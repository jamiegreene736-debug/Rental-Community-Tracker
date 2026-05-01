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
// pricing we sample the SearchAPI airbnb engine sparingly — once per
// season per bedroom count — and reuse those numbers across all weeks
// in that season. ~6 priced calls per scan per property.

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
  bounds?: { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number };
  apiKey: string;
};

// Single airbnb-engine call. Returns the cheapest available listing's
// per-night rate for the given window — null if nothing comes back with
// a usable price. Tolerates the engine's missing-price cases silently
// (some short-notice or far-future windows have no priced inventory).
export async function findCheapestPricedNightly(opts: FindCheapestOptions): Promise<number | null> {
  const nights = Math.max(1, Math.round(
    (new Date(opts.checkOut + "T12:00:00").getTime() - new Date(opts.checkIn + "T12:00:00").getTime()) / 86_400_000,
  ));
  const sp: Record<string, string> = {
    engine: "airbnb",
    check_in_date: opts.checkIn,
    check_out_date: opts.checkOut,
    adults: "2",
    bedrooms: String(opts.bedrooms),
    type_of_place: "entire_home",
    currency: "USD",
    api_key: opts.apiKey,
    q: opts.q,
  };
  if (opts.bounds) {
    sp.bounding_box = `[[${opts.bounds.ne_lat},${opts.bounds.ne_lng}],[${opts.bounds.sw_lat},${opts.bounds.sw_lng}]]`;
  }
  try {
    const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
    if (!r.ok) return null;
    const data = await r.json() as any;
    let properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
    if (opts.resortName) {
      const tokens = opts.resortName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((t) => t.length >= 3);
      properties = properties.filter((p: any) => {
        const hay = `${p?.name ?? p?.title ?? ""} ${p?.description ?? ""}`.toLowerCase();
        const lat = Number(p?.gps_coordinates?.latitude);
        const lng = Number(p?.gps_coordinates?.longitude);
        const inBounds = opts.bounds
          ? Number.isFinite(lat) && Number.isFinite(lng)
            && lat >= opts.bounds.sw_lat - 0.01 && lat <= opts.bounds.ne_lat + 0.01
            && lng >= opts.bounds.sw_lng - 0.01 && lng <= opts.bounds.ne_lng + 0.01
          : false;
        return tokens.every((t) => hay.includes(t)) || inBounds;
      });
    }
    properties = properties.filter((p: any) => {
      const pb = typeof p?.bedrooms === "number" ? p.bedrooms : null;
      return pb == null || pb === opts.bedrooms;
    });
    const prices = properties
      .map((p: any) => Number(p?.price?.extracted_total_price ?? 0))
      .filter((n) => n > 0);
    if (prices.length === 0) return null;
    const cheapestTotal = Math.min(...prices);
    return Math.round(cheapestTotal / nights);
  } catch {
    return null;
  }
}
