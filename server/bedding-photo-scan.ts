// ─────────────────────────────────────────────────────────────────────────────
// Bedding PHOTO scan — server engine (vision call + store + audit comparison).
//
// Pure logic (prompt/parse/merge/compare/store shapes) lives in
// shared/bedding-photo-scan.ts. This module owns the impure pieces, modeled on
// amenity-scan.ts + photo-judgment.ts:
//   • folder resolution via buildPhotoCommunityCheckRequestForProperty (the
//     SAME resolution every photo check uses — positive core ids AND negative
//     -draftId, active replacement-* folders after a swap);
//   • ONE batched downscaled-image Claude vision call per unit
//     (`BEDDING_SCAN_MODEL`, default claude-sonnet-4-6; kill
//     `BEDDING_SCAN_VISION_DISABLED=1` → caption-derived fallback);
//   • the fingerprint-scoped scan store in app_settings
//     (`bedding_photo_scans.v1`, promise-tail + fail-soft);
//   • the AUDIT comparison vs the Guesty listing's pushed bed layout. It lives
//     HERE because server/unit-audit-sweep.ts is source-locked to never
//     contain the string "listingRooms" (the layout stage must never push a
//     bed layout) — this module only ever GETs.
//
// Captions are deliberately NOT sent to the vision call: photo_labels captions
// can go stale (the Ilikai stale-label incident) and the whole point of this
// scan is fresh eyes on the actual pixels. The caption FALLBACK (no key /
// disabled) is the explicit degraded mode, flagged method:"captions".
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import sharp from "sharp";
import { storage } from "./storage";
import { guestyRequest } from "./guesty-sync";
import { buildPhotoCommunityCheckRequestForProperty, listPublishedFilenames } from "./builder-photo-groups";
import type { CheckGroupInput } from "./photo-community-check";
import { photoFolderFingerprint } from "../shared/photo-folder-verification";
import {
  BEDDING_PHOTO_SCANS_SETTING_KEY,
  BEDDING_SCAN_MIN_CONFIDENCE,
  buildBeddingVisionPrompt,
  captionFallbackBedding,
  compareDetectedBeddingToGuestyRooms,
  parseBeddingScanStore,
  parseBeddingVisionJson,
  parseGuestyListingRoomsForScan,
  serializeBeddingScanStore,
  summarizeDetectedBedding,
  type BeddingPhotoScanRecord,
  type BeddingScanUnit,
  type CaptionFallbackFile,
} from "../shared/bedding-photo-scan";

const MODEL = process.env.BEDDING_SCAN_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_TIMEOUT_MS = 120_000;
const VISION_IMAGE_WIDTH = 640;
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // pre-downscale read guard

// Bedroom photos matter most (coverage per distinct room); bathrooms next.
// When a folder has no category labels yet, an uncategorized slice still goes
// to vision so a fresh scrape isn't blind.
const BEDROOM_CAP = Number(process.env.BEDDING_SCAN_BEDROOM_CAP || 16);
const BATHROOM_CAP = Number(process.env.BEDDING_SCAN_BATHROOM_CAP || 10);
const UNCATEGORIZED_CAP = Number(process.env.BEDDING_SCAN_FALLBACK_CAP || 20);

export function beddingVisionEnabled(): boolean {
  return String(process.env.BEDDING_SCAN_VISION_DISABLED ?? "").trim() !== "1";
}

// ── Store ────────────────────────────────────────────────────────────────────

let storeTail: Promise<void> = Promise.resolve();

export async function loadBeddingScanStore(): Promise<Record<string, BeddingPhotoScanRecord>> {
  try {
    const raw = await storage.getSetting(BEDDING_PHOTO_SCANS_SETTING_KEY);
    return parseBeddingScanStore(raw ?? null);
  } catch {
    return Object.create(null);
  }
}

