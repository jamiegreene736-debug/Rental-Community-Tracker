// Locks the Unit Audit Sweep decision logic (shared/unit-audit-sweep-logic.ts):
// persisted job/report stores, resume rules, the stage-order resume seam,
// verdict roll-up honesty (error can never read green), the dashboard badge —
// plus source guards on the server orchestrator's reuse of the EXISTING
// engines and on the routes/index/home wiring so the sweep can't silently
// drift to re-implemented checks or lose its dashboard surfaces.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  communityPhotoFixSelections,
  dedupeAutoFixSelections,
  replaceRungOnCooldown,
  lookupUnitAuditRecord,
  photoFixRungsForUnit,
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
  rollUpUnitAuditVerdict,
  serializeUnitAuditReports,
  serializeUnitAuditStore,
  shouldResumeUnitAuditJob,
  summarizeUnitAuditCounts,
  summarizeUnitAuditQueue,
  unitAuditBadge,
  unitAuditHeadline,
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

check("fix: descriptions regenerate uses the SAME generator + disclosure composition as the builder button, persists overrides, refuses generator fallback",
  serverSrc.includes("/api/community/generate-listing") &&
  serverSrc.includes("composeSummaryWithDisclosures") &&
  serverSrc.includes("composeSpaceFromUnitDescriptions") &&
  serverSrc.includes("upsertPropertyDescriptionOverrides") &&
  /warning.*refused|refused.*warning/i.test(serverSrc));

check("fix: regenerated copy pushes ONLY the regenerated fields via push-descriptions (notes stays compliance-owned)",
  serverSrc.includes("/api/builder/push-descriptions") && !/descriptions:\s*\{[^}]*notes/.test(serverSrc));

check("fix: amenities fire the scan route (scan + save + ADD-ONLY Guesty union push in one call)",
  serverSrc.includes("/api/builder/scan-amenities"));

check("fix: cover collage drives the one-click AI endpoint with published-photo candidates",
  serverSrc.includes("/api/builder/auto-cover-collage"));

check("fix: pricing refresh drives the per-property refresh+push path (cores) / draft refresh-pricing, only when the verify found a refreshable problem",
  serverSrc.includes("/refresh-market-rates") && serverSrc.includes("/refresh-pricing") && serverSrc.includes("needsRefresh"));

check("fix: layout deliberately never pushes (Bedding-tab config lives in browser localStorage) — the sweep never PUTs to Guesty",
  !serverSrc.includes("listingRooms") && !/"PUT", `\/api\/guesty/.test(serverSrc) &&
  /never overwrites a layout/.test(serverSrc));

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

check("ladder: replacement requires record.allowReplace and honors AUDIT_REPLACE_DISABLED",
  serverSrc.includes("record.allowReplace") && serverSrc.includes("AUDIT_REPLACE_DISABLED"));

check("ladder: waits for the photo auto-labeler before re-checking (the 0/N false-fail class)",
  serverSrc.includes("waitForFolderLabels") && serverSrc.includes("getPhotoLabelsByFolder"));

check("ladder: a successful fix upserts the photo-community row so the roll-up reflects the POST-fix state",
  serverSrc.includes("(after photo fixes)"));

check("ladder: AUDIT_PHOTO_FIX=0 skips the stage",
  serverSrc.includes("AUDIT_PHOTO_FIX"));

check("bulk: startUnitAuditSweepBulk dedupes ids and funnels through the global concurrency slot",
  serverSrc.includes("startUnitAuditSweepBulk") && serverSrc.includes("acquireSweepSlot") &&
  serverSrc.includes("UNIT_AUDIT_CONCURRENCY"));

// ── Source guards: 2026-07-12 receipt fixes ──────────────────────────────────
check("amenity verify: reads {amenities, otherAmenities} via the SAME endpoint the push union uses + push-parity candidates",
  serverSrc.includes("/api/builder/guesty-amenities?listingId=") &&
  serverSrc.includes("otherAmenities") &&
  serverSrc.includes("amenityPresenceCandidates") &&
  serverSrc.includes("normalizeGuestyAmenityName"));

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

check("scheduler: targets = all builder properties + Guesty-MAPPED drafts only",
  schedulerSrc.includes("getAllUnitBuilders()") && schedulerSrc.includes("getGuestyPropertyMap") &&
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
  homeSrc.includes("button-bulk-unit-audit") && homeSrc.includes("/api/unit-audit/bulk"));

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
