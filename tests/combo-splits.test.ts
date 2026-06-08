// Unit tests for the zero-dep combo-split leaf the tracker UI labels read from.
// The escalation tracker must label EXACTLY the splits the matcher searches, and
// alternatives must appear ONLY for 6BR+ combos (a combo is max 2 units, so a
// 5BR has one split and you can never do 2+2+2 for a 6BR).
import { comboSplitLabels, hasAlternativeSplit, comboSplitsForPlan } from "../shared/combo-splits";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("combo-splits: UI labels + alternative-split detection");

// ── comboSplitLabels: 6BR shows BOTH combos, configured first ────────────────
check("[3,3] (6BR) → ['3BR + 3BR', '4BR + 2BR']",
  eq(comboSplitLabels([3, 3]), ["3BR + 3BR", "4BR + 2BR"]), comboSplitLabels([3, 3]));
check("[4,2] (6BR, configured 4+2) → ['4BR + 2BR', '3BR + 3BR'] (configured first)",
  eq(comboSplitLabels([4, 2]), ["4BR + 2BR", "3BR + 3BR"]), comboSplitLabels([4, 2]));
check("[4,4] (8BR) → ['4BR + 4BR', '6BR + 2BR', '5BR + 3BR']",
  eq(comboSplitLabels([4, 4]), ["4BR + 4BR", "6BR + 2BR", "5BR + 3BR"]), comboSplitLabels([4, 4]));

// ── single-split plans: 5BR / 4BR show ONE combo, no alternative ─────────────
check("[3,2] (5BR) → ['3BR + 2BR'] only (no 4+1, the 1BR is below the 2BR floor)",
  eq(comboSplitLabels([3, 2]), ["3BR + 2BR"]), comboSplitLabels([3, 2]));
check("[2,2] (4BR) → ['2BR + 2BR'] only", eq(comboSplitLabels([2, 2]), ["2BR + 2BR"]), comboSplitLabels([2, 2]));

// ── label always largest-bedroom-first per split (stable read) ───────────────
check("[2,3] normalizes each split largest-first → '3BR + 2BR'",
  eq(comboSplitLabels([2, 3]), ["3BR + 2BR"]), comboSplitLabels([2, 3]));

// ── degenerate / non-combo plans → no labels (caller hides the line) ─────────
check("[3] (one slot) → [] (not a 2-unit combo)", eq(comboSplitLabels([3]), []), comboSplitLabels([3]));
check("[] → []", eq(comboSplitLabels([]), []), comboSplitLabels([]));
check("[0,3] (a zero slot) → [] (cleaned to <2 real slots)", eq(comboSplitLabels([0, 3]), []), comboSplitLabels([0, 3]));
// 3-UNIT config (e.g. property 1 [3,2,2]) must NOT render a '3BR + 2BR + 2BR'
// label — comboSplitLabels self-enforces "exactly 2 units" so it can't ever
// misrepresent a 3-unit property as a 2-unit combo.
check("[3,2,2] (3-unit) → [] (labels are 2-unit only)", eq(comboSplitLabels([3, 2, 2]), []), comboSplitLabels([3, 2, 2]));
check("[3,3,2] (3-unit) → []", eq(comboSplitLabels([3, 3, 2]), []), comboSplitLabels([3, 3, 2]));
check("hasAlternativeSplit [3,2,2] (3-unit) → false", hasAlternativeSplit([3, 2, 2]) === false);

// ── custom unit word (for a verbose 'bedroom' rendering if the UI wants it) ───
check("unit word: [3,3] with ' bedroom' → '3 bedroom + 3 bedroom', '4 bedroom + 2 bedroom'",
  eq(comboSplitLabels([3, 3], " bedroom"), ["3 bedroom + 3 bedroom", "4 bedroom + 2 bedroom"]),
  comboSplitLabels([3, 3], " bedroom"));

// ── hasAlternativeSplit: true ONLY for 6BR+ ──────────────────────────────────
check("hasAlternativeSplit [3,3] (6BR) → true", hasAlternativeSplit([3, 3]) === true);
check("hasAlternativeSplit [4,4] (8BR) → true", hasAlternativeSplit([4, 4]) === true);
check("hasAlternativeSplit [3,2] (5BR) → false", hasAlternativeSplit([3, 2]) === false);
check("hasAlternativeSplit [2,2] (4BR) → false", hasAlternativeSplit([2, 2]) === false);
check("hasAlternativeSplit [3] → false", hasAlternativeSplit([3]) === false);

// ── labels are consistent with comboSplitsForPlan (single source of truth) ───
check("labels count == comboSplitsForPlan count for [3,3]",
  comboSplitLabels([3, 3]).length === comboSplitsForPlan([3, 3]).length);
check("labels count == comboSplitsForPlan count for [4,4]",
  comboSplitLabels([4, 4]).length === comboSplitsForPlan([4, 4]).length);

console.log(`\ncombo-splits: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
