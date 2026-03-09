import { storage } from "./storage";
import { log } from "./index";

const COMMUNITY_SEARCH_LOCATIONS: Record<string, string> = {
  "Poipu Kai": "Regency at Poipu Kai, Koloa, Kauai, Hawaii",
  "Kekaha Beachfront": "Kekaha, Kauai, Hawaii",
  "Keauhou": "Keauhou, Kailua-Kona, Big Island, Hawaii",
  "Princeville": "Princeville, Kauai, Hawaii",
  "Kapaa Beachfront": "Kapaa, Kauai, Hawaii",
  "Poipu Oceanfront": "Poipu Beach, Koloa, Kauai, Hawaii",
  "Poipu Brenneckes": "Brenneckes Beach, Poipu, Kauai, Hawaii",
  "Pili Mai": "Pili Mai at Poipu, Koloa, Kauai, Hawaii",
  "Southern Dunes": "Southern Dunes, Haines City, Florida",
  "Windsor Hills": "Windsor Hills Resort, Kissimmee, Florida",
};

const COMMUNITY_VRBO_DESTINATIONS: Record<string, string> = {
  "Poipu Kai": "Regency at Poipu Kai, Koloa, Hawaii",
  "Kekaha Beachfront": "Kekaha, Hawaii",
  "Keauhou": "Keauhou, Kailua-Kona, Hawaii",
  "Princeville": "Princeville, Kauai, Hawaii",
  "Kapaa Beachfront": "Kapaa, Kauai, Hawaii",
  "Poipu Oceanfront": "Poipu Beach, Koloa, Hawaii",
  "Poipu Brenneckes": "Poipu Beach, Koloa, Hawaii",
  "Pili Mai": "Pili Mai at Poipu, Koloa, Hawaii",
  "Southern Dunes": "Southern Dunes, Haines City, Florida",
  "Windsor Hills": "Windsor Hills Resort, Kissimmee, Florida",
};

