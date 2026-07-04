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

export const AUTO_REPLACE_STORE_SETTING_KEY = "auto_replace_jobs.v1";
export const AUTO_REPLACE_STORE_CAP = 12;
export const AUTO_REPLACE_STORE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Resume window is wider than the find job's own (60 min) — the orchestrator
// may legitimately outlive one find-job resume cycle.
export const AUTO_REPLACE_RESUME_WINDOW_MS = 90 * 60 * 1000;
export const MAX_AUTO_REPLACE_RESUMES = 2;
// How long a finished job stays on the dashboard queue chip.
export const AUTO_REPLACE_SURFACE_TERMINAL_MS = 2 * 60 * 60 * 1000;

export type AutoReplacePhase =
  | "queued"
  | "finding"      // replacement-find background job running
  | "committing"   // viable unit found — recording the swap / hydrating photos
  | "verifying"    // swap committed — OTA rescan + community-vision check kicked
  | "completed"
  | "failed";

export const AUTO_REPLACE_ACTIVE_PHASES: AutoReplacePhase[] = ["queued", "finding", "committing", "verifying"];

export type AutoReplaceJobRecord = {
  jobId: string;
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
  message: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  resumeCount: number;
};

export function isAutoReplacePhaseActive(phase: AutoReplacePhase): boolean {
  return AUTO_REPLACE_ACTIVE_PHASES.includes(phase);
}

const PHASES: AutoReplacePhase[] = ["queued", "finding", "committing", "verifying", "completed", "failed"];

export function parseAutoReplaceStore(raw: string | null | undefined): Record<string, AutoReplaceJobRecord> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, AutoReplaceJobRecord> = {};
    for (const [jobId, v] of Object.entries(parsed as Record<string, any>)) {
      if (!jobId || !v || typeof v !== "object") continue;
      if (!PHASES.includes(v.phase)) continue;
      const propertyId = Number(v.propertyId);
      const unitId = String(v.unitId ?? "");
      if (!Number.isFinite(propertyId) || !unitId) continue;
      out[jobId] = {
        jobId,
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
        message: typeof v.message === "string" ? v.message : null,
        error: typeof v.error === "string" ? v.error : null,
        createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
        updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
        resumeCount: typeof v.resumeCount === "number" ? v.resumeCount : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeAutoReplaceStore(store: Record<string, AutoReplaceJobRecord>, nowMs: number): string {
  const rows = Object.values(store)
    .filter((r) => nowMs - (r.updatedAt || r.createdAt) <= AUTO_REPLACE_STORE_MAX_AGE_MS)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, AUTO_REPLACE_STORE_CAP);
  return JSON.stringify(Object.fromEntries(rows.map((r) => [r.jobId, r])));
}

export function shouldResumeAutoReplaceJob(record: AutoReplaceJobRecord, nowMs: number): boolean {
  if (!isAutoReplacePhaseActive(record.phase)) return false;
  if (record.resumeCount >= MAX_AUTO_REPLACE_RESUMES) return false;
  const aliveAt = record.updatedAt || record.createdAt;
  return !!aliveAt && nowMs - aliveAt <= AUTO_REPLACE_RESUME_WINDOW_MS;
}

// One active auto-replace per property+unit — a double-tap must not launch two
// concurrent searches/commits for the same unit.
export function findActiveAutoReplaceJob(
  store: Record<string, AutoReplaceJobRecord>,
  propertyId: number,
  unitId: string,
): AutoReplaceJobRecord | null {
  for (const record of Object.values(store)) {
    if (record.propertyId !== propertyId || record.unitId !== unitId) continue;
    if (isAutoReplacePhaseActive(record.phase)) return record;
  }
  return null;
}

// What the orchestrator should do given the find job's current state.
//   wait   — find job still running (or resumable after a restart)
//   commit — find job completed with at least one viable unit
//   fail   — find job failed, vanished unresumably, or completed empty
export type AutoReplaceNextStep = "wait" | "commit" | "fail";

export function nextStepFromFindJob(findJob: {
  status?: string | null;
  unit?: unknown;
  units?: unknown;
} | null): AutoReplaceNextStep {
  if (!findJob) return "fail";
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

// Queue-chip summary: active jobs first (oldest first, the order they'll
// finish), then recently-finished ones (newest first) within the surface
// window so the operator sees the outcome without hunting.
export function summarizeAutoReplaceQueue(
  store: Record<string, AutoReplaceJobRecord>,
  nowMs: number,
): { activeCount: number; jobs: AutoReplaceJobRecord[] } {
  const all = Object.values(store);
  const active = all
    .filter((r) => isAutoReplacePhaseActive(r.phase))
    .sort((a, b) => a.createdAt - b.createdAt);
  const recent = all
    .filter((r) => !isAutoReplacePhaseActive(r.phase) && nowMs - (r.updatedAt || r.createdAt) <= AUTO_REPLACE_SURFACE_TERMINAL_MS)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  return { activeCount: active.length, jobs: [...active, ...recent] };
}
