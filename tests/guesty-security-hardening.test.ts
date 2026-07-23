import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyGuestyPushBackfill,
  applyGuestyPushRecord,
  parseGuestyPushHistoryStore,
  type GuestyPushEntry,
  type GuestyPushHistoryStore,
} from "../shared/guesty-push-history";
import { buildGuestyApiUrl } from "../shared/guesty-endpoint";
import { sanitizeForChatText } from "../shared/safe-log";

let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("Guesty security hardening");

check("Guesty URL builder preserves valid paths and canonicalizes query values", () => {
  assert.equal(
    buildGuestyApiUrl("/listings/6a03abf0e37bd400149f1f05?fields=pictures%20title&limit=10"),
    "https://open-api.guesty.com/v1/listings/6a03abf0e37bd400149f1f05?fields=pictures%20title&limit=10",
  );
});

check("Guesty URL builder keeps attacker-controlled URLs inside query values", () => {
  const url = new URL(buildGuestyApiUrl("/listings?redirect=https://example.invalid/a&redirect=/second"));
  assert.equal(url.origin, "https://open-api.guesty.com");
  assert.equal(url.pathname, "/v1/listings");
  assert.deepEqual(url.searchParams.getAll("redirect"), ["https://example.invalid/a", "/second"]);
});

check("Guesty URL builder rejects absolute, protocol-relative, traversal, fragment, and malformed inputs", () => {
  for (const endpoint of [
    "https://example.invalid/listings",
    "//example.invalid/listings",
    "/listings/../tokens",
    "/listings/%2e%2e/tokens",
    "/listings/%2e%2e%2Ftokens",
    "/listings/%2e%2e%5Ctokens",
    "/listings/%252e%252e%252ftokens",
    "/listings\\..\\tokens",
    "/listings#https://example.invalid",
    "/listings/%ZZ",
  ]) {
    assert.throws(() => buildGuestyApiUrl(endpoint), /Guesty endpoint/);
  }
});

check("guestyRequest sends only the URL produced by the safe builder", () => {
  const sync = readFileSync(new URL("../server/guesty-sync.ts", import.meta.url), "utf8");
  assert.match(sync, /const requestUrl = buildGuestyApiUrl\(endpoint\)/);
  assert.match(sync, /await fetch\(requestUrl,/);
  assert.doesNotMatch(sync, /fetch\(`https:\/\/open-api\.guesty\.com\/v1\$\{endpoint\}`/);
});

const validEntry: GuestyPushEntry = {
  pushedAt: "2026-07-23T22:00:00.000Z",
  status: "success",
  summary: "31 photos pushed",
};

check("push-history writes reject prototype keys and convert legacy maps to null-prototype maps", () => {
  const store: GuestyPushHistoryStore = { version: 1, listings: {} };
  assert.equal(applyGuestyPushRecord(store, "__proto__", "photos", validEntry, validEntry.pushedAt), false);
  assert.equal(applyGuestyPushRecord(store, "constructor", "photos", validEntry, validEntry.pushedAt), false);
  assert.deepEqual(
    applyGuestyPushBackfill(store, "__proto__", { photos: validEntry }, validEntry.pushedAt),
    { applied: 0, rejected: 0 },
  );
  assert.equal(applyGuestyPushRecord(store, "listing-1", "photos", validEntry, validEntry.pushedAt), true);
  assert.equal(Object.getPrototypeOf(store.listings), null);
  assert.equal(({} as Record<string, unknown>).photos, undefined);
});

check("push-history parsing drops prototype keys", () => {
  const raw = JSON.stringify({
    version: 1,
    listings: {
      ["__proto__"]: { tabs: { photos: validEntry }, updatedAt: validEntry.pushedAt },
      good: { tabs: { photos: validEntry }, updatedAt: validEntry.pushedAt },
    },
  });
  const parsed = parseGuestyPushHistoryStore(raw);
  assert.equal(Object.getPrototypeOf(parsed.listings), null);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.listings, "__proto__"), false);
  assert.equal(parsed.listings.good.tabs.photos?.summary, "31 photos pushed");
});

check("safe-log strips long trailing punctuation without a backtracking regex", () => {
  const punctuation = "!".repeat(50_000);
  assert.equal(
    sanitizeForChatText(`See https://example.com/gallery${punctuation}`, { maxLength: 100_000 }),
    `See [url:example.com/gallery]${punctuation}`,
  );
  const source = readFileSync(new URL("../shared/safe-log.ts", import.meta.url), "utf8");
  assert.match(source, /while \(end > 0 && TRAILING_URL_PUNCTUATION\.has/);
  assert.doesNotMatch(source, /raw\.match\(\s*\/\[[^\n]*\]\+\$\//);
});

check("photo mutation routes are rate-limited and local hosting enforces path containment", () => {
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const hosting = routes.slice(
    routes.indexOf("function sanitizePublicPathSegment"),
    routes.indexOf("function isAgreementChannel"),
  );
  assert.match(routes, /const guestyPhotoMutationRateLimit = rateLimit\(/);
  assert.match(routes, /app\.post\("\/api\/builder\/push-photos", guestyPhotoMutationRateLimit,/);
  assert.match(routes, /app\.post\("\/api\/builder\/normalize-photos", guestyPhotoMutationRateLimit,/);
  assert.match(hosting, /const hostedRoot = path\.resolve/);
  assert.match(hosting, /!targetPath\.startsWith\(`\$\{targetDir\}\$\{path\.sep\}`\)/);
  assert.match(hosting, /for \(const character of String\(value \?\? ""\)\.slice\(0, 256\)\)/);
  assert.doesNotMatch(hosting, /\.replace\(/);
});

console.log(`\nGuesty security hardening: ${passed} passed`);
