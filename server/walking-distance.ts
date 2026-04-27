// Geocoding (Nominatim primary, SearchAPI Google Maps fallback) +
// Haversine distance for the walking-distance feature. Nominatim is
// free, no key — usage policy is 1 req/sec so we throttle and cache
// coords in memory forever (addresses don't move). When Nominatim
// returns no result (private resort lanes, gated communities, freshly
// built subdivisions are common gaps), we fall back to SearchAPI's
// `google_maps` engine — which inherits Google's address coverage and
// resolves things like "9000 Treasure Trove Lane, Kissimmee, FL"
// (Caribe Cove Resort) that OSM doesn't have. Cache key is shared
// across both providers; a positive hit from either is sticky.

import {
  haversineFeet,
  walkMinutesFromFeet,
  describeWalk,
  fallbackWalkForResort,
  type WalkResult,
} from "@shared/walking-distance";

type Coord = { lat: number; lng: number };

const geocodeCache = new Map<string, Coord | null>();
let lastNominatimCall = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastNominatimCall));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();
}

async function geocodeViaNominatim(address: string): Promise<Coord | null> {
  try {
    await throttle();
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`,
      {
        headers: {
          // Nominatim requires a real User-Agent identifying the app.
          "User-Agent": "NexStay/1.0 (rental-community-tracker)",
          "Accept-Language": "en-US,en",
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!r.ok) return null;
    const rows = await r.json() as Array<{ lat: string; lon: string }>;
    if (!rows.length) return null;
    return { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon) };
  } catch (e: any) {
    console.warn(`[geocode/nominatim] ${address}: ${e?.message ?? e}`);
    return null;
  }
}

async function geocodeViaSearchApi(address: string): Promise<Coord | null> {
  const key = process.env.SEARCHAPI_API_KEY;
  if (!key) return null;
  try {
    const sp = new URLSearchParams({
      engine: "google_maps",
      q: address,
      api_key: key,
    });
    const r = await fetch(`https://www.searchapi.io/api/v1/search?${sp.toString()}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json() as any;
    // google_maps engine returns either a `place_results` object (single
    // hit, e.g. an exact address match) or a `local_results` array (POI /
    // business hits). Both carry `gps_coordinates: { latitude, longitude }`.
    const candidates: Array<{ gps_coordinates?: { latitude?: number; longitude?: number } }> = [];
    if (data?.place_results) candidates.push(data.place_results);
    if (Array.isArray(data?.local_results)) candidates.push(...data.local_results);
    for (const c of candidates) {
      const lat = Number(c?.gps_coordinates?.latitude);
      const lng = Number(c?.gps_coordinates?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return null;
  } catch (e: any) {
    console.warn(`[geocode/searchapi] ${address}: ${e?.message ?? e}`);
    return null;
  }
}

export async function geocode(address: string): Promise<Coord | null> {
  const key = address.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;
  // Nominatim first (free), SearchAPI google_maps as fallback (paid but
  // covers private resorts / gated communities OSM doesn't know).
  const coord = (await geocodeViaNominatim(address)) ?? (await geocodeViaSearchApi(address));
  geocodeCache.set(key, coord);
  return coord;
}

export async function walkBetween(
  addrA: string,
  addrB: string,
  resortName?: string,
): Promise<WalkResult> {
  // Same address → just steps apart, no API call needed.
  if (addrA.trim().toLowerCase() === addrB.trim().toLowerCase()) {
    return fallbackWalkForResort(resortName);
  }
  const [a, b] = await Promise.all([geocode(addrA), geocode(addrB)]);
  if (!a || !b) return fallbackWalkForResort(resortName);
  const feetRaw = haversineFeet(a.lat, a.lng, b.lat, b.lng);
  const feet = Math.max(10, Math.round(feetRaw / 10) * 10);
  const minutes = walkMinutesFromFeet(feet);
  return {
    minutes,
    feet,
    description: describeWalk(feet, minutes, resortName),
    source: "geocoded",
  };
}
