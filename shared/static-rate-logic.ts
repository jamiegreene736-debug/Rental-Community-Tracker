// Pure, zero-DB helpers for the Claude-generated STATIC seasonal rate engine.
//
// This replaces the live Airbnb SearchAPI P40 random-7-night sampler
// (server/hybrid-pricing.ts) as the source of per-(property, bedroom)
// buy-in cost basis. Instead of scraping a random window per month, Claude
// produces ONE rate per season tier (LOW / HIGH / HOLIDAY) per YEAR, and we
// expand those 6 anchor values across the next 24 calendar months on a
// rolling basis. The expanded per-month values are written into the SAME
// `property_market_rates.monthlyRates` JSONB shape the Guesty push already
// reads (server/routes.ts buildBulkGuestySeasonalPlan), so the markup +
// push + scheduler + queue all keep working unchanged — only the rate
// SOURCE changes.
//
// Kept dependency-free (only imports the shared pricing tables) so it can be
// unit-tested without a DB or network.

import {
  BUY_IN_RATES,
  SEASON_MULTIPLIERS,
  getCommunityRegion,
  getSeasonForMonth,
  type SeasonType,
  type RegionType,
} from "./pricing-rates";

export type SeasonAnchors = {
  LOW: number;
  HIGH: number;
  HOLIDAY: number;
};

// ── ALL-IN (taxes + fees) buy-in cost model ──────────────────────────────────
// Operator directive (2026-06-30): the buy-in rate MUST be the true ALL-IN cost
// to secure ONE comparable unit — nightly rent PLUS the flat cleaning fee, the
// channel service fee, and lodging/occupancy taxes — amortized over a 7-night
// reference stay (the operator's real combo-booking pattern). This is what the
// 15% markup is applied to, so the markup never gets eaten by the fees the old
// rent-only basis silently excluded (the Menehune Shores loss class).
//
// IMPORTANT: this all-in number bakes the per-stay cleaning fee INTO the nightly
// (amortized /7). The Guesty seasonal-rate push is unchanged (it still pushes a
// per-night base rate), so the operator should ZERO the guest-facing cleaning
// fee on these combo listings to avoid charging the guest cleaning twice. The UI
// surfaces this note; we deliberately do NOT change the push math here.

// Default 7-night reference stay used to amortize flat per-stay fees.
export const ALL_IN_REFERENCE_NIGHTS = 7;

// Combined lodging/occupancy tax applied to (rent + cleaning) when a channel
// doesn't itemize taxes (the common case in a SERP snippet). Hawaii TAT 10.25%
// + county TAT ~3% + GET ~4.7% gross-up ≈ ~18%; Florida state 6% + county
// surtax + tourist-development tax ≈ ~12.5%. Server-applied so Claude can't
// hallucinate it — Claude only reports observed rent/cleaning/service.
export const LODGING_TAX_PCT: Record<RegionType, number> = {
  hawaii: 0.18,
  florida: 0.125,
};

// Flat per-stay cleaning fee estimate when a channel doesn't show one. Amortized
// over ALL_IN_REFERENCE_NIGHTS. Conservative central values per region.
export const CLEANING_FEE_ESTIMATE: Record<RegionType, number> = {
  hawaii: 250,
  florida: 175,
};

// Channel service-fee % (of rent + cleaning) when a channel doesn't show one.
// PM/resort-direct carry no guest service fee (the operator's cheapest path);
// OTAs do. Keyed by the normalized channel key.
export const SERVICE_FEE_PCT_DEFAULT: Record<string, number> = {
  pm: 0.0,
  resort: 0.0,
  vrbo: 0.10,
  booking: 0.0, // Booking.com folds its margin into the displayed rate
  airbnb: 0.14,
  other: 0.08,
};

// Service % used to gross up a bare rent into an all-in BACKSTOP (the fail-soft
// fallback and the prior/clamp basis). A modest blended rate so the backstop is
// protective (leans slightly high) rather than assuming the rock-bottom PM path.
export const BACKSTOP_SERVICE_PCT = 0.08;

// Channels in operator-acquisition priority order (cheapest + most trustworthy
// first). Used as the reconciliation tie-break and for normalizing Claude's
// free-text channel labels.
export type ChannelKey = "pm" | "resort" | "vrbo" | "booking" | "airbnb" | "other";
export const CHANNEL_PRIORITY: ChannelKey[] = ["pm", "resort", "vrbo", "booking", "airbnb", "other"];

