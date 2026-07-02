export type BuyInPlatformSearchTerms = {
  airbnb?: string;
  booking?: string;
  vrbo?: string;
  pm?: string;
};

export type BuyInMarketLocation = {
  searchName: string;
  city: string;
  state: string;
  streetAddress?: string;
  lat: number;
  lng: number;
};

export type BuyInMarketBounds = {
  sw_lat: number;
  sw_lng: number;
  ne_lat: number;
  ne_lng: number;
};

export type BuyInMarket = {
  key: string;
  aliases: RegExp[];
  searchLocation: string;
  // Destination to use for the city-wide VRBO inventory export
  // (/api/operations/city-vrbo-inventory). `searchLocation` is resort/landmark
  // scoped on purpose for find-buy-in / replacement flows, but VRBO resolves a
  // resort name (e.g. "Poipu Kai Resort, …") to a small landmark region (~25
  // listings) — far narrower than the town the operator expects (Koloa ≈ 145).
  // The city-wide export is town-scoped by design ("export a city's entire VRBO
  // inventory, then match by shared title"), so it uses this town-level override
  // when set. Defaults to `searchLocation` when absent, so town-level markets
  // (Princeville, Keauhou) are unaffected.
  cityWideSearch?: string;
  platformSearch?: BuyInPlatformSearchTerms;
  location?: BuyInMarketLocation;
  bounds?: BuyInMarketBounds;
};

