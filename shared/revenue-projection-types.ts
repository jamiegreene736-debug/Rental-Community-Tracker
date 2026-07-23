// Shared output shapes for the dashboard revenue projection so the server
// aggregator (server/revenue-projection-aggregate.ts) and the client band
// (client/src/components/revenue-projection-band.tsx) can't drift. Pure types
// only — no runtime, no deps.

export interface RevenueProjectionMonth {
  month: string; // "YYYY-MM"
  label: string; // "Aug 2026"
  onBooksRevenue: number; // contracted guest revenue for stays this month
  baselineRevenue: number; // T90 run-rate × days in month (Phase 1 fill)
  projectedRevenue: number; // max(onBooks, baseline)
  onBooksPct: number; // onBooksRevenue / projectedRevenue (0..1)
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
  collectedDailyAvg90: number;
  collectedRunRateAnnual: number; // dailyAvg90 × 365
  collectedMomentumPct: number | null; // (last30 − prev30) / prev30
  revenueLast30: number;
  revenuePrev30: number;
  revenueLast60: number;
  revenueLast90: number;
  revenueLast365: number;
  revenueDailyAvg90: number;
  revenueRunRateAnnual: number;
  revenueMomentumPct: number | null;
  refundsLast30: number;
  refundsLast90: number;
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
}

// What GET /api/dashboard/revenue-projection returns: the snapshot plus the
// cache timestamp, OR a not-ready sentinel before the first scheduler run.
export type RevenueProjectionResponse =
  | (RevenueProjectionSnapshot & { computedAt: string | null })
  | { ready: false; computedAt: string | null };
