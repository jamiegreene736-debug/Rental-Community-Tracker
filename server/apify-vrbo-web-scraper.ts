// Vrbo search via Apify's generic `web-scraper` actor (seventh path).
//
// Per Grok rec #2: the existing Vrbo-specific actors (easyapi,
// makework36) keep returning 0 raw items. The generic web-scraper
// actor is more mature and lets us inject custom Page Function JS
// that runs IN the browser — handles React hydration, scrolls to
// load lazy results, and reads the property list from the DOM after
// it settles.
//
// Different attack vector from our other Apify path:
//   - apify-vrbo.ts (easyapi) → vendor's pre-built Vrbo extractor.
//     We pass URL params, they return structured items. Currently 0.
//   - this module (apify/web-scraper) → generic browser automation.
//     We pass JS that drives the page and extracts data. Robust to
//     Vrbo frontend changes since we control the extractor.
//
// Tradeoffs:
//   - More expensive per call (~$0.05 for a full run vs ~$0.005)
//   - Slower (~30-90s vs ~10s)
//   - More flexible — can scroll, wait for hydration, click filters
//
// We only fire this if Trivago / Outscraper / our other Apify path
// haven't already provided priced Vrbo candidates — to keep the
// per-find-buy-in cost bounded. Implemented as a separate module so
// it can be wired in selectively.

const DEFAULT_ACTOR = "apify~web-scraper";
const DEFAULT_MAX_RESULTS = 20;
const RUN_TIMEOUT_MS = 180_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export type ApifyWebScraperVrboCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms: number | undefined;
  image: string | undefined;
  snippet: string;
};

type CacheEntry = { value: ApifyWebScraperVrboCandidate[]; expiresAt: number };
const searchCache = new Map<string, CacheEntry>();

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// The Page Function runs INSIDE the headless browser on Apify's side.
// It receives the Apify context, navigates to the search URL, waits
// for hydration, and returns an array of property objects. Apify
// serializes this function to a string when sending to the actor.
//
// We make it defensive across Vrbo's likely DOM shapes — `[data-stid]`,
// `[data-wdio]`, role attributes, common class fragments — and walk
// the rendered text for prices that match "$X total" patterns.
const PAGE_FUNCTION = `
async function pageFunction(context) {
  const { request, page, log } = context;
  log.info("Vrbo search: " + request.url);

  // Wait for the search results to populate. Try multiple selectors
  // that Vrbo has used historically.
  const selectors = [
    '[data-stid="search-results"]',
    '[data-stid="property-listing"]',
    'div[class*="search-results"]',
    'div[class*="PropertyListing"]',
    'article',
  ];
  for (const sel of selectors) {
    try { await page.waitForSelector(sel, { timeout: 8000 }); break; } catch {}
  }
  // Give React hydration a beat after first selector hits.
  await new Promise((r) => setTimeout(r, 3000));

  // Scroll a few times to trigger lazy-load.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await new Promise((r) => setTimeout(r, 1200));
  }

  // Extract property cards from the DOM.
  const items = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    // Try multiple card selectors; whichever matches, extract.
    const cardSelectors = [
      '[data-stid="property-listing"]',
      '[data-wdio="property-listing"]',
      'article[itemtype*="LodgingBusiness"]',
      'article',
      'div[class*="HitProperty"]',
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 3) break;
    }
    for (const card of cards) {
      const a = card.querySelector('a[href*="/"]');
      if (!a) continue;
      let href = a.getAttribute('href') || '';
      if (href.startsWith('/')) href = 'https://www.vrbo.com' + href;
      // Vrbo property URLs match /<id> or /<id>?...
      const idMatch = href.match(/vrbo\\.com\\/(\\d+)/);
      if (!idMatch) continue;
      const id = idMatch[1];
      if (seen.has(id)) continue;
      seen.add(id);

      // Extract price text — look for "$X" patterns near "total" / "trip"
      const text = card.innerText || '';
      let totalPrice = 0;
      let nightlyPrice = 0;
      const totalMatch = text.match(/\\$\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:total|trip|stay)/i);
      if (totalMatch) totalPrice = parseFloat(totalMatch[1].replace(/,/g, ''));
      const nightlyMatch = text.match(/\\$\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:\\/|per|a)?\\s*(?:night|nightly|nt)/i);
      if (nightlyMatch) nightlyPrice = parseFloat(nightlyMatch[1].replace(/,/g, ''));

      const titleEl = card.querySelector('[data-stid="property-headline"]') ||
                      card.querySelector('h3') ||
                      card.querySelector('[class*="Heading"]');
      const title = titleEl ? titleEl.textContent.trim() : (card.querySelector('img')?.alt || 'Vrbo listing');

      const imgEl = card.querySelector('img');
      const image = imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src')) : undefined;

      // Bedroom hint from text — "N BR" or "N bedroom"
      let bedrooms;
      const bedMatch = text.match(/(\\d+)\\s*(?:BR|bedroom)/i);
      if (bedMatch) bedrooms = parseInt(bedMatch[1], 10);

      out.push({ url: href.split('?')[0], title, totalPrice, nightlyPrice, bedrooms, image, snippet: text.slice(0, 160) });
    }
    return out;
  });

  log.info("Extracted " + items.length + " items");
  return { items };
}
`.trim();

