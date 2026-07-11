// Unit Audit Sweep — pure decision logic (server orchestration lives in
// server/unit-audit-sweep.ts; UI in client/src/components/unit-audit-dialog.tsx).
//
// Operator ask (2026-07-11): one button per dashboard row that audits EVERY
// data aspect of a listing — duplicate photos, community match + bedroom
// coverage, OTA photo/address reposts, Claude-generated descriptions,
// AI-caught amenities, the AI cover collage, bedding/layout vs Guesty,
// pricing freshness, channels + licenses — and reports each stage honestly
// in the UI (per-stage verdict + failure reason) plus a dashboard column
// badge. PR 1 is VERIFY-ONLY: every stage checks and reports; auto-fixes
// chain in a follow-up.
//
// NAMING NOTE: "Full unit audit" is already taken — that's the builder
// pre-flight OTA platform check (shared/preflight-verdict.ts). This tool is
// the "Unit Audit Sweep" everywhere: code, endpoints, UI copy.
//
// This module is browser-safe (imported by the dashboard for the badge +
// stage labels) — keep it dependency-free and side-effect-free.

export const UNIT_AUDIT_STORE_SETTING_KEY = "unit_audit_sweeps.v1";
export const UNIT_AUDIT_REPORTS_SETTING_KEY = "unit_audit_reports.v1";
export const UNIT_AUDIT_STORE_CAP = 16;
export const UNIT_AUDIT_STORE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const UNIT_AUDIT_REPORTS_CAP = 80;
// A sweep is a chain of bounded verify calls (the longest legs — the Lens +
// vision community check and the deep OTA scan — are each ceilinged at
// ~15 min in the orchestrator), so an orphaned record older than this is a
// dead process, not a slow stage.
export const UNIT_AUDIT_RESUME_WINDOW_MS = 60 * 60 * 1000;
export const MAX_UNIT_AUDIT_RESUMES = 3;
export const STUCK_UNIT_AUDIT_ERROR =
  "The audit sweep was interrupted by server restarts and could not resume — re-run it from the Audit column.";

// Stage order IS the execution order. Photo stages run first because the
// content stages (collage, layout, descriptions) audit what the final photo
// set implies; pricing/channels close the sweep because they're independent.
export const UNIT_AUDIT_STAGE_IDS = [
  "resolve",
  "photo-dedupe",
  "photo-community",
  "ota-scan",
  "descriptions",
  "amenities",
  "cover-collage",
  "layout",
  "pricing",
  "channels",
] as const;

export type UnitAuditStageId = (typeof UNIT_AUDIT_STAGE_IDS)[number];

export const UNIT_AUDIT_STAGE_LABELS: Record<UnitAuditStageId, string> = {
  resolve: "Resolve listing",
  "photo-dedupe": "Duplicate photos",
  "photo-community": "Community match & bedrooms",
  "ota-scan": "OTA duplicate scan",
  descriptions: "Descriptions",
  amenities: "Amenities",
  "cover-collage": "Cover collage",
  layout: "Bedding & layout",
  pricing: "Pricing",
  channels: "Channels & licenses",
};

// Stage verdict vocabulary (see the PR-plan mockup):
//   pass      — verified good.
//   fixed     — was wrong, auto-fixed, re-verified (reserved for the auto-fix
//               follow-up PR; typed now so persisted reports stay parseable).
//   attention — needs a human decision; detail says exactly what + where.
//   failed    — the listing DATA is genuinely wrong (photos found on an OTA,
//               placeholder copy, layout mismatch…). Red.
//   error     — the CHECK could not run (missing key, timeout, quota).
//               Deliberately distinct from `failed`: absence of evidence must
//               never read as either a pass or a data failure (the false-Clear
//               class — see the preflight-audit-outcome lesson).
//   skipped   — not applicable (e.g. no Guesty listing mapped yet).
export type UnitAuditStageVerdict =
  | "pass"
  | "fixed"
  | "attention"
  | "failed"
  | "error"
  | "skipped";

