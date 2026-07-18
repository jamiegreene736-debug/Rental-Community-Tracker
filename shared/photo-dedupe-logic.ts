// Pure decision logic for the Photos-tab "Scan for duplicate photos" feature.
//
// The scan finds REDUNDANT photos inside each gallery folder (a unit folder or
// the community folder) from two independent signals:
//
//   1. dHash near-duplicate pairs (deterministic, keyless) — the same image
//      recompressed / resized / lightly cropped, or a burst shot.
//   2. Claude-vision "same scene, different angle" groups (fail-soft) — the
//      "same tree from another angle" class a 64-bit hash cannot catch.
//
// This module owns everything decidable without IO: clustering, the guards
// that keep a vision over-merge from proposing a REAL photo for removal, the
// deterministic keeper pick, and the apply-time selection validation the
// server re-runs before hiding anything. server/photo-dedupe.ts owns disk +
// vision IO.
//
// SAFETY MODEL (load-bearing — see AGENTS.md "Photos-tab duplicate scan"):
//   - The scan only ever PROPOSES. Removal happens in a second, operator-
//     confirmed apply call, validated against the stored proposal.
//   - Removal = the existing photo_labels.hidden soft-delete (excluded from
//     the tab, counts, and Guesty pushes) — files are NEVER unlinked, so an
//     "Undo" restores everything.
//   - Every duplicate group always keeps at least one photo (server-enforced).
//   - Grouping is WITHIN-FOLDER only. Cross-folder duplicates are the
//     photo-community-check's mixed-up-folders signal, not a dedupe target.

import { DUPLICATE_DISTANCE, hammingDistance } from "./photo-hash-distance";

// Hash distance that clusters two photos as near-identical WITHOUT vision.
// DUPLICATE_DISTANCE (5) = "same image up to recompression/light crop"; 6-10
// catches burst shots / trivial re-crops while staying far below the 25-36
// band where same-view LOOK-ALIKES live (see shared/photo-hash-distance.ts).
export const NEAR_DUPLICATE_DISTANCE = 10;

// Below this many remaining VISIBLE photos in a folder the apply response
// carries a warning (the scrape floor MIN_INDEPENDENT_UNIT_PHOTOS is 3).
// Deliberately a warning, not a block — the manual per-tile ✕ delete has no
// floor either, and the operator is reviewing the selection anyway. The only
// hard blocks are "never remove every member of a group" and "never empty a
// folder".
export const DEDUPE_MIN_COMFORTABLE_REMAINING = 3;

export type DedupePhotoEntry = {
  folder: string;
  filename: string;
  /** Effective caption (user override wins). */
  caption?: string | null;
  /** Effective category (user override wins), e.g. "Bedrooms" / "Kitchen". */
  category?: string | null;
  /** Bedroom cluster id from the bedroom-coverage engine, when labeled. */
  bedroomClusterId?: string | null;
  /** 16-hex-char dHash; null/undefined when uncomputable. */
  hash?: string | null;
  /** File size in bytes (keeper tie-break: bigger = likely higher-res). */
  byteSize?: number | null;
  /** Position in the rendered gallery order (what the operator sees/pushes). */
  galleryIndex: number;
  /** True when a human set userLabel/userCategory — never a default removal. */
  humanTouched?: boolean;
  /** photo_labels.sort_order when the operator manually ordered the gallery. */
  manualSortOrder?: number | null;
};

export type HashPair = { a: number; b: number; distance: number };

// Pairwise near-duplicate hash edges within one folder's entries.
export function clusterHashPairs(
  entries: Array<Pick<DedupePhotoEntry, "hash">>,
  threshold: number = NEAR_DUPLICATE_DISTANCE,
): HashPair[] {
  const pairs: HashPair[] = [];
  for (let i = 0; i < entries.length; i++) {
    const ha = entries[i]?.hash;
    if (!ha) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const hb = entries[j]?.hash;
      if (!hb) continue;
      const distance = hammingDistance(ha, hb);
      if (distance <= threshold) pairs.push({ a: i, b: j, distance });
    }
  }
  return pairs;
}

export type VisionDupeGroup = {
  /** Entry indexes within the folder's entry array. */
  indexes: number[];
  reason: string;
  confidence: "high" | "medium";
};

