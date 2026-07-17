// Photos-tab "Scan for duplicate photos" engine — disk + vision IO.
//
// The scan is TWO-PHASE by design (see AGENTS.md "Photos-tab duplicate scan"):
//   POST /api/builder/photo-dedupe-scan   → returns a PROPOSAL (nothing changes)
//   POST /api/builder/photo-dedupe-apply  → operator-confirmed; validated
//                                           against the STORED proposal, then
//                                           hides (photo_labels.hidden) the
//                                           selected extras. Files are NEVER
//                                           unlinked — undo restores them.
//
// Detection signals per folder:
//   1. dHash near-duplicate clustering (deterministic, works with no API key).
//      Reuses stored photo_labels.perceptual_hash; computes + persists missing
//      hashes from disk.
//   2. A batched Claude vision pass per folder ("same scene, different
//      angle" grouping). Manual scans use one fail-soft sampled call; strict
//      Dashboard automation opts into bounded exhaustive pair-cover batches
//      and rejects incomplete coverage upstream.
//
// All grouping/keeper/validation decisions live in shared/photo-dedupe-logic.ts.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { storage } from "./storage";
import { computeDhash } from "./photo-hashing";
import {
  buildDedupeVisionInstruction,
  buildCompleteVisionBatchPlan,
  buildDuplicateGroupsForFolder,
  clusterHashPairs,
  parseDedupeVisionGroups,
  summarizeDedupeFolders,
  NEAR_DUPLICATE_DISTANCE,
  type DedupeFolderResult,
  type DedupePhotoEntry,
  type PhotoDedupeProposal,
  type VisionDupeGroup,
} from "../shared/photo-dedupe-logic";

const MODEL = process.env.PHOTO_DEDUPE_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_TIMEOUT_MS = 120_000;
const IMAGE_EXT = /\.(?:jpe?g|png|webp)$/i;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Cap on photos inlined into any one vision call. Hash clustering always covers
// every photo. Manual scans sample down to this cap; strict scans build bounded
// pair-cover calls so every visible pair is compared or fail explicitly.
const VISION_PHOTO_CAP = (() => {
  const n = Number(process.env.PHOTO_DEDUPE_VISION_CAP || 60);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 60;
})();
// Exhaustive pair-cover mode is reserved for strict dashboard automation.
// Manual Photos-tab scans retain one sampled call per folder. At 60 photos per
// call, 12 pair-cover calls can exhaustively compare up to 150 photos; larger
// folders fail explicitly instead of returning a false clean result.
const COMPLETE_VISION_MAX_BATCHES = (() => {
  const n = Number(process.env.PHOTO_DEDUPE_COMPLETE_MAX_BATCHES || 12);
  return Number.isFinite(n) && n >= 1 ? Math.min(30, Math.floor(n)) : 12;
})();
// Images are downscaled for the vision call — scene identity doesn't need
// full resolution, and 60 full-res photos would blow the request size.
const VISION_IMAGE_WIDTH = 640;

const HASH_DISTANCE = (() => {
  const n = Number(process.env.PHOTO_DEDUPE_HASH_DISTANCE);
  return Number.isFinite(n) && n >= 0 && n <= 30 ? n : NEAR_DUPLICATE_DISTANCE;
})();

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

export type DedupeScanGroupInput = {
  folder: string;
  label: string;
  /** Visible filenames in rendered gallery order (the client's photos array). */
  filenames: string[];
  captions?: Record<string, string>;
};

export type DedupeScanOptions = {
  /** Compare every visible photo pair with Claude or report incomplete. */
  requireCompleteVision?: boolean;
};

// ── Scan store (apply validates against the stored proposal) ───────────────
// In-memory on purpose: a proposal is only actionable while the operator has
// the panel open; a restart just means "rescan" (the client surfaces the 410).
const SCAN_TTL_MS = 30 * 60 * 1000;
const MAX_STORED_SCANS = 20;
const scanStore = new Map<string, { proposal: PhotoDedupeProposal; expiresAt: number }>();

