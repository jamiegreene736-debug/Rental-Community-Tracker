export type SeasonType = "high" | "mid" | "low";

export type MonthRate = {
  month: string;
  year: number;
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

const MARKUP = 1.20;

const SEASON_MULTIPLIERS: Record<SeasonType, number> = {
  high: 1.25,
  mid: 1.00,
  low: 0.75,
};

const MONTH_SEASONS: SeasonType[] = [
  "high", // Jan
  "high", // Feb
  "high", // Mar
  "mid",  // Apr
  "mid",  // May
  "mid",  // Jun
  "high", // Jul
  "high", // Aug
  "low",  // Sep
  "low",  // Oct
  "low",  // Nov
  "high", // Dec
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const BUY_IN_RATES: Record<string, Record<number, number>> = {
  "Poipu Kai": {
    2: 425,
    3: 650,
  },
  "Kekaha Beachfront": {
    2: 500,
    3: 700,
  },
  "Princeville": {
    2: 400,
    3: 550,
    4: 750,
  },
  "Kapaa Beachfront": {
    2: 550,
    3: 750,
  },
  "Poipu Oceanfront": {
    2: 475,
    3: 675,
  },
  "Keauhou": {
    2: 350,
    4: 650,
    5: 1000,
  },
  "Poipu Brenneckes": {
    2: 400,
    3: 500,
    4: 625,
    5: 800,
  },
  "Kiahuna Plantation": {
    2: 600,
    3: 750,
  },
};

function getBuyInRate(community: string, bedrooms: number): number {
  const communityRates = BUY_IN_RATES[community];
  if (communityRates && communityRates[bedrooms]) {
    return communityRates[bedrooms];
  }
  const basePer = 225;
  return basePer * bedrooms;
}

function generateMonthlyRates(baseBuyIn: number): MonthRate[] {
  const rates: MonthRate[] = [];
  const startMonth = 1; // Feb 2026 (0-indexed = 1)
  const startYear = 2026;

  for (let i = 0; i < 24; i++) {
    const monthIndex = (startMonth + i) % 12;
    const year = startYear + Math.floor((startMonth + i) / 12);
    const season = MONTH_SEASONS[monthIndex];
    const multiplier = SEASON_MULTIPLIERS[season];
    const buyInRate = Math.round(baseBuyIn * multiplier);
    const sellRate = Math.round(buyInRate * MARKUP);

    rates.push({
      month: MONTH_NAMES[monthIndex],
      year,
      season,
      buyInRate,
      sellRate,
    });
  }

  return rates;
}

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
    community: "Kiahuna Plantation",
    units: [
      { unitId: "A", unitLabel: "Townhome A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Townhome B", bedrooms: 2 },
    ],
  },
  33: {
    community: "Kiahuna Plantation",
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
  27: {
    community: "Poipu Kai",
    units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 2 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
    ],
  },
};

export function getPropertyPricing(propertyId: number): PropertyPricing | null {
  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) return null;

  const units: UnitPricing[] = config.units.map((unit) => {
    const baseBuyIn = getBuyInRate(config.community, unit.bedrooms);
    const baseSellRate = Math.round(baseBuyIn * MARKUP);
    const monthlyRates = generateMonthlyRates(baseBuyIn);

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

  return {
    propertyId,
    totalBaseBuyIn,
    totalBaseSellRate,
    units,
  };
}

export function getSeasonLabel(season: SeasonType): string {
  switch (season) {
    case "high": return "High";
    case "mid": return "Mid";
    case "low": return "Low";
  }
}

export function getSeasonColor(season: SeasonType): string {
  switch (season) {
    case "high": return "text-red-600 dark:text-red-400";
    case "mid": return "text-yellow-600 dark:text-yellow-400";
    case "low": return "text-green-600 dark:text-green-400";
  }
}

export function getSeasonBadgeVariant(season: SeasonType): "destructive" | "secondary" | "default" {
  switch (season) {
    case "high": return "destructive";
    case "mid": return "secondary";
    case "low": return "default";
  }
}

export { MARKUP, SEASON_MULTIPLIERS, BUY_IN_RATES };
