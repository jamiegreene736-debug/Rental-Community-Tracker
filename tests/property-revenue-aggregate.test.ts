import { aggregateRevenueByProperty } from "../server/property-revenue-aggregate";

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

const START = "2025-06-26";
const END = "2026-06-26";

// Helper: a Guesty-shaped reservation whose reservationRevenue() resolves to
// `total` via money.totalPrice (the first cascade candidate).
const resv = (propertyId: number | null | undefined, checkIn: string, total: number, extra: Record<string, unknown> = {}) => ({
  operationsPropertyId: propertyId,
  checkIn,
  money: { totalPrice: total },
  ...extra,
});

console.log("property-revenue-aggregate: bucketing + sums");
{
  const rows = [
    resv(4, "2026-01-15", 1000),
    resv(4, "2026-02-20", 500),
    resv(9, "2026-03-01", 2500),
    resv(-3, "2026-04-01", 750), // mapped published-draft (negative property id)
  ];
  const m = aggregateRevenueByProperty(rows, START, END);
  check("property 4 sums both stays", m.get(4)?.revenue === 1500, m.get(4));
  check("property 4 booking count = 2", m.get(4)?.bookings === 2, m.get(4));
  check("property 9 single stay", m.get(9)?.revenue === 2500 && m.get(9)?.bookings === 1, m.get(9));
  check("negative -draftId property keyed as-is", m.get(-3)?.revenue === 750, m.get(-3));
  check("only the 3 distinct properties present", m.size === 3, m.size);
}

console.log("property-revenue-aggregate: check-in window boundaries");
{
  const rows = [
    resv(4, START, 100),                 // inclusive lower bound → counts
    resv(4, END, 200),                   // inclusive upper bound → counts
    resv(4, "2025-06-25", 999),          // one day before window → excluded
    resv(4, "2026-06-27", 888),          // one day after window → excluded
    resv(4, "2026-05-10T14:00:00Z", 50), // full ISO timestamp sliced to day → counts
  ];
  const m = aggregateRevenueByProperty(rows, START, END);
  check("inclusive bounds + ISO timestamp; out-of-window dropped", m.get(4)?.revenue === 350, m.get(4));
  check("only in-window stays counted", m.get(4)?.bookings === 3, m.get(4));
}

console.log("property-revenue-aggregate: skips invalid / zero rows");
{
  const rows = [
    resv(null, "2026-01-10", 1000),        // no property id → skip
    resv(0, "2026-01-10", 1000),           // zero property id (sentinel) → skip
    resv(4, "", 1000),                     // no check-in → skip
    resv(4, "not-a-date", 1000),           // malformed check-in → skip
    resv(7, "2026-01-10", 0),              // zero revenue → skip (no row)
    resv(7, "2026-01-11", -50),            // negative revenue → skip
    resv(8, "2026-01-12", 300),            // the one valid row
  ];
  const m = aggregateRevenueByProperty(rows, START, END);
  check("invalid/zero rows produce no property entries", m.size === 1 && m.has(8), Array.from(m.keys()));
  check("zero-revenue property absent (renders as —)", !m.has(7), m.get(7));
  check("valid row recorded", m.get(8)?.revenue === 300 && m.get(8)?.bookings === 1, m.get(8));
}

console.log("property-revenue-aggregate: manual-reservation money shape");
{
  // guesty-all synthesizes manual rows as money.fareAccommodation = totalRate
  // (no totalPrice). reservationRevenue() falls through to the gross-fare sum.
  const manual = {
    operationsPropertyId: 19,
    checkIn: "2026-02-02",
    money: { fareAccommodation: 1200, fareCleaning: 0, guestServiceFee: 0, totalTaxes: 0 },
  };
  const m = aggregateRevenueByProperty([manual], START, END);
  check("manual row revenue via gross-fare fallback", m.get(19)?.revenue === 1200, m.get(19));
}

console.log("property-revenue-aggregate: checkInDateLocalized preferred over checkIn");
{
  const rows = [{ operationsPropertyId: 4, checkInDateLocalized: "2026-03-03", checkIn: "1999-01-01", money: { totalPrice: 400 } }];
  const m = aggregateRevenueByProperty(rows, START, END);
  check("localized check-in used (in-window), raw ignored", m.get(4)?.revenue === 400, m.get(4));
}

console.log(`\nproperty-revenue-aggregate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
