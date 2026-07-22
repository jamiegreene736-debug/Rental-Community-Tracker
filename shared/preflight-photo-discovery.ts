/** Discovery attempt caps for promoted-draft preflight photo fetch (server + client). */
export type PreflightPhotoDiscoveryAttempt = {
  bedrooms: number | "any";
  minBedrooms?: number;
  maxCandidates: number;
};

/**
 * Acceptance gate for one discovery result inside the preflight photo-fetch
 * job. Root-caused 2026-07-18 (Cliffs at Princeville draft 20): the audit
 * sweep's find-new-source rung requested an exact-3BR listing, discovery found
 * none, and fetch-unit-photos returned its REPRESENTATIVE fallback — a 2BR
 * gallery from the same resort flagged `representativeFallback: true` with
 * proof status "review". The job's old acceptance check (`status !==
 * "rejected"`) let that wrong-bedroom gallery REPLACE the unit's real gallery
 * and re-stamp its source URL, silently turning a 3BR unit into a 2BR one with
 * no unit_swaps record. Find-new mode replaces a REAL gallery, so a
 * representative (wrong-BR) result must never win there — that was always the
 * stated invariant; this predicate enforces it. Empty-unit "Find Photos" and
 * the add-community wizard keep accepting representative galleries (photos
 * beat an empty listing at creation time).
 */
export function findNewDiscoveryResultRejection(input: {
  /** True when the job replaces an existing gallery with a DIFFERENT listing. */
  findNewSource: boolean;
  /** The endpoint's `representativeFallback` response flag (or the proof's). */
  representativeFallback: boolean;
  /** Proof bedroomMatch: false = scraped bedrooms contradict the request; null/undefined = unverifiable (allowed). */
  bedroomMatch: boolean | null | undefined;
  /**
   * PROPERTY-TYPE rejection reason from replacementPropertyTypeRejection
   * (shared/listing-property-type.ts), or null when the type is acceptable /
   * unknown. Added 2026-07-22 (Mauna Lani Point draft -13): a find-new run
   * must never replace a condo unit's gallery with a single-family house's.
   */
  propertyTypeRejection?: string | null;
}): string | null {
  if (!input.findNewSource) return null;
  if (input.representativeFallback) {
    return "representative wrong-bedroom gallery — must never replace a real gallery";
  }
  if (input.bedroomMatch === false) {
    return "scraped bedroom count contradicts the requested bedrooms";
  }
  if (typeof input.propertyTypeRejection === "string" && input.propertyTypeRejection) {
    return input.propertyTypeRejection;
  }
  return null;
}

export function preflightPhotoDiscoveryAttempts(
  bedrooms: number,
  replacingExistingPhotos: boolean,
): PreflightPhotoDiscoveryAttempt[] {
  // NOTE FOR CODEX: the `replacingExistingPhotos` (re-pull) branch was inert until
  // 2026-07-10 — plain re-pull still gates discovery OFF (allowDiscoveryFallback in
  // server/preflight-background-jobs.ts), but findNewSource mode (now the Unit
  // Audit Sweep's find-new-source rung; the operator "Find new photos" button
  // moved to the sameUnitOnly hunt on 2026-07-17 and no longer reaches these
  // attempts) runs them with replacingExistingPhotos=true, with the relaxed
  // `"any"` rung filtered out there (exact-bedroom only when replacing a real
  // gallery). The EMPTY-unit "Find Photos" path is the `false` branch.
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
