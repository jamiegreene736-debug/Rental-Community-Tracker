import {
  realRefundsForReceipts,
  reservationRefundItems,
  refundAmount,
  refundDate,
} from "../server/guesty-money";

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

console.log("guesty-money: refund detection");

// 1. Refund nested on an otherwise-SUCCEEDED payment (the shape that was being
//    missed): parent payment stays positive/paid, refund lives in .refunds[].
{
  const reservation = {
    _id: "r1",
    money: {
      payments: [
        {
          _id: "p1",
          amount: 5000,
          status: "SUCCEEDED",
          paidAt: "2026-06-01T10:00:00Z",
          refunds: [{ amount: 1500, refundedAt: "2026-06-12T15:00:00Z" }],
        },
      ],
    },
  };
  const refunds = realRefundsForReceipts(reservation);
  check("nested refund detected", refunds.length === 1, refunds);
  check("nested refund amount = 1500", refunds[0]?.amount === 1500, refunds[0]);
  check("nested refund dated by refundedAt", refunds[0]?.dateIso.slice(0, 10) === "2026-06-12", refunds[0]);
  // The parent payment must NOT also be counted as a refund (no double count).
  check("parent payment not double-counted", refunds.length === 1, refunds);
}

// 2. Top-level refund row whose ONLY date field is refundedAt (paymentDate
//    would have returned null and dropped it).
{
  const reservation = {
    _id: "r2",
    money: { refunds: [{ amount: 800, refundedAt: "2026-06-11T09:00:00Z", status: "completed" }] },
  };
  const refunds = realRefundsForReceipts(reservation);
  check("refundedAt-only refund detected", refunds.length === 1 && refunds[0].amount === 800, refunds);
  check("refundDate reads refundedAt", refundDate({ refundedAt: "2026-06-11T09:00:00Z" })?.toISOString().slice(0, 10) === "2026-06-11");
}

// 3. Plain negative payment line (no label) is still a refund.
{
  const reservation = {
    _id: "r3",
    money: { payments: [{ amount: -250, createdAt: "2026-06-10T12:00:00Z" }] },
  };
  const refunds = realRefundsForReceipts(reservation);
  check("bare negative line refund detected", refunds.length === 1 && refunds[0].amount === 250, refunds);
}

// 4. Partial refund: explicit refundedAmount used, not the full payment amount.
{
  const entry = { amount: 5000, refundedAmount: 1200, status: "PARTIALLY_REFUNDED", refundedAt: "2026-06-12T00:00:00Z" };
  check("partial refund amount = refundedAmount", refundAmount(entry) === 1200, refundAmount(entry));
}

// 5. Failed / pending refunds are NOT counted.
{
  const reservation = {
    _id: "r5",
    money: {
      refunds: [
        { amount: 300, refundedAt: "2026-06-12T00:00:00Z", status: "failed" },
        { amount: 400, refundedAt: "2026-06-12T00:00:00Z", status: "pending" },
      ],
    },
  };
  check("failed/pending refunds excluded", reservationRefundItems(reservation).length === 0, reservationRefundItems(reservation));
}

// 6. transactions[] refund with refundedAt is detected.
{
  const reservation = {
    _id: "r6",
    money: { transactions: [{ type: "refund", amount: 999, refundedAt: "2026-06-12T18:00:00Z", status: "succeeded" }] },
  };
  const refunds = realRefundsForReceipts(reservation);
  check("transaction refund detected", refunds.length === 1 && refunds[0].amount === 999, refunds);
}

console.log(`\nguesty-money refunds: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
