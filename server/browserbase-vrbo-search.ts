// Vrbo destination search via Browserbase — independent of Apify.
//
// Third path for sourcing priced Vrbo candidates, alongside:
//   - Apify (`apify-vrbo.ts`) — paid actor, depends on regionId resolution
//   - Google site:search — free, returns unpriced URLs
//
// This module drives a real Browserbase Chrome session through Vrbo's
// search UI:
//   1. Navigate to https://www.vrbo.com/search?destination=<X>&d1=<Y>&d2=<Z>
//   2. Wait for the property cards to render (Vrbo's frontend resolves
//      autocomplete + dispatches the actual search XHRs on its own)
//   3. Capture the GraphQL response that has the result list (`PropertySearch`
//      / `LodgingSearch` family of ops)
//   4. Parse property cards: detail URL, name, lead price, total, rooms
//
// Why this is worth it:
//   - Vrbo's frontend handles destination autocomplete for us — no
//     regionId hardcoding needed. "Poipu Kai" → city auto-resolved.
//   - Vrbo's frontend also computes the all-in trip total when dates
//     are present in the URL — we can read it from the GraphQL
//     responses or the rendered card.
//   - Doesn't depend on Apify actors (which keep returning 0 for our
//     queries due to regionId issues).
//
// Cost: ~$0.005 per Browserbase session, ~10-25s per call. Cached 5 min
// in-process. Auto-fill won't fire this on every find-buy-in call —
// it runs alongside the Apify + Google paths in parallel, and any of
// the three returning priced results is enough.
//
// Anti-bot: Vrbo's homepage / search page is more aggressive than the
// individual unit pages we already scrape via Browserbase elsewhere.
// We use Browserbase's residential proxy network and standard headers
// to look like a normal user.

import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";

const PAGE_TIMEOUT_MS = 30_000;
const RESULTS_WAIT_MS = 25_000;

export type BrowserbaseVrboCandidate = {
  url: string;
  title: string;
  totalPrice: number;       // USD all-in for the requested dates
  nightlyPrice: number;     // USD per night
  bedrooms: number | undefined;
  image: string | undefined;
  snippet: string;
};

type CacheEntry = { value: BrowserbaseVrboCandidate[]; expiresAt: number };
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Pull a Vrbo URL from the property card data. Vrbo property URLs are
// either `/<id>` or `/<slug>?...`. We accept both.
function extractListingUrl(card: any): string | null {
  // Common shapes in Vrbo's GraphQL responses for property cards.
  const candidates = [
    card?.cardLink?.resource?.value,
    card?.cardLink?.value,
    card?.detailPageUrl,
    card?.url,
    card?.listingUrl,
    card?.propertyUrl,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      // Some are relative URLs like `/3203749`. Resolve to absolute.
      if (/^\/\d/.test(c)) return `https://www.vrbo.com${c.split("?")[0]}`;
      if (/vrbo\.com\/\d/.test(c)) {
        // Strip query string — operator can re-attach dates later.
        return c.split("?")[0].replace(/^http:/, "https:");
      }
    }
  }
  return null;
}

// Try multiple field shapes for "all-in trip total". Returns the integer
// dollar amount or 0 when absent.
function extractTotal(card: any): number {
  const shapes = [
    card?.priceLockup?.priceContent?.priceSummary?.formatted,
    card?.priceLockup?.priceSummary?.formatted,
    card?.tripTotal?.formatted,
    card?.totalPrice?.formatted,
    card?.priceSummary?.formatted,
    card?.formattedTotal,
    card?.tripTotalString,
  ];
  for (const s of shapes) {
    if (typeof s === "string") {
      const m = s.match(/\$\s*([\d,]+(?:\.\d+)?)/);
      if (m) return parseFloat(m[1].replace(/,/g, ""));
    }
  }
  // Numeric structured fields
  const nums = [
    card?.tripTotal?.amount,
    card?.totalPrice?.amount,
    card?.priceLockup?.priceContent?.priceSummary?.amount,
    card?.priceSummary?.totalAmount,
  ];
  for (const n of nums) {
    if (typeof n === "number" && n > 0) return n;
  }
  return 0;
}

