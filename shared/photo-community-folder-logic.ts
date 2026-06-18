// Full community-folder audit helpers — dHash pre-screen + batch merging.

/** Looser than bedroom clustering: pool vs building at same resort may differ. */
export const COMMUNITY_CLUSTER_DISTANCE = 28;

/** Pairwise distance suggesting unrelated photo sources in one folder. */
export const MIXED_FOLDER_MAX_DISTANCE = 36;

/** Near-duplicate distance — same scrape batch often has similar comps. */
export const MIXED_FOLDER_MIN_NEAR_DISTANCE = 10;

export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x > 0) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length > 0 ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type HashPhoto = { id: string; hash?: string };

/** Single-linkage clustering on hex dHash strings. */
export function clusterPhotosByHash<T extends HashPhoto>(
  items: T[],
  threshold: number = COMMUNITY_CLUSTER_DISTANCE,
): T[][] {
  if (items.length === 0) return [];
  const clusterOf = new Array(items.length).fill(-1);
  let next = 0;
  for (let i = 0; i < items.length; i++) {
    if (clusterOf[i] !== -1) continue;
    clusterOf[i] = next;
    const hi = items[i].hash;
    if (hi) {
      for (let j = i + 1; j < items.length; j++) {
        if (clusterOf[j] !== -1) continue;
        const hj = items[j].hash;
        if (hj && hammingHex(hi, hj) <= threshold) clusterOf[j] = next;
      }
    }
    next++;
  }
  const buckets = new Map<number, T[]>();
  for (let i = 0; i < items.length; i++) {
    const c = clusterOf[i];
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c)!.push(items[i]);
  }
  return Array.from(buckets.values()).sort((a, b) => b.length - a.length);
}

export type MixedFolderScreen = {
  mixed: boolean;
  maxDistance: number;
  minNearDistance: number;
  clusterCount: number;
  reason: string | null;
};

/**
 * Cheap pre-screen: folders scraped from multiple unrelated listings often
 * contain near-duplicate comp photos AND visually unrelated outliers.
 */
export function detectLikelyMixedCommunityFolder(hashes: string[]): MixedFolderScreen {
  const valid = hashes.filter((h) => h && h.length >= 8);
  if (valid.length < 4) {
    return { mixed: false, maxDistance: 0, minNearDistance: 0, clusterCount: valid.length, reason: null };
  }
  let maxDistance = 0;
  let minNearDistance = 64;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const d = hammingHex(valid[i], valid[j]);
      if (d > maxDistance) maxDistance = d;
      if (d > 0 && d < minNearDistance) minNearDistance = d;
    }
  }
  const clusters = clusterPhotosByHash(valid.map((hash, i) => ({ id: String(i), hash })));
  const mixed =
    maxDistance >= MIXED_FOLDER_MAX_DISTANCE
    && minNearDistance <= MIXED_FOLDER_MIN_NEAR_DISTANCE
    && clusters.length >= 2;
  return {
    mixed,
    maxDistance,
    minNearDistance,
    clusterCount: clusters.length,
    reason: mixed
      ? `Folder mixes near-duplicate photos with unrelated images (dHash spread ${maxDistance}).`
      : null,
  };
}

export type PhotoVerdictLike = { id: string; match: "yes" | "no"; reason: string };

export function mergeCommunityPhotoVerdicts(batches: PhotoVerdictLike[][]): PhotoVerdictLike[] {
  const byId = new Map<string, PhotoVerdictLike>();
  for (const batch of batches) {
    for (const v of batch) {
      if (!v.id) continue;
      const prev = byId.get(v.id);
      if (!prev || (prev.match === "yes" && v.match === "no")) byId.set(v.id, v);
    }
  }
  return Array.from(byId.values());
}

export function communityAuditCoverage(checked: number, total: number): {
  complete: boolean;
  label: string;
} {
  const safeChecked = Math.max(0, checked);
  const safeTotal = Math.max(0, total);
  return {
    complete: safeTotal > 0 && safeChecked >= safeTotal,
    label: safeTotal > 0 ? `${safeChecked}/${safeTotal}` : `${safeChecked}`,
  };
}
