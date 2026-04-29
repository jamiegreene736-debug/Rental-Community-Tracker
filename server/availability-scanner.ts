import { storage } from "./storage";
import { log } from "./index";
import { syncAllPropertiesToGuesty } from "./guesty-sync";

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

// Block a window when verified-bookable inventory across channels is
// below this threshold. Counts include same-unit cross-channel
// duplicates (we don't run photo-match here for speed), so 3 here
// is roughly equivalent to ~2 unique physical units. The legacy
// Airbnb-only threshold was 10 raw listings; multi-channel "verified
// + priced" counts much smaller numbers, hence the drop.
//
// Tuning: bump to 4-5 if too many windows get blocked in practice
// (signals our cross-channel duplication is heavier than expected);
// drop to 2 if we want the operator to take more risk on tight
// windows.
const AVAILABILITY_THRESHOLD = 3;

// Defer to the sidecar deep-scan only when Airbnb returns BORDERLINE
// inventory (< this number of listings). When Airbnb already shows
// plenty (>= 2× threshold), the window is plainly available and
// running sidecar VRBO+Booking would just waste the daemon budget.
// 2× the threshold keeps the deep-scan honest — if Airbnb shows
// anywhere near the edge, we want VRBO+Booking signal too.
const SIDECAR_DEEP_SCAN_BORDERLINE = AVAILABILITY_THRESHOLD * 2;

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

// Multi-channel availability check.
//
// Step 1 — always: Airbnb engine (fast, ~5s, no daemon needed).
// Step 2 — only when borderline: sidecar VRBO + sidecar Booking in
//          parallel via the local Chrome daemon. "Borderline" =
//          Airbnb listings count < SIDECAR_DEEP_SCAN_BORDERLINE.
//          Plenty-of-Airbnb windows skip the deep scan to keep the
//          weekly cron's wall time bounded (~2h instead of ~7h).
//
// Returns: a per-channel breakdown + a `total` count that callers
// compare against AVAILABILITY_THRESHOLD. Total is the sum across
// channels — cross-channel duplicates inflate it slightly, but the
// threshold is calibrated for that.
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
  const error = airbnbCount === -1;
  const airbnbSafe = Math.max(0, airbnbCount);

  // Plenty-of-Airbnb fast path: don't burn the sidecar budget. Most
  // windows hit this branch and finish in ~5s.
  if (!error && airbnbSafe >= SIDECAR_DEEP_SCAN_BORDERLINE) {
    const entry: CacheEntry = {
      airbnb: airbnbSafe,
      vrbo: 0,
      booking: 0,
      total: airbnbSafe,
      sidecarRan: false,
      daemonOnline: false,
      error: false,
    };
    cache.set(cacheKey, entry);
    await sleep(3000);
    return entry;
  }

  // Borderline OR Airbnb error → bring in sidecar. Wide error catches
  // because sidecar is best-effort: if the daemon is offline / VRBO
  // queries time out, we just count what we have and let the
  // threshold decide.
  let vrboCount = 0;
  let bookingCount = 0;
  let daemonOnline = false;
  let sidecarRan = false;
  try {
    const { searchVrboViaSidecar, searchBookingViaSidecar } = await import("./vrbo-sidecar-queue");
    sidecarRan = true;
    const [vrboRes, bookingRes] = await Promise.all([
      searchVrboViaSidecar({
        destination: community,
        checkIn,
        checkOut,
        bedrooms,
        walletBudgetMs: 60_000,
      }).catch(() => null),
      searchBookingViaSidecar({
        destination: community,
        checkIn,
        checkOut,
        bedrooms,
        walletBudgetMs: 60_000,
      }).catch(() => null),
    ]);
    if (vrboRes) {
      daemonOnline = daemonOnline || vrboRes.workerOnline;
      // Count priced cards that match the requested bedroom count
      // (sidecar VRBO scrape sets `bedrooms` from the card text when
      // available; null bedrooms is permissive — count it as a match).
      vrboCount = vrboRes.candidates.filter(
        (c) => c.nightlyPrice > 0 && (c.bedrooms == null || c.bedrooms === bedrooms),
      ).length;
    }
    if (bookingRes) {
      daemonOnline = daemonOnline || bookingRes.workerOnline;
      bookingCount = bookingRes.candidates.filter((c) => c.totalPrice > 0).length;
    }
  } catch (e: any) {
    log(`sidecar deep-scan error (${community} ${bedrooms}BR ${checkIn}): ${e?.message ?? e}`, "scanner");
  }

  const total = airbnbSafe + vrboCount + bookingCount;
  const entry: CacheEntry = {
    airbnb: airbnbSafe,
    vrbo: vrboCount,
    booking: bookingCount,
    total,
    sidecarRan,
    daemonOnline,
    error,
  };
  cache.set(cacheKey, entry);
  await sleep(3000);
  return entry;
}

let scannerRunning = false;
let currentScanPropertyId: number | null = null;
let scanAborted = false;

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
      bedrooms: [...new Set(config.units.map(u => u.bedrooms))].sort(),
      totalBedrooms: config.units.reduce((sum, u) => sum + u.bedrooms, 0),
    }));
}

export function getPropertyName(propertyId: number): string {
  return PROPERTY_UNIT_NEEDS[propertyId]?.name || `Property #${propertyId}`;
}

export async function runAvailabilityScan(weeksAhead = 52, targetPropertyId?: number): Promise<number> {
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

    const periodsAhead = Math.ceil(weeksAhead / 2);
    log(`Starting availability scan: ${label}, ${periodsAhead} periods (14-day blocks)`, "scanner");

    const run = await storage.createScannerRun({
      status: "running",
      totalWeeksScanned: 0,
      totalBlocked: 0,
      totalAvailable: 0,
      totalErrors: 0,
    });
    runId = run.id;

    const windows = generateScanWindows(periodsAhead);

    let totalScanned = 0;
    let totalBlocked = 0;
    let totalAvailable = 0;
    let totalErrors = 0;

    const searchCache: SearchCache = new Map();
    scanAborted = false;
    consecutiveRateLimits = 0;

    for (const window of windows) {
      if (scanAborted) {
        log(`Scan aborted due to API quota exhaustion after ${totalScanned} weeks`, "scanner");
        break;
      }

      for (const propertyId of propertyIds) {
        const config = PROPERTY_UNIT_NEEDS[propertyId];
        const uniqueBedrooms = [...new Set(config.units.map(u => u.bedrooms))];

        let totalAirbnb = 0;
        let totalVrbo = 0;
        let totalBooking = 0;
        let totalAcrossChannels = 0;
        let hasError = false;
        let belowThreshold = false;
        let sidecarRanForThisWindow = false;

        for (const bedrooms of uniqueBedrooms) {
          if (scanAborted) break;

          const result = await searchCommunityBedroom(
            searchCache,
            config.community,
            bedrooms,
            window.checkIn,
            window.checkOut
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

        const shouldBlock = belowThreshold && !hasError;
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
            `→ ${status}`,
            "scanner",
          );
        }

        totalScanned++;

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

      searchCache.clear();
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
              ? `multi-channel total ${s.totalResults} < threshold ${AVAILABILITY_THRESHOLD}`
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
