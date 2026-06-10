import { annotatePreviousMonthlyRates } from "../shared/market-rate-history";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("market-rate-history: previous-rate annotation");

// First scan ever: no prior → no previous fields.
{
  const next = { "2026-06": { medianNightly: 800 }, "2026-07": { medianNightly: 900 } } as any;
  annotatePreviousMonthlyRates(next, undefined, undefined);
  check("first scan: no previousMedianNightly set",
    next["2026-06"].previousMedianNightly === undefined && next["2026-07"].previousMedianNightly === undefined, next);
}

// Second scan: previous = prior CURRENT median, + previousRefreshedAt.
{
  const prior = { "2026-06": { medianNightly: 760 }, "2026-07": { medianNightly: 920 } } as any;
  const next = { "2026-06": { medianNightly: 800 }, "2026-07": { medianNightly: 900 } } as any;
  annotatePreviousMonthlyRates(next, prior, "2026-06-01T00:00:00.000Z");
  check("second scan: previous = prior median",
    next["2026-06"].previousMedianNightly === 760 && next["2026-07"].previousMedianNightly === 920, next);
  check("second scan: previousRefreshedAt stamped",
    next["2026-06"].previousRefreshedAt === "2026-06-01T00:00:00.000Z", next);
}

// NO chaining: prior carries its own previousMedianNightly; new previous must be
// prior's CURRENT median, never prior's previous.
{
  const prior = { "2026-06": { medianNightly: 760, previousMedianNightly: 700 } } as any;
  const next = { "2026-06": { medianNightly: 800 } } as any;
  annotatePreviousMonthlyRates(next, prior, "2026-06-01");
  check("no chaining: previous = prior.medianNightly (760), not prior.previous (700)",
    next["2026-06"].previousMedianNightly === 760, next);
}

// Month in next but not in prior → left clean (and any stale previous stripped).
{
  const prior = { "2026-06": { medianNightly: 760 } } as any;
  const next = { "2026-06": { medianNightly: 800 }, "2026-08": { medianNightly: 1000, previousMedianNightly: 999 } } as any;
  annotatePreviousMonthlyRates(next, prior, "2026-06-01");
  check("new month: no prior → previous undefined; stale previous stripped",
    next["2026-06"].previousMedianNightly === 760 && next["2026-08"].previousMedianNightly === undefined, next);
}

// Rounding of the prior value.
{
  const prior = { "2026-06": { medianNightly: 612.4 } } as any;
  const next = { "2026-06": { medianNightly: 700 } } as any;
  annotatePreviousMonthlyRates(next, prior, null);
  check("prior median rounded (612.4 -> 612)", next["2026-06"].previousMedianNightly === 612, next);
  check("no priorRefreshedAt → previousRefreshedAt omitted", next["2026-06"].previousRefreshedAt === undefined, next);
}

// Non-positive / missing prior median → not annotated.
{
  const prior = { "2026-06": { medianNightly: 0 }, "2026-07": {} } as any;
  const next = { "2026-06": { medianNightly: 800 }, "2026-07": { medianNightly: 900 } } as any;
  annotatePreviousMonthlyRates(next, prior, "2026-06-01");
  check("prior median 0 / missing → no previous",
    next["2026-06"].previousMedianNightly === undefined && next["2026-07"].previousMedianNightly === undefined, next);
}

// Degrade safe: non-object / array next is returned unchanged.
{
  check("null next returned as-is", annotatePreviousMonthlyRates(null, { a: { medianNightly: 1 } } as any, "x") === null);
  const arr = [] as any;
  check("array next returned unchanged", annotatePreviousMonthlyRates(arr, {} as any, "x") === arr);
}

console.log(`\nmarket-rate-history: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
