import assert from "node:assert";
import {
  analyzeCaptionForCommunity,
  verifyCommunityPhotosFromInputs,
} from "../shared/community-photo-verify-logic";
import { classifyCommunityPhotoFromLens as classifyLens } from "../shared/community-photo-lens-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("community-photo-verify-logic: multi-signal community photo verification");

const bonitaNational = "Bonita National Golf & Country Club Condominiums";

check(
  "inconclusive lens alone → unconfirmed, not mismatch",
  (() => {
    const r = verifyCommunityPhotosFromInputs(
      [{
        id: "C1",
        expectedCommunity: bonitaNational,
        lens: "inconclusive",
        lensReason: "Reverse image search could not confirm this photo belongs to Bonita National.",
        caption: "Resort Pool",
        filename: "pool-01.jpg",
      }],
      bonitaNational,
    );
    return r.overallStatus === "unconfirmed" && r.photoResults[0].status === "unconfirmed";
  })(),
);

check(
  "lens confirmed + caption → verified",
  (() => {
    const r = verifyCommunityPhotosFromInputs(
      [{
        id: "C1",
        expectedCommunity: bonitaNational,
        lens: "confirmed",
        lensReason: "Reverse image search confirms Bonita National.",
        caption: "Bonita National resort pool",
        filename: "bonita-pool.jpg",
      }],
      bonitaNational,
    );
    return r.overallStatus === "verified" && r.photoResults[0].status === "verified";
  })(),
);

check(
  "lens wrong resort → mismatch",
  (() => {
    const r = verifyCommunityPhotosFromInputs(
      [{
        id: "C1",
        expectedCommunity: bonitaNational,
        lens: "contradicted",
        lensReason: 'Reverse image search identified "Bonita Beach & Tennis Club" — not Bonita National.',
        lensIdentifiedCommunity: "Bonita Beach & Tennis Club",
      }],
      bonitaNational,
    );
    return r.overallStatus === "mismatch";
  })(),
);

check(
  "high vision confidence rescues inconclusive lens → likely or verified",
  (() => {
    const r = verifyCommunityPhotosFromInputs(
      [{
        id: "C1",
        expectedCommunity: bonitaNational,
        lens: "inconclusive",
        lensReason: "No online matches",
        visionConfidence: 82,
        visionReason: "Golf course and clubhouse match Bonita National",
      }],
      bonitaNational,
    );
    return (r.overallStatus === "likely" || r.overallStatus === "verified")
      && r.photoResults[0].status !== "mismatch";
  })(),
);

check(
  "vision 72% with inconclusive lens → likely, not unconfirmed",
  (() => {
    const r = verifyCommunityPhotosFromInputs(
      [{
        id: "C2",
        expectedCommunity: bonitaNational,
        lens: "inconclusive",
        lensReason: "Reverse image search could not confirm this photo belongs to Bonita National.",
        caption: "Resort Pool Area",
        visionConfidence: 72,
        visionReason: "Resort pool with rock waterfall matches Bonita National amenities",
      }],
      bonitaNational,
    );
    return r.photoResults[0].status === "likely" && r.photoResults[0].match === "yes";
  })(),
);

check(
  "lens confirmed from AI overview alone → verified or likely",
  (() => {
    const r = verifyCommunityPhotosFromInputs(
      [{
        id: "C2",
        expectedCommunity: bonitaNational,
        lens: "confirmed",
        lensReason: "Reverse image search confirms Bonita National Golf & Country Club Condominiums.",
        caption: "Resort Pool Area",
        visionConfidence: 72,
      }],
      bonitaNational,
    );
    return (r.photoResults[0].status === "verified" || r.photoResults[0].status === "likely")
      && r.photoResults[0].match === "yes";
  })(),
);

check(
  "majority unconfirmed folder → unconfirmed overall, not mismatch",
  (() => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `C${i + 1}`,
      expectedCommunity: bonitaNational,
      lens: "inconclusive" as const,
      lensReason: "Could not confirm online",
      visionConfidence: 58,
      visionReason: "Generic resort amenity",
    }));
    const r = verifyCommunityPhotosFromInputs(rows, bonitaNational);
    return r.overallStatus !== "mismatch" && r.counts.unconfirmed + r.counts.likely >= 4;
  })(),
);

check(
  "caption mentions Bonita National → support signal",
  analyzeCaptionForCommunity(bonitaNational, "Bonita National pool", "IMG_001.jpg").result === "support",
);

check(
  "classifyCommunityPhotoFromLens marks empty results inconclusive",
  classifyLens(bonitaNational, []).outcome === "inconclusive",
);

const regencyPoipuKai = "Regency at Poipu Kai";

check(
  "lens Villas at Poipu Kai for Regency folder → mismatch (not likely)",
  (() => {
    const r = verifyCommunityPhotosFromInputs(
      [{
        id: "C1",
        expectedCommunity: regencyPoipuKai,
        lens: "contradicted",
        lensReason: 'Reverse image search identified "Villas at Poipu Kai" — a different complex within Poipu Kai, not Regency at Poipu Kai.',
        lensIdentifiedCommunity: "Villas at Poipu Kai",
        caption: "Resort Pool Area",
        visionConfidence: 78,
        visionReason: "Tropical pool with palm trees",
      }],
      regencyPoipuKai,
    );
    return r.photoResults[0].status === "mismatch" && r.overallStatus === "mismatch";
  })(),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
