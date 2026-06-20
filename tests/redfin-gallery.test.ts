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
  subjectGalleryFromJsonLd,
  MIN_JSONLD_SUBJECT_GALLERY,
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

// ── subjectGalleryFromJsonLd (host-agnostic comp-carousel isolation) ───────
//
// The general case of the Redfin trap: a Homes.com / MLS listing page renders a
// "Nearby similar homes" ItemList carousel whose cards carry OTHER units'
// thumbnails. The greedy page harvest sweeps those into the unit folder. The
// subject unit's JSON-LD `image` array, by contrast, only ever holds the subject
// unit's own photos.

const HOMES_SUBJECT = [
  "https://images.homes.com/listings/118/subjectA-1.jpg",
  "https://images.homes.com/listings/118/subjectA-2.jpg",
  "https://images.homes.com/listings/118/subjectA-3.jpg",
  "https://images.homes.com/listings/118/subjectA-4.jpg",
  "https://images.homes.com/listings/118/subjectA-5.jpg",
  "https://images.homes.com/listings/118/subjectA-6.jpg",
];
const HOMES_COMPS = [
  "https://images.homes.com/listings/999/compB-1.jpg",
  "https://images.homes.com/listings/888/compC-1.jpg",
  "https://images.homes.com/listings/777/compD-1.jpg",
];

function homesHtmlWithComps(): string {
  const subjectNode = {
    "@context": "https://schema.org",
    "@type": "SingleFamilyResidence",
    name: "Subject Unit A",
    image: HOMES_SUBJECT,
  };
  // The similar-homes carousel: each comp card is an ItemList element with its
  // own image. This is exactly what must NOT bleed into the subject gallery.
  const compList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: HOMES_COMPS.map((img, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: { "@type": "Product", name: `Nearby home ${i + 1}`, image: [img] },
    })),
  };
  return [
    `<meta property="og:image" content="${HOMES_SUBJECT[0]}"/>`,
    `<script type="application/ld+json">${JSON.stringify(subjectNode)}</script>`,
    `<script type="application/ld+json">${JSON.stringify(compList)}</script>`,
  ].join("\n");
}

check("JSON-LD subject gallery excludes the similar-homes ItemList carousel", () => {
  const html = homesHtmlWithComps();
  const urls = subjectGalleryFromJsonLd(html);
  assert.deepEqual(urls, HOMES_SUBJECT, "only the subject node's images are returned");
  for (const comp of HOMES_COMPS) {
    assert.ok(!urls.includes(comp), `comp ${comp} must not leak into the subject gallery`);
  }
  assert.ok(urls.length >= MIN_JSONLD_SUBJECT_GALLERY, "subject gallery clears the trust threshold");
});

check("JSON-LD subject gallery drops logo / junk assets", () => {
  const node = {
    "@type": "Product",
    image: [
      "https://images.homes.com/listings/1/a.jpg",
      "https://images.homes.com/static/logo.png",
      "https://images.homes.com/static/equal-housing-badge.png",
      "https://images.homes.com/listings/1/b.jpg",
    ],
  };
  const html = `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
  assert.deepEqual(subjectGalleryFromJsonLd(html), [
    "https://images.homes.com/listings/1/a.jpg",
    "https://images.homes.com/listings/1/b.jpg",
  ]);
});

check("JSON-LD images may be objects with a url/contentUrl field", () => {
  const node = {
    "@type": "Residence",
    image: [
      { "@type": "ImageObject", url: "https://images.homes.com/listings/2/a.jpg" },
      { "@type": "ImageObject", contentUrl: "https://images.homes.com/listings/2/b.jpg" },
    ],
  };
  const html = `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
  assert.deepEqual(subjectGalleryFromJsonLd(html), [
    "https://images.homes.com/listings/2/a.jpg",
    "https://images.homes.com/listings/2/b.jpg",
  ]);
});

check("a page-chrome Organization logo array is never treated as a gallery", () => {
  const org = {
    "@type": "Organization",
    name: "Homes.com",
    image: ["https://images.homes.com/static/brand-logo.jpg"],
    logo: "https://images.homes.com/static/brand-logo.jpg",
  };
  const html = `<script type="application/ld+json">${JSON.stringify(org)}</script>`;
  assert.deepEqual(subjectGalleryFromJsonLd(html), []);
});

check("malformed JSON-LD blocks are ignored without throwing", () => {
  const good = { "@type": "Product", image: ["https://images.homes.com/listings/3/a.jpg"] };
  const html = [
    `<script type="application/ld+json">{ not valid json,,, }</script>`,
    `<script type="application/ld+json">${JSON.stringify(good)}</script>`,
  ].join("\n");
  assert.deepEqual(subjectGalleryFromJsonLd(html), ["https://images.homes.com/listings/3/a.jpg"]);
});

check("no JSON-LD on the page yields an empty gallery (caller falls back to greedy harvest)", () => {
  const html = `<html><body><img src="https://images.homes.com/listings/4/a.jpg"/></body></html>`;
  assert.deepEqual(subjectGalleryFromJsonLd(html), []);
});

check("duplicate images (size variants / repeats) are de-duplicated by base URL", () => {
  const node = {
    "@type": "Product",
    image: [
      "https://images.homes.com/listings/5/a.jpg",
      "https://images.homes.com/listings/5/a.jpg?w=1024",
      "https://images.homes.com/listings/5/b.jpg",
    ],
  };
  const html = `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
  assert.deepEqual(subjectGalleryFromJsonLd(html), [
    "https://images.homes.com/listings/5/a.jpg",
    "https://images.homes.com/listings/5/b.jpg",
  ]);
});

console.log(`\nredfin-gallery: ${passed} checks passed`);
