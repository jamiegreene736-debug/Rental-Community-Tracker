// Photo Community Check — pure-logic tests (no network, no vision call).
//
// Locks the deterministic pieces of the exhaustive community check:
//   • evenSampleIndices  — sampling spread (and the "check ALL when n<=cap"
//     property that makes the community pass exhaustive).
//   • chunk              — Phase-B batching.
//   • summarizeCommunityVerdicts — folds per-photo verdicts over the FULL
//     community set; every photo without a verdict is surfaced as "unchecked",
//     never silently passed (the operator wants 100% coverage).
//   • synthesizeVerdict  — pass/warn/fail + same-community roll-up.
//
// Run: npx tsx tests/photo-community-check.test.ts
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  evenSampleIndices,
  chunk,
  summarizeCommunityVerdicts,
  synthesizeVerdict,
} = await import("../server/photo-community-check");

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("photo-community-check: pure logic");

// ── evenSampleIndices ───────────────────────────────────────────────────────
ok("n<=cap returns EVERY index (exhaustive for small folders)",
  JSON.stringify(evenSampleIndices(8, 10)) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]));
ok("n==cap returns every index", evenSampleIndices(6, 6).length === 6);
ok("n>cap spreads and includes first & last", (() => {
  const idx = evenSampleIndices(30, 6);
  return idx.length === 6 && idx[0] === 0 && idx[idx.length - 1] === 29 && idx.every((v, i) => i === 0 || v > idx[i - 1]);
})());
ok("cap==1 returns [0]", JSON.stringify(evenSampleIndices(30, 1)) === JSON.stringify([0]));
ok("n==0 returns []", evenSampleIndices(0, 6).length === 0);
ok("cap==0 returns []", evenSampleIndices(30, 0).length === 0);

// ── chunk ─────────────────────────────────────────────────────────────────--
ok("chunk splits into fixed-size groups with a remainder", (() => {
  const c = chunk([1, 2, 3, 4, 5, 6, 7], 3);
  return c.length === 3 && c[0].length === 3 && c[2].length === 1;
})());
ok("chunk of exact multiple", chunk([1, 2, 3, 4], 2).length === 2);
ok("chunk empty -> []", chunk([], 3).length === 0);
ok("chunk reassembles to the original order", (() => {
  const src = Array.from({ length: 25 }, (_, i) => i);
  return JSON.stringify(chunk(src, 9).flat()) === JSON.stringify(src);
})());

// ── summarizeCommunityVerdicts ───────────────────────────────────────────────
const mkSamples = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `C${i + 1}`, caption: `cap${i + 1}` }) as any);

{
  const samples = mkSamples(5);
  const v = new Map(samples.map((s: any) => [s.id, { verdict: "same" as const, reason: "" }]));
  const r = summarizeCommunityVerdicts(samples, v);
  ok("all same -> checked=N, allSame, no flags",
    r.checked === 5 && r.allSameCommunity && r.outliers.length === 0 && r.junk.length === 0 && r.unchecked.length === 0, r);
}
{
  const samples = mkSamples(5);
  const v = new Map<string, any>(samples.map((s: any) => [s.id, { verdict: "same", reason: "" }]));
  v.set("C3", { verdict: "different", reason: "different resort signage" });
  const r = summarizeCommunityVerdicts(samples, v);
  ok("one different -> outlier + allSame=false + carries reason/caption",
    !r.allSameCommunity && r.outliers.length === 1 && r.outliers[0].id === "C3" && r.outliers[0].caption === "cap3" && /signage/.test(r.outliers[0].reason), r);
}
{
  const samples = mkSamples(4);
  const v = new Map<string, any>(samples.map((s: any) => [s.id, { verdict: "same", reason: "" }]));
  v.set("C2", { verdict: "junk", reason: "floorplan" });
  const r = summarizeCommunityVerdicts(samples, v);
  ok("junk does NOT trip allSameCommunity (it's mis-filed, not a different community)",
    r.allSameCommunity && r.junk.length === 1 && r.outliers.length === 0, r);
}
{
  // A batch failed: two photos got no verdict → unchecked, never assumed same.
  const samples = mkSamples(5);
  const v = new Map<string, any>([["C1", { verdict: "same", reason: "" }], ["C2", { verdict: "same", reason: "" }], ["C3", { verdict: "same", reason: "" }]]);
  const r = summarizeCommunityVerdicts(samples, v);
  ok("missing verdicts -> unchecked (checked<N), not silently same",
    r.checked === 3 && r.unchecked.length === 2 && r.unchecked.map((u: any) => u.id).join(",") === "C4,C5", r);
}

