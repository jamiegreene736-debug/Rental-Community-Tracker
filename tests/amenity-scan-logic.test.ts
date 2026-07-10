import assert from "node:assert";
import fs from "node:fs";

import {
  buildAmenityDetectionInstruction,
  buildAmenityLocationResearchPrompt,
  parseAmenityDetectionJson,
  mergeDetectedAmenities,
} from "../shared/amenity-scan-logic";
import {
  AMENITY_VISION_TARGETS,
  AMENITY_LOCATION_TARGETS,
  AMENITY_CATALOG_KEYS,
  GUESTY_AMENITY_CATALOG,
  HAWAII_BASE_AMENITY_KEYS,
  getAmenityLabel,
} from "../shared/guesty-amenity-catalog";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("amenity-scan-logic: photo-driven amenity detection + add-only merge");

const VALID = AMENITY_CATALOG_KEYS;
const VISION_KEYS = new Set(AMENITY_VISION_TARGETS.map((t) => t.key));

// ── catalog integrity ────────────────────────────────────────────────────────
check("every vision target key exists in the catalog",
  AMENITY_VISION_TARGETS.every((t) => VALID.has(t.key)));
check("every baseline key exists in the catalog",
  HAWAII_BASE_AMENITY_KEYS.every((k) => VALID.has(k)));
check("catalog keys are unique",
  new Set(GUESTY_AMENITY_CATALOG.map((a) => a.key)).size === GUESTY_AMENITY_CATALOG.length);
check("vision targets are unique",
  new Set(AMENITY_VISION_TARGETS.map((t) => t.key)).size === AMENITY_VISION_TARGETS.length);

// ── buildAmenityDetectionInstruction ─────────────────────────────────────────
{
  const prompt = buildAmenityDetectionInstruction(AMENITY_VISION_TARGETS, {
    communityName: "Kaha Lani Resort",
    labelForKey: getAmenityLabel,
  });
  check("prompt names the community", prompt.includes("Kaha Lani Resort"));
  check("prompt lists a target key + hint", prompt.includes("POOL") && prompt.includes("resort swimming pool"));
  check("prompt asks for minified JSON present[]", prompt.includes('"present"'));
  check("prompt is add-only (no removal wording)", !/\bremove\b/i.test(prompt) && !/\babsent\b/i.test(prompt));
}
{
  const prompt = buildAmenityDetectionInstruction(AMENITY_VISION_TARGETS, {});
  check("prompt works without a community name", prompt.length > 0 && !prompt.includes("The property is"));
}

// ── parseAmenityDetectionJson ────────────────────────────────────────────────
{
  const { detected, detail } = parseAmenityDetectionJson(
    { present: [
      { key: "POOL", confidence: "high", evidence: "resort pool" },
      { key: "HOT_TUB", confidence: "medium", evidence: "spa next to pool" },
      { key: "MOUNTAIN_VIEW", confidence: "low", evidence: "maybe hills far off" },
      { key: "NOT_A_REAL_KEY", confidence: "high", evidence: "junk" },
    ] },
    VALID,
  );
  check("keeps high + medium keys", detected.includes("POOL") && detected.includes("HOT_TUB"));
  check("drops low-confidence from detected", !detected.includes("MOUNTAIN_VIEW"));
  check("low-confidence still visible in detail", detail.some((d) => d.key === "MOUNTAIN_VIEW"));
  check("drops keys not in the catalog", !detected.includes("NOT_A_REAL_KEY") && !detail.some((d) => d.key === "NOT_A_REAL_KEY"));
}
{
  // Dedupe: keep the highest confidence for a repeated key.
  const { detected, detail } = parseAmenityDetectionJson(
    { present: [
      { key: "POOL", confidence: "medium", evidence: "a" },
      { key: "POOL", confidence: "high", evidence: "b" },
    ] },
    VALID,
  );
  check("dedupes a repeated key", detected.filter((k) => k === "POOL").length === 1);
  check("keeps the highest confidence on dedupe", detail.find((d) => d.key === "POOL")?.confidence === "high");
}
{
  // Bare array + string rows + unknown confidence default to medium.
  const { detected } = parseAmenityDetectionJson(["OCEAN_VIEW", { key: "BBQ_GRILL" }], VALID);
  check("accepts a bare array and string rows", detected.includes("OCEAN_VIEW") && detected.includes("BBQ_GRILL"));
}
{
  const { detected, detail } = parseAmenityDetectionJson(null, VALID);
  check("null parses to empty", detected.length === 0 && detail.length === 0);
  const empty = parseAmenityDetectionJson({}, VALID);
  check("object without present[] parses to empty", empty.detected.length === 0);
}

