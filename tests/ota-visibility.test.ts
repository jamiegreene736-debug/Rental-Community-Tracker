import assert from "node:assert/strict";
import {
  canonicalVisibilityUrl,
  otaVisibilityPageForPosition,
  otaVisibilitySidecarFailureMessage,
  pickOtaVisibilityMatch,
  scoreOtaVisibilityCandidate,
  type OtaVisibilityCandidate,
} from "../server/ota-visibility-core";
import type { PropertyUnitBuilder } from "../client/src/data/unit-builder-data";

const sampleProperty: PropertyUnitBuilder = {
  propertyId: 1,
  propertyName: "Poipu Kai 6BR",
  complexName: "Poipu Kai Resort",
  address: "1941 Poipu Rd, Koloa, HI 96756",
  bookingTitle: "Luxury 6BR at Poipu Kai Resort",
  sampleDisclaimer: "",
  combinedDescription: "",
  units: [{ id: "a", unitNumber: "721", bedrooms: 3, bathrooms: 2, photos: [] }, { id: "b", unitNumber: "812", bedrooms: 3, bathrooms: 2, photos: [] }],
};

function candidate(overrides: Partial<OtaVisibilityCandidate>): OtaVisibilityCandidate {
  return {
    url: "https://www.vrbo.com/123",
    title: "Other listing",
    position: 1,
    page: 1,
    score: 40,
    reason: "weak match",
    ...overrides,
  };
}

assert.equal(otaVisibilityPageForPosition(1), 1);
assert.equal(otaVisibilityPageForPosition(50), 1);
assert.equal(otaVisibilityPageForPosition(51), 2);
assert.equal(otaVisibilityPageForPosition(120), 3);

assert.equal(
  canonicalVisibilityUrl("https://www.vrbo.com/123456?foo=bar"),
  "vrbo.com/123456",
);

const scored = scoreOtaVisibilityCandidate({
  candidate: {
    url: "https://www.vrbo.com/999",
    title: "Luxury 6BR at Poipu Kai Resort - Koloa",
    snippet: "6 bedrooms near Poipu Kai",
  },
  position: 73,
  property: sampleProperty,
  listingTitle: "Luxury 6BR at Poipu Kai Resort",
  publicUrl: "https://www.vrbo.com/999",
});
assert.equal(scored.page, 2);
assert.ok(scored.reason.includes("public URL match"));
assert.ok(scored.score >= 120);

const urlPick = pickOtaVisibilityMatch([
  candidate({ position: 5, score: 100, reason: "6/6 title tokens, community match", title: "Similar Poipu Kai listing" }),
  candidate({ position: 42, score: 125, reason: "public URL match", url: "https://www.vrbo.com/999", title: "Our listing" }),
]);
assert.equal(urlPick.found, true);
assert.equal(urlPick.match?.position, 42);

const titlePick = pickOtaVisibilityMatch([
  candidate({ position: 8, score: 85, reason: "7/8 title tokens, community match", title: "Luxury 6BR at Poipu Kai Resort" }),
]);
assert.equal(titlePick.found, true);
assert.equal(titlePick.match?.position, 8);

const missPick = pickOtaVisibilityMatch([
  candidate({ position: 2, score: 45, reason: "2/8 partial title tokens" }),
]);
assert.equal(missPick.found, false);
assert.ok(missPick.bestCandidate);

assert.equal(
  otaVisibilitySidecarFailureMessage({
    candidateCount: 0,
    workerOnline: false,
    reason: "queue wait budget 285000ms exceeded waiting for worker",
  }),
  "queue wait budget 285000ms exceeded waiting for worker",
);

assert.equal(
  otaVisibilitySidecarFailureMessage({
    candidateCount: 0,
    workerOnline: true,
    reason: "worker returned 0 result(s)",
  }),
  null,
);

assert.equal(
  otaVisibilitySidecarFailureMessage({
    candidateCount: 12,
    workerOnline: true,
    reason: "worker returned 12 result(s)",
  }),
  null,
);

console.log("ota-visibility.test.ts: all assertions passed");
