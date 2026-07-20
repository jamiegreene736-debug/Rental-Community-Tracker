// App back-navigation — locks the 2026-07-20 navigation redesign:
//   - Page headers no longer have a "Dashboard" back link; they render the ONE
//     shared AppBackButton, which goes to the browser's PREVIOUS page when the
//     previous history entry is inside the app, and falls back to "/" on deep
//     links / fresh tabs (so Back never exits the portal or does nothing).
//   - Home/dashboard navigation is the header LOGO's job (link-brand-home).
// Behavioral half exercises the per-tab nav-depth tracker against a stubbed
// window; source guards keep the wiring from silently reverting.
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

async function run() {
  console.log("app-nav-history: behavioral (stubbed window)");

  // Minimal window stub the tracker touches: history.pushState, popstate
  // listener registration, sessionStorage.
  const store = new Map<string, string>();
  let popstateHandler: (() => void) | null = null;
  let pushCalls = 0;
  (globalThis as any).window = {
    history: {
      pushState: (..._args: unknown[]) => { pushCalls++; },
    },
    addEventListener: (event: string, handler: () => void) => {
      if (event === "popstate") popstateHandler = handler;
    },
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
    },
  };

  const nav = await import("../client/src/lib/app-nav-history");

  check("before install, canGoBackInApp is false", !nav.canGoBackInApp());

  nav.installAppNavHistoryTracker();
  check("fresh tab starts with no in-app history", !nav.canGoBackInApp());

  (globalThis as any).window.history.pushState(null, "", "/bookings");
  check("a pushState navigation makes back-in-app available", nav.canGoBackInApp());
  check("the original pushState still ran (navigation not swallowed)", pushCalls === 1);

  popstateHandler?.();
  check("browser back (popstate) consumes the depth", !nav.canGoBackInApp());

  popstateHandler?.();
  check("extra popstate never goes negative", !nav.canGoBackInApp());

  (globalThis as any).window.history.pushState(null, "", "/inbox");
  (globalThis as any).window.history.pushState(null, "", "/bookings");
  check("depth persists to sessionStorage for same-tab reloads",
    Number(store.get("vre_app_nav_depth_v1")) === 2);

  console.log("source guards: shared back button + page wiring");

  const backButtonSrc = readFileSync("client/src/components/AppBackButton.tsx", "utf8");
  check("AppBackButton uses history.back only when the previous entry is in-app",
    backButtonSrc.includes("canGoBackInApp()") && backButtonSrc.includes("window.history.back()"));
  check("AppBackButton falls back to navigating to the dashboard",
    backButtonSrc.includes('fallbackHref = "/"') && backButtonSrc.includes("navigate(fallbackHref)"));

  const mainSrc = readFileSync("client/src/main.tsx", "utf8");
  check("tracker installs at boot in main.tsx (before the first navigation)",
    mainSrc.includes("installAppNavHistoryTracker()"));

  // Every page that used to render its own "← Dashboard" link now renders the
  // shared button instead. Adding a new page header? Use AppBackButton, not a
  // bespoke Link-to-"/".
  const backButtonPages = [
    "client/src/pages/bookings.tsx",
    "client/src/pages/inbox.tsx",
    "client/src/pages/availability-scanner.tsx",
    "client/src/pages/add-single-listing.tsx",
    "client/src/pages/add-community.tsx",
    "client/src/pages/buy-in-tracker.tsx",
    "client/src/pages/community-photo-finder.tsx",
    "client/src/pages/photo-audit.tsx",
    "client/src/pages/unit-builder.tsx",
    "client/src/pages/builder.tsx",
    "client/src/pages/builder-preflight.tsx",
  ];
  for (const page of backButtonPages) {
    const src = readFileSync(page, "utf8");
    check(`${page} renders AppBackButton`, src.includes("<AppBackButton"));
    check(`${page} has no "Back to Dashboard" copy left`, !src.includes("Back to Dashboard"));
  }

  const headerSrc = readFileSync("client/src/components/AppHeader.tsx", "utf8");
  check("header logo is the dashboard/home control (link-brand-home → \"/\")",
    headerSrc.includes('data-testid="link-brand-home"') && headerSrc.includes('aria-label="Go to Dashboard"'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
