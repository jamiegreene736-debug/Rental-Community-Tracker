// Suite Paradise rate scraper.
//
// Their public site uses RezCommerce (rcapi) under the hood — the
// orange "Search Availability" button on a unit page fires
// /rescms/ajax/item/pricing/simple with the unit's `eid` and the
// requested dates, and the response is a tiny JSON envelope
// containing rendered HTML with the total price.
//
// This module replicates that XHR server-side so we get rates in
// ~1s without driving a browser.
//
// Endpoint shape (confirmed via recon):
//
//   GET /rescms/ajax/item/pricing/simple
//     ?rcav[begin]=MM/DD/YYYY
//     &rcav[end]=MM/DD/YYYY
//     &rcav[adult]=2
//     &rcav[child]=0
//     &rcav[eid]=NNN          ← unit's RezCommerce entity id
//     &rcav[flex_type]=d
//
//   Headers: Accept: application/json, X-Requested-With: XMLHttpRequest,
//            Referer: <unit page URL>
//
//   Response 200:
//     Available:   {"status":1,"content":"<div class=\"rc-item-pricing\">...
//                   <span class=\"rc-price\">$2,291</span>...
//                   data-rc-ua-ecommerce-submit-addtocart=\"{...price:2291.48,...}\"...
//                   ..."}
//     Unavailable: {"status":1,"content":"<span class=\"rc-na\">Not Available</span>","reveals":""}
//
// The eid for a unit is embedded in the unit page HTML — `eid:156` and
// `item_id:156` for Regency 620. We fetch the page once and regex it
// out before hitting the pricing endpoint.

import type { AgentResult } from "./pm-rate-agent";

const PRICING_ENDPOINT = "https://www.suite-paradise.com/rescms/ajax/item/pricing/simple";

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
};

