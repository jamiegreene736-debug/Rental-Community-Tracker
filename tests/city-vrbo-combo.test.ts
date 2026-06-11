// Network-free unit tests for the community matcher's typo-tolerance + the
// complexName wiring. The PRECISION tests (a typo must never map to a DIFFERENT
// real complex) are the guard against over-clustering — the failure mode that
// would send a guest to two units in different communities.
import {
  comboSplitsForPlan,
  sharedResortPhraseKeys,
  suggestCityVrboComboPair,
  suggestCityVrboComboPairs,
  suggestUnconfirmedCityVrboComboPairs,
  summarizeCityVrboMatching,
  titlesShareWalkableCommunity,
  resolveUnitCommunityFromText,
  verifyResolvedUnitsShareCommunity,
  type CityVrboListing,
} from "../shared/city-vrbo-combo";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const keysFor = (title: string, opts: { snippet?: string; complexName?: string } = {}): string[] =>
  sharedResortPhraseKeys({ title, sourceLabel: "Vrbo", snippet: opts.snippet ?? "", complexName: opts.complexName });

const has = (ks: string[], k: string) => ks.includes(k);

console.log("city-vrbo-combo: typo tolerance + complexName wiring");

// ── 1) Exact + alias + fuzzy POSITIVES ───────────────────────────────────────
check("exact: 'Poipu Kai Resort 3BR' → dict:poipu kai", has(keysFor("Poipu Kai Resort 3BR"), "dict:poipu kai"));
check("ALIAS (headline): 'Poipu Kie Beachfront 2BR' → dict:poipu kai",
  has(keysFor("Poipu Kie Beachfront 2BR"), "dict:poipu kai"), keysFor("Poipu Kie Beachfront 2BR"));
check("alias: 'Poepu Kai Oceanview' → dict:poipu kai", has(keysFor("Poepu Kai Oceanview"), "dict:poipu kai"));
check("fuzzy: 'Cozy Sunset Kahilli 304' → dict:sunset kahili",
  has(keysFor("Cozy Sunset Kahilli 304"), "dict:sunset kahili"), keysFor("Cozy Sunset Kahilli 304"));
check("fuzzy: 'Poipu Shore Oceanfront' → dict:poipu shores",
  has(keysFor("Poipu Shore Oceanfront"), "dict:poipu shores"), keysFor("Poipu Shore Oceanfront"));
check("alias: 'Poipu Kapilli 402' → dict:poipu kapili",
  has(keysFor("Poipu Kapilli 402"), "dict:poipu kapili"), keysFor("Poipu Kapilli 402"));
check("fuzzy: 'Makahuenna at Poipu' → dict:makahuena",
  has(keysFor("Makahuenna at Poipu"), "dict:makahuena"), keysFor("Makahuenna at Poipu"));

// ── 2) PRECISION: a name must NOT leak into a DIFFERENT real complex ─────────
const pk = keysFor("Poipu Kai Resort 3BR Oceanfront");
check("precision: Poipu Kai does NOT → dict:poipu kapili", !has(pk, "dict:poipu kapili"), pk);
check("precision: Poipu Kai does NOT → dict:poipu sands", !has(pk, "dict:poipu sands"), pk);
check("precision: Poipu Kai does NOT → dict:poipu shores", !has(pk, "dict:poipu shores"), pk);
check("precision: Poipu Kai does NOT → dict:poipu crater", !has(pk, "dict:poipu crater"), pk);
check("precision: Poipu Kai does NOT → dict:pono kai", !has(pk, "dict:pono kai"), pk);

const nihi = keysFor("Nihi Kai Villas 3BR");
check("precision: Nihi Kai → dict:nihi kai villas", has(nihi, "dict:nihi kai villas"), nihi);
check("precision: Nihi Kai does NOT → dict:poipu kai", !has(nihi, "dict:poipu kai"), nihi);

const alii = keysFor("Alii Kai Princeville 2BR");
check("precision: Alii Kai → dict:alii kai", has(alii, "dict:alii kai"), alii);
check("precision: Alii Kai does NOT → dict:poipu kai", !has(alii, "dict:poipu kai"), alii);
check("precision: Alii Kai does NOT → dict:alihi lani", !has(alii, "dict:alihi lani"), alii);

