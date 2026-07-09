// ─────────────────────────────────────────────────────────────────────────────
// Photo-driven amenity scanner.
//
// Given a propertyId (positive core id OR negative -draftId), load the property's
// community + unit photos from disk, ask Claude vision which amenities are
// visibly present, and fold them into the amenity selection (ADD-ONLY; fills the
// standard baseline for a fresh listing). Reuses the SAME folder resolution as
// the photo-community check (buildPhotoCommunityCheckRequestForProperty), so it
// scans the exact folders the listing will publish — including a unit's active
// replacement-* folder after a photo swap.
//
// Persistence + the optional Guesty push live in the route/caller; this module
// only reads photos + runs vision + merges (so the bulk-combo job and the tab
// scan share one code path).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { buildPhotoCommunityCheckRequestForProperty } from "./builder-photo-groups";
import type { CheckGroupInput } from "./photo-community-check";
import {
  AMENITY_VISION_TARGETS,
  AMENITY_CATALOG_KEYS,
  HAWAII_BASE_AMENITY_KEYS,
  getAmenityLabel,
} from "@shared/guesty-amenity-catalog";
import {
  buildAmenityDetectionInstruction,
  parseAmenityDetectionJson,
  mergeDetectedAmenities,
  type AmenityDetection,
} from "@shared/amenity-scan-logic";

const MODEL = process.env.AMENITY_SCAN_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_TIMEOUT_MS = 90_000;
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Per-group photo caps + how many images ride in one vision call. Kept small so
// each call stays well under the timeout; batches only UNION detections (add-only),
// so splitting is lossless. Env-tunable for tighter/looser budgets.
const COMMUNITY_PHOTO_CAP = Number(process.env.AMENITY_SCAN_COMMUNITY_CAP || 12);
const UNIT_PHOTO_CAP = Number(process.env.AMENITY_SCAN_UNIT_CAP || 12);
const VISION_BATCH_SIZE = Number(process.env.AMENITY_SCAN_BATCH_SIZE || 12);

export type AmenityScanResult = {
  ok: boolean;
  propertyId: number;
  community: string;
  /** Merged, add-only amenity selection (catalog keys). */
  next: string[];
  /** Detected keys newly added on top of the base. */
  added: string[];
  /** Every key the scan detected (incl. ones already selected). */
  detected: string[];
  /** Per-key vision detail (confidence + evidence) for UI/diagnostics. */
  detail: AmenityDetection[];
  base: string[];
  filledFromBaseline: boolean;
  photosScanned: number;
  groupsScanned: number;
  /** Non-fatal note (e.g. no key / no photos). */
  warning?: string;
};

type LoadedPhoto = {
  groupLabel: string;
  role: "community" | "unit";
  filename: string;
  caption?: string;
  buffer: Buffer;
  mime: string;
};

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

function mimeForBuffer(buffer: Buffer, filename: string): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const head = buffer.slice(0, 6).toString("ascii");
  if (head.startsWith("GIF87") || head.startsWith("GIF89")) return "image/gif";
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

/** Evenly spread `cap` indices across `n` items (keeps a representative spread). */
function evenSampleIndices(n: number, cap: number): number[] {
  if (n <= 0) return [];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < cap; i++) {
    out.add(Math.min(n - 1, Math.round((i * (n - 1)) / (cap - 1))));
  }
  return Array.from(out).sort((a, b) => a - b);
}

