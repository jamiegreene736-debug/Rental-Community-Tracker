import assert from "node:assert";
import {
  MAX_REPLACEMENT_SERVER_RESUMES,
  REPLACEMENT_JOB_RESUME_WINDOW_MS,
  REPLACEMENT_JOB_STORE_CAP,
  REPLACEMENT_JOB_STORE_MAX_AGE_MS,
  STUCK_REPLACEMENT_SEARCH_ERROR,
  failStuckReplacementRecords,
  parseReplacementJobStore,
  replacementJobFromTerminalRecord,
  replacementJobResumingPlaceholder,
  replacementJobStuckFallback,
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
// 2026-07-05: supersede is UNIT-scoped when both sides know their unit — a
// two-unit property (duplicate-photos popup's common case) legitimately runs
// Unit A + Unit B searches concurrently; Unit A's fresh/restarted search must
// not kill Unit B's live one. Live in-process jobs are never superseded.
{
  const store: Record<string, PersistedReplacementJobRecord> = {
    unitB: rec({ jobId: "unitB", payload: { propertyId: 23, targetUnitId: "prop23-kl-2br" } }),
    sameUnitOld: rec({ jobId: "sameUnitOld", payload: { propertyId: 23, targetUnitId: "prop23-kl-3br" } }),
    legacyNoUnit: rec({ jobId: "legacyNoUnit", payload: { propertyId: 23 } }),
    liveSibling: rec({ jobId: "liveSibling", payload: { propertyId: 23, targetUnitId: "prop23-kl-3br" } }),
  };
  supersedeRunningRecordsForProperty(store, 23, "fresh-3br", NOW, {
    targetUnitId: "prop23-kl-3br",
    liveJobIds: ["liveSibling"],
  });
  check("sibling UNIT's concurrent search survives a same-property supersede",
    store.unitB.status === "running");
  check("same-unit older search is superseded; legacy unit-less record falls back to property scope",
    store.sameUnitOld.status === "failed" && store.legacyNoUnit.status === "failed");
  check("a search live in THIS process is never superseded in the store",
    store.liveSibling.status === "running");
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

// ── deploy-burst survivability (2026-07-05 Pili Mai incident) ────────────────
check("resume cap tolerates a 5-deploy merge burst", MAX_REPLACEMENT_SERVER_RESUMES >= 5);

// ── stuck unresumable records terminalize honestly ───────────────────────────
{
  const store: Record<string, PersistedReplacementJobRecord> = {
    resumable: rec({ jobId: "resumable" }),
    liveNow: rec({ jobId: "liveNow", resumeCount: MAX_REPLACEMENT_SERVER_RESUMES }),
    capped: rec({ jobId: "capped", resumeCount: MAX_REPLACEMENT_SERVER_RESUMES }),
    stale: rec({ jobId: "stale", updatedAt: NOW - REPLACEMENT_JOB_RESUME_WINDOW_MS - 1 }),
    done: rec({ jobId: "done", status: "completed", message: "Replacement unit found" }),
  };
  const failedIds = failStuckReplacementRecords(store, NOW, ["liveNow"]).sort();
  check("cap-exhausted and stale running records become failed",
    failedIds.join(",") === "capped,stale" &&
    store.capped.status === "failed" && store.stale.status === "failed");
  check("stuck failure carries the honest error + stuckUnresumable marker",
    store.capped.error === STUCK_REPLACEMENT_SEARCH_ERROR && store.capped.stuckUnresumable === true);
  check("resumable / live / terminal records untouched",
    store.resumable.status === "running" && store.liveNow.status === "running" && store.done.status === "completed");
  const synthesized = replacementJobFromTerminalRecord(store.capped);
  check("terminalized stuck record synthesizes a failed job flagged stuckUnresumable (orchestrator restarts, client stops waiting)",
    synthesized.status === "failed" && synthesized.stuckUnresumable === true && /server restarts/i.test(synthesized.error ?? ""));
}

// ── GET fallback for a stuck record the watchdog hasn't swept yet ────────────
{
  const fallback = replacementJobStuckFallback(rec({ resumeCount: MAX_REPLACEMENT_SERVER_RESUMES }), NOW);
  check("stuck fallback is a terminal failed job (no more eternal 404s)",
    fallback.status === "failed" && fallback.stuckUnresumable === true && /server restarts/i.test(fallback.error ?? ""));
}

// ── round-trip: stuckUnresumable survives parse/serialize ────────────────────
{
  const store: Record<string, PersistedReplacementJobRecord> = {
    s: rec({ jobId: "s", status: "failed", stuckUnresumable: true, error: STUCK_REPLACEMENT_SEARCH_ERROR }),
  };
  const round = parseReplacementJobStore(serializeReplacementJobStore(store, NOW));
  check("stuckUnresumable flag survives a store round-trip", round.s.stuckUnresumable === true);
}

// ── source lock: the CLIENT half of the stuck-record contract ────────────────
// GET :jobId used to 404 for a running-unresumable record, and the 404 was the
// client's ONLY trigger for its transparent localStorage relaunch. The server
// now returns 200 failed+stuckUnresumable — the client must relaunch on that
// too, or deploy-burst victims silently lose the "safe to leave this tab"
// contract. Guards client/src/components/unit-replacement-flow.tsx.
{
  const { readFileSync } = await import("node:fs");
  const clientSrc = readFileSync(new URL("../client/src/components/unit-replacement-flow.tsx", import.meta.url), "utf8");
  check("client poll relaunches on a stuckUnresumable failed job (the old 404 path's replacement)",
    clientSrc.includes('job.stuckUnresumable === true') &&
    /stuckUnresumable === true[\s\S]{0,200}attemptAutoResume/.test(clientSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
