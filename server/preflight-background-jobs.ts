import { preflightPhotoDiscoveryAttempts } from "@shared/preflight-photo-discovery";
import {
  auditUnitIdsNeedingRetry,
  mergeRetriedAuditUnitResult,
  tallyPreflightAuditOutcome,
} from "@shared/preflight-audit-outcome";
import {
  decideReplacementContinuation,
  mergeReplacementUnits,
  REPLACEMENT_EXHAUSTIVE_OPTION_TARGET_DEFAULT,
} from "@shared/replacement-search-continuation";
import {
  buildUnitPhotoResolverProof,
  compareUnitPhotoProofs,
  MIN_INDEPENDENT_UNIT_PHOTOS,
  summarizeUnitPhotoProof,
  type UnitPhotoResolverProof,
} from "./unit-photo-resolver";
import {
  runSameUnitPhotoHunt,
  sameUnitPhotoHuntEnabled,
  type SameUnitHuntAccepted,
} from "./same-unit-photo-hunt";

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type PreflightPhotoFetchJob = {
  id: string;
  status: JobStatus;
  phase: string;
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  draftId: number;
  propertyId: number;
  unitId: string;
  unitIndex: 0 | 1;
  savedCount: number | null;
  /**
   * Human-readable summary of what a re-pull actually CHANGED on disk
   * ("gallery already current — no changes" vs "3 new, 1 removed…"). Lets a
   * fast re-pull of the same listing show it ran without looking like a no-op.
   */
  changeNote: string | null;
  sourceUrl: string | null;
  proof: UnitPhotoResolverProof | null;
  diagnostic: Record<string, unknown> | null;
  /**
   * Same-unit hunt (sameUnitOnly mode) failed because NO genuinely different
   * photo set of this exact unit exists online — the honest next step is
   * replacing the unit, and the client renders a "Find replacement unit" CTA.
   * NEVER set on transient infra failures (SERP quota, scrape outage): a
   * failed search must not push the operator toward a destructive swap.
   */
  recommendReplaceUnit: boolean | null;
  error: string | null;
};

export type PreflightReplacementFindJob = {
  id: string;
  status: JobStatus;
  phase: string;
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  unit: Record<string, unknown> | null;
  // A0: the full list of clean units this search surfaced (element 0 === `unit`),
  // so the operator can pick from several options. Null/absent on older jobs.
  units?: Array<Record<string, unknown>> | null;
  diagnostic: Record<string, unknown> | null;
};

/**
 * "Full unit audit" / "Run check" — the OTA platform check (text search +
 * reverse-image photo scan) run SERVER-SIDE so the operator can fire it and
 * leave the tab. Previously the client looped over units with parallel fetches
 * to `/api/preflight/platform-check` and held the results in React state, so a
 * tab close mid-audit aborted the fetches and discarded everything. The job now
 * drives the SAME endpoint via loopback (no re-implementation of the ~800-line
 * handler) and accumulates per-unit results + the receipt + (for a full audit)
 * the deep reverse-image photo results onto the job. The client polls and
 * rehydrates its UI from the job; localStorage re-attaches on return. In-memory
 * + 2h TTL like the sibling jobs — a redeploy mid-audit just means a re-click
 * (the deep photo scan it kicks off persists independently via its 24h cache).
 */
export type PreflightAuditReceipt = {
  timestamp: number;
  success: boolean;
  title: string;
  detail: string;
};

export type PreflightAuditJob = {
  id: string;
  status: JobStatus;
  phase: "queued" | "text" | "photo" | "completed" | "failed";
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  fullPhotoAudit: boolean;
  totalUnits: number;
  completedCount: number;
  /** unitId → the platform-check endpoint's per-unit result (rendered as-is). */
  results: Record<string, unknown>;
  receipt: PreflightAuditReceipt | null;
  /** folder → deep reverse-image PhotoCheckRow (full audit only). */
  photoChecks: Record<string, unknown> | null;
  photoBudget: Record<string, unknown> | null;
  deepPhotoStarted: boolean;
  error: string | null;
};

/**
 * "Rescrape photos" — re-pull a single unit's OWN saved listing gallery, run
 * SERVER-SIDE so it survives a tab close. Drives the existing
 * `POST /api/builder/rescrape-unit-photos` via loopback. The one interactive
 * case (no source URL on file → HTTP 409 `needsUrl`) is surfaced as a terminal
 * `needsUrl` job so the client can prompt for a URL and start a fresh job — the
 * only step that still needs the operator present.
 */
export type PreflightRescrapeJob = {
  id: string;
  status: JobStatus;
  phase: "queued" | "scraping" | "completed" | "failed";
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  folder: string;
  /** True when the rescrape needs a source URL the operator must paste. */
  needsUrl: boolean;
  savedCount: number | null;
  bedroomCount: number | null;
  bathroomCount: number | null;
  sourceUrl: string | null;
  urlSource: string | null;
  coverage: Record<string, unknown> | null;
  error: string | null;
};

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
// find-unit ROUTE_BUDGET_MS is up to 285s (expanded) and may still run one
// PHOTO_SCRAPE_TIMEOUT_MS step that started just inside the budget guard.
const REPLACEMENT_FIND_UNIT_LOOPBACK_TIMEOUT_MS = 350_000;
const MAX_REPLACEMENT_FIND_CONTINUATIONS = 12;
const photoFetchJobs = new Map<string, PreflightPhotoFetchJob>();
const replacementFindJobs = new Map<string, PreflightReplacementFindJob>();
const auditJobs = new Map<string, PreflightAuditJob>();
const rescrapeJobs = new Map<string, PreflightRescrapeJob>();
const activePhotoFetchJobIds = new Set<string>();
const activeReplacementFindJobIds = new Set<string>();
const activeAuditJobIds = new Set<string>();
const activeRescrapeJobIds = new Set<string>();
const draftPhotoFetchProofs = new Map<number, Partial<Record<0 | 1, UnitPhotoResolverProof>>>();
const draftPhotoProofLockTails = new Map<number, Promise<void>>();

import { loopbackRequestHeaders } from "./auth";
import { storage } from "./storage";
import {
  REPLACEMENT_JOB_STORE_SETTING_KEY,
  failStuckReplacementRecords,
  parseReplacementJobStore,
  replacementJobFromTerminalRecord,
  replacementJobResumingPlaceholder,
  replacementJobStuckFallback,
  serializeReplacementJobStore,
  shouldResumeReplacementJob,
  supersedeRunningRecordsForProperty,
  type PersistedReplacementJobRecord,
} from "@shared/replacement-job-persistence";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

// ── Durable replacement-find job store (leave-your-phone survivability) ───────
// The in-memory job dies on every Railway redeploy/restart. The client's
// localStorage relaunch only fires when the operator's TAB polls again — so a
// restart while they were off in another app stalled the search until they
// came back. Records in app_settings let the boot/interval watchdog below
// re-launch orphaned running searches under the SAME job id (nothing for the
// client to reconcile) and serve terminal RESULTS across restarts. All store
// I/O is fail-soft: no DB just means the old memory-only behavior.
// Sequenced through a single promise tail so concurrent job events can't
// interleave read-modify-write cycles and drop each other's records.
let replacementStoreTail: Promise<void> = Promise.resolve();
function mutateReplacementJobStore(
  mutate: (store: Record<string, PersistedReplacementJobRecord>, nowMs: number) => void,
): Promise<void> {
  replacementStoreTail = replacementStoreTail.then(async () => {
    try {
      const now = Date.now();
      const raw = await storage.getSetting(REPLACEMENT_JOB_STORE_SETTING_KEY);
      const store = parseReplacementJobStore(raw ?? null);
      mutate(store, now);
      await storage.setSetting(REPLACEMENT_JOB_STORE_SETTING_KEY, serializeReplacementJobStore(store, now));
    } catch {
      // Fail-soft: persistence is an upgrade, never a blocker for the search.
    }
  });
  return replacementStoreTail;
}

