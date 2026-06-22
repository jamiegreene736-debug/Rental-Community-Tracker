// ─── COMMUNITY LOCATION GUARD ────────────────────────────────────────────────
// Some resort/community names are famous enough that the world-knowledge LLM
// research (server/community-research.ts) will surface them for a market even
// when the resort is physically in a DIFFERENT state — and an operator can save
// them under the wrong state from the Add-a-Community wizard.
//
// The reported case (2026-06-22): "Bay Watch" is a North Myrtle Beach, SOUTH
// CAROLINA oceanfront condo resort, but it kept appearing under FLORIDA in the
// Top Markets Sweep and was saved as a Florida community draft (property
// 900039 / draft 39). Attaching a community to the wrong state corrupts pricing
// areas, address discovery, buy-in markets, and the sweep grid.
//
// This module is a deterministic, curated guard. Any community whose canonical
// name is registered in COMMUNITY_HOME_STATE may ONLY be attached to its real
// home state — regardless of what the LLM returns or an operator types. It is
// the authoritative backstop that makes a KNOWN mis-location impossible to
// recur. New cross-state collisions are additionally discouraged by the
// state-locality rule in the research prompts; any that slip through can be
// permanently fixed by adding one line to COMMUNITY_HOME_STATE.
//
// Design choice — recall-safe / no false positives: an UNKNOWN community (not
// in the registry) is NEVER flagged. We only ever drop/reject a community we
// positively know belongs to a different state. So legitimate communities are
// untouched; the guard can only remove a genuine mistake.

/**
 * Canonical real-world home state (full name) for community/resort names that
 * are commonly mis-attached to the wrong market. Keyed by
 * `normalizeCommunityLocationKey(name)`.
 *
 * Add an entry whenever a community is found attached to a state it does not
 * physically sit in. Keep values as canonical FULL state names (see
 * STATE_ABBREVIATIONS) so `statesEquivalent` matches both "FL" and "Florida".
 */
export const COMMUNITY_HOME_STATE: Record<string, string> = {
  // Bay Watch Resort & Conference Center — North Myrtle Beach, South Carolina.
  // NOT a Florida community; do not surface it for any Florida market.
  "bay watch": "South Carolina",
};

const STATE_ABBREVIATIONS: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California",
  co: "Colorado", ct: "Connecticut", de: "Delaware", fl: "Florida", ga: "Georgia",
  hi: "Hawaii", id: "Idaho", il: "Illinois", in: "Indiana", ia: "Iowa",
  ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine", md: "Maryland",
  ma: "Massachusetts", mi: "Michigan", mn: "Minnesota", ms: "Mississippi",
  mo: "Missouri", mt: "Montana", ne: "Nebraska", nv: "Nevada", nh: "New Hampshire",
  nj: "New Jersey", nm: "New Mexico", ny: "New York", nc: "North Carolina",
  nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania",
  ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee",
  tx: "Texas", ut: "Utah", vt: "Vermont", va: "Virginia", wa: "Washington",
  wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming", dc: "District of Columbia",
};

const FULL_STATE_NAMES = new Set(
  Object.values(STATE_ABBREVIATIONS).map((s) => s.toLowerCase()),
);

/**
 * Normalize a state string to its canonical full name. Accepts a USPS
 * abbreviation ("fl", "FL"), a full name in any case ("florida"), or an unknown
 * value (returned trimmed, as typed). Empty/blank → "".
 */
export function canonicalStateName(state: string | null | undefined): string {
  const raw = String(state ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (STATE_ABBREVIATIONS[lower]) return STATE_ABBREVIATIONS[lower];
  if (FULL_STATE_NAMES.has(lower)) {
    // Re-emit the canonical capitalization from the abbreviation table.
    for (const full of Object.values(STATE_ABBREVIATIONS)) {
      if (full.toLowerCase() === lower) return full;
    }
  }
  return raw;
}

/** True when two state strings refer to the same (known, non-empty) state. */
export function statesEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ca = canonicalStateName(a).toLowerCase();
  const cb = canonicalStateName(b).toLowerCase();
  return ca !== "" && ca === cb;
}

/**
 * Normalize a community name to a registry key: lowercase, strip punctuation,
 * drop a leading "the", and strip ONE trailing generic descriptor so that
 * "Bay Watch Resort" and "Bay Watch" collapse to the same key ("bay watch").
 */
export function normalizeCommunityLocationKey(name: string | null | undefined): string {
  let s = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  s = s.replace(/^the\s+/, "");
  s = s.replace(
    /\s+(resorts?|condominiums?|condos?|townhomes?|townhouses?|villas?)$/,
    "",
  ).trim();
  return s;
}

/** The known real-world home state (canonical full name) for a community name,
 *  or null when the community is not in the curated registry. */
export function communityHomeState(name: string | null | undefined): string | null {
  const key = normalizeCommunityLocationKey(name);
  if (!key) return null;
  return COMMUNITY_HOME_STATE[key] ?? null;
}

export type CommunityStateVerdict = {
  /** True only when we KNOW this community's home state and it differs from the
   *  claimed state. False for unknown communities (recall-safe). */
  wrong: boolean;
  /** Canonical home state when the community is in the registry, else null. */
  homeState: string | null;
};

/**
 * Verdict on whether `name` is being attached to the wrong state.
 *
 * Conservative: `wrong` is true ONLY when the community is in the curated
 * registry AND the claimed state differs from its home state. Unknown
 * communities, or a blank claimed state, are never flagged.
 */
export function checkCommunityState(
  name: string | null | undefined,
  claimedState: string | null | undefined,
): CommunityStateVerdict {
  const homeState = communityHomeState(name);
  if (!homeState) return { wrong: false, homeState: null };
  const claimed = canonicalStateName(claimedState);
  if (!claimed) return { wrong: false, homeState };
  return { wrong: !statesEquivalent(homeState, claimed), homeState };
}

/** Convenience boolean wrapper around {@link checkCommunityState}. */
export function isCommunityInWrongState(
  name: string | null | undefined,
  claimedState: string | null | undefined,
): boolean {
  return checkCommunityState(name, claimedState).wrong;
}
