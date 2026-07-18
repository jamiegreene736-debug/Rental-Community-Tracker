// Locks the Unit Audit Sweep decision logic (shared/unit-audit-sweep-logic.ts):
// persisted job/report stores, resume rules, the stage-order resume seam,
// verdict roll-up honesty (error can never read green), the dashboard badge —
// plus source guards on the server orchestrator's reuse of the EXISTING
// engines and on the routes/index/home wiring so the sweep can't silently
// drift to re-implemented checks or lose its dashboard surfaces.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  COMMUNITY_CONSENSUS_PASSES_DEFAULT,
  RETRYABLE_ATTENTION_PATTERNS,
  SAME_SCENE_STABILITY_MIN_OVERLAP,
  UNIT_AUDIT_STAGE_RETRY_PASSES_DEFAULT,
  classifyUnitAuditConfiguredPhotoCoverage,
  communityCheckUncertaintyOnly,
  communityPhotoFixSelections,
  confirmSameSceneGroups,
  dedupeAutoFixSelections,
  mergeCommunityConsensusPasses,
  MAX_FULL_AUTOMATION_COMMITTED_REPLACEMENTS,
  replaceRungOnCooldown,
  lookupUnitAuditRecord,
  photoFixRungsForUnit,
  unitAuditRetryStageIds,
  type CommunityConsensusPass,
  MAX_UNIT_AUDIT_RESUMES,
  STUCK_UNIT_AUDIT_ERROR,
  UNIT_AUDIT_REPORTS_CAP,
  UNIT_AUDIT_RESUME_WINDOW_MS,
  UNIT_AUDIT_STAGE_IDS,
  UNIT_AUDIT_STAGE_LABELS,
  UNIT_AUDIT_STORE_CAP,
  UNIT_AUDIT_STORE_MAX_AGE_MS,
  failStuckUnitAuditRecords,
  findActiveUnitAuditJob,
  isUnitAuditStatusActive,
  nextUnitAuditStage,
  parseUnitAuditReports,
  parseUnitAuditStore,
  queueRecoverableUnitAuditMutation,
  rollUpUnitAuditVerdict,
  serializeUnitAuditReports,
  serializeUnitAuditStore,
  shouldResumeUnitAuditJob,
  shouldRetryCommittedFullAutomationReplacement,
  summarizeUnitAuditCounts,
  summarizeUnitAuditQueue,
  unitAuditBadge,
  unitAuditChildPollShouldCancel,
  unitAuditChildPollShouldProcessTerminalBeforeCancel,
  unitAuditChildPollShouldTimeout,
  unitAuditHeadline,
  unitAuditVerifyReadBackoffMs,
  unitAuditVerifyReadRetryable,
  upsertUnitAuditStageResult,
  type UnitAuditJobRecord,
  type UnitAuditStageResult,
} from "../shared/unit-audit-sweep-logic";
import { amenityPresenceCandidates, normalizeGuestyAmenityName } from "../shared/guesty-amenity-catalog";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const NOW = 1_760_000_000_000;

const record = (over: Partial<UnitAuditJobRecord> = {}): UnitAuditJobRecord => ({
  jobId: over.jobId ?? "uas_test_1",
  propertyId: 4,
  propertyName: "Test Property",
  status: "running",
  currentStage: "photo-dedupe",
  stages: [],
  message: null,
  error: null,
  createdAt: NOW - 60_000,
  updatedAt: NOW - 30_000,
  resumeCount: 0,
  autoFix: true,
  allowReplace: true,
  fullAutomation: false,
  pendingGuestyGallerySync: false,
  pendingDedupeHiddenCount: 0,
  coverCollageNeedsRefresh: false,
  requiredCoverCollageUrl: null,
  finalGuestyGalleryVerified: false,
  source: "manual",
  ...over,
});

const stage = (
  stageId: (typeof UNIT_AUDIT_STAGE_IDS)[number],
  verdict: UnitAuditStageResult["verdict"],
  detail = `${stageId} ${verdict}`,
): UnitAuditStageResult => ({ stage: stageId, verdict, detail });

// ── Stage vocabulary ─────────────────────────────────────────────────────────
check("11 stages in the documented order (photo-fix right after the photo verifies, channels last)",
  UNIT_AUDIT_STAGE_IDS.length === 11 &&
  UNIT_AUDIT_STAGE_IDS[0] === "resolve" &&
  UNIT_AUDIT_STAGE_IDS[1] === "photo-dedupe" &&
  UNIT_AUDIT_STAGE_IDS[2] === "photo-community" &&
  UNIT_AUDIT_STAGE_IDS[3] === "ota-scan" &&
  UNIT_AUDIT_STAGE_IDS[4] === "photo-fix" &&
  UNIT_AUDIT_STAGE_IDS[5] === "descriptions" &&
  UNIT_AUDIT_STAGE_IDS[10] === "channels");

check("every stage has an operator-facing label",
  UNIT_AUDIT_STAGE_IDS.every((id) => (UNIT_AUDIT_STAGE_LABELS[id] ?? "").length > 2));

// ── Job store round-trip ─────────────────────────────────────────────────────
check("store: garbage / null parses to empty",
  Object.keys(parseUnitAuditStore("not json")).length === 0 &&
  Object.keys(parseUnitAuditStore(null)).length === 0 &&
  Object.keys(parseUnitAuditStore("[1,2]")).length === 0);

let strictQueueFailureObserved = false;
const firstQueuedMutation = queueRecoverableUnitAuditMutation(Promise.resolve(), async () => {
  throw new Error("simulated durable write failure");
});
try {
  await firstQueuedMutation.operation;
} catch {
  strictQueueFailureObserved = true;
}
let laterQueuedMutationRan = false;
const secondQueuedMutation = queueRecoverableUnitAuditMutation(firstQueuedMutation.tail, async () => {
  laterQueuedMutationRan = true;
});
await secondQueuedMutation.operation;
check("store queue: strict failure propagates to its caller without poisoning the next queued mutation",
  strictQueueFailureObserved && laterQueuedMutationRan);

check("store: valid record round-trips with stages intact",
  (() => {
    const r = record({ stages: [stage("resolve", "pass"), stage("photo-dedupe", "attention")] });
    const parsed = parseUnitAuditStore(serializeUnitAuditStore({ [r.jobId]: r }, NOW));
    const back = parsed[r.jobId];
    return back?.propertyId === 4 && back.stages.length === 2 &&
      back.stages[1].verdict === "attention" && back.currentStage === "photo-dedupe";
  })());

check("store: invalid stage ids / verdicts are dropped, record survives",
  (() => {
    const raw = JSON.stringify({
      j1: { ...record(), stages: [{ stage: "nope", verdict: "pass", detail: "" }, { stage: "resolve", verdict: "sideways", detail: "" }, stage("pricing", "pass")] },
    });
    const back = parseUnitAuditStore(raw).j1;
    return back?.stages.length === 1 && back.stages[0].stage === "pricing";
  })());

check("store: records older than the max age are evicted at write time",
  (() => {
    const old = record({ jobId: "old", updatedAt: NOW - UNIT_AUDIT_STORE_MAX_AGE_MS - 1 });
    const fresh = record({ jobId: "fresh", updatedAt: NOW });
    const parsed = parseUnitAuditStore(serializeUnitAuditStore({ old, fresh }, NOW));
    return !parsed.old && !!parsed.fresh;
  })());

check("store: cap keeps the newest records",
  (() => {
    const store: Record<string, UnitAuditJobRecord> = {};
    for (let i = 0; i < UNIT_AUDIT_STORE_CAP + 5; i++) {
      store[`j${i}`] = record({ jobId: `j${i}`, updatedAt: NOW - i * 1000 });
    }
    const parsed = parseUnitAuditStore(serializeUnitAuditStore(store, NOW));
    return Object.keys(parsed).length === UNIT_AUDIT_STORE_CAP && !!parsed.j0 && !parsed[`j${UNIT_AUDIT_STORE_CAP + 4}`];
  })());

check("store: autoFix round-trips; records from before the auto-fix PR default ON",
  (() => {
    const off = record({ jobId: "off", autoFix: false });
    const parsed = parseUnitAuditStore(serializeUnitAuditStore({ off }, NOW));
    const legacy = parseUnitAuditStore(JSON.stringify({ old: { ...record({ jobId: "old" }), autoFix: undefined } }));
    return parsed.off?.autoFix === false && legacy.old?.autoFix === true;
  })());

check("store: allowReplace round-trips; legacy records default ON",
  (() => {
    const off = record({ jobId: "off2", allowReplace: false });
    const parsed = parseUnitAuditStore(serializeUnitAuditStore({ off2: off }, NOW));
    const legacy = parseUnitAuditStore(JSON.stringify({ old: { ...record({ jobId: "old" }), allowReplace: undefined } }));
    return parsed.off2?.allowReplace === false && legacy.old?.allowReplace === true;
  })());

check("store: fullAutomation round-trips; legacy records default OFF",
  (() => {
    const strict = record({ jobId: "strict", fullAutomation: true });
    const parsed = parseUnitAuditStore(serializeUnitAuditStore({ strict }, NOW));
    const legacy = parseUnitAuditStore(JSON.stringify({ old: { ...record({ jobId: "old" }), fullAutomation: undefined } }));
    return parsed.strict?.fullAutomation === true && legacy.old?.fullAutomation === false;
  })());

check("store: pending Guesty gallery handoff survives restart; legacy records are clean",
  (() => {
    const pending = record({
      jobId: "pending-gallery",
      pendingGuestyGallerySync: true,
      pendingDedupeHiddenCount: 4,
      coverCollageNeedsRefresh: true,
      requiredCoverCollageUrl: "https://cdn.example/current-audit-collage.jpg",
      finalGuestyGalleryVerified: false,
    });
    const parsed = parseUnitAuditStore(serializeUnitAuditStore({ pending }, NOW));
    const legacy = parseUnitAuditStore(JSON.stringify({ old: {
      ...record({ jobId: "old" }),
      pendingGuestyGallerySync: undefined,
      pendingDedupeHiddenCount: undefined,
      coverCollageNeedsRefresh: undefined,
      requiredCoverCollageUrl: undefined,
      finalGuestyGalleryVerified: undefined,
    } }));
    return parsed["pending-gallery"]?.pendingGuestyGallerySync === true
      && parsed["pending-gallery"]?.pendingDedupeHiddenCount === 4
      && parsed["pending-gallery"]?.coverCollageNeedsRefresh === true
      && parsed["pending-gallery"]?.requiredCoverCollageUrl === "https://cdn.example/current-audit-collage.jpg"
      && parsed["pending-gallery"]?.finalGuestyGalleryVerified === false
      && legacy.old?.pendingGuestyGallerySync === false
      && legacy.old?.pendingDedupeHiddenCount === 0
      && legacy.old?.coverCollageNeedsRefresh === false
      && legacy.old?.requiredCoverCollageUrl === null
      && legacy.old?.finalGuestyGalleryVerified === false;
  })());

