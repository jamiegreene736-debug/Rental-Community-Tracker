// Locks the 2026-07-19 actually-paid rate feature:
// 1. PURE EXTRACTION — label-anchored charged-total extraction from inbound
//    alias emails (booking-total labels beat paid-so-far labels; due/balance/
//    refund/per-night/installment lines never produce a candidate; newest
//    email wins within a tier).
// 2. TONE — green when paid <= recorded cost (+tolerance), red when we paid
//    more than the books say.
// 3. SOURCE WIRING — the extraction fires at the SAME four seams as the
//    auto-mark-bought-in feature (both IMAP ingesters + both panel reads),
//    the columns exist in schema + boot ALTER, and the slot card renders it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPaidAmountFromEmailText,
  selectPaidRateFromEmails,
  paidRateTone,
  paidRateNeedsWrite,
  paidRateSourceRecord,
  type PaidRateEmail,
} from "../shared/paid-rate-extraction";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
};

console.log("paid-rate-extraction: single-email extraction");

const vrboConfirmation = [
  "Your booking is confirmed!",
  "5 nights x $250.00",
  "Cleaning fee $180.00",
  "Service fee $95.00",
  "Taxes $... whatever",
  "Total $1,405.00",
  "Amount due at check-in: $0.00",
].join("\n");
{
  const got = extractPaidAmountFromEmailText("Booking confirmed", vrboConfirmation);
  check("VRBO confirmation Total wins", got?.amount === 1405 && got?.label === "total");
  check("quote is the verbatim line", (got?.quote ?? "").includes("Total $1,405.00"));
}

{
  // Table layout: label and amount on adjacent lines.
  const got = extractPaidAmountFromEmailText(null, "Payment summary\nTotal\n$1,837.42\nThanks!");
  check("adjacent-line table layout extracts the total", got?.amount === 1837.42);
}

{
  // Paid-so-far label works when no total exists…
  const got = extractPaidAmountFromEmailText(null, "Amount paid: $702.50\nWe look forward to hosting you");
  check("amount-paid label extracts at tier 1", got?.amount === 702.5 && got?.tier === 1);
  // …but a booking total in the SAME email beats it (split-payment deposit
  // receipts must not report the installment as the unit's paid rate).
  const both = extractPaidAmountFromEmailText(null, "Amount paid: $702.50\nTotal $1,405.00");
  check("booking total outranks the installment in one email", both?.amount === 1405 && both?.tier === 2);
}

check("amount due / balance lines never produce a candidate",
  extractPaidAmountFromEmailText(null, "Balance due: $702.50\nAmount due Aug 1: $702.50") == null);
check("refund lines never produce a candidate",
  extractPaidAmountFromEmailText(null, "Refund total $250.00") == null);
check("per-night rates never produce a candidate",
  extractPaidAmountFromEmailText(null, "Total per night $250.00\nAvg nightly total: $250") == null);
check("installment schedule rows (payment 1/2) are excluded",
  extractPaidAmountFromEmailText(null, "Payment 1 total: $702.50") == null);
check("no currency mark = no candidate (Total nights: 5)",
  extractPaidAmountFromEmailText(null, "Total nights: 5") == null);
check("host welcome email with no figures yields nothing",
  extractPaidAmountFromEmailText("Aloha!", "Welcome, we're excited to host you. Parking is stall 12.") == null);
check("implausible amounts are rejected",
  extractPaidAmountFromEmailText(null, "Total $450,000.00") == null);
check("USD-prefixed amounts parse", extractPaidAmountFromEmailText(null, "Total: USD 1,405.00")?.amount === 1405);
{
  const multi = extractPaidAmountFromEmailText(null, "Total $700.00\nsome lines\nGrand total $1,405.00");
  check("last same-tier match wins (final summary)", multi?.amount === 1405);
}

console.log("paid-rate-extraction: cross-email selection");

const mk = (over: Partial<PaidRateEmail>): PaidRateEmail => ({
  direction: "inbound",
  subject: "s",
  body: "",
  at: "2026-07-01T00:00:00Z",
  mailbox: "guest-inbox",
  ...over,
});

{
  const picked = selectPaidRateFromEmails([
    mk({ id: 1, body: "Total $1,405.00", at: "2026-07-01T00:00:00Z" }),
    mk({ id: 2, body: "Aloha, welcome!", at: "2026-07-02T00:00:00Z" }),
  ]);
  check("figure-less newer email does not mask the confirmation", picked?.amount === 1405 && picked?.email.id === 1);
}
{
  const picked = selectPaidRateFromEmails([
    mk({ id: 1, body: "Total $1,405.00", at: "2026-07-01T00:00:00Z" }),
    mk({ id: 2, body: "Total $1,350.00 after your host adjusted the price", at: "2026-07-03T00:00:00Z" }),
  ]);
  check("newest total wins across emails (price adjustments heal)", picked?.amount === 1350 && picked?.email.id === 2);
}
{
  const picked = selectPaidRateFromEmails([
    mk({ id: 1, body: "Total $1,405.00", at: "2026-07-01T00:00:00Z" }),
    mk({ id: 2, body: "Amount paid: $702.50", at: "2026-07-05T00:00:00Z" }),
  ]);
  check("older booking TOTAL beats a newer paid-so-far receipt", picked?.amount === 1405);
}
check("outbound emails are ignored (our own composes prove nothing)",
  selectPaidRateFromEmails([mk({ direction: "outbound", body: "Total $999.00" })]) == null);
