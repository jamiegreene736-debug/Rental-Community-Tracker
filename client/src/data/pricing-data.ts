// ─────────────────────────────────────────────────────────────
// PRICING DATA — Redesigned Methodology
// Season Types: LOW / HIGH / HOLIDAY
// Sell Rate = Buy-In Cost × (1 + PLATFORM_FEE) × (1 + BUSINESS_MARKUP)
// ─────────────────────────────────────────────────────────────

export type SeasonType = "HIGH" | "LOW" | "HOLIDAY";
export type RegionType = "hawaii" | "florida";

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
// TRANSPARENT MARKUP FORMULA
// Sell Rate = Buy-In × (1 + PLATFORM_FEE) × (1 + BUSINESS_MARKUP)
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
export function minProfitableRate(buyIn: number, channel: ChannelKey): number {
  const fee = CHANNEL_HOST_FEE[channel] ?? 0;
  return Math.ceil(((1 + MIN_PROFIT_MARGIN) * buyIn) / (1 - fee));
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

// ─────────────────────────────────────────────────────────────
// MONTHLY SEASON MAPS — LOW or HIGH only
// (HOLIDAY is detected at the day level and takes priority)
// ─────────────────────────────────────────────────────────────

const HAWAII_SEASONS: Record<string, SeasonType> = {
  "2026-04": "HIGH",   // Spring Break / Easter
  "2026-05": "LOW",
  "2026-06": "HIGH",
  "2026-07": "HIGH",
  "2026-08": "HIGH",
  "2026-09": "LOW",
  "2026-10": "LOW",
  "2026-11": "LOW",
  "2026-12": "HIGH",   // Holiday detected within at day level
  "2027-01": "HIGH",   // Holiday detected within at day level
  "2027-02": "LOW",
  "2027-03": "HIGH",   // Spring Break
  "2027-04": "HIGH",
  "2027-05": "LOW",
  "2027-06": "HIGH",
  "2027-07": "HIGH",
  "2027-08": "HIGH",
  "2027-09": "LOW",
  "2027-10": "LOW",
  "2027-11": "LOW",
  "2027-12": "HIGH",
  "2028-01": "HIGH",
  "2028-02": "LOW",
  "2028-03": "HIGH",
  "2028-04": "HIGH",
};

const FLORIDA_SEASONS: Record<string, SeasonType> = {
  "2026-04": "HIGH",
  "2026-05": "LOW",
  "2026-06": "HIGH",
  "2026-07": "HIGH",
  "2026-08": "HIGH",
  "2026-09": "LOW",
  "2026-10": "LOW",
  "2026-11": "LOW",
  "2026-12": "HIGH",
  "2027-01": "LOW",
  "2027-02": "LOW",
  "2027-03": "HIGH",
  "2027-04": "HIGH",
  "2027-05": "LOW",
  "2027-06": "HIGH",
  "2027-07": "HIGH",
  "2027-08": "HIGH",
  "2027-09": "LOW",
  "2027-10": "LOW",
  "2027-11": "LOW",
  "2027-12": "HIGH",
  "2028-01": "LOW",
  "2028-02": "LOW",
  "2028-03": "HIGH",
  "2028-04": "HIGH",
};

// ─────────────────────────────────────────────────────────────
// BASE BUY-IN RATES — per community, per bedroom count
// Source: Airbnb & VRBO live listings · May 2026 · nightly, pre-fees
// ─────────────────────────────────────────────────────────────

type CommunityRate = {
  "2BR"?: number;
  "3BR"?: number;
  "4BR"?: number;
  "5BR"?: number;
  region: RegionType;
};

const BUY_IN_RATES: Record<string, CommunityRate> = {
  // Kauai – South Shore
  "Poipu Kai":        { "2BR": 516, "3BR": 636, "4BR": 858,            region: "hawaii" },
  "Poipu Oceanfront": { "2BR": 630, "3BR": 792, "4BR": 936,            region: "hawaii" },
  "Poipu Brenneckes": { "2BR": 510, "3BR": 618, "4BR": 864,            region: "hawaii" },
  "Pili Mai":         { "2BR": 576, "3BR": 744, "4BR": 840,            region: "hawaii" },
  // Kauai – East Shore
  "Kapaa Beachfront": { "2BR": 588, "3BR": 840, "4BR": 1020,           region: "hawaii" },
  // Kauai – North Shore
  "Princeville":      { "2BR": 492, "3BR": 744, "4BR": 858,            region: "hawaii" },
  // Kauai – West Shore
  "Kekaha Beachfront":{ "2BR": 540, "3BR": 810, "4BR": 1080,           region: "hawaii" },
  // Big Island – Kona Coast
  "Keauhou":          { "2BR": 312,                                     region: "hawaii" },
  // Florida – Orlando Area
  "Southern Dunes":   {            "3BR": 192, "4BR": 200,             region: "florida" },
  "Windsor Hills":    {            "3BR": 210, "4BR": 294,             region: "florida" },
};

const FALLBACK_RATE_PER_BEDROOM = 270;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

export function getCommunityRegion(community: string): RegionType {
  return BUY_IN_RATES[community]?.region ?? "hawaii";
}

// Live-rate cache moved to `shared/pricing-rates.ts` so dashboard
// (`home.tsx → computeBaseRate`) and Builder Pricing tab read from
// the same Map. This file re-exports the public surface for code
// that imports from `@/data/pricing-data` (the Builder, drafts).
// New callers should import directly from `@shared/pricing-rates`.
import { setLivePropertyMarketRates, getLiveBuyIn, getBuyInRate, type LivePropertyMarketRateInput } from "@shared/pricing-rates";
export { setLivePropertyMarketRates, getLiveBuyIn, getBuyInRate };
export type { LivePropertyMarketRateInput };

function getSeasonForMonth(yearMonth: string, region: RegionType): SeasonType {
  const map = region === "florida" ? FLORIDA_SEASONS : HAWAII_SEASONS;
  return map[yearMonth] ?? "LOW";
}

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

function generateMonthlyRates(baseBuyIn: number, community: string): MonthRate[] {
  const region = getCommunityRegion(community);
  return RATE_SCHEDULE_MONTHS.map(({ yearMonth, monthIndex, year }) => {
    const season = getSeasonForMonth(yearMonth, region);
    const multiplier = SEASON_MULTIPLIERS[region][season];
    const buyInRate = Math.round(baseBuyIn * multiplier);
    const sellRate = Math.round(buyInRate * MARKUP);
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
// Based on community BUY_IN_RATES × season multiplier × MARKUP
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
      const base = getBuyInRate(config.community, unit.bedrooms, propertyId);
      nightlyBuyIn += Math.round(base * multiplier);
    }
    const nightlySell = Math.round(nightlyBuyIn * MARKUP);
    return { season, nightly: nightlySell, multiplier };
  });

  return { community: config.community, region, rates, totalUnits: config.units.length };
}

