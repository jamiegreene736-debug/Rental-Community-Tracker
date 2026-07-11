// Pure decision logic for the builder Pre-Flight "Full unit audit" ERROR handling.
//
// Two failure modes fed the red "some checks didn't respond (API error)" banner and,
// worse, a silent false "Not listed":
//   1. `checkPlatformStrict` (routes.ts /api/preflight/platform-check) wrapped its whole
//      query loop in ONE try/catch — a single SearchAPI timeout aborted the remaining
//      queries and marked the entire platform "error" with no retry.
//   2. A non-ok SearchAPI response (429 quota / 5xx) silently `continue`d — when EVERY
//      query failed that way the loop fell through to notListedVerdict(), a decisive
//      "No matching listing found" with ZERO evidence. That false-clear is the dangerous
//      direction (see AGENTS.md #721: no false Clear).
//
// This module holds the pure pieces both fixes share:
//   • preflightPlatformFailureVerdict — after the (now per-query-retried) query loop,
//     decide whether the platform verdict may honestly be "not-listed" (every query
//     actually ran) or must be "error" (coverage was incomplete), with a specific
//     operator-facing reason.
//   • auditUnitIdsNeedingRetry / mergeRetriedAuditUnitResult — the audit job's ONE
//     automatic retry pass over units that came back with platform errors. The merge is
//     purely additive: a decided verdict (confirmed / not-listed) from the first pass is
//     NEVER flipped by a retry — only "error" slots are filled in.
//   • tallyPreflightAuditOutcome — the receipt tally, recomputed from FINAL results so
//     the sticky banner reflects the post-retry state.

export const PREFLIGHT_AUDIT_PLATFORM_KEYS = ["airbnb", "vrbo", "booking"] as const;
export type PreflightAuditPlatformKey = (typeof PREFLIGHT_AUDIT_PLATFORM_KEYS)[number];

/** Platform statuses that count as a decisive, trustworthy answer for the receipt. */
const DECISIVE_PLATFORM_STATUSES = new Set(["confirmed", "photo-confirmed", "not-listed"]);

export type PreflightAuditOutcome = {
  verified: number;
  apiFailUnits: number;
  platformErrors: number;
  platformsChecked: number;
};

export type PreflightQueryRunSummary = {
  totalQueries: number;
  succeededQueries: number;
  failedQueries: number;
  /** SearchAPI signalled quota / rate-limit exhaustion (429 or quota body). */
  quotaHit: boolean;
  /** At least one attempt died on the 12s abort timer. */
  timedOut: boolean;
  lastHttpStatus: number | null;
};

/**
 * Decide the platform verdict AFTER the query loop ran. Returns null when every
 * query genuinely completed (caller may return its match verdict or an honest
 * "not-listed"); otherwise an "error" verdict whose detection says what actually
 * happened. Partial coverage must NOT claim "not-listed" — a unit could be listed
 * on exactly the query that failed.
 */
export function preflightPlatformFailureVerdict(
  summary: PreflightQueryRunSummary,
): { status: "error"; url: null; detection: string } | null {
  if (summary.failedQueries <= 0) return null;
  let detection: string;
  if (summary.quotaHit) {
    detection = "Search quota or rate limit hit — could not verify; re-run shortly.";
  } else if (summary.succeededQueries <= 0) {
    detection = summary.timedOut
      ? "Search timed out"
      : `Search service error${summary.lastHttpStatus ? ` (HTTP ${summary.lastHttpStatus})` : ""} — could not verify`;
  } else {
    detection = `${summary.failedQueries} of ${summary.totalQueries} searches didn't respond — could not fully verify`;
  }
  return { status: "error", url: null, detection };
}

type UnitResultLike = { platforms?: Record<string, { status?: unknown } | undefined> } | null | undefined;

function platformStatus(result: UnitResultLike, key: PreflightAuditPlatformKey): string {
  const status = (result as { platforms?: Record<string, { status?: unknown } | undefined> } | null | undefined)
    ?.platforms?.[key]?.status;
  return typeof status === "string" && status ? status : "error";
}

export function unitHasPlatformError(result: unknown): boolean {
  return PREFLIGHT_AUDIT_PLATFORM_KEYS.some((key) => platformStatus(result as UnitResultLike, key) === "error");
}

/** Units whose result carries ANY platform "error" — candidates for the automatic retry pass. */
export function auditUnitIdsNeedingRetry(results: Record<string, unknown> | null | undefined): string[] {
  if (!results) return [];
  return Object.keys(results).filter((unitId) => unitHasPlatformError(results[unitId]));
}

/**
 * Merge a retried unit result into the first-pass result. Additive only: for each
 * platform the FIRST non-error verdict wins — a retry can heal an "error" slot but
 * can never flip a decided confirmed/not-listed (SearchAPI is non-deterministic;
 * re-running the same queries must not toggle a verdict the operator already saw).
 */
export function mergeRetriedAuditUnitResult(prior: unknown, retried: unknown): Record<string, unknown> {
  const priorResult = (prior ?? {}) as Record<string, unknown>;
  const retriedResult = (retried ?? {}) as Record<string, unknown>;
  const priorPlatforms = (priorResult.platforms ?? {}) as Record<string, unknown>;
  const retriedPlatforms = (retriedResult.platforms ?? {}) as Record<string, unknown>;
  const platforms: Record<string, unknown> = { ...priorPlatforms };
  for (const key of PREFLIGHT_AUDIT_PLATFORM_KEYS) {
    if (platformStatus(priorResult as UnitResultLike, key) === "error"
      && platformStatus(retriedResult as UnitResultLike, key) !== "error") {
      platforms[key] = retriedPlatforms[key];
    }
  }
  return { ...priorResult, platforms };
}

/**
 * Receipt tally over FINAL per-unit results (post-retry). Mirrors the legacy
 * incremental tally: platformsChecked counts 3 per unit, apiFailUnits = a unit
 * whose EVERY platform errored ("couldn't be checked"), verified = a unit with at
 * least one decisive platform answer.
 */
export function tallyPreflightAuditOutcome(results: Record<string, unknown> | null | undefined): PreflightAuditOutcome {
  const outcome: PreflightAuditOutcome = { verified: 0, apiFailUnits: 0, platformErrors: 0, platformsChecked: 0 };
  for (const unitId of Object.keys(results ?? {})) {
    const statuses = PREFLIGHT_AUDIT_PLATFORM_KEYS.map((key) => platformStatus((results as Record<string, unknown>)[unitId] as UnitResultLike, key));
    outcome.platformsChecked += statuses.length;
    const errors = statuses.filter((s) => s === "error").length;
    outcome.platformErrors += errors;
    if (errors >= statuses.length) outcome.apiFailUnits += 1;
    if (statuses.some((s) => DECISIVE_PLATFORM_STATUSES.has(s))) outcome.verified += 1;
  }
  return outcome;
}