function persistBeddingScan(record: BeddingPhotoScanRecord): Promise<boolean> {
  const write = storeTail.then(async () => {
    try {
      const raw = await storage.getSetting(BEDDING_PHOTO_SCANS_SETTING_KEY);
      const map = parseBeddingScanStore(raw ?? null);
      map[String(record.propertyId)] = record;
      await storage.setSetting(BEDDING_PHOTO_SCANS_SETTING_KEY, serializeBeddingScanStore(map));
      return true;
    } catch (err: any) {
      // Fail-soft: an unpersisted scan just re-runs next time — the store is a
      // spend-saver for audits. The explicit tab route opts into required
      // persistence so it can never claim a timestamp was saved when it wasn't.
      console.warn(`[bedding-scan] could not persist property ${record.propertyId}: ${err?.message ?? err}`);
      return false;
    }
  });
  storeTail = write.then(() => undefined);
  return write;
}

/** The stored scan + whether it still describes the CURRENT published photo set. */
export async function loadStoredBeddingScan(
  propertyId: number,
): Promise<{ record: BeddingPhotoScanRecord | null; fresh: boolean }> {
  const map = await loadBeddingScanStore();
  const record = map[String(propertyId)] ?? null;
  if (!record) return { record: null, fresh: false };
  try {
    for (const [folder, fp] of Object.entries(record.fingerprints ?? {})) {
      const current = photoFolderFingerprint(await listPublishedFilenames(folder));
      if (current !== fp) return { record, fresh: false };
    }
    return { record, fresh: Object.keys(record.fingerprints ?? {}).length > 0 };
  } catch {
    return { record, fresh: false };
  }
}

// ── Photo loading ────────────────────────────────────────────────────────────

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

type ScanPhoto = { filename: string; data: string; mime: string };

async function loadScanPhoto(folder: string, filename: string): Promise<ScanPhoto | null> {
  try {
    const buffer = await fs.promises.readFile(path.join(publicPhotoDir(folder), path.basename(filename)));
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
    try {
      const out = await sharp(buffer)
        .rotate()
        .resize({ width: VISION_IMAGE_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      return { filename, data: out.toString("base64"), mime: "image/jpeg" };
    } catch {
      // Downscale failed (odd format) — send the original bytes.
      return { filename, data: buffer.toString("base64"), mime: "image/jpeg" };
    }
  } catch {
    return null;
  }
}

/**
 * Pick which of a unit group's published photos go to vision: every
 * Bedrooms-category photo first (distinct-room coverage is the whole game),
 * then Bathrooms, then — only when the folder has no bed/bath labels at all —
 * an uncategorized slice so a freshly-scraped folder isn't invisible.
 */
export function selectScanFilenames(group: CheckGroupInput): string[] {
  const files = (group.filenames ?? []).map((f) => path.basename(String(f))).filter((f) => IMAGE_EXT.test(f));
  const categories = group.categories ?? {};
  const bedroom = files.filter((f) => categories[f] === "Bedrooms").slice(0, Math.max(1, BEDROOM_CAP));
  const bathroom = files.filter((f) => categories[f] === "Bathrooms").slice(0, Math.max(1, BATHROOM_CAP));
  if (bedroom.length > 0 || bathroom.length > 0) return [...bedroom, ...bathroom];
  return files.slice(0, Math.max(1, UNCATEGORIZED_CAP));
}

// ── Vision call ──────────────────────────────────────────────────────────────

async function callBeddingVision(apiKey: string, prompt: string, photos: ScanPhoto[]): Promise<unknown> {
  const content: any[] = [{ type: "text", text: prompt }];
  photos.forEach((p, i) => {
    content.push({ type: "text", text: `Photo ${i + 1}` });
    content.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.data } });
  });
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: "user", content }] }),
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

function captionFilesForGroup(group: CheckGroupInput): CaptionFallbackFile[] {
  const files = (group.filenames ?? []).map((f) => path.basename(String(f)));
  return files.map((filename) => ({
    filename,
    caption: group.captions?.[filename],
    category: group.categories?.[filename],
    bedroomClusterId: group.bedroomClusterIds?.[filename],
    bedType: group.bedroomBedTypes?.[filename],
  }));
}

