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
  bedroomCoverage: {
    matchesListing: "yes",
    tier: "pass",
    bedroomsFoundCombined: 6,
    expectedListingBedrooms: 6,
  },
}, "2026-06-18T00:00:00.000Z");
check("pass when bedrooms, folder, and same-community all ok",
  passAll.bedroomsTier === "pass"
  && passAll.communityFolderOk === true
  && passAll.sameCommunityOk === true
  && passAll.overall === "pass");

const badBedrooms = derivePhotoCommunityRowStatus(2, {
  verdict: "fail",
  allSameCommunity: "yes",
  community: { matchesExpected: "yes", allSameCommunity: true },
  units: [{ sameAsCommunity: "yes" }],
  bedroomCoverage: { matchesListing: "no", tier: "fail", bedroomsFoundCombined: 4, expectedListingBedrooms: 6 },
}, "2026-06-18T00:00:00.000Z");
check("fail bedrooms when coverage short",
  badBedrooms.bedroomsTier === "fail" && badBedrooms.overall === "fail");

const warnBedrooms = derivePhotoCommunityRowStatus(5, {
  verdict: "warn",
  allSameCommunity: "yes",
  community: { matchesExpected: "yes", allSameCommunity: true },
  units: [{ sameAsCommunity: "yes" }, { sameAsCommunity: "yes" }],
  bedroomCoverage: {
    matchesListing: "yes",
    tier: "warn",
    bedroomsFoundCombined: 6,
    expectedListingBedrooms: 6,
    units: [{ tier: "warn" }, { tier: "pass" }],
  },
}, "2026-06-18T00:00:00.000Z");
check("warn tier when listing ok but unit issues",
  warnBedrooms.bedroomsTier === "warn" && warnBedrooms.overall === "warn");

check("status label shows warn for bedroom tier",
  photoCommunityStatusLabel(warnBedrooms).includes("⚠"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
