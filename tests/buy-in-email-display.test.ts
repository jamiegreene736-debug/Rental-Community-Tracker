import assert from "node:assert";
import {
  vendorVisibleEmailAddresses,
  MASKED_GUEST_ALIAS_LABEL,
  replySubjectForBuyInEmail,
  replyRecipientForBuyInEmail,
} from "../shared/buy-in-email-display";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("buy-in-email-display: vendor-visible sender/recipient");

const MAILBOX = "reservations@magicalislandvacations.com";
const GUEST_ALIAS = "thien.tran.4c015c@emailprivaccy.com";
const REVERSE = "info_at_waikikibeachrentals_com_ivqezgdnto@simplelogin.co";
const VENDOR = "info@waikikibeachrentals.com";
const FULL_CTX = { aliasEmail: GUEST_ALIAS, vendorEmail: VENDOR, reverseAliasEmail: REVERSE };

// ── the reported case: outbound "sent" via reverse alias ─────────────────────
{
  const v = vendorVisibleEmailAddresses(
    { direction: "outbound", status: "sent", fromEmail: MAILBOX, toEmail: REVERSE },
    FULL_CTX,
  );
  check("reverse-alias send → From = guest alias (what the PM sees)", v.from === GUEST_ALIAS);
  check("reverse-alias send → To = vendor real email", v.to === VENDOR);
  check("reverse-alias send → viaReverseAlias true", v.viaReverseAlias === true);
  check("reverse-alias send → mailboxFrom exposes the reservations mailbox", v.mailboxFrom === MAILBOX);
}

// ── sent-direct: vendor really saw reservations@ ─────────────────────────────
{
  const v = vendorVisibleEmailAddresses(
    { direction: "outbound", status: "sent-direct", fromEmail: MAILBOX, toEmail: VENDOR },
    FULL_CTX,
  );
  check("sent-direct → From stays reservations mailbox (honest)", v.from === MAILBOX);
  check("sent-direct → To stays the vendor address", v.to === VENDOR);
  check("sent-direct → viaReverseAlias false", v.viaReverseAlias === false);
  check("sent-direct → no mailboxFrom line", v.mailboxFrom === null);
}

// ── inbound: untouched passthrough ───────────────────────────────────────────
{
  const v = vendorVisibleEmailAddresses(
    { direction: "inbound", status: "received", fromEmail: VENDOR, toEmail: GUEST_ALIAS },
    FULL_CTX,
  );
  check("inbound → From passthrough", v.from === VENDOR && v.to === GUEST_ALIAS);
  check("inbound → viaReverseAlias false", v.viaReverseAlias === false && v.mailboxFrom === null);
}

// ── reverse-alias send but alias unresolved → masked label, NEVER reservations@ ──
{
  const v = vendorVisibleEmailAddresses(
    { direction: "outbound", status: "sent", fromEmail: MAILBOX, toEmail: REVERSE },
    { vendorEmail: VENDOR, reverseAliasEmail: REVERSE }, // no aliasEmail
  );
  check("no alias in ctx → From shows the masked-alias label, never reservations@", v.from === MASKED_GUEST_ALIAS_LABEL && v.from !== MAILBOX);
  check("no alias in ctx → still viaReverseAlias true", v.viaReverseAlias === true);
  // Critical: the routing note MUST still render (mailboxFrom set) so this can never
  // look like a sent-direct row that falsely asserts the PM saw reservations@.
  check("no alias in ctx → mailboxFrom still exposes reservations@ (caveat renders)", v.mailboxFrom === MAILBOX);
}

// ── legacy/null status but To matches the reverse alias ──────────────────────
{
  const v = vendorVisibleEmailAddresses(
    { direction: "outbound", status: null, fromEmail: MAILBOX, toEmail: REVERSE },
    FULL_CTX,
  );
  check("null status + To=reverse alias → treated as reverse-alias", v.viaReverseAlias === true && v.from === GUEST_ALIAS);
}

// ── outbound, unknown status, To is NOT the reverse alias → passthrough ───────
{
  const v = vendorVisibleEmailAddresses(
    { direction: "outbound", status: "queued", fromEmail: MAILBOX, toEmail: "someone@else.com" },
    FULL_CTX,
  );
  check("unknown status + non-reverse To → passthrough (not reverse)", v.viaReverseAlias === false && v.from === MAILBOX && v.to === "someone@else.com");
}

// ── case-insensitive direction ───────────────────────────────────────────────
{
  const v = vendorVisibleEmailAddresses(
    { direction: "OUTBOUND", status: "SENT", fromEmail: MAILBOX, toEmail: REVERSE },
    FULL_CTX,
  );
  check("uppercase direction/status handled", v.viaReverseAlias === true && v.from === GUEST_ALIAS);
}

