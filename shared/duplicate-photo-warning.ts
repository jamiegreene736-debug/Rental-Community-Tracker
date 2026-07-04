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

export type DuplicatePhotoMatchRow = {
  listingUrl?: string | null;
  title?: string | null;
  // OUR photo that Lens matched on that listing — the scanner stamps it as
  // `<host>/photos/<folder>/<filename>` (photo-listing-scanner.ts).
  photoUrl?: string | null;
};

export type DuplicateListingLink = {
  platform: DuplicatePhotoPlatform;
  url: string;
  title: string;
  // De-duped list of OUR matched photo URLs for this listing, so the popup
  // can show exactly WHICH photos were found there (thumbnails).
  matchedPhotoUrls: string[];
};

// Extract the photo filename out of a scanner match photoUrl
// ("https://host/photos/mauna-kai-t3/07-master.jpg?x" → "07-master.jpg").
// Null when the URL doesn't end in an image file.
export function photoFilenameFromMatchUrl(url: string | null | undefined): string | null {
  const path = String(url ?? "").trim().replace(/[?#].*$/, "");
  const last = path.split("/").filter(Boolean).pop() ?? "";
  if (!last || !/\.(?:jpe?g|png|webp|gif)$/i.test(last)) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// Flatten the per-platform Lens match rows into de-duped, clickable links to
// the actual OTA listings hosting the duplicated photos. The scanner has
// ALREADY suppressed our own Guesty-authorized listing URLs (see
// server/authorized-urls.ts), so every URL here is a listing that is NOT
// ours. Multiple photos usually match the same thief listing — de-dupe by
// URL (query/slash-insensitive) and accumulate each listing's matched photos,
// platform-ordered (Airbnb, VRBO, Booking.com). `limit` caps the rendered
// list; `more` is the count of links beyond it.
export function collectDuplicateListingLinks(
  matches: Partial<Record<DuplicatePhotoPlatform, DuplicatePhotoMatchRow[] | null | undefined>>,
  limit = 6,
): { links: DuplicateListingLink[]; more: number } {
  const links: DuplicateListingLink[] = [];
  const byKey = new Map<string, DuplicateListingLink>();
  for (const platform of DUPLICATE_PHOTO_PLATFORMS) {
    for (const m of matches[platform] ?? []) {
      const url = (m.listingUrl ?? "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      // Normalize just enough that the same listing with/without a query
      // string or trailing slash collapses to one link.
      const key = url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
      const photo = (m.photoUrl ?? "").trim();
      const existing = byKey.get(key);
      if (existing) {
        if (photo && !existing.matchedPhotoUrls.includes(photo)) existing.matchedPhotoUrls.push(photo);
        continue;
      }
      const link: DuplicateListingLink = {
        platform,
        url,
        title: (m.title ?? "").trim() || url,
        matchedPhotoUrls: photo ? [photo] : [],
      };
      byKey.set(key, link);
      links.push(link);
    }
  }
  return { links: links.slice(0, limit), more: Math.max(0, links.length - limit) };
}

// ── Per-unit attribution of the offending links ──────────────────────────────
// Some properties give each unit its own photo folder (one warning row per
// unit — no attribution needed), but others share ONE folder between Unit A
// and Unit B. For those, attribute each offending listing to the unit(s)
// whose configured gallery contains the matched photo(s). When both units
// use the SAME gallery (e.g. mauna-kai-t3 serves 7B and 8), attribution is
// impossible by construction — flag it as a shared gallery instead of
// pretending, and let the thumbnails identify the photos.

export type DuplicateLinkOwner = { label: string; filenames: string[] };

export type DuplicateLinkGroup = {
  kind: "all" | "unit" | "unassigned";
  label: string | null;          // unit label for kind:"unit", else null
  sharedGallery: boolean;        // true when 2+ owners share one identical gallery
  links: DuplicateListingLink[];
  more: number;
};

export function groupDuplicateListingLinksByUnit(
  matches: Partial<Record<DuplicatePhotoPlatform, DuplicatePhotoMatchRow[] | null | undefined>>,
  owners: DuplicateLinkOwner[],
  limitPerGroup = 6,
): DuplicateLinkGroup[] {
  const all = collectDuplicateListingLinks(matches, Number.MAX_SAFE_INTEGER).links;
  if (all.length === 0) return [];
  const capped = (links: DuplicateListingLink[]): Pick<DuplicateLinkGroup, "links" | "more"> => ({
    links: links.slice(0, limitPerGroup),
    more: Math.max(0, links.length - limitPerGroup),
  });
  const usable = owners.filter((o) => o.filenames.length > 0);
  const gallerySig = (o: DuplicateLinkOwner) => [...o.filenames].sort().join("|");
  const sharedGallery =
    usable.length >= 2 && new Set(usable.map(gallerySig)).size === 1;
  if (usable.length < 2 || sharedGallery) {
    return [{ kind: "all", label: null, sharedGallery, ...capped(all) }];
  }
  const unitGroups = usable.map((o) => ({
    label: o.label,
    set: new Set(o.filenames),
    links: [] as DuplicateListingLink[],
  }));
  const unassigned: DuplicateListingLink[] = [];
  for (const link of all) {
    const files = link.matchedPhotoUrls
      .map(photoFilenameFromMatchUrl)
      .filter((f): f is string => !!f);
    let attributed = false;
    for (const g of unitGroups) {
      if (files.some((f) => g.set.has(f))) {
        g.links.push(link); // a listing hosting BOTH units' photos appears under both
        attributed = true;
      }
    }
    if (!attributed) unassigned.push(link);
  }
  const out: DuplicateLinkGroup[] = unitGroups
    .filter((g) => g.links.length > 0)
    .map((g) => ({ kind: "unit" as const, label: g.label, sharedGallery: false, ...capped(g.links) }));
  if (unassigned.length > 0) {
    out.push({ kind: "unassigned", label: null, sharedGallery: false, ...capped(unassigned) });
  }
  return out;
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
