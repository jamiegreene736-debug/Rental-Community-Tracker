// Vrbo search via Apify actor.
//
// Replaces the Google site:vrbo.com step in find-buy-in (which only
// returned unpriced URLs) with a paid Apify actor that returns priced
// candidates with all-in totals.
//
// Two actor families supported via dispatch on `APIFY_VRBO_ACTOR`:
//
//   1. `easyapi/vrbo-property-listing-scraper` (default)
//      Input: { searchUrls: [{ url: "<vrbo search URL with d1/d2>" }],
//               maxItems: N, proxyConfiguration: {...} }
//      We construct a Vrbo search URL: `vrbo.com/search?destination=
//      <community>&d1=<checkIn>&d2=<checkOut>&adults=2&minBedrooms=N`
//
//   2. `makework36/vrbo-scraper`
//      Input: { locations: [name], checkIn, checkOut, adults,
//               maxResults, currency, locale }
//      Tried first (returned 0 consistently — actor is brand new with
//      only ~21 lifetime runs and may not be reliable yet). Kept as
//      a fallback path.
//
// Both return per-result objects with similar fields (url, title,
// description, price formatted, bedrooms, images). Field names vary
// slightly so the response parser is defensive across both shapes.
//
// Env:
//   APIFY_API_TOKEN              — required (already used for Zillow)
//   APIFY_VRBO_ACTOR             — optional, defaults to easyapi
//   APIFY_VRBO_MAX_RESULTS       — optional, default 30

const DEFAULT_ACTOR = "easyapi~vrbo-property-listing-scraper";
const DEFAULT_MAX_RESULTS = 30;
const RUN_TIMEOUT_MS = 180_000;

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