const mauna = keysFor("Mauna Kai Princeville Townhome");
check("precision: Mauna Kai → dict:mauna kai", has(mauna, "dict:mauna kai"), mauna);
check("precision: Mauna Kai does NOT → dict:poipu kai", !has(mauna, "dict:poipu kai"), mauna);

// A genuinely unrelated title must not fuzzy-match anything.
const unrelated = keysFor("Beautiful Beachfront Escape with Pool");
check("precision: unrelated title yields no dict key",
  !unrelated.some((k) => k.startsWith("dict:")), unrelated);

// ── 3) complexName wiring (enrichment / LLM output) ──────────────────────────
check("complexName single-word specific: 'Kamalii' → complex:kamalii",
  has(keysFor("Ocean View 3BR Condo", { complexName: "Kamalii" }), "complex:kamalii"),
  keysFor("Ocean View 3BR Condo", { complexName: "Kamalii" }));
check("complexName typo → dict: 'poipu kie' → dict:poipu kai",
  has(keysFor("Generic 2BR", { complexName: "poipu kie" }), "dict:poipu kai"),
  keysFor("Generic 2BR", { complexName: "poipu kie" }));
const generic = keysFor("Generic 3BR", { complexName: "poipu condo" });
check("complexName generic rejected: 'poipu condo' adds no community key",
  !generic.some((k) => k.startsWith("dict:") || k.startsWith("complex:")), generic);
const bareplace = keysFor("Generic 3BR", { complexName: "poipu" });
check("complexName bare place rejected: 'poipu' adds no community key",
  !bareplace.some((k) => k.startsWith("dict:") || k.startsWith("complex:")), bareplace);

// ── 4) End-to-end pairing ────────────────────────────────────────────────────
const L = (url: string, title: string, bedrooms: number, totalPrice: number, complexName?: string): CityVrboListing =>
  ({ url, title, bedrooms, totalPrice, complexName });

// 4a) typo half pairs with the correct half (same community).
const pairPool = [
  L("https://vrbo.com/a", "Poipu Kai Resort 3BR Oceanfront", 3, 3000),
  L("https://vrbo.com/b", "Poipu Kie Garden 2BR", 2, 2000),
  L("https://vrbo.com/c", "Kiahuna Plantation 3BR", 3, 9999), // distractor, wrong-priced-high
];
const pair = suggestCityVrboComboPair(pairPool, [3, 2], 7);
check("e2e: typo half pairs with correct half (resortPhrase poipu kai)",
  !!pair && pair.resortPhrase === "poipu kai" && pair.picks.length === 2, pair);
check("e2e: the pair uses the two Poipu Kai units (a + b), not the Kiahuna distractor",
  !!pair && new Set(pair.picks.map((p) => p.url)).size === 2 && pair.picks.every((p) => p.url !== "https://vrbo.com/c"), pair?.picks?.map((p) => p.url));

// 4b) two NON-adjacent communities must NOT pair (Poipu vs Princeville).
const noPairPool = [
  L("https://vrbo.com/x", "Poipu Kai Resort 3BR", 3, 3000),
  L("https://vrbo.com/y", "Mauna Kai Princeville 2BR", 2, 2000),
];
const noPair = suggestCityVrboComboPair(noPairPool, [3, 2], 7);
check("e2e: Poipu Kai + Mauna Kai(Princeville) → NO pair (not walkable-adjacent)", noPair === null, noPair);

// 4b-2) ADJACENCY: Poipu Kai 3BR + Kiahuna 3BR pair for [3,3] when no single
// complex has two 3BRs (the large-unit scarcity fix). matchSource = adjacency.
const adjPool = [
  L("https://vrbo.com/p1", "Poipu Kai Resort 3BR", 3, 3000),
  L("https://vrbo.com/p2", "Kiahuna Plantation 3BR", 3, 3200),
];
const adjPair = suggestCityVrboComboPair(adjPool, [3, 3], 7);
check("e2e: adjacency pairs Poipu Kai 3BR + Kiahuna 3BR for [3,3]",
  !!adjPair && adjPair.picks.length === 2 && adjPair.matchSource === "adjacency", adjPair);

