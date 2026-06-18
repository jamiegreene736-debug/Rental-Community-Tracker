import assert from "node:assert/strict";
import {
  calculateBlendedRate,
  extrapolateYearTwoMarketRate,
  fetchAirbnbMedianNightly,
  airbnbSearchGeoParamsForMarket,
  curatedAirbnbSearchQueries,
  hybridPricingWindowForMonth,
  hybridPricingWindowForSeason,
  isSearchApiAirbnbNoResultsError,
  AIRBNB_MARKET_RATE_SEARCH_MONTHS,
  YEAR_TWO_MARKET_RATE_GROWTH,
} from "../server/hybrid-pricing";
import { readFileSync } from "node:fs";
import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import { BUY_IN_MARKETS } from "@shared/buy-in-market";

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
assert.equal(decemberHolidayWindow.checkIn, "2026-12-01");
assert.equal(decemberHolidayWindow.checkOut, "2026-12-08");

const midJulyWindow = hybridPricingWindowForMonth(new Date("2026-05-27T23:47:00Z"), 2, 7, () => 0.5);
assert.equal(midJulyWindow.yearMonth, "2026-07");
assert.ok(midJulyWindow.checkIn >= "2026-07-01" && midJulyWindow.checkIn <= "2026-07-25");
assert.equal(midJulyWindow.checkOut.slice(0, 7), "2026-07");

assert.equal(extrapolateYearTwoMarketRate(200), 206);
assert.equal(extrapolateYearTwoMarketRate(0), 0);
assert.equal(AIRBNB_MARKET_RATE_SEARCH_MONTHS, 12);
assert.equal(YEAR_TWO_MARKET_RATE_GROWTH, 0.03);

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
assert.equal(
  curatedAirbnbSearchQueries("Ilikai", "Spacious 4BR for 8 at Ilikai!")[0],
  "Ilikai Hotel, Honolulu, HI",
  "Ilikai market pricing should use the curated address-backed query before the broad community name",
);
assert.deepEqual(
  airbnbSearchGeoParamsForMarket("Poipu Kai"),
  {
    sw_lat: "21.875",
    sw_lng: "-159.478",
    ne_lat: "21.895",
    ne_lng: "-159.458",
  },
  "Poipu Kai market pricing must use the curated resort bounds, not the broader center-radius fallback",
);
assert.deepEqual(
  airbnbSearchGeoParamsForMarket("Menehune Shores"),
  {
    sw_lat: "20.7615",
    sw_lng: "-156.4615",
    ne_lat: "20.7655",
    ne_lng: "-156.457",
  },
  "Menehune Shores market pricing must use resort-footprint bounds, not the broader center-radius fallback",
);
assert.deepEqual(
  airbnbSearchGeoParamsForMarket("Bonita National"),
  {
    sw_lat: "26.31",
    sw_lng: "-81.695",
    ne_lat: "26.342",
    ne_lng: "-81.648",
  },
  "Bonita National market pricing must keep using its curated club bounds",
);
assert.deepEqual(
  airbnbSearchGeoParamsForMarket("Santa Maria Resort"),
  {
    sw_lat: "26.408",
    sw_lng: "-81.903",
    ne_lat: "26.415",
    ne_lng: "-81.895",
  },
  "Santa Maria Resort market pricing must stay on the Estero Blvd resort footprint",
);

const routesSource = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
assert.equal(
  routesSource.includes("searchName: String(draft.name || draft.listingTitle || community)"),
  false,
  "draft market pricing refresh must not pass listing marketing title as Airbnb q=",
);
assert.equal(
  routesSource.includes("refusing LOW/HIGH/HOLIDAY fallback"),
  true,
  "bulk market pricing push must fail closed instead of applying broad seasonal fallback rates",
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
  const poipuBasis = await fetchAirbnbMedianNightly({
    community: "Poipu Kai",
    bedrooms: 3,
    checkIn: "2026-06-01",
    checkOut: "2026-06-08",
  });
  assert.equal(poipuBasis.medianNightly, 440);
  assert.equal(poipuBasis.sampleCount, 2);
  assert.equal(requestedSearchApiUrls.length, 1);
  const params = new URL(requestedSearchApiUrls[0]).searchParams;
  assert.equal(params.get("engine"), "airbnb");
  assert.equal(params.get("bedrooms"), "3");
  assert.equal(params.get("type_of_place"), "entire_home");
  assert.equal(params.get("sw_lat"), "21.875");
  assert.equal(params.get("sw_lng"), "-159.478");
  assert.equal(params.get("ne_lat"), "21.895");
  assert.equal(params.get("ne_lng"), "-159.458");
} finally {
  globalThis.fetch = originalFetch;
  if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
  else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
}

