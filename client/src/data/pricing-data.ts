// ─────────────────────────────────────────────────────────────
// PRICING DATA
// Source: Airbnb & VRBO live listings · May 2026 · All-in retail
// (taxes + cleaning + platform fees already included in base rates)
// ─────────────────────────────────────────────────────────────

export type SeasonType = "HIGH" | "MEDIUM" | "LOW";
export type RegionType = "hawaii" | "florida";

export type MonthRate = {
  month: string;
  year: number;
  yearMonth: string;
  season: SeasonType;
  buyInRate: number;
  sellRate: number;
};

export type UnitPricing = {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
  community: string;
  baseBuyIn: number;
  baseSellRate: number;
  monthlyRates: MonthRate[];
};

export type PropertyPricing = {
  propertyId: number;
  totalBaseBuyIn: number;
  totalBaseSellRate: number;
  units: UnitPricing[];
};

const MARKUP = 1.584;

// ─────────────────────────────────────────────────────────────
// SEASON MULTIPLIERS — region-specific
// ─────────────────────────────────────────────────────────────

const SEASON_MULTIPLIERS: Record<RegionType, Record<SeasonType, number>> = {
  hawaii:  { LOW: 0.85, MEDIUM: 1.00, HIGH: 1.50 },
  florida: { LOW: 0.80, MEDIUM: 1.00, HIGH: 1.45 },
};

// ─────────────────────────────────────────────────────────────
// MONTHLY SEASON MAPS — keyed by "YYYY-MM"
// ─────────────────────────────────────────────────────────────

const HAWAII_SEASONS: Record<string, SeasonType> = {
  "2026-04": "HIGH",
  "2026-05": "MEDIUM",
  "2026-06": "HIGH",
  "2026-07": "HIGH",
  "2026-08": "HIGH",
  "2026-09": "LOW",
  "2026-10": "LOW",
  "2026-11": "MEDIUM",
  "2026-12": "HIGH",
  "2027-01": "HIGH",
  "2027-02": "MEDIUM",
  "2027-03": "HIGH",
  "2027-04": "HIGH",
  "2027-05": "MEDIUM",
  "2027-06": "HIGH",
  "2027-07": "HIGH",
  "2027-08": "HIGH",
  "2027-09": "LOW",
  "2027-10": "LOW",
  "2027-11": "MEDIUM",
  "2027-12": "HIGH",
};

const FLORIDA_SEASONS: Record<string, SeasonType> = {
  "2026-04": "MEDIUM",
  "2026-05": "MEDIUM",
  "2026-06": "HIGH",
  "2026-07": "HIGH",
  "2026-08": "HIGH",
  "2026-09": "LOW",
  "2026-10": "MEDIUM",
  "2026-11": "MEDIUM",
  "2026-12": "HIGH",
  "2027-01": "LOW",
  "2027-02": "MEDIUM",
  "2027-03": "HIGH",
  "2027-04": "MEDIUM",
  "2027-05": "MEDIUM",
  "2027-06": "HIGH",
  "2027-07": "HIGH",
  "2027-08": "HIGH",
  "2027-09": "LOW",
  "2027-10": "MEDIUM",
  "2027-11": "MEDIUM",
  "2027-12": "HIGH",
};

// ─────────────────────────────────────────────────────────────
// BASE BUY-IN RATES — per community, per bedroom count
// ─────────────────────────────────────────────────────────────

type CommunityRate = {
  "2BR"?: number;
  "3BR"?: number;
  "4BR"?: number;
  "5BR"?: number;
  region: RegionType;
};

