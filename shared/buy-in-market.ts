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
  platformSearch?: BuyInPlatformSearchTerms;
  location?: BuyInMarketLocation;
  bounds?: BuyInMarketBounds;
};

export const BUY_IN_MARKETS: Record<string, BuyInMarket> = {
  "Poipu Kai": {
    key: "Poipu Kai",
    aliases: [/\b(?:poipu\s+kai|regency\s+at\s+poipu|villas\s+at\s+poipu\s+kai)\b/i],
    searchLocation: "Poipu Kai Resort, Koloa, Kauai, Hawaii",
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
    location: { searchName: "Kekaha Beachfront", city: "Kekaha", state: "Hawaii", streetAddress: "8497 Kekaha Rd", lat: 21.9678, lng: -159.7464 },
    bounds: { sw_lat: 21.955, sw_lng: -159.758, ne_lat: 21.978, ne_lng: -159.733 },
  },
  "Keauhou": {
    key: "Keauhou",
    aliases: [/\b(?:na\s+hale\s+o\s+keauhou|keauhou|kailua[\s-]*kona|kona)\b/i],
    searchLocation: "Keauhou, Kailua-Kona, Big Island, Hawaii",
    location: { searchName: "Keauhou Estates", city: "Kailua-Kona", state: "Hawaii", streetAddress: "78-6855 Ali'i Dr", lat: 19.5493, lng: -155.9704 },
    bounds: { sw_lat: 19.528, sw_lng: -155.992, ne_lat: 19.558, ne_lng: -155.966 },
  },
  "Princeville": {
    key: "Princeville",
    aliases: [/\b(?:princeville|mauna\s+kai|hanalei|haena)\b/i],
    searchLocation: "Princeville, Kauai, Hawaii",
    location: { searchName: "Mauna Kai Princeville", city: "Princeville", state: "Hawaii", streetAddress: "3920 Wyllie Rd", lat: 22.2218, lng: -159.4849 },
    bounds: { sw_lat: 22.210, sw_lng: -159.498, ne_lat: 22.235, ne_lng: -159.468 },
  },
  "Kapaa Beachfront": {
    key: "Kapaa Beachfront",
    aliases: [/\b(?:kaha\s+lani|kapaa|kapa'?a|wailua|lihue|anahola)\b/i],
    searchLocation: "Kaha Lani Resort, Wailua, Kauai, Hawaii",
    location: { searchName: "Kaha Lani Resort", city: "Wailua", state: "Hawaii", lat: 22.0360, lng: -159.3370 },
    bounds: { sw_lat: 22.021, sw_lng: -159.352, ne_lat: 22.051, ne_lng: -159.322 },
  },
  "Poipu Oceanfront": {
    key: "Poipu Oceanfront",
    aliases: [/\b(?:poipu\s+oceanfront|brennecke|ho'?one|makahuena)\b/i],
    searchLocation: "Poipu Beach, Koloa, Kauai, Hawaii",
    location: { searchName: "Poipu Brenneckes Oceanfront", city: "Koloa", state: "Hawaii", streetAddress: "2298 Ho'one Rd", lat: 21.8744, lng: -159.4538 },
    bounds: { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
  },
  "Poipu Brenneckes": {
    key: "Poipu Brenneckes",
    aliases: [/\b(?:poipu\s+brenneckes|brenneckes)\b/i],
    searchLocation: "Brenneckes Beach, Poipu, Kauai, Hawaii",
    location: { searchName: "Poipu Brenneckes", city: "Koloa", state: "Hawaii", streetAddress: "2298 Ho'one Rd", lat: 21.8744, lng: -159.4538 },
    bounds: { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
  },
  "Pili Mai": {
    key: "Pili Mai",
    aliases: [/\bpili\s+mai\b/i],
    searchLocation: "Pili Mai at Poipu, Koloa, Kauai, Hawaii",
    location: { searchName: "Pili Mai at Poipu", city: "Koloa", state: "Hawaii", streetAddress: "2611 Kiahuna Plantation Dr", lat: 21.8865, lng: -159.4729 },
    bounds: { sw_lat: 21.882, sw_lng: -159.483, ne_lat: 21.899, ne_lng: -159.468 },
  },
  "Menehune Shores": {
    key: "Menehune Shores",
    aliases: [/\bmenehune\s+shores\b/i],
    searchLocation: "Menehune Shores, Kihei, Hawaii",
    location: { searchName: "Menehune Shores", city: "Kihei", state: "Hawaii", streetAddress: "760 S Kihei Rd", lat: 20.7638, lng: -156.4594 },
  },
  "Windsor Hills": {
    key: "Windsor Hills",
    aliases: [/\b(?:windsor\s+hills|kissimmee|orlando)\b/i],
    searchLocation: "Windsor Hills Resort, Kissimmee, Florida",
    location: { searchName: "Windsor Hills Resort", city: "Kissimmee", state: "Florida", streetAddress: "2600 N Old Lake Wilson Rd", lat: 28.3222, lng: -81.5961 },
    bounds: { sw_lat: 28.305, sw_lng: -81.615, ne_lat: 28.340, ne_lng: -81.575 },
  },
  "Bonita National": {
    key: "Bonita National",
    aliases: [/\b(?:bonita\s+national|bonita\s+springs|estero|naples)\b/i],
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
  "Southern Dunes": {
    key: "Southern Dunes",
    aliases: [/\b(?:southern\s+dunes|haines\s+city|davenport)\b/i],
    searchLocation: "Southern Dunes, Haines City, Florida",
  },
  "Caribe Cove": {
    key: "Caribe Cove",
    aliases: [/\bcaribe\s+cove\b/i],
    searchLocation: "Caribe Cove Resort, Kissimmee, Florida",
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
  "Windsor Hills": ["Caribe Cove", "Southern Dunes"],
  "Caribe Cove": ["Windsor Hills", "Southern Dunes"],
  "Southern Dunes": ["Windsor Hills", "Caribe Cove"],
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
