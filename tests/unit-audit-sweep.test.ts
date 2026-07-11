// Locks the Unit Audit Sweep decision logic (shared/unit-audit-sweep-logic.ts):
// persisted job/report stores, resume rules, the stage-order resume seam,
// verdict roll-up honesty (error can never read green), the dashboard badge —
// plus source guards on the server orchestrator's reuse of the EXISTING
// engines and on the routes/index/home wiring so the sweep can't silently
// drift to re-implemented checks or lose its dashboard surfaces.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  dedupeAutoFixSelections,
  lookupUnitAuditRecord,
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
  ...over,
});

const stage = (
  stageId: (typeof UNIT_AUDIT_STAGE_IDS)[number],
  verdict: UnitAuditStageResult["verdict"],
  detail = `${stageId} ${verdict}`,
): UnitAuditStageResult => ({ stage: stageId, verdict, detail });

// ── Stage vocabulary ─────────────────────────────────────────────────────────
check("10 stages in the documented order (resolve first, channels last)",
  UNIT_AUDIT_STAGE_IDS.length === 10 &&
  UNIT_AUDIT_STAGE_IDS[0] === "resolve" &&
  UNIT_AUDIT_STAGE_IDS[1] === "photo-dedupe" &&
  UNIT_AUDIT_STAGE_IDS[2] === "photo-community" &&
  UNIT_AUDIT_STAGE_IDS[3] === "ota-scan" &&
  UNIT_AUDIT_STAGE_IDS[9] === "channels");

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

// ── Auto-fix: duplicate-photo selection (PR 2) ──────────────────────────────
check("dedupe auto-fix: hash groups' non-keepers only; same-scene NEVER auto-applied",
  (() => {
    const sel = dedupeAutoFixSelections([
      { kind: "exact", folder: "f1", members: [{ filename: "a.jpg", keep: true }, { filename: "b.jpg", keep: false }] },
      { kind: "near", folder: "f2", members: [{ filename: "c.jpg", keep: false }, { filename: "d.jpg", keep: true }] },
      { kind: "same-scene", folder: "f1", members: [{ filename: "e.jpg", keep: true }, { filename: "f.jpg", keep: false }] },
    ]);
    return sel.remove.length === 2 &&
      sel.remove.some((r) => r.folder === "f1" && r.filename === "b.jpg") &&
      sel.remove.some((r) => r.folder === "f2" && r.filename === "c.jpg") &&
      !sel.remove.some((r) => r.filename === "f.jpg") &&
      sel.hashGroupCount === 2 && sel.sameSceneCount === 1;
  })());

check("dedupe auto-fix: keepers are never selected; empty input is a no-op",
  (() => {
    const sel = dedupeAutoFixSelections([
      { kind: "exact", folder: "f", members: [{ filename: "keep.jpg", keep: true }] },
    ]);
    return sel.remove.length === 0 && dedupeAutoFixSelections([]).remove.length === 0;
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
    return b.kind === "running" && b.label === "4/10" && /OTA duplicate scan/.test(b.title);
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

check("fix: layout deliberately never pushes (Bedding-tab config lives in browser localStorage) — the sweep only GETs from Guesty",
  !serverSrc.includes("listingRooms") && !/loopbackJson\("PUT"/.test(serverSrc) &&
  /never overwrites a layout/.test(serverSrc));

check("fix: global kill switch UNIT_AUDIT_AUTOFIX_DISABLED gates every fix path",
  serverSrc.includes("UNIT_AUDIT_AUTOFIX_DISABLED") && /autoFixEnabled\(record\)/.test(serverSrc));

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

check("route + dialog: autoFix flows from the checkbox through POST /api/unit-audit",
  routesSrc.includes("autoFix: (req.body as any)?.autoFix !== false") &&
  dialogSrc.includes("checkbox-unit-audit-autofix") &&
  dialogSrc.includes("{ propertyId, autoFix }"));

const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
check("npm test chain includes this suite",
  pkg.includes("tests/unit-audit-sweep.test.ts"));

console.log(failed === 0
  ? `unit-audit-sweep: all ${passed} checks passed`
  : `unit-audit-sweep: ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
assert.ok(failed === 0);
