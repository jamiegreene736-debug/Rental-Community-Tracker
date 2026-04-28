// Vrbo search via Stagehand (Browserbase's managed agent framework).
//
// 8th Vrbo sourcing path. Where the other 7 paths each fight Vrbo's
// anti-bot in their own way (raw Browserbase + Playwright, ScrapingBee,
// Apify actors, Outscraper, Trivago meta, Apify generic web-scraper,
// Google site:search), this one delegates the whole flow — type
// destination, click autocomplete, pick dates, click Search, read
// property cards — to Stagehand's agent loop.
//
// Why Stagehand and not roll-our-own:
//   - Stagehand is what director.ai uses to drive Vrbo successfully.
//   - It handles the screenshot/action/observe loop, DOM grounding,
//     stale-element retries, and tool-call orchestration internally.
//     We just hand it a goal.
//   - Pairs the agent (for the messy UI flow) with `extract()` (a
//     one-shot structured-data pull) — agents are the right primitive
//     for navigating the UI, schemas are the right primitive for
//     reading the result rows. Don't make the agent do both.
//
// Env required:
//   BROWSERBASE_API_KEY     — session host
//   BROWSERBASE_PROJECT_ID  — project the session lives under
//   ANTHROPIC_API_KEY       — drives the agent + extract
//
// Cost: ~$0.20-0.50 per call (agent token usage dominates), ~60-120s
// wall time. Cached 5 min in-process to keep repeated find-buy-in
// calls for the same window cheap.

import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

export type StagehandVrboCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms: number | undefined;
  image: string | undefined;
  snippet: string;
};

type CacheEntry = { value: StagehandVrboCandidate[]; expiresAt: number };
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const AGENT_MODEL = "claude-sonnet-4-5";
// Hard wall budget. The agent can stall if Vrbo serves an unexpected
// modal (cookie banner, currency picker, login prompt) — bound the
// session so we don't burn $5 of tokens on a single find-buy-in.
const TOTAL_WALL_BUDGET_MS = 150_000;

const PropertyCardSchema = z.object({
  properties: z.array(
    z.object({
      title: z.string().describe("listing name"),
      url: z.string().describe("absolute URL to the property detail page on vrbo.com"),
      totalPrice: z
        .number()
        .nullable()
        .describe("all-in trip total in USD for the requested dates, before final tax line"),
      nightlyPrice: z
        .number()
        .nullable()
        .describe("per-night rate in USD if shown"),
      bedrooms: z.number().nullable().describe("bedroom count if shown"),
      image: z.string().nullable().describe("hero image URL if visible"),
    }),
  ),
});

