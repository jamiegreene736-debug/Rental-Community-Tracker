import assert from "node:assert";
import {
  decideReplacementContinuation,
  mergeReplacementUnits,
  type ReplacementPassFacts,
} from "../shared/replacement-search-continuation";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("replacement-search-continuation: exhaustive find-unit pass control");

const base: ReplacementPassFacts = {
  collectAllOptions: false,
  pass: 0,
  maxPasses: 12,
  accumulatedUnits: 0,
  optionTarget: 12,
  passHadUnit: false,
  passHadError: false,
  budgetStopped: false,
  capExceeded: false,
  uncheckedCount: 0,
};

// ── legacy mode (collectAllOptions off) ──────────────────────────────────────
check("legacy: first unit stops the search",
  decideReplacementContinuation({ ...base, passHadUnit: true, accumulatedUnits: 1, uncheckedCount: 50 }) === "stop-complete");
check("legacy: failed pass with budget-stopped leftovers continues",
  decideReplacementContinuation({ ...base, passHadError: true, budgetStopped: true, uncheckedCount: 30 }) === "continue");
check("legacy: failed pass with cap overflow continues",
  decideReplacementContinuation({ ...base, passHadError: true, capExceeded: true, uncheckedCount: 30 }) === "continue");
check("legacy: failed pass with nothing left fails",
  decideReplacementContinuation({ ...base, passHadError: true }) === "stop-failed");
check("legacy: pass cap exhausted fails even with leftovers",
  decideReplacementContinuation({ ...base, pass: 12, passHadError: true, budgetStopped: true, uncheckedCount: 9 }) === "stop-failed");

// ── exhaustive mode ──────────────────────────────────────────────────────────
const ex = { ...base, collectAllOptions: true };

check("exhaustive: SUCCESS pass with unchecked pool CONTINUES (the whole point)",
  decideReplacementContinuation({ ...ex, passHadUnit: true, accumulatedUnits: 4, uncheckedCount: 40 }) === "continue");
check("exhaustive: success with pool drained completes",
  decideReplacementContinuation({ ...ex, passHadUnit: true, accumulatedUnits: 4, uncheckedCount: 0 }) === "stop-complete");
check("exhaustive: option target met stops even with pool left",
  decideReplacementContinuation({ ...ex, passHadUnit: true, accumulatedUnits: 12, uncheckedCount: 40 }) === "stop-complete");
check("exhaustive: later no-more-units failure AFTER accumulating options is COMPLETE, not failed",
  decideReplacementContinuation({ ...ex, passHadError: true, accumulatedUnits: 5 }) === "stop-complete");
check("exhaustive: failure with zero accumulated units is a real failure",
  decideReplacementContinuation({ ...ex, passHadError: true }) === "stop-failed");
check("exhaustive: failed pass with budget leftovers still continues (like legacy)",
  decideReplacementContinuation({ ...ex, passHadError: true, budgetStopped: true, uncheckedCount: 20 }) === "continue");
check("exhaustive: failed pass with leftovers but NO budget/cap flag does not spin (rejects were real)",
  decideReplacementContinuation({ ...ex, passHadError: true, uncheckedCount: 20 }) === "stop-failed");
check("exhaustive: pass cap exhausted completes with what was accumulated",
  decideReplacementContinuation({ ...ex, pass: 12, passHadUnit: true, accumulatedUnits: 6, uncheckedCount: 30 }) === "stop-complete");

// ── mergeReplacementUnits ────────────────────────────────────────────────────
{
  const merged = mergeReplacementUnits(
    [{ url: "https://z/1" }, { url: "https://z/2" }],
    [{ url: "https://z/2" }, { url: "https://z/3" }, { url: "" }],
  );
  check("merge de-dupes by url and drops url-less rows",
    merged.length === 3 && merged[2].url === "https://z/3");
}
check("merge keeps accumulation order (first-found stays element 0)",
  mergeReplacementUnits([{ url: "a" }], [{ url: "b" }])[0].url === "a");

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
