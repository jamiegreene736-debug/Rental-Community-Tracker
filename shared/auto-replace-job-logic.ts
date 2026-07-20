// One-click "Auto replace unit photos" job (dashboard duplicate-photos warning).
//
// Operator ask (2026-07-04): clicking "Replace photos (Unit X)" should be
// one-click-and-done — no modal, no manual candidate pick, no manual commit.
// A SERVER-side orchestrator job (server/auto-replace-jobs.ts) chains the
// existing machinery: find-replacement-unit background job → auto-COMMIT the
// first viable candidate via POST /api/unit-swaps (falling through to the
// next option on a 409 duplicate-source rejection) → kick the verification
// legs (deep OTA rescan of the new folder + the Claude-vision photo-community
// check). Progress surfaces on a dashboard queue chip; when the job lands,
// the duplicate-photos indicators refresh on their own.
//
// Pure helpers only: persisted-record store (survives Railway restarts, same
// pattern as shared/replacement-job-persistence.ts), resume rules, the
// find-job→next-step decision, commit-candidate picking, and the queue-chip
// summary. Storage/loopback I/O lives in server/auto-replace-jobs.ts.

import { parseAutoReplaceOrigin, type AutoReplaceOrigin } from "./auto-fix-activity";

export const AUTO_REPLACE_STORE_SETTING_KEY = "auto_replace_jobs.v1";
export const AUTO_REPLACE_STORE_CAP = 12;
// Unit ids are internal slugs (normally under 40 chars). Bound the persisted
// and request-facing value so advisory-lock key derivation cannot be used as
// an unbounded CPU loop.
export const AUTO_REPLACE_UNIT_ID_MAX_LENGTH = 200;
// Terminal receipts stay hidden from the UI after two hours, but remain in
// the capped store for a week so a delayed retry/deploy bridge is durable.
export const AUTO_REPLACE_STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Persistent OTA findings get a small, delayed retry budget after a safe
// PRE-COMMIT failure. The delays fit inside the store retention window, and
// attempted candidate URLs stay burned across every retry.
export const MAX_AUTO_REPLACE_RETRIES = 3;
export const AUTO_REPLACE_RETRY_BACKOFF_MS = [10 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000] as const;
// Weekly photo scans are current for seven days; one day of scheduler grace
// prevents a deployment near the boundary from discarding a valid verdict.
export const AUTO_REPLACE_PHOTO_FINDING_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
// One deploy-time bridge for failures written before retry metadata existed.
// This is intentionally narrower than an all-found-folder sweep: only a
// recent persisted failed job can be promoted.
export const AUTO_REPLACE_LEGACY_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Longer than the route's five-minute hydration ceiling; a healthy runner
// heartbeats every 30s, while a killed instance becomes reclaimable in 10m.
export const AUTO_REPLACE_RUNNER_LEASE_MS = 10 * 60 * 1000;
// Resume window is wider than the find job's own (60 min) — the orchestrator
// may legitimately outlive one find-job resume cycle.
export const AUTO_REPLACE_RESUME_WINDOW_MS = 90 * 60 * 1000;
// 2026-07-05: raised 2 → 6 alongside MAX_REPLACEMENT_SERVER_RESUMES — a
// routine 5-deploy merge burst killed the orchestrator and its find job in
// lockstep, exhausting both cap-2 budgets and pinning the queue banner.
export const MAX_AUTO_REPLACE_RESUMES = 6;
// When the find leg dies UNRESUMABLY (its own resume budget exhausted), the
// orchestrator starts a bounded number of FRESH searches instead of failing
// with the misleading "no eligible unit found". Each restart is a full
// SearchAPI sweep, so keep this small.
export const MAX_AUTO_REPLACE_FIND_RESTARTS = 2;
// Terminal error when even the fresh-search budget is exhausted.
export const STUCK_AUTO_REPLACE_ERROR =
  "The replacement search kept getting interrupted by server restarts — click Replace photos to retry.";
// Phase-aware variants (adversarial review, 2026-07-05): a stuck "verifying"
// record means the swap WAS committed — telling the operator to re-run
// Replace photos there would swap in a DIFFERENT unit on top of the first.
export const STUCK_AUTO_REPLACE_VERIFY_ERROR =
  "The swap WAS committed, but the verification + Guesty photo push were interrupted by server restarts and never confirmed — open the builder's Photos tab and use \"Push Photos to Guesty\". Do NOT re-run Replace photos (that would swap in a different unit).";
