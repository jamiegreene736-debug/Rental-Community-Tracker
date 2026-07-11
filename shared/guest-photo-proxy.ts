// Guest-page photo UPSCALING proxy — pure decision logic (no crypto/IO; the
// HMAC signing + sharp pipeline live in server/guest-photo-upscale.ts).
//
// Why: some listing sources only publish genuinely small photos (live case:
// waikikibeachrentals.com serves 418x270 originals — there is NO larger
// variant to request, unlike the VRBO CDN). For those, the guest page routes
// the <img> src through GET /guest-photo, which fetches the source and serves
// a lanczos-upscaled + sharpened 1200px derivative. Already-sharp sources
// (VRBO/Expedia media family, handled by upgradeListingPhotoUrlResolution)
// bypass the proxy entirely; the endpoint itself also passes large sources
// through untouched and 302s to the original on ANY failure, so the worst
// case is exactly what the guest sees today.

import { isVrboMediaFamilyUrl } from "./listing-photo-resolution";

export const GUEST_PHOTO_PROXY_PATH = "/guest-photo";

/** Sources at or above this width are already sharp at the page's render size
 * — the proxy streams them through without re-encoding. */
export const GUEST_PHOTO_UPSCALE_MIN_SOURCE_WIDTH = 900;

/** Width of the upscaled derivative (matches GUEST_PHOTO_TARGET_WIDTH for the
 * CDN full-res path, so both photo classes render at comparable sizes). */
export const GUEST_PHOTO_UPSCALE_TARGET_WIDTH = 1200;

/**
 * SSRF guard for the proxy's outbound fetch: only plain http(s) hosts that are
 * real public DNS names. IP-literals, localhost, and internal/mDNS suffixes
 * are rejected — the proxy must never be usable to probe the Railway network.
 * (Defense-in-depth: the endpoint ALSO requires an HMAC signature minted at
 * page render, so arbitrary URLs can't be fed to it in the first place.)
 */
export function isSafeGuestPhotoSourceUrl(url: string | null | undefined): boolean {
  const raw = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host || !host.includes(".")) return false; // bare names (localhost, railway svc)
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (host.startsWith("[") || host.includes(":")) return false; // IPv6 literal
  if (/\.(?:local|internal|localdomain|home|lan|arpa)$/.test(host)) return false;
  // The rightmost label (TLD) of a real domain is always alphabetic. Rejecting
  // a non-alphabetic TLD kills every numeric IP-literal encoding that slips the
  // dotted-quad regex above — decimal (http://2130706433/ has no dot so is
  // already out), hex/octal dotted forms (http://0x7f.0.0.1/, http://0177.0.0.1/),
  // and mixed forms — none of which have an alphabetic TLD. Server-side DNS
  // resolution in guest-photo-upscale.ts is the authoritative backstop, but this
  // keeps the shared pure guard from ever green-lighting an IP-shaped host.
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (!/[a-z]/.test(tld)) return false;
  return true;
}

/**
 * Should this photo URL be routed through the upscaling proxy?
 * - Relative URLs (our own /photos/...) → no (served locally, full size).
 * - VRBO/Expedia media family → no (already full-res via the rw= upgrade).
 * - Everything else safe → yes; the endpoint decides pass-through vs upscale
 *   from the ACTUAL source dimensions, so proxying a large unknown-host photo
 *   costs one fetch and changes nothing visually.
 */
export function shouldProxyGuestPhoto(url: string | null | undefined): boolean {
  const raw = String(url ?? "").trim();
  if (!isSafeGuestPhotoSourceUrl(raw)) return false;
  return !isVrboMediaFamilyUrl(raw);
}