// 4b-3) single-complex pair PREFERRED over a cheaper adjacency pair.
const prefPool = [
  L("https://vrbo.com/q1", "Poipu Kai Resort 3BR A", 3, 3000),
  L("https://vrbo.com/q2", "Poipu Kai Resort 3BR B", 3, 3100),
  L("https://vrbo.com/q3", "Kiahuna Plantation 3BR", 3, 2500), // cheaper but cross-complex
];
const prefPair = suggestCityVrboComboPair(prefPool, [3, 3], 7);
check("e2e: single-complex (poipu kai) preferred over cheaper adjacency",
  !!prefPair && prefPair.matchSource === "dictionary" && prefPair.resortPhrase === "poipu kai", prefPair);

// 4b-4) >=BEDROOM: a 4BR satisfies a 3BR slot (one complex with 3BR + 4BR fills [3,3]).
const bigPool = [
  L("https://vrbo.com/g1", "Poipu Kai Resort 3BR", 3, 3000),
  L("https://vrbo.com/g2", "Poipu Kai Resort 4BR", 4, 3500),
];
check("e2e: 3BR + 4BR fills a [3,3] plan (bigger unit allowed)",
  !!suggestCityVrboComboPair(bigPool, [3, 3], 7), suggestCityVrboComboPair(bigPool, [3, 3], 7));

// 4b-5) >=BEDROOM assignment: a cheap 3BR must go to the 3-slot, not the 2-slot
// (largest-requirement-first), so a [2,3] plan still fills both.
const assignPool = [
  L("https://vrbo.com/h1", "Poipu Kai Resort 2BR", 2, 5000), // 2BR, expensive
  L("https://vrbo.com/h2", "Poipu Kai Resort 3BR", 3, 2000), // 3BR, cheap
];
check("e2e: [2,3] with a cheap 3BR fills both (largest-first assignment)",
  !!suggestCityVrboComboPair(assignPool, [2, 3], 7), suggestCityVrboComboPair(assignPool, [2, 3], 7));

// 4c) LLM-style complexName clusters generic titles (mutual validation: 2 share it).
const llmPool = [
  L("https://vrbo.com/m", "Spacious 3BR with Ocean View", 3, 3100, "kamalii"),
  L("https://vrbo.com/n", "Bright 2BR Garden Unit", 2, 2100, "kamalii"),
];
const llmPair = suggestCityVrboComboPair(llmPool, [3, 2], 7);
check("e2e: two complexName='kamalii' generic titles → pair", !!llmPair && llmPair.picks.length === 2, llmPair);

// 4d) a SINGLE complexName listing (no second) must NOT pair (mutual validation).
const singletonPool = [
  L("https://vrbo.com/s", "Lovely 3BR Retreat", 3, 3000, "kamalii"),
  L("https://vrbo.com/t", "Charming 2BR Hideaway", 2, 2000), // no community
];
check("e2e: singleton complexName → NO pair (needs >=2 sharing the community)",
  suggestCityVrboComboPair(singletonPool, [3, 2], 7) === null);

