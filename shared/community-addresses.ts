export type CommunityAddressRule = {
  names: string[];
  street: string;
  city: string;
  cityAliases?: string[];
  state: string;
  /** Optional Zillow building (/b/...) page listing many in-resort units. */
  zillowBuildingUrl?: string;
  /** Alphanumeric condo unit labels for targeted Google discovery (e.g. C1, O1). */
  discoveryUnitLabels?: string[];
  /**
   * Optional sibling building street addresses for a MULTI-BUILDING resort (e.g.
   * a 300-unit complex spanning several street numbers). The replacement
   * "Find a New Unit" flow gates candidates to the resort's street root(s); with
   * only the single canonical `street` it rejected every unit on a sibling
   * building. List the other building addresses here to admit them. Each entry is
   * a full street address (root is derived). Keep entries SPECIFIC to this resort —
   * a wrong/loose root would let a different resort's units in (wrong-resort photos).
   */
  buildingStreetRoots?: string[];
};

export const COMMUNITY_ADDRESS_RULES: CommunityAddressRule[] = [
  { names: ["Regency at Poipu Kai", "Poipu Kai", "Kahala at Poipu Kai", "Poipu Sands"], street: "1831 Poipu Rd", city: "Koloa", state: "HI" },
  { names: ["Pili Mai", "Pili Mai at Poipu"], street: "2611 Kiahuna Plantation Dr", city: "Koloa", state: "HI" },
  { names: ["Mauna Kai Princeville", "Mauna Kai"], street: "3920 Wyllie Rd", city: "Princeville", state: "HI" },
  { names: ["Kaha Lani Resort", "Kaha Lani"], street: "4460 Nehe Rd", city: "Lihue", state: "HI" },
  { names: ["Makahuena at Poipu", "Makahuena"], street: "1661 Pe'e Rd", city: "Koloa", state: "HI" },
  { names: ["Kaiulani of Princeville", "Ka'iulani of Princeville", "Kaiulani"], street: "4100 Queen Emma's Dr", city: "Princeville", state: "HI" },
  { names: ["The Cliffs at Princeville", "Cliffs at Princeville", "The Cliffs Princeville"], street: "3811 Edward Rd", city: "Princeville", cityAliases: ["Hanalei", "Kilauea", "Wainiha", "Haena"], state: "HI" },
  { names: ["Kekaha Beachfront Estate"], street: "8497 Kekaha Rd", city: "Kekaha", state: "HI" },
  { names: ["Keauhou Estates"], street: "78-6855 Ali'i Dr", city: "Kailua-Kona", state: "HI" },
  { names: ["Ilikai", "Ilikai Hotel", "Ilikai Hotel & Luxury Suites", "Ilikai Apt Bldg"], street: "1777 Ala Moana Blvd", city: "Honolulu", state: "HI" },
  { names: ["Waikiki Beach Tower", "Aston Waikiki Beach Tower"], street: "2470 Kalakaua Ave", city: "Honolulu", state: "HI" },
  { names: ["Waikiki Shore by Outrigger", "Waikiki Shore", "Castle Waikiki Shore"], street: "2161 Kalia Rd", city: "Honolulu", state: "HI" },
  { names: ["Waikiki Banyan", "Aston at the Waikiki Banyan"], street: "201 Ohua Ave", city: "Honolulu", state: "HI" },
  { names: ["Waikiki Sunset", "Aston Waikiki Sunset"], street: "229 Paoakalani Ave", city: "Honolulu", state: "HI" },
  { names: ["Island Colony", "Island Colony Waikiki"], street: "445 Seaside Ave", city: "Honolulu", state: "HI" },
  {
    names: ["Waikoloa Beach Villas", "Waikoloa Villas", "Beach Villas at Waikoloa Beach Resort"],
    street: "69-180 Waikoloa Beach Dr",
    city: "Waikoloa",
    cityAliases: ["Mauna Kea"],
    state: "HI",
    discoveryUnitLabels: ["C1", "O1", "P1", "F1", "C4", "I4", "C23", "P33", "M23", "L23", "G33", "J2"],
  },
  { names: ["Fairway Villas Waikoloa", "Fairway Villas at Waikoloa", "Waikoloa Fairway Villas", "Fairway Villas Waikoloa Beach Resort"], street: "69-200 Pohakulana Pl", city: "Waikoloa", cityAliases: ["Waikoloa Beach Resort", "Mauna Kea"], state: "HI" },
  { names: ["Halii Kai", "Hali'i Kai", "Haliʻi Kai", "Halii Kai at Waikoloa", "Hali'i Kai at Waikoloa", "Haliʻi Kai at Waikoloa", "Castle Halii Kai at Waikoloa", "Castle Haliʻi Kai at Waikoloa"], street: "69-1029 Nawahine Pl", city: "Waikoloa", cityAliases: ["Waikoloa Beach Resort", "Mauna Kea"], state: "HI" },
  { names: ["Mauna Lani Point", "Mauna Lani Point Condominium", "Mauna Lani"], street: "68-1050 Mauna Lani Point Dr", city: "Kamuela", cityAliases: ["Waikoloa", "Puako", "Mauna Lani", "Mauna Kea", "Waimea"], state: "HI" },
  { names: ["Windsor Hills", "Windsor Hills Resort"], street: "2600 N Old Lake Wilson Rd", city: "Kissimmee", state: "FL" },
  { names: ["Pink Shell Beach Resort", "Pink Shell Beach Resort and Marina", "Pink Shell Resort", "Pink Shell"], street: "275 Estero Blvd", city: "Fort Myers Beach", state: "FL" },
  // Additional Poipu/Koloa addresses for new combo seeds (enables geo-bbox unit search in /api/community/search-units and refresh-pricing)
  { names: ["Poipu Kapili"], street: "2221 Kapili Rd", city: "Koloa", state: "HI" },
  { names: ["Poipu Shores"], street: "1775 Pe'e Rd", city: "Koloa", state: "HI" },
  { names: ["Manualoha at Poipu Kai"], street: "2371 Ho'ohu Road", city: "Koloa", state: "HI" },
  { names: ["Honua Kai Resort", "Honua Kai", "Honua Kai Resort & Spa"], street: "130 Kai Malina Pkwy", city: "Lahaina", cityAliases: ["Kaanapali", "Ka'anapali", "Kapalua", "Napili", "Honokowai"], state: "HI" },
  { names: ["Kaanapali Alii", "Kaanapali Ali'i"], street: "50 Nohea Kai Dr", city: "Lahaina", cityAliases: ["Kaanapali", "Ka'anapali"], state: "HI" },
  { names: ["Wailea Elua Village", "Wailea Elua"], street: "3600 Wailea Alanui Dr", city: "Kihei", cityAliases: ["Wailea"], state: "HI" },
  { names: ["Wailea Ekahi Village", "Wailea Ekahi"], street: "3300 Wailea Alanui Dr", city: "Kihei", cityAliases: ["Wailea"], state: "HI" },
  { names: ["Grand Champions Villas", "Wailea Grand Champions"], street: "155 Wailea Ike Pl", city: "Kihei", cityAliases: ["Wailea"], state: "HI" },
  { names: ["Ko Olina Beach Villas", "Beach Villas at Ko Olina", "Beach Villas Ko Olina"], street: "92-102 Waialii Pl", city: "Kapolei", cityAliases: ["Ko Olina", "Ewa Beach", "Ewa"], state: "HI" },
  { names: ["Coconut Plantation at Ko Olina", "Coconut Plantation", "Coconut Plantation Ko Olina"], street: "92-1070 Olani St", city: "Kapolei", cityAliases: ["Ko Olina", "Ewa Beach", "Ewa"], state: "HI" },
  // Oahu North Shore — Turtle Bay / Kuilima resort zone. LOAD-BEARING city alias:
  // Zillow/Realtor/Redfin/Homes index these condos under KAHUKU, HI 96731 — "Turtle
  // Bay" is the resort name, NOT a USPS city. The bulk-combo sweep market is literally
  // "Turtle Bay" (community-research.ts OAHU_NORTH_CITY_PATTERN), and these resorts had
  // NO curated rule, so hydrate never corrected the city and photo discovery searched
  // "Turtle Bay" — a city Zillow returns nothing for — and skipped the resort as
  // "no photos". rule.city=Kahuku makes discoverySearchCitiesForPhotoSearch put Kahuku
  // first (the indexed city); the "Turtle Bay" alias keeps the sweep's city + the
  // guest-facing listing label valid (mirrors the Ko Olina/Kapolei pattern above).
  { names: ["Ocean Villas at Turtle Bay", "Ocean Villas Turtle Bay"], street: "57-020 Kuilima Dr", city: "Kahuku", cityAliases: ["Turtle Bay"], state: "HI" },
  // One rule for the whole Kuilima Estates gated complex (generic + East + West are a
  // single contiguous resort). East buildings sit on Eleku Kuilima Pl; West + the
  // generic seed on 57-101 Kuilima Dr. Street precision only scores candidates here —
  // discovery is name+city driven — so the shared canonical street is intentional.
  { names: ["Kuilima Estates", "Kuilima Estates East", "Kuilima Estates West", "Kuilima Ests East", "Kuilima Ests West"], street: "57-101 Kuilima Dr", city: "Kahuku", cityAliases: ["Turtle Bay"], state: "HI", buildingStreetRoots: ["57-101 Kuilima Dr", "57-068 Eleku Kuilima Pl"] },
];