// ── mergeDetectedAmenities (ADD-ONLY) ────────────────────────────────────────
{
  // Fresh listing (no prior selection) → baseline + detected.
  const r = mergeDetectedAmenities({
    current: null,
    baseline: HAWAII_BASE_AMENITY_KEYS,
    detected: ["POOL", "HOT_TUB", "WIFI" /* already in baseline */],
    validKeys: VALID,
  });
  check("fresh: fills from baseline", r.filledFromBaseline === true && r.base.includes("WIFI"));
  check("fresh: adds detected extras", r.next.includes("POOL") && r.next.includes("HOT_TUB"));
  check("fresh: baseline WiFi kept once (not double-added)", r.next.filter((k) => k === "WIFI").length === 1);
  check("fresh: added excludes baseline dupes", r.added.includes("POOL") && !r.added.includes("WIFI"));
  check("fresh: nothing from baseline is dropped", HAWAII_BASE_AMENITY_KEYS.every((k) => r.next.includes(k)));
}
{
  // Existing curated selection → keep it, only ADD detected. Never re-adds baseline.
  const current = ["WIFI", "KITCHEN"]; // operator trimmed to a minimal set
  const r = mergeDetectedAmenities({
    current,
    baseline: HAWAII_BASE_AMENITY_KEYS,
    detected: ["POOL", "KITCHEN" /* already present */],
    validKeys: VALID,
  });
  check("existing: keeps current base verbatim", r.base.join(",") === "WIFI,KITCHEN" && r.filledFromBaseline === false);
  check("existing: does NOT re-add trimmed baseline (e.g. AIR_CONDITIONING)", !r.next.includes("AIR_CONDITIONING"));
  check("existing: adds only new detected", r.added.join(",") === "POOL" && r.next.includes("POOL"));
  check("existing: never removes a current amenity", current.every((k) => r.next.includes(k)));
}
{
  // Invalid keys are filtered out of every output.
  const r = mergeDetectedAmenities({
    current: ["WIFI", "BOGUS_KEY"],
    baseline: HAWAII_BASE_AMENITY_KEYS,
    detected: ["POOL", "ALSO_BOGUS"],
    validKeys: VALID,
  });
  check("filters invalid keys from base + additions",
    !r.next.includes("BOGUS_KEY") && !r.next.includes("ALSO_BOGUS") && r.next.includes("WIFI") && r.next.includes("POOL"));
}
{
  // Empty current array is treated as "no prior selection".
  const r = mergeDetectedAmenities({ current: [], baseline: ["WIFI"], detected: ["POOL"], validKeys: VALID });
  check("empty current fills from baseline", r.filledFromBaseline === true && r.next.includes("WIFI") && r.next.includes("POOL"));
}

// ── AMENITY_LOCATION_TARGETS (surrounding-area research) ────────────────────
// The photo scan can never prove "Shopping Nearby" — these are researched by
// the Claude web-search leg. Keys must be real catalog keys and DISJOINT from
// the vision targets (views/beachfront stay vision-proven).
const LOCATION_KEYS = new Set(AMENITY_LOCATION_TARGETS.map((t) => t.key));
check("every location target key exists in the catalog",
  AMENITY_LOCATION_TARGETS.every((t) => VALID.has(t.key)));
check("location targets are unique",
  LOCATION_KEYS.size === AMENITY_LOCATION_TARGETS.length);
check("location targets are DISJOINT from vision targets",
  AMENITY_LOCATION_TARGETS.every((t) => !VISION_KEYS.has(t.key)));
check("location targets cover the operator's 'shopping nearby' class",
  ["SHOPPING", "NEAR_SHOPPING", "NEAR_RESTAURANTS", "GOLF", "NEAR_BEACH", "HIKING"].every((k) => LOCATION_KEYS.has(k)));
check("every location target has a distance-style hint",
  AMENITY_LOCATION_TARGETS.every((t) => t.hint.length > 10));

// ── buildAmenityLocationResearchPrompt ───────────────────────────────────────
{
  const prompt = buildAmenityLocationResearchPrompt(AMENITY_LOCATION_TARGETS, {
    communityName: "Poipu Kai Resort",
    city: "Koloa",
    state: "Hawaii",
    address: "1831 Poipu Rd",
    labelForKey: getAmenityLabel,
  });
  check("location prompt names the community + city + state",
    prompt.includes("Poipu Kai Resort") && prompt.includes("Koloa") && prompt.includes("Hawaii"));
  check("location prompt includes the street address when given", prompt.includes("1831 Poipu Rd"));
  check("location prompt lists a location target + hint",
    prompt.includes("SHOPPING") && prompt.includes("NEAR_RESTAURANTS"));
  check("location prompt demands a NAMED place as evidence", /specific named place/i.test(prompt));
  check("location prompt uses the same JSON contract as vision", prompt.includes('"present"') && prompt.includes('"confidence"'));
  check("location prompt is verify-only (no guessing)", /do not guess/i.test(prompt) && /omit/i.test(prompt));
  check("location prompt anchors distances on the community, not the town", /not from the town in general/i.test(prompt));
}
{
  const prompt = buildAmenityLocationResearchPrompt(AMENITY_LOCATION_TARGETS, { communityName: "Wavecrest", state: "Hawaii" });
  check("location prompt works without city/address", prompt.includes("Wavecrest") && !prompt.includes("Street address"));
}

