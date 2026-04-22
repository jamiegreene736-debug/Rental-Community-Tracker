// Nominatim-backed geocoding + Haversine distance for the walking-distance
// feature. Nominatim is free, no key — usage policy is 1 req/sec so we
// throttle and cache coords in memory forever (addresses don't move).

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

export async function geocode(address: string): Promise<Coord | null> {
  const key = address.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;
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
    if (!r.ok) {
      geocodeCache.set(key, null);
      return null;
    }
    const rows = await r.json() as Array<{ lat: string; lon: string }>;
    if (!rows.length) {
      geocodeCache.set(key, null);
      return null;
    }
    const coord: Coord = { lat: parseFloat(rows[0].lat), lng: parseFloat(rows[0].lon) };
    geocodeCache.set(key, coord);
    return coord;
  } catch (e: any) {
    console.warn(`[geocode] ${address}: ${e?.message ?? e}`);
    geocodeCache.set(key, null);
    return null;
  }
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
