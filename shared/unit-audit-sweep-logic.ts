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
  "photo-fix",
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
  "photo-fix": "Photo fixes",
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
  /** Auto-fix mode (PR 2): fixable stages repair + re-verify instead of only
   * flagging. Defaults ON (the operator's confirmed default); the dialog
   * checkbox and UNIT_AUDIT_AUTOFIX_DISABLED=1 turn it off. */
  autoFix: boolean;
  /** Photo fix ladder's last rung (PR 3): allow the bounded one-click unit
   * replacement when re-scrape / find-new-source can't fix the photos.
   * Default ON per the confirmed plan (max 1 replacement per unit per
   * sweep); requires autoFix; AUDIT_REPLACE_DISABLED=1 is the global kill. */
  allowReplace: boolean;
  /** Who started the sweep. "cron" = the weekly auto-audit scheduler — those
   * runs reuse the weekly photo-cron's OTA rows (wider fresh window) instead
   * of re-spending Lens budget, and default the replacement rung OFF. */
  source: "manual" | "cron";
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

// Prototype-pollution guard (CodeQL, PR #1013): store keys round-trip through
// JSON and are looked up by request-supplied ids (GET /api/unit-audit/:jobId),
// and reading `{}["__proto__"]` returns Object.prototype — so a crafted id
// could hand callers the prototype object to mutate. Both parsers build
// null-prototype maps AND drop these keys; use lookupUnitAuditRecord (own
// properties only) instead of raw indexing when the key comes from a request.
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function lookupUnitAuditRecord<T>(store: Record<string, T>, key: string): T | null {
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
}

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
    const out: Record<string, UnitAuditJobRecord> = Object.create(null);
    for (const [jobId, v] of Object.entries(parsed as Record<string, any>)) {
      if (!jobId || UNSAFE_RECORD_KEYS.has(jobId) || !v || typeof v !== "object") continue;
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
        // Records from before the auto-fix PR default ON (matches the new
        // start default) — a resumed pre-upgrade sweep behaves like a fresh one.
        autoFix: typeof v.autoFix === "boolean" ? v.autoFix : true,
        allowReplace: typeof v.allowReplace === "boolean" ? v.allowReplace : true,
        source: v.source === "cron" ? "cron" : "manual",
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
    const out: Record<string, UnitAuditReportRecord> = Object.create(null);
    for (const [key, v] of Object.entries(parsed as Record<string, any>)) {
      if (!key || UNSAFE_RECORD_KEYS.has(key) || !v || typeof v !== "object") continue;
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

// ── Auto-fix: duplicate-photo selection (PR 2, widened 2026-07-12) ───────────
// Which photos the sweep may hide WITHOUT operator review: members the dedupe
// engine pre-marked removable (keep === false; the deterministic keeper pick
// — human-touched > manual sort > gallery position > file size — stays).
//   • HASH-proven groups ("exact" ≤5 dHash / "near" ≤10 — the same image,
//     byte-identical or recompressed): always included.
//   • AI "same-scene" groups (HIGH-confidence vision only; medium was already
//     discarded by the engine): included when `includeSameScene` — the
//     operator's 2026-07-12 directive ("automate fixing all of these issues",
//     from a live receipt showing 5 same-scene review groups) overrides the
//     earlier review-only stance FOR THE AUDIT SWEEP; the Photos-tab manual
//     scan keeps its review flow. Removal stays the photo_labels.hidden
//     soft-delete behind the validated apply route (keep-one-per-group,
//     never-empty-folder), so ↺ Undo stays real and the receipt lists every
//     hidden file. AUDIT_DEDUPE_SAME_SCENE=0 restores review-only.
export type DedupeAutoFixGroupInput = {
  kind: "exact" | "near" | "same-scene";
  folder: string;
  members: Array<{ filename: string; keep: boolean }>;
};

export function dedupeAutoFixSelections(
  groups: DedupeAutoFixGroupInput[],
  opts: { includeSameScene?: boolean } = {},
): {
  remove: Array<{ folder: string; filename: string }>;
  hashGroupCount: number;
  sameSceneCount: number;
  sameSceneIncluded: boolean;
} {
  const includeSameScene = opts.includeSameScene === true;
  const remove: Array<{ folder: string; filename: string }> = [];
  let hashGroupCount = 0;
  let sameSceneCount = 0;
  for (const g of groups ?? []) {
    if (g.kind === "same-scene") {
      sameSceneCount += 1;
      if (!includeSameScene) continue;
    } else {
      hashGroupCount += 1;
    }
    for (const m of g.members ?? []) {
      if (!m.keep && m.filename) remove.push({ folder: g.folder, filename: m.filename });
    }
  }
  return { remove, hashGroupCount, sameSceneCount, sameSceneIncluded: includeSameScene };
}

// ── Auto-fix: community-folder photo cleanup (2026-07-12) ────────────────────
// The community check can FAIL on the community folder itself (per-photo RED
// mismatch votes, junk flags, cross-folder duplicates) — the live Coconut
// Plantation receipt. The remedy the operator performs by hand is the flagged-
// photo "Remove" button (photo_labels.hidden soft-delete); this selects the
// same removals automatically:
//   • per-photo RED votes (match === "no") — positively identified as a
//     different place. Yellow "uncertain" votes are NEVER auto-hidden.
//   • junk flags (floorplan/map/logo/screenshot) — resolved to files through
//     the group's photoVerdicts, same as the report UI.
//   • cross-folder duplicates where one side is the community folder — the
//     COMMUNITY copy hides (the photo survives in the unit folder, so zero
//     content is lost). Unit↔unit pairs stay review-only (which unit owns the
//     photo is a judgment call).
// A visible-count floor keeps the folder from being gutted; when the floor
// truncates, no-loss removals (cross-dupes) rank first, then junk, then RED
// votes.
export const COMMUNITY_PHOTO_FIX_FLOOR = 3;

export function communityPhotoFixSelections(input: {
  communityFolder: string;
  photoVerdicts: Array<{ id: string; folder?: string; filename?: string; match: "yes" | "no" | "uncertain" }>;
  junk: Array<{ id: string; reason?: string }>;
  duplicates: Array<{ scope: string; a: { folder: string; filename: string }; b: { folder: string; filename: string } }>;
  visibleCount: number;
  floor?: number;
}): {
  hide: Array<{ folder: string; filename: string; reason: string }>;
  skippedForFloor: number;
  reviewOnly: string[];
} {
  const floor = input.floor ?? COMMUNITY_PHOTO_FIX_FLOOR;
  const byId = new Map(input.photoVerdicts.filter((v) => v.folder && v.filename).map((v) => [v.id, v]));
  const seen = new Set<string>();
  const candidates: Array<{ folder: string; filename: string; reason: string; rank: number }> = [];
  const add = (folder: string | undefined, filename: string | undefined, reason: string, rank: number) => {
    if (!folder || !filename || folder !== input.communityFolder) return;
    const k = `${folder}/${filename}`;
    if (seen.has(k)) return;
    seen.add(k);
    candidates.push({ folder, filename, reason, rank });
  };
  const reviewOnly: string[] = [];

  for (const d of input.duplicates ?? []) {
    if (d.scope !== "cross-folder") continue;
    const aIsCommunity = d.a.folder === input.communityFolder;
    const bIsCommunity = d.b.folder === input.communityFolder;
    if (aIsCommunity !== bIsCommunity) {
      const communitySide = aIsCommunity ? d.a : d.b;
      const otherSide = aIsCommunity ? d.b : d.a;
      add(communitySide.folder, communitySide.filename, `duplicate of ${otherSide.folder}/${otherSide.filename} — unit copy kept`, 0);
    } else if (!aIsCommunity && !bIsCommunity) {
      reviewOnly.push(`${d.a.folder}/${d.a.filename} duplicates ${d.b.folder}/${d.b.filename} — two unit folders share a photo; pick the owner on the Photos tab`);
    }
  }
  for (const j of input.junk ?? []) {
    const v = byId.get(j.id);
    add(v?.folder, v?.filename, `junk: ${j.reason ?? "flagged"}`, 1);
  }
  for (const v of input.photoVerdicts ?? []) {
    if (v.match !== "no") continue;
    add(v.folder, v.filename, "flagged as a different place (red vote)", 2);
  }

  candidates.sort((a, b) => a.rank - b.rank);
  const maxHide = Math.max(0, input.visibleCount - floor);
  const hide = candidates.slice(0, maxHide).map(({ folder, filename, reason }) => ({ folder, filename, reason }));
  return { hide, skippedForFloor: candidates.length - hide.length, reviewOnly };
}

// ── Photo fix ladder (PR 3): which rungs apply to a failing unit ─────────────
// The operator's ask, bounded: "replace the photo scraping source or replace
// the unit until we can find a unit with enough bedroom photos."
//   bedroom shortfall   → re-scrape the CURRENT source (galleries grow /
//                         partial pulls heal) → find a NEW source listing →
//                         replace the unit.
//   community mismatch  → the source itself is suspect: re-scraping the same
//                         gallery can't change what community it shows, so
//                         skip straight to find-new-source → replace.
//   photos found on OTA → ANY photo of that unit is compromised (the unit is
//                         listed), so only a unit replacement helps — and the
//                         replace flow's find phase only accepts OTA-clean
//                         candidates, which is what makes its result safe.
export type PhotoFixRung = "rescrape" | "find-new" | "replace";

export function photoFixRungsForUnit(problem: {
  bedroomShort?: boolean;
  communityMismatch?: boolean;
  otaFound?: boolean;
}): PhotoFixRung[] {
  if (problem.otaFound) return ["replace"];
  if (problem.communityMismatch) return ["find-new", "replace"];
  if (problem.bedroomShort) return ["rescrape", "find-new", "replace"];
  return [];
}

// ── Cron replacement anti-churn cooldown (2026-07-12) ────────────────────────
// An UNATTENDED weekly swap must not ping-pong a unit in a community where no
// candidate can ever satisfy bedroom coverage: if the unit's photos already
// came from a swap within the cooldown and coverage is STILL short, the cron
// flags instead of swapping again. Manual sweeps are exempt — an operator
// click is an explicit ask.
export function replaceRungOnCooldown(
  lastSwapAtMs: number | null,
  nowMs: number,
  cooldownDays: number,
): boolean {
  if (lastSwapAtMs == null || !Number.isFinite(lastSwapAtMs) || cooldownDays <= 0) return false;
  return nowMs - lastSwapAtMs < cooldownDays * 24 * 60 * 60 * 1000;
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