const BUY_IN_RATES: Record<string, CommunityRate> = {
  // Kauai – South Shore
  "Poipu Kai":        { "2BR": 430, "3BR": 530, "4BR": 715,            region: "hawaii" },
  "Poipu Oceanfront": { "2BR": 525, "3BR": 660, "4BR": 780,            region: "hawaii" },
  "Poipu Brenneckes": { "2BR": 425, "3BR": 515, "4BR": 720,            region: "hawaii" },
  "Pili Mai":         { "2BR": 480, "3BR": 620, "4BR": 700,            region: "hawaii" },
  // Kauai – East Shore
  "Kapaa Beachfront": { "2BR": 490, "3BR": 700, "4BR": 850,            region: "hawaii" },
  // Kauai – North Shore
  "Princeville":      { "2BR": 410, "3BR": 620, "4BR": 715,            region: "hawaii" },
  // Kauai – West Shore
  "Kekaha Beachfront":{ "2BR": 450, "3BR": 675, "4BR": 900,            region: "hawaii" },
  // Big Island – Kona Coast
  "Keauhou":          { "2BR": 260,                                     region: "hawaii" },
  // Florida – Orlando Area
  "Southern Dunes":   {            "3BR": 160, "4BR": 167,             region: "florida" },
  "Windsor Hills":    {            "3BR": 175, "4BR": 245,             region: "florida" },
};

const FALLBACK_RATE_PER_BEDROOM = 225;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function getCommunityRegion(community: string): RegionType {
  return BUY_IN_RATES[community]?.region ?? "hawaii";
}

function getBuyInRate(community: string, bedrooms: number): number {
  const entry = BUY_IN_RATES[community];
  const key = `${bedrooms}BR` as keyof CommunityRate;
  const rate = entry?.[key];
  if (typeof rate === "number") return rate;
  return FALLBACK_RATE_PER_BEDROOM * bedrooms;
}

function getSeasonForMonth(yearMonth: string, region: RegionType): SeasonType {
  const map = region === "florida" ? FLORIDA_SEASONS : HAWAII_SEASONS;
  return map[yearMonth] ?? "MEDIUM";
}

// Generates 21 months of rates: April 2026 → December 2027
const RATE_SCHEDULE_MONTHS: { yearMonth: string; monthIndex: number; year: number }[] = (() => {
  const months: { yearMonth: string; monthIndex: number; year: number }[] = [];
  let year = 2026;
  let monthIndex = 3; // April = index 3
  for (let i = 0; i < 21; i++) {
    const mm = String(monthIndex + 1).padStart(2, "0");
    months.push({ yearMonth: `${year}-${mm}`, monthIndex, year });
    monthIndex++;
    if (monthIndex > 11) { monthIndex = 0; year++; }
  }
  return months;
})();