check("store: exact-gallery receipt validates URL bounds and preserves a completed marker",
  (() => {
    const verified = record({
      jobId: "verified-gallery",
      finalGuestyGalleryVerified: true,
    });
    const invalid = record({
      jobId: "invalid-gallery",
      requiredCoverCollageUrl: `https://cdn.example/${"x".repeat(2_100)}`,
    });
    const inconsistent = record({
      jobId: "inconsistent-gallery",
      pendingGuestyGallerySync: true,
      coverCollageNeedsRefresh: true,
      requiredCoverCollageUrl: "https://cdn.example/still-pending.jpg",
      finalGuestyGalleryVerified: true,
    });
    const parsed = parseUnitAuditStore(serializeUnitAuditStore({ verified, invalid, inconsistent }, NOW));
    return parsed["verified-gallery"]?.finalGuestyGalleryVerified === true
      && parsed["invalid-gallery"]?.requiredCoverCollageUrl === null
      && parsed["inconsistent-gallery"]?.finalGuestyGalleryVerified === false;
  })());

check("store: source round-trips ('cron' kept; junk/legacy defaults to 'manual')",
  (() => {
    const cron = record({ jobId: "cr", source: "cron" });
    const parsed = parseUnitAuditStore(serializeUnitAuditStore({ cr: cron }, NOW));
    const junk = parseUnitAuditStore(JSON.stringify({ j: { ...record({ jobId: "j" }), source: "weird" } }));
    return parsed.cr?.source === "cron" && junk.j?.source === "manual";
  })());

// ── Photo fix ladder rungs (PR 3) ────────────────────────────────────────────
check("ladder: bedroom shortfall walks re-scrape → find-new → replace",
  photoFixRungsForUnit({ bedroomShort: true }).join(",") === "rescrape,find-new,replace");

check("ladder: community mismatch skips the pointless re-scrape (same gallery, same community)",
  photoFixRungsForUnit({ communityMismatch: true }).join(",") === "find-new,replace");

check("ladder: OTA-found photos go straight to unit replacement (any photo of that unit is compromised)",
  photoFixRungsForUnit({ otaFound: true }).join(",") === "replace" &&
  photoFixRungsForUnit({ otaFound: true, bedroomShort: true, communityMismatch: true }).join(",") === "replace");

check("strict ladder: a committed candidate with a positive community/bedroom failure gets another bounded attempt",
  shouldRetryCommittedFullAutomationReplacement({
    fullAutomation: true,
    rung: "replace",
    gateDecision: "reject",
    reasonCode: "community-mismatch",
    strictSyncFailed: false,
    committedAttempts: 1,
  }) && MAX_FULL_AUTOMATION_COMMITTED_REPLACEMENTS === 3);

check("strict ladder: inconclusive proof, sync failure, non-replace rungs, and the cap never trigger another destructive swap",
  !shouldRetryCommittedFullAutomationReplacement({
    fullAutomation: true, rung: "replace", gateDecision: "inconclusive", reasonCode: "inconclusive",
    strictSyncFailed: false, committedAttempts: 1,
  })
  && !shouldRetryCommittedFullAutomationReplacement({
    fullAutomation: true, rung: "replace", gateDecision: "reject", reasonCode: "bedroom-coverage",
    strictSyncFailed: true, committedAttempts: 1,
  })
  && !shouldRetryCommittedFullAutomationReplacement({
    fullAutomation: true, rung: "find-new", gateDecision: "reject", reasonCode: "community-mismatch",
    strictSyncFailed: false, committedAttempts: 1,
  })
  && !shouldRetryCommittedFullAutomationReplacement({
    fullAutomation: true, rung: "replace", gateDecision: "reject", reasonCode: "community-mismatch",
    strictSyncFailed: false, committedAttempts: MAX_FULL_AUTOMATION_COMMITTED_REPLACEMENTS,
  }));

check("ladder: no problems → no rungs",
  photoFixRungsForUnit({}).length === 0);

// ── Cron replacement rails (2026-07-12) ──────────────────────────────────────
check("cooldown: a swap inside the window blocks another cron swap; outside/never/0-days does not",
  replaceRungOnCooldown(NOW - 5 * 86_400_000, NOW, 28) === true &&
  replaceRungOnCooldown(NOW - 40 * 86_400_000, NOW, 28) === false &&
  replaceRungOnCooldown(null, NOW, 28) === false &&
  replaceRungOnCooldown(NOW - 5 * 86_400_000, NOW, 0) === false);

// ── Auto-fix: duplicate-photo selection (PR 2; same-scene opt-in 2026-07-12) ─
const DEDUPE_GROUPS = [
  { kind: "exact" as const, folder: "f1", members: [{ filename: "a.jpg", keep: true }, { filename: "b.jpg", keep: false }] },
  { kind: "near" as const, folder: "f2", members: [{ filename: "c.jpg", keep: false }, { filename: "d.jpg", keep: true }] },
  { kind: "same-scene" as const, folder: "f1", members: [{ filename: "e.jpg", keep: true }, { filename: "f.jpg", keep: false }] },
];

check("dedupe auto-fix default: hash groups' non-keepers only (same-scene excluded)",
  (() => {
    const sel = dedupeAutoFixSelections(DEDUPE_GROUPS);
    return sel.remove.length === 2 &&
      sel.remove.some((r) => r.folder === "f1" && r.filename === "b.jpg") &&
      sel.remove.some((r) => r.folder === "f2" && r.filename === "c.jpg") &&
      !sel.remove.some((r) => r.filename === "f.jpg") &&
      sel.hashGroupCount === 2 && sel.sameSceneCount === 1 && sel.sameSceneIncluded === false;
  })());

check("dedupe auto-fix with includeSameScene: same-scene non-keepers included, keepers still safe (operator's 2026-07-12 directive)",
  (() => {
    const sel = dedupeAutoFixSelections(DEDUPE_GROUPS, { includeSameScene: true });
    return sel.remove.length === 3 &&
      sel.remove.some((r) => r.filename === "f.jpg") &&
      !sel.remove.some((r) => r.filename === "e.jpg") &&
      sel.sameSceneIncluded === true;
  })());

check("dedupe auto-fix: keepers are never selected; empty input is a no-op",
  (() => {
    const sel = dedupeAutoFixSelections([
      { kind: "exact", folder: "f", members: [{ filename: "keep.jpg", keep: true }] },
    ]);
    return sel.remove.length === 0 && dedupeAutoFixSelections([]).remove.length === 0;
  })());

// ── Auto-fix: community-folder photo cleanup (2026-07-12) ────────────────────
const COMM = "community-coconut";
const communityFixInput = (over: Record<string, unknown> = {}) => ({
  communityFolder: COMM,
  photoVerdicts: [
    { id: "C1", folder: COMM, filename: "red.jpg", match: "no" as const },
    { id: "C2", folder: COMM, filename: "yellow.jpg", match: "uncertain" as const },
    { id: "C3", folder: COMM, filename: "junky.jpg", match: "yes" as const },
    { id: "C4", folder: COMM, filename: "dupe.jpg", match: "yes" as const },
  ],
  junk: [{ id: "C3", reason: "floor plan" }],
  duplicates: [
    { scope: "cross-folder", a: { folder: COMM, filename: "dupe.jpg" }, b: { folder: "unit-a", filename: "dupe.jpg" } },
    { scope: "cross-folder", a: { folder: "unit-a", filename: "shared.jpg" }, b: { folder: "unit-b", filename: "shared.jpg" } },
  ],
  visibleCount: 10,
  ...over,
});

check("community fix: hides RED votes + junk (via verdict id) + community-side cross-dupes; yellow NEVER hidden",
  (() => {
    const sel = communityPhotoFixSelections(communityFixInput());
    const files = sel.hide.map((h) => h.filename);
    return files.includes("red.jpg") && files.includes("junky.jpg") && files.includes("dupe.jpg") &&
      !files.includes("yellow.jpg") && sel.hide.every((h) => h.folder === COMM);
  })());

check("community fix: unit↔unit cross-dupes are review-only (never auto-picked)",
  (() => {
    const sel = communityPhotoFixSelections(communityFixInput());
    return sel.reviewOnly.length === 1 && /shared\.jpg/.test(sel.reviewOnly[0]) &&
      !sel.hide.some((h) => h.filename === "shared.jpg");
  })());

check("community fix: floor caps the hide list — no-loss cross-dupes rank first, then junk, then red votes",
  (() => {
    const sel = communityPhotoFixSelections(communityFixInput({ visibleCount: 4 }));
    // 4 visible − floor 3 = 1 hide allowed; the cross-dupe (zero content loss) wins.
    return sel.hide.length === 1 && sel.hide[0].filename === "dupe.jpg" && sel.skippedForFloor === 2;
  })());

check("community fix: never hides photos from other folders and dedupes repeats",
  (() => {
    const sel = communityPhotoFixSelections(communityFixInput({
      photoVerdicts: [
        { id: "U1", folder: "unit-a", filename: "u.jpg", match: "no" as const },
        { id: "C1", folder: COMM, filename: "red.jpg", match: "no" as const },
      ],
      junk: [{ id: "C1", reason: "also junk" }],
      duplicates: [],
    }));
    return sel.hide.length === 1 && sel.hide[0].filename === "red.jpg";
  })());

// ── Amenity presence: push-parity normalization (2026-07-12) ─────────────────
check("normalizeGuestyAmenityName matches the push route's norm() semantics",
  normalizeGuestyAmenityName("BBQ / Grill") === "bbq grill" &&
  normalizeGuestyAmenityName("Outdoor seating (furniture)") === "outdoor seating furniture" &&
  normalizeGuestyAmenityName("AIR_CONDITIONING") === "air conditioning");

check("amenityPresenceCandidates: alias target + label + key, all normalized (OCEAN_VIEW finds Guesty's 'Sea view')",
  (() => {
    const c = amenityPresenceCandidates("OCEAN_VIEW");
    return c.includes("sea view") && c.includes("ocean view");
  })());