// ── Scan ─────────────────────────────────────────────────────────────────────

export type ScanBeddingOptions = {
  anthropicApiKey?: string;
  /** Explicit tab clicks require the scan/timestamp to be durably saved. */
  requirePersistence?: boolean;
};

/**
 * Scan a property's UNIT photos for bedding + bathroom fixtures. Never throws
 * for the degraded cases (no key / no photos) — those come back as
 * method:"captions" or per-unit warnings, so a caller can always render
 * something honest. Persists the result (fail-soft) and returns it.
 */
export async function scanBeddingPhotosForProperty(
  propertyId: number,
  opts: ScanBeddingOptions = {},
): Promise<BeddingPhotoScanRecord> {
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  const useVision = beddingVisionEnabled() && !!apiKey;

  const built = await buildPhotoCommunityCheckRequestForProperty(propertyId);
  const unitGroups = (built?.request.groups ?? []).filter((g) => g.role === "unit");

  const units: BeddingScanUnit[] = [];
  const fingerprints: Record<string, string> = {};
  let anyVision = false;

  for (const group of unitGroups) {
    try {
      fingerprints[group.folder] = photoFolderFingerprint(await listPublishedFilenames(group.folder));
    } catch {
      // Missing fingerprint just means staleness detection can't vouch for
      // this folder — loadStoredBeddingScan treats it as stale-safe.
    }
    const expectedBedrooms = typeof group.expectedBedrooms === "number" && group.expectedBedrooms > 0
      ? group.expectedBedrooms
      : null;

    const base: Omit<BeddingScanUnit, "bedrooms" | "bathrooms" | "photosScanned" | "unphotographedBedrooms"> = {
      unitId: group.unitId,
      folder: group.folder,
      label: group.label,
      expectedBedrooms,
    };

    const finalizeUnit = (
      bedrooms: BeddingScanUnit["bedrooms"],
      bathrooms: BeddingScanUnit["bathrooms"],
      photosScanned: number,
      evidenceMethod?: BeddingScanUnit["evidenceMethod"],
      warning?: string,
    ) => {
      // Audit coverage deliberately remains inclusive at the 60% floor. The
      // stricter >60% rule belongs only to the explicit tab auto-apply seam.
      const confident = bedrooms.filter((b) =>
        b.confidence >= BEDDING_SCAN_MIN_CONFIDENCE).length;
      units.push({
        ...base,
        evidenceMethod,
        bedrooms,
        bathrooms,
        photosScanned,
        unphotographedBedrooms: expectedBedrooms != null ? Math.max(0, expectedBedrooms - confident) : 0,
        warning,
      });
    };

    if (!useVision) {
      const { bedrooms, bathrooms } = captionFallbackBedding(captionFilesForGroup(group));
      finalizeUnit(bedrooms, bathrooms, 0, "captions", apiKey ? "Vision disabled — derived from existing photo labels; review only, not auto-applied." : "No ANTHROPIC_API_KEY — derived from existing photo labels; review only, not auto-applied.");
      continue;
    }

    const filenames = selectScanFilenames(group);
    const photos: ScanPhoto[] = [];
    for (const filename of filenames) {
      const p = await loadScanPhoto(group.folder, filename);
      if (p) photos.push(p);
    }
    if (photos.length === 0) {
      finalizeUnit([], [], 0, undefined, "No readable photos on disk for this unit yet.");
      continue;
    }

    try {
      const prompt = buildBeddingVisionPrompt({
        unitLabel: group.label,
        expectedBedrooms,
        photoCount: photos.length,
      });
      const raw = await callBeddingVision(apiKey, prompt, photos);
      const parsed = parseBeddingVisionJson(raw, photos.length);
      if (!parsed) throw new Error("vision answer did not match the required shape");
      anyVision = true;
      const bedrooms = parsed.bedrooms.map((b) => ({
        beds: b.beds,
        ensuiteFeatures: b.ensuiteFeatures,
        confidence: b.confidence,
        photos: b.photoIndexes.map((i) => photos[i - 1]?.filename).filter((f): f is string => !!f),
      }));
      const bathrooms = parsed.bathrooms.map((b) => ({
        features: b.features,
        isHalf: b.isHalf,
        confidence: b.confidence,
        photos: b.photoIndexes.map((i) => photos[i - 1]?.filename).filter((f): f is string => !!f),
      }));
      finalizeUnit(bedrooms, bathrooms, photos.length, "vision");
    } catch (err: any) {
      // FAIL-SOFT to the caption fallback for THIS unit; the warning keeps the
      // degradation visible (honesty over silence).
      const { bedrooms, bathrooms } = captionFallbackBedding(captionFilesForGroup(group));
      finalizeUnit(bedrooms, bathrooms, photos.length, "captions", `Vision scan failed (${String(err?.message ?? err).slice(0, 160)}) — derived from existing photo labels instead; review only, not auto-applied.`);
      console.warn(`[bedding-scan] vision failed for ${group.folder} (property ${propertyId}): ${err?.message ?? err}`);
    }
  }

  const record: BeddingPhotoScanRecord = {
    propertyId,
    scannedAt: new Date().toISOString(),
    method: anyVision ? "vision" : "captions",
    model: anyVision ? MODEL : null,
    units,
    fingerprints,
  };
  const persisted = await persistBeddingScan(record);
  if (opts.requirePersistence && !persisted) {
    throw new Error("The bedding scan finished, but its result and timestamp could not be saved. Guesty was not updated.");
  }
  return record;
}

