// Pass-to-pass control flow for the background "find a replacement unit"
// job (server/preflight-background-jobs.ts runPreflightReplacementFindJob).
//
// Legacy behavior (collectAllOptions OFF): stop at the first pass that
// returns a unit; continue only after a FAILED pass that left candidates
// unchecked (route/SearchAPI budget tripped or discovery overflowed a pass).
//
// Exhaustive behavior (collectAllOptions ON — "find ALL possible replacement
// units"): keep continuing after SUCCESSFUL passes too, accumulating viable
// units across passes, until the candidate pool is drained, the option
// target is met, or the pass cap is hit. A later pass that fails with
// "no eligible units" after options were already accumulated is pool
// exhaustion — a COMPLETED search, not a failure.
//
// Pure + unit-tested; the job runner just executes the decision.

export type ReplacementContinuationDecision = "continue" | "stop-complete" | "stop-failed";

export type ReplacementPassFacts = {
  collectAllOptions: boolean;
  pass: number;              // 0-based index of the pass that just finished
  maxPasses: number;         // total passes allowed (pass cap, inclusive)
  accumulatedUnits: number;  // viable units accumulated across passes so far (incl. this pass)
  optionTarget: number;      // exhaustive mode stops once this many options exist
  passHadUnit: boolean;
  passHadError: boolean;
  budgetStopped: boolean;
  capExceeded: boolean;
  uncheckedCount: number;
};

export const REPLACEMENT_EXHAUSTIVE_OPTION_TARGET_DEFAULT = 12;

export function decideReplacementContinuation(f: ReplacementPassFacts): ReplacementContinuationDecision {
  const passBudgetLeft = f.pass < f.maxPasses;
  if (!f.collectAllOptions) {
    // Legacy: first success wins; a clean "no error, no unit" response ends
    // the loop too (nothing more the route can do).
    if (f.passHadUnit) return "stop-complete";
    if (!f.passHadError) return "stop-complete";
    const resumable = (f.budgetStopped || f.capExceeded) && f.uncheckedCount > 0;
    return resumable && passBudgetLeft ? "continue" : "stop-failed";
  }
  // Exhaustive: drain the pool while there is one and the target isn't met.
  if (f.uncheckedCount > 0 && f.accumulatedUnits < f.optionTarget && passBudgetLeft) {
    // A failed pass with NO budget/cap flag means the leftover pool was
    // actually checked and rejected — continuing would re-check rejects.
    if (f.passHadUnit || f.budgetStopped || f.capExceeded) return "continue";
  }
  if (f.accumulatedUnits > 0) return "stop-complete";
  return f.passHadError ? "stop-failed" : "stop-complete";
}

// Merge one pass's units into the accumulated list, de-duped by listing url.
// Returns the same array reference semantics callers expect (new array).
export function mergeReplacementUnits<T extends { url?: unknown }>(
  accumulated: T[],
  incoming: T[],
): T[] {
  const out = [...accumulated];
  const seen = new Set(out.map((u) => String(u.url ?? "")).filter(Boolean));
  for (const unit of incoming) {
    const key = String(unit.url ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(unit);
  }
  return out;
}