function persistReplacementJobRunning(job: PreflightReplacementFindJob, payload: Record<string, unknown>, resumeCount = 0): void {
  void mutateReplacementJobStore((store, now) => {
    // Only a genuinely NEW search supersedes siblings — a watchdog RESUME
    // (resumeCount > 0) is the same search coming back, not competition.
    if (resumeCount === 0) {
      supersedeRunningRecordsForProperty(store, payload.propertyId, job.id, now, {
        targetUnitId: payload.targetUnitId,
        liveJobIds: [...Array.from(replacementFindJobs.keys()), ...Array.from(activeReplacementFindJobIds)],
      });
    }
    const prior = store[job.id];
    store[job.id] = {
      jobId: job.id,
      status: "running",
      payload,
      createdAt: prior?.createdAt ?? job.createdAt,
      updatedAt: now,
      resumeCount: Math.max(resumeCount, prior?.resumeCount ?? 0),
    };
  });
}

function persistReplacementJobTerminal(job: PreflightReplacementFindJob): void {
  replacementRecordHeartbeatAt.delete(job.id);
  void mutateReplacementJobStore((store, now) => {
    const prior = store[job.id];
    store[job.id] = {
      jobId: job.id,
      status: job.status === "completed" ? "completed" : "failed",
      payload: prior?.payload ?? {},
      createdAt: prior?.createdAt ?? job.createdAt,
      updatedAt: now,
      resumeCount: prior?.resumeCount ?? 0,
      message: job.message ?? null,
      error: job.error ?? null,
      unit: job.unit ?? null,
      units: job.units ?? null,
    };
  });
}

// GET :jobId fallback when the in-memory job is gone (post-restart): a
// terminal record serves its snapshotted result; a resumable running record
// returns a RUNNING placeholder so the polling client keeps waiting for the
// watchdog instead of launching a duplicate search of its own.
export async function getPersistedReplacementFindJob(jobId: string): Promise<PreflightReplacementFindJob | null> {
  try {
    const raw = await storage.getSetting(REPLACEMENT_JOB_STORE_SETTING_KEY);
    const record = parseReplacementJobStore(raw ?? null)[jobId];
    if (!record) return null;
    if (record.status !== "running") {
      return replacementJobFromTerminalRecord(record) as PreflightReplacementFindJob;
    }
    if (shouldResumeReplacementJob(record, Date.now())) {
      return replacementJobResumingPlaceholder(record, Date.now()) as PreflightReplacementFindJob;
    }
    // Running but unresumable (resume cap exhausted / outside the window): the
    // search died with a past process and will never finish. Serve an honest
    // terminal failure instead of the old null → 404 that left pollers
    // spinning forever (the watchdog sweep persists the same failure).
    return replacementJobStuckFallback(record, Date.now()) as PreflightReplacementFindJob;
  } catch {
    // A transient store-READ failure (DB blip) is NOT "the job vanished" —
    // null here would burn a client relaunch / an orchestrator fresh-search
    // restart on a hiccup. Serve a running placeholder; the next successful
    // read tells the truth.
    return {
      id: jobId,
      status: "running",
      phase: "checking",
      message: "Job store temporarily unreadable — retrying…",
      progress: 40,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      unit: null,
      diagnostic: null,
    } as PreflightReplacementFindJob;
  }
}

// Boot/interval watchdog: re-launch orphaned running records under the SAME
// job id so the operator's phone (still polling that id, or returning later)
// picks the search back up seamlessly. Gate: REPLACEMENT_RESUME_DISABLED=1.
let replacementResumeSweepInFlight = false;
export async function resumeOrphanedReplacementFindJobs(): Promise<void> {
  if (replacementResumeSweepInFlight) return;
  replacementResumeSweepInFlight = true;
  try {
    const raw = await storage.getSetting(REPLACEMENT_JOB_STORE_SETTING_KEY);
    const store = parseReplacementJobStore(raw ?? null);
    for (const record of Object.values(store)) {
      if (!shouldResumeReplacementJob(record, Date.now())) continue;
      if (replacementFindJobs.has(record.jobId) || activeReplacementFindJobIds.has(record.jobId)) continue;
      console.warn(`[replacement-find] boot-resume: re-launching orphaned running job ${record.jobId} (resume ${record.resumeCount + 1})`);
      const job: PreflightReplacementFindJob = {
        id: record.jobId,
        status: "queued",
        phase: "queued",
        message: "Resuming after server restart…",
        progress: 8,
        createdAt: record.createdAt || Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        error: null,
        unit: null,
        diagnostic: null,
      };
      replacementFindJobs.set(job.id, job);
      persistReplacementJobRunning(job, record.payload, record.resumeCount + 1);
      void runPreflightReplacementFindJob(job, record.payload);
    }
    // Running records that can NEVER come back (resume cap exhausted / outside
    // the window) get an honest terminal failure — otherwise they sit
    // "running" until the 24h eviction while pollers 404 and the auto-replace
    // orchestrator mis-reports "no eligible unit found" (2026-07-05 Pili Mai
    // deploy-burst incident). Records live in THIS process are protected.
    const liveIds = new Set([...Array.from(replacementFindJobs.keys()), ...Array.from(activeReplacementFindJobIds)]);
    const stuckIds = Object.values(store).filter((r) =>
      r.status === "running" && !liveIds.has(r.jobId) && !shouldResumeReplacementJob(r, Date.now()),
    ).map((r) => r.jobId);
    if (stuckIds.length > 0) {
      console.warn(`[replacement-find] failing ${stuckIds.length} stuck unresumable job(s): ${stuckIds.join(", ")}`);
      await mutateReplacementJobStore((liveStore, now) => {
        failStuckReplacementRecords(liveStore, now, liveIds);
      });
    }
  } catch {
    // Fail-soft — next sweep retries.
  } finally {
    replacementResumeSweepInFlight = false;
  }
}

export function startReplacementFindResumeWatchdog(): void {
  if (/^(1|true|yes|on)$/i.test(String(process.env.REPLACEMENT_RESUME_DISABLED ?? "").trim())) {
    console.log("[replacement-find] resume watchdog disabled via REPLACEMENT_RESUME_DISABLED");
    return;
  }
  // Boot pass waits for the loopback listener to be live (the job drives
  // find-unit via loopback POSTs), then a slow interval catches anything the
  // boot pass raced (e.g. DB not yet reachable).
  setTimeout(() => void resumeOrphanedReplacementFindJobs(), 20_000).unref?.();
  setInterval(() => void resumeOrphanedReplacementFindJobs(), 2 * 60_000).unref?.();
}

function newJobId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function touchPhotoJob(job: PreflightPhotoFetchJob, patch: Partial<PreflightPhotoFetchJob> = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  photoFetchJobs.set(job.id, job);
}

// Throttled durable heartbeat: the persisted record's updatedAt used to be
// stamped only at launch/resume, so a single restart after minute ~60 of a
// long exhaustive search fell outside the resume window (unresumable with
// resumeCount 0). Refreshing it every few minutes keeps a genuinely-alive
// search inside the window without hammering app_settings.
const REPLACEMENT_RECORD_HEARTBEAT_MS = 5 * 60 * 1000;
const replacementRecordHeartbeatAt = new Map<string, number>();

function touchReplacementJob(job: PreflightReplacementFindJob, patch: Partial<PreflightReplacementFindJob> = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  replacementFindJobs.set(job.id, job);
  if (job.status === "queued" || job.status === "running") {
    const now = Date.now();
    const last = replacementRecordHeartbeatAt.get(job.id) ?? 0;
    if (now - last >= REPLACEMENT_RECORD_HEARTBEAT_MS) {
      replacementRecordHeartbeatAt.set(job.id, now);
      void mutateReplacementJobStore((store) => {
        const record = store[job.id];
        if (record && record.status === "running") record.updatedAt = now;
      });
    }
  }
}

function touchAuditJob(job: PreflightAuditJob, patch: Partial<PreflightAuditJob> = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  auditJobs.set(job.id, job);
}