export const STUCK_AUTO_REPLACE_COMMIT_ERROR =
  "Interrupted by server restarts mid-commit — the swap may or may not have landed. Check the unit's swap history before re-running Replace photos.";
// How long a finished job stays on the dashboard queue chip.
export const AUTO_REPLACE_SURFACE_TERMINAL_MS = 2 * 60 * 60 * 1000;

// The staged community route already performs its own short evidence retry.
// A 503 after that is still infrastructure/evidence uncertainty, not a reason
// to burn a potentially-good candidate. The orchestrator retries that SAME
// URL with bounded exponential backoff before it gives up non-destructively.
export const AUTO_REPLACE_COMMUNITY_INCONCLUSIVE_MAX_ATTEMPTS = 3;
export const AUTO_REPLACE_COMMUNITY_INCONCLUSIVE_BACKOFF_BASE_MS = 2_000;

export function isStagedCommunityAuditInconclusive(status: number, data: unknown): boolean {
  return status === 503
    && !!data
    && typeof data === "object"
    && (data as { communityGateInconclusive?: unknown }).communityGateInconclusive === true;
}

/** retryNumber is one-based: the first retry waits BASE, then 2*BASE, capped. */
export function autoReplaceCommunityRetryBackoffMs(retryNumber: number): number {
  const n = Number.isFinite(retryNumber) ? Math.max(1, Math.floor(retryNumber)) : 1;
  return Math.min(15_000, AUTO_REPLACE_COMMUNITY_INCONCLUSIVE_BACKOFF_BASE_MS * (2 ** (n - 1)));
}

export type AutoReplacePhase =
  | "queued"
  | "finding"      // replacement-find background job running
  | "committing"   // viable unit found — recording the swap / hydrating photos
  | "verifying"    // swap committed — OTA rescan + community-vision check kicked
  | "retry_wait"   // safe pre-commit failure; bounded retry waits for its backoff
  | "completed"
  | "failed";

export const AUTO_REPLACE_ACTIVE_PHASES: AutoReplacePhase[] = ["queued", "finding", "committing", "verifying", "retry_wait"];

export type AutoReplaceGuestyPhotoPushOutcome = {
  status: "synced" | "not-mapped" | "skipped" | "failed";
  guestyListingId: string | null;
  photoCount: number | null;
  successCount: number | null;
  verifiedCount: number | null;
  skipped: string | null;
  error: string | null;
  completedAt: number;
};

const GUESTY_PHOTO_PUSH_STATUSES = new Set<AutoReplaceGuestyPhotoPushOutcome["status"]>([
  "synced", "not-mapped", "skipped", "failed",
]);

export function parseAutoReplaceGuestyPhotoPushOutcome(raw: unknown): AutoReplaceGuestyPhotoPushOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!GUESTY_PHOTO_PUSH_STATUSES.has(v.status as AutoReplaceGuestyPhotoPushOutcome["status"])) return null;
  const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    status: v.status as AutoReplaceGuestyPhotoPushOutcome["status"],
    guestyListingId: typeof v.guestyListingId === "string" ? v.guestyListingId : null,
    photoCount: numberOrNull(v.photoCount),
    successCount: numberOrNull(v.successCount),
    verifiedCount: numberOrNull(v.verifiedCount),
    skipped: typeof v.skipped === "string" ? v.skipped : null,
    error: typeof v.error === "string" ? v.error : null,
    completedAt: typeof v.completedAt === "number" && Number.isFinite(v.completedAt) ? v.completedAt : 0,
  };
}

// A local-only property is a valid end state. Once a Guesty listing is
// mapped, however, only an awaited, successful full-gallery push satisfies a
// strict audit; skipped/failed/legacy-missing outcomes must stay non-green.
export function autoReplaceGuestyPushSatisfied(
  outcome: AutoReplaceGuestyPhotoPushOutcome | null | undefined,
  hasMappedGuestyListing: boolean,
): boolean {
  return !hasMappedGuestyListing || outcome?.status === "synced";
}

