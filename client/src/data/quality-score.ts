// ─────────────────────────────────────────────────────────────
// NEXSTAY QUALITY SCORE ALGORITHM
// Measures how attractive an arbitrage opportunity is.
// Score: 0–10 (one decimal place)
//
// Factors (max points):
//   1. Market Value Gap    — 0–4 pts  (how much cheaper vs standalone comparable)
//   2. Profit Margin       — 0–2 pts  (our markup / business margin)
//   3. Location Demand     — 0–2 pts  (destination desirability & occupancy)
//   4. Group Size Scarcity — 0–1 pt   (larger groups = fewer competing options)
//   5. Unit Pairing Match  — 0–1 pt   (same BR count = cleaner combined listing)
// ─────────────────────────────────────────────────────────────

export type QualityGrade = "A" | "B" | "C" | "D";

export type QualityScoreBreakdown = {
  total: number;            // 0–10, one decimal
  grade: QualityGrade;      // A ≥ 8 · B ≥ 6.5 · C ≥ 5 · D < 5
  marketDiscount: number;   // 0–4: vs equivalent standalone market rate
  profitMargin: number;     // 0–2: our markup profit
  locationDemand: number;   // 0–2: destination tier
  groupScarcity: number;    // 0–1: large-group competition scarcity
  unitMatch: number;        // 0–1: how cleanly units combine
  discountPct: number;      // % savings vs comparable standalone property
  marketRate: number;       // estimated market rate for comparable standalone
};

// ─────────────────────────────────────────────────────────────
// MARKET REFERENCE RATES
// Estimated nightly rate per bedroom for a STANDALONE large
// private home/villa of equivalent size in each community.
// Guests compare our combined listing against these.
// ─────────────────────────────────────────────────────────────
const MARKET_RATE_PER_BR: Record<string, number> = {
  "Poipu Brenneckes":  650,  // Premium oceanfront homes — very rare, high demand
  "Kekaha Beachfront": 590,  // Exclusive beachfront estate equivalents
  "Kapaa Beachfront":  510,  // East Shore beachfront private homes
  "Poipu Oceanfront":  490,  // Ocean-view complex; standalone would cost more
  "Poipu Kai":         460,  // Steps-to-beach resort; 6BR standalone ~$2,760
  "Pili Mai":          445,  // Luxury resort townhome community
  "Princeville":       445,  // North Shore luxury; ocean-view villas
  "Keauhou":           390,  // Big Island ocean-view estates
  "Southern Dunes":    290,  // Florida vacation home comps
  "Windsor Hills":     300,  // Florida Orlando area
  "Caribe Cove":       260,  // Older Kissimmee resort; standalone 4BR comps run ~$1,000/night
};

const DEFAULT_MARKET_RATE_PER_BR = 430; // Generic fallback

