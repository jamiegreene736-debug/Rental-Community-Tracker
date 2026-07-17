import assert from "node:assert";
import { unitSwapSnapshotForUnit } from "../shared/unit-swap-photos";
import {
  AUTO_REPLACE_COMMUNITY_INCONCLUSIVE_MAX_ATTEMPTS,
  AUTO_REPLACE_RETRY_BACKOFF_MS,
  AUTO_REPLACE_RESUME_WINDOW_MS,
  AUTO_REPLACE_STORE_CAP,
  AUTO_REPLACE_STORE_MAX_AGE_MS,
  AUTO_REPLACE_SURFACE_TERMINAL_MS,
  AUTO_REPLACE_UNIT_ID_MAX_LENGTH,
  MAX_AUTO_REPLACE_FIND_RESTARTS,
  MAX_AUTO_REPLACE_RETRIES,
  MAX_AUTO_REPLACE_RESUMES,
  STUCK_AUTO_REPLACE_COMMIT_ERROR,
  STUCK_AUTO_REPLACE_ERROR,
  STUCK_AUTO_REPLACE_VERIFY_ERROR,
  autoReplaceCommunityRetryBackoffMs,
  autoReplaceGuestyPushSatisfied,
  autoReplaceRetryBackoffMs,
  clearableAutoReplaceJobIds,
  draftUnitIdForSlot,
  failStuckAutoReplaceRecords,
  findActiveAutoReplaceJob,
  isAutoReplacePhaseActive,
  isAutoReplaceRetryDue,
  isAutoReplaceRetryPending,
  isLegacyAutoReplaceFailureRetryable,
  newestAutoReplaceJobsByTarget,
  isStagedCommunityAuditInconclusive,
  parseDraftUnitId,
  nextStepFromFindJob,
  parseAutoReplaceStore,
  photoListingHasPersistentPhotoFinding,
  planAutoReplaceRetry,
  pickCommitCandidate,
  serializeAutoReplaceStore,
  shouldResumeAutoReplaceJob,
  summarizeAutoReplaceQueue,
  type AutoReplaceJobRecord,
} from "../shared/auto-replace-job-logic";
import { classifyStagedUnitCommunityAudit } from "../shared/unit-replacement-community-gate";

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
  origin: "operator",
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
  guestyPhotoPush: null,
  message: null,
  error: null,
  createdAt: NOW - 5 * 60_000,
  updatedAt: NOW - 60_000,
  resumeCount: 0,
  findRestarts: 0,
  requireBedroomPhotoCoverage: false,
  requireFullCommunityAudit: false,
  retryPhotoFolder: null,
  retryUnitSwapSnapshot: null,
  runnerId: null,
  runnerLeaseUntil: null,
  autoRetryCount: 0,
  nextRetryAt: null,
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
    Object.keys(store).length === 1 && store.good.unitLabel === "u" && store.good.origin === "unknown");
}
{
  const oversized = "u".repeat(AUTO_REPLACE_UNIT_ID_MAX_LENGTH + 1);
  const store = parseAutoReplaceStore(JSON.stringify({
    oversized: { phase: "finding", propertyId: 23, unitId: oversized, createdAt: 1, updatedAt: 2 },
  }));
  check("oversized persisted unit ids are rejected before lock-key derivation",
    Object.keys(store).length === 0);
}
check("corrupt raw → empty store", Object.keys(parseAutoReplaceStore("{x")).length === 0);
{
  const store: Record<string, AutoReplaceJobRecord> = {};
  for (let i = 0; i < AUTO_REPLACE_STORE_CAP + 3; i++) store[`j${i}`] = rec({ jobId: `j${i}`, updatedAt: NOW - i * 1000 });
  const round = parseAutoReplaceStore(serializeAutoReplaceStore(store, NOW));
  check("write-time cap keeps the newest records", Object.keys(round).length === AUTO_REPLACE_STORE_CAP && !!round.j0);
}

