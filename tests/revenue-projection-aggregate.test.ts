import {
  aggregateRevenueProjection,
  type ProjectionReservationLike,
} from "../server/revenue-projection-aggregate";
import { totalNightlyBuyInForMonth } from "@shared/pricing-rates";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
};
const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

// Fixed "now" so every rolling window is deterministic: 2026-07-15.
//   t30 = 2026-06-15   t60 = 2026-05-16   t90 = 2026-04-16   t365 = 2025-07-15
// Forward horizon months: 2026-07 .. 2027-06.
const NOW = Date.UTC(2026, 6, 15);

const monthOf = (snap: ReturnType<typeof aggregateRevenueProjection>, key: string) =>
  snap.months.find((m) => m.month === key)!;

// ── Trailing run-rate ────────────────────────────────────────────────────
console.log("revenue-projection: trailing windows + momentum");
{
  const trailingBookingReservations: ProjectionReservationLike[] = [
    // Booked 10 days ago ($1000) with a collected payment 5 days ago ($800).
    {
      _id: "A",
      status: "confirmed",
      createdAt: "2026-07-05T00:00:00Z",
      money: {
        totalPrice: 1000,
        payments: [{ amount: 800, status: "paid", paidAt: "2026-07-10T00:00:00Z" }],
      },
    },
    // Booked 45 days ago ($2000) — falls in the PREVIOUS 30-day window.
    { _id: "B", status: "confirmed", createdAt: "2026-05-31T00:00:00Z", money: { totalPrice: 2000 } },
  ];
  const snap = aggregateRevenueProjection({
    forwardStayReservations: [],
    trailingBookingReservations,
    nowMs: NOW,
  });
  const t = snap.trailing;
  check("revenueLast30 = 1000 (recent booking only)", t.revenueLast30 === 1000, t.revenueLast30);
  check("revenuePrev30 = 2000 (45-day-ago booking)", t.revenuePrev30 === 2000, t.revenuePrev30);
  check("revenueLast90 = 3000 (both bookings)", t.revenueLast90 === 3000, t.revenueLast90);
  check("revenueDailyAvg90 = 3000/90", near(t.revenueDailyAvg90, 3000 / 90), t.revenueDailyAvg90);
  check("revenueRunRateAnnual = round(dailyAvg90*365)", t.revenueRunRateAnnual === Math.round((3000 / 90) * 365), t.revenueRunRateAnnual);
  check("revenueMomentum = (1000-2000)/2000 = -0.5", near(t.revenueMomentumPct ?? NaN, -0.5, 1e-9), t.revenueMomentumPct);
  check("collectedLast30 = 800", t.collectedLast30 === 800, t.collectedLast30);
  check("collectedLast90 = 800", t.collectedLast90 === 800, t.collectedLast90);
}

// ── Forward projection: OTB revenue, cost, net profit, estimate ───────────
console.log("revenue-projection: forward OTB revenue + cost + profit");
{
  const resA: ProjectionReservationLike = {
    _id: "resA",
    status: "confirmed",
    operationsPropertyId: -1, // negative → community resolves from the slot
    checkInDateLocalized: "2026-08-10",
    checkOutDateLocalized: "2026-08-17", // 7 nights
    money: {
      totalPrice: 5000,
      hostPayout: 4000,
      totalPaid: 0,
      paymentSchedule: [{ status: "PENDING", amount: 1500, shouldBePaidAt: "2026-08-01T01:00:00Z" }],
    },
    slots: [
      { unitId: "a", bedrooms: 3, community: "Poipu Kai", buyIn: { status: "active", costPaid: "2000" } },
      { unitId: "b", bedrooms: 3, community: "Poipu Kai", buyIn: null },
    ],
  };
  const snap = aggregateRevenueProjection({
    forwardStayReservations: [resA],
    trailingBookingReservations: [],
    nowMs: NOW,
  });
  const aug = monthOf(snap, "2026-08");
  const expectedEst = Math.round(totalNightlyBuyInForMonth("Poipu Kai", [{ bedrooms: 3 }], "2026-08") * 7);
  check("Aug on-books revenue = 5000 (guest total)", aug.onBooksRevenue === 5000, aug.onBooksRevenue);
  check("Aug attached cost = 2000 (costPaid)", aug.attachedCost === 2000, aug.attachedCost);
  check("Aug estimated open-slot cost > 0", aug.estimatedCost > 0, aug.estimatedCost);
  check("Aug estimated cost = 3BR Poipu Kai x 7 nights", aug.estimatedCost === expectedEst, { got: aug.estimatedCost, expectedEst });
  check("Aug open slots = 1", aug.openSlots === 1, aug.openSlots);
  check("Aug unpriced slots = 0 (priced via community)", aug.unpricedSlots === 0, aug.unpricedSlots);
  check("Aug net profit = hostPayout - attached - estimated", aug.netProfit === Math.round(4000 - 2000 - expectedEst), aug.netProfit);
  check("Aug collections = 1500 (scheduled shouldBePaidAt)", aug.collections === 1500, aug.collections);
  check("Aug reservationCount = 1", aug.reservationCount === 1, aug.reservationCount);
}

