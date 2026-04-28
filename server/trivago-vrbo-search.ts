// Vrbo search via Trivago meta-search (sixth path).
//
// Trivago aggregates Vrbo (and other vacation-rental providers) with
// all-in totals already computed. Different attack vector from going
// at Vrbo directly — Trivago's anti-bot is materially less aggressive
// than Vrbo's, so ScrapingBee with `render_js=true&stealth_proxy=true`
// has a real chance of returning data where Vrbo direct doesn't.
//
// Per Grok recommendation #5. The actual selector advice was
// `[data-provider="Vrbo"][data-price]` but Trivago's DOM has shifted
// since Grok's training data, so this implementation is defensive:
//   1. Render the search page via ScrapingBee (with JS, stealth proxy,
//      US locale).
//   2. Parse __NEXT_DATA__ / inline JSON for property cards.
//   3. Filter cards whose deal source / provider mentions "vrbo".
//   4. Extract the all-in price (Trivago shows the all-in across all
//      providers in the deal lockup).
//
// Cached 5 min in-process. Cost: ~$0.0005 per render with stealth.

const PAGE_TIMEOUT_MS = 90_000;

export type TrivagoVrboCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms: number | undefined;
  image: string | undefined;
  snippet: string;
};

type CacheEntry = { value: TrivagoVrboCandidate[]; expiresAt: number };
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isVrboProvider(card: any): boolean {
  // Cards reference their lowest-price provider in various shapes
  // depending on Trivago's layout. Walk the card's stringified form
  // for "vrbo" — the deal source, the click-through URL, or a
  // provider name in nested objects.
  try {
    const blob = JSON.stringify(card).toLowerCase();
    return blob.includes("vrbo");
  } catch {
    return false;
  }
}

function extractTrivagoVrboUrl(card: any): string | null {
  // Trivago's click-through URLs typically wrap the destination
  // provider URL via tmcdn / r.trivago.com. We want the FINAL Vrbo
  // URL (vrbo.com/<id>). If we can't unwrap, store the Trivago
  // tracking URL; the operator clicks through and Trivago redirects.
  const candidates = [
    card?.dealUrl,
    card?.url,
    card?.itemUrl,
    card?.deal?.url,
    card?.cta?.url,
    card?.click?.url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      // Direct Vrbo URL beats a Trivago tracker.
      const directVrbo = c.match(/vrbo\.com\/\d+/);
      if (directVrbo) return `https://www.${directVrbo[0]}`;
      if (/^https?:\/\//.test(c)) return c;
    }
  }
  return null;
}

