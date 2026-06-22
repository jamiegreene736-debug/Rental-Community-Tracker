// ─── PHOTO LOCATION CONFIRMATION ─────────────────────────────────────────────
// Shared, deterministic helper that confirms WHAT STATE (and city) a community
// or unit is in, as part of the Pre-Flight Check photo features:
//   - "Re-pull community photos" confirms the community's state.
//   - "Get new photos" for a unit confirms that unit's state/city.
//
// Motivation: the operator added "Bay Watch" intending Florida, but it is a
// South Carolina resort (see shared/community-location-guard.ts). Surfacing the
// state alongside the photos catches that class of mistake while the operator is
// looking at the gallery.
//
// This builds on community-location-guard: the curated registry is the
// authoritative "known home state" signal, layered with an optional OBSERVED
// signal (e.g. the state Claude reports for the community, or a scraped listing
// address). It is recall-safe — it never fabricates a mismatch from nothing.

import {
  canonicalStateName,
  statesEquivalent,
  communityHomeState,
} from "./community-location-guard";

export type LocationMatch = "match" | "mismatch" | "unconfirmed";

export type LocationConfirmation = {
  communityName: string | null;
  /** The state/city we EXPECT (from the property/draft record), canonicalized. */
  expectedState: string | null;
  expectedCity: string | null;
  /** Our best read of the ACTUAL state/city (curated home state, or observed). */
  confirmedState: string | null;
  confirmedCity: string | null;
  stateStatus: LocationMatch;
  cityStatus: LocationMatch;
  /** Overall: `mismatch` if state or city contradicts; `match` if the state is
   *  positively confirmed to agree; otherwise `unconfirmed`. */
  status: LocationMatch;
  /** One-line operator-facing summary. */
  note: string;
};

const US_STATE_FULL_NAMES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
  "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "West Virginia", "Wisconsin", "Wyoming",
];

const STATE_ABBR = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

/** Pull a US state (full name or 2-letter abbrev) out of free text, returning
 *  the canonical full state name, or null when none is found. */
export function parseStateFromText(text: string | null | undefined): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  // Full names first, on WORD BOUNDARIES (longest match wins, so "West Virginia"
  // before "Virginia"). Boundaries stop a state name embedded in a larger word
  // from false-matching — e.g. "Indianapolis" must NOT yield Indiana, and
  // "foregone" must NOT yield Oregon (state names have no regex metachars).
  let best: string | null = null;
  for (const full of US_STATE_FULL_NAMES) {
    if (new RegExp(`\\b${full}\\b`, "i").test(raw)) {
      if (!best || full.length > best.length) best = full;
    }
  }
  if (best) return best;
  // Abbreviation only as a genuinely-uppercase STANDALONE word (e.g. the "FL" in
  // "Kissimmee, FL 34747") — never a 2-letter run inside a word like "PAlms" or
  // "soME", which would otherwise false-match Pennsylvania / Maine.
  const tokens = raw.match(/\b[A-Z]{2}\b/g) ?? [];
  for (const tok of tokens) {
    if (STATE_ABBR.has(tok)) return canonicalStateName(tok);
  }
  return null;
}

/** Parse {city, state} out of a mailing-style address ("123 Main St, Kissimmee,
 *  FL 34747"). Returns nulls for parts that can't be confidently extracted. */
export function parseCityStateFromAddress(
  address: string | null | undefined,
): { city: string | null; state: string | null } {
  const raw = String(address ?? "").trim();
  if (!raw) return { city: null, state: null };
  const state = parseStateFromText(raw);
  // City is the comma-segment immediately before the state/zip segment.
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  let city: string | null = null;
  if (parts.length >= 2) {
    // The last part usually holds "STATE ZIP" or "State"; the one before it is the city.
    const lastHasState = parseStateFromText(parts[parts.length - 1]) !== null;
    const cityIdx = lastHasState ? parts.length - 2 : parts.length - 1;
    if (cityIdx >= 0) city = parts[cityIdx] || null;
  }
  return { city: city || null, state };
}