function touchRescrapeJob(job: PreflightRescrapeJob, patch: Partial<PreflightRescrapeJob> = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  rescrapeJobs.set(job.id, job);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function reserveDraftPhotoProof(
  draftId: number,
  unitIndex: 0 | 1,
  proof: UnitPhotoResolverProof,
): string | null {
  const entry = draftPhotoFetchProofs.get(draftId) ?? {};
  const siblingIndex: 0 | 1 = unitIndex === 0 ? 1 : 0;
  const siblingProof = entry[siblingIndex];
  if (siblingProof) {
    const comparison = compareUnitPhotoProofs(proof, siblingProof);
    if (comparison.duplicate) {
      return `Unit ${unitIndex === 0 ? "A" : "B"} photo source duplicates Unit ${siblingIndex === 0 ? "A" : "B"} (${comparison.issues.join(", ") || "duplicate-photo-overlap"}; overlap ${comparison.overlapCount}, ratio ${comparison.overlapRatio.toFixed(2)}).`;
    }
  }
  entry[unitIndex] = proof;
  draftPhotoFetchProofs.set(draftId, entry);
  return null;
}

function releaseDraftPhotoProof(draftId: number, unitIndex: 0 | 1, proof: UnitPhotoResolverProof | null): void {
  if (!proof) return;
  const entry = draftPhotoFetchProofs.get(draftId);
  if (!entry || entry[unitIndex] !== proof) return;
  delete entry[unitIndex];
  if (!entry[0] && !entry[1]) draftPhotoFetchProofs.delete(draftId);
}

async function withDraftPhotoProofLock<T>(draftId: number, fn: () => Promise<T>): Promise<T> {
  const previous = draftPhotoProofLockTails.get(draftId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  draftPhotoProofLockTails.set(draftId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (draftPhotoProofLockTails.get(draftId) === tail) {
      draftPhotoProofLockTails.delete(draftId);
    }
  }
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<any> {
  const resp = await fetch(url, {
    method: "POST",
    headers: loopbackRequestHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || data?.message || `HTTP ${resp.status}`);
  return data;
}

function cleanupStaleJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of photoFetchJobs) {
    if ((job.finishedAt ?? job.createdAt) < cutoff) photoFetchJobs.delete(id);
  }
  for (const [id, job] of replacementFindJobs) {
    if ((job.finishedAt ?? job.createdAt) < cutoff) replacementFindJobs.delete(id);
  }
  // .forEach (not for-of) to avoid the repo's ES5 downlevelIteration tsc error;
  // deleting during Map.forEach is safe.
  auditJobs.forEach((job, id) => {
    if ((job.finishedAt ?? job.createdAt) < cutoff) auditJobs.delete(id);
  });
  rescrapeJobs.forEach((job, id) => {
    if ((job.finishedAt ?? job.createdAt) < cutoff) rescrapeJobs.delete(id);
  });
}

setInterval(cleanupStaleJobs, 30 * 60 * 1000).unref?.();

export function getPreflightPhotoFetchJob(jobId: string): PreflightPhotoFetchJob | null {
  return photoFetchJobs.get(jobId) ?? null;
}

export function getPreflightReplacementFindJob(jobId: string): PreflightReplacementFindJob | null {
  return replacementFindJobs.get(jobId) ?? null;
}

export function getPreflightAuditJob(jobId: string): PreflightAuditJob | null {
  return auditJobs.get(jobId) ?? null;
}

export function getPreflightRescrapeJob(jobId: string): PreflightRescrapeJob | null {
  return rescrapeJobs.get(jobId) ?? null;
}

export type StartPreflightPhotoFetchInput = {
  draftId: number;
  propertyId: number;
  unitId: string;
  unitIndex: 0 | 1;
  bedrooms: number;
  communityName: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  skipUrls?: string[];
  replacingExistingPhotos?: boolean;
  skipFirst?: number;
  /**
   * "Re-pull all photos": rescrape THIS unit's own saved listing URL directly
   * (full gallery) before any discovery. Set by the preflight when a unit
   * already has a saved source. If the source is off-market / yields fewer than
   * MIN_INDEPENDENT_UNIT_PHOTOS, the job falls through to discovery so we still
   * land a usable gallery instead of saving nothing.
   */
  rescrapeSourceUrl?: string;
  /**
   * "Find new photos": skip the saved-listing rescrape entirely and run
   * DISCOVERY for a DIFFERENT source listing even though the unit already has
   * photos (the caller puts the current source + sibling sources in skipUrls so
   * the same listing can never be re-picked). Discovery stays exact-bedroom in
   * this mode — a wrong-BR representative gallery must never replace a real
   * gallery. On success the new gallery replaces the old one and _source.json
   * is re-stamped by persist-photos; if nothing qualifying is found, the
   * existing gallery is kept.
   */
  findNewSource?: boolean;
  /**
   * The operator's preflight "Find new photos" button (2026-07-17): hunt for
   * the SAME physical unit's listing pages on the other real-estate portals
   * and accept only a gallery PROVEN different from the photos on file
   * (dHash novelty vs `currentFolder`). No fallback to the different-listing
   * discovery below — when the hunt exhausts, the job fails with
   * `recommendReplaceUnit` and the UI offers "Find replacement unit" instead.
   * Requires findNewSource (so the SAME_UNIT_PHOTO_HUNT_DISABLED kill switch
   * degrades to the legacy find-new discovery, never to a silent no-op).
   * The Unit Audit Sweep's find-new-source rung deliberately does NOT set
   * this — its remediation contract (bedroom shortfall → different listing)
   * keeps the legacy findNewSource semantics.
   */
  sameUnitOnly?: boolean;
  /** The unit's saved source listing URL — the same-unit hunt's identity anchor. */
  currentSourceUrl?: string;
  /** The unit's ACTIVE photo folder — what the novelty check compares against. */
  currentFolder?: string;
  /**
   * STATIC builder property mode (draftId <= 0): the unit's ACTIVE photo folder
   * (the replacement-p<prop>-u<unit> folder once the unit was swapped, else the
   * unit's own folder) to persist the discovered gallery into. There is no draft
   * row to persist through, so the job hands the discovered sourceUrl to
   * POST /api/builder/rescrape-unit-photos — the same single-writer path the
   * per-unit "Rescrape photos" button uses — which scrapes it, replaces the
   * folder via downloadAndPrioritize, and re-stamps _source.json. Ignored when
   * draftId > 0 (drafts keep the persist-photos path verbatim).
   */
  targetFolder?: string;
};

export function startPreflightPhotoFetchJob(input: StartPreflightPhotoFetchInput): PreflightPhotoFetchJob {
  const id = newJobId("ppfj");
  const job: PreflightPhotoFetchJob = {
    id,
    status: "queued",
    phase: "queued",
    message: "Queued",
    progress: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    draftId: input.draftId,
    propertyId: input.propertyId,
    unitId: input.unitId,
    unitIndex: input.unitIndex,
    savedCount: null,
    changeNote: null,
    sourceUrl: null,
    proof: null,
    diagnostic: null,
    recommendReplaceUnit: null,
    error: null,
  };
  photoFetchJobs.set(id, job);
  void runPreflightPhotoFetchJob(job, input);
  return job;
}

async function runPreflightPhotoFetchJob(
  job: PreflightPhotoFetchJob,
  input: StartPreflightPhotoFetchInput,
): Promise<void> {
  if (activePhotoFetchJobIds.has(job.id)) return;
  activePhotoFetchJobIds.add(job.id);
  const base = loopbackBaseUrl();
  const replacingExistingPhotos = input.replacingExistingPhotos === true;
  const findNewSource = input.findNewSource === true;
  // "Find new photos" (2026-07-17): SAME-UNIT cross-portal hunt. When the
  // kill switch disables it, the request degrades to the legacy findNewSource
  // different-listing discovery (loudly), never to a silent no-op.
  const sameUnitMode = input.sameUnitOnly === true && sameUnitPhotoHuntEnabled();
  if (input.sameUnitOnly === true && !sameUnitMode) {
    console.error("[photo-fetch] SAME_UNIT_PHOTO_HUNT_DISABLED=1 — falling back to legacy find-new-source discovery");
  }
  // STATIC builder property (no draft row): persist goes through
  // rescrape-unit-photos into input.targetFolder, and discovery never accepts a
  // thin gallery — static units are real listed properties, so a <MIN result
  // must not replace (or seed) their active folder.
  const staticFolderMode = !(input.draftId > 0);
  const rescrapeSourceUrl = !findNewSource
    && typeof input.rescrapeSourceUrl === "string" && /^https?:\/\//i.test(input.rescrapeSourceUrl)
    ? input.rescrapeSourceUrl.trim()
    : null;
  // Find-new mode keeps discovery EXACT-bedroom (drops the relaxed "any" rung):
  // it replaces a real gallery, so a wrong-BR representative must never win.
  const attempts = preflightPhotoDiscoveryAttempts(input.bedrooms, replacingExistingPhotos)
    .filter((a) => !findNewSource || a.bedrooms !== "any");
  let reservedProof: UnitPhotoResolverProof | null = null;
  try {
    touchPhotoJob(job, {
      status: "running",
      phase: "searching",
      message: "Checking existing photo sources",
      progress: 12,
      startedAt: job.startedAt ?? Date.now(),
    });

    const triedUrls = new Set((input.skipUrls ?? []).filter(Boolean));
    let photos: Array<{ url: string }> = [];
    let sourceUrl: string | null = null;
    let lastNote: string | undefined;
    let lastProof: UnitPhotoResolverProof | null = null;
    let lastDiagnostic: Record<string, unknown> | null = null;

    // ── SAME-UNIT CROSS-PORTAL HUNT ("Find new photos", 2026-07-17) ─────────
    // Hunt for THIS unit's listing pages on the other portals and accept only
    // a gallery proven different (dHash novelty) from the photos on file. No
    // fallback to the different-listing discovery below — an exhausted hunt
    // fails the job with recommendReplaceUnit so the UI offers the unit
    // replacement flow instead of silently substituting a neighbor's photos.
    let sameUnitPick: SameUnitHuntAccepted | null = null;
    if (sameUnitMode) {
      touchPhotoJob(job, {
        phase: "searching",
        message: "Hunting this exact unit's listing on other portals",
        progress: 16,
      });
      const hunt = await runSameUnitPhotoHunt({
        currentSourceUrl: input.currentSourceUrl,
        currentFolder: input.currentFolder ?? input.targetFolder,
        communityStreetAddress: input.streetAddress,
        communityName: input.communityName,
        bedrooms: input.bedrooms,
        excludeUrls: Array.from(triedUrls),
        progress: (message, progressPct) =>
          touchPhotoJob(job, { phase: "searching", message, progress: progressPct }),
        scrapeGallery: async (url) => {
          const fetchData = await postJson(`${base}/api/community/fetch-unit-photos`, {
            url,
            // No bedroom gate: the identity filter already proved this IS the
            // same unit; resort condos often mis-parse scraped bedrooms.
            bedrooms: "any",
            // Same sidecar/timeout posture as the saved-listing re-pull leg
            // below — background job, so the residential-IP tier is worth it.
            useSidecar: true,
            nocache: true,
          }, 300_000);
          const nextPhotos = Array.isArray(fetchData?.photos) ? fetchData.photos as Array<{ url: string }> : [];
          const proof = fetchData?.resolverProof && typeof fetchData.resolverProof === "object"
            ? fetchData.resolverProof as Record<string, unknown>
            : null;
          return {
            photos: nextPhotos,
            sourceUrl: typeof fetchData?.sourceUrl === "string" ? fetchData.sourceUrl : url,
            proofRejected: (proof as { status?: string } | null)?.status === "rejected",
            resolverProof: proof,
            diagnostic: fetchData?.diagnostic && typeof fetchData.diagnostic === "object"
              ? fetchData.diagnostic as Record<string, unknown>
              : null,
          };
        },
      });
      if (hunt.outcome !== "accepted") {
        touchPhotoJob(job, {
          status: "failed",
          phase: "failed",
          message: hunt.message,
          progress: 100,
          finishedAt: Date.now(),
          error: hunt.message,
          recommendReplaceUnit: hunt.recommendReplaceUnit,
        });
        return;
      }
      sameUnitPick = hunt;
      photos = hunt.photos;
      sourceUrl = hunt.sourceUrl;
      lastProof = (hunt.resolverProof as UnitPhotoResolverProof | null)
        ?? buildUnitPhotoResolverProof({
          photos: hunt.photos,
          sourceUrl: hunt.sourceUrl,
          foundVia: "url",
          facts: null,
        });
      lastDiagnostic = hunt.diagnostic;
      touchPhotoJob(job, { proof: lastProof, diagnostic: lastDiagnostic });
    }

    // "Re-pull all photos": rescrape this unit's OWN saved listing first, so the
    // operator gets the full original gallery rather than a discovery wander to
    // a different (often wrong-community) listing. The Redfin comp-carousel fix
    // (server/redfin-gallery.ts) guarantees the direct rescrape returns only the
    // subject listing's photos. If the saved listing is off-market / too thin
    // (< MIN_INDEPENDENT_UNIT_PHOTOS), fall through to the discovery loop below —
    // the source is in skipUrls so discovery won't re-pick the dead listing.
    if (rescrapeSourceUrl && !sameUnitMode) {
      touchPhotoJob(job, {
        phase: "searching",
        message: "Re-pulling this unit's saved listing",
        progress: 42,
      });
      try {
        const fetchData = await postJson(`${base}/api/community/fetch-unit-photos`, {
          url: rescrapeSourceUrl,
          // No bedroom gate: this IS the unit's own listing — never reject it on
          // a scraped-bedroom mismatch (resort condos often mis-parse).
          bedrooms: "any",
          // Opt into the residential-IP sidecar: a Redfin/Homes/Zillow listing
          // whose datacenter scrape returns 0 usable gallery photos (bot-wall /
          // block page) is otherwise re-pulled thin (missing bedrooms). This is
          // a background job, so the extra sidecar latency is invisible to the
          // UI. The 300s timeout gives headroom for the worst realistic chain —
          // Apify (180s ceiling) then a 90s sidecar wallet — so a genuinely slow
          // re-pull isn't silently dropped into discovery; if it still overruns
          // it fails soft to the discovery loop below (current behavior). The
          // sidecar is inert/fast when the worker is offline. See LB #45.
          useSidecar: true,
          // Operator-initiated: never serve a cached scrape for a deliberate re-pull.
          nocache: true,
        }, 300_000);
        lastNote = typeof fetchData?.note === "string" ? fetchData.note : lastNote;
        const nextPhotos = Array.isArray(fetchData?.photos) ? fetchData.photos as Array<{ url: string }> : [];
        const nextSourceUrl: string | null = fetchData?.sourceUrl ?? rescrapeSourceUrl;
        const nextProof = fetchData?.resolverProof && typeof fetchData.resolverProof === "object"
          ? fetchData.resolverProof as UnitPhotoResolverProof
          : buildUnitPhotoResolverProof({
              photos: nextPhotos,
              sourceUrl: nextSourceUrl,
              foundVia: typeof fetchData?.foundVia === "string" ? fetchData.foundVia : "url",
              facts: fetchData?.facts && typeof fetchData.facts === "object" ? fetchData.facts : null,
            });
        lastProof = nextProof;
        lastDiagnostic = fetchData?.diagnostic && typeof fetchData.diagnostic === "object"
          ? fetchData.diagnostic as Record<string, unknown>
          : null;
        touchPhotoJob(job, { proof: nextProof, diagnostic: lastDiagnostic });
        if (nextPhotos.length >= MIN_INDEPENDENT_UNIT_PHOTOS && nextProof.status !== "rejected") {
          photos = nextPhotos;
          sourceUrl = nextSourceUrl;
        }
      } catch (e: any) {
        // Off-market / unreachable saved listing — discovery takes over below.
        lastNote = e?.message || lastNote;
      }
    }

    // Discovery fallback — DISABLED for "Re-pull all photos" (replacingExistingPhotos).
    // That button rescrapes THIS unit's OWN saved listing only; if the listing can't
    // supply at least MIN_INDEPENDENT_UNIT_PHOTOS usable photos (or there's no saved
    // source URL at all) we KEEP the existing gallery rather than silently
    // substituting a DIFFERENT listing's photos (which is exactly what this discovery
    // loop does). Discovery runs for "Find Photos" on an EMPTY unit AND for the
    // operator's explicit "Find new photos" (findNewSource) — there, substituting a
    // different listing is the point, and skipUrls carries the current source so the
    // same listing can't be re-picked.
    // Same-unit mode NEVER falls back to different-listing discovery — that
    // silent substitution is exactly what the 2026-07-17 redesign removed.
    const allowDiscoveryFallback = (!replacingExistingPhotos || findNewSource) && !sameUnitMode;
    for (let i = 0; allowDiscoveryFallback && photos.length === 0 && i < attempts.length; i += 1) {
      const attempt = attempts[i];
      touchPhotoJob(job, {
        phase: "searching",
        message: `Searching real-estate listings (attempt ${i + 1}/${attempts.length})`,
        progress: 18 + Math.round((i / attempts.length) * 58),
      });
      const fetchData = await postJson(`${base}/api/community/fetch-unit-photos`, {
        communityName: input.communityName,
        streetAddress: input.streetAddress,
        city: input.city,
        state: input.state,
        bedrooms: attempt.bedrooms,
        minBedrooms: attempt.minBedrooms,
        skipUrls: Array.from(triedUrls),
        skipFirst: triedUrls.size === 0 && replacingExistingPhotos ? (input.skipFirst ?? 1) : 0,
        maxCandidates: attempt.maxCandidates,
        // Operator-initiated: bypass the discovery cache reads (SERP + scrape) so a
        // deliberate retry hits the live portals instead of a day-old cached result.
        nocache: true,
      // fetch-unit-photos may inspect three viable cross-portal galleries
      // within its 175s bounded budget before choosing the best one.
      }, 190_000);
      lastNote = typeof fetchData?.note === "string" ? fetchData.note : undefined;
      const nextPhotos = Array.isArray(fetchData?.photos) ? fetchData.photos as Array<{ url: string }> : [];
      const nextSourceUrl: string | null = fetchData?.sourceUrl ?? null;
      const nextProof = fetchData?.resolverProof && typeof fetchData.resolverProof === "object"
        ? fetchData.resolverProof as UnitPhotoResolverProof
        : buildUnitPhotoResolverProof({
            photos: nextPhotos,
            sourceUrl: nextSourceUrl,
            foundVia: typeof fetchData?.foundVia === "string" ? fetchData.foundVia : null,
            requestedBedrooms: attempt.bedrooms === "any" ? null : attempt.bedrooms,
            minimumBedrooms: attempt.minBedrooms ?? null,
            facts: fetchData?.facts && typeof fetchData.facts === "object" ? fetchData.facts : null,
            representativeFallback: fetchData?.representativeFallback === true,
            reusedConfiguredSource: fetchData?.reusedConfiguredSource === true,
          });
      lastProof = nextProof;
      lastDiagnostic = fetchData?.diagnostic && typeof fetchData.diagnostic === "object"
        ? fetchData.diagnostic as Record<string, unknown>
        : null;
      touchPhotoJob(job, {
        proof: nextProof,
        diagnostic: lastDiagnostic,
      });
      // Find-new mode replaces a REAL gallery, and persist-photos replaces the
      // folder BEFORE the post-persist MIN check — so a thin discovery result
      // must be rejected HERE (falls through to the next attempt) or it would
      // clobber the existing gallery and then fail. Empty-unit discovery keeps
      // the old >0 acceptance (any photos beat none).
      const minAcceptable = findNewSource || staticFolderMode ? MIN_INDEPENDENT_UNIT_PHOTOS : 1;
      if (nextPhotos.length >= minAcceptable && nextProof.status !== "rejected") {
        photos = nextPhotos;
        sourceUrl = nextSourceUrl;
        break;
      }
      if (nextSourceUrl) triedUrls.add(nextSourceUrl);
      const exhausted = Array.isArray(fetchData?.triedCandidateUrls)
        ? (fetchData.triedCandidateUrls as string[])
        : [];
      for (const u of exhausted) triedUrls.add(u);
    }

    if (photos.length === 0) {
      // "Re-pull all photos" (replacingExistingPhotos) never substitutes a different
      // listing — the discovery loop above is gated off — so the unit's existing
      // gallery is left untouched (we never reach persist) and the message says so.
      const replaceOnlyFailure = replacingExistingPhotos
        ? (findNewSource
            ? `Couldn't find a NEW ${input.bedrooms}BR source listing with usable photos at ${input.communityName} (the current source is excluded from the search)${lastNote ? ` — ${lastNote}` : ""}. Kept the existing gallery and source.`
            : rescrapeSourceUrl
            ? `This unit's saved listing didn't return at least ${MIN_INDEPENDENT_UNIT_PHOTOS} usable photos${lastNote ? ` — ${lastNote}` : ""}. Kept the existing gallery; no substitute listing was pulled.`
            : `This unit has no saved source listing to re-pull from. Kept the existing gallery — set a source under “Photo Sources” to refresh it.`)
        : null;
      const proofSummary = lastProof ? summarizeUnitPhotoProof("Photo search", lastProof) : null;
      touchPhotoJob(job, {
        status: "failed",
        phase: "failed",
        message: replaceOnlyFailure || lastNote || proofSummary || `Couldn't find another ${input.bedrooms}BR listing`,
        progress: 100,
        finishedAt: Date.now(),
        error: replaceOnlyFailure || lastNote || proofSummary || `Couldn't find another ${input.bedrooms}BR listing at ${input.communityName}`,
        proof: lastProof,
        diagnostic: lastDiagnostic,
      });
      return;
    }

    // STATIC builder property (no draft row): persist by handing the discovered
    // source to the folder-level rescrape endpoint — the SAME single-writer path
    // the per-unit "Rescrape photos" button drives — which scrapes it, replaces
    // the unit's ACTIVE folder (downloadAndPrioritize: labels + category
    // prioritization), and re-stamps _source.json so the next "Rescrape photos"
    // re-pulls the NEW source. The draft proof ledger is draft-scoped and is
    // deliberately skipped here — sibling same-source picks are already blocked
    // by the skipUrls the client sends (each sibling's _source.json URL).
    if (staticFolderMode) {
      const targetFolder = typeof input.targetFolder === "string" ? input.targetFolder.trim() : "";
      if (!targetFolder) {
        throw new Error("No target photo folder for this unit — cannot save the discovered gallery.");
      }
      if (!sourceUrl) {
        throw new Error("Discovery returned photos without a source listing URL — cannot save the gallery.");
      }
      touchPhotoJob(job, {
        phase: "persisting",
        message: "Replacing this unit's gallery from the new source",
        progress: 86,
      });
      const persistData = await postJson(`${base}/api/builder/rescrape-unit-photos`, {
        folder: targetFolder,
        sourceUrl,
      }, 300_000);
      const savedStatic = Number(persistData?.savedCount ?? 0);
      if (savedStatic < MIN_INDEPENDENT_UNIT_PHOTOS) {
        throw new Error(`Only ${savedStatic} photo${savedStatic === 1 ? "" : "s"} saved after proof checks; at least ${MIN_INDEPENDENT_UNIT_PHOTOS} are required before replacing this unit's gallery.`);
      }
      touchPhotoJob(job, {
        status: "completed",
        phase: "completed",
        message: sameUnitPick
          ? `Found a different photo set for this exact unit on ${sameUnitPick.portal} — saved ${savedStatic} photo${savedStatic === 1 ? "" : "s"} (${sameUnitPick.newPhotoCount} new vs the previous gallery)`
          : `Saved ${savedStatic} photo${savedStatic === 1 ? "" : "s"} from the new source`,
        progress: 100,
        finishedAt: Date.now(),
        savedCount: savedStatic,
        changeNote: sameUnitPick
          ? `${sameUnitPick.newPhotoCount} new photo${sameUnitPick.newPhotoCount === 1 ? "" : "s"} vs the previous gallery`
          : null,
        sourceUrl: typeof persistData?.sourceUrl === "string" ? persistData.sourceUrl : sourceUrl,
        proof: lastProof,
        diagnostic: lastDiagnostic,
        error: null,
      });
      return;
    }

    touchPhotoJob(job, {
      phase: "persisting",
      message: "Saving photos to this draft",
      progress: 86,
    });
    const persistBody = input.unitIndex === 0
      ? { unit1Photos: photos.map((p) => p.url), unit2Photos: [], unit1SourceUrl: sourceUrl }
      : { unit1Photos: [], unit2Photos: photos.map((p) => p.url), unit2SourceUrl: sourceUrl };
    const persistData = await withDraftPhotoProofLock(input.draftId, async () => {
      const duplicateReservation = lastProof
        ? reserveDraftPhotoProof(input.draftId, input.unitIndex, lastProof)
        : null;
      if (duplicateReservation) {
        throw new Error(`${duplicateReservation} Continue candidate search; do not save duplicate photos on both units.`);
      }
      reservedProof = lastProof;
      return postJson(`${base}/api/community/${input.draftId}/persist-photos`, persistBody, 180_000);
    });
    const persistedUnit = input.unitIndex === 0 ? persistData?.unit1 : persistData?.unit2;
    const saved = persistedUnit?.saved;
    if (typeof saved === "number" && saved < MIN_INDEPENDENT_UNIT_PHOTOS) {
      throw new Error(`Only ${saved} photo${saved === 1 ? "" : "s"} saved after proof checks; at least ${MIN_INDEPENDENT_UNIT_PHOTOS} are required before replacing this unit's gallery.`);
    }

    // What actually changed vs the gallery that was on disk — so a fast re-pull
    // of the SAME listing reports "already current" instead of looking like a
    // no-op. persist-photos returns a content-fingerprint delta per unit.
    const delta = persistedUnit?.delta as
      | { changed?: boolean; added?: number; removed?: number; unchanged?: number; hadPrevious?: boolean }
      | undefined;
    const changeNote = delta && delta.hadPrevious
      ? (delta.changed
          ? `${delta.added ?? 0} new, ${delta.removed ?? 0} removed, ${delta.unchanged ?? 0} unchanged`
          : "gallery already current — no changes")
      : null;

    touchPhotoJob(job, {
      status: "completed",
      phase: "completed",
      message: (sameUnitPick
        ? `Found a different photo set for this exact unit on ${sameUnitPick.portal} — saved ${saved ?? 0} photo${saved === 1 ? "" : "s"}`
        : `Saved ${saved ?? 0} photo${saved === 1 ? "" : "s"}`) + (changeNote ? ` · ${changeNote}` : ""),
      progress: 100,
      finishedAt: Date.now(),
      savedCount: typeof saved === "number" ? saved : null,
      changeNote,
      sourceUrl,
      proof: lastProof,
      diagnostic: lastDiagnostic,
      error: null,
    });
  } catch (e: any) {
    releaseDraftPhotoProof(input.draftId, input.unitIndex, reservedProof);
    touchPhotoJob(job, {
      status: "failed",
      phase: "failed",
      message: e?.message || "Photo fetch failed",
      progress: 100,
      finishedAt: Date.now(),
      error: e?.message || "Photo fetch failed",
    });
  } finally {
    activePhotoFetchJobIds.delete(job.id);
  }
}

export function startPreflightReplacementFindJob(body: Record<string, unknown>): PreflightReplacementFindJob {
  const id = newJobId("prfj");
  const job: PreflightReplacementFindJob = {
    id,
    status: "queued",
    phase: "queued",
    message: "Queued",
    progress: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    unit: null,
    diagnostic: null,
  };
  replacementFindJobs.set(id, job);
  // Durable record first (supersedes any older running search for the same
  // property), then launch. Fail-soft — no DB just means memory-only behavior.
  persistReplacementJobRunning(job, body);
  void runPreflightReplacementFindJob(job, body);
  return job;
}

async function runPreflightReplacementFindJob(
  job: PreflightReplacementFindJob,
  body: Record<string, unknown>,
): Promise<void> {
  if (activeReplacementFindJobIds.has(job.id)) return;
  activeReplacementFindJobIds.add(job.id);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (job.status !== "running") return;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const progress = elapsed < 2
      ? 12 + elapsed * 10
      : elapsed < 90
        ? Math.min(88, 32 + elapsed * 0.6)
        : Math.min(94, 88 + (elapsed - 90) * 0.05);
    touchReplacementJob(job, {
      phase: elapsed < 2 ? "searching" : "checking",
      message: elapsed < 2
        ? "Searching Zillow, Realtor, and Redfin…"
        : elapsed > 90
          ? "Still checking candidates; this can take a few minutes"
          : "Checking Airbnb, VRBO, and Booking.com for conflicts…",
      progress,
    });
  }, 1_000);
  heartbeat.unref?.();
  try {
    touchReplacementJob(job, {
      status: "running",
      phase: "searching",
      message: "Searching Zillow, Realtor, and Redfin…",
      progress: 12,
      startedAt: Date.now(),
    });
    // Exhaustive mode ("find ALL possible replacement units", operator ask
    // 2026-07-04): keep continuing after SUCCESSFUL passes too, accumulating
    // viable units across passes until the candidate pool is drained, the
    // option target is met, or the pass cap trips. Decision logic is pure —
    // shared/replacement-search-continuation.ts (unit-tested). Legacy
    // first-hit behavior is preserved when the flag is absent.
    const collectAllOptions = body.collectAllOptions === true;
    const optionTarget = Math.max(
      1,
      Number.isFinite(Number(process.env.REPLACEMENT_EXHAUSTIVE_TARGET))
        ? Number(process.env.REPLACEMENT_EXHAUSTIVE_TARGET)
        : REPLACEMENT_EXHAUSTIVE_OPTION_TARGET_DEFAULT,
    );
    let accumulatedUnits: Array<Record<string, unknown>> = [];
    let requestBody: Record<string, unknown> = { ...body };
    let data: any = null;
    for (let pass = 0; pass <= MAX_REPLACEMENT_FIND_CONTINUATIONS; pass += 1) {
      if (pass > 0) {
        touchReplacementJob(job, {
          phase: "checking",
          message: accumulatedUnits.length > 0
            ? `${accumulatedUnits.length} option${accumulatedUnits.length === 1 ? "" : "s"} found — checking the rest of the community (pass ${pass + 1})…`
            : `Continuing search (pass ${pass + 1})…`,
          progress: Math.min(92, 40 + pass * 6),
        });
      }
      data = await postJson(
        `${loopbackBaseUrl()}/api/replacement/find-unit`,
        requestBody,
        REPLACEMENT_FIND_UNIT_LOOPBACK_TIMEOUT_MS,
      );
      const passUnits = Array.isArray(data?.units) && data.units.length > 0
        ? data.units as Array<Record<string, unknown>>
        : data?.unit
          ? [data.unit as Record<string, unknown>]
          : [];
      accumulatedUnits = mergeReplacementUnits(accumulatedUnits, passUnits);
      const diagnostic = data?.diagnostic as {
        budgetStopped?: boolean;
        capExceeded?: boolean;
        uncheckedCandidates?: Array<Record<string, unknown>>;
        attempts?: Array<{ sourceUrl?: string }>;
      } | null;
      const unchecked = Array.isArray(diagnostic?.uncheckedCandidates)
        ? diagnostic!.uncheckedCandidates!
        : [];
      const decision = decideReplacementContinuation({
        collectAllOptions,
        pass,
        maxPasses: MAX_REPLACEMENT_FIND_CONTINUATIONS,
        accumulatedUnits: accumulatedUnits.length,
        optionTarget,
        passHadUnit: passUnits.length > 0,
        passHadError: !!data?.error,
        budgetStopped: diagnostic?.budgetStopped === true,
        capExceeded: diagnostic?.capExceeded === true,
        uncheckedCount: unchecked.length,
      });
      if (decision !== "continue") break;
      // Each continuation re-checks the leftover pool with skipDiscovery, so a
      // big community drains across passes without re-discovering. Accepted
      // unit URLs join skipUrls so a later pass can't re-propose them.
      const checkedUrls = (diagnostic?.attempts ?? [])
        .map((row) => String(row?.sourceUrl ?? "").trim())
        .filter(Boolean);
      const acceptedUrls = accumulatedUnits
        .map((u) => String((u as { url?: unknown }).url ?? "").trim())
        .filter(Boolean);
      const priorSkip = Array.isArray(requestBody.skipUrls)
        ? (requestBody.skipUrls as string[])
        : [];
      requestBody = {
        ...body,
        skipDiscovery: true,
        resumeCandidates: unchecked,
        skipUrls: [...new Set([...priorSkip, ...checkedUrls, ...acceptedUrls])],
        expandedSearch: body.expandedSearch === true || requestBody.expandedSearch === true,
      };
    }
    if (accumulatedUnits.length === 0 && data?.error) {
      touchReplacementJob(job, {
        status: "failed",
        phase: "failed",
        message: data.error,
        progress: 100,
        finishedAt: Date.now(),
        error: data.error,
        diagnostic: data.diagnostic ?? null,
      });
      persistReplacementJobTerminal(job);
      return;
    }
    const foundUnitList = accumulatedUnits.length > 0 ? accumulatedUnits : null;
    touchReplacementJob(job, {
      status: "completed",
      phase: "completed",
      message: foundUnitList && foundUnitList.length > 1
        ? `${foundUnitList.length} replacement options found`
        : "Replacement unit found",
      progress: 100,
      finishedAt: Date.now(),
      unit: foundUnitList?.[0] ?? data?.unit ?? null,
      units: foundUnitList,
      diagnostic: data?.diagnostic ?? null,
      error: null,
    });
    persistReplacementJobTerminal(job);
  } catch (e: any) {
    touchReplacementJob(job, {
      status: "failed",
      phase: "failed",
      message: e?.message || "Replacement search failed",
      progress: 100,
      finishedAt: Date.now(),
      error: e?.message || "Replacement search failed",
    });
    persistReplacementJobTerminal(job);
  } finally {
    clearInterval(heartbeat);
    activeReplacementFindJobIds.delete(job.id);
  }
}

