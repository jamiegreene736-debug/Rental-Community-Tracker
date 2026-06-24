// Locks the "Payment next due" resolution for the Operations bookings tables.
//
// Operator-caught regression (reservation BC-9jpBrRM5Y, guest Dean Hatzenbihler):
// Guesty's reservation Payments page showed "Next payment $5,224 on Jul 24, 2026",
// but our column showed "May 6, 2026". Root cause: Guesty stamps a scheduled
// auto-payment's charge date on `shouldBePaidAt`, which the resolver didn't read,
// so it fell back to the row's `createdAt` (≈ booking time). This test pins the
// field priority (shouldBePaidAt first), the deliberate exclusion of `createdAt`,
// and the next-due selection against the EXACT Guesty payment rows from that
// reservation.

import assert from "node:assert";
import {
  scheduledChargeDateIso,
  nextScheduledChargeDate,
  paymentRowLooksCollected,
  paymentRowLooksScheduled,
  SCHEDULED_CHARGE_DATE_FIELDS,
} from "../shared/guesty-payment-schedule";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("guesty-payment-schedule: next payment due");

// The two REAL money.payments rows from reservation BC-9jpBrRM5Y (Guesty API).
const collectedRow = {
  status: "SUCCEEDED",
  amount: 5224,
  shouldBePaidAt: "2026-05-07T03:05:42.845Z",
  paidAt: "2026-05-07T03:06:17.938Z",
  createdAt: "2026-05-07T03:06:10.386Z",
};
const scheduledRow = {
  status: "PENDING",
  amount: 5224,
  shouldBePaidAt: "2026-07-25T01:00:00.000Z",
  createdAt: "2026-05-07T03:06:10.396Z",
};

// "today" for the run — fixed so the test is deterministic.
const NOW = Date.parse("2026-06-24T12:00:00.000Z");

// ── scheduledChargeDateIso: field priority + createdAt exclusion ───────────────
check(
  "createdAt is NOT a fallback field",
  !(SCHEDULED_CHARGE_DATE_FIELDS as readonly string[]).includes("createdAt"),
);
check(
  "shouldBePaidAt is the first/highest-priority field",
  SCHEDULED_CHARGE_DATE_FIELDS[0] === "shouldBePaidAt",
);
check(
  "scheduled row resolves to shouldBePaidAt (Jul 25), not createdAt (May 7)",
  scheduledChargeDateIso(scheduledRow) === "2026-07-25T01:00:00.000Z",
  scheduledChargeDateIso(scheduledRow),
);
check(
  "a row with ONLY createdAt resolves to null (no misleading creation date)",
  scheduledChargeDateIso({ status: "PENDING", amount: 100, createdAt: "2026-05-07T03:06:10.396Z" }) === null,
);
check(
  "shouldBePaidAt wins over dueAt/scheduledAt",
  scheduledChargeDateIso({ shouldBePaidAt: "2026-07-25T01:00:00.000Z", dueAt: "2026-01-01", scheduledAt: "2026-02-02" }) === "2026-07-25T01:00:00.000Z",
);
check(
  "dueAt used when shouldBePaidAt absent",
  scheduledChargeDateIso({ dueAt: "2026-08-01T00:00:00.000Z" }) === "2026-08-01T00:00:00.000Z",
);
check(
  "Date object input is coerced to ISO",
  scheduledChargeDateIso({ shouldBePaidAt: new Date("2026-07-25T01:00:00.000Z") }) === "2026-07-25T01:00:00.000Z",
);
check("empty / nullish payment → null", scheduledChargeDateIso(null) === null && scheduledChargeDateIso({}) === null);

// ── classification ─────────────────────────────────────────────────────────────
check("SUCCEEDED + paidAt looks collected", paymentRowLooksCollected(collectedRow) === true);
check("SUCCEEDED + paidAt is NOT scheduled", paymentRowLooksScheduled(collectedRow) === false);
check("PENDING looks scheduled", paymentRowLooksScheduled(scheduledRow) === true);
check("PENDING is NOT collected", paymentRowLooksCollected(scheduledRow) === false);

// ── nextScheduledChargeDate: the actual column value ───────────────────────────
{
  const due = nextScheduledChargeDate([collectedRow, scheduledRow], NOW);
  check(
    "Dean scenario → Jul 25 2026 UTC (Guesty's 'Jul 24' local), NOT May",
    due !== null && due.toISOString() === "2026-07-25T01:00:00.000Z",
    due?.toISOString(),
  );
}
check("all-collected → null (nothing scheduled)", nextScheduledChargeDate([collectedRow], NOW) === null);
check("empty list → null", nextScheduledChargeDate([], NOW) === null);
{
  // Two scheduled charges → earliest still-upcoming wins.
  const earlier = { status: "PENDING", shouldBePaidAt: "2026-07-25T01:00:00.000Z" };
  const later = { status: "PENDING", shouldBePaidAt: "2026-09-01T01:00:00.000Z" };
  const due = nextScheduledChargeDate([later, earlier], NOW);
  check("two scheduled → earliest upcoming", due?.toISOString() === "2026-07-25T01:00:00.000Z", due?.toISOString());
}
{
  // Every scheduled date already past → earliest outstanding one (not null).
  const past1 = { status: "PENDING", shouldBePaidAt: "2026-03-01T01:00:00.000Z" };
  const past2 = { status: "PENDING", shouldBePaidAt: "2026-04-01T01:00:00.000Z" };
  const due = nextScheduledChargeDate([past2, past1], NOW);
  check("all overdue → earliest outstanding", due?.toISOString() === "2026-03-01T01:00:00.000Z", due?.toISOString());
}

console.log(`guesty-payment-schedule: ${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, "guesty-payment-schedule suite had failures");