function extractTotalPrice(card: any): number {
  const numericFields = [
    card?.deal?.price,
    card?.price?.amount,
    card?.priceTotal,
    card?.totalPrice,
    card?.totalRate,
  ];
  for (const n of numericFields) {
    if (typeof n === "number" && n > 0) return n;
    if (typeof n === "string") {
      const m = n.match(/(\d[\d,]*)/);
      if (m) {
        const v = parseFloat(m[1].replace(/,/g, ""));
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  }
  // String shapes: "$1,820 total" / "$1,820 per stay" / "$1,820"
  const formatted =
    card?.priceFormatted ??
    card?.deal?.priceFormatted ??
    card?.priceLabel ??
    card?.formattedPrice;
  if (typeof formatted === "string") {
    const m = formatted.match(/\$\s*([\d,]+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1].replace(/,/g, ""));
  }
  return 0;
}

function extractTitle(card: any): string {
  return String(
    card?.name ?? card?.title ?? card?.headline ?? card?.itemName ?? "Vrbo via Trivago",
  ).slice(0, 120);
}

function extractBedrooms(card: any): number | undefined {
  const direct = card?.bedrooms ?? card?.beds;
  if (typeof direct === "number") return direct;
  const subtitle = card?.subtitle ?? card?.description ?? card?.attributes ?? "";
  const m = String(subtitle).match(/(\d+)\s*(?:BR|bedroom)/i);
  if (m) return parseInt(m[1], 10);
  return undefined;
}

function extractImage(card: any): string | undefined {
  const candidates = [card?.image?.url, card?.images?.[0]?.url, card?.images?.[0], card?.thumbnail];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
  }
  return undefined;
}

// Recursively walk parsed JSON for arrays of property-card-shaped
// objects. Same approach as the Browserbase/ScrapingBee Vrbo paths.
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
        (extractTrivagoVrboUrl(sample) || extractTotalPrice(sample) > 0)
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

export async function searchVrboViaTrivago(opts: {
  resortName: string;
  destination: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  /** Cap on results returned. Default 12. */
  limit?: number;
}): Promise<TrivagoVrboCandidate[]> {
  const { resortName, destination, bedrooms, checkIn, checkOut } = opts;
  const limit = opts.limit ?? 12;

  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    console.warn(`[trivago-vrbo] SCRAPINGBEE_API_KEY not set — skipping`);
    return [];
  }

  const cacheKey = `tv|${destination}|${bedrooms}|${checkIn}|${checkOut}`;
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

  // Trivago's search URL pattern. They accept multiple URL shapes;
  // the modern query-string form is the most stable.
  const trivagoParams = new URLSearchParams({
    search: destination,
    checkin: checkIn,
    checkout: checkOut,
    rooms: `1-${bedrooms}`, // 1 room with N adults — Trivago's minBedrooms approximation
  });
  const trivagoUrl = `https://www.trivago.com/search?${trivagoParams.toString()}`;

  const sbParams = new URLSearchParams({
    api_key: apiKey,
    url: trivagoUrl,
    render_js: "true",
    stealth_proxy: "true",
    country_code: "us",
    block_resources: "false",
  });

  const startedAt = Date.now();
  try {
    const resp = await fetch(`https://app.scrapingbee.com/api/v1/?${sbParams.toString()}`, {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`[trivago-vrbo] HTTP ${resp.status} ${body.slice(0, 200)}`);
      searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
      return [];
    }
    const html = await resp.text();

    // Trivago uses Next.js with __NEXT_DATA__ for SSR data delivery.
    let cards: any[] = [];
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nd = JSON.parse(nextDataMatch[1]);
        cards = findPropertyCards(nd).filter(isVrboProvider);
      } catch (e: any) {
        console.warn(`[trivago-vrbo] __NEXT_DATA__ parse error: ${e?.message ?? e}`);
      }
    }
    // Fallback: scan inline scripts for embedded JSON state blobs.
    if (cards.length === 0) {
      const scriptBlobs = Array.from(html.matchAll(/<script[^>]*>([\s\S]{200,}?)<\/script>/g));
      for (const m of scriptBlobs) {
        const text = m[1];
        if (!/(vrbo|dealUrl|priceTotal)/i.test(text)) continue;
        const start = text.indexOf("{");
        if (start === -1) continue;
        try {
          const candidate = JSON.parse(text.slice(start));
          const found = findPropertyCards(candidate).filter(isVrboProvider);
          if (found.length > 0) {
            cards = found;
            break;
          }
        } catch { /* keep scanning */ }
      }
    }

    const seen = new Set<string>();
    const unique: any[] = [];
    for (const card of cards) {
      const u = extractTrivagoVrboUrl(card);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      unique.push(card);
    }

    const out: TrivagoVrboCandidate[] = [];
    let droppedNoResort = 0;
    let droppedWrongBedrooms = 0;
    let droppedNoPrice = 0;
    for (const card of unique) {
      const url = extractTrivagoVrboUrl(card);
      if (!url) continue;
      const title = extractTitle(card);
      const itemBeds = extractBedrooms(card);
      const total = extractTotalPrice(card);

      const haystack = `${title} ${card?.location ?? ""} ${card?.subtitle ?? ""} ${card?.description ?? ""}`;
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
        snippet: String(card?.subtitle ?? card?.description ?? "").slice(0, 160),
      });
    }
    out.sort((a, b) => a.totalPrice - b.totalPrice);
    const capped = out.slice(0, limit);

    console.log(
      `[trivago-vrbo] destination="${destination}" ${bedrooms}BR ${checkIn}→${checkOut}: ` +
      `${unique.length} unique vrbo cards, ${capped.length} after filter ` +
      `(dropped: noResort=${droppedNoResort} wrongBeds=${droppedWrongBedrooms} noPrice=${droppedNoPrice}) ` +
      `· ${Date.now() - startedAt}ms`,
    );

    searchCache.set(cacheKey, { value: capped, expiresAt: Date.now() + CACHE_TTL_MS });
    return capped;
  } catch (e: any) {
    console.warn(`[trivago-vrbo] error: ${e?.message ?? e}`);
    searchCache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
    return [];
  }
}
