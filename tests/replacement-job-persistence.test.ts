import assert from "node:assert";
import {
  MAX_REPLACEMENT_SERVER_RESUMES,
  REPLACEMENT_JOB_RESUME_WINDOW_MS,
  REPLACEMENT_JOB_STORE_CAP,
  REPLACEMENT_JOB_STORE_MAX_AGE_MS,
  parseReplacementJobStore,
  replacementJobFromTerminalRecord,
  replacementJobResumingPlaceholder,
  serializeReplacementJobStore,
  shouldResumeReplacementJob,
  supersedeRunningRecordsForProperty,
  type PersistedReplacementJobRecord,
} from "../shared/replacement-job-persistence";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("replacement-job-persistence: durable find-unit job store");

const NOW = Date.parse("2026-07-04T20:00:00Z");
const rec = (over: Partial<PersistedReplacementJobRecord>): PersistedReplacementJobRecord => ({
  jobId: "prfj-1",
  status: "running",
  payload: { communityFolder: "kaha-lani", propertyId: 23, targetUnitId: "prop23-kl-3br" },
  createdAt: NOW - 5 * 60_000,
  updatedAt: NOW - 5 * 60_000,
  resumeCount: 0,
  ...over,
});

// ── parse ────────────────────────────────────────────────────────────────────
{
  const store = parseReplacementJobStore(JSON.stringify({
    good: { status: "running", payload: { propertyId: 23 }, createdAt: 1, updatedAt: 2, resumeCount: 0 },
    badStatus: { status: "paused", payload: {}, createdAt: 1, updatedAt: 1 },
    noPayload: { status: "running", createdAt: 1, updatedAt: 1 },
  }));
  check("valid records kept; bad status / missing payload dropped",
    Object.keys(store).length === 1 && store.good.jobId === "good");
}
check("corrupt / empty raw → empty store",
  Object.keys(parseReplacementJobStore("{nope")).length === 0 &&
  Object.keys(parseReplacementJobStore(null)).length === 0);

// ── serialize: cap + age eviction ────────────────────────────────────────────
{
  const store: Record<string, PersistedReplacementJobRecord> = {};
  for (let i = 0; i < REPLACEMENT_JOB_STORE_CAP + 4; i++) {
    store[`j${i}`] = rec({ jobId: `j${i}`, updatedAt: NOW - i * 1000 });
  }
  store.ancient = rec({ jobId: "ancient", updatedAt: NOW - REPLACEMENT_JOB_STORE_MAX_AGE_MS - 1 });
  const round = parseReplacementJobStore(serializeReplacementJobStore(store, NOW));
  check("write-time cap keeps only the newest records",
    Object.keys(round).length === REPLACEMENT_JOB_STORE_CAP && !!round.j0 && !round[`j${REPLACEMENT_JOB_STORE_CAP + 3}`]);
  check("day-old records are evicted at write time", !round.ancient);
}

// ── shouldResume ─────────────────────────────────────────────────────────────
check("fresh running record resumes", shouldResumeReplacementJob(rec({}), NOW) === true);
check("terminal record never resumes",
  shouldResumeReplacementJob(rec({ status: "completed" }), NOW) === false &&
  shouldResumeReplacementJob(rec({ status: "failed" }), NOW) === false);
check("record outside the resume window does not resume",
  shouldResumeReplacementJob(rec({ updatedAt: NOW - REPLACEMENT_JOB_RESUME_WINDOW_MS - 1 }), NOW) === false);
check("server resume cap blocks a crash-looping deploy",
  shouldResumeReplacementJob(rec({ resumeCount: MAX_REPLACEMENT_SERVER_RESUMES }), NOW) === false);

// ── supersede ────────────────────────────────────────────────────────────────
{
  const store: Record<string, PersistedReplacementJobRecord> = {
    old: rec({ jobId: "old" }),
    otherProp: rec({ jobId: "otherProp", payload: { propertyId: 4 } }),
    fresh: rec({ jobId: "fresh" }),
  };
  supersedeRunningRecordsForProperty(store, 23, "fresh", NOW);
  check("older running search for the SAME property is superseded",
    store.old.status === "failed" && /superseded/i.test(store.old.error ?? ""));
  check("other property's search and the new job itself are untouched",
    store.otherProp.status === "running" && store.fresh.status === "running");
}

// ── synthesized jobs for the GET fallback ────────────────────────────────────
{
  const done = replacementJobFromTerminalRecord(rec({
    status: "completed",
    message: "3 replacement options found",
    units: [{ url: "https://z/1" }, { url: "https://z/2" }, { url: "https://z/3" }],
  }));
  check("completed record synthesizes a completed job with units and unit=element 0",
    done.status === "completed" && done.units?.length === 3 && (done.unit as any).url === "https://z/1" && done.progress === 100);
}
{
  const failedJob = replacementJobFromTerminalRecord(rec({ status: "failed", error: "No eligible replacement units found." }));
  check("failed record synthesizes a failed job with the error",
    failedJob.status === "failed" && /no eligible/i.test(failedJob.error ?? ""));
}
{
  const ph = replacementJobResumingPlaceholder(rec({}), NOW);
  check("resuming placeholder is a RUNNING job (stops the client's duplicate relaunch)",
    ph.status === "running" && /resuming/i.test(ph.message));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
