// Locks the AI "final say" photo adjudication (2026-07-12 operator directive:
// "I don't want to make judgment calls. I'll leave that to Claude AI to
// determine."): candidate selection posture (red "no" votes NEVER
// adjudicated), the forced-choice strict parse, the guarded action plan
// (low-confidence downgrade, one-side-only dupe hides, folder floor), the
// fingerprint-scoped decision store, and the kind-strict consensus coverage —
// plus source guards on the sweep/server wiring so the rail can't silently
// drift off the soft-delete seam or start masking contradictions.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  PHOTO_JUDGMENT_DECISIONS_CAP,
  PHOTO_JUDGMENT_DECISIONS_SETTING_KEY,
  PHOTO_JUDGMENT_DUPE_HASH_MAX_DISTANCE,
  PHOTO_JUDGMENT_MAX_DUPE_PAIRS,
  PHOTO_JUDGMENT_MAX_ITEMS_DEFAULT,
  PHOTO_JUDGMENT_MIN_REMOVE_CONFIDENCE,
  buildPhotoJudgmentPrompt,
  buildRemovalRefutePrompt,
  collectPhotoJudgmentCandidates,
  coveredJudgmentKeys,
  dupePairKey,
  filterAdjudicatedCandidates,
  fingerprintFolders,
  parsePhotoJudgmentDecisions,
  parsePhotoJudgmentVerdicts,
  parseRemovalRefuteVerdicts,
  photoJudgmentActionPlan,
  photoJudgmentKey,
  serializePhotoJudgmentDecisions,
  verifiedDupeHideDistance,
  type PhotoJudgmentCandidate,
  type PhotoJudgmentDecision,
} from "../shared/photo-judgment-adjudication";
import { NEAR_DUPLICATE_DISTANCE } from "../shared/photo-dedupe-logic";
import { photoFolderFingerprint } from "../shared/photo-folder-verification";
import {
  RETRYABLE_ATTENTION_PATTERNS,
  communityCheckUncertaintyOnly,
  mergeCommunityConsensusPasses,
  type CommunityConsensusPass,
} from "../shared/unit-audit-sweep-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// ── Candidate collection ─────────────────────────────────────────────────────
console.log("collectPhotoJudgmentCandidates");

const resultFixture = {
  community: {
    label: "Community folder",
    folder: "comm",
    photoVerdicts: [
      { id: "C-1", folder: "comm", filename: "pool.jpg", match: "uncertain" as const, reason: "no online match" },
      { id: "C-2", folder: "comm", filename: "sign.jpg", match: "no" as const, reason: "different resort signage" },
      { id: "C-3", folder: "comm", filename: "map.jpg", match: "yes" as const },
    ],
    junk: [{ id: "C-3", reason: "looks like a resort map" }],
  },
  units: [
    {
      label: "Unit A (3BR)",
      folder: "unit-a",
      photoVerdicts: [
        { id: "U1-1", folder: "unit-a", filename: "bed1.jpg", match: "uncertain" as const, reason: "generic interior" },
        { id: "U1-2", folder: "unit-a", filename: "floorplan.jpg", match: "yes" as const },
      ],
      junk: [{ id: "U1-2", reason: "floor plan" }, { id: "U1-9", reason: "unresolvable id" }],
    },
    {
      label: "Unit B (2BR)",
      folder: "unit-b",
      photoVerdicts: [],
      junk: [],
    },
  ],
  duplicates: [
    { scope: "cross-folder", a: { folder: "unit-a", filename: "lanai.jpg" }, b: { folder: "unit-b", filename: "photo_07.jpg" } },
    { scope: "cross-folder", a: { folder: "comm", filename: "pool.jpg" }, b: { folder: "unit-a", filename: "pool.jpg" } },
    { scope: "within-folder", a: { folder: "unit-a", filename: "x.jpg" }, b: { folder: "unit-a", filename: "y.jpg" } },
  ],
};

const candidates = collectPhotoJudgmentCandidates(resultFixture, { communityFolder: "comm" });
check("collects the unit↔unit cross-dupe as one pair candidate",
  candidates.filter((c) => c.kind === "cross-dupe").length === 1 &&
  candidates[0].kind === "cross-dupe" && candidates[0].pairFolder === "unit-b");
