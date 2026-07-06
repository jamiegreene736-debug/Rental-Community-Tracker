// Locks the cross-market resort de-duplication for the Top Markets sweep display
// (shared/sweep-resort-dedup.ts). Scenario mirrors the operator's Maui screenshot:
// Paia and Spreckelsville both surface "Sugar Cove" and "Kuau Plaza" (same
// resorts, different SEARCH cities) — each must display ONCE, under the first
// scanned city, and the queue must never build the same resort twice.
import {
  resortDedupKey,
  computeSweepResortOwnership,
  marketOwnsResort,
  type SweepMarketLike,
} from "../shared/sweep-resort-dedup";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("sweep-resort-dedup: cross-market resort de-duplication");

// ── resortDedupKey normalization ──────────────────────────────
check("key lowercases + collapses whitespace + includes state",
  resortDedupKey({ name: "  Sugar   Cove ", state: "Hawaii" }) === "sugar cove|hawaii");
check("same name, same state → identical key across cities",
  resortDedupKey({ name: "Sugar Cove", state: "HI" }) === resortDedupKey({ name: "sugar cove", state: "hi" }));
check("different state → different key (never collapse across states)",
  resortDedupKey({ name: "Sugar Cove", state: "HI" }) !== resortDedupKey({ name: "Sugar Cove", state: "FL" }));

// ── The Maui screenshot scenario ──────────────────────────────
// mi=0 Paia, mi=1 Spreckelsville — both return Sugar Cove + Kuau Plaza.
const mauiMarkets: SweepMarketLike[] = [
  { city: "Paia", state: "Hawaii", communities: [
    { name: "Sugar Cove", state: "Hawaii" },
    { name: "Kuau Plaza", state: "Hawaii" },
  ] },
  { city: "Spreckelsville", state: "Hawaii", communities: [
    { name: "Sugar Cove", state: "Hawaii" },
    { name: "Kuau Plaza", state: "Hawaii" },
  ] },
];
const mauiOwn = computeSweepResortOwnership(mauiMarkets);

check("Paia (first market) OWNS both resorts",
  marketOwnsResort(mauiOwn, 0, 0) && marketOwnsResort(mauiOwn, 0, 1));
check("Spreckelsville OWNS neither (both moved)",
  !marketOwnsResort(mauiOwn, 1, 0) && !marketOwnsResort(mauiOwn, 1, 1));
check("owner key points at first market/community",
  mauiOwn.ownerByKey.get("sugar cove|hawaii") === "0:0" &&
  mauiOwn.ownerByKey.get("kuau plaza|hawaii") === "0:1");
check("Spreckelsville lists both as moved, shown under Paia",
  (mauiOwn.movedByMarket.get(1) ?? []).length === 2 &&
  (mauiOwn.movedByMarket.get(1) ?? []).every((r) => r.shownUnderCity === "Paia"));
check("moved rows carry their own community index + name",
  JSON.stringify(mauiOwn.movedByMarket.get(1)) ===
  JSON.stringify([
    { communityIndex: 0, name: "Sugar Cove", shownUnderCity: "Paia" },
    { communityIndex: 1, name: "Kuau Plaza", shownUnderCity: "Paia" },
  ]));
check("Paia has no moved rows",
  (mauiOwn.movedByMarket.get(0) ?? []).length === 0);
check("each resort renders exactly ONCE across the whole sweep",
  [0, 1].reduce((n, mi) => n + (mauiOwn.ownedIndicesByMarket.get(mi)?.size ?? 0), 0) === 2);

// ── Partial overlap: later city has a UNIQUE resort too ───────
const partial: SweepMarketLike[] = [
  { city: "Paia", state: "Hawaii", communities: [{ name: "Sugar Cove", state: "Hawaii" }] },
  { city: "Spreckelsville", state: "Hawaii", communities: [
    { name: "Sugar Cove", state: "Hawaii" },   // dup → moved
    { name: "Maui Vista", state: "Hawaii" },    // unique → owned here
  ] },
];
const partialOwn = computeSweepResortOwnership(partial);
check("shared resort owned by Paia, unique resort owned by Spreckelsville",
  marketOwnsResort(partialOwn, 0, 0) &&
  !marketOwnsResort(partialOwn, 1, 0) &&
  marketOwnsResort(partialOwn, 1, 1));