function generateMonthlyRates(baseBuyIn: number, community: string): MonthRate[] {
  const region = getCommunityRegion(community);
  return RATE_SCHEDULE_MONTHS.map(({ yearMonth, monthIndex, year }) => {
    const season = getSeasonForMonth(yearMonth, region);
    const multiplier = SEASON_MULTIPLIERS[region][season];
    const buyInRate = Math.round(baseBuyIn * multiplier);
    const sellRate = Math.round(buyInRate * MARKUP);
    return {
      month: MONTH_NAMES[monthIndex],
      year,
      yearMonth,
      season,
      buyInRate,
      sellRate,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// PROPERTY → UNIT CONFIGURATION
// ─────────────────────────────────────────────────────────────

type UnitConfig = {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
};

const PROPERTY_UNIT_CONFIGS: Record<number, { community: string; units: UnitConfig[] }> = {
  1: {
    community: "Poipu Kai",
    units: [
      { unitId: "924", unitLabel: "Unit 924", bedrooms: 3 },
      { unitId: "114", unitLabel: "Unit 114", bedrooms: 2 },
      { unitId: "911", unitLabel: "Unit 911", bedrooms: 2 },
    ],
  },
  4: {
    community: "Poipu Kai",
    units: [
      { unitId: "721", unitLabel: "Unit 721", bedrooms: 3 },
      { unitId: "812", unitLabel: "Unit 812", bedrooms: 3 },
    ],
  },
  7: {
    community: "Poipu Kai",
    units: [
      { unitId: "A", unitLabel: "Villa A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Villa B", bedrooms: 3 },
      { unitId: "C", unitLabel: "Villa C", bedrooms: 2 },
    ],
  },
  8: {
    community: "Poipu Kai",
    units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
    ],
  },
  9: {
    community: "Poipu Kai",
    units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
    ],
  },
  10: {
    community: "Kekaha Beachfront",
    units: [
      { unitId: "main", unitLabel: "Main House", bedrooms: 3 },
      { unitId: "guest", unitLabel: "Guest Quarters", bedrooms: 2 },
    ],
  },
  12: {
    community: "Kekaha Beachfront",
    units: [
      { unitId: "main", unitLabel: "Main House", bedrooms: 3 },
      { unitId: "guest", unitLabel: "Guest Quarters", bedrooms: 2 },
    ],
  },
  14: {
    community: "Keauhou",
    units: [
      { unitId: "main", unitLabel: "Main House", bedrooms: 4 },
      { unitId: "guest", unitLabel: "Guest Quarters", bedrooms: 2 },
    ],
  },
  18: {
    community: "Poipu Kai",
    units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
    ],
  },
  19: {
    community: "Princeville",
    units: [
      { unitId: "A", unitLabel: "Townhome A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Townhome B", bedrooms: 2 },
    ],
  },
  20: {
    community: "Princeville",
    units: [
      { unitId: "A", unitLabel: "Townhome A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Townhome B", bedrooms: 3 },
    ],
  },
  21: {
    community: "Poipu Kai",
    units: [
      { unitId: "A", unitLabel: "Villa A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Villa B", bedrooms: 3 },
      { unitId: "C", unitLabel: "Villa C", bedrooms: 2 },
    ],
  },
  23: {
    community: "Kapaa Beachfront",
    units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
    ],
  },
  24: {
    community: "Poipu Oceanfront",
    units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
    ],
  },
  26: {
    community: "Keauhou",
    units: [
      { unitId: "main", unitLabel: "Main House", bedrooms: 5 },
      { unitId: "guest", unitLabel: "Guest Quarters", bedrooms: 2 },
    ],
  },
  27: {
    community: "Poipu Kai",
    units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 2 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
    ],
  },
  28: {
    community: "Poipu Brenneckes",
    units: [
      { unitId: "A", unitLabel: "Home A", bedrooms: 4 },
      { unitId: "B", unitLabel: "Home B", bedrooms: 3 },
    ],
  },
  29: {
    community: "Princeville",
    units: [
      { unitId: "A", unitLabel: "Townhome A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Townhome B", bedrooms: 4 },
    ],
  },
  31: {
    community: "Poipu Brenneckes",
    units: [
      { unitId: "main", unitLabel: "Main Home", bedrooms: 5 },
      { unitId: "guest", unitLabel: "Guest Quarters", bedrooms: 2 },
    ],
  },
  32: {
    community: "Pili Mai",
    units: [
      { unitId: "A", unitLabel: "Townhome A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Townhome B", bedrooms: 2 },
    ],
  },
  33: {
    community: "Pili Mai",
    units: [
      { unitId: "A", unitLabel: "Townhome A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Townhome B", bedrooms: 3 },
    ],
  },
  34: {
    community: "Poipu Kai",
    units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
    ],
  },
  36: {
    community: "Southern Dunes",
    units: [
      { unitId: "main", unitLabel: "Main House", bedrooms: 3 },
    ],
  },
  37: {
    community: "Windsor Hills",
    units: [
      { unitId: "main", unitLabel: "Main Condo", bedrooms: 3 },
    ],
  },
};

// ─────────────────────────────────────────────────────────────
// EXPORTED FUNCTIONS
// ─────────────────────────────────────────────────────────────