// ── Audit hook ───────────────────────────────────────────────────────────────

export type BeddingAuditCheckResult = {
  /** Receipt lines for the layout stage's items list. */
  items: string[];
  /** Photo-proven disagreement with the pushed Guesty bed layout. */
  mismatch: boolean;
  /** Claimed bedrooms without photo evidence (note, not a fail). */
  unverified: boolean;
  method: "vision" | "captions";
  /** True when a fingerprint-fresh stored scan was reused (no new vision spend). */
  reusedStoredScan: boolean;
};

/**
 * The unit-audit layout stage's bedding photo check. Reuses a
 * fingerprint-fresh stored scan when the published photo set is unchanged
 * (the Bedding-tab button and prior audits share the store — parallel to the
 * OTA fresh-row reuse); otherwise runs a fresh scan. Reads the Guesty
 * listing's pushed bed layout with a gated GET and compares TYPE presence
 * only. Throws when the check itself cannot run (Guesty read failure) — the
 * sweep reports that honestly as "could not run".
 */
export async function beddingPhotoCheckForAudit(
  propertyId: number,
  guestyListingId: string,
): Promise<BeddingAuditCheckResult> {
  const stored = await loadStoredBeddingScan(propertyId);
  const record = stored.fresh && stored.record
    ? stored.record
    : await scanBeddingPhotosForProperty(propertyId);

  const listing = await guestyRequest(
    "GET",
    `/listings/${encodeURIComponent(guestyListingId)}?fields=${encodeURIComponent("listingRooms bedrooms")}`,
  ) as Record<string, unknown> | null;
  const rooms = parseGuestyListingRoomsForScan((listing as any)?.listingRooms);

  const comparison = compareDetectedBeddingToGuestyRooms(record.units, rooms);
  const items = [...comparison.items];
  if (record.method === "captions") {
    items.push("Bedding photo check ran in label-fallback mode (no vision) — findings are caption-derived");
  }
  const summary = summarizeDetectedBedding(record.units);
  if (summary && !comparison.items.some((i) => i.includes(summary))) {
    items.push(`Bedding photo check detected: ${summary}`);
  }
  return {
    items,
    mismatch: comparison.mismatch,
    unverified: comparison.unverified,
    method: record.method,
    reusedStoredScan: stored.fresh && !!stored.record,
  };
}
