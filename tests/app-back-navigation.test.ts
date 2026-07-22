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

  // Minimal window stub the tracker touches: history.pushState/replaceState,
  // popstate listener registration, sessionStorage. pushedStates captures what
  // the tracker actually hands the browser so the per-entry stamp is provable.
  const store = new Map<string, string>();
  let popstateHandler: ((event: { state: unknown }) => void) | null = null;
  let pushCalls = 0;
  const pushedStates: unknown[] = [];
  (globalThis as any).window = {
    location: { pathname: "/bookings" },
    history: {
      state: null,
      pushState: (state: unknown, _title: unknown, url?: unknown) => {
        pushCalls++;
        pushedStates.push(state);
        if (typeof url === "string") (globalThis as any).window.location.pathname = url.split("?")[0];
      },
      replaceState: (_state: unknown, ..._rest: unknown[]) => {},
    },
    addEventListener: (event: string, handler: (e: { state: unknown }) => void) => {
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
  check("the entry carries its own depth stamp",
    (pushedStates[0] as any)?.__vreNavIdx === 1);

  popstateHandler?.({ state: null });
  check("browser back (popstate to the unstamped first entry) consumes the depth", !nav.canGoBackInApp());

  // THE 2026-07-21 BUG: browser FORWARD also fires popstate, and the old
  // counter decremented on it too — a back+forward pair (iPhone swipe
  // gestures) drained the depth and the Back button fell to the dashboard
  // with a valid in-app entry right behind it. The per-entry stamp restores
  // the exact depth on forward re-entry.
  popstateHandler?.({ state: pushedStates[0] });
  check("browser FORWARD back onto a stamped entry RESTORES the depth (the dashboard-fallback bug)",
    nav.canGoBackInApp());

  popstateHandler?.({ state: null });
  popstateHandler?.({ state: null });
  check("extra popstate never goes negative", !nav.canGoBackInApp());

  (globalThis as any).window.history.pushState(null, "", "/inbox");
  (globalThis as any).window.history.pushState(null, "", "/bookings");
  check("depth persists to sessionStorage for same-tab reloads",
    Number(store.get("vre_app_nav_depth_v1")) === 2);
  check("nested navigations stamp increasing depths",
    (pushedStates[1] as any)?.__vreNavIdx === 1 && (pushedStates[2] as any)?.__vreNavIdx === 2);

  // ── Back skips pass-through dashboard hops (2026-07-22 operator: "back
  // needs to go to the page with all the reservations, not the dashboard") ──
  // Current state from above: trail 0:/bookings, 1:/inbox, 2:/bookings, depth 2.
  check("plain back is one step when the previous page is a work page",
    JSON.stringify(nav.backNavigationPlan()) === JSON.stringify({ kind: "steps", delta: 1 }));

  // /bookings → / (dashboard hub) → /builder/89: Back must SKIP the dashboard
  // and land on All Reservations in one click.
  popstateHandler?.({ state: pushedStates[2] }); // back on /bookings, depth 2… reset walk
  (globalThis as any).window.history.pushState(null, "", "/");
  (globalThis as any).window.history.pushState(null, "", "/builder/89");
  const skipPlan = nav.backNavigationPlan();
  check("back from the builder SKIPS the dashboard hop and lands on /bookings",
    skipPlan.kind === "steps" && (skipPlan as any).delta === 2);

  // dashboard-only history stays honest: / → /inbox → Back is one step (the
  // dashboard IS the only previous page; skipping would exit the app).
  const store2 = store; store2.clear();
  (globalThis as any).window.location.pathname = "/";
  // simulate a fresh tab landing on the dashboard: reinstall not possible
  // (installed once) — emulate by walking history back to depth 0 with an
  // unstamped entry, then pushing /inbox from "/".
  popstateHandler?.({ state: null });
  (globalThis as any).window.history.pushState(null, "", "/inbox");
  const dashPlan = nav.backNavigationPlan();
  check("back from a page entered FROM the dashboard is a single honest step",
    dashPlan.kind === "steps" && (dashPlan as any).delta === 1);

  check("no in-app history → fallback plan", (() => {
    popstateHandler?.({ state: null });
    return nav.backNavigationPlan().kind === "fallback";
  })());

  console.log("source guards: warning popups navigate in-tab");
  const homeSrc = readFileSync("client/src/pages/home.tsx", "utf8");
  check("dashboard popup actions no longer open in-app pages in NEW TABS (no history = Back falls to dashboard)",
    !/window\.open\((`\/inbox|"\/bookings)/.test(homeSrc) && homeSrc.includes("navigateInApp("));

  console.log("source guards: shared back button + page wiring");

  const backButtonSrc = readFileSync("client/src/components/AppBackButton.tsx", "utf8");
  check("AppBackButton navigates via the dashboard-skipping plan",
    backButtonSrc.includes("backNavigationPlan()") && backButtonSrc.includes("window.history.go(-plan.delta)"));
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
