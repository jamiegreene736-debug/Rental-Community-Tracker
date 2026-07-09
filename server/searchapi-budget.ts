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
  const used = Number(account?.current_month_usage);
  const allowance = Number(account?.monthly_allowance);
  const remaining = Number(account?.remaining_credits);
  if (!Number.isFinite(allowance) || allowance <= 0 || !Number.isFinite(remaining)) return null;
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
  return snapshot.remaining <= minCredits;
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

// ---------------------------------------------------------------------------
// App singletons (fetch-backed; not exercised by unit tests).

// One shared circuit for the fetch-unit-photos discovery SERP queries. Scoped
// to that path on purpose — other SearchAPI consumers (Lens photo scans,
// market pricing) have their own budgets and failure semantics.
export const searchApiDiscoveryCircuit = createSearchApiCircuit();

const QUOTA_PROBE_TTL_MS = 5 * 60_000;
let quotaProbe: { snapshot: SearchApiQuotaSnapshot | null; at: number } | null = null;

export async function getSearchApiQuota(force = false): Promise<SearchApiQuotaSnapshot | null> {
  const key = process.env.SEARCHAPI_API_KEY;
  if (!key) return null;
  const at = Date.now();
  if (!force && quotaProbe && at - quotaProbe.at < QUOTA_PROBE_TTL_MS) return quotaProbe.snapshot;
  try {
    const resp = await fetch(`https://www.searchapi.io/api/v1/me?api_key=${key}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const snapshot = parseSearchApiQuota(await resp.json(), at);
    quotaProbe = { snapshot, at };
    return snapshot;
  } catch (e: any) {
    console.warn(`[searchapi-budget] quota probe failed (fail-open): ${e?.message ?? e}`);
    quotaProbe = { snapshot: null, at };
    return null;
  }
}
