import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  communityNamesMatch,
  computeUnitVerdict,
  filterUnitOutliers,
  isInteriorPhoto,
  pickInteriorPhotos,
  isStrongContradiction,
  communityOnlyCheckRequest,
  communityPhotosCorrectAnswer,
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
check("computeUnitVerdict fails with 4/5 yes votes (unanimous required)",
  computeUnitVerdict(fourYesOneNo, 5).sameAsCommunity === "no");

const sevenYesOneNo = [
  ...Array.from({ length: 7 }, () => ({ match: "yes" as const, reason: "ok" })),
  { match: "no" as const, reason: "weak mismatch" },
];
check("computeUnitVerdict fails with 7/8 yes votes (unanimous required)",
  computeUnitVerdict(sevenYesOneNo, 5).sameAsCommunity === "no");

check("computeUnitVerdict passes with 8/8 unanimous yes votes",
  computeUnitVerdict(Array.from({ length: 8 }, () => ({ match: "yes" as const, reason: "ok" })), 5).sameAsCommunity === "yes");

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

// ── communityOnlyCheckRequest (preflight "Check photos are correct") ─────────

console.log("\nphoto-community-check: community-only request narrowing");

const fullRequest = {
  expectedCommunity: "Kamaole Beach Club",
  expectedListingBedrooms: 4,
  groups: [
    { role: "community", folder: "kamaole-beach-club-community" },
    { role: "unit", folder: "kamaole-unit-a" },
    { role: "unit", folder: "kamaole-unit-b" },
  ],
};
const narrowed = communityOnlyCheckRequest(fullRequest);
check("communityOnlyCheckRequest keeps only the community group",
  narrowed.groups.length === 1 && narrowed.groups[0].role === "community");
check("communityOnlyCheckRequest keeps expectedCommunity",
  narrowed.expectedCommunity === "Kamaole Beach Club");
check("communityOnlyCheckRequest drops expectedListingBedrooms (bedroom coverage is a unit-leg concern)",
  !("expectedListingBedrooms" in narrowed));
check("communityOnlyCheckRequest yields no groups when the request has no community folder",
  communityOnlyCheckRequest({ groups: [{ role: "unit", folder: "u" }] }).groups.length === 0);

// ── communityPhotosCorrectAnswer (YES / NO / review headline) ────────────────

console.log("\nphoto-community-check: community-photos yes/no answer");

const yes = communityPhotosCorrectAnswer("Kamaole Beach Club", "pass", {
  identifiedCommunity: "Kamaole Beach Club",
  matchesExpected: "yes",
  overallStatus: "verified",
});
check("positive identification → YES", yes.answer === "yes" && yes.headline.includes("YES") && yes.headline.includes("Kamaole Beach Club"));

const yesWithWarnings = communityPhotosCorrectAnswer("Kamaole Beach Club", "warn", {
  identifiedCommunity: "Kamaole Beach Club",
  matchesExpected: "yes",
  overallStatus: "likely",
});
check("positive identification with minor warnings stays YES (warnings render below)",
  yesWithWarnings.answer === "yes");

const noNamed = communityPhotosCorrectAnswer("Kamaole Beach Club", "fail", {
  identifiedCommunity: "Maui Banyan",
  matchesExpected: "no",
  overallStatus: "mismatch",
});
check("mismatch naming a different resort → NO with the identified name",
  noNamed.answer === "no" && noNamed.headline.includes("Maui Banyan") && noNamed.headline.includes("not Kamaole Beach Club"));

const noGeneric = communityPhotosCorrectAnswer("Kamaole Beach Club", "fail", {
  identifiedCommunity: "",
  matchesExpected: "no",
  overallStatus: "mismatch",
});
check("mismatch without an identified name → generic NO",
  noGeneric.answer === "no" && noGeneric.headline.includes("do not match"));

// A fail verdict whose identifiedCommunity is an ALIAS of the expected name
// (e.g. an outlier photo failed the folder, not the identification) must not
// claim "X, not X".
const noAlias = communityPhotosCorrectAnswer("Regency at Poipu Kai", "fail", {
  identifiedCommunity: "Poipu Kai Regency",
  matchesExpected: "no",
  overallStatus: "mismatch",
});
check("fail with an alias-equivalent identified name avoids the self-contradicting headline",
  noAlias.answer === "no" && !noAlias.headline.includes("appear to be"));

