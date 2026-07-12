import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  communityNamesMatch,
  computeUnitVerdict,
  filterUnitOutliers,
  isInteriorPhoto,
  pickInteriorPhotos,
  isStrongContradiction,
  communityOnlyCheckRequest,
  communityPhotosCorrectAnswer,
} from "../shared/photo-community-check-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("photo-community-check: interior selection + binary verdicts");

check("communityNamesMatch handles aliases",
  communityNamesMatch("Regency at Poipu Kai", "Poipu Kai Regency"));

check("communityNamesMatch rejects unrelated names",
  !communityNamesMatch("Kiahuna Plantation", "Completely Different Resort"));

check("isInteriorPhoto detects bedroom captions",
  isInteriorPhoto("King Bedroom") && !isInteriorPhoto("Oceanfront Pool"));

const files = [
  { filename: "a.jpg", caption: "Resort Pool" },
  { filename: "b.jpg", caption: "King Bedroom" },
  { filename: "c.jpg", caption: "Updated Kitchen" },
  { filename: "d.jpg", caption: "Living Room" },
  { filename: "e.jpg", caption: "Master Bath" },
  { filename: "f.jpg", caption: "Lanai View" },
];
const picked = pickInteriorPhotos(files, 5);
check("pickInteriorPhotos prioritizes interior-labeled files",
  picked.interiorCount === 5 && picked.chosen.map((f) => f.filename).join() === "b.jpg,c.jpg,d.jpg,e.jpg,f.jpg");

const fiveYes = Array.from({ length: 5 }, () => ({ match: "yes" as const, reason: "compatible finishes" }));
check("computeUnitVerdict passes with 5/5 yes votes",
  computeUnitVerdict(fiveYes, 5).sameAsCommunity === "yes");

const fourYesOneNo = [
  ...Array.from({ length: 4 }, () => ({ match: "yes" as const, reason: "ok" })),
  { match: "no" as const, reason: "weak mismatch" },
];
check("computeUnitVerdict fails with 4/5 yes votes (unanimous required)",
  computeUnitVerdict(fourYesOneNo, 5).sameAsCommunity === "no");

const sevenYesOneNo = [
  ...Array.from({ length: 7 }, () => ({ match: "yes" as const, reason: "ok" })),
  { match: "no" as const, reason: "weak mismatch" },
];
check("computeUnitVerdict fails with 7/8 yes votes (unanimous required)",
  computeUnitVerdict(sevenYesOneNo, 5).sameAsCommunity === "no");

check("computeUnitVerdict passes with 8/8 unanimous yes votes",
  computeUnitVerdict(Array.from({ length: 8 }, () => ({ match: "yes" as const, reason: "ok" })), 5).sameAsCommunity === "yes");

check("computeUnitVerdict fails when fewer than 5 photos",
  computeUnitVerdict(fiveYes.slice(0, 3), 5).sameAsCommunity === "no");

const strongNo = [
  ...Array.from({ length: 4 }, () => ({ match: "yes" as const, reason: "ok" })),
  { match: "no" as const, reason: "Different resort signage visible on pool towel" },
];
check("computeUnitVerdict fails on strong contradiction",
  computeUnitVerdict(strongNo, 5).sameAsCommunity === "no");

check("isStrongContradiction detects resort signage mismatch",
  isStrongContradiction("Different resort signage visible on pool towel"));

check("filterUnitOutliers drops community pool/lanai shots from unit gallery",
  filterUnitOutliers([
    { id: "U1-3", caption: "Oceanfront Pool", reason: "shows resort pool not unit interior" },
    { id: "U1-7", caption: "Lanai View", reason: "exterior lanai" },
  ]).length === 0);

check("filterUnitOutliers keeps mismatched interior outliers",
  filterUnitOutliers([
    { id: "U1-2", caption: "Updated Kitchen", reason: "different kitchen finishes than other unit photos" },
  ]).length === 1);

// ── communityOnlyCheckRequest (preflight "Check photos are correct") ─────────

console.log("\nphoto-community-check: community-only request narrowing");

