// Watchdog thresholds for bulk photo community jobs (server-side queue).

/** Hard cap on a single property's vision check — prevents infinite hangs. */
export const BULK_PHOTO_COMMUNITY_PROPERTY_TIMEOUT_MS = 12 * 60 * 1000;

/** Reclaim a persisted "running" item from a prior worker after this age. */
export const BULK_PHOTO_COMMUNITY_ITEM_RECLAIM_MS = 45 * 1000;

/** Fail a running item when it exceeds this age even within an active worker. */
export const BULK_PHOTO_COMMUNITY_ITEM_STALE_FAIL_MS = 15 * 60 * 1000;

export type BulkItemLike = {
  status: string;
  startedAt?: number;
};

export function shouldFailStaleBulkPhotoCommunityItem(
  item: BulkItemLike,
  now = Date.now(),
): boolean {
  if (item.status !== "running" || item.startedAt == null) return false;
  return now - item.startedAt >= BULK_PHOTO_COMMUNITY_ITEM_STALE_FAIL_MS;
}

/** True when item was left "running" by a prior worker and is old enough to retry. */
export function shouldReclaimBulkPhotoCommunityItem(
  item: BulkItemLike,
  workerSessionStartedAt: number,
  now = Date.now(),
): boolean {
  if (item.status !== "running" || item.startedAt == null) return false;
  // Item was marked running before this worker session began.
  if (item.startedAt >= workerSessionStartedAt - 1000) return false;
  return now - item.startedAt >= BULK_PHOTO_COMMUNITY_ITEM_RECLAIM_MS;
}