export type UnitAuditStageResult = {
  stage: UnitAuditStageId;
  verdict: UnitAuditStageVerdict;
  /** One-line human status — always present, always specific. */
  detail: string;
  /** Expandable bullet lines (per-unit findings, links to review, etc.). */
  items?: string[];
  elapsedMs?: number;
};

export type UnitAuditJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export const UNIT_AUDIT_ACTIVE_STATUSES: UnitAuditJobStatus[] = ["queued", "running"];

export function isUnitAuditStatusActive(status: UnitAuditJobStatus): boolean {
  return UNIT_AUDIT_ACTIVE_STATUSES.includes(status);
}

export type UnitAuditJobRecord = {
  jobId: string;
  propertyId: number;
  propertyName: string;
  status: UnitAuditJobStatus;
  currentStage: UnitAuditStageId | null;
  /** Completed stage results, appended in execution order. */
  stages: UnitAuditStageResult[];
  message: string | null;
  /** Job-level failure (orchestrator crash / unresumable) — NOT a stage verdict. */
  error: string | null;
  createdAt: number;
  updatedAt: number;
  resumeCount: number;
};

// Overall verdict for a finished sweep. `error` outranks `attention` because
// an unverified stage means the operator does NOT have the all-clear.
export type UnitAuditOverallVerdict = "pass" | "attention" | "failed" | "error";

export type UnitAuditReportRecord = {
  propertyId: number;
  propertyName: string;
  jobId: string;
  finishedAt: string; // ISO
  verdict: UnitAuditOverallVerdict;
  stages: UnitAuditStageResult[];
};

const STATUSES: UnitAuditJobStatus[] = ["queued", "running", "completed", "failed", "cancelled"];
const VERDICTS: UnitAuditStageVerdict[] = ["pass", "fixed", "attention", "failed", "error", "skipped"];

function sanitizeStages(raw: unknown): UnitAuditStageResult[] {
  if (!Array.isArray(raw)) return [];
  const out: UnitAuditStageResult[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const stage = (v as any).stage;
    const verdict = (v as any).verdict;
    if (!UNIT_AUDIT_STAGE_IDS.includes(stage) || !VERDICTS.includes(verdict)) continue;
    out.push({
      stage,
      verdict,
      detail: String((v as any).detail ?? ""),
      items: Array.isArray((v as any).items)
        ? (v as any).items.filter((s: unknown) => typeof s === "string")
        : undefined,
      elapsedMs: typeof (v as any).elapsedMs === "number" ? (v as any).elapsedMs : undefined,
    });
  }
  return out;
}

