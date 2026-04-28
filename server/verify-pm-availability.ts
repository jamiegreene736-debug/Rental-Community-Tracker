// Lightweight per-row availability verification, called on-demand
// from the find-buy-in dialog's live-search candidate table.
//
// Goal: when an operator is considering a candidate row (especially
// an Airbnb-anchored photo-match where availability is *anchored*
// not *verified* at the PM end), give them a one-click "is this
// actually bookable for my dates?" confirmation BEFORE they record
// the buy-in.
//
// Cost target: ~$0.01 per click. Achieved by:
//   - Browserbase session opens with `proxies: true` (~$0.005)
//   - Stagehand DOM-mode `extract()` with Haiku 4.5 (~$0.005)
//   - No agent loop, no screenshot iteration — just navigate, settle,
//     extract a Zod-typed answer, close.
//
// Compared to the heavier `pm-rate-agent.ts` / `verifyPmRate` flow
// (Sonnet CUA, ~$0.10–0.30/call), this is ~10–30× cheaper. Tradeoff:
// less robust on PMs whose date pickers refuse our query-string
// pre-fills — those return "unclear" and the operator falls back to
// clicking Open. That's acceptable for an opt-in per-row check.

import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { scrapeVrboRate } from "./pm-scraper-vrbo";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";

// Stagehand 3.x requires the `provider/model` slash-prefixed identifier
// from its AVAILABLE_CUA_MODELS list; the bare model name throws
// "Unsupported model" and silently turns every per-row verify into
// `available: "unclear"`. See stagehand-vrbo-search.ts for the deeper
// note.
const VERIFIER_MODEL = "anthropic/claude-haiku-4-5-20251001";
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_DELAY_MS = 3_500;
const TOTAL_WALL_BUDGET_MS = 60_000;

export type VerifyAvailabilityResult = {
  available: "yes" | "no" | "unclear";
  nightlyPriceUsd: number | null;
  reason: string;
  finalUrl: string;
  ms: number;
};

const ResultSchema = z.object({
  available: z
    .enum(["yes", "no", "unclear"])
    .describe(
      "yes if the page clearly shows the unit can be booked for the requested check-in/check-out dates (a price is quoted, a Reserve/Book button is enabled, no 'unavailable' or 'sold out' message). no if the page clearly says the dates are unavailable / booked / not bookable / minimum-stay violation. unclear if the page is the homepage / search results / login wall / didn't load / dates aren't pre-filled.",
    ),
  nightlyPriceUsd: z
    .number()
    .nullable()
    .describe("If a per-night USD rate is visible on the page for these dates, return it. Otherwise null."),
  reason: z
    .string()
    .describe("One-sentence justification grounded in what's visible on the page."),
});

// In-process cache keyed by url+dates. Same window of a single
// operator session shouldn't fire repeated $0.01 verifies on the
// same row.
const cache = new Map<string, { value: VerifyAvailabilityResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function isVrboUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.)?vrbo\.com\//i.test(url);
}

function isBookingUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.)?booking\.com\//i.test(url);
}

// Force Booking.com URL to carry checkin/checkout query params. Booking
// renders a different page when dates are absent (the "Reserve" CTA
// without dates), and the operator's window-specific availability check
// only works when those params are present. We respect existing values
// if the URL already has them — operator-pasted URLs sometimes carry
// useful tracking params that shouldn't be clobbered.
function ensureBookingDates(url: string, checkIn: string, checkOut: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("checkin")) u.searchParams.set("checkin", checkIn);
    if (!u.searchParams.has("checkout")) u.searchParams.set("checkout", checkOut);
    if (!u.searchParams.has("group_adults")) u.searchParams.set("group_adults", "2");
    return u.toString();
  } catch {
    return url;
  }
}