// Convert "2026-12-20" → "12/20/2026" (Suite Paradise's date format).
function toMdYY(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

// Pull the RezCommerce entity ID out of the unit page HTML. We've
// observed both `"eid":"156"` (JS config) and `eid:156` (inline)
// — match either.
function extractEid(html: string): number | null {
  // Most reliable: the JS config has `"eid":"156"` near `show_prices`.
  const cfgMatch = html.match(/"eid"\s*:\s*"(\d+)"/);
  if (cfgMatch) return parseInt(cfgMatch[1], 10);
  // Fallback: bare `eid:156` (without quotes, in JS object literal).
  const bareMatch = html.match(/(?:^|[^a-zA-Z0-9_])eid\s*:\s*"?(\d+)"?/);
  if (bareMatch) return parseInt(bareMatch[1], 10);
  return null;
}

// Parse the precise total price from the pricing response HTML.
// Prefers the float embedded in the add-to-cart data attribute (exact),
// falls back to the rendered "$X,XXX" span (rounded to dollars).
function parsePrice(content: string): { totalPrice: number; nightlyPrice: number | null } | null {
  if (!content) return null;
  // Unavailable path.
  if (/class=["'][^"']*\brc-na\b/.test(content)) return null;
  // Exact: data-rc-ua-ecommerce-submit-addtocart="{...&quot;price&quot;:2291.48,..."
  const exact = content.match(/&quot;price&quot;\s*:\s*([\d.]+)/);
  if (exact) {
    const total = parseFloat(exact[1]);
    if (isFinite(total) && total > 0) return { totalPrice: total, nightlyPrice: null };
  }
  // Approximate: rendered $-amount.
  const rendered = content.match(/class=["'][^"']*\brc-price\b[^>]*>\s*\$\s*([\d,]+(?:\.\d+)?)/);
  if (rendered) {
    const total = parseFloat(rendered[1].replace(/,/g, ""));
    if (isFinite(total) && total > 0) return { totalPrice: total, nightlyPrice: null };
  }
  return null;
}

export async function scrapeSuiteParadiseRate(opts: {
  url: string; // unit page URL, e.g. https://www.suite-paradise.com/poipu-vacation-rentals/regency-620
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
}): Promise<AgentResult & { manualOnly?: boolean }> {
  const { url, checkIn, checkOut } = opts;
  const nights = Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86400000,
    ),
  );

  // Step 1 — fetch the unit page HTML to extract the eid.
  let eid: number | null = null;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": COMMON_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const html = await r.text();
      eid = extractEid(html);
    }
  } catch (e: any) {
    console.warn(`[sp-scraper] page fetch error: ${e?.message ?? e}`);
  }

  if (!eid) {
    // Couldn't resolve eid — return unknown extraction so the caller
    // falls through to the agent or $0 attach.
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: null,
        totalPrice: null,
        nightlyPrice: null,
        dateMatch: null,
        reason: "Couldn't extract Suite Paradise unit eid from page HTML",
      },
      finalUrl: url,
      title: "Suite Paradise",
      screenshotBase64: "",
      iterations: 0,
      agentTrace: ["sp-scraper: eid not found in page HTML"],
    };
  }

  // Step 2 — hit the pricing endpoint.
  const params = new URLSearchParams({
    "rcav[begin]": toMdYY(checkIn),
    "rcav[end]": toMdYY(checkOut),
    "rcav[adult]": "2",
    "rcav[child]": "0",
    "rcav[eid]": String(eid),
    "rcav[flex_type]": "d",
  });
  let body = "";
  try {
    const r = await fetch(`${PRICING_ENDPOINT}?${params.toString()}`, {
      headers: { ...COMMON_HEADERS, Referer: url },
      signal: AbortSignal.timeout(10000),
    });
    body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e: any) {
    return {
      ok: false,
      reason: "sp-scraper-error",
      extracted: null,
      finalUrl: url,
      title: "Suite Paradise",
      screenshotBase64: "",
      iterations: 0,
      agentError: e?.message ?? String(e),
      agentTrace: [`sp-scraper: ${e?.message ?? e}`],
    };
  }

  // Parse the JSON envelope. The `content` field has the rendered HTML.
  let parsed: { status?: number; content?: string } = {};
  try { parsed = JSON.parse(body); } catch {}
  const content = parsed?.content ?? "";
  const isNotAvailable = /class=["'][^"']*\brc-na\b/.test(content);
  const priced = parsePrice(content);

  if (priced) {
    const nightly = Math.round(priced.totalPrice / nights);
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: true,
        totalPrice: Math.round(priced.totalPrice),
        nightlyPrice: nightly,
        dateMatch: true,
        reason: `Suite Paradise rcapi: $${Math.round(priced.totalPrice).toLocaleString()} total for ${nights} nights (eid=${eid})`,
      },
      finalUrl: url,
      title: "Suite Paradise",
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [`sp-scraper: extracted $${priced.totalPrice} for eid=${eid}`],
    };
  }

  if (isNotAvailable) {
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: false,
        totalPrice: null,
        nightlyPrice: null,
        dateMatch: true,
        reason: `Suite Paradise rcapi: unit not available for ${checkIn} → ${checkOut} (eid=${eid})`,
      },
      finalUrl: url,
      title: "Suite Paradise",
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [`sp-scraper: unavailable, eid=${eid}`],
    };
  }

  // Fell through — unrecognized response shape.
  return {
    ok: true,
    extracted: {
      isUnitPage: true,
      available: null,
      totalPrice: null,
      nightlyPrice: null,
      dateMatch: null,
      reason: "Suite Paradise rcapi returned an unparseable response",
    },
    finalUrl: url,
    title: "Suite Paradise",
    screenshotBase64: "",
    iterations: 0,
    agentTrace: [`sp-scraper: unparseable response, body[:200]=${body.slice(0, 200)}`],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory discovery — find ALL Suite Paradise units matching a bedroom
// count and price-check each against rcapi for the requested dates.
//
// Why: find-buy-in's PM source previously relied on Google site:search to
// surface SP unit URLs, capped at 3 hits. Whichever 3 SP units Google's
// index ranks highest got into the candidate pool — regardless of whether
// they were available for the requested dates. Real-world consequence: on
// Amy Vanbuskirk's reservation (3BR Dec 20–Jan 2), Google surfaced 3 SP
// units, all of which the rcapi reported booked. Other 3BR SP units that
// WERE available never entered the pool.
//
// New approach: SP publishes a sitemap.xml listing every unit. We fetch it
// (cached 24h), pull each unit's `eid` + bedroom count from its page (cached
// 7 days — that metadata effectively never changes), filter to matching
// bedrooms, then run rcapi pricing for every candidate in parallel batches
// of 8. Returns priced+available units only.
//
// First-call cost: ~10–15s for the metadata warmup over ~130 unit pages
// (8-wide concurrency). Subsequent calls within the cache TTL: just the
// rcapi pricing batches, ~3-5s.

const SITEMAP_URL = "https://www.suite-paradise.com/sitemap.xml";
const POIPU_UNIT_PATH_RE = /^https:\/\/www\.suite-paradise\.com\/poipu-vacation-rentals\/[a-z0-9-]+$/i;
// Excluded slugs are filter/category landing pages, not actual unit pages.
const NON_UNIT_SLUGS = new Set([
  "amenity", "bedrooms", "book-direct", "maps", "poipu-kai",
  "search-location", "search-resort", "all",
]);

type SpUnitMeta = {
  url: string;
  slug: string;
  eid: number;
  bedrooms: number;
  title: string;
  /**
   * Concatenation of the H1 title, <title>, and meta description. Used by
   * the discovery caller to match a unit against a target resort/community
   * — e.g. "Kahala 422 at Poipu Kai Resort..." vs "...Kiahuna Golf Village".
   * SP's Poipu sitemap lists units across multiple resorts (Poipu Kai,
   * Kiahuna, Lawai Beach, etc.) under the same /poipu-vacation-rentals/
   * URL prefix; without this filter, a Poipu Kai search would return
   * Kiahuna units indiscriminately.
   */
  resortHaystack: string;
};

type CacheEntry<T> = { value: T; expiresAt: number };

// Module-level caches. find-buy-in calls run on the same process so a
// simple Map is fine; if we ever scale beyond a single Railway dyno
// these would need to move to Redis or the DB.
const sitemapCache: { entry: CacheEntry<string[]> | null } = { entry: null };
const unitMetaCache = new Map<string, CacheEntry<SpUnitMeta | null>>();
const SITEMAP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

async function fetchSitemapUnitUrls(): Promise<string[]> {
  const cached = sitemapCache.entry;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const r = await fetch(SITEMAP_URL, {
      headers: { "User-Agent": COMMON_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      console.warn(`[sp-discovery] sitemap fetch HTTP ${r.status}`);
      return cached?.value ?? [];
    }
    const xml = await r.text();
    // <loc>https://www.suite-paradise.com/poipu-vacation-rentals/regency-620</loc>
    const matches = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g));
    const urls = matches
      .map((m) => m[1].trim())
      .filter((u) => POIPU_UNIT_PATH_RE.test(u))
      .filter((u) => {
        const slug = u.split("/").pop() ?? "";
        return !NON_UNIT_SLUGS.has(slug);
      });
    const deduped = Array.from(new Set(urls));
    sitemapCache.entry = { value: deduped, expiresAt: Date.now() + SITEMAP_TTL_MS };
    return deduped;
  } catch (e: any) {
    console.warn(`[sp-discovery] sitemap error: ${e?.message ?? e}`);
    return cached?.value ?? [];
  }
}

