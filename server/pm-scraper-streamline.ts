// Streamline VRS rate scraper.
//
// Streamline VRS (https://streamlinevrs.com) is one of the largest
// commercial vacation-rental management platforms — hundreds of PM
// clients across the US. Every Streamline-powered site exposes the
// same WordPress AJAX gateway:
//
//   POST/GET {baseUrl}/wp-admin/admin-ajax.php
//     ?action=streamlinecore-api-request
//     &params={"methodName":"<X>","params":{...}}
//
// The auth-free methods we need:
//
//   GetPropertyListWordPress
//     params: {page_id: 1}
//     returns: { data: { property: [{
//       id, name, location_name, seo_page_name, short_description,
//       bedrooms_number, bathrooms_number, max_occupants,
//       resort_area_name, location_area_name, community,
//       price_data: {daily, currency}, price_str,
//       latitude, longitude, ... }, ...] } }
//
//   GetPropertyAvailabilityRawData
//     params: {unit_id, use_room_type_logic:"no", standard_pricing:1}
//     returns: { data: { range: {beginDate, endDate},
//       availability: "YYYNNYY..." (one char per day),
//       changeOver: "CCXXIO..." (per-day rules),
//       minStay: "4,4,5,..." (per-day min-stay) } }
//
//   GetPreReservationPrice
//     params: {unit_id, startdate, enddate, adults, children}
//     dates accept BOTH "MM/DD/YYYY" and "YYYY-MM-DD"
//     returns: { data: { price (base), taxes, total,
//       first_day_price, required_fees: [{name, value}],
//       vrbo_code, airbnb_code, ... } }
//
// Why this is cleaner than gather-vacations: Streamline gives us
// exact stay quotes including taxes + fees in a single AJAX call,
// vs parsing inline calendar HTML for date-by-date rates. The
// `total` field is the actual booking total a guest would pay.
//
// Discovery flow:
//   1. Walk inventory via GetPropertyListWordPress (cached 24h —
//      Alekona has 46 units, Princeville has 62; the response is
//      300KB-1.3MB, so caching matters).
//   2. Filter by bedroom exact-match + resort tokens (same approach
//      as Suite Paradise / vrp scrapers — community-aware filtering).
//   3. For each matching unit, fan out GetPreReservationPrice in
//      parallel batches of 8.
//   4. Drop unavailable units (status code != 0 / E0xxx). Sort by
//      total cost. Return up to `limit`.

import type { AgentResult } from "./pm-rate-agent";

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
};

// ─────────────────────────────────────────────────────────────────────────────
// Site config
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamlineSiteConfig {
  /** Base URL with no trailing slash, e.g. `https://alekonakauai.com`. */
  baseUrl: string;
  /** Display label for sourceLabel in find-buy-in candidates. */
  label: string;
}

/**
 * Compile-time list of Streamline-powered PM sites we surface in
 * find-buy-in. Add new entries by appending one block — the same
 * generic flow handles every Streamline tenant.
 *
 * Discovered via PR #331 batch auto-discovery + manual fingerprint
 * (PR #333) of streamline-core WP plugin script srcs.
 */
export const STREAMLINE_SITES = {
  alekonaKauai: {
    baseUrl: "https://alekonakauai.com",
    label: "Alekona Kauai",
  },
  princevilleVacationRentals: {
    baseUrl: "https://princevillevacationrentals.com",
    label: "Princeville Vacation Rentals",
  },
} satisfies Record<string, StreamlineSiteConfig>;

// ─────────────────────────────────────────────────────────────────────────────
// Caches
// ─────────────────────────────────────────────────────────────────────────────

type CacheEntry<T> = { value: T; expiresAt: number };
const PROPERTY_LIST_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const AVAILABILITY_TTL_MS = 60 * 60 * 1000;       // 1h
const FAIL_TTL_MS = 10 * 60 * 1000;               // short cache for failures

