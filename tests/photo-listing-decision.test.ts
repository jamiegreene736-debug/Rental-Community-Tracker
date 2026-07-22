import assert from "node:assert/strict";
import fs from "node:fs";
import {
  INCONCLUSIVE_SCAN_NOTE,
  decidePlatformStatus,
  photoListingScanWasInconclusive,
  subThresholdVerifiedMatches,
  subThresholdVerifiedMatchRows,
} from "../shared/photo-listing-decision";

function check(label: string, ok: boolean) {
  assert.ok(ok, label);
  console.log(`  ✓ ${label}`);
}

// Pins the Balanced detection contract (2026-06-29) for the weekly photo-listing cron's PHOTO leg:
//   - >=2 fully-verified photos OR >=3 community-compatible strong photos => "found"
//   - no signal + no Lens success => "unknown" (never silently "clean")
//   - no signal + Lens succeeded => "clean"
// Defaults: minMatches=2, agreementThreshold=3.
const base = {
  photoHitCount: 0,
  photoStrongCount: 0,
  anyLensSucceeded: true,
};

console.log("decidePlatformStatus:");

check(
  "flags found at the verified MIN_MATCHES threshold (2)",
  decidePlatformStatus({ ...base, photoHitCount: 2, photoStrongCount: 2 }) === "found",
);

check(
  "does NOT flag found on a single verified photo (precision floor held)",
  decidePlatformStatus({ ...base, photoHitCount: 1, photoStrongCount: 1 }) === "clean",
);

check(
  "flags found on multi-photo agreement (3 strong) with zero unit-text-verified hits",
  decidePlatformStatus({ ...base, photoHitCount: 0, photoStrongCount: 3 }) === "found",
);

check(
  "does NOT flag found on only 2 strong-but-unverified photos (below agreement threshold)",
  decidePlatformStatus({ ...base, photoHitCount: 0, photoStrongCount: 2 }) === "clean",
);

check(
  "returns unknown (not clean) when no signal and no Lens call succeeded",
  decidePlatformStatus({ ...base, anyLensSucceeded: false }) === "unknown",
);

check(
  "returns clean when Lens ran and found nothing",
  decidePlatformStatus({ ...base }) === "clean",
);

check(
  "stricter agreement override (4) => 3 strong is no longer enough",
  decidePlatformStatus({ ...base, photoStrongCount: 3, agreementThreshold: 4 }) === "clean",
);

check(
  "looser minMatches override (1) => a single verified photo flags",
  decidePlatformStatus({ ...base, photoHitCount: 1, photoStrongCount: 1, minMatches: 1 }) === "found",
);

// ── photoListingScanWasInconclusive (2026-07-12: 24h outage retry instead of the 7-day cadence) ──
console.log("photoListingScanWasInconclusive:");

check(
  "all-unknown statuses (no Lens success ever) => inconclusive",
  photoListingScanWasInconclusive({ airbnbStatus: "unknown", vrboStatus: "unknown", bookingStatus: "unknown", errorMessage: null }) === true,
);

check(
  "healthy clean row => NOT inconclusive (weekly cadence holds)",
  photoListingScanWasInconclusive({ airbnbStatus: "clean", vrboStatus: "clean", bookingStatus: "clean", errorMessage: null }) === false,
);

check(
  "healthy found row => NOT inconclusive (red verdicts keep the weekly cadence)",
  photoListingScanWasInconclusive({ airbnbStatus: "found", vrboStatus: "clean", bookingStatus: "clean", errorMessage: null }) === false,
);

check(
  "outage-preserved row (statuses kept + the persist() note) => inconclusive",
  photoListingScanWasInconclusive({
    airbnbStatus: "found",
    vrboStatus: "clean",
    bookingStatus: "clean",
    errorMessage: `Lens unavailable for selected unit photos: HTTP 429 (${INCONCLUSIVE_SCAN_NOTE})`,
  }) === true,
);