export async function searchVrboViaApifyWebScraper(opts: {
  resortName: string;
  destination: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  /** Cap on results returned. Default 20. */
  limit?: number;
}): Promise<ApifyWebScraperVrboCandidate[]> {
  const { resortName, destination, bedrooms, checkIn, checkOut } = opts;
  const limit = opts.limit ?? DEFAULT_MAX_RESULTS;

  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.warn(`[apify-web-scraper-vrbo] APIFY_API_TOKEN not set — skipping`);
    return [];
  }
  const actor = (process.env.APIFY_VRBO_WEB_ACTOR || DEFAULT_ACTOR).replace("/", "~");

  const cacheKey = `${actor}|${destination}|${bedrooms}|${checkIn}|${checkOut}|${limit}`;
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
  const startUrl = `https://www.vrbo.com/search?${vrboParams.toString()}`;

  const startedAt = Date.now();
  try {
    const api = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: [{ url: startUrl }],
        pageFunction: PAGE_FUNCTION,
        proxyConfiguration: {
          useApifyProxy: true,
          apifyProxyGroups: ["RESIDENTIAL"],
        },
        // Page function returns { items } — apify writes that to dataset.
        maxRequestRetries: 1,
        // Limits to avoid runaway cost
        maxResultsPerCrawl: 1,
        maxRequestsPerCrawl: 1,
        // Short overall timeout in case Vrbo blocks the page
        navigationTimeoutSecs: 60,
      }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[apify-web-scraper-vrbo] HTTP ${r.status} ${body.slice(0, 300)}`);
      searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
      return [];
    }
    const dataset: any[] = await r.json().catch(() => []);
    if (!Array.isArray(dataset) || dataset.length === 0) {
      console.warn(`[apify-web-scraper-vrbo] empty dataset`);
      searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
      return [];
    }
    // Page function returns one row with `items: [...]`.
    const allItems: any[] = [];
    for (const row of dataset) {
      if (Array.isArray(row?.items)) allItems.push(...row.items);
      else if (row?.url) allItems.push(row); // fallback if actor flattened
    }

    const out: ApifyWebScraperVrboCandidate[] = [];
    let droppedNoResort = 0;
    let droppedWrongBedrooms = 0;
    let droppedNoPrice = 0;
    for (const item of allItems) {
      const url = String(item?.url ?? "").trim();
      if (!url || !/vrbo\.com\/\d+/.test(url)) continue;
      const title = String(item?.title ?? "Vrbo listing").slice(0, 120);
      const itemBeds = typeof item?.bedrooms === "number" ? item.bedrooms : undefined;
      const total = typeof item?.totalPrice === "number" && item.totalPrice > 0
        ? item.totalPrice
        : (typeof item?.nightlyPrice === "number" && item.nightlyPrice > 0
            ? item.nightlyPrice * nights
            : 0);

      const haystack = `${title} ${item?.snippet ?? ""}`;
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
        nightlyPrice: typeof item?.nightlyPrice === "number" && item.nightlyPrice > 0
          ? Math.round(item.nightlyPrice)
          : Math.round(total / nights),
        bedrooms: itemBeds,
        image: typeof item?.image === "string" ? item.image : undefined,
        snippet: String(item?.snippet ?? "").slice(0, 160),
      });
    }
    out.sort((a, b) => a.totalPrice - b.totalPrice);
    const capped = out.slice(0, limit);

    console.log(
      `[apify-web-scraper-vrbo] destination="${destination}" ${bedrooms}BR ${checkIn}→${checkOut}: ` +
      `${allItems.length} raw, ${capped.length} after filter ` +
      `(dropped: noResort=${droppedNoResort} wrongBeds=${droppedWrongBedrooms} noPrice=${droppedNoPrice}) ` +
      `· ${Date.now() - startedAt}ms`,
    );

    searchCache.set(cacheKey, { value: capped, expiresAt: Date.now() + CACHE_TTL_MS });
    return capped;
  } catch (e: any) {
    console.warn(`[apify-web-scraper-vrbo] error: ${e?.message ?? e}`);
    searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
    return [];
  }
}
