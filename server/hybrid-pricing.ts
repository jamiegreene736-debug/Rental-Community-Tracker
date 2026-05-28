import fs from "node:fs";
import path from "node:path";

import { BUY_IN_MARKET_BOUNDS, BUY_IN_MARKET_LOCATIONS, BUY_IN_MARKETS } from "@shared/buy-in-market";
import { PROPERTY_UNIT_CONFIGS, type PropertyUnitConfig } from "@shared/property-units";

export type HybridDemandClass = "standard" | "high" | "peak" | "ultra";
export type HybridTriggerType = "Weekly Automated Scan" | "Manual Update" | "Admin Backfill";

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

function priceNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return NaN;
}

function extractBedrooms(candidate: any): number | null {
  if (typeof candidate?.bedrooms === "number" && Number.isFinite(candidate.bedrooms)) return candidate.bedrooms;
  const text = [
    candidate?.name,
    candidate?.title,
    candidate?.description,
    candidate?.snippet,
    candidate?.subtitle,
  ].filter(Boolean).join(" ");
  const match = text.match(/\b(\d+)\s*(?:br|bed|bedroom|bedrooms)\b/i);
  return match ? Number(match[1]) : null;
}

async function fetchAirbnbMedianNightly(args: {
  community: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  searchName?: string;
}): Promise<{ medianNightly: number | null; sampleCount: number; notes: string[] }> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) throw new Error("SEARCHAPI_API_KEY not configured");
  const nights = nightsBetween(args.checkIn, args.checkOut);
  const market = BUY_IN_MARKETS[args.community];
  const bounds = BUY_IN_MARKET_BOUNDS[args.community];
  const params: Record<string, string> = {
    engine: "airbnb",
    q: args.searchName || market?.platformSearch?.airbnb || market?.searchLocation || args.community,
    check_in_date: args.checkIn,
    check_out_date: args.checkOut,
    adults: "2",
    bedrooms: String(args.bedrooms),
    type_of_place: "entire_home",
    currency: "USD",
    api_key: apiKey,
  };
  if (bounds) {
    params.bounding_box = `[[${bounds.ne_lat},${bounds.ne_lng}],[${bounds.sw_lat},${bounds.sw_lng}]]`;
  }
  const response = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(params).toString()}`);
  if (!response.ok) throw new Error(`SearchAPI Airbnb HTTP ${response.status}`);
  const data = await response.json() as any;
  if (data?.error) throw new Error(`SearchAPI Airbnb: ${data.error}`);
  const rates: number[] = [];
  for (const candidate of Array.isArray(data?.properties) ? data.properties : []) {
    const total = Math.round(priceNumber(candidate?.price?.extracted_total_price));
    if (!(total > 0)) continue;
    const parsedBedrooms = extractBedrooms(candidate);
    if (parsedBedrooms != null && parsedBedrooms < args.bedrooms) continue;
    rates.push(Math.round(total / nights));
  }
  return {
    medianNightly: median(rates),
    sampleCount: rates.length,
    notes: [`SearchAPI Airbnb returned ${rates.length} usable ${args.bedrooms}+BR sample(s).`],
  };
}

function monthStart(base: Date, offset: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
}

export function hybridPricingWindowForMonth(asOf: Date, monthOffset: number, stayNights = HYBRID_PRICING_CONFIG.scanSettings.defaultStayNights): { yearMonth: string; checkIn: string; checkOut: string } {
  const start = monthStart(asOf, monthOffset);
  const todayUtc = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const earliestCurrentMonthCheckIn = addDays(todayUtc, 2);
  const checkInDate = monthOffset === 0 && start <= earliestCurrentMonthCheckIn
    ? earliestCurrentMonthCheckIn
    : start;
  const checkIn = dateOnly(checkInDate);
  return {
    yearMonth: checkIn.slice(0, 7),
    checkIn,
    checkOut: dateOnly(addDays(checkInDate, stayNights)),
  };
}

function propertyBedroomCounts(config: PropertyUnitConfig): number[] {
  return Array.from(new Set(config.units.map((u) => u.bedrooms))).sort((a, b) => a - b);
}

function toLegacySeason(demandClass: HybridDemandClass): "LOW" | "HIGH" | "HOLIDAY" {
  if (demandClass === "standard") return "LOW";
  if (demandClass === "high") return "HIGH";
  return "HOLIDAY";
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
}): Promise<{ propertyId: number; rows: any[]; logs: any[] }> {
  const { storage } = await import("./storage");
  const market = BUY_IN_MARKETS[args.community];
  const location = BUY_IN_MARKET_LOCATIONS[args.community];
  const searchName = args.searchName || market?.platformSearch?.airbnb || location?.searchName || market?.searchLocation || args.community;
  const asOf = args.asOf ?? new Date();
  const rows: any[] = [];
  const logs: any[] = [];
  const bedroomCounts = Array.from(new Set(args.bedroomCounts))
    .filter((bedrooms) => Number.isFinite(bedrooms) && bedrooms > 0)
    .sort((a, b) => a - b);

  for (const bedrooms of bedroomCounts) {
    const previous = (await storage.getPropertyMarketRates(args.propertyId)).find((r) => r.bedrooms === bedrooms);
    const monthlyRates: Record<string, HybridMonthlyRate> = {};
    const allFinalRates: number[] = [];
    const highRates: number[] = [];
    const holidayRates: number[] = [];
    let totalSamples = 0;
    let lastResult: HybridCalculationResult | null = null;

    for (let m = 0; m < HYBRID_PRICING_CONFIG.scanSettings.horizonMonths; m++) {
      const { checkIn, checkOut, yearMonth } = hybridPricingWindowForMonth(asOf, m);
      const airbnb = await fetchAirbnbMedianNightly({ community: args.community, bedrooms, checkIn, checkOut, searchName });
      if (HYBRID_PRICING_CONFIG.scanSettings.rateLimitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, HYBRID_PRICING_CONFIG.scanSettings.rateLimitMs));
      }
      if (airbnb.medianNightly == null) continue;
      totalSamples += airbnb.sampleCount;
      const result = calculateBlendedRate({
        airbnbMedianNightly: airbnb.medianNightly,
        checkIn,
        checkOut,
        bedrooms,
        unitCount: args.unitCount,
        isMultiUnit: args.unitCount > 1,
        asOf,
      });
      lastResult = result;
      allFinalRates.push(result.finalRate);
      if (result.demandClass === "high") highRates.push(result.finalRate);
      if (result.demandClass === "peak" || result.demandClass === "ultra") holidayRates.push(result.finalRate);
      monthlyRates[yearMonth] = {
        medianNightly: result.finalRate,
        season: toLegacySeason(result.demandClass),
        checkIn,
        checkOut,
        channelCount: 1,
        sampleCount: airbnb.sampleCount,
        demandClass: result.demandClass,
        seasonTierId: result.seasonTierId,
        seasonTierLabel: result.seasonTierLabel,
        channels: { airbnb: airbnb.medianNightly, vrbo: null, booking: null, pm: null },
        hybrid: {
          baseAirbnbMedian: result.baseAirbnbMedian,
          finalRate: result.finalRate,
          layers: result.layers,
          notes: [...airbnb.notes, ...result.notes],
        },
      };
    }

    const medianNightly = median(allFinalRates);
    if (medianNightly == null) {
      await storage.deletePropertyMarketRate(args.propertyId, bedrooms);
      logs.push(await storage.createPricingUpdateLog({
        propertyId: args.propertyId,
        propertyName: args.propertyName,
        bedrooms,
        triggerType: args.triggerType,
        oldRate: previous?.medianNightly ?? null,
        newRate: null,
        status: "error",
        notes: "No usable Airbnb samples returned by SearchAPI.",
        layersJson: [],
        calendarJson: {},
      }));
      continue;
    }

    const row = await storage.upsertPropertyMarketRate({
      propertyId: args.propertyId,
      bedrooms,
      medianNightly: String(medianNightly),
      medianNightlyHigh: String(median(highRates) ?? medianNightly),
      medianNightlyHoliday: String(median(holidayRates) ?? median(highRates) ?? medianNightly),
      monthlyRates,
      lowNightly: String(Math.min(...allFinalRates)),
      highNightly: String(Math.max(...allFinalRates)),
      sampleCount: totalSamples,
      source: "hybrid-airbnb-layered",
    });
    rows.push(row);
    logs.push(await storage.createPricingUpdateLog({
      propertyId: args.propertyId,
      propertyName: args.propertyName,
      bedrooms,
      triggerType: args.triggerType,
      oldRate: previous?.medianNightly ?? null,
      newRate: String(medianNightly),
      status: "ok",
      notes: args.notes || `Hybrid Airbnb layered pricing refreshed for ${Object.keys(monthlyRates).length} month(s).`,
      layersJson: lastResult?.layers ?? [],
      calendarJson: monthlyRates,
    }));
  }
  return { propertyId: args.propertyId, rows, logs };
}

export async function refreshHybridPricingForProperty(args: {
  propertyId: number;
  triggerType: HybridTriggerType;
  notes?: string;
  asOf?: Date;
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