// Booking.com-specific deterministic verifier. The Stagehand+Haiku path
// returned "unclear" on most Booking pages because the unavailability
// banner ("We have no availability here between ..." in a red error
// box) sits in the Availability section BELOW the property highlights —
// Stagehand's default extract reads the visible viewport and missed it.
//
// This scraper opens the URL, waits for hydration, scrolls past the
// fold, then reads the visible text for the banner copy. No LLM —
// the banner is a deterministic Booking.com string, not a layout we
// have to interpret. Same Browserbase residential-IP cost as the Vrbo
// scraper (~$0.005/session). Each URL opens its own session so a
// batch can fan them out in parallel.
//
// Returns:
//   "no"      — clear unavailability banner present.
//   "yes"     — Reserve / room-table prices visible (page is in a
//               bookable state for these dates). Optionally extracts
//               the lowest visible per-night rate from the rooms table.
//   "unclear" — neither signal found (login wall, CAPTCHA, location
//               redirect, etc).
async function verifyBookingViaScraper(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
}): Promise<VerifyAvailabilityResult> {
  const startedAt = Date.now();
  const finalUrl = ensureBookingDates(opts.url, opts.checkIn, opts.checkOut);
  const bb = new Browserbase({ apiKey: opts.bbApiKey });
  let session: Awaited<ReturnType<typeof bb.sessions.create>> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    session = await bb.sessions.create({
      projectId: opts.bbProjectId,
      proxies: true,
      browserSettings: { viewport: { width: 1280, height: 900 } },
    });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Booking is JS-heavy; wait for the property page chrome.
    await page.waitForTimeout(3500);
    // Scroll past the property highlights / amenities / overview into
    // the Availability section. ~2× viewport height covers the
    // standard Booking layout. Multiple scrolls so lazy-loaded blocks
    // mount even when the operator's session lands on a slow render.
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {});
    await page.waitForTimeout(1200);

    const result = await page.evaluate(() => {
      const fullText = (document.body?.innerText ?? "").toLowerCase();
      // Deterministic Booking.com no-availability banner copy. The exact
      // wording rotates ("We have no availability here between X and Y" /
      // "We're sorry, but there is no availability on our site for these
      // dates" / "No rooms available"); list every variant we've seen.
      const NO_PATTERNS = [
        /we have no availability here between/,
        /there (?:is|are) no availability/,
        /no availability for these dates/,
        /no rooms available/,
        /sold out for these dates/,
        /fully booked/,
        /unavailable for the dates you selected/,
      ];
      for (const re of NO_PATTERNS) {
        const m = re.exec(fullText);
        if (m) {
          // Grab a slice of context for the reason field.
          const idx = m.index;
          const context = (document.body?.innerText ?? "").slice(
            Math.max(0, idx - 20),
            idx + 140,
          );
          return {
            available: "no",
            reason: `Booking.com page banner: "${context.replace(/\s+/g, " ").trim()}"`,
            nightlyPrice: null as number | null,
          };
        }
      }
      // Positive signal: the rooms table or a Reserve / Select-room
      // affordance. Booking renders these only when the property is
      // bookable for the requested dates.
      const reserveSelectors = [
        '[data-testid="select-room-trigger"]',
        'button[name="book_this"]',
        '.hprt-reservation-cta',
        'a[data-component="atom/Button"][href*="book"]',
      ];
      const hasReserve = reserveSelectors.some((sel) => !!document.querySelector(sel));
      // Lowest visible per-night rate. Booking's room table cell carries
      // the price in `[data-testid="price-and-discounted-price"]` (recent
      // template) or `.bui-price-display__value` (older). Look at every
      // matching node, parse a "$X" number, take the minimum.
      const priceNodes = Array.from(
        document.querySelectorAll(
          '[data-testid="price-and-discounted-price"], .bui-price-display__value, .prco-valign-middle-helper',
        ),
      );
      let lowestPrice: number | null = null;
      for (const node of priceNodes) {
        const txt = node.textContent ?? "";
        const m = txt.match(/\$\s*([\d,]+)/);
        if (!m) continue;
        const n = parseInt(m[1].replace(/,/g, ""), 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        if (lowestPrice == null || n < lowestPrice) lowestPrice = n;
      }
      if (hasReserve || lowestPrice != null) {
        return {
          available: "yes" as const,
          reason: hasReserve
            ? `Booking.com page has Reserve / Select-room affordance${lowestPrice ? ` ($${lowestPrice} visible)` : ""}`
            : `Booking.com page shows priced rooms ($${lowestPrice} lowest visible)`,
          nightlyPrice: lowestPrice,
        };
      }
      return {
        available: "unclear" as const,
        reason: "Booking.com page didn't surface a clear availability banner OR a Reserve affordance — possibly a login/CAPTCHA wall",
        nightlyPrice: null,
      };
    });

    const out: VerifyAvailabilityResult = {
      available: result.available as "yes" | "no" | "unclear",
      nightlyPriceUsd: result.nightlyPrice,
      reason: result.reason,
      finalUrl: page.url(),
      ms: Date.now() - startedAt,
    };
    console.log(
      `[verify-availability:booking] ${opts.url} → available=${out.available} price=${out.nightlyPriceUsd} (${out.ms}ms)`,
    );
    return out;
  } catch (e: any) {
    console.error(`[verify-availability:booking] error for ${opts.url}:`, e?.message ?? e);
    return {
      available: "unclear",
      nightlyPriceUsd: null,
      reason: `booking scraper error: ${e?.message ?? "unknown"}`,
      finalUrl: opts.url,
      ms: Date.now() - startedAt,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (session) {
      await bb.sessions
        .update(session.id, { projectId: opts.bbProjectId, status: "REQUEST_RELEASE" })
        .catch(() => {});
    }
  }
}

