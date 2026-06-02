export const DAILY_POLICY_RUN_HOUR_ET = 1;
export const DEFAULT_TIGHT_SCARCITY_MARKUP = 0.12;
export const DEFAULT_CRITICAL_SCARCITY_MARKUP = 0.40;
export const DEFAULT_STANDARD_LEAD_TIME_MARKUP = 0.15;
export const DEFAULT_HIGH_SEASON_LEAD_TIME_MARKUP = 0.25;
export const DEFAULT_MAJOR_HOLIDAY_LEAD_TIME_MARKUP = 0.40;
export const DEFAULT_ULTRA_PEAK_LEAD_TIME_MARKUP = 0.50;

type AvailabilityPricingVerdict = "open" | "tight" | "blocked";
export type LeadTimePricingBand = "standard" | "high" | "majorHoliday" | "ultraPeak";

export function leadTimeMarkupForPolicyBand(band: LeadTimePricingBand | null | undefined): number {
  if (band === "ultraPeak") return DEFAULT_ULTRA_PEAK_LEAD_TIME_MARKUP;
  if (band === "majorHoliday") return DEFAULT_MAJOR_HOLIDAY_LEAD_TIME_MARKUP;
  if (band === "high") return DEFAULT_HIGH_SEASON_LEAD_TIME_MARKUP;
  return DEFAULT_STANDARD_LEAD_TIME_MARKUP;
}

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
