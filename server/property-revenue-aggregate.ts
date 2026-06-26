// Pure aggregation for the dashboard "Total Revenue" column, split out from the
// scheduler so it can be unit-tested without importing the DB layer (the
// scheduler imports ./storage → ./db, which throws when DATABASE_URL is unset).
// Depends only on the pure guesty-money helpers.

import { reservationRevenue } from "./guesty-money";

export type EnrichedReservationLike = {
  operationsPropertyId?: number | null;
  createdAt?: string | Date | null;
  money?: unknown;
  [k: string]: unknown;
};

// Resolve a reservation's BOOKING DATE (when the booking was made) as a
// YYYY-MM-DD day. We attribute revenue by booking date — NOT by stay/check-in
// date — because the operator's portfolio is heavily forward-booked (most stays
// are upcoming), so a stay-date window would leave nearly every property blank.
// `createdAt` is the field guesty-all returns + the same field its server-side
// createdAt filter bounds on, so aggregation and the pull stay consistent.
export function bookingDayOf(r: EnrichedReservationLike): string {
  const raw = r?.createdAt;
  const s = raw instanceof Date ? raw.toISOString() : String(raw ?? "");
  return s.slice(0, 10);
}

// Sums reservationRevenue() per operationsPropertyId for reservations BOOKED
// (created) within [windowStartISO, windowEndISO] (inclusive; YYYY-MM-DD
// compared lexicographically, which is correct for ISO dates). Rows with no
// usable property id, no in-window booking date, or a non-positive revenue
// figure are skipped — so a property only ever gets a row (and a "$ / N
// bookings" tooltip) when it has real attributable revenue. This is a defensive
// re-filter ON TOP OF the server-side guesty-all createdAt filter: it also
// bounds the merged manual reservations, which guesty-all does not date-filter.
export function aggregateRevenueByProperty(
  reservations: EnrichedReservationLike[],
  windowStartISO: string,
  windowEndISO: string,
): Map<number, { revenue: number; bookings: number }> {
  const byProperty = new Map<number, { revenue: number; bookings: number }>();
  for (const r of reservations) {
    const pid = Number(r?.operationsPropertyId);
    if (!Number.isFinite(pid) || pid === 0) continue;
    const bookedDay = bookingDayOf(r);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookedDay)) continue;
    if (bookedDay < windowStartISO || bookedDay > windowEndISO) continue;
    const revenue = reservationRevenue(r);
    if (!(revenue > 0)) continue;
    const entry = byProperty.get(pid) ?? { revenue: 0, bookings: 0 };
    entry.revenue += revenue;
    entry.bookings += 1;
    byProperty.set(pid, entry);
  }
  return byProperty;
}
