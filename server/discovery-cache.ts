// Discovery caches (2026-07-09) — pure, zero-dep leaf module (unit-tested in
// tests/discovery-cache.test.ts).
//
// Live root cause on the 2026-07-08 Oahu bulk-combo sweep (bcj_mrco70f7): the
// photo discovery loop re-scraped the SAME listing URL 8-20x within one job
// (exact + relaxed passes x unit A/B x 3 attempts x operator retry-failed) and
// re-fired the SAME SearchAPI queries each pass. That repetition (a) burned the
// entire 100k/month SearchAPI allowance (8,398 queries in ONE hour) and
// provoked portal 429s/bot-walls, and (b) LOST galleries that had already been
// won — one Redfin unit scraped 25 photos at 23:55 and 0 on every later call,
// so the item failed on a 1-photo thin match even though the full gallery had
// been in hand minutes earlier.
//
// Two caches fix the two halves:
//  - createKeepBetterScrapeCache: per-listing scrape results, keyed by the
//    caller's canonical listing key. KEEP-BETTER is the load-bearing rule — a
//    later, worse re-scrape (bot-walled to 0-1 photos) must NEVER downgrade a
//    cached gallery. Full galleries live long (24h); thin results live short
//    (45min) so a listing that was mid-publish or transiently walled gets
//    re-tried on later jobs. `sidecarTried` marks a thin entry whose sidecar
//    rescue already ran, so rescue credits aren't re-burned on the same URL
//    within the thin TTL.
//  - createSearchQueryCache: SERP rows per query string (6h TTL). Discovery
//    fires dozens of near-identical portal queries per resort per pass — the
//    organic results don't change pass-to-pass, only our budget does.
//
// Both caches are in-memory by design: a Railway deploy wipes them, which is
// fine — their job is de-duplicating WITHIN a job / same-day re-queues, not
// long-term storage (listings genuinely change day to day).

export type KeepBetterCacheEntry<T> = {
  result: T;
  photoCount: number;
  at: number;
  sidecarTried: boolean;
};

export function createKeepBetterScrapeCache<T>(opts: {
  now?: () => number;
  cap?: number;
  fullTtlMs?: number;
  thinTtlMs?: number;
  minFullPhotos?: number;
} = {}) {
  const now = opts.now ?? Date.now;
  const cap = opts.cap ?? 500;
  const fullTtlMs = opts.fullTtlMs ?? 24 * 60 * 60 * 1000;
  const thinTtlMs = opts.thinTtlMs ?? 45 * 60 * 1000;
  const minFullPhotos = opts.minFullPhotos ?? 3;
  const entries = new Map<string, KeepBetterCacheEntry<T>>();
  const ttlFor = (entry: KeepBetterCacheEntry<T>) =>
    entry.photoCount >= minFullPhotos ? fullTtlMs : thinTtlMs;

  const get = (key: string): KeepBetterCacheEntry<T> | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() - entry.at > ttlFor(entry)) {
      entries.delete(key);
      return null;
    }
    // LRU bump (Map preserves insertion order).
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };

  const remember = (
    key: string,
    result: T,
    photoCount: number,
    o: { sidecarTried?: boolean } = {},
  ): KeepBetterCacheEntry<T> => {
    const existing = get(key);
    if (existing && existing.photoCount > photoCount) {
      // KEEP-BETTER: a worse re-scrape never downgrades a cached gallery. The
      // sidecarTried flag still accumulates so a failed rescue isn't repeated.
      existing.sidecarTried = existing.sidecarTried || !!o.sidecarTried;
      return existing;
    }
    const entry: KeepBetterCacheEntry<T> = {
      result,
      photoCount,
      at: now(),
      sidecarTried: (existing?.sidecarTried ?? false) || !!o.sidecarTried,
    };
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > cap) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return entry;
  };

  return { get, remember, size: () => entries.size };
}

export function createSearchQueryCache<T>(opts: {
  now?: () => number;
  cap?: number;
  ttlMs?: number;
} = {}) {
  const now = opts.now ?? Date.now;
  const cap = opts.cap ?? 1500;
  const ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
  const entries = new Map<string, { result: T; at: number }>();

  const get = (key: string): T | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() - entry.at > ttlMs) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.result;
  };

  const remember = (key: string, result: T): void => {
    entries.delete(key);
    entries.set(key, { result, at: now() });
    while (entries.size > cap) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return { get, remember, size: () => entries.size };
}