// ── Full unit audit / platform check (server-side background job) ──────────────

const AUDIT_PLATFORM_CHECK_TIMEOUT_MS = 120_000;
// One automatic re-run of units whose platform lookups errored (transient
// SearchAPI blips) before the receipt is computed — the operator should not be
// the retry loop. Route-level per-query retries live in the platform-check
// handler itself; this pass covers whole-call failures (loopback timeout, a
// platform that exhausted its in-route attempts).
const AUDIT_UNIT_RETRY_PASSES = 1;
const AUDIT_UNIT_RETRY_DELAY_MS = 2_000;
const AUDIT_DEEP_PHOTO_TIMEOUT_MS = 60_000;
// Mirrors the client's old 90×6s (~9 min) deep-photo poll ceiling.
const AUDIT_DEEP_PHOTO_POLL_TRIES = 90;
const AUDIT_DEEP_PHOTO_POLL_INTERVAL_MS = 6_000;

export type PreflightAuditUnitInput = {
  unitId: string;
  unitNumber: string;
  address: string;
  bedrooms?: number;
  photoFolder?: string;
};

export type StartPreflightAuditInput = {
  name: string;
  city: string;
  singleListing: boolean;
  fullPhotoAudit: boolean;
  units: PreflightAuditUnitInput[];
  deepPhotoFolders: string[];
};