// ── bounded delayed retries for persistent OTA photo findings ───────────────
{
  const legacy = parseAutoReplaceStore(JSON.stringify({
    old: { phase: "failed", propertyId: -25, unitId: "draft25-unit-b", createdAt: 1, updatedAt: 2 },
    explicit: {
      phase: "retry_wait", propertyId: -25, unitId: "draft25-unit-b", createdAt: 1, updatedAt: 2,
      retryPhotoFolder: "draft-25-unit-b", retryUnitSwapSnapshot: "none", autoRetryCount: 2, nextRetryAt: NOW + 1,
      runnerId: "railway-instance-1", runnerLeaseUntil: NOW + 60_000,
    },
    invalid: {
      phase: "failed", propertyId: -25, unitId: "draft25-unit-b", createdAt: 1, updatedAt: 2,
      autoRetryCount: -4, nextRetryAt: -1, runnerId: "", runnerLeaseUntil: -1,
    },
  }));
  check("legacy retry and runner metadata default safely; explicit values round-trip",
    legacy.old.retryPhotoFolder === null && legacy.old.retryUnitSwapSnapshot === null && legacy.old.autoRetryCount === 0 && legacy.old.nextRetryAt === null &&
    legacy.explicit.retryPhotoFolder === "draft-25-unit-b" && legacy.explicit.retryUnitSwapSnapshot === "none" && legacy.explicit.autoRetryCount === 2 && legacy.explicit.nextRetryAt === NOW + 1 &&
    legacy.explicit.runnerId === "railway-instance-1" && legacy.explicit.runnerLeaseUntil === NOW + 60_000 &&
    legacy.old.runnerId === null && legacy.old.runnerLeaseUntil === null &&
    legacy.invalid.autoRetryCount === 0 && legacy.invalid.nextRetryAt === null && legacy.invalid.runnerId === null && legacy.invalid.runnerLeaseUntil === null);
}
check("retry budget is small, monotonic, and fits inside store retention",
  MAX_AUTO_REPLACE_RETRIES === AUTO_REPLACE_RETRY_BACKOFF_MS.length &&
  MAX_AUTO_REPLACE_RETRIES <= 3 &&
  AUTO_REPLACE_RETRY_BACKOFF_MS.every((delay, i, all) => delay > 0 && (i === 0 || delay > all[i - 1])) &&
  AUTO_REPLACE_RETRY_BACKOFF_MS[MAX_AUTO_REPLACE_RETRIES - 1] < AUTO_REPLACE_STORE_MAX_AGE_MS &&
  autoReplaceRetryBackoffMs(999) === AUTO_REPLACE_RETRY_BACKOFF_MS[MAX_AUTO_REPLACE_RETRIES - 1]);
{
  const base = rec({
    phase: "failed",
    propertyId: -25,
    unitId: "draft25-unit-b",
    retryPhotoFolder: "draft-25-unit-b",
    attemptedUrls: ["https://www.redfin.com/unit-29"],
    findRestarts: MAX_AUTO_REPLACE_FIND_RESTARTS,
    requireBedroomPhotoCoverage: true,
  });
  const patch = planAutoReplaceRetry(base, "Every found option failed at commit", NOW);
  const waiting = rec({ ...base, ...patch });
  check("safe pre-commit retry is scheduled once with a due time",
    patch?.phase === "retry_wait" && patch.autoRetryCount === 1 &&
    patch.nextRetryAt === NOW + AUTO_REPLACE_RETRY_BACKOFF_MS[0]);
  check("retry preserves rejected URLs, bedroom gate, and spent inner-search budget",
    waiting.attemptedUrls[0] === "https://www.redfin.com/unit-29" &&
    waiting.requireBedroomPhotoCoverage === true && waiting.findRestarts === MAX_AUTO_REPLACE_FIND_RESTARTS);
  check("waiting retry is active/deduped but neither resumable early nor clearable/stuck-failed",
    isAutoReplacePhaseActive(waiting.phase) &&
    findActiveAutoReplaceJob({ waiting }, -25, "draft25-unit-b")?.jobId === waiting.jobId &&
    isAutoReplaceRetryPending(waiting, NOW) && !isAutoReplaceRetryDue(waiting, NOW) &&
    !shouldResumeAutoReplaceJob(waiting, NOW) &&
    clearableAutoReplaceJobIds({ waiting }, NOW).length === 0 &&
    failStuckAutoReplaceRecords({ waiting }, NOW + AUTO_REPLACE_RESUME_WINDOW_MS * 2).length === 0);
  check("retry becomes due at the exact persisted boundary",
    !isAutoReplaceRetryDue(waiting, waiting.nextRetryAt! - 1) &&
    isAutoReplaceRetryDue(waiting, waiting.nextRetryAt!));

  let capped = waiting;
  for (let i = 1; i < MAX_AUTO_REPLACE_RETRIES; i++) {
    const next = planAutoReplaceRetry({ ...capped, phase: "failed" }, "still no candidate", NOW + i);
    capped = rec({ ...capped, phase: "failed", nextRetryAt: null, ...next });
  }
  check("retry cap is terminal and cannot reopen into an infinite loop",
    capped.autoRetryCount === MAX_AUTO_REPLACE_RETRIES &&
    planAutoReplaceRetry({ ...capped, phase: "failed" }, "again", NOW) === null);
  check("completed/verifying/waiting records can never allocate another retry",
    planAutoReplaceRetry({ ...base, phase: "completed" }, "again", NOW) === null &&
    planAutoReplaceRetry({ ...base, phase: "verifying" }, "again", NOW) === null &&
    planAutoReplaceRetry({ ...base, phase: "retry_wait" }, "again", NOW) === null);
}
check("automatic retry requires a persisted PHOTO finding (address-only is excluded)",
  photoListingHasPersistentPhotoFinding({ airbnbStatus: "clean", vrboStatus: "found", bookingStatus: "unknown", checkedAt: new Date(NOW) }, NOW) &&
  !photoListingHasPersistentPhotoFinding({
    airbnbStatus: "clean", vrboStatus: "unknown", bookingStatus: "clean", vrboAddressStatus: "found", checkedAt: new Date(NOW),
  } as any, NOW) &&
  !photoListingHasPersistentPhotoFinding({ airbnbStatus: "found", checkedAt: new Date(0) }, NOW) &&
  !photoListingHasPersistentPhotoFinding(null));
{
  const createdAt = new Date("2026-07-15T20:12:00Z");
  check("swap snapshot distinguishes none, pending, and committed generations",
    unitSwapSnapshotForUnit([], "unit-b") === "none" &&
    unitSwapSnapshotForUnit([{ id: 7, oldUnitId: "unit-b", createdAt, committed: false }], "unit-b") ===
      `7:${createdAt.toISOString()}:pending` &&
    unitSwapSnapshotForUnit([{ id: 7, oldUnitId: "unit-b", createdAt, committed: true }], "unit-b") ===
      `7:${createdAt.toISOString()}:committed`);
}
{
  const poipu = rec({
    phase: "failed",
    propertyId: -25,
    unitId: "draft25-unit-b",
    error: "Every found option failed at commit (1 photographed fewer bedrooms than the unit claims). Re-run the search.",
    updatedAt: NOW - 2 * 24 * 60 * 60_000,
  });
  check("legacy Poipu pre-commit failure is bridgeable",
    isLegacyAutoReplaceFailureRetryable(poipu, NOW));
  check("legacy committed/ambiguous failures are never bridgeable",
    !isLegacyAutoReplaceFailureRetryable({ ...poipu, replacementFolder: "replacement-pdraft-25-udraft25-unit-b" }, NOW) &&
    !isLegacyAutoReplaceFailureRetryable({ ...poipu, error: "The swap was recorded but the draft could not be repointed" }, NOW) &&
    !isLegacyAutoReplaceFailureRetryable({ ...poipu, error: "Interrupted mid-commit; the swap may or may not have landed" }, NOW) &&
    !isLegacyAutoReplaceFailureRetryable({ ...poipu, error: "fetch failed" }, NOW));
}
{
  const waiting = rec({
    jobId: "waiting",
    phase: "retry_wait",
    retryPhotoFolder: "draft-25-unit-b",
    autoRetryCount: 1,
    nextRetryAt: NOW + 1,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
  });
  const store: Record<string, AutoReplaceJobRecord> = { waiting };
  for (let i = 0; i < AUTO_REPLACE_STORE_CAP + 3; i++) {
    store[`terminal-${i}`] = rec({
      jobId: `terminal-${i}`, unitId: `other-${i}`, phase: "failed",
      createdAt: NOW - i, updatedAt: NOW - i,
    });
  }
  const round = parseAutoReplaceStore(serializeAutoReplaceStore(store, NOW));
  check("active retry survives the store cap ahead of newer terminal receipts", !!round.waiting);
}
{
  const obsoleteActive = rec({
    jobId: "obsolete-active", createdAt: NOW - 30_000, updatedAt: NOW,
    runnerId: "old-runner", runnerLeaseUntil: NOW + 60_000,
  });
  const laterTerminal = rec({
    jobId: "later-terminal", phase: "completed", createdAt: NOW - 20_000, updatedAt: NOW - 20_000,
  });
  const store: Record<string, AutoReplaceJobRecord> = { obsoleteActive, laterTerminal };
  for (let i = 0; i < AUTO_REPLACE_STORE_CAP - 1; i++) {
    store[`other-${i}`] = rec({
      jobId: `other-${i}`, unitId: `other-unit-${i}`, phase: "failed",
      createdAt: NOW - i, updatedAt: NOW - i,
    });
  }
  const round = parseAutoReplaceStore(serializeAutoReplaceStore(store, NOW));
  check("store cap keeps the later authoritative receipt over an obsolete runner heartbeat",
    !!round["later-terminal"] && !round["obsolete-active"]);
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
  const store = {
    a: rec({ jobId: "a", createdAt: NOW - 1_000, updatedAt: NOW - 1_000 }),
    b: rec({ jobId: "b", phase: "completed", createdAt: NOW - 2_000, updatedAt: NOW - 2_000 }),
  };
  check("running job for the same property+unit is found (double-tap guard)",
    findActiveAutoReplaceJob(store, 23, "prop23-kl-3br")?.jobId === "a");
  check("terminal job does not block a new run",
    findActiveAutoReplaceJob({ b: store.b }, 23, "prop23-kl-3br") === null);
  check("other unit is not blocked", findActiveAutoReplaceJob(store, 23, "other-unit") === null);
}
{
  const olderFailed = rec({ jobId: "older-failed", phase: "failed", createdAt: NOW - 4_000, updatedAt: NOW - 2_000 });
  const newerWaiting = rec({
    jobId: "newer-waiting",
    phase: "retry_wait",
    createdAt: NOW - 3_000,
    updatedAt: NOW - 1_000,
    retryPhotoFolder: "folder",
    retryUnitSwapSnapshot: "none",
    autoRetryCount: 1,
    nextRetryAt: NOW + 60_000,
  });
  const otherTarget = rec({ jobId: "other-target", unitId: "other", createdAt: NOW - 5_000, updatedAt: NOW - 3_000 });
  const authoritative = newestAutoReplaceJobsByTarget([olderFailed, newerWaiting, otherTarget]);
  check("only the newest receipt per property/unit can resume or bridge",
    authoritative.length === 2 && authoritative.some((record) => record.jobId === "newer-waiting")
      && !authoritative.some((record) => record.jobId === "older-failed"));
  check("double-tap guard returns the newest active receipt deterministically",
    findActiveAutoReplaceJob({ olderFailed, newerWaiting }, 23, "prop23-kl-3br")?.jobId === "newer-waiting");
  const oldHeartbeat = rec({
    jobId: "old-heartbeat", createdAt: NOW - 10_000, updatedAt: NOW,
    runnerId: "old-runner", runnerLeaseUntil: NOW + 60_000,
  });
  const laterTerminal = rec({
    jobId: "later-terminal", phase: "completed", createdAt: NOW - 5_000, updatedAt: NOW - 4_000,
  });
  check("an older runner heartbeat cannot outrank a later operator receipt",
    newestAutoReplaceJobsByTarget([oldHeartbeat, laterTerminal])[0]?.jobId === "later-terminal" &&
    findActiveAutoReplaceJob({ oldHeartbeat, laterTerminal }, 23, "prop23-kl-3br") === null &&
    summarizeAutoReplaceQueue({ oldHeartbeat, laterTerminal }, NOW).activeCount === 0);
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

// ── strict replacement synchronization + inconclusive retry decisions ───────
{
  const synced = {
    status: "synced" as const,
    guestyListingId: "g-23",
    photoCount: 42,
    successCount: 42,
    verifiedCount: 42,
    skipped: null,
    error: null,
    completedAt: NOW,
  };
  const failedPush = { ...synced, status: "failed" as const, successCount: 0, error: "Guesty 429" };
  check("mapped strict replacement accepts only a persisted successful Guesty gallery push",
    autoReplaceGuestyPushSatisfied(synced, true)
    && !autoReplaceGuestyPushSatisfied(failedPush, true)
    && !autoReplaceGuestyPushSatisfied(null, true));
  check("unmapped replacement is a valid local-only result even without a push receipt",
    autoReplaceGuestyPushSatisfied(null, false));

  check("only typed staged-community 503 responses retry without burning",
    isStagedCommunityAuditInconclusive(503, { communityGateInconclusive: true })
    && !isStagedCommunityAuditInconclusive(503, { communityGateInconclusive: false })
    && !isStagedCommunityAuditInconclusive(422, { communityGateInconclusive: true }));
  const retryWaits = Array.from(
    { length: AUTO_REPLACE_COMMUNITY_INCONCLUSIVE_MAX_ATTEMPTS - 1 },
    (_, i) => autoReplaceCommunityRetryBackoffMs(i + 1),
  );
  check("same-candidate inconclusive retries are bounded and exponentially backed off",
    AUTO_REPLACE_COMMUNITY_INCONCLUSIVE_MAX_ATTEMPTS === 3
    && retryWaits.length === 2
    && retryWaits[0] > 0
    && retryWaits[1] === retryWaits[0] * 2);
}

// ── staged full-community gate ─────────────────────────────────────────────
// A candidate is only commit-safe after positive community + unit + bedroom
// evidence. Positive mismatches burn it; missing evidence remains an explicit
// inconclusive result (never a false pass and never a permanent burn).
{
  const verified = {
    ok: true,
    allSameCommunity: "yes" as const,
    community: { matchesExpected: "yes" as const, overallStatus: "verified" },
    units: [{
      label: "Unit A",
      folder: "replacement-staging-a",
      sameAsCommunity: "yes" as const,
      reason: "6/6 interior photos match.",
    }],
    bedroomCoverage: {
      matchesListing: "yes" as const,
      units: [{
        label: "Unit A",
        folder: "replacement-staging-a",
        matchesListing: "yes" as const,
        bedroomsFound: 2,
        expectedBedrooms: 2,
      }],
    },
    sourcePages: [],
  };
  const accepted = classifyStagedUnitCommunityAudit(verified, { targetFolder: "replacement-staging-a" });
  check("staged candidate accepts only after positive community + unit + bedroom evidence",
    accepted.decision === "accept" && accepted.burnCandidate === false);

  const unreadableSource = classifyStagedUnitCommunityAudit({
    ...verified,
    sourcePages: [{
      unitLabel: "Unit A",
      url: "https://example.invalid/listing",
      match: "uncertain",
      unreadable: true,
      reason: "The source page was auth-gated.",
    }],
  }, { targetFolder: "replacement-staging-a" });
  check("missing or unreadable source-page evidence does not block an otherwise-positive staged audit",
    accepted.decision === "accept" && unreadableSource.decision === "accept");

  const sourceContradiction = classifyStagedUnitCommunityAudit({
    ...verified,
    sourcePages: [{
      unitLabel: "Unit A",
      url: "https://example.com/listing",
      match: "no",
      identifiedCommunity: "Different Resort",
      confidence: 0.92,
      reason: "The listing names a different resort.",
    }],
  }, { targetFolder: "replacement-staging-a" });
  check("a strong source-page contradiction still rejects and burns the candidate",
    sourceContradiction.decision === "reject"
    && sourceContradiction.burnCandidate === true
    && sourceContradiction.reasonCode === "community-mismatch");

  const communityMismatch = classifyStagedUnitCommunityAudit({
    ...verified,
    allSameCommunity: "no",
    community: { matchesExpected: "no", overallStatus: "mismatch", identifiedCommunity: "Different Resort" },
  }, { targetFolder: "replacement-staging-a" });
  check("positive staged community mismatch rejects and burns the candidate",
    communityMismatch.decision === "reject" && communityMismatch.burnCandidate === true);

  const bedroomShort = classifyStagedUnitCommunityAudit({
    ...verified,
    bedroomCoverage: {
      matchesListing: "no",
      units: [{
        label: "Unit A",
        folder: "replacement-staging-a",
        matchesListing: "no",
        bedroomsFound: 1,
        expectedBedrooms: 2,
        reason: "Only one distinct bedroom is photographed.",
      }],
    },
  }, { targetFolder: "replacement-staging-a", bedroomCoverageReliable: true });
  check("reliable staged bedroom shortfall rejects and burns the candidate",
    bedroomShort.decision === "reject" && bedroomShort.burnCandidate === true);

  const uncertain = classifyStagedUnitCommunityAudit({
    ...verified,
    ok: false,
    warning: "ANTHROPIC_API_KEY not configured",
    allSameCommunity: "no",
    community: null,
    units: [{
      label: "Unit A",
      folder: "replacement-staging-a",
      sameAsCommunity: "no",
      reason: "Only 3 interior photos checked — need 5+ to confirm same community.",
    }],
    bedroomCoverage: null,
  }, { targetFolder: "replacement-staging-a", bedroomCoverageReliable: false });
  check("staged audit uncertainty is inconclusive — neither accepted nor burned",
    uncertain.decision === "inconclusive" && uncertain.burnCandidate === false);
}

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
    oldActive: rec({ jobId: "oldActive", unitId: "old-active-unit", createdAt: NOW - 10 * 60_000 }),
    newActive: rec({ jobId: "newActive", unitId: "new-active-unit", createdAt: NOW - 60_000, phase: "verifying" }),
    doneRecent: rec({ jobId: "doneRecent", unitId: "done-recent-unit", phase: "completed", updatedAt: NOW - 5 * 60_000 }),
    doneOld: rec({ jobId: "doneOld", unitId: "done-old-unit", phase: "completed", updatedAt: NOW - AUTO_REPLACE_SURFACE_TERMINAL_MS - 1 }),
  };
  const q = summarizeAutoReplaceQueue(store, NOW);
  check("active jobs first (oldest first), then recent terminals; stale terminals dropped",
    q.activeCount === 2 &&
    q.jobs.map((j) => j.jobId).join(",") === "oldActive,newActive,doneRecent");
}