function storeScan(proposal: PhotoDedupeProposal): void {
  const now = Date.now();
  for (const [id, entry] of Array.from(scanStore.entries())) {
    if (entry.expiresAt <= now) scanStore.delete(id);
  }
  while (scanStore.size >= MAX_STORED_SCANS) {
    const oldest = scanStore.keys().next().value;
    if (oldest === undefined) break;
    scanStore.delete(oldest);
  }
  scanStore.set(proposal.scanId, { proposal, expiresAt: now + SCAN_TTL_MS });
}

export function getStoredDedupeScan(scanId: string): PhotoDedupeProposal | null {
  const entry = scanStore.get(scanId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    scanStore.delete(scanId);
    return null;
  }
  return entry.proposal;
}

// ── Vision call ─────────────────────────────────────────────────────────────

async function downscaleForVision(buffer: Buffer): Promise<{ data: string; mime: string }> {
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize({ width: VISION_IMAGE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    return { data: out.toString("base64"), mime: "image/jpeg" };
  } catch {
    // Fall back to the original bytes (mime sniffed loosely as jpeg — the API
    // tolerates jpeg/png/webp; original uploads here are one of those).
    return { data: buffer.toString("base64"), mime: "image/jpeg" };
  }
}

async function callDedupeVision(
  apiKey: string,
  folderLabel: string,
  photos: Array<{ id: string; buffer: Buffer; caption?: string | null }>,
): Promise<unknown> {
  const content: any[] = [];
  for (const p of photos) {
    const cap = p.caption ? ` · caption: "${p.caption}"` : "";
    content.push({ type: "text", text: `--- photo ${p.id}${cap} ---` });
    const img = await downscaleForVision(p.buffer);
    content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
  }
  content.push({ type: "text", text: buildDedupeVisionInstruction(folderLabel, photos.length) });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  });
  const data = await resp.json().catch(() => null) as any;
  if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  const text: string = data?.content?.[0]?.text ?? "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("vision response was not JSON");
  return JSON.parse(match[0]);
}

function evenSampleIndices(n: number, cap: number): number[] {
  if (n <= 0) return [];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < cap; i++) {
    out.add(Math.min(n - 1, Math.round((i * (n - 1)) / (cap - 1))));
  }
  return Array.from(out).sort((a, b) => a - b);
}

// ── Scan ────────────────────────────────────────────────────────────────────