function extractNightly(card: any, total: number, nights: number): number {
  const n = Math.max(1, nights);
  const direct = card?.priceLockup?.formattedPrice ?? card?.pricePerNight ?? card?.leadPrice;
  if (typeof direct === "string") {
    const m = direct.match(/\$\s*([\d,]+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1].replace(/,/g, ""));
  }
  if (typeof direct === "number" && direct > 0) return direct;
  return total > 0 ? Math.round(total / n) : 0;
}

function extractTitle(card: any): string {
  return String(
    card?.headline ??
    card?.title ??
    card?.name ??
    card?.propertyName ??
    "Vrbo listing",
  ).slice(0, 120);
}

function extractBedrooms(card: any): number | undefined {
  const direct = card?.bedrooms ?? card?.beds ?? card?.numBedrooms;
  if (typeof direct === "number") return direct;
  // Sometimes bedroom count is in a string like "House · 4 BR · 3 BA".
  const subtitle = card?.propertyType ?? card?.subtitle ?? card?.headline ?? "";
  const m = String(subtitle).match(/(\d+)\s*BR\b/i);
  if (m) return parseInt(m[1], 10);
  return undefined;
}

function extractImage(card: any): string | undefined {
  const candidates = [
    card?.image?.url,
    card?.images?.[0]?.url,
    card?.images?.[0],
    card?.heroImage?.url,
    card?.thumbnailUrl,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
  }
  return undefined;
}

