// Pure helpers for deleting an *added* community listing/draft from the system.
//
// The dashboard surfaces a `community_drafts` row (positive DB id N) under the
// NEGATIVE property id -N (see `draftsAsProperties` in client/src/pages/home.tsx
// and the `-draft.id` convention throughout server/routes.ts). "Deleting the
// unit from the system" therefore means cleaning every store keyed by that -N
// property id, by the draft's photo folders, and by the positive draft id.
//
// Only the folder-name derivation and the app_settings JSON pruning are pure, so
// they live here and are unit-tested without a database. The DB cleanup itself
// is in `storage.deleteCommunityDraftDeep`; the orchestration (Guesty gate,
// app_settings prune, on-disk folder removal) is in the DELETE route.

/**
 * The three photo folders a community draft owns on disk / in the photo tables.
 * Matches the canonical naming used by the persist-photos flow and the existing
 * admin cleanup route: `draft-<id>-unit-a`, `draft-<id>-unit-b`,
 * `community-draft-<id>`. Accepts either the positive draft id or the negative
 * dashboard id (it takes the absolute value).
 */
export function communityDraftPhotoFolders(draftId: number): string[] {
  const id = Math.abs(Math.trunc(Number(draftId)));
  return [`draft-${id}-unit-a`, `draft-${id}-unit-b`, `community-draft-${id}`];
}

/**
 * Remove every record whose `propertyId` matches the deleted property from an
 * app_settings JSON document (unit_audit_sweeps.v1 / unit_audit_reports.v1 —
 * both are keyed by jobId with `propertyId` on each record). Returns a NEW map
 * plus the number of records removed; never mutates the input. `propertyId`
 * here is the dashboard id (negative -draftId for drafts).
 */
export function pruneRecordsByPropertyId<T extends { propertyId?: number }>(
  records: Record<string, T>,
  propertyId: number,
): { records: Record<string, T>; removed: number } {
  const out: Record<string, T> = {};
  let removed = 0;
  for (const [key, value] of Object.entries(records ?? {})) {
    if (value && Number((value as { propertyId?: number }).propertyId) === propertyId) {
      removed += 1;
      continue;
    }
    out[key] = value;
  }
  return { records: out, removed };
}