check("amenityPresenceCandidates: a pushed listing name matches through the candidates (the false-'27 missing' class)",
  (() => {
    const stored = ["Sea view", "BBQ grill", "Wireless Internet"].map(normalizeGuestyAmenityName);
    const present = new Set(stored);
    return ["OCEAN_VIEW", "BBQ_GRILL", "WIFI"].every((k) =>
      amenityPresenceCandidates(k).some((cand) => present.has(cand)));
  })());

// ── Prototype-pollution guard (CodeQL, PR #1013) ─────────────────────────────
check("store: a crafted __proto__ key is dropped at parse and unreachable via lookup",
  (() => {
    const raw = JSON.stringify({ ["__proto__"]: record({ jobId: "__proto__" }), good: record({ jobId: "good" }) });
    const store = parseUnitAuditStore(raw);
    const probe: Record<string, unknown> = {};
    return lookupUnitAuditRecord(store, "__proto__") === null &&
      lookupUnitAuditRecord(store, "constructor") === null &&
      lookupUnitAuditRecord(store, "good")?.jobId === "good" &&
      (probe as any).status === undefined; // Object.prototype untouched
  })());

check("lookupUnitAuditRecord never returns inherited properties",
  lookupUnitAuditRecord({} as Record<string, unknown>, "toString") === null);

check("reports: __proto__/constructor keys are dropped at parse",
  (() => {
    const raw = JSON.stringify({
      ["__proto__"]: { propertyId: 1, propertyName: "x", jobId: "j", finishedAt: "2026-01-01", verdict: "pass", stages: [] },
      "7": { propertyId: 7, propertyName: "ok", jobId: "j2", finishedAt: "2026-01-01", verdict: "pass", stages: [] },
    });
    const reports = parseUnitAuditReports(raw);
    return lookupUnitAuditRecord(reports, "__proto__") === null && !!reports["7"];
  })());

// ── Reports store ────────────────────────────────────────────────────────────
check("reports: round-trip keeps verdict + stages; junk verdicts dropped",
  (() => {
    const raw = serializeUnitAuditReports({
      "4": { propertyId: 4, propertyName: "P4", jobId: "j", finishedAt: "2026-07-11T00:00:00Z", verdict: "attention", stages: [stage("pricing", "attention")] },
      "5": { propertyId: 5, propertyName: "P5", jobId: "j2", finishedAt: "2026-07-11T00:00:00Z", verdict: "sideways" as any, stages: [] },
    });
    const back = parseUnitAuditReports(raw);
    return back["4"]?.verdict === "attention" && back["4"].stages.length === 1 && !back["5"];
  })());

check("reports: cap keeps the newest by finishedAt",
  (() => {
    const reports: Record<string, any> = {};
    for (let i = 0; i < UNIT_AUDIT_REPORTS_CAP + 3; i++) {
      reports[String(i)] = { propertyId: i + 1, propertyName: `P${i}`, jobId: `j${i}`, finishedAt: new Date(NOW - i * 60_000).toISOString(), verdict: "pass", stages: [] };
    }
    const back = parseUnitAuditReports(serializeUnitAuditReports(reports));
    return Object.keys(back).length === UNIT_AUDIT_REPORTS_CAP && !!back["0"] && !back[String(UNIT_AUDIT_REPORTS_CAP + 2)];
  })());

// ── Active lookup / resume rules ─────────────────────────────────────────────
check("one active sweep per property is discoverable; terminal ones are not",
  (() => {
    const store = {
      a: record({ jobId: "a", status: "completed" }),
      b: record({ jobId: "b", status: "running" }),
    };
    return findActiveUnitAuditJob(store, 4)?.jobId === "b" && findActiveUnitAuditJob(store, 99) === null;
  })());

check("resume: active + inside window + under cap → yes",
  shouldResumeUnitAuditJob(record({ updatedAt: NOW - 5 * 60_000 }), NOW) === true);

check("resume: outside the window → no",
  shouldResumeUnitAuditJob(record({ updatedAt: NOW - UNIT_AUDIT_RESUME_WINDOW_MS - 1 }), NOW) === false);

check("resume: cap exhausted → no",
  shouldResumeUnitAuditJob(record({ resumeCount: MAX_UNIT_AUDIT_RESUMES }), NOW) === false);

check("resume: terminal statuses never resume",
  (["completed", "failed", "cancelled"] as const).every((s) =>
    shouldResumeUnitAuditJob(record({ status: s }), NOW) === false));

check("failStuck: unresumable active records terminalize with the honest error; live + resumable protected",
  (() => {
    const store = {
      stuck: record({ jobId: "stuck", resumeCount: MAX_UNIT_AUDIT_RESUMES }),
      live: record({ jobId: "live", resumeCount: MAX_UNIT_AUDIT_RESUMES }),
      okay: record({ jobId: "okay" }),
    };
    const failedIds = failStuckUnitAuditRecords(store, NOW, ["live"]);
    return failedIds.length === 1 && failedIds[0] === "stuck" &&
      store.stuck.status === "failed" && store.stuck.error === STUCK_UNIT_AUDIT_ERROR &&
      store.live.status === "running" && store.okay.status === "running";
  })());

// ── Resume seam: next stage = first missing, execution order ────────────────
check("nextUnitAuditStage: empty → resolve; contiguous prefix → next; gap → the gap",
  nextUnitAuditStage(record({ stages: [] })) === "resolve" &&
  nextUnitAuditStage(record({ stages: [stage("resolve", "pass"), stage("photo-dedupe", "pass")] })) === "photo-community" &&
  nextUnitAuditStage(record({ stages: [stage("resolve", "pass"), stage("photo-community", "pass")] })) === "photo-dedupe");

check("nextUnitAuditStage: all stages recorded → null (sweep complete)",
  nextUnitAuditStage(record({ stages: UNIT_AUDIT_STAGE_IDS.map((id) => stage(id, "pass")) })) === null);

check("upsert replaces a stage's row (resolve re-runs on resume) and keeps canonical order",
  (() => {
    const stages = upsertUnitAuditStageResult(
      [stage("photo-dedupe", "pass"), stage("resolve", "attention")],
      stage("resolve", "pass", "re-resolved"),
    );
    return stages.length === 2 && stages[0].stage === "resolve" && stages[0].detail === "re-resolved" && stages[1].stage === "photo-dedupe";
  })());

// ── Verdict roll-up honesty ──────────────────────────────────────────────────
check("roll-up: all pass/fixed/skipped → pass",
  rollUpUnitAuditVerdict([stage("resolve", "pass"), stage("pricing", "fixed"), stage("cover-collage", "skipped")]) === "pass");

check("roll-up severity: failed > error > attention",
  rollUpUnitAuditVerdict([stage("resolve", "pass"), stage("ota-scan", "failed"), stage("pricing", "error"), stage("amenities", "attention")]) === "failed" &&
  rollUpUnitAuditVerdict([stage("resolve", "pass"), stage("pricing", "error"), stage("amenities", "attention")]) === "error" &&
  rollUpUnitAuditVerdict([stage("resolve", "pass"), stage("amenities", "attention")]) === "attention");

check("roll-up: an unverified check can NEVER read green (error ≠ pass)",
  rollUpUnitAuditVerdict([stage("resolve", "pass"), stage("ota-scan", "error")]) !== "pass");

check("roll-up: degenerate all-skipped / empty reports are error, not pass",
  rollUpUnitAuditVerdict([]) === "error" &&
  rollUpUnitAuditVerdict([stage("cover-collage", "skipped")]) === "error");

check("counts + headline: attention/error/failed named plainly, good tallied",
  (() => {
    const stages = [
      stage("resolve", "pass"), stage("photo-dedupe", "pass"), stage("descriptions", "failed"),
      stage("pricing", "attention"), stage("ota-scan", "error"),
    ];
    const c = summarizeUnitAuditCounts(stages);
    const h = unitAuditHeadline(stages);
    return c.pass === 2 && c.failed === 1 && c.attention === 1 && c.error === 1 &&
      /1 failed/.test(h) && /1 needs your attention/.test(h) && /1 could not be verified/.test(h) && /2 passed/.test(h);
  })());

check("headline: clean sweep reads as all-passed",
  /All checks passed/.test(unitAuditHeadline([stage("resolve", "pass"), stage("pricing", "pass")])));

// ── Dashboard badge ──────────────────────────────────────────────────────────
check("badge: live sweep wins over any report and shows stage progress",
  (() => {
    const b = unitAuditBadge(
      { verdict: "pass", finishedAt: "2026-07-10T00:00:00Z", stages: [] },
      { status: "running", currentStage: "ota-scan" },
    );
    return b.kind === "running" && b.label === "4/11" && /OTA duplicate scan/.test(b.title);
  })());

check("badge: queued live sweep (no stage yet) still reads running",
  unitAuditBadge(null, { status: "queued", currentStage: null }).kind === "running");

check("badge: never audited → quiet dash inviting a run",
  (() => {
    const b = unitAuditBadge(null, null);
    return b.kind === "never" && b.label === "—" && /Never audited/.test(b.title);
  })());

check("badge: pass shows ✓ + date; attention shows the count; failed shows the count",
  (() => {
    const passB = unitAuditBadge({ verdict: "pass", finishedAt: "2026-07-11T12:00:00Z", stages: [stage("resolve", "pass")] }, null);
    const attn = unitAuditBadge({ verdict: "attention", finishedAt: "2026-07-11T12:00:00Z", stages: [stage("pricing", "attention"), stage("amenities", "attention")] }, null);
    const failB = unitAuditBadge({ verdict: "failed", finishedAt: "2026-07-11T12:00:00Z", stages: [stage("ota-scan", "failed")] }, null);
    return passB.kind === "pass" && passB.label.startsWith("✓") &&
      attn.kind === "attention" && attn.label === "⚠ 2" &&
      failB.kind === "failed" && failB.label === "✕ 1";
  })());

check("badge: terminal error report reads unverified, never green",
  unitAuditBadge({ verdict: "error", finishedAt: "2026-07-11T12:00:00Z", stages: [stage("ota-scan", "error")] }, null).kind === "error");