check(
  "Lens-unavailable error with a partial verdict => inconclusive",
  photoListingScanWasInconclusive({ airbnbStatus: "clean", vrboStatus: "unknown", bookingStatus: "unknown", errorMessage: "Lens unavailable for selected unit photos: request failed" }) === true,
);

check(
  "legacy address-leg failure note on a decided photo row => NOT inconclusive (photo verdict is usable)",
  photoListingScanWasInconclusive({ airbnbStatus: "clean", vrboStatus: "clean", bookingStatus: "clean", errorMessage: "Address search unavailable: SearchApi timed out" }) === false,
);

// ── subThresholdVerifiedMatches (2026-07-12: display-only amber REVIEW tier) ──
console.log("subThresholdVerifiedMatches:");

check(
  "one verified match on a clean platform => review count 1",
  subThresholdVerifiedMatches("clean", [{ verified: true }]) === 1,
);

check(
  "a found platform never double-reports as review (red wins)",
  subThresholdVerifiedMatches("found", [{ verified: true }, { verified: true }]) === 0,
);

check(
  "unverified agreement-evidence matches do NOT count toward review",
  subThresholdVerifiedMatches("clean", [{ verified: false }, {}]) === 0,
);

check(
  "legacy rows without the verified flag stay quiet (no matches => 0)",
  subThresholdVerifiedMatches("clean", null) === 0 && subThresholdVerifiedMatches("clean", []) === 0,
);

check(
  "verified match on an unknown-status row still surfaces for review",
  subThresholdVerifiedMatches("unknown", [{ verified: true }]) === 1,
);

// ── subThresholdVerifiedMatchRows (2026-07-22: rows + operator exception filter) ──
console.log("subThresholdVerifiedMatchRows:");

const rowA = { verified: true, listingUrl: "https://www.vrbo.com/p123?x=1" };
const rowB = { verified: true, listingUrl: "https://vrbo.com/p999" };
check(
  "returns the verified rows themselves (count fn delegates)",
  subThresholdVerifiedMatchRows("clean", [rowA, { verified: false, listingUrl: "https://vrbo.com/p2" }]).length === 1 &&
    subThresholdVerifiedMatchRows("clean", [rowA])[0] === rowA,
);
check(
  "an operator-confirmed exception (normalized URL) excludes that match — www/query variants collapse",
  subThresholdVerifiedMatchRows("clean", [rowA, rowB], new Set(["vrbo.com/p123"])).length === 1 &&
    subThresholdVerifiedMatchRows("clean", [rowA, rowB], new Set(["vrbo.com/p123"]))[0] === rowB,
);
check(
  "all matches excepted => zero rows (badge greens)",
  subThresholdVerifiedMatchRows("clean", [rowA, rowB], new Set(["vrbo.com/p123", "vrbo.com/p999"])).length === 0,
);
check(
  "a match with an unparseable listing URL is never silenced by exceptions (fail-loud)",
  subThresholdVerifiedMatchRows("clean", [{ verified: true, listingUrl: "not-a-url" }], new Set(["vrbo.com/p123"])).length === 1,
);
check(
  "found platform still returns no review rows (red wins)",
  subThresholdVerifiedMatchRows("found", [rowA]).length === 0,
);

// ── Source guards: the wiring these helpers exist for must not drift ──
console.log("source guards:");

const read = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const scannerSrc = read("server/photo-listing-scanner.ts");
const storageSrc = read("server/storage.ts");
const reactionsSrc = read("server/photo-found-reactions.ts");
const sweepSrc = read("server/unit-audit-sweep.ts");
const homeSrc = read("client/src/pages/home.tsx");
const alertsSrc = read("server/operator-alerts.ts");

check(
  "scanner persist() writes the SHARED inconclusive note (an inlined reworded copy would break the 24h retry)",
  scannerSrc.includes("INCONCLUSIVE_SCAN_NOTE") && scannerSrc.includes("(${INCONCLUSIVE_SCAN_NOTE})"),
);

