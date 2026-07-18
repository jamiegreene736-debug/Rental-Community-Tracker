import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  buildDedupeVisionInstruction,
  buildCompleteVisionBatchPlan,
  buildManualVisionBatchPlan,
  buildDuplicateGroupsForFolder,
  clusterHashPairs,
  dedupeEdgeAllowed,
  parseDedupeVisionGroups,
  pickKeeperIndex,
  summarizeDedupeFolders,
  validateDedupeSelection,
  NEAR_DUPLICATE_DISTANCE,
  type DedupePhotoEntry,
  type DedupeFolderResult,
} from "../shared/photo-dedupe-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

function entry(overrides: Partial<DedupePhotoEntry> & { filename: string; galleryIndex: number }): DedupePhotoEntry {
  return { folder: "test-folder", caption: null, category: null, hash: null, byteSize: 1000, ...overrides };
}

// Hashes with known hamming distances from all-zero.
const H0 = "0000000000000000";
const H1 = "0000000000000001";   // distance 1 from H0 (exact-dupe band)
const H8 = "00000000000000ff";   // distance 8 from H0 (near band)
const HFAR = "ffffffffffffffff"; // distance 64

console.log("photo-dedupe: hash clustering");

const pairs = clusterHashPairs([{ hash: H0 }, { hash: H1 }, { hash: HFAR }, { hash: null }]);
check("clusterHashPairs pairs only hashes within the threshold",
  pairs.length === 1 && pairs[0].a === 0 && pairs[0].b === 1 && pairs[0].distance === 1);

check("clusterHashPairs default threshold stays below the 25-36 look-alike band",
  NEAR_DUPLICATE_DISTANCE <= 16);

console.log("photo-dedupe: vision parse");

const oneBatch = buildCompleteVisionBatchPlan(60, 60, 12);
check("complete vision plan uses one call when the folder fits the cap",
  oneBatch.complete && oneBatch.batches.length === 1 && oneBatch.batches[0].length === 60);

const pairCover = buildCompleteVisionBatchPlan(61, 60, 12);
const allPairsCovered = (() => {
  if (!pairCover.complete) return false;
  for (let a = 0; a < 61; a++) {
    for (let b = a + 1; b < 61; b++) {
      if (!pairCover.batches.some((batch) => batch.includes(a) && batch.includes(b))) return false;
    }
  }
  return true;
})();
check("complete vision plan pair-covers every photo above the one-call cap",
  pairCover.batches.length === 3 && allPairsCovered && pairCover.batches.every((batch) => batch.length <= 60));

const overBudget = buildCompleteVisionBatchPlan(181, 60, 12);
check("complete vision plan fails explicitly when exhaustive coverage exceeds its budget",
  !overBudget.complete && overBudget.batches.length === 0 && /require 21 exhaustive Claude batches/.test(overBudget.error || ""));

const idMap = new Map<string, number>([["p1", 0], ["p2", 1], ["p3", 2]]);
const parsedGroups = parseDedupeVisionGroups({
  groups: [
    { photos: ["p1", "p3"], reason: "same pool", confidence: "high" },
    { photos: ["p2", "p9"], reason: "bad id", confidence: "high" },   // p9 unknown → 1 member → dropped
    { photos: ["p1", "p2"], confidence: "maybe" },                    // → medium
    { photos: ["p1"] },                                               // <2 → dropped
  ],
}, idMap);
check("parseDedupeVisionGroups keeps valid groups and maps ids to indexes",
  parsedGroups.length === 2 && parsedGroups[0].indexes.join(",") === "0,2" && parsedGroups[0].confidence === "high");
check("parseDedupeVisionGroups normalizes unknown confidence to medium",
  parsedGroups[1].confidence === "medium");
check("parseDedupeVisionGroups tolerates garbage",
  parseDedupeVisionGroups(null, idMap).length === 0 && parseDedupeVisionGroups({ groups: "x" }, idMap).length === 0);

console.log("photo-dedupe: merge guards");

const bedroomA = entry({ filename: "a.jpg", galleryIndex: 0, category: "Bedrooms", bedroomClusterId: "room-1" });
const bedroomB = entry({ filename: "b.jpg", galleryIndex: 1, category: "Bedrooms", bedroomClusterId: "room-2" });
check("vision edge between DIFFERENT bedroom clusters is refused",
  !dedupeEdgeAllowed(bedroomA, bedroomB).allowed);
check("vision edge between different categories is refused",
  !dedupeEdgeAllowed(
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Kitchen" }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Lanai" }),
  ).allowed);
check("exact-hash duplicates group even across category labels (mislabeled copy)",
  dedupeEdgeAllowed(
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Kitchen", hash: H0 }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Lanai", hash: H1 }),
  ).allowed);