export function getPropertyPricing(propertyId: number): PropertyPricing | null {
  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) return null;

  const units: UnitPricing[] = config.units.map((unit) => {
    const baseBuyIn = getBuyInRate(config.community, unit.bedrooms);
    const baseSellRate = Math.round(baseBuyIn * MARKUP);
    const monthlyRates = generateMonthlyRates(baseBuyIn, config.community);
    return {
      unitId: unit.unitId,
      unitLabel: unit.unitLabel,
      bedrooms: unit.bedrooms,
      community: config.community,
      baseBuyIn,
      baseSellRate,
      monthlyRates,
    };
  });

  const totalBaseBuyIn = units.reduce((sum, u) => sum + u.baseBuyIn, 0);
  const totalBaseSellRate = units.reduce((sum, u) => sum + u.baseSellRate, 0);

  return { propertyId, totalBaseBuyIn, totalBaseSellRate, units };
}

export function getSeasonLabel(season: SeasonType): string {
  switch (season) {
    case "HIGH":   return "High";
    case "MEDIUM": return "Mid";
    case "LOW":    return "Low";
  }
}

export function getSeasonColor(season: SeasonType): string {
  switch (season) {
    case "HIGH":   return "text-red-600 dark:text-red-400";
    case "MEDIUM": return "text-yellow-600 dark:text-yellow-400";
    case "LOW":    return "text-green-600 dark:text-green-400";
  }
}

export function getSeasonBadgeVariant(season: SeasonType): "destructive" | "secondary" | "default" {
  switch (season) {
    case "HIGH":   return "destructive";
    case "MEDIUM": return "secondary";
    case "LOW":    return "default";
  }
}

export function getAllUnitPricings(): { propertyId: number; community: string; unit: UnitPricing }[] {
  const results: { propertyId: number; community: string; unit: UnitPricing }[] = [];
  for (const [id, config] of Object.entries(PROPERTY_UNIT_CONFIGS)) {
    const propertyId = parseInt(id, 10);
    for (const unitCfg of config.units) {
      const baseBuyIn = getBuyInRate(config.community, unitCfg.bedrooms);
      const baseSellRate = Math.round(baseBuyIn * MARKUP);
      const monthlyRates = generateMonthlyRates(baseBuyIn, config.community);
      results.push({
        propertyId,
        community: config.community,
        unit: {
          unitId: unitCfg.unitId,
          unitLabel: unitCfg.unitLabel,
          bedrooms: unitCfg.bedrooms,
          community: config.community,
          baseBuyIn,
          baseSellRate,
          monthlyRates,
        },
      });
    }
  }
  return results;
}

export function calculateStaySellRate(
  propertyId: number,
  checkIn: string,
  checkOut: string
): { totalSellRate: number; totalNights: number; nightlyBreakdown: { date: string; sellRate: number }[] } | null {
  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) return null;

  const region = getCommunityRegion(config.community);
  const start = new Date(checkIn + "T12:00:00");
  const end = new Date(checkOut + "T12:00:00");
  const nightlyBreakdown: { date: string; sellRate: number }[] = [];
  let totalSellRate = 0;
  let totalNights = 0;

  const current = new Date(start);
  while (current < end) {
    const mm = String(current.getMonth() + 1).padStart(2, "0");
    const yearMonth = `${current.getFullYear()}-${mm}`;
    const season = getSeasonForMonth(yearMonth, region);
    const multiplier = SEASON_MULTIPLIERS[region][season];

    let nightlySellRate = 0;
    for (const unit of config.units) {
      const baseBuyIn = getBuyInRate(config.community, unit.bedrooms);
      const buyInRate = Math.round(baseBuyIn * multiplier);
      const sellRate = Math.round(buyInRate * MARKUP);
      nightlySellRate += sellRate;
    }

    nightlyBreakdown.push({ date: current.toISOString().split("T")[0], sellRate: nightlySellRate });
    totalSellRate += nightlySellRate;
    totalNights++;
    current.setDate(current.getDate() + 1);
  }

  return { totalSellRate, totalNights, nightlyBreakdown };
}

export { MARKUP, SEASON_MULTIPLIERS, BUY_IN_RATES };
