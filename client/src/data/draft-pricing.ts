// Pricing generator for community drafts (negative propertyIds).
//
// `getPropertyPricing(propertyId)` only knows about the static
// PROPERTY_UNIT_CONFIGS and returns null for promoted drafts — that's
// why the Pricing tab was rendering empty for any community added
// through "Add a New Community". This module produces a PropertyPricing
// in the same shape, derived from the draft's bedroom counts +
// pricingArea (the BUY_IN_RATES key the operator picked on Step 5)
// or the AI-estimated low rate as a fallback.
//
// We re-use the same season multipliers / markup formula as the static
// path so a draft and an active property render the same 24-month
// schedule shape — operators can compare them apples-to-apples.

import type { CommunityDraft } from "@shared/schema";
import {
  type PropertyPricing,
  type UnitPricing,
  type MonthRate,
  type SeasonType,
  MARKUP,
} from "./pricing-data";
import {
  BUY_IN_RATES,
  getSeasonForMonth,
  SEASON_MULTIPLIERS,
  type RegionType,
} from "@shared/pricing-rates";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const FALLBACK_RATE_PER_BEDROOM = 270; // matches shared/pricing-rates.ts

// Build a 24-month rolling window starting this month — same window
// the static pricing schedule uses so the Pricing tab table aligns
// with what active properties show.
function build24MonthWindow(): { yearMonth: string; monthIndex: number; year: number }[] {
  const now = new Date();
  const out: { yearMonth: string; monthIndex: number; year: number }[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const monthIndex = d.getMonth();
    const year = d.getFullYear();
    out.push({
      yearMonth: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
      monthIndex,
      year,
    });
  }
  return out;
}

function regionFromState(state: string): RegionType {
  return /florida|fl\b/i.test(state || "") ? "florida" : "hawaii";
}

// Pick a base buy-in for a single unit. Order of preference:
//   1. BUY_IN_RATES[draft.pricingArea][${bedrooms}BR]  (operator
//      picked an area on Step 5 → exact rate from the table)
//   2. estimatedLowRate / 2  (split equally across two units)
//   3. FALLBACK_RATE_PER_BEDROOM × bedrooms
function baseBuyInForUnit(draft: CommunityDraft, bedrooms: number, isFirstUnit: boolean): number {
  const area = draft.pricingArea ?? "";
  if (area && BUY_IN_RATES[area]) {
    const key = `${bedrooms}BR` as keyof (typeof BUY_IN_RATES)[string];
    const rate = BUY_IN_RATES[area]?.[key];
    if (typeof rate === "number" && rate > 0) return rate;
  }
  if (typeof draft.estimatedLowRate === "number" && draft.estimatedLowRate > 0) {
    // Estimated rate is a per-night sell rate for the COMBINED listing.
    // Reverse the markup to get a buy-in, then split per unit.
    const buyInForCombined = Math.round(draft.estimatedLowRate / MARKUP);
    return Math.round(buyInForCombined / 2);
  }
  return FALLBACK_RATE_PER_BEDROOM * bedrooms;
}

function generateMonthlyRatesForUnit(
  baseBuyIn: number,
  region: RegionType,
): MonthRate[] {
  const window = build24MonthWindow();
  return window.map(({ yearMonth, monthIndex, year }) => {
    const season = getSeasonForMonth(yearMonth, region) as SeasonType;
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

export function buildDraftPropertyPricing(
  draft: CommunityDraft,
  propertyId: number,
): PropertyPricing {
  const region = regionFromState(draft.state);
  const community = draft.pricingArea && BUY_IN_RATES[draft.pricingArea]
    ? draft.pricingArea
    : draft.name;

  const u1Br = draft.unit1Bedrooms ?? 2;
  const u2Br = draft.unit2Bedrooms ?? 2;

  const unit1BaseBuyIn = baseBuyInForUnit(draft, u1Br, true);
  const unit2BaseBuyIn = baseBuyInForUnit(draft, u2Br, false);

  const unit1: UnitPricing = {
    unitId: `draft${draft.id}-unit-a`,
    unitLabel: "A",
    bedrooms: u1Br,
    community,
    baseBuyIn: unit1BaseBuyIn,
    baseSellRate: Math.round(unit1BaseBuyIn * MARKUP),
    monthlyRates: generateMonthlyRatesForUnit(unit1BaseBuyIn, region),
  };
  const unit2: UnitPricing = {
    unitId: `draft${draft.id}-unit-b`,
    unitLabel: "B",
    bedrooms: u2Br,
    community,
    baseBuyIn: unit2BaseBuyIn,
    baseSellRate: Math.round(unit2BaseBuyIn * MARKUP),
    monthlyRates: generateMonthlyRatesForUnit(unit2BaseBuyIn, region),
  };

  const totalBaseBuyIn = unit1.baseBuyIn + unit2.baseBuyIn;
  const totalBaseSellRate = unit1.baseSellRate + unit2.baseSellRate;

  return {
    propertyId,
    totalBaseBuyIn,
    totalBaseSellRate,
    units: [unit1, unit2],
  };
}