// Pull bedroom count from the unit page HTML. SP renders the unit's bed
// count in a stable element on every page:
//
//   <span class="rc-lodging-beds rc-lodging-detail">3 BR</span>
//
// This is the canonical signal — every SP unit page has it, and the
// number is authoritative. Earlier versions tried to read it from the
// <title> tag, which works on some units ("3BR Poipu Condo Rental ... |
// Regency 620") but most SP unit titles are generic ("Poipu Beach
// Rentals - Kahala 422 | Suite Paradise") with no bedroom mention,
// which dropped 80%+ of units to bedrooms=null and silently filtered
// them out of discovery results.
//
// Title and body word-form mentions are kept as last-resort fallbacks
// for any unit whose page doesn't render the lodging-beds detail.
function extractBedroomsFromHtml(html: string): number | null {
  // Primary: rc-lodging-beds class (every SP unit page has it).
  const lodging = html.match(/class=["'][^"']*\brc-lodging-beds\b[^"']*["'][^>]*>\s*(\d+)\s*BR/i);
  if (lodging) {
    const n = parseInt(lodging[1], 10);
    if (n > 0 && n < 20) return n;
  }
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch?.[1] ?? "";
  // Secondary: "3BR" / "3 BR" in the title.
  const brShort = title.match(/(\d+)\s*BR\b/i);
  if (brShort) {
    const n = parseInt(brShort[1], 10);
    if (n > 0 && n < 20) return n;
  }
  // Tertiary: "X-bedroom" in title.
  const brLong = title.match(/(\d+)[\s-]*bedroom/i);
  if (brLong) {
    const n = parseInt(brLong[1], 10);
    if (n > 0 && n < 20) return n;
  }
  // Last resort: word-form ("three-bedroom") anywhere in body. Cheap
  // catch-all for unusual unit pages.
  const wordMap: Record<string, number> = {
    studio: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  };
  const wordMatch = html.match(/\b(studio|one|two|three|four|five|six|seven|eight)[\s-]*bedroom/i);
  if (wordMatch) {
    const n = wordMap[wordMatch[1].toLowerCase()];
    if (n !== undefined) return n;
  }
  return null;
}

async function fetchUnitMeta(url: string): Promise<SpUnitMeta | null> {
  const cached = unitMetaCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": COMMON_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      unitMetaCache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
      return null;
    }
    const html = await r.text();
    const eid = extractEid(html);
    const bedrooms = extractBedroomsFromHtml(html);
    const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const title = (titleMatch?.[1] ?? "").trim();
    const pageTitleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const pageTitle = (pageTitleMatch?.[1] ?? "").trim();
    const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)/i);
    const metaDesc = (metaDescMatch?.[1] ?? "").trim();
    const slug = url.split("/").pop() ?? "";
    if (!eid || bedrooms === null) {
      // Unparseable — cache short to retry sooner next time.
      unitMetaCache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
      return null;
    }
    const meta: SpUnitMeta = {
      url,
      slug,
      eid,
      bedrooms,
      title: title || slug,
      resortHaystack: `${title} ${pageTitle} ${metaDesc}`,
    };
    unitMetaCache.set(url, { value: meta, expiresAt: Date.now() + META_TTL_MS });
    return meta;
  } catch {
    unitMetaCache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
    return null;
  }
}

