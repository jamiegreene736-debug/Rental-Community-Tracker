// Deterministic tests for the photo-pipeline sanity guards and the route
// module's fact extractors. Runs without hitting Anthropic/Apify —
// injects synthetic inputs and asserts the branches behave correctly.
//
// Run: npx tsx tests/pipeline-logic.test.ts

import assert from "node:assert/strict";

// ---------- Import the internals we want to test ----------
// The sanity check and fact extractors aren't exported, so we
// replicate their exact logic here from source to test the shape
// of inputs they handle. This is a fixture-level check, not a mock.

// Kept in sync with server/photo-pipeline.ts applyCategorySanityCheck.
const BEDROOM_KEYWORDS = /\b(bed|bedroom|suite|master|guest room|sleeping|primary|bunk|twin|queen|king|double|full)\b/i;
const BATHROOM_KEYWORDS = /\b(bath|bathroom|shower|tub|toilet|vanity|powder|half bath|lavatory|washroom|ensuite|en-suite|jetted)\b/i;
const KITCHEN_KEYWORDS = /\b(kitchen|kitchenette|pantry|breakfast bar)\b/i;
const HARD_CONFIDENCE_FLOOR = 0.40;

type R = { label: string | null; category: string | null; confidence: number };

function sanity(r: R): R {
  if (!r.category || !r.label) return r;
  const label = r.label;
  const cat = r.category;
  const labelHasBed = BEDROOM_KEYWORDS.test(label);
  const labelHasBath = BATHROOM_KEYWORDS.test(label);
  const labelHasKitchen = KITCHEN_KEYWORDS.test(label);
  if ((cat === "Bedrooms" || cat === "Bathrooms") && labelHasKitchen && !labelHasBed && !labelHasBath) {
    return { ...r, category: "Kitchen" };
  }
  if (cat === "Bedrooms" && !labelHasBed) {
    return { ...r, category: "Other" };
  }
  if (cat === "Bathrooms" && !labelHasBath) {
    return { ...r, category: "Other" };
  }
  if ((cat === "Bedrooms" || cat === "Bathrooms") && r.confidence < HARD_CONFIDENCE_FLOOR) {
    return { ...r, category: "Other" };
  }
  return r;
}

// ---------- Tests for the sanity check ----------
console.log("sanity check suite");

// Case 1: Legit bedroom — passes through.
assert.equal(
  sanity({ label: "King Bedroom", category: "Bedrooms", confidence: 0.95 }).category,
  "Bedrooms",
  "legit bedroom should pass through",
);
console.log("  ✓ legit bedroom passes");

// Case 2: Kitchen photo accidentally tagged Bedrooms (the Unit B bug).
assert.equal(
  sanity({ label: "Updated Kitchen With Island", category: "Bedrooms", confidence: 0.9 }).category,
  "Kitchen",
  "kitchen-labeled Bedrooms should demote to Kitchen",
);
console.log("  ✓ kitchen-labeled-as-Bedrooms demotes to Kitchen");

// Case 3: Bedrooms category but label has no bed vocabulary.
assert.equal(
  sanity({ label: "Open Floor Plan", category: "Bedrooms", confidence: 0.9 }).category,
  "Other",
  "Bedrooms category with no bed keywords should demote to Other",
);
console.log("  ✓ Bedrooms with no bed keywords demotes to Other");

// Case 4: Bathrooms with no bath vocabulary.
assert.equal(
  sanity({ label: "Wraparound Porch", category: "Bathrooms", confidence: 0.9 }).category,
  "Other",
  "Bathrooms with no bath keywords should demote to Other",
);
console.log("  ✓ Bathrooms with no bath keywords demotes to Other");

// Case 5: Moderate-confidence Bedroom with bed keywords — TRUST it.
// Previously we demoted anything below 0.70, which under-counted real
// bedrooms. Now only very-low confidence (< 0.40) gets demoted.
assert.equal(
  sanity({ label: "Queen Bedroom", category: "Bedrooms", confidence: 0.65 }).category,
  "Bedrooms",
  "moderate-confidence Bedroom with bed keywords should be trusted",
);
console.log("  ✓ moderate-confidence Bedroom with bed keywords is trusted");

