// ─────────────────────────────────────────────────────────────
// PRICING DATA — Redesigned Methodology
// Season Types: LOW / HIGH / HOLIDAY
// Builder sheet rate = Buy-In Cost with a clean target margin after the
// Direct/Stripe host fee. Guesty handles channel-specific pricing rules after
// the marked-up base calendar rate is pushed.
// ─────────────────────────────────────────────────────────────

import {
  BUY_IN_RATES,
  SEASON_MULTIPLIERS,
  getBuyInRate,
  getCommunityRegion,
  getLiveBuyIn,
  getSeasonForMonth,
  setLivePropertyMarketRates,
  type LivePropertyMarketRateInput,
  type RegionType,
  type SeasonType,
} from "@shared/pricing-rates";
import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";

export {
  getBuyInRate,
  getCommunityRegion,
  getLiveBuyIn,
  getSeasonForMonth,
  setLivePropertyMarketRates,
};
export type { LivePropertyMarketRateInput, RegionType, SeasonType };

export type MonthRate = {
  month: string;
  year: number;
  yearMonth: string;
  season: SeasonType;
  buyInRate: number;
  sellRate: number;
};

export type UnitPricing = {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
  community: string;
  baseBuyIn: number;
  baseSellRate: number;
  monthlyRates: MonthRate[];
};

export type PropertyPricing = {
  propertyId: number;
  totalBaseBuyIn: number;
  totalBaseSellRate: number;
  units: UnitPricing[];
};

// ─────────────────────────────────────────────────────────────
// LEGACY BUY-IN TRACKER MARKUP FORMULA
// Some older buy-in views still show the historical split:
// Sell Rate = Buy-In × (1 + PLATFORM_FEE) × (1 + BUSINESS_MARKUP).
// The Builder Pricing tab uses `cleanBaseRateFromBuyIn` below instead so
// "Sheet Rate / Night" matches the marked-up Guesty calendar push.
// ─────────────────────────────────────────────────────────────

export const PLATFORM_FEE = 0.15;      // 15% — covers Booking.com / Airbnb guest service fees
export const BUSINESS_MARKUP = 0.20;   // 20% — your business profit margin
export const MARKUP = (1 + PLATFORM_FEE) * (1 + BUSINESS_MARKUP); // = 1.38

// ─────────────────────────────────────────────────────────────
// PER-CHANNEL HOST FEES
// Each channel takes a cut of the gross guest charge before paying
// the host. These are the *host-side* fees (what comes off YOUR payout),
// not the guest service fees that sit on top of the listed price.
// ─────────────────────────────────────────────────────────────

export type ChannelKey = "airbnb" | "vrbo" | "booking" | "direct";

export const CHANNEL_HOST_FEE: Record<ChannelKey, number> = {
  airbnb:  0.155,  // Airbnb host service fee: 15.5% on some listings (previously 3% co-host model)
  vrbo:    0.08,   // Vrbo/HomeAway pay-per-booking: 8% commission
  booking: 0.17,   // Booking.com: 15–17% depending on market
  direct:  0.03,   // Stripe/processing for direct bookings
};

export const MIN_PROFIT_MARGIN = 0.20; // 20% — floor we want after channel fees

/**
 * Given a buy-in cost and channel, returns the minimum nightly rate
 * that still yields `MIN_PROFIT_MARGIN` profit after the channel's host fee.
 *
 *   minSellRate × (1 - channelFee) - buyIn ≥ MIN_PROFIT_MARGIN × buyIn
 *   ⇒ minSellRate = (1 + MIN_PROFIT_MARGIN) × buyIn / (1 - channelFee)
 *
 * Example: buyIn=$1,172 on Airbnb → 1.20 × 1172 / 0.845 = $1,664.85
 */
export function minProfitableRate(
  buyIn: number,
  channel: ChannelKey,
  targetMargin: number = MIN_PROFIT_MARGIN,
): number {
  const fee = CHANNEL_HOST_FEE[channel] ?? 0;
  return Math.ceil(((1 + targetMargin) * buyIn) / (1 - fee));
}

export function cleanBaseRateFromBuyIn(
  buyIn: number,
  targetMargin: number = MIN_PROFIT_MARGIN,
): number {
  return minProfitableRate(buyIn, "direct", targetMargin);
}

/**
 * Given a gross guest charge and channel, what does the host actually net?
 * Useful for booking margin checks.
 */
export function netPayoutAfterChannelFee(gross: number, channel: ChannelKey): number {
  return gross * (1 - (CHANNEL_HOST_FEE[channel] ?? 0));
}