// Run an array of async tasks with a concurrency cap. Built-in alternative
// to importing p-limit. Concurrency=8 balances SP's tolerance for
// concurrent requests (no documented rate limit, but a polite ceiling)
// against total wall-clock time on cold cache.
async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export type SuiteParadiseAvailableUnit = {
  url: string;
  title: string;
  bedrooms: number;
  totalPrice: number;
  nightlyPrice: number;
  eid: number;
};

export async function findAvailableSuiteParadiseUnits(opts: {
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  /**
   * Resort/community name to filter by (e.g. "Poipu Kai", "Pili Mai",
   * "Kiahuna"). Required — SP's Poipu sitemap lists units across many
   * resorts; without this filter, a Poipu Kai search returns Kiahuna
   * Golf Village houses, Poipu Beach houses, etc. — surfacing wrong-
   * community candidates that auto-fill would then attach as buy-ins.
   *
   * Matched the same way the OTA filters work: every significant token
   * (≥3 chars, lowercase, punctuation-stripped) of the resort name must
   * appear in the unit's resortHaystack (h1 + page title + meta
   * description).
   */
  resortName: string;
  /** Optional cap on number of priced units returned. Default 8. */
  limit?: number;
}): Promise<SuiteParadiseAvailableUnit[]> {
  const { bedrooms, checkIn, checkOut, resortName, limit = 8 } = opts;
  // Tokenize resort name the same way routes.ts:mentionsResort does, so
  // SP filtering is consistent with Airbnb / Vrbo / Booking filtering.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const resortTokens = normalize(resortName).split(" ").filter((t) => t.length >= 3);
  const matchesResort = (haystack: string): boolean => {
    if (resortTokens.length === 0) return true; // shouldn't happen, but safe
    const n = normalize(haystack);
    return resortTokens.every((t) => n.includes(t));
  };
  const nights = Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86400000,
    ),
  );

  const startedAt = Date.now();
  const urls = await fetchSitemapUnitUrls();
  if (urls.length === 0) {
    console.warn(`[sp-discovery] sitemap returned 0 units`);
    return [];
  }

  // Phase 1: warm metadata for any URLs we haven't seen, in parallel.
  // Already-cached URLs return instantly so this is a no-op on warm cache.
  const metas = await withConcurrency(urls, 8, fetchUnitMeta);
  const matchingBedrooms = metas
    .filter((m): m is SpUnitMeta => m !== null && m.bedrooms === bedrooms);
  // Apply resort filter — drop units that don't mention the target resort
  // in their h1/title/meta-description. Without this, a Poipu Kai search
  // returns Kiahuna Golf Village houses, etc.
  const matchingResort = matchingBedrooms.filter((m) => matchesResort(m.resortHaystack));

  console.log(
    `[sp-discovery] sitemap=${urls.length} metaResolved=${metas.filter(Boolean).length} ` +
    `matchingBedrooms=${matchingBedrooms.length} matchingResort=${matchingResort.length} ` +
    `(target=${bedrooms}BR @ "${resortName}")`,
  );

  if (matchingResort.length === 0) return [];

  // Phase 2: rcapi pricing for every matching unit, in parallel batches.
  // We use scrapeSuiteParadiseRate for consistency, but it re-fetches the
  // page to extract the eid — wasteful here since we already have the eid
  // from the metadata pass. Inline the rcapi call instead.
  const priceOne = async (meta: SpUnitMeta): Promise<SuiteParadiseAvailableUnit | null> => {
    const params = new URLSearchParams({
      "rcav[begin]": toMdYY(checkIn),
      "rcav[end]": toMdYY(checkOut),
      "rcav[adult]": "2",
      "rcav[child]": "0",
      "rcav[eid]": String(meta.eid),
      "rcav[flex_type]": "d",
    });
    try {
      const r = await fetch(`${PRICING_ENDPOINT}?${params.toString()}`, {
        headers: { ...COMMON_HEADERS, Referer: meta.url },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const body = await r.text();
      let parsed: { status?: number; content?: string } = {};
      try { parsed = JSON.parse(body); } catch { return null; }
      const content = parsed.content ?? "";
      if (/class=["'][^"']*\brc-na\b/.test(content)) return null; // unavailable
      const priced = parsePrice(content);
      if (!priced) return null;
      return {
        url: meta.url,
        title: meta.title,
        bedrooms: meta.bedrooms,
        totalPrice: Math.round(priced.totalPrice),
        nightlyPrice: Math.round(priced.totalPrice / nights),
        eid: meta.eid,
      };
    } catch {
      return null;
    }
  };

  const priced = await withConcurrency(matchingResort, 8, priceOne);
  const available = priced
    .filter((u): u is SuiteParadiseAvailableUnit => u !== null)
    .sort((a, b) => a.totalPrice - b.totalPrice)
    .slice(0, limit);

  console.log(
    `[sp-discovery] ${matchingResort.length} ${bedrooms}BR @ "${resortName}" units checked, ` +
    `${available.length} available for ${checkIn}→${checkOut} (${Date.now() - startedAt}ms)`,
  );
  return available;
}
