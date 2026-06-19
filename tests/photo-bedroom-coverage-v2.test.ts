import {
  capBedroomClustersToExpected,
  classifyBedroomPhotoCandidate,
  compareBedInventory,
  computeListingBedroomCoverage,
  computeUnitBedroomCoverage,
  dedupeCrossUnitBedroomClusters,
  deriveBedroomListingTier,
  isBedroomCategory,
  parseExpectedBedInventory,
  batchBedroomVisionRepresentatives,
} from "../shared/photo-bedroom-coverage-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("photo-bedroom-coverage v2 logic");

check("isBedroomCategory accepts Bedrooms", isBedroomCategory("Bedrooms"));
check("classifyBedroomPhotoCandidate category-first",
  classifyBedroomPhotoCandidate("Living Room", "Bedrooms") === "category");
check("classifyBedroomPhotoCandidate precomputed wins",
  classifyBedroomPhotoCandidate("Anything", "Living Areas", "room-1") === "precomputed");

check("parseExpectedBedInventory from listing copy",
  parseExpectedBedInventory("King bed, Queen bed, and two twins in the loft").length >= 3);

const inv = compareBedInventory(
  ["King Bed", "Queen Bed", "Two Twin Beds"],
  ["King Bed", "Queen Bed", "Two Twin Beds"],
);
check("bed inventory exact match", inv.matches === "yes");

const invMiss = compareBedInventory(["King Bed", "Queen Bed"], ["King Bed"]);
check("bed inventory missing queen", invMiss.matches === "no" && invMiss.missing.includes("Queen Bed"));

const clusters = [
  [{ id: "1", caption: "Master Bedroom — King", hash: "a".repeat(16) }],
  [{ id: "2", caption: "Bedroom 2 — Queen", hash: "b".repeat(16) }],
  [{ id: "3", caption: "Bedroom 3 — Twin", hash: "c".repeat(16) }],
  [{ id: "4", caption: "Bedroom 4 — Bunk", hash: "d".repeat(16) }],
];
const capped = capBedroomClustersToExpected(clusters, 3);
check("hard cap trims to 3 clusters", capped.clusters.length === 3 && capped.trimmedCount === 1);

// Regression: a 2BR with two King clusters (split angles) + one Queen must keep
// the Queen, not drop it for a duplicate King (false "missing Queen Bed").
const kingKingQueen = [
  [{ id: "k1", caption: "King Bedroom With Ocean View", hash: "a".repeat(16) }],
  [{ id: "k2", caption: "King Bedroom With Ocean View", hash: "b".repeat(16) }],
  [{ id: "q1", caption: "Queen Bedroom", hash: "c".repeat(16) }],
];
const keptInv = capBedroomClustersToExpected(kingKingQueen, 2, {
  expectedBedInventory: ["King Bed", "Queen Bed"],
});
const keptHasQueen = keptInv.clusters.some((c) => /queen/i.test(c[0].caption ?? ""));
const keptHasKing = keptInv.clusters.some((c) => /king/i.test(c[0].caption ?? ""));
check("cap keeps the unique Queen over a duplicate King (inventory-aware)",
  keptInv.clusters.length === 2 && keptInv.trimmedCount === 1 && keptHasQueen && keptHasKing);

// Even with no expected inventory, diversity should keep distinct bed types.
const keptDiverse = capBedroomClustersToExpected(kingKingQueen, 2);
check("cap keeps the Queen via diversity when no inventory is supplied",
  keptDiverse.clusters.some((c) => /queen/i.test(c[0].caption ?? ""))
  && keptDiverse.clusters.some((c) => /king/i.test(c[0].caption ?? "")));

// A trim that still matches the bed inventory is a clean duplicate merge — pass, not warn.
const cleanTrim = computeUnitBedroomCoverage("Unit A (2BR)", "a", [
  { name: "Bedroom 1", description: "King Bed", bedType: "King Bed", photoCount: 1, photoIds: ["1"], altViewCount: 0 },
  { name: "Bedroom 2", description: "Queen Bed", bedType: "Queen Bed", photoCount: 1, photoIds: ["2"], altViewCount: 0 },
], 2, { trimmedClusterCount: 1, bedInventoryMatch: "yes" });
check("clean trim with matching inventory → pass (no warn)",
  cleanTrim.tier === "pass" && cleanTrim.matchesListing === "yes" && /merged/.test(cleanTrim.reason));
check("clean trim does not raise a listing warn",
  deriveBedroomListingTier(cleanTrim.matchesListing, [cleanTrim]) === "pass");

const dedupe = dedupeCrossUnitBedroomClusters([
  {
    label: "Unit A",
    rooms: [
      { name: "Bedroom 1", description: "King", photoCount: 1, photoIds: ["1"], altViewCount: 0 },
      { name: "Bedroom 2", description: "Queen", photoCount: 1, photoIds: ["2"], altViewCount: 0 },
    ],
    repHashes: ["a".repeat(16), "b".repeat(16)],
  },
  {
    label: "Unit B",
    rooms: [
      { name: "Bedroom 1", description: "King duplicate", photoCount: 1, photoIds: ["3"], altViewCount: 0 },
      { name: "Bedroom 2", description: "Twin", photoCount: 1, photoIds: ["4"], altViewCount: 0 },
    ],
    repHashes: ["a".repeat(16), "c".repeat(16)],
  },
]);
check("cross-unit dedupe removes duplicate hash",
  dedupe.dedupedCount === 1 && dedupe.units[0].rooms.length === 2 && dedupe.units[1].rooms.length === 1);

const unitWarn = computeUnitBedroomCoverage("Unit A (3BR)", "a", [
  { name: "Bedroom 1", description: "King", photoCount: 1, photoIds: ["1"], altViewCount: 0 },
  { name: "Bedroom 2", description: "Queen", photoCount: 1, photoIds: ["2"], altViewCount: 0 },
  { name: "Bedroom 3", description: "Twin", photoCount: 1, photoIds: ["3"], altViewCount: 0 },
  { name: "Bedroom 4", description: "Extra", photoCount: 1, photoIds: ["4"], altViewCount: 0 },
], 3, { trimmedClusterCount: 1 });
check("unit over-count with trim → warn tier",
  unitWarn.tier === "warn" && unitWarn.matchesListing === "yes");

const listingWarn = computeListingBedroomCoverage([
  computeUnitBedroomCoverage("Unit A (3BR)", "a", [
    { name: "B1", description: "King", photoCount: 1, photoIds: ["1"], altViewCount: 0 },
    { name: "B2", description: "Queen", photoCount: 1, photoIds: ["2"], altViewCount: 0 },
    { name: "B3", description: "Twin", photoCount: 1, photoIds: ["3"], altViewCount: 0 },
  ], 3, { trimmedClusterCount: 1 }),
  computeUnitBedroomCoverage("Unit B (3BR)", "b", [
    { name: "B1", description: "King", photoCount: 1, photoIds: ["4"], altViewCount: 0 },
    { name: "B2", description: "Queen", photoCount: 1, photoIds: ["5"], altViewCount: 0 },
    { name: "B3", description: "Twin", photoCount: 1, photoIds: ["6"], altViewCount: 0 },
  ], 3),
], 6);
check("listing tier warn when trim on unit",
  deriveBedroomListingTier(listingWarn.matchesListing, listingWarn.units) === "warn");

check("vision batches split 14 into 3 batches of 6",
  batchBedroomVisionRepresentatives(Array.from({ length: 14 }, (_, i) => i)).length === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
