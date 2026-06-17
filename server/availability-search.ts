// Lightweight inventory-counter for the availability scanner.
//
// Original design (Apr 2026, removed): one SearchAPI airbnb-engine call
// per (window × bedroom-count). At 52 weeks × 2 BR groups × 11 properties
// × daily runs = ~73,000 calls/year/property in SearchAPI spend (~$70+).
// Worse, the engine doesn't reliably return prices for short-notice or
// far-future windows, so the per-window detail wasn't paying off anyway.
//
// New design: one cheap Google `site:airbnb.com/rooms` search per
// (resort × bedroom-count), counting unique listing IDs that exist for
// that resort. Apply the same count across every window — listings at
// a given resort don't appear/disappear week-to-week, so the count is
// effectively static over any single 24-month scan. Drops scan cost
// to ~3 SearchAPI calls per property per run (one per unique BR).
//
// Trade-off: doesn't model real-time availability depletion (e.g. a busy
// July 4 week where most listings are booked). For those edge cases, the
// daily re-scan + manual force-block override is the safety net.

import {
  BUY_IN_MARKETS,
  BUY_IN_MARKET_LOCATIONS,
  haversineMiles,
  resolveBuyInMarket,
  searchLocationForBuyInMarket,
} from "@shared/buy-in-market";

import {
  pickRandom7NightInSeason,
  applyAirbnbBiasAndCombo,
  type SeasonKey as SharedSeasonKey,
  type RegionType,
  getCommunityRegion,
} from "@shared/pricing-rates";

export type CandidateListing = {
  id: string;          // Airbnb listing id (extracted from /rooms/<id> URL)
  url: string;
  title: string;
};

export type CountByBedrooms = {
  count: number;
  sample: CandidateListing[];   // first ~5 for the detail panel
  raw: number;                   // raw search hits before dedup
};

export type CountOptions = {
  resortName: string | null;     // e.g. "Kaha Lani" — used in the quoted query
  community: string;             // fallback when resortName is null
  bedrooms: number;
  apiKey: string;
};

