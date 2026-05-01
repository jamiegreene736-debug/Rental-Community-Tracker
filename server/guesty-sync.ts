import { storage } from "./storage";
import { log } from "./index";
import { getGuestyToken } from "./guesty-token";

export async function guestyRequest(method: string, endpoint: string, body?: unknown) {
  const token = await getGuestyToken();
  const res = await fetch(`https://open-api.guesty.com/v1${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
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
    throw new Error(`Guesty ${res.status} on ${method} ${endpoint}: ${message}`);
  }
  if (res.status === 204) return { success: true };
  return res.json();
}

const PROPERTY_UNIT_NEEDS: Record<number, { community: string; units: { bedrooms: number }[] }> = {
  1:  { community: "Poipu Kai",         units: [{ bedrooms: 3 }, { bedrooms: 2 }, { bedrooms: 2 }] },
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

const COMMUNITY_SEARCH_LOCATIONS: Record<string, string> = {
  "Poipu Kai":         "Regency at Poipu Kai, Koloa, Kauai, Hawaii",
  "Kekaha Beachfront": "Kekaha, Kauai, Hawaii",
  "Keauhou":           "Keauhou, Kailua-Kona, Big Island, Hawaii",
  "Princeville":       "Princeville, Kauai, Hawaii",
  "Kapaa Beachfront":  "Kapaa, Kauai, Hawaii",
  "Poipu Oceanfront":  "Poipu Beach, Koloa, Kauai, Hawaii",
  "Poipu Brenneckes":  "Brenneckes Beach, Poipu, Kauai, Hawaii",
  "Pili Mai":          "Pili Mai at Poipu, Koloa, Kauai, Hawaii",
};

const COMMUNITY_BOUNDS: Record<string, { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number }> = {
  "Poipu Kai":        { sw_lat: 21.875, sw_lng: -159.478, ne_lat: 21.895, ne_lng: -159.458 },
  "Pili Mai":         { sw_lat: 21.882, sw_lng: -159.483, ne_lat: 21.899, ne_lng: -159.468 },
  "Poipu Brenneckes": { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
  "Poipu Oceanfront": { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
  "Princeville":      { sw_lat: 22.210, sw_lng: -159.498, ne_lat: 22.235, ne_lng: -159.468 },
  "Kapaa Beachfront": { sw_lat: 22.060, sw_lng: -159.333, ne_lat: 22.085, ne_lng: -159.308 },
  "Kekaha Beachfront":{ sw_lat: 21.955, sw_lng: -159.758, ne_lat: 21.978, ne_lng: -159.733 },
  "Keauhou":          { sw_lat: 19.528, sw_lng: -155.992, ne_lat: 19.558, ne_lng: -155.966 },
};

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
  const location = COMMUNITY_SEARCH_LOCATIONS[config.community] || `${config.community}, Hawaii`;

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
