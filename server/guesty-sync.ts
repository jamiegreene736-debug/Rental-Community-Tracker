import { storage } from "./storage";
import { log } from "./index";
import { getGuestyToken } from "./guesty-token";
import {
  BUY_IN_MARKET_BOUNDS,
  searchLocationForBuyInMarket,
} from "@shared/buy-in-market";

import {
  guesty429MaxAttempts,
  guesty429PauseMs,
  parseRetryAfterMs,
  shouldRetryGuesty429,
} from "@shared/guesty-retry";
import { buildGuestyApiUrl } from "@shared/guesty-endpoint";

let guestyRequestGate: Promise<void> = Promise.resolve();
let nextGuestyRequestAt = 0;
let guestyRateLimitPauseUntil = 0;

async function waitForGuestyRequestSlot() {
  const minGapMs = Math.max(0, Number(process.env.GUESTY_REQUEST_MIN_GAP_MS ?? 500));
  const previous = guestyRequestGate.catch(() => undefined);
  const current = previous.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, nextGuestyRequestAt - now, guestyRateLimitPauseUntil - now);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextGuestyRequestAt = Date.now() + minGapMs;
  });
  guestyRequestGate = current;
  await current;
}

export async function guestyRequest(method: string, endpoint: string, body?: unknown) {
  // 429 RETRY IN PLACE (2026-07-20 "Failed to load bookings" incident): the
  // gate below already pauses FUTURE requests when a 429 lands, but the
  // request that received it used to throw immediately — an interactive
  // endpoint (bookings list, inbox) unlucky enough to fire inside the window
  // surfaced a hard 500. A 429 was never processed by Guesty, so re-queueing
  // through the gate (which now waits out the pause) is safe for EVERY
  // method. Bounded by GUESTY_429_RETRIES (default 2 extra attempts).
  const maxAttempts = guesty429MaxAttempts(process.env.GUESTY_429_RETRIES);
  const requestUrl = buildGuestyApiUrl(endpoint);
  let res!: Response;
  for (let attempt = 1; ; attempt++) {
    const token = await getGuestyToken();
    await waitForGuestyRequestSlot();
    res = await fetch(requestUrl, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.max(5_000, Number(process.env.GUESTY_REQUEST_TIMEOUT_MS ?? 25_000))),
    });
    if (res.ok) break;

    // Guesty error responses are inconsistent — sometimes JSON with message,
    // sometimes plain text, sometimes empty. Read once as text so we can
    // surface the actual body even when JSON parsing fails. Keeps the bubble
    // up message useful instead of a generic "Guesty 500".
    const rawText = await res.text().catch(() => "");
    let parsed: any = null;
    try { parsed = JSON.parse(rawText); } catch { /* not JSON */ }
    const message =
      parsed?.message
      || parsed?.error?.message
      || (typeof parsed?.error === "string" ? parsed.error : "")
      || (parsed && typeof parsed === "object" ? JSON.stringify(parsed).slice(0, 500) : "")
      || rawText.slice(0, 500)
      || `(no body)`;
    log(`[guesty] ${method} ${endpoint} → ${res.status}: ${message.slice(0, 300)}`, "guesty-error");
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    if (res.status === 429) {
      guestyRateLimitPauseUntil = Math.max(guestyRateLimitPauseUntil, Date.now() + guesty429PauseMs(retryAfterMs));
    }
    if (shouldRetryGuesty429(res.status, attempt, maxAttempts)) {
      log(`[guesty] 429 on ${method} ${endpoint} — waiting out the rate-limit pause, retry ${attempt}/${maxAttempts - 1}`, "guesty");
      continue;
    }
    const err = new Error(`Guesty ${res.status} on ${method} ${endpoint}: ${message}`) as Error & {
      status?: number;
      method?: string;
      endpoint?: string;
      rateLimited?: boolean;
      retryAfterMs?: number;
    };
    err.status = res.status;
    err.method = method;
    err.endpoint = endpoint;
    err.rateLimited = res.status === 429 || /rate.?limit|too many requests/i.test(message);
    err.retryAfterMs = retryAfterMs ?? undefined;
    throw err;
  }
  if (res.status === 204) return { success: true };

  // Guesty action endpoints sometimes return 200 with an empty body
  // after the action succeeds. Calling res.json() on that response
  // throws "Unexpected end of JSON input", which made successful
  // Airbnb pre-approvals look like failures in the inbox.
  const rawText = await res.text().catch(() => "");
  if (!rawText.trim()) return { success: true };
  try {
    return JSON.parse(rawText);
  } catch {
    return { success: true, raw: rawText.slice(0, 500) };
  }
}

