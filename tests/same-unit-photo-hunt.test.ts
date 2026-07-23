import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalKeysForExclusion,
  chooseSameUnitHuntAnchor,
  evaluateGalleryNovelty,
  filterSameUnitSerpRows,
  hawaiiInlineUnitClaim,
  normalizedUnitKey,
  sameUnitCandidateVerdict,
  sameUnitHuntExhaustionProven,
  sameUnitHuntIdentity,
  sameUnitHuntQueries,
  sameUnitHuntSearchComplete,
  sameUnitSourceUrlsMatch,
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
// A unit token WITHOUT a parseable street root must NOT anchor: a bare unit
// number is exactly how a different building's same-numbered unit would pass.
assert.equal(
  sameUnitHuntIdentity({ sourceUrl: "https://www.zillow.com/homedetails/Building-A-APT-201-Koloa/1_zpid/" }),
  null,
  "unit-claim-only anchors are rejected — no street root, no hunt",
);

// Cross-portal sources must preserve BOTH the street and unit identity. This
// is the production Unit 920 guard: a stale Unit 720 source at the same
// building may never become the anchor or be persisted into Unit 920's folder.
const poipu920 = "https://www.zillow.com/homedetails/1831-Poipu-Rd-APT-920-Koloa-HI-96756/80157293_zpid/";
assert.equal(
  sameUnitSourceUrlsMatch(
    poipu920,
    "https://www.homes.com/property/1831-poipu-rd-koloa-hi-unit-920/example/",
  ),
  true,
  "the exact same unit on another portal is allowed",
);
assert.equal(
  sameUnitSourceUrlsMatch(
    poipu920,
    "https://www.homes.com/property/1831-poipu-rd-koloa-hi-unit-720/gy46glh43cckm/",
  ),
  false,
  "a neighbor at the same street is rejected",
);
assert.equal(
  sameUnitSourceUrlsMatch(
    poipu920,
    "https://www.redfin.com/HI/Koloa/1831-Poipu-Rd-96756/home/123",
  ),
  false,
  "a unit-less same-building page cannot prove the requested condo",
);
assert.equal(
  sameUnitSourceUrlsMatch(
    poipu920,
    "https://www.redfin.com/HI/Koloa/1775-Poipu-Rd-96756/unit-920/home/123",
  ),
  false,
  "the same unit number at another street is rejected",
);
assert.equal(
  sameUnitSourceUrlsMatch(
    "https://www.zillow.com/homedetails/4460-Nehe-Rd-Lihue-HI-96766/555_zpid/",
    "https://www.redfin.com/HI/Lihue/4460-Nehe-Rd-96766/home/777",
    { allowUnitlessStreetMatch: true },
  ),
  true,
  "positively identified unique-address homes can match cross-portal on exact street root",
);
assert.equal(
  sameUnitSourceUrlsMatch(
    "https://www.zillow.com/homedetails/1831-Poipu-Rd-Koloa-HI-96756/80157293_zpid/",
    "https://www.redfin.com/HI/Koloa/1831-Poipu-Rd-96756/home/123",
  ),
  false,
  "unit-less same-street URLs fail closed without positive unique-home evidence",
);
assert.equal(
  sameUnitSourceUrlsMatch(
    "https://www.zillow.com/homedetails/1831-Poipu-Rd-Koloa-HI-96756/80157293_zpid/",
    "https://www.homes.com/property/1831-poipu-rd-koloa-hi-unit-720/example/",
    { expectedUnitClaim: "Unit 920" },
  ),
  false,
  "a committed unit claim rejects a different unit even when the authority URL is opaque",
);
assert.equal(
  sameUnitSourceUrlsMatch(
    "https://www.zillow.com/homedetails/4460-Nehe-Rd-Lihue-HI-96766/555_zpid/",
    "https://www.redfin.com/HI/Lihue/4460-Nehe-Rd-96766/unit-5/home/777",
  ),
  false,
  "a unique-address home does not match a subunit at that address",
);
assert.equal(
  sameUnitSourceUrlsMatch(`${poipu920}?utm_source=test`, `${poipu920}?utm_source=other`),
  true,
  "tracking parameters do not split the same canonical listing",
);
assert.equal(
  sameUnitSourceUrlsMatch(poipu920, "https://example.com/listing/opaque"),
  false,
  "an unparseable different URL fails closed",
);

