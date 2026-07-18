import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalKeysForExclusion,
  evaluateGalleryNovelty,
  filterSameUnitSerpRows,
  normalizedUnitKey,
  sameUnitCandidateVerdict,
  sameUnitHuntIdentity,
  sameUnitHuntQueries,
  summarizeSameUnitHuntFailure,
  SAME_UNIT_HUNT_MAX_CANDIDATES_DEFAULT,
  SAME_UNIT_HUNT_MIN_NEW_PHOTOS_DEFAULT,
} from "../shared/same-unit-photo-hunt";

// ── Identity anchoring ───────────────────────────────────────────────────────

const condoAnchor = sameUnitHuntIdentity({
  sourceUrl: "https://www.zillow.com/homedetails/2827-Poipu-Rd-APT-201-Koloa-HI-96756/12345_zpid/",
});
assert.ok(condoAnchor, "a Zillow condo URL with a unit token must anchor the hunt");
assert.equal(condoAnchor!.streetRoot, "2827 poipu rd", "street root canonicalizes without the unit token");
assert.equal(normalizedUnitKey(condoAnchor!.unitClaim), "201", "the APT token is the unit claim");
assert.equal(condoAnchor!.sourcePortal, "zillow");

const uniqueHomeAnchor = sameUnitHuntIdentity({
  sourceUrl: "https://www.zillow.com/homedetails/4460-Nehe-Rd-Lihue-HI-96766/555_zpid/",
});
assert.ok(uniqueHomeAnchor, "a unique-address home anchors on its street root alone");
assert.equal(uniqueHomeAnchor!.streetRoot, "4460 nehe rd");
assert.equal(normalizedUnitKey(uniqueHomeAnchor!.unitClaim), "", "no unit token on a single-family home");

assert.equal(sameUnitHuntIdentity({ sourceUrl: "" }), null, "no source URL = nothing to anchor on");
assert.equal(
  sameUnitHuntIdentity({ sourceUrl: "https://example.com/some-page" }),
  null,
  "an unparseable URL (no address, no unit) cannot anchor a same-unit hunt",
);

// Unit-claim normalization: portal slug vs display text vs leading zeros.
assert.equal(normalizedUnitKey("APT-2-301"), normalizedUnitKey("apt 2 0301"));
assert.notEqual(normalizedUnitKey("201"), normalizedUnitKey("301"));

// ── Query surface (reuses PR #1059's buildEquivalentPortalQueries) ──────────

const queries = sameUnitHuntQueries(condoAnchor!, "2827 Poipu Rd");
assert.ok(queries.length >= 5 && queries.length <= 9, `expected 5-9 queries, got ${queries.length}`);
assert.ok(queries.some((q) => q.includes("site:zillow.com")), "zillow leg present");
assert.ok(queries.some((q) => q.includes("site:redfin.com")), "redfin leg present");
assert.ok(queries.some((q) => q.includes("site:realtor.com")), "realtor leg present");
assert.ok(queries.some((q) => q.includes("site:homes.com")), "homes leg present");

// ── SERP candidate filtering (precision: same unit or nothing) ──────────────

const currentSource = "https://www.zillow.com/homedetails/2827-Poipu-Rd-APT-201-Koloa-HI-96756/12345_zpid/";
const excludeKeys = canonicalKeysForExclusion([currentSource]);
const serpRows = [
  // The current source re-surfaced with tracking params → excluded (canonical key).
  { link: `${currentSource}?utm_source=serp`, title: "2827 Poipu Rd APT 201, Koloa, HI 96756 | Zillow" },
  // Cross-portal mirrors of the SAME unit → accepted, sorted before same-portal.
  { link: "https://www.realtor.com/realestateandhomes-detail/2827-Poipu-Rd-Apt-201_Koloa_HI_96756_M1234-56789", title: "2827 Poipu Rd Apt 201, Koloa" },
  { link: "https://www.homes.com/property/2827-poipu-rd-apt-201-koloa-hi/id-4/", title: "2827 Poipu Rd APT 201" },
  // A RE-LISTING of the same unit on the SAME portal (different zpid) → accepted, after cross-portal.
  { link: "https://www.zillow.com/homedetails/2827-Poipu-Rd-APT-201-Koloa-HI-96756/99999_zpid/", title: "2827 Poipu Rd APT 201 (sold)" },
  // A NEIGHBOR unit on the same street → rejected (the old behavior this replaces).
  { link: "https://www.realtor.com/realestateandhomes-detail/2827-Poipu-Rd-Apt-305_Koloa_HI_96756_M9876-54321", title: "2827 Poipu Rd Apt 305, Koloa" },
  // Same street, NO unit claim → unprovable → rejected.
  { link: "https://www.zillow.com/homedetails/2827-Poipu-Rd-Koloa-HI-96756/321_zpid/", title: "2827 Poipu Rd, Koloa" },
  // OTA page → never a candidate (real-estate portals only).
  { link: "https://www.airbnb.com/rooms/12345", title: "Poipu Kai condo unit 201" },
  // Duplicate of an accepted candidate (trailing slash) → deduped silently.
  { link: "https://www.homes.com/property/2827-poipu-rd-apt-201-koloa-hi/id-4", title: "dup" },
];
const filtered = filterSameUnitSerpRows(serpRows, condoAnchor!, excludeKeys);
assert.equal(filtered.candidates.length, 3, `expected 3 same-unit candidates, got ${JSON.stringify(filtered.candidates)}`);
assert.equal(filtered.rejectedExcluded, 1, "current source excluded by canonical key");
assert.equal(filtered.rejectedNotPortal, 1, "OTA link rejected");
assert.equal(filtered.rejectedDifferentUnit, 2, "neighbor unit + unit-less listing rejected");
assert.notEqual(filtered.candidates[0].portal, "zillow", "cross-portal candidates sort before the source's own portal");
assert.equal(filtered.candidates[2].portal, "zillow", "the same-portal re-listing is still a candidate, just last");

