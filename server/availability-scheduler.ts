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
  getSeasonalAvailabilityQueueStatus,
  scanSeasonalAvailabilityCapacity,
  type SeasonalAvailabilityWindow,
} from "./seasonal-availability";
import { syncScannerBlocksForProperty } from "./sync-scanner-blocks";

const TICK_MS = 10 * 60 * 1000; // every 10 min

let _timer: NodeJS.Timeout | null = null;
let _lastTickAt: Date | null = null;
let _tickRunning = false;

export function getScannerSchedulerStatus() {
  return { lastTickAt: _lastTickAt, running: _tickRunning, seasonalQueue: getSeasonalAvailabilityQueueStatus() };
}

// Main pipeline — identical to what the UI buttons do, all in one pass.
// Sentinel prefix the scheduler uses to distinguish "this was a no-op
// because the preconditions aren't met" from "this crashed". The tick
// + manual runners treat summaries starting with this as status="skipped"
// instead of "ok"/"error". Keeps run history clean — a freshly-created
// property with scheduler auto-enabled (per Load-Bearing #10) but no
// Guesty mapping yet shouldn't look like a failure.
const SKIP_PREFIX = "skipped:";

// Returns a short human-readable summary that goes in lastRunSummary.
// Summaries beginning with SKIP_PREFIX indicate the run was a clean
// no-op (precondition missing, not a failure).
export async function runFullScanForProperty(
  propertyId: number,
  opts: { minSets: number; targetMargin: number; runInventory: boolean; runPricing: boolean; runSyncBlocks: boolean },
): Promise<string> {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) throw new Error("SEARCHAPI_API_KEY not configured");

  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) throw new Error(`Property ${propertyId} not in config`);

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
  const summaries: string[] = [];

  let seasonalWindows: SeasonalAvailabilityWindow[] = [];
  if (opts.runInventory) {
    const scan = await scanSeasonalAvailabilityCapacity({
      propertyId,
      config,
      resortName,
      manualMinSets: opts.minSets,
      weeks: 104,
    });
    seasonalWindows = scan.windows;
    const worst = seasonalWindows.reduce((acc, w) => {
      const rank = { open: 0, tight: 1, blocked: 2 };
      if (!acc) return w;
      if (rank[w.verdict] > rank[acc.verdict]) return w;
      if (rank[w.verdict] === rank[acc.verdict] && w.maxSets < acc.maxSets) return w;
      return acc;
    }, null as SeasonalAvailabilityWindow | null);
    const open = seasonalWindows.filter((w) => w.verdict === "open").length;
    const tight = seasonalWindows.filter((w) => w.verdict === "tight").length;
    const blocked = seasonalWindows.filter((w) => w.verdict === "blocked").length;
    summaries.push(`inventory ${worst?.maxSets ?? 0} sets (${worst?.verdict ?? "blocked"})`);
    summaries.push(`weekly-windows ${open} open/${tight} tight/${blocked} blocked`);
  }

  if (opts.runSyncBlocks && opts.runInventory && seasonalWindows.length > 0) {
    const overrides = await storage.getScannerOverrides(propertyId);
    const overrideByStart = new Map(overrides.map((o) => [o.startDate, o]));
    const windows = seasonalWindows.map((w) => {
      const ov = overrideByStart.get(w.startDate);
      const verdict: "blocked" | "available" | "tight" | "error" = ov
        ? (ov.mode === "force-block" ? "blocked" : "available")
        : (w.verdict === "open" ? "available" : w.verdict);
      return {
        startDate: w.startDate,
        endDate: w.endDate,
        verdict,
        maxSets: ov?.mode === "force-block" ? 0 : w.maxSets,
        minSets: w.minSets,
        reason: ov ? `manual override: ${ov.mode}` : w.reason,
      };
    });
    const result = await syncScannerBlocksForProperty(propertyId, windows);
    summaries.push(`blocks +${result.created}/-${result.removed}${result.failures.length ? `/×${result.failures.length}` : ""}`);
  }

  // ── Rate push: per-month Guesty calendar from STATIC buy-in cost ──
  // Uses the manually-curated BUY_IN_RATES from shared/pricing-rates.ts
  // (cost we PAY per night) × season multiplier, then marks up to hit
  // the target margin after the direct-channel fee. The earlier version
  // used live OTA website prices as the cost basis, which was wrong —
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

