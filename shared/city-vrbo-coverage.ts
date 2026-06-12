// City VRBO scan COVERAGE summary. Pure + dependency-free so the server
// (city-vrbo-inventory), the auto-fill job, the client tracker, and tests all
// agree on one shape + one "is the scan complete" rule.
//
// Why this exists: the operator compared VRBO's own destination-search count
// (e.g. Koloa = 144 properties, ALL bedroom counts) against the buy-in tracker's
// "82 listings" and reasonably read it as the tool missing 62 listings. In fact
// the sidecar harvested ~142 of 144 and the tool then DROPS sub-2BR units (a
// buy-in combo unit must be >=2BR) + unpriced rows, leaving 82 USABLE. This
// summary surfaces that breakdown so the tracker shows found-vs-usable-vs-VRBO
// total — and flags a GENUINELY incomplete harvest (rawHarvested well short of
// VRBO's reported total) instead of letting it look like coverage.

export type CityVrboCoverage = {
  /** VRBO's own "N of T" results total for the search (null when not parseable). */
  vrboReportedTotal: number | null;
  /** Deduped listings the sidecar actually captured (ALL bedroom counts). */
  rawHarvested: number;
  /** Priced, >=2BR listings the matcher can actually use. */
  usable: number;
  /** Excluded because <2BR (studios/1BR can't be a buy-in combo unit). */
  droppedBelowMinBedrooms: number;
  /** Excluded because no extractable price. */
  droppedNoPrice: number;
  /** rawHarvested covers >= COVERAGE_COMPLETE_RATIO of VRBO's total (or total unknown). */
  looksComplete: boolean;
  // ── HomeToGo source completeness (mirrors the VRBO reconciliation) ───────────
  // HomeToGo runs as a SEPARATE sidecar op against its own /searchdetails feed, so
  // it gets its own "did we pull all of them" signal. The reconciliation target is
  // the FEED's own offer total (apples-to-apples with the scoped offers we harvest,
  // both pre-filter) — NOT the rendered all-provider "N rentals" header (we drop
  // Vrbo/Expedia, so that would always look short). 0/unknown when HomeToGo is off.
  /** HomeToGo /searchdetails feed's own reported offer total (null when not exposed). */
  hometogoReportedTotal: number | null;
  /** Raw scoped HomeToGo offers the sidecar harvested for the search (pre-filter). */
  hometogoRawHarvested: number;
  /**
   * HomeToGo harvest reached the feed total OR a genuine scroll plateau (the feed
   * stopped serving new offers) — i.e. NOT truncated by the wallet budget / scroll
   * cap. Unknown total never false-alarms, same policy as VRBO.
   */
  hometogoLooksComplete: boolean;
};

// A harvest is "complete" when we deduped-captured at least this fraction of
// VRBO's own reported total. 0.9 absorbs the few listings VRBO shows but never
// renders (dupes, just-booked) without masking a real pagination shortfall.
export const COVERAGE_COMPLETE_RATIO = 0.9;

/** Pull VRBO's reported results total from the sidecar's mapHarvest diagnostics. */
export function vrboReportedTotalFromMapHarvest(
  mapHarvest: Record<string, unknown> | null | undefined,
): number | null {
  const n = Number((mapHarvest as { graphqlTotalCount?: unknown } | null | undefined)?.graphqlTotalCount);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function buildCityScanCoverage(args: {
  rawHarvested: number;
  usable: number;
  droppedBelowMinBedrooms: number;
  droppedNoPrice: number;
  vrboReportedTotal: number | null;
  // HomeToGo source (all optional — omit/undefined when HomeToGo is disabled or the
  // op returned no harvest diag; the VRBO call site is unchanged when these are absent).
  hometogoReportedTotal?: number | null;
  hometogoRawHarvested?: number;
  /** Worker reached the feed total OR a genuine plateau (not budget/scroll-cap truncated). */
  hometogoHarvestComplete?: boolean;
}): CityVrboCoverage {
  const rawHarvested = Math.max(0, Math.round(Number(args.rawHarvested) || 0));
  const total =
    args.vrboReportedTotal != null && Number.isFinite(args.vrboReportedTotal) && args.vrboReportedTotal > 0
      ? Math.round(args.vrboReportedTotal)
      : null;
  // Unknown/unreliable total => don't false-alarm => treat as complete.
  const looksComplete = total == null || rawHarvested >= Math.floor(COVERAGE_COMPLETE_RATIO * total);

  // HomeToGo completeness: COMPLETE when the worker genuinely exhausted the feed
  // (reached-total / plateau), OR we pulled >= 90% of the feed's own total, OR there is
  // no feed total to judge against (no false alarm). Only a budget / scroll-cap cutoff
  // SHORT of a known feed total reads as incomplete.
  const hometogoReportedTotal =
    args.hometogoReportedTotal != null && Number.isFinite(args.hometogoReportedTotal) && args.hometogoReportedTotal > 0
      ? Math.round(args.hometogoReportedTotal)
      : null;
  const hometogoRawHarvested = Math.max(0, Math.round(Number(args.hometogoRawHarvested) || 0));
  // Three cases, by the worker's terminal harvest state:
  //  - undefined  → HomeToGo did NOT run (disabled / errored / VRBO-only call) → n/a → complete.
  //  - true       → reached-total or plateau (results UI exhausted) → complete.
  //  - false      → budget / scroll-cap cutoff → complete ONLY if we still pulled >=90% of a
  //                 KNOWN feed total; an unknown total + a cutoff is possibly-truncated → flag it.
  // (Unlike VRBO, an unknown total does NOT auto-pass here: a budget/max-scrolls stop is itself
  // evidence of truncation regardless of whether the feed exposed a number.)
  const hometogoLooksComplete =
    args.hometogoHarvestComplete === undefined
      ? true
      : args.hometogoHarvestComplete
        ? true
        : hometogoReportedTotal != null &&
          hometogoRawHarvested >= Math.floor(COVERAGE_COMPLETE_RATIO * hometogoReportedTotal);

  return {
    vrboReportedTotal: total,
    rawHarvested,
    usable: Math.max(0, Math.round(Number(args.usable) || 0)),
    droppedBelowMinBedrooms: Math.max(0, Math.round(Number(args.droppedBelowMinBedrooms) || 0)),
    droppedNoPrice: Math.max(0, Math.round(Number(args.droppedNoPrice) || 0)),
    looksComplete,
    hometogoReportedTotal,
    hometogoRawHarvested,
    hometogoLooksComplete,
  };
}