// Wrong street root with a matching unit number must NOT pass (same unit number
// in a different building is a different home).
const wrongStreet = filterSameUnitSerpRows(
  [{ link: "https://www.realtor.com/realestateandhomes-detail/500-Kuhio-Hwy-Apt-201_Kapaa_HI_96746_M1-1", title: "500 Kuhio Hwy Apt 201" }],
  condoAnchor!,
  excludeKeys,
);
assert.equal(wrongStreet.candidates.length, 0);
assert.equal(wrongStreet.rejectedDifferentUnit, 1);

// Unique-address home: full street-root equality is the identity.
const uniqueRows = [
  { link: "https://www.redfin.com/HI/Lihue/4460-Nehe-Rd-96766/home/777", title: "4460 Nehe Rd, Lihue" },
  { link: "https://www.redfin.com/HI/Lihue/4470-Nehe-Rd-96766/home/778", title: "4470 Nehe Rd, Lihue" },
  { link: "https://www.redfin.com/HI/Lihue/4460-Nehe-Rd-96766/unit-2/home/779", title: "4460 Nehe Rd Unit 2" },
];
const uniqueFiltered = filterSameUnitSerpRows(uniqueRows, uniqueHomeAnchor!, new Set());
assert.equal(uniqueFiltered.candidates.length, 1, "only the exact-address candidate qualifies");
assert.equal(uniqueFiltered.candidates[0].url, uniqueRows[0].link);
assert.equal(
  uniqueFiltered.rejectedDifferentUnit,
  2,
  "wrong house number and a unit-bearing sub-listing are both different homes",
);

// ── Gallery novelty (dHash) ─────────────────────────────────────────────────

const zeros = "0000000000000000";
const near = "000000000000000f"; // 4 bits away → near-duplicate (≤10)
const eightBits = "00000000000000ff"; // 8 bits → still a near-duplicate
const far = "0000000000ffff00"; // 16 bits → genuinely different photo
const veryFar = "ffffff0000000000"; // 24 bits → genuinely different photo

const novelty = evaluateGalleryNovelty([zeros], [zeros, near, eightBits, far, veryFar, null]);
assert.equal(novelty.total, 6);
assert.equal(novelty.hashed, 5);
assert.equal(novelty.unverified, 1, "an unhashable photo is inconclusive — never new, never duplicate");
assert.equal(novelty.dupCount, 3, "recompressed/resized copies (≤ near-dupe distance) count as duplicates");
assert.equal(novelty.newCount, 2);

const emptyFolder = evaluateGalleryNovelty([], [far, veryFar]);
assert.equal(emptyFolder.newCount, 2, "with no existing photos every hashed photo is new");

// ── Verdicts ────────────────────────────────────────────────────────────────

const verdictOpts = { minPhotos: 3, minNewPhotos: SAME_UNIT_HUNT_MIN_NEW_PHOTOS_DEFAULT };
assert.equal(
  sameUnitCandidateVerdict({ total: 20, hashed: 18, unverified: 2, newCount: 12, dupCount: 6 }, verdictOpts),
  "accept",
);
assert.equal(
  sameUnitCandidateVerdict({ total: 20, hashed: 20, unverified: 0, newCount: 2, dupCount: 18 }, verdictOpts),
  "duplicate-set",
  "a mirror gallery with under-threshold new photos is the same photo set",
);
assert.equal(
  sameUnitCandidateVerdict({ total: 2, hashed: 2, unverified: 0, newCount: 2, dupCount: 0 }, verdictOpts),
  "too-thin",
);
assert.equal(
  sameUnitCandidateVerdict({ total: 20, hashed: 2, unverified: 18, newCount: 2, dupCount: 0 }, verdictOpts),
  "unverifiable",
  "novelty must be PROVEN — a gallery we couldn't hash may not replace a real gallery",
);

// ── Failure summaries (the copy that flips the UI to Find replacement unit) ──

