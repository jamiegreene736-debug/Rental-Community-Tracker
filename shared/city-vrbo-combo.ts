import { textMatchesResortPhrase } from "./buy-in-market";
import { haversineFeet, MAX_BUY_IN_WALK_MINUTES, walkMinutesFromFeet } from "./walking-distance";

export type CityVrboListing = {
  url: string;
  title: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  sleeps?: number | null;
  nightlyPrice?: number;
  totalPrice?: number;
  rating?: number | null;
  reviewCount?: number | null;
  lat?: number | null;
  lng?: number | null;
  sourceLabel?: string;
  locationText?: string | null;
  snippet?: string;
  image?: string;
  images?: string[];
  basicDetails?: string[];
  vrboId?: string;
  captureSource?: string;
  priceBasis?: string;
  priceIncludesTaxes?: boolean;
  priceIncludesFees?: boolean;
  availabilityOnly?: boolean;
  // Optional enrichment signals (populated by later harvest phases; safe when absent):
  //  - photoHashes: perceptual hashes of amenity/exterior photos (Phase: image hashing)
  //  - propertyManager: normalized PM/host name (e.g. "parrish kauai")
  //  - complexName: a confident community/complex name from detail-page enrichment
  photoHashes?: string[];
  propertyManager?: string | null;
  complexName?: string | null;
};

export type CommunityMatchSource =
  | "coords"
  | "dictionary"
  | "complex-name"
  | "shared-phrase"
  | "photo"
  | "property-manager"
  | "unknown";

export type CityVrboComboPair = {
  resortPhrase: string;
  bedrooms: number[];
  picks: CityVrboListing[];
  totalCost: number;
  walkMinutes: number | null;
  // Back-compat: kept as the old narrow union plus the new richer sources.
  walkSource: "coords" | "shared-phrase" | "unknown" | CommunityMatchSource;
  /** Which signal actually clustered this pair (most specific first). */
  matchSource?: CommunityMatchSource;
  /** Rough confidence in the "same community" claim for this pair. */
  matchConfidence?: "high" | "medium" | "low";
};

function normalizedIdentityText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Generic leading adjectives that decorate a title but are not part of a
// complex name ("Cozy Sunset Kahili 304" → "sunset kahili").
const GENERIC_TITLE_ADJECTIVES = new Set([
  "the", "a", "an", "your", "our", "new", "newly", "renovated", "remodeled",
  "beautiful", "lovely", "spacious", "modern", "luxury", "luxurious", "elegant",
  "stunning", "gorgeous", "charming", "cozy", "quaint", "tropical", "private",
  "amazing", "wonderful", "incredible", "breathtaking", "relaxing", "serene",
  "affordable", "best", "perfect", "ultimate", "premier", "exclusive", "grand",
  "oceanfront", "oceanview", "ocean", "beachfront", "beach", "seaside", "poolside",
  "ground", "top", "upper", "lower", "corner", "end", "entire", "whole",
  "stylish", "bright", "sunny", "peaceful", "romantic", "family", "deluxe", "premium",
]);

// Listing/structural words. A heuristic candidate containing ANY of these is
// boilerplate, not a complex name ("3 bedroom condo sleeps 8", "current price
// is", "photo gallery for") — reject the whole candidate.
const STRUCTURAL_STOPWORDS = new Set([
  "bedroom", "bedrooms", "bed", "beds", "bath", "baths", "bathroom", "bathrooms",
  "sleeps", "sleep", "condo", "condos", "apartment", "apt", "unit", "units",
  "studio", "studios", "home", "house", "houses", "villa", "villas", "townhome",
  "townhouse", "suite", "suites", "guest", "guests", "sqft", "ac", "wifi",
  "pool", "spa", "hot", "tub", "price", "prices", "reviews", "review", "rating",
  "night", "nights", "stay", "stays", "photo", "photos", "image", "images",
  "gallery", "previous", "next", "current", "from", "for", "with", "and", "the",
  "vrbo", "listing", "new", "minute", "weekly", "monthly", "view", "views",
  "of", "to", "in", "at", "on", "near", "steps", "walk", "min", "mins", "miles",
]);

// Bare place words that must never become a community key on their own.
const PLACE_STOPWORDS = new Set([
  "kauai", "hawaii", "hi", "usa", "us", "island",
  "koloa", "poipu", "kapaa", "kapaʻa", "wailua", "lihue", "princeville",
  "hanalei", "kekaha", "waimea", "kalaheo", "lawai", "kilauea", "anahola",
  "kailua", "kona", "honolulu", "kihei", "maui", "oahu",
]);