const PROPERTY_UNIT_NEEDS: Record<number, { name: string; community: string; units: { bedrooms: number }[] }> = {
  1: { name: "Poipu Kai Sunset", community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }, { bedrooms: 2 }] },
  4: { name: "Poipu Kai Ocean Breeze", community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  7: { name: "Poipu Kai Grand", community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }, { bedrooms: 2 }] },
  8: { name: "Poipu Kai Twin Palms", community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  9: { name: "Poipu Kai Reef", community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  10: { name: "Kekaha Beach House", community: "Kekaha Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  12: { name: "Kekaha Oceanside", community: "Kekaha Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  14: { name: "Keauhou Estates", community: "Keauhou", units: [{ bedrooms: 4 }, { bedrooms: 2 }] },
  18: { name: "Poipu Kai Aloha", community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  19: { name: "Princeville Cliffs", community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  20: { name: "Princeville Paradise", community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  21: { name: "Poipu Kai Triple", community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }, { bedrooms: 2 }] },
  23: { name: "Kapaa Sands", community: "Kapaa Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  24: { name: "Poipu Oceanfront", community: "Poipu Oceanfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  26: { name: "Keauhou Grand", community: "Keauhou", units: [{ bedrooms: 5 }, { bedrooms: 2 }] },
  27: { name: "Poipu Kai Duo", community: "Poipu Kai", units: [{ bedrooms: 2 }, { bedrooms: 2 }] },
  28: { name: "Poipu Brenneckes", community: "Poipu Brenneckes", units: [{ bedrooms: 4 }, { bedrooms: 3 }] },
  29: { name: "Princeville Views", community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 4 }] },
  31: { name: "Poipu Brenneckes Grand", community: "Poipu Brenneckes", units: [{ bedrooms: 5 }, { bedrooms: 2 }] },
  32: { name: "Pili Mai Resort A", community: "Pili Mai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  33: { name: "Pili Mai Resort B", community: "Pili Mai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  34: { name: "Poipu Kai Palms", community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  36: { name: "Southern Dunes Villa", community: "Southern Dunes", units: [{ bedrooms: 3 }] },
  37: { name: "Windsor Hills Villa", community: "Windsor Hills", units: [{ bedrooms: 3 }] },
};

interface LodgifyPropertyInfo {
  lodgifyId: number;
  name: string;
  rooms: { id: number; name: string }[];
}

type CacheEntry = { airbnb: number; vrbo: number; error: boolean };
type SearchCache = Map<string, CacheEntry>;

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function generateWeeklyWindows(weeksAhead: number): { checkIn: string; checkOut: string }[] {
  const windows: { checkIn: string; checkOut: string }[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startDate = new Date(today);
  const dayOfWeek = startDate.getDay();
  const daysUntilSaturday = (6 - dayOfWeek + 7) % 7 || 7;
  startDate.setDate(startDate.getDate() + daysUntilSaturday);

  for (let i = 0; i < weeksAhead; i++) {
    const checkIn = new Date(startDate);
    checkIn.setDate(checkIn.getDate() + i * 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 7);
    windows.push({ checkIn: formatDate(checkIn), checkOut: formatDate(checkOut) });
  }

  return windows;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let consecutiveRateLimits = 0;

async function fetchWithRetry(url: string, label: string, maxRetries = 3): Promise<Response | null> {
  if (consecutiveRateLimits >= 5) {
    const cooldown = 120;
    log(`Too many rate limits in a row, cooling down ${cooldown}s before ${label}`, "scanner");
    await sleep(cooldown * 1000);
    consecutiveRateLimits = 0;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        consecutiveRateLimits++;
        const waitTime = Math.min(15000 * Math.pow(2, attempt), 120000);
        log(`Rate limited on ${label}, waiting ${waitTime / 1000}s (attempt ${attempt + 1}/${maxRetries + 1})`, "scanner");
        await sleep(waitTime);
        continue;
      }
      if (!response.ok) {
        log(`${label}: HTTP ${response.status}`, "scanner");
        return null;
      }
      consecutiveRateLimits = 0;
      return response;
    } catch (err: any) {
      log(`${label} failed: ${err.message}`, "scanner");
      if (attempt < maxRetries) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  log(`${label}: all ${maxRetries + 1} attempts exhausted`, "scanner");
  return null;
}

async function searchAirbnb(
  community: string,
  bedrooms: number,
  checkIn: string,
  checkOut: string
): Promise<number> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) return -1;

  const searchLocation = COMMUNITY_SEARCH_LOCATIONS[community] || `${community}, Hawaii`;
  const params = new URLSearchParams({
    engine: "airbnb",
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults: "2",
    bedrooms: String(bedrooms),
    type_of_place: "entire_home",
    currency: "USD",
    api_key: apiKey,
    q: searchLocation,
  });

  const response = await fetchWithRetry(
    `https://www.searchapi.io/api/v1/search?${params.toString()}`,
    `Airbnb ${community} ${bedrooms}BR ${checkIn}`
  );
  if (!response) return -1;

  const data = await response.json();
  return (data.properties || []).length;
}

async function searchVRBO(
  community: string,
  bedrooms: number,
  checkIn: string,
  checkOut: string
): Promise<number> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) return -1;

  const destination = COMMUNITY_VRBO_DESTINATIONS[community] || `${community}, Hawaii`;
  const params = new URLSearchParams({
    engine: "google_hotels",
    q: destination,
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults: "2",
    bedrooms: String(bedrooms),
    property_type: "vacation_rental",
    sort_by: "lowest_price",
    currency: "USD",
    api_key: apiKey,
  });

  const response = await fetchWithRetry(
    `https://www.searchapi.io/api/v1/search?${params.toString()}`,
    `VRBO ${community} ${bedrooms}BR ${checkIn}`
  );
  if (!response) return -1;

  const data = await response.json();
  return (data.properties || []).length;
}

async function fetchLodgifyProperties(): Promise<LodgifyPropertyInfo[]> {
  const apiKey = process.env.LODGIFY_API_KEY;
  if (!apiKey) {
    log("Lodgify API key not configured, cannot fetch properties for blocking", "scanner");
    return [];
  }

  try {
    const response = await fetch("https://api.lodgify.com/v2/properties?page=1&size=50", {
      headers: {
        "X-ApiKey": apiKey,
        "accept": "application/json",
      },
    });

    if (!response.ok) {
      log(`Failed to fetch Lodgify properties: ${response.status}`, "scanner");
      return [];
    }

    const data = await response.json();
    const items = data.items || data;
    if (!Array.isArray(items)) {
      log("Unexpected Lodgify properties response format", "scanner");
      return [];
    }

    const results: LodgifyPropertyInfo[] = [];
    for (const prop of items) {
      const propId = prop.id;
      const propName = prop.name || "";

      const detailResponse = await fetch(`https://api.lodgify.com/v2/properties/${propId}`, {
        headers: {
          "X-ApiKey": apiKey,
          "accept": "application/json",
        },
      });

      if (!detailResponse.ok) {
        log(`Failed to fetch Lodgify property ${propId} details: ${detailResponse.status}`, "scanner");
        continue;
      }

      const detail = await detailResponse.json();
      const rooms = (detail.rooms || []).map((r: any) => ({
        id: r.id,
        name: r.name || `Room ${r.id}`,
      }));

      results.push({ lodgifyId: propId, name: propName, rooms });
      await sleep(300);
    }

    log(`Fetched ${results.length} Lodgify properties with room types`, "scanner");
    return results;
  } catch (err: any) {
    log(`Error fetching Lodgify properties: ${err.message}`, "scanner");
    return [];
  }
}

async function createLodgifyBlock(
  lodgifyPropertyId: number,
  roomTypeId: number,
  checkIn: string,
  checkOut: string,
  reason: string
): Promise<string | null> {
  const apiKey = process.env.LODGIFY_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.lodgify.com/v1/reservation/booking", {
      method: "POST",
      headers: {
        "X-ApiKey": apiKey,
        "Content-Type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({
        guest: {
          name: "No Availability - Auto Block",
          email: "scanner@thevacationrentalexperts.com",
        },
        status: "Declined",
        property_id: lodgifyPropertyId,
        arrival: checkIn,
        departure: checkOut,
        bookability: "InstantBooking",
        origin: "manual",
        total: 0,
        currency_code: "USD",
        source_text: "Availability Scanner",
        rooms: [
          {
            room_type_id: roomTypeId,
            people: 1,
          },
        ],
        notes: reason,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log(`Lodgify block failed for property ${lodgifyPropertyId} room ${roomTypeId}: ${response.status} - ${errText}`, "scanner");
      return null;
    }

    const data = await response.json();
    const blockId = String(data.id || data.booking_id || "created");
    log(`Lodgify block created: property ${lodgifyPropertyId}, room ${roomTypeId}, ${checkIn}-${checkOut} (ID: ${blockId})`, "scanner");
    return blockId;
  } catch (err: any) {
    log(`Lodgify block error for property ${lodgifyPropertyId}: ${err.message}`, "scanner");
    return null;
  }
}

async function searchCommunityBedroom(
  cache: SearchCache,
  community: string,
  bedrooms: number,
  checkIn: string,
  checkOut: string
): Promise<CacheEntry> {
  const cacheKey = `${community}|${bedrooms}|${checkIn}|${checkOut}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const airbnbCount = await searchAirbnb(community, bedrooms, checkIn, checkOut);
  await sleep(5000);
  const vrboCount = await searchVRBO(community, bedrooms, checkIn, checkOut);

  const error = airbnbCount === -1 && vrboCount === -1;
  const entry: CacheEntry = {
    airbnb: Math.max(0, airbnbCount),
    vrbo: Math.max(0, vrboCount),
    error,
  };

  cache.set(cacheKey, entry);
  await sleep(5000);

  return entry;
}

let scannerRunning = false;
let currentScanPropertyId: number | null = null;

export function isScannerRunning(): boolean {
  return scannerRunning;
}

export function getCurrentScanPropertyId(): number | null {
  return currentScanPropertyId;
}

export function getScannableProperties(): { id: number; name: string; community: string; bedrooms: number[] }[] {
  return Object.entries(PROPERTY_UNIT_NEEDS).map(([id, config]) => ({
    id: Number(id),
    name: config.name,
    community: config.community,
    bedrooms: [...new Set(config.units.map(u => u.bedrooms))].sort(),
  }));
}

export function getPropertyName(propertyId: number): string {
  return PROPERTY_UNIT_NEEDS[propertyId]?.name || `Property #${propertyId}`;
}

export async function runAvailabilityScan(weeksAhead = 52, targetPropertyId?: number, lodgifyPropertyId?: number): Promise<number> {
  if (scannerRunning) {
    log("Scanner already running, skipping", "scanner");
    return -1;
  }

  scannerRunning = true;
  currentScanPropertyId = targetPropertyId || null;
  let runId = -1;

  try {
    const propertyIds = targetPropertyId
      ? [targetPropertyId]
      : Object.keys(PROPERTY_UNIT_NEEDS).map(Number);

    if (targetPropertyId && !PROPERTY_UNIT_NEEDS[targetPropertyId]) {
      log(`Property ${targetPropertyId} not found in scanner configuration`, "scanner");
      return -1;
    }

    const label = targetPropertyId
      ? `property #${targetPropertyId} (${PROPERTY_UNIT_NEEDS[targetPropertyId].name})`
      : `all ${propertyIds.length} properties`;

    log(`Starting availability scan: ${label}, ${weeksAhead} weeks`, "scanner");

    const run = await storage.createScannerRun({
      status: "running",
      totalWeeksScanned: 0,
      totalBlocked: 0,
      totalAvailable: 0,
      totalErrors: 0,
    });
    runId = run.id;

    let lodgifyProperties: LodgifyPropertyInfo[] = [];
    if (lodgifyPropertyId) {
      const allProps = await fetchLodgifyProperties();
      const match = allProps.find(p => p.lodgifyId === lodgifyPropertyId);
      if (match) {
        lodgifyProperties = [match];
        log(`Will block Lodgify property ${lodgifyPropertyId} (${match.name})`, "scanner");
      } else {
        log(`Lodgify property ${lodgifyPropertyId} not found, skipping blocks`, "scanner");
      }
    } else if (!targetPropertyId) {
      lodgifyProperties = await fetchLodgifyProperties();
      log(`Loaded ${lodgifyProperties.length} Lodgify properties for calendar blocking`, "scanner");
    }

    const windows = generateWeeklyWindows(weeksAhead);

    let totalScanned = 0;
    let totalBlocked = 0;
    let totalAvailable = 0;
    let totalErrors = 0;

    const searchCache: SearchCache = new Map();

    for (const window of windows) {
      for (const propertyId of propertyIds) {
        const config = PROPERTY_UNIT_NEEDS[propertyId];
        const uniqueBedrooms = [...new Set(config.units.map(u => u.bedrooms))];

        let totalAirbnb = 0;
        let totalVrbo = 0;
        let hasError = false;
        let anyBedroomMissing = false;

        for (const bedrooms of uniqueBedrooms) {
          const result = await searchCommunityBedroom(
            searchCache,
            config.community,
            bedrooms,
            window.checkIn,
            window.checkOut
          );

          if (result.error) {
            hasError = true;
          }

          totalAirbnb += result.airbnb;
          totalVrbo += result.vrbo;

          if (result.airbnb + result.vrbo === 0 && !result.error) {
            anyBedroomMissing = true;
          }
        }

        const totalResults = totalAirbnb + totalVrbo;
        const shouldBlock = anyBedroomMissing && !hasError;
        let status: string;

        if (hasError && totalResults === 0) {
          status = "error";
          totalErrors++;
        } else if (shouldBlock) {
          status = "blocked";
          totalBlocked++;
        } else {
          status = "available";
          totalAvailable++;
        }

        let lodgifyBlockIds: string[] = [];

        if (shouldBlock && lodgifyProperties.length > 0) {
          for (const lp of lodgifyProperties) {
            for (const room of lp.rooms) {
              const blockId = await createLodgifyBlock(
                lp.lodgifyId,
                room.id,
                window.checkIn,
                window.checkOut,
                `Auto-block: No ${uniqueBedrooms.map(b => `${b}BR`).join("/")} buy-in availability found in ${config.community} for ${window.checkIn} to ${window.checkOut}`
              );
              if (blockId) {
                lodgifyBlockIds.push(`${lp.lodgifyId}:${room.id}:${blockId}`);
              }
              await sleep(500);
            }
          }
        }

        await storage.createAvailabilityScan({
          runId: run.id,
          propertyId,
          community: config.community,
          checkIn: window.checkIn,
          checkOut: window.checkOut,
          bedroomConfig: JSON.stringify(uniqueBedrooms),
          airbnbResults: totalAirbnb,
          vrboResults: totalVrbo,
          totalResults,
          blocked: shouldBlock ? "true" : "false",
          lodgifyBlockIds: lodgifyBlockIds.length > 0 ? JSON.stringify(lodgifyBlockIds) : null,
          status,
        });

        totalScanned++;

        if (totalScanned % 10 === 0) {
          await storage.updateScannerRun(run.id, {
            totalWeeksScanned: totalScanned,
            totalBlocked,
            totalAvailable,
            totalErrors,
          });
          log(`Scan progress: ${totalScanned}/${propertyIds.length * windows.length} weeks scanned, ${totalBlocked} blocked, ${totalAvailable} available`, "scanner");
        }
      }

      searchCache.clear();
    }

    await storage.updateScannerRun(run.id, {
      completedAt: new Date(),
      totalWeeksScanned: totalScanned,
      totalBlocked,
      totalAvailable,
      totalErrors,
      status: "completed",
    });

    log(`Scan completed: ${totalScanned} weeks scanned, ${totalBlocked} blocked, ${totalAvailable} available, ${totalErrors} errors`, "scanner");
    return run.id;
  } catch (err: any) {
    log(`Scan failed: ${err.message}`, "scanner");
    if (runId > 0) {
      await storage.updateScannerRun(runId, {
        completedAt: new Date(),
        status: "failed",
      }).catch(() => {});
    }
    return runId;
  } finally {
    scannerRunning = false;
    currentScanPropertyId = null;
  }
}

export function startWeeklyScheduler() {
  const MONDAY = 1;
  const HOUR = 3;
  const MINUTE = 0;

  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(HOUR, MINUTE, 0, 0);

    const daysUntilMonday = (MONDAY - now.getDay() + 7) % 7;
    if (daysUntilMonday === 0 && now >= next) {
      next.setDate(next.getDate() + 7);
    } else if (daysUntilMonday > 0) {
      next.setDate(next.getDate() + daysUntilMonday);
    }

    const msUntilNext = next.getTime() - now.getTime();
    log(`Next scan scheduled for ${next.toISOString()} (in ${Math.round(msUntilNext / 3600000)}h)`, "scanner");

    setTimeout(async () => {
      try {
        await runAvailabilityScan(52);
      } catch (err: any) {
        log(`Scheduled scan error: ${err.message}`, "scanner");
      }
      scheduleNext();
    }, msUntilNext);
  }

  scheduleNext();
  log("Weekly availability scanner scheduler started (every Monday 3am)", "scanner");
}