check("community-side cross-dupes are excluded (community ladder owns them)",
  !candidates.some((c) => c.kind === "cross-dupe" && (c.folder === "comm" || c.pairFolder === "comm")));
check("within-folder dupes are excluded (dedupe stage owns them)",
  candidates.filter((c) => c.kind === "cross-dupe").length === 1);
check("junk flags resolve through the group's photoVerdicts byId",
  candidates.some((c) => c.kind === "junk" && c.folder === "comm" && c.filename === "map.jpg") &&
  candidates.some((c) => c.kind === "junk" && c.folder === "unit-a" && c.filename === "floorplan.jpg"));
check("unresolvable junk ids are dropped, never guessed",
  !candidates.some((c) => c.kind === "junk" && c.filename === ""));
check("uncertain votes are candidates",
  candidates.some((c) => c.kind === "uncertain-vote" && c.filename === "pool.jpg") &&
  candidates.some((c) => c.kind === "uncertain-vote" && c.filename === "bed1.jpg"));
check("red 'no' votes are NEVER candidates (Load-Bearing #16 posture)",
  !candidates.some((c) => c.filename === "sign.jpg"));
check("dupes rank ahead of per-photo suspicions under the item cap",
  collectPhotoJudgmentCandidates(resultFixture, { communityFolder: "comm", maxItems: 1 })[0].kind === "cross-dupe");
check("dupe pair cap bounds the image-heaviest kind",
  PHOTO_JUDGMENT_MAX_DUPE_PAIRS <= PHOTO_JUDGMENT_MAX_ITEMS_DEFAULT);

// ── Stored-decision filtering ────────────────────────────────────────────────
console.log("filterAdjudicatedCandidates");

const fpA = photoFolderFingerprint(["bed1.jpg", "floorplan.jpg", "lanai.jpg"]);
const mkDecision = (folder: string, filename: string, kind: PhotoJudgmentDecision["kind"], decision: "keep" | "remove", fingerprint: string): PhotoJudgmentDecision =>
  ({ folder, filename, kind, decision, reason: "r", decidedAt: "2026-07-12T00:00:00.000Z", fingerprint });

{
  const uncertainA: PhotoJudgmentCandidate = { kind: "uncertain-vote", folder: "unit-a", filename: "bed1.jpg", groupLabel: "Unit A (3BR)", context: "c" };
  const decisions = {
    [photoJudgmentKey("unit-a", "bed1.jpg", "uncertain-vote")]: mkDecision("unit-a", "bed1.jpg", "uncertain-vote", "keep", fpA),
  };
  const { pending, priorKeeps } = filterAdjudicatedCandidates([uncertainA], decisions, { "unit-a": fpA });
  check("a fingerprint-valid prior keep short-circuits (not re-asked)", pending.length === 0 && priorKeeps.length === 1);
  const changed = filterAdjudicatedCandidates([uncertainA], decisions, { "unit-a": photoFolderFingerprint(["bed1.jpg"]) });
  check("a changed folder fingerprint silently un-applies the stored keep", changed.pending.length === 1 && changed.priorKeeps.length === 0);
  const removed = filterAdjudicatedCandidates(
    [uncertainA],
    { [photoJudgmentKey("unit-a", "bed1.jpg", "uncertain-vote")]: mkDecision("unit-a", "bed1.jpg", "uncertain-vote", "remove", fpA) },
    { "unit-a": fpA },
  );
  check("a stored REMOVE never short-circuits (visible again = operator override, re-ask)", removed.pending.length === 1);
}
{
  const dupe: PhotoJudgmentCandidate = {
    kind: "cross-dupe", folder: "unit-a", filename: "lanai.jpg", groupLabel: "Unit A (3BR)", context: "c",
    pairFolder: "unit-b", pairFilename: "photo_07.jpg", pairGroupLabel: "Unit B (2BR)",
  };
  const fpB = photoFolderFingerprint(["photo_07.jpg"]);
  const bothKept = {
    [photoJudgmentKey("unit-a", "lanai.jpg", "cross-dupe")]: mkDecision("unit-a", "lanai.jpg", "cross-dupe", "keep", fpA),
    [photoJudgmentKey("unit-b", "photo_07.jpg", "cross-dupe")]: mkDecision("unit-b", "photo_07.jpg", "cross-dupe", "keep", fpB),
  };
  check("a dupe pair short-circuits only when BOTH sides hold applicable keeps",
    filterAdjudicatedCandidates([dupe], bothKept, { "unit-a": fpA, "unit-b": fpB }).pending.length === 0 &&
    filterAdjudicatedCandidates([dupe], bothKept, { "unit-a": fpA, "unit-b": "v1:other" }).pending.length === 1);
}