check("same-category vision edge is allowed",
  dedupeEdgeAllowed(
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Pool" }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Pool" }),
  ).allowed);

console.log("photo-dedupe: group building");

{
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, hash: H0 }),
    entry({ filename: "b.jpg", galleryIndex: 1, hash: H1 }),
    entry({ filename: "c.jpg", galleryIndex: 2, hash: HFAR }),
  ];
  const { groups } = buildDuplicateGroupsForFolder("f", entries, clusterHashPairs(entries), []);
  check("exact hash pair forms one group of two", groups.length === 1 && groups[0].members.length === 2);
  check("exact pair is kind=exact", groups[0].kind === "exact");
  check("keeper is the earlier gallery photo; the other is removable",
    groups[0].members[0].filename === "a.jpg" && groups[0].members[0].keep === true && groups[0].members[1].keep === false);
}

{
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, hash: H0 }),
    entry({ filename: "b.jpg", galleryIndex: 1, hash: H8 }),
  ];
  const { groups } = buildDuplicateGroupsForFolder("f", entries, clusterHashPairs(entries), []);
  check("distance-8 pair is kind=near (not exact)", groups.length === 1 && groups[0].kind === "near");
}

{
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Pool" }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Pool" }),
    entry({ filename: "c.jpg", galleryIndex: 2, category: "Pool" }),
  ];
  const high = [{ indexes: [0, 2], reason: "same pool two angles", confidence: "high" as const }];
  const { groups } = buildDuplicateGroupsForFolder("f", entries, [], high);
  check("high-confidence vision group forms a same-scene group with its reason",
    groups.length === 1 && groups[0].kind === "same-scene" && groups[0].reason === "same pool two angles" &&
    groups[0].members.map((m) => m.filename).join(",") === "a.jpg,c.jpg");

  const medium = [{ indexes: [0, 2], reason: "maybe same", confidence: "medium" as const }];
  const mediumSets = buildDuplicateGroupsForFolder("f", entries, [], medium);
  check("medium-confidence vision groups are never PROPOSED (no maybe pre-selected)",
    mediumSets.groups.length === 0);
  // 2026-07-18: they are no longer discarded outright — a maybe is exactly the
  // repeat-angle case the operator asked to see, so it surfaces for review.
  check("medium-confidence vision groups SURFACE as review groups",
    mediumSets.reviewGroups.length === 1 && mediumSets.reviewGroups[0].kind === "review" &&
    mediumSets.reviewGroups[0].members.map((m) => m.filename).join(",") === "a.jpg,c.jpg");
  check("every review member keeps — a review group can never pre-select a removal",
    mediumSets.reviewGroups[0].members.every((m) => m.keep === true));
}

{
  // A vision over-merge across two bedroom clusters must not form a group.
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Bedrooms", bedroomClusterId: "room-1" }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Bedrooms", bedroomClusterId: "room-2" }),
  ];
  const bedroomSets = buildDuplicateGroupsForFolder("f", entries, [], [
    { indexes: [0, 1], reason: "similar bedrooms", confidence: "high" },
  ]);
  check("vision cannot merge two DIFFERENT bedroom clusters", bedroomSets.groups.length === 0);
  check("the guarded bedroom merge is still reported for review, not swallowed",
    bedroomSets.reviewGroups.length === 1 &&
    bedroomSets.reviewGroups[0].reason.includes("different bedroom clusters"));
}

console.log("photo-dedupe: keeper pick");

check("human-touched photo beats gallery order",
  pickKeeperIndex([
    entry({ filename: "a.jpg", galleryIndex: 0 }),
    entry({ filename: "b.jpg", galleryIndex: 1, humanTouched: true }),
  ]) === 1);
check("manual sort order beats gallery order",
  pickKeeperIndex([
    entry({ filename: "a.jpg", galleryIndex: 0, manualSortOrder: 5 }),
    entry({ filename: "b.jpg", galleryIndex: 1, manualSortOrder: 2 }),
  ]) === 1);
check("earlier gallery position wins by default",
  pickKeeperIndex([
    entry({ filename: "a.jpg", galleryIndex: 0 }),
    entry({ filename: "b.jpg", galleryIndex: 1 }),
  ]) === 0);
check("bigger file wins a full tie",
  pickKeeperIndex([
    entry({ filename: "a.jpg", galleryIndex: 0, byteSize: 100 }),
    entry({ filename: "b.jpg", galleryIndex: 0, byteSize: 900 }),
  ]) === 1);

console.log("photo-dedupe: apply validation");

