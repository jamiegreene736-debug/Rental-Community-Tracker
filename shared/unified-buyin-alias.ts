// Unified per-unit buy-in alias (2026-07-19, operator): each attached buy-in
// carries exactly ONE SimpleLogin alias — the (reservationId, buyInId)-scoped
// unit alias — used BOTH as the VRBO traveler/booking email and as the
// PM/arrival-details thread address. Because both IMAP ingesters (buy_in_emails
// via buy-in-email-sync, guest_inbox_messages via guest-inbox-sync) watch the
// SAME mailbox filtered by that one address, an inbound email can land in BOTH
// tables. This module is the pure display-side merge/dedupe so the bookings-page
// panel renders ONE history instead of the same email twice.

export type AliasThreadPmEmail = {
  id: number;
  direction: string;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  providerMessageId?: string | null;
  sentAt?: string | Date | null;
};

export type AliasThreadBookingMessage = {
  id: number;
  direction?: string | null;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  providerMessageId?: string | null;
  receivedAt?: string | Date | null;
};

// RFC Message-IDs arrive with/without angle brackets depending on the ingester.
export function normalizeProviderMessageId(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/^<+|>+$/g, "").trim();
}

function normalizeSubjectForDedupe(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^\s*(re|fwd?|fw)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function timeOf(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isNaN(t) ? null : t;
}

// Same email captured by both ingesters: identical Message-ID, or (fallback for
// providers that strip it) same normalized subject + same sender + timestamps
// within a small window. Direction must agree — an outbound PM email and an
// inbound host reply with a quoted subject must NOT fold together.
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export function bookingMessageDuplicatesPmEmail(
  message: AliasThreadBookingMessage,
  email: AliasThreadPmEmail,
): boolean {
  const dirA = String(message.direction ?? "inbound").toLowerCase();
  const dirB = String(email.direction ?? "").toLowerCase();
  if (dirA !== dirB) return false;
  const idA = normalizeProviderMessageId(message.providerMessageId);
  const idB = normalizeProviderMessageId(email.providerMessageId);
  if (idA && idB) return idA === idB;
  const subjA = normalizeSubjectForDedupe(message.subject);
  const subjB = normalizeSubjectForDedupe(email.subject);
  if (!subjA || subjA !== subjB) return false;
  const fromA = String(message.fromEmail ?? "").trim().toLowerCase();
  const fromB = String(email.fromEmail ?? "").trim().toLowerCase();
  if (!fromA || fromA !== fromB) return false;
  const tA = timeOf(message.receivedAt);
  const tB = timeOf(email.sentAt);
  if (tA == null || tB == null) return true; // same subject+sender+direction, no timestamps — treat as dupe
  return Math.abs(tA - tB) <= DEDUPE_WINDOW_MS;
}

export type MergedAliasThreadRow<
  E extends AliasThreadPmEmail = AliasThreadPmEmail,
  M extends AliasThreadBookingMessage = AliasThreadBookingMessage,
> =
  | { source: "pm"; timestamp: number | null; email: E }
  | { source: "booking"; timestamp: number | null; message: M };

/**
 * One combined history: every PM/vendor row (rich card, reply-able) plus the
 * booking-thread messages that are NOT the same email seen through the other
 * ingester. PM rows win the tie because they carry attachments + the
 * reverse-alias reply path. Sorted newest-first.
 */
export function mergeAliasThread<E extends AliasThreadPmEmail, M extends AliasThreadBookingMessage>(
  emails: E[],
  messages: M[],
): MergedAliasThreadRow<E, M>[] {
  const rows: MergedAliasThreadRow<E, M>[] = emails.map((email) => ({
    source: "pm" as const,
    timestamp: timeOf(email.sentAt),
    email,
  }));
  for (const message of messages) {
    if (emails.some((email) => bookingMessageDuplicatesPmEmail(message, email))) continue;
    rows.push({ source: "booking" as const, timestamp: timeOf(message.receivedAt), message });
  }
  return rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

/**
 * Which alias mailboxes belong to THIS unit's email history (the panel's
 * booking-thread leg + /api/guest-inbox?buyInId=). Attribution-exact, the
 * 2026-07-20 "email history is the same for both aliases" fix:
 *
 *  - the unit's buyInId-SCOPED reservation_aliases rows always count;
 *  - `travelerEmail` counts UNLESS a sibling unit shares the same address
 *    while this unit has its own scoped alias — a legacy shared travelerEmail
 *    (the pre-unification collision) must not pour the sibling's booking
 *    thread into both panels. With no scoped alias the shared address is the
 *    only mailbox we have, so it stays (legacy behavior, better than empty);
 *  - a reservation-LEVEL alias row (buyInId null) is attributable only when
 *    the reservation has exactly ONE attached unit (same rule as
 *    aliasCandidatesForBuyIn in server/arrival-email-extract.ts).
 *
 * Order matters: the first entry is the PRIMARY alias (scoped first) — the
 * one the UI displays and replies send from.
 */
export function guestThreadAliasesForBuyIn(input: {
  buyInId: number;
  travelerEmail: string | null | undefined;
  siblings: Array<{ id: number; travelerEmail?: string | null }>;
  aliasRows: Array<{ buyInId: number | null; aliasEmail: string | null | undefined }>;
}): string[] {
  const out: string[] = [];
  const add = (value: string | null | undefined) => {
    const email = String(value ?? "").trim().toLowerCase();
    if (email && !out.includes(email)) out.push(email);
  };
  const scoped = input.aliasRows.filter((row) => row.buyInId === input.buyInId);
  for (const row of scoped) add(row.aliasEmail);
  const traveler = String(input.travelerEmail ?? "").trim().toLowerCase();
  const travelerShared = !!traveler && input.siblings.some(
    (s) => s.id !== input.buyInId && String(s.travelerEmail ?? "").trim().toLowerCase() === traveler,
  );
  if (traveler && !(travelerShared && out.length > 0)) add(traveler);
  const attachedCount = input.siblings.length;
  if (attachedCount === 1) {
    for (const row of input.aliasRows) {
      if (row.buyInId == null) add(row.aliasEmail);
    }
  }
  return out;
}

/**
 * The pre-unification collision left two units on one reservation sharing a
 * travelerEmail. An UNBOOKED unit whose address is shared with a sibling should
 * be re-minted onto its own unit alias; a BOOKED unit keeps its address (VRBO
 * already has it on the live booking). Server-side twin of the guard inside
 * ensureTravelerEmailForBuyIn.
 */
export function travelerEmailNeedsRemint(input: {
  buyInId: number;
  travelerEmail: string | null | undefined;
  bookingStatus?: string | null;
  siblings: Array<{ id: number; travelerEmail?: string | null }>;
}): boolean {
  const email = String(input.travelerEmail ?? "").trim().toLowerCase();
  if (!email) return false; // nothing minted yet — normal mint path, not a heal
  if (String(input.bookingStatus ?? "").toLowerCase() === "booked") return false;
  return input.siblings.some(
    (s) => s.id !== input.buyInId && String(s.travelerEmail ?? "").trim().toLowerCase() === email,
  );
}
