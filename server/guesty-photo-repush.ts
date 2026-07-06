// Server-side Guesty photo RE-PUSH after a unit photo replacement (2026-07-05
// operator ask). A committed unit swap hydrates replacement-p<prop>-u<unit> on
// disk, but until the mapped Guesty listing's pictures[] is re-PUT it keeps
// serving the OLD unit's photos — the exact ones the OTA scan flagged as
// duplicated on someone else's listing. This module assembles the listing's
// CURRENT gallery (active folders: replacement folder when swapped, else the
// unit's own; community last) and drives the existing
// POST /api/builder/push-photos via loopback — reusing its ImgBB hosting,
// collage pinning, 100-photo cap, checkpointed PUTs, and the verify-and-retry
// loop. That PUT replaces the entire pictures[] array, which is what deletes
// the stale photos from Guesty (and, via Guesty's fan-out, from the OTAs).
//
// Callers:
//   - POST /api/unit-swaps (routes.ts) — fire-and-forget after every swap
//     commit (manual "pick manually" flow + the auto-replace orchestrator's
//     loopback commit both land there).
//   - server/auto-replace-jobs.ts phase 3 — awaited, so the dashboard queue
//     shows push progress/outcome (it passes skipGuestyPhotoPush to the
//     commit POST so the same swap isn't pushed twice).
//   - POST /api/replacement/repush-guesty-photos — retroactive sweep for
//     properties swapped within the trailing window (default 3 days).

import path from "node:path";
import { getUnitBuilderByPropertyId } from "../client/src/data/unit-builder-data";
import { resolveActiveUnitPhotoFolders } from "@shared/unit-swap-photos";
import { resolveCanonicalCommunityPhotoFolder } from "@shared/community-photo-folders";
import { draftUnitIdForSlot } from "@shared/auto-replace-job-logic";
import {
  assembleGuestyPushPhotos,
  recentUnitSwapPropertyIds,
  type GuestyPushGallery,
} from "@shared/guesty-photo-repush";
import { listPhotoFiles } from "./photo-labeler";
import { loopbackRequestHeaders } from "./auth";
import { storage } from "./storage";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;
const photosRoot = () => path.join(process.cwd(), "client/public/photos");

// A full push (upscale + ImgBB + checkpointed Guesty PUTs + verify loop) runs
// 1-3 min for a 30-50 photo gallery; 15 min is a generous ceiling.
const PUSH_TIMEOUT_MS = 15 * 60 * 1000;

// hydrateUnitSwapPhotoFolder QUEUES the Claude photo-label scan
// (queueMissingPhotoLabels) — it does not await it. A push fired right after
// a swap commit would otherwise beat the labeler and publish filename-fallback
// captions ("01", "02") with no hero-first ordering signal. Bounded wait: poll
// the fresh folder's label coverage, proceed anyway on timeout (fallback
// captions beat leaving the duplicated photos live on Guesty).
const LABEL_WAIT_TIMEOUT_MS = 4 * 60 * 1000;
const LABEL_WAIT_POLL_MS = 10_000;
const LABEL_WAIT_COVERAGE = 0.9;

async function waitForFolderLabels(folder: string): Promise<void> {
  const startedAt = Date.now();
  const dir = path.join(photosRoot(), folder);
  for (;;) {
    const files = await listPhotoFiles(dir).catch(() => [] as string[]);
    if (files.length === 0) return;
    const labels = await storage.getPhotoLabelsByFolder(folder).catch(() => []);
    const labeled = new Set(labels.map((row) => row.filename));
    const covered = files.filter((f) => labeled.has(f)).length / files.length;
    if (covered >= LABEL_WAIT_COVERAGE) return;
    if (Date.now() - startedAt > LABEL_WAIT_TIMEOUT_MS) {
      console.warn(`[guesty-photo-repush] ${folder}: label coverage ${(covered * 100).toFixed(0)}% after ${Math.round(LABEL_WAIT_TIMEOUT_MS / 60000)} min — pushing with filename-fallback captions for the rest`);
      return;
    }
    await new Promise((r) => setTimeout(r, LABEL_WAIT_POLL_MS));
  }
}

export type GuestyPhotoRepushResult = {
  ok: boolean;
  propertyId: number;
  propertyName?: string;
  guestyListingId?: string;
  skipped?: "no-builder" | "no-guesty-mapping" | "no-photos";
  photoCount?: number;
  successCount?: number;
  verifiedCount?: number;
  error?: string;
};

// Serialize pushes per property: the unit-swaps hook and the retroactive
// sweep can overlap, and two concurrent PUTs against the same listing's
// pictures[] would race (last writer wins with a possibly-shorter set).
const pushTails = new Map<number, Promise<unknown>>();