const folderResult: DedupeFolderResult = {
  folder: "f",
  label: "Unit A (2BR)",
  totalVisible: 10,
  visionEligible: 10,
  scannedForVision: 10,
  visionBatchCount: 1,
  visionUsed: true,
  visionComplete: true,
  visionError: null,
  reviewGroups: [],
  groups: [
    {
      id: "f#0", folder: "f", kind: "exact", reason: "near-identical",
      members: [
        { filename: "a.jpg", caption: null, category: null, keep: true, humanTouched: false },
        { filename: "b.jpg", caption: null, category: null, keep: false, humanTouched: false },
        { filename: "c.jpg", caption: null, category: null, keep: false, humanTouched: false },
      ],
    },
  ],
};
const proposal = { folders: [folderResult] };

check("valid selection (extras only) passes",
  validateDedupeSelection(proposal, [{ folder: "f", filename: "b.jpg" }, { folder: "f", filename: "c.jpg" }]).ok);
check("selecting a file outside every group is rejected",
  !validateDedupeSelection(proposal, [{ folder: "f", filename: "z.jpg" }]).ok);
check("removing EVERY member of a group is rejected (keep-one guard)",
  !validateDedupeSelection(proposal, [
    { folder: "f", filename: "a.jpg" }, { folder: "f", filename: "b.jpg" }, { folder: "f", filename: "c.jpg" },
  ]).ok);
check("empty selection is rejected",
  !validateDedupeSelection(proposal, []).ok);
check("remaining count is reported per folder",
  validateDedupeSelection(proposal, [{ folder: "f", filename: "b.jpg" }]).remainingByFolder["f"] === 9);

{
  const tiny: DedupeFolderResult = { ...folderResult, totalVisible: 3 };
  const verdict = validateDedupeSelection({ folders: [tiny] }, [{ folder: "f", filename: "b.jpg" }]);
  check("dropping a small folder below 3 visible photos warns but does not block",
    verdict.ok && verdict.warnings.length === 1);
  const emptied = validateDedupeSelection(
    { folders: [{ ...tiny, totalVisible: 2 }] },
    [{ folder: "f", filename: "b.jpg" }, { folder: "f", filename: "c.jpg" }],
  );
  check("emptying a folder is a hard error", !emptied.ok);
}

console.log("photo-dedupe: proposal summary");

{
  const { groupCount, removableCount, warnings } = summarizeDedupeFolders([folderResult]);
  check("summary counts groups + removable extras", groupCount === 1 && removableCount === 2 && warnings.length === 0);
  const low = summarizeDedupeFolders([{ ...folderResult, totalVisible: 3 }]);
  check("summary warns when the default removal would leave < 3 photos", low.warnings.length === 1);
  const noVision = summarizeDedupeFolders([{ ...folderResult, visionBatchCount: 0, visionError: "no ANTHROPIC_API_KEY" }]);
  check("summary surfaces a vision-unavailable warning", noVision.warnings.some((w) => w.includes("hash-only")));
}

console.log("photo-dedupe: vision prompt stays conservative");

const instruction = buildDedupeVisionInstruction("Unit A (2BR)", 12);
check("prompt forbids grouping different rooms", instruction.includes("NEVER group photos of DIFFERENT rooms"));
check("prompt forbids grouping different amenities", instruction.includes("NEVER group different amenities"));
check("prompt tells the model not to group when unsure", instruction.includes("When unsure, DO NOT group"));
check("prompt asks for high-confidence marking", instruction.includes(`confidence "high" only when certain`));

console.log("photo-dedupe: source wiring locks");

const routesSource = readFileSync("server/routes.ts", "utf8");
check("scan endpoint exists", routesSource.includes(`app.post("/api/builder/photo-dedupe-scan"`));
check("apply endpoint exists", routesSource.includes(`app.post("/api/builder/photo-dedupe-apply"`));
check("restore endpoint exists", routesSource.includes(`app.post("/api/builder/photo-dedupe-restore"`));
check("apply validates against the STORED proposal via the shared validator",
  routesSource.includes("getStoredDedupeScan(") && routesSource.includes("validateDedupeSelection(proposal, remove)"));
check("apply is the hidden soft-delete, not a file deletion",
  routesSource.includes(`updatePhotoLabelOverrides(s.folder, s.filename, { hidden: true })`));
check("restore un-hides", routesSource.includes(`updatePhotoLabelOverrides(s.folder, s.filename, { hidden: false })`));
check("expired scan returns 410 so the client re-scans instead of applying blind",
  routesSource.includes("status(410)"));

