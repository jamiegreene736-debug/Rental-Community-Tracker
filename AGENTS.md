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

25. **Vanilla rebrowser-playwright + the Dockerfile's Chromium — never
    Browserbase — for app.guesty.com automation.** Browserbase is in
    the dependency tree (`@browserbasehq/sdk`) because Vrbo's PUBLIC
    site CAPTCHAs anonymous traffic, and `pm-scraper-vrbo.ts` uses
    Browserbase + residential proxy to get past it. Guesty's
    AUTHENTICATED admin UI for paying customers does not have that
    problem — vanilla Playwright with the local
    `/usr/bin/chromium` (already in the Dockerfile) and
    rebrowser-playwright's CDP-leak patch handles Okta's bot
    detection. This saves the ~$0.10/click Browserbase session cost
    and the API-key footprint. If you find yourself reaching for
    Browserbase for a Guesty automation, first check whether the
    existing `openGuestyAdminPage` helper in
    `server/guesty-playwright.ts` works — it almost certainly does.

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

28. **VRBO compliance submission drives Guesty's UI; the form-fill is
    heuristic, not selector-based; the republish step is automated as
    part of the same session.** Sister to the Airbnb compliance flow but
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
