// Weekly "cron" that refreshes every configured property's market-rate pricing
// table (SearchAPI Airbnb seasonal bases) AND pushes the result to Guesty, then
// surfaces the per-property "Last Price Scan" timestamp the dashboard column
// reads. Modeled on the other in-process boot schedulers
// (server/property-revenue-scheduler.ts, server/booking-confirmations.ts).
//
// WHY a dedicated scheduler instead of the existing /api/admin/refresh-all-
// market-rates: that account-wide endpoint runs `runHybridPricingForAllProperties`,
// which only RECOMPUTES + persists `property_market_rates`. It does NOT push to
// Guesty and so never stamps `scanner_schedule.lastGuestyRatePushAt`. The path
// that both refreshes the pricing table AND pushes to Guesty (stamping the
// timestamp via `markScannerGuestyRatePush`) is the per-property
// POST /api/property/:id/refresh-market-rates → refreshPricingTabMarketRates →
// pushBulkGuestyPricingAfterRefresh. So this scheduler loopback self-calls THAT
// endpoint per property (the same path the visible "Update Market Rates" button
// and the legacy refresh-all loop use). It runs the refresh synchronously inline
// and returns once Guesty has been pushed.
//
// DEPLOY SAFETY (load-bearing): a market-rate scan WRITES live prices to Guesty,
// so it must NOT fire on every Railway redeploy. The last-run timestamp is
// persisted in app_settings (`market_rate_scan.last_run_at`); on boot the first
// run is scheduled for (lastRun + 7d), not immediately. The retroactive seed
// (below) also anchors last_run_at on the very first boot so a fresh deploy does
// not trigger an immediate portfolio-wide push.

import { storage } from "./storage";
import { loopbackRequestHeaders } from "./auth";
import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import { DAY_MS, WEEK_MS, retroactivePriceScanSeeds, nextRunDelayMs } from "./market-rate-scan-logic";

// Re-export the pure helpers so existing importers (and tests) can reach them
// through either module.
export { retroactivePriceScanSeeds, nextRunDelayMs } from "./market-rate-scan-logic";

// Gentle gap between per-property refreshes so the weekly sweep doesn't hammer
// SearchAPI / Guesty all at once.
const INTER_PROPERTY_DELAY_MS = 1500;
// Per-property refresh hard cap. A single property's SearchAPI + Guesty push is
// minutes, never many; this only protects the sweep from a hung request.
const PER_PROPERTY_TIMEOUT_MS = 8 * 60 * 1000;

export const LAST_RUN_SETTING_KEY = "market_rate_scan.last_run_at";

export type MarketRateScanRunResult = {
  ok: boolean;
  properties: number;
  pushed: number;
  skipped: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
  message: string;
  results: Array<{ propertyId: number; status: "pushed" | "skipped" | "failed"; detail?: string }>;
};

let _enabled = true;
let _running = false;
let _lastRunAt: Date | null = null;
let _lastRunResult: MarketRateScanRunResult | null = null;

// ── Run ───────────────────────────────────────────────────────────────────────

function configuredPropertyIds(): number[] {
  return Object.keys(PROPERTY_UNIT_CONFIGS).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

export async function runMarketRateScan(trigger: string): Promise<MarketRateScanRunResult> {
  const startedAt = new Date();
  // Claim the week BEFORE the heavy loop so a redeploy mid-sweep can't refire
  // within the same week (picks that already pushed persist server-side).
  await storage.setSetting(LAST_RUN_SETTING_KEY, startedAt.toISOString()).catch(() => {});

  // Skip operator-deleted core properties — they're hidden from the dashboard,
  // so re-pricing them weekly would re-seed their scanner_schedule row and burn
  // SearchAPI on a listing that's gone. Fail-soft: [] on error.
  const removedCore = new Set(await storage.getDeletedCorePropertyIds().catch(() => []));
  const ids = configuredPropertyIds().filter((id) => !removedCore.has(id));
  const port = process.env.PORT || "5000";
  const results: MarketRateScanRunResult["results"] = [];

  for (const id of ids) {
    try {
      const resp = await fetch(
        `http://127.0.0.1:${port}/api/property/${id}/refresh-market-rates`,
        {
          method: "POST",
          headers: loopbackRequestHeaders(),
          signal: AbortSignal.timeout(PER_PROPERTY_TIMEOUT_MS),
        },
      );
      const data = (await resp.json().catch(() => ({}))) as any;
      if (resp.status === 202 && data?.alreadyRunning) {
        results.push({ propertyId: id, status: "skipped", detail: "a refresh was already running" });
      } else if (!resp.ok) {
        results.push({ propertyId: id, status: "failed", detail: data?.error ?? `HTTP ${resp.status}` });
      } else if (data?.guestyPush?.skipped) {
        results.push({ propertyId: id, status: "skipped", detail: data.guestyPush.reason ?? "no mapped Guesty listing" });
      } else {
        results.push({ propertyId: id, status: "pushed" });
      }
    } catch (e: any) {
      results.push({ propertyId: id, status: "failed", detail: e?.message ?? String(e) });
    }
    if (INTER_PROPERTY_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, INTER_PROPERTY_DELAY_MS));
    }
  }

  const finishedAt = new Date();
  const pushed = results.filter((r) => r.status === "pushed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const result: MarketRateScanRunResult = {
    ok: failed === 0,
    properties: ids.length,
    pushed,
    skipped,
    failed,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    message: `Market-rate scan (${trigger}): ${pushed} pushed to Guesty, ${skipped} skipped, ${failed} failed across ${ids.length} propert${ids.length === 1 ? "y" : "ies"}`,
    results,
  };
  _lastRunAt = finishedAt;
  _lastRunResult = result;
  // Re-stamp last_run_at at completion (the start-stamp claimed the slot; this
  // keeps the next-week math anchored to when the sweep actually finished).
  await storage.setSetting(LAST_RUN_SETTING_KEY, finishedAt.toISOString()).catch(() => {});
  return result;
}