const dedupeEngineSource = readFileSync("server/photo-dedupe.ts", "utf8");
check("dedupe engine NEVER deletes files from disk (undo depends on it)",
  !/\bunlink(?:Sync)?\s*\(/.test(dedupeEngineSource) && !/\brm(?:Sync|dir|dirSync)?\s*\(/.test(dedupeEngineSource));
check("dedupe engine fails soft to hash-only when the vision pass errors",
  dedupeEngineSource.includes("visionError") && dedupeEngineSource.includes("no ANTHROPIC_API_KEY"));
check("vision images are downscaled before inlining",
  dedupeEngineSource.includes("downscaleForVision"));

const builderIndexSource = readFileSync("client/src/components/GuestyListingBuilder/index.tsx", "utf8");
check("Photos tab has the scan button", builderIndexSource.includes(`data-testid="btn-photo-dedupe-scan"`));
check("Photos tab has the confirm-remove button", builderIndexSource.includes(`data-testid="btn-photo-dedupe-apply"`));
check("Photos tab has the undo button", builderIndexSource.includes(`data-testid="btn-photo-dedupe-undo"`));
check("apply asks for operator confirmation first",
  builderIndexSource.includes("window.confirm") && builderIndexSource.includes("Remove ${remove.length} duplicate photo"));
check("apply refreshes the photo-label state (hidden photos disappear from the tab)",
  builderIndexSource.includes("photo-dedupe-apply") && builderIndexSource.includes("onPhotoOverridesChanged?.();"));

console.log("photo-dedupe: Guesty propagation locks (2026-07-15 — a dedupe removal must reach Guesty)");

// The hide is a local soft-delete; what deletes the photo from the LIVE
// Guesty listing is the background gallery re-push (full pictures[] PUT).
// These locks keep that seam wired end-to-end.
check("apply/restore share the dedupeGuestySync helper (definition + 2 call sites)",
  routesSource.split("dedupeGuestySync(").length - 1 >= 2 && routesSource.includes("const dedupeGuestySync = async"));
check("the sync drives the existing gallery re-push, FIRE-AND-FORGET (response must not block minutes)",
  routesSource.includes("void repushGuestyPhotosForProperty(propertyId, { reason })"));
check("the sync requires a mapped Guesty listing and reports honestly when there is none",
  routesSource.includes("getGuestyListingId(propertyId)") && routesSource.includes(`{ started: false, reason: "no-guesty-mapping" }`));
check("no propertyId → no push (the opt-in gate)",
  routesSource.includes(`{ started: false, reason: "no-property" }`));

// The unit-audit sweep's loopback apply must stay propertyId-FREE: a
// mid-sweep gallery push would race the sweep's own photo stages
// (community ladder / replace / collage). The sweep DOES sync its dedupe
// hides to Guesty (decided 2026-07-15) — but at its OWN seam: one
// fire-and-forget re-push at sweep END, after every photo stage and the
// retry rails, never via the mid-sweep body. Standard audits may start that
// final push in the background; strict bulk audits await and verify it.
const sweepSource = readFileSync("server/unit-audit-sweep.ts", "utf8");
check("sweep loopback apply body stays { scanId, remove } — no propertyId, no mid-sweep push",
  sweepSource.includes(`"/api/builder/photo-dedupe-apply", { scanId, remove }`));

// The sweep's end-of-sweep sync seam (2026-07-15):
check("sweep durably tracks local gallery changes + dedupe hides for the end-of-sweep sync",
  sweepSource.includes("pendingGuestyGallerySync: true")
  && sweepSource.includes("pendingDedupeHiddenCount: record.pendingDedupeHiddenCount + remove.length")
  && !sweepSource.includes("dedupeHiddenThisSweep"));
check("sweep fires ONE gallery re-push at sweep END; strict audits await it while standard audits stay fire-and-forget",
  sweepSource.includes("const pushPromise = repushGuestyPhotosForProperty(record.propertyId")
  && sweepSource.includes("if (!record.fullAutomation)")
  && sweepSource.includes("void pushPromise.then(")
  && sweepSource.includes("const result = await pushPromise"));
check("the end-of-sweep push runs AFTER the retry rails, before the receipt (completed path)",
  /unitAuditRetryStageIds[\s\S]*noteSweepDedupeGuestySync\(record\);[\s\S]*const headline = unitAuditHeadline/.test(sweepSource));
check("a FAILED sweep still syncs its durable hides; a CANCELLED sweep does not",
  /noteSweepDedupeGuestySync\(record\);\s*\n\s*touch\(record, \{ status: "failed"/.test(sweepSource)
  && !/noteSweepDedupeGuestySync\(record\);\s*\n\s*touch\(record, \{ status: "cancelled"/.test(sweepSource));
check("a replace-rung resets pre-swap hides, while newer post-swap hides still reach the final push",
  sweepSource.includes("if (rungResult.ok) await clearGuestyGallerySyncPending(record)")
  && sweepSource.indexOf("if (rungResult.ok) await clearGuestyGallerySyncPending(record)")
    < sweepSource.indexOf("const dedupe = await stagePhotoDedupe(target, record)")
  && sweepSource.includes("pendingDedupeHiddenCount: record.pendingDedupeHiddenCount + remove.length")
  && !sweepSource.includes("already removed from Guesty by the unit replacement's gallery re-push"));
check("sweep dedupe push has a kill switch (AUDIT_DEDUPE_GUESTY_PUSH=0) with honest receipt copy",
  sweepSource.includes(`process.env.AUDIT_DEDUPE_GUESTY_PUSH`)
  && sweepSource.includes("NOT synchronized to Guesty (AUDIT_DEDUPE_GUESTY_PUSH=0)"));
check("the sync verdict lands on the photo-dedupe receipt row and clears the durable handoff only after success",
  sweepSource.includes(`record.stages.find((s) => s.stage === "photo-dedupe")`)
  && sweepSource.includes("if (result.ok && !result.skipped && exactGalleryVerified)")
  && sweepSource.includes("await clearGuestyGallerySyncPending(record, {")
  && sweepSource.includes("finalGuestyGalleryVerified: true"));

// The whole propagation depends on the repush assembly dropping hidden
// photos — if this filter goes, the re-push would re-publish the dupes.
const repushSharedSource = readFileSync("shared/guesty-photo-repush.ts", "utf8");
check("repush gallery assembly drops hidden photos",
  repushSharedSource.includes(".filter((filename) => !labelByFile.get(filename)?.hidden)"));

check("client sends propertyId on BOTH apply and restore (opts in to the Guesty sync)",
  builderIndexSource.split(`...(typeof propertyId === "number" ? { propertyId } : {})`).length - 1 >= 2);
check("applied panel renders the honest Guesty-sync verdict",
  builderIndexSource.includes(`data-testid="dedupe-guesty-sync-note"`)
  && builderIndexSource.includes("Removing them from Guesty too")
  && builderIndexSource.includes(`use "Push Photos to Guesty" to remove them from the live listing`));

// ── Manual-path vision coverage (2026-07-18) ────────────────────────────────
// The manual Photos-tab scan used to show Claude ONE evenly-strided sample of
// 60 photos and report the whole gallery as scanned, so repeat angles among
// the unsampled photos were invisible AND undisclosed.
console.log("photo-dedupe: manual vision batch plan");

{
  const one = buildManualVisionBatchPlan(40, 60, 4);
  check("manual plan: a folder inside the cap is one complete call",
    one.batches.length === 1 && one.complete && one.batches[0].length === 40);

  const exhaustive = buildManualVisionBatchPlan(90, 60, 4);
  check("manual plan: exhaustive pair cover is used when it fits the budget",
    exhaustive.complete && exhaustive.batches.length === 3);
  {
    const seen = new Set<string>();
    for (const b of exhaustive.batches) {
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) seen.add(`${Math.min(b[i], b[j])}|${Math.max(b[i], b[j])}`);
    }
    let missing = 0;
    for (let i = 0; i < 90; i++) for (let j = i + 1; j < 90; j++) if (!seen.has(`${i}|${j}`)) missing++;
    check("manual plan: the exhaustive tier really compares every pair", missing === 0);
  }

  // Tier 3: too big to pair-cover on the manual budget. The old behaviour
  // dropped 140 of 200 photos entirely; every photo must now be seen.
  const chunked = buildManualVisionBatchPlan(200, 60, 4);
  check("manual plan: an oversized folder falls back to chunks, not a sample",
    !chunked.complete && chunked.batches.length === 4 && chunked.error === null);
  check("manual plan: the chunked tier still shows EVERY photo to Claude",
    (chunked.covered ?? []).length === 200);
  check("manual plan: chunked coverage reports incomplete PAIR coverage honestly",
    chunked.complete === false);

  const tinyBudget = buildManualVisionBatchPlan(200, 60, 1);
  check("manual plan: a one-call budget covers what it can and never claims complete",
    tinyBudget.batches.length === 1 && !tinyBudget.complete && (tinyBudget.covered ?? []).length === 60);

  check("manual plan: a folder with nothing to compare is trivially complete",
    buildManualVisionBatchPlan(1, 60, 4).complete && buildManualVisionBatchPlan(1, 60, 4).batches.length === 0);
  check("manual plan: a folder with no batches never claims a photo was shown to Claude",
    (buildManualVisionBatchPlan(1, 60, 4).covered ?? []).length === 0);
  check("manual plan: no tier ever emits a batch above the per-call cap",
    [[40,60,4],[61,60,4],[90,60,4],[121,60,3],[200,60,4],[200,60,1],[2,2,1]].every(
      ([n, c, b]) => buildManualVisionBatchPlan(n, c, b).batches.every((x) => x.length <= c)));
  check("manual plan: a zero batch budget is an explicit error, never a silent pass",
    !buildManualVisionBatchPlan(30, 60, 0).complete && !!buildManualVisionBatchPlan(30, 60, 0).error);
  {
    // A trailing chunk of one photo cannot be compared with anything — it must
    // be folded back rather than burning a useless call or being dropped.
    const folded = buildManualVisionBatchPlan(121, 60, 3);
    check("manual plan: an orphan tail photo is absorbed without exceeding the per-call cap",
      folded.batches.every((b) => b.length >= 2 && b.length <= 60) && (folded.covered ?? []).length === 121);
  }
}

console.log("photo-dedupe: vision groups gate per PAIR, not in a star");

{
  // The old union only tested valid[0]<->valid[i], so one blocked first edge
  // discarded every other pair in the group. Here photo a carries a different
  // machine category, but b and c are a genuine repeat and must still group.
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Exterior" }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Pool" }),
    entry({ filename: "c.jpg", galleryIndex: 2, category: "Pool" }),
  ];
  const sets = buildDuplicateGroupsForFolder("f", entries, [], [
    { indexes: [0, 1, 2], reason: "same pool three angles", confidence: "high" },
  ]);
  check("a blocked first edge no longer discards the rest of the group",
    sets.groups.length === 1 && sets.groups[0].members.map((m) => m.filename).join(",") === "b.jpg,c.jpg");
  check("the category-guarded pairs are surfaced for review instead of vanishing",
    sets.reviewGroups.length > 0 && sets.reviewGroups.every((g) => g.members.every((m) => m.keep)));
}

{
  // A review candidate whose photos are ALL already together in one confirmed
  // group tells the operator nothing new and must be dropped (it is already
  // actionable there). Overlap alone is fine — see the star-topology case above,
  // where a third guarded photo is deliberately still surfaced.
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, hash: H0, category: "Pool" }),
    entry({ filename: "b.jpg", galleryIndex: 1, hash: H1, category: "Pool" }),
  ];
  const sets = buildDuplicateGroupsForFolder("f", entries, clusterHashPairs(entries), [
    { indexes: [0, 1], reason: "maybe the same", confidence: "medium" },
  ]);
  check("a review candidate already covered by a confirmed group is not repeated",
    sets.groups.length === 1 && sets.reviewGroups.length === 0);
}

