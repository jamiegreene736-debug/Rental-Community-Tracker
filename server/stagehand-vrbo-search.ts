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

export type StagehandVrboDebug = {
  destination: string;
  checkIn: string;
  checkOut: string;
  agentSuccess: boolean;
  agentCompleted: boolean;
  agentMessage: string;
  agentActions: Array<{ tool?: string; arg?: string; status?: string }>;
  finalUrl: string;
  rawExtractedCount: number;
  rawExtractedProperties: Array<{ title?: string; url?: string; totalPrice?: number | null; nightlyPrice?: number | null; bedrooms?: number | null }>;
  acceptedCount: number;
  rejectedReasons: Record<string, number>;
  screenshotBase64: string | null;
  ms: number;
  errorMessage: string | null;
};

type CacheEntry = { value: StagehandVrboCandidate[]; expiresAt: number };
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Stagehand 3.x rejects the old `{ provider, modelName }` config and
// requires a `provider/model` slash-prefixed string from its
// AVAILABLE_CUA_MODELS list (see @browserbasehq/stagehand
// dist/.../agent.js). Bare "claude-sonnet-4-5" returned an
// "Unsupported model" error and silently emptied every Stagehand-driven
// search. The dated identifier is the canonical CUA model name.
const AGENT_MODEL = "anthropic/claude-sonnet-4-5-20250929";
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
  const out = await searchVrboViaStagehandWithDebug(opts);
  return out.candidates;
}