const unconfirmed = communityPhotosCorrectAnswer("Kamaole Beach Club", "warn", {
  identifiedCommunity: "",
  matchesExpected: "no",
  overallStatus: "unconfirmed",
});
check("unconfirmed (no positive ID, no hard fail) → review",
  unconfirmed.answer === "review" && unconfirmed.headline.toLowerCase().includes("could not"));

check("missing community analysis → review",
  communityPhotosCorrectAnswer("Kamaole Beach Club", "warn", null).answer === "review");

check("empty expected community falls back to a readable phrase",
  communityPhotosCorrectAnswer("", "pass", { identifiedCommunity: "X", matchesExpected: "yes" })
    .headline.includes("the expected community"));

// ── Source assertions: the wiring the above logic assumes ────────────────────

console.log("\nphoto-community-check: source wiring assertions");

const routesSource = readFileSync("server/routes.ts", "utf8");
check("photo-community-check endpoint narrows communityOnly requests via communityOnlyCheckRequest",
  routesSource.includes("communityOnlyCheckRequest(request)"));
check("community-only results are NOT persisted over the dashboard Community QA status",
  routesSource.includes("propertyId != null && !communityOnly"));

const preflightPageSource = readFileSync("client/src/pages/builder-preflight.tsx", "utf8");
check("preflight Community Photos card sends communityOnly: true",
  preflightPageSource.includes("communityOnly: true"));
check("preflight renders the yes/no verdict via communityPhotosCorrectAnswer",
  preflightPageSource.includes("communityPhotosCorrectAnswer("));
check("re-pull button is renamed to 'Find new community photos'",
  preflightPageSource.includes("Find new community photos")
  && !preflightPageSource.includes("Re-pull community photos</>"));

// ── Source assertions: the preflight FULL "Check photo community" report ─────
// The Community Match card runs the Photos-tab full check ({ propertyId } only,
// NEVER communityOnly) and both surfaces render the ONE shared report component
// — if either re-inlines a copy, the reports drift and these lock it.

console.log("\nphoto-community-check: shared full-report wiring assertions");

const reportComponentSource = readFileSync(
  "client/src/components/photo-community-check-report.tsx",
  "utf8",
);
check("shared report renders the same-community roster headline",
  reportComponentSource.includes("Same community?"));
check("shared report renders the source-page check card",
  reportComponentSource.includes("Source page check"));
check("shared report renders bedroom photo coverage (the x/x bedrooms answer)",
  reportComponentSource.includes("Bedroom photo coverage"));
check("shared report renders the cross-folder duplicates card",
  reportComponentSource.includes("Same photo found in more than one folder"));
check("shared report keeps the manual-verify escape hatch",
  reportComponentSource.includes("Mark as verified anyway"));

const builderIndexSource = readFileSync(
  "client/src/components/GuestyListingBuilder/index.tsx",
  "utf8",
);
check("Photos tab renders the SHARED report component",
  builderIndexSource.includes("<PhotoCommunityCheckReport")
  && builderIndexSource.includes('from "@/components/photo-community-check-report"'));
check("Photos tab carries no re-inlined report copy (edit the shared component instead)",
  !builderIndexSource.includes("Bedroom photo coverage"));

check("preflight Community Match button is the Photos-tab 'Check photo community'",
  preflightPageSource.includes("Check photo community"));
check("preflight Community Match posts the FULL check ({ propertyId } only, no communityOnly)",
  preflightPageSource.includes("JSON.stringify({ propertyId: id })"));
check("preflight renders the SHARED report component (bedroom coverage, votes, dupes)",
  preflightPageSource.includes("<PhotoCommunityCheckReport")
  && preflightPageSource.includes('from "@/components/photo-community-check-report"'));
check("preflight carries no re-inlined report copy",
  !preflightPageSource.includes("Bedroom photo coverage"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
