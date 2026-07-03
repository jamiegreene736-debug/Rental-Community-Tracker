import {
  buildPaymentReceiptBody,
  buildRefundReceiptBody,
  buildRefundReceiptSmsBody,
  refundSmsNeedsAttention,
  sanitizeForBookingChannel,
  receiptDedupKey,
  sameTransactionMoment,
  receiptNeedsAttention,
  RECEIPT_STALE_MS,
  formatReceiptMoney,
  formatReceiptLongDate,
  RECEIPT_SENDER_NAME,
  RECEIPT_BRAND_NAME,
} from "../shared/receipt-message";

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

console.log("receipt-message: formatters");
check("money: 2 decimals + comma", formatReceiptMoney(1234.5) === "$1,234.50");
check("money: NaN -> $0.00", formatReceiptMoney(NaN) === "$0.00");
check("date: YYYY-MM-DD -> long, no UTC drift", formatReceiptLongDate("2026-04-28") === "April 28, 2026");
check("date: full ISO sliced to day", formatReceiptLongDate("2026-12-01T08:30:00Z") === "December 1, 2026");

console.log("receipt-message: payment body");
{
  const body = buildPaymentReceiptBody({
    guestFirstName: "Michelle",
    propertyName: "Kaha Lani Resort",
    checkInIso: "2026-11-17",
    paymentAmount: 1200,
    paymentDateIso: "2026-06-10",
    bookingTotal: 3000,
    pastPayments: [{ date: "2026-05-01", amount: 1800 }],
  });
  check("payment: greets guest", body.startsWith("Hi Michelle,"), body);
  check("payment: states amount + processed wording", /a payment of \$1,200\.00 was processed on June 10, 2026/.test(body), body);
  check("payment: names property + check-in", body.includes("Kaha Lani Resort") && body.includes("check-in November 17, 2026"), body);
  check("payment: booking total line", body.includes("Booking total: $3,000.00"), body);
  check("payment: history flags this payment", body.includes("(this payment)") && body.includes("- May 1, 2026: $1,800.00"), body);
  check("payment: total paid + balance", body.includes("Total paid to date: $3,000.00") && body.includes("Remaining balance: $0.00"), body);
  check("payment: signed off", body.trim().endsWith(`Thanks,\n${RECEIPT_SENDER_NAME}\n${RECEIPT_BRAND_NAME}`), body);
}
{
  // No booking total + no past payments → minimal body, no history/balance block.
  const body = buildPaymentReceiptBody({
    guestFirstName: "",
    paymentAmount: 500,
    paymentDateIso: "2026-06-10",
  });
  check("payment: 'Hi there,' when no name", body.startsWith("Hi there,"), body);
  check("payment: no booking-total block when total unknown", !body.includes("Booking total:") && !body.includes("Remaining balance:"), body);
  check("payment: no history block for a single payment", !body.includes("Payment history:"), body);
}

console.log("receipt-message: refund body");
{
  const body = buildRefundReceiptBody({
    guestFirstName: "Nili",
    propertyName: "Makahuena at Poipu",
    refundAmount: 642.13,
    refundDateIso: "2026-06-09",
  });
  check("refund: confirms refund + amount + date", /a refund of \$642\.13 was issued on June 9, 2026/.test(body), body);
  check("refund: 5-10 business days note", body.includes("5-10 business days"), body);
  check("refund: original payment method wording", body.includes("back to your original payment method"), body);
  check("refund: signed off", body.trim().endsWith(`Thanks,\n${RECEIPT_SENDER_NAME}\n${RECEIPT_BRAND_NAME}`), body);
}

console.log("receipt-message: durable receipt link on its own line");
{
  const url = "https://app.example.com/receipt/abcdef0123456789abcdef01";
  const body = buildPaymentReceiptBody({
    guestFirstName: "Sam",
    paymentAmount: 100,
    paymentDateIso: "2026-06-10",
    receiptUrl: url,
  });
  const lines = body.split("\n");
  const idx = lines.indexOf(url);
  check("link: URL present on its own dedicated line", idx > 0 && lines[idx] === url, body);
  check("link: preceded by the 'view your receipt' lead-in", lines[idx - 1].includes("itemized receipt"), body);
}