// ── 4e) MULTIPLE BEDROOM SPLITS: a 2-unit combo can satisfy the TOTAL via more
// than one split (6BR = 3+3 OR 4+2). comboSplitsForPlan enumerates them, configured
// first; suggestCityVrboComboPair tries every split and returns the cheapest. ──
const splitKey = (splits: number[][]) => splits.map((s) => s.slice().sort((a, b) => b - a).join("+")).join(",");
check("split: [3,3] → 3+3 (configured) then 4+2", splitKey(comboSplitsForPlan([3, 3])) === "3+3,4+2", comboSplitsForPlan([3, 3]));
check("split: [4,2] → 4+2 (configured) then 3+3", splitKey(comboSplitsForPlan([4, 2])) === "4+2,3+3", comboSplitsForPlan([4, 2]));
check("split: [4,4] (8BR) → 4+4, 6+2, 5+3", splitKey(comboSplitsForPlan([4, 4])) === "4+4,6+2,5+3", comboSplitsForPlan([4, 4]));
check("split: [3,2] (5BR) has no alt (4+1 has a 1BR < min)", splitKey(comboSplitsForPlan([3, 2])) === "3+2", comboSplitsForPlan([3, 2]));
check("split: [2,2] (4BR) has no alt", splitKey(comboSplitsForPlan([2, 2])) === "2+2", comboSplitsForPlan([2, 2]));
check("split: non-2-unit plan returned unchanged ([3] / [3,3,2])",
  splitKey(comboSplitsForPlan([3])) === "3" && splitKey(comboSplitsForPlan([3, 3, 2])) === "3+3+2",
  [comboSplitsForPlan([3]), comboSplitsForPlan([3, 3, 2])]);

// 4e-1) END-TO-END: a community has a 4BR + 2BR and NO two 3BR. A [3,3] booking
// must still pair via the 4+2 split (same total 6BR, same community, walkable).
const splitPool = [
  L("https://vrbo.com/sp1", "Poipu Kai Resort 4BR Oceanfront", 4, 3800),
  L("https://vrbo.com/sp2", "Poipu Kai Resort 2BR Garden", 2, 2100),
  L("https://vrbo.com/sp3", "Kiahuna Plantation 3BR", 3, 9999), // distractor, wrong community + dear
];
const splitPair = suggestCityVrboComboPair(splitPool, [3, 3], 7);
check("e2e: [3,3] booking fills via a same-community 4BR+2BR split",
  !!splitPair && splitPair.picks.length === 2 && splitPair.resortPhrase === "poipu kai", splitPair);
check("e2e: the 4+2 split picks the two Poipu Kai units (4BR + 2BR), not the Kiahuna distractor",
  !!splitPair && new Set(splitPair.picks.map((p) => p.bedrooms)).has(4) && new Set(splitPair.picks.map((p) => p.bedrooms)).has(2)
    && splitPair.picks.every((p) => p.url !== "https://vrbo.com/sp3"), splitPair?.picks?.map((p) => `${p.bedrooms}BR ${p.url}`));

// 4e-2) CHEAPEST split wins: when BOTH 3+3 and 4+2 can form in one community, the
// cheapest pair ACROSS splits is chosen. Cheapest 4+2 = 4BR(2800)+2BR(1900)=4700;
// cheapest 3+3 = 4BR(2800)+3BR(3000)=5800 (the 4BR satisfies a 3-slot). 4+2 wins.
const bothSplitsPool = [
  L("https://vrbo.com/bs1", "Poipu Kai Resort 3BR A", 3, 3000),
  L("https://vrbo.com/bs2", "Poipu Kai Resort 3BR B", 3, 3000),
  L("https://vrbo.com/bs3", "Poipu Kai Resort 4BR", 4, 2800),
  L("https://vrbo.com/bs4", "Poipu Kai Resort 2BR", 2, 1900),
];
const cheapestSplit = suggestCityVrboComboPair(bothSplitsPool, [3, 3], 7);
check("e2e: cheapest split chosen across 3+3 vs 4+2 (4+2 @ 4700 wins)",
  !!cheapestSplit && cheapestSplit.totalCost === 4700
    && new Set(cheapestSplit.picks.map((p) => p.bedrooms)).has(4) && new Set(cheapestSplit.picks.map((p) => p.bedrooms)).has(2),
  cheapestSplit);

