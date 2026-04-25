// Static cost-basis tables shared by client (pricing-data.ts) and server
// (availability-scheduler).
//
// These are what we PAY to buy into other hosts' listings — NOT what we
// charge guests. Sourced from manual market research per community + BR
// count, multiplied by season factor. Used as the floor for computing
// a "cost + 20% margin" target rate.
//
// Important: don't drop the airbnb engine's live SELL prices in here as
// "live cost basis" — those are other hosts' marked-up retail rates,
// which would inflate our target by ~80%. Treat live engine numbers as
// telemetry only.

export type SeasonType = "HIGH" | "LOW" | "HOLIDAY";
export type RegionType = "hawaii" | "florida";

type CommunityRate = {
  "2BR"?: number;
  "3BR"?: number;
  "4BR"?: number;
  "5BR"?: number;
  region: RegionType;
};

export const BUY_IN_RATES: Record<string, CommunityRate> = {
  "Poipu Kai":         { "2BR": 516, "3BR": 636, "4BR": 858,  region: "hawaii" },
  "Poipu Oceanfront":  { "2BR": 630, "3BR": 792, "4BR": 936,  region: "hawaii" },
  "Poipu Brenneckes":  { "2BR": 510, "3BR": 618, "4BR": 864,  region: "hawaii" },
  "Pili Mai":          { "2BR": 576, "3BR": 744, "4BR": 840,  region: "hawaii" },
  "Kapaa Beachfront":  { "2BR": 588, "3BR": 840, "4BR": 1020, region: "hawaii" },
  "Princeville":       { "2BR": 492, "3BR": 744, "4BR": 858,  region: "hawaii" },
  "Kekaha Beachfront": { "2BR": 540, "3BR": 810, "4BR": 1080, region: "hawaii" },
  "Keauhou":           { "2BR": 312,                          region: "hawaii" },
  "Southern Dunes":    {            "3BR": 192, "4BR": 200,   region: "florida" },
  "Windsor Hills":     {            "3BR": 210, "4BR": 294,   region: "florida" },
};
const FALLBACK_RATE_PER_BEDROOM = 270;

export const SEASON_MULTIPLIERS: Record<RegionType, Record<SeasonType, number>> = {
  hawaii:  { LOW: 0.80, HIGH: 1.30, HOLIDAY: 1.80 },
  florida: { LOW: 0.75, HIGH: 1.25, HOLIDAY: 1.70 },
};

const HAWAII_SEASONS: Record<string, SeasonType> = {
  "2026-04": "HIGH",  "2026-05": "LOW",  "2026-06": "HIGH",  "2026-07": "HIGH",
  "2026-08": "HIGH",  "2026-09": "LOW",  "2026-10": "LOW",   "2026-11": "LOW",
  "2026-12": "HIGH",  "2027-01": "HIGH", "2027-02": "LOW",   "2027-03": "HIGH",
  "2027-04": "HIGH",  "2027-05": "LOW",  "2027-06": "HIGH",  "2027-07": "HIGH",
  "2027-08": "HIGH",  "2027-09": "LOW",  "2027-10": "LOW",   "2027-11": "LOW",
  "2027-12": "HIGH",  "2028-01": "HIGH", "2028-02": "LOW",   "2028-03": "HIGH",
  "2028-04": "HIGH",
};
const FLORIDA_SEASONS: Record<string, SeasonType> = {
  "2026-04": "HIGH",  "2026-05": "LOW",  "2026-06": "HIGH",  "2026-07": "HIGH",
  "2026-08": "HIGH",  "2026-09": "LOW",  "2026-10": "LOW",   "2026-11": "LOW",
  "2026-12": "HIGH",  "2027-01": "LOW",  "2027-02": "LOW",   "2027-03": "HIGH",
  "2027-04": "HIGH",  "2027-05": "LOW",  "2027-06": "HIGH",  "2027-07": "HIGH",
  "2027-08": "HIGH",  "2027-09": "LOW",  "2027-10": "LOW",   "2027-11": "LOW",
  "2027-12": "HIGH",  "2028-01": "LOW",  "2028-02": "LOW",   "2028-03": "HIGH",
  "2028-04": "HIGH",
};

export function getCommunityRegion(community: string): RegionType {
  return BUY_IN_RATES[community]?.region ?? "hawaii";
}

