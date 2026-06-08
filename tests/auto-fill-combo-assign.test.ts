// Regression test for the combo-attach bug where a same-bedroom pair (e.g. Poipu
// Kai [3,3]) attached only the FIRST unit: a bedroom->single-pick map collapsed
// the two distinct 3BR picks into one, so the 2nd slot got the 1st pick and was
// dedup-skipped. assignComboPicksToSlots must consume each pick exactly once.
// (Seed a dummy DATABASE_URL so importing the server module's lazy db connection
// doesn't fire — same trick as city-vrbo-expansion.smoke.ts.)
process.env.DATABASE_URL ||= "postgres://smoke:smoke@127.0.0.1:5432/smoke";
// DYNAMIC import (not a top-level `import`): auto-fill-job → storage → db.ts
// throws at import time if DATABASE_URL is unset, and ESM hoists static imports
// ABOVE the env assignment above. A dynamic import runs after the env is seeded.
const { assignComboPicksToSlots } = await import("../server/auto-fill-job");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};
const distinct = (a: Array<{ pickIndex: number }>) => new Set(a.map((x) => x.pickIndex)).size === a.length;

console.log("auto-fill combo-assign: each pick consumed once");

// THE regression: [3,3] must fill both slots with DISTINCT picks (not pick0 twice).
{
  const a = assignComboPicksToSlots([3, 3], [{ bedrooms: 3 }, { bedrooms: 3 }]);
  check("[3,3]: both slots filled with two DISTINCT picks", a.length === 2 && distinct(a), a);
}
// [2,2] same-bedroom — same collapse risk.
{
  const a = assignComboPicksToSlots([2, 2], [{ bedrooms: 2 }, { bedrooms: 2 }]);
  check("[2,2]: both slots filled with two DISTINCT picks", a.length === 2 && distinct(a), a);
}
// [3,2]: exact-bedroom, in order.
{
  const a = assignComboPicksToSlots([3, 2], [{ bedrooms: 3 }, { bedrooms: 2 }]);
  const byslot = Object.fromEntries(a.map((x) => [x.slotIndex, x.pickIndex]));
  check("[3,2]: slot0->pick0(3), slot1->pick1(2)", a.length === 2 && byslot[0] === 0 && byslot[1] === 1, a);
}
// picks [3,2] vs slots ordered [2,3]: each slot must get its exact-bedroom pick, distinct.
{
  const a = assignComboPicksToSlots([3, 2], [{ bedrooms: 2 }, { bedrooms: 3 }]);
  const byslot = Object.fromEntries(a.map((x) => [x.slotIndex, x.pickIndex]));
  check("picks[3,2] vs slots[2,3]: slot0->pick1(2), slot1->pick0(3)", a.length === 2 && byslot[0] === 1 && byslot[1] === 0 && distinct(a), a);
}
// bigger-unit fill: picks [3,4] fill slots [3,3] (the 4BR satisfies a 3-slot), distinct.
{
  const a = assignComboPicksToSlots([3, 4], [{ bedrooms: 3 }, { bedrooms: 3 }]);
  check("[3,4] picks fill [3,3] slots (bigger unit allowed), distinct", a.length === 2 && distinct(a), a);
}
// MULTI-SPLIT: a 4+2 combo fills a [3,3] booking (total 6BR delivered across the
// two 3-slots; the 2BR pick legitimately lands in a 3-slot). Largest pick (4BR)
// -> a slot, smallest pick (2BR) -> the other slot; both slots filled, distinct.
{
  const a = assignComboPicksToSlots([4, 2], [{ bedrooms: 3 }, { bedrooms: 3 }]);
  check("[4,2] picks fill [3,3] slots (multi-split combo), 2 distinct", a.length === 2 && distinct(a), a);
}
// not enough picks: 1 pick, 2 slots -> only 1 assignment (never double-uses a pick).
{
  const a = assignComboPicksToSlots([3], [{ bedrooms: 3 }, { bedrooms: 3 }]);
  check("1 pick, 2 slots -> exactly 1 assignment (no double-use)", a.length === 1, a);
}

console.log(`\nauto-fill combo-assign: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
