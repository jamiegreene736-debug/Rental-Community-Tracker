// Pure, zero-DB helpers for the Claude-generated STATIC seasonal rate engine.
//
// This replaces the live Airbnb SearchAPI P40 random-7-night sampler
// (server/hybrid-pricing.ts) as the source of per-(property, bedroom)
// buy-in cost basis. Instead of scraping a random window per month, Claude
// produces ONE rate per season tier (LOW / HIGH / HOLIDAY) per YEAR, and we
// expand those 6 anchor values across the next 24 calendar months on a
// rolling basis. The expanded per-month values are written into the SAME
// `property_market_rates.monthlyRates` JSONB shape the Guesty push already
// reads (server/routes.ts buildBulkGuestySeasonalPlan), so the markup +
// push + scheduler + queue all keep working unchanged — only the rate
// SOURCE changes.
//
// Kept dependency-free (only imports the shared pricing tables) so it can be
// unit-tested without a DB or network.

import {
  BUY_IN_RATES,
  SEASON_MULTIPLIERS,
  getCommunityRegion,
  getSeasonForMonth,
  type SeasonType,
  type RegionType,
} from "./pricing-rates";

export type SeasonAnchors = {
  LOW: number;
  HIGH: number;
  HOLIDAY: number;
};

export type StaticRateAnchors = {
  // Year 1 = the next 12 months; Year 2 = months 13–24. "Rolling" means the
  // window always starts at the current month, so as time passes year-1 anchors
  // age out and year-2 becomes the new year-1 on the next regeneration.
  year1: SeasonAnchors;
  year2: SeasonAnchors;
};

export type SeasonLockFlags = {
  LOW?: boolean;
  HIGH?: boolean;
  HOLIDAY?: boolean;
};

export type StaticRateLocks = {
  year1?: SeasonLockFlags;
  year2?: SeasonLockFlags;
};

// Per-bedroom static plan persisted alongside the row (column `static_plan`).
export type StaticRateBedroomPlan = {
  bedrooms: number;
  anchors: StaticRateAnchors;
  locks: StaticRateLocks;
  // The operator-validated static seasonal basis used as the prior/clamp.
  staticBasis: SeasonAnchors;
  confidence: number; // 0–100, Claude's self-reported confidence
  reasoning: string;
  metricsUsed: string[];
};

export type StaticRatePlan = {
  generatedAt: string;
  model: string;
  source: "claude-static" | "static-fallback";
  summary: string;
  bedrooms: StaticRateBedroomPlan[];
};

export const STATIC_RATE_SEASONS: SeasonType[] = ["LOW", "HIGH", "HOLIDAY"];

// Year-over-year growth applied to year-2 anchors when Claude (or the static
// fallback) doesn't supply them explicitly. Conservative single-digit.
export const STATIC_RATE_YOY_GROWTH = 1.04;

// Months that should be priced from the HOLIDAY anchor rather than LOW/HIGH.
// At MONTH granularity (the Guesty push prices whole months) December is the
// dominant Christmas / New Year peak in both Hawaii and Florida. Short holiday
// windows inside other months are still covered by the separate lead-time
// scarcity push (unchanged), so this set is intentionally narrow.
export const STATIC_HOLIDAY_MONTHS = new Set<number>([12]);

// Operator-validated seasonal basis for a (community, bedrooms) pair, straight
// from BUY_IN_RATES × SEASON_MULTIPLIERS. This is the trusted prior Claude is
// anchored to and the clamp reference. Falls back to a per-region per-bedroom
// default when the exact community/bedroom isn't in the static table.
export function staticSeasonalBasis(community: string, bedrooms: number): SeasonAnchors {
  const entry = BUY_IN_RATES[community];
  const region: RegionType = entry?.region ?? getCommunityRegion(community);
  const key = `${bedrooms}BR` as "2BR" | "3BR" | "4BR" | "5BR";
  const baseline = typeof entry?.[key] === "number" && (entry[key] as number) > 0
    ? (entry[key] as number)
    : (region === "florida" ? 80 : 270) * Math.max(1, bedrooms);
  const mult = SEASON_MULTIPLIERS[region];
  return {
    LOW: Math.round(baseline * mult.LOW),
    HIGH: Math.round(baseline * mult.HIGH),
    HOLIDAY: Math.round(baseline * mult.HOLIDAY),
  };
}

// Sane default anchors when Claude is unavailable: the static seasonal basis
// for year 1, grown by STATIC_RATE_YOY_GROWTH for year 2.
export function defaultStaticAnchors(community: string, bedrooms: number): StaticRateAnchors {
  const basis = staticSeasonalBasis(community, bedrooms);
  const grow = (v: number) => Math.round(v * STATIC_RATE_YOY_GROWTH);
  return {
    year1: { ...basis },
    year2: { LOW: grow(basis.LOW), HIGH: grow(basis.HIGH), HOLIDAY: grow(basis.HOLIDAY) },
  };
}