const PROPERTY_UNIT_NEEDS: Record<number, { community: string; units: { bedrooms: number }[] }> = {
  4:  { community: "Poipu Kai",         units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  7:  { community: "Poipu Kai",         units: [{ bedrooms: 3 }, { bedrooms: 3 }, { bedrooms: 2 }] },
  8:  { community: "Poipu Kai",         units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  9:  { community: "Poipu Kai",         units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  10: { community: "Kekaha Beachfront",  units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  12: { community: "Kekaha Beachfront",  units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  14: { community: "Keauhou",            units: [{ bedrooms: 4 }, { bedrooms: 2 }] },
  18: { community: "Poipu Kai",         units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  19: { community: "Princeville",        units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  20: { community: "Princeville",        units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  21: { community: "Poipu Kai",         units: [{ bedrooms: 3 }, { bedrooms: 3 }, { bedrooms: 2 }] },
  23: { community: "Kapaa Beachfront",   units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  24: { community: "Poipu Oceanfront",   units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  26: { community: "Keauhou",            units: [{ bedrooms: 5 }, { bedrooms: 2 }] },
  27: { community: "Poipu Kai",         units: [{ bedrooms: 2 }, { bedrooms: 2 }] },
  28: { community: "Poipu Brenneckes",   units: [{ bedrooms: 4 }, { bedrooms: 3 }] },
  29: { community: "Princeville",        units: [{ bedrooms: 3 }, { bedrooms: 4 }] },
  31: { community: "Poipu Brenneckes",   units: [{ bedrooms: 5 }, { bedrooms: 2 }] },
  32: { community: "Pili Mai",           units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  33: { community: "Pili Mai",           units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  34: { community: "Poipu Kai",         units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
};

const COMMUNITY_BOUNDS: Record<string, { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number }> = BUY_IN_MARKET_BOUNDS;

function formatDate(d: Date) { return d.toISOString().split("T")[0]; }

function generate14DayWindows(months: number): { checkIn: string; checkOut: string }[] {
  const windows: { checkIn: string; checkOut: string }[] = [];
  const start = new Date();
  start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setMonth(end.getMonth() + months);
  const cur = new Date(start);
  while (cur < end) {
    const checkIn = formatDate(cur);
    const checkOut = new Date(cur);
    checkOut.setDate(checkOut.getDate() + 14);
    windows.push({ checkIn, checkOut: formatDate(checkOut) });
    cur.setDate(cur.getDate() + 14);
  }
  return windows;
}

async function scanWindow(propertyId: number, checkIn: string, checkOut: string): Promise<"available" | "low" | "none"> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) throw new Error("SEARCHAPI_API_KEY not set");

  const config = PROPERTY_UNIT_NEEDS[propertyId];
  if (!config) throw new Error(`Property ${propertyId} not in config`);

  const bounds = COMMUNITY_BOUNDS[config.community];
  const location = searchLocationForBuyInMarket(config.community) || `${config.community}, Hawaii`;

  const bedroomCounts: Record<number, number> = {};
  for (const u of config.units) bedroomCounts[u.bedrooms] = (bedroomCounts[u.bedrooms] || 0) + 1;
  const neededCount = config.units.length;

  let totalFound = 0;
  for (const [brStr, needed] of Object.entries(bedroomCounts)) {
    const bedrooms = parseInt(brStr);
    const params = new URLSearchParams({
      engine: "airbnb",
      check_in_date: checkIn,
      check_out_date: checkOut,
      adults: "2",
      bedrooms: String(bedrooms),
      type_of_place: "entire_home",
      currency: "USD",
      api_key: apiKey,
      q: location,
    });
    if (bounds) {
      params.set("bounding_box", `[[${bounds.ne_lat},${bounds.ne_lng}],[${bounds.sw_lat},${bounds.sw_lng}]]`);
    }

    const res = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
    if (!res.ok) continue;
    const data = await res.json() as { properties?: any[] };
    let props = data.properties || [];
    if (bounds && props.length > 0) {
      const geo = props.filter((p: any) => {
        const lat = p.gps_coordinates?.latitude;
        const lng = p.gps_coordinates?.longitude;
        if (!lat || !lng) return true;
        return lat >= bounds.sw_lat && lat <= bounds.ne_lat && lng >= bounds.sw_lng && lng <= bounds.ne_lng;
      });
      if (geo.length > 0) props = geo;
    }
    totalFound += Math.min(props.length, needed);
  }

  return totalFound >= neededCount ? "available" : totalFound > 0 ? "low" : "none";
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export async function syncPropertyToGuesty(propertyId: number, guestyListingId: string): Promise<{ scanned: number; blocked: number; errors: number }> {
  const windows = generate14DayWindows(24);
  let scanned = 0, blocked = 0, errors = 0;

  log(`[guesty-sync] Starting sync for property ${propertyId} → listing ${guestyListingId} (${windows.length} windows)`, "scanner");

  for (const w of windows) {
    try {
      const status = await scanWindow(propertyId, w.checkIn, w.checkOut);
      scanned++;

      if (status === "none" || status === "low") {
        await guestyRequest("POST", "/blocks", {
          listingId: guestyListingId,
          startDate: w.checkIn,
          endDate: w.checkOut,
          reasonType: "owner_block",
          note: `Auto-blocked: ${status === "none" ? "no" : "insufficient"} buy-in availability`,
        });
        blocked++;
        log(`[guesty-sync] Blocked ${w.checkIn}→${w.checkOut} (${status})`, "scanner");
      }

      await sleep(1500);
    } catch (err: any) {
      errors++;
      log(`[guesty-sync] Error on window ${w.checkIn}: ${err.message}`, "scanner");
    }
  }

  await storage.updateGuestyLastSynced(propertyId);
  log(`[guesty-sync] Done: ${scanned} scanned, ${blocked} blocked, ${errors} errors`, "scanner");
  return { scanned, blocked, errors };
}

const pendingSyncJobs = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleGuestySync(propertyId: number, guestyListingId: string, delayMs: number) {
  const key = `${propertyId}:${guestyListingId}`;
  if (pendingSyncJobs.has(key)) {
    clearTimeout(pendingSyncJobs.get(key)!);
  }
  const handle = setTimeout(async () => {
    pendingSyncJobs.delete(key);
    try {
      await syncPropertyToGuesty(propertyId, guestyListingId);
    } catch (err: any) {
      log(`[guesty-sync] Scheduled sync failed for property ${propertyId}: ${err.message}`, "scanner");
    }
  }, delayMs);
  pendingSyncJobs.set(key, handle);
  log(`[guesty-sync] Sync scheduled for property ${propertyId} in ${Math.round(delayMs / 60000)} min`, "scanner");
}

export async function syncAllPropertiesToGuesty() {
  const mappings = await storage.getGuestyPropertyMap();
  if (mappings.length === 0) {
    log("[guesty-sync] No Guesty property mappings found, skipping weekly sync", "scanner");
    return;
  }
  log(`[guesty-sync] Weekly sync starting for ${mappings.length} properties`, "scanner");
  for (const m of mappings) {
    try {
      await syncPropertyToGuesty(m.propertyId, m.guestyListingId);
      await sleep(5000);
    } catch (err: any) {
      log(`[guesty-sync] Weekly sync failed for property ${m.propertyId}: ${err.message}`, "scanner");
    }
  }
  log("[guesty-sync] Weekly sync complete", "scanner");
}
