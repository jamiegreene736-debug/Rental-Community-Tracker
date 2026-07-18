import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  AREA_SECTION_HEADERS,
  DESCRIPTION_OVERRIDE_FIELDS,
  DESCRIPTION_PLACEHOLDER_PHRASES,
  GROUNDING_SNIPPET_MAX_CHARS,
  SLEEPING_CAPACITY_RULE,
  SUMMARY_DISCLOSURE_LEADS,
  SUMMARY_DISCLOSURE_SEPARATOR,
  buildSleepingCapacityExplanation,
  clampGroundingSnippet,
  confirmedBeddingBedPortion,
  describesSleepingCapacity,
  ensureSleepingCapacityExplanation,
  sleepingCapacityPromptContext,
  generatedDraftCompletenessRegressions,
  composeSpaceFromUnitDescriptions,
  composeSummaryWithDisclosures,
  findDescriptionReadbackMismatches,
  findDescriptionPlaceholders,
  normalizeDescriptionReadback,
  photoCaptionDigest,
  stripAreaSectionsFromDescription,
  unconfirmedBedTypeMentions,
} from "../shared/description-copy";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("description-copy: Descriptions-tab copy pipeline helpers");

// ── stripAreaSectionsFromDescription ─────────────────────────────────────────
// The exact shape generate-listing stores on drafts: summary + space +
// "THE NEIGHBORHOOD" + "GETTING AROUND" glued with blank lines.
const FLAT = [
  "Bring the group together at Poipu Kai in Koloa, HI.",
  "This bundled stay combines Unit A (3BR) and Unit B (3BR).",
  "THE NEIGHBORHOOD",
  "Poipu Kai sits between two beloved beaches on Kauai's south shore.",
  "GETTING AROUND",
  "A rental car is recommended; Lihue airport is ~30 minutes away.",
].join("\n\n");

{
  const stripped = stripAreaSectionsFromDescription(FLAT);
  check("area sections removed from the flat draft description",
    !stripped.includes("THE NEIGHBORHOOD") && !stripped.includes("GETTING AROUND")
    && !stripped.includes("beloved beaches") && !stripped.includes("rental car"));
  check("summary/space body preserved",
    stripped.startsWith("Bring the group together") && stripped.includes("bundled stay combines"));
}

check("lowercase / colon header variants still match",
  !stripAreaSectionsFromDescription("Body text.\n\nThe Neighborhood:\n\nNearby stuff.").includes("Nearby stuff"));
check("prose merely MENTIONING 'the neighborhood' mid-line is untouched", (() => {
  const text = "Guests love the neighborhood around the resort.\n\nSecond paragraph.";
  return stripAreaSectionsFromDescription(text) === text;
})());
check("text without headers passes through trimmed",
  stripAreaSectionsFromDescription("  Plain summary.  ") === "Plain summary.");
check("trailing --- divider left by the cut is dropped",
  stripAreaSectionsFromDescription("Body.\n\n---\n\nTHE NEIGHBORHOOD\n\nArea.") === "Body.");
check("empty/nullish input → empty string",
  stripAreaSectionsFromDescription("") === "" && stripAreaSectionsFromDescription(undefined as unknown as string) === "");
check("header list stays in sync with the strip regex",
  AREA_SECTION_HEADERS.every((h) => !stripAreaSectionsFromDescription(`Body.\n\n${h}\n\nSection.`).includes("Section.")));

// ── findDescriptionPlaceholders ──────────────────────────────────────────────
// The literal fallback sentences from generate-listing's fallbackDraft().
const FALLBACK_SPACE_COMBO = "This bundled stay combines Unit A (3BR) and Unit B (2BR) at Poipu Kai. Update bedding, bathrooms, and amenity details once the exact units are confirmed.";
const FALLBACK_NEIGHBORHOOD = "Poipu Kai places guests in the Koloa, HI area, close to local beaches, restaurants, shopping, and outdoor activities. Add specific nearby landmarks and drive times before publishing.";
const FALLBACK_TRANSIT = "A rental car is recommended for exploring Koloa and the surrounding area. Add airport distance, parking details, and walkability notes once the exact unit location is confirmed.";
const FALLBACK_SPACE_SINGLE = "This standalone unit includes 2 bedrooms and a practical condo-style layout. Update the bedroom layout, bedding, bathrooms, and amenities once the exact unit details are confirmed.";