// ── paidRate preferred over costPaid; cancelled buy-in = open; horizon ─────
console.log("revenue-projection: paidRate preference, cancelled slot, horizon");
{
  const resB: ProjectionReservationLike = {
    _id: "resB",
    status: "confirmed",
    operationsPropertyId: -2,
    checkInDateLocalized: "2026-09-05",
    checkOutDateLocalized: "2026-09-08",
    money: { totalPrice: 3000, hostPayout: 2500, totalPaid: 0 }, // no schedule → fallback collection
    slots: [{ unitId: "a", bedrooms: 2, community: "Pili Mai", buyIn: { status: "active", costPaid: "1000", paidRate: "1200" } }],
  };
  const resC: ProjectionReservationLike = {
    _id: "resC",
    status: "confirmed",
    operationsPropertyId: -99, // unknown community
    checkInDateLocalized: "2026-10-10",
    checkOutDateLocalized: "2026-10-12",
    money: { totalPrice: 0, hostPayout: 0 },
    slots: [{ unitId: "a", bedrooms: 3, buyIn: { status: "cancelled", costPaid: "999" } }],
  };
  const resD: ProjectionReservationLike = {
    _id: "resD",
    status: "confirmed",
    operationsPropertyId: -3,
    checkInDateLocalized: "2028-01-01", // outside the 12-month horizon
    checkOutDateLocalized: "2028-01-05",
    money: { totalPrice: 9999, hostPayout: 9999 },
    slots: [],
  };
  const snap = aggregateRevenueProjection({
    forwardStayReservations: [resB, resC, resD],
    trailingBookingReservations: [],
    nowMs: NOW,
  });
  const sep = monthOf(snap, "2026-09");
  const oct = monthOf(snap, "2026-10");
  check("Sep attached cost = 1200 (paidRate preferred over costPaid)", sep.attachedCost === 1200, sep.attachedCost);
  check("Sep net profit = 2500 - 1200 = 1300", sep.netProfit === 1300, sep.netProfit);
  check("Sep collections = 3000 (fallback: outstanding to check-in month)", sep.collections === 3000, sep.collections);
  check("Oct cancelled buy-in counts as OPEN slot", oct.openSlots === 1, oct.openSlots);
  check("Oct open slot with unknown community is UNPRICED", oct.unpricedSlots === 1, oct.unpricedSlots);
  check("Oct attached cost = 0 (cancelled not counted)", oct.attachedCost === 0, oct.attachedCost);
  check("horizon excludes 2028 stay (resB + resC in-window; resD dropped)", snap.totals.reservations === 2, snap.totals.reservations);
  check("no month bucket for out-of-horizon 2028-01", !snap.months.some((m) => m.month === "2028-01"), snap.months.map((m) => m.month));
}