async function loadGroupPhotos(group: CheckGroupInput, cap: number): Promise<LoadedPhoto[]> {
  const dir = publicPhotoDir(group.folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f));
  } catch {
    return [];
  }
  const diskSet = new Set(diskFiles);
  const requested = Array.isArray(group.filenames) && group.filenames.length > 0
    ? group.filenames.map((f) => path.basename(String(f))).filter((f) => IMAGE_EXT.test(f) && diskSet.has(f))
    : diskFiles.slice().sort();
  const ordered = Array.from(new Set(requested));
  const idxs = evenSampleIndices(ordered.length, cap);
  const out: LoadedPhoto[] = [];
  for (const i of idxs) {
    const filename = ordered[i];
    try {
      const buffer = await fs.promises.readFile(path.join(dir, filename));
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;
      out.push({
        groupLabel: group.label,
        role: group.role,
        filename,
        caption: group.captions?.[filename],
        buffer,
        mime: mimeForBuffer(buffer, filename),
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

async function callAmenityVision(apiKey: string, content: any[]): Promise<unknown> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type ScanAmenitiesOptions = {
  /** Existing selection to add onto; null/undefined → fill from baseline. */
  currentKeys?: string[] | null;
  /** Override the baseline (defaults to the Hawaii standard baseline). */
  baseline?: string[];
  /** Anthropic key (defaults to env). Empty → no vision, baseline-only merge. */
  anthropicApiKey?: string;
};

/**
 * Scan a property's photos for amenities and return the add-only merged set.
 * Never throws for the "no vision available" case — it degrades to a
 * baseline/current merge with a warning, so a fresh draft is still filled out.
 */
export async function scanAmenitiesForProperty(
  propertyId: number,
  opts: ScanAmenitiesOptions = {},
): Promise<AmenityScanResult> {
  const baseline = opts.baseline ?? HAWAII_BASE_AMENITY_KEYS;
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";

  const built = await buildPhotoCommunityCheckRequestForProperty(propertyId);
  const community = built?.request.expectedCommunity ?? "";
  const groups = built?.request.groups ?? [];

  const finalize = (detected: string[], detail: AmenityDetection[], photosScanned: number, groupsScanned: number, warning?: string): AmenityScanResult => {
    const merged = mergeDetectedAmenities({
      current: opts.currentKeys ?? null,
      baseline,
      detected,
      validKeys: AMENITY_CATALOG_KEYS,
    });
    return {
      ok: true,
      propertyId,
      community,
      next: merged.next,
      added: merged.added,
      detected: detected.filter((k) => AMENITY_CATALOG_KEYS.has(k)),
      detail,
      base: merged.base,
      filledFromBaseline: merged.filledFromBaseline,
      photosScanned,
      groupsScanned,
      warning,
    };
  };

  if (groups.length === 0) {
    return finalize([], [], 0, 0, built ? "No photo folders found for this property." : "Property not found.");
  }
  if (!apiKey) {
    return finalize([], [], 0, groups.length, "No ANTHROPIC_API_KEY — filled the standard baseline without a photo scan.");
  }

  // Load + sample photos per group.
  const photos: LoadedPhoto[] = [];
  for (const g of groups) {
    const cap = g.role === "community" ? COMMUNITY_PHOTO_CAP : UNIT_PHOTO_CAP;
    photos.push(...await loadGroupPhotos(g, cap));
  }
  if (photos.length === 0) {
    return finalize([], [], 0, groups.length, "No readable photos on disk for this property yet.");
  }

  const instruction = buildAmenityDetectionInstruction(AMENITY_VISION_TARGETS, {
    communityName: community,
    labelForKey: getAmenityLabel,
  });

  // Batch the images (add-only union across batches, so splitting is lossless).
  const bestByKey = new Map<string, AmenityDetection>();
  const confRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  let batchErrors = 0;
  for (const batch of chunk(photos, VISION_BATCH_SIZE)) {
    const content: any[] = [{ type: "text", text: instruction }];
    // number photos per group so the model can cite "Community photo 2".
    const counters = new Map<string, number>();
    for (const p of batch) {
      const n = (counters.get(p.groupLabel) ?? 0) + 1;
      counters.set(p.groupLabel, n);
      const cap = p.caption ? ` — caption: ${p.caption}` : "";
      content.push({ type: "text", text: `${p.groupLabel} photo ${n}${cap}` });
      content.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.buffer.toString("base64") } });
    }
    try {
      const parsed = await callAmenityVision(apiKey, content);
      const { detail } = parseAmenityDetectionJson(parsed, AMENITY_CATALOG_KEYS);
      for (const d of detail) {
        const prev = bestByKey.get(d.key);
        if (!prev || confRank[d.confidence] > confRank[prev.confidence]) bestByKey.set(d.key, d);
      }
    } catch (err: any) {
      batchErrors += 1;
      console.warn(`[amenity-scan] vision batch failed (${propertyId}): ${err?.message ?? err}`);
    }
  }

  const detail = Array.from(bestByKey.values());
  const detected = detail.filter((d) => d.confidence !== "low").map((d) => d.key);
  const warning = batchErrors > 0 && detected.length === 0
    ? "The photo scan could not complete; filled the standard baseline only."
    : batchErrors > 0
      ? `Some photo batches failed (${batchErrors}); results may be partial.`
      : undefined;
  return finalize(detected, detail, photos.length, groups.length, warning);
}
