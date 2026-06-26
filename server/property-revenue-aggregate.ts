// Pure aggregation for the dashboard "Total Revenue" column, split out from the
// scheduler so it can be unit-tested without importing the DB layer (the
// scheduler imports ./storage → ./db, which throws when DATABASE_URL is unset).
// Depends only on the pure guesty-money helpers.

import { reservationRevenue } from "./guesty-money";

export type EnrichedReservationLike = {
  operationsPropertyId?: number | null;
  checkIn?: string | null;
  checkInDateLocalized?: string | null;
  money?: unknown;
  [k: string]: unknown;
};

// Sums reservationRevenue() per operationsPropertyId for reservations whose
// CHECK-IN day falls within [windowStartISO, windowEndISO] (inclusive;
// YYYY-MM-DD compared lexicographically, which is correct for ISO dates). Rows
// with no usable property id, no in-window check-in, or a non-positive revenue
// figure are skipped — so a property only ever gets a row (and a "$ / N stays"
// tooltip) when it has real attributable revenue. This is a defensive re-filter
// ON TOP OF the server-side guesty-all check-in filter: it also bounds the
// merged manual reservations, which guesty-all does not date-filter.
export function aggregateRevenueByProperty(
  reservations: EnrichedReservationLike[],
  windowStartISO: string,
  windowEndISO: string,
): Map<number, { revenue: number; bookings: number }> {
  const byProperty = new Map<number, { revenue: number; bookings: number }>();
  for (const r of reservations) {
    const pid = Number(r?.operationsPropertyId);
    if (!Number.isFinite(pid) || pid === 0) continue;
    const checkIn = String(r?.checkInDateLocalized ?? r?.checkIn ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) continue;
    if (checkIn < windowStartISO || checkIn > windowEndISO) continue;
    const revenue = reservationRevenue(r);
    if (!(revenue > 0)) continue;
    const entry = byProperty.get(pid) ?? { revenue: 0, bookings: 0 };
    entry.revenue += revenue;
    entry.bookings += 1;
    byProperty.set(pid, entry);
  }
  return byProperty;
}
