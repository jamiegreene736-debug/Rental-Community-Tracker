/** Discovery attempt caps for promoted-draft preflight photo fetch (server + client). */
export type PreflightPhotoDiscoveryAttempt = {
  bedrooms: number | "any";
  minBedrooms?: number;
  maxCandidates: number;
};

export function preflightPhotoDiscoveryAttempts(
  bedrooms: number,
  replacingExistingPhotos: boolean,
): PreflightPhotoDiscoveryAttempt[] {
  // NOTE FOR CODEX: the `replacingExistingPhotos` (re-pull) branch is effectively
  // inert here — re-pull gates discovery OFF entirely (allowDiscoveryFallback =
  // !replacingExistingPhotos in server/preflight-background-jobs.ts), so these
  // attempts only run for the EMPTY-unit "Find Photos" path (the `false` branch).
  // The empty-unit caps were the binding limit on "no photos found" failures:
  // discovery harvests dozens of Zillow/Realtor/Redfin/Homes candidates but only
  // the first 6/8/10 were ever scraped. Raised to 12/14/16 so more of the
  // already-built candidate pool gets a chance to land a usable same-resort
  // gallery. Still bounded by the route's discoveryWallBudgetMs (~175s) and each
  // attempt's 120s loopback timeout, so this can't blow the 300s edge.
  return [
    { bedrooms, maxCandidates: replacingExistingPhotos ? 10 : 12 },
    { bedrooms, maxCandidates: replacingExistingPhotos ? 12 : 14 },
    { bedrooms: "any", maxCandidates: replacingExistingPhotos ? 14 : 16 },
  ];
}