// ── replySubjectForBuyInEmail: "Re:" without stacking ────────────────────────
{
  check("plain subject gets Re: prefix", replySubjectForBuyInEmail("Cancellation Request") === "Re: Cancellation Request");
  check("already Re: is left alone", replySubjectForBuyInEmail("Re: Cancellation Request") === "Re: Cancellation Request");
  check("RE: (uppercase) is left alone", replySubjectForBuyInEmail("RE: Booking") === "RE: Booking");
  check("re : (spaced) is left alone", replySubjectForBuyInEmail("re : Booking") === "re : Booking");
  check("Re[2]: (counted) is left alone", replySubjectForBuyInEmail("Re[2]: Booking") === "Re[2]: Booking");
  check("empty subject threads as a reply", replySubjectForBuyInEmail("") === "Re: (no subject)");
  check("whitespace-only subject threads as a reply", replySubjectForBuyInEmail("   ") === "Re: (no subject)");
  check("null subject threads as a reply", replySubjectForBuyInEmail(null) === "Re: (no subject)");
  check("leading whitespace trimmed before prefix", replySubjectForBuyInEmail("  Booking  ") === "Re: Booking");
  // "Fwd:" is not a reply marker — a reply to a forward still gets Re:
  check("Fwd: still gets Re: prefix", replySubjectForBuyInEmail("Fwd: Booking") === "Re: Fwd: Booking");
}

// ── replyRecipientForBuyInEmail: reply reaches the vendor's REAL address ──────
{
  // inbound: the stored From IS the PM's real address — reply straight to it,
  // even preferring it over a (possibly different) ctx.vendorEmail.
  check(
    "inbound → reply to the sender's real address",
    replyRecipientForBuyInEmail(
      { direction: "inbound", status: "received", fromEmail: VENDOR, toEmail: GUEST_ALIAS },
      FULL_CTX,
    ) === VENDOR,
  );
  check(
    "inbound → prefers the actual sender over ctx.vendorEmail",
    replyRecipientForBuyInEmail(
      { direction: "inbound", status: "received", fromEmail: "info@marinahawaiivacations.com", toEmail: GUEST_ALIAS },
      { ...FULL_CTX, vendorEmail: "other@vendor.com" },
    ) === "info@marinahawaiivacations.com",
  );
  // outbound reverse-alias: To is the …@simplelogin.co alias, NOT a reply target —
  // fall back to the known vendor real address.
  check(
    "outbound reverse-alias → reply to the vendor real address, never the reverse alias",
    replyRecipientForBuyInEmail(
      { direction: "outbound", status: "sent", fromEmail: MAILBOX, toEmail: REVERSE },
      FULL_CTX,
    ) === VENDOR,
  );
  // outbound sent-direct: the stored To already IS the vendor's real address.
  check(
    "outbound sent-direct → stored To is a valid reply target",
    replyRecipientForBuyInEmail(
      { direction: "outbound", status: "sent-direct", fromEmail: MAILBOX, toEmail: VENDOR },
      { aliasEmail: GUEST_ALIAS }, // no ctx.vendorEmail — must recover it from the row
    ) === VENDOR,
  );
  // outbound sent-direct on a MULTI-VENDOR buy-in: the render side resolves a
  // sent-direct row's ctx.vendorEmail to the buy-in's FIRST contact (Vendor A), but
  // the reply must go to the row's actual recipient (Vendor B). The row's own To wins.
  check(
    "outbound sent-direct → row's own recipient beats a mismatched ctx.vendorEmail",
    replyRecipientForBuyInEmail(
      { direction: "outbound", status: "sent-direct", fromEmail: MAILBOX, toEmail: "info@pmb.com" },
      { aliasEmail: GUEST_ALIAS, vendorEmail: "aloha@pma.com" },
    ) === "info@pmb.com",
  );
  // never reply to the reverse alias even if it somehow lands in From (defensive).
  check(
    "reverse alias in From is rejected as a reply target",
    replyRecipientForBuyInEmail(
      { direction: "inbound", status: "received", fromEmail: REVERSE, toEmail: GUEST_ALIAS },
      { reverseAliasEmail: REVERSE, vendorEmail: VENDOR },
    ) === VENDOR,
  );
  // never reply to the guest's own privacy alias.
  check(
    "guest alias is never a reply target",
    replyRecipientForBuyInEmail(
      { direction: "inbound", status: "received", fromEmail: GUEST_ALIAS, toEmail: GUEST_ALIAS },
      { aliasEmail: GUEST_ALIAS, vendorEmail: VENDOR },
    ) === VENDOR,
  );
  // nothing deliverable → null so the UI can disable Reply.
  check(
    "no deliverable address → null",
    replyRecipientForBuyInEmail(
      { direction: "inbound", status: "received", fromEmail: "not-an-email", toEmail: GUEST_ALIAS },
      {},
    ) === null,
  );
  check(
    "outbound with only a reverse-alias To and no vendor ctx → null",
    replyRecipientForBuyInEmail(
      { direction: "outbound", status: "sent", fromEmail: MAILBOX, toEmail: REVERSE },
      { aliasEmail: GUEST_ALIAS, reverseAliasEmail: REVERSE },
    ) === null,
  );
  // returned address is normalized (lowercased) so it matches the server's own
  // extractEmailAddress().toLowerCase() vendor-contact lookup.
  check(
    "reply target is lowercased",
    replyRecipientForBuyInEmail(
      { direction: "inbound", status: "received", fromEmail: "Info@MarinaHawaiiVacations.com", toEmail: GUEST_ALIAS },
      {},
    ) === "info@marinahawaiivacations.com",
  );
}

console.log(`\nbuy-in-email-display: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
