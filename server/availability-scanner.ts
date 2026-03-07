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

const PROPERTY_UNIT_NEEDS: Record<number, { community: string; units: { bedrooms: number }[] }> = {
  1: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }, { bedrooms: 2 }] },
  4: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  7: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }, { bedrooms: 2 }] },
  8: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  9: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  10: { community: "Kekaha Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  12: { community: "Kekaha Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  14: { community: "Keauhou", units: [{ bedrooms: 4 }, { bedrooms: 2 }] },
  18: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  19: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  20: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  21: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }, { bedrooms: 2 }] },
  23: { community: "Kapaa Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  24: { community: "Poipu Oceanfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  26: { community: "Keauhou", units: [{ bedrooms: 5 }, { bedrooms: 2 }] },
  27: { community: "Poipu Kai", units: [{ bedrooms: 2 }, { bedrooms: 2 }] },
  28: { community: "Poipu Brenneckes", units: [{ bedrooms: 4 }, { bedrooms: 3 }] },
  29: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 4 }] },
  31: { community: "Poipu Brenneckes", units: [{ bedrooms: 5 }, { bedrooms: 2 }] },
  32: { community: "Pili Mai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
  33: { community: "Pili Mai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  34: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  36: { community: "Southern Dunes", units: [{ bedrooms: 3 }] },
  37: { community: "Windsor Hills", units: [{ bedrooms: 3 }] },
};

interface CommunityBedroomNeeds {
  community: string;
  bedroomConfigs: number[];
  propertyIds: number[];
}

function getCommunityNeeds(): CommunityBedroomNeeds[] {
  const communityMap = new Map<string, { bedrooms: Set<number>; propertyIds: Set<number> }>();

  for (const [pidStr, config] of Object.entries(PROPERTY_UNIT_NEEDS)) {
    const pid = parseInt(pidStr);
    if (!communityMap.has(config.community)) {
      communityMap.set(config.community, { bedrooms: new Set(), propertyIds: new Set() });
    }
    const entry = communityMap.get(config.community)!;
    entry.propertyIds.add(pid);
    for (const unit of config.units) {
      entry.bedrooms.add(unit.bedrooms);
    }
  }

  return Array.from(communityMap.entries()).map(([community, data]) => ({
    community,
    bedroomConfigs: Array.from(data.bedrooms).sort((a, b) => a - b),
    propertyIds: Array.from(data.propertyIds),
  }));
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function generateWeeklyWindows(weeksAhead: number): { checkIn: string; checkOut: string }[] {
  const windows: { checkIn: string; checkOut: string }[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() + ((7 - startDate.getDay()) % 7 || 7));

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

async function searchAirbnb(
  community: string,
  bedrooms: number,
  checkIn: string,
  checkOut: string
): Promise<number> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) return -1;

  const searchLocation = COMMUNITY_SEARCH_LOCATIONS[community] || `${community}, Hawaii`;

  try {
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

    const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
    if (!response.ok) {
      log(`Airbnb search error for ${community} ${bedrooms}BR: ${response.status}`, "scanner");
      return -1;
    }

    const data = await response.json();
    return (data.properties || []).length;
  } catch (err: any) {
    log(`Airbnb search failed for ${community} ${bedrooms}BR: ${err.message}`, "scanner");
    return -1;
  }
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

  try {
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

    const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
    if (!response.ok) {
      log(`VRBO search error for ${community} ${bedrooms}BR: ${response.status}`, "scanner");
      return -1;
    }

    const data = await response.json();
    return (data.properties || []).length;
  } catch (err: any) {
    log(`VRBO search failed for ${community} ${bedrooms}BR: ${err.message}`, "scanner");
    return -1;
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
          name: "Availability Block",
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
        source_text: "Availability Scanner - No buy-in inventory",
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
      log(`Lodgify block failed for property ${lodgifyPropertyId}: ${response.status} - ${errText}`, "scanner");
      return null;
    }

    const data = await response.json();
    return String(data.id || data.booking_id || "created");
  } catch (err: any) {
    log(`Lodgify block error: ${err.message}`, "scanner");
    return null;
  }
}

let scannerRunning = false;

