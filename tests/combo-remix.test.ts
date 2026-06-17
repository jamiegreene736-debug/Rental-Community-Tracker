// Unit tests for remixBedroomSplits — the bedroom re-mix fallback used when a
// same-size combo (e.g. 3BR + 3BR) can't source two DISTINCT units. The re-mix
// must PRESERVE the combined total, use two DIFFERENT sizes, exclude the
// original split, and never propose a unit larger than the cap (no 5BR condos).
import { remixBedroomSplits, comboFallbackPairings } from "../shared/community-combo";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("combo-remix: bedroom re-mix split generation");

// ── the headline case: 3+3 can't find a 2nd 3BR → re-mix to 4BR + 2BR ─────────
check("3+3 (6BR) → [{4,2}] (larger half = Unit A)",
  eq(remixBedroomSplits(3, 3), [{ unit1Beds: 4, unit2Beds: 2 }]), remixBedroomSplits(3, 3));

// ── total is always preserved ────────────────────────────────────────────────
check("every 3+3 split totals 6",
  remixBedroomSplits(3, 3).every((s) => s.unit1Beds + s.unit2Beds === 6), remixBedroomSplits(3, 3));

// ── 2+2 (4BR) → 3BR + 1BR ────────────────────────────────────────────────────
check("2+2 (4BR) → [{3,1}]",
  eq(remixBedroomSplits(2, 2), [{ unit1Beds: 3, unit2Beds: 1 }]), remixBedroomSplits(2, 2));

// ── 4+4 (8BR): NO valid same-total split under the 4BR cap (5+3/6+2 forbidden) ─
check("4+4 (8BR) → [] under the 4BR cap (caller falls back to photo reuse)",
  eq(remixBedroomSplits(4, 4), []), remixBedroomSplits(4, 4));

// ── the cap is honored: never propose a unit > maxUnitBeds ───────────────────
check("3+3 with maxUnitBeds=4 never proposes a 5BR+ half",
  remixBedroomSplits(3, 3, { maxUnitBeds: 4 }).every((s) => s.unit1Beds <= 4 && s.unit2Beds <= 4),
  remixBedroomSplits(3, 3, { maxUnitBeds: 4 }));
check("raising the cap to 5 unlocks 4+4 → [{5,3}] (only when explicitly allowed)",
  eq(remixBedroomSplits(4, 4, { maxUnitBeds: 5 }), [{ unit1Beds: 5, unit2Beds: 3 }]),
  remixBedroomSplits(4, 4, { maxUnitBeds: 5 }));

// ── the original split is excluded (we already failed to find two of those) ───
check("4+2 (already distinct) → does not re-propose {4,2} or {2,4}",
  remixBedroomSplits(4, 2).every((s) => !((s.unit1Beds === 4 && s.unit2Beds === 2))),
  remixBedroomSplits(4, 2));

// ── both halves must be DIFFERENT sizes ──────────────────────────────────────
check("no split returns two equal halves",
  [remixBedroomSplits(3, 3), remixBedroomSplits(4, 4), remixBedroomSplits(2, 2), remixBedroomSplits(5, 5)]
    .every((list) => list.every((s) => s.unit1Beds !== s.unit2Beds)), "equal-halves leaked");

// ── larger half is always Unit A (stable so save() maps A=big, B=small) ───────
check("larger half is always unit1Beds",
  remixBedroomSplits(3, 3).concat(remixBedroomSplits(2, 2)).every((s) => s.unit1Beds >= s.unit2Beds),
  "ordering");

// ── limit caps the number of candidates ──────────────────────────────────────
check("limit:0 → []", eq(remixBedroomSplits(3, 3, { limit: 0 }), []), remixBedroomSplits(3, 3, { limit: 0 }));

// ── degenerate inputs are safe ───────────────────────────────────────────────
check("0+0 → []", eq(remixBedroomSplits(0, 0), []), remixBedroomSplits(0, 0));

// ── comboFallbackPairings: the bulk-queue STRICT ladder (keep beds high, then ──
// ── step down) — same-total re-mixes first, then smaller totals to the 2BR floor.
console.log("\ncombo-remix: fallback combination-type ladder (strict bulk queue)");

