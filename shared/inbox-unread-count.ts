// Header "unread guest messages" badge logic.
//
// The inbox page's unreadConversationCount (inbox.tsx) is the single source
// of truth once that page has mounted — it publishes via inboxUnreadStore.
// But BEFORE the first inbox visit of a session, the header used to fall
// back to the pending-AI-draft count, which is a different signal entirely
// (and it also summed missed calls into the number) — so the badge routinely
// did not match the actual unread messages. These pure helpers let AppHeader
// derive the REAL unread-conversation count independently from the same
// Guesty conversations list the inbox uses, honoring the operator's persisted
// right-click "Mark as read / unread" overrides.
//
// Semantics mirror inbox.tsx exactly for the signals available on the list
// endpoint (which the header fetches with the load-bearing `&fields=` so
// `state` is expanded — see the inbox conversations query):
//   - a conversation "awaits reply" when the last real message came from the
//     guest — `state.isLastPostFromGuest` when Guesty provides it (all
//     current production rows), else the legacy NEW/UNREAD/UNANSWERED
//     state strings.
//   - a manual override wins UNLESS a newer guest message arrived after the
//     mark (a stale "read" re-surfaces; live state already covers "unread").
// The inbox page's count additionally folds session-only reply suppression
// (locallyRepliedAtByConversation) — that state doesn't exist before the
// inbox mounts, and the published count takes precedence the moment it does.

export const INBOX_READ_OVERRIDE_STORAGE_KEY = "nexstay_inbox_read_overrides_v1";

export type InboxReadOverride = { state: "read" | "unread"; at: number };

// Parse the persisted right-click overrides (localStorage JSON). Pure so both
// the inbox page and the header validate identically.
export function parseStoredInboxReadOverrides(raw: string | null | undefined): Record<string, InboxReadOverride> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, InboxReadOverride> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, any>)) {
      if (!id || typeof id !== "string") continue;
      if (
        value &&
        (value.state === "read" || value.state === "unread") &&
        typeof value.at === "number"
      ) {
        out[id] = { state: value.state, at: value.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Find the conversations array inside Guesty's wrapped list response:
//   { status, data: { count, conversations: [...] } } — or the older
//   { results: [...] } / { data: [...] } / bare-array shapes.
export function extractConversationList(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  const walk = (node: any, depth: number): any[] | null => {
    if (!node || typeof node !== "object" || depth > 4) return null;
    for (const key of ["conversations", "results", "data"]) {
      const v = node[key];
      if (Array.isArray(v)) return v;
    }
    return walk(node.data, depth + 1);
  };
  return walk(data, 0) ?? [];
}

// Latest-activity timestamp, using the same resolution order the inbox row
// display uses: the expanded state.lastMessage.date first, then the list-level
// fallbacks. 0 when nothing parses.
export function conversationLastActivityMs(c: any): number {
  const stateObj = c?.state && typeof c.state === "object" ? c.state : null;
  const candidates = [stateObj?.lastMessage?.date, c?.lastMessageAt, c?.updatedAt, c?.createdAt];
  for (const v of candidates) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

// Does the latest real message come from the guest (host reply still owed)?
export function conversationAwaitsReply(c: any): boolean {
  const stateObj = c?.state && typeof c.state === "object" ? c.state : null;
  if (typeof stateObj?.isLastPostFromGuest === "boolean") return stateObj.isLastPostFromGuest;
  const legacy = typeof c?.state === "string" ? c.state : "";
  return legacy === "NEW" || legacy === "UNREAD" || legacy === "UNANSWERED";
}

// The override-aware unread count. Mirrors inbox.tsx applyLocalReplyOverride:
// an override applies unless a NEWER guest message arrived after it was set.
export function countUnreadConversations(
  conversations: any[],
  overrides: Record<string, InboxReadOverride>,
): number {
  let count = 0;
  for (const c of conversations) {
    const id = String(c?._id ?? c?.id ?? "");
    const override = id ? overrides[id] : undefined;
    if (override) {
      const activityMs = conversationLastActivityMs(c);
      const supersededByNewActivity = activityMs > override.at;
      if (!supersededByNewActivity) {
        if (override.state === "unread") count += 1;
        continue;
      }
    }
    if (conversationAwaitsReply(c)) count += 1;
  }
  return count;
}