console.log("receipt-message: Booking.com sanitization");
{
  const url = "https://app.example.com/receipt/tok";
  const bookingBody = buildRefundReceiptBody({
    guestFirstName: "José",
    propertyName: "Café Kai — Suite",
    refundAmount: 200,
    refundDateIso: "2026-06-10",
    receiptUrl: url,
    channel: "bookingCom",
  });
  check("booking: strips non-ASCII (accents/em-dash)", !/[^\x09\x0A\x0D\x20-\x7E]/.test(bookingBody), bookingBody);
  check("booking: still contains the link verbatim", bookingBody.includes(url), bookingBody);
  // A non-booking channel keeps unicode as-is.
  const airbnbBody = buildRefundReceiptBody({
    guestFirstName: "José",
    refundAmount: 200,
    refundDateIso: "2026-06-10",
    channel: "airbnb2",
  });
  check("non-booking: unicode preserved", airbnbBody.includes("José"), airbnbBody);
}
{
  check("sanitize: smart quotes + em-dash -> ASCII", sanitizeForBookingChannel("“hi” — it’s…") === '"hi" - it\'s...');
  check("sanitize: collapses 3+ blank lines", sanitizeForBookingChannel("a\n\n\n\nb") === "a\n\nb");
}

console.log("receipt-message: dedup key");
{
  const a = receiptDedupKey({ reservationId: "r1", kind: "payment", dateIso: "2026-06-10T08:00:00Z", amount: 1200 });
  const b = receiptDedupKey({ reservationId: "r1", kind: "payment", dateIso: "2026-06-10T23:59:00Z", amount: 1200.004 });
  check("dedup: same day + amount(cents) collapse to one key", a === b && a === "r1|payment|2026-06-10|1200.00", { a, b });
  const refundKey = receiptDedupKey({ reservationId: "r1", kind: "refund", dateIso: "2026-06-10", amount: -1200 });
  check("dedup: refund keyed distinctly + abs amount", refundKey === "r1|refund|2026-06-10|1200.00", refundKey);
  check("dedup: different amount -> different key", receiptDedupKey({ reservationId: "r1", kind: "payment", dateIso: "2026-06-10", amount: 50 }) !== a);
}

console.log("receipt-message: dedup key with txn id (50/50 same-day fix)");
{
  // No id -> EXACT legacy key (backward compatible).
  const noId = receiptDedupKey({ reservationId: "r1", kind: "payment", dateIso: "2026-06-26T18:00:00Z", amount: 1855 });
  check("dedup(id): no id reproduces legacy key", noId === "r1|payment|2026-06-26|1855.00", noId);
  check("dedup(id): blank id -> legacy key", receiptDedupKey({ reservationId: "r1", kind: "payment", dateIso: "2026-06-26", amount: 1855, id: "  " }) === noId);
  // Two same-day, same-amount charges (deposit + auto-charged balance) with
  // DISTINCT ids -> DISTINCT keys. This is the bug fix: previously they collapsed.
  const depositKey = receiptDedupKey({ reservationId: "r1", kind: "payment", dateIso: "2026-06-26T18:00:00Z", amount: 1855, id: "pay_deposit" });
  const balanceKey = receiptDedupKey({ reservationId: "r1", kind: "payment", dateIso: "2026-06-26T18:02:30Z", amount: 1855, id: "pay_balance" });
  check("dedup(id): same day+amount, different id -> DIFFERENT keys", depositKey !== balanceKey, { depositKey, balanceKey });
  check("dedup(id): id appended to legacy base", depositKey === "r1|payment|2026-06-26|1855.00|pay_deposit", depositKey);
  // Same charge read twice (stable id, jittered timestamp/cents) -> SAME key,
  // so the scheduler never double-sends across polls.
  const reread = receiptDedupKey({ reservationId: "r1", kind: "payment", dateIso: "2026-06-26T18:00:00.456Z", amount: 1855.004, id: "pay_deposit" });
  check("dedup(id): same id across reads -> stable key (no double-send)", reread === depositKey, { reread, depositKey });
}