// ── Baseline fill for empty far months (Phase 1 T90 run-rate) ─────────────
console.log("revenue-projection: baseline fill + on-books split");
{
  const trailingBookingReservations: ProjectionReservationLike[] = [
    { _id: "T", status: "confirmed", createdAt: "2026-07-01T00:00:00Z", money: { totalPrice: 3000 } },
  ];
  const forwardStayReservations: ProjectionReservationLike[] = [
    {
      _id: "near",
      status: "confirmed",
      operationsPropertyId: -1,
      checkInDateLocalized: "2026-08-05",
      checkOutDateLocalized: "2026-08-12",
      money: { totalPrice: 8000, hostPayout: 7000 },
      slots: [],
    },
  ];
  const snap = aggregateRevenueProjection({ forwardStayReservations, trailingBookingReservations, nowMs: NOW });
  const dailyAvg = 3000 / 90;
  const aug = monthOf(snap, "2026-08"); // 31 days, has an $8000 booking
  const farJun = monthOf(snap, "2027-06"); // 30 days, no bookings
  const baselineAug = Math.round(dailyAvg * 31);
  const baselineJun = Math.round(dailyAvg * 30);
  check("far empty month baseline = round(dailyAvg90 * days)", farJun.baselineRevenue === baselineJun, { got: farJun.baselineRevenue, baselineJun });
  check("far empty month projected = baseline (OTB is 0)", farJun.projectedRevenue === baselineJun, farJun.projectedRevenue);
  check("far empty month on-books revenue = 0", farJun.onBooksRevenue === 0, farJun.onBooksRevenue);
  check("far empty month onBooksPct = 0", farJun.onBooksPct === 0, farJun.onBooksPct);
  check("strong near month keeps OTB (max, not summed)", aug.projectedRevenue === 8000, { projected: aug.projectedRevenue, baselineAug });
  check("strong near month onBooksPct = 1", aug.onBooksPct === 1, aug.onBooksPct);
  check("totals.projectedRevenue >= totals.onBooksRevenue", snap.totals.projectedRevenue12mo >= snap.totals.onBooksRevenue12mo, snap.totals);
  check("totals.onBooksPct12mo within [0,1]", snap.totals.onBooksPct12mo >= 0 && snap.totals.onBooksPct12mo <= 1, snap.totals.onBooksPct12mo);
  check("horizon spans 12 months", snap.months.length === 12, snap.months.length);
  check("first month is the current month", snap.months[0].month === "2026-07", snap.months[0].month);
}

// ── Phase 2: seasonal baseline from trailing-year stay revenue ────────────
console.log("revenue-projection: seasonal baseline weighting");
{
  // Trailing booking run-rate: $9000 over last 90 days → $100/day.
  const trailingBookingReservations: ProjectionReservationLike[] = [
    { _id: "rr", status: "confirmed", createdAt: "2026-07-01T00:00:00Z", money: { totalPrice: 9000 } },
  ];
  // Past-year stays (seasonality signal): 6 calendar months w/ data, Aug peak,
  // Sep trough. avg = 25000/6 = 4166.67. weight[8]=2.4→clamp 2.0; weight[9]=0.24→0.4.
  const histStay = (checkIn: string, total: number, i: number): ProjectionReservationLike => ({
    _id: `h${i}`,
    status: "confirmed",
    checkInDateLocalized: checkIn,
    money: { totalPrice: total },
  });
  const historicalStayReservations: ProjectionReservationLike[] = [
    histStay("2025-08-10", 10000, 1), // Aug peak
    histStay("2025-09-10", 1000, 2), // Sep trough
    histStay("2025-10-10", 2000, 3),
    histStay("2025-11-10", 2000, 4),
    histStay("2025-12-10", 8000, 5),
    histStay("2026-01-10", 2000, 6),
  ];
  const snap = aggregateRevenueProjection({
    forwardStayReservations: [],
    trailingBookingReservations,
    historicalStayReservations,
    nowMs: NOW,
  });
  check("seasonality applied with >=6 months of history", snap.seasonality.applied === true, snap.seasonality);
  check("monthsOfHistory = 6", snap.seasonality.monthsOfHistory === 6, snap.seasonality.monthsOfHistory);
  const aug = monthOf(snap, "2026-08"); // 31 days, cal month 8 → weight clamped to 2.0
  const sep = monthOf(snap, "2026-09"); // 30 days, cal month 9 → weight clamped to 0.4
  const feb = monthOf(snap, "2027-02"); // 28 days, cal month 2 → no history → neutral 1
  check("Aug seasonal weight clamped to 2.0", aug.seasonalWeight === 2.0, aug.seasonalWeight);
  check("Aug baseline = 100/day x 31 x 2.0 = 6200", aug.baselineRevenue === 6200, aug.baselineRevenue);
  check("Sep seasonal weight clamped to 0.4", sep.seasonalWeight === 0.4, sep.seasonalWeight);
  check("Sep baseline = 100/day x 30 x 0.4 = 1200", sep.baselineRevenue === 1200, sep.baselineRevenue);
  check("Feb (no history) weight neutral 1", feb.seasonalWeight === 1, feb.seasonalWeight);
  check("Feb baseline = 100/day x 28 x 1 = 2800", feb.baselineRevenue === 2800, feb.baselineRevenue);
}