export type CompleteVisionBatchPlan = {
  /** Index sets for Claude calls. Every pair co-occurs in at least one set. */
  batches: number[][];
  complete: boolean;
  error: string | null;
  /**
   * Photo indexes the plan shows to Claude at least once. Pair coverage
   * (`complete`) and PHOTO coverage are different guarantees: a chunked plan
   * shows every photo but not every pair. Callers report both honestly.
   */
  covered?: number[];
};

/**
 * Build a bounded set of Claude calls that compares every photo pair.
 *
 * A plain sequence of disjoint batches is not complete: photo 10 could be an
 * alternate angle of photo 70 and the model would never see them together.
 * Splitting into half-cap chunks and pairing every two chunks guarantees that
 * every pair co-occurs in at least one call, including pairs within a chunk.
 * If that guarantee would exceed the configured call budget, callers get an
 * explicit incomplete plan and must not claim the gallery is clean.
 */
export function buildCompleteVisionBatchPlan(
  photoCount: number,
  photoCap: number,
  maxBatches: number,
): CompleteVisionBatchPlan {
  const count = Number.isFinite(photoCount) ? Math.max(0, Math.floor(photoCount)) : 0;
  const cap = Math.floor(photoCap);
  const budget = Number.isFinite(maxBatches) ? Math.max(0, Math.floor(maxBatches)) : 0;
  if (count < 2) return { batches: [], complete: true, error: null };
  if (!Number.isFinite(cap) || cap < 2) {
    return { batches: [], complete: false, error: `vision photo cap ${String(photoCap)} is below 2` };
  }
  if (count <= cap) {
    if (budget < 1) return { batches: [], complete: false, error: "vision batch budget is 0" };
    return { batches: [Array.from({ length: count }, (_, i) => i)], complete: true, error: null };
  }

  const chunkSize = Math.floor(cap / 2);
  const chunks: number[][] = [];
  for (let start = 0; start < count; start += chunkSize) {
    chunks.push(Array.from({ length: Math.min(chunkSize, count - start) }, (_, i) => start + i));
  }
  const needed = (chunks.length * (chunks.length - 1)) / 2;
  if (needed > budget) {
    return {
      batches: [],
      complete: false,
      error: `${count} photos require ${needed} exhaustive Claude batches (limit ${budget})`,
    };
  }

  const batches: number[][] = [];
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      batches.push([...chunks[i], ...chunks[j]]);
    }
  }
  return { batches, complete: true, error: null };
}

/**
 * Plan the MANUAL Photos-tab scan's vision calls.
 *
 * The old manual plan was a single evenly-strided SAMPLE capped at
 * `photoCap`, so a 150-photo folder showed Claude 60 photos and never looked
 * at the other 90 at all — while the UI still reported a clean gallery. Since
 * the alternate-angle pass is the ONLY signal that catches "the same tree from
 * another angle" (dHash cannot — those sit far above NEAR_DUPLICATE_DISTANCE),
 * dropping 60% of the gallery silently is exactly the miss the operator hits.
 *
 * Three tiers, best coverage that fits the budget:
 *   1. `count <= photoCap`         → one call, every pair compared (complete).
 *   2. exhaustive pair-cover fits  → `buildCompleteVisionBatchPlan` (complete).
 *   3. otherwise                   → DISJOINT chunks covering EVERY photo once
 *                                    (`ceil(count / photoCap)` calls). Not
 *                                    every pair, but every photo is seen, and
 *                                    same-scene repeats are overwhelmingly
 *                                    ADJACENT in scraped gallery order — so
 *                                    this recovers most of what tier 2 would
 *                                    find at a fraction of the spend.
 *
 * Tier 3 returns `complete: false` ON PURPOSE. It is never an error — callers
 * must report it as partial pair coverage rather than suppressing the result.
 */
