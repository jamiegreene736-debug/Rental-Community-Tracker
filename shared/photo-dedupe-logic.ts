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
    `Group ONLY photos you are confident show the SAME physical subject or scene — e.g. the same pool from two angles, the same palm tree closer and farther, the same bedroom shot from the doorway and from the window, near-identical exterior shots of one building face.`,
    ``,
    `Rules:`,
    `- Only group photos where seeing both adds nothing for a guest.`,
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
  kind: "exact" | "near" | "same-scene";
  reason: string;
  members: DedupeGroupMember[];
};

// Union-find merge of hash pairs + high-confidence vision groups into final
// duplicate groups, keeper pre-picked. Medium-confidence vision groups are
// DISCARDED on purpose — a "maybe" must not pre-select a photo for removal.
export function buildDuplicateGroupsForFolder(
  folder: string,
  entries: DedupePhotoEntry[],
  hashPairs: HashPair[],
  visionGroups: VisionDupeGroup[],
): DedupeGroup[] {
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
  for (const g of visionGroups) {
    if (g.confidence !== "high") continue;
    const valid = g.indexes.filter((i) => i >= 0 && i < entries.length);
    for (let i = 1; i < valid.length; i++) {
      const a = valid[0];
      const b = valid[i];
      const gate = dedupeEdgeAllowed(entries[a], entries[b]);
      if (!gate.allowed) continue;
      union(a, b);
      if (!visionReasonByIndex.has(a)) visionReasonByIndex.set(a, g.reason);
      if (!visionReasonByIndex.has(b)) visionReasonByIndex.set(b, g.reason);
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
  return groups;
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
};

export type PhotoDedupeProposal = {
  scanId: string;
  createdAt: string;
  folders: DedupeFolderResult[];
  groupCount: number;
  removableCount: number;
  visionUsed: boolean;
  warnings: string[];
  note?: string;
};

export function summarizeDedupeFolders(folders: DedupeFolderResult[]): {
  groupCount: number;
  removableCount: number;
  warnings: string[];
} {
  let groupCount = 0;
  let removableCount = 0;
  const warnings: string[] = [];
  for (const f of folders) {
    groupCount += f.groups.length;
    const removable = f.groups.reduce((s, g) => s + g.members.filter((m) => !m.keep).length, 0);
    removableCount += removable;
    const remaining = f.totalVisible - removable;
    if (f.groups.length > 0 && remaining < DEDUPE_MIN_COMFORTABLE_REMAINING) {
      warnings.push(
        `${f.label || f.folder}: removing all ${removable} proposed photos would leave only ${remaining} — consider keeping more.`,
      );
    }
    if (f.visionError) {
      warnings.push(`${f.label || f.folder}: AI same-scene pass unavailable (${f.visionError}) — hash-only results shown.`);
    }
  }
  return { groupCount, removableCount, warnings };
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

  const memberKeys = new Set<string>();
  for (const f of proposal.folders) {
    for (const g of f.groups) {
      for (const m of g.members) memberKeys.add(`${f.folder}/${m.filename}`);
    }
  }
  for (const key of Array.from(selectedKeys)) {
    if (!memberKeys.has(key)) errors.push(`${key} is not part of any duplicate group in this scan — rescan first`);
  }

  for (const f of proposal.folders) {
    let removedInFolder = 0;
    for (const g of f.groups) {
      const removedInGroup = g.members.filter((m) => selectedKeys.has(`${f.folder}/${m.filename}`)).length;
      removedInFolder += removedInGroup;
      if (removedInGroup >= g.members.length) {
        errors.push(`group ${g.id} would lose ALL its photos — keep at least one`);
      }
    }
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
