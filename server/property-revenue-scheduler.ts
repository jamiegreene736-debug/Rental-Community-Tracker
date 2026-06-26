// Daily "cron" that refreshes the dashboard "Total Revenue" column: trailing-
// 365-day revenue per property, keyed by the dashboard property id (the
// enriched reservation's `operationsPropertyId` — positive core ids, negative
// -draftId for mapped published drafts). Modeled on the other in-process boot
// schedulers (server/booking-confirmations.ts, server/guest-receipts.ts).
//
// It does NOT re-implement the account-wide Guesty pull or the listing→property
// mapping. It loopback self-calls the existing, load-bearing
// GET /api/bookings/guesty-all (committed-only, manual reservations merged, each
// row carrying operationsPropertyId + checkIn + money) with the new
// checkInFrom/checkInTo filter so only the trailing-365-day window comes back —
// then sums reservationRevenue() per property and wholesale-replaces the
// property_trailing_revenue cache the dashboard reads.
//
// Attribution convention: a reservation counts toward a property's window if its
// CHECK-IN date falls in [windowStart, windowEnd] (i.e. revenue from stays that
// began in the past year). Documented in the column tooltip + AGENTS.md.

import { storage } from "./storage";
import { loopbackRequestHeaders } from "./auth";
import { aggregateRevenueByProperty, type EnrichedReservationLike } from "./property-revenue-aggregate";
import type { InsertPropertyTrailingRevenue } from "@shared/schema";

const WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
// First run after the rest of the boot schedulers settle and the loopback
// self-call target (/api/bookings/guesty-all) is live + warm.
const INITIAL_DELAY_MS = 90_000;
// Hard cap on the account-wide pull; guesty-all clamps this to <=10000.
const MAX_ROWS = 10000;

export type PropertyRevenueRunResult = {
  ok: boolean;
  properties: number;
  reservations: number;
  totalRevenue: number;
  windowStart: string;
  windowEnd: string;
  message: string;
};

let _enabled = true;
let _running = false;
let _lastRunAt: Date | null = null;
let _lastRunResult: PropertyRevenueRunResult | null = null;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runPropertyRevenueRefresh(): Promise<PropertyRevenueRunResult> {
  const now = new Date();
  const windowEnd = isoDay(now);
  const windowStart = isoDay(new Date(now.getTime() - WINDOW_DAYS * DAY_MS));
  const port = process.env.PORT || "5000";
  const url =
    `http://127.0.0.1:${port}/api/bookings/guesty-all` +
    `?includePast=true&checkInFrom=${windowStart}&checkInTo=${windowEnd}&maxRows=${MAX_ROWS}`;

  const resp = await fetch(url, { headers: loopbackRequestHeaders() });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`guesty-all ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { reservations?: EnrichedReservationLike[] };
  const reservations = Array.isArray(data?.reservations) ? data.reservations : [];

  const byProperty = aggregateRevenueByProperty(reservations, windowStart, windowEnd);
  const rows: InsertPropertyTrailingRevenue[] = Array.from(byProperty.entries()).map(
    ([propertyId, v]) => ({
      propertyId,
      revenue: v.revenue.toFixed(2), // numeric column → string
      currency: "USD",
      bookings: v.bookings,
      windowDays: WINDOW_DAYS,
      computedAt: now,
    }),
  );
  await storage.replacePropertyTrailingRevenue(rows);

  const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue), 0);
  const result: PropertyRevenueRunResult = {
    ok: true,
    properties: rows.length,
    reservations: reservations.length,
    totalRevenue,
    windowStart,
    windowEnd,
    message: `Refreshed trailing-${WINDOW_DAYS}d revenue for ${rows.length} propert${rows.length === 1 ? "y" : "ies"} from ${reservations.length} reservation(s)`,
  };
  _lastRunAt = now;
  _lastRunResult = result;
  return result;
}

async function safeRun(trigger: string): Promise<void> {
  if (_running) {
    console.log(`[property-revenue] ${trigger} run skipped — a refresh is already in progress`);
    return;
  }
  _running = true;
  try {
    const result = await runPropertyRevenueRefresh();
    console.log(`[property-revenue] ${result.message} (window ${result.windowStart}..${result.windowEnd})`);
  } catch (e: any) {
    _lastRunAt = new Date();
    _lastRunResult = {
      ok: false,
      properties: 0,
      reservations: 0,
      totalRevenue: 0,
      windowStart: "",
      windowEnd: "",
      message: `Refresh failed: ${e?.message ?? e}`,
    };
    console.warn(`[property-revenue] ${trigger} refresh failed:`, e?.message ?? e);
  } finally {
    _running = false;
  }
}

export function startPropertyRevenueScheduler(): void {
  if (process.env.PROPERTY_REVENUE_DISABLED === "1") {
    _enabled = false;
    console.log("[property-revenue] Scheduler disabled via PROPERTY_REVENUE_DISABLED");
    return;
  }
  setTimeout(() => { void safeRun("boot"); }, INITIAL_DELAY_MS);
  setInterval(() => { void safeRun("interval"); }, REFRESH_INTERVAL_MS);
  console.log("[property-revenue] Scheduler started (daily trailing-365d refresh)");
}

export function getPropertyRevenueStatus() {
  return { enabled: _enabled, running: _running, lastRunAt: _lastRunAt, lastRunResult: _lastRunResult };
}
