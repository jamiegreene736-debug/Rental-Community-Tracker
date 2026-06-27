import assert from "node:assert/strict";
import {
  evaluateComboPhotoCommunityGate,
  communityIsRealMismatch,
  isComboPhotoGateInfraWarning,
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
      units: [
        { label: "Unit A", matchesListing: "no", bedroomsFound: 2, expectedBedrooms: 3 },
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

console.log("combo-photo-community-gate suite passed");