// ── Prompt + strict parse ────────────────────────────────────────────────────
console.log("parsePhotoJudgmentVerdicts");

const promptItems: PhotoJudgmentCandidate[] = [
  { kind: "junk", folder: "unit-a", filename: "floorplan.jpg", groupLabel: "Unit A (3BR)", context: "flagged as junk" },
  { kind: "cross-dupe", folder: "unit-a", filename: "lanai.jpg", groupLabel: "Unit A (3BR)", context: "dupe", pairFolder: "unit-b", pairFilename: "photo_07.jpg", pairGroupLabel: "Unit B (2BR)" },
];
const prompt = buildPhotoJudgmentPrompt({ expectedCommunity: "Poipu Kai", items: promptItems });
check("prompt forces a decision — 'uncertain' explicitly refused", /"uncertain" is NOT an accepted answer/.test(prompt));
check("prompt lists both dupe sides", prompt.includes("unit-a/lanai.jpg") && prompt.includes("unit-b/photo_07.jpg"));

check("strict parse accepts a complete valid answer",
  parsePhotoJudgmentVerdicts({ decisions: [
    { index: 1, decision: "remove", confidence: 0.9, reason: "floor plan" },
    { index: 2, decision: "keep-a", confidence: 0.8, reason: "matches unit A bedding" },
  ] }, promptItems)?.length === 2);
check("a missing item rejects the whole answer",
  parsePhotoJudgmentVerdicts({ decisions: [{ index: 1, decision: "remove", confidence: 0.9, reason: "r" }] }, promptItems) === null);
check("a kind-invalid decision rejects (keep-a on a junk item)",
  parsePhotoJudgmentVerdicts({ decisions: [
    { index: 1, decision: "keep-a", confidence: 0.9, reason: "r" },
    { index: 2, decision: "keep-a", confidence: 0.9, reason: "r" },
  ] }, promptItems) === null);
check("'uncertain' rejects at parse — the forced choice is enforced, not hoped",
  parsePhotoJudgmentVerdicts({ decisions: [
    { index: 1, decision: "uncertain", confidence: 0.9, reason: "r" },
    { index: 2, decision: "keep-a", confidence: 0.9, reason: "r" },
  ] }, promptItems) === null);
check("duplicate indexes reject", parsePhotoJudgmentVerdicts({ decisions: [
  { index: 1, decision: "remove", confidence: 0.9, reason: "r" },
  { index: 1, decision: "keep", confidence: 0.9, reason: "r" },
] }, promptItems) === null);
check("out-of-range index rejects", parsePhotoJudgmentVerdicts({ decisions: [
  { index: 1, decision: "remove", confidence: 0.9, reason: "r" },
  { index: 3, decision: "keep-a", confidence: 0.9, reason: "r" },
] }, promptItems) === null);
check("missing confidence coerces to 0.5 (below the removal bar)",
  parsePhotoJudgmentVerdicts({ decisions: [
    { index: 1, decision: "remove", reason: "r" },
    { index: 2, decision: "keep-both", confidence: 2, reason: "r" },
  ] }, promptItems)![0].confidence === 0.5);

// ── Action plan guards ───────────────────────────────────────────────────────
console.log("photoJudgmentActionPlan");