function auditErrorUnitResult(unit: PreflightAuditUnitInput): Record<string, unknown> {
  const platform = { status: "error", url: null, detection: "Could not verify" };
  return {
    unitId: unit.unitId,
    unitNumber: unit.unitNumber,
    address: unit.address,
    platforms: { airbnb: { ...platform }, vrbo: { ...platform }, booking: { ...platform } },
  };
}

// Port of the client's receipt logic (builder-preflight.tsx) so the sticky
// confirmation is computed server-side and is accurate even when the operator
// left the tab. `outcome` is tallied across every unit's platform statuses.
function buildAuditReceipt(
  input: StartPreflightAuditInput,
  outcome: { verified: number; apiFailUnits: number; platformErrors: number; platformsChecked: number },
): PreflightAuditReceipt {
  const total = input.units.length;
  const unitWord = total === 1 ? "unit" : "units";
  const base = input.fullPhotoAudit ? "Full unit audit" : "OTA platform check";
  const allPlatformsErrored =
    outcome.platformsChecked > 0 && outcome.platformErrors >= outcome.platformsChecked;
  let success: boolean;
  let title: string;
  let detail: string;
  if (outcome.apiFailUnits > 0) {
    success = false;
    title = `${base} — connection error`;
    detail = `${outcome.apiFailUnits} of ${total} ${unitWord} couldn't be checked — the listing-check service didn't respond (timeout or API error). Results are incomplete; run it again.`;
  } else if (allPlatformsErrored) {
    success = false;
    title = `${base} — connection error`;
    detail = `Couldn't verify any of ${total} ${unitWord} — Airbnb, VRBO & Booking.com didn't respond (API error). Try running it again.`;
  } else if (outcome.platformErrors > 0) {
    success = false;
    title = `${base} — some checks didn't respond`;
    detail = `Checked ${total} ${unitWord}, but ${outcome.platformErrors} OTA lookup${outcome.platformErrors === 1 ? "" : "s"} didn't respond (API error) — results may be incomplete. Re-run to retry them.`;
  } else if (outcome.verified === 0) {
    success = false;
    title = base;
    detail = `Couldn't verify any of ${total} ${unitWord} against Airbnb, VRBO & Booking.com. Try running it again.`;
  } else {
    success = true;
    title = base;
    detail = `Checked all ${total} ${unitWord} against Airbnb, VRBO & Booking.com.`;
  }
  return { timestamp: Date.now(), success, title, detail };
}

