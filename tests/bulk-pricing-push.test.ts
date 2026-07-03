import {
  guestyPushStatusForItem,
  summarizeBulkPricingGuestyPush,
  type BulkPricingPushItemLike,
} from "../shared/bulk-pricing-push-logic";

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

const item = (overrides: Partial<BulkPricingPushItemLike>): BulkPricingPushItemLike => ({
  propertyId: 1,
  label: "Property 1",
  status: "completed",
  progress: null,
  error: null,
  ...overrides,
});

const pushedItem = (propertyId: number, extras: Record<string, unknown> = {}): BulkPricingPushItemLike =>
  item({
    propertyId,
    label: `Property ${propertyId}`,
    progress: {
      guestyPush: {
        skipped: false,
        listingId: "abc",
        targetMargin: 0.2,
        seasonal: { pushedDays: 731, pushedRanges: 13, totalRanges: 13, verifiedDays: 731 },
        leadTime: { pushed: 14, total: 14 },
        ...extras,
      },
    },
  });

console.log("bulk-pricing-push: guestyPushStatusForItem");
{
  const s = guestyPushStatusForItem(pushedItem(4));
  check("fully pushed item → pushed", s.outcome === "pushed", s);
  check("pushed detail includes days pushed", s.detail.includes("731 days pushed"), s.detail);
  check("pushed detail includes read-back verification", s.detail.includes("731 verified by Guesty read-back"), s.detail);
  check("pushed detail includes lead-time windows", s.detail.includes("lead-time 14/14"), s.detail);
}
{
  const s = guestyPushStatusForItem(
    item({
      progress: {
        guestyPush: {
          skipped: false,
          seasonal: { pushedDays: 365, pushedRanges: 8, totalRanges: 8 },
          leadTime: { pushed: 6, total: 6 },
        },
      },
    }),
  );
  check("verify rate-limited push still counts as pushed", s.outcome === "pushed", s);
  check("deferred read-back is called out", s.detail.includes("read-back deferred"), s.detail);
}
{
  const s = guestyPushStatusForItem(
    item({ progress: { guestyPush: { skipped: true, reason: "No mapped Guesty listing or pricing configuration found for this property." } } }),
  );
  check("skipped push → skipped", s.outcome === "skipped", s);
  check("skipped detail carries the reason", s.detail.includes("No mapped Guesty listing"), s.detail);
  check("skipped detail says NOT pushed", s.detail.includes("NOT pushed to Guesty"), s.detail);
}
{
  const s = guestyPushStatusForItem(item({ status: "failed", error: "Guesty seasonal-rate push failed with HTTP 429." }));
  check("failed item → failed", s.outcome === "failed", s);
  check("failed detail carries the error", s.detail.includes("HTTP 429"), s.detail);
}
{
  // A failed item whose LAST attempt died before the push must not reuse a
  // stale success payload from a prior attempt's progress.
  const s = guestyPushStatusForItem({ ...pushedItem(9), status: "failed", error: "Market pricing refresh failed" });
  check("failed status wins over stale pushed progress", s.outcome === "failed", s);
}
{
  const s = guestyPushStatusForItem(item({ status: "cancelled" }));
  check("cancelled item → cancelled", s.outcome === "cancelled", s);
}
{
  check("queued item → pending", guestyPushStatusForItem(item({ status: "queued" })).outcome === "pending");
  check("running item → pending", guestyPushStatusForItem(item({ status: "running" })).outcome === "pending");
}
{
  const s = guestyPushStatusForItem(item({ progress: { phase: "done", percent: 100 } as any }));
  check("completed without push info → unknown", s.outcome === "unknown", s);
}

console.log("bulk-pricing-push: summarizeBulkPricingGuestyPush");
{
  const summary = summarizeBulkPricingGuestyPush([pushedItem(1), pushedItem(2), pushedItem(3)]);
  check("all pushed → allPushed true", summary.allPushed === true, summary);
  check("pushed count matches", summary.pushed === 3);
  check("no attention items when all pushed", summary.attention.length === 0);
}
{
  const summary = summarizeBulkPricingGuestyPush([
    pushedItem(1),
    item({ propertyId: 2, label: "Draft 2", progress: { guestyPush: { skipped: true, reason: "No valid monthly pricing plan was generated." } } }),
    item({ propertyId: 3, label: "Property 3", status: "failed", error: "HTTP 500" }),
  ]);
  check("mixed queue → allPushed false", summary.allPushed === false, summary);
  check("counts split pushed/skipped/failed", summary.pushed === 1 && summary.skipped === 1 && summary.failed === 1, summary);
  check("attention lists the skip and the failure", summary.attention.length === 2, summary.attention);
  check("attention keeps labels for the operator", summary.attention.map((a) => a.label).join(",") === "Draft 2,Property 3", summary.attention);
}
{
  const summary = summarizeBulkPricingGuestyPush([pushedItem(1), item({ propertyId: 2, status: "running" })]);
  check("in-flight queue → allPushed false", summary.allPushed === false);
  check("pending is not an attention item", summary.attention.length === 0, summary.attention);
  check("pending counted", summary.pending === 1);
}
{
  const summary = summarizeBulkPricingGuestyPush([]);
  check("empty queue → allPushed false", summary.allPushed === false);
}
{
  const summary = summarizeBulkPricingGuestyPush([pushedItem(1), item({ propertyId: 2, status: "cancelled" })]);
  check("cancelled item blocks allPushed", summary.allPushed === false);
  check("cancelled is not an attention item (operator chose to stop)", summary.attention.length === 0, summary.attention);
}

console.log(`\nbulk-pricing-push tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
