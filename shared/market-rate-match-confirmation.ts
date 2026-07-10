// Market-rate MATCH CONFIRMATION — the deterministic "are these rates really
// for the RIGHT community and the RIGHT bedroom count?" verdict (operator ask,
// 2026-07-10). Runs over the evidence the live SearchAPI Airbnb median engine
// (server/hybrid-pricing.ts) already persists per scanned month in
// `property_market_rates.monthlyRates[ym].{confidence,evidence}`, so the SAME
// pure function powers BOTH surfaces:
//   - server: dashboard bulk market-pricing queue items + queue events
//     (server/routes.ts runBulkPricingItem)
//   - client: the Pricing-tab "Research confirmation" block
//     (GuestyListingBuilder researchProvenance, via the getLiveBuyIn cache)
//
// The verdict is intentionally STRICT — it only reports "verified" (green ✓)
// when the evidence clears the operator's 95%+ bar:
//   COMMUNITY — every live-scanned month's comp search was hard-boxed to the
//   community's geo footprint (curated resort bounds, or a tight auto-curated
//   center-radius box), zero widened/nearby-area months, and the search label
//   itself passes the name+location check (confirmResearchCommunity — the same
//   guard the static engine chip uses). Comps detectably outside the box are
//   rejected by the engine before they can price anything, so "all months
//   boxed" is a hard constraint, not a heuristic.
//   BEDROOMS — the Airbnb query was pinned to the exact bedroom count for
//   every live month AND at least MATCH_VERIFIED_MIN_PCT (95%) of accepted
//   comps were INDEPENDENTLY parsed at exactly that size (the engine rejects
//   any comp that parses to a different size, so the residual risk is only
//   comps whose payload omitted bedrooms — they ride the query filter).
//
// Anything short of that is an amber "review" with the precise reasons, and a
// positive contradiction (wrong-location search label, an accepted comp parsed
// at the WRONG size, an expected bedroom size that was never researched) is a
// red "mismatch". Absence of evidence NEVER reads as verified.
//
// Kept dependency-light (only the shared static-rate-logic label check) so it
// is unit-testable and safe to bundle client-side.

import { confirmResearchCommunity, type CommunityConfirmation } from "./static-rate-logic";

export type MarketRateMatchVerdict = "verified" | "partial" | "unverified" | "mismatch";
export type MarketRateMatchLevel = "green" | "yellow" | "red";

// The operator's bar: green requires >=95% of accepted comps independently
// verified at the exact bedroom size (and 100% of live months geo-boxed).
export const MATCH_VERIFIED_MIN_PCT = 95;
// Small-sample guard: fewer than this many comps for a bedroom size can never
// read "verified" (2/2 exact is 100% but proves little).
export const MATCH_MIN_COMPS_PER_BEDROOM = 3;
// An auto-curated center-radius box still counts as community-scoped when it is
// this tight (the default auto-curation half-box is ~2mi corner radius); wider
// boxes are area-level evidence only.
export const MATCH_AREA_BOX_MAX_RADIUS_MILES = 3.5;

export type MarketRateMatchBedroomCheck = {
  bedrooms: number;
  liveMonths: number;          // months with a real SearchAPI evidence record
  extrapolatedMonths: number;  // year-2 months that inherit a year-1 basis
  fallbackMonths: number;      // priced from the static table (no comps)
  blackoutMonths: number;
  comps: number;               // accepted comps across live months
  exactBedroomComps: number;   // independently parsed at exactly `bedrooms`
  unknownBedroomComps: number; // payload omitted bedrooms (query filter only)
  mismatchedBedroomComps: number; // accepted but parsed at ANOTHER size (engine anomaly)
  bedroomQueryPinned: boolean; // every live month's search was bedrooms=<exact>
  bedroomVerifiedPct: number | null;   // 100 * exact / comps
  communityEvidencedComps: number;     // comps with positive in-community evidence
  communityVerifiedPct: number | null; // 100 * evidenced / comps (lower bound)
  resortBoxedMonths: number;   // curated resort-bounds box, not widened
  areaBoxedMonths: number;     // center-radius box, not widened
  widenedMonths: number;       // widened nearby-area fallback box
  unboxedMonths: number;       // kind "none" — no geographic constraint
  maxRadiusMiles: number | null;
  queries: string[];
  bedroomVerdict: MarketRateMatchVerdict;
  communityVerdict: MarketRateMatchVerdict;
};