console.log("receipt-message: sameTransactionMoment (migration shim)");
{
  check("moment: identical ISO -> same", sameTransactionMoment("2026-06-26T18:00:00Z", "2026-06-26T18:00:00Z"));
  check("moment: same instant, different format -> same", sameTransactionMoment("2026-06-26T18:00:00Z", "2026-06-26T18:00:00.000+00:00"));
  check("moment: deposit vs balance same day -> DIFFERENT", !sameTransactionMoment("2026-06-26T18:00:00Z", "2026-06-26T18:02:30Z"));
  check("moment: missing -> false", !sameTransactionMoment(null, "2026-06-26T18:00:00Z") && !sameTransactionMoment("2026-06-26T18:00:00Z", ""));
}

console.log("receipt-message: receiptNeedsAttention (non-delivery safety net)");
{
  const now = 1_700_000_000_000;
  const fresh = now - 60_000;                 // 1 min ago
  const stale = now - (RECEIPT_STALE_MS + 60_000); // past the stale threshold
  check("misroute always needs attention", receiptNeedsAttention({ status: "misroute", createdAtMs: fresh }, now));
  check("sent never needs attention", !receiptNeedsAttention({ status: "sent", createdAtMs: stale }, now));
  check("unconfirmed reached the OTA -> no attention", !receiptNeedsAttention({ status: "unconfirmed", createdAtMs: stale }, now));
  check("manual page -> no attention", !receiptNeedsAttention({ status: "page", createdAtMs: stale }, now));
  check("fresh error retries silently -> no attention", !receiptNeedsAttention({ status: "error", createdAtMs: fresh }, now));
  check("STALE error -> needs attention", receiptNeedsAttention({ status: "error", createdAtMs: stale }, now));
  check("fresh pending -> no attention", !receiptNeedsAttention({ status: "pending", createdAtMs: fresh }, now));
  check("STALE pending -> needs attention", receiptNeedsAttention({ status: "pending", createdAtMs: stale }, now));
  check("error with unknown age -> surfaced", receiptNeedsAttention({ status: "error", createdAtMs: null }, now));
}

console.log("receipt-message: refund SMS leg (text to the guest's phone on file)");
{
  const sms = buildRefundReceiptSmsBody({
    guestFirstName: "Cheryl",
    propertyName: "Santa Maria 214",
    refundAmount: 350,
    refundDateIso: "2026-07-03T18:00:00Z",
    receiptUrl: "https://admin.vacationrentalexpertz.com/receipt/abc123",
  });
  check("sms: greets the guest by first name", sms.startsWith("Hi Cheryl,"), sms);
  check("sms: names sender + brand", sms.includes(RECEIPT_SENDER_NAME) && sms.includes(RECEIPT_BRAND_NAME));
  check("sms: states the refund amount + date", sms.includes("$350.00") && sms.includes("July 3, 2026"));
  check("sms: names the property", sms.includes("Santa Maria 214"));
  check("sms: includes the durable receipt link", sms.includes("https://admin.vacationrentalexpertz.com/receipt/abc123"));
  check("sms: sets the 5-10 business day expectation", /5-10 business days/.test(sms));
  check("sms: ASCII-only (SMS-safe)", !/[^\x09\x0A\x0D\x20-\x7E]/.test(sms), sms);
  check("sms: comfortably under the Quo 1600-char cap", sms.length <= 640, sms.length);
  const noUrl = buildRefundReceiptSmsBody({ guestFirstName: "", refundAmount: 25, refundDateIso: "2026-07-01" });
  check("sms: degrades without name/property/url", noUrl.startsWith("Hi there,") && !noUrl.includes("Receipt:"), noUrl);
}

console.log("receipt-message: refundSmsNeedsAttention (text confirmation safety net)");
{
  check("refund + sms error -> attention", refundSmsNeedsAttention({ kind: "refund", smsStatus: "error" }));
  check("refund + no phone on file -> attention", refundSmsNeedsAttention({ kind: "refund", smsStatus: "no-phone" }));
  check("refund + sms sent -> ok", !refundSmsNeedsAttention({ kind: "refund", smsStatus: "sent" }));
  check("refund + not attempted (null) -> ok", !refundSmsNeedsAttention({ kind: "refund", smsStatus: null }));
  check("refund + SMS not configured -> ok (nothing per-refund actionable)", !refundSmsNeedsAttention({ kind: "refund", smsStatus: "not-configured" }));
  check("payment rows never flag on sms", !refundSmsNeedsAttention({ kind: "payment", smsStatus: "error" }));
}

console.log(`\nreceipt-message: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