export function isScannerRunning(): boolean {
  return scannerRunning;
}

export async function runAvailabilityScan(weeksAhead = 78): Promise<number> {
  if (scannerRunning) {
    log("Scanner already running, skipping", "scanner");
    return -1;
  }

  scannerRunning = true;
  log(`Starting availability scan for ${weeksAhead} weeks`, "scanner");

  const run = await storage.createScannerRun({
    status: "running",
    totalWeeksScanned: 0,
    totalBlocked: 0,
    totalAvailable: 0,
    totalErrors: 0,
  });

  try {
    const communityNeeds = getCommunityNeeds();
    const windows = generateWeeklyWindows(weeksAhead);

    let totalScanned = 0;
    let totalBlocked = 0;
    let totalAvailable = 0;
    let totalErrors = 0;

    for (const window of windows) {
      for (const communityInfo of communityNeeds) {
        let totalAirbnb = 0;
        let totalVrbo = 0;
        let hasError = false;

        for (const bedrooms of communityInfo.bedroomConfigs) {
          const [airbnbCount, vrboCount] = await Promise.all([
            searchAirbnb(communityInfo.community, bedrooms, window.checkIn, window.checkOut),
            searchVRBO(communityInfo.community, bedrooms, window.checkIn, window.checkOut),
          ]);

          if (airbnbCount === -1 && vrboCount === -1) {
            hasError = true;
          }

          totalAirbnb += Math.max(0, airbnbCount);
          totalVrbo += Math.max(0, vrboCount);

          await sleep(1500);
        }

        const totalResults = totalAirbnb + totalVrbo;
        const shouldBlock = totalResults === 0 && !hasError;
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

        let lodgifyBlockIds: string | undefined;

        if (shouldBlock) {
          log(`No availability for ${communityInfo.community} ${window.checkIn}-${window.checkOut}, blocking`, "scanner");
        }

        await storage.createAvailabilityScan({
          runId: run.id,
          community: communityInfo.community,
          checkIn: window.checkIn,
          checkOut: window.checkOut,
          bedroomConfig: JSON.stringify(communityInfo.bedroomConfigs),
          airbnbResults: totalAirbnb,
          vrboResults: totalVrbo,
          totalResults,
          blocked: shouldBlock ? "true" : "false",
          lodgifyBlockIds: lodgifyBlockIds || null,
          status,
        });

        totalScanned++;
      }

      if (totalScanned % 10 === 0) {
        await storage.updateScannerRun(run.id, {
          totalWeeksScanned: totalScanned,
          totalBlocked,
          totalAvailable,
          totalErrors,
        });
      }
    }

    await storage.updateScannerRun(run.id, {
      completedAt: new Date(),
      totalWeeksScanned: totalScanned,
      totalBlocked,
      totalAvailable,
      totalErrors,
      status: "completed",
    });

    log(`Scan completed: ${totalScanned} scanned, ${totalBlocked} blocked, ${totalAvailable} available, ${totalErrors} errors`, "scanner");
    return run.id;
  } catch (err: any) {
    log(`Scan failed: ${err.message}`, "scanner");
    await storage.updateScannerRun(run.id, {
      completedAt: new Date(),
      status: "failed",
    });
    return run.id;
  } finally {
    scannerRunning = false;
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

    const daysUntilMonday = (MONDAY - now.getDay() + 7) % 7 || 7;
    if (daysUntilMonday === 7 && now < next) {
      // today is Monday and it's before scheduled time
    } else {
      next.setDate(next.getDate() + (daysUntilMonday === 0 ? 7 : daysUntilMonday));
    }

    const msUntilNext = next.getTime() - now.getTime();
    log(`Next scan scheduled for ${next.toISOString()} (in ${Math.round(msUntilNext / 3600000)}h)`, "scanner");

    setTimeout(async () => {
      try {
        await runAvailabilityScan(78);
      } catch (err: any) {
        log(`Scheduled scan error: ${err.message}`, "scanner");
      }
      scheduleNext();
    }, msUntilNext);
  }

  scheduleNext();
  log("Weekly availability scanner scheduler started", "scanner");
}
