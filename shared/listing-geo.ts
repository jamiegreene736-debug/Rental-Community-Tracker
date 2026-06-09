// Geographic guard for harvested VRBO/OTA listings. Pure + dependency-free.
//
// WHY: VRBO autocomplete can resolve a small Kauai town to a MAINLAND namesake —
// e.g. the nearby-city expansion searched "Port Allen" (a real Kauai town ~45 min
// from Poipu Kai) and VRBO returned "Port Allen, LOUISIANA" (next to Baton Rouge /
// LSU). Those out-of-state listings were harvested, the matcher clustered them
// ("baton rouge retreat"), and a $2,604 Baton Rouge 4BR got attached to a Hawaii
// booking. Every buy-in market is in Hawaii, so we drop any harvested listing
// whose location clearly names a NON-Hawaii US state. Conservative: a listing with
// no recognizable state is KEPT (we never over-drop a genuine Hawaii unit that
// just lacks a state in its card text).

// Hawaii signals (islands, major towns, the state + abbreviation). If a listing's
// location names any of these it is treated as in-state and never dropped.
const HAWAII_RE = /\b(hawaii|hawai'?i|kauai|kaua'?i|maui|oahu|o'?ahu|molokai|moloka'?i|lanai|lana'?i|honolulu|lihue|līhu'?e|kona|kailua|hilo|waikiki|poipu|po'?ipu|koloa|kōloa|princeville|wailua|kapaa|kapa'?a|hanalei|kihei|lahaina|wailea|kaanapali|kā'?anapali)\b/i;
const HI_ABBR_RE = /(?:^|[,\s])HI(?:[,\s]|$)/; // ", HI" / " HI " — case-sensitive so it doesn't match "hi" in words

// Non-Hawaii US states: full names + USPS abbreviations. (Hawaii intentionally
// excluded — it's the target.)
const NON_HAWAII_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "idaho", "illinois", "indiana", "iowa", "kansas",
  "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
  "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
];
const NON_HAWAII_ABBRS = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA",
  "WA", "WV", "WI", "WY",
];
const NON_HAWAII_NAME_RE = new RegExp(`\\b(?:${NON_HAWAII_STATE_NAMES.join("|").replace(/ /g, "\\s")})\\b`, "i");
// Abbreviation only counts when it reads like a state slot: ", LA" or ", LA, " or ", LA <zip/word>"
// — never a bare two letters inside a word. Case-sensitive (states are uppercase).
const NON_HAWAII_ABBR_RE = new RegExp(`,\\s*(?:${NON_HAWAII_ABBRS.join("|")})(?:[\\s,]|$)`);

/** True if the text clearly references a Hawaii location. */
export function mentionsHawaii(text: string | null | undefined): boolean {
  if (!text) return false;
  return HAWAII_RE.test(text) || HI_ABBR_RE.test(text);
}

/** True if the text clearly names a US state that is NOT Hawaii. */
export function mentionsNonHawaiiState(text: string | null | undefined): boolean {
  if (!text) return false;
  return NON_HAWAII_NAME_RE.test(text) || NON_HAWAII_ABBR_RE.test(text);
}

/**
 * Should this listing be dropped as OUT-OF-AREA for a Hawaii buy-in market?
 * Drop only when the location clearly names a non-Hawaii state AND does NOT also
 * name Hawaii (a Hawaii signal always wins, so "Lawai, HI" near a stray token is
 * safe). No location / ambiguous → KEEP (don't over-drop). targetState currently
 * only supports Hawaii (every market is Hawaii); pass it for future-proofing.
 */
export function listingIsOutOfArea(
  locationText: string | null | undefined,
  targetState = "Hawaii",
): boolean {
  if (!/hawaii/i.test(targetState)) return false; // non-Hawaii markets not yet supported → never drop
  if (!locationText) return false;
  if (mentionsHawaii(locationText)) return false;
  return mentionsNonHawaiiState(locationText);
}
