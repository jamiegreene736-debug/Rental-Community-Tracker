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