export async function countAirbnbCandidates(opts: CountOptions): Promise<CountByBedrooms> {
  const qualifier = opts.resortName ? `"${opts.resortName}"` : `"${opts.community}"`;
  // Two complementary queries — `site:airbnb.com/rooms` to force per-listing
  // pages (not search results), with the bedroom count phrased in the
  // common ways listings spell it out.
  const q = `site:airbnb.com/rooms ${qualifier} (${opts.bedrooms}BR OR "${opts.bedrooms} bedroom")`;
  const sp = new URLSearchParams({
    engine: "google",
    q,
    num: "20",
    api_key: opts.apiKey,
  });
  try {
    const r = await fetch(`https://www.searchapi.io/api/v1/search?${sp.toString()}`);
    if (!r.ok) return { count: 0, sample: [], raw: 0 };
    const data = await r.json() as any;
    const organic: any[] = Array.isArray(data?.organic_results) ? data.organic_results : [];

    // De-dupe by listing id — Google returns the same listing under
    // multiple URLs sometimes (locale prefixes, query params).
    const seen = new Map<string, CandidateListing>();
    for (const o of organic) {
      const link = String(o?.link ?? "");
      const m = link.match(/airbnb\.com\/(?:[a-z]{2}-[a-z]{2}\/)?rooms\/(?:plus\/)?(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      // Best-effort BR check on the title — listings that don't mention
      // the right BR count get skipped to keep the count meaningful.
      const title = String(o?.title ?? "");
      const snippet = String(o?.snippet ?? "");
      const txt = `${title} ${snippet}`.toLowerCase();
      // Match "<n>BR", "<n> bedroom", "<n>-bedroom"
      const brRe = new RegExp(`(?:^|[^\\d])${opts.bedrooms}\\s*(?:br\\b|-?bedroom)`, "i");
      // Reject when title clearly says a different BR count
      const otherBrMatch = txt.match(/(\d)\s*(?:br\b|-?bedroom)/i);
      if (otherBrMatch && parseInt(otherBrMatch[1], 10) !== opts.bedrooms && !brRe.test(txt)) {
        continue;
      }
      seen.set(id, { id, url: `https://www.airbnb.com/rooms/${id}`, title });
    }

    const sample = Array.from(seen.values()).slice(0, 5);
    return { count: seen.size, sample, raw: organic.length };
  } catch (e: any) {
    console.error(`[availability-search] count error ${opts.resortName ?? opts.community} ${opts.bedrooms}BR: ${e?.message ?? e}`);
    return { count: 0, sample: [], raw: 0 };
  }
}

// Given the per-bedroom counts and the unit config, work out how many
// independent complete sets exist. Group slots by BR count: for each
// group, sets = floor(count / units-of-that-BR-per-set). Take the min.
//
// E.g. a 6BR listing made of 3BR + 3BR needs 2 distinct 3BR listings
// per set. With 7 candidates → floor(7/2) = 3 sets.
//
// E.g. a 5BR listing made of 3BR + 2BR needs 1 of each per set. With
// 7 3BR candidates and 4 2BR candidates → min(7, 4) = 4 sets.
export function computeSetsFromCounts(
  unitSlots: Array<{ bedrooms: number }>,
  countsByBR: Record<number, number>,
): number {
  const need: Record<number, number> = {};
  for (const slot of unitSlots) {
    need[slot.bedrooms] = (need[slot.bedrooms] ?? 0) + 1;
  }
  let max = Infinity;
  for (const [brStr, n] of Object.entries(need)) {
    const br = parseInt(brStr, 10);
    const have = countsByBR[br] ?? 0;
    max = Math.min(max, Math.floor(have / n));
  }
  return max === Infinity ? 0 : max;
}

export function verdictFor(maxSets: number, minSets: number): "open" | "tight" | "blocked" {
  if (maxSets < minSets) return "blocked";
  if (maxSets <= minSets + 1) return "tight";
  return "open";
}

// ── Airbnb date-availability check (the sourceability gate's black-out test) ──
// Operator directive 2026-06-15: a calendar window is blacked out ONLY when a
// live SearchAPI Airbnb search for those EXACT dates can't surface the unit
// sizes the listing is built from. A 5BR = 3BR + 2BR needs at least one
// available 3BR AND one available 2BR for the dates (a [3,3] plan needs two
// distinct available 3BRs). No VRBO, no pricing/comp confidence — pure
// availability. If Airbnb has the set, the window stays open.
//
// Uses the SAME engine=airbnb, dated, entire-home query the market-rate sampler
// already uses (server/availability-scanner.ts `searchAirbnb`), so this is the
// channel the operator means by "the Airbnb API". A keyless / errored / rate-
// limited search returns ok:false so the gate fail-safe-SKIPs (never blocks on
// a failed search).

export type AirbnbPlanAvailability = {
  ok: boolean;                         // false ⇒ search failed / no key ⇒ caller SKIPs (fail-safe)
  setsAvailable: number;               // complete unit-sets Airbnb can supply for the dates
  perBedroom: Record<number, number>;  // available entire-home listings per required bedroom size
  detail: string;                      // e.g. "3BR×4, 2BR×9 → 4 set(s)"
};

// One engine=airbnb search for a single bedroom size on specific dates.
// Returns the count of available entire-home listings that meet OR exceed the
// requested size (a 4BR can back a 3BR slot), or -1 on any failure so the
// caller can treat it as "unknown" rather than "zero available".
async function countAvailableAirbnbForDates(opts: {
  searchLocation: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  apiKey: string;
}): Promise<number> {
  const params = new URLSearchParams({
    engine: "airbnb",
    check_in_date: opts.checkIn,
    check_out_date: opts.checkOut,
    adults: "2",
    bedrooms: String(opts.bedrooms),
    type_of_place: "entire_home",
    currency: "USD",
    api_key: opts.apiKey,
    q: opts.searchLocation,
  });
  try {
    const r = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
    if (!r.ok) return -1;
    const data = (await r.json()) as any;
    if (data?.error) {
      console.warn(`[availability-search] airbnb avail ${opts.searchLocation} ${opts.bedrooms}BR: ${data.error}`);
      return -1;
    }
    const props: any[] = Array.isArray(data?.properties) ? data.properties : [];
    // Engine `bedrooms` is a floor; count listings meeting or exceeding the
    // requested size. Unparsed bedroom counts are credited (the dated search
    // already constrained the result), so we never under-count availability.
    let n = 0;
    for (const p of props) {
      const pb = typeof p?.bedrooms === "number" ? p.bedrooms : null;
      if (pb == null || pb >= opts.bedrooms) n++;
    }
    return n;
  } catch (e: any) {
    console.error(`[availability-search] airbnb avail error ${opts.searchLocation} ${opts.bedrooms}BR ${opts.checkIn}: ${e?.message ?? e}`);
    return -1;
  }
}

export async function checkAirbnbAvailabilityForPlan(opts: {
  community: string;
  unitSlots: Array<{ bedrooms: number }>;
  checkIn: string;
  checkOut: string;
  apiKey?: string;
}): Promise<AirbnbPlanAvailability> {
  const apiKey = opts.apiKey ?? process.env.SEARCHAPI_API_KEY;
  if (!apiKey) {
    return { ok: false, setsAvailable: 0, perBedroom: {}, detail: "no SEARCHAPI_API_KEY — fail-safe skip" };
  }
  // One search per DISTINCT required bedroom size (a [3,2] plan → two searches).
  const need: Record<number, number> = {};
  for (const s of opts.unitSlots) need[s.bedrooms] = (need[s.bedrooms] ?? 0) + 1;
  // Resolve the search to the TOWN level ("Wailua, Hawaii" / "Bonita Springs,
  // Florida"), NOT the single resort string. A resort-anchored query (e.g.
  // "Kaha Lani Resort, Wailua, Kauai, Hawaii") can return ZERO entire-home
  // listings of a required size for a thin resort even when the surrounding
  // town has plenty — and a zero from a SUCCESSFUL search becomes a BLOCK (not
  // a skip). That is the exact false-zero the market-rate sampler had to
  // geo-widen away (PR #684, market-rate-geo-widening). The town is also where
  // we'd actually source the buy-in, so it's the correct scope for "can we
  // source this set". The 2-sweep confirmation guard still backstops a transient
  // town-level zero.
  const market = BUY_IN_MARKET_LOCATIONS[opts.community];
  const town = market?.city && market?.state ? `${market.city}, ${market.state}` : null;
  const searchLocation = town || searchLocationForBuyInMarket(opts.community) || `${opts.community}, Hawaii`;
  const perBedroom: Record<number, number> = {};
  for (const brStr of Object.keys(need)) {
    const br = Number(brStr);
    const count = await countAvailableAirbnbForDates({
      searchLocation,
      bedrooms: br,
      checkIn: opts.checkIn,
      checkOut: opts.checkOut,
      apiKey,
    });
    // A failed search for ANY required size ⇒ the whole window is "unknown" ⇒
    // fail-safe skip (we must not block on an incomplete picture).
    if (count < 0) {
      return { ok: false, setsAvailable: 0, perBedroom, detail: `Airbnb search error for ${br}BR — fail-safe skip` };
    }
    perBedroom[br] = count;
  }
  const setsAvailable = computeSetsFromCounts(opts.unitSlots, perBedroom);
  const detail =
    Object.entries(perBedroom)
      .map(([br, n]) => `${br}BR×${n}`)
      .join(", ") + ` → ${setsAvailable} set(s)`;
  return { ok: true, setsAvailable, perBedroom, detail };
}

// ── Profit-aware sourcing cost (operator direction 2026-06-17) ───────────────
// The availability check above answers "do the unit sizes exist for the dates".
// In a LIQUID market (e.g. Poipu) inventory almost never runs dry, so the real
// risk is PROFIT: a week sold far out can later cost MORE to source than we sold
// it for (the "Lea" case — sold a 6BR for $12,187, cheapest combo now $18,617).
// This block derives an ASSUMED buy-in cost from the SAME engine=airbnb fetch
// used for availability — NO extra sidecar, NO new API surface — by taking the
// HIGH END (operator's pick: p90/near-max) of the same-community, same-size,
// OWN-LISTINGS-EXCLUDED nightly rates. The gate then blocks a window only when
// that assumed cost beats our real Guesty sell price.
//
// Three precision rules the 2026-06-17 live calibration proved load-bearing:
//  (1) engine=airbnb has NO `bedrooms` field — read `accommodations`.
//  (2) `q=` returns an ISLAND-WIDE pool — require the community ALIAS in the
//      title AND a loose geo radius (town / resort / "Poipu" queries are
//      identical; geo alone can't separate Poipu Kai from Makahuena/Brenneckes/
//      Pili Mai, which sit 0.5-0.9mi apart and all map to "Koloa, Hawaii").
//  (3) EXCLUDE our own listings — ours appear in the results at our own asking
//      price, which would pin assumedCost ≈ sellPrice and hide every real loss.

/** Exact bedroom count from an engine=airbnb listing. The API never populates a
 *  top-level `bedrooms` field (always null); the real count lives in
 *  `accommodations` (e.g. ["3 bedrooms","4 beds"]). "4 beds" must NOT read as
 *  bedrooms. Studio ⇒ 0. Returns null when unparseable. */
export function exactBedroomsFromAirbnbListing(p: any): number | null {
  const acc: any[] = Array.isArray(p?.accommodations) ? p.accommodations : [];
  for (const a of acc) {
    const s = String(a).toLowerCase();
    const m = s.match(/(\d+)\s*bedroom/);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n)) return n; }
    if (/\bstudio\b/.test(s)) return 0;
  }
  return null;
}