const fullRequest = {
  expectedCommunity: "Kamaole Beach Club",
  expectedListingBedrooms: 4,
  groups: [
    { role: "community", folder: "kamaole-beach-club-community" },
    { role: "unit", folder: "kamaole-unit-a" },
    { role: "unit", folder: "kamaole-unit-b" },
  ],
};
const narrowed = communityOnlyCheckRequest(fullRequest);
check("communityOnlyCheckRequest keeps only the community group",
  narrowed.groups.length === 1 && narrowed.groups[0].role === "community");
check("communityOnlyCheckRequest keeps expectedCommunity",
  narrowed.expectedCommunity === "Kamaole Beach Club");
check("communityOnlyCheckRequest drops expectedListingBedrooms (bedroom coverage is a unit-leg concern)",
  !("expectedListingBedrooms" in narrowed));
check("communityOnlyCheckRequest yields no groups when the request has no community folder",
  communityOnlyCheckRequest({ groups: [{ role: "unit", folder: "u" }] }).groups.length === 0);

// ── communityPhotosCorrectAnswer (YES / NO / review headline) ────────────────

console.log("\nphoto-community-check: community-photos yes/no answer");

const yes = communityPhotosCorrectAnswer("Kamaole Beach Club", "pass", {
  identifiedCommunity: "Kamaole Beach Club",
  matchesExpected: "yes",
  overallStatus: "verified",
});
check("positive identification → YES", yes.answer === "yes" && yes.headline.includes("YES") && yes.headline.includes("Kamaole Beach Club"));

const yesWithWarnings = communityPhotosCorrectAnswer("Kamaole Beach Club", "warn", {
  identifiedCommunity: "Kamaole Beach Club",
  matchesExpected: "yes",
  overallStatus: "likely",
});
check("positive identification with minor warnings stays YES (warnings render below)",
  yesWithWarnings.answer === "yes");

const noNamed = communityPhotosCorrectAnswer("Kamaole Beach Club", "fail", {
  identifiedCommunity: "Maui Banyan",
  matchesExpected: "no",
  overallStatus: "mismatch",
});
check("mismatch naming a different resort → NO with the identified name",
  noNamed.answer === "no" && noNamed.headline.includes("Maui Banyan") && noNamed.headline.includes("not Kamaole Beach Club"));

const noGeneric = communityPhotosCorrectAnswer("Kamaole Beach Club", "fail", {
  identifiedCommunity: "",
  matchesExpected: "no",
  overallStatus: "mismatch",
});
check("mismatch without an identified name → generic NO",
  noGeneric.answer === "no" && noGeneric.headline.includes("do not match"));

// A fail verdict whose identifiedCommunity is an ALIAS of the expected name
// (e.g. an outlier photo failed the folder, not the identification) must not
// claim "X, not X".
const noAlias = communityPhotosCorrectAnswer("Regency at Poipu Kai", "fail", {
  identifiedCommunity: "Poipu Kai Regency",
  matchesExpected: "no",
  overallStatus: "mismatch",
});
check("fail with an alias-equivalent identified name avoids the self-contradicting headline",
  noAlias.answer === "no" && !noAlias.headline.includes("appear to be"));

const unconfirmed = communityPhotosCorrectAnswer("Kamaole Beach Club", "warn", {
  identifiedCommunity: "",
  matchesExpected: "no",
  overallStatus: "unconfirmed",
});
check("unconfirmed (no positive ID, no hard fail) → review",
  unconfirmed.answer === "review" && unconfirmed.headline.toLowerCase().includes("could not"));

check("missing community analysis → review",
  communityPhotosCorrectAnswer("Kamaole Beach Club", "warn", null).answer === "review");

check("empty expected community falls back to a readable phrase",
  communityPhotosCorrectAnswer("", "pass", { identifiedCommunity: "X", matchesExpected: "yes" })
    .headline.includes("the expected community"));

// ── Source assertions: the wiring the above logic assumes ────────────────────

console.log("\nphoto-community-check: source wiring assertions");

