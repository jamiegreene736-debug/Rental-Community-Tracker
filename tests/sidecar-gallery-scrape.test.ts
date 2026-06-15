// Guards the generic `listing_gallery_scrape` sidecar op added to recover
// Redfin/Homes.com (and the previously-phantom zillow_photo_scrape) galleries
// from the operator's residential-IP Chrome when Railway's datacenter IP
// bot-walls the fetch+ScrapingBee chain down to og:image-only. See Load-Bearing
// #45. vrbo-sidecar-queue transitively imports server/db, so set a dummy
// DATABASE_URL before the dynamic import (mirrors sidecar-request-key.test.ts).
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
import assert from "node:assert/strict";

const { makeRequestKey, scrapeListingGalleryViaSidecar } = await import(
  "../server/vrbo-sidecar-queue"
);

console.log("sidecar-gallery-scrape suite");

const redfinA = "https://www.redfin.com/HI/Koloa/2611-Kiahuna-Plantation-Dr-96756/unit-1/home/111";
const redfinB = "https://www.redfin.com/HI/Koloa/2611-Kiahuna-Plantation-Dr-96756/unit-2/home/222";
const homesC = "https://www.homes.com/property/some-condo-koloa-hi/abc123/";

// ── 1. URL-keyed dedup (regression-locks the sidecar-request-key bug) ──
const keyA = makeRequestKey("listing_gallery_scrape", { url: redfinA } as any);
const keyB = makeRequestKey("listing_gallery_scrape", { url: redfinB } as any);
const keyC = makeRequestKey("listing_gallery_scrape", { url: homesC } as any);

assert.ok(typeof keyA === "string" && keyA.length > 0, "key is a non-empty string (never undefined)");
assert.ok(keyA.startsWith("listing_gallery_scrape|"), "key carries the op prefix");
assert.ok(keyA.includes(redfinA), "key embeds the listing URL");
assert.notEqual(keyA, keyB, "two distinct Redfin listings get distinct keys (no collision)");
assert.notEqual(keyA, keyC, "Redfin vs Homes.com listings get distinct keys");
console.log("  ✓ distinct listing URLs produce distinct dedup keys");

// Identical re-enqueue SHOULD dedup to the same key.
assert.equal(
  makeRequestKey("listing_gallery_scrape", { url: redfinA } as any),
  makeRequestKey("listing_gallery_scrape", { url: redfinA } as any),
  "identical URL yields the same key (legit dedup)",
);
console.log("  ✓ identical re-enqueue dedups to one key");

// Must NOT share a key with the Zillow op for the same URL (distinct op prefixes).
const sameUrl = "https://www.zillow.com/homedetails/1_zpid/";
assert.notEqual(
  makeRequestKey("listing_gallery_scrape", { url: sameUrl } as any),
  makeRequestKey("zillow_photo_scrape", { url: sameUrl } as any),
  "listing_gallery_scrape and zillow_photo_scrape never collide on one key",
);
console.log("  ✓ does not collide with zillow_photo_scrape");

// ── 2. Bad-URL bail (pure, no worker required) ──
const bail = await scrapeListingGalleryViaSidecar({ url: "not-a-url" });
assert.deepEqual(
  { photos: bail.photos, online: bail.workerOnline, reason: bail.reason },
  { photos: [], online: false, reason: "valid url required" },
  "invalid URL bails without enqueueing",
);
console.log("  ✓ invalid URL bails cleanly (no enqueue)");

console.log("sidecar-gallery-scrape: all assertions passed");
