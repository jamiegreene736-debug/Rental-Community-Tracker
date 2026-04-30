// Gather Vacations rate scraper.
//
// gathervacations.com runs a customised vrp_main fork — the plugin
// loads (homepage and unit pages contain `vrp_main`/`vrpjax` markers)
// but the standard rate-quote AJAX (`?vrpjax=1&act=getUnitRates`) is
// stripped — calling it returns 0 bytes. So the canonical
// pm-scraper-vrp.ts path doesn't work.
//
// What does work: every unit page server-renders a 12-month
// availability calendar inline. The shape:
//
//   <td class="p-1 md:!p-2" title="Tuesday, May 5, 2026">
//     05<div class='cal-rate'>$300</div>
//   </td>
//
// Cell semantics (derived from the HTML class+content combinations
// seen on /vrp/unit/176/):
//   - `class="pad"` → month-edge padding, ignore
//   - `class="passed highlighted"` → past date, ignore (no cal-rate)
//   - `class="highlighted"` (future, no cal-rate) → BOOKED / unavailable
//   - cal-rate present, price > $1 → bookable for that night
//   - cal-rate present, price = $1 → arrival/departure-only
//     placeholder (transition night for an existing booking)
//   - `aDate`/`dDate` modifiers → check-in-only / check-out-only;
//     conservatively treated as unbookable for "stay through" nights
//
// Algorithm:
//   1. Fetch the homepage once (cached 24h) to enumerate every
//      `/vrp/unit/N/` URL.
//   2. For each unit URL we haven't seen, fetch the page once (cached
//      1h — calendar changes as bookings come in, but a 1h staleness
//      window is fine for buy-in scans). Extract:
//        - numberOfBedrooms from JSON-LD <script type="application/ld+json">
//        - unit name from <title> ("Pili Mai 7M | 3 BD | Koloa, HI | …")
//        - resort haystack (title + h1 + meta-description)
//        - rate calendar Map<YYYY-MM-DD, price>
//   3. Filter to matching bedrooms + resort tokens.
//   4. Sum the calendar over [checkIn, checkOut). Any missing or
//      $1-placeholder night → unavailable. All nights priced → quote.
//
// Caching: the page response is the bottleneck (each page ~850KB
// because the inline calendar covers ~12 months). 1h TTL keeps repeat
// find-buy-in calls cheap without going stale. With ~24 units, cold
// cache is ~5-8s wall at 8-wide concurrency.

import type { AgentResult } from "./pm-rate-agent";

const BASE_URL = "https://gathervacations.com";
const HOMEPAGE_URL = `${BASE_URL}/`;
const SITEMAP_URL = `${BASE_URL}/?vrpsitemap=1`;
const PM_LABEL = "Gather Vacations";

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// ─────────────────────────────────────────────────────────────────────────────
// Caches
// ─────────────────────────────────────────────────────────────────────────────

type CacheEntry<T> = { value: T; expiresAt: number };
const SITEMAP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PAGE_TTL_MS = 60 * 60 * 1000;          // 1h — calendar may shift

// `null` value = page fetch failed / parse failed; cached briefly
// (10 min) so we retry sooner than the happy path.
const UNIT_PAGE_TTL_MS_FAIL = 10 * 60 * 1000;

const sitemapCache: { entry: CacheEntry<string[]> | null } = { entry: null };
const unitPageCache = new Map<string, CacheEntry<GatherUnitData | null>>();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GatherVacationsAvailableUnit {
  url: string;
  title: string;
  bedrooms: number;
  totalPrice: number;
  nightlyPrice: number;
  unitId: string;
}

