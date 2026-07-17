import fs from "node:fs";
import path from "node:path";

import {
  BEDDING_PHOTO_SCANS_SETTING_KEY,
  BEDDING_SCAN_MIN_CONFIDENCE,
  autoApplyBeddingScanToUnits,
  buildBeddingVisionPrompt,
  captionFallbackBedding,
  compareDetectedBeddingToGuestyRooms,
  describeDetectedBeds,
  isBeddingScanAutoApplyEligible,
  mergeBeddingScanIntoUnit,
  normalizeScanBathFeature,
  normalizeScanBedType,
  parseBeddingScanStore,
  parseBeddingVisionJson,
  parseGuestyListingRoomsForScan,
  serializeBeddingScanStore,
  summarizeDetectedBedding,
  type BeddingScanUnit,
  type MergeUnitShape,
} from "../shared/bedding-photo-scan";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("bedding-photo-scan: vision prompt/parse, caption fallback, merge, Guesty comparison");

// ── normalization ────────────────────────────────────────────────────────────
check("bed types normalize (KING/king bed/CAL KING → KING_BED)",
  normalizeScanBedType("KING") === "KING_BED" &&
  normalizeScanBedType("king bed") === "KING_BED" &&
  normalizeScanBedType("CAL KING") === "KING_BED" &&
  normalizeScanBedType("California King") === "KING_BED");
check("twin/single → SINGLE_BED, full/double → DOUBLE_BED, sofa/sleeper → SOFA_BED",
  normalizeScanBedType("TWIN") === "SINGLE_BED" &&
  normalizeScanBedType("single") === "SINGLE_BED" &&
  normalizeScanBedType("FULL") === "DOUBLE_BED" &&
  normalizeScanBedType("double_bed") === "DOUBLE_BED" &&
  normalizeScanBedType("sleeper sofa") === "SOFA_BED");
check("unknown bed types → null (never guessed)",
  normalizeScanBedType("WATER_BED") === null && normalizeScanBedType("") === null && normalizeScanBedType(undefined) === null);
check("bath features normalize incl. synonyms",
  normalizeScanBathFeature("walk-in-shower") === "walk-in-shower" &&
  normalizeScanBathFeature("Walk In Shower") === "walk-in-shower" &&
  normalizeScanBathFeature("shower over tub") === "shower-tub-combo" &&
  normalizeScanBathFeature("freestanding tub") === "soaking-tub" &&
  normalizeScanBathFeature("jacuzzi") === "jetted-tub" &&
  normalizeScanBathFeature("bidet") === null);

// ── prompt ───────────────────────────────────────────────────────────────────
const prompt = buildBeddingVisionPrompt({ unitLabel: "Unit A", expectedBedrooms: 3, photoCount: 9 });
check("prompt: names the unit + photo count", prompt.includes("Unit A") && prompt.includes("9 numbered photos"));
check("prompt: forbids padding to the claimed bedroom count", /NEVER pad/.test(prompt));
check("prompt: same-room folding rule present", /fold them into ONE entry/i.test(prompt));
check("prompt: en-suite requires visible attachment, never inferred", /Never infer an en-suite/i.test(prompt));
check("prompt: fixed bath-feature vocabulary listed",
  prompt.includes("walk-in-shower") && prompt.includes("shower-tub-combo") && prompt.includes("jetted-tub"));
check("prompt: demands minified JSON only", /ONLY minified JSON/.test(prompt));
const promptNoExpected = buildBeddingVisionPrompt({ unitLabel: "Unit B", expectedBedrooms: null, photoCount: 4 });
check("prompt without expected count still demands see-only reporting", /Report ONLY rooms you can actually see/.test(promptNoExpected));

