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
// We re-use the same season multipliers / clean-margin base-rate formula as the static
// path so a draft and an active property render the same 24-month
// schedule shape — operators can compare them apples-to-apples.

import type { CommunityDraft } from "@shared/schema";
import {
  type PropertyPricing,
  type UnitPricing,
  type MonthRate,
  type SeasonType,
  MARKUP,
  cleanBaseRateFromBuyIn,
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
const FALLBACK_RATE_PER_BEDROOM: Record<RegionType, number> = {
  hawaii: 270,
  florida: 80,
};

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

function positiveInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function positiveMoney(value: unknown): number | null {
  const n = typeof value === "number"
    ? value
    : Number.parseFloat(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function inferDraftBedroomCount(draft: CommunityDraft, unitKey: "unit1" | "unit2"): number {
  const stored = unitKey === "unit1" ? draft.unit1Bedrooms : draft.unit2Bedrooms;
  const combined = (draft as any).singleListing === true ? draft.combinedBedrooms : null;
  const fromStructured = positiveInteger(stored) ?? positiveInteger(combined);
  if (fromStructured) return fromStructured;

  const unitText = [
    unitKey === "unit1" ? draft.unit1Description : draft.unit2Description,
    unitKey === "unit1" ? draft.unit1Bedding : draft.unit2Bedding,
    unitKey === "unit1" ? draft.unit1ShortDescription : draft.unit2ShortDescription,
    unitKey === "unit1" ? draft.unit1LongDescription : draft.unit2LongDescription,
  ].filter(Boolean).join(" ");
  const unitMatch = unitText.match(/(\d{1,2})\s*(?:br|bd|bed(?:room)?s?)/i);
  const fromUnitText = unitMatch ? positiveInteger(unitMatch[1]) : null;
  if (fromUnitText) return fromUnitText;
  if ((draft as any).singleListing !== true) return 2;

  const text = [
    draft.listingTitle,
    draft.bookingTitle,
    draft.name,
    draft.unitTypes,
    draft.listingDescription,
  ].filter(Boolean).join(" ");
  const match = text.match(/(\d{1,2})\s*(?:br|bd|bed(?:room)?s?)/i);
  const fromText = match ? positiveInteger(match[1]) : null;
  return fromText ?? 2;
}

// Pick a base buy-in for a single unit. Order of preference:
//   1. BUY_IN_RATES[draft.pricingArea][${bedrooms}BR]  (operator
//      picked an area on Step 5 → exact rate from the table)
//   2. estimatedLowRate reversed from sell-rate markup, split across
//      two units for combos and kept whole for single-listing drafts
//   3. region-aware FALLBACK_RATE_PER_BEDROOM × bedrooms
function baseBuyInForUnit(draft: CommunityDraft, bedrooms: number, region: RegionType): number {
  const area = draft.pricingArea ?? "";
  if (area && BUY_IN_RATES[area]) {
    const key = `${bedrooms}BR` as keyof (typeof BUY_IN_RATES)[string];
    const rate = BUY_IN_RATES[area]?.[key];
    if (typeof rate === "number" && rate > 0) return rate;
  }
  const estimatedLowRate = positiveMoney(draft.estimatedLowRate);
  if (estimatedLowRate != null) {
    // Estimated rate is a per-night sell rate for the listing. Reverse
    // the markup to get buy-in, then split only when the listing is a
    // true combo. Standalone drafts should not manufacture a second unit.
    const buyInForCombined = Math.round(estimatedLowRate / MARKUP);
    const unitCount = (draft as any).singleListing === true ? 1 : 2;
    return Math.round(buyInForCombined / unitCount);
  }
  return FALLBACK_RATE_PER_BEDROOM[region] * bedrooms;
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
    const sellRate = cleanBaseRateFromBuyIn(buyInRate);
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
    : region === "florida"
      ? "Florida Generic"
      : draft.name;

  const isSingle = (draft as any).singleListing === true;
  const u1Br = inferDraftBedroomCount(draft, "unit1");
  const u2Br = inferDraftBedroomCount(draft, "unit2");

  const unit1BaseBuyIn = baseBuyInForUnit(draft, u1Br, region);
  const unit2BaseBuyIn = baseBuyInForUnit(draft, u2Br, region);

  const unit1: UnitPricing = {
    unitId: `draft${draft.id}-unit-a`,
    unitLabel: "A",
    bedrooms: u1Br,
    community,
    baseBuyIn: unit1BaseBuyIn,
    baseSellRate: cleanBaseRateFromBuyIn(unit1BaseBuyIn),
    monthlyRates: generateMonthlyRatesForUnit(unit1BaseBuyIn, region),
  };
  const unit2: UnitPricing = {
    unitId: `draft${draft.id}-unit-b`,
    unitLabel: "B",
    bedrooms: u2Br,
    community,
    baseBuyIn: unit2BaseBuyIn,
    baseSellRate: cleanBaseRateFromBuyIn(unit2BaseBuyIn),
    monthlyRates: generateMonthlyRatesForUnit(unit2BaseBuyIn, region),
  };

  const units = isSingle ? [unit1] : [unit1, unit2];
  const totalBaseBuyIn = units.reduce((sum, unit) => sum + unit.baseBuyIn, 0);
  const totalBaseSellRate = units.reduce((sum, unit) => sum + unit.baseSellRate, 0);

  return {
    propertyId,
    totalBaseBuyIn,
    totalBaseSellRate,
    units,
  };
}
