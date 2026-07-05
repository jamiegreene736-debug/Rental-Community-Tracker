// One-click "Auto replace unit photos" orchestrator (dashboard duplicate-photos
// warning). Chains the EXISTING machinery server-side so the operator's click
// is fire-and-forget:
//
//   1. finding    — start the replacement-find background job (same engine as
//                   the manual flow; restart-survivable per PR #899).
//   2. committing — auto-commit the first viable candidate via loopback
//                   POST /api/unit-swaps (the route owns every dedup guard +
//                   photo hydration). A 409 duplicate-source rejection burns
//                   that URL and falls through to the next option.
//   3. verifying  — kick the deep OTA rescan of the new replacement folder +
//                   the Claude-vision photo-community check (both existing
//                   endpoints), then complete. The dashboard's own polling
//                   refreshes the duplicate-photos indicators as those land.
//
// Records persist in app_settings (shared/auto-replace-job-logic.ts) and a
// boot/interval watchdog resumes orphaned jobs after a Railway restart —
// the phone can be in another app the whole time. Pure decisions are
// unit-tested in tests/auto-replace-job.test.ts.

import { getUnitBuilderByPropertyId } from "../client/src/data/unit-builder-data";
import { inferCommunityStreetAddress } from "@shared/community-addresses";
import { parseStreetCityState } from "@shared/address-listing-logic";
import { latestUnitSwapsByUnit, replacementPhotoFolderForUnit } from "@shared/unit-swap-photos";
import {
  AUTO_REPLACE_STORE_SETTING_KEY,
  clearableAutoReplaceJobIds,
  findActiveAutoReplaceJob,
  isAutoReplacePhaseActive,
  nextStepFromFindJob,
  parseAutoReplaceStore,
  pickCommitCandidate,
  serializeAutoReplaceStore,
  shouldResumeAutoReplaceJob,
  summarizeAutoReplaceQueue,
  type AutoReplaceJobRecord,
  type AutoReplacePhase,
} from "@shared/auto-replace-job-logic";
import {
  getPersistedReplacementFindJob,
  getPreflightReplacementFindJob,
  startPreflightReplacementFindJob,
} from "./preflight-background-jobs";
import { repushGuestyPhotosForProperty } from "./guesty-photo-repush";
import { loopbackRequestHeaders } from "./auth";
import { storage } from "./storage";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

const FIND_POLL_INTERVAL_MS = 5_000;
// The exhaustive manual search can run long; the auto flow uses first-hit mode
// so ~45 min is a generous ceiling before declaring the find leg stuck.
const FIND_WAIT_CEILING_MS = 45 * 60 * 1000;

const jobs = new Map<string, AutoReplaceJobRecord>();
const activeJobIds = new Set<string>();

let storeTail: Promise<void> = Promise.resolve();
function mutateStore(mutate: (store: Record<string, AutoReplaceJobRecord>, nowMs: number) => void): Promise<void> {
  storeTail = storeTail.then(async () => {
    try {
      const now = Date.now();
      const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY);
      const store = parseAutoReplaceStore(raw ?? null);
      mutate(store, now);
      await storage.setSetting(AUTO_REPLACE_STORE_SETTING_KEY, serializeAutoReplaceStore(store, now));
    } catch {
      // Fail-soft: persistence is an upgrade, never a blocker.
    }
  });
  return storeTail;
}

function touch(record: AutoReplaceJobRecord, patch: Partial<AutoReplaceJobRecord>): void {
  Object.assign(record, patch, { updatedAt: Date.now() });
  jobs.set(record.jobId, record);
  void mutateStore((store) => {
    store[record.jobId] = { ...record };
  });
}

// The same find payload the manual dialog assembles (builder-preflight parity):
// parsed display address + inferred community street + existing swaps' source
// URLs as skipUrls. First-hit mode (no collectAllOptions) — the auto flow
// commits the first viable unit, so exhaustive pool-draining is wasted time.
async function assembleFindPayload(propertyId: number, unitId: string): Promise<Record<string, unknown> | null> {
  const builder = getUnitBuilderByPropertyId(propertyId);
  if (!builder?.communityPhotoFolder) return null;
  const unit = builder.units.find((u) => u.id === unitId);
  if (!unit) return null;
  const parsed = parseStreetCityState(builder.address ?? "");
  const streetAddress = inferCommunityStreetAddress({
    communityName: builder.complexName,
    city: parsed.city,
    state: parsed.state,
    addressHint: parsed.street || builder.address,
  }) || parsed.street;
  const swaps = latestUnitSwapsByUnit(await storage.getUnitSwaps(propertyId).catch(() => []));
  const skipUrls = Array.from(new Set(
    Array.from(swaps.values()).map((s: any) => String(s?.newSourceUrl ?? "")).filter(Boolean),
  ));
  return {
    communityFolder: builder.communityPhotoFolder,
    communityName: builder.complexName,
    propertyAddress: builder.address,
    streetAddress: streetAddress || undefined,
    city: parsed.city || undefined,
    state: parsed.state || undefined,
    propertyId,
    targetUnitId: unit.id,
    requiredBedrooms: unit.bedrooms,
    skipUrls,
  };
}

