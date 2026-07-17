import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  AREA_SECTION_HEADERS,
  DESCRIPTION_OVERRIDE_FIELDS,
  DESCRIPTION_PLACEHOLDER_PHRASES,
  composeSpaceFromUnitDescriptions,
  composeSummaryWithDisclosures,
  findDescriptionReadbackMismatches,
  findDescriptionPlaceholders,
  normalizeDescriptionReadback,
  stripAreaSectionsFromDescription,
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
    /const access = singleListing[\s\S]{0,1200}access,[\s\S]{0,100}houseRules,/.test(routes)
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

// ── override field list ──────────────────────────────────────────────────────
check("override fields cover the editable set + title, and exclude compliance-owned notes",
  DESCRIPTION_OVERRIDE_FIELDS.includes("title")
  && DESCRIPTION_OVERRIDE_FIELDS.includes("summary")
  && DESCRIPTION_OVERRIDE_FIELDS.includes("houseRules")
  && !(DESCRIPTION_OVERRIDE_FIELDS as readonly string[]).includes("notes"));

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