export function normalizeCityName(city: string | null | undefined): string {
  return String(city ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when two city strings refer to the same (non-empty) place. */
export function citiesEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeCityName(a);
  const nb = normalizeCityName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Tolerate "St. Pete Beach" vs "Saint Petersburg Beach"-style containment.
  return (na.length >= 4 && nb.includes(na)) || (nb.length >= 4 && na.includes(nb));
}

export type ConfirmLocationInput = {
  communityName?: string | null;
  expectedCity?: string | null;
  expectedState?: string | null;
  /**
   * Other city/town names that count as the SAME place as expectedCity — e.g.
   * the curated `cityAliases` from shared/community-addresses.ts. Resort
   * communities routinely market under a locality different from their mailing
   * city (Poipu Kai's mailing city is "Koloa" but it markets as "Poipu";
   * The Cliffs at Princeville markets as Hanalei/Kilauea), so without these a
   * benign city difference would otherwise read as a conflict.
   */
  expectedCityAliases?: Array<string | null | undefined> | null;
  /** A positively-observed state (e.g. from Claude research or a scraped listing). */
  observedState?: string | null;
  observedCity?: string | null;
};

/**
 * Confirm a community/unit's location against what we expect.
 *
 * State signals, strongest first: the curated home state (community-location-guard)
 * > the observed state. The overall `status` is STATE-driven: we only flag
 * `mismatch` when a positively-known state contradicts the expected state — an
 * unknown location is never a mismatch, and a city-only difference is surfaced
 * as an informational aside (never a red verdict), because mailing-city vs
 * marketed-town differences are pervasive (pass `expectedCityAliases`).
 */
export function confirmCommunityLocation(input: ConfirmLocationInput): LocationConfirmation {
  const communityName = (input.communityName ?? "").trim() || null;
  const expectedState = input.expectedState ? canonicalStateName(input.expectedState) || null : null;
  const expectedCity = (input.expectedCity ?? "").trim() || null;
  const observedStateCanon = input.observedState ? canonicalStateName(input.observedState) || null : null;
  const observedCity = (input.observedCity ?? "").trim() || null;

  const homeState = communityName ? communityHomeState(communityName) : null;
  // Best read of the actual state: curated registry wins, then observed.
  const knownState = homeState ?? observedStateCanon ?? null;

  // ── State ──────────────────────────────────────────────────────────────────
  let stateStatus: LocationMatch;
  if (knownState && expectedState) {
    stateStatus = statesEquivalent(knownState, expectedState) ? "match" : "mismatch";
  } else {
    stateStatus = "unconfirmed";
  }
  const confirmedState = knownState ?? expectedState;

  // ── City (a secondary signal — NEVER the red verdict; see status below) ─────
  // observedCity counts as a match if it equals the expected city OR any curated
  // alias (mailing-city vs marketed-town equivalences).
  const acceptableCities = [expectedCity, ...(input.expectedCityAliases ?? [])]
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
  let cityStatus: LocationMatch;
  if (observedCity && acceptableCities.length > 0) {
    cityStatus = acceptableCities.some((c) => citiesEquivalent(observedCity, c)) ? "match" : "mismatch";
  } else {
    cityStatus = "unconfirmed";
  }
  const confirmedCity = observedCity ?? expectedCity;

  // ── Overall + note ───────────────────────────────────────────────────────--
  // STATE drives the verdict — that is the question the feature answers ("what
  // state is it in?"). A city-only divergence is informational and must NOT
  // raise a red "wrong state" alarm on a community whose state is correct,
  // because mailing-city vs marketed-town differences are pervasive here.
  const status: LocationMatch =
    stateStatus === "mismatch"
      ? "mismatch"
      : stateStatus === "match"
        ? "match"
        : "unconfirmed";

  const who = communityName ? `"${communityName}"` : "This location";
  const cityAside =
    cityStatus === "mismatch" && observedCity && expectedCity
      ? ` (Reported city ${observedCity} differs from ${expectedCity} — usually the same resort area.)`
      : "";
  let note: string;
  if (stateStatus === "mismatch") {
    note = `${who} is in ${knownState}, not ${expectedState}. ${homeState ? "Known mis-location" : "Observed location differs"} — fix the state before using these photos.`;
  } else if (stateStatus === "match") {
    note = (cityStatus === "mismatch"
      ? `Confirmed in ${confirmedState}.`
      : `Confirmed in ${confirmedCity ? `${confirmedCity}, ` : ""}${confirmedState}.`) + cityAside;
  } else if (expectedState) {
    note = `Listed in ${expectedCity ? `${expectedCity}, ` : ""}${expectedState}. No state conflict detected.` + cityAside;
  } else {
    note = "No state on record to confirm against.";
  }

  return {
    communityName,
    expectedState,
    expectedCity,
    confirmedState,
    confirmedCity,
    stateStatus,
    cityStatus,
    status,
    note,
  };
}
