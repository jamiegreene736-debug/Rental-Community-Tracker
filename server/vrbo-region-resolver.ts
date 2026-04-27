// Resolve Vrbo `regionId` + `latLong` for a destination.
//
// Vrbo's search refuses to return results when `destination=<city>` is
// passed without disambiguators — the actor's documented working URL
// shows both `regionId=652645981589159936` and `latLong=39.096,-120.033`
// alongside the human-readable destination string. Our find-buy-in calls
// to the Apify Vrbo actor were returning 0 raw items because we omitted
// these.
//
// This resolver returns the disambiguators in three tiers:
//
//   1. Hardcoded `KNOWN_REGIONS` map. Zero latency. Covers our active
//      Hawaii markets (Koloa, Wailea, Lahaina, Princeville, Kapaa).
//   2. In-memory cache populated by previous resolver calls (across
//      requests, until process restart). 7-day soft TTL.
//   3. Browserbase fetch of Vrbo's destination SEO page
//      (`/lodging/<slug>-vacation-rentals`). Extracts regionId + latLong
//      from JSON-LD / `__APP_INITIAL_STATE__` window blob. Caches result.
//
// Only tier 3 burns a Browserbase session (~$0.005). Tier 1 covers our
// common destinations, so most calls hit it.
//
// `regionId` values are stable identifiers Vrbo assigns once and rarely
// changes. If a hardcoded value goes stale, the symptom is "0 results"
// from Apify, and we'd resolve via Browserbase + cache to recover.

import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";

export type VrboRegion = {
  /** Vrbo's internal place identifier — typically 18 digits. */
  regionId: string;
  /** "<lat>,<lng>" with full precision Vrbo uses in search URLs. */
  latLong: string;
  /** Display destination string Vrbo expects in search URLs.
   * Often longer than the input (e.g. "Lake Tahoe, United States of America"). */
  displayDestination: string;
};

// Hardcoded constants for our active markets. Populate this map AFTER
// observing successful Browserbase resolutions (look for the
// `[vrbo-region] resolved <dest> → regionId=...` log line) — that gives
// us verified Vrbo regionIds we know work in their search.
//
// Keys are lowercased "city, state, country" canonical forms — the
// resolver normalizes input the same way before lookup.
//
// Empty for now: every destination resolves via Browserbase + cache on
// first encounter, then the dynamic cache services subsequent calls
// for 7 days. After we've observed the regionIds that work for our
// active markets, paste them here so cold starts skip the Browserbase
// hop entirely.
const KNOWN_REGIONS: Record<string, VrboRegion> = {};

// In-memory cache for resolutions discovered via Browserbase. Survives
// across requests within a single process boot.
type CacheEntry = { value: VrboRegion | null; expiresAt: number };
const dynamicCache = new Map<string, CacheEntry>();
const RESOLUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Negative-cache TTL — when Browserbase resolution fails, don't keep
// retrying for every find-buy-in call. 1 hour is a balance: recovers
// quickly if the Vrbo page format changes, doesn't hammer Browserbase
// during a transient outage.
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

