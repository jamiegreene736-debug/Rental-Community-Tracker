import {
  derivePhotoCommunityRowStatus,
  photoCommunityStatusLabel,
} from "../shared/photo-community-status-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("photo-community-status logic");

const passAll = derivePhotoCommunityRowStatus(1, {
  verdict: "pass",
  allSameCommunity: "yes",
  community: { matchesExpected: "yes", allSameCommunity: true, photosChecked: 28, photosTotal: 28 },
  units: [{ sameAsCommunity: "yes" }, { sameAsCommunity: "yes" }],
  bedroomCoverage: { matchesListing: "yes", bedroomsFoundCombined: 6, expectedListingBedrooms: 6 },
}, "2026-06-18T00:00:00.000Z");
check("pass when bedrooms, folder, and same-community all ok",
  passAll.bedroomsOk === true
  && passAll.communityFolderOk === true
  && passAll.sameCommunityOk === true
  && passAll.overall === "pass"
  && passAll.communityAuditComplete === true
  && passAll.communityPhotosChecked === 28);

const badBedrooms = derivePhotoCommunityRowStatus(2, {
  verdict: "fail",
  allSameCommunity: "yes",
  community: { matchesExpected: "yes", allSameCommunity: true },
  units: [{ sameAsCommunity: "yes" }],
  bedroomCoverage: { matchesListing: "no", bedroomsFoundCombined: 4, expectedListingBedrooms: 6 },
}, "2026-06-18T00:00:00.000Z");
check("fail bedrooms when coverage short",
  badBedrooms.bedroomsOk === false && badBedrooms.overall === "fail");

const badFolder = derivePhotoCommunityRowStatus(3, {
  verdict: "fail",
  allSameCommunity: "yes",
  community: { matchesExpected: "no", allSameCommunity: true },
  units: [{ sameAsCommunity: "yes" }],
  bedroomCoverage: { matchesListing: "yes", bedroomsFoundCombined: 3, expectedListingBedrooms: 3 },
}, "2026-06-18T00:00:00.000Z");
check("fail community folder when expected resort mismatch",
  badFolder.communityFolderOk === false && badFolder.overall === "fail");

const badMatch = derivePhotoCommunityRowStatus(4, {
  verdict: "fail",
  allSameCommunity: "no",
  community: { matchesExpected: "yes", allSameCommunity: true },
  units: [{ sameAsCommunity: "yes" }, { sameAsCommunity: "no" }],
  bedroomCoverage: { matchesListing: "yes", bedroomsFoundCombined: 6, expectedListingBedrooms: 6 },
}, "2026-06-18T00:00:00.000Z");
check("fail same-community when units disagree",
  badMatch.sameCommunityOk === false && badMatch.overall === "fail");

check("status label summarizes bedroom failure",
  photoCommunityStatusLabel(badBedrooms).includes("4/6"));

check("status label for all pass",
  photoCommunityStatusLabel(passAll).includes("passed"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
