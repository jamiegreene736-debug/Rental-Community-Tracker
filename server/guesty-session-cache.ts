// Cache layer for Guesty Playwright session credentials.
//
// Background: until this file existed, the Playwright stack read
// GUESTY_SESSION_COOKIES + GUESTY_OKTA_TOKEN_STORAGE straight off
// process.env. That meant every cookie expiry (~weekly) required the
// operator to manually paste fresh values into Railway's env-var UI and
// trigger a redeploy — ~5 min of toil per refresh.
//
// This cache adds two things:
//
//   1. A file-on-volume override that takes precedence over the env vars,
//      so an admin endpoint can refresh the cookies without a redeploy.
//      File lives at process.cwd() (Railway volume mount root) — same
//      pattern as `.guesty_token_cache.json` written by guesty-token.ts.
//
//   2. A Browserbase persistent-context ID slot. Once the operator has
//      bootstrapped a Browserbase context (one-time), the
//      guesty-browserbase-login refresh path can drive a fresh login
//      against that context's residential IP + device-trust cookies and
//      write the refreshed cookies straight back into this cache. No
//      operator involvement.
//
// Layered read order:
//   1. In-memory cache (process lifetime)
//   2. File on volume (.guesty_session_cache.json)
//   3. Env vars GUESTY_SESSION_COOKIES + GUESTY_OKTA_TOKEN_STORAGE
//      (still respected so legacy deploys keep working — the cache
//      is purely additive)
//
// Writes only ever land in memory + file; env vars are read-only.

import fs from "fs";
import path from "path";

// Same "Cookie-Editor export" shape the existing parseGuestyCookies()
// uses — copied here so we don't introduce a circular import between
// guesty-playwright.ts and this file.
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
  // Raw cookies in Cookie-Editor JSON shape — same format the env var
  // accepts, so the parsers downstream don't care which source served them.
  cookies: RawCookieRecord[];
  // Raw `okta-token-storage` localStorage value (a JSON string itself).
  oktaTokenStorage: string | null;
  // Browserbase persistent-context ID. Set once via the bootstrap
  // endpoint; read by guesty-browserbase-login on every refresh.
  browserbaseContextId: string | null;
  // Bookkeeping — surfaced via /api/admin/guesty/session-status so the
  // operator can see how stale the cache is and where it came from.
  lastRefreshedAt: number;
  source: "manual-paste" | "browserbase-refresh" | "env-var-bootstrap";
};

const CACHE_FILE = path.join(
  process.cwd(),
  ".guesty_session_cache.json",
);

let memCache: Cached | null = null;

function readFile(): Cached | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cached;
    // Defensive: if the shape is wrong (e.g. an older cache file from a
    // previous schema), treat as empty rather than crash callers.
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
    // Non-fatal — memory cache still lives, just won't survive a restart.
    console.error("[guesty-session-cache] file write failed:", (err as Error).message);
  }
}

/**
 * Read the cached session if anything has been written. Returns null when
 * neither memory nor file have a record — caller should fall back to env
 * vars. Does NOT auto-promote env vars into the cache; the env-var path
 * stays env-var-only so the manual operator workflow keeps working.
 */
export function getCachedSession(): Cached | null {
  if (memCache) return memCache;
  const fromFile = readFile();
  if (fromFile) {
    memCache = fromFile;
    return fromFile;
  }
  return null;
}

/**
 * Update the cache with a partial patch. Always bumps `lastRefreshedAt`.
 * Use the second arg's `source` to record where the patch came from
 * (manual paste, automated Browserbase refresh, etc.) — purely for the
 * status endpoint, not load-bearing.
 */
export function setCachedSession(
  patch: Partial<Pick<Cached, "cookies" | "oktaTokenStorage" | "browserbaseContextId">>,
  source: Cached["source"],
): Cached {
  const prior = memCache ?? readFile();
  const merged: Cached = {
    cookies: patch.cookies ?? prior?.cookies ?? [],
    oktaTokenStorage:
      patch.oktaTokenStorage !== undefined
        ? patch.oktaTokenStorage
        : prior?.oktaTokenStorage ?? null,
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

/**
 * Status snapshot for the debug endpoint. Returns booleans + metadata
 * only — never the cookie or token values themselves, so this is safe to
 * call without an admin secret if we ever want to expose a non-secret
 * health check.
 */
export function getSessionStatus(): {
  hasCachedCookies: boolean;
  cookieCount: number;
  hasOktaToken: boolean;
  hasBrowserbaseContext: boolean;
  lastRefreshedAt: string | null;
  source: Cached["source"] | null;
} {
  const c = getCachedSession();
  return {
    hasCachedCookies: !!c && c.cookies.length > 0,
    cookieCount: c?.cookies.length ?? 0,
    hasOktaToken: !!c?.oktaTokenStorage,
    hasBrowserbaseContext: !!c?.browserbaseContextId,
    lastRefreshedAt: c ? new Date(c.lastRefreshedAt).toISOString() : null,
    source: c?.source ?? null,
  };
}

/**
 * Returns the cookie JSON string that parseGuestyCookies should use.
 * Prefers the cache; falls back to GUESTY_SESSION_COOKIES env var.
 *
 * Returning the raw JSON string (rather than parsed cookies) keeps the
 * existing parseGuestyCookies() shape — that function does its own
 * normalization and we don't want to duplicate it.
 */
export function resolveGuestyCookieJson(): string | null {
  const c = getCachedSession();
  if (c && c.cookies.length > 0) return JSON.stringify(c.cookies);
  return process.env.GUESTY_SESSION_COOKIES ?? null;
}

/**
 * Returns the `okta-token-storage` localStorage value to inject. Prefers
 * the cache; falls back to GUESTY_OKTA_TOKEN_STORAGE env var.
 */
export function resolveOktaTokenStorage(): string | null {
  const c = getCachedSession();
  if (c?.oktaTokenStorage) return c.oktaTokenStorage;
  return process.env.GUESTY_OKTA_TOKEN_STORAGE ?? null;
}

/**
 * Returns the bootstrapped Browserbase context ID (if any). Read by the
 * Browserbase refresh helper. Null when bootstrap hasn't happened — the
 * refresh path returns a clear error in that case.
 */
export function resolveBrowserbaseContextId(): string | null {
  const c = getCachedSession();
  return c?.browserbaseContextId ?? null;
}
