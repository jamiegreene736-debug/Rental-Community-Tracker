// Estimate the walking distance between two resort units.
//
// Methodology:
//   1. Geocode both addresses via OpenStreetMap Nominatim (free, no API key).
//   2. Compute great-circle distance via the Haversine formula.
//   3. Convert to walking time assuming 3 mph (20 min per mile). Walking
//      paths inside resorts aren't quite great-circle — we bump the
//      time up 15% to account for paths bending around buildings.
//   4. Bucket the result into a human-readable sentence suitable for
//      the listing's "space" description.
//
// Fallback: if Nominatim can't resolve either address (rate-limited,
// too generic, etc.), use RESORT_DEFAULT_WALK_MINUTES for the unit's
// resort (hardcoded median based on resort footprint), or 3 min if
// the resort isn't in the map. Fallbacks report `source: "fallback"`
// so callers can degrade gracefully.

export const WALKING_SPEED_MPH = 3;
export const PATH_BEND_FACTOR = 1.15; // paths inside resorts bend ~15% longer than straight-line
export const MAX_BUY_IN_WALK_MINUTES = 10;

// A text/photo same-community match (two listings sharing a resort name or amenity
// photo) is normally trusted on its own — detail-page coordinates can be slightly
// off (geocoded to a building centroid, a shared region pin, etc.), so coords must
// NOT *reject* a real same-complex pair on a small discrepancy (the Phase-4 "Point
// at Poipu 721 + 812" regression). But coordinates that place the two units THIS
// far apart are not geocoding slop — they are a different area entirely, so a
// same-name coincidence across that gap is vetoed. Deliberately generous (~2.5x
// MAX_BUY_IN_WALK_MINUTES) so only gross contradictions reject, never near-misses.
export const COORD_CONTRADICTION_WALK_MINUTES = 25;

// For true multi-unit combo buy-ins (e.g. two 3BRs replacing a 6BR booking),
// we intend to enforce this strictly at attach time. Sub-community correctness
// (via unitTypeConfidence) is now an additional strong gate alongside distance.

export type WalkResult = {
  minutes: number;       // rounded up to nearest minute
  feet: number;          // rounded to nearest 10 ft
  description: string;   // human-readable sentence for listings
  // "coords" = computed from EXACT source-supplied coordinates (e.g. HomeToGo's
  // per-offer geoLocation). Strictly MORE trustworthy than "geocoded" (which
  // resolves a possibly-fuzzy address string) — the points are the listing's own.
  source: "geocoded" | "fallback" | "coords";
};

