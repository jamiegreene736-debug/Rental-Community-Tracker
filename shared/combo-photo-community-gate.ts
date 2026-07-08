// Pure decision logic for the bulk combo-listing "photo-community" pre-publish
// gate — no DB / vision / fs dependencies, so it is unit-testable.
//
// The bulk combo queue runs the SAME "Check photo community" engine the operator
// runs by hand on the pricing tab (server/photo-community-check.ts →
// runPhotoCommunityCheck), then feeds the result here to decide PUBLISH vs SKIP
// for one resort, before the listing is finalized.
//
// LOAD-BEARING POSTURE (operator decision, 2026-06-26): the gate SKIPS a resort
// ONLY when the check POSITIVELY identifies a problem; it NEVER skips on the mere
// absence of proof. Concretely:
//   • Skip on a REAL community mismatch ("mismatch"), NOT on "unconfirmed" /
//     "likely" — those mean Google Lens was inconclusive (a legit resort that
//     just isn't indexed online), and skipping them would drop valid resorts.
//   • Skip a unit ONLY on a STRONG contradiction (wrong resort signage / wrong
//     community / incompatible climate), NOT on "too few interior photos to tell".
//   • Skip on a SHORT bedroom count that misses MORE THAN ONE bedroom (e.g. a
//     1BR sourced for a 3BR slot). Tolerate a SINGLE missing bedroom (2 of 3) —
//     vision routinely under-counts a genuine unit by one because the sourced
//     gallery does not always picture every bedroom (operator decision 2026-07-08).
//   • IGNORE bed-TYPE inventory entirely — a mislabeled queen or a missing
//     sleeper sofa is already stripped upstream (shared/photo-bedroom-coverage-
//     logic.ts) and must never reach a skip here. That is why the caller passes
//     FOLDER-ONLY groups (no captions / expectedBedInventory) to the check.
//   • Treat a key-missing / no-photos / check-threw situation as INFRA and
//     PUBLISH (fail-open), so an API outage can't silently skip an entire batch.

import { isStrongContradiction } from "./photo-community-check-logic";

/**
 * Warnings runPhotoCommunityCheck returns from an early-out when it could not
 * actually run (these are returned verbatim, never concatenated). A later,
 * partial-failure warning is a longer free-text string and is NOT treated as
 * infra here — those paths leave community/bedroomCoverage null or a unit "no"
 * with a non-contradiction reason, which the predicate already declines to skip.
 */
const INFRA_WARNINGS = new Set<string>([
  "no-photos",
  "SEARCHAPI_API_KEY not configured",
  "ANTHROPIC_API_KEY not configured",
]);

export function isComboPhotoGateInfraWarning(warning?: string | null): boolean {
  if (!warning) return false;
  return INFRA_WARNINGS.has(warning.trim());
}

export type ComboPhotoGateCommunity = {
  matchesExpected: "yes" | "no";
  overallStatus?: string;
  identifiedCommunity?: string;
} | null;

export type ComboPhotoGateUnit = {
  label: string;
  sameAsCommunity: "yes" | "no";
  reason: string;
};

export type ComboPhotoGateBedroomUnit = {
  label: string;
  matchesListing: "yes" | "no" | "n/a";
  bedroomsFound: number;
  expectedBedrooms: number | null;
};

export type ComboPhotoGateBedroomCoverage = {
  tier: "pass" | "warn" | "fail";
  units: ComboPhotoGateBedroomUnit[];
} | null;

export type ComboPhotoGateInput = {
  expectedCommunity?: string;
  warning?: string | null;
  community: ComboPhotoGateCommunity;
  units: ComboPhotoGateUnit[];
  bedroomCoverage: ComboPhotoGateBedroomCoverage;
  /**
   * Whether the bedroom-coverage result can be trusted for a SKIP. The coverage
   * engine selects candidate bedroom photos BY caption/category from photo_labels,
   * which the bulk-combo caller writes ASYNCHRONOUSLY after a fresh draft's photos
   * are persisted. Before those labels land, EVERY unit reports 0/N bedrooms — an
   * infra/timing artifact, NOT a positive short-count. The caller passes `false`
   * until it has waited for labeling to finish; a `false` value suppresses the
   * bedroom-count skip (the community + unit checks above, which read the images
   * directly and need no labels, still apply). Undefined defaults to reliable so
   * the pricing-tab path and existing tests are unaffected. Root-caused 2026-07-07:
   * the queue silently deleted every fresh combo draft on a uniform 0/N produced by
   * labels that had not been written when the gate ran.
   */
  bedroomCoverageReliable?: boolean;
};

