// Auto-mark a buy-in as BOUGHT IN when email arrives at its traveler alias.
//
// The per-buy-in SimpleLogin alias (buy_ins.travelerEmail) is used for exactly
// one thing: the traveler email on that unit's checkout. Nobody mails it until
// a real booking exists — VRBO's confirmation, the host's welcome message, the
// PM's arrival details all follow an actual purchase. So ANY inbound email at
// the alias is operator-grade proof the unit was bought in (operator directive
// 2026-07-20: "any email hitting is verification"), and the portal records the
// same durable transition the "Mark as bought in" button would.
//
// Deliberately conservative about WHEN it fires, not WHETHER:
// - inbound only — our own outbound rows (replies, arrival-details requests
//   composed from the portal) prove nothing;
// - never overwrites an existing "booked" row (bookedAt stays the FIRST proof);
// - a cancelled/detached buy-in is left alone — marking it booked would arm
//   the never-re-book guard on a row the operator abandoned.

export type AliasBoughtInBuyIn = {
  bookingStatus?: string | null;
  status?: string | null;
};

export type AliasBoughtInEmail = {
  direction?: string | null;
};

/** True when at least one message is a genuine INBOUND email at the alias. */
export function hasInboundAliasEmail(messages: ReadonlyArray<AliasBoughtInEmail>): boolean {
  return messages.some((m) => String(m?.direction ?? "").trim().toLowerCase() === "inbound");
}

/**
 * Should this buy-in be auto-marked bought in, given the alias mailbox
 * contents? Pure decision — the caller performs the actual PATCH.
 */
export function aliasEmailProvesPurchase(
  buyIn: AliasBoughtInBuyIn | null | undefined,
  messages: ReadonlyArray<AliasBoughtInEmail>,
): boolean {
  if (!buyIn) return false;
  if (String(buyIn.status ?? "").trim().toLowerCase() === "cancelled") return false;
  if (String(buyIn.bookingStatus ?? "").trim().toLowerCase() === "booked") return false;
  return hasInboundAliasEmail(messages);
}
