import assert from "node:assert/strict";
import { decidePlatformStatus } from "../shared/photo-listing-decision";

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

console.log("photo-listing-decision: all assertions passed");
