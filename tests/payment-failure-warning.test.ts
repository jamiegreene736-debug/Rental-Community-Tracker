// Failed / uncollected guest-payment warning — pure-logic tests.
// Operator rules (2026-07-04): warn on a FAILED charge and on a scheduled
// balance (e.g. due ~90 days before arrival) that blew past its due date
// uncollected; ~2-week retroactive lookback; NEVER warn on a cancelled booking.
import {
  collectReservationPaymentIssues,
  paymentFailureDateIso,
  paymentFailureWarningSignature,
  paymentRowLooksFailed,
  reservationExcludedFromPaymentWarnings,
  reservationLooksFullyPaid,
  PAYMENT_WARNING_WINDOW_MS,
  type PaymentFailureWarning,
} from "../shared/payment-failure-warning";

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

const NOW = new Date("2026-07-04T18:00:00Z").getTime();
const daysAgoIso = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const daysAheadIso = (d: number) => new Date(NOW + d * 24 * 60 * 60 * 1000).toISOString();

const confirmedRes = (payments: any[], money: Record<string, unknown> = {}) => ({
  _id: "res1",
  status: "confirmed",
  checkIn: daysAheadIso(90),
  money: { totalPrice: 4000, totalPaid: 2000, payments, ...money },
});

console.log("payment-failure-warning: failed-charge detection");
{
  const failed = { status: "FAILED", amount: 1855, failedAt: daysAgoIso(2) };
  const issues = collectReservationPaymentIssues(confirmedRes([failed]), NOW);
  check("FAILED row -> one 'failed' issue", issues.length === 1 && issues[0].kind === "failed", issues);
  check("failed issue carries amount + date", issues[0]?.amount === 1855 && issues[0]?.dateIso === daysAgoIso(2));

  const declined = { status: "DECLINED", amount: 500, updatedAt: daysAgoIso(1) };
  check(
    "DECLINED row -> failed",
    collectReservationPaymentIssues(confirmedRes([declined]), NOW)[0]?.kind === "failed",
  );

  check(
    "status-only match: 'fail' in the free-text description is NOT a failure",
    !paymentRowLooksFailed({ status: "SUCCEEDED", description: "retry if payment fails", amount: 100 }),
  );
  check(
    "CANCELLED payment row is not 'failed' (operator-voided, not declined)",
    !paymentRowLooksFailed({ status: "CANCELLED", amount: 100 }),
  );
  check(
    "failed REFUND row is out of scope (refund alert owns it)",
    !paymentRowLooksFailed({ status: "FAILED", type: "refund", amount: 200 }),
  );
  check(
    "negative-amount row is refund-shaped, not a failed payment",
    !paymentRowLooksFailed({ status: "FAILED", amount: -200 }),
  );

  const oldFailure = { status: "FAILED", amount: 900, failedAt: daysAgoIso(20) };
  check(
    "failure older than the 14-day window is excluded",
    collectReservationPaymentIssues(confirmedRes([oldFailure]), NOW).length === 0,
  );

  const undated = { status: "FAILED", amount: 700 };
  check(
    "undated failure with an in-window fallback (reservation lastUpdatedAt) surfaces",
    collectReservationPaymentIssues(confirmedRes([undated]), NOW, { fallbackDateIso: daysAgoIso(3) }).length === 1,
  );
  check(
    "undated failure with an out-of-window fallback is excluded",
    collectReservationPaymentIssues(confirmedRes([undated]), NOW, { fallbackDateIso: daysAgoIso(30) }).length === 0,
  );
  check(
    "undated failure with NO fallback surfaces (never silently hide)",
    collectReservationPaymentIssues(confirmedRes([undated]), NOW).length === 1,
  );
}

console.log("payment-failure-warning: overdue scheduled balance");
{
  // The operator's 90-days-before-arrival case: PENDING schedule row whose
  // shouldBePaidAt passed 3 days ago without collection.
  const overdue = { status: "PENDING", amount: 5224, shouldBePaidAt: daysAgoIso(3), createdAt: daysAgoIso(60) };
  const issues = collectReservationPaymentIssues(confirmedRes([overdue]), NOW);
  check("overdue PENDING schedule row -> 'overdue' issue", issues.length === 1 && issues[0].kind === "overdue", issues);
  check("overdue issue dated by shouldBePaidAt (not createdAt)", issues[0]?.dateIso === daysAgoIso(3));

  const dueToday = { status: "PENDING", amount: 100, shouldBePaidAt: new Date(NOW - 6 * 3600 * 1000).toISOString() };
  check(
    "due <24h ago is inside the processing grace — no warning",
    collectReservationPaymentIssues(confirmedRes([dueToday]), NOW).length === 0,
  );

  const futureDue = { status: "PENDING", amount: 100, shouldBePaidAt: daysAheadIso(30) };
  check(
    "future scheduled charge -> no warning",
    collectReservationPaymentIssues(confirmedRes([futureDue]), NOW).length === 0,
  );

  const staleOverdue = { status: "PENDING", amount: 100, shouldBePaidAt: daysAgoIso(20) };
  check(
    "overdue older than the 14-day lookback is excluded (retroactive ~2 weeks)",
    collectReservationPaymentIssues(confirmedRes([staleOverdue]), NOW).length === 0,
  );

  const paid = { status: "SUCCEEDED", amount: 2000, paidAt: daysAgoIso(5), shouldBePaidAt: daysAgoIso(5) };
  check(
    "collected row never warns",
    collectReservationPaymentIssues(confirmedRes([paid]), NOW).length === 0,
  );
}