/** Same-community membership: the listing name/title/description must match the
 *  community's alias regex (BUY_IN_MARKETS[community].aliases). This is the
 *  precision layer — a geo radius alone can't mean "same community" in the
 *  overlapping Koloa cluster. When a community has no alias signal we fail OPEN
 *  on membership (count it) so a missing config can never manufacture a block. */
export function matchesCommunityName(p: any, aliases: RegExp[] | undefined): boolean {
  if (!aliases || aliases.length === 0) return true;
  const hay = [p?.title, p?.name, p?.description].filter(Boolean).map(String).join(" ");
  return aliases.some((re) => re.test(hay));
}

/** Is this Airbnb result one of OUR OWN managed listings? Ours surface in the
 *  search at our own asking price; including them pins the assumed cost to the
 *  sell price and masks every real loss. Conservative normalized lead-match
 *  against our Guesty listing names/nicknames (community + size, before
 *  "Sleeps N"). */
export function isOwnListing(p: any, ownNames: string[]): boolean {
  if (!ownNames || ownNames.length === 0) return false;
  const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const hay = norm([p?.title, p?.name].filter(Boolean).join(" "));
  if (!hay) return false;
  for (const raw of ownNames) {
    const own = norm(raw);
    if (!own) continue;
    const lead = own.split(" sleeps ")[0].trim();   // distinctive lead, drop the "sleeps N" tail
    if (lead.length >= 8 && hay.includes(lead)) return true;
  }
  return false;
}

