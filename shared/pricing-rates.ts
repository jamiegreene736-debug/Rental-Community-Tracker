// Static cost-basis tables shared by client (pricing-data.ts) and server
// (availability-scheduler).
//
// These are what we PAY to buy into other hosts' listings — NOT what we
// charge guests. Sourced from manual market research per community + BR
// count, multiplied by season factor. Used as the floor for computing
// a "cost + 20% margin" target rate.
//
// Important: don't drop the airbnb engine's live SELL prices in here as
// "live cost basis" — those are other hosts' marked-up retail rates,
// which would inflate our target by ~80%. Treat live engine numbers as
// telemetry only.

import { resolveBuyInMarket } from "./buy-in-market";

// Business markup applied to the buy-in cost basis when we push base rates to
// Guesty (the dashboard "Update market pricing" bulk queue + the weekly
// availability scan). 0.15 = a flat 15% markup over cost.
//
// Operator directive 2026-07-01: the market-rate update queue applies a 20%
// markup to every property (was 15% per the 2026-06-18 directive). This is the
// single source of truth for that business margin — the server market-rate
// pushes use it directly, overriding any legacy per-property
// `scanner_schedules.target_margin`. Change this one constant to retune it.
export const MARKET_RATE_TARGET_MARGIN = 0.20;

// Per-property margin OVERRIDES. Default (no entry) = MARKET_RATE_TARGET_MARGIN.
// Keyed by dashboard propertyId — negative ids are community drafts (the
// `-draftId` convention used across the dashboard); positive ids are static
// properties from unit-builder-data.ts.
//
// NOTE FOR CODEX: this is the *additive* re-introduction of a per-property
// margin. The 2026-06-18 directive disabled reading the polluted
// `scanner_schedules.target_margin` column (legacy rows carry a stale 0.2000
// default) and pushed a flat 15% to everyone. This map does NOT touch that
// column — it is an explicit allow-list so the global flat 15% still applies to
// every property NOT listed here. Operator 2026-06-27: the Menehune Shores
// "4BR" listing (propertyId -3) is a 2-unit MAUI combo bought retail in peak
// season — at the flat 15% over the Airbnb p40 rent median it books at or below
// the doubled buy-in cost. Set to 20% (the operator's target net margin) so the
// per-unit sell clears realized cost even when the cheap units are gone. Keep
// this list short; if it grows, back it with an explicit DB column (NOT the
// legacy target_margin) and read it through targetMarginForProperty.
export const PROPERTY_TARGET_MARGIN_OVERRIDES: Record<number, number> = {
  [-3]: 0.20, // Menehune Shores, Kihei (Maui) — 2BR+2BR combo "Sunny 4BR for 8"
};

// Single chokepoint for the margin applied when pushing market rates to Guesty.
// Every price-push path (bulk queue, weekly cron, manual "Run now") must read
// the margin through this helper so the override stays consistent.
export function targetMarginForProperty(propertyId?: number | null): number {
  if (propertyId != null) {
    const override = PROPERTY_TARGET_MARGIN_OVERRIDES[propertyId];
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
      return override;
    }
  }
  return MARKET_RATE_TARGET_MARGIN;
}

export type SeasonType = "HIGH" | "LOW" | "HOLIDAY";
export type RegionType = "hawaii" | "florida";

type CommunityRate = {
  "2BR"?: number;
  "3BR"?: number;
  "4BR"?: number;
  "5BR"?: number;
  region: RegionType;
};