// Normalize a free-text channel label from Claude into a ChannelKey.
export function normalizeChannelKey(raw: unknown): ChannelKey {
  const s = String(raw ?? "").toLowerCase();
  if (/booking/.test(s)) return "booking";
  if (/vrbo|homeaway|vacasa.*vrbo/.test(s)) return "vrbo";
  if (/airbnb|abnb/.test(s)) return "airbnb";
  if (/\bpm\b|property manager|management|realty|rentals?\b|direct/.test(s)) return "pm";
  if (/resort|hotel|official|own site/.test(s)) return "resort";
  return "other";
}

// One researched channel data point for a (bedroom, season, year), with the
// server-computed all-in nightly. Persisted so the operator can audit the rate.
export type ChannelEvidence = {
  season: SeasonType;
  year: 1 | 2;
  channel: ChannelKey;
  sourceUrl?: string;
  stayNights: number;
  rentNightly: number;
  cleaningPerStay: number | null;
  serviceFeePct: number | null;
  feesObserved: boolean;
  allInNightly: number;
  feeBasis: "all-in-observed" | "grossed-up";
};

// The server's reconciliation of all channels for one (season, year) into the
// single chosen anchor, with the spread + the rule it applied (auditable).
export type SeasonReconciliation = {
  season: SeasonType;
  year: 1 | 2;
  chosen: number;
  channel: ChannelKey | null;
  rule: string;
  spread: { min: number; median: number; max: number; n: number };
  dropped: string[];
};

// All-in nightly = (rent×nights + cleaning + service + tax(rent×nights+cleaning)) / nights.
// Service and tax both apply to the rent+cleaning subtotal (both HI and FL tax
// the cleaning charge as part of the rental). Pure + deterministic.
export function allInNightlyFromComponents(args: {
  rentNightly: number;
  nights: number;
  cleaningPerStay: number;
  serviceFeePct: number;
  region: RegionType;
  taxPct?: number;
}): number {
  const nights = Number.isFinite(args.nights) && args.nights > 0 ? args.nights : ALL_IN_REFERENCE_NIGHTS;
  const rent = Math.max(0, args.rentNightly) * nights;
  const cleaning = Math.max(0, args.cleaningPerStay || 0);
  const subtotal = rent + cleaning;
  const service = subtotal * Math.max(0, args.serviceFeePct || 0);
  const tax = subtotal * (args.taxPct ?? LODGING_TAX_PCT[args.region]);
  const total = rent + cleaning + service + tax;
  return Math.round(total / nights);
}

// Gross up a BARE nightly rent into an all-in nightly using region fee/tax
// estimates (used for the fail-soft fallback, the prior/clamp basis, and any
// channel that only exposed a bare nightly).
export function grossUpRentToAllIn(
  rentNightly: number,
  region: RegionType,
  opts?: { nights?: number; cleaning?: number; serviceFeePct?: number; taxPct?: number },
): number {
  return allInNightlyFromComponents({
    rentNightly,
    nights: opts?.nights ?? ALL_IN_REFERENCE_NIGHTS,
    cleaningPerStay: opts?.cleaning ?? CLEANING_FEE_ESTIMATE[region],
    serviceFeePct: opts?.serviceFeePct ?? BACKSTOP_SERVICE_PCT,
    region,
    taxPct: opts?.taxPct,
  });
}

