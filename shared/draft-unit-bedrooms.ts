// Resolves per-unit bedroom counts for community drafts (combo + single).
// Combo drafts often store Zillow-scraped 2BR on each unit while
// combinedBedrooms / listingTitle correctly say 6BR — preflight must
// reconcile before photo discovery and platform checks.

export type DraftBedroomFields = {
  singleListing?: boolean | null;
  combinedBedrooms?: number | null;
  unit1Bedrooms?: number | null;
  unit2Bedrooms?: number | null;
  unit1Description?: string | null;
  unit2Description?: string | null;
  unit1ShortDescription?: string | null;
  unit2ShortDescription?: string | null;
  unit1LongDescription?: string | null;
  unit2LongDescription?: string | null;
  unit1Bedding?: string | null;
  unit2Bedding?: string | null;
  listingTitle?: string | null;
  bookingTitle?: string | null;
  name?: string | null;
  unitTypes?: string | null;
  listingDescription?: string | null;
};

const BR_PATTERN = /(\d{1,2})\s*(?:br|bd|bed(?:room)?s?)/i;

export function positiveDraftInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstBedroomInText(text: string): number | null {
  const match = text.match(BR_PATTERN);
  return match ? positiveDraftInteger(match[1]) : null;
}

/** Combined bedroom total from structured field or listing-level copy. */
export function inferCombinedBedroomsFromDraft(draft: DraftBedroomFields): number | null {
  const stored = positiveDraftInteger(draft.combinedBedrooms);
  if (stored) return stored;
  const text = [
    draft.listingTitle,
    draft.bookingTitle,
    draft.name,
    draft.unitTypes,
    draft.listingDescription,
  ].filter(Boolean).join(" ");
  return firstBedroomInText(text);
}

function unitSpecificText(draft: DraftBedroomFields, unitKey: "unit1" | "unit2"): string {
  return [
    unitKey === "unit1" ? draft.unit1Description : draft.unit2Description,
    unitKey === "unit1" ? draft.unit1Bedding : draft.unit2Bedding,
    unitKey === "unit1" ? draft.unit1ShortDescription : draft.unit2ShortDescription,
    unitKey === "unit1" ? draft.unit1LongDescription : draft.unit2LongDescription,
    draft.unitTypes,
  ].filter(Boolean).join(" ");
}

/** Stored or unit-specific prose only — never listingTitle on combo drafts. */
export function inferStoredUnitBedrooms(
  draft: DraftBedroomFields,
  unitKey: "unit1" | "unit2",
): number | null {
  const stored = unitKey === "unit1" ? draft.unit1Bedrooms : draft.unit2Bedrooms;
  const fromStored = positiveDraftInteger(stored);
  if (fromStored) return fromStored;
  if (draft.singleListing === true) {
    return positiveDraftInteger(draft.combinedBedrooms);
  }
  return firstBedroomInText(unitSpecificText(draft, unitKey));
}

export type ResolvedDraftBedrooms = {
  unit1: number;
  unit2: number;
  combined: number;
};

export function resolveComboUnitBedrooms(draft: DraftBedroomFields): ResolvedDraftBedrooms {
  const isSingle = draft.singleListing === true;
  const combined = inferCombinedBedroomsFromDraft(draft);

  if (isSingle) {
    const unit1 = inferStoredUnitBedrooms(draft, "unit1") ?? combined ?? 2;
    return { unit1, unit2: 0, combined: combined ?? unit1 };
  }

  let unit1 = inferStoredUnitBedrooms(draft, "unit1");
  let unit2 = inferStoredUnitBedrooms(draft, "unit2");

  if (!unit2 && combined && unit1 && combined > unit1) {
    unit2 = combined - unit1;
  }

  let unitBedrooms = [unit1, unit2].filter((b): b is number => !!b && b > 0);

  if (unitBedrooms.length === 0 && combined) {
    unitBedrooms = combined % 2 === 0
      ? [combined / 2, combined / 2]
      : [Math.ceil(combined / 2), Math.floor(combined / 2)];
  }

  if (unitBedrooms.length === 1 && combined && combined > unitBedrooms[0]) {
    unitBedrooms.push(combined - unitBedrooms[0]);
  }

  if (combined && unitBedrooms.length === 2) {
    const sum = unitBedrooms[0] + unitBedrooms[1];
    if (sum > 0 && sum < combined) {
      if (unitBedrooms[0] === unitBedrooms[1] && combined % 2 === 0) {
        unitBedrooms = [combined / 2, combined / 2];
      } else if (unitBedrooms[0] > 0) {
        unitBedrooms = [unitBedrooms[0], combined - unitBedrooms[0]];
      }
    }
  }

  const u1 = unitBedrooms[0]
    ?? (combined ? (combined % 2 === 0 ? combined / 2 : Math.ceil(combined / 2)) : 2);
  const u2 = unitBedrooms[1] ?? (combined ? Math.max(1, combined - u1) : 2);

  return { unit1: u1, unit2: u2, combined: combined ?? (u1 + u2) };
}

export function resolveDraftUnitBedrooms(
  draft: DraftBedroomFields,
  unitKey: "unit1" | "unit2",
): number {
  const resolved = resolveComboUnitBedrooms(draft);
  return unitKey === "unit1" ? resolved.unit1 : resolved.unit2;
}
