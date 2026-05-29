import fs from "node:fs";
import path from "node:path";

import { BUY_IN_MARKET_BOUNDS, BUY_IN_MARKET_LOCATIONS, BUY_IN_MARKETS } from "@shared/buy-in-market";
import { getCommunityRegion, getSeasonForMonth } from "@shared/pricing-rates";
import { PROPERTY_UNIT_CONFIGS, type PropertyUnitConfig } from "@shared/property-units";
import { extractBedroomsFromListing, fetchAmortizedNightlyByBR } from "./community-research";

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
};

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
  medianNightly: number;
  season: "LOW" | "HIGH" | "HOLIDAY";
  checkIn: string;
  checkOut: string;
  channelCount: number;
  sampleCount: number;
  demandClass: HybridDemandClass;
  seasonTierId: string;
  seasonTierLabel: string;
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

function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return Math.round(clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2);
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
  const perQualifier = Math.round(priceNumber(candidate?.price?.extracted_price_per_qualifier));
  if (perQualifier > 0) return perQualifier;
  const total = Math.round(priceNumber(candidate?.price?.extracted_total_price));
  if (total > 0) return Math.round(total / nights);
  return null;
}

function listingMatchesBedrooms(candidate: any, bedrooms: number): boolean {
  const parsed = typeof candidate?.bedrooms === "number" && Number.isFinite(candidate.bedrooms)
    ? candidate.bedrooms
    : extractBedroomsFromListing(candidate);
  // SearchAPI already filters by bedrooms= — when the engine omits BR in the
  // payload, trust the query rather than dropping every priced listing.
  if (Number.isNaN(parsed)) return true;
  return parsed === bedrooms;
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
  return [...new Set(ordered)];
}

