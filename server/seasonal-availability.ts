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
  policyBand: AvailabilityPolicyBand;
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
  daysUntilArrival: number;
  requiredLeadDays: number;
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

export type AvailabilityPolicyBand = "standard" | "high" | "majorHoliday" | "ultraPeak";

export const AVAILABILITY_POLICY_STANDARD_LEAD_DAYS = 45;
export const AVAILABILITY_POLICY_HIGH_SEASON_LEAD_DAYS = 75;
export const AVAILABILITY_POLICY_MAJOR_HOLIDAY_LEAD_DAYS = 90;
export const AVAILABILITY_POLICY_ULTRA_PEAK_LEAD_DAYS = 120;
export const AVAILABILITY_SCAN_MONTHS = 24;
export const AVAILABILITY_WINDOWS_PER_MONTH = 2;
export const AVAILABILITY_WINDOW_NIGHTS = 14;
export const AVAILABILITY_RELIABILITY_FACTOR = 1;
export const AVAILABILITY_AUTO_BLOCK_NEAR_TERM_DAYS = AVAILABILITY_POLICY_STANDARD_LEAD_DAYS;
export const AVAILABILITY_AUTO_BLOCK_HOLIDAY_DAYS = AVAILABILITY_POLICY_MAJOR_HOLIDAY_LEAD_DAYS;
export const AVAILABILITY_AUTO_BLOCK_ULTRA_PEAK_DAYS = AVAILABILITY_POLICY_ULTRA_PEAK_LEAD_DAYS;

