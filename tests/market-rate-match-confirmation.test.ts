import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeMarketRateMatchConfirmation,
  MATCH_AREA_BOX_MAX_RADIUS_MILES,
  MATCH_MIN_COMPS_PER_BEDROOM,
  MATCH_VERIFIED_MIN_PCT,
} from "../shared/market-rate-match-confirmation";

// ── fixtures: the persisted property_market_rates.monthlyRates month shape ──

type MonthOpts = {
  accepted?: number;
  exact?: number;
  unknown?: number;
  geoVerified?: number;
  textMatched?: number;
  requestedBedrooms?: number | null;
  kind?: "curated-bounds" | "center-radius" | "none";
  widened?: boolean;
  radiusMiles?: number | null;
  query?: string;
};

function liveMonth(opts: MonthOpts = {}) {
  const accepted = opts.accepted ?? 4;
  const exact = opts.exact ?? accepted;
  const unknown = opts.unknown ?? 0;
  return {
    medianNightly: 450,
    season: "LOW",
    sampleCount: accepted,
    confidence: {
      score: 92,
      level: "green",
      sampleCount: accepted,
      acceptedCandidates: accepted,
      rejectedCandidates: 1,
      exactBedroomCandidates: exact,
      unknownBedroomCandidates: unknown,
      communityMatchedCandidates: opts.textMatched ?? 1,
      geoVerifiedCandidates: opts.geoVerified ?? Math.max(0, accepted - 1),
      percentileBasis: 50,
    },
    evidence: {
      searchedAt: "2026-07-10T00:00:00.000Z",
      query: opts.query ?? "Poipu Kai Resort, Koloa, HI",
      checkIn: "2026-08-04",
      checkOut: "2026-08-11",
      nights: 7,
      requestedBedrooms: opts.requestedBedrooms === null ? undefined : (opts.requestedBedrooms ?? 3),
      totalCandidates: accepted + 1,
      acceptedCandidates: accepted,
      rejectedCandidates: 1,
      acceptedExactBedroomCandidates: exact,
      acceptedUnknownBedroomCandidates: unknown,
      acceptedCommunityMatchedCandidates: opts.textMatched ?? 1,
      acceptedGeoVerifiedCandidates: opts.geoVerified ?? Math.max(0, accepted - 1),
      geoConstraint: {
        kind: opts.kind ?? "curated-bounds",
        description: "curated resort/market bounding box",
        radiusMiles: opts.radiusMiles === undefined ? 0.9 : opts.radiusMiles,
        widened: opts.widened === true,
      },
    },
  };
}

// Year-2 months copy the year-1 confidence forward but carry no evidence.
function extrapolatedMonth() {
  return { medianNightly: 464, sampleCount: 4, confidence: { score: 92, level: "green", sampleCount: 4, acceptedCandidates: 4, exactBedroomCandidates: 4 } };
}

// Thin months priced from the static buy-in table: neither confidence nor evidence.
function staticFallbackMonth() {
  return { medianNightly: 810, sampleCount: 0 };
}

// Distinct keys for >12 months (yearMonth-shaped keys are not required by the module).
function monthRecordKeyed(months: any[]): Record<string, any> {
  const record: Record<string, any> = {};
  months.forEach((m, i) => { record[`m${i}`] = m; });
  return record;
}

