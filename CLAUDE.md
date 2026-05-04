# CLAUDE.md — Claude Code session primer

**Read [`AGENTS.md`](./AGENTS.md) first.** It's the shared contract
between me (Claude Code) and Codex, and it documents the load-bearing
design decisions I made in prior sessions — many of which will look
like bugs if I encounter them cold.

## Session checklist

Before making any changes:

1. Read `AGENTS.md` in full.
2. Scan the Decision Log for recent entries (resolved disputes).
3. Check the Load-Bearing Decisions section against the area I'm
   about to touch.

## My role (reminder)

- Feature branches named `claude/<slug>`, push PRs, **merge my own
  PRs via `gh pr merge --squash --delete-branch --admin`** once the
  work is done. The branch-protection checks aren't wired for
  `claude/*` branches so admin override is the standing pattern.
  Do not pause to ask the human to click Merge — it wastes a turn.
- Conventional commits (`feat:` / `fix:` / `refactor:`).
- PR body includes *why*, test plan, and "intentional deviations"
  section when I break a pattern on purpose.
- Deploy verification via API smoke tests or Playwright against the
  live Railway URL.

## When to update AGENTS.md

- After resolving a disagreement with Codex or the human — append a
  Decision Log line.
- When I introduce a new load-bearing constraint — add it to the
  Load-Bearing Decisions section in the same PR.
- When I remove/replace a load-bearing decision — replace (don't
  delete) the entry with a note pointing to the new PR.

## Key files

- Architecture pointers are in `AGENTS.md` under "Architecture
  pointers". Don't duplicate them here.

## Recent operational notes

