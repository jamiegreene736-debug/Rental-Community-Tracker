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
}): CityVrboCoverage {
  const rawHarvested = Math.max(0, Math.round(Number(args.rawHarvested) || 0));
  const total =
    args.vrboReportedTotal != null && Number.isFinite(args.vrboReportedTotal) && args.vrboReportedTotal > 0
      ? Math.round(args.vrboReportedTotal)
      : null;
  // Unknown/unreliable total => don't false-alarm => treat as complete.
  const looksComplete = total == null || rawHarvested >= Math.floor(COVERAGE_COMPLETE_RATIO * total);
  return {
    vrboReportedTotal: total,
    rawHarvested,
    usable: Math.max(0, Math.round(Number(args.usable) || 0)),
    droppedBelowMinBedrooms: Math.max(0, Math.round(Number(args.droppedBelowMinBedrooms) || 0)),
    droppedNoPrice: Math.max(0, Math.round(Number(args.droppedNoPrice) || 0)),
    looksComplete,
  };
}
