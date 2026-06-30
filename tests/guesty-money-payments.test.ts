import {
  collectedPaymentsForReceipts,
  paymentHistoryForReceipts,
  transactionId,
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

console.log("guesty-money: collected payment detection + per-txn dedup");

// 1. THE BUG: a 50% deposit + the auto-charged 50% balance, both captured the
//    SAME calendar day for the SAME amount (a within-window booking) — Faith Ito
//    / Menehune Shores, 2x $1,855. They must surface as TWO distinct payments,
//    not collapse to one (which left the balance with no "paid in full" receipt).
{
  const reservation = {
    _id: "BC-RK08oPjD0",
    money: {
      payments: [
        { _id: "pay_deposit", amount: 1855, status: "SUCCEEDED", paidAt: "2026-06-26T18:00:00Z" },
        { _id: "pay_balance", amount: 1855, status: "SUCCEEDED", paidAt: "2026-06-26T18:02:30Z" },
      ],
    },
  };
  const txns = collectedPaymentsForReceipts(reservation);
  check("two same-day same-amount payments are BOTH detected", txns.length === 2, txns);
  check("each carries its stable Guesty id", txns.map((t) => t.id).sort().join(",") === "pay_balance,pay_deposit", txns.map((t) => t.id));
  const history = paymentHistoryForReceipts(reservation);
  check("payment history lists both halves -> total $3,710", history.reduce((s, p) => s + p.amount, 0) === 3710, history);
}

// 2. The SAME captured charge surfaced from money.payments AND money.transactions
//    under ONE id must fold to a single payment (no double-send).
{
  const reservation = {
    _id: "r2",
    money: {
      payments: [{ _id: "pay_1", amount: 500, status: "SUCCEEDED", paidAt: "2026-06-26T18:00:00Z" }],
      transactions: [{ _id: "pay_1", type: "payment", amount: 500, status: "succeeded", processedAt: "2026-06-26T18:00:00Z" }],
    },
  };
  check("same charge in two arrays under one id folds to one", collectedPaymentsForReceipts(reservation).length === 1, collectedPaymentsForReceipts(reservation));
}

// 3. Id-less rows keep the LEGACY day+amount+description fold (unchanged): two
//    identical id-less same-day payments still collapse to one.
{
  const reservation = {
    _id: "r3",
    money: {
      payments: [
        { amount: 300, status: "paid", paidAt: "2026-06-26T18:00:00Z", description: "Payment" },
        { amount: 300, status: "paid", paidAt: "2026-06-26T19:00:00Z", description: "Payment" },
      ],
    },
  };
  check("id-less identical same-day payments keep legacy single-fold", collectedPaymentsForReceipts(reservation).length === 1, collectedPaymentsForReceipts(reservation));
}

// 4. Distinct amounts on the same day already worked — still both detected.
{
  const reservation = {
    _id: "r4",
    money: {
      payments: [
        { _id: "x", amount: 1000, status: "SUCCEEDED", paidAt: "2026-06-26T18:00:00Z" },
        { _id: "y", amount: 2000, status: "SUCCEEDED", paidAt: "2026-06-26T18:00:00Z" },
      ],
    },
  };
  check("distinct same-day amounts both detected", collectedPaymentsForReceipts(reservation).length === 2, collectedPaymentsForReceipts(reservation));
}

// 5. Scheduled / pending balance (not yet captured) is NOT receipted — only the
//    collected deposit shows. (paymentLooksCollected excludes PENDING.)
{
  const reservation = {
    _id: "r5",
    money: {
      payments: [
        { _id: "pay_deposit", amount: 1855, status: "SUCCEEDED", paidAt: "2026-06-26T18:00:00Z" },
        { _id: "pay_balance", amount: 1855, status: "PENDING", shouldBePaidAt: "2026-08-12T01:00:00Z" },
      ],
    },
  };
  const txns = collectedPaymentsForReceipts(reservation);
  check("uncaptured scheduled balance excluded (only deposit)", txns.length === 1 && txns[0].id === "pay_deposit", txns);
}

console.log("guesty-money: transactionId extractor");
{
  check("transactionId: _id wins over id", transactionId({ _id: "a", id: "b" }) === "a");
  check("transactionId: falls back to id", transactionId({ id: "b" }) === "b");
  check("transactionId: paymentId / chargeId", transactionId({ paymentId: "p" }) === "p" && transactionId({ chargeId: "c" }) === "c");
  check("transactionId: none -> null", transactionId({ amount: 5 }) === null);
  check("transactionId: blank -> null", transactionId({ _id: "   " }) === null);
  check("transactionId: numeric id coerced to string", transactionId({ id: 12345 }) === "12345");
}

console.log(`\nguesty-money payments: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
