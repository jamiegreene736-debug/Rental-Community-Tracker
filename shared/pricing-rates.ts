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
  // 3BR re-set 2026-04-28 from $840 to $615 to match the live-data
  // methodology operator chose to keep. The live Airbnb-engine
  // backfill landed Kapaa Beachfront 2BR at $430/n=4 (vs the prior
  // static $588 — 27% drop), but Kapaa proper has no 3BR condo comps
  // in the operator's COMMUNITY_BOUNDS zone, so the per-property
  // refresh persists no 3BR row and the Pricing tab falls through to
  // this static value for unit A on prop 23. Extrapolation: $430 ×
  // 1.43 (the prior static 3BR/2BR ratio for this community) = $615 —
  // keeps prop 23's 3BR component consistent with the rest of the
  // live-data table.
  "Kapaa Beachfront":  { "2BR": 588, "3BR": 615, "4BR": 1020, region: "hawaii" },
  "Princeville":       { "2BR": 492, "3BR": 744, "4BR": 858,  region: "hawaii" },
  "Kekaha Beachfront": { "2BR": 540, "3BR": 810, "4BR": 1080, region: "hawaii" },
  "Keauhou":           { "2BR": 312,                          region: "hawaii" },
  "Southern Dunes":    { "2BR":  85, "3BR": 192, "4BR": 200,  region: "florida" },
  "Windsor Hills":     { "2BR": 150, "3BR": 210, "4BR": 294,  region: "florida" },
  // Caribe Cove (Kissimmee, FL) — older mid-tier resort ~5mi from Disney.
  // 2BR base of $125 reflects what the unit actually rents for on
  // Airbnb/VRBO including taxes + fees (operator-validated 2026-04, see
  // PR that introduced this entry). Lower than Windsor Hills which is a
  // newer, more amenitied build. 3BR set proportionally — refresh
  // empirically once we have a real 3BR draft to compare against.
  "Caribe Cove":       { "2BR": 125, "3BR": 175,              region: "florida" },
};

// Region-aware fallback for areas not in BUY_IN_RATES. Hawaii's $270/BR
// matches the average 2BR cost basis across our Kauai inventory; Florida's
// $80/BR matches the Disney-area condo cost basis (Caribe Cove 2BR ≈
// $62/BR, Southern Dunes 3BR ≈ $64/BR). Using the Hawaii number for a
// Florida draft inflates the dashboard buy-in by ~3.5×. See the note in
// `getBuyInRate` for how the fallback is selected.
const FALLBACK_RATE_PER_BEDROOM: Record<RegionType, number> = {
  hawaii:  270,
  florida:  80,
};

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

// Suggest a BUY_IN_RATES key for a draft. Used by the Add a New
// Community wizard's pricing-area picker as the default selection —
// operator can override. Returns "" when nothing matches; the dashboard
// treats that as "no pricing area" and falls back to the per-bedroom
// rate for the region.
//
// `communityName` (optional) lets us pin specific named complexes to
// their own tier when one exists in BUY_IN_RATES. This matters because
// city/state alone can't distinguish "Caribe Cove" (older mid-tier,
// ~$125/night per 2BR) from "Windsor Hills" (newer premium, ~$210+
// for 3BR) — both are in Kissimmee. The name match runs first so a
// known complex always lands on its own tier.
export function suggestPricingArea(
  city: string,
  state: string,
  communityName?: string,
): string {
  const name = (communityName || "").toLowerCase();
  if (name) {
    // Match against every BUY_IN_RATES key. A community draft named
    // "Caribe Cove Resort" should resolve to "Caribe Cove"; allowing
    // a substring match handles "Resort" / "Condos" suffixes that
    // operators add to the name field.
    for (const key of Object.keys(BUY_IN_RATES)) {
      if (name.includes(key.toLowerCase())) return key;
    }
  }
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
    // Three FL keys in BUY_IN_RATES — Southern Dunes (Haines City /
    // Davenport, ~15-25mi from Disney, lower buy-in), Caribe Cove
    // (older Kissimmee resort), and Windsor Hills (Disney-proximate
    // newer-build tier). Kissimmee is broad but most STR-eligible
    // communities there are within ~5mi of the parks, so default to
    // Windsor Hills tier when no specific name matched above and let
    // the operator downshift to Caribe Cove or Southern Dunes if the
    // build is older or further out.
    if (/\b(haines city|davenport)\b/.test(c)) return "Southern Dunes";
    if (/\b(orlando|kissimmee)\b/.test(c)) return "Windsor Hills";
    return "";
  }
  return "";
}

// Live per-(propertyId, bedrooms) buy-in cache. Hydrated client-side
// from `GET /api/property/market-rates` at app mount via
// `setLivePropertyMarketRates`. Empty on the server (server reads
// `property_market_rates` directly from the DB) — that's fine; this
// file is shared but the cache only lives in process memory and the
// only callers that need it run client-side.
//
// Lookup key: `${propertyId}::${bedrooms}`. Negative propertyIds are
// drafts (the synthetic `-draftId` convention used everywhere on the
// dashboard); positive ids are static properties from
// `unit-builder-data.ts`. One cache covers both.
type LiveBuyInKey = string;
type LiveBuyInEntry = {
  // LOW-season basis — primary value the formula uses when called
  // without a season argument (and the field every existing reader
  // already expects). Always present.
  medianNightly: number;
  // Per-season basis added in PR #282. Populated when the multi-
  // season scan ran for that property; null when the scan was
  // legacy single-window OR the season window was unreachable.
  medianNightlyHigh: number | null;
  medianNightlyHoliday: number | null;
  sampleCount: number;
  refreshedAt: string;
  source: string;
};
const _liveBuyIns = new Map<LiveBuyInKey, LiveBuyInEntry>();
const liveKey = (propertyId: number, bedrooms: number): LiveBuyInKey => `${propertyId}::${bedrooms}`;