// ── 1. fully verified curated scan → green "verified" ──
{
  const rows = [
    {
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([
        ...Array.from({ length: 12 }, () => liveMonth({ requestedBedrooms: 3, accepted: 4, exact: 4, geoVerified: 3, textMatched: 1 })),
        ...Array.from({ length: 12 }, () => extrapolatedMonth()),
      ]),
    },
    {
      bedrooms: 2,
      monthlyRates: monthRecordKeyed([
        ...Array.from({ length: 12 }, () => liveMonth({ requestedBedrooms: 2, accepted: 3, exact: 3, geoVerified: 2, textMatched: 0 })),
        ...Array.from({ length: 12 }, () => extrapolatedMonth()),
      ]),
    },
  ];
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, HI",
    expectedCity: "Koloa",
    expectedState: "Hawaii",
    curated: true,
    expectedBedrooms: [2, 3],
    rows,
  });
  assert.ok(match, "verified case returns a confirmation");
  assert.equal(match!.verdict, "verified");
  assert.equal(match!.level, "green");
  assert.equal(match!.communityVerdict, "verified");
  assert.equal(match!.bedroomVerdict, "verified");
  assert.equal(match!.comps, 48 + 36);
  assert.equal(match!.exactBedroomComps, 84);
  assert.equal(match!.bedroomVerifiedPct, 100);
  assert.equal(match!.liveMonths, 24);
  assert.equal(match!.widenedMonths, 0);
  assert.equal(match!.communityConfirmation?.confirmed, true);
  assert.equal(match!.missingExpectedBedrooms.length, 0);
  assert.ok(match!.headline.startsWith("Community & bedrooms verified"), `headline: ${match!.headline}`);
  assert.ok((match!.bedroomVerifiedPct ?? 0) >= MATCH_VERIFIED_MIN_PCT);
  const row3 = match!.perBedroom.find((b) => b.bedrooms === 3)!;
  assert.equal(row3.liveMonths, 12);
  assert.equal(row3.extrapolatedMonths, 12);
  assert.equal(row3.bedroomQueryPinned, true);
  assert.equal(row3.resortBoxedMonths, 12);
  // reasons carry both dimensions for the tooltip/detail UI
  assert.ok(match!.reasons.some((r) => r.includes("hard-boxed")));
  assert.ok(match!.reasons.some((r) => r.includes("independently parsed")));
}

// ── 2. unknown-bedroom dilution below the 95% bar → partial / review ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, HI",
    curated: true,
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([
        liveMonth({ requestedBedrooms: 3, accepted: 6, exact: 4, unknown: 2 }),
        liveMonth({ requestedBedrooms: 3, accepted: 6, exact: 4, unknown: 2 }),
      ]),
    }],
  });
  assert.equal(match!.bedroomVerdict, "partial");
  assert.equal(match!.verdict, "review");
  assert.equal(match!.level, "yellow");
  assert.equal(match!.bedroomVerifiedPct, 67);
  assert.ok(match!.headline.includes("Partially verified"));
}

// ── 3. widened nearby-area months poison community verification ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Bonita National",
    searchLabel: "Bonita National Golf and Country Club, Bonita Springs, FL",
    curated: true,
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([
        ...Array.from({ length: 10 }, () => liveMonth({ requestedBedrooms: 3 })),
        liveMonth({ requestedBedrooms: 3, widened: true, kind: "center-radius", radiusMiles: 4.1 }),
        liveMonth({ requestedBedrooms: 3, widened: true, kind: "center-radius", radiusMiles: 10.2 }),
      ]),
    }],
  });
  assert.equal(match!.communityVerdict, "partial");
  assert.equal(match!.verdict, "review");
  assert.equal(match!.widenedMonths, 2);
  assert.ok(match!.reasons.some((r) => r.includes("WIDENED nearby-area box")));
}

// ── 4. an accepted comp parsed at ANOTHER size is a hard mismatch (red) ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, HI",
    curated: true,
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([liveMonth({ requestedBedrooms: 3, accepted: 5, exact: 3, unknown: 1 })]),
    }],
  });
  assert.equal(match!.bedroomVerdict, "mismatch");
  assert.equal(match!.verdict, "mismatch");
  assert.equal(match!.level, "red");
  assert.ok(match!.reasons.some((r) => r.includes("DIFFERENT bedroom size")));
}

