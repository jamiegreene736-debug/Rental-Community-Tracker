import assert from "node:assert/strict";
import {
  MAX_EQUIVALENT_PORTAL_QUERIES,
  MAX_FULL_GALLERY_OPTIONS,
  buildEquivalentPortalQueries,
  canonicalListingUrlKey,
  detectRealEstateListingPortal,
  extractListingUnitIdentity,
  groupListingUrlsByIdentity,
  listingIdentityClusterKey,
  selectBestPhotoGalleryOption,
} from "../shared/real-estate-listing-discovery";
import { parseListingAddressFromUrl } from "../shared/listing-url-address";

const mirrors = [
  { url: "https://www.zillow.com/homedetails/220-Young-Ave-APT-27-Cocoa-Beach-FL/1_zpid/", unit: "27" },
  { url: "https://www.realtor.com/realestateandhomes-detail/220-Young-Ave-Apt-27_Cocoa-Beach_FL_32931_M1-2", unit: "027" },
  { url: "https://www.redfin.com/FL/Cocoa-Beach/220-Young-Ave-32931/unit-27/home/3", unit: "27" },
  { url: "https://www.homes.com/property/220-young-ave-unit-27-cocoa-beach-fl/4/", unit: "27" },
];
const mirrorGroups = groupListingUrlsByIdentity(mirrors, (row) => ({
  url: row.url,
  streetRoot: "220 young ave",
  unitClaim: row.unit,
}));
assert.equal(mirrorGroups.size, 1, "all four portals for one physical unit should share one cluster");
assert.equal([...mirrorGroups.values()][0].length, 4, "a cluster should preserve every portal mirror for richest-gallery scraping");

const neighboringUnits = groupListingUrlsByIdentity([
  ...mirrors,
  { url: "https://www.zillow.com/homedetails/220-Young-Ave-APT-28-Cocoa-Beach-FL/5_zpid/", unit: "28" },
], (row) => ({ url: row.url, streetRoot: "220 young ave", unitClaim: row.unit }));
assert.equal(neighboringUnits.size, 2, "neighboring units at one tower address must never share a cluster");
assert.notEqual(
  listingIdentityClusterKey({ url: mirrors[0].url, streetRoot: "220 young ave", unitClaim: "27" }),
  listingIdentityClusterKey({ url: mirrors[0].url, streetRoot: "220 young ave", unitClaim: "28" }),
);
assert.equal(
  listingIdentityClusterKey({ url: "https://example.com/a", streetRoot: "2695 s kihei rd", unitClaim: "08j" }),
  listingIdentityClusterKey({ url: "https://example.com/b", streetRoot: "2695 S Kihei Rd", unitClaim: "8J" }),
  "unit normalization should collapse leading-zero/case variants",
);
assert.equal(
  listingIdentityClusterKey({ url: "https://example.com/a", streetRoot: "2695 s kihei rd", unitClaim: "02-0301" }),
  listingIdentityClusterKey({ url: "https://example.com/b", streetRoot: "2695 S Kihei Rd", unitClaim: "2 301" }),
  "compound unit normalization should collapse separator and per-segment zero variants",
);
assert.notEqual(
  listingIdentityClusterKey({ url: "https://example.com/a", streetRoot: null, unitClaim: "27" }),
  listingIdentityClusterKey({ url: "https://example.com/b", streetRoot: null, unitClaim: "27" }),
  "unparseable addresses should remain URL-specific",
);
const ambiguousTowerRows = groupListingUrlsByIdentity([
  { url: "https://example.com/tower-listing-a" },
  { url: "https://example.com/tower-listing-b" },
], (row) => ({ url: row.url, streetRoot: "220 young ave", unitClaim: null }));
assert.equal(ambiguousTowerRows.size, 2, "root-equal rows without unit proof must remain URL-isolated");
assert.equal(
  listingIdentityClusterKey({
    url: "https://example.com/distinct-address-mirror",
    streetRoot: "69 555 waikoloa beach dr",
    unitClaim: null,
    allowRootOnly: true,
  }),
  "69 555 waikoloa beach dr",
  "legacy distinct-address callers may explicitly preserve root-only clustering",
);

