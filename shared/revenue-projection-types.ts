// Shared output shapes for the dashboard revenue projection so the server
// aggregator (server/revenue-projection-aggregate.ts) and the client band
// (client/src/components/revenue-projection-band.tsx) can't drift. Pure types
// only — no runtime, no deps.

export interface RevenueProjectionMonth {
  month: string; // "YYYY-MM"
  label: string; // "Aug 2026"
  onBooksRevenue: number; // contracted guest revenue for stays this month
  baselineRevenue: number; // T30 run-rate × days in month (fill basis — operator choice 2026-07-23)
  projectedRevenue: number; // max(onBooks, baseline)
  onBooksPct: number; // onBooksRevenue / projectedRevenue (0..1)
  seasonalWeight: number; // baseline seasonal multiplier applied (1 = neutral)
  collections: number; // scheduled cash forecast due this month
  reservationCount: number;
  netProfit: number; // OTB: netRevenue − attachedCost − estimatedCost
  attachedCost: number;
  estimatedCost: number;
  openSlots: number; // slots on contracted stays with no covered buy-in
  unpricedSlots: number; // open slots we could not price (no known community)
}

export interface RevenueProjectionTrailing {
  collectedLast30: number;
  collectedPrev30: number;
  collectedLast60: number;
  collectedLast90: number;
  collectedLast365: number;
  collectedDailyAvg30: number;
  collectedRunRateAnnual: number; // dailyAvg30 × 365
  collectedMomentumPct: number | null; // (last30 − prev30) / prev30
  revenueLast30: number;
  revenuePrev30: number;
  revenueLast60: number;
  revenueLast90: number;
  revenueLast365: number;
  revenueDailyAvg30: number;
  revenueRunRateAnnual: number; // dailyAvg30 × 365
  revenueMomentumPct: number | null;
  revenuePrev365: number; // booking revenue in [today-730, today-365) — the prior year
  revenueYoyPct: number | null; // (last365 − prev365) / prev365, null when no prior-year data
  refundsLast30: number;
  refundsLast90: number;
}

// How the far-month baseline was shaped. `applied` = we had enough trailing
// stay-history to weight the baseline seasonally; otherwise it stays a flat
// 30-day run rate.
export interface RevenueProjectionSeasonality {
  applied: boolean;
  monthsOfHistory: number; // calendar months of the past year with realized stay revenue
}

export interface RevenueProjectionTotals {
  projectedRevenue12mo: number;
  onBooksRevenue12mo: number;
  projectedCollections12mo: number;
  projectedNetProfit12mo: number;
  attachedCost12mo: number;
  estimatedCost12mo: number;
  onBooksPct12mo: number;
  reservations: number;
  openSlots: number;
  unpricedSlots: number;
}

export interface RevenueProjectionSnapshot {
  ready: true;
  generatedAt: string;
  horizonMonths: number;
  months: RevenueProjectionMonth[];
  trailing: RevenueProjectionTrailing;
  totals: RevenueProjectionTotals;
  seasonality: RevenueProjectionSeasonality;
}

// What GET /api/dashboard/revenue-projection returns: the snapshot plus the
// cache timestamp, OR a not-ready sentinel before the first scheduler run.
export type RevenueProjectionResponse =
  | (RevenueProjectionSnapshot & { computedAt: string | null })
  | { ready: false; computedAt: string | null };
