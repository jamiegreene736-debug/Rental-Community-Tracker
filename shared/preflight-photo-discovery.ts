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
  return [
    { bedrooms, maxCandidates: replacingExistingPhotos ? 10 : 6 },
    { bedrooms, maxCandidates: replacingExistingPhotos ? 12 : 8 },
    { bedrooms: "any", maxCandidates: replacingExistingPhotos ? 14 : 10 },
  ];
}
