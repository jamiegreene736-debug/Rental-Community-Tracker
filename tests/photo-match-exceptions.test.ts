import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_EXCEPTIONS_PER_FOLDER,
  addPhotoMatchException,
  exceptionSetForFolder,
  isConfirmedMatchUrl,
  normalizeListingUrlForMatch,
  parsePhotoMatchExceptions,
  removePhotoMatchException,
  serializePhotoMatchExceptions,
  type PhotoMatchExceptionStore,
} from "../shared/photo-match-exceptions";

console.log("photo-match-exceptions suite");

// ── URL normalization (must equal server/authorized-urls.ts semantics) ──
assert.equal(normalizeListingUrlForMatch("https://www.vrbo.com/753065?adults=2#photos"), "vrbo.com/753065");
assert.equal(normalizeListingUrlForMatch("https://vrbo.com/753065/"), "vrbo.com/753065");
assert.equal(
  normalizeListingUrlForMatch("https://www.booking.com/hotel/us/menehune.html"),
  "booking.com/hotel/us/menehune",
  "extension stripped",
);
assert.equal(normalizeListingUrlForMatch("not a url"), null);
assert.equal(normalizeListingUrlForMatch(""), null);
console.log("  ✓ normalization collapses query/slash/www/extension variants");

// ── add / dedupe / remove / set ──
const store: PhotoMatchExceptionStore = Object.create(null);
const now = new Date("2026-07-20T18:00:00.000Z");
const added = addPhotoMatchException(store, "menehune-shores-unit-b", "https://www.vrbo.com/999111?x=1", now, "Look-alike condo");
assert.ok(added, "exception added");
assert.equal(added!.normalized, "vrbo.com/999111");
// Same listing via a URL variant → idempotent (no duplicate row).
const again = addPhotoMatchException(store, "menehune-shores-unit-b", "https://vrbo.com/999111/", now);
assert.equal(store["menehune-shores-unit-b"]!.length, 1, "URL variants dedupe to one exception");
assert.equal(again!.confirmedAt, added!.confirmedAt, "existing row returned, not replaced");

const set = exceptionSetForFolder(store, "menehune-shores-unit-b");
assert.equal(isConfirmedMatchUrl(set, "https://www.vrbo.com/999111?adults=4"), true, "variant of a confirmed listing matches");
assert.equal(isConfirmedMatchUrl(set, "https://www.vrbo.com/753065"), false, "a DIFFERENT listing is never suppressed");
assert.equal(isConfirmedMatchUrl(exceptionSetForFolder(store, "other-folder"), "https://www.vrbo.com/999111"), false, "exceptions are folder-scoped");

assert.equal(removePhotoMatchException(store, "menehune-shores-unit-b", "https://vrbo.com/999111"), true, "undo removes by normalized key");
assert.equal(store["menehune-shores-unit-b"], undefined, "empty folder entry cleaned up");
assert.equal(removePhotoMatchException(store, "menehune-shores-unit-b", "https://vrbo.com/999111"), false, "second remove is a no-op");
console.log("  ✓ add/dedupe/remove + folder scoping (different listings still warn)");

// ── parse/serialize round trip + junk tolerance + caps ──
const store2: PhotoMatchExceptionStore = Object.create(null);
addPhotoMatchException(store2, "f1", "https://www.airbnb.com/rooms/42", now, "t");
const roundTripped = parsePhotoMatchExceptions(serializePhotoMatchExceptions(store2));
assert.deepEqual(roundTripped.f1![0]!.normalized, "airbnb.com/rooms/42", "round trip preserves rows");
assert.equal(Object.keys(parsePhotoMatchExceptions("{not json")).length, 0, "junk parses to empty");
assert.equal(Object.keys(parsePhotoMatchExceptions('{"f":[{"url":""}]}')).length, 0, "row without a usable URL dropped");
const capStore: PhotoMatchExceptionStore = Object.create(null);
for (let i = 0; i < MAX_EXCEPTIONS_PER_FOLDER + 10; i++) {
  addPhotoMatchException(capStore, "big", `https://www.vrbo.com/${1000 + i}`, now);
}
assert.equal(capStore.big!.length, MAX_EXCEPTIONS_PER_FOLDER, "per-folder cap enforced");
console.log("  ✓ parse/serialize round trip, junk tolerance, caps");

// ── SOURCE GUARDS ─────────────────────────────────────────────────────────────
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");
const scannerSrc = read("server", "photo-listing-scanner.ts");
const authorizedSrc = read("server", "authorized-urls.ts");
const routesSrc = read("server", "routes.ts");
const homeSrc = read("client", "src", "pages", "home.tsx");

// Scanner: exceptions suppressed at the SAME seam as authorized URLs, folder-scoped.
assert.ok(scannerSrc.includes("confirmedMatchSetForFolder(folder)"), "scanner must load the folder's confirmed exceptions");
assert.ok(
  /isAuthorizedUrl\(c, authorizedUrls\)\)\) return false;[\s\S]{0,400}isConfirmedMatchUrl\(confirmedOkUrls/.test(scannerSrc),
  "exception suppression must sit at the authorized-URL seam",
);
// One shared normalization: authorized-urls re-exports the shared function.
assert.ok(authorizedSrc.includes("normalizeListingUrl = normalizeListingUrlForMatch"), "authorized-urls must reuse the shared normalizer (no drift)");
// Routes: confirm + undo endpoints exist.
assert.ok(routesSrc.includes('app.post("/api/photo-listing-check/match-exceptions"'), "confirm endpoint must exist");
assert.ok(routesSrc.includes('app.post("/api/photo-listing-check/match-exceptions/remove"'), "undo endpoint must exist");
// UI: per-link confirm button chains into the folder rescan so the row heals
// through the real scanner path (never a faked status flip).
assert.ok(homeSrc.includes("confirmMatchOkMutation"), "home.tsx must define the confirm-OK mutation");
assert.ok(/confirmMatchOkMutation[\s\S]{0,1600}confirmPhotosReplacedMutation\.mutate\(/.test(homeSrc), "confirming must kick the folder rescan");
assert.ok(homeSrc.includes("button-confirm-match-ok-"), "per-link confirm button must render in the popup");
console.log("  ✓ source guards: scanner seam, shared normalizer, routes, popup wiring");

// ── Avg Paid Rate tile (same-PR feature) source guards ──
assert.ok(
  /paidRateBookings[\s\S]{0,400}avgPaidNightlyRate = paidNightsTotal > 0 \? Math\.round\(paidAmountTotal \/ paidNightsTotal\) : null/.test(routesSrc),
  "revenue-30-days must compute the nights-weighted realized rate",
);
assert.ok(routesSrc.includes("avgPaidNightlyRate,"), "response must carry avgPaidNightlyRate");
assert.ok(homeSrc.includes("Avg Paid Rate/Night"), "tile label must say Avg Paid Rate/Night");
assert.ok(homeSrc.includes("revenueSummary?.avgPaidNightlyRate"), "tile must read the server's realized rate");
assert.ok(!homeSrc.includes("const avgLow"), "the listed-price average must be gone from the dashboard");
console.log("  ✓ avg-paid-rate tile: server computation + tile wiring, listed-price avg gone");

console.log("photo-match-exceptions suite passed");