function clampToBasis(value: number, basisSeason: number): number {
  if (!Number.isFinite(value) || value <= 0) return basisSeason;
  // Reject hallucinated/absurd anchors: keep within 0.4×–3× of the
  // operator-validated seasonal basis. Wide enough to let Claude move the
  // number meaningfully on real signal, tight enough to block a bad parse.
  const lo = Math.round(basisSeason * 0.4);
  const hi = Math.round(basisSeason * 3);
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

// Enforce LOW ≤ HIGH ≤ HOLIDAY within a year and clamp each season to its
// basis band. Returns a corrected copy; never throws.
export function sanitizeSeasonAnchors(anchors: Partial<SeasonAnchors>, basis: SeasonAnchors): SeasonAnchors {
  const low = clampToBasis(anchors.LOW ?? basis.LOW, basis.LOW);
  let high = clampToBasis(anchors.HIGH ?? basis.HIGH, basis.HIGH);
  let holiday = clampToBasis(anchors.HOLIDAY ?? basis.HOLIDAY, basis.HOLIDAY);
  high = Math.max(high, low);
  holiday = Math.max(holiday, high);
  return { LOW: low, HIGH: high, HOLIDAY: holiday };
}

// Full anchor sanitation across both years, plus a year-2 band check so a
// runaway year-2 can't drift more than +20% / −5% off year-1 per season.
export function sanitizeAnchors(anchors: Partial<StaticRateAnchors>, basis: SeasonAnchors): StaticRateAnchors {
  const year1 = sanitizeSeasonAnchors(anchors.year1 ?? {}, basis);
  const rawYear2 = sanitizeSeasonAnchors(anchors.year2 ?? {}, basis);
  const banded = (y2: number, y1: number) =>
    Math.min(Math.round(y1 * 1.2), Math.max(Math.round(y1 * 0.95), y2));
  const year2 = {
    LOW: banded(rawYear2.LOW, year1.LOW),
    HIGH: banded(rawYear2.HIGH, year1.HIGH),
    HOLIDAY: banded(rawYear2.HOLIDAY, year1.HOLIDAY),
  };
  // Re-assert ordering after banding.
  year2.HIGH = Math.max(year2.HIGH, year2.LOW);
  year2.HOLIDAY = Math.max(year2.HOLIDAY, year2.HIGH);
  return { year1, year2 };
}

// Merge freshly generated anchors with the operator's locked overrides: any
// season/year flagged locked keeps the PRIOR value instead of the new one.
export function mergeLockedAnchors(
  generated: StaticRateAnchors,
  locks: StaticRateLocks | undefined,
  prior: StaticRateAnchors | undefined,
): StaticRateAnchors {
  if (!locks || !prior) return generated;
  const apply = (
    yearKey: "year1" | "year2",
    season: SeasonType,
  ): number => {
    if (locks[yearKey]?.[season] && prior[yearKey] && typeof prior[yearKey][season] === "number") {
      return prior[yearKey][season];
    }
    return generated[yearKey][season];
  };
  return {
    year1: { LOW: apply("year1", "LOW"), HIGH: apply("year1", "HIGH"), HOLIDAY: apply("year1", "HOLIDAY") },
    year2: { LOW: apply("year2", "LOW"), HIGH: apply("year2", "HIGH"), HOLIDAY: apply("year2", "HOLIDAY") },
  };
}

// Month-granularity season classifier for the static engine. December is
// priced from the HOLIDAY anchor; every other month uses the existing
// LOW/HIGH map (getSeasonForMonth never returns HOLIDAY).
export function staticSeasonForMonth(yearMonth: string, region: RegionType): SeasonType {
  const month = Number(yearMonth.slice(5, 7));
  if (STATIC_HOLIDAY_MONTHS.has(month)) return "HOLIDAY";
  return getSeasonForMonth(yearMonth, region);
}

export type ExpandedMonthlyRate = {
  medianNightly: number;
  season: SeasonType;
  source: "claude-static";
  yearIndex: 1 | 2;
};

// Build the rolling 24-month window of yearMonth keys starting at `asOf`.
export function staticRateWindowMonths(asOf: Date, horizonMonths = 24): string[] {
  const months: string[] = [];
  for (let i = 0; i < horizonMonths; i += 1) {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() + i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

// Expand the 6 seasonal anchors into a per-month record matching the
// property_market_rates.monthlyRates shape consumed by buildBulkGuestySeasonalPlan.
// Months 0–11 use year1 anchors, 12–23 use year2.
export function expandAnchorsToMonthlyRates(
  anchors: StaticRateAnchors,
  community: string,
  asOf: Date,
  horizonMonths = 24,
): Record<string, ExpandedMonthlyRate> {
  const region: RegionType = BUY_IN_RATES[community]?.region ?? getCommunityRegion(community);
  const months = staticRateWindowMonths(asOf, horizonMonths);
  const out: Record<string, ExpandedMonthlyRate> = {};
  months.forEach((yearMonth, offset) => {
    const yearIndex: 1 | 2 = offset < 12 ? 1 : 2;
    const seasonAnchors = yearIndex === 1 ? anchors.year1 : anchors.year2;
    const season = staticSeasonForMonth(yearMonth, region);
    out[yearMonth] = {
      medianNightly: Math.round(seasonAnchors[season]),
      season,
      source: "claude-static",
      yearIndex,
    };
  });
  return out;
}

// Representative season basis columns (low/high/holiday) for the row, taken
// from the year-1 anchors so the Pricing-tab badges + getBuyInRate season
// fallback stay consistent with the calendar's first year.
export function seasonColumnsFromAnchors(anchors: StaticRateAnchors): { low: number; high: number; holiday: number } {
  return { low: anchors.year1.LOW, high: anchors.year1.HIGH, holiday: anchors.year1.HOLIDAY };
}