assert.equal(extractListingUnitIdentity("Building 2 Unit 306"), "306", "an explicit unit outranks its building number");
assert.equal(extractListingUnitIdentity("2695 S Kihei Rd APT 2 301"), "2 301");
assert.equal(extractListingUnitIdentity("https://example.com/2695-S-Kihei-Rd-APT-2-301"), "2 301");
const compoundPortalUrl = "https://www.zillow.com/homedetails/2695-S-Kihei-Rd-APT-2-301-Kihei-HI/123_zpid/";
assert.equal(parseListingAddressFromUrl(compoundPortalUrl), "2695 S Kihei Rd APT 2");
assert.equal(
  extractListingUnitIdentity(parseListingAddressFromUrl(compoundPortalUrl), compoundPortalUrl),
  "2 301",
  "the full portal slug must outrank a compound unit truncated by address parsing",
);
assert.equal(
  listingIdentityClusterKey({
    url: "https://example.com/portal-a",
    streetRoot: "2695 s kihei rd",
    unitClaim: extractListingUnitIdentity("2695 S Kihei Rd APT-2-301"),
  }),
  listingIdentityClusterKey({
    url: "https://example.com/portal-b",
    streetRoot: "2695 S Kihei Rd",
    unitClaim: extractListingUnitIdentity("2695 S Kihei Rd Unit 2 301"),
  }),
  "compound unit separator variants should cluster across portals",
);
assert.notEqual(
  listingIdentityClusterKey({
    url: "https://example.com/a",
    streetRoot: "2695 s kihei rd",
    unitClaim: extractListingUnitIdentity("2695 S Kihei Rd APT 2 301"),
  }),
  listingIdentityClusterKey({
    url: "https://example.com/b",
    streetRoot: "2695 s kihei rd",
    unitClaim: extractListingUnitIdentity("2695 S Kihei Rd APT 2 306"),
  }),
  "compound unit claims in one building must remain separate",
);

assert.equal(canonicalListingUrlKey("https://www.Zillow.com/homedetails/ABC/?utm_source=x#photos"), "zillow.com/homedetails/abc");
assert.equal(detectRealEstateListingPortal(mirrors[0].url), "zillow");
assert.equal(detectRealEstateListingPortal(mirrors[1].url), "realtor");
assert.equal(detectRealEstateListingPortal(mirrors[2].url), "redfin");
assert.equal(detectRealEstateListingPortal(mirrors[3].url), "homes");
assert.equal(detectRealEstateListingPortal("https://www.vrbo.com/123"), null, "OTA pages are not photo discovery sources");
assert.equal(
  parseListingAddressFromUrl(mirrors[3].url),
  "220 Young Ave Unit 27",
  "Homes.com mirrors must expose the same address/unit identity as the other portals",
);

const equivalentQueries = buildEquivalentPortalQueries({
  address: "220 Young Ave Unit 27, Cocoa Beach, FL",
  communityAddress: "220 Young Ave, Cocoa Beach, FL",
  unit: "27",
});
assert.ok(equivalentQueries.some((query) => query.includes("site:zillow.com")));
assert.ok(equivalentQueries.some((query) => query.includes("site:realtor.com/realestateandhomes-detail")));
assert.ok(equivalentQueries.some((query) => query.includes("site:redfin.com")));
assert.ok(equivalentQueries.some((query) => query.includes("site:homes.com")));
assert.ok(equivalentQueries.length <= MAX_EQUIVALENT_PORTAL_QUERIES, "equivalent lookup must remain query-bounded");
assert.equal(buildEquivalentPortalQueries({ address: "220 Young Ave" }, 2).length, 2, "explicit query caps must be honored");

const options = [
  { id: "first-adequate", exactStreetMatch: true, bedroomEvidence: 2, photoCount: 8, discoveryScore: 100, discoveryIndex: 0 },
  { id: "richest", exactStreetMatch: true, bedroomEvidence: 2, photoCount: 31, discoveryScore: 80, discoveryIndex: 1 },
  { id: "off-street", exactStreetMatch: false, bedroomEvidence: 2, photoCount: 50, discoveryScore: 110, discoveryIndex: 2 },
];
assert.equal(selectBestPhotoGalleryOption(options)?.id, "richest", "selection must scan past the first adequate gallery but prefer exact-street evidence");
assert.equal(
  selectBestPhotoGalleryOption([
    { id: "stable-a", exactStreetMatch: true, bedroomEvidence: 2, photoCount: 20, discoveryScore: 90, discoveryIndex: 0 },
    { id: "stable-b", exactStreetMatch: true, bedroomEvidence: 2, photoCount: 20, discoveryScore: 90, discoveryIndex: 1 },
  ])?.id,
  "stable-a",
  "ties should preserve discovery order",
);
assert.equal(selectBestPhotoGalleryOption([]), null);
assert.equal(MAX_FULL_GALLERY_OPTIONS, 3, "Add Combo should inspect at most three viable galleries before choosing");

console.log("real-estate-listing-discovery tests passed");