export async function searchVrboViaStagehand(opts: {
  resortName: string | null;
  destination: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
  anthropicKey: string;
}): Promise<StagehandVrboCandidate[]> {
  const { destination, bedrooms, checkIn, checkOut, bbApiKey, bbProjectId, anthropicKey } = opts;

  const cacheKey = `${destination}|${bedrooms}|${checkIn}|${checkOut}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[vrbo-stagehand] cache hit for ${cacheKey}`);
    return cached.value;
  }

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: bbApiKey,
    projectId: bbProjectId,
    browserbaseSessionCreateParams: {
      projectId: bbProjectId,
      // Residential proxy is the proven CAPTCHA-free path for Vrbo
      // (see PR #177). Fingerprinting alone doesn't beat their bot
      // wall — the IP source is the load-bearing piece.
      proxies: true,
      browserSettings: { viewport: { width: 1280, height: 800 } },
    },
    model: { provider: "anthropic", modelName: AGENT_MODEL, apiKey: anthropicKey },
    verbose: 1,
  });

  let candidates: StagehandVrboCandidate[] = [];
  const startedAt = Date.now();

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];

    // Land on the homepage rather than constructing /search?destination=...
    // The agent has to drive the autocomplete + date picker anyway, and
    // homepage entry avoids a redirect chain that sometimes 403s.
    await page.goto("https://www.vrbo.com/", {
      timeoutMs: 30_000,
      waitUntil: "domcontentloaded",
    });

    // Try to dismiss currency / region modals that some IPs see on first
    // load. Best-effort — the agent can also handle these.
    await page.waitForTimeout(1500);

    const agent = stagehand.agent({
      systemPrompt: [
        "You are searching vrbo.com for vacation rentals. The browser is already on the Vrbo homepage.",
        "STEPS:",
        "1. Find the destination/where field and type the destination exactly as given.",
        "2. CRITICAL: After typing, click the first autocomplete suggestion that matches the destination. Do not press Enter — Vrbo only resolves a regionId if you click a suggestion.",
        "3. Open the dates field (check-in / check-out). Pick the requested check-in and check-out dates by clicking the calendar cells.",
        "4. Click the Search button.",
        "5. Wait for the search results page to load. STOP as soon as property cards are visible — do not scroll, do not click into any card, do not change filters.",
        "If you see a cookie banner, sign-in modal, or currency/region picker, dismiss it and continue.",
      ].join("\n"),
    });

    const wallRemaining = Math.max(15_000, TOTAL_WALL_BUDGET_MS - (Date.now() - startedAt));
    const abort = new AbortController();
    const timeoutHandle = setTimeout(() => abort.abort(), wallRemaining);

    const goal = [
      `Search vrbo.com for vacation rentals in ${destination}.`,
      `Check-in: ${checkIn}. Check-out: ${checkOut}.`,
      `Stop once the search results page is loaded and property cards are visible.`,
    ].join(" ");

    let result;
    try {
      result = await agent.execute({
        instruction: goal,
        maxSteps: 18,
        signal: abort.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    console.log(
      `[vrbo-stagehand] agent done success=${result.success} completed=${result.completed} actions=${result.actions.length}`,
    );

    if (!result.success || !result.completed) {
      console.warn(`[vrbo-stagehand] agent did not complete: ${result.message}`);
    }

    // Give Vrbo's results a beat to settle before extracting.
    await page.waitForTimeout(2_000);

    const extracted = await stagehand.extract(
      "Extract every visible vacation rental property card on this page. For each, get the listing title, the absolute URL of the property detail page, the all-in trip total in USD if shown (numeric — strip $ and commas), the nightly rate in USD if shown, the number of bedrooms if shown, and the hero image URL if visible. Skip ads and 'similar' rows.",
      PropertyCardSchema,
    );

    candidates = (extracted?.properties ?? [])
      .map((p): StagehandVrboCandidate | null => {
        const url = (p.url || "").trim();
        if (!url) return null;
        // Reject anything that isn't a Vrbo property detail page.
        if (!/^https?:\/\/(?:www\.)?vrbo\.com\//i.test(url)) return null;
        const title = (p.title || "").trim();
        if (!title) return null;
        const totalPrice = typeof p.totalPrice === "number" && p.totalPrice > 0 ? Math.round(p.totalPrice) : 0;
        const nightlyPrice = typeof p.nightlyPrice === "number" && p.nightlyPrice > 0 ? Math.round(p.nightlyPrice) : 0;
        // At least one of total or nightly must be present — unpriced
        // cards are useless for the cheapest pool.
        if (totalPrice <= 0 && nightlyPrice <= 0) return null;
        return {
          url,
          title,
          totalPrice,
          nightlyPrice,
          bedrooms: typeof p.bedrooms === "number" && p.bedrooms > 0 ? p.bedrooms : undefined,
          image: p.image && p.image.startsWith("http") ? p.image : undefined,
          snippet: "",
        };
      })
      .filter((c): c is StagehandVrboCandidate => c !== null);

    console.log(`[vrbo-stagehand] extracted ${candidates.length} priced cards from results page`);
  } catch (e: any) {
    console.error(`[vrbo-stagehand] error:`, e?.message ?? e);
    candidates = [];
  } finally {
    try {
      await stagehand.close();
    } catch (e: any) {
      console.warn(`[vrbo-stagehand] close failed:`, e?.message ?? e);
    }
  }

  searchCache.set(cacheKey, { value: candidates, expiresAt: Date.now() + CACHE_TTL_MS });
  return candidates;
}
