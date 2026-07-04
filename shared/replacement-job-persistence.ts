// Durable store for background "find a replacement unit" jobs.
//
// The jobs themselves run in server MEMORY (preflight-background-jobs.ts) and
// die on every Railway redeploy / restart. Until now the only recovery was
// CLIENT-driven: the browser's localStorage payload relaunched an evicted job
// when the operator's tab polled again — which meant a restart while the
// operator was off in another app (Twitter, Messages…) stalled the search
// until they came back. This store makes the search finish WITHOUT a browser:
// each job persists a compact record in app_settings
// (REPLACEMENT_JOB_STORE_SETTING_KEY), a boot/interval watchdog re-launches
// orphaned running records under the SAME job id, and terminal results are
// snapshotted so the finished options survive a post-completion restart too.
//
// Pure helpers only (parse/serialize/decide/synthesize) — storage I/O and the
// watchdog live in server/preflight-background-jobs.ts.

export const REPLACEMENT_JOB_STORE_SETTING_KEY = "replacement_find_jobs.v1";

// Only resume a record that was recently alive — a stale record (operator gave
// up days ago) must not silently burn a fresh SearchAPI-billed search on boot.
export const REPLACEMENT_JOB_RESUME_WINDOW_MS = 60 * 60 * 1000;
// Server-side restart budget per search (the client keeps its own separate
// 3-restart cap; both exist so a crash-looping deploy can't spin forever).
export const MAX_REPLACEMENT_SERVER_RESUMES = 2;
// Keep the store small: newest records win, and anything older than a day is
// history (terminal results older than that aren't worth serving either).
export const REPLACEMENT_JOB_STORE_CAP = 10;
export const REPLACEMENT_JOB_STORE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PersistedReplacementJobStatus = "running" | "completed" | "failed";

export type PersistedReplacementJobRecord = {
  jobId: string;
  status: PersistedReplacementJobStatus;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  resumeCount: number;
  // Terminal snapshot (completed/failed):
  message?: string | null;
  error?: string | null;
  unit?: Record<string, unknown> | null;
  units?: Array<Record<string, unknown>> | null;
};

export function parseReplacementJobStore(raw: string | null | undefined): Record<string, PersistedReplacementJobRecord> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, PersistedReplacementJobRecord> = {};
    for (const [jobId, value] of Object.entries(parsed as Record<string, any>)) {
      if (!jobId || !value || typeof value !== "object") continue;
      if (value.status !== "running" && value.status !== "completed" && value.status !== "failed") continue;
      if (!value.payload || typeof value.payload !== "object") continue;
      out[jobId] = {
        jobId,
        status: value.status,
        payload: value.payload,
        createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
        resumeCount: typeof value.resumeCount === "number" ? value.resumeCount : 0,
        message: typeof value.message === "string" ? value.message : null,
        error: typeof value.error === "string" ? value.error : null,
        unit: value.unit && typeof value.unit === "object" ? value.unit : null,
        units: Array.isArray(value.units) ? value.units : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

// Newest-first cap + age eviction happen at WRITE time so the setting row
// can't grow unbounded.
export function serializeReplacementJobStore(
  store: Record<string, PersistedReplacementJobRecord>,
  nowMs: number,
): string {
  const rows = Object.values(store)
    .filter((r) => nowMs - (r.updatedAt || r.createdAt) <= REPLACEMENT_JOB_STORE_MAX_AGE_MS)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, REPLACEMENT_JOB_STORE_CAP);
  return JSON.stringify(Object.fromEntries(rows.map((r) => [r.jobId, r])));
}

export function shouldResumeReplacementJob(record: PersistedReplacementJobRecord, nowMs: number): boolean {
  if (record.status !== "running") return false;
  if (record.resumeCount >= MAX_REPLACEMENT_SERVER_RESUMES) return false;
  const aliveAt = record.updatedAt || record.createdAt;
  return !!aliveAt && nowMs - aliveAt <= REPLACEMENT_JOB_RESUME_WINDOW_MS;
}

// A NEW search for the same property supersedes any older running record —
// without this, the watchdog could resume an abandoned search alongside the
// operator's fresh one and run two SearchAPI-billed sweeps concurrently.
export function supersedeRunningRecordsForProperty(
  store: Record<string, PersistedReplacementJobRecord>,
  propertyId: unknown,
  exceptJobId: string,
  nowMs: number,
): void {
  const pid = Number(propertyId);
  if (!Number.isFinite(pid)) return;
  for (const record of Object.values(store)) {
    if (record.jobId === exceptJobId || record.status !== "running") continue;
    if (Number(record.payload?.propertyId) !== pid) continue;
    record.status = "failed";
    record.error = "Superseded by a newer search for this property";
    record.updatedAt = nowMs;
  }
}

// Job-shaped objects for the GET :jobId fallback when the in-memory job is
// gone (post-restart). Shapes mirror PreflightReplacementFindJob.
export function replacementJobFromTerminalRecord(record: PersistedReplacementJobRecord) {
  const completed = record.status === "completed";
  return {
    id: record.jobId,
    status: record.status,
    phase: record.status,
    message: record.message ?? (completed ? "Replacement unit found" : record.error ?? "Replacement search failed"),
    progress: 100,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.createdAt,
    finishedAt: record.updatedAt,
    error: completed ? null : record.error ?? record.message ?? "Replacement search failed",
    unit: record.unit ?? record.units?.[0] ?? null,
    units: record.units ?? (record.unit ? [record.unit] : null),
    diagnostic: null,
  };
}

export function replacementJobResumingPlaceholder(record: PersistedReplacementJobRecord, nowMs: number) {
  return {
    id: record.jobId,
    status: "running" as const,
    phase: "checking",
    message: "Server restarted mid-search — resuming automatically…",
    progress: 40,
    createdAt: record.createdAt,
    updatedAt: nowMs,
    startedAt: record.createdAt,
    finishedAt: null,
    error: null,
    unit: null,
    units: null,
    diagnostic: null,
  };
}
