// Vrbo search via Apify actor `makework36/vrbo-scraper`.
//
// Takes a destination string + check-in/check-out + bedrooms, returns
// PRICED Vrbo properties with all-in totals (e.g. "$1,868 total for 5
// nights") in USD. Replaces the Google site:vrbo.com step in find-buy-in
// which only returned unpriced URLs that the operator had to click
// through to see the rate.
//
// Why an Apify actor instead of our own Browserbase Vrbo scraper:
// - Apify maintains the actor — Vrbo's frontend rev churn becomes their
//   problem, not ours.
// - Returns the all-in total (base + cleaning + service + taxes), which
//   our Browserbase calendar-GraphQL parsing was missing entirely.
// - Forces USD via explicit `currency: "USD"` + `locale: "en_US"` —
//   sidesteps the locale-leak issues we hit with Browserbase proxy
//   rotation.
// - ~$0.0025 per result. With maxResults=30 that's ~$0.075 per search;
//   we cache for 5 min so a re-run for the same dates costs $0.
//
// Env:
//   APIFY_API_TOKEN              — required (already used for Zillow)
//   APIFY_VRBO_ACTOR             — optional, override default
//   APIFY_VRBO_MAX_RESULTS       — optional, default 30
//
// Response shape (what the actor returns per result, observed):
//   {
//     id: string,
//     url: string,                  // canonical Vrbo URL
//     name: string,                 // listing title
//     priceFormatted: string,       // "$1,868 total for 5 nights"
//     priceLabel: string,           // alt label
//     bedrooms: number,
//     guests: number,
//     images: string[],
//     description: string,
//     ...
//   }
//
// We're careful to:
//   1. Filter to results that pass the resort-name match (same rule as
//      Airbnb / Booking / SP / PK use).
//   2. Filter to bedroom count ≥ requested (some actors return 4BR
//      results for a 3BR query — keep them, they upcover).
//   3. Parse the all-in total out of `priceFormatted` since the
//      structured numeric field isn't documented to exist.

const DEFAULT_ACTOR = "makework36~vrbo-scraper";
const DEFAULT_MAX_RESULTS = 30;
const RUN_TIMEOUT_MS = 120_000;

export type ApifyVrboCandidate = {
  url: string;
  title: string;
  totalPrice: number;       // USD all-in for the requested dates
  nightlyPrice: number;     // USD per night (totalPrice / nights)
  bedrooms: number | undefined;
  image: string | undefined;
  snippet: string;
};

type CacheEntry = { value: ApifyVrboCandidate[]; expiresAt: number };
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Parse "$1,868 total for 5 nights" → 1868. Falls back to first
// "$X,XXX" amount when the "total" suffix isn't present.
function parseTotal(priceFormatted: string | undefined | null): number {
  if (!priceFormatted) return 0;
  const totalMatch = priceFormatted.match(/\$\s*([\d,]+(?:\.\d+)?)\s*total/i);
  if (totalMatch) return parseFloat(totalMatch[1].replace(/,/g, ""));
  const anyMatch = priceFormatted.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (anyMatch) return parseFloat(anyMatch[1].replace(/,/g, ""));
  return 0;
}

