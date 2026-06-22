// Community-photo curation — the deterministic "keep the 10 best COMMUNITY
// FEATURE photos" selector used at the tail of the Pre-Flight "Re-pull community
// photos" pipeline.
//
// The operator's ask: the community folder should hold AT MOST a handful of
// photos and EVERY one should be a real shared community amenity (pool, grounds,
// clubhouse, building exterior, aerial…) — NOT a photo taken inside a private
// rental unit, and NOT a different resort that happens to share the name/town.
//
// Two independent signals feed this selector:
//   • amenity classification (Claude vision in community-photo-repull.ts, or a
//     caption-keyword fallback): is the photo a community AMENITY, a unit
//     INTERIOR, or OTHER junk (map / floor-plan / logo / screenshot / person)?
//     plus a `belongs` hint (does it depict THIS community?).
//   • community verdict (the existing Google-Lens + vision verifier): "yes" /
//     "no" / "uncertain" that the photo is this exact community.
//
// This module is PURE (no I/O) so the keep/drop decision is unit-testable and
// deterministic. The caller is responsible for actually deleting the dropped
// files from disk.

/** What the photo depicts. */
export type AmenityCategory = "amenity" | "interior" | "other";

/** Whether the photo depicts the EXPECTED community (vs a different resort). */
export type BelongsVerdict = "yes" | "no" | "unsure";

/** Per-photo community match from the Lens + vision verifier. */
export type CommunityVerdict = "yes" | "no" | "uncertain";

/** One photo offered to the curator, with both signals already merged in. */
export type CuratableCommunityPhoto = {
  /** Stable sample id (e.g. "C3"). */
  id: string;
  /** Image basename on disk (e.g. "07-community.jpg"). */
  filename: string;
  /** What the photo depicts (community amenity vs unit interior vs junk). */
  category: AmenityCategory;
  /** Does the amenity classifier think this is THIS community? */
  belongs: BelongsVerdict;
  /** Per-photo verdict from the reverse-image + vision verifier, if available. */
  communityVerdict?: CommunityVerdict;
  /** 0-100 confidence that this is a genuine, useful community-feature photo. */
  confidence: number;
  /** Short human-readable reason from the classifier (for diagnostics). */
  reason?: string;
};

export type CurationDrop = {
  filename: string;
  reason: string;
};

export type CurationResult = {
  /** Filenames to KEEP, best first (≤ max). */
  keep: string[];
  /** Filenames to DELETE, each with a reason. */
  drop: CurationDrop[];
  keptCount: number;
  droppedCount: number;
};

export const DEFAULT_MAX_COMMUNITY_PHOTOS = 10;

const DROP_INTERIOR = "Unit interior — not a shared community feature.";
const DROP_OTHER =
  "Not a community feature (map, floor plan, logo, screenshot, or unrelated image).";
const DROP_DIFFERENT = "Appears to be a different community.";
const dropOverCap = (max: number) =>
  `Over the ${max}-photo community limit (kept the strongest matches).`;

/**
 * A photo is ELIGIBLE to keep only when it is a genuine community amenity that
 * isn't positively flagged as a different place. This is the rule that makes the
 * kept set "100% community features": interiors and junk are never eligible, and
 * a positive different-community verdict (from EITHER signal) is excluded.
 *
 * Note: `belongs === "unsure"` and `communityVerdict === "uncertain"` stay
 * eligible on purpose — the Lens logic deliberately downgrades same-area sibling
 * resorts (which share real amenities) to inconclusive rather than deleting a
 * legitimate, just-not-well-indexed community photo (see AGENTS.md #45).
 */
function isEligible(p: CuratableCommunityPhoto): boolean {
  if (p.category !== "amenity") return false;
  if (p.belongs === "no") return false;
  if (p.communityVerdict === "no") return false;
  return true;
}

/** Reason an INELIGIBLE photo is dropped (most-specific cause first). */
function ineligibleReason(p: CuratableCommunityPhoto): string {
  if (p.category === "interior") return DROP_INTERIOR;
  if (p.category === "other") return DROP_OTHER;
  // category === "amenity" but flagged as a different place.
  return DROP_DIFFERENT;
}

/**
 * Higher tier = more desirable. Both signals agreeing it's this community beats
 * a single positive signal, which beats "neither contradicts but neither
 * positively confirms".
 */
function desirabilityTier(p: CuratableCommunityPhoto): number {
  const belongsYes = p.belongs === "yes";
  const verdictYes = p.communityVerdict === "yes";
  if (belongsYes && verdictYes) return 3;
  if (belongsYes || verdictYes) return 2;
  return 1;
}

/**
 * Select the ≤max strongest community-FEATURE photos to keep, dropping everything
 * else (interiors, junk, different-community, and anything past the cap).
 *
 * Deterministic: ties break by confidence desc, then filename asc, so the same
 * input always yields the same keep/drop split.
 */
export function selectCommunityPhotosToKeep(
  photos: CuratableCommunityPhoto[],
  options: { max?: number } = {},
): CurationResult {
  const max = Math.max(0, options.max ?? DEFAULT_MAX_COMMUNITY_PHOTOS);

  const eligible: CuratableCommunityPhoto[] = [];
  const drop: CurationDrop[] = [];

  // A photo with no usable filename can't be kept or deleted by the caller.
  for (const p of photos) {
    if (!p.filename) continue;
    if (isEligible(p)) eligible.push(p);
    else drop.push({ filename: p.filename, reason: ineligibleReason(p) });
  }

  eligible.sort((a, b) => {
    const tierDiff = desirabilityTier(b) - desirabilityTier(a);
    if (tierDiff !== 0) return tierDiff;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.filename.localeCompare(b.filename);
  });

  const keep = eligible.slice(0, max).map((p) => p.filename);
  for (const p of eligible.slice(max)) {
    drop.push({ filename: p.filename, reason: dropOverCap(max) });
  }

  return {
    keep,
    drop,
    keptCount: keep.length,
    droppedCount: drop.length,
  };
}
