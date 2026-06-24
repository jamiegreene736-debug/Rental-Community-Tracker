// Pure host/guest/system classification of Guesty conversation posts. Shared so
// the auto-reply scheduler (server/auto-reply.ts) routes through ONE tested
// implementation instead of inline copies.
//
// LOAD-BEARING: the 2026-05-04 production outage was exactly this logic returning
// null for every thread when Guesty switched to the inbox-v2 `sentBy` shape —
// auto-reply silently skipped real guest messages across every channel for ~2
// weeks with no failing test. These are the highest-blast-radius two-way-sync
// helpers, so they are unit-tested (tests/guesty-post-classify.test.ts). Keep the
// legacy `isIncoming` / `direction` / `authorType` / `senderType` checks for older
// fixtures and any non-Guesty inbox source; `sentBy` is the authoritative signal
// for the CURRENT Guesty inbox-v2 shape.

export function isIncomingPost(p: any): boolean {
  if (p.sentBy === "guest") return true;
  if (p.isIncoming === true) return true;
  if (p.direction === "incoming" || p.direction === "in" || p.direction === "inbound") return true;
  if (p.authorType && p.authorType.toLowerCase() === "guest") return true;
  if (p.senderType && p.senderType.toLowerCase() === "guest") return true;
  return false;
}

export function isSystemPost(p: any): boolean {
  // Inbox-v2 marks the auto-generated "New guest inquiry" log entry with
  // `sentBy: "log"` (and also `module.type: "log"`). The body patterns catch older
  // fixtures and any future system post without the explicit log markers.
  if (p.sentBy === "log") return true;
  const moduleType = String(p.module?.type ?? p.type ?? "").toLowerCase();
  if (moduleType === "log" || moduleType === "system" || moduleType === "internal" || moduleType === "note") return true;
  const body = String(p.body ?? p.text ?? p.message ?? "").trim().toLowerCase();
  return (
    body === "new guest inquiry" ||
    body === "new inquiry" ||
    body === "new reservation request" ||
    body.startsWith("new guest reservation")
  );
}

export function isHostPost(p: any): boolean {
  if (p.sentBy === "host") return true;
  if (p.isIncoming === false) return true;
  if (p.direction === "outgoing" || p.direction === "out" || p.direction === "outbound") return true;
  if (p.authorType && p.authorType.toLowerCase() === "host") return true;
  if (p.authorRole && p.authorRole.toLowerCase() === "host") return true;
  if (p.senderType && p.senderType.toLowerCase() === "host") return true;
  return false;
}

export function postTimestampMs(p: any): number {
  const v = p?.createdAt ?? p?.sentAt ?? p?.postedAt;
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

// Decide whether this conversation has a guest message awaiting a host response —
// and if so, which post is the trigger. Returns null when:
//   - there are no incoming posts (host-initiated thread), or
//   - the host has already replied AFTER the guest's latest message (a manual
//     reply via the inbox UI or Guesty itself).
//
// Without the host-replied-after check, a pure "is there an incoming post?" filter
// would re-trigger after a manual host reply and produce a duplicate auto-reply on
// the next guest message.
export function pickPostToReplyTo<T extends { _id?: unknown }>(posts: T[] | undefined): T | null {
  if (!posts || posts.length === 0) return null;
  const conversational = posts.filter((p) => !isSystemPost(p));

  const incoming = conversational.filter(isIncomingPost);
  if (incoming.length === 0) return null;
  incoming.sort((a, b) => postTimestampMs(b) - postTimestampMs(a));
  const latestIncoming = incoming[0];
  if (!latestIncoming?._id) return null;

  const host = conversational.filter(isHostPost);
  if (host.length === 0) return latestIncoming;
  host.sort((a, b) => postTimestampMs(b) - postTimestampMs(a));
  const latestHost = host[0];

  // Host's last message is more recent than the guest's last — already handled.
  if (postTimestampMs(latestHost) > postTimestampMs(latestIncoming)) return null;

  return latestIncoming;
}