/**
 * Effective profit margin given a sell rate, buy-in, and channel.
 * Returns a decimal (0.20 = 20%). Negative if at a loss.
 */
export function actualMarginPct(sellRate: number, buyIn: number, channel: ChannelKey): number {
  const net = netPayoutAfterChannelFee(sellRate, channel);
  if (buyIn <= 0) return 0;
  return (net - buyIn) / buyIn;
}

// ─────────────────────────────────────────────────────────────
// SEASON MULTIPLIERS — region-specific, 3 tiers
// ─────────────────────────────────────────────────────────────

const SEASON_MULTIPLIERS: Record<RegionType, Record<SeasonType, number>> = {
  hawaii:  { LOW: 0.80, HIGH: 1.30, HOLIDAY: 1.80 },
  florida: { LOW: 0.75, HIGH: 1.25, HOLIDAY: 1.70 },
};

// Per-season markup to correct Airbnb's typical under-pricing vs VRBO/Booking.com medians.
// Mirrors shared/pricing-rates.ts for client-side preview in Pricing tab.
export const AIRBNB_TO_MARKET_MARKUPS: Record<SeasonType, number> = {
  LOW: 1.16,
  HIGH: 1.09,
  HOLIDAY: 1.05,
};

// ─────────────────────────────────────────────────────────────
// HOLIDAY DATE RANGES — day-level detection overrides monthly season
// Month numbers are 1-indexed. Ranges use startMonth/startDay → endMonth/endDay.
// ─────────────────────────────────────────────────────────────

type HolidayRange = {
  label: string;
  sm: number; sd: number;  // start month/day
  em: number; ed: number;  // end month/day
};

export const HOLIDAY_RANGES: HolidayRange[] = [
  { label: "Christmas / New Year",  sm: 12, sd: 20, em: 1,  ed: 5  },
  { label: "Independence Day Week", sm: 7,  sd: 1,  em: 7,  ed: 7  },
  { label: "Thanksgiving Week",     sm: 11, sd: 22, em: 11, ed: 30 },
  { label: "Spring Break",          sm: 3,  sd: 15, em: 4,  ed: 5  },
  { label: "Presidents' Weekend",   sm: 2,  sd: 14, em: 2,  ed: 17 },
];

export function getHolidayLabel(date: Date): string | null {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  for (const r of HOLIDAY_RANGES) {
    if (r.sm > r.em) {
      // Year-wrapping range (e.g. Dec 20 → Jan 5)
      if ((m === r.sm && d >= r.sd) || m > r.sm || m < r.em || (m === r.em && d <= r.ed)) {
        return r.label;
      }
    } else if (r.sm === r.em) {
      if (m === r.sm && d >= r.sd && d <= r.ed) return r.label;
    } else {
      if ((m === r.sm && d >= r.sd) || (m > r.sm && m < r.em) || (m === r.em && d <= r.ed)) {
        return r.label;
      }
    }
  }
  return null;
}

