import assert from "node:assert/strict";
import {
  evaluateComboPhotoCommunityGate,
  communityIsRealMismatch,
  isComboPhotoGateInfraWarning,
  planComboBedroomRetry,
  type ComboPhotoGateInput,
} from "../shared/combo-photo-community-gate";

// A fully-clean combo: correct community, both units in it, full bedroom coverage.
const clean: ComboPhotoGateInput = {
  expectedCommunity: "Regency at Poipu Kai",
  warning: undefined,
  community: { matchesExpected: "yes", overallStatus: "verified", identifiedCommunity: "Regency at Poipu Kai" },
  units: [
    { label: "Unit A", sameAsCommunity: "yes", reason: "12/12 interior photos match (unanimous)." },
    { label: "Unit B", sameAsCommunity: "yes", reason: "10/10 interior photos match (unanimous)." },
  ],
  bedroomCoverage: {
    tier: "pass",
    units: [
      { label: "Unit A", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
      { label: "Unit B", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
    ],
  },
};

// 1. Clean combo → publish.
{
  const d = evaluateComboPhotoCommunityGate(clean);
  assert.equal(d.decision, "publish");
  assert.equal(d.infra, false);
  assert.deepEqual(d.reasons, []);
}

// 2. REAL community mismatch (overallStatus "mismatch") → skip.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    community: { matchesExpected: "no", overallStatus: "mismatch", identifiedCommunity: "Poipu Sands" },
  });
  assert.equal(d.decision, "skip");
  assert.equal(d.infra, false);
  assert.match(d.reasons[0], /Poipu Sands/);
}

// 3. matchesExpected "no" but Lens only "unconfirmed" → publish (lenient).
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    community: { matchesExpected: "no", overallStatus: "unconfirmed", identifiedCommunity: "" },
  });
  assert.equal(d.decision, "publish");
}

// 3b. matchesExpected "no" + "likely" → publish (still inconclusive, not a real mismatch).
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    community: { matchesExpected: "no", overallStatus: "likely" },
  });
  assert.equal(d.decision, "publish");
}

// 3c. matchesExpected "no" with NO status (binary no, treated as real) → skip.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    community: { matchesExpected: "no" },
  });
  assert.equal(d.decision, "skip");
}

// 4. Unit STRONG contradiction → skip.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    units: [
      { label: "Unit A", sameAsCommunity: "yes", reason: "match" },
      { label: "Unit B", sameAsCommunity: "no", reason: "Photos show a different resort entirely — wrong community." },
    ],
  });
  assert.equal(d.decision, "skip");
  assert.match(d.reasons[0], /Unit B is not from/);
}

// 5. Unit "no" caused by INSUFFICIENT photos → publish (not a positive finding).
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    units: [
      { label: "Unit A", sameAsCommunity: "yes", reason: "match" },
      { label: "Unit B", sameAsCommunity: "no", reason: "Only 3 interior photos checked — need 5+ to confirm same community." },
    ],
  });
  assert.equal(d.decision, "publish");
}

// 5b. Unit "no" with a weak (non-contradiction) reason → publish (conservative).
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    units: [
      { label: "Unit A", sameAsCommunity: "yes", reason: "match" },
      { label: "Unit B", sameAsCommunity: "no", reason: "One interior photo did not clearly match the community profile." },
    ],
  });
  assert.equal(d.decision, "publish");
}

// 6. SHORT bedroom count (a 1BR sourced for a 3BR slot) → skip, with the count.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
        { label: "Unit B", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(d.decision, "skip");
  assert.match(d.reasons[0], /Unit B shows only 1\/3 bedrooms/);
}

// 6a-i. bedroomCoverageReliable=false suppresses a SHORT-count skip → publish.
//   Root cause 2026-07-07: the unit photos' labels are written asynchronously, so
//   the bedroom engine reads 0/N before they land. The caller sets this false until
//   it has waited for labeling, so a 0/N caused by unwritten labels never deletes a
//   draft. Same input as test 6 (a genuine 1/3), but unreliable → do not skip.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: false,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
        { label: "Unit B", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(d.decision, "publish");
  assert.deepEqual(d.reasons, []);
}