async function postLoopback(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: any }> {
  const resp = await fetch(`${loopbackBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function runAutoReplaceJob(record: AutoReplaceJobRecord): Promise<void> {
  if (activeJobIds.has(record.jobId)) return;
  activeJobIds.add(record.jobId);
  try {
    // Phase 1 — finding.
    if (!record.findJobId) {
      const payload = await assembleFindPayload(record.propertyId, record.unitId);
      if (!payload) {
        touch(record, { phase: "failed", error: "Could not resolve this property/unit for a replacement search." });
        return;
      }
      const findJob = startPreflightReplacementFindJob(payload);
      touch(record, {
        phase: "finding",
        findJobId: findJob.id,
        message: `Searching ${String(payload.communityName ?? "the community")} for a clean ${String(payload.requiredBedrooms ?? "?")}BR unit…`,
      });
    } else if (record.phase === "queued") {
      touch(record, { phase: "finding" });
    }

    // Wait for the find job (it survives restarts on its own — PR #899).
    let findJob: any = null;
    if (record.phase === "finding") {
      const waitStart = Date.now();
      for (;;) {
        findJob = getPreflightReplacementFindJob(record.findJobId!) ?? await getPersistedReplacementFindJob(record.findJobId!);
        const step = nextStepFromFindJob(findJob);
        if (step === "commit") break;
        if (step === "fail") {
          touch(record, {
            phase: "failed",
            error: String(findJob?.error ?? findJob?.message ?? "Replacement search failed — no eligible unit found."),
          });
          return;
        }
        if (Date.now() - waitStart > FIND_WAIT_CEILING_MS) {
          touch(record, { phase: "failed", error: "Replacement search did not finish in time." });
          return;
        }
        touch(record, { message: String(findJob?.message ?? "Searching…") });
        await new Promise((r) => setTimeout(r, FIND_POLL_INTERVAL_MS));
      }
    } else {
      findJob = getPreflightReplacementFindJob(record.findJobId!) ?? await getPersistedReplacementFindJob(record.findJobId!);
    }

    // Phase 2 — committing (auto-pick, 409s fall through to the next option).
    if (record.phase === "finding" || record.phase === "queued" || record.phase === "committing") {
      const units: Array<Record<string, unknown>> = Array.isArray(findJob?.units)
        ? findJob.units
        : findJob?.unit ? [findJob.unit] : [];
      const builder = getUnitBuilderByPropertyId(record.propertyId);
      const unit = builder?.units.find((u) => u.id === record.unitId);
      if (!builder || !unit) {
        touch(record, { phase: "failed", error: "Property/unit no longer resolvable for commit." });
        return;
      }
      touch(record, { phase: "committing", message: "Recording the swap and pulling the new unit's photos…" });
      let committed: { newUnitLabel: string; newAddress: string; photoFolder: string } | null = null;
      for (;;) {
        const candidate = pickCommitCandidate(units as Array<{ url?: unknown }>, record.attemptedUrls);
        if (!candidate) {
          touch(record, { phase: "failed", error: "Every found unit was rejected at commit (already used by another listing). Re-run the search." });
          return;
        }
        const c = candidate as Record<string, unknown>;
        const url = String(c.url ?? "");
        const { status, data } = await postLoopback("/api/unit-swaps", {
          // The route's fire-and-forget Guesty push is skipped here — this
          // orchestrator runs its OWN awaited push below so the dashboard
          // queue shows push progress and the completed message reports the
          // real outcome. Without the flag the same swap would push twice.
          skipGuestyPhotoPush: true,
          propertyId: record.propertyId,
          communityFolder: builder.communityPhotoFolder,
          oldUnitId: unit.id,
          oldUnitNumber: unit.unitNumber ?? "",
          oldBedrooms: unit.bedrooms,
          newAddress: String(c.address ?? ""),
          newUnitLabel: String(c.unitLabel ?? c.address ?? "Replacement unit"),
          newBedrooms: typeof c.bedrooms === "number" ? c.bedrooms : unit.bedrooms,
          newSourceUrl: url,
          thumbnailUrl: Array.isArray(c.photos) ? String((c.photos[0] as any)?.url ?? "") || null : null,
        }, 180_000);
        if (status === 409) {
          touch(record, { attemptedUrls: [...record.attemptedUrls, url], message: "Candidate already in use — trying the next option…" });
          continue;
        }
        if (status >= 400) {
          touch(record, { phase: "failed", error: String(data?.error ?? `Unit swap failed (HTTP ${status})`) });
          return;
        }
        committed = {
          newUnitLabel: String(data?.swap?.newUnitLabel ?? c.unitLabel ?? ""),
          newAddress: String(data?.swap?.newAddress ?? c.address ?? ""),
          photoFolder: String(data?.photoFolder ?? replacementPhotoFolderForUnit(record.propertyId, record.unitId)),
        };
        break;
      }

      // Phase 3 — verifying: kick both verification legs, best-effort.
      touch(record, {
        phase: "verifying",
        newUnitLabel: committed.newUnitLabel,
        newAddress: committed.newAddress,
        replacementFolder: committed.photoFolder,
        message: "Swap committed — verifying the new photos are clean and in-community…",
      });
      await postLoopback("/api/photo-listing-check/run", { folders: [committed.photoFolder] }, 30_000)
        .catch((e) => console.warn(`[auto-replace] verify rescan kick failed: ${e?.message ?? e}`));
      await postLoopback("/api/builder/bulk-photo-community-check", {
        propertyIds: [record.propertyId],
        labels: { [String(record.propertyId)]: record.propertyName },
      }, 30_000).catch((e) => console.warn(`[auto-replace] community check kick failed: ${e?.message ?? e}`));

      // Phase 3b — push the rebuilt gallery to Guesty (2026-07-05 operator
      // ask). The PUT replaces the listing's entire pictures[] array, so this
      // is what actually removes the OLD unit's duplicated photos from
      // Guesty (and, via its channel fan-out, from Airbnb/VRBO/Booking).
      // Awaited so the queue message reports the real outcome; a failure is
      // surfaced but does NOT fail the job — the swap itself is committed and
      // the builder's manual "Push Photos to Guesty" button remains the
      // fallback. The commit POST above passed skipGuestyPhotoPush so the
      // route's own fire-and-forget hook doesn't double-push.
      touch(record, {
        message: "Swap committed — pushing the new photos to Guesty (replaces the old unit's photos on the listing)…",
      });
      let guestyPushNote = "";
      try {
        const push = await repushGuestyPhotosForProperty(record.propertyId, {
          reason: `auto-replace ${record.jobId} (${record.unitLabel})`,
          waitForLabelsFolder: committed.photoFolder,
        });
        if (push.ok && !push.skipped) {
          guestyPushNote = ` ${push.successCount ?? 0} photos re-pushed to Guesty (old photos replaced).`;
        } else if (push.skipped === "no-guesty-mapping") {
          guestyPushNote = " No Guesty listing is mapped to this property, so there were no old photos to replace on Guesty.";
        } else if (push.skipped) {
          guestyPushNote = ` ⚠ Guesty photo push skipped (${push.skipped}).`;
        } else {
          guestyPushNote = ` ⚠ Guesty photo push failed (${push.error ?? "unknown error"}) — open the builder's Photos tab and use "Push Photos to Guesty".`;
        }
      } catch (e: any) {
        guestyPushNote = ` ⚠ Guesty photo push failed (${e?.message ?? e}) — open the builder's Photos tab and use "Push Photos to Guesty".`;
      }

      touch(record, {
        phase: "completed",
        message: `${record.unitLabel} now uses ${committed.newUnitLabel || committed.newAddress || "the new unit"} — OTA rescan + Claude-vision community check are running.${guestyPushNote}`,
        error: null,
      });
    }
  } catch (e: any) {
    touch(record, { phase: "failed", error: e?.message ?? "Auto replace failed" });
  } finally {
    activeJobIds.delete(record.jobId);
  }
}