export const BUY_IN_RATES: Record<string, CommunityRate> = {
  "Poipu Kai":         { "2BR": 516, "3BR": 636, "4BR": 858,  region: "hawaii" },
  "Poipu Oceanfront":  { "2BR": 630, "3BR": 792, "4BR": 936,  region: "hawaii" },
  "Poipu Brenneckes":  { "2BR": 510, "3BR": 618, "4BR": 864,  region: "hawaii" },
  // Recalibrated from operator-verified Airbnb buy-in comps for
  // 2026-09-08..2026-09-15: 2BR $384 and 3BR $532. September is LOW
  // season in Hawaii, so divide by 0.80 to keep this as the annual
  // baseline used by the existing season multiplier model.
  "Pili Mai":          { "2BR": 480, "3BR": 665, "4BR": 840,  region: "hawaii" },
  // 3BR re-set 2026-04-28 from $840 to $615 to match the live-data
  // methodology operator chose to keep. The live Airbnb-engine
  // backfill landed Kapaa Beachfront 2BR at $430/n=4 (vs the prior
  // static $588 — 27% drop), but Kapaa proper has no 3BR condo comps
  // in the operator's COMMUNITY_BOUNDS zone, so the per-property
  // refresh persists no 3BR row and the Pricing tab falls through to
  // this static value for unit A on prop 23. Extrapolation: $430 ×
  // 1.43 (the prior static 3BR/2BR ratio for this community) = $615 —
  // keeps prop 23's 3BR component consistent with the rest of the
  // live-data table.
  "Kapaa Beachfront":  { "2BR": 588, "3BR": 615, "4BR": 1020, region: "hawaii" },
  "Princeville":       { "2BR": 492, "3BR": 744, "4BR": 858,  region: "hawaii" },
  "Kekaha Beachfront": { "2BR": 540, "3BR": 810, "4BR": 1080, region: "hawaii" },
  "Keauhou":           { "2BR": 312,                          region: "hawaii" },
  "Southern Dunes":    { "2BR":  85, "3BR": 192, "4BR": 200,  region: "florida" },
  "Windsor Hills":     { "2BR": 150, "3BR": 210, "4BR": 294,  region: "florida" },
  "Bonita National":   { "2BR": 160,                          region: "florida" },
  // Santa Maria Resort (Fort Myers Beach, FL) — distinct from Bonita
  // National so the pricing queue stays on the Estero Blvd resort footprint.
  "Santa Maria Resort":{ "2BR": 160,                          region: "florida" },
  // Internal fallback key for Florida single-listing/community drafts
  // whose exact resort has no static buy-in row yet. Keeps live
  // season-band scans on Florida multipliers instead of falling through
  // to the Hawaii default.
  "Florida Generic":   {                                      region: "florida" },
};

// Region-aware fallback for areas not in BUY_IN_RATES. Hawaii's $270/BR
// matches the average 2BR cost basis across our Kauai inventory; Florida's
// $80/BR matches the Disney-area condo cost basis (Southern Dunes 3BR ≈
// $64/BR). Using the Hawaii number for a
// Florida draft inflates the dashboard buy-in by ~3.5×. See the note in
// `getBuyInRate` for how the fallback is selected.
const FALLBACK_RATE_PER_BEDROOM: Record<RegionType, number> = {
  hawaii:  270,
  florida:  80,
};

const AIRBNB_STATIC_PLAUSIBILITY_RATIO = 1.25;

export const SEASON_MULTIPLIERS: Record<RegionType, Record<SeasonType, number>> = {
  hawaii:  { LOW: 0.80, HIGH: 1.30, HOLIDAY: 1.80 },
  florida: { LOW: 0.75, HIGH: 1.25, HOLIDAY: 1.70 },
};

// Per-season markup to correct Airbnb's typical under-pricing vs VRBO/Booking.com medians.
// Applied to the exact-BR median *before* combo handling and the final 20% business markup.
// Tunable; conservative values from historical spread observations.
export const AIRBNB_TO_MARKET_MARKUPS: Record<SeasonType, number> = {
  LOW: 1.16,      // shoulder/low: biggest Airbnb discount vs reality
  HIGH: 1.09,     // peak summer: smaller gap
  HOLIDAY: 1.05,  // holiday spikes: Airbnb closer to other channels
};

const HAWAII_SEASONS: Record<string, SeasonType> = {
  "2026-04": "HIGH",  "2026-05": "LOW",  "2026-06": "HIGH",  "2026-07": "HIGH",
  "2026-08": "HIGH",  "2026-09": "LOW",  "2026-10": "LOW",   "2026-11": "LOW",
  "2026-12": "HIGH",  "2027-01": "HIGH", "2027-02": "LOW",   "2027-03": "HIGH",
  "2027-04": "HIGH",  "2027-05": "LOW",  "2027-06": "HIGH",  "2027-07": "HIGH",
  "2027-08": "HIGH",  "2027-09": "LOW",  "2027-10": "LOW",   "2027-11": "LOW",
  "2027-12": "HIGH",  "2028-01": "HIGH", "2028-02": "LOW",   "2028-03": "HIGH",
  "2028-04": "HIGH",
};
const FLORIDA_SEASONS: Record<string, SeasonType> = {
  "2026-04": "HIGH",  "2026-05": "LOW",  "2026-06": "HIGH",  "2026-07": "HIGH",
  "2026-08": "HIGH",  "2026-09": "LOW",  "2026-10": "LOW",   "2026-11": "LOW",
  "2026-12": "HIGH",  "2027-01": "LOW",  "2027-02": "LOW",   "2027-03": "HIGH",
  "2027-04": "HIGH",  "2027-05": "LOW",  "2027-06": "HIGH",  "2027-07": "HIGH",
  "2027-08": "HIGH",  "2027-09": "LOW",  "2027-10": "LOW",   "2027-11": "LOW",
  "2027-12": "HIGH",  "2028-01": "LOW",  "2028-02": "LOW",   "2028-03": "HIGH",
  "2028-04": "HIGH",
};