{
  // Selecting one photo that appears in BOTH tiers must count once, or the
  // never-empty-folder guard would fire on a folder that still has photos.
  const shared: DedupeFolderResult = {
    ...folderResult,
    totalVisible: 3,
    groups: [{
      id: "f#0", folder: "f", kind: "same-scene", reason: "same lanai",
      members: [
        { filename: "a.jpg", caption: null, category: null, keep: true, humanTouched: false },
        { filename: "b.jpg", caption: null, category: null, keep: false, humanTouched: false },
      ],
    }],
    reviewGroups: [{
      id: "f#review0", folder: "f", kind: "review", reason: "possible repeat",
      members: [
        { filename: "b.jpg", caption: null, category: null, keep: true, humanTouched: false },
        { filename: "c.jpg", caption: null, category: null, keep: true, humanTouched: false },
      ],
    }],
  };
  const v = validateDedupeSelection({ folders: [shared] }, [{ folder: "f", filename: "b.jpg" }]);
  check("a photo in both tiers counts once against the folder total",
    v.ok && v.remainingByFolder["f"] === 2);
}

console.log("photo-dedupe: merge guards hold at CLUSTER level, not just per pair");

{
  // REGRESSION: union-find is transitive, so an unlabeled bridge photo that is
  // edge-allowed against BOTH bedrooms would re-merge the very pair the guard
  // refused — producing a confirmed group with a second bedroom's photo
  // pre-selected for removal, which the weekly sweep would auto-hide.
  const entries = [
    entry({ filename: "bed1.jpg", galleryIndex: 0, category: "Bedrooms", bedroomClusterId: "room-1" }),
    entry({ filename: "bed2.jpg", galleryIndex: 1, category: "Bedrooms", bedroomClusterId: "room-2" }),
    entry({ filename: "unlabeled.jpg", galleryIndex: 2 }),
  ];
  const sets = buildDuplicateGroupsForFolder("f", entries, [], [
    { indexes: [0, 1, 2], reason: "similar bedspreads", confidence: "high" },
  ]);
  const merged = sets.groups.find((g) =>
    g.members.some((m) => m.filename === "bed1.jpg") && g.members.some((m) => m.filename === "bed2.jpg"));
  check("an unlabeled bridge photo can NEVER merge two different bedrooms", !merged);
  check("no bedroom photo is pre-selected for removal via the bridge",
    sets.groups.every((g) => g.members.every((m) => m.keep || m.filename === "unlabeled.jpg")));
  check("the refused bedroom merge is surfaced for review",
    sets.reviewGroups.some((g) => g.reason.includes("bedroom")));
}