export async function startAutoReplaceJob(input: {
  propertyId: number;
  unitId: string;
  unitLabel?: string;
}): Promise<{ ok: true; job: AutoReplaceJobRecord } | { ok: false; status: number; error: string }> {
  const propertyId = Number(input.propertyId);
  const unitId = String(input.unitId ?? "");
  const builder = Number.isFinite(propertyId) && propertyId > 0 ? getUnitBuilderByPropertyId(propertyId) : undefined;
  const unit = builder?.units.find((u) => u.id === unitId);
  if (!builder || !unit) return { ok: false, status: 400, error: "Unknown property/unit for auto replace" };

  // Double-tap guard — one active auto-replace per property+unit (memory + store).
  for (const existing of Array.from(jobs.values())) {
    if (existing.propertyId === propertyId && existing.unitId === unitId && isAutoReplacePhaseActive(existing.phase)) {
      return { ok: true, job: existing };
    }
  }
  const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY).catch(() => undefined);
  const persistedActive = findActiveAutoReplaceJob(parseAutoReplaceStore(raw ?? null), propertyId, unitId);
  if (persistedActive && !jobs.has(persistedActive.jobId)) {
    jobs.set(persistedActive.jobId, persistedActive);
    void runAutoReplaceJob(persistedActive);
    return { ok: true, job: persistedActive };
  }

  const unitIndex = builder.units.findIndex((u) => u.id === unitId);
  const record: AutoReplaceJobRecord = {
    jobId: `arj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    phase: "queued",
    propertyId,
    unitId,
    unitLabel: input.unitLabel
      || `Unit ${unitIndex >= 0 ? String.fromCharCode(65 + unitIndex) : "?"}${unit.unitNumber ? ` (${unit.unitNumber})` : ""}`,
    propertyName: builder.propertyName || builder.complexName,
    findJobId: null,
    attemptedUrls: [],
    newUnitLabel: null,
    newAddress: null,
    replacementFolder: null,
    message: "Queued",
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resumeCount: 0,
  };
  jobs.set(record.jobId, record);
  await mutateStore((store) => { store[record.jobId] = { ...record }; });
  void runAutoReplaceJob(record);
  return { ok: true, job: record };
}

// Queue for the dashboard chip: in-memory records win (freshest), persisted
// records fill in after a restart.
export async function listAutoReplaceJobs(): Promise<{ activeCount: number; jobs: AutoReplaceJobRecord[] }> {
  const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY).catch(() => undefined);
  const store = parseAutoReplaceStore(raw ?? null);
  for (const record of Array.from(jobs.values())) store[record.jobId] = record;
  return summarizeAutoReplaceQueue(store, Date.now());
}

// Operator "Clear queue": drop finished (and unresumably-stuck) records from
// memory AND the persisted store so the dashboard banner disappears. Jobs this
// process is actively running keep their records (clearableAutoReplaceJobIds
// protects them via activeJobIds).
export async function clearAutoReplaceQueue(): Promise<{ removed: number; activeCount: number; jobs: AutoReplaceJobRecord[] }> {
  const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY).catch(() => undefined);
  const store = parseAutoReplaceStore(raw ?? null);
  for (const record of Array.from(jobs.values())) store[record.jobId] = record;
  const removable = clearableAutoReplaceJobIds(store, Date.now(), activeJobIds);
  for (const jobId of removable) jobs.delete(jobId);
  await mutateStore((persisted) => {
    for (const jobId of removable) delete persisted[jobId];
  });
  const summary = await listAutoReplaceJobs();
  return { removed: removable.length, ...summary };
}

// Boot/interval watchdog — resume orphaned active jobs after a restart.
// Gate: AUTO_REPLACE_RESUME_DISABLED=1.
let resumeSweepInFlight = false;
export async function resumeOrphanedAutoReplaceJobs(): Promise<void> {
  if (resumeSweepInFlight) return;
  resumeSweepInFlight = true;
  try {
    const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY);
    const store = parseAutoReplaceStore(raw ?? null);
    for (const record of Object.values(store)) {
      if (!shouldResumeAutoReplaceJob(record, Date.now())) continue;
      if (jobs.has(record.jobId) || activeJobIds.has(record.jobId)) continue;
      console.warn(`[auto-replace] boot-resume: re-attaching orphaned job ${record.jobId} (phase ${record.phase}, resume ${record.resumeCount + 1})`);
      record.resumeCount += 1;
      jobs.set(record.jobId, record);
      void mutateStore((store2) => { store2[record.jobId] = { ...record }; });
      void runAutoReplaceJob(record);
    }
  } catch {
    // Fail-soft — next sweep retries.
  } finally {
    resumeSweepInFlight = false;
  }
}

export function startAutoReplaceResumeWatchdog(): void {
  if (/^(1|true|yes|on)$/i.test(String(process.env.AUTO_REPLACE_RESUME_DISABLED ?? "").trim())) {
    console.log("[auto-replace] resume watchdog disabled via AUTO_REPLACE_RESUME_DISABLED");
    return;
  }
  // Slightly after the replacement-find watchdog (20s) so a resumed find job
  // is already back in memory when the orchestrator re-attaches.
  setTimeout(() => void resumeOrphanedAutoReplaceJobs(), 25_000).unref?.();
  setInterval(() => void resumeOrphanedAutoReplaceJobs(), 2 * 60_000).unref?.();
}
