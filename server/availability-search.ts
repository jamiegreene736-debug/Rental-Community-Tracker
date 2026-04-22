// Lightweight wrapper around SearchAPI's `airbnb` engine, extracted so
// the availability scanner can call it directly without HTTP overhead or
// the 500-line find-buy-in route handler.
//
// Returns only *priced* Airbnb listings for the given bedroom count +
// dates, filtered to the resort name when available. This is what
// actually drives the set-counting logic: a window is "available" only
// if enough real, bookable listings exist at the right BR count.

import type { PropertyUnitConfig } from "@shared/property-units";

export type PricedListing = {
  id: string;
  title: string;
  url: string;
  bedrooms: number | null;
  nightlyPrice: number;
  totalPrice: number;
  gpsCoordinates?: { latitude: number; longitude: number };
};

export type CommunityBounds = { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number };

export type FindPricedOptions = {
  community: string;          // e.g. "Kapaa Beachfront"
  resortName: string | null;  // e.g. "Kaha Lani" — post-filter (title / desc)
  bedrooms: number;
  checkIn: string;            // YYYY-MM-DD
  checkOut: string;           // YYYY-MM-DD
  q: string;                  // search query (e.g. "Kaha Lani, Kauai, Hawaii")
  bounds?: CommunityBounds;
  apiKey: string;
};

// Case-insensitive token-subset match — every significant token (≥3 chars)
// of the resort name must appear somewhere in the haystack. Matches the
// approach used in the find-buy-in route so results stay consistent.
export function matchesResort(haystack: string, resortName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = norm(resortName).split(" ").filter((t) => t.length >= 3);
  if (tokens.length === 0) return true;
  const h = norm(haystack);
  return tokens.every((t) => h.includes(t));
}

export async function findPricedAirbnbListings(opts: FindPricedOptions): Promise<PricedListing[]> {
  const { community, resortName, bedrooms, checkIn, checkOut, q, bounds, apiKey } = opts;
  const nights = Math.max(1, Math.round(
    (new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86_400_000,
  ));
  const sp: Record<string, string> = {
    engine: "airbnb",
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults: "2",
    bedrooms: String(bedrooms),
    type_of_place: "entire_home",
    currency: "USD",
    api_key: apiKey,
    q,
  };
  if (bounds) {
    sp.sw_lat = String(bounds.sw_lat);
    sp.sw_lng = String(bounds.sw_lng);
    sp.ne_lat = String(bounds.ne_lat);
    sp.ne_lng = String(bounds.ne_lng);
  }

  try {
    const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
    if (!r.ok) return [];
    const data = await r.json() as any;
    let properties: any[] = Array.isArray(data?.properties) ? data.properties : [];

    // Post-filter by resort name when we have one (the engine's geo bounds
    // alone aren't tight enough — neighbors in the same tile can slip in).
    if (resortName) {
      properties = properties.filter((p: any) => {
        const hay = `${p?.name ?? p?.title ?? ""} ${p?.description ?? ""}`;
        return matchesResort(hay, resortName);
      });
    }

    // Post-filter by actual bedrooms. The engine's `bedrooms` param is a
    // minimum filter, not an exact match — 4BR listings come back for a
    // 3BR query. For SET COUNTING this matters: the set is 3BR+3BR, so we
    // reject 4BR from the 3BR pool.
    properties = properties.filter((p: any) => {
      const pb = typeof p?.bedrooms === "number" ? p.bedrooms : null;
      if (pb == null) return true; // unknown BR — keep for manual review
      return pb === bedrooms;
    });

    return properties
      .filter((p: any) => p?.price?.extracted_total_price > 0 && p?.link)
      .map((p: any): PricedListing => {
        const total = Number(p.price.extracted_total_price);
        return {
          id: String(p?.id ?? p?.listing_id ?? p?.link),
          title: String(p?.name ?? p?.title ?? "Airbnb listing"),
          url: String(p.link),
          bedrooms: typeof p?.bedrooms === "number" ? p.bedrooms : null,
          totalPrice: total,
          nightlyPrice: Math.round(total / nights),
          gpsCoordinates: p?.gps_coordinates,
        };
      });
  } catch (e: any) {
    console.error(`[availability-search] ${resortName ?? community} ${bedrooms}BR ${checkIn}→${checkOut}: ${e?.message ?? e}`);
    return [];
  }
}

// For a property with multiple unit slots, work out how many COMPLETE
// independent sets we can form from the available listings. A "set" is
// one bookable listing per unit slot, with no listing reused across
// sets. Groups slots by bedroom count — e.g. a 6BR listing that's
// 3BR+3BR needs 2 distinct 3BR listings for one set, 4 for two sets.
//
// Returns max sets we could form AND the specific cheapest N sets.
export function buildSets(
  unitSlots: PropertyUnitConfig["units"],
  listingsByBedrooms: Record<number, PricedListing[]>,
  wantN: number,
): { maxSets: number; sets: Array<{ slots: Array<{ unitId: string; listing: PricedListing }>; totalPrice: number }> } {
  // How many listings of each BR count we need per set
  const needPerSet: Record<number, number> = {};
  for (const slot of unitSlots) {
    needPerSet[slot.bedrooms] = (needPerSet[slot.bedrooms] ?? 0) + 1;
  }

  // Max sets = min across BR groups of floor(available / needed)
  let maxSets = Infinity;
  for (const [brStr, need] of Object.entries(needPerSet)) {
    const br = parseInt(brStr, 10);
    const available = listingsByBedrooms[br]?.length ?? 0;
    maxSets = Math.min(maxSets, Math.floor(available / need));
  }
  if (maxSets === Infinity) maxSets = 0;
  const sampleN = Math.min(maxSets, wantN);

  // Build the cheapest `sampleN` sets. Sort listings per BR cheapest-first,
  // then greedily assign top `need*sampleN` to the sets in rotation.
  const sets: Array<{ slots: Array<{ unitId: string; listing: PricedListing }>; totalPrice: number }> = [];
  if (sampleN === 0) return { maxSets, sets };

  // Sorted pools, cheapest first. Pool is a shallow copy we can shift from.
  const pools: Record<number, PricedListing[]> = {};
  for (const [brStr, pool] of Object.entries(listingsByBedrooms)) {
    pools[parseInt(brStr, 10)] = [...pool].sort((a, b) => a.totalPrice - b.totalPrice);
  }

  for (let i = 0; i < sampleN; i++) {
    const slotAssignments: Array<{ unitId: string; listing: PricedListing }> = [];
    let total = 0;
    let ok = true;
    for (const slot of unitSlots) {
      const pool = pools[slot.bedrooms];
      if (!pool || pool.length === 0) { ok = false; break; }
      const listing = pool.shift()!;
      slotAssignments.push({ unitId: slot.unitId, listing });
      total += listing.totalPrice;
    }
    if (!ok) break;
    sets.push({ slots: slotAssignments, totalPrice: total });
  }

  return { maxSets, sets };
}

export function verdictFor(maxSets: number, minSets: number): "open" | "tight" | "blocked" {
  if (maxSets < minSets) return "blocked";
  if (maxSets <= minSets + 1) return "tight";
  return "open";
}
