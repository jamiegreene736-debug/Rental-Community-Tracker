// Guest-page photo sharpness: the sidecar harvests listing galleries from the
// search/detail DOM, where the <img> src is a CDN THUMBNAIL variant — e.g.
// media.vrbo.com/...jpg?impolicy=resizecrop&rw=297&ra=fit is the SAME photo the
// CDN also serves at 2738x1825 (verified live 2026-07-06). Embedding those URLs
// on /alternatives/:token made the guest page look blurry. This helper rewrites
// known CDN thumbnail URLs to a high-resolution variant — REAL original pixels
// from the CDN, not AI interpolation.
//
// Deliberately conservative: only hosts whose resize parameters are verified
// (VRBO / Expedia "trvl-media" family, `rw=` width param). An invented variant
// on an unverified CDN could 404 on a guest-facing page, which is worse than a
// soft photo. Relative URLs (our own /photos/...) and unknown hosts pass
// through untouched. Never downgrades an already-large request.

/** Target render width for guest-page photos. 1200px is sharp on the page's
 * layout while keeping per-photo weight reasonable (~250KB vs ~580KB raw). */
export const GUEST_PHOTO_TARGET_WIDTH = 1200;

const VRBO_MEDIA_HOST_RE = /(?:^|\.)(?:media\.vrbo\.com|trvl-media\.com)$/i;

export function upgradeListingPhotoUrlResolution(url: string | null | undefined): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return raw; // relative (our own /photos/...) — untouched
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!VRBO_MEDIA_HOST_RE.test(parsed.hostname)) return raw;
  const rw = Number(parsed.searchParams.get("rw"));
  // No rw param → the URL already points at the original; leave it alone.
  // rw >= target → never downgrade a larger request.
  if (!Number.isFinite(rw) || rw <= 0 || rw >= GUEST_PHOTO_TARGET_WIDTH) return raw;
  parsed.searchParams.set("rw", String(GUEST_PHOTO_TARGET_WIDTH));
  return parsed.toString();
}