assert.equal(
  chooseSameUnitHuntAnchor({
    replacementFolder: true,
    authorityAvailable: false,
    folderUrl: null,
    clientUrl: "https://www.homes.com/property/1831-poipu-rd-koloa-hi-unit-720/stale/",
  }),
  null,
  "a replacement folder never falls back to a stale client anchor when committed authority is unavailable",
);
assert.equal(
  chooseSameUnitHuntAnchor({
    replacementFolder: false,
    authorityAvailable: false,
    folderUrl: null,
    clientUrl: poipu920,
  }),
  poipu920,
  "ordinary folders retain the client fallback",
);

// Hawaii Hwy addresses parse (the 57-091 Kamehameha Hwy class): a neighboring
// association's same-numbered unit must be rejected on the street root.
const hwyAnchor = sameUnitHuntIdentity({
  sourceUrl: "https://www.zillow.com/homedetails/57-091-Kamehameha-Hwy-APT-106-Kahuku-HI-96731/2_zpid/",
});
assert.ok(hwyAnchor, "Hwy street suffix must parse (Turtle Bay / Kuilima class)");
assert.equal(hwyAnchor!.streetRoot, "57 091 kamehameha hwy");
assert.equal(normalizedUnitKey(hwyAnchor!.unitClaim), "106");
const hwyNeighbors = filterSameUnitSerpRows(
  [
    { link: "https://www.zillow.com/homedetails/57-101-Kamehameha-Hwy-APT-106-Kahuku-HI-96731/3_zpid/", title: "57-101 Kamehameha Hwy APT 106" },
    { link: "https://www.redfin.com/HI/Kahuku/57-091-Kamehameha-Hwy-96731/unit-106/home/4", title: "57-091 Kamehameha Hwy #106" },
  ],
  hwyAnchor!,
  new Set(),
);
assert.equal(hwyNeighbors.candidates.length, 1, "same unit number in the NEIGHBORING building must not pass");
assert.equal(hwyNeighbors.candidates[0].portal, "redfin");
assert.equal(hwyNeighbors.rejectedDifferentUnit, 1);

// Hawaii inline-unit slugs ("92-1070-1-Olani-St" = unit 1): neighbors must not
// collapse into one unit-less identity.
assert.equal(hawaiiInlineUnitClaim("92 1070 1 Olani St"), "1");
assert.equal(hawaiiInlineUnitClaim("2827 Poipu Rd Apt 201"), null);
assert.equal(hawaiiInlineUnitClaim("57 091 Kamehameha Hwy"), null, "district-lot with no inline unit stays unit-less");
const inlineAnchor = sameUnitHuntIdentity({
  sourceUrl: "https://www.zillow.com/homedetails/92-1070-1-Olani-St-Kapolei-HI-96707/5_zpid/",
});
assert.ok(inlineAnchor);
assert.equal(inlineAnchor!.streetRoot, "92 1070 olani st");
assert.equal(normalizedUnitKey(inlineAnchor!.unitClaim), "1", "the inline token IS the unit claim");
const inlineFiltered = filterSameUnitSerpRows(
  [
    { link: "https://www.zillow.com/homedetails/92-1070-2-Olani-St-Kapolei-HI-96707/6_zpid/", title: "92-1070-2 Olani St" },
    { link: "https://www.redfin.com/HI/Kapolei/92-1070-Olani-St-96707/unit-1/home/7", title: "92-1070 Olani St Unit 1" },
  ],
  inlineAnchor!,
  new Set(),
);
assert.equal(inlineFiltered.candidates.length, 1, "the NEIGHBOR inline unit must be rejected, the true mirror kept");
assert.equal(inlineFiltered.candidates[0].portal, "redfin");

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

