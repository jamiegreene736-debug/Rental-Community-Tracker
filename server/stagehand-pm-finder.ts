// PM finder via Stagehand — escalation path for the find-buy-in flow.
//
// When the cheap structured paths (Airbnb anchor + photo-match, Vrbo
// 8 ways, Booking, Google PM site:search, direct PM scrapers) return
// few or zero priced candidates for a destination/window, fall back
// to a Stagehand agent that drives Google like a human would:
//
//   1. Type a query: `"<resort>" vacation rental property management
//      book directly`.
//   2. Let the SERP render.
//   3. Read the top organic results, filter out OTAs / aggregators
//      (same OTA filter the photo-match path uses).
//   4. Return PM domain URLs as unpriced PM candidates.
//
// Why an agent instead of just hitting SearchAPI for Google? We
// already do that (`pm` source via `siteSearch`). The agent does two
// things SearchAPI cannot:
//   - It can dismiss interstitial overlays (cookie banners,
//     "before you continue" prompts) that occasionally block the
//     first SERP load on residential proxies.
//   - It can scroll past the People-Also-Ask block and "Maps for"
//     panels to find the long tail of organic PM results.
//
// Result shape matches `Array<{ url; title; domain }>` so the caller
// can map directly into the existing PM `Candidate` shape (no price,
// just a click-through link).
//
// Env required:
//   BROWSERBASE_API_KEY     — session host
//   BROWSERBASE_PROJECT_ID  — project the session lives under
//   ANTHROPIC_API_KEY       — drives the agent + extract
//
// Cost: ~$0.20-0.40 per call (typically simpler than the Vrbo flow
// because Google SERPs are static once loaded). Cached 5 min.

import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

export type PmFinderResult = {
  url: string;
  title: string;
  domain: string;
};

type CacheEntry = { value: PmFinderResult[]; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const AGENT_MODEL = "claude-sonnet-4-5";
const TOTAL_WALL_BUDGET_MS = 120_000;

// Same domain blacklist used by the Airbnb→Lens photo-match path.
// Keep these in sync; if PR #228's rationale changes, both sites
// need updating. Inlined here (rather than imported) to keep this
// module standalone.
const OTA_DOMAIN_FILTER = /(?:^|\.)(?:airbnb\.[a-z.]+|vrbo\.com|homeaway\.[a-z.]+|booking\.com|tripadvisor\.com|expedia\.[a-z.]+|hotels\.com|kayak\.com|trivago\.com|priceline\.com|orbitz\.com|travelocity\.com|hotwire\.com|agoda\.com|google\.com|youtube\.com|facebook\.com|instagram\.com|pinterest\.com|to-hawaii\.com|hawaii-aloha\.com|vacationrentals\.com|flipkey\.com|holidaylettings\.com|tripping\.com|realtor\.com|zillow\.com|redfin\.com|coldwellbanker\.com|century21\.com|compass\.com|sothebysrealty\.com|sothebys\.com|hawaiilife\.com|pscondos\.com|hotpads\.com|homes\.com|realtytrac\.com|trulia\.com|movoto\.com|mls\.com|loopnet\.com|apartments\.com)$/i;

const SerpResultsSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().describe("absolute URL of the organic result"),
      title: z.string().describe("the result title"),
    }),
  ),
});

function safeDomain(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function findPmsViaStagehand(opts: {
  resortName: string | null;
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  bbApiKey: string;
  bbProjectId: string;
  anthropicKey: string;
}): Promise<PmFinderResult[]> {
  const { resortName, destination, checkIn, checkOut, bedrooms, bbApiKey, bbProjectId, anthropicKey } = opts;
  const target = resortName ?? destination;

  const cacheKey = `${target}|${bedrooms}|${checkIn}|${checkOut}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[pm-finder] cache hit for ${cacheKey}`);
    return cached.value;
  }

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: bbApiKey,
    projectId: bbProjectId,
    browserbaseSessionCreateParams: {
      projectId: bbProjectId,
      proxies: true,
      browserSettings: { viewport: { width: 1280, height: 800 } },
    },
    model: { provider: "anthropic", modelName: AGENT_MODEL, apiKey: anthropicKey },
    verbose: 1,
  });

  let out: PmFinderResult[] = [];
  const startedAt = Date.now();

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];

    const query = `"${target}" ${bedrooms} bedroom vacation rental property management book directly`;
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=30`;

    await page.goto(url, { timeoutMs: 30_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // Use the agent only to dismiss interstitials + scroll the SERP.
    // The actual data extraction is a one-shot Zod call — agents are
    // bad at structured extraction, schemas are good at it.
    const agent = stagehand.agent({
      systemPrompt: [
        "You are on a Google search results page. Your only job is to make sure organic results are visible.",
        "1. If a 'Before you continue' / cookie / consent overlay is present, click 'Accept all' or 'Reject all' to dismiss it.",
        "2. If a sign-in modal is present, dismiss it.",
        "3. Scroll down once to load the long tail of organic results past any 'People also ask' block.",
        "4. STOP. Do not click into any result. Do not navigate away from the SERP.",
      ].join("\n"),
    });

    const wallRemaining = Math.max(15_000, TOTAL_WALL_BUDGET_MS - (Date.now() - startedAt));
    const abort = new AbortController();
    const timeoutHandle = setTimeout(() => abort.abort(), wallRemaining);

    try {
      const result = await agent.execute({
        instruction: "Dismiss any consent or sign-in overlay, then scroll once to reveal more organic results. Stop on the SERP.",
        maxSteps: 6,
        signal: abort.signal,
      });
      console.log(`[pm-finder] agent done success=${result.success} actions=${result.actions.length}`);
    } catch (e: any) {
      console.warn(`[pm-finder] agent failed (continuing to extract):`, e?.message ?? e);
    } finally {
      clearTimeout(timeoutHandle);
    }

    await page.waitForTimeout(1000);

    const extracted = await stagehand.extract(
      "Extract every organic search result on this Google SERP. For each, return the absolute URL and the title. Skip ads, the 'People also ask' block, the Maps panel, video carousels, and 'Top stories'. Return the long tail of organic results — at least 10 if visible.",
      SerpResultsSchema,
    );

    const seenDomains = new Set<string>();
    for (const r of extracted?.results ?? []) {
      const url = (r.url || "").trim();
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const domain = safeDomain(url);
      if (!domain) continue;
      if (OTA_DOMAIN_FILTER.test(domain)) continue;
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      out.push({
        url,
        title: (r.title || domain).slice(0, 80),
        domain,
      });
      if (out.length >= 12) break;
    }

    console.log(`[pm-finder] extracted ${out.length} non-OTA PM candidates`);
  } catch (e: any) {
    console.error(`[pm-finder] error:`, e?.message ?? e);
    out = [];
  } finally {
    try {
      await stagehand.close();
    } catch (e: any) {
      console.warn(`[pm-finder] close failed:`, e?.message ?? e);
    }
  }

  cache.set(cacheKey, { value: out, expiresAt: Date.now() + CACHE_TTL_MS });
  return out;
}