export async function searchVrboViaStagehandWithDebug(opts: {
  resortName: string | null;
  destination: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
  anthropicKey: string;
  // When true, skip the in-process cache so a forced re-run dumps fresh
  // diagnostics. find-buy-in's normal call leaves this false so repeat
  // hits within 5 min are free.
  bypassCache?: boolean;
}): Promise<{ candidates: StagehandVrboCandidate[]; debug: StagehandVrboDebug }> {
  const { destination, bedrooms, checkIn, checkOut, bbApiKey, bbProjectId, anthropicKey, bypassCache } = opts;

  const cacheKey = `${destination}|${bedrooms}|${checkIn}|${checkOut}`;
  if (!bypassCache) {
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[vrbo-stagehand] cache hit for ${cacheKey}`);
      return {
        candidates: cached.value,
        debug: {
          destination,
          checkIn,
          checkOut,
          agentSuccess: true,
          agentCompleted: true,
          agentMessage: "(cache hit)",
          agentActions: [],
          finalUrl: "(cache hit — no live page)",
          rawExtractedCount: cached.value.length,
          rawExtractedProperties: [],
          acceptedCount: cached.value.length,
          rejectedReasons: {},
          screenshotBase64: null,
          ms: 0,
          errorMessage: null,
        },
      };
    }
  }

  // If the operator has bootstrapped a Vrbo persistent context (via
  // POST /api/admin/vrbo/bootstrap-browserbase-context), attach it to
  // the session here. Vrbo's anti-bot recognizes the context as a
  // returning real user and lets the search through; without the
  // context the residential-proxy session hits the "Show us your
  // human side..." spin-and-block wall before vrbo.com renders.
  // (See diagnostic from PR #265 + screenshot at
  // /photos/debug/vrbo-stagehand-1777421048110.jpg.)
  const { resolveBrowserbaseContextId } = await import("./vrbo-session-cache");
  const persistentContextId = resolveBrowserbaseContextId();

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
      browserSettings: {
        viewport: { width: 1280, height: 800 },
        ...(persistentContextId
          ? { context: { id: persistentContextId, persist: true } }
          : {}),
        // Belt-and-suspenders: enable Browserbase's CAPTCHA solver in
        // case Vrbo escalates from passive fingerprint to an active
        // slider/press-and-hold challenge.
        solveCaptchas: true,
      },
    },
    // Drop the explicit `provider` field — Stagehand parses the slash
    // prefix off `modelName` and an explicit provider would short-circuit
    // that parsing and re-trigger the "Unsupported model" path.
    model: { modelName: AGENT_MODEL, apiKey: anthropicKey },
    verbose: 1,
  });

  let candidates: StagehandVrboCandidate[] = [];
  const startedAt = Date.now();
  const debug: StagehandVrboDebug = {
    destination,
    checkIn,
    checkOut,
    agentSuccess: false,
    agentCompleted: false,
    agentMessage: "",
    agentActions: [],
    finalUrl: "",
    rawExtractedCount: 0,
    rawExtractedProperties: [],
    acceptedCount: 0,
    rejectedReasons: {},
    screenshotBase64: null,
    ms: 0,
    errorMessage: null,
  };
  const reject = (reason: string) => {
    debug.rejectedReasons[reason] = (debug.rejectedReasons[reason] ?? 0) + 1;
  };

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

    const goal = [
      `Search vrbo.com for vacation rentals in ${destination}.`,
      `Check-in: ${checkIn}. Check-out: ${checkOut}.`,
      `Stop once the search results page is loaded and property cards are visible.`,
    ].join(" ");

    // Stagehand 3.x marks `signal: AbortSignal` on agent.execute() as an
    // experimental flag and rejects it unless the constructor opts into
    // experimental + disableAPI. Drop the signal and enforce the wall
    // budget via Promise.race instead — same effect at the find-buy-in
    // level (the rejected timeout propagates to the existing catch),
    // and the Stagehand session is still cleaned up by the outer finally
    // that calls stagehand.close().
    let result: Awaited<ReturnType<ReturnType<typeof stagehand.agent>["execute"]>>;
    try {
      result = await Promise.race([
        agent.execute({ instruction: goal, maxSteps: 18 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`stagehand-vrbo wall budget exceeded (${wallRemaining}ms)`)), wallRemaining),
        ),
      ]);
    } catch (e: any) {
      // Promote the timeout / agent error into the diagnostics path
      // rather than crashing the whole find-buy-in.
      debug.errorMessage = e?.message ?? String(e);
      console.error(`[vrbo-stagehand] agent.execute failed:`, debug.errorMessage);
      // Continue to the extraction step anyway — even a partial run
      // sometimes leaves the page on a usable state.
      result = { success: false, completed: false, message: debug.errorMessage, actions: [] } as any;
    }

    debug.agentSuccess = !!result.success;
    debug.agentCompleted = !!result.completed;
    debug.agentMessage = String(result.message ?? "");
    debug.agentActions = (result.actions ?? []).slice(0, 30).map((a: any) => ({
      tool: a?.action ?? a?.type ?? a?.tool ?? "?",
      arg: typeof a?.arguments === "string"
        ? a.arguments.slice(0, 120)
        : JSON.stringify(a?.arguments ?? a?.args ?? a?.value ?? "").slice(0, 120),
      status: a?.status ?? a?.outcome ?? undefined,
    }));

    console.log(
      `[vrbo-stagehand] agent done success=${result.success} completed=${result.completed} actions=${result.actions.length} message="${String(result.message ?? "").slice(0, 200)}"`,
    );

    if (!result.success || !result.completed) {
      console.warn(`[vrbo-stagehand] agent did not complete: ${result.message}`);
    }

    // Give Vrbo's results a beat to settle before extracting.
    await page.waitForTimeout(2_000);
    debug.finalUrl = page.url();

    // Capture a screenshot at the point we'd run extraction so we can
    // see what Stagehand was actually looking at — search results page,
    // unresolved autocomplete state, anti-bot wall, etc.
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      debug.screenshotBase64 = buf.toString("base64");
    } catch (e: any) {
      console.warn(`[vrbo-stagehand] screenshot capture failed:`, e?.message ?? e);
    }

    const extracted = await stagehand.extract(
      "Extract every visible vacation rental property card on this page. For each, get the listing title, the absolute URL of the property detail page, the all-in trip total in USD if shown (numeric — strip $ and commas), the nightly rate in USD if shown, the number of bedrooms if shown, and the hero image URL if visible. Skip ads and 'similar' rows.",
      PropertyCardSchema,
    );

    const rawProps = extracted?.properties ?? [];
    debug.rawExtractedCount = rawProps.length;
    debug.rawExtractedProperties = rawProps.slice(0, 12).map((p) => ({
      title: p.title,
      url: p.url,
      totalPrice: p.totalPrice,
      nightlyPrice: p.nightlyPrice,
      bedrooms: p.bedrooms,
    }));

    candidates = rawProps
      .map((p): StagehandVrboCandidate | null => {
        const url = (p.url || "").trim();
        if (!url) { reject("empty url"); return null; }
        if (!/^https?:\/\/(?:www\.)?vrbo\.com\//i.test(url)) { reject("non-vrbo url"); return null; }
        const title = (p.title || "").trim();
        if (!title) { reject("empty title"); return null; }
        const totalPrice = typeof p.totalPrice === "number" && p.totalPrice > 0 ? Math.round(p.totalPrice) : 0;
        const nightlyPrice = typeof p.nightlyPrice === "number" && p.nightlyPrice > 0 ? Math.round(p.nightlyPrice) : 0;
        if (totalPrice <= 0 && nightlyPrice <= 0) { reject("no priced fields"); return null; }
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

    debug.acceptedCount = candidates.length;

    console.log(
      `[vrbo-stagehand] finalUrl=${debug.finalUrl} extracted=${debug.rawExtractedCount} accepted=${candidates.length} rejected=${JSON.stringify(debug.rejectedReasons)}`,
    );
  } catch (e: any) {
    debug.errorMessage = e?.message ?? String(e);
    console.error(`[vrbo-stagehand] error:`, debug.errorMessage);
    candidates = [];
  } finally {
    try {
      await stagehand.close();
    } catch (e: any) {
      console.warn(`[vrbo-stagehand] close failed:`, e?.message ?? e);
    }
  }

  debug.ms = Date.now() - startedAt;
  if (!bypassCache) {
    searchCache.set(cacheKey, { value: candidates, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return { candidates, debug };
}
