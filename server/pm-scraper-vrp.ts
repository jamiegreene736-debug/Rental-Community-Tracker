// Generic vrp_main inventory + rate scraper.
//
// vrp_main (a.k.a. "vrpjax") is a WordPress vacation-rental plugin used
// by multiple PMs we care about — Parrish Kauai, CB Island Vacations,
// and other independent shops in Hawaii / Mountain West. Every site
// using it exposes the SAME structure:
//
//   Sitemap:
//     {baseUrl}/?vrpsitemap=1
//     <urlset>...{baseUrl}/vrp/unit/<slug>...</urlset>
//
//   Unit page metadata (data-* attributes on #unit-data div):
//     data-unit-id         (numeric, used for getUnitRates)
//     data-unit-slug       (used for getUnitBookedDates `par=`)
//     data-unit-name       (display name)
//     data-unit-beds       (bedroom count) ← key field
//     data-unit-baths
//     data-unit-sleeps
//     data-unit-city / state / zip
//
//   Rate endpoint:
//     GET {baseUrl}/?vrpjax=1&act=getUnitRates&unitId={id}
//     Returns { "YYYY-MM-DD": { amount, chargebasis, ... }, ... }
//                                                          (or "null")
//
//   Availability endpoint:
//     GET {baseUrl}/?vrpjax=1&act=getUnitBookedDates&par={slug}
//     Returns {
//       bookedDates: ["M-D-YYYY", ...],
//       noCheckin:   ["M-D-YYYY", ...],
//       minLOS:      number,
//       minNights:   [{ start, end, minLOS }, ...]
//     }
//
// 3 GETs per matching unit; with 8-wide concurrency a typical 30-unit
// 3BR shortlist completes in ~5s warm. First call after deploy warms
// the metadata cache (~15-50s depending on inventory size, cached 7d).
//
// Adding a new vrp PM = one config block in `VRP_SITES` at the bottom
// of this file plus a call site in routes.ts.

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
};

export type VrpSiteConfig = {
  /** Display label surfaced in the candidate's `sourceLabel`. */
  label: string;
  /** Base URL — no trailing slash. e.g. "https://www.parrishkauai.com" */
  baseUrl: string;
};

type VrpUnitMeta = {
  url: string;
  slug: string;
  unitId: string;
  name: string;
  bedrooms: number;
  city: string;
  resortHaystack: string;
};

type CacheEntry<T> = { value: T; expiresAt: number };

// Per-site caches keyed by baseUrl. Module-scoped so multiple find-buy-in
// calls share warmed metadata.
const sitemapCacheBySite = new Map<string, CacheEntry<string[]>>();
const unitMetaCacheBySite = new Map<string, Map<string, CacheEntry<VrpUnitMeta | null>>>();
const SITEMAP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function unitMetaCache(baseUrl: string): Map<string, CacheEntry<VrpUnitMeta | null>> {
  let cache = unitMetaCacheBySite.get(baseUrl);
  if (!cache) {
    cache = new Map();
    unitMetaCacheBySite.set(baseUrl, cache);
  }
  return cache;
}

