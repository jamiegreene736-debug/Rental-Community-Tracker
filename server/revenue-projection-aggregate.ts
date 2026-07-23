// Pure aggregation for the dashboard 12-month revenue projection + the improved
// trailing run-rate. Split out from the scheduler (server/revenue-projection-
// scheduler.ts) so it can be unit-tested without importing the DB layer — it
// depends only on the pure money/pricing helpers, mirroring the
// property-revenue-aggregate.ts pattern.
//
// TWO horizons, two very different methods (Phase 1):
//
//   1. TRAILING run-rate (backward-looking "how am I doing / growth"). Replaces
//      the old naive "(last 3 days ÷ 3) × 365" forecast basis. We compute
//      T30/T60/T90/T365 windows for BOTH collected cash (by payment date) and
//      booking revenue (by booking date), plus a T30-vs-prior-30 momentum %.
//      The stable headline is the T90 daily average.
//
//   2. FORWARD 12-month projection (the real ask), bucketed by STAY month — NOT
//      booking date — because that is when revenue is earned and buy-in cost is
//      incurred. The anchor is ON-THE-BOOKS (OTB): revenue already contracted
//      for each future month. Since the portfolio is heavily forward-booked,
//      the near months are largely known, not guessed. For the far months that
//      are only sparsely booked, Phase 1 fills the gap with a flat T90 run-rate
//      BASELINE: projectedRevenue[m] = max(OTB[m], baseline[m]). Taking the max
//      (never a sum) means a near month that is already booking strongly keeps
//      its real OTB figure and is never inflated, while a far month that nobody
//      has booked yet floats up to the run-rate expectation instead of reading
//      near-zero. Each month exposes onBooksPct = OTB / projected so the UI can
//      show "X% on the books, Y% estimated". Phase 2 replaces the flat baseline
//      with a seasonally-weighted one (property_market_rates monthly curve).
//
// NET PROFIT is deliberately OTB-only (contracted reservations): for each
// forward reservation, netRevenue − attached buy-in cost − estimated cost of any
// slot not yet bought in. It never assumes profit on a hypothetical unbooked
// stay. The estimated open-slot cost mirrors the bookings page's
// estimateRemainingBuyInCost (market-rate table via totalNightlyBuyInForMonth),
// and attached cost prefers the actually-paid rate (buy_ins.paidRate) over the
// recorded estimate (buy_ins.costPaid).

import {
  asNum,
  reservationRevenue,
  paymentAmount,
  collectedPaymentsForReceipts,
  realRefundsForReceipts,
  localizedStayDate,
} from "./guesty-money";
import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import { totalNightlyBuyInForMonth } from "@shared/pricing-rates";
import {
  scheduledChargeDateIso,
  paymentRowLooksScheduled,
  type GuestyPaymentRow,
} from "@shared/guesty-payment-schedule";
import type {
  RevenueProjectionMonth,
  RevenueProjectionTrailing,
  RevenueProjectionTotals,
  RevenueProjectionSnapshot,
  RevenueProjectionSeasonality,
} from "@shared/revenue-projection-types";