export type LivePropertyMarketRateInput = {
  propertyId: number;
  bedrooms: number;
  medianNightly: number | string;
  medianNightlyHigh?: number | string | null;
  medianNightlyHoliday?: number | string | null;
  sampleCount: number;
  refreshedAt: string;
  source: string;
};

function parseNullableRate(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setLivePropertyMarketRates(rates: LivePropertyMarketRateInput[]): void {
  _liveBuyIns.clear();
  for (const r of rates) {
    const median = typeof r.medianNightly === "number" ? r.medianNightly : parseFloat(r.medianNightly);
    if (!Number.isFinite(median) || median <= 0) continue;
    _liveBuyIns.set(liveKey(r.propertyId, r.bedrooms), {
      medianNightly: median,
      medianNightlyHigh: parseNullableRate(r.medianNightlyHigh),
      medianNightlyHoliday: parseNullableRate(r.medianNightlyHoliday),
      sampleCount: r.sampleCount,
      refreshedAt: r.refreshedAt,
      source: r.source,
    });
  }
}

export function getLiveBuyIn(propertyId: number, bedrooms: number): LiveBuyInEntry | null {
  return _liveBuyIns.get(liveKey(propertyId, bedrooms)) ?? null;
}

// Fallback chain (highest → lowest priority):
//   1. Live per-season basis for (propertyId, bedrooms, season) when
//      a season is supplied AND the multi-season scan populated it.
//   2. Live LOW basis × SEASON_MULTIPLIERS for the season (legacy
//      multiplier model when per-season basis is absent).
//   3. BUY_IN_RATES[community][${BR}BR] — operator-validated static.
//   4. FALLBACK_RATE_PER_BEDROOM[region] × bedrooms — per-region
//      default for areas not in the static table.
//
// `season` is optional: when omitted, returns the LOW basis directly
// (the legacy single-value behavior). When supplied, returns the
// season-specific basis from the multi-season scan when available,
// otherwise applies the multiplier to the LOW basis.
export function getBuyInRate(
  community: string,
  bedrooms: number,
  propertyId?: number,
  season?: SeasonType,
): number {
  if (propertyId != null) {
    const live = _liveBuyIns.get(liveKey(propertyId, bedrooms));
    if (live) {
      // Season-specific basis when available + requested.
      if (season === "HIGH" && live.medianNightlyHigh != null) return live.medianNightlyHigh;
      if (season === "HOLIDAY" && live.medianNightlyHoliday != null) return live.medianNightlyHoliday;
      // LOW or unknown-season → use base. When the caller supplied
      // HIGH/HOLIDAY but per-season basis isn't populated, apply the
      // multiplier so the formula still varies seasonally.
      if (season && season !== "LOW") {
        const region = BUY_IN_RATES[community]?.region ?? getCommunityRegion(community);
        const multiplier = SEASON_MULTIPLIERS[region][season];
        return Math.round(live.medianNightly * multiplier);
      }
      return live.medianNightly;
    }
  }
  const entry = BUY_IN_RATES[community];
  const key = `${bedrooms}BR` as keyof CommunityRate;
  const rate = entry?.[key];
  if (typeof rate === "number") {
    // Static-table values are an annual BASELINE (not pre-calibrated
    // to any specific season). Legacy callers pre-PR #282 always
    // applied SEASON_MULTIPLIERS on top, including the 0.80 LOW
    // multiplier. PR #283 accidentally skipped the LOW multiplier
    // when a season was explicitly passed, inflating LOW-month
    // totals for properties relying on the static fallback (3BR
    // Kaha Lani: was $615 raw, should be $615 × 0.80 = $492).
    // Restore: apply multiplier for ALL seasons including LOW when
    // a season is supplied. Legacy seasonless callers still get
    // the raw baseline back.
    if (season) {
      const region = entry?.region ?? getCommunityRegion(community);
      const multiplier = SEASON_MULTIPLIERS[region][season];
      return Math.round(rate * multiplier);
    }
    return rate;
  }
  // No exact rate. Fall back per region — Florida and Hawaii cost
  // bases differ by ~3.5×, so a global per-BR fallback would inflate
  // one market or under-price the other. If the community isn't in
  // the table at all, getCommunityRegion defaults to hawaii.
  const region = entry?.region ?? getCommunityRegion(community);
  const fallback = FALLBACK_RATE_PER_BEDROOM[region] * bedrooms;
  if (season) {
    const multiplier = SEASON_MULTIPLIERS[region][season];
    return Math.round(fallback * multiplier);
  }
  return fallback;
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
//
// PR #282: when a per-season basis is populated for the (propertyId,
// bedrooms) pair, getBuyInRate(community, br, propertyId, season)
// returns it directly — no multiplier applied. Falls back to LOW ×
// multiplier when the per-season basis is missing.
export function totalNightlyBuyInForMonth(
  community: string,
  unitSlots: Array<{ bedrooms: number }>,
  yearMonth: string,
  propertyId?: number,
): number {
  const region = getCommunityRegion(community);
  const season = getSeasonForMonth(yearMonth, region);
  let total = 0;
  for (const slot of unitSlots) {
    total += getBuyInRate(community, slot.bedrooms, propertyId, season);
  }
  return total;
}
