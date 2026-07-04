import assert from "node:assert";
import {
  canonicalUnitToken,
  conflictingSiblingUnitToken,
  isSiblingUnitLookalikeHit,
  unitTokensFromListingText,
} from "../shared/sibling-unit-lookalike";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("sibling-unit-lookalike: same-community visual-match suppression (Pili Mai 8J incident)");

// ── canonical tokens ─────────────────────────────────────────────────────────
check("leading zero strips: 08D == 8D", canonicalUnitToken("08D") === "8D" && canonicalUnitToken("8d") === "8D");
check("unit-marker noise strips: '#8J' == 8J", canonicalUnitToken("#8J") === "8J");

// ── extraction (the four real matches from the incident) ─────────────────────
check("'Pili Mai 8K – 3BR/3BA, Central A/C…' → 8K (and NOT 3BR)",
  unitTokensFromListingText("Pili Mai 8K – 3BR/3BA, Central A/C, Golf Course & Distant Ocean Views").join(",") === "8K");
check("'Pili Mai 08D by Parrish Kauai - Koloa | Vrbo' → 8D",
  unitTokensFromListingText("Pili Mai 08D by Parrish Kauai - Koloa | Vrbo").includes("8D"));
check("'Pili Mai Family Condo 13F, Spacious 1st Floor Lanai' → 13F (1st does not match)",
  unitTokensFromListingText("Pili Mai Family Condo 13F, Spacious 1st Floor Lanai, - Koloa").join(",") === "13F");
check("'Pili Mai 7J: Tranquil 3BR Condo w/ Pool' → 7J",
  unitTokensFromListingText("Pili Mai 7J: Tranquil 3BR Condo w/ Pool, Ocean/Golf Views").includes("7J"));
check("redfin-style /unit-8j/ URL → 8J",
  unitTokensFromListingText("https://www.redfin.com/HI/Koloa/2611-Kiahuna-Plantation-Dr-96756/unit-8J/home/144280665").includes("8J"));
check("no unit token in generic title → []",
  unitTokensFromListingText("Spacious tropical getaway w/ private lanai and W/D").length === 0);
check("street numbers / zips are not unit tokens",
  !unitTokensFromListingText("2611 Kiahuna Plantation Dr, Koloa HI 96756").some((t) => t === "2611" || t === "96756"));

// ── conflict decision ────────────────────────────────────────────────────────
check("sibling title (8K) conflicts with our 8J", conflictingSiblingUnitToken("Pili Mai 8K – 3BR/3BA", ["8J"]) === "8K");
check("leading-zero sibling (08D) conflicts with our 8J", conflictingSiblingUnitToken("Pili Mai 08D by Parrish", ["8J"]) === "8D");
check("a title naming OUR unit is NOT a conflict", conflictingSiblingUnitToken("Pili Mai 8J: Tranquil 3BR Condo", ["8J"]) === null);
check("mixed tokens incl. ours → no conflict (benefit of the doubt)",
  conflictingSiblingUnitToken("Pili Mai 8K and 8J combo", ["8J"]) === null);
check("no readable token → no conflict (agreement path keeps working)",
  conflictingSiblingUnitToken("Beach Service by Beach - Heated Pool Dreamland", ["8J"]) === null);
check("no claims of our own → never a conflict", conflictingSiblingUnitToken("Pili Mai 8K", []) === null);

// ── full policy ──────────────────────────────────────────────────────────────
check("visual-match sibling listing IS suppressed",
  isSiblingUnitLookalikeHit({ title: "Pili Mai 8K – 3BR/3BA", link: "https://www.vrbo.com/123", lensSource: "visual", ourUnitClaims: ["8J"] }) === true);
check("known-source hit is NEVER suppressed (real copy of our image)",
  isSiblingUnitLookalikeHit({ title: "Pili Mai 8K – 3BR/3BA", link: "https://www.vrbo.com/123", lensSource: "known-source", ourUnitClaims: ["8J"] }) === false);
check("unit-less repost keeps counting toward agreement",
  isSiblingUnitLookalikeHit({ title: "Tropical condo w/ pool", link: "https://www.vrbo.com/123", lensSource: "visual", ourUnitClaims: ["8J"] }) === false);

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
