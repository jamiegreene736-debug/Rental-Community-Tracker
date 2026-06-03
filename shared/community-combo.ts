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

export function normalizeCombinedBedroomsTypical(community: TypicalComboBedroomFields): number | undefined {
  const inferred = inferTypicalComboPair(community);
  if (inferred) return inferred.totalBeds;
  const stored = typeof community.combinedBedroomsTypical === "number"
    ? Math.round(community.combinedBedroomsTypical)
    : undefined;
  return stored && stored > 0 ? stored : undefined;
}