// Reconcile per-channel all-in nightlies for one (season, year) into ONE anchor.
// Rule: the operator books the CHEAPEST credible channel, so we take the lowest
// credible all-in — but with guards so a single mis-scraped bargain can't price
// the whole combo into a loss:
//   1. Drop teasers (a not-fee-observed row whose RENT is < 0.5× the rent basis —
//      almost certainly a smaller/different unit or a per-person "from $X").
//   2. If the single cheapest is >15% below the 2nd-cheapest, use the 2nd-cheapest
//      (over-pricing slightly is recoverable; under-pricing sells at a loss).
//   3. Tie-break within 5%: prefer the higher-trust channel (PM > VRBO > Booking > Airbnb).
export function reconcileChannelAllIn(
  rows: Array<{ channel: ChannelKey; rentNightly: number; allInNightly: number; feesObserved: boolean }>,
  bareRentBasisSeason: number,
): { chosen: number | null; channel: ChannelKey | null; rule: string; spread: { min: number; median: number; max: number; n: number }; dropped: string[] } {
  const dropped: string[] = [];
  const credible = rows.filter((r) => {
    if (!(r.allInNightly > 0)) { dropped.push(`${r.channel}:invalid`); return false; }
    if (!r.feesObserved && r.rentNightly > 0 && bareRentBasisSeason > 0 && r.rentNightly < 0.5 * bareRentBasisSeason) {
      dropped.push(`${r.channel}:teaser`);
      return false;
    }
    return true;
  });
  const sortedVals = credible.map((r) => r.allInNightly).sort((a, b) => a - b);
  const spread = sortedVals.length
    ? { min: sortedVals[0], median: sortedVals[Math.floor((sortedVals.length - 1) / 2)], max: sortedVals[sortedVals.length - 1], n: sortedVals.length }
    : { min: 0, median: 0, max: 0, n: 0 };
  if (credible.length === 0) return { chosen: null, channel: null, rule: "no-credible-evidence", spread, dropped };
  const asc = [...credible].sort((a, b) => a.allInNightly - b.allInNightly);
  let pick = asc[0];
  let rule = "lowest-credible";
  if (asc.length >= 2 && asc[0].allInNightly < 0.85 * asc[1].allInNightly) {
    pick = asc[1];
    rule = "second-cheapest (cheapest >15% below 2nd)";
  }
  // Tie-break: among rows within 5% ABOVE the pick (NOT cheaper rows — a much
  // cheaper row was already rejected by the >15% guard above and must not
  // re-enter), prefer the higher-trust channel.
  const band = pick.allInNightly * 1.05;
  const contenders = asc.filter((r) => r.allInNightly >= pick.allInNightly && r.allInNightly <= band);
  contenders.sort((a, b) => CHANNEL_PRIORITY.indexOf(a.channel) - CHANNEL_PRIORITY.indexOf(b.channel));
  const finalPick = contenders[0] ?? pick;
  if (finalPick.channel !== pick.channel) rule += " · tie-break by channel priority";
  return { chosen: finalPick.allInNightly, channel: finalPick.channel, rule, spread, dropped };
}

// The ALL-IN seasonal prior/clamp basis for a (community, bedrooms): the
// operator's rent-only basis grossed up per season via the fee/tax model. This
// is what Claude's anchors are clamped against (so a legit all-in number isn't
// flagged as "too high" vs a rent-only reference) and the fail-soft fallback.
export function allInSeasonalBasis(
  community: string,
  bedrooms: number,
  opts?: { nights?: number; cleaning?: number; serviceFeePct?: number; taxPct?: number },
): SeasonAnchors {
  const rent = staticSeasonalBasis(community, bedrooms);
  const region: RegionType = BUY_IN_RATES[community]?.region ?? getCommunityRegion(community);
  return {
    LOW: grossUpRentToAllIn(rent.LOW, region, opts),
    HIGH: grossUpRentToAllIn(rent.HIGH, region, opts),
    HOLIDAY: grossUpRentToAllIn(rent.HOLIDAY, region, opts),
  };
}

// A representative 7-night sampling window per season per year, pinned by the
// server and handed to Claude so the research is deterministic + reproducible.
// HIGH = mid-July, LOW = mid-September (deep off-season; LOW in both region
// maps), HOLIDAY = Dec 26–Jan 2. Year 2 = the same windows + 12 months.
export type SeasonWindow = { season: SeasonType; year: 1 | 2; checkIn: string; checkOut: string };
export function computeSeasonWindows(asOf: Date, _region?: RegionType): SeasonWindow[] {
  const baseYear = asOf.getFullYear();
  const fmt = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const win = (y: number, m: number, d: number): { checkIn: string; checkOut: string } => {
    const ci = new Date(y, m - 1, d);
    const co = new Date(y, m - 1, d + ALL_IN_REFERENCE_NIGHTS);
    return { checkIn: fmt(ci), checkOut: fmt(co) };
  };
  // Pick the first occurrence at least ~45 days out for year 1; year 2 = +1.
  const leadGate = new Date(asOf.getTime() + 45 * 86_400_000);
  const yearFor = (month: number, day: number): number =>
    new Date(baseYear, month - 1, day) >= leadGate ? baseYear : baseYear + 1;
  const hiY = yearFor(7, 13);
  const loY = yearFor(9, 14);
  const hoY = yearFor(12, 26);
  return [
    { season: "HIGH", year: 1, ...win(hiY, 7, 13) },
    { season: "LOW", year: 1, ...win(loY, 9, 14) },
    { season: "HOLIDAY", year: 1, ...win(hoY, 12, 26) },
    { season: "HIGH", year: 2, ...win(hiY + 1, 7, 13) },
    { season: "LOW", year: 2, ...win(loY + 1, 9, 14) },
    { season: "HOLIDAY", year: 2, ...win(hoY + 1, 12, 26) },
  ];
}

