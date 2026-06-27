import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  proposeAttach,
  registerCommitContext,
  unregisterCommitContext,
  validateGroundFloorEvidence,
  sanitizePhotoUrls,
  setCoordResolver,
  __resetCoordResolverForTests,
} = await import("../server/buyin-agent-commit");
const { buildOutcomeSummary } = await import("../server/auto-fill-cowork");
const { evaluateComboProfit } = await import("../shared/buy-in-profit");

console.log("buyin-agent-commit suite");

// ── pure guard: ground-floor evidence ────────────────────────────────────────
{
  assert.equal(validateGroundFloorEvidence("Ground floor unit with step-free entry").ok, true);
  assert.equal(validateGroundFloorEvidence("First-floor lanai, no stairs").ok, true);
  assert.equal(validateGroundFloorEvidence("").ok, false, "empty → not confirmed");
  assert.equal(validateGroundFloorEvidence("nice").ok, false, "too short → not confirmed");
  assert.equal(validateGroundFloorEvidence("Top floor penthouse with elevator").ok, false, "no ground-floor signal → not confirmed");
  console.log("  ✓ validateGroundFloorEvidence requires a real, non-trivial snippet");
}

// ── pure guard: photo url sanitize ───────────────────────────────────────────
{
  const out = sanitizePhotoUrls([
    "https://img.example.com/a.jpg",
    "http://img.example.com/b.png",
    "not-a-url",
    "ftp://x/y",
    "https://img.example.com/a.jpg", // dup
    "",
    null,
  ]);
  assert.deepEqual(out, ["https://img.example.com/a.jpg", "http://img.example.com/b.png"]);
  assert.equal(sanitizePhotoUrls(Array.from({ length: 30 }, (_, i) => `https://x/${i}.jpg`)).length, 12, "capped at 12");
  console.log("  ✓ sanitizePhotoUrls keeps well-formed http(s), dedups, caps at 12");
}

// ── proposeAttach harness ────────────────────────────────────────────────────
type Captured = { picks: any[]; loss: any[]; econ: any[] };
function makeCtx(over: { expectedRevenue?: number; groundFloor?: number[] } = {}) {
  const captured: Captured = { picks: [], loss: [], econ: [] };
  const job: any = {
    id: "afj_test",
    reservationId: "res_test",
    propertyId: 4,
    propertyName: "Test",
    community: "poipu kai",
    listingId: null,
    checkIn: "2026-09-12",
    checkOut: "2026-09-19",
    nights: 7,
    slots: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
    ],
    attached: [],
    groundFloorBedrooms: new Set(over.groundFloor ?? []),
    expectedRevenue: over.expectedRevenue ?? 9000,
    existingAttachedCost: 0,
  };
  const committedCost = () => job.existingAttachedCost + job.attached.reduce((s: number, a: any) => s + (Number(a.totalPrice) || 0), 0);
  const deps: any = {
    base: "http://127.0.0.1:5000",
    committedCost,
    gate: (comboCost: number) => evaluateComboProfit({ expectedRevenue: job.expectedRevenue, existingCost: committedCost(), comboCost, flat: 100, pct: 0 }),
    remainingSlots: () => job.slots.filter((s: any) => !job.attached.some((a: any) => a.unitId === s.unitId)),
    used: new Set<string>(),
    recordEconomics: (...args: any[]) => captured.econ.push(args),
    recordLossComboOption: (...args: any[]) => captured.loss.push(args),
    attachPick: async (args: any) => {
      captured.picks.push(args.pick);
      job.attached.push({ unitId: args.slot.unitId, url: args.pick.url, title: args.pick.title, totalPrice: args.pick.totalPrice, bedrooms: args.searchedBedrooms });
      return true;
    },
    reconcile: async () => {},
    finalize: () => {},
    touch: () => {},
    setEscalation: () => {},
  };
  registerCommitContext(job.id, { job, deps });
  return { job, deps, captured };
}

// profitable single pick attaches through the chokepoint
{
  __resetCoordResolverForTests();
  const { job, captured } = makeCtx();
  const r = await proposeAttach({ jobId: "afj_test", picks: [{ unitId: "A", url: "https://vrbo.com/a", title: "3BR Villa", totalPrice: 4000, bedrooms: 3 }] });
  assert.equal(r.ok, true);
  assert.equal(r.acceptable, true);
  assert.equal(r.attached[0].attached, true);
  assert.equal(job.attached.length, 1);
  assert.equal(captured.picks[0].verified, "yes", "agent pick attaches as verified");
  unregisterCommitContext("afj_test");
  console.log("  ✓ profitable single pick commits via attachPick");
}

