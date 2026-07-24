// SearchAPI budget guard (2026-07-09) — quota probe + 429 circuit breaker.
// Pure decision logic is exported for tests (tests/searchapi-budget.test.ts);
// the fetch-backed singletons at the bottom are what the app wires in.
//
// Live root cause on the 2026-07-08 Oahu bulk-combo sweep (bcj_mrco70f7): the
// SearchAPI monthly allowance ran dry MID-RUN (100,002/100,000 used, -70
// remaining, resets Jul 19) so every discovery query 429'd — and the queue kept
// churning for hours, burning Apify credits and reporting the outage as
// "no for-sale listings were found" (indistinguishable from genuine scarcity).
// Two guards prevent a recurrence:
//  - getSearchApiQuota(): a cheap cached /me probe (does NOT consume search
//    credits). The bulk-combo runner checks it before each item and fails fast
//    with an explicit quota message instead of scraping into a dead wall.
//  - createSearchApiCircuit(): counts consecutive 429s across discovery
//    queries; once open, discovery skips further SearchAPI calls for a
//    cooldown (hourly rate-limit bursts recover on their own — the circuit
//    half-opens and probes again).
// Both are FAIL-OPEN: a probe error or missing key never blocks a search —
// only a POSITIVE "quota exhausted" reading does.

import { getSearchApiKeys } from "./searchapi";

export type SearchApiQuotaSnapshot = {
  used: number;
  allowance: number;
  remaining: number;
  fetchedAt: number;
};

export function searchApiMinCredits(): number {
  const raw = Number(process.env.SEARCHAPI_MIN_CREDITS ?? 25);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 25;
}

export function parseSearchApiQuota(payload: unknown, fetchedAt: number): SearchApiQuotaSnapshot | null {
  const account = (payload as any)?.account;
  const usedRaw = Number(account?.current_month_usage);
  const allowance = Number(account?.monthly_allowance);
  const creditsRemaining = Number(account?.remaining_credits);
  if (!Number.isFinite(allowance) || allowance <= 0) return null;

  // RECONCILE remaining (2026-07-18, operator: "should be rotating through two
  // keys"): SearchAPI's docs define remaining_credits = monthly_allowance -
  // current_month_usage, but some accounts return a remaining_credits that
  // CONTRADICTS that — e.g. the live 35k-key /me on 2026-07-18 read
  // {current_month_usage: 3401, monthly_allowance: 35000, remaining_credits: 0}
  // (3,401/35,000 used yet "0 remaining"). Trusting that bogus 0 made
  // searchApiQuotaExhausted fire on BOTH keys, so getSearchApiQuota's
  // healthiest-key pick still reported "quota exhausted" and the bulk-combo
  // preflight gate blocked every resort — even with ~31,599 searches left on the
  // 35k key and a fresh 100k rotation key. So derive the canonical remaining
  // from the two primitive counters and take the HEALTHIER of the two readings:
  // only report exhausted when EVERY signal agrees the plan is dry. This is
  // fail-open by design (the whole module's stated philosophy) — a contradictory
  // low remaining_credits can never again falsely block discovery, while a
  // genuinely over-quota account (allowance - used <= 0) still trips.
  const used = Number.isFinite(usedRaw)
    ? usedRaw
    : Number.isFinite(creditsRemaining)
      ? allowance - creditsRemaining
      : NaN;
  const usageRemaining = Number.isFinite(used) ? allowance - used : NaN;
  const candidates = [usageRemaining, creditsRemaining].filter((n) => Number.isFinite(n));
  if (candidates.length === 0) return null; // fail-open: no usable reading
  const remaining = Math.max(...candidates);

  return {
    used: Number.isFinite(used) ? used : allowance - remaining,
    allowance,
    remaining,
    fetchedAt,
  };
}

export function searchApiQuotaExhausted(
  snapshot: SearchApiQuotaSnapshot | null,
  minCredits: number = searchApiMinCredits(),
): boolean {
  if (!snapshot) return false; // fail-open: no reading, no block
  // Two independent "remaining" signals, because SearchAPI accounts report them
  // differently: a subscription plan tracks usage in current_month_usage against
  // monthly_allowance and leaves remaining_credits at 0 (that field is the
  // pay-as-you-go prepaid balance, unused on a plan), while a prepaid account
  // tracks remaining_credits directly. A key is only exhausted when BOTH the
  // prepaid balance AND the monthly-allowance headroom are spent — otherwise a
  // healthy plan key (remaining_credits: 0, but 34,971/35,000 allowance free)
  // would be wrongly read as dead and block discovery. Live-verified 2026-07-09
  // against the second rotation key, which searches fine at remaining_credits 0.
  const allowanceHeadroom = snapshot.allowance - snapshot.used;
  return snapshot.remaining <= minCredits && allowanceHeadroom <= minCredits;
}