// ─────────────────────────────────────────────────────────────
// PROPERTY → UNIT CONFIGURATION
// ─────────────────────────────────────────────────────────────

type UnitConfig = {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
};

// CONDO / TOWNHOME ONLY — mirrors shared/property-units.ts. No villas, detached
// houses, or single-family dwellings. Properties 7, 10, 12, 14, 21, 26, 28, 31,
// 36 were removed 2026-04 as part of a business-model pivot.
const PROPERTY_UNIT_CONFIGS: Record<number, { community: string; units: UnitConfig[] }> = {
  1:  { community: "Poipu Kai",         units: [{ unitId: "924", unitLabel: "Unit 924", bedrooms: 3 }, { unitId: "114", unitLabel: "Unit 114", bedrooms: 2 }, { unitId: "911", unitLabel: "Unit 911", bedrooms: 2 }] },
  4:  { community: "Poipu Kai",         units: [{ unitId: "721", unitLabel: "Unit 721", bedrooms: 3 }, { unitId: "812", unitLabel: "Unit 812", bedrooms: 3 }] },
  8:  { community: "Poipu Kai",         units: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }, { unitId: "B", unitLabel: "Unit B", bedrooms: 3 }] },
  9:  { community: "Poipu Kai",         units: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }, { unitId: "B", unitLabel: "Unit B", bedrooms: 2 }] },
  18: { community: "Poipu Kai",         units: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }, { unitId: "B", unitLabel: "Unit B", bedrooms: 3 }] },
  19: { community: "Princeville",       units: [{ unitId: "A", unitLabel: "Townhome A", bedrooms: 3 }, { unitId: "B", unitLabel: "Townhome B", bedrooms: 2 }] },
  20: { community: "Princeville",       units: [{ unitId: "A", unitLabel: "Townhome A", bedrooms: 3 }, { unitId: "B", unitLabel: "Townhome B", bedrooms: 3 }] },
  23: { community: "Kapaa Beachfront",  units: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }, { unitId: "B", unitLabel: "Unit B", bedrooms: 2 }] },
  24: { community: "Poipu Oceanfront",  units: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }, { unitId: "B", unitLabel: "Unit B", bedrooms: 2 }] },
  27: { community: "Poipu Kai",         units: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 2 }, { unitId: "B", unitLabel: "Unit B", bedrooms: 2 }] },
  29: { community: "Princeville",       units: [{ unitId: "A", unitLabel: "Townhome A", bedrooms: 3 }, { unitId: "B", unitLabel: "Townhome B", bedrooms: 4 }] },
  32: { community: "Pili Mai",          units: [{ unitId: "A", unitLabel: "Townhome A", bedrooms: 3 }, { unitId: "B", unitLabel: "Townhome B", bedrooms: 2 }] },
  33: { community: "Pili Mai",          units: [{ unitId: "A", unitLabel: "Townhome A", bedrooms: 3 }, { unitId: "B", unitLabel: "Townhome B", bedrooms: 3 }] },
  34: { community: "Poipu Kai",         units: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }, { unitId: "B", unitLabel: "Unit B", bedrooms: 3 }] },
  37: { community: "Windsor Hills",     units: [{ unitId: "main", unitLabel: "Main Condo", bedrooms: 3 }] },
};

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
    const baseSellRate = Math.round(baseBuyIn * MARKUP);
    const monthlyRates = generateMonthlyRates(baseBuyIn, config.community);
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
      const baseSellRate = Math.round(baseBuyIn * MARKUP);
      const monthlyRates = generateMonthlyRates(baseBuyIn, config.community);
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
    const multiplier = SEASON_MULTIPLIERS[region][season];

    let nightlyBuyIn = 0;
    for (const unit of config.units) {
      const baseBuyIn = getBuyInRate(config.community, unit.bedrooms, propertyId);
      nightlyBuyIn += Math.round(baseBuyIn * multiplier);
    }
    const nightlySellRate = Math.round(nightlyBuyIn * MARKUP);

    nightlyBreakdown.push({ date: current.toISOString().split("T")[0], sellRate: nightlySellRate, season });
    totalSellRate += nightlySellRate;
    totalNights++;
    current.setDate(current.getDate() + 1);
  }

  return { totalSellRate, totalNights, nightlyBreakdown };
}

export { MARKUP as _MARKUP_TOTAL, SEASON_MULTIPLIERS, BUY_IN_RATES };