export function getSeasonalAvailabilityQueueStatus() {
  return {
    active: null,
    queued: 0,
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

export function generateWeeklyAvailabilityPolicyWindows(args: {
  weeks?: number;
  now?: Date;
}): Array<{ checkIn: string; checkOut: string; nights: number }> {
  const weeks = Math.min(Math.max(Math.round(args.weeks ?? 104), 1), 104);
  const windows: Array<{ checkIn: string; checkOut: string; nights: number }> = [];
  const now = args.now ? new Date(args.now) : new Date();
  now.setUTCHours(12, 0, 0, 0);
  for (let i = 0; i < weeks; i++) {
    const checkIn = new Date(now);
    checkIn.setUTCDate(checkIn.getUTCDate() + i * 7);
    const checkOut = new Date(checkIn);
    checkOut.setUTCDate(checkOut.getUTCDate() + 7);
    windows.push({ checkIn: ymd(checkIn), checkOut: ymd(checkOut), nights: 7 });
  }
  return windows;
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
  // Default rule: only block when the scan cannot prove even one complete
  // replacement set. The operator-facing `manualMinSets` is the "fully open"
  // target, not the hard blackout floor: a 3-set target blocks at 0 sets,
  // stays tight at 1-2 sets, and opens at 3+. This avoids blanketing the
  // Guesty calendar when provider coverage is thin.
  const openMinSets = Math.max(1, manualMinSets);
  const blockMinSets = 1;
  for (const [brRaw, required] of Object.entries(requiredByBR)) {
    const br = Number(brRaw);
    const openCandidates = required * openMinSets;
    const blockCandidates = required * blockMinSets;
    openCandidatesByBR[br] = openCandidates;
    blockCandidatesByBR[br] = blockCandidates;
  }

  return { requiredByBR, openCandidatesByBR, blockCandidatesByBR, openMinSets, blockMinSets };
}

export function effectiveAvailabilityCount(counts: Omit<AvailabilityChannelCounts, "effective">): number {
  if (counts.total <= 0) return 0;
  return Math.max(1, Math.floor(counts.total * AVAILABILITY_RELIABILITY_FACTOR));
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
  context?: {
    season: SeasonKey;
    checkIn: string;
    now?: Date;
  },
): SeasonalAvailabilityWindow["verdict"] {
  void maxSets;
  void thresholds;
  void scan;
  if (!context) return "open";
  return availabilityAutoBlockAllowed(context) ? "blocked" : "open";
}

export function availabilityAutoBlockAllowed(context: {
  season: SeasonKey;
  checkIn: string;
  now?: Date;
}): boolean {
  const policy = availabilityPolicyForWindow({
    region: "hawaii",
    checkIn: context.checkIn,
    checkOut: context.checkIn,
    nights: 1,
    now: context.now,
    season: context.season,
  });
  return policy.shouldBlock;
}

function daysUntilArrival(checkIn: string, now?: Date): number {
  const anchor = now ? new Date(now) : new Date();
  anchor.setUTCHours(12, 0, 0, 0);
  const arrival = new Date(`${checkIn}T12:00:00Z`);
  return Math.floor((arrival.getTime() - anchor.getTime()) / 86_400_000);
}

function ultraPeakDate(d: Date): boolean {
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return (month === 12 && day >= 20) || (month === 1 && day <= 5);
}

function majorHolidayDate(d: Date): boolean {
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return (month === 7 && day >= 1 && day <= 7)
    || (month === 11 && day >= 22 && day <= 30)
    || (month === 3 && day >= 15)
    || (month === 4 && day <= 5)
    || (month === 2 && day >= 14 && day <= 17);
}

export function seasonForWindow(region: RegionKey, start: Date, nights: number): SeasonKey {
  for (let i = 0; i < nights; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (ultraPeakDate(d) || majorHolidayDate(d)) return "HOLIDAY";
  }
  const yearMonth = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return seasonForMonth(region, yearMonth);
}

export function availabilityPolicyBandForWindow(args: {
  region: RegionKey;
  checkIn: string;
  nights: number;
  season?: SeasonKey;
}): AvailabilityPolicyBand {
  const start = new Date(`${args.checkIn}T12:00:00Z`);
  for (let i = 0; i < args.nights; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (ultraPeakDate(d)) return "ultraPeak";
  }
  for (let i = 0; i < args.nights; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (majorHolidayDate(d)) return "majorHoliday";
  }
  const season = args.season ?? seasonForWindow(args.region, start, args.nights);
  return season === "HIGH" ? "high" : "standard";
}

export function availabilityLeadDaysForPolicyBand(band: AvailabilityPolicyBand): number {
  switch (band) {
    case "ultraPeak": return AVAILABILITY_POLICY_ULTRA_PEAK_LEAD_DAYS;
    case "majorHoliday": return AVAILABILITY_POLICY_MAJOR_HOLIDAY_LEAD_DAYS;
    case "high": return AVAILABILITY_POLICY_HIGH_SEASON_LEAD_DAYS;
    case "standard": return AVAILABILITY_POLICY_STANDARD_LEAD_DAYS;
  }
}

export function availabilityPolicyForWindow(args: {
  region: RegionKey;
  checkIn: string;
  checkOut: string;
  nights: number;
  now?: Date;
  season?: SeasonKey;
}): { band: AvailabilityPolicyBand; leadDays: number; daysUntilArrival: number; shouldBlock: boolean } {
  const band = availabilityPolicyBandForWindow(args);
  const leadDays = availabilityLeadDaysForPolicyBand(band);
  const days = daysUntilArrival(args.checkIn, args.now);
  return {
    band,
    leadDays,
    daysUntilArrival: days,
    shouldBlock: days <= leadDays,
  };
}

function policyBandLabel(band: AvailabilityPolicyBand): string {
  switch (band) {
    case "ultraPeak": return "ultra-peak";
    case "majorHoliday": return "major holiday";
    case "high": return "high season";
    case "standard": return "standard season";
  }
}

function buildWindowFromPolicy(args: {
  region: RegionKey;
  season: SeasonKey;
  window: { checkIn: string; checkOut: string; nights: number };
  thresholds: AvailabilityThresholds;
  now?: Date;
}): SeasonalAvailabilityWindow {
  const policy = availabilityPolicyForWindow({
    region: args.region,
    checkIn: args.window.checkIn,
    checkOut: args.window.checkOut,
    nights: args.window.nights,
    now: args.now,
    season: args.season,
  });
  const verdict: SeasonalAvailabilityWindow["verdict"] = policy.shouldBlock ? "blocked" : "open";
  const listingCounts: Record<number, number> = {};
  const channelCounts: SeasonalAvailabilityWindow["channelCounts"] = {};
  for (const br of Object.keys(args.thresholds.requiredByBR).map(Number)) {
    const effective = policy.shouldBlock ? 0 : args.thresholds.openCandidatesByBR[br] ?? args.thresholds.openMinSets;
    listingCounts[br] = effective;
    channelCounts[br] = { airbnb: 0, vrbo: 0, booking: 0, pm: 0, total: effective, effective };
  }
  const maxSets = policy.shouldBlock ? 0 : args.thresholds.openMinSets;
  const label = policyBandLabel(policy.band);
  return {
    season: args.season,
    policyBand: policy.band,
    startDate: args.window.checkIn,
    endDate: args.window.checkOut,
    nights: args.window.nights,
    verdict,
    maxSets,
    minSets: args.thresholds.blockMinSets,
    openMinSets: args.thresholds.openMinSets,
    blockMinSets: args.thresholds.blockMinSets,
    listingCounts,
    channelCounts,
    daemonOnline: true,
    daysUntilArrival: policy.daysUntilArrival,
    requiredLeadDays: policy.leadDays,
    reason: policy.shouldBlock
      ? `Blocked by fixed booking-window policy: ${label} arrivals require more than ${policy.leadDays} days lead time; this arrival is ${policy.daysUntilArrival} day(s) away.`
      : `Allowed by fixed booking-window policy: ${label} arrivals require ${policy.leadDays} days lead time; this arrival is ${policy.daysUntilArrival} day(s) away.`,
  };
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
  return runSeasonalAvailabilityCapacity(args);
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
  const weeks = Math.min(Math.max(args.weeks ?? 104, 1), 104);
  args.onPhase?.("Applying fixed availability lead-time policy");
  const windows = generateWeeklyAvailabilityPolicyWindows({ weeks, now: args.now }).map((window) => ({
    season: seasonForWindow(region, new Date(`${window.checkIn}T12:00:00Z`), window.nights),
    window,
  }));

  const sampleResults: SeasonalAvailabilityWindow[] = [];
  for (let idx = 0; idx < windows.length; idx++) {
    const { season, window } = windows[idx];
    throwIfAborted(args.signal);
    const result = buildWindowFromPolicy({ region, season, window, thresholds, now: args.now });
    sampleResults.push(result);
    args.onWindow?.(result);
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