async function fetchSitemapUnitUrls(site: VrpSiteConfig): Promise<string[]> {
  const cached = sitemapCacheBySite.get(site.baseUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const r = await fetch(`${site.baseUrl}/?vrpsitemap=1`, {
      headers: { "User-Agent": HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      console.warn(`[vrp-discovery:${site.label}] sitemap fetch HTTP ${r.status}`);
      return cached?.value ?? [];
    }
    const xml = await r.text();
    const unitPathRe = new RegExp(
      `^${escapeRe(site.baseUrl)}/vrp/unit/[A-Za-z0-9_-]+-\\d+-\\d+$`,
    );
    const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g))
      .map((m) => m[1].trim())
      .filter((u) => unitPathRe.test(u));
    const deduped = Array.from(new Set(urls));
    sitemapCacheBySite.set(site.baseUrl, {
      value: deduped,
      expiresAt: Date.now() + SITEMAP_TTL_MS,
    });
    return deduped;
  } catch (e: any) {
    console.warn(`[vrp-discovery:${site.label}] sitemap error: ${e?.message ?? e}`);
    return cached?.value ?? [];
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickAttr(html: string, attr: string): string | null {
  const re = new RegExp(`data-${attr}=["']([^"']+)["']`);
  const m = html.match(re);
  return m ? m[1] : null;
}

async function fetchUnitMeta(site: VrpSiteConfig, url: string): Promise<VrpUnitMeta | null> {
  const cache = unitMetaCache(site.baseUrl);
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      cache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
      return null;
    }
    const html = await r.text();
    const unitId = pickAttr(html, "unit-id");
    const slug = pickAttr(html, "unit-slug");
    const name = pickAttr(html, "unit-name") ?? "";
    const beds = pickAttr(html, "unit-beds");
    const city = pickAttr(html, "unit-city") ?? "";
    if (!unitId || !slug || !beds) {
      cache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
      return null;
    }
    const bedrooms = parseInt(beds, 10);
    if (!Number.isFinite(bedrooms) || bedrooms <= 0) {
      cache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
      return null;
    }
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const pageTitle = (titleMatch?.[1] ?? "").trim();
    const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)/i);
    const metaDesc = (metaDescMatch?.[1] ?? "").trim();
    const meta: VrpUnitMeta = {
      url,
      slug,
      unitId,
      name,
      bedrooms,
      city,
      resortHaystack: `${name} ${pageTitle} ${metaDesc} ${city}`,
    };
    cache.set(url, { value: meta, expiresAt: Date.now() + META_TTL_MS });
    return meta;
  } catch {
    cache.set(url, { value: null, expiresAt: Date.now() + 60 * 60 * 1000 });
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

function isoToMdYyyy(iso: string): string {
  const [y, m, d] = iso.split("-").map((p) => parseInt(p, 10));
  return `${m}-${d}-${y}`;
}

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

export type VrpAvailableUnit = {
  url: string;
  name: string;
  bedrooms: number;
  totalPrice: number;
  nightlyPrice: number;
  unitId: string;
  /** Display label of the source PM (e.g. "Parrish Kauai"). */
  sourceLabel: string;
};

export async function findAvailableVrpUnits(opts: {
  site: VrpSiteConfig;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  resortName: string;
  /** Optional cap on number of priced units returned. Default 8. */
  limit?: number;
}): Promise<VrpAvailableUnit[]> {
  const { site, bedrooms, checkIn, checkOut, resortName, limit = 8 } = opts;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const resortTokens = normalize(resortName).split(" ").filter((t) => t.length >= 3);
  const matchesResort = (haystack: string): boolean => {
    if (resortTokens.length === 0) return true;
    const n = normalize(haystack);
    return resortTokens.every((t) => n.includes(t));
  };

  const startedAt = Date.now();
  const urls = await fetchSitemapUnitUrls(site);
  if (urls.length === 0) {
    console.warn(`[vrp-discovery:${site.label}] sitemap returned 0 units`);
    return [];
  }

  const metas = await withConcurrency(urls, 8, (url) => fetchUnitMeta(site, url));
  const matchingBedrooms = metas.filter(
    (m): m is VrpUnitMeta => m !== null && m.bedrooms === bedrooms,
  );
  const matchingResort = matchingBedrooms.filter((m) => matchesResort(m.resortHaystack));

  console.log(
    `[vrp-discovery:${site.label}] sitemap=${urls.length} metaResolved=${metas.filter(Boolean).length} ` +
    `matchingBedrooms=${matchingBedrooms.length} matchingResort=${matchingResort.length} ` +
    `(target=${bedrooms}BR @ "${resortName}")`,
  );

  if (matchingResort.length === 0) return [];

  const stayNights = enumerateNights(checkIn, checkOut);
  const stayNightsMD = new Set(stayNights.map((iso) => isoToMdYyyy(iso)));
  const checkInMD = isoToMdYyyy(checkIn);
  const rateEndpoint = `${site.baseUrl}/?vrpjax=1&act=getUnitRates&unitId=`;
  const bookedEndpoint = `${site.baseUrl}/?vrpjax=1&act=getUnitBookedDates&par=`;

  const priceOne = async (meta: VrpUnitMeta): Promise<VrpAvailableUnit | null> => {
    try {
      const [ratesResp, bookedResp] = await Promise.all([
        fetch(`${rateEndpoint}${encodeURIComponent(meta.unitId)}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(10000),
        }),
        fetch(`${bookedEndpoint}${encodeURIComponent(meta.slug)}`, {
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
      // `null` body — the PM doesn't publish public rates for this unit.
      if (rates === null || rates === undefined) return null;

      const bookedSet = new Set(booked.bookedDates ?? []);
      for (const md of stayNightsMD) {
        if (bookedSet.has(md)) return null;
      }
      const noCheckinSet = new Set(booked.noCheckin ?? []);
      if (noCheckinSet.has(checkInMD)) return null;

      const stayLength = stayNights.length;
      let requiredMinLOS = booked.minLOS ?? 1;
      if (Array.isArray(booked.minNights)) {
        for (const w of booked.minNights) {
          if (checkIn >= w.start && checkIn <= w.end) {
            requiredMinLOS = Math.max(requiredMinLOS, w.minLOS);
          }
        }
      }
      if (stayLength < requiredMinLOS) return null;

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
      if (pricedNights < Math.ceil(stayLength * 0.8)) return null;
      if (!(total > 0)) return null;

      return {
        url: meta.url,
        name: meta.name,
        bedrooms: meta.bedrooms,
        totalPrice: Math.round(total),
        nightlyPrice: Math.round(total / stayLength),
        unitId: meta.unitId,
        sourceLabel: site.label,
      };
    } catch {
      return null;
    }
  };

  const priced = await withConcurrency(matchingResort, 8, priceOne);
  const available = priced
    .filter((u): u is VrpAvailableUnit => u !== null)
    .sort((a, b) => a.totalPrice - b.totalPrice)
    .slice(0, limit);

  console.log(
    `[vrp-discovery:${site.label}] ${matchingResort.length} ${bedrooms}BR @ "${resortName}" units checked, ` +
    `${available.length} available for ${checkIn}→${checkOut} (${Date.now() - startedAt}ms)`,
  );
  return available;
}

// Registered vrp_main-powered PM sites. Adding a new one = one config
// block here plus a discovery promise in routes.ts find-buy-in.
export const VRP_SITES = {
  parrishKauai: {
    label: "Parrish Kauai",
    baseUrl: "https://www.parrishkauai.com",
  },
  cbIslandVacations: {
    label: "CB Island Vacations",
    baseUrl: "https://www.cbislandvacations.com",
  },
} as const satisfies Record<string, VrpSiteConfig>;