// One-time retroactive backfill so the column has visible history on day one.
// Only fills properties that have NEVER had a real Guesty push (seedScannerPriceScan
// is non-clobbering), and only anchors last_run_at on the very first boot.
export async function seedRetroactivePriceScans(): Promise<{ seeded: number; anchored: boolean }> {
  const removedCore = new Set(await storage.getDeletedCorePropertyIds().catch(() => []));
  const ids = configuredPropertyIds().filter((id) => !removedCore.has(id));
  const seeds = retroactivePriceScanSeeds(ids, Date.now());
  let seeded = 0;
  for (const s of seeds) {
    const wrote = await storage
      .seedScannerPriceScan(
        s.propertyId,
        new Date(s.at),
        "Initial backfill — no live Guesty push; the weekly auto-scan replaces this with a real push",
      )
      .catch(() => false);
    if (wrote) seeded++;
  }

  // Anchor the weekly cadence to the newest seed ONLY if we've never recorded a
  // run — this stops a fresh deploy from triggering an immediate portfolio-wide
  // Guesty push (the first real auto-run lands ~1 week after the newest seed).
  let anchored = false;
  const existing = await storage.getSetting(LAST_RUN_SETTING_KEY).catch(() => undefined);
  if (!existing && seeds.length > 0) {
    const newest = Math.max(...seeds.map((s) => s.at));
    await storage.setSetting(LAST_RUN_SETTING_KEY, new Date(newest).toISOString()).catch(() => {});
    anchored = true;
  }
  return { seeded, anchored };
}

async function safeRun(trigger: string): Promise<void> {
  if (_running) {
    console.log(`[market-rate-scan] ${trigger} run skipped — a scan is already in progress`);
    return;
  }
  _running = true;
  try {
    const result = await runMarketRateScan(trigger);
    console.log(`[market-rate-scan] ${result.message}`);
  } catch (e: any) {
    _lastRunAt = new Date();
    console.warn(`[market-rate-scan] ${trigger} scan failed:`, e?.message ?? e);
  } finally {
    _running = false;
  }
}

export function startMarketRateScheduler(): void {
  if (process.env.MARKET_RATE_SCAN_DISABLED === "1") {
    _enabled = false;
    console.log("[market-rate-scan] Scheduler disabled via MARKET_RATE_SCAN_DISABLED");
    return;
  }
  void (async () => {
    try {
      const seed = await seedRetroactivePriceScans();
      if (seed.seeded > 0) {
        console.log(`[market-rate-scan] seeded ${seed.seeded} retroactive price-scan timestamp(s)${seed.anchored ? " (cadence anchored)" : ""}`);
      }
      const lastRunRaw = await storage.getSetting(LAST_RUN_SETTING_KEY).catch(() => undefined);
      const lastRunMs = lastRunRaw ? Date.parse(lastRunRaw) : NaN;
      const delay = nextRunDelayMs(Number.isFinite(lastRunMs) ? lastRunMs : null, Date.now());
      setTimeout(() => { void safeRun("scheduled"); }, delay);
      setInterval(() => { void safeRun("interval"); }, WEEK_MS);
      const days = Math.round((delay / DAY_MS) * 10) / 10;
      console.log(`[market-rate-scan] Scheduler started (weekly Guesty market-rate push; first run in ~${days}d)`);
    } catch (e: any) {
      console.warn("[market-rate-scan] failed to start scheduler:", e?.message ?? e);
    }
  })();
}

export function getMarketRateScanStatus() {
  return { enabled: _enabled, running: _running, lastRunAt: _lastRunAt, lastRunResult: _lastRunResult, intervalDays: WEEK_MS / DAY_MS };
}
