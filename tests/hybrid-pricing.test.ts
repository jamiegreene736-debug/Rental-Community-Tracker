import assert from "node:assert/strict";
import {
  calculateBlendedRate,
  fetchAirbnbMedianNightly,
  hybridPricingWindowForMonth,
  isSearchApiAirbnbNoResultsError,
} from "../server/hybrid-pricing";

const july = calculateBlendedRate({
  airbnbMedianNightly: 500,
  checkIn: "2026-07-10",
  checkOut: "2026-07-17",
  bedrooms: 5,
  unitCount: 1,
  asOf: new Date("2026-05-27T00:00:00Z"),
});

assert.equal(july.demandClass, "high");
assert.equal(july.seasonTierId, "high_summer");
assert.equal(july.layers.length, 5);
assert.equal(july.finalRate, 759);

const december = calculateBlendedRate({
  airbnbMedianNightly: 500,
  checkIn: "2026-12-20",
  checkOut: "2026-12-27",
  bedrooms: 5,
  unitCount: 2,
  asOf: new Date("2026-05-27T00:00:00Z"),
});

assert.equal(december.demandClass, "ultra");
assert.equal(december.seasonTierId, "ultra_holiday");
assert.equal(december.layers.some((layer) => layer.ruleId === "multi_unit"), true);
assert.equal(december.finalRate, 939);

const mayWindow = hybridPricingWindowForMonth(new Date("2026-05-27T23:47:00Z"), 0);
assert.equal(mayWindow.checkIn, "2026-05-29");
assert.equal(mayWindow.checkOut, "2026-06-05");

const juneWindow = hybridPricingWindowForMonth(new Date("2026-05-27T23:47:00Z"), 1);
assert.equal(juneWindow.checkIn, "2026-06-01");
assert.equal(juneWindow.checkOut, "2026-06-08");

assert.equal(isSearchApiAirbnbNoResultsError("SearchAPI Airbnb: Airbnb didn't return any results."), true);

const originalFetch = globalThis.fetch;
const originalSearchApiKey = process.env.SEARCHAPI_API_KEY;
process.env.SEARCHAPI_API_KEY = "test-key";
globalThis.fetch = (async () => new Response(JSON.stringify({
  error: "Airbnb didn't return any results.",
}), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
try {
  const emptyAirbnb = await fetchAirbnbMedianNightly({
    community: "Kapaa Beachfront",
    bedrooms: 3,
    checkIn: "2026-05-29",
    checkOut: "2026-06-05",
  });
  assert.equal(emptyAirbnb.medianNightly, null);
  assert.equal(emptyAirbnb.sampleCount, 0);
} finally {
  globalThis.fetch = originalFetch;
  if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
  else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
}

console.log("hybrid pricing suite passed");
