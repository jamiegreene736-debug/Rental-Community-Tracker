// Pure, dependency-free builders for the AUTOMATED guest receipt messages
// (a payment we collected, or a refund we issued) plus the Booking.com
// channel sanitizer and a per-transaction dedup key.
//
// Shared so the server scheduler (server/guest-receipts.ts) and any future
// client preview render the SAME copy. The wording + "Thanks, John Carpenter /
// VacationRentalExpertz" sign-off mirror the MANUAL inbox receipt
// (client/src/pages/inbox.tsx `buildReceiptBody`) so an auto receipt and a
// hand-sent one read identically to the guest.
//
// Keep this file zero-dependency (no server/client imports) — it is unit
// tested in tests/receipt-message.test.ts.

export const RECEIPT_SENDER_NAME = "John Carpenter";
export const RECEIPT_BRAND_NAME = "VacationRentalExpertz";

export type ReceiptKind = "payment" | "refund";

export function formatReceiptMoney(n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  return `$${safe.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// `new Date("2026-04-28")` parses as UTC midnight, which renders as the prior
// day in negative-offset timezones. Build in local time so the receipt's date
// matches the operator's wall clock. Accepts a full ISO timestamp or a bare
// YYYY-MM-DD; slices to the date part either way.
export function formatReceiptLongDate(iso: string): string {
  const ymd = String(iso ?? "").slice(0, 10);
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd || "";
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// Make a body safe for Booking.com guest messaging, which strips rich text and
// rejects/garbles non-ASCII. Plain ASCII only, straight quotes, hyphens for
// dashes, single blank lines. Verbatim-equivalent to routes.ts
// `sanitizeForBookingChannel` so the auto path and the relocation path format
// identically.
export function sanitizeForBookingChannel(text: string): string {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[…]/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A channel string that "includes booking" → Booking.com plain-text rules.
// Matches both the integration platform string "bookingCom" and a raw
// "Booking.com" source label.
export function isBookingChannel(channel?: string | null): boolean {
  return String(channel ?? "").toLowerCase().includes("booking");
}

function receiptLinkLines(receiptUrl?: string | null): string[] {
  const url = String(receiptUrl ?? "").trim();
  if (!url) return [];
  // The URL sits on its OWN line — load-bearing for Booking.com link delivery
  // (the channel only renders a link once the property allowlists the domain in
  // the extranet, and only when the link is not wrapped in other text).
  return ["You can view your full itemized receipt here:", url, ""];
}

export interface PaymentReceiptArgs {
  guestFirstName?: string;
  propertyName?: string;
  checkInIso?: string | null;
  paymentAmount: number;
  paymentDateIso: string;
  bookingTotal?: number;
  pastPayments?: Array<{ date: string; amount: number }>;
  receiptUrl?: string | null;
  channel?: string | null;
}

// Payment-received receipt. `pastPayments` (optional) lists prior payments on
// the booking; today's charge is supplied separately as paymentAmount /
// paymentDateIso so it can be flagged "(this payment)" in the history. The
// payment-history + balance block only renders when we actually know the
// booking total (degrade-safe for channels that don't expose it).
export function buildPaymentReceiptBody(args: PaymentReceiptArgs): string {
  const past = (args.pastPayments ?? [])
    .filter((p) => p && p.amount > 0)
    .map((p) => ({ date: p.date, amount: p.amount, isToday: false }));
  const todayRow =
    args.paymentAmount > 0
      ? [{ date: args.paymentDateIso, amount: args.paymentAmount, isToday: true }]
      : [];
  const allPayments = [...past, ...todayRow];
  const totalPaid = allPayments.reduce((sum, p) => sum + p.amount, 0);
  const bookingTotal = Number(args.bookingTotal) || 0;
  const balance = Math.max(0, bookingTotal - totalPaid);
  const stayLabel = args.propertyName ? ` for your stay at ${args.propertyName}` : "";
  const checkInLine = args.checkInIso ? ` (check-in ${formatReceiptLongDate(args.checkInIso)})` : "";

  const lines: string[] = [
    `Hi ${args.guestFirstName || "there"},`,
    ``,
    // Channel-neutral wording: this auto-receipt fires for Airbnb/VRBO/
    // Booking.com/direct, and we do not hold the card on the OTA channels, so
    // we say "a payment was processed" rather than "we charged the card".
    `This is ${RECEIPT_SENDER_NAME} with ${RECEIPT_BRAND_NAME} confirming a payment of ${formatReceiptMoney(args.paymentAmount)} was processed on ${formatReceiptLongDate(args.paymentDateIso)}${stayLabel}${checkInLine}.`,
  ];

  if (bookingTotal > 0) {
    lines.push(``, `Booking total: ${formatReceiptMoney(bookingTotal)}`);
  }

  if (allPayments.length > 1) {
    lines.push(``, `Payment history:`);
    for (const p of allPayments) {
      const dateLabel = p.date ? formatReceiptLongDate(p.date) : "Date -";
      const tag = p.isToday ? " (this payment)" : "";
      lines.push(`  - ${dateLabel}: ${formatReceiptMoney(p.amount)}${tag}`);
    }
  }

  if (bookingTotal > 0) {
    lines.push(
      ``,
      `Total paid to date: ${formatReceiptMoney(totalPaid)}`,
      `Remaining balance: ${formatReceiptMoney(balance)}`,
    );
  }

  lines.push(``, ...receiptLinkLines(args.receiptUrl));
  lines.push(
    `If you have any questions about this charge or your reservation, just reply to this message - happy to help.`,
    ``,
    `Thanks,`,
    RECEIPT_SENDER_NAME,
    RECEIPT_BRAND_NAME,
  );

  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return isBookingChannel(args.channel) ? sanitizeForBookingChannel(body) : body;
}

export interface RefundReceiptArgs {
  guestFirstName?: string;
  propertyName?: string;
  checkInIso?: string | null;
  refundAmount: number;
  refundDateIso: string;
  receiptUrl?: string | null;
  channel?: string | null;
}

// Refund-issued receipt.
export function buildRefundReceiptBody(args: RefundReceiptArgs): string {
  const stayLabel = args.propertyName ? ` for your stay at ${args.propertyName}` : "";
  const checkInLine = args.checkInIso ? ` (check-in ${formatReceiptLongDate(args.checkInIso)})` : "";
  const lines: string[] = [
    `Hi ${args.guestFirstName || "there"},`,
    ``,
    `This is ${RECEIPT_SENDER_NAME} with ${RECEIPT_BRAND_NAME} confirming a refund of ${formatReceiptMoney(args.refundAmount)} was issued on ${formatReceiptLongDate(args.refundDateIso)}${stayLabel}${checkInLine}.`,
    ``,
    `Refund amount: ${formatReceiptMoney(args.refundAmount)}`,
    `The refund goes back to your original payment method and typically takes 5-10 business days to appear on your statement, depending on your bank or card issuer.`,
    ``,
    ...receiptLinkLines(args.receiptUrl),
    `If you have any questions about this refund or your reservation, just reply to this message - happy to help.`,
    ``,
    `Thanks,`,
    RECEIPT_SENDER_NAME,
    RECEIPT_BRAND_NAME,
  ];
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return isBookingChannel(args.channel) ? sanitizeForBookingChannel(body) : body;
}

// Stable per-transaction identity so a given payment/refund is messaged exactly
// once. `reservationId|kind|day|amount`, with the stable Guesty transaction id
// appended (`|<id>`) when one is available.
//
// HISTORY (do not regress): the original key was day+amount ONLY, deliberately
// dropping the txn id so the key stayed stable across polls (never double-send).
// The accepted cost was that two GENUINELY-DISTINCT same-day, same-cent charges
// collapse to ONE receipt. That case is NOT rare in vacation-rental billing — a
// 50/50 deposit + balance split has two equal halves, and when a booking is made
// inside the "balance due N days before arrival" window Guesty auto-charges the
// balance the SAME day as the deposit. So the guest got one receipt for two
// charges and no "paid in full" confirmation (operator-reported, see PR #TBD /
// the 2026-06-30 Decision Log).
//
// FIX: the Guesty txn `_id` IS the right discriminator (and is itself stable
// across polls — it is immutable, more so than the timestamp the old comment
// feared). Appending it splits two same-day same-amount charges into two
// receipts. The day+amount stay in the key as the human-readable, jitter-stable
// base; the migration shim in guest-receipts.ts (sameTransactionMoment) keeps a
// pre-id-upgrade legacy row (`reservationId|kind|day|amount`, no suffix) from
// re-sending. Omitting the id reproduces the EXACT legacy key, so id-less shapes
// are byte-for-byte backward compatible.
export function receiptDedupKey(args: {
  reservationId: string;
  kind: ReceiptKind;
  dateIso: string;
  amount: number;
  id?: string | null;
}): string {
  const day = String(args.dateIso ?? "").slice(0, 10);
  const amt = (Number.isFinite(args.amount) ? Math.abs(args.amount) : 0).toFixed(2);
  const base = `${args.reservationId}|${args.kind}|${day}|${amt}`;
  const id = String(args.id ?? "").trim();
  return id ? `${base}|${id}` : base;
}

// Do two ISO timestamps name the SAME charge moment? Used by the guest-receipts
// migration shim to tell whether a legacy (id-less) ledger row was for THIS exact
// transaction or for a DIFFERENT same-day same-amount one (e.g. the deposit when
// this is the balance). Exact-instant match only — no tolerance window — so two
// genuinely-distinct charges are never merged.
export function sameTransactionMoment(aIso?: string | null, bIso?: string | null): boolean {
  const a = String(aIso ?? "").trim();
  const b = String(bIso ?? "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}