// ── operator "Clear queue" ───────────────────────────────────────────────────
{
  const store = {
    done: rec({ jobId: "done", unitId: "done-unit", phase: "completed" }),
    dead: rec({ jobId: "dead", unitId: "dead-unit", phase: "failed" }),
    running: rec({ jobId: "running", unitId: "running-unit", phase: "finding", updatedAt: NOW - 60_000 }),
    liveNow: rec({ jobId: "liveNow", unitId: "live-unit", phase: "committing", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000 }),
    stuckStale: rec({ jobId: "stuckStale", unitId: "stale-unit", phase: "finding", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000 }),
    stuckCapped: rec({ jobId: "stuckCapped", unitId: "capped-unit", phase: "finding", resumeCount: MAX_AUTO_REPLACE_RESUMES }),
    leasedStale: rec({
      jobId: "leasedStale", unitId: "leased-unit", phase: "finding", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000,
      runnerId: "other-instance", runnerLeaseUntil: NOW + 60_000,
    }),
  };
  const cleared = clearableAutoReplaceJobIds(store, NOW, ["liveNow"]).sort();
  check("terminal jobs are clearable", cleared.includes("done") && cleared.includes("dead"));
  check("resumable active job is NOT clearable", !cleared.includes("running"));
  check("actually-running job is NEVER clearable, even when it looks stale", !cleared.includes("liveNow"));
  check("stuck active job outside the resume window IS clearable", cleared.includes("stuckStale"));
  check("stuck active job at the resume cap IS clearable", cleared.includes("stuckCapped"));
  check("a live cross-process runner lease is never clearable", !cleared.includes("leasedStale"));
  check("exactly the expected set clears", cleared.join(",") === "dead,done,stuckCapped,stuckStale");
  check("empty store clears nothing", clearableAutoReplaceJobIds({}, NOW).length === 0);
}
{
  const obsolete = rec({
    jobId: "obsolete", createdAt: NOW - 2_000, updatedAt: NOW,
    runnerId: "old-runner", runnerLeaseUntil: NOW + 60_000,
  });
  const tombstone = rec({
    jobId: "tombstone", phase: "completed", createdAt: NOW - 1_000, updatedAt: NOW - 1_000,
  });
  const cleared = clearableAutoReplaceJobIds({ obsolete, tombstone }, NOW).sort();
  check("clearing a newer terminal receipt also removes its obsolete active generation",
    cleared.join(",") === "obsolete,tombstone");
}