export function isHolidayDate(date: Date): boolean {
  return getHolidayLabel(date) !== null;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Get season for a specific calendar date (holiday detection takes priority)
export function getSeasonForDate(date: Date, region: RegionType): SeasonType {
  if (isHolidayDate(date)) return "HOLIDAY";
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return getSeasonForMonth(`${date.getFullYear()}-${mm}`, region);
}

// Get the dominant season for a date range (for summary display)
export function getDominantSeason(
  checkIn: string,
  checkOut: string,
  region: RegionType
): { season: SeasonType; holidayLabel: string | null } {
  const start = new Date(checkIn + "T12:00:00");
  const end = new Date(checkOut + "T12:00:00");
  const counts: Record<SeasonType, number> = { LOW: 0, HIGH: 0, HOLIDAY: 0 };
  let holidayLabel: string | null = null;

  const cur = new Date(start);
  while (cur < end) {
    const season = getSeasonForDate(cur, region);
    counts[season]++;
    if (season === "HOLIDAY" && !holidayLabel) holidayLabel = getHolidayLabel(cur);
    cur.setDate(cur.getDate() + 1);
  }

  if (counts.HOLIDAY > 0) return { season: "HOLIDAY", holidayLabel };
  if (counts.HIGH >= counts.LOW) return { season: "HIGH", holidayLabel: null };
  return { season: "LOW", holidayLabel: null };
}

// Generates 24 months of rates starting from the current month (dynamic)
const RATE_SCHEDULE_MONTHS: { yearMonth: string; monthIndex: number; year: number }[] = (() => {
  const now = new Date();
  const months: { yearMonth: string; monthIndex: number; year: number }[] = [];
  let year = now.getFullYear();
  let monthIndex = now.getMonth();
  for (let i = 0; i < 24; i++) {
    const mm = String(monthIndex + 1).padStart(2, "0");
    months.push({ yearMonth: `${year}-${mm}`, monthIndex, year });
    monthIndex++;
    if (monthIndex > 11) { monthIndex = 0; year++; }
  }
  return months;
})();

function generateMonthlyRates(
  baseBuyIn: number,
  community: string,
  // PR #282: when supplied, each month's buy-in is read directly via
  // getBuyInRate(community, br, propertyId, season) — picks up the
  // per-season basis from the live cache when populated. Falls back
  // to baseBuyIn × multiplier when the cache has no per-season data
  // for that BR (legacy single-window scan or static BUY_IN_RATES).
  propertyId?: number,
  bedrooms?: number,
): MonthRate[] {
  const region = getCommunityRegion(community);
  return RATE_SCHEDULE_MONTHS.map(({ yearMonth, monthIndex, year }) => {
    const season = getSeasonForMonth(yearMonth, region);
    let buyInRate: number;
    if (propertyId != null && bedrooms != null) {
      // getBuyInRate reads per-season basis from live cache when
      // available; falls through to LOW × multiplier internally
      // when not.
      buyInRate = getBuyInRate(community, bedrooms, propertyId, season, yearMonth);
    } else {
      // Legacy callers (no propertyId/bedrooms): apply multiplier
      // to the base.
      const multiplier = SEASON_MULTIPLIERS[region][season];
      buyInRate = Math.round(baseBuyIn * multiplier);
    }
    const sellRate = cleanBaseRateFromBuyIn(buyInRate);
    return { month: MONTH_NAMES[monthIndex], year, yearMonth, season, buyInRate, sellRate };
  });
}

// ─────────────────────────────────────────────────────────────
// SELL RATE CALCULATION — transparent breakdown
// ─────────────────────────────────────────────────────────────

export function calcSellRateFromBuyIn(buyInCost: number): {
  platformFeeAmount: number;
  markupAmount: number;
  sellRate: number;
  profit: number;
  margin: number;
} {
  const platformFeeAmount = Math.round(buyInCost * PLATFORM_FEE);
  const subtotal = buyInCost + platformFeeAmount;
  const markupAmount = Math.round(subtotal * BUSINESS_MARKUP);
  const sellRate = subtotal + markupAmount;
  const profit = sellRate - buyInCost;
  const margin = buyInCost > 0 ? Math.round((profit / sellRate) * 100) : 0;
  return { platformFeeAmount, markupAmount, sellRate, profit, margin };
}

// ─────────────────────────────────────────────────────────────
// SEASONAL RATE REFERENCE — what you'd charge per season for a property
// Based on community BUY_IN_RATES × season multiplier × marked-up base rate
// ─────────────────────────────────────────────────────────────

export type SeasonalRateRef = {
  season: SeasonType;
  nightly: number;       // sell rate per night
  multiplier: number;
};

export function getSeasonalRateReference(
  propertyId: number,
  nights = 7
): { community: string; region: RegionType; rates: SeasonalRateRef[]; totalUnits: number } | null {
  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) return null;

  const region = getCommunityRegion(config.community);

  const rates: SeasonalRateRef[] = (["LOW", "HIGH", "HOLIDAY"] as SeasonType[]).map(season => {
    const multiplier = SEASON_MULTIPLIERS[region][season];
    let nightlyBuyIn = 0;
    for (const unit of config.units) {
      nightlyBuyIn += getBuyInRate(config.community, unit.bedrooms, propertyId, season);
    }
    const nightlySell = cleanBaseRateFromBuyIn(nightlyBuyIn);
    return { season, nightly: nightlySell, multiplier };
  });

  return { community: config.community, region, rates, totalUnits: config.units.length };
}

// ─────────────────────────────────────────────────────────────
// EXPORTED FUNCTIONS
// ─────────────────────────────────────────────────────────────

// Cache of draft-derived pricing populated by the builder page when it
// loads a community-draft property (propertyId < 0). The Pricing tab
// inside GuestyListingBuilder calls getPropertyPricing(propertyId)
// directly, so the parent page can't just pass pricing through props
// — we register it here ahead of render and the helper checks the
// cache first for negative propertyIds. Same pattern as
// registerDraftBeddingDefaults() in bedding-config.ts.
const draftPricingCache = new Map<number, PropertyPricing>();
export function registerDraftPropertyPricing(
  propertyId: number,
  pricing: PropertyPricing,
): void {
  draftPricingCache.set(propertyId, pricing);
}