export function getCommunityRegion(community: string): RegionType {
  return BUY_IN_RATES[community]?.region ?? "hawaii";
}

// Combined lodging/occupancy tax by region. Hawaii TAT 10.25% + county TAT ~3%
// + GET ~4.7% ≈ ~18%; Florida state 6% + county tourist-development ≈ ~12.5%.
// NOTE (2026-07-10): the LIVE market-rate engine (server/hybrid-pricing.ts) no
// longer applies this — the operator asked for the tax uplift's removal, so
// the stored basis is the raw SearchAPI Airbnb median again. This table is
// kept ONLY for the dormant Claude static/all-in engine
// (shared/static-rate-logic.ts re-exports it — keep it here).
export const LODGING_TAX_PCT: Record<RegionType, number> = {
  hawaii: 0.18,
  florida: 0.125,
};

// Gross a nightly buy-in basis up by the community's regional lodging tax.
// UNUSED by the live market-rate update path since 2026-07-10 (the operator
// asked for the checkout-tax uplift's removal — do NOT re-wire this into
// hybrid-pricing.ts; tests/pipeline-logic.test.ts source-guards that). Retained
// as a pure helper for the dormant static engine + tests. The old
// MARKET_RATE_LODGING_TAX_DISABLED kill-switch env var is now a no-op.
export function applyLodgingTaxGrossUp(basis: number, community: string): number {
  if (!Number.isFinite(basis) || basis <= 0) return basis;
  const region = getCommunityRegion(community);
  return Math.round(basis * (1 + LODGING_TAX_PCT[region]));
}

function staticRateForSeason(
  community: string,
  bedrooms: number,
  season?: SeasonType,
): number | null {
  const entry = BUY_IN_RATES[community];
  const key = `${bedrooms}BR` as keyof CommunityRate;
  const rate = entry?.[key];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  if (!season) return rate;
  const region = entry?.region ?? getCommunityRegion(community);
  return Math.round(rate * SEASON_MULTIPLIERS[region][season]);
}

export function clampSuspiciousAirbnbBuyInRate(args: {
  community: string;
  bedrooms: number;
  rate: number;
  source?: string | null;
  season?: SeasonType;
}): number {
  if (args.source !== "airbnb") return args.rate;
  const staticRate = staticRateForSeason(args.community, args.bedrooms, args.season);
  if (staticRate == null) return args.rate;
  return args.rate > staticRate * AIRBNB_STATIC_PLAUSIBILITY_RATIO ? staticRate : args.rate;
}

