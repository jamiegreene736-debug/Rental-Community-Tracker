import { isVirtualStagingCandidateFilename } from "@shared/virtual-staging";

export type PhotoLabelMergePlan<TId extends string | number> = {
  obsoleteIds: TId[];
  unlabeledLiveIds: TId[];
};

/**
 * Classify destination rows before a staged gallery is promoted.
 *
 * Virtual-staging rows are durable assets outside the scrape-owned gallery.
 * Live scrape filenames retain their human override row even when no labeler
 * ran, while rows for photos no longer present are removed.
 */
export function planPhotoLabelMerge<TId extends string | number>(
  destinationRows: readonly { id: TId; filename: string }[],
  stagedFilenames: ReadonlySet<string>,
  liveFilenames: readonly string[],
): PhotoLabelMergePlan<TId> {
  const liveFilenameSet = new Set(liveFilenames);
  const obsoleteIds: TId[] = [];
  const unlabeledLiveIds: TId[] = [];

  for (const row of destinationRows) {
    if (isVirtualStagingCandidateFilename(row.filename)) continue;
    if (!liveFilenameSet.has(row.filename)) {
      obsoleteIds.push(row.id);
    } else if (!stagedFilenames.has(row.filename)) {
      unlabeledLiveIds.push(row.id);
    }
  }

  return { obsoleteIds, unlabeledLiveIds };
}
