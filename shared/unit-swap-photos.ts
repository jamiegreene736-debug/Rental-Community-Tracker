export function replacementPhotoFolderForUnit(propertyId: number | string, oldUnitId: string): string {
  const prop = String(propertyId)
    .trim()
    .replace(/^-/, "draft-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const unit = String(oldUnitId)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return `replacement-p${prop || "unknown"}-u${unit || "unit"}`.slice(0, 96);
}

// Latest swap per original unit. storage.getUnitSwaps returns newest-first, so
// the FIRST row seen for an oldUnitId wins — same rule as routes.ts
// latestUnitSwaps; kept pure here so folder-resolution logic is unit-testable.
export function latestUnitSwapsByUnit<T extends { oldUnitId: string }>(swaps: T[]): Map<string, T> {
  const latestByUnit = new Map<string, T>();
  for (const swap of swaps) {
    if (!swap?.oldUnitId || latestByUnit.has(swap.oldUnitId)) continue;
    latestByUnit.set(swap.oldUnitId, swap);
  }
  return latestByUnit;
}

// Stable identity for the latest swap intent on one original unit. Used as an
// optimistic precondition by the auto-replace worker and re-checked inside the
// transaction that inserts a swap, so a newer manual choice always wins.
export function unitSwapSnapshotForUnit(
  swaps: Array<{
    oldUnitId: string;
    id?: unknown;
    createdAt?: Date | string | null;
    committed?: boolean | null;
  }>,
  unitId: string,
): string {
  const latest = latestUnitSwapsByUnit(swaps).get(unitId);
  if (!latest) return "none";
  const createdAt = latest.createdAt instanceof Date
    ? latest.createdAt.toISOString()
    : String(latest.createdAt ?? "");
  return `${String(latest.id ?? "unknown")}:${createdAt}:${latest.committed === true ? "committed" : "pending"}`;
}

export type ActiveUnitPhotoFolder = {
  unitId: string;
  originalFolder: string;
  activeFolder: string;   // replacement folder when the unit was swapped, else the original
  replaced: boolean;
};

// Which photo folder is the ACTIVE one for each unit — the replacement folder
// once the operator swapped the unit (photo-listing scanner, dashboard, and
// the photo-community vision check must all agree on this), otherwise the
// unit's own folder. Mirrors routes.ts activeUnitPhotoFoldersForBuilder.
export function resolveActiveUnitPhotoFolders(
  propertyId: number | string,
  units: Array<{ id: string; photoFolder?: string | null }>,
  swaps: Array<{ oldUnitId: string }>,
): ActiveUnitPhotoFolder[] {
  const latest = latestUnitSwapsByUnit(swaps);
  const out: ActiveUnitPhotoFolder[] = [];
  for (const unit of units) {
    const originalFolder = unit.photoFolder ?? "";
    if (!originalFolder) continue;
    const replaced = latest.has(unit.id);
    out.push({
      unitId: unit.id,
      originalFolder,
      activeFolder: replaced ? replacementPhotoFolderForUnit(propertyId, unit.id) : originalFolder,
      replaced,
    });
  }
  return out;
}
