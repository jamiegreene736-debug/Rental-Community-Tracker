import { storage } from "./storage";
import { log } from "./index";
import { syncAllPropertiesToGuesty } from "./guesty-sync";
import {
  BUY_IN_MARKET_LOCATIONS,
  resolveBuyInMarket,
  searchLocationForBuyInMarket,
} from "@shared/buy-in-market";
import { acquireSidecarLane, cancelActiveSidecarLane, isSidecarLaneCancellationRequested } from "./sidecar-lane";
import { fetchMultiChannelBuyInByBR, inferRegion } from "./multichannel-buy-in";
import {
  availabilityAutoBlockAllowed,
  seasonForWindow,
} from "./seasonal-availability";

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
};

// Tuning: this is intentionally loose. Scanner blocks are high-impact
// calendar writes, so require a true zero for at least one required bedroom
// size before blacking out a window. Thin-but-nonzero inventory stays
// available/review-only and will clear prior scanner-owned Guesty blocks.
const AVAILABILITY_THRESHOLD = 1;

type CacheEntry = {
  airbnb: number;
  vrbo: number;
  booking: number;
  total: number;
  sidecarRan: boolean;
  daemonOnline: boolean;
  error: boolean;
};
type SearchCache = Map<string, CacheEntry>;
type AvailabilitySidecarConcurrencyMode = "availability_bulk";
type AvailabilityScanProgress = {
  scanned: number;
  total: number;
  percent: number;
  blocked: number;
  available: number;
  errors: number;
  label: string;
  updatedAt: string;
};
type AvailabilityScanOptions = {
  sidecarConcurrencyMode?: AvailabilitySidecarConcurrencyMode;
  windowConcurrency?: number;
  onProgress?: (progress: AvailabilityScanProgress) => void;
  shouldPause?: () => boolean;
  shouldCancel?: () => boolean;
};