// Vrbo-specific shortcut. The generic Haiku-on-screenshot extract
// can't reliably parse Vrbo's date-picker widget from a single
// screenshot — it returns "unclear" for most Vrbo URLs even when
// the unit is genuinely available or genuinely booked. The
// `scrapeVrboRate` path (Browserbase + Playwright + GraphQL
// response interception) is deterministic: it intercepts Vrbo's
// rate-calendar GraphQL response and reads availability + price
// directly from the response body. Same Browserbase cost as the
// Haiku path (~$0.005/session), but accuracy goes from ~10% to
// ~95% on Vrbo URLs specifically.
async function verifyVrboViaScraper(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
}): Promise<VerifyAvailabilityResult> {
  const startedAt = Date.now();
  try {
    const result = await scrapeVrboRate({
      url: opts.url,
      checkIn: opts.checkIn,
      checkOut: opts.checkOut,
      bbApiKey: opts.bbApiKey,
      bbProjectId: opts.bbProjectId,
    });
    const ex = result.extracted;
    if (!ex) {
      return {
        available: "unclear",
        nightlyPriceUsd: null,
        reason: result.reason || "vrbo scraper returned no extraction",
        finalUrl: result.finalUrl || opts.url,
        ms: Date.now() - startedAt,
      };
    }
    const available: "yes" | "no" | "unclear" =
      ex.available === true ? "yes" : ex.available === false ? "no" : "unclear";
    const out: VerifyAvailabilityResult = {
      available,
      nightlyPriceUsd:
        typeof ex.nightlyPrice === "number" && ex.nightlyPrice > 0
          ? Math.round(ex.nightlyPrice)
          : null,
      reason: ex.reason || result.reason || "vrbo scraper",
      finalUrl: result.finalUrl || opts.url,
      ms: Date.now() - startedAt,
    };
    console.log(
      `[verify-availability:vrbo] ${opts.url} → available=${out.available} price=${out.nightlyPriceUsd} (${out.ms}ms)`,
    );
    return out;
  } catch (e: any) {
    console.error(`[verify-availability:vrbo] error for ${opts.url}:`, e?.message ?? e);
    return {
      available: "unclear",
      nightlyPriceUsd: null,
      reason: `vrbo scraper error: ${e?.message ?? "unknown"}`,
      finalUrl: opts.url,
      ms: Date.now() - startedAt,
    };
  }
}

