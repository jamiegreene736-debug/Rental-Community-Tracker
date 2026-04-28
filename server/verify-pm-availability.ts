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

export async function verifyPmAvailability(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
  anthropicKey: string;
}): Promise<VerifyAvailabilityResult> {
  const { url, checkIn, checkOut, bbApiKey, bbProjectId, anthropicKey } = opts;

  const cacheKey = `${url}|${checkIn}|${checkOut}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[verify-availability] cache hit ${url}`);
    return cached.value;
  }

  const startedAt = Date.now();
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: bbApiKey,
    projectId: bbProjectId,
    browserbaseSessionCreateParams: {
      projectId: bbProjectId,
      proxies: true,
      browserSettings: { viewport: { width: 1280, height: 800 } },
    },
    model: { provider: "anthropic", modelName: VERIFIER_MODEL, apiKey: anthropicKey },
    verbose: 1,
  });

  let result: VerifyAvailabilityResult;

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];

    const abort = new AbortController();
    const timeoutHandle = setTimeout(
      () => abort.abort(),
      Math.max(15_000, TOTAL_WALL_BUDGET_MS - (Date.now() - startedAt)),
    );

    try {
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

      result = {
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
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (e: any) {
    console.error(`[verify-availability] error for ${url}:`, e?.message ?? e);
    result = {
      available: "unclear",
      nightlyPriceUsd: null,
      reason: `verifier error: ${e?.message ?? "unknown"}`,
      finalUrl: url,
      ms: Date.now() - startedAt,
    };
  } finally {
    try {
      await stagehand.close();
    } catch (e: any) {
      console.warn(`[verify-availability] close failed:`, e?.message ?? e);
    }
  }

  cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