// ─────────────────────────────────────────────────────────────
// LOCATION DEMAND TIERS (0–2 pts)
// Based on occupancy demand, tourism volume, and scarcity of
// equivalent large-group options in the destination.
// ─────────────────────────────────────────────────────────────
const LOCATION_DEMAND: Record<string, number> = {
  "Poipu Brenneckes":  2.00,
  "Kekaha Beachfront": 1.95,
  "Poipu Oceanfront":  1.95,
  "Kapaa Beachfront":  1.90,
  "Poipu Kai":         1.85,
  "Pili Mai":          1.80,
  "Princeville":       1.75,
  "Keauhou":           1.50,
  "Southern Dunes":    1.00,
  "Windsor Hills":     0.90,
  "Caribe Cove":       0.85,  // Disney-proximate but older build than Windsor Hills
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function groupScarcityScore(bedrooms: number): number {
  if (bedrooms >= 10) return 1.00;
  if (bedrooms >= 8)  return 0.90;
  if (bedrooms >= 6)  return 0.80;
  if (bedrooms >= 5)  return 0.65;
  if (bedrooms >= 4)  return 0.45;
  return 0.25;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Extracts a list of individual unit bedroom counts from unitDetails text.
 * e.g. "2 adjacent 3BR units" → [3, 3]
 *      "3BR + 2BR" → [3, 2]
 *      "5BR main home + 2BR guest quarters" → [5, 2]
 */
export function extractBRList(text: string): number[] {
  const lower = text.toLowerCase();

  // Pattern: "N adjacent/side-by-side/x N2BR" → N copies of N2
  // e.g. "2 adjacent 3BR" or "2 side-by-side 3BR" or "Two 3BR"
  const multiRe =
    /(two|three|four|five|six|\d)\s+(?:adjacent|side-by-side|x\s+)?(\d+)[\s-]?br\b/g;
  const wordToNum: Record<string, number> = {
    two: 2, three: 3, four: 4, five: 5, six: 6,
  };
  const result: number[] = [];
  let m;

  while ((m = multiRe.exec(lower)) !== null) {
    const countStr = m[1].toLowerCase();
    const count = wordToNum[countStr] ?? parseInt(countStr);
    const br = parseInt(m[2]);
    if (br > 0 && br < 10 && count > 0 && count <= 6) {
      for (let i = 0; i < count; i++) result.push(br);
    }
  }

  if (result.length > 0) return result;

  // Fallback: simple "XBR" tokens (e.g. "3BR + 2BR + 2BR")
  const simpleRe = /(\d+)[\s-]?br\b/g;
  while ((m = simpleRe.exec(lower)) !== null) {
    const n = parseInt(m[1]);
    if (n > 0 && n < 10) result.push(n);
  }

  return result;
}

function unitMatchScore(unitDetails: string, multiUnit: boolean): number {
  if (!multiUnit) return 0.20; // Single-unit: no combination value

  const text = unitDetails.toLowerCase();

  // Estate-style combos (main house + guest quarters) — moderate match
  if (text.includes("main house") || text.includes("guest quarter")) {
    const brs = extractBRList(text);
    if (brs.length >= 2) {
      const spread = Math.max(...brs) - Math.min(...brs);
      return spread <= 1 ? 0.75 : spread <= 3 ? 0.65 : 0.55;
    }
    return 0.65;
  }

  const brs = extractBRList(text);

  if (brs.length === 0) return 0.60; // Can't determine
  if (brs.length === 1) return 0.35; // Looks like a single unit
  const spread = Math.max(...brs) - Math.min(...brs);
  if (spread === 0) return 1.00; // Perfect match (all same BR)
  if (spread === 1) return 0.75; // Close match (3BR + 2BR)
  if (spread === 2) return 0.55; // Moderate (4BR + 2BR)
  return 0.40; // Large spread
}

// ─────────────────────────────────────────────────────────────
// MAIN SCORE FUNCTION — for existing dashboard properties
// ─────────────────────────────────────────────────────────────
export function computeQualityScore(property: {
  community: string;
  island: string;
  bedrooms: number;
  lowPrice: number | null;
  highPrice: number | null;
  multiUnit: boolean;
  unitDetails: string;
}): QualityScoreBreakdown {
  const { community, bedrooms, lowPrice, multiUnit, unitDetails } = property;

  // ── 1. Market Value Gap (0–4 pts) ──────────────────────────
  const ratePerBR = MARKET_RATE_PER_BR[community] ?? DEFAULT_MARKET_RATE_PER_BR;
  const marketRate = ratePerBR * bedrooms;
  // Use lowPrice (our low-season sell rate) — strongest value prop to guests
  const ourRate = lowPrice ?? marketRate * 0.65; // fallback: assume ~35% discount if no data
  const discountFrac = clamp((marketRate - ourRate) / marketRate, 0, 1);
  // Full 4 pts at ≥ 45% discount
  const marketDiscountScore = clamp((discountFrac / 0.45) * 4, 0, 4);

  // ── 2. Profit Margin (0–2 pts) ─────────────────────────────
  // Fixed markup: 1.15 × 1.20 = 1.38 → margin ≈ 27.5%
  // Full 2 pts at ≥ 30% margin
  const margin = 1 - 1 / 1.38; // ≈ 0.275
  const profitMarginScore = clamp((margin / 0.30) * 2, 0, 2);

  // ── 3. Location Demand (0–2 pts) ───────────────────────────
  const locationScore = LOCATION_DEMAND[community] ?? 1.20;

  // ── 4. Group Size Scarcity (0–1 pt) ────────────────────────
  const groupScore = groupScarcityScore(bedrooms);

  // ── 5. Unit Pairing Match (0–1 pt) ─────────────────────────
  const matchScore = unitMatchScore(unitDetails, multiUnit);

  const rawTotal = marketDiscountScore + profitMarginScore + locationScore + groupScore + matchScore;
  const total = Math.round(clamp(rawTotal, 0, 10) * 10) / 10;

  const grade: QualityGrade =
    total >= 8   ? "A" :
    total >= 6.5 ? "B" :
    total >= 5   ? "C" : "D";

  return {
    total,
    grade,
    marketDiscount: Math.round(marketDiscountScore * 100) / 100,
    profitMargin:   Math.round(profitMarginScore   * 100) / 100,
    locationDemand: Math.round(locationScore       * 100) / 100,
    groupScarcity:  Math.round(groupScore          * 100) / 100,
    unitMatch:      Math.round(matchScore          * 100) / 100,
    discountPct:    Math.round(discountFrac * 1000) / 10,
    marketRate,
  };
}

// ─────────────────────────────────────────────────────────────
// ESTIMATE FUNCTION — for community finder (new discoveries)
// Uses available research data to project quality potential.
// ─────────────────────────────────────────────────────────────
export function estimateNewCommunityScore(params: {
  state: string;
  city: string;
  estimatedLowRate: number | null;
  estimatedHighRate: number | null;
  unitTypes: string;       // e.g. "2BR, 3BR" or "3BR, 3BR"
  confidenceScore: number; // 0–100 from AI
}): QualityScoreBreakdown {
  const { state, city, estimatedLowRate, unitTypes, confidenceScore } = params;

  // ── Infer location demand from state / city ─────────────────
  let locationScore = 1.10;
  const c = city.toLowerCase();
  const s = state.toUpperCase();

  if (s === "HAWAII" || s === "HI") {
    if (c.includes("poipu") || c.includes("koloa"))          locationScore = 1.90;
    else if (c.includes("kekaha"))                           locationScore = 1.90;
    else if (c.includes("kapaa") || c.includes("kapa'a"))    locationScore = 1.85;
    else if (c.includes("princeville"))                      locationScore = 1.75;
    else if (c.includes("keauhou") || c.includes("kailua"))  locationScore = 1.50;
    else                                                      locationScore = 1.60;
  } else if (s === "FLORIDA" || s === "FL") {
    if (c.includes("miami") || c.includes("key west"))       locationScore = 1.30;
    else if (c.includes("naples") || c.includes("sarasota")) locationScore = 1.20;
    else                                                      locationScore = 1.00;
  } else if (s === "CALIFORNIA" || s === "CA") {
    locationScore = 1.30;
  } else if (["COLORADO", "CO", "UTAH", "UT"].includes(s)) {
    locationScore = 1.20;
  }

  // ── Parse bedroom counts from unitTypes ─────────────────────
  const brMatches = (unitTypes.match(/\d+/g) || []).map(Number).filter(n => n > 0 && n < 10);
  const totalBRs = brMatches.reduce((sum, n) => sum + n, 0) || 5;

  // ── Market rate estimate ─────────────────────────────────────
  const ratePerBR = locationScore >= 1.8 ? 470 : locationScore >= 1.4 ? 380 : 280;
  const marketRate = ratePerBR * totalBRs;

  // estimatedLowRate from research is for individual units on Airbnb/VRBO.
  // Combined buy-in ≈ estimatedLowRate × 2 (two units)
  // Our sell rate = combinedBuyIn × 1.38
  let ourRate: number;
  if (estimatedLowRate) {
    const estimatedCombinedBuyIn = estimatedLowRate * 2;
    ourRate = estimatedCombinedBuyIn * 1.38;
  } else {
    ourRate = marketRate * 0.65; // assume ~35% discount
  }

  const discountFrac = clamp((marketRate - ourRate) / marketRate, 0, 1);
  const marketDiscountScore = clamp((discountFrac / 0.45) * 4, 0, 4);
  const profitMarginScore = clamp(((1 - 1 / 1.38) / 0.30) * 2, 0, 2);
  const groupScore = groupScarcityScore(totalBRs);

  const maxBR = brMatches.length > 0 ? Math.max(...brMatches) : 3;
  const minBR = brMatches.length > 0 ? Math.min(...brMatches) : 3;
  const brSpread = maxBR - minBR;
  const matchScore =
    brMatches.length < 2 ? 0.60 :
    brSpread === 0       ? 1.00 :
    brSpread === 1       ? 0.75 : 0.55;

  // Confidence modifier: lower AI confidence slightly reduces the estimate
  const confidenceMult = 0.70 + (confidenceScore / 100) * 0.30;

  const rawTotal = (marketDiscountScore + profitMarginScore + locationScore + groupScore + matchScore) * confidenceMult;
  const total = Math.round(clamp(rawTotal, 0, 10) * 10) / 10;

  const grade: QualityGrade =
    total >= 8   ? "A" :
    total >= 6.5 ? "B" :
    total >= 5   ? "C" : "D";

  return {
    total,
    grade,
    marketDiscount: Math.round(marketDiscountScore * 100) / 100,
    profitMargin:   Math.round(profitMarginScore   * 100) / 100,
    locationDemand: Math.round(locationScore       * 100) / 100,
    groupScarcity:  Math.round(groupScore          * 100) / 100,
    unitMatch:      Math.round(matchScore          * 100) / 100,
    discountPct:    Math.round(discountFrac * 1000) / 10,
    marketRate,
  };
}

// ─────────────────────────────────────────────────────────────
// DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────
export function gradeColor(grade: QualityGrade): string {
  switch (grade) {
    case "A": return "text-emerald-600 dark:text-emerald-400";
    case "B": return "text-blue-600 dark:text-blue-400";
    case "C": return "text-amber-600 dark:text-amber-400";
    case "D": return "text-muted-foreground";
  }
}

export function gradeBg(grade: QualityGrade): string {
  switch (grade) {
    case "A": return "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800";
    case "B": return "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800";
    case "C": return "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800";
    case "D": return "bg-muted border-border";
  }
}
