// Locks the 2026-07-20 alias-inbox changes:
// 1. AUTO-MARK BOUGHT IN — any INBOUND email at a unit's alias verifies the
//    purchase (operator: "any email hitting is verification") and flips the
//    owning buy-in to the durable "booked" state at BOTH ingestion seams
//    (guest_inbox_messages + buy_in_emails) and on both panel reads.
// 2. The Gmail-style two-pane "Alias email history" redesign in bookings.tsx.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aliasEmailProvesPurchase, hasInboundAliasEmail } from "../shared/alias-bought-in";

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

console.log("alias-bought-in: purchase-proof predicate");

const activeBuyIn = { bookingStatus: "not_started", status: "active" };
const inbound = [{ direction: "inbound" }];

check("inbound email at an active unmarked buy-in proves the purchase",
  aliasEmailProvesPurchase(activeBuyIn, inbound));
check("awaiting_payment flips too (the confirmation email IS the proof)",
  aliasEmailProvesPurchase({ bookingStatus: "awaiting_payment", status: "active" }, inbound));
check("request_submitted flips too (host accepted → confirmation email)",
  aliasEmailProvesPurchase({ bookingStatus: "request_submitted", status: "active" }, inbound));
check("already-booked rows are never re-marked (bookedAt stays the first proof)",
  !aliasEmailProvesPurchase({ bookingStatus: "booked", status: "active" }, inbound));
check("cancelled buy-ins are left alone",
  !aliasEmailProvesPurchase({ bookingStatus: "not_started", status: "cancelled" }, inbound));
check("outbound-only mail proves nothing (our own sends)",
  !aliasEmailProvesPurchase(activeBuyIn, [{ direction: "outbound" }]));
check("no mail proves nothing",
  !aliasEmailProvesPurchase(activeBuyIn, []));
check("missing buy-in proves nothing",
  !aliasEmailProvesPurchase(null, inbound));
check("mixed directions still count the inbound",
  aliasEmailProvesPurchase(activeBuyIn, [{ direction: "outbound" }, { direction: "INBOUND" }]));
check("hasInboundAliasEmail is direction-exact",
  hasInboundAliasEmail([{ direction: "inbound" }]) && !hasInboundAliasEmail([{ direction: "out" }]));

// ── Source assertions: both ingestion seams + both panel reads + the UI ─────
console.log("alias-bought-in: source wiring");
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", rel), "utf8");
const guestInboxSyncSrc = read("server/guest-inbox-sync.ts");
const buyInEmailSyncSrc = read("server/buy-in-email-sync.ts");
const routesSrc = read("server/routes.ts");
const bookingsSrc = read("client/src/pages/bookings.tsx");

check("guest-inbox-sync: the ONE marker records the durable booked transition",
  guestInboxSyncSrc.includes("markBuyInBoughtInFromInboundEmail")
  && guestInboxSyncSrc.includes('bookingStatus: "booked"')
  // storage.updateBuyIn bypasses the HTTP handler's auto-stamp — bookedAt must
  // be set explicitly here or the proof time is lost.
  && guestInboxSyncSrc.includes("bookedAt: new Date()")
  && guestInboxSyncSrc.includes("aliasEmailProvesPurchase"));
check("guest-inbox-sync: kill switch",
  guestInboxSyncSrc.includes("ALIAS_AUTO_BOUGHT_IN_DISABLED"));
check("guest-inbox-sync: fires at the ingestion seam (new mail via the 5-min tick)",
  guestInboxSyncSrc.includes("await autoMarkBoughtInFromAliasEmails(aliasEmail)"));
check("buy-in-email-sync: fires after the inbound buy_in_emails insert",
  buyInEmailSyncSrc.includes("markBuyInBoughtInFromInboundEmail(buyInId, parsed.aliasEmail"));
check("routes: GET /api/guest-inbox reconciles + reports the flip",
  routesSrc.includes("autoMarkBoughtInFromAliasEmails(aliasEmail)")
  && routesSrc.includes("autoMarkedBoughtIn,"));
check("routes: buy-in-communications reconciles every inbound email's buy-in + reports ids",
  routesSrc.includes('markBuyInBoughtInFromInboundEmail(targetId, String(email.toEmail ?? ""), "buy-in-communications")')
  && routesSrc.includes("autoMarkedBuyInIds"));
check("bookings: panels refresh the rows when a read performed the flip",
  bookingsSrc.includes("autoMarkedBuyInIds")
  && bookingsSrc.includes("autoMarkedBoughtIn")
  && bookingsSrc.includes("Marked bought in"));

console.log("alias-bought-in: Gmail-style alias inbox");
check("two-pane layout with a message-list sidebar + reading pane",
  bookingsSrc.includes("alias-inbox-row-")
  && bookingsSrc.includes("alias-inbox-")
  && bookingsSrc.includes("md:flex-row"));
check("newest email opens by default; a stale selection falls back",
  bookingsSrc.includes("?? emails[0] ?? null"));
check("list snippets reuse the SAME body formatter as the reading pane",
  bookingsSrc.includes("aliasEmailSnippet")
  && bookingsSrc.includes("formatEmailBodyForDisplay(String(body ?? \"\"))"));
check("reading pane keeps the masked-address + reply plumbing",
  bookingsSrc.includes("vendorVisibleEmailAddresses")
  && bookingsSrc.includes("replyRecipientForBuyInEmail"));
check("switching messages closes a reply drafted on another one",
  bookingsSrc.includes("if (replyingId !== null && replyingId !== email.id) closeReply();"));

console.log(`\nalias-bought-in: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