// SERP snippet junk ("Similar homes: … Apt 5") must NOT inject a unit claim
// onto a unit-less exact-address mirror — the candidate's unit comes from its
// URL slug + parsed address only.
const junkSnippet = filterSameUnitSerpRows(
  [{
    link: "https://www.redfin.com/HI/Lihue/4460-Nehe-Rd-96766/home/777",
    title: "4460 Nehe Rd, Lihue",
    snippet: "Similar homes nearby: 123 Aloha St Apt 5 · cozy studio",
  }],
  uniqueHomeAnchor!,
  new Set(),
);
assert.equal(junkSnippet.candidates.length, 1, "snippet junk must not reject the true mirror");

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

// ── Exhaustion / search-completeness honesty ────────────────────────────────

assert.equal(sameUnitHuntSearchComplete({ attempted: 9, responded: 9 }), true);
assert.equal(sameUnitHuntSearchComplete({ attempted: 9, responded: 1 }), false, "a partial SERP outage is NOT a complete search");
assert.equal(sameUnitHuntSearchComplete({ attempted: 0, responded: 0 }), false);

assert.equal(
  sameUnitHuntExhaustionProven([
    { url: "a", portal: "realtor", verdict: "duplicate-set" },
    { url: "b", portal: "redfin", verdict: "too-thin" },
  ]),
  true,
  "every candidate substantively judged = exhaustion proven",
);
assert.equal(
  sameUnitHuntExhaustionProven([
    { url: "a", portal: "realtor", verdict: "duplicate-set" },
    { url: "c", portal: "homes", verdict: "scrape-failed" },
  ]),
  false,
  "a candidate lost to scrape infra proves nothing — never recommend replacement off it",
);
assert.equal(
  sameUnitHuntExhaustionProven([{ url: "a", portal: "zillow", verdict: "unverifiable" }]),
  false,
);
assert.equal(sameUnitHuntExhaustionProven([]), false);

// ── Failure summaries (the copy that flips the UI to Find replacement unit) ──

const provenExhaustedMsg = summarizeSameUnitHuntFailure({
  outcome: "exhausted",
  bedrooms: 2,
  communityName: "Poipu Kai",
  minNewPhotos: 3,
  checked: [
    { url: "a", portal: "realtor", verdict: "duplicate-set", newCount: 2, totalCount: 20 },
    { url: "b", portal: "redfin", verdict: "too-thin", totalCount: 1 },
  ],
});
assert.ok(provenExhaustedMsg.includes("Find replacement unit"), "PROVEN exhaustion points at the replacement flow");
assert.ok(provenExhaustedMsg.includes("same photos already on file"), "duplicate sets are named");
assert.ok(provenExhaustedMsg.includes("only 2 new photo"), "the best near-miss is reported honestly");
assert.ok(provenExhaustedMsg.includes("existing gallery was kept"));

const unprovenExhaustedMsg = summarizeSameUnitHuntFailure({
  outcome: "exhausted",
  bedrooms: 2,
  communityName: "Poipu Kai",
  minNewPhotos: 3,
  checked: [
    { url: "a", portal: "realtor", verdict: "duplicate-set", newCount: 1, totalCount: 20 },
    { url: "c", portal: "homes", verdict: "scrape-failed" },
  ],
});
assert.ok(!unprovenExhaustedMsg.includes("Find replacement unit"), "infra-tainted exhaustion must NOT push a replacement");
assert.ok(unprovenExhaustedMsg.includes("try again"), "infra-tainted exhaustion reads as retryable");