// ── 5. researched sizes don't cover the listing's sizes → red mismatch ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, HI",
    curated: true,
    expectedBedrooms: [2, 3],
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([liveMonth({ requestedBedrooms: 3 })]),
    }],
  });
  assert.equal(match!.verdict, "mismatch");
  assert.deepEqual(match!.missingExpectedBedrooms, [2]);
  assert.ok(match!.headline.includes("listing needs 2BR"), `headline: ${match!.headline}`);
}

// ── 6. search label in the wrong location → red mismatch (geo guard) ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Street, Baton Rouge, Louisiana",
    expectedCity: "Koloa",
    expectedState: "Hawaii",
    curated: true,
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([liveMonth({ requestedBedrooms: 3 })]),
    }],
  });
  assert.equal(match!.communityConfirmation?.locationMatch, false);
  assert.equal(match!.communityVerdict, "mismatch");
  assert.equal(match!.verdict, "mismatch");
  assert.ok(match!.headline.includes("Research location doesn't match"));
}

// ── 7. inferred combo bedroom split caps at partial even with clean evidence ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, HI",
    curated: true,
    bedroomSplitInferred: true,
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([liveMonth({ requestedBedrooms: 3 }), liveMonth({ requestedBedrooms: 3 })]),
    }],
  });
  assert.equal(match!.bedroomVerdict, "partial");
  assert.equal(match!.verdict, "review");
  assert.ok(match!.reasons.some((r) => r.includes("split was inferred")));
}

// ── 8. static-table-only months (no live comps) can never read verified ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, HI",
    curated: true,
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([staticFallbackMonth(), staticFallbackMonth(), staticFallbackMonth()]),
    }],
  });
  assert.equal(match!.liveMonths, 0);
  assert.equal(match!.bedroomVerdict, "unverified");
  assert.equal(match!.communityVerdict, "unverified");
  assert.equal(match!.verdict, "review");
  assert.ok(match!.headline.includes("not market-verified"));
}

// ── 9. tiny comp pools never read verified (small-sample guard) ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, HI",
    curated: true,
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([liveMonth({ requestedBedrooms: 3, accepted: 2, exact: 2, geoVerified: 2 })]),
    }],
  });
  assert.ok(2 < MATCH_MIN_COMPS_PER_BEDROOM);
  assert.equal(match!.bedroomVerdict, "partial");
  assert.equal(match!.verdict, "review");
}

// ── 10. tight auto-curated center-radius box still verifies; a wide one doesn't ──
{
  const tight = computeMarketRateMatchConfirmation({
    community: "Sunset Cove",
    searchLabel: "Sunset Cove, Lahaina, HI",
    expectedCity: "Lahaina",
    expectedState: "HI",
    rows: [{
      bedrooms: 2,
      monthlyRates: monthRecordKeyed([
        liveMonth({ requestedBedrooms: 2, kind: "center-radius", radiusMiles: 2.0, query: "Sunset Cove, Lahaina, HI" }),
        liveMonth({ requestedBedrooms: 2, kind: "center-radius", radiusMiles: 2.0, query: "Sunset Cove, Lahaina, HI" }),
      ]),
    }],
  });
  assert.ok(2.0 <= MATCH_AREA_BOX_MAX_RADIUS_MILES);
  assert.equal(tight!.communityVerdict, "verified");
  assert.equal(tight!.verdict, "verified");

  const wide = computeMarketRateMatchConfirmation({
    community: "Sunset Cove",
    searchLabel: "Sunset Cove, Lahaina, HI",
    expectedCity: "Lahaina",
    expectedState: "HI",
    rows: [{
      bedrooms: 2,
      monthlyRates: monthRecordKeyed([
        liveMonth({ requestedBedrooms: 2, kind: "center-radius", radiusMiles: 8.0 }),
      ]),
    }],
  });
  assert.equal(wide!.communityVerdict, "partial");
}

// ── 11. missing requestedBedrooms (legacy evidence) → query not proven pinned ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, HI",
    curated: true,
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([liveMonth({ requestedBedrooms: null, accepted: 6, exact: 6 })]),
    }],
  });
  assert.equal(match!.perBedroom[0].bedroomQueryPinned, false);
  assert.equal(match!.bedroomVerdict, "partial");
}

