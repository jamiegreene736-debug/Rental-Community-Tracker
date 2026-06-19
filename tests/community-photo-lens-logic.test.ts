import assert from "node:assert";
import {
  judgeCommunityPhotoFromLens,
  classifyCommunityPhotoFromLens,
  communitySharesGeoArea,
  analyzeAiOverviewForCommunity,
} from "../shared/community-photo-lens-logic";

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

// ── Regency at Poipu Kai: decisive sibling conflicts (Villas, etc.) ─────────
const regency = "Regency at Poipu Kai";

check(
  "flags Villas at Poipu Kai pool as wrong community for Regency",
  judgeCommunityPhotoFromLens(
    regency,
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
    regency,
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
    regency,
    [{
      title: "Regency at Poipu Kai Resort Pool - Koloa",
      snippet: "Regency at Poipu Kai swimming pool and tennis courts",
      link: "https://www.parrishkauai.com/kauai-condos/regency-at-poipu-kai/",
      position: 1,
    }],
  ).match === "yes",
);

check(
  "AI Overview naming Villas at Poipu Kai contradicts Regency (not dict-key confirm)",
  analyzeAiOverviewForCommunity(
    ["This image showcases the amenities at The Villas at Poipu Kai, featuring a tropical pool area."],
    regency,
    "Koloa",
  ).outcome === "contradicts",
);

// ── Regency pool: top hit Regency beats lower Villas sibling (user report) ──
const regencyPoolRows = [
  {
    title: "Regency at Poipu Kai #821 (3BD)",
    snippet: "The Parrish Collection Kauai — resort pool with lounge chairs",
    link: "https://www.parrishkauai.com/kauai-condos/regency-at-poipu-kai/",
    position: 1,
  },
  {
    title: "Garden Villas in Kauai, Hawaii - Villas At Poipu Kai",
    snippet: "Villas at Poipu Kai pool and tropical landscaping",
    link: "https://www.villasatpoipukai.com/",
    position: 2,
  },
];
const regencyPoolAiOverview = [
  "This image showcases the pool area at the Regency at Poipu Kai resort on Kauai, featuring tropical foliage, lounge chairs, and a paved patio surrounding the pool.",
];

check(
  "Regency #821 at position 1 confirms despite Villas sibling at position 2",
  judgeCommunityPhotoFromLens(regency, regencyPoolRows).match === "yes",
);

check(
  "classifyCommunityPhotoFromLens confirms Regency pool when top organic hit names Regency",
  classifyCommunityPhotoFromLens(regency, regencyPoolRows, [], "Koloa").outcome === "confirmed",
);

check(
  "AI Overview naming Regency confirms pool photo despite Villas organic hit",
  classifyCommunityPhotoFromLens(regency, regencyPoolRows, regencyPoolAiOverview, "Koloa").outcome === "confirmed",
);

check(
  "Parrish Collection snippet on Regency listing does not false-flag sibling conflict",
  judgeCommunityPhotoFromLens(
    regency,
    [{
      title: "Regency at Poipu Kai #821 (3BD)",
      snippet: "The Parrish Collection Kauai vacation rentals",
      link: "https://www.parrishkauai.com/kauai-condos/regency-at-poipu-kai/",
      position: 1,
    }],
  ).match === "yes",
);

// ── Same-area sibling-resort cross-matches defer to vision (Poipu) ──────────
check(
  "communitySharesGeoArea: sibling Poipu resort shares area",
  communitySharesGeoArea("poipu sands", regency, "Koloa")
  && communitySharesGeoArea("Poipu Kapili", regency, "Koloa"),
);

check(
  "communitySharesGeoArea: different area does not share",
  !communitySharesGeoArea("Mauna Kai Princeville", regency, "Koloa")
  && !communitySharesGeoArea("Hanalei Bay Resort", regency, "Koloa"),
);

check(
  "same-area Poipu Sands hit defers to vision (inconclusive, not contradicted)",
  classifyCommunityPhotoFromLens(
    regency,
    [{ title: "Vacation rental at Poipu Sands", snippet: "poipu sands resort pool", link: "https://x.com", position: 1 }],
    [],
    "Koloa",
  ).outcome === "inconclusive",
);

check(
  "same-area Poipu Kapili hit defers to vision",
  classifyCommunityPhotoFromLens(
    regency,
    [{ title: "Poipu Kapili condo", snippet: "poipu kapili pool and spa", link: "https://y.com", position: 1 }],
    [],
    "Koloa",
  ).outcome === "inconclusive",
);

check(
  "different-area Princeville hit still hard-contradicts",
  classifyCommunityPhotoFromLens(
    regency,
    [{ title: "stay at Mauna Kai Princeville", snippet: "mauna kai princeville", link: "https://z.com", position: 1 }],
    [],
    "Koloa",
  ).outcome === "contradicted",
);

// ── Google Lens AI Overview is authoritative (the operator's tennis court) ──
const tennisRows = [
  { title: "Poipu Sands at Poipu Kai #234", snippet: "poipu sands at poipu kai", link: "https://x.com/poipu-sands", source: "organic", position: 1 },
  { title: "Poipu Kai Resort Vacation Rentals | Parrish Kauai", snippet: "Discover Poipu Kai vacation rentals", link: "https://x.com/poipu-kai", source: "organic", position: 2 },
];
const tennisAiOverview = [
  "These are the tennis courts at the Poipu Kai Resort in Kauai.",
  "The tennis club features eight total courts.",
];

check(
  "analyzeAiOverviewForCommunity confirms when overview names the expected resort",
  analyzeAiOverviewForCommunity(tennisAiOverview, regency, "Koloa").outcome === "confirms",
);

check(
  "AI Overview naming Poipu Kai CONFIRMS the photo despite a sibling-resort organic conflict",
  classifyCommunityPhotoFromLens(regency, tennisRows, tennisAiOverview, "Koloa").outcome === "confirmed",
);

check(
  "without the AI Overview, the sibling conflict still defers to vision (inconclusive)",
  classifyCommunityPhotoFromLens(regency, tennisRows, [], "Koloa").outcome === "inconclusive",
);

check(
  "AI Overview naming a DIFFERENT-area resort still hard-contradicts",
  classifyCommunityPhotoFromLens(
    regency,
    [],
    ["This is the pool at Hanalei Bay Resort in Princeville."],
    "Koloa",
  ).outcome === "contradicted",
);

check(
  "analyzeAiOverviewForCommunity: empty overview is inconclusive",
  analyzeAiOverviewForCommunity([], regency, "Koloa").outcome === "inconclusive",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