function legacyBulkAutoBlockAllowed(community: string, checkIn: string, checkOut: string): boolean {
  const loc = resolveLegacyAvailabilityLocation(community);
  const region = inferRegion(loc.city, loc.state);
  const start = new Date(`${checkIn}T12:00:00Z`);
  const end = new Date(`${checkOut}T12:00:00Z`);
  const nights = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  return availabilityAutoBlockAllowed({
    season: seasonForWindow(region, start, nights),
    checkIn,
  });
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function generateScanWindows(periodsAhead: number): { checkIn: string; checkOut: string }[] {
  const windows: { checkIn: string; checkOut: string }[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startDate = new Date(today);
  const dayOfWeek = startDate.getDay();
  const daysUntilSaturday = (6 - dayOfWeek + 7) % 7 || 7;
  startDate.setDate(startDate.getDate() + daysUntilSaturday);

  for (let i = 0; i < periodsAhead; i++) {
    const checkIn = new Date(startDate);
    checkIn.setDate(checkIn.getDate() + i * 14);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 14);
    windows.push({ checkIn: formatDate(checkIn), checkOut: formatDate(checkOut) });
  }

  return windows;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let consecutiveRateLimits = 0;

async function fetchWithRetry(url: string, label: string, maxRetries = 3): Promise<Response | null> {
  if (consecutiveRateLimits >= 10) {
    log(`API quota appears exhausted (${consecutiveRateLimits} consecutive rate limits). Aborting scan.`, "scanner");
    scanAborted = true;
    return null;
  }

  if (consecutiveRateLimits >= 5) {
    const cooldown = 120;
    log(`Too many rate limits in a row, cooling down ${cooldown}s before ${label}`, "scanner");
    await sleep(cooldown * 1000);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        let body = "";
        try { body = await response.text(); } catch {}
        if (body.includes("used all") || body.includes("upgrade your plan")) {
          log(`SearchAPI monthly quota exhausted: ${body.trim()}`, "scanner");
          consecutiveRateLimits = 10;
          scanAborted = true;
          return null;
        }
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

  const searchLocation = searchLocationForBuyInMarket(community) || `${community}, Hawaii`;
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
  if (data.error) {
    log(`SearchAPI error (Airbnb ${community} ${bedrooms}BR): ${data.error}`, "scanner");
    if (data.error.includes("used all") || data.error.includes("upgrade")) {
      consecutiveRateLimits = 10;
      scanAborted = true;
    }
    return -1;
  }
  return (data.properties || []).length;
}

function resolveLegacyAvailabilityLocation(community: string): {
  community: string;
  searchName: string;
  city: string;
  state: string;
  streetAddress?: string;
  bboxCenterOverride?: { lat: number; lng: number };
} {
  const marketKey =
    resolveBuyInMarket({ name: community, city: "Koloa", state: "Hawaii" }) ||
    resolveBuyInMarket({ name: community }) ||
    community;
  const market = BUY_IN_MARKET_LOCATIONS[marketKey] || BUY_IN_MARKET_LOCATIONS[community];
  const fallbackSearchName = searchLocationForBuyInMarket(community) || community;
  return {
    community: marketKey,
    searchName: market?.searchName || fallbackSearchName,
    city: market?.city || "Koloa",
    state: market?.state || "Hawaii",
    streetAddress: market?.streetAddress,
    bboxCenterOverride: market && Number.isFinite(market.lat) && Number.isFinite(market.lng)
      ? { lat: market.lat, lng: market.lng }
      : undefined,
  };
}

// Multi-channel availability check. Every provider count now comes from the
// shared sidecar scan layer so the legacy availability scanner follows the
// same visible provider evidence as Operations/find-buy-in. The in-run cache
// dedupes repeated property/BR/window requests, and the queue layer adds the
// longer successful-result cache for repeat runs.
async function searchCommunityBedroom(
  cache: SearchCache,
  community: string,
  bedrooms: number,
  checkIn: string,
  checkOut: string,
  options: Pick<AvailabilityScanOptions, "sidecarConcurrencyMode"> = {},
): Promise<CacheEntry> {
  const cacheKey = `${community}|${bedrooms}|${checkIn}|${checkOut}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }
  const loc = resolveLegacyAvailabilityLocation(community);
  let entry: CacheEntry;
  try {
    const scan = await fetchMultiChannelBuyInByBR({
      community: loc.community,
      city: loc.city,
      state: loc.state,
      streetAddress: loc.streetAddress,
      bboxCenterOverride: loc.bboxCenterOverride,
      searchName: loc.searchName,
      bedroomCounts: [bedrooms],
      dateOverride: { checkIn, checkOut },
      skipPm: true,
      reuseSharedOtaSearch: true,
      sidecarQueueBudgetMs: 285_000,
      sidecarConcurrencyMode: options.sidecarConcurrencyMode,
    });
    const counts = scan.channelAvailableCountsByBR[bedrooms] ?? { airbnb: 0, vrbo: 0, booking: 0, total: 0 };
    entry = {
      airbnb: counts.airbnb,
      vrbo: counts.vrbo,
      booking: counts.booking,
      total: counts.total,
      sidecarRan: true,
      daemonOnline: scan.daemonOnline,
      error: !scan.daemonOnline,
    };
  } catch (e: any) {
    log(`sidecar availability scan error (${community} ${bedrooms}BR ${checkIn}): ${e?.message ?? e}`, "scanner");
    entry = {
      airbnb: 0,
      vrbo: 0,
      booking: 0,
      total: 0,
      sidecarRan: true,
      daemonOnline: false,
      error: true,
    };
  }
  cache.set(cacheKey, entry);
  await sleep(3000);
  return entry;
}

let scannerRunning = false;
let currentScanPropertyId: number | null = null;
let scanAborted = false;

type BulkQueueItemStatus = "pending" | "running" | "success" | "error" | "cancelled";

export type BulkAvailabilityQueueItem = {
  propertyId: number;
  name: string;
  community: string;
  bedrooms: number[];
  totalBedrooms: number;
  status: BulkQueueItemStatus;
  runId: number | null;
  message: string | null;
  startedAt: string | null;
  completedAt: string | null;
  progress: AvailabilityScanProgress | null;
};

export type BulkAvailabilityQueueStatus = {
  id: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  weeksAhead: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  totals: {
    pending: number;
    running: number;
    success: number;
    error: number;
  };
  items: BulkAvailabilityQueueItem[];
};

let bulkAvailabilityQueue: BulkAvailabilityQueueStatus | null = null;
let bulkAvailabilityQueueProcessing = false;
let bulkAvailabilityQueuePaused = false;
let bulkAvailabilityQueueCancelRequested = false;

export function isScannerRunning(): boolean {
  return scannerRunning;
}

export function getCurrentScanPropertyId(): number | null {
  return currentScanPropertyId;
}

export function getScannableProperties(): { id: number; name: string; community: string; bedrooms: number[]; totalBedrooms: number }[] {
  return Object.entries(PROPERTY_UNIT_NEEDS)
    .filter(([, config]) => config.units.length >= 2)
    .map(([id, config]) => ({
      id: Number(id),
      name: config.name,
      community: config.community,
      bedrooms: Array.from(new Set(config.units.map(u => u.bedrooms))).sort(),
      totalBedrooms: config.units.reduce((sum, u) => sum + u.bedrooms, 0),
    }));
}

export function getPropertyName(propertyId: number): string {
  return PROPERTY_UNIT_NEEDS[propertyId]?.name || `Property #${propertyId}`;
}

function refreshBulkAvailabilityTotals(queue: BulkAvailabilityQueueStatus) {
  queue.totals = {
    pending: queue.items.filter(item => item.status === "pending").length,
    running: queue.items.filter(item => item.status === "running").length,
    success: queue.items.filter(item => item.status === "success").length,
    error: queue.items.filter(item => item.status === "error").length,
  };
}

export function getBulkAvailabilityQueueStatus(): BulkAvailabilityQueueStatus | null {
  if (!bulkAvailabilityQueue) return null;
  refreshBulkAvailabilityTotals(bulkAvailabilityQueue);
  return bulkAvailabilityQueue;
}

export function isBulkAvailabilityQueueRunning(): boolean {
  return bulkAvailabilityQueueProcessing;
}

export function clearBulkAvailabilityQueue(): { ok: boolean; queue: BulkAvailabilityQueueStatus | null; error?: string } {
  if (bulkAvailabilityQueueProcessing || scannerRunning) {
    return { ok: false, queue: bulkAvailabilityQueue, error: "Cannot clear while the availability queue is running. Pause or cancel it first." };
  }
  bulkAvailabilityQueue = null;
  bulkAvailabilityQueuePaused = false;
  bulkAvailabilityQueueCancelRequested = false;
  return { ok: true, queue: null };
}

export function pauseBulkAvailabilityQueue(reason = "paused by operator"): { ok: boolean; queue: BulkAvailabilityQueueStatus | null; error?: string } {
  if (!bulkAvailabilityQueue || (!bulkAvailabilityQueueProcessing && bulkAvailabilityQueue.status !== "running")) {
    return { ok: false, queue: bulkAvailabilityQueue, error: "No running availability queue to pause" };
  }
  bulkAvailabilityQueuePaused = true;
  bulkAvailabilityQueue.status = "paused";
  for (const item of bulkAvailabilityQueue.items) {
    if (item.status === "pending") item.message = "Paused";
    if (item.status === "running") item.message = "Pausing after current window";
  }
  log(`Bulk availability queue paused: ${reason}`, "scanner");
  return { ok: true, queue: getBulkAvailabilityQueueStatus() };
}

export function resumeBulkAvailabilityQueue(): { ok: boolean; queue: BulkAvailabilityQueueStatus | null; error?: string } {
  if (!bulkAvailabilityQueue || bulkAvailabilityQueue.status !== "paused") {
    return { ok: false, queue: bulkAvailabilityQueue, error: "No paused availability queue to resume" };
  }
  bulkAvailabilityQueuePaused = false;
  bulkAvailabilityQueue.status = "running";
  for (const item of bulkAvailabilityQueue.items) {
    if (item.status === "pending") item.message = "Waiting for its turn";
    if (item.status === "running") item.message = "Scanning availability";
  }
  log("Bulk availability queue resumed", "scanner");
  return { ok: true, queue: getBulkAvailabilityQueueStatus() };
}

export async function cancelBulkAvailabilityQueue(reason = "cancelled by operator"): Promise<{
  ok: boolean;
  queue: BulkAvailabilityQueueStatus | null;
  cancelled: number;
}> {
  if (!bulkAvailabilityQueue && !bulkAvailabilityQueueProcessing && !scannerRunning) {
    return { ok: false, queue: null, cancelled: 0 };
  }
  bulkAvailabilityQueueCancelRequested = true;
  bulkAvailabilityQueuePaused = false;
  scanAborted = true;
  cancelActiveSidecarLane(reason);
  let cancelled = 0;
  if (bulkAvailabilityQueue) {
    bulkAvailabilityQueue.status = "cancelled";
    bulkAvailabilityQueue.completedAt = new Date().toISOString();
    for (const item of bulkAvailabilityQueue.items) {
      if (item.status === "pending" || item.status === "running") {
        item.status = "cancelled";
        item.message = reason;
        item.completedAt = new Date().toISOString();
        if (item.progress) {
          item.progress = {
            ...item.progress,
            label: reason,
            updatedAt: item.completedAt,
          };
        }
        cancelled++;
      }
    }
    refreshBulkAvailabilityTotals(bulkAvailabilityQueue);
  }
  try {
    const { cancelSidecarRunAndRequests } = await import("./vrbo-sidecar-queue");
    cancelSidecarRunAndRequests(reason);
  } catch (e: any) {
    log(`Bulk availability sidecar cancellation warning: ${e?.message ?? e}`, "scanner");
  }
  log(`Bulk availability queue cancelled: ${reason}`, "scanner");
  return { ok: true, queue: getBulkAvailabilityQueueStatus(), cancelled };
}

export function startBulkAvailabilityQueue(propertyIds?: number[], weeksAhead = 52): BulkAvailabilityQueueStatus {
  if (bulkAvailabilityQueueProcessing) {
    throw new Error("A bulk availability queue is already running");
  }
  if (scannerRunning) {
    throw new Error("An availability scan is already running");
  }

  const scannableProperties = getScannableProperties();
  const propertyMap = new Map(scannableProperties.map(property => [property.id, property]));
  const targetIds = propertyIds?.length ? propertyIds : scannableProperties.map(property => property.id);
  const uniqueTargetIds = Array.from(new Set(targetIds));
  const invalidIds = uniqueTargetIds.filter(propertyId => !propertyMap.has(propertyId));

  if (invalidIds.length > 0) {
    throw new Error(`Invalid scannable property id(s): ${invalidIds.join(", ")}`);
  }
  if (uniqueTargetIds.length === 0) {
    throw new Error("No scannable properties were selected");
  }

  const now = new Date().toISOString();
  bulkAvailabilityQueue = {
    id: `availability-bulk-${Date.now()}`,
    status: "running",
    weeksAhead,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    totals: { pending: uniqueTargetIds.length, running: 0, success: 0, error: 0 },
    items: uniqueTargetIds.map(propertyId => {
      const property = propertyMap.get(propertyId)!;
      return {
        propertyId,
        name: property.name,
        community: property.community,
        bedrooms: property.bedrooms,
        totalBedrooms: property.totalBedrooms,
        status: "pending",
        runId: null,
        message: null,
        startedAt: null,
        completedAt: null,
        progress: null,
      };
    }),
  };
  bulkAvailabilityQueuePaused = false;
  bulkAvailabilityQueueCancelRequested = false;

  void processBulkAvailabilityQueue(bulkAvailabilityQueue);
  return bulkAvailabilityQueue;
}

async function processBulkAvailabilityQueue(queue: BulkAvailabilityQueueStatus) {
  bulkAvailabilityQueueProcessing = true;
  queue.startedAt = new Date().toISOString();

  try {
    for (const item of queue.items) {
      while (bulkAvailabilityQueuePaused && !bulkAvailabilityQueueCancelRequested) {
        queue.status = "paused";
        item.message = "Paused";
        refreshBulkAvailabilityTotals(queue);
        await sleep(1_000);
      }
      if (bulkAvailabilityQueueCancelRequested) {
        if (item.status === "pending") {
          item.status = "cancelled";
          item.message = "Cancelled";
          item.completedAt = new Date().toISOString();
        }
        continue;
      }
      queue.status = "running";
      item.status = "running";
      item.startedAt = new Date().toISOString();
      item.message = "Scanning availability";
      item.progress = {
        scanned: 0,
        total: Math.ceil(queue.weeksAhead / 2),
        percent: 0,
        blocked: 0,
        available: 0,
        errors: 0,
        label: "Starting scan",
        updatedAt: item.startedAt,
      };
      refreshBulkAvailabilityTotals(queue);

      try {
        const runId = await runAvailabilityScan(queue.weeksAhead, item.propertyId, {
          sidecarConcurrencyMode: "availability_bulk",
          windowConcurrency: 4,
          onProgress: (progress) => {
            item.progress = progress;
            item.message = progress.label;
          },
          shouldPause: () => bulkAvailabilityQueuePaused,
          shouldCancel: () => bulkAvailabilityQueueCancelRequested,
        });
        item.runId = runId > 0 ? runId : null;
        const cancelled = bulkAvailabilityQueueCancelRequested || scanAborted;
        item.status = cancelled ? "cancelled" : runId > 0 ? "success" : "error";
        item.message = cancelled ? "Cancelled" : runId > 0 ? `Completed as run #${runId}` : "Scan did not start";
        if (item.progress) {
          item.progress = {
            ...item.progress,
            percent: runId > 0 && !cancelled ? 100 : item.progress.percent,
            label: item.message,
            updatedAt: new Date().toISOString(),
          };
        }
      } catch (err: any) {
        item.status = "error";
        item.message = err?.message ?? String(err);
        if (item.progress) {
          item.progress = {
            ...item.progress,
            label: item.message,
            updatedAt: new Date().toISOString(),
          };
        }
        log(`Bulk availability scan failed for property ${item.propertyId}: ${item.message}`, "scanner");
      } finally {
        item.completedAt = new Date().toISOString();
        refreshBulkAvailabilityTotals(queue);
      }
    }

    queue.status = bulkAvailabilityQueueCancelRequested
      ? "cancelled"
      : queue.totals.error > 0
        ? "failed"
        : "completed";
  } finally {
    queue.completedAt = new Date().toISOString();
    refreshBulkAvailabilityTotals(queue);
    bulkAvailabilityQueueProcessing = false;
    bulkAvailabilityQueuePaused = false;
    bulkAvailabilityQueueCancelRequested = false;
    log(
      `Bulk availability queue ${queue.status}: ${queue.totals.success} completed, ${queue.totals.error} failed`,
      "scanner",
    );
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export async function runAvailabilityScan(
  weeksAhead = 52,
  targetPropertyId?: number,
  options: AvailabilityScanOptions = {},
): Promise<number> {
  if (scannerRunning) {
    log("Scanner already running, skipping", "scanner");
    return -1;
  }

  scannerRunning = true;
  currentScanPropertyId = targetPropertyId || null;
  let runId = -1;
  const laneOwnerId = `legacy-availability:${targetPropertyId ?? "all"}:${Date.now()}`;
  let lane: Awaited<ReturnType<typeof acquireSidecarLane>> | null = null;
  let laneHeartbeat: NodeJS.Timeout | null = null;

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

    const periodsAhead = Math.ceil(weeksAhead / 2);
    log(`Starting availability scan: ${label}, ${periodsAhead} periods (14-day blocks)`, "scanner");

    lane = await acquireSidecarLane({
      ownerType: "availability-scan",
      ownerId: laneOwnerId,
      label: `Legacy availability queue scan for ${label}`,
      pollMs: 1_000,
      shouldCancel: async () =>
        scanAborted ||
        isSidecarLaneCancellationRequested("availability-scan", laneOwnerId),
      onWait: async (owner) => {
        log(`Availability scan waiting for Chrome sidecar lane held by ${owner.label}`, "scanner");
      },
    });
    laneHeartbeat = setInterval(() => lane?.heartbeat(), 30_000);
    log(`Availability scan acquired Chrome sidecar lane for ${label}`, "scanner");

    const run = await storage.createScannerRun({
      status: "running",
      totalWeeksScanned: 0,
      totalBlocked: 0,
      totalAvailable: 0,
      totalErrors: 0,
    });
    runId = run.id;

    const windows = generateScanWindows(periodsAhead);
    const totalPeriods = propertyIds.length * windows.length;

    let totalScanned = 0;
    let totalBlocked = 0;
    let totalAvailable = 0;
    let totalErrors = 0;

    const searchCache: SearchCache = new Map();
    scanAborted = false;
    consecutiveRateLimits = 0;
    options.onProgress?.({
      scanned: 0,
      total: totalPeriods,
      percent: 0,
      blocked: 0,
      available: 0,
      errors: 0,
      label: `Queued ${totalPeriods} date window${totalPeriods === 1 ? "" : "s"}`,
      updatedAt: new Date().toISOString(),
    });

    const scanWindow = async (window: { checkIn: string; checkOut: string }, clearCacheAfterWindow: boolean) => {
      while (options.shouldPause?.() && !scanAborted) {
        options.onProgress?.({
          scanned: totalScanned,
          total: totalPeriods,
          percent: totalPeriods > 0 ? Math.round((totalScanned / totalPeriods) * 100) : 0,
          blocked: totalBlocked,
          available: totalAvailable,
          errors: totalErrors,
          label: "Paused",
          updatedAt: new Date().toISOString(),
        });
        await sleep(1_000);
      }
      if (options.shouldCancel?.()) {
        scanAborted = true;
      }
      if (isSidecarLaneCancellationRequested("availability-scan", laneOwnerId)) {
        scanAborted = true;
        log("Scan aborted because the Chrome sidecar lane was cancelled", "scanner");
        return;
      }
      if (scanAborted) {
        log(`Scan aborted due to API quota exhaustion after ${totalScanned} weeks`, "scanner");
        return;
      }

      for (const propertyId of propertyIds) {
        if (isSidecarLaneCancellationRequested("availability-scan", laneOwnerId)) {
          scanAborted = true;
          log("Scan aborted because the Chrome sidecar lane was cancelled", "scanner");
          break;
        }
        const config = PROPERTY_UNIT_NEEDS[propertyId];
        const uniqueBedrooms = Array.from(new Set(config.units.map(u => u.bedrooms)));

        let totalAirbnb = 0;
        let totalVrbo = 0;
        let totalBooking = 0;
        let totalAcrossChannels = 0;
        let hasError = false;
        let belowThreshold = false;
        const autoBlockAllowed = legacyBulkAutoBlockAllowed(config.community, window.checkIn, window.checkOut);
        let sidecarRanForThisWindow = false;

        for (const bedrooms of uniqueBedrooms) {
          if (scanAborted) break;

          const result = await searchCommunityBedroom(
            searchCache,
            config.community,
            bedrooms,
            window.checkIn,
            window.checkOut,
            { sidecarConcurrencyMode: options.sidecarConcurrencyMode },
          );

          if (result.error) hasError = true;
          if (result.sidecarRan) sidecarRanForThisWindow = true;
          totalAirbnb += result.airbnb;
          totalVrbo += result.vrbo;
          totalBooking += result.booking;
          totalAcrossChannels += result.total;

          // Block decision is per-bedroom: if ANY required bedroom
          // count comes up short across channels, the property can't
          // fulfill that window's mix and we should block the whole
          // window. (Operator buys ONE unit per bedroom slot — short
          // on 3BR means short overall, even if 2BR has plenty.)
          if (result.total < AVAILABILITY_THRESHOLD && !result.error) {
            belowThreshold = true;
          }
        }

        const shouldBlock = belowThreshold && !hasError && autoBlockAllowed;
        let status: string;

        if (hasError && totalAcrossChannels === 0) {
          status = "error";
          totalErrors++;
        } else if (shouldBlock) {
          status = "blocked";
          totalBlocked++;
        } else {
          status = "available";
          totalAvailable++;
        }

        await storage.createAvailabilityScan({
          runId: run.id,
          propertyId,
          community: config.community,
          checkIn: window.checkIn,
          checkOut: window.checkOut,
          bedroomConfig: JSON.stringify(uniqueBedrooms),
          airbnbResults: totalAirbnb,
          // vrboResults persists the sidecar-VRBO count when the
          // deep-scan ran; legacy callers reading this column still
          // get a sensible number. Booking + sidecar metadata aren't
          // schema'd yet — surface them in logs only for now.
          vrboResults: totalVrbo,
          totalResults: totalAcrossChannels,
          blocked: shouldBlock ? "true" : "false",
          lodgifyBlockIds: null,
          status,
        });

        if (sidecarRanForThisWindow) {
          log(
            `${config.community} ${window.checkIn}→${window.checkOut}: ` +
            `airbnb=${totalAirbnb} vrbo=${totalVrbo} booking=${totalBooking} ` +
            `total=${totalAcrossChannels} threshold=${AVAILABILITY_THRESHOLD} ` +
            `autoBlock=${autoBlockAllowed ? "yes" : "no"} ` +
            `→ ${status}`,
            "scanner",
          );
        }

        totalScanned++;
        const percent = totalPeriods > 0 ? Math.round((totalScanned / totalPeriods) * 100) : 100;
        options.onProgress?.({
          scanned: totalScanned,
          total: totalPeriods,
          percent: Math.max(0, Math.min(100, percent)),
          blocked: totalBlocked,
          available: totalAvailable,
          errors: totalErrors,
          label: `${config.name} ${window.checkIn}→${window.checkOut}: ${status}`,
          updatedAt: new Date().toISOString(),
        });

        await storage.updateScannerRun(run.id, {
          totalWeeksScanned: totalScanned,
          totalBlocked,
          totalAvailable,
          totalErrors,
        });

        if (totalScanned % 5 === 0) {
          log(`Scan progress: ${totalScanned}/${propertyIds.length * windows.length} weeks scanned, ${totalBlocked} blocked, ${totalAvailable} available, ${totalErrors} errors`, "scanner");
        }
      }

      if (clearCacheAfterWindow) searchCache.clear();
    };

    const shouldRunWindowsConcurrently = options.sidecarConcurrencyMode === "availability_bulk" && targetPropertyId;
    if (shouldRunWindowsConcurrently) {
      const windowConcurrency = options.windowConcurrency ?? 4;
      log(`Bulk availability sidecar concurrency enabled: ${windowConcurrency} date windows queued ahead for ${label}`, "scanner");
      await runWithConcurrency(windows, windowConcurrency, async (window) => {
        await scanWindow(window, false);
      });
      searchCache.clear();
    } else {
      for (const window of windows) {
        await scanWindow(window, true);
        if (scanAborted) break;
      }
    }

    const finalStatus = scanAborted ? "aborted" : "completed";
    await storage.updateScannerRun(run.id, {
      completedAt: new Date(),
      totalWeeksScanned: totalScanned,
      totalBlocked,
      totalAvailable,
      totalErrors,
      status: finalStatus,
    });

    log(`Scan ${finalStatus}: ${totalScanned} weeks scanned, ${totalBlocked} blocked, ${totalAvailable} available, ${totalErrors} errors`, "scanner");

    // ── Auto-publish blocks to Guesty ─────────────────────────────────
    // After a clean(ish) run, push the scanner's verdicts to each
    // property's Guesty calendar. Skip auto-publish when the run was
    // aborted (mid-flight cancel — incomplete data) or when the run
    // had errors AND zero successful scans (can't trust the verdicts).
    //
    // Only properties with at least one blocked-or-available verdict
    // get touched. Per-property: build the windows[] from the scan
    // rows, call the shared sync helper. Failures are logged per
    // property so one Guesty hiccup doesn't poison the whole batch.
    //
    // Auto-publish covers both directions: NEW blocks for newly-tight
    // windows, and UNBLOCK for previously-blocked windows that came
    // up green this scan. The shared helper diffs against the
    // scanner_blocks table and only modifies its own rows
    // (`source: nexstay-scanner`); operator-placed blocks elsewhere
    // are never touched.
    if (finalStatus === "completed" && !(totalErrors > 0 && totalAvailable === 0)) {
      try {
        const { syncScannerBlocksForProperty } = await import("./sync-scanner-blocks");
        const allScans = await storage.getAvailabilityScans({ runId: run.id });
        type Scan = typeof allScans[number];
        const scansByProperty = new Map<number, Scan[]>();
        for (const s of allScans) {
          if (s.propertyId == null) continue; // defensive — schema allows null
          const list = scansByProperty.get(s.propertyId) ?? [];
          list.push(s);
          scansByProperty.set(s.propertyId, list);
        }
        let autoCreated = 0;
        let autoRemoved = 0;
        let autoFailed = 0;
        for (const propertyId of Array.from(scansByProperty.keys())) {
          const scans = scansByProperty.get(propertyId)!;
          // Skip properties whose scans had ANY errors — don't risk
          // over-blocking on a flaky API run.
          const hasAnyError = scans.some((s: Scan) => s.status === "error");
          if (hasAnyError) {
            log(`auto-publish skipped for property ${propertyId} — scan had errors`, "scanner");
            continue;
          }
          const windows = scans.map((s: Scan) => ({
            startDate: s.checkIn,
            endDate: s.checkOut,
            verdict: (s.status === "blocked" ? "blocked" : "available") as "blocked" | "available",
            reason: s.status === "blocked"
              ? `multi-channel total ${s.totalResults} < threshold ${AVAILABILITY_THRESHOLD} inside auto-block horizon`
              : undefined,
          }));
          try {
            const r = await syncScannerBlocksForProperty(propertyId, windows);
            autoCreated += r.created;
            autoRemoved += r.removed;
            autoFailed += r.failures.length;
            if (r.created > 0 || r.removed > 0 || r.failures.length > 0) {
              log(
                `auto-publish ${PROPERTY_UNIT_NEEDS[propertyId].name} (${propertyId}): ` +
                `+${r.created} blocks, -${r.removed} unblocks` +
                (r.failures.length > 0 ? `, ${r.failures.length} failures` : ""),
                "scanner",
              );
            }
          } catch (e: any) {
            autoFailed++;
            log(`auto-publish error property ${propertyId}: ${e?.message ?? e}`, "scanner");
          }
        }
        log(
          `auto-publish summary: +${autoCreated} blocks, -${autoRemoved} unblocks, ${autoFailed} failures`,
          "scanner",
        );
      } catch (e: any) {
        log(`auto-publish phase failed: ${e?.message ?? e}`, "scanner");
      }
    } else {
      log(`auto-publish skipped — run status=${finalStatus} totalErrors=${totalErrors} totalAvailable=${totalAvailable}`, "scanner");
    }

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
    if (laneHeartbeat) clearInterval(laneHeartbeat);
    lane?.release();
    scannerRunning = false;
    currentScanPropertyId = null;
  }
}

export async function cleanupStaleRuns() {
  try {
    const count = await storage.cleanupStaleRuns();
    if (count > 0) {
      log(`Cleaned up ${count} stale scan run(s) from previous session`, "scanner");
    }
  } catch (err: any) {
    log(`Failed to cleanup stale runs: ${err.message}`, "scanner");
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
      try {
        await syncAllPropertiesToGuesty();
      } catch (err: any) {
        log(`Guesty weekly sync error: ${err.message}`, "scanner");
      }
      scheduleNext();
    }, msUntilNext);
  }

  scheduleNext();
  log("Weekly availability scanner scheduler started (every Monday 3am)", "scanner");
}
