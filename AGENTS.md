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
   **Coverage transparency: "82 listings" is the >=2BR USABLE count, not the
   harvest (2026-06-08, `shared/city-vrbo-coverage.ts`).** An operator compared
   VRBO's own destination count (Koloa = 144, ALL bedroom counts) against the
   tracker's "82 listings" and read it as the tool missing 62. It wasn't: the
   sidecar harvested 142 of 144 (`rawListings`/`mergedCount`=142,
   `mapHarvest.graphqlTotalCount`=144), and the normalize pipeline correctly
   DROPS <2BR (studios/1BR can't be a buy-in combo unit — `MIN_COMBO_UNIT_BEDROOMS`)
   + unpriced rows: `142 − 55 below-2BR − 5 unpriced = 82 usable`. So the gap was
   a TRANSPARENCY gap, not an under-harvest. `runCityScanCore` now returns a
   `coverage` object (`CityVrboCoverage`: vrboReportedTotal / rawHarvested / usable
   / droppedBelowMinBedrooms / droppedNoPrice / looksComplete) built by the pure
   zero-dep `shared/city-vrbo-coverage.ts`; the home-city escalation carries it
   (`homeCityCoverage`) and the tracker shows "Koloa, Hawaii · 142 of 144 on VRBO ·
   82 usable (>=2BR)" + an "N studio/1BR + M unpriced excluded" note. `looksComplete`
   = `vrboReportedTotal == null || rawHarvested >= floor(0.9 * vrboReportedTotal)`;
   when it's false (a GENUINE pagination shortfall) the server `console.warn`s and
   the tracker shows an amber "scan may be incomplete — try Refresh" line. **Don't
   "fix" the 144→82 gap by removing the <2BR filter** — a 1BR/studio can never be
   a combo unit; the fix is showing the breakdown, not widening the pool. Locked
   by `tests/city-vrbo-coverage.test.ts`.
   **OUT-OF-AREA guard: a mainland namesake must never be harvested/attached
   (2026-06-08, `shared/listing-geo.ts`).** The bulk queue attached a
   "Charming Baton Rouge Retreat ~ 3 Mi to LSU!" (Baton Rouge, LOUISIANA) to a
   Poipu Kai (Kauai, HAWAII) booking: the nearby-city expansion searched
   "Port Allen" (a real Kauai town) and VRBO autocomplete resolved it to
   "Port Allen, Louisiana" (next to Baton Rouge/LSU), harvesting mainland
   listings the matcher then clustered ("baton rouge retreat") + attached. The fix
   is two layers: **(1) daemon (`worker.mjs` `vrboResolvedToNonHawaiiState`)** — the
   destination guard (`stateMatchesExpectedDestination`) rejects a search whose
   RESOLVED `/search?destination=` / title names a non-Hawaii US state, so a
   wrong-region search harvests nothing (`throwIfDestinationMismatch`). **(2) server
   (`city-vrbo-inventory.ts` `normalizeSidecarCandidates`)** — drops any harvested
   listing whose `locationText` names a non-Hawaii state (`droppedOutOfArea`),
   BEFORE the matcher/single-unit-fallback sees it. **Check `locationText` ONLY,
   never the title** — titles are noisy ("Indiana Jones villa", a "Condo, CA King
   Bed" amenity would false-drop). A Hawaii token ALWAYS wins (never over-drop a
   real Kauai unit); ambiguous/no-state → KEEP. Locked by
   `tests/listing-geo.test.ts`.
   **REGION-AWARE update (2026-06-09): the portfolio is NO LONGER Hawaii-only**
   (Florida properties — Santa Maria Resort/Fort Myers Beach, Bonita National — were
   added), and the daemon guard was over-rejecting them (a FL property legitimately
   resolves to "Florida" → was dropped → 0 VRBO inventory). The daemon guard now
   takes the property's EXPECTED state, threaded from the server as
   `vrbo_search` param `expectedState` (full lowercase name; `searchVrboViaSidecar`
   normalizes the parsed location state via a USPS abbr→full map, "FL"→"florida").
   `vrboResolvedToNonHawaiiState(urlDestination, title, expectedState)` rejects a
   non-Hawaii resolution ONLY when it DISAGREES with `expectedState`; default
   (absent/"hawaii") is byte-identical → Baton-Rouge still rejected. `runVrboSearch-
   Variant` appends the state to a `guardDestination` used ONLY in the post-submit
   checks (not the pre-submit homepage-form match). Verified live: FL VRBO 0→35
   exported; Baton-Rouge logic test 5/5. **Don't narrow the daemon guard back to
   reject-all-non-Hawaii.** SIBLING STILL PENDING: the layer-(2) server geo-drop +
   `city-vrbo-inventory.ts` `targetState` still default to Hawaii, so FL COMBO
   bookings' city-wide path needs the same region threading (the current FL
   bookings are single-unit, which only hits the daemon find-buy-in path).
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
   **Bigger-unit fill + walkable-adjacency (2026-06-08).** Two changes target the
   diagnosed root cause of "no pairs" on large-unit plans (a city pool has plenty
   of 2BRs but few 3BRs and ~zero 4BRs, so no single complex holds two big units):
   - **`pickCheapestPlan` now fills a slot with a unit of `>=` the required
     bedrooms** (a 4BR satisfies a 3BR slot), assigning the LARGEST requirements
     FIRST so a scarce big unit isn't consumed by a small slot (a [2,3] plan with
     one cheap 3BR must put it in the 3-slot). Cheapest-first still prefers an
     exact-size unit when available. Don't revert to `=== targetBr`.
   - **`WALKABLE_COMPLEX_CLUSTERS` + `evaluateAdjacencyClusters`**: a curated map
     of complexes within `MAX_BUY_IN_WALK_MINUTES` (~10 min) of EACH OTHER lets a
     pair be drawn ACROSS complexes (e.g. Poipu Kai 3BR + adjacent Kiahuna 3BR).
     It is a STRICT FALLBACK — only evaluated when NO single complex (strong/
     photo/geo) satisfied the plan, so high-confidence same-complex pairs always
     win; `matchSource:"adjacency"`, medium confidence. **OPERATOR-OWNED & must
     stay TIGHT**: a pair from one cluster auto-attaches as "walkable", and VRBO
     hides coords so it CAN'T be auto-verified — only add complexes you KNOW are a
     short walk apart. Canonicals must match `KAUAI_COMPLEX_DICTIONARY`.
   - The diagnostic (`summarizeCityVrboMatching`) no longer counts a listing's own
     SINGLETON photo URL as "matched" (only photo keys SHARED by >=2 listings),
     so the `[city-vrbo-match-diag]` `matched`/`none` counts read true.
   **Multiple bedroom SPLITS per combo (2026-06-08, `shared/combo-splits.ts`).**
   A 2-unit combo can satisfy a booking's TOTAL bedrooms via more than one split:
   a 6BR booking is fillable as 3+3 OR 4+2, an 8BR as 4+4 / 5+3 / 6+2. A combo is
   NEVER more than two units, so alternative splits only exist for total >= 6BR.
   The split logic lives in the **zero-dep leaf `shared/combo-splits.ts`**
   (`comboSplitsForPlan`, `comboSplitLabels`, `hasAlternativeSplit`) so the client
   tracker UI can import it WITHOUT dragging `city-vrbo-combo.ts`'s top-level
   computed state (`FUZZY_SAFE_CANONICALS`) into the browser bundle;
   `city-vrbo-combo.ts` imports + re-exports `comboSplitsForPlan` for back-compat.
   `suggestCityVrboComboPair` is a thin wrapper: `comboSplitsForPlan(plan)`
   enumerates every valid 2-unit split (each unit `>= MIN_COMBO_UNIT_BEDROOMS = 2`,
   the city-scan floor), **configured split FIRST so it wins ties**; the wrapper
   runs the (renamed, unchanged) internal `suggestPairForExactPlan` over the SAME
   city pool per split and returns the CHEAPEST pair across splits. All the #6
   rules apply per split (clustering, walkability, `>=`-bedroom fill, adjacency
   fallback); the winning split is reported in the pair's `bedrooms`. Because it's
   plan-driven, BOTH the home-city scan and the nearby-expansion get it for free.
   This is what makes a city with a 4BR+2BR (but no two 3BRs) in one community
   FILL a [3,3] booking instead of returning "no pair". Paired server-side change:
   **`assignComboPicksToSlots` (`server/auto-fill-job.ts`) is a largest-pick →
   largest-slot bijection**, NOT per-slot exact/`>=` matching — a 4+2 pick set
   must fill [3,3] slots (the 2BR pick legitimately lands in a "3BR" slot; the
   combo already satisfies the TOTAL). For the configured split this is identical
   to exact-bedroom matching and still fixes the same-bedroom "only attached the
   first unit" collapse (#596). The call site derives `pickBedrooms` from
   `pair.bedrooms[i]` (the split), which aligns with `pair.picks[i]` because
   `pickCheapestPlan` writes `picksByIndex[slot.i]`. Locked by
   `tests/city-vrbo-combo.test.ts` (split enumeration + 4+2-fills-[3,3] e2e +
   cheapest-split-wins) and `tests/auto-fill-combo-assign.test.ts` ([4,2]→[3,3]).
   Don't revert `assignComboPicksToSlots` to per-slot `>=` matching — it leaves
   the small pick of a non-configured split unassigned.
   **Tracker UI label (2026-06-08, `client/src/pages/bookings.tsx`
   `BuyInEscalationStages`).** The 4-phase buy-in escalation tracker shows ONE
   line under its header — "Searching 3BR + 3BR or 4BR + 2BR in each phase" —
   computed via `comboSplitLabels(bedroomPlan)` from the SAME leaf the matcher
   uses, so the label can't drift from what's actually searched (largest-first
   normalization + configured-first order are guaranteed by the helper, never
   hand-formatted). It is gated on `hasAlternativeSplit(plan)` so it renders ONLY
   for a genuine 6BR+ TWO-unit combo: suppressed for 5BR/4BR (one combo), for
   single-unit properties, AND for 3-unit configs like `[3,2,2]` (`hasAlternativeSplit`
   is false there, so the line can never misrepresent a non-2-unit property as a
   combo). Wording is "or … in each phase", NOT the operator's literal "then":
   every phase tries ALL splits simultaneously and takes the cheapest pair — it is
   NOT a sequential fallback, so "then" would misrepresent it. `bedroomPlan` is
   passed from `PROPERTY_UNIT_CONFIGS[selectedPropertyId].units` (the same config
   the server's city-vrbo-inventory endpoint derives its plan from → label matches
   search by construction). Locked by `tests/combo-splits.test.ts`.
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
   per-tier caps (env `CITY_VRBO_EXPANSION_TIER{1,2}_*`). **City caps are 8/8
   (raised from 4/5, 2026-06-08):** at 4/5 the walk stopped at the ~9 NEAREST towns
   (all ≤21 min on Kauai) and never reached the 21–45 min band (Wailua/Kapaa/
   Anahola), so "within 45 min" wasn't actually reaching 45 min. 8/8 sweeps each
   tier's full radius (Kauai self-caps at ~12–14 towns ≤45 min). The expansion
   BUDGET was bumped 30→38 min to fit the wider sweep (the furthest towns scan
   LAST, so a tight budget would cut exactly the ones we widened to reach); stays
   under the auto-fill 40-min poll cap. Trade-off: an UNFILLABLE booking ties up
   the sidecar longer — dial the caps/budget down for big bulk queues.
   `nearbyBuyInMarketsForScoutDetailed`
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
8. **The BULK queue OVERRIDES attached units with a fresh search (2026-06-08).**
   `startBulkBuyInQueue` (`bookings.tsx`), before running a selected reservation,
   DETACHES every already-attached buy-in (`POST /api/bookings/detach-buy-in/:id`
   for each `slot.buyIn.id`), then calls the SAME `autoFillMutation` with a
   `freshReservation` whose every slot is `buyIn:null` — so the queue re-searches
   and re-fills ALL units from scratch, not just the open ones. This is the
   EXACT same search as the single "Auto-fill cheapest" button (same mutation,
   same `/api/operations/auto-fill` job, same ladder); the only deltas are
   `awaitExpansionInline` (bulk polls the job inline) + `silent` + `forceRestart`.
   The detach is awaited BEFORE the auto-fill POST, so when the job reads
   `getBuyInsByReservation` (its `existingAttachedCost` baseline) the DB is
   clean → 0. A detach failure THROWS → the loop's catch marks the item failed
   (no half-detached partial search), and a `finally` calls
   `stopTrackingAutoFill` so a failed item never leaks `autoFillRunRef` (which
   would block the row's later runs). **Server-restart resilience (2026-06-08):**
   auto-fill jobs are in-memory, so a Railway redeploy mid-queue wipes them and the
   poll returns "Auto-fill job was lost (server restart)". The bulk loop now RETRIES
   such an item up to 3× (15s apart, also catching network throws during the
   redeploy window) before failing — picks persist to Postgres as they attach, so
   the re-POST (forceRestart) resumes. (Don't deploy while an operator is mid-bulk-
   queue if avoidable — each deploy restarts the server.) **`forceRestart` (load-bearing):** the bulk
   POST sets `forceRestart:true`; `startAutoFillJob`'s single-flight guard then
   SUPERSEDES (cancels + finalizes) any in-flight job for that reservation instead
   of reusing it. Without this, an in-flight single-button job J (fire-and-forget,
   non-terminal for tens of seconds) would be REUSED by the bulk POST — and J
   carries a STALE pre-detach `existingAttachedCost` baseline AND its old (smaller)
   slot set, so the detached slot would never refill and the gate would mis-reject.
   The single "Auto-fill cheapest" button does NOT pass `forceRestart` (it still
   reuses an in-flight job — interactive behavior unchanged). **Eligibility:** "Select open"
   (`eligibleGlobalReservations`) still only auto-picks OPEN-slot bookings (no
   footgun re-searching completed ones), but the per-row checkbox + the
   actually-run set (`selectedBulkEligibleReservations`) include any buy-in-capable
   reservation, so a fully-attached one can be MANUALLY selected and re-searched.
   Don't make the single button auto-detach — that override is bulk-only by ask.

Endpoints: `POST /api/operations/auto-fill` (start, single-flight, returns
`jobId`), `GET /api/operations/auto-fill/:jobId` (poll), `GET
/api/operations/auto-fill/active` (rediscover), `POST .../:jobId/cancel` (unused
by the client — the poller intentionally NEVER cancels on unmount). The client's
old `CityExpansionJobPoller` / `expansionJobs` flow is now dead (the expansion
runs inside the server job) but left in place; don't wire it back to the button.

9. **Keep-the-Mac-awake while the sidecar has work (2026-06-08).** A bulk queue (or
   any sidecar scan) stalls if the Mac idle-sleeps — macOS suspends the LaunchAgent,
   the workers stop polling, and the server flips `getHeartbeat().isOnline` false
   after 90s ("sidecar offline") even though the Mac is on the network. The
   supervisor (`daemon/vrbo-sidecar/supervisor.mjs`) now polls the auth-excluded
   `GET /api/admin/vrbo-sidecar/status` every 30s and holds ONE `caffeinate -i -m`
   power assertion while `pending + inProgress > 0`, releasing it after a 5-min
   grace window of no work. `-i` prevents IDLE SYSTEM sleep only (the display may
   still sleep; the operator can still sleep manually / close the lid), so an idle
   Mac sleeps normally. macOS-only, opt out with `SIDECAR_KEEP_MAC_AWAKE=0`
   (grace via `SIDECAR_KEEP_MAC_AWAKE_GRACE_MS`). This is a DAEMON change — it ships
   via `cp daemon/vrbo-sidecar/supervisor.mjs ~/.vrbo-sidecar-daemon/` + `launchctl
   kickstart -k gui/$(id -u)/com.vrbosidecar.worker`, NOT a Railway deploy. The
   client also takes a `navigator.wakeLock('screen')` while `bulkBuyInQueueRunning`
   (instant, tab-visible-only layer; the caffeinate is the deeper guard).
   **Updated 2026-06-09 (PR for the server-side bulk queue):** the supervisor now
   also treats `bulkAutoFillActive === true` (a new field on `GET .../status`,
   true while the server-side bulk queue runs) as "busy", so caffeinate holds for
   the WHOLE bulk run — not just while VRBO requests happen to sit in the sidecar
   queue. Between reservations the sidecar can briefly idle (job hand-off,
   cache-only ladder stages); without this the 5-min grace could lapse and the Mac
   sleep mid-queue. This too is a DAEMON change (cp supervisor.mjs + kickstart).

### Read-only inbox buy-in search (dry-run auto-fill) (Load-Bearing, 2026-06-17)

The guest inbox's **"Do buy-in search"** button (`client/src/pages/inbox.tsx`, on an
inquiry's right panel, next to the static "Buy-in estimate") runs the EXACT same
search the Operations tab runs on **"Auto-fill cheapest"** — the full escalation
ladder (resort find-buy-in → home-city VRBO → nearby-city expansion → per-slot
single-unit fallback), driving the local Chrome sidecar and finding the cheapest
same-community combos — but it **attaches/persists NOTHING**. It exists so the
operator can see live market options for an inquiry's dates before deciding to take
it. Operator ask 2026-06-17: "run a buy-in search there and then … fire the exact
same search … utilize the sidecar and find cheapest combinations … it doesn't need
to attach the buy, it just needs to show me the results."

The implementation is a **`dryRun` mode on the existing auto-fill job**
(`server/auto-fill-job.ts`), NOT a re-implementation — so it inherits every
load-bearing rule for free (VRBO sight+click, the geo guards, same-community
pairing, the deploy-survival poll). Load-bearing choices — don't "simplify" them:

1. **`dryRun` is a flag on `StartAutoFillInput`/`AutoFillJob`; default false →
   existing behavior is byte-identical.** The whole feature is additive and gated.
2. **`attachPick` is the ONLY attach boundary, and the dry-run short-circuit lives
   there.** After the SAME validity/dedup gating (price valid, bedrooms match,
   verified, not-a-dup — so the surfaced pick is a real fillable unit), a dry-run
   run records the would-be pick in `job.attached` with **`buyInId: null`** and
   returns true WITHOUT the two loopback POSTs (`/api/buy-ins` create +
   `/attach-buy-in`). The control flow downstream is then IDENTICAL to a real run
   (slots fill → ladder terminates at the cheapest stage, `committedCost()` running
   total, the resort↔home-city swap, the all-or-nothing rollback), because **every
   `storage.detachBuyIn` / rollback-reattach site is already guarded by
   `buyInId != null`** — a null id makes them all no-ops automatically. So the only
   code that had to change is the create+attach in `attachPick`. The expansion
   child job (`city-vrbo-expansion.ts`) is search-only and never attaches, so it
   needs no change. Locked by `tests/inbox-buy-in-search.test.ts` (asserts the
   short-circuit precedes the create POST AND that every detach site stays guarded).
3. **Reservation-keyed persistence is skipped for dry-run jobs.** The inbox passes a
   SYNTHETIC `reservationId` (`inbox-search:<listingId>:<checkIn>:<checkOut>`,
   namespaced so it can never collide with a real reservation). `finalize()`
   early-returns before `upsertAutoFillLossOptions`, `startAutoFillJob` skips
   `markAutoFillSearchStarted`, and the SIGTERM interrupted-stamp filters out
   dry-run jobs — otherwise a throwaway inbox search would clobber a real
   reservation's durable last-search row and enroll itself in boot-resume. A dry-run
   job that dies on redeploy is simply re-clicked (the client treats a poll 404 as a
   terminal "run it again" state).
4. **The profit gate is intentionally DISABLED (`expectedRevenue: 0`).** That's the
   documented inquiry degrade-safe path (see "Auto-fill is PROFITABILITY-GATED"):
   an inquiry has no committed revenue to gate on, and the operator wants to SEE the
   cheapest options, not a "would lose money, left empty" verdict. The static
   estimate block right above already gives the margin-vs-quoted hint.
5. **Scope = `PROPERTY_UNIT_CONFIGS` properties only** (the city stages require a
   config), same scope as the static `/api/inbox/buy-in-estimate`. Unmapped /
   unconfigured listings return `{ok:false, reason}` (a toast), not a broken search.
6. **Server entry `POST /api/inbox/buy-in-search`** resolves the inquiry
   (guestyPropertyMap → propertyId → PROPERTY_UNIT_CONFIGS slots+community) and
   starts the dry-run job; the client polls the NORMAL `GET
   /api/operations/auto-fill/:jobId` and renders `attached` (cheapest combo found),
   `comboOptions` (other walkable combos), and `cityEconomics` (the per-city ladder)
   read-only via `InboxBuyInSearchResults`. No attach UI anywhere in that panel.

### Preflight replacement-find job survives a server restart (Load-Bearing, 2026-06-15)

The unit-replacement flow (`client/src/components/unit-replacement-flow.tsx`,
the "Find a New Unit" panel in builder-preflight) runs find-unit as a SERVER-SIDE
job (`server/preflight-background-jobs.ts` `replacementFindJobs` Map) and the
client polls `GET /api/preflight/replacement-find-jobs/:jobId`. That job is
IN-MEMORY only and a find-unit run is LONG (up to 8 continuation passes ×
~350s). Railway recycles the process on every deploy / idle-cycle / crash, which
evicts the in-flight job, so the poll 404s — even though the UI promises **"Safe
to leave this tab — search continues on server"**. The operator hit this:
a red dead-end "Replacement search session expired … run Find Replacement Unit
again." (screenshot, 2026-06-15).

Fix (CLIENT-ONLY transparent restart — same philosophy as Auto-fill #6/#8 above:
ephemeral job + client re-launch, not a Postgres-backed job). Built + hardened
via two adversarial review Workflows (9 findings confirmed + all fixed — the
"don't simplify these back" list below IS those fixes):

1. **Persist the start PAYLOAD** in the localStorage ref (`ReplacementJobRef`),
   not just `{jobId, targetUnitId}`. All of `payload`/`startedAt`/`lastAliveAt`/
   `resumeCount` are optional so a ref written by an older client still parses;
   the mount restore effect rehydrates `lastSearchPayloadRef` from it.
2. **On a poll 404, `attemptAutoResume(evictedJobId)`** re-POSTs the SAME payload
   to start a fresh job, saves the new ref, `setReplacementJobId(newId)` (which
   starts a new poll loop), and sets the old poll's `cancelled=true`. It returns a
   **TRI-STATE** — `"resumed"` / `"in-progress"` / `"cannot"` — and ONLY `"cannot"`
   falls through to the original "session expired" error (string preserved —
   `tests/pipeline-logic.test.ts` greps it).
3. **The tri-state is load-bearing (fixes the concurrency bug).** The 2s poll
   `setInterval` has no in-flight guard, so two `poll()`s can hit the same 404
   concurrently. `attemptAutoResume` claims the evicted jobId in `autoResumedFromRef`
   (per-mount Set) SYNCHRONOUSLY before its await; a 2nd concurrent call (or a tick
   in the post-success re-render window where the old jobId is still polled) gets
   `"in-progress"` and returns WITHOUT touching the error setters — otherwise it
   would clobber the resume with the very dead-end this fix removes. The claim is
   KEPT on success but **RELEASED on a failed start-POST** (the `!data.job.id` and
   `catch` paths `delete` it) — otherwise a resume POST that fails while the effect
   resubscribed mid-flight (so the failing tick's `cancelled` re-check swallows its
   error) would strand the UI on a permanent `"in-progress"` spinner with no error
   and no retry button. The poll also re-checks `cancelled` AFTER the resume await
   before any state mutation (incl. the localStorage clear), so a teardown
   mid-resume can't wipe the ref.
4. **Bounds are DURABLE, not per-mount (don't weaken — find-unit burns SearchAPI
   budget):** the restart cap reads `stored.resumeCount` from localStorage and
   increments it ONLY on a confirmed successful start-POST (cap
   `MAX_REPLACEMENT_AUTO_RESUMES` = 3) — so it survives the close/reopen REMOUNT
   (the component is conditionally rendered, refs reset on remount) and a failed
   POST doesn't erode the budget. A fresh operator `search()` / remediation resets
   `resumeCount` to 0. The freshness window (`REPLACEMENT_AUTO_RESUME_WINDOW_MS`,
   45 min) is keyed on `lastAliveAt` — refreshed by `markReplacementJobRefAlive`
   on every successful (queued/running) poll — NOT on `startedAt`, so a long search
   the operator is actively watching never ages out, while a days-stale reopen
   still does. `startedAt` is carried forward across resumes (informational). A
   completed/failed job clears the ref on terminal, so a finished search never
   spuriously resumes.
5. **Auto-resume is a FULL RESTART, not a progress-preserving resume.** The evicted
   job's `diagnostic` (uncheckedCandidates) died with the process, so unlike the
   `OperationFailureActions` "continue-search" playbook we re-run discovery from
   scratch. The progress bar resets — so a sky "Server restarted — your search
   resumed automatically" banner (`resumedAfterRestart`) renders in the searching
   stage so the reset reads as recovery, not regression.

NOTE: `PreflightPhotoFetchJob` in the same file shares the in-memory pattern but
is NOT auto-resumed here (its "Find Photos" UX dead-ends less painfully and a
re-click is cheap) — a sibling candidate if the operator reports it.

### `allowOtaListed` opt-in for STVR-saturated replacement search (Load-Bearing, 2026-06-17)

The builder "Find a New Unit" flow (`POST /api/replacement/find-unit`) requires a
**clean** unit — one NOT already listed on Airbnb/VRBO/Booking.com — so the
replacement's real-estate photos don't feed the photo-listing scanner's
re-detection loop. In a **short-term-rental-saturated** community (e.g. Waikoloa
Beach Villas: ~121 units, ~89 on VRBO alone) almost every discoverable for-sale
unit is ALSO an active OTA rental, so `checkAllPlatforms` marks them all
`skipped-found` and the route returns "No eligible replacement units found" even
though the community has plenty of inventory. (Diagnosed via a workflow that
replayed discovery with live web search + an adversarial code trace: discovery
~24 usable candidates, resort-street gate 11/11 PASS, unit-extraction fine — the
bottleneck is the OTA gate doing its job on a saturated community, NOT a config
or matcher break.)

`allowOtaListed` (request body, **default OFF**) is the operator escape hatch.
Load-bearing constraints — don't loosen them:

1. **It relaxes ONLY the unit-name OTA gate (`skipped-found`), NEVER the
   photo-reuse gate (`skipped-photo-found`).** When `foundOn` is set and
   `allowOtaListed` is true, the candidate falls through with
   `otaListedHost = foundOn.host` instead of `continue`-ing — but the downstream
   reverse-image `skipped-photo-found` check still runs unconditionally. So an
   accepted unit may be *listed* on an OTA, but its real-estate photos are still
   verified as NOT reused on that OTA. This keeps PR #338's anti-feedback-loop
   protection intact: candidate URLs + photos remain sourced exclusively from
   zillow/redfin/homes/realtor; we never pull OTA photos.
2. **The accepted unit is flagged `otaListedOn: <host>`** on the returned `unit`,
   and the client (`unit-replacement-flow.tsx`) renders an amber "already listed
   on <host>" banner and forces the header tone off green — so the "Clean on
   Airbnb, VRBO, and Booking.com" shield can never lie about an OTA-listed pick.
3. **The default-OFF path is byte-equivalent to prior behavior** (`if (foundOn &&
   !allowOtaListed)` is the unchanged skip), so Kauai / non-saturated communities
   are unaffected. The job layer (`preflight-background-jobs.ts`) is a pass-through
   — it forwards the whole body — so no change was needed there.
4. **Diagnostic reword is APPEND-ONLY.** The empty-result message gained a clause
   naming the `skipped-found` count and pointing at the toggle, appended AFTER the
   existing `diagnostic` assignment. The `parts.push(\`… found on \${cleanChannel
   ? "the enforced channel" : "Airbnb/VRBO/Booking.com"}\`)` line is asserted
   verbatim by `tests/pipeline-logic.test.ts` and was left byte-identical.

FOLLOW-UP (a) — SHIPPED 2026-06-17 (PR after #718). The OTA matcher's
**letter-branch** false-`found` is fixed. A web check found a genuinely-clean,
for-sale, never-rented 3BR (Waikoloa Beach Villas **O1**, $1.69M) that the tool
was wrongly dropping: `site:vrbo.com "Waikoloa Beach Villas" "O1"` returns
multi-unit **roundup** pages whose snippets enumerate codes ("…C1, A4, I4…"), and
the old bare `\bcode\b` over title+snippet+link flagged O1 as already-listed. The
matcher moved to the pure, unit-tested **`server/listing-unit-match.ts`**
(`hitTextMatchesUnit`): a letter code now matches ONLY when ANCHORED — (i) a
bounded token in the hit **TITLE** (a real single listing titles its unit; a
roundup title is generic), OR (ii) adjacent to a **generic** unit-designator
keyword (`unit|apt|apartment|condo|suite|bldg|building`) anywhere in the text. The
keyword set deliberately **excludes** the resort/"villas" word so a roundup
snippet "…Beach Villas C1, A4…" cannot anchor via "villas c1". **The numeric
branch (Poipu Kai "721") is byte-identical** — Kauai unaffected. **Safe because
the reverse-image photo-reuse gate (`skipped-photo-found`) is the backstop:** any
unit that slips through the (now looser) name match but reuses OTA photos is still
rejected, so this never reintroduces the photo-feedback loop. `tests/listing-unit-match.test.ts`
(17) locks the roundup-false-positive kills, single-listing recall, boundary
precision (O1≠O2, J2≠J22), and the unchanged numeric branch. Don't re-inline the
matcher into the route or add the resort name to the letter keyword set.

FOLLOW-UP (b) — STILL OPEN. Genuinely-clean *off-market* 3BR units (e.g. A4, I4 —
when not on any OTA) can die at the photo-count/vision gate because off-market
Zillow pages carry few interior photos. Active for-sale listings (like O1) are
photo-rich and unaffected; this only bites units that are sold/off-market.
Unverifiable without running the live search.

### Bulk buy-in queue is a SERVER-SIDE background job (Load-Bearing, 2026-06-09)

The bookings-page **bulk buy-in queue** ("Run bulk buy-ins" over many selected
reservations) no longer runs as a CLIENT `for`-loop. The whole queue now runs
server-side in `server/bulk-auto-fill-job.ts` (modeled on `auto-fill-job.ts`):
the client builds each reservation's self-contained payload ONCE, POSTs the whole
list to `POST /api/operations/bulk-auto-fill`, and then only POLLS
`GET /api/operations/bulk-auto-fill/:id` for per-item progress.

**Why:** the per-RESERVATION search was already server-side (`auto-fill-job.ts`),
but the ORCHESTRATION — which reservation runs next — lived in the browser
(`startBulkBuyInQueue`'s `for`-loop `await`ing each job inline). When Safari
suspended the tab overnight (screen sleep / Mac idle / backgrounded tab) the JS
event loop froze mid-`await`, no further jobs were POSTed, and the queue silently
stalled — the operator left it running overnight and **zero** reservations ran.
The wake-lock only holds while the tab is visible, and caffeinate only engaged
when the sidecar already had work (which it never got). The Cancel button also
did nothing because it flipped a client ref the frozen loop never read. Now the
operator clicks Start once and can **close Safari entirely** — the server walks
the queue and the launchd sidecar daemon (kept awake by the bulkAutoFillActive
caffeinate signal, #9 above) finishes every search.

Load-bearing choices — don't "simplify" them away:

1. **Per reservation the bulk job calls the EXISTING `startAutoFillJob` in-process**
   (with `forceRestart:true`, `silent:true`, `owner:"bulk"`) and polls
   `getAutoFillJob` to terminal — it does NOT re-implement the ladder. So the
   $100 profit gate, all-or-nothing combo rule, nearby-city expansion, and the
   loss-combo `/last` capture all keep working unchanged.
2. **owner="bulk" isolates these jobs from the row-level `/active` rediscovery**
   (`getActiveAutoFillJobForReservation(id, { excludeBulk:true })`) so the row
   poller never re-attaches to a bulk-driven reservation and races the
   orchestrator's single-flight / `forceRestart` (B1). The client ALSO skips
   reservations in `bulkActiveReservationIdsRef` in its row rediscovery —
   belt-and-suspenders.
3. **Override-detach is ATOMIC (B2).** Per item it snapshots the attached buy-in
   ids, detaches all, and on ANY detach failure RE-ATTACHES the already-detached
   ones (`storage.attachBuyIn(id, reservationId)`) so the reservation ends exactly
   as it began — never stranded partially detached on the money path — then fails
   the item. Detach is `storage.detachBuyIn` directly (no side effects; the HTTP
   route does only this).
4. **Cancel hits a real endpoint** (`POST .../:id/cancel`) that sets the bulk
   `canceled` flag AND `cancelAutoFillJob`s the in-flight reservation. Partial
   fills before the cancel landed are surfaced honestly ("Cancelled — attached
   X/Y …"), not hidden behind a clean "cancelled".
5. **Sidecar circuit breaker (M5):** before each item the orchestrator checks
   `getHeartbeat().isOnline` (with one 10s re-check to absorb a blip); if the
   worker is genuinely offline it marks the remaining items failed and STOPS
   rather than grinding each through the ladder's ~40-min expansion timeouts.
6. **Start resumes the sidecar queue** (`resumeQueue()`) because a prior "Clear
   Queue" pause makes the sidecar REFUSE every enqueue — every search would
   silently fail. Clicking Start is explicit intent to run.
7. **Idempotent + redeploy-resilient:** a still-running bulk job is REUSED on a
   duplicate POST (no second queue). The job store is in-memory (2h TTL, lost on
   redeploy — picks persist to Postgres); the client poller treats a `:id` 404 as
   "job lost" and auto-resumes ONCE by re-POSTing the not-yet-terminal items.
8. **Polling is full-record + stable-order (M6):** `GET /:id` returns every item,
   every field, in insertion order; the client REPLACES `bulkBuyInQueueItems`
   wholesale (never a shallow patch that could erase prior progress fields). The
   POST returns immediately (the loop is fire-and-forget) so it never holds an
   HTTP request past Railway's edge timeout.

The old client `for`-loop + its server-restart retry are GONE; `setBulkQueueItem`
/ `logBulkBuyInQueueEvent` may now be unused (the server logs to console — single
writer). Don't wire the loop back to the Start button.

### Auto-fill is PROFITABILITY-GATED (Load-Bearing, 2026-06-08)

Auto-fill no longer attaches the cheapest combo regardless of margin. A combo is
attached only if the booking's projected loss stays within a HARD limit:
`profit = expectedRevenue - existingAttachedCost - comboCost >= -tolerance`,
`tolerance = max($100, 0%·revenue) = $100` flat (operator, 2026-06-08: "as long
as I don't lose more than $100"). It's `max(FLAT, PCT·revenue)` with `FLAT=$100`,
`PCT=0` (env `AUTOFILL_PROFIT_MIN_FLAT` / `_PCT`), so the cap is UNIFORM across
stay sizes — a $9.9k booking and a $600 booking both reject the moment the loss
exceeds $100. **Do NOT reintroduce a revenue-percentage tolerance** (the old
`max($50, 2%)` let a $9.9k stay lose ~$198, which is exactly what the $100 cap
replaced). The pure math is `shared/buy-in-profit.ts` (`evaluateComboProfit`),
unit-tested in `tests/buy-in-profit.test.ts` (incl. the $9,919 stay: −$100 matches,
−$101 rejected). Load-bearing choices:
- **`expectedRevenue` is the CLIENT's `getNetRevenue(reservation)`** (hostPayout →
  netIncome → fareAccommodation → totalPaid), passed in the start POST, so the
  gate's profit EQUALS the bookings-page profit number — don't invent a server
  revenue formula or the operator sees a "profitable" row the gate refused.
- **DEGRADE SAFE: revenue <= 0/unknown (manual reservations, inquiries) DISABLES
  the gate** (attach as before) — refusing there would silently break those flows.
- **The cheapest same-community combo IS the max-profit one in a city**, so the
  gate doesn't enumerate alternatives: if the cheapest is unprofitable, the city
  has none → record its economics and search the NEXT city. The expansion
  (`city-vrbo-expansion.ts`) now CONTINUES past an unprofitable city (status
  `"unprofitable"` + `comboCost`/`expectedProfit` on the city result) instead of
  stopping at the first pair; it's handed pre-netted `revenueAvailable`/`minProfit`/
  `profitGateEnabled` by the auto-fill job.
- **Terminal when NO city is profitable: leave slots EMPTY, status `completed`**
  (it succeeded at not losing money), and surface the per-city economics ladder
  (`AutoFillJobStatus.cityEconomics` + the `doneMessage` "best option" summary +
  the tracker's orange `⊘` city chips). NEVER auto-attach a least-loss combo — the
  operator must not be silently committed to a loss.
- **The single-unit fallback is gated on the RUNNING total** (committedCost grows
  as units attach): a unit that tips the booking into a loss STOPS the fill rather
  than attaching one profitable + one loss-making unit. `existingAttachedCost` is
  captured ONCE (pre-job baseline) and this job's attaches are summed separately —
  don't conflate with `job.totalCost` (double-count).
- **The single-unit fallback is ALL-OR-NOTHING for a combo booking (operator,
  2026-06-08).** When `>=2` slots remain, it must fill EVERY slot with a valid
  (walkable + within-$100) unit or attach NONE. Why: a 6BR/2-unit group needs all
  its units, and the attach proximity guard rejects a cross-community 2nd pick
  ("units too far apart"). When there's no profitable WALKABLE pair within $100,
  the cheap single units are scattered across communities (e.g. Lea: Pane Road in
  Lawai $3,380 attaches, Hale Malu in Kiahuna $3,877 is rejected as too far) — so
  the fallback could only ever leave a LONE unit that can't house the group. So it
  now rolls back (`storage.detachBuyIn` + splice `job.attached` + `recomputeTotals`)
  any partial it attached and records "no profitable WALKABLE combo for all N units
  … left empty for manual review." A SINGLE-unit booking (one slot) attaches
  normally. Don't revert to per-slot independent fills — a 1/2 combo is the bug
  this fixes. (The cause was diagnosed via the job's `skipped` reason
  "attach rejected (Buy-in units too far apart)".)
- **Rejected (over-budget) combos are LOGGED and one-click OVERRIDABLE (operator,
  2026-06-08, PR #610).** A "leave slots empty" terminal is correct but used to be
  a black box — once the operator closed the bulk-queue dialog, every loss combo
  the search found vanished. Now each rejected SAME-COMMUNITY WALKABLE pair (resort
  stage when the proposal covers every slot, home-city, AND every nearby-expansion
  city) is captured via module-level `pushLossComboOption` in `server/auto-fill-job.ts`
  as an attachable `AutoFillComboOption` with `isLoss:true`/`lossProfit` (deduped by
  sorted attach URLs), pushed onto `job.comboOptions` alongside the existing
  `cityEconomics` ledger. The bookings page surfaces both in a durable amber
  `LastBuyInSearchPanel` on the reservation row, with a confirm-gated "Attach
  (accept the loss)" button that reuses `attachComboMutation`. Load-bearing pieces:
  - **Durability = the in-memory last-job store, NOW BACKED BY POSTGRES (2026-06-09).**
    The bulk queue runs server-side and the operator clicks OUT of the queue dialog,
    so client-only combo state died on close. `lastJobByReservation` (kept AFTER the
    job finalizes, unlike `activeJobByReservation`; 2h TTL) +
    `GET /api/operations/auto-fill/last?reservationIds=` re-shows it. BUT the
    in-memory store is wiped by the 2h TTL AND every redeploy (operator hit this:
    a deploy erased a 24-booking run's loss options). So `finalize()` now ALSO
    upserts the loss combos + city economics to `auto_fill_loss_options` (Postgres,
    keyed by reservationId, latest search wins; table created in
    `ensureRuntimeSchema`), and `/last` falls back to that DB row (mapped into an
    AutoFillJobStatus-compatible shape) when the in-memory job is gone. So loss
    options survive permanently. The `/last` route MUST be registered before
    `:jobId` (same as `/active`).
  - **Surfaced in BOTH the reservation row AND the bulk-queue dialog (2026-06-09).**
    The bulk orchestrator carries each item's `lossCombos`+`lossLog` onto the
    serialized bulk status, and the queue dialog renders the SAME
    `LastBuyInSearchPanel` per item (full-width below the row) — so the operator
    sees "found in city X / Y but would lose $Z" and can one-click attach right in
    the results, not just by expanding each booking row. The dialog's attach looks
    the reservation up in the live `reservations` list (toasts if it's not in view).
  - **`isLoss` combos are filtered OUT of `ComboComparisonPanel` AND the cancellation
    advice** — otherwise a loss combo sorts as the "cheapest combo" and skews the
    advised cost. They render ONLY in `LastBuyInSearchPanel`. Don't merge the two.
  - **Expansion carries a COMPACT `lossPair`** (the 2 picks, NOT the full ~200-listing
    inventory) on unprofitable `ExpansionCityResult`s; the LIVE escalation copy in
    `runExpansion` strips it (`map(({lossPair, ...rest}) => rest)`) so polling stays
    lean — the terminal fold reads `terminal.cityResults` directly to keep it.
  - **Override is NEVER automatic** — surfacing a loss combo must not attach it; the
    operator confirms each one. Don't add an auto-attach-least-loss path.
  - **Each `cityEconomics` "Full loss log" row carries a `units` breakdown
    (2026-06-09, PR #620)** — `{bedrooms,url,title,totalPrice,sourceLabel}[]` — so
    the row shows the bedroom-split combo TYPE (e.g. "3BR + 3BR") + a clickable link
    per unit, even for the ledger rows that have no attachable card (single-unit,
    rollback summary). Built by `comboUnitsFromPicks(picks, bedrooms?)` where the
    SLOT bedrooms win over the scraped pick's own field. `cityEconomics` rides the
    serialize / Postgres-jsonb / bulk-`lossLog` paths VERBATIM — don't strip `units`
    from any of them thinking it's redundant with the attachable `lossCombos` cards;
    the log covers cases the cards don't.
  - **Each loss combo also carries a SCAN-SCOPE tag (2026-06-09, PR #622)** — which
    stage of the escalation ladder found it: "Same city" (resort / home-city /
    single-unit fallback), "Within ~20-min drive" (expansion tier 1), or
    "Within ~45-min drive" (tier 2). The loss-LOG row uses `cityEconomics.scopeTier`
    (1|2, nearby only) + `source` (home/nearby); the loss-CARD uses
    `AutoFillComboOption.scopeCategory` ("home"|"tier1"|"tier2"). Both also carry
    `driveMinutes` + `driveMinutesCeiling`. **Load-bearing — minute numbers are
    SERVER-FED, never a client literal:** `tierCeilingMinutes(tier)` (exported from
    `city-vrbo-expansion.ts`, env-floored from `CITY_VRBO_EXPANSION_TIER{1,2}_MAX_MIN`)
    feeds `driveMinutesCeiling` on every nearby combo AND `tier1Ceiling`/`tier2Ceiling`
    on `serializeExpansionJob` — which also drive the escalation-tracker StageRow
    titles + the no-nearby toast (threaded through `ExpansionJobState` + the
    `BuyInEscalation` snapshot, `?? 20`/`?? 45` only as a pre-data fallback). Don't
    re-hardcode 20/45 anywhere. Legacy nearby rows (no `scopeTier`) render a NEUTRAL
    "Nearby drive" chip — do NOT force-bucket them to tier-2 (a real tier-1 city would
    be mislabeled). Only the nearby fold can resolve the 20-vs-45 split; resort/
    home-city/single-unit all bucket "Same city" from `source` (single-unit-city's
    `fetchCity()` is ALWAYS the home city — no city override).

- **Before flagging a concern**, check if the behaviour is documented
  here. If it is, your flag should be *"this intentional decision is
  wrong because…"* rather than *"this code has a bug"*.
- **When the human resolves a dispute**, one of us adds a Decision Log
  entry so the same discussion doesn't happen again next session.

### Guest payment/refund receipts auto-send (Load-Bearing, 2026-06-10)

`server/guest-receipts.ts` auto-sends a guest a receipt MESSAGE when a payment is
collected or a refund is issued in Guesty, and mints a durable `/receipt/:token`
page. Constraints — don't "simplify" them away:

1. **Detection is a POLL of Guesty, not a webhook or a button.** The scheduler
   pages reservations by `-lastUpdatedAt` (a payment/refund bumps the money
   object) so a refund on a months-old booking is still caught; sorting by
   `-createdAt` would miss it. The money extraction (`collectedPaymentsForReceipts`
   / `realRefundsForReceipts` in `server/guesty-money.ts`) is a **verbatim MIRROR**
   of the inline helpers in `dashboardRevenue30DayHandler` (`server/routes.ts`
   ~6990-7073) so a receipt's amount EQUALS the revenue tile's number. Both copies
   are intentional — re-pointing that load-bearing handler at the module risked a
   lexical-scope regression (a same-named `paymentAmount` exists elsewhere in
   `registerRoutes`). Change the math in BOTH or neither.
2. **Dedup = `reservationId|kind|day|amount`, UNIQUE.** Day+amount is jitter-stable
   across polls, which is what guarantees we never DOUBLE-send a money confirmation
   (the cardinal sin). The accepted cost: two genuinely-distinct identical-cent,
   same-day, same-kind transactions collapse to one receipt. Do NOT add a Guesty
   txn id/description to the key to "fix" that — it reintroduces double-send risk if
   the field is ever absent/unstable. Rationale is in `shared/receipt-message.ts`
   `receiptDedupKey`.
3. **Send-then-mark, rebuild-on-retry.** A row is created `pending`, the message is
   posted, then marked `sent`. A failed send leaves `error` and is retried next
   tick — and the retry REBUILDS the body + page payload from CURRENT reservation
   data (only the token is reused, for durable-link stability), so a guest never
   gets a stale receipt. The page payload + message stay in sync via
   `storage.updateGuestReceiptContent`.
4. **Tight backfill + burst cap.** `RECEIPT_BACKFILL_HOURS` (default 48) means the
   first run after deploy only messages last-2-days transactions — it never blasts
   history. `RECEIPT_MAX_SENDS_PER_RUN` (default 25) caps a burst; the rest send
   next tick (oldest-first, so nothing is starved). OFF switch:
   `GUEST_RECEIPTS_DISABLED=true` or `POST /api/inbox/guest-receipts/toggle`.
   `RECEIPT_SKIP_CHANNELS` mutes channels (forward-substring match only — a
   misconfigured longer token must not swallow real channels).
5. **Wording is channel-NEUTRAL** ("a payment of $X was processed" / "a refund of
   $X was issued"), because the auto-sender fires for Airbnb/VRBO too where we do
   NOT hold the card — never "we charged the card on file" (that's only true for
   direct/Booking.com, and is what the MANUAL inbox receipt says). Booking.com
   bodies are ASCII-sanitized with the durable link on its own line (extranet
   allowlist), same rule as the relocation message.
6. **`/receipt/:token` is a NEW public path** (`server/auth.ts`): only the random-
   token guest page is public (creation is the server scheduler; the
   sent-status/tracking/toggle/logs APIs stay gated). PII shown is the guest's own
   receipt; every interpolated value is `escapeHtml`'d; `Cache-Control: no-store`.
7. **The Operations feed is sourced from OUR ledger, not re-derived** — the
   `guestReceipts` array on `/api/dashboard/revenue-30-days` reflects exactly what
   we SENT (status `sent`, in-window), so the tile can't disagree with reality.
   Locked by `tests/receipt-message.test.ts` (builders + sanitize + dedup key).
8. **Refund extraction must handle NESTED refunds + `refundedAt` dating** (added
   2026-06-12). Guesty commonly records a refund as a nested record on the
   original, still-`SUCCEEDED` payment (`money.payments[].refunds[]` / `.refund`)
   rather than as a standalone refund row, AND stamps it with `refundedAt` (not
   `paidAt`). The original code only scanned top-level rows via `refundLooksReal`
   and dated refunds with `paymentDate()` (no `refundedAt`), so a refund issued
   against a collected payment was invisible to BOTH the receipt scheduler and the
   revenue tile. `reservationRefundItems` now descends into nested refund records
   (and prefers them over the parent row to avoid double-counting a partial
   refund), `refundDate()` reads the `refundedAt`/variants first, and
   `refundAmount()` prefers an explicit `refundedAmount`/`refundAmount` field for
   partials. Mirrored in BOTH `server/guesty-money.ts` and the
   `dashboardRevenue30DayHandler` inline copies. Locked by
   `tests/guesty-money-refunds.test.ts`.
9. **Manual escape hatch:** `POST /api/inbox/guest-receipts/send-for-reservation`
   (`sendReceiptForReservation` in `server/guest-receipts.ts`) force-sends a
   receipt for ONE reservation (by `reservationId` or `confirmationCode`),
   IGNORING the backfill window. An explicit `{ kind, amount, dateIso }` forces a
   send even if detection still can't see the txn. It reuses the SAME
   build+send+ledger path as the scheduler (so dedup still prevents a later
   auto-tick from re-sending). For when a refund was issued but the auto-poll
   missed it.

### Platform AI assistant — loopback-only orchestration (Load-Bearing, 2026-06-15)

The dashboard chat agent "Magical" (`server/assistant/*`, `client/src/components/AssistantDock.tsx`)
is a Claude `tool_use` orchestrator. Its single most important constraint:

1. **Every tool is a thin wrapper over an EXISTING HTTP endpoint, called over
   in-process loopback** (`http://127.0.0.1:${PORT}` + `loopbackRequestHeaders()`,
   which bypasses the `ADMIN_SECRET` gate via the `isLoopback` socket check — the
   exact pattern in `server/auto-fill-job.ts`). The agent NEVER touches the DB,
   Guesty, or VRBO directly. This is what makes it safe at scale: it physically
   inherits every load-bearing rule (VRBO sight+click, the $100 profit gate, the
   geo guards, no-double-attach) because it can only act through the endpoints
   that enforce them. **Do not add a tool that re-implements an endpoint or hits
   a provider directly — wrap the endpoint.**
2. **Tools are tagged `kind: "read" | "write"`. Phase 0 ships read-only only.**
   When write/outward tools land (attach buy-in, send guest message, reprice,
   publish), they must go through a confirm-before-act gate (emit a confirm card,
   run the endpoint only on operator confirm). The tag exists so the gate is a
   one-line `if (tool.kind === "write")` check in `agent.ts`. Don't ship a write
   tool that executes without that gate.
3. **ON by default (operator request 2026-06-15; REPLACES the original
   "ships dark behind `PLATFORM_ASSISTANT_ENABLED`" decision).** `assistantEnabled()`
   now returns true unless `PLATFORM_ASSISTANT_DISABLED=1` (or legacy
   `PLATFORM_ASSISTANT_ENABLED=0/false`). Needs `ANTHROPIC_API_KEY`.
   `GET /api/assistant/status` (`{enabled, hasKey}`) gates the client dock; it
   renders admin-only.
4. **Persistence is FAIL-SOFT.** `server/assistant/store.ts` returns empty/null on
   any DB error so the chat never 500s the dashboard; `assistant_sessions` /
   `assistant_messages` auto-create via `schema-maintenance.ts` + `db:push`.
5. **History replay is text-only** (`buildModelHistory`): we replay user/assistant
   TEXT across turns, not the raw `tool_use`/`tool_result` blocks, to avoid
   tool_use/tool_result id-mismatch errors when resuming a session.

Full design + the phased roadmap (Phase 1 buy-ins/pricing → 4 polish) live in
`docs/platform-assistant.md`.

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

   **Redfin has the same trap, fixed the same way (2026-06-17, draft
   26 "Halii Kai at Waikoloa").** `extractGenericRealEstateGalleryFromHtml`
   (the Redfin/Homes/generic tier) harvests *every* `cdn-redfin.com`
   image on the page, and a Redfin listing-detail page — especially an
   OFF-MARKET / SOLD one — renders a "Nearby similar homes" /
   comparable-sold carousel where each card carries ~3 thumbnails. So a
   single unit folder filled with **15-17 different listings'** photos
   (the operator's "mixed photos / completely wrong community": Unit B
   was 16 comp batches incl. an inland Waikoloa-Village golf home in an
   oceanfront-resort unit). `server/redfin-gallery.ts`
   `isolateRedfinSubjectGallery(html, urls)` keeps ONLY the subject
   listing's own photo set — every photo in one Redfin gallery shares a
   numeric `photoSetId` (`.../genMid.<setId>_<i>.jpg`), and the subject's
   set id is whatever `og:image` points at. **If `og:image` is the Redfin
   rocket logo (off-market with no own photos), keep NONE of the
   cdn-redfin photos** — they are all comps; saving them is the bug. Do
   NOT revert to harvesting the whole page. This runs on every Redfin
   scrape (discovery, rescrape, replacement, full-unit audit), so it also
   makes discovery correctly SKIP dead listings instead of saving their
   neighbors. Locked by `tests/redfin-gallery.test.ts` (real off-market
   fixtures).

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
    - ~~**ONE vision call with every sampled photo inlined** … Per-folder
      sample caps (community 10, unit 6, total 24).~~ **REPLACED by the
      EXHAUSTIVE two-phase engine (PR #720, 2026-06-17)** — the operator wanted
      to be 100% sure EVERY community photo belongs, and a 10-photo sample of a
      30-photo folder missed outliers in the unsampled 20. Now:
      - **Phase A — Anchor + Units (one call):** identify the canonical
        community from a small even-spread REFERENCE sample (≤6) of the
        community folder + judge each UNIT (~5 photos each, the operator's ask)
        against that reference. This is the cross-folder holistic judgment the
        single call used to do — community-↔-unit consistency, `matchesExpected`,
        per-unit `sameAsCommunity`.
      - **Phase B — Exhaustive community (batched, ≤3 concurrent calls):**
        verify EVERY community photo (no cap below `COMMUNITY_HARD_MAX=150`), in
        batches of `COMMUNITY_BATCH_SIZE=9`, each batch grounded by ≤3 TRUSTED
        reference anchors (Phase-A anchors minus any the model flagged) + the
        Phase-A identity. Per-photo verdict `same|different|junk`.
      - **The two phases are INDEPENDENT** — a unit-call failure still yields the
        exhaustive community result, and vice-versa.
      - **`unchecked` is load-bearing — never silently pass a photo.** A photo a
        batch could not analyze (vision error) is reported in
        `community.unchecked` and degrades the verdict to warn; the UI shows
        `photosChecked/photosTotal` so a coverage gap is visible. Do NOT default
        an un-analyzed photo to "same" — that would re-introduce the false
        confidence this rework removed.
      - Deterministic folds (`summarizeCommunityVerdicts`, `synthesizeVerdict`,
        `chunk`, `evenSampleIndices`) are pure + locked by
        `tests/photo-community-check.test.ts`. Cost/latency ≈ $0.20-0.40, 30-90s
        for a 30-photo community + 2 units.
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

46. **Guesty push photo order = cover collage → Unit A → Unit B → … →
    Community, hero-first within each gallery, operator drag wins
    (2026-06-19).** The builder assembly (`client/src/pages/builder.tsx`,
    the `propertyData.photos` useMemo) is the single source of truth for the
    order the Photos tab shows AND the order `/api/builder/push-photos` PUTs
    to Guesty (it sends `propertyData.photos` verbatim; the cover collage is
    pushed separately by `upload-collage` and **prepended** as the first/cover
    picture — that's the "collage first"). Two deliberate changes from the old
    behavior:
    - **Grouping replaces the interleave.** The previous assembly threaded
      community photos as an "opener" before unit A and a "separator" between
      units. The operator asked (2026-06-19) for a clean
      units-then-community grouping, so that interleave logic is GONE. Don't
      reintroduce community-opener / between-unit separators.
    - **Hero-first default is intentional and OVERRIDES old decision #2.**
      Within each gallery the default order is the category heuristic in
      `shared/photo-order.ts` (`orderGallery`): living/view/kitchen → bedrooms
      → baths → … for a unit; pool/beach/exterior → grounds → amenities → …
      for the community. The operator explicitly chose "auto hero-first by
      default" over "keep scrape order", so the historical "users want
      Zillow's scrape order, no category sort" decision (#2) does NOT apply to
      the *published push order* — only to the scrape/review pipeline. A manual
      drag-to-reorder persists an explicit `photo_labels.sort_order` for every
      photo in that folder and **wins** over the heuristic (`hasManualOrder`
      short-circuit). "↺ Reset to best order" clears `sort_order` → back to
      hero-first. Reorder is folder-scoped (a unit gallery or the community
      gallery); cross-gallery drags are ignored on purpose (the
      A→B→community order is structural, not draggable). Persistence:
      `POST /api/photo-labels/:folder/reorder` (`{order}` to set,
      `{reset:true}` to clear) → `storage.reorderPhotosInFolder` /
      `resetPhotoOrder`; `sort_order` column added via `schema-maintenance.ts`
      (NOT db:push). The pure ordering helper is locked by
      `tests/photo-order.test.ts`.

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

### Sourceability gate + last-minute pricing (Load-Bearing, 2026-06-15)

The buy-in model sells inventory we don't own yet. These two mechanisms protect
margin on the SELL side (pricing) and the SOURCING side (the gate). PRs #663
(pricing) + #664/#665/#666 (gate). Don't "fix" any of these cold:

- **Last-minute markup is a single FLAT +15% within 14 days — NOT the old
  per-season-band escalation.** `server/availability-policy.ts`
  `LAST_MINUTE_MARKUP_DAYS` (14) / `LAST_MINUTE_MARKUP_PCT` (0.15) +
  `lastMinuteMarkupForDaysUntilArrival` / `lastMinuteDemandFactor`. The old
  scheme (+15/25/40/50% across 45/75/90/120 days by season band) priced us above
  market for near-term dates where our buy cost had not risen — measured from 479
  of our own VRBO scrapes, unit cost is flat until ~14 days out then ~+13%. The
  band functions (`demandFactorForPolicyBand`) are RETAINED but
  deprecated-for-pricing. The availability scanner's 45/75/90/120 lead horizons
  and the inventory-scarcity verdict markup are SEPARATE concerns and unchanged.
  The pushed near-term rate (`pushLeadTimePolicyPricesToGuesty`) is
  `setCost × lastMinuteDemandFactor(days) × (1+targetMargin)`.

- **The rate fed to Guesty is the desired NET disbursement; do NOT gross up for
  commission in code.** `cleanBaseRateFromBuyInServer` = `(1+targetMargin) ×
  cost`. Operator decision: Guesty is configured to apply the per-channel markup
  that recovers each channel's fee (Airbnb ~+18.3%, Booking.com ~+20.5%, VRBO
  ~+8.7%) and disburse this rate net. Adding a code gross-up would double-count.
  `CHANNEL_HOST_FEE` / `computeChannelMarkups` (`shared/pricing-rates.ts`) are
  CLIENT-DISPLAY ONLY and are never pushed to Guesty. (If those Guesty markups are
  ever turned off, the rate would net `(1+margin)×(1−commission)` instead — that's
  a Guesty-config issue, not a code change.)

- **The sourceability gate FAIL-SAFE IS OPEN.** `server/sourceability-gate.ts`
  daily sweep, env-gated (`SOURCEABILITY_GATE_ENABLED` / `SOURCEABILITY_GATE_ENFORCE`,
  both default OFF → a deploy is INERT until flipped). Per near-term window it runs
  `runCityVrboInventoryScan` and decides block/open/skip (`decideSourceability` in
  `sourceability-gate-core.ts`): it BLOCKS only when a CONFIRMED real pool's cheapest
  same-community combo costs more than `sellableRevenue × (1+minMargin)` (or no combo
  exists in a real pool). An offline/errored/EMPTY scan → "skip": neither block nor
  unblock. A false block silently kills real revenue, so the asymmetry is deliberate.
  `reconcileSourceabilityBlocks` (`sync-scanner-blocks.ts`) PUTs Guesty status
  unavailable/available and touches ONLY `source="sourceability-gate"` scanner_blocks
  (never human/legacy blocks). The sweep is single-flight, yields the sidecar to the
  operator's bulk queue, is scan-budget-capped, and only covers the near-term horizon.

- **Blocks/unblocks require N CONSECUTIVE agreeing sweeps (default 2) — the
  confirmation guard.** Live validation caught the same Poipu Kai week reading
  −$8,664 then +$5,045 minutes apart (partial scrape). `applyConfirmation` /
  `confirmedAction` (`sourceability-gate-core.ts`) + per-window streaks persisted in
  the NEW `sourceability_observations` table (so confirmation survives redeploys —
  in-memory would reset every deploy). A "skip" is NEUTRAL: it leaves the streak (it
  never resets nor counts toward a confirmation). DRY-RUN sweeps STILL build the
  streaks (only the Guesty reconcile is gated by enforce), so the safe rollout is
  dry-run a couple nights → review → flip ENFORCE; the next sweep then acts on the
  already-confirmed windows. Tune via `SOURCEABILITY_GATE_CONFIRM_SWEEPS`.

- **UI:** the Sourceability Gate card on `/availability-scanner`
  (`SourceabilityGateCard`) reads `GET /api/availability/sourceability-observations`
  (`classifyObservation` → "Loss flagged 1/2 — 1 more sweep to block" / "Blocked on
  Guesty" / "Sourceable"). `sourceability_observations` is a NEW CREATE TABLE (boot
  db:push creates it; also applied directly via psql per the db:push-skips-ALTER
  caveat below).

- **Profit-aware blackout via the Airbnb HIGH-END rate (PR #717, 2026-06-17,
  `SOURCEABILITY_GATE_PROFIT_ENABLED` default OFF → INERT).** NOTE the bullets ABOVE
  this one still describe the pre-#694 VRBO/profit gate (`runCityVrboInventoryScan` /
  `decideSourceability`) and are STALE: since PR #694 the gate decides blackout by pure
  Airbnb AVAILABILITY (`checkAirbnbAvailabilityForPlan`, town-level dated `engine=airbnb`;
  block only if the unit sizes can't be supplied). This PR adds an OPTIONAL profit layer:
  when on, a SOURCEABLE window is ALSO blocked when the assumed buy-in cost beats our real
  Guesty sell price. `analyzeAirbnbPlanForProfit` (`availability-search.ts`) derives BOTH
  availability AND the high-end cost from the SAME fetch (no sidecar, no new API surface):
  exact-BR from `accommodations` (engine=airbnb has NO `bedrooms` field — always null),
  same-community ALIAS membership (`BUY_IN_MARKETS[c].aliases` — a geo radius CANNOT mean
  "same community" in the overlapping Koloa cluster: Poipu Kai/Makahuena/Brenneckes/Pili
  Mai are 0.5-0.9mi apart, all "Koloa, Hawaii"), OWN-LISTINGS EXCLUDED (`isOwnListing` —
  ours surface at our own price and would pin cost≈sell, masking every loss), trimmed-p90
  nightly (`trimmedPercentile` — p90 is noisy run-to-run; one luxury listing swung it
  $31.5k→$11.8k, so the small-n top-trim + the 2-sweep guard are load-bearing).
  `assumedComboCost` = cheapest of [Σ slot high-ends, single total-size high-end] × nights;
  sell = sum of 7 Guesty calendar `price` (`sellPriceForWindow`).
  `decideSourceabilityWithProfit` (`sourceability-gate-core.ts`) blocks on
  `cost > sell×(1−minMargin)`. FAIL-SAFE unchanged: missing cost/sell ⇒ OPEN (never block
  on missing profit data); unsourceable still BLOCKS; the 2-sweep confirm +
  `reconcileSourceabilityBlocks` source-scoping reused unchanged. Town-keyed in-memory
  dedup cache (`clearAirbnbCellCache` at sweep start, 6h TTL) so same-community properties
  share one SearchApi fetch per (town,size,week). Env: `_PROFIT_ENABLED` (off),
  `_COST_PERCENTILE` (0.90), `_MIN_MARGIN` (0). Validated live on Poipu Kai 6BR (1/13 weeks
  blocked at p90: Aug29 −$14, real sell prices). DON'T re-enable a profit block without
  confirming own-listing exclusion is wired — the cost is self-referential without it. Full
  methodology + the 90-day simulations in `docs/availability-blackout-methodology.md`.

49. **Market-rate refresh WIDENS the Airbnb search when a resort footprint has
    no priced comps — it never falls back to static data.** `fetchAirbnbMedianNightly`
    (`server/hybrid-pricing.ts`) scans one 7-night Airbnb window per calendar month
    across the 24-month horizon and the refresh HARD-FAILS the whole property the
    moment any month returns zero usable exact-BR samples (`deletePropertyMarketRate`
    + throw "no usable exact-NBR samples"). Thin in-footprint markets — gated
    golf/country-club communities like **Bonita National**, or tiny resort footprints
    like **Santa Maria Resort** — have ~zero exact-BR entire-home Airbnb inventory
    INSIDE their curated club bounding box, so the refresh used to abort. The sampler
    now runs ordered passes: PASS 0 is the PRIMARY constraint (curated bounds →
    center-radius → none) with the curated query list — **byte-identical** to before,
    returning on the first query with samples (exactly ONE SearchAPI request for
    healthy markets; locked by the Poipu Kai single-request test). PASSES 1+ are
    geographic-widening FALLBACKS that run ONLY after every primary query returned
    **rates.length===0** (NOT on red confidence — escalating on red would break the
    single-request guarantee for legitimately-thin markets). Each widened pass uses a
    progressively larger **center-radius** box (~6.6km then ~16km, `halfDeg` 0.06/0.15
    around `BUY_IN_MARKET_LOCATIONS[community]`) with **city anchors first**
    (`"Bonita Springs, FL"` etc.) so a healthy nearby-comp set wins before a thin 1-2
    sample resort-name hit can short-circuit at red. LOAD-BEARING invariants: (a)
    `geoConstraintForMarket` / `airbnbSearchGeoParamsForMarket` are UNCHANGED (curated
    bounds stay primary; locked by the bounds tests); the override threads ONLY through
    `fetchAirbnbMedianNightlyForQuery`. (b) Widened passes keep a center-radius box
    (NEVER kind `"none"`) so confidence caps at 84 → a healthy widened month can still
    reach yellow and clear the non-red save/push gate; the scorer is NOT loosened, so a
    genuinely-empty market still fails closed with the real message (and a real HTTP
    error still propagates — it is not swallowed as "no samples"). (c) Markets with no
    mapped center never widen. Kill switch `MARKET_RATE_GEO_WIDENING=0/false/off/no`
    reverts to the old hard-fail (default ON; widening can only improve a refresh that
    would otherwise throw). Don't move the widening into `geoConstraintForMarket`, and
    don't escalate on red confidence. PR #684; design + adversarial review via two
    multi-agent workflows (0 confirmed blockers).

50. **The bulk combo-listing queue NEVER saves a combo without real, distinct
    photos for BOTH units — it tries other combination types, then skips the
    resort (2026-06-16).** This is the strict, BULK-QUEUE-ONLY photo contract;
    it REVERSES the 2026-06-15 "photo reuse" safety net (operator changed his
    mind — see that Decision Log line). The standalone photos-tab combo fetch
    (`runComboPhotoFetchJob`) is the NON-strict path and is unchanged. Pieces, all
    load-bearing:
    - **Strict discovery gate.** `runComboPhotoFetchItem(..., {strictDistinctBothUnits:true})`
      walks `comboFallbackPairings` (`shared/community-combo.ts`): same-total
      re-mix FIRST (3+3→4+2, keeps the bedroom count) then progressively SMALLER
      totals down to the abundant 2BR+2BR floor (→3+2→2+2). Order is operator-chosen
      ("keep beds high, then step down") — `result[0]` must stay the same-total
      re-mix. Halves are floored at 2BR (`COMBO_FALLBACK_MIN_UNIT_BEDROOMS`) and
      capped at 4BR; the requested split + duplicate keys are excluded. Strict mode
      does NOT run the photo-reuse block; on ladder exhaustion it THROWS an error
      tagged `bulkComboNoRetry` (deterministic → the queue must NOT burn 3× the
      ~12-min photo budget retrying the same combos). Locked by
      `tests/combo-remix.test.ts`.
    - **No swallow.** `runBulkComboListingItem` no longer catches the photo-failure
      to "continue the draft save" — the throw fails the item and the queue skips
      the resort.
    - **Persist is a HARD gate, with roll-back.** Discovery only proves photo URLs
      exist; `/api/community/:id/persist-photos` actually downloads them and 409s if
      either unit saves `< MIN_INDEPENDENT_UNIT_PHOTOS` or the sets are duplicates.
      For a freshly-saved draft, a persist failure ROLLS BACK the draft
      (`storage.deleteCommunityDraft`) + clears `item.draftId` + fails the item, so
      NO photo-less row is left behind. A reused, already-photographed draft keeps
      best-effort persist (it has its own photos). Transient timeouts/aborts are
      rethrown UN-tagged so they retry; only deterministic `<MIN`/dup is no-retry.
    - **Resume is drop-and-rerun-fresh.** The top short-circuit marks an item
      "completed" ONLY when its draft has BOTH `unit*PhotoFolder`s; otherwise it
      DELETES the photo-less draft and re-runs from scratch (so persist always
      targets a freshly-created draft — no re-persist into a stale id, no phantom
      "completed"). A THROWN draft-read error is NOT treated as "missing" (that would
      delete a good draft on a DB blip): it clears in-memory `item.draftId` and
      retries with the row intact (re-found by `findExistingBulkComboDraftId`, which
      only returns fully-photographed drafts).
    - **Read-path backstop.** `GET /api/community/drafts` AND
      `getComboInventoryForCommunity` HIDE/skip a bulk-queue combo draft
      (`queueIdempotencyKey` set, `singleListing !== true`) that is missing either
      photo folder — so a transient mid-persist draft or a delete-failure zombie can
      NEVER appear as a dashboard listing or falsely occupy a combo slot. Scoped to
      queue-created drafts so MANUAL in-progress drafts are unaffected — don't widen
      this filter to all drafts. `persist-photos` also 404s on a missing draft.
    - **Re-mix dup-skip.** A combo re-mixed onto a DIFFERENT total re-checks the
      EFFECTIVE combo key against `getComboInventoryForCommunity` occupiedKeys and
      skips-as-duplicate rather than minting a 2nd listing for the same community+size.
    Env: `COMBO_FALLBACK_MAX_LADDER=5`, `COMBO_FALLBACK_MIN_UNIT_BEDROOMS=2` (plus
    existing `COMBO_REMIX_*`). Built + hardened via THREE adversarial review
    workflows (10 confirmed findings fixed). See the 2026-06-16 Decision Log line.

### Database & deploy

15. **Schema sync on Railway boot: `ensureRuntimeSchema()` is authoritative;
    boot `npm run db:push` is a NON-INTERACTIVE backstop.** See `Dockerfile`
    `CMD` + `server/schema-maintenance.ts`. `ensureRuntimeSchema` (runs in
    `server/index.ts` on boot) does idempotent `CREATE TABLE` / `ADD COLUMN` /
    `CREATE INDEX IF NOT EXISTS` — THIS is where new tables/columns/indexes
    actually land, because boot `db:push` SILENTLY SKIPS `ADD COLUMN` on
    existing tables (new `CREATE TABLE` does work). The boot CMD runs
    `( timeout -k 10 120 npm run db:push </dev/null && echo ok || echo skip );
    exec node …` — non-interactive (stdin denied), bounded, NON-BLOCKING.
    DON'T revert the `;` back to `&&`, and DON'T switch to `drizzle-kit push
    --force`: a data-loss diff (e.g. adding a unique constraint to a populated
    table) makes drizzle-kit prompt, which in the non-TTY container wedged every
    deploy ~15-20 min; `--force` "fixes" the wait by auto-TRUNCATING the table
    (PR #677, Decision Log 2026-06-15). `shared/schema.ts` declares NO indexes,
    so a cleanly-completing push DROPS the ~16 `*_idx` ensureRuntimeSchema
    creates and boot recreates them (churn — and running push against prod from
    a laptop drops them live until the next boot). Apply genuinely destructive
    DDL by hand via the Postgres public proxy; keep `shared/schema.ts` +
    `server/schema-maintenance.ts` in sync.

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
    circuits the find-clean-unit HTML-fallback step. PR #361.
    **UPDATE (Load-Bearing #45, 2026-06-15):** the worker handler
    that #41 said the operator must hand-add now SHIPS in the repo
    `daemon/vrbo-sidecar/worker.mjs` — `zillow_photo_scrape` is
    routed to the generic `processListingGalleryScrape`, so this
    tier is no longer a phantom. The old delta doc
    (`docs/sidecar-worker-deltas/zillow-photo-scrape.md`) is
    superseded. See #45 for the full Redfin/Homes/Zillow tier.

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

45. **Redfin / Homes.com / Zillow have a residential-IP sidecar scrape
    tier of last resort (`listing_gallery_scrape`).** Redfin and Homes.com
    are richly DISCOVERED (SearchAPI `site:` queries) but their server-side
    scrape chain is fetch → ScrapingBee with no Apify and no sidecar, so on
    Railway's datacenter IP they frequently bot-wall down to a single
    og:image and fail the downstream photo-count gate. The Redfin/Homes
    branch of `scrapeListingPhotos` now falls back — ONLY when fetch +
    ScrapingBee returned **0** photos — to `scrapeListingGalleryViaSidecar`
    (a generic, host-agnostic gallery scrape via the operator's home-IP
    Chrome). The same worker handler (`processListingGalleryScrape`) also
    backs the previously-phantom `zillow_photo_scrape` caller (#41).

    - **Sequential fallback only — never union** (Load-Bearing #5). It fires
      solely on `result.urls.length === 0` and REPLACES the (empty) photo
      set; it does not merge with or reorder fetch/ScrapingBee photos.
    - **Real-estate hosts only** (PR #338). It lives inside the
      `redfin.com|homes.com` branch, so no OTA host (VRBO/Airbnb/Booking)
      can flow through it for replacement/find-unit photos.
    - **Naturally inert** when the worker is offline (`workerOnline:false`)
      and gated to non-zero wallets — `SCRAPE_WITHOUT_SIDECAR`
      (`sidecarWalletMs:0`, used by `fetch-unit-photos`) skips it, so only
      the find-unit / find-clean-unit paths use it. Kill switch:
      `SIDECAR_GALLERY_SCRAPE_ENABLED=0`.
    - **`makeRequestKey` MUST stay URL-keyed** for this op (sidecar
      request-key exhaustiveness regression — a prior bug collided distinct
      listings onto one dedup key).
    - **DEPLOY:** the worker handler lives in the daemon (`worker.mjs`). A
      Railway deploy ships the SERVER only — it does NOT activate the
      handler. Run `cp daemon/vrbo-sidecar/worker.mjs
      ~/.vrbo-sidecar-daemon/worker.mjs && launchctl kickstart -k
      gui/$(id -u)/com.vrbosidecar.worker`. Until then the live (old) worker
      hits `default: unknown opType`, the op fails, and the server tier
      degrades to its existing 0-photo behavior — safe, just no benefit.

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

    **Auto-reply is DRAFTS-ONLY — auto-send default OFF (Load-Bearing,
    2026-06-09; SUPERSEDES the 2026-06-08 "FULLY AUTOMATED / auto-send
    default ON" decision below).** Operator asked to "disable the
    automatic reply feature": NOTHING goes out to a guest automatically.
    Draft GENERATION is unchanged (`_enabled`, orthogonal to auto-send) —
    the AI still drafts a reply for EVERY incoming guest message; with
    auto-send off those land as status "drafted" and surface in the inbox
    attention banner, where the operator edits + Saves (which TEACHES the
    AI from the original→edited diff via `analyzeAndSaveDraftedReply` →
    `auto_reply_style_examples`) or Sends. The whole 3-layer safety stack,
    the banner UI, and the toggle below are UNCHANGED — only the default
    flipped. Don't revert without operator ask:
    - `loadAutoSendConfig` runs a ONE-TIME DISABLE rollout keyed on
      `auto_send.disabled_rollout_v2`: on the first boot after this change
      it FORCES `auto_send.master_enabled=false` and persists it
      (overriding the stale "true" the 2026-06-08 rollout left), reverts
      any `queued` sends back to `drafted` (so they show in the banner),
      and ALSO stamps `auto_send.full_auto_rollout_v1` so the superseded
      enable-rollout can never re-fire (critical on a fresh DB). A LATER
      operator ON toggle still sticks. In-memory default is now
      `_autoSendEnabled=false`. The banner Auto-send toggle re-enables the
      full-auto behavior described below if the operator ever wants it.
    - [HISTORICAL, pre-2026-06-09] The enable path: `loadAutoSendConfig`
      formerly ran a ONE-TIME rollout keyed on
      `auto_send.full_auto_rollout_v1` that FORCED
      `auto_send.master_enabled=true` +
      `auto_send.hold_recommendations=false`. In-memory defaults were
      `_autoSendEnabled=true`, `_holdRecommendations=false`.
    - The 3-layer safety stack above is UNCHANGED and is what makes this
      safe: a flagged / errored / urgent / unmapped-listing / area-
      uncertain message is HELD, never queued. The clean path now drafts
      with `forceDraftForReview:true` so a model self-flag still leaves a
      conservative HELD draft for one-click review (a flag still sets
      status "flagged" → never auto-sent).
    - CONFIDENCE RAIL: the SYSTEM_PROMPT "AUTO-SEND MODE" block tells the
      model its clean replies send with no human review → "if not FULLY
      confident, flag" and "urgent/time-critical, flag immediately".
      URGENCY RAIL: explicit urgency terms added to `RISK_KEYWORDS`
      (urgent / asap / locked out / stranded / …) so those always hold.
    - UI [UPDATED 2026-06-12 — operator asked for it back as its own tab]:
      the review surface is a DEDICATED "AI Drafts" TAB again
      (`client/src/pages/inbox.tsx`, `<TabsTrigger value="ai-drafts">`,
      gated `isAdmin`, sitting between Messages and Reservations). It holds
      the SAME `panel-auto-reply` block verbatim — the slim "AI auto-reply:
      On/Drafts only" status row (auto-send toggle + review-window +
      Check-now) and the red/amber "N messages need your review" list of
      HELD items (status drafted/flagged/error), urgent-first, each with
      the guest message, hold reason, editable draft, and Send / Save /
      Save&learn / Redo / Open-thread / Decline — plus a dashed empty-state
      when nothing is pending. DISCOVERABILITY (load-bearing for this
      reversal): because the panel is no longer always-visible above the
      Tabs, the `ai-drafts` `TabsTrigger` carries a count badge
      (`sortedAttentionAutoReplyLogs.length`, RED when urgent else AMBER) so
      the operator still notices held messages from any tab. "queued"
      (clean, auto-sending) rows are NOT listed — only the count. Urgency
      highlight is CLIENT-SIDE display only (`AUTO_REPLY_URGENT_RE`); the
      server hold is the authority (urgent ⊂ `RISK_KEYWORDS`). `<Tabs>` is
      controlled so the tab's "Open thread" jumps to Messages. The header
      badge (#48) still counts the same held statuses — it complements the
      tab badge. [HISTORICAL, 2026-06-09 → 2026-06-12] this same surface
      lived as a TOP ATTENTION BANNER above the Tabs; before that
      (pre-2026-06-09) it was the "AI Draft Approval" tab. The 2026-06-12
      change moves it back into a tab — don't "restore" the banner without
      operator ask.
    - NOTE: default-ON means the EXISTING open-conversation backlog gets
      auto-replies on the first scheduler tick after deploy (only clean/
      in-scope ones; everything risky holds). Intended (fast catch-up),
      but is why the operator should glance at the banner right after the
      deploy. A single OFF switch (the banner toggle) reverts to manual.

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
2026-06-08 · Jamie asked to make the guest-inbox responder FULLY AUTOMATED ("the automatic reply/responder… this will now be fully automated"), with a top-of-inbox notice that pops up the messages he should check (not-100%-confident or super-urgent), and to REMOVE the "AI Draft Approval" tab · ACCEPTED · This SUPERSEDES the 2026-06-07 "Part B default OFF" decision above — auto-send is now default ON. The Part B engine (queue → review window → `runAutoSendQueue` re-validation) was already built and correct; this change just (a) flips the default on via a one-time persisted rollout flag (`auto_send.full_auto_rollout_v1` forces master_enabled=true + hold_recommendations=false at first boot, regardless of stale state, while a later operator OFF still sticks), (b) sharpens the HOLD rails — a SYSTEM_PROMPT "AUTO-SEND MODE" confidence gate ("not fully confident → flag", "urgent → flag immediately"), explicit urgency keywords in `RISK_KEYWORDS`, and `forceDraftForReview:true` on the clean path so held items still carry a conservative reviewable draft — and (c) moves the review UI from the removed tab into a top ATTENTION BANNER (`client/src/pages/inbox.tsx`, above the now-controlled `<Tabs>`, isAdmin-gated): a slim status row with the auto-send toggle/window/Check-now + a red/amber "N messages need your review" list of HELD items (drafted/flagged/error, urgent-first via the client-side display-only `AUTO_REPLY_URGENT_RE`), each with Send/Save/Save&learn/Redo/Open-thread/Decline; clean "queued" rows auto-send silently and show only as a count. No schema change (urgency is display-only; the server hold via RISK_KEYWORDS is the authority). See the new "Auto-reply is FULLY AUTOMATED" Load-Bearing note under #24. Verified: `npm run build` clean (client+server), `npm run check` adds zero new TS errors in the two touched files; reviewed via a 3-dimension adversarial workflow (auto-send safety / client banner / cross-file integration). **The single OFF switch is the banner's Auto-send toggle** — it reverts to held-for-manual without redeploy.
2026-06-10 · Jamie: "when I have the [portable] 2nd monitor plugged in… the sidecar [should] use the 2nd monitor and have Google Chrome sit on that monitor… I don't want it popping up and minimizing as that would be more distracting than just having it run on my 2nd monitor" · ACCEPTED, EXTENDS the 2026-06-07 minimize/focus entry above · The sidecar now AUTO-DETECTS a connected external display and, when present, runs the local Chrome VISIBLE on that monitor and never minimizes/hides it; with no external display it keeps the existing hidden/offscreen behavior. **Load-bearing / don't "fix" cold:** (1) Detection is `detectExternalDisplayBounds()` in `daemon/vrbo-sidecar/chrome-sidecar-manager.mjs` — `osascript -l JavaScript` + ObjC `CGDisplayBounds`, which returns TOP-LEFT global points = Chrome's `--window-position`/`Browser.setWindowBounds` space (no Cocoa flip), and needs NO Accessibility/Automation TCC (works from the launchd daemon, same reason the worker's `lsappinfo` focus-guard does). (2) `ChromeSidecarManager.externalDisplay()` caches ~4s and makes effective-visible = `localVisible || ext`; `launchLocalChrome`/`enforceLocalWindowMode`/`visiblePosition*` were threaded with an `ext` param captured ONCE per acquire (so launch + the post-`waitForCdp` enforce can't read a different topology). This is why `SIDECAR_CHROME_VISIBLE=0` can still produce a visible window — that's intended, not a stale env. (3) Worker (`worker.mjs`) guards `minimizeSidecarWindow`/`scheduleSidecarMinimize` AND the CAPTCHA-clear branch of `setCaptchaWindowVisibility` with `externalDisplaySidecarActive()` so a solved CAPTCHA re-places Chrome on the external display instead of yanking it offscreen+minimized (the bug the review caught). Off-switch `SIDECAR_USE_EXTERNAL_DISPLAY=0` (parsed via the same `boolFromEnv` in both processes). The daemon runs LOCALLY (launchd `com.vrbosidecar.worker`), so a Railway deploy does NOT ship this — the live `~/.vrbo-sidecar-daemon/*.mjs` cp + `launchctl kickstart` is what activated it. Verified: 5-dimension adversarial review workflow (all confirmed findings fixed) + an isolated real-Chrome launch on the operator's plugged-in PM161Q monitor landed the window at left=1440, windowState=normal (on monitor 2, not minimized); daemon kickstarted clean (8 slots, no errors).
2026-06-10 · Jamie: "When I send someone a refund via Guesty, [send] an automated message to the guest [as a] receipt of the refund being done … The same for when a payment was taken … and [find] a good place in the UI to [show/store] this." · ACCEPTED · New AUTO-SEND scheduler `server/guest-receipts.ts` (clone of `booking-confirmations.ts`, every 5 min) polls recently-updated Guesty reservations by `-lastUpdatedAt`, detects collected payments + real refunds (reusing the revenue-tile money math, now also in `server/guesty-money.ts`), and for each transaction inside a TIGHT backfill window (`RECEIPT_BACKFILL_HOURS`, default 48 — so first deploy never blasts history) posts a receipt MESSAGE into the guest's Guesty conversation (routes to their booking channel + lands in our Guest Inbox) AND mints a durable tokenized `/receipt/:token` page (the operator-chosen "second way"; clone of `/alternatives/:token`, open-tracked, link on its own line for Booking.com). Dedup ledger `guest_receipts.dedup_key` UNIQUE = `reservationId|kind|day|amount` (DELIBERATE: day+amount is jitter-stable so we NEVER double-send a money confirmation; the cost is two genuinely-distinct identical-cent same-day same-kind txns collapse to one receipt — accepted, see `shared/receipt-message.ts receiptDedupKey`). Rollout: AUTO-ON with an OFF toggle (`/api/inbox/guest-receipts/toggle`, env `GUEST_RECEIPTS_DISABLED`). Operator UI (primary): a "Guest receipts sent" tile + feed in the Operations revenue dialog (`home.tsx`), sourced from our own ledger; (secondary): a sky "Receipt sent" row badge on `bookings.tsx` (batch `POST /api/operations/guest-receipts/sent-status`) + a "📄 Receipt" chip on the message in the inbox thread. **WIDENS THE PUBLIC PATH LIST**: `/receipt/` added to `server/auth.ts` PUBLIC_PATH_PREFIXES (guest page only, token = randomBytes(12); creation is the server scheduler; sent-status/tracking/toggle/logs stay gated). Money math is a deliberate MIRROR of the inline `dashboardRevenue30DayHandler` copies (re-pointing that 100-line load-bearing handler at the module risked a lexical-scope regression). Built + reviewed via a 4-dimension adversarial Workflow (6 findings confirmed + fixed: forward-only channel-skip match, retry rebuilds body/payload from current data, `sentAt` serialized to ISO, dedup trade-off documented). Verified: `tests/receipt-message.test.ts` 28/0, full `npm test` green, `npm run build` clean, `npm run check` adds zero new TS errors (baseline-diffed, still 285). See the "Guest payment/refund receipts" Load-Bearing subsection.
2026-06-12 · Jamie: "In the guest inbox, move the AI draft section as a tab like Auto-Messages and/or Reservations." · ACCEPTED, REVERSES the 2026-06-08/09 "review surface moved to a TOP ATTENTION BANNER" UI decision (the Part-B auto-send engine, the 3-layer safety stack, and the drafts-only default are ALL UNCHANGED — this is a pure UI relocation) · The `panel-auto-reply` block (auto-send status/controls row + the "N messages need your review" held-item list with Send/Save/Save&learn/Redo/Open-thread/Decline) moved out of the always-visible banner above `<Tabs>` and into a new `<TabsContent value="ai-drafts">` — an "AI Drafts" tab (`Bot` icon, isAdmin-gated, sitting between Messages and Reservations) in `client/src/pages/inbox.tsx`. Because the panel is no longer always on screen, the `ai-drafts` `TabsTrigger` carries a needs-review COUNT BADGE (`sortedAttentionAutoReplyLogs.length`, RED when urgent else AMBER) so held messages stay discoverable from any tab, and the tab renders a dashed empty-state when nothing is pending. No state / mutations / endpoints changed — the same `<Tabs>`/`<TabsList>` were relocated to wrap from higher up and "Open thread" still `setActiveTab("messages")`. Load-Bearing #24's UI bullet was updated (REPLACED, not deleted — the banner is retained as HISTORICAL with a "don't restore the banner without operator ask" note). Verified: `npm run build` clean (client+server), `npm run check` adds 0 new TS errors in `inbox.tsx`.
2026-06-15 · Jamie: "plan out the ultimate AI agent for the entire platform … a chat I can speak with … sitting on the dashboard … ask it about pricing basically anything in the system." · ACCEPTED, Phase 0 shipped (`claude/platform-ai-agent-design-n4uk3r`) · New dashboard chat agent "Magical" — a Claude `tool_use` orchestrator (generalization of `server/auto-reply.ts`'s loop, model `claude-opus-4-8` via env `ASSISTANT_MODEL`) that answers operator questions by calling existing endpoints as TOOLS over in-process loopback (`server/assistant/{tools,agent,store,routes}.ts`; floating `client/src/components/AssistantDock.tsx` mounted in `App.tsx`, SSE-streamed). **LOAD-BEARING — the agent NEVER touches DB/Guesty/VRBO directly; every tool is a thin wrapper over an existing HTTP endpoint via `loopbackRequestHeaders()` + `http://127.0.0.1:${PORT}` (same pattern as `auto-fill-job.ts`), so it inherits every existing guard (VRBO sight+click, $100 profit gate, geo guards, no-double-attach) for free. Don't add tools that bypass the endpoints.** Phase 0 is READ-ONLY (`get_dashboard`, `list_bookings`, `get_reports`, `get_buy_in_estimate`); tools carry a `kind:"read"|"write"` tag so the planned confirm-before-act gate for write/outward tools (attach/send/reprice) is a one-line check in `agent.ts`. Ships DARK behind `PLATFORM_ASSISTANT_ENABLED` (+`ANTHROPIC_API_KEY`); `GET /api/assistant/status` gates the dock, admin-only. Persistence `assistant_sessions`/`assistant_messages` (fail-soft; auto-create via `schema-maintenance.ts` + `db:push`). Full design + phased roadmap in `docs/platform-assistant.md` + the "Platform AI assistant" Load-Bearing subsection. Verified: `tests/assistant-tools.test.ts` 12/0, `npm run build` clean (client+server), `npm run check` adds 0 new TS errors in touched files (baseline 287). Could NOT live-smoke (no DB/ANTHROPIC creds in the cloud session) — code-path + build verified. FOLLOW-UPS (same day): Phases 1/1.5/2/3/4 shipped + merged (PRs #668–#672) — live buy-in/city-combo/pricing read tools, confirm-before-act gate + `start_auto_fill`/`check_auto_fill`, photo find/alerts/status, guest inbox read + confirm-gated `send_guest_message`/`send_payment_receipt`, prompt caching + session-history UI + nudges. 17 tools total.
2026-06-15 · Jamie: "add that variable for me [on] the platform" (enable the assistant) · ACCEPTED, REVERSES the same-day "ships DARK behind `PLATFORM_ASSISTANT_ENABLED`" rollout decision · Could not set Railway env vars from the cloud session (no Railway tool/creds), so instead made the assistant ON BY DEFAULT in code: `assistantEnabled()` (`server/assistant/routes.ts`) returns true unless `PLATFORM_ASSISTANT_DISABLED=1` (or legacy `PLATFORM_ASSISTANT_ENABLED=0/false`). Still needs `ANTHROPIC_API_KEY` (already set for other AI features) and renders admin-only. Updated the Load-Bearing "Platform AI assistant" #3 bullet (REPLACED) + docs. Verified: `tests/assistant-tools.test.ts` 65/0, `npm run build` clean, `npm run check` 0 new errors.
2026-06-15 · Jamie reported "the sidecar randomly going off" · DIAGNOSED + KILLED (operational); NO in-repo code fix is possible (PR #674 = docs only) · Root cause: an UNATTENDED inventory-feed sweep — every Kauai city (Koloa/Princeville/Poipu Beach/Wailua…) × consecutive weekly windows × full-city `cityWideInventory` export, each city firing BOTH a `vrbo_search` and a `hometogo_search` — enqueued onto the prod sidecar queue at ALL HOURS (bursts across Jun 11–15 incl. overnight 00:00–08:00 UTC), so the operator's LOCAL Chrome sidecar (8 workers polling `admin.vacationrentalexpertz.com`) drove itself unprompted for hours. SEPARATE from the already-gated Monday-3am `WEEKLY_AVAILABILITY_SCAN` sweep. **The feed scheduler is OFF-REPO** — it is in NO branch, NO worktree, NO local cron / Claude scheduled-task / `/loop`, and NOT on disk; it exists only as the deployed Railway artifact (prod runs code ahead of git — likely `railway up`'d from an uncommitted tree). **DO NOT try to gate it in-repo (this is the trap):** HomeToGo is NOT feed-only — as of the concurrent main merge it's a LEGIT second inventory source called from the shared city-scan core (`server/city-vrbo-inventory.ts` `runCityScanCore` → `searchHometogoViaSidecar`), so EVERY real operator scan (auto-fill / find-buy-in / bulk queue / expansion) now emits the SAME `vrbo_search` + `hometogo_search` cityWide pair. Feed jobs and operator jobs are therefore BYTE-IDENTICAL (same opType, same `cityWideInventory:true`, `bedrooms:1`, null queue context) at every layer this repo controls — a `hometogo_search` (or cityWide-1BR) kill-switch would silently degrade the operator's own buy-in coverage AND still wouldn't stop the VRBO half. An earlier draft of this PR added exactly that guard; it was REMOVED for this reason. Immediate kill (done): `POST /api/vrbo-sidecar/stop` paused the live queue (cancels active + blocks new → stops BOTH halves; worker idles, heartbeat stays green); `POST /api/vrbo-sidecar/start` re-enables. DURABLE FIX (operator, off-repo): disable the prod feed scheduler at its source, OR redeploy prod cleanly from git — current `main` contains NO feed scheduler (every city-scan caller is an on-demand operator flow), so a git-based deploy drops it while KEEPING HomeToGo as a legit source — then un-pause. Until then the sweep resumes the instant the queue is un-paused.
2026-06-15 · Jamie asked to fix last-minute buy-in pricing (he believed late-arriving bookings lost money because the markup wasn't high enough) + account for VRBO/Booking/Airbnb commission, targeting "20% clean after fees" · ACCEPTED, but the data redirected the fix (PR #663) · Analysis of 23 committed reservations + 479 of our own VRBO scrapes: median booking lead ~200 days (almost no true last-minute bookings) and unit cost is FLAT until ~14 days out then ~+13% — so the old escalating per-season-band lead-time markup (+15/25/40/50% across 45/75/90/120 days) was PRICING US OUT of near-term dates where cost hadn't risen. Replaced it with a single FLAT +15% within 14 days (`server/availability-policy.ts` LAST_MINUTE_MARKUP_DAYS/PCT). Commission: operator confirmed Guesty applies the per-channel markup and disburses the fed rate NET, so `cleanBaseRateFromBuyInServer` stays the clean net target (cost×(1+margin)) with NO code gross-up — adding one would double-count. The real margin thinness is the sell-early/buy-late spread + Booking.com commission, NOT last-minute underpricing. See the "Sourceability gate + last-minute pricing" Load-Bearing subsection.
2026-06-15 · Jamie asked to auto-block the Guesty calendar (near-immediately) for windows we can't source a buy-in for at a profit ("sell now, can't source later"), then — after live validation caught wild VRBO scan noise — a confirmation guard, then a UI showing each window's progress toward a block · ACCEPTED · Three PRs: (#664) sourceability gate — a daily sweep runs the existing buy-in scan per near-term window and blocks/unblocks via Guesty, tracking only our `source="sourceability-gate"` scanner_blocks; FAIL-SAFE IS OPEN (never block on a failed/empty scan). (#665) 2-sweep confirmation guard — the same Poipu Kai week read −$8,664 then +$5,045 minutes apart, so a window needs the SAME decision in N CONSECUTIVE sweeps (default 2) before the calendar moves; streaks persist in the new `sourceability_observations` table; a "skip" is neutral. (#666) the Sourceability Gate card on `/availability-scanner` (`GET /api/availability/sourceability-observations` → "Loss flagged 1/2 — 1 more sweep to block"). Env-gated + INERT on deploy; operator flipped SOURCEABILITY_GATE_ENABLED+ENFORCE on this day. Validated LIVE filtering real scan noise (a window hit 2/2 blocks then an open read reset it → never false-blocked). See the "Sourceability gate + last-minute pricing" Load-Bearing subsection.
2026-06-15 · Jamie: "add an email alias for the 2nd unit buy-in — at the moment there's only the option to make an alias for the first buy-in." · ACCEPTED · SimpleLogin buy-in aliases are now PER-UNIT, not per-reservation. Root cause: `reservation_aliases.reservation_id UNIQUE` (one row/reservation, no `buy_in_id`) + the UI gating the "Create alias" button to `firstBuyInId` in `bookings.tsx`. Changes: (1) nullable `buy_in_id` added to `reservation_aliases` (`shared/schema.ts`); `schema-maintenance.ts` backfills legacy rows to the reservation's earliest buy-in, DROPs `reservation_aliases_reservation_id_key`, and adds `UNIQUE INDEX (reservation_id, buy_in_id)`. (2) `getOrCreateReservationAlias` takes optional `buyInId` (look up / insert per reservation+unit); `getOrCreateVendorContact` + `POST /api/bookings/:id/simplelogin/alias` thread it and validate the buy-in belongs to the reservation. (3) `GET .../buy-in-communications` returns `aliases[]` (per-unit) + back-compat `alias`. (4) UI shows the alias control on EVERY attached unit; each panel reads `aliases.find(a => a.buyInId === buyIn.id)` and POSTs `{ buyInId }`; label "Booking email alias" → "Unit email alias". Verified: `npm run build` clean, full `npm test` green, `npm run check` 0 new TS errors (baseline 287). SimpleLogin live-smoke pending on deploy.
2026-06-15 · Jamie reported every Railway deploy stalling ~15-20 min in DEPLOYING because boot `npm run db:push` hit an interactive truncate-prompt in the non-TTY container · FIXED (PR #677) · Root cause was a constraint-NAME mismatch: prod's `guest_receipts` token/dedup_key UNIQUE were Postgres-default-named (`*_key`) because `ensureRuntimeSchema` created the table with inline `UNIQUE`, but drizzle-kit matches constraints by NAME and wanted `*_unique`, so push prompted to "add" them every deploy. Renamed the two prod constraints to `guest_receipts_token_unique` / `guest_receipts_dedup_key_unique` (psql; verified no dup/null tokens). Durable guard: boot CMD now runs `timeout -k 10 120 npm run db:push </dev/null` then `; exec node` (non-interactive + bounded + non-blocking) — NOT `--force` (it auto-truncates). Verified live: post-merge deploy reached SUCCESS in ~3 min with `[✓] Changes applied` + `[boot] db:push completed` and zero prompt text in logs. Lesson: when a table is created by ensureRuntimeSchema raw SQL AND declared `.unique()` in schema.ts, name the raw-SQL constraint `<table>_<col>_unique`. See Load-Bearing #15.
2026-06-15 · Jamie (angry): "every time I open the Operations tab a search pops up and starts the sidecar — I didn't start this." · DIAGNOSED + shipped a global pause switch · Verified the committed Operations page (`/bookings`) does NOT start any sidecar search on navigation — find-buy-in needs an expanded slot + click, the city-scan `autoScanTrigger` is dead (`cityInventoryScanTrigger` is never set), and the on-mount auto-fill/bulk rediscovery is READ-ONLY (the bulk 404 re-POST is guarded by an in-session `bulkPayloadsRef` that's empty on a fresh load). The unattended scans come from SERVER automation: the Sourceability Gate sweep (operator enabled `SOURCEABILITY_GATE_ENABLED` earlier today; up to `SCAN_BUDGET`=12 sidecar scans/sweep/property) and/or the off-repo inventory-feed sweep — the Operations page just SURFACES them in the sidecar panel. SHIPPED a single global kill-switch `server/sidecar-automation.ts` (`isSidecarAutomationPaused`/`setSidecarAutomationPaused`): env `SIDECAR_AUTOMATION_PAUSED=1/0` hard override, else a persisted `app_settings` toggle (`sidecar.automation_paused.v1`). Gated the two in-repo automated drivers (`runSourceabilitySweepAllEnabled` + the weekly Monday-3am OTA scan in `availability-scanner.ts`); operator-initiated HTTP searches are NEVER affected. Endpoints `GET /api/admin/sidecar-automation` + `POST .../toggle`; a "Pause/Resume automated scans" button on the Operations sidecar control. CANNOT stop the off-repo feed (not in this codebase) — that still needs a clean redeploy from `main`. Verified: `npm run build` clean, full `npm test` green, `npm run check` 0 new TS errors (baseline 287).
2026-06-15 · Jamie hit "Update market pricing" and the bulk queue failed on "Sunny 2BR Condo at Bonita National!" with "SearchAPI Airbnb returned no usable exact-2BR samples for Bonita National Golf and Country Club, Bonita Springs, FL 2026-06" · FIXED (geographic-widening fallback) · Root cause: Bonita National is a gated golf community with ~zero exact-2BR entire-home Airbnb inventory inside its curated club bounding box (the box is correct — the resort center is inside it — the inventory is just thin), and the 24-month market-rate refresh hard-fails the moment any one month finds zero priced 2BR comps, with no geographic fallback. Fix: `fetchAirbnbMedianNightly` (`server/hybrid-pricing.ts`) now escalates to progressively wider center-radius boxes (~6.6km → ~16km around the community center) anchored on city-level queries ("Bonita Springs, FL"), but ONLY after every primary curated-box query returns zero usable samples — so healthy markets stay byte-identical (one SearchAPI request, curated box) and the Poipu single-request test holds. Real-data only (no static/seasonal fallback); a fully-empty widened search still fails closed; widened passes keep a center-radius box so confidence caps at 84 (yellow) and can clear the non-red gate. Also unblocks the other tight Florida footprints (Santa Maria Resort, Southern Dunes). Kill switch `MARKET_RATE_GEO_WIDENING=0`. Built + reviewed via two multi-agent workflows (3-lens design validation → GO-with-changes; 4-lens adversarial review → 0 confirmed blockers). 6 new tests; `npm test` green, `npm run build` clean, `npm run check` 0 new TS errors in touched files. See Load-Bearing #49.
2026-06-15 · Jamie: the bulk add-combo-listing queue kept producing combos with a BLANK second unit (Unit A 25 photos, Unit B 0) because both halves are the same community + same bedroom count and the resolver excludes Unit A's listing for Unit B — so when only one good listing exists, Unit B starves. "I like taking the same unit photos if it can't find a 2nd unit but… switch the combo to a [4] bedroom and find a 2 bedroom unit instead." · ACCEPTED + shipped (bedroom re-mix fallback) · `runComboPhotoFetchItem` (`server/routes.ts`) now escalates when the same-size second unit comes back < `MIN_INDEPENDENT_UNIT_PHOTOS`: (1) **re-mix** — `remixBedroomSplits` (`shared/community-combo.ts`) proposes same-TOTAL different-SIZE splits capped at 4BR (no 5BR condos; 3+3→4+2, 2+2→3+1, 4+4→none) and re-searches BOTH halves, committing only when both return real distinct galleries; (2) **photo reuse** (final safety net) — reuse Unit A's photos for Unit B so a combo is never saved blank. The effective (re-mixed) sizes flow into `generate-listing` copy + `/api/community/save` (`unit1Bedrooms`/`unit2Bedrooms`/`combinedBedrooms`) and the dedup/idempotency helpers (`effectiveBulkComboBeds`), so a re-mixed item finds its own draft on retry. Tracked durably via 4 new `bulk_combo_listing_job_items` columns (`ensureRuntimeSchema`, NOT db:push), a `remix`/`photo-reuse` queue event, and per-item UI badges + Unit A/B photo counts on the queue (`add-community.tsx`). Env: `COMBO_REMIX_ENABLED`/`COMBO_PHOTO_REUSE_ENABLED`/`COMBO_REMIX_MAX_UNIT_BEDROOMS=4` (default ON). LOAD-BEARING: the proof's duplicate-overlap check is SKIPPED when `unit2PhotosReused` (reused photos are identical by design); `effUnit*Beds` (not `pairing.unit*Beds`) must feed copy/save/dedup or a re-mixed draft mismatches + duplicates on retry. Built; new `tests/combo-remix.test.ts` (11) green, `npm test` green, `npm run build` clean, `npm run check` 0 new TS errors (baseline 287); 3-lens adversarial review → 0 confirmed bugs. NOTE: separately surfaced two NON-photo blockers in the same live batch (not fixed here) — items fail on a missing community street address (`validateCommunityStreetAddress`) and on heartbeat-stale drops during long phases.
2026-06-15 · Jamie hit "Replacement search session expired (server restarted or job not found)" while finding a replacement unit (screenshot) · ACCEPTED, client-only · The find-unit job is in-memory (`server/preflight-background-jobs.ts`) and a run is long (≤8×~350s); a Railway restart mid-run evicts it and the poll 404s, breaking the UI's "Safe to leave this tab — search continues on server" promise. Rather than a Postgres-backed job (the result isn't applied until the operator confirms, so there's nothing to durably persist — unlike auto-fill picks), `unit-replacement-flow.tsx` now persists the start PAYLOAD in localStorage and TRANSPARENTLY re-launches the same search on a 404 (`attemptAutoResume`, tri-state `resumed`/`in-progress`/`cannot`). Bounds are DURABLE: a `resumeCount` in the localStorage ref (cap 3, survives the close/reopen remount, incremented only on a confirmed start-POST) + a `lastAliveAt`-keyed 45-min freshness window (refreshed each successful poll) so it can't spin SearchAPI in a crash loop yet a long actively-watched search never ages out. Falls back to the original error (string preserved for the grep test) only when resume is truly impossible. Same ephemeral-job + client-relaunch philosophy as Auto-fill #6/#8. Built + hardened via TWO adversarial review Workflows (9 findings confirmed + fixed: concurrent-poll error-clobber [high], post-await cancel re-check, per-mount→durable cap, freshness re-anchor, budget-before-POST, transient flash, no resume signal/full-restart, long-run window age-out, claim-on-failure stuck-spinner). See the "Preflight replacement-find job survives a server restart" Load-Bearing subsection. Verified: full `npm test` green, `npm run build` clean, `npm run check` 0 new TS errors in the touched file.
2026-06-15 · Jamie: "fix the address issue as well and the heartbeat going stale on long phases" (the two NON-photo blockers flagged after the re-mix fix) · ACCEPTED + shipped · TWO fixes to the bulk add-combo-listing queue. (A) ADDRESS FAIL-FAST: `validateCommunityStreetAddress` (`shared/community-addresses.ts`) hard-rejects a community with no real numbered street, but only at the SAVE step — AFTER 10-15 min of photo work (Wailea Ekahi died here). Added a pre-check in the `runBulkComboListingJob` per-item loop (after the cancel check, before the max-attempts guard): `hydrateBulkComboListingItem` + `validateCommunityStreetAddress`, and on failure mark the item failed + `continue` (skips the retry loop entirely — no photos, no attempts burned, clear "add a street address" message + `address-precheck` event). Also added 3 curated resort addresses to `COMMUNITY_ADDRESS_RULES` (Wailea Elua Village 3600 Wailea Alanui Dr, Wailea Ekahi Village 3300 Wailea Alanui Dr, Grand Champions Villas 155 Wailea Ike Pl — all Kihei/Wailea HI, web-verified) so the operator's current batch resolves. (B) HEARTBEAT INTERRUPTION REPRIEVE: items were hard-dropped ("heartbeat went stale after 3 attempts") when a deploy/restart killed the worker mid-item at attemptCount=3 (the now-#691-rarer photo retries used to push items to att 3). KEY INSIGHT: a "running" item in `recoverStaleBulkComboListingJob` was ALWAYS interrupted (genuine failures exit the retry loop as status="failed", never "running"), so don't permanently drop it — give up to `BULK_COMBO_LISTING_MAX_INTERRUPTIONS=3` bounded reprieves (interruptions++, attemptCount=MAX-1 = one more genuine attempt, status="queued"). New persisted `interruptions` column (`ensureRuntimeSchema`, NOT db:push) bounds it across restarts. LOAD-BEARING: the reprieve relies on genuine failures never leaving an item "running"; the bound MUST persist (else a deploy storm loops forever). Built; new `tests/community-addresses.test.ts` (16) + full `npm test` green, `npm run build` clean, `npm run check` 0 new TS errors (baseline 287); 2-lens adversarial review.
2026-06-15 · Jamie disabled RealtyAPI (it burned metered API budget for low marginal value) and asked for OTHER ways to find unit photos · ACCEPTED · An architecture-mapping workflow found the real gap is SCRAPE-side, not discovery-side: Redfin/Homes.com are richly DISCOVERED but their scrape chain is fetch → ScrapingBee with no Apify and no sidecar tier, so on Railway's datacenter IP they bot-wall to a single og:image and fail the photo-count gate; and the `zillow_photo_scrape` sidecar op was a PHANTOM (server fully wired it but the repo `worker.mjs` had no handler — it hit `default: unknown opType` and failed silently; #41 had flagged this as an operator-TODO). Shipped ONE zero-marginal-cost change reusing the FREE Mac sidecar (no new paid API — the explicit anti-goal after the RealtyAPI overspend): a generic `listing_gallery_scrape` op (`processListingGalleryScrape` in `worker.mjs`, host-agnostic gallery + JSON-LD-facts harvest, gallery-container-scoped to avoid "similar homes" pollution) wired as a SEQUENTIAL last-resort tier in `scrapeListingPhotos`' Redfin/Homes branch (fires only on 0 photos from fetch+ScrapingBee → never unions, Load-Bearing #5); the same handler also backs the phantom `zillow_photo_scrape` caller. Gated `SIDECAR_GALLERY_SCRAPE_ENABLED` (default on) + inert when the worker is offline + skipped by `SCRAPE_WITHOUT_SIDECAR` (so `fetch-unit-photos` never fires it; the pipeline-logic meta-assertion holds). URL-keyed `makeRequestKey` (request-key exhaustiveness regression). Built + adversarially reviewed via two multi-agent workflows (architecture map → 4-lens review + verify). Verified: full `npm test` green (+2 new sidecar-gallery tests), `npm run build` clean, `npm run check` 0 new TS errors (baseline-diffed: queue.ts 15→15, routes.ts 172→172). DEPLOY: Railway ships the server; the worker handler needs `cp daemon/vrbo-sidecar/worker.mjs ~/.vrbo-sidecar-daemon/ && launchctl kickstart -k gui/$(id -u)/com.vrbosidecar.worker`. See Load-Bearing #45.
2026-06-16 · Jamie: the bulk add-combo-listing queue still "sometimes adds the listing to the dashboard even without photos … if it can't find photos for unit a and unit b then it needs to stop, don't use that combination type, and instead try to find another combination type … e.g. a 6BR (two 3BR) → switch to a 4BR (two 2BR) … then if that fails, move on from that resort." · ACCEPTED + shipped — REVERSES the photo-reuse half of the 2026-06-15 re-mix decision (operator no longer wants Unit-B-reuses-Unit-A; a combo MUST have real, distinct photos for BOTH units or it is NOT created). Strict gate is BULK-QUEUE-ONLY (the standalone photos-tab combo fetch is byte-unchanged). Changes (all `server/routes.ts` unless noted): (1) `runComboPhotoFetchItem` takes `{strictDistinctBothUnits}`; strict mode walks a wider COMBINATION-TYPE ladder via new `comboFallbackPairings` (`shared/community-combo.ts` — same-total re-mix FIRST [3+3→4+2, preserves beds] then progressively smaller totals down to the abundant 2BR+2BR floor [→3+2→2+2]; halves floored at 2BR, capped at 4BR; requested split + dup keys excluded), SKIPS photo-reuse entirely, and on exhaustion THROWS tagged `bulkComboNoRetry` (deterministic → no wasteful 3× retry of the 12-min discovery). (2) `runBulkComboListingItem` no longer SWALLOWS the photo failure to "continue the draft save" — the throw fails the item so the queue skips the resort. (3) PERSIST IS A HARD GATE: `/api/community/:id/persist-photos` is no longer fail-soft for a fresh draft — if it doesn't confirm ≥`MIN_INDEPENDENT_UNIT_PHOTOS` real saved photos for BOTH units (409 / `<MIN` / duplicate), the just-saved draft is ROLLED BACK (`deleteCommunityDraft`) + the item fails (no photo-less row left behind); only a reused already-photographed draft keeps best-effort persist. (4) RESUME: the short-circuit only marks "completed" when the draft has BOTH `unit*PhotoFolder`s; otherwise it DROPS the photo-less draft and re-runs FRESH (a THROWN read error is NOT read as "missing" — clears in-memory draftId + retries so a good draft is never deleted on a DB blip). (5) RE-MIX DUP-SKIP: a combo re-mixed onto a DIFFERENT total re-checks `getComboInventoryForCommunity` occupiedKeys on the EFFECTIVE key and skips-as-duplicate instead of minting a 2nd listing. (6) READ-PATH BACKSTOP: `GET /api/community/drafts` + `getComboInventoryForCommunity` hide a bulk-queue combo draft (`queueIdempotencyKey` set, non-singleListing) missing either photo folder — so a transient mid-persist draft or a delete-failure zombie can never appear as a listing (manual drafts unaffected). (7) `persist-photos` 404s on a missing draft (no phantom ok:true). Env: `COMBO_FALLBACK_MAX_LADDER=5` / `COMBO_FALLBACK_MIN_UNIT_BEDROOMS=2` (plus existing `COMBO_REMIX_*`). Built + hardened via THREE adversarial review Workflows (round1: discovery-swallow+reuse; round2: persist-swallow + resume-trusts-draftId + re-mix-dup [3 high, all fixed]; round2-rereview: resume-orphan/no-retry + phantom-completed + delete-zombie [3, fixed by SIMPLIFYING resume to delete-and-rerun-fresh + read-path backstop]; round3: 1 low transient-DB-read deletes good draft [fixed]). 12 new `comboFallbackPairings` tests in `tests/combo-remix.test.ts` (23 total); full `npm test` green, `npm run build` clean, `npm run check` 0 new TS errors (baseline 287). LOAD-BEARING: never re-enable photo-reuse for the bulk queue; the persist gate's roll-back + the read-path photo-folder filter together are what guarantee "no photo-less combo listing"; `comboFallbackPairings` element ordering (same-total first) is operator-chosen ("keep beds high, then step down"). See Load-Bearing #50.
2026-06-16 · Jamie: "update the top market sweep so it will also look for 4 bedroom and/or 5 bedroom combinations as well … at the moment it only looks for 6 bedroom or 7/8 bedroom combinations." · ACCEPTED + shipped · The Top Markets Sweep (Add-a-Community wizard) flagged only 6BR (two 3BR = 3+3) and 7/8BR (3+4 / 4+4) two-unit combos, and — LOAD-BEARING — its candidate filter `filterTopScanSixBedroomComboCandidates` GATED each market's surfaced communities on 6BR potential, so a community whose plentiful 2BR/3BR inventory only makes a 4BR or 5BR combo was dropped entirely. Added 4BR (two 2BR = 2+2) and 5BR (2BR+3BR = 2+3) as first-class combo sizes: `server/community-research.ts` new `hasFourBedroomComboPotential`/`hasFiveBedroomComboPotential` + `TOP_SCAN_COMBO_PAIRS`=[[2,2],[2,3],[3,3],[3,4],[4,4]] + `hasAnyTopScanComboPotential`, and the candidate filter was WIDENED + renamed `isTopScanComboCandidate`/`filterTopScanComboCandidates` (eligible && ANY of 4/5/6/7-8BR) — markets now surface on any of the four sizes, each reported independently. Persisted via two new `top_market_scan_cache` columns (`four_bedroom_possible`/`five_bedroom_possible`, `shared/schema.ts` + `server/schema-maintenance.ts` CREATE + `ALTER TABLE ADD COLUMN IF NOT EXISTS` for existing prod tables) and `TOP_MARKET_SCAN_CACHE_LOGIC_VERSION` 4→5 — the bump CLEARS the cache on boot (a re-scan, NOT `refreshTopMarketScanCacheComboFlags`, because old rows were stored under the narrow 6BR-only filter so recompute-from-stored-JSON can't recover the newly-qualifying 4/5BR-only communities). Boot-safe: `ensureRuntimeSchema` (the ALTER) runs at index.ts:98 BEFORE the version-clear's Drizzle `select(*)` at :99. `server/routes.ts` job + NDJSON stream + `/api/community/top-markets/seeds` all emit the four flags; `client/src/pages/add-community.tsx` mirrors the two predicates and renders four combo badges (4BR violet / 5BR indigo / 6BR emerald / 7-8BR sky) in both the seed-picker grid and the live per-market cards (`seedComboBadge` refactored to a `COMBO_BADGE_META` map). INTENTIONAL DEFERRAL (nit from the adversarial review): the market-level static "Est. combo rental {range}" badge (`TOP_MARKET_SEEDS` `estimatedComboLow/High`) is calibrated to large combos and can overstate revenue for a 4/5BR-only market — left as-is (it's pre-existing display, the four yes/no badges + per-resort ranges disambiguate, and the actually-queued combo gets its own server-computed sell rate). Verified: full `npm test` green (+ new synthetic & real-seed combo assertions in `tests/pipeline-logic.test.ts`), `npm run build` clean, `npm run check` 0 new TS errors (baseline 287, stash-diffed); 4-dimension adversarial review (combo semantics / filter-widening side-effects / deploy-migration-cache / client-server parity) → 0 real bugs, 2 nits (stale comment fixed; the est-range deferral above).
2026-06-17 · Jamie asked whether SearchApi Airbnb counts could drive a daily 7-night Guesty blackout per listing 2 years out, then steered it to PROFIT-aware blocking using the Airbnb HIGH-END rate as the assumed buy-in cost · ACCEPTED + shipped (PR #717, INERT) · Live calibration (engine=airbnb + real Guesty calendar prices) found: engine=airbnb has NO `bedrooms` field (parse `accommodations`); `bedrooms=N` is a MIN filter; `q=` returns an ISLAND-WIDE pool so "same community" needs the alias regex, not geo (the Koloa cluster — Poipu Kai/Makahuena/Brenneckes/Pili Mai — is 0.5-0.9mi apart, all "Koloa, Hawaii"); 2yr-out returns 0 (Airbnb ~12mo listing-cliff — kills the "2 years out" availability goal, far-future stays on buy-early cost-lock); and OUR OWN listing appears in results at our own price (must be excluded or cost≈sell). Two 90-day Poipu Kai sims showed availability ~never binds in a liquid market, so the real lever is profit. Shipped an OPTIONAL profit layer on the #694 availability gate (`SOURCEABILITY_GATE_PROFIT_ENABLED`, default OFF): assumedCost = trimmed-p90 of same-community own-excluded Airbnb nightly (cheapest of combo vs single-unit path) computed FREE from the same fetch; sell = Guesty calendar; block if cost > sell×(1−minMargin); fail-safe-OPEN on missing cost/sell; 2-sweep confirm + source-scoped reconcile reused. Validated live: Poipu Kai 6BR (Guesty listing 69e14c…) blocked 1/13 weeks at p90 (Aug29 −$14). New `tests/sourceability-profit.test.ts` (6 groups) green; existing sourceability/availability suites green; `npm run build` clean; `npm run check` 0 new TS errors (baseline 287). Methodology + sims in `docs/availability-blackout-methodology.md`. The "Sourceability gate" Load-Bearing bullets predate #694 and still describe the VRBO/profit gate — STALE; the new "Profit-aware blackout" bullet is current. OPS: I leaked ADMIN_SECRET into the session transcript via a bad shell expansion — operator should ROTATE it.
2026-06-17 · Jamie: "the most recent bulk combo listing tool failed to find an address — see why; if it's SearchAPI it's already fixed, else diagnose + fix." · DIAGNOSED (NOT SearchAPI) + shipped two fixes · Pulled the prod queue from the DB (job `bcj_mqhk76d6_obuy3u`, a Kauai Top-Markets-Sweep batch): 4 items hard-failed the `address-precheck` — Lae Nani, Puu Poa, Hanalei Bay Resort, Waipouli Beach Resort — each queued with EMPTY `streetAddress`/`addressHint`/`community.address` and a WRONG sweep-assigned mailing city ("Puhi"/"Kilauea"), and none in `COMMUNITY_ADDRESS_RULES`. ROOT CAUSE: the address path (`resolveBulkComboListingStreet`→`inferCommunityStreetAddress`) is PURE (curated rule + operator hint only) with NO discovery, so any non-curated swept resort fails the gate before a single photo — SearchAPI being dead never even touched it (the operator's hypothesis was wrong). Separately found a WRONG-address bug in the SAME batch: "Alii Kai" (Princeville, Kauai) saved Draft #26 against `69-1029 Nawahine Pl` — the Big-Island Halii Kai address — because `communityAddressRuleForName` used raw substring matching and `"halii kai".includes("alii kai")`. FIX 1 (systematic, the "find an address" answer): new `server/community-address-discovery.ts` `discoverCommunityStreetAddress()` — SearchAPI `google_maps` (same engine `walking-distance.ts` geocodes with), multi-variant queries (name / name+resort / name+condominium / name+state — robust to the wrong city), lifts a real numbered street from `place_results`+`local_results`. LOAD-BEARING — PRECISION OVER RECALL (a wrong address publishes a real listing at the wrong place): a candidate is accepted ONLY when `isLikelyStreetAddress(streetRootFromAddress(addr))` AND `titleMatchesResort` (every distinctive, non-generic resort token present as a WHOLE WORD in the maps title — rejects the streetless "Lae Nani Beach" POI and the wrong-resort Halii Kai hit); a streetless/unmatched result yields null → the item fails the pre-check exactly as before (no regression, just an extra chance). Wired into the `runBulkComboListingJob` pre-check ONLY when validate fails AND there is NO curated rule (a curated mismatch must still surface, not be papered over); on success sets+persists `item.streetAddress` into the item payload (new targeted `persistBulkComboItemStreetAddress` — `persistBulkComboListingSnapshot` does NOT write payload), emits an `address-discovered` event, re-validates. LOAD-BEARING: discovery negative-caches ONLY a DEFINITIVE no-match — a transient throw/timeout/non-2xx (now thrown, not `[]`) leaves it uncached so a retry can re-attempt (no one-blip-skips-the-resort poisoning). Env `BULK_COMBO_ADDRESS_DISCOVERY=0` kills it. FIX 2: `communityAddressRuleForName` now matches on WORD BOUNDARIES (pad both normalized strings with spaces) so "alii kai" no longer matches inside "halii kai" while legit partials hold ("grand champions" ⊂ "wailea grand champions", "poipu kai" ⊂ "kahala at poipu kai", bare "kaiulani"); Alii Kai now falls through to discovery → its correct `3830 Edward Rd, Princeville`. Did NOT hardcode the 4 Kauai addresses (discovery covers them + the long tail; avoids wrong-hardcode risk). Verified: `npm run build` clean; full `npm test` green incl. new `tests/community-address-discovery.test.ts` (17) + extended `tests/community-addresses.test.ts` (30, +Alii Kai/word-boundary locks); `npm run check` 0 new TS errors (stash-diffed, baseline 131-unique); LIVE end-to-end `discoverCommunityStreetAddress` resolved all 4 failed resorts + Alii Kai correctly from their exact garbage inputs, and a fake resort → null. NOTE: the automated multi-agent adversarial review fan-out was blocked by a sustained Anthropic-side 529 overload (3 attempts, all 4 agents); a thorough MANUAL 4-dimension adversarial pass stood in and caught the cache-poisoning issue (fixed above). The existing wrong-address Draft #26 (Alii Kai) is stale data — operator should re-queue it to pick up the correct address. Separately observed (NOT fixed, out of scope): the Top Markets Sweep assigns garbage mailing cities to resorts (Lae Nani→"Puhi"); discovery is robust to it, but photo-discovery city terms could still be improved later.
2026-06-17 · Jamie: "find more locations and subsequent resorts in Hawaii that we can list, then implement them into the top sweeps market tool." · ACCEPTED + shipped · Expanded the Top Markets Sweep's two Hawaii data layers in `server/community-research.ts`: (a) +6 location seeds in `TOP_MARKET_SEEDS` (Mahinahina, Spreckelsville [Maui]; Kahaluu-Keauhou, Waikoloa Village [Big Island]; Kaluakoi, Ualapue [Molokai]) → Hawaii seeds 68→74, total 100→106; (b) +120 curated condo/townhome resorts in `KNOWN_COMBO_COMMUNITY_SEEDS` (the `knownComboSeedsForCity` dictionary that powers the per-market resort breakdown #708/#709) — e.g. Princeville +7, Kihei +20, Poipu/Koloa +11, Kona/Keauhou +15, West Maui +21, Waikoloa coast +10, plus 4 new named city-pattern constants (`MAUI_NORTH_SHORE_CITY_PATTERN`, `WAIKOLOA_VILLAGE_CITY_PATTERN`, `HILO_CITY_PATTERN`, `MOLOKAI_CITY_PATTERN`) and `mahinahina` added to `MAUI_WEST_CITY_PATTERN`. Discovered + adversarially verified via a 13-segment (per-island) research Workflow (discover → skeptical verify → synthesize, 27 agents); only individually-owned condos/townhomes survive (`checkCommunityType`-eligible: hotels/condotels/timeshares/vacation-clubs/branded-operators/detached-villas/SFR all excluded). **LOAD-BEARING — the cross-island cache-key collision trap:** the sweep caches each market on `state|city` lowercased and the curated-resort dictionary keys on anchored `city` regexes, so Hawaii's reused place names WILL collide if added naively. Three deliberate collision-avoidance choices: (1) `Kahaluu-Keauhou` uses the DASHED string (not bare `Kahaluu`) to avoid colliding with Oahu's no-STR Kahaluu, and reuses the existing Kona pattern (which already lists `kahaluu-keauhou`) so bare "Kahaluu" attaches 0 resorts; (2) `Waikoloa Village` uses the FULL string + its OWN `/^waikoloa village$/i` pattern — the anchored `BIG_ISLAND_RESORT_CITY_PATTERN` (`/^(waikoloa|…)$/`) does NOT match "waikoloa village", so the inland village condos and the coastal Waikoloa Beach resort condos stay disjoint (verified: 0 overlap); (3) `Mahinahina`/`Spreckelsville`/`Kaluakoi`/`Ualapue` are unique to their island (no same-named town elsewhere). Claude's own final precision/sensitivity filter DROPPED 10 of the 130 verified candidates: the Lahaina-TOWN fire-zone complexes (Puamana/Lahaina Shores/Puunoa — Aug-2023 fire), condotel hybrids (Mana Kai Maui, Pohailani, Napili Shores), legality-questionable Oahu residential condos (Royal Kuhio, Royal Garden, Ilikai Marina), and a receivership-history Hilo complex (Waiakea Villas). Oahu kept deliberately conservative — only clearly resort-zoned/NUC pockets (Turtle Bay/Kuilima, Makaha oceanfront). NO cache version bump (logic unchanged; new markets scan fresh, existing markets surface new resorts on their next scan/refresh — a global clear would force a heavy full re-sweep for no correctness gain). Pure additive data change: no UI change (the sweep grid groups by `tag` dynamically), no schema/cache-key change. Verified: full `npm test` green (`pipeline-logic` top-market audit now 106 markets; `TOP_MARKET_SEEDS.length>=86` holds), `npm run build` clean (client+server), `npm run check` 0 new TS errors (baseline 287, stash-diffed), and a runtime assertion confirmed 0 `state|city` collisions + correct resort attachment via the real regexes.
2026-06-17 · Jamie: "when a guest sends an inquiry … run a buy-in search there and then by clicking a button … fire the exact same search as the Operations tab's 'find cheapest choice' … utilize the sidecar and find cheapest combinations … it doesn't need to attach the buy, it just needs to show me the results." · ACCEPTED + shipped (`claude/inbox-buy-in-search`) · New "Do buy-in search" button on a guest inquiry's inbox right panel (next to the static "Buy-in estimate") runs the EXACT Operations "Auto-fill cheapest" escalation ladder (resort find-buy-in → home-city VRBO → nearby-city expansion → per-slot single-unit fallback, driving the local Chrome sidecar + cheapest same-community combos) and DISPLAYS the results read-only — it attaches/persists NOTHING. Implemented as an additive, default-false `dryRun` mode on the EXISTING auto-fill job (`server/auto-fill-job.ts`), not a re-implementation, so it inherits every load-bearing rule (VRBO sight+click, geo guards, same-community pairing, deploy-survival poll) for free. KEY INSIGHT that made it a tiny diff: `attachPick` is the only attach boundary, and every detach/rollback site is already guarded by `buyInId != null` — so a dry-run that records the would-be pick with `buyInId:null` and skips the two create/attach POSTs leaves ALL downstream control flow (slots fill → ladder terminates, running-total profit gate, swap, all-or-nothing rollback) byte-identical with zero other server changes. Reservation-keyed persistence (`markAutoFillSearchStarted`/`upsertAutoFillLossOptions`/SIGTERM interrupted-stamp) is skipped for dry-run (synthetic `inbox-search:` reservationId never touches a real reservation's durable rows / boot-resume). Profit gate disabled (`expectedRevenue:0`, the documented inquiry degrade-safe path) so it shows the cheapest options, not a "would lose money" verdict. New `POST /api/inbox/buy-in-search` resolves the inquiry (guestyPropertyMap → PROPERTY_UNIT_CONFIGS slots+community, same scope as the static estimate) and starts the job; client polls the normal `GET /api/operations/auto-fill/:jobId` and renders `attached`/`comboOptions`/`cityEconomics` via `InboxBuyInSearchResults`. Verified: new `tests/inbox-buy-in-search.test.ts` (20 checks) green, full `npm test` green, `npm run build` clean (client+server), `npm run check` 0 new TS errors in touched files (baseline 287). See the "Read-only inbox buy-in search (dry-run auto-fill)" Load-Bearing subsection.
2026-06-17 · Jamie: builder "Find a New Unit" can't find an alternative replacement for "Sunny 6BR for 12 at Waikoloa Villas!" (Waikoloa Beach Villas, Big Island; backed by two 3BR condos) — "there's a lot of properties in that community so it should be able to find them but it can't." · ACCEPTED + shipped · An evidence-grounded multi-agent Workflow (live-web discovery replay + adversarial code trace + 2 refuters) proved the config is COMPLETE and not the bug: the `Waikoloa Beach Villas` community-address rule, discovery cities/queries/`discoveryUnitLabels`, the resort-street gate (every `69-180 Waikoloa Beach Dr APT/UNIT/# …` URL parses to root `69 180 waikoloa beach dr` and PASSES), and unit extraction (letter-coded C1/I4/M23) all work; Zillow/Redfin/Homes surface ~24 usable 3BR-or-unknown candidates. The REAL cause is that Waikoloa Beach Villas is a ~121-unit STVR-saturated complex (~89 units on VRBO alone) so almost every discoverable for-sale unit is ALSO an active Airbnb/VRBO rental → the default "clean unit" requirement correctly drops them all as `skipped-found` (the operator sees "a lot of properties" but nearly none are clean). Fix = an OPERATOR OPT-IN `allowOtaListed` (default OFF) that relaxes ONLY the unit-name OTA gate, never the photo-reuse gate (`skipped-photo-found` stays enforced — PR #338 anti-feedback-loop intact, photos still sourced only from zillow/redfin/homes/realtor), flags the kept unit `otaListedOn` (client surfaces an amber "already listed on <host>" banner so the green "clean" shield never lies), plus an APPEND-ONLY diagnostic line that names the skipped-found count and points the operator at the toggle (the test-asserted `found on …Airbnb/VRBO/Booking.com` substring left byte-identical). Two implementation landmines the refuters caught and I avoided: (a) the OTA matcher's letter-branch roundup-snippet false-positives and the photo-gate loss of off-market clean 3BR were left as documented FOLLOW-UPS — not a blind matcher tweak, which risks double-listings — because tuning needs live SearchAPI data I can't run here; (b) the diagnostic reword is append-only. `server/routes.ts` + `client/src/components/unit-replacement-flow.tsx` (job layer is a pass-through, no change). Verified: full `npm test` green (+8 new source-lock assertions in `tests/pipeline-logic.test.ts`), `npm run build` clean, `npm run check` 0 new TS errors (baseline 287, stash-diffed). See the "`allowOtaListed` opt-in for STVR-saturated replacement search" Load-Bearing subsection.
2026-06-17 · Jamie (follow-up to the Waikoloa #718 fix): "at what point can we say this is not fixable and there is no legitimate replacement?" · ANSWERED (not unfixable) + shipped FOLLOW-UP (a) · A live web check of the actual 3BR inventory at 69-180 Waikoloa Beach Dr found a genuinely-clean, active, NEVER-RENTED for-sale 3BR — Waikoloa Beach Villas **O1** ($1.69M) — that the tool was WRONGLY dropping, so "no legitimate replacement" was FALSE. Root cause = the deferred letter-branch false-positive: `site:vrbo.com "Waikoloa Beach Villas" "O1"` returns multi-unit ROUNDUP pages whose snippets enumerate codes ("…C1, A4, I4…"), and `hitMatchesUnit`'s old bare `\bcode\b` over title+snippet+link flagged clean O1 as already-listed (skipped-found). Fix: extracted the matcher to the pure, unit-tested `server/listing-unit-match.ts` (`hitTextMatchesUnit`) and ANCHORED the letter branch — a letter code matches only when it's a bounded token in the hit TITLE, or adjacent to a GENERIC unit-designator keyword (`unit|apt|apartment|condo|suite|bldg|building`); the keyword set EXCLUDES the resort/"villas" word so a roundup snippet "…Beach Villas C1, A4…" can't anchor via "villas c1". NUMERIC branch (Poipu Kai "721") byte-identical → Kauai unaffected. SAFE because the reverse-image `skipped-photo-found` gate is the backstop (a looser name-match that lets an OTA unit through is still rejected if its photos are reused → no photo-feedback loop). `tests/listing-unit-match.test.ts` (17) locks roundup-kill + single-listing recall + O1≠O2/J2≠J22 boundary precision + the unchanged numeric branch. Also delivered the operator a decision-framework for declaring a community genuinely exhausted (run with Include-OTA + Expand ON, read the verdict breakdown; terminal = all candidates skipped-photo-found / too-few-photos / vision-rejected / internal-duplicate). FOLLOW-UP (b) (sparse-photo off-market clean 3BR dying at the photo gate) STILL OPEN — but active for-sale units like O1 are photo-rich and now recoverable. Built in a fresh worktree off `main` (the shared `claude/city-research-dedup-and-radius` checkout has concurrent uncommitted edits). Verified: full `npm test` green (incl. the 17 new behavioral tests), `npm run build` clean, `npm run check` 0 new TS errors (baseline 287). See the updated FOLLOW-UP (a)/(b) note in the "`allowOtaListed` opt-in for STVR-saturated replacement search" Load-Bearing subsection. COULDN'T live-confirm O1 now surfaces (no SearchAPI/Railway here) — the matcher fix is unit-proven; if O1 still doesn't appear after deploy, next suspect is discovery ranking / its for-sale page being on a non-allowlisted brokerage site (hawaiiliving etc.).
2026-06-17 · Jamie: builder "Check photo community" button must check EVERY community-folder photo (confirm each is in that community or not) + ~5 photos of each unit (confirm each unit is the same community) — "100% sure that every community photo is a part of the community" and as close to 100% as possible on the units · ACCEPTED + shipped (PR #720) · DIAGNOSIS: the existing check sampled the community folder at `COMMUNITY_SAMPLE_CAP=10` in ONE vision call; real folders run 16-30 photos (mauna-kai-6a=30, kaiulani-52=28), so 20 photos were never looked at — an outlier in the unsampled tail was invisible, defeating the 100% goal. FIX: reworked `server/photo-community-check.ts` into a TWO-PHASE engine (replaces the single-call/caps design in Load-Bearing #45, marked superseded there). Phase A (one call) identifies the canonical community from a small even-spread REFERENCE sample (≤6) + judges each UNIT (~5 photos each) against it — the cross-folder holistic judgment the single call did. Phase B verifies EVERY community photo (no cap below `COMMUNITY_HARD_MAX=150`), in `COMMUNITY_BATCH_SIZE=9` batches run ≤3 concurrent, each grounded by ≤3 TRUSTED reference anchors (Phase-A anchors minus any the model flagged) + the Phase-A identity; per-photo verdict `same|different|junk`. The two phases are INDEPENDENT (a unit-call failure still yields the exhaustive community result, and vice-versa). LOAD-BEARING `unchecked`: a photo a batch couldn't analyze is surfaced in `community.unchecked` + degrades the verdict to warn (UI shows `photosChecked/photosTotal` so a gap is visible) — never defaulted to "same", which would re-introduce the false confidence this removed. Kept AGENTS #45's other constraints verbatim (client-driven/property-agnostic groups, Sonnet, positive-contradiction-only "different/no", deterministic dHash dup detection over the FULL community set). Pure folds (`summarizeCommunityVerdicts`/`synthesizeVerdict`/`chunk`/`evenSampleIndices`) extracted + locked by new `tests/photo-community-check.test.ts` (22). Client: type gains `unchecked`, the community card renders it, button copy + latency hint updated (30-90s). Verified: full `npm test` green (22 new), `npm run build` clean, `npm run check` 0 new TS errors (baseline 287, stash-diffed). COULDN'T live-smoke the vision leg (no ANTHROPIC_API_KEY / photo volume in the cloud session) — build + 22 pure tests + code-path verified; confirm live by clicking the button on a listing with a community folder + 2 units.
2026-06-17 · Jamie (Waikoloa "Full unit audit" screenshot): "I keep getting false positives — make it a definitive YES or NO, not a maybe; remove the 200 photo-check-a-day limit if needed" · SHIPPED on `claude/unit-audit-yes-no` (PR #721) · The builder Pre-Flight "Full unit audit" rendered TWO unmerged signals per platform — a TEXT badge (`/api/preflight/platform-check`) and a separate PHOTO sub-line — so a short/letter/empty-numbered unit was a DOUBLE maybe: text can only reach "unconfirmed" (finds the resort, can't pin the unit) and the photo scan kept returning "inconclusive" because the **200/day Lens cap** stopped the batch before the folder was scanned and it only sampled 5 photos. Three changes: (1) `PHOTO_CHECK_DAILY_CAP` default null = UNLIMITED (`server/photo-listing-scanner.ts`; still env-overridable; 0 hard-disables; circuit-breaker only fires when a finite cap is set); (2) the deep audit now reverse-image-scans the WHOLE deduped gallery (`PHOTO_AUDIT_MAX_PHOTOS`=30, was a fixed 5) so a clean result is trustworthy; (3) NEW pure `shared/preflight-verdict.ts` `mergeUnitVerdict()` merges text+photo into ONE decisive badge — text-confirmed OR ≥2-verified-photo-`found` → **Listed**; a DEEP `clean` → **Clear**; shallow/unknown → keep the honest text verdict. **LOAD-BEARING revision of #695/#696's "a community-listed unit degrades to unconfirmed, NEVER a false not-listed/Clear":** a GENERIC-UNIT unconfirmed (resort matched, unit unpinnable — the screenshot case) + a DEEP clean photo scan now resolves to **Clear** (honest copy: "the resort itself is listed, as always, but this specific unit was not"). This is the operator's explicit "YES or NO" ask and a full-gallery clean is the strongest available signal. Reviewed by a 13-agent adversarial Workflow; ALL its false-NO guards are implemented: a SHALLOW 3-photo background "clean" never overrides text (gated on `photosChecked >= DEEP_PHOTO_MIN`=4, both in the merge and in the endpoint's skip-if-fresh so the deep audit re-scans shallow rows), and a `unit-pinned`/`bedroom-conflict` unconfirmed (text located a REAL per-unit listing) is KEPT on Review WITH its link — only `generic-unit` is resolvable (server now tags the unconfirmed `reason`). Key resolution switched to `getSearchApiKeys()[0]`/`getSearchApiKey()` so an empty primary env with a live `SEARCHAPI_API_KEY_2` works. `tests/preflight-verdict.test.ts` (20) locks the merge incl. no-false-Clear + pinned-URL preservation. Verified: full `npm test` green, `npm run build` clean, `npm run check` 0 new TS errors (total 287→284). Couldn't live-smoke (no SearchAPI/Railway in this session) — verify by running a Full unit audit on a short-numbered unit and confirming it lands on Listed/Clear, not Review.
2026-06-17 · Jamie reported the builder compliance lookup "can't find any" TMK/GET/TAT/STR for Waikoloa Beach Villas (Big Island) · ACCEPTED (TMK leg) · Root cause: TMK + STR lookups were KAUAI-ONLY (`lookupKauaiTmkFromAddress` hits the County of Kauai ArcGIS layer; STR keys off the County of Kauai TVR PDF) gated by a `/kauai|koloa|.../` regex. Waikoloa ("Wai**koloa**" does NOT match `\bkoloa\b`) and every other non-Kauai Hawaii address fell straight through to `lookupHawaiiPublicListingLicenses` (public OTA snippet scraping), which finds nothing for heavily-rented resorts → all four fields empty. Fix: new `lookupHawaiiStatewideTmkFromAddress` in `server/hawaii-compliance-lookup.ts` geocodes (shared `geocodeHawaiiAddress` helper, extracted from the Kauai fn) then point-queries the State of Hawaii Statewide GIS "Statewide TMKs" layer (`geodata.hawaii.gov/.../ParcelsZoning/MapServer/25`) — covers Big Island/Maui/Oahu/Molokai/Lanai, returns the authoritative MASTER-parcel `tmk_txt` + qPublic link in the SAME `KauaiTmkLookupResult` shape so `/api/builder/tmk-lookup` serves it unchanged. The route now tries statewide GIS first for non-Kauai HI addresses, falling back to public search only on a GIS miss. LOAD-BEARING: the statewide layer exposes the master parcel only (no individual CPR/condo units), so confidence is always `master-parcel` — verify the qPublic link before pushing if a channel needs unit-level CPR (Kauai's dedicated CPR-aware path is unchanged). GET/TAT/STR are NOT fixed by this: GET/TAT are state DoT tax IDs the owner holds (only resolvable from Guesty/public listings) and Big Island has NO public STR registry API (Kauai's TVR PDF has no Big Island equivalent) — those still come from the connected Guesty listing or manual entry. Verified live e2e: Waikoloa Beach Villas → TMK `369008014` + qPublic link; Kona + Maui addresses also resolve. `npm test` green (+`tests/hawaii-tmk-lookup.test.ts` 7/0, fetch-mocked), `npm run build` clean, `npm run check` zero new TS errors.
2026-06-17 · Jamie (preflight property 900026 "Halii Kai at Waikoloa", draft 26): "Find different photos scrapes multiple different properties' photos, of a completely wrong community — I want to just repull/scrape the photos of the original unit" · ROOT-CAUSE FIXED + button realigned (PR #TBD) · DIAGNOSIS via the live DB + the two saved `_source.json` proofs + fetching the actual Redfin pages: both units point at OFF-MARKET/SOLD Redfin listings at 69-1029 Nawahine Pl (which IS the real Halii Kai resort address — `unit-5F` confirms the condo), and `extractGenericRealEstateGalleryFromHtml` harvested EVERY `cdn-redfin.com` image on each page, so each folder filled with the "Nearby similar homes" carousel — Unit A = 56 photos across **17 listings** (~3 each), Unit B = 52 across **16 listings**, sharing the same neighborhood comps (incl. an inland Waikoloa-Village golf home) → exactly the photo-community-check FAIL. Not a discovery-wander bug; the scraper itself was the contaminator. FIX (Part 1, the real one): `server/redfin-gallery.ts` `isolateRedfinSubjectGallery` keeps only the subject listing's photoSetId (from `og:image`); off-market `og:image`=Redfin-logo → keep NONE (drops the whole carousel) instead of saving comps. Wired into the generic extractor, so it cleans EVERY Redfin scrape (discovery/rescrape/replacement/audit) and makes discovery correctly skip dead listings. Verified on the real live HTML: Unit A 64-photos/17-listings → 2/1 (subject set 204315); Unit B 60/16 → 0 (off-market). See Load-Bearing "Photo scraping & curation" #1 (Redfin paragraph). FIX (Part 2, the operator's words): the preflight per-unit button is now **"Re-pull all photos"** — it rescrapes the unit's OWN saved listing first (`rescrapeSourceUrl`, full gallery, no 25 cap), falling back to discovery only when that source is off-market/yields < `MIN_INDEPENDENT_UNIT_PHOTOS`. This re-instates PR #739's intent that PR #740 had ripped out ("same photos") — now SAFE because Part 1 guarantees the rescrape returns only the subject, not comps. "Swap a genuinely different unit" stays on the separate "Find / Replace a Unit" button. Updated the conflicting #740 meta-assertion in `tests/pipeline-logic.test.ts` (it had hard-coded the now-reversed "must discover instead of rescrape"). Verified: `tests/redfin-gallery.test.ts` 11/0 (real off-market fixtures), full `npm test` green, `npm run build` clean, `npm run check` 0 new TS errors (baseline 288 unchanged). NOTE for draft 26 specifically: because BOTH its sources are off-market with no own gallery, a re-pull yields ~0 subject photos and falls to discovery — the units need an ACTIVE Halii Kai source (for-sale or the curated community gallery); the fix stops the contamination but can't conjure photos from a dead listing.
2026-06-18 · Jamie: "when I bulk add combo style listings it will a lot of the time fail because it cannot find an address … modify the process so it can always find and apply an address" · ACCEPTED · Follow-up to the 2026-06-17 address-discovery entry. Root cause of the residual misses: `discoverCommunityStreetAddress` only accepted a candidate whose google_maps `address` ALREADY carried a numbered street, but google_maps very often knows a resort's exact location (returns correct `gps_coordinates` + a name-matched title) while giving `address` as just the locality ("Princeville, HI 96722") — so the direct street path found nothing and the item failed the pre-check. ADDED a precision-safe reverse-geocode RESCUE: `selectCoordinateFallbackCandidate` (new pure, tested) surfaces the first title-matched (same whole-word gate as the street path — Alii/Halii still protected) streetless place that exposes coordinates; when no direct street hit is found across all queries, `reverseGeocodeToStreetAddress` (new in `server/walking-distance.ts`, Nominatim reverse, free/no-key, shares the 1-req/sec throttle) snaps those coordinates to a real numbered street. Precision-safe because the title gate has already confirmed the resort identity, so the coordinates belong to the correct place; a real direct street always wins over the rescue. Transient reverse-geocode failures throw (not negative-cached); a clean "no house-numbered road at the centroid" fails exactly as before. Discovery still runs ONLY for non-curated resorts (`!communityAddressRuleForName`) so it can never override a curated rule. See the `server/community-address-discovery.ts` header + the "REVERSE-GEOCODE RESCUE" block. Verified: `tests/community-address-discovery.test.ts` 21/0 (+4 new fallback locks), full `npm test` green, `npm run build` clean, `npm run check` 0 new TS errors. Live SearchAPI/Nominatim leg not smoke-tested from the cloud session (no SEARCHAPI key) — pure selection logic + wiring are test-covered; confirm on the next bulk sweep.
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
2026-06-18 · Jamie: "Check every single property on my dashboard (33 total). Make sure the bulk queue to update listing market pricing searches Airbnb with the correct resort/community name. Fix and push." · ACCEPTED + shipped (`claude/dashboard-properties-pricing-test-p4r4yp`) · DIAGNOSIS (evidence-based, via a probe that printed `curatedAirbnbSearchQueries(community)[0]` for every `PROPERTY_UNIT_CONFIGS` id): the bulk market-pricing queue (`/api/pricing/bulk-refresh` → `refreshHybridPricingForProperty`/`refreshHybridPricingForDraft` → `refreshHybridPricingForTarget` → `curatedAirbnbSearchQueries`) builds its SearchAPI Airbnb `q=` by preferring `market.platformSearch.airbnb`, then falling back to the multi-purpose `searchLocation`. Of the 6 communities backing configured properties, only **Poipu Kai** had a curated Airbnb term; **Keauhou, Princeville, Kapaa Beachfront, Poipu Oceanfront, Pili Mai** fell back to `searchLocation`, whose verbose `…, Kauai, Hawaii` / `…, Big Island, Hawaii` tail is meant for VRBO/Booking/find-buy-in — so those properties priced off a generic, inconsistently-formatted town/area search instead of the correct curated resort/community name. FIX (additive, low-blast-radius): added a curated `platformSearch.airbnb` (clean `"Place/Resort, City, ST"` form) to every active Hawaii market + the remaining Hawaii/FL markets a draft can resolve to (Kekaha, Poipu Brenneckes, Makahuena, Menehune Shores, Windsor Hills) in `shared/buy-in-market.ts`. **LOAD-BEARING — why only the `airbnb` term, not vrbo/pm:** `platformSearch.airbnb` is consumed by BOTH the pricing scan AND find-buy-in (`routes.ts` `airbnbWebsiteSearchTerm = buyInPlatformSearch.airbnb ?? websiteSearchTerm`); leaving vrbo/pm unset keeps find-buy-in's VRBO sidecar (its primary source) on the listing-specific `websiteSearchTerm`, so only the secondary Airbnb-via-SearchAPI source broadens to community level (a strict superset, filtered down by the existing resort-match) — no VRBO/pricing-geo behavior change (geo bounds in `geoConstraintForMarket` are untouched). Princeville + Poipu Oceanfront use COMMUNITY-level Airbnb terms on purpose (each spans multiple resorts). Guardrail: extended `tests/hybrid-pricing.test.ts` to enumerate EVERY `PROPERTY_UNIT_CONFIGS` id and assert its bulk-pricing Airbnb query equals the expected curated resort/community name AND rejects the verbose island+Hawaii `searchLocation` tail, plus a market-table sweep asserting every dashboard-backing market carries a clean `, ST` Airbnb term. Verified: full `npm test` green, `npm run build` clean (client+server), `npm run check` 0 new TS errors (baseline 344 lines, stash-diffed). Could NOT live-smoke the SearchAPI Airbnb call (no SEARCHAPI/Railway creds in the cloud session) — fix is code-path + probe + test verified; confirm live by running the bulk queue and reading the `[find-buy-in]`/scan logs.
2026-06-18 · Jamie: "When I run the Bulk market rate update queue it currently adds a 20% margin. Change the formula so it only applies a 15% markup — all pricing updates via the market update queue should be 15%. Merge + push." · ACCEPTED + shipped (`claude/bulk-pricing-15pct-markup`, PR #TBD) · The market-rate base rate is `ceil((1 + targetMargin) × buyIn)` (`cleanBaseRateFromBuyInServer`). The bulk queue (`pushBulkGuestyPricingAfterRefresh`) read `parseTargetMargin(schedule?.targetMargin) ?? 0.20`, and the per-property `scanner_schedules.target_margin` column defaulted to `0.2000` (operator-editable via the builder), so the EFFECTIVE markup was 20% everywhere. FIX: introduced a single source-of-truth constant `MARKET_RATE_TARGET_MARGIN = 0.15` in `shared/pricing-rates.ts`; the bulk queue now applies it directly. **LOAD-BEARING — intentional deviation:** the market-rate base push no longer reads the per-property `target_margin` (legacy rows carry the old 0.2000; the operator wants a uniform 15% across ALL queue updates). To stop the weekly availability scan from re-pushing 20% and undoing a 15% queue update, `availability-scheduler.ts` (`runScheduledScans` tick + `runFullScanNow`) now also passes `MARKET_RATE_TARGET_MARGIN` instead of the stored margin. Schema default for `target_margin` lowered `0.2000`→`0.1500` (and the schedule-upsert + lead-time-preview fallbacks now use the constant) for coherence; the column/builder UI is retained but no longer authoritative for the market-rate base push. Removed the now-unused `parseTargetMargin`. NOTE: the builder's client-side margin DISPLAY still reads `MIN_PROFIT_MARGIN`/stored schedule (cosmetic 20% possible) — left untouched to avoid moving the client profitability floor; the actual Guesty push is 15% server-side. Verified: full `npm test` green, `npm run build` clean (client+server), `npm run check` 0 new TS errors (baseline 344, unchanged). Could NOT live-smoke the Guesty push (no Guesty/Railway creds in the cloud session) — change is single-constant + code-path verified; confirm live by running the queue and reading the "...pushed at 15% margin" progress label.
2026-06-19 · Jamie: "In the photos tab of the unit builder: let me move the photos around in the unit gallery and community gallery. When we push to Guesty push: collage first, then Unit A, then Unit B, then community. Improve the order so they present best to guests. Implement + merge + push." · ACCEPTED + shipped (`claude/amazing-wright-d2260f`, PR #TBD) · Operator chose (via clarifying question) **auto hero-first by default** over keep-scrape-order. THREE layers: (1) NEW pure helper `shared/photo-order.ts` (`orderGallery`/`categoryRank`/`scopeForSource`/`bestOrderIndices`) — within one gallery, default to a hero-first category order (living/view/kitchen → bedrooms → baths → … for a unit; pool/beach/exterior → grounds → amenities → … for community), but if ANY photo carries a manual `sort_order` the whole gallery is ordered by it (drag wins); stable on original index. (2) `client/src/pages/builder.tsx` `propertyData.photos` assembly REWRITTEN: was community-opener → Unit A → community-separator → Unit B → community-end (interleave); now units-first-then-community, each gallery `orderGallery`'d. This array is the single source of truth for BOTH the Photos-tab display AND `/api/builder/push-photos` (sends it verbatim) — and the cover collage is already prepended first by `upload-collage`, so the live Guesty order = collage → A → B → community. (3) `PhotoCurator.tsx` gained native HTML5 drag-and-drop + ◀▶ move buttons per tile (optimistic overlay so a drop shows instantly) and a per-gallery "↺ Reset to best order"; reorder/reset persist via NEW `POST /api/photo-labels/:folder/reorder` (`storage.reorderPhotosInFolder`/`resetPhotoOrder`) → `photo_labels.sort_order` (NEW nullable column, added in `schema-maintenance.ts`, NOT db:push) → `onPhotoOverridesChanged` refresh rebuilds `propertyData`. `usePhotoLabels` now exposes `categoryFor`/`sortOrderFor`. **LOAD-BEARING — intentional deviation from old decision #2:** that decision ("users want Zillow's scrape order, no category sort") applies to the scrape/review pipeline; the operator explicitly opted into hero-first for the *published push order* here, so #2 does NOT govern the push. Reorder is folder-scoped; cross-gallery drags are ignored (the A→B→community order is structural). See new Load-Bearing "Photo scraping & curation" #46. Verified: `tests/photo-order.test.ts` (10) + full `npm test` green, `npm run build` clean (client+server), `npm run check` 0 new TS errors (baseline 309, stash-diffed). Could NOT live-smoke the Guesty push / drag UI (no DB/Guesty creds in the cloud session) — build + test + code-path verified; confirm live by dragging a photo on the Photos tab then pushing.
