# AGENTS.md — Contract between Claude Code, Codex, and the human operator

**Read this file in full before making changes.** It exists so multiple AI
tools (primarily Claude Code and Codex) can work on the same repo without
re-litigating design decisions every session. If you find yourself
about to "fix" something, check the Load-Bearing Decisions section first.

## Roles

| Actor | Responsibility | Writes code? | Merges? |
|---|---|---|---|
| **Claude Code** | Primary implementer. Builds features, fixes bugs, runs e2e verifications, commits on feature branches, opens PRs, and merges its own PRs once work is done. | Yes | Yes (admin override) |
| **Codex** | Reviewer and security auditor. Reads merged code, flags bugs / vulnerabilities / patterns. | No — comments/suggestions only | No |
| **Human operator (Jamie)** | Arbiter. Reviews post-hoc when desired, resolves disputes between tools, appends Decision Log entries. | Occasionally | Yes |

**Merge rule:** Claude Code merges its own PRs with
`gh pr merge <n> --squash --delete-branch --admin`. Main has branch
protection (required reviews + required checks `quality` /
`secret-scan` / `analyze`), but those checks aren't wired for
`claude/*` branches, so the admin override is the standing path.
The human can still revert or follow up — no one loses the ability
to catch problems. Codex review happens against merged code, not in
the way of merge. If Codex finds something, the human decides whether
to open a fix PR via Claude Code or accept the original decision.

## How to use this file

- **Before writing code**, scan the Load-Bearing Decisions. If your
  change contradicts one of them, pause and ask the human before
  proceeding.

## Build Hygiene (Load-Bearing — prevents repeated Railway/esbuild failures)

**Never append duplicate function declarations ("back-compat copies") at the bottom of a .ts file.**

A recent commit appended copies of `resolveAvailabilityPropertyConfig` and `getAvailabilitySchedulerUnsupportedReason` at the end of `server/availability-scheduler.ts` while the originals were still present. esbuild (used by `npm run build` → Railway) rejected the file with duplicate export errors.

See the machine-readable rule at `.cursor/rules/build-hygiene.mdc` for the full policy and verification steps (`npm run check && npm run build` must pass locally before pushing anything that touches schedulers/routes/shared pricing).

## VRBO / OTA Buy-In Search Policy (Load-Bearing)

**Never inject a pre-constructed `vrbo.com/search?...` URL (or any
parameterized deep link) when driving VRBO for buy-in, replacement,
alternative unit scouting, or live pricing flows.**

- VRBO flows must be 100% "sight + clicking": start at bare homepage,
  type into visible destination field (or vision-assisted click+type),
  select visible autocomplete suggestion, interact with visible date
  controls, click the visible Search button.
- Direct URL navigation for VRBO (even "realistic" ones via Apify,
  ScrapingBee, Browserbase, or manual `page.goto`) is the primary
  trigger for slider CAPTCHA that frequently remains blocking even
  after manual solve.
- The sidecar worker (`daemon/vrbo-sidecar/worker.mjs`) contains a hard
  runtime guard `assertSafeVrboNavigation` that will throw on any
  violation. All buy-in paths (find-buy-in, city-vrbo-inventory,
  replacement flows, etc.) must route VRBO exclusively
  through the sidecar visible-interaction path.
- Airbnb and Booking.com may use post-dropdown confirmed results URLs
  with date params (per historical policy), but VRBO is special-cased
  as zero-tolerance.

If a legacy scraper or debug tool (`apify-vrbo`, `browserbase-vrbo-search`,
etc.) is still reachable from a buy-in UI path, refactor it to the
sidecar or mark it explicitly deprecated for VRBO.

### VRBO city inventory export — full SRP pagination (Load-Bearing, 2026-06-05)

`/api/operations/city-vrbo-inventory` (`server/city-vrbo-inventory.ts` →
`searchVrboViaSidecar({cityWideInventory:true})`) exports a city's *entire*
VRBO inventory (~210 for Princeville), which spans ~5 SRP pages of 50. The
authoritative harvester is the **UI page walk** in
`walkVrboResultsUiPages` (`daemon/vrbo-sidecar/worker.mjs`): it clicks the
real blue Next control (`[data-stid="next-button"]`) and DOM-harvests each
page. Three constraints make it actually reach the full count — don't
"simplify" any of them away:

1. **GraphQL pagination must NOT advance the SRP for city-wide.**
   `paginateVrboGraphqlInventory` is called with `allowUiNext:false` when
   `exhaustiveCityExport`. VRBO's list-view GraphQL replay returns 0 rows, so
   letting it click UI-Next just walks the SRP forward *without harvesting* and
   the page walk then starts mid-list (the "151-200 of 210, only the tail" bug).
   Replay-only keeps the SRP on page 1 so the walk owns navigation.
2. **The page walk waits for the SRP to actually advance** after each Next
   click (`waitForVrboResultsPageAdvance` polls the visible "N-M of T" range
   until the start index increases), re-checks next-availability before
   concluding it's at the end (the control flickers during the async list swap),
   and stops cleanly on `range-end-reached` (end>=total). It scrolls the
   pagination footer into view (`scrollVrboResultsPaginationIntoView`) before
   harvesting each page so all 50 virtualized cards render — do NOT reset to the
   top instead (that only captured ~20/50).
3. **The date picker selects by month, not by bare day number.**
   `findVisibleDay` in `applyVrboVisibleCalendarDates` must disambiguate which
   of the two visible months a "20" belongs to (strict metadata → month-grid
   container → left→right column → offset slice). A number-only match clicks the
   current month's cell and the homepage form-guard then rejects the search.