async function scanOneFolder(
  group: DedupeScanGroupInput,
  apiKey: string | undefined,
  options: DedupeScanOptions,
): Promise<DedupeFolderResult> {
  const dir = publicPhotoDir(group.folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f));
  } catch {
    diskFiles = [];
  }
  const diskSet = new Set(diskFiles);

  const labelRows = await storage.getPhotoLabelsByFolder(group.folder).catch(() => []);
  const rowByFile = new Map(labelRows.map((r) => [r.filename, r] as const));

  // The client sends the VISIBLE gallery order; intersect with disk so a
  // stale tab can't scan files that no longer exist. Fallback (no filenames):
  // disk order minus hidden rows.
  const requested = Array.isArray(group.filenames) && group.filenames.length > 0
    ? group.filenames.map((f) => path.basename(String(f))).filter((f) => IMAGE_EXT.test(f) && diskSet.has(f))
    : diskFiles.slice().sort().filter((f) => !rowByFile.get(f)?.hidden);
  const filenames = Array.from(new Set(requested));

  const entries: DedupePhotoEntry[] = [];
  const buffers: Array<Buffer | null> = [];
  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    const row = rowByFile.get(filename);
    let hash: string | null = row?.perceptualHash ?? null;
    let buffer: Buffer | null = null;
    let byteSize: number | null = null;
    try {
      buffer = await fs.promises.readFile(path.join(dir, filename));
      byteSize = buffer.length;
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) buffer = null;
    } catch {
      buffer = null;
    }
    if (!hash && buffer) {
      try {
        hash = await computeDhash(buffer);
        // Best-effort backfill so the next scan (and the theft scanner) reuse it.
        if (row) await storage.updatePhotoLabelHash(group.folder, filename, hash).catch(() => {});
      } catch {
        hash = null;
      }
    }
    entries.push({
      folder: group.folder,
      filename,
      caption: row?.userLabel || row?.label || group.captions?.[filename] || null,
      category: row?.userCategory || row?.category || null,
      bedroomClusterId: row?.bedroomClusterId ?? null,
      hash,
      byteSize,
      galleryIndex: i,
      humanTouched: !!(row?.userLabel || row?.userCategory),
      manualSortOrder: row?.sortOrder ?? null,
    });
    buffers.push(buffer);
  }

  const hashPairs = clusterHashPairs(entries, HASH_DISTANCE);

  let visionGroups: VisionDupeGroup[] = [];
  let visionUsed = false;
  let visionComplete = entries.length < 2;
  let visionError: string | null = null;
  let scannedForVision = 0;
  let visionBatchCount = 0;
  const visionDisabled = process.env.PHOTO_DEDUPE_VISION_DISABLED === "1";
  const readable = entries
    .map((e, i) => ({ entry: e, buffer: buffers[i] }))
    .filter((x) => x.buffer != null) as Array<{ entry: DedupePhotoEntry; buffer: Buffer }>;
  if (apiKey && !visionDisabled && entries.length >= 2) {
    const plan = options.requireCompleteVision
      ? buildCompleteVisionBatchPlan(readable.length, VISION_PHOTO_CAP, COMPLETE_VISION_MAX_BATCHES)
      : {
          batches: [evenSampleIndices(readable.length, VISION_PHOTO_CAP)],
          complete: readable.length <= VISION_PHOTO_CAP,
          error: null,
        };
    if (options.requireCompleteVision && !plan.complete) {
      visionError = plan.error || "complete Claude pair coverage could not be planned";
    } else {
      const covered = new Set<number>();
      for (let batchIndex = 0; batchIndex < plan.batches.length; batchIndex++) {
        const sample = plan.batches[batchIndex].map((i) => readable[i]);
        if (sample.length < 2) continue;
        const idToIndex = new Map<string, number>();
        const photos = sample.map((s, n) => {
          const id = `p${n + 1}`;
          idToIndex.set(id, s.entry.galleryIndex);
          return { id, buffer: s.buffer, caption: s.entry.caption };
        });
        try {
          const batchLabel = plan.batches.length > 1
            ? `${group.label || group.folder} (coverage batch ${batchIndex + 1}/${plan.batches.length})`
            : group.label || group.folder;
          const parsed = await callDedupeVision(apiKey, batchLabel, photos);
          visionGroups.push(...parseDedupeVisionGroups(parsed, idToIndex));
          visionUsed = true;
          visionBatchCount += 1;
          for (const s of sample) covered.add(s.entry.galleryIndex);
        } catch (e: any) {
          visionError = String(e?.message ?? e).slice(0, 200);
          console.error(`[photo-dedupe] vision pass failed for ${group.folder}: ${visionError}`);
          break;
        }
      }
      scannedForVision = covered.size;
      visionComplete = plan.complete && visionError == null && readable.length === entries.length &&
        scannedForVision === entries.length && visionBatchCount === plan.batches.length;
    }
  } else if (!apiKey) {
    visionError = "no ANTHROPIC_API_KEY";
  } else if (visionDisabled) {
    visionError = "disabled (PHOTO_DEDUPE_VISION_DISABLED=1)";
  }

  const groups = buildDuplicateGroupsForFolder(group.folder, entries, hashPairs, visionGroups);

  return {
    folder: group.folder,
    label: group.label || group.folder,
    totalVisible: entries.length,
    visionEligible: readable.length,
    scannedForVision,
    visionBatchCount,
    visionUsed,
    visionComplete,
    visionError,
    groups,
  };
}

export async function scanForDuplicatePhotos(
  groups: DedupeScanGroupInput[],
  options: DedupeScanOptions = {},
): Promise<PhotoDedupeProposal> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const folders: DedupeFolderResult[] = [];
  for (const g of groups) {
    folders.push(await scanOneFolder(g, apiKey, options));
  }
  const { groupCount, removableCount, warnings } = summarizeDedupeFolders(folders);
  const proposal: PhotoDedupeProposal = {
    scanId: crypto.randomBytes(8).toString("hex"),
    createdAt: new Date().toISOString(),
    folders,
    groupCount,
    removableCount,
    visionUsed: folders.some((f) => f.visionUsed),
    warnings,
    note: !apiKey
      ? "Hash-only scan (no ANTHROPIC_API_KEY) — exact/near-identical copies only; same-scene angle detection needs the AI pass."
      : undefined,
  };
  storeScan(proposal);
  return proposal;
}
