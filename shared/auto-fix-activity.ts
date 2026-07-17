// Durable, operator-facing receipts for server-run photo replacement work.
// The live auto-replace queue is intentionally dismissible; these events live
// in queue_job_events so an operator can still answer when/if an automatic
// attempt happened after the queue receipt is gone.

export const AUTO_FIX_ACTIVITY_JOB_TYPE = "auto-fix";
export const AUTO_FIX_ACTIVITY_DEFAULT_LIMIT = 100;
export const AUTO_FIX_ACTIVITY_MAX_LIMIT = 100;
export const AUTO_FIX_ACTIVITY_MESSAGE_MAX_LENGTH = 600;

export const AUTO_REPLACE_ORIGINS = [
  "operator",
  "operator-audit",
  "scheduled-audit",
  "automatic-retry",
  "legacy-recovery",
  "unknown",
] as const;

export type AutoReplaceOrigin = typeof AUTO_REPLACE_ORIGINS[number];

export const AUTO_FIX_ACTIVITY_STATUSES = [
  "started",
  "retry-scheduled",
  "retry-started",
  "succeeded",
  "failed",
  "skipped",
] as const;

export type AutoFixActivityStatus = typeof AUTO_FIX_ACTIVITY_STATUSES[number];

export type AutoFixActivityEvent = {
  id: number;
  jobId: string;
  propertyId: number;
  propertyName: string;
  unitId: string;
  unitLabel: string;
  origin: AutoReplaceOrigin;
  status: AutoFixActivityStatus;
  attemptNumber: number;
  occurredAt: string;
  scheduledFor: string | null;
  message: string;
};

export type AutoFixActivityWrite = Omit<AutoFixActivityEvent, "id" | "occurredAt"> & {
  eventKey: string;
  occurredAt: number;
};

const ORIGIN_SET = new Set<string>(AUTO_REPLACE_ORIGINS);
const STATUS_SET = new Set<string>(AUTO_FIX_ACTIVITY_STATUSES);

export function parseAutoReplaceOrigin(value: unknown): AutoReplaceOrigin {
  return typeof value === "string" && ORIGIN_SET.has(value)
    ? value as AutoReplaceOrigin
    : "unknown";
}

export function autoFixActivityEventKey(
  jobId: string,
  status: AutoFixActivityStatus,
  attemptNumber: number,
): string {
  return `${jobId}:${Math.max(0, Math.floor(attemptNumber))}:${status}`;
}

export function sanitizeAutoFixActivityText(value: unknown): string {
  const text = String(value ?? "")
    .replace(/https?:\/\/[^\s)\]}>,]+/gi, "[link omitted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, AUTO_FIX_ACTIVITY_MESSAGE_MAX_LENGTH);
}

export function normalizeAutoFixActivityLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return AUTO_FIX_ACTIVITY_DEFAULT_LIMIT;
  return Math.min(AUTO_FIX_ACTIVITY_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

type QueueEventRowLike = {
  id?: unknown;
  jobId?: unknown;
  phase?: unknown;
  message?: unknown;
  meta?: unknown;
  createdAt?: unknown;
};

export function parseAutoFixActivityRows(
  rows: readonly QueueEventRowLike[],
  limit = AUTO_FIX_ACTIVITY_DEFAULT_LIMIT,
): AutoFixActivityEvent[] {
  const out: AutoFixActivityEvent[] = [];
  const seenKeys = new Set<string>();
  const boundedLimit = normalizeAutoFixActivityLimit(limit);
  for (const row of rows) {
    if (out.length >= boundedLimit) break;
    const id = Number(row.id);
    const jobId = typeof row.jobId === "string" ? row.jobId.trim() : "";
    const status = typeof row.phase === "string" && STATUS_SET.has(row.phase)
      ? row.phase as AutoFixActivityStatus
      : null;
    const meta = row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
      ? row.meta as Record<string, unknown>
      : {};
    const eventKey = typeof meta.eventKey === "string" && meta.eventKey.trim()
      ? meta.eventKey.trim()
      : `${jobId}:${status ?? "invalid"}:${id}`;
    const occurredAtMs = row.createdAt instanceof Date
      ? row.createdAt.getTime()
      : Date.parse(String(row.createdAt ?? ""));
    const propertyId = Number(meta.propertyId);
    const attemptNumber = Number(meta.attemptNumber);
    if (!Number.isInteger(id) || id <= 0 || !jobId || !status || !Number.isFinite(occurredAtMs)
      || !Number.isFinite(propertyId) || !Number.isFinite(attemptNumber) || attemptNumber < 0
      || seenKeys.has(eventKey)) continue;
    const scheduledForMs = meta.scheduledFor == null
      ? null
      : Date.parse(String(meta.scheduledFor));
    seenKeys.add(eventKey);
    out.push({
      id,
      jobId,
      propertyId,
      propertyName: sanitizeAutoFixActivityText(meta.propertyName) || `Property ${propertyId}`,
      unitId: sanitizeAutoFixActivityText(meta.unitId),
      unitLabel: sanitizeAutoFixActivityText(meta.unitLabel) || "Unit",
      origin: parseAutoReplaceOrigin(meta.origin),
      status,
      attemptNumber: Math.floor(attemptNumber),
      occurredAt: new Date(occurredAtMs).toISOString(),
      scheduledFor: scheduledForMs != null && Number.isFinite(scheduledForMs)
        ? new Date(scheduledForMs).toISOString()
        : null,
      message: sanitizeAutoFixActivityText(row.message) || "No details recorded.",
    });
  }
  return out;
}