// Weekly market-rate refresh. Calls the in-process
// /api/admin/refresh-all-market-rates endpoint, which walks every
// active static property in PROPERTY_UNIT_NEEDS plus every saved
// community draft and re-runs the sidecar-backed LOW / HIGH /
// HOLIDAY website-search lookup. Result is one upserted row per (propertyId,
// bedrooms) in `property_market_rates` — the cost-basis that the
// Pricing tab feeds into the per-channel floor formula
// `(buyIn × 1.20) ÷ (1 − channel_fee)`.
//
// Cadence: once per 7 days. The sidecar serializes all browser work
// through one Chrome instance; weekly is the right balance between
// freshness and queue contention. Operators who need a faster refresh
// can hit `/api/property/:id/refresh-market-rates` directly from the
// Pricing tab.
const MARKET_RATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
let _marketRateRefreshRunning = false;

// PR #300: persistence-by-DB-query. Earlier this used in-memory
// `_lastMarketRateRefreshAt` which reset to 0 on every container
// restart, causing the cron to re-run all 22 properties on every
// deploy. The result was 15-20 minutes of daemon queue contention
// per deploy that starved manual refreshes (operator's "click
// refresh, see nothing happen" complaint 2026-04-29).
//
// Fix: derive "last cron run time" from the most-recent
// refreshedAt across property_market_rates rows. Persists across
// restarts since it reads actual DB state. Manual refreshes also
// update refreshedAt, so a busy operator naturally postpones the
// cron — exactly what we want (no double-stomping the daemon).
async function getMostRecentMarketRateRefreshAt(): Promise<number> {
  try {
    const allRates = await storage.getAllPropertyMarketRates();
    let max = 0;
    for (const r of allRates) {
      const t = new Date(r.refreshedAt).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    }
    return max;
  } catch (e: any) {
    // DB read failures shouldn't block the cron — if we can't
    // determine last-run, fall through and let it run. Conservative:
    // worst case we run an extra cron pass.
    console.error(`[availability-scheduler] getMostRecentMarketRateRefreshAt: ${e?.message ?? e}`);
    return 0;
  }
}

async function maybeRefreshMarketRates() {
  if (_marketRateRefreshRunning) return;
  if (!process.env.SEARCHAPI_API_KEY) return;
  const lastRefreshAt = await getMostRecentMarketRateRefreshAt();
  if (lastRefreshAt > 0 && Date.now() - lastRefreshAt < MARKET_RATE_INTERVAL_MS) {
    const ageDays = Math.round((Date.now() - lastRefreshAt) / (24 * 60 * 60 * 1000) * 10) / 10;
    console.log(`[availability-scheduler] market-rates skip — last refresh ${ageDays}d ago, interval is ${MARKET_RATE_INTERVAL_MS / (24 * 60 * 60 * 1000)}d`);
    return;
  }
  _marketRateRefreshRunning = true;
  try {
    const port = process.env.PORT || "5000";
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/refresh-all-market-rates`, { method: "POST" });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; succeeded?: number; total?: number };
    if (data.ok) {
      console.log(`[availability-scheduler] market-rates refreshed ${data.succeeded}/${data.total}`);
    } else {
      console.warn(`[availability-scheduler] market-rates refresh returned !ok`);
    }
  } catch (e: any) {
    console.error(`[availability-scheduler] market-rates refresh failed: ${e?.message ?? e}`);
  } finally {
    _marketRateRefreshRunning = false;
  }
}

export function startAvailabilityScheduler() {
  // First tick after 2 minutes so server startup has time to settle.
  setTimeout(() => { tick().catch(() => {}); }, 2 * 60 * 1000);
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  // Market-rates run on their own ~weekly cadence — checked every
  // tick but no-ops until the 7-day interval has elapsed. First check
  // is delayed 5 minutes so the initial availability tick finishes
  // first (the two paths share the SearchAPI key).
  setTimeout(() => { maybeRefreshMarketRates().catch(() => {}); }, 5 * 60 * 1000);
  setInterval(() => { maybeRefreshMarketRates().catch(() => {}); }, TICK_MS);
  console.log(`[availability-scheduler] started (tick every ${TICK_MS / 60000} min, market-rates every ${MARKET_RATE_INTERVAL_MS / (24 * 60 * 60 * 1000)} days)`);
}

// Exposed so the UI's "Run now" button can force a sync without waiting.
export async function runFullScanNow(propertyId: number): Promise<{ summary: string; status: "ok" | "error" | "skipped" }> {
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