interface GatherUnitData {
  url: string;
  unitId: string;
  /** Display title (h1 if present, falls back to <title>'s left segment). */
  title: string;
  /** From JSON-LD `numberOfBedrooms`, falls back to "X BD" in <title>. */
  bedrooms: number;
  /** Concatenation of title + h1 + meta-description for resort filtering. */
  resortHaystack: string;
  /** Per-night rate map. Missing keys = booked/unavailable. */
  calendar: Map<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sitemap discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull every `/vrp/unit/N/` path. `?vrpsitemap=1` returns 200 OK with
 * HTML (the customised fork's quirk) — but the HTML still embeds all
 * unit hrefs, so we extract them with a regex regardless of
 * content-type. Falls back to the homepage if the sitemap path is
 * unreachable.
 */
async function fetchUnitUrls(): Promise<string[]> {
  const cached = sitemapCache.entry;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const sources = [SITEMAP_URL, HOMEPAGE_URL];
  let html = "";
  for (const src of sources) {
    try {
      const r = await fetch(src, {
        headers: COMMON_HEADERS,
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });
      if (r.ok) {
        html = await r.text();
        break;
      }
    } catch (e: any) {
      console.warn(`[gv-discovery] ${src} fetch error: ${e?.message ?? e}`);
    }
  }
  if (!html) {
    console.warn(`[gv-discovery] both sitemap and homepage unreachable`);
    return cached?.value ?? [];
  }

  // Match `/vrp/unit/123/` and `/vrp/unit/123` (with or without trailing slash).
  const matches = Array.from(html.matchAll(/\/vrp\/unit\/(\d+)\/?/g));
  const ids = new Set<string>();
  for (const m of matches) ids.add(m[1]);
  const urls = Array.from(ids).map((id) => `${BASE_URL}/vrp/unit/${id}/`);
  sitemapCache.entry = { value: urls, expiresAt: Date.now() + SITEMAP_TTL_MS };
  return urls;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit page parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the JSON-LD VacationRental block to pull numberOfBedrooms.
 * The block sits inside a `<script type="application/ld+json">` near
 * the bottom of every unit page. JSON-LD is the most reliable signal
 * — bedroom counts elsewhere on the page (the title's "X BD") are a
 * fallback.
 */
function extractBedroomsFromJsonLd(html: string): number | null {
  const blocks = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (!blocks) return null;
  for (const block of blocks) {
    const inner = block.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? "";
    const m = inner.match(/"numberOfBedrooms"\s*:\s*(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 20) return n;
    }
  }
  return null;
}

function extractBedroomsFromTitle(title: string): number | null {
  const m = title.match(/(\d+)\s*BD\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 20) return n;
  }
  return null;
}

/**
 * Parse a calendar cell's `title="Tuesday, May  5, 2026"` into ISO
 * YYYY-MM-DD. The page uses `&nbsp;`-padded day numbers (single-digit
 * days have an extra space), so we normalise whitespace.
 */
function parseCellTitle(title: string): string | null {
  const cleaned = title.replace(/\s+/g, " ").trim();
  const m = cleaned.match(/[A-Za-z]+,\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MONTH_NAMES[m[1].toLowerCase()];
  if (!month) return null;
  const year = m[3];
  const day = m[2].padStart(2, "0");
  return `${year}-${String(month).padStart(2, "0")}-${day}`;
}

/**
 * Walk every `<td>` in the rate calendar and build a date→price map.
 *
 * We allow the second `class="..."` attribute that gathervacations
 * emits as a layout artefact (a malformed double-class on every cell);
 * the regex captures both the semantic class (`highlighted`/`passed`/
 * `pad`/`aDate`/`dDate`) and the layout class without conflating them.
 */
function parseCalendar(html: string): Map<string, number> {
  const out = new Map<string, number>();
  // Match <td class="..." [class="..."]? title="..." …> NN [<div class='cal-rate'>$X</div>] </td>
  const tdRe = /<td\s+class=["']([^"']*)["'](?:\s+class=["'][^"']*["'])?\s+title=["']([^"']+)["'][^>]*>\s*\d+\s*(?:<div\s+class=['"]cal-rate['"]>\$([\d,]+)<\/div>)?\s*<\/td>/g;
  // `Array.from` over matchAll keeps tsconfig's older iteration target happy
  // (other scrapers in this codebase use the same pattern).
  for (const m of Array.from(html.matchAll(tdRe))) {
    const cls = m[1] ?? "";
    const title = m[2] ?? "";
    const rateRaw = m[3];
    if (!rateRaw) continue;                  // no cal-rate = booked / past / pad
    if (/\bpassed\b/i.test(cls)) continue;   // past date
    if (/\bpad\b/i.test(cls)) continue;      // padding
    // Conservative: aDate (arrival-only) and dDate (departure-only)
    // cells aren't fully bookable as stay-through nights — skip them.
    // Some PMs price these as $1 placeholders; either way we don't
    // count them as available stay nights.
    if (/\baDate\b|\bdDate\b/.test(cls)) continue;
    const date = parseCellTitle(title);
    if (!date) continue;
    const price = parseInt(rateRaw.replace(/,/g, ""), 10);
    if (!Number.isFinite(price) || price <= 1) continue;
    out.set(date, price);
  }
  return out;
}

function extractTitleSegments(html: string): { title: string; pageTitle: string; h1: string; metaDesc: string } {
  const pageTitleM = html.match(/<title>([^<]+)<\/title>/i);
  const pageTitle = (pageTitleM?.[1] ?? "").trim();
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = (h1M?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const metaM = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)/i);
  const metaDesc = (metaM?.[1] ?? "").trim();
  // Display title: prefer h1; fall back to the leftmost segment of <title> ("Pili Mai 7M | 3 BD | Koloa, HI | …" → "Pili Mai 7M").
  const titleLeft = pageTitle.split("|")[0]?.trim() ?? "";
  return { title: h1 || titleLeft || pageTitle, pageTitle, h1, metaDesc };
}

async function fetchUnitData(url: string): Promise<GatherUnitData | null> {
  const cached = unitPageCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const r = await fetch(url, {
      headers: COMMON_HEADERS,
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!r.ok) {
      unitPageCache.set(url, { value: null, expiresAt: Date.now() + UNIT_PAGE_TTL_MS_FAIL });
      return null;
    }
    const html = await r.text();
    const { title, pageTitle, h1, metaDesc } = extractTitleSegments(html);
    const bedrooms = extractBedroomsFromJsonLd(html) ?? extractBedroomsFromTitle(pageTitle);
    if (!bedrooms) {
      unitPageCache.set(url, { value: null, expiresAt: Date.now() + UNIT_PAGE_TTL_MS_FAIL });
      return null;
    }
    const idMatch = url.match(/\/vrp\/unit\/(\d+)/);
    const unitId = idMatch?.[1] ?? "";
    if (!unitId) {
      unitPageCache.set(url, { value: null, expiresAt: Date.now() + UNIT_PAGE_TTL_MS_FAIL });
      return null;
    }
    const calendar = parseCalendar(html);
    const data: GatherUnitData = {
      url,
      unitId,
      title,
      bedrooms,
      resortHaystack: `${title} ${pageTitle} ${h1} ${metaDesc}`,
      calendar,
    };
    unitPageCache.set(url, { value: data, expiresAt: Date.now() + PAGE_TTL_MS });
    return data;
  } catch (e: any) {
    console.warn(`[gv-discovery] unit fetch error ${url}: ${e?.message ?? e}`);
    unitPageCache.set(url, { value: null, expiresAt: Date.now() + UNIT_PAGE_TTL_MS_FAIL });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stay pricing
// ─────────────────────────────────────────────────────────────────────────────

function enumerateNights(checkIn: string, checkOut: string): string[] {
  const start = new Date(checkIn + "T12:00:00Z").getTime();
  const end = new Date(checkOut + "T12:00:00Z").getTime();
  const out: string[] = [];
  for (let t = start; t < end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Sum nightly rates for `[checkIn, checkOut)`. Returns null if any
 * night is missing or marked $1 (we filter those out at parse time
 * already). All-or-nothing semantics — we'd rather drop the candidate
 * than quote a partial stay.
 */
function priceStay(
  cal: Map<string, number>,
  checkIn: string,
  checkOut: string,
): { totalPrice: number; nightlyPrice: number; nights: number } | null {
  const nights = enumerateNights(checkIn, checkOut);
  if (nights.length === 0) return null;
  let total = 0;
  for (const n of nights) {
    const rate = cal.get(n);
    if (!rate) return null;
    total += rate;
  }
  return {
    totalPrice: total,
    nightlyPrice: Math.round(total / nights.length),
    nights: nights.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency helper
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
// Public: single-URL rate scraper (mirrors pm-scraper-suite-paradise.ts shape)
// ─────────────────────────────────────────────────────────────────────────────

export async function scrapeGatherVacationsRate(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
}): Promise<AgentResult & { manualOnly?: boolean }> {
  const { url, checkIn, checkOut } = opts;
  const data = await fetchUnitData(url);
  if (!data) {
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: null,
        totalPrice: null,
        nightlyPrice: null,
        dateMatch: null,
        reason: "Couldn't fetch or parse Gather Vacations unit page",
      },
      finalUrl: url,
      title: PM_LABEL,
      screenshotBase64: "",
      iterations: 0,
      agentTrace: ["gv-scraper: page fetch/parse failed"],
    };
  }
  const priced = priceStay(data.calendar, checkIn, checkOut);
  if (priced) {
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: true,
        totalPrice: priced.totalPrice,
        nightlyPrice: priced.nightlyPrice,
        dateMatch: true,
        reason: `Gather Vacations inline calendar: $${priced.totalPrice.toLocaleString()} total for ${priced.nights} nights`,
      },
      finalUrl: url,
      title: PM_LABEL,
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [`gv-scraper: priced unit ${data.unitId} at $${priced.totalPrice}`],
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
      reason: `Gather Vacations: one or more nights unavailable for ${checkIn} → ${checkOut}`,
    },
    finalUrl: url,
    title: PM_LABEL,
    screenshotBase64: "",
    iterations: 0,
    agentTrace: [`gv-scraper: unit ${data.unitId} not available for window`],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: inventory discovery (mirrors findAvailableSuiteParadiseUnits)
// ─────────────────────────────────────────────────────────────────────────────

export async function findAvailableGatherVacationsUnits(opts: {
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  resortName: string;
  /** Cap on returned units. Default 8. */
  limit?: number;
}): Promise<GatherVacationsAvailableUnit[]> {
  const { bedrooms, checkIn, checkOut, resortName, limit = 8 } = opts;
  const startedAt = Date.now();

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const resortTokens = normalize(resortName).split(" ").filter((t) => t.length >= 3);
  const matchesResort = (haystack: string): boolean => {
    if (resortTokens.length === 0) return true;
    const n = normalize(haystack);
    return resortTokens.every((t) => n.includes(t));
  };

  const urls = await fetchUnitUrls();
  if (urls.length === 0) {
    console.warn(`[gv-discovery] sitemap returned 0 units`);
    return [];
  }

  // Single fetch per unit gets us metadata AND calendar — there's no
  // second pricing call (unlike Suite Paradise's rcapi roundtrip).
  const datas = await withConcurrency(urls, 8, fetchUnitData);

  // Filter: bedroom exact-match AND resort-token presence.
  const matchingBedrooms = datas
    .filter((d): d is GatherUnitData => d !== null && d.bedrooms === bedrooms);
  const matchingResort = matchingBedrooms.filter((d) => matchesResort(d.resortHaystack));

  console.log(
    `[gv-discovery] sitemap=${urls.length} dataResolved=${datas.filter(Boolean).length} ` +
    `matchingBedrooms=${matchingBedrooms.length} matchingResort=${matchingResort.length} ` +
    `(target=${bedrooms}BR @ "${resortName}")`,
  );

  if (matchingResort.length === 0) return [];

  // Price each matching unit using its already-fetched calendar.
  const priced: GatherVacationsAvailableUnit[] = [];
  for (const d of matchingResort) {
    const stay = priceStay(d.calendar, checkIn, checkOut);
    if (!stay) continue;
    priced.push({
      url: d.url,
      title: d.title,
      bedrooms: d.bedrooms,
      totalPrice: stay.totalPrice,
      nightlyPrice: stay.nightlyPrice,
      unitId: d.unitId,
    });
  }

  const available = priced
    .sort((a, b) => a.totalPrice - b.totalPrice)
    .slice(0, limit);

  console.log(
    `[gv-discovery] ${matchingResort.length} ${bedrooms}BR @ "${resortName}" units checked, ` +
    `${available.length} available for ${checkIn}→${checkOut} (${Date.now() - startedAt}ms)`,
  );
  return available;
}
