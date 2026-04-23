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
import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import {
  totalNightlyBuyInForMonth,
  computeChannelMarkups,
  CHANNEL_TO_GUESTY_KEY,
  type ChannelKey,
} from "@shared/pricing-rates";
import {
  countAirbnbCandidates,
  computeSetsFromCounts,
  verdictFor,
  findCheapestPricedNightly,
  type SeasonKey,
} from "./availability-search";

const TICK_MS = 10 * 60 * 1000; // every 10 min

let _timer: NodeJS.Timeout | null = null;
let _lastTickAt: Date | null = null;
let _tickRunning = false;

export function getScannerSchedulerStatus() {
  return { lastTickAt: _lastTickAt, running: _tickRunning };
}

// Pick a representative mid-season check-in. LOW = Sep, HIGH = Jul,
// HOLIDAY = late Dec. Roll forward 1 year if the target is already in
// the past or too close to now (listings hide short-notice).
function pickDateForSeason(season: SeasonKey): { checkIn: string; checkOut: string } {
  const now = new Date();
  const y = now.getFullYear();
  const minAhead = 30 * 86_400_000;
  const makeWindow = (year: number, month: number, day: number) => {
    const d = new Date(year, month, day, 12, 0, 0);
    if (d.getTime() < now.getTime() + minAhead) return makeWindow(year + 1, month, day);
    const ci = d.toISOString().slice(0, 10);
    const co = new Date(d.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    return { checkIn: ci, checkOut: co };
  };
  switch (season) {
    case "LOW":     return makeWindow(y, 8, 15);   // mid-September
    case "HIGH":    return makeWindow(y, 6, 10);   // mid-July
    case "HOLIDAY": return makeWindow(y, 11, 26);  // late-December
  }
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
// Returns a short human-readable summary that goes in lastRunSummary.
export async function runFullScanForProperty(
  propertyId: number,
  opts: { minSets: number; targetMargin: number; runInventory: boolean; runPricing: boolean; runSyncBlocks: boolean },
): Promise<string> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) throw new Error("SEARCHAPI_API_KEY not configured");

  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) throw new Error(`Property ${propertyId} not in config`);

  const guestyListingId = await storage.getGuestyListingId(propertyId);
  if (!guestyListingId) throw new Error(`No Guesty listing mapped for property ${propertyId}`);

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

  // ── Pricing telemetry: 1 sample per season per BR ──
  // We snapshot the live Airbnb retail rate per season for visibility
  // (lets the operator see if the market is moving), but we do NOT use
  // these as the cost basis — those are other hosts' SELL prices, not
  // our buy-in cost. Pushing rates off them caused 197% margins.
  const priceByBR: Record<SeasonKey, Record<number, number | null>> = {
    LOW: {}, HIGH: {}, HOLIDAY: {},
  };
  if (opts.runPricing) {
    const seasons: SeasonKey[] = ["LOW", "HIGH", "HOLIDAY"];
    for (const s of seasons) {
      const { checkIn, checkOut } = pickDateForSeason(s);
      const res = await Promise.all(uniqueBedrooms.map(async (br) => {
        const nightly = await findCheapestPricedNightly({
          resortName, community, bedrooms: br, checkIn, checkOut,
          q: `${resortName ?? community}, Hawaii`, apiKey,
        });
        return [br, nightly] as [number, number | null];
      }));
      for (const [br, n] of res) priceByBR[s][br] = n;
    }
    const pricedSeasons = Object.entries(priceByBR)
      .filter(([_, m]) => Object.values(m).some((v) => v != null))
      .map(([s]) => s);
    summaries.push(`market-snapshot ${pricedSeasons.length}/3 seasons`);
  }

  // ── Block sync: push owner-blocks for insufficient windows ──
  if (opts.runSyncBlocks && opts.runInventory) {
    // Build 52 weeks of verdicts. With the baseline-count model the
    // verdict is the same for every non-overridden week — we still write
    // overrides per-week though.
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
      const verdict = ov
        ? (ov.mode === "force-block" ? "blocked" : "open" as const)
        : baselineVerdict;
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

    // ── Channel markup push ──
    // The base rate above nets targetMargin% on Direct only. Each OTA
    // has a higher host fee, so we layer per-channel markups on top so
    // Airbnb/VRBO/Booking also net targetMargin% after their fees.
    // Formula (from shared/pricing-rates.ts): m_ch = (1 - feeDirect)/(1 - fee_ch) - 1.
    try {
      const markups = computeChannelMarkups();
      const markupsByPlatform: Record<string, { percent: number; active: boolean }> = {};
      for (const ch of ["airbnb", "vrbo", "booking", "direct"] as ChannelKey[]) {
        markupsByPlatform[CHANNEL_TO_GUESTY_KEY[ch]] = {
          percent: markups[ch] * 100,
          active: true,
        };
      }
      await guestyRequest("PUT", `/listings/${guestyListingId}`, {
        useAccountMarkups: false,
        markups: markupsByPlatform,
      });
      const labels = (["airbnb", "vrbo", "booking"] as ChannelKey[])
        .map((ch) => `${ch[0]}${(markups[ch] * 100).toFixed(1)}%`)
        .join("/");
      summaries.push(`markups ${labels}`);
    } catch (e: any) {
      summaries.push(`markups FAILED: ${(e?.message ?? "unknown").slice(0, 40)}`);
    }
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
      const due = !row.lastRunAt || (now - row.lastRunAt.getTime()) >= row.intervalHours * 60 * 60 * 1000;
      if (!due) continue;
      const startedAt = Date.now();
      try {
        const summary = await runFullScanForProperty(row.propertyId, {
          minSets: row.minSets,
          targetMargin: parseFloat(String(row.targetMargin)),
          runInventory: row.runInventory,
          runPricing: row.runPricing,
          runSyncBlocks: row.runSyncBlocks,
        });
        const durationMs = Date.now() - startedAt;
        await storage.markScannerScheduleRan(row.propertyId, "ok", summary);
        await storage.recordScannerRun({
          propertyId: row.propertyId,
          status: "ok", summary, durationMs, trigger: "scheduled",
        }).catch(() => {});
        console.log(`[availability-scheduler] property ${row.propertyId} ok · ${summary}`);
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
export async function runFullScanNow(propertyId: number): Promise<{ summary: string; status: "ok" | "error" }> {
  const startedAt = Date.now();
  try {
    const sched = await storage.getScannerSchedule(propertyId);
    const summary = await runFullScanForProperty(propertyId, {
      minSets: sched?.minSets ?? 3,
      targetMargin: sched ? parseFloat(String(sched.targetMargin)) : 0.2,
      runInventory: sched?.runInventory ?? true,
      runPricing: sched?.runPricing ?? true,
      runSyncBlocks: sched?.runSyncBlocks ?? true,
    });
    const durationMs = Date.now() - startedAt;
    await storage.markScannerScheduleRan(propertyId, "ok", summary).catch(() => {});
    await storage.recordScannerRun({
      propertyId, status: "ok", summary, durationMs, trigger: "manual",
    }).catch(() => {});
    return { summary, status: "ok" };
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
