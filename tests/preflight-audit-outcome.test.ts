// Locks the Full-unit-audit ERROR handling (shared/preflight-audit-outcome.ts):
// honest error-vs-not-listed after the platform-check query loop, the audit
// job's additive-only retry merge, and the post-retry receipt tally — plus
// source guards on the two wired call sites so the fixes can't silently drift
// back to the old one-shot / false-not-listed shape.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  auditUnitIdsNeedingRetry,
  mergeRetriedAuditUnitResult,
  preflightPlatformFailureVerdict,
  tallyPreflightAuditOutcome,
  PREFLIGHT_AUDIT_PLATFORM_KEYS,
  type PreflightQueryRunSummary,
} from "../shared/preflight-audit-outcome";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const summary = (over: Partial<PreflightQueryRunSummary> = {}): PreflightQueryRunSummary => ({
  totalQueries: 2,
  succeededQueries: 2,
  failedQueries: 0,
  quotaHit: false,
  timedOut: false,
  lastHttpStatus: null,
  ...over,
});

const unit = (
  airbnb: string,
  vrbo: string,
  booking: string,
): Record<string, unknown> => ({
  unitId: "u1",
  platforms: {
    airbnb: { status: airbnb, url: null, detection: `airbnb ${airbnb}` },
    vrbo: { status: vrbo, url: null, detection: `vrbo ${vrbo}` },
    booking: { status: booking, url: null, detection: `booking ${booking}` },
  },
});

// ── preflightPlatformFailureVerdict ─────────────────────────────────────────────
check("every query completed → null (caller may say not-listed)",
  preflightPlatformFailureVerdict(summary()) === null);

check("quota hit → error naming the quota, never not-listed",
  (() => {
    const v = preflightPlatformFailureVerdict(summary({ succeededQueries: 0, failedQueries: 2, quotaHit: true }));
    return v?.status === "error" && /quota or rate limit/i.test(v.detection);
  })());

check("all queries timed out → error 'Search timed out'",
  (() => {
    const v = preflightPlatformFailureVerdict(summary({ succeededQueries: 0, failedQueries: 2, timedOut: true }));
    return v?.status === "error" && v.detection === "Search timed out";
  })());

check("all queries HTTP-failed → error carries the HTTP status",
  (() => {
    const v = preflightPlatformFailureVerdict(summary({ succeededQueries: 0, failedQueries: 2, lastHttpStatus: 500 }));
    return v?.status === "error" && /HTTP 500/.test(v.detection);
  })());

check("PARTIAL coverage → error (not a false not-listed), says how partial",
  (() => {
    const v = preflightPlatformFailureVerdict(summary({ succeededQueries: 1, failedQueries: 1 }));
    return v?.status === "error" && /1 of 2 searches/.test(v.detection);
  })());

// ── auditUnitIdsNeedingRetry ────────────────────────────────────────────────────
check("clean results → no retries",
  auditUnitIdsNeedingRetry({ a: unit("not-listed", "not-listed", "confirmed") }).length === 0);

check("one errored platform flags the unit for retry",
  auditUnitIdsNeedingRetry({
    a: unit("not-listed", "error", "not-listed"),
    b: unit("not-listed", "not-listed", "not-listed"),
  }).join(",") === "a");

check("missing platforms object counts as all-error → retried",
  auditUnitIdsNeedingRetry({ a: { unitId: "a" } }).join(",") === "a");

check("null/undefined results → no retries, no throw",
  auditUnitIdsNeedingRetry(null).length === 0 && auditUnitIdsNeedingRetry(undefined).length === 0);

// ── mergeRetriedAuditUnitResult (additive-only) ────────────────────────────────
check("retry heals an error slot",
  (() => {
    const merged = mergeRetriedAuditUnitResult(
      unit("not-listed", "error", "not-listed"),
      unit("confirmed", "not-listed", "confirmed"),
    ) as any;
    return merged.platforms.vrbo.status === "not-listed"
      && merged.platforms.airbnb.status === "not-listed"   // decided verdict NOT flipped
      && merged.platforms.booking.status === "not-listed"; // decided verdict NOT flipped
  })());

