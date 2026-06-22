import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyManualComboUnitUrl } from "../shared/manual-combo-url";

// The manual "Add a community" endpoint scrapes the pasted URL server-side, so
// this classifier is both the feature gate and the SSRF guard. These tests lock
// the allowlist + scheme behavior.

test("accepts supported real-estate hosts (incl. www + subdomains)", () => {
  for (const url of [
    "https://www.zillow.com/homedetails/2440-Hoonani-Rd-Koloa-HI-96756/123_zpid/",
    "https://www.redfin.com/HI/Koloa/2440-Hoonani-Rd-96756/home/12345",
    "https://www.realtor.com/realestateandhomes-detail/2440-Hoonani-Rd_Koloa_HI_96756",
    "https://www.homes.com/property/2440-hoonani-rd-koloa-hi/abcd/",
    "http://zillow.com/homedetails/x/1_zpid/", // http allowed
    "https://maps.realtor.com/foo", // subdomain of an allowed host
  ]) {
    const v = classifyManualComboUnitUrl(url);
    assert.equal(v.ok, true, `expected ok for ${url} (got: ${v.reason})`);
  }
});

test("rejects OTA hosts with the 'paste a real-estate listing' hint", () => {
  for (const url of [
    "https://www.vrbo.com/1234567",
    "https://www.airbnb.com/rooms/12345",
    "https://www.booking.com/hotel/us/foo.html",
    "https://www.hometogo.com/offer/123",
  ]) {
    const v = classifyManualComboUnitUrl(url);
    assert.equal(v.ok, false, `expected reject for ${url}`);
    assert.match(v.reason ?? "", /can't be scraped|Zillow, Redfin/);
  }
});

test("SSRF: rejects internal / metadata / non-http targets", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://localhost:6379/",
    "http://127.0.0.1/admin",
    "http://10.0.0.5/",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://127.0.0.1:6379/_INFO",
  ]) {
    const v = classifyManualComboUnitUrl(url);
    assert.equal(v.ok, false, `expected reject for ${url}`);
  }
});

test("rejects an unsupported but otherwise-normal host", () => {
  const v = classifyManualComboUnitUrl("https://example.com/listing/1");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /isn't a supported listing site/);
});

test("rejects malformed input", () => {
  for (const url of ["", "not a url", "zillow.com/foo"]) {
    const v = classifyManualComboUnitUrl(url);
    assert.equal(v.ok, false, `expected reject for ${JSON.stringify(url)}`);
  }
});

test("a lookalike host (zillow.com.evil.com) is NOT accepted", () => {
  const v = classifyManualComboUnitUrl("https://zillow.com.evil.com/x");
  assert.equal(v.ok, false);
});

console.log("manual-combo-url: all assertions passed");