// ── Queue summary ────────────────────────────────────────────────────────────
check("queue: active first (oldest first), then recent terminals (newest first)",
  (() => {
    const store = {
      t1: record({ jobId: "t1", status: "completed", updatedAt: NOW - 10_000 }),
      a2: record({ jobId: "a2", status: "running", createdAt: NOW - 5_000 }),
      a1: record({ jobId: "a1", status: "running", createdAt: NOW - 50_000 }),
      old: record({ jobId: "old", status: "failed", updatedAt: NOW - 3 * 60 * 60 * 1000 }),
    };
    const q = summarizeUnitAuditQueue(store, NOW);
    return q.activeCount === 2 && q.jobs.map((j) => j.jobId).join(",") === "a1,a2,t1";
  })());

check("isUnitAuditStatusActive: queued/running only",
  isUnitAuditStatusActive("queued") && isUnitAuditStatusActive("running") &&
  !isUnitAuditStatusActive("completed") && !isUnitAuditStatusActive("cancelled"));

const configuredCommunity = { role: "community" as const, label: "Community — Test", folder: "community-test", publishedCount: 3 };
const configuredUnit = { role: "unit" as const, label: "Unit A (2BR)", folder: "unit-a", publishedCount: 5, unitId: "unit-a" };
const requiredUnits = [{ label: configuredUnit.label, unitId: configuredUnit.unitId }];
check("strict folder coverage: unavailable inventory and positive-but-omitted groups fail closed as infrastructure errors",
  classifyUnitAuditConfiguredPhotoCoverage({ configured: null, represented: [], requiredUnits }).inventoryUnavailable &&
  classifyUnitAuditConfiguredPhotoCoverage({
    configured: [configuredCommunity, configuredUnit],
    represented: [{ role: "community", label: configuredCommunity.label, folder: configuredCommunity.folder }],
    requiredUnits,
  }).inventoryUnavailable);
check("strict folder coverage: genuinely empty configured folders remain repairable, not infrastructure failures",
  (() => {
    const coverage = classifyUnitAuditConfiguredPhotoCoverage({
      configured: [
        configuredCommunity,
        { ...configuredUnit, publishedCount: 0 },
      ],
      represented: [{ role: "community", label: configuredCommunity.label, folder: configuredCommunity.folder }],
      requiredUnits,
    });
    return !coverage.inventoryUnavailable && !coverage.communityMissing &&
      coverage.missingUnits.length === 1 && coverage.missingUnits[0].unitId === configuredUnit.unitId;
  })());

// ── Source guards: the orchestrator must REUSE the existing engines ──────────
const serverSrc = readFileSync(new URL("../server/unit-audit-sweep.ts", import.meta.url), "utf8");

check("server: photo groups resolved via buildPhotoCommunityCheckRequestForProperty (active swap folders, drafts included)",
  serverSrc.includes("buildPhotoCommunityCheckRequestForProperty"));

check("server: dedupe stage calls the existing scanForDuplicatePhotos engine",
  serverSrc.includes("scanForDuplicatePhotos"));

check("server: community stage loopbacks POST /api/builder/photo-community-check with propertyId (persists → Comm QA)",
  /photo-community-check/.test(serverSrc) && /propertyId: target\.propertyId/.test(serverSrc));

check("server: OTA stage kicks the existing deep scan + polls photo_listing_checks rows",
  serverSrc.includes("/api/photo-listing-check/run") && serverSrc.includes("getPhotoListingCheckByFolder"));

check("server: descriptions stage uses the shared placeholder detector (push-guard parity)",
  serverSrc.includes("findDescriptionPlaceholders") && serverSrc.includes("AREA_SECTION_HEADERS"));

check("server: collage stage reads the cover_collages.v1 record (shared key)",
  serverSrc.includes("COVER_COLLAGE_SETTING_KEY"));

check("server: pricing stage computes the shared match confirmation from stored rows",
  serverSrc.includes("computeMarketRateMatchConfirmation"));

check("server: license check uses the shared sample-license detector",
  serverSrc.includes("isPlaceholderLicenseValue"));

check("server: Guesty reads go through the loopback proxy (token stays server-side, one client)",
  serverSrc.includes("/api/guesty-proxy/listings/"));

check("server: channel stage reuses GET /api/dashboard/channel-status",
  serverSrc.includes("/api/dashboard/channel-status"));