export type AutoReplaceJobRecord = {
  jobId: string;
  // The initiating context is retained while retry events are separately
  // labeled as automatic. Older persisted records safely parse as unknown.
  origin: AutoReplaceOrigin;
  phase: AutoReplacePhase;
  propertyId: number;
  unitId: string;
  unitLabel: string;      // "Unit A (7B)" — display
  propertyName: string;
  findJobId: string | null;
  attemptedUrls: string[]; // commit attempts that 409'd — never retried
  newUnitLabel: string | null;
  newAddress: string | null;
  replacementFolder: string | null;
  /** Awaited full-gallery push receipt. Persisted with the terminal job. */
  guestyPhotoPush: AutoReplaceGuestyPhotoPushOutcome | null;
  message: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  resumeCount: number;
  // Fresh find searches launched after a find job died unresumably (bounded
  // by MAX_AUTO_REPLACE_FIND_RESTARTS; separate from resumeCount, which
  // counts orchestrator re-attaches).
  findRestarts: number;
  // Audit-ladder bedroom-shortfall replacements: the NEW gallery must
  // photograph every claimed bedroom or the commit aborts at staging and the
  // candidate is burned (a short gallery would fail the audit's re-check
  // again — the 2026-07-12 Ilikai receipt). OTA-found/manual replacements
  // leave it off: getting off compromised photos beats gallery coverage.
  requireBedroomPhotoCoverage: boolean;
  /** Strict dashboard-audit replacements stage and fully verify the candidate
   * before commit. Standalone/manual auto-replace defaults off for backwards
   * compatibility and retains its pre-existing find/commit contract. */
  requireFullCommunityAudit: boolean;
  // Automatic retries exist only for a CURRENT photo folder whose persisted
  // Airbnb/VRBO/Booking PHOTO verdict was found when the job started. The
  // watchdog re-checks the same folder at retry time and stops if it cleared.
  retryPhotoFolder: string | null;
  // Latest unit-swap row at scheduling time. "none" is an explicit snapshot;
  // null means a legacy record that never captured one.
  retryUnitSwapSnapshot: string | null;
  // Cross-process execution lease. Railway briefly runs old + new instances
  // together during deploys, so process-local maps cannot be the authority.
  runnerId: string | null;
  runnerLeaseUntil: number | null;
  autoRetryCount: number;
  nextRetryAt: number | null;
};

export function isAutoReplacePhaseActive(phase: AutoReplacePhase): boolean {
  return AUTO_REPLACE_ACTIVE_PHASES.includes(phase);
}

// ── Draft (negative-id) unit identity ─────────────────────────────────────────
// Promoted community drafts address their units as `draft<id>-unit-a/b` — the
// SAME convention client/src/data/adapt-draft.ts synthesizes for the builder
// UI and the `/-unit-([ab])$/` slot parse in PATCH /api/unit-swaps/commit
// expects. Centralized here so the dashboard button, the auto-replace
// orchestrator, and the Guesty re-push agree on the id shape (2026-07-05:
// draft rows in the duplicate-photos popup had NO Replace button at all).
export function draftUnitIdForSlot(draftId: number, slot: "a" | "b"): string {
  return `draft${draftId}-unit-${slot}`;
}

export function parseDraftUnitId(unitId: unknown): { draftId: number; slot: "a" | "b" } | null {
  const m = /^draft(\d+)-unit-([ab])$/i.exec(String(unitId ?? "").trim());
  if (!m) return null;
  const draftId = Number(m[1]);
  if (!Number.isFinite(draftId) || draftId <= 0) return null;
  return { draftId, slot: m[2].toLowerCase() as "a" | "b" };
}

const PHASES: AutoReplacePhase[] = ["queued", "finding", "committing", "verifying", "retry_wait", "completed", "failed"];

