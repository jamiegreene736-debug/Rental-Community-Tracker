// Network-free unit tests for the community matcher's typo-tolerance + the
// complexName wiring. The PRECISION tests (a typo must never map to a DIFFERENT
// real complex) are the guard against over-clustering — the failure mode that
// would send a guest to two units in different communities.
import {
  comboSplitsForPlan,
  sharedResortPhraseKeys,
  suggestCityVrboComboPair,
  summarizeCityVrboMatching,
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

console.log(`\ncity-vrbo-combo: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
