// Manual "Add a community" (Add Combo Listing wizard) — unit URL classifier.
//
// The operator pastes two unit listing URLs that the server then FETCHES and
// browser-NAVIGATES to (Apify / headless Chromium) to scrape photos. That makes
// this both a feature gate (we can only scrape full galleries from a handful of
// real-estate hosts) AND the SSRF guard: a POSITIVE allowlist is the only safe
// gate — a denylist would let an operator point the scraper at http://localhost,
// RFC-1918 hosts, or the cloud-metadata endpoint (169.254.169.254). This mirrors
// the isVrboListingUrl-style allowlist used by the other URL-accepting endpoints.
//
// Pure + shared so it can be unit-tested in isolation and reused.

/** Real-estate hosts whose listing pages expose a full photo gallery we scrape. */
export const MANUAL_COMBO_SUPPORTED_HOSTS = [
  "zillow.com",
  "redfin.com",
  "realtor.com",
  "homes.com",
] as const;

/**
 * OTA hosts the operator might paste by mistake. They have NO gallery extractor
 * (generic og:image yields ~1 hero and they bot-wall datacenter IPs), and a combo
 * is built from CLEAN, non-OTA units anyway — so they get a tailored hint.
 */
export const MANUAL_COMBO_OTA_HOSTS = [
  "vrbo.com",
  "airbnb.com",
  "homeaway.com",
  "booking.com",
  "abritel.fr",
  "expedia.com",
  "hometogo.com",
] as const;

export type ManualComboUrlVerdict = {
  /** True only for an http(s) URL on a supported real-estate host. */
  ok: boolean;
  /** Normalized host (www-stripped, lowercased), or null when the URL won't parse. */
  host: string | null;
  /** Operator-facing reason when ok=false (reads after "Unit A URL "/"Unit B URL "). */
  reason?: string;
};

const hostMatches = (host: string, suffix: string): boolean =>
  host === suffix || host.endsWith(`.${suffix}`);

/**
 * Classify a pasted unit URL. ok=true ONLY for https/http URLs on a supported
 * real-estate host — everything else (bad URL, non-http scheme, OTA host, or any
 * other/internal host) is rejected with an operator-facing reason.
 */
export function classifyManualComboUnitUrl(raw: string): ManualComboUrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, host: null, reason: "is not a valid URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, host: parsed.hostname || null, reason: "must be an http(s) link." };
  }
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (MANUAL_COMBO_SUPPORTED_HOSTS.some((h) => hostMatches(host, h))) {
    return { ok: true, host };
  }
  if (MANUAL_COMBO_OTA_HOSTS.some((h) => hostMatches(host, h))) {
    return {
      ok: false,
      host,
      reason: `points to ${host}, whose photos can't be scraped. Paste the unit's Zillow, Redfin, Realtor.com, or Homes.com listing instead.`,
    };
  }
  return {
    ok: false,
    host,
    reason: `points to ${host}, which isn't a supported listing site. Paste the unit's Zillow, Redfin, Realtor.com, or Homes.com listing.`,
  };
}
