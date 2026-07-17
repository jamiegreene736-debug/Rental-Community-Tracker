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

/**
 * Build the replacement search's durable source exclusion list.
 *
 * Every historical swap for the property matters here, not only the active
 * (latest) swap per unit: an older source may have been replaced precisely
 * because it failed an audit, and proposing it again would make the automatic
 * repair loop cycle. `rejectedUrls` carries candidates burned by the current
 * job (duplicate source, inaccessible gallery, bedroom shortfall, and similar
 * candidate-level failures).
 *
 * URL query/hash variants are the same listing for replacement purposes. The
 * first spelling is preserved for the downstream request while deduplication
 * uses a host+path identity key.
 */
export function collectUnitSwapSkipUrls(
  swaps: Array<{ newSourceUrl?: unknown }>,
  rejectedUrls: unknown[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const value = raw.trim();
    if (!/^https?:\/\//i.test(value)) return;
    let key: string;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      key = `${url.hostname.replace(/^www\./i, "").toLowerCase()}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
    } catch {
      return;
    }
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  for (const swap of swaps) add(swap?.newSourceUrl);
  for (const url of rejectedUrls) add(url);
  return out;
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