// ── strict parse ─────────────────────────────────────────────────────────────
const goodParse = parseBeddingVisionJson({
  bedrooms: [
    { photos: [1, 3], beds: [{ type: "KING", quantity: 1 }], ensuiteFeatures: ["walk-in-shower"], confidence: 0.92 },
    { photos: [2], beds: [{ type: "TWIN", quantity: 2 }], ensuiteFeatures: [], confidence: 0.8 },
  ],
  bathrooms: [
    { photos: [4], features: ["shower-tub-combo"], isHalf: false, confidence: 0.85 },
    { photos: [5], features: [], isHalf: true, confidence: 0.7 },
  ],
}, 5);
check("parse: valid payload keeps both bedrooms + both bathrooms",
  goodParse != null && goodParse.bedrooms.length === 2 && goodParse.bathrooms.length === 2);
check("parse: bed types normalized + ensuite features kept",
  goodParse?.bedrooms[0].beds[0].type === "KING_BED" &&
  goodParse?.bedrooms[0].ensuiteFeatures.length === 1 &&
  goodParse?.bedrooms[1].beds[0].quantity === 2);
check("parse: half bath with no features survives (isHalf is the finding)",
  goodParse?.bathrooms[1].isHalf === true);

check("parse: top-level garbage → null", parseBeddingVisionJson("nope", 5) === null &&
  parseBeddingVisionJson({ something: [] }, 5) === null &&
  parseBeddingVisionJson(null, 5) === null);
const outOfRange = parseBeddingVisionJson({
  bedrooms: [
    { photos: [7, 9], beds: [{ type: "KING" }], confidence: 0.9 },
    { photos: [0, -1], beds: [{ type: "QUEEN" }], confidence: 0.9 },
  ],
  bathrooms: [],
}, 5);
check("parse: out-of-range photo indexes drop the entry (never repaired)",
  outOfRange != null && outOfRange.bedrooms.length === 0);
const sharedPhoto = parseBeddingVisionJson({
  bedrooms: [
    { photos: [1, 2], beds: [{ type: "KING" }], confidence: 0.9 },
    { photos: [2], beds: [{ type: "QUEEN" }], confidence: 0.9 },
  ],
  bathrooms: [],
}, 5);
check("parse: a photo claimed by two bedrooms only counts for the first",
  sharedPhoto != null && sharedPhoto.bedrooms.length === 1 && sharedPhoto.bedrooms[0].beds[0].type === "KING_BED");
const noBeds = parseBeddingVisionJson({
  bedrooms: [{ photos: [1], beds: [{ type: "WATERBED" }], confidence: 0.9 }],
  bathrooms: [{ photos: [2], features: ["gold-taps"], isHalf: false, confidence: 0.9 }],
}, 5);
check("parse: entries with no recognizable bed/feature are dropped",
  noBeds != null && noBeds.bedrooms.length === 0 && noBeds.bathrooms.length === 0);
const clampQty = parseBeddingVisionJson({
  bedrooms: [{ photos: [1], beds: [{ type: "TWIN", quantity: 99 }], confidence: 2.5 }],
  bathrooms: [],
}, 5);
check("parse: quantity clamped to 6 and confidence clamped to 1",
  clampQty?.bedrooms[0].beds[0].quantity === 6 && clampQty?.bedrooms[0].confidence === 1);

// ── caption fallback ─────────────────────────────────────────────────────────
const fallback = captionFallbackBedding([
  { filename: "a.jpg", caption: "King Bedroom", category: "Bedrooms", bedroomClusterId: "c1" },
  { filename: "b.jpg", caption: "King Bedroom Angle", category: "Bedrooms", bedroomClusterId: "c1" },
  { filename: "c.jpg", caption: "Two Queens Bedroom", category: "Bedrooms", bedroomClusterId: "c2" },
  { filename: "d.jpg", caption: "Bathroom With Jetted Tub", category: "Bathrooms" },
  { filename: "e.jpg", caption: "Half Bath", category: "Bathrooms" },
  { filename: "f.jpg", caption: "Updated Kitchen", category: "Kitchen" },
]);
check("fallback: same-cluster photos fold into one bedroom",
  fallback.bedrooms.length === 2 &&
  fallback.bedrooms.some((b) => b.photos.length === 2 && b.beds[0].type === "KING_BED"));
