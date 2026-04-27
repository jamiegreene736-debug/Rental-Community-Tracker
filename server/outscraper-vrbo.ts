// Vrbo search via Outscraper — fifth path.
//
// Operator confirmed Outscraper has a Vrbo scraper they want to use.
// Their API isn't fully documented from the marketing pages we have
// WebFetch access to, so this module is built defensively:
//
//   1. Endpoint configurable via `OUTSCRAPER_VRBO_ENDPOINT` env var.
//      Default is the most likely path (`/vrbo-search`); if that
//      404s, we surface the response in the debug snapshot so the
//      operator can swap to the correct service slug from their
//      dashboard via env var change (no code redeploy needed).
//
//   2. Sync request only. Outscraper supports both sync (`async=false`)
//      and async (returns request_id, poll later) modes. We start
//      sync because find-buy-in is a single-request flow; if the
//      scraper takes >120s we'll add async polling later.
//
//   3. Defensive response parsing — Outscraper's per-service response
//      shapes vary. The walker scans for arrays of objects with a
//      url + price field shape, same as the Browserbase / ScrapingBee
//      paths. Field names supported include the variants we've seen
//      across other Vrbo scrapers (detailUrl, propertyUrl, url; price
//      object with total or formatted; bedrooms in dedicated field
//      or embedded in propertyType string).
//
//   4. Debug snapshot at `/api/operations/outscraper-vrbo-debug` —
//      same pattern as the Apify path. Lets us iterate without
//      redeploying or burning new calls.
//
// Env:
//   OUTSCRAPER_API_KEY            — required
//   OUTSCRAPER_VRBO_ENDPOINT      — optional, default below
//   OUTSCRAPER_VRBO_MAX_RESULTS   — optional, default 30

const DEFAULT_ENDPOINT = "https://api.app.outscraper.com/vrbo-search";
const DEFAULT_MAX_RESULTS = 30;
const RUN_TIMEOUT_MS = 180_000;

export type OutscraperVrboCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms: number | undefined;
  image: string | undefined;
  snippet: string;
};

type CacheEntry = { value: OutscraperVrboCandidate[]; expiresAt: number };
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