/** Percentile of a numeric list with a small-sample outlier trim: when n ≥ 4,
 *  drop the single largest value before taking the percentile, so one luxury
 *  listing can't spike a thin pool (the live p90 swung run-to-run on n=6 from a
 *  single outlier appearing/vanishing). Returns null on an empty list. */
export function trimmedPercentile(values: number[], q: number): number | null {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pool = xs.length >= 4 ? xs.slice(0, -1) : xs;
  if (pool.length === 1) return pool[0];
  const k = (pool.length - 1) * Math.min(1, Math.max(0, q));
  const f = Math.floor(k), c = Math.ceil(k);
  return f === c ? pool[f] : pool[f] * (c - k) + pool[c] * (k - f);
}

/** Cheapest assumed sourcing cost for the plan, from the per-size high-end
 *  nightlies. Considers the literal combo (sum of every slot) AND a single unit
 *  of the total bedroom size, taking the cheaper PRICED path. null when no path
 *  can be priced (⇒ caller fail-safe-opens; never blocks on missing cost). */
export function assumedComboCost(
  unitSlots: Array<{ bedrooms: number }>,
  highEndNightlyBySize: Record<number, number | null>,
  nights: number,
): number | null {
  const n = Math.max(1, nights);
  let comboNightly = 0, comboOk = unitSlots.length > 0;
  for (const s of unitSlots) {
    const v = highEndNightlyBySize[s.bedrooms];
    if (v == null || !(v > 0)) { comboOk = false; break; }
    comboNightly += v;
  }
  const comboCost = comboOk ? comboNightly * n : null;
  const totalBr = unitSlots.reduce((acc, u) => acc + u.bedrooms, 0);
  const singleV = highEndNightlyBySize[totalBr];
  const singleCost = singleV != null && singleV > 0 ? singleV * n : null;
  const candidates = [comboCost, singleCost].filter((c): c is number => c != null && c > 0);
  return candidates.length ? Math.round(Math.min(...candidates)) : null;
}

