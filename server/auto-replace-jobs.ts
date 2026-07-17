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
import {
  latestUnitSwapsByUnit,
  replacementPhotoFolderForUnit,
  resolveActiveUnitPhotoFolders,
  unitSwapSnapshotForUnit,
} from "@shared/unit-swap-photos";
import { resolveCanonicalCommunityPhotoFolder } from "@shared/community-photo-folders";
import { resolveDraftUnitBedrooms } from "@shared/draft-unit-bedrooms";
import {
  AUTO_REPLACE_STORE_SETTING_KEY,
  AUTO_REPLACE_RUNNER_LEASE_MS,
  AUTO_REPLACE_UNIT_ID_MAX_LENGTH,
  MAX_AUTO_REPLACE_FIND_RESTARTS,
  MAX_AUTO_REPLACE_RETRIES,
  STUCK_AUTO_REPLACE_ERROR,
  clearableAutoReplaceJobIds,
  parseDraftUnitId,
  failStuckAutoReplaceRecords,
  findActiveAutoReplaceJob,
  isAutoReplacePhaseActive,
  isAutoReplaceRetryDue,
  isLegacyAutoReplaceFailureRetryable,
  newestAutoReplaceJobsByTarget,
  nextStepFromFindJob,
  parseAutoReplaceStore,
  photoListingHasPersistentPhotoFinding,
  planAutoReplaceRetry,
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
import { dbPool } from "./db";
import { storage } from "./storage";
import pg from "pg";
import type { PoolClient } from "pg";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

const FIND_POLL_INTERVAL_MS = 5_000;
// The exhaustive manual search can run long; the auto flow uses first-hit mode
// so ~45 min is a generous ceiling before declaring the find leg stuck.
const FIND_WAIT_CEILING_MS = 45 * 60 * 1000;
// Consecutive "restart" poll signals required before launching a fresh search
// (~15s at the poll interval) — a lone signal can be a store blip/write lag.
const RESTART_SIGNAL_CONFIRM_POLLS = 3;
const AUTO_REPLACE_RUNNER_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const AUTO_REPLACE_RUNNER_HEARTBEAT_MS = 30_000;

class AutoReplaceRunnerLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Auto-replace runner lease lost for ${jobId}`);
  }
}

const jobs = new Map<string, AutoReplaceJobRecord>();
const activeJobIds = new Set<string>();

let storeTail: Promise<void> = Promise.resolve();
async function mutateStoreTransaction(
  mutate: (store: Record<string, AutoReplaceJobRecord>, nowMs: number) => void,
): Promise<void> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    // Ensure the row exists before FOR UPDATE; concurrent first writers then
    // serialize on the primary-key conflict instead of both observing a gap.
    await client.query(
      `INSERT INTO app_settings ("key", "value", "updated_at") VALUES ($1, '{}', NOW()) ON CONFLICT ("key") DO NOTHING`,
      [AUTO_REPLACE_STORE_SETTING_KEY],
    );
    const locked = await client.query<{ value: string }>(
      `SELECT "value" FROM app_settings WHERE "key" = $1 FOR UPDATE`,
      [AUTO_REPLACE_STORE_SETTING_KEY],
    );
    const now = Date.now();
    const store = parseAutoReplaceStore(locked.rows[0]?.value ?? null);
    mutate(store, now);
    await client.query(
      `UPDATE app_settings SET "value" = $2, "updated_at" = NOW() WHERE "key" = $1`,
      [AUTO_REPLACE_STORE_SETTING_KEY, serializeAutoReplaceStore(store, now)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function enqueueStoreMutation(
  mutate: (store: Record<string, AutoReplaceJobRecord>, nowMs: number) => void,
  strict: boolean,
): Promise<void> {
  const attempt = storeTail.then(() => mutateStoreTransaction(mutate));
  // Keep the tail usable after one failed write; strict callers still receive
  // the original rejection and MUST NOT launch destructive work.
  storeTail = attempt.catch(() => undefined);
  return strict ? attempt : attempt.catch(() => undefined);
}

function mutateStore(mutate: (store: Record<string, AutoReplaceJobRecord>, nowMs: number) => void): Promise<void> {
  return enqueueStoreMutation(mutate, false);
}

function mutateStoreStrict(mutate: (store: Record<string, AutoReplaceJobRecord>, nowMs: number) => void): Promise<void> {
  return enqueueStoreMutation(mutate, true);
}

const AUTO_REPLACE_LOCK_NAMESPACE = 0x41524a;
type AutoReplaceTargetLock = { release: () => Promise<void> };
// Short-lived orchestration claims use a separately bounded pool so even a
// burst across many units cannot consume the application's query pool. These
// locks cover only validation + durable queue promotion, never external search
// or photo hydration.
const autoReplaceLockPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  application_name: "auto-replace-short-locks",
});
autoReplaceLockPool.on("error", (error) => {
  console.error(`[auto-replace] short-lock pool error: ${error?.message ?? error}`);
});

function autoReplaceTargetLockKey(propertyId: number, unitId: string): number {
  if (unitId.length > AUTO_REPLACE_UNIT_ID_MAX_LENGTH) {
    throw new Error("Auto-replace unit id is too long");
  }
  let hash = 0x811c9dc5;
  const value = `${propertyId}:${unitId}`;
  // The explicit ceiling is load-bearing for CodeQL's loop-bound analysis.
  // propertyId contributes at most 24 printable characters for a JS number.
  const bound = AUTO_REPLACE_UNIT_ID_MAX_LENGTH + 25;
  for (let i = 0; i < value.length && i < bound; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  }
  return hash | 0;
}

async function acquireAutoReplaceTargetLock(record: Pick<AutoReplaceJobRecord, "propertyId" | "unitId">): Promise<AutoReplaceTargetLock | null> {
  const client: PoolClient = await autoReplaceLockPool.connect();
  const targetKey = autoReplaceTargetLockKey(record.propertyId, record.unitId);
  try {
    const claimed = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
      [AUTO_REPLACE_LOCK_NAMESPACE, targetKey],
    );
    if (claimed.rows[0]?.acquired !== true) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [AUTO_REPLACE_LOCK_NAMESPACE, targetKey]);
      } finally {
        client.release();
      }
    },
  };
}

function touch(record: AutoReplaceJobRecord, patch: Partial<AutoReplaceJobRecord>): void {
  const now = Date.now();
  Object.assign(record, patch, {
    updatedAt: now,
    ...(record.runnerId === AUTO_REPLACE_RUNNER_ID
      ? { runnerLeaseUntil: now + AUTO_REPLACE_RUNNER_LEASE_MS }
      : {}),
  });
  jobs.set(record.jobId, record);
  const snapshot = { ...record, attemptedUrls: [...record.attemptedUrls] };
  void mutateStore((store) => {
    const current = store[record.jobId];
    if (snapshot.runnerId && current?.runnerId !== snapshot.runnerId) return;
    store[record.jobId] = snapshot;
  });
}

async function claimAutoReplaceRunner(record: AutoReplaceJobRecord, resuming: boolean): Promise<boolean> {
  let claimed: AutoReplaceJobRecord | null = null;
  await mutateStoreStrict((store, now) => {
    const current = store[record.jobId];
    if (!current || current.phase === "retry_wait" || !isAutoReplacePhaseActive(current.phase)) return;
    const authoritative = newestAutoReplaceJobsByTarget(Object.values(store))
      .find((candidate) => candidate.propertyId === current.propertyId && candidate.unitId === current.unitId);
    if (authoritative?.jobId !== current.jobId) return;
    if (current.runnerId
      && current.runnerId !== AUTO_REPLACE_RUNNER_ID
      && (current.runnerLeaseUntil ?? 0) > now) return;
    if (resuming && !shouldResumeAutoReplaceJob(current, now)) return;

    claimed = {
      ...current,
      resumeCount: current.resumeCount + (resuming ? 1 : 0),
      runnerId: AUTO_REPLACE_RUNNER_ID,
      runnerLeaseUntil: now + AUTO_REPLACE_RUNNER_LEASE_MS,
      updatedAt: now,
    };
    store[current.jobId] = claimed;
  });
  if (!claimed) return false;
  Object.assign(record, claimed);
  jobs.set(record.jobId, record);
  return true;
}

async function renewAutoReplaceRunnerLease(
  record: AutoReplaceJobRecord,
): Promise<"owned" | "lost" | "unavailable"> {
  let owned = false;
  let leaseUntil = 0;
  try {
    await mutateStoreStrict((store, now) => {
      const current = store[record.jobId];
      if (!current || current.runnerId !== AUTO_REPLACE_RUNNER_ID) return;
      const authoritative = newestAutoReplaceJobsByTarget(Object.values(store))
        .find((candidate) => candidate.propertyId === current.propertyId && candidate.unitId === current.unitId);
      if (authoritative?.jobId !== current.jobId) return;
      leaseUntil = now + AUTO_REPLACE_RUNNER_LEASE_MS;
      current.runnerLeaseUntil = leaseUntil;
      current.updatedAt = now;
      store[record.jobId] = current;
      owned = true;
    });
  } catch {
    return "unavailable";
  }
  if (!owned) return "lost";
  record.runnerLeaseUntil = leaseUntil;
  record.updatedAt = Date.now();
  jobs.set(record.jobId, record);
  return "owned";
}

async function releaseAutoReplaceRunnerLease(record: AutoReplaceJobRecord): Promise<void> {
  await mutateStore((store, now) => {
    const current = store[record.jobId];
    if (!current || current.runnerId !== AUTO_REPLACE_RUNNER_ID) return;
    current.runnerId = null;
    current.runnerLeaseUntil = null;
    current.updatedAt = now;
    store[record.jobId] = current;
    Object.assign(record, current);
  });
}

// Unified property/unit resolution — the one seam that makes the flow work for
// BOTH the 11 hardcoded builder properties (positive ids, unit-builder-data)
// and promoted community drafts (negative ids, community_drafts rows). Draft
// unit ids follow adapt-draft.ts's `draft<id>-unit-a/b`; the community folder
// mirrors its canonical-name resolution so the find job's community gates see
// the same folder the builder UI uses. 2026-07-05: draft rows in the
// duplicate-photos popup previously had NO replace path at all.
type AutoReplaceTarget = {
  isDraft: boolean;
  communityFolder: string;
  communityName: string;
  propertyName: string;
  address: string;
  street?: string;
  city?: string;
  state?: string;
  unit: { id: string; unitNumber: string; bedrooms: number; photoFolder: string | null };
  unitIndex: number;
};

async function resolveAutoReplaceTarget(propertyId: number, unitId: string): Promise<AutoReplaceTarget | null> {
  if (Number.isFinite(propertyId) && propertyId > 0) {
    const builder = getUnitBuilderByPropertyId(propertyId);
    if (!builder?.communityPhotoFolder) return null;
    const index = builder.units.findIndex((u) => u.id === unitId);
    if (index < 0) return null;
    const unit = builder.units[index];
    const parsed = parseStreetCityState(builder.address ?? "");
    return {
      isDraft: false,
      communityFolder: builder.communityPhotoFolder,
      communityName: builder.complexName,
      propertyName: builder.propertyName || builder.complexName,
      address: builder.address ?? "",
      street: parsed.street || undefined,
      city: parsed.city || undefined,
      state: parsed.state || undefined,
      unit: {
        id: unit.id,
        unitNumber: unit.unitNumber ?? "",
        bedrooms: unit.bedrooms,
        photoFolder: unit.photoFolder ?? null,
      },
      unitIndex: index,
    };
  }
  if (!Number.isFinite(propertyId) || propertyId >= 0) return null;
  const ref = parseDraftUnitId(unitId);
  if (!ref || ref.draftId !== -propertyId) return null;
  const draft = await storage.getCommunityDraft(ref.draftId);
  if (!draft) return null;
  if (ref.slot === "b" && (draft as any).singleListing === true) return null;
  const bedrooms = resolveDraftUnitBedrooms(draft as any, ref.slot === "a" ? "unit1" : "unit2");
  if (!bedrooms) return null;
  const street = (draft as any).streetAddress ?? "";
  return {
    isDraft: true,
    communityFolder: resolveCanonicalCommunityPhotoFolder(draft.name) ?? `community-draft-${ref.draftId}`,
    communityName: draft.name,
    propertyName: draft.name,
    address: [street, draft.city, draft.state].filter(Boolean).join(", "),
    street: street || undefined,
    city: draft.city || undefined,
    state: draft.state || undefined,
    unit: {
      id: unitId,
      unitNumber: ref.slot.toUpperCase(),
      bedrooms,
      photoFolder: ref.slot === "a"
        ? (draft.unit1PhotoFolder ?? `draft-${ref.draftId}-unit-a`)
        : (draft.unit2PhotoFolder ?? `draft-${ref.draftId}-unit-b`),
    },
    unitIndex: ref.slot === "a" ? 0 : 1,
  };
}

type AutoReplaceTargetContext = { photoFolder: string | null; unitSwapSnapshot: string };

async function currentTargetContextForRecord(
  record: Pick<AutoReplaceJobRecord, "propertyId" | "unitId">,
): Promise<AutoReplaceTargetContext | null> {
  const target = await resolveAutoReplaceTarget(record.propertyId, record.unitId);
  if (!target) return null;
  const swaps = await storage.getUnitSwaps(record.propertyId);
  const unitSwapSnapshot = unitSwapSnapshotForUnit(swaps, record.unitId);
  if (target.isDraft) return { photoFolder: target.unit.photoFolder, unitSwapSnapshot };
  const photoFolder = resolveActiveUnitPhotoFolders(record.propertyId, [target.unit], swaps)[0]?.activeFolder
    ?? target.unit.photoFolder;
  return { photoFolder, unitSwapSnapshot };
}

async function folderStillHasPhotoFinding(folder: string | null): Promise<boolean> {
  if (!folder) return false;
  const row = await storage.getPhotoListingCheckByFolder(folder);
  return photoListingHasPersistentPhotoFinding(row);
}

async function targetStillMatchesScheduledSnapshot(record: AutoReplaceJobRecord): Promise<boolean> {
  // Legacy in-flight records predate snapshot capture. Their original resume
  // behavior stays intact; legacy FAILED records capture a snapshot before
  // entering retry_wait.
  if (record.retryUnitSwapSnapshot == null) return true;
  const current = await currentTargetContextForRecord(record);
  if (!current || current.unitSwapSnapshot !== record.retryUnitSwapSnapshot) return false;
  return !record.retryPhotoFolder || current.photoFolder === record.retryPhotoFolder;
}

async function finishAutoReplaceFailure(
  record: AutoReplaceJobRecord,
  error: string,
  opts: { retryablePreCommit?: boolean } = {},
): Promise<void> {
  const previous = { ...record, attemptedUrls: [...record.attemptedUrls] };
  const expectedRunnerId = record.runnerId === AUTO_REPLACE_RUNNER_ID
    ? AUTO_REPLACE_RUNNER_ID
    : undefined;
  if (opts.retryablePreCommit) {
    const retry = planAutoReplaceRetry(record, error, Date.now());
    if (retry) {
      console.warn(
        `[auto-replace] ${record.jobId}: safe pre-commit failure; ${retry.message} (${error})`,
      );
      Object.assign(record, retry);
      try {
        await persistAutoReplaceRecord(record, { strict: true, expectedRunnerId });
      } catch (persistError) {
        Object.assign(record, previous);
        throw persistError;
      }
      return;
    }
    if (record.retryPhotoFolder && record.autoRetryCount >= MAX_AUTO_REPLACE_RETRIES) {
      error = `${error} Automatic retry limit (${MAX_AUTO_REPLACE_RETRIES}) reached.`;
    }
  }
  Object.assign(record, {
    phase: "failed",
    nextRetryAt: null,
    runnerId: null,
    runnerLeaseUntil: null,
    error,
    updatedAt: Date.now(),
  });
  try {
    await persistAutoReplaceRecord(record, { strict: true, expectedRunnerId });
  } catch (persistError) {
    Object.assign(record, previous);
    throw persistError;
  }
}

// The same find payload the manual dialog assembles (builder-preflight parity):
// parsed display address + inferred community street + existing swaps' source
// URLs as skipUrls. First-hit mode (no collectAllOptions) — the auto flow
// commits the first viable unit, so exhaustive pool-draining is wasted time.
async function assembleFindPayload(propertyId: number, unitId: string, extraSkipUrls: string[] = []): Promise<Record<string, unknown> | null> {
  const target = await resolveAutoReplaceTarget(propertyId, unitId);
  if (!target) return null;
  const streetAddress = inferCommunityStreetAddress({
    communityName: target.communityName,
    city: target.city,
    state: target.state,
    addressHint: target.street || target.address,
  }) || target.street;
  const swaps = latestUnitSwapsByUnit(await storage.getUnitSwaps(propertyId).catch(() => []));
  const skipUrls = Array.from(new Set([
    ...Array.from(swaps.values()).map((s: any) => String(s?.newSourceUrl ?? "")).filter(Boolean),
    // Commit-burned URLs (409 in-use / bot-walled gallery / coverage-short) —
    // a coverage-exhaustion RESTART must not re-find the gallery it just
    // refused to commit.
    ...extraSkipUrls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)),
  ]));
  return {
    communityFolder: target.communityFolder,
    communityName: target.communityName,
    propertyAddress: target.address,
    streetAddress: streetAddress || undefined,
    city: target.city || undefined,
    state: target.state || undefined,
    propertyId,
    targetUnitId: target.unit.id,
    requiredBedrooms: target.unit.bedrooms,
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

async function patchLoopback(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: any }> {
  const resp = await fetch(`${loopbackBaseUrl()}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function runAutoReplaceJob(
  record: AutoReplaceJobRecord,
  opts: { resuming?: boolean } = {},
): Promise<void> {
  // retry_wait is promoted only by the watchdog after its due time and a
  // fresh persisted-photo-status check. No other caller may start it early.
  if (record.phase === "retry_wait") {
    return;
  }
  if (activeJobIds.has(record.jobId)) {
    return;
  }
  let claimed = false;
  try {
    claimed = await claimAutoReplaceRunner(record, opts.resuming === true);
  } catch (error: any) {
    console.warn(`[auto-replace] ${record.jobId}: runner claim failed: ${error?.message ?? error}`);
    return;
  }
  if (!claimed) return;

  activeJobIds.add(record.jobId);
  if (opts.resuming) {
    console.warn(`[auto-replace] boot-resume: claimed orphaned job ${record.jobId} (phase ${record.phase}, resume ${record.resumeCount})`);
  }
  let leaseLost = false;
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || leaseLost) return;
    heartbeatBusy = true;
    void renewAutoReplaceRunnerLease(record)
      .then((status) => { if (status === "lost") leaseLost = true; })
      .finally(() => { heartbeatBusy = false; });
  }, AUTO_REPLACE_RUNNER_HEARTBEAT_MS);
  heartbeat.unref?.();

  const confirmRunnerLease = async (): Promise<boolean> => {
    if (leaseLost) return false;
    const status = await renewAutoReplaceRunnerLease(record);
    if (status === "lost") leaseLost = true;
    if (status === "unavailable") {
      console.warn(`[auto-replace] ${record.jobId}: runner lease could not be verified; deferring before commit`);
    }
    return status === "owned";
  };
  try {
    if (record.phase === "queued" || record.phase === "finding") {
      let targetMatches: boolean;
      try {
        targetMatches = await targetStillMatchesScheduledSnapshot(record);
      } catch (error: any) {
        await finishAutoReplaceFailure(
          record,
          `Could not verify the unit's current swap state (${error?.message ?? error}).`,
          { retryablePreCommit: true },
        );
        return;
      }
      if (!targetMatches) {
        await finishAutoReplaceFailure(
          record,
          "The unit or its pending swap changed while this replacement was queued — automatic work stopped to preserve the newer choice.",
        );
        return;
      }
    }
    // Resumed mid-"verifying": the swap is already COMMITTED (newUnitLabel /
    // replacementFolder were persisted in the same touch that flipped the
    // phase) — never re-commit; just re-kick the idempotent verification legs
    // + Guesty push and land. Without this, a job killed during the verify /
    // push leg re-attached into a phase no block handled and sat "verifying"
    // forever.
    if (record.phase === "verifying") {
      await runAutoReplaceVerifyPhase(record, {
        newUnitLabel: record.newUnitLabel ?? "",
        newAddress: record.newAddress ?? "",
        photoFolder: record.replacementFolder || replacementPhotoFolderForUnit(record.propertyId, record.unitId),
      });
      return;
    }

    // Phases 1+2 run inside a bounded outer loop: a commit pass that burns
    // EVERY found option on bedroom-photo coverage re-enters the find phase
    // with the burned URLs excluded (first-hit finds can return a pool of
    // ONE — the live Ilikai re-run burned its single candidate and had
    // nothing left to try). Bounded by the same MAX_AUTO_REPLACE_FIND_RESTARTS
    // budget the deploy-burst restarts use.
    findCommit: for (;;) {
    // Phase 1 — finding. Restart-tolerant: a find job that vanished or died
    // unresumably (killed by a deploy burst — the 2026-07-05 Pili Mai
    // incident) gets a bounded number of FRESH searches instead of the old
    // misleading "no eligible unit found" failure.
    let findJob: any = null;
    if (record.phase === "queued" || record.phase === "finding" || !record.findJobId) {
      const waitStart = Date.now();
      // A single "restart" signal can be a store-write lag racing this poll —
      // require a few consecutive signals before burning a bounded fresh
      // search (each one is a full SearchAPI sweep).
      let restartSignals = 0;
      for (;;) {
        if (leaseLost) return;
        if (!record.findJobId) {
          const payload = await assembleFindPayload(record.propertyId, record.unitId, record.attemptedUrls);
          if (!payload) {
            await finishAutoReplaceFailure(record, "Could not resolve this property/unit for a replacement search.");
            return;
          }
          const started = startPreflightReplacementFindJob(payload);
          touch(record, {
            phase: "finding",
            findJobId: started.id,
            message: `Searching ${String(payload.communityName ?? "the community")} for a clean ${String(payload.requiredBedrooms ?? "?")}BR unit…`,
          });
        } else if (record.phase === "queued") {
          touch(record, { phase: "finding" });
        }
        findJob = getPreflightReplacementFindJob(record.findJobId!) ?? await getPersistedReplacementFindJob(record.findJobId!);
        const step = nextStepFromFindJob(findJob);
        if (step !== "restart") restartSignals = 0;
        if (step === "commit") break;
        if (step === "restart" && ++restartSignals >= RESTART_SIGNAL_CONFIRM_POLLS) {
          restartSignals = 0;
          if (record.findRestarts >= MAX_AUTO_REPLACE_FIND_RESTARTS) {
            await finishAutoReplaceFailure(record, STUCK_AUTO_REPLACE_ERROR, { retryablePreCommit: true });
            return;
          }
          console.warn(`[auto-replace] find job ${record.findJobId} died unresumably — starting a fresh search (restart ${record.findRestarts + 1}/${MAX_AUTO_REPLACE_FIND_RESTARTS})`);
          touch(record, {
            findJobId: null,
            findRestarts: record.findRestarts + 1,
            message: "The search was interrupted by a server restart — starting a fresh search…",
          });
          continue;
        }
        if (step === "fail") {
          await finishAutoReplaceFailure(
            record,
            String(findJob?.error ?? findJob?.message ?? "Replacement search failed — no eligible unit found."),
            { retryablePreCommit: true },
          );
          return;
        }
        if (Date.now() - waitStart > FIND_WAIT_CEILING_MS) {
          await finishAutoReplaceFailure(record, "Replacement search did not finish in time.", { retryablePreCommit: true });
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
      const target = await resolveAutoReplaceTarget(record.propertyId, record.unitId);
      if (!target) {
        await finishAutoReplaceFailure(record, "Property/unit no longer resolvable for commit.");
        return;
      }
      const unit = target.unit;
      touch(record, { phase: "committing", message: "Recording the swap and pulling the new unit's photos…" });
      let committed: { newUnitLabel: string; newAddress: string; photoFolder: string } | null = null;
      // Per-reason burn counts so the all-burned failure message reports what
      // ACTUALLY happened — a photo-hydration burn used to read as "already
      // used by another listing" (Makahuena 2026-07-06: the single found
      // unit's gallery was gone, but the failure blamed a duplicate).
      let burnedInUse = 0;
      let burnedPhotos = 0;
      let burnedCoverage = 0;
      for (;;) {
        const candidate = pickCommitCandidate(units as Array<{ url?: unknown }>, record.attemptedUrls);
        if (!candidate) {
          // Coverage burns exhausted the pool — widen it instead of failing:
          // re-enter the find phase with every burned URL excluded, on the
          // same bounded restart budget the deploy-burst path uses. Only for
          // coverage burns: an all-409/bot-wall exhaustion means the pool
          // itself is bad and a fresh first-hit search would refind it.
          if (burnedCoverage > 0 && record.findRestarts < MAX_AUTO_REPLACE_FIND_RESTARTS) {
            console.warn(`[auto-replace] ${record.jobId}: all ${burnedCoverage + burnedInUse + burnedPhotos} option(s) burned (${burnedCoverage} on bedroom coverage) — searching for more candidates (restart ${record.findRestarts + 1}/${MAX_AUTO_REPLACE_FIND_RESTARTS})`);
            touch(record, {
              phase: "finding",
              findJobId: null,
              findRestarts: record.findRestarts + 1,
              message: "Every found gallery photographed too few bedrooms — searching for more candidates (burned galleries excluded)…",
            });
            continue findCommit;
          }
          const reasons = [
            burnedInUse > 0 ? `${burnedInUse} already used by another listing` : null,
            burnedPhotos > 0 ? `${burnedPhotos} had a gallery that could not be scraped (bot-walled or photos taken down)` : null,
            burnedCoverage > 0 ? `${burnedCoverage} photographed fewer bedrooms than the unit claims (the audit needs every bedroom in the gallery)` : null,
          ].filter(Boolean).join("; ");
          await finishAutoReplaceFailure(
            record,
            units.length === 0
              // Resumed mid-commit but the find results are gone (store evicted
              // >24h later) — the search never said "no units", so don't claim it.
              ? "The search results were lost in a server restart — click Replace photos to run a fresh search."
              : `Every found option failed at commit${reasons ? ` (${reasons})` : ""}. Re-run the search.`,
            { retryablePreCommit: true },
          );
          return;
        }
        const c = candidate as Record<string, unknown>;
        const url = String(c.url ?? "");
        if (!(await confirmRunnerLease())) return;
        let targetMatches: boolean;
        try {
          targetMatches = await targetStillMatchesScheduledSnapshot(record);
        } catch (error: any) {
          await finishAutoReplaceFailure(
            record,
            `Could not verify the unit's current swap state before commit (${error?.message ?? error}).`,
            { retryablePreCommit: true },
          );
          return;
        }
        if (!targetMatches) {
          await finishAutoReplaceFailure(
            record,
            "The unit or its pending swap changed while the replacement search was running — commit stopped to preserve the newer choice.",
          );
          return;
        }
        const { status, data } = await postLoopback("/api/unit-swaps", {
          // The route's fire-and-forget Guesty push is skipped here — this
          // orchestrator runs its OWN awaited push below so the dashboard
          // queue shows push progress and the completed message reports the
          // real outcome. Without the flag the same swap would push twice.
          skipGuestyPhotoPush: true,
          propertyId: record.propertyId,
          communityFolder: target.communityFolder,
          oldUnitId: unit.id,
          oldUnitNumber: unit.unitNumber ?? "",
          oldBedrooms: unit.bedrooms,
          newAddress: String(c.address ?? ""),
          newUnitLabel: String(c.unitLabel ?? c.address ?? "Replacement unit"),
          newBedrooms: typeof c.bedrooms === "number" ? c.bedrooms : unit.bedrooms,
          newSourceUrl: url,
          thumbnailUrl: Array.isArray(c.photos) ? String((c.photos[0] as any)?.url ?? "") || null : null,
          // The find phase's scraped gallery — hydration's fallback when the
          // commit-time re-scrape hits a bot-wall/quota outage (all scrape
          // tiers can degrade at once; the find already proved this gallery).
          // Prefer the unit's photoUrls field (the FULL proven gallery,
          // 2026-07-15); c.photos is only the SERP display thumbnail — often
          // a base64 data: URI that the https filter drops, which left this
          // fallback permanently EMPTY on the find-unit path (the Poipu
          // Kapili unit-B burn class).
          photoUrls: Array.isArray(c.photoUrls) && c.photoUrls.length > 0
            ? (c.photoUrls as unknown[]).map((u) => String(u ?? "")).filter((u) => /^https?:\/\//i.test(u)).slice(0, 120)
            : Array.isArray(c.photos)
              ? (c.photos as Array<{ url?: unknown }>).map((p) => String(p?.url ?? "")).filter((u) => /^https?:\/\//i.test(u))
              : [],
          // Re-checked transactionally by POST /api/unit-swaps AFTER photo
          // hydration and immediately before INSERT. A newer manual choice
          // therefore wins even if it lands during the long scrape.
          expectedUnitSwapSnapshot: record.retryUnitSwapSnapshot,
          // Bedroom-shortfall replacements (audit ladder): the route aborts
          // the commit at staging when the new gallery photographs fewer
          // bedrooms than the unit claims — burned below as coverageShort.
          requireBedroomPhotoCoverage: record.requireBedroomPhotoCoverage === true,
        }, 300_000); // hydration may use the bounded 90s sidecar scrape tier
        if (leaseLost) return;
        if (status === 409 && data?.targetChanged === true) {
          await finishAutoReplaceFailure(
            record,
            String(data?.error ?? "The unit's swap history changed before commit — automatic work stopped to preserve the newer choice."),
          );
          return;
        }
        if (status === 409) {
          burnedInUse += 1;
          touch(record, { attemptedUrls: [...record.attemptedUrls, url], message: "Candidate already in use — trying the next option…" });
          continue;
        }
        // 502 from this route = photo hydration failed for THIS candidate
        // (bot-walled gallery / photos taken down since the find phase / the
        // bedroom-coverage gate rejected the gallery) — a candidate-level
        // problem, not a job-level one. Burn the URL and try the next option
        // (the Pili Mai 9K case: option 1's Redfin gallery came back empty
        // while option 2 scraped fine).
        if (status === 502 && (data?.coverageShort === true || /photo/i.test(String(data?.error ?? "")))) {
          // A resolver-proof "bedroom-mismatch:N-vs-M" reject is a COVERAGE
          // problem (the gallery photographs fewer bedrooms than the unit
          // needs), not a scrape failure — bucketing it as "could not be
          // scraped" sent the 2026-07-15 Poipu Kapili diagnosis chasing
          // bot-walls when the pipeline had the photos all along.
          const coverageReject = data?.coverageShort === true
            || /bedroom-mismatch/i.test(String(data?.error ?? ""));
          if (coverageReject) burnedCoverage += 1;
          else burnedPhotos += 1;
          touch(record, {
            attemptedUrls: [...record.attemptedUrls, url],
            message: coverageReject
              ? "Candidate's gallery photographs too few bedrooms — trying the next option…"
              : "Candidate's photos could not be scraped — trying the next option…",
          });
          continue;
        }
        if (status >= 400) {
          // The route returned outside the explicitly pre-commit 409/502
          // candidate rejects above. The commit may be ambiguous; never stack
          // an automatic second swap on top of it.
          await finishAutoReplaceFailure(record, String(data?.error ?? `Unit swap failed (HTTP ${status})`));
          return;
        }
        committed = {
          newUnitLabel: String(data?.swap?.newUnitLabel ?? c.unitLabel ?? ""),
          newAddress: String(data?.swap?.newAddress ?? c.address ?? ""),
          photoFolder: String(data?.photoFolder ?? replacementPhotoFolderForUnit(record.propertyId, record.unitId)),
        };
        // Promoted drafts persist photos under unit{1,2}PhotoFolder — repoint
        // the draft at the replacement folder + the new unit's identity NOW
        // (one-click semantics; same PATCH as builder-preflight's "Commit
        // Replacements & Continue", but SCOPED to this unit so a sibling
        // unit's abandoned preflight pick is never silently committed).
        // Without it the dashboard, scanner, and Guesty push keep reading the
        // OLD folder/unit.
        if (target.isDraft) {
          const repoint = await patchLoopback(`/api/unit-swaps/commit/${record.propertyId}`, { oldUnitId: record.unitId }, 30_000)
            .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
          if (repoint.status >= 400) {
            await finishAutoReplaceFailure(
              record,
              `The swap was recorded but the draft could not be repointed at the new unit (HTTP ${repoint.status}) — open builder pre-flight and use "Commit Replacements & Continue".`,
            );
            return;
          }
        }
        break;
      }

      // Phase 3 — verifying (shared with the resumed-mid-verifying path).
      await runAutoReplaceVerifyPhase(record, committed);
    }
    break;
    } // findCommit
  } catch (e: any) {
    // Another Railway instance reclaimed the job after this runner's lease
    // expired. The winner is now authoritative; the loser must not rewrite
    // its phase or error receipt.
    if (e instanceof AutoReplaceRunnerLeaseLostError) return;
    // A verifying record is already past the destructive swap boundary. If
    // its final durable write failed, keep it resumable so the watchdog can
    // repeat the idempotent verification/push leg instead of falsely marking
    // the committed swap as a generic failure.
    if (record.phase === "verifying" && record.replacementFolder) {
      console.error(`[auto-replace] ${record.jobId}: verify completion was not persisted; leaving it resumable: ${e?.message ?? e}`);
      return;
    }
    try {
      await finishAutoReplaceFailure(record, e?.message ?? "Auto replace failed", {
        // A thrown request while committing may have crossed the write boundary
        // before the response was lost. Finding/queued failures are pre-commit.
        retryablePreCommit: record.phase === "queued" || record.phase === "finding",
      });
    } catch (persistError: any) {
      console.error(`[auto-replace] ${record.jobId}: could not persist failure state: ${persistError?.message ?? persistError}`);
    }
  } finally {
    clearInterval(heartbeat);
    activeJobIds.delete(record.jobId);
    await releaseAutoReplaceRunnerLease(record);
  }
}

// Phase 3 — verifying: kick both verification legs (best-effort) + the awaited
// Guesty photo push, then complete. Also the resume entry point for a job
// killed mid-verify: every leg is safe to re-run (rescan + community check are
// re-kicks; the Guesty push PUTs the full pictures[] array idempotently).
async function runAutoReplaceVerifyPhase(
  record: AutoReplaceJobRecord,
  committed: { newUnitLabel: string; newAddress: string; photoFolder: string },
): Promise<void> {
  touch(record, {
    phase: "verifying",
    newUnitLabel: committed.newUnitLabel || record.newUnitLabel,
    newAddress: committed.newAddress || record.newAddress,
    replacementFolder: committed.photoFolder,
    message: "Swap committed — verifying the new photos are clean and in-community…",
  });
  // Track the kick outcome — an HTTP failure here (e.g. the folder rejected
  // as unscannable) must surface in the completed message, not silently read
  // as "rescan is running".
  let rescanKickNote = "";
  await postLoopback("/api/photo-listing-check/run", { folders: [committed.photoFolder] }, 30_000)
    .then(({ status, data }) => {
      if (status >= 400) {
        rescanKickNote = ` ⚠ OTA rescan did not start (${String((data as any)?.error ?? `HTTP ${status}`)}) — use "Rescan again" on the row.`;
        console.warn(`[auto-replace] verify rescan kick rejected (${status}) for ${committed.photoFolder}`);
      }
    })
    .catch((e) => {
      rescanKickNote = " ⚠ OTA rescan did not start (request failed) — use \"Rescan again\" on the row.";
      console.warn(`[auto-replace] verify rescan kick failed: ${e?.message ?? e}`);
    });
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
  // fallback. The commit POST passed skipGuestyPhotoPush so the route's
  // own fire-and-forget hook doesn't double-push.
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

  const expectedRunnerId = record.runnerId === AUTO_REPLACE_RUNNER_ID
    ? AUTO_REPLACE_RUNNER_ID
    : undefined;
  const previous = { ...record, attemptedUrls: [...record.attemptedUrls] };
  Object.assign(record, {
    phase: "completed",
    message: `${record.unitLabel} now uses ${committed.newUnitLabel || record.newUnitLabel || committed.newAddress || "the new unit"} — OTA rescan + Claude-vision community check are running.${rescanKickNote}${guestyPushNote}`,
    error: null,
    runnerId: null,
    runnerLeaseUntil: null,
    updatedAt: Date.now(),
  });
  try {
    await persistAutoReplaceRecord(record, { strict: true, expectedRunnerId });
  } catch (error) {
    Object.assign(record, previous);
    throw error;
  }
}

export async function startAutoReplaceJob(input: {
  propertyId: number;
  unitId: string;
  unitLabel?: string;
  // Audit-ladder bedroom-shortfall replacements: require the NEW gallery to
  // photograph every claimed bedroom (commit aborts at staging + burns the
  // candidate otherwise). See AutoReplaceJobRecord.requireBedroomPhotoCoverage.
  requireBedroomPhotoCoverage?: boolean;
}): Promise<{ ok: true; job: AutoReplaceJobRecord } | { ok: false; status: number; error: string }> {
  const propertyId = Number(input.propertyId);
  const unitId = String(input.unitId ?? "");
  if (unitId.length > AUTO_REPLACE_UNIT_ID_MAX_LENGTH) {
    return { ok: false, status: 400, error: "Invalid unit id" };
  }
  // Resolves BOTH builder properties (positive ids) and promoted drafts
  // (negative ids, `draft<id>-unit-a/b`).
  const target = await resolveAutoReplaceTarget(propertyId, unitId);
  if (!target) return { ok: false, status: 400, error: "Unknown property/unit for auto replace" };

  // Double-tap guard — merge memory with the shared store, but keep the
  // freshest version of each job. A newer terminal receipt must be able to
  // supersede an older in-memory active receipt during a rolling deploy.
  const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY).catch(() => undefined);
  const combinedStore = parseAutoReplaceStore(raw ?? null);
  for (const local of Array.from(jobs.values())) {
    const persisted = combinedStore[local.jobId];
    if (!persisted || (local.updatedAt || local.createdAt) >= (persisted.updatedAt || persisted.createdAt)) {
      combinedStore[local.jobId] = local;
    }
  }
  const persistedActive = findActiveAutoReplaceJob(combinedStore, propertyId, unitId);
  if (persistedActive) {
    if (!jobs.has(persistedActive.jobId)) jobs.set(persistedActive.jobId, persistedActive);
    // A cross-instance double-tap only returns the shared receipt. The runner
    // lease/watchdog owns execution; an API request must never duplicate it.
    return { ok: true, job: persistedActive };
  }

  let targetLock: AutoReplaceTargetLock | null;
  try {
    targetLock = await acquireAutoReplaceTargetLock({ propertyId, unitId });
  } catch {
    return { ok: false, status: 503, error: "Could not lock this unit for replacement safely — please retry." };
  }
  if (!targetLock) {
    // A concurrent instance may have persisted between the first read and the
    // advisory-lock attempt. Return that shared record when possible; never
    // create a second job merely because its first write is still in flight.
    const latestRaw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY).catch(() => undefined);
    const latestActive = findActiveAutoReplaceJob(parseAutoReplaceStore(latestRaw ?? null), propertyId, unitId);
    if (latestActive) return { ok: true, job: latestActive };
    return { ok: false, status: 409, error: "A replacement job for this unit is already starting — please wait a moment." };
  }

  try {
    // Re-read after taking the cross-instance lock. This is the authoritative
    // double-tap check for rolling Railway deployments.
    let lockedRaw: string | undefined;
    try {
      lockedRaw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY);
    } catch {
      return { ok: false, status: 503, error: "Could not verify the replacement queue safely — please retry." };
    }
    const lockedActive = findActiveAutoReplaceJob(parseAutoReplaceStore(lockedRaw ?? null), propertyId, unitId);
    if (lockedActive) {
      jobs.set(lockedActive.jobId, lockedActive);
      return { ok: true, job: lockedActive };
    }

    let targetContext: AutoReplaceTargetContext | null;
    try {
      targetContext = await currentTargetContextForRecord({ propertyId, unitId });
    } catch {
      return { ok: false, status: 503, error: "Could not read the unit's current swap state safely — please retry." };
    }
    if (!targetContext) {
      return { ok: false, status: 503, error: "Could not capture the unit's current swap state safely — please retry." };
    }
    let retryPhotoFolder: string | null;
    try {
      retryPhotoFolder = await folderStillHasPhotoFinding(targetContext.photoFolder)
        ? targetContext.photoFolder
        : null;
    } catch {
      return { ok: false, status: 503, error: "Could not read the latest OTA photo check safely — please retry." };
    }

    const letter = String.fromCharCode(65 + Math.max(0, target.unitIndex));
    const numberSuffix = target.unit.unitNumber && target.unit.unitNumber !== letter
      ? ` (${target.unit.unitNumber})`
      : "";
    const record: AutoReplaceJobRecord = {
      jobId: `arj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      phase: "queued",
      propertyId,
      unitId,
      unitLabel: input.unitLabel || `Unit ${letter}${numberSuffix}`,
      propertyName: target.propertyName,
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
      findRestarts: 0,
      requireBedroomPhotoCoverage: input.requireBedroomPhotoCoverage === true,
      retryPhotoFolder,
      retryUnitSwapSnapshot: targetContext.unitSwapSnapshot,
      runnerId: null,
      runnerLeaseUntil: null,
      autoRetryCount: 0,
      nextRetryAt: null,
    };
    try {
      await persistAutoReplaceRecord(record, { strict: true });
    } catch {
      return { ok: false, status: 503, error: "Could not persist the replacement job safely — please retry." };
    }
    void runAutoReplaceJob(record);
    return { ok: true, job: record };
  } finally {
    await targetLock.release().catch(() => undefined);
  }
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

async function persistAutoReplaceRecord(
  record: AutoReplaceJobRecord,
  opts: { strict?: boolean; expectedRunnerId?: string } = {},
): Promise<void> {
  const snapshot = { ...record, attemptedUrls: [...record.attemptedUrls] };
  if (opts.strict) {
    let accepted = false;
    await mutateStoreStrict((store) => {
      if (opts.expectedRunnerId && store[record.jobId]?.runnerId !== opts.expectedRunnerId) return;
      store[record.jobId] = snapshot;
      accepted = true;
    });
    if (!accepted) throw new AutoReplaceRunnerLeaseLostError(record.jobId);
    jobs.set(record.jobId, record);
    return;
  }
  jobs.set(record.jobId, record);
  await mutateStore((store) => {
    if (opts.expectedRunnerId && store[record.jobId]?.runnerId !== opts.expectedRunnerId) return;
    store[record.jobId] = snapshot;
  });
}

async function scheduleLegacyAutoReplaceRetry(record: AutoReplaceJobRecord, nowMs: number): Promise<boolean> {
  if (!isLegacyAutoReplaceFailureRetryable(record, nowMs)) return false;
  const targetLock = await acquireAutoReplaceTargetLock(record).catch(() => null);
  if (!targetLock) return false;
  try {
    const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY);
    const liveStore = parseAutoReplaceStore(raw ?? null);
    const current = liveStore[record.jobId];
    const authoritative = newestAutoReplaceJobsByTarget(Object.values(liveStore))
      .find((candidate) => candidate.propertyId === record.propertyId && candidate.unitId === record.unitId);
    if (!current || authoritative?.jobId !== record.jobId || !isLegacyAutoReplaceFailureRetryable(current, nowMs)) {
      return false;
    }
    Object.assign(record, current);

    const context = await currentTargetContextForRecord(record);
    // Legacy receipts never captured their original generation. Requiring no
    // swap is conservative but essential: otherwise a manual choice made
    // after the old failure becomes the retry's adopted baseline.
    if (!context?.photoFolder || context.unitSwapSnapshot !== "none"
      || !(await folderStillHasPhotoFinding(context.photoFolder))) return false;
    const previous = { ...record };
    record.retryPhotoFolder = context.photoFolder;
    record.retryUnitSwapSnapshot = context.unitSwapSnapshot;
    const retry = planAutoReplaceRetry(record, String(record.error ?? "Auto replace failed"), nowMs);
    if (!retry) return false;
    Object.assign(record, retry);

    let promoted = false;
    const snapshot = { ...record, attemptedUrls: [...record.attemptedUrls] };
    try {
      await mutateStoreStrict((store) => {
        const live = store[record.jobId];
        const latest = newestAutoReplaceJobsByTarget(Object.values(store))
          .find((candidate) => candidate.propertyId === record.propertyId && candidate.unitId === record.unitId);
        if (!live || latest?.jobId !== record.jobId || live.phase !== "failed"
          || live.updatedAt !== previous.updatedAt) return;
        store[record.jobId] = snapshot;
        promoted = true;
      });
    } catch (error) {
      Object.assign(record, previous);
      throw error;
    }
    if (!promoted) {
      Object.assign(record, previous);
      return false;
    }
    jobs.set(record.jobId, record);
    console.warn(`[auto-replace] legacy-retry: ${record.jobId} scheduled for persistent finding on ${context.photoFolder}`);
    return true;
  } finally {
    await targetLock.release().catch(() => undefined);
  }
}

async function activateDueAutoReplaceRetry(record: AutoReplaceJobRecord): Promise<boolean> {
  if (!isAutoReplaceRetryDue(record, Date.now()) || activeJobIds.has(record.jobId)) return false;
  const targetLock = await acquireAutoReplaceTargetLock(record).catch((error) => {
    console.warn(`[auto-replace] ${record.jobId}: retry target lock failed: ${error?.message ?? error}`);
    return null;
  });
  if (!targetLock) return false;

  try {
    let persisted: AutoReplaceJobRecord | undefined;
    try {
      const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY);
      persisted = parseAutoReplaceStore(raw ?? null)[record.jobId];
    } catch (error: any) {
      console.warn(`[auto-replace] ${record.jobId}: retry queue read failed; deferring: ${error?.message ?? error}`);
      return false;
    }
    if (!persisted || !isAutoReplaceRetryDue(persisted, Date.now())) return false;
    Object.assign(record, persisted);

    // Re-check every piece of mutable target identity while holding the same
    // short claim lock used by every watchdog instance. The actual swap write
    // has its own transaction-level generation precondition.
    let context: AutoReplaceTargetContext | null;
    try {
      context = await currentTargetContextForRecord(record);
    } catch (error: any) {
      console.warn(`[auto-replace] ${record.jobId}: retry target read failed; deferring: ${error?.message ?? error}`);
      return false;
    }
    const snapshotUnchanged = record.retryUnitSwapSnapshot != null
      && context?.unitSwapSnapshot === record.retryUnitSwapSnapshot;
    const folderUnchanged = !!context?.photoFolder
      && context.photoFolder === record.retryPhotoFolder;
    let findingStillPresent = false;
    if (folderUnchanged) {
      try {
        findingStillPresent = await folderStillHasPhotoFinding(context!.photoFolder);
      } catch (error: any) {
        console.warn(`[auto-replace] ${record.jobId}: retry photo-check read failed; deferring: ${error?.message ?? error}`);
        return false;
      }
    }
    if (!snapshotUnchanged || !findingStillPresent) {
      const reason = !context
        ? "the unit could no longer be resolved safely"
        : !snapshotUnchanged
          ? "the unit's swap history changed during the retry backoff"
          : !folderUnchanged
            ? "the unit's active photo folder changed during the retry backoff"
            : "the latest Airbnb/VRBO/Booking photo check no longer reports the unit as found";
      const previous = { ...record };
      Object.assign(record, {
        phase: "failed" as const,
        nextRetryAt: null,
        message: null,
        error: `${record.error ?? "The replacement attempt failed."} Automatic retry stopped because ${reason}.`,
        updatedAt: Date.now(),
      });
      try {
        await persistAutoReplaceRecord(record, { strict: true });
      } catch (error) {
        Object.assign(record, previous);
        throw error;
      }
      console.warn(`[auto-replace] ${record.jobId}: automatic retry cancelled — ${reason}`);
      return false;
    }

    const previous = { ...record };
    Object.assign(record, {
      phase: "queued" as const,
      findJobId: null,
      resumeCount: 0,
      nextRetryAt: null,
      message: `Starting automatic retry ${record.autoRetryCount}/${MAX_AUTO_REPLACE_RETRIES}; rejected candidates remain excluded…`,
      error: null,
      updatedAt: Date.now(),
    });
    // Strict durability is a launch precondition. If the write fails, this
    // process releases the target lock without starting a search; a later
    // watchdog sweep can safely try the still-persisted retry_wait record.
    try {
      await persistAutoReplaceRecord(record, { strict: true });
    } catch (error) {
      Object.assign(record, previous);
      throw error;
    }
    console.warn(`[auto-replace] retry-start: ${record.jobId} attempt ${record.autoRetryCount}/${MAX_AUTO_REPLACE_RETRIES}`);
    void runAutoReplaceJob(record);
    return true;
  } finally {
    await targetLock.release().catch((error) => {
      console.warn(`[auto-replace] ${record.jobId}: retry target lock release failed: ${error?.message ?? error}`);
    });
  }
}

// Boot/interval watchdog — resume orphaned active jobs after a restart and
// promote bounded delayed retries after re-confirming the OTA photo finding.
// Gate: AUTO_REPLACE_RESUME_DISABLED=1.
let resumeSweepInFlight = false;
export async function resumeOrphanedAutoReplaceJobs(): Promise<void> {
  if (resumeSweepInFlight) return;
  resumeSweepInFlight = true;
  try {
    const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY);
    const store = parseAutoReplaceStore(raw ?? null);
    const now = Date.now();

    // Bridge recent failures written before retry metadata shipped. Only the
    // newest receipt for each target is authoritative: an older failure must
    // not be promoted after a later operator attempt or completed swap.
    const authoritativeRecords = newestAutoReplaceJobsByTarget(Object.values(store));
    for (const record of authoritativeRecords) {
      await scheduleLegacyAutoReplaceRetry(record, now);
    }

    for (const record of authoritativeRecords) {
      if (record.phase === "retry_wait") {
        if (isAutoReplaceRetryDue(record, Date.now())) await activateDueAutoReplaceRetry(record);
        continue;
      }
      if (!shouldResumeAutoReplaceJob(record, Date.now())) continue;
      if (activeJobIds.has(record.jobId)) continue;
      void runAutoReplaceJob(record, { resuming: true });
    }
    // Active-phase records that can NEVER come back (resume cap exhausted /
    // outside the window) become an honest terminal failure instead of
    // pinning the queue banner "active" until store eviction (2026-07-05
    // Pili Mai deploy-burst incident). In-process jobs are protected.
    const liveIds = new Set(Array.from(activeJobIds));
    const stuckIds = authoritativeRecords.filter((r) =>
      r.phase !== "retry_wait" && isAutoReplacePhaseActive(r.phase)
        && !liveIds.has(r.jobId) && !shouldResumeAutoReplaceJob(r, Date.now()),
    ).map((r) => r.jobId);
    if (stuckIds.length > 0) {
      console.warn(`[auto-replace] reconciling ${stuckIds.length} stuck unresumable job(s): ${stuckIds.join(", ")}`);
      await mutateStore((liveStore, now) => {
        // Re-evaluate authority inside the row-locked transaction: a newer
        // receipt may have arrived since this sweep read the setting.
        const authoritativeIds = new Set(
          newestAutoReplaceJobsByTarget(Object.values(liveStore)).map((record) => record.jobId),
        );
        const protectedIds = new Set(liveIds);
        for (const jobId of Object.keys(liveStore)) {
          if (!authoritativeIds.has(jobId)) protectedIds.add(jobId);
        }
        failStuckAutoReplaceRecords(liveStore, now, protectedIds);
      });
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
