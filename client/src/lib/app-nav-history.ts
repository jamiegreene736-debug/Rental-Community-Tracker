// Per-tab in-app navigation depth tracker backing the shared AppBackButton.
//
// "Back" on a page header must mean the browser's PREVIOUS PAGE, but only
// while that previous page is still inside this app — a deep link opened in
// a new tab (or arriving from an external site) has no in-app history, and
// history.back() there would either do nothing or dump the operator out of
// the portal. So we count in-app pushState navigations per tab (sessionStorage
// keeps the count across reloads of the SAME tab; a new tab starts at 0) and
// AppBackButton falls back to navigating home when the count is zero.
//
// pushState is patched exactly once per page load (wouter navigations all go
// through it); popstate (browser back/forward) decrements. Forward-button
// re-entry also fires popstate and decrements one step too far — acceptable:
// the only consequence is an early fallback to the dashboard, never a broken
// or external navigation.

const STORAGE_KEY = "vre_app_nav_depth_v1";

function readDepth(): number {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function writeDepth(depth: number): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, String(depth));
  } catch {
    // sessionStorage unavailable — tracking degrades to in-memory only.
  }
}

let depth = 0;
let installed = false;

export function installAppNavHistoryTracker(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  depth = readDepth();
  const originalPushState = window.history.pushState.bind(window.history);
  window.history.pushState = function pushStateTracked(
    ...args: Parameters<History["pushState"]>
  ) {
    depth += 1;
    writeDepth(depth);
    return originalPushState(...args);
  };
  window.addEventListener("popstate", () => {
    depth = Math.max(0, depth - 1);
    writeDepth(depth);
  });
}

/** True when the previous browser-history entry is a page inside this app. */
export function canGoBackInApp(): boolean {
  return depth > 0;
}
