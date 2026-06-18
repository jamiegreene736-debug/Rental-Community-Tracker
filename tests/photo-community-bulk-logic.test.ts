import {
  BULK_PHOTO_COMMUNITY_ITEM_RECLAIM_MS,
  BULK_PHOTO_COMMUNITY_ITEM_STALE_FAIL_MS,
  BULK_PHOTO_COMMUNITY_PROPERTY_TIMEOUT_MS,
  shouldFailStaleBulkPhotoCommunityItem,
  shouldReclaimBulkPhotoCommunityItem,
} from "../shared/photo-community-bulk-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("photo-community-bulk watchdog logic");

const now = Date.now();
const workerStart = now - 5_000;

check("property timeout is 12 minutes", BULK_PHOTO_COMMUNITY_PROPERTY_TIMEOUT_MS === 12 * 60 * 1000);
check("reclaim threshold is 45 seconds", BULK_PHOTO_COMMUNITY_ITEM_RECLAIM_MS === 45_000);
check("stale fail threshold is 15 minutes", BULK_PHOTO_COMMUNITY_ITEM_STALE_FAIL_MS === 15 * 60 * 1000);

check(
  "reclaim item started before this worker session and age >= 45s",
  shouldReclaimBulkPhotoCommunityItem(
    { status: "running", startedAt: now - 60_000 },
    workerStart,
    now,
  ),
);

check(
  "do not reclaim item started by this worker session",
  !shouldReclaimBulkPhotoCommunityItem(
    { status: "running", startedAt: workerStart + 1000 },
    workerStart,
    now,
  ),
);

check(
  "fail item stale after 15 minutes",
  shouldFailStaleBulkPhotoCommunityItem(
    { status: "running", startedAt: now - 16 * 60 * 1000 },
    now,
  ),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