const exhaustedMsg = summarizeSameUnitHuntFailure({
  outcome: "exhausted",
  bedrooms: 2,
  communityName: "Poipu Kai",
  minNewPhotos: 3,
  checked: [
    { url: "a", portal: "realtor", verdict: "duplicate-set", newCount: 2, totalCount: 20 },
    { url: "b", portal: "redfin", verdict: "too-thin", totalCount: 1 },
    { url: "c", portal: "homes", verdict: "scrape-failed" },
  ],
});
assert.ok(exhaustedMsg.includes("Find replacement unit"), "exhausted copy must point at the replacement flow");
assert.ok(exhaustedMsg.includes("same photos already on file"), "duplicate sets are named");
assert.ok(exhaustedMsg.includes("only 2 new photo"), "the best near-miss is reported honestly");
assert.ok(exhaustedMsg.includes("existing gallery was kept"));

const noAnchorMsg = summarizeSameUnitHuntFailure({
  outcome: "no-anchor", bedrooms: 2, communityName: "Poipu Kai", minNewPhotos: 3, checked: [],
});
assert.ok(noAnchorMsg.includes("no saved source listing"));
assert.ok(noAnchorMsg.includes("Find replacement unit"));

const transientMsg = summarizeSameUnitHuntFailure({
  outcome: "search-unavailable", bedrooms: 2, communityName: "Poipu Kai", minNewPhotos: 3, checked: [],
});
assert.ok(transientMsg.includes("temporary"), "a search outage reads as transient, not as advice to replace the unit");
assert.ok(!transientMsg.includes("Find replacement unit"));

const noCandidatesMsg = summarizeSameUnitHuntFailure({
  outcome: "no-candidates", bedrooms: 2, communityName: "Poipu Kai", minNewPhotos: 3, checked: [],
});
assert.ok(noCandidatesMsg.includes("No different photos of this unit exist online"));

// ── Exclusion keys ──────────────────────────────────────────────────────────

const keys = canonicalKeysForExclusion([currentSource, `${currentSource}?x=1`, null, undefined, ""]);
assert.equal(keys.size, 1, "query-string variants of one listing collapse to one exclusion key");

assert.equal(SAME_UNIT_HUNT_MAX_CANDIDATES_DEFAULT, 4);

// ── SOURCE GUARDS (drift locks) ─────────────────────────────────────────────
// The pure logic above only matters if the wiring holds. These lock the seams
// the 2026-07-17 redesign depends on — if one trips, re-read the PR before
// "fixing" the assertion.

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const jobSource = read("server/preflight-background-jobs.ts");
assert.ok(
  jobSource.includes("const sameUnitMode = input.sameUnitOnly === true && sameUnitPhotoHuntEnabled()"),
  "photo-fetch job must gate the same-unit hunt on sameUnitOnly + the kill switch",
);
assert.ok(
  jobSource.includes("const allowDiscoveryFallback = (!replacingExistingPhotos || findNewSource) && !sameUnitMode"),
  "same-unit mode must NEVER fall back to different-listing discovery — that silent substitution is what the redesign removed",
);
assert.ok(
  jobSource.includes("recommendReplaceUnit: hunt.recommendReplaceUnit"),
  "an exhausted hunt must surface recommendReplaceUnit on the failed job",
);
assert.ok(
  jobSource.includes("runSameUnitPhotoHunt({"),
  "the job must run the shared same-unit hunt engine",
);

const huntSource = read("server/same-unit-photo-hunt.ts");
assert.ok(
  huntSource.includes('return failure("search-unavailable", [], false)'),
  "a SERP outage must NOT recommend replacing the unit (transient infra ≠ no photos exist)",
);
assert.ok(
  huntSource.includes('return failure("no-candidates", [], true)')
    && huntSource.includes('return failure("exhausted", checked, true)'),
  "genuinely exhausted hunts DO recommend the replacement flow",
);

const clientSource = read("client/src/pages/builder-preflight.tsx");
assert.ok(
  clientSource.includes("sameUnitOnly: findNewSource"),
  "the Find-new-photos button must request the same-unit hunt",
);
assert.ok(
  clientSource.includes("currentSourceUrl: findNewSource && currentSourceUrl ? currentSourceUrl : undefined"),
  "the button must send the identity anchor (the unit's saved source URL)",
);
assert.ok(
  clientSource.includes("button-find-replacement-unit-") && clientSource.includes("openReplacementFlowForUnit"),
  "a recommendReplaceUnit failure must render the Find-replacement-unit CTA",
);

const sweepSource = read("server/unit-audit-sweep.ts");
assert.ok(
  sweepSource.includes("findNewSource: true") && !sweepSource.includes("sameUnitOnly"),
  "the Unit Audit Sweep's find-new-source rung keeps LEGACY findNewSource semantics (different-listing discovery) — it must not opt into the same-unit hunt",
);

const routesSource = read("server/routes.ts");
assert.ok(
  routesSource.includes("sameUnitOnly: body.sameUnitOnly === true"),
  "the photo-fetch-jobs route must forward sameUnitOnly to the job",
);

console.log("same-unit-photo-hunt tests passed");
