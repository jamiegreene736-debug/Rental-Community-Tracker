// Redfin subject-gallery isolation.
//
// WHY THIS EXISTS (root cause of "mixed photos / wrong community", 2026-06-17):
// A Redfin listing-detail page — especially an OFF-MARKET / SOLD one — renders a
// "Nearby similar homes" / "More homes like this" / comparable-sold carousel.
// Every comp card carries ~3 `cdn-redfin.com` thumbnails. The generic gallery
// extractor (`extractGenericRealEstateGalleryFromHtml`) harvests *every*
// `cdn-redfin.com` image on the page, so a unit folder ends up with 15-17
// different listings' photos (~3 each) instead of the subject listing's own
// gallery. That is exactly the contamination the photo-community check flags
// (Halii Kai draft 26: Unit B = 16 comp batches, an inland Waikoloa-Village
// golf home mixed into an oceanfront resort unit).
//
// THE FIX: every photo in ONE Redfin listing's gallery shares a single numeric
// `photoSetId` (`.../genMid.<setId>_<index>.jpg`, `.../<shard>/<setId>_<i>.jpg`).
// The subject listing's set id is whatever `og:image` points at — Redfin always
// uses the subject's primary photo for og:image when the listing has a gallery,
// and falls back to the Redfin rocket logo when it has none. So:
//   - keep only `cdn-redfin` photos whose set id == the og:image set id
//   - if og:image has no set id (off-market / no own photos), keep NONE of the
//     cdn-redfin photos (they are all comps) rather than saving the carousel.
// Non-Redfin photos and non-Redfin pages pass through untouched.

/**
 * Extract the Redfin photo-set id from a cdn-redfin photo URL.
 *
 * Gallery URLs look like:
 *   https://ssl.cdn-redfin.com/photo/168/mbpaddedwide/315/genMid.204315_0.jpg
 *   http://ssl.cdn-redfin.com/photo/168/bigphoto/315/204315_0.jpg
 *   https://ssl.cdn-redfin.com/photo/168/bcsphoto/668/genbcs.726668_1_4.jpg
 * The set id is the run of digits immediately before `_<index>[_<variant>].<ext>`.
 * Returns null for non-photo assets (logos, app-download badges, twitter cards),
 * which have no `<digits>_<index>.<ext>` segment.
 */
export function redfinPhotoSetId(url: string): string | null {
  if (typeof url !== "string") return null;
  const m = url.match(/(?:^|[./])(\d{4,})_\d+(?:_\d+)?\.(?:jpe?g|png|webp)(?:[?#]|$)/i);
  return m ? m[1] : null;
}

/**
 * The subject listing's photo-set id, read from the page's og:image meta tag.
 * og:image is always the subject's hero photo on a Redfin listing that has a
 * gallery; an off-market listing with no photos points og:image at the Redfin
 * logo, so this returns null and the caller drops every comp photo.
 */
export function redfinSubjectSetIdFromHtml(html: string): string | null {
  if (typeof html !== "string") return null;
  const og =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!og) return null;
  return redfinPhotoSetId(og[1]);
}

export type RedfinGalleryIsolation = {
  /** Whether the source HTML is a Redfin page (has cdn-redfin assets). */
  isRedfin: boolean;
  /** The subject listing's photo-set id, or null if it has no own gallery. */
  subjectSetId: string | null;
  /** Photos to keep (subject gallery + any non-redfin photos). */
  urls: string[];
  /** How many cdn-redfin comp/junk photos were dropped. */
  droppedComps: number;
};

/**
 * Given a Redfin page's HTML and the photo URLs harvested from it, keep only the
 * subject listing's own gallery and drop the nearby/comparable-homes carousel.
 * No-op for non-Redfin pages.
 */
export function isolateRedfinSubjectGallery(html: string, urls: string[]): RedfinGalleryIsolation {
  const isRedfin = /cdn-redfin\.com/i.test(html);
  if (!isRedfin) {
    return { isRedfin: false, subjectSetId: null, urls, droppedComps: 0 };
  }
  const subjectSetId = redfinSubjectSetIdFromHtml(html);
  let droppedComps = 0;
  const kept = urls.filter((u) => {
    // Non-redfin photos (rare on a Redfin page) are not comps — keep them.
    if (!/cdn-redfin\.com/i.test(u)) return true;
    const setId = redfinPhotoSetId(u);
    const keep = subjectSetId != null && setId === subjectSetId;
    if (!keep) droppedComps += 1;
    return keep;
  });
  return { isRedfin: true, subjectSetId, urls: kept, droppedComps };
}
