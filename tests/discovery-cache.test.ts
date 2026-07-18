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

// ── Source locks: operator nocache bypass + "Find new photos" wiring (2026-07-10) ──
// The caches above are LOAD-BEARING for the bulk-combo queue (SearchAPI budget +
// keep-better). Operator-initiated preflight buttons must BYPASS the cache READS
// (a deliberate retry must hit live portals) while still remembering results.
// These greps lock the wiring so a refactor can't silently re-cache the buttons
// or re-enable the relaxed "any"-bedroom rung when replacing a real gallery.
console.log("discovery-cache: nocache / find-new-source wiring (source locks)");
{
  const fs = await import("node:fs");
  const routes = fs.readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  check("fetch-unit-photos accepts nocache",
    /const bypassDiscoveryCaches = nocache === true;/.test(routes));
  check("SERP cache read gated by nocache",
    /bypassDiscoveryCaches \? null : discoverySerpCache\.get\(q\)/.test(routes));
  check("scrape cache read gated by nocache",
    /bypassDiscoveryCaches \? null : listingScrapeCache\.get\(clusterKey\)/.test(routes));
  check("new cluster mirrors are tried without discarding the stable cached winner",
    /const newlyDiscoveredMirrorUrls = cachedScrape/.test(routes)
      && /cachedScrape\.result\.dual\.photos\.length >= freshDual\.photos\.length/.test(routes)
      && /mirrorKeys: Array\.from\(new Set\(/.test(routes));
  check("photo-fetch-jobs route forwards findNewSource",
    /findNewSource: body\.findNewSource === true,/.test(routes));

  const job = fs.readFileSync(new URL("../server/preflight-background-jobs.ts", import.meta.url), "utf8");
  check("re-pull leg sends nocache", (job.match(/nocache: true,/g) ?? []).length >= 2);
  // 2026-07-17: the operator "Find new photos" button became the sameUnitOnly
  // hunt, which NEVER falls into discovery — but plain findNewSource (the Unit
  // Audit Sweep's find-new-source rung) must keep enabling discovery despite
  // existing photos.
  check("find-new mode enables discovery despite existing photos (same-unit hunt opts out)",
    /allowDiscoveryFallback = \(!replacingExistingPhotos \|\| findNewSource\) && !sameUnitMode;/.test(job));
  check("find-new mode drops the relaxed any-bedroom rung",
    /\.filter\(\(a\) => !findNewSource \|\| a\.bedrooms !== "any"\)/.test(job));
  check("find-new mode skips the saved-listing rescrape",
    /const rescrapeSourceUrl = !findNewSource\s*&&/.test(job));
  check("find-new failure keeps the existing gallery",
    /Kept the existing gallery and source\./.test(job));
  check("find-new + static modes reject thin galleries BEFORE persist (persist replaces the folder first)",
    /const minAcceptable = findNewSource \|\| staticFolderMode \? MIN_INDEPENDENT_UNIT_PHOTOS : 1;/.test(job)
    && /nextPhotos\.length >= minAcceptable && nextProof\.status !== "rejected"/.test(job));

  const page = fs.readFileSync(new URL("../client/src/pages/builder-preflight.tsx", import.meta.url), "utf8");
  check("preflight page has the Find new photos button",
    /button-find-new-photos-/.test(page) && /Find new photos/.test(page));
  check("button starts the job in findNewSource mode",
    /handleScrapePhotosForUnit\(i === 0 \? 0 : 1, unit[^,]*, \{ findNewSource: true \}\)/.test(page));
  check("find-new payload excludes the current source and skips rescrape",
    /\(replacingExistingPhotos \|\| findNewSource\) && currentSourceUrl/.test(page)
    && /!findNewSource && replacingExistingPhotos && currentSourceUrl/.test(page));
}

// ── Source locks: STATIC builder properties get the same per-unit photo buttons
// (2026-07-10 follow-up). The Photo Sources card — home of "Find new photos" —
// was promoted-drafts-only, so a static property's preflight (e.g. Kaha Lani)
// had NO per-unit photo buttons at all. Now: the card renders on every
// preflight page; static rows act on the unit's ACTIVE folder (replacement
// folder once swapped) — "Re-pull all photos" delegates to the existing
// per-folder rescrape job, while "Find new photos" / empty-folder discovery
// runs the photo-fetch job, which persists via rescrape-unit-photos
// (targetFolder) since there is no draft row to persist through.
console.log("discovery-cache: static-property Photo Sources wiring (source locks)");
{
  const fs = await import("node:fs");
  const page = fs.readFileSync(new URL("../client/src/pages/builder-preflight.tsx", import.meta.url), "utf8");
  check("Photo Sources card renders for static properties (not draft-gated)",
    page.includes('data-testid="card-photo-sources"')
    && !/\{isPromotedDraft &&\s*\(\s*<Card className="p-6 mb-6" data-testid="card-photo-sources">/.test(page));
  check("handleScrapePhotosForUnit no longer bails on static ids",
    !page.includes("if (id >= 0 || !property) return; // promoted drafts only")
    && page.includes("const isDraft = id < 0;"));
  check("static Re-pull delegates to the existing per-folder rescrape job",
    page.includes("void startRescrapeJob(activeFolder);"));
  check("static photo-fetch payload carries the unit's ACTIVE folder",
    page.includes("targetFolder: isDraft ? undefined : activeFolder,"));
  check("row buttons reflect a live rescrape job on the unit's folder",
    /const isRescrapingThisUnit = !!\(unitFolder && rescrapeJobIdsByFolder\[unitFolder\]\);/.test(page)
    && /const unitBusy = isScrapingThisUnit \|\| isRescrapingThisUnit;/.test(page));
  check("static sibling exclusion resolves the sibling's ACTIVE folder",
    page.includes("loadSourceUrl(isDraft ? u.photoFolder : (unitOverrides[u.id]?.photoFolder ?? u.photoFolder))"));
  check("static rows count the ACTIVE folder on disk, never the (absent) static photos array",
    /unitOverrides\[unitId\]\?\.photoFolder \|\| id >= 0/.test(page)
    && /\?\? \(id >= 0 \? \(\(u as any\)\.photoFolder as string \| undefined\) : undefined\)/.test(page));

  const job = fs.readFileSync(new URL("../server/preflight-background-jobs.ts", import.meta.url), "utf8");
  check("photo-fetch input declares the static targetFolder",
    /targetFolder\?: string;/.test(job));
  check("static persist goes through rescrape-unit-photos (single-writer folder path)",
    /const staticFolderMode = !\(input\.draftId > 0\);/.test(job)
    && /if \(staticFolderMode\) \{/.test(job)
    && job.includes('postJson(`${base}/api/builder/rescrape-unit-photos`'));
  check("static persist enforces the MIN gallery floor",
    /savedStatic < MIN_INDEPENDENT_UNIT_PHOTOS/.test(job));
  check("draft persist path is untouched",
    job.includes("/api/community/${input.draftId}/persist-photos"));

  const routes = fs.readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  check("photo-fetch-jobs route accepts static mode (propertyId + targetFolder)",
    routes.includes("targetFolder required for a static property photo fetch")
    && routes.includes("targetFolder: targetFolder || undefined,"));
}

console.log(`\ndiscovery-cache: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