type DebugSnapshot = {
  at: string;
  endpoint: string;
  query: Record<string, string>;
  httpStatus: number | null;
  errorBody: string | null;
  rawItemsCount: number;
  firstItemKeys: string[];
  firstItemSample: any;
  filteredOut: { noResort: number; wrongBedrooms: number; noPrice: number };
  candidatesReturned: number;
  durationMs: number;
} | null;
let lastDebugSnapshot: DebugSnapshot = null;
export function getOutscraperVrboDebugSnapshot(): DebugSnapshot {
  return lastDebugSnapshot;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseTotal(formatted: string | undefined | null): number {
  if (!formatted) return 0;
  const totalMatch = formatted.match(/\$\s*([\d,]+(?:\.\d+)?)\s*total/i);
  if (totalMatch) return parseFloat(totalMatch[1].replace(/,/g, ""));
  const anyMatch = formatted.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (anyMatch) return parseFloat(anyMatch[1].replace(/,/g, ""));
  return 0;
}

function pickImage(item: any): string | undefined {
  const candidates: any[] = [
    item?.images?.[0],
    item?.thumbnail,
    item?.image,
    item?.photos?.[0],
    item?.heroImage?.url,
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

function extractListingUrl(item: any): string | null {
  const candidates = [
    item?.detailUrl,
    item?.propertyUrl,
    item?.url,
    item?.link,
    item?.cardLink?.resource?.value,
    item?.cardLink?.value,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      if (/^\/\d/.test(c)) return `https://www.vrbo.com${c.split("?")[0]}`;
      if (/vrbo\.com\/\d/.test(c)) return c.split("?")[0].replace(/^http:/, "https:");
      if (/vrbo\.com/.test(c)) return c.split("?")[0].replace(/^http:/, "https:");
    }
  }
  return null;
}

function extractTotal(item: any): number {
  const structured = Number(
    item?.totalPrice ??
    item?.priceTotal ??
    item?.totalAmount ??
    item?.tripTotal?.amount ??
    item?.price?.total ??
    item?.price?.amount ??
    0,
  );
  if (structured > 0) return structured;
  const formatted =
    item?.priceFormatted ??
    item?.priceLabel ??
    item?.totalPriceFormatted ??
    item?.tripTotal?.formatted ??
    item?.formattedTotal ??
    (typeof item?.price === "string" ? item.price : null);
  return parseTotal(formatted);
}

function extractTitle(item: any): string {
  return String(
    item?.name ?? item?.title ?? item?.propertyName ?? item?.headline ?? "Vrbo listing",
  ).slice(0, 120);
}

function extractBedrooms(item: any): number | undefined {
  const direct = item?.bedrooms ?? item?.numBedrooms ?? item?.beds ?? item?.details?.bedrooms;
  if (typeof direct === "number") return direct;
  if (typeof direct === "string" && /^\d+/.test(direct)) return parseInt(direct, 10);
  const subtitle = item?.propertyType ?? item?.subtitle ?? "";
  const m = String(subtitle).match(/(\d+)\s*BR\b/i);
  if (m) return parseInt(m[1], 10);
  return undefined;
}

// Walk parsed JSON for arrays of objects that look like property cards.
// Outscraper sometimes wraps the payload in `{ data: [...] }` or
// `{ results: [...] }`; the walker finds the right array by shape.
function findPropertyCards(parsed: any): any[] {
  const cards: any[] = [];
  const stack: any[] = [parsed];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (Array.isArray(node)) {
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
  return cards;
}

export async function searchVrboViaOutscraper(opts: {
  resortName: string;
  destination: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  /** Cap on results returned. Default 30. */
  maxResults?: number;
}): Promise<OutscraperVrboCandidate[]> {
  const { resortName, destination, bedrooms, checkIn, checkOut } = opts;
  const apiKey = process.env.OUTSCRAPER_API_KEY;
  if (!apiKey) {
    console.warn(`[outscraper-vrbo] OUTSCRAPER_API_KEY not set — skipping`);
    return [];
  }
  const endpoint = process.env.OUTSCRAPER_VRBO_ENDPOINT || DEFAULT_ENDPOINT;
  const envMax = parseInt(process.env.OUTSCRAPER_VRBO_MAX_RESULTS ?? "", 10);
  const maxResults = opts.maxResults
    ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_RESULTS);

  const cacheKey = `${endpoint}|${destination}|${bedrooms}|${checkIn}|${checkOut}|${maxResults}`;
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

  // Outscraper's typical query shape uses `query` for a search keyword,
  // dates as `check_in` / `check_out`, and `async=false` for sync
  // response. Defensive: send under several aliases so whichever one
  // the actual endpoint expects gets populated.
  const query: Record<string, string> = {
    query: destination,
    check_in: checkIn,
    check_out: checkOut,
    checkIn,
    checkOut,
    adults: "2",
    bedrooms: String(bedrooms),
    minBedrooms: String(bedrooms),
    currency: "USD",
    language: "en",
    region: "US",
    limit: String(maxResults),
    async: "false",
  };
  const url = `${endpoint}?${new URLSearchParams(query).toString()}`;

  const startedAt = Date.now();
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "X-API-KEY": apiKey,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });

    const bodyText = await r.text().catch(() => "");
    if (!r.ok) {
      console.warn(`[outscraper-vrbo] HTTP ${r.status} ${bodyText.slice(0, 300)}`);
      lastDebugSnapshot = {
        at: new Date().toISOString(),
        endpoint,
        query,
        httpStatus: r.status,
        errorBody: bodyText.slice(0, 800),
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

    let parsed: any;
    try { parsed = JSON.parse(bodyText); }
    catch { parsed = null; }

    if (!parsed) {
      lastDebugSnapshot = {
        at: new Date().toISOString(),
        endpoint,
        query,
        httpStatus: r.status,
        errorBody: "non-JSON response",
        rawItemsCount: 0,
        firstItemKeys: [],
        firstItemSample: bodyText.slice(0, 500),
        filteredOut: { noResort: 0, wrongBedrooms: 0, noPrice: 0 },
        candidatesReturned: 0,
        durationMs: Date.now() - startedAt,
      };
      return [];
    }

    const cards = findPropertyCards(parsed);
    // De-dupe by extracted URL.
    const seen = new Set<string>();
    const unique: any[] = [];
    for (const card of cards) {
      const u = extractListingUrl(card);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      unique.push(card);
    }

    const out: OutscraperVrboCandidate[] = [];
    let droppedNoResort = 0;
    let droppedWrongBedrooms = 0;
    let droppedNoPrice = 0;
    for (const item of unique) {
      const detailUrl = extractListingUrl(item);
      if (!detailUrl) continue;
      const title = extractTitle(item);
      const itemBeds = extractBedrooms(item);
      const total = extractTotal(item);

      const haystack = `${title} ${item?.location?.description ?? item?.location ?? ""} ${item?.propertyType ?? item?.subtitle ?? ""} ${item?.description ?? ""}`;
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
      out.push({
        url: detailUrl,
        title,
        totalPrice: Math.round(total),
        nightlyPrice: Math.round(total / nights),
        bedrooms: itemBeds,
        image: pickImage(item),
        snippet: String(item?.description ?? item?.summary ?? "").slice(0, 160),
      });
    }
    out.sort((a, b) => a.totalPrice - b.totalPrice);
    const capped = out.slice(0, maxResults);

    // Capture diagnostic snapshot — last call only.
    const firstItem = unique[0] ?? cards[0] ?? null;
    let firstItemSample: any = null;
    if (firstItem && typeof firstItem === "object") {
      try {
        const json = JSON.stringify(firstItem);
        firstItemSample = json.length > 2000 ? json.slice(0, 2000) + "…(truncated)" : firstItem;
      } catch { /* ignore */ }
    }
    lastDebugSnapshot = {
      at: new Date().toISOString(),
      endpoint,
      query,
      httpStatus: r.status,
      errorBody: null,
      rawItemsCount: cards.length,
      firstItemKeys: firstItem && typeof firstItem === "object" ? Object.keys(firstItem) : [],
      firstItemSample,
      filteredOut: { noResort: droppedNoResort, wrongBedrooms: droppedWrongBedrooms, noPrice: droppedNoPrice },
      candidatesReturned: capped.length,
      durationMs: Date.now() - startedAt,
    };

    console.log(
      `[outscraper-vrbo] destination="${destination}" ${bedrooms}BR ${checkIn}→${checkOut}: ` +
      `${cards.length} cards, ${capped.length} after filter ` +
      `(dropped: noResort=${droppedNoResort} wrongBeds=${droppedWrongBedrooms} noPrice=${droppedNoPrice}) ` +
      `· ${Date.now() - startedAt}ms`,
    );

    searchCache.set(cacheKey, { value: capped, expiresAt: Date.now() + CACHE_TTL_MS });
    return capped;
  } catch (e: any) {
    console.warn(`[outscraper-vrbo] error: ${e?.message ?? e}`);
    lastDebugSnapshot = {
      at: new Date().toISOString(),
      endpoint,
      query,
      httpStatus: null,
      errorBody: String(e?.message ?? e).slice(0, 500),
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
}
