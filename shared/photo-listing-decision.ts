// Pure, zero-dependency per-platform PHOTO verdict for the photo-listing reverse-image scanner.
// Extracted from server/photo-listing-scanner.ts so the Balanced detection contract (2026-06-29)
// is unit-testable without the scanner's network / DB / disk dependencies. Address-on-OTA detection
// is a SEPARATE leg (its own columns in shared/address-listing-logic.ts) and is NOT decided here.
//
// A platform (Airbnb / VRBO / Booking) is judged "found" by photos when ANY of:
//   1. an address hit was passed in (kept for callers that fold address into the photo verdict), OR
//   2. >= minMatches distinct photos were FULLY verified — community-compatible AND the unit number
//      appears in the listing's Google-indexed page text (the historical strict signal), OR
//   3. >= agreementThreshold distinct interior photos strongly matched the SAME host on
//      community-compatible listings, even without per-hit unit-text verification (the Balanced
//      multi-photo-agreement fallback that catches reposts which hide the unit number from page text).
// When none of those hold: "unknown" if no Lens call succeeded (inconclusive — never silently clean),
// else "clean".
export type PhotoListingPlatformStatus = "clean" | "found" | "unknown";

export const DEFAULT_MIN_PHOTO_MATCHES = 2;
export const DEFAULT_MULTI_PHOTO_AGREEMENT = 3;

export function decidePlatformStatus(input: {
  photoHitCount: number;
  photoStrongCount: number;
  hasAddressHit: boolean;
  anyLensSucceeded: boolean;
  minMatches?: number;
  agreementThreshold?: number;
}): PhotoListingPlatformStatus {
  const minMatches = input.minMatches ?? DEFAULT_MIN_PHOTO_MATCHES;
  const agreement = input.agreementThreshold ?? DEFAULT_MULTI_PHOTO_AGREEMENT;
  if (input.hasAddressHit) return "found";
  if (input.photoHitCount >= minMatches || input.photoStrongCount >= agreement) return "found";
  if (!input.anyLensSucceeded) return "unknown";
  return "clean";
}
