import assert from "node:assert";
import { judgeCommunityPhotoFromLens } from "../shared/community-photo-lens-logic";

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
  "empty lens results fail closed",
  judgeCommunityPhotoFromLens(bonitaNational, []).match === "no",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
