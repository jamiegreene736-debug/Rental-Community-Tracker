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

import type { PropertyUnitConfig } from "@shared/property-units";

import {
  BUY_IN_MARKET_LOCATIONS,
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
  unitSlots: PropertyUnitConfig["units"],
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
