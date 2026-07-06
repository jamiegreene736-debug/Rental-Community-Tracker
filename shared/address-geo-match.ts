// Phase-2 coordinate cross-check for the address-on-OTA leg.
//
// Some relists never print the street on the public page but DO expose an
// approximate map coordinate in JSON-LD (`geo.latitude/longitude`, Booking.com)
// or in the page's embedded JSON (`"lat"/"lng"`, Airbnb). This module pulls
// that coordinate out of already-fetched HTML so the scanner can compare it to
// our unit's own geocoded location — catching a relist whose street text a
// pure string match missed (an abbreviation/diacritic variant) or that the
// listing simply doesn't print.
//
// VRBO is deliberately NOT a target: it strips per-listing coordinates
// end-to-end (documented dead-end) — the scanner skips it.
//
// Network-free + deterministic. Precision is enforced downstream (tight radius
// + the unit-number gate), so a stray/attraction coordinate that slips through
// extraction simply fails the radius and never flags — extraction can be
// forgiving without risking a false positive.

export type LatLng = { lat: number; lng: number };

// Reject NaN/±Inf, out-of-range values, and Null Island (0,0) — the latter is a
// common "unset coordinate" placeholder, never a real listing.
export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a < -90 || a > 90 || b < -180 || b > 180) return false;
  if (Math.abs(a) < 1e-6 && Math.abs(b) < 1e-6) return false;
  return true;
}

function firstNumber(html: string, re: RegExp): number | null {
  const m = re.exec(html);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Pull the listing's published coordinate. Order of preference:
//   1. JSON-LD `latitude`/`longitude` (Booking.com GeoCoordinates).
//   2. Embedded `"lat"`/`"lng"` (or `"lon"`) JSON (Airbnb bootstrap).
// Returns null when nothing valid is found.
export function extractGeoFromPageText(html: string): LatLng | null {
  const text = String(html ?? "");
  if (!text) return null;

  // JSON-LD standard keys.
  const ldLat = firstNumber(text, /"latitude"\s*:\s*"?(-?\d{1,3}(?:\.\d+)?)"?/i);
  const ldLng = firstNumber(text, /"longitude"\s*:\s*"?(-?\d{1,3}(?:\.\d+)?)"?/i);
  if (ldLat !== null && ldLng !== null && isValidLatLng(ldLat, ldLng)) {
    return { lat: ldLat, lng: ldLng };
  }

  // Embedded short-key JSON (Airbnb et al.).
  const lat = firstNumber(text, /"lat"\s*:\s*"?(-?\d{1,3}(?:\.\d+)?)"?/i);
  const lng = firstNumber(text, /"(?:lng|lon)"\s*:\s*"?(-?\d{1,3}(?:\.\d+)?)"?/i);
  if (lat !== null && lng !== null && isValidLatLng(lat, lng)) {
    return { lat, lng };
  }

  return null;
}