// ── 5) match diagnostics (read-only instrumentation) ─────────────────────────
const diagPool = [
  L("https://vrbo.com/d1", "Poipu Kai Resort 3BR", 3, 3000),
  L("https://vrbo.com/d2", "Poipu Kie 2BR Oceanfront", 2, 2000),       // alias → poipu kai
  L("https://vrbo.com/d3", "Beautiful 3BR Beachfront Escape", 3, 2500), // no signal
  L("https://vrbo.com/d4", "Tropical 2BR Paradise Retreat", 2, 1800),   // no signal
];
const diag = summarizeCityVrboMatching(diagPool, [3, 2], 7);
check("diag: pricedTotal counts all priced+bedroomed listings", diag.pricedTotal === 4, diag);
check("diag: 2 matched (the two Poipu Kai), 2 unmatched", diag.matched === 2 && diag.unmatched === 2, diag);
check("diag: bySignal.dictionary === 2", diag.bySignal.dictionary === 2, diag.bySignal);
check("diag: unmatchedSample surfaces the generic titles",
  diag.unmatchedSample.some((u) => /Beachfront Escape/.test(u.title)) && diag.unmatchedSample.some((u) => /Paradise Retreat/.test(u.title)),
  diag.unmatchedSample);
check("diag: poipu kai cluster is pairable (3BR + 2BR present)", diag.pairableClusters >= 1, diag);
check("diag: topClusters includes poipu kai", diag.topClusters.some((c) => c.label === "poipu kai"), diag.topClusters);

// ── 6) PLURAL: top-N DISTINCT combos from one pool ───────────────────────────
// suggestCityVrboComboPairs mines the SAME broad pool VRBO returns for adjacent
// towns for MULTIPLE distinct same-community combos, instead of the single
// cheapest. result[0] MUST equal the singular (back-compat / attach + profit gate
// key off the single cheapest — never let the plural change it).
const samePicks = (a: CityVrboComboPairLike, b: CityVrboComboPairLike): boolean =>
  !!a && !!b && a.totalCost === b.totalCost && a.resortPhrase === b.resortPhrase &&
  a.picks.length === b.picks.length &&
  a.picks.map((p) => p.url).sort().join("|") === b.picks.map((p) => p.url).sort().join("|");
type CityVrboComboPairLike = { totalCost: number; resortPhrase: string; picks: { url: string; bedrooms?: number | null }[] };
const allUrls = (combos: CityVrboComboPairLike[]): string[] => combos.flatMap((c) => c.picks.map((p) => p.url));
const noDupUrls = (combos: CityVrboComboPairLike[]): boolean => { const u = allUrls(combos); return new Set(u).size === u.length; };

// 6-1) EQUIVALENCE: result[0] is byte-identical to the singular (locks back-compat).
const eqPool = [
  L("https://vrbo.com/e1", "Poipu Kai Resort 3BR A", 3, 3000),
  L("https://vrbo.com/e2", "Poipu Kai Resort 3BR B", 3, 3050),
  L("https://vrbo.com/e3", "Kiahuna Plantation 3BR", 3, 3500),
  L("https://vrbo.com/e4", "Kiahuna Plantation 3BR B", 3, 3600),
];
const eqSingular = suggestCityVrboComboPair(eqPool, [3, 3], 7);
const eqPlural = suggestCityVrboComboPairs(eqPool, [3, 3], 7, 5);
check("plural: result[0] equals the singular cheapest pair",
  !!eqSingular && eqPlural.length >= 1 && samePicks(eqPlural[0], eqSingular), { eqSingular, top: eqPlural[0] });

// 6-2) DISTINCT-URL NON-OVERLAP: 4 same-community 3BRs, plan [3,3] → 2 combos, no shared URL.
const fourPool = [
  L("https://vrbo.com/f1", "Poipu Kai Resort 3BR A", 3, 3000),
  L("https://vrbo.com/f2", "Poipu Kai Resort 3BR B", 3, 3100),
  L("https://vrbo.com/f3", "Poipu Kai Resort 3BR C", 3, 3200),
  L("https://vrbo.com/f4", "Poipu Kai Resort 3BR D", 3, 3300),
];
const fourCombos = suggestCityVrboComboPairs(fourPool, [3, 3], 7, 5);
check("plural: 4 same-community 3BRs → exactly 2 combos", fourCombos.length === 2, fourCombos.map((c) => c.totalCost));
check("plural: the 2 combos share NO listing URL", noDupUrls(fourCombos), allUrls(fourCombos));