// Suggest a BUY_IN_RATES key for a draft. Used by the Add a New
// Community wizard's pricing-area picker as the default selection —
// operator can override. Returns "" when nothing matches; the dashboard
// treats that as "no pricing area" and falls back to the per-bedroom
// rate for the region.
//
// `communityName` (optional) lets us pin specific named complexes to
// their own tier when one exists in BUY_IN_RATES. City/state alone is too
// broad for Florida resort clusters, so the name match runs first.
export function suggestPricingArea(
  city: string,
  state: string,
  communityName?: string,
): string {
  const name = (communityName || "").toLowerCase();
  if (name) {
    // Match against every BUY_IN_RATES key. Allowing a substring match handles
    // "Resort" / "Condos" suffixes that operators add to the name field.
    for (const key of Object.keys(BUY_IN_RATES)) {
      if (name.includes(key.toLowerCase())) return key;
    }
  }
  const resolvedMarket = resolveBuyInMarket({ name: communityName, city, state });
  if (resolvedMarket && BUY_IN_RATES[resolvedMarket]) return resolvedMarket;
  const c = (city || "").toLowerCase();
  const s = (state || "").toLowerCase();
  if (s === "hawaii" || s === "hi") {
    if (/\b(poipu|koloa|kalaheo)\b/.test(c)) return "Poipu Kai";
    if (/\b(princeville|hanalei|haena)\b/.test(c)) return "Princeville";
    if (/\b(kapaa|wailua|lihue|anahola)\b/.test(c)) return "Kapaa Beachfront";
    if (/\b(kekaha|waimea|hanapepe)\b/.test(c)) return "Kekaha Beachfront";
    if (/\b(kona|kailua-kona|keauhou|hilo|waikoloa|kohala)\b/.test(c)) return "Keauhou";
    return "";
  }
  if (s === "florida" || s === "fl") {
    // Named FL keys in BUY_IN_RATES — Southern Dunes (Haines City /
    // Davenport, ~15-25mi from Disney, lower buy-in) and Windsor Hills
    // (Disney-proximate newer-build tier). Kissimmee is broad but most
    // STR-eligible communities there are within ~5mi of the parks, so default
    // to Windsor Hills tier when no specific name matched above.
    if (/\b(haines city|davenport)\b/.test(c)) return "Southern Dunes";
    // "estero" narrowed to the inland TOWN — NOT the Fort Myers Beach coastal refs
    // (Estero Blvd / Island / Beach / Bay), which are Santa Maria Resort, a different
    // area (see buy-in-market.ts Bonita National alias, 2026-07-01).
    if (/\b(bonita springs|naples)\b/.test(c) || /\bestero\b(?!\s*(?:blvd|boulevard|island|isl|beach|bay))/.test(c)) return "Bonita National";
    if (/\b(orlando|kissimmee)\b/.test(c)) return "Windsor Hills";
    return "Florida Generic";
  }
  return "";
}

// Live per-(propertyId, bedrooms) buy-in cache. Hydrated client-side
// from `GET /api/property/market-rates` at app mount via
// `setLivePropertyMarketRates`. Empty on the server (server reads
// `property_market_rates` directly from the DB) — that's fine; this
// file is shared but the cache only lives in process memory and the
// only callers that need it run client-side.
//
// Lookup key: `${propertyId}::${bedrooms}`. Negative propertyIds are
// drafts (the synthetic `-draftId` convention used everywhere on the
// dashboard); positive ids are static properties from
// `unit-builder-data.ts`. One cache covers both.
type LiveBuyInKey = string;
type LiveBuyInEntry = {
  // LOW-season basis — primary value the formula uses when called
  // without a season argument (and the field every existing reader
  // already expects). Always present.
  medianNightly: number;
  // Per-season basis added in PR #282. Populated when the multi-
  // season scan ran for that property; null when the scan was
  // legacy single-window OR the season window was unreachable.
  medianNightlyHigh: number | null;
  medianNightlyHoliday: number | null;
  monthlyRates: Record<string, MonthlyMarketRate>;
  sampleCount: number;
  refreshedAt: string;
  source: string;
};
const _liveBuyIns = new Map<LiveBuyInKey, LiveBuyInEntry>();
const liveKey = (propertyId: number, bedrooms: number): LiveBuyInKey => `${propertyId}::${bedrooms}`;

export type MonthlyMarketRate = {
  medianNightly: number;
  season?: SeasonType;
  checkIn?: string;
  checkOut?: string;
  channelCount?: number;
  sampleCount?: number;
  demandClass?: "standard" | "high" | "peak" | "ultra";
  seasonTierId?: string;
  seasonTierLabel?: string;
  channels?: { airbnb?: number | null; vrbo?: number | null; booking?: number | null; pm?: number | null };
  hybrid?: {
    baseAirbnbMedian?: number;
    finalRate?: number;
    layers?: Array<Record<string, unknown>>;
    notes?: string[];
  };
  // Per-month research confidence + evidence (subset). Surfaced by the Pricing
  // tab "Research confirmation" block: the resort actually searched (query), the
  // geo radius / widened flag, and per-bedroom sample/confidence. The comp-level
  // counters (accepted / exact-bedroom / community-matched / geo-verified) feed
  // computeMarketRateMatchConfirmation (shared/market-rate-match-confirmation)
  // — the "right community + right bedroom count" verdict — so do NOT strip
  // them back out of the parse (2026-07-10).
  confidence?: {
    score?: number;
    level?: "green" | "yellow" | "red";
    sampleCount?: number;
    acceptedCandidates?: number;
    exactBedroomCandidates?: number;
    unknownBedroomCandidates?: number;
    communityMatchedCandidates?: number;
    geoVerifiedCandidates?: number;
  };
  evidence?: {
    query?: string;
    requestedBedrooms?: number;
    geoConstraint?: {
      kind?: "curated-bounds" | "center-radius" | "none";
      description?: string;
      radiusMiles?: number | null;
      widened?: boolean;
    };
  };
};