// Case 5b: Very-low confidence Bedroom → demote.
assert.equal(
  sanity({ label: "King Bedroom", category: "Bedrooms", confidence: 0.3 }).category,
  "Other",
  "very-low-confidence Bedroom should demote to Other",
);
console.log("  ✓ very-low-confidence (<0.40) Bedroom demotes");

// Case 6: Low confidence but Kitchen stays (guard only applies to Bed/Bath).
assert.equal(
  sanity({ label: "Updated Kitchen", category: "Kitchen", confidence: 0.5 }).category,
  "Kitchen",
  "low-confidence Kitchen should NOT demote",
);
console.log("  ✓ low-confidence Kitchen stays (only private rooms guarded)");

// Case 6b: "Bedroom With Built-in Cabinet" — previously demoted by
// cabinet-keyword false-positive, now should stay.
assert.equal(
  sanity({ label: "Bedroom With Built-in Cabinet", category: "Bedrooms", confidence: 0.9 }).category,
  "Bedrooms",
  "bedroom with cabinet word should NOT demote to Kitchen",
);
console.log("  ✓ 'Bedroom With Cabinet' stays Bedrooms (cabinet no longer a kitchen trigger)");

// Case 6c: "Kitchen With Island" still demotes when categorized as Bedrooms.
assert.equal(
  sanity({ label: "Kitchen With Island", category: "Bedrooms", confidence: 0.9 }).category,
  "Kitchen",
  "label starting 'Kitchen' in Bedrooms category should demote to Kitchen",
);
console.log("  ✓ 'Kitchen With Island' mislabeled as Bedrooms demotes to Kitchen");

// Case 7: Primary Bathroom — valid (has \"Primary\" + \"Bathroom\").
assert.equal(
  sanity({ label: "Primary Bathroom With Shower", category: "Bathrooms", confidence: 0.9 }).category,
  "Bathrooms",
  "primary bathroom should pass",
);
console.log("  ✓ Primary Bathroom passes");

// Case 8: Suite detected as master-adjacent (has \"suite\" keyword).
assert.equal(
  sanity({ label: "Master Suite", category: "Bedrooms", confidence: 0.92 }).category,
  "Bedrooms",
  "master suite should pass",
);
console.log("  ✓ Master Suite passes");

// ---------- Tests for extractFactsFromJsonLd ----------
// (copied from server/routes.ts for the fixture test)
function extractFactsFromJsonLd(html: string) {
  const out: { bedrooms?: number; bathrooms?: number } = {};
  const matches = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of items) {
        if (!obj || typeof obj !== "object") continue;
        const bd = obj.numberOfBedrooms ?? obj.numberOfRooms;
        const ba = obj.numberOfBathroomsTotal ?? obj.numberOfFullBathrooms;
        if (out.bedrooms == null && typeof bd === "number" && bd > 0 && bd < 50) {
          out.bedrooms = Math.round(bd);
        }
        if (out.bathrooms == null && typeof ba === "number" && ba > 0 && ba < 50) {
          out.bathrooms = Math.floor(ba);
        }
      }
    } catch {}
  }
  return out;
}

console.log("\nJSON-LD extraction suite");