// ── 12. no usable rows → null (UIs skip rendering) ──
{
  assert.equal(computeMarketRateMatchConfirmation({ community: "Poipu Kai", rows: [] }), null);
  assert.equal(
    computeMarketRateMatchConfirmation({ community: "Poipu Kai", rows: [{ bedrooms: 3, monthlyRates: null }] }),
    null,
  );
}

// ── 13. a precomputed communityConfirmation (from the pricing recipe) wins ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Poipu Kai",
    searchLabel: "whatever",
    communityConfirmation: {
      community: "Poipu Kai",
      searchLabel: "custom",
      nameMatch: false,
      cityMatch: true,
      stateMatch: true,
      locationMatch: true,
      curated: false,
      claudeConfirmed: false,
      confirmed: false,
      detail: "custom-detail-passthrough",
    },
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([liveMonth({ requestedBedrooms: 3 })]),
    }],
  });
  assert.equal(match!.reasons[0], "custom-detail-passthrough");
  // unconfirmed (but location-plausible) label caps community at partial
  assert.equal(match!.communityVerdict, "partial");
}

// ── 14. unboxed (kind "none") months + blackout months are surfaced ──
{
  const match = computeMarketRateMatchConfirmation({
    community: "Mystery Resort",
    searchLabel: "Mystery Resort",
    rows: [{
      bedrooms: 3,
      monthlyRates: monthRecordKeyed([
        liveMonth({ requestedBedrooms: 3, kind: "none", radiusMiles: null }),
        { blackout: true, medianNightly: 0 },
      ]),
    }],
  });
  assert.equal(match!.unboxedMonths, 1);
  assert.equal(match!.perBedroom[0].blackoutMonths, 1);
  assert.equal(match!.communityVerdict, "partial");
  assert.ok(match!.reasons.some((r) => r.includes("NO geographic constraint")));
}

// ── source assertions: the verdict is actually wired into engine, queue, and UIs ──
{
  const read = (rel: string) => readFileSync(rel, "utf8");

  // Live engine stamps the label-level confirmation on the pricing recipe so the
  // queue shows "Community confirmed" from the FIRST progress event.
  const hybrid = read("server/hybrid-pricing.ts");
  assert.ok(hybrid.includes("confirmResearchCommunity"), "hybrid-pricing computes the label confirmation");
  assert.ok(hybrid.includes("communityConfirmation"), "hybrid-pricing recipe carries communityConfirmation");

  // The bulk queue computes the evidence verdict when an item's refresh lands
  // and stamps it on progress + terminal events.
  const routes = read("server/routes.ts");
  assert.ok(routes.includes("computeMarketRateMatchConfirmation"), "runBulkPricingItem computes the match confirmation");
  assert.ok(routes.includes("matchConfirmation"), "queue progress carries matchConfirmation");

  // Dashboard queue UI renders the verdict chip.
  const home = read("client/src/pages/home.tsx");
  assert.ok(home.includes("matchConfirmation"), "dashboard reads progress.matchConfirmation");

  // Pricing tab computes the same verdict from the persisted rows.
  const builder = read("client/src/components/GuestyListingBuilder/index.tsx");
  assert.ok(builder.includes("computeMarketRateMatchConfirmation"), "pricing tab computes the match confirmation");

  // The client monthlyRates parse keeps the comp-level counters the verdict
  // needs (widened 2026-07-10 — do not strip these back out).
  const pricingRates = read("shared/pricing-rates.ts");
  assert.ok(pricingRates.includes("exactBedroomCandidates"), "client parse keeps exact-bedroom counters");
  assert.ok(pricingRates.includes("requestedBedrooms"), "client parse keeps requestedBedrooms");
}

console.log("market-rate-match-confirmation suite passed");