check("empty mailbox yields nothing", selectPaidRateFromEmails([]) == null);

{
  const picked = selectPaidRateFromEmails([mk({ id: 7, fromEmail: "no-reply@vrbo.com", body: "Total $1,405.00" })])!;
  const rec = paidRateSourceRecord(picked, new Date("2026-07-19T00:00:00Z"));
  check("provenance record carries mailbox/email/quote/amount",
    rec.mailbox === "guest-inbox" && rec.emailId === 7 && rec.fromEmail === "no-reply@vrbo.com"
    && rec.amount === 1405 && rec.quote.includes("$1,405.00") && rec.extractedAt === "2026-07-19T00:00:00.000Z");
}

console.log("paid-rate-extraction: tone + write rules");

check("paid == recorded cost is green", paidRateTone("1405.00", 1405) === "green");
check("paid under recorded cost is green", paidRateTone("1500.00", 1405) === "green");
check("tiny rounding drift stays green ($1 tolerance)", paidRateTone("1405.00", 1405.9) === "green");
check("paid over recorded cost is red", paidRateTone("1405.00", 1500) === "red");
check("no recorded cost renders green (nothing contradicts the paid rate)", paidRateTone(0, 1405) === "green");
check("no paid rate renders nothing", paidRateTone("1405.00", null) === null);

const pickedSel = selectPaidRateFromEmails([mk({ body: "Total $1,405.00" })])!;
check("write when nothing stored", paidRateNeedsWrite(null, pickedSel));
check("skip when the same amount is already stored", !paidRateNeedsWrite("1405.00", pickedSel));
check("write when the amount changed", paidRateNeedsWrite("1300.00", pickedSel));

// ── Source assertions: schema, boot ALTER, the four seams, UI, report ───────
console.log("paid-rate-extraction: source wiring");
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", rel), "utf8");
const schemaSrc = read("shared/schema.ts");
const maintSrc = read("server/schema-maintenance.ts");
const engineSrc = read("server/paid-rate-extract.ts");
const guestInboxSyncSrc = read("server/guest-inbox-sync.ts");
const buyInEmailSyncSrc = read("server/buy-in-email-sync.ts");
const routesSrc = read("server/routes.ts");
const bookingsSrc = read("client/src/pages/bookings.tsx");

check("schema: buy_ins carries paid_rate + paid_rate_source",
  schemaSrc.includes('numeric("paid_rate"') && schemaSrc.includes('jsonb("paid_rate_source")'));
check("schema-maintenance: boot ALTER adds both columns idempotently",
  maintSrc.includes("ADD COLUMN IF NOT EXISTS paid_rate numeric(10,2)")
  && maintSrc.includes("ADD COLUMN IF NOT EXISTS paid_rate_source jsonb"));
check("engine: kill switch + pure selection + both mailboxes",
  engineSrc.includes("PAID_RATE_EXTRACT_DISABLED")
  && engineSrc.includes("selectPaidRateFromEmails")
  && engineSrc.includes("getGuestInboxMessages")
  && engineSrc.includes("buyInEmails"));
check("seam 1: guest-inbox IMAP ingestion refreshes the paid rate",
  guestInboxSyncSrc.includes("refreshPaidRateForAlias"));
check("seam 2: buy-in-email IMAP ingestion refreshes the paid rate",
  buyInEmailSyncSrc.includes("refreshPaidRateForBuyIn"));
check("seam 3: buy-in-communications panel read reconciles + surfaces ids",
  routesSrc.includes("paidRateUpdatedBuyInIds"));
check("seam 4: guest-inbox panel read reconciles + surfaces the flag",
  routesSrc.includes("paidRateUpdated,"));
check("reporting: GET /api/reports/buy-in-paid-rates serves the stored rows",
  routesSrc.includes("/api/reports/buy-in-paid-rates") && routesSrc.includes("paidRateSource: b.paidRateSource"));
check("UI: slot card renders the green/red paid figure next to the cost",
  bookingsSrc.includes("paidRateTone(slot.buyIn.costPaid")
  && bookingsSrc.includes("text-paid-rate-")
  && bookingsSrc.includes("text-red-600")
  && bookingsSrc.includes("paid {fmtMoney(paid)}"));
check("UI: both panel reads trigger a bookings-row refresh",
  bookingsSrc.includes("paidRateUpdatedBuyInIds") && bookingsSrc.includes("paidRateUpdated"));

console.log(`\npaid-rate-extraction: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
