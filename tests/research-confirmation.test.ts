import assert from "node:assert/strict";
import {
  abbreviateUsState,
  autoCuratedAirbnbSearchName,
  curatedResortSearchName,
  isCuratedBuyInMarket,
} from "../shared/buy-in-market";
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

// Royal Kahana (Maui) is now a curated market — its draft.name matches the new
// BUY_IN_MARKETS key exactly, so the pricing tab badge goes green and the scan
// uses the clean Airbnb resort query + the curated geo box.
assert.equal(isCuratedBuyInMarket("Royal Kahana"), true);
assert.equal(curatedResortSearchName("Royal Kahana"), "Royal Kahana, Lahaina, HI");

// AUTO-CURATION query half: a non-registry resort gets a clean "Resort, City, ST"
// Airbnb query built from its own identity (the geo box is added server-side from
// geocoded coordinates), never the raw free-text name.
assert.equal(
  autoCuratedAirbnbSearchName({ name: "Sunset Cove", city: "Lahaina", state: "Hawaii" }),
  "Sunset Cove, Lahaina, HI",
);
// Already-abbreviated state passes through (upper-cased); missing pieces are dropped.
assert.equal(autoCuratedAirbnbSearchName({ name: "Beach Villas", city: "Kihei", state: "hi" }), "Beach Villas, Kihei, HI");
assert.equal(autoCuratedAirbnbSearchName({ name: "Lone Tower" }), "Lone Tower");
assert.equal(autoCuratedAirbnbSearchName({ name: "", city: "Kihei", state: "HI" }), "");
// State abbreviation helper.
assert.equal(abbreviateUsState("Hawaii"), "HI");
assert.equal(abbreviateUsState("florida"), "FL");
assert.equal(abbreviateUsState("HI"), "HI");
assert.equal(abbreviateUsState(""), "");
assert.equal(abbreviateUsState(null), "");

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
