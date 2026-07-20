// Guesty 429 in-place retry — locks the 2026-07-20 Operations-tab incident:
// "Failed to load bookings — 500: Guesty 429 on GET /reservations…". The
// global request gate always paused FUTURE Guesty calls after a 429, but the
// call that RECEIVED it threw immediately, so any interactive endpoint firing
// inside the rate-limit window surfaced a hard 500 to the operator.
//
// Fix under guard: guestyRequest loops — a 429 re-queues through the gate
// (which waits out the pause) up to GUESTY_429_RETRIES extra attempts before
// throwing. A 429 was never processed by Guesty, so the retry is safe for
// every method. Policy is pure (shared/guesty-retry.ts) because
// server/guesty-sync.ts is not importable without a DATABASE_URL.
import { readFileSync } from "node:fs";
import {
  DEFAULT_GUESTY_429_RETRIES,
  guesty429MaxAttempts,
  guesty429PauseMs,
  parseRetryAfterMs,
  shouldRetryGuesty429,
} from "../shared/guesty-retry";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("retry policy");

check("default = 2 extra attempts (3 total)",
  DEFAULT_GUESTY_429_RETRIES === 2 && guesty429MaxAttempts(undefined) === 3 && guesty429MaxAttempts("") === 3);
check("env override respected and capped at 5 retries",
  guesty429MaxAttempts("0") === 1 && guesty429MaxAttempts("4") === 5 && guesty429MaxAttempts("99") === 6);
check("garbage env falls back to default", guesty429MaxAttempts("nope") === 3);

check("429 below the cap retries; at the cap throws",
  shouldRetryGuesty429(429, 1, 3) && shouldRetryGuesty429(429, 2, 3) && !shouldRetryGuesty429(429, 3, 3));
check("non-429 statuses NEVER retry (a processed 4xx/5xx must not be re-issued blindly)",
  !shouldRetryGuesty429(500, 1, 3) && !shouldRetryGuesty429(502, 1, 3) && !shouldRetryGuesty429(400, 1, 3) && !shouldRetryGuesty429(404, 1, 3));

console.log("retry-after parsing / pause");

check("delta-seconds form", parseRetryAfterMs("30") === 30_000);
check("capped at 120s", parseRetryAfterMs("999") === 120_000);
check("HTTP-date form parses to a bounded delta", (() => {
  const ms = parseRetryAfterMs(new Date(Date.now() + 10_000).toUTCString());
  return ms !== null && ms >= 0 && ms <= 120_000;
})());
check("absent/garbage → null → 15s default pause",
  parseRetryAfterMs(null) === null && parseRetryAfterMs("soon") === null && guesty429PauseMs(null) === 15_000);
check("honored retry-after drives the pause", guesty429PauseMs(30_000) === 30_000);

console.log("wiring source guards");

const sync = readFileSync(new URL("../server/guesty-sync.ts", import.meta.url), "utf8");
const fn = sync.slice(sync.indexOf("export async function guestyRequest"), sync.indexOf("const PROPERTY_UNIT_NEEDS"));

check("guestyRequest loops over attempts with the shared policy",
  fn.includes("guesty429MaxAttempts(process.env.GUESTY_429_RETRIES)") &&
  fn.includes("for (let attempt = 1; ; attempt++)"));
check("a retryable 429 continues instead of throwing",
  fn.includes("shouldRetryGuesty429(res.status, attempt, maxAttempts)") &&
  /shouldRetryGuesty429\([^)]*\)\) \{[\s\S]{0,220}continue;/.test(fn));
check("the rate-limit pause is stamped BEFORE the retry decision (the gate waits it out)",
  fn.indexOf("guestyRateLimitPauseUntil = Math.max") < fn.indexOf("shouldRetryGuesty429(res.status"));
check("each attempt re-enters the serialized gate (never a raw sleep-and-refire)",
  (fn.match(/await waitForGuestyRequestSlot\(\)/g) ?? []).length === 1 &&
  fn.indexOf("for (let attempt") < fn.indexOf("await waitForGuestyRequestSlot()"));
check("exhausted retries still throw the classified error (status + rateLimited intact)",
  fn.includes("err.rateLimited = res.status === 429") && fn.includes("err.status = res.status"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