export function startPreflightAuditJob(input: StartPreflightAuditInput): PreflightAuditJob {
  const id = newJobId("paj");
  const job: PreflightAuditJob = {
    id,
    status: "queued",
    phase: "queued",
    message: "Queued",
    progress: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    fullPhotoAudit: input.fullPhotoAudit,
    totalUnits: input.units.length,
    completedCount: 0,
    results: {},
    receipt: null,
    photoChecks: null,
    photoBudget: null,
    deepPhotoStarted: false,
    error: null,
  };
  auditJobs.set(id, job);
  void runPreflightAuditJob(job, input);
  return job;
}

async function runPreflightAuditJob(job: PreflightAuditJob, input: StartPreflightAuditInput): Promise<void> {
  if (activeAuditJobIds.has(job.id)) return;
  activeAuditJobIds.add(job.id);
  const base = loopbackBaseUrl();
  const total = input.units.length;
  try {
    touchAuditJob(job, {
      status: "running",
      phase: "text",
      message: "Searching Airbnb, VRBO & Booking.com…",
      progress: 8,
      startedAt: job.startedAt ?? Date.now(),
    });

    const recordResult = (unitId: string, result: Record<string, unknown>) => {
      const firstTime = !(unitId in job.results);
      job.results = { ...job.results, [unitId]: result };
      if (firstTime) job.completedCount = Math.min(total, job.completedCount + 1);
      // Text phase climbs to ~78%; the deep photo phase (if any) owns 78→98.
      const progress = total > 0 ? 8 + Math.round((job.completedCount / total) * 70) : 78;
      touchAuditJob(job, { progress });
    };

    // One unit's platform-check via loopback — the heavy work already lives in
    // the platform-check handler; we just drive it. Any failure (non-ok, no
    // unit in the payload, thrown fetch) becomes the all-platforms-error
    // result the retry pass below picks up.
    const checkUnitViaLoopback = async (unit: PreflightAuditUnitInput): Promise<Record<string, unknown>> => {
      const params = new URLSearchParams({
        name: input.name,
        city: input.city,
        units: JSON.stringify([
          {
            unitId: unit.unitId,
            unitNumber: unit.unitNumber,
            address: unit.address,
            photoFolder: unit.photoFolder ?? "",
            bedrooms: unit.bedrooms,
          },
        ]),
        photoMode: input.fullPhotoAudit ? "full" : "sample",
        singleListing: input.singleListing ? "1" : "0",
      });
      try {
        const resp = await fetch(`${base}/api/preflight/platform-check?${params.toString()}`, {
          headers: loopbackRequestHeaders(),
          signal: AbortSignal.timeout(AUDIT_PLATFORM_CHECK_TIMEOUT_MS),
        });
        if (!resp.ok) return auditErrorUnitResult(unit);
        const data = await resp.json().catch(() => ({}));
        const unitResult = Array.isArray(data?.units) ? data.units[0] : undefined;
        return unitResult && typeof unitResult === "object"
          ? (unitResult as Record<string, unknown>)
          : auditErrorUnitResult(unit);
      } catch {
        return auditErrorUnitResult(unit);
      }
    };

    // Same parallelism as the old client Promise.all over units.
    await Promise.all(
      input.units.map(async (unit) => {
        recordResult(unit.unitId, await checkUnitViaLoopback(unit));
      }),
    );

    // Automatic retry pass (2026-07-11): SearchAPI is non-deterministic and a
    // transient blip used to surface as the red "N OTA lookups didn't respond
    // (API error) — re-run to retry them" banner, making the OPERATOR the retry
    // loop. Units that came back with any platform "error" get ONE more
    // loopback call before the receipt is computed. The merge is additive-only
    // (mergeRetriedAuditUnitResult): a retry can heal an "error" slot but never
    // flips a decided confirmed/not-listed from the first pass.
    for (let pass = 0; pass < AUDIT_UNIT_RETRY_PASSES; pass++) {
      const retryIds = auditUnitIdsNeedingRetry(job.results);
      if (retryIds.length === 0) break;
      touchAuditJob(job, {
        message: `Retrying ${retryIds.length} lookup${retryIds.length === 1 ? "" : "s"} that didn't respond…`,
      });
      await new Promise((rr) => setTimeout(rr, AUDIT_UNIT_RETRY_DELAY_MS));
      await Promise.all(
        retryIds.map(async (unitId) => {
          const unit = input.units.find((u) => u.unitId === unitId);
          if (!unit) return;
          const retried = await checkUnitViaLoopback(unit);
          recordResult(unitId, mergeRetriedAuditUnitResult(job.results[unitId], retried));
        }),
      );
    }

    // The receipt tallies FINAL (post-retry) results so the sticky banner
    // reflects what the operator actually has, not the first pass's blips.
    const outcome = tallyPreflightAuditOutcome(job.results);
    const receipt = buildAuditReceipt(input, outcome);
    touchAuditJob(job, { receipt, progress: total > 0 ? 78 : 90 });

    // Full audit: also drive the deep reverse-image photo scan server-side. It
    // is itself a persistent job (its 24h photo-check cache survives a redeploy),
    // so even if this audit job is evicted the operator still gets the photo
    // results via the page-load read-path on return.
    if (input.fullPhotoAudit && input.deepPhotoFolders.length > 0) {
      touchAuditJob(job, {
        phase: "photo",
        message: "Reverse-image-scanning every interior photo…",
        deepPhotoStarted: true,
      });
      await runAuditDeepPhotoCheck(job, base, input.deepPhotoFolders);
    }

    touchAuditJob(job, {
      status: "completed",
      phase: "completed",
      message: receipt.detail,
      progress: 100,
      finishedAt: Date.now(),
    });
  } catch (e: any) {
    touchAuditJob(job, {
      status: "failed",
      phase: "failed",
      message: e?.message || "Unit audit failed",
      progress: 100,
      finishedAt: Date.now(),
      error: e?.message || "Unit audit failed",
    });
  } finally {
    activeAuditJobIds.delete(job.id);
  }
}