const routesSource = readFileSync("server/routes.ts", "utf8");
check("photo-community-check endpoint narrows communityOnly requests via communityOnlyCheckRequest",
  routesSource.includes("communityOnlyCheckRequest(request)"));
check("community-only results are NOT persisted over the dashboard Community QA status",
  routesSource.includes("propertyId != null && !communityOnly"));

const preflightPageSource = readFileSync("client/src/pages/builder-preflight.tsx", "utf8");
check("preflight Community Photos card sends communityOnly: true",
  preflightPageSource.includes("communityOnly: true"));
check("preflight renders the yes/no verdict via communityPhotosCorrectAnswer",
  preflightPageSource.includes("communityPhotosCorrectAnswer("));
check("re-pull button is renamed to 'Find new community photos'",
  preflightPageSource.includes("Find new community photos")
  && !preflightPageSource.includes("Re-pull community photos</>"));

// ── Source assertions: the preflight FULL "Check photo community" report ─────
// The Community Match card runs the Photos-tab full check ({ propertyId } only,
// NEVER communityOnly) and both surfaces render the ONE shared report component
// — if either re-inlines a copy, the reports drift and these lock it.

console.log("\nphoto-community-check: shared full-report wiring assertions");

const reportComponentSource = readFileSync(
  "client/src/components/photo-community-check-report.tsx",
  "utf8",
);
check("shared report renders the same-community roster headline",
  reportComponentSource.includes("Same community?"));
check("shared report renders the source-page check card",
  reportComponentSource.includes("Source page check"));
check("shared report renders bedroom photo coverage (the x/x bedrooms answer)",
  reportComponentSource.includes("Bedroom photo coverage"));
check("shared report renders the cross-folder duplicates card",
  reportComponentSource.includes("Same photo found in more than one folder"));
check("shared report keeps the manual-verify escape hatch",
  reportComponentSource.includes("Mark as verified anyway"));

const builderIndexSource = readFileSync(
  "client/src/components/GuestyListingBuilder/index.tsx",
  "utf8",
);
check("Photos tab renders the SHARED report component",
  builderIndexSource.includes("<PhotoCommunityCheckReport")
  && builderIndexSource.includes('from "@/components/photo-community-check-report"'));
check("Photos tab carries no re-inlined report copy (edit the shared component instead)",
  !builderIndexSource.includes("Bedroom photo coverage"));

check("preflight Community Match button is the Photos-tab 'Check photo community'",
  preflightPageSource.includes("Check photo community"));
check("preflight Community Match posts the FULL check ({ propertyId } only, no communityOnly)",
  preflightPageSource.includes("JSON.stringify({ propertyId: id })"));
check("preflight renders the SHARED report component (bedroom coverage, votes, dupes)",
  preflightPageSource.includes("<PhotoCommunityCheckReport")
  && preflightPageSource.includes('from "@/components/photo-community-check-report"'));
check("preflight carries no re-inlined report copy",
  !preflightPageSource.includes("Bedroom photo coverage"));

// ── Source assertions: flagged-photo review (2026-07-11) ─────────────────────
// Every YELLOW (unconfirmed) / RED (mismatch) per-photo vote, outlier/junk
// flag, and cross-folder duplicate in the shared report shows the ACTUAL photo
// (thumbnail + folder/filename) with an inline keep / remove decision, so the
// operator can see exactly which photo a flag refers to. Removal is the
// EXISTING photo_labels.hidden soft-delete and is ALWAYS operator-confirmed —
// the check itself never auto-drops a photo (Load-Bearing #4).

console.log("\nphoto-community-check: flagged-photo review assertions");

check("shared report renders flagged-photo thumbnails from the local /photos/ path",
  reportComponentSource.includes("flaggedPhotoCard")
  && reportComponentSource.includes("/photos/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}"));
check("thumbnails render ONLY for yellow/red rows (mismatch + unconfirmed), never green",
  reportComponentSource.includes('st === "mismatch" || st === "unconfirmed"'));
check("remove = the EXISTING photo_labels.hidden soft-delete via PUT /api/photo-labels",
  reportComponentSource.includes("/api/photo-labels/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}")
  && reportComponentSource.includes("JSON.stringify({ hidden })"));
