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

// ── Host-agnostic subject-gallery isolation (JSON-LD) ──────────────────────
//
// WHY THIS EXISTS (root cause of "jumbled photos from multiple units", the
// general case of the Redfin trap above): EVERY real-estate listing-detail page
// — Homes.com, Realtor MLS/broker portals, and most generic hosts — renders a
// "Nearby similar homes" / "More homes like this" carousel whose cards each
// carry other units' thumbnails. The greedy page scrape
// (`extractGenericRealEstateGalleryFromHtml`) harvests every <img>/srcset/CDN
// URL on the page, so a single unit folder fills with several DIFFERENT
// listings' photos. The Redfin photoSetId isolation above only protects Redfin;
// Homes.com and the rest had no guard at all.
//
// THE FIX: a listing page's JSON-LD structured data describes the SUBJECT entity
// (the unit), and its `image` array is the subject's own authoritative gallery.
// The similar-homes carousel lives in SEPARATE JSON-LD nodes (an `ItemList`), so
// it is never part of the subject node's `image` array. When a page exposes a
// substantial subject gallery in structured data, that is the cleanest
// "only this unit's photos" source — immune to the page-wide harvest. We pull
// images ONLY from property/accommodation/product nodes and explicitly skip
// `ItemList` / breadcrumb / org / site subtrees so a comp carousel or a logo set
// can never masquerade as the subject gallery.

// Junk assets (logos, icons, map pins, app-store badges, social cards, etc.)
// that are not listing photos even when they appear in a JSON-LD image field.
const JSONLD_JUNK_RE =
  /logo|icon|sprite|avatar|favicon|placeholder|transparent|broker|team|award|flag|main-bg|no-?photo|map-placeholder|badge|app-store|google-play|twitter-card|equal-housing/i;

// JSON-LD node @types whose subtree never holds the subject's own gallery —
// the comp carousel (ItemList) and page chrome (nav/org/site/breadcrumbs).
const JSONLD_SKIP_TYPE_RE =
  /(?:ItemList|BreadcrumbList|SiteNavigationElement|Organization|WebSite|WebPage|Person|RealEstateAgent)/i;

// JSON-LD node @types that DO describe the subject unit/listing, so their
// `image` array is the gallery we want.
const JSONLD_SUBJECT_TYPE_RE =
  /(?:Residence|House|Apartment|Accommodation|Product|Place|RealEstateListing|SingleFamilyResidence|LodgingBusiness|Offer|Home|Property)/i;

function jsonLdTypeString(node: any): string {
  const t = node?.["@type"];
  return Array.isArray(t) ? t.join(" ") : String(t ?? "");
}

function normalizeJsonLdImage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u = raw.trim().replace(/\\u002F/gi, "/").replace(/&amp;/gi, "&");
  if (u.startsWith("//")) u = `https:${u}`;
  if (!/^https?:\/\//i.test(u)) return null;
  if (!/\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(u)) return null;
  const lower = u.toLowerCase();
  if (/(?:pinterest|facebook|twitter|instagram|youtube)\.com/i.test(lower)) return null;
  if (JSONLD_JUNK_RE.test(lower)) return null;
  return u;
}

/**
 * Extract the SUBJECT listing's own photo gallery from a real-estate page's
 * JSON-LD structured data. Returns de-duplicated image URLs in document order,
 * pulled ONLY from property/accommodation/product nodes (skipping the
 * similar-homes `ItemList` and page-chrome subtrees). Returns [] when no usable
 * subject gallery is present so the caller can fall back to the greedy harvest.
 */
export function subjectGalleryFromJsonLd(html: string): string[] {
  if (typeof html !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const pushImage = (raw: unknown) => {
    const u = normalizeJsonLdImage(
      typeof raw === "string" ? raw : (raw as any)?.url ?? (raw as any)?.contentUrl,
    );
    if (!u) return;
    const key = u.replace(/[?#].*$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(u);
  };
  const visit = (node: any, depth: number, withinSubject: boolean) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1, withinSubject);
      return;
    }
    if (typeof node !== "object") return;
    const typeStr = jsonLdTypeString(node);
    // Never descend into a comp carousel or page-chrome subtree.
    if (JSONLD_SKIP_TYPE_RE.test(typeStr)) return;
    const isSubject = withinSubject || JSONLD_SUBJECT_TYPE_RE.test(typeStr);
    if (isSubject && node.image != null) {
      const imgs = Array.isArray(node.image) ? node.image : [node.image];
      for (const i of imgs) pushImage(i);
    }
    for (const value of Object.values(node)) visit(value, depth + 1, isSubject);
  };
  for (const m of Array.from(
    html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  )) {
    try {
      visit(JSON.parse(m[1]), 0, false);
    } catch {
      /* malformed JSON-LD block — ignore */
    }
  }
  return out;
}

/**
 * Minimum JSON-LD subject images that count as a real gallery (vs. an og-only or
 * single hero image). Below this we keep the greedy harvest so a page that only
 * exposes one structured-data image is not reduced to a single photo.
 */
export const MIN_JSONLD_SUBJECT_GALLERY = 5;

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