check("fallback: 'Two Queens' caption yields quantity 2",
  fallback.bedrooms.some((b) => b.beds[0].type === "QUEEN_BED" && b.beds[0].quantity === 2));
const numberedRoomFallback = captionFallbackBedding([
  { filename: "room-2.jpg", caption: "Bedroom 2 with Queen Bed", category: "Bedrooms", bedroomClusterId: "room-2" },
  { filename: "soaking.jpg", caption: "Bathroom with freestanding soaking tub", category: "Bathrooms" },
]);
check("fallback: room numbers are not bed quantities and soaking tubs are not mislabeled as combos",
  numberedRoomFallback.bedrooms[0]?.beds[0]?.quantity === 1 &&
  numberedRoomFallback.bathrooms[0]?.features.join(",") === "soaking-tub");
check("fallback: bathroom captions map to features + half bath",
  fallback.bathrooms.some((b) => b.features.includes("jetted-tub")) &&
  fallback.bathrooms.some((b) => b.isHalf));
check("fallback: caption confidence clears the apply floor (captions are vision-authored)",
  fallback.bedrooms.every((b) => isBeddingScanAutoApplyEligible(b.confidence)));
check("fallback: never fabricates en-suite evidence",
  fallback.bedrooms.every((b) => b.ensuiteFeatures.length === 0));
check("fallback: non-bed/bath categories ignored",
  ![...fallback.bedrooms, ...fallback.bathrooms].some((g) => g.photos.includes("f.jpg")));

