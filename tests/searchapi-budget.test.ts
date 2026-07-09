import {
  createSearchApiCircuit,
  describeSearchApiQuota,
  parseSearchApiQuota,
  searchApiQuotaExhausted,
} from "../server/searchapi-budget";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
};

console.log("searchapi-budget: quota parsing");
{
  // The exact live payload shape from 2026-07-09 (quota blown mid-sweep).
  const live = {
    account: { current_month_usage: 100002, monthly_allowance: 100000, remaining_credits: -70 },
    api_usage: { searches_this_hour: 8398, hourly_rate_limit: 20000 },
  };
  const snap = parseSearchApiQuota(live, 1000);
  check("parses the live /me shape", !!snap && snap.used === 100002 && snap.allowance === 100000 && snap.remaining === -70);
  check("exhausted at negative remaining", searchApiQuotaExhausted(snap, 25));
  check("describe is human-readable", !!snap && /100,002\/100,000/.test(describeSearchApiQuota(snap)), snap && describeSearchApiQuota(snap));

  const healthy = parseSearchApiQuota({ account: { current_month_usage: 10, monthly_allowance: 100000, remaining_credits: 99990 } }, 0);
  check("healthy quota not exhausted", !searchApiQuotaExhausted(healthy, 25));
  check("threshold boundary: remaining == min is exhausted", searchApiQuotaExhausted(parseSearchApiQuota({ account: { monthly_allowance: 100, remaining_credits: 25 } }, 0), 25));
  check("threshold boundary: remaining just above min is fine", !searchApiQuotaExhausted(parseSearchApiQuota({ account: { monthly_allowance: 100, remaining_credits: 26 } }, 0), 25));

  check("malformed payload parses to null (fail-open)", parseSearchApiQuota({ nope: true }, 0) === null);
  check("null snapshot is never exhausted (fail-open)", !searchApiQuotaExhausted(null, 25));
}

console.log("searchapi-budget: 429 circuit breaker");
{
  let now = 0;
  const circuit = createSearchApiCircuit({ threshold: 3, cooldownMs: 5 * 60_000, now: () => now });
  check("closed initially", !circuit.isOpen());
  circuit.record429();
  circuit.record429();
  check("stays closed below threshold", !circuit.isOpen());
  circuit.record429();
  check("opens at threshold", circuit.isOpen());

  // A success resets everything.
  circuit.recordOk();
  check("recordOk closes and resets", !circuit.isOpen() && circuit.state().consecutive429s === 0);

  // Open, then cooldown elapses → half-open: one probe allowed, one more 429
  // re-opens immediately.
  circuit.record429();
  circuit.record429();
  circuit.record429();
  check("re-opened", circuit.isOpen());
  now += 5 * 60_000;
  check("half-open after cooldown (probe allowed)", !circuit.isOpen());
  circuit.record429();
  check("single 429 during half-open re-opens", circuit.isOpen());
  now += 5 * 60_000;
  circuit.recordOk();
  check("successful probe closes for good", !circuit.isOpen());
}

console.log(`\nsearchapi-budget: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