export async function searchVrboViaBrowserbase(opts: {
  resortName: string;
  destination: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
  /** Cap on results returned. Default 12. */
  limit?: number;
}): Promise<BrowserbaseVrboCandidate[]> {
  const {
    resortName, destination, bedrooms, checkIn, checkOut,
    bbApiKey, bbProjectId,
  } = opts;
  const limit = opts.limit ?? 12;

  const cacheKey = `bb|${destination}|${bedrooms}|${checkIn}|${checkOut}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const nights = Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T12:00:00").getTime() -
        new Date(checkIn + "T12:00:00").getTime()) / 86400000,
    ),
  );

  const resortTokens = normalize(resortName).split(" ").filter((t) => t.length >= 3);
  const matchesResort = (haystack: string): boolean => {
    if (resortTokens.length === 0) return true;
    const n = normalize(haystack);
    return resortTokens.every((t) => n.includes(t));
  };

  const params = new URLSearchParams({
    destination,
    d1: checkIn,
    startDate: checkIn,
    d2: checkOut,
    endDate: checkOut,
    flexibility: "0_DAY",
    adults: "2",
    isInvalidatedDate: "false",
    sort: "RECOMMENDED",
  });
  const searchUrl = `https://www.vrbo.com/search?${params.toString()}`;

  const bb = new Browserbase({ apiKey: bbApiKey });
  const session = await bb.sessions.create({ projectId: bbProjectId, proxies: true });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  const startedAt = Date.now();

  // Capture GraphQL response bodies — Vrbo's search results live in
  // one of `PropertySearch` / `LodgingSearch` / `getAllPropertyResults`
  // ops. We don't know the exact name, so we collect every Vrbo
  // graphql body and hunt for property cards by structure.
  const graphqlBodies: string[] = [];
  let resultsBody: string | null = null;

  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());

    await ctx.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await ctx.addCookies([
      { name: "set_pi_session_currency", value: "USD", domain: ".vrbo.com", path: "/" },
      { name: "preferred_currency", value: "USD", domain: ".vrbo.com", path: "/" },
    ]);

    page.on("response", async (resp) => {
      const u = resp.url();
      if (!u.includes("vrbo.com/graphql")) return;
      const ct = resp.headers()["content-type"] || "";
      if (!/json/i.test(ct)) return;
      const body = await resp.text().catch(() => "");
      if (graphqlBodies.length < 60) graphqlBodies.push(body);
      // Heuristic: results body has many "$X" amounts and "/<id>" detail paths.
      // We pick the body with the most property-card-shaped entries.
      if (
        /propertySearch|lodgingSearch|searchResults|"results"\s*:\s*\[/.test(body) &&
        /\$/.test(body)
      ) {
        resultsBody = body;
      }
    });

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });

    // Wait for search results to populate. Vrbo's results are JS-rendered
    // — give them a window to load.
    const waitStart = Date.now();
    while (!resultsBody && Date.now() - waitStart < RESULTS_WAIT_MS) {
      await page.waitForTimeout(500);
    }

    // Even if no specific results body matched our heuristic, scan all
    // captured bodies for property cards as a fallback.
    const cards: any[] = [];
    const considered = resultsBody ? [resultsBody] : graphqlBodies;
    for (const body of considered) {
      try {
        const parsed = JSON.parse(body);
        // Recursively walk for arrays of objects that look like property cards
        // (have a URL-ish field + a price-ish field).
        const stack: any[] = [parsed];
        while (stack.length) {
          const node = stack.pop();
          if (!node) continue;
          if (Array.isArray(node)) {
            // Array — if it looks like cards, capture it
            const sample = node[0];
            if (
              sample && typeof sample === "object" &&
              (extractListingUrl(sample) || extractTotal(sample) > 0)
            ) {
              cards.push(...node);
            } else {
              for (const item of node) stack.push(item);
            }
          } else if (typeof node === "object") {
            for (const k of Object.keys(node)) stack.push((node as any)[k]);
          }
        }
        if (cards.length > 0) break; // found in this body
      } catch { /* not parseable JSON, skip */ }
    }

    // De-dupe cards by listing URL — the recursive walk picks up the
    // same card via multiple paths.
    const seen = new Set<string>();
    const unique: any[] = [];
    for (const card of cards) {
      const u = extractListingUrl(card);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      unique.push(card);
    }

    const candidates: BrowserbaseVrboCandidate[] = [];
    let droppedNoResort = 0;
    let droppedWrongBedrooms = 0;
    let droppedNoPrice = 0;
    for (const card of unique) {
      const url = extractListingUrl(card);
      if (!url) continue;
      const title = extractTitle(card);
      const itemBeds = extractBedrooms(card);
      const total = extractTotal(card);

      const haystack = `${title} ${card?.location?.description ?? ""} ${card?.propertyType ?? card?.subtitle ?? ""}`;
      if (!matchesResort(haystack)) {
        droppedNoResort++;
        continue;
      }
      if (typeof itemBeds === "number" && itemBeds < bedrooms) {
        droppedWrongBedrooms++;
        continue;
      }
      if (!(total > 0)) {
        droppedNoPrice++;
        continue;
      }
      candidates.push({
        url,
        title,
        totalPrice: Math.round(total),
        nightlyPrice: extractNightly(card, total, nights),
        bedrooms: itemBeds,
        image: extractImage(card),
        snippet: String(card?.location?.description ?? card?.subtitle ?? "").slice(0, 160),
      });
    }
    candidates.sort((a, b) => a.totalPrice - b.totalPrice);
    const out = candidates.slice(0, limit);

    console.log(
      `[bb-vrbo] destination="${destination}" ${bedrooms}BR ${checkIn}→${checkOut}: ` +
      `${unique.length} unique cards, ${out.length} after filter ` +
      `(dropped: noResort=${droppedNoResort} wrongBeds=${droppedWrongBedrooms} noPrice=${droppedNoPrice}) ` +
      `· ${Date.now() - startedAt}ms · ${graphqlBodies.length} graphql bodies`,
    );

    searchCache.set(cacheKey, { value: out, expiresAt: Date.now() + CACHE_TTL_MS });
    return out;
  } catch (e: any) {
    console.warn(`[bb-vrbo] error: ${e?.message ?? e}`);
    searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
    await bb.sessions.update(session.id, { projectId: bbProjectId, status: "REQUEST_RELEASE" }).catch(() => {});
  }
}
