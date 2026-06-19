import assert from "node:assert";
import { judgeCommunityPhotoFromLens, classifyCommunityPhotoFromLens } from "../shared/community-photo-lens-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("community-photo-lens-logic: reverse-image community verdicts");

const bonitaNational = "Bonita National Golf & Country Club Condominiums";

check(
  "flags Bonita Beach & Tennis Club pool as wrong community",
  judgeCommunityPhotoFromLens(
    bonitaNational,
    [{
      title: "Walk to Beach: Bonita Springs Gem w/ Pool! - Bonita Springs - Vrbo",
      snippet: "Bonita Beach & Tennis Club swimming pool area with lounge chairs",
      link: "https://www.vrbo.com/12345",
      position: 1,
    }],
    [
      "This image shows the swimming pool area at the Bonita Beach & Tennis Club in Bonita Springs, Florida.",
    ],
  ).match === "no",
);

check(
  "confirms expected community when Lens names it",
  judgeCommunityPhotoFromLens(
    bonitaNational,
    [{
      title: "Bonita National Golf & Country Club - Resort Pool - Vrbo",
      snippet: "Bonita National Golf and Country Club condominiums pool",
      link: "https://www.vrbo.com/99999",
      position: 1,
    }],
  ).match === "yes",
);

check(
  "generic pool hit without resort name passes",
  judgeCommunityPhotoFromLens(
    bonitaNational,
    [{
      title: "Resort pool with lounge chairs",
      snippet: "Heated swimming pool and spa amenities",
      link: "https://example.com/pool",
      position: 1,
    }],
  ).match === "yes",
);

check(
  "classifyCommunityPhotoFromLens marks empty results inconclusive",
  classifyCommunityPhotoFromLens(bonitaNational, []).outcome === "inconclusive",
);

check(
  "AI overview naming Bonita National confirms expected community",
  judgeCommunityPhotoFromLens(
    bonitaNational,
    [],
    [
      "The image depicts the resort-style pool area at the Bonita National Golf & Country Club in Naples, Florida.",
    ],
  ).match === "yes",
);

check(
  "generic visual hits plus VRBO organic naming row still confirms",
  judgeCommunityPhotoFromLens(
    bonitaNational,
    [
      {
        title: "Resort pool with lounge chairs",
        snippet: "Heated swimming pool and spa amenities",
        link: "https://example.com/pool-photo",
        source: "visual",
        position: 1,
      },
      {
        title: "927 Bonita National Condo - Naples | Vrbo",
        snippet: "Bonita National Golf and Country Club resort pool area",
        link: "https://www.vrbo.com/12345",
        source: "organic",
        position: 2,
      },
    ],
  ).match === "yes",
);

const regencyPoipuKai = "Regency at Poipu Kai";

check(
  "flags Villas at Poipu Kai pool as wrong community for Regency",
  judgeCommunityPhotoFromLens(
    regencyPoipuKai,
    [{
      title: "Kauai Vacation Rentals - The Villas at Poipu Kai",
      snippet: "The Parrish Collection Kauai — tropical pool area with palm trees",
      link: "https://www.parrishkauai.com/kauai-vacation-rentals/villas-at-poipu-kai/",
      position: 1,
    }],
    [
      "This image showcases the amenities at The Villas at Poipu Kai, featuring a tropical pool area with lush palm trees and volcanic rock features.",
    ],
  ).match === "no",
);

check(
  "classifyCommunityPhotoFromLens marks Villas-at-Poipu-Kai hit as contradicted for Regency",
  classifyCommunityPhotoFromLens(
    regencyPoipuKai,
    [{
      title: "Luxury Kauai Vacation Rentals | Villas at Poipu Kai",
      snippet: "Resort pool and spa at Villas at Poipu Kai",
      link: "https://www.villasatpoipukai.com/",
      position: 1,
    }],
  ).outcome === "contradicted",
);

check(
  "confirms Regency pool when Lens names Regency at Poipu Kai",
  judgeCommunityPhotoFromLens(
    regencyPoipuKai,
    [{
      title: "Regency at Poipu Kai Resort Pool - Koloa",
      snippet: "Regency at Poipu Kai swimming pool and tennis courts",
      link: "https://www.parrishkauai.com/kauai-condos/regency-at-poipu-kai/",
      position: 1,
    }],
  ).match === "yes",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
