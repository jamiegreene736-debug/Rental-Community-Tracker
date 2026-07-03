import assert from "node:assert";
import {
  duplicatePhotoWarningSignature,
  formatDuplicatePhotoPlatforms,
  photoReplaceRescanVerdict,
} from "../shared/duplicate-photo-warning";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("duplicate-photo-warning: dashboard duplicate-photos popup helpers");

// ── signature ────────────────────────────────────────────────────────────────
check("empty unit list → empty signature (no popup)", duplicatePhotoWarningSignature([]) === "");

const sigA = duplicatePhotoWarningSignature([
  { folder: "poipu-kai-a", platforms: ["vrbo", "airbnb"], checkedAt: "2026-07-01T10:00:00Z" },
  { folder: "kaha-lani-b", platforms: ["booking"], checkedAt: "2026-07-02T10:00:00Z" },
]);
const sigB = duplicatePhotoWarningSignature([
  { folder: "kaha-lani-b", platforms: ["booking"], checkedAt: "2026-07-02T10:00:00Z" },
  { folder: "poipu-kai-a", platforms: ["airbnb", "vrbo"], checkedAt: "2026-07-01T10:00:00Z" },
]);
check("signature is order-independent across units AND platforms", sigA === sigB && sigA.length > 0);

const sigNewScan = duplicatePhotoWarningSignature([
  { folder: "poipu-kai-a", platforms: ["vrbo", "airbnb"], checkedAt: "2026-07-03T10:00:00Z" },
  { folder: "kaha-lani-b", platforms: ["booking"], checkedAt: "2026-07-02T10:00:00Z" },
]);
check("a fresh scan re-confirming duplicates changes the signature (re-raises a dismissed popup)", sigNewScan !== sigA);

const sigNewPlatform = duplicatePhotoWarningSignature([
  { folder: "poipu-kai-a", platforms: ["vrbo", "airbnb", "booking"], checkedAt: "2026-07-01T10:00:00Z" },
  { folder: "kaha-lani-b", platforms: ["booking"], checkedAt: "2026-07-02T10:00:00Z" },
]);
check("a new platform on an existing unit changes the signature", sigNewPlatform !== sigA);

check("missing checkedAt is tolerated", duplicatePhotoWarningSignature([{ folder: "x", platforms: ["airbnb"] }]).includes("x|airbnb|"));

// ── platform labels ──────────────────────────────────────────────────────────
check("platform labels render operator-facing names", formatDuplicatePhotoPlatforms(["airbnb", "vrbo", "booking"]) === "Airbnb / VRBO / Booking.com");

// ── rescan verdict ───────────────────────────────────────────────────────────
const startedAt = Date.parse("2026-07-03T12:00:00Z");

check("no checkedAt yet → pending", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: null, statuses: {},
}).state === "pending");

check("stale checkedAt (before rescan start) → pending", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T11:59:58Z",
  statuses: { airbnb: "clean", vrbo: "clean", booking: "clean" },
}).state === "pending");

check("checkedAt within the 1s tolerance counts as done", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T11:59:59.500Z",
  statuses: { airbnb: "clean", vrbo: "clean", booking: "clean" },
}).state === "clean");

check("unparseable checkedAt → pending", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: "not-a-date",
  statuses: { airbnb: "clean", vrbo: "clean", booking: "clean" },
}).state === "pending");

check("all three clean after rescan → clean", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T12:05:00Z",
  statuses: { airbnb: "clean", vrbo: "clean", booking: "clean" },
}).state === "clean");

{
  const v = photoReplaceRescanVerdict({
    rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T12:05:00Z",
    statuses: { airbnb: "clean", vrbo: "found", booking: "unknown" },
  });
  check("any FOUND wins over inconclusive → still_found on that platform only",
    v.state === "still_found" && v.platforms.join(",") === "vrbo");
}

{
  const v = photoReplaceRescanVerdict({
    rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T12:05:00Z",
    statuses: { airbnb: "clean", vrbo: "unknown", booking: undefined },
  });
  check("no FOUND but unknown/missing platforms → inconclusive, never a soft clean",
    v.state === "inconclusive" && v.platforms.join(",") === "vrbo,booking");
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
