export const DAILY_POLICY_RUN_HOUR_ET = 1;
export const DEFAULT_TIGHT_SCARCITY_MARKUP = 0.12;
export const DEFAULT_CRITICAL_SCARCITY_MARKUP = 0.40;
export const DEFAULT_STANDARD_LEAD_TIME_MARKUP = 0.15;
export const DEFAULT_HIGH_SEASON_LEAD_TIME_MARKUP = 0.25;
export const DEFAULT_MAJOR_HOLIDAY_LEAD_TIME_MARKUP = 0.40;
export const DEFAULT_ULTRA_PEAK_LEAD_TIME_MARKUP = 0.50;

type AvailabilityPricingVerdict = "open" | "tight" | "blocked";
export type LeadTimePricingBand = "standard" | "high" | "majorHoliday" | "ultraPeak";

// ─────────────────────────────────────────────────────────────────────────
// LAST-MINUTE (lead-time) PRICING MARKUP — 2026-06-14 redesign.
//
// Old scheme: an escalating per-SEASON-band surcharge (standard +15% / high
// +25% / holiday +40% / ultra +50%) applied to EVERY date within 45/75/90/120
// days of arrival. That priced us above market for near-term dates 6+ weeks
// out where our actual buy-in cost had NOT yet risen, and (since we hold no
// inventory) an over-market date just doesn't book.
//
// We measured the real premium from 479 of our own VRBO scrapes: cost/night is
// flat until ~14 days out, then ~+6% (days 8-14) and ~+13% (final 7 days). So
// the markup is now a single FLAT surcharge that only applies inside the final
// LAST_MINUTE_MARKUP_DAYS — enough to cover the genuine final-fortnight bump
// without pricing out the long lead-time bookings that are ~95% of demand.
// See memory: leadtime-markup-vs-buyin-profit-analysis.
export const LAST_MINUTE_MARKUP_DAYS = 14;   // only dates within 14 days of arrival
export const LAST_MINUTE_MARKUP_PCT = 0.15;  // flat +15% (covers the measured ~+13% final-week cost bump)

export function lastMinuteMarkupForDaysUntilArrival(daysUntilArrival: number): number {
  return daysUntilArrival <= LAST_MINUTE_MARKUP_DAYS ? LAST_MINUTE_MARKUP_PCT : 0;
}

export function lastMinuteDemandFactor(daysUntilArrival: number): number {
  return 1 + lastMinuteMarkupForDaysUntilArrival(daysUntilArrival);
}

// DEPRECATED for pricing (2026-06-14): the band-escalating lead-time markup is
// no longer used to push rates — see lastMinuteDemandFactor above. Retained
// only so the season-band constants/type still resolve for any band-model
// reference; do NOT reintroduce this into a Guesty rate push.
export function leadTimeMarkupForPolicyBand(band: LeadTimePricingBand | null | undefined): number {
  if (band === "ultraPeak") return DEFAULT_ULTRA_PEAK_LEAD_TIME_MARKUP;
  if (band === "majorHoliday") return DEFAULT_MAJOR_HOLIDAY_LEAD_TIME_MARKUP;
  if (band === "high") return DEFAULT_HIGH_SEASON_LEAD_TIME_MARKUP;
  return DEFAULT_STANDARD_LEAD_TIME_MARKUP;
}

/** @deprecated for pricing — use {@link lastMinuteDemandFactor}. */
export function demandFactorForPolicyBand(band: LeadTimePricingBand | null | undefined): number {
  return 1 + leadTimeMarkupForPolicyBand(band);
}

export function demandFactorForAvailabilityVerdict(
  verdict: AvailabilityPricingVerdict,
  opts: { tightMarkup?: number; criticalMarkup?: number } = {},
): number {
  if (verdict === "tight") return 1 + (opts.tightMarkup ?? DEFAULT_TIGHT_SCARCITY_MARKUP);
  if (verdict === "blocked") return 1 + (opts.criticalMarkup ?? DEFAULT_CRITICAL_SCARCITY_MARKUP);
  return 1;
}

function easternParts(date: Date): { dateKey: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
  };
}

export function isDueForPolicyPass(lastRunAt: Date | null | undefined, now = new Date(), _intervalHours = 24): boolean {
  const nowEt = easternParts(now);
  if (nowEt.hour < DAILY_POLICY_RUN_HOUR_ET) return false;
  if (!lastRunAt) return true;
  return easternParts(lastRunAt).dateKey !== nowEt.dateKey;
}
