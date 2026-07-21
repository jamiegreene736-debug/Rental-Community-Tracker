// Per-tab in-app navigation tracker backing the shared AppBackButton.
//
// "Back" on a page header must mean the browser's PREVIOUS PAGE, but only
// while that previous page is still inside this app — a deep link opened in
// a new tab (or arriving from an external site) has no in-app history, and
// history.back() there would either do nothing or dump the operator out of
// the portal.
//
// HOW (2026-07-21 rewrite — operator: "back just takes me to the dashboard,
// not the previous page"): the old implementation was a bare COUNTER
// (pushState +1, popstate −1). Browser FORWARD also fires popstate, so every
// back+forward pair (swipe gestures on the iPhone) drained the counter one
// step too far and the button fell back to the dashboard while a perfectly
// good in-app history entry sat behind it. Now each pushState STAMPS its
// in-app depth INTO the history entry's own state (history.state.__vreNavIdx),
// so back/forward re-entry reads the exact depth off the entry it lands on —
// the counter can never drift, no matter how the operator mixes app-Back,
// browser-back, and forward. Entries without a stamp (the tab's first page,
// external entries) read as depth 0 = "previous page is not this app".
//
// pushState/replaceState are patched exactly once per page load (wouter
// navigations all go through pushState; replaceState keeps its entry's
// existing depth). sessionStorage carries the current depth across RELOADS of
// the same tab only as a fallback for entries created before the stamp
// existed; the stamp on history.state wins when present.

const STORAGE_KEY = "vre_app_nav_depth_v1";
const STATE_KEY = "__vreNavIdx";

function readStoredDepth(): number {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function writeStoredDepth(depth: number): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, String(depth));
  } catch {
    // sessionStorage unavailable — tracking degrades to in-memory only.
  }
}

function stampedDepth(state: unknown): number | null {
  const n = state && typeof state === "object" ? (state as Record<string, unknown>)[STATE_KEY] : null;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function withStamp(state: unknown, depth: number): unknown {
  if (state == null) return { [STATE_KEY]: depth };
  if (typeof state === "object" && !Array.isArray(state)) {
    return { ...(state as Record<string, unknown>), [STATE_KEY]: depth };
  }
  // Non-object state (string/number) — leave it untouched rather than break a
  // caller's contract; that entry just reads as depth 0 on re-entry.
  return state;
}

let depth = 0;
let installed = false;

export function installAppNavHistoryTracker(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // The stamp on the CURRENT entry (survives reloads exactly) wins over the
  // sessionStorage fallback.
  depth = stampedDepth(window.history.state) ?? readStoredDepth();

  const originalPushState = window.history.pushState.bind(window.history);
  window.history.pushState = function pushStateTracked(
    ...args: Parameters<History["pushState"]>
  ) {
    depth += 1;
    writeStoredDepth(depth);
    args[0] = withStamp(args[0], depth);
    return originalPushState(...args);
  };

  const originalReplaceState = window.history.replaceState.bind(window.history);
  window.history.replaceState = function replaceStateTracked(
    ...args: Parameters<History["replaceState"]>
  ) {
    // Same entry, same depth — a replace must never change how far back the
    // operator can go.
    args[0] = withStamp(args[0], depth);
    return originalReplaceState(...args);
  };

  window.addEventListener("popstate", (event: PopStateEvent) => {
    // Back OR forward: read the exact depth off the entry we landed on.
    depth = stampedDepth(event.state) ?? 0;
    writeStoredDepth(depth);
  });
}

/** True when the previous browser-history entry is a page inside this app. */
export function canGoBackInApp(): boolean {
  return depth > 0;
}