export type MarketRateMatchConfirmation = {
  community: string;
  searchLabel: string | null;
  communityConfirmation: CommunityConfirmation | null;
  perBedroom: MarketRateMatchBedroomCheck[];
  comps: number;
  exactBedroomComps: number;
  communityEvidencedComps: number;
  bedroomVerifiedPct: number | null;
  communityVerifiedPct: number | null;
  liveMonths: number;
  widenedMonths: number;
  unboxedMonths: number;
  expectedBedrooms: number[] | null;
  missingExpectedBedrooms: number[];
  bedroomSplitInferred: boolean;
  resortConfident: boolean;
  communityVerdict: MarketRateMatchVerdict;
  bedroomVerdict: MarketRateMatchVerdict;
  verdict: "verified" | "review" | "mismatch";
  level: MarketRateMatchLevel;
  headline: string;
  reasons: string[];
};

const VERDICT_RANK: Record<MarketRateMatchVerdict, number> = {
  mismatch: 0,
  unverified: 1,
  partial: 2,
  verified: 3,
};

function worstVerdict(verdicts: MarketRateMatchVerdict[]): MarketRateMatchVerdict {
  if (verdicts.length === 0) return "unverified";
  return verdicts.reduce((worst, v) => (VERDICT_RANK[v] < VERDICT_RANK[worst] ? v : worst));
}