function newStagehand(opts: { bbApiKey: string; bbProjectId: string; anthropicKey: string }) {
  return new Stagehand({
    env: "BROWSERBASE",
    apiKey: opts.bbApiKey,
    projectId: opts.bbProjectId,
    browserbaseSessionCreateParams: {
      projectId: opts.bbProjectId,
      proxies: true,
      browserSettings: { viewport: { width: 1280, height: 800 } },
    },
    // Drop the explicit `provider` field — Stagehand parses the slash
    // prefix off `modelName` and an explicit provider short-circuits
    // that parser back into the "Unsupported model" error path.
    model: { modelName: VERIFIER_MODEL, apiKey: opts.anthropicKey },
    verbose: 1,
  });
}

// Per-URL verify against an already-initialized Stagehand. Used by both
// the single-URL path (opens its own session) and the batch path (one
// session, many sequential navigates — saves the per-URL session cost).
async function verifyOneAgainst(
  stagehand: Stagehand,
  url: string,
  checkIn: string,
  checkOut: string,
): Promise<VerifyAvailabilityResult> {
  const startedAt = Date.now();
  try {
    const page = stagehand.context.pages()[0];
    await page.goto(url, { timeoutMs: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    // PM sites are JS-heavy; give the date-pre-fill / availability
    // calendar a chance to settle before extracting.
    await page.waitForTimeout(SETTLE_DELAY_MS);

    const extracted = await stagehand.extract(
      `You are checking a property-management vacation-rental page. The user wants to know whether THIS specific unit can be booked for check-in ${checkIn} and check-out ${checkOut}. Examine the page and report:
- available: yes (price is quoted + a working Book/Reserve button + no unavailable banner) / no (page clearly says these dates are unavailable, booked, or violate min-stay) / unclear (homepage, search results page, didn't load, dates not pre-filled).
- nightlyPriceUsd: the per-night USD rate if visible for these dates, else null.
- reason: one short sentence grounded in what's on the page.`,
      ResultSchema,
    );

    const result: VerifyAvailabilityResult = {
      available: extracted?.available ?? "unclear",
      nightlyPriceUsd:
        typeof extracted?.nightlyPriceUsd === "number" && extracted.nightlyPriceUsd > 0
          ? Math.round(extracted.nightlyPriceUsd)
          : null,
      reason: extracted?.reason ?? "extract returned empty",
      finalUrl: page.url(),
      ms: Date.now() - startedAt,
    };
    console.log(
      `[verify-availability] ${url} → available=${result.available} price=${result.nightlyPriceUsd} (${result.ms}ms)`,
    );
    return result;
  } catch (e: any) {
    console.error(`[verify-availability] error for ${url}:`, e?.message ?? e);
    return {
      available: "unclear",
      nightlyPriceUsd: null,
      reason: `verifier error: ${e?.message ?? "unknown"}`,
      finalUrl: url,
      ms: Date.now() - startedAt,
    };
  }
}

export async function verifyPmAvailability(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
  anthropicKey: string;
}): Promise<VerifyAvailabilityResult> {
  const { url, checkIn, checkOut } = opts;

  const cacheKey = `${url}|${checkIn}|${checkOut}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[verify-availability] cache hit ${url}`);
    return cached.value;
  }

  let result: VerifyAvailabilityResult;
  if (isVrboUrl(url)) {
    // Vrbo-specific shortcut — deterministic, much higher accuracy than Haiku.
    result = await verifyVrboViaScraper({
      url, checkIn, checkOut,
      bbApiKey: opts.bbApiKey, bbProjectId: opts.bbProjectId,
    });
  } else if (isBookingUrl(url)) {
    // Booking.com-specific shortcut — scrolls past the fold to read
    // the deterministic "no availability" banner. Higher accuracy than
    // the Stagehand+Haiku generic path which doesn't scroll.
    result = await verifyBookingViaScraper({
      url, checkIn, checkOut,
      bbApiKey: opts.bbApiKey, bbProjectId: opts.bbProjectId,
    });
  } else {
    const stagehand = newStagehand(opts);
    try {
      await stagehand.init();
      result = await verifyOneAgainst(stagehand, url, checkIn, checkOut);
    } finally {
      try {
        await stagehand.close();
      } catch (e: any) {
        console.warn(`[verify-availability] close failed:`, e?.message ?? e);
      }
    }
  }

  cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