export function buildManualVisionBatchPlan(
  photoCount: number,
  photoCap: number,
  maxBatches: number,
): CompleteVisionBatchPlan {
  const count = Number.isFinite(photoCount) ? Math.max(0, Math.floor(photoCount)) : 0;
  const cap = Math.floor(photoCap);
  const budget = Number.isFinite(maxBatches) ? Math.max(0, Math.floor(maxBatches)) : 0;
  const all = (n: number) => Array.from({ length: n }, (_, i) => i);

  // Nothing to compare, and no batch is sent — `covered` must not claim a photo
  // was shown to Claude when no call carries it.
  if (count < 2) return { batches: [], complete: true, error: null, covered: [] };
  if (!Number.isFinite(cap) || cap < 2) {
    return { batches: [], complete: false, error: `vision photo cap ${String(photoCap)} is below 2`, covered: [] };
  }
  if (budget < 1) return { batches: [], complete: false, error: "vision batch budget is 0", covered: [] };

  // Tier 1 — the whole folder fits one call.
  if (count <= cap) return { batches: [all(count)], complete: true, error: null, covered: all(count) };

  // Tier 2 — exhaustive pair cover, when it fits the budget.
  const exhaustive = buildCompleteVisionBatchPlan(count, cap, budget);
  if (exhaustive.complete && exhaustive.batches.length > 0) {
    return { ...exhaustive, covered: all(count) };
  }

  // Tier 3 — disjoint chunks: every photo seen once, bounded by the budget.
  const batches: number[][] = [];
  for (let start = 0; start < count && batches.length < budget; start += cap) {
    batches.push(Array.from({ length: Math.min(cap, count - start) }, (_, i) => start + i));
  }
  // A trailing chunk of one photo can't be compared against anything. Replace
  // it with the LAST `cap` photos (a window that overlaps the previous chunk)
  // rather than appending the orphan — appending would push that batch to
  // cap + 1 and break the per-call cap the caller asked for.
  if (batches.length > 1 && batches[batches.length - 1].length < 2) {
    const windowSize = Math.min(cap, count);
    batches[batches.length - 1] = Array.from({ length: windowSize }, (_, i) => count - windowSize + i);
  }
  return {
    batches,
    complete: false,
    error: null,
    covered: Array.from(new Set(batches.flat())).sort((a, b) => a - b),
  };
}

// Parse the vision response. `ids` in the response are "p<N>" markers (1-based
// over the photos the server actually sent); `idToIndex` maps them back to
// entry indexes. Anything malformed is dropped — a parse gap must never turn
// into a removal proposal.
export function parseDedupeVisionGroups(
  parsed: unknown,
  idToIndex: Map<string, number>,
): VisionDupeGroup[] {
  const root = parsed as { groups?: unknown } | null;
  if (!root || !Array.isArray(root.groups)) return [];
  const out: VisionDupeGroup[] = [];
  for (const raw of root.groups) {
    const g = raw as { photos?: unknown; reason?: unknown; confidence?: unknown };
    if (!g || !Array.isArray(g.photos)) continue;
    const indexes: number[] = [];
    for (const p of g.photos) {
      const idx = idToIndex.get(String(p).trim().toLowerCase());
      if (idx !== undefined && !indexes.includes(idx)) indexes.push(idx);
    }
    if (indexes.length < 2) continue;
    const confidence = String(g.confidence ?? "").toLowerCase() === "high" ? "high" : "medium";
    out.push({
      indexes: indexes.sort((a, b) => a - b),
      reason: typeof g.reason === "string" && g.reason.trim() ? g.reason.trim().slice(0, 300) : "same scene from multiple angles",
      confidence,
    });
  }
  return out;
}

// The conservative grouping instruction for the vision call. The server
// inlines each photo preceded by a "--- photo p<N> ---" marker.
export function buildDedupeVisionInstruction(folderLabel: string, photoCount: number): string {
  return [
    `You are reviewing ${photoCount} vacation-rental listing photos from ONE gallery ("${folderLabel}") to find REDUNDANT shots a guest gains nothing from seeing twice.`,
    ``,
    `The specific problem to find: scraped galleries often carry TOO MANY ANGLES OF THE SAME SHOT — the same tree, the same pool, the same view, the same room photographed repeatedly from slightly different positions. Those repeats are what you are looking for.`,
    ``,
    `Group ONLY photos you are confident show the SAME physical subject or scene — e.g. the same pool from two angles, the same palm tree closer and farther, the same bedroom shot from the doorway and from the window, near-identical exterior shots of one building face.`,
    ``,
    `Rules:`,
    `- Only group photos where seeing both adds nothing for a guest.`,
    `- Any caption shown with a photo is MACHINE-GENERATED and may be wrong or inconsistent. Judge from the images themselves; two different captions are NOT proof of two different rooms, and two matching captions are NOT proof of one room.`,
    `- NEVER group photos of DIFFERENT rooms, even when they look similar. Two bedrooms with the same bedspread are different rooms — do not group.`,
    `- NEVER group different amenities (two different pools, two different lawns, two different buildings).`,
    `- A wide shot plus a close-up of the same room: group ONLY if the close-up shows nothing new. A detail shot of a distinct feature is NOT redundant.`,
    `- When unsure, DO NOT group. Missing a duplicate is fine; a wrong group would delete a real photo.`,
    ``,
    `Respond with ONLY JSON, no prose:`,
    `{"groups":[{"photos":["p3","p7"],"reason":"same pool area from two angles","confidence":"high"}]}`,
    `Use confidence "high" only when certain the shots are redundant; "medium" otherwise. An empty groups array is a valid answer.`,
  ].join("\n");
}

