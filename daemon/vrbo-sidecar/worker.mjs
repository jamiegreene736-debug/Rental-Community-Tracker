// VRBO sidecar worker — drives real Chrome via CDP.
//
// v3 (2026-04-29): generalized to dispatch on op type. Each request
// from the queue carries `opType` ∈ { vrbo_search, booking_search,
// google_serp, pm_url_check } plus a `params` blob; this worker
// dispatches to the right scrape function based on opType. Each
// processor reuses the same Chrome instance — same dedicated
// user-data-dir, same cookies, same accumulated trust.
//
// Architecture:
//   - Spawns the user's Google Chrome.app with
//     --remote-debugging-port=9222 + a dedicated user-data-dir.
//   - Connects via Playwright's chromium.connectOverCDP.
//   - Polls Railway every 60s; dispatches by opType; posts results.
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

const SERVER = process.env.SIDECAR_SERVER ?? "https://rental-community-tracker-production.up.railway.app";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";

const POLL_IDLE_MS = 60_000;
const POLL_BUSY_MS = 5_000;
const PAGE_NAV_TIMEOUT_MS = 35_000;
const PAGE_SETTLE_MS = 5_500;
const PER_REQUEST_BUDGET_MS = 90_000;

let browser = null;
let context = null;
let page = null;

function log(msg, ...rest) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [vrbo-sidecar]`, msg, ...rest);
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
  log(`spawning Chrome (port ${CDP_PORT}, user-data-dir ${CHROME_DATA_DIR})…`);
  const proc = spawn(
    CHROME_BINARY,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
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

async function ensureBrowser() {
  if (browser && context && page && !page.isClosed()) return;
  await ensureChromeRunning();
  log("connecting to Chrome via CDP…");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  context = browser.contexts()[0] ?? (await browser.newContext());
  const cookies = loadCookies();
  await context.addCookies(cookies);
  log(`seeded ${cookies.length} cookies into Chrome context`);

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
  const stalePages = context.pages();
  page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  let closedCount = 0;
  for (const stale of stalePages) {
    if (stale === page) continue; // defensive — shouldn't happen
    if (stale.isClosed?.()) continue;
    try {
      await stale.close({ runBeforeUnload: false });
      closedCount++;
    } catch {
      // Non-fatal — Chrome may have already closed the tab, or we
      // hit a race. Leaving an extra tab is harmless.
    }
  }
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
    await context.addCookies(normalised);
    lastAppliedCookieFingerprint = fp;
    log(
      `cookie sync: applied ${normalised.length} cookies from extension (fp=${fp})`,
    );
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
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
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
  try {
    await page.click('button:has-text("Filters")', { timeout: 3000 });
    await page.waitForTimeout(800);
    const inputHandle = await page
      .locator('input[aria-label*="Minimum bedrooms" i]')
      .first()
      .elementHandle();
    if (!inputHandle) throw new Error("Minimum bedrooms input not found");

    let strategyWorked = false;
    try {
      await inputHandle.click({ timeout: 2000 });
      await page.keyboard.press("Meta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(String(bedrooms), { delay: 30 });
      await page.waitForTimeout(200);
      const after = await inputHandle.inputValue().catch(() => "");
      if (after === String(bedrooms)) strategyWorked = true;
    } catch {}
    if (!strategyWorked) {
      await inputHandle.evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor((el.constructor.prototype), "value")?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, String(bedrooms));
      await page.waitForTimeout(200);
      const after = await inputHandle.inputValue().catch(() => "");
      if (after === String(bedrooms)) strategyWorked = true;
    }
    if (!strategyWorked) throw new Error("input strategies failed");

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
    log(`applied bedroom filter (${bedrooms}+BR)`);
    return true;
  } catch (e) {
    log(`vrbo filter UI failed: ${e.message ?? e}`);
    return false;
  }
}

async function processVrboSearch(id, params) {
  const { destination, checkIn, checkOut, bedrooms } = params;
  log(`vrbo_search ${id}: ${destination} ${checkIn}→${checkOut} ${bedrooms}BR`);
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
    `https://www.vrbo.com/search?destination=${encodeURIComponent(destination)}` +
    `&startDate=${checkIn}&endDate=${checkOut}` +
    `&adults=2&sort=PRICE_LOW_TO_HIGH&currency=USD`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  const state = await dumpPageState("vrbo", { id, ...params });
  if (state && /show us your human side|we can.?t tell if you.?re a human/i.test(state.bodyExcerpt)) {
    throw new Error("Vrbo bot wall — refresh cookies.json (vrbo.com) and kickstart");
  }
  // PR #301: dropped applyVrboBedroomFilter — Vrbo redesigned the
  // search page and the "Filters" button no longer exists with the
  // selector we relied on. The URL filter (now also dropped) was the
  // backup. We now extract all cards and bucket by BR client-side via
  // bedroomsExtracted.

  // Compute expected nights from the requested window — we always
  // ask for 7-night (multichannel scanner) but compute robustly so
  // future callers can ask for different windows.
  const expectedNights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / (24 * 60 * 60 * 1000)));

  const result = await page.evaluate((args) => {
    const { expectedNights } = args;

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
      if (bedroomsExtracted == null) { drops.badBedrooms++; }

      out.push({
        url: "https://www.vrbo.com" + propertyPath,
        title: title.slice(0, 80),
        totalPrice,
        nightlyPrice: Math.round(totalPrice / totalNights),
        // bedrooms can be undefined when extraction fails — downstream
        // helper treats undefined as "unknown, probably matches" so a
        // nameless 3BR doesn't get dropped from a 3BR scan.
        bedrooms: bedroomsExtracted ?? undefined,
        priceIncludesTaxes,
      });
    }
    return { out, drops, totalSeen: cardEls.length, selectorSource, firstCardSample };
  }, { expectedNights });

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

