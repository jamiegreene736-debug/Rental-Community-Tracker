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
//   NOTE (2026-07-11 security fix): /api/admin/vrbo-sidecar/* and
//   /api/admin/buyin-agent/* are NO LONGER public. They were previously
//   allowlisted here on the theory that the local-Chrome sidecar and the
//   buy-in agent runner poll them from the operator's Mac over an
//   "implicitly trusted" channel — but the routes are served on the same
//   public Railway origin as everything else, so any anonymous internet
//   caller could poll /next (steal/observe jobs), POST forged /result
//   payloads (inject fake listings/prices/photos into buy-in decisions and
//   guest pages), read /tools/job-context (reservation + financial PII),
//   or drive the Anthropic-billed vision endpoints. The per-route
//   checkAdminSecret() backstop was a no-op. Both worker transports ALREADY
//   send X-Admin-Secret on every request (daemon/vrbo-sidecar/worker.mjs
//   authHeaders(); daemon/buyin-agent/runner.mjs), so requireAuth now gates
//   these paths uniformly: the workers pass via the header, an operator
//   viewing them passes via the admin cookie, loopback self-calls pass, and
//   anonymous callers get 401. OPERATOR ACTION: ADMIN_SECRET must be set
//   identically on the web service, the Railway sidecar-worker service, and
//   the local Mac LaunchAgents or the workers will 401.
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
//   - /alternatives/* — tokenized guest-facing alternative-stay photo pages.
//     Creation/drafting APIs stay protected; only the random-token rendered
//     page is public so it can be sent to a guest.
//   - /receipt/* — tokenized guest-facing payment/refund receipt pages
//     (server/guest-receipts.ts). Same model as /alternatives: only the
//     random-token rendered page is public; the creation path is the
//     server-side scheduler, and the operator-facing tracking/log/toggle APIs
//     stay protected.
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
  "/api/quo/webhooks/",
  "/agreement/",
  "/alternatives/",
  "/receipt/",
  "/admin/agreement/",
  "/api/rental-agreements/",
  // NOTE FOR CODEX (2026-07-19, headless Claude find-runs): these are the
  // TOKEN-authed endpoints the headless `claude -p` agent calls with curl —
  // it deliberately never holds ADMIN_SECRET (prompt-injection blast-radius
  // cap), so the cookie/header gate can't apply. EVERY handler under this
  // prefix verifies the per-run X-Run-Token (timing-safe, run-scoped,
  // dies with the run) before doing anything — see server/claude-find-runs.ts.
  // The operator-facing routes (create/claim/status/cancel) live OUTSIDE this
  // prefix and stay fully gated. Do not widen this to /api/claude-find-runs/.
  "/api/claude-find-runs/agent/",
];