export type ComboPhotoGateDecision = {
  decision: "publish" | "skip";
  /** True when the check could not produce a real verdict (publish anyway). */
  infra: boolean;
  /** Human-readable reasons — only populated on a skip. */
  reasons: string[];
};

/**
 * A community verdict counts as a REAL mismatch only when it is positively
 * wrong. Mirrors the `communityHardFail` rule in server/photo-community-check.ts
 * (`overallStatus === "mismatch" || (matchesExpected === "no" && status not in
 * {unconfirmed, likely})`) so the gate and the engine agree on "real mismatch".
 */
export function communityIsRealMismatch(community: ComboPhotoGateCommunity): boolean {
  if (!community) return false;
  if (community.overallStatus === "mismatch") return true;
  return (
    community.matchesExpected === "no" &&
    community.overallStatus !== "unconfirmed" &&
    community.overallStatus !== "likely"
  );
}

/**
 * Loose "is the identified community the one we expected?" — tolerant of casing,
 * punctuation, and one name being a phrase-subset of the other ("Kanaloa at Kona"
 * vs "Kanaloa"). Used only to suppress a self-contradicting "looks like X, not X".
 */
function sameCommunityName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || ` ${na} `.includes(` ${nb} `) || ` ${nb} `.includes(` ${na} `);
}

/**
 * How many bedrooms a unit may be SHORT in its photos and still publish. Vision
 * commonly detects one fewer bedroom than a genuine unit has — the sourced
 * gallery simply does not always picture every bedroom — which was skipping
 * nearly every resort ("Unit A (3BR) shows only 2/3 bedrooms …"). At 1, a unit
 * passes when it shows all-but-one of its bedrooms (2 of 3); a unit missing 2+
 * bedrooms (1 of 3, or a 1BR sourced for a 3BR slot) still skips. Operator
 * decision, 2026-07-08.
 */
const MAX_BEDROOM_SHORTFALL = 1;

function expectedCommunityLabel(input: ComboPhotoGateInput): string {
  return (input.expectedCommunity ?? "").trim() || "the expected community";
}

/**
 * (a) The community photo folder is the correct community. Returns the skip
 * reason, or null when the community leg does not skip. Belt-and-suspenders:
 * never emit a self-contradicting "looks like X, not X" (a dHash pre-screen
 * false-positive on diverse amenity photos that slips through) — publish instead.
 */
function communitySkipReason(input: ComboPhotoGateInput): string | null {
  if (!communityIsRealMismatch(input.community)) return null;
  const expected = expectedCommunityLabel(input);
  const idd = input.community?.identifiedCommunity?.trim();
  if (idd && sameCommunityName(idd, expected)) return null;
  return idd
    ? `community photos look like ${idd}, not ${expected}`
    : `community photos do not match ${expected}`;
}

/**
 * (b)/(c) Each unit is in that community — only a STRONG contradiction skips. A
 * unit "no" caused by too few interior photos (insufficient evidence) is NOT a
 * positive finding and must publish.
 */
function unitContradictionReasons(input: ComboPhotoGateInput): string[] {
  const expected = expectedCommunityLabel(input);
  const out: string[] = [];
  for (const u of input.units ?? []) {
    if (u.sameAsCommunity === "no" && isStrongContradiction(u.reason)) {
      out.push(`${u.label} is not from ${expected} (${u.reason})`);
    }
  }
  return out;
}

/**
 * (d) Units whose photos do NOT cover their bedroom count beyond the tolerance.
 * matchesListing "no" fires exactly when bedroomsFound < expectedBedrooms
 * (bed-TYPE inventory does not affect this). A unit is only surfaced here when it
 * is short by MORE THAN MAX_BEDROOM_SHORTFALL bedrooms — a unit that shows
 * all-but-one of its bedrooms (2 of 3, or 1 of 2 for a 4BR combo) publishes,
 * because vision routinely under-counts a genuine unit by one; a unit missing 2+
 * (1 of 3, or a 1BR sourced for a 3BR slot) is still caught. Trustworthy ONLY
 * when the unit photos were actually labeled — with `bedroomCoverageReliable ===
 * false` (labels not yet written) a 0/N is an infra artifact and is ignored (see
 * the field's doc + the 2026-07-07 root cause).
 */