process.env.SEARCHAPI_API_KEY = "test-key";
globalThis.fetch = (async () => {
  return new Response(JSON.stringify({
    properties: [
      {
        name: "Poipu Kai 3 bedroom condo",
        price: { extracted_total_price: 700 },
      },
      {
        name: "Poipu Kai 3 bedroom condo repeated rate",
        price: { extracted_total_price: 700 },
      },
      {
        name: "Poipu Kai 3 bedroom condo higher rate",
        price: { extracted_total_price: 1400 },
      },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
try {
  const distinctPoipuBasis = await fetchAirbnbMedianNightly({
    community: "Poipu Kai",
    bedrooms: 3,
    checkIn: "2027-08-11",
    checkOut: "2027-08-18",
    avoidNightlyBasis: 100,
  });
  assert.equal(distinctPoipuBasis.medianNightly, 200);
  assert.match(
    distinctPoipuBasis.notes[0],
    /adjusted to nearest distinct monthly sample/,
    "duplicate monthly p40 basis should choose the nearest distinct sampled rate",
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
  else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
}

process.env.SEARCHAPI_API_KEY = "test-key";
globalThis.fetch = (async () => {
  return new Response(JSON.stringify({
    properties: [
      {
        name: "Poipu Kai 3 bedroom condo outside Koloa",
        gps_coordinates: { latitude: 21.955, longitude: -159.36 },
        price: { extracted_total_price: 2100 },
      },
      {
        name: "Poipu Kai 3 bedroom condo inside resort",
        gps_coordinates: { latitude: 21.883, longitude: -159.466 },
        price: { extracted_total_price: 2800 },
      },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
try {
  const fencedPoipuBasis = await fetchAirbnbMedianNightly({
    community: "Poipu Kai",
    bedrooms: 3,
    checkIn: "2027-09-01",
    checkOut: "2027-09-08",
  });
  assert.equal(fencedPoipuBasis.medianNightly, 400);
  assert.equal(fencedPoipuBasis.sampleCount, 1);
  assert.equal(fencedPoipuBasis.evidence?.rejectCounts.geography, 1);
  assert.equal(fencedPoipuBasis.evidence?.acceptedGeoVerifiedCandidates, 1);
} finally {
  globalThis.fetch = originalFetch;
  if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
  else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
}

process.env.SEARCHAPI_API_KEY = "test-key";
globalThis.fetch = (async () => {
  return new Response(JSON.stringify({
    properties: Array.from({ length: 10 }, (_, index) => ({
      name: `Koloa resort suite ${index + 1}`,
      gps_coordinates: { latitude: 21.883 + (index * 0.0001), longitude: -159.466 },
      price: { extracted_total_price: 2100 + (index * 70) },
    })),
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
try {
  const unparsedBedroomBasis = await fetchAirbnbMedianNightly({
    community: "Poipu Kai",
    bedrooms: 3,
    checkIn: "2027-10-01",
    checkOut: "2027-10-08",
  });
  assert.equal(unparsedBedroomBasis.sampleCount, 10);
  assert.equal(unparsedBedroomBasis.confidence?.exactBedroomCandidates, 0);
  assert.equal(unparsedBedroomBasis.confidence?.unknownBedroomCandidates, 10);
  assert.equal(unparsedBedroomBasis.confidence?.level, "red");
  assert.ok((unparsedBedroomBasis.confidence?.score ?? 100) <= 74);
} finally {
  globalThis.fetch = originalFetch;
  if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
  else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
}

process.env.SEARCHAPI_API_KEY = "test-key";
globalThis.fetch = (async () => {
  return new Response(JSON.stringify({
    properties: Array.from({ length: 8 }, (_, index) => ({
      name: `Unmapped Confidence Resort 3 bedroom condo ${index + 1}`,
      bedrooms: 3,
      price: { extracted_total_price: 2100 + (index * 70) },
    })),
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
try {
  const unfencedBasis = await fetchAirbnbMedianNightly({
    community: "Unmapped Confidence Resort",
    bedrooms: 3,
    checkIn: "2027-11-01",
    checkOut: "2027-11-08",
  });
  assert.equal(unfencedBasis.sampleCount, 8);
  assert.equal(unfencedBasis.evidence?.geoConstraint.kind, "none");
  assert.equal(unfencedBasis.confidence?.level, "red");
  assert.ok((unfencedBasis.confidence?.score ?? 100) <= 69);
} finally {
  globalThis.fetch = originalFetch;
  if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
  else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
}

// ── Geographic-widening fallback for thin in-footprint markets ──────────────
// Bonita National (a gated golf community) has near-zero exact-2BR entire-home
// Airbnb inventory inside its curated club box, which used to hard-fail the whole
// market-rate refresh with "no usable exact-2BR samples". The refresh now widens
// to a center-radius box (and city-level query anchor) when the resort footprint
// comes back empty — real Airbnb data only, no static fallback.
const BONITA_CURATED_SW_LAT = "26.31"; // String(BUY_IN_MARKET_BOUNDS["Bonita National"].sw_lat)
function bonitaWidenedListings(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `2 Bedroom condo near Bonita Springs #${index + 1}`,
    bedrooms: 2,
    gps_coordinates: { latitude: 26.32, longitude: -81.67 }, // inside the widened center-radius box
    price: { extracted_total_price: 2100 + index * 140 },
  }));
}

// (A) Widen succeeds AND clears the confidence gate: the curated club box returns
// nothing, then the wider center-radius box returns exact-2BR comps.
process.env.SEARCHAPI_API_KEY = "test-key";
{
  const seen: Array<{ swLat: string | null; q: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const swLat = url.searchParams.get("sw_lat");
    seen.push({ swLat, q: url.searchParams.get("q") });
    const properties = swLat === BONITA_CURATED_SW_LAT ? [] : bonitaWidenedListings(6);
    return new Response(JSON.stringify({ properties }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const widened = await fetchAirbnbMedianNightly({
      community: "Bonita National",
      bedrooms: 2,
      checkIn: "2026-06-08",
      checkOut: "2026-06-15",
    });
    assert.ok((widened.medianNightly ?? 0) > 0, "widening should produce a real nearby-comp basis when the footprint is empty");
    assert.equal(widened.sampleCount, 6);
    assert.equal(widened.evidence?.geoConstraint.kind, "center-radius", "a widened basis must report the center-radius tier it came from");
    assert.equal(widened.confidence?.level, "yellow", "a healthy widened month should clear the non-red save/push gate");
    assert.ok(
      (widened.confidence?.score ?? 0) >= 75 && (widened.confidence?.score ?? 0) <= 84,
      "center-radius widening must stay capped at the yellow tier, not be inflated to green",
    );
    assert.ok(/Geo-widened/.test(widened.notes[0] ?? ""), "the basis note must surface that widening was applied");
    assert.ok(seen.some((r) => r.swLat === BONITA_CURATED_SW_LAT), "the curated footprint must be tried first");
    assert.ok(seen.some((r) => r.swLat !== BONITA_CURATED_SW_LAT && r.swLat != null), "a wider center-radius box must be tried after the footprint is empty");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
    else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
  }
}

// (B) Primary-wins regression: when the curated footprint DOES yield samples, the
// refresh returns on the first request and never widens (one SearchAPI call, the
// curated-bounds tier) — the byte-identical guarantee for healthy markets.
process.env.SEARCHAPI_API_KEY = "test-key";
{
  const seen: Array<string | null> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(new URL(String(input)).searchParams.get("sw_lat"));
    return new Response(JSON.stringify({
      properties: Array.from({ length: 6 }, (_, index) => ({
        name: `Bonita National 2 bedroom condo #${index + 1}`,
        bedrooms: 2,
        gps_coordinates: { latitude: 26.325, longitude: -81.67 }, // inside the curated club box
        price: { extracted_total_price: 2100 + index * 140 },
      })),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const primary = await fetchAirbnbMedianNightly({
      community: "Bonita National",
      bedrooms: 2,
      checkIn: "2026-06-08",
      checkOut: "2026-06-15",
    });
    assert.equal(primary.sampleCount, 6);
    assert.equal(seen.length, 1, "a market whose footprint yields samples must make exactly one SearchAPI request");
    assert.equal(seen[0], BONITA_CURATED_SW_LAT, "the single request must use the curated club bounds, not a widened box");
    assert.equal(primary.evidence?.geoConstraint.kind, "curated-bounds");
    assert.ok(!/Geo-widened/.test(primary.notes[0] ?? ""), "a footprint hit must not be labeled as widened");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
    else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
  }
}

// (C) Widening still fails closed: if every tier (footprint + widened) comes back
// empty, the basis is null so the caller still throws — no fabricated rate.
process.env.SEARCHAPI_API_KEY = "test-key";
{
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: "Airbnb didn't return any results.",
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const failClosed = await fetchAirbnbMedianNightly({
      community: "Bonita National",
      bedrooms: 2,
      checkIn: "2026-06-08",
      checkOut: "2026-06-15",
    });
    assert.equal(failClosed.medianNightly, null, "an all-empty widened search must still fail closed, not fabricate a rate");
    assert.equal(failClosed.sampleCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
    else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
  }
}

// (D) Unmapped markets (no mapped center) never widen: only the bounds-less "none"
// requests fire — no center-radius box is ever issued.
process.env.SEARCHAPI_API_KEY = "test-key";
{
  const sawGeoBox: boolean[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sawGeoBox.push(new URL(String(input)).searchParams.get("sw_lat") != null);
    return new Response(JSON.stringify({ properties: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const unmapped = await fetchAirbnbMedianNightly({
      community: "Unmapped Confidence Resort",
      bedrooms: 3,
      checkIn: "2027-11-01",
      checkOut: "2027-11-08",
    });
    assert.equal(unmapped.medianNightly, null);
    assert.ok(!sawGeoBox.some(Boolean), "an unmapped market has no center to widen around, so no geo-boxed request must be issued");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
    else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
  }
}

// (E) Generality: the same widening unblocks the other tight Florida footprints
// (Santa Maria Resort), proving the fix is not a Bonita one-off.
const SANTA_MARIA_CURATED_SW_LAT = "26.408"; // String(BUY_IN_MARKET_BOUNDS["Santa Maria Resort"].sw_lat)
process.env.SEARCHAPI_API_KEY = "test-key";
{
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const swLat = new URL(String(input)).searchParams.get("sw_lat");
    const properties = swLat === SANTA_MARIA_CURATED_SW_LAT ? [] : Array.from({ length: 6 }, (_, index) => ({
      name: `2 Bedroom Fort Myers Beach condo #${index + 1}`,
      bedrooms: 2,
      gps_coordinates: { latitude: 26.411, longitude: -81.899 },
      price: { extracted_total_price: 2450 + index * 140 },
    }));
    return new Response(JSON.stringify({ properties }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const santaMaria = await fetchAirbnbMedianNightly({
      community: "Santa Maria Resort",
      bedrooms: 2,
      checkIn: "2026-06-08",
      checkOut: "2026-06-15",
    });
    assert.ok((santaMaria.medianNightly ?? 0) > 0, "Santa Maria's tight footprint should also widen to nearby comps");
    assert.equal(santaMaria.evidence?.geoConstraint.kind, "center-radius");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchApiKey == null) delete process.env.SEARCHAPI_API_KEY;
    else process.env.SEARCHAPI_API_KEY = originalSearchApiKey;
  }
}

const hybridPricingSource = readFileSync(new URL("../server/hybrid-pricing.ts", import.meta.url), "utf8");
assert.ok(
  hybridPricingSource.includes('source: "airbnb"'),
  "pricing refresh should persist raw SearchAPI 40th percentile bases without hybrid markup layers",
);
assert.equal(
  hybridPricingSource.includes("calculateBlendedRate({"),
  false,
  "market-rate refresh must not run hybrid layered markup on sampled medians",
);
assert.ok(
  hybridPricingSource.includes("hybridPricingWindowForMonth(") && hybridPricingSource.includes("monthScanRng"),
  "market-rate refresh should pick a random 7-night window per calendar month",
);
assert.ok(
  hybridPricingSource.includes("monthOffset >= AIRBNB_MARKET_RATE_SEARCH_MONTHS"),
  "months 13–24 extrapolate instead of calling SearchAPI",
);
assert.ok(
  hybridPricingSource.includes("for (let monthOffset = 0; monthOffset < horizonMonths; monthOffset += 1)"),
  "market-rate refresh should scan the configured pricing horizon month-by-month",
);
assert.ok(
  hybridPricingSource.includes("seasonalMedians[legacySeasonForDemandClass(tier.demandClass)].push(basis)"),
  "season summary medians must bucket by sampled stay demand tier, not calendar season map (Hawaii has no HOLIDAY months in HAWAII_SEASONS)",
);
assert.ok(
  hybridPricingSource.includes("monthly scan ok") && hybridPricingSource.includes("[hybrid-pricing]"),
  "each calendar month scan should log to Railway/server logs",
);
assert.ok(
  hybridPricingSource.includes("scannedMonths.length !== horizonMonths"),
  "market-rate refresh must fail when fewer than horizonMonths monthly bases were stored",
);
assert.equal(
  hybridPricingSource.includes("fetchAmortizedNightlyByBR("),
  false,
  "market-rate refresh must not fall back to amortized geo pricing when a monthly Airbnb SearchAPI query is empty",
);
assert.ok(
  hybridPricingSource.includes("MARKET_PRICING_PERCENTILE = 40"),
  "market pricing should use the 40th percentile basis",
);
assert.equal(
  hybridPricingSource.includes("MIN_PERCENTILE_TO_MEDIAN_RATIO"),
  false,
  "market pricing must use the raw P40 basis without a median-floor backup",
);
assert.equal(
  hybridPricingSource.includes("extracted_price_per_qualifier"),
  false,
  "market pricing must use all-inclusive checkout totals, not per-night display prices",
);
assert.ok(
  hybridPricingSource.includes("staticMarketRateBasis") && hybridPricingSource.includes("getBuyInRate("),
  "thin/no-comp months must fall back to static seasonal buy-in instead of blacking out the calendar",
);
assert.ok(
  hybridPricingSource.includes("deletePropertyMarketRate(args.propertyId, bedrooms)"),
  "a genuinely unworkable scan (no eligible window / month-count integrity failure) should still clear the stale market-rate row",
);
assert.ok(
  hybridPricingSource.includes('blackouts: []'),
  "market-rate refresh must not return blackout windows",
);
assert.ok(
  hybridPricingSource.includes('airbnb.confidence.level === "red"'),
  "red market-rate confidence must still be detected but the month is priced (not blacked out)",
);
assert.ok(
  routesSource.includes("reopenAllPricingBlackoutBlocks") && routesSource.includes("reconcilePricingBlackoutBlocks"),
  "the Guesty push must reopen legacy pricing-blackout blocks on re-run",
);
assert.ok(
  routesSource.includes("unitSlotsForCommunityDraft") && routesSource.includes("hasUnit2Config"),
  "single-unit drafts must use one unit slot so Guesty push does not double the rate",
);
assert.ok(
  routesSource.includes("entry?.blackout"),
  "the seasonal plan builder must still honor legacy blackout rows via static buy-in fallback",
);
assert.ok(
  hybridPricingSource.includes("monthOffset >= AIRBNB_MARKET_RATE_SEARCH_MONTHS"),
  "months beyond the Airbnb dated-search horizon must extrapolate from the same calendar month in year 1",
);
assert.ok(
  hybridPricingSource.includes("extrapolateYearTwoMarketRate"),
  "year-2 months must apply the configured growth rate to the prior-year SearchAPI basis",
);
assert.equal(
  hybridPricingSource.includes("avoidNightlyBasis: previousBasis"),
  false,
  "monthly scan must not nudge P40 to avoid matching the prior month",
);
assert.ok(
  !hybridPricingSource.includes("demandRank(resolveSeasonTier"),
  "monthly windows must be a random 7-night sample, not demand-biased peak days",
);

// ── End-to-end: every dashboard property's bulk-pricing scan must query Airbnb
// with the correct curated resort/community name ───────────────────────────────
// The bulk market-pricing queue runs one property at a time and, for each, scans
// SearchAPI Airbnb via curatedAirbnbSearchQueries(community)[0]. For configured
// properties the community is PROPERTY_UNIT_CONFIGS[id].community. This block
// guarantees every configured community resolves to a curated, clean
// "Place/Resort, City, ST" Airbnb query (not the verbose, channel-shared
// searchLocation tail like "…, Kauai, Hawaii"), so the operator never
// accidentally prices a property off a generic town/area search.
const EXPECTED_AIRBNB_PRICING_QUERY: Record<string, string> = {
  "Poipu Kai": "Poipu Kai Resort, Koloa, HI",
  "Keauhou": "Keauhou, Kailua-Kona, HI",
  "Princeville": "Princeville, Kauai, HI",
  "Kapaa Beachfront": "Kaha Lani Resort, Wailua, HI",
  "Poipu Oceanfront": "Poipu Beach, Koloa, HI",
  "Pili Mai": "Pili Mai at Poipu, Koloa, HI",
};

const configuredCommunities = new Set(
  Object.values(PROPERTY_UNIT_CONFIGS).map((cfg) => cfg.community),
);
for (const community of configuredCommunities) {
  const expected = EXPECTED_AIRBNB_PRICING_QUERY[community];
  assert.ok(
    expected,
    `configured community "${community}" has no expected curated Airbnb pricing query — add one (and a curated platformSearch.airbnb in shared/buy-in-market.ts)`,
  );
  assert.equal(
    BUY_IN_MARKETS[community]?.platformSearch?.airbnb,
    expected,
    `market "${community}" must carry a curated platformSearch.airbnb so bulk pricing searches Airbnb by the correct resort/community name`,
  );
}

// Assert per-property (every id the bulk queue can run) and reject any verbose
// "Kauai, Hawaii" / "Big Island, Hawaii" tail leaking into the Airbnb query.
for (const [idStr, cfg] of Object.entries(PROPERTY_UNIT_CONFIGS)) {
  const query = curatedAirbnbSearchQueries(cfg.community)[0];
  assert.equal(
    query,
    EXPECTED_AIRBNB_PRICING_QUERY[cfg.community],
    `property #${idStr} (${cfg.community}) must price off the correct curated Airbnb query`,
  );
  assert.doesNotMatch(
    query,
    /,\s*(?:Kauai|Big Island|Maui|Oahu),\s*Hawaii$/i,
    `property #${idStr} Airbnb pricing query must not use the verbose island+Hawaii searchLocation tail (got "${query}")`,
  );
}

// Every curated market that backs the dashboard (Hawaii + Florida resorts) should
// expose a clean ", ST" Airbnb term so drafts that resolve to them are also correct.
for (const [key, market] of Object.entries(BUY_IN_MARKETS)) {
  if (key === "Florida Generic") continue; // generic statewide fallback, no resort
  const airbnbQuery = market.platformSearch?.airbnb;
  assert.ok(
    airbnbQuery,
    `market "${key}" should carry a curated platformSearch.airbnb for the bulk-pricing Airbnb search`,
  );
  assert.match(
    airbnbQuery!,
    /,\s*[A-Z]{2}$/,
    `market "${key}" curated Airbnb query "${airbnbQuery}" must end in a 2-letter state code`,
  );
}

console.log("hybrid pricing suite passed");
