import assert from "node:assert";
import {
  AUTO_REPLACE_RESUME_WINDOW_MS,
  AUTO_REPLACE_STORE_CAP,
  AUTO_REPLACE_SURFACE_TERMINAL_MS,
  MAX_AUTO_REPLACE_FIND_RESTARTS,
  MAX_AUTO_REPLACE_RESUMES,
  STUCK_AUTO_REPLACE_ERROR,
  clearableAutoReplaceJobIds,
  failStuckAutoReplaceRecords,
  findActiveAutoReplaceJob,
  nextStepFromFindJob,
  parseAutoReplaceStore,
  pickCommitCandidate,
  serializeAutoReplaceStore,
  shouldResumeAutoReplaceJob,
  summarizeAutoReplaceQueue,
  type AutoReplaceJobRecord,
} from "../shared/auto-replace-job-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("auto-replace-job: one-click replace orchestration logic");

const NOW = Date.parse("2026-07-04T22:00:00Z");
const rec = (over: Partial<AutoReplaceJobRecord>): AutoReplaceJobRecord => ({
  jobId: "arj-1",
  phase: "finding",
  propertyId: 23,
  unitId: "prop23-kl-3br",
  unitLabel: "Unit A (339)",
  propertyName: "Incredible 5 bedrooms",
  findJobId: "prfj-1",
  attemptedUrls: [],
  newUnitLabel: null,
  newAddress: null,
  replacementFolder: null,
  message: null,
  error: null,
  createdAt: NOW - 5 * 60_000,
  updatedAt: NOW - 60_000,
  resumeCount: 0,
  findRestarts: 0,
  ...over,
});

// ── store parse/serialize ────────────────────────────────────────────────────
{
  const store = parseAutoReplaceStore(JSON.stringify({
    good: { phase: "finding", propertyId: 23, unitId: "u", createdAt: 1, updatedAt: 2 },
    badPhase: { phase: "paused", propertyId: 23, unitId: "u" },
    noUnit: { phase: "finding", propertyId: 23 },
  }));
  check("valid records kept; bad phase / missing unit dropped",
    Object.keys(store).length === 1 && store.good.unitLabel === "u");
}
check("corrupt raw → empty store", Object.keys(parseAutoReplaceStore("{x")).length === 0);
{
  const store: Record<string, AutoReplaceJobRecord> = {};
  for (let i = 0; i < AUTO_REPLACE_STORE_CAP + 3; i++) store[`j${i}`] = rec({ jobId: `j${i}`, updatedAt: NOW - i * 1000 });
  const round = parseAutoReplaceStore(serializeAutoReplaceStore(store, NOW));
  check("write-time cap keeps the newest records", Object.keys(round).length === AUTO_REPLACE_STORE_CAP && !!round.j0);
}

// ── resume rules ─────────────────────────────────────────────────────────────
check("active fresh record resumes", shouldResumeAutoReplaceJob(rec({}), NOW) === true);
check("terminal record never resumes",
  !shouldResumeAutoReplaceJob(rec({ phase: "completed" }), NOW) && !shouldResumeAutoReplaceJob(rec({ phase: "failed" }), NOW));
check("stale record outside the window does not resume",
  !shouldResumeAutoReplaceJob(rec({ updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 1 }), NOW));
check("resume cap blocks crash loops", !shouldResumeAutoReplaceJob(rec({ resumeCount: MAX_AUTO_REPLACE_RESUMES }), NOW));

// ── one active job per property+unit ─────────────────────────────────────────
{
  const store = { a: rec({ jobId: "a" }), b: rec({ jobId: "b", phase: "completed" }) };
  check("running job for the same property+unit is found (double-tap guard)",
    findActiveAutoReplaceJob(store, 23, "prop23-kl-3br")?.jobId === "a");
  check("terminal job does not block a new run",
    findActiveAutoReplaceJob({ b: store.b }, 23, "prop23-kl-3br") === null);
  check("other unit is not blocked", findActiveAutoReplaceJob(store, 23, "other-unit") === null);
}

// ── next step from find job ──────────────────────────────────────────────────
check("running find job → wait", nextStepFromFindJob({ status: "running" }) === "wait");
check("completed with units → commit", nextStepFromFindJob({ status: "completed", units: [{ url: "u" }] }) === "commit");
check("completed with only legacy `unit` → commit", nextStepFromFindJob({ status: "completed", unit: { url: "u" } }) === "commit");
check("completed EMPTY → fail (never commit nothing)", nextStepFromFindJob({ status: "completed" }) === "fail");
check("failed find job → fail", nextStepFromFindJob({ status: "failed" }) === "fail");
// 2026-07-05: a VANISHED or stuck-unresumable find job never reached a verdict
// (killed by a deploy burst) — the orchestrator starts a FRESH search instead
// of reporting the misleading "no eligible unit found".
check("vanished find job → restart (fresh search, not a fake 'no units')", nextStepFromFindJob(null) === "restart");
check("stuck-unresumable find job → restart", nextStepFromFindJob({ status: "failed", stuckUnresumable: true }) === "restart");
check("fresh-search budget is bounded", MAX_AUTO_REPLACE_FIND_RESTARTS >= 1 && MAX_AUTO_REPLACE_FIND_RESTARTS <= 3);
check("resume cap tolerates a 5-deploy merge burst", MAX_AUTO_REPLACE_RESUMES >= 5);