const propertyListCache = new Map<string, CacheEntry<StreamlineProperty[]>>();
const availabilityCache = new Map<string, CacheEntry<AvailabilityRaw | null>>();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StreamlineProperty {
  id: number;
  name: string;
  location_name: string | null;
  seo_page_name: string;
  short_description: string | null;
  bedrooms_number: number | null;
  bathrooms_number: number | null;
  max_occupants: number | null;
  resort_area_name: string | null;
  location_area_name: string | null;
  community: string | null;
  region: string | null;
  city: string | null;
  price_data: { daily?: number; currency?: string } | null;
  price_str: string | null;
  flyer_url: string | null;
}

interface AvailabilityRaw {
  range: { beginDate: string; endDate: string };
  availability: string;
  changeOver: string;
  minStay: string;
}

interface ReservationPriceResponse {
  unit_id?: number;
  price?: number;          // base rent for the stay (no taxes/fees)
  taxes?: number;
  total?: number;          // grand total (price + taxes + fees)
  first_day_price?: number;
  unit_name?: string;
  vrbo_code?: string | null;
  airbnb_code?: string | null;
  required_fees?: Array<{ name: string; value: number }>;
}

export interface StreamlineAvailableUnit {
  url: string;
  title: string;
  bedrooms: number;
  /** Total payable (price + taxes + required fees). */
  totalPrice: number;
  /** Total / nights — operator-comparable per-night number. */
  nightlyPrice: number;
  unitId: number;
  /** PM cross-listings, when Streamline knows them. Useful for de-duping. */
  vrboCode?: string;
  airbnbCode?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// AJAX gateway
// ─────────────────────────────────────────────────────────────────────────────

async function callStreamlineApi<T = unknown>(
  baseUrl: string,
  methodName: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  const url = new URL(`${baseUrl}/wp-admin/admin-ajax.php`);
  url.searchParams.set("action", "streamlinecore-api-request");
  url.searchParams.set("params", JSON.stringify({ methodName, params }));
  try {
    const r = await fetch(url.toString(), {
      headers: COMMON_HEADERS,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      redirect: "follow",
    });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const body = await r.text();
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { return { ok: false, reason: "non-JSON response" }; }
    // Streamline error envelope: {"status":{"code":"E00xx","description":"..."}}
    if (parsed?.status?.code) {
      return { ok: false, reason: `${parsed.status.code}: ${parsed.status.description ?? ""}`.slice(0, 240) };
    }
    if (parsed?.data === undefined) {
      return { ok: false, reason: "response missing .data" };
    }
    return { ok: true, data: parsed.data as T };
  } catch (e: any) {
    return { ok: false, reason: `network: ${e?.message ?? String(e)}`.slice(0, 200) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory walk
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPropertyList(site: StreamlineSiteConfig): Promise<StreamlineProperty[]> {
  const cacheKey = site.baseUrl;
  const cached = propertyListCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const r = await callStreamlineApi<{ property?: StreamlineProperty[] }>(
    site.baseUrl,
    "GetPropertyListWordPress",
    { page_id: 1 },
    { timeoutMs: 30_000 },
  );
  if (!r.ok) {
    console.warn(`[streamline:${site.label}] property list fetch failed: ${r.reason}`);
    return cached?.value ?? [];
  }
  const props = r.data.property ?? [];
  propertyListCache.set(cacheKey, { value: props, expiresAt: Date.now() + PROPERTY_LIST_TTL_MS });
  return props;
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability check (Y/N per day) — cheap pre-filter before pricing
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAvailability(site: StreamlineSiteConfig, unitId: number): Promise<AvailabilityRaw | null> {
  const cacheKey = `${site.baseUrl}#${unitId}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const r = await callStreamlineApi<AvailabilityRaw>(
    site.baseUrl,
    "GetPropertyAvailabilityRawData",
    { unit_id: unitId, use_room_type_logic: "no", standard_pricing: 1 },
  );
  if (!r.ok) {
    availabilityCache.set(cacheKey, { value: null, expiresAt: Date.now() + FAIL_TTL_MS });
    return null;
  }
  availabilityCache.set(cacheKey, { value: r.data, expiresAt: Date.now() + AVAILABILITY_TTL_MS });
  return r.data;
}

/**
 * Check whether every night in [checkIn, checkOut) is marked 'Y' in
 * the availability string. Returns:
 *   - true  → all nights available
 *   - false → at least one night blocked
 *   - null  → window is outside the calendar's known range, can't say
 */
function isWindowAvailable(avail: AvailabilityRaw, checkIn: string, checkOut: string): boolean | null {
  // beginDate is "MM/DD/YYYY" — parse into a UTC anchor at noon to
  // avoid DST edge cases.
  const beginParts = avail.range.beginDate.split("/");
  if (beginParts.length !== 3) return null;
  const [bm, bd, by] = beginParts.map((p) => parseInt(p, 10));
  if (!Number.isFinite(bm) || !Number.isFinite(bd) || !Number.isFinite(by)) return null;
  const beginMs = Date.UTC(by, bm - 1, bd, 12, 0, 0);
  const checkInMs = Date.UTC(
    parseInt(checkIn.slice(0, 4), 10),
    parseInt(checkIn.slice(5, 7), 10) - 1,
    parseInt(checkIn.slice(8, 10), 10),
    12, 0, 0,
  );
  const checkOutMs = Date.UTC(
    parseInt(checkOut.slice(0, 4), 10),
    parseInt(checkOut.slice(5, 7), 10) - 1,
    parseInt(checkOut.slice(8, 10), 10),
    12, 0, 0,
  );
  const startIdx = Math.round((checkInMs - beginMs) / 86_400_000);
  const endIdx = Math.round((checkOutMs - beginMs) / 86_400_000);
  if (startIdx < 0 || endIdx > avail.availability.length) return null;
  for (let i = startIdx; i < endIdx; i++) {
    if (avail.availability[i] !== "Y") return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exact stay quote — GetPreReservationPrice
// ─────────────────────────────────────────────────────────────────────────────

async function fetchReservationPrice(
  site: StreamlineSiteConfig,
  unitId: number,
  checkIn: string,
  checkOut: string,
): Promise<ReservationPriceResponse | null> {
  // ISO `YYYY-MM-DD` works fine on Streamline (verified against
  // alekonakauai + princevillevacationrentals in fingerprinting),
  // and avoids any locale ambiguity that MM/DD/YYYY introduces.
  const r = await callStreamlineApi<ReservationPriceResponse>(
    site.baseUrl,
    "GetPreReservationPrice",
    { unit_id: unitId, startdate: checkIn, enddate: checkOut, adults: 2, children: 0 },
  );
  if (!r.ok) return null;
  return r.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Public: single-URL rate scrape (mirrors pm-scraper-suite-paradise.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort: given a Streamline unit page URL (e.g.
 * https://alekonakauai.com/pili-mai-condo-15l/), resolve the unit_id
 * by fetching the page and grepping for `propertyId=NNNN`, then run
 * GetPreReservationPrice. Used by routes.ts's per-candidate
 * verification path.
 */
export async function scrapeStreamlineRate(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
  site: StreamlineSiteConfig;
}): Promise<AgentResult & { manualOnly?: boolean }> {
  const { url, checkIn, checkOut, site } = opts;
  // Resolve unit_id from the page HTML — Streamline's resortpro
  // controller injects ng-init="propertyId=NNNN;..." on every unit page.
  let unitId: number | null = null;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": COMMON_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/propertyId\s*=\s*(\d+)/);
      if (m) unitId = parseInt(m[1], 10);
    }
  } catch {}
  if (!unitId) {
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: null,
        totalPrice: null,
        nightlyPrice: null,
        dateMatch: null,
        reason: "Couldn't resolve Streamline unit_id from page HTML",
      },
      finalUrl: url,
      title: site.label,
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [`streamline-scraper: unit_id not found on ${url}`],
    };
  }
  const quote = await fetchReservationPrice(site, unitId, checkIn, checkOut);
  const nights = Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86_400_000,
    ),
  );
  if (quote && typeof quote.total === "number" && quote.total > 0) {
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: true,
        totalPrice: Math.round(quote.total),
        nightlyPrice: Math.round(quote.total / nights),
        dateMatch: true,
        reason: `${site.label} Streamline API: $${Math.round(quote.total).toLocaleString()} total for ${nights} nights (unit_id=${unitId})`,
      },
      finalUrl: url,
      title: site.label,
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [`streamline-scraper: priced unit ${unitId} at $${quote.total}`],
    };
  }
  return {
    ok: true,
    extracted: {
      isUnitPage: true,
      available: false,
      totalPrice: null,
      nightlyPrice: null,
      dateMatch: true,
      reason: `${site.label} Streamline API returned no price for ${checkIn} → ${checkOut}`,
    },
    finalUrl: url,
    title: site.label,
    screenshotBase64: "",
    iterations: 0,
    agentTrace: [`streamline-scraper: unit ${unitId} unpriced for window`],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: inventory discovery (mirrors findAvailableSuiteParadiseUnits / Vrp)
// ─────────────────────────────────────────────────────────────────────────────

export async function findAvailableStreamlineUnits(opts: {
  site: StreamlineSiteConfig;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  resortName: string;
  /** Cap on returned units. Default 8. */
  limit?: number;
}): Promise<StreamlineAvailableUnit[]> {
  const { site, bedrooms, checkIn, checkOut, resortName, limit = 8 } = opts;
  const startedAt = Date.now();

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const resortTokens = normalize(resortName).split(" ").filter((t) => t.length >= 3);
  const matchesResort = (haystack: string): boolean => {
    if (resortTokens.length === 0) return true;
    const n = normalize(haystack);
    return resortTokens.every((t) => n.includes(t));
  };

  const props = await fetchPropertyList(site);
  if (props.length === 0) {
    console.warn(`[streamline:${site.label}] property list returned 0 units`);
    return [];
  }

  const matchingBedrooms = props.filter((p) => p.bedrooms_number === bedrooms);

  const matchingResort = matchingBedrooms.filter((p) => {
    // Concatenate every text field that might mention the resort. Streamline's
    // schema is verbose; the relevant identifier could land in name,
    // location_name, resort_area_name, location_area_name, community, or
    // short_description depending on how the PM has tagged the unit.
    const haystack = [
      p.name,
      p.location_name,
      p.short_description,
      p.resort_area_name,
      p.location_area_name,
      p.community,
      p.region,
    ].filter(Boolean).join(" ");
    return matchesResort(haystack);
  });

  console.log(
    `[streamline:${site.label}] inventory=${props.length} matchingBedrooms=${matchingBedrooms.length} ` +
    `matchingResort=${matchingResort.length} (target=${bedrooms}BR @ "${resortName}")`,
  );
  if (matchingResort.length === 0) return [];

  // Phase 1 — availability gate (cheap, cached). Drop units whose
  // calendar already says the window is blocked. Saves a price call
  // for known-unavailable candidates.
  const availChecks = await withConcurrency(matchingResort, 8, async (p) => {
    const avail = await fetchAvailability(site, p.id);
    if (!avail) return { p, available: null as boolean | null };
    return { p, available: isWindowAvailable(avail, checkIn, checkOut) };
  });
  const availableOrUnknown = availChecks.filter((x) => x.available !== false);

  // Phase 2 — exact stay quote in parallel.
  const priced = await withConcurrency(availableOrUnknown, 8, async ({ p }) => {
    const quote = await fetchReservationPrice(site, p.id, checkIn, checkOut);
    if (!quote || typeof quote.total !== "number" || quote.total <= 0) return null;
    const nights = Math.max(
      1,
      Math.round(
        (new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86_400_000,
      ),
    );
    const unit: StreamlineAvailableUnit = {
      url: `${site.baseUrl}/${p.seo_page_name}/`,
      title: p.name,
      bedrooms: p.bedrooms_number ?? bedrooms,
      totalPrice: Math.round(quote.total),
      nightlyPrice: Math.round(quote.total / nights),
      unitId: p.id,
      vrboCode: quote.vrbo_code ?? undefined,
      airbnbCode: quote.airbnb_code ?? undefined,
    };
    return unit;
  });

  const available = priced
    .filter((u): u is StreamlineAvailableUnit => u !== null)
    .sort((a, b) => a.totalPrice - b.totalPrice)
    .slice(0, limit);

  console.log(
    `[streamline:${site.label}] ${matchingResort.length} ${bedrooms}BR @ "${resortName}" candidates checked, ` +
    `${available.length} priced+available for ${checkIn}→${checkOut} (${Date.now() - startedAt}ms)`,
  );
  return available;
}
