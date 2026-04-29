// Cache layer for Vrbo Browserbase persistent-context state.
//
// Why this exists: Vrbo's anti-bot fingerprints Browserbase residential
// proxy sessions and serves a "Show us your human side..." spin-and-block
// page before the UI ever loads. Direct verification (PR #265 diagnostic):
// Chrome session from operator's real IP passes through cleanly and
// returns 42 priced properties for Poipu Kai Jun 13-20 2026; Browserbase
// session for the same query never reaches Vrbo's homepage.
//
// Same architectural pattern as guesty-session-cache.ts (PR #261). One-
// time bootstrap: operator exports vrbo.com cookies from their real
// Chrome session via Cookie-Editor, posts to a bootstrap endpoint, server
// creates a Browserbase persistent context with those cookies. Vrbo
// treats subsequent Browserbase sessions as the same returning real user
// from a known device — bot wall stays down.
//
// Layered read order:
//   1. In-memory cache (process lifetime)
//   2. File on volume (.vrbo_session_cache.json at process.cwd())
//   3. (no env-var fallback — Vrbo cookies are too volatile to ship in
//      env vars; the bootstrap endpoint is the only write path)
//
// Writes only ever land in memory + file.

import fs from "fs";
import path from "path";

export type RawCookieRecord = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expirationDate?: number;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

type Cached = {
  // Raw cookies in Cookie-Editor JSON shape — same format the bootstrap
  // endpoint accepts. Kept here for diagnostics + manual paste fallback.
  // Browserbase persistent context handles the cookie reuse on its own
  // once the contextId is set; we don't need to re-inject cookies on
  // every session.
  cookies: RawCookieRecord[];
  // Browserbase persistent-context ID. Set once via the bootstrap
  // endpoint; read by stagehand-vrbo-search on every find-buy-in to
  // attach the persistent context to the session.
  browserbaseContextId: string | null;
  // Bookkeeping.
  lastRefreshedAt: number;
  source: "manual-paste" | "auto-refresh";
};

const CACHE_FILE = path.join(process.cwd(), ".vrbo_session_cache.json");

let memCache: Cached | null = null;

function readFile(): Cached | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cached;
    if (!data || typeof data !== "object" || !Array.isArray(data.cookies)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function writeFile(c: Cached): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), "utf8");
  } catch (err) {
    console.error("[vrbo-session-cache] file write failed:", (err as Error).message);
  }
}

export function getCachedSession(): Cached | null {
  if (memCache) return memCache;
  const fromFile = readFile();
  if (fromFile) {
    memCache = fromFile;
    return fromFile;
  }
  return null;
}

export function setCachedSession(
  patch: Partial<Pick<Cached, "cookies" | "browserbaseContextId">>,
  source: Cached["source"],
): Cached {
  const prior = memCache ?? readFile();
  const merged: Cached = {
    cookies: patch.cookies ?? prior?.cookies ?? [],
    browserbaseContextId:
      patch.browserbaseContextId !== undefined
        ? patch.browserbaseContextId
        : prior?.browserbaseContextId ?? null,
    lastRefreshedAt: Date.now(),
    source,
  };
  memCache = merged;
  writeFile(merged);
  return merged;
}

export function getSessionStatus(): {
  hasCachedCookies: boolean;
  cookieCount: number;
  hasBrowserbaseContext: boolean;
  lastRefreshedAt: string | null;
  source: Cached["source"] | null;
} {
  const c = getCachedSession();
  return {
    hasCachedCookies: !!c && c.cookies.length > 0,
    cookieCount: c?.cookies.length ?? 0,
    hasBrowserbaseContext: !!c?.browserbaseContextId,
    lastRefreshedAt: c ? new Date(c.lastRefreshedAt).toISOString() : null,
    source: c?.source ?? null,
  };
}

export function resolveBrowserbaseContextId(): string | null {
  const c = getCachedSession();
  return c?.browserbaseContextId ?? null;
}