// ── commit candidate picking ─────────────────────────────────────────────────
{
  const units = [{ url: "https://z/1" }, { url: "https://z/2" }, { url: "" }];
  check("first option picked when nothing attempted", pickCommitCandidate(units, [])?.url === "https://z/1");
  check("409-burned url falls through to the next option",
    pickCommitCandidate(units, ["https://z/1"])?.url === "https://z/2");
  check("all options burned → null (job fails honestly)",
    pickCommitCandidate(units, ["https://z/1", "https://z/2"]) === null);
}

// ── queue summary ────────────────────────────────────────────────────────────
{
  const store = {
    oldActive: rec({ jobId: "oldActive", createdAt: NOW - 10 * 60_000 }),
    newActive: rec({ jobId: "newActive", createdAt: NOW - 60_000, phase: "verifying" }),
    doneRecent: rec({ jobId: "doneRecent", phase: "completed", updatedAt: NOW - 5 * 60_000 }),
    doneOld: rec({ jobId: "doneOld", phase: "completed", updatedAt: NOW - AUTO_REPLACE_SURFACE_TERMINAL_MS - 1 }),
  };
  const q = summarizeAutoReplaceQueue(store, NOW);
  check("active jobs first (oldest first), then recent terminals; stale terminals dropped",
    q.activeCount === 2 &&
    q.jobs.map((j) => j.jobId).join(",") === "oldActive,newActive,doneRecent");
}

// ── operator "Clear queue" ───────────────────────────────────────────────────
{
  const store = {
    done: rec({ jobId: "done", phase: "completed" }),
    dead: rec({ jobId: "dead", phase: "failed" }),
    running: rec({ jobId: "running", phase: "finding", updatedAt: NOW - 60_000 }),
    liveNow: rec({ jobId: "liveNow", phase: "committing", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000 }),
    stuckStale: rec({ jobId: "stuckStale", phase: "finding", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000 }),
    stuckCapped: rec({ jobId: "stuckCapped", phase: "verifying", resumeCount: MAX_AUTO_REPLACE_RESUMES }),
  };
  const cleared = clearableAutoReplaceJobIds(store, NOW, ["liveNow"]).sort();
  check("terminal jobs are clearable", cleared.includes("done") && cleared.includes("dead"));
  check("resumable active job is NOT clearable", !cleared.includes("running"));
  check("actually-running job is NEVER clearable, even when it looks stale", !cleared.includes("liveNow"));
  check("stuck active job outside the resume window IS clearable", cleared.includes("stuckStale"));
  check("stuck active job at the resume cap IS clearable", cleared.includes("stuckCapped"));
  check("exactly the expected set clears", cleared.join(",") === "dead,done,stuckCapped,stuckStale");
  check("empty store clears nothing", clearableAutoReplaceJobIds({}, NOW).length === 0);
}

// ── watchdog terminalizes stuck unresumable records ──────────────────────────
{
  const store = {
    running: rec({ jobId: "running", phase: "finding", updatedAt: NOW - 60_000 }),
    liveNow: rec({ jobId: "liveNow", phase: "committing", resumeCount: MAX_AUTO_REPLACE_RESUMES }),
    stuckStale: rec({ jobId: "stuckStale", phase: "finding", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000 }),
    stuckCapped: rec({ jobId: "stuckCapped", phase: "verifying", resumeCount: MAX_AUTO_REPLACE_RESUMES }),
    done: rec({ jobId: "done", phase: "completed" }),
  };
  const failedIds = failStuckAutoReplaceRecords(store, NOW, ["liveNow"]).sort();
  check("stuck records (stale window / cap exhausted) become failed",
    failedIds.join(",") === "stuckCapped,stuckStale" &&
    store.stuckCapped.phase === "failed" && store.stuckStale.phase === "failed");
  check("stuck records carry the honest restart error",
    store.stuckCapped.error === STUCK_AUTO_REPLACE_ERROR && store.stuckCapped.updatedAt === NOW);
  check("resumable / live / terminal records untouched",
    store.running.phase === "finding" && store.liveNow.phase === "committing" && store.done.phase === "completed");
  check("a terminalized stuck record no longer blocks a retry (double-tap guard clears)",
    findActiveAutoReplaceJob({ s: store.stuckCapped }, 23, "prop23-kl-3br") === null);
}

// ── parse: findRestarts defaults for legacy records ──────────────────────────
{
  const store = parseAutoReplaceStore(JSON.stringify({
    legacy: { phase: "finding", propertyId: 23, unitId: "u", createdAt: 1, updatedAt: 2 },
    counted: { phase: "finding", propertyId: 23, unitId: "u", createdAt: 1, updatedAt: 2, findRestarts: 2 },
  }));
  check("legacy record without findRestarts parses to 0; explicit value kept",
    store.legacy.findRestarts === 0 && store.counted.findRestarts === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
