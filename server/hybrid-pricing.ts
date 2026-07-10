import fs from "node:fs";
import path from "node:path";

import { BUY_IN_MARKET_BOUNDS, BUY_IN_MARKET_LOCATIONS, BUY_IN_MARKETS, haversineMiles } from "@shared/buy-in-market";
import { getBuyInRate, getCommunityRegion, getSeasonForMonth, applyLodgingTaxGrossUp, LODGING_TAX_PCT } from "@shared/pricing-rates";
import { confirmResearchCommunity, type CommunityConfirmation } from "@shared/static-rate-logic";
import { PROPERTY_UNIT_CONFIGS, type PropertyUnitConfig } from "@shared/property-units";
import { extractBedroomsFromListing } from "./community-research";

export type HybridDemandClass = "standard" | "high" | "peak" | "ultra";
export type HybridTriggerType = "Weekly Automated Scan" | "Manual Update" | "Admin Backfill";

export type HybridMonthScannedEvent = {
  propertyId: number;
  bedrooms: number;
  monthOffset: number;
  horizonMonths: number;
  yearMonth: string;
  checkIn: string;
  checkOut: string;
  medianNightly: number;
  sampleCount: number;
  confidence?: MarketRateConfidence;
  pricingRecipe?: MarketRatePricingRecipe;
};

// Emitted when a single month's exact-bedroom scan can't find a confident
// comp basis (red confidence or no usable samples). Instead of aborting the
// whole property (the pre-2026-06-15 behavior), the scan records a blackout
// for that month's window and continues to the next month. The bulk pricing
// queue surfaces these and the Guesty push closes the window on the calendar.
export type HybridMonthBlackoutEvent = {
  propertyId: number;
  bedrooms: number;
  monthOffset: number;
  horizonMonths: number;
  yearMonth: string;
  checkIn: string;
  checkOut: string;
  reason: string;
  confidence?: MarketRateConfidence;
};

// A blacked-out (yearMonth, bedrooms) window returned by the scan so callers
// can close it on Guesty (see reconcilePricingBlackoutBlocks).
export type HybridBlackoutWindow = {
  bedrooms: number;
  yearMonth: string;
  checkIn: string;
  checkOut: string;
  reason: string;
};

const hybridPricingCancelledError = () => Object.assign(new Error("Cancelled by operator"), { cancelled: true });

export type HybridLayerBreakdown = {
  layer: number;
  name: string;
  ruleId: string;
  label: string;
  multiplier: number;
  before: number;
  after: number;
};

export type HybridCalculationInput = {
  airbnbMedianNightly: number;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  unitCount?: number;
  isMultiUnit?: boolean;
  difficultGap?: boolean;
  asOf?: Date;
};

export type HybridCalculationResult = {
  finalRate: number;
  baseAirbnbMedian: number;
  demandClass: HybridDemandClass;
  seasonTierId: string;
  seasonTierLabel: string;
  layers: HybridLayerBreakdown[];
  notes: string[];
};

type HybridPricingConfig = {
  version: number;
  scanSettings: {
    enabled: boolean;
    intervalHours: number;
    horizonMonths: number;
    defaultStayNights: number;
    searchApiPageSize: number;
    rateLimitMs: number;
  };
  platformBlendUplift: Record<HybridDemandClass, number>;
  seasonTiers: Array<{
    id: string;
    label: string;
    demandClass: HybridDemandClass;
    multiplier: number;
    recurringRanges?: Array<{ start: string; end: string }>;
    absoluteRanges?: Array<{ start: string; end: string }>;
    relativeHolidayRanges?: Array<{ holiday: "thanksgiving" | "presidents_day"; startOffsetDays: number; endOffsetDays: number }>;
  }>;
  unitSize: {
    smallMultiplier: number;
    fourBedroomMultiplier: number;
    fivePlusBedroomMultiplier: number;
    multiUnitMultiplier: number;
  };
  stayPattern: {
    cleanFivePlusMultiplier: number;
    shortHighDemandMultiplier: number;
    difficultGapMultiplier: number;
  };
  leadTime: Array<{ id: string; minDays?: number; maxDays?: number; multiplier: number; label: string }>;
};

export type LegacySeason = "LOW" | "HIGH" | "HOLIDAY";

export type HybridMonthlyRate = {
  // 0 for blackout months (no confident comp basis); a positive nightly
  // basis otherwise. Readers that price off this value must skip blackout
  // entries (medianNightly <= 0 / blackout === true) — getLiveMonthlyBuyIn
  // already returns null for non-positive values.
  medianNightly: number;
  season: "LOW" | "HIGH" | "HOLIDAY";
  checkIn: string;
  checkOut: string;
  channelCount: number;
  sampleCount: number;
  demandClass: HybridDemandClass;
  seasonTierId: string;
  seasonTierLabel: string;
  confidence?: MarketRateConfidence;
  evidence?: MarketRateEvidence;
  // Set when this month had no confident exact-bedroom comps. The month is
  // kept in monthlyRates (so the 24-month count stays whole and the Guesty
  // push can tell "intentionally blacked out" from "missing/error") but no
  // price is pushed and the window is closed on the Guesty calendar.
  blackout?: boolean;
  blackoutReason?: string;
  channels: { airbnb: number | null; vrbo: null; booking: null; pm: null };
  hybrid: {
    baseAirbnbMedian: number;
    finalRate: number;
    layers: HybridLayerBreakdown[];
    notes: string[];
  };
};

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config/hybrid-pricing.config.json");

function loadConfig(): HybridPricingConfig {
  const raw = process.env.HYBRID_PRICING_CONFIG_JSON
    ?? fs.readFileSync(process.env.HYBRID_PRICING_CONFIG_PATH || DEFAULT_CONFIG_PATH, "utf8");
  return JSON.parse(raw) as HybridPricingConfig;
}

export const HYBRID_PRICING_CONFIG = loadConfig();

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Operator directive 2026-07-01: price from the Airbnb MEDIAN comp (50th
// percentile), not the old P40. 50 = median by definition (interpolatedPercentile
// at 50 == the median already computed alongside it in marketPricingBasis).
const MARKET_PRICING_PERCENTILE = 50;
// Airbnb dated search is reliable for ~12 months; months 13–24 extrapolate
// from the same calendar month in year 1 with YEAR_TWO_MARKET_RATE_GROWTH.
export const AIRBNB_MARKET_RATE_SEARCH_MONTHS = 12;
export const YEAR_TWO_MARKET_RATE_GROWTH = 0.03;

export type MarketRatePricingRecipe = {
  community: string;
  searchName: string;
  source: "searchapi-airbnb";
  percentileBasis: number;
  unitCount: number;
  searchedBedrooms: number[];
  stayNights: number;
  querySet: string[];
  // Phase-3 confirmation flags (drafts only; configured properties are always
  // confident/explicit). resortConfident=false means the community could not be
  // matched to a curated market and fell through to a default — verify the
  // resort. bedroomSplitInferred=true means a combo's per-unit bedroom split was
  // inferred from the combined total rather than explicit per-unit data.
  resortConfident?: boolean;
  bedroomSplitInferred?: boolean;
  // Label-level "right community?" check for the LIVE engine (2026-07-10) —
  // the same confirmResearchCommunity guard the static engine's chip uses: the
  // search label must match the expected city/state (the load-bearing geo
  // guard) plus a name-or-curated identity signal. Computed once per refresh
  // in refreshHybridPricingForTarget and carried on every progress event, so
  // the market-rate queue shows "✓ Community confirmed" from the first tick.
  communityConfirmation?: CommunityConfirmation;
};

export type MarketRateCandidateEvidence = {
  page: number;
  position: number;
  title: string | null;
  url: string | null;
  nightly: number | null;
  bedrooms: number | null;
  communityMatched?: boolean;
  geoMatched?: boolean | null;
  accepted: boolean;
  reason: string;
};

export type MarketRateEvidence = {
  searchedAt: string;
  query: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  requestedBedrooms: number;
  totalCandidates: number;
  acceptedCandidates: number;
  rejectedCandidates: number;
  acceptedExactBedroomCandidates: number;
  acceptedUnknownBedroomCandidates: number;
  acceptedCommunityMatchedCandidates: number;
  acceptedGeoVerifiedCandidates: number;
  acceptedPreview: MarketRateCandidateEvidence[];
  rejectedPreview: MarketRateCandidateEvidence[];
  rejectCounts: Record<string, number>;
  searchContract: Record<string, string>;
  geoConstraint: {
    kind: "curated-bounds" | "center-radius" | "none";
    description: string;
    // Approximate radius (miles) of the search box — center to the NE corner of
    // the bbox. Null when there is no geographic constraint. Surfaced in the
    // research-confirmation UI ("comps within ~X mi").
    radiusMiles: number | null;
    // True when this basis came from a geo-WIDENING fallback pass (the curated
    // resort footprint returned no priced comps, so comps were pulled from a
    // larger nearby box). The confirmation UI flags widened months so the
    // operator knows the basis is nearby-area, not strictly the resort.
    widened: boolean;
  };
};

export type MarketRateConfidence = {
  score: number;
  level: "green" | "yellow" | "red";
  summary: string;
  reasons: string[];
  sampleCount: number;
  acceptedCandidates: number;
  rejectedCandidates: number;
  exactBedroomCandidates?: number;
  unknownBedroomCandidates?: number;
  communityMatchedCandidates?: number;
  geoVerifiedCandidates?: number;
  percentileBasis: number;
};

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function parseDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(1, Math.round((parseDate(checkOut).getTime() - parseDate(checkIn).getTime()) / MS_PER_DAY));
}

