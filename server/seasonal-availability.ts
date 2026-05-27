import type { PropertyUnitConfig } from "@shared/property-units";
import { computeSetsFromCounts } from "./availability-search";
import {
  fetchMultiChannelBuyInByBR,
  inferRegion,
  type MultiChannelBuyInResult,
  type RegionKey,
  type ScanWarning,
  type SeasonKey,
} from "./multichannel-buy-in";
import { getSidecarStopGeneration, hasSidecarStopGenerationChanged } from "./vrbo-sidecar-queue";
import { acquireSidecarLane, isSidecarLaneCancellationRequested } from "./sidecar-lane";

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
export const AVAILABILITY_SCAN_MONTHS = 24;
export const AVAILABILITY_WINDOWS_PER_MONTH = 2;
export const AVAILABILITY_WINDOW_NIGHTS = 14;
export const AVAILABILITY_RELIABILITY_FACTOR = 0.5;

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

export function availabilityWindowCountForWeeks(weeks = 104): number {
  const months = Math.min(Math.max(Math.round((weeks / 52) * 12), 1), AVAILABILITY_SCAN_MONTHS);
  return months * AVAILABILITY_WINDOWS_PER_MONTH;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const start = new Date(`${checkIn}T12:00:00Z`).getTime();
  const end = new Date(`${checkOut}T12:00:00Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

export function generateTwiceMonthlyAvailabilityWindows(args: {
  weeks?: number;
  now?: Date;
}): Array<{ checkIn: string; checkOut: string; nights: number }> {
  const targetCount = availabilityWindowCountForWeeks(args.weeks ?? 104);
  const windows: Array<{ checkIn: string; checkOut: string; nights: number }> = [];
  const now = args.now ? new Date(args.now) : new Date();
  now.setUTCHours(12, 0, 0, 0);
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12, 0, 0));

  while (windows.length < targetCount) {
    for (const day of [1, 15]) {
      const checkIn = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), day, 12, 0, 0));
      if (checkIn < now) continue;
      const checkOut = new Date(checkIn);
      checkOut.setUTCDate(checkOut.getUTCDate() + AVAILABILITY_WINDOW_NIGHTS);
      windows.push({ checkIn: ymd(checkIn), checkOut: ymd(checkOut), nights: AVAILABILITY_WINDOW_NIGHTS });
      if (windows.length >= targetCount) break;
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return windows;
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
  const laneOwnerId = `seasonal-availability:${args.propertyId}:${queuedAt}`;
  const laneLabel = `Availability sidecar scan for property ${args.propertyId}`;
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
    const lane = await acquireSidecarLane({
      ownerType: "availability-scan",
      ownerId: laneOwnerId,
      label: laneLabel,
      pollMs: 1_000,
      shouldCancel: async () =>
        Boolean(args.signal?.aborted) ||
        isSidecarLaneCancellationRequested("availability-scan", laneOwnerId),
      onWait: async (owner) => {
        args.onPhase?.(`Waiting for Chrome sidecar lane held by ${owner.label}`);
      },
    });
    const laneHeartbeat = setInterval(() => lane.heartbeat(), 30_000);
    try {
      args.onPhase?.("Chrome sidecar lane acquired for availability scan");
      return await run();
    } finally {
      clearInterval(laneHeartbeat);
      lane.release();
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
  // Availability blackouts are written as 7-night windows, so keep the
  // sidecar sample window exactly 7 nights as well.
  const nights = 7;
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
  // Default rule: block only when we cannot verify at least 3 full
  // independent buy-in sets, mark
  // tight until 2 extra cushion sets are visible, then open. This keeps
  // the net wide enough to catch unlabeled-but-valid resort listings
  // while still avoiding the "last pair available" oversell risk.
  const blockMinSets = Math.max(3, manualMinSets);
  const openMinSets = blockMinSets + 2;
  for (const [brRaw, required] of Object.entries(requiredByBR)) {
    const br = Number(brRaw);
    const openCandidates = required * openMinSets;
    const blockCandidates = required * blockMinSets;
    openCandidatesByBR[br] = openCandidates;
    blockCandidatesByBR[br] = blockCandidates;
  }

  return { requiredByBR, openCandidatesByBR, blockCandidatesByBR, openMinSets, blockMinSets };
}

function effectiveAvailabilityCount(counts: Omit<AvailabilityChannelCounts, "effective">): number {
  return Math.floor(counts.total * AVAILABILITY_RELIABILITY_FACTOR);
}

const BLOCKING_QUALITY_WARNING_KINDS = new Set<ScanWarning["kind"]>([
  "captcha",
  "blocked",
  "rate-limit",
  "timeout",
  "network",
]);

export function availabilityBlockingQualityIssue(
  scan: Pick<MultiChannelBuyInResult, "daemonOnline" | "warnings">,
): string | null {
  if (!scan.daemonOnline) return "sidecar offline or incomplete";
  const warning = scan.warnings.find((w) => BLOCKING_QUALITY_WARNING_KINDS.has(w.kind));
  if (!warning) return null;
  const channel = warning.channel === "engine" ? "engine" : warning.channel.toUpperCase();
  return `${channel} ${warning.kind}${warning.reason ? `: ${warning.reason.slice(0, 120)}` : ""}`;
}

export function availabilityVerdictForScan(
  maxSets: number,
  thresholds: AvailabilityThresholds,
  scan: Pick<MultiChannelBuyInResult, "daemonOnline" | "warnings">,
): SeasonalAvailabilityWindow["verdict"] {
  const verdict =
    maxSets < thresholds.blockMinSets ? "blocked"
    : maxSets < thresholds.openMinSets ? "tight"
    : "open";
  // Only auto-block from a clean, complete sidecar scan. Provider CAPTCHA,
  // bot walls, timeouts, rate limits, network errors, and offline daemon
  // states can all look like "0 inventory"; keep those visible as tight
  // instead of writing a calendar blackout from incomplete evidence.
  if (verdict === "blocked" && availabilityBlockingQualityIssue(scan)) return "tight";
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
  const qualityIssue = availabilityBlockingQualityIssue(args.scan);
  const verdict = availabilityVerdictForScan(maxSets, args.thresholds, args.scan);
  const reason = qualityIssue && maxSets < args.thresholds.blockMinSets
    ? `${args.season} sample found ${maxSets} effective set(s), but ${qualityIssue}; not auto-blocking from incomplete provider evidence.`
    : args.scan.daemonOnline
    ? `${args.season} ${args.window.nights}-night window found ${maxSets} effective set(s) after ${Math.round(AVAILABILITY_RELIABILITY_FACTOR * 100)}% reliability haircut; block below ${args.thresholds.blockMinSets}, open at ${args.thresholds.openMinSets}.`
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

function holidayDate(d: Date): boolean {
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return (month === 12 && day >= 20)
    || (month === 1 && day <= 5)
    || (month === 7 && day >= 1 && day <= 7)
    || (month === 11 && day >= 22 && day <= 30)
    || (month === 3 && day >= 15)
    || (month === 4 && day <= 5)
    || (month === 2 && day >= 14 && day <= 17);
}

function seasonForWindow(region: RegionKey, start: Date, nights: number): SeasonKey {
  for (let i = 0; i < nights; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (holidayDate(d)) return "HOLIDAY";
  }
  const yearMonth = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return seasonForMonth(region, yearMonth);
}

function expandSeasonSamplesToWeekly(args: {
  samples: SeasonalAvailabilityWindow[];
  region: RegionKey;
  weeks: number;
  now?: Date;
}): SeasonalAvailabilityWindow[] {
  const bySeason = new Map<SeasonKey, SeasonalAvailabilityWindow>();
  for (const sample of args.samples) bySeason.set(sample.season, sample);

  const start = args.now ? new Date(args.now) : new Date();
  start.setUTCHours(12, 0, 0, 0);

  const windows: SeasonalAvailabilityWindow[] = [];
  for (let i = 0; i < args.weeks; i++) {
    const checkIn = new Date(start);
    checkIn.setUTCDate(checkIn.getUTCDate() + i * 7);
    const checkOut = new Date(checkIn);
    checkOut.setUTCDate(checkOut.getUTCDate() + 7);
    const season = seasonForWindow(args.region, checkIn, 7);
    const template = bySeason.get(season);
    if (!template) continue;
    windows.push({
      ...template,
      season,
      startDate: ymd(checkIn),
      endDate: ymd(checkOut),
      nights: 7,
      reason: `${season} sidecar sample ${template.startDate}→${template.endDate} found ${template.maxSets} de-duped set(s); applied to this 7-night week. Block below ${template.blockMinSets}, open at ${template.openMinSets}.`,
    });
  }
  return windows;
}

export async function scanSeasonalAvailabilityCapacity(args: {
  propertyId: number;
  config: PropertyUnitConfig;
  resortName?: string | null;
  manualMinSets?: number;
  weeks?: number;
  now?: Date;
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
  weeks?: number;
  now?: Date;
  signal?: AbortSignal;
  onPhase?: (label: string) => void;
  onWindow?: (window: SeasonalAvailabilityWindow) => void;
}): Promise<SeasonalAvailabilityResult> {
  const startedAt = Date.now();
  const loc = resolveAvailabilityLocation(args.config.community, args.resortName);
  const region = inferRegion(loc.city, loc.state);
  const thresholds = computeAvailabilityThresholds(args.config.units, args.manualMinSets ?? 1);
  const bedroomCounts = Object.keys(thresholds.requiredByBR).map(Number).sort((a, b) => a - b);
  const weeks = Math.min(Math.max(args.weeks ?? 104, 1), 104);
  const sidecarStopGeneration = getSidecarStopGeneration();
  const assertSidecarRunCurrent = () => {
    if (hasSidecarStopGenerationChanged(sidecarStopGeneration)) {
      const err = new Error("sidecar run cancelled by operator stop");
      err.name = "SidecarRunCancelledError";
      throw err;
    }
  };
  const windows = generateTwiceMonthlyAvailabilityWindows({ weeks, now: args.now }).map((window) => ({
    season: seasonForWindow(region, new Date(`${window.checkIn}T12:00:00Z`), window.nights),
    window,
  }));

  const sampleResults: SeasonalAvailabilityWindow[] = [];
  for (let idx = 0; idx < windows.length; idx++) {
    const { season, window } = windows[idx];
    throwIfAborted(args.signal);
    assertSidecarRunCurrent();
    args.onPhase?.(`Scanning ${season} 14-night window ${idx + 1}/${windows.length} (${window.checkIn} to ${window.checkOut})`);
    const seasonStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      args.onPhase?.(`Still scanning ${season} window ${idx + 1}/${windows.length} (${formatElapsed(Date.now() - seasonStartedAt)})`);
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
        sidecarStopGeneration,
      });
      assertSidecarRunCurrent();
      const result = buildWindowFromScan({ season, window, scan, units: args.config.units, thresholds });
      sampleResults.push(result);
      args.onWindow?.(result);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const result = buildErrorWindow({ season, window, units: args.config.units, thresholds, error });
      sampleResults.push(result);
      args.onWindow?.(result);
    } finally {
      clearInterval(heartbeat);
    }
  }

  return {
    propertyId: args.propertyId,
    community: args.config.community,
    searchName: loc.searchName,
    region,
    windows: sampleResults,
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
