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

export type WalkResult = {
  minutes: number;       // rounded up to nearest minute
  feet: number;          // rounded to nearest 10 ft
  description: string;   // human-readable sentence for listings
  source: "geocoded" | "fallback";
};

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
  const mins = (resortName && RESORT_DEFAULT_WALK_MINUTES[resortName]) ?? 3;
  return {
    minutes: mins,
    feet: Math.round(mins * (WALKING_SPEED_MPH / 60) * 5280 / PATH_BEND_FACTOR),
    description: describeWalkFromMinutes(mins, resortName ?? undefined),
    source: "fallback",
  };
}