const jsonLdHtml = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SingleFamilyResidence","numberOfBedrooms":3,"numberOfBathroomsTotal":2}
</script>
</head></html>`;
const jsonLdResult = extractFactsFromJsonLd(jsonLdHtml);
assert.equal(jsonLdResult.bedrooms, 3, "should extract bedrooms from JSON-LD");
assert.equal(jsonLdResult.bathrooms, 2, "should extract bathrooms from JSON-LD");
console.log("  ✓ extracts bedrooms and bathrooms from SingleFamilyResidence");

// Malformed JSON-LD — should not crash.
const badHtml = `<script type="application/ld+json">{not json</script>`;
const badResult = extractFactsFromJsonLd(badHtml);
assert.equal(badResult.bedrooms, undefined, "malformed JSON-LD should not populate");
console.log("  ✓ malformed JSON-LD doesn't crash");

// ---------- Tests for extractFactsFromText ----------
function extractFactsFromText(html: string) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const out: { bedrooms?: number; bathrooms?: number } = {};
  const bedMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:beds?\b|bd\b|bedrooms?\b)/i);
  const bathMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:baths?\b|ba\b|bathrooms?\b)/i);
  if (bedMatch) {
    const n = parseFloat(bedMatch[1]);
    if (n > 0 && n < 50) out.bedrooms = Math.round(n);
  }
  if (bathMatch) {
    const n = parseFloat(bathMatch[1]);
    if (n > 0 && n < 50) out.bathrooms = Math.round(n * 2) / 2;
  }
  return out;
}

console.log("\ntext-regex extraction suite");

assert.deepEqual(
  extractFactsFromText("<span>3 bd</span><span>2.5 ba</span>"),
  { bedrooms: 3, bathrooms: 2.5 },
  "should extract 3 bd / 2.5 ba",
);
console.log("  ✓ extracts '3 bd 2.5 ba'");

assert.deepEqual(
  extractFactsFromText("<p>Beautiful 4 bedroom, 3 bathroom home.</p>"),
  { bedrooms: 4, bathrooms: 3 },
  "should extract 4 bedroom 3 bathroom",
);
console.log("  ✓ extracts '4 bedroom 3 bathroom' prose");

assert.deepEqual(
  extractFactsFromText("<strong>3 beds</strong> | <strong>2 baths</strong>"),
  { bedrooms: 3, bathrooms: 2 },
  "should extract 3 beds 2 baths",
);
console.log("  ✓ extracts '3 beds | 2 baths'");

// Half-bath precision check
assert.equal(
  extractFactsFromText("3 bed 2.5 bath").bathrooms,
  2.5,
  "should preserve 2.5 bathrooms",
);
console.log("  ✓ preserves half-bath precision");

// ---------- Tests for extractListingFacts (recursive tree walk) ----------
function extractListingFacts(payload: any) {
  const facts: { bedrooms?: number; bathrooms?: number } = {};
  function walk(o: any, depth: number): void {
    if (depth > 8 || !o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    if (facts.bedrooms == null && typeof o.bedrooms === "number" && o.bedrooms > 0 && o.bedrooms < 50) {
      facts.bedrooms = Math.round(o.bedrooms);
    }
    if (facts.bathrooms == null) {
      let b: number | undefined;
      if (typeof o.bathrooms === "number") b = o.bathrooms;
      else if (typeof o.bathroomsFull === "number") {
        b = o.bathroomsFull + (typeof o.bathroomsHalf === "number" ? o.bathroomsHalf * 0.5 : 0);
      } else if (typeof o.bathroomsTotalInteger === "number") b = o.bathroomsTotalInteger;
      if (typeof b === "number" && b > 0 && b < 50) {
        facts.bathrooms = Math.round(b * 2) / 2;
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  }
  walk(payload, 0);
  return facts;
}

console.log("\nlisting-facts extraction suite");

// Real Zillow __NEXT_DATA__ shape (simplified).
assert.deepEqual(
  extractListingFacts({
    props: { pageProps: { initialData: { data: { homeInfo: { bedrooms: 3, bathrooms: 2.5 } } } } },
  }),
  { bedrooms: 3, bathrooms: 2.5 },
  "should extract from homeInfo path",
);
console.log("  ✓ walks into homeInfo path and preserves half-bath");

// bathroomsFull + bathroomsHalf reconstruction when `bathrooms` is missing.
assert.deepEqual(
  extractListingFacts({
    props: { pageProps: { data: { bathroomsFull: 2, bathroomsHalf: 1, bedrooms: 3 } } },
  }),
  { bedrooms: 3, bathrooms: 2.5 },
  "should reconstruct 2.5 from Full=2 + Half=1",
);
console.log("  ✓ reconstructs 2.5 from bathroomsFull + bathroomsHalf");

// bathroomsTotalInteger as last-resort.
assert.deepEqual(
  extractListingFacts({ data: { bathroomsTotalInteger: 3, bedrooms: 4 } }),
  { bedrooms: 4, bathrooms: 3 },
  "should use integer fallback",
);
console.log("  ✓ falls back to bathroomsTotalInteger");

// Zero bedrooms (studio) → skipped (kept null).
assert.equal(
  extractListingFacts({ data: { bedrooms: 0, bathrooms: 1 } }).bedrooms,
  undefined,
  "zero bedrooms (studio) should be skipped",
);
console.log("  ✓ skips studios (bedrooms: 0)");

// Junk-huge value → skipped.
assert.equal(
  extractListingFacts({ data: { bedrooms: 999, bathrooms: 1 } }).bedrooms,
  undefined,
  "absurd bedroom count should be skipped",
);
console.log("  ✓ skips absurd bedroom counts");

// Nested array of listings — picks the shallowest match.
assert.deepEqual(
  extractListingFacts({
    searchResults: { listResults: [{ beds: 3, baths: 2 }, { bedrooms: 3, bathrooms: 2 }] },
  }),
  { bedrooms: 3, bathrooms: 2 },
  "should find nested listing data",
);
console.log("  ✓ finds nested list data");

// ---------- Tests for property-units duplicate guard ----------
// Validates that two listings in the same community cannot claim the
// same physical unit. Placeholder ids ("A", "B", "main") are exempt —
// they are display labels used before a real resort unit number has
// been backfilled, so they don't denote identity.
import {
  findDuplicateUnitsInCommunity,
  PROPERTY_UNIT_CONFIGS,
  type PropertyUnitConfig,
} from "../shared/property-units.ts";

console.log("\nproperty-units duplicate guard suite");

// Case 1: Clean config returns no duplicates.
assert.deepEqual(
  findDuplicateUnitsInCommunity({
    100: { community: "Poipu Kai", units: [{ unitId: "721", unitLabel: "Unit 721", bedrooms: 3 }] },
    101: { community: "Poipu Kai", units: [{ unitId: "812", unitLabel: "Unit 812", bedrooms: 3 }] },
  } as Record<number, PropertyUnitConfig>),
  [],
  "distinct unit ids in same community should not collide",
);
console.log("  ✓ distinct unit ids pass");

// Case 2: Same unit id, same community, different properties → collision.
const dupes = findDuplicateUnitsInCommunity({
  100: { community: "Poipu Kai", units: [{ unitId: "721", unitLabel: "Unit 721", bedrooms: 3 }] },
  101: { community: "Poipu Kai", units: [{ unitId: "721", unitLabel: "Unit 721", bedrooms: 3 }] },
} as Record<number, PropertyUnitConfig>);
assert.equal(dupes.length, 1, "should detect one duplicate unit");
assert.equal(dupes[0].community, "Poipu Kai");
assert.equal(dupes[0].unitId, "721");
assert.deepEqual(dupes[0].propertyIds.sort(), [100, 101]);
console.log("  ✓ cross-property collision detected");

// Case 3: Same unit id in different communities → NOT a collision.
assert.deepEqual(
  findDuplicateUnitsInCommunity({
    100: { community: "Poipu Kai",   units: [{ unitId: "A1", unitLabel: "A1", bedrooms: 3 }] },
    101: { community: "Princeville", units: [{ unitId: "A1", unitLabel: "A1", bedrooms: 3 }] },
  } as Record<number, PropertyUnitConfig>),
  [],
  "same unit id across different communities should not collide",
);
console.log("  ✓ cross-community same id is allowed");

// Case 4: Placeholder ids ("A"/"B"/"main") are exempt.
assert.deepEqual(
  findDuplicateUnitsInCommunity({
    100: { community: "Poipu Kai", units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
    ] },
    101: { community: "Poipu Kai", units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
    ] },
    102: { community: "Windsor Hills", units: [
      { unitId: "main", unitLabel: "Main", bedrooms: 3 },
    ] },
  } as Record<number, PropertyUnitConfig>),
  [],
  "placeholder ids A/B/main should be exempt from the collision check",
);
console.log("  ✓ placeholders A/B/main exempt");

// Case 5: Live config has no duplicates (regression guard against a
// future edit that accidentally reuses a real unit number).
assert.deepEqual(
  findDuplicateUnitsInCommunity(PROPERTY_UNIT_CONFIGS),
  [],
  "live PROPERTY_UNIT_CONFIGS should be free of community+unitId duplicates",
);
console.log("  ✓ live config has no duplicates");

// ---------- Pricing tables (shared/pricing-rates) ----------
console.log("\npricing tables suite");

import { getBuyInRate, suggestPricingArea, BUY_IN_RATES } from "../shared/pricing-rates";

// Caribe Cove (Kissimmee, FL) is the operator-validated 2BR low tier —
// $125/unit base × 2 units = $250 buy-in, matching what the unit
// actually rents for on Airbnb/VRBO including taxes + fees. If this
// number drifts up the dashboard reverts to its old $1,080-for-two-2BR
// behavior that triggered the original bug report.
assert.equal(getBuyInRate("Caribe Cove", 2), 125, "Caribe Cove 2BR base should be $125");
assert.equal(BUY_IN_RATES["Caribe Cove"]?.region, "florida");
console.log("  ✓ Caribe Cove 2BR pinned at $125");

// Windsor Hills now carries a 2BR entry too — without it the dashboard
// fell through to the FALLBACK_RATE_PER_BEDROOM (Hawaii-tier $270/BR)
// for any 2BR Disney-area draft.
assert.equal(getBuyInRate("Windsor Hills", 2), 150, "Windsor Hills 2BR base should be $150");
assert.equal(getBuyInRate("Southern Dunes", 2), 85, "Southern Dunes 2BR base should be $85");
console.log("  ✓ Florida 2BR rates filled in");

// Region-aware fallback: a Florida community not in the table picks
// the FL per-BR rate, NOT the Hawaii one. The bug we just fixed had a
// global $270/BR fallback that produced $540 per 2BR unit on Florida
// drafts where the real cost basis is closer to $125.
assert.equal(
  getBuyInRate("Southern Dunes", 5),
  80 * 5,
  "unknown bedroom count on a Florida community should use the FL fallback ($80/BR)",
);
console.log("  ✓ Florida fallback is $80/BR");

// suggestPricingArea: a Kissimmee draft named "Caribe Cove" should
// resolve to "Caribe Cove" via the new community-name match — not to
// "Windsor Hills" via the city regex. Same draft without the name
// should still default to Windsor Hills.
assert.equal(
  suggestPricingArea("Kissimmee", "Florida", "Caribe Cove Resort"),
  "Caribe Cove",
  "community name should override city default",
);
assert.equal(
  suggestPricingArea("Kissimmee", "Florida"),
  "Windsor Hills",
  "Kissimmee with no community name still defaults to Windsor Hills",
);
console.log("  ✓ suggestPricingArea matches by community name first");

// ---------- SearchAPI airbnb engine listing parser ----------
console.log("\nairbnb engine listing parser suite");

import { extractBedroomsFromListing } from "../server/community-research";

// SearchAPI's airbnb engine never returns `bedrooms` as a top-level
// number — the count lives in the title. These cases mirror the real
// shapes Caribe Cove returned during a prod probe (PR that introduced
// this test). If the engine starts returning a structured `bedrooms`
// field one day we can simplify, but until then this regex path is
// what stands between the engine and a useful pricing sample.
assert.equal(
  extractBedroomsFromListing({ title: "Boho Chic 2BR Condo Near Disney w/ Scenic Patio" }),
  2,
  "title with '2BR' → 2",
);
assert.equal(
  extractBedroomsFromListing({ name: "Spacious 3 Bedroom Vacation Home", description: "Apartment in Kissimmee" }),
  3,
  "title with '3 Bedroom' → 3",
);
assert.equal(
  extractBedroomsFromListing({ title: "Studio condo by the pool" }),
  0,
  "title with 'Studio' → 0",
);
assert.equal(
  extractBedroomsFromListing({ title: "Cozy efficiency unit" }),
  0,
  "title with 'efficiency' → 0",
);
assert.equal(
  extractBedroomsFromListing({ title: "Beautiful Two Bedroom by Disney" }),
  2,
  "title with 'Two Bedroom' → 2",
);
assert.equal(
  extractBedroomsFromListing({
    title: "Condo near parks",
    accommodations: ["3 bedrooms", "2 baths", "sleeps 8"],
  }),
  3,
  "accommodations array fallback when title is generic",
);
assert.ok(
  Number.isNaN(extractBedroomsFromListing({ title: "Vacation home rental" })),
  "title with no bedroom signal → NaN",
);
console.log("  ✓ extractBedroomsFromListing handles real engine shapes");

console.log("\nall suites passed ✅");
