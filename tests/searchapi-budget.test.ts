import {
  createConcurrencyLimiter,
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
  // remaining is reconciled to the canonical allowance - used (100000 - 100002 = -2),
  // NOT the raw remaining_credits (-70); both are negative so exhaustion is unchanged.
  check("parses the live /me shape", !!snap && snap.used === 100002 && snap.allowance === 100000 && snap.remaining === -2);
  check("exhausted at negative remaining", searchApiQuotaExhausted(snap, 25));
  check("describe is human-readable", !!snap && /100,002\/100,000/.test(describeSearchApiQuota(snap)), snap && describeSearchApiQuota(snap));

  // REGRESSION (2026-07-18): the live 35k-key /me reported a bogus "0 remaining"
  // that contradicted 3,401/35,000 used. Reconciliation must trust allowance -
  // used (31,599 remaining) so the key reads HEALTHY and never falsely blocks.
  const contradictory = parseSearchApiQuota({ account: { current_month_usage: 3401, monthly_allowance: 35000, remaining_credits: 0 } }, 0);
  check("contradictory remaining_credits=0 reconciles to allowance - used", !!contradictory && contradictory.remaining === 31599);
  check("contradictory quota is NOT exhausted (fixes the false block)", !searchApiQuotaExhausted(contradictory, 25));

  const healthy = parseSearchApiQuota({ account: { current_month_usage: 10, monthly_allowance: 100000, remaining_credits: 99990 } }, 0);
  check("healthy quota not exhausted", !searchApiQuotaExhausted(healthy, 25));
  check("threshold boundary: remaining == min is exhausted", searchApiQuotaExhausted(parseSearchApiQuota({ account: { monthly_allowance: 100, remaining_credits: 25 } }, 0), 25));
  check("threshold boundary: remaining just above min is fine", !searchApiQuotaExhausted(parseSearchApiQuota({ account: { monthly_allowance: 100, remaining_credits: 26 } }, 0), 25));

  check("malformed payload parses to null (fail-open)", parseSearchApiQuota({ nope: true }, 0) === null);
  check("null snapshot is never exhausted (fail-open)", !searchApiQuotaExhausted(null, 25));

  // The live 2026-07-09 shape of the second rotation key: a subscription plan
  // reports remaining_credits: 0 (the unused prepaid balance) while the real
  // monthly allowance has 34,971/35,000 free — searches succeed. It must NOT be
  // read as exhausted, or the bulk-combo gate would false-block on a healthy key.
  const planKey = parseSearchApiQuota(
    { account: { current_month_usage: 29, monthly_allowance: 35000, remaining_credits: 0 } },
    0,
  );
  check("plan key: remaining_credits 0 but allowance free -> NOT exhausted", !searchApiQuotaExhausted(planKey, 25), planKey);
  check(
    "plan key becomes exhausted when the monthly allowance is spent",
    searchApiQuotaExhausted(
      parseSearchApiQuota({ account: { current_month_usage: 34999, monthly_allowance: 35000, remaining_credits: 0 } }, 0),
      25,
    ),
  );
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

console.log("searchapi-budget: shared concurrency limiter");
await (async () => {
  const limiter = createConcurrencyLimiter(2);
  let inFlight = 0;
  let peak = 0;
  const order: number[] = [];
  const gate: Array<() => void> = [];
  const task = (id: number) =>
    limiter(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => gate.push(resolve));
      order.push(id);
      inFlight -= 1;
    });
  const all = Promise.all([task(1), task(2), task(3), task(4)]);
  await new Promise((r) => setTimeout(r, 10));
  check("only max slots start immediately", gate.length === 2 && limiter.stats().queued === 2, limiter.stats());
  gate.shift()!();
  await new Promise((r) => setTimeout(r, 10));
  check("releasing a slot admits the next waiter (FIFO)", gate.length === 2);
  while (gate.length) gate.shift()!();
  await new Promise((r) => setTimeout(r, 10));
  while (gate.length) gate.shift()!();
  await all;
  check("never exceeds max concurrency", peak === 2, peak);
  check("all tasks complete", order.length === 4, order);

  // A throwing task must release its slot.
  const limiter2 = createConcurrencyLimiter(1);
  let threw = false;
  try {
    await limiter2(async () => {
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  let ran = false;
  await limiter2(async () => {
    ran = true;
  });
  check("a throwing task releases its slot", threw && ran);
})();

console.log(`\nsearchapi-budget: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
