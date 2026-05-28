import { resolveVrboRegion } from "./vrbo-region-resolver";

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

// Build the Vrbo search URL the easyapi actor expects. Modeled after
// the actor's documented working example, which uses the FULL set of
// query params Vrbo's frontend emits when a real user searches:
//
//   destination=Lake%20Tahoe%2C%20United%20States%20of%20America
//   regionId=652645981589159936     ← optional but helps disambiguate
//   latLong=39.09605908133315,-120.0334518044189   ← also optional
//   flexibility=0_DAY
//   d1=2025-01-25 & startDate=2025-01-25
//   d2=2025-02-08 & endDate=2025-02-08
//   adults=2
//   isInvalidatedDate=false
//   sort=RECOMMENDED
//
// Without `startDate`/`endDate` (alongside `d1`/`d2`) and `sort`, the
// actor was getting empty result sets on initial recon — Vrbo's
// frontend either showed the autocomplete interstitial or a blank
// state. We send both date conventions to maximize compatibility.
//
// `regionId` and `latLong` are omitted: we don't have them per
// destination, and Vrbo does auto-resolve a free-text destination
// when they're absent. If we hit destinations where this fails, we
// can build a small lookup table or hit Vrbo's destination
// autocomplete to resolve them.
// Map a resort name to the destination string Vrbo's destination search
// actually recognizes. Vrbo's search resolves CITIES / regions, not
// individual resorts — passing "Poipu Kai" returned 0 raw results from
// the actor because Vrbo's autocomplete couldn't resolve it. We swap to
// the city the resort sits in, then narrow back via the post-hoc
// `mentionsResort` filter on title + location.description + propertyType.
//
// Hawaii destinations covered for now (matches our PM coverage). New
// destinations fall through to the original resort name (better than
// nothing — sometimes Vrbo does match resort names directly).
function resolveVrboDestination(resortOrLocation: string): string {
  const s = resortOrLocation.toLowerCase();
  if (/poipu|pili\s*mai|kiahuna/.test(s)) return "Koloa, HI, United States";
  if (/wailea|kihei/.test(s)) return "Wailea, HI, United States";
  if (/kaanapali|kapalua/.test(s)) return "Lahaina, HI, United States";
  if (/princeville|hanalei|anini/.test(s)) return "Princeville, HI, United States";
  if (/wailua|kapaa/.test(s)) return "Kapaa, HI, United States";
  return resortOrLocation;
}