export function getPropertyPricing(propertyId: number): PropertyPricing | null {
  // Promoted-draft fast path: the builder page registered pricing for
  // this negative propertyId before any tab rendered.
  if (propertyId < 0) {
    return draftPricingCache.get(propertyId) ?? null;
  }
  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) return null;

  const units: UnitPricing[] = config.units.map((unit) => {
    const baseBuyIn = getBuyInRate(config.community, unit.bedrooms, propertyId);
    const baseSellRate = cleanBaseRateFromBuyIn(baseBuyIn);
    const monthlyRates = generateMonthlyRates(baseBuyIn, config.community, propertyId, unit.bedrooms);
    return { unitId: unit.unitId, unitLabel: unit.unitLabel, bedrooms: unit.bedrooms, community: config.community, baseBuyIn, baseSellRate, monthlyRates };
  });

  const totalBaseBuyIn = units.reduce((sum, u) => sum + u.baseBuyIn, 0);
  const totalBaseSellRate = units.reduce((sum, u) => sum + u.baseSellRate, 0);
  return { propertyId, totalBaseBuyIn, totalBaseSellRate, units };
}

export function getSeasonLabel(season: SeasonType): string {
  switch (season) {
    case "HIGH":    return "High";
    case "LOW":     return "Low";
    case "HOLIDAY": return "Holiday";
  }
}

export function getSeasonColor(season: SeasonType): string {
  switch (season) {
    case "HIGH":    return "text-amber-600 dark:text-amber-400";
    case "LOW":     return "text-green-600 dark:text-green-400";
    case "HOLIDAY": return "text-purple-600 dark:text-purple-400";
  }
}

export function getSeasonBgClass(season: SeasonType): string {
  switch (season) {
    case "HIGH":    return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "LOW":     return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
    case "HOLIDAY": return "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300";
  }
}

export function getSeasonBadgeVariant(season: SeasonType): "destructive" | "secondary" | "default" {
  switch (season) {
    case "HIGH":    return "destructive";
    case "LOW":     return "default";
    case "HOLIDAY": return "secondary";
  }
}

export function getAllUnitPricings(): { propertyId: number; community: string; unit: UnitPricing }[] {
  const results: { propertyId: number; community: string; unit: UnitPricing }[] = [];
  for (const [id, config] of Object.entries(PROPERTY_UNIT_CONFIGS)) {
    const propertyId = parseInt(id, 10);
    for (const unitCfg of config.units) {
      const baseBuyIn = getBuyInRate(config.community, unitCfg.bedrooms, propertyId);
      const baseSellRate = cleanBaseRateFromBuyIn(baseBuyIn);
      const monthlyRates = generateMonthlyRates(baseBuyIn, config.community, propertyId, unitCfg.bedrooms);
      results.push({
        propertyId,
        community: config.community,
        unit: { unitId: unitCfg.unitId, unitLabel: unitCfg.unitLabel, bedrooms: unitCfg.bedrooms, community: config.community, baseBuyIn, baseSellRate, monthlyRates },
      });
    }
  }
  return results;
}

export function calculateStaySellRate(
  propertyId: number,
  checkIn: string,
  checkOut: string
): { totalSellRate: number; totalNights: number; nightlyBreakdown: { date: string; sellRate: number; season: SeasonType }[] } | null {
  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) return null;

  const region = getCommunityRegion(config.community);
  const start = new Date(checkIn + "T12:00:00");
  const end = new Date(checkOut + "T12:00:00");
  const nightlyBreakdown: { date: string; sellRate: number; season: SeasonType }[] = [];
  let totalSellRate = 0;
  let totalNights = 0;

  const current = new Date(start);
  while (current < end) {
    const season = getSeasonForDate(current, region);
    const yearMonth = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;

    let nightlyBuyIn = 0;
    for (const unit of config.units) {
      nightlyBuyIn += getBuyInRate(config.community, unit.bedrooms, propertyId, season, yearMonth);
    }
    const nightlySellRate = cleanBaseRateFromBuyIn(nightlyBuyIn);

    nightlyBreakdown.push({ date: current.toISOString().split("T")[0], sellRate: nightlySellRate, season });
    totalSellRate += nightlySellRate;
    totalNights++;
    current.setDate(current.getDate() + 1);
  }

  return { totalSellRate, totalNights, nightlyBreakdown };
}

export { MARKUP as _MARKUP_TOTAL, SEASON_MULTIPLIERS, BUY_IN_RATES };