- 2026-05-04 (special-offer pivoted to clipboard + open-in-Guesty): the
  earlier preset-discount work surfaced a downstream issue — the actual
  POST to Guesty 502'd because Guesty's Open API
  (`open-api.guesty.com/v1`) does NOT expose an Airbnb special-offer
  endpoint for this tenant. Verified 2026-05-04 across 13 path
  variants: `/reservations/{id}/special-offer`, `/airbnb2/...`,
  `/airbnb/...`, `/channels/airbnb/special-offers`,
  `/channels/airbnb2/special-offers`, `/airbnb-special-offer-requests`,
  `/listings/{id}/special-offer`, conversation-namespaced variants —
  every single one returns 404 ("Cannot POST /api/v2/..."), with
  Guesty's response confirming the v1→v2 internal rewrite. Pre-approve
  and decline still work because they're WRITABLE FIELDS on the
  reservation document (`preApproveState`, `status`) that PUT
  /reservations/{id} accepts; special-offer needs a channel-action
  endpoint Guesty doesn't ship in v1. Pivoted the dialog footer button
  from `apiRequest("POST", ...)` to: `navigator.clipboard.writeText`
  the discounted price + `window.open(https://app.guesty.com/inbox-v2/
  {convId}/reservation, "_blank")` so the operator pastes into
  Guesty's native Special Offer form. The discount-preset buttons
  (5/10/15% off) still do all the math — that was the actual painful
  part. Server endpoint at `/api/inbox/reservations/.../airbnb/
  special-offer` and the underlying `callGuestyAirbnbAction`
  candidate-walker remain in place for future reactivation if/when
  Guesty ships the API endpoint. Inline NOTE FOR CODEX comments on
  `sendSpecialOffer` and the dialog explainer flag this as
  intentional, not a UI preference. Alternative path (Playwright
  against app.guesty.com per Load-Bearing #25–32) was considered and
  deferred — too heavy for a workflow the operator can complete in
  ~10s by pasting a number.
- 2026-05-04 (special-offer quick-discount presets): added 5% / 10% / 15%
  preset buttons inside the Send Special Offer dialog (`inbox.tsx` near
  the price input around line ~3318). Use case: Jamie kept telling guests
  he'd give them a 5% discount but had to do `currentTotal × 0.95` in his
  head before opening the dialog — error-prone, especially across
  multiple inquiries. Buttons compute `Math.round(currentTotal × (1 −
  pct/100))` and write the result into the price input. The currently-
  applied preset is highlighted by comparing the price field back to the
  preset value (within $1 to absorb integer rounding). A "Reset" button
  restores the original quote, and a small green line under the buttons
  confirms the actual $ off and % applied (e.g. "$283 off (5.0% discount)
  — guest pays $5,369"). NOTE FOR CODEX: discount is applied to the
  GUEST-FACING total (`specialOfferDialog.currentTotal`), NOT to host
  payout — that's what Airbnb's Special Offer overrides. Airbnb adds its
  service fee on top of whatever total we set, so the guest sees the
  discount applied to the base accommodation+cleaning rather than the
  all-in.
- 2026-05-04 (inbox buy-in estimate): added an inquiry-time buy-in cost
  estimator to the Guest Inbox right panel. Use case: Jamie was getting
  short-stay inquiries (Michelle's Kaha Lani 4-nighter on Nov 17–21)
  where cleaning fees swallow the margin and wanted a glance-able way
  to see "is this profitable, or do I need to send a higher Special
  Offer?" without running the full /find-buy-in flow (which is ~60s
  and burns SearchAPI budget — overkill for a triage decision). New
  endpoint: `GET /api/inbox/buy-in-estimate?listingId=X&checkIn=Y
  &checkOut=Z&cleaningFeePerUnit=N` in `server/routes.ts` — maps the
  Guesty listingId to the local property via `guestyPropertyMap`,
  derives `pricingArea` from `suggestPricingArea(city, state,
  complexName)` (so Kaha Lani's "Lihue" address falls through to
  "Kapaa Beachfront" via the Hawaii city regex), seasons by check-in
  month via `getSeasonForMonth`, and computes per-unit nightly ×
  nights + flat per-unit cleaning. Client renders a small "Buy-in
  estimate" block in the right panel below the Send Special Offer
  button, gated to `phase === "inquiry"`. Cleaning fee is editable
  inline and persisted via the same `nexstay_cleaning_fee`
  localStorage key buy-in-tracker.tsx already uses (so changing it
  on either page propagates everywhere). Bottom line: per-night row
  amortizes cleaning across the stay so a 4-night stay at $250/unit
  surfaces +$125/night vs ~$71/night on 7 nights — operator can
  glance both rows and decide. NOTE: deliberately NOT a live
  /find-buy-in call — static-table estimate is within ~±20% of
  market, plenty for the is-this-worth-it decision; the live search
  remains canonical when the operator actually accepts. Drafts
  (community_drafts) aren't covered yet — v1 scope is the static
  unit-builder portfolio. Inline `NOTE FOR CODEX` comments at the
  endpoint, the address parser (off-by-one trap is real — earlier
  version pulled "4460 Nehe Rd" as the city), the cleaning-fee
  state, and the render block.
- 2026-05-04 (follow-up to the same-day inbox-v2 fix below): the previous
  fix taught the client to READ `state.lastMessage.{body,date}` and
  `state.readByNonUser` / `state.isLastPostFromGuest`, but Jamie spotted
  that Michelle's Kaha Lani thread (`69ea7b4608e5bc000f8e89ef`) was still
  pinned at its Apr 23 creation date with no unread dot — the May 3 + Apr
  30 follow-ups appeared in the THREAD VIEW (so the renderer was OK), but
  the LIST row was unchanged. Root cause: Guesty's
  `/communication/conversations` LIST endpoint returns a STRIPPED `state`
  object by default — only `{read, status}`, no `lastMessage`,
  `readByNonUser`, or `isLastPostFromGuest`. Guesty's `state` only
  expands to its full shape when the request includes a `fields=` query
  param (even empty `?fields=`). Our previous request was just
  `?limit=30`. Fix: append `&fields=` to the inbox client list query
  (`client/src/pages/inbox.tsx`) and the auto-reply scheduler list query
  (`server/auto-reply.ts` `fetchOpenConversations`). Inline `NOTE FOR
  CODEX` comments at both call sites flag this as load-bearing — the
  empty `fields=` looks like a typo and would be tempting to strip, but
  removing it silently degrades the list back to creation-date timestamps
  and disables the unread indicator.
- 2026-05-04: Claude Code fixed the Guest Inbox so it actually surfaces
  new guest messages on Guesty's inbox-v2 shape. Jamie spotted that
  Michelle's thread (`69ea7b4608e5bc000f8e89ef`) had two follow-up
  messages on Apr 30 + May 3 visible in Guesty's UI but invisible (or
  miscategorised) in our Guest Inbox. Root cause: Guesty inbox-v2
  posts use `sentBy: "guest" | "host" | "log"` and conversations expose
  the latest activity at `state.lastMessage.{body,date}` plus
  `state.readByNonUser` + `state.isLastPostFromGuest`. The legacy
  `isIncoming` / `direction` / `authorType` / `senderType` fields are
  null on every current production conversation, and `state` is now an
  object instead of the old `"NEW"` / `"UNREAD"` strings. Effects: list
  rows showed an empty preview, the timestamp dropped to the thread's
  `createdAt` (so Michelle's row stayed pinned at Apr 23), no unread
  dot ever rendered, and inside the thread every message rendered as a
  guest bubble because `isHost` couldn't tell guest from host. Worse,
  `auto-reply.ts` `pickPostToReplyTo` returned null for every thread
  (no posts looked "incoming"), so the auto-reply scheduler silently
  skipped real guest messages — no log entry, no draft, no flag — for
  weeks before this surfaced. Fix: `client/src/pages/inbox.tsx`
  `normalizeConversation` now reads `state.lastMessage` for
  preview/timestamp and treats `readByNonUser=false &&
  isLastPostFromGuest=true` as the unread signal; the conversation
  list is now sorted client-side by latest activity (Guesty's default
  ordering is creation date, which freezes long threads); the thread
  renderer adds `sentBy === "host"` to the `isHost` heuristic and
  filters `sentBy === "log"` system entries (e.g. "New guest
  inquiry"). `server/auto-reply.ts` `isIncomingPost`, `isHostPost`,
  and `isSystemPost` all add `sentBy` as the highest-priority signal.
  Legacy field checks are kept for older cached fixtures and any
  non-Guesty inbox source we add later. Notes for Codex are inline in
  both files at every changed block (search `NOTE FOR CODEX`).
- 2026-05-01: Codex changed find-buy-in PM discovery so Google searches
  are SearchAPI-only. The local Chrome sidecar should no longer be used
  to visit google.com for PM sourcing; it should only open concrete
  candidate PM/OTA URLs to verify rates and availability. In
  `server/routes.ts`, the old `googleSerpViaSidecar` PM stage-1 and
  "Sidecar Google PM finder" paths were replaced with multi-query
  SearchAPI discovery (`pmPromise` + `pmSearchApiFinder`). Kaha Lani also
  now falls back to the curated `COMMUNITY_LOCATION_BY_KEY` search name
  (`Kaha Lani Resort`) when Guesty title lookup cannot resolve a resort,
  and `/api/admin/pm-discovery` / `/api/admin/pm-auto-discover-all` use
  curated resort search names instead of generic internal keys like
  `Kapaa Beachfront`. The admin discovery module
  `server/pm-discovery.ts` keeps `sourceBreakdown.sidecar` for response
  compatibility, but it is intentionally always `0`. Follow-up in this
  session: find-buy-in now prioritizes unpriced PM rows that would render
  as "manual quote" and pushes them through `checkPmUrlsBatchViaSidecar`
  before returning results, so Chrome gets a chance to extract a live
  rate from the PM booking widget automatically. Follow-up safety guard:
  optional sidecar verification now observes a 270s route budget and stops
  early with diagnostics (`skippedForBudget`) instead of risking Railway's
  ~5-minute edge timeout. Follow-up from Jamie's 2026-05-01 diagnostic
  report (`25` sidecar checks, `0` verified): the local sidecar now runs a
  shared `dismissObstructions()` helper after page load for VRBO, Booking,
  Google, and PM URL checks. It clicks safe close/dismiss/no-thanks/cookie
  controls, presses Escape if a modal remains, logs what was dismissed, and
  appends that detail to PM verification reasons. The find-buy-in diagnostic
  report now summarizes top sidecar failure buckets (unavailable/stay-rule,
  no date-specific total, no clear signal, bot wall, navigation error, with
  popup-dismissal noted) so Jamie can paste one report instead of screenshots.
  Follow-up from Jamie watching Chrome: PM URL verification was only adding
  date query params and scraping, which fails on PM widgets that ignore URL
  params until a human fills the inputs. The sidecar now runs a generic
  `applyPmDateInputs()` step before scraping PM rates: it opens availability
  widgets when needed, fills check-in/check-out or a date-range field,
  clicks a nearby Search/Check Availability/View Rates/Book/Reserve action,
  waits for the AJAX/navigation settle, then scrapes. Verification reasons
  now include `entered dates (...)` and the server diagnostic buckets call
  out outcomes "after date entry."
- 2026-04-30: Codex added operator-facing diagnostics for
  `/api/operations/find-buy-in`. The route now returns a `diagnostics`
  object with per-source status (`Airbnb`, `Vrbo`, `Booking.com`, `PM
  companies`, sidecar verifier), raw/kept/priced/verified counts,
  elapsed time, captured source errors/timeouts, and a copy-friendly
  report string. The bookings live-search UI auto-opens a dismissible
  "Search log" dialog whenever severity is `warning` or `error`, keeps
  the search results visible behind it, and leaves a persistent "View
  log" button in the panel after close. This is meant to replace
  screenshot-only debugging when Jamie sees a partial/slow/fallback scan.
  Follow-up smoke caught that verifier `no`/`unclear` counts were being
  counted only inside the priced pool; Codex changed them to count every
  sidecar-checked URL so the report does not say "25 checked, 0 no,
  0 unclear" when all checked URLs were actually unavailable/unclear.
- 2026-04-30: Codex fixed the Steve Kuykendall multi-slot find-buy-in
  flow after Jamie saw an error-before-results, duplicate unit selection,
  and missing Booking/PM rates. Changes: client auto-fill now seeds its
  picked-URL set with already-attached sibling slot URLs and live-search
  panels hide candidates already attached elsewhere in the reservation;
  `storage.attachBuyIn()` also rejects attaching the same canonical
  listing URL to two units in one reservation. The live-search query keeps
  previous completed results visible during slow refreshes so a transient
  retry/error state doesn't make the scan look broken. Booking.com search
  cards are now treated as URL discovery only because their card prices can
  be teaser/partial totals; sidecar detail verification opens the Booking
  page, requires a priced room block matching the requested bedroom count,
  and only then promotes the real total/nightly rate. PM/Booking sidecar
  verification now covers up to 25 URLs, and the sidecar Google PM finder
  starts in parallel with other source discovery to reduce cold-scan wall
  time. The live worker at `~/Downloads/vrbo-sidecar/worker.mjs` was copied
  and restarted while testing. Smoke checks: `npm run build` passed;
  `npm run check` still fails on pre-existing repo-wide TypeScript errors.
- 2026-04-30: Codex diagnosed Steve Kuykendall / Unit 721 showing a
  `$0` Parrish fallback even though PM rows were scanned. Root cause was
  the local sidecar `pm_url_check_batch` verifier throwing a DOM
  `SyntaxError`: `scrapePmUrl()` used Playwright selectors
  (`button:has-text("Reserve")`) inside `page.evaluate()` with native
  `document.querySelector()`. Every checked PM URL became
  `verified="unclear"` with `verifiedReason="tab error..."`, so
  find-buy-in had `2 priced · 0 verified` and Auto-fill attached the
  unpriced fallback. Follow-up issue: generic PM verification then trusted
  category-page text like `$200/night`, which is not a date-specific quote.
  Fix: sidecar now detects reserve/book affordances with native CSS plus
  text matching, uses Suite Paradise `rcapi` and VRP/Parrish `vrpjax`
  endpoints when those platforms are detected, requires a date-specific
  total (or reserve + nightly + visible requested dates) for generic PM
  success, and `/api/operations/find-buy-in` no longer returns unpriced
  `$0` manual-quote fallbacks in `cheapest` because Auto-fill consumes that
  list directly. The live worker at
  `~/Downloads/vrbo-sidecar/worker.mjs` was copied and restarted.
  Post-deploy smoke on Railway deployment
  `db1f98de-d145-460b-a509-05e961439736` for property `4`, `3BR`,
  `2026-06-13 → 2026-06-20` returned `cheapest=[]` and no `$0`
  fallback; sidecar checked 15 PM URLs (`12` booked/unavailable, `3`
  unclear). The stale bad `$0` attachment for Steve Kuykendall / Unit
  721 (`buy_ins.id=84`) was detached via
  `POST /api/bookings/detach-buy-in/84`; the row remains in buy-ins but
  is no longer attached to the reservation. Relevant commit:
  `fix(sidecar): verify PM rates with date-specific signals`.
- 2026-04-30: Codex fixed find-buy-in result quality/pricing issues and
  the local Chrome sidecar ergonomics. Key points: stale empty live-search
  cache is short-lived and manual refresh adds `nocache=1`; Poipu Kai
  filters now require condo-like 3BR candidates; sidecar Chrome is not
  intentionally zoomed out, so the worker now launches at `1280x900`,
  resets page scale/zoom best-effort, creates a fresh daemon tab on
  startup, times stale-tab cleanup, polls every ~10s idle / ~2s busy,
  and the live worker at `~/Downloads/vrbo-sidecar/worker.mjs` was copied
  + restarted. Relevant commits: `55aba79`, `4dc74f6`, `b89cdeb`,
  `aab4366`, `cde689c`, `d5eff1f`, `87e6ccb`.
- 2026-04-30: Codex fixed Airbnb "Replace photos" replacement discovery
  so channel-scoped Airbnb replacements may use clean Poipu Kai units
  found on VRBO, provided the unit is not listed on Airbnb. VRBO listing
  galleries must be scraped through the local sidecar because Railway
  receives VRBO's bot wall directly. Relevant commits: `75f4874`,
  `8afb0df`, `89d8d55`, `7a93161`, `47cfa5b`. Follow-up in this
  session made non-array sidecar results valid (`{ photos: [...] }`)
  and made CDP cookie seeding best-effort when Chrome refuses injection.