// In-memory dedup cache so every property in the same community shares ONE
// SearchApi fetch per (town, size, week) within a sweep (the daily sweep runs
// all properties back-to-back). Success-only + short TTL so a transient error
// is retried next sweep, never cached. This is the town-keyed dedup that keeps
// the deduped monthly call volume (~7k) well inside the plan.
type CellCache = { at: number; props: any[] };
const _cellCache = new Map<string, CellCache>();
const CELL_TTL_MS = 6 * 60 * 60 * 1000; // 6h — dedups one daily sweep, expires before the next
export function clearAirbnbCellCache(): void { _cellCache.clear(); }

async function fetchAirbnbCell(
  searchLocation: string, bedrooms: number, checkIn: string, checkOut: string, apiKey: string,
): Promise<{ ok: boolean; props: any[] }> {
  const key = `${searchLocation}|${bedrooms}|${checkIn}|${checkOut}`;
  const hit = _cellCache.get(key);
  if (hit && Date.now() - hit.at < CELL_TTL_MS) return { ok: true, props: hit.props };
  const params = new URLSearchParams({
    engine: "airbnb", check_in_date: checkIn, check_out_date: checkOut, adults: "2",
    bedrooms: String(bedrooms), type_of_place: "entire_home", currency: "USD", api_key: apiKey, q: searchLocation,
  });
  try {
    const r = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
    if (!r.ok) return { ok: false, props: [] };
    const data = (await r.json()) as any;
    if (data?.error) { console.warn(`[availability-search] airbnb cell ${searchLocation} ${bedrooms}BR: ${data.error}`); return { ok: false, props: [] }; }
    const props: any[] = Array.isArray(data?.properties) ? data.properties : [];
    _cellCache.set(key, { at: Date.now(), props });
    return { ok: true, props };
  } catch (e: any) {
    console.error(`[availability-search] airbnb cell error ${searchLocation} ${bedrooms}BR ${checkIn}: ${e?.message ?? e}`);
    return { ok: false, props: [] };
  }
}

export type AirbnbPlanProfitAnalysis = {
  ok: boolean;                                    // false ⇒ caller fail-safe SKIPs
  setsAvailable: number;                          // complete same-community sets Airbnb can supply
  perBedroom: Record<number, number>;             // same-community own-excluded available count per slot size
  highEndNightlyBySize: Record<number, number | null>; // trimmed-p90 nightly per size (for cost)
  detail: string;
};

