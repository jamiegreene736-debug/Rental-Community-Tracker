import assert from "node:assert/strict";
import {
  calculateBlendedRate,
  fetchAirbnbMedianNightly,
  hybridPricingWindowForMonth,
  isSearchApiAirbnbNoResultsError,
} from "../server/hybrid-pricing";
import { readFileSync } from "node:fs";

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

const mayWindow = hybridPricingWindowForMonth(new Date("2026-05-27T23:47:00Z"), 0, 7, () => 0);
assert.equal(mayWindow.checkIn, "2026-05-29");
assert.equal(mayWindow.checkOut, "2026-06-05");

const juneWindow = hybridPricingWindowForMonth(new Date("2026-05-27T23:47:00Z"), 1, 7, () => 0);
assert.equal(juneWindow.checkIn, "2026-06-01");
assert.equal(juneWindow.checkOut, "2026-06-08");

const lateJuneWindow = hybridPricingWindowForMonth(new Date("2026-05-27T23:47:00Z"), 1, 7, () => 0.999);
assert.equal(lateJuneWindow.yearMonth, "2026-06");
assert.equal(lateJuneWindow.checkIn, "2026-06-24");
assert.equal(lateJuneWindow.checkOut, "2026-07-01");

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

process.env.SEARCHAPI_API_KEY = "test-key";
const requestedSearchApiUrls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  requestedSearchApiUrls.push(String(input));
  return new Response(JSON.stringify({
    properties: [
      {
        name: "Poipu Kai 3 bedroom condo",
        price: { extracted_total_price: 2800, extracted_price_per_qualifier: 250 },
      },
      {
        name: "Poipu Kai 3 bedroom condo with fees",
        price: { extracted_total_price: 3500, extracted_price_per_qualifier: 280 },
      },
      {
        name: "Poipu Kai 4 bedroom condo",
        price: { extracted_total_price: 7000, extracted_price_per_qualifier: 500 },
      },
      {
        name: "Poipu Kai 3 bedroom condo missing checkout total",
        price: { extracted_price_per_qualifier: 120 },
      },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
try {
  const poipuMedian = await fetchAirbnbMedianNightly({
    community: "Poipu Kai",
    bedrooms: 3,
    checkIn: "2026-06-01",
    checkOut: "2026-06-08",
  });
  assert.equal(poipuMedian.medianNightly, 450);
  assert.equal(poipuMedian.sampleCount, 2);
  assert.equal(requestedSearchApiUrls.length, 1);
  const params = new URL(requestedSearchApiUrls[0]).searchParams;
  assert.equal(params.get("engine"), "airbnb");
  assert.equal(params.get("bedrooms"), "3");
  assert.equal(params.get("type_of_place"), "entire_home");
} finally {
  globalThis.fetch = originalFetch;
  if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
  else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
}

const hybridPricingSource = readFileSync(new URL("../server/hybrid-pricing.ts", import.meta.url), "utf8");
assert.ok(
  hybridPricingSource.includes("for (let m = 0; m < HYBRID_PRICING_CONFIG.scanSettings.horizonMonths; m++)") &&
    hybridPricingSource.indexOf("for (let m = 0; m < HYBRID_PRICING_CONFIG.scanSettings.horizonMonths; m++)") <
      hybridPricingSource.indexOf("const airbnb = await fetchAirbnbMedianNightly({"),
  "hybrid pricing should make one Airbnb SearchAPI request per monthly pricing row",
);
assert.ok(
  !hybridPricingSource.includes("sampled once"),
  "hybrid pricing logs should not claim month rows were extrapolated from one Airbnb sample",
);

console.log("hybrid pricing suite passed");
