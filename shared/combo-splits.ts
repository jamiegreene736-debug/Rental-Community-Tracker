// Bedroom-split enumeration for 2-unit buy-in combos. Extracted into this
// ZERO-DEPENDENCY leaf so BOTH the server matcher (shared/city-vrbo-combo.ts)
// AND the client tracker UI (client/src/pages/bookings.tsx) import the SAME
// source of truth — the escalation tracker must label exactly the splits the
// matcher actually searches. (city-vrbo-combo.ts has top-level computed state
// like FUZZY_SAFE_CANONICALS that esbuild can't reliably tree-shake out of the
// client bundle, so the client must NOT import the whole matcher just for this.)

// The city scan drops <2BR listings, so every split unit must be >= 2BR.
export const MIN_COMBO_UNIT_BEDROOMS = 2;

/**
 * For a 2-UNIT booking, enumerate the valid ways to split the TOTAL bedrooms
 * across two units (each >= MIN). e.g. a 6BR booking can be 3+3 OR 4+2 — both
 * give the guest 6BR in 2 walkable units, so both are valid combos. The
 * CONFIGURED plan is returned FIRST so it wins ties. Plans that aren't exactly
 * two units are returned unchanged (no alternative-split logic). 5BR (3+2) and
 * 4BR (2+2) have no alternative; alternatives only exist for total >= 6.
 * A combo is NEVER more than two units (no 2+2+2 for a 6BR).
 */
export function comboSplitsForPlan(plan: number[]): number[][] {
  if (plan.length !== 2) return [plan];
  const total = (plan[0] || 0) + (plan[1] || 0);
  if (!Number.isFinite(total) || total < 2 * MIN_COMBO_UNIT_BEDROOMS) return [plan];
  const configured = [plan[0], plan[1]];
  const splits: number[][] = [configured];
  const seen = new Set<string>([configured.slice().sort((a, b) => b - a).join("x")]);
  for (let big = total - MIN_COMBO_UNIT_BEDROOMS; big >= Math.ceil(total / 2); big -= 1) {
    const small = total - big;
    if (small < MIN_COMBO_UNIT_BEDROOMS) continue;
    const key = `${big}x${small}`;
    if (seen.has(key)) continue;
    seen.add(key);
    splits.push([big, small]);
  }
  return splits;
}

/**
 * Compact UI labels for the splits the matcher will search, in search order
 * (configured first). e.g. [3,3] -> ["3BR + 3BR", "4BR + 2BR"]; [3,2] -> ["3BR + 2BR"].
 * Each split is shown largest-bedroom-first for a stable read. Returns [] for an
 * empty/invalid plan so the caller can hide the line.
 */
export function comboSplitLabels(plan: number[], unit = "BR"): string[] {
  const clean = plan.filter((br) => Number.isFinite(br) && br > 0);
  // Labels are for 2-UNIT combos ONLY. A 3-unit config like [3,2,2] would
  // otherwise render "3BR + 2BR + 2BR" (comboSplitsForPlan returns non-2-unit
  // plans unchanged) — self-enforce the contract here so the helper is safe even
  // without the hasAlternativeSplit gate. (comboSplitsForPlan itself keeps its
  // pass-through behavior — the matcher relies on it.)
  if (clean.length !== 2) return [];
  return comboSplitsForPlan(clean).map((split) =>
    split
      .slice()
      .sort((a, b) => b - a)
      .map((br) => `${br}${unit}`)
      .join(" + "),
  );
}

/** True when the plan has MORE THAN ONE valid 2-unit split (i.e. a 6BR+ combo). */
export function hasAlternativeSplit(plan: number[]): boolean {
  return comboSplitLabels(plan).length > 1;
}