function buildVrboSearchUrl(opts: {
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  /** Optional Vrbo `regionId` — strongly recommended; without it, Vrbo's search
   * often returns 0 properties because the destination string alone doesn't
   * disambiguate. Resolved by `vrbo-region-resolver.ts`. */
  regionId?: string;
  /** Optional `<lat>,<lng>` matching the regionId. */
  latLong?: string;
}): string {
  const params = new URLSearchParams({
    destination: opts.destination,
    d1: opts.checkIn,
    startDate: opts.checkIn,
    d2: opts.checkOut,
    endDate: opts.checkOut,
    flexibility: "0_DAY",
    adults: "2",
    isInvalidatedDate: "false",
    sort: "RECOMMENDED",
  });
  if (opts.regionId) params.set("regionId", opts.regionId);
  if (opts.latLong) params.set("latLong", opts.latLong);
  // Note: we deliberately DO NOT pass `minBedrooms` to Vrbo. The data
  // is sparse on listings and Vrbo's filter often drops valid results
  // that just don't have the field set. The post-hoc bedroom filter
  // in the response parser handles this — and it's permissive (keeps
  // unknowns) so we don't lose candidates with missing metadata.
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
  /** Vrbo's regionId for the destination, when known. Critical for the
   * easyapi actor — Vrbo's search returns 0 without it. */
  regionId?: string;
  latLong?: string;
  /** Override for the `destination` query param. When the resolver
   * supplies a canonical destination string (e.g. "Koloa, Hawaii,
   * United States of America"), prefer it over the heuristic mapping. */
  displayDestination?: string;
}): Record<string, unknown> {
  const { actor, location, bedrooms, checkIn, checkOut, maxResults } = opts;
  if (/easyapi/.test(actor)) {
    const searchUrl = buildVrboSearchUrl({
      destination: opts.displayDestination || resolveVrboDestination(location),
      checkIn,
      checkOut,
      bedrooms,
      regionId: opts.regionId,
      latLong: opts.latLong,
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

  // Resolve Vrbo regionId for the destination. Tier 1 (hardcoded) is
  // synchronous and instant for our active markets. Tier 2 (in-memory
  // cache) is also fast. Tier 3 (Browserbase fetch) only fires when
  // we encounter an unknown destination — and only if Browserbase
  // creds are configured. For known destinations this is a no-op.
  const destinationForVrbo = resolveVrboDestination(location);
  const region = await resolveVrboRegion({
    destination: destinationForVrbo,
    bbApiKey: process.env.BROWSERBASE_API_KEY,
    bbProjectId: process.env.BROWSERBASE_PROJECT_ID,
  }).catch(() => null);

  const startedAt = Date.now();
  const inputObj: Record<string, unknown> = buildActorInput({
    actor,
    location,
    bedrooms,
    checkIn,
    checkOut,
    maxResults,
    regionId: region?.regionId,
    latLong: region?.latLong || undefined,
    displayDestination: region?.displayDestination || undefined,
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
      // URL — easyapi documents `detailUrl` as the property page URL.
      // `searchUrl` on the item is the source search URL, NOT the
      // property — checking it would link the operator to a search
      // page, not a specific property. Falls back to `url`/`propertyUrl`
      // / `link` for makework36 + future actors.
      const url = String(
        item?.detailUrl ?? item?.url ?? item?.propertyUrl ?? item?.link ?? "",
      ).trim();
      if (!url || !/vrbo\.com/i.test(url)) continue;
      // Title — `name` is documented in easyapi; fall through to the
      // makework36 / generic variants.
      const title = String(
        item?.name ?? item?.title ?? item?.propertyName ?? item?.headline ?? "Vrbo listing",
      ).slice(0, 120);
      // Description — easyapi's `location.description` carries the
      // location string ("Poipu Beach, HI" etc) which is what we want
      // for the resort match. Plus `propertyType` ("House · 4 BR · 3 BA")
      // for bedroom signal.
      const locationDesc = String(item?.location?.description ?? "");
      const propertyType = String(item?.propertyType ?? "");
      const description = String(item?.description ?? item?.summary ?? "");

      // Resort filter — combine title + location + propertyType +
      // description into one haystack. easyapi's `location.description`
      // is the most reliable resort/area indicator.
      const haystack = `${title} ${locationDesc} ${propertyType} ${description}`;
      if (!matchesResort(haystack)) {
        droppedNoResort++;
        continue;
      }

      // Bedroom filter — easyapi packs bed count into `propertyType`
      // ("House · 4 BR · 3 BA"). Parse "(\d+)\s*BR" out of the string
      // when no structured field is present.
      const itemBedsRaw = item?.bedrooms ?? item?.numBedrooms ?? item?.beds ?? item?.details?.bedrooms;
      let itemBeds: number | undefined =
        typeof itemBedsRaw === "number" ? itemBedsRaw
        : (typeof itemBedsRaw === "string" && /^\d+/.test(itemBedsRaw) ? parseInt(itemBedsRaw, 10) : undefined);
      if (itemBeds === undefined && propertyType) {
        const m = propertyType.match(/(\d+)\s*BR\b/i);
        if (m) itemBeds = parseInt(m[1], 10);
      }
      if (typeof itemBeds === "number" && itemBeds < bedrooms) {
        droppedWrongBedrooms++;
        continue;
      }

      // Price extraction — easyapi documents `price` as an object with
      // `perNight`, `total`, and `fees`. `total` IS the all-in for the
      // requested dates (the whole point of using this actor). Falls
      // back to alt structured fields and formatted-string parsing for
      // makework36 / other actors.
      const priceField = item?.price;
      const structuredTotal = Number(
        (typeof priceField === "object" ? priceField?.total : null) ??
        (typeof priceField === "object" ? priceField?.amount : null) ??
        item?.totalPrice ??
        item?.priceTotal ??
        item?.totalAmount ??
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
