import assert from "node:assert/strict";
import fs from "node:fs";
import {
  INCONCLUSIVE_SCAN_NOTE,
  decidePlatformStatus,
  photoListingScanWasInconclusive,
  subThresholdVerifiedMatches,
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
  hasAddressHit: false,
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
  "an explicit address hit (folded-in caller) is decisive found",
  decidePlatformStatus({ ...base, hasAddressHit: true }) === "found",
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
  "address-leg-only failure on a decided photo row => NOT inconclusive (photo verdict is usable)",
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
  "cron replace blocks (cooldown + budget) text the operator via sendOperatorAlert",
  sweepSrc.includes("replace-blocked-cooldown:") && sweepSrc.includes("replace-blocked-budget:"),
);

check(
  "operator alerts are fail-soft and phone-gated (OPERATOR_ALERT_PHONE)",
  alertsSrc.includes("OPERATOR_ALERT_PHONE") && alertsSrc.includes("return false"),
);

check(
  "dashboard derives the amber review badge from the shared helper (status stays clean — no popup)",
  homeSrc.includes("subThresholdVerifiedMatches(row.airbnbStatus, row.airbnbMatches)"),
);

console.log("photo-listing-decision: all assertions passed");
