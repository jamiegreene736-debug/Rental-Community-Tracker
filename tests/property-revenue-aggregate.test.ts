import { aggregateRevenueByProperty, bookingDayOf } from "../server/property-revenue-aggregate";

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

// Helper: a Guesty-shaped reservation BOOKED on `createdAt`, whose
// reservationRevenue() resolves to `total` via money.totalPrice. Note revenue
// is attributed by BOOKING date (createdAt), NOT stay/check-in date.
const resv = (propertyId: number | null | undefined, createdAt: string | Date | null, total: number, extra: Record<string, unknown> = {}) => ({
  operationsPropertyId: propertyId,
  createdAt,
  money: { totalPrice: total },
  ...extra,
});

console.log("property-revenue-aggregate: bucketing + sums (by booking date)");
{
  const rows = [
    resv(4, "2026-01-15", 1000),
    resv(4, "2026-02-20", 500),
    resv(9, "2026-03-01", 2500),
    resv(-3, "2026-04-01", 750), // mapped published-draft (negative property id)
  ];
  const m = aggregateRevenueByProperty(rows, START, END);
  check("property 4 sums both bookings", m.get(4)?.revenue === 1500, m.get(4));
  check("property 4 booking count = 2", m.get(4)?.bookings === 2, m.get(4));
  check("property 9 single booking", m.get(9)?.revenue === 2500 && m.get(9)?.bookings === 1, m.get(9));
  check("negative -draftId property keyed as-is", m.get(-3)?.revenue === 750, m.get(-3));
  check("only the 3 distinct properties present", m.size === 3, m.size);
}

console.log("property-revenue-aggregate: counts FUTURE stays booked in-window");
{
  // The key reason for booking-date attribution: a booking MADE inside the
  // window whose STAY is in the future must still count.
  const rows = [
    resv(4, "2026-06-20", 3000, { checkIn: "2027-03-10" }), // booked now, stay next year → counts
  ];
  const m = aggregateRevenueByProperty(rows, START, END);
  check("future-stay booking counted by booking date", m.get(4)?.revenue === 3000, m.get(4));
}

console.log("property-revenue-aggregate: booking-date window boundaries");
{
  const rows = [
    resv(4, START, 100),                 // inclusive lower bound → counts
    resv(4, END, 200),                   // inclusive upper bound → counts
    resv(4, "2025-06-25", 999),          // one day before window → excluded
    resv(4, "2026-06-27", 888),          // one day after window → excluded
    resv(4, "2026-05-10T14:00:00Z", 50), // full ISO timestamp sliced to day → counts
    resv(4, new Date("2026-05-11T00:00:00Z"), 25), // Date object accepted → counts
  ];
  const m = aggregateRevenueByProperty(rows, START, END);
  check("inclusive bounds + ISO timestamp + Date; out-of-window dropped", m.get(4)?.revenue === 375, m.get(4));
  check("only in-window bookings counted", m.get(4)?.bookings === 4, m.get(4));
}

console.log("property-revenue-aggregate: skips invalid / zero rows");
{
  const rows = [
    resv(null, "2026-01-10", 1000),        // no property id → skip
    resv(0, "2026-01-10", 1000),           // zero property id (sentinel) → skip
    resv(4, "", 1000),                     // no booking date → skip
    resv(4, "not-a-date", 1000),           // malformed booking date → skip
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
    createdAt: "2026-02-02",
    money: { fareAccommodation: 1200, fareCleaning: 0, guestServiceFee: 0, totalTaxes: 0 },
  };
  const m = aggregateRevenueByProperty([manual], START, END);
  check("manual row revenue via gross-fare fallback", m.get(19)?.revenue === 1200, m.get(19));
}

console.log("property-revenue-aggregate: bookingDayOf");
{
  check("ISO timestamp sliced to day", bookingDayOf({ createdAt: "2026-03-03T09:30:00Z" }) === "2026-03-03");
  check("date-only passthrough", bookingDayOf({ createdAt: "2026-03-03" }) === "2026-03-03");
  check("Date object → ISO day", bookingDayOf({ createdAt: new Date("2026-03-03T00:00:00Z") }) === "2026-03-03");
  check("null → empty", bookingDayOf({ createdAt: null }) === "");
}

console.log(`\nproperty-revenue-aggregate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
