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
//   2. One batched Claude vision call per folder ("same scene, different
//      angle" grouping) — fail-soft: any error degrades that folder to
//      hash-only results, never fails the scan.
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
// Cap on photos inlined into the per-folder vision call. Hash clustering still
// covers EVERY photo; beyond the cap only the AI same-scene signal thins out.
const VISION_PHOTO_CAP = Number(process.env.PHOTO_DEDUPE_VISION_CAP || 60);
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
  let visionError: string | null = null;
  let scannedForVision = 0;
  const visionDisabled = process.env.PHOTO_DEDUPE_VISION_DISABLED === "1";
  if (apiKey && !visionDisabled && entries.length >= 2) {
    const readable = entries
      .map((e, i) => ({ entry: e, buffer: buffers[i] }))
      .filter((x) => x.buffer != null) as Array<{ entry: DedupePhotoEntry; buffer: Buffer }>;
    const sampleIdx = evenSampleIndices(readable.length, VISION_PHOTO_CAP);
    const sample = sampleIdx.map((i) => readable[i]);
    scannedForVision = sample.length;
    if (sample.length >= 2) {
      const idToIndex = new Map<string, number>();
      const photos = sample.map((s, n) => {
        const id = `p${n + 1}`;
        idToIndex.set(id, s.entry.galleryIndex);
        return { id, buffer: s.buffer, caption: s.entry.caption };
      });
      try {
        const parsed = await callDedupeVision(apiKey, group.label || group.folder, photos);
        visionGroups = parseDedupeVisionGroups(parsed, idToIndex);
        visionUsed = true;
      } catch (e: any) {
        visionError = String(e?.message ?? e).slice(0, 200);
        console.error(`[photo-dedupe] vision pass failed for ${group.folder}: ${visionError}`);
      }
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
    scannedForVision,
    visionUsed,
    visionError,
    groups,
  };
}

export async function scanForDuplicatePhotos(
  groups: DedupeScanGroupInput[],
): Promise<PhotoDedupeProposal> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const folders: DedupeFolderResult[] = [];
  for (const g of groups) {
    folders.push(await scanOneFolder(g, apiKey));
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