export function parseUnitAuditStore(raw: string | null | undefined): Record<string, UnitAuditJobRecord> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, UnitAuditJobRecord> = {};
    for (const [jobId, v] of Object.entries(parsed as Record<string, any>)) {
      if (!jobId || !v || typeof v !== "object") continue;
      if (!STATUSES.includes(v.status)) continue;
      const propertyId = Number(v.propertyId);
      if (!Number.isFinite(propertyId) || propertyId === 0) continue;
      out[jobId] = {
        jobId,
        propertyId,
        propertyName: String(v.propertyName ?? `Property ${propertyId}`),
        status: v.status,
        currentStage: UNIT_AUDIT_STAGE_IDS.includes(v.currentStage) ? v.currentStage : null,
        stages: sanitizeStages(v.stages),
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

export function serializeUnitAuditStore(store: Record<string, UnitAuditJobRecord>, nowMs: number): string {
  const rows = Object.values(store)
    .filter((r) => nowMs - (r.updatedAt || r.createdAt) <= UNIT_AUDIT_STORE_MAX_AGE_MS)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, UNIT_AUDIT_STORE_CAP);
  return JSON.stringify(Object.fromEntries(rows.map((r) => [r.jobId, r])));
}

export function parseUnitAuditReports(raw: string | null | undefined): Record<string, UnitAuditReportRecord> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, UnitAuditReportRecord> = {};
    for (const [key, v] of Object.entries(parsed as Record<string, any>)) {
      if (!v || typeof v !== "object") continue;
      const propertyId = Number(v.propertyId);
      if (!Number.isFinite(propertyId) || propertyId === 0) continue;
      const verdict = (["pass", "attention", "failed", "error"] as const).includes(v.verdict) ? v.verdict : null;
      if (!verdict) continue;
      out[key] = {
        propertyId,
        propertyName: String(v.propertyName ?? `Property ${propertyId}`),
        jobId: String(v.jobId ?? ""),
        finishedAt: String(v.finishedAt ?? ""),
        verdict,
        stages: sanitizeStages(v.stages),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeUnitAuditReports(reports: Record<string, UnitAuditReportRecord>): string {
  const entries = Object.entries(reports)
    .sort((a, b) => String(b[1]?.finishedAt ?? "").localeCompare(String(a[1]?.finishedAt ?? "")))
    .slice(0, UNIT_AUDIT_REPORTS_CAP);
  return JSON.stringify(Object.fromEntries(entries));
}

// One active sweep per property — a double-tap must not run two concurrent
// sweeps (each burns real SearchAPI/Lens/vision budget).
export function findActiveUnitAuditJob(
  store: Record<string, UnitAuditJobRecord>,
  propertyId: number,
): UnitAuditJobRecord | null {
  for (const record of Object.values(store)) {
    if (record.propertyId !== propertyId) continue;
    if (isUnitAuditStatusActive(record.status)) return record;
  }
  return null;
}

export function shouldResumeUnitAuditJob(record: UnitAuditJobRecord, nowMs: number): boolean {
  if (!isUnitAuditStatusActive(record.status)) return false;
  if (record.resumeCount >= MAX_UNIT_AUDIT_RESUMES) return false;
  const aliveAt = record.updatedAt || record.createdAt;
  return !!aliveAt && nowMs - aliveAt <= UNIT_AUDIT_RESUME_WINDOW_MS;
}

// Active records that can never resume become an honest terminal failure so
// the column badge stops spinning (same posture as the auto-replace watchdog).
export function failStuckUnitAuditRecords(
  store: Record<string, UnitAuditJobRecord>,
  nowMs: number,
  liveJobIds: Iterable<string> = [],
): string[] {
  const live = new Set(liveJobIds);
  const failedIds: string[] = [];
  for (const record of Object.values(store)) {
    if (!isUnitAuditStatusActive(record.status) || live.has(record.jobId)) continue;
    if (shouldResumeUnitAuditJob(record, nowMs)) continue;
    record.status = "failed";
    record.error = STUCK_UNIT_AUDIT_ERROR;
    record.updatedAt = nowMs;
    failedIds.push(record.jobId);
  }
  return failedIds;
}

// Resume seam: stage results are appended only on COMPLETION, so the first
// stage id missing from `stages` is where a resumed job picks up. `resolve`
// always re-runs (its in-memory target isn't persisted) but overwrites its
// own row instead of duplicating it.
export function nextUnitAuditStage(record: UnitAuditJobRecord): UnitAuditStageId | null {
  const done = new Set(record.stages.map((s) => s.stage));
  for (const id of UNIT_AUDIT_STAGE_IDS) {
    if (!done.has(id)) return id;
  }
  return null;
}

export function upsertUnitAuditStageResult(
  stages: UnitAuditStageResult[],
  result: UnitAuditStageResult,
): UnitAuditStageResult[] {
  const next = stages.filter((s) => s.stage !== result.stage);
  next.push(result);
  // Keep persisted order canonical (execution order) regardless of upserts.
  next.sort((a, b) => UNIT_AUDIT_STAGE_IDS.indexOf(a.stage) - UNIT_AUDIT_STAGE_IDS.indexOf(b.stage));
  return next;
}

export type UnitAuditCounts = Record<UnitAuditStageVerdict, number>;

export function summarizeUnitAuditCounts(stages: UnitAuditStageResult[]): UnitAuditCounts {
  const counts: UnitAuditCounts = { pass: 0, fixed: 0, attention: 0, failed: 0, error: 0, skipped: 0 };
  for (const s of stages) counts[s.verdict] += 1;
  return counts;
}

// Severity roll-up: failed > error > attention > pass. `fixed` counts as a
// good outcome; `skipped` never drags a verdict down. An all-skipped sweep
// (shouldn't happen — resolve always reports) still rolls up as `error` so a
// degenerate report can't read green.
export function rollUpUnitAuditVerdict(stages: UnitAuditStageResult[]): UnitAuditOverallVerdict {
  const counts = summarizeUnitAuditCounts(stages);
  if (counts.failed > 0) return "failed";
  if (counts.error > 0) return "error";
  if (counts.attention > 0) return "attention";
  if (counts.pass + counts.fixed > 0) return "pass";
  return "error";
}

export function unitAuditHeadline(stages: UnitAuditStageResult[]): string {
  const c = summarizeUnitAuditCounts(stages);
  const good = [
    c.pass > 0 ? `${c.pass} passed` : null,
    c.fixed > 0 ? `${c.fixed} auto-fixed` : null,
  ].filter(Boolean).join(", ");
  const bad = [
    c.failed > 0 ? `${c.failed} failed` : null,
    c.attention > 0 ? `${c.attention} need${c.attention === 1 ? "s" : ""} your attention` : null,
    c.error > 0 ? `${c.error} could not be verified` : null,
  ].filter(Boolean).join(", ");
  if (!bad) return good ? `All checks passed — ${good}` : "No checks ran";
  return `${bad}${good ? ` — ${good}` : ""}`;
}

// Dashboard "Audit" column badge. A live sweep always wins over the last
// report; "never" renders a quiet dash.
export type UnitAuditBadge = {
  kind: "running" | "pass" | "attention" | "failed" | "error" | "never";
  label: string;
  title: string;
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function unitAuditBadge(
  report: Pick<UnitAuditReportRecord, "verdict" | "finishedAt" | "stages"> | null,
  active: Pick<UnitAuditJobRecord, "status" | "currentStage"> | null,
): UnitAuditBadge {
  if (active && isUnitAuditStatusActive(active.status)) {
    const stage = active.currentStage;
    const idx = stage ? UNIT_AUDIT_STAGE_IDS.indexOf(stage) + 1 : 0;
    const label = stage ? `${idx}/${UNIT_AUDIT_STAGE_IDS.length}` : "queued";
    return {
      kind: "running",
      label,
      title: stage
        ? `Audit sweep running — stage ${idx} of ${UNIT_AUDIT_STAGE_IDS.length}: ${UNIT_AUDIT_STAGE_LABELS[stage]}`
        : "Audit sweep queued",
    };
  }
  if (!report) {
    return { kind: "never", label: "—", title: "Never audited — click to run a full audit sweep" };
  }
  const when = shortDate(report.finishedAt);
  const c = summarizeUnitAuditCounts(report.stages);
  if (report.verdict === "pass") {
    return { kind: "pass", label: `✓ ${when}`.trim(), title: `Audit passed every check (${when}) — click for the receipt` };
  }
  if (report.verdict === "attention") {
    return { kind: "attention", label: `⚠ ${c.attention}`, title: `${c.attention} item${c.attention === 1 ? "" : "s"} need attention (${when}) — click for the receipt` };
  }
  if (report.verdict === "failed") {
    return { kind: "failed", label: `✕ ${c.failed}`, title: `${c.failed} check${c.failed === 1 ? "" : "s"} failed (${when}) — click for the receipt` };
  }
  return { kind: "error", label: "? unverified", title: `Some checks could not be verified (${when}) — click for the receipt` };
}

// Queue summary (active first, then recent terminals) — mirrors the
// auto-replace queue chip semantics.
export const UNIT_AUDIT_SURFACE_TERMINAL_MS = 2 * 60 * 60 * 1000;

export function summarizeUnitAuditQueue(
  store: Record<string, UnitAuditJobRecord>,
  nowMs: number,
): { activeCount: number; jobs: UnitAuditJobRecord[] } {
  const all = Object.values(store);
  const active = all
    .filter((r) => isUnitAuditStatusActive(r.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  const recent = all
    .filter((r) => !isUnitAuditStatusActive(r.status) && nowMs - (r.updatedAt || r.createdAt) <= UNIT_AUDIT_SURFACE_TERMINAL_MS)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  return { activeCount: active.length, jobs: [...active, ...recent] };
}
