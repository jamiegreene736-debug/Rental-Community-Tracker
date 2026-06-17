// Locks the single headline-occupancy rule and every listing's title + summary
// to it. The operator's recurring complaint was the listing title, the summary
// prose, the dashboard "Guests" column, and Guesty `accommodates` showing three
// or four different "sleeps" numbers for the same listing. The fix routes them
// all through occupancyForBedrooms() and corrects the static text; this test
// fails loudly if a title/summary ever drifts off the rule again.
import assert from "node:assert";
import {
  occupancyForBedrooms,
  headlineBedrooms,
  headlineSleeps,
} from "../client/src/data/bedding-config";
import { unitBuilderData } from "../client/src/data/unit-builder-data";

console.log("occupancy-rule");

// ── The rule itself (operator anchors, 2026-06-16) ───────────────────────────
// 2 guests/bedroom + sleeper sofas: +2 for ≤2BR, +4 for ≥3BR.
const anchors: Array<[number, number]> = [
  [0, 0],   // guard
  [1, 4],
  [2, 6],   // anchor
  [3, 10],  // operator-confirmed (drafts)
  [4, 12],  // anchor
  [5, 14],  // anchor
  [6, 16],  // anchor
  [7, 18],  // anchor
  [8, 20],  // extrapolated
];
for (const [br, want] of anchors) {
  assert.equal(occupancyForBedrooms(br), want, `occupancyForBedrooms(${br}) should be ${want}`);
}
// Non-finite / negative guards.
assert.equal(occupancyForBedrooms(-3), 0);
assert.equal(occupancyForBedrooms(NaN), 0);
console.log("  ✓ occupancyForBedrooms anchors (2→6, 4→12, 5→14, 6→16, 7→18; 3→10, 8→20)");

// ── Every builder listing's static title + summary matches the rule ──────────
const titleRe = /(\d+)\s*BR\b.*?Sleeps\s+(\d+)/i;
const summaryRe = /offer\s+(\d+)\s+bedrooms?\s+and\s+can\s+accommodate\s+up\s+to\s+(\d+)\s+guests/i;
let checked = 0;
for (const p of unitBuilderData) {
  const tm = p.bookingTitle.match(titleRe);
  assert.ok(tm, `prop ${p.propertyId}: bookingTitle must carry "<N>BR … Sleeps <M>" → "${p.bookingTitle}"`);
  const titleBr = Number(tm![1]);
  const titleSleeps = Number(tm![2]);
  assert.equal(
    titleSleeps,
    occupancyForBedrooms(titleBr),
    `prop ${p.propertyId}: title "${p.bookingTitle}" says Sleeps ${titleSleeps}, rule wants ${occupancyForBedrooms(titleBr)} for ${titleBr}BR`,
  );

  const sm = p.combinedDescription.match(summaryRe);
  assert.ok(sm, `prop ${p.propertyId}: summary must carry "offer <N> bedrooms … up to <M> guests"`);
  const sumBr = Number(sm![1]);
  const sumGuests = Number(sm![2]);
  assert.equal(sumBr, titleBr, `prop ${p.propertyId}: summary says ${sumBr}BR but title says ${titleBr}BR`);
  assert.equal(
    sumGuests,
    occupancyForBedrooms(sumBr),
    `prop ${p.propertyId}: summary says ${sumGuests} guests, rule wants ${occupancyForBedrooms(sumBr)} for ${sumBr}BR`,
  );
  checked++;
}
assert.ok(checked >= 17, `expected to check ≥17 listings, only saw ${checked}`);
console.log(`  ✓ all ${checked} builder titles + summaries match the rule`);

// ── headlineBedrooms / headlineSleeps key off the advertised bookingTitle ────
// Listing #20 is the operator-resolved conflict: advertised 7BR (sleeps 18)
// even though its bed config still has 2 units. The headline must follow the
// title's "7BR", not the bed-config total.
const emptyCfg = { propertyId: 20, units: [] };
assert.equal(headlineBedrooms(20, emptyCfg), 7, "prop 20 headline bedrooms should be the advertised 7BR");
assert.equal(headlineSleeps(20, emptyCfg), 18, "prop 20 headline sleeps should be 18");
// A draft (negative id, no bookingTitle) falls back to the bed-config total.
assert.equal(headlineBedrooms(-99, { propertyId: -99, units: [] }), 0);
console.log("  ✓ headlineBedrooms/headlineSleeps prefer the advertised bookingTitle, fall back for drafts");

console.log("occupancy-rule: all checks passed");