// High-precision dictionary of known Kauai (esp. Koloa/Poipu + Princeville)
// condo complexes. A dictionary hit is the strongest text signal. Extend as
// new complexes appear. Each canonical maps to a matcher run over the full
// title + snippet text (already normalized to lowercase alnum+spaces).
// `aliases` are EXACT (token-bounded) alternate spellings / known misspellings /
// abbreviations. They are the ONLY safe way to catch a typo of an
// "exact-only-unsafe" canonical (one whose name is within edit-distance 3 of a
// DIFFERENT real complex — e.g. "poipu kai" vs "poipu kapili"/"pono kai"), where
// fuzzy matching would risk pairing a guest across two communities. The headline
// case "Poipu Kie" → poipu kai lives here, NOT in the fuzzy matcher. Extend as
// production scrapes reveal new variants.
const KAUAI_COMPLEX_DICTIONARY: Array<{ canonical: string; match: RegExp; aliases?: string[] }> = [
  { canonical: "poipu kai", match: /\bpoipu kai\b|\bregency at poipu\b|\bvillas at poipu kai\b/,
    aliases: ["poipu kie", "poipu kia", "poipu kay", "poipu key", "poepu kai", "poipu kai resort", "regency at poipu kai", "the regency at poipu"] },
  { canonical: "poipu kapili", match: /\bpoipu kapili\b/, aliases: ["poipu kapilli", "poipu kapil", "poipukapili"] },
  { canonical: "kiahuna plantation", match: /\bkiahuna\b/, aliases: ["kiahuna plantation", "kiahuna resort"] },
  { canonical: "nihi kai villas", match: /\bnihi kai\b/, aliases: ["nihikai", "nihi kai villas"] },
  { canonical: "poipu sands", match: /\bpoipu sands\b/ },
  { canonical: "poipu crater", match: /\bpoipu crater\b/, aliases: ["poipu crater resort"] },
  { canonical: "poipu shores", match: /\bpoipu shores\b/ },
  { canonical: "koloa landing", match: /\bkoloa landing\b/, aliases: ["koloa landing resort"] },
  { canonical: "sunset kahili", match: /\bsunset kahili\b/, aliases: ["sunset kahilli", "sunset kihili"] },
  { canonical: "kuhio shores", match: /\bkuhio shores\b/ },
  { canonical: "makahuena", match: /\bmakahuena\b/, aliases: ["makahuena at poipu", "makaheuna", "makahuna"] },
  { canonical: "pili mai", match: /\bpili mai\b/, aliases: ["pilimai", "pili mai at poipu", "pili mai resort"] },
  { canonical: "waikomo stream villas", match: /\bwaikomo\b/, aliases: ["waikomo stream", "waikomo streams"] },
  { canonical: "whalers cove", match: /\bwhalers? cove\b/ },
  { canonical: "point at poipu", match: /\bpoint at poipu\b/, aliases: ["the point at poipu", "points at poipu"] },
  { canonical: "lawai beach resort", match: /\blawai beach\b/, aliases: ["lawai beach resort"] },
  { canonical: "prince kuhio", match: /\bprince kuhio\b/ },
  { canonical: "manualoha", match: /\bmanualoha\b/, aliases: ["manualoha at poipu", "manaloha"] },
  { canonical: "alihi lani", match: /\balihi lani\b/, aliases: ["alihilani", "alihi lani poipu"] },
  { canonical: "kahala at poipu", match: /\bkahala at poipu\b/, aliases: ["the kahala at poipu", "kahala poipu"] },
  // Princeville / north shore
  { canonical: "hanalei bay resort", match: /\bhanalei bay resort\b/, aliases: ["hanalei bay villas"] },
  { canonical: "puu poa", match: /\bpuu poa\b|\bpu'?u po'?a\b/, aliases: ["puu poa", "puupoa"] },
  { canonical: "sealodge", match: /\bsealodge\b|\bsea lodge\b/ },
  { canonical: "alii kai", match: /\balii kai\b|\bali'?i kai\b/, aliases: ["alii kai princeville"] },
  { canonical: "hanalei colony resort", match: /\bhanalei colony\b/ },
  { canonical: "mauna kai", match: /\bmauna kai\b/, aliases: ["mauna kai princeville"] },
  { canonical: "the cliffs at princeville", match: /\bcliffs?\s+(?:at\s+|of\s+)?princeville\b|\bprinceville\s+cliffs?\b|\bcliffs?\s+club\b/ },
  // Kapaa / east side
  { canonical: "kaha lani", match: /\bkaha lani\b/, aliases: ["kahalani", "kaha lani resort"] },
  { canonical: "lae nani", match: /\blae nani\b/, aliases: ["laenani"] },
  { canonical: "lanikai", match: /\blanikai\b/ },
  { canonical: "kapaa shore", match: /\bkapaa shore\b/, aliases: ["kapaa shores", "kapaa sands"] },
  { canonical: "pono kai", match: /\bpono kai\b/, aliases: ["ponokai", "pono kai resort"] },
  { canonical: "wailua bay view", match: /\bwailua bay view\b/ },
];

// ── Typo-tolerant dictionary matching ────────────────────────────────────────
// Two layers, both high-precision:
//   1) EXACT regex + curated `aliases` (token-bounded substring) — always on.
//   2) FUZZY match (Damerau-Levenshtein + Jaro-Winkler over equal-token windows)
//      — applied ONLY to canonicals proven safe (nearest same-token-count sibling
//      is >= EDIT distance 4 apart) so a typo can never be mistaken for a
//      DIFFERENT real complex. The best canonical must also beat the second-best
//      by a Jaro-Winkler margin. Thresholds were chosen via an exhaustive
//      single-edit-typo sweep over the dictionary (0 cross-complex false accepts).
const FUZZY_JW_MIN = 0.9;       // Jaro-Winkler floor for a candidate match
const FUZZY_NDL_MAX = 0.34;     // normalized Damerau-Levenshtein ceiling
const FUZZY_JW_MARGIN = 0.06;   // best canonical must beat 2nd-best by this JW gap
const FUZZY_MIN_CANONICAL_LEN = 7; // shorter canonicals are too collision-prone

function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i += 1) d[i][0] = i;
  for (let j = 0; j <= bl; j += 1) d[0][j] = j;
  for (let i = 1; i <= al; i += 1) {
    for (let j = 1; j <= bl; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const al = a.length;
  const bl = b.length;
  if (al === 0 || bl === 0) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(al, bl) / 2) - 1);
  const aMatch = new Array(al).fill(false);
  const bMatch = new Array(bl).fill(false);
  let matches = 0;
  for (let i = 0; i < al; i += 1) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, bl);
    for (let j = start; j < end; j += 1) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < al; i += 1) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;
  const jaro = (matches / al + matches / bl + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, al, bl);
  for (let i = 0; i < maxPrefix; i += 1) {
    if (a[i] === b[i]) prefix += 1;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

const DICT_ENTRIES = KAUAI_COMPLEX_DICTIONARY.map((e) => ({
  canonical: e.canonical,
  tokens: e.canonical.split(" "),
  aliases: e.aliases ?? [],
}));

// A canonical is FUZZY-SAFE iff its nearest same-token-count sibling is at least
// EDIT distance 4 away (so no single/double typo can blur it into another real
// complex) and it is long enough to be distinctive. Computed once at load so the
// set self-maintains as the dictionary grows.
const FUZZY_SAFE_CANONICALS: Set<string> = (() => {
  const safe = new Set<string>();
  for (const e of DICT_ENTRIES) {
    if (e.canonical.length < FUZZY_MIN_CANONICAL_LEN) continue;
    let minSibling = Infinity;
    for (const o of DICT_ENTRIES) {
      if (o.canonical === e.canonical || o.tokens.length !== e.tokens.length) continue;
      minSibling = Math.min(minSibling, damerauLevenshtein(e.canonical, o.canonical));
    }
    if (minSibling >= 4) safe.add(e.canonical);
  }
  return safe;
})();

/** True when `text` contains the alias as a whole-token run. */
function textHasAlias(text: string, alias: string): boolean {
  if (!alias) return false;
  return ` ${text} `.includes(` ${alias} `);
}

/**
 * Resolve a piece of text (a title, sourceLabel, or an enrichment/LLM-supplied
 * complexName) to a dictionary canonical via exact regex → curated alias →
 * fuzzy-safe match. Returns the canonical or null. Never returns an
 * exact-only-unsafe canonical from a fuzzy guess.
 */
function dictionaryCanonicalForText(text: string): string | null {
  const norm = normalizedIdentityText(text);
  if (!norm) return null;
  // 1) exact regex / curated alias (covers exact-only-unsafe canonicals).
  for (const entry of KAUAI_COMPLEX_DICTIONARY) {
    if (entry.match.test(norm)) return entry.canonical;
    if ((entry.aliases ?? []).some((a) => textHasAlias(norm, a))) return entry.canonical;
  }
  // 2) fuzzy over equal-token windows, fuzzy-safe canonicals only, with a
  //    best-vs-second-best Jaro-Winkler margin so an ambiguous typo is rejected.
  const tokens = norm.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const bestJwPerCanonical = new Map<string, number>();
  for (const e of DICT_ENTRIES) {
    if (!FUZZY_SAFE_CANONICALS.has(e.canonical)) continue;
    const n = e.tokens.length;
    for (let i = 0; i + n <= tokens.length; i += 1) {
      const window = tokens.slice(i, i + n).join(" ");
      if (window.length < 6 || window === e.canonical) continue; // exact handled above
      const dl = damerauLevenshtein(window, e.canonical);
      const nd = dl / Math.max(window.length, e.canonical.length);
      if (nd > FUZZY_NDL_MAX) continue;
      const jw = jaroWinkler(window, e.canonical);
      if (jw < FUZZY_JW_MIN) continue;
      const prev = bestJwPerCanonical.get(e.canonical) ?? 0;
      if (jw > prev) bestJwPerCanonical.set(e.canonical, jw);
    }
  }
  if (bestJwPerCanonical.size === 0) return null;
  const ranked = Array.from(bestJwPerCanonical.entries()).sort((a, b) => b[1] - a[1]);
  const [bestCanonical, bestJw] = ranked[0];
  const secondJw = ranked[1]?.[1] ?? 0;
  if (ranked.length > 1 && bestJw - secondJw < FUZZY_JW_MARGIN) return null; // ambiguous
  return bestCanonical;
}

function isGenericRentalTitle(value: string): boolean {
  const t = normalizedIdentityText(value);
  if (!t) return true;
  if (/^(?:condo|apartment|townhouse|home|house|villa|rental unit|guest suite|loft|cottage|bungalow|place)\s+in\s+[a-z ]+$/.test(t)) return true;
  if (/^(?:beautiful|lovely|spacious|modern|luxury|elegant)?\s*(?:\d+\s*(?:br|bedroom)\s*)?(?:condo|apartment|townhouse|home|house|villa|rental)$/.test(t)) return true;
  return false;
}

/** Strip leading generic adjectives, then reject pure place / generic phrases. */
function cleanComplexCandidate(phrase: string): string | null {
  let tokens = normalizedIdentityText(phrase).split(/\s+/).filter(Boolean);
  while (tokens.length && GENERIC_TITLE_ADJECTIVES.has(tokens[0])) tokens.shift();
  while (tokens.length && GENERIC_TITLE_ADJECTIVES.has(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length < 2) return null; // single-word leads are too ambiguous
  // Any structural/boilerplate token disqualifies the whole candidate.
  if (tokens.some((tok) => STRUCTURAL_STOPWORDS.has(tok))) return null;
  // Reject phrases that are ONLY place words (e.g. "koloa kauai", "poipu beach").
  if (tokens.every((tok) => PLACE_STOPWORDS.has(tok))) return null;
  // Reject place + type-word phrases ("kauai resort", "poipu beach") while
  // keeping brand/proper-noun + place + type ("sheraton kauai resort").
  const TYPE_WORDS = new Set(["resort", "resorts", "hotel", "club", "spa", "beach"]);
  const meaningful = tokens.filter((tok) => !TYPE_WORDS.has(tok));
  if (meaningful.length === 0 || meaningful.every((tok) => PLACE_STOPWORDS.has(tok))) return null;
  // Every token must be a real word (>=3 chars) — kills stray "a b 12" fragments.
  if (tokens.some((tok) => tok.length < 3)) return null;
  const key = tokens.join(" ");
  if (key.length < 8) return null;
  if (isGenericRentalTitle(key)) return null;
  return key;
}

/**
 * Strong community keys from a listing's text (title + sourceLabel + snippet):
 * dictionary hits, the classic resort/villas/plantation phrases, and a
 * complex-name-before-unit-number heuristic. A listing can yield several.
 */
export function sharedResortPhraseKeys(
  candidate: Pick<CityVrboListing, "title" | "sourceLabel" | "snippet" | "complexName">,
): string[] {
  // Dictionary may scan the snippet too (its terms are specific multi-word
  // complex names). The heuristic + classic-phrase + FUZZY scans use the TITLE
  // only: VRBO card snippets are full of UI boilerplate ("current price is 450",
  // "photo gallery for", "condo sleeps 8") that the unit-number heuristic / fuzzy
  // matcher would otherwise turn into junk clusters.
  const titleText = normalizedIdentityText([candidate.title, candidate.sourceLabel].filter(Boolean).join(" "));
  const fullText = normalizedIdentityText([candidate.title, candidate.sourceLabel, candidate.snippet].filter(Boolean).join(" "));
  const keys = new Set<string>();

  // 0) Structured community name from detail-page enrichment OR the conservative
  //    LLM classifier (city-vrbo-community-llm.ts). Resolve it to a dictionary
  //    canonical (exact/alias/fuzzy); otherwise keep it as a complex key if it's
  //    a specific name (NOT a bare place/generic word). This is what lets a
  //    GENERIC-titled listing ("Ocean view 3BR") cluster once a high-confidence
  //    source has named its community.
  if (candidate.complexName) {
    const cn = normalizedIdentityText(candidate.complexName);
    const canonical = dictionaryCanonicalForText(cn);
    if (canonical) {
      keys.add(`dict:${canonical}`);
    } else {
      const cleaned = cleanComplexCandidate(cn);
      if (cleaned) {
        keys.add(`complex:${cleaned}`);
      } else {
        // Allow a single SPECIFIC token (e.g. "kamalii", "manualoha") — vetted
        // upstream (enrichment/high-confidence LLM), so a one-word name is OK
        // here even though the title heuristic rejects single-word leads.
        const toks = cn.split(/\s+/).filter(Boolean);
        if (
          toks.length === 1 && toks[0].length >= 6 &&
          !PLACE_STOPWORDS.has(toks[0]) && !STRUCTURAL_STOPWORDS.has(toks[0]) &&
          !isGenericRentalTitle(toks[0])
        ) {
          keys.add(`complex:${toks[0]}`);
        }
      }
    }
  }

  if (!fullText) return Array.from(keys);

  // 1) Dictionary (highest precision) — exact regex over title + snippet, PLUS a
  //    typo-tolerant alias/fuzzy pass over the TITLE (not the snippet) so a
  //    misspelled complex ("Poipu Kie" → poipu kai via alias; "Sunset Kahilli" →
  //    sunset kahili via fuzzy) still clusters with the correctly-spelled ones.
  for (const entry of KAUAI_COMPLEX_DICTIONARY) {
    if (entry.match.test(fullText)) keys.add(`dict:${entry.canonical}`);
  }
  const fuzzyCanonical = dictionaryCanonicalForText(titleText);
  if (fuzzyCanonical) keys.add(`dict:${fuzzyCanonical}`);

  const text = titleText;
  if (!text) return Array.from(keys);

  // 2) Classic suffix phrases ("X villas / X resort / X plantation / villas of X").
  const phrasePatterns = [
    /\b(villas? of [a-z0-9 ]{3,40}?)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? villas?)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? resort)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? plantation)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
  ];
  for (const pattern of phrasePatterns) {
    for (const match of text.matchAll(pattern)) {
      const key = normalizedIdentityText(match[1]);
      if (key.length < 10 || isGenericRentalTitle(key)) continue;
      // Reject phrases that are just a place + type word ("kauai resort",
      // "poipu villas") — those over-cluster unrelated listings.
      const lead = key.split(/\s+/).filter((t) => !/^(resort|villas?|plantation|of)$/.test(t));
      if (lead.length === 0 || lead.every((t) => PLACE_STOPWORDS.has(t))) continue;
      keys.add(`phrase:${key}`);
    }
  }

  // 3) Complex-name-before-unit-number heuristic. Take up to 3 words immediately
  //    before a unit token ("#523", "304", "4201", "bldg 7"), clean them, and
  //    keep the result if it isn't a pure place/generic phrase. e.g.
  //    "cozy sunset kahili 304" → "sunset kahili"; "poipu kapili 402" → "poipu kapili".
  for (const m of text.matchAll(/((?:[a-z']+\s+){1,3})#?\d{1,4}\b/g)) {
    const cleaned = cleanComplexCandidate(m[1]);
    if (cleaned) keys.add(`complex:${cleaned}`);
  }
  // Building/letter units ("nalo studio a", "building 38") — capture the lead.
  for (const m of text.matchAll(/((?:[a-z']+\s+){1,3})(?:bldg|building)\s+\d{1,3}\b/g)) {
    const cleaned = cleanComplexCandidate(m[1]);
    if (cleaned) keys.add(`complex:${cleaned}`);
  }

  return Array.from(keys);
}

/** Weak signal: property manager / host suffix ("... By Parrish Kauai"). */
export function propertyManagerKey(
  candidate: Pick<CityVrboListing, "title" | "sourceLabel" | "snippet" | "propertyManager">,
): string | null {
  if (candidate.propertyManager) {
    const pm = normalizedIdentityText(candidate.propertyManager);
    return pm ? `pm:${pm}` : null;
  }
  const raw = [candidate.title, candidate.snippet, candidate.sourceLabel].filter(Boolean).join(" ");
  const m = raw.match(/\bby\s+([A-Za-z][A-Za-z&'. ]{2,30}?)(?:\s*[-:|,]|\s+(?:vacation|rentals?|realty|properties|management|kauai)\b|$)/i);
  if (!m) return null;
  const pm = normalizedIdentityText(m[1]);
  // Reject 1-word generic captures.
  if (!pm || pm.split(" ").length < 2 || isGenericRentalTitle(pm)) return null;
  return `pm:${pm}`;
}

/** A short human label for a community key (drops the kind prefix). */
export function communityKeyLabel(key: string): string {
  const idx = key.indexOf(":");
  return idx >= 0 ? key.slice(idx + 1) : key;
}

export function listingTotalPrice(listing: CityVrboListing, nights: number): number {
  if (listing.totalPrice && listing.totalPrice > 0) return listing.totalPrice;
  if (listing.nightlyPrice && listing.nightlyPrice > 0) return listing.nightlyPrice * Math.max(1, nights);
  return 0;
}

function walkMinutesBetween(a: CityVrboListing, b: CityVrboListing): number | null {
  const latA = typeof a.lat === "number" ? a.lat : null;
  const lngA = typeof a.lng === "number" ? a.lng : null;
  const latB = typeof b.lat === "number" ? b.lat : null;
  const lngB = typeof b.lng === "number" ? b.lng : null;
  if (latA === null || lngA === null || latB === null || lngB === null) return null;
  const feet = haversineFeet(latA, lngA, latB, lngB);
  return walkMinutesFromFeet(feet);
}

/** True when two listings share at least one near-duplicate amenity photo hash. */
function sharedPhotoHash(a: CityVrboListing, b: CityVrboListing): boolean {
  const aHashes = a.photoHashes;
  const bHashes = b.photoHashes;
  if (!aHashes?.length || !bHashes?.length) return false;
  const set = new Set(aHashes);
  return bHashes.some((h) => set.has(h));
}

/**
 * Stable signature of a VRBO image URL: drop the query string and CDN size
 * segments so the same underlying photo file matches across listings even when
 * served at different sizes. Two listings reusing the same hero/amenity photo
 * are almost always the same complex (a PM reusing the building/pool shot) — or
 * the same unit relisted, which the same-unit guard below filters out of pairs.
 */
function imageSignature(url: string | undefined | null): string | null {
  const raw = String(url ?? "").trim();
  if (!raw || !/^https?:/i.test(raw)) return null;
  let path = raw.split("?")[0].toLowerCase();
  path = path.replace(/^https?:\/\/[^/]+/, "");           // drop host
  path = path.replace(/\.(?:jpg|jpeg|png|webp|avif)$/i, ""); // drop extension
  // Drop a leading size/policy segment some CDNs prepend (e.g. /b_1280x720/).
  path = path.replace(/\/[a-z]_\d+x\d+\//, "/");
  return path.length >= 12 ? `imgurl:${path}` : null;
}

function imageSignatureKeys(listing: CityVrboListing): string[] {
  const urls = [listing.image, ...(listing.images ?? [])].filter(Boolean) as string[];
  const keys = new Set<string>();
  for (const u of urls) {
    const sig = imageSignature(u);
    if (sig) keys.add(sig);
  }
  return Array.from(keys);
}

/** Same physical unit relisted (so it can't be one half of a 2-unit combo). */
function looksLikeSameUnit(a: CityVrboListing, b: CityVrboListing): boolean {
  const ta = normalizedIdentityText(a.title);
  const tb = normalizedIdentityText(b.title);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  const short = ta.length <= tb.length ? ta : tb;
  const long = ta.length <= tb.length ? tb : ta;
  return short.length >= 16 && long.startsWith(short);
}

export function pairIsWalkable(picks: CityVrboListing[]): {
  ok: boolean;
  walkMinutes: number | null;
  walkSource: CityVrboComboPair["walkSource"];
} {
  if (picks.length < 2) return { ok: true, walkMinutes: null, walkSource: "unknown" };
  const a = picks[0];
  const b = picks[1];

  // Coordinates, when present, are the authoritative walkability check.
  const minutes = walkMinutesBetween(a, b);
  if (minutes !== null) {
    return { ok: minutes <= MAX_BUY_IN_WALK_MINUTES, walkMinutes: minutes, walkSource: "coords" };
  }
  // Shared amenity photo → same building/complex.
  if (sharedPhotoHash(a, b)) return { ok: true, walkMinutes: null, walkSource: "photo" };
  // Shared strong text key → same named complex (assumed walkable).
  const aKeys = new Set(sharedResortPhraseKeys(a));
  if (aKeys.size > 0 && sharedResortPhraseKeys(b).some((key) => aKeys.has(key))) {
    return { ok: true, walkMinutes: null, walkSource: "shared-phrase" };
  }
  return { ok: false, walkMinutes: null, walkSource: "unknown" };
}

type ScoredRow = { listing: CityVrboListing; total: number; br: number };

function pickCheapestPlan(bucket: ScoredRow[], plan: number[]): CityVrboListing[] | null {
  const picks: CityVrboListing[] = [];
  const usedUrls = new Set<string>();
  for (const targetBr of plan) {
    const match = bucket
      .filter((row) => row.br === targetBr && !usedUrls.has(row.listing.url))
      .sort((a, b) => a.total - b.total)[0];
    if (!match) return null;
    usedUrls.add(match.listing.url);
    picks.push(match.listing);
  }
  return picks;
}

/**
 * Walkability decision for a pair, aware of WHICH signal clustered it:
 *  - geo / property-manager clusters REQUIRE coordinate-confirmed walkability
 *    (geo IS the coords; PM alone spans the whole town, so it must be confirmed).
 *  - dictionary / complex / phrase / photo clusters are authoritative on their
 *    own — coordinates only ANNOTATE (near → upgrade the label). Enrichment
 *    coords can be stale/shared/parse-errored, so they must NOT *reject* a real
 *    text/photo pair (that was a Phase-4 regression: a good "Point at Poipu 721"
 *    + "Point at Poipu 812" pair getting dropped on slightly-off coords).
 */
function pairWalkability(
  picks: CityVrboListing[],
  source: CommunityMatchSource,
): { ok: boolean; walkMinutes: number | null; walkSource: CityVrboComboPair["walkSource"] } {
  if (picks.length < 2) return { ok: true, walkMinutes: null, walkSource: "unknown" };
  const minutes = walkMinutesBetween(picks[0], picks[1]); // null when coords absent
  const coordsNear = minutes !== null && minutes <= MAX_BUY_IN_WALK_MINUTES;
  if (source === "coords" || source === "property-manager") {
    return { ok: coordsNear, walkMinutes: minutes, walkSource: "coords" };
  }
  const fallback: CityVrboComboPair["walkSource"] = source === "photo" ? "photo" : "shared-phrase";
  return { ok: true, walkMinutes: minutes, walkSource: coordsNear ? "coords" : fallback };
}

function confidenceFor(source: CommunityMatchSource): "high" | "medium" | "low" {
  switch (source) {
    case "coords":
    case "dictionary":
    case "photo":
      return "high";
    case "complex-name":
    case "shared-phrase":
      return "medium";
    default:
      return "low";
  }
}

/**
 * Geo-proximity clusters via union-find: any two listings within
 * MAX_BUY_IN_WALK_MINUTES of each other (by coords) join the same cluster, so a
 * connected run of nearby units becomes one "community". Only listings carrying
 * lat/lng participate — coordinates are populated by detail-page enrichment
 * (Phase 4), since the VRBO SRP/map don't expose them. O(n^2) over the priced
 * pool (~140), which is trivial at this scale.
 */
function buildGeoClusters(rows: ScoredRow[]): Map<string, ScoredRow[]> {
  // NOTE: must check `!= null` BEFORE Number() — Number(null) === 0 passes
  // Number.isFinite, which would smear coordless listings to (0,0) and cluster
  // them together with bogus distances. (Caught in Phase 4 review.)
  const pts = rows.filter(
    (r) =>
      r.listing.lat != null &&
      r.listing.lng != null &&
      Number.isFinite(Number(r.listing.lat)) &&
      Number.isFinite(Number(r.listing.lng)),
  );
  const n = pts.length;
  const parent = pts.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = pts[i].listing;
      const b = pts[j].listing;
      const feet = haversineFeet(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
      if (walkMinutesFromFeet(feet) <= MAX_BUY_IN_WALK_MINUTES) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<string, ScoredRow[]>();
  for (let i = 0; i < n; i += 1) {
    const key = `geo:${find(i)}`;
    const bucket = clusters.get(key) ?? [];
    bucket.push(pts[i]);
    clusters.set(key, bucket);
  }
  return clusters;
}

function matchSourceForKey(key: string): CommunityMatchSource {
  if (key.startsWith("dict:")) return "dictionary";
  if (key.startsWith("complex:")) return "complex-name";
  if (key.startsWith("phrase:")) return "shared-phrase";
  if (key.startsWith("geo:")) return "coords";
  if (key.startsWith("img:") || key.startsWith("imgurl:")) return "photo";
  if (key.startsWith("pm:")) return "property-manager";
  return "unknown";
}

/**
 * Cluster-first pairing. Every "same-community" signal (dictionary, complex
 * name, classic phrase, photo hash, geo proximity, and — as a last resort —
 * property manager) contributes cluster keys; we then pick the cheapest pair
 * matching the bedroom plan within a single cluster. Coordinates, when present,
 * still gate walkability so a cluster can't pair two far-apart units.
 *
 * This replaces the old "title-phrase bucket only" gate, which left genuine
 * same-complex units (different/generic titles) unpaired.
 */
export function suggestCityVrboComboPair(
  listings: CityVrboListing[],
  bedroomPlan: number[],
  nights: number,
): CityVrboComboPair | null {
  const plan = bedroomPlan.filter((br) => Number.isFinite(br) && br > 0);
  // Need at least two slots to form a pair. A same-bedroom plan (e.g. Steve's
  // 3BR+3BR) is valid — pickCheapestPlan dedups by URL so we pick two DISTINCT
  // units. (The old guard `uniquePlan.length < 2` wrongly rejected same-bedroom
  // plans entirely, which is why a 3BR+3BR booking never got a suggested pair.)
  if (plan.length < 2) return null;

  const priced: ScoredRow[] = listings
    .map((listing) => ({
      listing,
      total: listingTotalPrice(listing, nights),
      br: typeof listing.bedrooms === "number" && Number.isFinite(listing.bedrooms) ? Math.round(listing.bedrooms) : 0,
    }))
    .filter((row) => row.total > 0 && row.br > 0);

  // Strong clusters: dictionary / complex-name / classic phrase / geo / photo.
  // Geo + photo cluster keys are attached upstream (later phases); we also build
  // photo clusters here opportunistically from photoHashes.
  const strongBuckets = new Map<string, ScoredRow[]>();
  const pmBuckets = new Map<string, ScoredRow[]>();
  const photoBuckets = new Map<string, ScoredRow[]>();

  for (const row of priced) {
    for (const key of sharedResortPhraseKeys(row.listing)) {
      const bucket = strongBuckets.get(key) ?? [];
      bucket.push(row);
      strongBuckets.set(key, bucket);
    }
    for (const h of row.listing.photoHashes ?? []) {
      const key = `img:${h}`;
      const bucket = photoBuckets.get(key) ?? [];
      bucket.push(row);
      photoBuckets.set(key, bucket);
    }
    for (const key of imageSignatureKeys(row.listing)) {
      const bucket = photoBuckets.get(key) ?? [];
      bucket.push(row);
      photoBuckets.set(key, bucket);
    }
    const pm = propertyManagerKey(row.listing);
    if (pm) {
      const bucket = pmBuckets.get(pm) ?? [];
      bucket.push(row);
      pmBuckets.set(pm, bucket);
    }
  }

  const evaluate = (buckets: Map<string, ScoredRow[]>, opts: { guardSameUnit?: boolean } = {}): CityVrboComboPair | null => {
    let best: CityVrboComboPair | null = null;
    for (const [key, bucket] of buckets) {
      if (bucket.length < plan.length) continue;
      const picks = pickCheapestPlan(bucket, plan);
      if (!picks) continue;
      // Photo/URL clusters can group the SAME physical unit relisted (same hero
      // photo, near-identical title). Those can't be two halves of one combo.
      if (opts.guardSameUnit && picks.some((p, i) => picks.some((q, j) => j > i && looksLikeSameUnit(p, q)))) continue;
      const source = matchSourceForKey(key);
      const walk = pairWalkability(picks, source);
      if (!walk.ok) continue;
      const totalCost = picks.reduce((sum, pick) => sum + listingTotalPrice(pick, nights), 0);
      if (!best || totalCost < best.totalCost) {
        best = {
          resortPhrase: communityKeyLabel(key),
          bedrooms: plan,
          picks,
          totalCost,
          walkMinutes: walk.walkMinutes,
          walkSource: walk.walkSource,
          matchSource: source,
          matchConfidence: confidenceFor(source),
        };
      }
    }
    return best;
  };

  // Prefer high-confidence strong/photo clusters; fall back to property-manager
  // clusters only when nothing stronger pairs (PM alone can span the whole town,
  // so it is the lowest-confidence suggestion and is flagged as such).
  const strongPair = evaluate(strongBuckets);
  const photoPair = evaluate(photoBuckets, { guardSameUnit: true });
  // Geo clusters (Phase 4): listings within walking distance of each other form
  // a community even when titles/photos give nothing. High confidence — coords
  // directly prove walkability. guardSameUnit drops a relisted-unit pairing.
  const geoPair = evaluate(buildGeoClusters(priced), { guardSameUnit: true });
  const candidates = [strongPair, photoPair, geoPair].filter((p): p is CityVrboComboPair => !!p);
  if (candidates.length) {
    candidates.sort((a, b) => a.totalCost - b.totalCost);
    return candidates[0];
  }
  // PM fallback — pairWalkability requires coordinate-confirmed walkability for
  // PM clusters (one PM spans the whole town), so a PM pair only survives when
  // coords place the two units within walking distance. Medium confidence.
  const pmPair = evaluate(pmBuckets);
  if (pmPair) {
    return { ...pmPair, matchSource: "property-manager", matchConfidence: "medium" };
  }
  return null;
}

/** Optional operator phrase (e.g. Kamalii) applied to the in-memory scrape pool before pairing. */
export function filterCityVrboListingsByPhrase(listings: CityVrboListing[], phrase: string): CityVrboListing[] {
  const trimmed = String(phrase ?? "").trim();
  if (!trimmed) return listings;
  return listings.filter((listing) =>
    textMatchesResortPhrase(`${listing.title ?? ""} ${listing.sourceLabel ?? ""} ${listing.snippet ?? ""}`, trimmed),
  );
}

export function countCityVrboPhraseBuckets(listings: CityVrboListing[]): number {
  const keys = new Set<string>();
  for (const listing of listings) {
    const phraseKey = sharedResortPhraseKeys(listing)[0];
    if (phraseKey) keys.add(phraseKey);
  }
  return keys.size;
}

export function groupCityVrboByBedroom(listings: CityVrboListing[]): Map<number, CityVrboListing[]> {
  const map = new Map<number, CityVrboListing[]>();
  for (const listing of listings) {
    const br = typeof listing.bedrooms === "number" && Number.isFinite(listing.bedrooms)
      ? Math.round(listing.bedrooms)
      : 0;
    if (br <= 0) continue;
    const bucket = map.get(br) ?? [];
    bucket.push(listing);
    map.set(br, bucket);
  }
  for (const [br, bucket] of map) {
    bucket.sort((a, b) => listingTotalPrice(a, 1) - listingTotalPrice(b, 1));
    map.set(br, bucket);
  }
  return map;
}

export type CityVrboMatchDiagnostics = {
  pricedTotal: number;
  matched: number;
  unmatched: number;
  /** Each priced listing counted once, by its STRONGEST community signal. */
  bySignal: {
    dictionary: number;
    complex: number;
    phrase: number;
    photo: number;
    propertyManager: number;
    none: number;
  };
  /** Cluster keys that hold >= bedroomPlan.length listings AND can satisfy the
   *  bedroom plan with distinct units (i.e. could actually form a pair). */
  pairableClusters: number;
  /** Largest clusters (any signal) for eyeballing what's grouping (and whether a
   *  property-manager / boilerplate phrase is dominating — the over-cluster trap). */
  topClusters: Array<{ label: string; source: CommunityMatchSource; size: number; bedrooms: number[] }>;
  /** Titles of priced listings with NO community signal at all — the population a
   *  text-frequency / extra matching layer would need to rescue. */
  unmatchedSample: Array<{ title: string; bedrooms: number | null }>;
};

/**
 * Read-only instrumentation: for the priced pool, report how many listings got a
 * community signal (and which kind), how many clusters could actually pair, and a
 * sample of the listings that matched NOTHING. This is a measurement tool to
 * decide whether more matching machinery (text-frequency mining, etc.) is worth
 * it — and to expose the property-manager / boilerplate over-cluster trap if a
 * huge low-precision cluster shows up in `topClusters`. Does not affect pairing.
 */
export function summarizeCityVrboMatching(
  listings: CityVrboListing[],
  bedroomPlan: number[],
  nights: number,
): CityVrboMatchDiagnostics {
  const plan = bedroomPlan.filter((b) => Number.isFinite(b) && b > 0);
  const priced = listings
    .map((l) => ({
      l,
      total: listingTotalPrice(l, nights),
      br: typeof l.bedrooms === "number" && Number.isFinite(l.bedrooms) ? Math.round(l.bedrooms) : 0,
    }))
    .filter((r) => r.total > 0 && r.br > 0);

  const bySignal = { dictionary: 0, complex: 0, phrase: 0, photo: 0, propertyManager: 0, none: 0 };
  const unmatchedSample: Array<{ title: string; bedrooms: number | null }> = [];
  const buckets = new Map<string, { source: CommunityMatchSource; rows: typeof priced }>();
  let matched = 0;

  for (const row of priced) {
    const textKeys = sharedResortPhraseKeys(row.l);
    const photoKeys = [...imageSignatureKeys(row.l), ...((row.l.photoHashes ?? []).map((h) => `img:${h}`))];
    const pm = propertyManagerKey(row.l);
    for (const key of [...textKeys, ...photoKeys, ...(pm ? [pm] : [])]) {
      const b = buckets.get(key) ?? { source: matchSourceForKey(key), rows: [] as typeof priced };
      b.rows.push(row);
      buckets.set(key, b);
    }
    let best: keyof typeof bySignal = "none";
    if (textKeys.some((k) => k.startsWith("dict:"))) best = "dictionary";
    else if (textKeys.some((k) => k.startsWith("complex:"))) best = "complex";
    else if (textKeys.some((k) => k.startsWith("phrase:"))) best = "phrase";
    else if (photoKeys.length) best = "photo";
    else if (pm) best = "propertyManager";
    bySignal[best] += 1;
    if (best === "none") {
      if (unmatchedSample.length < 15) unmatchedSample.push({ title: String(row.l.title ?? ""), bedrooms: row.br || null });
    } else {
      matched += 1;
    }
  }

  const canSatisfyPlan = (rows: typeof priced): boolean => {
    const used = new Set<string>();
    for (const br of plan) {
      const m = rows.find((r) => r.br === br && !used.has(r.l.url));
      if (!m) return false;
      used.add(m.l.url);
    }
    return true;
  };
  let pairableClusters = 0;
  const clusterList: CityVrboMatchDiagnostics["topClusters"] = [];
  // forEach + index-dedup (not for-of / Set→Array.from) to avoid the repo's
  // downlevel-iteration TS noise.
  buckets.forEach((b, key) => {
    if (b.rows.length >= plan.length && canSatisfyPlan(b.rows)) pairableClusters += 1;
    const brs = b.rows.map((r) => r.br);
    clusterList.push({
      label: communityKeyLabel(key),
      source: b.source,
      size: b.rows.length,
      bedrooms: brs.filter((v, i) => brs.indexOf(v) === i).sort((a, c) => c - a),
    });
  });
  clusterList.sort((a, c) => c.size - a.size);

  return {
    pricedTotal: priced.length,
    matched,
    unmatched: priced.length - matched,
    bySignal,
    pairableClusters,
    topClusters: clusterList.slice(0, 8),
    unmatchedSample,
  };
}
