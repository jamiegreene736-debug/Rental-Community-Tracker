// Cookie cache that bridges the Chrome extension → daemon flow.
//
// Architecture:
//   1. Operator installs the VRBO Sidecar Cookie Sync extension in
//      Chrome (~/Downloads/vrbo-sidecar-cookie-extension/).
//   2. Whenever vrbo.com / booking.com / expedia.com cookies change in
//      that Chrome (login, refresh, expiry rotation), the extension's
//      service worker debounces 5s then POSTs the full cookie array
//      here.
//   3. The daemon (~/Downloads/vrbo-sidecar/worker.mjs) pulls from
//      /api/admin/vrbo-sidecar/cookies on each tick and reseeds its
//      Chrome context if anything changed.
//
// Net effect: the operator never has to manually export Cookie-Editor
// JSON again. As long as they're logged into the watched sites in
// the Chrome where the extension lives, sessions stay fresh.
//
// Storage: in-memory + file-on-volume mirror (process.cwd()/.sidecar_
// cookies.json). Same pattern as guesty-session-cache.ts. File survives
// Railway restart so the daemon can fetch valid cookies even right
// after a deploy before the extension fires its first push.

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
  cookies: RawCookieRecord[];
  // Bookkeeping the UI / debug surfaces care about.
  lastPushedAt: number;
  source: string; // free-form, e.g. "extension v1.0.0"
  // Hash of cookie name+value+domain set, for cheap "did anything
  // change?" checks by the daemon.
  fingerprint: string;
};

const CACHE_FILE = path.join(process.cwd(), ".sidecar_cookies.json");

let memCache: Cached | null = null;

function readFile(): Cached | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cached;
    if (!data || !Array.isArray(data.cookies)) return null;
    return data;
  } catch {
    return null;
  }
}

function writeFile(c: Cached): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), "utf8");
  } catch (err) {
    console.error("[sidecar-cookies] file write failed:", (err as Error).message);
  }
}

function fingerprint(cookies: RawCookieRecord[]): string {
  // Stable fingerprint: sort by domain|name, hash with a simple
  // string concatenation. Daemon compares this against what it last
  // applied to skip no-op reseeds.
  const sorted = [...cookies]
    .filter((c) => c?.name && c?.domain)
    .sort((a, b) =>
      `${a.domain}|${a.name}`.localeCompare(`${b.domain}|${b.name}`),
    );
  let h = 0;
  for (const c of sorted) {
    const s = `${c.domain}|${c.name}|${c.value ?? ""}`;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }
  return `${cookies.length}-${(h >>> 0).toString(16)}`;
}

export function pushCookies(opts: {
  cookies: RawCookieRecord[];
  source?: string;
}): { ok: true; stored: number; fingerprint: string; changed: boolean } {
  const cookies = (opts.cookies ?? []).filter(
    (c) => c?.name && c?.domain,
  );
  const fp = fingerprint(cookies);
  const prior = memCache ?? readFile();
  const changed = !prior || prior.fingerprint !== fp;
  const merged: Cached = {
    cookies,
    lastPushedAt: Date.now(),
    source: opts.source || "unknown",
    fingerprint: fp,
  };
  memCache = merged;
  writeFile(merged);
  return { ok: true, stored: cookies.length, fingerprint: fp, changed };
}

export function getCookies(): {
  cookies: RawCookieRecord[];
  lastPushedAt: string | null;
  source: string | null;
  fingerprint: string | null;
} {
  const c = memCache ?? readFile();
  if (!c) {
    return { cookies: [], lastPushedAt: null, source: null, fingerprint: null };
  }
  if (!memCache) memCache = c;
  return {
    cookies: c.cookies,
    lastPushedAt: new Date(c.lastPushedAt).toISOString(),
    source: c.source,
    fingerprint: c.fingerprint,
  };
}

export function getCookiesStatus(): {
  hasCookies: boolean;
  cookieCount: number;
  lastPushedAt: string | null;
  source: string | null;
  fingerprint: string | null;
  domainBreakdown: Record<string, number>;
} {
  const c = memCache ?? readFile();
  if (!c) {
    return {
      hasCookies: false,
      cookieCount: 0,
      lastPushedAt: null,
      source: null,
      fingerprint: null,
      domainBreakdown: {},
    };
  }
  const domainBreakdown: Record<string, number> = {};
  for (const cookie of c.cookies) {
    const d = cookie.domain.replace(/^\./, "");
    const root = d.split(".").slice(-2).join(".");
    domainBreakdown[root] = (domainBreakdown[root] ?? 0) + 1;
  }
  return {
    hasCookies: c.cookies.length > 0,
    cookieCount: c.cookies.length,
    lastPushedAt: new Date(c.lastPushedAt).toISOString(),
    source: c.source,
    fingerprint: c.fingerprint,
    domainBreakdown,
  };
}