const PUBLIC_PATH_EXACT = new Set<string>([
  "/login",
  "/logout",
  "/agreement",
  "/admin/agreement",
  // NOTE FOR CODEX: /guest-photo is the SIGNED photo-upscaling proxy embedded
  // in /alternatives/:token pages (guests are unauthenticated). It is NOT an
  // open proxy: requests need an HMAC `sig` minted at page render, and the
  // handler re-rejects IP-literal/internal hosts. See server/guest-photo-upscale.ts.
  "/guest-photo",
  // NOTE FOR CODEX: /healthz is the Railway deploy healthcheck target
  // (railway.json healthcheckPath). It returns a static {ok:true} and exposes
  // nothing. Railway's prober has no cookie/X-Admin-Secret, so removing this
  // entry (or the matching early route in server/index.ts) makes every deploy
  // fail its healthcheck and never go live. See AGENTS.md "Deploy healthcheck".
  "/healthz",
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

export function isLoopback(req: Request): boolean {
  const sock = req.socket?.remoteAddress ?? "";
  return sock === "127.0.0.1" || sock === "::ffff:127.0.0.1" || sock === "::1";
}

/** Headers for same-process HTTP self-calls (queue workers, schedulers). */
export function loopbackRequestHeaders(contentType = "application/json"): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  const secret = process.env.ADMIN_SECRET ?? "";
  if (secret) headers["X-Admin-Secret"] = secret;
  return headers;
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
  // Verified Guesty send (replaces the client-direct guesty-proxy /send-message
  // at line ~220 for inbox replies + receipts) — agent-role inbox users send too.
  if (method === "POST" && /^\/api\/inbox\/conversations\/[^/]+\/send$/.test(path)) return true;
  if ((method === "PUT" || method === "PATCH") && /^\/api\/inbox\/sms\/conversations\/[^/]+\/(phone|links)$/.test(path)) return true;
  if (method === "GET" && path.startsWith("/api/inbox/calls/")) return true;
  // Unmatched texts ("Texts" tab): third-party SMS to the Quo number with no
  // Guesty conversation (e.g. Canary verification links). Agents work the
  // inbox and forward these links to guests. The link-to-booking stamp
  // (/api/inbox/unmatched-texts/link) stays admin-only: deliberately NOT listed.
  if (method === "GET" && path === "/api/inbox/unmatched-texts") return true;
  if (method === "POST" && path === "/api/inbox/unmatched-texts/reply") return true;
  if (method === "POST" && /^\/api\/inbox\/calls\/(\d+|conversations\/[^/]+)\/acknowledge$/.test(path)) return true;
  if (method === "POST" && path === "/api/inbox/ai-draft") return true;
  // Guest-question tier badges (read-only): the agent works the same inbox and
  // needs to see which threads the AI auto-answered (tier 1) vs which need a
  // human (tier 2). The tier-1 toggle + the full auto-reply log stay admin-only.
  if (method === "GET" && path === "/api/inbox/auto-reply/tiers") return true;

  // Guest issues tracker — remote agents open issues, read them, and comment /
  // change status ("resolved" / "ongoing"). DELETE is deliberately NOT listed,
  // so only the operator (admin) can remove an issue.
  if (method === "GET" && /^\/api\/inbox\/guest-issues(\/[^/]+)?$/.test(path)) return true;
  if (method === "POST" && path === "/api/inbox/guest-issues") return true;
  if (method === "POST" && /^\/api\/inbox\/guest-issues\/\d+\/comments$/.test(path)) return true;

  if (method === "GET" && /^\/api\/bookings\/[^/]+\/(arrival-details|buy-in-communications|rental-agreement)$/.test(path)) return true;

  // Agent-limited buy-in view (2026-07-20): the agent sees ONLY reservations
  // the operator shared via "Show in agent portal" — the handlers enforce the
  // reservation_agent_shares gate + a financial-field whitelist projection
  // (shared/agent-buyin-view.ts), so allowlisting the paths is safe.
  // /api/agent-shares (the toggle) stays admin-only: deliberately NOT listed.
  if (method === "GET" && path === "/api/agent/shared-bookings") return true;
  // Reply to the PM from the unit alias — handler 403s unless the buy-in's
  // reservation is shared with the agent portal.
  if (method === "POST" && /^\/api\/buy-ins\/\d+\/vendor-email$/.test(path)) return true;
  // PM SMS/Text History (read-only for agents; same share gate in the handler)
  // — part of the 2026-07-21 "show the reservation as if I am clicking into
  // it" expanded view. The SEND route stays operator-only: not listed.
  if (method === "GET" && /^\/api\/buy-ins\/\d+\/pm-sms$/.test(path)) return true;

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

// Agent-role logins (role "agent" → identical rights/views, gated by
// isAgentAllowedPath). Passwords are compared in constant time.
//
// SECURITY (2026-07-11): these were previously hardcoded here in plaintext,
// which is unsafe in a public repo — anyone reading this file could sign in
// as an agent and reach the guest inbox + reservation PII. Credentials now
// come ONLY from the AGENT_LOGINS env var; nothing is compiled in. Unset =>
// agent sign-in is disabled entirely.
//
// Format (either works):
//   1. JSON array:  AGENT_LOGINS='[{"username":"christalh","password":"…"}]'
//   2. Pair list:   AGENT_LOGINS='christalh:…,agent:…'
// Use the JSON form if a password contains a comma. Usernames are matched
// case-insensitively; passwords are used verbatim (not trimmed).
// OPERATOR ACTION: set AGENT_LOGINS in Railway with NEW passwords — the old
// "agent"/"agent" and "christalh"/"VacationRentalz@12" values are burned
// (they were committed to a public repo) and no longer work until reissued.
function loadAgentLogins(): ReadonlyArray<{ username: string; password: string }> {
  const raw = (process.env.AGENT_LOGINS ?? "").trim();
  if (!raw) return [];
  const out: Array<{ username: string; password: string }> = [];
  // Preferred: JSON array of {username, password}.
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          const username = typeof e?.username === "string" ? e.username.trim().toLowerCase() : "";
          const password = typeof e?.password === "string" ? e.password : "";
          if (username && password) out.push({ username, password });
        }
        return out;
      }
    } catch {
      // Malformed JSON — fall through to the pair-list parser so a stray
      // bracket doesn't silently disable every agent login.
    }
  }
  // Fallback: comma-separated "username:password" pairs (first colon splits).
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const username = trimmed.slice(0, idx).trim().toLowerCase();
    const password = trimmed.slice(idx + 1);
    if (username && password) out.push({ username, password });
  }
  return out;
}