// 6a-ii. The EXACT live failure signature — every unit 0/N with unreliable labels
//   → publish (this is what deleted Wavecrest 2BR+2BR / Molokai Shores 1BR+2BR).
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: false,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (2BR)", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 2 },
        { label: "Unit B (2BR)", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 2 },
      ],
    },
  });
  assert.equal(d.decision, "publish");
  assert.deepEqual(d.reasons, []);
}

// 6a-iii. bedroomCoverageReliable=true (labels ready) keeps the real short-count
//   skip — the gate still catches a 1BR sourced for a 3BR slot once labels exist.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
        { label: "Unit B", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(d.decision, "skip");
  assert.match(d.reasons[0], /Unit B shows only 1\/3 bedrooms/);
}

// 6a-iv. bedroomCoverageReliable=false must NOT mask a REAL community mismatch —
//   the community + unit-vision legs read the images directly (no labels needed),
//   so they still skip even when bedroom coverage is untrusted.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: false,
    community: { matchesExpected: "no", overallStatus: "mismatch", identifiedCommunity: "Poipu Sands" },
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 2 },
        { label: "Unit B", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 2 },
      ],
    },
  });
  assert.equal(d.decision, "skip");
  assert.equal(d.reasons.length, 1);
  assert.match(d.reasons[0], /Poipu Sands/);
}

// 6c-i. TOLERANCE (operator decision 2026-07-08): a unit short by exactly ONE
//   bedroom (2 of 3) PUBLISHES — vision under-counts a genuine unit by one, which
//   was skipping nearly every resort. matchesListing is "no" (2 < 3) but the
//   1-bedroom shortfall is tolerated. This is the Maui Hill / Kamaole Sands fix.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (3BR)", matchesListing: "no", bedroomsFound: 2, expectedBedrooms: 3 },
        { label: "Unit B (3BR)", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(d.decision, "publish");
  assert.deepEqual(d.reasons, []);
}

// 6c-ii. BOTH units short by one (2/3 each) → publish. Nearly every skipped
//   resort in the screenshot was this shape.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (3BR)", matchesListing: "no", bedroomsFound: 2, expectedBedrooms: 3 },
        { label: "Unit B (3BR)", matchesListing: "no", bedroomsFound: 2, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(d.decision, "publish");
  assert.deepEqual(d.reasons, []);
}

// 6c-iii. MIXED (the Koa Resort case): Unit A 2/3 (tolerated) but Unit B 1/3
//   (short by two) → skip, and ONLY Unit B is named.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (3BR)", matchesListing: "no", bedroomsFound: 2, expectedBedrooms: 3 },
        { label: "Unit B (3BR)", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(d.decision, "skip");
  assert.equal(d.reasons.length, 1);
  assert.match(d.reasons[0], /Unit B \(3BR\) shows only 1\/3 bedrooms/);
}

// 6c-iv. The tolerance is ONE bedroom, not a ratio: a 2/4 unit is short by two
//   and still skips.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A", matchesListing: "no", bedroomsFound: 2, expectedBedrooms: 4 },
        { label: "Unit B", matchesListing: "yes", bedroomsFound: 4, expectedBedrooms: 4 },
      ],
    },
  });
  assert.equal(d.decision, "skip");
  assert.match(d.reasons[0], /Unit A shows only 2\/4 bedrooms/);
}

// 6c-v. 4BR COMBO (2BR + 2BR): a unit showing 1 of its 2 bedrooms PUBLISHES —
//   operator rule 2026-07-08 "for a 4 bedroom combo drop the requirement to just
//   1 out of 2 bedrooms" (same shortfall-of-one tolerance, expressed for 2BR).
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (2BR)", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 2 },
        { label: "Unit B (2BR)", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 2 },
      ],
    },
  });
  assert.equal(d.decision, "publish");
  assert.deepEqual(d.reasons, []);
}

