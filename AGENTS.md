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

29. **Google's identifier-step CAPTCHA is solved via 2captcha; 2SV
    and "verify it's you" challenges still aren't.** The SSO path
    routinely trips Google's "Type the text you hear or see" image
    CAPTCHA on the email step because Railway's IP has no device
    history. `loginToGuestyViaGoogleSso` detects this state — still
    on `/signin/identifier` after submit + a CAPTCHA `<img>` present
    — and submits the image to 2captcha (`server/captcha-solver.ts`)
    with `TWOCAPTCHA_API_KEY`. Cost: ~$0.001/solve, typically once
    every 4-7 days because the device-trust cookie persists. Up to 2
    solves per run (Google sometimes chains a second CAPTCHA after a
    correct first one); past that it's a session-suspect signal and
    we bail with the cookie-refresh recommendation. Bad solutions
    are reported back to 2captcha for credit refund.

    What 2captcha does NOT solve: the post-password challenges (2SV
    Google Prompt, authenticator code, security key, "verify it's
    you" device check, "this browser may not be secure" wall). Those
    are genuine hard-blockers per #28; the answer remains refreshing
    `GUESTY_SESSION_COOKIES`. The CAPTCHA gate just removes the most
    common failure mode — the one that fires every single first
    login from Railway — and turns a daily intervention into a
    monthly one.

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

    Wallet: ~3 SearchAPI text calls + 3 SearchAPI Lens calls per
    qualifier = ~6 calls. find-clean-unit walks up to 8 candidates,
    so a worst-case "no clean unit found" scan is ~3 (Zillow
    discovery) + 8 × 6 (per-candidate qualifier) + 8 (Apify
    scrapes) = ~51 SearchAPI calls + 8 Apify calls. First clean
    candidate short-circuits — common case is 1–3 candidates.

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
2026-04-29 · Jamie: "You are not running the browser session locally like I asked. You have to run the browser on my PC." After multi-PR investigation showed Vrbo's anti-bot fingerprints every Browserbase residential session even with persistent context + real-Chrome cookies (IP-level flag — "There is a robot on the same network as you"). Direct Chrome MCP test from operator's home IP returned 42 priced properties for the same query that Browserbase couldn't load past the bot wall. · ACCEPTED · New "VRBO local-Chrome sidecar" architecture: in-memory queue on Railway (`server/vrbo-sidecar-queue.ts`) bridges find-buy-in to a `/loop` worker running inside the operator's Claude Code session. find-buy-in calls `searchVrboViaSidecar()` as path 9 (parallel with the existing 8 paths, prioritized FIRST in the dedup chain when results return because it's the only path that beats the IP wall). When the worker is offline, the wallet budget (75s) expires and we gracefully fall back. Endpoints `POST /api/vrbo-sidecar/enqueue`, `GET /api/admin/vrbo-sidecar/next`, `POST /api/admin/vrbo-sidecar/result`, `GET /api/vrbo-sidecar/result/:id`. Worker is a /loop task in Claude Code that polls /next, drives Chrome MCP through Vrbo's search UI on the operator's actual browser, extracts priced cards, and POSTs the result. This is the "OpenClaw"-style local-agent pattern — Claude Code on the operator's Mac is the bridge between Railway and their real-IP browser.
```

(Populate on first dispute.)

## Architecture pointers

- `server/routes.ts` — single big Express router. Zillow scrapers
  (`scrapeZillowViaApify` / `scrapeZillowViaScrapingBee`) live here,
  as do the photo-label + availability endpoints.
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
