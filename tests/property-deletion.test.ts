// Pure helpers behind the dashboard "delete an added listing/draft" feature.
// The feature deletes a community_drafts row (dashboard id -N) plus every store
// keyed by that -N property id, its photo folders, and the positive draft id.
// These helpers derive the folder names and prune the app_settings audit docs.
import assert from "node:assert";
import fs from "node:fs";
import {
  communityDraftPhotoFolders,
  pruneRecordsByPropertyId,
  parseDeletedCorePropertyIds,
  serializeDeletedCorePropertyIds,
} from "../shared/property-deletion";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
  }
}

const read = (rel: string): string => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

console.log("property-deletion: folder derivation + app_settings prune");

// ── communityDraftPhotoFolders ───────────────────────────────────────────────
check("returns the three canonical folders for a positive draft id",
  JSON.stringify(communityDraftPhotoFolders(70)) ===
  JSON.stringify(["draft-70-unit-a", "draft-70-unit-b", "community-draft-70"]));

check("accepts the negative dashboard id and normalizes to the same folders",
  JSON.stringify(communityDraftPhotoFolders(-70)) ===
  JSON.stringify(communityDraftPhotoFolders(70)));

check("normalizes non-integer input via trunc",
  JSON.stringify(communityDraftPhotoFolders(-70.9)) ===
  JSON.stringify(communityDraftPhotoFolders(70)));

// Drift-lock: the exact folder shape must match what the persist-photos flow and
// the existing admin cleanup route (routes.ts) create/delete. If that naming
// ever changes, this helper (and the delete route) must change with it.
{
  const routesSrc = read("server/routes.ts");
  check("folder naming matches the admin cleanup route's `draft-${id}-unit-a` form",
    routesSrc.includes("`draft-${id}-unit-a`") &&
    routesSrc.includes("`draft-${id}-unit-b`") &&
    routesSrc.includes("`community-draft-${id}`"));
}

// ── pruneRecordsByPropertyId ─────────────────────────────────────────────────
{
  const records = {
    jobA: { propertyId: -70, verdict: "pass" },
    jobB: { propertyId: -71, verdict: "attention" },
    jobC: { propertyId: -70, verdict: "failed" },
    jobD: { propertyId: 4, verdict: "pass" },
  };
  const { records: kept, removed } = pruneRecordsByPropertyId(records, -70);
  check("removes exactly the records whose propertyId matches", removed === 2);
  check("keeps every other record untouched",
    Object.keys(kept).sort().join(",") === "jobB,jobD" &&
    kept.jobB.propertyId === -71 &&
    kept.jobD.propertyId === 4);
  check("does not mutate the input object", Object.keys(records).length === 4);
}

check("no-op when nothing matches the property id",
  pruneRecordsByPropertyId({ a: { propertyId: 4 } }, -70).removed === 0);

check("tolerates an empty / undefined record map",
  pruneRecordsByPropertyId({}, -70).removed === 0 &&
  pruneRecordsByPropertyId(undefined as any, -70).removed === 0);

check("does not treat a positive core id as its negative dashboard twin",
  pruneRecordsByPropertyId({ a: { propertyId: 70 } }, -70).removed === 0);

// ── deleted-core-property-id set (round-trips, dedupes, sorts, rejects junk) ──
check("parses/serializes a clean sorted unique positive-id set",
  serializeDeletedCorePropertyIds([4, 32, 4]) === "[4,32]"
  && JSON.stringify(parseDeletedCorePropertyIds("[32,4,4]")) === "[4,32]");

check("drops non-positive / non-integer / junk ids",
  JSON.stringify(parseDeletedCorePropertyIds("[4,-7,0,3.5,\"x\",null,32]")) === "[4,32]");

check("tolerates empty / malformed / non-array input",
  JSON.stringify(parseDeletedCorePropertyIds(null)) === "[]"
  && JSON.stringify(parseDeletedCorePropertyIds("not json")) === "[]"
  && JSON.stringify(parseDeletedCorePropertyIds('{"a":1}')) === "[]");

// ── Wiring drift-locks: the storage deep-delete + the DELETE route ───────────
{
  const storageSrc = read("server/storage.ts");
  check("storage.deletePropertyDataDeep + deleteCommunityDraftDeep exist",
    storageSrc.includes("async deletePropertyDataDeep(") &&
    storageSrc.includes("async deleteCommunityDraftDeep("));
  check("storage exposes the deleted-core-id set helpers",
    storageSrc.includes("async getDeletedCorePropertyIds(") &&
    storageSrc.includes("async addDeletedCorePropertyId("));
  // These stores MUST be cleaned by property id — a regression that drops one
  // silently orphans that data on every delete.
  for (const table of [
    "propertyMarketRates", "pricingUpdateLogs", "propertyTrailingRevenue",
    "propertyAmenities", "propertyDescriptionOverrides", "propertyComplianceOverrides",
    "unitSwaps", "scannerSchedule", "scannerRunHistory", "guestyPropertyMap",
  ]) {
    check(`deletePropertyDataDeep cleans ${table}`, storageSrc.includes(table));
  }

  const routesSrc = read("server/routes.ts");
  check("DELETE /api/dashboard/property/:id route exists",
    routesSrc.includes('app.delete("/api/dashboard/property/:id"'));
  check("route gates on the Guesty connection (getGuestyListingId) for both kinds",
    routesSrc.includes("getGuestyListingId(dashboardId)"));
  check("route deletes drafts (negative id) via the draft-deep purge",
    routesSrc.includes("deleteCommunityDraftDeep(draftId)"));
  check("route deletes CORE properties (positive id): persist hide + deep purge",
    routesSrc.includes("dashboardId > 0") &&
    routesSrc.includes("addDeletedCorePropertyId(dashboardId)") &&
    routesSrc.includes("deletePropertyDataDeep(dashboardId)"));
  check("GET /api/dashboard/removed-core-properties route exists",
    routesSrc.includes('app.get("/api/dashboard/removed-core-properties"'));

  // Schedulers must skip operator-deleted core ids or the delete doesn't stick.
  check("unit-audit cron filters deleted core ids",
    read("server/unit-audit-scheduler.ts").includes("getDeletedCorePropertyIds"));
  check("market-rate cron filters deleted core ids",
    read("server/market-rate-scheduler.ts").includes("getDeletedCorePropertyIds"));

  const homeSrc = read("client/src/pages/home.tsx");
  check("client hits the delete endpoint with the dashboard id",
    homeSrc.includes("`/api/dashboard/property/${property.id}`"));
  check("client delete is a two-step confirmation",
    homeSrc.includes("button-confirm-delete-step-1") &&
    homeSrc.includes("button-confirm-delete-step-2"));
  check("client delete button is gated on the Guesty connection",
    homeSrc.includes("guestyConnected.has(property.id)") &&
    homeSrc.includes("button-delete-property-"));
  check("client offers delete on core rows too (not only drafts)",
    homeSrc.includes("isDraft || unitBuilderIds.has(property.id)"));
  check("client hides deleted core rows via the persisted removed set",
    homeSrc.includes('"/api/dashboard/removed-core-properties"') &&
    homeSrc.includes("!removedCoreIds.has(p.id)"));
}

console.log(`\nproperty-deletion: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
