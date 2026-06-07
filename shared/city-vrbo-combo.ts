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
const KAUAI_COMPLEX_DICTIONARY: Array<{ canonical: string; match: RegExp }> = [
  { canonical: "poipu kai", match: /\bpoipu kai\b|\bregency at poipu\b|\bvillas at poipu kai\b/ },
  { canonical: "poipu kapili", match: /\bpoipu kapili\b/ },
  { canonical: "kiahuna plantation", match: /\bkiahuna\b/ },
  { canonical: "nihi kai villas", match: /\bnihi kai\b/ },
  { canonical: "poipu sands", match: /\bpoipu sands\b/ },
  { canonical: "poipu crater", match: /\bpoipu crater\b/ },
  { canonical: "poipu shores", match: /\bpoipu shores\b/ },
  { canonical: "koloa landing", match: /\bkoloa landing\b/ },
  { canonical: "sunset kahili", match: /\bsunset kahili\b/ },
  { canonical: "kuhio shores", match: /\bkuhio shores\b/ },
  { canonical: "makahuena", match: /\bmakahuena\b/ },
  { canonical: "pili mai", match: /\bpili mai\b/ },
  { canonical: "waikomo stream villas", match: /\bwaikomo\b/ },
  { canonical: "whalers cove", match: /\bwhalers? cove\b/ },
  { canonical: "point at poipu", match: /\bpoint at poipu\b/ },
  { canonical: "lawai beach resort", match: /\blawai beach\b/ },
  { canonical: "prince kuhio", match: /\bprince kuhio\b/ },
  { canonical: "manualoha", match: /\bmanualoha\b/ },
  { canonical: "alihi lani", match: /\balihi lani\b/ },
  { canonical: "kahala at poipu", match: /\bkahala at poipu\b/ },
  // Princeville / north shore
  { canonical: "hanalei bay resort", match: /\bhanalei bay resort\b/ },
  { canonical: "puu poa", match: /\bpuu poa\b|\bpu'?u po'?a\b/ },
  { canonical: "sealodge", match: /\bsealodge\b|\bsea lodge\b/ },
  { canonical: "alii kai", match: /\balii kai\b|\bali'?i kai\b/ },
  { canonical: "hanalei colony resort", match: /\bhanalei colony\b/ },
  { canonical: "mauna kai", match: /\bmauna kai\b/ },
  { canonical: "the cliffs at princeville", match: /\bcliffs?\s+(?:at\s+|of\s+)?princeville\b|\bprinceville\s+cliffs?\b|\bcliffs?\s+club\b/ },
  // Kapaa / east side
  { canonical: "kaha lani", match: /\bkaha lani\b/ },
  { canonical: "lae nani", match: /\blae nani\b/ },
  { canonical: "lanikai", match: /\blanikai\b/ },
  { canonical: "kapaa shore", match: /\bkapaa shore\b/ },
  { canonical: "pono kai", match: /\bpono kai\b/ },
  { canonical: "wailua bay view", match: /\bwailua bay view\b/ },
];

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
  candidate: Pick<CityVrboListing, "title" | "sourceLabel" | "snippet">,
): string[] {
  // Dictionary may scan the snippet too (its terms are specific multi-word
  // complex names). The heuristic + classic-phrase scans use the TITLE only:
  // VRBO card snippets are full of UI boilerplate ("current price is 450",
  // "photo gallery for", "condo sleeps 8") that the unit-number heuristic would
  // otherwise turn into junk clusters.
  const titleText = normalizedIdentityText([candidate.title, candidate.sourceLabel].filter(Boolean).join(" "));
  const fullText = normalizedIdentityText([candidate.title, candidate.sourceLabel, candidate.snippet].filter(Boolean).join(" "));
  if (!fullText) return [];
  const keys = new Set<string>();

  // 1) Dictionary (highest precision) — title + snippet.
  for (const entry of KAUAI_COMPLEX_DICTIONARY) {
    if (entry.match.test(fullText)) keys.add(`dict:${entry.canonical}`);
  }

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

function matchSourceForKey(key: string): CommunityMatchSource {
  if (key.startsWith("dict:")) return "dictionary";
  if (key.startsWith("complex:")) return "complex-name";
  if (key.startsWith("phrase:")) return "shared-phrase";
  if (key.startsWith("geo:")) return "coords";
  if (key.startsWith("img:")) return "photo";
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
    const pm = propertyManagerKey(row.listing);
    if (pm) {
      const bucket = pmBuckets.get(pm) ?? [];
      bucket.push(row);
      pmBuckets.set(pm, bucket);
    }
  }

  const evaluate = (buckets: Map<string, ScoredRow[]>): CityVrboComboPair | null => {
    let best: CityVrboComboPair | null = null;
    for (const [key, bucket] of buckets) {
      if (bucket.length < plan.length) continue;
      const picks = pickCheapestPlan(bucket, plan);
      if (!picks) continue;
      const walk = pairIsWalkable(picks);
      if (!walk.ok) continue;
      const totalCost = picks.reduce((sum, pick) => sum + listingTotalPrice(pick, nights), 0);
      const source = matchSourceForKey(key);
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
  const photoPair = evaluate(photoBuckets);
  const candidates = [strongPair, photoPair].filter((p): p is CityVrboComboPair => !!p);
  if (candidates.length) {
    candidates.sort((a, b) => a.totalCost - b.totalCost);
    return candidates[0];
  }
  // PM fallback — but only accept it when coordinates confirm walkability (so we
  // never suggest two same-PM units that are miles apart). Without coords it
  // stays unflagged-low and is returned only if the operator has no better lead.
  const pmPair = evaluate(pmBuckets);
  if (pmPair) {
    if (pmPair.walkSource === "coords") {
      return { ...pmPair, matchSource: "property-manager", matchConfidence: "medium" };
    }
    return { ...pmPair, matchSource: "property-manager", matchConfidence: "low" };
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