check("a retry that errors again never clobbers a prior non-error verdict",
  (() => {
    const merged = mergeRetriedAuditUnitResult(
      unit("confirmed", "error", "not-listed"),
      unit("error", "error", "error"),
    ) as any;
    return merged.platforms.airbnb.status === "confirmed"
      && merged.platforms.vrbo.status === "error"
      && merged.platforms.booking.status === "not-listed";
  })());

check("unit-level fields come from the first pass",
  (mergeRetriedAuditUnitResult(
    { ...unit("error", "error", "error"), address: "first" },
    { ...unit("not-listed", "not-listed", "not-listed"), address: "second" },
  ) as any).address === "first");

// ── tallyPreflightAuditOutcome ─────────────────────────────────────────────────
check("clean 2-unit audit → all verified, zero errors",
  (() => {
    const o = tallyPreflightAuditOutcome({
      a: unit("not-listed", "not-listed", "not-listed"),
      b: unit("confirmed", "not-listed", "not-listed"),
    });
    return o.verified === 2 && o.platformErrors === 0 && o.apiFailUnits === 0 && o.platformsChecked === 6;
  })());

check("screenshot regression: 1 errored lookup among 2 units → platformErrors 1, apiFail 0, both verified",
  (() => {
    const o = tallyPreflightAuditOutcome({
      a: unit("not-listed", "not-listed", "not-listed"),
      b: unit("error", "not-listed", "not-listed"),
    });
    return o.platformErrors === 1 && o.apiFailUnits === 0 && o.verified === 2 && o.platformsChecked === 6;
  })());

check("all-platform-error unit counts as apiFail (couldn't be checked)",
  (() => {
    const o = tallyPreflightAuditOutcome({
      a: unit("error", "error", "error"),
      b: unit("not-listed", "not-listed", "not-listed"),
    });
    return o.apiFailUnits === 1 && o.platformErrors === 3 && o.verified === 1;
  })());

check("platform keys stay the audit trio", PREFLIGHT_AUDIT_PLATFORM_KEYS.join(",") === "airbnb,vrbo,booking");

// ── Source guards — the wiring must not drift back ─────────────────────────────
const routesSrc = readFileSync("server/routes.ts", "utf8");
const jobsSrc = readFileSync("server/preflight-background-jobs.ts", "utf8");

check("routes.ts: platform-check returns not-listed ONLY behind the failure gate",
  routesSrc.includes("preflightPlatformFailureVerdict(summary) ?? notListedVerdict()"));

check("routes.ts: per-query retry attempts exist",
  routesSrc.includes("PREFLIGHT_QUERY_ATTEMPTS") && /PREFLIGHT_QUERY_ATTEMPTS = 2/.test(routesSrc));

check("routes.ts: quota responses fail fast (no retry hammering)",
  routesSrc.includes("isSearchApiQuotaError(resp.status") && routesSrc.includes("summary.quotaHit = true"));

check("routes.ts: the old silent non-ok continue is gone from the strict checker",
  (() => {
    const start = routesSrc.indexOf("const checkPlatformStrict");
    const end = routesSrc.indexOf("preflightPlatformFailureVerdict(summary) ?? notListedVerdict()");
    return start >= 0 && end > start && !routesSrc.slice(start, end).includes("if (!resp.ok) continue;");
  })());

check("audit job: retry pass selects errored units via the shared helper",
  jobsSrc.includes("auditUnitIdsNeedingRetry(job.results)"));

check("audit job: retry merge is the additive-only shared helper",
  jobsSrc.includes("mergeRetriedAuditUnitResult(job.results[unitId], retried)"));

check("audit job: receipt tallies FINAL post-retry results",
  jobsSrc.includes("tallyPreflightAuditOutcome(job.results)"));

check("audit job: bounded retry passes",
  /AUDIT_UNIT_RETRY_PASSES = 1/.test(jobsSrc));

assert.ok(true);
console.log(failed === 0
  ? `preflight-audit-outcome: all ${passed} checks passed`
  : `preflight-audit-outcome: ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
