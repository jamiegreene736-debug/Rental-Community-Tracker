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
import net from "net";
import dns from "dns/promises";
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
const MAX_REDIRECTS = 3;
const SOURCE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

// ── SSRF hardening (2026-07-11) ─────────────────────────────────────────────
// The string guard (isSafeGuestPhotoSourceUrl) rejects IP-literal / internal /
// numeric-TLD hosts, but a PUBLIC DNS name can still resolve to an internal IP
// (e.g. 169.254.169.254.nip.io), and a legitimately-signed URL could 302 to an
// internal host. So before every fetch — and on every redirect hop — we (a)
// re-run the string guard, and (b) resolve the host and reject any private /
// reserved / link-local / loopback address. Redirects are followed manually
// (redirect: "manual") so each hop is re-validated. Residual TOCTOU (a rebinding
// DNS could return a public IP to lookup() and an internal IP to the socket) is
// bounded by the HMAC-signature requirement — only URLs we embedded on a stored
// guest page can reach this endpoint at all.

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function isDisallowedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (b & mask) >>> 0;
  };
  return (
    inRange("0.0.0.0", 8) ||       // "this" network
    inRange("10.0.0.0", 8) ||      // private
    inRange("100.64.0.0", 10) ||   // CGNAT
    inRange("127.0.0.0", 8) ||     // loopback
    inRange("169.254.0.0", 16) ||  // link-local (cloud metadata)
    inRange("172.16.0.0", 12) ||   // private
    inRange("192.0.0.0", 24) ||    // IETF protocol assignments
    inRange("192.0.2.0", 24) ||    // TEST-NET-1
    inRange("192.88.99.0", 24) ||  // 6to4 relay anycast
    inRange("192.168.0.0", 16) ||  // private
    inRange("198.18.0.0", 15) ||   // benchmarking
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) ||  // TEST-NET-3
    inRange("224.0.0.0", 4) ||     // multicast
    inRange("240.0.0.0", 4)        // reserved + broadcast
  );
}

function isDisallowedIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isDisallowedIpv4(ip);
  if (fam === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    const mapped = /^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
    if (mapped) return isDisallowedIpv4(mapped[1]); // IPv4-mapped/compat
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    return false;
  }
  return true; // not a valid IP string → unsafe
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    // The string guard rejects IP-literal hosts before we get here, but stay
    // defensive in case this is ever called directly.
    if (isDisallowedIp(hostname)) throw new Error(`blocked ip host ${hostname}`);
    return;
  }
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length) throw new Error(`no DNS records for ${hostname}`);
  for (const r of records) {
    if (isDisallowedIp(r.address)) {
      throw new Error(`host ${hostname} resolves to disallowed address ${r.address}`);
    }
  }
}

/** Fetch `startUrl`, following redirects manually and re-validating the string
 * guard + resolved IP on every hop. Throws on an unsafe hop or too many. */
async function ssrfSafeImageFetch(startUrl: string): Promise<globalThis.Response> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeGuestPhotoSourceUrl(url)) throw new Error(`unsafe redirect target ${url}`);
    await assertPublicHost(new URL(url).hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": SOURCE_UA, Accept: "image/*,*/*;q=0.8" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`redirect ${response.status} without location`);
      url = new URL(location, url).toString(); // resolve relative redirects
      continue;
    }
    return response;
  }
  throw new Error("too many redirects");
}

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
  // SSRF-hardened fetch: validates the string guard + resolves the host to a
  // public IP on every redirect hop before connecting (see ssrfSafeImageFetch).
  const response = await ssrfSafeImageFetch(src);
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