// ─────────────────────── Booking.com search ─────────────────────────
async function processBookingSearch(id, params) {
  const { destination, checkIn, checkOut, bedrooms } = params;
  log(`booking_search ${id}: ${destination} ${checkIn}→${checkOut} ${bedrooms}BR`);
  await ensureBrowser();
  // Booking.com supports `nflt=entire_place_bedroom_count%3D${bedrooms}`
  // for the bedroom filter (URL-encoded "entire_place_bedroom_count=N"),
  // sorted by price: `&order=price`.
  const url =
    `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(destination)}` +
    `&checkin=${checkIn}&checkout=${checkOut}` +
    `&group_adults=2&no_rooms=1&group_children=0` +
    `&order=price&nflt=${encodeURIComponent("entire_place_bedroom_count=" + bedrooms)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  const state = await dumpPageState("booking", { id, ...params });
  if (state && /access denied|are you a robot|please verify/i.test(state.bodyExcerpt)) {
    throw new Error("Booking.com bot wall — refresh cookies.json (booking.com)");
  }
  // Dismiss the genius/sign-in modal if present.
  await page.click('button[aria-label*="Dismiss" i], [role="dialog"] button:has-text("No, thanks")', { timeout: 1500 }).catch(() => {});

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
      if (bedrooms && bedrooms < minBd) continue;
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
  // Dismiss consent overlay if present.
  await page.click('button:has-text("Accept all"), button:has-text("I agree"), button:has-text("Reject all")', { timeout: 1500 }).catch(() => {});
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

// Visit `url` on `targetPage`, scrape an availability + price signal.
// Returns { available, nightlyPrice, totalPrice, reason }. Pure
// function on a Playwright page — doesn't touch the shared `page`,
// so safe to call concurrently from N tabs.
async function scrapePmUrl(targetPage, url, checkIn, checkOut) {
  const finalUrl = withDateParams(url, checkIn, checkOut);
  await targetPage.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await targetPage.waitForTimeout(PAGE_SETTLE_MS);
  return await targetPage.evaluate(() => {
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
    const reserveBtn = document.querySelector(
      'button[id*="book" i], button[name*="book" i], button:has-text("Reserve"), button:has-text("Book Now"), a:has-text("Reserve"), a:has-text("Book Now")',
    );
    const perNight = text.match(/\$\s*([\d,]+)\s*(?:\/|per|a\s+)?\s*(?:night|nightly)/i);
    const totalPrice = text.match(/\$\s*([\d,]+)\s*total/i) || text.match(/total\s*\$\s*([\d,]+)/i);
    const nightlyN = perNight ? parseInt(perNight[1].replace(/,/g, ""), 10) : null;
    const totalN = totalPrice ? parseInt(totalPrice[1].replace(/,/g, ""), 10) : null;
    if (reserveBtn || nightlyN || totalN) {
      return {
        available: "yes",
        nightlyPrice: nightlyN,
        totalPrice: totalN,
        reason: reserveBtn
          ? `Reserve/Book button present${nightlyN ? ` ($${nightlyN}/night)` : ""}${totalN ? ` ($${totalN} total)` : ""}`
          : `Visible price${nightlyN ? ` $${nightlyN}/night` : ""}${totalN ? ` $${totalN} total` : ""}`,
      };
    }
    return {
      available: "unclear",
      nightlyPrice: null,
      totalPrice: null,
      reason: "Page didn't show a clear availability/price signal — possibly login wall or non-standard PM layout",
    };
  });
}

async function processPmUrlCheck(id, params) {
  const { url, checkIn, checkOut } = params;
  log(`pm_url_check ${id}: ${url} ${checkIn}→${checkOut}`);
  await ensureBrowser();
  const result = await scrapePmUrl(page, url, checkIn, checkOut);
  await dumpPageState("pm", { id, ...params });
  log(`pm_url_check ${id}: available=${result.available} price=${result.nightlyPrice}/n`);
  await postResult(id, result);
}

// ─────────────────────── PM URL availability check (BATCH) ─────────
// Open one fresh tab per URL, scrape concurrently, close each. Total
// wall time ≈ slowest single check, not sum. Capped at 5 to keep
// Chrome happy and to bound the per-request budget.
async function processPmUrlCheckBatch(id, params) {
  const { urls, checkIn, checkOut } = params;
  log(`pm_url_check_batch ${id}: ${urls.length} urls ${checkIn}→${checkOut}`);
  await ensureBrowser();
  const cap = Math.min(urls.length, 5);
  const slice = urls.slice(0, cap);
  const results = await Promise.all(
    slice.map(async (url) => {
      let tab = null;
      try {
        tab = await context.newPage();
        const r = await scrapePmUrl(tab, url, checkIn, checkOut);
        return { url, ...r };
      } catch (e) {
        return {
          url,
          available: "unclear",
          nightlyPrice: null,
          totalPrice: null,
          reason: `tab error: ${e?.message ?? String(e)}`.slice(0, 200),
        };
      } finally {
        if (tab) {
          try { await tab.close(); } catch {}
        }
      }
    }),
  );
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

  switch (opType) {
    case "vrbo_search": return processVrboSearch(req.id, params);
    case "booking_search": return processBookingSearch(req.id, params);
    case "google_serp": return processGoogleSerp(req.id, params);
    case "pm_url_check": return processPmUrlCheck(req.id, params);
    case "pm_url_check_batch": return processPmUrlCheckBatch(req.id, params);
    default: throw new Error(`unknown opType: ${opType}`);
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
    // After a busy tick, only wait POLL_BUSY_MS (default 5s) before
    // polling again — find-buy-in often fires several requests in
    // close succession (e.g. pre-verifying 3-6 PM URLs) and the
    // operator's wallet budget can't absorb 60s × N idle waits.
    // After an idle tick (queue empty), wait the full POLL_IDLE_MS
    // (60s) so we don't pound the server.
    await new Promise((r) => setTimeout(r, wasBusy ? POLL_BUSY_MS : POLL_IDLE_MS));
  }
}

main().catch((e) => {
  log(`fatal: ${e.message ?? String(e)}`);
  process.exit(1);
});
