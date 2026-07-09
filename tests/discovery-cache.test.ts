import { createKeepBetterScrapeCache, createSearchQueryCache } from "../server/discovery-cache";

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

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

console.log("discovery-cache: keep-better scrape cache");
{
  let now = Date.parse("2026-07-09T00:00:00Z");
  const cache = createKeepBetterScrapeCache<{ tag: string }>({
    now: () => now,
    cap: 3,
    fullTtlMs: 24 * HOUR,
    thinTtlMs: 45 * MIN,
    minFullPhotos: 3,
  });

  check("miss on empty cache", cache.get("a") === null);

  // The live 2026-07-08 failure shape: 25 photos won once, then bot-walled
  // re-scrapes returning 0-1. Keep-better must preserve the 25.
  cache.remember("a", { tag: "full-25" }, 25);
  check("full gallery cached", cache.get("a")?.result.tag === "full-25");
  cache.remember("a", { tag: "walled-0" }, 0);
  check("worse re-scrape never downgrades the cached gallery", cache.get("a")?.result.tag === "full-25");
  check("photoCount stays at the better result", cache.get("a")?.photoCount === 25);
  cache.remember("a", { tag: "better-30" }, 30);
  check("strictly better result replaces", cache.get("a")?.result.tag === "better-30");

  // Thin entries: short TTL so a transiently-walled listing is retried later.
  cache.remember("thin", { tag: "thin-1" }, 1);
  now += 30 * MIN;
  check("thin entry alive inside thin TTL", cache.get("thin")?.result.tag === "thin-1");
  now += 20 * MIN;
  check("thin entry expires after thin TTL", cache.get("thin") === null);

  // Full entries: long TTL.
  now = Date.parse("2026-07-09T00:00:00Z");
  const cache2 = createKeepBetterScrapeCache<{ tag: string }>({ now: () => now, minFullPhotos: 3 });
  cache2.remember("f", { tag: "full" }, 10);
  now += 12 * HOUR;
  check("full entry alive at 12h", cache2.get("f") !== null);
  now += 13 * HOUR;
  check("full entry expires after 24h", cache2.get("f") === null);

  // sidecarTried accumulates and survives keep-better rejection.
  const cache3 = createKeepBetterScrapeCache<{ tag: string }>({ now: () => now });
  cache3.remember("s", { tag: "thin" }, 1, { sidecarTried: true });
  check("sidecarTried recorded", cache3.get("s")?.sidecarTried === true);
  cache3.remember("s", { tag: "thin2" }, 1);
  check("sidecarTried sticky across re-remember", cache3.get("s")?.sidecarTried === true);
  cache3.remember("s", { tag: "worse" }, 0, { sidecarTried: true });
  check("keep-better rejection still keeps entry", cache3.get("s")?.result.tag === "thin2");

  // LRU cap: oldest evicted.
  const lru = createKeepBetterScrapeCache<{ tag: string }>({ now: () => now, cap: 2 });
  lru.remember("x", { tag: "x" }, 5);
  lru.remember("y", { tag: "y" }, 5);
  lru.get("x"); // bump x
  lru.remember("z", { tag: "z" }, 5);
  check("LRU evicts least-recently-used (y)", lru.get("y") === null && lru.get("x") !== null && lru.get("z") !== null);
}

console.log("discovery-cache: search query cache");
{
  let now = Date.parse("2026-07-09T00:00:00Z");
  const serp = createSearchQueryCache<Array<{ link: string }>>({ now: () => now, ttlMs: 6 * HOUR, cap: 2 });
  check("miss on empty cache", serp.get("q1") === null);
  serp.remember("q1", [{ link: "https://a" }]);
  check("hit returns cached rows", serp.get("q1")?.[0]?.link === "https://a");
  now += 5 * HOUR;
  check("alive inside TTL", serp.get("q1") !== null);
  now += 2 * HOUR;
  check("expires after TTL", serp.get("q1") === null);

  serp.remember("a", [{ link: "a" }]);
  serp.remember("b", [{ link: "b" }]);
  serp.get("a");
  serp.remember("c", [{ link: "c" }]);
  check("LRU cap evicts oldest", serp.get("b") === null && serp.get("a") !== null && serp.get("c") !== null);
}

console.log(`\ndiscovery-cache: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