function monthDayInRange(checkIn: string, start: string, end: string): boolean {
  const md = checkIn.slice(5);
  if (start <= end) return md >= start && md <= end;
  return md >= start || md <= end;
}

function dateInRange(checkIn: string, start: string, end: string): boolean {
  return checkIn >= start && checkIn <= end;
}

function nthWeekdayOfMonth(year: number, monthIndex: number, weekday: number, nth: number): Date {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return addDays(first, offset + (nth - 1) * 7);
}

function relativeHolidayDate(year: number, holiday: "thanksgiving" | "presidents_day"): Date {
  if (holiday === "thanksgiving") return nthWeekdayOfMonth(year, 10, 4, 4);
  return nthWeekdayOfMonth(year, 1, 1, 3);
}

function resolveSeasonTier(checkIn: string, config: HybridPricingConfig = HYBRID_PRICING_CONFIG) {
  const year = Number(checkIn.slice(0, 4));
  for (const tier of config.seasonTiers) {
    if (tier.absoluteRanges?.some((r) => dateInRange(checkIn, r.start, r.end))) return tier;
    if (tier.recurringRanges?.some((r) => monthDayInRange(checkIn, r.start, r.end))) return tier;
    if (tier.relativeHolidayRanges?.some((r) => {
      const holiday = relativeHolidayDate(year, r.holiday);
      return dateInRange(checkIn, dateOnly(addDays(holiday, r.startOffsetDays)), dateOnly(addDays(holiday, r.endOffsetDays)));
    })) return tier;
  }
  return { id: "standard", label: "Standard", demandClass: "standard" as const, multiplier: 1 };
}

function addLayer(layers: HybridLayerBreakdown[], layer: number, name: string, ruleId: string, label: string, before: number, multiplier: number): number {
  const after = Math.round(before * multiplier);
  layers.push({ layer, name, ruleId, label, multiplier, before: Math.round(before), after });
  return after;
}

export function calculateBlendedRate(input: HybridCalculationInput, config: HybridPricingConfig = HYBRID_PRICING_CONFIG): HybridCalculationResult {
  if (!Number.isFinite(input.airbnbMedianNightly) || input.airbnbMedianNightly <= 0) {
    throw new Error("airbnbMedianNightly must be a positive number");
  }
  const seasonTier = resolveSeasonTier(input.checkIn, config);
  const layers: HybridLayerBreakdown[] = [];
  const notes: string[] = [];
  let value = Math.round(input.airbnbMedianNightly);

  value = addLayer(layers, 1, "Platform Blend Uplift", `platform_${seasonTier.demandClass}`, `Airbnb median adjusted to blended OTA median (${seasonTier.demandClass})`, value, config.platformBlendUplift[seasonTier.demandClass]);
  value = addLayer(layers, 2, "Season / Demand Tier", seasonTier.id, seasonTier.label, value, seasonTier.multiplier);

  const sizeMultiplier = input.bedrooms >= 5
    ? config.unitSize.fivePlusBedroomMultiplier
    : input.bedrooms === 4
      ? config.unitSize.fourBedroomMultiplier
      : config.unitSize.smallMultiplier;
  value = addLayer(layers, 3, "Unit Size / Property Complexity", `bedrooms_${input.bedrooms >= 5 ? "5_plus" : input.bedrooms}`, `${input.bedrooms}BR size complexity`, value, sizeMultiplier);
  if (input.isMultiUnit || (input.unitCount ?? 1) > 1) {
    value = addLayer(layers, 3, "Unit Size / Property Complexity", "multi_unit", "Multi-unit / split-stay buy-in complexity", value, config.unitSize.multiUnitMultiplier);
  }

  const nights = nightsBetween(input.checkIn, input.checkOut);
  if (input.difficultGap) {
    value = addLayer(layers, 4, "Stay Length & Pattern", "difficult_gap", "Difficult gap / orphan-night risk", value, config.stayPattern.difficultGapMultiplier);
    notes.push("Flag for review: stay pattern may create difficult gaps.");
  } else if (nights >= 2 && nights <= 4 && (seasonTier.demandClass === "high" || seasonTier.demandClass === "peak" || seasonTier.demandClass === "ultra")) {
    value = addLayer(layers, 4, "Stay Length & Pattern", "short_high_demand", `${nights}-night high-demand stay`, value, config.stayPattern.shortHighDemandMultiplier);
  } else {
    value = addLayer(layers, 4, "Stay Length & Pattern", "clean_5_plus", `${nights}-night clean pattern`, value, config.stayPattern.cleanFivePlusMultiplier);
  }

  const asOf = input.asOf ?? new Date();
  const leadDays = Math.round((parseDate(input.checkIn).getTime() - Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate())) / MS_PER_DAY);
  const leadRule = config.leadTime.find((r) =>
    (r.minDays == null || leadDays >= r.minDays) && (r.maxDays == null || leadDays <= r.maxDays)
  ) ?? config.leadTime[config.leadTime.length - 1];
  value = addLayer(layers, 5, "Lead Time / Booking Horizon", leadRule.id, `${leadRule.label} (${leadDays} days)`, value, leadRule.multiplier);

  return {
    finalRate: value,
    baseAirbnbMedian: Math.round(input.airbnbMedianNightly),
    demandClass: seasonTier.demandClass,
    seasonTierId: seasonTier.id,
    seasonTierLabel: seasonTier.label,
    layers,
    notes,
  };
}

function interpolatedPercentile(values: number[], percentile: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!clean.length) return null;
  const clamped = Math.min(100, Math.max(0, percentile));
  if (clean.length === 1) return Math.round(clean[0]);
  const position = (clamped / 100) * (clean.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return Math.round(clean[lower]);
  const weight = position - lower;
  return Math.round(clean[lower] + ((clean[upper] - clean[lower]) * weight));
}

function closestDistinctSampleBasis(values: number[], target: number, avoidBasis?: number | null): number | null {
  if (!Number.isFinite(target)) return null;
  if (avoidBasis == null || target !== avoidBasis) return target;
  const alternatives = Array.from(new Set(
    values
      .filter((v) => Number.isFinite(v) && v > 0)
      .map((v) => Math.round(v)),
  ))
    .filter((v) => v !== avoidBasis)
    .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
  return alternatives[0] ?? target;
}

function marketPricingBasis(values: number[], avoidBasis?: number | null): { basis: number | null; percentile: number | null; median: number | null; tieAdjusted: boolean } {
  const percentile = interpolatedPercentile(values, MARKET_PRICING_PERCENTILE);
  const median = interpolatedPercentile(values, 50);
  if (percentile == null || median == null) return { basis: null, percentile, median, tieAdjusted: false };
  const basis = closestDistinctSampleBasis(values, percentile, avoidBasis);
  return { basis, percentile, median, tieAdjusted: basis != null && basis !== percentile };
}

function marketPricingBasisNotes(stats: ReturnType<typeof marketPricingBasis>): string {
  if (stats.percentile != null && stats.median != null) {
    return `using the Airbnb median comp basis $${stats.basis}${stats.tieAdjusted ? "; adjusted to nearest distinct monthly sample to avoid repeating the prior month" : ""}`;
  }
  return `using the Airbnb median comp basis`;
}

function summarizeMonthlyHybridRates(monthlyRates: Record<string, HybridMonthlyRate>) {
  return Object.entries(monthlyRates)
    .slice(0, 4)
    .map(([yearMonth, rate]) => ({
      yearMonth,
      checkIn: rate.checkIn,
      checkOut: rate.checkOut,
      demandClass: rate.demandClass,
      seasonTierId: rate.seasonTierId,
      baseAirbnbMedian: rate.hybrid.baseAirbnbMedian,
      finalRate: rate.hybrid.finalRate,
      appliedRules: rate.hybrid.layers.map((layer) => layer.ruleId),
    }));
}

function summarizeHybridLayers(result: HybridCalculationResult | null) {
  return result?.layers.map((layer) => ({
    layer: layer.layer,
    ruleId: layer.ruleId,
    multiplier: layer.multiplier,
    before: layer.before,
    after: layer.after,
  })) ?? [];
}

function priceNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return NaN;
}

function nightlyRateFromListing(candidate: any, nights: number): number | null {
  const total = Math.round(priceNumber(candidate?.price?.extracted_total_price));
  if (total > 0) return Math.round(total / nights);
  return null;
}

function listingTitle(candidate: any): string | null {
  const value = candidate?.title ?? candidate?.name ?? candidate?.listing_name ?? candidate?.property_name;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function listingUrl(candidate: any): string | null {
  const value = candidate?.link ?? candidate?.url ?? candidate?.listing_url ?? candidate?.property_url;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parsedListingBedrooms(candidate: any): number | null {
  if (typeof candidate?.bedrooms === "number" && Number.isFinite(candidate.bedrooms)) return candidate.bedrooms;
  const parsed = extractBedroomsFromListing(candidate);
  return Number.isNaN(parsed) ? null : parsed;
}

function numberFromCandidate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function candidateCoordinates(candidate: any): { lat: number; lng: number } | null {
  const sources = [
    candidate?.gps_coordinates,
    candidate?.gpsCoordinates,
    candidate?.coordinates,
    candidate?.coordinate,
    candidate,
  ];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const lat = numberFromCandidate(source.latitude ?? source.lat);
    const lng = numberFromCandidate(source.longitude ?? source.lng ?? source.lon);
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

// AUTO-CURATION geo: a non-registry listing's OWN clean Airbnb query + geocoded
// center. Threaded into the market-rate scan it produces a center-radius comp box
// (plus city-level widening anchors) for a resort that has no hand-tuned
// BUY_IN_MARKETS entry — so every listing gets a curated-quality, geo-scoped scan
// instead of a state-wide raw-string search. Ignored for registry markets.
export type DerivedMarketGeo = {
  searchName: string;
  lat: number;
  lng: number;
  city?: string;
  state?: string;
};

function geoConstraintForMarket(community: string): {
  kind: "curated-bounds" | "center-radius" | "none";
  params: Record<string, string>;
  description: string;
} {
  const bounds = BUY_IN_MARKET_BOUNDS[community];
  if (bounds) {
    return {
      kind: "curated-bounds",
      params: {
        sw_lat: String(bounds.sw_lat),
        sw_lng: String(bounds.sw_lng),
        ne_lat: String(bounds.ne_lat),
        ne_lng: String(bounds.ne_lng),
      },
      description: "curated resort/market bounding box",
    };
  }
  const location = BUY_IN_MARKET_LOCATIONS[community];
  if (location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    const halfDeg = 0.02;
    return {
      kind: "center-radius",
      params: {
        sw_lat: String(location.lat - halfDeg),
        sw_lng: String(location.lng - halfDeg),
        ne_lat: String(location.lat + halfDeg),
        ne_lng: String(location.lng + halfDeg),
      },
      description: "center-radius fallback bounding box",
    };
  }
  return { kind: "none", params: {}, description: "no configured geographic constraint" };
}

// Approximate search-box radius in miles (center → NE corner) from the bbox
// params a geoConstraint carries. Null when the box is incomplete/absent. Used
// only for the research-confirmation display ("comps within ~X mi").
function geoConstraintRadiusMiles(params: Record<string, string>): number | null {
  const swLat = numberFromCandidate(params.sw_lat);
  const swLng = numberFromCandidate(params.sw_lng);
  const neLat = numberFromCandidate(params.ne_lat);
  const neLng = numberFromCandidate(params.ne_lng);
  if (swLat == null || swLng == null || neLat == null || neLng == null) return null;
  const centerLat = (swLat + neLat) / 2;
  const centerLng = (swLng + neLng) / 2;
  const miles = haversineMiles(centerLat, centerLng, neLat, neLng);
  return Number.isFinite(miles) ? Math.round(miles * 10) / 10 : null;
}

function candidateGeoMatch(candidate: any, params: Record<string, string>): boolean | null {
  const coords = candidateCoordinates(candidate);
  if (!coords) return null;
  const swLat = numberFromCandidate(params.sw_lat);
  const swLng = numberFromCandidate(params.sw_lng);
  const neLat = numberFromCandidate(params.ne_lat);
  const neLng = numberFromCandidate(params.ne_lng);
  if (swLat == null || swLng == null || neLat == null || neLng == null) return null;
  const pad = 0.003;
  return coords.lat >= swLat - pad &&
    coords.lat <= neLat + pad &&
    coords.lng >= swLng - pad &&
    coords.lng <= neLng + pad;
}

function listingTextMatchesCommunity(candidate: any, community: string, query: string): boolean {
  const haystack = [
    listingTitle(candidate),
    listingUrl(candidate),
    candidate?.location,
    candidate?.address,
    candidate?.snippet,
  ].filter(Boolean).join(" ").toLowerCase();
  const tokens = Array.from(new Set([...community.split(/\W+/), ...query.split(/\W+/)]
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 4 && !/hawaii|florida|condo|villa|rental|airbnb/.test(token))));
  return tokens.length > 0 && tokens.some((token) => haystack.includes(token));
}

function listingMatchesBedrooms(candidate: any, bedrooms: number): boolean {
  const parsed = parsedListingBedrooms(candidate);
  // SearchAPI already filters by bedrooms= — when the engine omits BR in the
  // payload, trust the query rather than dropping every priced listing.
  if (parsed == null) return true;
  return parsed === bedrooms;
}

function previewPush<T>(items: T[], item: T, limit = 5): void {
  if (items.length < limit) items.push(item);
}

function scoreMarketRateConfidence(args: {
  evidence: MarketRateEvidence;
  basis: ReturnType<typeof marketPricingBasis>;
}): MarketRateConfidence {
  const { evidence, basis } = args;
  const accepted = evidence.acceptedCandidates;
  const exactParsed = evidence.acceptedExactBedroomCandidates;
  const unknownParsed = evidence.acceptedUnknownBedroomCandidates;
  const communityMatches = evidence.acceptedCommunityMatchedCandidates;
  const geoVerified = evidence.acceptedGeoVerifiedCandidates;
  const sampleScore = accepted >= 15 ? 28 : accepted >= 10 ? 24 : accepted >= 6 ? 18 : accepted >= 3 ? 10 : accepted > 0 ? 4 : 0;
  const queryScore = evidence.query.trim() ? 15 : 0;
  const locationScore = evidence.geoConstraint.kind === "curated-bounds" ? 20 : evidence.geoConstraint.kind === "center-radius" ? 10 : 0;
  const geoEvidenceScore = geoVerified >= 3 ? 5 : geoVerified > 0 ? 3 : 0;
  const bedroomScore = exactParsed >= 5 ? 22 : exactParsed >= 3 ? 18 : exactParsed > 0 ? 12 : unknownParsed >= 8 ? 8 : unknownParsed > 0 ? 4 : 0;
  const communityScore = communityMatches >= 5 ? 12 : communityMatches >= 2 ? 8 : communityMatches > 0 ? 4 : 0;
  const basisSpread = basis.percentile && basis.median ? Math.abs(basis.median - basis.percentile) / Math.max(1, basis.median) : 0;
  const dispersionScore = basisSpread <= 0.2 ? 10 : basisSpread <= 0.35 ? 6 : 2;
  const rejectionPenalty = evidence.rejectedCandidates > accepted * 3 ? 12 : evidence.rejectedCandidates > accepted * 2 ? 8 : evidence.rejectedCandidates > accepted ? 4 : 0;
  let score = Math.max(0, Math.min(100, sampleScore + queryScore + locationScore + geoEvidenceScore + bedroomScore + communityScore + dispersionScore - rejectionPenalty));
  if (accepted < 3) score = Math.min(score, 69);
  if (exactParsed === 0) score = Math.min(score, 74);
  if (evidence.geoConstraint.kind === "none") score = Math.min(score, 69);
  if (evidence.geoConstraint.kind === "center-radius") score = Math.min(score, 84);
  if (basisSpread > 0.45) score = Math.min(score, 79);
  const level: MarketRateConfidence["level"] = score >= 90 ? "green" : score >= 75 ? "yellow" : "red";
  const reasons = [
    `${accepted} accepted candidate${accepted === 1 ? "" : "s"} (${exactParsed} exact-${evidence.requestedBedrooms}BR, ${unknownParsed} unparsed)`,
    `${evidence.geoConstraint.description}${geoVerified > 0 ? `; ${geoVerified} coordinate-verified` : ""}`,
    communityMatches > 0 ? `${communityMatches} accepted candidate community text match${communityMatches === 1 ? "" : "es"}` : "community match inferred from query/location only",
    `basis p${MARKET_PRICING_PERCENTILE}${basis.median != null ? `, median $${basis.median}` : ""}`,
  ];
  if (evidence.rejectedCandidates > 0) reasons.push(`${evidence.rejectedCandidates} rejected by existing filters`);
  if (level === "red") reasons.push("red confidence blocks save/push for this month");
  return {
    score,
    level,
    summary: `${score}% ${level} confidence`,
    reasons,
    sampleCount: accepted,
    acceptedCandidates: accepted,
    rejectedCandidates: evidence.rejectedCandidates,
    exactBedroomCandidates: exactParsed,
    unknownBedroomCandidates: unknownParsed,
    communityMatchedCandidates: communityMatches,
    geoVerifiedCandidates: geoVerified,
    percentileBasis: MARKET_PRICING_PERCENTILE,
  };
}

export function isSearchApiAirbnbNoResultsError(error: unknown): boolean {
  const text = typeof error === "string"
    ? error
    : error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  return /airbnb.*(?:didn'?t|did not).*return.*(?:any )?results|no .*airbnb.*results|no results/i.test(text);
}

/** Curated resort queries first — draft marketing titles must not override these. */
export function curatedAirbnbSearchQueries(community: string, hint?: string): string[] {
  const market = BUY_IN_MARKETS[community];
  const location = BUY_IN_MARKET_LOCATIONS[community];
  const ordered = [
    market?.platformSearch?.airbnb,
    market?.searchLocation,
    location?.searchName,
    community,
    hint?.trim() || null,
  ].filter((q): q is string => !!q);
  return Array.from(new Set(ordered));
}

export function airbnbSearchGeoParamsForMarket(community: string): Record<string, string> {
  return geoConstraintForMarket(community).params;
}

// ── Geographic-widening fallback for thin in-footprint markets ──────────────
// Some curated markets (gated golf/country-club communities like Bonita National,
// or tiny resort footprints like Santa Maria Resort) have almost no exact-BR
// entire-home Airbnb inventory INSIDE the resort bounding box. The market-rate
// refresh scans 24 months and HARD-FAILS the whole property the moment one month
// returns zero usable samples ("SearchAPI Airbnb returned no usable exact-NBR
// samples …"). When that happens we widen the search to progressively larger
// center-radius boxes around the community center (and broaden the query anchor to
// the surrounding city) so the basis is drawn from real, same-area Airbnb comps
// instead of failing. This is a FALLBACK only — it never runs while the primary
// (curated) box still yields samples, so healthy markets are byte-identical and
// make exactly one SearchAPI request. Real-data only: no static/seasonal fallback.
const MARKET_RATE_WIDENING_HALF_DEGREES = [0.06, 0.15] as const; // ≈ 6.6km then ≈ 16km

// Kill switch (default ON): MARKET_RATE_GEO_WIDENING=0/false/off/no reverts to the
// old hard-fail-on-thin-footprint behavior without a redeploy. Widening can only
// improve a refresh that would otherwise throw, so it is safe to leave enabled.
function marketRateGeoWideningEnabled(): boolean {
  const flag = process.env.MARKET_RATE_GEO_WIDENING;
  return flag == null || !/^(0|false|off|no)$/i.test(flag.trim());
}

// A wider center-radius box around the community's mapped center. Always
// kind "center-radius" (never "none"), so the confidence scorer still credits a
// geographic constraint (center-radius caps at 84 → a healthy widened month can
// still reach yellow and clear the save/push gate). Returns null when the market
// has no mapped center, so unmapped/empty markets never widen.
function centerRadiusGeoConstraint(community: string, halfDeg: number): ReturnType<typeof geoConstraintForMarket> | null {
  const location = BUY_IN_MARKET_LOCATIONS[community];
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return null;
  const km = Math.round(halfDeg * 111);
  return {
    kind: "center-radius",
    params: {
      sw_lat: String(location.lat - halfDeg),
      sw_lng: String(location.lng - halfDeg),
      ne_lat: String(location.lat + halfDeg),
      ne_lng: String(location.lng + halfDeg),
    },
    description: `widened ~${km}km center-radius fallback box (resort footprint had no priced comps)`,
  };
}

// AUTO-CURATION: a center-radius box from arbitrary geocoded coordinates.
// Mirrors centerRadiusGeoConstraint but keyed off a listing's OWN lat/lng rather
// than a curated BUY_IN_MARKET_LOCATIONS center, so a non-registry resort still
// gets a real comp box (primary and widened tiers alike). Returns undefined for
// non-finite coordinates so the caller falls back to the raw-string "none" scan.
function centerRadiusConstraintFromCoords(
  lat: number,
  lng: number,
  halfDeg: number,
  description: string,
): ReturnType<typeof geoConstraintForMarket> | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return {
    kind: "center-radius",
    params: {
      sw_lat: String(lat - halfDeg),
      sw_lng: String(lng - halfDeg),
      ne_lat: String(lat + halfDeg),
      ne_lng: String(lng + halfDeg),
    },
    description,
  };
}

// City-level query anchors used only at the widened tiers. A tight resort q can
// itself starve Airbnb's result set, so broadening the box AND the query (e.g.
// "Bonita Springs, FL") is what actually surfaces nearby same-area comps.
function cityAnchorQueriesForMarket(community: string): string[] {
  const market = BUY_IN_MARKETS[community];
  const location = BUY_IN_MARKET_LOCATIONS[community];
  const anchors: string[] = [];
  if (market?.platformSearch?.booking) anchors.push(market.platformSearch.booking);
  if (location?.city) anchors.push(location.state ? `${location.city}, ${location.state}` : location.city);
  return Array.from(new Set(anchors.map((q) => q.trim()).filter(Boolean)));
}

async function fetchAirbnbMedianNightlyForQuery(args: {
  community: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  query: string;
  apiKey: string;
  nights: number;
  // When omitted the query runs against the market's PRIMARY constraint (curated
  // bounds → center-radius → none) exactly as before. A widening fallback passes
  // an override to broaden the geographic box without touching geoConstraintForMarket
  // (which is locked by the curated-bounds tests). The override drives the SearchAPI
  // request params, the candidateGeoMatch post-filter, and the evidence kind alike.
  geoConstraintOverride?: ReturnType<typeof geoConstraintForMarket>;
  // True when this query runs under a geo-widening fallback pass — recorded on
  // the evidence so the confirmation UI can flag a widened (nearby-area) basis.
  widened?: boolean;
}): Promise<{ rates: number[]; evidence: MarketRateEvidence; confidence: MarketRateConfidence | null; noResultsError: string | null }> {
  const geoConstraint = args.geoConstraintOverride ?? geoConstraintForMarket(args.community);
  const params: Record<string, string> = {
    engine: "airbnb",
    q: args.query,
    check_in_date: args.checkIn,
    check_out_date: args.checkOut,
    adults: "2",
    bedrooms: String(args.bedrooms),
    type_of_place: "entire_home",
    currency: "USD",
    api_key: args.apiKey,
  };
  Object.assign(params, geoConstraint.params);
  const response = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(params).toString()}`);
  if (!response.ok) throw new Error(`SearchAPI Airbnb HTTP ${response.status}`);
  const data = await response.json() as any;
  const evidence: MarketRateEvidence = {
    searchedAt: new Date().toISOString(),
    query: args.query,
    checkIn: args.checkIn,
    checkOut: args.checkOut,
    nights: args.nights,
    requestedBedrooms: args.bedrooms,
    totalCandidates: Array.isArray(data?.properties) ? data.properties.length : 0,
    acceptedCandidates: 0,
    rejectedCandidates: 0,
    acceptedExactBedroomCandidates: 0,
    acceptedUnknownBedroomCandidates: 0,
    acceptedCommunityMatchedCandidates: 0,
    acceptedGeoVerifiedCandidates: 0,
    acceptedPreview: [],
    rejectedPreview: [],
    rejectCounts: {},
    searchContract: Object.fromEntries(
      Object.entries(params)
        .filter(([key]) => key !== "api_key")
        .map(([key, value]) => [key, String(value)]),
    ),
    geoConstraint: {
      kind: geoConstraint.kind,
      description: geoConstraint.description,
      radiusMiles: geoConstraintRadiusMiles(geoConstraint.params),
      widened: !!args.widened,
    },
  };
  if (data?.error) {
    const message = `SearchAPI Airbnb: ${data.error}`;
    if (isSearchApiAirbnbNoResultsError(message)) {
      return { rates: [], evidence, confidence: null, noResultsError: message };
    }
    throw new Error(message);
  }
  const rates: number[] = [];
  for (const [index, candidate] of (Array.isArray(data?.properties) ? data.properties : []).entries()) {
    const parsedBedrooms = parsedListingBedrooms(candidate);
    const communityMatched = listingTextMatchesCommunity(candidate, args.community, args.query);
    const geoMatched = candidateGeoMatch(candidate, geoConstraint.params);
    const baseEvidence = {
      page: 1,
      position: index + 1,
      title: listingTitle(candidate),
      url: listingUrl(candidate),
      bedrooms: parsedBedrooms,
      communityMatched,
      geoMatched,
    };
    if (geoMatched === false) {
      evidence.rejectedCandidates += 1;
      evidence.rejectCounts.geography = (evidence.rejectCounts.geography || 0) + 1;
      previewPush(evidence.rejectedPreview, { ...baseEvidence, nightly: null, accepted: false, reason: "outside market bounds" });
      continue;
    }
    if (!listingMatchesBedrooms(candidate, args.bedrooms)) {
      evidence.rejectedCandidates += 1;
      evidence.rejectCounts.bedrooms = (evidence.rejectCounts.bedrooms || 0) + 1;
      previewPush(evidence.rejectedPreview, { ...baseEvidence, nightly: null, accepted: false, reason: "bedroom mismatch" });
      continue;
    }
    const nightly = nightlyRateFromListing(candidate, args.nights);
    if (nightly == null || nightly < 50 || nightly > 3000) {
      evidence.rejectedCandidates += 1;
      const reason = nightly == null ? "missing nightly rate" : "nightly outlier";
      evidence.rejectCounts[reason] = (evidence.rejectCounts[reason] || 0) + 1;
      previewPush(evidence.rejectedPreview, { ...baseEvidence, nightly, accepted: false, reason });
      continue;
    }
    rates.push(nightly);
    evidence.acceptedCandidates += 1;
    if (parsedBedrooms === args.bedrooms) evidence.acceptedExactBedroomCandidates += 1;
    else if (parsedBedrooms == null) evidence.acceptedUnknownBedroomCandidates += 1;
    if (communityMatched) evidence.acceptedCommunityMatchedCandidates += 1;
    if (geoMatched === true) evidence.acceptedGeoVerifiedCandidates += 1;
    previewPush(evidence.acceptedPreview, { ...baseEvidence, nightly, accepted: true, reason: "accepted by existing filters" });
  }
  const basis = marketPricingBasis(rates);
  return {
    rates,
    evidence,
    confidence: rates.length > 0
      ? scoreMarketRateConfidence({
        evidence,
        basis,
      })
      : null,
    noResultsError: null,
  };
}

export async function fetchAirbnbMedianNightly(args: {
  community: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  searchName?: string;
  avoidNightlyBasis?: number | null;
  // AUTO-CURATION: the listing's own clean query + geocoded center, supplied when
  // the community is NOT a hand-tuned BUY_IN_MARKETS key. When present it scopes
  // the scan to a center-radius box around the listing (primary + widened tiers)
  // and leads the query set with the clean searchName. Ignored for registry
  // markets — those keep their curated bounds verbatim.
  derived?: DerivedMarketGeo;
}): Promise<{ medianNightly: number | null; sampleCount: number; notes: string[]; evidence?: MarketRateEvidence; confidence?: MarketRateConfidence }> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) throw new Error("SEARCHAPI_API_KEY not configured");
  const nights = nightsBetween(args.checkIn, args.checkOut);
  // Never let a derived override displace a curated registry market.
  const derived = args.derived && !BUY_IN_MARKETS[args.community] ? args.derived : undefined;
  const primaryQueries = derived
    ? Array.from(new Set([derived.searchName, ...curatedAirbnbSearchQueries(args.community, args.searchName)]))
    : curatedAirbnbSearchQueries(args.community, args.searchName);
  const notes: string[] = [];
  let lastNoResults: string | null = null;

  // Ordered search passes. Pass 0 uses the PRIMARY constraint (curated bounds →
  // center-radius → none) and the curated query list — identical to the previous
  // behavior, returning on the first query with samples (one SearchAPI request for
  // healthy markets). Passes 1+ are geographic-widening FALLBACKS that run ONLY
  // after every primary query came back with zero usable samples — the exact
  // condition that used to hard-fail the whole property refresh for thin
  // in-footprint markets. Each widened pass keeps a center-radius box and adds
  // city-level query anchors. Live SearchAPI scans throughout; no static fallback.
  type SearchPass = { widened: boolean; queries: string[]; geoConstraintOverride?: ReturnType<typeof geoConstraintForMarket> };
  // AUTO-CURATION: a non-registry derived market boxes pass 0 around the listing's
  // own coordinates (registry markets keep their primary curated bounds → the
  // override stays undefined and behavior is byte-identical to before).
  const primaryGeoOverride = derived
    ? centerRadiusConstraintFromCoords(derived.lat, derived.lng, 0.02, "auto-curated center-radius box (derived from the listing's own address)")
    : undefined;
  // The listing's own "City, State" anchor — used at the widened tiers AND as the
  // broad fallback query set below, independent of the geo-widening kill switch.
  const derivedCityAnchor = derived?.city
    ? [derived.state ? `${derived.city}, ${derived.state}` : derived.city]
    : [];
  const passes: SearchPass[] = [{ widened: false, queries: primaryQueries, geoConstraintOverride: primaryGeoOverride }];
  if (marketRateGeoWideningEnabled()) {
    // City anchors FIRST at the widened tiers: a city-level query ("Bonita Springs,
    // FL") is what actually surfaces a healthy nearby-comp set, whereas the tight
    // resort-name query at a wider box tends to return 0–2 listings. Because we only
    // escalate on rates.length===0 (NOT on red confidence — that would break the
    // single-request guarantee for legitimately-thin markets like the Poipu test),
    // a thin 1–2 sample resort-name hit would short-circuit at red and abort before
    // the city anchor's yellow-clearing sample. Trying the city anchor first avoids
    // that and uses fewer requests. For a derived market the anchor is the listing's
    // own "City, State" and the wider boxes are centered on its coordinates.
    const widenedQueries = derived
      ? Array.from(new Set([...derivedCityAnchor, ...primaryQueries]))
      : Array.from(new Set([...cityAnchorQueriesForMarket(args.community), ...primaryQueries]));
    for (const halfDeg of MARKET_RATE_WIDENING_HALF_DEGREES) {
      const override = derived
        ? centerRadiusConstraintFromCoords(derived.lat, derived.lng, halfDeg, `widened ~${Math.round(halfDeg * 111)}km center-radius box (auto-curated, derived from the listing's own address)`)
        : centerRadiusGeoConstraint(args.community, halfDeg);
      if (override) passes.push({ widened: true, queries: widenedQueries, geoConstraintOverride: override });
    }
  }
  // AUTO-CURATION safety net: a derived market ALWAYS keeps a broad escape hatch.
  // If the tight + widened boxes all returned zero comps (a genuinely thin area,
  // OR the MARKET_RATE_GEO_WIDENING kill switch is off so no widened tiers ran),
  // fall back to the un-boxed state-wide search the listing had BEFORE auto-
  // curation instead of hard-failing to the static table / throwing. Runs only
  // after every geo-boxed pass came back empty (same rates.length===0 escalation),
  // so a healthy derived market still makes a single request and is unaffected.
  if (derived) {
    passes.push({
      widened: false,
      queries: Array.from(new Set([...derivedCityAnchor, ...primaryQueries])),
      geoConstraintOverride: { kind: "none", params: {}, description: "broad state-wide fallback (auto-curated geo boxes found no comps)" },
    });
  }

  for (const pass of passes) {
    for (const query of pass.queries) {
      const { rates, evidence, confidence, noResultsError } = await fetchAirbnbMedianNightlyForQuery({
        community: args.community,
        bedrooms: args.bedrooms,
        checkIn: args.checkIn,
        checkOut: args.checkOut,
        query,
        apiKey,
        nights,
        geoConstraintOverride: pass.geoConstraintOverride,
        widened: pass.widened,
      });
      if (noResultsError) {
        lastNoResults = noResultsError;
        notes.push(`${noResultsError} (q="${query}"${pass.widened ? `; ${evidence.geoConstraint.description}` : ""})`);
        continue;
      }
      if (rates.length > 0) {
        const basis = marketPricingBasis(rates, args.avoidNightlyBasis);
        const widenNote = pass.widened
          ? ` Geo-widened: the resort footprint returned no priced exact-${args.bedrooms}BR comps, so this basis is from nearby same-area Airbnb inventory (${evidence.geoConstraint.description}).`
          : "";
        return {
          medianNightly: basis.basis,
          sampleCount: rates.length,
          evidence,
          confidence: confidence ?? undefined,
          notes: [
            `SearchAPI Airbnb returned ${rates.length} usable exact-${args.bedrooms}BR all-in checkout sample(s) for q="${query}"; ${marketPricingBasisNotes(basis)}; confidence ${confidence?.score ?? 0}%.${widenNote}`,
          ],
        };
      }
      notes.push(`q="${query}" returned 0 usable exact-${args.bedrooms}BR priced samples${pass.widened ? ` (${evidence.geoConstraint.description})` : ""}`);
    }
  }

  if (lastNoResults) {
    notes.push("no static fallback is allowed for market-rate refreshes.");
  }
  return { medianNightly: null, sampleCount: 0, notes };
}