{
  // Same transitivity hole for the CATEGORY guard.
  const entries = [
    entry({ filename: "kitchen.jpg", galleryIndex: 0, category: "Kitchen" }),
    entry({ filename: "lanai.jpg", galleryIndex: 1, category: "Lanai" }),
    entry({ filename: "unlabeled.jpg", galleryIndex: 2 }),
  ];
  const sets = buildDuplicateGroupsForFolder("f", entries, [], [
    { indexes: [0, 1, 2], reason: "looks similar", confidence: "high" },
  ]);
  check("an unlabeled bridge photo cannot merge two different categories",
    !sets.groups.some((g) =>
      g.members.some((m) => m.filename === "kitchen.jpg") && g.members.some((m) => m.filename === "lanai.jpg")));
}

{
  // The guard must not over-block: a genuine 3-shot repeat in ONE room still groups.
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Bedrooms", bedroomClusterId: "room-1" }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Bedrooms", bedroomClusterId: "room-1" }),
    entry({ filename: "c.jpg", galleryIndex: 2, category: "Bedrooms", bedroomClusterId: "room-1" }),
  ];
  const sets = buildDuplicateGroupsForFolder("f", entries, [], [
    { indexes: [0, 1, 2], reason: "same bedroom three angles", confidence: "high" },
  ]);
  check("a genuine same-room 3-shot repeat still forms ONE group of three",
    sets.groups.length === 1 && sets.groups[0].members.length === 3);
  check("that group keeps exactly one photo",
    sets.groups[0].members.filter((m) => m.keep).length === 1);
}