{
  const items: PhotoJudgmentCandidate[] = [
    { kind: "junk", folder: "unit-a", filename: "floorplan.jpg", groupLabel: "Unit A (3BR)", context: "junk" },
    { kind: "uncertain-vote", folder: "unit-a", filename: "bed1.jpg", groupLabel: "Unit A (3BR)", context: "unconfirmed" },
    { kind: "cross-dupe", folder: "unit-a", filename: "lanai.jpg", groupLabel: "Unit A (3BR)", context: "dupe", pairFolder: "unit-b", pairFilename: "photo_07.jpg", pairGroupLabel: "Unit B (2BR)" },
  ];
  const plan = photoJudgmentActionPlan(items, [
    { index: 1, decision: "remove", confidence: 0.95, reason: "floor plan" },
    { index: 2, decision: "keep", confidence: 0.7, reason: "belongs" },
    { index: 3, decision: "keep-a", confidence: 0.9, reason: "unit A owns it" },
  ], { "unit-a": 10, "unit-b": 10 });
  check("decisive junk removal hides; keep stays; dupe hides the LOSING side only",
    plan.hide.some((h) => h.filename === "floorplan.jpg") &&
    plan.keep.some((k) => k.filename === "bed1.jpg") &&
    plan.hide.some((h) => h.folder === "unit-b" && h.filename === "photo_07.jpg") &&
    !plan.hide.some((h) => h.filename === "lanai.jpg"));
  check("the dupe winner is recorded as a keep",
    plan.keep.some((k) => k.folder === "unit-a" && k.filename === "lanai.jpg"));

  const lowConf = photoJudgmentActionPlan(items, [
    { index: 1, decision: "remove", confidence: 0.4, reason: "maybe" },
    { index: 2, decision: "keep", confidence: 0.7, reason: "belongs" },
    { index: 3, decision: "keep-a", confidence: 0.3, reason: "guess" },
  ], { "unit-a": 10, "unit-b": 10 });
  check("low-confidence removals downgrade to keep (forced choice ≠ decisive)",
    lowConf.hide.length === 0 && lowConf.lowConfidenceKept === 2 &&
    lowConf.keep.some((k) => k.folder === "unit-b" && k.filename === "photo_07.jpg"));
  check("removal confidence bar is a real constant", PHOTO_JUDGMENT_MIN_REMOVE_CONFIDENCE >= 0.5);

  // keep-b hides side A — so ALL THREE wanted removals land in unit-a
  // (4 visible, floor 3 → exactly ONE hide allowed, and the no-loss dupe
  // hide outranks junk and uncertain-vote removals).
  const floored = photoJudgmentActionPlan(items, [
    { index: 1, decision: "remove", confidence: 0.95, reason: "floor plan" },
    { index: 2, decision: "remove", confidence: 0.95, reason: "wrong place" },
    { index: 3, decision: "keep-b", confidence: 0.9, reason: "unit B owns it" },
  ], { "unit-a": 4, "unit-b": 10 });
  check("folder floor blocks removals below 3 visible; no-loss dupe hide ranks first",
    floored.hide.length === 1 &&
    floored.hide[0].folder === "unit-a" && floored.hide[0].filename === "lanai.jpg" &&
    floored.floorBlocked.length === 2);
  check("floorBlocked entries are separate from definitive keeps (never persisted as covered)",
    floored.floorBlocked.every((f) => !floored.keep.some((k) => k.folder === f.folder && k.filename === f.filename)));

  const keepBoth = photoJudgmentActionPlan([items[2]], [
    { index: 1, decision: "keep-both", confidence: 0.9, reason: "different rooms" },
  ], { "unit-a": 10, "unit-b": 10 });
  check("keep-both hides nothing and keeps BOTH sides",
    keepBoth.hide.length === 0 && keepBoth.keep.length === 2);
}

// ── Decision store ───────────────────────────────────────────────────────────
console.log("decision store");