/** Tokens from a Hawaii hyphenated street number (e.g. 92-102) that must not be treated as condo unit IDs in listing URL slugs. */
export function hawaiiHyphenStreetSlugTokens(address: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  const match = String(address ?? "").match(/\b(\d{1,2})-(\d{2,5})\b/);
  if (!match) return tokens;
  tokens.add(match[1].toUpperCase());
  tokens.add(match[2].toUpperCase());
  return tokens;
}

/**
 * Fold Hawaiian diacritics to their ASCII base so SearchAPI/listing data matches
 * the operator's plain-text resort names and so okina-bearing streets validate.
 * google_maps returns the real spellings — "Kona Aliʻi", "75-6082 Aliʻi Dr",
 * "Hōlualoa Bay Villas", "Molokaʻi Shores" — but the okina (ʻ U+02BB / ‘ U+2018)
 * and macrons (ō, ā, …) previously (a) failed isLikelyStreetAddress's char class
 * and (b) were turned into word-SPLITTING spaces by normalizeCommunityAddressToken
 * ("Aliʻi" → "ali i"), so every Aliʻi-Drive Kona resort failed address discovery
 * (observed live 2026-06-26: Casa De Emdeko, Sea Village, Kona Makai, Alii Villas,
 * Kona Alii, Holualoa Bay Villas). NFD-decompose to drop macrons, then remove the
 * okina + apostrophes so the glottal stop JOINS the word ("Aliʻi" → "alii"). It is
 * a no-op on plain ASCII and never crosses a space, so the load-bearing
 * "Alii Kai" ≠ "Halii Kai" word-boundary distinction is preserved.
 */
