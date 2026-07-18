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
//  • UNIT REPLACEMENT is ON by default (operator directive 2026-07-12 — a
//    3BR showing one bedroom photo must be swapped without a click;
//    UNIT_AUDIT_CRON_REPLACE=0 restores flag-only), made safe by three
//    rails in the sweep: a bedroom shortfall must be PROVEN with photo
//    labels complete (a labeling race can never trigger a swap), a 28-day
//    anti-churn cooldown per unit (AUDIT_REPLACE_COOLDOWN_DAYS), and a
//    per-run replacement budget (UNIT_AUDIT_CRON_REPLACE_CAP=3, reset
//    each run) so a systemic false signal can't burn SearchAPI overnight.
// Kill switch: UNIT_AUDIT_AUTO_DISABLED=1.

import { storage } from "./storage";
import { getActiveUnitBuilders } from "../client/src/data/unit-builder-data";
import { DAY_MS, WEEK_MS, nextRunDelayMs } from "./market-rate-scan-logic";
import { resetCronReplaceBudget, startUnitAuditSweepBulk } from "./unit-audit-sweep";

export const UNIT_AUDIT_AUTO_LAST_RUN_KEY = "unit_audit_auto.last_run_at";

let _running = false;
let _lastRunSummary: { startedAt: string; started: number; skipped: number } | null = null;

function autoAuditDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.UNIT_AUDIT_AUTO_DISABLED ?? "").trim());
}

// Every dashboard row that can be audited: the ACTIVE builder properties
// (positive core ids; retired unit-builder-data entries are NOT dashboard
// rows and must never be swept — the 2026-07-18 first weekly tick audited
// six retired ghosts and auto-committed a unit swap for one) + promoted
// drafts that are LIVE (Guesty-mapped negative ids — sweeping every
// half-finished draft weekly would waste budget on listings that aren't
// selling anywhere yet).
export async function unitAuditCronTargets(): Promise<number[]> {
  const coreIds = getActiveUnitBuilders().map((b) => b.propertyId).filter((n) => Number.isFinite(n) && n > 0);
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
    // Replacement is ON by default for cron runs (operator directive
    // 2026-07-12: a 3BR with one bedroom photo "100% needs to be automated");
    // UNIT_AUDIT_CRON_REPLACE=0 restores flag-only. The unattended rails —
    // labels-proven shortfall, the 28-day anti-churn cooldown, and the
    // per-run budget reset below — are what make the default safe.
    const budget = resetCronReplaceBudget();
    console.log(`[unit-audit-auto] ${reason}: starting weekly audit sweeps for ${targets.length} properties (queued one at a time; replacement budget ${budget})`);
    const result = await startUnitAuditSweepBulk({
      propertyIds: targets,
      autoFix: true,
      allowReplace: String(process.env.UNIT_AUDIT_CRON_REPLACE ?? "").trim() !== "0",
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