export type {
  RevenueProjectionMonth,
  RevenueProjectionTrailing,
  RevenueProjectionTotals,
  RevenueProjectionSnapshot,
  RevenueProjectionSeasonality,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCLUDED_STATUS_RE = /cancel|declin|inquir|request|expired|closed/;

// Seasonal baseline (Phase 2): shape the flat run-rate fill by the portfolio's
// own realized seasonality. Only apply when the trailing year has enough
// calendar months with revenue to be a signal, and clamp each month's weight so
// one outlier month can't produce a wild baseline.
const MIN_SEASONAL_MONTHS = 6;
const SEASONAL_WEIGHT_MIN = 0.4;
const SEASONAL_WEIGHT_MAX = 2.0;

export interface ProjectionSlotLike {
  unitId?: string;
  bedrooms?: number;
  community?: string;
  buyIn?: {
    status?: string | null;
    costPaid?: string | number | null;
    paidRate?: string | number | null;
  } | null;
}

export interface ProjectionReservationLike {
  _id?: string;
  id?: string;
  status?: string;
  createdAt?: string | Date | null;
  checkIn?: string | null;
  checkOut?: string | null;
  checkInDateLocalized?: string | null;
  checkOutDateLocalized?: string | null;
  nightsCount?: number;
  nights?: number;
  operationsPropertyId?: number | null;
  money?: any;
  payments?: any;
  slots?: ProjectionSlotLike[];
  [k: string]: unknown;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map((s) => Number(s));
  if (!y || !m || m < 1 || m > 12) return monthKey;
  return `${MONTH_LABELS[m - 1]} ${y}`;
}

function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split("-").map((s) => Number(s));
  if (!y || !m) return 30;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Rolling list of the next `count` month keys ("YYYY-MM") starting at the month
// containing `nowMs`. Built off the UTC month index — a projection is a
// calendar-month rollup, so the exact TZ boundary is immaterial.
function forwardMonthKeys(nowMs: number, count: number): string[] {
  const d = new Date(nowMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth(); // 0-based
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return keys;
}

function reservationId(r: ProjectionReservationLike): string {
  return String(r?._id ?? r?.id ?? "");
}

function isExcludedStatus(r: ProjectionReservationLike): boolean {
  return EXCLUDED_STATUS_RE.test(String(r?.status ?? "").toLowerCase());
}

function bookingDate(r: ProjectionReservationLike): Date | null {
  const raw = r?.createdAt;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Stay length in nights, from the guest-LOCAL calendar dates (localizedStayDate
// avoids the UTC day-drift Guesty's raw checkIn carries). Falls back to a
// nights count, then to 1 so a cost estimate is never multiplied by 0.
function stayNights(r: ProjectionReservationLike): number {
  const ci = localizedStayDate(r, "in");
  const co = localizedStayDate(r, "out");
  if (ci && co) {
    const n = Math.round((Date.parse(co) - Date.parse(ci)) / DAY_MS);
    if (n > 0) return n;
  }
  const nc = asNum(r?.nightsCount ?? r?.nights);
  return nc > 0 ? Math.round(nc) : 1;
}

// Net revenue basis for PROFIT (what we actually keep), mirroring the bookings
// page getNetRevenue: hostPayout → netIncome → gross(fareAccommodation →
// hostPayout → totalPaid). Distinct from reservationRevenue (guest top-line),
// which drives the revenue projection.
function reservationNetRevenue(r: ProjectionReservationLike): number {
  const money = r?.money ?? {};
  const gross =
    asNum(money.fareAccommodation) || asNum(money.hostPayout) || asNum(money.totalPaid);
  return asNum(money.hostPayout) || asNum(money.netIncome) || gross;
}

// A slot's real buy-in COST, or null when the slot has no covered buy-in (open).
// A cancelled buy-in does not count as coverage. Prefers the actually-paid rate
// (paidRate, extracted from alias emails) over the recorded estimate (costPaid).
// Both are stay TOTALS (not nightly), so they are summed directly.
function slotBuyInCost(slot: ProjectionSlotLike): number | null {
  const buyIn = slot?.buyIn;
  if (!buyIn || typeof buyIn !== "object") return null;
  if (String(buyIn.status ?? "").toLowerCase().includes("cancel")) return null;
  const paid = asNum(buyIn.paidRate);
  if (paid > 0) return paid;
  const cost = asNum(buyIn.costPaid);
  return cost >= 0 ? cost : 0;
}

// The community used to price OPEN slots: the property's configured community
// (positive core ids), else a community carried on a slot (ad-hoc listings).
function resolveCommunity(r: ProjectionReservationLike): string | null {
  const pid = Number(r?.operationsPropertyId);
  if (Number.isFinite(pid) && pid > 0) {
    const c = PROPERTY_UNIT_CONFIGS[pid]?.community;
    if (c) return c;
  }
  const slots = Array.isArray(r?.slots) ? r.slots : [];
  const withCommunity = slots.find(
    (s) => typeof s?.community === "string" && s.community!.trim(),
  );
  return withCommunity?.community ?? null;
}

// Scheduled (not-yet-collected) cash for a reservation, as {monthKey, amount}
// rows dated by Guesty's scheduled charge date. Falls back to attributing the
// whole outstanding balance (revenue − totalPaid) to the check-in month when
// Guesty exposes no schedule rows — so the collections forecast isn't blank for
// reservations without an explicit payment plan.
function scheduledCollections(
  r: ProjectionReservationLike,
): Array<{ month: string; amount: number }> {
  const money = r?.money ?? {};
  const rows: GuestyPaymentRow[] = [
    ...(Array.isArray(r?.payments) ? r.payments : []),
    ...(Array.isArray(money?.payments) ? money.payments : []),
    ...(Array.isArray(money?.paymentSchedule) ? money.paymentSchedule : []),
  ];
  const out: Array<{ month: string; amount: number }> = [];
  let sawSchedule = false;
  for (const row of rows) {
    if (!paymentRowLooksScheduled(row)) continue;
    const iso = scheduledChargeDateIso(row);
    if (!iso) continue;
    const amount = paymentAmount(row);
    if (!(amount > 0)) continue;
    sawSchedule = true;
    out.push({ month: iso.slice(0, 7), amount });
  }
  if (!sawSchedule) {
    const outstanding = reservationRevenue(r) - asNum(money.totalPaid);
    if (outstanding > 0) {
      const ci = localizedStayDate(r, "in");
      if (ci) out.push({ month: ci.slice(0, 7), amount: outstanding });
    }
  }
  return out;
}

// Seasonal weight per calendar month (1..12) from the trailing year's realized
// stay revenue. weight = that month's revenue ÷ the average month (over months
// that HAVE data), clamped; a calendar month with no history stays neutral (1).
// Returns applied=false (all weights 1 → flat baseline) when there isn't enough
// history to be a signal.
function computeSeasonalWeights(historical: ProjectionReservationLike[]): {
  weights: number[]; // length 13, indices 1..12 used
  monthsOfHistory: number;
  applied: boolean;
} {
  const byMonth = new Array(13).fill(0);
  const seen = new Set<string>();
  for (const r of historical) {
    if (isExcludedStatus(r)) continue;
    const rid = reservationId(r);
    if (rid && seen.has(rid)) continue;
    if (rid) seen.add(rid);
    const stayDay = localizedStayDate(r, "in");
    if (!stayDay) continue;
    const cm = Number(stayDay.slice(5, 7));
    if (!(cm >= 1 && cm <= 12)) continue;
    const rev = reservationRevenue(r);
    if (rev > 0) byMonth[cm] += rev;
  }
  const monthsWithData = byMonth.filter((v) => v > 0).length;
  const total = byMonth.reduce((s, v) => s + v, 0);
  const weights = new Array(13).fill(1);
  if (monthsWithData < MIN_SEASONAL_MONTHS || total <= 0) {
    return { weights, monthsOfHistory: monthsWithData, applied: false };
  }
  const avg = total / monthsWithData;
  for (let m = 1; m <= 12; m++) {
    if (byMonth[m] > 0) {
      weights[m] = Math.min(SEASONAL_WEIGHT_MAX, Math.max(SEASONAL_WEIGHT_MIN, byMonth[m] / avg));
    }
  }
  return { weights, monthsOfHistory: monthsWithData, applied: true };
}

export function aggregateRevenueProjection(input: {
  forwardStayReservations: ProjectionReservationLike[];
  trailingBookingReservations: ProjectionReservationLike[];
  // Past-year stays (checkIn in the last 365 days) — the seasonality signal.
  // Optional: absent/sparse → the baseline stays a flat run rate (Phase 1).
  historicalStayReservations?: ProjectionReservationLike[];
  nowMs: number;
  horizonMonths?: number;
}): RevenueProjectionSnapshot {
  const { forwardStayReservations, trailingBookingReservations, nowMs } = input;
  const horizonMonths = input.horizonMonths ?? 12;
  const seasonal = computeSeasonalWeights(input.historicalStayReservations ?? []);

  // ── Trailing run-rate ────────────────────────────────────────────────────
  const t30 = nowMs - 30 * DAY_MS;
  const t60 = nowMs - 60 * DAY_MS;
  const t90 = nowMs - 90 * DAY_MS;
  const t365 = nowMs - 365 * DAY_MS;
  const t730 = nowMs - 730 * DAY_MS;

  let revenuePrev365 = 0; // booking revenue in [t730, t365) — the prior year, for YoY
  let collectedLast30 = 0,
    collectedPrev30 = 0,
    collectedLast60 = 0,
    collectedLast90 = 0,
    collectedLast365 = 0;
  let revenueLast30 = 0,
    revenuePrev30 = 0,
    revenueLast60 = 0,
    revenueLast90 = 0,
    revenueLast365 = 0;
  let refundsLast30 = 0,
    refundsLast90 = 0;

  const seenPayment = new Set<string>();
  const seenRefund = new Set<string>();

  for (const r of trailingBookingReservations) {
    if (isExcludedStatus(r)) continue;
    const rid = reservationId(r);

    // Collected cash, bucketed by capture date.
    for (const p of collectedPaymentsForReceipts(r)) {
      const key = `${rid}|${p.id ?? `${p.dateIso}|${p.amount.toFixed(2)}`}`;
      if (seenPayment.has(key)) continue;
      seenPayment.add(key);
      const t = p.date.getTime();
      if (t < t365 || t > nowMs) continue;
      collectedLast365 += p.amount;
      if (t >= t90) collectedLast90 += p.amount;
      if (t >= t60) collectedLast60 += p.amount;
      if (t >= t30) collectedLast30 += p.amount;
      else if (t >= t60) collectedPrev30 += p.amount; // [60d..30d) ago
    }

    // Refunds, bucketed by refund date (for net-collected context).
    for (const rf of realRefundsForReceipts(r)) {
      const key = `${rid}|${rf.id ?? `${rf.dateIso}|${rf.amount.toFixed(2)}`}`;
      if (seenRefund.has(key)) continue;
      seenRefund.add(key);
      const t = rf.date.getTime();
      if (t < t365 || t > nowMs) continue;
      if (t >= t90) refundsLast90 += rf.amount;
      if (t >= t30) refundsLast30 += rf.amount;
    }

    // Booking revenue, bucketed by booking (created) date.
    const made = bookingDate(r);
    if (made) {
      const t = made.getTime();
      if (t >= t365 && t <= nowMs) {
        const rev = reservationRevenue(r);
        if (rev > 0) {
          revenueLast365 += rev;
          if (t >= t90) revenueLast90 += rev;
          if (t >= t60) revenueLast60 += rev;
          if (t >= t30) revenueLast30 += rev;
          else if (t >= t60) revenuePrev30 += rev;
        }
      } else if (t >= t730 && t < t365) {
        // Prior year (same-length window, one year back) — YoY denominator.
        const rev = reservationRevenue(r);
        if (rev > 0) revenuePrev365 += rev;
      }
    }
  }

  const collectedDailyAvg90 = collectedLast90 / 90;
  const revenueDailyAvg90 = revenueLast90 / 90;
  const trailing: RevenueProjectionTrailing = {
    collectedLast30,
    collectedPrev30,
    collectedLast60,
    collectedLast90,
    collectedLast365,
    collectedDailyAvg90,
    collectedRunRateAnnual: Math.round(collectedDailyAvg90 * 365),
    collectedMomentumPct:
      collectedPrev30 > 0 ? (collectedLast30 - collectedPrev30) / collectedPrev30 : null,
    revenueLast30,
    revenuePrev30,
    revenueLast60,
    revenueLast90,
    revenueLast365,
    revenueDailyAvg90,
    revenueRunRateAnnual: Math.round(revenueDailyAvg90 * 365),
    revenueMomentumPct:
      revenuePrev30 > 0 ? (revenueLast30 - revenuePrev30) / revenuePrev30 : null,
    revenuePrev365,
    revenueYoyPct: revenuePrev365 > 0 ? (revenueLast365 - revenuePrev365) / revenuePrev365 : null,
    refundsLast30,
    refundsLast90,
  };

  // ── Forward 12-month projection (by STAY month) ──────────────────────────
  const monthKeys = forwardMonthKeys(nowMs, horizonMonths);
  const monthIndex = new Map<string, number>();
  monthKeys.forEach((k, i) => monthIndex.set(k, i));
  const firstMonth = monthKeys[0];
  const lastMonth = monthKeys[monthKeys.length - 1];

  const acc = monthKeys.map((month) => ({
    month,
    onBooksRevenue: 0,
    collections: 0,
    reservationCount: 0,
    netProfit: 0,
    attachedCost: 0,
    estimatedCost: 0,
    openSlots: 0,
    unpricedSlots: 0,
  }));

  const seenForward = new Set<string>();
  for (const r of forwardStayReservations) {
    if (isExcludedStatus(r)) continue;
    const rid = reservationId(r);
    if (rid && seenForward.has(rid)) continue;
    if (rid) seenForward.add(rid);

    const stayDay = localizedStayDate(r, "in");
    if (!stayDay) continue;
    const stayMonth = stayDay.slice(0, 7);
    const mi = monthIndex.get(stayMonth);
    if (mi == null) continue; // outside the 12-month horizon

    const bucket = acc[mi];
    bucket.reservationCount += 1;
    bucket.onBooksRevenue += reservationRevenue(r);

    // Costs: attached (real) + estimated (open slots), on the profit basis.
    const slots = Array.isArray(r?.slots) ? r.slots : [];
    const openSlots: ProjectionSlotLike[] = [];
    let attachedCost = 0;
    for (const slot of slots) {
      const cost = slotBuyInCost(slot);
      if (cost == null) openSlots.push(slot);
      else attachedCost += cost;
    }
    bucket.attachedCost += attachedCost;
    bucket.openSlots += openSlots.length;

    let estimatedCost = 0;
    if (openSlots.length > 0) {
      const community = resolveCommunity(r);
      if (community) {
        const pid = Number(r?.operationsPropertyId);
        const nights = stayNights(r);
        const perNight = totalNightlyBuyInForMonth(
          community,
          openSlots.map((s) => ({ bedrooms: Number(s?.bedrooms ?? 0) })),
          stayMonth,
          Number.isFinite(pid) && pid > 0 ? pid : undefined,
        );
        estimatedCost = perNight * nights;
        if (!(estimatedCost > 0)) bucket.unpricedSlots += openSlots.length;
      } else {
        bucket.unpricedSlots += openSlots.length;
      }
    }
    bucket.estimatedCost += estimatedCost;

    bucket.netProfit += reservationNetRevenue(r) - attachedCost - estimatedCost;

    // Scheduled cash forecast, bucketed by its own scheduled charge month.
    for (const c of scheduledCollections(r)) {
      if (c.month < firstMonth || c.month > lastMonth) continue;
      const ci = monthIndex.get(c.month);
      if (ci != null) acc[ci].collections += c.amount;
    }
  }

  const months: RevenueProjectionMonth[] = acc.map((b) => {
    const calMonth = Number(b.month.slice(5, 7));
    const seasonalWeight = seasonal.weights[calMonth] ?? 1;
    const baselineRevenue = Math.round(revenueDailyAvg90 * daysInMonth(b.month) * seasonalWeight);
    const onBooksRevenue = Math.round(b.onBooksRevenue);
    const projectedRevenue = Math.max(onBooksRevenue, baselineRevenue);
    return {
      month: b.month,
      label: monthLabel(b.month),
      onBooksRevenue,
      baselineRevenue,
      projectedRevenue,
      onBooksPct: projectedRevenue > 0 ? onBooksRevenue / projectedRevenue : 1,
      seasonalWeight,
      collections: Math.round(b.collections),
      reservationCount: b.reservationCount,
      netProfit: Math.round(b.netProfit),
      attachedCost: Math.round(b.attachedCost),
      estimatedCost: Math.round(b.estimatedCost),
      openSlots: b.openSlots,
      unpricedSlots: b.unpricedSlots,
    };
  });

  const totals: RevenueProjectionTotals = {
    projectedRevenue12mo: months.reduce((s, m) => s + m.projectedRevenue, 0),
    onBooksRevenue12mo: months.reduce((s, m) => s + m.onBooksRevenue, 0),
    projectedCollections12mo: months.reduce((s, m) => s + m.collections, 0),
    projectedNetProfit12mo: months.reduce((s, m) => s + m.netProfit, 0),
    attachedCost12mo: months.reduce((s, m) => s + m.attachedCost, 0),
    estimatedCost12mo: months.reduce((s, m) => s + m.estimatedCost, 0),
    onBooksPct12mo: 0,
    reservations: months.reduce((s, m) => s + m.reservationCount, 0),
    openSlots: months.reduce((s, m) => s + m.openSlots, 0),
    unpricedSlots: months.reduce((s, m) => s + m.unpricedSlots, 0),
  };
  totals.onBooksPct12mo =
    totals.projectedRevenue12mo > 0
      ? totals.onBooksRevenue12mo / totals.projectedRevenue12mo
      : 1;

  const seasonality: RevenueProjectionSeasonality = {
    applied: seasonal.applied,
    monthsOfHistory: seasonal.monthsOfHistory,
  };

  return {
    ready: true,
    generatedAt: new Date(nowMs).toISOString(),
    horizonMonths,
    months,
    trailing,
    totals,
    seasonality,
  };
}