export type LivePropertyMarketRateInput = {
  propertyId: number;
  bedrooms: number;
  medianNightly: number | string;
  medianNightlyHigh?: number | string | null;
  medianNightlyHoliday?: number | string | null;
  monthlyRates?: Record<string, MonthlyMarketRate> | null;
  sampleCount: number;
  refreshedAt: string;
  source: string;
};

function parseNullableRate(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseMonthlyRates(input: unknown): Record<string, MonthlyMarketRate> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const parsed: Record<string, MonthlyMarketRate> = {};
  for (const [yearMonth, raw] of Object.entries(input as Record<string, any>)) {
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) continue;
    if (!raw || typeof raw !== "object") continue;
    const medianNightly = parseNullableRate(raw.medianNightly);
    if (medianNightly == null) continue;
    const season = raw.season === "HIGH" || raw.season === "LOW" || raw.season === "HOLIDAY"
      ? raw.season
      : undefined;
    parsed[yearMonth] = {
      medianNightly,
      season,
      checkIn: typeof raw.checkIn === "string" ? raw.checkIn : undefined,
      checkOut: typeof raw.checkOut === "string" ? raw.checkOut : undefined,
      channelCount: typeof raw.channelCount === "number" ? raw.channelCount : undefined,
      sampleCount: typeof raw.sampleCount === "number" ? raw.sampleCount : undefined,
      demandClass: raw.demandClass === "standard" || raw.demandClass === "high" || raw.demandClass === "peak" || raw.demandClass === "ultra"
        ? raw.demandClass
        : undefined,
      seasonTierId: typeof raw.seasonTierId === "string" ? raw.seasonTierId : undefined,
      seasonTierLabel: typeof raw.seasonTierLabel === "string" ? raw.seasonTierLabel : undefined,
      channels: raw.channels && typeof raw.channels === "object" ? {
        airbnb: parseNullableRate(raw.channels.airbnb),
        vrbo: parseNullableRate(raw.channels.vrbo),
        booking: parseNullableRate(raw.channels.booking),
        pm: parseNullableRate(raw.channels.pm),
      } : undefined,
      hybrid: raw.hybrid && typeof raw.hybrid === "object" ? raw.hybrid : undefined,
      confidence: raw.confidence && typeof raw.confidence === "object" ? {
        score: typeof raw.confidence.score === "number" ? raw.confidence.score : undefined,
        level: raw.confidence.level === "green" || raw.confidence.level === "yellow" || raw.confidence.level === "red"
          ? raw.confidence.level
          : undefined,
        sampleCount: typeof raw.confidence.sampleCount === "number" ? raw.confidence.sampleCount : undefined,
        acceptedCandidates: typeof raw.confidence.acceptedCandidates === "number" ? raw.confidence.acceptedCandidates : undefined,
        exactBedroomCandidates: typeof raw.confidence.exactBedroomCandidates === "number" ? raw.confidence.exactBedroomCandidates : undefined,
        unknownBedroomCandidates: typeof raw.confidence.unknownBedroomCandidates === "number" ? raw.confidence.unknownBedroomCandidates : undefined,
        communityMatchedCandidates: typeof raw.confidence.communityMatchedCandidates === "number" ? raw.confidence.communityMatchedCandidates : undefined,
        geoVerifiedCandidates: typeof raw.confidence.geoVerifiedCandidates === "number" ? raw.confidence.geoVerifiedCandidates : undefined,
      } : undefined,
      evidence: raw.evidence && typeof raw.evidence === "object" ? {
        query: typeof raw.evidence.query === "string" ? raw.evidence.query : undefined,
        requestedBedrooms: typeof raw.evidence.requestedBedrooms === "number" ? raw.evidence.requestedBedrooms : undefined,
        geoConstraint: raw.evidence.geoConstraint && typeof raw.evidence.geoConstraint === "object" ? {
          kind: raw.evidence.geoConstraint.kind,
          description: typeof raw.evidence.geoConstraint.description === "string" ? raw.evidence.geoConstraint.description : undefined,
          radiusMiles: typeof raw.evidence.geoConstraint.radiusMiles === "number" ? raw.evidence.geoConstraint.radiusMiles : null,
          widened: raw.evidence.geoConstraint.widened === true,
        } : undefined,
      } : undefined,
    };
  }
  return parsed;
}