{
  const row = mkDecision("unit-a", "bed1.jpg", "uncertain-vote", "keep", fpA);
  const raw = serializePhotoJudgmentDecisions({ [photoJudgmentKey("unit-a", "bed1.jpg", "uncertain-vote")]: row });
  const parsed = parsePhotoJudgmentDecisions(raw);
  check("round-trips a decision", parsed[photoJudgmentKey("unit-a", "bed1.jpg", "uncertain-vote")]?.fingerprint === fpA);
  check("store key + cap are stable", PHOTO_JUDGMENT_DECISIONS_SETTING_KEY === "photo_judgment_decisions.v1" && PHOTO_JUDGMENT_DECISIONS_CAP >= 200);
  check("garbage parses to empty, never throws",
    Object.keys(parsePhotoJudgmentDecisions("not json")).length === 0 &&
    Object.keys(parsePhotoJudgmentDecisions(JSON.stringify({ __proto__: { x: 1 }, "k": { folder: "f" } }))).length === 0);
  const big: Record<string, PhotoJudgmentDecision> = {};
  for (let i = 0; i < PHOTO_JUDGMENT_DECISIONS_CAP + 50; i++) {
    big[`f/${i}.jpg|junk`] = { ...row, folder: "f", filename: `${i}.jpg`, kind: "junk", decidedAt: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` };
  }
  check("serialize caps at the newest N", Object.keys(parsePhotoJudgmentDecisions(serializePhotoJudgmentDecisions(big))).length === PHOTO_JUDGMENT_DECISIONS_CAP);
  check("dupePairKey is order-insensitive",
    dupePairKey({ folder: "a", filename: "1.jpg" }, { folder: "b", filename: "2.jpg" }) ===
    dupePairKey({ folder: "b", filename: "2.jpg" }, { folder: "a", filename: "1.jpg" }));
  check("fingerprintFolders matches photoFolderFingerprint",
    fingerprintFolders({ "unit-a": ["bed1.jpg", "floorplan.jpg", "lanai.jpg"] })["unit-a"] === fpA);
}

// ── Consensus coverage (kind-strict) ─────────────────────────────────────────
console.log("consensus coverage");

const consensusPass = (over: Partial<CommunityConsensusPass> = {}): CommunityConsensusPass => ({
  verdict: "warn",
  community: { matchesExpected: "yes", photoVerdicts: [{ id: "c1", folder: "comm", filename: "p1.jpg", match: "uncertain" }], junk: [] },
  units: [],
  bedroomCoverage: null,
  duplicates: [],
  sourcePages: [],
  ...over,
});

{
  const junkPass = consensusPass({
    units: [{
      label: "Unit A (3BR)",
      sameAsCommunity: "yes",
      photoVerdicts: [{ id: "U1-2", folder: "unit-a", filename: "floorplan.jpg", match: "yes" }],
      junk: [{ id: "U1-2" }],
    }],
  });
  check("junk blocks the consensus gate without coverage", !communityCheckUncertaintyOnly(junkPass));
  const coverage = { coveredPhotoKeys: new Set(["unit-a/floorplan.jpg"]), coveredDupeSides: new Set<string>() };
  check("an AI-kept junk finding stops blocking (coverage)", communityCheckUncertaintyOnly(junkPass, coverage));
  check("coverage NEVER unblocks a red vote",
    !communityCheckUncertaintyOnly(consensusPass({
      units: [{ label: "U", sameAsCommunity: "yes", photoVerdicts: [{ id: "x", folder: "unit-a", filename: "floorplan.jpg", match: "no" }], junk: [] }],
    }), coverage));
  check("coverage NEVER unblocks a bedroom shortfall",
    !communityCheckUncertaintyOnly(consensusPass({ bedroomCoverage: { units: [{ label: "U", matchesListing: "no" }] } }), coverage));

  const dupePass = consensusPass({
    duplicates: [{ scope: "cross-folder", a: { folder: "unit-a", filename: "lanai.jpg" }, b: { folder: "unit-b", filename: "photo_07.jpg" } }],
  });
  check("a cross-dupe blocks without coverage", !communityCheckUncertaintyOnly(dupePass));
  check("a keep-both adjudicated pair (BOTH sides covered) stops blocking",
    communityCheckUncertaintyOnly(dupePass, { coveredPhotoKeys: new Set(), coveredDupeSides: new Set(["unit-a/lanai.jpg", "unit-b/photo_07.jpg"]) }) &&
    !communityCheckUncertaintyOnly(dupePass, { coveredPhotoKeys: new Set(), coveredDupeSides: new Set(["unit-a/lanai.jpg"]) }));
  check("a shapeless duplicate entry still blocks even with coverage",
    !communityCheckUncertaintyOnly(consensusPass({ duplicates: [{}] }), coverage));
  check("mergeCommunityConsensusPasses threads coverage into its contradiction check",
    !mergeCommunityConsensusPasses([junkPass], coverage).contradiction &&
    mergeCommunityConsensusPasses([junkPass]).contradiction);

  const decided = {
    [photoJudgmentKey("unit-a", "floorplan.jpg", "junk")]: mkDecision("unit-a", "floorplan.jpg", "junk", "keep", fpA),
    [photoJudgmentKey("unit-a", "bed1.jpg", "uncertain-vote")]: mkDecision("unit-a", "bed1.jpg", "uncertain-vote", "keep", fpA),
    [photoJudgmentKey("unit-a", "lanai.jpg", "cross-dupe")]: mkDecision("unit-a", "lanai.jpg", "cross-dupe", "keep", fpA),
    [photoJudgmentKey("unit-a", "gone.jpg", "junk")]: mkDecision("unit-a", "gone.jpg", "junk", "keep", "v1:stale"),
  };
  const keys = coveredJudgmentKeys(decided, { "unit-a": fpA });
  check("coverage is KIND-STRICT: junk keep covers, uncertain keep does not, stale fingerprint drops",
    keys.coveredPhotoKeys.has("unit-a/floorplan.jpg") &&
    !keys.coveredPhotoKeys.has("unit-a/bed1.jpg") &&
    !keys.coveredPhotoKeys.has("unit-a/gone.jpg") &&
    keys.coveredDupeSides.has("unit-a/lanai.jpg"));
}

check("a failed AI judgment run is a retryable attention signature (rail A)",
  RETRYABLE_ATTENTION_PATTERNS.some((re) => re.test("AI judgment could not run (HTTP 529) — the flagged findings stay for review")));

// ── Removal verification (deletions must be proven) ─────────────────────────
console.log("removal verification");

check("cross-dupe candidates carry the engine's pair distance",
  collectPhotoJudgmentCandidates({
    units: [{ label: "Unit A (3BR)", folder: "unit-a", photoVerdicts: [], junk: [] }],
    duplicates: [{ scope: "cross-folder", a: { folder: "unit-a", filename: "l.jpg" }, b: { folder: "unit-b", filename: "p.jpg" }, distance: 4 }],
  }, {})[0].pairDistance === 4);
check("dupe hide proof threshold matches the dedupe engine's near-duplicate bar",
  PHOTO_JUDGMENT_DUPE_HASH_MAX_DISTANCE === NEAR_DUPLICATE_DISTANCE);
check("verifiedDupeHideDistance: fresh distance at/below the bar proves; above/null/NaN never does",
  verifiedDupeHideDistance(0) && verifiedDupeHideDistance(NEAR_DUPLICATE_DISTANCE) &&
  !verifiedDupeHideDistance(NEAR_DUPLICATE_DISTANCE + 1) &&
  !verifiedDupeHideDistance(null) && !verifiedDupeHideDistance(undefined) && !verifiedDupeHideDistance(NaN));

const refuteItems = [
  { folder: "unit-a", filename: "floorplan.jpg", kind: "junk" as const, reason: "floor plan" },
  { folder: "comm", filename: "pool.jpg", kind: "uncertain-vote" as const, reason: "wrong place" },
];
const refutePrompt = buildRemovalRefutePrompt({ expectedCommunity: "Poipu Kai", items: refuteItems });
check("refute prompt is adversarial with a keep default",
  /REFUTE each removal/.test(refutePrompt) && /when in ANY doubt answer "keep"/.test(refutePrompt));
check("refute parse accepts a complete answer",
  parseRemovalRefuteVerdicts({ reviews: [
    { index: 1, verdict: "remove", reason: "agree — floor plan" },
    { index: 2, verdict: "keep", reason: "plausible lanai view" },
  ] }, 2)?.length === 2);
check("refute parse rejects missing/invalid/duplicate reviews wholesale",
  parseRemovalRefuteVerdicts({ reviews: [{ index: 1, verdict: "remove", reason: "r" }] }, 2) === null &&
  parseRemovalRefuteVerdicts({ reviews: [
    { index: 1, verdict: "unsure", reason: "r" },
    { index: 2, verdict: "keep", reason: "r" },
  ] }, 2) === null &&
  parseRemovalRefuteVerdicts({ reviews: [
    { index: 1, verdict: "remove", reason: "r" },
    { index: 1, verdict: "keep", reason: "r" },
  ] }, 2) === null);
check("a withheld second review emits the retryable signature (rail A re-runs it)",
  RETRYABLE_ATTENTION_PATTERNS.some((re) => re.test("AI judgment could not run the second removal review (HTTP 529) — 2 removal(s) withheld this pass")));

// ── Source guards (wiring) ───────────────────────────────────────────────────
console.log("source guards");

const sweepSrc = readFileSync(new URL("../server/unit-audit-sweep.ts", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("../server/photo-judgment.ts", import.meta.url), "utf8");
const sharedSrc = readFileSync(new URL("../shared/photo-judgment-adjudication.ts", import.meta.url), "utf8");

check("sweep runs the adjudication rail and gates it on the kill switch",
  sweepSrc.includes("runAiFinalSayAdjudication") && sweepSrc.includes("photoJudgmentEnabled") &&
  serverSrc.includes("AUDIT_AI_JUDGMENT"));
check("adjudication hides through the photo-labels soft-delete seam (never unlinks files)",
  /runAiFinalSayAdjudication[\s\S]{0,8000}\/api\/photo-labels\//.test(sweepSrc) &&
  !/from "fs"|require\("fs"\)|unlinkSync|rmSync/.test(sharedSrc));
check("sweep persists decisions and re-checks after hides",
  sweepSrc.includes("recordPhotoJudgmentDecisions") &&
  /judgment\.hidden > 0[\s\S]{0,600}runCommunityCheck/.test(sweepSrc));
check("consensus seams load coverage from the decision store",
  sweepSrc.includes("coveredJudgmentKeysForFolders") &&
  /communityCheckUncertaintyOnly\(first, coverage\)/.test(sweepSrc) &&
  /mergeCommunityConsensusPasses\(passes, coverage\)/.test(sweepSrc));
check("floorBlocked decisions are never persisted as keeps",
  /floorBlocked and WITHHELD removals are deliberately NOT persisted/.test(sweepSrc));
check("keep-only resolution still routes the row through the consensus rail (no verdict shortcut)",
  /\(after AI judgment\) /.test(sweepSrc));
check("the vision call refuses malformed answers instead of acting",
  serverSrc.includes("parsePhotoJudgmentVerdicts") && serverSrc.includes("failed strict validation"));
check("fingerprints come from listPublishedFilenames (pin-store parity)",
  serverSrc.includes("listPublishedFilenames") && serverSrc.includes("photoFolderFingerprint"));
check("red 'no' votes are structurally excluded from candidates",
  /match !== "uncertain"/.test(sharedSrc) && !/match === "no"[\s\S]{0,80}push\(/.test(sharedSrc));
check("dupe hides are hash re-proven from disk BEFORE the PUT loop",
  /verifyDupePairOnDisk[\s\S]{0,4000}for \(const h of confirmedHides\)/.test(sweepSrc) &&
  serverSrc.includes("computeDhash") && serverSrc.includes("hammingDistance"));
check("junk/uncertain hides go through the adversarial second review before acting",
  /runRemovalRefuteVision[\s\S]{0,5000}for \(const h of confirmedHides\)/.test(sweepSrc) &&
  sweepSrc.includes("photoJudgmentDoubleCheckEnabled") &&
  /AUDIT_JUDGMENT_DOUBLE_CHECK[\s\S]{0,80}!== "0"/.test(serverSrc));
check("a hash-refuted duplicate keeps BOTH sides instead of hiding",
  /hash re-verification refuted the duplicate/.test(sweepSrc));
check("withheld removals count as unresolved (attention), never as silent keeps",
  /plan\.floorBlocked\.length \+ putFailed \+ withheld/.test(sweepSrc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
assert.ok(failed === 0);