// 6-3) DIFFERENT-CLUSTER PREFERENCE: a 2nd Poipu Kai pair is CHEAPER than the
// Kiahuna pair, yet combo[1] is the KIAHUNA pair (new cluster preferred);
// the cheaper 2nd Poipu Kai pair only appears at combo[2] (same-cluster allowed).
const divPool = [
  L("https://vrbo.com/v1", "Poipu Kai Resort 3BR A", 3, 3000),
  L("https://vrbo.com/v2", "Poipu Kai Resort 3BR B", 3, 3050),
  L("https://vrbo.com/v3", "Poipu Kai Resort 3BR C", 3, 3100),
  L("https://vrbo.com/v4", "Poipu Kai Resort 3BR D", 3, 3150),
  L("https://vrbo.com/v5", "Kiahuna Plantation 3BR A", 3, 3500),
  L("https://vrbo.com/v6", "Kiahuna Plantation 3BR B", 3, 3600),
];
const divCombos = suggestCityVrboComboPairs(divPool, [3, 3], 7, 3);
check("plural: combo[0] is the cheapest overall (Poipu Kai pair)",
  divCombos[0]?.resortPhrase === "poipu kai", divCombos.map((c) => `${c.resortPhrase} $${c.totalCost}`));
check("plural: combo[1] prefers the DIFFERENT cluster (Kiahuna) over a cheaper 2nd Poipu Kai pair",
  divCombos[1]?.resortPhrase === "kiahuna plantation", divCombos.map((c) => `${c.resortPhrase} $${c.totalCost}`));
check("plural: combo[2] is the same-cluster runner-up (2nd Poipu Kai pair)",
  divCombos[2]?.resortPhrase === "poipu kai", divCombos.map((c) => `${c.resortPhrase} $${c.totalCost}`));
check("plural: all 3 combos are URL-disjoint", noDupUrls(divCombos), allUrls(divCombos));

// 6-4) LIMIT HONORED: a pool that could yield >=3 combos, limit 2 → exactly 2,
// and combo[0] is still the global cheapest.
const limitCombos = suggestCityVrboComboPairs(divPool, [3, 3], 7, 2);
check("plural: limit honored (2 of >=3 possible)", limitCombos.length === 2, limitCombos.length);
check("plural: limited result[0] still equals the singular",
  !!suggestCityVrboComboPair(divPool, [3, 3], 7) && samePicks(limitCombos[0], suggestCityVrboComboPair(divPool, [3, 3], 7)!), limitCombos[0]);

// 6-5) EMPTY / INSUFFICIENT pools.
check("plural: empty pool → []", suggestCityVrboComboPairs([], [3, 3], 7, 5).length === 0);
check("plural: limit 0 → []", suggestCityVrboComboPairs(fourPool, [3, 3], 7, 0).length === 0);
const threePool = [
  L("https://vrbo.com/t1", "Poipu Kai Resort 3BR A", 3, 3000),
  L("https://vrbo.com/t2", "Poipu Kai Resort 3BR B", 3, 3100),
  L("https://vrbo.com/t3", "Poipu Kai Resort 3BR C", 3, 3200),
];
check("plural: 3 same-community units → only 1 combo (2nd would reuse a URL)",
  suggestCityVrboComboPairs(threePool, [3, 3], 7, 5).length === 1, suggestCityVrboComboPairs(threePool, [3, 3], 7, 5).length);

// 6-6) WALKABILITY PRESERVED: after the one walkable combo, the only leftovers are
// single units in DIFFERENT non-adjacent communities → NO second (non-walkable)
// combo is ever fabricated to reach the limit.
const walkPool = [
  L("https://vrbo.com/w1", "Poipu Kai Resort 3BR A", 3, 3000),
  L("https://vrbo.com/w2", "Poipu Kai Resort 3BR B", 3, 3100),
  L("https://vrbo.com/w3", "Mauna Kai Princeville 3BR", 3, 2000), // far, lone
  L("https://vrbo.com/w4", "Kaha Lani Resort 3BR", 3, 1900),      // far, lone (different community)
];
const walkCombos = suggestCityVrboComboPairs(walkPool, [3, 3], 7, 5);
check("plural: never fabricates a non-walkable cross-community combo to fill the limit",
  walkCombos.length === 1 && walkCombos[0].resortPhrase === "poipu kai", walkCombos.map((c) => c.resortPhrase));

