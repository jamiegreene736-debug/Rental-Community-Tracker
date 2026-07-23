// Daily "cron" that refreshes the dashboard 12-month revenue projection +
// trailing run-rate. Modeled on server/property-revenue-scheduler.ts (and the
// other boot schedulers): it does NOT re-implement the account-wide Guesty pull
// or the listing→property mapping — it loopback self-calls the load-bearing
// GET /api/bookings/guesty-all TWICE, then hands both result sets to the pure
// aggregator (server/revenue-projection-aggregate.ts) and wholesale-replaces the
// single-row `revenue_projection` cache the dashboard reads.
//
// TWO pulls, because the two horizons need two different Guesty windows and
// guesty-all's filters are AND-combined:
//   • FORWARD (stay window): checkInFrom=today, checkInTo=today+365 — every
//     committed reservation CHECKING IN in the next year, regardless of when it
//     was booked. Each row carries slots[].buyIn + money → OTB revenue + cost.
//   • TRAILING (booking window): includePast=true, createdFrom=today-365,
//     createdTo=today — every booking MADE in the past year, for the trailing
//     revenue + collected-cash run-rate (bucketed by booking/payment date).
// The two overlap (a booking made last month for a stay next month is in both),
// but each feeds a different metric family, so nothing is double-counted.

import { storage } from "./storage";
import { loopbackRequestHeaders } from "./auth";
import {
  aggregateRevenueProjection,
  type ProjectionReservationLike,
} from "./revenue-projection-aggregate";

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
// After property-revenue's 90s boot run so the two heavy account-wide pulls
// don't collide on the first tick.
const INITIAL_DELAY_MS = 110_000;
const MAX_ROWS = 10000; // guesty-all clamps to <=10000
const HORIZON_MONTHS = 12;

export type RevenueProjectionRunResult = {
  ok: boolean;
  forwardReservations: number;
  trailingReservations: number;
  projectedRevenue12mo: number;
  projectedNetProfit12mo: number;
  message: string;
};

let _enabled = true;
let _running = false;
let _lastRunAt: Date | null = null;
let _lastRunResult: RevenueProjectionRunResult | null = null;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function pullReservations(query: string): Promise<ProjectionReservationLike[]> {
  const port = process.env.PORT || "5000";
  const url = `http://127.0.0.1:${port}/api/bookings/guesty-all?${query}`;
  const resp = await fetch(url, { headers: loopbackRequestHeaders() });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`guesty-all ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { reservations?: ProjectionReservationLike[] };
  return Array.isArray(data?.reservations) ? data.reservations : [];
}

export async function runRevenueProjectionRefresh(): Promise<RevenueProjectionRunResult> {
  const now = new Date();
  const nowMs = now.getTime();
  const today = isoDay(now);
  const forwardEnd = isoDay(new Date(nowMs + 365 * DAY_MS));
  const trailingStart = isoDay(new Date(nowMs - 365 * DAY_MS));

  const [forwardStayReservations, trailingBookingReservations] = await Promise.all([
    pullReservations(`checkInFrom=${today}&checkInTo=${forwardEnd}&maxRows=${MAX_ROWS}`),
    pullReservations(`includePast=true&createdFrom=${trailingStart}&createdTo=${today}&maxRows=${MAX_ROWS}`),
  ]);

  const snapshot = aggregateRevenueProjection({
    forwardStayReservations,
    trailingBookingReservations,
    nowMs,
    horizonMonths: HORIZON_MONTHS,
  });
  await storage.replaceRevenueProjection(snapshot);

  const result: RevenueProjectionRunResult = {
    ok: true,
    forwardReservations: forwardStayReservations.length,
    trailingReservations: trailingBookingReservations.length,
    projectedRevenue12mo: snapshot.totals.projectedRevenue12mo,
    projectedNetProfit12mo: snapshot.totals.projectedNetProfit12mo,
    message:
      `Projection refreshed: ${snapshot.totals.reservations} on-the-books reservation(s), ` +
      `12-mo revenue ~$${snapshot.totals.projectedRevenue12mo.toLocaleString()}, ` +
      `net profit ~$${snapshot.totals.projectedNetProfit12mo.toLocaleString()}`,
  };
  _lastRunAt = now;
  _lastRunResult = result;
  return result;
}

async function safeRun(trigger: string): Promise<void> {
  if (_running) {
    console.log(`[revenue-projection] ${trigger} run skipped — a refresh is already in progress`);
    return;
  }
  _running = true;
  try {
    const result = await runRevenueProjectionRefresh();
    console.log(`[revenue-projection] ${result.message}`);
  } catch (e: any) {
    _lastRunAt = new Date();
    _lastRunResult = {
      ok: false,
      forwardReservations: 0,
      trailingReservations: 0,
      projectedRevenue12mo: 0,
      projectedNetProfit12mo: 0,
      message: `Refresh failed: ${e?.message ?? e}`,
    };
    console.warn(`[revenue-projection] ${trigger} refresh failed:`, e?.message ?? e);
  } finally {
    _running = false;
  }
}

export function startRevenueProjectionScheduler(): void {
  if (process.env.REVENUE_PROJECTION_DISABLED === "1") {
    _enabled = false;
    console.log("[revenue-projection] Scheduler disabled via REVENUE_PROJECTION_DISABLED");
    return;
  }
  setTimeout(() => { void safeRun("boot"); }, INITIAL_DELAY_MS);
  setInterval(() => { void safeRun("interval"); }, REFRESH_INTERVAL_MS);
  console.log("[revenue-projection] Scheduler started (daily 12-month projection refresh)");
}

export function getRevenueProjectionStatus() {
  return { enabled: _enabled, running: _running, lastRunAt: _lastRunAt, lastRunResult: _lastRunResult };
}
