import assert from "node:assert";
import {
  clusterBedroomPhotosByHash,
  computeListingBedroomCoverage,
  computeUnitBedroomCoverage,
  isBedroomPhotoCaption,
  parseExpectedBedroomsFromLabel,
  summarizeBedroomCluster,
} from "../shared/photo-bedroom-coverage-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("photo-bedroom-coverage logic");

check("isBedroomPhotoCaption accepts King Bedroom",
  isBedroomPhotoCaption("King Bedroom") && isBedroomPhotoCaption("Bedroom 2 — Alt View"));

check("isBedroomPhotoCaption rejects kitchen",
  !isBedroomPhotoCaption("Updated Kitchen"));

check("parseExpectedBedroomsFromLabel parses Unit A (3BR)",
  parseExpectedBedroomsFromLabel("Unit A (3BR)") === 3);

const sameHash = "a".repeat(16);
const nearHash = "a".repeat(15) + "b";
const farHash = "f".repeat(16);
const clustered = clusterBedroomPhotosByHash([
  { id: "1", caption: "King Bedroom", hash: sameHash },
  { id: "2", caption: "King Bedroom — Alt View", hash: nearHash },
  { id: "3", caption: "Queen Bedroom", hash: farHash },
]);
check("clusterBedroomPhotosByHash merges same-room angles",
  clustered.length === 2 && clustered[0].length === 2 && clustered[1].length === 1);

const room = summarizeBedroomCluster(
  [{ id: "1", caption: "Twin Bedroom" }, { id: "2", caption: "Twin Bedroom — Alt View" }],
  0,
);
check("summarizeBedroomCluster names Bedroom 1 with bed type",
  room.name === "Bedroom 1" && room.description === "Twin Bed" && room.photoCount === 2);

const unitOk = computeUnitBedroomCoverage("Unit A (3BR)", "unit-a", [
  { name: "Bedroom 1", description: "King Bed", photoCount: 2, photoIds: ["1", "2"], altViewCount: 1 },
  { name: "Bedroom 2", description: "Two Twin Beds", photoCount: 1, photoIds: ["3"], altViewCount: 0 },
  { name: "Bedroom 3", description: "Queen Bed", photoCount: 3, photoIds: ["4", "5", "6"], altViewCount: 2 },
], 3);
check("computeUnitBedroomCoverage passes 3/3",
  unitOk.matchesListing === "yes" && unitOk.bedroomsFound === 3);

const unitShort = computeUnitBedroomCoverage("Unit B (3BR)", "unit-b", [
  { name: "Bedroom 1", description: "King Bed", photoCount: 1, photoIds: ["1"], altViewCount: 0 },
], 3);
check("computeUnitBedroomCoverage fails 1/3",
  unitShort.matchesListing === "no" && unitShort.bedroomsFound === 1);

const listing = computeListingBedroomCoverage([unitOk, unitShort], 6);
check("computeListingBedroomCoverage sums units and fails 4/6",
  listing.bedroomsFoundCombined === 4 && listing.matchesListing === "no");

const listingPass = computeListingBedroomCoverage([
  computeUnitBedroomCoverage("Unit A (3BR)", "a", [
    { name: "Bedroom 1", description: "King", photoCount: 1, photoIds: ["1"], altViewCount: 0 },
    { name: "Bedroom 2", description: "Queen", photoCount: 1, photoIds: ["2"], altViewCount: 0 },
    { name: "Bedroom 3", description: "Twin", photoCount: 1, photoIds: ["3"], altViewCount: 0 },
  ], 3),
  computeUnitBedroomCoverage("Unit B (3BR)", "b", [
    { name: "Bedroom 1", description: "King", photoCount: 1, photoIds: ["4"], altViewCount: 0 },
    { name: "Bedroom 2", description: "Queen", photoCount: 1, photoIds: ["5"], altViewCount: 0 },
    { name: "Bedroom 3", description: "Twin", photoCount: 1, photoIds: ["6"], altViewCount: 0 },
  ], 3),
], 6);
check("computeListingBedroomCoverage passes 6/6",
  listingPass.matchesListing === "yes" && listingPass.bedroomsFoundCombined === 6);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