export function setLivePropertyMarketRates(rates: LivePropertyMarketRateInput[]): void {
  _liveBuyIns.clear();
  for (const r of rates) {
    const median = typeof r.medianNightly === "number" ? r.medianNightly : parseFloat(r.medianNightly);
    if (!Number.isFinite(median) || median <= 0) continue;
    _liveBuyIns.set(liveKey(r.propertyId, r.bedrooms), {
      medianNightly: median,
      medianNightlyHigh: parseNullableRate(r.medianNightlyHigh),
      medianNightlyHoliday: parseNullableRate(r.medianNightlyHoliday),
      monthlyRates: parseMonthlyRates(r.monthlyRates),
      sampleCount: r.sampleCount,
      refreshedAt: r.refreshedAt,
      source: r.source,
    });
  }
}

export function getLiveBuyIn(propertyId: number, bedrooms: number): LiveBuyInEntry | null {
  return _liveBuyIns.get(liveKey(propertyId, bedrooms)) ?? null;
}

export function getLiveMonthlyBuyIn(
  propertyId: number,
  bedrooms: number,
  yearMonth: string,
): number | null {
  const monthly = getLiveBuyIn(propertyId, bedrooms)?.monthlyRates[yearMonth]?.medianNightly;
  if (monthly == null || !Number.isFinite(monthly) || monthly <= 0) return null;
  return Math.round(monthly);
}

function fallbackSeasonBasisFromLow(
  community: string,
  lowBasis: number | null,
  season: "HIGH" | "HOLIDAY",
): number | null {
  if (lowBasis == null || lowBasis <= 0) return null;
  const region = BUY_IN_RATES[community]?.region ?? getCommunityRegion(community);
  return Math.round(lowBasis * SEASON_MULTIPLIERS[region][season]);
}

export function normalizeSeasonalBasis(
  community: string,
  lowBasis: number,
  highBasis: number | null,
  holidayBasis: number | null,
): { low: number; high: number | null; holiday: number | null } {
  const highFloor = fallbackSeasonBasisFromLow(community, lowBasis, "HIGH");
  const high = highFloor == null
    ? highBasis
    : Math.max(highBasis ?? highFloor, highFloor);
  const holidayFloorBase = fallbackSeasonBasisFromLow(community, lowBasis, "HOLIDAY");
  const holidayFloor = Math.max(holidayFloorBase ?? 0, high ?? 0) || null;
  const holiday = holidayFloor == null
    ? holidayBasis
    : Math.max(holidayBasis ?? holidayFloor, holidayFloor);
  return { low: lowBasis, high, holiday };
}