// 6c-vi. …but a 2BR unit showing 0 of 2 (short by two) still skips.
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (2BR)", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 2 },
        { label: "Unit B (2BR)", matchesListing: "yes", bedroomsFound: 2, expectedBedrooms: 2 },
      ],
    },
  });
  assert.equal(d.decision, "skip");
  assert.match(d.reasons[0], /Unit A \(2BR\) shows only 0\/2 bedrooms/);
}

// 6b. Bedroom coverage "n/a" (unknown expected) → publish (can't confirm count).
{
  const d = evaluateComboPhotoCommunityGate({
    ...clean,
    bedroomCoverage: {
      tier: "warn",
      units: [
        { label: "Unit A", matchesListing: "n/a", bedroomsFound: 2, expectedBedrooms: null },
        { label: "Unit B", matchesListing: "n/a", bedroomsFound: 2, expectedBedrooms: null },
      ],
    },
  });
  assert.equal(d.decision, "publish");
}

// 7. Bed-TYPE inventory mismatch is NEVER modeled here — a unit that is fine on
//    community + count publishes even if its queen/sleeper-sofa label is wrong.
//    (The caller deliberately does not pass expectedBedInventory; this asserts the
//    gate has no bed-type lever at all.)
{
  const d = evaluateComboPhotoCommunityGate(clean);
  assert.equal(d.decision, "publish");
}

// 8. Each infra sentinel → publish + infra=true (fail-open).
for (const w of ["no-photos", "SEARCHAPI_API_KEY not configured", "ANTHROPIC_API_KEY not configured"]) {
  const d = evaluateComboPhotoCommunityGate({
    expectedCommunity: "Regency at Poipu Kai",
    warning: w,
    community: null,
    units: [],
    bedroomCoverage: null,
  });
  assert.equal(d.decision, "publish", `infra warning ${w} should publish`);
  assert.equal(d.infra, true, `infra warning ${w} should mark infra`);
  assert.deepEqual(d.reasons, []);
}