const noAnchorMsg = summarizeSameUnitHuntFailure({
  outcome: "no-anchor", bedrooms: 2, communityName: "Poipu Kai", minNewPhotos: 3, checked: [], anchor: "missing",
});
assert.ok(noAnchorMsg.includes("no saved source listing"));
assert.ok(noAnchorMsg.includes("Find replacement unit"));

const unparseableAnchorMsg = summarizeSameUnitHuntFailure({
  outcome: "no-anchor", bedrooms: 2, communityName: "Poipu Kai", minNewPhotos: 3, checked: [], anchor: "unparseable",
});
assert.ok(
  !unparseableAnchorMsg.includes("no saved source listing") && unparseableAnchorMsg.includes("parseable"),
  "a source that EXISTS but can't be parsed must not be reported as missing",
);

const transientMsg = summarizeSameUnitHuntFailure({
  outcome: "search-unavailable", bedrooms: 2, communityName: "Poipu Kai", minNewPhotos: 3, checked: [],
});
assert.ok(transientMsg.includes("temporary"), "a search outage reads as transient, not as advice to replace the unit");
assert.ok(!transientMsg.includes("Find replacement unit"));

const noCandidatesMsg = summarizeSameUnitHuntFailure({
  outcome: "no-candidates", bedrooms: 2, communityName: "Poipu Kai", minNewPhotos: 3, checked: [],
});
assert.ok(noCandidatesMsg.includes("No different photos of this unit exist online"));

const partialNoCandidatesMsg = summarizeSameUnitHuntFailure({
  outcome: "no-candidates", bedrooms: 2, communityName: "Poipu Kai", minNewPhotos: 3, checked: [], searchIncomplete: true,
});
assert.ok(
  !partialNoCandidatesMsg.includes("Find replacement unit") && partialNoCandidatesMsg.includes("temporary"),
  "no-candidates off a PARTIAL sweep must read as transient",
);

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
  huntSource.includes('failure("no-candidates", [], !searchIncomplete'),
  "no-candidates only recommends replacement off a COMPLETE SERP sweep",
);
assert.ok(
  huntSource.includes("const proven = !searchIncomplete && sameUnitHuntExhaustionProven(checked)")
    && huntSource.includes('failure("exhausted", checked, proven'),
  "exhaustion must be PROVEN (complete sweep + every candidate substantively judged) before recommending replacement",
);
assert.ok(
  huntSource.includes("readFolderSourceUrl(folder, {"),
  "the hunt must fall back to the folder's _source.json anchor when the client-sent source URL is missing (transport blips must not become false no-anchor verdicts)",
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
assert.ok(
  clientSource.includes("recommendReplaceUnit && !unitOverrides[unit.id]")
    && clientSource.includes("dismissPhotoFetchReceipt(oldUnitId)"),
  "the CTA and its sticky receipt must clear once the unit is actually replaced",
);
assert.ok(
  clientSource.includes("key={targetUnit.id}"),
  "retargeting UnitReplacementFlow must remount it — stale unit-scoped state could commit against the wrong unit",
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
assert.ok(
  huntSource.includes("replacementPhotoFolderRef(folder)")
    && huntSource.includes("authoritativeReplacementPhotoSource(folder)")
    && huntSource.includes("replacementAuthority: folderAuthority")
    && huntSource.includes("chooseSameUnitHuntAnchor({")
    && huntSource.includes('failure("no-anchor", [], false'),
  "replacement-folder hunts must reconcile even a nonempty client anchor against the committed swap",
);
assert.ok(
  routesSource.includes("authoritativeReplacementPhotoSource(folder)")
    && routesSource.includes("!sameUnitSourceUrlsMatch(authoritativeSwapUrl, sourceUrl, {")
    && routesSource.includes("expectedUnitClaim: authoritativeSwap?.unitClaim")
    && routesSource.includes("identityMismatch: true"),
  "rescrape must reject an explicit source that contradicts the committed replacement identity",
);

console.log("same-unit-photo-hunt tests passed");