// 6-7) SPLIT DIVERSITY: a single community has both a 4+2 pair and a 3+3 pair for a
// [3,3] booking; the two surfaced combos use DIFFERENT splits and share no URL.
const splitDivPool = [
  L("https://vrbo.com/d1", "Poipu Kai Resort 3BR A", 3, 3000),
  L("https://vrbo.com/d2", "Poipu Kai Resort 3BR B", 3, 3000),
  L("https://vrbo.com/d3", "Poipu Kai Resort 4BR", 4, 2800),
  L("https://vrbo.com/d4", "Poipu Kai Resort 2BR", 2, 1900),
];
const splitDivCombos = suggestCityVrboComboPairs(splitDivPool, [3, 3], 7, 5);
const brSet = (c: CityVrboComboPairLike) => new Set(c.picks.map((p) => p.bedrooms));
check("plural: combo[0] is the cheaper 4+2 split", !!splitDivCombos[0] && brSet(splitDivCombos[0]).has(4) && brSet(splitDivCombos[0]).has(2), splitDivCombos[0]?.picks?.map((p) => p.bedrooms));
check("plural: combo[1] is the 3+3 split (different split, URL-disjoint)",
  !!splitDivCombos[1] && [...brSet(splitDivCombos[1])].every((b) => b === 3) && noDupUrls(splitDivCombos), splitDivCombos[1]?.picks?.map((p) => p.bedrooms));

// ── titlesShareWalkableCommunity: the attach-route proximity guard's
// cross-resort evidence check (2026-06-10 incident: a Puamana unit + a Wyndham
// Ka Eo Kai unit attached to one booking as a "4 minute walk" because geocoding
// failed and the configured-resort footprint fallback passed the gate).
check("guard: the actual incident pair (Puamana vs Wyndham Ka Eo Kai) is NOT same-community",
  !titlesShareWalkableCommunity(
    "Puamana Peaceful 3BR North Shore Stay",
    "Princeville Paradise 2BR Suite @ Wyndham Ka Eo Kai",
  ));
check("guard: same complex by dictionary ('Kaha Lani' both sides) IS same-community",
  titlesShareWalkableCommunity(
    "Kaha Lani Oceanfront Resort #129 - Beautiful and Private 2 B",
    "2 Bedroom Ocean View w/Lanai – Kaha Lani 107",
  ));
check("guard: same complex by phrase ('Poipu Kai Resort' both sides) IS same-community",
  titlesShareWalkableCommunity("Poipu Kai Resort 3BR A", "Poipu Kai Resort 2BR garden view"));
check("guard: curated-adjacent complexes (Poipu Kai + Kiahuna Plantation) ARE walkable together",
  titlesShareWalkableCommunity("Poipu Kai Resort 3BR ocean view", "Kiahuna Plantation #245 garden suite"));
check("guard: two GENERIC titles (no resort evidence either side) are NOT assumed same-community",
  !titlesShareWalkableCommunity("Ocean view 3BR with pool", "Beautiful 2BR condo near the beach"));
check("guard: generic title vs named complex is NOT same-community",
  !titlesShareWalkableCommunity("Ocean view 3BR with pool", "Poipu Kai Resort 2BR"));

