import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  buildRealtyApiCommunitySearchLocations,
  buildRealtyApiSearchParams,
  harvestRealtyApiCommunityListings,
  isRealtyApiDiscoveryEnabled,
  normalizeRealtyApiListing,
  passesRealtyApiBedroomFilter,
  realtyApiDiscoveryTuning,
  realtyApiPhotoDiscoverySearchType,
  shouldRejectRealtyApiListing,
  zipFromAddressHint,
} = await import("../server/realtyapi-discovery");

console.log("realtyapi-discovery suite");

const piliLocations = buildRealtyApiCommunitySearchLocations({
  communityName: "Pili Mai at Poipu",
  streetAddress: "2611 Kiahuna Plantation Dr, Koloa, HI 96756",
  city: "Koloa",
  state: "HI",
});
assert.ok(piliLocations.some((l) => /pili mai/i.test(l)), "community name search location");
assert.ok(
  piliLocations.some((l) => l.includes("2611") || l.includes("96756")),
  "street or ZIP fallback location",
);
console.log("  ✓ Pili Mai search location plan");

const qs = buildRealtyApiSearchParams({
  location: "Pili Mai at Poipu",
  page: 1,
  resultCount: 50,
  minBedrooms: 2,
  maxBedrooms: 2,
  keywords: "Pili Mai",
});
assert.equal(qs.get("location"), "Pili Mai at Poipu");
assert.equal(qs.get("propertyType"), "Condo,Townhome");
assert.equal(qs.get("searchType"), realtyApiPhotoDiscoverySearchType());
assert.equal(realtyApiPhotoDiscoverySearchType(), "For_Sale,Sold");
assert.equal(qs.get("pending"), "false");
assert.equal(qs.get("hasPhotos"), "true");
assert.equal(qs.get("bedsRange"), "min:2,max:2");
assert.equal(qs.get("keywords"), "Pili Mai");
console.log("  ✓ search params builder");

assert.equal(zipFromAddressHint("2611 Kiahuna Plantation Dr, Koloa, HI 96756"), "96756");

const row = normalizeRealtyApiListing({
  permalink: "https://www.realtor.com/realestateandhomes-detail/2611-Kiahuna-Plantation-Dr-Koloa_HI_96756_M123-45678",
  address: {
    line: "2611 Kiahuna Plantation Dr Unit 12B",
    city: "Koloa",
    state_code: "HI",
    postal_code: "96756",
  },
  beds: 2,
  baths: 2,
  sqft: 1100,
  status: "sold",
  list_price: 850000,
  property_id: "12345",
}, "Pili Mai at Poipu");
assert.ok(row);
assert.ok(row!.listingUrl.includes("realtor.com/realestateandhomes-detail"));
assert.equal(row!.bedrooms, 2);
assert.equal(shouldRejectRealtyApiListing(row!), null);
assert.equal(passesRealtyApiBedroomFilter(row!, 2, 2), true);
assert.equal(passesRealtyApiBedroomFilter(row!, 3, 3), false);
console.log("  ✓ listing normalization");

const prevKey = process.env.REALTYAPI_API_KEY;
const prevEnabled = process.env.REALTYAPI_DISCOVERY_ENABLED;
delete process.env.REALTYAPI_API_KEY;
assert.equal(isRealtyApiDiscoveryEnabled(), false);
process.env.REALTYAPI_API_KEY = "test-key";
process.env.REALTYAPI_DISCOVERY_ENABLED = "1";
assert.equal(isRealtyApiDiscoveryEnabled(), true);
process.env.REALTYAPI_DISCOVERY_ENABLED = "0";
assert.equal(isRealtyApiDiscoveryEnabled(), false);
if (prevKey !== undefined) process.env.REALTYAPI_API_KEY = prevKey;
else delete process.env.REALTYAPI_API_KEY;
if (prevEnabled !== undefined) process.env.REALTYAPI_DISCOVERY_ENABLED = prevEnabled;
else delete process.env.REALTYAPI_DISCOVERY_ENABLED;
console.log("  ✓ enablement flag");

assert.equal(realtyApiDiscoveryTuning("bounded").maxPagesPerLocation, 2);
process.env.REALTYAPI_MAX_PAGES_PER_LOCATION = "3";
assert.equal(realtyApiDiscoveryTuning("bounded").maxPagesPerLocation, 3);
delete process.env.REALTYAPI_MAX_PAGES_PER_LOCATION;
console.log("  ✓ tuning env overrides");

const empty = await harvestRealtyApiCommunityListings({
  communityName: "Pili Mai",
  city: "Koloa",
  state: "HI",
});
assert.deepEqual(empty.candidates, []);
assert.equal(empty.rawCount, 0);
console.log("  ✓ harvest returns empty without API key");

console.log("realtyapi-discovery suite passed");