function bedroomShortUnits(input: ComboPhotoGateInput): ComboPhotoGateBedroomUnit[] {
  const bc = input.bedroomCoverage;
  if (!bc || input.bedroomCoverageReliable === false) return [];
  const out: ComboPhotoGateBedroomUnit[] = [];
  for (const u of bc.units ?? []) {
    if (
      u.matchesListing === "no" &&
      u.expectedBedrooms != null &&
      u.expectedBedrooms - u.bedroomsFound > MAX_BEDROOM_SHORTFALL
    ) {
      out.push(u);
    }
  }
  return out;
}

export function evaluateComboPhotoCommunityGate(input: ComboPhotoGateInput): ComboPhotoGateDecision {
  // Fail-open: the check could not run → publish (never skip a whole batch on an
  // ops problem like a missing API key or an empty community folder).
  if (isComboPhotoGateInfraWarning(input.warning)) {
    return { decision: "publish", infra: true, reasons: [] };
  }

  // Order preserved (community → unit-contradiction → bedroom-short) so existing
  // callers/tests see the same reason list they always have.
  const reasons: string[] = [];
  const community = communitySkipReason(input);
  if (community) reasons.push(community);
  reasons.push(...unitContradictionReasons(input));
  for (const u of bedroomShortUnits(input)) {
    reasons.push(`${u.label} shows only ${u.bedroomsFound}/${u.expectedBedrooms} bedrooms in its photos`);
  }

  return reasons.length > 0
    ? { decision: "skip", infra: false, reasons }
    : { decision: "publish", infra: false, reasons: [] };
}

export type ComboBedroomRetryUnit = {
  /** Which combo slot this failing unit maps to (drives which folder to re-source). */
  slot: "unit1" | "unit2";
  label: string;
  bedroomsFound: number;
  expectedBedrooms: number;
};

export type ComboBedroomRetryPlan = {
  /**
   * True iff the gate would SKIP and the ONLY reason is bedroom-photo coverage —
   * i.e. no community mismatch and no strong unit contradiction. Those other
   * skips are NOT fixed by trying another for-sale candidate (operator decision
   * 2026-07-08: retry on bedroom photos only), so they keep the plain skip.
   */
  retryable: boolean;
  /** The bedroom-short units to re-source (empty when not retryable). */
  units: ComboBedroomRetryUnit[];
};

/** "Unit A (3BR)" → "unit1", "Unit B" → "unit2", anything else → null. */
function slotFromUnitLabel(label: string): "unit1" | "unit2" | null {
  const m = /unit\s*([ab])/i.exec(label);
  if (!m) return null;
  return m[1].toLowerCase() === "a" ? "unit1" : "unit2";
}

/**
 * Decide whether a would-be SKIP is recoverable by re-sourcing the failing
 * unit(s) from another for-sale candidate, and which slots need it. Used by the
 * bulk combo queue to "move on to another opportunity unit" when a unit's photos
 * don't cover its bedrooms, instead of skipping the whole resort. Pure so the
 * decision is unit-testable; the caller owns the re-source / re-persist loop.
 */
export function planComboBedroomRetry(input: ComboPhotoGateInput): ComboBedroomRetryPlan {
  // An infra publish is never a skip → nothing to retry.
  if (isComboPhotoGateInfraWarning(input.warning)) return { retryable: false, units: [] };
  const shortUnits = bedroomShortUnits(input);
  if (shortUnits.length === 0) return { retryable: false, units: [] };
  // Retry ONLY when bedrooms are the sole problem — a wrong community folder /
  // wrong-community unit is not fixed by swapping a for-sale candidate.
  const bedroomOnly = !communitySkipReason(input) && unitContradictionReasons(input).length === 0;
  const units: ComboBedroomRetryUnit[] = [];
  for (const u of shortUnits) {
    const slot = slotFromUnitLabel(u.label);
    if (!slot || u.expectedBedrooms == null) continue;
    units.push({ slot, label: u.label, bedroomsFound: u.bedroomsFound, expectedBedrooms: u.expectedBedrooms });
  }
  return { retryable: bedroomOnly && units.length > 0, units };
}