const AGENT_LOGINS: ReadonlyArray<{ username: string; password: string }> = loadAgentLogins();

export function resolveLoginRole(usernameRaw: string, password: string, adminSecret: string): PortalRole | null {
  const username = usernameRaw.trim().toLowerCase();
  if ((username === "" || username === "admin") && constantTimeEqual(password, adminSecret)) {
    return "admin";
  }
  for (const login of AGENT_LOGINS) {
    if (username === login.username && constantTimeEqual(password, login.password)) {
      return "agent";
    }
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

// ── Login brute-force limiter (in-memory, per client IP) ────────────────────
// 2026-07-11: POST /login had no throttling — the admin secret and agent
// passwords were guessable at network speed. This caps FAILED attempts per
// client IP within a rolling window; a successful login clears the bucket.
// NOTE: the key uses X-Forwarded-For (Railway's edge sets it to the real
// client) with a socket fallback — this is ONLY for rate-limit bucketing, NOT
// an auth decision, so an attacker spoofing XFF merely reshuffles their own
// bucket (the standard IP-limiter limitation) and gains no access. Auth itself
// still relies on the cookie/secret and the un-spoofable socket loopback check.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map<string, number[]>();

function loginClientKey(req: Request): string {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "unknown";
}

function recentLoginFailures(key: string, now: number): number[] {
  const arr = (loginFailures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (arr.length) loginFailures.set(key, arr);
  else loginFailures.delete(key);
  return arr;
}

export function isLoginRateLimited(req: Request): boolean {
  return recentLoginFailures(loginClientKey(req), Date.now()).length >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(req: Request): void {
  const now = Date.now();
  const key = loginClientKey(req);
  const arr = recentLoginFailures(key, now);
  arr.push(now);
  loginFailures.set(key, arr);
  if (loginFailures.size > 5000) {
    // Bound memory: drop buckets whose newest failure has aged out.
    loginFailures.forEach((v, k) => {
      if (!v.some((t) => now - t < LOGIN_WINDOW_MS)) loginFailures.delete(k);
    });
  }
}

function clearLoginFailures(req: Request): void {
  loginFailures.delete(loginClientKey(req));
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
  if (isLoginRateLimited(req)) {
    res.status(429);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.set("Retry-After", String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
    return res.send(LOGIN_HTML("Too many attempts. Please wait a few minutes and try again.", safeNext));
  }
  const role = resolveLoginRole(username, password, secret);
  if (!role) {
    recordLoginFailure(req);
    res.status(401);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store");
    return res.send(LOGIN_HTML("Incorrect username or password.", safeNext));
  }
  clearLoginFailures(req);
  res.set("Set-Cookie", buildSetCookie(buildRoleCookieValue(secret, role), Math.floor(COOKIE_MAX_AGE_MS / 1000)));
  res.redirect(role === "agent" && safeNext !== "/inbox" ? "/" : safeNext);
}

export function logoutHandler(_req: Request, res: Response) {
  res.set("Set-Cookie", buildSetCookie("", 0));
  res.redirect("/login");
}
