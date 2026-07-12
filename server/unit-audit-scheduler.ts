// Weekly auto-audit "cron" — the piece that makes the dashboard columns keep
// THEMSELVES green (operator ask 2026-07-12: "how can we get it to auto
// correct itself so that the Comm QA column will turn green?"). Every mapped
// property gets a full Unit Audit Sweep with auto-fix ON once a week; the
// sweep's community re-checks persist through the SAME engine that feeds the
// Comm QA column, its pricing stage refreshes stale rates, its amenity stage
// re-pushes gaps — so the Audit, Comm QA, Photos, and Last Price Scan columns
// converge to green without a click.
//
// Modeled on server/market-rate-scheduler.ts:
//  • DEPLOY SAFETY (load-bearing): sweeps WRITE to Guesty (descriptions,
//    amenities, collage, rates) and hide photos, so the cron must NOT fire on
//    every Railway redeploy. last_run_at persists in app_settings
//    (`unit_audit_auto.last_run_at`), stamped at sweep START; the very first
//    boot seeds it to ~now−1d so a fresh deploy's first auto-sweep lands ~6
//    days later, never at boot.
//  • The bulk starter funnels every sweep through the global one-at-a-time
//    slot, so a portfolio run spreads over hours instead of stampeding the
//    shared Lens/SearchAPI/vision budgets.
//
// CRON-run posture (deliberate, different from a manual sweep):
//  • source:"cron" → the OTA stage reuses the weekly photo-cron's deep-scan
//    rows (AUDIT_CRON_OTA_FRESH_HOURS, default 192h) instead of re-spending
//    the same Lens budget the photo cron just spent.
//  • UNIT REPLACEMENT stays OFF unless UNIT_AUDIT_CRON_REPLACE=1 — an
//    unattended job silently swapping a unit's photos is a bigger call than
//    hiding a duplicate; the receipt tells the operator exactly which unit
//    needs the (one-click) replacement instead.
// Kill switch: UNIT_AUDIT_AUTO_DISABLED=1.

import { storage } from "./storage";
import { getAllUnitBuilders } from "../client/src/data/unit-builder-data";
import { DAY_MS, WEEK_MS, nextRunDelayMs } from "./market-rate-scan-logic";
import { startUnitAuditSweepBulk } from "./unit-audit-sweep";

export const UNIT_AUDIT_AUTO_LAST_RUN_KEY = "unit_audit_auto.last_run_at";

let _running = false;
let _lastRunSummary: { startedAt: string; started: number; skipped: number } | null = null;

function autoAuditDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.UNIT_AUDIT_AUTO_DISABLED ?? "").trim());
}

// Every dashboard row that can be audited: the configured builder properties
// (positive core ids) + promoted drafts that are LIVE (Guesty-mapped negative
// ids — sweeping every half-finished draft weekly would waste budget on
// listings that aren't selling anywhere yet).
export async function unitAuditCronTargets(): Promise<number[]> {
  const coreIds = getAllUnitBuilders().map((b) => b.propertyId).filter((n) => Number.isFinite(n) && n > 0);
  const mappedDraftIds = (await storage.getGuestyPropertyMap().catch(() => []))
    .map((m) => m.propertyId)
    .filter((n) => Number.isFinite(n) && n < 0);
  return Array.from(new Set([...coreIds, ...mappedDraftIds]));
}

export async function runUnitAuditCronSweep(reason: string): Promise<{ started: number; skipped: number; targets: number }> {
  if (_running) return { started: 0, skipped: 0, targets: 0 };
  _running = true;
  try {
    // Stamp at START (not completion) so a crash mid-portfolio doesn't refire
    // the whole sweep on the next boot.
    await storage.setSetting(UNIT_AUDIT_AUTO_LAST_RUN_KEY, new Date().toISOString());
    const targets = await unitAuditCronTargets();
    console.log(`[unit-audit-auto] ${reason}: starting weekly audit sweeps for ${targets.length} properties (queued one at a time)`);
    const result = await startUnitAuditSweepBulk({
      propertyIds: targets,
      autoFix: true,
      allowReplace: /^(1|true|yes|on)$/i.test(String(process.env.UNIT_AUDIT_CRON_REPLACE ?? "").trim()),
      source: "cron",
    });
    _lastRunSummary = { startedAt: new Date().toISOString(), started: result.started.length, skipped: result.skipped.length };
    if (result.skipped.length > 0) {
      console.warn(`[unit-audit-auto] ${result.skipped.length} sweep(s) did not start: ${result.skipped.map((s) => `${s.propertyId} (${s.error})`).join("; ")}`);
    }
    return { started: result.started.length, skipped: result.skipped.length, targets: targets.length };
  } finally {
    _running = false;
  }
}

export function getUnitAuditCronStatus(): { running: boolean; lastRun: typeof _lastRunSummary } {
  return { running: _running, lastRun: _lastRunSummary };
}

async function scheduleNextRun(): Promise<void> {
  let lastRunAt: Date | null = null;
  try {
    const raw = await storage.getSetting(UNIT_AUDIT_AUTO_LAST_RUN_KEY);
    if (raw) {
      const t = new Date(raw);
      if (!Number.isNaN(t.getTime())) lastRunAt = t;
    }
  } catch {
    // fail-soft — treat as never run
  }
  if (!lastRunAt) {
    // First boot ever: anchor so the first auto-sweep lands ~6 days out, not
    // at deploy time (same posture as the market-rate cron).
    lastRunAt = new Date(Date.now() - DAY_MS);
    await storage.setSetting(UNIT_AUDIT_AUTO_LAST_RUN_KEY, lastRunAt.toISOString()).catch(() => undefined);
    console.log("[unit-audit-auto] first boot — anchoring last_run_at; first weekly auto-audit in ~6 days");
  }
  const delay = nextRunDelayMs(lastRunAt.getTime(), Date.now(), WEEK_MS);
  console.log(`[unit-audit-auto] next weekly auto-audit in ~${Math.round(delay / 3600_000)}h`);
  setTimeout(() => {
    void runUnitAuditCronSweep("weekly tick")
      .catch((e) => console.warn(`[unit-audit-auto] weekly run failed: ${e?.message ?? e}`))
      .finally(() => void scheduleNextRun());
  }, delay).unref?.();
}

export function startUnitAuditAutoScheduler(): void {
  if (autoAuditDisabled()) {
    console.log("[unit-audit-auto] disabled via UNIT_AUDIT_AUTO_DISABLED");
    return;
  }
  // Slightly after the resume watchdog so re-attached sweeps claim the queue
  // slot first — a resumed half-finished sweep beats starting a new portfolio.
  setTimeout(() => void scheduleNextRun(), 45_000).unref?.();
}
