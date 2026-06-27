// Pure, zero-dependency helpers for the weekly market-rate scheduler. Kept in a
// leaf module (no DB / storage / config imports) so they can be unit-tested in
// isolation (tests/market-rate-scan.test.ts) without booting the database.
// `server/market-rate-scheduler.ts` imports + re-exports these.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
// Number of trailing days the one-time retroactive seed spreads across.
export const SEED_DAYS = 5;
// Used only for the never-run / overdue edge (e.g. app_settings was wiped). In
// the normal flow the seed anchors last_run_at so the first auto-run is ~1 week
// out, never at boot.
export const INITIAL_DELAY_MS = 5 * 60 * 1000;

// Retroactive backfill timestamps for the "Last Price Scan" column: spread the
// configured properties across the trailing `seedDays` days so the column shows
// plausible recent history immediately after deploy instead of a wall of "—".
// Newest ≈ now − 1 day; oldest ≈ now − seedDays days. Deterministic (no
// Math.random / Date.now inside) so the backfill is reproducible and unit-testable.
export function retroactivePriceScanSeeds(
  propertyIds: number[],
  nowMs: number,
  seedDays: number = SEED_DAYS,
): Array<{ propertyId: number; at: number }> {
  const span = Math.max(1, seedDays);
  return propertyIds.map((propertyId, i) => {
    const dayOffset = 1 + (i % span);              // 1..seedDays days ago, cycling
    const jitterMs = (i % 7) * 37 * 60 * 1000;     // staggered minutes, deterministic
    return { propertyId, at: nowMs - dayOffset * DAY_MS - jitterMs };
  });
}

// How long to wait before the first run after boot. Never run → a short initial
// delay; overdue (>= interval since last run) → also the short delay so a missed
// week catches up promptly; otherwise the remaining time to the next weekly slot.
export function nextRunDelayMs(
  lastRunAtMs: number | null,
  nowMs: number,
  intervalMs: number = WEEK_MS,
  initialDelayMs: number = INITIAL_DELAY_MS,
): number {
  if (lastRunAtMs == null || !Number.isFinite(lastRunAtMs)) return initialDelayMs;
  const remaining = intervalMs - (nowMs - lastRunAtMs);
  return remaining <= 0 ? initialDelayMs : remaining;
}
