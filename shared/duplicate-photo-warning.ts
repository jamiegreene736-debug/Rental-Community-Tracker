// Duplicate-photos warning popup logic (dashboard).
//
// When the photo-listing scanner marks a unit's photos as FOUND on
// Airbnb / VRBO / Booking.com, the dashboard raises a red warning dialog
// (same visual language as the refund-receipt alert). The operator's
// remediation is manual — replace the photos on the listing — so the
// dialog's action is "Confirm photos replaced", which fires a deep
// verification rescan of just that unit's folder and then reports
// whether the replaced photos are genuinely gone from all three OTAs.
//
// Pure helpers only: signature (so a dismissed warning doesn't nag until
// the facts change) and the rescan verdict state machine. The React side
// in client/src/pages/home.tsx owns fetching and rendering.

export type DuplicatePhotoPlatform = "airbnb" | "vrbo" | "booking";
export type DuplicatePhotoStatus = "clean" | "found" | "unknown";

export const DUPLICATE_PHOTO_PLATFORMS: DuplicatePhotoPlatform[] = ["airbnb", "vrbo", "booking"];

export const DUPLICATE_PHOTO_PLATFORM_LABELS: Record<DuplicatePhotoPlatform, string> = {
  airbnb: "Airbnb",
  vrbo: "VRBO",
  booking: "Booking.com",
};

export function formatDuplicatePhotoPlatforms(platforms: DuplicatePhotoPlatform[]): string {
  return platforms.map((p) => DUPLICATE_PHOTO_PLATFORM_LABELS[p]).join(" / ");
}

export type DuplicatePhotoUnitFacts = {
  folder: string;
  platforms: DuplicatePhotoPlatform[];
  // checkedAt of the scan row that produced the FOUND verdict. Including it
  // means a LATER scan that still finds duplicates re-raises a dismissed
  // warning (the facts are fresh), while mere page reloads stay quiet.
  checkedAt?: string | null;
};

// Order-independent signature of the current duplicate-photo facts.
// Persisted on dismiss; the popup only auto-reopens when the signature
// changes (new unit flagged, platform set changed, or a fresh scan
// re-confirmed the duplicates).
export function duplicatePhotoWarningSignature(units: DuplicatePhotoUnitFacts[]): string {
  if (units.length === 0) return "";
  return units
    .map((u) => `${u.folder}|${[...u.platforms].sort().join(",")}|${u.checkedAt ?? ""}`)
    .sort()
    .join(";");
}

export type DuplicateListingLink = {
  platform: DuplicatePhotoPlatform;
  url: string;
  title: string;
};

// Flatten the per-platform Lens match rows into de-duped, clickable links to
// the actual OTA listings hosting the duplicated photos. The scanner has
// ALREADY suppressed our own Guesty-authorized listing URLs (see
// server/authorized-urls.ts), so every URL here is a listing that is NOT
// ours. Multiple photos usually match the same thief listing — de-dupe by
// URL so the popup shows one link per offending listing, platform-ordered
// (Airbnb, VRBO, Booking.com). `limit` caps the rendered list; `more` is the
// count of links beyond it.
export function collectDuplicateListingLinks(
  matches: Partial<Record<DuplicatePhotoPlatform, Array<{ listingUrl?: string | null; title?: string | null }> | null | undefined>>,
  limit = 6,
): { links: DuplicateListingLink[]; more: number } {
  const links: DuplicateListingLink[] = [];
  const seen = new Set<string>();
  for (const platform of DUPLICATE_PHOTO_PLATFORMS) {
    for (const m of matches[platform] ?? []) {
      const url = (m.listingUrl ?? "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      // Normalize just enough that the same listing with/without a query
      // string or trailing slash collapses to one link.
      const key = url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ platform, url, title: (m.title ?? "").trim() || url });
    }
  }
  return { links: links.slice(0, limit), more: Math.max(0, links.length - limit) };
}

export type PhotoReplaceRescanVerdict =
  | { state: "pending" }
  | { state: "clean" }
  | { state: "still_found"; platforms: DuplicatePhotoPlatform[] }
  | { state: "inconclusive"; platforms: DuplicatePhotoPlatform[] };

// Classify a "Confirm photos replaced" verification rescan from the
// (re-fetched) photo-check row. `pending` until the row's checkedAt passes
// the rescan start (1s tolerance, mirroring the deep-scan progress modal —
// the server stamps checkedAt from its own clock). A verdict is only
// `clean` when ALL THREE platforms come back clean; any FOUND wins over
// inconclusive so the operator is never shown a soft verdict while a
// platform still hosts the photos.
export function photoReplaceRescanVerdict(input: {
  rescanStartedAtMs: number;
  checkedAt: string | null | undefined;
  statuses: Partial<Record<DuplicatePhotoPlatform, DuplicatePhotoStatus | null | undefined>>;
}): PhotoReplaceRescanVerdict {
  const checkedMs = input.checkedAt ? Date.parse(input.checkedAt) : NaN;
  if (!Number.isFinite(checkedMs) || checkedMs < input.rescanStartedAtMs - 1000) {
    return { state: "pending" };
  }
  const stillFound = DUPLICATE_PHOTO_PLATFORMS.filter((p) => input.statuses[p] === "found");
  if (stillFound.length > 0) return { state: "still_found", platforms: stillFound };
  const inconclusive = DUPLICATE_PHOTO_PLATFORMS.filter((p) => (input.statuses[p] ?? "unknown") !== "clean");
  if (inconclusive.length > 0) return { state: "inconclusive", platforms: inconclusive };
  return { state: "clean" };
}
