import assert from "node:assert";
import {
  communityNamesMatch,
  computeUnitVerdict,
  filterUnitOutliers,
  isInteriorPhoto,
  pickInteriorPhotos,
  isStrongContradiction,
} from "../shared/photo-community-check-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("photo-community-check: interior selection + binary verdicts");

check("communityNamesMatch handles aliases",
  communityNamesMatch("Regency at Poipu Kai", "Poipu Kai Regency"));

check("communityNamesMatch rejects unrelated names",
  !communityNamesMatch("Kiahuna Plantation", "Completely Different Resort"));

check("isInteriorPhoto detects bedroom captions",
  isInteriorPhoto("King Bedroom") && !isInteriorPhoto("Oceanfront Pool"));

const files = [
  { filename: "a.jpg", caption: "Resort Pool" },
  { filename: "b.jpg", caption: "King Bedroom" },
  { filename: "c.jpg", caption: "Updated Kitchen" },
  { filename: "d.jpg", caption: "Living Room" },
  { filename: "e.jpg", caption: "Master Bath" },
  { filename: "f.jpg", caption: "Lanai View" },
];
const picked = pickInteriorPhotos(files, 5);
check("pickInteriorPhotos prioritizes interior-labeled files",
  picked.interiorCount === 5 && picked.chosen.map((f) => f.filename).join() === "b.jpg,c.jpg,d.jpg,e.jpg,f.jpg");

const fiveYes = Array.from({ length: 5 }, () => ({ match: "yes" as const, reason: "compatible finishes" }));
check("computeUnitVerdict passes with 5/5 yes votes",
  computeUnitVerdict(fiveYes, 5).sameAsCommunity === "yes");

const fourYesOneNo = [
  ...Array.from({ length: 4 }, () => ({ match: "yes" as const, reason: "ok" })),
  { match: "no" as const, reason: "weak mismatch" },
];
check("computeUnitVerdict fails with 4/5 yes votes",
  computeUnitVerdict(fourYesOneNo, 5).sameAsCommunity === "no");

check("computeUnitVerdict fails when fewer than 5 photos",
  computeUnitVerdict(fiveYes.slice(0, 3), 5).sameAsCommunity === "no");

const strongNo = [
  ...Array.from({ length: 4 }, () => ({ match: "yes" as const, reason: "ok" })),
  { match: "no" as const, reason: "Different resort signage visible on pool towel" },
];
check("computeUnitVerdict fails on strong contradiction",
  computeUnitVerdict(strongNo, 5).sameAsCommunity === "no");

check("isStrongContradiction detects resort signage mismatch",
  isStrongContradiction("Different resort signage visible on pool towel"));

check("filterUnitOutliers drops community pool/lanai shots from unit gallery",
  filterUnitOutliers([
    { id: "U1-3", caption: "Oceanfront Pool", reason: "shows resort pool not unit interior" },
    { id: "U1-7", caption: "Lanai View", reason: "exterior lanai" },
  ]).length === 0);

check("filterUnitOutliers keeps mismatched interior outliers",
  filterUnitOutliers([
    { id: "U1-2", caption: "Updated Kitchen", reason: "different kitchen finishes than other unit photos" },
  ]).length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
