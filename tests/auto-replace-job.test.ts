import assert from "node:assert";
import {
  AUTO_REPLACE_RESUME_WINDOW_MS,
  AUTO_REPLACE_STORE_CAP,
  AUTO_REPLACE_SURFACE_TERMINAL_MS,
  MAX_AUTO_REPLACE_FIND_RESTARTS,
  MAX_AUTO_REPLACE_RESUMES,
  STUCK_AUTO_REPLACE_COMMIT_ERROR,
  STUCK_AUTO_REPLACE_ERROR,
  STUCK_AUTO_REPLACE_VERIFY_ERROR,
  clearableAutoReplaceJobIds,
  draftUnitIdForSlot,
  failStuckAutoReplaceRecords,
  findActiveAutoReplaceJob,
  parseDraftUnitId,
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
// "verifying" = swap already committed; its remaining legs are cheap and
// idempotent, so the cap (which bounds SearchAPI sweeps) does not apply —
// only the window does. Abandoning it strands the Guesty photo push.
check("verifying job at the resume cap is STILL resumable (swap committed; verify legs are cheap)",
  shouldResumeAutoReplaceJob(rec({ phase: "verifying", resumeCount: MAX_AUTO_REPLACE_RESUMES }), NOW));
check("verifying job outside the window does not resume",
  !shouldResumeAutoReplaceJob(rec({ phase: "verifying", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 1 }), NOW));

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
    stuckCapped: rec({ jobId: "stuckCapped", phase: "finding", resumeCount: MAX_AUTO_REPLACE_RESUMES }),
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
    stuckCapped: rec({ jobId: "stuckCapped", phase: "committing", resumeCount: MAX_AUTO_REPLACE_RESUMES }),
    stuckVerify: rec({ jobId: "stuckVerify", phase: "verifying", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000 }),
    done: rec({ jobId: "done", phase: "completed" }),
  };
  const failedIds = failStuckAutoReplaceRecords(store, NOW, ["liveNow"]).sort();
  check("stuck records (stale window / cap exhausted) become failed",
    failedIds.join(",") === "stuckCapped,stuckStale,stuckVerify" &&
    store.stuckCapped.phase === "failed" && store.stuckStale.phase === "failed" && store.stuckVerify.phase === "failed");
  check("finding-phase stuck record carries the honest retry error",
    store.stuckStale.error === STUCK_AUTO_REPLACE_ERROR && store.stuckStale.updatedAt === NOW);
  // Phase-aware messages: a stuck verify has a COMMITTED swap — "re-run
  // Replace photos" would swap in a DIFFERENT unit; a stuck commit is ambiguous.
  check("verifying-phase stuck record says the swap committed + push-photos fallback (never 'retry Replace photos')",
    store.stuckVerify.error === STUCK_AUTO_REPLACE_VERIFY_ERROR && /do not re-run/i.test(store.stuckVerify.error ?? ""));
  check("committing-phase stuck record warns the commit may have landed",
    store.stuckCapped.error === STUCK_AUTO_REPLACE_COMMIT_ERROR && /swap history/i.test(store.stuckCapped.error ?? ""));
  check("resumable / live / terminal records untouched",
    store.running.phase === "finding" && store.liveNow.phase === "committing" && store.done.phase === "completed");
  check("a terminalized stuck record no longer blocks a retry (double-tap guard clears)",
    findActiveAutoReplaceJob({ s: store.stuckCapped }, 23, "prop23-kl-3br") === null);
}

// ── source locks: hydration failures fall through, and hydration can sidecar ─
// The Pili Mai 9K incident (2026-07-05): option 1's Redfin gallery bot-walled
// Railway ("returned 0 photos") and the whole job failed even though option 2
// scraped fine. The commit loop must burn a photo-hydration 502 like a 409,
// and POST /api/unit-swaps must hydrate with the bounded sidecar scrape tier.
{
  const { readFileSync } = await import("node:fs");
  const orch = readFileSync(new URL("../server/auto-replace-jobs.ts", import.meta.url), "utf8");
  check("commit loop burns a 502 photo-hydration failure and tries the next option",
    /status === 502 && \/photo\/i\.test/.test(orch));
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  check("POST /api/unit-swaps hydrates with the sidecar scrape tier (bot-walled galleries recover)",
    /hydrateUnitSwapPhotoFolder\(parsed\.data, \{ useSidecar: true \}\)/.test(routes));
}

// ── draft (negative-id) unit identity ─────────────────────────────────────────
// 2026-07-05 operator screenshot: flagged DRAFT rows (Waikoloa Villas Unit B —
// draft-12-unit-b / draft-13-unit-a) had NO Replace photos button because the
// popup resolver returned [] for negative ids. The whole flow now supports
// drafts; these helpers keep the client button, the orchestrator, and the
// Guesty re-push agreed on the `draft<id>-unit-a/b` id convention that
// adapt-draft.ts synthesizes and PATCH /api/unit-swaps/commit's slot parse
// expects.
check("draft unit id round-trips through parse",
  draftUnitIdForSlot(12, "b") === "draft12-unit-b" &&
  JSON.stringify(parseDraftUnitId("draft12-unit-b")) === JSON.stringify({ draftId: 12, slot: "b" }) &&
  JSON.stringify(parseDraftUnitId(draftUnitIdForSlot(7, "a"))) === JSON.stringify({ draftId: 7, slot: "a" }));
check("non-draft / malformed unit ids parse to null",
  parseDraftUnitId("prop23-kl-3br") === null &&
  parseDraftUnitId("draft-12-unit-b") === null &&
  parseDraftUnitId("draft12-unit-c") === null &&
  parseDraftUnitId(null) === null);

// ── source locks: the draft replace path exists at every seam ─────────────────
{
  const { readFileSync } = await import("node:fs");
  const orch = readFileSync(new URL("../server/auto-replace-jobs.ts", import.meta.url), "utf8");
  check("orchestrator resolves draft targets (getCommunityDraft branch)",
    orch.includes("resolveAutoReplaceTarget") && orch.includes("getCommunityDraft"));
  check("orchestrator repoints the draft after a committed swap (PATCH /api/unit-swaps/commit)",
    /target\.isDraft[\s\S]{0,400}\/api\/unit-swaps\/commit\//.test(orch));
  const repush = readFileSync(new URL("../server/guesty-photo-repush.ts", import.meta.url), "utf8");
  check("Guesty re-push assembles draft galleries (unit1/unit2 photo folders)",
    repush.includes("draftPushUnits") && repush.includes("unit1PhotoFolder"));
  const homeSrc = readFileSync(new URL("../client/src/pages/home.tsx", import.meta.url), "utf8");
  check("dashboard popup resolves draft rows to Replace buttons (no propertyId <= 0 bail)",
    homeSrc.includes("replaceBuilderLikeFor") && homeSrc.includes("draftUnitIdForSlot"));
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