// ── Merge guards ─────────────────────────────────────────────────────────────

function normCategory(c: string | null | undefined): string {
  return String(c ?? "").trim().toLowerCase();
}

// A vision edge between two photos whose effective CATEGORIES disagree is
// suspicious (the model grouped a kitchen with a lanai) — dropped unless the
// hashes independently say "same image" (a mislabeled exact dupe).
export function dedupeEdgeAllowed(
  a: DedupePhotoEntry,
  b: DedupePhotoEntry,
): { allowed: boolean; why?: string } {
  const exactDupe = !!a.hash && !!b.hash && hammingDistance(a.hash, b.hash) <= DUPLICATE_DISTANCE;
  if (exactDupe) return { allowed: true };
  const ca = normCategory(a.category);
  const cb = normCategory(b.category);
  if (ca && cb && ca !== cb) {
    return { allowed: false, why: `categories differ (${ca} vs ${cb})` };
  }
  // Two photos the bedroom-coverage engine assigned to DIFFERENT physical
  // bedrooms must never be folded — that would remove a whole room's coverage.
  const ba = a.bedroomClusterId ?? null;
  const bb = b.bedroomClusterId ?? null;
  if (ba != null && bb != null && String(ba) !== String(bb)) {
    return { allowed: false, why: "different bedroom clusters" };
  }
  return { allowed: true };
}

export type DedupeGroupMember = {
  filename: string;
  caption: string | null;
  category: string | null;
  /** True = default keeper; false = proposed-removable extra. */
  keep: boolean;
  humanTouched: boolean;
};

export type DedupeGroup = {
  id: string;
  folder: string;
  /**
   * "review" is the OPERATOR-REVIEW tier (2026-07-18): possible repeat angles
   * the engine deliberately refuses to propose for removal. Review groups live
   * on `DedupeFolderResult.reviewGroups`, NEVER on `.groups` — see the
   * load-bearing note on that field.
   */
  kind: "exact" | "near" | "same-scene" | "review";
  reason: string;
  members: DedupeGroupMember[];
};

export type DedupeGroupSets = {
  /** Confirmed duplicate groups — keeper pre-picked, extras pre-selected. */
  groups: DedupeGroup[];
  /** Possible repeats surfaced for the operator's eyes only (nothing pre-selected). */
  reviewGroups: DedupeGroup[];
};

