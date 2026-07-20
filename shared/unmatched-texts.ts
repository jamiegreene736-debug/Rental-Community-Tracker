// Unmatched inbound texts (operator ask 2026-07-20: third-party texts — e.g. a
// Canary Technologies verification link — sent to the Quo number match no
// Guesty conversation, so they were stored in quo_sms_messages with a null
// conversationId and rendered NOWHERE. The inbox "Texts" tab is their home).
//
// Pure helpers shared by the route (server) and the Texts tab (client). The
// data is the EXISTING quo_sms_messages mirror table filtered to
// conversation-less rows — no new tables.

import { formatPmSmsPhone, pmSmsPhoneKey } from "./pm-sms";

export type UnmatchedTextMessageInput = {
  id: number;
  direction: string;
  body: string;
  guestPhone: string;
  fromNumber?: string | null;
  toNumber?: string | null;
  guestName?: string | null;
  reservationId?: string | null;
  mediaUrls?: string | null;
  sentAt: string | Date | null;
};

export type UnmatchedTextThread = {
  /** Last-10-digit key the thread is grouped on (quo phone-matching convention). */
  phoneKey: string;
  /** "(808) 555-1234"-style label for the counterparty number. */
  displayNumber: string;
  /** Best-known label for the counterparty (guestName stamped on any row). */
  label: string | null;
  /** Reservation a row in the thread was linked to, if any. */
  reservationId: string | null;
  /** Chat order (oldest first). */
  messages: UnmatchedTextMessageInput[];
  /** ISO of the newest message either direction (thread sort key). */
  newestAt: string;
  /** ISO of the newest INBOUND message — the unread signal. */
  newestInboundAt: string | null;
  inboundCount: number;
};

function sentAtIso(value: string | Date | null | undefined): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  return "";
}

/**
 * Group conversation-less quo_sms_messages rows into per-number threads.
 * Rules (load-bearing):
 *  - The thread key is the last 10 digits of guestPhone — the webhook stores
 *    the COUNTERPARTY number there for both directions (inbound: sender;
 *    outbound: recipient), so one key = one back-and-forth.
 *  - Threads with ZERO inbound messages are dropped: outbound-only
 *    conversation-less rows are receipt/PM texts we sent that already have a
 *    home elsewhere; this tab exists for texts that would otherwise be unseen.
 *  - Newest thread first; messages within a thread oldest-first (chat order).
 */
export function groupUnmatchedTexts(rows: UnmatchedTextMessageInput[]): UnmatchedTextThread[] {
  const byKey = new Map<string, UnmatchedTextMessageInput[]>();
  for (const row of rows ?? []) {
    if (!row || typeof row.body !== "string") continue;
    const key = pmSmsPhoneKey(row.guestPhone);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  const threads: UnmatchedTextThread[] = [];
  for (const [phoneKey, list] of Array.from(byKey.entries())) {
    const messages = list
      .slice()
      .sort((a, b) => sentAtIso(a.sentAt).localeCompare(sentAtIso(b.sentAt)) || a.id - b.id);
    const inbound = messages.filter((m) => m.direction === "inbound");
    if (inbound.length === 0) continue;
    const newestAt = sentAtIso(messages[messages.length - 1]!.sentAt);
    const newestInboundAt = sentAtIso(inbound[inbound.length - 1]!.sentAt) || null;
    const labeled = messages.find((m) => String(m.guestName ?? "").trim());
    const linked = messages.find((m) => String(m.reservationId ?? "").trim());
    threads.push({
      phoneKey,
      displayNumber: formatPmSmsPhone(phoneKey),
      label: labeled ? String(labeled.guestName).trim() : null,
      reservationId: linked ? String(linked.reservationId).trim() : null,
      messages,
      newestAt,
      newestInboundAt,
      inboundCount: inbound.length,
    });
  }

  threads.sort((a, b) => b.newestAt.localeCompare(a.newestAt));
  return threads;
}

/** localStorage key for the per-thread "seen up to" map ({phoneKey: ISO}). */
export const UNMATCHED_TEXTS_SEEN_KEY = "nexstay_unmatched_texts_seen_v1";

export function parseUnmatchedSeenMap(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** True when the thread has inbound activity newer than its seen stamp. */
export function unmatchedThreadIsUnread(
  thread: Pick<UnmatchedTextThread, "phoneKey" | "newestInboundAt">,
  seen: Record<string, string>,
): boolean {
  if (!thread.newestInboundAt) return false;
  const seenAt = seen[thread.phoneKey];
  return !seenAt || thread.newestInboundAt > seenAt;
}

/** Tab-badge count: threads with unseen inbound activity. */
export function countUnreadUnmatchedThreads(
  threads: Array<Pick<UnmatchedTextThread, "phoneKey" | "newestInboundAt">>,
  seen: Record<string, string>,
): number {
  return (threads ?? []).filter((t) => unmatchedThreadIsUnread(t, seen)).length;
}
