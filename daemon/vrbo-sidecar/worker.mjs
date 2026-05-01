// VRBO sidecar worker — drives real Chrome via CDP.
//
// v3 (2026-04-29): generalized to dispatch on op type. Each request
// from the queue carries `opType` ∈ { vrbo_search, vrbo_photo_scrape,
// booking_search, google_serp, pm_url_check } plus a `params` blob; this worker
// dispatches to the right scrape function based on opType. Each
// processor reuses the same Chrome instance — same dedicated
// user-data-dir, same cookies, same accumulated trust.
//
// Architecture:
//   - Spawns the user's Google Chrome.app with
//     --remote-debugging-port=9222 + a dedicated user-data-dir.
//   - Connects via Playwright's chromium.connectOverCDP.
//   - Polls Railway every ~10s when idle; dispatches by opType; posts results.
//   - Heartbeats happen automatically — every /next call stamps the
//     server's lastWorkerPollAt for the UI's "Local sidecar online"
//     badge.

import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = path.join(__dirname, "cookies.json");
const CHROME_DATA_DIR = path.join(
  os.homedir(),
  "Library/Application Support/VrboSidecar-Chrome",
);
const CHROME_BINARY = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9222;
const SIDE_CAR_CHROME_VISIBLE = process.env.SIDECAR_CHROME_VISIBLE === "1";
const HIDDEN_WINDOW_POSITION = "-32000,-32000";

const SERVER = process.env.SIDECAR_SERVER ?? "https://rental-community-tracker-production.up.railway.app";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";

const POLL_IDLE_MS = Number(process.env.SIDECAR_POLL_IDLE_MS ?? 10_000);
const POLL_BUSY_MS = Number(process.env.SIDECAR_POLL_BUSY_MS ?? 2_000);
const PAGE_NAV_TIMEOUT_MS = 35_000;
const PAGE_SETTLE_MS = Number(process.env.SIDECAR_PAGE_SETTLE_MS ?? 3_000);
const PM_PARTIAL_DATE_RETRY_MS = Number(process.env.SIDECAR_PM_PARTIAL_DATE_RETRY_MS ?? 1_500);
const PM_POST_DATE_SETTLE_MS = Number(process.env.SIDECAR_PM_POST_DATE_SETTLE_MS ?? 2_500);
const PER_REQUEST_BUDGET_MS = 90_000;
const VIEWPORT = { width: 1280, height: 820 };
const BLOCKED_NAV_HOST_RE = /(^|\.)((facebook|instagram|threads|pinterest)\.com|facebook\.net|fbcdn\.net|x\.com|twitter\.com|t\.co)$/i;

let browser = null;
let context = null;
let page = null;
let contextGuardsInstalled = false;

function log(msg, ...rest) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [vrbo-sidecar]`, msg, ...rest);
}

function withSoftTimeout(promise, timeoutMs, fallback = undefined) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

function hostFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function shouldBlockNavigation(rawUrl) {
  const host = hostFromUrl(rawUrl);
  return Boolean(host && BLOCKED_NAV_HOST_RE.test(host));
}

async function installContextGuards() {
  if (!context || contextGuardsInstalled) return;
  contextGuardsInstalled = true;

  await context.route("**/*", async (route) => {
    const rawUrl = route.request().url();
    if (shouldBlockNavigation(rawUrl)) {
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  }).catch((e) => {
    log(`context route guard failed: ${e?.message ?? e}`);
  });

  context.on("page", (createdPage) => {
    void (async () => {
      await createdPage.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
      const rawUrl = createdPage.url?.() ?? "";
      if (shouldBlockNavigation(rawUrl)) {
        log(`closed blocked popup/tab: ${rawUrl.slice(0, 140)}`);
        await createdPage.close({ runBeforeUnload: false }).catch(() => {});
      }
    })();
  });
}

async function closeExtraTabs(reason, keepPage = page) {
  if (!context) return 0;
  const pages = context.pages().filter((p) => p && !p.isClosed?.());
  let closedCount = 0;
  for (const candidate of pages) {
    if (candidate === keepPage) continue;
    try {
      const closed = await withSoftTimeout(
        candidate.close({ runBeforeUnload: false }).then(() => true),
        1_500,
        false,
      );
      if (closed) closedCount++;
    } catch {
      // Racy by nature: Chrome may already have closed the tab.
    }
  }
  if (closedCount > 0) log(`${reason}: closed ${closedCount} extra tab(s)`);
  return closedCount;
}

async function dismissObstructions(targetPage = page, label = "page") {
  if (!targetPage || targetPage.isClosed?.()) return [];
  const actions = [];
  for (let pass = 0; pass < 4; pass++) {
    const action = await withSoftTimeout(
      targetPage.evaluate(() => {
        const CONTROL_SELECTOR = "button, a, [role='button'], input[type='button'], input[type='submit'], [aria-label], [title]";
        const ROOT_SELECTOR = [
          "[role='dialog']",
          "[aria-modal='true']",
          "[class*='modal' i]",
          "[id*='modal' i]",
          "[class*='popup' i]",
          "[id*='popup' i]",
          "[class*='overlay' i]",
          "[id*='overlay' i]",
          "[class*='newsletter' i]",
          "[id*='newsletter' i]",
          "[class*='cookie' i]",
          "[id*='cookie' i]",
          "[class*='consent' i]",
          "[id*='consent' i]",
          "#onetrust-banner-sdk",
          ".cc-window",
        ].join(",");
        const closeRe = /(?:^|\b)(?:close|dismiss|no thanks|not now|skip|maybe later|continue without|×|x)(?:\b|$)/i;
        const strictCloseRe = /^(?:×|x|close|dismiss)$/i;
        const cookieRe = /\b(?:accept all|accept cookies|allow all|i agree|agree|reject all|decline|got it|ok)\b/i;
        const globalCookieRe = /\b(?:accept all|accept cookies|allow all|i agree|reject all|decline)\b/i;

        function isVisible(el) {
          if (!el || !(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) return false;
          if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
        }

        function labelOf(el) {
          return [
            el.textContent,
            el.getAttribute?.("aria-label"),
            el.getAttribute?.("title"),
            el.getAttribute?.("value"),
          ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        }

        function isDisabled(el) {
          return Boolean(el.disabled) || el.getAttribute?.("aria-disabled") === "true";
        }

        function isDismissLabel(label) {
          const compact = String(label || "").trim();
          if (!compact) return false;
          // Accessibility skip links are often visible/focusable near the top
          // of PM pages. They are not overlays and clicking them can move the
          // page away from the booking widget during rate checks.
          if (/^skip\s+to\s+main\s+content$/i.test(compact)) return false;
          if (strictCloseRe.test(compact)) return true;
          return compact.length <= 90 && closeRe.test(compact);
        }

        function clickCandidate(el, kind) {
          const rect = el.getBoundingClientRect();
          const label = labelOf(el).slice(0, 80) || el.tagName.toLowerCase();
          el.scrollIntoView?.({ block: "center", inline: "center" });
          el.click();
          return {
            clicked: true,
            kind,
            label,
            tag: el.tagName.toLowerCase(),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
        }

        const roots = Array.from(document.querySelectorAll(ROOT_SELECTOR))
          .filter(isVisible)
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
          });

        for (const root of roots) {
          const rootText = [
            root.id,
            root.className,
            root.getAttribute?.("aria-label"),
            root.textContent,
          ].filter(Boolean).join(" ").slice(0, 2000);
          const looksCookie = /cookie|consent|privacy|gdpr|onetrust/i.test(rootText);
          const controls = Array.from(root.querySelectorAll(CONTROL_SELECTOR))
            .filter((el) => isVisible(el) && !isDisabled(el));
          const target = controls.find((el) => {
            const label = labelOf(el);
            if (!label) return false;
            if (looksCookie && cookieRe.test(label)) return true;
            return isDismissLabel(label);
          });
          if (target) {
            const targetLabel = labelOf(target);
            const kind = looksCookie && cookieRe.test(targetLabel) ? "cookie-or-consent" : "modal-or-popup";
            return clickCandidate(target, kind);
          }
        }

        const controls = Array.from(document.querySelectorAll(CONTROL_SELECTOR))
          .filter((el) => isVisible(el) && !isDisabled(el));
        const cookieTarget = controls.find((el) => globalCookieRe.test(labelOf(el)));
        if (cookieTarget) return clickCandidate(cookieTarget, "cookie-or-consent");

        const closeTarget = controls.find((el) => {
          const label = labelOf(el);
          if (!isDismissLabel(label)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width <= 96 && rect.height <= 96;
        });
        if (closeTarget) return clickCandidate(closeTarget, "global-close");

        return null;
      }),
      2_500,
      null,
    );
    if (!action?.clicked) break;
    actions.push(action);
    await targetPage.waitForTimeout(400).catch(() => {});
  }

  const stillBlocked = await withSoftTimeout(
    targetPage.evaluate(() => {
      const roots = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true'], [class*='modal' i], [class*='popup' i], [class*='overlay' i]"));
      return roots.some((el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      });
    }),
    1_000,
    false,
  );
  if (stillBlocked) {
    await targetPage.keyboard.press("Escape").catch(() => {});
    actions.push({ clicked: true, kind: "escape", label: "Escape" });
    await targetPage.waitForTimeout(400).catch(() => {});
  }

  if (actions.length > 0) {
    log(`${label}: dismissed obstruction(s): ${actions.map((a) => `${a.kind}:${a.label}`).join("; ")}`);
  }
  return actions;
}

function withPagePrepReason(result, dismissals, dateEntry) {
  if (!result) return result;
  const parts = [];
  if (Array.isArray(dismissals) && dismissals.length > 0) {
    const detail = dismissals
      .slice(0, 4)
      .map((a) => `${a.kind}:${a.label}`)
      .join(", ");
    parts.push(`dismissed obstruction(s): ${detail}`);
  }
  const filledCount = dateEntry?.filled?.length ?? 0;
  if (filledCount > 0 || dateEntry?.openedLabel || dateEntry?.submitLabel) {
    parts.push(
      `entered dates (${filledCount} field${filledCount === 1 ? "" : "s"}` +
      `${dateEntry?.openedLabel ? `, opened "${dateEntry.openedLabel}"` : ""}` +
      `${dateEntry?.submitLabel ? `, clicked "${dateEntry.submitLabel}"` : ""})`,
    );
  }
  if (parts.length === 0) return result;
  const base = result.reason || "Parsed page";
  return {
    ...result,
    reason: `${base}; ${parts.join("; ")}`.slice(0, 800),
  };
}

function pmDateEntryComplete(dateEntry) {
  return Boolean(
    dateEntry?.filled?.some((f) => f.role === "range") ||
    (dateEntry?.filled?.some((f) => f.role === "checkin") && dateEntry?.filled?.some((f) => f.role === "checkout")),
  );
}

function attachDetectedBedrooms(result, bedrooms) {
  if (!result) return result;
  if (typeof result.bedrooms === "number" && Number.isFinite(result.bedrooms)) return result;
  return {
    ...result,
    bedrooms: typeof bedrooms === "number" && Number.isFinite(bedrooms) ? bedrooms : null,
  };
}

async function detectPmPageBedrooms(targetPage) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  return withSoftTimeout(
    targetPage.evaluate(() => {
      function clean(raw) {
        return String(raw || "").replace(/\s+/g, " ").trim();
      }
      function extractBedroomCount(raw) {
        const text = clean(raw).toLowerCase();
        if (!text) return null;
        if (/\bstudio\b|\befficiency\b/.test(text)) return 0;
        const direct = text.match(/\b([1-9])\s*(?:br|bd|bdr|bedrooms?|bed\s*rooms?)\b/);
        if (direct) return parseInt(direct[1], 10);
        const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
        for (const [word, count] of Object.entries(words)) {
          if (new RegExp(`\\b${word}[\\s-]*(?:bedroom|bedrooms|bed\\s*rooms?)\\b`).test(text)) return count;
        }
        return null;
      }
      const selectorGroups = [
        "h1, [data-testid*='title' i], [class*='title' i]",
        "[data-testid*='bedroom' i], [class*='bedroom' i], [class*='property-info' i], [class*='property-details' i], [class*='unit-details' i], [class*='amenit' i]",
        "meta[name='description'], meta[property='og:description']",
      ];
      for (const selectors of selectorGroups) {
        const parts = Array.from(document.querySelectorAll(selectors))
          .slice(0, 12)
          .map((el) => el instanceof HTMLMetaElement ? el.content : el.textContent)
          .map(clean)
          .filter(Boolean);
        const found = extractBedroomCount(parts.join(" | "));
        if (found !== null) return found;
      }
      return extractBedroomCount(`${document.title || ""} ${(document.body?.innerText || "").slice(0, 3000)}`);
    }),
    2_000,
    null,
  ).catch(() => null);
}

function authHeaders() {
  return ADMIN_SECRET ? { "X-Admin-Secret": ADMIN_SECRET } : {};
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_FILE)) {
    throw new Error(
      `cookies.json not found at ${COOKIES_FILE}. Export Cookie-Editor JSON from your real browser on vrbo.com (and ideally booking.com too) and save it here.`,
    );
  }
  const raw = fs.readFileSync(COOKIES_FILE, "utf8").trim();
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("cookies.json is empty or not a JSON array.");
  }
  const sameSiteMap = { strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None" };
  return arr
    .filter((c) => c?.name && c?.value && c?.domain)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
      path: c.path ?? "/",
      expires:
        typeof c.expirationDate === "number"
          ? Math.floor(c.expirationDate)
          : typeof c.expires === "number"
          ? Math.floor(c.expires)
          : -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax",
    }));
}

async function addCookiesBestEffort(cookies, label) {
  if (!cookies?.length || !context) return false;
  try {
    await context.addCookies(cookies);
    return true;
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/Browser context management is not supported|Storage\.setCookies|Target page, context or browser has been closed/i.test(msg)) {
      log(`${label}: cookie injection unavailable over CDP; continuing with Chrome profile cookies`);
      return false;
    }
    throw e;
  }
}

async function isCdpReady() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureChromeRunning() {
  if (await isCdpReady()) return;
  if (!fs.existsSync(CHROME_BINARY)) {
    throw new Error(`Google Chrome not found at ${CHROME_BINARY}`);
  }
  fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height + 80}`,
    `--window-position=${SIDE_CAR_CHROME_VISIBLE ? "120,80" : HIDDEN_WINDOW_POSITION}`,
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  const launchHiddenOnMac = process.platform === "darwin" && !SIDE_CAR_CHROME_VISIBLE;
  const command = launchHiddenOnMac ? "/usr/bin/open" : CHROME_BINARY;
  const args = launchHiddenOnMac
    ? ["-g", "-j", "-n", "-a", "Google Chrome", "--args", ...chromeArgs]
    : chromeArgs;
  log(
    `spawning Chrome ${launchHiddenOnMac ? "hidden/offscreen " : ""}(port ${CDP_PORT}, user-data-dir ${CHROME_DATA_DIR})…`,
  );
  const proc = spawn(
    command,
    args,
    { detached: true, stdio: "ignore" },
  );
  proc.unref();
  for (let i = 0; i < 40; i++) {
    if (await isCdpReady()) {
      log("Chrome CDP ready");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Chrome spawned but CDP did not become ready within 20s");
}

async function normalizePageDisplay(targetPage = page) {
  if (!targetPage || targetPage.isClosed?.()) return;
  await withSoftTimeout(targetPage.setViewportSize(VIEWPORT), 1_500);
  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (session) {
    await withSoftTimeout(session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 }), 1_500);
    await withSoftTimeout(session.detach(), 500);
  }
  // Chrome profile zoom can persist per-origin. Reset the visible tab
  // so the sidecar window doesn't stay accidentally zoomed out.
  await withSoftTimeout(targetPage.keyboard.press(process.platform === "darwin" ? "Meta+0" : "Control+0"), 1_000);
}

