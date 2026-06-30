import {
  needsSameRoomVision,
  parseSameRoomGroups,
  applySameRoomGroups,
} from "../shared/bedroom-same-room-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("bedroom same-room (different-angle) logic");

// ── needsSameRoomVision ──
check("needsSameRoomVision false for 0/1 clusters",
  !needsSameRoomVision(0) && !needsSameRoomVision(1));
check("needsSameRoomVision true for >= 2 clusters",
  needsSameRoomVision(2) && needsSameRoomVision(5));

// ── parseSameRoomGroups: happy paths ──
const ids3 = ["BR1", "BR2", "BR3"];
const roomsForm = parseSameRoomGroups('{"rooms":[{"ids":["BR1","BR3"]},{"ids":["BR2"]}]}', ids3);
check("parses {rooms:[{ids}]} into a partition",
  !!roomsForm && roomsForm.length === 2
  && roomsForm[0].join(",") === "BR1,BR3" && roomsForm[1].join(",") === "BR2");

const groupsForm = parseSameRoomGroups('{"groups":[["BR1","BR3"],["BR2"]]}', ids3);
check("parses {groups:[[...]]} into a partition",
  !!groupsForm && groupsForm.length === 2 && groupsForm[0].length === 2);

check("parses through prose / code fences around the JSON",
  !!parseSameRoomGroups('```json\n{"rooms":[{"ids":["BR1","BR2","BR3"]}]}\n```', ids3));

check("all-separate partition is valid",
  (() => {
    const g = parseSameRoomGroups('{"rooms":[{"ids":["BR1"]},{"ids":["BR2"]},{"ids":["BR3"]}]}', ids3);
    return !!g && g.length === 3;
  })());

// ── parseSameRoomGroups: rejection (must no-op → null) ──
check("rejects an unknown/hallucinated id", parseSameRoomGroups('{"rooms":[{"ids":["BR1","BRX"]},{"ids":["BR2"]}]}', ids3) === null);
check("rejects an id appearing in two groups", parseSameRoomGroups('{"rooms":[{"ids":["BR1","BR2"]},{"ids":["BR2","BR3"]}]}', ids3) === null);
check("rejects a partial partition (missing id)", parseSameRoomGroups('{"rooms":[{"ids":["BR1"]},{"ids":["BR2"]}]}', ids3) === null);
check("rejects malformed JSON", parseSameRoomGroups("not json at all", ids3) === null);
check("rejects when neither rooms nor groups present", parseSameRoomGroups('{"foo":1}', ids3) === null);
check("rejects empty valid id set", parseSameRoomGroups('{"rooms":[{"ids":["BR1"]}]}', []) === null);

// ── applySameRoomGroups ──
type Ref = { id: string };
const clusters: Ref[][] = [
  [{ id: "a1" }, { id: "a2" }],   // cluster 0, rep a1 (master, bed angle)
  [{ id: "b1" }],                  // cluster 1, rep b1 (guest)
  [{ id: "c1" }],                  // cluster 2, rep c1 (master, TV angle)
];
const repIds = ["a1", "b1", "c1"];

const folded = applySameRoomGroups(clusters, repIds, [["a1", "c1"], ["b1"]]);
check("folds two same-room clusters into one",
  folded.clusters.length === 2 && folded.mergedCount === 1);
check("merged cluster keeps the earliest position and concatenates photos",
  folded.clusters[0].map((p) => p.id).join(",") === "a1,a2,c1"
  && folded.clusters[1].map((p) => p.id).join(",") === "b1");

const allSeparate = applySameRoomGroups(clusters, repIds, [["a1"], ["b1"], ["c1"]]);
check("all-separate partition leaves clusters untouched",
  allSeparate.clusters.length === 3 && allSeparate.mergedCount === 0);

const allOne = applySameRoomGroups(clusters, repIds, [["a1", "b1", "c1"]]);
check("everything-one-room collapses to a single cluster with every photo",
  allOne.clusters.length === 1 && allOne.clusters[0].length === 4 && allOne.mergedCount === 2);

const mismatched = applySameRoomGroups(clusters, ["a1", "b1"], [["a1", "b1"]]);
check("repIds/clusters length mismatch is a safe no-op",
  mismatched.clusters.length === 3 && mismatched.mergedCount === 0);

// ── minClusters blast-radius floor (defense against vision over-merge) ──
// A 3BR (expected 3 → floor = expected-1 = 2). Folding the two master angles
// to 2 rooms is ALLOWED (surfaces the 1-bedroom gap)…
const floorAllows = applySameRoomGroups(clusters, repIds, [["a1", "c1"], ["b1"]], 2);
check("floor allows a fold down to expected-1 (surfaces a believable gap)",
  floorAllows.clusters.length === 2 && floorAllows.mergedCount === 1);

// …but a partition that collapses everything to 1 (implying 2 missing bedrooms,
// far likelier a vision error) is REJECTED wholesale → clusters untouched.
const floorRejects = applySameRoomGroups(clusters, repIds, [["a1", "b1", "c1"]], 2);
check("floor rejects an over-collapse below the floor (no merge, untouched)",
  floorRejects.clusters.length === 3 && floorRejects.mergedCount === 0);

check("no floor (undefined) still allows total collapse",
  applySameRoomGroups(clusters, repIds, [["a1", "b1", "c1"]]).clusters.length === 1);

// expected=2 → floor=1: a fold to 1 room is still allowed (can't distinguish a
// real 1/2 gap from a merge at this count; reliability is the guard there).
const floorTwo = applySameRoomGroups(
  [[{ id: "x1" }], [{ id: "x2" }]] as Ref[][], ["x1", "x2"], [["x1", "x2"]], 1,
);
check("floor of 1 (expected 2) still permits a single-room fold",
  floorTwo.clusters.length === 1 && floorTwo.mergedCount === 1);

// End-to-end: a 3BR scrape where the master was shot twice (head-on + TV angle)
// and the 3rd bedroom was never photographed → vision says master angles are one
// room → 2 distinct rooms, surfacing the coverage gap instead of masking it.
const e2e = (() => {
  const cl: Ref[][] = [[{ id: "m-bed" }], [{ id: "guest" }], [{ id: "m-tv" }]];
  const partition = parseSameRoomGroups('{"rooms":[{"ids":["m-bed","m-tv"]},{"ids":["guest"]}]}', ["m-bed", "guest", "m-tv"]);
  if (!partition) return false;
  const out = applySameRoomGroups(cl, ["m-bed", "guest", "m-tv"], partition);
  return out.clusters.length === 2; // 2 rooms photographed for a 3BR → gap visible
})();
check("end-to-end: 3 clusters → 2 real rooms when master shot twice", e2e);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