console.log("photo-dedupe: review tier is selectable but never auto-removable");

{
  const withReview: DedupeFolderResult = {
    ...folderResult,
    groups: [],
    reviewGroups: [{
      id: "f#review0", folder: "f", kind: "review", reason: "possible repeat",
      members: [
        { filename: "r1.jpg", caption: null, category: null, keep: true, humanTouched: false },
        { filename: "r2.jpg", caption: null, category: null, keep: true, humanTouched: false },
      ],
    }],
  };
  const ok = validateDedupeSelection({ folders: [withReview] }, [{ folder: "f", filename: "r2.jpg" }]);
  check("the operator CAN confirm a review photo (apply must not reject it)", ok.ok);
  const both = validateDedupeSelection({ folders: [withReview] }, [
    { folder: "f", filename: "r1.jpg" }, { folder: "f", filename: "r2.jpg" },
  ]);
  check("the keep-one guard applies to review groups too", !both.ok);
  check("review removals count against the folder's remaining photos", ok.remainingByFolder["f"] === 9);

  const summary = summarizeDedupeFolders([withReview]);
  check("review groups are counted separately and never inflate the duplicate count",
    summary.groupCount === 0 && summary.removableCount === 0 && summary.reviewGroupCount === 1);
}

console.log("photo-dedupe: incomplete AI coverage is disclosed");

{
  const partial = summarizeDedupeFolders([{ ...folderResult, visionComplete: false, scannedForVision: 6, totalVisible: 10 }]);
  check("summary warns when the AI angle pass covered only part of a gallery",
    partial.warnings.some((w) => w.includes("6 of 10")));
  const pairsOnly = summarizeDedupeFolders([{ ...folderResult, visionComplete: false, scannedForVision: 10, totalVisible: 10 }]);
  check("summary distinguishes 'every photo seen' from 'every pair compared'",
    pairsOnly.warnings.some((w) => w.includes("not every pair")));
  const complete = summarizeDedupeFolders([folderResult]);
  check("a fully covered gallery produces no coverage warning", complete.warnings.length === 0);
  const errored = summarizeDedupeFolders([{ ...folderResult, visionComplete: false, visionBatchCount: 0, visionError: "boom" }]);
  check("a gallery whose AI pass never ran reports hash-only, once",
    errored.warnings.length === 1 && errored.warnings[0].includes("hash-only"));
  // A pass that ran some batches then failed is NOT hash-only — AI groups from
  // the completed batches are on screen, so the copy must not contradict them.
  const partialFail = summarizeDedupeFolders([{ ...folderResult, visionComplete: false, visionBatchCount: 2, visionError: "timeout" }]);
  check("a partially-completed AI pass is reported as partial, not as hash-only",
    partialFail.warnings.length === 1 && partialFail.warnings[0].includes("stopped early")
    && !partialFail.warnings[0].includes("hash-only"));
}