check("combo fallback space is flagged",
  findDescriptionPlaceholders({ space: FALLBACK_SPACE_COMBO }).length > 0);
check("fallback neighborhood is flagged",
  findDescriptionPlaceholders({ neighborhood: FALLBACK_NEIGHBORHOOD }).length > 0);
check("fallback transit is flagged",
  findDescriptionPlaceholders({ transit: FALLBACK_TRANSIT }).length > 0);
check("single-listing fallback space is flagged",
  findDescriptionPlaceholders({ space: FALLBACK_SPACE_SINGLE }).length > 0);
check("hit carries the field name",
  findDescriptionPlaceholders({ neighborhood: FALLBACK_NEIGHBORHOOD })[0].field === "neighborhood");
check("real operator copy passes clean",
  findDescriptionPlaceholders({
    summary: "Bring the group together at Poipu Kai — 6 bedrooms across two condos a short walk apart.",
    neighborhood: "Poipu Beach Park and Shipwreck Beach are both a short stroll away.",
    transit: "Lihue airport is about 30 minutes by rental car; parking is free on site.",
  }).length === 0);
check("empty/null fields are ignored",
  findDescriptionPlaceholders({ summary: "", space: null, transit: undefined }).length === 0);
check("matching is case-insensitive",
  findDescriptionPlaceholders({ space: FALLBACK_SPACE_COMBO.toUpperCase() }).length > 0);

// ── exact normalized Guesty read-back ───────────────────────────────────────
check("read-back normalization accepts only line-ending and edge-whitespace changes",
  normalizeDescriptionReadback("  First\r\nSecond \r") === "First\nSecond");
check("read-back verifier checks every submitted field, including title", (() => {
  const mismatches = findDescriptionReadbackMismatches(
    { title: "Exact title", summary: "Line one\r\nLine two", access: "Private home" },
    { title: "Different title", summary: " Line one\nLine two ", access: "Private home" },
  );
  return mismatches.length === 1 && mismatches[0].field === "title";
})());
check("read-back verifier catches an omitted non-summary field",
  findDescriptionReadbackMismatches(
    { title: "Title", summary: "Summary", houseRules: "Care for the home." },
    { title: "Title", summary: "Summary" },
  ).some((mismatch) => mismatch.field === "houseRules"));

