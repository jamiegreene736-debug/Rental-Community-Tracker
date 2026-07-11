import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  buildDedupeVisionInstruction,
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
  const groups = buildDuplicateGroupsForFolder("f", entries, clusterHashPairs(entries), []);
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
  const groups = buildDuplicateGroupsForFolder("f", entries, clusterHashPairs(entries), []);
  check("distance-8 pair is kind=near (not exact)", groups.length === 1 && groups[0].kind === "near");
}

{
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Pool" }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Pool" }),
    entry({ filename: "c.jpg", galleryIndex: 2, category: "Pool" }),
  ];
  const high = [{ indexes: [0, 2], reason: "same pool two angles", confidence: "high" as const }];
  const groups = buildDuplicateGroupsForFolder("f", entries, [], high);
  check("high-confidence vision group forms a same-scene group with its reason",
    groups.length === 1 && groups[0].kind === "same-scene" && groups[0].reason === "same pool two angles" &&
    groups[0].members.map((m) => m.filename).join(",") === "a.jpg,c.jpg");

  const medium = [{ indexes: [0, 2], reason: "maybe same", confidence: "medium" as const }];
  check("medium-confidence vision groups are DISCARDED (never propose a maybe)",
    buildDuplicateGroupsForFolder("f", entries, [], medium).length === 0);
}

{
  // A vision over-merge across two bedroom clusters must not form a group.
  const entries = [
    entry({ filename: "a.jpg", galleryIndex: 0, category: "Bedrooms", bedroomClusterId: "room-1" }),
    entry({ filename: "b.jpg", galleryIndex: 1, category: "Bedrooms", bedroomClusterId: "room-2" }),
  ];
  const groups = buildDuplicateGroupsForFolder("f", entries, [], [
    { indexes: [0, 1], reason: "similar bedrooms", confidence: "high" },
  ]);
  check("vision cannot merge two DIFFERENT bedroom clusters", groups.length === 0);
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
  scannedForVision: 10,
  visionUsed: true,
  visionError: null,
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
  const noVision = summarizeDedupeFolders([{ ...folderResult, visionError: "no ANTHROPIC_API_KEY" }]);
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

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
