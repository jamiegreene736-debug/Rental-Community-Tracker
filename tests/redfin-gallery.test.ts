// Deterministic tests for Redfin subject-gallery isolation.
//
// Fixtures are real photo URLs captured from the two off-market Redfin pages
// that contaminated Halii Kai draft 26 (2026-06-17):
//   - Unit A: .../unit-5F/home/148299850  → subject photoSetId 204315 (sparse,
//     off-market) + ~16 nearby-comp batches.
//   - Unit B: .../home/88440562          → NO subject photos (og:image is the
//     Redfin logo) + only nearby-comp batches.
//
// Run: npx tsx tests/redfin-gallery.test.ts

import assert from "node:assert/strict";
import {
  redfinPhotoSetId,
  redfinSubjectSetIdFromHtml,
  isolateRedfinSubjectGallery,
} from "../server/redfin-gallery";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ── redfinPhotoSetId ──────────────────────────────────────────────────────
check("setId from genMid subject url", () => {
  assert.equal(
    redfinPhotoSetId("https://ssl.cdn-redfin.com/photo/168/mbpaddedwide/315/genMid.204315_0.jpg"),
    "204315",
  );
});
check("setId from bigphoto (no gen prefix) subject url", () => {
  assert.equal(
    redfinPhotoSetId("http://ssl.cdn-redfin.com/photo/168/bigphoto/315/204315_0.jpg"),
    "204315",
  );
});
check("setId from genbcs comp url with variant suffix", () => {
  assert.equal(
    redfinPhotoSetId("https://ssl.cdn-redfin.com/photo/168/bcsphoto/668/genbcs.726668_1_4.jpg"),
    "726668",
  );
});
check("setId is null for the twitter-card junk asset", () => {
  assert.equal(
    redfinPhotoSetId("https://ssl.cdn-redfin.com/vLATEST/images/search/details/twittercards/twitter-card-camera-160x160.png"),
    null,
  );
});
check("setId is null for app-download / footer junk", () => {
  assert.equal(redfinPhotoSetId("https://ssl.cdn-redfin.com/vLATEST/images/apple-app-download.png"), null);
  assert.equal(redfinPhotoSetId("https://ssl.cdn-redfin.com/vLATEST/images/footer/equal-housing.png"), null);
});

// ── redfinSubjectSetIdFromHtml ────────────────────────────────────────────
check("subject setId read from og:image (listing with a gallery)", () => {
  const html = `<meta property="og:image" content="https://ssl.cdn-redfin.com/photo/168/mbpaddedwide/315/genMid.204315_0.jpg"/>`;
  assert.equal(redfinSubjectSetIdFromHtml(html), "204315");
});
check("subject setId is null when og:image is the Redfin logo (off-market, no photos)", () => {
  const html = `<meta property="og:image" content="http://ssl.cdn-redfin.com/vLATEST/images/logos/redfin-rocket-logo-red-bg-1200x1200.png"/>`;
  assert.equal(redfinSubjectSetIdFromHtml(html), null);
});

// ── isolateRedfinSubjectGallery ───────────────────────────────────────────
const SUBJECT_A = [
  "https://ssl.cdn-redfin.com/photo/168/mbpaddedwide/315/genMid.204315_0.jpg",
  "https://ssl.cdn-redfin.com/photo/168/bigphoto/315/204315_0.jpg",
];
const COMPS = [
  "https://ssl.cdn-redfin.com/photo/168/bcsphoto/668/genbcs.726668_3.jpg",
  "https://ssl.cdn-redfin.com/photo/168/bcsphoto/668/genbcs.726668_1_4.jpg",
  "https://ssl.cdn-redfin.com/photo/168/bcsphoto/584/genbcs.725584_1.jpg",
  "https://ssl.cdn-redfin.com/photo/168/bcsphoto/329/genbcs.718329_2.jpg",
  "https://ssl.cdn-redfin.com/photo/168/bcsphoto/225/genbcs.731225_1.jpg",
];
const JUNK = [
  "https://ssl.cdn-redfin.com/vLATEST/images/search/details/twittercards/twitter-card-camera-160x160.png",
  "https://ssl.cdn-redfin.com/vLATEST/images/apple-app-download.png",
];

check("keeps only the subject set, drops comps + junk", () => {
  const html = `<meta property="og:image" content="https://ssl.cdn-redfin.com/photo/168/mbpaddedwide/315/genMid.204315_0.jpg"/>`;
  const res = isolateRedfinSubjectGallery(html, [...SUBJECT_A, ...COMPS, ...JUNK]);
  assert.equal(res.isRedfin, true);
  assert.equal(res.subjectSetId, "204315");
  assert.deepEqual(res.urls, SUBJECT_A);
  assert.equal(res.droppedComps, COMPS.length + JUNK.length);
});

check("off-market subject (logo og:image) keeps NOTHING — never saves the carousel", () => {
  const html = `<meta property="og:image" content="http://ssl.cdn-redfin.com/vLATEST/images/logos/redfin-rocket-logo-red-bg-1200x1200.png"/>`;
  // Unit B: only comp batches were on the page.
  const res = isolateRedfinSubjectGallery(html, [...COMPS, ...JUNK]);
  assert.equal(res.isRedfin, true);
  assert.equal(res.subjectSetId, null);
  assert.deepEqual(res.urls, []);
  assert.equal(res.droppedComps, COMPS.length + JUNK.length);
});

check("non-Redfin page is a pass-through no-op", () => {
  const html = `<meta property="og:image" content="https://photos.zillowstatic.com/fp/abc-cc_ft_1536.jpg"/>`;
  const zillow = [
    "https://photos.zillowstatic.com/fp/abc-cc_ft_1536.jpg",
    "https://photos.zillowstatic.com/fp/def-cc_ft_1536.jpg",
  ];
  const res = isolateRedfinSubjectGallery(html, zillow);
  assert.equal(res.isRedfin, false);
  assert.deepEqual(res.urls, zillow);
  assert.equal(res.droppedComps, 0);
});

check("non-redfin photos on a redfin page are preserved (only comps dropped)", () => {
  const html = `<meta property="og:image" content="https://ssl.cdn-redfin.com/photo/168/mbpaddedwide/315/genMid.204315_0.jpg"/>`;
  const broker = "https://listingphotos.sierrastatic.com/12345/genmls.jpg";
  const res = isolateRedfinSubjectGallery(html, [...SUBJECT_A, broker, ...COMPS]);
  assert.ok(res.urls.includes(broker), "non-redfin broker photo kept");
  assert.deepEqual(res.urls, [...SUBJECT_A, broker]);
});

console.log(`\nredfin-gallery: ${passed} checks passed`);