// Server-side port of the client's deep-photo poll: read once for "before"
// timestamps, kick off the run, then poll the read-path until every scanned
// folder's checkedAt advances (or the ~9-min ceiling). Results are stored on the
// job as they arrive so a watching operator sees them live.
async function runAuditDeepPhotoCheck(job: PreflightAuditJob, base: string, folders: string[]): Promise<void> {
  const setPhotoChecks = (checks: unknown, budget: unknown) => {
    if (Array.isArray(checks)) {
      const map: Record<string, unknown> = {};
      for (const c of checks) {
        if (c && typeof c === "object" && typeof (c as any).folder === "string") {
          map[(c as any).folder] = c;
        }
      }
      job.photoChecks = map;
    }
    if (budget && typeof budget === "object") job.photoBudget = budget as Record<string, unknown>;
    touchAuditJob(job);
  };

  const before: Record<string, string | undefined> = {};
  try {
    const r0 = await postJson(`${base}/api/preflight/photo-check`, { folders, run: false }, AUDIT_DEEP_PHOTO_TIMEOUT_MS);
    for (const c of (r0?.checks ?? [])) before[c.folder] = c.checkedAt;
    setPhotoChecks(r0?.checks, r0?.budget);
  } catch { /* non-fatal — start the run anyway */ }

  let started = false;
  let scanning: string[] = folders;
  try {
    const startData = await postJson(
      `${base}/api/preflight/photo-check`,
      { folders, run: true, force: true },
      AUDIT_DEEP_PHOTO_TIMEOUT_MS,
    );
    if (startData?.budget) job.photoBudget = startData.budget;
    started = startData?.started === true;
    if (Array.isArray(startData?.scanning)) scanning = startData.scanning;
    if (startData?.budgetReached) {
      touchAuditJob(job, { message: "Daily photo-check budget reached — re-run tomorrow." });
    }
  } catch { /* the read-path/page-load effect picks up cached results on return */ }

  // Nothing fresh was kicked off (cached within 24h) — the initial read already
  // stored the current results, so there's nothing to poll for.
  if (!started) return;

  for (let i = 0; i < AUDIT_DEEP_PHOTO_POLL_TRIES; i += 1) {
    await sleep(AUDIT_DEEP_PHOTO_POLL_INTERVAL_MS);
    try {
      const d2 = await postJson(`${base}/api/preflight/photo-check`, { folders, run: false }, AUDIT_DEEP_PHOTO_TIMEOUT_MS);
      setPhotoChecks(d2?.checks, d2?.budget);
      const checks: any[] = Array.isArray(d2?.checks) ? d2.checks : [];
      const allAdvanced = scanning.every((f) => {
        const row = checks.find((c) => c?.folder === f);
        return row?.checkedAt && row.checkedAt !== before[f];
      });
      if (allAdvanced) break;
    } catch { /* keep polling */ }
  }
}

