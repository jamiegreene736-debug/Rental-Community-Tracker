// Role-aware gate for the VacationRentalExpertz portal.
//
// Activated by setting the `ADMIN_SECRET` env var. When unset, this
// middleware is a no-op so cold deploys, local dev, and the previous
// open-portal posture all keep working without touching env config.
//
// Auth modes:
//   1. Browser cookie — operator/agent submits credentials to /login,
//      we set an HttpOnly cookie whose value is role + HMAC. Each
//      request recomputes the HMAC and timing-safe-compares — no
//      server-side session storage. Rotating ADMIN_SECRET invalidates
//      every session. Legacy admin cookies from the previous
//      single-password gate are still accepted as admin until they
//      expire.
//   2. `X-Admin-Secret` request header — for CLI / curl / scripts.
//      Same secret as the cookie path. Matches the existing pattern
//      Load-Bearing #32 already documents for the Guesty admin
//      endpoints.
//
// Whitelisted entry points (the FOUR EXCLUSIONS from the 2026-05-04
// portal-auth scan in CLAUDE.md — each is load-bearing):
//
//   - /login + /logout — the auth flow itself; gating these would
//     create a chicken-and-egg.
//   - /api/admin/vrbo-sidecar/* — the local-Chrome sidecar
//     (Decision Log 2026-04-29) polls these endpoints from the
//     operator's Mac. Gating would break the find-buy-in flow's
//     most-reliable Vrbo path. The sidecar already runs on the
//     operator's own machine and the channel is implicitly trusted.
//   - /assets/* + /photos/* + /brand/* + favicon/touch icons +
//     /manifest.json + /robots.txt — the page can't render the
//     login form without its own JS/CSS/brand assets, and browsers
//     request favicons before the operator has authenticated.
//   - /api/quo/webhooks/* — Quo/OpenPhone sends inbound SMS webhooks
//     server-to-server and cannot carry the browser auth cookie. The
//     endpoint is protected separately with QUO_WEBHOOK_SECRET when set.
//   - /agreement/* + /admin/agreement/* + /api/rental-agreements/* —
//     tokenized guest signature links. Guests receive these by SMS/email
//     and cannot use the operator password. The /admin/agreement/*
//     alias exists only for older/shared guest links that included
//     "admin" in the path; it does not unlock the admin portal. Admin
//     creation routes stay protected under /api/bookings/*/rental-agreement.
//   - /api/buy-in-emails/inbound — server-to-server email webhook only
//     when BUY_IN_EMAIL_WEBHOOK_SECRET matches. This records PM/vendor
//     replies from alias email threads without giving guests/vendors the
//     operator password.
//   - 127.0.0.1 loopback — availability-scheduler.ts does an HTTP
//     self-call to /api/admin/refresh-all-market-rates once per
//     scheduled tick. The bypass uses req.socket.remoteAddress, NOT
//     req.ip / X-Forwarded-For, because Railway's edge sets XFF to
//     the client IP and an attacker could spoof "127.0.0.1" via XFF.
//     The raw socket is what actually identifies localhost.
//
// NOTE FOR CODEX: do NOT widen the public path list without a
// matching entry in CLAUDE.md / AGENTS.md. Each whitelisted prefix
// is a hole in the gate — the operator's Guesty session cookies
// and Anthropic API key are reachable through almost every other
// /api/* route, so the bar for adding a new exception is high.

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const COOKIE_NAME = "nexstay_auth";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export type PortalRole = "admin" | "agent";
export type PortalSession = { role: PortalRole; username: string };

const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/logout",
  "/assets/",
  "/photos/",
  "/brand/",
  "/api/admin/vrbo-sidecar/",
  "/api/quo/webhooks/",
  "/agreement/",
  "/admin/agreement/",
  "/api/rental-agreements/",
];

const PUBLIC_PATH_EXACT = new Set<string>([
  "/login",
  "/logout",
  "/agreement",
  "/admin/agreement",
  "/favicon.ico",
  "/favicon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
  "/manifest.json",
  "/site.webmanifest",
  "/robots.txt",
]);

function getExpectedCookieValue(secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("nexstay-portal-authenticated-v1")
    .digest("hex");
}

function getRoleCookieSignature(secret: string, role: PortalRole): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`nexstay-portal-authenticated-v2:${role}`)
    .digest("hex");
}