// ── merge into the Bedding-tab config ────────────────────────────────────────
function makeUnit(): MergeUnitShape {
  return {
    bedrooms: [
      { roomNumber: 1, label: "Master Bedroom", beds: [{ type: "QUEEN_BED", quantity: 1 }], hasEnsuite: true, ensuiteFeatures: ["soaking-tub"] },
      { roomNumber: 2, label: "Bedroom 2", beds: [{ type: "QUEEN_BED", quantity: 1 }], hasEnsuite: false, ensuiteFeatures: [] },
      { roomNumber: 3, label: "Bedroom 3", beds: [{ type: "QUEEN_BED", quantity: 1 }], hasEnsuite: false, ensuiteFeatures: [] },
    ],
    bathrooms: [
      { id: "bath-0", label: "Master Ensuite", isHalf: false, features: ["walk-in-shower", "soaking-tub"] },
      { id: "bath-1", label: "Hall Bath", isHalf: false, features: ["shower-tub-combo"] },
      { id: "bath-h0", label: "Powder Room", isHalf: true, features: [] },
    ],
  };
}
const scanUnit: BeddingScanUnit = {
  unitId: "unit-a",
  evidenceMethod: "vision",
  folder: "unit-a",
  label: "Unit A",
  expectedBedrooms: 3,
  photosScanned: 8,
  bedrooms: [
    { beds: [{ type: "SINGLE_BED", quantity: 2 }], ensuiteFeatures: [], confidence: 0.85, photos: ["p3.jpg"] },
    { beds: [{ type: "KING_BED", quantity: 1 }], ensuiteFeatures: ["walk-in-shower"], confidence: 0.95, photos: ["p1.jpg", "p2.jpg"] },
    { beds: [{ type: "QUEEN_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.4, photos: ["p9.jpg"] },
  ],
  bathrooms: [
    { features: ["walk-in-shower", "double-vanity"], isHalf: false, confidence: 0.9, photos: ["p4.jpg"] },
    { features: ["shower-tub-combo"], isHalf: false, confidence: 0.3, photos: ["p5.jpg"] },
  ],
  unphotographedBedrooms: 1,
};
const merged = mergeBeddingScanIntoUnit(makeUnit(), scanUnit);
check("merge: biggest detected bed lands on the Master slot",
  merged.unit.bedrooms[0].beds[0].type === "KING_BED");
check("merge: second confident bedroom fills slot 2 (two twins)",
  merged.unit.bedrooms[1].beds[0].type === "SINGLE_BED" && merged.unit.bedrooms[1].beds[0].quantity === 2);
check("merge: low-confidence bedroom NOT applied — slot 3 untouched",
  merged.unit.bedrooms[2].beds[0].type === "QUEEN_BED");
check("merge: en-suite evidence unions features, never replaces the operator's",
  merged.unit.bedrooms[0].hasEnsuite === true &&
  merged.unit.bedrooms[0].ensuiteFeatures.includes("soaking-tub") &&
  merged.unit.bedrooms[0].ensuiteFeatures.includes("walk-in-shower"));
check("merge: confident bathroom replaces slot features; low-confidence one doesn't",
  merged.unit.bathrooms[0].features.join(",") === "walk-in-shower,double-vanity" &&
  merged.unit.bathrooms[1].features.join(",") === "shower-tub-combo");
check("merge: bathroom/bedroom COUNTS unchanged; half bath untouched",
  merged.unit.bedrooms.length === 3 && merged.unit.bathrooms.length === 3 &&
  merged.unit.bathrooms[2].features.length === 0);
check("merge: notes name the low-confidence + unphotographed leftovers",
  merged.notes.some((n) => /confidence floor/.test(n)) &&
  merged.notes.some((n) => /No photo evidence for Bedroom 3/.test(n)));
check("merge: changed=true and applied lines describe the writes",
  merged.changed === true && merged.applied.length >= 3);

const noEvidence = mergeBeddingScanIntoUnit(makeUnit(), {
  ...scanUnit, bedrooms: [], bathrooms: [], unphotographedBedrooms: 3,
});
check("merge: zero confident detections → unit byte-equal, changed=false",
  noEvidence.changed === false && JSON.stringify(noEvidence.unit) === JSON.stringify(makeUnit()));

const ensuiteNever = mergeBeddingScanIntoUnit(makeUnit(), {
  ...scanUnit,
  bedrooms: [{ beds: [{ type: "KING_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.9, photos: ["p1.jpg"] }],
  bathrooms: [],
});
check("merge: absence of en-suite evidence never unsets the operator's en-suite flag",
  ensuiteNever.unit.bedrooms[0].hasEnsuite === true &&
  ensuiteNever.unit.bedrooms[0].ensuiteFeatures.includes("soaking-tub"));

const strictBoundary = mergeBeddingScanIntoUnit(makeUnit(), {
  ...scanUnit,
  bedrooms: [
    { beds: [{ type: "KING_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.6, photos: ["exact.jpg"] },
    { beds: [{ type: "SINGLE_BED", quantity: 2 }], ensuiteFeatures: [], confidence: 0.6001, photos: ["above.jpg"] },
  ],
  bathrooms: [
    { features: ["walk-in-shower"], isHalf: false, confidence: 0.6, photos: ["bath-exact.jpg"] },
    { features: ["double-vanity"], isHalf: false, confidence: 0.6001, photos: ["bath-above.jpg"] },
  ],
}, { requireAboveMinimum: true });
check("auto-apply threshold is strict: exactly 60% excluded, 60.01% included",
  !isBeddingScanAutoApplyEligible(0.6) &&
  isBeddingScanAutoApplyEligible(0.6001) &&
  strictBoundary.unit.bedrooms[0].beds[0].type === "SINGLE_BED" &&
  strictBoundary.unit.bedrooms[1].beds[0].type === "QUEEN_BED" &&
  strictBoundary.unit.bathrooms[0].features.join(",") === "double-vanity" &&
  strictBoundary.unit.bathrooms[1].features.join(",") === "shower-tub-combo");

const autoUnitA = { ...makeUnit(), unitId: "config-unit-a" };
const autoUnitB = { ...makeUnit(), unitId: "config-unit-b" };
const onlyUnitBScan: BeddingScanUnit = {
  ...scanUnit,
  unitId: "config-unit-b",
  folder: "replacement-folder-that-does-not-match-the-unit-id",
  label: "Unit B",
  bedrooms: [{ beds: [{ type: "KING_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.9, photos: ["b.jpg"] }],
  bathrooms: [],
};
const exactIdApplied = autoApplyBeddingScanToUnits([autoUnitA, autoUnitB], [onlyUnitBScan]);
check("auto-apply maps by canonical unit id, never shifted array position or photo folder",
  exactIdApplied.units[0].bedrooms[0].beds[0].type === "QUEEN_BED" &&
  exactIdApplied.units[1].bedrooms[0].beds[0].type === "KING_BED" &&
  exactIdApplied.appliedUnits.length === 1 &&
  exactIdApplied.appliedUnits[0].unitId === "config-unit-b");

const missingIdSkipped = autoApplyBeddingScanToUnits(
  [autoUnitA, autoUnitB],
  [{ ...onlyUnitBScan, unitId: undefined }],
);
check("auto-apply refuses legacy/malformed scan units without a stable id",
  JSON.stringify(missingIdSkipped.units) === JSON.stringify([autoUnitA, autoUnitB]) &&
  missingIdSkipped.appliedUnits.length === 0 &&
  missingIdSkipped.skippedScanUnits[0]?.reason === "missing-unit-id");

const duplicateIdSkipped = autoApplyBeddingScanToUnits(
  [autoUnitA, autoUnitB],
  [onlyUnitBScan, { ...onlyUnitBScan, folder: "another-folder" }],
);
check("auto-apply refuses ambiguous duplicate scan rows for the same unit id",
  duplicateIdSkipped.units[1].bedrooms[0].beds[0].type === "QUEEN_BED" &&
  duplicateIdSkipped.appliedUnits.length === 0 &&
  duplicateIdSkipped.skippedScanUnits.every((row) => row.reason === "duplicate-unit-id"));

const captionResultSkipped = autoApplyBeddingScanToUnits(
  [autoUnitA, autoUnitB],
  [{ ...onlyUnitBScan, evidenceMethod: "captions" }],
);
check("auto-apply never writes caption-fallback evidence even when its review score exceeds 60%",
  JSON.stringify(captionResultSkipped.units) === JSON.stringify([autoUnitA, autoUnitB]) &&
  captionResultSkipped.appliedUnits.length === 0 &&
  captionResultSkipped.skippedScanUnits[0]?.reason === "non-vision-evidence");

// ── Guesty comparison (audit) ────────────────────────────────────────────────
const guestyRooms = parseGuestyListingRoomsForScan([
  { roomNumber: 1, name: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 1 }] },
  { roomNumber: 2, beds: [{ type: "QUEEN_BED", quantity: 1 }] },
  { roomNumber: 0, beds: [{ type: "SOFA_BED", quantity: 1 }] },
  { roomNumber: 3, beds: [{ type: "WATER_BED", quantity: 1 }] },
]);
check("guesty parse: rooms tolerated, invalid bed types dropped, living room kept",
  guestyRooms != null && guestyRooms.length === 4 && guestyRooms[3].beds.length === 0);
check("guesty parse: non-array → null", parseGuestyListingRoomsForScan(undefined) === null);

const matchUnits: BeddingScanUnit[] = [{
  folder: "unit-a", label: "Unit A", expectedBedrooms: 2, photosScanned: 6,
  bedrooms: [
    { beds: [{ type: "KING_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.9, photos: ["a.jpg"] },
    { beds: [{ type: "QUEEN_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.9, photos: ["b.jpg"] },
  ],
  bathrooms: [], unphotographedBedrooms: 0,
}];
const cleanCompare = compareDetectedBeddingToGuestyRooms(matchUnits, guestyRooms);
check("compare: photographed beds matching the pushed layout → no mismatch + ✓ line",
  cleanCompare.mismatch === false && cleanCompare.unverified === false &&
  cleanCompare.items.some((i) => /match the pushed Guesty layout/.test(i)));

const bunkUnits: BeddingScanUnit[] = [{
  ...matchUnits[0],
  bedrooms: [
    ...matchUnits[0].bedrooms,
    { beds: [{ type: "BUNK_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.9, photos: ["c.jpg"] },
  ],
}];
const bunkCompare = compareDetectedBeddingToGuestyRooms(bunkUnits, guestyRooms);
check("compare: photo-proven bed type absent from Guesty → mismatch naming the type",
  bunkCompare.mismatch === true && bunkCompare.items.some((i) => /Bunk bed/.test(i)));
// guestyRooms carries 3 bedroom rooms (the unparseable-bed room still counts as
// a room), so the 3 detected bedrooms are NOT a count mismatch there — but two
// pushed rooms vs three photographed ones is.
const fewerRooms = compareDetectedBeddingToGuestyRooms(bunkUnits, [
  { roomNumber: 1, beds: [{ type: "KING_BED", quantity: 1 }] },
  { roomNumber: 2, beds: [{ type: "QUEEN_BED", quantity: 1 }] },
]);
check("compare: more photographed bedrooms than pushed rooms → mismatch",
  fewerRooms.mismatch === true && fewerRooms.items.some((i) => /3 distinct bedrooms/.test(i)));

const partialUnits: BeddingScanUnit[] = [{
  ...matchUnits[0],
  bedrooms: [matchUnits[0].bedrooms[0]],
  unphotographedBedrooms: 1,
}];
const partialCompare = compareDetectedBeddingToGuestyRooms(partialUnits, guestyRooms);
check("compare: unphotographed bedroom → Guesty-only types NOT flagged (could live in the unseen room)",
  partialCompare.mismatch === false && partialCompare.unverified === true &&
  partialCompare.items.some((i) => /no bedroom photo/.test(i)));

const noRoomsCompare = compareDetectedBeddingToGuestyRooms(matchUnits, []);
check("compare: Guesty has no bed layout at all → mismatch pointing at the Bedding tab",
  noRoomsCompare.mismatch === true && noRoomsCompare.items.some((i) => /NO bed layout pushed/.test(i)));

const nothingDetected = compareDetectedBeddingToGuestyRooms(
  [{ ...matchUnits[0], bedrooms: [], unphotographedBedrooms: 2 }], guestyRooms);
check("compare: nothing confidently detected → unverifiable, never a mismatch",
  nothingDetected.mismatch === false && nothingDetected.unverified === true);

const sofaOnly = compareDetectedBeddingToGuestyRooms(
  [{ ...matchUnits[0], bedrooms: [
    { beds: [{ type: "KING_BED", quantity: 1 }, { type: "SOFA_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.9, photos: ["a.jpg"] },
    { beds: [{ type: "QUEEN_BED", quantity: 1 }], ensuiteFeatures: [], confidence: 0.9, photos: ["b.jpg"] },
  ] }], guestyRooms);
check("compare: sofa beds excluded from the type comparison entirely",
  sofaOnly.mismatch === false);

check("describe/summarize helpers render human bed lists",
  describeDetectedBeds([{ type: "SINGLE_BED", quantity: 2 }]) === "2× Twin bed" &&
  summarizeDetectedBedding(matchUnits) === "King bed, Queen bed");

// ── store (de)serialization ──────────────────────────────────────────────────
const rec = (propertyId: number, scannedAt: string) => ({
  propertyId, scannedAt, method: "vision" as const, model: "m", units: [] as BeddingScanUnit[], fingerprints: {},
});
const store = parseBeddingScanStore(serializeBeddingScanStore({ "4": rec(4, "2026-07-14T00:00:00Z") }));
check("store: round-trips a record", store["4"]?.propertyId === 4 && store["4"]?.method === "vision");
check("store: garbage/malformed rows dropped",
  Object.keys(parseBeddingScanStore('{"4":{"nope":1},"5":"x",  "bad json…')).length === 0 &&
  Object.keys(parseBeddingScanStore('{"4":{"nope":1},"5":"x"}')).length === 0);
const big: Record<string, ReturnType<typeof rec>> = {};
for (let i = 0; i < 250; i++) big[String(i)] = rec(i, `2026-01-01T00:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`);
check("store: serialization caps at 200 newest", Object.keys(parseBeddingScanStore(serializeBeddingScanStore(big))).length === 200);
check("store: setting key is versioned", BEDDING_PHOTO_SCANS_SETTING_KEY === "bedding_photo_scans.v1");

// ── source guards (wiring must not drift) ────────────────────────────────────
const repoRoot = path.resolve(process.cwd());
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");

const engineSrc = read("server/bedding-photo-scan.ts");
check("engine: resolves folders via buildPhotoCommunityCheckRequestForProperty (drafts + active swap folders)",
  engineSrc.includes("buildPhotoCommunityCheckRequestForProperty"));
check("engine: persists to the versioned app_settings store via the shared serializers",
  engineSrc.includes("BEDDING_PHOTO_SCANS_SETTING_KEY") &&
  engineSrc.includes("serializeBeddingScanStore") && engineSrc.includes("parseBeddingScanStore"));
check("engine/routes: explicit tab scans require durable timestamp persistence before returning",
  engineSrc.includes("opts.requirePersistence && !persisted") &&
  read("server/routes.ts").includes("{ requirePersistence: true }") &&
  engineSrc.includes("Guesty was not updated"));
check("engine: vision kill switch + caption fallback wired",
  engineSrc.includes("BEDDING_SCAN_VISION_DISABLED") && engineSrc.includes("captionFallbackBedding"));
check("engine: audit comparison reads the Guesty rooms HERE (sweep is locked against the string)",
  engineSrc.includes("listingRooms") && engineSrc.includes("compareDetectedBeddingToGuestyRooms"));
check("engine: Guesty read is a GET through the gated guestyRequest — never a PUT",
  /guestyRequest\(\s*"GET"/.test(engineSrc) && !/guestyRequest\(\s*"PUT"/.test(engineSrc));
check("engine: fingerprints scans with photoFolderFingerprint over listPublishedFilenames (pin-store parity)",
  engineSrc.includes("photoFolderFingerprint") && engineSrc.includes("listPublishedFilenames"));
check("engine: carries the server-resolved canonical unit id into every scan result",
  engineSrc.includes("unitId: group.unitId"));
check("engine: marks each unit as vision or caption evidence so degraded rows cannot auto-push",
  engineSrc.includes('finalizeUnit(bedrooms, bathrooms, photos.length, "vision")') &&
  engineSrc.includes('finalizeUnit(bedrooms, bathrooms, photos.length, "captions"'));

const groupBuilderSrc = read("server/builder-photo-groups.ts");
check("group builder: stamps stable ids for static, draft, and replacement-backed unit folders",
  groupBuilderSrc.includes("unitDescriptionFromBuilder(u),\n          u.id,") &&
  groupBuilderSrc.includes("draftUnitIdForSlot(draft.id, \"a\")") &&
  groupBuilderSrc.includes("draftUnitIdForSlot(draft.id, \"b\")"));

const sweepSrc = read("server/unit-audit-sweep.ts");
check("sweep: layout stage runs the bedding photo check through the engine (reuse, not re-implementation)",
  sweepSrc.includes("beddingPhotoCheckForAudit"));
check("sweep: bedding check kill switch present", sweepSrc.includes("AUDIT_BEDDING_PHOTO_CHECK"));
check("sweep: still never contains the Guesty rooms field name (layout stays flag-only)",
  !sweepSrc.includes("listingRooms"));

const routesSrc = read("server/routes.ts");
check("routes: POST scan + GET last-scan endpoints registered",
  routesSrc.includes("/api/builder/bedding-photo-scan") &&
  routesSrc.includes("scanBeddingPhotosForProperty"));
check("routes: scan timestamps cannot be served from browser cache",
  routesSrc.includes('res.set("Cache-Control", "no-store")'));

const tabSrc = read("client/src/components/GuestyListingBuilder/BeddingTab.tsx");
check("BeddingTab: the explicit scan click auto-applies by stable id with the strict shared helper",
  tabSrc.includes("autoApplyBeddingScanToUnits(currentConfig.units, record.units)") &&
  tabSrc.includes("isBeddingScanAutoApplyEligible"));
const saveNextConfigAt = tabSrc.indexOf("if (!saveBeddingConfig(nextConfig))");
const pushNextConfigAt = tabSrc.indexOf("pushBeddingConfigToGuesty(scannedGuestyListingId, nextConfig)");
check("BeddingTab: saves the merged config before building Guesty's supported projection from it",
  saveNextConfigAt >= 0 && pushNextConfigAt > saveNextConfigAt);
check("BeddingTab: no Guesty listing is an explicit save-only success path",
  tabSrc.includes("if (!scannedGuestyListingId)") &&
  tabSrc.includes("No Guesty listing was connected when the scan began, so no push was attempted"));
check("BeddingTab: snapshots the Guesty target so a later selector change cannot redirect the push",
  tabSrc.includes("const scannedGuestyListingId = guestyListingId") &&
  tabSrc.includes("listing selected when the scan began") &&
  !tabSrc.includes("activeGuestyListingIdRef"));
check("BeddingTab: tab remounts share one workflow and retain completion/error copy without replaying stale config",
  tabSrc.includes("activeBeddingScanWorkflows") &&
  tabSrc.includes("completedBeddingScanWorkflows") &&
  tabSrc.includes("const saved = loadBeddingConfig(propertyId)") &&
  !tabSrc.includes("result.config ??") &&
  tabSrc.includes("if (activeBeddingScanWorkflows.has(propertyId)) return") &&
  tabSrc.includes("completed.configSnapshot !== JSON.stringify(config)"));
check("BeddingTab: stale GET hydration cannot replace a newer scan timestamp",
  tabSrc.includes("comparableTimestamp < latestScanTimestampRef.current") &&
  tabSrc.includes("comparableTimestamp > completedTimestamp") &&
  tabSrc.includes("if (!acceptScanRecord(record, true))"));
check("BeddingTab: legacy/caption rows never fall back to positional manual application",
  tabSrc.includes('scanUnit.evidenceMethod !== "vision"') &&
  !tabSrc.includes(": config.units[unitIndex]"));
check("BeddingTab: stored-scan hydration stays read-only; auto-apply only lives in the click handler",
  !/useEffect\([^)]*autoApplyBeddingScanToUnits/s.test(tabSrc));
check("BeddingTab: every completed scan renders its timestamp even with zero unit rows",
  tabSrc.includes("{beddingScan && (") &&
  !tabSrc.includes("{beddingScan && beddingScan.units.length > 0 && ("));

// ── Last Price Scan column chain (operator ask 2026-07-14: audit pricing push
// must move the dashboard rates column). The chain already exists — these
// guards lock every link so it can't silently drift.
check("chain: audit pricing auto-fix drives the per-property refresh route (positive ids)",
  sweepSrc.includes("/refresh-market-rates"));
check("chain: audit pricing auto-fix drives the draft refresh route (negative ids)",
  sweepSrc.includes("/refresh-pricing"));
check("chain: the push tail stamps the Last Price Scan column (markScannerGuestyRatePush ok)",
  /markScannerGuestyRatePush\(propertyId,\s*"ok"/.test(read("server/routes.ts")));
const homeSrc = read("client/src/pages/home.tsx");
check("chain: dashboard invalidates /api/dashboard/price-scans when a sweep finishes",
  /anyFinished[\s\S]{0,400}\/api\/dashboard\/price-scans/.test(homeSrc));

console.log(`\nbedding-photo-scan: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