// ── Per-unit rescrape (server-side background job) ────────────────────────────

const RESCRAPE_LOOPBACK_TIMEOUT_MS = 300_000;

export type StartPreflightRescrapeInput = {
  folder: string;
  sourceUrl?: string;
};

export function startPreflightRescrapeJob(input: StartPreflightRescrapeInput): PreflightRescrapeJob {
  const id = newJobId("prsj");
  const job: PreflightRescrapeJob = {
    id,
    status: "queued",
    phase: "queued",
    message: "Queued",
    progress: 6,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    folder: input.folder,
    needsUrl: false,
    savedCount: null,
    bedroomCount: null,
    bathroomCount: null,
    sourceUrl: null,
    urlSource: null,
    coverage: null,
    error: null,
  };
  rescrapeJobs.set(id, job);
  void runPreflightRescrapeJob(job, input);
  return job;
}

async function runPreflightRescrapeJob(job: PreflightRescrapeJob, input: StartPreflightRescrapeInput): Promise<void> {
  if (activeRescrapeJobIds.has(job.id)) return;
  activeRescrapeJobIds.add(job.id);
  const base = loopbackBaseUrl();
  try {
    touchRescrapeJob(job, {
      status: "running",
      phase: "scraping",
      message: "Re-pulling this unit's saved listing…",
      progress: 25,
      startedAt: Date.now(),
    });

    const body: Record<string, unknown> = { folder: input.folder };
    if (typeof input.sourceUrl === "string" && /^https?:\/\//i.test(input.sourceUrl)) {
      body.sourceUrl = input.sourceUrl.trim();
    }
    // Manual fetch (not postJson) so we can inspect the 409 `needsUrl` case
    // instead of collapsing it into a generic throw.
    const resp = await fetch(`${base}/api/builder/rescrape-unit-photos`, {
      method: "POST",
      headers: loopbackRequestHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RESCRAPE_LOOPBACK_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => ({} as any));

    if (resp.status === 409 && data?.needsUrl) {
      touchRescrapeJob(job, {
        status: "failed",
        phase: "failed",
        message: data?.error || "No source URL on file — paste the listing URL to re-pull.",
        progress: 100,
        finishedAt: Date.now(),
        needsUrl: true,
        error: data?.error || "No source URL on file for this folder.",
      });
      return;
    }
    if (!resp.ok) {
      throw new Error(data?.error || `HTTP ${resp.status}`);
    }

    touchRescrapeJob(job, {
      status: "completed",
      phase: "completed",
      message: `Re-pulled ${Number(data?.savedCount ?? 0)} photo${Number(data?.savedCount ?? 0) === 1 ? "" : "s"}`,
      progress: 100,
      finishedAt: Date.now(),
      savedCount: Number(data?.savedCount ?? 0),
      bedroomCount: Number(data?.bedroomCount ?? 0),
      bathroomCount: Number(data?.bathroomCount ?? 0),
      sourceUrl: typeof data?.sourceUrl === "string" ? data.sourceUrl : null,
      urlSource: typeof data?.urlSource === "string" ? data.urlSource : null,
      coverage: data?.coverage && typeof data.coverage === "object" ? data.coverage : null,
      error: null,
    });
  } catch (e: any) {
    touchRescrapeJob(job, {
      status: "failed",
      phase: "failed",
      message: e?.message || "Rescrape failed",
      progress: 100,
      finishedAt: Date.now(),
      error: e?.message || "Rescrape failed",
    });
  } finally {
    activeRescrapeJobIds.delete(job.id);
  }
}
