// Profit-aware sourceability gate — pure-logic tests (no network).
// Covers the Airbnb-rate → assumed-buy-in-cost helpers and the loss decision.
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  exactBedroomsFromAirbnbListing,
  matchesCommunityName,
  isOwnListing,
  trimmedPercentile,
  assumedComboCost,
} = await import("../server/availability-search");

const { decideSourceabilityWithProfit } = await import("../server/sourceability-gate-core");
const { BUY_IN_MARKETS } = await import("@shared/buy-in-market");

let passed = 0;
const ok = (name: string) => { passed++; };

// ── exactBedroomsFromAirbnbListing ──────────────────────────────────────────
assert.equal(exactBedroomsFromAirbnbListing({ accommodations: ["3 bedrooms", "4 beds"] }), 3);
assert.equal(exactBedroomsFromAirbnbListing({ accommodations: ["Studio", "1 bed"] }), 0);
assert.equal(exactBedroomsFromAirbnbListing({ accommodations: ["4 beds", "2 baths"] }), null, "'4 beds' must not read as bedrooms");
assert.equal(exactBedroomsFromAirbnbListing({ accommodations: [] }), null);
assert.equal(exactBedroomsFromAirbnbListing({}), null);
assert.equal(exactBedroomsFromAirbnbListing({ accommodations: ["6 bedrooms"] }), 6);
ok("exactBedroomsFromAirbnbListing");

// ── matchesCommunityName (real Poipu Kai alias regex) ───────────────────────
const pkAliases = BUY_IN_MARKETS["Poipu Kai"].aliases;
assert.equal(matchesCommunityName({ title: "Regency at Poipu Kai 423 By Parrish" }, pkAliases), true);
assert.equal(matchesCommunityName({ title: "Lovely Poipu Beach condo, south shore" }, pkAliases), true, "bare 'poipu' matches Poipu Kai alias");
assert.equal(matchesCommunityName({ title: "Makahuena 4204 Oceanfront AC" }, pkAliases), false, "a non-Poipu Makahuena title is not Poipu Kai");
assert.equal(matchesCommunityName({ title: "Hanalei Bay Estate, north shore" }, pkAliases), false);
assert.equal(matchesCommunityName({ title: "anything" }, undefined), true, "no aliases ⇒ fail-open membership");
ok("matchesCommunityName");

// ── isOwnListing ────────────────────────────────────────────────────────────
const own = ["Poipu Kai - 6BR Villas, Pool - Sleeps 16", "Pili Mai - 5BR Townhomes - Sleeps 14"];
assert.equal(isOwnListing({ title: "Poipu Kai - 6BR Villas, Pool - Sleeps 16" }, own), true, "our own listing excluded");
assert.equal(isOwnListing({ title: "Poipu Kai 6BR Villas Pool - Sleeps 16 (great views!)" }, own), true, "lead-match survives punctuation/suffix");
assert.equal(isOwnListing({ title: "1308 Oceanview | Turtles • Pool • Spa" }, own), false, "unrelated listing not excluded");
assert.equal(isOwnListing({ title: "Regency 524 Island Casual" }, own), false);
assert.equal(isOwnListing({ title: "Poipu Kai - 6BR Villas, Pool - Sleeps 16" }, []), false, "no own names ⇒ never excludes");
ok("isOwnListing");

// ── trimmedPercentile ───────────────────────────────────────────────────────
assert.equal(trimmedPercentile([], 0.9), null);
assert.equal(trimmedPercentile([500], 0.9), 500);
assert.equal(trimmedPercentile([100, 200], 0.5), 150);
// n>=4 drops the single top outlier so one luxury listing can't spike a thin pool
assert.equal(trimmedPercentile([100, 100, 100, 100, 5000], 0.9), 100, "top outlier trimmed on n>=4");
// n<4 keeps everything (can't reliably call something an outlier)
assert.ok((trimmedPercentile([100, 5000], 0.9) as number) > 1000, "n<4 keeps the high value");
ok("trimmedPercentile");

// ── assumedComboCost ────────────────────────────────────────────────────────
const slots33 = [{ bedrooms: 3 }, { bedrooms: 3 }];
assert.equal(assumedComboCost(slots33, { 3: 500 }, 7), 7000, "2 x 500 x 7 (combo path only)");
assert.equal(assumedComboCost(slots33, { 3: 500, 6: 600 }, 7), 4200, "cheaper single-6BR path wins: 600 x 7");
assert.equal(assumedComboCost(slots33, { 6: 900 }, 7), 6300, "no 3BR price ⇒ fall back to single-6BR");
assert.equal(assumedComboCost(slots33, {}, 7), null, "no priced path ⇒ null (caller fail-safe-opens)");
assert.equal(assumedComboCost([{ bedrooms: 3 }, { bedrooms: 2 }], { 3: 500, 2: 400 }, 7), 6300, "mixed combo sums");
ok("assumedComboCost");

// ── decideSourceabilityWithProfit ───────────────────────────────────────────
const sets1 = { ok: true, setsAvailable: 1, detail: "3BR×4 → 1 set(s)" };
assert.equal(decideSourceabilityWithProfit({ ok: false, setsAvailable: 0 }, { assumedCost: 1, sellPrice: 1, minMargin: 0 }).decision, "skip", "failed search ⇒ skip");
assert.equal(decideSourceabilityWithProfit({ ok: true, setsAvailable: 0 }, { assumedCost: null, sellPrice: null, minMargin: 0 }).decision, "block", "no set ⇒ block (unsourceable)");
assert.equal(decideSourceabilityWithProfit(sets1, { assumedCost: null, sellPrice: 7000, minMargin: 0 }).decision, "open", "no cost ⇒ open (profit not assessable)");
assert.equal(decideSourceabilityWithProfit(sets1, { assumedCost: 9000, sellPrice: null, minMargin: 0 }).decision, "open", "no sell ⇒ open");
assert.equal(decideSourceabilityWithProfit(sets1, { assumedCost: 8000, sellPrice: 7000, minMargin: 0 }).decision, "block", "cost>sell ⇒ block (loss)");
assert.equal(decideSourceabilityWithProfit(sets1, { assumedCost: 6000, sellPrice: 7000, minMargin: 0 }).decision, "open", "cost<sell ⇒ open (profitable)");
assert.equal(decideSourceabilityWithProfit(sets1, { assumedCost: 7000, sellPrice: 7000, minMargin: 0 }).decision, "open", "cost==sell at minMargin 0 ⇒ open (not a loss)");
assert.equal(decideSourceabilityWithProfit(sets1, { assumedCost: 6500, sellPrice: 7000, minMargin: 0.1 }).decision, "block", "10% margin floor: 6500 > 6300 ceiling ⇒ block");
assert.equal(decideSourceabilityWithProfit(sets1, { assumedCost: 6200, sellPrice: 7000, minMargin: 0.1 }).decision, "open", "10% margin floor: 6200 < 6300 ceiling ⇒ open");
ok("decideSourceabilityWithProfit");

console.log(`sourceability-profit: ${passed} groups passed`);