export async function verifyPmAvailabilityBatch(opts: {
  urls: string[];
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
  anthropicKey: string;
  maxUrls?: number;
}): Promise<Record<string, VerifyAvailabilityResult>> {
  const { urls, checkIn, checkOut, maxUrls = 10 } = opts;
  const out: Record<string, VerifyAvailabilityResult> = {};

  // Cache hits never spend a session — peel them off first so a fully
  // cached batch is free.
  const toFetch: string[] = [];
  for (const url of urls.slice(0, maxUrls)) {
    const cacheKey = `${url}|${checkIn}|${checkOut}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      out[url] = cached.value;
    } else {
      toFetch.push(url);
    }
  }

  if (toFetch.length === 0) {
    console.log(`[verify-availability] batch fully cached (${urls.length} urls)`);
    return out;
  }

  // Split: Vrbo + Booking.com URLs go through deterministic per-URL
  // scrapers (each opens its own Browserbase session — runs all in
  // parallel since they don't share state). Other PM URLs go through
  // the single shared Stagehand session sequentially.
  const vrboUrls = toFetch.filter(isVrboUrl);
  const bookingUrls = toFetch.filter(isBookingUrl);
  const stagehandUrls = toFetch.filter((u) => !isVrboUrl(u) && !isBookingUrl(u));

  console.log(
    `[verify-availability] batch: ${urls.length} requested, ${urls.length - toFetch.length} cached, ${vrboUrls.length} vrbo + ${bookingUrls.length} booking (parallel scrapers), ${stagehandUrls.length} other-pm (single Stagehand session)`,
  );

  // Vrbo + Booking paths — fire all in parallel. Both use deterministic
  // scrapers (no LLM) so concurrent Browserbase sessions are cheap.
  const deterministicTasks: Array<Promise<{ url: string; result: VerifyAvailabilityResult }>> = [];
  for (const url of vrboUrls) {
    deterministicTasks.push(
      verifyVrboViaScraper({
        url,
        checkIn,
        checkOut,
        bbApiKey: opts.bbApiKey,
        bbProjectId: opts.bbProjectId,
      }).then((result) => ({ url, result })),
    );
  }
  for (const url of bookingUrls) {
    deterministicTasks.push(
      verifyBookingViaScraper({
        url,
        checkIn,
        checkOut,
        bbApiKey: opts.bbApiKey,
        bbProjectId: opts.bbProjectId,
      }).then((result) => ({ url, result })),
    );
  }
  if (deterministicTasks.length > 0) {
    const settled = await Promise.all(deterministicTasks);
    for (const { url, result } of settled) {
      out[url] = result;
      cache.set(`${url}|${checkIn}|${checkOut}`, {
        value: result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
  }

  // Non-Vrbo path — single Stagehand session, sequential navigates.
  if (stagehandUrls.length > 0) {
    const stagehand = newStagehand(opts);
    const batchStartedAt = Date.now();
    try {
      await stagehand.init();
      for (const url of stagehandUrls) {
        // Hard wall budget across the whole batch — if we're past it,
        // mark remaining URLs as unclear/timeout rather than hanging.
        if (
          Date.now() - batchStartedAt >
          TOTAL_WALL_BUDGET_MS * Math.min(stagehandUrls.length, 6)
        ) {
          console.warn(`[verify-availability] batch wall budget exceeded; remaining urls return unclear`);
          for (const remaining of stagehandUrls.slice(stagehandUrls.indexOf(url))) {
            out[remaining] = {
              available: "unclear",
              nightlyPriceUsd: null,
              reason: "batch wall budget exceeded before this URL was checked",
              finalUrl: remaining,
              ms: 0,
            };
          }
          break;
        }
        const result = await verifyOneAgainst(stagehand, url, checkIn, checkOut);
        out[url] = result;
        cache.set(`${url}|${checkIn}|${checkOut}`, {
          value: result,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
      }
    } finally {
      try {
        await stagehand.close();
      } catch (e: any) {
        console.warn(`[verify-availability] batch close failed:`, e?.message ?? e);
      }
    }
  }

  return out;
}