export function parseAutoReplaceStore(raw: string | null | undefined): Record<string, AutoReplaceJobRecord> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, AutoReplaceJobRecord> = {};
    for (const [jobId, v] of Object.entries(parsed as Record<string, any>)) {
      if (!jobId || !v || typeof v !== "object") continue;
      if (!PHASES.includes(v.phase)) continue;
      const propertyId = Number(v.propertyId);
      const unitId = typeof v.unitId === "string" && v.unitId.length <= AUTO_REPLACE_UNIT_ID_MAX_LENGTH
        ? v.unitId
        : "";
      if (!Number.isFinite(propertyId) || !unitId) continue;
      out[jobId] = {
        jobId,
        origin: parseAutoReplaceOrigin(v.origin),
        phase: v.phase,
        propertyId,
        unitId,
        unitLabel: String(v.unitLabel ?? unitId),
        propertyName: String(v.propertyName ?? `Property ${propertyId}`),
        findJobId: typeof v.findJobId === "string" ? v.findJobId : null,
        attemptedUrls: Array.isArray(v.attemptedUrls) ? v.attemptedUrls.filter((u: unknown) => typeof u === "string") : [],
        newUnitLabel: typeof v.newUnitLabel === "string" ? v.newUnitLabel : null,
        newAddress: typeof v.newAddress === "string" ? v.newAddress : null,
        replacementFolder: typeof v.replacementFolder === "string" ? v.replacementFolder : null,
        guestyPhotoPush: parseAutoReplaceGuestyPhotoPushOutcome(v.guestyPhotoPush),
        message: typeof v.message === "string" ? v.message : null,
        error: typeof v.error === "string" ? v.error : null,
        createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
        updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
        resumeCount: typeof v.resumeCount === "number" ? v.resumeCount : 0,
        findRestarts: typeof v.findRestarts === "number" ? v.findRestarts : 0,
        requireBedroomPhotoCoverage: v.requireBedroomPhotoCoverage === true,
        requireFullCommunityAudit: v.requireFullCommunityAudit === true,
        retryPhotoFolder: typeof v.retryPhotoFolder === "string" && v.retryPhotoFolder.trim()
          ? v.retryPhotoFolder.trim()
          : null,
        retryUnitSwapSnapshot: typeof v.retryUnitSwapSnapshot === "string" && v.retryUnitSwapSnapshot.trim()
          ? v.retryUnitSwapSnapshot.trim()
          : null,
        runnerId: typeof v.runnerId === "string" && v.runnerId.trim() ? v.runnerId.trim() : null,
        runnerLeaseUntil: typeof v.runnerLeaseUntil === "number" && Number.isFinite(v.runnerLeaseUntil) && v.runnerLeaseUntil > 0
          ? v.runnerLeaseUntil
          : null,
        autoRetryCount: typeof v.autoRetryCount === "number" && Number.isFinite(v.autoRetryCount)
          ? Math.max(0, Math.floor(v.autoRetryCount))
          : 0,
        nextRetryAt: typeof v.nextRetryAt === "number" && Number.isFinite(v.nextRetryAt) && v.nextRetryAt > 0
          ? v.nextRetryAt
          : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeAutoReplaceStore(store: Record<string, AutoReplaceJobRecord>, nowMs: number): string {
  const rows = Object.values(store)
    .filter((r) => nowMs - (r.updatedAt || r.createdAt) <= AUTO_REPLACE_STORE_MAX_AGE_MS);
  const authoritativeIds = new Set(newestAutoReplaceJobsByTarget(rows).map((record) => record.jobId));
  const retained = rows
    // Never let a CURRENT live/waiting receipt get evicted by terminal history.
    // An obsolete older active receipt is not protected: doing so could evict
    // the later terminal receipt that proves it no longer has authority.
    .sort((a, b) => Number(authoritativeIds.has(b.jobId) && isAutoReplacePhaseActive(b.phase))
      - Number(authoritativeIds.has(a.jobId) && isAutoReplacePhaseActive(a.phase))
      || (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt)
      || b.updatedAt - a.updatedAt)
    .slice(0, AUTO_REPLACE_STORE_CAP);
  return JSON.stringify(Object.fromEntries(retained.map((r) => [r.jobId, r])));
}

export function shouldResumeAutoReplaceJob(record: AutoReplaceJobRecord, nowMs: number): boolean {
  if (!isAutoReplacePhaseActive(record.phase)) return false;
  // Delayed retries have their own due-time gate and are promoted by the
  // watchdog only after it re-confirms the OTA photo finding.
  if (record.phase === "retry_wait") return false;
  // "verifying" is exempt from the resume cap: the swap is already committed
  // and the remaining legs (rescan/community-check kicks + Guesty photo push)
  // are cheap and idempotent — abandoning them strands the operator's actual
  // goal (the old unit's duplicated photos stay live on the OTAs). The resume
  // WINDOW still bounds it. The cap exists to bound repeated SearchAPI
  // sweeps, which the verify phase never runs.
  if (record.phase !== "verifying" && record.resumeCount >= MAX_AUTO_REPLACE_RESUMES) return false;
  const aliveAt = record.updatedAt || record.createdAt;
  return !!aliveAt && nowMs - aliveAt <= AUTO_REPLACE_RESUME_WINDOW_MS;
}

export function autoReplaceRetryBackoffMs(autoRetryCount: number): number {
  const index = Math.min(
    AUTO_REPLACE_RETRY_BACKOFF_MS.length - 1,
    Math.max(0, Math.floor(autoRetryCount)),
  );
  return AUTO_REPLACE_RETRY_BACKOFF_MS[index];
}

export function isAutoReplaceRetryPending(record: AutoReplaceJobRecord, nowMs: number): boolean {
  return record.phase === "retry_wait" && record.nextRetryAt != null && record.nextRetryAt > nowMs;
}

export function isAutoReplaceRetryDue(record: AutoReplaceJobRecord, nowMs: number): boolean {
  return record.phase === "retry_wait" && record.nextRetryAt != null && record.nextRetryAt <= nowMs;
}

export function planAutoReplaceRetry(
  record: AutoReplaceJobRecord,
  error: string,
  nowMs: number,
): Partial<AutoReplaceJobRecord> | null {
  // replacementFolder/newUnitLabel mean a swap reached (or may have reached)
  // the commit boundary. Automatically starting another search there is not
  // safe; those records stay terminal for human reconciliation.
  if (!(["queued", "finding", "committing", "failed"] as AutoReplacePhase[]).includes(record.phase)) return null;
  if (!record.retryPhotoFolder || record.replacementFolder || record.newUnitLabel) return null;
  if (record.autoRetryCount >= MAX_AUTO_REPLACE_RETRIES) return null;
  const nextCount = record.autoRetryCount + 1;
  const delayMs = autoReplaceRetryBackoffMs(record.autoRetryCount);
  const delayMinutes = Math.round(delayMs / 60_000);
  return {
    phase: "retry_wait",
    findJobId: null,
    // Keep the inner fresh-search counter spent across delayed retries. A
    // coverage-exhausted run that already used its two widening passes gets
    // one genuinely fresh pass per delayed retry, not another full 3-pass
    // budget (bounded SearchAPI spend).
    findRestarts: record.findRestarts,
    resumeCount: 0,
    runnerId: null,
    runnerLeaseUntil: null,
    autoRetryCount: nextCount,
    nextRetryAt: nowMs + delayMs,
    message: `Automatic retry ${nextCount}/${MAX_AUTO_REPLACE_RETRIES} scheduled after a ${delayMinutes}-minute backoff; rejected candidates stay excluded.`,
    error,
    updatedAt: nowMs,
  };
}

// Old records have no retry metadata. Only known pre-commit failure wording is
// bridgeable; ambiguous commit/repoint/verify failures must never auto-retry.
export function isLegacyAutoReplaceFailureRetryable(record: AutoReplaceJobRecord, nowMs: number): boolean {
  if (record.phase !== "failed" || record.autoRetryCount !== 0) return false;
  if (record.replacementFolder || record.newUnitLabel || record.newAddress) return false;
  const ageMs = nowMs - (record.updatedAt || record.createdAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > AUTO_REPLACE_LEGACY_RETRY_MAX_AGE_MS) return false;
  const error = String(record.error ?? "");
  if (/swap was recorded|may or may not have landed|repoint|swap history|do not re-run/i.test(error)) return false;
  return /every found option failed at commit|replacement search failed|no eligible unit found|search results were lost|replacement search did not finish|replacement search kept getting interrupted|server restarts?/i.test(error);
}

export function photoListingHasPersistentPhotoFinding(row: {
  airbnbStatus?: unknown;
  vrboStatus?: unknown;
  bookingStatus?: unknown;
  checkedAt?: unknown;
} | null | undefined, nowMs = Date.now()): boolean {
  if (!row || ![row.airbnbStatus, row.vrboStatus, row.bookingStatus].some((status) => status === "found")) return false;
  const checkedAtMs = row.checkedAt instanceof Date
    ? row.checkedAt.getTime()
    : new Date(row.checkedAt as any).getTime();
  const ageMs = nowMs - checkedAtMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= AUTO_REPLACE_PHOTO_FINDING_MAX_AGE_MS;
}

// One active auto-replace per property+unit — a double-tap must not launch two
// concurrent searches/commits for the same unit.
export function findActiveAutoReplaceJob(
  store: Record<string, AutoReplaceJobRecord>,
  propertyId: number,
  unitId: string,
): AutoReplaceJobRecord | null {
  return newestAutoReplaceJobsByTarget(Object.values(store))
    .find((record) => record.propertyId === propertyId
      && record.unitId === unitId
      && isAutoReplacePhaseActive(record.phase)) ?? null;
}

// A deploy can leave more than one historical receipt for a target. Only the
// newest receipt is authoritative: promoting an older failure after a newer
// attempt completed (or is waiting) would stack a replacement on stale intent.
export function newestAutoReplaceJobsByTarget(
  records: Iterable<AutoReplaceJobRecord>,
): AutoReplaceJobRecord[] {
  const newestByTarget = new Map<string, AutoReplaceJobRecord>();
  // Receipt generation is its creation time. updatedAt is progress/heartbeat
  // time and must not let an older runner become authoritative again after a
  // later operator attempt has already produced a newer receipt.
  const generationAt = (record: AutoReplaceJobRecord) => record.createdAt || record.updatedAt;
  const sorted = Array.from(records).sort((a, b) =>
    generationAt(b) - generationAt(a)
      || b.jobId.localeCompare(a.jobId));
  for (const record of sorted) {
    const key = JSON.stringify([record.propertyId, record.unitId]);
    if (!newestByTarget.has(key)) newestByTarget.set(key, record);
  }
  return Array.from(newestByTarget.values());
}

// What the orchestrator should do given the find job's current state.
//   wait    — find job still running (or resumable after a restart)
//   commit  — find job completed with at least one viable unit
//   restart — find job vanished or died unresumably (killed by restarts, never
//             ran to a verdict): start a FRESH search (bounded by
//             MAX_AUTO_REPLACE_FIND_RESTARTS) rather than reporting the
//             misleading "no eligible unit found"
//   fail    — find job genuinely failed or completed empty
export type AutoReplaceNextStep = "wait" | "commit" | "restart" | "fail";

export function nextStepFromFindJob(findJob: {
  status?: string | null;
  unit?: unknown;
  units?: unknown;
  stuckUnresumable?: unknown;
} | null): AutoReplaceNextStep {
  if (!findJob) return "restart";
  if (findJob.stuckUnresumable === true) return "restart";
  const status = String(findJob.status ?? "");
  if (status === "queued" || status === "running") return "wait";
  if (status === "completed") {
    const units = Array.isArray(findJob.units) ? findJob.units : findJob.unit ? [findJob.unit] : [];
    return units.length > 0 ? "commit" : "fail";
  }
  return "fail";
}

// Next commit candidate: first option whose URL hasn't already been attempted
// (a 409 duplicate-source rejection burns the URL, never retried).
// ── Replacement bedroom EXACT-match rule (2026-07-20, Cliffs Unit A 2BR→3BR) ─
// A photo replacement stands in for the SAME sellable unit, so a candidate
// must have EXACTLY the unit's configured bedroom count. Every find-unit gate
// used to be a floor (">= required", "needs at least NBR"), which let the
// 2026-07-19 weekly audit commit a 3BR gallery onto the Cliffs at Princeville
// 2BR Unit A — the swap-commit repoint then silently flipped the draft to
// 3BR (combined 7) even though the Guesty listing sells 2BR+4BR. Unknown
// counts (null) are deliberately NOT rejected here — the finder's downstream
// scrape/vision checks own those; this only rejects a POSITIVE mismatch.
export function replacementBedroomMismatch(
  required: number | null | undefined,
  candidate: number | null | undefined,
): boolean {
  if (typeof required !== "number" || !Number.isFinite(required) || required <= 0) return false;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) return false;
  return Math.round(candidate) !== Math.round(required);
}

export function pickCommitCandidate<T extends { url?: unknown }>(
  units: T[],
  attemptedUrls: string[],
): T | null {
  const attempted = new Set(attemptedUrls);
  for (const unit of units) {
    const url = String(unit?.url ?? "").trim();
    if (!url || attempted.has(url)) continue;
    return unit;
  }
  return null;
}

// Active-phase records that can never resume (cap exhausted / outside the
// window) used to pin the queue banner "active" until the 24h eviction. The
// watchdog converts them to an honest terminal failure so the operator sees
// the outcome and a retry click starts a genuinely fresh job. Records in
// liveJobIds (running in this process) are never touched. Returns failed ids.
export function failStuckAutoReplaceRecords(
  store: Record<string, AutoReplaceJobRecord>,
  nowMs: number,
  liveJobIds: Iterable<string> = [],
): string[] {
  const live = new Set(liveJobIds);
  const failedIds: string[] = [];
  for (const record of Object.values(store)) {
    if (!isAutoReplacePhaseActive(record.phase) || live.has(record.jobId)) continue;
    if (record.runnerId && (record.runnerLeaseUntil ?? 0) > nowMs) continue;
    if (record.phase === "retry_wait") continue;
    if (shouldResumeAutoReplaceJob(record, nowMs)) continue;
    // Phase-aware message — a stuck "verifying" record has a COMMITTED swap
    // (replacementFolder/newUnitLabel were persisted with the phase flip);
    // "re-run Replace photos" there would swap in a different unit.
    const error = record.phase === "verifying"
      ? STUCK_AUTO_REPLACE_VERIFY_ERROR
      : record.phase === "committing"
        ? STUCK_AUTO_REPLACE_COMMIT_ERROR
        : STUCK_AUTO_REPLACE_ERROR;
    // A queued/finding job is provably pre-commit. If it belongs to a
    // persistent OTA finding, convert the exhausted crash-resume cycle into
    // the next delayed retry instead of losing the remaining retry budget.
    if (record.phase === "queued" || record.phase === "finding") {
      const retry = planAutoReplaceRetry(record, error, nowMs);
      if (retry) {
        Object.assign(record, retry);
        continue;
      }
    }
    record.phase = "failed";
    record.error = error;
    record.updatedAt = nowMs;
    failedIds.push(record.jobId);
  }
  return failedIds;
}

// Operator "Clear queue": which records may be removed from the store.
//   • terminal jobs (completed/failed) — always clearable; the operator has
//     seen the outcome and wants the banner gone.
//   • STUCK active jobs — an active-phase record that is NOT currently running
//     in this process AND can never be resumed (resume cap hit, or outside the
//     resume window) would otherwise hold the banner spinning until the 24h
//     store eviction. Clearable.
// A job the process is actually running right now (liveJobIds) is NEVER
// cleared — mid-flight commits must not lose their record.
export function clearableAutoReplaceJobIds(
  store: Record<string, AutoReplaceJobRecord>,
  nowMs: number,
  liveJobIds: Iterable<string> = [],
): string[] {
  const live = new Set(liveJobIds);
  const authoritativeIds = new Set(newestAutoReplaceJobsByTarget(Object.values(store)).map((record) => record.jobId));
  return Object.values(store)
    .filter((record) => {
      // Remove obsolete generations together with the visible receipt. If an
      // old active row were left behind after its newer terminal tombstone was
      // cleared, it could become authoritative again and resume destructively.
      if (!authoritativeIds.has(record.jobId)) return true;
      if (live.has(record.jobId)) return false;
      if (!isAutoReplacePhaseActive(record.phase)) return true;
      if (record.runnerId && (record.runnerLeaseUntil ?? 0) > nowMs) return false;
      if (record.phase === "retry_wait") return false;
      return !shouldResumeAutoReplaceJob(record, nowMs);
    })
    .map((record) => record.jobId);
}

// Queue-chip summary: active jobs first (oldest first, the order they'll
// finish), then recently-finished ones (newest first) within the surface
// window so the operator sees the outcome without hunting.
export function summarizeAutoReplaceQueue(
  store: Record<string, AutoReplaceJobRecord>,
  nowMs: number,
): { activeCount: number; jobs: AutoReplaceJobRecord[] } {
  // Hide obsolete receipts from rolling-deploy races. In particular, an old
  // runner heartbeat must not keep the dashboard badge active after a later
  // operator attempt has completed for the same unit.
  const all = newestAutoReplaceJobsByTarget(Object.values(store));
  const active = all
    .filter((r) => isAutoReplacePhaseActive(r.phase))
    .sort((a, b) => a.createdAt - b.createdAt);
  const recent = all
    .filter((r) => !isAutoReplacePhaseActive(r.phase) && nowMs - (r.updatedAt || r.createdAt) <= AUTO_REPLACE_SURFACE_TERMINAL_MS)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  return { activeCount: active.length, jobs: [...active, ...recent] };
}
