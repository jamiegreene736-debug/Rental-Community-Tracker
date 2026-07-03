import {
  selectBulkPricingJobToSurface,
  BULK_PRICING_RESURFACE_WINDOW_MS,
} from "../shared/bulk-pricing-queue-surface";

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

const NOW = Date.parse("2026-07-03T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

console.log("bulk-pricing-queue-surface: selectBulkPricingJobToSurface");
{
  const job = selectBulkPricingJobToSurface(
    [
      { id: "old", status: "completed", finishedAt: iso(60_000) },
      { id: "live", status: "running", finishedAt: null },
    ],
    [],
    NOW,
  );
  check("running job wins over a recent terminal job", job?.id === "live", job);
}
{
  const job = selectBulkPricingJobToSurface(
    [{ id: "live", status: "queued", finishedAt: null }],
    ["live"],
    NOW,
  );
  check("live job surfaces even when its id was dismissed (cancel never landed)", job?.id === "live", job);
}
{
  const job = selectBulkPricingJobToSurface(
    [
      { id: "older", status: "completed", finishedAt: iso(3 * 60 * 60 * 1000) },
      { id: "newest", status: "completed", finishedAt: iso(30 * 60 * 1000) },
    ],
    [],
    NOW,
  );
  check("most recently finished terminal job is surfaced", job?.id === "newest", job);
}
{
  const job = selectBulkPricingJobToSurface(
    [
      { id: "newest", status: "completed", finishedAt: iso(30 * 60 * 1000) },
      { id: "older", status: "failed", finishedAt: iso(60 * 60 * 1000) },
    ],
    ["newest"],
    NOW,
  );
  check("dismissed terminal job stays gone; next one surfaces", job?.id === "older", job);
}
{
  const job = selectBulkPricingJobToSurface(
    [{ id: "ancient", status: "completed", finishedAt: iso(BULK_PRICING_RESURFACE_WINDOW_MS + 60_000) }],
    [],
    NOW,
  );
  check("a terminal job older than the resurface window is not surfaced", job === null, job);
}
{
  const job = selectBulkPricingJobToSurface(
    [{ id: "cancelled", status: "cancelled", finishedAt: iso(10 * 60 * 1000) }],
    [],
    NOW,
  );
  check("a recently cancelled queue is surfaced (operator should see it stopped)", job?.id === "cancelled", job);
}
{
  const job = selectBulkPricingJobToSurface(
    [{ id: "nofinish", status: "completed", finishedAt: null }],
    [],
    NOW,
  );
  check("terminal job without finishedAt is not surfaced", job === null, job);
}
{
  check("empty list → null", selectBulkPricingJobToSurface([], [], NOW) === null);
}

console.log(`\nbulk-pricing-queue-surface tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