console.log("photo-dedupe: prompt names the operator's actual target");
check("prompt names repeat angles of the same shot as the target",
  instruction.includes("TOO MANY ANGLES OF THE SAME SHOT"));
check("prompt tells the model captions are machine-generated and not evidence",
  instruction.includes("MACHINE-GENERATED"));

console.log("photo-dedupe: engine + sweep source guards");

check("manual scans plan coverage with buildManualVisionBatchPlan",
  dedupeEngineSource.includes("buildManualVisionBatchPlan(readable.length, VISION_PHOTO_CAP, MANUAL_VISION_MAX_BATCHES)"));
check("the local even-stride sampler is gone (it caused the silent under-scan)",
  !dedupeEngineSource.includes("function evenSampleIndices"));
check("the wall-clock budget is owned by the HTTP ROUTE, not invented by the engine",
  routesSource.includes("deadlineAt: Date.now() + MANUAL_SCAN_BUDGET_MS")
  && !dedupeEngineSource.includes("options.deadlineAt ?? Date.now()"));
check("background callers (the sweep) run unbudgeted — no default deadline in the engine",
  dedupeEngineSource.includes("const overallDeadline = options.deadlineAt;"));
check("strict automation is exempt from the deadline check",
  dedupeEngineSource.includes("!options.requireCompleteVision && options.deadlineAt != null"));
// The budget used to be consumed in folder order, so on a large property the
// LAST gallery — typically Unit B — could get zero repeat-angle coverage.
check("each folder gets a fair share of the remaining budget",
  dedupeEngineSource.includes("remaining / (groups.length - i)"));
check("the sweep still passes no deadline of its own",
  !sweepSource.includes("deadlineAt"));
check("the engine returns review groups alongside confirmed groups",
  dedupeEngineSource.includes("const { groups, reviewGroups } = buildDuplicateGroupsForFolder"));

const sweepLogicSource = readFileSync("shared/unit-audit-sweep-logic.ts", "utf8");
check("the sweep auto-fix explicitly refuses to hide a review group",
  sweepLogicSource.includes(`if (g.kind === "review") continue;`));

check("the sweep's clean-gallery test still reads only .groups (review groups must not flag a sweep)",
  sweepSource.includes("proposal.folders.flatMap((f) => f.groups.map(") && !sweepSource.includes("f.reviewGroups"));

console.log("photo-dedupe: Photos-tab honesty");

check("the coverage receipt renders for EVERY scanned folder, not only ones with findings",
  builderIndexSource.includes("dedupe-coverage-") && builderIndexSource.includes("Scanned {dedupeResult.folders.length} galler"));
check("warnings + note render on every completed scan, not just when groups were found",
  builderIndexSource.split("dedupeResult.warnings").length - 1 === 1
  && builderIndexSource.includes("note + warnings render once in the coverage receipt above"));
check("the clean verdict only claims repeat-angle coverage when every gallery was fully checked",
  builderIndexSource.includes("No duplicate or repeat-angle photos found")
  && builderIndexSource.includes("the AI repeat-angle pass did not cover everything"));
check("the review tier renders with nothing pre-selected",
  builderIndexSource.includes(`data-testid="dedupe-review-header"`)
  && builderIndexSource.includes("Nothing is selected; tick anything you agree is a repeat"));
check("review-only findings still get an apply button when there are no confirmed groups",
  builderIndexSource.includes(`data-testid="btn-photo-dedupe-apply-review"`));
check("the client pre-selects removals only from confirmed groups",
  builderIndexSource.includes("for (const g of f.groups ?? [])"));
// A filename can sit in a confirmed group AND a review group, so a per-group
// keep-one check let the operator build a selection the server would 422.
check("the keep-one checkbox guard spans every group containing the photo",
  builderIndexSource.includes("const toggleDedupePhoto = useCallback")
  && builderIndexSource.includes("const allGroups = [...(f?.groups ?? []), ...(f?.reviewGroups ?? [])];")
  && builderIndexSource.split("toggleDedupePhoto(f.folder, m.filename)").length - 1 === 2);
check("the coverage receipt distinguishes 'saw every photo' from 'compared every pair'",
  builderIndexSource.includes("but not every pair together"));
check("the in-progress copy no longer overclaims what the AI pass compares",
  builderIndexSource.includes("every photo in every gallery on this tab by perceptual hash")
  && builderIndexSource.includes("reports exactly what each pass covered")
  && !builderIndexSource.includes("Comparing every photo in each gallery (perceptual hash"));

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