check("removal is operator-confirmed (window.confirm) — the check never auto-drops a photo",
  reportComponentSource.includes("window.confirm"));
check("a removed photo keeps an Undo (hidden flips back off)",
  reportComponentSource.includes("↺ Undo")
  && reportComponentSource.includes("setPhotoHidden(folder, filename, false)"));
check("a failed undo STAYS removed so the Undo button survives",
  reportComponentSource.includes('{ state: "removed", error }'));
check("outlier/junk flag ids resolve to photos via the group's per-photo verdicts",
  reportComponentSource.includes("photoByIdFor"));
check("cross-folder duplicates render BOTH copies for a which-folder-keeps-it decision",
  reportComponentSource.match(/flaggedPhotoCard\(d\.a\.folder, d\.a\.filename/) != null
  && reportComponentSource.match(/flaggedPhotoCard\(d\.b\.folder, d\.b\.filename/) != null);
check("Photos tab passes its gallery-refresh callback into the shared report",
  builderIndexSource.includes("onPhotoOverridesChanged={onPhotoOverridesChanged}"));

// ── Provenance (chain-of-custody) upgrade (2026-07-12) ───────────────────────
// "Can't confirm photos" (uncertain votes / too few decisive votes) is upgraded
// ONLY when the gallery's origin is independently verified: operator pin >
// source-page "yes" > committed swap. A positive "no" vote always wins — the
// upgrade clears uncertainty, never masks a mismatch.

console.log("\nphoto-community-check: provenance upgrade");

{
  const { unitProvenanceFor, canUpgradeWithProvenance } = await import("../shared/photo-community-check-logic");

  check("no provenance signals → null (nothing upgrades by default)",
    unitProvenanceFor({}, undefined) === null && unitProvenanceFor(null, "uncertain") === null);
  check("operator pin outranks everything and carries the date",
    unitProvenanceFor({ operatorVerified: true, operatorVerifiedAt: "2026-07-12T01:02:03Z", swapVerified: true }, "yes")?.kind === "operator"
    && (unitProvenanceFor({ operatorVerified: true, operatorVerifiedAt: "2026-07-12T01:02:03Z" }, undefined)?.detail ?? "").includes("2026-07-12"));
  check("source page 'yes' is provenance on its own",
    unitProvenanceFor({}, "yes")?.kind === "source-page");
  check("committed swap is provenance when the source page doesn't contradict",
    unitProvenanceFor({ swapVerified: true }, undefined)?.kind === "swap"
    && unitProvenanceFor({ swapVerified: true }, "uncertain")?.kind === "swap");
  check("source page 'no' VETOES swap provenance (machine vs machine)",
    unitProvenanceFor({ swapVerified: true }, "no") === null);
  check("source page 'no' does NOT veto the operator pin (explicit human confirmation)",
    unitProvenanceFor({ operatorVerified: true }, "no")?.kind === "operator");

  const operator = { kind: "operator" as const, detail: "op" };
  const machine = { kind: "source-page" as const, detail: "sp" };
  const yes = { match: "yes" as const };
  const no = { match: "no" as const };
  const unc = { match: "uncertain" as const };
  check("a single 'no' vote blocks EVERY provenance kind (mismatch always wins)",
    !canUpgradeWithProvenance([yes, yes, no, unc], operator)
    && !canUpgradeWithProvenance([yes, yes, no, unc], machine));
  check("zero votes block every provenance kind (nothing was judged)",
    !canUpgradeWithProvenance([], operator) && !canUpgradeWithProvenance([], machine));
  check("operator pin upgrades even all-uncertain votes",
    canUpgradeWithProvenance([unc, unc, unc], operator));
  check("machine provenance needs at least one corroborating 'yes' vote",
    !canUpgradeWithProvenance([unc, unc, unc], machine)
    && canUpgradeWithProvenance([yes, unc, unc], machine));
}

{
  const {
    photoFolderFingerprint,
    parsePhotoFolderVerifications,
    serializePhotoFolderVerifications,
    PHOTO_FOLDER_VERIFICATIONS_CAP,
  } = await import("../shared/photo-folder-verification");

  const fp = photoFolderFingerprint(["b.jpg", "a.jpg", "c.jpg"]);
  check("fingerprint is order-insensitive and duplicate-insensitive",
    fp === photoFolderFingerprint(["c.jpg", "a.jpg", "b.jpg", "a.jpg"]));
  check("fingerprint changes when any photo is added/removed/renamed",
    fp !== photoFolderFingerprint(["a.jpg", "b.jpg"])
    && fp !== photoFolderFingerprint(["a.jpg", "b.jpg", "c.jpg", "d.jpg"])
    && fp !== photoFolderFingerprint(["a.jpg", "b.jpg", "x.jpg"]));
  check("fingerprint carries the photo count (collision would also need same count)",
    fp.startsWith("v1:3:"));

  const roundTrip = parsePhotoFolderVerifications(serializePhotoFolderVerifications({
    "unit-721": { folder: "unit-721", fingerprint: fp, verifiedAt: "2026-07-12T00:00:00Z" },
  } as any));
  check("pin store round-trips",
    roundTrip["unit-721"]?.fingerprint === fp && roundTrip["unit-721"]?.verifiedAt === "2026-07-12T00:00:00Z");
  const polluted = parsePhotoFolderVerifications(JSON.stringify({
    "__proto__": { fingerprint: "x", verifiedAt: "2026-01-01" },
    "constructor": { fingerprint: "x", verifiedAt: "2026-01-01" },
    ok: { fingerprint: "f", verifiedAt: "2026-01-01" },
  }));
  check("pin store drops prototype-pollution keys and returns a null-prototype map",
    Object.keys(polluted).length === 1 && polluted["ok"]?.fingerprint === "f"
    && Object.getPrototypeOf(polluted) === null);
  check("pin store parse fails soft on junk",
    Object.keys(parsePhotoFolderVerifications("not json")).length === 0
    && Object.keys(parsePhotoFolderVerifications(null)).length === 0);
  const big: Record<string, any> = {};
  for (let i = 0; i < PHOTO_FOLDER_VERIFICATIONS_CAP + 20; i++) {
    big[`f${i}`] = { folder: `f${i}`, fingerprint: "fp", verifiedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` };
  }
  check("pin store caps at the newest N on write",
    Object.keys(JSON.parse(serializePhotoFolderVerifications(big))).length === PHOTO_FOLDER_VERIFICATIONS_CAP);
}

// _source.json backfill never clobbers (behavioral, real temp folder on disk).
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { writeFolderSourceUrlIfMissing, readFolderSourceUrl } = await import("../server/photo-folder-source");
  const folder = "test-source-backfill-tmp";
  const dir = path.resolve(process.cwd(), "client/public/photos", folder);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    check("backfill refuses a folder that doesn't exist on disk",
      !(await writeFolderSourceUrlIfMissing(folder, "https://example.com/listing")));
    fs.mkdirSync(dir, { recursive: true });
    check("backfill rejects non-http candidates",
      !(await writeFolderSourceUrlIfMissing(folder, "javascript:alert(1)"))
      && !(await writeFolderSourceUrlIfMissing(folder, "")));
    check("backfill writes when no _source.json exists",
      (await writeFolderSourceUrlIfMissing(folder, "https://example.com/listing")) === true
      && (await readFolderSourceUrl(folder)) === "https://example.com/listing");
    check("backfill NEVER clobbers an existing url",
      !(await writeFolderSourceUrlIfMissing(folder, "https://evil.example.com/other"))
      && (await readFolderSourceUrl(folder)) === "https://example.com/listing");
    fs.writeFileSync(path.join(dir, "_source.json"), JSON.stringify({ sourceListing: { title: "kept" }, extra: 1 }));
    check("backfill merges into an existing url-less _source.json (other fields kept)",
      (await writeFolderSourceUrlIfMissing(folder, "https://example.com/2")) === true
      && (() => {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, "_source.json"), "utf8"));
        return doc.sourceListing.url === "https://example.com/2" && doc.sourceListing.title === "kept" && doc.extra === 1;
      })());
    fs.writeFileSync(path.join(dir, "_source.json"), "{ not valid json");
    check("backfill leaves an unparseable _source.json untouched",
      !(await writeFolderSourceUrlIfMissing(folder, "https://example.com/3"))
      && fs.readFileSync(path.join(dir, "_source.json"), "utf8") === "{ not valid json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Source guards: the wiring that makes provenance real end-to-end.
{
  const engineSource = readFileSync("server/photo-community-check.ts", "utf8");
  check("engine runs the provenance upgrade pass gated by canUpgradeWithProvenance",
    engineSource.includes("canUpgradeWithProvenance(u.photoVerdicts, provenance)")
    && engineSource.includes("unitProvenanceFor(input, sp?.match)"));
  check("engine upgrade pass runs AFTER source pages and BEFORE verdict synthesis",
    engineSource.indexOf("Provenance upgrade (chain of custody)") > engineSource.indexOf("verifyUnitSourcePages(sourceUnitInputs")
    && engineSource.indexOf("Provenance upgrade (chain of custody)") < engineSource.indexOf("── Verdict synthesis ──"));
  check("provenance substitutes for the interior-sample-size warn",
    engineSource.includes("u.interiorPhotosChecked < UNIT_INTERIOR_MIN && !u.provenanceVerified"));

  const routesSource = readFileSync("server/routes.ts", "utf8");
  check("route STRIPS client-sent provenance fields (a browser can never assert custody)",
    routesSource.includes("({ swapVerified, operatorVerified, operatorVerifiedAt, ...rest }) => rest"));
  check("route enriches groups with server-derived provenance before the engine",
    routesSource.includes("await enrichCheckGroupsWithProvenance(request.groups)"));
  check("pin endpoint exists and validates the folder name",
    routesSource.includes('app.post("/api/builder/photo-folder-verification"')
    && routesSource.includes("setPhotoFolderVerification(folder, verified)"));

  const bulkSource = readFileSync("server/photo-community-bulk.ts", "utf8");
  check("bulk Comm-QA job applies the same enrichment (bulk must not read stricter than manual)",
    bulkSource.includes("enrichCheckGroupsWithProvenance(built.request.groups)"));

  const pinServerSource = readFileSync("server/photo-folder-verification.ts", "utf8");
  check("swap provenance requires a COMMITTED unit_swaps row for the replacement folder",
    pinServerSource.includes("replacementPhotoFolderRef(g.folder)")
    && pinServerSource.includes("latestUnitSwapsByUnit"));
  check("operator pin applies ONLY while the published-set fingerprint still matches",
    pinServerSource.includes("photoFolderFingerprint(filenames) === pin.fingerprint"));
  check("pin endpoint fingerprints the CURRENT published set at save time",
    pinServerSource.includes("listPublishedFilenames(folder)"));

  const sweepSource = readFileSync("server/unit-audit-sweep.ts", "utf8");
  check("sweep resolve stage backfills _source.json provenance",
    sweepSource.includes("backfillUnitSourceProvenance(target)"));
  check("sweep backfill: replacement folders take the committed swap's newSourceUrl",
    sweepSource.includes("newSourceUrl"));
  check("sweep backfill: draft source hints never apply to a swapped (replacement) folder",
    sweepSource.indexOf("replacementPhotoFolderRef(g.folder)") >= 0
    && /\}\s*else if \(target\.isDraft\)/.test(sweepSource));

  check("shared report renders the provenance chip",
    reportComponentSource.includes("Verified by provenance")
    && reportComponentSource.includes("provenanceReason"));
  check("shared report offers the operator pin only where it can help (never over a mismatch)",
    reportComponentSource.includes("button-pin-folder-verified-")
    && reportComponentSource.includes('hasMismatch || (u.sameAsCommunity !== "no" && !hasUncertain)'));
  check("pin button is operator-confirmed and POSTs the verification endpoint",
    reportComponentSource.includes("/api/builder/photo-folder-verification")
    && reportComponentSource.includes("Mark every photo currently in"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
