# Sidecar worker delta: `zillow_photo_scrape`

When this PR (claude/sidecar-zillow-scrape) deploys, the server starts
enqueuing `zillow_photo_scrape` operations whenever Apify+ScrapingBee
both return zero photos for a Zillow URL (third-tier fallback inside
`scrapeListingPhotos`). Until you add a handler to your local
`~/Downloads/vrbo-sidecar/worker.mjs`, those requests will sit in
`pending` and time out at 90s — the server falls back to the existing
behavior gracefully, but you won't actually benefit from the
residential-IP scrape.

This doc describes the handler you need to add. **You only need to do
this once.** After that, every `zillow_photo_scrape` request the
server enqueues will be processed by your local Chrome.

## Where the handler goes

In `worker.mjs`, find the dispatch block that handles existing op
types — typically a `switch (job.opType)` or `if/else if` chain that
already covers `vrbo_photo_scrape`, `vrbo_search`, `pm_url_check`,
etc. Add a new branch right after `vrbo_photo_scrape`:

```js
} else if (job.opType === "zillow_photo_scrape") {
  result = await handleZillowPhotoScrape(page, job.params);
```

## The handler function

Add this near the existing `handleVrboPhotoScrape` function. It opens
the Zillow URL in your local Chrome, waits for `__NEXT_DATA__` to
hydrate (Zillow's React data blob), and extracts both photos and
property facts.

```js
async function handleZillowPhotoScrape(page, params) {
  const { url, maxPhotos = 40 } = params;
  if (!url || !/^https?:\/\/(www\.)?zillow\.com\//i.test(url)) {
    return { photos: [], facts: undefined };
  }

  // Navigate. Zillow detail pages are heavy — wait until network is
  // idle so the photo carousel finishes hydrating. 30s upper bound.
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

  // Some Zillow pages put the listing data behind an "I'm not a
  // robot" press-and-hold challenge on first load. We don't try to
  // solve it from JS — if the page didn't render the carousel within
  // the navigation budget, return empty and let the server fall
  // through.
  // Accept either of Zillow's two main DOM locations.
  await page
    .waitForSelector("#__NEXT_DATA__, ul[class*='photo']", { timeout: 15000 })
    .catch(() => null);

  // Pull __NEXT_DATA__ first — that's the structured-JSON blob with
  // photos array AND resoFacts (bedrooms/bathrooms/homeType/etc).
  // Falls back to scraping <img> tags and JSON-LD when __NEXT_DATA__
  // isn't there (rare).
  const result = await page.evaluate((cap) => {
    const out = { photos: [], facts: {} };
    const seen = new Set();
    const pushPhoto = (u) => {
      if (typeof u !== "string") return;
      if (!u.startsWith("http")) return;
      if (!/zillowstatic\.com|photos\.zillow\.com/.test(u)) return;
      if (seen.has(u)) return;
      seen.add(u);
      out.photos.push(u);
    };

    // Tier 1: __NEXT_DATA__
    try {
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd && nd.textContent) {
        const data = JSON.parse(nd.textContent);
        // Walk the payload depth-bounded looking for photos +
        // resoFacts — same shape the server's extractListingFacts
        // walks.
        const walk = (o, depth) => {
          if (depth > 10 || !o || typeof o !== "object") return;
          if (Array.isArray(o)) {
            for (const v of o) walk(v, depth + 1);
            return;
          }
          // Photos
          if (Array.isArray(o.responsivePhotos)) {
            for (const p of o.responsivePhotos) {
              const url =
                p?.mixedSources?.jpeg?.find?.((s) => s?.width >= 1024)?.url ??
                p?.mixedSources?.jpeg?.[0]?.url ??
                p?.url;
              if (url) pushPhoto(url);
              if (out.photos.length >= cap) return;
            }
          }
          if (Array.isArray(o.originalPhotos)) {
            for (const p of o.originalPhotos) {
              const url =
                p?.mixedSources?.jpeg?.find?.((s) => s?.width >= 1024)?.url ??
                p?.mixedSources?.jpeg?.[0]?.url ??
                p?.url;
              if (url) pushPhoto(url);
              if (out.photos.length >= cap) return;
            }
          }
          // Facts — first-found-wins per field
          if (out.facts.bedrooms == null && typeof o.bedrooms === "number" && o.bedrooms > 0 && o.bedrooms < 50) {
            out.facts.bedrooms = Math.round(o.bedrooms);
          }
          if (out.facts.bathrooms == null) {
            let b;
            if (typeof o.bathrooms === "number") b = o.bathrooms;
            else if (typeof o.bathroomsFloat === "number") b = o.bathroomsFloat;
            else if (typeof o.bathroomsFull === "number") {
              b = o.bathroomsFull
                + (typeof o.bathroomsHalf === "number" ? o.bathroomsHalf * 0.5 : 0)
                + (typeof o.partialBathrooms === "number" ? o.partialBathrooms * 0.5 : 0)
                + (typeof o.bathroomsThreeQuarter === "number" ? o.bathroomsThreeQuarter * 0.75 : 0)
                + (typeof o.bathroomsOneQuarter === "number" ? o.bathroomsOneQuarter * 0.25 : 0);
            } else if (typeof o.bathroomsTotalInteger === "number") b = o.bathroomsTotalInteger;
            if (typeof b === "number" && b > 0 && b < 50) {
              out.facts.bathrooms = Math.round(b * 2) / 2;
            }
          }
          if (out.facts.homeType == null) {
            if (typeof o.homeType === "string" && o.homeType.length > 0) out.facts.homeType = o.homeType;
            else if (typeof o.propertyTypeDimension === "string" && o.propertyTypeDimension.length > 0) out.facts.homeType = o.propertyTypeDimension;
          }
          if (out.facts.homeStatus == null && typeof o.homeStatus === "string" && o.homeStatus.length > 0) {
            out.facts.homeStatus = o.homeStatus;
          }
          if (out.facts.propertySubType == null && typeof o.propertySubType === "string" && o.propertySubType.length > 0) {
            out.facts.propertySubType = o.propertySubType;
          }
          if (out.facts.photoCount == null && typeof o.photoCount === "number" && o.photoCount >= 0 && o.photoCount < 1000) {
            out.facts.photoCount = o.photoCount;
          }
          for (const v of Object.values(o)) {
            if (out.photos.length >= cap) return;
            walk(v, depth + 1);
          }
        };
        walk(data, 0);
      }
    } catch (_) {}

    // Tier 2: visible <img> tags as a final fallback
    if (out.photos.length === 0) {
      for (const img of Array.from(document.querySelectorAll("img"))) {
        const src = img.src || img.getAttribute("data-src") || "";
        pushPhoto(src);
        if (out.photos.length >= cap) break;
      }
    }
    return out;
  }, maxPhotos);

  return {
    photos: result.photos.slice(0, maxPhotos),
    facts: Object.keys(result.facts).length > 0 ? result.facts : undefined,
  };
}
```

## Verifying it works

1. Save `worker.mjs` and restart the daemon.
2. On Railway, hit `/api/single-listing/find-clean-unit` with a community
   that's hitting Apify rate limits.
3. Check Railway logs for `[scrapeZillow] sidecar success: N photos`.
4. The sidecar dashboard at the top of the operator page should show
   the `zillow_photo_scrape` op type counter increment.

## Why this is heartbeat-gated

The server only enqueues a `zillow_photo_scrape` request when
`getHeartbeat().isOnline === true`. If your daemon is offline, the
server skips this fallback entirely — no requests pile up, no false
"sidecar online" claims. The behavior matches the existing
`pm_url_check` and `vrbo_search` ops, so you don't need to change
anything in the daemon's heartbeat logic.

## Cost / wall-time profile

- **Cost:** $0 — just operator's Chrome time.
- **Wall time:** ~15-30s typical for a Zillow detail page (heavier
  than VRBO listing cards). Hard cap 90s server-side.
- **Concurrency:** sidecar processes one job at a time; if multiple
  candidates need photos, they queue up. find-clean-unit doesn't
  hit the sidecar fallback for every candidate — only the ones
  where Apify+ScrapingBee both came up empty.
