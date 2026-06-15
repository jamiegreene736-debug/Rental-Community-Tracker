export type TypicalComboBedroomFields = {
  availableBedrooms?: number[] | null;
  estimatedBedroomUnitCounts?: Record<string, number> | null;
  combinedBedroomsTypical?: number | null;
};

export type TypicalComboPair = { unitBeds: number; secondUnitBeds?: number; totalBeds: number };

export type ComboPairingAvailability = {
  totalBeds: number;
  matchScore: number;
  availability?: "available" | "existing" | "reserved";
  alreadyExists?: boolean;
  reserved?: boolean;
};

export function isComboPairingAvailable(pairing: ComboPairingAvailability): boolean {
  return (
    pairing.availability === "available"
    || (
      !pairing.alreadyExists
      && !pairing.reserved
      && pairing.availability !== "existing"
      && pairing.availability !== "reserved"
    )
  );
}

/** Prefer the largest unused combo (e.g. 8BR over 6BR when both are open). */
export function pickBestAvailableComboPairing<T extends ComboPairingAvailability>(
  pairings: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const pairing of pairings) {
    if (!isComboPairingAvailable(pairing)) continue;
    if (
      !best
      || pairing.totalBeds > best.totalBeds
      || (pairing.totalBeds === best.totalBeds && pairing.matchScore > best.matchScore)
    ) {
      best = pairing;
    }
  }
  return best;
}

function getComboBedroomCounts(community: Pick<TypicalComboBedroomFields, "estimatedBedroomUnitCounts">): Map<number, number> {
  const counts = new Map<number, number>();
  if (community.estimatedBedroomUnitCounts) {
    for (const [bedrooms, count] of Object.entries(community.estimatedBedroomUnitCounts)) {
      const bedroomCount = Math.round(Number(String(bedrooms).replace(/[^\d.]/g, "")));
      const unitCount = Math.round(Number(count));
      if (Number.isFinite(bedroomCount) && bedroomCount > 0 && Number.isFinite(unitCount) && unitCount > 0) {
        counts.set(bedroomCount, Math.max(counts.get(bedroomCount) ?? 0, unitCount));
      }
    }
  }
  return counts;
}

function getComboAvailableBedrooms(community: Pick<TypicalComboBedroomFields, "availableBedrooms" | "estimatedBedroomUnitCounts">): Set<number> {
  const bedrooms = new Set<number>();
  for (const value of community.availableBedrooms ?? []) {
    const normalized = Math.round(Number(value));
    if (Number.isFinite(normalized) && normalized > 0) bedrooms.add(normalized);
  }
  getComboBedroomCounts(community).forEach((_count, bedroom) => bedrooms.add(bedroom));
  return bedrooms;
}

/** Best typical two-unit combo for display (same scoring as search-units). */
export function inferTypicalComboPair(community: TypicalComboBedroomFields): TypicalComboPair | null {
  const availableTypes = Array.from(getComboAvailableBedrooms(community)).sort((a, b) => a - b);
  if (availableTypes.length === 0) return null;

  let best: TypicalComboPair | null = null;
  let bestScore = -1;
  for (let i = 0; i < availableTypes.length; i += 1) {
    for (let j = i; j < availableTypes.length; j += 1) {
      const b1 = availableTypes[i];
      const b2 = availableTypes[j];
      const total = b1 + b2;
      if (total < 3 || total > 10) continue;
      const counts = getComboBedroomCounts(community);
      if (b1 === b2 && counts.size > 0 && (counts.get(b1) ?? 0) < 2) continue;
      const fourBrBoost = availableTypes.includes(4) && (b1 === 4 || b2 === 4) ? 2 : 0;
      const matchScore = (b1 === b2 ? 2 : 0) + Math.min(total / 2, 3) + fourBrBoost;
      if (!best || matchScore > bestScore || (matchScore === bestScore && total > best.totalBeds)) {
        bestScore = matchScore;
        best = { unitBeds: b1, secondUnitBeds: b2, totalBeds: total };
      }
    }
  }
  return best;
}

export function formatTypicalComboLabel(pair: TypicalComboPair | null | undefined): string {
  if (!pair) return "";
  const second = pair.secondUnitBeds ?? pair.unitBeds;
  if (second !== pair.unitBeds) {
    return ` · ${pair.unitBeds}BR+${second}BR=${pair.totalBeds}BR`;
  }
  return ` · 2×${pair.unitBeds}BR=${pair.totalBeds}BR`;
}

export type RemixSplit = { unit1Beds: number; unit2Beds: number };

/**
 * When a same-size combo (e.g. 3BR + 3BR) cannot source two DISTINCT units in a
 * community, propose alternative bedroom SPLITS of the SAME total using two
 * DIFFERENT unit sizes — so each half draws from a different inventory pool and
 * is far more likely to resolve to a genuine second unit.
 *
 * Rules (operator-driven):
 * - Preserves the combined bedroom total (a 6BR combo stays 6BR: 3+3 -> 4+2).
 * - Caps each half at `maxUnitBeds` (default 4 — there is no 5BR condo in these
 *   communities) and floors at `minUnitBeds` (default 1).
 * - Both halves must be DIFFERENT sizes (the whole point), and the original
 *   split is excluded.
 * - The larger half is returned as `unit1Beds` (Unit A), the smaller as
 *   `unit2Beds` (Unit B). Ordered most-balanced-first and capped to `limit`.
 *
 * Examples (maxUnitBeds=4): 3+3 -> [{4,2}]; 2+2 -> [{3,1}]; 4+4 -> [] (no valid
 * same-total split under the 4BR cap) -> caller falls back to photo reuse.
 */
export function remixBedroomSplits(
  unit1Beds: number,
  unit2Beds: number,
  opts: { maxUnitBeds?: number; minUnitBeds?: number; limit?: number } = {},
): RemixSplit[] {
  const a0 = Math.round(Number(unit1Beds) || 0);
  const b0 = Math.round(Number(unit2Beds) || 0);
  const total = a0 + b0;
  const maxUnitBeds = Math.max(1, Math.round(opts.maxUnitBeds ?? 4));
  const minUnitBeds = Math.max(1, Math.round(opts.minUnitBeds ?? 1));
  const limit = Math.max(0, Math.round(opts.limit ?? 3));
  if (total <= 0 || limit === 0) return [];
  const out: RemixSplit[] = [];
  // `big` = larger half: from the cap down to just above half (so big > small).
  for (let big = Math.min(maxUnitBeds, total - minUnitBeds); big * 2 > total; big -= 1) {
    const small = total - big;
    if (small < minUnitBeds || small > maxUnitBeds) continue;
    if (big === small) continue; // must be two DIFFERENT sizes
    if ((big === a0 && small === b0) || (big === b0 && small === a0)) continue; // skip original
    out.push({ unit1Beds: big, unit2Beds: small });
  }
  // Most-balanced first (smallest larger-half), then cap.
  out.sort((x, y) => x.unit1Beds - y.unit1Beds);
  return out.slice(0, limit);
}

export function normalizeCombinedBedroomsTypical(community: TypicalComboBedroomFields): number | undefined {
  const inferred = inferTypicalComboPair(community);
  if (inferred) return inferred.totalBeds;
  const stored = typeof community.combinedBedroomsTypical === "number"
    ? Math.round(community.combinedBedroomsTypical)
    : undefined;
  return stored && stored > 0 ? stored : undefined;
}