// Union-find merge of hash pairs + high-confidence vision groups into final
// duplicate groups, keeper pre-picked.
//
// A "maybe" must still never PRE-SELECT a photo for removal — but before
// 2026-07-18 a maybe was thrown away entirely, so the operator never learned
// it existed. Two suppression paths were silently eating the exact
// "too many angles of the same shot" class the scan is meant to catch:
//   - medium-confidence vision groups were dropped with no trace, on top of a
//     prompt that already says "when unsure, DO NOT group" (double-conservative);
//   - a high-confidence edge refused by `dedupeEdgeAllowed` (categories or
//     bedroom clusters disagree) vanished — and an angle variant can NEVER be
//     rescued by the exact-hash bypass, because two angles of one scene are far
//     apart in hash space by construction.
// Both now surface as REVIEW groups: reported, never pre-selected, never
// auto-fixable. The removal safety model is unchanged.
export function buildDuplicateGroupsForFolder(
  folder: string,
  entries: DedupePhotoEntry[],
  hashPairs: HashPair[],
  visionGroups: VisionDupeGroup[],
): DedupeGroupSets {
  const parent = entries.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const exactEdge = new Set<string>();
  for (const p of hashPairs) {
    if (p.a < 0 || p.b < 0 || p.a >= entries.length || p.b >= entries.length) continue;
    union(p.a, p.b);
    if (p.distance <= DUPLICATE_DISTANCE) exactEdge.add(`${Math.min(p.a, p.b)}|${Math.max(p.a, p.b)}`);
  }

  // Track vision participation per ENTRY (not per union-find root — a later
  // union can re-root a cluster and orphan a root-keyed reason).
  const visionReasonByIndex = new Map<number, string>();
  // Candidate review clusters: [member indexes, human-readable reason].
  const reviewCandidates: Array<{ indexes: number[]; reason: string }> = [];

  // ── Cluster-level merge guards ────────────────────────────────────────────
  // LOAD-BEARING: gating each PAIR is not enough, because union-find is
  // transitive. A photo carrying no bedroom cluster is edge-allowed against
  // BOTH bedroom 1 and bedroom 2, so unioning those two allowed pairs silently
  // re-merges the very pair the guard refused — and the blocked-edge review
  // path below then sees them already merged and stays quiet. The result was a
  // confirmed group with a second bedroom's only photo pre-selected for
  // removal, which the weekly sweep would auto-hide. So the guards are enforced
  // over the whole CLUSTER a union would produce, not just its two endpoints.
  const rootClusters = new Map<number, Set<string>>();
  const rootCategories = new Map<number, Set<string>>();
  const addTo = (map: Map<number, Set<string>>, root: number, value: string) => {
    if (!value) return;
    const set = map.get(root) ?? new Set<string>();
    set.add(value);
    map.set(root, set);
  };
  // Seed from the post-hash state: an exact-hash union may legitimately have
  // already bridged categories (the documented mislabeled-copy bypass).
  for (let i = 0; i < entries.length; i++) {
    const r = find(i);
    const bc = entries[i].bedroomClusterId;
    if (bc != null) addTo(rootClusters, r, String(bc));
    addTo(rootCategories, r, normCategory(entries[i].category));
  }
  const mergedSize = (map: Map<number, Set<string>>, ra: number, rb: number): number => {
    const merged = new Set<string>(map.get(ra) ?? []);
    for (const v of Array.from(map.get(rb) ?? [])) merged.add(v);
    return merged.size;
  };
  /** Union a,b only if the resulting cluster stays guard-consistent. */
  const unionRespectingClusters = (a: number, b: number): { ok: boolean; why?: string } => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return { ok: true };
    if (mergedSize(rootClusters, ra, rb) > 1) {
      return { ok: false, why: "it would merge two different bedrooms" };
    }
    const exactDupe = !!entries[a].hash && !!entries[b].hash
      && hammingDistance(entries[a].hash!, entries[b].hash!) <= DUPLICATE_DISTANCE;
    if (!exactDupe && mergedSize(rootCategories, ra, rb) > 1) {
      return { ok: false, why: "it would merge photos filed under different categories" };
    }
    const clusters = new Set<string>([...Array.from(rootClusters.get(ra) ?? []), ...Array.from(rootClusters.get(rb) ?? [])]);
    const categories = new Set<string>([...Array.from(rootCategories.get(ra) ?? []), ...Array.from(rootCategories.get(rb) ?? [])]);
    union(a, b);
    const root = find(a);
    rootClusters.set(root, clusters);
    rootCategories.set(root, categories);
    return { ok: true };
  };

  for (const g of visionGroups) {
    const valid = g.indexes.filter((i) => i >= 0 && i < entries.length);
    if (valid.length < 2) continue;

    // Medium confidence: never unioned, but no longer invisible.
    if (g.confidence !== "high") {
      reviewCandidates.push({ indexes: valid, reason: `${g.reason} (AI was not certain)` });
      continue;
    }

    // ALL PAIRS, each gated independently. The old code only tested
    // valid[0]↔valid[i], so one blocked first edge discarded every other pair
    // in the group — a 3-shot repeat where the first photo happened to carry a
    // different machine category lost the other two as well. Union-find already
    // gives transitivity, so a partially-gated group now degrades to its
    // allowed sub-clusters instead of collapsing to nothing.
    const blocked: Array<{ a: number; b: number; why: string }> = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const a = valid[i];
        const b = valid[j];
        const gate = dedupeEdgeAllowed(entries[a], entries[b]);
        if (!gate.allowed) {
          blocked.push({ a, b, why: gate.why ?? "guarded" });
          continue;
        }
        // Allowed as a PAIR, but still refused if it would produce a cluster
        // that mixes two bedrooms/categories via an unlabeled bridge photo.
        const merge = unionRespectingClusters(a, b);
        if (!merge.ok) {
          blocked.push({ a, b, why: merge.why ?? "guarded" });
          continue;
        }
        if (!visionReasonByIndex.has(a)) visionReasonByIndex.set(a, g.reason);
        if (!visionReasonByIndex.has(b)) visionReasonByIndex.set(b, g.reason);
      }
    }
    // Surface guarded edges that did NOT end up merged anyway (a pair can be
    // blocked directly yet still land in one cluster transitively — that is a
    // real merge, not a review item).
    for (const e of blocked) {
      if (find(e.a) === find(e.b)) continue;
      reviewCandidates.push({
        indexes: [e.a, e.b],
        reason: `${g.reason} — held back for your review because ${e.why}`,
      });
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const r = find(i);
    const list = byRoot.get(r) ?? [];
    list.push(i);
    byRoot.set(r, list);
  }

  const groups: DedupeGroup[] = [];
  let seq = 0;
  for (const members of Array.from(byRoot.values())) {
    if (members.length < 2) continue;
    members.sort((a, b) => entries[a].galleryIndex - entries[b].galleryIndex);

    // Kind: exact when every member pair is a same-image edge; same-scene when
    // a vision edge participated; near otherwise (hash-only, looser distance).
    let allExact = true;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = `${Math.min(members[i], members[j])}|${Math.max(members[i], members[j])}`;
        if (!exactEdge.has(key)) allExact = false;
      }
    }
    const visionReason = members.map((i) => visionReasonByIndex.get(i)).find((r) => !!r);
    const anyVision = visionReason !== undefined;
    const kind: DedupeGroup["kind"] = anyVision ? "same-scene" : allExact ? "exact" : "near";

    const keeperIdx = pickKeeperIndex(members.map((i) => entries[i]));
    groups.push({
      id: `${folder}#${seq++}`,
      folder,
      kind,
      reason: anyVision
        ? (visionReason ?? "same scene from multiple angles")
        : allExact ? "near-identical images (perceptual hash)" : "visually near-duplicate images (perceptual hash)",
      members: members.map((i, pos) => ({
        filename: entries[i].filename,
        caption: entries[i].caption ?? null,
        category: entries[i].category ?? null,
        keep: pos === keeperIdx,
        humanTouched: !!entries[i].humanTouched,
      })),
    });
  }
  groups.sort((a, b) => a.id.localeCompare(b.id));

  // ── Review tier ───────────────────────────────────────────────────────────
  // A candidate is dropped only when it tells the operator nothing new: every
  // one of its photos already sits together inside a single CONFIRMED group,
  // where it is already actionable. A candidate that merely OVERLAPS a
  // confirmed group is kept — e.g. a third shot the category guard held back
  // from an already-merged pair is exactly the repeat we want surfaced.
  // (validateDedupeSelection counts distinct filenames per folder, so a photo
  // appearing in both tiers cannot double-count against the folder's total.)
  const confirmedSets = groups.map((g) => new Set(g.members.map((m) => m.filename)));

  const reviewGroups: DedupeGroup[] = [];
  const seenMemberSets = new Set<string>();
  let reviewSeq = 0;
  for (const cand of reviewCandidates) {
    const members = Array.from(new Set(cand.indexes))
      .filter((i) => i >= 0 && i < entries.length)
      .sort((a, b) => entries[a].galleryIndex - entries[b].galleryIndex);
    if (members.length < 2) continue;
    const names = members.map((i) => entries[i].filename);
    if (confirmedSets.some((set) => names.every((n) => set.has(n)))) continue;
    const key = members.map((i) => entries[i].filename).join("|");
    if (seenMemberSets.has(key)) continue;
    seenMemberSets.add(key);
    reviewGroups.push({
      id: `${folder}#review${reviewSeq++}`,
      folder,
      kind: "review",
      reason: cand.reason,
      // EVERY member keeps. Nothing here is pre-selected for removal, and the
      // sweep's auto-fix can never act on it (see dedupeAutoFixSelections).
      members: members.map((i) => ({
        filename: entries[i].filename,
        caption: entries[i].caption ?? null,
        category: entries[i].category ?? null,
        keep: true,
        humanTouched: !!entries[i].humanTouched,
      })),
    });
  }
  reviewGroups.sort((a, b) => a.id.localeCompare(b.id));

  return { groups, reviewGroups };
}

