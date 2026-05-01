import type { PropertyUnitConfig } from "@shared/property-units";
import { computeSetsFromCounts } from "./availability-search";
import {
  fetchMultiChannelBuyInByBR,
  inferRegion,
  type MultiChannelBuyInResult,
  type RegionKey,
  type SeasonKey,
} from "./multichannel-buy-in";

export type AvailabilityChannelCounts = {
  airbnb: number;
  vrbo: number;
  booking: number;
  pm: number;
  total: number;
  effective: number;
};

export type SeasonalAvailabilityWindow = {
  season: SeasonKey;
  startDate: string;
  endDate: string;
  nights: number;
  verdict: "open" | "tight" | "blocked";
  maxSets: number;
  minSets: number;
  openMinSets: number;
  blockMinSets: number;
  listingCounts: Record<number, number>;
  channelCounts: Record<number, AvailabilityChannelCounts>;
  daemonOnline: boolean;
  reason: string;
};

export type SeasonalAvailabilityResult = {
  propertyId: number;
  community: string;
  searchName: string;
  region: RegionKey;
  windows: SeasonalAvailabilityWindow[];
  thresholds: AvailabilityThresholds;
  durationMs: number;
};

export type AvailabilityLocation = {
  searchName: string;
  city: string;
  state: string;
  streetAddress?: string;
  lat?: number;
  lng?: number;
};

export type AvailabilityThresholds = {
  requiredByBR: Record<number, number>;
  openCandidatesByBR: Record<number, number>;
  blockCandidatesByBR: Record<number, number>;
  openMinSets: number;
  blockMinSets: number;
};

const SEASONS: SeasonKey[] = ["LOW", "HIGH", "HOLIDAY"];
const SEASON_SCAN_HEARTBEAT_MS = 12_000;

let seasonalScanQueue: Promise<unknown> = Promise.resolve();
let seasonalScanActive: { propertyId: number; startedAt: number } | null = null;
let seasonalScanQueued = 0;

export function getSeasonalAvailabilityQueueStatus() {
  return {
    active: seasonalScanActive,
    queued: seasonalScanQueued,
  };
}

export const AVAILABILITY_LOCATION_BY_COMMUNITY: Record<string, AvailabilityLocation> = {
  "Poipu Kai":         { searchName: "Regency at Poipu Kai",        city: "Koloa",       state: "Hawaii", streetAddress: "1831 Poipu Rd",              lat: 21.8794, lng: -159.4609 },
  "Kekaha Beachfront": { searchName: "Kekaha Beachfront",           city: "Kekaha",      state: "Hawaii", streetAddress: "8497 Kekaha Rd",             lat: 21.9678, lng: -159.7464 },
  "Keauhou":           { searchName: "Keauhou Estates",             city: "Kailua-Kona", state: "Hawaii", streetAddress: "78-6855 Ali'i Dr",           lat: 19.5493, lng: -155.9704 },
  "Princeville":       { searchName: "Mauna Kai Princeville",       city: "Princeville", state: "Hawaii", streetAddress: "3920 Wyllie Rd",             lat: 22.2218, lng: -159.4849 },
  "Kapaa Beachfront":  { searchName: "Kaha Lani Resort",            city: "Wailua",      state: "Hawaii",                                              lat: 22.0360, lng: -159.3370 },
  "Poipu Oceanfront":  { searchName: "Poipu Brenneckes Oceanfront", city: "Koloa",       state: "Hawaii", streetAddress: "2298 Ho'one Rd",             lat: 21.8744, lng: -159.4538 },
  "Poipu Brenneckes":  { searchName: "Poipu Brenneckes",            city: "Koloa",       state: "Hawaii", streetAddress: "2298 Ho'one Rd",             lat: 21.8744, lng: -159.4538 },
  "Pili Mai":          { searchName: "Pili Mai at Poipu",           city: "Koloa",       state: "Hawaii", streetAddress: "2611 Kiahuna Plantation Dr", lat: 21.8865, lng: -159.4729 },
  "Windsor Hills":     { searchName: "Windsor Hills Resort",        city: "Kissimmee",   state: "Florida",                                             lat: 28.3189, lng: -81.5968 },
};