// Promoted drafts (negative ids) have no unit-builder-data entry — their
// gallery structure lives on the community_drafts row (unit{1,2}PhotoFolder
// + the canonical community folder adapt-draft.ts resolves). 2026-07-05: the
// draft "Replace photos" flow needs the same auto re-push builder properties
// get, otherwise the live listing keeps serving the flagged photos.
async function draftPushUnits(propertyId: number): Promise<
  { propertyName: string; units: Array<{ id: string; photoFolder?: string }>; communityFolder: string } | null
> {
  const draftId = -propertyId;
  if (!Number.isFinite(draftId) || draftId <= 0) return null;
  const draft = await storage.getCommunityDraft(draftId).catch(() => undefined);
  if (!draft) return null;
  const units: Array<{ id: string; photoFolder?: string }> = [
    { id: draftUnitIdForSlot(draftId, "a"), photoFolder: draft.unit1PhotoFolder ?? undefined },
  ];
  if ((draft as any).singleListing !== true) {
    units.push({ id: draftUnitIdForSlot(draftId, "b"), photoFolder: draft.unit2PhotoFolder ?? undefined });
  }
  return {
    propertyName: draft.name,
    units,
    communityFolder: resolveCanonicalCommunityPhotoFolder(draft.name) ?? `community-draft-${draftId}`,
  };
}

async function assemblePushPhotosForProperty(propertyId: number): Promise<
  | { photos: Array<{ localPath: string; caption: string }>; guestyListingId: string; propertyName: string }
  | { skipped: NonNullable<GuestyPhotoRepushResult["skipped"]>; propertyName?: string }
> {
  const builder = propertyId > 0 ? getUnitBuilderByPropertyId(propertyId) : undefined;
  const draft = !builder ? await draftPushUnits(propertyId) : null;
  if (!builder && !draft) return { skipped: "no-builder" };
  const propertyName = builder ? (builder.propertyName || builder.complexName) : draft!.propertyName;
  const guestyListingId = await storage.getGuestyListingId(propertyId).catch(() => undefined);
  if (!guestyListingId) return { skipped: "no-guesty-mapping", propertyName };

  const swaps = await storage.getUnitSwaps(propertyId).catch(() => []);
  const pushUnits: Array<{ id: string; photoFolder?: string; photos?: Array<{ filename: string; label: string }> }> =
    builder ? builder.units : draft!.units;
  const activeFolders = resolveActiveUnitPhotoFolders(propertyId, pushUnits, swaps);

  const galleries: GuestyPushGallery[] = [];
  const galleryFor = async (
    folder: string,
    scope: "unit" | "community",
    staticLabels?: Record<string, string>,
  ): Promise<GuestyPushGallery> => ({
    folder,
    scope,
    files: (await listPhotoFiles(path.join(photosRoot(), folder)).catch(() => [] as string[])).slice().sort(),
    labels: await storage.getPhotoLabelsByFolder(folder).catch(() => []),
    staticLabels,
  });

  // Units first (A, B, …) — same across-gallery order as the builder Photos
  // tab. Static unit-builder-data captions only apply to a builder unit's
  // ORIGINAL folder; replacement folders (and all draft folders) are labeled
  // by the Claude labeler / photo_labels rows.
  for (const unit of pushUnits) {
    const active = activeFolders.find((f) => f.unitId === unit.id);
    if (!active?.activeFolder) continue;
    const staticLabels = !active.replaced && Array.isArray(unit.photos)
      ? Object.fromEntries(unit.photos.map((p) => [p.filename, p.label]))
      : undefined;
    galleries.push(await galleryFor(active.activeFolder, "unit", staticLabels));
  }
  // Community last.
  const communityFolder = builder ? builder.communityPhotoFolder : draft!.communityFolder;
  if (communityFolder) {
    const staticLabels = builder && Array.isArray(builder.communityPhotos)
      ? Object.fromEntries(builder.communityPhotos.map((p) => [p.filename, p.label]))
      : undefined;
    galleries.push(await galleryFor(communityFolder, "community", staticLabels));
  }

  const photos = assembleGuestyPushPhotos(galleries);
  if (photos.length === 0) return { skipped: "no-photos", propertyName };
  return { photos, guestyListingId, propertyName };
}