export function describeSearchApiQuota(snapshot: SearchApiQuotaSnapshot): string {
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  return `${fmt(snapshot.used)}/${fmt(snapshot.allowance)} monthly searches used, ${fmt(snapshot.remaining)} remaining`;
}

export function createSearchApiCircuit(opts: {
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
} = {}) {
  const threshold = opts.threshold ?? 6;
  const cooldownMs = opts.cooldownMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  let consecutive429s = 0;
  let openedAt: number | null = null;
  return {
    record429(): void {
      consecutive429s += 1;
      if (consecutive429s >= threshold && openedAt === null) openedAt = now();
    },
    recordOk(): void {
      consecutive429s = 0;
      openedAt = null;
    },
    isOpen(): boolean {
      if (openedAt === null) return false;
      if (now() - openedAt >= cooldownMs) {
        // Half-open: allow the next real query through as a probe. One more
        // 429 re-opens immediately (counter parked at threshold - 1).
        openedAt = null;
        consecutive429s = threshold - 1;
        return false;
      }
      return true;
    },
    state(): { consecutive429s: number; openedAt: number | null } {
      return { consecutive429s, openedAt };
    },
  };
}

// Simple FIFO concurrency limiter (pure; unit-tested). SearchAPI producers
// used to fan out unbounded — on 2026-07-08 the bulk-combo sweep and a
// concurrent top-markets scan together fired 8,398 queries in one hour, each
// starving the other into 429s. One shared limiter puts a ceiling on the
// account-wide burst rate no matter how many jobs run at once.
export function createConcurrencyLimiter(maxConcurrent: number) {
  const max = Number.isFinite(maxConcurrent) && maxConcurrent >= 1 ? Math.floor(maxConcurrent) : 1;
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < max) {
        active += 1;
        resolve();
      } else {
        waiters.push(() => {
          active += 1;
          resolve();
        });
      }
    });
  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
  (run as any).stats = () => ({ active, queued: waiters.length, max });
  return run as (<T>(fn: () => Promise<T>) => Promise<T>) & { stats: () => { active: number; queued: number; max: number } };
}

// ---------------------------------------------------------------------------
// App singletons (fetch-backed; not exercised by unit tests).

// Shared across ALL SearchAPI producers that opt in (bulk-combo discovery,
// top-market research). Create the fetch's AbortSignal INSIDE the wrapped fn —
// a signal minted before the slot is acquired would count queue-wait time
// against the request timeout.
export const runWithSearchApiSlot = createConcurrencyLimiter(
  Number(process.env.SEARCHAPI_MAX_CONCURRENCY ?? 6),
);

// One shared circuit for the fetch-unit-photos discovery SERP queries. Scoped
// to that path on purpose — other SearchAPI consumers (Lens photo scans,
// market pricing) have their own budgets and failure semantics.
export const searchApiDiscoveryCircuit = createSearchApiCircuit();

const QUOTA_PROBE_TTL_MS = 5 * 60_000;
let quotaProbe: { snapshot: SearchApiQuotaSnapshot | null; at: number } | null = null;

async function probeSingleKeyQuota(key: string, at: number): Promise<SearchApiQuotaSnapshot | null> {
  const resp = await fetch(`https://www.searchapi.io/api/v1/me?api_key=${key}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return parseSearchApiQuota(await resp.json(), at);
}

// ROTATION-AWARE (2026-07-09): probes EVERY configured key (primary +
// SEARCHAPI_API_KEY_2…) and returns the HEALTHIEST snapshot — the one with the
// most remaining credits. This is what the bulk-combo gate keys off, so the
// queue is only blocked as "quota exhausted" when ALL keys are dry; a primary
// that hit its monthly cap no longer stalls discovery while a rotation key still
// has room. Still fail-open: probe errors / no keys never block.
export async function getSearchApiQuota(force = false): Promise<SearchApiQuotaSnapshot | null> {
  const keys = getSearchApiKeys();
  if (keys.length === 0) return null;
  const at = Date.now();
  if (!force && quotaProbe && at - quotaProbe.at < QUOTA_PROBE_TTL_MS) return quotaProbe.snapshot;
  const snapshots = await Promise.all(
    keys.map((key) =>
      probeSingleKeyQuota(key, at).catch((e: any) => {
        console.warn(`[searchapi-budget] quota probe failed (fail-open): ${e?.message ?? e}`);
        return null;
      }),
    ),
  );
  // Pick the key with the most remaining credits; a null (probe error) key wins
  // outright so a transient probe failure fails open rather than reporting a
  // sibling key's exhaustion.
  let best: SearchApiQuotaSnapshot | null = snapshots[0] ?? null;
  let sawNull = false;
  for (const snapshot of snapshots) {
    if (!snapshot) {
      sawNull = true;
      continue;
    }
    if (!best || snapshot.remaining > best.remaining) best = snapshot;
  }
  const snapshot = sawNull ? null : best;
  quotaProbe = { snapshot, at };
  return snapshot;
}