export type StaticRateAnchors = {
  // Year 1 = the next 12 months; Year 2 = months 13–24. "Rolling" means the
  // window always starts at the current month, so as time passes year-1 anchors
  // age out and year-2 becomes the new year-1 on the next regeneration.
  year1: SeasonAnchors;
  year2: SeasonAnchors;
};

export type SeasonLockFlags = {
  LOW?: boolean;
  HIGH?: boolean;
  HOLIDAY?: boolean;
};

export type StaticRateLocks = {
  year1?: SeasonLockFlags;
  year2?: SeasonLockFlags;
};

// Per-bedroom static plan persisted alongside the row (column `static_plan`).
export type StaticRateBedroomPlan = {
  bedrooms: number;
  anchors: StaticRateAnchors;
  locks: StaticRateLocks;
  // The operator-validated RENT-ONLY seasonal basis (prior, for reference).
  staticBasis: SeasonAnchors;
  confidence: number; // 0–100, Claude's self-reported confidence
  reasoning: string;
  metricsUsed: string[];
  // ── ALL-IN provenance (optional; absent on legacy rows) ──
  // The all-in (taxes + fees) seasonal basis the anchors were clamped against.
  allInBasis?: SeasonAnchors;
  // Per-channel research data points (rent/cleaning/service + server all-in).
  evidence?: ChannelEvidence[];
  // How each (season, year) anchor was reconciled from the channel evidence.
  reconciliation?: SeasonReconciliation[];
  // Seasons whose anchor hit the clamp band (surfaced so silent truncation shows).
  clampedSeasons?: string[];
  // The amortized per-night cleaning component baked into the all-in nightly
  // (so the operator can see it + zero the Guesty guest-facing cleaning fee).
  cleaningPerNight?: number;
};

// Double-check that the resort/location Claude is asked to research actually
// corresponds to the listing's configured community + its known city/state.
// Surfaced in the Pricing tab and the market-rate queue so the operator can SEE
// that the research target was confirmed (and catch a wrong-resort / wrong-state
// lookup before it prices a listing).
export type CommunityConfirmation = {
  community: string;
  searchLabel: string;
  expectedCity?: string;
  expectedState?: string;
  nameMatch: boolean;
  cityMatch: boolean;
  stateMatch: boolean;
  locationMatch: boolean;
  curated: boolean;
  // Claude's own research-backed verification that the resort is real + located
  // where expected (independent of the string match).
  claudeConfirmed: boolean;
  verifiedResort?: string;
  confirmed: boolean;
  detail: string;
};

export type StaticRatePlan = {
  generatedAt: string;
  model: string;
  source: "claude-static" | "static-fallback";
  summary: string;
  communityConfirmation?: CommunityConfirmation;
  bedrooms: StaticRateBedroomPlan[];
};

// US state full-name ↔ abbreviation aliases so "Hawaii" in the community config
// still matches "HI" in a draft's stored state (and vice-versa). Only the markets
// we operate in need entries; unknown states fall through to a literal match.
const STATE_ALIASES: Record<string, string[]> = {
  hawaii: ["hawaii", "hi"],
  hi: ["hawaii", "hi"],
  florida: ["florida", "fl"],
  fl: ["florida", "fl"],
};

