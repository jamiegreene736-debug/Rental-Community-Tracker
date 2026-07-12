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
  requireBedroomPhotoCoverage: false,
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
    /status === 502 && \(data\?\.coverageShort === true \|\| \/photo\/i\.test/.test(orch));
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  check("POST /api/unit-swaps hydrates with the sidecar scrape tier (bot-walled galleries recover)",
    /hydrateUnitSwapPhotoFolder\(parsed\.data, \{ useSidecar: true, fallbackPhotoUrls, requireBedroomPhotoCoverage \}\)/.test(routes));
  // 2026-07-06: the commit re-scrape can fail while ALL scrape tiers are
  // degraded (Apify 403 + ScrapingBee quota + 0-photo sidecar run) even
  // though the FIND phase scraped the gallery minutes earlier — the found
  // unit's photo URLs pass through so a proven gallery can never be lost
  // between find and commit.
  check("hydration falls back to the find phase's photo URLs when the re-scrape is empty",
    routes.includes("fallbackPhotoUrls") && /falling back to \$\{urls\.length\} find-phase photo URLs/.test(routes));

  // ── 2026-07-12 Ilikai receipt (draft -7, job uas_mrh8wbqk_ls005u) ──────────
  // (a) STALE-LABEL LEAK: re-hydrating a REUSED replacement folder deleted
  // only the STAGING folder's photo_labels rows — the target's rows from the
  // PREVIOUS gallery survived the file rm+rename, filename-collided with the
  // fresh photo_NN.jpg set, and queueMissingPhotoLabels saw nothing missing.
  // Every caption/hash consumer (bedroom coverage → "0/2", dedupe → 13
  // phantom cross-folder pairs, collage captions) then read June's labels on
  // July's photos. Hydration must RE-KEY the pipeline's staging rows into
  // place, replacing the destination's rows wholesale.
  check("hydration re-keys the staging label rows onto the final folder (stale rows purged)",
    /movePhotoLabelsToFolder\(stagingFolder, folder\)/.test(routes));
  const storageSrc = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
  check("movePhotoLabelsToFolder deletes the destination's rows before re-keying (filename collisions)",
    /async movePhotoLabelsToFolder\(fromFolder: string, toFolder: string\)/.test(storageSrc) &&
    /delete\(photoLabels\)\.where\(eq\(photoLabels\.folder, toFolder\)\)/.test(storageSrc));
  // (b) BEDROOM-COVERAGE GATE: the audit ladder replaced Unit B with a
  // gallery that itself photographed 1 of 2 bedrooms — the re-check could
  // never pass and the swap was burned for nothing. A bedroom-shortfall
  // replacement aborts at STAGING when the pipeline's folded bedroom count
  // is short (only when the pipeline actually labeled — a labeler outage
  // must not burn every candidate on a false 0), the route surfaces
  // coverageShort on the 502, and the orchestrator burns the candidate.
  check("hydration aborts a coverage-short gallery at staging (before the destructive rm+rename)",
    /opts\.requireBedroomPhotoCoverage === true/.test(routes) &&
    /result\.labeled > 0/.test(routes) &&
    /result\.bedroomCount < coverageExpected/.test(routes) &&
    routes.includes("coverageShort: true"));
  check("orchestrator threads requireBedroomPhotoCoverage from the record into the commit body",
    /requireBedroomPhotoCoverage: record\.requireBedroomPhotoCoverage === true/.test(orch));
  check("orchestrator counts coverage burns separately for the all-burned failure message",
    orch.includes("burnedCoverage") && /photographed fewer bedrooms/.test(orch));
  // Live Ilikai re-run (2026-07-12, uas_mrhwgeqz_2j7hi8): the first-hit find
  // returned a pool of ONE, the coverage gate burned it, and the job failed
  // with nothing left to try. A coverage-exhausted commit pass re-enters the
  // find phase (same bounded findRestarts budget as the deploy-burst path)
  // with every burned URL excluded so the fresh search can't refind them.
  check("coverage-exhausted commit re-enters the find with burned URLs excluded (bounded restarts)",
    /burnedCoverage > 0 && record\.findRestarts < MAX_AUTO_REPLACE_FIND_RESTARTS/.test(orch) &&
    orch.includes("continue findCommit") &&
    /assembleFindPayload\(record\.propertyId, record\.unitId, record\.attemptedUrls\)/.test(orch));
}