export function resolveAvailabilityLocation(community: string, resortName?: string | null): AvailabilityLocation {
  return AVAILABILITY_LOCATION_BY_COMMUNITY[community] ?? {
    searchName: resortName || community,
    city: community,
    state: "Hawaii",
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const start = new Date(`${checkIn}T12:00:00Z`).getTime();
  const end = new Date(`${checkOut}T12:00:00Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("seasonal availability scan cancelled");
  err.name = "AbortError";
  throw err;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function enqueueSeasonalScan<T>(
  args: {
    propertyId: number;
    signal?: AbortSignal;
    onPhase?: (label: string) => void;
  },
  run: () => Promise<T>,
): Promise<T> {
  const queuedAhead = seasonalScanQueued + (seasonalScanActive ? 1 : 0);
  seasonalScanQueued++;

  let waitHeartbeat: NodeJS.Timeout | null = null;
  const queuedAt = Date.now();
  if (queuedAhead > 0) {
    args.onPhase?.(`Waiting for sidecar scan slot (${queuedAhead} ahead)`);
    waitHeartbeat = setInterval(() => {
      args.onPhase?.(`Waiting for sidecar scan slot (${formatElapsed(Date.now() - queuedAt)})`);
    }, SEASON_SCAN_HEARTBEAT_MS);
  }

  const task = seasonalScanQueue.then(async () => {
    if (waitHeartbeat) clearInterval(waitHeartbeat);
    seasonalScanQueued = Math.max(0, seasonalScanQueued - 1);
    throwIfAborted(args.signal);
    seasonalScanActive = { propertyId: args.propertyId, startedAt: Date.now() };
    try {
      return await run();
    } finally {
      seasonalScanActive = null;
    }
  });

  seasonalScanQueue = task.catch(() => undefined);
  return task;
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function seasonForMonth(region: RegionKey, yearMonth: string): "LOW" | "HIGH" {
  const hawaii: Record<number, "LOW" | "HIGH"> = {
    1: "HIGH", 2: "LOW", 3: "HIGH", 4: "HIGH",
    5: "LOW", 6: "HIGH", 7: "HIGH", 8: "HIGH",
    9: "LOW", 10: "LOW", 11: "LOW", 12: "HIGH",
  };
  const florida: Record<number, "LOW" | "HIGH"> = {
    1: "LOW", 2: "LOW", 3: "HIGH", 4: "HIGH",
    5: "LOW", 6: "HIGH", 7: "HIGH", 8: "HIGH",
    9: "LOW", 10: "LOW", 11: "LOW", 12: "HIGH",
  };
  const month = Number(yearMonth.slice(5, 7));
  return (region === "florida" ? florida : hawaii)[month] ?? "LOW";
}

export function pickAvailabilitySeasonWindow(args: {
  propertyId: number;
  region: RegionKey;
  season: SeasonKey;
  now?: Date;
}): { checkIn: string; checkOut: string; nights: number } {
  const now = args.now ? new Date(args.now) : new Date();
  now.setUTCHours(0, 0, 0, 0);
  const seedMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const seed = hashString(`${args.propertyId}:${args.region}:${args.season}:${seedMonth}`);
  const nights = 7 + (seed % 8);
  const minStart = new Date(now);
  minStart.setUTCDate(minStart.getUTCDate() + 30);

  if (args.season === "HOLIDAY") {
    const holidayStarts: Array<{ month: number; day: number }> = [
      { month: 12, day: 20 },
      { month: 7, day: 1 },
      { month: 11, day: 22 },
      { month: 3, day: 15 },
      { month: 2, day: 14 },
    ];
    const candidates: Date[] = [];
    for (let yearOffset = 0; yearOffset <= 2; yearOffset++) {
      const year = now.getUTCFullYear() + yearOffset;
      for (const h of holidayStarts) {
        const start = new Date(Date.UTC(year, h.month - 1, h.day));
        if (start > minStart) candidates.push(start);
      }
    }
    candidates.sort((a, b) => a.getTime() - b.getTime());
    const base = candidates[seed % Math.max(1, Math.min(4, candidates.length))] ?? candidates[0] ?? minStart;
    const offset = seed % 4;
    const checkIn = new Date(base);
    checkIn.setUTCDate(checkIn.getUTCDate() + offset);
    const checkOut = new Date(checkIn);
    checkOut.setUTCDate(checkOut.getUTCDate() + nights);
    return { checkIn: ymd(checkIn), checkOut: ymd(checkOut), nights };
  }

  const matchingMonths: Date[] = [];
  for (let monthOffset = 1; monthOffset <= 24; monthOffset++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
    const yearMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (seasonForMonth(args.region, yearMonth) === args.season) matchingMonths.push(d);
  }
  const month = matchingMonths[seed % Math.max(1, Math.min(6, matchingMonths.length))] ?? matchingMonths[0] ?? minStart;
  const maxStartDay = Math.max(1, daysInMonth(month.getUTCFullYear(), month.getUTCMonth()) - nights);
  const startDay = Math.min(maxStartDay, 4 + ((seed >>> 8) % 17));
  const checkIn = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), startDay));
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + nights);
  return { checkIn: ymd(checkIn), checkOut: ymd(checkOut), nights };
}

export function computeAvailabilityThresholds(
  units: PropertyUnitConfig["units"],
  manualMinSets = 1,
): AvailabilityThresholds {
  const requiredByBR: Record<number, number> = {};
  for (const unit of units) requiredByBR[unit.bedrooms] = (requiredByBR[unit.bedrooms] ?? 0) + 1;

  const openCandidatesByBR: Record<number, number> = {};
  const blockCandidatesByBR: Record<number, number> = {};
  let openMinSets = 1;
  let blockMinSets = Math.max(1, manualMinSets);
  for (const [brRaw, required] of Object.entries(requiredByBR)) {
    const br = Number(brRaw);
    const openCandidates = Math.max(12, required * 10);
    const blockCandidates = Math.max(6, required * 5);
    openCandidatesByBR[br] = openCandidates;
    blockCandidatesByBR[br] = blockCandidates;
    openMinSets = Math.max(openMinSets, Math.ceil(openCandidates / required));
    blockMinSets = Math.max(blockMinSets, Math.ceil(blockCandidates / required));
  }

  return { requiredByBR, openCandidatesByBR, blockCandidatesByBR, openMinSets, blockMinSets };
}

function effectiveAvailabilityCount(counts: Omit<AvailabilityChannelCounts, "effective">): number {
  const values = [counts.airbnb, counts.vrbo, counts.booking, counts.pm].filter((n) => n > 0);
  if (values.length === 0) return 0;
  const maxChannel = Math.max(...values);
  const extra = Math.max(0, counts.total - maxChannel);
  return Math.floor(maxChannel + extra * 0.35);
}

function verdictForSeason(
  maxSets: number,
  thresholds: AvailabilityThresholds,
  daemonOnline: boolean,
): SeasonalAvailabilityWindow["verdict"] {
  const verdict =
    maxSets < thresholds.blockMinSets ? "blocked"
    : maxSets < thresholds.openMinSets ? "tight"
    : "open";
  // If the daemon was offline, the scan is incomplete. Keep the warning
  // visible as tight, but do not auto-block based on Airbnb-only data.
  if (!daemonOnline && verdict === "blocked") return "tight";
  return verdict;
}

function buildWindowFromScan(args: {
  season: SeasonKey;
  window: { checkIn: string; checkOut: string; nights: number };
  scan: MultiChannelBuyInResult;
  units: PropertyUnitConfig["units"];
  thresholds: AvailabilityThresholds;
}): SeasonalAvailabilityWindow {
  const channelCounts: SeasonalAvailabilityWindow["channelCounts"] = {};
  const effectiveCountsByBR: Record<number, number> = {};
  for (const br of Object.keys(args.thresholds.requiredByBR).map(Number)) {
    const raw = args.scan.channelAvailableCountsByBR[br] ?? { airbnb: 0, vrbo: 0, booking: 0, pm: 0, total: 0 };
    const counts = { ...raw, effective: effectiveAvailabilityCount(raw) };
    channelCounts[br] = counts;
    effectiveCountsByBR[br] = counts.effective;
  }
  const maxSets = computeSetsFromCounts(args.units, effectiveCountsByBR);
  const verdict = verdictForSeason(maxSets, args.thresholds, args.scan.daemonOnline);
  const reason = args.scan.daemonOnline
    ? `${args.season} sample found ${maxSets} de-duped set(s); block below ${args.thresholds.blockMinSets}, open at ${args.thresholds.openMinSets}.`
    : `${args.season} sample only partially verified because the sidecar was offline; not auto-blocking from incomplete data.`;
  return {
    season: args.season,
    startDate: args.window.checkIn,
    endDate: args.window.checkOut,
    nights: args.window.nights,
    verdict,
    maxSets,
    minSets: args.thresholds.blockMinSets,
    openMinSets: args.thresholds.openMinSets,
    blockMinSets: args.thresholds.blockMinSets,
    listingCounts: effectiveCountsByBR,
    channelCounts,
    daemonOnline: args.scan.daemonOnline,
    reason,
  };
}

function buildErrorWindow(args: {
  season: SeasonKey;
  window: { checkIn: string; checkOut: string; nights: number };
  units: PropertyUnitConfig["units"];
  thresholds: AvailabilityThresholds;
  error: unknown;
}): SeasonalAvailabilityWindow {
  const channelCounts: SeasonalAvailabilityWindow["channelCounts"] = {};
  const effectiveCountsByBR: Record<number, number> = {};
  for (const br of Object.keys(args.thresholds.requiredByBR).map(Number)) {
    channelCounts[br] = { airbnb: 0, vrbo: 0, booking: 0, pm: 0, total: 0, effective: 0 };
    effectiveCountsByBR[br] = 0;
  }
  const message = args.error instanceof Error ? args.error.message : String(args.error);
  return {
    season: args.season,
    startDate: args.window.checkIn,
    endDate: args.window.checkOut,
    nights: args.window.nights,
    verdict: "tight",
    maxSets: 0,
    minSets: args.thresholds.blockMinSets,
    openMinSets: args.thresholds.openMinSets,
    blockMinSets: args.thresholds.blockMinSets,
    listingCounts: effectiveCountsByBR,
    channelCounts,
    daemonOnline: false,
    reason: `${args.season} scan failed (${message.slice(0, 120)}); not auto-blocking from a failed scan.`,
  };
}

export async function scanSeasonalAvailabilityCapacity(args: {
  propertyId: number;
  config: PropertyUnitConfig;
  resortName?: string | null;
  manualMinSets?: number;
  signal?: AbortSignal;
  onPhase?: (label: string) => void;
  onWindow?: (window: SeasonalAvailabilityWindow) => void;
}): Promise<SeasonalAvailabilityResult> {
  return enqueueSeasonalScan(args, () => runSeasonalAvailabilityCapacity(args));
}

async function runSeasonalAvailabilityCapacity(args: {
  propertyId: number;
  config: PropertyUnitConfig;
  resortName?: string | null;
  manualMinSets?: number;
  signal?: AbortSignal;
  onPhase?: (label: string) => void;
  onWindow?: (window: SeasonalAvailabilityWindow) => void;
}): Promise<SeasonalAvailabilityResult> {
  const startedAt = Date.now();
  const loc = resolveAvailabilityLocation(args.config.community, args.resortName);
  const region = inferRegion(loc.city, loc.state);
  const thresholds = computeAvailabilityThresholds(args.config.units, args.manualMinSets ?? 1);
  const bedroomCounts = Object.keys(thresholds.requiredByBR).map(Number).sort((a, b) => a - b);
  const windows = SEASONS.map((season) => ({
    season,
    window: pickAvailabilitySeasonWindow({ propertyId: args.propertyId, region, season }),
  }));

  const results: SeasonalAvailabilityWindow[] = [];
  for (const { season, window } of windows) {
    throwIfAborted(args.signal);
    args.onPhase?.(`Scanning ${season} sample (${window.checkIn} to ${window.checkOut})`);
    const seasonStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      args.onPhase?.(`Still scanning ${season} sample (${formatElapsed(Date.now() - seasonStartedAt)})`);
    }, SEASON_SCAN_HEARTBEAT_MS);
    try {
      const scan = await fetchMultiChannelBuyInByBR({
        community: loc.searchName,
        city: loc.city,
        state: loc.state,
        streetAddress: loc.streetAddress,
        bboxCenterOverride: loc.lat != null && loc.lng != null ? { lat: loc.lat, lng: loc.lng } : undefined,
        searchName: loc.searchName,
        bedroomCounts,
        dateOverride: { checkIn: window.checkIn, checkOut: window.checkOut },
      });
      const result = buildWindowFromScan({ season, window, scan, units: args.config.units, thresholds });
      results.push(result);
      args.onWindow?.(result);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const result = buildErrorWindow({ season, window, units: args.config.units, thresholds, error });
      results.push(result);
      args.onWindow?.(result);
    } finally {
      clearInterval(heartbeat);
    }
  }

  results.sort((a, b) => SEASONS.indexOf(a.season) - SEASONS.indexOf(b.season));
  return {
    propertyId: args.propertyId,
    community: args.config.community,
    searchName: loc.searchName,
    region,
    windows: results,
    thresholds,
    durationMs: Date.now() - startedAt,
  };
}

export function aggregateSeasonalCandidates(
  windows: SeasonalAvailabilityWindow[],
): {
  countsByBR: Record<number, number>;
  channelCountsByBR: Record<number, AvailabilityChannelCounts>;
  baselineSets: number;
  baselineVerdict: "open" | "tight" | "blocked";
} {
  const countsByBR: Record<number, number> = {};
  const channelCountsByBR: Record<number, AvailabilityChannelCounts> = {};
  let baselineSets = Infinity;
  let baselineVerdict: "open" | "tight" | "blocked" = "open";
  const severity = { open: 0, tight: 1, blocked: 2 };
  for (const window of windows) {
    baselineSets = Math.min(baselineSets, window.maxSets);
    if (severity[window.verdict] > severity[baselineVerdict]) baselineVerdict = window.verdict;
    for (const [brRaw, counts] of Object.entries(window.channelCounts)) {
      const br = Number(brRaw);
      countsByBR[br] = countsByBR[br] == null ? counts.effective : Math.min(countsByBR[br], counts.effective);
      const current = channelCountsByBR[br];
      if (!current || counts.effective < current.effective) channelCountsByBR[br] = counts;
    }
  }
  return {
    countsByBR,
    channelCountsByBR,
    baselineSets: baselineSets === Infinity ? 0 : baselineSets,
    baselineVerdict,
  };
}