4. **The city-wide destination is the TOWN, not the resort
   (`cityWideSearch` in `shared/buy-in-market.ts`, 2026-06-07).** VRBO's
   autocomplete resolves a resort name like `"Poipu Kai Resort, Koloa, Kauai,
   Hawaii"` to a tiny landmark region (`regionId 553248635976421921` ≈ 25
   listings, single page, no Next control) — NOT the town. The operator's
   reference search is `"Koloa, Hawaii"` (≈145). So `runCityVrboInventoryScan`
   uses `cityWideSearchLocationForBuyInMarket(community)`, which returns the
   per-market `cityWideSearch` override (Poipu Kai → `"Koloa, Hawaii"`) and
   falls back to `searchLocation` for markets that are already town-scoped
   (Princeville, Keauhou). The resort `searchLocation` is still correct for
   find-buy-in / replacement flows — don't repoint those at the town. Cache key
   is `city-vrbo-dropdown-v3` (bumped so v2 resort-scoped pools aren't reused).
5. **The page walk's `target-reached` stop is subordinate to the Next button,
   2026-06-07.** `walkVrboResultsUiPages` only honors the `targetTotal` hint as
   a stop reason when `isVrboResultsNextPageAvailable` is false. The total hint
   (`readVrboResultsTotalHint`) frequently mis-reads a stray small number (e.g.
   "25") before VRBO paints its "N-M of T" text, and trusting it short-circuited
   the walk on page 1 ("145 results, only 48 exported"). While the blue Next
   control is still clickable there ARE more pages. `range-end-reached` (visible
   "N-M of T") is authoritative; a `harvest-plateau` guard (2 consecutive pages
   adding ≤2 cards) backstops the case where the range text never renders and
   Next never disables. `readVrboResultsTotalHint` is also floored by the
   rendered lodging-card count so it can never under-count below what's on the
   page. Don't reinstate an unconditional `target-reached` break.
6. **Same-community pairing is cluster-first + multi-signal, not title-substring,
   2026-06-07 (`shared/city-vrbo-combo.ts`).** `suggestCityVrboComboPair`
   clusters the city pool by ANY same-community signal — a curated Kauai complex
   DICTIONARY (`KAUAI_COMPLEX_DICTIONARY`), the classic "X resort/villas/
   plantation" phrases, a complex-name-before-unit-number heuristic run over the
   TITLE ONLY (card snippets are full of price/booking boilerplate that pollutes
   it), plus photo-hash + property-manager hooks for later phases — then picks
   the cheapest pair matching the bedroom plan WITHIN one cluster. Keep the three
   precision guards: `STRUCTURAL_STOPWORDS` (bedroom/sleeps/price/photo…),
   `PLACE_STOPWORDS` (koloa/poipu/kauai alone), and the place+`TYPE_WORDS` reject
   ("kauai resort" out, "sheraton kauai resort" in). Dictionary regexes MUST be
   anchored — a greedy `kahala.*poipu` or bare `the cliffs` over-clusters
   unrelated listings (caught in review). `pickCheapestPlan` dedups by url so a
   SAME-bedroom plan (3BR+3BR) picks two DISTINCT units; the old
   `uniquePlan.length < 2` guard wrongly rejected same-bedroom plans entirely.
   Property-manager is the lowest-confidence signal and yields a pair only when
   walkability is independently confirmed (never PM-alone — one PM spans the
   whole town). Coordinates, when present, gate walkability via `pairIsWalkable`.
   **Typo tolerance + LLM recovery (2026-06-08, `shared/city-vrbo-combo.ts` +
   `server/city-vrbo-community-llm.ts`):** the dictionary now also matches via
   (a) curated per-entry `aliases` (token-bounded exact — known misspellings /
   abbreviations) and (b) FUZZY (Damerau-Levenshtein + Jaro-Winkler over
   EQUAL-token windows) — but fuzzy is applied ONLY to `FUZZY_SAFE_CANONICALS`,
   computed at load as the canonicals whose nearest same-token-count sibling is
   `>= DL 4`. **6 canonicals are EXACT-ONLY-UNSAFE** (poipu kai, poipu kapili,
   alii kai, alihi lani, pili mai, pono kai — each within DL 3 of a DIFFERENT
   real complex), so a typo of them is genuinely ambiguous and MUST be caught by
   the alias table, never fuzzy. The headline case **"Poipu Kie" → poipu kai
   lives in `aliases`, NOT in the fuzzy matcher.** Fuzzy thresholds
   (`FUZZY_JW_MIN=0.90`, `FUZZY_NDL_MAX=0.34`, `FUZZY_JW_MARGIN=0.06`) came from
   an exhaustive single-edit-typo sweep — the best-vs-second-best JW MARGIN
   (not the absolute thresholds) is the over-clustering guard; **do not drop the
   margin below 0.06** (0.05 leaked poipu-kai typos into poipu sands). Precision
   is locked by `tests/city-vrbo-combo.test.ts` (typo positives + cross-complex
   non-collisions) — run it after any dictionary/threshold change.
   `sharedResortPhraseKeys` now also consumes `CityVrboListing.complexName` (set
   by detail enrichment AND the LLM classifier) → dict/complex key; this is what
   finally makes the enrichment `complexName` (previously dead) cluster. The LLM
   classifier (`runCityScanCore`, gated `CITY_VRBO_LLM_COMMUNITY` + needs
   `ANTHROPIC_API_KEY`) runs ONLY as a NO-PAIR recovery step (never overrides a
   deterministic pair): one conservative Claude pass names each listing's
   specific complex (positive-ID only; "near X" != "in X"; generic → null; only
   `confidence:"high"`, bare-place/generic labels rejected). It sets
   `complexName`; **MUTUAL VALIDATION** (a label only pairs when >=2 listings
   share it) is enforced FOR FREE by the existing bucket-size `>= bedroomPlan.length`
   gate, so a single hallucinated label can never form a pair. Don't loosen the
   confidence gate or remove the bucket-size mutual-validation guard.
7. **The SRP harvest captures each card's hero image; SRP-level image matching is
   inert by design, 2026-06-07.** `harvestVrboMapResultCards` /
   `extractVisibleVrboCards` now grab the card `<img>` (VRBO CDN hosts only) so
   `image`/`images` flow through `normalizeSidecarCandidates` to the listing —
   this populates the relocation guest page (previously 0 photos for
   city-attached units). The matcher (`imageSignatureKeys` → `imgurl:` photo
   buckets, with a `looksLikeSameUnit` guard so a relisted unit isn't paired with
   itself) clusters listings that share a hero photo. Empirical finding: VRBO SRP
   card heroes are UNIT-specific (each unit's own interior), so listings
   essentially never share a hero — image clustering surfaces no new pairs at the
   SRP level. The shared amenity/exterior photos that actually identify a complex
   live in the DETAIL-page galleries; real image matching belongs with
   detail-page enrichment (a later phase), not the card hero. The `photoHashes`
   field + dHash hook (`server/photo-hashing.ts`) are wired for that. Don't
   re-add SRP-hero hashing expecting matching gains.
8. **Per-listing coordinates are NOT available cheaply for the city export; the
   map-view harvest was tried and abandoned, 2026-06-07.** Geo-clustering needs
   per-listing lat/lng, but the city-wide SRP list view exposes NONE: not on the
   DOM cards (`data-stid` only), not in GraphQL (list view fires
   `CollectionCarouselQuery`, `network=0`), not in `window.__APOLLO_STATE__` (3
   entries, only `ROOT_QUERY` — no `Listing` nodes), not in the HTML
   (`geoCode` count 0). A "Path A" map-view harvest WAS implemented and tested
   (open the map after the walk → let `networkCapture` absorb the map's GraphQL →
   merge coords by listing id): the map opened but yielded **`coordIds=0`** (its
   markers are tiles/clusters, not per-pin geoCode the parser can read) AND it
   added ~3 min (a 267s run — near Railway's ~5-min edge timeout). It was
   reverted. Conclusion: geo coordinates must come from **detail-page
   enrichment** (open each candidate's listing page — that page reliably has
   coords + the gallery + the exact complex/PM). Don't re-attempt SRP/map-view
   coordinate capture. The matcher (`pairIsWalkable`, `walkMinutesBetween`)
   already consumes `lat`/`lng` when present, so detail-page enrichment only has
   to populate them.
9. **Detail-page enrichment populates coords + galleries on a no-pair result,
   2026-06-07 (Phase 4).** When `suggestCityVrboComboPair` finds NO same-community
   pair, `runCityScanCore` opens the top-K cheapest plan-matching candidates'
   DETAIL pages via the existing `vrbo_photo_scrape` sidecar job (extended to also
   return `lat`/`lng`/`complexName`/`streetAddress` from JSON-LD → meta →
   `__APOLLO_STATE__`), attaches coords + gallery photos to the cached listings,
   and re-runs the matcher. The matcher geo-clusters via `buildGeoClusters`
   (union-find, ≤`MAX_BUY_IN_WALK_MINUTES`). Load-bearing details:
   - **Coords are authoritative ONLY for geo + property-manager clusters**
     (`pairWalkability`). For dictionary/complex/phrase/photo clusters the text/
     photo key is authoritative and noisy enrichment coords may only *annotate*,
     never *reject* the pair — otherwise a real "Point at Poipu 721/812" pair gets
     dropped on slightly-off coords (regression caught in review).
   - **Null-coord guard:** filters that test coordinates MUST check `!= null`
     before `Number()` — `Number(null) === 0` passes `isFinite` and would smear
     coordless listings to (0,0) (false clusters / zero enrichment targets).
   - Gated: only on no-pair, only if `!detailEnriched` (cached per pool), behind
     `CITY_VRBO_DETAIL_ENRICH` (default on), bounded (`CITY_VRBO_ENRICH_MAX`=8,
     budget 75s, concurrency 4), best-effort (a blocked/slow VRBO yields no coords
     → same as before, no throw). Don't make enrichment run on every scan.
   - **KNOWN LIMITATION (verified live 2026-06-07):** VRBO's Koloa detail pages
     returned a SHARED region centroid (`21.906666,-159.469162`) for ALL 5
     enriched listings — NOT per-listing coords. That would manufacture false
     "co-located" geo pairs, so a **region-centroid guard** strips the coords when
     the enriched set resolves to ≤1 distinct location (`distinctCoords <= 1` →
     null them, return 0). Net effect: geo-clustering is effectively a no-op on
     VRBO until a real per-listing coord source is found (VRBO appears to obscure
     exact location). The text signals (#6) remain the only reliable matcher.
     Couldn't fully diagnose the per-source coord (JSON-LD vs `__APOLLO_STATE__`)
     because VRBO was rate-limiting (scrapes degraded to 1 listing) — revisit when
     it cools. Do NOT trust enriched coords without re-confirming they're distinct.
   - **GEOCODING-THE-ADDRESS FALLBACK IS ALSO DEAD (probed 2026-06-07).** The
     proposed next step was: geocode a per-listing street address from the detail
     page. Probed 3 distinct complexes (Point at Poipu / Sunset Kahili / Kiahuna)
     and the detail pages exposed NO usable per-listing location at all: no
     JSON-LD `address`, no JSON-LD `geo`, no street address, no "located in"
     neighborhood text, no per-listing lat/lng in the HTML — only the same shared
     centroid coord again. VRBO obscures exact location END-TO-END (SRP, map, AND
     detail page). **Conclusion: geo-clustering is NOT achievable from VRBO's
     public data. Don't re-attempt SRP/map/detail coord capture OR address
     geocoding for VRBO.** The geo-cluster + enrichment plumbing stays (harmless,
     centroid-guarded, and ready if a non-VRBO coord source is ever wired). Text
     signals (#6) are the ceiling for VRBO same-community matching.

`exhaustiveCityHarvestAllSorts` (multi-sort union) remains a fallback for when
the walk still falls short, but it re-navigates `/search?...&sort=` URLs and so
is in tension with the zero-tolerance rule above — it should only fire rarely
and is a candidate to migrate onto the sight+click walk.

### Drive-time nearby-city combo expansion (Load-Bearing, 2026-06-07)

`server/city-vrbo-expansion.ts` adds a fourth rung to the buy-in combo ladder for
`>=2`-unit bookings: **resort search → home-city VRBO → cities within a 20-min
drive → cities within a 45-min drive**. It only fires after the home-city scan
runs with the sidecar ONLINE and finds NO same-community `suggestedPair`. It's a
background job the client (`autoFillMutation` in `client/src/pages/bookings.tsx`)
starts (`POST /api/operations/city-vrbo-inventory/expand`) and polls
(`GET …/expand/:jobId`); each nearby-city scan drives the sidecar for minutes, so
a synchronous request would blow Railway's edge timeout. Load-bearing choices —
don't "simplify" them away:

1. **Nearby cities are discovered by DRIVE TIME from the community's coordinates,
   not from the curated market list.** `nearbyTownsForCoords` reuses the proven
   Photon `/reverse` + `driveMinutesBetweenCoords` pattern from
   `/api/community/nearby-cities`, anchored on `BUY_IN_MARKET_LOCATIONS[community]`
   (so NO initial geocode). Tier 1 = ≤20 min, tier 2 = ≤45 min, nearest-first,
   per-tier caps (env `CITY_VRBO_EXPANSION_TIER{1,2}_*`). `nearbyBuyInMarketsForScoutDetailed`
   (curated markets only) is deliberately NOT used — the operator wants arbitrary
   real towns. Coordinates are used ONLY for discovery + drive math; the VRBO
   destination is always a plain `"City, State"` string (sight+click policy).
2. **Combo-only, gated in `startExpansionJob` (`units.length >= 2`).** This is
   STRICTER than the GET `/api/operations/city-vrbo-inventory` endpoint, which
   intentionally allows `>= 1` for the single-unit home-city fallback. The two
   gates differ on purpose — don't align them.
3. **Worker-offline must bail FAST.** An offline worker leaves each sidecar scan
   PENDING until the queue TTL (~5 min/city). So: the client only starts the job
   when the home scan reported `sidecar.workerOnline === true`; the worker checks
   `getHeartbeat().isOnline` BEFORE the loop and before EVERY city; and a scan
   returning `sidecar.workerOnline === false` ends the ladder — BUT only as
   genuinely-offline when the live heartbeat is also offline (a per-search wallet
   timeout on a HEALTHY worker returns `workerOnline:false` too, and must be
   treated as a transient skip, not a fatal bail). A VRBO provider cooldown
   (`workerOnline:true` + 0 listings + "cooling down/block/proxy" reason) also
   short-circuits the ladder so the operator is told "blocked, retry", not "no
   pair anywhere".
4. **The home town is excluded by BOTH coordinates and normalized name.** The
   community KEY ("Kapaa Beachfront") is not a town name, so name-only exclusion
   misses it — the worker seeds the exclusion set with the home `cityWideSearch`
   term AND `"<loc.city>, <loc.state>"`, and additionally drops any discovered
   town within `CITY_VRBO_EXPANSION_HOME_RADIUS_KM` of the community center. Tier 2
   excludes every tier-1 town already scanned.
5. **The expansion uses a DISJOINT cache namespace.** Per-town scans go through
   `runCityVrboInventoryScanForCity` → `cacheKeyForCityTerm`
   (`term:…|city-vrbo-term-v1`), which can never collide with the community-keyed
   `cacheKeyForScrape` (`…|city-vrbo-dropdown-v3`) in the same `cityVrboScrapeCache`
   Map, so a nearby town's pool is never served for the home community or
   vice-versa. `clearCityVrboInventoryCache(community)` intentionally does NOT
   purge `term:` entries (they're town-scoped, not community-scoped) — use the
   no-arg form to clear them.
6. **Single-flight + in-memory job store.** `activeJobByKey` (`propertyId|checkIn|
   checkOut`) returns the live job instead of starting a second; jobs are
   in-memory (lost on redeploy — the poller treats 404/401/403 + a 45-min cap as
   terminal and falls back to the per-slot net). Interactive resolution attaches
   the found combo via `attachComboMutation` ONLY if the booking's slots are still
   all empty (no-clobber); otherwise / on no-combo it re-invokes auto-fill with
   `skipExpansion:true` to run the per-slot + single-unit safety net (the
   `skipExpansion` flag also skips the redundant home-city scan and prevents an
   expansion loop). The bulk queue polls the SAME job inline (`awaitExpansionInline`)
   so its pass/fail report stays correct. Deterministic smoke:
   `tests/city-vrbo-expansion.smoke.ts`.

### Auto-fill cheapest is a SERVER-SIDE background job (Load-Bearing, 2026-06-08)

The bookings-page **"Auto-fill cheapest"** button no longer runs the escalation
ladder client-side. The whole flow — Stage 1 resort `find-buy-in` → Stage 2
home-city VRBO → Stage 3-4 nearby-city expansion → per-slot single-unit city
fallback — AND the buy-in attach now run server-side in
`server/auto-fill-job.ts` (a fire-and-forget job modeled on
`server/preflight-background-jobs.ts` + `server/city-vrbo-expansion.ts`).

**Why:** the old `autoFillMutation` (`client/src/pages/bookings.tsx`) was pure
client orchestration. The heavy search primitives were already server-side, but
the ladder + the `POST /api/buy-ins` → `POST .../attach-buy-in` calls lived in
the React mutation, so leaving the bookings page (in-app navigation, tab close,
mobile suspend) abandoned the promise chain and any not-yet-completed stage
NEVER attached. The operator had to babysit the tab. (PR #588's resume only
re-fired on tab *return while still mounted*.) Now the search keeps running and
slots keep filling regardless of the browser tab.

Load-bearing choices — don't "simplify" them away:

1. **The worker drives the existing endpoints via in-process LOOPBACK self-calls**
   (`http://127.0.0.1:${PORT}` + `loopbackRequestHeaders()`; 127.0.0.1 bypasses
   the `ADMIN_SECRET` gate — same pattern as `preflight-background-jobs.ts`). It
   does NOT re-implement the 4,000-line `find-buy-in` handler. It calls
   `GET /api/operations/find-buy-in`, `GET /api/operations/city-vrbo-inventory`,
   `POST /api/buy-ins`, `POST /api/bookings/:id/attach-buy-in`; and it starts/
   polls the expansion job IN-PROCESS (`startExpansionJob`/`getExpansionJob`).
   So auto-fill no longer double-calls `find-buy-in` from the client — there is
   no sidecar-lane self-contention.
2. **`find-buy-in` completeness gate.** A partial scan can return `autoFillSafe:
   true` with 1 priced row while a source timed out. The worker only retries (a
   fresh call, NOT `?recover=1` — recover just replays the recovery cache) when
   the scan came back `scanComplete:false` AND empty; otherwise it uses whatever
   `cheapest` returned. Don't trust `autoFillSafe` alone.
3. **No double-attach.** Single-flight by `reservationId` (`activeJobByReservation`);
   the worker re-reads `getBuyInsByReservation` and seeds a used-identity set +
   filled-`unitId` set before each attach, and `storage.attachBuyIn`'s
   same-`unitId` guard is the backstop. The client no longer attaches at all, so
   there is no client/server attach race. The identity-dedup functions
   (`listingIdentityKeys`/`listingUrlKey`/`normalizedIdentityText`/
   `isGenericRentalTitle`) are ported VERBATIM from `bookings.tsx` so the
   server's across-slot de-dup matches the client's exactly.
4. **The "Manual photo URLs:" marker stays LAST in the buy-in notes** (see
   Load-Bearing #1 / Decision Log 2026-06-05) — `attachPick` appends it via
   `buyInPhotoNotesSuffix` after every other suffix.
5. **Attach 409s (proximity / combo unit-type confidence) are recorded as
   skips**, exactly the outcome the client got (it never force-overrode auto
   picks). The worker does NOT pass `force:true`. Parity preserved.
6. **Jobs are in-memory and lost on redeploy — that's fine** because every pick
   is persisted to Postgres the instant it attaches. The client rediscovers a
   live job on return via `GET /api/operations/auto-fill/active?reservationIds=…`
   (the key to surviving a full reload/navigation), and treats a 404 (job lost)
   as terminal, falling back to a re-click.
7. **City stages are gated to configured `PROPERTY_UNIT_CONFIGS` properties**
   (the `city-vrbo-inventory` endpoint requires a config); drafts (negative
   propertyId) and Guesty-derived targets get Stage 1 only — exactly as the old
   client gated `staticUnitConfig`.

Endpoints: `POST /api/operations/auto-fill` (start, single-flight, returns
`jobId`), `GET /api/operations/auto-fill/:jobId` (poll), `GET
/api/operations/auto-fill/active` (rediscover), `POST .../:jobId/cancel` (unused
by the client — the poller intentionally NEVER cancels on unmount). The client's
old `CityExpansionJobPoller` / `expansionJobs` flow is now dead (the expansion
runs inside the server job) but left in place; don't wire it back to the button.

- **Before flagging a concern**, check if the behaviour is documented
  here. If it is, your flag should be *"this intentional decision is
  wrong because…"* rather than *"this code has a bug"*.
- **When the human resolves a dispute**, one of us adds a Decision Log
  entry so the same discussion doesn't happen again next session.

## Load-Bearing Decisions

These are deliberate choices that may look like bugs in isolation. Do
not revert without human approval. Each entry notes the PR that
established it so you can read the rationale in the commit message.

### Photo scraping & curation

1. **Zillow photo extractors read ONLY whitelisted keys** on the
   listing item (`responsivePhotos`, `originalPhotos`, `photos`,
   `hdpData.homeInfo.*`). The greedy "walk the whole payload pulling
   every `zillowstatic.com` URL" pattern was intentionally removed in
   PR #21 because it swept in side-panel content (similar homes,
   nearby schools, map thumbnails) and inflated a 16-photo listing to
   21. `walkForPhotosScoped` is a last-resort fallback only. Do NOT
   widen the extractor's coverage; narrow it further if anything.

2. **Pipeline preserves Zillow's photo order.** `photo-pipeline.ts`
   Step 3b sorts `survivors` by `originalIndex`, NOT by a category
   priority map. A `CATEGORY_PRIORITY` sort was in place earlier;
   removed in PR #21 because users want to see photos in the order
   Zillow presents them.

3. **Photos that Claude fails to label after retry are DROPPED, not
   kept as "Other".** See `unlabeledResults` filter in
   `downloadAndPrioritize`. PR #9. The old fallback let null-labeled
   photos render in the UI with a generic "Photo" caption; the user
   explicitly asked for this to be removed.

4. **Coalesce step is label-only, no photo dropping.**
   `labelBedroomsInPlace` / `labelBathroomsInPlace` rename photos to
   "Master Bedroom — King" / "Primary Bathroom" etc. but return every
   input photo. The older `coalesceBedrooms` / `coalesceBathrooms` with
   `MAX_PER_ROOM=2` was replaced in PR #21 because the user curates
   manually in the UI. Do NOT reintroduce per-room or per-category
   caps.

5. **Apify-first, ScrapingBee fallback — NEVER parallel union.**
   `scrapeListingPhotos` runs Apify; only falls back to ScrapingBee
   when Apify returns 0. A parallel-union approach (PR #11, reverted in
   PR #21) inflated counts because each scraper surfaced different
   slices of the Zillow page. One scraper = one authoritative photo
   set.

6. **User overrides survive rescrape/relabel.** `upsertPhotoLabel` in
   `server/storage.ts` updates ONLY labeler-generated fields
   (`label`, `category`, `confidence`, `model`). It does not touch
   `userLabel`, `userCategory`, or `hidden`. Human edits must persist
   across rescrape operations.

7. **Sanity check trusts keyword match over raw confidence.**
   `applyCategorySanityCheck` uses a hard-floor of `0.40`, not `0.70`.
   A photo labeled "Queen Bedroom" at confidence 0.65 is kept because
   the label text confirms the category. Raising the floor
   under-counts bedrooms. See PR #12 rationale.

8. **Cover collage pairs community + patio, not outdoor + indoor.**
   `pickCollagePhotos` splits the photo set by `source` field. The old
   outdoor/indoor pairing produced "ocean view + kitchen" combos that
   didn't sell the space. See PR #23.

9. **Channel photo caps are published platform limits, hardcoded.**
   `PhotoCurator.tsx` `CHANNEL_LIMITS` = Airbnb 100 / VRBO 50 /
   Booking.com 30. Update these numbers when the platforms publish
   new limits. Do not make them dynamic / DB-driven.

45. **Photo Community Check is CLIENT-DRIVEN and property-agnostic — the
    endpoint does NOT look up `unitBuilderData` by propertyId.** The photos
    tab button (`runCommunityCheck` in `GuestyListingBuilder/index.tsx`)
    derives the request groups from the *rendered* `photos` array: it parses
    each photo's folder/filename from its `/photos/<folder>/<file>` URL and its
    role/label from the photo's `source` string (`"Community — {complex}"` →
    community + `expectedCommunity`; `"Unit A (3BR)"` → unit). It POSTs those
    groups to `POST /api/builder/photo-community-check`, which reads the bytes
    off the Railway photo volume and runs the check. This is deliberate so the
    check works for static props AND negative-id drafts AND single listings
    (none of which can be assumed present in `unitBuilderData`). **Do NOT
    "simplify" the endpoint to take just a propertyId and look up static
    data — that silently breaks drafts/single-listings**, which are exactly the
    things being QA'd before first publish. Engine lives in
    `server/photo-community-check.ts`.
    - **Sonnet (`claude-sonnet-4-6`), not Haiku, on purpose.** This is
      cross-folder visual reasoning + named-resort world knowledge, not the
      short noun-phrase labeling `photo-labeler.ts` does. Haiku over-flags.
    - **ONE vision call with every sampled photo inlined**, delimited by text
      markers (`--- GROUP: … · photo C1 · caption … ---`), so the model judges
      community ↔ unit-A ↔ unit-B consistency holistically. Per-folder sample
      caps (community 10, unit 6, total 24) bound cost/latency (~$0.10, 20-40s).
    - **The prompt reserves a cross-community "no" for POSITIVE
      contradictions** (different named resort on signage, wrong climate,
      incompatible building type/view, distinct architecture); generic-but-
      plausible photos are "uncertain", never "no". This is the anti-false-
      alarm guard — don't loosen it to "flag anything that looks different",
      because unit interiors *always* look different from community amenities.
    - **Cross-folder duplicate detection is deterministic (dHash), not the
      model's job.** The same image filed in two folders is the strongest
      "mixed-up" signal and is computed via `photo-hashing.ts` regardless of
      whether the vision call succeeds (it still runs with no `ANTHROPIC_API_KEY`).

### Availability & pricing

10. **Auto-scan scheduler flips ON when the tab loads for any
    property.** `AvailabilityTab.tsx` uses `scheduleFetched` STATE
    (not a ref) to distinguish "GET still pending" from "server says
    no row exists". A `useRef` would skip the re-render because
    `setSchedule(null)` on initial-null state is a React bail-out.
    See PR #18. Do NOT refactor the state flag back to a ref.

11. **Availability tab default weeks-ahead = 104 (24 months).**
    Not 52. Guesty's calendar horizon is 24 months and users plan
    against that. PR #14.

12. **Half-bath precision preserved end-to-end.** `extractListingFacts`
    uses `Math.round(b * 2) / 2`, not `Math.floor(b)`. A 2.5 BA
    listing stays 2.5, not 2. PR #8.

13. ~~**24-month cost forecast is zero-external-API-cost by design.**~~
    **Removed in PR #29.** The forecast table (endpoint
    `/api/availability/cost-forecast/:propertyId` + the table at the
    top of the Availability tab) duplicated the seasonality table
    already on the Pricing tab, so it was deleted end-to-end — UI,
    endpoint, types. The surviving pricing surface on the Availability
    tab is the Weekly Pricing Correlation block (Load-Bearing #14),
    which is the demand-adjusted counterpart that runs post-scan.
    If you find yourself wanting a static month-by-month forecast in
    the Availability tab again, reach for the Pricing tab's table
    first — it's the same math.

14. **Weekly pricing adds +12% demand markup on "tight" weeks.** Not
    configurable per property yet. If you need to change the factor,
    change the constant in `server/routes.ts` under
    `/api/availability/weekly-pricing` and note the new value here.

30. **`FALLBACK_RATE_PER_BEDROOM` is region-keyed, NOT a single global
    number.** Hawaii is `$270/BR`, Florida is `$80/BR`. Earlier revision
    used `$270` globally — calibrated against Kauai 2BR rates ($516 ÷ 2
    ≈ $258/BR) — which inflated the dashboard buy-in for any Florida
    draft missing an exact `BUY_IN_RATES[area][${br}BR]` entry by ~3.5×.
    Concrete failure: a 2BR + 2BR Caribe Cove draft showed $1,080/night
    buy-in (`$540 × 2`) when the operator-validated cost basis is closer
    to $250/night. The Florida-specific number is calibrated against
    Caribe Cove 2BR ($125 ÷ 2 ≈ $62/BR) and Southern Dunes 3BR ($192 ÷ 3
    ≈ $64/BR). If you add a community in a new region (Tennessee, the
    Carolinas, etc.), add a fallback entry for that region rather than
    bumping the Hawaii or Florida numbers.

31. **`spotCheckRate` in `server/community-research.ts` uses the priced
    Airbnb engine over a 7-night window — NOT regex-grep over Google
    snippets.** The earlier revision regex-matched `$XXX/night` patterns
    out of raw Google JSON, which caught (a) headline "from $X" rates
    that are typically 1-night quotes inflated by cleaning fees, (b)
    peak-season rates from review sites, and (c) rates from unrelated
    nearby properties. For Caribe Cove specifically, that path returned
    `null` entirely because Florida resort pages don't carry the exact
    `$XXX/night` token. The current path delegates to
    `fetchAmortizedNightlyByBR` (also used by `/api/community/search-units`)
    which queries SearchAPI's `airbnb` engine for a 7-night window 30
    days out and divides `extracted_total_price` by 7 — amortizing
    cleaning + service fees the way a real booking would. Per-unit
    rates land within ~10-15% of operator-validated prices. Do NOT
    revert to Google-snippet scraping for pricing data.

32. **`fetchAmortizedNightlyByBR` matches listings by GEOCODED address
    bounds when an `addressHint` is provided, falling back to token-
    based name match otherwise.** Many listings at a resort don't name
    the resort in title or description — Caribe Cove condos commonly
    list themselves as "Disney Vacation Condo" or similar generics —
    so a name-only filter returned 0 listings even on resorts with
    dozens listed. The geo path geocodes `addressHint, city, state`
    via Nominatim (cached in-memory by `server/walking-distance.ts`),
    builds a ~500m bounding box around the result, passes it to the
    Airbnb engine as `sw_lat`/`ne_lat`/`sw_lng`/`ne_lng`, and
    post-filters returned listings whose `gps_coordinates` fall outside
    the box. Listings without coordinates are kept (the engine already
    honored the bbox query param; missing coords is more often a
    data-shape quirk than an out-of-bounds listing). When no address is
    available — typically Step 3 of the Add Community wizard, before
    the operator has set `streetAddress` — the function falls back to
    the same token-based name match that `mentionsResort` in
    `routes.ts` uses. This is intentionally layered: don't collapse to
    name-match-only, the false-negative rate is too high.

    **Refresh path:** `POST /api/community/:id/refresh-pricing` re-runs
    the lookup using the saved draft's `streetAddress` and writes the
    new low/high back to `estimatedLowRate` / `estimatedHighRate`. Use
    this whenever a draft's pricing looks stale — it's idempotent and
    only costs one SearchAPI call + one Nominatim call (or zero, on a
    cache hit).

### Database & deploy

15. **Schema migrations run via `npm run db:push` on Railway boot.**
    See `Dockerfile` `CMD`. Adding a column = bump `shared/schema.ts`;
    Drizzle handles the rest. Do NOT write bespoke migration SQL.

16. **Railway auto-deploys on push to `main`.** No `railway up`
    equivalent needed. Server changes don't change the client bundle
    hash — use API response checks to verify server deploys, not
    bundle diffs.

    When Jamie explicitly asks Codex to implement a production change,
    finish with a clean deploy path: build, commit the focused scope,
    push to `main`, and verify Railway. Do not stop at a local build
    unless Jamie asks for local-only work.

17. **Scraped photos live on a Railway volume mounted at
    `/app/client/public/photos`.** The Docker filesystem is ephemeral,
    so without a volume every deploy wipes the scrape output and the
    builder silently falls back to the static
    `property.communityPhotos` / `u.photos` arrays (user-visible as
    "my 40-photo scrape reverted to 22"). The image ships a backup
    copy of the committed static photos at `/app/photos-seed/`, and
    the CMD runs `cp -Rn /app/photos-seed/. /app/client/public/photos/`
    on boot so a fresh volume gets seeded with the static set without
    clobbering any scraped photos from prior boots. See PR #26. **Do
    NOT** collapse `/app/photos-seed` into `/app/client/public/photos`
    at build time — the volume mount shadows anything at the
    destination path, so the seed must live elsewhere in the image.

18. **Cover collage banner renders whenever `photos.length >= 2`, not
    only when a Guesty listing is selected.** Earlier gate was
    `!!selectedId && photos.length >= 2`, which hid the feature
    entirely until a listing was picked. The revised surface keeps
    the banner visible so the feature is discoverable, but disables
    the button with an inline hint ("Select a Guesty listing above to
    push the collage as cover") when `selectedId` is falsy — the push
    target is unknown without a selected listing. See PR #26.

19. **The availability scheduler does NOT fan out the baseline
    verdict across 52 future weeks.** Only explicit per-window
    overrides (`scanner_overrides.mode = "force-block"`) drive
    automatic Guesty blocks from the scheduler's block-sync step.
    Earlier revision applied `baselineVerdict` to every non-override
    week, which meant a single point-in-time Airbnb-listing count of
    "2 sets, need 3" auto-blocked every week for a year — user
    reported "every future date is blocked." The baseline scan is a
    SIGNAL about current supply tightness (still reported in the run
    summary as `inventory N sets (verdict)`), not an ACTION that
    should translate to 52 Guesty blocks. For real per-week blocks
    based on actual per-week availability scans, use the manual "Run
    inventory scan" → "Push Blackouts to Guesty" flow in the
    Availability tab — that flow queries each window individually
    and writes only weeks that actually failed. Do NOT reintroduce
    baseline-to-52-weeks fanout. See PR #38.

34. **The unattended WEEKLY availability scan is OPT-IN (default OFF),
    2026-06-08.** `startWeeklyScheduler` (`server/availability-scanner.ts`) used
    to run `runAvailabilityScan(52)` every Monday 3am UTC. That scan's inventory
    step (`searchCommunityBedroom` → `fetchMultiChannelBuyInByBR`) drives the
    operator's LOCAL Chrome sidecar through hundreds of Booking.com/VRBO searches
    across every property/bedroom/window and runs for HOURS — the operator saw it
    as "rogue" Chrome activity they never initiated (caught mid-sweep ~10h into the
    Monday-3am run). It now only runs when `WEEKLY_AVAILABILITY_SCAN=1`; otherwise
    the weekly tick logs a skip and only does the (API-only, no-Chrome)
    `syncAllPropertiesToGuesty`. Operators run availability scans ON DEMAND via the
    dashboard / availability-scanner "Run bulk scan" button (`startBulkAvailabilityQueue`).
    Don't re-enable the unattended weekly OTA sweep by default. NOTE: the DAILY
    `availability-scheduler` and the top-market cache refresh are SearchAPI/DB-only
    (no local Chrome), so they are NOT rogue-Chrome sources — leave them as is.

### Browser automation against Guesty admin

25. **Vanilla rebrowser-playwright for STEADY-STATE Guesty admin
    automation; Browserbase persistent context ONLY for cookie
    refresh.** *(Original rule was "never Browserbase for Guesty admin"
    — narrowed when the SSO-from-Railway failure mode finally surfaced,
    see Load-Bearing #32 + the Decision Log.)* For any operation where
    the Playwright session has valid stored cookies, vanilla
    rebrowser-playwright + the Dockerfile's `/usr/bin/chromium` is the
    right tool. rebrowser's CDP-leak patch handles Okta's bot detection
    cheaply (~$0/call), and Guesty's authenticated admin UI for paying
    customers doesn't gate on residential-IP fingerprints. The
    `openGuestyAdminPage` helper in `server/guesty-playwright.ts` is
    the canonical entry point and should keep being used for inspect /
    publish / submit endpoints.

    Browserbase is in the dependency tree for two purposes: (a) Vrbo's
    PUBLIC site (`pm-scraper-vrbo.ts` — anti-bot CAPTCHA on anonymous
    traffic), and (b) the cookie-refresh path
    (`guesty-browserbase-login.ts`) — see #32. Don't reach for
    Browserbase for a NEW Guesty admin automation; the steady-state
    path already works. Browserbase only earns its keep when the
    failure mode is "Google's challenge wall vs. Railway's datacenter
    IP" — a narrow scope.

26. **Guesty admin endpoints are synchronous, not queued.** The
    pattern (`/api/admin/guesty/inspect-vrbo-compliance`,
    `/api/admin/guesty/inspect-distribution`,
    `/api/admin/airbnb/submit-compliance`) runs Playwright inline in
    the request handler and returns `{ ok, finalUrl, screenshotUrl,
    trace, errorMessages? }` directly. A click-and-verify against
    Guesty completes in ~10-30s — well under HTTP timeout — and the
    operator usually wants the screenshot back immediately, not a
    job-status page to poll. Don't introduce a `publish_jobs` table
    or worker process unless we hit a concrete reason synchronous
    can't scale (e.g. multiple concurrent Railway requests
    fighting over Chromium memory). The single-process, one-call-at-
    a-time shape is also the cheapest — no DB writes, no extra
    process, browser lifetime exactly equals the request.

27. **Inspect-first, click-second.** Every Guesty automation against
    a new admin page lands as TWO PRs: an `inspect-X` endpoint that
    dumps DOM structure (headings, buttons, channel-row containers,
    publish-candidate buttons + their `data-testid`s) and a
    screenshot, then a `submit-X` / `publish-X` endpoint that
    actually clicks. The operator hits inspect on a real account,
    pastes back the dump, and the click selectors get wired against
    confirmed DOM rather than guesses. Guesty's admin UI varies per
    account (which channels are connected, what state each is in,
    beta-flag-gated controls) so this is materially cheaper than
    iterating blindly on a deploy → screenshot loop. Precedent:
    `inspect-vrbo-compliance` shipped before `submit-vrbo-compliance`
    was written. See `server/guesty-playwright.ts` for the shared
    session helpers both phases lean on.

28. **Guesty login fallback order: stored session → Google SSO →
    native email/password.** `loginToGuestyIfNeeded` first relies on
    `GUESTY_SESSION_COOKIES` + `GUESTY_OKTA_TOKEN_STORAGE` to skip
    login entirely. If Guesty bounces to `/auth/login`, the dispatcher
    checks for the SSO branch FIRST: when `GOOGLE_PASSWORD` is set AND
    Guesty's login page actually shows a "Sign in with Google" button
    (so we don't misroute on non-SSO accounts), we drive the Google
    OAuth popup with `GOOGLE_EMAIL` (defaults to `GUESTY_EMAIL`) +
    `GOOGLE_PASSWORD`. Otherwise the native `GUESTY_EMAIL` /
    `GUESTY_PASSWORD` flow runs (with IMAP-fetched 6-digit MFA via
    `GMAIL_USER` / `GMAIL_APP_PASSWORD`).

    The SSO path exists because Google Workspace tenants on Guesty
    typically have NO native password — Continue on the email step
    just stalls. **It is not a complete substitute for refreshing
    cookies.** Google's challenges from new datacenter IPs ("verify
    it's you", post-password 2SV, "this browser may not be secure")
    are genuine hard-blockers — there is no automatable second factor
    for an SSO-only account. When the SSO flow hits one of these, the
    error message tells the operator to refresh
    `GUESTY_SESSION_COOKIES` + `GUESTY_OKTA_TOKEN_STORAGE` from a
    logged-in browser instead of trying again. Realistic steady-state
    reliability of the SSO path is ~70-80% once Railway's IP has been
    device-trusted by one successful login. Don't expand the SSO path
    to handle 2SV; expand the cookie-refresh ergonomics instead.

29. **Automatic CAPTCHA solving is disabled; CapSolver is only the
    configured provider surface.** The SSO path can still trip
    Google's "Type the text you hear or see" image CAPTCHA on the
    email step because Railway's IP has no device history.
    `loginToGuestyViaGoogleSso` detects this state — still on
    `/signin/identifier` after submit + a CAPTCHA `<img>` present —
    and now fails with a cookie-refresh recommendation instead of
    submitting the image to an external solver. CapSolver config lives
    behind `CAPTCHA_PROVIDER=capsolver`, `CAPSOLVER_API_KEY`, and
    `CAPTCHA_SOLVING_ENABLED`, but provider scrapers should surface
    blocked status rather than hiding the failure behind automatic
    CAPTCHA attempts.

    What this does NOT solve: the post-password challenges (2SV
    Google Prompt, authenticator code, security key, "verify it's
    you" device check, "this browser may not be secure" wall). Those
    are genuine hard-blockers per #28; the answer remains refreshing
    `GUESTY_SESSION_COOKIES` or using the Browserbase persistent
    context path in #32.

32. **Cookie refresh is self-healing via a Browserbase persistent
    context — operator no longer pastes cookies after every expiry.**
    Sister to #28: the documented answer used to be "operator refreshes
    `GUESTY_SESSION_COOKIES` + `GUESTY_OKTA_TOKEN_STORAGE` on Railway
    when Google's SSO challenge wall blocks the relogin from Railway's
    datacenter IP." That's ~5 min of toil every 1-2 weeks. The new path
    uses Browserbase's persistent-context feature (`bb.contexts.create`
    + `browserSettings.context.{id, persist: true}` per session) which
    does two things vanilla Playwright can't: (a) sessions land on a
    residential IP, and (b) the context persists Google's device-trust
    cookie across runs, so Google sees the same "browser" that
    successfully logged in before and waves the SSO through silently.

    Architecture in three pieces:
    - **`server/guesty-session-cache.ts`** — file-on-volume cache at
      `process.cwd()/.guesty_session_cache.json` (same volume pattern
      as `guesty-token.ts`). Holds `cookies`, `oktaTokenStorage`, and
      `browserbaseContextId`. Read priority is memory → file → env var
      so manual env-var deploys still work and writes (cache-only,
      never the env var) take effect without redeploy.
    - **`server/guesty-browserbase-login.ts`** — two functions:
      `bootstrapBrowserbaseContext()` for one-time setup (operator
      paste → create BB context → seed cookies → verify → save
      context_id), and `refreshGuestySessionViaBrowserbase()` for the
      auto path (connect to existing context → navigate → drive SSO if
      needed → harvest fresh cookies + Okta token → write to cache).
    - **`openGuestyAdminPage` self-healing branch** — when the page
      bounces to `/auth/login` AND a Browserbase context is
      bootstrapped, calls the refresh helper FIRST, re-seeds the
      in-flight Playwright context with the freshly-extracted cookies,
      reloads, and continues. Falls through to the legacy
      native/SSO login from #28 if Browserbase is unset or refresh
      errors — so cold deploys without Browserbase still work.

    Operator workflow:
    - **Day 0 (one-time):** export Cookie-Editor JSON from
      app.guesty.com + copy `okta-token-storage` from DevTools, POST
      both to `/api/admin/guesty/bootstrap-browserbase-context`. Saves
      the context_id to the cache.
    - **Steady state:** push compliance / publish channel / etc. just
      works. When cookies expire, the auto-refresh fires inside the
      same request and the operator never sees it.
    - **Manual override:** `/api/admin/guesty/save-session` accepts a
      cookie+token paste straight into the cache (skipping
      Browserbase). Used when Browserbase isn't bootstrapped yet, or
      when the operator wants to hand-pick cookies for a specific
      account. `/api/admin/guesty/refresh-session` triggers the
      Browserbase path on demand for verification.
    - **Re-bootstrap (rare — months):** when Google's device-trust
      cookie eventually rotates inside the persistent context, the
      auto-refresh fails on the SSO step and surfaces a clear error.
      Operator re-runs the bootstrap with fresh browser cookies; new
      context, new device-trust cookie, back to silent steady state.

    Cost: ~$0.20 per Browserbase session × ~30-50 refreshes/year ≈
    $6-10/year. Cheaper than the operator's time. Don't widen this to
    cover EVERY Guesty admin call — the cheap rebrowser-playwright
    path is what handles the 99% steady-state case (#25). Browserbase
    is for the cookie-refresh path only.

    **Optional auth gate:** the three admin endpoints honor
    `ADMIN_SECRET` env var when set (require `X-Admin-Secret` header
    match). When unset, they're open like the rest of `/api/admin/*` —
    matching the existing operator-only-deploy posture. If the deploy
    becomes multi-tenant, set `ADMIN_SECRET`.

### Compliance & channel sync

20. **Tax Map Key (TMK) is NEVER written to
    `publicDescription.notes`.** The TMK is a bare 12-digit number
    (e.g. `420140050001`) and Airbnb's content moderation flags it
    as contact info ("Links and contact info can't be shared"),
    which rejects the entire Guesty→Airbnb sync and leaves the
    channel stuck with `integration.status: FAILED`. The Guesty UI
    surfaces the rejection as *"We can't save your info yet.
    Please remove this info to continue: '420140050001'"* on the
    listing's Airbnb distribution row. TMK still flows through
    Guesty tags, `licenseNumber`/`taxId` fields, VRBO's
    `channels.homeaway.parcelNumber`, Booking.com's `tmk_number`,
    and Airbnb's regulation form — all non-OTA-scanned routes. GET
    and TAT licenses DO stay in notes because their letter prefixes
    (`GE-` / `TA-`) skip phone-number filters. See PR that added
    this entry for the full diagnosis flow.

30. **VRBO compliance submission drives Guesty's UI; the form-fill is
    heuristic, not selector-based; the republish step is automated as
    part of the same session.** *(Originally numbered #28 in PR #186;
    renumbered here because PRs #183/#184 also claimed #28/#29 under
    "Browser automation against Guesty admin" — first one to merge wins
    the slot.)* Sister to the Airbnb compliance flow but
    with a different mechanic. Airbnb publishes a regulations form at
    `airbnb.com/regulations/{id}/.../existing-registration` that we
    drive directly with Playwright; VRBO has no equivalent public form,
    so `/api/admin/guesty/submit-vrbo-compliance` opens
    `app.guesty.com/properties/{id}/owners-and-license`, edits the
    "Vrbo license requirements" panel (TMK / TAT / GET), saves, then
    navigates to `/properties/{id}/distribution` and clicks Publish on
    the VRBO row. The republish step is the VRBO equivalent of the
    manual reminder Airbnb's flow leaves to the operator — we automate
    it because we're already in the same Playwright session, so it
    costs nothing extra.

    The endpoint uses `openGuestyAdminPage` from
    `server/guesty-playwright.ts` (Load-Bearing #25 — vanilla
    rebrowser-playwright, **never** Browserbase, for Guesty admin) and
    runs synchronously inline (#26). Inspect-first/click-second (#27):
    `inspect-vrbo-compliance` already dumps the Edit modal's form
    structure, so the submit-side form-fill targets a confirmed shape.

    The form-fill is **heuristic, not selector-based**. The "Vrbo
    license requirements" inputs don't have stable IDs and change between
    Guesty UI revisions, so the endpoint matches by
    `aria-label`/`name`/`placeholder`/parent-label-text against three
    patterns:
    - parcel/TMK/tax-map → fills TMK
    - tax-id/excise/GET  → fills GET
    - license/permit/registration/TAT → fills TAT

    Match priority is parcel-first (most specific) so "license" doesn't
    accidentally claim a parcel field whose container also mentions
    licensing. If no fields match, the endpoint returns the diagnostic
    payload + screenshot and points the operator at the inspect endpoint
    to refresh the form-shape discovery. **Don't promote this to hard-
    coded selectors** — every Guesty UI rev would break it; the
    heuristic survives small DOM changes.

    The republish step uses the same heuristic style: walk up from the
    VRBO/Homeaway text node looking for a row container, then click the
    nearest publish-like button (`/publish|re-?publish|push|sync now/i`).
    Falls back to a page-wide search if the row scope finds nothing. If
    no button matches, the response carries `republishResult.clicked:
    false` and the UI tells the operator to do it by hand. **Do NOT
    remove the heuristic fallback** — a partial automation that says it
    didn't republish is much better than one that silently skips the
    step and leaves Guesty out of sync with VRBO.

    **Persistent compliance state is detected from THREE paths on the
    listing payload, not one.** The original implementation only read
    `listing.channels.homeaway.{licenseNumber, taxId, parcelNumber}`
    and reported "not yet in Guesty" on every real listing because that
    path doesn't exist on real Guesty payloads — it was theoretical.
    `getChannelStatus` (in `client/src/services/guestyService.ts`) now
    detects from each of these in priority order, returning whichever
    has the most complete picture:
    1. **`listing.tags`** — `TMK:` / `TAT:` / `GET:` prefixed entries
       written by `/api/builder/push-compliance` Step 1. Carries all
       three values (TAT, GET, TMK) and is the most reliable source
       when this codebase pushed the compliance.
    2. **`integrations[platform=bookingCom].bookingCom.license.information.contentData`** —
       Booking.com Hawaii variant 6 (`hawaii-hotel_v1`) license object
       written by push-compliance Step 3b. Carries TAT (`number`) and
       TMK (`tmk_number`) but NOT GET. Guesty's UI "Vrbo license
       requirements" panel surfaces these too because the Hawaii
       variant is shared across VRBO and Booking.com.
    3. **`listing.channels.homeaway.{licenseNumber, taxId, parcelNumber}`** —
       legacy/future-proof fallback. Empty on every real account we've
       seen but kept in case Guesty starts populating it.

    The push-compliance verification was reporting `vrbo.saved = false`
    on every successful push because it only read path #3. That's been
    relaxed — `saved` is now true when ANY of tags / Booking.com Hawaii
    variant / channels.homeaway have the data, with the response note
    spelling out which path took it. Don't regress to a single-path
    check — channels.homeaway is unused in production Guesty.

    The VRBO compliance card sub-block surfaces three states from
    `info.vrboLicense`:
    - **on file** (green) — Guesty has every field the property record
      has a value for, and the values match,
    - **out of date / incomplete** (amber) — Guesty has SOMETHING but
      it's stale relative to the property record OR missing fields the
      record carries,
    - **not yet in Guesty** (blue) — Guesty has no VRBO license data.

    The session-local "done" flag in `vrboComplianceStateByListing` is
    a fast-path for the gap between the click and the next channel-
    status refresh; the real source of truth is `info.vrboLicense`. Do
    NOT regress this back to a session-only flag — it caused a stale UI
    on every page reload.

31. **`/api/admin/guesty/publish-channel` is one heuristic clicker for
    all three channels.** Generic Distribution publish endpoint: takes
    `{listingId, channel}` where channel is `"airbnb" | "vrbo" |
    "bookingCom"`, opens Guesty's Distribution page via
    `openGuestyAdminPage`, scopes a click to the requested channel's
    row, and clicks whatever publish-like button lives there
    (`/publish|connect|enable|sync now|push|create listing|activate|list
    on/i`). Same backend code path handles three observable user
    actions:
    - **Create listing** — channel is connected (OAuth done) but the
      listing hasn't been pushed to it yet → the click creates the
      listing on the channel.
    - **Re-publish** — channel is already listed → the click pushes
      Guesty's latest state (e.g. compliance fields just saved) back to
      the channel.
    - **No publish button** — channel has no integration at all → the
      endpoint returns `clicked: false, reason: "..."` and the UI tells
      the operator to set up OAuth in Guesty UI first.

    The match scope is **channel-row-first, page-fallback-second**: it
    walks up from any short text node mentioning the channel name to
    look for an enclosing button container, then falls back to a page-
    wide search where each candidate button must have a channel mention
    in its ancestor chain. This avoids two failure modes the simpler
    "first publish-like button on the page" heuristic hits: (a) clicking
    Airbnb's Publish button when the operator asked to publish to VRBO,
    and (b) clicking a stray top-level "Connect more channels" CTA that
    isn't tied to any specific channel.

    The endpoint also tries a one-shot confirm-modal click after the
    publish click (matches `/^(publish|confirm|yes|ok|continue|i agree)$/i`
    on visible buttons) so the operator doesn't end up with a half-
    clicked dialog. **Do NOT** chain more than one confirm step or wait
    longer than 3s — Guesty's publish modals are typically single-step,
    and a multi-step waterfall would risk clicking through a CAPTCHA or
    OAuth re-prompt the operator should see.

    UI: each channel card shows a single full-width "+ Create listing"
    or "↑ Re-publish" button (label adapts to `info.live`). The button
    is hidden when `!info.connected` because there's no integration to
    publish to. Per-channel busy state lives in
    `publishStateByListingChannel` keyed `${listingId}:${channel}` so
    all three buttons can be in-flight independently — they each spawn
    their own Playwright session server-side.

    **Don't merge the form-fill heuristic from VRBO compliance into this
    one.** This endpoint clicks ONE button on a Distribution page; the
    VRBO compliance endpoint navigates a completely different page and
    fills a multi-input form. Sharing code between them today would
    couple two flows that may need to evolve independently as Guesty's
    UI changes per page.

### Dashboard data shape

21. **`home.tsx` properties carry both `community` (display) and
    `pricingArea` (lookup key).** Dashboard badges, filters, and
    sorting use `community` — the canonical complexName from
    `unit-builder-data` (Kaha Lani Resort, Regency at Poipu Kai,
    Mauna Kai Princeville, …). Buy-in rates, market-rate-per-BR,
    and location-demand tables in `shared/pricing-rates` and
    `client/src/data/quality-score` are keyed by area (Poipu Kai,
    Princeville, Kapaa Beachfront, …) — multiple complexes share
    one area. Keep both fields up to date when adding a property:
    `community` matches the complex; `pricingArea` matches whichever
    BUY_IN_RATES key applies. `computeBaseRate`,
    `computeQualityScore` (via `{ ...p, community: p.pricingArea }`),
    and `communityVariant` all read `pricingArea`. See PR #93.

22. ~~**Dashboard Photo Match column drops folders whose
    `unitHintFromFolder` doesn't equal the unit's current
    `unitNumber`.**~~ **Replaced in PR #95.** The dashboard-side
    staleness filter introduced in PR #93 was a band-aid over a
    scanner that verified Lens hits against the folder-name hint
    (e.g. `kaha-lani-109` → "109"). Removed in favour of moving
    the canonical unit identity into `shared/folder-unit-map.ts`'s
    `FOLDER_UNIT_TOKENS` (see #23). The dashboard now trusts the
    scanner output again.

23. **Photo-listing scanner verifies Lens hits against
    `FOLDER_UNIT_TOKENS`, not the folder-name hint.** Each
    scannable folder in `shared/folder-unit-map.ts` maps to a list
    of unit-number tokens — usually the unit numbers from
    `unit-builder-data`, with single-letter IDs ("A"/"B") dropped
    because they false-positive on Google snippets. Verification
    accepts a Lens hit when the matched listing's page mentions
    ANY of the listed tokens. This handles three real-world cases
    the prior folder-hint approach choked on:
    - **Folder names that have drifted** — `kaha-lani-109` is the
      photo folder for a unit now claimed as 339; verification
      targets 339, not 109, so listings for the OLD 109 unit are
      correctly rejected.
    - **Shared folders** — `unit-114` is claimed by props 1, 9,
      AND 27. The map lists every claiming unit's tokens; a match
      against any one of them counts.
    - **Placeholder folders without a digit hint** —
      `pili-mai-unit-a/b` hold Pili Mai photos. Building numbers
      from "Building 38" / "Building 10" / etc. become the
      verification tokens, so the folders enter the scan universe
      for the first time.
    `isScannableFolder` consults the map first, then falls back to
    the folder-name hint, so the dashboard aggregation in
    `home.tsx`→`photoByProperty` stays in lockstep with what the
    scanner actually scans. **Adding a new property requires
    adding the folder to `FOLDER_UNIT_TOKENS`** so the scanner has
    tokens to verify against — otherwise the folder falls through
    to the hint-based legacy path or is treated as unscannable.
    See PR #95.

33. **Single-listing drafts share the `community_drafts` table with
    combo drafts; the `singleListing` boolean flag flips the per-unit
    rendering across the stack.** When the operator uses the "Add a
    Single Listing" wizard (`/add-single-listing`, see
    `client/src/pages/add-single-listing.tsx`), the resulting draft
    lands in the same `community_drafts` row shape as a combo — just
    with `unit2_*` columns null and `singleListing = true`. This
    intentionally avoids creating a parallel `single_listings` table:
    the builder, preflight, photo pipeline, Guesty publish path, and
    the dashboard table all already operate on per-unit fields and
    only need to know "skip Unit B" — not a different schema shape.

    Three branch points to be aware of:
    - **Wizard side** — `add-single-listing.tsx` is a 4-step (not 5)
      flow: Property → OTA Check → Photos → Listing Draft. There's no
      community-wide research scan; instead, Step 2 is the OTA-clean
      qualifier (see #34). On save, the wizard explicitly POSTs
      `singleListing: true` plus `unit2_*: null`.
    - **Server side** — `/api/community/save` keeps the
      `checkCommunityType` validation (single-listing standalones must
      still be condo/townhouse, not villa/single-family — same
      business rule). `/api/community/generate-listing` branches its
      Claude prompt: combo prompt mentions "two units" + walking
      distance; single-listing prompt drops both, asks for only
      `unitA`, and the no-Anthropic + catch-block fallbacks emit
      single-unit copy. `/api/community/fetch-unit-photos` now also
      returns `facts: { bedrooms?, bathrooms? }` (Zillow-extracted) so
      the single wizard can size bedding/sleeps defaults — additive,
      combo flow ignores it.
    - **Client adapters** — `home.tsx → draftsAsProperties` and
      `client/src/data/adapt-draft.ts → adaptDraftToPropertyUnitBuilder`
      both branch on `(draft as any).singleListing === true`. Single
      drafts render as `multiUnit: false`, with a one-element
      `units[]` array, and `unitDetails: "{N}BR standalone"` instead
      of "{N}BR + {M}BR". `loadDraftFullDataByNegativeId`'s photo-
      folder list `.filter((f): f is string => !!f)` already drops
      null `unit2PhotoFolder` so photo loading needs no further
      change.

    **Don't collapse single + combo into one prompt** — the framing
    constraints are genuinely different ("two separate units, %{walk}
    apart" vs. standalone), and Claude will leak combo phrasing into
    standalones if the prompt isn't branched. **Don't add a
    `single_listings` table** — every adapter, builder tab, and
    Guesty endpoint would need a parallel path. The flag-on-shared-
    table approach keeps the surface tiny.

34. **`/api/single-listing/qualify` is the OTA-clean gate for the
    single-listing wizard, NOT a generic platform-check.** Operator
    hard requirement: a standalone unit only qualifies when its
    street address returns ZERO confirmed matches on Airbnb / VRBO /
    Booking.com. The endpoint runs three SearchAPI Google queries in
    parallel — `site:{platform}.com "{streetAddress}" "{city}"` — and
    matches the response against per-platform URL patterns:
    `airbnb.com/(rooms|h)/`, `vrbo.com/\d+`, `booking.com/(hotel|apartments)/`.
    A result counts as a match only when the URL pattern matches AND
    the title or snippet contains the exact street portion (lowercase
    substring).

    Different from `/api/preflight/platform-check` (Load-Bearing
    surface for the existing combo flow):
    - **platform-check** verifies a known multi-unit RESORT'S per-unit
      listings exist with strict unit-number / building gating
      ("Unit 122" vs. random "122" in a price). False-negative tuned —
      it's verifying the operator's own listings are live.
    - **single-listing/qualify** verifies an INDEPENDENT address is
      NOT listed anywhere. Less unit-number ambiguity (a standalone
      address is unique on its own). False-positive tuned — a single
      confirmed match on any of the three platforms hard-blocks save.

    The wizard's Step 2 disables the Continue button until
    `qualifies: true`. There's no operator override — the rule is
    that the property must be clean, full stop. Don't add a "force
    save" path; the failure mode is a missed disqualification, not a
    missed qualification.

35. **`/api/community/city-suggest-any` is hard-scoped to Hawaii +
    Florida.** The single-listing wizard's Step 1 uses this endpoint
    (Photon, no bbox restriction) but post-filters the response to
    `state ∈ {Hawaii, Florida}` because those are the two states the
    business currently operates in. The combo wizard's existing
    state-scoped endpoint (`/api/community/city-suggest?state=...`)
    is unchanged — it covers the full US states list and is gated by
    the operator picking a state first. Operator directive
    (2026-05-04): "for now just keep it focused on Hawaii and
    Florida." When expanding to a new market, add the state name (in
    Photon's `state` casing — e.g. `"tennessee"`) to the
    `ALLOWED_STATES` set in `server/routes.ts`'s `city-suggest-any`
    handler. Don't widen this to a generic nationwide endpoint —
    Photon returns enough other-country / other-state noise that an
    explicit allowlist is the safest gate.

36. **`researchCommunitiesForCity` takes a `mode` parameter — `"combo"`
    keeps the original combinability-gated 10-result Haiku flow;
    `"single"` is purpose-built for the single-listing wizard.** Single
    mode (a) drops the `combinabilityScore >= 50` hard filter (irrelevant
    for standalone listings — combinability is a combo-flow concept),
    (b) lifts the world-knowledge cap from 3 to 15 entries, (c) returns
    up to 20 results instead of 10, (d) runs on Sonnet rather than
    Haiku for better recall on niche named resorts, and (e) uses an
    expanded 5-query SearchAPI sweep that hits "best resort" round-up
    pages along with the original site:airbnb-style queries. The prompt
    also enumerates known resorts per major Florida market (Fort Myers
    Beach, Destin, Panama City Beach, Kissimmee/Orlando) and per
    Hawaii market (Lihue/Kapaa/Poipu) as a recall anchor — explicitly
    telling Claude "for any city named, you MUST surface every example
    resort listed for that city" because the Haiku-default behavior
    was to omit Santa Maria Resort (Fort Myers Beach) from results.

    The combo flow is unchanged. `/api/community/research` accepts an
    optional `mode` field on the request body; default `"combo"`. Top-
    markets-sweep keeps using combo mode because it iterates 12+
    markets back-to-back and the Haiku speed advantage matters there.

    **Don't merge the prompts back into one** — the combinability
    framing leaks into single-mode if the prompt isn't branched, and
    Haiku's narrower world knowledge silently drops niche resorts.
    **Don't shorten the example-resort list in the single-mode prompt** —
    it's the recall anchor that solved the original Santa Maria bug.

37. **Single-listing wizard: one click finds a clean Zillow unit, no
    address typing.** After picking a community + bedroom count on
    Step 1, the operator clicks "Find a clean {N}BR unit" and the
    backend (`/api/single-listing/find-clean-unit`) does the rest:
    (1) SearchAPI Google for `site:zillow.com "{community}" {city} {state}
    {bedrooms} bedroom` with two progressively-broader fallback queries,
    (2) iterates up to 8 Zillow homedetails candidates, (3) scrapes
    each for facts + photos via the existing Apify→ScrapingBee chain,
    (4) parses the address from the URL slug
    (`/homedetails/4460-Nehe-Rd-Lihue-HI-96766/...`), (5) hard-filters
    on bedroom-count match, (6) calls the extracted `runOtaQualifier`
    helper on the address. First clean candidate wins — wizard skips
    straight to Step 2 with the unit + qualifier result + photos all
    pre-populated. The "Try another unit" button on Step 2 re-calls
    the endpoint with the current URL appended to `skipUrls`.

    `runOtaQualifier(apiKey, address, city, state)` is the shared
    helper; both `/api/single-listing/qualify` (manual-typed-address
    path) and `/api/single-listing/find-clean-unit` (auto-discovery
    path) call it. The helper returns `{ qualifies, platforms, reason,
    address, city, state }` — same shape as the qualify endpoint
    response, so the wizard reuses one component to render either
    path's result.

    **Worst-case wallet:** ~3 SearchAPI calls (Zillow discovery) +
    8 candidates × (1 Apify scrape + 3 SearchAPI qualifier calls) =
    ~32 SearchAPI calls + 8 Apify calls per click. Aborts the
    iteration as soon as a clean candidate is found; common case is
    1–2 candidates. **Don't bump the candidate cap above 8** without
    a wallet review — Apify scrapes are the slow leg (60-120s
    cold-start each).

    **Manual escape hatch preserved:** the wizard still has a
    "Couldn't find your resort? Type the unit's name + street
    address manually" path that bypasses the auto-discovery and
    runs the original `/qualify` endpoint. Used when the resort
    isn't on Zillow yet or when the operator already has a specific
    listing in mind.

38. **Single-listing OTA qualifier uses BOTH text search AND
    Google Lens reverse-image-search — same two-source methodology
    as the combo-flow preflight platform-check.** When the
    operator clicks "Find a clean {N}BR unit" or types an address
    manually, `runOtaQualifier(apiKey, address, city, state,
    photoUrls)` runs in parallel:

    - **Text search** (per platform): SearchAPI Google
      `site:{platform}.com "{street}" "{city}"` with strict
      matching (URL must be a real listing-page shape, snippet must
      contain the street). Same logic as before — covers listings
      whose title/snippet name the address.

    - **Reverse-image-search** (when `photoUrls.length > 0`):
      `runPhotoReverseSearch` sends each of the first 3 photo
      URLs to Google Lens via SearchAPI's `google_lens` engine,
      collects every hit on `airbnb.com/(rooms|h)/`, `vrbo.com/\d+`,
      and `booking.com/(hotel|apartments)/`. Standalone units have
      unique photos; a Lens hit on a competitor's listing page is
      a strong signal that the property is already listed there
      even when the address text doesn't appear in the snippet —
      this catches the marketing-driven titles that the text
      search misses. **Skips ImgBB** because Zillow CDN URLs
      (`photos.zillowstatic.com`) are already publicly crawlable
      by Lens, unlike preflight's local-disk photos which need an
      upload step.

    A platform counts as "listed" when EITHER signal fires. The
    response shape carries `matches[]` (text matches) and
    `photoMatches[]` (Lens-found URLs) per platform plus a
    top-level `photoChecksRun` count, so the wizard can render
    "X address + Y photo" badges and the operator can see which
    signal triggered the rejection.

    Wallet: manual `/qualify` is ~3 SearchAPI text calls + up to 3
    SearchAPI Lens calls. `/api/single-listing/find-clean-unit`
    uses the text check as a cheap pre-scrape rejection gate, then
    runs the Lens/photo half only after the candidate has scraped
    usable photos and passed bed/type/status gates. A candidate is
    accepted only after that final photo check passes.

    **Don't drop the photo signal to save on credits** — it's the
    only thing catching listings that don't include the street in
    the title. The preflight platform-check has the same dual
    structure for the same reason; adding it here brings the
    single-listing qualifier to parity with the combo-flow
    methodology Jamie validated.

    **Don't add `verifyUrlMentionsAddress` (analog of preflight's
    `verifyUrlMentionsUnit`)** — preflight needs that step because
    multiple units in a multi-unit complex share photos. For a
    standalone unit, the photos are property-unique by
    construction, so the secondary verification adds latency
    without removing false positives. If false positives surface
    in the field, revisit.

39. **Single-listing research returns `availableBedrooms[]` per
    community so the wizard's bedroom selector only shows valid
    options.** When the operator picks a community on Step 1, the
    research scan returns each entry with an `availableBedrooms`
    array (e.g. Santa Maria Resort → `[2, 3]`) populated by the
    Sonnet prompt. The wizard renders `[2BR, 3BR]` as the bedroom
    buttons rather than the generic `[1, 2, 3, 4, 5]` — saves the
    operator from picking a count that doesn't exist at that
    resort and lands no Zillow candidates.

    Falls back to `[1, 2, 3, 4, 5]` when the array is empty
    (Claude returned no confidence on the bedroom mix). The
    wizard surfaces a small note explaining whether the buttons
    are confirmed-available or generic-fallback so the operator
    knows when to trust the picker. Combo flow's
    `combinedBedroomsTypical` is unchanged — that's a different
    field used by the combo wizard's pairing engine.

    The `availableBedrooms` array is filtered server-side to
    integers in [1, 12] and deduped before persistence, so a
    badly-formed Claude response can't pollute the wizard with
    `[0, 1.5, 99]` chaos.

40. **Apify actor env vars pick which actors discover and scrape
    each platform.** All are operator-overridable so the actor
    choice doesn't require a code change.

    Defaults:
    - `APIFY_ZILLOW_ACTOR` → `maxcopell~zillow-detail-scraper`
    - `APIFY_REALTOR_ACTOR` → `dz_omar~realtor-scraper`
    - `APIFY_ZILLOW_SEARCH_ACTOR` → `igolaizola~zillow-scraper-ppe`
    - `APIFY_REALTOR_SEARCH_ACTOR` → `dz_omar~realtor-scraper`

    Per Grok's 2026-05-04 architectural review of the find-clean-
    unit + photo-scraper system, `jaroslavhejlek~zillow-scraper`
    is the recommended Zillow alternative — better photo extraction
    (handles Zillow's carousel JSON more reliably, extracts up to
    50+ photos via `resoFacts.photos`), better resoFacts coverage
    (lower rate of partial-payload responses where bedrooms is
    present but bathrooms is null). Cost is roughly equivalent.
    **To switch:** set the env var on Railway (note tilde, not
    slash — the value is passed straight into the Apify URL path).
    The runtime URL becomes
    `https://api.apify.com/v2/acts/<actor>/run-sync-get-dataset-items?...`.

    Realtor.com integration order (added 2026-05-05):
    1. **Apify primary** (`scrapeRealtorViaApify`, this Load-Bearing)
    2. **Direct fetch** (`scrapeRealtorViaFetch`) — JSON-LD + text
       regex on Realtor's HTML. Cheap; Realtor's anti-bot is light
       enough that direct fetch usually works.
    3. **ScrapingBee** — JS-rendered HTML, last resort.

    The Apify-primary chain mirrors Zillow's
    Apify→ScrapingBee→sidecar. No sidecar tier yet for Realtor.com
    (operator's residential Chrome can be wired up later if all
    three datacenter scrapers fail consistently).

    Most Apify Realtor actors accept `{ startUrls: [{url}] }`;
    older epctex actors also accept `{ urls: [...] }`. The detail
    helper sends both — actors ignore unknown fields. The Zillow
    search helper is actor-aware because `igolaizola~zillow-scraper-
    ppe` requires `{ location, maxItems }`, while maxcopell/api-
    ninja search actors require `searchUrls`.

    The other big architectural recommendations from the same Grok
    consult are NOT yet implemented and gated on operator decisions:
    Bright Data Web Unblocker as primary scraper (~$0.50-1 per 1K
    requests; would replace Apify+ScrapingBee for the highest
    success rate on Zillow's anti-bot), and Redfin / Realtor /
    Trulia source diversification. See
    `server/grok-single-listing-consult.ts` for the full brief —
    hit `GET /api/operations/grok-single-listing-consult` on Railway
    to re-run the consult. **Don't ship Bright Data without operator
    approval** (cost concern).

    The other two Grok recommendations DID ship:
    - Residential-IP Chrome sidecar for Zillow scraping (PR #361,
      Load-Bearing #41) — wired as tertiary fallback in
      scrapeListingPhotos.
    - Verify-then-discover architecture flip (Load-Bearing #42) —
      OTA address index built FIRST, used as a prefilter before
      Zillow candidates get scraped.

41. **Local Chrome sidecar wired as tertiary Zillow scraper.**
    `scrapeListingPhotos` chain on Zillow URLs: Apify primary →
    ScrapingBee secondary → sidecar tertiary (heartbeat-gated).
    The sidecar's `zillow_photo_scrape` op type extracts photos
    AND facts from the rendered DOM, so a sidecar success short-
    circuits the find-clean-unit HTML-fallback step. Operator
    needs to add `handleZillowPhotoScrape` to their local
    `worker.mjs` per `docs/sidecar-worker-deltas/zillow-photo-
    scrape.md` — until they do, sidecar requests time out
    gracefully (90s wallet) and the chain falls through to its
    existing behavior. PR #361.

42. **find-clean-unit uses verify-then-discover prefiltering: OTA
    address index built BEFORE Zillow candidates get scraped.**
    Old flow walked 15 Zillow candidates × Apify scrape × 6-call
    qualifier sequentially, even at saturated resorts where 70%+
    of candidates are already on Airbnb/VRBO/Booking. New flow,
    feature-flagged on by default (`FIND_CLEAN_UNIT_VERIFY_FIRST`
    env var; set to `0` to disable):

    1. Build OTA address index — three parallel SearchAPI Google
       site:airbnb / site:vrbo / site:booking queries against the
       community + city. Extract street tokens (regex against
       organic-result snippets).
    2. For each Zillow candidate, before scraping, parse address
       from the URL slug and check substring containment against
       any indexed token. Match → skip without scraping (rejected
       attempt with reason "Pre-filtered: address appears in OTA
       index").
    3. Otherwise fall through to the existing scrape + qualifier
       chain — preserves the safety net for borderline cases
       where the OTA index is sparse, has stale data, or fuzzy-
       matches a clean unit's address tokens.

    Streaming events added: `ota-index-start`, `ota-index-done`
    (with per-platform counts + token count), `candidate-
    prefiltered`. Wizard's progress UI shows the OTA-indexing
    phase + a pre-filtered count in the footer.

    Wallet impact at saturated resorts: ~3 SearchAPI for the index
    + ~5 surviving candidates × (1 Apify + 4 SearchAPI) ≈ 23
    SearchAPI + 5 Apify, vs. the old flow's 15 candidates × 5
    SearchAPI + 15 Apify ≈ 75 SearchAPI + 15 Apify. Net ~70%
    SearchAPI / 67% Apify reduction on saturated resorts. On
    sparse resorts the index returns near-empty so every
    candidate falls through; cost is +3 SearchAPI calls vs the
    old flow.

    **Skipped from Grok's full plan:** Airbnb engine integration
    (Airbnb engine returns no street addresses, only fuzzy
    titles + coords — would require geocoding cache for marginal
    coverage gain), and coord-cluster matching. The street-token
    text-match alone catches most of the value; revisit if
    operator data shows the prefilter missing too many
    saturated-resort candidates.

    **Don't delete the fall-through to runOtaQualifier** for
    candidates that DON'T match the OTA index — that's the
    safety net against the index being stale / fuzzy-matched /
    incomplete. Pure inverse-filter would lose legitimate clean
    candidates.

43. **RentCast is discovery-only for photo search — never a photo
    source.** PRs #503–#505. `server/rentcast-discovery.ts` queries
    RentCast `GET /v1/listings/sale` (active Condo/Townhouse by city +
    bedrooms). RentCast does **not** ship listing photos or Zillow
    URLs in its API response. Each hit is resolved to
    `zillow.com/homedetails` and/or `realtor.com/realestateandhomes-detail`
    URLs via SearchAPI Google (`resolveRentCastCandidatesToPortalUrls`),
    then merged into the same candidate pool as Apify + Zillow
    SearchAPI discovery. **Photos and bed/bath facts always come from
    the existing portal scrape stack** (`scrapeListingPhotos` /
    `scrapeListingPhotosDualSource` — Apify-first per Load-Bearing #5).

    Stacked in parallel on:
    - `POST /api/community/fetch-unit-photos`
    - `POST /api/replacement/find-unit` (RentCast leg + existing Google queries)
    - `POST /api/single-listing/find-clean-unit`

    **Requires both** `RENTCAST_API_KEY` and `SEARCHAPI_API_KEY` for
    the RentCast leg to add candidates (harvest alone is useless without
    portal resolution). Disable with `RENTCAST_DISCOVERY_ENABLED=0`.
    Tune on Railway without code changes:
    `RENTCAST_LIMIT_PER_CITY`, `RENTCAST_RESOLVER_MAX_LOOKUPS`,
    `RENTCAST_REQUEST_TIMEOUT_MS`, `RENTCAST_RESOLVER_CONCURRENCY`
    (see `rentCastDiscoveryTuning()` and `docs/rentcast-photo-discovery.md`).

    **Do NOT** call RentCast for photo bytes or bypass Apify/ScrapingBee
    on RentCast IDs. **Do NOT** remove supplemental Realtor/Redfin/Homes
    SearchAPI legs — RentCast expands address inventory, not replace
    those portals.

44. **RealtyAPI is discovery-only for community Realtor inventory — never
    the final photo source.** `server/realtyapi-discovery.ts` paginates
    RealtyAPI `GET /search/bylocation` using a community-first location plan
    (name → canonical street → ZIP → discovery cities), with
    `propertyType=Condo,Townhome`, `hasPhotos=true`, and optional bedroom
    filters. Each hit already includes a `realtor.com/realestateandhomes-detail`
    URL, so this leg **does not** spend SearchAPI credits on address→URL
    resolution (unlike RentCast #43).

    Stacked in parallel on the same three surfaces as RentCast:
    `fetch-unit-photos`, `find-unit`, `find-clean-unit`. Disable with
    `REALTYAPI_DISCOVERY_ENABLED=0`. Requires `REALTYAPI_API_KEY` only
    (no SearchAPI dependency for this leg).

    **Do NOT** skip `scrapeListingPhotos` because search results include
    thumbnail URLs. **Do NOT** remove Apify/RentCast/Google legs — RealtyAPI
    is the primary Realtor URL harvester, not the only discovery source.

### Inbox auto-reply

24. **Auto-reply has a three-layer safety stack — input filter,
    Claude self-flag, output filter.** Generated replies are
    AUTO-SENT to the guest by default; the layers exist so a wrong
    auto-send is harder to produce than a wrong draft.

    **Layer 1 — input keyword filter** (`RISK_KEYWORDS` in
    `server/auto-reply.ts`). If the GUEST'S message contains any of
    the listed terms (refund, cancel, pet, smoke, party, early
    check-in, lockout, lawyer, …), the reply is forced into the
    "flagged" path — Claude still drafts so the host has something
    to send, but the message never auto-sends. The list is grouped
    by category in the source. **When in doubt, add a keyword** —
    a false positive is one extra click; a missed case can be a
    refund we didn't authorize.

    **Layer 2 — Claude self-flag.** The system prompt tells the
    model to call the `flag_for_human` tool whenever it can't
    answer confidently from fetched context, or whenever the
    request touches money / schedule changes / policy exceptions /
    health / safety / legal / reviews / press / operational
    issues. The tool exits the run with `flagReason` set; the
    auto-reply records "flagged" status without sending.

    **Layer 3 — output regex filter** (`OUTPUT_RISK_PATTERNS`).
    Even when input passed the keyword filter and Claude didn't
    self-flag, the generated reply is scanned for forbidden
    commitments — "I'll refund", "we can comp", "pets are fine",
    "early check-in is ok", a 4–6 digit number adjacent to "code"
    (access-code leak), etc. Any match downgrades to "flagged" so
    the host reviews before send.

    The system prompt explicitly enumerates what the AI MAY answer
    on its own (factual property questions answered from tool-
    fetched context) vs what it MUST flag (anything that costs
    money, changes the booking, grants an exception, or addresses
    a complaint/safety issue). Adding a new "auto-send-OK" topic
    means widening the prompt's "WHAT YOU MAY ANSWER" list.
    Adding a new "always draft" topic means at minimum adding
    keywords to `RISK_KEYWORDS`; for high-stakes categories,
    also add an output pattern in `OUTPUT_RISK_PATTERNS`. See PR
    that added this entry.

48. **The Inbox header badge counts pending AI-draft approvals + missed
    calls — NOT unread messages — and stale drafts are auto-swept.**
    `AppHeader.tsx` `inboxAlertCount = pendingDraftCount + missedCallCount`;
    `pendingDraftCount` is auto-reply logs with status drafted/flagged/error,
    not sent, not dismissed. Reading a conversation does NOT clear it — a draft
    clears only when sent or dismissed. To stop the badge inflating with stale
    drafts, `dismissHandledAutoReplyDrafts` (run on every `/api/inbox/auto-reply/logs`
    fetch) dismisses a pending draft when ANY of: (a) the host already replied
    after the trigger, (b) it is **superseded** — an older pending draft for a
    conversation that has a newer pending draft (newest-per-conversation wins),
    or (c) the reservation was **canceled/declined/expired** (a system
    cancellation log at/after the trigger). Don't revert to host-reply-only
    dismissal — superseded duplicates and canceled-reservation drafts were
    inflating the count. Genuinely-pending drafts (guest's last message
    unanswered, reservation live) intentionally remain until sent/dismissed.

### Guest alternatives page

46. **The community blurb on `/alternatives/:token` is CURATED-FIRST, not
    AI-first.** The runtime drafter `draftAlternativeCommunityDescription`
    (`server/routes.ts`) is deliberately forbidden from naming amenities it
    can't confirm (it would hallucinate pools/beaches/golf — see PR #563/#564),
    so for every community we actually operate in we keep an accurate, web-
    researched, fact-checked blurb in `server/community-descriptions.ts`
    (`CURATED_COMMUNITY_DESCRIPTIONS` + `resolveCuratedCommunityDescription`).
    Both the build-time drafter AND the GET renderer call the resolver FIRST:
    - **Drafter:** curated match → return it (`generatedBy: "curated"`),
      otherwise fall through to the existing AI / deterministic-fallback path.
    - **Renderer:** curated match → render it, EVEN IF `payload.communityDescription`
      is already populated (upgrades old pages to the rich blurb without a
      rebuild). Otherwise the persisted blurb is reused ONLY when it actually
      refers to this community (`normalizeResortText(persisted).includes(
      normalizeResortText(label))`); a persisted blurb that doesn't fit is
      dropped in favor of the community-NAMED deterministic fallback. Don't
      "fix" the renderer to trust the persisted field unconditionally.

    **Resolution is community-FIRST; the area is consulted ONLY when the
    community slot is empty (or is itself the area name).** This is the fix for
    the "header says the community, body describes the city" bug: an unknown
    community we don't curate (e.g. "Villas of Kamali'i") must return `null`
    so the caller renders a community-NAMED blurb — it must NOT inherit its
    area's city blurb ("Princeville is…"). Do NOT re-add a blanket
    community-then-area fallback (`matchCommunity(community) ?? matchArea(area)`),
    which is exactly what caused the regression. Each entry's descriptions are
    amenity-rich on PURPOSE (the operator asked for in-depth community copy) but
    stay within the guest-copy safety stack: no prices, owners, booking
    platforms, unit/building numbers, or addresses. **Only add an amenity to an
    entry if it's confirmed across credible sources** — a guest must never be
    told a community has something it lacks. Aliases must include the short form
    (e.g. "Kaha Lani" as well as "Kaha Lani Resort") and, for a community whose
    own name a guest will see, its specific entry (e.g. "Villas of Kamali'i")
    rather than relying on the area.

47. **Unit galleries on `/alternatives/:token` are screened so a guest can't
    identify the exact listing.** Scraped VRBO photos arrive as bare URLs with
    no captions/tags (the sidecar grabs only `img.src`/`srcset`), so there is
    nothing to filter on cheaply — screening needs vision. Two layers, by
    design:
    - **Build-time vision screen** (`server/unit-photo-vision.ts`
      `filterNonRentalUnitPhotos`, called per unit in the `/api/booking-alternatives`
      and `/from-vrbo` hydration). ONE **Sonnet** call per unit, images sent BY
      URL (no download), per-unit calls run in parallel. It removes photos a
      guest could identify the property from — a legible building/unit number,
      address, or property-manager logo — plus maps/floor plans/screenshots/docs.
      **Sonnet, NOT Haiku, on purpose:** Haiku was empirically inconsistent here
      (flagged `[3,4]` one run, `[3,4,25]` the next, false-positived an interior
      bedroom) and MISSED the building-number exterior/entrance shots, so the leak
      photos survived — the exact bug the operator reported. Sonnet returns the
      identifying shots reliably with no false positives. This is leak
      prevention; reliability beats Haiku's speed. **Images are normalized to a
      legible width** (`rw=1200` on VRBO/Expedia media URLs) for the request only
      — a thumbnail makes the number unreadable and the screen misses it.
      Conservative: unsure → KEEP; if it would leave < 4 photos it no-ops. On no
      `ANTHROPIC_API_KEY` / error it keeps everything (`filtered: false`).
      Persisted on the item as `photosVisionFiltered` + `photosVisionVersion`
      (= `UNIT_PHOTO_VISION_VERSION`; bump it when the model/logic changes).
    - **Lazy re-screen on render**: a page whose units aren't at the current
      `photosVisionVersion` (built pre-screen, by an older pass, or under a
      no-key build) is re-screened on render and the cleaned result persisted via
      `saveBookingAlternativePage`, so old links self-heal without a regenerate.
      BLOCKING (≤25s cap) for operator/preview loads so the tester sees the fix
      on reload; BACKGROUND for guest loads so they take no latency. An
      in-memory token guard prevents duplicate concurrent migrations.
    - **Render-time tail trim** (the GET renderer): drops the last 5 photos of
      each unit gallery (with a floor), because the PM logo / unit-number-on-
      building shots also cluster at the end. It is **SKIPPED only when the unit
      is screened AT THE CURRENT VERSION** (`photosVisionFiltered === true &&
      photosVisionVersion === UNIT_PHOTO_VISION_VERSION`); otherwise it runs as a
      partial backstop until the lazy re-screen persists. Don't make the trim
      unconditional (it would re-trim cleaned galleries) and don't drop it (old
      pages rely on it). The screen is bounded to 45 images.

### Portal authentication

35. **Portal-wide auth gate is a single shared password keyed by
    `ADMIN_SECRET` env var, with FOUR exclusions that are load-bearing:
    sidecar endpoints, loopback self-calls, static assets, and the
    /login flow itself.** Lives in `server/auth.ts`. The middleware
    is mounted in `server/index.ts` BEFORE `registerRoutes` and
    `serveStatic`. **No-op when `ADMIN_SECRET` is unset** — that's
    the default state on the deploy as of 2026-05-04, kept for
    backward compat so cold deploys + local dev work without env
    config. The operator opts in by setting the env var on Railway.

    The four exclusions and why each one is load-bearing:
    - **`/login` + `/logout`** — auth flow itself. Gating them is a
      chicken-and-egg.
    - **`/api/admin/vrbo-sidecar/*`** — the local-Chrome sidecar
      worker (Decision Log 2026-04-29) on the operator's Mac polls
      `/next` / `/heartbeat` / `/result` / `/cookies` /
      `/visual-date-controls`. Gating these breaks find-buy-in's
      most-reliable Vrbo path. The sidecar runs on the operator's
      own machine; the channel is implicitly trusted, and the
      sidecar can't easily be redeployed with a fresh secret every
      rotation.
    - **`/assets/*` + `/photos/*` + favicon / manifest / robots** —
      the SPA shell + login page can't render without their JS/CSS,
      and PWA shells / crawlers expect those root files.
    - **`127.0.0.1` loopback** — `availability-scheduler.ts` does an
      HTTP self-call to `/api/admin/refresh-all-market-rates` once
      per scheduled tick. The bypass uses `req.socket.remoteAddress`,
      NOT `req.ip` / `X-Forwarded-For` — Railway's edge sets XFF to
      the client IP and an attacker could spoof "127.0.0.1" via XFF;
      the raw socket is the only safe signal.

    Auth modes: (a) browser cookie set by POST /login — value is
    `HMAC-SHA256(secret, "nexstay-portal-authenticated-v1")`, no
    server-side session storage; rotating the env var invalidates
    every existing session. (b) `X-Admin-Secret` request header for
    CLI/curl/scripts — same secret, matches Load-Bearing #32's
    pattern.

    Cookie is HttpOnly + SameSite=Lax + Secure-in-prod, 30-day
    Max-Age. Open-redirect guard on POST /login: `next` param must be
    a same-site relative path. Login page is INTENTIONALLY inline
    HTML (not React) so the unauthenticated request doesn't load the
    ~1 MB SPA bundle.

    Client side: `client/src/lib/queryClient.ts` `apiRequest` and
    `getQueryFn` detect 401 responses and redirect to
    `/login?next=...`. A `_redirectedToLogin` one-shot guard prevents
    parallel 401s (TanStack Query fans queries out aggressively)
    from racing multiple navigations.

    **Do NOT widen the public path list** without a matching
    Decision Log entry. Each whitelisted prefix is a hole in the
    gate — every other `/api/*` route can reach the operator's
    Guesty session cookies, Anthropic key, etc., so the bar for
    adding a new exception is high. If a future workflow needs an
    open path, prefer carrying the secret in the
    `X-Admin-Secret` header from the calling code.

## Conventions

### Branches
- Feature branches: `claude/<slug>` (e.g. `claude/cover-community-patio`)
- Hotfixes: same prefix, descriptive slug
- Only the human merges to `main` normally; Claude Code self-merges
  its own PRs via `gh pr merge --admin` (see Roles section above).

### Commits
- Conventional prefixes: `feat:` / `fix:` / `refactor:` / `chore:` / `docs:`
- Commit body explains *why*, not just *what*
- Reference the PR number when fixing a previous PR

### Pull requests
Every PR body must contain:
1. **Summary** — what changed and why (the rationale)
2. **Test plan** — what the human or a reviewer should check
3. **Intentional deviations** (if any) — if you broke a pattern on
   purpose, say so, so reviewers don't flag it as a bug

### Tests
- `tests/pipeline-logic.test.ts` — deterministic unit tests, run with
  `npx tsx tests/pipeline-logic.test.ts`
- `tests/e2e-*.spec.ts` — Playwright against the live Railway URL.
  Used to verify post-deploy behaviour.
- New load-bearing decisions should add a test that would fail if the
  decision were reverted.

## Decision Log

Append one line per resolved dispute. Format:

```
YYYY-MM-DD · <source of flag> · <decision> · <one-line rationale>
```

Examples:

```
2026-04-23 · Codex flagged narrow scraper walker as "missing defensive fallback" · REJECTED · intentional; see Load-Bearing #1 (PR #21 rationale)
2026-04-23 · Codex flagged unlabeledResults drop as "silent data loss" · REJECTED · intentional; see Load-Bearing #3 (PR #9 rationale)
2026-04-24 · Jamie said "never merge" guardrail was wasting turns — "it's clicking a button" · ACCEPTED · Claude Code now self-merges via `gh pr merge --admin` (main's required checks aren't wired for claude/* branches so override is the standing path). Human still merges when desired.
2026-04-27 · Jamie asked auto-fill to use Airbnb as a real bookable last resort, overriding the long-standing "Airbnb is footgun for auto-fill, TOS bars sublet" rule · ACCEPTED · Auto-fill now walks `sources.airbnb` after PM/Booking/Vrbo all return nothing usable. Buy-in notes get a `⚠️ Last-resort Airbnb pick — Airbnb TOS prohibits sublet` suffix and the toast surfaces the count separately so the operator handles the booking channel manually. Server's `cheapest` still excludes Airbnb (Booking/PM remain preferred); the fallback lives in `bookings.tsx` auto-fill.
2026-04-27 · Jamie corrected an in-progress "Browserbase + Anthropic computer-use loop for Vrbo search" with "use Stagehand, that's what their browser agent is meant for" · ACCEPTED · Vrbo search agent uses `@browserbasehq/stagehand` (DOM-mode `agent.execute()` for the search-flow UI + `extract()` with a Zod schema for structured property data) rather than rolling our own screenshot/action/observe loop against the raw `claude-sonnet-4-5` `computer_20250124` tool. Stagehand handles the loop, retries, and DOM grounding internally; same path director.ai uses. Lives in `server/stagehand-vrbo-search.ts`, wired as Vrbo path 7 (highest priority in dedupe — most likely to actually return priced data because it drives the real UI).
2026-04-27 · Jamie wanted a search system that "encompasses everything" including PM discovery via Stagehand · ACCEPTED with escalation gating · Two PRs: (a) widened existing photo-match caps (TOP_AIRBNB_FOR_LENS 15→30, per-anchor 3→6) — cheap and high-impact; (b) added `server/stagehand-pm-finder.ts` that drives Google like a human, dismisses overlays, scrolls past PAA/Maps panels, and extracts long-tail organic PM URLs. PM finder fires only when `priced bookable < 3` from cheap paths (booking + PM Google + per-PM sitemaps + photo-match) so we don't pay $0.30 on every find-buy-in. Returned URLs are unpriced (agent doesn't drive each PM's availability widget; that's `verifyPmRate`'s job).
2026-04-28 · Jamie: "I want Airbnb to be completely involved in this search now like it was in the previous versions of the buy in tool. Do not exclude it anymore, always include in the cheapest options." · ACCEPTED, supersedes 2026-04-27 entry above · Server's `cheapest` pool now includes `airbnbWithMatches` alongside booking + pmAugmented. Airbnb engine results auto-marked `verified: "yes"` (the engine queries with check_in / check_out, so listings returned ARE date-specific available). Vrbo stays excluded from cheapest (same TOS sublet bar but no engine-level date verification — surfacing as "buy this" is a footgun without the verification gate). The TOS-sublet warning suffix in auto-fill notes is preserved — it's a billing-flow concern, not a discovery-flow concern, and the operator wants visibility into the actually-cheapest option regardless of channel.
2026-05-04 · Jamie asked for an "Add a Single Listing" dashboard button that mirrors Add Community but for a standalone condo/townhouse, with a Zillow-search → OTA-clean qualifier as the gate · ACCEPTED, option A (no community research scan) · New 4-step wizard at `/add-single-listing` cloning the relevant pieces of `add-community.tsx`. Reuses `community_drafts` table with a new `singleListing` boolean flag rather than a parallel table — see Load-Bearing #33 for the rationale (one shared shape across the stack, branching only at adapters). New `/api/single-listing/qualify` endpoint runs SearchAPI site:airbnb/vrbo/booking searches and hard-blocks save when any platform shows a confirmed match (Load-Bearing #34). `/api/community/generate-listing` got a branched prompt for single-unit framing; `/api/community/fetch-unit-photos` now also returns `facts: { bedrooms, bathrooms }` so the single wizard can size defaults from the Zillow scrape (additive, combo unaffected). All "what I added" surfaces carry `CODEX NOTE (2026-05-04, claude/single-listing)` comments per Jamie's instruction.
2026-05-04 · Jamie followed up with three asks for the find-clean-unit flow: (1) ensure photos are scraped + downloaded with the discovered unit; (2) "is utilizing the same methodology for checking and ensuring the unit isn't on Airbnb, VRBO and/or Booking.com as the pre flight check for when we add a new community/combo listing? That check is very good and thorough and I need to make sure that this new tool utiizes the same methodology"; (3) bedroom selector should reflect what the picked community actually offers (e.g. Santa Maria → 2BR/3BR only, not generic 1-5BR). · ACCEPTED · (1) Already worked end-to-end (find-clean-unit returns photo URLs from scrapeListingPhotos, wizard stashes them in state, persist-photos downloads on save) — verified with the existing flow. (2) Ported preflight's photo-search logic into a new `runPhotoReverseSearch` helper and wired it into `runOtaQualifier`; Lens runs on the first 3 Zillow CDN URLs with no ImgBB upload step (URLs are already public). A platform counts as "listed" when EITHER text-search OR photo-search finds a match. UI surfaces "X address / Y photo" match badges. Load-Bearing #38. (3) `researchCommunitiesForCity` single-mode prompt now asks for `availableBedrooms[]` per community; the wizard's bedroom selector renders only those buttons, with a fallback to 1-5BR when Claude returned an empty array and an inline note telling the operator whether the picker is confirmed or generic. Load-Bearing #39.
2026-05-04 · Jamie tested Fort Myers Beach in the single-listing wizard and Santa Maria Resort wasn't surfacing in the community list — followed up: "Also, when I click a resort, I should not need to enter a street address etc. I should just like select the say the bedroom count and click continue and then it automatically search Zillow for that resort and that bedroom count and find a unit with that bedroom count and then scan to make sure it's not on Aibnb,VRBO, and/or Booking.com. If it is listed on any of those sites please then find another unit." · ACCEPTED · Two-PR ship: (1) `researchCommunitiesForCity` got a `mode` param — single mode drops combinability filter, lifts world-knowledge cap 3→15, returns up to 20, runs on Sonnet, uses an expanded 5-query SearchAPI sweep, and includes per-market example-resort lists in the prompt as a recall anchor (Load-Bearing #36). (2) New `/api/single-listing/find-clean-unit` endpoint does Zillow discovery + scrape + bedroom-match filter + OTA qualifier per candidate, returning the first clean match with photos pre-loaded; the `runOtaQualifier` helper extracted from the original `/qualify` endpoint is shared between both paths. Wizard Step 1 replaced the operator-typed propertyName + streetAddress fields with a bedroom-count picker + "Find a clean {N}BR unit" button; Step 2 now displays the auto-discovered unit + qualifier with a "Try another unit" button (re-calls the endpoint with skipUrls). Manual-mode escape hatch preserved for resorts not on Zillow. (Load-Bearing #37.)
2026-05-04 · Jamie reviewed the deployed Step 1 form ("4 fields: name + address + state + city") and asked to switch it to a discovery flow: "type a city → drop down list of cities → top 20 best vacation rental communities to choose from." Follow-up: "for now just keep it focused on Hawaii and Florida." · ACCEPTED · Step 1 of `add-single-listing.tsx` rewritten as: nationwide city autocomplete (new `/api/community/city-suggest-any` endpoint, Photon + state allowlist) → kicks off `/api/community/research` automatically on city pick → top-20 community cards → operator picks a community (or hits "enter manually") → fills the unit-specific street address. Picked community pre-fills `propertyName`. Hawaii + Florida scope lives in `ALLOWED_STATES` set in the new endpoint — see Load-Bearing #35. Combo flow's existing state-scoped city-suggest endpoint is untouched; only the new single-listing wizard uses the nationwide variant.
2026-05-05 · Jamie reported Add Single Listing could not find clean units and suspected Apify was returning no results · ACCEPTED · Production debug showed the default Zillow search actor was a 404 (`epctex~zillow-scraper`) and the default Realtor actor was not rented (`epctex~realtor-scraper`). Defaults now use runnable actors (`igolaizola~zillow-scraper-ppe`, `dz_omar~realtor-scraper`) with actor-specific input shapes, and find-clean-unit now accepts a candidate only after scraped photos pass the Google Lens OTA check, restoring parity with the combo preflight photo methodology.
2026-06-04 · Jamie asked to integrate RentCast API into photo-search discovery alongside Apify and Zillow · ACCEPTED · Four-PR ship (#503–#506): RentCast client, `fetch-unit-photos` 3-leg stack, find-unit + find-clean-unit wiring, AGENTS #43 + Railway tuning env vars. RentCast supplies addresses only; SearchAPI resolves to portal URLs; scrape stack unchanged.
2026-04-29 · Jamie: "You are not running the browser session locally like I asked. You have to run the browser on my PC." After multi-PR investigation showed Vrbo's anti-bot fingerprints every Browserbase residential session even with persistent context + real-Chrome cookies (IP-level flag — "There is a robot on the same network as you"). Direct Chrome MCP test from operator's home IP returned 42 priced properties for the same query that Browserbase couldn't load past the bot wall. · ACCEPTED · New "VRBO local-Chrome sidecar" architecture: in-memory queue on Railway (`server/vrbo-sidecar-queue.ts`) bridges find-buy-in to a `/loop` worker running inside the operator's Claude Code session. find-buy-in calls `searchVrboViaSidecar()` as path 9 (parallel with the existing 8 paths, prioritized FIRST in the dedup chain when results return because it's the only path that beats the IP wall). When the worker is offline, the wallet budget (75s) expires and we gracefully fall back. Endpoints `POST /api/vrbo-sidecar/enqueue`, `GET /api/admin/vrbo-sidecar/next`, `POST /api/admin/vrbo-sidecar/result`, `GET /api/vrbo-sidecar/result/:id`. Worker is a /loop task in Claude Code that polls /next, drives Chrome MCP through Vrbo's search UI on the operator's actual browser, extracts priced cards, and POSTs the result. This is the "OpenClaw"-style local-agent pattern — Claude Code on the operator's Mac is the bridge between Railway and their real-IP browser.
2026-06-06 · Jamie asked for a dashboard "guest cancelled — payment on file" alert with a "confirm refund done" checkbox, refunds reflected in the payments-taken tile, and a revenue-past-30-days/48-hours box · ACCEPTED · The cancellation-audit infra already existed (`reservation_cancellation_audits` + `operatorStatus` + `PATCH /api/operations/cancellations/:id`), so this is mostly UI wiring: (a) prominent red alert banner in `home.tsx` listing every audit where `operatorStatus==="needs_review" && totalPaid>totalRefunded`, each with "Confirm refund done" (→`refunded`) / "No refund due" (→`no_refund_due`) buttons; resolving drops it out of `reviewNeeded` so the banner self-clears. Same control added to the cancellation modal detail panel (+ Reopen). (b) `dashboardRevenue30DayHandler` now also returns `refunds30Days/48Hours`, `refundCount*`, `netCollected*` and a `refunds[]` list (separate refund pass — `reservationPaymentItems` still excludes refunds so gross-collected stays pure); the "Funds collected" tile shows a refund/net line + a refunds table. NOTE: refunds are only counted for reservations already in the 30-day-created fetch set, same window limitation as the existing collected-payments figure. (c) New "Revenue, past 30 days / 48 hours" KPI card backed by `revenue`+`bookingCount` and new `revenue48Hours`+`bookingCount48Hours`; KPI grid widened to `lg:grid-cols-6`. (d) `GET /api/dashboard/cancellations` now fires a throttled (20 min), single-flight background `runAllCancellationAuditScans` so the alert populates without a manual "Refresh from Guesty" (was scan-only before).
2026-06-06 · Jamie asked the Operations bulk-queue buy-in to use the resort-name-on-VRBO → city-wide-VRBO fallback methodology for every queued booking · ACCEPTED · The bulk queue already shares `autoFillMutation` (resort combo → `/api/operations/city-vrbo-inventory` combo fallback) so 2-unit configured properties were already covered. Gap: single-unit reservations (e.g. Keauhou #2) and the leftover slot of a partially-filled booking got resort search only. Fix: (a) relaxed the `city-vrbo-inventory` endpoint gate from `units.length >= 2` to `>= 1` (`suggestedPair` stays null for 1-unit plans, so combo behaviour is unchanged); (b) added a per-slot single-unit city-VRBO fallback at the END of `autoFillMutation` (after resort search leaves slots empty) — picks cheapest unused `byBedroom[bedrooms]` row, attaches with `attachSource:"city-vrbo"` (skips the resort-name reject filter), gated to `staticUnitConfig` present. Server caches the city scrape by (community,checkIn,checkOut) so the combo + single paths only drive the VRBO sidecar once per reservation. Bulk-queue MECHANICS verified unchanged (sequential, `silent:true` suppresses per-item toasts, cancel + server logging intact). VRBO sight+click policy preserved — the city path is the approved sidecar path, no injected `/search?` URLs.
2026-06-06 · Jamie reported the "Message guest about the move" relocation draft named the guest's ORIGINAL community ("Mauna Kai Princeville") instead of the new one they were moved to · ACCEPTED · Root cause: the client sends `propertyLabel = prox.resortName` from `/unit-proximity`, and `estimateAttachedBuyInProximity` returns `resortName = displayResort ?? configuredResort` — it falls back to the CONFIGURED community when the attached units' titles don't resolve a shared resort. `buildRelocationGuestMessage`'s caller (`POST /api/booking-alternatives`) then used `req.body.propertyLabel` FIRST, so it named the original. Fix (message call site only): derive the named place from the ATTACHED units' OWN titles (`commonResortNameFromTitles` for ≥2, else `communityFromAlternativeTitle`), and NEVER name the original — if the derived label `sameCommunityContext` the reservation's `originalCommunity` (or nothing resolves), `propertyLabel=null` so the builder uses neutral "comparable replacement stay ... in the same area" copy. Left the `/from-vrbo` call site alone (operator supplies the new propertyName there). The walk card was already relabeled by PR #530; this only fixes the message text.
2026-06-06 · FOLLOW-UP (replaces the title-PREFIX derivation in the entry above): Jamie reported the message then named NO community at all (neutral copy) for the real booking · ACCEPTED · The prefix-based `commonResortNameFromTitles` returned null because the new community is mid-title, not a prefix: the real VRBO titles were "Tropical End Unit Townhouse! Villas of Kamalii 30" / "Island Living at Villas of Kamalii 39" (community = "Villas of Kamalii", buried), and the buy-in notes carry it as the lowercase city-combo phrase `· villas of kamalii —`. New module-level `extractNewCommunityFromUnits(titles, notes, originalCommunity)` in `routes.ts` (used at the `POST /api/booking-alternatives` message call site): primary = longest common CONTIGUOUS token phrase across the unit titles (casing from the title, generic/marketing/size edges trimmed, must contain a distinctive token); fallback = the combo-note resort phrase title-cased (casing borrowed from a title when present). Still NEVER returns `originalCommunity` and returns null → neutral copy when nothing confident resolves. Designed + executably verified via a 4-agent Workflow (3 strategies each self-tested with node) + an independent local 8/8 battery run incl. the exact Cecilio data and an adversarial "title mentions BOTH original and new resort" case. The earlier `commonResortNameFromTitles`/`communityFromAlternativeTitle` derivation at this call site is REPLACED by this function.
2026-06-06 · FOLLOW-UP #2 (same relocation message): live test showed it STILL went neutral even though extractNewCommunityFromUnits correctly returned "Villas of Kamalii" · ACCEPTED · Root cause downstream: `buildRelocationGuestMessage` re-ran `communityFromAlternativeTitle(args.propertyLabel)`, whose title-lead reject regex `^(...|villas?|condos?|gardens?|...)\b` discards any community name that STARTS with a category word — so it stripped the (already-validated) "Villas of Kamalii" back to "". Fix: the builder now uses the LIGHT guard `usableCommunityContext(args.propertyLabel)` instead (rejects only internal-notes + bedroom-size leads), since the caller already resolves a clean community. Don't reintroduce `communityFromAlternativeTitle` on an already-validated propertyLabel — it false-rejects "Villas of/at X", "Gardens at X", etc. Verified live: message now reads "...arranged a comparable stay for you at Villas of Kamalii."
2026-06-07 · Jamie reported the sidecar Chrome "pops up and closes over and over in a loop" on guest-page creation and said "if you can't fix it, just remove the feature... I don't mind clicking Safari again when Chrome pops up and takes focus" · ACCEPTED, REVERSES the 2026-06-06 focus-guard default · Two causes: (1) `recoverDeadLocalCdp` treated a `--no-startup-window` browser's empty page-target list as DEAD and close+relaunched it (fixed in PR #557 — reachable-but-tabless is alive, create a tab via `Target.createTarget`); (2) the macOS foreground management (`scheduleReturnFocus` via `open -b` at 100/350/750/1400ms + `scheduleSidecarMinimize`/`minimizeSidecarWindow`) fighting the CDP page-create's activation made Chrome visibly flap. Per operator request both are now DISABLED: new `SIDECAR_AUTO_MINIMIZE` env (default still ON in code via `!== "0"`, gates `scheduleSidecarMinimize`+`minimizeSidecarWindow`) and the existing `SIDECAR_RETURN_FOCUS` are BOTH set to `0` in the live run script AND defaulted to `0` in `scripts/install-vrbo-sidecar-launchagent.sh`. Net: Chrome may take focus once when it activates; the operator clicks their app back; NO flapping loop. CAPTCHA window surfacing (`SIDECAR_CAPTCHA_SURFACE_WINDOW=1`) is untouched. Verified live: a real `vrbo_photo_scrape` acquire now logs ONE spawn, no "relaunching", no "minimiz", and `open -b` fired 0 times across the whole job. Supersedes the 2026-06-06 CLAUDE.md focus-guard note's "default on" stance — to re-enable, set `SIDECAR_RETURN_FOCUS=1` / `SIDECAR_AUTO_MINIMIZE=1`.
2026-06-07 · Jamie asked to make the guest-inbox AI draft "an expert on every community and its surrounding areas" using Claude's OWN world knowledge + guardrails (NOT a curated KB) · ACCEPTED (Part A of the local-expert + auto-send plan) · This deliberately RELAXES Load-Bearing #24's "draft only from fetched context, not generic knowledge" posture — but ONLY for AREA/orientation questions (beaches, dining, activities, getting around, weather), never for property facts (beds/layout/amenities/policies stay fetch-or-flag) and never for the money/policy FLAG categories. Both draft surfaces got an "EXPERT LOCAL KNOWLEDGE" prompt block (`server/auto-reply.ts` SYSTEM_PROMPT + a `LOCAL_KNOWLEDGE_RULES` const in `server/routes.ts` ai-draft) with hard anti-hallucination guardrails: anchor to the property's exact island/town (new `shared/area-identity.ts` `resolveIslandRegion(address)`, surfaced via `get_local_property_facts` `island`/`town`/`areaIdentity` + the client `buildPropertyContextForDraft` AREA line + now also neighborhood/transit which the manual path previously omitted); NEVER state exact prices/hours/"open now"/phone numbers/addresses; hedge distances; tell guests to verify time-sensitive specifics; describe the TYPE not an uncertain named business. Deterministic backstop: new `OUTPUT_RISK_PATTERNS` (phone numbers, current-hours claims, external prices) auto-FLAG any draft that slips a verifiable specific, so it's held from the (future) auto-send. Don't widen world-knowledge to property facts or policies. Part B (aggressive auto-send) is a separate follow-up; until it ships nothing changes about send behavior (all drafts still wait for approval).
2026-06-07 · Jamie said "build part B now" (the aggressive auto-send engine) · ACCEPTED · Ships with the master toggle DEFAULT OFF (persisted), so deploying changes nothing until the operator flips it on. New `app_settings` kv table (`getSetting`/`setSetting`) holds `auto_send.master_enabled` (false), `auto_send.review_window_seconds` (90), `auto_send.hold_recommendations` (true). New `auto_reply_log` columns `autoSent` + `sendAfter`, new `"queued"` status. When the toggle is ON, `runAutoReply` sets a clean `drafted` result to `queued` with a `sendAfter` deadline; a SEPARATE pass `runAutoSendQueue()` (own 20s interval, started in `startAutoReplyScheduler`) sends due queued rows. HARD EXCLUSIONS that never auto-send: anything `flagged`/`error` (the full 3-layer stack still gates everything), unmapped listing (`!listingId`), empty draft, and — while `hold_recommendations` is on — drafts whose guest message looks like an area/recommendation ask (`looksLikeAreaQuestion`). Before each send the pass RE-VALIDATES: re-checks the toggle (kill switch), re-fetches the row (operator edits/declines win — editing a `queued` draft reverts it to `drafted` via `saveDraftedReply`), re-runs `hasManualHostReplyAfterTrigger` (a human reply → `dismissed`), and re-runs `classifyOutput`. Toggling OFF reverts all `queued` rows back to `drafted`. Endpoints: `POST /api/inbox/auto-reply/auto-send/{toggle,config,run}`; `getAutoReplyStatus()` now carries the auto-send config. UI: amber "Auto-send clean drafts" switch + review-window select + banner in the AI Draft Approval card; per-draft "Auto-sending in Xs" countdown badge + a Hold button + an "Auto-sent" badge. **Do NOT enable auto-send against the live inbox without a dry-run to a test conversation first.** Recommended rollout (from the approved plan): soak Part A in the approval queue ~1-2 weeks, then enable with hold_recommendations=true + a non-zero window, then relax.
2026-06-07 · Jamie asked the buy-in tool to add a fourth fallback rung: after resort search → city-wide VRBO finds no combo, auto-research the cities within a 20-min drive and city-scan each; if still none, expand to 45 min, scanning all cities not already searched · ACCEPTED, background-job + polling, combo-only (Jamie's choices via AskUserQuestion) · New `server/city-vrbo-expansion.ts` (in-memory job store + worker + Photon `/reverse` drive-time town discovery anchored on `BUY_IN_MARKET_LOCATIONS` coords) + 3 endpoints under `POST/GET /api/operations/city-vrbo-inventory/expand[/:jobId[/cancel]]`. `runCityVrboInventoryScan` was generalized (extracted `runCityScanCore`; added exported `runCityVrboInventoryScanForCity` with a DISJOINT `term:…|city-vrbo-term-v1` cache namespace). Client `autoFillMutation` starts the job when the home-city scan ran worker-online with no pair, hands it to a row poller (`CityExpansionJobPoller`) that attaches the found combo (no-clobber) or re-invokes auto-fill `skipExpansion:true` for the per-slot net; bulk queue polls inline (`awaitExpansionInline`). Built via a 4-agent design workflow + a 23-agent adversarial review (10 findings confirmed + fixed: healthy-worker wallet-timeout vs offline reconciliation, provider-cooldown short-circuit, attach-button mid-attach race, found-but-not-attachable safety-net fall-through, poller 401/deadline terminal, unmount-cancel, skipExpansion home-scan skip). See the "Drive-time nearby-city combo expansion" Load-Bearing subsection above for the 6 load-bearing constraints. Verified: `npm run build` clean, `tests/city-vrbo-expansion.smoke.ts` 8/8 (combo-only gate, single-flight, offline fast-bail), Photon discovery returns a sane Kauai ladder for Poipu Kai. Live VRBO leg verified on Railway post-deploy.
2026-06-08 · Jamie reported that running "Auto-fill cheapest" from iPhone Safari, then leaving the app, made the search "basically pause" and produce nothing on return · ACCEPTED, PR #588 (`claude/mobile-buy-in-search-resilience`) · Root cause is a CLIENT mobile-resilience gap, NOT a server cancellation (the `booking_search`+`vrbo_search` "server cancelled request" churn in the sidecar log is the scheduled availability pass hitting its 90s per-op wallet budget under single-Chrome-lane contention — confirmed via a 4-agent trace; find-buy-in disables booking and continues detached on disconnect). iOS Safari suspends a backgrounded tab and tears down in-flight fetches (~30s) while freezing JS timers; the find-buy-in scan finishes server-side but `FIND_BUY_IN_TTL_MS=0` deletes the result, so the re-fire on return restarts from zero. **Two LOAD-BEARING decisions in this fix that look like bugs cold — don't "fix" them back:** (1) `server/routes.ts` find-buy-in now WRITES to `findBuyInCache` even though `FIND_BUY_IN_TTL_MS=0` — these are RECOVERY-only entries (trustworthy+priced+complete, 120s `FIND_BUY_IN_RECOVERY_TTL_MS`) read ONLY by a `?recover=1` re-fire (`allowRecoveryCache`), never by a normal interactive search, so the "buy-in scans always run live" invariant holds; the Auto-fill client (`getFindBuyInForBedrooms`) always sends `recover=1` so its retry/resume is idempotent within the window. (2) `CityExpansionJobPoller` (`client/src/pages/bookings.tsx`) no longer cancels the server job on a HIDDEN unmount — only on a DELIBERATE (tab-visible) unmount — because a backgrounded/discarded tab killing a live multi-minute sidecar job is exactly the reported bug; a hidden unmount leaves the job to finish under its own 30-min server budget. Also: the poller cap is now cumulative FOREGROUND/active polling time (suspended gaps not billed), not wall-clock-from-mount (which tripped instantly on resume and declared live jobs "lost"); added a foreground-resume tick; added an auto-fill visibility-resume effect that re-fires a transient-interrupted run with empty slots (guarded against re-running abandoned/already-filled searches). Known follow-up NOT in this PR: full iOS page-discard recovery for in-flight combos (persist expansion `jobId` to localStorage to re-attach after a hard reload) — only the suspend-and-return path is fixed. Verified: `npm run build` clean (client+server), `npm run check` adds zero new TS errors in both files (baseline-diffed), Railway deploy `38cdcc5` booted clean + healthy (base 302→/login, gated API 401).
```

(Populate on first dispute.)

## Architecture pointers

- `server/routes.ts` — single big Express router. Zillow scrapers
  (`scrapeZillowViaApify` / `scrapeZillowViaScrapingBee`) live here,
  as do the photo-label + availability endpoints.
- `server/rentcast-discovery.ts` — RentCast sale-listing harvest +
  SearchAPI portal URL resolution for photo discovery (Load-Bearing #43).
- `server/photo-pipeline.ts` — download → label → rename orchestration.
  `downloadAndPrioritize` is the entry point.
- `server/photo-labeler.ts` — Claude Haiku vision classifier. One
  retry with backoff.
- `server/availability-scheduler.ts` — background tick
  (`runFullScanForProperty`) that runs inventory + price + block sync
  per property on the configured interval.
- `client/src/components/GuestyListingBuilder/PhotoCurator.tsx` —
  photo review UI. Cover collage button lives here.
- `client/src/components/GuestyListingBuilder/AvailabilityTab.tsx` —
  availability + pricing UI (scheduler, heatmap, weekly pricing).
- `shared/pricing-rates.ts` — static buy-in rates + season
  multipliers. Edit here to change seasonality.
- `shared/schema.ts` — Drizzle schema, single source of truth for the
  database.
- `server/guesty-playwright.ts` — shared building blocks for any
  Playwright automation against `app.guesty.com`: cookie restoration,
  Okta storage injection, stealth init script, the email/password +
  IMAP-MFA login flow, and `openGuestyAdminPage()` which composes them
  all into a one-call session opener. Add new admin automations on
  top of these helpers; don't re-implement the 500 lines of session
  boilerplate per endpoint. See Load-Bearing #25–27 for the policy.

## Addressed to Codex specifically

You're reading merged code and flagging concerns. A few patterns to
avoid false positives:

1. If you see a narrow whitelist / restrictive filter / explicit drop
   that looks defensive but limited — check this file first. A lot of
   this codebase's pain came from being *too* permissive in
   scrapers/labelers, and several decisions here are deliberate
   tightenings.
2. If you see a drop/delete that could be a retention issue, check
   whether there's a "user override survives" decision documented —
   `hidden` is soft-delete, not hard-delete.
3. If you see what looks like dead code in `photo-pipeline.ts`
   (e.g. `CATEGORY_PRIORITY`, `PER_CATEGORY_CAP`) — it's been left in
   place intentionally in case we want to re-introduce category-based
   ordering as a toggle. Don't remove without human approval.
4. When you flag something real, format the finding as:
   *"PR #N touched X. Decision-log entry (or Load-Bearing #M) says Y.
   Concern: Z."* — makes the arbitration fast.

Welcome. When in doubt, ask the human.
