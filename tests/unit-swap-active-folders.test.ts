import assert from "node:assert";
import {
  collectUnitSwapSkipUrls,
  latestUnitSwapsByUnit,
  replacementPhotoFolderForUnit,
  resolveActiveUnitPhotoFolders,
} from "../shared/unit-swap-photos";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("unit-swap-active-folders: active photo-folder resolution");

// latestUnitSwapsByUnit — newest-first input, first row per unit wins
{
  const latest = latestUnitSwapsByUnit([
    { oldUnitId: "u-a", id: 3 },
    { oldUnitId: "u-a", id: 1 },
    { oldUnitId: "u-b", id: 2 },
  ] as Array<{ oldUnitId: string; id: number }>);
  check("first (newest) swap per unit wins", (latest.get("u-a") as any).id === 3 && latest.size === 2);
}
check("swap rows without oldUnitId are ignored",
  latestUnitSwapsByUnit([{ oldUnitId: "" }, { oldUnitId: "u-a" }]).size === 1);

// Replacement searches exclude every historical source, not only the newest
// row per unit, plus every candidate burned during the current retry loop.
{
  const skipUrls = collectUnitSwapSkipUrls([
    { newSourceUrl: "https://www.zillow.com/homedetails/older-source/123_zpid/?utm_source=first" },
    { newSourceUrl: "https://zillow.com/homedetails/current-source/456_zpid/" },
    { newSourceUrl: "https://zillow.com/homedetails/older-source/123_zpid/#photos" },
    { newSourceUrl: "data:text/plain,not-a-listing" },
  ], [
    "https://www.redfin.com/HI/Koloa/rejected-candidate/home/789?source=search",
    "https://redfin.com/HI/Koloa/rejected-candidate/home/789#photos",
    null,
  ]);
  check("all historical and rejected listing sources are excluded without query/hash duplicates",
    skipUrls.length === 3
    && skipUrls.some((url) => url.includes("older-source"))
    && skipUrls.some((url) => url.includes("current-source"))
    && skipUrls.some((url) => url.includes("rejected-candidate")));
}

// resolveActiveUnitPhotoFolders
const units = [
  { id: "u-a", photoFolder: "poipu-kai-721" },
  { id: "u-b", photoFolder: "poipu-kai-723" },
  { id: "u-c", photoFolder: undefined },
];

{
  const active = resolveActiveUnitPhotoFolders(4, units, []);
  check("no swaps → every unit keeps its own folder",
    active.length === 2 && active.every((f) => f.activeFolder === f.originalFolder && !f.replaced));
}

{
  const active = resolveActiveUnitPhotoFolders(4, units, [{ oldUnitId: "u-a" }]);
  const a = active.find((f) => f.unitId === "u-a")!;
  const b = active.find((f) => f.unitId === "u-b")!;
  check("swapped unit resolves to its replacement-* folder",
    a.replaced && a.activeFolder === replacementPhotoFolderForUnit(4, "u-a") && a.activeFolder.startsWith("replacement-p4-u"));
  check("original folder preserved alongside for fallback", a.originalFolder === "poipu-kai-721");
  check("unswapped sibling unit is untouched", !b.replaced && b.activeFolder === "poipu-kai-723");
}

check("folderless units are dropped (nothing to verify)",
  resolveActiveUnitPhotoFolders(4, units, [{ oldUnitId: "u-c" }]).every((f) => f.unitId !== "u-c"));

check("draft (negative id) replacement folder uses the draft- prefix",
  resolveActiveUnitPhotoFolders(-12, [{ id: "unit1", photoFolder: "draft-12-unit-a" }], [{ oldUnitId: "unit1" }])[0]
    .activeFolder === replacementPhotoFolderForUnit(-12, "unit1"));

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