// Headline: 3+3 (6BR) → 4+2 (still 6BR) → 3+2 (5BR) → 2+2 (4BR).
check("3+3 (6BR) → [4+2, 3+2, 2+2]",
  eq(comboFallbackPairings(3, 3), [
    { unit1Beds: 4, unit2Beds: 2 },
    { unit1Beds: 3, unit2Beds: 2 },
    { unit1Beds: 2, unit2Beds: 2 },
  ]), comboFallbackPairings(3, 3));

// Same-total re-mix is ALWAYS tried before any smaller total.
check("3+3 ladder starts with the same-total re-mix (4+2)",
  eq(comboFallbackPairings(3, 3)[0], { unit1Beds: 4, unit2Beds: 2 }), comboFallbackPairings(3, 3)[0]);

// The 2BR+2BR floor is reached for a 6BR combo (the operator's explicit example).
check("3+3 ladder ends at the 2BR+2BR floor",
  comboFallbackPairings(3, 3).some((s) => s.unit1Beds === 2 && s.unit2Beds === 2),
  comboFallbackPairings(3, 3));

// 4+4 (8BR): no same-total re-mix under the 4BR cap, so it steps straight down
// through smaller totals to 2+2.
check("4+4 (8BR) → [4+3, 4+2, 3+3, 3+2, 2+2]",
  eq(comboFallbackPairings(4, 4), [
    { unit1Beds: 4, unit2Beds: 3 },
    { unit1Beds: 4, unit2Beds: 2 },
    { unit1Beds: 3, unit2Beds: 3 },
    { unit1Beds: 3, unit2Beds: 2 },
    { unit1Beds: 2, unit2Beds: 2 },
  ]), comboFallbackPairings(4, 4));

// 2+2 (4BR) is already the floor — there is nothing smaller to try.
check("2+2 (4BR) → [] (already the abundant floor)",
  eq(comboFallbackPairings(2, 2), []), comboFallbackPairings(2, 2));

// Never proposes a 1BR half (floor is 2BR by default) nor a 5BR+ half (cap 4).
check("no fallback half is below 2BR or above 4BR",
  [comboFallbackPairings(3, 3), comboFallbackPairings(4, 4), comboFallbackPairings(4, 3), comboFallbackPairings(3, 2)]
    .every((list) => list.every((s) => s.unit2Beds >= 2 && s.unit1Beds <= 4)),
  "out-of-range half leaked");

// The requested split is never re-proposed as a fallback.
check("requested split is excluded from its own ladder",
  comboFallbackPairings(3, 3).every((s) => !(s.unit1Beds === 3 && s.unit2Beds === 3))
    && comboFallbackPairings(4, 2).every((s) => !((s.unit1Beds === 4 && s.unit2Beds === 2))),
  "requested split leaked");

// No duplicate combo keys in the ladder.
check("ladder has no duplicate combo keys",
  [comboFallbackPairings(3, 3), comboFallbackPairings(4, 4), comboFallbackPairings(5, 3)]
    .every((list) => {
      const keys = list.map((s) => `${s.unit1Beds}+${s.unit2Beds}`);
      return new Set(keys).size === keys.length;
    }), "duplicate combo key");

// larger half is always Unit A (stable A=big, B=small mapping for save()).
check("fallback larger half is always unit1Beds",
  [comboFallbackPairings(3, 3), comboFallbackPairings(4, 4), comboFallbackPairings(4, 3)]
    .every((list) => list.every((s) => s.unit1Beds >= s.unit2Beds)), "ordering");

// limit caps the ladder length.
check("limit:1 → only the first (same-total) candidate",
  eq(comboFallbackPairings(3, 3, { limit: 1 }), [{ unit1Beds: 4, unit2Beds: 2 }]),
  comboFallbackPairings(3, 3, { limit: 1 }));
check("limit:0 → []", eq(comboFallbackPairings(3, 3, { limit: 0 }), []), comboFallbackPairings(3, 3, { limit: 0 }));

// degenerate inputs are safe.
check("0+0 → []", eq(comboFallbackPairings(0, 0), []), comboFallbackPairings(0, 0));

console.log(`\ncombo-remix: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