// 9. Multiple positive findings → skip, all reasons surfaced.
{
  const d = evaluateComboPhotoCommunityGate({
    expectedCommunity: "Regency at Poipu Kai",
    warning: undefined,
    community: { matchesExpected: "no", overallStatus: "mismatch", identifiedCommunity: "Kuhio Shores" },
    units: [
      { label: "Unit A", sameAsCommunity: "no", reason: "Different building / wrong community signage." },
      { label: "Unit B", sameAsCommunity: "yes", reason: "match" },
    ],
    bedroomCoverage: {
      tier: "fail",
      // 1/3 is short by TWO bedrooms (beyond the 1-bedroom tolerance) → still fires.
      units: [
        { label: "Unit A", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
        { label: "Unit B", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(d.decision, "skip");
  assert.equal(d.reasons.length, 3);
}

// 10. communityIsRealMismatch unit helper.
assert.equal(communityIsRealMismatch(null), false);
assert.equal(communityIsRealMismatch({ matchesExpected: "yes", overallStatus: "verified" }), false);
assert.equal(communityIsRealMismatch({ matchesExpected: "no", overallStatus: "unconfirmed" }), false);
assert.equal(communityIsRealMismatch({ matchesExpected: "no", overallStatus: "likely" }), false);
assert.equal(communityIsRealMismatch({ matchesExpected: "no", overallStatus: "mismatch" }), true);
assert.equal(communityIsRealMismatch({ matchesExpected: "yes", overallStatus: "mismatch" }), true);
assert.equal(communityIsRealMismatch({ matchesExpected: "no" }), true);

// 11. isComboPhotoGateInfraWarning.
assert.equal(isComboPhotoGateInfraWarning(undefined), false);
assert.equal(isComboPhotoGateInfraWarning(""), false);
assert.equal(isComboPhotoGateInfraWarning("no-photos"), true);
assert.equal(isComboPhotoGateInfraWarning("SEARCHAPI_API_KEY not configured"), true);
// A partial-failure warning (free text) is NOT infra — the predicate handles it
// via its null/contradiction checks, not by failing open.
assert.equal(isComboPhotoGateInfraWarning("Unit B verification failed: vision timed out"), false);

// 12. Defensive guard: a "mismatch" verdict whose identifiedCommunity IS the
// expected community must NOT self-contradict ("looks like X, not X") — publish.
// (Kanaloa at Kona, 2026-06-26: the dHash pre-screen flipped a positive vision ID
// to "mismatch"; the engine fix stops the flip, this gate guard is the backstop.)
{
  const d = evaluateComboPhotoCommunityGate({
    expectedCommunity: "Kanaloa at Kona",
    warning: null,
    community: { matchesExpected: "no", overallStatus: "mismatch", identifiedCommunity: "Kanaloa at Kona" },
    units: [],
    bedroomCoverage: null,
  });
  assert.equal(d.decision, "publish");
  assert.equal(d.reasons.length, 0);
}
// Subset match also counts as "same" (identified "Kanaloa" ⊂ expected "Kanaloa at Kona").
{
  const d = evaluateComboPhotoCommunityGate({
    expectedCommunity: "Kanaloa at Kona",
    warning: null,
    community: { matchesExpected: "no", overallStatus: "mismatch", identifiedCommunity: "Kanaloa" },
    units: [],
    bedroomCoverage: null,
  });
  assert.equal(d.decision, "publish");
}
// A genuinely DIFFERENT identified community still skips (real mismatch preserved).
{
  const d = evaluateComboPhotoCommunityGate({
    expectedCommunity: "Kanaloa at Kona",
    warning: null,
    community: { matchesExpected: "no", overallStatus: "mismatch", identifiedCommunity: "Poipu Sands" },
    units: [],
    bedroomCoverage: null,
  });
  assert.equal(d.decision, "skip");
  assert.equal(d.reasons.length, 1);
}

// ── planComboBedroomRetry: "move on to another opportunity unit" (2026-07-08) ──
// When the ONLY reason to skip is bedroom-photo coverage, the bulk queue re-sources
// the failing unit(s) from another for-sale candidate instead of skipping the
// resort. planComboBedroomRetry is the pure decision that drives that loop.

// P1. A clean combo is not retryable (nothing to fix).
{
  const p = planComboBedroomRetry(clean);
  assert.equal(p.retryable, false);
  assert.deepEqual(p.units, []);
}

// P2. A single bedroom-short unit (Unit B 1/3), reliable labels → retry Unit B.
{
  const p = planComboBedroomRetry({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (3BR)", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
        { label: "Unit B (3BR)", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(p.retryable, true);
  assert.equal(p.units.length, 1);
  assert.equal(p.units[0].slot, "unit2");
  assert.equal(p.units[0].expectedBedrooms, 3);
  assert.equal(p.units[0].bedroomsFound, 1);
}

// P3. BOTH units short → both slots surfaced, mapped A→unit1, B→unit2.
{
  const p = planComboBedroomRetry({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (2BR)", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 2 },
        { label: "Unit B (3BR)", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(p.retryable, true);
  assert.deepEqual(p.units.map((u) => u.slot), ["unit1", "unit2"]);
}

// P4. A tolerated shortfall (2/3) is NOT short → not retryable (it publishes).
{
  const p = planComboBedroomRetry({
    ...clean,
    bedroomCoverageReliable: true,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (3BR)", matchesListing: "no", bedroomsFound: 2, expectedBedrooms: 3 },
        { label: "Unit B (3BR)", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(p.retryable, false);
}

// P5. Bedroom-short + a REAL community mismatch → NOT retryable (re-sourcing a
//   unit can't fix a wrong community folder; keep the plain skip).
{
  const p = planComboBedroomRetry({
    ...clean,
    bedroomCoverageReliable: true,
    community: { matchesExpected: "no", overallStatus: "mismatch", identifiedCommunity: "Poipu Sands" },
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (3BR)", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
        { label: "Unit B (3BR)", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(p.retryable, false);
  // The short unit is still reported (so the caller can log it), but retry is off.
  assert.equal(p.units.length, 1);
}

// P6. Bedroom-short + a strong unit contradiction → NOT retryable.
{
  const p = planComboBedroomRetry({
    ...clean,
    bedroomCoverageReliable: true,
    units: [
      { label: "Unit A", sameAsCommunity: "yes", reason: "match" },
      { label: "Unit B", sameAsCommunity: "no", reason: "Photos show a different resort entirely — wrong community." },
    ],
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (3BR)", matchesListing: "no", bedroomsFound: 1, expectedBedrooms: 3 },
        { label: "Unit B (3BR)", matchesListing: "yes", bedroomsFound: 3, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(p.retryable, false);
}

// P7. Unreliable labels (0/N from unwritten labels) → not retryable (infra, publishes).
{
  const p = planComboBedroomRetry({
    ...clean,
    bedroomCoverageReliable: false,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A (3BR)", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 3 },
        { label: "Unit B (3BR)", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 3 },
      ],
    },
  });
  assert.equal(p.retryable, false);
  assert.deepEqual(p.units, []);
}

// P8. An infra warning is never a skip → never retryable.
{
  const p = planComboBedroomRetry({
    expectedCommunity: "Regency at Poipu Kai",
    warning: "no-photos",
    community: null,
    units: [],
    bedroomCoverage: null,
  });
  assert.equal(p.retryable, false);
}

// ── Source guard: the bulk-combo gate must feed the check HYDRATED groups ─────
// Regression (root-caused 2026-07-06): the gate ran the photo-community check on
// FOLDER-ONLY groups (no captions/categories). The bedroom-coverage engine picks
// candidate bedroom photos by caption/category, so with none it found 0/N
// bedrooms for EVERY unit and this gate deleted every fresh combo draft — nothing
// reached the dashboard. The fix builds groups via
// buildPhotoCommunityCheckRequestForProperty(-draftId) (photo_labels-hydrated),
// the same path the pricing-tab check uses. Lock the fix + the absence of the old
// caption-less folder-only unit-group literal inside the gate step.
{
  const { readFileSync } = await import("node:fs");
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const stepIdx = routes.indexOf('"Verifying photo community"');
  assert.ok(stepIdx > 0, "combo photo-community gate step anchor present");
  const region = routes.slice(stepIdx, stepIdx + 6000);
  assert.ok(
    region.includes("buildPhotoCommunityCheckRequestForProperty(-draftId)"),
    "gate builds hydrated groups via buildPhotoCommunityCheckRequestForProperty(-draftId)",
  );
  assert.ok(
    region.includes("evaluateComboPhotoCommunityGate("),
    "gate still evaluates the decision from the check result",
  );
  assert.ok(
    !/folder:\s*`draft-\$\{draftId\}-unit-a`/.test(region),
    "gate no longer passes a caption-less folder-only Unit A group",
  );
  // Root-caused 2026-07-07: hydrated groups are not enough — the async auto-labeler
  // hadn't WRITTEN the photo_labels when the gate ran (~65ms after persist), so the
  // hydrated groups still carried no captions/categories → 0/N → every fresh draft
  // deleted. The gate must WAIT for labeling and pass the reliability flag through.
  assert.ok(
    region.includes("waitForFolderPhotoLabels("),
    "gate waits for the async auto-labeler before building the check groups",
  );
  assert.ok(
    /bedroomCoverageReliable:\s*allLabelsReady/.test(region),
    "gate passes bedroomCoverageReliable so an unlabeled 0/N cannot skip",
  );
}

// Source guard: waitForFolderPhotoLabels must exist and be driven by the async
// (fire-and-forget) queueMissingPhotoLabels — the whole reason the wait is needed.
{
  const { readFileSync } = await import("node:fs");
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  assert.ok(
    routes.includes("const waitForFolderPhotoLabels = async"),
    "waitForFolderPhotoLabels helper present",
  );
  const qIdx = routes.indexOf("const queueMissingPhotoLabels = async");
  assert.ok(qIdx > 0, "queueMissingPhotoLabels present");
  const qRegion = routes.slice(qIdx, qIdx + 2600);
  // It returns immediately after kicking a background `void (async () => …)()` loop
  // — i.e. it does NOT await the labeling. This is exactly why the gate must wait.
  assert.ok(
    /void \(async \(\) =>/.test(qRegion),
    "queueMissingPhotoLabels labels in a fire-and-forget background loop",
  );
}

console.log("combo-photo-community-gate suite passed");