// Last-call snapshot for /api/operations/apify-vrbo-debug. Lets us
// diagnose "0 candidates" returns without needing Railway log access
// or re-running (and re-paying for) the actor each time.
type ApifyVrboDebugSnapshot = {
  at: string;
  actor: string;
  input: Record<string, unknown>;
  httpStatus: number | null;
  errorBody: string | null;
  rawItemsCount: number;
  firstItemKeys: string[];
  firstItemSample: any;
  filteredOut: { noResort: number; wrongBedrooms: number; noPrice: number };
  candidatesReturned: number;
  durationMs: number;
} | null;
let lastDebugSnapshot: ApifyVrboDebugSnapshot = null;
export function getApifyVrboDebugSnapshot(): ApifyVrboDebugSnapshot {
  return lastDebugSnapshot;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Build the Vrbo search URL the easyapi actor expects. Vrbo uses `d1`
// and `d2` for check-in / check-out, `destination` for the search
// keyword, and `minBedrooms` for the bedroom floor. Encoding is
// straightforward — no path-style colons, plain query string.
function buildVrboSearchUrl(opts: {
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
}): string {
  const params = new URLSearchParams({
    destination: opts.destination,
    d1: opts.checkIn,
    d2: opts.checkOut,
    adults: "2",
    minBedrooms: String(opts.bedrooms),
  });
  return `https://www.vrbo.com/search?${params.toString()}`;
}

// Build the input payload for whichever Apify actor we're calling.
// Both actors live behind the same `searchVrboViaApify` API, but
// expect different input shapes:
//
//   - easyapi/vrbo-property-listing-scraper:
//       { searchUrls: [{ url }], maxItems, proxyConfiguration }
//   - makework36/vrbo-scraper:
//       { locations, checkIn, checkOut, adults, maxResults,
//         currency, locale }
//
// Default + recommended is easyapi (more mature, takes a real Vrbo
// search URL with d1/d2 dates so the actor doesn't have to interpret
// "Poipu Kai" — Vrbo's own search engine handles that).
function buildActorInput(opts: {
  actor: string;
  location: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  maxResults: number;
}): Record<string, unknown> {
  const { actor, location, bedrooms, checkIn, checkOut, maxResults } = opts;
  if (/easyapi/.test(actor)) {
    const searchUrl = buildVrboSearchUrl({
      destination: location,
      checkIn,
      checkOut,
      bedrooms,
    });
    return {
      searchUrls: [{ url: searchUrl }],
      maxItems: maxResults,
      proxyConfiguration: { useApifyProxy: true },
    };
  }
  // makework36 (and other location-based actors) — fall through.
  return {
    locations: [location],
    checkIn,
    checkOut,
    adults: 2,
    maxResults,
    currency: "USD",
    locale: "en_US",
  };
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
  // Resolve maxResults: explicit opts > APIFY_VRBO_MAX_RESULTS env > default.
  // Mixing `??` and `||` directly is a syntax error per ECMA — the env
  // parse + default fallback is parenthesized into a helper expression.
  const envMax = parseInt(process.env.APIFY_VRBO_MAX_RESULTS ?? "", 10);
  const maxResults = opts.maxResults
    ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_RESULTS);

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
  const inputObj: Record<string, unknown> = buildActorInput({
    actor,
    location,
    bedrooms,
    checkIn,
    checkOut,
    maxResults,
  });
  try {
    const api = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputObj),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[apify-vrbo] HTTP ${r.status} ${body.slice(0, 200)}`);
      lastDebugSnapshot = {
        at: new Date().toISOString(),
        actor,
        input: inputObj,
        httpStatus: r.status,
        errorBody: body.slice(0, 600),
        rawItemsCount: 0,
        firstItemKeys: [],
        firstItemSample: null,
        filteredOut: { noResort: 0, wrongBedrooms: 0, noPrice: 0 },
        candidatesReturned: 0,
        durationMs: Date.now() - startedAt,
      };
      searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
      return [];
    }
    const items: any[] = await r.json().catch(() => []);
    if (!Array.isArray(items)) {
      console.warn(`[apify-vrbo] non-array response`);
      lastDebugSnapshot = {
        at: new Date().toISOString(),
        actor,
        input: inputObj,
        httpStatus: r.status,
        errorBody: "non-array response",
        rawItemsCount: 0,
        firstItemKeys: [],
        firstItemSample: null,
        filteredOut: { noResort: 0, wrongBedrooms: 0, noPrice: 0 },
        candidatesReturned: 0,
        durationMs: Date.now() - startedAt,
      };
      return [];
    }

    const candidates: ApifyVrboCandidate[] = [];
    let droppedNoResort = 0;
    let droppedWrongBedrooms = 0;
    let droppedNoPrice = 0;
    for (const item of items) {
      // URL — easyapi tends to use `propertyUrl`; makework36 uses `url`.
      const url = String(
        item?.url ?? item?.propertyUrl ?? item?.link ?? "",
      ).trim();
      if (!url || !/vrbo\.com/i.test(url)) continue;
      // Title — easyapi `propertyName` / `headline`; makework36 `name`/`title`.
      const title = String(
        item?.name ?? item?.title ?? item?.propertyName ?? item?.headline ?? "Vrbo listing",
      ).slice(0, 120);
      const description = String(item?.description ?? item?.summary ?? "");

      // Resort filter
      const haystack = `${title} ${description}`;
      if (!matchesResort(haystack)) {
        droppedNoResort++;
        continue;
      }

      // Bedroom filter — accept several field name variants. easyapi
      // sometimes nests this under `details.bedrooms` or similar.
      const itemBedsRaw = item?.bedrooms ?? item?.numBedrooms ?? item?.beds ?? item?.details?.bedrooms;
      const itemBeds = typeof itemBedsRaw === "number"
        ? itemBedsRaw
        : (typeof itemBedsRaw === "string" && /^\d+/.test(itemBedsRaw) ? parseInt(itemBedsRaw, 10) : undefined);
      if (typeof itemBeds === "number" && itemBeds < bedrooms) {
        droppedWrongBedrooms++;
        continue;
      }

      // Price extraction — try structured numeric fields first, then
      // formatted strings. easyapi often surfaces `price` as either a
      // string ("$1,868 total for 5 nights") or an object with `total`/
      // `amount`. makework36 uses `priceFormatted`.
      const priceField = item?.price;
      const structuredTotal = Number(
        item?.totalPrice ??
        item?.priceTotal ??
        item?.totalAmount ??
        (typeof priceField === "object" ? priceField?.total ?? priceField?.amount : 0) ??
        0,
      );
      const formattedCandidate =
        item?.priceFormatted ??
        item?.priceLabel ??
        item?.totalPriceFormatted ??
        (typeof priceField === "string" ? priceField : null);
      const total = structuredTotal > 0
        ? structuredTotal
        : parseTotal(formattedCandidate);
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

    // Capture diagnostic snapshot — last call only. Truncate the first
    // item to ~2KB JSON so the debug response stays bounded.
    const firstItem = items[0] ?? null;
    let firstItemSample: any = null;
    if (firstItem && typeof firstItem === "object") {
      try {
        const clone = JSON.parse(JSON.stringify(firstItem));
        const json = JSON.stringify(clone);
        firstItemSample = json.length > 2000 ? json.slice(0, 2000) + "…(truncated)" : clone;
      } catch {
        firstItemSample = "(unstringifiable)";
      }
    }
    lastDebugSnapshot = {
      at: new Date().toISOString(),
      actor,
      input: inputObj,
      httpStatus: r.status,
      errorBody: null,
      rawItemsCount: items.length,
      firstItemKeys: firstItem && typeof firstItem === "object" ? Object.keys(firstItem) : [],
      firstItemSample,
      filteredOut: { noResort: droppedNoResort, wrongBedrooms: droppedWrongBedrooms, noPrice: droppedNoPrice },
      candidatesReturned: candidates.length,
      durationMs: Date.now() - startedAt,
    };

    searchCache.set(cacheKey, { value: candidates, expiresAt: Date.now() + CACHE_TTL_MS });
    return candidates;
  } catch (e: any) {
    console.warn(`[apify-vrbo] error: ${e?.message ?? e}`);
    return [];
  }
}
