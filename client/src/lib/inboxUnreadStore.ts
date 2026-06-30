import { useSyncExternalStore } from "react";

// Reactive, cross-component store for the inbox "unread guest conversations"
// count.
//
// The inbox page (client/src/pages/inbox.tsx) is the SINGLE SOURCE OF TRUTH —
// it already derives this count from Guesty's live conversation state PLUS the
// operator's manual right-click "Mark as read / unread" overrides, in
// `unreadConversationCount`. The problem this store solves: the global top-nav
// badge lives in a DIFFERENT component (AppHeader) that has no access to the
// inbox page's state, so marking a row read/unread never moved it.
//
// Now the inbox page publishes its count here whenever it changes, and
// AppHeader subscribes — so the header badge updates the instant the operator
// marks a row read/unread, even though they're separate components.
//
// The value is intentionally kept in MODULE MEMORY only (not localStorage):
// the underlying read/unread overrides ARE persisted (see inbox.tsx
// `inboxReadOverrides`), so when the inbox page mounts it recomputes the true
// count and republishes — persisting the derived count too would only risk
// showing a stale number on a fresh load before the inbox has been opened.
// `null` means "the inbox page hasn't published a count yet this session", which
// lets AppHeader fall back to its own independent signal until then.

let currentCount: number | null = null;
const listeners = new Set<() => void>();

export function setInboxUnreadCount(count: number): void {
  const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (next === currentCount) return;
  currentCount = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number | null {
  return currentCount;
}

// Server snapshot: SSR has no published count.
function getServerSnapshot(): number | null {
  return null;
}

/**
 * Subscribe to the inbox unread-conversation count. Returns `null` until the
 * inbox page has published a count this session, then the live count (updates
 * the moment the operator marks a row read/unread).
 */
export function useInboxUnreadCount(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
