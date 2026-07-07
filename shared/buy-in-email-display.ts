// Vendor-visible sender/recipient for a stored buy-in email row.
//
// When we email a PM/vendor about a buy-in, we send FROM the reservations mailbox
// (reservations@…) TO a SimpleLogin REVERSE ALIAS (…@simplelogin.co). SimpleLogin
// then re-forwards the message to the vendor's REAL address with the visible From
// header REWRITTEN to the guest's alias (…@emailprivaccy.com) — that rewrite is the
// whole point of the reverse alias, and it's why we must send from the reservations
// mailbox (SimpleLogin only authorizes the forward when the sender is a verified
// mailbox that owns the alias). So the VENDOR sees the guest alias, never the
// reservations mailbox.
//
// Our stored outbound row records the raw SMTP envelope (From: reservations@…,
// To: <reverse alias>) — the technical routing, NOT what the vendor received.
// This helper translates a stored row into the vendor-visible sender/recipient so
// the outbound history reflects what the PM actually saw.

export type BuyInEmailRowForDisplay = {
  direction?: string | null;
  // "sent" = delivered via the SimpleLogin reverse alias (From rewritten to the
  // guest alias); "sent-direct" = reverse alias unavailable, emailed the vendor's
  // real address straight from the reservations mailbox.
  status?: string | null;
  fromEmail: string;
  toEmail: string;
};

export type VendorVisibleContext = {
  aliasEmail?: string | null; // the guest's SimpleLogin alias (…@emailprivaccy.com)
  vendorEmail?: string | null; // the PM/vendor's real address
  reverseAliasEmail?: string | null; // the …@simplelogin.co reverse alias we send TO
};

export type VendorVisibleAddresses = {
  from: string; // what the recipient sees as the sender
  to: string; // the real recipient
  viaReverseAlias: boolean; // true = SimpleLogin rewrote From to the guest alias
  mailboxFrom: string | null; // the raw reservations-mailbox sender (technical routing); set on EVERY reverse-alias row so the disclosure always renders
};

// Shown as the sender on a reverse-alias row when we can't resolve the exact guest
// alias in scope — never let the raw reservations mailbox masquerade as the sender
// (the PM never saw it), and never render indistinguishably from a sent-direct row.
export const MASKED_GUEST_ALIAS_LABEL = "the guest's private alias";

function norm(value?: string | null): string {
  return String(value ?? "").trim().toLowerCase();
}

export function vendorVisibleEmailAddresses(
  email: BuyInEmailRowForDisplay,
  ctx: VendorVisibleContext = {},
): VendorVisibleAddresses {
  const rawFrom = email.fromEmail;
  const rawTo = email.toEmail;
  const passthrough: VendorVisibleAddresses = { from: rawFrom, to: rawTo, viaReverseAlias: false, mailboxFrom: null };

  const direction = norm(email.direction) || "inbound";
  if (direction !== "outbound") return passthrough; // inbound already shows the true sender/recipient

  const status = norm(email.status);
  // Direct send: the vendor really did receive it from the reservations mailbox.
  if (status === "sent-direct") return passthrough;

  // Reverse-alias path — authoritative signal is status "sent"; also treat a row
  // whose recipient is the known reverse alias as reverse-alias (legacy/null status).
  const toMatchesReverse = !!ctx.reverseAliasEmail && norm(rawTo) === norm(ctx.reverseAliasEmail);
  if (status !== "sent" && !toMatchesReverse) return passthrough;

  // The vendor SAW the guest alias as sender and received it at their real address.
  // If the guest alias can't be resolved, show a MASKED label — the PM still never
  // saw the reservations mailbox, so we must not display it as the sender. The raw
  // reservations sender is always surfaced as `mailboxFrom` for the routing note.
  return {
    from: ctx.aliasEmail?.trim() || MASKED_GUEST_ALIAS_LABEL,
    to: ctx.vendorEmail?.trim() || rawTo,
    viaReverseAlias: true,
    mailboxFrom: rawFrom,
  };
}
