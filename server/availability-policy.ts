export const DAILY_POLICY_RUN_HOUR_ET = 1;
export const DEFAULT_TIGHT_SCARCITY_MARKUP = 0.12;
export const DEFAULT_CRITICAL_SCARCITY_MARKUP = 0.40;

type AvailabilityPricingVerdict = "open" | "tight" | "blocked";

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