// Deterministic keeper pick within one group (members already in gallery
// order). Priority: human-touched photo (operator captioned/categorized it) →
// explicit manual sort order (lower = more prominent) → earlier gallery
// position; larger file wins a tie (likely the higher-res copy).
export function pickKeeperIndex(members: DedupePhotoEntry[]): number {
  let best = 0;
  for (let i = 1; i < members.length; i++) {
    const a = members[best];
    const b = members[i];
    const touchedA = a.humanTouched ? 1 : 0;
    const touchedB = b.humanTouched ? 1 : 0;
    if (touchedB !== touchedA) { if (touchedB > touchedA) best = i; continue; }
    const soA = a.manualSortOrder ?? Number.POSITIVE_INFINITY;
    const soB = b.manualSortOrder ?? Number.POSITIVE_INFINITY;
    if (soA !== soB) { if (soB < soA) best = i; continue; }
    if (a.galleryIndex !== b.galleryIndex) { if (b.galleryIndex < a.galleryIndex) best = i; continue; }
    if ((b.byteSize ?? 0) > (a.byteSize ?? 0)) best = i;
  }
  return best;
}

// ── Proposal + apply validation ──────────────────────────────────────────────

export type DedupeFolderResult = {
  folder: string;
  label: string;
  totalVisible: number;
  /** Photos readable and eligible for the Claude vision pass. */
  visionEligible: number;
  scannedForVision: number;
  /** Successful Claude calls used for this folder. */
  visionBatchCount: number;
  visionUsed: boolean;
  /** True only when every visible photo was readable and pair-covered. */
  visionComplete: boolean;
  visionError: string | null;
  groups: DedupeGroup[];
  /**
   * LOAD-BEARING: possible repeats for operator review, kept OUT of `groups`.
   * The unit-audit sweep treats `folders[].groups` being empty as "gallery is
   * clean" (server/unit-audit-sweep.ts) — putting review candidates there would
   * make every weekly sweep flag properties over findings it can never act on.
   * The operator may still select these in the Photos tab; the apply validator
   * accepts them explicitly.
   */
  reviewGroups: DedupeGroup[];
};

