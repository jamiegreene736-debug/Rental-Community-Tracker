// Per-listing availability scanner scheduler (Phase 4).
//
// Every few minutes, walk the scanner_schedule table and run the full
// pipeline (inventory → pricing → block sync → rate push) for any rows
// whose `lastRunAt` is older than their configured `intervalHours`.
//
// The pipeline reuses the same in-process helpers and Guesty writers
// as the manual endpoints — no HTTP round-trips. Failures on any one
// property don't abort the tick; each run is wrapped and logged.

import { storage } from "./storage";
import { guestyRequest } from "./guesty-sync";
import { PROPERTY_UNIT_CONFIGS, type PropertyUnitConfig } from "@shared/property-units";
import { totalNightlyBuyInForMonth } from "@shared/pricing-rates";
import { resolveBuyInMarket } from "@shared/buy-in-market";
import {
  countAirbnbCandidates,
  computeSetsFromCounts,
  verdictFor,
  findCheapestPricedNightly,
  sampleMedianBuyInForSeason,
  type SeasonKey,
} from "./availability-search";
import { getPropertyUnits } from "@shared/property-units";
import { applyAirbnbBiasAndCombo } from "@shared/pricing-rates";
import {
  computeAvailabilityThresholds,
  scanSeasonalAvailabilityCapacity,
  type SeasonalAvailabilityWindow,
} from "./seasonal-availability";
import { syncScannerBlocksForProperty } from "./sync-scanner-blocks";

const TICK_MS = 10 * 60 * 1000; // every 10 min
const POLICY_WEEKS = 104;

let _timer: NodeJS.Timeout | null = null;
let _lastTickAt: Date | null = null;
let _tickRunning = false;

export function getScannerSchedulerStatus() {
  return { lastTickAt: _lastTickAt, running: _tickRunning };
}

function positiveDraftInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function inferBedroomsFromGuestyListing(listing: any): number | null {
  const direct = numberFromUnknown(
    listing?.bedrooms ?? listing?.bedroomsCount ?? listing?.bedroomCount ?? listing?.beds,
  );
  if (direct && direct > 0) return direct;
  const text = firstNonEmptyString(listing?.nickname, listing?.title, listing?.name);
  const match = text.match(/(\d{1,2})\s*(?:br|bd|bed(?:room)?s?)/i);
  return match ? positiveDraftInteger(match[1]) : null;
}

function communityKeyForAvailabilityDraft(draft: any): string {
  const pricingArea = typeof draft?.pricingArea === "string" ? draft.pricingArea.trim() : "";
  const resolved = resolveBuyInMarket({
    marketKey: pricingArea,
    name: draft?.name,
    listingTitle: draft?.listingTitle,
    bookingTitle: draft?.bookingTitle,
    streetAddress: draft?.streetAddress,
    unit1Address: draft?.unit1Address,
    unit2Address: draft?.unit2Address,
    city: draft?.city,
    state: draft?.state,
    sourceUrl: draft?.sourceUrl,
  });
  if (resolved) return resolved;
  if (pricingArea) return pricingArea;
  return draft?.name ?? "Poipu Kai";
}

function configFromGuestyListing(listing: any): PropertyUnitConfig | null {
  const title = firstNonEmptyString(listing?.nickname, listing?.title, listing?.name);
  const address = listing?.address ?? {};
  const community = resolveBuyInMarket({
    name: title,
    listingTitle: listing?.title,
    bookingTitle: listing?.nickname,
    streetAddress: firstNonEmptyString(address?.full, address?.formatted, address?.display, address?.street, address?.streetAddress),
    city: address?.city,
    state: address?.state,
  });
  const bedrooms = inferBedroomsFromGuestyListing(listing);
  if (!community || !bedrooms) return null;
  return {
    community,
    units: [{
      unitId: "main",
      unitLabel: title || `${bedrooms}BR Guesty listing`,
      bedrooms,
    }],
  };
}

