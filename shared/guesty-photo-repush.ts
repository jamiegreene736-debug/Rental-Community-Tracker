// Pure helpers for the post-replacement Guesty photo RE-PUSH (2026-07-05
// operator ask): once a replacement unit's photos are hydrated into
// replacement-p<prop>-u<unit>, the mapped Guesty listing must stop serving the
// OLD unit's photos (the ones the OTA scan flagged as duplicated on someone
// else's listing). The push itself goes through the existing
// POST /api/builder/push-photos, whose PUT /listings/{id} REPLACES the entire
// pictures[] array — assembling the gallery from the ACTIVE folders is what
// deletes the stale photos from Guesty (and, via Guesty's channel fan-out,
// from Airbnb/VRBO/Booking).
//
// The assembly here deliberately mirrors the builder Photos tab
// (client/src/pages/builder.tsx propertyData memo) so an automated re-push
// produces the SAME gallery the operator would get from the manual
// "Push Photos to Guesty" button:
//   Unit A → Unit B → … → Community, each gallery hero-first-ordered via
//   shared/photo-order.ts unless the operator dragged a manual sort_order;
//   hidden photos dropped; base caption = userLabel > label > static label >
//   humanized filename; multi-unit bedroom/bathroom captions then receive their
//   natural logical Unit A/B suffix in planGalleryLayout.

import { orderGallery, type PhotoScope } from "./photo-order";
import { planGalleryLayout, type PhotoGalleryLayout } from "./photo-gallery-layout";

export type GuestyPushLabelRow = {
  filename: string;
  label?: string | null;
  userLabel?: string | null;
  category?: string | null;
  userCategory?: string | null;
  hidden?: boolean | null;
  sortOrder?: number | null;
};

export type GuestyPushGallery = {
  folder: string;
  scope: PhotoScope;
  /** Live disk listing for the folder (image files only, unordered ok). */
  files: string[];
  /** photo_labels rows for the folder (captions/hidden/manual order). */
  labels?: GuestyPushLabelRow[];
  /** Static unit-builder-data captions, filename → label (original folders only). */
  staticLabels?: Record<string, string>;
  /** Static unit-builder-data categories, filename → category (original folders only). */
  staticCategories?: Record<string, string>;
  /** Builder unit id — required for `scope: "unit"` so the saved unit order applies. */
  unitId?: string;
  /** Natural-position label ("Unit B (3BR)") used in the divider caption. */
  unitLabel?: string;
};

export type GuestyPushPhoto = { localPath: string; caption: string };

// Mirror of client/src/pages/builder.tsx captionFromFilename — the last-resort
// caption when neither the labeler nor the static config knows the photo.
export function captionFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/^\d+[-_]/, "");
  if (!stem) return "Photo";
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Assemble the push list for POST /api/builder/push-photos from per-folder
 * galleries. WITHIN each gallery the shared orderGallery contract applies
 * (manual sort_order wins, else the hero-first category default); ACROSS
 * galleries the shared planGalleryLayout contract applies — the operator's
 * saved unit order plus the community-photo divider between units.
 *
 * LOAD-BEARING: the `layout` argument is what keeps an AUTOMATED re-push
 * (after a unit swap, or the retroactive sweep) identical to what the operator
 * would get from the manual "Push Photos to Guesty" button. Dropping it here
 * silently reverts their chosen unit order on the next replacement. The caller
 * still owns which galleries exist; planGalleryLayout owns their order.
 */
export function assembleGuestyPushPhotos(
  galleries: GuestyPushGallery[],
  layout?: PhotoGalleryLayout | null,
): GuestyPushPhoto[] {
  type Entry = { localPath: string; caption: string; category: string | null };
  const unitGalleries: Array<{ unitId: string; label: string; photos: Entry[] }> = [];
  const community: Entry[] = [];

  for (const gallery of galleries) {
    if (!gallery?.folder) continue;
    const labelByFile = new Map<string, GuestyPushLabelRow>(
      (gallery.labels ?? []).map((row) => [row.filename, row]),
    );
    const entries = (gallery.files ?? [])
      .filter((filename) => !labelByFile.get(filename)?.hidden)
      .map((filename) => {
        const row = labelByFile.get(filename);
        const caption = row?.userLabel || row?.label
          || gallery.staticLabels?.[filename]
          || captionFromFilename(filename);
        const category = row?.userCategory || row?.category
          || gallery.staticCategories?.[filename]
          || null;
        return {
          filename,
          caption,
          category,
          // Same ranking signal as the builder: caption + category + filename.
          text: [caption, category, filename].filter(Boolean).join(" "),
          sortOrder: typeof row?.sortOrder === "number" ? row.sortOrder : null,
        };
      });
    const ordered = orderGallery(entries, gallery.scope).map((entry) => ({
      localPath: `/photos/${gallery.folder}/${entry.filename}`,
      caption: entry.caption,
      category: entry.category,
    }));
    if (gallery.scope === "community") {
      community.push(...ordered);
    } else {
      unitGalleries.push({
        unitId: gallery.unitId ?? gallery.folder,
        label: gallery.unitLabel ?? "",
        photos: ordered,
      });
    }
  }

  const out: GuestyPushPhoto[] = [];
  const seenLocalPaths = new Set<string>();
  for (const item of planGalleryLayout({ units: unitGalleries, community, layout })) {
    const { localPath, caption } = item.photo;
    if (seenLocalPaths.has(localPath)) continue;
    seenLocalPaths.add(localPath);
    out.push({ localPath, caption });
  }
  return out;
}

/**
 * Distinct propertyIds with a unit swap recorded within the trailing window —
 * the retroactive "re-push Guesty photos for every recent replacement" set.
 * Input order is preserved (storage.getAllUnitSwaps returns newest-first).
 * Rows without a parseable createdAt are skipped: they cannot prove recency,
 * and a wholesale re-push of every property ever swapped is not what the
 * retroactive pass is for.
 */
export function recentUnitSwapPropertyIds(
  swaps: Array<{ propertyId: number; createdAt?: Date | string | null }>,
  nowMs: number,
  windowDays: number,
): number[] {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const swap of swaps) {
    const propertyId = Number(swap?.propertyId);
    if (!Number.isFinite(propertyId) || seen.has(propertyId)) continue;
    const raw = swap?.createdAt;
    const t = raw instanceof Date ? raw.getTime() : raw ? Date.parse(String(raw)) : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    seen.add(propertyId);
    out.push(propertyId);
  }
  return out;
}
