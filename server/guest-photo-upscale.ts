// GET /guest-photo — signed upscaling proxy for guest-page photos whose
// SOURCE is genuinely low-resolution (live case: waikikibeachrentals.com
// publishes 418x270 originals; the VRBO CDN path never comes here because
// upgradeListingPhotoUrlResolution already requests its full-res variant).
//
// Pipeline: verify HMAC → fetch source (bounded) → probe dimensions with
// sharp → source already >= GUEST_PHOTO_UPSCALE_MIN_SOURCE_WIDTH wide →
// stream the ORIGINAL bytes untouched; smaller → lanczos3 upscale to
// GUEST_PHOTO_UPSCALE_TARGET_WIDTH + unsharp + JPEG re-encode. This is
// classical interpolation + sharpening (real, deterministic), NOT generative
// AI super-resolution — it cannot invent detail, only render what exists as
// crisply as possible at the page's display size.
//
// FAIL-SAFE (load-bearing): any error — fetch timeout, bot wall, non-image
// body, sharp failure — 302-redirects to the source URL, so the guest sees
// exactly what they'd have seen without the proxy. Never a broken image.
//
// SECURITY (load-bearing): the path is in server/auth.ts PUBLIC_PATH_EXACT
// (guests are unauthenticated), so the endpoint is reachable by anyone. Two
// independent guards keep it from being an open proxy / SSRF primitive:
// (1) `sig` — HMAC-SHA256 over the src, minted ONLY at page render for URLs
//     already embedded in a stored alternative page; (2) isSafeGuestPhotoSourceUrl
//     rejects IP-literals / localhost / internal suffixes even with a valid
//     signature. Key = GUEST_PHOTO_SIGN_KEY || ADMIN_SECRET (falls back to a
//     static dev key only when the portal gate itself is off).

import type { Express, Request, Response } from "express";
import crypto from "crypto";
import sharp from "sharp";
import {
  GUEST_PHOTO_PROXY_PATH,
  GUEST_PHOTO_UPSCALE_MIN_SOURCE_WIDTH,
  GUEST_PHOTO_UPSCALE_TARGET_WIDTH,
  isSafeGuestPhotoSourceUrl,
  shouldProxyGuestPhoto,
} from "@shared/guest-photo-proxy";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_MAX_ENTRIES = 80;

const signingKey = (): string =>
  process.env.GUEST_PHOTO_SIGN_KEY || process.env.ADMIN_SECRET || "nexstay-guest-photo-v1";

export function guestPhotoSignature(src: string): string {
  return crypto.createHmac("sha256", signingKey()).update(String(src ?? "")).digest("hex").slice(0, 32);
}

/** Proxy URL for a photo the page should upscale; returns the input unchanged
 * when the proxy shouldn't/can't handle it (relative, VRBO CDN, unsafe). */
export function proxiedGuestPhotoUrl(src: string): string {
  const raw = String(src ?? "").trim();
  if (!raw || !shouldProxyGuestPhoto(raw)) return raw;
  return `${GUEST_PHOTO_PROXY_PATH}?src=${encodeURIComponent(raw)}&sig=${guestPhotoSignature(raw)}`;
}

type CachedPhoto = { body: Buffer; contentType: string };
const photoCache = new Map<string, CachedPhoto>(); // insertion-ordered LRU
const inflight = new Map<string, Promise<CachedPhoto>>();

const cacheGet = (key: string): CachedPhoto | undefined => {
  const hit = photoCache.get(key);
  if (hit) {
    photoCache.delete(key);
    photoCache.set(key, hit); // refresh recency
  }
  return hit;
};

const cachePut = (key: string, value: CachedPhoto): void => {
  photoCache.delete(key);
  photoCache.set(key, value);
  while (photoCache.size > CACHE_MAX_ENTRIES) {
    const oldest = photoCache.keys().next().value;
    if (oldest === undefined) break;
    photoCache.delete(oldest);
  }
};

async function fetchAndUpscale(src: string): Promise<CachedPhoto> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: globalThis.Response;
  try {
    response = await fetch(src, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        Accept: "image/*,*/*;q=0.8",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`source HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) throw new Error("source too large");
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_SOURCE_BYTES) throw new Error(`source size ${buf.length}`);

  const meta = await sharp(buf).metadata();
  const width = Number(meta.width) || 0;
  if (!width) throw new Error("not an image");
  if (width >= GUEST_PHOTO_UPSCALE_MIN_SOURCE_WIDTH) {
    // Already sharp at render size — never re-encode good pixels.
    return { body: buf, contentType: response.headers.get("content-type") || `image/${meta.format ?? "jpeg"}` };
  }
  const upscaled = await sharp(buf)
    .resize({ width: GUEST_PHOTO_UPSCALE_TARGET_WIDTH, kernel: "lanczos3", withoutEnlargement: false })
    .sharpen({ sigma: 1.1 })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return { body: upscaled, contentType: "image/jpeg" };
}

export function registerGuestPhotoRoute(app: Express): void {
  app.get(GUEST_PHOTO_PROXY_PATH, async (req: Request, res: Response) => {
    const src = String(req.query.src ?? "").trim().slice(0, 1400);
    const sig = String(req.query.sig ?? "").trim();
    const expected = src ? guestPhotoSignature(src) : "";
    const sigOk = !!expected && sig.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!src || !sigOk || !isSafeGuestPhotoSourceUrl(src)) {
      return res.status(404).send("Not found");
    }
    try {
      let photo = cacheGet(src);
      if (!photo) {
        let pending = inflight.get(src);
        if (!pending) {
          pending = fetchAndUpscale(src).finally(() => inflight.delete(src));
          inflight.set(src, pending);
        }
        photo = await pending;
        cachePut(src, photo);
      }
      res.setHeader("Content-Type", photo.contentType);
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(photo.body);
    } catch (err: any) {
      // Fail-safe: the signature already proved this URL is one WE embedded on
      // a guest page, so redirecting to it is exactly the pre-proxy behavior.
      console.log(`[guest-photo] upscale fallback for ${src}: ${err?.message ?? err}`);
      return res.redirect(302, src);
    }
  });
}
