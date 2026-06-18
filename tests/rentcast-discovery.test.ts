import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  buildRentCastPortalLookupQueries,
  buildRentCastSaleListingsQuery,
  harvestRentCastSaleListings,
  isRentCastDiscoveryEnabled,
  passesRentCastBedroomFilter,
  rentCastDiscoveryTuning,
  shouldRejectRentCastListing,
  stateToAbbrevForRentCast,
  streetRootFromRentCastAddress,
} = await import("../server/rentcast-discovery");

console.log("rentcast-discovery suite");

assert.equal(stateToAbbrevForRentCast("Florida"), "FL");
assert.equal(stateToAbbrevForRentCast("HI"), "HI");
console.log("  ✓ state abbreviations");

const qs = buildRentCastSaleListingsQuery({
  city: "Fort Myers Beach",
  state: "Florida",
  limit: 80,
  minBedrooms: 2,
  maxBedrooms: 2,
});
assert.equal(qs.get("city"), "Fort Myers Beach");
assert.equal(qs.get("state"), "FL");
assert.equal(qs.get("status"), "Active");
const inactiveQs = buildRentCastSaleListingsQuery({
  city: "Koloa",
  state: "HI",
  limit: 40,
  listingStatus: "Inactive",
});
assert.equal(inactiveQs.get("status"), "Inactive");
assert.equal(qs.get("bedrooms"), "2");
assert.equal(qs.get("propertyType"), "Condo,Townhouse");
assert.equal(qs.get("limit"), "80");
console.log("  ✓ sale listings query builder");

const lookupQueries = buildRentCastPortalLookupQueries({
  id: "x",
  formattedAddress: "123 Main St, Fort Myers Beach, FL 33931",
  addressLine1: "123 Main St",
  city: "Fort Myers Beach",
  state: "FL",
  zipCode: "33931",
  bedrooms: 2,
  bathrooms: 2,
  status: "Active",
  price: 1,
  latitude: null,
  longitude: null,
  propertyType: "Condo",
  lastSeenDate: null,
  streetRoot: "123 main st",
});
assert.match(lookupQueries.zillow, /site:zillow\.com\/homedetails/);
assert.match(lookupQueries.realtor, /site:realtor\.com\/realestateandhomes-detail/);
console.log("  ✓ portal lookup query builder");

assert.equal(
  streetRootFromRentCastAddress("78-6833 Alii Dr, Kapaa, HI 96746"),
  "78 6833 alii dr",
);
assert.equal(
  streetRootFromRentCastAddress("4460 Nehe Rd, Lihue, HI 96766"),
  "4460 nehe rd",
);
console.log("  ✓ street roots from formatted addresses");

const activeListing = {
  id: "test-1",
  formattedAddress: "123 Main St, Fort Myers Beach, FL 33931",
  addressLine1: "123 Main St",
  city: "Fort Myers Beach",
  state: "FL",
  zipCode: "33931",
  bedrooms: 2,
  bathrooms: 2,
  status: "Active",
  price: 450000,
  propertyType: "Condo",
  streetRoot: streetRootFromRentCastAddress("123 Main St, Fort Myers Beach, FL 33931"),
} as const;

assert.equal(shouldRejectRentCastListing(activeListing), null);
assert.equal(shouldRejectRentCastListing({ ...activeListing, status: "Sold" }), null);
assert.equal(shouldRejectRentCastListing({ ...activeListing, status: "Pending" }), "status:Pending");
assert.equal(passesRentCastBedroomFilter(activeListing, 2, 2), true);
assert.equal(passesRentCastBedroomFilter(activeListing, 3, null), false);
console.log("  ✓ listing filters");

const prevKey = process.env.RENTCAST_API_KEY;
const prevEnabled = process.env.RENTCAST_DISCOVERY_ENABLED;
delete process.env.RENTCAST_API_KEY;
assert.equal(isRentCastDiscoveryEnabled(), false);
process.env.RENTCAST_API_KEY = "test-key";
process.env.RENTCAST_DISCOVERY_ENABLED = "1";
assert.equal(isRentCastDiscoveryEnabled(), true);
delete process.env.RENTCAST_DISCOVERY_ENABLED;
assert.equal(isRentCastDiscoveryEnabled(), false);
process.env.RENTCAST_DISCOVERY_ENABLED = "1";
assert.equal(isRentCastDiscoveryEnabled(), true);
process.env.RENTCAST_DISCOVERY_ENABLED = "0";
assert.equal(isRentCastDiscoveryEnabled(), false);
if (prevKey !== undefined) process.env.RENTCAST_API_KEY = prevKey;
else delete process.env.RENTCAST_API_KEY;
if (prevEnabled !== undefined) process.env.RENTCAST_DISCOVERY_ENABLED = prevEnabled;
else delete process.env.RENTCAST_DISCOVERY_ENABLED;
console.log("  ✓ enablement flag");

const bounded = rentCastDiscoveryTuning("bounded");
assert.equal(bounded.maxResolverLookups, 25);
process.env.RENTCAST_RESOLVER_MAX_LOOKUPS = "12";
assert.equal(rentCastDiscoveryTuning("bounded").maxResolverLookups, 12);
delete process.env.RENTCAST_RESOLVER_MAX_LOOKUPS;
console.log("  ✓ tuning env overrides");

const empty = await harvestRentCastSaleListings({
  cities: ["Lihue"],
  state: "Hawaii",
});
assert.deepEqual(empty.candidates, []);
assert.equal(empty.rawCount, 0);
console.log("  ✓ harvest returns empty without API key");

console.log("rentcast-discovery suite passed");