// ── suggestUnconfirmedCityVrboComboPairs: last-resort recall over generic units ──
// The cheap units have generic titles the same-community gate can't cluster; this
// surfaces the cheapest combo anyway (operator verifies + auto-attach never uses it).
{
  const L = (url: string, title: string, br: number, total: number): CityVrboListing =>
    ({ url, title, bedrooms: br, totalPrice: total, sourceLabel: "Vrbo" });
  const pool = [
    L("u1", "Poipu Pool House: Ocean Views", 4, 4368),
    L("u2", "Gorgeous Greenbelt Home", 4, 4389),
    L("u3", "Villas at Poipu Kai Penthouse", 3, 9000),
    L("u4", "Beautiful 4 bedroom Poipu Kai", 4, 9664),
    L("u5", "Random 2BR condo", 2, 3000),
  ];
  const r = suggestUnconfirmedCityVrboComboPairs(pool, [3, 3], 7, 3, ["u3", "u4"]);
  check("unconfirmed: forms a combo from generic units", r.length >= 1, r.length);
  check("unconfirmed: every pair tagged unconfirmedCommunity", r.every((p) => p.unconfirmedCommunity === true));
  check("unconfirmed: cheapest combo wins (4BR+2BR $7368 beats the named pairs)", r[0]?.totalCost === 7368, r[0]?.totalCost);
  check("unconfirmed: never reuses excluded confirmed-pair urls", !r.some((p) => p.picks.some((x) => x.url === "u3" || x.url === "u4")));
  check("unconfirmed: combos are url-disjoint", (() => {
    const seen = new Set<string>();
    for (const p of r) for (const x of p.picks) { if (x.url && seen.has(x.url)) return false; if (x.url) seen.add(x.url); }
    return true;
  })());
  check("unconfirmed: <2 priced units → empty", suggestUnconfirmedCityVrboComboPairs([L("a", "x", 3, 0)], [3, 3], 7, 3).length === 0);
}

// ── ENRICH half: resolveUnitCommunityFromText + verifyResolvedUnitsShareCommunity ──
// The operator-click verify endpoint feeds the detail-page DESCRIPTION prose here
// (VRBO hides coords/address). A generic title that the matcher can't cluster STILL
// resolves once the description names the complex.
{
  // Generic title, but the description prose names the resort → resolves to a canonical.
  const a = resolveUnitCommunityFromText({
    title: "Poipu Pool House: Private Ocean Views",
    descriptionText: "Welcome to our home within the Poipu Kai resort, steps from Brennecke's Beach.",
  });
  check("enrich: description prose resolves a generic title to its complex", a.label === "poipu kai", a.label);
  check("enrich: dictCanonicals carries the resolved complex", a.dictCanonicals.includes("poipu kai"));

  // A title that names a complex resolves even with no description.
  const b = resolveUnitCommunityFromText({ title: "Nihi Kai Villas #300 by Parrish", descriptionText: "" });
  check("enrich: title-only still resolves a named complex", b.dictCanonicals.includes("nihi kai villas"), b.dictCanonicals);

  // Truly generic both ways → unresolved (no false positive).
  const c = resolveUnitCommunityFromText({ title: "Beautiful 2BR condo", descriptionText: "Cozy unit near the beach with a pool." });
  check("enrich: a generic unit with no complex named stays unresolved", c.label === null, c.label);

  // Two units, both resolving to Poipu Kai → same-community.
  check(
    "enrich verdict: same complex in both descriptions → same-community",
    verifyResolvedUnitsShareCommunity(a, resolveUnitCommunityFromText({ title: "Greenbelt home", descriptionText: "Located in Poipu Kai near the tennis courts." })) === "same-community",
  );
  // Poipu Kai + Kiahuna Plantation (curated cluster) → walkable-adjacent.
  check(
    "enrich verdict: curated-adjacent communities → walkable-adjacent",
    verifyResolvedUnitsShareCommunity(a, resolveUnitCommunityFromText({ title: "Garden suite", descriptionText: "A unit at Kiahuna Plantation with resort grounds." })) === "walkable-adjacent",
  );
  // Two distinct, non-adjacent dictionary communities → different.
  check(
    "enrich verdict: two distinct non-adjacent complexes → different",
    verifyResolvedUnitsShareCommunity(
      resolveUnitCommunityFromText({ title: "x", descriptionText: "Stay at the Cliffs at Princeville on the north shore." }),
      resolveUnitCommunityFromText({ title: "y", descriptionText: "Our condo is in Poipu Kai on the south shore." }),
    ) === "different",
  );
  // One side unresolved → overall unresolved (never a false positive).
  check(
    "enrich verdict: one side unresolved → unresolved",
    verifyResolvedUnitsShareCommunity(a, c) === "unresolved",
  );
}

console.log(`\ncity-vrbo-combo: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