console.log("payment-failure-warning: exclusions");
{
  check("cancelled booking excluded", reservationExcludedFromPaymentWarnings({ status: "canceled" }));
  check("British spelling too", reservationExcludedFromPaymentWarnings({ status: "cancelled" }));
  check("inquiry excluded", reservationExcludedFromPaymentWarnings({ status: "inquiry" }));
  check("confirmed NOT excluded", !reservationExcludedFromPaymentWarnings({ status: "confirmed" }));

  const failedRow = { status: "FAILED", amount: 500, failedAt: daysAgoIso(1) };
  const cancelled = { ...confirmedRes([failedRow]), status: "canceled" };
  check(
    "cancelled booking with a failed charge -> NO warning (can't reprocess)",
    collectReservationPaymentIssues(cancelled, NOW).length === 0,
  );

  check(
    "isFullyPaid true -> fully paid even with totalPaid 0 (Booking.com channel-collected)",
    reservationLooksFullyPaid({ money: { isFullyPaid: true, totalPrice: 3000, totalPaid: 0 } }),
  );
  check(
    "totalPaid covering totalPrice -> fully paid (failed attempt later recovered)",
    reservationLooksFullyPaid({ money: { totalPrice: 3000, totalPaid: 3000 } }),
  );
  check(
    "partial payment is not fully paid",
    !reservationLooksFullyPaid({ money: { totalPrice: 4000, totalPaid: 2000 } }),
  );
  const fullyPaidRes = confirmedRes([failedRow], { isFullyPaid: true });
  check(
    "fully-paid reservation with an old failed row -> no warning",
    collectReservationPaymentIssues(fullyPaidRes, NOW).length === 0,
  );
}

console.log("payment-failure-warning: dedup");
{
  const failedRow = { status: "FAILED", amount: 1855, failedAt: daysAgoIso(2) };
  const res: any = confirmedRes([failedRow]);
  res.payments = [failedRow]; // same row mirrored at reservation.payments
  check(
    "same row in money.payments AND reservation.payments -> one issue",
    collectReservationPaymentIssues(res, NOW).length === 1,
  );

  // Guesty keeps the schedule row pending alongside the failed attempt row —
  // the same charge must surface once, as FAILED (the actionable framing).
  const schedule = { status: "PENDING", amount: 1855, shouldBePaidAt: daysAgoIso(2) };
  const both = collectReservationPaymentIssues(confirmedRes([failedRow, schedule]), NOW);
  check("failed attempt + pending schedule for the SAME charge -> one FAILED issue", both.length === 1 && both[0].kind === "failed", both);

  const otherBalance = { status: "PENDING", amount: 2145, shouldBePaidAt: daysAgoIso(4) };
  const mixed = collectReservationPaymentIssues(confirmedRes([failedRow, otherBalance]), NOW);
  check(
    "a DIFFERENT overdue balance still surfaces alongside the failed charge",
    mixed.length === 2 && mixed.some((i) => i.kind === "failed") && mixed.some((i) => i.kind === "overdue"),
    mixed,
  );
}

console.log("payment-failure-warning: failure date resolution");
{
  check("failedAt wins", paymentFailureDateIso({ failedAt: "2026-07-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }) === "2026-07-01T00:00:00Z");
  check("falls back to shouldBePaidAt", paymentFailureDateIso({ shouldBePaidAt: "2026-06-20T00:00:00Z" }) === "2026-06-20T00:00:00Z");
  check("falls back to createdAt last", paymentFailureDateIso({ createdAt: "2026-06-01T00:00:00Z" }) === "2026-06-01T00:00:00Z");
  check("null when dateless", paymentFailureDateIso({ amount: 5 }) === null);
}

console.log("payment-failure-warning: dismissal signature");
{
  const w = (reservationId: string, issues: Array<{ kind: "failed" | "overdue"; amount: number; dateIso: string | null }>): PaymentFailureWarning => ({
    reservationId,
    confirmationCode: null,
    guestName: null,
    listingNickname: null,
    channel: null,
    checkIn: null,
    checkOut: null,
    conversationId: null,
    totalPrice: null,
    totalPaid: null,
    issues: issues.map((i) => ({ ...i, statusRaw: "" })),
  });
  const a = w("r1", [{ kind: "failed", amount: 100, dateIso: daysAgoIso(1) }]);
  const b = w("r2", [{ kind: "overdue", amount: 200, dateIso: daysAgoIso(2) }]);
  check("empty -> empty signature", paymentFailureWarningSignature([]) === "");
  check("order-independent", paymentFailureWarningSignature([a, b]) === paymentFailureWarningSignature([b, a]));
  const c = w("r1", [{ kind: "failed", amount: 100, dateIso: daysAgoIso(1) }, { kind: "overdue", amount: 300, dateIso: daysAgoIso(1) }]);
  check(
    "a NEW issue on a dismissed reservation changes the signature (re-raises)",
    paymentFailureWarningSignature([a]) !== paymentFailureWarningSignature([c]),
  );
}

console.log("payment-failure-warning: window constant");
check("retroactive window is 14 days", PAYMENT_WARNING_WINDOW_MS === 14 * 24 * 60 * 60 * 1000);

console.log(`\npayment-failure-warning: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
