// Parrish Kauai inventory + rate scraper.
//
// PK runs a custom WordPress vacation-rental plugin (vrp_main / vrpjax).
// Every unit page is enriched with `data-unit-*` attributes that give us
// clean structured metadata server-side, AND there are two cheap public
// AJAX endpoints that return the full rate calendar + booked dates per
// unit — no auth, no headers, no Browserbase session needed.
//
// Recon (April 2026):
//
//   Sitemap:
//     https://www.parrishkauai.com/?vrpsitemap=1   (~370+ units)
//
//   Unit page metadata (data-* attributes on `#unit-data`):
//     data-unit-id         (numeric, used for getUnitRates)
//     data-unit-slug       (used for getUnitBookedDates `par=`)
//     data-unit-name       (display name)
//     data-unit-beds       (bedroom count) ← key field
//     data-unit-baths
//     data-unit-sleeps
//     data-unit-city / state / zip
//
//   Rate endpoint:
//     GET /?vrpjax=1&act=getUnitRates&unitId={id}
//       Returns { "YYYY-MM-DD": { amount, chargebasis, ... }, ... }
//
//   Availability endpoint:
//     GET /?vrpjax=1&act=getUnitBookedDates&par={slug}
//       Returns {
//         bookedDates: ["M-D-YYYY", ...],
//         noCheckin:   ["M-D-YYYY", ...],   // can't ARRIVE on these
//         minLOS:      number,              // baseline minimum nights
//         minNights:   [{ start, end, minLOS }, ...]   // per-window overrides
//       }
//
// The two endpoints together let us answer "is this unit available for
// [checkIn, checkOut) at base rate $X" without ever opening Chrome.
// 3 GETs per matching unit; with 8-wide concurrency a 30-unit 3BR
// shortlist completes in ~5s warm.

const SITEMAP_URL = "https://www.parrishkauai.com/?vrpsitemap=1";
const UNIT_URL_RE = /^https:\/\/www\.parrishkauai\.com\/vrp\/unit\/[A-Za-z0-9_]+-\d+-\d+$/;
const RATE_ENDPOINT = "https://www.parrishkauai.com/?vrpjax=1&act=getUnitRates&unitId=";
const BOOKED_ENDPOINT = "https://www.parrishkauai.com/?vrpjax=1&act=getUnitBookedDates&par=";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
};

type PkUnitMeta = {
  url: string;
  slug: string;
  unitId: string;
  name: string;
  bedrooms: number;
  city: string;
  /**
   * Concatenation of h1 + page title + meta description for resort
   * filtering. PK units span all of Kauai (Poipu, Princeville, Hanalei,
   * Anini, Wailua, …); without resort filtering a Poipu Kai search
   * would return Princeville rentals indiscriminately.
   */
  resortHaystack: string;
};

type CacheEntry<T> = { value: T; expiresAt: number };
const sitemapCache: { entry: CacheEntry<string[]> | null } = { entry: null };
const unitMetaCache = new Map<string, CacheEntry<PkUnitMeta | null>>();
const SITEMAP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

async function fetchSitemapUnitUrls(): Promise<string[]> {
  const cached = sitemapCache.entry;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const r = await fetch(SITEMAP_URL, {
      headers: { "User-Agent": HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      console.warn(`[pk-discovery] sitemap fetch HTTP ${r.status}`);
      return cached?.value ?? [];
    }
    const xml = await r.text();
    const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g))
      .map((m) => m[1].trim())
      .filter((u) => UNIT_URL_RE.test(u));
    const deduped = Array.from(new Set(urls));
    sitemapCache.entry = { value: deduped, expiresAt: Date.now() + SITEMAP_TTL_MS };
    return deduped;
  } catch (e: any) {
    console.warn(`[pk-discovery] sitemap error: ${e?.message ?? e}`);
    return cached?.value ?? [];
  }
}