export type PhotoDedupeProposal = {
  scanId: string;
  createdAt: string;
  folders: DedupeFolderResult[];
  groupCount: number;
  removableCount: number;
  /** Possible-repeat groups surfaced for review; never counted as duplicates. */
  reviewGroupCount: number;
  visionUsed: boolean;
  warnings: string[];
  note?: string;
};

export function summarizeDedupeFolders(folders: DedupeFolderResult[]): {
  groupCount: number;
  removableCount: number;
  reviewGroupCount: number;
  warnings: string[];
} {
  let groupCount = 0;
  let removableCount = 0;
  let reviewGroupCount = 0;
  const warnings: string[] = [];
  for (const f of folders) {
    groupCount += f.groups.length;
    reviewGroupCount += (f.reviewGroups ?? []).length;
    const removable = f.groups.reduce((s, g) => s + g.members.filter((m) => !m.keep).length, 0);
    removableCount += removable;
    const remaining = f.totalVisible - removable;
    if (f.groups.length > 0 && remaining < DEDUPE_MIN_COMFORTABLE_REMAINING) {
      warnings.push(
        `${f.label || f.folder}: removing all ${removable} proposed photos would leave only ${remaining} — consider keeping more.`,
      );
    }
    if (f.visionError) {
      // A pass that ran some batches then failed is NOT "hash-only" — AI groups
      // from the completed batches are on screen, so saying otherwise
      // contradicts what the operator is looking at.
      warnings.push(
        f.visionBatchCount > 0
          ? `${f.label || f.folder}: the AI alternate-angle pass stopped early after ${f.visionBatchCount} pass${f.visionBatchCount === 1 ? "" : "es"} (${f.visionError}) — partial AI results shown.`
          : `${f.label || f.folder}: AI same-scene pass unavailable (${f.visionError}) — hash-only results shown.`,
      );
    }
    if (!f.visionError && f.totalVisible >= 2 && !f.visionComplete) {
      // HONESTY (2026-07-18): the engine has always computed visionComplete,
      // but nothing consumed it on the manual path, so a partially-covered
      // gallery reported exactly like a fully-covered one. Split the claim by
      // signal — the hash pass genuinely covers every photo; only the
      // alternate-angle pass can come up short.
      const seen = Math.min(f.scannedForVision, f.totalVisible);
      warnings.push(
        seen < f.totalVisible
          ? `${f.label || f.folder}: the AI alternate-angle pass covered ${seen} of ${f.totalVisible} photos — near-identical copies were checked across all of them, but repeat angles among the other ${f.totalVisible - seen} were not.`
          : `${f.label || f.folder}: all ${f.totalVisible} photos were seen by the AI alternate-angle pass, but not every pair was compared directly — a repeat angle between distant photos could remain.`,
      );
    }
  }
  return { groupCount, removableCount, reviewGroupCount, warnings };
}

