// Attach-time proximity gate: the fuzzy-geocode deferral decision (2026-06-26).
//
// The "Buy-in units too far apart" reject was firing on MANUAL combo attaches
// (e.g. a VRBO buy-in for Princeville Townhome B) because VRBO exposes no
// scrapable per-listing address, so the unit's address is fabricated from the
// configured resort and the geocode is a fuzzy title-guess. The cross-resort
// gate already distrusts those geocodes for CITY-WIDE pairs; this extends the
// same distrust to NON-city-wide configured combos: a within-town fuzzy distance
// defers to the resort footprint instead of hard-rejecting, while a gross
// contradiction (different town/island) still rejects.
//
// Locks `fuzzyGeocodeShouldDeferToResort`, the pure decision the gate uses.
import {
  fuzzyGeocodeShouldDeferToResort,
  MAX_BUY_IN_WALK_MINUTES,
  COORD_CONTRADICTION_WALK_MINUTES,
} from "../shared/walking-distance";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("attach-proximity: fuzzy-geocode deferral decision");

// ── The bug case: non-city-wide combo, fuzzy geocode, within-town distance ──
check(
  "DEFER: non-city-wide combo, fuzzy geocode 15 min apart (within town) → resort fallback",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: false, walkSource: "geocoded", walkMinutes: 15 }) === true,
);
check(
  "DEFER: just over the strict limit (11 min)",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: false, walkSource: "geocoded", walkMinutes: MAX_BUY_IN_WALK_MINUTES + 1 }) === true,
);
check(
  "DEFER: at the gross-contradiction boundary (25 min) is still within-town",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: false, walkSource: "geocoded", walkMinutes: COORD_CONTRADICTION_WALK_MINUTES }) === true,
);

// ── Already within the limit → nothing to defer (the gate would pass anyway) ──
check(
  "NO DEFER: already within the 10-min limit",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: false, walkSource: "geocoded", walkMinutes: 8 }) === false,
);

// ── Gross contradiction (different town/island) is NOT geocoding slop → reject ──
check(
  "NO DEFER: 26 min (just past gross-contradiction) still rejects",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: false, walkSource: "geocoded", walkMinutes: COORD_CONTRADICTION_WALK_MINUTES + 1 }) === false,
);
check(
  "NO DEFER: Poipu↔Princeville-scale 40 min rejects",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: false, walkSource: "geocoded", walkMinutes: 40 }) === false,
);

// ── City-wide pairs are untouched (handled by the unverified-cross-resort rule) ──
check(
  "NO DEFER: city-wide pair never defers (cross-resort gate owns it)",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: true, geoTrustworthy: false, walkSource: "geocoded", walkMinutes: 15 }) === false,
);

// ── Trustworthy geo (exact coords / two real addresses) is untouched ──
check(
  "NO DEFER: trustworthy geo rejects a real far distance",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: true, walkSource: "geocoded", walkMinutes: 15 }) === false,
);
check(
  "NO DEFER: exact source coords (coords) are never treated as fuzzy",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: true, walkSource: "coords", walkMinutes: 15 }) === false,
);

// ── A fallback walk is not a geocode → no deferral needed ──
check(
  "NO DEFER: source 'fallback' (already the resort default)",
  fuzzyGeocodeShouldDeferToResort({ pairCityWide: false, geoTrustworthy: false, walkSource: "fallback", walkMinutes: 4 }) === false,
);

console.log(`\nattach-proximity: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
