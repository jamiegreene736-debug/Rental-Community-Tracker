// Network-free unit tests for the community matcher's typo-tolerance + the
// complexName wiring. The PRECISION tests (a typo must never map to a DIFFERENT
// real complex) are the guard against over-clustering — the failure mode that
// would send a guest to two units in different communities.
import {
  sharedResortPhraseKeys,
  suggestCityVrboComboPair,
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

// 4b) two DIFFERENT communities must NOT pair.
const noPairPool = [
  L("https://vrbo.com/x", "Poipu Kai Resort 3BR", 3, 3000),
  L("https://vrbo.com/y", "Kiahuna Plantation 2BR", 2, 2000),
];
const noPair = suggestCityVrboComboPair(noPairPool, [3, 2], 7);
check("e2e: Poipu Kai 3BR + Kiahuna 2BR → NO pair (different communities)", noPair === null, noPair);

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

console.log(`\ncity-vrbo-combo: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
