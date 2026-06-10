// Profitability gate for buy-in auto-fill. Pure + dependency-free so both the
// server (auto-fill-job, city-vrbo-expansion) and tests can use it, and so the
// gate's profit matches the bookings-page number the operator already trusts:
//   profit = expectedRevenue - existingAttachedCost - comboCost
// where expectedRevenue is the CLIENT's getNetRevenue(reservation)
// (hostPayout -> netIncome -> fareAccommodation -> totalPaid) passed through.
//
// Accept when profit >= -tolerance. The operator set a HARD MAX-LOSS LIMIT of
// $100 (2026-06-08): a combo is matched as long as it loses no more than $100,
// and rejected the moment the projected loss exceeds $100 — regardless of stay
// size. That's a FLAT tolerance: flat = $100, pct = 0 (so max(flat, pct*revenue)
// == 100 for any known revenue). The pct knob is kept (env-overridable) but off
// by default; do NOT reintroduce a revenue-percentage tolerance without an
// operator ask — it let a big stay lose ~2% (≈$198 on a $9.9k booking), which is
// exactly what the $100 cap replaced.
//
// DEGRADE SAFE: revenue <= 0 / unknown (manual reservations, inquiries) disables
// the gate (attach as before) — refusing there would silently break those flows.

export const DEFAULT_PROFIT_MIN_FLAT_USD = 100;
export const DEFAULT_PROFIT_MIN_PCT = 0;
// OPT-IN positive margin floor (0 = off, preserves the $100 max-loss model).
// When > 0 the gate flips from "lose no more than the flat cap" to "a combo
// must CLEAR this fraction of revenue in profit". Off by default — see
// minAcceptableProfit for why this is the wrong lever to *create* margin.
export const DEFAULT_PROFIT_MARGIN_FLOOR_PCT = 0;

export function profitToleranceUsd(
  revenue: number,
  flat: number = DEFAULT_PROFIT_MIN_FLAT_USD,
  pct: number = DEFAULT_PROFIT_MIN_PCT,
): number {
  if (!Number.isFinite(revenue) || revenue <= 0) return 0;
  return Math.max(flat, pct * revenue);
}

// The minimum acceptable profit for a combo at the given revenue.
//
// DEFAULT (marginFloorPct <= 0) = the HARD MAX-LOSS model: minProfit =
// -tolerance, so small losses up to the flat cap ($100) still attach. This is
// the operator's 2026-06-08 "don't lose more than $100" rule and keeps a
// booked guest from being left unhoused over a few dollars.
//
// OPT-IN (marginFloorPct > 0, env AUTOFILL_PROFIT_MARGIN_FLOOR_PCT) = a
// POSITIVE MARGIN FLOOR: a combo must clear `marginFloorPct × revenue` in
// profit or it is rejected and the slots are left empty.
//
// IMPORTANT (why it's off by default): this gate runs at FULFILMENT time, when
// the guest's revenue is ALREADY fixed by the sell price set at booking. A
// hard floor here cannot CREATE margin — it can only REFUSE to fulfil thin
// already-sold bookings (leaving slots empty for manual review). Margin is won
// UPSTREAM at the sell price (baseRateForTargetMargin + Guesty channel
// markups). Use this floor to refuse to over-pay on a fresh search, not as the
// primary way to hit a target margin.
export function minAcceptableProfit(
  revenue: number,
  flat: number = DEFAULT_PROFIT_MIN_FLAT_USD,
  pct: number = DEFAULT_PROFIT_MIN_PCT,
  marginFloorPct: number = DEFAULT_PROFIT_MARGIN_FLOOR_PCT,
): number {
  if (!Number.isFinite(revenue) || revenue <= 0) return 0;
  if (marginFloorPct > 0) return Math.ceil(marginFloorPct * revenue);
  return -profitToleranceUsd(revenue, flat, pct);
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
  marginFloorPct?: number;
}): ProfitVerdict {
  const revenue = Number(args.expectedRevenue) || 0;
  const existingCost = Number(args.existingCost) || 0;
  const comboCost = Number(args.comboCost) || 0;
  const gateEnabled = revenue > 0;
  const tolerance = profitToleranceUsd(revenue, args.flat, args.pct);
  const minProfit = minAcceptableProfit(revenue, args.flat, args.pct, args.marginFloorPct);
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
