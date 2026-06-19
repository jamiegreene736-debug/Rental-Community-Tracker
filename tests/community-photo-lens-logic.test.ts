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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