// Suggest a BUY_IN_RATES key based on the city / state a draft is
// being added in. Used by the Add a New Community wizard's pricing-
// area picker as the default selection — operator can override.
// Returns "" when nothing matches; the dashboard treats that as
// "no pricing area" and falls back to the default per-bedroom rate.
export function suggestPricingArea(city: string, state: string): string {
  const c = (city || "").toLowerCase();
  const s = (state || "").toLowerCase();
  if (s === "hawaii" || s === "hi") {
    if (/\b(poipu|koloa|kalaheo)\b/.test(c)) return "Poipu Kai";
    if (/\b(princeville|hanalei|haena)\b/.test(c)) return "Princeville";
    if (/\b(kapaa|wailua|lihue|anahola)\b/.test(c)) return "Kapaa Beachfront";
    if (/\b(kekaha|waimea|hanapepe)\b/.test(c)) return "Kekaha Beachfront";
    if (/\b(kona|kailua-kona|keauhou|hilo|waikoloa|kohala)\b/.test(c)) return "Keauhou";
    return "";
  }
  if (s === "florida" || s === "fl") {
    // Two FL keys in BUY_IN_RATES — Southern Dunes (Haines City /
    // Davenport, ~15-25mi from Disney, lower buy-in) and Windsor
    // Hills (Disney-proximate vacation-rental tier). Kissimmee is
    // broad but most STR-eligible communities there (Caribe Cove,
    // Windsor Palms, Windsor Hills itself) are within ~5mi of the
    // parks, so default to Windsor Hills tier and let the operator
    // downshift to Southern Dunes if a specific Kissimmee community
    // is south of the 192 corridor. Earlier logic listed Kissimmee
    // under Southern Dunes which under-priced everything closer to
    // Disney.
    if (/\b(haines city|davenport)\b/.test(c)) return "Southern Dunes";
    if (/\b(orlando|kissimmee)\b/.test(c)) return "Windsor Hills";
    return "";
  }
  return "";
}

export function getBuyInRate(community: string, bedrooms: number): number {
  const entry = BUY_IN_RATES[community];
  const key = `${bedrooms}BR` as keyof CommunityRate;
  const rate = entry?.[key];
  if (typeof rate === "number") return rate;
  return FALLBACK_RATE_PER_BEDROOM * bedrooms;
}

export function getSeasonForMonth(yearMonth: string, region: RegionType): SeasonType {
  const map = region === "florida" ? FLORIDA_SEASONS : HAWAII_SEASONS;
  return map[yearMonth] ?? "LOW";
}

// Channel host-fee model + target margin. Kept here so server and client
// agree on the numbers — the client's pricing-data.ts re-exports from here.
export type ChannelKey = "airbnb" | "vrbo" | "booking" | "direct";

export const CHANNEL_HOST_FEE: Record<ChannelKey, number> = {
  airbnb:  0.155,
  vrbo:    0.08,
  booking: 0.17,
  direct:  0.03,
};

// Fee-differential markup per channel: makes every channel net the same
// dollars as Direct after its fee. Formula:
//   m_ch = (1 - fee_direct) / (1 - fee_ch) - 1
// Rounded UP to 0.1% so the resulting margin never rounds DOWN below target.
export function computeChannelMarkups(
  fees: Record<ChannelKey, number> = CHANNEL_HOST_FEE,
): Record<ChannelKey, number> {
  const feeDirect = fees.direct ?? 0;
  const out: Record<ChannelKey, number> = { airbnb: 0, vrbo: 0, booking: 0, direct: 0 };
  for (const ch of ["airbnb", "vrbo", "booking", "direct"] as ChannelKey[]) {
    const raw = (1 - feeDirect) / (1 - (fees[ch] ?? 0)) - 1;
    out[ch] = Math.max(0, Math.ceil(raw * 1000) / 1000);
  }
  return out;
}

// Maps our logical channel keys to Guesty's integration platform keys.
// Confirmed from a live listing readback 2026-04-21.
export const CHANNEL_TO_GUESTY_KEY: Record<ChannelKey, string> = {
  airbnb:  "airbnb2",
  vrbo:    "homeaway2",
  booking: "bookingCom",
  direct:  "manual",
};

// Total nightly buy-in cost for a property's full set of unit slots in
// a given month. Used as the cost floor for the seasonal rate push.
export function totalNightlyBuyInForMonth(
  community: string,
  unitSlots: Array<{ bedrooms: number }>,
  yearMonth: string,
): number {
  const region = getCommunityRegion(community);
  const season = getSeasonForMonth(yearMonth, region);
  const multiplier = SEASON_MULTIPLIERS[region][season];
  let total = 0;
  for (const slot of unitSlots) {
    total += Math.round(getBuyInRate(community, slot.bedrooms) * multiplier);
  }
  return total;
}