check("Spreckelsville still owns/render its unique resort",
  (partialOwn.movedByMarket.get(1) ?? []).length === 1 &&
  partialOwn.ownerByKey.get("maui vista|hawaii") === "1:1");

// ── Ordering by market index is deterministic (not completion order) ──
// Even if the array is [Spreckelsville, Paia], the FIRST index wins.
const flipped: SweepMarketLike[] = [
  { city: "Spreckelsville", state: "Hawaii", communities: [{ name: "Sugar Cove", state: "Hawaii" }] },
  { city: "Paia", state: "Hawaii", communities: [{ name: "Sugar Cove", state: "Hawaii" }] },
];
const flippedOwn = computeSweepResortOwnership(flipped);
check("owner = first ARRAY index (Spreckelsville here), not alphabetical",
  marketOwnsResort(flippedOwn, 0, 0) && !marketOwnsResort(flippedOwn, 1, 0) &&
  (flippedOwn.movedByMarket.get(1) ?? [])[0]?.shownUnderCity === "Spreckelsville");

// ── Name-less resorts collapse by "|state", matching the queue ─
// (load-bearing: ownership MUST agree with sweepSelectedCommunities so a
// rendered checkbox is never silently dropped at queue time. Name-less rows are
// non-buildable + indistinguishable, so the first owns and the rest move.)
const nameless: SweepMarketLike[] = [
  { city: "A", state: "HI", communities: [{ name: "", state: "HI" }] },
  { city: "B", state: "HI", communities: [{ name: "", state: "HI" }] },
];
const namelessOwn = computeSweepResortOwnership(nameless);
check("first name-less resort owns, second collapses (matches queue dedup)",
  marketOwnsResort(namelessOwn, 0, 0) && !marketOwnsResort(namelessOwn, 1, 0) &&
  (namelessOwn.movedByMarket.get(1) ?? []).length === 1);
check("name-less resorts in DIFFERENT states never collapse", (() => {
  const o = computeSweepResortOwnership([
    { city: "A", state: "HI", communities: [{ name: "", state: "HI" }] },
    { city: "B", state: "FL", communities: [{ name: "", state: "FL" }] },
  ]);
  return marketOwnsResort(o, 0, 0) && marketOwnsResort(o, 1, 0) &&
    (o.movedByMarket.get(1) ?? []).length === 0;
})());

// ── Within a single market, an accidental repeat collapses too ─
const intraDup: SweepMarketLike[] = [
  { city: "Paia", state: "Hawaii", communities: [
    { name: "Sugar Cove", state: "Hawaii" },
    { name: "Sugar Cove", state: "Hawaii" }, // duplicate in the same city
  ] },
];
const intraOwn = computeSweepResortOwnership(intraDup);
check("intra-market duplicate is de-duped (owns index 0, moves index 1)",
  marketOwnsResort(intraOwn, 0, 0) && !marketOwnsResort(intraOwn, 0, 1) &&
  (intraOwn.movedByMarket.get(0) ?? []).length === 1);

// ── Empty / nullish input ─────────────────────────────────────
check("empty markets → empty ownership", (() => {
  const o = computeSweepResortOwnership([]);
  return o.ownerByKey.size === 0 && o.ownedIndicesByMarket.size === 0;
})());
check("nullish input does not throw", (() => {
  const o = computeSweepResortOwnership(undefined);
  return o.ownerByKey.size === 0;
})());
check("market with no communities → empty owned set, no throw", (() => {
  const o = computeSweepResortOwnership([{ city: "Hana", state: "Hawaii", communities: [] }]);
  return (o.ownedIndicesByMarket.get(0)?.size ?? -1) === 0 && (o.movedByMarket.get(0) ?? []).length === 0;
})());

console.log(`\nsweep-resort-dedup: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