// Parse the "Geo: <lat>,<lon>" marker a coord-bearing buy-in (HomeToGo onsite) stamps
// into its notes at attach time. Returns null for VRBO/Booking buy-ins (no marker), and
// rejects out-of-range / 0,0 sentinels. The attach-time proximity gate uses this to
// authorize a city-wide cross-complex walk on REAL source coordinates.
export function parseGeoNote(notes: unknown): { lat: number; lng: number } | null {
  const m = String(notes ?? "").match(/Geo:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/i);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

// Walk between two EXACT coordinate pairs (added 2026-06-11 for the HomeToGo
// onsite source, whose /searchdetails feed carries each offer's own geoLocation).
// No geocoding/network — pure haversine on real source coordinates. Reported as
// source "coords" so the attach-time proximity gate can trust it like (better
// than) a geocoded-address walk. See server/routes.ts estimateAttachedBuyInProximity.
export function walkBetweenCoords(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  resortName?: string,
): WalkResult {
  const feetRaw = haversineFeet(a.lat, a.lng, b.lat, b.lng);
  const feet = Math.max(10, Math.round(feetRaw / 10) * 10);
  const minutes = walkMinutesFromFeet(feet);
  return { minutes, feet, description: describeWalk(feet, minutes, resortName), source: "coords" };
}

// Per-resort defaults (median walking time between any two units within
// the resort's footprint). Use when geocoding fails or for listings
// whose unit addresses aren't distinct enough.
export const RESORT_DEFAULT_WALK_MINUTES: Record<string, number> = {
  "Regency at Poipu Kai":           5,  // sprawling multi-building complex
  "Pili Mai":                       3,  // townhome clusters
  "Pili Mai at Poipu":              3,
  "Kaha Lani Resort":               3,
  "Lae Nani Resort":                3,
  "Mauna Kai Princeville":          4,
  "Kaiulani of Princeville":        3,
  "Keauhou Estates":                2,
  "Poipu Brenneckes Beachside":     2,
  "Poipu Brenneckes Oceanfront":    2,
  "Kekaha Beachfront Estate":       2,
  "Kiahuna Plantation":             5,
  "Southern Dunes":                 2,
  "Windsor Hills":                  3,
};

export function haversineFeet(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 20_902_231; // earth radius in feet
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function walkMinutesFromFeet(feet: number): number {
  const miles = feet / 5280;
  const minutesStraight = (miles / WALKING_SPEED_MPH) * 60;
  return Math.max(1, Math.ceil(minutesStraight * PATH_BEND_FACTOR));
}

// Human-readable bucket for the computed distance.
// Keeps phrasing resort-friendly — no "0.42 miles" precision, just
// conversational ranges guests actually care about.
export function describeWalk(feet: number, minutes: number, resortName?: string): string {
  const where = resortName ? ` within ${resortName}` : " within the resort";
  if (feet < 150) return `The units are directly adjacent${where} — just steps apart, typically in the same building or cluster.`;
  if (feet < 400) return `The units are a short 1-minute walk apart${where}, within the same cluster of buildings.`;
  if (feet < 900) return `The units are approximately a ${minutes}-minute walk apart${where} — an easy stroll across the grounds.`;
  if (feet < 1800) return `The units are approximately a ${minutes}-minute walk apart${where}, across the resort grounds.`;
  if (feet < 3600) {
    const mi = Math.round((feet / 5280) * 10) / 10;
    return `The units are approximately a ${minutes}-minute walk apart (${mi} mi)${where}.`;
  }
  const mi = Math.round((feet / 5280) * 10) / 10;
  return `The units are about ${mi} miles apart (~${minutes}-minute walk)${where} — driving or riding a cart between them is recommended.`;
}

// Build a description from a resort-default minute count when we don't
// have real coordinates. We don't know the actual distance so we
// describe in terms of time only.
export function describeWalkFromMinutes(minutes: number, resortName?: string): string {
  const where = resortName ? ` within ${resortName}` : " within the resort";
  if (minutes <= 1) return `The units are just steps apart${where}.`;
  if (minutes <= 3) return `The units are approximately a ${minutes}-minute walk apart${where}.`;
  if (minutes <= 5) return `The units are approximately a ${minutes}-minute walk apart${where} — an easy stroll across the grounds.`;
  return `The units are approximately a ${minutes}-minute walk apart${where}, across the resort property.`;
}

export function fallbackWalkForResort(resortName?: string | null): WalkResult {
  const mins = resortName ? RESORT_DEFAULT_WALK_MINUTES[resortName] ?? 3 : 3;
  return {
    minutes: mins,
    feet: Math.round(mins * (WALKING_SPEED_MPH / 60) * 5280 / PATH_BEND_FACTOR),
    description: describeWalkFromMinutes(mins, resortName ?? undefined),
    source: "fallback",
  };
}

// Attach-time proximity gate decision: should a NON-trustworthy geocoded walk
// between two units be IGNORED for rejection (collapsed to the resort-footprint
// fallback) instead of being trusted to block the attach?
//
// The cross-resort gate already distrusts title-guess geocodes for CITY-WIDE
// pairs — geocoding "title-soup, Town, HI" drops a fuzzy pin (the 2026-06-10
// Puamana + Wyndham Ka Eo Kai mispair). The SAME distrust applies to a
// NON-city-wide configured combo: when neither unit has a real (saved/scraped)
// address, the unit's address is fabricated from the CONFIGURED resort (e.g. a
// manual VRBO buy-in — VRBO exposes no scrapable per-listing address), so a
// WITHIN-TOWN fuzzy distance is not reliable enough to hard-reject an attach the
// operator explicitly made. Such pairs defer to the resort footprint default.
//
// A GROSS contradiction (> COORD_CONTRADICTION_WALK_MINUTES, ≈ a different
// town/island) is NOT geocoding slop, so it is kept and still rejects. City-wide
// pairs (handled by the unverified-cross-resort evidence rule) and trustworthy
// geo (exact source coords, or two REAL addresses) are unaffected — they keep
// their computed walk and reject when genuinely far.
export function fuzzyGeocodeShouldDeferToResort(opts: {
  pairCityWide: boolean;
  geoTrustworthy: boolean;
  walkSource: WalkResult["source"];
  walkMinutes: number;
}): boolean {
  if (opts.pairCityWide || opts.geoTrustworthy) return false;
  if (opts.walkSource !== "geocoded") return false;
  return (
    opts.walkMinutes > MAX_BUY_IN_WALK_MINUTES &&
    opts.walkMinutes <= COORD_CONTRADICTION_WALK_MINUTES
  );
}