function pickAttr(html: string, attr: string): string | null {
  const re = new RegExp(`data-${attr}=["']([^"']+)["']`);
  const m = html.match(re);
  return m ? m[1] : null;
}

async function fetchUnitMeta(url: string): Promise<PkUnitMeta | null> {
  const cached = unitMetaCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      unitMetaCache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
      return null;
    }
    const html = await r.text();
    const unitId = pickAttr(html, "unit-id");
    const slug = pickAttr(html, "unit-slug");
    const name = pickAttr(html, "unit-name") ?? "";
    const beds = pickAttr(html, "unit-beds");
    const city = pickAttr(html, "unit-city") ?? "";
    if (!unitId || !slug || !beds) {
      unitMetaCache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
      return null;
    }
    const bedrooms = parseInt(beds, 10);
    if (!Number.isFinite(bedrooms) || bedrooms <= 0) {
      unitMetaCache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
      return null;
    }
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const pageTitle = (titleMatch?.[1] ?? "").trim();
    const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)/i);
    const metaDesc = (metaDescMatch?.[1] ?? "").trim();
    const meta: PkUnitMeta = {
      url,
      slug,
      unitId,
      name,
      bedrooms,
      city,
      resortHaystack: `${name} ${pageTitle} ${metaDesc} ${city}`,
    };
    unitMetaCache.set(url, { value: meta, expiresAt: Date.now() + META_TTL_MS });
    return meta;
  } catch {
    unitMetaCache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
    return null;
  }
}

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

// PK booked-dates uses M-D-YYYY (no leading zeros). Convert ISO YYYY-MM-DD → M-D-YYYY.
function isoToMdYyyy(iso: string): string {
  const [y, m, d] = iso.split("-").map((p) => parseInt(p, 10));
  return `${m}-${d}-${y}`;
}

// Generate the list of NIGHTS in [checkIn, checkOut) — i.e. checkIn
// inclusive, checkOut exclusive. Vacation rentals charge per night, not
// per calendar-day-occupied, so a 12/20 → 1/2 stay is 13 nights:
// 12/20, 12/21, ..., 1/1 (charged), 1/2 (checkout, not charged).
function enumerateNights(checkIn: string, checkOut: string): string[] {
  const result: string[] = [];
  const start = new Date(checkIn + "T12:00:00Z").getTime();
  const end = new Date(checkOut + "T12:00:00Z").getTime();
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    result.push(`${y}-${m}-${day}`);
  }
  return result;
}

export type ParrishKauaiAvailableUnit = {
  url: string;
  name: string;
  bedrooms: number;
  totalPrice: number;
  nightlyPrice: number;
  unitId: string;
};

