# Repliers.com Integration Research for Rental Community Tracker (NexStay)

**Date:** 2026-06 (research session)
**Branch:** claude/repliers-photos-integration
**Researcher:** Grok (via tools + code inspection)
**Context:** User query to investigate current property photo sourcing (believed Zillow-centric) and evaluate integrating repliers.com MLS API for addresses + photos + Google reverse-image (Lens) flow for OTA duplicate detection / clean unit qualification.

## Current Photo Sourcing & Usage (as of main)

### Primary Sources for Unit Photos
- **Zillow** (dominant): 
  - Discovery: SearchAPI Google `site:zillow.com "Community" City State` + Apify Zillow search actors (igolaizola~zillow-scraper-ppe etc.) for city-wide / high-volume.
  - Scrape: `scrapeListingPhotos` in `server/routes.ts:3361`
    - Tier 1: Apify (APIFY_ZILLOW_ACTOR, default maxcopell~zillow-detail-scraper) — `scrapeZillowViaApify`
    - Tier 2: ScrapingBee (when Apify 0 photos)
    - Tier 3: Local residential Chrome sidecar (`scrapeZillowPhotosViaSidecar` via vrbo-sidecar-queue, heartbeat-gated, 25s wallet for loops / 90s default). See Load-Bearing #41.
  - Photo extraction: strict `extractOrderedPhotosFromListingItem` (reads `responsivePhotos`, `originalPhotos`, `photos`, hdpData paths only; no greedy walk over whole payload — per Load-Bearing #1 in AGENTS.md). Preserves Zillow order.
- **Realtor.com** (added ~2026-05): parallel tiers (Apify primary `dz_omar~realtor-scraper`, direct fetch JSON-LD+regex, ScrapingBee last). Similar extraction. See CODEX notes in routes.ts around 3385+.
- Generic real estate hosts fallback (Redfin/homes.com etc. via fetch or Playwright).

See:
- `server/routes.ts:3473` (Zillow branch in scrapeListingPhotos)
- `server/routes.ts:2627` (scrapeZillowViaApify)
- `server/routes.ts:2545` (extract photos)
- `server/routes.ts:29299` (discovery in find-clean-unit, now Zillow + Realtor)
- `server/grok-single-listing-consult.ts` (prior Grok brief that led to Realtor + sidecar + verify-first diversification)

### How Photos Are Used
1. **Candidate Discovery + Qualification (Single-Listing Wizard)**:
   - `/api/single-listing/find-clean-unit` (routes.ts:29218, streaming NDJSON)
   - Discovers candidates → prefilter OTA address index (verify-then-discover, Load-Bearing #42) → cheap text OTA qualify → scrape (only clean ones) → facts/BR gate + photoCount >=3 → full `runOtaQualifier` (with photos for Lens).
   - `runOtaQualifier` (28950): text SearchAPI Google site: per platform + `runPhotoReverseSearch` (28880) on up to first 3 photos.
   - `runPhotoReverseSearch`: uses SearchAPI `engine=google_lens` directly on public Zillow CDN URLs (no upload needed). Requires >=2 distinct strong photo matches to count as "listed" on a platform. Filters via `isStrongLensMatch` + guardrails in `photo-match-guardrails.ts`.
   - Result feeds "clean" unit + photos into draft for builder.

2. **Combo Preflight Platform-Check** (`/api/preflight/platform-check`, routes:23683; also quick variant):
   - Uses **local disk photo folders** (previously scraped/curated Zillow photos under `/app/client/public/photos` or seeded).
   - For each unit's photos: read disk → base64 → upload to ImgBB (IMGBB_API_KEY) to make public → SearchAPI google_lens on the public URL.
   - Samples first 5 (or full audit mode), skips community/shared via `isCommunityOrSharedPhotoCandidate`.
   - Same Lens matching + island/guardrail filters.
   - Used in preflight Step to warn about units that visually match existing OTA listings (photo duplication risk).

3. **Photo Pipeline + Builder**:
   - `server/photo-pipeline.ts`: downloads scraped photos, labels via Claude vision (`photo-labeler.ts`), prioritizes by category (bedrooms first etc per CATEGORY_PRIORITY), renames to photo_00.jpg etc, persists labels.
   - Strict rules (see AGENTS.md Load-Bearing 1-9): no per-room caps (user curates), drops unlabeled after retries, preserves order, Apify-first not union, user overrides survive rescrape.
   - `PhotoCurator.tsx` etc in client for review/push to Guesty.

4. **Other**:
   - Buy-in / replacement flows also scrape listing photos for visual audit.
   - Community photos fetch (some static COMMUNITY_SOURCE_URLS point to Zillow).
   - Dashboard photo-match scanner (`photo-listing-scanner.ts`) uses local folders + Lens against OTAs.
   - `photo-match-guardrails.ts`, `photo-hashing.ts`, `photo-validator.ts` for dedupe/quality.

**Key invariants (AGENTS.md):**
- Zillow photo extractors whitelisted keys only.
- Preserve Zillow photo order (no category sort for final).
- Unlabeled after retry = dropped.
- Apify primary, SB fallback (no parallel union).
- Sidecar only when triggered + online.
- Dual text + photo Lens for qualify (text alone insufficient for standalone units).

No Repliers, no other MLS direct feeds currently. Heavy reliance on consumer portals (Zillow/Realtor) + scraping stack + SearchAPI proxy for discovery + Lens.

## Repliers.com Research

**What it is:** Developer-friendly MLS® / RESO data API. Provides live + sold listing data from multiple boards, normalized, with photos/media, statistics, AI features (image search, quality scores, cover image AI, estimates). "Real Estate Data Made Easy".

**Official site / resources:**
- https://repliers.com/ (AI search, image insights, property intelligence built-in)
- Docs: https://docs.repliers.io/ (has llms.txt for agents; Postman collection)
- Help: https://help.repliers.com/
- GitHub: https://github.com/Repliers-io (incl. MCP Server!)
- Request key: https://repliers.com/request-access (sandbox + trial real data, subject to MLS agreements)

**Coverage relevant to app (Hawaii + Florida vacation rentals):**
- Florida: 31 MLS boards documented (Stellar MLS, SEF MLS/Miami, BeachesMLS, realMLS, Emerald Coast, etc.). See https://repliers.com/mls-directory/florida/ and guides.
- Hawaii: Supported via Hawaii Information Service, Maui MLS etc (RESO members list references; Repliers claims broad US + Canada).
- Strong condo / residential focus; filters for class=condo, propertyType, style, etc.
- Active + unavailable/sold data (status, lastStatus, min/max soldDate etc).

**Key API surfaces (from docs + OpenAPI snippets):**
- `POST /listings` (main search, rich query params + JSON body for map/imageSearchItems):
  - Filters: city, state, neighborhood, streetName, streetNumber, unitNumber, zip, area, district, locationId, lat/long/radius, map (geoJSON), class=["condo"], propertyType, min/maxBedrooms, min/maxBaths, status=["A"], hasImages=true, lastStatus, listDate, mlsNumber, search (keyword), boardId (multi-board keys), etc.
  - Options: fields= (projection, e.g. images[10] to limit photos), resultsPerPage, pageNum, sortBy (updatedOnDesc etc), aggregates, statistics, cluster (map), coverImage= (AI pick e.g. "primary bedroom"), imageSearchItems (AI visual/text search).
  - Returns: listings[] with mlsNumber, address {streetNumber, unitNumber, streetName, city, state, zip, neighborhood, ...}, map {lat,lng}, listPrice, details {numBedrooms, numBathrooms, sqft, propertyType, style, yearBuilt, description, ...}, images: string[] (media refs/paths), photoCount, status, lastStatus, etc. Full single listing expands with history/comps.
- `GET /listings/{mlsNumber or addressKey?}` or single via search.
- Buildings search (`/buildings`): group by unique address (great for "community" / resort-level).
- Media / photos: images array + "advanced media repository and CDN" for delivery/optimization. (Need key-specific URL construction or additional media endpoints; sandbox examples show relative "sandbox/IMG-..."; production likely full CDN or signed.)
- Other: estimates (AI value), agents/offices, webhooks, NLP search (`/nlp`), favorites/saved searches (client side), places (schools etc).

**Auth:** Header `REPLIERS-API-KEY`. Per FAQ: requires licensed real estate agent / board access agreements. Sandbox available on key request.

**Pricing / notes:** Subscription or usage-based (not public in crawl; operator would know from portal). High performance (Elasticsearch). Built-in compliance/automation mentioned in marketing. Supports RESO Web API normalized data.

**Image specifics:**
- Has "Property Photo insights": AI categorize, enhance, analyze, quality scores for ranking in search.
- Dynamic optimization, CDN.
- AI Image Search: feed image or text ("White Kitchen") to filter listings.
- `coverImage` param for AI-selected hero from the set.

**Comparison to current Zillow/Realtor path:**
- Zillow/Realtor: consumer-facing portals (scraped via 3rd party actors + proxies). Photos rehosted, sometimes incomplete or variant. Anti-bot heavy (hence tiers + sidecar). Good for off-market / for-sale visibility + consumer photos.
- Repliers: direct MLS feed (authoritative for listed properties). Structured, consistent schema across boards, full facts + mandated photos. Less anti-bot (API). May miss non-MLS or delisted inventory. Photos are the listing's official media.

## Proposed Integration: User's Idea + Analysis

User: "integrate repliers.com API as well? We can pull all addresses for the community, push them through repliers.com API, grab the photos from there and then push through Google reverse image search."

**Yes — strong fit.** This is a natural evolution of the "source diversification" item in the prior single-listing Grok consult (grok-single-listing-consult.ts:147: "End-to-end source diversification... alternative real-estate aggregators... MLS feeds").

### Value for "pull addresses + photos + Lens"
1. **Better candidate discovery for find-clean-unit / single-listing:**
   - Replace/augment Google site:zillow + Apify harvest with `POST /listings` filtered to resort (neighborhood or address.streetName from known COMMUNITY_FOLDER_TO_ADDRESS roots, city, state, class=condo, minBedrooms, hasImages=true, status=A or recent).
   - Get address + bedrooms/baths + images[] in one structured response. No fragile URL slug parsing or post-scrape HTML fallback.
   - Directly feed photos (if full public CDN URLs) or fetched images into the existing `runOtaQualifier(..., photoUrls)` + Lens path.
   - Result: faster, more reliable, cheaper (no Apify per candidate), higher quality facts/photos.

2. **Reverse image search (Lens) exactly as described:**
   - MLS photos are often the "source" images that get reused verbatim on Airbnb/VRBO listings by owners/PMs.
   - Running Lens on Repliers photos (upload via ImgBB if needed, or direct if crawlable) will surface OTA duplicates with high signal.
   - Can be used in:
     - Single qualify (already passes photoUrls).
     - Enhanced preflight/platform-check: given a unit's address (from draft), do a Repliers lookup by addressKey or street+unit+city, pull its MLS photos, Lens them (in addition to or instead of local folder photos).
     - New bulk "community inventory audit via MLS photos": for a resort, pull all relevant listings, for each run Lens + text checks, aggregate "which units are visually present on OTAs". Complements the folder-scanner (which only knows units we have local photos for).

3. **Photo sourcing for builder:**
   - For Repliers-sourced clean units, use their images[] directly (download to the unit's photo folder on volume, run through existing photo-pipeline for labeling/ordering/curate).
   - Potential win: Repliers images may be more consistent/professional; their AI insights could pre-seed labels or pick cover (map to our categories).
   - Still run Claude labeler for app-specific needs (Master Bedroom numbering, coalesce, reject community shots).

4. **Community-level "all addresses":**
   - Use /listings + /buildings to enumerate inventory at a resort (group by addressKey or neighborhood).
   - Cross with unit-builder-data or FOLDER_UNIT_TOKENS.
   - Great for dashboard stats ("X units on MLS for this community") or pre-populating single-listing bedroom options (beyond Claude research).

### Integration Points in Code (high level)
- New env: `REPLIERS_API_KEY` (optional; if unset, skip Repliers paths).
- New helpers (perhaps `server/repliers.ts` or colocated in routes.ts like other scrapers):
  - `searchRepliersListings(filters: {city, state, neighborhood?, streetName?, minBedrooms?, class:'condo', ...})`
  - `getRepliersListingPhotosAndFacts(mlsNumber or addressKey or full listing)` → {urls: string[], facts: {bedrooms, bathrooms, address, ...}, raw?}
  - URL construction for images (inspect real response; may be `https://cdn.repliers.io/...` or per-key media proxy; handle relative).
  - For Lens: if URLs not public/crawlable, mirror preflight (base64 or download → ImgBB).
- Wire into:
  - find-clean-unit discovery (parallel to Zillow/Realtor harvest; prefer Repliers when board-covered for the market).
  - runOtaQualifier path (already photo-aware).
  - /api/preflight/platform-check and photo platform-check (address → Repliers lookup → photos for Lens, as supplement).
  - scrapeListingPhotos? Or new `fetchPhotosForAddress(address, city, state)` that tries Repliers first (by parsed address), falls back to URL-based Zillow/Realtor.
  - community-inventory endpoint (add Repliers count).
  - Possibly new admin/ops endpoint to "audit resort via MLS photos".
- Facts merge: Repliers details are authoritative; prefer over scraped.
- Caching: listings change; cache short or use repliersUpdatedOn for polling.
- Error handling / fallbacks: always have Zillow path; Repliers board access may be partial.
- Cost/wallet: similar bounding as current (cap candidates, sample 3 photos for Lens).

### Pros
- **Diversification & robustness:** Less scraper flakiness (the #1 pain in consults and Load-Bearing notes). MLS API is "meant" for this.
- **Data quality:** Normalized beds/baths (half-bath precision already handled), full address, official photos. AI photo features are bonus (quality, categorization, search).
- **Exact user flow enablement:** "pull all addresses... grab the photos... push through Google reverse image search" — native fit for both sourcing and detection.
- **Coverage alignment:** App targets HI/FL condo resorts; Repliers has explicit boards there.
- **Future:** Could expand to sold data for comps, or use Repliers image AI to improve photo pipeline (e.g. pre-filter rejects).
- **Compliance:** Repliers markets "automated compliance"; app already has heavy compliance automation for Guesty/OTAs.

### Cons / Risks / Open Questions
- **Access:** Must have valid key + board permissions for the exact MLSes (e.g. for Kaha Lani / Poipu: specific HI board; Caribe Cove / FL resorts: Stellar or appropriate). Sandbox first. Licensed RE agent required per their FAQ.
- **Photo URLs for Lens:** Critical unknown — if images[] are not directly fetchable/public (like zillowstatic), every photo needs ImgBB step (cost + 1-2s + rate limit). Test with real key. Alternative: download server-side and use data: or temp public host.
- **Scope of listings:** MLS active listings = properties currently marketed for sale/lease. Not every rental unit in a resort will have an active MLS row (many are owner-managed rentals never "listed for sale", or in rental programs). Good for for-sale clean units and recent activity, but Zillow/Google still useful for broader/consumer visibility + some off-market. Hybrid.
- **Unit matching:** Resorts have unit numbers (109, Bldg 2 #339); MLS may list as "Unit 109" or specific address. Leverage existing `streetRootFromListingAddress`, `verificationTokensForFolder`, unitVerificationClaims.
- **Cost:** New paid API (in addition to SearchAPI, Apify, ImgBB, sidecar). Low-volume operator use should be fine, but audit.
- **Rate limits / pagination:** Use pageNum/resultsPerPage; for "all" in community, may need multiple pages or geo bounds.
- **Images in response:** Payload may limit images; use `fields=images[20]` or separate media fetch. Sandbox vs prod differ.
- **RESO nuances:** Some fields vary by board; code should be defensive (like current Zillow payload walkers).
- **Legal/ToS for reverse search:** Same as today (Lens on marketing photos to detect public OTA copies). MLS data has display rules (some fields "Y"/"N" for internet); respect permissions.display* .
- **Not replacement:** Keep Zillow/Realtor/sidecar as fallbacks. Repliers shines for listed properties in covered boards.

### Recommendations / Next Steps
1. **Prototype safely:** Add REPLIERS_API_KEY (optional). Implement `searchRepliersForResort` + photo extractor in a new file. Gate behind env.
2. **Start narrow:** 
   - Enhance `/api/single-listing/community-inventory` and find-clean-unit discovery with Repliers parallel call (for markets where key works).
   - Add Repliers photo source to a new `fetchUnitPhotosByAddress` helper; use in qualify flow.
   - Expose a diagnostic: POST /api/operations/repliers-lookup {community, city, state} returning sample listings + photo URLs + fact summary.
3. **For Lens flow:** Extend runPhotoReverseSearch or preflight photoSearch to accept "repliers" source (address-based lookup instead of folder).
4. **Test data:** Use attached_assets or known communities (Kaha Lani, Poipu Kai, Santa Maria, Caribe Cove) + operator's Repliers key for real calls.
5. **Update AGENTS.md / Load-Bearing if shipped:** e.g. "Repliers is primary structured source for board-covered markets; Zillow/Realtor for fallback + non-MLS inventory."
6. **Docs:** Add to railway env example, ops runbook.
7. **Wallet/observability:** Log source breakdown (repliers vs zillow etc) like existing diagnostics.
8. **MCP note:** Repliers has an official MCP server — interesting for future agentic tools, but not needed here.

**Overall verdict:** Excellent idea. Directly addresses pain points in current Zillow-heavy photo pipeline and detection. Aligns with prior architectural reviews. Feasible to add as parallel path without breaking existing. High leverage for "all addresses in community" + visual OTA matching use case. Recommend proceeding to a small proof-of-concept PR (fetch + basic integration in find-clean + one audit endpoint), using real key for validation on 1-2 HI/FL resorts.

**Code pointers for implementer:**
- Start in `server/routes.ts` near the other harvest* and scrape* functions.
- Mirror Realtor addition pattern (see 2026-05 CODEX notes).
- Reuse `runOtaQualifier`, `parseListingAddressFromUrl` (extend for Repliers address shape), photo guardrails.
- Add types in shared/ if needed.
- Respect Load-Bearing decisions around photo handling.

Research performed via:
- Local code grep/read on server/routes.ts, photo-*.ts, grok-*-consult.ts, AGENTS.md.
- GitHub MCP + web tools for Repliers public info, MLS coverage, API surface.
- No changes to runtime behavior in this research doc.

Next action: operator review + provide test Repliers key (if proceeding) → implement on branch → PR.