async function ensureBrowser() {
  if (browser && context && page && !page.isClosed()) return;
  await ensureChromeRunning();
  log("connecting to Chrome via CDP…");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  context = browser.contexts()[0] ?? (await browser.newContext());
  await installContextGuards();
  const cookies = loadCookies();
  const seeded = await addCookiesBestEffort(cookies, "startup cookie seed");
  log(seeded ? `seeded ${cookies.length} cookies into Chrome context` : `using existing Chrome profile cookies (${cookies.length} cookies available on disk)`);

  // PR #302 (revised): always create a NEW page rather than reusing
  // pages[0]. The daemon's Chrome accumulates tabs from prior sessions
  // (cookie-extension setup, leftover scans, manual user navigation)
  // and `pages[0]` may not be a tab the daemon owns. Operator
  // screenshot 2026-04-29 showed the visible window stuck on
  // about:blank while the daemon was scraping a hidden tab.
  //
  // PR #307: create the daemon-owned tab FIRST, then close all
  // OTHER tabs in the context. The earlier "close everything then
  // newPage" attempt hung Chrome because closing the last tab quits
  // Chrome on macOS — but if we have ≥2 tabs (our new one + N stale
  // ones), closing the stale set leaves Chrome alive and the daemon
  // tab as the only one. Net result: each daemon start gives us a
  // single fresh tab, no clutter, no stale state, no risk of
  // accidentally scraping a leftover tab.
  page = await Promise.race([
    context.newPage(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("newPage timed out")), 8000)),
  ]);
  await normalizePageDisplay(page);
  const closedCount = await closeExtraTabs("startup tab cleanup", page);
  log(`opened fresh daemon-owned tab; closed ${closedCount} stale tab(s)`);
}

// Reset the daemon-owned page to a clean about:blank state. Called
// between ops in the dispatcher so each scrape starts from a known
// blank slate — no leftover modal dialogs, scroll position, JS
// timers, intersection observers, or page-level event listeners
// from the previous op. Cookies persist (context-level), which is
// what we want for VRBO/Booking/Google session continuity.
//
// Cheap (~50ms) and idempotent. If `page` is closed for any reason,
// ensureBrowser() in the next op will recreate it.
async function resetPage() {
  if (!page || page.isClosed?.()) return;
  try {
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 });
    await normalizePageDisplay(page);
  } catch {
    // about:blank should never fail, but if it does the next
    // ensureBrowser/page.goto will recover.
  }
}

async function teardownBrowser(reason) {
  log(`disconnecting CDP: ${reason}`);
  try { if (browser) await browser.close().catch(() => {}); } catch {}
  browser = null;
  context = null;
  page = null;
  contextGuardsInstalled = false;
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON response: ${text.slice(0, 200)}`); }
}

async function pollNext() {
  const data = await fetchJson(`${SERVER}/api/admin/vrbo-sidecar/next`, {
    headers: authHeaders(),
  });
  return data.request ?? null;
}

// ── Auto-refresh cookies pushed by the Chrome extension ─────────────
// Fingerprint of the cookie set last applied to the Chrome context.
// On each tick, fetch /api/admin/vrbo-sidecar/cookies; if the
// server's fingerprint differs from ours, reseed the context. This is
// the Chrome-extension → daemon handoff for Option C cookie sync.
let lastAppliedCookieFingerprint = null;

async function syncRemoteCookies() {
  try {
    const r = await fetch(`${SERVER}/api/admin/vrbo-sidecar/cookies`, {
      headers: authHeaders(),
    });
    if (!r.ok) return false;
    const data = await r.json();
    const cookies = data?.cookies ?? [];
    const fp = data?.fingerprint ?? null;
    if (!cookies.length) return false;
    if (fp && fp === lastAppliedCookieFingerprint) return false;
    if (!context) await ensureBrowser();
    if (!context) return false;
    // Normalise to Playwright shape (same as loadCookies()).
    const sameSiteMap = { strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None" };
    const normalised = cookies
      .filter((c) => c?.name && c?.value && c?.domain)
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
        path: c.path ?? "/",
        expires:
          typeof c.expirationDate === "number"
            ? Math.floor(c.expirationDate)
            : typeof c.expires === "number"
            ? Math.floor(c.expires)
            : -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? true,
        sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax",
      }));
    const applied = await addCookiesBestEffort(normalised, "cookie sync");
    if (!applied) {
      if (fp) lastAppliedCookieFingerprint = fp;
      return false;
    }
    lastAppliedCookieFingerprint = fp;
    log(`cookie sync: applied ${normalised.length} cookies from extension (fp=${fp})`);
    return true;
  } catch (e) {
    // Cookie sync failure is non-fatal — the daemon keeps running with
    // whatever cookies it last had (file-seeded or previously
    // extension-pushed).
    if (!/AbortError|fetch failed/i.test(e?.message ?? "")) {
      log(`cookie sync error: ${e?.message ?? e}`);
    }
    return false;
  }
}

async function postResult(id, results, error) {
  const body = error ? { id, error } : { id, results };
  await fetchJson(`${SERVER}/api/admin/vrbo-sidecar/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
}

async function dumpPageState(label, requestForLog) {
  try {
    // Set a wider viewport before screenshot so we capture more of the
    // listing grid (Vrbo's narrow viewport falls back to mobile layout
    // which renders fewer cards). Resize idempotent — Playwright
    // tracks the current size.
    await normalizePageDisplay(page);
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyExcerpt: (document.body?.innerText ?? "").slice(0, 2000),
      bodyHtmlSnippet: (document.body?.innerHTML ?? "").slice(0, 4000),
    }));
    fs.writeFileSync(
      path.join(__dirname, `last-${label}-state.json`),
      JSON.stringify({ ...requestForLog, ...state }, null, 2),
    );
    // Full-page screenshot so we capture all listings, not just the
    // viewport. Quality 70 keeps file size sensible (~150-300KB).
    await page.screenshot({ path: path.join(__dirname, `last-${label}.jpg`), type: "jpeg", quality: 70, fullPage: true }).catch(() => {});
    log(`${label} state: url=${state.url.slice(0, 100)} title="${state.title.slice(0, 60)}"`);
    return state;
  } catch {
    return null;
  }
}

