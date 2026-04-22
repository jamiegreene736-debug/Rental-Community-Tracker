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
