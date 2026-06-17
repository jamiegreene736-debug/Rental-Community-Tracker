import fs from "node:fs";
import path from "node:path";

import { BUY_IN_MARKET_BOUNDS, BUY_IN_MARKET_LOCATIONS, BUY_IN_MARKETS } from "@shared/buy-in-market";
import { getCommunityRegion, getSeasonForMonth } from "@shared/pricing-rates";
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
const MARKET_PRICING_PERCENTILE = 40;

export type MarketRatePricingRecipe = {
  community: string;
  searchName: string;
  source: "searchapi-airbnb";
  percentileBasis: number;
  unitCount: number;
  searchedBedrooms: number[];
  stayNights: number;
  querySet: string[];
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
    return `using raw ${MARKET_PRICING_PERCENTILE}th percentile basis $${stats.basis} (median $${stats.median})${stats.tieAdjusted ? "; adjusted to nearest distinct monthly sample to avoid repeating the prior month" : ""}`;
  }
  return `using raw ${MARKET_PRICING_PERCENTILE}th percentile basis`;
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
}): Promise<{ medianNightly: number | null; sampleCount: number; notes: string[]; evidence?: MarketRateEvidence; confidence?: MarketRateConfidence }> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) throw new Error("SEARCHAPI_API_KEY not configured");
  const nights = nightsBetween(args.checkIn, args.checkOut);
  const primaryQueries = curatedAirbnbSearchQueries(args.community, args.searchName);
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
  const passes: SearchPass[] = [{ widened: false, queries: primaryQueries }];
  if (marketRateGeoWideningEnabled()) {
    // City anchors FIRST at the widened tiers: a city-level query ("Bonita Springs,
    // FL") is what actually surfaces a healthy nearby-comp set, whereas the tight
    // resort-name query at a wider box tends to return 0–2 listings. Because we only
    // escalate on rates.length===0 (NOT on red confidence — that would break the
    // single-request guarantee for legitimately-thin markets like the Poipu test),
    // a thin 1–2 sample resort-name hit would short-circuit at red and abort before
    // the city anchor's yellow-clearing sample. Trying the city anchor first avoids
    // that and uses fewer requests.
    const widenedQueries = Array.from(new Set([...cityAnchorQueriesForMarket(args.community), ...primaryQueries]));
    for (const halfDeg of MARKET_RATE_WIDENING_HALF_DEGREES) {
      const override = centerRadiusGeoConstraint(args.community, halfDeg);
      if (override) passes.push({ widened: true, queries: widenedQueries, geoConstraintOverride: override });
    }
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
  const candidates: Array<{ date: Date; rank: number }> = [];
  for (let offset = 0; offset <= spanDays; offset += 1) {
    const date = addDays(firstEligibleDate, offset);
    candidates.push({ date, rank: demandRank(resolveSeasonTier(dateOnly(date)).demandClass) });
  }
  const bestRank = candidates.reduce((max, candidate) => Math.max(max, candidate.rank), 0);
  const bestCandidates = candidates.filter((candidate) => candidate.rank === bestRank);
  const chosen = bestCandidates[randomIntInclusive(0, bestCandidates.length - 1, rng)] ?? candidates[0];
  const checkInDate = chosen.date;
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
  asOf?: Date;
  onMonthScanned?: (event: HybridMonthScannedEvent) => void | Promise<void>;
  onMonthBlackout?: (event: HybridMonthBlackoutEvent) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
}): Promise<{ propertyId: number; rows: any[]; logs: any[]; blackouts: HybridBlackoutWindow[] }> {
  const { storage } = await import("./storage");
  const asOf = args.asOf ?? new Date();
  const searchQueries = curatedAirbnbSearchQueries(args.community, args.searchName);
  const searchName = searchQueries[0] || args.community;
  const pricingRegion = getCommunityRegion(args.community);
  const rows: any[] = [];
  const logs: any[] = [];
  // Windows that had no confident exact-bedroom comp this run, accumulated
  // across all bedroom counts. Returned to the caller so the Guesty push can
  // close them on the calendar (reversible — reopened when a later scan finds
  // comps for that month).
  const blackouts: HybridBlackoutWindow[] = [];
  const bedroomCounts = Array.from(new Set(args.bedroomCounts))
    .filter((bedrooms) => Number.isFinite(bedrooms) && bedrooms > 0)
    .sort((a, b) => a - b);
  const pricingRecipe: MarketRatePricingRecipe = {
    community: args.community,
    searchName,
    source: "searchapi-airbnb",
    percentileBasis: MARKET_PRICING_PERCENTILE,
    unitCount: args.unitCount,
    searchedBedrooms: bedroomCounts,
    stayNights: HYBRID_PRICING_CONFIG.scanSettings.defaultStayNights,
    querySet: searchQueries,
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

    // Record a blacked-out month (no confident exact-bedroom comp) instead of
    // aborting the whole property. The month is kept in monthlyRates (medianNightly
    // 0 + blackout flag) so the 24-month count stays whole and the Guesty push can
    // tell "intentionally blacked out" from "missing"; the window is queued for a
    // calendar close. The scan then moves on to the next month.
    const recordMonthBlackout = async (params: {
      monthOffset: number;
      window: { yearMonth: string; checkIn: string; checkOut: string };
      reason: string;
      confidence?: MarketRateConfidence;
    }) => {
      const { monthOffset, window, reason, confidence } = params;
      const season = getSeasonForMonth(window.yearMonth, pricingRegion);
      const tier = resolveSeasonTier(window.checkIn);
      monthlyRates[window.yearMonth] = {
        medianNightly: 0,
        blackout: true,
        blackoutReason: reason,
        season,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
        channelCount: 0,
        sampleCount: 0,
        demandClass: tier.demandClass,
        seasonTierId: tier.id,
        seasonTierLabel: tier.label,
        confidence,
        channels: { airbnb: null, vrbo: null, booking: null, pm: null },
        hybrid: { baseAirbnbMedian: 0, finalRate: 0, layers: [], notes: [`Blackout: ${reason}`] },
      };
      blackouts.push({ bedrooms, yearMonth: window.yearMonth, checkIn: window.checkIn, checkOut: window.checkOut, reason });
      console.info("[hybrid-pricing] month blackout", JSON.stringify({
        propertyId: args.propertyId,
        community: args.community,
        bedrooms,
        yearMonth: window.yearMonth,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
        reason,
        confidence,
      }));
      await args.onMonthBlackout?.({
        propertyId: args.propertyId,
        bedrooms,
        monthOffset,
        horizonMonths,
        yearMonth: window.yearMonth,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
        reason,
        confidence,
      });
    };

    for (let monthOffset = 0; monthOffset < horizonMonths; monthOffset += 1) {
      if (await args.shouldCancel?.()) throw hybridPricingCancelledError();
      let airbnb: Awaited<ReturnType<typeof fetchAirbnbMedianNightly>> | null = null;
      let window = { yearMonth: "", checkIn: "", checkOut: "" };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await args.shouldCancel?.()) throw hybridPricingCancelledError();
        window = hybridPricingWindowForMonth(asOf, monthOffset, stayNights);
        const previousYearMonth = monthOffset > 0 ? dateOnly(monthStart(asOf, monthOffset - 1)).slice(0, 7) : null;
        const previousEntry = previousYearMonth ? monthlyRates[previousYearMonth] : null;
        const previousBasis = previousEntry && !previousEntry.blackout ? previousEntry.medianNightly : null;
        airbnb = await fetchAirbnbMedianNightly({
          community: args.community,
          bedrooms,
          checkIn: window.checkIn,
          checkOut: window.checkOut,
          searchName,
          avoidNightlyBasis: previousBasis,
        });
        if (await args.shouldCancel?.()) throw hybridPricingCancelledError();
        if (airbnb.medianNightly != null && (previousBasis == null || airbnb.medianNightly !== previousBasis)) break;
      }
      if (!window.checkIn) {
        await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
        throw new Error(
          `No eligible 7-night Airbnb pricing window exists for ${window.yearMonth || `month offset ${monthOffset}`} (${searchName})`,
        );
      }
      if (!airbnb || airbnb.medianNightly == null) {
        // No usable exact-bedroom comps for this window. Don't abort the whole
        // property — black out this month's window and move to the next month.
        await recordMonthBlackout({
          monthOffset,
          window,
          reason: `no usable exact-${bedrooms}BR comps for ${window.checkIn} to ${window.checkOut}`,
          confidence: airbnb?.confidence,
        });
        await sleep(HYBRID_PRICING_CONFIG.scanSettings.rateLimitMs);
        continue;
      }
      if (!airbnb.confidence || airbnb.confidence.level === "red") {
        // Confidence too low (e.g. exact-bedroom comps missing, as for 3BR in a
        // mostly-1/2BR resort). Black out this window and continue rather than
        // failing the property.
        const summary = airbnb.confidence?.summary ?? "not scored";
        await recordMonthBlackout({
          monthOffset,
          window,
          reason: `no confident exact-${bedrooms}BR comps (${summary})`,
          confidence: airbnb.confidence,
        });
        await sleep(HYBRID_PRICING_CONFIG.scanSettings.rateLimitMs);
        continue;
      }
      // A repeated basis vs the prior priced month is no longer fatal: the
      // retry loop above already tried distinct windows to avoid it, and a
      // confident-but-identical month is still real, sellable inventory — far
      // better to keep it than to abort the property over a cosmetic dupe.
      const basis = airbnb.medianNightly;
      const season = getSeasonForMonth(window.yearMonth, pricingRegion);
      const tier = resolveSeasonTier(window.checkIn);
      if (airbnb.confidence) monthlyConfidences.push(airbnb.confidence);
      totalSamples += airbnb.sampleCount;
      seasonalMedians[legacySeasonForDemandClass(tier.demandClass)].push(basis);
      monthlyRates[window.yearMonth] = {
        medianNightly: basis,
        season,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
        channelCount: 1,
        sampleCount: airbnb.sampleCount,
        demandClass: tier.demandClass,
        seasonTierId: tier.id,
        seasonTierLabel: tier.label,
        confidence: airbnb.confidence,
        evidence: airbnb.evidence,
        channels: { airbnb: basis, vrbo: null, booking: null, pm: null },
        hybrid: {
          baseAirbnbMedian: basis,
          finalRate: basis,
          layers: [],
          notes: [
            ...airbnb.notes,
            `Stored raw SearchAPI ${MARKET_PRICING_PERCENTILE}th percentile basis (no hybrid markup layers). ${window.yearMonth} window ${window.checkIn} to ${window.checkOut}.`,
            args.unitCount > 1
              ? `Property has ${args.unitCount} configured unit slot(s); Guesty combo pushes sum the matching unit bases.`
              : "Single-unit pricing basis.",
          ],
        },
      };
      console.info("[hybrid-pricing] monthly scan ok", JSON.stringify({
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
        sampleCount: airbnb.sampleCount,
        confidence: airbnb.confidence,
        acceptedCandidates: airbnb.evidence?.acceptedCandidates,
        rejectedCandidates: airbnb.evidence?.rejectedCandidates,
        searchQuery: airbnb.evidence?.query,
        calendarSeason: season,
        demandClass: tier.demandClass,
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
        sampleCount: airbnb.sampleCount,
        confidence: airbnb.confidence,
        pricingRecipe,
      });
      await sleep(HYBRID_PRICING_CONFIG.scanSettings.rateLimitMs);
    }

    // Aggregate over PRICED months only — blacked-out months (medianNightly 0)
    // must never pollute the seasonal bases, min/max, or the live buy-in cache.
    const pricedValues = Object.values(monthlyRates).filter((rate) => !rate.blackout).map((rate) => rate.medianNightly);
    const blackoutCount = Object.values(monthlyRates).filter((rate) => rate.blackout).length;
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
    // Every month is now accounted for either as a priced basis or a blackout,
    // so the calendar must still be whole. (Blacked-out months stay in
    // monthlyRates with medianNightly 0 + blackout=true.)
    if (scannedMonths.length !== horizonMonths) {
      await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
      throw new Error(
        `SearchAPI Airbnb monthly scan for ${searchName} stored ${scannedMonths.length}/${horizonMonths} months; expected one ${MARKET_PRICING_PERCENTILE}th percentile basis (or a blackout) per calendar month.`,
      );
    }
    const pricedCount = pricedValues.length;
    const blackoutSuffix = blackoutCount > 0
      ? ` ${blackoutCount} month(s) blacked out (no confident exact-${bedrooms}BR comps); those windows are closed on the Guesty calendar.`
      : "";
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
        args.notes || `SearchAPI Airbnb monthly ${MARKET_PRICING_PERCENTILE}th percentile bases saved without hybrid markup layers; static buy-in fallback is disabled for market-rate refreshes.`,
        `Priced ${pricedCount}/${scannedMonths.length} calendar months (${scannedMonths[0]} through ${scannedMonths[scannedMonths.length - 1]}).${blackoutSuffix}`,
        confidenceSummary ? `Confidence: ${confidenceSummary.summary}.` : "Confidence: not enough evidence to score.",
      ].join(" "),
      layersJson: [{
        type: "market-rate-confidence",
        pricingRecipe,
        confidenceSummary,
        blackoutCount,
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
      blackoutCount,
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
  return { propertyId: args.propertyId, rows, logs, blackouts };
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