export async function findAvailableParrishKauaiUnits(opts: {
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  resortName: string;
  /** Optional cap on number of priced units returned. Default 8. */
  limit?: number;
}): Promise<ParrishKauaiAvailableUnit[]> {
  const { bedrooms, checkIn, checkOut, resortName, limit = 8 } = opts;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const resortTokens = normalize(resortName).split(" ").filter((t) => t.length >= 3);
  const matchesResort = (haystack: string): boolean => {
    if (resortTokens.length === 0) return true;
    const n = normalize(haystack);
    return resortTokens.every((t) => n.includes(t));
  };

  const startedAt = Date.now();
  const urls = await fetchSitemapUnitUrls();
  if (urls.length === 0) {
    console.warn(`[pk-discovery] sitemap returned 0 units`);
    return [];
  }

  // Phase 1: warm metadata for any URLs we haven't seen, in parallel.
  const metas = await withConcurrency(urls, 8, fetchUnitMeta);
  const matchingBedrooms = metas.filter(
    (m): m is PkUnitMeta => m !== null && m.bedrooms === bedrooms,
  );
  const matchingResort = matchingBedrooms.filter((m) => matchesResort(m.resortHaystack));

  console.log(
    `[pk-discovery] sitemap=${urls.length} metaResolved=${metas.filter(Boolean).length} ` +
    `matchingBedrooms=${matchingBedrooms.length} matchingResort=${matchingResort.length} ` +
    `(target=${bedrooms}BR @ "${resortName}")`,
  );

  if (matchingResort.length === 0) return [];

  // Phase 2: pricing + availability for each match, in parallel.
  const stayNights = enumerateNights(checkIn, checkOut);
  const stayNightsMD = new Set(stayNights.map((iso) => isoToMdYyyy(iso)));
  const checkInMD = isoToMdYyyy(checkIn);

  const priceOne = async (meta: PkUnitMeta): Promise<ParrishKauaiAvailableUnit | null> => {
    try {
      const [ratesResp, bookedResp] = await Promise.all([
        fetch(`${RATE_ENDPOINT}${encodeURIComponent(meta.unitId)}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(10000),
        }),
        fetch(`${BOOKED_ENDPOINT}${encodeURIComponent(meta.slug)}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(10000),
        }),
      ]);
      if (!ratesResp.ok || !bookedResp.ok) return null;
      const ratesText = await ratesResp.text();
      const bookedText = await bookedResp.text();
      let rates: Record<string, { amount?: string }> = {};
      let booked: { bookedDates?: string[]; noCheckin?: string[]; minLOS?: number; minNights?: Array<{ start: string; end: string; minLOS: number }> } = {};
      try { rates = JSON.parse(ratesText); } catch { return null; }
      try { booked = JSON.parse(bookedText); } catch { return null; }

      // Availability: no booked dates inside the stay window.
      const bookedSet = new Set(booked.bookedDates ?? []);
      for (const md of stayNightsMD) {
        if (bookedSet.has(md)) return null;
      }

      // No-checkin guard: can't ARRIVE on a noCheckin date.
      const noCheckinSet = new Set(booked.noCheckin ?? []);
      if (noCheckinSet.has(checkInMD)) return null;

      // minLOS / minNights guard: per-window override applies if any
      // window covers the check-in date.
      const stayLength = stayNights.length;
      let requiredMinLOS = booked.minLOS ?? 1;
      if (Array.isArray(booked.minNights)) {
        for (const w of booked.minNights) {
          // Window dates are ISO YYYY-MM-DD per recon.
          if (checkIn >= w.start && checkIn <= w.end) {
            requiredMinLOS = Math.max(requiredMinLOS, w.minLOS);
          }
        }
      }
      if (stayLength < requiredMinLOS) return null;

      // Priced: sum nightly amounts across stay nights. ISO-keyed rates.
      let total = 0;
      let pricedNights = 0;
      for (const iso of stayNights) {
        const r = rates[iso];
        const amt = r ? parseFloat(String(r.amount ?? "0")) : 0;
        if (Number.isFinite(amt) && amt > 0) {
          total += amt;
          pricedNights++;
        }
      }
      // Require at least 80% of nights to have a posted rate — guards
      // against partial calendar leaks (sometimes recent dates are
      // priced but distant ones aren't yet).
      if (pricedNights < Math.ceil(stayLength * 0.8)) return null;
      if (!(total > 0)) return null;

      return {
        url: meta.url,
        name: meta.name,
        bedrooms: meta.bedrooms,
        totalPrice: Math.round(total),
        nightlyPrice: Math.round(total / stayLength),
        unitId: meta.unitId,
      };
    } catch {
      return null;
    }
  };

  const priced = await withConcurrency(matchingResort, 8, priceOne);
  const available = priced
    .filter((u): u is ParrishKauaiAvailableUnit => u !== null)
    .sort((a, b) => a.totalPrice - b.totalPrice)
    .slice(0, limit);

  console.log(
    `[pk-discovery] ${matchingResort.length} ${bedrooms}BR @ "${resortName}" units checked, ` +
    `${available.length} available for ${checkIn}→${checkOut} (${Date.now() - startedAt}ms)`,
  );
  return available;
}