// ── synthesizeVerdict ─────────────────────────────────────────────────────--
const community = (over: Partial<any> = {}) => ({
  role: "community", label: "Community — X", folder: "x", photosChecked: 10, photosTotal: 10,
  identifiedCommunity: "X Resort", matchesExpected: "yes", matchReason: "", allSameCommunity: true,
  outliers: [], junk: [], unchecked: [], confidence: 0.9, ...over,
}) as any;
const unit = (over: Partial<any> = {}) => ({
  role: "unit", label: "Unit A", folder: "a", photosChecked: 5, photosTotal: 5,
  identifiedCommunity: "X Resort", sameAsCommunity: "yes", reason: "", allSameUnit: true,
  outliers: [], junk: [], confidence: 0.9, ...over,
}) as any;
const base = { expectedCommunity: "X Resort", crossDupeCount: 0, modelConcerns: [], unitCompareFailed: false };

{
  const r = synthesizeVerdict({ ...base, community: community(), units: [unit(), unit({ label: "Unit B" })] });
  ok("clean community + 2 matching units -> pass / yes", r.verdict === "pass" && r.allSameCommunity === "yes", r);
}
{
  const r = synthesizeVerdict({ ...base, community: community({ matchesExpected: "no", identifiedCommunity: "Other Resort" }), units: [unit()] });
  ok("community matchesExpected=no -> fail / no", r.verdict === "fail" && r.allSameCommunity === "no", r);
}
{
  const r = synthesizeVerdict({ ...base, community: community(), units: [unit({ sameAsCommunity: "no", identifiedCommunity: "Other" })] });
  ok("a unit different -> fail / no", r.verdict === "fail" && r.allSameCommunity === "no", r);
}
{
  // A stray different-community photo in the (otherwise-right) community folder:
  // folder still matches → roll-up stays "yes", but it's a WARN to review.
  const r = synthesizeVerdict({ ...base, community: community({ outliers: [{ id: "C7", reason: "x" }] }), units: [unit()] });
  ok("community outlier photo -> warn but allSameCommunity stays yes", r.verdict === "warn" && r.allSameCommunity === "yes", r);
}
{
  const r = synthesizeVerdict({ ...base, community: community({ unchecked: [{ id: "C9", reason: "x" }] }), units: [unit()] });
  ok("unchecked community photo -> warn + concern mentions not verified",
    r.verdict === "warn" && r.concerns.some((c) => /could NOT be analyzed|unchecked|not every photo/i.test(c)), r);
}
{
  const r = synthesizeVerdict({ ...base, community: community(), units: [] });
  ok("single set, nothing to compare -> pass / uncertain roll-up", r.verdict === "pass" && r.allSameCommunity === "uncertain", r);
}
{
  const r = synthesizeVerdict({ ...base, community: community(), units: [unit()], unitCompareFailed: true });
  ok("unit compare failed -> warn + concern", r.verdict === "warn" && r.concerns.some((c) => /Unit comparison could not run/i.test(c)), r);
}
{
  const r = synthesizeVerdict({ ...base, community: community(), units: [unit()], crossDupeCount: 2 });
  ok("cross-folder dupes -> warn", r.verdict === "warn" && r.concerns.some((c) => /more than one folder/i.test(c)), r);
}

console.log(`\nphoto-community-check: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