async function runRepush(propertyId: number, reason: string, waitForLabelsFolder?: string): Promise<GuestyPhotoRepushResult> {
  const base: GuestyPhotoRepushResult = { ok: false, propertyId };
  let assembled: Awaited<ReturnType<typeof assemblePushPhotosForProperty>>;
  try {
    if (waitForLabelsFolder) await waitForFolderLabels(waitForLabelsFolder);
    assembled = await assemblePushPhotosForProperty(propertyId);
  } catch (e: any) {
    return { ...base, error: `Photo assembly failed: ${e?.message ?? e}` };
  }
  if ("skipped" in assembled) {
    console.log(`[guesty-photo-repush] property ${propertyId} skipped (${assembled.skipped}) — ${reason}`);
    // A property with no Guesty mapping (e.g. an unpublished draft) has
    // nothing stale to overwrite — skipping IS the correct outcome.
    return { ...base, ok: assembled.skipped !== "no-photos", skipped: assembled.skipped, propertyName: assembled.propertyName };
  }

  const { photos, guestyListingId, propertyName } = assembled;
  console.log(`[guesty-photo-repush] pushing ${photos.length} photos to Guesty listing ${guestyListingId} (${propertyName}) — ${reason}`);
  try {
    const resp = await fetch(`${loopbackBaseUrl()}/api/builder/push-photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
      body: JSON.stringify({ guestyListingId, photos, upscale: true }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!resp.ok || !resp.body) {
      return { ...base, propertyName, guestyListingId, photoCount: photos.length, error: `push-photos HTTP ${resp.status}` };
    }
    // Drain the NDJSON stream; the final {type:"done"} line carries the counts.
    let successCount = 0;
    let verifiedCount = 0;
    let sawDone = false;
    const reader = (resp.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev?.type === "done") {
            sawDone = true;
            successCount = Number(ev.successCount ?? 0);
            verifiedCount = Number(ev.verifiedCount ?? 0);
          }
        } catch { /* malformed line — ignore */ }
      }
    }
    const ok = sawDone && successCount > 0;
    console.log(`[guesty-photo-repush] ${propertyName}: ${ok ? "✓" : "✗"} ${successCount}/${photos.length} pushed, ${verifiedCount} verified on Guesty`);
    return {
      ...base,
      ok,
      propertyName,
      guestyListingId,
      photoCount: photos.length,
      successCount,
      verifiedCount,
      ...(ok ? {} : { error: sawDone ? "Guesty saved 0 photos" : "push stream ended without a done event" }),
    };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError" ? `push timed out after ${Math.round(PUSH_TIMEOUT_MS / 60000)} min` : (e?.message ?? String(e));
    console.warn(`[guesty-photo-repush] ${propertyName}: push failed — ${msg}`);
    return { ...base, propertyName, guestyListingId, photoCount: photos.length, error: msg };
  }
}

/**
 * Re-push the property's CURRENT gallery (active folders) to its mapped
 * Guesty listing. Per-property calls are serialized so overlapping triggers
 * can't race two PUTs against the same pictures[] array.
 */
export function repushGuestyPhotosForProperty(
  propertyId: number,
  opts: {
    reason?: string;
    /**
     * Folder just hydrated by the triggering swap — the push waits (bounded)
     * for its Claude photo labels so captions/ordering match a manual push.
     */
    waitForLabelsFolder?: string;
  } = {},
): Promise<GuestyPhotoRepushResult> {
  const reason = opts.reason ?? "manual";
  const tail = pushTails.get(propertyId) ?? Promise.resolve();
  const run = tail
    .catch(() => undefined)
    .then(() => runRepush(propertyId, reason, opts.waitForLabelsFolder));
  pushTails.set(propertyId, run);
  void run.finally(() => {
    if (pushTails.get(propertyId) === run) pushTails.delete(propertyId);
  });
  return run;
}

/**
 * Retroactive sweep: re-push every property with a unit swap recorded in the
 * trailing window (default 3 days). Sequential — Guesty's picture PUT is
 * tenant-rate-limited, and each push is already minutes-long.
 */
export async function repushGuestyPhotosForRecentSwaps(
  windowDays: number,
  onEvent?: (
    event:
      | { type: "start"; propertyIds: number[]; windowDays: number }
      | { type: "property-start"; propertyId: number }
      | ({ type: "property" } & GuestyPhotoRepushResult),
  ) => void,
): Promise<{ propertyIds: number[]; results: GuestyPhotoRepushResult[] }> {
  const swaps = await storage.getAllUnitSwaps().catch(() => []);
  const propertyIds = recentUnitSwapPropertyIds(swaps, Date.now(), windowDays);
  onEvent?.({ type: "start", propertyIds, windowDays });
  const results: GuestyPhotoRepushResult[] = [];
  for (const propertyId of propertyIds) {
    onEvent?.({ type: "property-start", propertyId });
    const result = await repushGuestyPhotosForProperty(propertyId, { reason: `retro sweep (${windowDays}d window)` });
    results.push(result);
    onEvent?.({ type: "property", ...result });
  }
  return { propertyIds, results };
}
