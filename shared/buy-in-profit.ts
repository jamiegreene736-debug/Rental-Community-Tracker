// Profitability gate for buy-in auto-fill. Pure + dependency-free so both the
// server (auto-fill-job, city-vrbo-expansion) and tests can use it, and so the
// gate's profit matches the bookings-page number the operator already trusts:
//   profit = expectedRevenue - existingAttachedCost - comboCost
// where expectedRevenue is the CLIENT's getNetRevenue(reservation)
// (hostPayout -> netIncome -> fareAccommodation -> totalPaid) passed through.
//
// "Profitable and/or roughly break even" => accept when profit >= -tolerance,
// tolerance = max(flat, pct * revenue) so a tiny loss on a big stay is noise but
// a real loss on a small stay is rejected.
//
// DEGRADE SAFE: revenue <= 0 / unknown (manual reservations, inquiries) disables
// the gate (attach as before) — refusing there would silently break those flows.

export const DEFAULT_PROFIT_MIN_FLAT_USD = 50;
export const DEFAULT_PROFIT_MIN_PCT = 0.02;

export function profitToleranceUsd(
  revenue: number,
  flat: number = DEFAULT_PROFIT_MIN_FLAT_USD,
  pct: number = DEFAULT_PROFIT_MIN_PCT,
): number {
  if (!Number.isFinite(revenue) || revenue <= 0) return 0;
  return Math.max(flat, pct * revenue);
}

export type ProfitVerdict = {
  /** false when revenue is unknown/<=0 — the gate is bypassed (attach as today). */
  gateEnabled: boolean;
  profit: number;
  tolerance: number;
  /** the minimum acceptable profit (== -tolerance). */
  minProfit: number;
  /** true => OK to attach this combo. */
  acceptable: boolean;
};

export function evaluateComboProfit(args: {
  expectedRevenue: number;
  existingCost: number;
  comboCost: number;
  flat?: number;
  pct?: number;
}): ProfitVerdict {
  const revenue = Number(args.expectedRevenue) || 0;
  const existingCost = Number(args.existingCost) || 0;
  const comboCost = Number(args.comboCost) || 0;
  const gateEnabled = revenue > 0;
  const tolerance = profitToleranceUsd(revenue, args.flat, args.pct);
  const minProfit = -tolerance;
  const profit = revenue - existingCost - comboCost;
  const acceptable = !gateEnabled || profit >= minProfit;
  return { gateEnabled, profit, tolerance, minProfit, acceptable };
}

/**
 * Lower-level gate used where the caller has already netted revenue against
 * existing cost (e.g. the expansion worker, which is handed revenueAvailable +
 * minProfit rather than the raw revenue). Keeps the accept rule identical.
 */
export function comboProfitAcceptable(args: {
  revenueAvailable: number;
  comboCost: number;
  minProfit: number;
  gateEnabled: boolean;
}): { profit: number; acceptable: boolean } {
  const profit = (Number(args.revenueAvailable) || 0) - (Number(args.comboCost) || 0);
  const acceptable = !args.gateEnabled || profit >= args.minProfit;
  return { profit, acceptable };
}
