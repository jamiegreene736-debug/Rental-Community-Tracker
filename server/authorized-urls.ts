// Authoritative set of "listing URLs we own on Airbnb / VRBO /
// Booking.com" — derived from Guesty's per-listing `integrations[]`
// payload. The photo-listing scanner and preflight consult this set to
// suppress false positives where a reverse-image / text search
// correctly matches OUR own published listing (not a thief's repost).
//
// Guesty data flow:
//   GET /listings?fields=integrations  → array of listing records.
//   Each listing carries `integrations[]`, one entry per connected
//   channel. The channel-specific sub-object (e.g. `integration.airbnb2`)
//   exposes a `listingUrl` / `url` / `publicUrl` / `propertyUrl` and a
//   platform-specific id (`id` on Airbnb, `hotelId` on Booking,
//   `advertiserId` on VRBO). See `/api/dashboard/channel-status` in
//   routes.ts for the flag-extraction pattern.
//
// We return a flat `Set<string>` of *normalized* URLs — lowercase host,
// no extension, no query/fragment, no trailing slash. Both the Guesty-
// reported URLs and any incoming candidate URLs get run through the
// same `normalizeListingUrl()` before comparison so
// `https://www.airbnb.com/rooms/123?check_in=...` matches
// `https://airbnb.com/rooms/123`.

import { guestyRequest } from "./guesty-sync";
import { storage } from "./storage";

const REFRESH_MS = 30 * 60 * 1000; // 30 minutes — Guesty data doesn't drift faster.

type CachedSet = { urls: Set<string>; at: number };
let cache: CachedSet | null = null;

export function normalizeListingUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname
    .replace(/\.[a-z0-9.-]+$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!host || !path) return null;
  return `${host}${path}`;
}

// Pluck the public URL out of a channel integration sub-object. Mirrors
// the ordering used by the client's guestyService.pickChannelUrl.
// For Airbnb we fall back to constructing a URL from the numeric id
// because Guesty does not always stamp the listingUrl even when the
// channel is live.
function pickChannelUrl(
  sub: Record<string, unknown> | undefined,
  platform: "airbnb" | "vrbo" | "booking",
): string | null {
  if (!sub) return null;
  for (const k of ["listingUrl", "url", "publicUrl", "propertyUrl"]) {
    const v = sub[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  if (platform === "airbnb") {
    const id = sub["id"] ?? sub["listingId"];
    if (typeof id === "string" && /^\d+$/.test(id)) return `https://www.airbnb.com/rooms/${id}`;
    if (typeof id === "number") return `https://www.airbnb.com/rooms/${id}`;
  }
  return null;
}

async function fetchAuthorizedUrls(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const map = await storage.getGuestyPropertyMap();
    if (map.length === 0) return out;
    const resp = await guestyRequest(
      "GET",
      `/listings?limit=200&fields=_id%20integrations`,
    ) as { results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const listings = Array.isArray(resp) ? resp : (resp.results ?? []);
    const findIntegration = (
      integrations: Array<Record<string, unknown>>,
      keys: string[],
    ): Record<string, unknown> | undefined => {
      const entry = integrations.find((i) => keys.includes(i.platform as string));
      if (!entry) return undefined;
      const k = entry.platform as string;
      return entry[k] as Record<string, unknown> | undefined;
    };
    for (const l of listings) {
      const integrations = Array.isArray(l.integrations)
        ? (l.integrations as Array<Record<string, unknown>>)
        : [];
      const airbnb  = pickChannelUrl(findIntegration(integrations, ["airbnb2", "airbnb"]),                     "airbnb");
      const vrbo    = pickChannelUrl(findIntegration(integrations, ["homeaway2", "homeaway", "vrbo"]),         "vrbo");
      const booking = pickChannelUrl(findIntegration(integrations, ["bookingCom2", "bookingCom", "booking_com"]), "booking");
      for (const u of [airbnb, vrbo, booking]) {
        const n = normalizeListingUrl(u);
        if (n) out.add(n);
      }
    }
  } catch (e: any) {
    console.error(`[authorized-urls] fetch failed: ${e?.message}`);
    // Return whatever we collected so far — consumers treat an empty
    // set as "no suppression, scan normally."
  }
  return out;
}

// Returns the set of normalized authorized URLs, cached for 30 minutes.
// Force a refresh with `{ force: true }`.
export async function getAuthorizedChannelUrls(
  opts: { force?: boolean } = {},
): Promise<Set<string>> {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < REFRESH_MS) return cache.urls;
  const urls = await fetchAuthorizedUrls();
  cache = { urls, at: now };
  console.error(`[authorized-urls] refreshed: ${urls.size} URLs cached`);
  return urls;
}

// True if `url` is one of our own authorized listings. Handles
// normalization on both sides.
export function isAuthorizedUrl(url: string, set: Set<string>): boolean {
  const n = normalizeListingUrl(url);
  if (!n) return false;
  return set.has(n);
}