function monthStart(base: Date, offset: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
}

function randomIntInclusive(min: number, max: number, rng: () => number): number {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

function demandRank(demandClass: HybridDemandClass): number {
  switch (demandClass) {
    case "ultra": return 3;
    case "peak": return 2;
    case "high": return 1;
    case "standard": return 0;
  }
}

function legacySeasonForDemandClass(demandClass: HybridDemandClass): LegacySeason {
  if (demandClass === "standard") return "LOW";
  if (demandClass === "high") return "HIGH";
  return "HOLIDAY";
}

function demandClassMatchesLegacySeason(demandClass: HybridDemandClass, season: LegacySeason): boolean {
  return legacySeasonForDemandClass(demandClass) === season;
}

export function extrapolateYearTwoMarketRate(priorBasis: number): number {
  if (!Number.isFinite(priorBasis) || priorBasis <= 0) return 0;
  return Math.round(priorBasis * (1 + YEAR_TWO_MARKET_RATE_GROWTH));
}

export function hybridPricingWindowForMonth(
  asOf: Date,
  monthOffset: number,
  stayNights = HYBRID_PRICING_CONFIG.scanSettings.defaultStayNights,
  rng: () => number = Math.random,
): { yearMonth: string; checkIn: string; checkOut: string } {
  const start = monthStart(asOf, monthOffset);
  const monthEnd = monthStart(asOf, monthOffset + 1);
  const todayUtc = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const earliestCurrentMonthCheckIn = addDays(todayUtc, 2);
  const firstEligibleDate = monthOffset === 0 && start <= earliestCurrentMonthCheckIn
    ? earliestCurrentMonthCheckIn
    : start;
  const latestCheckInDate = addDays(monthEnd, -stayNights);
  const firstEligibleMs = firstEligibleDate.getTime();
  const latestCheckInMs = latestCheckInDate.getTime();
  const spanDays = Math.max(0, Math.floor((latestCheckInMs - firstEligibleMs) / MS_PER_DAY));
  const offset = randomIntInclusive(0, spanDays, rng);
  const checkInDate = addDays(firstEligibleDate, offset);
  const checkIn = dateOnly(checkInDate);
  return {
    yearMonth: dateOnly(start).slice(0, 7),
    checkIn,
    checkOut: dateOnly(addDays(checkInDate, stayNights)),
  };
}

export function hybridPricingWindowForSeason(
  asOf: Date,
  season: LegacySeason,
  stayNights = HYBRID_PRICING_CONFIG.scanSettings.defaultStayNights,
  rng: () => number = Math.random,
): { season: LegacySeason; yearMonth: string; checkIn: string; checkOut: string } {
  const todayUtc = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const firstEligibleDate = addDays(todayUtc, 2);
  const horizonEnd = monthStart(asOf, HYBRID_PRICING_CONFIG.scanSettings.horizonMonths);
  const latestCheckInDate = addDays(horizonEnd, -stayNights);
  const totalDays = Math.max(0, Math.floor((latestCheckInDate.getTime() - firstEligibleDate.getTime()) / MS_PER_DAY));
  const candidates: Date[] = [];
  for (let offset = 0; offset <= totalDays; offset += 1) {
    const date = addDays(firstEligibleDate, offset);
    const tier = resolveSeasonTier(dateOnly(date));
    if (demandClassMatchesLegacySeason(tier.demandClass, season)) candidates.push(date);
  }
  if (candidates.length === 0) {
    throw new Error(`No eligible ${season} 7-night Airbnb pricing window exists in the configured horizon`);
  }
  const checkInDate = candidates[randomIntInclusive(0, candidates.length - 1, rng)] ?? candidates[0];
  const checkIn = dateOnly(checkInDate);
  return {
    season,
    yearMonth: checkIn.slice(0, 7),
    checkIn,
    checkOut: dateOnly(addDays(checkInDate, stayNights)),
  };
}

function monthScanRng(propertyId: number, bedrooms: number, monthOffset: number): () => number {
  let state = ((propertyId * 1_000_003) ^ (bedrooms * 97_531) ^ (monthOffset * 2_654_435_761)) >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function propertyBedroomCounts(config: PropertyUnitConfig): number[] {
  return Array.from(new Set(config.units.map((u) => u.bedrooms))).sort((a, b) => a - b);
}

function representativeMonthlyRate(
  monthlyRates: Record<string, HybridMonthlyRate>,
  season: LegacySeason,
): HybridMonthlyRate | null {
  return Object.values(monthlyRates).find(
    (rate) => !rate.blackout && legacySeasonForDemandClass(rate.demandClass) === season,
  ) ?? null;
}

function seasonalBasisSummary(
  seasonalBases: Record<LegacySeason, number[]>,
): { lowBasis: number | null; highBasis: number | null; holidayBasis: number | null; missing: LegacySeason[] } {
  const missing: LegacySeason[] = [];
  const lowBasis = marketPricingBasis(seasonalBases.LOW).basis;
  const highBasis = marketPricingBasis(seasonalBases.HIGH).basis;
  const holidayBasis = marketPricingBasis(seasonalBases.HOLIDAY).basis;
  if (lowBasis == null) missing.push("LOW");
  if (highBasis == null) missing.push("HIGH");
  if (holidayBasis == null) missing.push("HOLIDAY");
  return { lowBasis, highBasis, holidayBasis, missing };
}

function summarizeMarketRateConfidence(confidences: MarketRateConfidence[]): MarketRateConfidence | null {
  if (confidences.length === 0) return null;
  const score = Math.round(confidences.reduce((sum, confidence) => sum + confidence.score, 0) / confidences.length);
  const minScore = Math.min(...confidences.map((confidence) => confidence.score));
  const level: MarketRateConfidence["level"] = minScore < 75 ? "red" : score >= 90 ? "green" : "yellow";
  const acceptedCandidates = confidences.reduce((sum, confidence) => sum + confidence.acceptedCandidates, 0);
  const rejectedCandidates = confidences.reduce((sum, confidence) => sum + confidence.rejectedCandidates, 0);
  const exactBedroomCandidates = confidences.reduce((sum, confidence) => sum + (confidence.exactBedroomCandidates || 0), 0);
  const unknownBedroomCandidates = confidences.reduce((sum, confidence) => sum + (confidence.unknownBedroomCandidates || 0), 0);
  const communityMatchedCandidates = confidences.reduce((sum, confidence) => sum + (confidence.communityMatchedCandidates || 0), 0);
  const geoVerifiedCandidates = confidences.reduce((sum, confidence) => sum + (confidence.geoVerifiedCandidates || 0), 0);
  return {
    score,
    level,
    summary: `${score}% ${level} confidence across ${confidences.length} monthly scan${confidences.length === 1 ? "" : "s"}`,
    reasons: [
      `${acceptedCandidates} accepted candidates across ${confidences.length} month${confidences.length === 1 ? "" : "s"} (${exactBedroomCandidates} exact-bedroom, ${unknownBedroomCandidates} unparsed bedroom)`,
      `${geoVerifiedCandidates} coordinate-verified and ${communityMatchedCandidates} community-text matched accepted candidates`,
      `${rejectedCandidates} rejected by existing filters`,
      `rate basis is p${MARKET_PRICING_PERCENTILE}`,
    ],
    sampleCount: acceptedCandidates,
    acceptedCandidates,
    rejectedCandidates,
    exactBedroomCandidates,
    unknownBedroomCandidates,
    communityMatchedCandidates,
    geoVerifiedCandidates,
    percentileBasis: MARKET_PRICING_PERCENTILE,
  };
}

export async function refreshHybridPricingForTarget(args: {
  propertyId: number;
  propertyName: string;
  community: string;
  bedroomCounts: number[];
  unitCount: number;
  triggerType: HybridTriggerType;
  notes?: string;
  searchName?: string;
  // AUTO-CURATION: the listing's own clean query + geocoded center, used when
  // the community is NOT a curated BUY_IN_MARKETS key so the scan is geo-scoped
  // rather than a state-wide raw-string search. Ignored for registry markets.
  derivedGeo?: DerivedMarketGeo;
  resortConfident?: boolean;
  bedroomSplitInferred?: boolean;
  // Expected location for the recipe's community-confirmation label check.
  // Defaults to the curated market's registry location; the draft path passes
  // the draft's own city/state so non-registry listings are checked too.
  expectedCity?: string;
  expectedState?: string;
  asOf?: Date;
  onMonthScanned?: (event: HybridMonthScannedEvent) => void | Promise<void>;
  onMonthBlackout?: (event: HybridMonthBlackoutEvent) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
}): Promise<{ propertyId: number; rows: any[]; logs: any[]; blackouts: HybridBlackoutWindow[] }> {
  const { storage } = await import("./storage");
  const asOf = args.asOf ?? new Date();
  // A derived geo only applies to non-registry communities (registry markets are
  // already curated and must keep their hand-tuned bounds/queries verbatim).
  const derivedGeo = args.derivedGeo && !BUY_IN_MARKETS[args.community] ? args.derivedGeo : undefined;
  const searchQueries = derivedGeo
    ? Array.from(new Set([derivedGeo.searchName, ...curatedAirbnbSearchQueries(args.community, args.searchName)]))
    : curatedAirbnbSearchQueries(args.community, args.searchName);
  const searchName = derivedGeo ? derivedGeo.searchName : (searchQueries[0] || args.community);
  const pricingRegion = getCommunityRegion(args.community);
  const rows: any[] = [];
  const logs: any[] = [];
  // Windows that had no confident exact-bedroom comp this run, accumulated
  // across all bedroom counts. Returned to the caller so the Guesty push can
  // close them on the calendar (reversible — reopened when a later scan finds
  // comps for that month).
  const bedroomCounts = Array.from(new Set(args.bedroomCounts))
    .filter((bedrooms) => Number.isFinite(bedrooms) && bedrooms > 0)
    .sort((a, b) => a - b);
  const marketLocation = BUY_IN_MARKET_LOCATIONS[args.community];
  const pricingRecipe: MarketRatePricingRecipe = {
    community: args.community,
    searchName,
    source: "searchapi-airbnb",
    percentileBasis: MARKET_PRICING_PERCENTILE,
    unitCount: args.unitCount,
    searchedBedrooms: bedroomCounts,
    stayNights: HYBRID_PRICING_CONFIG.scanSettings.defaultStayNights,
    querySet: searchQueries,
    resortConfident: args.resortConfident ?? true,
    bedroomSplitInferred: args.bedroomSplitInferred ?? false,
    communityConfirmation: confirmResearchCommunity({
      community: args.community,
      searchLabel: searchName,
      expectedCity: args.expectedCity ?? marketLocation?.city,
      expectedState: args.expectedState ?? marketLocation?.state,
      curated: !!BUY_IN_MARKETS[args.community],
    }),
  };

  for (const bedrooms of bedroomCounts) {
    if (await args.shouldCancel?.()) throw hybridPricingCancelledError();
    const previous = (await storage.getPropertyMarketRates(args.propertyId)).find((r) => r.bedrooms === bedrooms);
    const monthlyRates: Record<string, HybridMonthlyRate> = {};
    const seasonalMedians: Record<LegacySeason, number[]> = { LOW: [], HIGH: [], HOLIDAY: [] };
    const monthlyConfidences: MarketRateConfidence[] = [];
    let totalSamples = 0;
    const horizonMonths = HYBRID_PRICING_CONFIG.scanSettings.horizonMonths;
    const stayNights = HYBRID_PRICING_CONFIG.scanSettings.defaultStayNights;

    const staticMarketRateBasis = (yearMonth: string) => {
      const season = getSeasonForMonth(yearMonth, pricingRegion);
      return getBuyInRate(
        args.community,
        bedrooms,
        args.propertyId > 0 ? args.propertyId : undefined,
        season,
        yearMonth,
      );
    };

    const recordPricedMonth = async (params: {
      monthOffset: number;
      window: { yearMonth: string; checkIn: string; checkOut: string };
      basis: number;
      sampleCount: number;
      channelCount: number;
      confidence?: MarketRateConfidence;
      evidence?: MarketRateEvidence;
      notes: string[];
      logKind: "scan" | "extrapolation" | "static-fallback";
    }) => {
      const { monthOffset, window, basis, sampleCount, channelCount, confidence, evidence, notes, logKind } = params;
      const season = getSeasonForMonth(window.yearMonth, pricingRegion);
      const tier = resolveSeasonTier(window.checkIn);
      if (confidence) monthlyConfidences.push(confidence);
      totalSamples += sampleCount;
      seasonalMedians[legacySeasonForDemandClass(tier.demandClass)].push(basis);
      monthlyRates[window.yearMonth] = {
        medianNightly: basis,
        season,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
        channelCount,
        sampleCount,
        demandClass: tier.demandClass,
        seasonTierId: tier.id,
        seasonTierLabel: tier.label,
        confidence,
        evidence,
        channels: { airbnb: channelCount > 0 ? basis : null, vrbo: null, booking: null, pm: null },
        hybrid: {
          baseAirbnbMedian: basis,
          finalRate: basis,
          layers: [],
          notes: [
            ...notes,
            args.unitCount > 1
              ? `Property has ${args.unitCount} configured unit slot(s); Guesty combo pushes sum the matching unit bases.`
              : "Single-unit pricing basis.",
          ],
        },
      };
      const logLabel = logKind === "scan"
        ? "monthly scan ok"
        : logKind === "extrapolation"
          ? "monthly extrapolation ok"
          : "monthly static fallback ok";
      console.info(`[hybrid-pricing] ${logLabel}`, JSON.stringify({
        propertyId: args.propertyId,
        propertyName: args.propertyName,
        community: args.community,
        bedrooms,
        monthOffset,
        horizonMonths,
        yearMonth: window.yearMonth,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
        medianNightly: basis,
        sampleCount,
        logKind,
        confidence,
      }));
      await args.onMonthScanned?.({
        propertyId: args.propertyId,
        bedrooms,
        monthOffset,
        horizonMonths,
        yearMonth: window.yearMonth,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
        medianNightly: basis,
        sampleCount,
        confidence,
        pricingRecipe,
      });
    };

    for (let monthOffset = 0; monthOffset < horizonMonths; monthOffset += 1) {
      if (await args.shouldCancel?.()) throw hybridPricingCancelledError();
      const window = hybridPricingWindowForMonth(
        asOf,
        monthOffset,
        stayNights,
        monthScanRng(args.propertyId, bedrooms, monthOffset),
      );

      if (monthOffset >= AIRBNB_MARKET_RATE_SEARCH_MONTHS) {
        const priorYearMonth = dateOnly(monthStart(asOf, monthOffset - AIRBNB_MARKET_RATE_SEARCH_MONTHS)).slice(0, 7);
        const priorEntry = monthlyRates[priorYearMonth];
        const basis = priorEntry && priorEntry.medianNightly > 0
          ? extrapolateYearTwoMarketRate(priorEntry.medianNightly)
          : staticMarketRateBasis(window.yearMonth);
        const extrapolationNotes = priorEntry && priorEntry.medianNightly > 0
          ? [
            `Year-2 extrapolation: ${priorYearMonth} SearchAPI P${MARKET_PRICING_PERCENTILE} basis $${priorEntry.medianNightly} + ${Math.round(YEAR_TWO_MARKET_RATE_GROWTH * 100)}% → $${basis} (Airbnb dated search is unreliable beyond ~${AIRBNB_MARKET_RATE_SEARCH_MONTHS} months).`,
            `Representative ${stayNights}-night window ${window.checkIn} to ${window.checkOut}.`,
          ]
          : [
            `Year-2 month with no prior-year SearchAPI basis for ${priorYearMonth}; using static seasonal buy-in $${basis}.`,
            `Representative ${stayNights}-night window ${window.checkIn} to ${window.checkOut}.`,
          ];
        await recordPricedMonth({
          monthOffset,
          window,
          basis,
          sampleCount: priorEntry?.sampleCount ?? 0,
          channelCount: priorEntry && priorEntry.medianNightly > 0 ? 0 : 0,
          confidence: priorEntry?.confidence,
          notes: extrapolationNotes,
          logKind: priorEntry && priorEntry.medianNightly > 0 ? "extrapolation" : "static-fallback",
        });
        await sleep(HYBRID_PRICING_CONFIG.scanSettings.rateLimitMs);
        continue;
      }

      const airbnb = await fetchAirbnbMedianNightly({
        community: args.community,
        bedrooms,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
        searchName,
        derived: derivedGeo,
      });
      if (await args.shouldCancel?.()) throw hybridPricingCancelledError();
      if (!window.checkIn) {
        await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
        throw new Error(
          `No eligible 7-night Airbnb pricing window exists for ${window.yearMonth || `month offset ${monthOffset}`} (${searchName})`,
        );
      }

      let basis = airbnb?.medianNightly ?? null;
      let logKind: "scan" | "static-fallback" = "scan";
      const scanNotes = [...(airbnb?.notes ?? [])];
      // Gross the SearchAPI median up by the regional lodging tax so the stored
      // buy-in equals the ACTUAL guest checkout total. Airbnb's
      // extracted_total_price (the median's basis) already includes cleaning +
      // service fees but NOT occupancy tax, which Airbnb adds at checkout — so
      // without this the buy-in understates real cost. Applied ONLY to a real
      // SearchAPI median (not the static thin-comp fallback, which is a separate
      // rent-only backstop). Kill-switch: MARKET_RATE_LODGING_TAX_DISABLED=1.
      if (basis != null && basis > 0 && process.env.MARKET_RATE_LODGING_TAX_DISABLED !== "1") {
        const preTax = basis;
        basis = applyLodgingTaxGrossUp(basis, args.community);
        if (basis > preTax) {
          scanNotes.push(`Grossed up $${preTax} → $${basis} for ${Number((LODGING_TAX_PCT[getCommunityRegion(args.community)] * 100).toFixed(1))}% ${getCommunityRegion(args.community)} lodging tax (all-in checkout total).`);
        }
      }
      if (basis == null || basis <= 0) {
        basis = staticMarketRateBasis(window.yearMonth);
        logKind = "static-fallback";
        scanNotes.push(
          basis > 0
            ? `No usable exact-${bedrooms}BR SearchAPI comps for ${window.checkIn} to ${window.checkOut}; priced from static seasonal buy-in $${basis}.`
            : `No usable exact-${bedrooms}BR SearchAPI comps and no static buy-in table entry for ${window.yearMonth}.`,
        );
      } else if (!airbnb?.confidence || airbnb.confidence.level === "red") {
        scanNotes.push(
          `Stored SearchAPI P${MARKET_PRICING_PERCENTILE} basis despite ${airbnb?.confidence?.summary ?? "red"} confidence — market-rate refresh no longer blackouts calendar months.`,
        );
      } else {
        scanNotes.push(
          `Stored SearchAPI ${MARKET_PRICING_PERCENTILE}th percentile basis (median, grossed for lodging tax; no hybrid markup layers). Random ${stayNights}-night sample ${window.checkIn} to ${window.checkOut} in ${window.yearMonth}.`,
        );
      }

      if (!(basis > 0)) {
        await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
        throw new Error(
          `No market-rate basis for ${window.yearMonth} (${searchName}, ${bedrooms}BR): SearchAPI returned no comps and static buy-in table has no entry.`,
        );
      }

      await recordPricedMonth({
        monthOffset,
        window,
        basis,
        sampleCount: airbnb?.sampleCount ?? 0,
        channelCount: airbnb?.medianNightly != null && airbnb.medianNightly > 0 ? 1 : 0,
        confidence: airbnb?.confidence,
        evidence: airbnb?.evidence,
        notes: scanNotes,
        logKind,
      });
      await sleep(HYBRID_PRICING_CONFIG.scanSettings.rateLimitMs);
    }

    const pricedValues = Object.values(monthlyRates).map((rate) => rate.medianNightly).filter((v) => v > 0);
    const { lowBasis, highBasis, holidayBasis } = seasonalBasisSummary(seasonalMedians);
    // A demand tier with no priced months (all blacked out) is no longer fatal.
    // Fall back to the overall priced basis so the legacy seasonal columns stay
    // sane; when EVERY month is blacked out, store 0 (setLivePropertyMarketRates
    // skips <=0, so getBuyInRate falls through to the static table — no zero
    // leaks into buy-in cost).
    const overallBasis = marketPricingBasis(pricedValues).basis;
    const lowB = lowBasis ?? overallBasis ?? 0;
    const highB = highBasis ?? overallBasis ?? lowB;
    const holidayB = holidayBasis ?? overallBasis ?? highB;
    const lowNightly = pricedValues.length ? Math.min(...pricedValues) : 0;
    const highNightly = pricedValues.length ? Math.max(...pricedValues) : 0;
    const lowRate = representativeMonthlyRate(monthlyRates, "LOW");
    const highRate = representativeMonthlyRate(monthlyRates, "HIGH");
    const holidayRate = representativeMonthlyRate(monthlyRates, "HOLIDAY");
    const scannedMonths = Object.keys(monthlyRates).sort();
    const confidenceSummary = summarizeMarketRateConfidence(monthlyConfidences);
    if (scannedMonths.length !== horizonMonths) {
      await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
      throw new Error(
        `SearchAPI Airbnb monthly scan for ${searchName} stored ${scannedMonths.length}/${horizonMonths} months; expected one ${MARKET_PRICING_PERCENTILE}th percentile basis per calendar month.`,
      );
    }
    const pricedCount = pricedValues.length;
    const row = await storage.upsertPropertyMarketRate({
      propertyId: args.propertyId,
      bedrooms,
      medianNightly: String(lowB),
      medianNightlyHigh: String(highB),
      medianNightlyHoliday: String(holidayB),
      monthlyRates,
      lowNightly: String(lowNightly),
      highNightly: String(highNightly),
      sampleCount: totalSamples,
      source: "airbnb",
    });
    rows.push(row);
    logs.push(await storage.createPricingUpdateLog({
      propertyId: args.propertyId,
      propertyName: args.propertyName,
      bedrooms,
      triggerType: args.triggerType,
      oldRate: previous?.medianNightly ?? null,
      newRate: String(lowB),
      status: "ok",
      notes: [
        args.notes || `SearchAPI Airbnb monthly ${MARKET_PRICING_PERCENTILE}th percentile bases saved without hybrid markup layers; thin months fall back to static buy-in instead of calendar blackouts.`,
        `Priced ${pricedCount}/${scannedMonths.length} calendar months (${scannedMonths[0]} through ${scannedMonths[scannedMonths.length - 1]}).`,
        confidenceSummary ? `Confidence: ${confidenceSummary.summary}.` : "Confidence: not enough evidence to score.",
      ].join(" "),
      layersJson: [{
        type: "market-rate-confidence",
        pricingRecipe,
        confidenceSummary,
      }],
      calendarJson: monthlyRates,
    }));
    console.info("[hybrid-pricing] applied raw Airbnb monthly percentile bases", JSON.stringify({
      propertyId: args.propertyId,
      propertyName: args.propertyName,
      community: args.community,
      bedrooms,
      triggerType: args.triggerType,
      source: "airbnb",
      searchName,
      unitCount: args.unitCount,
      pricingRecipe,
      confidenceSummary,
      sampleCount: totalSamples,
      pricedCount,
      low: {
        basis: lowB,
        checkIn: lowRate?.checkIn ?? null,
        checkOut: lowRate?.checkOut ?? null,
        baseAirbnbMedian: lowRate?.hybrid?.baseAirbnbMedian ?? null,
        finalRate: lowRate?.hybrid?.finalRate ?? null,
      },
      high: {
        basis: highB,
        checkIn: highRate?.checkIn ?? null,
        checkOut: highRate?.checkOut ?? null,
        baseAirbnbMedian: highRate?.hybrid?.baseAirbnbMedian ?? null,
        finalRate: highRate?.hybrid?.finalRate ?? null,
      },
      holiday: {
        basis: holidayB,
        checkIn: holidayRate?.checkIn ?? null,
        checkOut: holidayRate?.checkOut ?? null,
        baseAirbnbMedian: holidayRate?.hybrid?.baseAirbnbMedian ?? null,
        finalRate: holidayRate?.hybrid?.finalRate ?? null,
      },
      lowNightly,
      highNightly,
      monthsScanned: scannedMonths.length,
      scannedMonths,
      monthlyPreview: summarizeMonthlyHybridRates(monthlyRates),
      layers: [],
    }));
  }
  return { propertyId: args.propertyId, rows, logs, blackouts: [] };
}

export async function refreshHybridPricingForProperty(args: {
  propertyId: number;
  triggerType: HybridTriggerType;
  notes?: string;
  asOf?: Date;
  onMonthScanned?: (event: HybridMonthScannedEvent) => void | Promise<void>;
  onMonthBlackout?: (event: HybridMonthBlackoutEvent) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
}): Promise<{ propertyId: number; rows: any[]; logs: any[]; blackouts: HybridBlackoutWindow[] }> {
  const config = PROPERTY_UNIT_CONFIGS[args.propertyId];
  if (!config) throw new Error(`Property ${args.propertyId} is not configured for hybrid pricing`);
  return refreshHybridPricingForTarget({
    propertyId: args.propertyId,
    propertyName: `${config.community} property ${args.propertyId}`,
    community: config.community,
    bedroomCounts: propertyBedroomCounts(config),
    unitCount: config.units.length,
    triggerType: args.triggerType,
    notes: args.notes,
    asOf: args.asOf,
    onMonthScanned: args.onMonthScanned,
    onMonthBlackout: args.onMonthBlackout,
    shouldCancel: args.shouldCancel,
  });
}

export async function runHybridPricingForAllProperties(triggerType: HybridTriggerType = "Weekly Automated Scan") {
  const ids = Object.keys(PROPERTY_UNIT_CONFIGS).map(Number).sort((a, b) => a - b);
  const results: Array<{ id: number; ok: boolean; rows?: number; error?: string }> = [];
  for (const id of ids) {
    try {
      const result = await refreshHybridPricingForProperty({ propertyId: id, triggerType });
      results.push({ id, ok: true, rows: result.rows.length });
    } catch (e: any) {
      results.push({ id, ok: false, error: e?.message ?? String(e) });
    }
  }
  return { total: results.length, succeeded: results.filter((r) => r.ok).length, results };
}
