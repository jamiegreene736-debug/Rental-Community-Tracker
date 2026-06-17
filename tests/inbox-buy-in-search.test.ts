// Locks the load-bearing invariants of the read-only inbox buy-in search
// (the "Do buy-in search" button on a guest inquiry). It reuses the Operations
// "Auto-fill cheapest" escalation ladder in DRY-RUN mode: the SAME search, but it
// attaches/persists NOTHING. These assertions fail if any guard is reverted.
//
// Run: npx tsx tests/inbox-buy-in-search.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const autoFillSource = readFileSync("server/auto-fill-job.ts", "utf8");
const routesSource = readFileSync("server/routes.ts", "utf8");
const inboxSource = readFileSync("client/src/pages/inbox.tsx", "utf8");

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
  }
}

console.log("inbox buy-in search (dry-run auto-fill) suite");

// 1) attachPick short-circuits in dry-run, recording the would-be pick with
//    buyInId:null and WITHOUT creating/attaching a buy-in. The short-circuit must
//    come BEFORE the create POST, or it would still persist.
const dryRunBranchIdx = autoFillSource.indexOf("if (job.dryRun) {");
const createPostIdx = autoFillSource.indexOf("`${base}/api/buy-ins`");
check("attachPick has an `if (job.dryRun)` short-circuit", dryRunBranchIdx !== -1);
check("dry-run short-circuit precedes the /api/buy-ins create POST", dryRunBranchIdx !== -1 && createPostIdx !== -1 && dryRunBranchIdx < createPostIdx);
check("dry-run pick is recorded with buyInId: null (so detach sites stay no-ops)", /if \(job\.dryRun\)[\s\S]{0,400}buyInId: null/.test(autoFillSource));

// 2) EVERY detach site is guarded by `buyInId != null`. This is what makes a
//    dry-run (which sets buyInId:null) skip all DB rollback/swap calls for free.
const detachLines = autoFillSource.split("\n").filter((l) => l.includes("storage.detachBuyIn("));
check("at least one storage.detachBuyIn site exists", detachLines.length >= 1);
check("every storage.detachBuyIn call is guarded by `buyInId != null`", detachLines.every((l) => /buyInId\s*!=\s*null/.test(l)));

// 3) Reservation-keyed persistence is skipped for dry-run jobs (a synthetic inbox
//    reservationId must NOT clobber a real reservation's durable rows or enroll the
//    throwaway search in boot-resume).
const finalizeIdx = autoFillSource.indexOf("function finalize(");
const finalizeBody = finalizeIdx !== -1 ? autoFillSource.slice(finalizeIdx, finalizeIdx + 1600) : "";
const dryReturnIdx = finalizeBody.indexOf("if (job.dryRun) return;");
const upsertIdx = finalizeBody.indexOf("upsertAutoFillLossOptions");
check("finalize() returns early for dry-run before upsertAutoFillLossOptions", dryReturnIdx !== -1 && upsertIdx !== -1 && dryReturnIdx < upsertIdx);
check("markAutoFillSearchStarted is gated on !job.dryRun", /if \(!job\.dryRun\) \{[\s\S]{0,200}markAutoFillSearchStarted/.test(autoFillSource));
check("the SIGTERM interrupted-stamp skips dry-run jobs", /!isTerminal\(j\.status\) && !j\.dryRun/.test(autoFillSource));

// 4) dryRun threads through the input → job → serialized status so the client can
//    render the read-only framing.
check("StartAutoFillInput declares dryRun?", /dryRun\?: boolean;/.test(autoFillSource));
check("startAutoFillJob sets job.dryRun from input", /dryRun: input\.dryRun === true/.test(autoFillSource));
check("serializeAutoFillJob exposes dryRun", /dryRun: job\.dryRun/.test(autoFillSource));

// 5) The inbox endpoint starts the SAME job in dry-run, with a namespaced synthetic
//    reservationId, profit gate disabled (inquiry has no committed revenue), and
//    scoped to PROPERTY_UNIT_CONFIGS properties.
check("POST /api/inbox/buy-in-search route exists", routesSource.includes('"/api/inbox/buy-in-search"'));
const endpointIdx = routesSource.indexOf('app.post("/api/inbox/buy-in-search"');
const endpointBody = routesSource.slice(endpointIdx, endpointIdx + 4000);
check("endpoint starts the auto-fill job with dryRun: true", /dryRun: true/.test(endpointBody));
check("endpoint uses a namespaced synthetic reservationId", /reservationId: `inbox-search:/.test(endpointBody));
check("endpoint disables the profit gate (expectedRevenue: 0)", /expectedRevenue: 0/.test(endpointBody));
check("endpoint builds slots from PROPERTY_UNIT_CONFIGS", endpointBody.includes("PROPERTY_UNIT_CONFIGS[propertyId]"));

// 6) The inbox UI exposes the button (inquiry-only) and posts to the endpoint.
check("inbox renders the Do-buy-in-search button", inboxSource.includes('data-testid="button-inbox-buy-in-search"'));
check("inbox button posts to /api/inbox/buy-in-search", inboxSource.includes('"/api/inbox/buy-in-search"'));
check("inbox polls the auto-fill status endpoint for results", inboxSource.includes("`/api/operations/auto-fill/${activeBuyInJobId}`"));

if (failures > 0) {
  console.log(`\ninbox-buy-in-search: ${failures} failed`);
  process.exit(1);
}
console.log("inbox-buy-in-search: all checks passed");
