import assert from "node:assert/strict";
import { curatedResortSearchName, isCuratedBuyInMarket } from "../shared/buy-in-market";

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

console.log("research-confirmation suite passed");