async function fetchAirbnbMedianNightlyForQuery(args: {
  community: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  query: string;
  apiKey: string;
  nights: number;
}): Promise<{ rates: number[]; noResultsError: string | null }> {
  const location = BUY_IN_MARKET_LOCATIONS[args.community];
  const bounds = BUY_IN_MARKET_BOUNDS[args.community];
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
  if (location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    const halfDeg = 0.02;
    params.sw_lat = String(location.lat - halfDeg);
    params.sw_lng = String(location.lng - halfDeg);
    params.ne_lat = String(location.lat + halfDeg);
    params.ne_lng = String(location.lng + halfDeg);
  } else if (bounds) {
    params.bounding_box = `[[${bounds.ne_lat},${bounds.ne_lng}],[${bounds.sw_lat},${bounds.sw_lng}]]`;
  }
  const response = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(params).toString()}`);
  if (!response.ok) throw new Error(`SearchAPI Airbnb HTTP ${response.status}`);
  const data = await response.json() as any;
  if (data?.error) {
    const message = `SearchAPI Airbnb: ${data.error}`;
    if (isSearchApiAirbnbNoResultsError(message)) {
      return { rates: [], noResultsError: message };
    }
    throw new Error(message);
  }
  const rates: number[] = [];
  for (const candidate of Array.isArray(data?.properties) ? data.properties : []) {
    if (!listingMatchesBedrooms(candidate, args.bedrooms)) continue;
    const nightly = nightlyRateFromListing(candidate, args.nights);
    if (nightly == null || nightly < 50 || nightly > 3000) continue;
    rates.push(nightly);
  }
  return { rates, noResultsError: null };
}

export async function fetchAirbnbMedianNightly(args: {
  community: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  searchName?: string;
}): Promise<{ medianNightly: number | null; sampleCount: number; notes: string[] }> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) throw new Error("SEARCHAPI_API_KEY not configured");
  const nights = nightsBetween(args.checkIn, args.checkOut);
  const queries = curatedAirbnbSearchQueries(args.community, args.searchName);
  const notes: string[] = [];
  let lastNoResults: string | null = null;

  for (const query of queries) {
    const { rates, noResultsError } = await fetchAirbnbMedianNightlyForQuery({
      community: args.community,
      bedrooms: args.bedrooms,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      query,
      apiKey,
      nights,
    });
    if (noResultsError) {
      lastNoResults = noResultsError;
      notes.push(`${noResultsError} (q="${query}")`);
      continue;
    }
    if (rates.length > 0) {
      return {
        medianNightly: median(rates),
        sampleCount: rates.length,
        notes: [
          `SearchAPI Airbnb returned ${rates.length} usable exact-${args.bedrooms}BR all-in checkout sample(s) for q="${query}".`,
        ],
      };
    }
    notes.push(`q="${query}" returned 0 usable exact-${args.bedrooms}BR priced samples`);
  }

  const location = BUY_IN_MARKET_LOCATIONS[args.community];
  if (location) {
    const amortized = await fetchAmortizedNightlyByBR(
      location.searchName,
      location.city,
      location.state,
      location.streetAddress,
      { lat: location.lat, lng: location.lng },
      { checkIn: args.checkIn, checkOut: args.checkOut },
      { bedrooms: args.bedrooms, bboxScale: 2 },
    );
    const brRates = amortized.ratesByBR[args.bedrooms] ?? [];
    if (brRates.length > 0) {
      return {
        medianNightly: median(brRates),
        sampleCount: brRates.length,
        notes: [
          `SearchAPI amortized path returned ${brRates.length} exact-${args.bedrooms}BR sample(s) for ${location.searchName}.`,
        ],
      };
    }
    if (amortized.drops?.engineCount) {
      notes.push(
        `amortized geo fallback saw ${amortized.drops.engineCount} engine listing(s) but 0 priced ${args.bedrooms}BR`,
      );
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
    (rate) => legacySeasonForDemandClass(rate.demandClass) === season,
  ) ?? null;
}

function seasonalMedianSummary(
  seasonalMedians: Record<LegacySeason, number[]>,
): { lowMedian: number | null; highMedian: number | null; holidayMedian: number | null; missing: LegacySeason[] } {
  const missing: LegacySeason[] = [];
  const lowMedian = median(seasonalMedians.LOW);
  const highMedian = median(seasonalMedians.HIGH);
  const holidayMedian = median(seasonalMedians.HOLIDAY);
  if (lowMedian == null) missing.push("LOW");
  if (highMedian == null) missing.push("HIGH");
  if (holidayMedian == null) missing.push("HOLIDAY");
  return { lowMedian, highMedian, holidayMedian, missing };
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
}): Promise<{ propertyId: number; rows: any[]; logs: any[] }> {
  const { storage } = await import("./storage");
  const asOf = args.asOf ?? new Date();
  const searchQueries = curatedAirbnbSearchQueries(args.community, args.searchName);
  const searchName = searchQueries[0] || args.community;
  const pricingRegion = getCommunityRegion(args.community);
  const rows: any[] = [];
  const logs: any[] = [];
  const bedroomCounts = Array.from(new Set(args.bedroomCounts))
    .filter((bedrooms) => Number.isFinite(bedrooms) && bedrooms > 0)
    .sort((a, b) => a - b);

  for (const bedrooms of bedroomCounts) {
    const previous = (await storage.getPropertyMarketRates(args.propertyId)).find((r) => r.bedrooms === bedrooms);
    const monthlyRates: Record<string, HybridMonthlyRate> = {};
    const seasonalMedians: Record<LegacySeason, number[]> = { LOW: [], HIGH: [], HOLIDAY: [] };
    let totalSamples = 0;
    const horizonMonths = HYBRID_PRICING_CONFIG.scanSettings.horizonMonths;
    const stayNights = HYBRID_PRICING_CONFIG.scanSettings.defaultStayNights;

    for (let monthOffset = 0; monthOffset < horizonMonths; monthOffset += 1) {
      let airbnb: Awaited<ReturnType<typeof fetchAirbnbMedianNightly>> | null = null;
      let window = { yearMonth: "", checkIn: "", checkOut: "" };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        window = hybridPricingWindowForMonth(asOf, monthOffset, stayNights);
        airbnb = await fetchAirbnbMedianNightly({
          community: args.community,
          bedrooms,
          checkIn: window.checkIn,
          checkOut: window.checkOut,
          searchName,
        });
        if (airbnb.medianNightly != null) break;
      }
      if (!window.checkIn) {
        await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
        throw new Error(
          `No eligible 7-night Airbnb pricing window exists for ${window.yearMonth || `month offset ${monthOffset}`} (${searchName})`,
        );
      }
      if (!airbnb || airbnb.medianNightly == null) {
        await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
        throw new Error(
          `SearchAPI Airbnb returned no usable exact-${bedrooms}BR samples for ${searchName} ` +
          `${window.yearMonth} (${window.checkIn} to ${window.checkOut}); static fallback is disabled for market-rate refreshes.`,
        );
      }
      const basis = airbnb.medianNightly;
      const season = getSeasonForMonth(window.yearMonth, pricingRegion);
      const tier = resolveSeasonTier(window.checkIn);
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
        channels: { airbnb: basis, vrbo: null, booking: null, pm: null },
        hybrid: {
          baseAirbnbMedian: basis,
          finalRate: basis,
          layers: [],
          notes: [
            ...airbnb.notes,
            `Stored raw SearchAPI median (no hybrid markup layers). ${window.yearMonth} window ${window.checkIn} to ${window.checkOut}.`,
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
      });
      await sleep(HYBRID_PRICING_CONFIG.scanSettings.rateLimitMs);
    }

    const { lowMedian, highMedian, holidayMedian, missing } = seasonalMedianSummary(seasonalMedians);
    if (missing.length > 0) {
      await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
      throw new Error(
        `SearchAPI Airbnb monthly scans for ${searchName} did not produce ${missing.join("/")} demand-tier samples ` +
        `(need standard/low, high, and peak/ultra windows); static fallback is disabled.`,
      );
    }
    const lowRate = representativeMonthlyRate(monthlyRates, "LOW");
    const highRate = representativeMonthlyRate(monthlyRates, "HIGH");
    const holidayRate = representativeMonthlyRate(monthlyRates, "HOLIDAY");
    if (!lowRate || !highRate || !holidayRate) {
      await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
      throw new Error(`SearchAPI Airbnb monthly scans missing a LOW/HIGH/HOLIDAY month for ${searchName}.`);
    }
    const monthlyValues = Object.values(monthlyRates).map((rate) => rate.medianNightly);
    const scannedMonths = Object.keys(monthlyRates).sort();
    if (scannedMonths.length !== horizonMonths) {
      await storage.deletePropertyMarketRate(args.propertyId, bedrooms).catch(() => undefined);
      throw new Error(
        `SearchAPI Airbnb monthly scan for ${searchName} stored ${scannedMonths.length}/${horizonMonths} months; expected one median per calendar month.`,
      );
    }
    const row = await storage.upsertPropertyMarketRate({
      propertyId: args.propertyId,
      bedrooms,
      medianNightly: String(lowMedian),
      medianNightlyHigh: String(highMedian),
      medianNightlyHoliday: String(holidayMedian),
      monthlyRates,
      lowNightly: String(Math.min(...monthlyValues)),
      highNightly: String(Math.max(...monthlyValues)),
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
      newRate: String(lowMedian),
      status: "ok",
      notes: [
        args.notes || "SearchAPI Airbnb monthly medians saved without hybrid markup layers; static buy-in fallback is disabled for market-rate refreshes.",
        `Scanned ${scannedMonths.length} calendar months (${scannedMonths[0]} through ${scannedMonths[scannedMonths.length - 1]}).`,
      ].join(" "),
      layersJson: [],
      calendarJson: monthlyRates,
    }));
    console.info("[hybrid-pricing] applied raw Airbnb monthly medians", JSON.stringify({
      propertyId: args.propertyId,
      propertyName: args.propertyName,
      community: args.community,
      bedrooms,
      triggerType: args.triggerType,
      source: "airbnb",
      searchName,
      unitCount: args.unitCount,
      sampleCount: totalSamples,
      low: {
        median: lowMedian,
        checkIn: lowRate.checkIn,
        checkOut: lowRate.checkOut,
        baseAirbnbMedian: lowRate.hybrid.baseAirbnbMedian,
        finalRate: lowRate.hybrid.finalRate,
      },
      high: {
        median: highMedian,
        checkIn: highRate.checkIn,
        checkOut: highRate.checkOut,
        baseAirbnbMedian: highRate.hybrid.baseAirbnbMedian,
        finalRate: highRate.hybrid.finalRate,
      },
      holiday: {
        median: holidayMedian,
        checkIn: holidayRate.checkIn,
        checkOut: holidayRate.checkOut,
        baseAirbnbMedian: holidayRate.hybrid.baseAirbnbMedian,
        finalRate: holidayRate.hybrid.finalRate,
      },
      lowNightly: Math.min(...monthlyValues),
      highNightly: Math.max(...monthlyValues),
      monthsScanned: scannedMonths.length,
      scannedMonths,
      monthlyPreview: summarizeMonthlyHybridRates(monthlyRates),
      layers: [],
    }));
  }
  return { propertyId: args.propertyId, rows, logs };
}

export async function refreshHybridPricingForProperty(args: {
  propertyId: number;
  triggerType: HybridTriggerType;
  notes?: string;
  asOf?: Date;
  onMonthScanned?: (event: HybridMonthScannedEvent) => void | Promise<void>;
}): Promise<{ propertyId: number; rows: any[]; logs: any[] }> {
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
