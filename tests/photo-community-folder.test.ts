import {
  chunkArray,
  clusterPhotosByHash,
  communityAuditCoverage,
  detectLikelyMixedCommunityFolder,
  hammingHex,
  mergeCommunityPhotoVerdicts,
} from "../shared/photo-community-folder-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("photo-community-folder logic");

check("chunkArray splits evenly",
  chunkArray([1, 2, 3, 4, 5], 2).length === 3 && chunkArray([1, 2, 3, 4, 5], 2)[0].length === 2);

const nearA = "a".repeat(16);
const nearB = "a".repeat(15) + "b";
const far = "f".repeat(16);
const clustered = clusterPhotosByHash([
  { id: "1", hash: nearA },
  { id: "2", hash: nearB },
  { id: "3", hash: far },
]);
check("clusterPhotosByHash groups similar hashes",
  clustered.length === 2 && clustered[0].length === 2);

const mixed = detectLikelyMixedCommunityFolder([nearA, nearB, far, "0".repeat(16)]);
check("detectLikelyMixedCommunityFolder flags spread + near dupes",
  mixed.mixed === true && mixed.maxDistance >= 36);

const uniform = detectLikelyMixedCommunityFolder([nearA, nearB, nearA, nearB]);
check("detectLikelyMixedCommunityFolder passes uniform resort folder",
  uniform.mixed === false);

const merged = mergeCommunityPhotoVerdicts([
  [{ id: "C1", match: "yes", reason: "ok" }, { id: "C2", match: "yes", reason: "ok" }],
  [{ id: "C2", match: "no", reason: "wrong place" }, { id: "C3", match: "yes", reason: "ok" }],
]);
check("mergeCommunityPhotoVerdicts keeps strongest no",
  merged.find((v) => v.id === "C2")?.match === "no" && merged.length === 3);

check("communityAuditCoverage labels checked/total",
  communityAuditCoverage(28, 28).complete && communityAuditCoverage(28, 28).label === "28/28");

check("hammingHex distance zero for identical",
  hammingHex(nearA, nearA) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