async function configFromMappedGuestyListing(propertyId: number): Promise<PropertyUnitConfig | null> {
  const listingId = await storage.getGuestyListingId(propertyId).catch(() => null);
  if (!listingId) return null;
  try {
    const fields = encodeURIComponent("title nickname name bedrooms bedroomsCount bedroomCount beds bathrooms accommodates personCapacity address.full address.formatted address.display address.city address.state address.street address.streetAddress");
    const listing = await guestyRequest("GET", `/listings/${listingId}?fields=${fields}`) as any;
    return configFromGuestyListing(listing);
  } catch {
    return null;
  }
}

function inferAvailabilityDraftBedrooms(draft: any, unitKey: "unit1" | "unit2"): number | null {
  const stored = unitKey === "unit1" ? draft?.unit1Bedrooms : draft?.unit2Bedrooms;
  const combined = draft?.singleListing === true ? draft?.combinedBedrooms : null;
  const fromStructured = positiveDraftInteger(stored) ?? positiveDraftInteger(combined);
  if (fromStructured) return fromStructured;

  const text = [
    unitKey === "unit1" ? draft?.unit1Description : draft?.unit2Description,
    unitKey === "unit1" ? draft?.unit1Bedding : draft?.unit2Bedding,
    draft?.listingTitle,
    draft?.bookingTitle,
    draft?.name,
    draft?.unitTypes,
  ].filter(Boolean).join(" ");
  const match = text.match(/(\d{1,2})\s*(?:br|bd|bed(?:room)?s?)/i);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function unitLabelFromDraftAddress(address: unknown, fallback: string): string {
  if (typeof address !== "string" || !address.trim()) return fallback;
  const match = address.match(/(?:#|unit|apt|apartment|suite|ste)\s*([A-Za-z]?\d{1,5}[A-Za-z]?)/i);
  return match?.[1] ? `Unit ${match[1]}` : fallback;
}

function configFromAvailabilityDraft(draft: any): PropertyUnitConfig | null {
  const community = communityKeyForAvailabilityDraft(draft);
  const isSingle = draft?.singleListing === true;
  const combinedBedrooms = positiveDraftInteger(draft?.combinedBedrooms);
  const unit1Bedrooms = inferAvailabilityDraftBedrooms(draft, "unit1") ?? (isSingle ? combinedBedrooms : null);
  let unit2Bedrooms = isSingle ? null : inferAvailabilityDraftBedrooms(draft, "unit2");

  if (!isSingle && !unit2Bedrooms && combinedBedrooms && unit1Bedrooms && combinedBedrooms > unit1Bedrooms) {
    unit2Bedrooms = combinedBedrooms - unit1Bedrooms;
  }

  if (isSingle) {
    const bedrooms = unit1Bedrooms ?? combinedBedrooms;
    return bedrooms
      ? {
          community,
          units: [{
            unitId: "main",
            unitLabel: unitLabelFromDraftAddress(draft?.unit1Address, `${bedrooms}BR Guesty listing`),
            bedrooms,
          }],
        }
      : null;
  }

  let unitBedrooms = [unit1Bedrooms, unit2Bedrooms]
    .filter((bedrooms): bedrooms is number => !!bedrooms && bedrooms > 0);
  if (unitBedrooms.length === 0 && combinedBedrooms) {
    unitBedrooms = combinedBedrooms % 2 === 0
      ? [combinedBedrooms / 2, combinedBedrooms / 2]
      : [Math.ceil(combinedBedrooms / 2), Math.floor(combinedBedrooms / 2)];
  }
  if (unitBedrooms.length === 1 && combinedBedrooms && combinedBedrooms > unitBedrooms[0]) {
    unitBedrooms.push(combinedBedrooms - unitBedrooms[0]);
  }
  if (unitBedrooms.length === 0) return null;

  return {
    community,
    units: unitBedrooms.map((bedrooms, index) => ({
      unitId: index === 0 ? "unit-a" : "unit-b",
      unitLabel: unitLabelFromDraftAddress(
        index === 0 ? draft?.unit1Address : draft?.unit2Address,
        index === 0 ? "Unit A" : "Unit B",
      ),
      bedrooms,
    })),
  };
}

export async function resolveAvailabilityPropertyConfig(propertyId: number): Promise<PropertyUnitConfig | null> {
  if (!Number.isFinite(propertyId)) return null;
  if (propertyId > 0) return PROPERTY_UNIT_CONFIGS[propertyId] ?? null;
  const draft = await storage.getCommunityDraft(Math.abs(propertyId)).catch(() => null);
  const draftConfig = draft ? configFromAvailabilityDraft(draft) : null;
  return draftConfig ?? await configFromMappedGuestyListing(propertyId);
}

export async function getAvailabilitySchedulerUnsupportedReason(propertyId: number): Promise<string | null> {
  if (!Number.isFinite(propertyId)) return "invalid property id";
  const config = await resolveAvailabilityPropertyConfig(propertyId);
  if (!config) {
    return propertyId <= 0
      ? "draft-backed property is missing bedroom/community data for availability scans"
      : "property not in availability config";
  }
  return null;
}

// Pick a *random* 7-night inside the next season occurrence (capped 10mo).
// Delegates to the shared helper that guarantees no 2028+ far-future dates
// (the root cause of "SearchAPI Airbnb returned no usable exact-2BR LOW samples").
// Keeps the old signature so the rest of the file is untouched.
function pickDateForSeason(season: SeasonKey): { checkIn: string; checkOut: string } {
  // Use the shared random picker (capped 10mo, random day inside season month).
  // This is the surgical fix for 2028 far-future "no usable samples" errors.
  const { pickRandom7NightInSeason } = require("@shared/pricing-rates"); // sync require safe in this context
  const region = "hawaii" as const;
  const w = pickRandom7NightInSeason(region, season as any, 10);
  if (w) return w;
  // ultimate fallback (should never hit)
  const now = new Date();
  const d = new Date(now.getFullYear() + 1, season === "LOW" ? 8 : 6, 10);
  const ci = d.toISOString().slice(0, 10);
  const co = new Date(d.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  return { checkIn: ci, checkOut: co };
}

// Which season is this month in? Hawaii-ish default map — good enough
// for the initial run. Falls back to LOW for anything we don't know.
const MONTH_SEASONS: Record<number, SeasonKey> = {
  1: "HIGH", 2: "LOW", 3: "HIGH", 4: "HIGH",
  5: "LOW", 6: "HIGH", 7: "HIGH", 8: "HIGH",
  9: "LOW", 10: "LOW", 11: "LOW", 12: "HIGH",
};
function seasonForMonth(yearMonth: string): SeasonKey {
  const [_, m] = yearMonth.split("-").map(Number);
  // Late-December override — holiday prices.
  const isHoliday = m === 12;
  if (isHoliday) return "HOLIDAY";
  return MONTH_SEASONS[m] ?? "LOW";
}

// Main pipeline — identical to what the UI buttons do, all in one pass.
// Sentinel prefix the scheduler uses to distinguish "this was a no-op
// because the preconditions aren't met" from "this crashed". The tick
// + manual runners treat summaries starting with this as status="skipped"
// instead of "ok"/"error". Keeps run history clean — a freshly-created
// property with scheduler auto-enabled (per Load-Bearing #10) but no
// Guesty mapping yet shouldn't look like a failure.
const SKIP_PREFIX = "skipped:";

function easternDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function easternHour(d: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).format(d);
  return Number.parseInt(hour, 10);
}

/** Daily policy pass runs once per Eastern calendar day after 1 AM. */
export function isDueForPolicyPass(
  lastRunAt: Date | null,
  now: Date,
  intervalHours: number,
): boolean {
  if (intervalHours < 24) {
    return !lastRunAt || (now.getTime() - lastRunAt.getTime()) >= intervalHours * 60 * 60 * 1000;
  }
  if (easternHour(now) < 1) return false;
  if (!lastRunAt) return true;
  return easternDateKey(lastRunAt) < easternDateKey(now);
}

function applyPolicyOverrides(
  windows: SeasonalAvailabilityWindow[],
  overrides: Awaited<ReturnType<typeof storage.getScannerOverrides>>,
): SeasonalAvailabilityWindow[] {
  const overrideByStart = new Map(overrides.map((o) => [o.startDate, o]));
  return windows.map((window) => {
    const ov = overrideByStart.get(window.startDate);
    if (!ov) return window;
    const verdict = ov.mode === "force-block" ? "blocked" : "open";
    return {
      ...window,
      verdict,
      maxSets: ov.mode === "force-open" ? window.openMinSets + 5 : 0,
      reason: ov.mode === "force-open"
        ? `Manual override forced this ${window.season} window open.`
        : `Manual override forced this ${window.season} window blocked.`,
    };
  });
}

function formatPolicySummary(windows: SeasonalAvailabilityWindow[]): string {
  const open = windows.filter((w) => w.verdict === "open").length;
  const tight = windows.filter((w) => w.verdict === "tight").length;
  const blocked = windows.filter((w) => w.verdict === "blocked").length;
  return `policy ${open} open/${tight} tight/${blocked} blocked`;
}

// Same path as Availability tab "Apply policy" — fixed lead-time windows + Guesty sync.
export async function runLeadTimePolicySyncForProperty(
  propertyId: number,
  opts: { minSets?: number; weeks?: number; syncToGuesty?: boolean } = {},
): Promise<string> {
  const weeks = opts.weeks ?? POLICY_WEEKS;
  const syncToGuesty = opts.syncToGuesty ?? true;
  const minSets = opts.minSets ?? 3;

  const unsupportedReason = await getAvailabilitySchedulerUnsupportedReason(propertyId);
  if (unsupportedReason) return `${SKIP_PREFIX} ${unsupportedReason}`;

  const config = await resolveAvailabilityPropertyConfig(propertyId);
  if (!config) return `${SKIP_PREFIX} property not in availability config`;

  const guestyListingId = await storage.getGuestyListingId(propertyId);
  if (!guestyListingId) {
    return `${SKIP_PREFIX} no Guesty listing mapped — connect one to enable scans`;
  }

  let resortName: string | null = null;
  try {
    const listing = await guestyRequest("GET", `/listings/${guestyListingId}?fields=title%20nickname`) as any;
    const title = listing?.title ?? listing?.nickname ?? null;
    if (title) resortName = title.split(/\s+[–-]\s+/)[0].trim();
  } catch { /* non-fatal */ }

  const result = await scanSeasonalAvailabilityCapacity({
    propertyId,
    config,
    resortName,
    manualMinSets: minSets,
    weeks,
  });
  const finalWindows = applyPolicyOverrides(
    result.windows,
    await storage.getScannerOverrides(propertyId),
  );
  const parts = [formatPolicySummary(finalWindows)];

  if (syncToGuesty) {
    const syncWindows = finalWindows.map((w) => ({
      startDate: w.startDate,
      endDate: w.endDate,
      verdict: (w.verdict === "open" ? "available" : w.verdict) as "blocked" | "available" | "tight" | "error",
      maxSets: w.maxSets,
      minSets: w.minSets,
      reason: w.reason,
    }));
    const syncResult = await syncScannerBlocksForProperty(propertyId, syncWindows);
    const failed = syncResult.failures.length;
    parts.push(`blocks +${syncResult.created}/-${syncResult.removed}${failed ? `/×${failed}` : ""}`);
  }

  return parts.join(" · ");
}

async function runScheduledAvailabilityPass(
  propertyId: number,
  opts: { minSets: number; targetMargin: number; runInventory: boolean; runPricing: boolean; runSyncBlocks: boolean },
): Promise<string> {
  const parts: string[] = [];
  const runPolicy = opts.runInventory || opts.runSyncBlocks;

  if (runPolicy) {
    parts.push(await runLeadTimePolicySyncForProperty(propertyId, {
      minSets: opts.minSets,
      weeks: POLICY_WEEKS,
      syncToGuesty: opts.runSyncBlocks,
    }));
  }

  if (opts.runPricing) {
    const legacy = await runFullScanForProperty(propertyId, {
      minSets: opts.minSets,
      targetMargin: opts.targetMargin,
      runInventory: false,
      runPricing: true,
      runSyncBlocks: false,
    });
    if (!legacy.startsWith(SKIP_PREFIX)) {
      for (const segment of legacy.split(" · ")) {
        if (segment.startsWith("market-snapshot") || segment.startsWith("rates ")) {
          parts.push(segment);
        }
      }
    } else if (!runPolicy) {
      return legacy;
    }
  }

  if (parts.length === 0) return `${SKIP_PREFIX} no phases enabled`;
  return parts.join(" · ");
}

// Returns a short human-readable summary that goes in lastRunSummary.
// Summaries beginning with SKIP_PREFIX indicate the run was a clean
// no-op (precondition missing, not a failure).
export async function runFullScanForProperty(
  propertyId: number,
  opts: { minSets: number; targetMargin: number; runInventory: boolean; runPricing: boolean; runSyncBlocks: boolean },
): Promise<string> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) throw new Error("SEARCHAPI_API_KEY not configured");

  const unsupportedReason = await getAvailabilitySchedulerUnsupportedReason(propertyId);
  if (unsupportedReason) return `${SKIP_PREFIX} ${unsupportedReason}`;

  const config = await resolveAvailabilityPropertyConfig(propertyId);
  if (!config) return `${SKIP_PREFIX} property not in availability config`;

  const guestyListingId = await storage.getGuestyListingId(propertyId);
  if (!guestyListingId) {
    // Graceful skip: scheduler auto-enables on Availability-tab load
    // for every property (Load-Bearing #10), but properties that
    // haven't been built on Guesty yet have no listing to scan
    // against. Return a skip summary rather than throwing so the
    // run history shows this as a no-op, not an error.
    return `${SKIP_PREFIX} no Guesty listing mapped — connect one to enable scans`;
  }

  // Resort name from Guesty listing title
  let resortName: string | null = null;
  try {
    const listing = await guestyRequest("GET", `/listings/${guestyListingId}?fields=title%20nickname`) as any;
    const title = listing?.title ?? listing?.nickname ?? null;
    if (title) resortName = title.split(/\s+[–-]\s+/)[0].trim();
  } catch { /* non-fatal */ }

  const community = config.community;
  const uniqueBedrooms = Array.from(new Set(config.units.map((u) => u.bedrooms)));
  const summaries: string[] = [];

  // ── Inventory: candidate count per BR ──
  let countsByBR: Record<number, number> = {};
  let baselineSets = 0;
  let baselineVerdict: "open" | "tight" | "blocked" = "blocked";
  if (opts.runInventory) {
    const out = await Promise.all(uniqueBedrooms.map(async (br) => {
      const r = await countAirbnbCandidates({ resortName, community, bedrooms: br, apiKey });
      return [br, r.count] as [number, number];
    }));
    countsByBR = Object.fromEntries(out);
    baselineSets = computeSetsFromCounts(config.units, countsByBR);
    baselineVerdict = verdictFor(baselineSets, opts.minSets);
    summaries.push(`inventory ${baselineSets} sets (${baselineVerdict})`);
  }

  // ── Pricing telemetry: random 7-night per season per BR (live market) ──
  // Now uses the surgical sampler: exact-BR median from SearchAPI, per-season
  // Airbnb bias markup, combo handling (sum or double per PROPERTY_UNIT_CONFIGS),
  // then the existing push layers the final 20% target margin. This directly
  // implements the requested flow and eliminates far-future 2028 sample failures.
  const priceByBR: Record<SeasonKey, Record<number, number | null>> = {
    LOW: {}, HIGH: {}, HOLIDAY: {},
  };
  if (opts.runPricing) {
    const seasons: SeasonKey[] = ["LOW", "HIGH", "HOLIDAY"];
    const unitsForProp = getPropertyUnits(propertyId);
    const isCombo = unitsForProp.length > 1;
    const sameBr = isCombo && new Set(unitsForProp.map(u => u.bedrooms)).size === 1;
    for (const s of seasons) {
      const res = await Promise.all(uniqueBedrooms.map(async (br) => {
        const sample = await sampleMedianBuyInForSeason({
          community,
          bedrooms: br,
          season: s,
          unitCount: isCombo ? unitsForProp.length : 1,
          sameBrCombo: sameBr,
          apiKey,
          maxSamples: 4,
        });
        // Use the post-markup+combo adjusted as the "live buy-in" snapshot
        return [br, sample.adjustedBuyIn ?? sample.median] as [number, number | null];
      }));
      for (const [br, n] of res) priceByBR[s][br] = n;
    }
    const pricedSeasons = Object.entries(priceByBR)
      .filter(([_, m]) => Object.values(m).some((v) => v != null))
      .map(([s]) => s);
    summaries.push(`market-snapshot ${pricedSeasons.length}/3 seasons (live+markup+combo)`);
  }

  // ── Block sync: push owner-blocks for insufficient windows ──
  if (opts.runSyncBlocks && opts.runInventory) {
    // Build 52 weeks of verdicts. ONLY explicit per-window overrides
    // (force-block) turn into actual Guesty blocks here — the baseline
    // supply count is NOT fanned out across all 52 weeks.
    //
    // Earlier revisions applied `baselineVerdict` to every non-override
    // week, which meant a single point-in-time Airbnb-listing count of
    // "2 sets, need 3" auto-blocked every future week for a year.
    // That's the wrong shape: baseline is a SIGNAL about current supply
    // tightness, not an ACTION that should block bookings 11 months
    // out when supply will almost certainly have shifted by then.
    //
    // The per-week scan flow (manual "Run inventory scan" button +
    // "Push Blackouts to Guesty" in the Availability tab) is the
    // correct place to push real per-week blocks — it actually queries
    // each window individually. See Load-Bearing Decision #19 in
    // AGENTS.md.
    const overrides = await storage.getScannerOverrides(propertyId);
    const overrideByStart = new Map(overrides.map((o) => [o.startDate, o]));
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const weeks = 52;
    const windows: Array<{ startDate: string; endDate: string; verdict: "open" | "tight" | "blocked"; maxSets?: number; minSets: number }> = [];
    for (let w = 1; w <= weeks; w++) {
      const start = new Date(today); start.setDate(start.getDate() + (w - 1) * 7);
      const end = new Date(start); end.setDate(end.getDate() + 7);
      const sd = start.toISOString().slice(0, 10);
      const ed = end.toISOString().slice(0, 10);
      const ov = overrideByStart.get(sd);
      const verdict: "open" | "blocked" =
        ov && ov.mode === "force-block" ? "blocked" : "open";
      windows.push({ startDate: sd, endDate: ed, verdict, maxSets: baselineSets, minSets: opts.minSets });
    }

    const active = await storage.getActiveScannerBlocks(propertyId);
    const activeKeyed = new Map(active.map((b) => [`${b.startDate}:${b.endDate}`, b]));
    const desiredBlocks = new Set(windows.filter((w) => w.verdict === "blocked").map((w) => `${w.startDate}:${w.endDate}`));
    const calPath = `/availability-pricing/api/calendar/listings/${guestyListingId}`;
    let created = 0, removed = 0, failed = 0;
    for (const w of windows.filter((ww) => ww.verdict === "blocked")) {
      const key = `${w.startDate}:${w.endDate}`;
      if (activeKeyed.has(key)) continue;
      try {
        const reason = `low-inventory: ${w.maxSets ?? 0} / ${w.minSets} sets`;
        const resp = await guestyRequest("PUT", calPath, {
          startDate: w.startDate,
          endDate: w.endDate,
          status: "unavailable",
          note: `nexstay-scanner (cron): ${reason}`,
        }) as any;
        const createdBlocksArr = resp?.data?.blocks?.createdBlocks ?? resp?.blocks?.createdBlocks ?? [];
        await storage.createScannerBlock({
          propertyId, guestyListingId,
          startDate: w.startDate, endDate: w.endDate,
          guestyBlockId: createdBlocksArr[0]?._id ?? createdBlocksArr[0]?.id ?? null,
          reason,
        });
        created++;
        await new Promise((r) => setTimeout(r, 150));
      } catch { failed++; }
    }
    for (const b of active) {
      const key = `${b.startDate}:${b.endDate}`;
      if (desiredBlocks.has(key)) continue;
      try {
        await guestyRequest("PUT", calPath, {
          startDate: b.startDate,
          endDate: b.endDate,
          status: "available",
        });
        await storage.markScannerBlockRemoved(b.id);
        removed++;
        await new Promise((r) => setTimeout(r, 150));
      } catch { failed++; }
    }
    summaries.push(`blocks +${created}/-${removed}${failed ? `/×${failed}` : ""}`);
  }

  // ── Rate push: per-month Guesty calendar from STATIC buy-in cost ──
  // Uses the manually-curated BUY_IN_RATES from shared/pricing-rates.ts
  // (cost we PAY per night) × season multiplier, then marks up to hit
  // the target margin after the direct-channel fee. The earlier version
  // used live Airbnb engine prices as the cost basis, which was wrong —
  // those are SELL prices already inflated by other hosts' margins.
  if (opts.runPricing) {
    const feeDirect = 0.03;
    const today = new Date();
    const ranges: Array<{ startDate: string; endDate: string; price: number }> = [];
    for (let m = 0; m < 24; m++) {
      const d = new Date(today.getFullYear(), today.getMonth() + m, 1);
      const y = d.getFullYear();
      const mm = d.getMonth() + 1;
      const yearMonth = `${y}-${String(mm).padStart(2, "0")}`;
      // Cost basis = sum of buy-in cost per slot for this month/season
      const setCost = totalNightlyBuyInForMonth(community, config.units, yearMonth);
      if (setCost <= 0) continue;
      const targetRate = Math.round(((1 + opts.targetMargin) * setCost) / (1 - feeDirect));
      const startDate = new Date(y, mm - 1, 1).toISOString().slice(0, 10);
      const lastDay = new Date(y, mm, 0).getDate();
      const endDate = new Date(y, mm - 1, lastDay).toISOString().slice(0, 10);
      ranges.push({ startDate, endDate, price: targetRate });
    }
    let pushedRanges = 0;
    for (const r of ranges) {
      try {
        await guestyRequest("PUT", `/availability-pricing/api/calendar/listings/${guestyListingId}`, r);
        pushedRanges++;
        await new Promise((resolve) => setTimeout(resolve, 120));
      } catch { /* continue */ }
    }
    summaries.push(`rates ${pushedRanges}/${ranges.length} months`);
  }

  return summaries.join(" · ");
}

async function tick() {
  if (_tickRunning) return;
  _tickRunning = true;
  _lastTickAt = new Date();
  try {
    const rows = await storage.getScannerSchedules();
    const now = Date.now();
    for (const row of rows) {
      if (!row.enabled) continue;
      const due = isDueForPolicyPass(row.lastRunAt, new Date(now), row.intervalHours);
      if (!due) continue;
      const startedAt = Date.now();
      try {
        const summary = await runScheduledAvailabilityPass(row.propertyId, {
          minSets: row.minSets,
          targetMargin: parseFloat(String(row.targetMargin)),
          runInventory: row.runInventory,
          runPricing: row.runPricing,
          runSyncBlocks: row.runSyncBlocks,
        });
        const durationMs = Date.now() - startedAt;
        // "skipped:"-prefixed summaries are clean no-ops (missing
        // precondition, e.g. no Guesty mapping yet). Record as
        // "skipped" so the UI can show a neutral pill instead of
        // green-ok, and the error log stays clean.
        const status: "ok" | "skipped" = summary.startsWith(SKIP_PREFIX) ? "skipped" : "ok";
        await storage.markScannerScheduleRan(row.propertyId, status, summary);
        await storage.recordScannerRun({
          propertyId: row.propertyId,
          status, summary, durationMs, trigger: "scheduled",
        }).catch(() => {});
        console.log(`[availability-scheduler] property ${row.propertyId} ${status} · ${summary}`);
      } catch (e: any) {
        const durationMs = Date.now() - startedAt;
        const msg = e?.message ?? String(e);
        await storage.markScannerScheduleRan(row.propertyId, "error", msg.slice(0, 200)).catch(() => {});
        await storage.recordScannerRun({
          propertyId: row.propertyId,
          status: "error", summary: msg.slice(0, 200), durationMs, trigger: "scheduled",
        }).catch(() => {});
        console.error(`[availability-scheduler] property ${row.propertyId} FAILED: ${msg}`);
      }
    }
  } finally {
    _tickRunning = false;
  }
}

export function startAvailabilityScheduler() {
  // First tick after 2 minutes so server startup has time to settle.
  setTimeout(() => { tick().catch(() => {}); }, 2 * 60 * 1000);
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  console.log(`[availability-scheduler] started (tick every ${TICK_MS / 60000} min)`);
}

// Exposed so the UI's "Run now" button can force a sync without waiting.
export async function runFullScanNow(propertyId: number): Promise<{ summary: string; status: "ok" | "error" | "skipped" }> {
  const startedAt = Date.now();
  try {
    const sched = await storage.getScannerSchedule(propertyId);
    const summary = await runScheduledAvailabilityPass(propertyId, {
      minSets: sched?.minSets ?? 3,
      targetMargin: sched ? parseFloat(String(sched.targetMargin)) : 0.2,
      runInventory: sched?.runInventory ?? true,
      runPricing: sched?.runPricing ?? true,
      runSyncBlocks: sched?.runSyncBlocks ?? true,
    });
    const durationMs = Date.now() - startedAt;
    const status: "ok" | "skipped" = summary.startsWith(SKIP_PREFIX) ? "skipped" : "ok";
    await storage.markScannerScheduleRan(propertyId, status, summary).catch(() => {});
    await storage.recordScannerRun({
      propertyId, status, summary, durationMs, trigger: "manual",
    }).catch(() => {});
    return { summary, status };
  } catch (e: any) {
    const durationMs = Date.now() - startedAt;
    const msg = e?.message ?? String(e);
    await storage.markScannerScheduleRan(propertyId, "error", msg.slice(0, 200)).catch(() => {});
    await storage.recordScannerRun({
      propertyId, status: "error", summary: msg.slice(0, 200), durationMs, trigger: "manual",
    }).catch(() => {});
    return { summary: msg, status: "error" };
  }
}

// ── Back-compat helpers for routes.ts (restored after refactor) ──
// These were removed/renamed in recent main changes but are still
// imported and used by several availability endpoints.
export async function resolveAvailabilityPropertyConfig(propertyId: number): Promise<any | null> {
  if (!Number.isFinite(propertyId)) return null;

  if (propertyId > 0) {
    // Static properties
    return PROPERTY_UNIT_CONFIGS[propertyId] ?? null;
  }

  // Negative IDs → draft-backed properties
  try {
    const draft = await storage.getCommunityDraft(Math.abs(propertyId)).catch(() => null);
    if (draft) {
      const units: any[] = [];
      if (draft.unit1Bedrooms) units.push({ unitId: "unit1", unitLabel: "Unit 1", bedrooms: draft.unit1Bedrooms });
      if (draft.unit2Bedrooms) units.push({ unitId: "unit2", unitLabel: "Unit 2", bedrooms: draft.unit2Bedrooms });
      if (units.length === 0 && draft.combinedBedrooms) {
        units.push({ unitId: "main", unitLabel: "Combined", bedrooms: draft.combinedBedrooms });
      }
      return {
        community: draft.community || draft.name || "unknown",
        units,
      };
    }
  } catch {}

  // Last resort: try to resolve from mapped Guesty listing (the current main logic)
  try {
    return await (async () => {
      const guestyId = await storage.getGuestyListingId(propertyId).catch(() => null);
      if (!guestyId) return null;
      const fields = encodeURIComponent("title nickname name bedrooms bedroomsCount bedroomCount beds");
      const listing = await guestyRequest("GET", `/listings/${guestyId}?fields=${fields}`) as any;
      const br = listing?.bedrooms ?? listing?.bedroomsCount ?? listing?.bedroomCount ?? listing?.beds;
      if (!br) return null;
      return {
        community: "unknown",
        units: [{ unitId: "main", unitLabel: listing?.nickname || listing?.title || "Unit", bedrooms: Math.round(Number(br)) }],
      };
    })();
  } catch {
    return null;
  }
}

export async function getAvailabilitySchedulerUnsupportedReason(propertyId: number): Promise<string | null> {
  if (!Number.isFinite(propertyId)) return "invalid property id";
  const config = await resolveAvailabilityPropertyConfig(propertyId);
  if (!config) {
    return propertyId <= 0
      ? "draft-backed property is missing bedroom/community data for availability scans"
      : "property not in availability config";
  }
  return null;
}
