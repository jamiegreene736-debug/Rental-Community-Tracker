import assert from "node:assert";
import { vendorVisibleEmailAddresses, MASKED_GUEST_ALIAS_LABEL } from "../shared/buy-in-email-display";

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

console.log(`\nbuy-in-email-display: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
