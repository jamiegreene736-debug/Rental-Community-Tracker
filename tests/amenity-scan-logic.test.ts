import assert from "node:assert";
import {
  buildAmenityDetectionInstruction,
  parseAmenityDetectionJson,
  mergeDetectedAmenities,
} from "../shared/amenity-scan-logic";
import {
  AMENITY_VISION_TARGETS,
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

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