// ── watchdog terminalizes stuck unresumable records ──────────────────────────
{
  const store = {
    running: rec({ jobId: "running", phase: "finding", updatedAt: NOW - 60_000 }),
    liveNow: rec({ jobId: "liveNow", phase: "committing", resumeCount: MAX_AUTO_REPLACE_RESUMES }),
    stuckStale: rec({ jobId: "stuckStale", phase: "finding", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000 }),
    stuckCapped: rec({ jobId: "stuckCapped", phase: "committing", resumeCount: MAX_AUTO_REPLACE_RESUMES }),
    stuckVerify: rec({ jobId: "stuckVerify", phase: "verifying", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000 }),
    leasedStale: rec({
      jobId: "leasedStale", phase: "finding", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000,
      runnerId: "other-instance", runnerLeaseUntil: NOW + 60_000,
    }),
    stuckRetry: rec({
      jobId: "stuckRetry", phase: "finding", updatedAt: NOW - AUTO_REPLACE_RESUME_WINDOW_MS - 60_000,
      retryPhotoFolder: "draft-25-unit-b",
    }),
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
  check("stuck pre-commit job with a persistent finding spends the next delayed retry instead of terminalizing",
    store.stuckRetry.phase === "retry_wait" && store.stuckRetry.autoRetryCount === 1 && store.stuckRetry.nextRetryAt! > NOW);
  check("resumable / live / terminal records untouched",
    store.running.phase === "finding" && store.liveNow.phase === "committing" &&
    store.leasedStale.phase === "finding" && store.done.phase === "completed");
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
  const retryPromotionSource = orch.slice(
    orch.indexOf("async function activateDueAutoReplaceRetry"),
    orch.indexOf("// Boot/interval watchdog"),
  );
  check("retry promotion holds a short per-target claim, validates folder + swap snapshot, and persists strictly before launch",
    retryPromotionSource.includes("acquireAutoReplaceTargetLock(record)") &&
    retryPromotionSource.includes("retryUnitSwapSnapshot") &&
    retryPromotionSource.includes("folderStillHasPhotoFinding") &&
    /persistAutoReplaceRecord\(record, \{[\s\S]{0,120}strict: true/.test(retryPromotionSource) &&
    retryPromotionSource.indexOf("persistAutoReplaceRecord(record") < retryPromotionSource.indexOf("runAutoReplaceJob(record)"));
  const legacyRetrySource = orch.slice(
    orch.indexOf("async function scheduleLegacyAutoReplaceRetry"),
    orch.indexOf("async function activateDueAutoReplaceRetry"),
  );
  check("legacy bridge locks the target, re-reads the newest receipt, rejects later swaps, and CAS-promotes",
    legacyRetrySource.includes("acquireAutoReplaceTargetLock(record)") &&
    legacyRetrySource.includes("storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY)") &&
    legacyRetrySource.includes("newestAutoReplaceJobsByTarget(Object.values(liveStore))") &&
    legacyRetrySource.includes("currentTargetContextForRecord(record)") &&
    legacyRetrySource.includes('context.unitSwapSnapshot !== "none"') &&
    legacyRetrySource.includes("folderStillHasPhotoFinding(context.photoFolder)") &&
    legacyRetrySource.includes("live.updatedAt !== previous.updatedAt") &&
    legacyRetrySource.includes("await mutateStoreStrict"));
  check("a retry-wait record cannot bypass the due-time watchdog",
    /if \(record\.phase === "retry_wait"\) \{[\s\S]{0,100}return;/.test(orch) &&
    /persistedActive && autoReplaceJobSatisfiesRequestedGates\(persistedActive, input\)[\s\S]{0,400}return \{ ok: true, job: persistedActive \};/.test(orch));
  const startSource = orch.slice(
    orch.indexOf("export async function startAutoReplaceJob"),
    orch.indexOf("export async function listAutoReplaceJobs"),
  );
  check("new jobs acquire a per-target lock and require durable persistence before launch",
    /targetLock = await acquireAutoReplaceTargetLock\(\{ propertyId, unitId \}\)/.test(startSource) &&
    /persistAutoReplaceRecord\(record, \{[\s\S]{0,120}strict: true/.test(startSource) &&
    startSource.indexOf("persistAutoReplaceRecord(record") < startSource.indexOf("runAutoReplaceJob(record)") &&
    /SELECT "value" FROM app_settings WHERE "key" = \$1 FOR UPDATE/.test(orch));
  const runSource = orch.slice(
    orch.indexOf("async function runAutoReplaceJob"),
    orch.indexOf("// Phase 3 — verifying", orch.indexOf("async function runAutoReplaceJob")),
  );
  check("execution never holds an advisory-lock client across the long search/commit worker",
    !runSource.includes("acquireAutoReplaceTargetLock") &&
    /autoReplaceLockPool = new pg\.Pool\([\s\S]{0,180}max: 2/.test(orch));
  const runnerClaimSource = orch.slice(
    orch.indexOf("async function claimAutoReplaceRunner"),
    orch.indexOf("async function renewAutoReplaceRunnerLease"),
  );
  check("a persisted runner lease is CAS-claimed before execution and blocks a live competing instance",
    runnerClaimSource.includes("await mutateStoreStrict") &&
    runnerClaimSource.includes("authoritative?.jobId !== current.jobId") &&
    runnerClaimSource.includes("current.runnerId !== AUTO_REPLACE_RUNNER_ID") &&
    runnerClaimSource.includes("current.runnerLeaseUntil ?? 0") &&
    runSource.indexOf("claimAutoReplaceRunner") < runSource.indexOf("activeJobIds.add"));
  check("the runner heartbeats its lease and verifies ownership immediately before the swap POST",
    runSource.includes("renewAutoReplaceRunnerLease(record)") &&
    runSource.includes("AUTO_REPLACE_RUNNER_HEARTBEAT_MS") &&
    /renewAutoReplaceRunnerLease[\s\S]{0,700}authoritative\?\.jobId !== current\.jobId/.test(orch) &&
    runSource.indexOf("await confirmRunnerLease()") < runSource.indexOf('postLoopback("/api/unit-swaps"'));
  const failureSource = orch.slice(
    orch.indexOf("async function finishAutoReplaceFailure"),
    orch.indexOf("// The same find payload"),
  );
  check("retry scheduling is strictly persisted and awaited",
    /await persistAutoReplaceRecord\(record, \{[\s\S]{0,120}strict: true,[\s\S]{0,120}expectedRunnerId/.test(failureSource) &&
    /await finishAutoReplaceFailure\(record, STUCK_AUTO_REPLACE_ERROR/.test(orch));

  // Durable automatic-fix activity is a semantic transition log, not a copy
  // of heartbeat/progress messages. Lock every lifecycle seam that answers
  // whether the system actually tried, retried, stopped, succeeded, or failed.
  const activityTransactionSource = orch.slice(
    orch.indexOf("async function mutateStoreTransaction"),
    orch.indexOf("function enqueueStoreMutation"),
  );
  check("activity rows commit with their job transition (and fail open behind a savepoint)",
    activityTransactionSource.includes("const activity = mutate(store, now) ?? []") &&
    activityTransactionSource.includes("INSERT INTO queue_job_events") &&
    activityTransactionSource.includes("SAVEPOINT auto_fix_activity_write") &&
    activityTransactionSource.indexOf("INSERT INTO queue_job_events") < activityTransactionSource.indexOf('client.query("COMMIT")'));

  check("replacement start is recorded only after the runner lease is actually claimed",
    startSource.includes("origin?: AutoReplaceOrigin") &&
    startSource.includes("origin,") &&
    !/activity:\s*\[autoFixActivity\(record, "started"/.test(startSource) &&
    runnerClaimSource.includes('retryAttempt ? "retry-started" : "started"') &&
    runnerClaimSource.includes("after the runner lease was acquired"));

  check("automatic retry outcomes cannot inherit the original operator/audit label",
    /origin:\s*opts\.origin \?\? \(attemptNumber > 0 \? "automatic-retry" : record\.origin\)/.test(orch));

  check("retry scheduling records the failed attempt and its scheduled retry",
    /autoFixActivity\(record, "failed", error/.test(failureSource) &&
    /autoFixActivity\([\s\S]{0,120}record,[\s\S]{0,80}"retry-scheduled"/.test(failureSource) &&
    failureSource.includes("scheduledFor: record.nextRetryAt"));
  check("terminal failure records a final failed activity event",
    /phase:\s*"failed"[\s\S]{0,600}activity:\s*\[autoFixActivity\(record, "failed"/.test(failureSource));

  const retryActivationSource = retryPromotionSource;
  check("due retries record safe-stop skips; actual retry starts are recorded at runner claim",
    /activity:\s*\[autoFixActivity\([\s\S]{0,160}"skipped"/.test(retryActivationSource) &&
    !/activity:\s*\[autoFixActivity\([\s\S]{0,160}"retry-started"/.test(retryActivationSource) &&
    runnerClaimSource.includes('retryAttempt ? "retry-started" : "started"'));

  const verifySource = orch.slice(
    orch.indexOf("async function runAutoReplaceVerifyPhase"),
    orch.indexOf("export async function startAutoReplaceJob"),
  );
  check("successful verification records a succeeded activity event",
    /activity:\s*\[autoFixActivity\(record, "succeeded"/.test(verifySource));

  const storageSource = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
  check("photo finding lookup uses the newest check row",
    /getPhotoListingCheckByFolder[\s\S]{0,350}orderBy\(desc\(photoListingChecks\.checkedAt\)\)[\s\S]{0,80}limit\(1\)/.test(storageSource));
  check("replacement find excludes all historical swap sources plus this job's rejected candidates",
    orch.includes("collectUnitSwapSkipUrls(swaps, extraSkipUrls)")
    && !/latestUnitSwapsByUnit\(await storage\.getUnitSwaps\(propertyId\)/.test(orch));
  check("commit loop burns a 502 photo-hydration failure and tries the next option",
    /status === 502 && \(data\?\.coverageShort === true \|\| \/photo\/i\.test/.test(orch));
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const auditSweep = readFileSync(new URL("../server/unit-audit-sweep.ts", import.meta.url), "utf8");
  check("the direct one-click route attributes replacement activity to the operator",
    /app\.post\("\/api\/replacement\/auto-jobs"[\s\S]{0,500}origin:\s*"operator"/.test(routes));
  check("unit-audit replacements distinguish scheduled automation from operator-run audits",
    /startAutoReplaceJob\(\{[\s\S]{0,300}origin:\s*record\.source === "cron" \? "scheduled-audit" : "operator-audit"/.test(auditSweep));
  check("the read-only automatic-fix activity endpoint is wired to the bounded history query",
    /app\.get\("\/api\/replacement\/auto-fix-activity"[\s\S]{0,250}listAutoFixActivity\(req\.query\.limit\)/.test(routes) &&
    /export async function listAutoFixActivity[\s\S]{0,800}WHERE job_type = \$1[\s\S]{0,180}ORDER BY created_at DESC, id DESC[\s\S]{0,120}parseAutoFixActivityRows/.test(orch));
  const clearQueueSource = orch.slice(
    orch.indexOf("export async function clearAutoReplaceQueue"),
    orch.indexOf("async function persistAutoReplaceRecord"),
  );
  check("clearing the live queue never deletes the independent activity history",
    clearQueueSource.includes("clearableAutoReplaceJobIds") &&
    !clearQueueSource.includes("queue_job_events") &&
    !clearQueueSource.includes("AUTO_FIX_ACTIVITY_JOB_TYPE"));
  const homeSource = readFileSync(new URL("../client/src/pages/home.tsx", import.meta.url), "utf8");
  check("activity UI is accurately scoped and keeps recent terminal queue receipts as a logging fallback",
    homeSource.includes("Photo replacement activity") &&
    homeSource.includes('data-testid="section-auto-fix-recent-receipts"') &&
    homeSource.includes("Retry ${event.attemptNumber} ${AUTO_FIX_RETRY_STATUS_LABELS[event.status]}") &&
    !homeSource.includes("> Automatic fix activity<"));
  const swapLock = readFileSync(new URL("../server/unit-swap-write-lock.ts", import.meta.url), "utf8");
  check("manual and automatic swap writers share a separately bounded property lock",
    (routes.match(/withUnitSwapPropertyWriteLock\(/g)?.length ?? 0) >= 5 &&
    /unitSwapWriteLockPool = new pg\.Pool\([\s\S]{0,180}max: 2/.test(swapLock));
  const readSwapRoute = routes.slice(
    routes.indexOf('app.get("/api/unit-swaps/:propertyId"'),
    routes.indexOf('app.delete("/api/unit-swaps/:id"'),
  );
  check("GET hydration is serialized with swap writers so an old row cannot overwrite a newer folder",
    readSwapRoute.indexOf("withUnitSwapPropertyWriteLock") < readSwapRoute.indexOf("hydrateUnitSwapPhotoFolder"));
  const autoSwapRoute = routes.slice(
    routes.indexOf('app.post("/api/unit-swaps"'),
    routes.indexOf("// POST /api/replacement/repush-guesty-photos"),
  );
  const lockAt = autoSwapRoute.indexOf("withUnitSwapPropertyWriteLock");
  const snapshotAt = autoSwapRoute.indexOf("unitSwapSnapshotForUnit");
  const hydrateAt = autoSwapRoute.indexOf("hydrateUnitSwapPhotoFolder");
  const insertAt = autoSwapRoute.indexOf("createUnitSwapAtomically(parsed.data, expectedUnitSwapSnapshot)");
  const atomicCreate = routes.slice(
    routes.indexOf("const createUnitSwapAtomically"),
    routes.indexOf("const activeUnitPhotoFoldersForBuilder"),
  );
  check("auto swap generation is checked under the writer lock before hydration and again before insert",
    lockAt >= 0 && lockAt < snapshotAt && snapshotAt < hydrateAt && hydrateAt < insertAt &&
    atomicCreate.includes("unitSwapSnapshotForUnit") && atomicCreate.includes('reason: "target-changed"'));
  check("POST /api/unit-swaps hydrates with the sidecar scrape tier (bot-walled galleries recover)",
    /hydrateUnitSwapPhotoFolder\(parsed\.data, \{[\s\S]{0,220}useSidecar: true,[\s\S]{0,220}fallbackPhotoUrls,[\s\S]{0,220}requireBedroomPhotoCoverage/.test(routes));
  // 2026-07-06: the commit re-scrape can fail while ALL scrape tiers are
  // degraded (Apify 403 + ScrapingBee quota + 0-photo sidecar run) even
  // though the FIND phase scraped the gallery minutes earlier — the found
  // unit's photo URLs pass through so a proven gallery can never be lost
  // between find and commit. 2026-07-15 (Poipu Kapili unit-B): the fallback
  // also fires on a THIN scrape (a sold-stripped/bot-walled page returns
  // exactly 1 og:image, which used to bypass the empty-only fallback and
  // then die at the MIN floor) — find-phase URLs are UNIONED behind the
  // fresh scrape.
  check("hydration falls back to the find phase's photo URLs when the re-scrape is empty OR thin",
    routes.includes("fallbackPhotoUrls")
    && /scraped\.length < MIN_INDEPENDENT_UNIT_PHOTOS\s*\n?\s*&& Array\.isArray\(opts\.fallbackPhotoUrls\)/.test(routes)
    && /adding \$\{extras\.length\} find-phase photo URLs/.test(routes));
  // 2026-07-15 (the reason the Poipu Kapili unit-B auto-replacement burned
  // BOTH candidates): find-unit's foundUnits carried ONLY the Google SERP
  // thumbnail (a base64 data: URI) as `photos`, so the orchestrator's
  // https-only photoUrls filter always produced an EMPTY fallback — the
  // 2026-07-06 pass-through never actually had the gallery on this path.
  // The found unit must now carry the FULL proven scraped gallery as
  // photoUrls, and both commit callers must prefer it.
  check("find-unit found units carry the full scraped gallery as photoUrls (not just the SERP thumbnail)",
    /photoUrls: scrapedPhotoUrls\s*\n?\s*\.filter\(\(u\) => \/\^https\?:\\\/\\\/\/i\.test\(String\(u \?\? ""\)\)\)/.test(routes));
  check("orchestrator commit body prefers the unit's photoUrls gallery over the display thumbnail",
    /Array\.isArray\(c\.photoUrls\) && c\.photoUrls\.length > 0/.test(orch));
  {
    const flowSrc = readFileSync(new URL("../client/src/components/unit-replacement-flow.tsx", import.meta.url), "utf8");
    check("manual Replace-photos flow sends the full photoUrls gallery when present",
      /photoUrls: \(result\.photoUrls\?\.length/.test(flowSrc));
  }

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
    routes.includes("coverageShort: true") &&
    /coverageShort: true,[\s\S]{0,120}candidateRejected: true,[\s\S]{0,120}candidateRejection: "bedroom-coverage"/.test(routes));
  check("orchestrator threads requireBedroomPhotoCoverage from the record into the commit body",
    /requireBedroomPhotoCoverage: record\.requireBedroomPhotoCoverage === true/.test(orch));
  check("orchestrator counts coverage burns separately for the all-burned failure message",
    orch.includes("burnedCoverage") && /photographed fewer bedrooms/.test(orch));
  // 2026-07-15: a resolver-proof "bedroom-mismatch:N-vs-M" 502 is a coverage
  // reject, not a scrape failure — it must land in the burnedCoverage bucket
  // so the all-burned receipt doesn't send the operator chasing bot-walls.
  check("orchestrator classifies resolver-proof bedroom-mismatch rejects as coverage burns",
    /\/bedroom-mismatch\/i\.test/.test(orch) && /coverageReject/.test(orch));
  // Live Ilikai re-run (2026-07-12, uas_mrhwgeqz_2j7hi8): the first-hit find
  // returned a pool of ONE, the coverage gate burned it, and the job failed
  // with nothing left to try. A coverage-exhausted commit pass re-enters the
  // find phase (same bounded findRestarts budget as the deploy-burst path)
  // with every burned URL excluded so the fresh search can't refind them.
  check("coverage-exhausted commit re-enters the find with burned URLs excluded (bounded restarts)",
    /burnedCoverage > 0 \|\| burnedCommunity > 0/.test(orch) &&
    orch.includes("continue findCommit") &&
    /assembleFindPayload\(record\.propertyId, record\.unitId, record\.attemptedUrls\)/.test(orch));

  // End-to-end staged gate: auto-replace opts in; the disposable folder is
  // checked with the same full engine before the destructive destination
  // replacement; only a typed positive contradiction burns the URL.
  const gateCall = routes.indexOf("verifyStagedUnitSwapCommunity(");
  const destructiveRename = routes.indexOf("await fs.promises.rm(folderPath", gateCall);
  check("staged full-community gate is persisted and opt-in (standalone/manual auto-replace stays backwards-compatible)",
    /requireFullCommunityAudit: record\.requireFullCommunityAudit === true/.test(orch)
    && /requireFullCommunityAudit: input\.requireFullCommunityAudit === true/.test(orch));
  check("strict automatic replacement never reuses a stale prior hydration receipt as a pass",
    /existingSavedCount !== null && opts\.requireFullCommunityAudit !== true/.test(routes));
  check("staged full-community audit runs before destination rm/rename",
    gateCall >= 0 && destructiveRename > gateCall &&
    routes.includes("const verifyStagedUnitSwapCommunity = async") &&
    routes.includes("const result = await runPhotoCommunityCheck("));
  check("staged gate retries inconclusive evidence a bounded number of times",
    routes.includes("STAGED_UNIT_COMMUNITY_GATE_MAX_ATTEMPTS = 2") &&
    routes.includes("STAGED_UNIT_COMMUNITY_GATE_RETRY_MS"));
  const { photoFolderDiskName } = await import("../server/photo-folder-source");
  check("full audit resolves the hidden hydration staging folder without weakening public path sanitization",
    photoFolderDiskName(".replacement-p23-uprop23-a.staging-1784311200000-deadbeef")
      === ".replacement-p23-uprop23-a.staging-1784311200000-deadbeef" &&
    photoFolderDiskName("../../outside") === "-outside");
  check("positive staged mismatch is a typed candidate rejection and auto-replace burns it",
    routes.includes("candidateRejected: hydrated.candidateRejected") &&
    /status === 422 && data\?\.candidateRejected === true/.test(orch) &&
    orch.includes("burnedCommunity"));
  check("inconclusive staged audit returns a typed non-destructive 503 and is never added to attemptedUrls",
    routes.includes("communityGateInconclusive") &&
    /hydrated\.communityGateInconclusive[\s\S]{0,80}\? 503/.test(routes) &&
    !/status === 503[\s\S]{0,300}attemptedUrls/.test(orch));
  check("orchestrator retries a typed inconclusive 503 on the same URL with bounded backoff before failing non-destructively",
    orch.includes("AUTO_REPLACE_COMMUNITY_INCONCLUSIVE_MAX_ATTEMPTS")
    && orch.includes("autoReplaceCommunityRetryBackoffMs(attempt)")
    && /community audit remained inconclusive/.test(orch));
  const reuseUpgradeSource = orch.slice(
    orch.indexOf("async function reuseOrUpgradeAutoReplaceJob"),
    orch.indexOf("export async function startAutoReplaceJob"),
  );
  check("strict reuse upgrades only queued/finding jobs through the transactional newest-authority store",
    reuseUpgradeSource.includes("await mutateStoreStrict")
    && reuseUpgradeSource.includes("newestAutoReplaceJobsByTarget(Object.values(store))")
    && reuseUpgradeSource.includes('authoritative.phase !== "queued" && authoritative.phase !== "finding"')
    && reuseUpgradeSource.includes("requireFullCommunityAudit: authoritative.requireFullCommunityAudit"));
  check("already-strict reuse is idempotent while post-boundary non-strict reuse fails closed",
    reuseUpgradeSource.indexOf("autoReplaceJobSatisfiesRequestedGates(authoritative, requested)")
      < reuseUpgradeSource.indexOf('outcome = { kind: "blocked"')
    && /reuse\.kind === "blocked"[\s\S]{0,180}status: 409/.test(orch));
  check("a cross-instance strict upgrade is monotonic and adopted by the runner lease before commit",
    /requireFullCommunityAudit: snapshot\.requireFullCommunityAudit \|\| current\?\.requireFullCommunityAudit === true/.test(orch)
    && orch.includes("requireFullCommunityAudit ||= current.requireFullCommunityAudit"));
  const commitPostAt = orch.indexOf('postLoopback("/api/unit-swaps"');
  const targetChangedAt = orch.indexOf("data?.targetChanged === true", commitPostAt);
  const generic409At = orch.indexOf("if (status === 409)", targetChangedAt + 1);
  const commitPostSource = orch.slice(commitPostAt, generic409At);
  check("commit sends snapshot and full-community gates and handles targetChanged before generic 409",
    commitPostSource.includes("expectedUnitSwapSnapshot: record.retryUnitSwapSnapshot")
    && commitPostSource.includes("requireFullCommunityAudit: record.requireFullCommunityAudit === true")
    && targetChangedAt > commitPostAt && generic409At > targetChangedAt);
  check("auto-replace awaits persistence of the terminal Guesty push receipt before completing",
    /Object\.assign\(record, \{\s*phase: "completed",\s*guestyPhotoPush,/.test(orch)
    && /persistAutoReplaceRecord\(record,\s*\{\s*strict:\s*true,\s*expectedRunnerId,[\s\S]{0,220}activity:/.test(orch));
}

// Strict audit commit gates survive the persisted store round-trip (a
// deploy mid-commit must not resume WITHOUT the gate and commit a short
// gallery the pre-deploy attempt would have refused).
{
  const round = parseAutoReplaceStore(serializeAutoReplaceStore(
    { j: rec({ jobId: "j", requireBedroomPhotoCoverage: true, requireFullCommunityAudit: true }) }, NOW));
  check("replacement coverage + full-community gates round-trip through the persisted store",
    round.j.requireBedroomPhotoCoverage === true && round.j.requireFullCommunityAudit === true);
  const legacy = parseAutoReplaceStore(JSON.stringify({
    old: { phase: "finding", propertyId: 23, unitId: "u", createdAt: 1, updatedAt: 2 },
  }));
  check("legacy records without the fields parse both strict gates OFF",
    legacy.old.requireBedroomPhotoCoverage === false && legacy.old.requireFullCommunityAudit === false);
}

// The awaited Guesty result survives a deploy/store round-trip, while legacy
// terminal records remain parseable but deliberately lack strict proof.
{
  const pushReceipt = {
    status: "synced" as const,
    guestyListingId: "g-23",
    photoCount: 40,
    successCount: 40,
    verifiedCount: 40,
    skipped: null,
    error: null,
    completedAt: NOW,
  };
  const round = parseAutoReplaceStore(serializeAutoReplaceStore(
    { j: rec({ jobId: "j", phase: "completed", guestyPhotoPush: pushReceipt }) }, NOW));
  check("awaited Guesty gallery push outcome round-trips through the persisted auto-replace job",
    round.j.guestyPhotoPush?.status === "synced"
    && round.j.guestyPhotoPush.successCount === 40
    && round.j.guestyPhotoPush.guestyListingId === "g-23");
  const legacy = parseAutoReplaceStore(JSON.stringify({
    old: { phase: "completed", propertyId: 23, unitId: "u", createdAt: 1, updatedAt: 2 },
  }));
  check("legacy replacement jobs parse with no fabricated Guesty push proof",
    legacy.old.guestyPhotoPush === null);
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