function normalizeDest(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function knownLookup(destination: string): VrboRegion | null {
  return KNOWN_REGIONS[normalizeDest(destination)] ?? null;
}

function cacheLookup(destination: string): VrboRegion | null | undefined {
  const entry = dynamicCache.get(normalizeDest(destination));
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.value;
}

// Convert "Koloa, HI, United States" → "koloa-vacation-rentals" for
// Vrbo's SEO destination URL pattern.
function destinationToSlug(destination: string): string {
  const city = destination.split(",")[0]?.trim() ?? destination;
  return city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-vacation-rentals";
}

// Extract regionId + latLong from Vrbo's destination page HTML.
// Vrbo embeds these in a `window.__APP_INITIAL_STATE__` JSON blob and
// in JSON-LD `<script type="application/ld+json">` blocks.
function extractRegionFromHtml(html: string): VrboRegion | null {
  // Pattern 1: JSON-LD with @type Place / TouristAttraction / City.
  // Look for "geo":{"latitude":N,"longitude":N}.
  const geoMatch = html.match(/"geo"\s*:\s*\{\s*[^}]*?"latitude"\s*:\s*(-?[\d.]+)[^}]*?"longitude"\s*:\s*(-?[\d.]+)/);
  // Pattern 2: regionId / region_id field — 12+ digits, often inside
  // `__APP_INITIAL_STATE__` or `data-store` JSON.
  const regionMatch =
    html.match(/"regionId"\s*:\s*"?(\d{6,})"?/i) ??
    html.match(/"region_id"\s*:\s*"?(\d{6,})"?/i);
  if (!regionMatch) return null;
  const regionId = regionMatch[1];
  const lat = geoMatch?.[1];
  const lng = geoMatch?.[2];
  // Even without geo, regionId alone is often enough for Vrbo's search.
  return {
    regionId,
    latLong: lat && lng ? `${lat},${lng}` : "",
    displayDestination: "",
  };
}

async function resolveViaBrowserbase(
  destination: string,
  bbApiKey: string,
  bbProjectId: string,
): Promise<VrboRegion | null> {
  const slug = destinationToSlug(destination);
  const url = `https://www.vrbo.com/lodging/${slug}`;

  const bb = new Browserbase({ apiKey: bbApiKey });
  const session = await bb.sessions.create({ projectId: bbProjectId, proxies: true });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());
    await ctx.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Vrbo's __APP_INITIAL_STATE__ ships in the initial HTML; no need to
    // wait for client hydration.
    const html = await page.content();
    const region = extractRegionFromHtml(html);
    if (region) {
      // Fill in the displayDestination from the page's <title> or meta
      // when available — keeps the URL human-readable for debugging.
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch) {
        // "Koloa Vacation Rentals: Koloa, HI Lodging | Vrbo" → "Koloa, HI"
        const t = titleMatch[1];
        const m = t.match(/([A-Za-z][\w\s,'-]{2,40},\s*[A-Z]{2})/);
        if (m) region.displayDestination = `${m[1]}, United States of America`;
      }
      console.log(`[vrbo-region] resolved ${destination} → regionId=${region.regionId} latLong=${region.latLong}`);
    } else {
      console.warn(`[vrbo-region] no regionId found in ${url}`);
    }
    return region;
  } catch (e: any) {
    console.warn(`[vrbo-region] error resolving ${destination}: ${e?.message ?? e}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await bb.sessions.update(session.id, { projectId: bbProjectId, status: "REQUEST_RELEASE" }).catch(() => {});
  }
}

export async function resolveVrboRegion(opts: {
  destination: string;
  /** When omitted, only the hardcoded + dynamic caches are checked. */
  bbApiKey?: string;
  bbProjectId?: string;
}): Promise<VrboRegion | null> {
  const { destination, bbApiKey, bbProjectId } = opts;
  // Tier 1: hardcoded
  const known = knownLookup(destination);
  if (known) return known;
  // Tier 2: in-memory cache
  const cached = cacheLookup(destination);
  if (cached !== undefined) return cached;
  // Tier 3: Browserbase fetch
  if (!bbApiKey || !bbProjectId) {
    // Caller didn't pass credentials → can't do tier 3. Cache short
    // negative result so we don't try again on every call.
    dynamicCache.set(normalizeDest(destination), {
      value: null,
      expiresAt: Date.now() + NEGATIVE_TTL_MS,
    });
    return null;
  }
  const resolved = await resolveViaBrowserbase(destination, bbApiKey, bbProjectId);
  dynamicCache.set(normalizeDest(destination), {
    value: resolved,
    expiresAt: Date.now() + (resolved ? RESOLUTION_TTL_MS : NEGATIVE_TTL_MS),
  });
  return resolved;
}