const DEFAULT_GEO_RADIUS_MILES = 3.0;

/** One engine=airbnb fetch per distinct size (slot sizes + the total bedroom
 *  size as a single-unit sourcing alternative), filtered to exact-BR +
 *  same-community alias + own-excluded + within geo radius, returning both the
 *  availability set count AND the high-end (trimmed-p90) nightly per size.
 *  Fail-safe: any cell error / missing key ⇒ ok:false. */
export async function analyzeAirbnbPlanForProfit(opts: {
  community: string;
  unitSlots: Array<{ bedrooms: number }>;
  checkIn: string;
  checkOut: string;
  apiKey?: string;
  costPercentile?: number;   // default 0.90 (operator's "high end" pick)
  ownNames?: string[];       // our own Guesty listing names to exclude from the cost pool
  geoRadiusMiles?: number;   // default 3.0 (loose; alias is the precision layer)
}): Promise<AirbnbPlanProfitAnalysis> {
  const apiKey = opts.apiKey ?? process.env.SEARCHAPI_API_KEY;
  if (!apiKey) return { ok: false, setsAvailable: 0, perBedroom: {}, highEndNightlyBySize: {}, detail: "no SEARCHAPI_API_KEY — fail-safe skip" };

  const market = BUY_IN_MARKETS[opts.community];
  const loc = BUY_IN_MARKET_LOCATIONS[opts.community];
  const aliases = market?.aliases;
  const town = loc?.city && loc?.state ? `${loc.city}, ${loc.state}` : null;
  const searchLocation = town || searchLocationForBuyInMarket(opts.community) || `${opts.community}, Hawaii`;
  const center = loc && typeof loc.lat === "number" && typeof loc.lng === "number" ? { lat: loc.lat, lng: loc.lng } : null;
  const radius = opts.geoRadiusMiles ?? DEFAULT_GEO_RADIUS_MILES;
  const pct = opts.costPercentile ?? 0.90;
  const ownNames = opts.ownNames ?? [];
  const nights = Math.max(1, Math.round((+new Date(opts.checkOut) - +new Date(opts.checkIn)) / 86_400_000));

  const slotSizes = Array.from(new Set(opts.unitSlots.map((s) => s.bedrooms)));
  const totalBr = opts.unitSlots.reduce((acc, u) => acc + u.bedrooms, 0);
  const sizesToFetch = Array.from(new Set([...slotSizes, totalBr]));

  const perBedroom: Record<number, number> = {};
  const highEndNightlyBySize: Record<number, number | null> = {};

  for (const br of sizesToFetch) {
    const cell = await fetchAirbnbCell(searchLocation, br, opts.checkIn, opts.checkOut, apiKey);
    if (!cell.ok) {
      return { ok: false, setsAvailable: 0, perBedroom, highEndNightlyBySize, detail: `Airbnb cell error for ${br}BR — fail-safe skip` };
    }
    let count = 0;
    const nightlies: number[] = [];
    for (const p of cell.props) {
      if (exactBedroomsFromAirbnbListing(p) !== br) continue;          // exact size (param is a MIN filter)
      if (!matchesCommunityName(p, aliases)) continue;                 // same community (alias)
      if (isOwnListing(p, ownNames)) continue;                         // never price against ourselves
      if (center) {
        const lat = Number(p?.gps_coordinates?.latitude), lng = Number(p?.gps_coordinates?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng) && haversineMiles(center.lat, center.lng, lat, lng) > radius) continue;
        // missing coords ⇒ credit (fail-safe; Airbnb jitters/omits coordinates)
      }
      count++;
      const total = Number(p?.price?.extracted_total_price ?? 0);
      if (total > 0) nightlies.push(total / nights);
    }
    if (slotSizes.includes(br)) perBedroom[br] = count;
    highEndNightlyBySize[br] = trimmedPercentile(nightlies, pct);
  }

  const setsAvailable = computeSetsFromCounts(opts.unitSlots, perBedroom);
  const detail =
    Object.entries(perBedroom).map(([br, n]) => `${br}BR×${n}`).join(", ") +
    ` → ${setsAvailable} set(s); p${Math.round(pct * 100)} ` +
    Object.entries(highEndNightlyBySize).map(([br, v]) => `${br}BR=${v == null ? "-" : Math.round(v)}`).join("/");
  return { ok: true, setsAvailable, perBedroom, highEndNightlyBySize, detail };
}

