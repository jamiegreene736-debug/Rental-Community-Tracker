import assert from "node:assert";
import {
  canonicalOtaUrlCandidates,
  hostOfUrl,
  otaPlatformForUrl,
} from "../shared/ota-host-match";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("ota-host-match: OTA host-family bucketing for the photo scanner");

// ── hostOfUrl ────────────────────────────────────────────────────────────────
check("strips www + lowercases", hostOfUrl("https://WWW.Airbnb.com/rooms/1") === "airbnb.com");
check("junk → null", hostOfUrl("not a url ::") === null && hostOfUrl("") === null);

// ── otaPlatformForUrl: airbnb family ─────────────────────────────────────────
check("airbnb.com → airbnb", otaPlatformForUrl("https://www.airbnb.com/rooms/123") === "airbnb");
check("airbnb.co.uk → airbnb", otaPlatformForUrl("https://www.airbnb.co.uk/rooms/123") === "airbnb");
check("airbnb.ca → airbnb", otaPlatformForUrl("https://airbnb.ca/rooms/123") === "airbnb");
check("airbnb.com.au → airbnb", otaPlatformForUrl("https://www.airbnb.com.au/rooms/123") === "airbnb");
check("fr.airbnb.ca subdomain → airbnb", otaPlatformForUrl("https://fr.airbnb.ca/rooms/9") === "airbnb");
check("lookalike airbnb.evil.com is REJECTED", otaPlatformForUrl("https://airbnb.evil.com/rooms/123") === null);

// ── vrbo family ──────────────────────────────────────────────────────────────
check("vrbo.com → vrbo", otaPlatformForUrl("https://www.vrbo.com/1234567") === "vrbo");
check("homeaway.com → vrbo", otaPlatformForUrl("https://www.homeaway.com/vacation-rental/p1234567") === "vrbo");
check("abritel.fr → vrbo", otaPlatformForUrl("https://www.abritel.fr/location-vacances/p1234567vb") === "vrbo");
check("fewo-direkt.de → vrbo", otaPlatformForUrl("https://www.fewo-direkt.de/ferienwohnung-ferienhaus/p1234567") === "vrbo");
check("stayz.com.au → vrbo", otaPlatformForUrl("https://www.stayz.com.au/holiday-rental/p1234567") === "vrbo");
check("bookabach.co.nz → vrbo", otaPlatformForUrl("https://www.bookabach.co.nz/holiday-house/p1234567") === "vrbo");

// ── booking family ───────────────────────────────────────────────────────────
check("booking.com → booking", otaPlatformForUrl("https://www.booking.com/hotel/us/foo.html") === "booking");
check("m.booking.com subdomain → booking", otaPlatformForUrl("https://m.booking.com/hotel/us/foo.html") === "booking");
check("booking.evil.com is REJECTED", otaPlatformForUrl("https://booking.evil.com/hotel/x") === null);

// ── non-OTA hosts ────────────────────────────────────────────────────────────
check("zillow / random hosts → null",
  otaPlatformForUrl("https://www.zillow.com/homedetails/1") === null &&
  otaPlatformForUrl("https://hometogo.com/x") === null);

// ── canonicalOtaUrlCandidates ────────────────────────────────────────────────
{
  const c = canonicalOtaUrlCandidates("https://www.airbnb.co.uk/rooms/12345");
  check("regional airbnb also yields canonical airbnb.com URL for suppression",
    c.includes("https://www.airbnb.com/rooms/12345") && c.length === 2);
}
{
  const c = canonicalOtaUrlCandidates("https://www.airbnb.com/rooms/12345");
  check("canonical airbnb.com yields only itself", c.length === 1);
}
{
  const c = canonicalOtaUrlCandidates("https://www.abritel.fr/location-vacances/p7654321vb");
  check("abritel listing canonicalizes to vrbo.com/<id>", c.includes("https://www.vrbo.com/7654321"));
}
{
  const c = canonicalOtaUrlCandidates("https://www.homeaway.com/vacation-rental/p9876543");
  check("homeaway listing canonicalizes to vrbo.com/<id>", c.includes("https://www.vrbo.com/9876543"));
}
{
  const c = canonicalOtaUrlCandidates("https://m.booking.com/hotel/us/blue-pacific.en-gb.html");
  check("m.booking.com canonicalizes to booking.com path", c.includes("https://www.booking.com/hotel/us/blue-pacific.en-gb.html"));
}
check("non-OTA URL yields only itself", canonicalOtaUrlCandidates("https://www.zillow.com/homedetails/1").length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