// ───────────────────────── VRBO search ──────────────────────────────
async function applyVrboBedroomFilter(bedrooms) {
  const targetBedrooms = Number.parseInt(String(bedrooms ?? ""), 10);
  if (!Number.isFinite(targetBedrooms) || targetBedrooms <= 0) return false;
  try {
    const filterButton = page
      .locator('button:has-text("Rooms & spaces"), button:has-text("Filters")')
      .first();
    await filterButton.click({ timeout: 3000 });
    await page.waitForTimeout(800);
    const inputHandle = await page
      .locator(
        [
          'input[aria-label*="Minimum bedrooms" i]',
          'input[aria-label*="Bedrooms" i]',
          '[role="spinbutton"][aria-label*="Bedroom" i]',
        ].join(", "),
      )
      .first()
      .elementHandle();

    let strategyWorked = false;
    if (inputHandle) {
      try {
        await inputHandle.click({ timeout: 2000 });
        await page.keyboard.press("Meta+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(String(targetBedrooms), { delay: 30 });
        await page.waitForTimeout(200);
        const after = await inputHandle.evaluate((el) => el.value || el.getAttribute("aria-valuenow") || "").catch(() => "");
        if (after === String(targetBedrooms)) strategyWorked = true;
      } catch {}
      if (!strategyWorked) {
        await inputHandle.evaluate((el, val) => {
          const setter = Object.getOwnPropertyDescriptor((el.constructor.prototype), "value")?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, String(targetBedrooms));
        await page.waitForTimeout(200);
        const after = await inputHandle.evaluate((el) => el.value || el.getAttribute("aria-valuenow") || "").catch(() => "");
        if (after === String(targetBedrooms)) strategyWorked = true;
      }
    }
    if (!strategyWorked) {
      strategyWorked = Boolean(await withSoftTimeout(
        page.evaluate((target) => {
          function isVisible(el) {
            if (!el || !(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 8 && rect.height > 8 &&
              rect.bottom >= 0 && rect.right >= 0 &&
              rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
              style.display !== "none" && style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.05;
          }
          function labelOf(el) {
            return [
              el.textContent,
              el.getAttribute?.("aria-label"),
              el.getAttribute?.("title"),
              el.getAttribute?.("value"),
            ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
          }
          const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
            .filter((el) => isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
          const inc = buttons.find((el) => {
            const label = labelOf(el);
            return /bedroom/i.test(label) && /\b(increase|add|plus|\+)\b/i.test(label);
          }) ?? buttons.find((el) => {
            const label = labelOf(el);
            return /^(?:\+|add)$/i.test(label) &&
              /bedroom/i.test(labelOf(el.closest("[role='group'], fieldset, section, div") || el.parentElement || el));
          });
          if (!inc) return false;
          for (let i = 0; i < target; i++) inc.click();
          return true;
        }, targetBedrooms),
        3_000,
        false,
      ));
    }
    if (!strategyWorked) throw new Error("bedroom control not found");

    const doneCandidates = await page
      .locator('button:has-text("Done"), button:has-text("Apply"), button:has-text("Show properties"), button:has-text("Show stays")')
      .all()
      .catch(() => []);
    if (doneCandidates.length > 0) {
      await doneCandidates[doneCandidates.length - 1].click({ timeout: 3000 }).catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.waitForTimeout(PAGE_SETTLE_MS);
    log(`vrbo_search: applied visible bedroom filter (${targetBedrooms}+BR)`);
    return true;
  } catch (e) {
    log(`vrbo filter UI failed: ${e.message ?? e}`);
    try {
      const current = new URL(page.url());
      current.searchParams.set("minBedrooms", String(targetBedrooms));
      await page.goto(current.toString(), { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
      await page.waitForTimeout(PAGE_SETTLE_MS);
      log(`vrbo_search: applied URL bedroom fallback (minBedrooms=${targetBedrooms})`);
      return true;
    } catch (fallbackError) {
      log(`vrbo filter URL fallback failed: ${fallbackError.message ?? fallbackError}`);
      return false;
    }
  }
}

async function applyBookingBedroomFilter(bedrooms) {
  const targetBedrooms = Number.parseInt(String(bedrooms ?? ""), 10);
  if (!Number.isFinite(targetBedrooms) || targetBedrooms <= 0) return false;
  try {
    const current = new URL(page.url());
    const filters = current.searchParams
      .getAll("nflt")
      .join(";")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/^entire_place_bedroom_count=/i.test(part));
    filters.push(`entire_place_bedroom_count=${targetBedrooms}`);
    current.searchParams.delete("nflt");
    current.searchParams.set("nflt", filters.join(";"));
    await page.goto(current.toString(), { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await page.waitForTimeout(PAGE_SETTLE_MS);
    await dismissObstructions(page, "booking_search_after_bedroom_filter");
    log(`booking_search: applied bedroom filter (${targetBedrooms}BR) after visible search submit`);
    return true;
  } catch (e) {
    log(`booking bedroom filter failed: ${e.message ?? e}`);
    return false;
  }
}

async function clickVisibleSearchSubmit(targetPage = page, label = "search") {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const clicked = await withSoftTimeout(
    targetPage.evaluate(() => {
      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 &&
          rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05;
      }
      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }
      const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button']"))
        .filter((el) => isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
      const target = candidates.find((el) => {
        const label = textOf(el);
        return /^(search|find|submit)$/i.test(label) ||
          /\b(search|find stays|show stays|show properties)\b/i.test(label);
      });
      if (!target) return null;
      const clickedLabel = textOf(target).slice(0, 80) || target.tagName.toLowerCase();
      target.scrollIntoView?.({ block: "center", inline: "center" });
      target.click?.();
      return clickedLabel;
    }),
    2_000,
    null,
  );
  if (clicked) {
    log(`${label}: clicked visible search submit "${clicked}"`);
    await targetPage.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
  }
  return clicked;
}

async function processVrboSearch(id, params) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(searchTerm || destination || "").trim();
  log(
    `vrbo_search ${id}: searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR`,
  );
  await ensureBrowser();
  // PR #301: drop minBedrooms URL filter — Vrbo's server-side filter
  // is unreliable (returns 5 properties for a regionId+minBedrooms=3
  // search where only 0 are actually 3BR). Pull ALL listings for the
  // resort and let the helper filter by exact-match bedroom downstream.
  // Same pattern lets one Vrbo fetch satisfy multiple BR scans —
  // server-side dedup in the queue could later avoid hitting Vrbo
  // multiple times per property.
  // Force currency=USD so Canadian operators don't get CAD values
  // mistakenly persisted as USD.
  const url =
    `https://www.vrbo.com/search?destination=${encodeURIComponent(effectiveSearchTerm)}` +
    `&startDate=${checkIn}&endDate=${checkOut}` +
    `&adults=2&sort=PRICE_LOW_TO_HIGH&currency=USD`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await dismissObstructions(page, "vrbo_search");
  await clickVisibleSearchSubmit(page, "vrbo_search").catch(() => null);
  await applyVrboBedroomFilter(bedrooms).catch(() => false);
  const state = await dumpPageState("vrbo", { id, ...params });
  if (state && /show us your human side|we can.?t tell if you.?re a human/i.test(state.bodyExcerpt)) {
    throw new Error("Vrbo bot wall — refresh cookies.json (vrbo.com) and kickstart");
  }
  // Still extract all visible cards and bucket by BR client-side:
  // VRBO's browser-side filter is useful for relevance and operator
  // visibility, but the downstream exact-bedroom guard remains the
  // authoritative protection against mismatched 1BR/2BR rows.

  // Compute expected nights from the requested window — we always
  // ask for 7-night (multichannel scanner) but compute robustly so
  // future callers can ask for different windows.
  const expectedNights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / (24 * 60 * 60 * 1000)));

  const result = await page.evaluate((args) => {
    const { expectedNights, targetBedrooms } = args;

    // Card selector with fallback chain. Vrbo's data-stid attribute
    // has changed multiple times; relying on a single fixed selector
    // breaks every time they redesign. Strategy:
    //   1. Try the historical data-stid="lodging-card-responsive"
    //      (still works on some page variants)
    //   2. Fall back to anchors with Vrbo property URLs (/N pattern)
    //      and walk up to their card-like ancestor. Vrbo property
    //      listing URLs are consistently digit-based, much more
    //      stable than data-stid attributes.
    let cardEls = Array.from(document.querySelectorAll('[data-stid="lodging-card-responsive"]'));
    let selectorSource = "data-stid";
    if (cardEls.length === 0) {
      const propertyAnchors = Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => /^\/\d+/.test(a.getAttribute("href") || ""));
      const cardSet = new Set();
      for (const a of propertyAnchors) {
        // Walk up to a card-like container. The first ancestor with
        // an h3 inside is likely the card boundary.
        let el = a;
        for (let depth = 0; depth < 6 && el && el.parentElement; depth++) {
          el = el.parentElement;
          if (el.querySelector("h3")) {
            cardSet.add(el);
            break;
          }
        }
      }
      cardEls = Array.from(cardSet);
      selectorSource = "anchor-fallback";
    }
    const out = [];
    const drops = { noUrl: 0, noPrice: 0, badBedrooms: 0 };
    let firstCardSample = null;
    for (const card of cardEls) {
      const titleEl = card.querySelector("h3");
      const title = titleEl ? titleEl.textContent.trim().replace(/^Photo gallery for\s*/i, "") : "";
      const fullText = (card.textContent || "").replace(/\s+/g, " ");
      const bdMatch = fullText.match(/(\d+)\s*bedrooms?/i);
      const link = card.querySelector("a[href]");
      const propertyPath = ((link?.getAttribute("href") || "")).replace(/^https?:\/\/[^\/]+/, "").split("?")[0];
      const bedroomsExtracted = bdMatch ? parseInt(bdMatch[1], 10) : null;

      // Capture the first card's text + extracted values so the daemon
      // can log it when zero cards survived the filter — gives us
      // visibility into Vrbo UI changes without redeploying.
      if (firstCardSample === null) {
        firstCardSample = {
          title: title.slice(0, 80),
          textExcerpt: fullText.slice(0, 240),
          propertyPath: propertyPath.slice(0, 80),
          bedroomsExtracted,
        };
      }

      if (!/^\/\d+/.test(propertyPath)) { drops.noUrl++; continue; }

      // Vrbo card pricing has TWO common formats today (2026-04-29):
      //   New: "$820" big price + "$8,123 total includes taxes & fees"
      //   Old: "$X for Y nights" (single string)
      let totalPrice = 0;
      let totalNights = 0;
      let priceIncludesTaxes = false;

      const totalMatch = fullText.match(/\$\s*([\d,]+)\s*total\s*(?:includes\s*taxes)?/i);
      if (totalMatch) {
        totalPrice = parseInt(totalMatch[1].replace(/,/g, ""), 10);
        totalNights = expectedNights;
        priceIncludesTaxes = /total\s*includes\s*taxes/i.test(fullText);
      } else {
        const m = fullText.match(/\$\s*([\d,]+)\s*for\s*(\d+)\s*nights/i);
        if (m) {
          totalPrice = parseInt(m[1].replace(/,/g, ""), 10);
          totalNights = parseInt(m[2], 10);
          priceIncludesTaxes = false;
        }
      }
      if (!(totalPrice > 0) || !(totalNights > 0)) { drops.noPrice++; continue; }
      if (bedroomsExtracted !== targetBedrooms) { drops.badBedrooms++; continue; }

      out.push({
        url: "https://www.vrbo.com" + propertyPath,
        title: title.slice(0, 80),
        totalPrice,
        nightlyPrice: Math.round(totalPrice / totalNights),
        bedrooms: bedroomsExtracted,
        priceIncludesTaxes,
      });
    }
    return { out, drops, totalSeen: cardEls.length, selectorSource, firstCardSample };
  }, { expectedNights, targetBedrooms: Number.parseInt(String(bedrooms ?? ""), 10) });

  const cards = result.out;
  const allInCount = cards.filter((c) => c.priceIncludesTaxes).length;
  // Bedroom distribution across the extracted cards — surfaces UI
  // changes where the regex matches the wrong number (e.g. matches
  // "Sleeps 4 · 1 bedroom" → 4 instead of 1).
  const brList = cards.map((c) => c.bedrooms ?? "?").join(",");
  log(
    `vrbo_search ${id}: ${cards.length} cards (${allInCount} all-in / ${cards.length - allInCount} pre-tax) ` +
    `[selector=${result.totalSeen}/${result.selectorSource}, drops=noUrl:${result.drops.noUrl}/noPrice:${result.drops.noPrice}/badBR:${result.drops.badBedrooms}, BRs=[${brList}]]`,
  );
  if (cards.length === 0 && result.firstCardSample) {
    log(`vrbo_search ${id}: empty-result diagnostic — first card title="${result.firstCardSample.title}" path="${result.firstCardSample.propertyPath}" br=${result.firstCardSample.bedroomsExtracted} text="${result.firstCardSample.textExcerpt}"`);
  }
  // Per-card detail. Log min/max nightly per BR bucket so we can spot
  // outliers without flooding logs with 19+ lines per scan.
  if (cards.length > 0) {
    const byBR = new Map();
    for (const c of cards) {
      const k = c.bedrooms ?? "?";
      const bucket = byBR.get(k) ?? [];
      bucket.push(c.nightlyPrice);
      byBR.set(k, bucket);
    }
    const summary = Array.from(byBR.entries())
      .sort((a, b) => (typeof a[0] === "number" ? a[0] : 99) - (typeof b[0] === "number" ? b[0] : 99))
      .map(([br, prices]) => {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        return `${br}BR n=${prices.length} $${min}-$${max}`;
      })
      .join(", ");
    log(`vrbo_search ${id}: by-BR: ${summary}`);
  }
  await postResult(id, cards);
}

// ─────────────────────── VRBO listing photo scrape ─────────────────
async function processVrboPhotoScrape(id, params) {
  const { url, maxPhotos = 50 } = params;
  log(`vrbo_photo_scrape ${id}: ${url}`);
  await ensureBrowser();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await dismissObstructions(page, "vrbo_photo_scrape");
  const state = await dumpPageState("vrbo-photo", { id, ...params });
  if (state && /show us your human side|we can.?t tell if you.?re a human|bot or not/i.test(state.bodyExcerpt)) {
    throw new Error("Vrbo bot wall — refresh cookies.json (vrbo.com) and kickstart");
  }

  await page
    .click('button:has-text("View all photos"), button:has-text("Show all photos"), button:has-text("Photo gallery")', { timeout: 2500 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const photos = await page.evaluate(({ maxPhotos }) => {
    const out = [];
    const seen = new Set();

    function normalize(raw) {
      if (!raw) return "";
      let url = String(raw)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .trim();
      if (url.startsWith("//")) url = `https:${url}`;
      return url;
    }

    function push(raw) {
      const url = normalize(raw);
      if (!/^https?:\/\//i.test(url)) return;
      const lower = url.toLowerCase();
      const isVrboImageHost = /(?:images\.trvl-media\.com|mediaim\.expedia\.com|odis\.homeaway\.com|vrbo\.com|homeaway\.com)/i.test(lower);
      const hasImageExtension = /\.(?:jpe?g|webp|png)(?:[?#]|$)/i.test(lower);
      if (!isVrboImageHost && !hasImageExtension) return;
      if (/logo|icon|sprite|avatar|favicon|placeholder|transparent|map/.test(lower)) return;
      const key = lower.replace(/[?#].*$/, "");
      if (seen.has(key)) return;
      seen.add(key);
      out.push(url);
    }

    function pushSrcset(srcset) {
      String(srcset || "").split(",").forEach((part) => {
        const first = part.trim().split(/\s+/)[0];
        push(first);
      });
    }

    document.querySelectorAll("img").forEach((img) => {
      push(img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src"));
      pushSrcset(img.getAttribute("srcset"));
    });
    document.querySelectorAll("source[srcset]").forEach((source) => pushSrcset(source.getAttribute("srcset")));

    document.querySelectorAll("script").forEach((script) => {
      const text = normalize(script.textContent || "");
      const matches = text.match(/https?:\/\/[^"' <>()]+?(?:jpe?g|webp|png)(?:\?[^"' <>()]*)?/gi) || [];
      matches.forEach(push);
    });

    return out.slice(0, Math.max(1, Math.min(100, Number(maxPhotos) || 50)));
  }, { maxPhotos });

  log(`vrbo_photo_scrape ${id}: ${photos.length} photos`);
  await postResult(id, { photos });
}

// ─────────────────────── Booking.com search ─────────────────────────
async function processBookingSearch(id, params) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(searchTerm || destination || "").trim();
  log(
    `booking_search ${id}: searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR`,
  );
  await ensureBrowser();
  // Booking.com supports `nflt=entire_place_bedroom_count%3D${bedrooms}`
  // for the bedroom filter (URL-encoded "entire_place_bedroom_count=N"),
  // sorted by price: `&order=price`.
  const url =
    `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(effectiveSearchTerm)}` +
    `&checkin=${checkIn}&checkout=${checkOut}` +
    `&group_adults=2&no_rooms=1&group_children=0` +
    `&order=price&nflt=${encodeURIComponent("entire_place_bedroom_count=" + bedrooms)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await dismissObstructions(page, "booking_search");
  await clickVisibleSearchSubmit(page, "booking_search").catch(() => null);
  await applyBookingBedroomFilter(bedrooms).catch(() => false);
  const state = await dumpPageState("booking", { id, ...params });
  if (state && /access denied|are you a robot|please verify/i.test(state.bodyExcerpt)) {
    throw new Error("Booking.com bot wall — refresh cookies.json (booking.com)");
  }

  const cards = await page.evaluate((minBd) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="property-card"]'));
    const out = [];
    for (const card of cards) {
      const titleEl = card.querySelector('[data-testid="title"]') ?? card.querySelector("h3, h2");
      const title = titleEl ? titleEl.textContent.trim() : "";
      const link = card.querySelector('a[href*="/hotel/"]');
      const href = link ? link.getAttribute("href") || "" : "";
      // Strip query string for the canonical URL but keep the .html path.
      const url = href.startsWith("http") ? href.split("?")[0] : href ? "https://www.booking.com" + href.split("?")[0] : "";
      // Booking renders multiple $X numbers inside the price element:
      // strikethrough original, discount amount ("$28 savings"), and
      // the actual total. The original regex grabbed the FIRST match
      // which on discounted listings was the $28 savings badge — bug
      // surfaced 2026-04-29 with a $28 booking median for a 2BR Hawaii
      // unit that should be ~$3000+ total. Fix: grab ALL $X matches
      // and take the LARGEST. The total you'd actually pay is always
      // the biggest number on the price card.
      const priceEl = card.querySelector('[data-testid="price-and-discounted-price"]');
      const priceText = priceEl ? priceEl.textContent.replace(/\s+/g, " ") : "";
      const allPrices = Array.from(priceText.matchAll(/\$\s*([\d,]+)/g))
        .map((m) => parseInt(m[1].replace(/,/g, ""), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      const totalPrice = allPrices.length > 0 ? Math.max(...allPrices) : 0;
      const fullText = (card.textContent || "").replace(/\s+/g, " ");
      const bdMatch = fullText.match(/(\d+)\s*bedroom/i);
      const bedrooms = bdMatch ? parseInt(bdMatch[1], 10) : 0;
      if (!url) continue;
      if (!(totalPrice > 0)) continue;
      if (bedrooms !== minBd) continue;
      out.push({
        url,
        title: title.slice(0, 80),
        totalPrice,
        // Booking shows a "total" price including taxes/fees for the
        // requested window; nightlyPrice is the average across that window.
        // Caller knows the night count from its own context (find-buy-in),
        // so we just publish total + a best-effort per-night.
        nightlyPrice: 0, // filled in by caller using its known night count
        bedrooms: bedrooms || undefined,
      });
    }
    return out;
  }, bedrooms);
  log(`booking_search ${id}: ${cards.length} cards`);
  await postResult(id, cards);
}

// ─────────────────────── Google SERP scrape ─────────────────────────
async function processGoogleSerp(id, params) {
  const { query, maxResults } = params;
  log(`google_serp ${id}: "${query}" max=${maxResults}`);
  await ensureBrowser();
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults ?? 20}&hl=en&gl=us`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(2500);
  await dismissObstructions(page, "google_serp");
  await page.waitForTimeout(800);
  const state = await dumpPageState("google", { id, ...params });
  if (state && /unusual traffic|sorry, but your computer/i.test(state.bodyExcerpt)) {
    throw new Error("Google rate-limit page — wait or rotate IP");
  }

  const hits = await page.evaluate((max) => {
    const out = [];
    const seen = new Set();
    // Modern Google SERP: organic results are inside `div.g` or
    // `div[data-sokoban-container]`. The h3 is the title; the parent
    // anchor carries the destination URL.
    const candidates = Array.from(document.querySelectorAll("div.g, div[data-sokoban-container], div.MjjYud"));
    for (const node of candidates) {
      if (out.length >= max) break;
      const a = node.querySelector("a[href^=http]");
      if (!a) continue;
      const url = a.getAttribute("href") || "";
      if (!url || seen.has(url)) continue;
      // Skip ads and Google-internal links.
      if (/google\.com\/(?:aclk|search|sorry)/.test(url)) continue;
      const titleEl = node.querySelector("h3");
      const title = titleEl ? titleEl.textContent.trim() : "";
      if (!title) continue;
      const snippetEl = node.querySelector("div[data-sncf], div.VwiC3b, span.aCOpRe");
      const snippet = snippetEl ? snippetEl.textContent.trim().slice(0, 220) : "";
      seen.add(url);
      out.push({ url, title: title.slice(0, 120), snippet });
    }
    return out;
  }, maxResults ?? 20);
  log(`google_serp ${id}: ${hits.length} hits`);
  await postResult(id, hits);
}

// ─────────────────────── PM URL availability check ─────────────────
// URL canonicalisation: most PM widgets accept either checkin/checkout
// or check_in/check_out query keys; set both so we don't have to know
// which CMS each PM is running.
function withDateParams(url, checkIn, checkOut) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("checkin")) u.searchParams.set("checkin", checkIn);
    if (!u.searchParams.has("checkout")) u.searchParams.set("checkout", checkOut);
    if (!u.searchParams.has("check_in")) u.searchParams.set("check_in", checkIn);
    if (!u.searchParams.has("check_out")) u.searchParams.set("check_out", checkOut);
    return u.toString();
  } catch {
    return url;
  }
}

async function clickPmCalendarDates(targetPage, checkIn, checkOut) {
  if (!targetPage || targetPage.isClosed?.()) return null;

  const runCalendarAction = (action, iso = null) => withSoftTimeout(
    targetPage.evaluate(({ action, iso }) => {
      const dateContextRe = /\b(?:check[\s_-]*in|check[\s_-]*out|arrival|departure|arrive|depart|date|dates|stay|calendar|availability|rates|booking|reservation|book now|reserve|select dates)\b/i;
      const badActionRe = /\b(?:clear|reset|cancel|close|search results|view search results|skip to main content|overview|photos?|visit owner|owner'?s website|external website|facebook|instagram|social|share|contact|terms|privacy|cookies?|policy|map|directions)\b/i;
      const submitRe = /\b(?:search|check availability|check rates|view rates|show rates|update|apply|submit|book now|reserve|continue)\b/i;
      const nextRe = /^(?:next|next month|following month|›|»|>|→)$/i;

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
          el.getAttribute?.("class"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        let cur = el.parentElement;
        for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
          parts.push(cur.getAttribute?.("aria-label"));
          parts.push(cur.getAttribute?.("class"));
          const txt = (cur.textContent || "").replace(/\s+/g, " ").trim();
          if (txt.length <= 320) parts.push(txt);
        }
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function disabled(el) {
        return Boolean(el.disabled) ||
          el.getAttribute?.("aria-disabled") === "true" ||
          /\b(?:disabled|unavailable|blocked)\b/i.test(el.getAttribute?.("class") || "");
      }

      function activate(el) {
        const label = textOf(el).slice(0, 80) || el.tagName.toLowerCase();
        el.scrollIntoView?.({ block: "center", inline: "center" });
        const init = { bubbles: true, cancelable: true, view: window };
        try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("mousedown", init)); } catch {}
        try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("mouseup", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("click", init)); } catch { el.click?.(); }
        return label;
      }

      function isoParts(rawIso) {
        const [y, m, d] = String(rawIso || "").split("-").map((p) => parseInt(p, 10));
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
        const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        return {
          y,
          m,
          d,
          iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
          mdyyyy: `${m}/${d}/${y}`,
          padded: `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`,
          monthLong: date.toLocaleString("en-US", { timeZone: "UTC", month: "long" }),
          monthShort: date.toLocaleString("en-US", { timeZone: "UTC", month: "short" }),
        };
      }

      function scoreDateCell(el, rawIso) {
        const p = isoParts(rawIso);
        if (!p || !isVisible(el) || disabled(el)) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width > 180 || rect.height > 180) return 0;
        const attrs = [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
          el.getAttribute?.("data-date"),
          el.getAttribute?.("data-day"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
          el.getAttribute?.("datetime"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        const label = attrs.toLowerCase();
        const ancestor = contextOf(el).toLowerCase();
        const monthYear = new RegExp(`\\b(?:${p.monthLong}|${p.monthShort})\\b[\\s\\S]{0,80}\\b${p.y}\\b`, "i");
        if (label.includes(p.iso)) return 100;
        if (label.includes(p.padded.toLowerCase()) || label.includes(p.mdyyyy.toLowerCase())) return 96;
        if (label.includes(`${p.monthLong.toLowerCase()} ${p.d}, ${p.y}`) || label.includes(`${p.monthShort.toLowerCase()} ${p.d}, ${p.y}`)) return 94;
        if (label.includes(`${p.monthLong.toLowerCase()} ${p.d}`) || label.includes(`${p.monthShort.toLowerCase()} ${p.d}`)) return 86;
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text === String(p.d) && monthYear.test(ancestor)) return 78;
        if (new RegExp(`\\b${p.d}\\b`).test(text) && monthYear.test(ancestor)) return 66;
        return 0;
      }

      function findDateCell(rawIso) {
        const selector = [
          "button",
          "a",
          "[role='button']",
          "td",
          "div[aria-label]",
          "span[aria-label]",
          "[data-date]",
          "[data-day]",
          "time",
        ].join(",");
        return Array.from(document.querySelectorAll(selector))
          .map((el) => ({ el, score: scoreDateCell(el, rawIso) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)[0]?.el ?? null;
      }

      function openCalendar() {
        if (iso && findDateCell(iso)) return null;
        const controls = Array.from(document.querySelectorAll("input, textarea, [role='textbox'], button, a, [role='button']"))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !disabled(el))
          .map((el) => {
            const label = textOf(el);
            const ctx = contextOf(el);
            const hay = `${label} ${ctx}`;
            let score = 0;
            if (dateContextRe.test(hay)) score += 50;
            if (/check[\s_-]*in|arrival|check[\s_-]*out|departure|dates|calendar/i.test(hay)) score += 30;
            if (/book now|reserve|check availability|select dates|view rates|show rates/i.test(hay)) score += 10;
            if (badActionRe.test(label)) score = 0;
            return { el, score, label };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score);
        const target = controls[0]?.el ?? null;
        if (!target) return null;
        return { openedLabel: activate(target) };
      }

      function clickDate(rawIso) {
        const target = findDateCell(rawIso);
        if (!target) return null;
        return { clickedLabel: activate(target) };
      }

      function clickNextMonth() {
        const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !disabled(el))
          .map((el) => ({ el, label: textOf(el), ctx: contextOf(el) }))
          .filter(({ label, ctx }) => {
            if (badActionRe.test(label)) return false;
            return nextRe.test(label.trim()) || /\bnext\b/i.test(label) || /\bnext\b/i.test(ctx) || /chevron[-_\s]*right|arrow[-_\s]*right/i.test(ctx);
          });
        const target = candidates[0]?.el ?? null;
        if (!target) return null;
        return { openedLabel: activate(target) };
      }

      function submitDates() {
        const buttons = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']"))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !disabled(el));
        const target = buttons.find((el) => {
          const label = textOf(el);
          if (!submitRe.test(label)) return false;
          if (badActionRe.test(label)) return false;
          return true;
        });
        if (!target) return null;
        return { submitLabel: activate(target) };
      }

      if (action === "open") return openCalendar();
      if (action === "click-date") return iso ? clickDate(iso) : null;
      if (action === "next-month") return clickNextMonth();
      if (action === "submit") return submitDates();
      return null;
    }, { action, iso }),
    3_000,
    null,
  );

  const filled = [];
  let openedLabel = null;
  let submitLabel = null;
  const openResult = await runCalendarAction("open", checkIn);
  if (openResult?.openedLabel) {
    openedLabel = openResult.openedLabel;
    await targetPage.waitForTimeout(500).catch(() => {});
  }

  for (const [role, iso] of [["checkin", checkIn], ["checkout", checkOut]]) {
    let clicked = null;
    for (let i = 0; i < 8 && !clicked; i++) {
      clicked = await runCalendarAction("click-date", iso);
      if (clicked?.clickedLabel) break;
      const next = await runCalendarAction("next-month", iso);
      if (next?.openedLabel) {
        openedLabel = openedLabel ?? next.openedLabel;
        await targetPage.waitForTimeout(350).catch(() => {});
      } else if (i === 0) {
        const retryOpen = await runCalendarAction("open", iso);
        if (retryOpen?.openedLabel) {
          openedLabel = openedLabel ?? retryOpen.openedLabel;
          await targetPage.waitForTimeout(500).catch(() => {});
        } else {
          break;
        }
      } else {
        break;
      }
    }
    if (clicked?.clickedLabel) {
      filled.push({ role, label: `calendar ${clicked.clickedLabel}`.slice(0, 80), visible: true });
      await targetPage.waitForTimeout(600).catch(() => {});
    }
  }

  if (filled.length > 0) {
    const submit = await runCalendarAction("submit");
    if (submit?.submitLabel) {
      submitLabel = submit.submitLabel;
      await targetPage.waitForTimeout(600).catch(() => {});
    }
  }

  return { filled, submitLabel, openedLabel, controlCount: 0 };
}

async function fillKnownPmDatePairs(targetPage, checkIn, checkOut) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  return withSoftTimeout(
    targetPage.evaluate(({ checkIn, checkOut }) => {
      const [cinY, cinM, cinD] = String(checkIn).split("-").map((p) => parseInt(p, 10));
      const [coutY, coutM, coutD] = String(checkOut).split("-").map((p) => parseInt(p, 10));
      const checkInHuman = `${cinM}/${cinD}/${cinY}`;
      const checkOutHuman = `${coutM}/${coutD}/${coutY}`;
      const pairs = [
        ["#book_start_date, [name='book_start_date']", "#book_end_date, [name='book_end_date']"],
        ["#checkin, #check_in, [name='checkin'], [name='check_in']", "#checkout, #check_out, [name='checkout'], [name='check_out']"],
        ["[name*='arrival' i], [id*='arrival' i], [name*='start' i], [id*='start' i]", "[name*='departure' i], [id*='departure' i], [name*='end' i], [id*='end' i]"],
      ];
      const buttonSelector = "button, a, input[type='button'], input[type='submit'], [role='button']";
      const submitRe = /\b(?:search|check availability|check rates|view rates|show rates|update|apply|submit|book now|reserve|select dates|continue)\b/i;
      const badDateActionRe = /\b(?:clear|reset|cancel|close|search results|view search results|skip to main content|overview|photos?|visit owner|owner'?s website|external website|facebook|instagram|social|share|contact|terms|privacy|cookies?|policy|map|directions)\b/i;

      function isRendered(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function setInputValue(el, value, iso) {
        if (!el) return false;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();
        const nextValue = tag === "input" && type === "date" ? iso : value;
        try { el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
        try { el.focus?.(); } catch {}
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, nextValue);
        else el.value = nextValue;
        try {
          const jq = window.jQuery || window.$;
          if (jq?.fn?.datepicker && jq(el)?.hasClass?.("hasDatepicker")) {
            jq(el).datepicker("setDate", value);
            jq(el).trigger("input").trigger("change").trigger("blur");
          }
        } catch {}
        for (const name of ["input", "change", "blur"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return true;
      }

      for (const [startSelector, endSelector] of pairs) {
        const start = Array.from(document.querySelectorAll(startSelector)).find(isRendered);
        const end = Array.from(document.querySelectorAll(endSelector)).find(isRendered);
        if (!start || !end || start === end) continue;
        const filled = [];
        if (setInputValue(start, checkInHuman, checkIn)) {
          filled.push({ role: "checkin", label: `${start.getAttribute("name") || start.id || "paired start"}`.slice(0, 80), visible: true });
        }
        if (setInputValue(end, checkOutHuman, checkOut)) {
          filled.push({ role: "checkout", label: `${end.getAttribute("name") || end.id || "paired end"}`.slice(0, 80), visible: true });
        }
        const submit = filled.some((f) => f.role === "checkin") && filled.some((f) => f.role === "checkout")
          ? Array.from(document.querySelectorAll(buttonSelector))
            .filter((el) => el instanceof HTMLElement && isRendered(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true")
            .find((el) => {
              const label = textOf(el);
              return submitRe.test(label) && !badDateActionRe.test(label);
            })
          : null;
        if (submit) {
          submit.scrollIntoView?.({ block: "center", inline: "center" });
          submit.click();
        }
        if (filled.length > 0) return {
          filled,
          submitLabel: submit ? textOf(submit).slice(0, 80) || submit.tagName.toLowerCase() : null,
          openedLabel: null,
          controlCount: 2,
        };
      }
      return null;
    }, { checkIn, checkOut }),
    5_000,
    null,
  );
}

async function applyPmDateInputs(targetPage, checkIn, checkOut) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const attempt = async (allowOpenOnly) => withSoftTimeout(
    targetPage.evaluate(({ checkIn, checkOut, allowOpenOnly }) => {
      const [cinY, cinM, cinD] = String(checkIn).split("-").map((p) => parseInt(p, 10));
      const [coutY, coutM, coutD] = String(checkOut).split("-").map((p) => parseInt(p, 10));
      const checkInHuman = `${cinM}/${cinD}/${cinY}`;
      const checkOutHuman = `${coutM}/${coutD}/${coutY}`;
      const rangeHuman = `${checkInHuman} - ${checkOutHuman}`;
      const controlSelector = [
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[role='textbox']",
      ].join(",");
      const buttonSelector = "button, a, input[type='button'], input[type='submit'], [role='button']";
      const inRe = /\b(?:check[\s_-]*in|arrival|arrive|start|from|begin|beginning)\b/i;
      const outRe = /\b(?:check[\s_-]*out|departure|depart|end|until|leave|leaving|to)\b/i;
      const dateRe = /\b(?:date|dates|stay|calendar|availability|booking|reservation|arrival|departure|check[\s_-]*in|check[\s_-]*out)\b/i;
      const dateValueRe = /(?:mm\/dd|dd\/mm|yyyy|arrival|departure|check|date)/i;
      const submitRe = /\b(?:search|check availability|check rates|view rates|show rates|update|apply|submit|book now|reserve|select dates|continue)\b/i;
      const openerRe = /\b(?:check availability|check rates|view rates|show rates|book now|reserve|select dates|availability|rates)\b/i;
      const badDateActionRe = /\b(?:clear|reset|cancel|close|search results|view search results|skip to main content|overview|photos?|visit owner|owner'?s website|external website|facebook|instagram|social|share|contact|terms|privacy|cookies?|policy|map|directions)\b/i;

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
          el.getAttribute?.("class"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        let cur = el.parentElement;
        for (let i = 0; cur && i < 3; i++, cur = cur.parentElement) {
          parts.push(cur.getAttribute?.("aria-label"));
          parts.push(cur.getAttribute?.("class"));
          const txt = (cur.textContent || "").replace(/\s+/g, " ").trim();
          if (txt.length <= 240) parts.push(txt);
        }
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function fieldContextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        const nearestField = el.closest?.(".form-group, .date-group, [class*='field' i], [class*='date' i]");
        const fieldText = (nearestField?.textContent || "").replace(/\s+/g, " ").trim();
        if (fieldText.length <= 120) parts.push(fieldText);
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function isDateControl(el) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();
        if (tag === "input" && ["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(type)) return false;
        const ctx = contextOf(el);
        if (tag === "input" && type === "date") return true;
        if (!isVisible(el) && !(tag === "input" && type === "hidden" && /check|arrival|depart|date/i.test(ctx))) return false;
        if (dateRe.test(ctx) || dateValueRe.test(ctx)) return true;
        return false;
      }

      function setValue(el, value, iso) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();
        const nextValue = tag === "input" && type === "date" ? iso : value;
        try { el.focus?.(); } catch {}
        if (tag === "select") {
          const options = Array.from(el.options || []);
          const wanted = [nextValue, value, iso].map((s) => String(s).toLowerCase());
          const option = options.find((o) => wanted.some((w) => String(o.value || "").toLowerCase().includes(w) || String(o.textContent || "").toLowerCase().includes(w)));
          if (!option) return false;
          el.value = option.value;
        } else if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
          el.textContent = nextValue;
        } else {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, nextValue);
          else el.value = nextValue;
        }
        try {
          const jq = window.jQuery || window.$;
          if (jq?.fn?.datepicker && jq(el)?.hasClass?.("hasDatepicker")) {
            jq(el).datepicker("setDate", value);
            jq(el).trigger("input").trigger("change").trigger("blur");
          }
        } catch {}
        for (const name of ["input", "change", "blur"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return true;
      }

      function classify(el) {
        const fieldCtx = fieldContextOf(el);
        if (inRe.test(fieldCtx) && !outRe.test(fieldCtx)) return "checkin";
        if (outRe.test(fieldCtx) && !inRe.test(fieldCtx)) return "checkout";
        const ctx = contextOf(el);
        if (inRe.test(ctx) && !outRe.test(ctx)) return "checkin";
        if (outRe.test(ctx) && !inRe.test(ctx)) return "checkout";
        if (/\b(?:range|dates|stay)\b/i.test(ctx) && inRe.test(ctx) && outRe.test(ctx)) return "range";
        return "unknown";
      }

      function clickSubmit(nearEls) {
        const nearForms = new Set(nearEls.map((el) => el.closest?.("form")).filter(Boolean));
        const buttons = Array.from(document.querySelectorAll(buttonSelector))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
        const candidates = buttons.filter((el) => {
          const label = textOf(el);
          if (!submitRe.test(label)) return false;
          if (badDateActionRe.test(label)) return false;
          const form = el.closest?.("form");
          return nearForms.size === 0 || nearForms.has(form) || /availability|rates|book|reserve|search/i.test(contextOf(el));
        });
        const target = candidates[0];
        if (!target) return null;
        target.scrollIntoView?.({ block: "center", inline: "center" });
        target.click();
        return textOf(target).slice(0, 80) || target.tagName.toLowerCase();
      }

      const controls = Array.from(document.querySelectorAll(controlSelector)).filter(isDateControl);
      const visibleControls = controls.filter(isVisible);
      const checkInEls = controls.filter((el) => classify(el) === "checkin");
      const checkOutEls = controls.filter((el) => classify(el) === "checkout");
      const rangeEls = controls.filter((el) => classify(el) === "range");
      const filled = [];
      const filledEls = [];

      const uniqueControls = (items) => Array.from(new Set(items.filter(Boolean)));
      const preferVisible = (items) => items.find(isVisible) ?? items[0] ?? null;
      const nextVisibleAfter = (el) => {
        if (!el) return null;
        const idx = visibleControls.indexOf(el);
        if (idx < 0) return null;
        return visibleControls.slice(idx + 1).find((candidate) => !filledEls.includes(candidate)) ?? null;
      };
      const previousVisibleBefore = (el) => {
        if (!el) return null;
        const idx = visibleControls.indexOf(el);
        if (idx < 0) return null;
        return [...visibleControls.slice(0, idx)].reverse().find((candidate) => !filledEls.includes(candidate)) ?? null;
      };
      const firstUnusedVisible = (...exclude) =>
        visibleControls.find((candidate) => !exclude.includes(candidate) && !filledEls.includes(candidate)) ?? null;

      const fillOne = (el, value, iso, role) => {
        if (!el || filledEls.includes(el)) return null;
        if (setValue(el, value, iso)) {
          filledEls.push(el);
          filled.push({ role, label: contextOf(el).slice(0, 80), visible: isVisible(el) });
          return el;
        }
        return null;
      };
      const fillFirst = (candidates, value, iso, role) => {
        for (const candidate of uniqueControls(candidates)) {
          const used = fillOne(candidate, value, iso, role);
          if (used) return used;
        }
        return null;
      };

      if (checkInEls.length > 0 || checkOutEls.length > 0) {
        const labeledCheckIn = preferVisible(checkInEls);
        const labeledCheckOut = preferVisible(checkOutEls);
        const usedCheckIn = fillFirst([
          labeledCheckIn,
          previousVisibleBefore(labeledCheckOut),
          firstUnusedVisible(labeledCheckOut),
        ], checkInHuman, checkIn, "checkin");
        fillFirst([
          labeledCheckOut,
          nextVisibleAfter(usedCheckIn ?? labeledCheckIn),
          firstUnusedVisible(usedCheckIn ?? labeledCheckIn),
        ], checkOutHuman, checkOut, "checkout");
      } else if (rangeEls.length > 0) {
        fillOne(rangeEls[0], rangeHuman, checkIn, "range");
      } else if (visibleControls.length >= 2) {
        fillOne(visibleControls[0], checkInHuman, checkIn, "checkin");
        fillOne(visibleControls[1], checkOutHuman, checkOut, "checkout");
      } else if (visibleControls.length === 1) {
        fillOne(visibleControls[0], rangeHuman, checkIn, "range");
      }

      const hasCompleteDateEntry =
        filled.some((f) => f.role === "range") ||
        (filled.some((f) => f.role === "checkin") && filled.some((f) => f.role === "checkout"));
      const submitLabel = hasCompleteDateEntry ? clickSubmit(filledEls) : null;
      if (filled.length === 0 && allowOpenOnly) {
        const openers = Array.from(document.querySelectorAll(buttonSelector))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true")
          .filter((el) => {
            const label = textOf(el);
            if (badDateActionRe.test(label)) return false;
            return openerRe.test(label) || openerRe.test(contextOf(el));
          });
        const opener = openers[0];
        if (opener) {
          opener.scrollIntoView?.({ block: "center", inline: "center" });
          opener.click();
          return { filled, submitLabel: null, openedLabel: textOf(opener).slice(0, 80) || opener.tagName.toLowerCase(), controlCount: controls.length };
        }
      }
      return { filled, submitLabel, openedLabel: null, controlCount: controls.length };
    }, { checkIn, checkOut, allowOpenOnly }),
    5_000,
    null,
  );

  const hasCompleteDateEntry = (entry) =>
    entry?.filled?.some((f) => f.role === "range") ||
    (entry?.filled?.some((f) => f.role === "checkin") && entry?.filled?.some((f) => f.role === "checkout"));
  const mergeDateEntry = (prev, next) => {
    const filled = [];
    const seen = new Set();
    for (const item of [...(prev?.filled ?? []), ...(next?.filled ?? [])]) {
      const key = `${item.role}|${item.label}|${item.visible}`;
      if (seen.has(key)) continue;
      seen.add(key);
      filled.push(item);
    }
    return {
      controlCount: next?.controlCount ?? prev?.controlCount ?? 0,
      filled,
      submitLabel: next?.submitLabel ?? prev?.submitLabel ?? null,
      openedLabel: prev?.openedLabel ?? next?.openedLabel ?? null,
    };
  };
  const knownPair = await fillKnownPmDatePairs(targetPage, checkIn, checkOut);
  await targetPage.waitForTimeout(hasCompleteDateEntry(knownPair) ? 500 : 0).catch(() => {});
  const first = hasCompleteDateEntry(knownPair)
    ? knownPair
    : mergeDateEntry(knownPair, await attempt(true));
  let result = first;
  if (first?.openedLabel && (!first.filled || first.filled.length === 0)) {
    await targetPage.waitForTimeout(1_000).catch(() => {});
    await dismissObstructions(targetPage, "pm_date_entry_after_open");
    const second = await attempt(false);
    result = mergeDateEntry(first, second);
  }
  for (let i = 0; result?.filled?.length > 0 && !hasCompleteDateEntry(result) && i < 2; i++) {
    await targetPage.waitForTimeout(PM_PARTIAL_DATE_RETRY_MS).catch(() => {});
    await dismissObstructions(targetPage, "pm_date_entry_after_partial");
    const next = await attempt(false);
    result = mergeDateEntry(result, next);
    if (!next?.filled?.length && !next?.openedLabel && !next?.submitLabel) break;
  }
  if (!hasCompleteDateEntry(result)) {
    await targetPage.waitForTimeout(500).catch(() => {});
    const knownPairRetry = await fillKnownPmDatePairs(targetPage, checkIn, checkOut);
    result = mergeDateEntry(result, knownPairRetry);
  }
  if (!hasCompleteDateEntry(result)) {
    await dismissObstructions(targetPage, "pm_date_entry_calendar_fallback");
    const calendar = await clickPmCalendarDates(targetPage, checkIn, checkOut);
    result = mergeDateEntry(result, calendar);
  }

  const filledCount = result?.filled?.length ?? 0;
  const entryComplete = hasCompleteDateEntry(result);
  if (filledCount > 0 || result?.openedLabel || result?.submitLabel) {
    log(
      `pm_url_check: date entry controls=${result?.controlCount ?? 0} filled=${filledCount}` +
      `${result?.filled?.length ? ` roles=${result.filled.map((f) => f.role).join("+")}` : ""}` +
      `${entryComplete ? " complete=true" : filledCount > 0 ? " complete=false" : ""}` +
      `${result?.openedLabel ? ` opened="${result.openedLabel}"` : ""}` +
      `${result?.submitLabel ? ` clicked="${result.submitLabel}"` : ""}`,
    );
    if (entryComplete || result?.submitLabel || result?.openedLabel) {
      if (result?.submitLabel || result?.openedLabel) {
        await withSoftTimeout(targetPage.waitForLoadState("networkidle", { timeout: 4_000 }), 4_500);
      }
      await targetPage.waitForTimeout(entryComplete ? PM_POST_DATE_SETTLE_MS : 1_000).catch(() => {});
      await dismissObstructions(targetPage, entryComplete ? "pm_url_check_after_date_entry" : "pm_url_check_after_date_submit");
    }
  }
  return result;
}

// Visit `url` on `targetPage`, scrape an availability + price signal.
// Returns { available, nightlyPrice, totalPrice, reason }. Pure
// function on a Playwright page — doesn't touch the shared `page`,
// so safe to call concurrently from N tabs.
async function scrapePmUrl(targetPage, url, checkIn, checkOut, bedrooms = null) {
  const finalUrl = withDateParams(url, checkIn, checkOut);
  const navResponse = await targetPage.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  const navStatus = navResponse?.status?.();
  if (navStatus === 404 || navStatus === 410) {
    return {
      available: "no",
      nightlyPrice: null,
      totalPrice: null,
      reason: `HTTP ${navStatus}: PM page is no longer published for this URL`,
    };
  }
  if (typeof navStatus === "number" && navStatus >= 400) {
    return {
      available: "unclear",
      nightlyPrice: null,
      totalPrice: null,
      reason: `HTTP ${navStatus}: PM page did not load cleanly`,
    };
  }
  await targetPage.waitForTimeout(PAGE_SETTLE_MS);
  const dismissals = await dismissObstructions(targetPage, "pm_url_check");
  await targetPage.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" })).catch(() => {});
  const dateEntry = await applyPmDateInputs(targetPage, checkIn, checkOut);
  await normalizePageDisplay(targetPage);
  const hostForBedroomDetect = (() => {
    try { return new URL(finalUrl).hostname.replace(/^www\./, ""); } catch { return ""; }
  })();
  const detectedBedrooms = /booking\.com$/i.test(hostForBedroomDetect)
    ? null
    : await detectPmPageBedrooms(targetPage);
  const platformResult = await targetPage.evaluate(async ({ checkIn, checkOut, bedrooms }) => {
    const nightsBetween = (a, b) => Math.max(
      1,
      Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000),
    );
    const nights = nightsBetween(checkIn, checkOut);
    const isoNights = [];
    for (
      let t = new Date(`${checkIn}T12:00:00Z`).getTime(), end = new Date(`${checkOut}T12:00:00Z`).getTime();
      t < end;
      t += 86400000
    ) {
      const d = new Date(t);
      isoNights.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
    const toMdY = (iso) => {
      const [y, m, d] = iso.split("-").map((p) => parseInt(p, 10));
      return `${m}-${d}-${y}`;
    };
    const toMdYY = (iso) => {
      const [y, m, d] = iso.split("-");
      return `${m}/${d}/${y}`;
    };
    const host = window.location.hostname.replace(/^www\./, "");

    function parseMoneyAmount(raw) {
      const n = parseFloat(String(raw || "").replace(/,/g, "").replace(/[^\d.]/g, ""));
      return Number.isFinite(n) ? n : 0;
    }

    function bedroomPhraseRe(n) {
      if (!n || !Number.isFinite(Number(n))) return null;
      const words = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };
      const w = words[Number(n)];
      return new RegExp(`(?:${n}${w ? `|${w}` : ""})[\\s-]*(?:bedroom|bedrooms|bed|br|bd)`, "i");
    }

    async function callStreamline(methodName, params) {
      const sp = new URLSearchParams();
      sp.set("action", "streamlinecore-api-request");
      sp.set("params", JSON.stringify({ methodName, params }));
      const resp = await fetch(`/wp-admin/admin-ajax.php?${sp.toString()}`, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
      const raw = await resp.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { return { ok: false, reason: "non-JSON response" }; }
      if (json?.status?.code) {
        return { ok: false, reason: `${json.status.code}: ${json.status.description || ""}`.slice(0, 180) };
      }
      return { ok: true, data: json?.data };
    }

    function streamlineWindowAvailable(avail) {
      const begin = String(avail?.range?.beginDate || "").split("/").map((p) => parseInt(p, 10));
      const availability = String(avail?.availability || "");
      const minStay = String(avail?.minStay || "").split(",").map((p) => parseInt(p, 10)).filter(Number.isFinite);
      if (begin.length !== 3 || availability.length === 0) return null;
      const [bm, bd, by] = begin;
      const beginMs = Date.UTC(by, bm - 1, bd, 12, 0, 0);
      const startMs = new Date(`${checkIn}T12:00:00Z`).getTime();
      const endMs = new Date(`${checkOut}T12:00:00Z`).getTime();
      const startIdx = Math.round((startMs - beginMs) / 86400000);
      const endIdx = Math.round((endMs - beginMs) / 86400000);
      if (startIdx < 0 || endIdx > availability.length) return null;
      const window = availability.slice(startIdx, endIdx);
      if (/N/.test(window)) return { available: false, reason: `blocked nights ${window}` };
      const requiredMinStay = minStay[startIdx] || 1;
      if (nights < requiredMinStay) return { available: false, reason: `${requiredMinStay}-night minimum` };
      return { available: true, reason: `calendar open ${window}` };
    }

    async function tryStreamline() {
      if (!/(?:alekonakauai|princevillevacationrentals)\.com$/i.test(host)) return null;
      const html = document.documentElement?.innerHTML ?? "";
      const unitIdMatch =
        html.match(/propertyId\s*=\s*(\d+)/) ||
        html.match(/(?:unit_id|unitId|property_id|propertyId)["'\s:=]+(\d+)/i);
      const unitId = unitIdMatch ? parseInt(unitIdMatch[1], 10) : 0;
      if (!(unitId > 0)) return null;

      const availability = await callStreamline("GetPropertyAvailabilityRawData", {
        unit_id: unitId,
        use_room_type_logic: "no",
        standard_pricing: 1,
      });
      const availabilityState = availability.ok ? streamlineWindowAvailable(availability.data) : null;
      if (availabilityState?.available === false) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Streamline calendar: ${availabilityState.reason} for ${checkIn} → ${checkOut} (unitId=${unitId})`,
        };
      }

      const quote = await callStreamline("GetPreReservationPrice", {
        unit_id: unitId,
        startdate: checkIn,
        enddate: checkOut,
        adults: 2,
        children: 0,
      });
      const total = quote.ok ? parseMoneyAmount(quote.data?.total) : 0;
      if (availabilityState?.available === true && total > 0) {
        return {
          available: "yes",
          nightlyPrice: Math.round(total / nights),
          totalPrice: Math.round(total),
          reason: `Streamline API: $${Math.round(total).toLocaleString()} total for ${nights} nights; ${availabilityState.reason} (unitId=${unitId})`,
        };
      }
      if (total > 0) {
        return {
          available: "unclear",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Streamline API quoted $${Math.round(total).toLocaleString()} but calendar availability was inconclusive for ${checkIn} → ${checkOut} (unitId=${unitId})`,
        };
      }
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `Streamline API returned no usable quote for ${checkIn} → ${checkOut} (unitId=${unitId}${quote.ok ? "" : `; ${quote.reason}`})`,
      };
    }

    function tryBookingCom() {
      if (!/booking\.com$/i.test(host)) return null;
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
      if (/no availability|sold out|not available|unavailable for your dates|no properties found/i.test(text)) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Booking.com page says unavailable for ${checkIn} → ${checkOut}`,
        };
      }
      const reserveBtn = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'))
        .find((el) => {
          const label = [
            el.textContent,
            el.getAttribute?.("aria-label"),
            el.getAttribute?.("title"),
            el.getAttribute?.("value"),
          ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
          const disabled = el.disabled || el.getAttribute?.("aria-disabled") === "true";
          return !disabled && /\b(reserve|select|book now|see availability|choose room)\b/i.test(label);
        });
      const targetBedroomRe = bedroomPhraseRe(bedrooms);
      const rowTexts = Array.from(document.querySelectorAll("[data-block-id], tr, [class*=hprt], [class*=room]"))
        .map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
        .filter((row) => row.length > 20 && row.length < 5000 && /(?:US\$|\$)\s*[\d,]+/.test(row));
      const pricedRows = rowTexts.filter((row) => /\b(select|reserve|room|suite|apartment|villa|nights?|price)\b/i.test(row));
      const targetRows = targetBedroomRe ? pricedRows.filter((row) => targetBedroomRe.test(row)) : pricedRows;
      if (targetBedroomRe && pricedRows.length > 0 && targetRows.length === 0) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Booking.com did not show a priced ${bedrooms}-bedroom room type for ${checkIn} → ${checkOut}`,
        };
      }
      const priceText = (targetRows[0] || pricedRows[0] || text).replace(/\s+/g, " ");
      const perNightMatch =
        priceText.match(/(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)[^\n.]{0,40}(?:per night|nightly)/i) ||
        priceText.match(/(?:per night|nightly)[^\$]{0,40}(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)/i);
      const nightly = perNightMatch ? Math.round(parseMoneyAmount(perNightMatch[1])) : null;
      let total = 0;
      const amounts = Array.from(priceText.matchAll(/(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)/g))
        .map((m) => Math.round(parseMoneyAmount(m[1])))
        .filter((n) => n > 0);
      const minStayTotal = Math.max(250, (nightly && nightly > 0 ? nightly : 50) * nights * 0.6);
      const plausibleTotals = amounts.filter((n) => n >= minStayTotal && (!nightly || Math.abs(n - nightly) > 3));
      if (plausibleTotals.length > 0) total = Math.min(...plausibleTotals);
      if (!(total > 0) && nightly && reserveBtn) total = Math.round(nightly * nights);
      if (total > 0) {
        return {
          available: "yes",
          nightlyPrice: nightly && nightly > 0 ? nightly : Math.round(total / nights),
          totalPrice: Math.round(total),
          reason: `Booking.com detail page quoted $${Math.round(total).toLocaleString()} total for ${nights} nights`,
        };
      }
      if (reserveBtn) {
        return {
          available: "unclear",
          nightlyPrice: null,
          totalPrice: null,
          reason: "Booking.com showed a reserve/select flow but no parseable total price",
        };
      }
      return null;
    }

    async function trySuiteParadise() {
      if (!/suite-paradise\.com$/i.test(host)) return null;
      const html = document.documentElement?.innerHTML ?? "";
      const eidMatch = html.match(/"eid"\s*:\s*"(\d+)"/) || html.match(/(?:^|[^a-zA-Z0-9_])eid\s*:\s*"?(\d+)"?/);
      const eid = eidMatch ? eidMatch[1] : null;
      if (!eid) return null;
      const params = new URLSearchParams({
        "rcav[begin]": toMdYY(checkIn),
        "rcav[end]": toMdYY(checkOut),
        "rcav[adult]": "2",
        "rcav[child]": "0",
        "rcav[eid]": eid,
        "rcav[flex_type]": "d",
      });
      const resp = await fetch(`/rescms/ajax/item/pricing/simple?${params.toString()}`, {
        headers: {
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const raw = await resp.text();
      if (!resp.ok) return null;
      let json = {};
      try { json = JSON.parse(raw); } catch { return null; }
      const content = json?.content ?? "";
      if (/class=["'][^"']*\brc-na\b/i.test(content) || /not available/i.test(content)) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Suite Paradise rcapi: not available for ${checkIn} → ${checkOut} (eid=${eid})`,
        };
      }
      const exact = content.match(/(?:&quot;|")price(?:&quot;|")\s*:\s*([\d.]+)/);
      const rendered = content.match(/class=["'][^"']*\brc-price\b[^>]*>\s*\$\s*([\d,]+(?:\.\d+)?)/);
      const total = exact
        ? parseFloat(exact[1])
        : rendered
        ? parseFloat(rendered[1].replace(/,/g, ""))
        : 0;
      if (Number.isFinite(total) && total > 0) {
        return {
          available: "yes",
          nightlyPrice: Math.round(total / nights),
          totalPrice: Math.round(total),
          reason: `Suite Paradise rcapi: $${Math.round(total).toLocaleString()} total for ${nights} nights (eid=${eid})`,
        };
      }
      return null;
    }

    async function tryVrpMain() {
      const dataEl = document.querySelector("[data-unit-id][data-unit-slug]") || document.querySelector("#unit-data");
      const unitId = dataEl?.getAttribute("data-unit-id") || dataEl?.dataset?.unitId || null;
      const slug = dataEl?.getAttribute("data-unit-slug") || dataEl?.dataset?.unitSlug || null;
      if (!unitId || !slug) return null;
      const [ratesResp, bookedResp] = await Promise.all([
        fetch(`/?vrpjax=1&act=getUnitRates&unitId=${encodeURIComponent(unitId)}`, { headers: { Accept: "application/json, text/javascript, */*; q=0.01" } }),
        fetch(`/?vrpjax=1&act=getUnitBookedDates&par=${encodeURIComponent(slug)}`, { headers: { Accept: "application/json, text/javascript, */*; q=0.01" } }),
      ]);
      if (!ratesResp.ok || !bookedResp.ok) return null;
      let rates = null;
      let booked = {};
      try { rates = await ratesResp.json(); } catch { return null; }
      try { booked = await bookedResp.json(); } catch { booked = {}; }
      if (!rates || typeof rates !== "object") return null;

      const bookedSet = new Set(booked.bookedDates || []);
      for (const iso of isoNights) {
        if (bookedSet.has(toMdY(iso))) {
          return {
            available: "no",
            nightlyPrice: null,
            totalPrice: null,
            reason: `VRP calendar: booked night ${iso} for ${checkIn} → ${checkOut}`,
          };
        }
      }
      const checkInMd = toMdY(checkIn);
      if (new Set(booked.noCheckin || []).has(checkInMd)) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `VRP calendar: no check-in allowed on ${checkIn}`,
        };
      }
      let requiredMinLOS = Number(booked.minLOS || 1);
      if (Array.isArray(booked.minNights)) {
        for (const rule of booked.minNights) {
          if (rule?.start && rule?.end && checkIn >= rule.start && checkIn <= rule.end) {
            requiredMinLOS = Math.max(requiredMinLOS, Number(rule.minLOS || 1));
          }
        }
      }
      if (nights < requiredMinLOS) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `VRP calendar: ${requiredMinLOS}-night minimum for ${checkIn}`,
        };
      }
      let total = 0;
      let pricedNights = 0;
      for (const iso of isoNights) {
        const amount = parseFloat(String(rates?.[iso]?.amount ?? "0"));
        if (Number.isFinite(amount) && amount > 0) {
          total += amount;
          pricedNights++;
        }
      }
      if (pricedNights >= Math.ceil(nights * 0.8) && total > 0) {
        return {
          available: "yes",
          nightlyPrice: Math.round(total / nights),
          totalPrice: Math.round(total),
          reason: `VRP vrpjax: $${Math.round(total).toLocaleString()} total for ${nights} nights (unitId=${unitId})`,
        };
      }
      return null;
    }

    try {
      const streamline = await tryStreamline();
      if (streamline) return streamline;
    } catch (e) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `Streamline API parse error: ${String(e?.message || e).slice(0, 120)}`,
      };
    }
    try {
      const booking = tryBookingCom();
      if (booking) return booking;
    } catch (e) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `Booking.com detail parse error: ${String(e?.message || e).slice(0, 120)}`,
      };
    }
    try {
      const sp = await trySuiteParadise();
      if (sp) return sp;
    } catch (e) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `Suite Paradise rcapi error: ${String(e?.message || e).slice(0, 120)}`,
      };
    }
    try {
      const vrp = await tryVrpMain();
      if (vrp) return vrp;
    } catch (e) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `VRP vrpjax error: ${String(e?.message || e).slice(0, 120)}`,
      };
    }
    return null;
  }, { checkIn, checkOut, bedrooms }).catch(() => null);
  if (platformResult) {
    return withPagePrepReason(attachDetectedBedrooms(platformResult, detectedBedrooms), dismissals, dateEntry);
  }
  const genericResult = await targetPage.evaluate(({ checkIn, checkOut, nights }) => {
    const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
    const NO_PATTERNS = [
      /not available for these dates/i,
      /no availability/i,
      /unavailable for the selected dates/i,
      /sold out/i,
      /these dates are not available/i,
    ];
    for (const re of NO_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Page says: "${text.slice(Math.max(0, m.index - 20), m.index + 120)}"`,
        };
      }
    }
    const nativeReserveSelector =
      'button[id*="book" i], button[name*="book" i], button[class*="book" i], a[href*="book" i], input[type="submit"], input[type="button"], [role="button"]';
    const textReserveRe = /\b(reserve|book now|book direct|book online|check availability|check rates|view rates|select dates)\b/i;
    const isDisabled = (el) =>
      el.disabled ||
      el.getAttribute("aria-disabled") === "true" ||
      /\bdisabled\b/i.test(el.getAttribute("class") || "");
    const reserveBtn = Array.from(document.querySelectorAll(nativeReserveSelector))
      .find((el) => {
        if (isDisabled(el)) return false;
        const label = [
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.getAttribute("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        return textReserveRe.test(label);
      });
    const perNight = text.match(/\$\s*([\d,]+)\s*(?:\/|per|a\s+)?\s*(?:night|nightly)/i);
    const totalPrice = text.match(/\$\s*([\d,]+)\s*total/i) || text.match(/total\s*\$\s*([\d,]+)/i);
    const nightlyN = perNight ? parseInt(perNight[1].replace(/,/g, ""), 10) : null;
    const totalN = totalPrice ? parseInt(totalPrice[1].replace(/,/g, ""), 10) : null;
    const dateHintVariants = (iso) => {
      const hints = [iso];
      const d = new Date(`${iso}T12:00:00Z`);
      if (Number.isFinite(d.getTime())) {
        const monthShort = d.toLocaleString("en-US", { timeZone: "UTC", month: "short" });
        const monthLong = d.toLocaleString("en-US", { timeZone: "UTC", month: "long" });
        hints.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`);
        hints.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(-2)}`);
        hints.push(`${monthShort} ${d.getUTCDate()}`);
        hints.push(`${monthLong} ${d.getUTCDate()}`);
      }
      return hints;
    };
    const lowerText = text.toLowerCase();
    const hasCheckInSignal = dateHintVariants(checkIn).some((hint) => lowerText.includes(String(hint).toLowerCase()));
    const hasCheckOutSignal = dateHintVariants(checkOut).some((hint) => lowerText.includes(String(hint).toLowerCase()));
    const hasDateSignal = hasCheckInSignal && hasCheckOutSignal;
    const hasDateSpecificPrice = hasDateSignal && (totalN || (reserveBtn && nightlyN));
    if (hasDateSpecificPrice) {
      return {
        available: "yes",
        nightlyPrice: nightlyN,
        totalPrice: totalN ?? (nightlyN ? Math.round(nightlyN * nights) : null),
        reason: reserveBtn
          ? `Reserve/Book button present${nightlyN ? ` ($${nightlyN}/night)` : ""}${totalN ? ` ($${totalN} total)` : ""}`
          : `Visible price${nightlyN ? ` $${nightlyN}/night` : ""}${totalN ? ` $${totalN} total` : ""}`,
      };
    }
    if (reserveBtn || nightlyN || totalN) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: "Page showed a generic book/price signal but no date-specific total for the requested stay",
      };
    }
    return {
      available: "unclear",
      nightlyPrice: null,
      totalPrice: null,
      reason: "Page didn't show a clear availability/price signal — possibly login wall or non-standard PM layout",
    };
  }, { checkIn, checkOut, nights: Math.max(1, Math.round((new Date(`${checkOut}T12:00:00Z`).getTime() - new Date(`${checkIn}T12:00:00Z`).getTime()) / 86400000)) });
  const genericWithBedrooms = attachDetectedBedrooms(genericResult, detectedBedrooms);
  const preparedGeneric = withPagePrepReason(genericWithBedrooms, dismissals, dateEntry);
  if (preparedGeneric?.available === "yes" && (!pmDateEntryComplete(dateEntry) || !dateEntry?.submitLabel)) {
    return {
      ...preparedGeneric,
      available: "unclear",
      nightlyPrice: null,
      totalPrice: null,
      reason: `Date-specific search was not confirmed by a clicked availability/search submit; ${preparedGeneric.reason}`.slice(0, 800),
    };
  }
  return preparedGeneric;
}

async function processPmUrlCheck(id, params) {
  const { url, checkIn, checkOut, bedrooms } = params;
  log(`pm_url_check ${id}: ${url} ${checkIn}→${checkOut}`);
  await ensureBrowser();
  const result = await scrapePmUrl(page, url, checkIn, checkOut, bedrooms ?? null);
  await dumpPageState("pm", { id, ...params });
  log(`pm_url_check ${id}: available=${result.available} price=${result.nightlyPrice}/n`);
  await postResult(id, result);
}

// ─────────────────────── PM URL availability check (BATCH) ─────────
// Open one fresh tab per URL, scrape concurrently, close each. Total
// wall time ≈ slowest single check, not sum. Capped at 5 to keep
// Chrome happy and to bound the per-request budget.
async function processPmUrlCheckBatch(id, params) {
  const { urls, checkIn, checkOut, bedrooms } = params;
  log(`pm_url_check_batch ${id}: ${urls.length} urls ${checkIn}→${checkOut}`);
  await ensureBrowser();
  const cap = Math.min(urls.length, 5);
  const slice = urls.slice(0, cap);
  const tabs = new Set();
  const results = await Promise.all(
    slice.map(async (url) => {
      let tab = null;
      try {
        tab = await context.newPage();
        tabs.add(tab);
        const r = await scrapePmUrl(tab, url, checkIn, checkOut, bedrooms ?? null);
        return { url, ...r };
      } catch (e) {
        return {
          url,
          available: "unclear",
          nightlyPrice: null,
          totalPrice: null,
          reason: `tab error: ${e?.message ?? String(e)}`.slice(0, 200),
        };
      }
    }),
  );
  await Promise.all(Array.from(tabs).map(async (tab) => {
    try { if (tab && !tab.isClosed?.()) await tab.close(); } catch {}
  }));
  log(
    `pm_url_check_batch ${id}: yes=${results.filter((r) => r.available === "yes").length} no=${results.filter((r) => r.available === "no").length} unclear=${results.filter((r) => r.available === "unclear").length}`,
  );
  await postResult(id, results);
}

// ─────────────────────── Dispatcher ─────────────────────────────────
async function processRequest(req) {
  // Backward compat: if req.opType is missing (server hasn't deployed
  // yet OR a very old daemon talking to a new server somehow), the
  // request is the legacy vrbo-only shape.
  const opType = req.opType ?? "vrbo_search";
  const params = req.params ?? {
    destination: req.destination,
    checkIn: req.checkIn,
    checkOut: req.checkOut,
    bedrooms: req.bedrooms,
  };

  // PR #307: clear the daemon page between ops so each scrape starts
  // from a known blank state — no carryover from the previous scrape's
  // modals, observers, timers, or scroll position. The batch op
  // (pm_url_check_batch) opens its own per-URL tabs and closes them
  // in finally, so it's already isolated; skip the reset for it to
  // avoid an extra navigation on the daemon-owned page that the
  // batch isn't going to use.
  if (opType !== "pm_url_check_batch") {
    await resetPage();
  }

  try {
    switch (opType) {
      case "vrbo_search": return await processVrboSearch(req.id, params);
      case "vrbo_photo_scrape": return await processVrboPhotoScrape(req.id, params);
      case "booking_search": return await processBookingSearch(req.id, params);
      case "google_serp": return await processGoogleSerp(req.id, params);
      case "pm_url_check": return await processPmUrlCheck(req.id, params);
      case "pm_url_check_batch": return await processPmUrlCheckBatch(req.id, params);
      default: throw new Error(`unknown opType: ${opType}`);
    }
  } finally {
    await closeExtraTabs(`after ${opType}`, page).catch(() => {});
    await resetPage().catch(() => {});
  }
}

// ─────────────────────── Tick / main loop ───────────────────────────
let consecutiveErrors = 0;

// Returns true if a request was processed (so the main loop knows to
// poll again immediately rather than sleeping POLL_IDLE_MS — that
// way back-to-back requests don't each pay the 60s polling interval
// as latency. Critical for find-buy-in's pre-verify pass which fires
// 3+ pm_url_check requests in quick succession; without busy-loop
// the operator's wallet budget expires before the daemon gets to
// the second URL.)
async function tick() {
  // Pull the latest cookies the extension pushed, before claiming
  // work. Fast no-op when nothing changed (server returns same
  // fingerprint, we skip reseed).
  await syncRemoteCookies();

  let req = null;
  try {
    req = await pollNext();
  } catch (e) {
    consecutiveErrors++;
    log(`poll error (${consecutiveErrors}): ${e.message}`);
    if (consecutiveErrors >= 3) await new Promise((r) => setTimeout(r, POLL_IDLE_MS * 2));
    return false;
  }
  if (!req) {
    consecutiveErrors = 0;
    return false;
  }
  const startedAt = Date.now();
  try {
    await processRequest(req);
    consecutiveErrors = 0;
    log(`done ${req.id} in ${Date.now() - startedAt}ms`);
    return true;
  } catch (e) {
    log(`process error for ${req.id}: ${e.message}`);
    try { await postResult(req.id, undefined, e.message ?? String(e)); } catch {}
    if (/closed|disconnected|protocol|target/i.test(e.message ?? "")) {
      await teardownBrowser("error suggests CDP died");
    }
    return true; // we DID process (even if it errored) — keep busy-looping
  }
}

async function main() {
  log(`starting (server=${SERVER}, admin-secret=${ADMIN_SECRET ? "set" : "none"})`);
  log(`Chrome binary: ${CHROME_BINARY}`);
  log(`Chrome user-data-dir: ${CHROME_DATA_DIR}`);
  try {
    await ensureBrowser();
  } catch (e) {
    log(`startup failed: ${e.message}`);
    process.exit(1);
  }
  process.on("SIGINT", async () => { await teardownBrowser("SIGINT"); process.exit(0); });
  process.on("SIGTERM", async () => { await teardownBrowser("SIGTERM"); process.exit(0); });
  while (true) {
    const wasBusy = await tick();
    // After a busy tick, only wait POLL_BUSY_MS (default 2s) before
    // polling again — find-buy-in often fires several requests in
    // close succession (e.g. pre-verifying 3-6 PM URLs) and the
    // operator's wallet budget can't absorb 60s × N idle waits.
    // After an idle tick (queue empty), wait the full POLL_IDLE_MS
    // (default 10s) so the operator isn't waiting on a full-minute poll.
    await new Promise((r) => setTimeout(r, wasBusy ? POLL_BUSY_MS : POLL_IDLE_MS));
  }
}

main().catch((e) => {
  log(`fatal: ${e.message ?? String(e)}`);
  process.exit(1);
});