function buildRoleCookieValue(secret: string, role: PortalRole): string {
  return `${role}:${getRoleCookieSignature(secret, role)}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

function isLoopback(req: Request): boolean {
  const sock = req.socket?.remoteAddress ?? "";
  return sock === "127.0.0.1" || sock === "::ffff:127.0.0.1" || sock === "::1";
}

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATH_EXACT.has(path)) return true;
  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(prefix)) return true;
  }
  return false;
}

function isPublicAgreementPagePath(path: string): boolean {
  return (
    path === "/agreement" ||
    path.startsWith("/agreement/") ||
    path === "/admin/agreement" ||
    path.startsWith("/admin/agreement/")
  );
}

function isAuthorizedBuyInEmailWebhook(req: Request): boolean {
  if (req.path !== "/api/buy-in-emails/inbound") return false;
  const secret = process.env.BUY_IN_EMAIL_WEBHOOK_SECRET ?? "";
  if (!secret) return false;
  const header = req.headers["x-webhook-secret"] ?? req.headers["x-buy-in-email-webhook-secret"];
  return typeof header === "string" && constantTimeEqual(header, secret);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function resolvePortalSession(req: Request, secret: string): PortalSession | null {
  const cookies = parseCookies(req.headers.cookie);
  const cookieVal = cookies[COOKIE_NAME];
  if (cookieVal) {
    if (constantTimeEqual(cookieVal, getExpectedCookieValue(secret))) {
      return { role: "admin", username: "admin" };
    }
    const match = /^(admin|agent):([a-f0-9]{64})$/i.exec(cookieVal);
    if (match) {
      const role = match[1].toLowerCase() as PortalRole;
      const signature = match[2];
      if (constantTimeEqual(signature, getRoleCookieSignature(secret, role))) {
        return { role, username: role };
      }
    }
  }
  const header = req.headers["x-admin-secret"];
  if (typeof header === "string" && constantTimeEqual(header, secret)) {
    return { role: "admin", username: "admin" };
  }
  return null;
}

function agentApiMethodAllowed(req: Request): boolean {
  const method = req.method.toUpperCase();
  const path = req.path;

  if (method === "GET" && path === "/api/auth/session") return true;
  if (method === "GET" && path === "/api/guesty-property-map") return true;
  if (method === "GET" && /^\/api\/agent\/properties\/-?\d+\/bookings$/.test(path)) return true;

  if (method === "GET" && path.startsWith("/api/guesty-proxy/communication/conversations")) return true;
  if (method === "POST" && /^\/api\/guesty-proxy\/communication\/conversations\/[^/]+\/send-message$/.test(path)) return true;

  if (method === "GET" && /^\/api\/guesty-proxy\/reservations\/[^/]+$/.test(path)) return true;

  if (method === "GET" && path === "/api/inbox/sms/status") return true;
  if (method === "GET" && path === "/api/inbox/sms/match") return true;
  if (method === "GET" && path === "/api/inbox/templates") return true;
  if (method === "GET" && path.startsWith("/api/inbox/sms/conversations/")) return true;
  if (method === "POST" && /^\/api\/inbox\/sms\/conversations\/[^/]+\/send$/.test(path)) return true;
  if ((method === "PUT" || method === "PATCH") && /^\/api\/inbox\/sms\/conversations\/[^/]+\/(phone|links)$/.test(path)) return true;
  if (method === "GET" && path.startsWith("/api/inbox/calls/")) return true;
  if (method === "POST" && /^\/api\/inbox\/calls\/(\d+|conversations\/[^/]+)\/acknowledge$/.test(path)) return true;
  if (method === "POST" && path === "/api/inbox/ai-draft") return true;

  if (method === "GET" && /^\/api\/bookings\/[^/]+\/(arrival-details|buy-in-communications|rental-agreement)$/.test(path)) return true;

  return false;
}

export function isAgentAllowedPath(req: Request): boolean {
  const path = req.path;
  if (isPublicPath(path)) return true;
  if (path === "/" || path === "/inbox") return true;
  if (path.startsWith("/assets/") || path.startsWith("/brand/") || path.startsWith("/photos/")) return true;
  if (path.startsWith("/api/")) return agentApiMethodAllowed(req);
  return false;
}

export function resolveLoginRole(usernameRaw: string, password: string, adminSecret: string): PortalRole | null {
  const username = usernameRaw.trim().toLowerCase();
  if ((username === "" || username === "admin") && constantTimeEqual(password, adminSecret)) {
    return "admin";
  }
  if (username === "agent" && constantTimeEqual(password, "agent")) {
    return "agent";
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.ADMIN_SECRET ?? "";
  if (!secret) {
    res.locals.portalSession = { role: "admin", username: "admin" } satisfies PortalSession;
    return next();
  }
  if (isLoopback(req)) return next();
  if (isAuthorizedBuyInEmailWebhook(req)) return next();
  if (isPublicPath(req.path)) return next();
  const session = resolvePortalSession(req, secret);
  if (session) {
    res.locals.portalSession = session;
    if (session.role === "agent" && !isAgentAllowedPath(req)) {
      if (req.path.startsWith("/api/")) {
        return res.status(403).json({ error: "Agent access is limited to guest inbox and property information" });
      }
      return res.redirect("/");
    }
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const target = req.originalUrl && req.originalUrl !== "/"
    ? `?next=${encodeURIComponent(req.originalUrl)}`
    : "";
  return res.redirect(`/login${target}`);
}

const LOGIN_HTML = (errorMsg: string, nextPath: string) => `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Sign in — VacationRentalExpertz</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="shortcut icon" href="/favicon.ico?v=3">
<link rel="icon" href="/favicon.ico?v=3" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=3">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?v=3">
<link rel="icon" type="image/png" href="/favicon.png?v=3">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=3">
<link rel="apple-touch-icon-precomposed" href="/apple-touch-icon-precomposed.png?v=3">
<link rel="manifest" href="/site.webmanifest?v=3">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { background: white; padding: 32px 36px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); width: 320px; }
  .brand { display: block; width: 220px; max-width: 100%; margin: 0 auto 18px; }
  h1 { font-size: 20px; margin: 0 0 8px; color: #0f172a; }
  p { font-size: 13px; color: #64748b; margin: 0 0 20px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 6px; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 14px; border: 1px solid #cbd5e1; border-radius: 6px; outline: none; }
  input[type=text]:focus, input[type=password]:focus { border-color: #3b82f6; }
  button { width: 100%; margin-top: 16px; padding: 10px; font-size: 14px; font-weight: 600; color: white; background: #3b82f6; border: none; border-radius: 6px; cursor: pointer; }
  button:hover { background: #2563eb; }
  .err { color: #dc2626; font-size: 12px; margin-top: 8px; }
</style>
</head><body>
<form class="card" method="POST" action="/login">
  <img class="brand" src="/brand/vacation-rental-expertz-horizontal.png" alt="VacationRentalExpertz">
  <h1>VacationRentalExpertz Portal</h1>
  <p>This portal is private. Operators can use the admin password; agents use their assigned username and password.</p>
  <input type="hidden" name="next" value="${nextPath.replace(/"/g, "&quot;")}">
  <label for="username">Username</label>
  <input id="username" type="text" name="username" autocomplete="username" autofocus>
  <label for="password">Password</label>
  <input id="password" type="password" name="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
  ${errorMsg ? `<div class="err">${errorMsg}</div>` : ""}
</form>
</body></html>`;

function buildSetCookie(value: string, maxAgeSeconds: number): string {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

export function loginPageHandler(req: Request, res: Response) {
  const nextPath = typeof req.query.next === "string" ? req.query.next : "/";
  // If a guest previously hit the agreement route before the public
  // allowlist deployed, Safari may have cached/copied the redirected
  // /login?next=/agreement/... URL. Do not show the operator password
  // form for those tokenized guest links; send them back to the public
  // agreement route. This still leaves every other /login?next=/admin...
  // path protected.
  if (nextPath.startsWith("/") && !nextPath.startsWith("//") && isPublicAgreementPagePath(nextPath)) {
    return res.redirect(nextPath);
  }
  // Gate is open when ADMIN_SECRET is unset — bounce home immediately
  // so the operator doesn't see a confusing login form on a deploy
  // that doesn't actually require auth.
  if (!process.env.ADMIN_SECRET) {
    return res.redirect(nextPath.startsWith("/") ? nextPath : "/");
  }
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.send(LOGIN_HTML("", nextPath));
}

export function loginPostHandler(req: Request, res: Response) {
  const secret = process.env.ADMIN_SECRET ?? "";
  if (!secret) {
    return res.redirect("/");
  }
  const username = String((req.body as any)?.username ?? "");
  const password = String((req.body as any)?.password ?? "");
  const nextRaw = String((req.body as any)?.next ?? "/") || "/";
  // Only allow same-site relative redirects after login. An open
  // redirect on the post-login bounce would let an attacker craft
  // /login?next=https://evil/ to hand off the freshly-issued cookie
  // to a phishing page. Relative paths only.
  const safeNext = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";
  const role = resolveLoginRole(username, password, secret);
  if (!role) {
    res.status(401);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store");
    return res.send(LOGIN_HTML("Incorrect username or password.", safeNext));
  }
  res.set("Set-Cookie", buildSetCookie(buildRoleCookieValue(secret, role), Math.floor(COOKIE_MAX_AGE_MS / 1000)));
  res.redirect(role === "agent" && safeNext !== "/inbox" ? "/" : safeNext);
}

export function logoutHandler(_req: Request, res: Response) {
  res.set("Set-Cookie", buildSetCookie("", 0));
  res.redirect("/login");
}
