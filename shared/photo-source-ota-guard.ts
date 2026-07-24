// OTA photo-source guard — a listing gallery we publish may NEVER be scraped
// from a live short-term-rental listing.
//
// WHY (2026-07-23, property 4 / unit-621): the folder `unit-621` carried
// `_source.json` → `sourceListing.url = https://www.vrbo.com/982364`, stamped
// 2026-04-30 by the alert-remediate flow. Its 43 photos ARE that VRBO
// listing's photos, so the weekly reverse-image scanner flagged the folder
// `vrbo_status = found` on 2026-06-30 — correctly. The scanner was never the
// problem: we had sourced the gallery off an OTA in the first place, which
// means our Guesty/Airbnb/VRBO listings publish another host's live photos.
// That is a duplicate-content + takedown exposure on every channel.
//
// The find/discovery paths were already portal-gated
// (`detectRealEstateListingPortal` — Zillow / Realtor / Redfin / Homes only),
// but every path that CONSUMES a saved source URL was not: the preflight
// "Re-pull all photos" job feeds `_source.json` straight back into
// `fetch-unit-photos`, `rescrape-unit-photos` resolves the same stamp, the
// same-unit hunt anchors on it, and the unit-swap routes accepted any
// `http(s)` URL as `newSourceUrl`. One poisoned stamp therefore kept
// re-poisoning the gallery on every re-pull.
//
// This module is the single, pure classifier those seams share. It is
// deliberately built on `otaPlatformForUrl` (shared/ota-host-match.ts) — the
// same host-family matcher the duplicate-photo scanner buckets with — so the
// guard and the detector can never disagree: anything the scanner would flag
// as "found on an OTA" is exactly what we refuse to source from.
//
// FAIL-OPEN BY DESIGN: an unrecognized host (property-manager site, resort
// site, Zillow/Redfin/Realtor/Homes) is NOT rejected. Only positively
// identified OTA hosts are. Absence of evidence must never block a legitimate
// re-pull — the failure mode we are closing is the false ACCEPT, not a false
// reject.

import { hostOfUrl, otaPlatformForUrl, type OtaPlatformKey } from "./ota-host-match";

/**
 * OTA hosts beyond the three the reverse-image scanner buckets
 * (airbnb / vrbo family / booking.com). Photos lifted from any of these are
 * just as unpublishable, they simply aren't part of the scanner's platform
 * vocabulary. Matched with the same `host === family || *.family` semantics,
 * so regional subdomains are covered and lookalikes ("expedia.evil.com") are
 * not. Extend this list rather than loosening the matcher.
 *
 * DELIBERATELY EXCLUDED: property-manager and resort sites (parrishkauai.com,
 * olaproperties.com, waikikibeachrentals.com …). Those are configured,
 * legitimate community photo sources — `COMMUNITY_SOURCE_URLS` names two of
 * them — so blanket-banning "any site that rents units" would break the
 * community re-pull the operator relies on. The rule being enforced here is
 * the operator's: not an OTA.
 */
export const EXTRA_OTA_PHOTO_SOURCE_HOSTS: readonly string[] = [
  // Expedia group — VRBO's parent; same inventory pool under other brands.
  "expedia.com",
  "expedia.co.uk",
  "expedia.ca",
  "hotels.com",
  "orbitz.com",
  "travelocity.com",
  // TripAdvisor group.
  "tripadvisor.com",
  "tripadvisor.co.uk",
  "flipkey.com",
  // Other pure OTAs / OTA metasearch whose listings are OTA inventory.
  "agoda.com",
  "hometogo.com",
];

export type OtaPhotoSourceRejection = {
  /** Registrable host the URL resolved to (www. stripped, lowercased). */
  host: string;
  /**
   * Scanner platform key when the host is one the duplicate-photo scanner
   * checks; null for the supplementary OTA hosts above.
   */
  platform: OtaPlatformKey | null;
  /** Operator-facing label ("VRBO", "Airbnb", "Booking.com", or the host). */
  label: string;
};

const PLATFORM_LABELS: Record<OtaPlatformKey, string> = {
  airbnb: "Airbnb",
  vrbo: "VRBO",
  booking: "Booking.com",
};

function hostInFamily(host: string, family: string): boolean {
  return host === family || host.endsWith(`.${family}`);
}

/**
 * Classify a candidate photo-source URL. Returns null for every URL that is
 * not a positively identified OTA listing host — including empty/malformed
 * input, which callers handle with their own URL validation.
 */
export function otaPhotoSourceRejection(url: string | null | undefined): OtaPhotoSourceRejection | null {
  const host = hostOfUrl(url);
  if (!host) return null;
  const platform = otaPlatformForUrl(url);
  if (platform) return { host, platform, label: PLATFORM_LABELS[platform] };
  for (const family of EXTRA_OTA_PHOTO_SOURCE_HOSTS) {
    if (hostInFamily(host, family)) return { host, platform: null, label: host };
  }
  return null;
}

/** True when this URL is a live OTA listing and must not become a photo source. */
export function isOtaPhotoSourceUrl(url: string | null | undefined): boolean {
  return otaPhotoSourceRejection(url) !== null;
}

/**
 * The one operator-facing sentence every seam reports. `subject` names what
 * was refused ("Replacement listing", "Photo source", …) so the message reads
 * naturally wherever it surfaces.
 */
export function otaPhotoSourceMessage(
  rejection: OtaPhotoSourceRejection,
  subject = "Photo source",
): string {
  return (
    `${subject} is a live ${rejection.label} listing (${rejection.host}). ` +
    `Unit photos may never be scraped from an OTA — publishing them would duplicate ` +
    `another host's live listing and trip the duplicate-photo scanner on every channel. ` +
    `Use a real-estate listing (Zillow, Redfin, Realtor.com, Homes.com) instead.`
  );
}

/** Convenience: message-or-null for a candidate URL. */
export function otaPhotoSourceRejectionMessage(
  url: string | null | undefined,
  subject = "Photo source",
): string | null {
  const rejection = otaPhotoSourceRejection(url);
  return rejection ? otaPhotoSourceMessage(rejection, subject) : null;
}