// requireBedroomPhotoCoverage survives the persisted store round-trip (a
// deploy mid-commit must not resume WITHOUT the gate and commit a short
// gallery the pre-deploy attempt would have refused).
{
  const round = parseAutoReplaceStore(serializeAutoReplaceStore(
    { j: rec({ jobId: "j", requireBedroomPhotoCoverage: true }) }, NOW));
  check("requireBedroomPhotoCoverage round-trips through the persisted store",
    round.j.requireBedroomPhotoCoverage === true);
  const legacy = parseAutoReplaceStore(JSON.stringify({
    old: { phase: "finding", propertyId: 23, unitId: "u", createdAt: 1, updatedAt: 2 },
  }));
  check("legacy records without the field parse to coverage-gate OFF",
    legacy.old.requireBedroomPhotoCoverage === false);
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

// ── draft replacement folders parse + stay scannable ──────────────────────────
// Adversarial review (2026-07-05): replacementPhotoFolderRef's old greedy
// (.+)-u(.+) split at the LAST "-u" — inside every draft unit id's "-unit-a/b"
// suffix (and builder ids like prop27-unit-a) — so draft replacement folders
// were unparseable → unscannable: the verify rescan 400'd, the weekly cron
// skipped the new gallery forever, and the dashboard dropped the folder.
{
  const { replacementPhotoFolderRef, isScannableFolder } = await import("../shared/photo-folder-utils");
  const draftRef = replacementPhotoFolderRef("replacement-pdraft-12-udraft12-unit-b");
  check("draft replacement folder parses to its negative property id + full unit id",
    draftRef?.propertyId === -12 && draftRef?.oldUnitId === "draft12-unit-b");
  check("draft replacement folder is scannable (rescan + weekly cron + dashboard keep it)",
    isScannableFolder("replacement-pdraft-12-udraft12-unit-b"));
  const builderRef = replacementPhotoFolderRef("replacement-p32-uprop32-kia-3br");
  check("builder replacement folder parses unchanged",
    builderRef?.propertyId === 32 && builderRef?.oldUnitId === "prop32-kia-3br");
  const p27 = replacementPhotoFolderRef("replacement-p27-uprop27-unit-a");
  check("builder unit ids containing '-unit-' parse too (pre-existing prop27 gap)",
    p27?.propertyId === 27 && p27?.oldUnitId === "prop27-unit-a");
  check("junk replacement folder names still reject",
    replacementPhotoFolderRef("replacement-punknown-uunit") === null);
}

// ── source locks: the draft replace path exists at every seam ─────────────────
{
  const { readFileSync } = await import("node:fs");
  const orch = readFileSync(new URL("../server/auto-replace-jobs.ts", import.meta.url), "utf8");
  check("orchestrator resolves draft targets (getCommunityDraft branch)",
    orch.includes("resolveAutoReplaceTarget") && orch.includes("getCommunityDraft"));
  check("orchestrator repoints the draft after a committed swap — SCOPED to the unit (never commits a sibling's pending pick)",
    /target\.isDraft[\s\S]{0,600}\/api\/unit-swaps\/commit\/[\s\S]{0,80}oldUnitId: record\.unitId/.test(orch));
  const repush = readFileSync(new URL("../server/guesty-photo-repush.ts", import.meta.url), "utf8");
  check("Guesty re-push assembles draft galleries (unit1/unit2 photo folders + conventional fallback)",
    repush.includes("draftPushUnits") && repush.includes("unit1PhotoFolder") && /\?\? `draft-\$\{draftId\}-unit-a`/.test(repush));
  const homeSrc = readFileSync(new URL("../client/src/pages/home.tsx", import.meta.url), "utf8");
  check("dashboard popup resolves draft rows to Replace buttons (no propertyId <= 0 bail)",
    homeSrc.includes("replaceBuilderLikeFor") && homeSrc.includes("draftUnitIdForSlot"));
  check("manual draft repoint is unit-scoped and STOPS on failure (no misleading community check/toast)",
    /unit-swaps\/commit\/\$\{target\.propertyId\}`, \{ oldUnitId \}/.test(homeSrc) &&
    /Draft repoint failed[\s\S]{0,400}return;/.test(homeSrc));
  check("terminal draft queue jobs refetch the drafts (stale flagged row would re-enable the button)",
    /job\.propertyId < 0[\s\S]{0,200}\/api\/community\/drafts/.test(homeSrc));
  const routesSrc = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  check("commit route honors the oldUnitId scope",
    routesSrc.includes("scopeOldUnitId") && /commitUnitSwaps\(propertyId, scopeOldUnitId\)/.test(routesSrc));
  // 2026-07-06: "N had too few photos" was the dominant find-phase failure
  // (Mauna Lani 7/13, Pili Mai 4/9) — datacenter bot-walls on Zillow/Redfin
  // galleries. A bounded sidecar re-scrape rescues an otherwise-qualified
  // candidate BEFORE the skipped-too-few-photos verdict.
  check("find-unit rescues photo-floor candidates through the bounded sidecar tier",
    routesSrc.includes("MAX_SIDECAR_PHOTO_RESCUES") &&
    /sidecarPhotoRescues < MAX_SIDECAR_PHOTO_RESCUES[\s\S]{0,600}SCRAPE_WITH_SIDECAR/.test(routesSrc));
  const scannerSrc = readFileSync(new URL("../server/photo-listing-scanner.ts", import.meta.url), "utf8");
  check("scanner drops the abandoned original draft folder after a swap (mirrors builder semantics)",
    /if \(draft\) set\.delete\(`draft-\$\{draft\[1\]\}-unit-\$\{draft\[2\]\}`\)/.test(scannerSrc));
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