// Fallback chain (highest → lowest priority):
//   1. Live per-season basis for (propertyId, bedrooms, season) when a
//      season is supplied AND the multi-season scan populated it.
//   2. Live LOW basis × SEASON_MULTIPLIERS for the season (legacy
//      multiplier model when per-season basis is absent).
//   3. BUY_IN_RATES[community][${BR}BR] — operator-validated static.
//   4. FALLBACK_RATE_PER_BEDROOM[region] × bedrooms — per-region
//      default for areas not in the static table.
//
// `season` is optional: when omitted, returns the LOW basis directly
// (the legacy single-value behavior). When supplied, returns the
// season-specific basis from the multi-season scan when available,
// otherwise applies the multiplier to the LOW basis.
//
// When `yearMonth` is supplied and a live monthly median exists for that
// month, it drives pricing (one SearchAPI sample per calendar month).
// Otherwise fall back to per-season basis columns or LOW × multiplier.
export function getBuyInRate(
  community: string,
  bedrooms: number,
  propertyId?: number,
  season?: SeasonType,
  yearMonth?: string,
): number {
  if (propertyId != null) {
    const live = _liveBuyIns.get(liveKey(propertyId, bedrooms));
    if (live) {
      if (yearMonth) {
        const monthly = getLiveMonthlyBuyIn(propertyId, bedrooms, yearMonth);
        if (monthly != null) {
          return monthly;
        }
      }
      const normalized = normalizeSeasonalBasis(
        community,
        live.medianNightly,
        live.medianNightlyHigh,
        live.medianNightlyHoliday,
      );
      // Season-specific basis when available + requested.
      if (season === "HIGH" && normalized.high != null) {
        return clampSuspiciousAirbnbBuyInRate({ community, bedrooms, rate: normalized.high, source: live.source, season });
      }
      if (season === "HOLIDAY" && normalized.holiday != null) {
        return clampSuspiciousAirbnbBuyInRate({ community, bedrooms, rate: normalized.holiday, source: live.source, season });
      }
      // LOW or unknown-season → use base. When the caller supplied
      // HIGH/HOLIDAY but per-season basis isn't populated, apply the
      // multiplier so the formula still varies seasonally.
      if (season && season !== "LOW") {
        const region = BUY_IN_RATES[community]?.region ?? getCommunityRegion(community);
        const multiplier = SEASON_MULTIPLIERS[region][season];
        return clampSuspiciousAirbnbBuyInRate({
          community,
          bedrooms,
          rate: Math.round(live.medianNightly * multiplier),
          source: live.source,
          season,
        });
      }
      return clampSuspiciousAirbnbBuyInRate({ community, bedrooms, rate: live.medianNightly, source: live.source, season });
    }
  }
  const entry = BUY_IN_RATES[community];
  const key = `${bedrooms}BR` as keyof CommunityRate;
  const rate = entry?.[key];
  if (typeof rate === "number") {
    // Static-table values are an annual BASELINE (not pre-calibrated
    // to any specific season). Legacy callers pre-PR #282 always
    // applied SEASON_MULTIPLIERS on top, including the 0.80 LOW
    // multiplier. PR #283 accidentally skipped the LOW multiplier
    // when a season was explicitly passed, inflating LOW-month
    // totals for properties relying on the static fallback (3BR
    // Kaha Lani: was $615 raw, should be $615 × 0.80 = $492).
    // Restore: apply multiplier for ALL seasons including LOW when
    // a season is supplied. Legacy seasonless callers still get
    // the raw baseline back.
    if (season) {
      const region = entry?.region ?? getCommunityRegion(community);
      const multiplier = SEASON_MULTIPLIERS[region][season];
      return Math.round(rate * multiplier);
    }
    return rate;
  }
  // No exact rate. Fall back per region — Florida and Hawaii cost
  // bases differ by ~3.5×, so a global per-BR fallback would inflate
  // one market or under-price the other. If the community isn't in
  // the table at all, getCommunityRegion defaults to hawaii.
  const region = entry?.region ?? getCommunityRegion(community);
  const fallback = FALLBACK_RATE_PER_BEDROOM[region] * bedrooms;
  if (season) {
    const multiplier = SEASON_MULTIPLIERS[region][season];
    return Math.round(fallback * multiplier);
  }
  return fallback;
}

export function getSeasonForMonth(yearMonth: string, region: RegionType): SeasonType {
  const map = region === "florida" ? FLORIDA_SEASONS : HAWAII_SEASONS;
  return map[yearMonth] ?? "LOW";
}

// Channel host-fee model + target margin. Kept here so server and client
// agree on the numbers — the client's pricing-data.ts re-exports from here.
export type ChannelKey = "airbnb" | "vrbo" | "booking" | "direct";

export const CHANNEL_HOST_FEE: Record<ChannelKey, number> = {
  airbnb:  0.155,
  vrbo:    0.08,
  booking: 0.17,
  direct:  0.03,
};

// Fee-differential markup per channel: makes every channel net the same
// dollars as Direct after its fee. Formula:
//   m_ch = (1 - fee_direct) / (1 - fee_ch) - 1
// Rounded UP to 0.1% so the resulting margin never rounds DOWN below target.
export function computeChannelMarkups(
  fees: Record<ChannelKey, number> = CHANNEL_HOST_FEE,
): Record<ChannelKey, number> {
  const feeDirect = fees.direct ?? 0;
  const out: Record<ChannelKey, number> = { airbnb: 0, vrbo: 0, booking: 0, direct: 0 };
  for (const ch of ["airbnb", "vrbo", "booking", "direct"] as ChannelKey[]) {
    const raw = (1 - feeDirect) / (1 - (fees[ch] ?? 0)) - 1;
    out[ch] = Math.max(0, Math.ceil(raw * 1000) / 1000);
  }
  return out;
}

