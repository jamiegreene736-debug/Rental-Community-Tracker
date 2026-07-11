// Network-free unit tests for shared/guest-photo-proxy.ts — the signed
// upscaling proxy that makes genuinely low-res guest-page photos (418x270
// PM-site originals, live Thien Tran Unit A case) render sharp, plus source
// locks on the server wiring (routes.ts, auth.ts, guest-photo-upscale.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUEST_PHOTO_PROXY_PATH,
  GUEST_PHOTO_UPSCALE_MIN_SOURCE_WIDTH,
  GUEST_PHOTO_UPSCALE_TARGET_WIDTH,
  isSafeGuestPhotoSourceUrl,
  shouldProxyGuestPhoto,
} from "../shared/guest-photo-proxy";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("guest-photo-proxy: isSafeGuestPhotoSourceUrl (SSRF guard)");
check("public https host ok", isSafeGuestPhotoSourceUrl("https://www.waikikibeachrentals.com/rentals/463/a.jpg") === true);
check("plain http ok", isSafeGuestPhotoSourceUrl("http://example.com/a.jpg") === true);
check("IPv4 literal rejected", isSafeGuestPhotoSourceUrl("https://169.254.169.254/latest/meta-data") === false);
check("IPv6 literal rejected", isSafeGuestPhotoSourceUrl("https://[::1]/a.jpg") === false);
check("bare hostname (localhost / railway svc) rejected", isSafeGuestPhotoSourceUrl("http://localhost/a.jpg") === false);
check("internal suffix rejected", isSafeGuestPhotoSourceUrl("https://postgres.railway.internal/a.jpg") === false);
check("relative URL rejected", isSafeGuestPhotoSourceUrl("/photos/ilikai/1.jpg") === false);
check("non-http scheme rejected", isSafeGuestPhotoSourceUrl("file:///etc/passwd") === false);
check("empty/null rejected", isSafeGuestPhotoSourceUrl("") === false && isSafeGuestPhotoSourceUrl(null) === false);
// Numeric IP-literal encodings must not slip the dotted-quad regex (numeric TLD).
check("hex dotted IP rejected", isSafeGuestPhotoSourceUrl("http://0x7f.0.0.1/a.jpg") === false);
check("octal dotted IP rejected", isSafeGuestPhotoSourceUrl("http://0177.0.0.1/a.jpg") === false);
check("decimal IP (no dot) rejected", isSafeGuestPhotoSourceUrl("http://2130706433/a.jpg") === false);
check("DNS name with alphabetic TLD still allowed", isSafeGuestPhotoSourceUrl("https://cdn.example.io/a.jpg") === true);

console.log("guest-photo-proxy: shouldProxyGuestPhoto");
check("low-res PM site → proxy", shouldProxyGuestPhoto("https://www.waikikibeachrentals.com/rentals/463/Ilikai-1834-1.jpg") === true);
check("VRBO media family bypasses (already full-res via rw upgrade)",
  shouldProxyGuestPhoto("https://media.vrbo.com/lodging/1/2/a.jpg?rw=1200") === false);
check("trvl-media family bypasses", shouldProxyGuestPhoto("https://images.trvl-media.com/lodging/1/2/a.jpg") === false);
check("our own relative photos bypass", shouldProxyGuestPhoto("/photos/ilikai/1.jpg") === false);
check("unsafe host never proxied", shouldProxyGuestPhoto("http://localhost/a.jpg") === false);

check("proxy path + width constants stable",
  GUEST_PHOTO_PROXY_PATH === "/guest-photo"
  && GUEST_PHOTO_UPSCALE_TARGET_WIDTH === 1200
  && GUEST_PHOTO_UPSCALE_MIN_SOURCE_WIDTH === 900);

// ── Source assertions: server wiring ────────────────────────────────────────
console.log("guest-photo-proxy: source wiring");
const here = path.dirname(fileURLToPath(import.meta.url));
const routesSrc = fs.readFileSync(path.join(here, "..", "server", "routes.ts"), "utf8");
const authSrc = fs.readFileSync(path.join(here, "..", "server", "auth.ts"), "utf8");
const upscaleSrc = fs.readFileSync(path.join(here, "..", "server", "guest-photo-upscale.ts"), "utf8");

check("routes: renderer routes photos through the proxy after the CDN rw upgrade",
  routesSrc.includes("proxiedGuestPhotoUrl(upgradeListingPhotoUrlResolution(url))"));
check("routes: proxy route registered before the alternatives page",
  routesSrc.includes("registerGuestPhotoRoute(app);"));
check("auth: /guest-photo is public (guests are unauthenticated)",
  authSrc.includes('"/guest-photo",'));
check("upscale: requests are HMAC-signed and timing-safe verified",
  upscaleSrc.includes("guestPhotoSignature(src)") && upscaleSrc.includes("crypto.timingSafeEqual"));
check("upscale: SSRF guard re-checked even with a valid signature",
  upscaleSrc.includes("!isSafeGuestPhotoSourceUrl(src)"));
check("upscale: large sources pass through untouched (never re-encode good pixels)",
  upscaleSrc.includes("width >= GUEST_PHOTO_UPSCALE_MIN_SOURCE_WIDTH"));
check("upscale: any failure 302s to the source (never a broken guest image)",
  upscaleSrc.includes("res.redirect(302, src)"));
check("upscale: resolves + validates the host IP before fetching (SSRF)",
  upscaleSrc.includes("assertPublicHost") && upscaleSrc.includes("isDisallowedIp"));
check("upscale: follows redirects manually so each hop is re-validated",
  upscaleSrc.includes('redirect: "manual"'));
check("upscale: lanczos3 + sharpen at the target width",
  upscaleSrc.includes('kernel: "lanczos3"') && upscaleSrc.includes("sharpen("));

console.log(`\nguest-photo-proxy: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