export function foldHawaiianDiacritics(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")            // strip combining marks (macrons: ō → o)
    .replace(/[ʻʼ‘’']/g, ""); // drop okina + curly/straight apostrophes (join the word)
}

export function normalizeCommunityAddressToken(value: string): string {
  return foldHawaiianDiacritics(value)
    .toLowerCase()
    .replace(/\b(hawaii|hi|florida|fl|united states|usa|us)\b/g, " ")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(street)\b/g, "st")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(highway)\b/g, "hwy")
    .replace(/\b(apartment|apt|unit|suite|ste|building|bldg|#)\s*[a-z0-9-]+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stateAbbrev(value: string): string {
  const s = value.trim().toLowerCase();
  if (s === "hawaii") return "HI";
  if (s === "florida") return "FL";
  return value.trim().toUpperCase();
}

// One normalized name contains the other ON WORD BOUNDARIES. Padding both sides
// with a space means "alii kai" no longer matches inside "halii kai" (the suffix
// of "halii" is not a whole word) while legitimate partials like "grand champions"
// ⊂ "wailea grand champions" and "poipu kai" ⊂ "kahala at poipu kai" still match.
// LOAD-BEARING: a raw substring match here silently saved a Kauai "Alii Kai" combo
// listing against the Big-Island "Halii Kai" address — keep this boundary-aware.
function nameTokensContain(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  return ` ${haystack} `.includes(` ${needle} `);
}

export function communityAddressRuleForName(name: string | null | undefined): CommunityAddressRule | null {
  const n = normalizeCommunityAddressToken(String(name ?? ""));
  if (!n) return null;
  return COMMUNITY_ADDRESS_RULES.find((rule) =>
    rule.names.some((candidate) => {
      const c = normalizeCommunityAddressToken(candidate);
      if (!c) return false;
      return n === c || nameTokensContain(n, c) || nameTokensContain(c, n);
    }),
  ) ?? null;
}

/** Mailing city from "street, city, HI 96707" or "street, city, Hawaii". */
export function parseCityFromMailingAddress(address: string | null | undefined): string | null {
  const trimmed = String(address ?? "").trim();
  if (!trimmed) return null;
  const withZip = trimmed.match(/,\s*([^,]+),\s*[A-Z]{2}\s+\d/);
  if (withZip) return withZip[1].trim();
  const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2) return parts[1];
  return null;
}

/** Recover city when a full address was sent as the platform-check `city` param. */
export function normalizePlatformCheckCity(city: string, mailingAddress?: string): string {
  const raw = String(city ?? "").trim();
  if (!raw) return parseCityFromMailingAddress(mailingAddress) ?? "";
  if (/,/.test(raw) && /\d/.test(raw)) {
    return parseCityFromMailingAddress(raw) ?? raw;
  }
  return raw;
}

// One numbered-street test, shared by isLikelyStreetAddress and the comma-segment
// scan in streetRootFromAddress. The optional `-\d{1,6}` allows the Hawaii
// hyphenated house number (e.g. 75-6082 Alii Dr). Inputs are diacritic-folded
// upstream, so the okina never reaches this char class.
const NUMBERED_STREET_PATTERN = /\b\d{1,6}(?:-\d{1,6})?\s+[A-Za-z0-9' .-]+(?:Rd|Road|Dr|Drive|St|Street|Ave|Avenue|Ln|Lane|Hwy|Highway|Blvd|Boulevard|Way|Cir|Circle|Ct|Court|Pl|Place|Trl|Trail|Pkwy|Parkway)\b/i;

export function streetRootFromAddress(value: string | null | undefined): string {
  const raw = foldHawaiianDiacritics(value).trim();
  if (!raw) return "";
  // Pick the comma-segment that actually carries the numbered street. Most addresses
  // lead with it, but rural Hawaii ones lead with a postal route — e.g.
  // "Star Route, 1000 Kamehameha V Hwy, Kaunakakai, HI" (Molokai Shores) — where the
  // real street is the SECOND segment. Fall back to the first segment so addresses
  // with no numbered street ("Princeville, HI 96722") behave exactly as before.
  const segments = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const streetSeg = segments.find((s) => NUMBERED_STREET_PATTERN.test(s)) ?? segments[0] ?? "";
  return streetSeg
    .replace(/\b(?:apartment|apt|unit|suite|ste|building|bldg|#)\s*[a-z0-9-]+\b/gi, "")
    .replace(/\b(Blvd|Boulevard|Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Hwy|Highway|Way|Cir|Circle|Ct|Court|Pkwy|Parkway|Pl|Place|Trl|Trail)\s+[A-Za-z]?\d{1,5}[A-Za-z]?\b$/i, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelyStreetAddress(value: string | null | undefined): boolean {
  return NUMBERED_STREET_PATTERN.test(streetRootFromAddress(value));
}

export function inferCommunityStreetAddress(input: {
  communityName?: string | null;
  city?: string | null;
  state?: string | null;
  unitAddresses?: Array<string | null | undefined>;
  addressHint?: string | null;
}): string {
  const rule = communityAddressRuleForName(input.communityName);
  if (rule) return rule.street;

  if (input.addressHint && isLikelyStreetAddress(input.addressHint)) {
    return input.addressHint;
  }

  const addresses = (input.unitAddresses ?? []).map(streetRootFromAddress).filter(Boolean);
  if (addresses.length > 0) {
    const first = normalizeCommunityAddressToken(addresses[0]);
    const allSame = addresses.every((addr) => normalizeCommunityAddressToken(addr) === first);
    if (allSame && isLikelyStreetAddress(addresses[0])) return addresses[0];
  }

  return "";
}

/** Canonical street for bulk-combo queue items (backfills rules added after a job was queued). */
export function resolveBulkComboListingStreet(input: {
  communityName?: string | null;
  city?: string | null;
  state?: string | null;
  streetAddress?: string | null;
  addressHint?: string | null;
}): string {
  const trimmed = String(input.streetAddress ?? "").trim();
  if (trimmed && isLikelyStreetAddress(trimmed)) return streetRootFromAddress(trimmed);
  return inferCommunityStreetAddress({
    communityName: input.communityName,
    city: input.city,
    state: input.state,
    unitAddresses: trimmed ? [trimmed] : [],
    addressHint: input.addressHint,
  });
}

export function validateCommunityStreetAddress(input: {
  communityName?: string | null;
  city?: string | null;
  state?: string | null;
  streetAddress?: string | null;
}): { ok: true; streetAddress: string; warning?: string } | { ok: false; error: string; expectedStreet?: string } {
  const street = streetRootFromAddress(input.streetAddress);
  if (!isLikelyStreetAddress(street)) {
    return { ok: false, error: "A real street address is required before saving or pushing a listing." };
  }

  const rule = communityAddressRuleForName(input.communityName);
  if (!rule) return { ok: true, streetAddress: street };

  const sameStreet = normalizeCommunityAddressToken(street) === normalizeCommunityAddressToken(rule.street);
  const allowedCities = [rule.city, ...(rule.cityAliases ?? [])].map(normalizeCommunityAddressToken);
  const sameCity = !input.city || allowedCities.includes(normalizeCommunityAddressToken(input.city));
  const sameState = !input.state || stateAbbrev(input.state) === rule.state;
  if (!sameStreet || !sameCity || !sameState) {
    return {
      ok: false,
      error: `${input.communityName} should use ${rule.street}, ${rule.city}, ${rule.state}.`,
      expectedStreet: rule.street,
    };
  }

  return { ok: true, streetAddress: rule.street };
}

/** City Zillow/Google index listings under (may differ from draft mailing city). */
export function discoveryCityForPhotoSearch(input: {
  city?: string | null;
  communityName?: string | null;
  streetAddress?: string | null;
}): string {
  const cities = discoverySearchCitiesForPhotoSearch(input);
  return cities[0] ?? String(input.city ?? "").trim();
}

/**
 * SearchAPI / Apify city terms for photo discovery. Resort mailing cities
 * (e.g. Mauna Kea) often differ from Zillow index cities (Kamuela, Waikoloa).
 */
export function discoverySearchCitiesForPhotoSearch(input: {
  city?: string | null;
  communityName?: string | null;
  streetAddress?: string | null;
}): string[] {
  const rule = communityAddressRuleForName(input.communityName);
  const city = String(input.city ?? "").trim();
  const street = String(input.streetAddress ?? "").trim();
  const community = String(input.communityName ?? "").trim();
  const cities = new Set<string>();
  if (rule?.city) cities.add(rule.city);
  if (city) cities.add(city);
  for (const alias of rule?.cityAliases ?? []) {
    if (alias) cities.add(alias);
  }
  if (/waikoloa/i.test(street) || /waikoloa/i.test(community)) cities.add("Waikoloa");
  if (/\bmauna kea\b/i.test(city) && /waikoloa|69[- ]?180/i.test(`${street} ${community}`)) {
    cities.add("Waikoloa");
  }
  if (/mauna\s+lani/i.test(community) || /mauna\s+lani\s+point/i.test(street)) {
    cities.add("Waikoloa");
    cities.add("Mauna Lani");
    cities.add("Kamuela");
  }
  if (/ko\s*olina|koolina/i.test(community) || /waialii|olani/i.test(street)) {
    cities.add("Kapolei");
    cities.add("Ko Olina");
    cities.add("Ewa Beach");
  }
  return Array.from(cities).filter(Boolean).slice(0, 4);
}

/** Resort name variants for SearchAPI discovery (draft title vs Zillow building name). */
export function discoveryCommunityNameAliases(name: string | null | undefined): string[] {
  const base = String(name ?? "").trim();
  if (!base) return [];
  const aliases = new Set<string>([base]);
  const rule = communityAddressRuleForName(base);
  for (const alt of rule?.names ?? []) aliases.add(alt);
  return Array.from(aliases).filter(Boolean);
}

/** Targeted Google queries for resorts with alphanumeric unit IDs (e.g. Waikoloa C1). */
export function discoveryUnitLabelSearchQueries(input: {
  communityName?: string | null;
  street?: string | null;
  city?: string | null;
  requiredBedrooms?: number | null;
  maxLabels?: number;
}): string[] {
  const rule = communityAddressRuleForName(input.communityName);
  const labels = rule?.discoveryUnitLabels ?? [];
  if (labels.length === 0) return [];
  const street = String(input.street ?? rule?.street ?? "").trim();
  if (!street) return [];
  const city = String(input.city ?? rule?.city ?? "").trim();
  const cap = Math.max(1, Math.min(input.maxLabels ?? 12, labels.length));
  const bedroomSuffix = input.requiredBedrooms ? ` "${input.requiredBedrooms} bedroom"` : "";
  const queries: string[] = [];
  for (const label of labels.slice(0, cap)) {
    const unitTerm = `"unit ${label}"`;
    queries.push(
      `site:redfin.com "${street}" ${unitTerm}${bedroomSuffix}`.trim(),
      `site:zillow.com/homedetails "${street}" "${label}"${bedroomSuffix}`.trim(),
    );
    if (city) {
      queries.push(`site:realtor.com "${street}" ${unitTerm} "${city}"${bedroomSuffix}`.trim());
    }
  }
  return queries;
}
