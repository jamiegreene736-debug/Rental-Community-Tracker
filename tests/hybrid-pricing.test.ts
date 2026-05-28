import assert from "node:assert/strict";
import {
  calculateBlendedRate,
  fetchAirbnbMedianNightly,
  curatedAirbnbSearchQueries,
  hybridPricingWindowForMonth,
  hybridPricingWindowForSeason,
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

const rawAirbnbMedian = 450;
const layeredPeakRate = calculateBlendedRate({
  airbnbMedianNightly: rawAirbnbMedian,
  checkIn: "2026-07-01",
  checkOut: "2026-07-08",
  bedrooms: 3,
  unitCount: 2,
  asOf: new Date("2026-05-27T00:00:00Z"),
});
assert.ok(layeredPeakRate.finalRate > rawAirbnbMedian);
assert.equal(layeredPeakRate.layers.some((layer) => layer.ruleId === "platform_peak"), true);
assert.equal(layeredPeakRate.layers.some((layer) => layer.ruleId === "peak_july_fourth"), true);
assert.equal(layeredPeakRate.layers.some((layer) => layer.ruleId === "multi_unit"), true);

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

const julyPeakWindow = hybridPricingWindowForMonth(new Date("2026-05-27T23:47:00Z"), 2, 7, () => 0);
assert.equal(julyPeakWindow.yearMonth, "2026-07");
assert.equal(julyPeakWindow.checkIn, "2026-07-01");
assert.equal(julyPeakWindow.checkOut, "2026-07-08");

const decemberHolidayWindow = hybridPricingWindowForMonth(new Date("2026-05-27T23:47:00Z"), 7, 7, () => 0);
assert.equal(decemberHolidayWindow.yearMonth, "2026-12");
assert.equal(decemberHolidayWindow.checkIn, "2026-12-15");
assert.equal(decemberHolidayWindow.checkOut, "2026-12-22");

const lowSeasonWindow = hybridPricingWindowForSeason(new Date("2026-05-27T23:47:00Z"), "LOW", 7, () => 0);
assert.equal(lowSeasonWindow.season, "LOW");
assert.equal(lowSeasonWindow.checkIn, "2026-05-29");
assert.equal(lowSeasonWindow.checkOut, "2026-06-05");

const highSeasonWindow = hybridPricingWindowForSeason(new Date("2026-05-27T23:47:00Z"), "HIGH", 7, () => 0);
assert.equal(highSeasonWindow.season, "HIGH");
assert.equal(highSeasonWindow.checkIn, "2026-06-01");
assert.equal(highSeasonWindow.checkOut, "2026-06-08");

const holidaySeasonWindow = hybridPricingWindowForSeason(new Date("2026-05-27T23:47:00Z"), "HOLIDAY", 7, () => 0);
assert.equal(holidaySeasonWindow.season, "HOLIDAY");
assert.equal(holidaySeasonWindow.checkIn, "2026-06-28");
assert.equal(holidaySeasonWindow.checkOut, "2026-07-05");

assert.equal(isSearchApiAirbnbNoResultsError("SearchAPI Airbnb: Airbnb didn't return any results."), true);

const bonitaQueries = curatedAirbnbSearchQueries(
  "Bonita National",
  "Sunny 2BR Condo at Bonita National Golf & Country Club Condominiums",
);
assert.equal(
  bonitaQueries[0],
  "Bonita National Golf and Country Club, Bonita Springs, FL",
  "market Airbnb query must beat draft marketing title",
);
assert.equal(
  bonitaQueries.at(-1),
  "Sunny 2BR Condo at Bonita National Golf & Country Club Condominiums",
  "draft marketing title may only be used as a last-resort Airbnb query",
);

const routesSource = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
assert.equal(
  routesSource.includes("searchName: String(draft.name || draft.listingTitle || community)"),
  false,
  "draft market pricing refresh must not pass listing marketing title as Airbnb q=",
);

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
  assert.equal(poipuMedian.medianNightly, 250);
  assert.equal(poipuMedian.sampleCount, 3);
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
  hybridPricingSource.includes('source: "airbnb"'),
  "pricing refresh should persist raw SearchAPI medians without hybrid markup layers",
);
assert.equal(
  hybridPricingSource.includes("calculateBlendedRate({"),
  false,
  "market-rate refresh must not run hybrid layered markup on sampled medians",
);
assert.ok(
  hybridPricingSource.includes("hybridPricingWindowForMonth(asOf, monthOffset, stayNights)"),
  "market-rate refresh should run one SearchAPI Airbnb scan per calendar month",
);
assert.ok(
  hybridPricingSource.includes("for (let monthOffset = 0; monthOffset < horizonMonths; monthOffset += 1)"),
  "market-rate refresh should scan the configured pricing horizon month-by-month",
);
assert.ok(
  hybridPricingSource.includes("fetchAmortizedNightlyByBR("),
  "market-rate refresh should fall back to the amortized geo Airbnb path when direct queries are empty",
);
assert.equal(
  hybridPricingSource.includes("staticFallbackMonthlyRates"),
  false,
  "market-rate refresh must not fall back to static buy-in rates",
);
assert.ok(
  hybridPricingSource.includes("deletePropertyMarketRate(args.propertyId, bedrooms)"),
  "empty Airbnb SearchAPI samples should clear stale market-rate rows instead of retaining static or old data",
);
assert.ok(
  !hybridPricingSource.includes("sampled once"),
  "hybrid pricing logs should not claim month rows were extrapolated from one Airbnb sample",
);

console.log("hybrid pricing suite passed");
