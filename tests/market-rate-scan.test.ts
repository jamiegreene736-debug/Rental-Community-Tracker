import {
  retroactivePriceScanSeeds,
  nextRunDelayMs,
  DAY_MS,
  WEEK_MS,
  SEED_DAYS,
  INITIAL_DELAY_MS,
} from "../server/market-rate-scan-logic";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
};

const NOW = Date.parse("2026-06-27T12:00:00Z");

console.log("market-rate-scan: retroactivePriceScanSeeds");
{
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const seeds = retroactivePriceScanSeeds(ids, NOW);

  check("one seed per property id", seeds.length === ids.length);
  check("preserves property ids in order", seeds.every((s, i) => s.propertyId === ids[i]));
  check("every seed is in the past", seeds.every((s) => s.at < NOW), seeds);

  const newest = Math.max(...seeds.map((s) => s.at));
  const oldest = Math.min(...seeds.map((s) => s.at));
  // Newest is at most "yesterday" (offset starts at 1 day), so it never looks
  // like a push happened today — and it anchors the weekly cadence ~1 week out.
  check("newest seed is <= now - 1 day", newest <= NOW - DAY_MS, new Date(newest).toISOString());
  // Oldest stays within the seed window (seedDays days + the minutes of jitter).
  check(
    "oldest seed is within the seed window",
    oldest >= NOW - SEED_DAYS * DAY_MS - 7 * 37 * 60 * 1000,
    new Date(oldest).toISOString(),
  );

  // Determinism — same inputs, same outputs (no Math.random / Date.now inside).
  const again = retroactivePriceScanSeeds(ids, NOW);
  check("deterministic", JSON.stringify(seeds) === JSON.stringify(again));

  check("empty input → empty output", retroactivePriceScanSeeds([], NOW).length === 0);

  // The first few properties land on distinct days (1,2,3,4,5 days ago) so the
  // column shows a spread, not a single date.
  const dayOffsets = seeds.slice(0, SEED_DAYS).map((s) => Math.round((NOW - s.at) / DAY_MS));
  check("first 5 properties span 5 distinct days", new Set(dayOffsets).size === SEED_DAYS, dayOffsets);
}

console.log("market-rate-scan: nextRunDelayMs");
{
  check("never run → initial delay", nextRunDelayMs(null, NOW) === INITIAL_DELAY_MS);
  check("NaN last-run → initial delay", nextRunDelayMs(Number.NaN, NOW) === INITIAL_DELAY_MS);

  // Just ran → wait ~a full week.
  check("just ran → ~one week", nextRunDelayMs(NOW, NOW) === WEEK_MS);

  // Half a week ago → remaining ~half a week.
  check("half a week ago → remaining half", nextRunDelayMs(NOW - WEEK_MS / 2, NOW) === WEEK_MS / 2);

  // Exactly due → catch up via the short initial delay.
  check("exactly due → initial delay", nextRunDelayMs(NOW - WEEK_MS, NOW) === INITIAL_DELAY_MS);

  // Overdue → also the short initial delay (never negative).
  check("overdue → initial delay", nextRunDelayMs(NOW - 3 * WEEK_MS, NOW) === INITIAL_DELAY_MS);

  // A seed anchored ~1 day ago (the real boot path) → first run ~6 days out, NOT
  // immediately — this is what prevents a deploy-time Guesty push storm.
  const anchor = NOW - DAY_MS;
  const delay = nextRunDelayMs(anchor, NOW);
  check("seed-anchored → first run ~6 days out", delay === WEEK_MS - DAY_MS && delay > DAY_MS, delay);
}

console.log(`\nmarket-rate-scan: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