check("server: stage errors report verdict \"error\" — absence of evidence never passes",
  /verdict: "error", detail: `Check could not run/.test(serverSrc));

check("server: request-supplied jobId lookups go through lookupUnitAuditRecord (own properties only)",
  /return lookupUnitAuditRecord\(parseUnitAuditStore\(raw \?\? null\), jobId\);/.test(serverSrc));

// ── Source guards: auto-fix wiring (PR 2) reuses the EXISTING fix engines ────
check("fix: dedupe apply goes through the validated apply route (keep-one-per-group, never-empty-folder) with the shared hash-only selection",
  serverSrc.includes("/api/builder/photo-dedupe-apply") && serverSrc.includes("dedupeAutoFixSelections"));

check("full automation: every multi-photo folder must complete Claude alternate-angle dedupe on initial and re-verify scans",
  serverSrc.includes("requireCompleteVision(proposal, \"the initial gallery scan\")") &&
  serverSrc.includes("requireCompleteVision(confirmation, \"the initial clean-gallery confirmation\")") &&
  serverSrc.includes("requireCompleteVision(second, `the ${phase} double-check`)") &&
  serverSrc.includes("requireCompleteVision(proposal, \"the post-hide re-scan\")") &&
  serverSrc.includes("requireCompleteVision(finalPrimary, \"the final post-removal scan\")") &&
  serverSrc.includes("requireCompleteVision(finalConfirmation, \"the final post-removal stability confirmation\")") &&
  serverSrc.includes("requireCompleteVision: record.fullAutomation") &&
  serverSrc.includes("!folder.visionComplete"));

check("full automation: a second apply round cannot claim clean without a fresh two-scan stability verification",
  serverSrc.includes("Two apply rounds completed — running the required fresh final scan") &&
  serverSrc.includes("the strict audit will not claim the gallery is clean") &&
  serverSrc.includes('verdict: "error"') &&
  serverSrc.includes("AUDIT_DEDUPE_DOUBLE_CHECK=0 disables it"));

check("full automation: exhaustive 100-photo pair coverage fits the dedupe stage's bounded timeout",
  serverSrc.includes('"photo-dedupe": 40 * 60_000') &&
  serverSrc.includes("a 100-photo folder needs six calls per exhaustive scan"));

check("fix: descriptions regenerate uses the SAME generator + disclosure composition as the builder button, persists overrides, refuses generator fallback",
  serverSrc.includes("/api/community/generate-listing") &&
  serverSrc.includes("composeSummaryWithDisclosures") &&
  serverSrc.includes("composeSpaceFromUnitDescriptions") &&
  serverSrc.includes("upsertPropertyDescriptionOverrides") &&
  /warning.*refused|refused.*warning/i.test(serverSrc));

check("full automation: descriptions always regenerate and require explicit Claude provenance",
  serverSrc.includes("record.fullAutomation || problems.placeholderFields") &&
  serverSrc.includes('generation?.method !== "claude"') &&
  serverSrc.includes("Claude description generation did not complete"));

check("full automation: all seven operator-editable description fields are required and persisted",
  serverSrc.includes('["title", "summary", "space", "neighborhood", "transit", "access", "houseRules"]') &&
  serverSrc.includes("if (access) patch.access = access") &&
  serverSrc.includes("if (houseRules) patch.houseRules = houseRules"));

check("full automation: a Guesty description push counts only after verified read-back",
  serverSrc.includes('(push.data as any)?.success === true') &&
  serverSrc.includes('(push.data as any)?.verified === true'));

check("fix: regenerated copy pushes ONLY the regenerated fields via push-descriptions (notes stays compliance-owned)",
  serverSrc.includes("/api/builder/push-descriptions") && !/descriptions:\s*\{[^}]*notes/.test(serverSrc));

check("fix: amenities fire the scan route (scan + save + ADD-ONLY Guesty union push in one call)",
  serverSrc.includes("/api/builder/scan-amenities"));

check("full automation: amenities require complete Claude vision and a durable photo-fingerprint receipt",
  serverSrc.includes("strictVisionComplete") && serverSrc.includes("claude-vision") &&
  serverSrc.includes("AMENITY_SCAN_RECEIPTS_SETTING_KEY") && serverSrc.includes("photoFingerprint"));

check("fix: cover collage drives the one-click AI endpoint with published-photo candidates",
  serverSrc.includes("/api/builder/auto-cover-collage"));

check("full automation: missing/empty configured photo folders cannot disappear from the audit",
  serverSrc.includes("configuredPhotoFolderStatusesForProperty") &&
  serverSrc.includes("strictPhotoFolderGaps") &&
  serverSrc.includes("omitted folders cannot count as a successful full audit"));

check("full automation: an inventory read failure stops safely and never masquerades as absent folders eligible for replacement",
  (() => {
    const resolveSource = serverSrc.slice(
      serverSrc.indexOf("async function stageResolve("),
      serverSrc.indexOf("async function stagePhotoDedupe("),
    );
    const photoFixSource = serverSrc.slice(
      serverSrc.indexOf("async function stagePhotoFix("),
      serverSrc.indexOf("async function stageDescriptions("),
    );
    return resolveSource.includes("strictPhotoFolderGaps(target).inventoryUnavailable") &&
      resolveSource.indexOf("strict audit stopped before duplicate cleanup or any other mutation") < resolveSource.indexOf("targets.set(record.jobId, target)") &&
      photoFixSource.includes("photo repair stopped before OTA planning, repull, or replacement") &&
      photoFixSource.indexOf("photo repair stopped before OTA planning, repull, or replacement") < photoFixSource.indexOf("getPhotoListingCheckByFolder");
  })());

check("full automation: a missing/empty unit folder enters the bounded repair ladder with replacement fallback",
  serverSrc.includes("configured photo folder is empty") &&
  serverSrc.includes('missingFolder.folder ? ["rescrape", "find-new", "replace"] : ["replace"]') &&
  serverSrc.includes("problems.set(missing.label, { bedroomShort: true, communityMismatch: false })"));

check("full automation: an empty configured community folder enters Find-new-community-photos and rechecks; an unconfigured folder fails honestly",
  serverSrc.includes("Community folder is empty — running Find new community photos") &&
  serverSrc.includes("Empty community folder repull") &&
  serverSrc.includes("Checking the newly populated community folder") &&
  serverSrc.includes("no folder is configured, so the automatic repull cannot run"));

check("full automation: collage refuses a missing community pool even when an old receipt or unit photos exist",
  serverSrc.includes("if (strictGaps.communityMissing)") &&
  serverSrc.includes("no existing receipt or unit-only pair was accepted"));

check("full automation: mapped collage arms the durable final sync before its Guesty PUT and persists this audit's returned URL",
  (() => {
    const start = serverSrc.indexOf("async function stageCoverCollage(");
    const end = serverSrc.indexOf("async function stageLayout(", start);
    const collageStage = serverSrc.slice(start, end);
    const arm = collageStage.indexOf("await markGuestyGallerySyncPending(record, {");
    const invoke = collageStage.indexOf('loopbackJson("POST", "/api/builder/auto-cover-collage"');
    const localFileVerified = collageStage.indexOf("const onDisk = await fs.promises.access(file)");
    const acceptedIdentity = collageStage.lastIndexOf("requiredCoverCollageUrl: generatedCollageUrl");
    return start >= 0 && end > start && arm >= 0 && invoke > arm
      && collageStage.includes("requiredCoverCollageUrl: null")
      && collageStage.includes("generatedCollageUrl")
      && acceptedIdentity > localFileVerified
      && collageStage.includes("coverCollageNeedsRefresh: false")
      && collageStage.includes("finalGuestyGalleryVerified: false");
  })());

check("full automation: a retry-rail photo mutation forces one final Claude collage regeneration before exact sync",
  (() => {
    const start = serverSrc.indexOf("async function runUnitAuditJob(");
    const end = serverSrc.indexOf("// ── Public API", start);
    const run = serverSrc.slice(start, end);
    const retryLoop = run.indexOf("for (let pass = 1; pass <= retryPasses; pass++)");
    const refresh = run.indexOf("if (record.fullAutomation && record.coverCollageNeedsRefresh)");
    const rerun = run.indexOf('await runStageForRecord(record, "cover-collage")', refresh);
    const finalSync = run.indexOf("await noteSweepDedupeGuestySync(record)", rerun);
    return retryLoop >= 0 && refresh > retryLoop && rerun > refresh && finalSync > rerun;
  })());

check("fix: pricing refresh drives the per-property refresh+push path (cores) / draft refresh-pricing, only when the verify found a refreshable problem",
  serverSrc.includes("/refresh-market-rates") && serverSrc.includes("/refresh-pricing") && serverSrc.includes("needsRefresh"));

check("full automation: pricing always refreshes via forceSearchApi and accepts a durable local setup when Guesty is absent",
  serverSrc.includes("record.fullAutomation || v.needsRefresh") &&
  serverSrc.includes("forceSearchApi: record.fullAutomation") &&
  serverSrc.includes("localOnlyAccepted"));

check("full automation: pricing refresh is unconditional, while no-Guesty success is based on the saved local table",
  (() => {
    const verifyStart = serverSrc.indexOf("async function verifyPricing(");
    const stageStart = serverSrc.indexOf("async function stagePricing(");
    const stageEnd = serverSrc.indexOf("async function stageChannels(", stageStart);
    const verifyPricingSrc = serverSrc.slice(verifyStart, stageStart);
    const stagePricingSrc = serverSrc.slice(stageStart, stageEnd);
    const localAcceptBranch = verifyPricingSrc.indexOf("if (!target.guestyListingId && opts.localOnlyAccepted)");
    const missingPushBranch = verifyPricingSrc.indexOf("else if (!pushedAt)");
    return verifyStart >= 0 && stageStart > verifyStart && stageEnd > stageStart &&
      localAcceptBranch >= 0 && localAcceptBranch < missingPushBranch &&
      stagePricingSrc.includes("const localOnlyAccepted = record.fullAutomation && !target.guestyListingId") &&
      stagePricingSrc.includes("const shouldRefresh = record.fullAutomation || v.needsRefresh") &&
      stagePricingSrc.includes('{ forceSearchApi: record.fullAutomation }') &&
      stagePricingSrc.includes("guestyPush?.skipped && !localOnlyAccepted") &&
      stagePricingSrc.includes("SearchAPI Airbnb market rates refreshed and the complete pricing setup saved locally");
  })());

check("layout: manual audits remain compare-only; full automation uses the strict Claude apply helper",
  serverSrc.includes("applyBeddingPhotoScanForAudit") &&
  serverSrc.includes("forceFresh: true") &&
  serverSrc.includes("record.fullAutomation") &&
  /never overwrites a layout/.test(serverSrc));

check("full automation: non-cancellable mutating stages are awaited to their real terminal result",
  serverSrc.includes("record.fullAutomation && FULL_AUTOMATION_MUTATING_STAGES.has(stageId)") &&
  serverSrc.includes("? await work") &&
  serverSrc.includes(": await withTimeout(work"));

check("child poll deadline: standard/manual behavior remains bounded",
  !unitAuditChildPollShouldTimeout(false, NOW, NOW + 1) &&
  unitAuditChildPollShouldTimeout(false, NOW + 1, NOW));

check("child poll deadline: full automation waits past the normal ceiling for a terminal child",
  !unitAuditChildPollShouldTimeout(true, NOW + 24 * 60 * 60_000, NOW));

check("child poll cancellation: standard stops immediately; strict waits only while the child is active",
  unitAuditChildPollShouldCancel(false, true, true) &&
  !unitAuditChildPollShouldCancel(true, true, true) &&
  unitAuditChildPollShouldCancel(true, true, false) &&
  !unitAuditChildPollShouldCancel(true, false, false));

check("child poll cancellation ordering: only strict terminal children are consumed before cancellation",
  unitAuditChildPollShouldProcessTerminalBeforeCancel(true, true, false) &&
  !unitAuditChildPollShouldProcessTerminalBeforeCancel(true, true, true) &&
  !unitAuditChildPollShouldProcessTerminalBeforeCancel(false, true, false) &&
  !unitAuditChildPollShouldProcessTerminalBeforeCancel(true, false, false));

check("full automation: every mutating child poll uses the strict terminality deadline guard",
  (serverSrc.match(/unitAuditChildPollShouldTimeout\(record\.fullAutomation, Date\.now\(\), deadline\)/g) ?? []).length === 4 &&
  serverSrc.includes("find-new-source did not finish in time") &&
  serverSrc.includes("unit replacement did not finish inside the audit window") &&
  serverSrc.includes("Community repull did not finish in time"));

check("full automation: cancellation waits for every mutating child to terminalize before the parent stops",
  (serverSrc.match(/unitAuditChildPollShouldCancel\(record\.fullAutomation, cancellationPending, childActive\)/g) ?? []).length === 4 &&
  (serverSrc.match(/unitAuditChildPollShouldProcessTerminalBeforeCancel\(/g) ?? []).length === 4 &&
  serverSrc.includes("if (rungResult.cancelAfterTerminal) throw new Error(\"cancelled\")") &&
  (serverSrc.match(/Cancellation requested — waiting for .* to finish safely/g) ?? []).length === 4);

check("fix: global kill switch UNIT_AUDIT_AUTOFIX_DISABLED gates every fix path",
  serverSrc.includes("UNIT_AUDIT_AUTOFIX_DISABLED") && /autoFixEnabled\(record\)/.test(serverSrc));

// ── Source guards: photo fix ladder (PR 3) reuses the EXISTING repair jobs ───
check("ladder: rungs come from the shared photoFixRungsForUnit (no inline re-derivation)",
  serverSrc.includes("photoFixRungsForUnit"));

check("ladder: re-scrape rung drives the single-writer rescrape route",
  serverSrc.includes("/api/builder/rescrape-unit-photos"));

check("ladder: find-new rung drives the preflight photo-fetch job with findNewSource + targetFolder + sibling skipUrls",
  serverSrc.includes("startPreflightPhotoFetchJob") &&
  serverSrc.includes("findNewSource: true") &&
  /skipUrls/.test(serverSrc));

check("ladder: replace rung drives the one-click auto-replace orchestrator (find→commit→verify, OTA-clean-gated find)",
  serverSrc.includes("startAutoReplaceJob") && serverSrc.includes("listAutoReplaceJobs"));

// 2026-07-12 Ilikai receipt (uas_mrh8wbqk_ls005u): the replace rung committed
// a gallery that itself photographed 1 of 2 bedrooms, so the re-check failed
// again and the swap was burned for nothing. A bedroom-shortfall plan must
// require the NEW gallery to photograph every claimed bedroom (the commit
// aborts at staging; the orchestrator burns the candidate and tries the next
// option). OTA-found-only plans deliberately do NOT gate — getting off
// compromised photos beats gallery coverage.
check("ladder: bedroom-shortfall replacements require bedroom-photo coverage on the new gallery",
  /requireBedroomPhotoCoverage: plan\.bedroomShort/.test(serverSrc) &&
  /requireBedroomPhotoCoverage: opts\.requireBedroomPhotoCoverage === true/.test(serverSrc));


check("ladder: replacement requires record.allowReplace and honors AUDIT_REPLACE_DISABLED",
  serverSrc.includes("record.allowReplace") && serverSrc.includes("AUDIT_REPLACE_DISABLED"));

check("ladder: waits for the photo auto-labeler before re-checking (the 0/N false-fail class)",
  serverSrc.includes("waitForFolderLabels") && serverSrc.includes("getPhotoLabelsByFolder"));

check("full automation: every changed/replacement gallery is deduped again before final community + bedroom verification",
  serverSrc.includes("Final post-change gallery") &&
  serverSrc.indexOf("const dedupe = await stagePhotoDedupe") < serverSrc.indexOf("re-checking community + bedroom coverage after the ${rung}"));

check("full automation: every local gallery mutation has a durable end-of-sweep Guesty sync handoff",
  serverSrc.includes("pendingGuestyGallerySync: true") &&
  serverSrc.includes("pendingDedupeHiddenCount: record.pendingDedupeHiddenCount + remove.length") &&
  serverSrc.includes("const strictMappedFinalSync = record.fullAutomation") &&
  serverSrc.includes("!record.finalGuestyGalleryVerified") &&
  serverSrc.includes("if (!record.pendingGuestyGallerySync && !strictMappedFinalSync) return null") &&
  !serverSrc.includes("dedupeHiddenThisSweep"));

check("full automation: every local gallery mutator durably pre-arms exact Guesty sync before it can change files",
  (() => {
    const prearm = serverSrc.slice(
      serverSrc.indexOf("async function prearmStrictGuestyGallerySync("),
      serverSrc.indexOf("async function clearGuestyGallerySyncPending("),
    );
    const dedupe = serverSrc.slice(
      serverSrc.indexOf("async function stagePhotoDedupe("),
      serverSrc.indexOf("async function stagePhotoCommunity("),
    );
    const rung = serverSrc.slice(
      serverSrc.indexOf("async function runPhotoFixRung("),
      serverSrc.indexOf("async function runAiFinalSayAdjudication("),
    );
    const finalSay = serverSrc.slice(
      serverSrc.indexOf("async function runAiFinalSayAdjudication("),
      serverSrc.indexOf("async function stagePhotoFix("),
    );
    const photoFix = serverSrc.slice(
      serverSrc.indexOf("async function stagePhotoFix("),
      serverSrc.indexOf("async function stageDescriptions("),
    );
    return prearm.includes("if (record.fullAutomation)") &&
      prearm.includes("await markGuestyGallerySyncPending(record, {") &&
      prearm.includes("coverCollageNeedsRefresh: true") &&
      prearm.includes("requiredCoverCollageUrl: null") &&
      !prearm.includes("!record.pendingGuestyGallerySync") &&
      /await prearmStrictGuestyGallerySync\(record\);\s*const apply = await loopbackJson\("POST", "\/api\/builder\/photo-dedupe-apply"/.test(dedupe) &&
      /await prearmStrictGuestyGallerySync\(record\);\s*const r = await loopbackJson\("POST", "\/api\/builder\/rescrape-unit-photos"/.test(rung) &&
      /await prearmStrictGuestyGallerySync\(record\);\s*const job = startPreflightPhotoFetchJob/.test(rung) &&
      /await prearmStrictGuestyGallerySync\(record\);\s*const started = await startAutoReplaceJob/.test(rung) &&
      /await prearmStrictGuestyGallerySync\(record\);\s*for \(const h of confirmedHides\)/.test(finalSay) &&
      /await prearmStrictGuestyGallerySync\(record\);\s*for \(const h of selections\.hide\)/.test(photoFix) &&
      (photoFix.match(/await prearmStrictGuestyGallerySync\(record\);\s*const repull = startCommunityPhotoRepullJob/g) ?? []).length === 2;
  })());

check("full automation: final preflight requires positive target/community/bedroom proof and only hard candidate failures retry",
  serverSrc.includes("classifyStagedUnitCommunityAudit(recheck.result") &&
  serverSrc.includes('strictGate?.decision === "inconclusive"') &&
  serverSrc.includes("shouldRetryCommittedFullAutomationReplacement") &&
  serverSrc.includes('rungQueue.push("replace")') &&
  serverSrc.includes("MAX_FULL_AUTOMATION_COMMITTED_REPLACEMENTS"));

check("full automation: mapped replacement completion requires the persisted awaited Guesty push receipt",
  serverSrc.includes("autoReplaceGuestyPushSatisfied(j.guestyPhotoPush, !!target.guestyListingId)")
  && serverSrc.includes("requireFullCommunityAudit: record.fullAutomation")
  && serverSrc.includes("strict audit cannot mark replacement complete")
  && serverSrc.includes("photoChanged: true")
  && /if \(!rungResult\.ok && !rungResult\.photoChanged\) \{\s*if \(rungResult\.cancelAfterTerminal\) throw new Error\("cancelled"\);\s*continue;\s*\}/.test(serverSrc)
  && serverSrc.includes("local replacement gallery is clean, but Guesty synchronization is still unverified"));

check("full automation: the final post-dedupe Guesty sync is awaited and a mapped failure turns the dedupe row into error",
  serverSrc.includes("await noteSweepDedupeGuestySync(record)")
  && serverSrc.includes("if (!record.fullAutomation)")
  && serverSrc.includes('verdict: "error" as const')
  && serverSrc.includes("strict audit cannot verify the live gallery"));

check("full automation: final mapped sync requires this audit's collage identity plus exact ordered readback before durable clear",
  serverSrc.includes("requiredCoverCollageUrl: record.requiredCoverCollageUrl!")
  && serverSrc.includes("result.collagePinned === true && result.strictGalleryVerified === true")
  && serverSrc.includes("await clearGuestyGallerySyncPending(record, {")
  && serverSrc.includes("requiredCoverCollageUrl: null")
  && serverSrc.includes("finalGuestyGalleryVerified: true")
  && serverSrc.includes("Guesty exact-gallery read-back succeeded, but its durable completion receipt could not be saved"));

check("ladder: a successful fix upserts the photo-community row so the roll-up reflects the POST-fix state",
  serverSrc.includes("(after photo fixes)"));

check("ladder: AUDIT_PHOTO_FIX=0 skips the stage",
  serverSrc.includes("AUDIT_PHOTO_FIX"));

check("bulk: startUnitAuditSweepBulk dedupes ids and funnels through the global concurrency slot",
  serverSrc.includes("startUnitAuditSweepBulk") && serverSrc.includes("acquireSweepSlot") &&
  serverSrc.includes("UNIT_AUDIT_CONCURRENCY"));

check("bulk: strict clicks never silently reuse a partially-run standard audit",
  serverSrc.includes("A standard audit is already running for this property") &&
  serverSrc.includes('existing.status === "queued" && existing.currentStage == null && existing.stages.length === 0') &&
  serverSrc.includes("touch(existing, { fullAutomation: true, autoFix: true, allowReplace: true"));

// ── Source guards: 2026-07-12 receipt fixes ──────────────────────────────────
check("amenity verify: reads {amenities, otherAmenities} via the SAME endpoint the push union uses + push-parity candidates",
  serverSrc.includes("/api/builder/guesty-amenities?listingId=") &&
  serverSrc.includes("otherAmenities") &&
  serverSrc.includes("amenityPresenceCandidates") &&
  serverSrc.includes("normalizeGuestyAmenityName"));

// ── Verify-read retry over Guesty rate-limit pauses (2026-07-12) ─────────────
// The live Coconut Plantation receipt: the amenities read-back aborted at its
// single 30s attempt while the global Guesty request gate sat in a 429 pause,
// and the stage reported "could not be verified" for a push that had landed.
check("verify-read retry: success statuses never retry",
  !unitAuditVerifyReadRetryable(200) && !unitAuditVerifyReadRetryable(204) && !unitAuditVerifyReadRetryable(304));

check("verify-read retry: transient classes retry (429 route rate-limit, 5xx incl. Guesty-429-as-500, 599 client abort)",
  unitAuditVerifyReadRetryable(429) && unitAuditVerifyReadRetryable(500) &&
  unitAuditVerifyReadRetryable(502) && unitAuditVerifyReadRetryable(599));

check("verify-read retry: non-retryable 4xx (bad listing id / validation) fail fast",
  !unitAuditVerifyReadRetryable(400) && !unitAuditVerifyReadRetryable(404) && !unitAuditVerifyReadRetryable(422));

check("verify-read backoff: grows 10s/20s so attempt 2 clears Guesty's default 15s pause",
  unitAuditVerifyReadBackoffMs(1) === 10_000 && unitAuditVerifyReadBackoffMs(2) === 20_000 &&
  unitAuditVerifyReadBackoffMs(0) === 10_000);

check("amenity verify: read-back goes through the retrying loopbackVerifyRead (never a bare single attempt)",
  /loopbackVerifyRead\(\s*`\/api\/builder\/guesty-amenities\?listingId=/.test(serverSrc) &&
  !/loopbackJson\("GET", `\/api\/builder\/guesty-amenities/.test(serverSrc));

check("layout verify: listing read goes through the retrying loopbackVerifyRead",
  /loopbackVerifyRead\(\s*`\/api\/guesty-proxy\/listings\//.test(serverSrc) &&
  !/loopbackJson\("GET", `\/api\/guesty-proxy\/listings\//.test(serverSrc));

check("channels verify: channel-status read goes through the retrying loopbackVerifyRead",
  /loopbackVerifyRead\(\s*\n?\s*"\/api\/dashboard\/channel-status"/.test(serverSrc) &&
  !/loopbackJson\("GET", "\/api\/dashboard\/channel-status"/.test(serverSrc));

check("verify-read retry: classification + backoff come from the shared pure functions",
  serverSrc.includes("unitAuditVerifyReadRetryable") && serverSrc.includes("unitAuditVerifyReadBackoffMs"));

check("amenities stage ceiling accounting: the scan timeout subtracts BOTH verify calls' worst case",
  serverSrc.includes("2 * AMENITY_VERIFY_WORST_MS"));

check("verify-read failure receipts carry the attempt count (honest 'could not verify', never silent)",
  /after \$\{attemptsUsed\} read attempt/.test(serverSrc));

check("amenity normalizer drift-lock: routes' inline norm() and the shared normalizer are byte-identical",
  (() => {
    const impl = 's.toLowerCase().replace(/[_\\-/&]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\\s+/g, " ").trim()';
    const routesSrcLocal = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const catalogSrc = readFileSync(new URL("../shared/guesty-amenity-catalog.ts", import.meta.url), "utf8");
    return routesSrcLocal.includes(impl) && catalogSrc.includes(impl);
  })());

check("community ladder: flagged photos hidden via the photo-labels soft-delete PUT (insert-on-miss, undoable)",
  serverSrc.includes("communityPhotoFixSelections") && serverSrc.includes("/api/photo-labels/"));

check("community ladder: still-wrong folder escalates to the existing Find-new-community-photos repull job",
  serverSrc.includes("startCommunityPhotoRepullJob") && serverSrc.includes("getCommunityPhotoRepullJob"));

check("gallery sync: community hides, Claude final-say hides, and completed community repulls all set the durable end-of-sweep obligation",
  (() => {
    const finalSay = serverSrc.slice(
      serverSrc.indexOf("async function runAiFinalSayAdjudication("),
      serverSrc.indexOf("async function stagePhotoFix("),
    );
    const photoFix = serverSrc.slice(
      serverSrc.indexOf("async function stagePhotoFix("),
      serverSrc.indexOf("async function stageDescriptions("),
    );
    return finalSay.includes("if (confirmedHides.length > 0) await prearmStrictGuestyGallerySync(record)") &&
      finalSay.includes("if (hidden === 1 && !record.pendingGuestyGallerySync) await markGuestyGallerySyncPending(record)") &&
      photoFix.includes("Community folder: hid") &&
      photoFix.includes("Repull clears/rebuilds the local community folder") &&
      (photoFix.match(/await markGuestyGallerySyncPending\(record\)/g)?.length ?? 0) >= 5 &&
      (photoFix.match(/await prearmStrictGuestyGallerySync\(record\)/g)?.length ?? 0) >= 3;
  })());

check("dedupe stage: same-scene auto-apply is env-gated (AUDIT_DEDUPE_SAME_SCENE=0 restores review-only)",
  serverSrc.includes("AUDIT_DEDUPE_SAME_SCENE") && serverSrc.includes("includeSameScene"));

check("photo-fix honesty: 'nothing to fix' can never render under a failed photo stage",
  serverSrc.includes("no automatic remedy") && /photoRowsBad/.test(serverSrc));

// ── Source guards: unattended-replacement rails (2026-07-12) ─────────────────
check("rail 1: a bedroom shortfall must be PROVEN with photo labels complete before the ladder acts",
  serverSrc.includes("folderLabelsComplete") &&
  /labeling race/.test(serverSrc) &&
  serverSrc.includes("Re-verifying bedroom coverage with labels complete"));

check("rail 2: cron swaps honor the anti-churn cooldown via the unit's swap history (manual sweeps exempt)",
  serverSrc.includes("AUDIT_REPLACE_COOLDOWN_DAYS") &&
  serverSrc.includes("lastSwapAtForUnit") &&
  serverSrc.includes("latestUnitSwapsByUnit") &&
  /rung === "replace" && record\.source === "cron"/.test(serverSrc));

check("rail 3: cron swaps draw from a per-run budget the scheduler resets",
  serverSrc.includes("UNIT_AUDIT_CRON_REPLACE_CAP") &&
  serverSrc.includes("consumeCronReplaceBudget") &&
  serverSrc.includes("export function resetCronReplaceBudget"));

check("rails: cooldown/budget blocks report attention, never a hard fail",
  serverSrc.includes("anyOnCooldown") && serverSrc.includes("anyBudgetSpent") &&
  /blockedSoft/.test(serverSrc));

check("post-swap follow-through: descriptions regenerate + collage re-composes after a replacement this sweep",
  serverSrc.includes("replacedThisSweep") &&
  serverSrc.includes("forcedBySwap") &&
  serverSrc.includes("collageStaleFromSwap"));

// ── Source guards: weekly auto-audit scheduler (2026-07-12) ──────────────────
const schedulerSrc = readFileSync(new URL("../server/unit-audit-scheduler.ts", import.meta.url), "utf8");
check("scheduler: last-run persisted in app_settings, stamped at START, first boot anchored (never fires at deploy)",
  schedulerSrc.includes("unit_audit_auto.last_run_at") &&
  /setSetting\(UNIT_AUDIT_AUTO_LAST_RUN_KEY, new Date\(\)\.toISOString\(\)\)/.test(schedulerSrc) &&
  /first boot/.test(schedulerSrc));

// 2026-07-18: "all builder properties" became "ACTIVE builder properties" —
// the first weekly tick swept six retired ghost entries and auto-committed a
// unit swap for one. tests/retired-properties.test.ts locks the retired set.
check("scheduler: targets = ACTIVE builder properties + Guesty-MAPPED drafts only",
  schedulerSrc.includes("getActiveUnitBuilders()") && !schedulerSrc.includes("getAllUnitBuilders") &&
  schedulerSrc.includes("getGuestyPropertyMap") &&
  /n < 0/.test(schedulerSrc));

check("scheduler: cron sweeps run auto-fix ON, replacement ON by default (UNIT_AUDIT_CRON_REPLACE=0 restores flag-only), source 'cron'",
  schedulerSrc.includes("autoFix: true") &&
  /UNIT_AUDIT_CRON_REPLACE \?\? ""\)\.trim\(\) !== "0"/.test(schedulerSrc) &&
  schedulerSrc.includes('source: "cron"'));

check("scheduler: per-run replacement budget reset at the start of every cron sweep",
  schedulerSrc.includes("resetCronReplaceBudget()"));

check("scheduler: kill switch UNIT_AUDIT_AUTO_DISABLED",
  schedulerSrc.includes("UNIT_AUDIT_AUTO_DISABLED"));

check("cron sweeps reuse the weekly photo-cron's OTA rows (wider fresh window by source)",
  serverSrc.includes("AUDIT_CRON_OTA_FRESH_HOURS") && /source === "cron"/.test(serverSrc));


// ── Source guards: wiring ────────────────────────────────────────────────────
const routesSrc = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
check("routes: POST /api/unit-audit + GET active/:jobId/cancel + dashboard status wired",
  routesSrc.includes('app.post("/api/unit-audit"') &&
  routesSrc.includes('app.get("/api/unit-audit/active"') &&
  routesSrc.includes('app.get("/api/unit-audit/:jobId"') &&
  routesSrc.includes('app.post("/api/unit-audit/:jobId/cancel"') &&
  routesSrc.includes('app.get("/api/dashboard/unit-audit-status"'));

check("routes: /api/unit-audit/active registered BEFORE /api/unit-audit/:jobId (else :jobId swallows it)",
  routesSrc.indexOf('app.get("/api/unit-audit/active"') < routesSrc.indexOf('app.get("/api/unit-audit/:jobId"'));

// 2026-07-12 Ilikai receipt: the ladder's rescrape rung replaced Unit B's
// 19-photo folder with a single og:image from a stripped/delisted source
// gallery. The rescrape route must keep the existing gallery when the fresh
// scrape can't even clear the unit photo floor (community folders exempt —
// their curation path caps/floors separately).
check("routes: rescrape-unit-photos floor-guards against downgrading a healthy gallery",
  /scraped\.length < MIN_INDEPENDENT_UNIT_PHOTOS && !folder\.startsWith\("community-"\)/.test(routesSrc) &&
  routesSrc.includes("keptExisting: true"));

const indexSrc = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
check("index.ts: resume watchdog registered on boot",
  indexSrc.includes("startUnitAuditResumeWatchdog()"));

check("index.ts: weekly auto-audit scheduler registered on boot",
  indexSrc.includes("startUnitAuditAutoScheduler()"));

check("routes: admin cron trigger + status wired",
  routesSrc.includes('app.post("/api/admin/run-unit-audit-cron"') &&
  routesSrc.includes('app.get("/api/admin/unit-audit-cron-status"'));

const homeSrc = readFileSync(new URL("../client/src/pages/home.tsx", import.meta.url), "utf8");
check("home.tsx: Audit column header + shared badge + per-row dialog trigger",
  homeSrc.includes(">\n                  Audit\n                </TableHead>") ||
  (homeSrc.includes("Unit Audit Sweep") && homeSrc.includes("unitAuditBadge") && homeSrc.includes("button-unit-audit-")));

check("home.tsx: empty-state row colSpan grew with the new column (21)",
  homeSrc.includes("colSpan={21}"));

check("home.tsx: dashboard status query polls /api/dashboard/unit-audit-status",
  homeSrc.includes("/api/dashboard/unit-audit-status"));

const dialogSrc = readFileSync(new URL("../client/src/components/unit-audit-dialog.tsx", import.meta.url), "utf8");
check("dialog: starts via POST /api/unit-audit and polls the job endpoint",
  dialogSrc.includes('apiRequest("POST", "/api/unit-audit"') && dialogSrc.includes("/api/unit-audit/${jobId}"));

check("dialog: renders every stage from the SHARED stage list (no drift)",
  dialogSrc.includes("UNIT_AUDIT_STAGE_IDS.map"));

check("route + dialog: autoFix + allowReplace flow from the checkboxes through POST /api/unit-audit",
  routesSrc.includes("autoFix: (req.body as any)?.autoFix !== false") &&
  routesSrc.includes("allowReplace: (req.body as any)?.allowReplace !== false") &&
  dialogSrc.includes("checkbox-unit-audit-autofix") &&
  dialogSrc.includes("checkbox-unit-audit-allow-replace") &&
  dialogSrc.includes("allowReplace: autoFix && allowReplace"));

check("route: POST /api/unit-audit/bulk wired to startUnitAuditSweepBulk",
  routesSrc.includes('app.post("/api/unit-audit/bulk"') && routesSrc.includes("startUnitAuditSweepBulk({"));

check("home.tsx: 'Audit selected' bulk button posts the checked property ids",
  homeSrc.includes("button-bulk-unit-audit") && homeSrc.includes("/api/unit-audit/bulk") &&
  homeSrc.includes("fullAutomation: true"));

// ── Self-verifying audit rails (2026-07-12): pure decisions ──────────────────
// Operator: "fix the review so that no human intervention is needed …
// double or triple check system".

// Rail A: which stages re-run before the receipt.
check("rail A: error stages re-run (returned in stage order), resolve never does",
  (() => {
    const ids = unitAuditRetryStageIds([
      stage("resolve", "error"),
      stage("channels", "error"),
      stage("layout", "error"),
      stage("photo-dedupe", "pass"),
    ]);
    return ids.length === 2 && ids[0] === "layout" && ids[1] === "channels";
  })());

check("rail A: attention row with a transient auto-fix failure item re-runs",
  unitAuditRetryStageIds([
    { stage: "amenities", verdict: "attention", detail: "x", items: ["Auto-fix failed: amenity scan did not run (HTTP 502)"] },
  ]).join(",") === "amenities");

check("rail A: failed row with a transient auto-fix failure item re-runs (pricing push blip)",
  unitAuditRetryStageIds([
    { stage: "pricing", verdict: "failed", detail: "x", items: ["Auto-fix failed: market-rate refresh did not run (HTTP 599)"] },
  ]).join(",") === "pricing");

check("rail A: 'already running' refresh re-runs; judgment-call attention rows never do",
  unitAuditRetryStageIds([
    { stage: "pricing", verdict: "attention", detail: "x", items: ["A market-rate refresh for this property is already running — re-run the audit after it lands"] },
    { stage: "layout", verdict: "attention", detail: "x", items: ["Bathrooms: Guesty shows 2, system says 3"] },
    { stage: "channels", verdict: "attention", detail: "x", items: ["TAT license is a SAMPLE/placeholder value (TA-026-780-7890-01)"] },
    { stage: "photo-fix", verdict: "attention", detail: "x", items: ["Unit A (3BR): replacement skipped — anti-churn cooldown"] },
  ]).join(",") === "pricing");

check("rail A: dedupe 'Auto-fix could not apply' re-runs",
  unitAuditRetryStageIds([
    { stage: "photo-dedupe", verdict: "attention", detail: "x", items: ["Auto-fix could not apply (HTTP 410) — review on the Photos tab instead"] },
  ]).join(",") === "photo-dedupe");

check("rail A: pass/fixed/skipped rows never re-run",
  unitAuditRetryStageIds([
    stage("photo-dedupe", "fixed"), stage("photo-community", "pass"), stage("photo-fix", "skipped"),
  ]).length === 0);

check("rail A: default is 2 extra passes (triple-checked worst case)",
  UNIT_AUDIT_STAGE_RETRY_PASSES_DEFAULT === 2 && RETRYABLE_ATTENTION_PATTERNS.length >= 3);

// Rail A drift-lock: the retry patterns must match the strings the
// orchestrator actually emits (reword one → update the other in the same PR).
check("rail A drift-lock: the orchestrator emits the exact transient-failure strings the patterns match",
  serverSrc.includes("Auto-fix failed:") &&
  serverSrc.includes("Auto-fix could not apply") &&
  serverSrc.includes("already running") &&
  RETRYABLE_ATTENTION_PATTERNS.some((re) => re.test("Auto-fix failed: amenity scan did not run (HTTP 502)")) &&
  RETRYABLE_ATTENTION_PATTERNS.some((re) => re.test("Auto-fix could not apply (HTTP 410) — review on the Photos tab instead")) &&
  RETRYABLE_ATTENTION_PATTERNS.some((re) => re.test("A market-rate refresh for this property is already running — re-run the audit after it lands")));

// Rail C: same-scene stability double-check.
const ssGroup = (folder: string, files: string[]) => ({
  kind: "same-scene" as const,
  folder,
  members: files.map((filename, i) => ({ filename, keep: i === 0 })),
});

check("rail C: a same-scene group reproduced by a second scan (≥2 shared members) is confirmed",
  (() => {
    const { confirmed, noise } = confirmSameSceneGroups(
      [ssGroup("f", ["a.jpg", "b.jpg"])],
      [ssGroup("f", ["a.jpg", "b.jpg", "c.jpg"])],
    );
    return confirmed.length === 1 && noise.length === 0;
  })());

check("rail C: a one-scan-only group is noise (second scan paired differently)",
  (() => {
    const { confirmed, noise } = confirmSameSceneGroups(
      [ssGroup("f", ["a.jpg", "b.jpg"])],
      [ssGroup("f", ["a.jpg", "c.jpg"])],
    );
    return confirmed.length === 0 && noise.length === 1;
  })());

check("rail C: folder must match — the same filenames in another folder don't confirm",
  confirmSameSceneGroups([ssGroup("f1", ["a.jpg", "b.jpg"])], [ssGroup("f2", ["a.jpg", "b.jpg"])]).confirmed.length === 0);

check("rail C: empty second scan → everything is noise",
  confirmSameSceneGroups([ssGroup("f", ["a.jpg", "b.jpg"])], []).noise.length === 1);

check("rail C: agreement bar is 2 shared members (a single shared photo is not agreement)",
  SAME_SCENE_STABILITY_MIN_OVERLAP === 2);

// Rail B: community consensus gate + cross-pass merge.
const consensusPass = (over: Partial<CommunityConsensusPass> = {}): CommunityConsensusPass => ({
  verdict: "warn",
  community: {
    matchesExpected: "yes",
    photoVerdicts: [
      { id: "c1", folder: "comm", filename: "p1.jpg", match: "yes" },
      { id: "c2", folder: "comm", filename: "p2.jpg", match: "uncertain" },
    ],
    junk: [],
  },
  units: [{ label: "Unit A (3BR)", sameAsCommunity: "yes", photoVerdicts: [], junk: [] }],
  bedroomCoverage: { units: [{ label: "Unit A (3BR)", matchesListing: "yes" }] },
  duplicates: [],
  sourcePages: [],
  ...over,
});

check("rail B gate: warn with only uncertain votes = uncertainty-only (consensus may act)",
  communityCheckUncertaintyOnly(consensusPass()));
check("rail B gate: a RED photo vote disqualifies (mismatch always wins)",
  !communityCheckUncertaintyOnly(consensusPass({ community: { matchesExpected: "yes", photoVerdicts: [{ id: "c1", folder: "comm", filename: "p1.jpg", match: "no" }], junk: [] } })));
check("rail B gate: community identity 'no' disqualifies",
  !communityCheckUncertaintyOnly(consensusPass({ community: { matchesExpected: "no", photoVerdicts: [], junk: [] } })));
check("rail B gate: a unit 'no' disqualifies (the fix ladder owns it)",
  !communityCheckUncertaintyOnly(consensusPass({ units: [{ label: "Unit A (3BR)", sameAsCommunity: "no" }] })));
check("rail B gate: a bedroom shortfall disqualifies (the fix ladder owns it)",
  !communityCheckUncertaintyOnly(consensusPass({ bedroomCoverage: { units: [{ label: "Unit A (3BR)", matchesListing: "no" }] } })));
check("rail B gate: junk flags disqualify (the community ladder owns them)",
  !communityCheckUncertaintyOnly(consensusPass({ community: { matchesExpected: "yes", photoVerdicts: [], junk: [{ id: "c9" }] } })));
check("rail B gate: cross-folder duplicates disqualify",
  !communityCheckUncertaintyOnly(consensusPass({ duplicates: [{}] })));
check("rail B gate: a source-page 'no' disqualifies",
  !communityCheckUncertaintyOnly(consensusPass({ sourcePages: [{ match: "no" }] })));
check("rail B gate: verdict fail disqualifies",
  !communityCheckUncertaintyOnly(consensusPass({ verdict: "fail" })));
check("rail B: default is 3 total passes (the operator's 'double or triple check')",
  COMMUNITY_CONSENSUS_PASSES_DEFAULT === 3);

check("rail B merge: uncertain-in-pass-1 + confirmed-in-pass-2 resolves by union",
  (() => {
    const p2 = consensusPass({
      community: {
        matchesExpected: "yes",
        photoVerdicts: [
          { id: "c1", folder: "comm", filename: "p1.jpg", match: "uncertain" },
          { id: "c2", folder: "comm", filename: "p2.jpg", match: "yes" },
        ],
        junk: [],
      },
    });
    const merged = mergeCommunityConsensusPasses([consensusPass(), p2]);
    return !merged.contradiction && merged.allResolvedByUnion && merged.residualUnconfirmed.length === 0;
  })());

check("rail B merge: a never-confirmed photo stays residual (named in the receipt)",
  (() => {
    const merged = mergeCommunityConsensusPasses([consensusPass(), consensusPass()]);
    return !merged.contradiction && !merged.allResolvedByUnion &&
      merged.residualUnconfirmed.length === 1 && merged.residualUnconfirmed[0] === "comm/p2.jpg";
  })());

check("rail B merge: a contradiction in ANY pass trips the merge",
  mergeCommunityConsensusPasses([
    consensusPass(),
    consensusPass({ community: { matchesExpected: "yes", photoVerdicts: [{ id: "c1", folder: "comm", filename: "p1.jpg", match: "no" }], junk: [] } }),
  ]).contradiction);

// ── Source guards: the rails are wired in the orchestrator ───────────────────
check("rail A wired: retry loop uses the pure stage picker + env knob, before the receipt",
  serverSrc.includes("unitAuditRetryStageIds") &&
  serverSrc.includes("AUDIT_STAGE_RETRY_PASSES") &&
  serverSrc.indexOf("unitAuditRetryStageIds(record.stages)") < serverSrc.indexOf("rollUpUnitAuditVerdict(record.stages)"));

check("rail A wired: a photo-verify verdict change re-runs photo-fix (its inputs changed)",
  /photoInputChanged/.test(serverSrc) && /runStageForRecord\(record, "photo-fix", \{ retryPass: pass \}\)/.test(serverSrc));

check("rail B wired: consensus helper gates on the pure uncertainty-only predicate + env knob",
  serverSrc.includes("communityOutcomeWithConsensus") &&
  serverSrc.includes("communityCheckUncertaintyOnly") &&
  serverSrc.includes("AUDIT_COMMUNITY_CONSENSUS_PASSES") &&
  serverSrc.includes("mergeCommunityConsensusPasses"));

check("rail B wired at BOTH seams: stage 3 AND the post-photo-fix row upsert",
  /const outcome = await communityOutcomeWithConsensus\(target, record, run\.result\);/.test(serverSrc) &&
  /communityOutcomeWithConsensus\(target, record, communityResult, "\(after photo fixes\) "\)/.test(serverSrc));

check("rail C wired: same-scene groups act only when a second independent scan reproduces them",
  serverSrc.includes("confirmSameSceneGroups") &&
  serverSrc.includes("AUDIT_DEDUPE_DOUBLE_CHECK") &&
  /visionUsed/.test(serverSrc));

check("rail D wired: fresh-but-inconclusive OTA rows re-scan via the shared cron predicate",
  serverSrc.includes("photoListingScanWasInconclusive"));

// ── Last Price Scan column actually updates after a sweep (2026-07-12
// Coconut Plantation incident) ────────────────────────────────────────────────
// Two halves: (a) the pricing stage must not claim "refreshed + pushed" when
// the refresh soft-skipped the Guesty push (markScannerGuestyRatePush stamps
// real pushes only, so the column stays frozen — say so); (b) the dashboard
// must refetch its data-column queries when a sweep finishes — they use
// staleTime + no focus refetch, so without invalidation the DB stamp lands
// but the open dashboard never shows it until a full reload.
{
  const sweepSrcLocal = readFileSync(new URL("../server/unit-audit-sweep.ts", import.meta.url), "utf8");
  check("pricing stage reports a SKIPPED Guesty push honestly (no false 'pushed' claim)",
    sweepSrcLocal.includes("guestyPush?.skipped")
    && sweepSrcLocal.includes("the Guesty push was SKIPPED"));
  check("a skipped push can never report better than attention",
    sweepSrcLocal.includes('re.verdict === "pass" ? "attention" : re.verdict'));
  check("home.tsx refreshes the data columns when a sweep leaves the active set",
    homeSrc.includes("prevActiveAuditIdsRef")
    && homeSrc.includes('invalidateQueries({ queryKey: ["/api/dashboard/price-scans"] })'));
  check("dialog terminal effect refreshes Last Price Scan + Photos + drafts too",
    dialogSrc.includes('queryKey: ["/api/dashboard/price-scans"]')
    && dialogSrc.includes('queryKey: ["/api/photo-listing-check"]')
    && dialogSrc.includes('queryKey: ["/api/community/drafts"]'));
}

const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
check("npm test chain includes this suite",
  pkg.includes("tests/unit-audit-sweep.test.ts"));

console.log(failed === 0
  ? `unit-audit-sweep: all ${passed} checks passed`
  : `unit-audit-sweep: ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
assert.ok(failed === 0);