export type DedupeSelection = { folder: string; filename: string };

export type DedupeSelectionVerdict = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** folder → visible photos left after the removal (per the proposal counts). */
  remainingByFolder: Record<string, number>;
};

// Apply-time validation, re-run SERVER-SIDE against the stored proposal so a
// buggy/hand-crafted client request can never (a) remove a photo the scan
// didn't propose as part of a duplicate group, (b) remove EVERY member of a
// group, or (c) empty a folder.
export function validateDedupeSelection(
  proposal: Pick<PhotoDedupeProposal, "folders">,
  selections: DedupeSelection[],
): DedupeSelectionVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const remainingByFolder: Record<string, number> = {};

  const selectedKeys = new Set<string>();
  for (const s of selections) {
    const key = `${s.folder}/${s.filename}`;
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
  }
  if (selectedKeys.size === 0) {
    return { ok: false, errors: ["nothing selected"], warnings, remainingByFolder };
  }

  // Review groups are selectable too — they are surfaced precisely so the
  // operator can act on them — so they must be in the allowed member set or a
  // legitimate confirm would be rejected as "not part of any duplicate group".
  // Every other guard below (keep-one-per-group, never empty a folder) applies
  // to them identically. NOTE: a filename CAN legitimately appear in both a
  // confirmed and a review group — a candidate is dropped only when ALL of its
  // filenames sit together inside one confirmed group, so a third shot held
  // back from an already-merged pair still surfaces. That is exactly why
  // removedInFolder counts DISTINCT filenames below: summing per group would
  // double-count such a photo and could wrongly report the folder as emptied.
  const groupsOf = (f: { groups?: DedupeGroup[]; reviewGroups?: DedupeGroup[] }): DedupeGroup[] =>
    [...(f.groups ?? []), ...(f.reviewGroups ?? [])];

  const memberKeys = new Set<string>();
  for (const f of proposal.folders) {
    for (const g of groupsOf(f)) {
      for (const m of g.members) memberKeys.add(`${f.folder}/${m.filename}`);
    }
  }
  for (const key of Array.from(selectedKeys)) {
    if (!memberKeys.has(key)) errors.push(`${key} is not part of any duplicate group in this scan — rescan first`);
  }

  for (const f of proposal.folders) {
    // Count DISTINCT selected photos, not per-group hits. One photo can legitimately
    // appear in a confirmed group and in a review group (e.g. a third shot the
    // category guard held back from an already-merged pair); summing per group
    // would count it twice and could wrongly report the folder as emptied.
    const removedFilenames = new Set<string>();
    for (const g of groupsOf(f)) {
      const removedInGroup = g.members.filter((m) => selectedKeys.has(`${f.folder}/${m.filename}`));
      for (const m of removedInGroup) removedFilenames.add(m.filename);
      if (removedInGroup.length >= g.members.length) {
        errors.push(`group ${g.id} would lose ALL its photos — keep at least one`);
      }
    }
    const removedInFolder = removedFilenames.size;
    const remaining = f.totalVisible - removedInFolder;
    remainingByFolder[f.folder] = remaining;
    if (removedInFolder > 0 && remaining <= 0) {
      errors.push(`${f.label || f.folder} would be left with no visible photos`);
    } else if (removedInFolder > 0 && remaining < DEDUPE_MIN_COMFORTABLE_REMAINING) {
      warnings.push(`${f.label || f.folder} will be left with only ${remaining} visible photo${remaining === 1 ? "" : "s"}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, remainingByFolder };
}