// ── Price-side helpers (Phase 3) ────────────────────────────────────────
// The cheap site-search counts inventory but doesn't carry prices. For
// pricing, legacy availability callers now delegate to the multichannel
// sidecar scan so "cheapest" means the same Airbnb/VRBO/Booking visible-UI
// evidence used by Operations/find-buy-in.

export type SeasonKey = "LOW" | "HIGH" | "HOLIDAY";

export type SeasonalCheapestPerBR = Record<SeasonKey, Record<number, number | null>>;
//                                  ^ season       ^ bedrooms  cheapest nightly

export type FindCheapestOptions = {
  resortName: string | null;
  community: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  q: string;
  city?: string;
  state?: string;
  propertyId?: number;
  searchName?: string;
  listingTitle?: string;
  bounds?: { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number };
  apiKey: string;
};

// Returns the cheapest visible OTA sidecar nightly for the given window. This
// used to be a single SearchAPI Airbnb call; keep the function name for older
// availability callers, but route through the same multichannel sidecar layer
// used by Operations/find-buy-in so all "cheapest" surfaces follow the same
// visible-dropdown/no-URL-injection policy.
export async function findCheapestPricedNightly(opts: FindCheapestOptions): Promise<number | null> {
  try {
    const { fetchMultiChannelBuyInByBR } = await import("./multichannel-buy-in");
    const marketKey =
      resolveBuyInMarket({ name: opts.searchName ?? opts.resortName ?? opts.community, city: opts.city, state: opts.state }) ||
      resolveBuyInMarket({ name: opts.community, city: opts.city, state: opts.state }) ||
      opts.community;
    const market = BUY_IN_MARKET_LOCATIONS[marketKey] || BUY_IN_MARKET_LOCATIONS[opts.community];
    const searchName = opts.searchName || opts.resortName || market?.searchName || opts.community;
    const scan = await fetchMultiChannelBuyInByBR({
      community: marketKey,
      city: opts.city || market?.city || "",
      state: opts.state || market?.state || "",
      streetAddress: market?.streetAddress,
      bboxCenterOverride: market ? { lat: market.lat, lng: market.lng } : undefined,
      searchName,
      listingTitle: opts.listingTitle ?? opts.resortName ?? undefined,
      bedroomCounts: [opts.bedrooms],
      propertyId: opts.propertyId,
      dateOverride: { checkIn: opts.checkIn, checkOut: opts.checkOut },
      skipPm: true,
      reuseSharedOtaSearch: true,
      sidecarQueueBudgetMs: 180_000,
    });
    const byChannel = scan.channelCheapestByBR?.[opts.bedrooms] || {};
    const candidates = [
      scan.consensusCheapestByBR?.[opts.bedrooms],
      byChannel.airbnb,
      byChannel.vrbo,
      byChannel.booking,
      byChannel.pm,
    ].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
    return candidates.length ? Math.round(Math.min(...candidates)) : null;
  } catch (e: any) {
    console.error(
      `[availability-search] sidecar cheapest error ${opts.resortName ?? searchLocationForBuyInMarket(opts.community) ?? opts.community} ` +
      `${opts.bedrooms}BR ${opts.checkIn}→${opts.checkOut}: ${e?.message ?? e}`,
    );
    return null;
  }
}

// ── Live market-rate sampler for dashboard queue + Pricing tab manual button ──
// Implements the exact user spec: random 7-night per season, exact-BR median
// from SearchAPI Airbnb, per-season bias markup, combo doubling/sum, then
// the caller layers the final 20% before Guesty push.
// Surgical: reuses the existing fetch pattern; hard-caps lookahead to kill
// 2028 "no usable samples" errors.

