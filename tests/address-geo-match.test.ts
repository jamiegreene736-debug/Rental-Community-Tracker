import assert from "node:assert";
import { extractGeoFromPageText, isValidLatLng } from "../shared/address-geo-match";
import { haversineFeet } from "../shared/walking-distance";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("address-geo-match: coordinate cross-check helpers");

// ---- isValidLatLng ----------------------------------------------------------
check("valid Kauai coord", isValidLatLng(21.8829, -159.4693) === true);
check("out-of-range lat rejected", isValidLatLng(120, -159) === false);
check("out-of-range lng rejected", isValidLatLng(21, -200) === false);
check("Null Island (0,0) rejected", isValidLatLng(0, 0) === false);
check("NaN rejected", isValidLatLng(Number.NaN, -159) === false);
check("string numbers accepted", isValidLatLng("21.88", "-159.46") === true);

// ---- extractGeoFromPageText -------------------------------------------------
// Booking.com-style JSON-LD GeoCoordinates.
check(
  "extracts JSON-LD latitude/longitude (Booking.com)",
  (() => {
    const html = '<script type="application/ld+json">{"@type":"Hotel","geo":{"@type":"GeoCoordinates","latitude":"21.8829","longitude":"-159.4693"}}</script>';
    const g = extractGeoFromPageText(html);
    return !!g && Math.abs(g.lat - 21.8829) < 1e-6 && Math.abs(g.lng + 159.4693) < 1e-6;
  })(),
);

// Airbnb-style embedded short-key JSON.
check(
  "extracts embedded lat/lng (Airbnb)",
  (() => {
    const html = '<script>window.__data = {"location":{"lat":21.8830,"lng":-159.4690}};</script>';
    const g = extractGeoFromPageText(html);
    return !!g && Math.abs(g.lat - 21.8830) < 1e-6 && Math.abs(g.lng + 159.4690) < 1e-6;
  })(),
);

check(
  "accepts 'lon' as a longitude key",
  (() => {
    const g = extractGeoFromPageText('{"lat":40.7128,"lon":-74.0060}');
    return !!g && Math.abs(g.lat - 40.7128) < 1e-6 && Math.abs(g.lng + 74.006) < 1e-6;
  })(),
);

check(
  "JSON-LD wins over stray short keys when both present",
  (() => {
    const html = '{"latitude":"21.8829","longitude":"-159.4693"} ... {"lat":99,"lng":99}';
    const g = extractGeoFromPageText(html);
    return !!g && Math.abs(g.lat - 21.8829) < 1e-6;
  })(),
);

check("null/empty html → null", extractGeoFromPageText("") === null);
check("no coordinates → null", extractGeoFromPageText("<p>Lovely Poipu condo, sleeps 6</p>") === null);
check(
  "unset (0,0) placeholder → null",
  extractGeoFromPageText('{"geo":{"latitude":"0","longitude":"0"}}') === null,
);
check(
  "out-of-range coords → null",
  extractGeoFromPageText('{"lat":500.0,"lng":-159.4}') === null,
);

// ---- end-to-end radius sanity (reuses shared haversineFeet) -----------------
{
  // Two points ~0.5 mi apart in Poipu; a 2640 ft (0.5 mi) window admits them,
  // a tight 660 ft window does not — the two thresholds the scanner uses.
  const ours = extractGeoFromPageText('{"latitude":"21.8829","longitude":"-159.4693"}')!;
  const theirs = extractGeoFromPageText('{"lat":21.8760,"lng":-159.4693}')!; // ~0.48 mi south
  const feet = haversineFeet(ours.lat, ours.lng, theirs.lat, theirs.lng);
  check("nearby pin within the 0.5 mi window", feet <= 2640);
  check("same nearby pin outside a tight 660 ft window", feet > 660);
}

console.log(`\naddress-geo-match: ${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, "address-geo-match tests failed");