console.log("revenue-projection: seasonality falls back to flat when sparse");
{
  const trailingBookingReservations: ProjectionReservationLike[] = [
    { _id: "rr", status: "confirmed", createdAt: "2026-07-01T00:00:00Z", money: { totalPrice: 9000 } },
  ];
  const historicalStayReservations: ProjectionReservationLike[] = [
    { _id: "h1", status: "confirmed", checkInDateLocalized: "2025-08-10", money: { totalPrice: 5000 } },
    { _id: "h2", status: "confirmed", checkInDateLocalized: "2025-12-10", money: { totalPrice: 5000 } },
    { _id: "h3", status: "confirmed", checkInDateLocalized: "2026-01-10", money: { totalPrice: 5000 } },
  ];
  const snap = aggregateRevenueProjection({
    forwardStayReservations: [],
    trailingBookingReservations,
    historicalStayReservations,
    nowMs: NOW,
  });
  check("seasonality NOT applied with <6 months of history", snap.seasonality.applied === false, snap.seasonality);
  const aug = monthOf(snap, "2026-08");
  check("sparse history → flat baseline (weight 1)", aug.seasonalWeight === 1 && aug.baselineRevenue === 6200 / 2, aug.baselineRevenue);
}

console.log("revenue-projection: YoY growth");
{
  const trailingBookingReservations: ProjectionReservationLike[] = [
    { _id: "cur", status: "confirmed", createdAt: "2026-07-01T00:00:00Z", money: { totalPrice: 9000 } }, // last 365
    { _id: "prior", status: "confirmed", createdAt: "2025-01-01T00:00:00Z", money: { totalPrice: 6000 } }, // prior 365
  ];
  const snap = aggregateRevenueProjection({
    forwardStayReservations: [],
    trailingBookingReservations,
    nowMs: NOW,
  });
  check("revenueLast365 = 9000", snap.trailing.revenueLast365 === 9000, snap.trailing.revenueLast365);
  check("revenuePrev365 = 6000 (prior-year booking)", snap.trailing.revenuePrev365 === 6000, snap.trailing.revenuePrev365);
  check("YoY = (9000-6000)/6000 = 0.5", near(snap.trailing.revenueYoyPct ?? NaN, 0.5, 1e-9), snap.trailing.revenueYoyPct);

  const noPrior = aggregateRevenueProjection({
    forwardStayReservations: [],
    trailingBookingReservations: [trailingBookingReservations[0]],
    nowMs: NOW,
  });
  check("YoY null when no prior-year data", noPrior.trailing.revenueYoyPct === null, noPrior.trailing.revenueYoyPct);
}

console.log(`\nrevenue-projection-aggregate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
