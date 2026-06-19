import assert from "node:assert";
import {
  communityPhotoSiblingConflict,
  expectedIsRegencyAtPoipuKai,
  mentionsKnownNonRegencyPoipuKaiComplex,
} from "../shared/community-photo-subcommunity";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("community-photo-subcommunity: Poipu Kai sibling precision");

check("expectedIsRegencyAtPoipuKai recognizes Regency folder",
  expectedIsRegencyAtPoipuKai("Regency at Poipu Kai"));

check("mentionsKnownNonRegencyPoipuKaiComplex catches Villas at Poipu Kai",
  mentionsKnownNonRegencyPoipuKaiComplex("The Villas at Poipu Kai pool amenities") === "Villas at Poipu Kai");

check("mentionsKnownNonRegencyPoipuKaiComplex ignores Parrish Collection (manages Regency and Villas)",
  mentionsKnownNonRegencyPoipuKaiComplex("The Parrish Collection Kauai vacation rentals") == null);

check(
  "communityPhotoSiblingConflict flags Villas pool for Regency expected",
  (() => {
    const c = communityPhotoSiblingConflict(
      "This image showcases the amenities at The Villas at Poipu Kai, featuring a tropical pool area",
      "Regency at Poipu Kai",
    );
    return c != null && c.identifiedCommunity.includes("Villas");
  })(),
);

check(
  "communityPhotoSiblingConflict allows Regency-named hits",
  communityPhotoSiblingConflict(
    "Regency at Poipu Kai resort pool and tennis courts",
    "Regency at Poipu Kai",
  ) == null,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