export const BUY_IN_MARKETS: Record<string, BuyInMarket> = {
  "Poipu Kai": {
    key: "Poipu Kai",
    aliases: [/\b(?:poipu(?:\s+kai)?|regency\s+at\s+poipu|villas\s+at\s+poipu\s+kai)\b/i],
    searchLocation: "Poipu Kai Resort, Koloa, Kauai, Hawaii",
    // VRBO resolves "Poipu Kai Resort" to a ~25-listing landmark region; the
    // town (Koloa) is what the operator sees (~145) and what the city-wide
    // export is meant to sweep. See cityWideSearch on the type above.
    cityWideSearch: "Koloa, Hawaii",
    platformSearch: {
      airbnb: "Poipu Kai Resort, Koloa, HI",
      booking: "Poipu Kai Resort, Koloa, HI",
      vrbo: "Poipu Kai Resort, Koloa, HI",
      pm: "Poipu Kai",
    },
    location: { searchName: "Poipu Kai", city: "Koloa", state: "Hawaii", streetAddress: "1831 Poipu Rd", lat: 21.8794, lng: -159.4609 },
    bounds: { sw_lat: 21.875, sw_lng: -159.478, ne_lat: 21.895, ne_lng: -159.458 },
  },
  "Kekaha Beachfront": {
    key: "Kekaha Beachfront",
    aliases: [/\b(?:kekaha|waimea|hanapepe)\b/i],
    searchLocation: "Kekaha, Kauai, Hawaii",
    platformSearch: {
      airbnb: "Kekaha, Kauai, HI",
    },
    location: { searchName: "Kekaha Beachfront", city: "Kekaha", state: "Hawaii", streetAddress: "8497 Kekaha Rd", lat: 21.9678, lng: -159.7464 },
    bounds: { sw_lat: 21.955, sw_lng: -159.758, ne_lat: 21.978, ne_lng: -159.733 },
  },
  "Keauhou": {
    key: "Keauhou",
    aliases: [/\b(?:na\s+hale\s+o\s+keauhou|keauhou|kailua[\s-]*kona|kona)\b/i],
    searchLocation: "Keauhou, Kailua-Kona, Big Island, Hawaii",
    // Curated Airbnb market-rate query (clean "Place, City, ST" form). Without
    // this the bulk pricing scan falls back to `searchLocation`, whose verbose
    // "…, Big Island, Hawaii" tail is meant for VRBO/Booking/find-buy-in, not the
    // Airbnb engine. See curatedAirbnbSearchQueries + hybrid-pricing.test.ts.
    platformSearch: {
      airbnb: "Keauhou, Kailua-Kona, HI",
    },
    location: { searchName: "Keauhou Estates", city: "Kailua-Kona", state: "Hawaii", streetAddress: "78-6855 Ali'i Dr", lat: 19.5493, lng: -155.9704 },
    bounds: { sw_lat: 19.528, sw_lng: -155.992, ne_lat: 19.558, ne_lng: -155.966 },
  },
  "Princeville": {
    key: "Princeville",
    aliases: [/\b(?:princeville|mauna\s+kai|hanalei|haena)\b/i],
    searchLocation: "Princeville, Kauai, Hawaii",
    // Community-level Airbnb market-rate query: this market spans several
    // Princeville resorts (Mauna Kai, Kaiulani), so comps are drawn from the
    // Princeville community (geo-bounded below), not a single resort.
    platformSearch: {
      airbnb: "Princeville, Kauai, HI",
    },
    location: { searchName: "Mauna Kai Princeville", city: "Princeville", state: "Hawaii", streetAddress: "3920 Wyllie Rd", lat: 22.2218, lng: -159.4849 },
    bounds: { sw_lat: 22.210, sw_lng: -159.498, ne_lat: 22.235, ne_lng: -159.468 },
  },
  "Kapaa Beachfront": {
    key: "Kapaa Beachfront",
    aliases: [/\b(?:kaha\s+lani|kapaa|kapa'?a|wailua|lihue|anahola)\b/i],
    searchLocation: "Kaha Lani Resort, Wailua, Kauai, Hawaii",
    // Curated Airbnb market-rate query — the resort name in clean form.
    platformSearch: {
      airbnb: "Kaha Lani Resort, Wailua, HI",
    },
    location: { searchName: "Kaha Lani Resort", city: "Wailua", state: "Hawaii", lat: 22.0360, lng: -159.3370 },
    bounds: { sw_lat: 22.021, sw_lng: -159.352, ne_lat: 22.051, ne_lng: -159.322 },
  },
  "Poipu Oceanfront": {
    key: "Poipu Oceanfront",
    aliases: [/\b(?:poipu\s+oceanfront|brennecke|ho'?one|makahuena)\b/i],
    searchLocation: "Poipu Beach, Koloa, Kauai, Hawaii",
    // Community-level Airbnb market-rate query: this oceanfront market spans
    // several small Poipu Beach resorts (Makahuena, Brennecke's, Ho'one), so
    // comps are drawn from the geo-bounded Poipu Beach oceanfront strip.
    platformSearch: {
      airbnb: "Poipu Beach, Koloa, HI",
    },
    location: { searchName: "Poipu Brenneckes Oceanfront", city: "Koloa", state: "Hawaii", streetAddress: "2298 Ho'one Rd", lat: 21.8744, lng: -159.4538 },
    bounds: { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
  },
  "Poipu Brenneckes": {
    key: "Poipu Brenneckes",
    aliases: [/\b(?:poipu\s+brenneckes|brenneckes)\b/i],
    searchLocation: "Brenneckes Beach, Poipu, Kauai, Hawaii",
    platformSearch: {
      airbnb: "Brennecke's Beach, Poipu, Koloa, HI",
    },
    location: { searchName: "Poipu Brenneckes", city: "Koloa", state: "Hawaii", streetAddress: "2298 Ho'one Rd", lat: 21.8744, lng: -159.4538 },
    bounds: { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
  },
  "Makahuena": {
    key: "Makahuena",
    aliases: [/\b(?:makahuena|ma\s*kahuena)\b/i],
    searchLocation: "Makahuena at Poipu, Koloa, Kauai, Hawaii",
    platformSearch: {
      airbnb: "Makahuena at Poipu, Koloa, HI",
    },
    location: { searchName: "Makahuena at Poipu", city: "Koloa", state: "Hawaii", streetAddress: "1661 Pe'e Rd", lat: 21.8735, lng: -159.4482 },
    bounds: { sw_lat: 21.870, sw_lng: -159.456, ne_lat: 21.878, ne_lng: -159.442 },
  },
  "Pili Mai": {
    key: "Pili Mai",
    aliases: [/\bpili\s+mai\b/i],
    searchLocation: "Pili Mai at Poipu, Koloa, Kauai, Hawaii",
    // Curated Airbnb market-rate query — the resort name in clean form.
    platformSearch: {
      airbnb: "Pili Mai at Poipu, Koloa, HI",
    },
    location: { searchName: "Pili Mai at Poipu", city: "Koloa", state: "Hawaii", streetAddress: "2611 Kiahuna Plantation Dr", lat: 21.8865, lng: -159.4729 },
    bounds: { sw_lat: 21.882, sw_lng: -159.483, ne_lat: 21.899, ne_lng: -159.468 },
  },
  "Menehune Shores": {
    key: "Menehune Shores",
    aliases: [/\bmenehune\s+shores\b/i],
    searchLocation: "Menehune Shores, Kihei, Hawaii",
    platformSearch: {
      airbnb: "Menehune Shores, Kihei, HI",
    },
    location: { searchName: "Menehune Shores", city: "Kihei", state: "Hawaii", streetAddress: "760 S Kihei Rd", lat: 20.7638, lng: -156.4594 },
    bounds: { sw_lat: 20.7615, sw_lng: -156.4615, ne_lat: 20.7655, ne_lng: -156.4570 },
  },
  "Royal Kahana": {
    key: "Royal Kahana",
    aliases: [/\broyal\s+kahana\b/i],
    searchLocation: "Royal Kahana Resort, Kahana, Lahaina, Maui, Hawaii",
    // Curated Airbnb market-rate query — the resort name in clean form.
    platformSearch: {
      airbnb: "Royal Kahana, Lahaina, HI",
    },
    // Coordinates verified via Nominatim (OSM node 7228340763): the beachfront
    // tower at 4365 Lower Honoapiilani Rd in Kahana, West Maui.
    location: { searchName: "Royal Kahana", city: "Lahaina", state: "Hawaii", streetAddress: "4365 Lower Honoapiilani Rd", lat: 20.9720, lng: -156.6793 },
    bounds: { sw_lat: 20.9640, sw_lng: -156.6873, ne_lat: 20.9800, ne_lng: -156.6713 },
  },
  "Ilikai": {
    key: "Ilikai",
    aliases: [/\bilikai\b/i],
    searchLocation: "Ilikai Hotel, Honolulu, Hawaii",
    platformSearch: {
      airbnb: "Ilikai Hotel, Honolulu, HI",
      booking: "Ilikai Hotel, Honolulu, HI",
      vrbo: "Ilikai Hotel, Honolulu, HI",
      pm: "Ilikai",
    },
    location: { searchName: "Ilikai", city: "Honolulu", state: "Hawaii", streetAddress: "1777 Ala Moana Blvd", lat: 21.2845, lng: -157.8380 },
    bounds: { sw_lat: 21.2795, sw_lng: -157.8430, ne_lat: 21.2895, ne_lng: -157.8330 },
  },
  "Windsor Hills": {
    key: "Windsor Hills",
    aliases: [/\b(?:windsor\s+hills|kissimmee|orlando)\b/i],
    searchLocation: "Windsor Hills Resort, Kissimmee, Florida",
    platformSearch: {
      airbnb: "Windsor Hills Resort, Kissimmee, FL",
    },
    location: { searchName: "Windsor Hills Resort", city: "Kissimmee", state: "Florida", streetAddress: "2600 N Old Lake Wilson Rd", lat: 28.3222, lng: -81.5961 },
    bounds: { sw_lat: 28.305, sw_lng: -81.615, ne_lat: 28.340, ne_lng: -81.575 },
  },
  "Bonita National": {
    key: "Bonita National",
    aliases: [
      /\b(?:bonita\s+national|bonita\s+springs|naples)\b/i,
      // "Estero" the INLAND TOWN → Bonita National tier, but NOT the Fort Myers Beach
      // coastal refs (Estero Blvd / Island / Beach / Bay). Those are Santa Maria Resort's
      // OWN address ("7317 Estero Blvd"); because Bonita National sits earlier in this
      // object and the old bare "estero" alias matched first, it stole Santa Maria's match
      // and mislabeled a Fort Myers Beach condo as the inland Bonita Springs golf community
      // (broke the cowork buy-in search). (2026-07-01)
      /\bestero\b(?!\s*(?:blvd|boulevard|island|isl|beach|bay))/i,
    ],
    searchLocation: "Bonita National Golf and Country Club, Bonita Springs, Florida",
    platformSearch: {
      airbnb: "Bonita National Golf and Country Club, Bonita Springs, FL",
      booking: "Bonita Springs, FL",
      vrbo: "Bonita National Golf and Country Club",
      pm: "Bonita National",
    },
    location: { searchName: "Bonita National", city: "Bonita Springs", state: "Florida", streetAddress: "17501 Bonita National Blvd", lat: 26.3254, lng: -81.6713 },
    bounds: { sw_lat: 26.310, sw_lng: -81.695, ne_lat: 26.342, ne_lng: -81.648 },
  },
  "Santa Maria Resort": {
    key: "Santa Maria Resort",
    aliases: [/\b(?:santa\s+maria(?:\s+(?:resort|harbou?r|condos?|condominiums?))?|fort\s+myers\s+beach.*santa\s+maria|73(?:07|17|27)\s+estero)\b/i],
    searchLocation: "Santa Maria Resort, Fort Myers Beach, Florida",
    platformSearch: {
      airbnb: "Santa Maria Resort, Fort Myers Beach, FL",
      booking: "Santa Maria Resort, Fort Myers Beach, FL",
      vrbo: "Santa Maria Resort Fort Myers Beach",
      pm: "Santa Maria Resort",
    },
    location: { searchName: "Santa Maria Resort", city: "Fort Myers Beach", state: "Florida", streetAddress: "7317 Estero Blvd", lat: 26.4116, lng: -81.8994 },
    bounds: { sw_lat: 26.4080, sw_lng: -81.9030, ne_lat: 26.4150, ne_lng: -81.8950 },
  },
  "Southern Dunes": {
    key: "Southern Dunes",
    aliases: [/\b(?:southern\s+dunes|haines\s+city|davenport)\b/i],
    searchLocation: "Southern Dunes, Haines City, Florida",
    platformSearch: {
      airbnb: "Southern Dunes, Haines City, FL",
      booking: "Southern Dunes, Haines City, FL",
      vrbo: "Southern Dunes, Haines City, FL",
      pm: "Southern Dunes",
    },
    location: { searchName: "Southern Dunes", city: "Haines City", state: "Florida", streetAddress: "2888 Southern Dunes Blvd", lat: 28.1277, lng: -81.6259 },
    bounds: { sw_lat: 28.112, sw_lng: -81.641, ne_lat: 28.137, ne_lng: -81.612 },
  },
  "Florida Generic": {
    key: "Florida Generic",
    aliases: [/\bflorida\b/i],
    searchLocation: "Florida, United States",
  },
};

export const BUY_IN_MARKET_SEARCH_LOCATIONS: Record<string, string> = Object.fromEntries(
  Object.values(BUY_IN_MARKETS).map((market) => [market.key, market.searchLocation]),
);

export const BUY_IN_MARKET_CITY_WIDE_SEARCH_LOCATIONS: Record<string, string> = Object.fromEntries(
  Object.values(BUY_IN_MARKETS).map((market) => [market.key, market.cityWideSearch ?? market.searchLocation]),
);

// Nearby substitute markets for guest-save workflows. These are intentionally
// curated by market cluster rather than inferred from broad city search:
// an alternative buy-in should be plausibly explainable to a guest as the
// same area, not just any cheaper inventory in the state.
export const SIMILAR_BUY_IN_MARKETS: Record<string, string[]> = {
  "Poipu Kai": ["Poipu Oceanfront", "Poipu Brenneckes", "Kapaa Beachfront"],
  "Pili Mai": ["Poipu Oceanfront", "Poipu Brenneckes", "Kapaa Beachfront"],
  "Poipu Brenneckes": ["Poipu Oceanfront", "Kapaa Beachfront", "Kekaha Beachfront"],
  "Poipu Oceanfront": ["Poipu Brenneckes", "Kapaa Beachfront", "Kekaha Beachfront"],
  "Kapaa Beachfront": ["Princeville"],
  "Princeville": ["Kapaa Beachfront"],
  "Windsor Hills": ["Southern Dunes"],
  "Southern Dunes": ["Windsor Hills"],
};

export const BUY_IN_MARKET_PLATFORM_SEARCH_TERMS: Record<string, BuyInPlatformSearchTerms> = Object.fromEntries(
  Object.values(BUY_IN_MARKETS)
    .filter((market) => market.platformSearch)
    .map((market) => [market.key, market.platformSearch!]),
);

export const BUY_IN_MARKET_LOCATIONS: Record<string, BuyInMarketLocation> = Object.fromEntries(
  Object.values(BUY_IN_MARKETS)
    .filter((market) => market.location)
    .map((market) => [market.key, market.location!]),
);

export const BUY_IN_MARKET_BOUNDS: Record<string, BuyInMarketBounds> = Object.fromEntries(
  Object.values(BUY_IN_MARKETS)
    .filter((market) => market.bounds)
    .map((market) => [market.key, market.bounds!]),
);

export function resolveBuyInMarketFromText(...values: unknown[]): string | null {
  const text = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  if (!text.trim()) return null;
  for (const market of Object.values(BUY_IN_MARKETS)) {
    if (market.key === "Florida Generic") continue;
    if (market.aliases.some((pattern) => pattern.test(text))) return market.key;
  }
  return null;
}

export function resolveBuyInMarket(input: {
  marketKey?: string | null;
  name?: string | null;
  listingTitle?: string | null;
  bookingTitle?: string | null;
  city?: string | null;
  state?: string | null;
  streetAddress?: string | null;
  unit1Address?: string | null;
  unit2Address?: string | null;
  sourceUrl?: string | null;
}): string | null {
  const marketKey = input.marketKey?.trim();
  if (marketKey && BUY_IN_MARKETS[marketKey]) return marketKey;
  const inferred = resolveBuyInMarketFromText(
    input.name,
    input.listingTitle,
    input.bookingTitle,
    input.streetAddress,
    input.unit1Address,
    input.unit2Address,
    input.city,
    input.state,
    input.sourceUrl,
  );
  if (inferred) return inferred;
  if (/\bfl(orida)?\b/i.test(input.state || "")) return "Florida Generic";
  return null;
}

export function searchLocationForBuyInMarket(marketKey: string): string | null {
  return BUY_IN_MARKET_SEARCH_LOCATIONS[marketKey] || null;
}

/**
 * The resort/market label the market-rate scan actually searches Airbnb under,
 * mirroring the server's `curatedAirbnbSearchQueries(community)[0]` priority:
 * platform Airbnb term → searchLocation → curated location searchName → the raw
 * community key. Used by the "research confirmation" UI (Pricing tab + bulk
 * pricing log) so the operator can SEE which resort the comps were drawn from.
 *
 * NOTE FOR CODEX: this is a display-only mirror. It does NOT reflect a
 * widened-fallback city anchor — that only fires server-side when the resort
 * box returns zero comps and is not echoed here. The accurate, persisted
 * searchName (incl. widened fallback) is a later phase; until then the bulk-log
 * side should prefer `pricingRecipe.searchName` (the value the scan actually
 * used) and only fall back to this helper when that is absent.
 */
export function curatedResortSearchName(community: string | null | undefined): string {
  const key = String(community ?? "").trim();
  if (!key) return "";
  const market = BUY_IN_MARKETS[key];
  return (
    market?.platformSearch?.airbnb
    || market?.searchLocation
    || market?.location?.searchName
    || key
  );
}

/**
 * True when the community key maps to a curated buy-in market. When false the
 * market-rate scan searches the raw community string verbatim (no curated
 * resort/geo box), which the confirmation UI should surface so a fallen-through
 * default is not mistaken for a confirmed resort.
 */
export function isCuratedBuyInMarket(community: string | null | undefined): boolean {
  const key = String(community ?? "").trim();
  return key.length > 0 && !!BUY_IN_MARKETS[key];
}

// US state name → 2-letter abbreviation. Used to build a clean "Resort, City, ST"
// Airbnb query from a listing's OWN city/state when it isn't a curated market
// (auto-curation). A value that's already a 2-letter code is returned upper-cased;
// an unrecognized value passes through unchanged.
const US_STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

export function abbreviateUsState(state: string | null | undefined): string {
  const s = String(state ?? "").trim();
  if (!s) return "";
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return US_STATE_ABBREVIATIONS[s.toLowerCase()] ?? s;
}

/**
 * AUTO-CURATION (query half): build a clean "Resort, City, ST" Airbnb search
 * query from a listing's own identity when its community is NOT a curated
 * BUY_IN_MARKETS key. Paired server-side with a geo box derived from the
 * listing's geocoded coordinates so a non-registry resort still gets a
 * curated-quality, geo-scoped Airbnb scan instead of a state-wide raw-string
 * search on its free-text draft name. Returns "" when there is no usable name.
 */
export function autoCuratedAirbnbSearchName(input: {
  name?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  const name = String(input.name ?? "").trim();
  if (!name) return "";
  const city = String(input.city ?? "").trim();
  const st = abbreviateUsState(input.state);
  return [name, city, st].filter(Boolean).join(", ");
}

// Coarse, generously-padded state bounding boxes used ONLY to reject a grossly
// wrong-STATE geocode before it anchors an auto-curation comp box. The boxes are
// intentionally loose — the goal is to catch "a Hawaii listing geocoded to
// Florida", never to pin a precise border. States not listed fail OPEN
// (validation skipped) so this can never block a legitimate in-state coordinate;
// add states here as the portfolio expands. [sw_lat, sw_lng, ne_lat, ne_lng].
const US_STATE_BOUNDS: Record<string, [number, number, number, number]> = {
  hawaii: [18.5, -160.5, 22.5, -154.5],
  florida: [24.3, -87.8, 31.2, -79.8],
  california: [32.3, -124.6, 42.2, -113.9],
  texas: [25.5, -106.9, 36.7, -93.3],
  arizona: [31.2, -114.9, 37.1, -108.9],
  nevada: [34.9, -120.1, 42.1, -113.9],
  colorado: [36.9, -109.2, 41.1, -101.9],
  tennessee: [34.9, -90.4, 36.8, -81.5],
  "south carolina": [31.9, -83.4, 35.3, -78.4],
  "north carolina": [33.7, -84.4, 36.7, -75.4],
  georgia: [30.3, -85.7, 35.1, -80.8],
};

// True when (lat,lng) plausibly falls inside the claimed US state (or the state
// is unlisted → fail open). Accepts a full name or a 2-letter code.
export function coordinateMatchesState(lat: number, lng: number, state: string | null | undefined): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const raw = String(state ?? "").trim().toLowerCase();
  if (!raw) return true; // no claimed state → nothing to check against
  const fullName = raw.length === 2
    ? Object.entries(US_STATE_ABBREVIATIONS).find(([, abbr]) => abbr.toLowerCase() === raw)?.[0]
    : raw;
  const box = fullName ? US_STATE_BOUNDS[fullName] : undefined;
  if (!box) return true; // unlisted state → fail open (never reject a real coord)
  const [swLat, swLng, neLat, neLng] = box;
  return lat >= swLat && lat <= neLat && lng >= swLng && lng <= neLng;
}

/**
 * Town-level destination for the city-wide VRBO inventory export. Falls back to
 * the resort/landmark `searchLocation` when a market has no town override, so
 * markets whose `searchLocation` is already town-scoped (Princeville, Keauhou)
 * keep their verified behaviour.
 */
export function cityWideSearchLocationForBuyInMarket(marketKey: string): string | null {
  return BUY_IN_MARKET_CITY_WIDE_SEARCH_LOCATIONS[marketKey] || searchLocationForBuyInMarket(marketKey);
}

/** Map scout rows like "Princeville, Hawaii" to configured market keys (e.g. Princeville). */
export function buyInMarketKeyForScoutCommunity(communityLabel: string): string | null {
  const trimmed = String(communityLabel ?? "").trim();
  if (!trimmed) return null;
  if (BUY_IN_MARKETS[trimmed]) return trimmed;
  return resolveBuyInMarketFromText(trimmed) ?? resolveBuyInMarket({ name: trimmed });
}

export function resortPhraseTokens(phrase: string): string[] {
  return String(phrase ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

export function textMatchesResortPhrase(haystack: string, phrase: string): boolean {
  const tokens = resortPhraseTokens(phrase);
  if (tokens.length === 0) return true;
  const normalized = String(haystack ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return tokens.every((token) => normalized.includes(token));
}

/** Beachfront/oceanfront sources should only scout other waterfront markets. */
export function oceanfrontComparableBuyInMarket(community: string | null | undefined): boolean {
  const key = String(community ?? "").toLowerCase();
  return /\b(oceanfront|beachfront|brenneckes?|makahuena)\b/.test(key);
}

const DRIVE_SPEED_MPH = 35;
const DRIVE_ROAD_FACTOR = 1.35;

export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function driveMinutesBetweenBuyInMarkets(fromKey: string, toKey: string): number | null {
  const a = BUY_IN_MARKET_LOCATIONS[fromKey];
  const b = BUY_IN_MARKET_LOCATIONS[toKey];
  if (!a || !b) return null;
  const roadMiles = haversineMiles(a.lat, a.lng, b.lat, b.lng) * DRIVE_ROAD_FACTOR;
  return Math.max(1, Math.ceil((roadMiles / DRIVE_SPEED_MPH) * 60));
}

export function driveMinutesBetweenCoords(aLat: number, aLng: number, bLat: number, bLng: number): number | null {
  if (!Number.isFinite(aLat) || !Number.isFinite(aLng) || !Number.isFinite(bLat) || !Number.isFinite(bLng)) return null;
  const roadMiles = haversineMiles(aLat, aLng, bLat, bLng) * DRIVE_ROAD_FACTOR;
  return Math.max(1, Math.ceil((roadMiles / DRIVE_SPEED_MPH) * 60));
}

/** All configured buy-in markets that have map coordinates (used for drive-time scout). */
export function buyInMarketsWithScoutCoordinates(): BuyInMarket[] {
  return Object.values(BUY_IN_MARKETS).filter((market) => market.location);
}

/** Nearby substitute markets within a short drive of the base community. */
export function nearbyBuyInMarketsForScout(
  baseCommunity: string,
  opts: { maxDriveMinutes?: number; oceanfrontOnly?: boolean; limit?: number } = {},
): string[] {
  const maxDriveMinutes = opts.maxDriveMinutes ?? 20;
  const limit = opts.limit ?? 10;
  const baseLocation = BUY_IN_MARKET_LOCATIONS[baseCommunity];
  if (!baseLocation) {
    return (SIMILAR_BUY_IN_MARKETS[baseCommunity] ?? [])
      .filter((key) => key !== baseCommunity && !!BUY_IN_MARKET_LOCATIONS[key])
      .filter((key) => !opts.oceanfrontOnly || oceanfrontComparableBuyInMarket(key))
      .slice(0, limit);
  }

  const ranked: { key: string; minutes: number }[] = [];
  for (const market of buyInMarketsWithScoutCoordinates()) {
    if (market.key === baseCommunity || market.key === "Florida Generic") continue;
    if (market.location!.state !== baseLocation.state) continue;
    if (opts.oceanfrontOnly && !oceanfrontComparableBuyInMarket(market.key)) continue;
    const minutes = driveMinutesBetweenBuyInMarkets(baseCommunity, market.key);
    if (minutes === null || minutes > maxDriveMinutes) continue;
    ranked.push({ key: market.key, minutes });
  }
  ranked.sort((a, b) => a.minutes - b.minutes || a.key.localeCompare(b.key));
  return ranked.slice(0, limit).map((row) => row.key);
}

/** Drive-time ranked list for UI transparency (community + minutes). */
export function nearbyBuyInMarketsForScoutDetailed(
  baseCommunity: string,
  opts: { maxDriveMinutes?: number; oceanfrontOnly?: boolean; limit?: number } = {},
): Array<{ community: string; driveMinutes: number }> {
  const maxDriveMinutes = opts.maxDriveMinutes ?? 20;
  const limit = opts.limit ?? 10;
  const baseLocation = BUY_IN_MARKET_LOCATIONS[baseCommunity];
  if (!baseLocation) return [];

  const ranked: { community: string; driveMinutes: number }[] = [];
  for (const market of buyInMarketsWithScoutCoordinates()) {
    if (market.key === baseCommunity || market.key === "Florida Generic") continue;
    if (market.location!.state !== baseLocation.state) continue;
    if (opts.oceanfrontOnly && !oceanfrontComparableBuyInMarket(market.key)) continue;
    const minutes = driveMinutesBetweenBuyInMarkets(baseCommunity, market.key);
    if (minutes === null || minutes > maxDriveMinutes) continue;
    ranked.push({ community: market.key, driveMinutes: minutes });
  }
  ranked.sort((a, b) => a.driveMinutes - b.driveMinutes || a.community.localeCompare(b.community));
  return ranked.slice(0, limit);
}
