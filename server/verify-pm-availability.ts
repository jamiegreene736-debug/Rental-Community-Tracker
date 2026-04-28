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

const VERIFIER_MODEL = "claude-haiku-4-5-20251001";
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
    model: { provider: "anthropic", modelName: VERIFIER_MODEL, apiKey: opts.anthropicKey },
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

  // Split: Vrbo URLs go through the deterministic GraphQL-intercept
  // scraper (each opens its own Browserbase session — runs all in
  // parallel since they don't share state). Non-Vrbo URLs go through
  // the single shared Stagehand session sequentially.
  const vrboUrls = toFetch.filter(isVrboUrl);
  const stagehandUrls = toFetch.filter((u) => !isVrboUrl(u));

  console.log(
    `[verify-availability] batch: ${urls.length} requested, ${urls.length - toFetch.length} cached, ${vrboUrls.length} vrbo (parallel scraper), ${stagehandUrls.length} non-vrbo (single Stagehand session)`,
  );

  // Vrbo path — fire all in parallel.
  if (vrboUrls.length > 0) {
    const vrboResults = await Promise.all(
      vrboUrls.map((url) =>
        verifyVrboViaScraper({
          url,
          checkIn,
          checkOut,
          bbApiKey: opts.bbApiKey,
          bbProjectId: opts.bbProjectId,
        }).then((result) => ({ url, result })),
      ),
    );
    for (const { url, result } of vrboResults) {
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