// ── source lock: routes.ts fallback copy stays covered by the phrase list ────
{
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  // Every fallbackDraft sentence that instructs the OPERATOR must be
  // detected. If a fallback sentence in routes.ts is reworded, add its
  // new phrasing to DESCRIPTION_PLACEHOLDER_PHRASES in the same PR.
  const stillPresent = DESCRIPTION_PLACEHOLDER_PHRASES.filter((p) =>
    routes.toLowerCase().includes(p),
  );
  check("routes.ts fallbackDraft copy matches the detector phrase list (drift lock)",
    stillPresent.length >= 5);
  check("push-descriptions endpoint runs the placeholder guard",
    /push-descriptions[\s\S]{0,2500}findDescriptionPlaceholders/.test(routes));
  check("push-descriptions verifies exact normalized read-back and fails mismatches",
    /push-descriptions[\s\S]{0,5000}findDescriptionReadbackMismatches[\s\S]{0,800}recordGuestyPush\(listingId, "descriptions", "error"[\s\S]{0,300}res\.status\(502\)/.test(routes)
    && !/const summaryWasSaved/.test(routes));
  check("Claude output asks for all seven operator-editable fields in both prompt variants",
    (routes.match(/\"access\": \"1 short paragraph/g) ?? []).length === 2
    && (routes.match(/\"houseRules\": \"1 short paragraph/g) ?? []).length === 2);
  check("Claude access/rules prompt forbids unsourced operational specifics",
    routes.includes("never invent access codes")
    && routes.includes("parking details")
    && routes.includes("quiet hours")
    && routes.includes("check-in or check-out times")
    && routes.includes("pet rules")
    && routes.includes("smoking rules")
    && routes.includes("fee specifics"));
  check("generate-listing returns access and houseRules for Claude and fallback output",
    // Window widened 1200 -> 1600 on 2026-07-18: the fallback path gained the
    // sleeping-capacity ensure, growing this span. Intent unchanged.
    /const access = singleListing[\s\S]{0,1600}access,[\s\S]{0,100}houseRules,/.test(routes)
    && /access: parsedAccess,[\s\S]{0,100}houseRules: parsedHouseRules/.test(routes));
  check("bulk-combo copy step passes the real unit source URLs",
    /generate-listing[\s\S]{0,600}unit1:\s*\{\s*bedrooms:\s*effUnit1Beds,\s*url:\s*item\.unit1SourceUrl/.test(routes));
  check("draftToGuestySummarySource strips area sections",
    /draftToGuestySummarySource[\s\S]{0,900}stripAreaSectionsFromDescription/.test(routes));
}

// ── source lock: client paths ────────────────────────────────────────────────
{
  const adaptDraft = readFileSync(new URL("../client/src/data/adapt-draft.ts", import.meta.url), "utf8");
  check("adapt-draft descriptionForDraft strips area sections",
    /descriptionForDraft[\s\S]{0,700}stripAreaSectionsFromDescription\(draft\.listingDescription/.test(adaptDraft));
  const builderIndex = readFileSync(new URL("../client/src/components/GuestyListingBuilder/index.tsx", import.meta.url), "utf8");
  check("builder has the Regenerate descriptions button",
    builderIndex.includes("btn-regenerate-descriptions") && builderIndex.includes("regenerateDescriptions"));
  check("builder persists description edits via the overrides endpoint",
    builderIndex.includes("/api/builder/descriptions/") && builderIndex.includes("btn-save-descriptions"));
  check("regenerate never applies fallback scaffolding (warning → error)",
    /gen\?\.warning[\s\S]{0,120}throw new Error/.test(builderIndex));
  check("manual regenerate applies Claude access and houseRules",
    /gen\?\.access[\s\S]{0,160}gen\?\.houseRules[\s\S]{0,200}!access \|\| !houseRules[\s\S]{0,200}nextEdits\.access[\s\S]{0,100}nextEdits\.houseRules/.test(builderIndex));
}

// ── composeSummaryWithDisclosures ────────────────────────────────────────────
check("combo: top + body + bottom joined with --- separators", (() => {
  const s = composeSummaryWithDisclosures("Body.", { top: "TOP", bottom: "BOTTOM" });
  return s === "TOP\n\n---\n\nBody.\n\n---\n\nBOTTOM";
})());
check("single: empty top disclosure is dropped",
  composeSummaryWithDisclosures("Body.", { top: "", bottom: "BOTTOM" }) === "Body.\n\n---\n\nBOTTOM");
check("blank body collapses to disclosures only",
  composeSummaryWithDisclosures("  ", { top: "TOP", bottom: "BOTTOM" }) === "TOP\n\n---\n\nBOTTOM");

// ── composeSpaceFromUnitDescriptions ─────────────────────────────────────────
check("units labeled + walk line appended", (() => {
  const s = composeSpaceFromUnitDescriptions(
    [
      { label: "Unit A (3BR)", text: "Ocean-view condo." },
      { label: "Unit B (2BR)", text: "Garden-level condo." },
    ],
    "The two units are a short 3-minute walk apart.",
  );
  return s === "Unit A (3BR): Ocean-view condo.\n\nUnit B (2BR): Garden-level condo.\n\nThe two units are a short 3-minute walk apart.";
})());
check("empty unit text dropped; no walk line for singles",
  composeSpaceFromUnitDescriptions([{ label: "Unit A (2BR)", text: "Cozy condo." }, { label: "Unit B (2BR)", text: "" }], null)
    === "Unit A (2BR): Cozy condo.");

// ── generator grounding helpers (2026-07-17) ─────────────────────────────────
check("clampGroundingSnippet collapses whitespace and trims",
  clampGroundingSnippet("  King   Bedroom \n Lanai\tWith Ocean View  ") === "King Bedroom Lanai With Ocean View");
check("clampGroundingSnippet caps at the shared snippet limit",
  clampGroundingSnippet("x".repeat(2000)).length === GROUNDING_SNIPPET_MAX_CHARS
  && clampGroundingSnippet("abcdef", 3) === "abc");
check("clampGroundingSnippet nullish → empty string",
  clampGroundingSnippet(null) === "" && clampGroundingSnippet(undefined) === "");

check("photoCaptionDigest dedupes case-insensitively, keeps hero-first order", (() => {
  const digest = photoCaptionDigest([
    "Lanai With Ocean View", "King Bedroom", "lanai with ocean view", " King Bedroom ", "Updated Kitchen",
  ]);
  return digest === "Lanai With Ocean View; King Bedroom; Updated Kitchen";
})());
check("photoCaptionDigest drops empty captions and respects maxItems", (() => {
  const digest = photoCaptionDigest(["", null, "A", "B", "C"], { maxItems: 2 });
  return digest === "A; B";
})());
check("photoCaptionDigest of nothing is empty",
  photoCaptionDigest([]) === "" && photoCaptionDigest([null, "  "]) === "");

// The confirmed string is describeUnitBedding's shape — bare bed-type
// labels ("King", "2 Twin / Singles"), not "King bed" prose.
const CONFIRMED = "Master Bedroom: King (ensuite); Bedroom 2: 2 Twin / Singles. Living room sofa bed. Bathrooms: Hall Bath (Walk-in shower).";
check("prose matching the confirmed bedding passes clean",
  unconfirmedBedTypeMentions(
    "The master offers a King bed, the second bedroom has two twin beds, and there is a sofa bed in the living room.",
    CONFIRMED,
  ).length === 0);
check("an invented Queen bed is flagged", (() => {
  const hits = unconfirmedBedTypeMentions("The second bedroom has a Queen bed.", CONFIRMED);
  return hits.length === 1 && hits[0] === "Queen bed";
})());
check("caption-style 'King Bedroom' counts as a King-bed claim",
  unconfirmedBedTypeMentions("The King Bedroom overlooks the pool.", "Bedroom 1: Queen. Bathrooms: Hall Bath.")
    .includes("King bed"));
check("'a single bedroom unit' and 'full kitchen' never false-positive",
  unconfirmedBedTypeMentions("A single bedroom unit with a full kitchen and full bathroom.", CONFIRMED).length === 0);
check("'queen sleeper sofa' reads as the confirmed sofa bed, not a Queen bed",
  unconfirmedBedTypeMentions("A queen sleeper sofa rounds out the living room.", CONFIRMED).length === 0);
check("a pull-out couch is flagged when no sofa bed is confirmed", (() => {
  const hits = unconfirmedBedTypeMentions("A pull-out couch in the den.", "Bedroom 1: King. Bathrooms: Hall Bath.");
  return hits.length === 1 && hits[0] === "Sofa bed";
})());
check("'king-size bed' is flagged when the config has no King",
  unconfirmedBedTypeMentions("Sleep on a king-size bed.", "Bedroom 1: Queen. Bathrooms: Hall Bath.")
    .includes("King bed"));
check("empty confirmed config never flags (no basis to audit)",
  unconfirmedBedTypeMentions("A King bed and a Queen bed.", "").length === 0
  && unconfirmedBedTypeMentions("", CONFIRMED).length === 0);

// Review fixes (2026-07-17 adversarial pass):
check("'Double vanity' bathroom feature cannot mask an invented double/full bed",
  unconfirmedBedTypeMentions(
    "A full-size bed in the second bedroom.",
    "Master Bedroom: King (ensuite). Bathrooms: Hall Bath (Double vanity).",
  ).includes("Double/Full bed"));
check("'Full Bath' label cannot mask an invented full bed",
  unconfirmedBedTypeMentions("A full bed in the den.", "Bedroom 1: King. Bathrooms: Full Bath.")
    .includes("Double/Full bed"));
check("plural confirmed labels ('2 Queens', '2 Kings') never false-flag correct prose",
  unconfirmedBedTypeMentions(
    "The master offers two King beds and the second bedroom has two Queen beds.",
    "Master Bedroom: 2 Kings; Bedroom 2: 2 Queens. Bathrooms: Hall Bath.",
  ).length === 0);
check("'Living room 2 sofa beds' confirms sleeper-sofa prose",
  unconfirmedBedTypeMentions(
    "Two sleeper sofas round out the living room.",
    "Bedroom 1: King. Living room 2 sofa beds. Bathrooms: Hall Bath.",
  ).length === 0);
check("confirmedBeddingBedPortion cuts at the Bathrooms section",
  confirmedBeddingBedPortion("Bedroom 1: King. Bathrooms: Full Bath (Double vanity).") === "Bedroom 1: King."
  && confirmedBeddingBedPortion(null) === "");
check("array form audits each unit's bed portion — unit 2 beds survive unit 1's bathroom cut", (() => {
  const hits = unconfirmedBedTypeMentions(
    "A King bed, a Queen bed, and a double bed.",
    ["Bedroom 1: King. Bathrooms: Full Bath (Double vanity).", "Bedroom 1: Queen. Bathrooms: Hall Bath."],
  );
  return hits.length === 1 && hits[0] === "Double/Full bed";
})());

const COMPLETE_DRAFT = {
  title: "T", bookingTitle: "BT", summary: "S", space: "SP", neighborhood: "N",
  transit: "TR", access: "A", houseRules: "H",
  unitA: { bedding: "King", shortDescription: "short", longDescription: "long" },
  unitB: { bedding: "Queen", shortDescription: "short", longDescription: "long" },
};
check("completeness: identical drafts have no regressions",
  generatedDraftCompletenessRegressions(COMPLETE_DRAFT, COMPLETE_DRAFT).length === 0);
check("completeness: a retry missing unitA regresses",
  generatedDraftCompletenessRegressions(COMPLETE_DRAFT, { ...COMPLETE_DRAFT, unitA: undefined }).includes("unitA"));
check("completeness: a retry that gutted a longDescription regresses",
  generatedDraftCompletenessRegressions(
    COMPLETE_DRAFT,
    { ...COMPLETE_DRAFT, unitA: { ...COMPLETE_DRAFT.unitA, longDescription: "  " } },
  ).includes("unitA.longDescription"));
check("completeness: a retry that dropped summary regresses",
  generatedDraftCompletenessRegressions(COMPLETE_DRAFT, { ...COMPLETE_DRAFT, summary: "" }).includes("summary"));
check("completeness: a single-listing first draft (no unitB) never demands unitB of the retry",
  generatedDraftCompletenessRegressions(
    { ...COMPLETE_DRAFT, unitB: null },
    { ...COMPLETE_DRAFT, unitB: null },
  ).length === 0);
check("completeness: fields the FIRST draft lacked are not regressions",
  generatedDraftCompletenessRegressions({ ...COMPLETE_DRAFT, neighborhood: "" }, { ...COMPLETE_DRAFT, neighborhood: "" }).length === 0);

// ── source lock: generator grounding wiring (2026-07-17) ────────────────────
{
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  check("both prompt variants carry the authoritative confirmed-bedding rule",
    (routes.match(/\$\{CONFIRMED_BEDDING_RULE\}/g) ?? []).length === 2
    && routes.includes("authoritative, operator-verified fact"));
  check("both prompt variants carry the photo-evidence rule",
    (routes.match(/\$\{PHOTO_FACTS_RULE\}/g) ?? []).length === 2
    && routes.includes("do not advertise a view or amenity that none of the supplied facts support"));
  check("confirmed-bedding CONTEXT lines exist in single (1) + combo (2) variants",
    (routes.match(/CONFIRMED bedding & bathrooms \(operator's Bedding tab — authoritative\)/g) ?? []).length === 3);
  check("generate-listing grounds photo captions via the shared group builder (captions digested per unit + community)",
    /generate-listing", async[\s\S]{0,25000}buildPhotoCommunityCheckRequestForProperty\(groundingPropertyId\)[\s\S]{0,800}photoCaptionDigest/.test(routes));
  check("generate-listing grounds saved amenities from the property store",
    /generate-listing", async[\s\S]{0,26000}getPropertyAmenities\(groundingPropertyId\)[\s\S]{0,400}getAmenityLabel/.test(routes));
  check("confirmed bedding deterministically overwrites the structured bedding field",
    /unitA: withConfirmedBedding\(normalizeGeneratedUnitDraft\(parsed\.unitA, unit1\), unit1ConfirmedBedding\)/.test(routes)
    && /withConfirmedBedding\(normalizeGeneratedUnitDraft\(parsed\.unitB, unit2\), unit2ConfirmedBedding\)/.test(routes));
  check("a bed-type contradiction triggers ONE corrective retry, never a fallback",
    /auditBeddingAccuracy\(parsed\)[\s\S]{0,900}IMPORTANT CORRECTION[\s\S]{0,1600}retriedNotes\.length <= accuracyNotes\.length/.test(routes));
  check("persistent mismatches surface as accuracyNotes — never as the warning field every consumer refuses",
    /\.\.\.\(accuracyNotes\.length > 0 \? \{ accuracyNotes \} : \{\}\)/.test(routes)
    && !/warning:\s*accuracyNotes/.test(routes));
  check("an audit-clean but structurally incomplete retry is discarded (never replaces the first draft)",
    /generatedDraftCompletenessRegressions\(parsed, retried\)[\s\S]{0,400}regressions\.length > 0[\s\S]{0,400}retriedNotes\.length <= accuracyNotes\.length/.test(routes));
  check("the audit skips the model's bedding field (deterministically overwritten) and passes array-form confirmed strings",
    /const prose = \[unitDraft\.shortDescription, unitDraft\.longDescription\]/.test(routes)
    && !/\[unitDraft\.bedding, unitDraft\.shortDescription/.test(routes)
    && /unconfirmedBedTypeMentions\(sharedProse, \[unit1ConfirmedBedding, unit2ConfirmedBedding\]\)/.test(routes));

  const builderIndex = readFileSync(new URL("../client/src/components/GuestyListingBuilder/index.tsx", import.meta.url), "utf8");
  check("regenerate sends propertyId + the confirmed Bedding-tab config",
    /generate-listing[\s\S]{0,1400}propertyId,[\s\S]{0,900}confirmedBedding: unit1ConfirmedBedding/.test(builderIndex)
    && builderIndex.includes("describeUnitBedding"));
  check("regenerate matches bedding-config units by canonical unitId (index only as fallback)",
    /cfgUnits\.find\(\(c\) => c\.unitId === unitId\)[\s\S]{0,60}\?\? cfgUnits\[index\]/.test(builderIndex));
  check("regenerate surfaces persistent accuracyNotes to the operator",
    /accuracyNotes[\s\S]{0,700}Review bedding mentions/.test(builderIndex));

  const sweep = readFileSync(new URL("../server/unit-audit-sweep.ts", import.meta.url), "utf8");
  check("audit-sweep regenerate passes propertyId for server-side photo/amenity grounding",
    /generate-listing", \{[\s\S]{0,600}propertyId: target\.propertyId/.test(sweep));
}

// ── sleeping-capacity explanation (2026-07-18) ───────────────────────────────
{
  const combo4 = buildSleepingCapacityExplanation({ bedrooms: 4, unitCount: 2 })!;
  check("4BR combo derives the operator's arithmetic: 8 in bedrooms + 4 on sofas = 12",
    combo4.sleeps === 12 && combo4.bedroomGuests === 8 && combo4.sofaGuests === 4 && combo4.sofaCount === 2);
  check("4BR sentence states both numbers and the total",
    /\b4 bedrooms sleep 8 guests at 2 per bedroom\b/.test(combo4.sentence)
    && /\b8 plus 4 is 12 guests in total\b/.test(combo4.sentence));
  check("combo sentence attributes one sleeper sofa to each unit",
    /each of the 2 units has a sleeper sofa in the living area that sleeps 2/.test(combo4.sentence));

  // The Bedding tab captures no sofa SIZE, so claiming one would invent a fact
  // (same rule buildSpaceDescription follows).
  check("never claims a sleeper-sofa size, and the prompt rule forbids one",
    !/queen sleeper sofa|king sleeper sofa/i.test(combo4.sentence)
    && /Never claim a size for a sleeper sofa/i.test(SLEEPING_CAPACITY_RULE));
  // Booking.com mangles non-ASCII.
  check("sentence is ASCII-only", /^[\x20-\x7E]*$/.test(combo4.sentence));

  const single2 = buildSleepingCapacityExplanation({ bedrooms: 2, unitCount: 1 })!;
  check("2BR standalone: 4 in bedrooms + 2 on one sofa = 6",
    single2.sleeps === 6 && single2.sofaCount === 1
    && /the living area has a sleeper sofa that sleeps 2/.test(single2.sentence));

  check("1BR pluralization reads 'the 1 bedroom sleeps'",
    /the 1 bedroom sleeps 2 guests/.test(buildSleepingCapacityExplanation({ bedrooms: 1, unitCount: 1 })!.sentence));

  // Honesty guards — say nothing rather than assert a breakdown we can't back.
  check("no bedrooms -> null", buildSleepingCapacityExplanation({ bedrooms: 0, unitCount: 2 }) === null);
  check("standalone listing carrying the combo +4 -> null (never claims 2 sofas in one condo)",
    buildSleepingCapacityExplanation({ bedrooms: 3, unitCount: 1 }) === null);

  // ── placement inside a composed summary ────────────────────────────────────
  const TOP = "Please note: this listing combines two units within the same community.";
  const BOTTOM = "Unit assignment note: This listing uses representative accommodations.";
  const comboSummary = [TOP, "Bring the group together at Poipu Kai.", BOTTOM].join(SUMMARY_DISCLOSURE_SEPARATOR);
  const comboOut = ensureSleepingCapacityExplanation(comboSummary, combo4);
  const comboBlocks = comboOut.split(SUMMARY_DISCLOSURE_SEPARATOR);
  check("combo: paragraph lands in the BODY block, not the disclosures",
    comboBlocks.length === 3
    && comboBlocks[0] === TOP
    && comboBlocks[2] === BOTTOM
    && comboBlocks[1].includes(combo4.sentence));

  const singleSummary = ["Enjoy a standalone 2-bedroom condo.", BOTTOM].join(SUMMARY_DISCLOSURE_SEPARATOR);
  const singleBlocks = ensureSleepingCapacityExplanation(singleSummary, single2).split(SUMMARY_DISCLOSURE_SEPARATOR);
  check("single listing (body + bottom disclosure): paragraph lands in the body",
    singleBlocks.length === 2 && singleBlocks[1] === BOTTOM && singleBlocks[0].includes(single2.sentence));

  check("plain body with no disclosures gets the paragraph appended",
    ensureSleepingCapacityExplanation("A lovely condo.", combo4)
      === `A lovely condo.\n\n${combo4.sentence}`);

  check("degenerate all-disclosure summary gets its own block, never swallowed by one",
    ensureSleepingCapacityExplanation([BOTTOM, BOTTOM].join(SUMMARY_DISCLOSURE_SEPARATOR), combo4)
      .split(SUMMARY_DISCLOSURE_SEPARATOR)[1] === combo4.sentence);

  check("null explanation leaves the summary untouched",
    ensureSleepingCapacityExplanation(comboSummary, null) === comboSummary);

  // ── idempotency: the backfill and the generator both re-run over live copy ──
  check("second pass is a no-op (no duplicate paragraph)",
    ensureSleepingCapacityExplanation(comboOut, combo4) === comboOut);

  // Detection must accept Claude's OWN wording — a false negative would append
  // a duplicate explanation to live guest-facing copy.
  const modelWrote = "Gather 12 guests across 4 bedrooms. The bedrooms sleep 8, and a sleeper sofa in each unit brings the total to 12.";
  check("recognises a model-written explanation and leaves it alone",
    describesSleepingCapacity(modelWrote, combo4)
    && ensureSleepingCapacityExplanation(modelWrote, combo4) === modelWrote);
  check("prose naming the total but no sofa is NOT treated as explained",
    !describesSleepingCapacity("Sleeps 12 guests across 8 beds.", combo4));

  // ── prompt context mirrors the deterministic sentence ──────────────────────
  const ctx = sleepingCapacityPromptContext(combo4);
  check("prompt context carries the same numbers as the sentence",
    ctx.includes("4 bedrooms sleep 8 guests at 2 per bedroom")
    && ctx.includes("for 4 more") && ctx.includes("sleeps 12 in total"));
  check("prompt context is empty when there is nothing honest to say",
    sleepingCapacityPromptContext(null) === "");
}

// ── source guards: the wiring that makes every listing explain its occupancy ──
{
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  check("generate-listing derives the explanation from the listing's own unit count",
    /buildSleepingCapacityExplanation\(\{[\s\S]{0,160}unitCount: singleListing \? 1 : 2/.test(routes));
  check("BOTH prompt variants inject the capacity CONTEXT",
    (routes.match(/\$\{sleepingCapacityPromptContext\(capacityExplanation\)\}/g) ?? []).length === 2);
  check("BOTH prompt variants carry the capacity CONSTRAINT rule",
    (routes.match(/\$\{SLEEPING_CAPACITY_RULE\}/g) ?? []).length === 2);
  // Belt and braces: prompting alone can't guarantee "every listing explains it".
  check("Claude path deterministically ensures the explanation before the fee note",
    /ensureSleepingCapacityExplanation\(parsedSummary, capacityExplanation\)[\s\S]{0,400}appendResortFeeNote\(\s*summaryWithCapacity/.test(routes));
  check("no-key fallback path ensures it too",
    /ensureSleepingCapacityExplanation\(summary, capacityExplanation\)/.test(routes));

  // The backfill is surgical by operator decision — it must never re-run Claude
  // over the portfolio, and must persist an override so a later
  // push-descriptions can't revert Guesty to the un-explained summary.
  const backfill = routes.slice(routes.indexOf("/api/admin/backfill-sleeping-capacity"));
  const backfillBody = backfill.slice(0, backfill.indexOf("/api/builder/push-photos"));
  check("backfill streams NDJSON with a heartbeat (Railway's 15-min edge cap)",
    /application\/x-ndjson/.test(backfillBody) && /type: "heartbeat"/.test(backfillBody));
  check("backfill is dry-run unless { execute: true }",
    /const execute = body\.execute === true/.test(backfillBody));
  check("backfill inserts into the CURRENT summary rather than regenerating copy",
    /ensureSleepingCapacityExplanation\(currentSummary, explanation\)/.test(backfillBody)
    // No AI call anywhere in the walk — surgical by operator decision, so live
    // OTA copy and hand-edited overrides survive verbatim.
    && !/anthropic|requestClaudeDraft|loopbackJson/i.test(backfillBody));
  check("backfill persists the override before pushing, so a later push can't revert it",
    backfillBody.indexOf("upsertPropertyDescriptionOverrides") < backfillBody.indexOf('guestyRequest("PUT"'));
  check("backfill verifies the write by read-back",
    /normalizeDescriptionReadback\(savedSummary\) === normalizeDescriptionReadback\(nextSummary\)/.test(backfillBody));
  check("backfill refuses to contradict the occupancy Guesty already advertises",
    /advertised !== explanation\.sleeps/.test(backfillBody));

  // Disclosure leads are matched as literal prefixes — reword a disclosure in
  // unit-builder-data.ts and placement silently lands in the wrong block.
  const builderData = readFileSync(new URL("../client/src/data/unit-builder-data.ts", import.meta.url), "utf8");
  const disclosureSrc = builderData.toLowerCase();
  check("SUMMARY_DISCLOSURE_LEADS still match the live disclosure constants",
    SUMMARY_DISCLOSURE_LEADS.every((lead) => disclosureSrc.includes(lead)));
}

// ── override field list ──────────────────────────────────────────────────────
check("override fields cover the editable set + title, and exclude compliance-owned notes",
  DESCRIPTION_OVERRIDE_FIELDS.includes("title")
  && DESCRIPTION_OVERRIDE_FIELDS.includes("summary")
  && DESCRIPTION_OVERRIDE_FIELDS.includes("houseRules")
  && !(DESCRIPTION_OVERRIDE_FIELDS as readonly string[]).includes("notes"));

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