function capVerdict(verdict: MarketRateMatchVerdict, cap: MarketRateMatchVerdict): MarketRateMatchVerdict {
  return VERDICT_RANK[verdict] < VERDICT_RANK[cap] ? verdict : cap;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toCount(value: unknown): number {
  const n = toFiniteNumber(value);
  return n != null && n > 0 ? Math.round(n) : 0;
}

function pct(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((100 * part) / whole);
}

export type MarketRateMatchRowInput = {
  bedrooms?: unknown;
  monthlyRates?: unknown;
};

export function computeMarketRateMatchConfirmation(args: {
  community: string;
  searchLabel?: string | null;
  expectedCity?: string | null;
  expectedState?: string | null;
  curated?: boolean;
  // Precomputed label check (e.g. from the pricing recipe) wins over an inline
  // recompute so both surfaces show the exact same confirmation.
  communityConfirmation?: CommunityConfirmation | null;
  resortConfident?: boolean;
  bedroomSplitInferred?: boolean;
  // The listing's TRUE distinct unit sizes. When provided, a researched-size
  // set that fails to cover them is a hard mismatch (the "priced a 6BR from a
  // 3BR comp" class the operator fears).
  expectedBedrooms?: number[] | null;
  rows: MarketRateMatchRowInput[];
}): MarketRateMatchConfirmation | null {
  const perBedroom: MarketRateMatchBedroomCheck[] = [];
  for (const row of args.rows ?? []) {
    const bedrooms = toFiniteNumber(row?.bedrooms);
    const monthlyRates = row?.monthlyRates;
    if (bedrooms == null || bedrooms <= 0) continue;
    if (!monthlyRates || typeof monthlyRates !== "object" || Array.isArray(monthlyRates)) continue;

    let liveMonths = 0;
    let extrapolatedMonths = 0;
    let fallbackMonths = 0;
    let blackoutMonths = 0;
    let pinnedMonths = 0;
    let comps = 0;
    let exact = 0;
    let unknown = 0;
    let communityEvidenced = 0;
    let resortBoxedMonths = 0;
    let areaBoxedMonths = 0;
    let widenedMonths = 0;
    let unboxedMonths = 0;
    let maxRadiusMiles: number | null = null;
    const queries = new Set<string>();

    for (const payload of Object.values(monthlyRates as Record<string, any>)) {
      if (!payload || typeof payload !== "object") continue;
      if (payload.blackout === true) {
        blackoutMonths += 1;
        continue;
      }
      const confidence = payload.confidence && typeof payload.confidence === "object" ? payload.confidence : null;
      const evidence = payload.evidence && typeof payload.evidence === "object" ? payload.evidence : null;
      if (!evidence) {
        // No per-month search record: a year-2 extrapolation carries the
        // year-1 confidence forward (its comps are already counted on the
        // year-1 month), a static-fallback month has neither.
        if (confidence) extrapolatedMonths += 1;
        else fallbackMonths += 1;
        continue;
      }
      liveMonths += 1;
      const accepted = toCount(confidence?.acceptedCandidates ?? evidence.acceptedCandidates);
      const exactBR = toCount(confidence?.exactBedroomCandidates ?? evidence.acceptedExactBedroomCandidates);
      const unknownBR = toCount(confidence?.unknownBedroomCandidates ?? evidence.acceptedUnknownBedroomCandidates);
      const geoVerified = toCount(confidence?.geoVerifiedCandidates ?? evidence.acceptedGeoVerifiedCandidates);
      const textMatched = toCount(confidence?.communityMatchedCandidates ?? evidence.acceptedCommunityMatchedCandidates);
      comps += accepted;
      exact += Math.min(exactBR, accepted);
      unknown += Math.min(unknownBR, accepted);
      // geoVerified and textMatched can overlap on the same comp; max() is the
      // safe lower bound of the union ("at least this many comps carry
      // positive in-community evidence").
      communityEvidenced += Math.min(accepted, Math.max(geoVerified, textMatched));
      const requestedBedrooms = toFiniteNumber(evidence.requestedBedrooms);
      if (requestedBedrooms != null && requestedBedrooms === bedrooms) pinnedMonths += 1;
      const geo = evidence.geoConstraint && typeof evidence.geoConstraint === "object" ? evidence.geoConstraint : null;
      const widened = geo?.widened === true;
      const kind = typeof geo?.kind === "string" ? geo.kind : "none";
      if (widened) widenedMonths += 1;
      else if (kind === "curated-bounds") resortBoxedMonths += 1;
      else if (kind === "center-radius") areaBoxedMonths += 1;
      else unboxedMonths += 1;
      const radius = toFiniteNumber(geo?.radiusMiles);
      if (radius != null) maxRadiusMiles = maxRadiusMiles == null ? radius : Math.max(maxRadiusMiles, radius);
      if (typeof evidence.query === "string" && evidence.query.trim()) queries.add(evidence.query.trim());
    }

    const mismatched = Math.max(0, comps - exact - unknown);
    const bedroomQueryPinned = liveMonths > 0 && pinnedMonths === liveMonths;
    const bedroomVerifiedPct = pct(exact, comps);
    const communityVerifiedPct = pct(communityEvidenced, comps);

    let bedroomVerdict: MarketRateMatchVerdict;
    if (mismatched > 0) bedroomVerdict = "mismatch";
    else if (comps === 0) bedroomVerdict = "unverified";
    else if (bedroomQueryPinned && (bedroomVerifiedPct ?? 0) >= MATCH_VERIFIED_MIN_PCT && comps >= MATCH_MIN_COMPS_PER_BEDROOM) {
      bedroomVerdict = "verified";
    } else if ((bedroomVerifiedPct ?? 0) >= 50) bedroomVerdict = "partial";
    else bedroomVerdict = "unverified";

    let communityVerdict: MarketRateMatchVerdict;
    if (liveMonths === 0) communityVerdict = "unverified";
    else if (widenedMonths > 0 || unboxedMonths > 0) communityVerdict = "partial";
    else if (areaBoxedMonths > 0 && (maxRadiusMiles == null || maxRadiusMiles > MATCH_AREA_BOX_MAX_RADIUS_MILES)) {
      communityVerdict = "partial";
    } else communityVerdict = "verified";

    perBedroom.push({
      bedrooms,
      liveMonths,
      extrapolatedMonths,
      fallbackMonths,
      blackoutMonths,
      comps,
      exactBedroomComps: exact,
      unknownBedroomComps: unknown,
      mismatchedBedroomComps: mismatched,
      bedroomQueryPinned,
      bedroomVerifiedPct,
      communityEvidencedComps: communityEvidenced,
      communityVerifiedPct,
      resortBoxedMonths,
      areaBoxedMonths,
      widenedMonths,
      unboxedMonths,
      maxRadiusMiles,
      queries: Array.from(queries),
      bedroomVerdict,
      communityVerdict,
    });
  }

  if (perBedroom.length === 0) return null;
  perBedroom.sort((a, b) => a.bedrooms - b.bedrooms);

  const community = (args.community || "").trim();
  const searchLabel = args.searchLabel?.trim() || null;
  const communityConfirmation = args.communityConfirmation
    ?? (searchLabel
      ? confirmResearchCommunity({
        community,
        searchLabel,
        expectedCity: args.expectedCity ?? undefined,
        expectedState: args.expectedState ?? undefined,
        curated: args.curated,
      })
      : null);

  const comps = perBedroom.reduce((s, b) => s + b.comps, 0);
  const exactBedroomComps = perBedroom.reduce((s, b) => s + b.exactBedroomComps, 0);
  const communityEvidencedComps = perBedroom.reduce((s, b) => s + b.communityEvidencedComps, 0);
  const liveMonths = perBedroom.reduce((s, b) => s + b.liveMonths, 0);
  const widenedMonths = perBedroom.reduce((s, b) => s + b.widenedMonths, 0);
  const unboxedMonths = perBedroom.reduce((s, b) => s + b.unboxedMonths, 0);
  const fallbackMonths = perBedroom.reduce((s, b) => s + b.fallbackMonths, 0);
  const extrapolatedMonths = perBedroom.reduce((s, b) => s + b.extrapolatedMonths, 0);
  const mismatchedComps = perBedroom.reduce((s, b) => s + b.mismatchedBedroomComps, 0);

  const expectedBedrooms = Array.isArray(args.expectedBedrooms) && args.expectedBedrooms.length > 0
    ? Array.from(new Set(args.expectedBedrooms.filter((b) => Number.isFinite(b) && b > 0))).sort((a, b) => a - b)
    : null;
  const researchedSizes = new Set(perBedroom.map((b) => b.bedrooms));
  const missingExpectedBedrooms = expectedBedrooms?.filter((b) => !researchedSizes.has(b)) ?? [];

  const bedroomSplitInferred = args.bedroomSplitInferred === true;
  const resortConfident = args.resortConfident !== false;

  let bedroomVerdict = worstVerdict(perBedroom.map((b) => b.bedroomVerdict));
  if (missingExpectedBedrooms.length > 0) bedroomVerdict = "mismatch";
  else if (bedroomSplitInferred) bedroomVerdict = capVerdict(bedroomVerdict, "partial");

  let communityVerdict = worstVerdict(perBedroom.map((b) => b.communityVerdict));
  if (communityConfirmation && !communityConfirmation.locationMatch) communityVerdict = "mismatch";
  else if (communityConfirmation && !communityConfirmation.confirmed) communityVerdict = capVerdict(communityVerdict, "partial");
  if (!resortConfident) communityVerdict = capVerdict(communityVerdict, "partial");

  const verdict: MarketRateMatchConfirmation["verdict"] =
    bedroomVerdict === "mismatch" || communityVerdict === "mismatch"
      ? "mismatch"
      : bedroomVerdict === "verified" && communityVerdict === "verified"
        ? "verified"
        : "review";
  const level: MarketRateMatchLevel = verdict === "verified" ? "green" : verdict === "mismatch" ? "red" : "yellow";

  const sizesLabel = perBedroom.map((b) => `${b.bedrooms}BR`).join(" + ");
  const bedroomVerifiedPct = pct(exactBedroomComps, comps);
  const communityVerifiedPct = pct(communityEvidencedComps, comps);

  const reasons: string[] = [];
  if (communityConfirmation) {
    reasons.push(communityConfirmation.detail);
  }
  if (liveMonths > 0) {
    const boxed = liveMonths - widenedMonths - unboxedMonths;
    reasons.push(
      `Community: ${boxed}/${liveMonths} scanned months were hard-boxed to the ${community || "community"} footprint` +
      `${widenedMonths > 0 ? `; ${widenedMonths} month(s) used a WIDENED nearby-area box` : ""}` +
      `${unboxedMonths > 0 ? `; ${unboxedMonths} month(s) had NO geographic constraint` : ""}` +
      `${comps > 0 ? `; ${communityEvidencedComps}/${comps} comps carry positive in-community evidence (coordinates in the box or naming the community)` : ""}.`,
    );
    reasons.push(
      `Bedrooms: search pinned to the exact size for ${perBedroom.filter((b) => b.bedroomQueryPinned).length}/${perBedroom.length} researched size(s); ` +
      `${exactBedroomComps}/${comps} comps (${bedroomVerifiedPct ?? 0}%) independently parsed at the exact bedroom count; ` +
      `${mismatchedComps} accepted comp(s) parsed at a different size.`,
    );
  } else {
    reasons.push("No live SearchAPI months were recorded — the rates came from the static table / extrapolation, so community and bedroom count cannot be verified from market data. Re-run the market-rate update.");
  }
  if (missingExpectedBedrooms.length > 0) {
    reasons.push(`MISMATCH: the listing needs ${missingExpectedBedrooms.map((b) => `${b}BR`).join(", ")} but no rates were researched for that size.`);
  }
  if (mismatchedComps > 0) {
    reasons.push(`MISMATCH: ${mismatchedComps} accepted comp(s) parsed at a DIFFERENT bedroom size — treat these rates as unverified.`);
  }
  if (bedroomSplitInferred) {
    reasons.push("The combo's per-unit bedroom split was inferred from the combined total — verify the split before trusting the sizes.");
  }
  if (!resortConfident) {
    reasons.push("The community could not be confidently matched to a curated market — verify the resort.");
  }
  if (extrapolatedMonths > 0 || fallbackMonths > 0) {
    reasons.push(`${liveMonths} live month(s) scanned · ${extrapolatedMonths} year-2 month(s) extrapolated from year-1 · ${fallbackMonths} month(s) priced from the static table.`);
  }

  const headline = verdict === "verified"
    ? `Community & bedrooms verified — ${sizesLabel} · ${bedroomVerifiedPct ?? 0}% of ${comps} comps exact-size · all months in-community`
    : verdict === "mismatch"
      ? missingExpectedBedrooms.length > 0
        ? `Wrong bedroom research — listing needs ${missingExpectedBedrooms.map((b) => `${b}BR`).join(", ")}`
        : communityConfirmation && !communityConfirmation.locationMatch
          ? `Research location doesn't match this listing — verify the community`
          : `Comp evidence contradicts the listing — review before trusting these rates`
      : liveMonths === 0
        ? `Rates not market-verified (no live comps) — re-run the update`
        : `Partially verified — review the comp evidence (${bedroomVerifiedPct ?? 0}% exact-size comps${widenedMonths > 0 ? `, ${widenedMonths} widened month(s)` : ""})`;

  return {
    community,
    searchLabel,
    communityConfirmation,
    perBedroom,
    comps,
    exactBedroomComps,
    communityEvidencedComps,
    bedroomVerifiedPct,
    communityVerifiedPct,
    liveMonths,
    widenedMonths,
    unboxedMonths,
    expectedBedrooms,
    missingExpectedBedrooms,
    bedroomSplitInferred,
    resortConfident,
    communityVerdict,
    bedroomVerdict,
    verdict,
    level,
    headline,
    reasons,
  };
}