// Pull image URL from a few likely shapes: array of strings, array of
// objects with `url`, or a single `image`/`thumbnail`.
function pickImage(item: any): string | undefined {
  const candidates: any[] = [
    item?.images?.[0],
    item?.thumbnail,
    item?.image,
    item?.photos?.[0],
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
    if (c && typeof c === "object") {
      const u = c.url ?? c.src ?? c.thumbnail;
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  }
  return undefined;
}

export async function searchVrboViaApify(opts: {
  resortName: string;
  /** Search location passed to the actor (often the same as resortName, or a city like "Poipu Kai"). */
  location?: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  /** Defaults to APIFY_VRBO_MAX_RESULTS env or 30. */
  maxResults?: number;
}): Promise<ApifyVrboCandidate[]> {
  const { resortName, bedrooms, checkIn, checkOut } = opts;
  const location = opts.location ?? resortName;
  const maxResults = opts.maxResults
    ?? parseInt(process.env.APIFY_VRBO_MAX_RESULTS ?? "", 10)
    || DEFAULT_MAX_RESULTS;

  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.warn(`[apify-vrbo] APIFY_API_TOKEN not set — skipping`);
    return [];
  }
  const actor = (process.env.APIFY_VRBO_ACTOR || DEFAULT_ACTOR).replace("/", "~");

  // Cache key: same params return the same results within 5 min.
  // Resort name doesn't go into the actor input (we filter post-hoc
  // by resortName), but it does affect the result subset, so include it.
  const cacheKey = `${actor}|${location}|${checkIn}|${checkOut}|${bedrooms}|${maxResults}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const nights = Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T12:00:00").getTime() -
        new Date(checkIn + "T12:00:00").getTime()) / 86400000,
    ),
  );

  // Tokenize resort name for filtering — same rule as routes.ts:mentionsResort.
  const resortTokens = normalize(resortName).split(" ").filter((t) => t.length >= 3);
  const matchesResort = (haystack: string): boolean => {
    if (resortTokens.length === 0) return true;
    const n = normalize(haystack);
    return resortTokens.every((t) => n.includes(t));
  };

  const startedAt = Date.now();
  try {
    const api = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locations: [location],
        checkIn,
        checkOut,
        adults: 2,
        maxResults,
        currency: "USD",
        locale: "en_US",
      }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[apify-vrbo] HTTP ${r.status} ${body.slice(0, 200)}`);
      searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
      return [];
    }
    const items: any[] = await r.json().catch(() => []);
    if (!Array.isArray(items)) {
      console.warn(`[apify-vrbo] non-array response`);
      return [];
    }

    const candidates: ApifyVrboCandidate[] = [];
    let droppedNoResort = 0;
    let droppedWrongBedrooms = 0;
    let droppedNoPrice = 0;
    for (const item of items) {
      const url = String(item?.url ?? item?.link ?? "").trim();
      if (!url || !/vrbo\.com/i.test(url)) continue;
      const title = String(item?.name ?? item?.title ?? "Vrbo listing").slice(0, 120);
      const description = String(item?.description ?? "");

      // Resort filter
      const haystack = `${title} ${description}`;
      if (!matchesResort(haystack)) {
        droppedNoResort++;
        continue;
      }

      // Bedroom filter: keep equal or larger (covers our needs)
      const itemBeds = typeof item?.bedrooms === "number" ? item.bedrooms : undefined;
      if (typeof itemBeds === "number" && itemBeds < bedrooms) {
        droppedWrongBedrooms++;
        continue;
      }

      // Price extraction — try structured fields first, then formatted string.
      const structuredTotal = Number(
        item?.totalPrice ??
        item?.priceTotal ??
        item?.price?.total ??
        item?.price?.amount ??
        0,
      );
      const total = structuredTotal > 0
        ? structuredTotal
        : parseTotal(item?.priceFormatted ?? item?.priceLabel ?? item?.price);
      if (!(total > 0)) {
        droppedNoPrice++;
        continue;
      }

      candidates.push({
        url,
        title,
        totalPrice: Math.round(total),
        nightlyPrice: Math.round(total / nights),
        bedrooms: itemBeds,
        image: pickImage(item),
        snippet: description.slice(0, 160),
      });
    }

    // Sort cheapest first. Auto-fill prefers cheapest priced candidates,
    // and the operator's UI shows them in this order too.
    candidates.sort((a, b) => a.totalPrice - b.totalPrice);

    console.log(
      `[apify-vrbo] location="${location}" ${bedrooms}BR ${checkIn}→${checkOut}: ` +
      `${items.length} raw, ${candidates.length} after filter ` +
      `(dropped: noResort=${droppedNoResort} wrongBeds=${droppedWrongBedrooms} noPrice=${droppedNoPrice}) ` +
      `· ${Date.now() - startedAt}ms`,
    );

    searchCache.set(cacheKey, { value: candidates, expiresAt: Date.now() + CACHE_TTL_MS });
    return candidates;
  } catch (e: any) {
    console.warn(`[apify-vrbo] error: ${e?.message ?? e}`);
    return [];
  }
}
