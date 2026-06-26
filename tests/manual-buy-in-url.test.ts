import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBuyInListingUrl,
  resolvePmExtractedCost,
  nightsBetween,
} from "../shared/manual-buy-in-url";

// The manual buy-in dialog routes a pasted URL into one of two
// extraction paths: VRBO (its own checkout reader) vs. any other
// direct-booking / property-manager site (generic PM rate extractor).
// These tests lock that routing and the cost-from-extraction decision.

test("classify: vrbo.com (and subdomains) → vrbo", () => {
  for (const url of [
    "https://www.vrbo.com/1234567",
    "https://vrbo.com/1234567ha",
    "http://m.vrbo.com/1234567",
    "https://www.VRBO.com/1234567?adults=4",
  ]) {
    assert.equal(classifyBuyInListingUrl(url), "vrbo", url);
  }
});

test("classify: a direct-booking / PM link → direct", () => {
  for (const url of [
    "https://www.waikikibeachrentals.com/viewProperty.jsp?PROP_ID=463&doa=07/07/2026&dod=07/12/2026&searchback=true#description",
    "https://book.suite-paradise.com/unit/123",
    "https://www.koloalanding.com/rooms/5",
    "http://example-pm.com/listing/9",
  ]) {
    assert.equal(classifyBuyInListingUrl(url), "direct", url);
  }
});

test("classify: empty / malformed / non-http(s) → invalid", () => {
  for (const url of ["", "   ", "not a url", "waikikibeachrentals.com/x", "ftp://x.com/a", "file:///etc/passwd", null, undefined]) {
    assert.equal(classifyBuyInListingUrl(url as any), "invalid", String(url));
  }
});

test("classify: a vrbo look-alike host is NOT treated as vrbo", () => {
  assert.equal(classifyBuyInListingUrl("https://vrbo.com.evil.com/x"), "direct");
});

test("cost: prefers a positive total, rounded to cents", () => {
  const r = resolvePmExtractedCost({ totalPrice: 4523.5, nightlyPrice: 900 }, 5);
  assert.deepEqual(r, { ok: true, cost: 4523.5, basis: "total" });
});

test("cost: falls back to nightly × nights when no total", () => {
  const r = resolvePmExtractedCost({ totalPrice: null, nightlyPrice: 850 }, 5);
  assert.deepEqual(r, { ok: true, cost: 4250, basis: "nightly" });
});

test("cost: a page marked unavailable is rejected even if a price is present", () => {
  const r = resolvePmExtractedCost({ totalPrice: 4000, available: false }, 5);
  assert.deepEqual(r, { ok: false, reason: "unavailable" });
});

test("cost: no usable price → no-price", () => {
  for (const ex of [null, undefined, {}, { totalPrice: 0, nightlyPrice: 0 }, { nightlyPrice: -5 }]) {
    const r = resolvePmExtractedCost(ex as any, 5);
    assert.deepEqual(r, { ok: false, reason: "no-price" }, JSON.stringify(ex));
  }
});

test("cost: nightly fallback needs a positive night count", () => {
  assert.deepEqual(resolvePmExtractedCost({ nightlyPrice: 800 }, 0), { ok: false, reason: "no-price" });
});

test("nightsBetween: inclusive night count, guards bad input", () => {
  assert.equal(nightsBetween("2026-07-07", "2026-07-12"), 5);
  assert.equal(nightsBetween("2026-07-07", "2026-07-08"), 1);
  assert.equal(nightsBetween("2026-07-12", "2026-07-07"), 0); // reversed
  assert.equal(nightsBetween("2026-07-07", "2026-07-07"), 0); // same day
  assert.equal(nightsBetween("garbage", "2026-07-12"), 0);
});

console.log("manual-buy-in-url: all assertions passed");