// ── location-leg parsing (same parser, location key whitelist) ───────────────
{
  const { detected, detail } = parseAmenityDetectionJson(
    { present: [
      { key: "SHOPPING", confidence: "high", evidence: "Poipu Shopping Village ~0.5 mi" },
      { key: "GOLF", confidence: "medium", evidence: "Poipu Bay Golf Course ~1.5 mi" },
      { key: "POOL", confidence: "high", evidence: "vision key must NOT pass the location whitelist" },
      { key: "THEME_PARK", confidence: "low", evidence: "nothing within range" },
    ] },
    LOCATION_KEYS,
  );
  check("location parse keeps confirmed nearby keys", detected.includes("SHOPPING") && detected.includes("GOLF"));
  check("location parse rejects vision keys (whitelist is location-only)", !detected.includes("POOL"));
  check("location parse drops low confidence", !detected.includes("THEME_PARK"));
  check("location evidence carries the named place", detail.find((d) => d.key === "SHOPPING")?.evidence.includes("Poipu Shopping Village") === true);
}

// ── vision + location legs merge add-only ────────────────────────────────────
{
  const r = mergeDetectedAmenities({
    current: null,
    baseline: HAWAII_BASE_AMENITY_KEYS,
    detected: ["POOL", "OCEAN_VIEW", "SHOPPING", "NEAR_RESTAURANTS"], // vision ∪ location
    validKeys: VALID,
  });
  check("merged legs: photo + nearby amenities all land in the selection",
    ["POOL", "OCEAN_VIEW", "SHOPPING", "NEAR_RESTAURANTS"].every((k) => r.next.includes(k)));
  check("merged legs: nearby keys count as added (not baseline)",
    r.added.includes("SHOPPING") && r.added.includes("NEAR_RESTAURANTS"));
}

// ── source guards (wiring that must not silently regress) ────────────────────
// These lock the automation chain the operator asked for (2026-07-10):
// scan → save in-system → push to Guesty, fully automatic — including the
// deferred push when the Guesty listing is only created/connected later.
const read = (p: string) => fs.readFileSync(p, "utf8"); // repo-root cwd (matches pipeline-logic.test.ts)
{
  const scanSrc = read("server/amenity-scan.ts");
  check("amenity-scan runs the surrounding-area research leg",
    scanSrc.includes("researchLocationAmenitiesForProperty(propertyId"));
  check("amenity-scan result carries the location section", /location:\s*\{/.test(scanSrc));
  check("amenity-scan unions both legs before the add-only merge",
    scanSrc.includes("...visionDetected, ...location.detected"));
}
{
  const locSrc = read("server/amenity-location-research.ts");
  check("location research has a kill switch", locSrc.includes("AMENITY_LOCATION_RESEARCH_DISABLED"));
  check("location research fails soft without an API key",
    locSrc.includes("skipped the surrounding-area research"));
  check("location research parses via the shared whitelist parser",
    locSrc.includes("parseAmenityDetectionJson(res.data, locationKeys)"));
  check("location research researches ONLY the location targets",
    locSrc.includes("AMENITY_LOCATION_TARGETS"));
}
{
  const routesSrc = read("server/routes.ts");
  check("scan route pushes through the shared union helper",
    routesSrc.includes("pushAmenityKeysToGuestyListing(listingId, scan.next)"));
  check("union helper preserves the listing's current Guesty amenities (add-only)",
    routesSrc.includes("...existingGuestyAmenities,"));
  check("schedule-sync auto-pushes saved amenities on mapping",
    /upsertGuestyPropertyMap\(propertyId, guestyListingId\);[\s\S]{0,400}autoPushSavedAmenitiesForProperty\(propertyId, guestyListingId, "schedule-sync"\)/.test(routesSrc));
  check("dashboard Connect-to-Guesty auto-pushes saved amenities",
    routesSrc.includes('autoPushSavedAmenitiesForProperty(propertyId, guestyListingId.trim(), "guesty-property-map")'));
  check("Guesty import auto-pushes saved amenities (both branches)",
    routesSrc.includes('autoPushSavedAmenitiesForProperty(requestedPropertyId, guestyListingId, "guesty-import")')
    && routesSrc.includes('autoPushSavedAmenitiesForProperty(-draft.id, guestyListingId, "guesty-import-create")'));
  check("auto-push is a no-op when nothing is saved in-system",
    /keys\.length === 0\) return;/.test(routesSrc));
  check("auto-push cooldown absorbs the create flow's double-fire",
    routesSrc.includes("AMENITY_AUTO_PUSH_COOLDOWN_MS"));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
