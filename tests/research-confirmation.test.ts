import assert from "node:assert/strict";
import { curatedResortSearchName, isCuratedBuyInMarket } from "../shared/buy-in-market";
import { comboBedroomSplitIsInferred } from "../shared/draft-unit-bedrooms";

// curatedResortSearchName mirrors the server's curatedAirbnbSearchQueries[0]
// priority: platform Airbnb term → searchLocation → location.searchName → key.
// Poipu Kai has a platformSearch.airbnb term, so that wins.
assert.equal(curatedResortSearchName("Poipu Kai"), "Poipu Kai Resort, Koloa, HI");
// Kapaa Beachfront → the curated Airbnb resort form (Kaha Lani), NOT the raw key.
assert.equal(curatedResortSearchName("Kapaa Beachfront"), "Kaha Lani Resort, Wailua, HI");
// Princeville is a community-level market (spans resorts) — its airbnb term wins.
assert.equal(curatedResortSearchName("Princeville"), "Princeville, Kauai, HI");

// An uncurated community string is returned verbatim (this is exactly what the
// scan searches), and the confirmation UI flags it as not-curated.
assert.equal(curatedResortSearchName("Totally Made Up Resort"), "Totally Made Up Resort");
assert.equal(isCuratedBuyInMarket("Totally Made Up Resort"), false);
assert.equal(isCuratedBuyInMarket("Poipu Kai"), true);

// Empty / nullish input is safe.
assert.equal(curatedResortSearchName(""), "");
assert.equal(curatedResortSearchName(null), "");
assert.equal(curatedResortSearchName(undefined), "");
assert.equal(isCuratedBuyInMarket(""), false);
assert.equal(isCuratedBuyInMarket(null), false);

// comboBedroomSplitIsInferred — Phase 3 "bedroom split inferred" warning.
// Single listings are never inferred.
assert.equal(comboBedroomSplitIsInferred({ singleListing: true, combinedBedrooms: 6 }), false);
// Both unit sizes explicit (stored fields) → not inferred.
assert.equal(comboBedroomSplitIsInferred({ unit1Bedrooms: 3, unit2Bedrooms: 3 }), false);
// Both unit sizes from per-unit prose → not inferred.
assert.equal(
  comboBedroomSplitIsInferred({ unit1Description: "spacious 3 bedroom condo", unit2Description: "cozy 2 bedroom unit" }),
  false,
);
// Only a combined total, no per-unit data → inferred (halved 6 → 3+3).
assert.equal(comboBedroomSplitIsInferred({ combinedBedrooms: 6 }), true);
// One unit explicit, the other derived from the combined total → inferred.
assert.equal(comboBedroomSplitIsInferred({ unit1Bedrooms: 3, combinedBedrooms: 6 }), true);

console.log("research-confirmation suite passed");
