// Single source of truth for the Guesty OAuth token.
//
// Guesty's /oauth2/token endpoint is rate-limited to ~5 requests per 24h.
// Hitting 429 once wedges the whole app until the quota window resets.
// Defense in depth:
//   1. In-memory cache (process lifetime)
//   2. Postgres row — survives deploys & container restarts (primary)
//   3. Local file — fallback if DB is down (ephemeral on Railway but still
//      useful in dev and for multi-request-per-run coherence)
//   4. Refresh-in-flight promise deduplication — if 10 concurrent API calls
//      notice the token expired, only ONE actually hits /oauth2/token.
//   5. Admin override — lets you manually paste a known-good token to
//      bypass a live 429 and unstick the app without redeploying.
//
// Both routes.ts (the /api/guesty-token endpoint and the /api/guesty-proxy/*
// bearer injection) and guesty-sync.ts MUST route through getGuestyToken()
// so only one refresh path exists.

import fs from "fs";
import path from "path";
import { db } from "./db";
import { guestyTokenCache } from "@shared/schema";
import { eq } from "drizzle-orm";

const GUESTY_TOKEN_FILE = path.join(process.cwd(), ".guesty_token_cache.json");

type Cached = { token: string; expiry: number };

let memoryCache: Cached | null = null;
let inflightRefresh: Promise<string> | null = null;

// ── Layer 1: memory ───────────────────────────────────────────
function readMemory(): Cached | null {
  if (memoryCache && Date.now() < memoryCache.expiry) return memoryCache;
  return null;
}

// ── Layer 2: Postgres ─────────────────────────────────────────
async function readDB(): Promise<Cached | null> {
  try {
    const rows = await db.select().from(guestyTokenCache).limit(1);
    const row = rows[0];
    if (!row) return null;
    const expiryMs = new Date(row.expiry).getTime();
    if (Date.now() < expiryMs) return { token: row.token, expiry: expiryMs };
    return null;
  } catch (err: any) {
    // Most common reason: table doesn't exist yet (db:push not run).
    if (!/42P01|does not exist/i.test(err.message ?? "")) {
      console.error("[guesty-token] DB read error:", err.message);
    }
    return null;
  }
}

async function writeDB(c: Cached): Promise<void> {
  try {
    // Upsert single row: delete-then-insert is simplest since we only ever
    // keep one token row.
    await db.delete(guestyTokenCache);
    await db.insert(guestyTokenCache).values({
      token: c.token,
      expiry: new Date(c.expiry),
    });
  } catch (err: any) {
    if (!/42P01|does not exist/i.test(err.message ?? "")) {
      console.error("[guesty-token] DB write error:", err.message);
    }
  }
}

// ── Layer 3: file ─────────────────────────────────────────────
function readFile(): Cached | null {
  try {
    if (!fs.existsSync(GUESTY_TOKEN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(GUESTY_TOKEN_FILE, "utf8")) as Cached;
    if (data.token && data.expiry && Date.now() < data.expiry) return data;
    return null;
  } catch { return null; }
}

function writeFile(c: Cached): void {
  try { fs.writeFileSync(GUESTY_TOKEN_FILE, JSON.stringify(c), "utf8"); } catch { /* ok */ }
}

// ── Fetch a fresh token from Guesty (rate-limited — use sparingly) ──
async function fetchFreshToken(): Promise<Cached> {
  const clientId = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GUESTY_CLIENT_ID / GUESTY_CLIENT_SECRET not set");
  }

  console.log("[guesty-token] refreshing token (hitting /oauth2/token)");
  const resp = await fetch("https://open-api.guesty.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "open-api",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 429) {
      // Rate limited — try the persistent caches one more time before failing.
      const fallback = (await readDB()) ?? readFile();
      if (fallback) {
        console.warn("[guesty-token] 429 — serving stale-but-valid cached token");
        memoryCache = fallback;
        return fallback;
      }
      throw new RateLimitedError("Guesty token endpoint rate-limited (429) and no cached token available. Paste a fresh token via POST /api/admin/guesty-token/set or wait for the 24h quota to reset.");
    }
    throw new Error(`Guesty token error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  // Subtract 60s from expiry to give ourselves a safety margin.
  const expiry = Date.now() + (data.expires_in - 60) * 1000;
  const cached: Cached = { token: data.access_token, expiry };

  memoryCache = cached;
  await writeDB(cached);
  writeFile(cached);
  console.log(`[guesty-token] refreshed — valid for ${Math.round(data.expires_in / 60)} min`);
  return cached;
}

export class RateLimitedError extends Error {
  readonly rateLimited = true;
  constructor(msg: string) {
    super(msg);
    this.name = "RateLimitedError";
  }
}

/**
 * Main entry point. Returns a valid Guesty access token, fetching a new one
 * only if every cache layer misses. Concurrent callers share one refresh.
 */
export async function getGuestyToken(): Promise<string> {
  // 1. Memory
  const mem = readMemory();
  if (mem) return mem.token;

  // 2. DB
  const dbCached = await readDB();
  if (dbCached) {
    memoryCache = dbCached;
    // Opportunistic: also refresh the file so local dev stays warm.
    writeFile(dbCached);
    return dbCached.token;
  }

  // 3. File
  const fileCached = readFile();
  if (fileCached) {
    memoryCache = fileCached;
    // Copy forward to DB so future cold starts skip the file step.
    await writeDB(fileCached);
    return fileCached.token;
  }

  // 4. Fresh — but dedupe concurrent callers
  if (!inflightRefresh) {
    inflightRefresh = fetchFreshToken()
      .then((c) => c.token)
      .finally(() => { inflightRefresh = null; });
  }
  return inflightRefresh;
}

/**
 * Force-refresh (use only when you know the current token is invalid, e.g.
 * an API call just came back with 401). Still deduped.
 */
export async function refreshGuestyToken(): Promise<string> {
  memoryCache = null;
  if (!inflightRefresh) {
    inflightRefresh = fetchFreshToken()
      .then((c) => c.token)
      .finally(() => { inflightRefresh = null; });
  }
  return inflightRefresh;
}

/**
 * Admin override — manually set a known-good token. Useful when Guesty is
 * rate-limiting /oauth2/token and you copy a token from Guesty's UI.
 */
export async function setGuestyTokenManually(token: string, expiresInSeconds: number): Promise<void> {
  const expiry = Date.now() + (Math.max(60, expiresInSeconds) - 60) * 1000;
  const cached: Cached = { token, expiry };
  memoryCache = cached;
  await writeDB(cached);
  writeFile(cached);
}

/**
 * Returns cache state for debugging (no secrets).
 */
export async function getGuestyTokenStatus(): Promise<{
  hasToken: boolean;
  expiresInSeconds: number | null;
  source: "memory" | "db" | "file" | "none";
}> {
  const mem = readMemory();
  if (mem) return { hasToken: true, expiresInSeconds: Math.round((mem.expiry - Date.now()) / 1000), source: "memory" };
  const dbC = await readDB();
  if (dbC) return { hasToken: true, expiresInSeconds: Math.round((dbC.expiry - Date.now()) / 1000), source: "db" };
  const fileC = readFile();
  if (fileC) return { hasToken: true, expiresInSeconds: Math.round((fileC.expiry - Date.now()) / 1000), source: "file" };
  return { hasToken: false, expiresInSeconds: null, source: "none" };
}