check(
  "scanner tags fully-verified hits with verified: true (feeds the dashboard review tier)",
  scannerSrc.includes("verifiedHits.push({ photoUrl, listingUrl: link, title, source, verified: true })"),
);

check(
  "storage staleness check consults photoListingScanWasInconclusive for the short retry window",
  storageSrc.includes("photoListingScanWasInconclusive"),
);

check(
  "weekly scheduler passes the inconclusive retry window + the found-flip reaction hook",
  scannerSrc.includes("PHOTO_LISTING_INCONCLUSIVE_RETRY_MS") &&
    scannerSrc.includes("onNewDetection: reactToPhotoListingDetections"),
);

check(
  "reactive sweep runs with the CRON posture (source: \"cron\" => cooldown/budget rails + fresh OTA row reuse)",
  reactionsSrc.includes('source: "cron"') && reactionsSrc.includes("startUnitAuditSweep"),
);

check(
  "reactive sweep never resets the weekly replacement budget (it draws from the shared allowance)",
  !reactionsSrc.includes("resetCronReplaceBudget"),
);

check(
  "reactive sweep is ALERT-ONLY for duplicate findings (2026-07-20): the SMS + note say replacement is OFF and point at the dashboard alert",
  reactionsSrc.includes("unattendedOtaDuplicateReplaceBlocked") &&
    reactionsSrc.includes("automatic replacement is OFF for duplicate findings"),
);

check(
  "cron replace blocks (cooldown + budget) text the operator via sendOperatorAlert",
  sweepSrc.includes("replace-blocked-cooldown:") && sweepSrc.includes("replace-blocked-budget:"),
);

check(
  "operator alerts are fail-soft and phone-gated (OPERATOR_ALERT_PHONE)",
  alertsSrc.includes("OPERATOR_ALERT_PHONE") && alertsSrc.includes("return false"),
);

check(
  "dashboard derives the amber review badge from the shared helper (status stays clean — no popup)",
  homeSrc.includes("subThresholdVerifiedMatchRows(row.airbnbStatus, row.airbnbMatches") &&
    homeSrc.includes("subThresholdVerifiedMatchRows(row.vrboStatus, row.vrboMatches") &&
    homeSrc.includes("subThresholdVerifiedMatchRows(row.bookingStatus, row.bookingMatches"),
);

// ── 2026-07-22: amber badge → review modal → match-exception wiring ──
check(
  "amber review badge is clickable and opens the review modal",
  homeSrc.includes("setPhotoReviewModal({ propertyId: property.id") &&
    homeSrc.includes("onClick={isReview ?"),
);
check(
  "confirming 'not a match' saves a match exception then deep-rescans the folder (heals through the real scanner)",
  homeSrc.includes('"/api/photo-listing-check/match-exceptions"') &&
    homeSrc.includes("photoScanMutation.mutate({ folders: [vars.folder]"),
);
check(
  "the badge computation consults the operator exception allowlist so a confirmed listing greens immediately",
  homeSrc.includes("photoMatchExceptionSets.get(f)"),
);

// ── 2026-07-22: _pending_ temp-name scan guard + stale-thumbnail degrade ──
check(
  "scanner label candidates exclude _-prefixed pipeline temp names (a scan racing a hydration must not stamp _pending_NNN.jpg photoUrls)",
  scannerSrc.includes('!l.filename.startsWith("_")') && scannerSrc.includes('!l.filename.startsWith(".")'),
);
check(
  "match thumbnails hide themselves on a broken/stale photoUrl instead of rendering a broken-image icon",
  (homeSrc.match(/onError=\{\(e\) => \{ (?:const a = )?e\.currentTarget/g)?.length ?? 0) >= 2 &&
    homeSrc.includes('e.currentTarget.style.display = "none"'),
);

console.log("photo-listing-decision: all assertions passed");
