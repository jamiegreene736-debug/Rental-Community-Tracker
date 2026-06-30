// Same-bedroom (different-angle) detection — pure logic.
//
// dHash clustering splits two angles of ONE bedroom (e.g. a head-on shot of the
// bed and a second shot of the SAME room's TV/dresser) into separate clusters,
// and the caption merges in photo-bedroom-coverage-logic only fold them when the
// scraped captions happen to agree (both "Master", identical detected bed type,
// etc.). For machine-labeled scrape galleries the captions usually don't agree,
// so the angles survive as two "bedrooms" — inflating the room count and masking
// a genuinely un-photographed bedroom.
//
// A vision model is the reliable signal for "is this the same physical room from
// another angle?". This module holds the pure, deterministic glue around that
// call: which clusters to send, how to parse the model's grouping, and how to
// fold confirmed same-room clusters back together. The vision request itself
// lives in server/bedroom-same-room-vision.ts so this stays unit-testable with no
// network/Buffer dependency.

/** Need at least two clusters before a same-room merge can do anything. */
export function needsSameRoomVision(clusterCount: number): boolean {
  return clusterCount >= 2;
}

/**
 * Parse the vision model's room-grouping JSON into arrays of representative ids.
 *
 * Accepts either `{"rooms":[{"ids":["A","B"]},{"ids":["C"]}]}` or
 * `{"groups":[["A","B"],["C"]]}`. Returns null (caller treats as "no merge")
 * unless the response is a clean PARTITION of exactly the ids we asked about:
 * every id present, each exactly once, no unknown ids. Strictness is the safety
 * rail — a malformed or partial response must never silently collapse rooms.
 */
export function parseSameRoomGroups(text: string, validIds: string[]): string[][] | null {
  const valid = new Set(validIds.map((id) => String(id ?? "").trim()).filter(Boolean));
  if (valid.size === 0) return null;

  const raw = String(text ?? "");
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  let groupsRaw: unknown[];
  if (Array.isArray(parsed.rooms)) {
    groupsRaw = parsed.rooms.map((r: any) => (Array.isArray(r) ? r : r?.ids));
  } else if (Array.isArray(parsed.groups)) {
    groupsRaw = parsed.groups;
  } else {
    return null;
  }

  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const g of groupsRaw) {
    if (!Array.isArray(g)) return null;
    const clean: string[] = [];
    for (const item of g) {
      const id = String(item ?? "").trim();
      if (!id) continue;
      if (!valid.has(id)) return null; // hallucinated id → reject whole response
      if (seen.has(id)) return null; // an id in two rooms is contradictory → reject
      seen.add(id);
      clean.push(id);
    }
    if (clean.length > 0) groups.push(clean);
  }

  // Must be a full partition of the ids we asked about.
  if (seen.size !== valid.size) return null;
  return groups;
}

/**
 * Fold clusters whose representatives the vision model grouped as the same room.
 *
 * `repIds[i]` is the representative id of `clusters[i]`. Clusters whose reps share
 * a group are unioned; the merged cluster keeps the position of its earliest
 * member so room ordering is stable. Returns the input unchanged when the groups
 * don't line up with the clusters (defensive — never throws, never drops a
 * cluster's photos).
 *
 * `minClusters` is the blast-radius floor (defense-in-depth against a vision
 * over-merge). The fold is allowed to take the room count BELOW the expected
 * bedroom count — that is the whole point, it surfaces a genuinely un-photographed
 * bedroom — but only by a believable margin. Callers pass `expectedBedrooms - 1`,
 * so a partition that would imply TWO+ missing bedrooms (far likelier a vision
 * error collapsing two real rooms than a real double-gap) is rejected wholesale
 * and the clusters are returned untouched. With `minClusters` unset there is no
 * floor (union-find can never reach zero from a non-empty input).
 */
export function applySameRoomGroups<T>(
  clusters: T[][],
  repIds: string[],
  groups: string[][],
  minClusters?: number | null,
): { clusters: T[][]; mergedCount: number } {
  if (clusters.length !== repIds.length || clusters.length === 0) {
    return { clusters, mergedCount: 0 };
  }

  const idToIdx = new Map<string, number>();
  repIds.forEach((id, i) => {
    const key = String(id ?? "").trim();
    if (key && !idToIdx.has(key)) idToIdx.set(key, i);
  });

  // Union-find with the smallest index as the canonical root, so the merged
  // cluster inherits the earliest member's position.
  const parent = clusters.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  for (const group of groups) {
    const idxs = group
      .map((id) => idToIdx.get(String(id ?? "").trim()))
      .filter((x): x is number => typeof x === "number");
    for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k]);
  }

  const byRoot = new Map<number, T[]>();
  const order: number[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) {
      byRoot.set(r, []);
      order.push(r);
    }
    byRoot.get(r)!.push(...clusters[i]);
  }
  const out = order.map((r) => byRoot.get(r)!);
  // Blast-radius floor: distrust a partition that collapses the unit below the
  // believable-gap floor (a likely vision over-merge) — leave clusters untouched.
  if (minClusters != null && minClusters > 0 && out.length < minClusters) {
    return { clusters, mergedCount: 0 };
  }
  return { clusters: out, mergedCount: clusters.length - out.length };
}