function normalizeText(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function labelMentionsState(label: string, state: string): boolean {
  const norm = normalizeText(state);
  if (!norm) return true;
  const aliases = STATE_ALIASES[norm] ?? [norm];
  // Word-boundary-ish match so "fl" doesn't hit "florida" substrings spuriously.
  return aliases.some((a) => new RegExp(`(^| )${a}( |$)`).test(label));
}

// Confirm the research target. `curated` = the community is a hand-tuned
// BUY_IN_MARKETS key (its searchLabel is authoritative), which lets a draft whose
// own listing name doesn't literally contain the community key still confirm on
// location. `confirmed` is gated on LOCATION (the load-bearing geo guard) plus a
// name OR curated signal.
export function confirmResearchCommunity(args: {
  community: string;
  searchLabel: string;
  expectedCity?: string;
  expectedState?: string;
  curated?: boolean;
  // Claude's own research verdict: it web-verified the resort exists where expected.
  claudeConfirmed?: boolean;
  verifiedResort?: string;
  // Claude's verified city/state — when present, they count toward the location
  // match too (so a draft whose listing name omits the city still confirms when
  // Claude's research independently places it in the right city/state).
  verifiedCity?: string;
  verifiedState?: string;
}): CommunityConfirmation {
  const label = normalizeText(args.searchLabel);
  const community = (args.community || "").trim();
  const claudeConfirmed = !!args.claudeConfirmed;
  const nameMatch = (community.length > 0 && label.includes(normalizeText(community)))
    || (!!args.verifiedResort && normalizeText(args.verifiedResort).includes(normalizeText(community)));
  // City/state match against the research label OR Claude's verified location.
  const cityMatch = args.expectedCity
    ? (label.includes(normalizeText(args.expectedCity))
        || (!!args.verifiedCity && normalizeText(args.verifiedCity).includes(normalizeText(args.expectedCity))))
    : true;
  const stateMatch = args.expectedState
    ? (labelMentionsState(label, args.expectedState)
        || (!!args.verifiedState && labelMentionsState(normalizeText(args.verifiedState), args.expectedState)))
    : true;
  const locationMatch = cityMatch && stateMatch;
  const curated = !!args.curated;
  // Confirmed when the location lines up AND we have an identity signal: a name
  // match, a curated market, OR Claude's own research confirmation.
  const confirmed = locationMatch && (nameMatch || curated || claudeConfirmed);
  const loc = [args.expectedCity, args.expectedState].filter(Boolean).join(", ");
  const how = claudeConfirmed ? " (Claude web-verified the resort)" : "";
  const detail = confirmed
    ? `Confirmed: researching ${community}${loc ? ` in ${loc}` : ""}${how}.`
    : !locationMatch
      ? `⚠ Research location doesn’t match this listing’s ${loc || "expected location"} — verify the resort before pushing.`
      : `⚠ Couldn’t confirm the community name in the research target — verify it matches ${community}.`;
  return { community, searchLabel: args.searchLabel, expectedCity: args.expectedCity, expectedState: args.expectedState, nameMatch, cityMatch, stateMatch, locationMatch, curated, claudeConfirmed, verifiedResort: args.verifiedResort, confirmed, detail };
}

export const STATIC_RATE_SEASONS: SeasonType[] = ["LOW", "HIGH", "HOLIDAY"];

// Year-over-year growth applied to year-2 anchors when Claude (or the static
// fallback) doesn't supply them explicitly. Conservative single-digit.
export const STATIC_RATE_YOY_GROWTH = 1.04;

// Months that should be priced from the HOLIDAY anchor rather than LOW/HIGH.
// At MONTH granularity (the Guesty push prices whole months) December is the
// dominant Christmas / New Year peak in both Hawaii and Florida. Short holiday
// windows inside other months are still covered by the separate lead-time
// scarcity push (unchanged), so this set is intentionally narrow.
export const STATIC_HOLIDAY_MONTHS = new Set<number>([12]);

// Operator-validated seasonal basis for a (community, bedrooms) pair, straight
// from BUY_IN_RATES × SEASON_MULTIPLIERS. This is the trusted prior Claude is
// anchored to and the clamp reference. Falls back to a per-region per-bedroom
// default when the exact community/bedroom isn't in the static table.
export function staticSeasonalBasis(community: string, bedrooms: number): SeasonAnchors {
  const entry = BUY_IN_RATES[community];
  const region: RegionType = entry?.region ?? getCommunityRegion(community);
  const key = `${bedrooms}BR` as "2BR" | "3BR" | "4BR" | "5BR";
  const baseline = typeof entry?.[key] === "number" && (entry[key] as number) > 0
    ? (entry[key] as number)
    : (region === "florida" ? 80 : 270) * Math.max(1, bedrooms);
  const mult = SEASON_MULTIPLIERS[region];
  return {
    LOW: Math.round(baseline * mult.LOW),
    HIGH: Math.round(baseline * mult.HIGH),
    HOLIDAY: Math.round(baseline * mult.HOLIDAY),
  };
}

// Sane default anchors when Claude is unavailable: the ALL-IN seasonal basis
// (rent grossed up with cleaning + service + taxes) for year 1, grown by
// STATIC_RATE_YOY_GROWTH for year 2. Using the ALL-IN basis (not the rent-only
// staticSeasonalBasis) is the load-bearing fail-soft fix: a keyless session or
// any Claude outage now still pushes all-in cost numbers, so the markup is never
// applied to bare rent (the Menehune Shores loss class).
export function defaultStaticAnchors(community: string, bedrooms: number): StaticRateAnchors {
  const basis = allInSeasonalBasis(community, bedrooms);
  const grow = (v: number) => Math.round(v * STATIC_RATE_YOY_GROWTH);
  return {
    year1: { ...basis },
    year2: { LOW: grow(basis.LOW), HIGH: grow(basis.HIGH), HOLIDAY: grow(basis.HOLIDAY) },
  };
}

// Clamp band around the (all-in) seasonal basis. Floor raised 0.4×→0.55× so an
// implausibly-low scrape can't pull the anchor far below the all-in cost floor
// (under-pricing sells at a loss); ceiling stays 3× so a legit holiday all-in
// has room but a bad parse is blocked.
export const CLAMP_FLOOR_RATIO = 0.55;
export const CLAMP_CEIL_RATIO = 3;
function clampToBasis(value: number, basisSeason: number): number {
  if (!Number.isFinite(value) || value <= 0) return basisSeason;
  const lo = Math.round(basisSeason * CLAMP_FLOOR_RATIO);
  const hi = Math.round(basisSeason * CLAMP_CEIL_RATIO);
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

// Report which seasons of a year's anchors fall OUTSIDE the clamp band against
// the given basis (i.e. would be truncated by clampToBasis). Used by the engine
// to surface silent clamping to the operator. Pure; does not mutate.
export function clampedSeasonsAgainst(
  anchors: Partial<SeasonAnchors>,
  basis: SeasonAnchors,
  yearLabel?: string,
): string[] {
  const out: string[] = [];
  (Object.keys(basis) as SeasonType[]).forEach((season) => {
    const v = anchors[season];
    if (v == null || !Number.isFinite(v) || v <= 0) return;
    const lo = basis[season] * CLAMP_FLOOR_RATIO;
    const hi = basis[season] * CLAMP_CEIL_RATIO;
    if (v < lo || v > hi) out.push(yearLabel ? `${yearLabel} ${season}` : season);
  });
  return out;
}

// Enforce LOW ≤ HIGH ≤ HOLIDAY within a year and clamp each season to its
// basis band. Returns a corrected copy; never throws.
export function sanitizeSeasonAnchors(anchors: Partial<SeasonAnchors>, basis: SeasonAnchors): SeasonAnchors {
  const low = clampToBasis(anchors.LOW ?? basis.LOW, basis.LOW);
  let high = clampToBasis(anchors.HIGH ?? basis.HIGH, basis.HIGH);
  let holiday = clampToBasis(anchors.HOLIDAY ?? basis.HOLIDAY, basis.HOLIDAY);
  high = Math.max(high, low);
  holiday = Math.max(holiday, high);
  return { LOW: low, HIGH: high, HOLIDAY: holiday };
}

// Full anchor sanitation across both years, plus a year-2 band check so a
// runaway year-2 can't drift more than +20% / −5% off year-1 per season.
export function sanitizeAnchors(anchors: Partial<StaticRateAnchors>, basis: SeasonAnchors): StaticRateAnchors {
  const year1 = sanitizeSeasonAnchors(anchors.year1 ?? {}, basis);
  const rawYear2 = sanitizeSeasonAnchors(anchors.year2 ?? {}, basis);
  const banded = (y2: number, y1: number) =>
    Math.min(Math.round(y1 * 1.2), Math.max(Math.round(y1 * 0.95), y2));
  const year2 = {
    LOW: banded(rawYear2.LOW, year1.LOW),
    HIGH: banded(rawYear2.HIGH, year1.HIGH),
    HOLIDAY: banded(rawYear2.HOLIDAY, year1.HOLIDAY),
  };
  // Re-assert ordering after banding.
  year2.HIGH = Math.max(year2.HIGH, year2.LOW);
  year2.HOLIDAY = Math.max(year2.HOLIDAY, year2.HIGH);
  return { year1, year2 };
}

// Merge freshly generated anchors with the operator's locked overrides: any
// season/year flagged locked keeps the PRIOR value instead of the new one.
export function mergeLockedAnchors(
  generated: StaticRateAnchors,
  locks: StaticRateLocks | undefined,
  prior: StaticRateAnchors | undefined,
): StaticRateAnchors {
  if (!locks || !prior) return generated;
  const apply = (
    yearKey: "year1" | "year2",
    season: SeasonType,
  ): number => {
    if (locks[yearKey]?.[season] && prior[yearKey] && typeof prior[yearKey][season] === "number") {
      return prior[yearKey][season];
    }
    return generated[yearKey][season];
  };
  return {
    year1: { LOW: apply("year1", "LOW"), HIGH: apply("year1", "HIGH"), HOLIDAY: apply("year1", "HOLIDAY") },
    year2: { LOW: apply("year2", "LOW"), HIGH: apply("year2", "HIGH"), HOLIDAY: apply("year2", "HOLIDAY") },
  };
}

// Month-granularity season classifier for the static engine. December is
// priced from the HOLIDAY anchor; every other month uses the existing
// LOW/HIGH map (getSeasonForMonth never returns HOLIDAY).
export function staticSeasonForMonth(yearMonth: string, region: RegionType): SeasonType {
  const month = Number(yearMonth.slice(5, 7));
  if (STATIC_HOLIDAY_MONTHS.has(month)) return "HOLIDAY";
  return getSeasonForMonth(yearMonth, region);
}

export type ExpandedMonthlyRate = {
  medianNightly: number;
  season: SeasonType;
  source: "claude-static";
  yearIndex: 1 | 2;
};

// Build the rolling 24-month window of yearMonth keys starting at `asOf`.
export function staticRateWindowMonths(asOf: Date, horizonMonths = 24): string[] {
  const months: string[] = [];
  for (let i = 0; i < horizonMonths; i += 1) {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() + i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

// Expand the 6 seasonal anchors into a per-month record matching the
// property_market_rates.monthlyRates shape consumed by buildBulkGuestySeasonalPlan.
// Months 0–11 use year1 anchors, 12–23 use year2.
export function expandAnchorsToMonthlyRates(
  anchors: StaticRateAnchors,
  community: string,
  asOf: Date,
  horizonMonths = 24,
): Record<string, ExpandedMonthlyRate> {
  const region: RegionType = BUY_IN_RATES[community]?.region ?? getCommunityRegion(community);
  const months = staticRateWindowMonths(asOf, horizonMonths);
  const out: Record<string, ExpandedMonthlyRate> = {};
  months.forEach((yearMonth, offset) => {
    const yearIndex: 1 | 2 = offset < 12 ? 1 : 2;
    const seasonAnchors = yearIndex === 1 ? anchors.year1 : anchors.year2;
    const season = staticSeasonForMonth(yearMonth, region);
    out[yearMonth] = {
      medianNightly: Math.round(seasonAnchors[season]),
      season,
      source: "claude-static",
      yearIndex,
    };
  });
  return out;
}

// Representative season basis columns (low/high/holiday) for the row, taken
// from the year-1 anchors so the Pricing-tab badges + getBuyInRate season
// fallback stay consistent with the calendar's first year.
export function seasonColumnsFromAnchors(anchors: StaticRateAnchors): { low: number; high: number; holiday: number } {
  return { low: anchors.year1.LOW, high: anchors.year1.HIGH, holiday: anchors.year1.HOLIDAY };
}