export type MarketRateSample = {
  season: SharedSeasonKey;
  checkIn: string;
  checkOut: string;
  median: number | null;
  adjustedBuyIn: number | null; // after bias markup + combo
  rawSampleCount: number;
  error?: string;
};

export async function sampleMedianBuyInForSeason(opts: {
  community: string;
  bedrooms: number;          // exact unit type (e.g. 2 for the 2BR side of a combo)
  season: SharedSeasonKey;
  unitCount?: number;        // >1 = combo listing (sum or double)
  sameBrCombo?: boolean;     // hint for explicit 2x rule
  apiKey: string;
  maxSamples?: number;       // default 4
}): Promise<MarketRateSample> {
  const region: RegionType = getCommunityRegion(opts.community);
  const window = pickRandom7NightInSeason(region, opts.season, 10);
  if (!window) {
    return {
      season: opts.season,
      checkIn: "",
      checkOut: "",
      median: null,
      adjustedBuyIn: null,
      rawSampleCount: 0,
      error: "no future window in 10-month cap",
    };
  }

  const { checkIn, checkOut } = window;
  const nights = Math.max(1, Math.round((+new Date(checkOut) - +new Date(checkIn)) / 86_400_000));
  const prices: number[] = [];
  let lastErr: string | null = null;

  // Up to 2 random windows in the season month if first is thin (true "random 7-night")
  const attempts = [window];
  if ((opts.maxSamples ?? 4) > 2) {
    // second attempt: nudge +3 days (still same season month, still random-ish)
    const d2 = new Date(checkIn + "T12:00:00");
    d2.setDate(d2.getDate() + 3);
    attempts.push({ checkIn: d2.toISOString().slice(0, 10), checkOut: new Date(d2.getTime() + 7 * 86_400_000).toISOString().slice(0, 10) });
  }

  for (const w of attempts) {
    if (prices.length >= (opts.maxSamples ?? 4)) break;
    const sp = new URLSearchParams({
      engine: "airbnb",
      check_in_date: w.checkIn,
      check_out_date: w.checkOut,
      adults: "2",
      bedrooms: String(opts.bedrooms),
      type_of_place: "entire_home",
      currency: "USD",
      api_key: opts.apiKey,
      q: opts.community,
    });
    try {
      const r = await fetch(`https://www.searchapi.io/api/v1/search?${sp.toString()}`);
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      const data = await r.json() as any;
      const props: any[] = Array.isArray(data?.properties) ? data.properties : [];
      for (const p of props) {
        const pb = typeof p?.bedrooms === "number" ? p.bedrooms : null;
        if (pb != null && pb !== opts.bedrooms) continue; // exact-BR only
        const total = Number(p?.price?.extracted_total_price ?? 0);
        if (total > 0) prices.push(total / nights);
      }
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
  }

  if (prices.length === 0) {
    const msg = `SearchAPI Airbnb returned no usable exact-${opts.bedrooms}BR ${opts.season} samples for ${opts.community} ${checkIn} to ${checkOut}; static fallback is disabled for market-rate refreshes.`;
    console.warn(`[market-rate-sampler] ${msg} ${lastErr ? lastErr : ""}`);
    return {
      season: opts.season,
      checkIn,
      checkOut,
      median: null,
      adjustedBuyIn: null,
      rawSampleCount: 0,
      error: msg,
    };
  }

  // Median of the collected nightly rates (not cheapest)
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const unitCount = Math.max(1, opts.unitCount ?? 1);
  const adjusted = applyAirbnbBiasAndCombo(Math.round(median), opts.season, unitCount, !!opts.sameBrCombo);

  return {
    season: opts.season,
    checkIn,
    checkOut,
    median: Math.round(median),
    adjustedBuyIn: adjusted,
    rawSampleCount: prices.length,
  };
}
