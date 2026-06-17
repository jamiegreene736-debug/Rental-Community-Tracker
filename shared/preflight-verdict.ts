// Pure decision logic for the builder Pre-Flight "Full unit audit" verdict.
//
// The audit must answer YES (Listed) or NO (Clear), not "maybe". Two independent signals feed it:
//   • TEXT (PreflightTextResult.status): a site:-scoped Google search that confirms community,
//     location, and unit when discriminating enough.
//   • PHOTO (reverse-image of the unit's OWN interior photos): "found" = ≥2 verified hits on a
//     live listing; DEEP "clean" = full-gallery scan found no such listing.
//
// Full unit audit (requireDual): Listed requires BOTH text confirmed AND photo found. A photo-only
// hit (e.g. the same room staged in Texas) is NOT Listed — text must corroborate the community/unit.
// Units without a photo folder fall back to text-only (no photos to cross-check).
//
// Quick platform check (legacy): text confirmed → Listed; photo alone never upgrades to Listed.

export type PreflightVerdictStatus =
  | "confirmed"
  | "photo-confirmed"
  | "photo-only"
  | "unconfirmed"
  | "not-listed"
  | "error";

export type PreflightUnconfirmedReason = "generic-unit" | "unit-pinned" | "bedroom-conflict";

export type PreflightTextResult = {
  status: PreflightVerdictStatus;
  url: string | null;
  detection: string;
  reason?: PreflightUnconfirmedReason;
};

export type PreflightPhotoStatus = "clean" | "found" | "unknown";

export type MergeUnitVerdictOptions = {
  /** Full unit audit: YES only when text AND photo both confirm. */
  requireDual?: boolean;
  /** Photo scan still running — caller should show a checking state. */
  photoPending?: boolean;
  /** Unit has a local photo folder (dual rules apply when requireDual). */
  hasPhotoFolder?: boolean;
};

// A photo-listing-check row counts as DECISIVE evidence for a "clean" verdict only when it came from
// the deep Full-unit-audit (which scans the WHOLE deduped gallery). The hourly background scheduler
// scans only 3 photos — a 3-photo "clean" can easily miss the one room shot that's on a live listing,
// so it must NOT assert "this unit is not listed". We distinguish by the row's photosChecked: a count
// >= DEEP_PHOTO_MIN means a deep audit (or a fully-scanned small gallery).
export const DEEP_PHOTO_MIN = 4;

const dualListed = (text: PreflightTextResult): PreflightTextResult => ({
  status: "confirmed",
  url: text.url,
  detection: "Text search and reverse-image scan both confirm this unit is listed here.",
});

const notListed = (detection: string): PreflightTextResult => ({
  status: "not-listed",
  url: null,
  detection,
});

export function mergeUnitVerdict(
  text: PreflightTextResult | undefined,
  photoStatus: PreflightPhotoStatus | undefined,
  photoDeep: boolean,
  opts: MergeUnitVerdictOptions = {},
): PreflightTextResult | undefined {
  const { requireDual = false, photoPending = false, hasPhotoFolder = false } = opts;
  if (photoPending) return undefined;

  const textConfirmed = text?.status === "confirmed";
  const photoFound = photoStatus === "found";
  const photoClearDeep = photoStatus === "clean" && photoDeep;

  // ── Full unit audit: dual confirmation when photos exist ─────────────────────
  if (requireDual && hasPhotoFolder) {
    if (textConfirmed && photoFound) return dualListed(text!);
    if (photoFound && !textConfirmed) {
      return notListed(
        "Photos matched a listing on this platform, but text search did not confirm this unit at this community.",
      );
    }
    if (textConfirmed && photoClearDeep) {
      return notListed(
        "Text suggested a listing, but a full photo scan did not find this unit's interior photos on that platform.",
      );
    }
    if (text?.status === "not-listed") return text;
    if (photoClearDeep) {
      return notListed("A full reverse-image scan found no listing of this unit on this platform.");
    }
    return notListed(text?.detection || "No listing confirmed by both text search and photo scan.");
  }

  // ── Legacy quick platform check (text-primary) ───────────────────────────────
  if (!text) {
    // Photo-only is never Listed — not even before text lands.
    if (photoFound) {
      return notListed("Photos matched a listing, but text search has not confirmed this unit.");
    }
    if (photoClearDeep) {
      return notListed("A full reverse-image scan of this unit's photos found no listing of it.");
    }
    return text;
  }
  if (text.status === "confirmed") return text;
  if (photoFound) {
    return notListed(
      "Photos matched a listing on this platform, but text search did not confirm this unit at this community.",
    );
  }
  if (text.status === "photo-only") {
    if (photoClearDeep) {
      return notListed("A full reverse-image scan of every interior photo found no matching listing here.");
    }
    return notListed(text.detection || "Photo signal alone is not sufficient without text confirmation.");
  }
  if (text.status === "unconfirmed") {
    if (photoClearDeep) {
      return notListed("No verified listing match for this unit.");
    }
    return notListed(text.detection || "No verified listing match for this unit.");
  }
  if (text.status === "not-listed") return text;
  if (photoClearDeep) {
    return notListed(
      "A full reverse-image scan of every interior photo found no listing of this unit — the resort itself is listed, as always, but this specific unit was not.",
    );
  }
  return notListed(text.detection || "No verified listing match for this unit.");
}
