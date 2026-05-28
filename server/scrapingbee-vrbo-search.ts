// Vrbo destination search via ScrapingBee — fourth path.
//
// We already use ScrapingBee for Zillow (the fallback when Apify
// returns 0 photos), so the API key + cost ceiling is established.
// ScrapingBee is a managed scraping service that handles anti-bot,
// renders JS, and uses stealth/residential proxies. It's a different
// vendor from Browserbase — adding it as a parallel path is pure
// resilience: when one provider has issues, the other can still
// land results.
//
// Flow:
//   1. Build a Vrbo search URL with destination + dates (same as the
//      Browserbase path).
//   2. POST to ScrapingBee with `render_js=true` + `stealth_proxy=true`
//      + `country_code=us` so we get a fully-rendered HTML page in USD.
//   3. Parse property cards out of the rendered HTML — Vrbo's
//      `<head>__NEXT_DATA__` SSR blob has the structured search data.
//   4. Filter by resort + bedrooms, return priced candidates.
//
// Cost: ~$0.0005 per JS-rendered request with stealth_proxy. Cached 5
// min in-process. Skipped when SCRAPINGBEE_API_KEY isn't set.

const PAGE_TIMEOUT_MS = 90_000;

export type ScrapingBeeVrboCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms: number | undefined;
  image: string | undefined;
  snippet: string;
};

type CacheEntry = { value: ScrapingBeeVrboCandidate[]; expiresAt: number };
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Match Browserbase path's card extraction logic so the two yield
// equivalent outputs when both fire.
function extractListingUrl(card: any): string | null {
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
      if (/^\/\d/.test(c)) return `https://www.vrbo.com${c.split("?")[0]}`;
      if (/vrbo\.com\/\d/.test(c)) return c.split("?")[0].replace(/^http:/, "https:");
    }
  }
  return null;
}

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

function extractTitle(card: any): string {
  return String(
    card?.headline ?? card?.title ?? card?.name ?? card?.propertyName ?? "Vrbo listing",
  ).slice(0, 120);
}

function extractBedrooms(card: any): number | undefined {
  const direct = card?.bedrooms ?? card?.beds ?? card?.numBedrooms;
  if (typeof direct === "number") return direct;
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

// Walk parsed JSON for arrays of objects that look like property cards
// (have a URL-ish field + a price-ish field).
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

export async function searchVrboViaScrapingBee(opts: {
  resortName: string;
  destination: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  /** Cap on results returned. Default 12. */
  limit?: number;
}): Promise<ScrapingBeeVrboCandidate[]> {
  const { resortName, destination, bedrooms, checkIn, checkOut } = opts;
  const limit = opts.limit ?? 12;

  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    console.warn(`[sb-vrbo] SCRAPINGBEE_API_KEY not set — skipping`);
    return [];
  }

  const cacheKey = `sb|${destination}|${bedrooms}|${checkIn}|${checkOut}`;
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

  const vrboParams = new URLSearchParams({
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
  const vrboUrl = `https://www.vrbo.com/search?${vrboParams.toString()}`;

  const sbParams = new URLSearchParams({
    api_key: apiKey,
    url: vrboUrl,
    render_js: "true",
    stealth_proxy: "true",
    country_code: "us",
    // We want the search results JSON; allowing all resources to load
    // ensures the SSR blob includes the property data.
    block_resources: "false",
  });

  const startedAt = Date.now();
  try {
    const resp = await fetch(`https://app.scrapingbee.com/api/v1/?${sbParams.toString()}`, {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`[sb-vrbo] HTTP ${resp.status} ${body.slice(0, 200)}`);
      searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
      return [];
    }
    const html = await resp.text();

    // Vrbo's SSR puts search results in a __NEXT_DATA__ JSON blob
    // (same shape Zillow's scraper looks for). Parse and walk for cards.
    let cards: any[] = [];
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nd = JSON.parse(nextDataMatch[1]);
        cards = findPropertyCards(nd);
      } catch (e: any) {
        console.warn(`[sb-vrbo] __NEXT_DATA__ parse error: ${e?.message ?? e}`);
      }
    }
    // Fallback: walk inline `window.__APOLLO_STATE__` or other JSON
    // blobs embedded in script tags.
    if (cards.length === 0) {
      const scriptBlobs = Array.from(html.matchAll(/<script[^>]*>([\s\S]{200,}?)<\/script>/g));
      for (const m of scriptBlobs) {
        const text = m[1];
        // Find embedded JSON objects starting with { and containing a
        // price/url shape. Bounded search to keep this cheap.
        if (!/(detailPageUrl|priceLockup|tripTotal)/.test(text)) continue;
        const start = text.indexOf("{");
        if (start === -1) continue;
        try {
          const candidate = JSON.parse(text.slice(start));
          const found = findPropertyCards(candidate);
          if (found.length > 0) {
            cards = found;
            break;
          }
        } catch { /* continue scanning */ }
      }
    }

    const seen = new Set<string>();
    const unique: any[] = [];
    for (const card of cards) {
      const u = extractListingUrl(card);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      unique.push(card);
    }

    const out: ScrapingBeeVrboCandidate[] = [];
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
      out.push({
        url,
        title,
        totalPrice: Math.round(total),
        nightlyPrice: total > 0 ? Math.round(total / nights) : 0,
        bedrooms: itemBeds,
        image: extractImage(card),
        snippet: String(card?.location?.description ?? card?.subtitle ?? "").slice(0, 160),
      });
    }
    out.sort((a, b) => a.totalPrice - b.totalPrice);
    const capped = out.slice(0, limit);

    console.log(
      `[sb-vrbo] destination="${destination}" ${bedrooms}BR ${checkIn}→${checkOut}: ` +
      `${unique.length} unique cards, ${capped.length} after filter ` +
      `(dropped: noResort=${droppedNoResort} wrongBeds=${droppedWrongBedrooms} noPrice=${droppedNoPrice}) ` +
      `· ${Date.now() - startedAt}ms`,
    );

    searchCache.set(cacheKey, { value: capped, expiresAt: Date.now() + CACHE_TTL_MS });
    return capped;
  } catch (e: any) {
    console.warn(`[sb-vrbo] error: ${e?.message ?? e}`);
    searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
    return [];
  }
}
