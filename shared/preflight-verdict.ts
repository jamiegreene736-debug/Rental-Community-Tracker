// Pure decision logic for the builder Pre-Flight "Full unit audit" verdict.
//
// The audit must answer YES (Listed) or NO (Clear), not "maybe". Two independent signals feed it:
//   • TEXT (PreflightTextResult.status): a site:-scoped Google search. It can CONFIRM a unit whose
//     number is discriminating, but for a short / single-letter / empty unit number it only ever
//     reaches "unconfirmed" — it finds the COMMUNITY but can't pin the UNIT. That is the "Possible
//     Match — Check Manually" maybe the operator wants gone.
//   • PHOTO (reverse-image of the unit's OWN interior photos): "found" = ≥2 of those photos were
//     verified (server-side) on a live listing that names the unit — a decisive YES at any depth; a
//     DEEP "clean" = a full-gallery scan surfaced no such listing; "unknown"/undefined = couldn't check.
//
// mergeUnitVerdict merges them so the photo result — the only signal that can resolve a short-number
// unit — drives the verdict when text is inconclusive. Guardrails (each prevents a FALSE verdict):
//   • A verified photo MATCH ("found") is a definitive YES (the server requires ≥2 verified hits).
//   • A "clean" is decisive ONLY when DEEP (full-gallery). A shallow background 3-photo "clean" never
//     overrides text — it leaves the honest text verdict, so we never assert a false "Clear".
//   • A text "unconfirmed" that PINNED a concrete per-unit listing (reason "unit-pinned"/"bedroom-
//     conflict") stays "Review" with its link — a clean photo scan must not erase a real listing the
//     text located (it could be this same unit shot with different photos). A "generic-unit"
//     unconfirmed only proves the RESORT is listed, so a deep clean MAY resolve it to Clear.
//   • "clean" means "this unit's OWN photos weren't found", NOT "the unit is unlisted" — so the
//     deep-clean copy is honest (resort is listed; this unit wasn't found) and avoids over-claiming.
//
// Extracted from client/src/pages/builder-preflight.tsx so it is unit-testable
// (tests/preflight-verdict.test.ts) and shareable. Zero dependencies.

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

// A photo-listing-check row counts as DECISIVE evidence for a "clean" verdict only when it came from
// the deep Full-unit-audit (which scans the WHOLE deduped gallery). The hourly background scheduler
// scans only 3 photos — a 3-photo "clean" can easily miss the one room shot that's on a live listing,
// so it must NOT assert "this unit is not listed". We distinguish by the row's photosChecked: a count
// >= DEEP_PHOTO_MIN means a deep audit (or a fully-scanned small gallery).
export const DEEP_PHOTO_MIN = 4;

export function mergeUnitVerdict(
  text: PreflightTextResult | undefined,
  photoStatus: PreflightPhotoStatus | undefined,
  photoDeep: boolean,
): PreflightTextResult | undefined {
  const photoFound = photoStatus === "found";                  // ≥2 verified matches — strong YES at any depth
  const photoClearDeep = photoStatus === "clean" && photoDeep; // thorough no-match — decisive NO

  // Photo signal alone can be decisive even before the text result lands.
  if (!text) {
    if (photoFound) return { status: "photo-confirmed", url: null, detection: "This unit's interior photos appear on a live listing here." };
    if (photoClearDeep) return { status: "not-listed", url: null, detection: "A full reverse-image scan of this unit's photos found no listing of it." };
    return text;
  }
  // 1. Strong text confirmation — highest-confidence YES (community + pinned unit + consistent beds).
  if (text.status === "confirmed") return text;
  // 2. A verified photo match is a definitive YES regardless of what text could pin.
  if (photoFound) {
    return { status: "photo-confirmed", url: text.url, detection: "This unit's interior photos were found on a live listing here." };
  }
  // 3. Inline text photo-match ("photo-only", a real photo match) → YES, unless a deep scan clears it.
  if (text.status === "photo-only") {
    if (photoClearDeep) return { status: "not-listed", url: null, detection: "A full reverse-image scan of every interior photo found no matching listing here." };
    return { status: "photo-confirmed", url: text.url, detection: text.detection || "This unit's interior photos were found on a live listing here." };
  }
  // 4. Text located a concrete PER-UNIT listing it couldn't fully confirm (pinned the unit token, or a
  //    bedroom mismatch on a real listing page). Keep "Review" WITH the link; never erase it, even on a
  //    clean photo scan. A "generic-unit" unconfirmed only proves the RESORT is listed (not this unit),
  //    so it is NOT preserved here — a deep clean scan can resolve it to Clear below.
  if (text.status === "unconfirmed" && text.url && text.reason !== "generic-unit") return text;
  // 5. Text already says NO (unit token absent) — a clean photo scan just reinforces it.
  if (text.status === "not-listed") return text;
  // 6. Community-present "unconfirmed" (or an errored text) with a DEEP clean scan → confident NO,
  //    worded honestly: the resort is listed (it always is) but no listing of THIS unit was found.
  if (photoClearDeep) {
    return { status: "not-listed", url: null, detection: "A full reverse-image scan of every interior photo found no listing of this unit — the resort itself is listed, as always, but this specific unit was not." };
  }
  // 7. No decisive signal (shallow/unknown photos, or photos not checked) → keep the honest text
  //    verdict. "unconfirmed" stays "Review" — the only remaining maybe, now rare after a full audit.
  return text;
}