// over-loss combo is refused + recorded as a loss option, nothing attached
{
  const { job, captured } = makeCtx({ expectedRevenue: 2000 });
  const r = await proposeAttach({ jobId: "afj_test", picks: [
    { unitId: "A", url: "https://vrbo.com/a", title: "3BR", totalPrice: 4000, bedrooms: 3 },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.acceptable, false, "over the $100 cap → not acceptable");
  assert.equal(job.attached.length, 0, "nothing attached");
  assert.equal(captured.loss.length, 1, "recorded a loss option");
  unregisterCommitContext("afj_test");
  console.log("  ✓ over-loss proposal refused + recorded as a loss option (never attached)");
}

// ground-floor required slot: rejected without a snippet, attached with one
{
  const { job, captured } = makeCtx({ groundFloor: [3] });
  const noEvidence = await proposeAttach({ jobId: "afj_test", picks: [{ unitId: "A", url: "https://vrbo.com/a", title: "3BR", totalPrice: 3000, bedrooms: 3 }] });
  assert.equal(noEvidence.attached[0].attached, false, "no ground-floor snippet → rejected");
  assert.equal(job.attached.length, 0);

  const withEvidence = await proposeAttach({ jobId: "afj_test", picks: [{ unitId: "A", url: "https://vrbo.com/a", title: "3BR", totalPrice: 3000, bedrooms: 3, groundFloorEvidence: "Ground-floor unit with step-free entry and no stairs" }] });
  assert.equal(withEvidence.attached[0].attached, true, "valid snippet → attaches");
  assert.equal(captured.picks.at(-1).groundFloorStatus, "confirmed");
  unregisterCommitContext("afj_test");
  console.log("  ✓ ground-floor slot needs a server-verifiable snippet");
}

// coords: server-derived only — the agent's coords are ignored for the Geo marker
{
  setCoordResolver(async () => ({ lat: 21.8800, lng: -159.4500 }));
  const { captured } = makeCtx();
  await proposeAttach({ jobId: "afj_test", picks: [{ unitId: "A", url: "https://vrbo.com/a", title: "3BR", totalPrice: 3000, bedrooms: 3, /* agent-supplied bogus coords below */ ...( { lat: 99, lng: 99 } as any) }] });
  assert.equal(captured.picks[0].lat, 21.88, "uses server-derived lat, not the agent's");
  assert.equal(captured.picks[0].lng, -159.45);
  unregisterCommitContext("afj_test");
  __resetCoordResolverForTests();
  console.log("  ✓ coords are server-derived; agent coords ignored");
}

// unknown slot, already-filled slot, and no-context guards
{
  __resetCoordResolverForTests();
  const { job } = makeCtx();
  assert.equal((await proposeAttach({ jobId: "afj_test", picks: [{ unitId: "Z", url: "u", title: "t", totalPrice: 100 }] })).ok, false, "unknown slot");
  await proposeAttach({ jobId: "afj_test", picks: [{ unitId: "A", url: "https://vrbo.com/a", title: "3BR", totalPrice: 3000, bedrooms: 3 }] });
  assert.equal(job.attached.length, 1);
  assert.equal((await proposeAttach({ jobId: "afj_test", picks: [{ unitId: "A", url: "https://vrbo.com/a2", title: "3BR", totalPrice: 3000, bedrooms: 3 }] })).ok, false, "already-filled slot");
  unregisterCommitContext("afj_test");
  assert.equal((await proposeAttach({ jobId: "afj_test", picks: [{ unitId: "A", url: "u", title: "t", totalPrice: 100 }] })).ok, false, "no live context");
  console.log("  ✓ unknown-slot, already-filled, and no-context proposals are refused");
}

// ── buildOutcomeSummary (observability) ──────────────────────────────────────
{
  assert.match(buildOutcomeSummary("attached", [1, 2, 3], 2, 2, null), /attached 2\/2/);
  assert.match(buildOutcomeSummary("no-combo-found", [1, 2], 0, 2, null), /no profitable/i);
  assert.match(buildOutcomeSummary("session-invalid", [], 0, 2, null), /session invalid|logged out/i);
  assert.match(buildOutcomeSummary("budget-exhausted", [1], 0, 2, null), /time/i);
  assert.match(buildOutcomeSummary("agent-error", [], 0, 1, "boom"), /error/i);
  console.log("  ✓ buildOutcomeSummary surfaces WHY for each outcome");
}

console.log("buyin-agent-commit suite passed");
