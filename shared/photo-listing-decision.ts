// Pure per-platform PHOTO verdict for the photo-listing reverse-image scanner (only other pure
// shared modules imported — no Node/DB/React). Extracted from server/photo-listing-scanner.ts so
// the Balanced detection contract (2026-06-29) is unit-testable without the scanner's
// network / DB / disk dependencies.
import { normalizeListingUrlForMatch } from "./photo-match-exceptions";
//
// A platform (Airbnb / VRBO / Booking) is judged "found" by photos when EITHER:
//   1. >= minMatches distinct photos were FULLY verified — community-compatible AND the unit number
//      appears in the listing's Google-indexed page text (the historical strict signal), OR
//   2. >= agreementThreshold distinct interior photos strongly matched the SAME host on
//      community-compatible listings, even without per-hit unit-text verification (the Balanced
//      multi-photo-agreement fallback that catches reposts which hide the unit number from page text).
// When neither holds: "unknown" if no Lens call succeeded (inconclusive — never silently clean),
// else "clean".
export type PhotoListingPlatformStatus = "clean" | "found" | "unknown";

export const DEFAULT_MIN_PHOTO_MATCHES = 2;
export const DEFAULT_MULTI_PHOTO_AGREEMENT = 3;

export function decidePlatformStatus(input: {
  photoHitCount: number;
  photoStrongCount: number;
  anyLensSucceeded: boolean;
  minMatches?: number;
  agreementThreshold?: number;
}): PhotoListingPlatformStatus {
  const minMatches = input.minMatches ?? DEFAULT_MIN_PHOTO_MATCHES;
  const agreement = input.agreementThreshold ?? DEFAULT_MULTI_PHOTO_AGREEMENT;
  if (input.photoHitCount >= minMatches || input.photoStrongCount >= agreement) return "found";
  if (!input.anyLensSucceeded) return "unknown";
  return "clean";
}

// The note the scanner's persist() appends to errorMessage when a scan was inconclusive (provider
// outage / no Lens success) and the prior statuses were preserved. Shared as a constant so the
// staleness check below can't drift from the string the scanner actually writes.
export const INCONCLUSIVE_SCAN_NOTE = "kept previous status because the provider failure was inconclusive";

// True when a persisted photo_listing_checks row represents a scan that never really ran — the
// photo leg produced no usable verdict (all-unknown statuses = no Lens call succeeded) or the
// scanner recorded an outage (Lens unavailable / prior statuses preserved because the failure was
// inconclusive). The weekly scheduler uses this to RE-SCAN such rows after a short retry window
// (~24h) instead of letting one SearchAPI outage blind a folder for the full 7-day cadence.
// A healthy clean/found row never matches: its statuses are decided and its errorMessage is null.
export function photoListingScanWasInconclusive(row: {
  airbnbStatus?: string | null;
  vrboStatus?: string | null;
  bookingStatus?: string | null;
  errorMessage?: string | null;
}): boolean {
  const allUnknown =
    row.airbnbStatus === "unknown" &&
    row.vrboStatus === "unknown" &&
    row.bookingStatus === "unknown";
  if (allUnknown) return true;
  const err = String(row.errorMessage ?? "").toLowerCase();
  if (!err) return false;
  if (err.includes(INCONCLUSIVE_SCAN_NOTE)) return true;
  if (err.includes("lens unavailable")) return true;
  return false;
}

// REVIEW tier (2026-07-12, display-only): a platform whose verdict stayed below the red thresholds
// but still produced at least one FULLY-VERIFIED match (community-compatible AND the unit number in
// the listing's page text) is worth a human look — a thief who copied exactly ONE photo never
// reaches MIN_MATCHES. Returns how many verified sub-threshold matches the row carries; the
// dashboard renders an amber "!" when > 0. Deliberately NEVER feeds automation: the status stays
// "clean", the red duplicate-photos popup does not raise, and the audit sweep's OTA stage ignores
// it — one verified hit can still be a shared-building edge case, so a human decides.
export function subThresholdVerifiedMatches(
  status: string | null | undefined,
  matches: Array<{ verified?: boolean } | null | undefined> | null | undefined,
): number {
  return subThresholdVerifiedMatchRows(status, matches).length;
}

// Row-level variant (2026-07-22): returns the actual verified sub-threshold match rows so the
// dashboard's review modal can show the operator WHICH photo matched WHICH listing. Accepts an
// optional set of operator-confirmed exception keys (normalizeListingUrlForMatch output — the
// photo-match-exceptions allowlist): a match whose listing URL the operator already reviewed and
// confirmed as "not a match" is excluded, so the amber badge greens IMMEDIATELY after confirming
// (the stored scan row still heals through the real scanner rescan, which suppresses the same
// URLs at the authorized-URL seam). Matches with an unparseable listing URL are never excluded —
// fail-loud: an exception can only silence the exact listing the operator saw.
export function subThresholdVerifiedMatchRows<
  T extends { verified?: boolean; listingUrl?: string | null },
>(
  status: string | null | undefined,
  matches: Array<T | null | undefined> | null | undefined,
  exceptedNormalizedUrls?: Set<string> | null,
): T[] {
  if (status === "found") return []; // already red — the review tier only covers sub-threshold rows
  const out: T[] = [];
  for (const m of matches ?? []) {
    if (!m || m.verified !== true) continue;
    if (exceptedNormalizedUrls && exceptedNormalizedUrls.size > 0) {
      const normalized = normalizeListingUrlForMatch(m.listingUrl);
      if (normalized && exceptedNormalizedUrls.has(normalized)) continue;
    }
    out.push(m);
  }
  return out;
}
