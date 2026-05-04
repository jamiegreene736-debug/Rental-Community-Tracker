// Single-password gate for the NexStay portal.
//
// Activated by setting the `ADMIN_SECRET` env var. When unset, this
// middleware is a no-op so cold deploys, local dev, and the previous
// open-portal posture all keep working without touching env config.
//
// Auth modes:
//   1. Browser cookie — operator submits the password to /login,
//      we set an HttpOnly cookie whose value is HMAC-SHA256(secret,
//      "nexstay-portal-authenticated-v1"). Each request recomputes
//      the HMAC and timing-safe-compares — no server-side session
//      storage. Rotating ADMIN_SECRET invalidates every session.
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
//   - /assets/* + /photos/* + /favicon.ico + /manifest.json +
//     /robots.txt — the page can't render the login form without
//     its own JS/CSS, and crawlers/PWA shells expect those files.
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

const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/logout",
  "/assets/",
  "/photos/",
  "/api/admin/vrbo-sidecar/",
];

const PUBLIC_PATH_EXACT = new Set<string>([
  "/login",
  "/logout",
  "/favicon.ico",
  "/manifest.json",
  "/robots.txt",
]);

function getExpectedCookieValue(secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("nexstay-portal-authenticated-v1")
    .digest("hex");
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isAuthenticated(req: Request, secret: string): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const cookieVal = cookies[COOKIE_NAME];
  if (cookieVal && constantTimeEqual(cookieVal, getExpectedCookieValue(secret))) {
    return true;
  }
  const header = req.headers["x-admin-secret"];
  if (typeof header === "string" && constantTimeEqual(header, secret)) {
    return true;
  }
  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.ADMIN_SECRET ?? "";
  if (!secret) return next();
  if (isLoopback(req)) return next();
  if (isPublicPath(req.path)) return next();
  if (isAuthenticated(req, secret)) return next();

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
<title>Sign in — NexStay</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { background: white; padding: 32px 36px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); width: 320px; }
  h1 { font-size: 20px; margin: 0 0 8px; color: #0f172a; }
  p { font-size: 13px; color: #64748b; margin: 0 0 20px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 14px; border: 1px solid #cbd5e1; border-radius: 6px; outline: none; }
  input[type=password]:focus { border-color: #3b82f6; }
  button { width: 100%; margin-top: 16px; padding: 10px; font-size: 14px; font-weight: 600; color: white; background: #3b82f6; border: none; border-radius: 6px; cursor: pointer; }
  button:hover { background: #2563eb; }
  .err { color: #dc2626; font-size: 12px; margin-top: 8px; }
</style>
</head><body>
<form class="card" method="POST" action="/login">
  <h1>NexStay Portal</h1>
  <p>This portal is private. Sign in with the operator password.</p>
  <input type="hidden" name="next" value="${nextPath.replace(/"/g, "&quot;")}">
  <label for="password">Password</label>
  <input id="password" type="password" name="password" autocomplete="current-password" autofocus required>
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
  const password = String((req.body as any)?.password ?? "");
  const nextRaw = String((req.body as any)?.next ?? "/") || "/";
  // Only allow same-site relative redirects after login. An open
  // redirect on the post-login bounce would let an attacker craft
  // /login?next=https://evil/ to hand off the freshly-issued cookie
  // to a phishing page. Relative paths only.
  const safeNext = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";
  if (!constantTimeEqual(password, secret)) {
    res.status(401);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store");
    return res.send(LOGIN_HTML("Incorrect password.", safeNext));
  }
  res.set("Set-Cookie", buildSetCookie(getExpectedCookieValue(secret), Math.floor(COOKIE_MAX_AGE_MS / 1000)));
  res.redirect(safeNext);
}

export function logoutHandler(_req: Request, res: Response) {
  res.set("Set-Cookie", buildSetCookie("", 0));
  res.redirect("/login");
}