// Maps our logical channel keys to Guesty's integration platform keys.
// Confirmed from a live listing readback 2026-04-21.
export const CHANNEL_TO_GUESTY_KEY: Record<ChannelKey, string> = {
  airbnb:  "airbnb2",
  vrbo:    "homeaway2",
  booking: "bookingCom",
  direct:  "manual",
};

// Total nightly buy-in cost for a property's full set of unit slots in
// a given month. Used as the cost floor for the seasonal rate push.
//
// PR #282: when a per-season basis is populated for the (propertyId,
// bedrooms) pair, getBuyInRate(community, br, propertyId, season)
// returns it directly — no multiplier applied. Falls back to LOW ×
// multiplier when the per-season basis is missing.
export function totalNightlyBuyInForMonth(
  community: string,
  unitSlots: Array<{ bedrooms: number }>,
  yearMonth: string,
  propertyId?: number,
): number {
  const region = getCommunityRegion(community);
  const season = getSeasonForMonth(yearMonth, region);
  let total = 0;
  for (const slot of unitSlots) {
    total += getBuyInRate(community, slot.bedrooms, propertyId, season, yearMonth);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────
// RANDOM 7-NIGHT SEASONAL SAMPLER (for live market-rate refreshes)
// Picks a *random* 7-night window inside the *next* season occurrence
// within a hard 10-month lookahead cap. Never returns 2028+ dates
// that have no Airbnb calendar data yet. Used by scheduler + manual
// Pricing tab refresh to avoid the "no usable exact-2BR LOW samples"
// failure for far-future windows.
// ─────────────────────────────────────────────────────────────

export type SeasonKey = SeasonType;

export function pickRandom7NightInSeason(
  region: RegionType,
  season: SeasonKey,
  maxLookaheadMonths = 10,
): { checkIn: string; checkOut: string } | null {
  const seasonMap = region === "florida" ? FLORIDA_SEASONS : HAWAII_SEASONS;
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxFuture = new Date(today.getTime() + maxLookaheadMonths * 30 * 86_400_000);

  // For HOLIDAY use the existing holiday ranges (first future one within cap)
  if (season === "HOLIDAY") {
    const holidays: Array<{ sm: number; sd: number; em: number; ed: number }> = [
      { sm: 12, sd: 20, em: 1, ed: 5 },
      { sm: 7, sd: 1, em: 7, ed: 7 },
      { sm: 11, sd: 22, em: 11, ed: 30 },
      { sm: 3, sd: 15, em: 4, ed: 5 },
      { sm: 2, sd: 14, em: 2, ed: 17 },
    ];
    for (const yearOffset of [0, 1]) {
      for (const h of holidays) {
        const year = today.getFullYear() + yearOffset;
        const ci = new Date(year, h.sm - 1, h.sd + 2);
        if (ci > today && ci < maxFuture) {
          const co = new Date(ci.getTime() + 7 * 86_400_000);
          return { checkIn: ymd(ci), checkOut: ymd(co) };
        }
      }
    }
    return null;
  }

  // LOW / HIGH: walk forward month-by-month (capped), find first match,
  // then pick a *random* day 4-21 for check-in (true random 7-night inside season month).
  for (let offset = 1; offset <= maxLookaheadMonths; offset++) {
    const target = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    if (target > maxFuture) break;
    const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
    if (seasonMap[ym] === season) {
      // Random day in 4..21 to avoid 1st/31st edge cases in pricing calendars
      const day = 4 + Math.floor(Math.random() * 18);
      const ci = new Date(target.getFullYear(), target.getMonth(), day);
      if (ci > today) {
        const co = new Date(ci.getTime() + 7 * 86_400_000);
        return { checkIn: ymd(ci), checkOut: ymd(co) };
      }
    }
  }
  return null;
}

// Apply per-season Airbnb bias correction, then combo adjustment, then caller adds final 20%.
export function applyAirbnbBiasAndCombo(
  median: number,
  season: SeasonKey,
  unitCount: number,   // 1 for single listing, 2+ for combo (two physical units behind one Guesty listing)
  sameBrCount = false, // when true and unitCount===2, user spec allows explicit double
): number {
  const bias = AIRBNB_TO_MARKET_MARKUPS[season] ?? 1.10;
  let adjusted = Math.round(median * bias);
  if (unitCount > 1) {
    // Combo: either explicit double (identical BRs) or sum (different BRs). Caller passes effective count.
    adjusted = sameBrCount && unitCount === 2 ? adjusted * 2 : adjusted * unitCount;
  }
  return Math.round(adjusted);
}
