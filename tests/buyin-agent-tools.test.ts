import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { toolPropertyUnitConfig, toolEvaluateProfit, toolCheckWalkability, toolNearbyTowns } =
  await import("../server/buyin-agent-tools");
const { evaluateComboProfit } = await import("../shared/buy-in-profit");
const { PROPERTY_UNIT_CONFIGS } = await import("../shared/property-units");

console.log("buyin-agent-tools suite");

// ── property-unit-config matches the in-process map ──────────────────────────
{
  const ids = Object.keys(PROPERTY_UNIT_CONFIGS).map(Number);
  assert.ok(ids.length > 0, "there is at least one configured property");
  const id = ids[0];
  assert.deepEqual(toolPropertyUnitConfig(id), PROPERTY_UNIT_CONFIGS[id], "config matches the map");
  assert.equal(toolPropertyUnitConfig(-99999), null, "unknown property → null");
  assert.equal(toolPropertyUnitConfig(NaN), null, "non-finite id → null");
  console.log("  ✓ property-unit-config returns the in-process config / null");
}

// ── evaluate-profit matches evaluateComboProfit exactly (the gate the agent reads) ─
{
  const cases = [
    { expectedRevenue: 5000, existingCost: 0, comboCost: 3000 },
    { expectedRevenue: 5000, existingCost: 0, comboCost: 5200 }, // -200 → reject
    { expectedRevenue: 9000, existingCost: 0, comboCost: 9100 }, // -100 → exactly the cap
    { expectedRevenue: 0, existingCost: 0, comboCost: 9999 }, // gate disabled
  ];
  for (const c of cases) {
    assert.deepEqual(
      toolEvaluateProfit(c),
      evaluateComboProfit({ ...c, flat: 100, pct: 0 }),
      `evaluate-profit matches for ${JSON.stringify(c)}`,
    );
  }
  console.log("  ✓ evaluate-profit == evaluateComboProfit with the $100 flat gate");
}

// ── check-walkability: coords are authoritative; single pick is trivially ok ──
{
  // single pick → trivially walkable, unknown source
  const single = toolCheckWalkability([{ url: "a", title: "Unit A", lat: 21.88, lng: -159.45 }]);
  assert.equal(single.ok, true);
  assert.equal(single.walkSource, "unknown");

  // two very-close coords (~55m apart) → walkable via coords
  const close = toolCheckWalkability([
    { url: "a", title: "Unit A", lat: 21.8800, lng: -159.4500 },
    { url: "b", title: "Unit B", lat: 21.8805, lng: -159.4500 },
  ]);
  assert.equal(close.ok, true, "close coords are walkable");
  assert.equal(close.walkSource, "coords");
  assert.ok((close.walkMinutes ?? 99) < 10, "walk minutes under the cap");

  // two far-apart coords → NOT walkable
  const far = toolCheckWalkability([
    { url: "a", title: "Unit A", lat: 21.88, lng: -159.45 },
    { url: "b", title: "Unit B", lat: 22.20, lng: -159.30 },
  ]);
  assert.equal(far.ok, false, "far coords are not walkable");
  assert.equal(far.walkSource, "coords");

  // no coords, unrelated generic titles → not walkable, unknown source
  const unrelated = toolCheckWalkability([
    { url: "a", title: "Condo in Koloa" },
    { url: "b", title: "Apartment in Lihue" },
  ]);
  assert.equal(unrelated.ok, false);
  assert.equal(unrelated.walkSource, "unknown");
  console.log("  ✓ check-walkability: coords authoritative, single ok, unrelated rejected");
}

// ── nearby-towns: unknown community → [] (offline-safe degrade) ───────────────
{
  const towns = await toolNearbyTowns("definitely-not-a-real-community-xyz");
  assert.deepEqual(towns, [], "unknown community → no towns (no network)");
  console.log("  ✓ nearby-towns degrades to [] for an unknown community");
}

console.log("buyin-agent-tools suite passed");
