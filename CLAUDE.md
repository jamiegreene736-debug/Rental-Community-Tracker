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

- 2026-07-03 (dashboard duplicate-photos WARNING POPUP + "Confirm photos replaced" verify rescan):
  Operator asked for a refund-style warning popup when a unit shows duplicate photos on
  Airbnb/VRBO/Booking, with a "confirm you replaced the photos" action that rescans and confirms the
  replaced photos are gone from all three OTAs. SHIPPED (`claude/duplicate-photos-warning-ymujum`,
  PR #TBD): pure `shared/duplicate-photo-warning.ts` (13 tests) — dismissal signature (folder +
  platforms + checkedAt, so a FRESH scan re-confirming duplicates re-raises a dismissed popup) +
  `photoReplaceRescanVerdict` (pending until the row's checkedAt passes the rescan start, 1s
  tolerance; any FOUND beats inconclusive; `clean` requires ALL THREE platforms clean — never a soft
  green). `home.tsx`: `photoByProperty` folder loop now emits `duplicateUnits` (photo statuses only —
  address-on-OTA hits deliberately excluded, the remedy here is "replace the photos"); auto-opening
  red Dialog (refund-alert styling) + persistent "Review & fix" banner above the table; per-unit
  "Confirm photos replaced" button → `window.confirm("Confirm that you have replaced the photos…")` →
  `POST /api/photo-listing-check/run {folders:[folder]}` (the existing DEEP scan, scoped to that one
  folder; no new server code) → inline pending spinner → green "no longer found on Airbnb, VRBO, or
  Booking.com" / red STILL-found re-warning ("Rescan again"). A now-clean unit drops out of the
  duplicate list but keeps its green row via the `photoReplaceRescans` state entry. Dismissal
  persists in localStorage `nexstay_duplicate_photo_warning_dismissed`. NOT a reintroduction of the
  ripped-out PR #318 "Replace & push" banner — no master-sync push; replacement stays manual/builder.
  Verified: `tests/duplicate-photo-warning.test.ts` 13/0, full `npm test` exit 0, build clean,
  `npm run check` 335 = baseline (0 new). Could NOT live-smoke a real rescan (no SEARCHAPI key in
  session) — confirm post-deploy: the popup should auto-raise if any dashboard Photos cell is red.

- 2026-07-03 (bulk market-pricing queue: leave-your-phone SURVIVABILITY — boot/watchdog resume +
  return-visit surfacing): Operator asked to be able to start the mass market update from his phone,
  leave Safari, and have it run to the end. AUDIT (don't re-chase): the queue was ALREADY fully
  server-side (fire-and-forget worker, Postgres-persisted, lease renewed each heartbeat, loopback
  pushes, no sidecar) — closing Safari never stopped it. The GAP: an ORPHANED job (Railway
  redeploy/restart mid-queue) was only ever resumed by a client GET, so with no browser open it froze
  "running" until the next dashboard visit. SHIPPED (`claude/mass-update-guesty-sync-5pff0c`, PR
  #TBD): (1) `startBulkPricingResumeWatchdog` (routes.ts; wired in `server/index.ts` after listen) —
  boot pass ~20s after listen (loopback push must be live) + 2-min interval calling
  `resumeOrphanedBulkPricingJobs`; the atomic lease claim keeps it safe vs live workers/deploy
  overlap; gate `BULK_PRICING_RESUME_DISABLED=1`. (2) Return-visit UX: pure
  `shared/bulk-pricing-queue-surface.ts` (8 tests) — the discovery poll now surfaces a live queue OR
  the most recent finished-≤24h queue (so the PR #885 push-confirmation banner is seen), honoring
  "Clear queue" dismissals persisted in localStorage (`nexstay_dismissed_bulk_pricing_jobs`); a
  surfaced terminal job fetches its events once. (3) The "Update market pricing" trigger button no
  longer requires selected rows to OPEN the dialog when a queue exists, and shows a live status chip.
  Verified: full `npm test` exit 0, build clean, `npm run check` 335 = baseline. Could NOT live-smoke
  a restart-resume (no DB creds) — confirm post-deploy via the "[bulk-pricing] boot-resume:
  re-claiming orphaned running job" Railway log line after a mid-run redeploy.

- 2026-07-03 (bulk market-pricing queue: per-property GUESTY PUSH CONFIRMATION): Operator asked to
  ensure every property in a dashboard mass market update pushes its rates to Guesty AND to confirm
  it visibly. AUDIT (don't re-chase): the push was already robust — read-back verification
  (`verifiedDays`) inside `POST /api/builder/push-seasonal-rates`, item-level retry (2 attempts) on
  any push throw, "Retry failed rows", and `markScannerGuestyRatePush` ok/error stamps feeding the
  "Last Price Scan" column. The GAP was that a queue item can COMPLETE without pushing
  (`guestyPush.skipped`: unmapped listing / no priced months) and nothing aggregated "did they ALL
  push?". SHIPPED (`claude/mass-update-guesty-sync-5pff0c`, PR #TBD): pure
  `shared/bulk-pricing-push-logic.ts` (29 tests) classifies each item from the already-persisted
  `progress.guestyPush` (pushed/skipped/failed/cancelled/pending/unknown; failed status beats stale
  pushed progress). Server `emitBulkPricingPushCoverage` writes a durable terminal queue event —
  `guesty-push-confirmed` or `guesty-push-incomplete` with the per-property attention list — in both
  terminal paths; `summarizeBulkPricingJob` exposes `dryRun`. UI (`home.tsx`): per-item chips
  ("✓ Pushed to Guesty · N days · N verified" / amber "⚠ NOT pushed" / red "✕ not confirmed"), a live
  "Pushed to Guesty X/Y" stat tile, and a terminal green all-pushed banner or amber/red banner listing
  exactly which properties didn't push and why. Verified: full `npm test` exit 0, build clean,
  `npm run check` 335 = baseline. Could NOT live-smoke (no Guesty creds) — confirm post-deploy by
  running a mass update and checking for the green banner.

- 2026-07-01 (market-rate median → ALL-IN checkout cost + 20% markup): Live-diagnosed a running 6BR
  scan in the Railway logs (propertyId -15, "Spacious 6BR for 14 at Ko Olina!") — the reverted median
  engine correctly did resort lookup → exact-3BR → median (p50) → 7-night × 24 months → summed 2 units →
  pushed 731/731 days to Guesty. Operator wanted two corrections: markup 20% (was 15%) and the buy-in to
  equate to the ACTUAL Airbnb checkout total (the median = `extracted_total_price ÷ 7` includes
  cleaning+service fees but NOT occupancy tax). SHIPPED (`claude/market-rate-allin-20pct`, PR #TBD):
  (1) `MARKET_RATE_TARGET_MARGIN` 0.15→0.20 in `shared/pricing-rates.ts`. (2) new `LODGING_TAX_PCT`
  (HI 0.18/FL 0.125) + `applyLodgingTaxGrossUp(basis, community)` there (single tax-table source;
  `static-rate-logic.ts` now RE-EXPORTS it). `server/hybrid-pricing.ts` grosses the SearchAPI median up
  by the regional tax at the point it becomes the stored `basis`. LOAD-BEARING: taxed ONLY on a real
  SearchAPI median (NOT the thin-comp static fallback), and NOT double-applied in the year-2
  extrapolation branch (year-2 = already-taxed year-1 basis × growth). Kill-switch
  `MARKET_RATE_LODGING_TAX_DISABLED=1`. Net ≈ +23% vs prior 15%/no-tax for a HI combo; effective on the
  NEXT push per property (re-run the queue for Ko Olina to apply). Verified: full `npm test` exit 0,
  `npm run build` clean, `npm run check` 335 = baseline; adversarial diff review. Full rationale:
  AGENTS.md 2026-07-01 Decision Log line.

- 2026-07-01 (bulk market-pricing queue: "Clear queue" button that always works): Operator couldn't
  clear the queue — a STUCK/orphaned running item (worker heartbeat but never completes) kept
  `job.status = "running"`, so `bulkPricingTerminal` was never true and the old "Clear completed queue"
  button stayed disabled; "Cancel remaining" couldn't rescue it either because
  `POST /api/pricing/bulk-refresh/:jobId/cancel` only terminalized a `"queued"` job (a running job with
  a dead lease was left "running" forever). FIX (`claude/bulk-queue-clear-button`, PR #TBD): (1) the
  cancel route now accepts `?force=1` — the operator "Clear queue" action — which unconditionally
  terminalizes the job (all non-terminal items → cancelled, `status = "cancelled"`, lease released via
  `job.lockedBy/lockExpiresAt = null` + `activeBulkPricingJobIds.delete`) so a stuck item can't hold it
  open; it ALSO now terminalizes a non-force cancel when there's no live worker lease (dead/expired) —
  fixing "Cancel remaining" for orphaned running jobs. Graceful stop (live worker keeps its current item
  running to stop at the next SearchAPI-month boundary) is preserved for a normal non-force cancel. (2)
  `home.tsx`: "Clear completed queue" → "Clear queue", always enabled; `clearBulkPricingQueue()`
  force-cancels server-side when not terminal (with a confirm), then dismisses local state
  (`setBulkPricingJob(null)` + selection + events). The discovery poll only re-surfaces queued/running
  jobs, so a cleared (cancelled) job stays gone. Verified: full `npm test` exit 0, `npm run build` clean,
  `npm run check` 335 = baseline (0 new).

- 2026-07-01 (REVERTED market-rate updates to the legacy SearchAPI Airbnb engine, now using the MEDIAN
  not P40): Operator: "This new [Claude all-in] methodology is not working well. Revert to the old
  methodology for market-rate updates (dashboard queue + Pricing-tab 'Update Market Rates' button), but
  use the MEDIAN Airbnb price instead of P40." SHIPPED (`claude/revert-airbnb-median`, PR #TBD). This
  UNWINDS the default of the 2026-06-29 static engine + the 2026-06-30 (#873) all-in work FOR THE UPDATE
  PATH ONLY — the Claude static/all-in engine code stays intact but DORMANT (re-enable with
  `STATIC_RATE_ENGINE=1`); do NOT delete it. Two edits: (1) `staticRateEngineEnabled()` in
  `server/routes.ts` flipped to default OFF (`process.env.STATIC_RATE_ENGINE === "1"`, was
  `STATIC_RATE_ENGINE_DISABLED !== "1"`). All three market-rate entry points route back to
  `refreshHybridPricingFor{Property,Draft}` (hybrid-pricing.ts); `generateStaticRatesForTarget` is only
  reachable behind that flag, so the revert is complete. (2) `MARKET_PRICING_PERCENTILE` in
  `server/hybrid-pricing.ts` 40 → 50 (the median; `interpolatedPercentile(values,50)` == the `median`
  already computed in `marketPricingBasis`; the prior-month tie-adjust `closestDistinctSampleBasis` is
  unchanged). Relabeled operator-facing "P40" → "median" (routes progress + push-error, client
  queue/refresh labels, `formatPricingRecipe`); `tests/hybrid-pricing.test.ts` recompute — source-grep
  `= 40`→`= 50`, the one distinct-median fixture 440→450 (3BR `[400,500]`), tie-adjust `[100,100,200]`→200
  and single `[400]`→400 unchanged. Verified: full `npm test` exit 0, `npm run build` clean,
  `npm run check` 335 = baseline (0 new); adversarial diff review. Post-deploy: the dashboard "Update
  market pricing" queue + Pricing-tab button now scan SearchAPI Airbnb and price from the median (the
  Pricing tab shows "… · N-night median" and the queue phase reads "searchapi-airbnb"). Full rationale:
  AGENTS.md 2026-07-01 Decision Log line.

- 2026-06-30 (market-rate engine → ALL-IN, 7-night, multi-channel buy-in research): Operator wanted the
  market-rate update to web-research the REAL buy-in rate across VRBO/Booking.com/PM sites/Airbnb (as
  much data as possible), produce LOW/HIGH/HOLIDAY for the next 24 months INCLUDING all taxes + fees,
  use a 7-night sample, then double it for the 2-unit combo (sometimes 3BR + 2BR). SHIPPED
  (`claude/practical-shamir-39ae8c`, PR #TBD). DIAGNOSIS: the Claude prompt asked for a BARE nightly rate
  (no taxes/fees, no 7-night sample, one number/season); `BUY_IN_RATES` are rent-only — the Menehune
  loss class. The "double it" was ALREADY correct (push sums per-bedroom rows per unit; 3BR+2BR works).
  KEY SEAM (don't re-chase): all-in lives in the ANCHOR VALUES only — `buildBulkGuestySeasonalPlan`,
  `cleanBaseRateFromBuyInServer`, the `monthlyRates` shape, markup, scheduler + queue are ALL unchanged.
  Pieces: (1) `shared/static-rate-logic.ts` (pure, 89/0 incl. +46 new) — `allInNightlyFromComponents`
  (rent + cleaning + service + server tax, /7), `grossUpRentToAllIn`, `allInSeasonalBasis`,
  `reconcileChannelAllIn` (lowest credible; drop teasers; >15%-below-2nd guard; PM>VRBO>Booking>Airbnb
  tie-break — the tie-break only considers rows AT-OR-ABOVE the pick), `computeSeasonWindows` (7-night
  HIGH=Jul/LOW=Sep/HOLIDAY=Dec26), `clampedSeasonsAgainst`; `defaultStaticAnchors` now ALL-IN (fail-soft
  can't push rent-only loss numbers); clamp floor 0.4×→0.55× vs the ALL-IN basis. (2)
  `server/static-rate-engine.ts` — prompt rewrite (per-channel sweep, pinned 7-night windows, report
  OBSERVED rent/cleaning/service ONLY — server applies tax `LODGING_TAX_PCT` HI 0.18/FL 0.125);
  `resolveBedroomAnchors` computes per-channel all-in → reconciles → clamps vs all-in basis → persists
  `evidence`/`reconciliation`/`allInBasis`/`clampedSeasons`/`cleaningPerNight`; budget 6→12 searches /
  4000→12000 tokens (env-tunable); observed `cleaningPerStay:0` preserved (not overwritten with the
  estimate). (3) `server/claude-json.ts` — DISTINCT "truncated (max_tokens)" error so a truncated
  multi-bedroom response isn't mistaken for an outage. (4) `shared/schema.ts` mirrors the new optional
  `static_plan` JSONB fields (no migration). (5) `StaticRatePlanPanel` — per-channel all-in evidence
  table + reconciliation summary + comp-count/estimated-fees/clamped chips + a "ZERO the Guesty
  guest-facing cleaning fee" note (cleaning is amortized into the nightly; we deliberately did NOT add a
  cleaning-fee push path). Designed via a 4-lens design panel + reviewed via a 3-dimension adversarial
  diff workflow (0 merge blockers; 2 MEDIUMs fixed). Verified: `tests/static-rate-logic.test.ts` 89/0,
  full `npm test` exit 0, `npm run build` clean, `npm run check` 335 = baseline (0 new). Could NOT
  live-smoke the Claude web-search leg in-session (no ANTHROPIC_API_KEY) — confirm post-deploy via
  "Update Market Rates Now" or `POST /api/admin/refresh-all-market-rates`; the Pricing tab then shows the
  per-channel all-in breakdown. Full rationale: AGENTS.md "Static buy-in rates are ALL-IN, 7-night,
  multi-channel" + the 2026-06-30 Decision Log line.

- 2026-06-30 (guest receipts: ensure REFUNDS always reach the guest on their OTA channel): Follow-up
  to the same-day payment fix. SHIPPED (`claude/refund-receipt-always-ota`, PR #TBD). The refund
  auto-send + OTA routing ALREADY existed (the `server/guest-receipts.ts` scheduler detects refunds via
  `realRefundsForReceipts` and posts through `sendGuestyConversationMessage`, which routes to the guest's
  `integration.platform` channel — Airbnb→Airbnb, VRBO→VRBO, Booking.com→Booking.com). Two gaps closed
  for the "ALWAYS" guarantee: (1) `RECEIPT_SKIP_CHANNELS` muted both kinds — refunds now BYPASS the mute
  (`processTransaction` applies it only when `kind === "payment"`), since a channel mute is for redundant
  payment receipts, not refund confirmations. (2) Per AGENTS.md #51 the scheduler must NOT auto-retry a
  `misroute`/`unconfirmed` send (would re-post a duplicate — the cardinal sin), so a genuinely
  non-delivered refund could silently never reach the guest. Added a SAFETY NET: pure
  `receiptNeedsAttention()` (`shared/receipt-message.ts`) flags refund rows that are `misroute` or a
  STALE `error`/`pending`; the dashboard revenue payload exposes `guestRefundReceiptIssues` and
  `home.tsx` renders a red alert + "Resend to guest" button (`kind:"refund"`-scoped force-send via
  `POST /api/inbox/guest-receipts/send-for-reservation`; the OTA path de-dupes so the channel is never
  double-posted). `unconfirmed` is deliberately NOT flagged (the message reached the OTA once already).
  Verified: `tests/receipt-message.test.ts` 46/0, full `npm test` exit 0, build clean, `npm run check`
  335 = baseline (0 new). Could NOT live-smoke (no Guesty creds) — confirm post-deploy by issuing a
  refund: the guest gets a refund receipt on their booking channel within ~5 min; any misroute surfaces
  in the dashboard alert with a working Resend.

- 2026-06-30 (guest receipts: auto-charged FINAL payment got NO receipt — same-day 50/50 dedup
  collapse): Operator reported that when Guesty auto-took the second 50% payment (booking made INSIDE
  the "balance due ~90 days before arrival" window, so the balance is charged the SAME day as the
  deposit), the guest got the deposit receipt but never a second "paid in full" receipt. SHIPPED
  (`claude/receipt-final-payment-dedup`, PR #TBD). ROOT CAUSE: both receipt dedup layers keyed on
  day+amount and IGNORED transaction identity — `dedupeTransactions` (`server/guesty-money.ts`,
  `day|amount|desc`) and `receiptDedupKey` (`shared/receipt-message.ts`,
  `reservationId|kind|day|amount`). Two equal $1,855 charges on the same day collapsed to ONE receipt.
  This was the DOCUMENTED-but-wrong 2026-06-10 trade-off ("two same-day same-amount charges collapse;
  do NOT add a txn id") — overridden here (AGENTS.md Load-Bearing #2 replaced + 2026-06-30 Decision
  Log). FIX: distinguish charges by Guesty's stable txn `_id` (new `transactionId()`; appended to the
  ledger key `|<id>`; `dedupeTransactions` splits by id). `_id` is immutable across polls so it does
  NOT reintroduce the jitter double-send the old comment feared; id-less shapes reproduce the EXACT
  legacy key (backward compatible). A self-expiring migration shim (`sameTransactionMoment` in
  `processTransaction`) checks the legacy key too and skips ONLY when it was for THIS exact charge
  moment — so the deploy doesn't re-send recent receipts while the balance still sends. FOR FAITH ITO
  SPECIFICALLY: both her charges are now >48h old (outside the backfill window), so use the manual
  `POST /api/inbox/guest-receipts/send-for-reservation` (reservationId or confirmationCode) — the
  detection path now returns BOTH payments and the shim sends only the missing balance. Verified:
  `tests/guesty-money-payments.test.ts` 13/0 (new), `tests/receipt-message.test.ts` 37/0, full
  `npm test` exit 0, `npm run build` clean, `npm run check` 335 = baseline (0 new). Could NOT
  live-smoke the Guesty leg (no creds in session) — confirm post-deploy on the next within-window
  booking.

- 2026-06-30 (FOLLOW-UP: community double-check on the static-rate research target): Operator wanted
  glanceable proof that the community Claude web-researches is the CORRECT community for the listing —
  matching BOTH the community NAME and its LOCATION (city/state). SHIPPED
  (`claude/static-rate-community-confirm`, PR #TBD). Pure `confirmResearchCommunity` in
  `shared/static-rate-logic.ts` (43/0 incl. 9 new): normalizes the research `searchLabel` and checks
  nameMatch (community token in label) + cityMatch + stateMatch (state full-name↔abbrev aliased, so
  "Hawaii"↔"HI"); `confirmed = locationMatch && (nameMatch || curated)` — LOCATION is the load-bearing
  geo guard (catches the Baton-Rouge-LA-vs-Kauai-HI class). `resolveStaticPricingTarget` now returns
  `expectedCity/expectedState/curated` (curated market `location` for configured props + curated drafts;
  draft's own city/state otherwise), the engine computes the `CommunityConfirmation` once and persists
  it on `staticPlan.communityConfirmation` + emits it on the queue `pricingRecipe`. UI: green
  "✓ Community confirmed — <community> · <city, state> · Researching: <label>" banner (amber
  "⚠ Confirm community" + Name/Location ✓/✕ sub-checks) on the Pricing-tab `StaticRatePlanPanel`, and a
  matching ✓/⚠ confirmation chip on each market-rate queue item in `home.tsx`. Verified: full `npm test`
  exit 0, `npm run build` clean, `npm run check` 335 = baseline (0 new).

- 2026-06-29 (REPLACED live Airbnb P40 sampler with Claude WEB-RESEARCHED static seasonal rates):
  Operator directive — stop the random-7-night SearchAPI Airbnb P40 sampler; instead have Claude
  ACTUALLY WEB-SEARCH (Google/OTAs) each resort's real nightly rates and produce ONE static buy-in
  rate per LOW/HIGH/HOLIDAY per YEAR for the rolling next 24 months, still markup + push to Guesty.
  SHIPPED (`claude/static-pricing-rates-ckgp32`, PR #TBD). KEY SEAM (don't re-chase): the new engine
  writes into the SAME `property_market_rates.monthlyRates` JSONB shape the Guesty push already reads
  (`buildBulkGuestySeasonalPlan` → `pushBulkGuestyPricingAfterRefresh`), so markup
  (`targetMarginForProperty`), the bulk queue, the weekly `market-rate-scheduler`, and the push are
  ALL unchanged — only the rate SOURCE changed. Pieces: (1) `shared/static-rate-logic.ts` (pure,
  unit-tested 34/0): 6 anchors per bedroom (LOW/HIGH/HOLIDAY × year1/year2), sanity clamps vs the
  operator BUY_IN_RATES basis, lock-merge, and `expandAnchorsToMonthlyRates` (months 0-11=year1,
  12-23=year2; **December is priced from the HOLIDAY anchor** — INTENTIONAL behavioral change, the
  only whole-month HOLIDAY mapping since getSeasonForMonth never returns HOLIDAY). (2)
  `server/claude-json.ts` centralized Anthropic helper incl. `callClaudeWebSearchJson` (server-side
  `web_search_20250305` tool, handles `pause_turn`). (3) `server/static-rate-engine.ts`
  `generateStaticRatesForTarget` — gathers metrics (operator table + last live medians snapshot +
  trailing revenue as PRIORS only), then Claude **web-researches** the resort and returns anchors;
  fail-soft to the static basis with NO key/error. `applyStaticRateOverride` = edit/lock then
  re-expand. Persists `source:"claude-static"` + new nullable `static_plan` JSONB column
  (schema.ts + schema-maintenance ALTER). (4) Dispatch behind flag `STATIC_RATE_ENGINE_DISABLED=1`
  (default ON; legacy hybrid-pricing.ts kept dormant/intact for fallback): `refreshMarketRatesForProperty`
  in routes.ts routes the Pricing-tab refresh, bulk queue (`runBulkPricingItem`), and
  `/api/admin/refresh-all-market-rates`; the weekly scheduler inherits it via the loopback. New endpoints
  `GET /api/property/:id/static-rate` + `POST /api/property/:id/static-rate/override` (edit/lock, no
  auto-push). Search label = curated `BUY_IN_MARKETS[community].searchLocation` (or draft name+city+state).
  (5) UI: new `StaticRatePlanPanel` on the Pricing tab (editable/lockable anchor grid + Claude
  reasoning/confidence/model/sources) replacing the SearchAPI "research confirmation" as the rate
  display; dashboard bulk-queue copy + `formatPricingRecipe` relabeled to "Claude web research". Verified:
  `tests/static-rate-logic.test.ts` 34/0, full `npm test` exit 0, `npm run build` clean, `npm run check`
  335 = baseline (0 new). Could NOT live-smoke the Claude web-search leg in-session (no ANTHROPIC_API_KEY) —
  confirm post-deploy via the per-property "Update Market Rates Now" button or
  `POST /api/admin/refresh-all-market-rates`, then the Pricing tab shows researched anchors and the
  queue shows "Claude web research".

- 2026-06-29 (FOLLOW-UP: dashboard "Run photo match scan" button → DEEP + progress modal): Operator
  asked whether the dashboard refresh button (next to the Photos column) does a deep scan, and to add a
  search bar / progress modal. It did NOT — `POST /api/photo-listing-check/run` ran the cheap 3-photo
  screen (no `maxPhotos`). Made it DEEP (`maxPhotos: PHOTO_AUDIT_MAX_PHOTOS` + `budgetCap` when finite),
  so a manual scan matches the weekly cron's thoroughness + runs the address leg. Added a progress modal
  in `client/src/pages/home.tsx` (`photoScanModalOpen`): opens on click, polls `GET /api/photo-listing-check`
  every 4s, marks each folder done when its `checkedAt` passes the scan start, folder search box, per-folder
  photo + 📍address status dots, % bar. Progress is derived client-side (no server job state) — reliable
  because scans run sequentially and upsert `checkedAt` per folder. Same PR/branch. Verified: full
  `npm test` exit 0, build clean, `npm run check` 335 = baseline (0 new).

- 2026-06-29 (photo/unit audit → 95-100% OTA detection + address leg): Operator wanted the recurring
  photo scan/unit audit to be 95-100% sure whether unit A/B's photos (besides community) are listed on
  Airbnb/Booking/VRBO, AND to detect the address being listed; noted there's already a dashboard cron.
  SHIPPED (`claude/photo-scan-ota-detection-gs6o30`, PR #TBD). KEY FINDING (don't re-chase): the cron
  ALREADY exists and is solid — `server/photo-listing-scanner.ts` `startPhotoListingScheduler` (hourly
  tick, re-scans folders stale >`PHOTO_LISTING_SCAN_INTERVAL_DAYS`=7 → WEEKLY) → Google-Lens
  reverse-image over Airbnb/VRBO/Booking with strong-match ≥0.8, ≥2-distinct-photo `MIN_MATCHES`,
  unit-number URL cross-validation (`verifyUrlMentionsUnit`), authorized-URL suppression, and
  all-Lens-fail→`unknown` (never silently clean). TWO gaps fixed: (1) the BACKGROUND cron only scanned
  `PHOTOS_PER_FOLDER`=3 hero shots (only the on-demand deep button scanned the whole gallery) → a repost
  copying the 4th+ photo could slip the weekly scan. Now the cron passes the new
  `PHOTO_LISTING_SCAN_MAX_PHOTOS` (default = `PHOTO_AUDIT_MAX_PHOTOS`=30 → full deduped interior gallery;
  set to 3 to restore the cheap screen). Daily Lens cap is already unlimited (2026-06-17), so credits are
  the only cost — operator chose certainty over cost. (2) NO address-on-OTA detection in the cron. Added
  a per-unit `site:host "street" "city"` leg: pure `shared/address-listing-logic.ts`
  (`ADDRESS_PLATFORMS`/`streetPortionOf`/`buildAddressQuery`/`filterAddressSerpRows`, 12 unit tests) +
  `checkAddressOnOtas`/`folderAddressContext`/`callGoogleTextSearch` in the scanner. Keeps only real
  listing-page URLs that surface the street, suppresses our own authorized URLs, and (unless standalone
  unique-address) requires the page to ALSO mention the unit number so a shared-resort street can't flag
  every owner. SEPARATE from the photo verdict (photos stay the precise 95-100% signal). Persisted in 4
  additive `photo_listing_checks` columns (`airbnb/vrbo/booking_address_status` + `address_matches`,
  ALTER-on-boot in `server/schema-maintenance.ts`), returned by `GET /api/photo-listing-check`, surfaced
  on the dashboard Photos column as a 📍 A/V/B mini-row + "Addr on …" line (`client/src/pages/home.tsx`),
  outage-preserved like the photo statuses. Toggle `PHOTO_LISTING_ADDRESS_SCAN_DISABLED=1`. No address
  alert rows (the alert enrichment maps platform→photo-sync remediation; address is column-only). Full
  rationale in AGENTS.md "Photo/address OTA detection audit" Load-Bearing subsection + the 2026-06-29
  Decision Log line. Verified: `tests/address-listing-logic.test.ts` 12/0, full `npm test` exit 0,
  `npm run build` clean, `npm run check` 335 = baseline (0 new). Could NOT live-smoke the SearchAPI legs
  (no key in session) — confirm post-deploy via the dashboard "Run photo match scan" button + the weekly
  auto-run.

- 2026-06-27 (dashboard "Last Price Scan" column + WEEKLY market-rate cron): Operator asked for
  a per-listing column showing the last time the market-rate update ran for that listing's pricing
  table AND was pushed to Guesty, ~5 days of retroactive seed data, and a once-a-week auto-scan.
  SHIPPED (`claude/stoic-pascal-a091fc`, PR #TBD). KEY FINDING (don't re-chase): the "pushed to
  Guesty" timestamp ALREADY exists — `scanner_schedule.lastGuestyRatePushAt`, stamped by
  `storage.markScannerGuestyRatePush`, which ONLY fires on the per-property push path
  `POST /api/property/:id/refresh-market-rates` → `refreshPricingTabMarketRates` →
  `pushBulkGuestyPricingAfterRefresh`. The account-wide `POST /api/admin/refresh-all-market-rates`
  (`runHybridPricingForAllProperties`) only recomputes `property_market_rates` and does NOT push to
  Guesty, so the cron drives the per-property endpoint instead (runs refresh+push synchronously
  inline; the `?run=1`/background code after its first `return` is dead). Pieces: (1) column in
  `client/src/pages/home.tsx` (sortable, keyed by `property.id`, "—" when never pushed, amber when
  stale >8d, red on last-push error, italic "·seed" for the backfill) reading
  `GET /api/dashboard/price-scans`. (2) weekly scheduler `server/market-rate-scheduler.ts` (clone of
  `property-revenue-scheduler.ts`) — boot seed + weekly `setInterval`, single-flight, fail-soft, gate
  `MARKET_RATE_SCAN_DISABLED=1`, registered in `server/index.ts`; pure date math split into the
  zero-dep leaf `server/market-rate-scan-logic.ts` (`retroactivePriceScanSeeds`/`nextRunDelayMs`,
  unit-tested). (3) DEPLOY SAFETY: the scan WRITES live Guesty prices, so it must NOT fire every
  Railway redeploy — last-run persisted in `app_settings` (`market_rate_scan.last_run_at`), stamped at
  the START of the sweep, first run scheduled at `lastRun + 7d`; the first-boot seed anchors
  `last_run_at` to ~now−1day so a fresh deploy's first auto-push lands ~1 week later, never at boot.
  (4) RETROACTIVE SEED: `storage.seedScannerPriceScan` backfills the ~11 `PROPERTY_UNIT_CONFIGS` ids
  across the past 5 days, ONLY where there's no real push yet (non-clobbering), status sentinel
  `"seed"` (NOT `"ok"`) so an audit never mistakes it for a real push. Endpoints:
  `GET /api/dashboard/price-scans`, `POST /api/admin/refresh-price-scans` (manual/smoke),
  `GET /api/admin/price-scan-status`. Verified: `tests/market-rate-scan.test.ts` 15/0, full `npm test`
  exit 0, build clean, `npm run check` 335 = baseline (0 new). Could NOT live-smoke the Guesty push
  (no creds) — confirm post-deploy via `POST /api/admin/refresh-price-scans`; the column then shows
  real "ok" pushes, and the weekly auto-run replaces the seeds ~1 week after deploy.

- 2026-06-26 (Total Revenue column FOLLOW-UP: attribution → BOOKING DATE): Post-deploy smoke
  of PR #847 showed the portfolio is heavily forward-booked (prod: 34/35 committed reservations
  have FUTURE check-ins), so the original CHECK-IN-date window populated only 2 properties and
  left the rest "—". Operator chose "count every booking MADE in the last 365 days, regardless
  of stay date." Shipped `claude/revenue-by-booking-date` (PR #TBD): aggregate by `createdAt`
  (`bookingDayOf` in `server/property-revenue-aggregate.ts`); scheduler pulls via new additive
  `createdFrom`/`createdTo` filter on `guesty-all` (mirrors the 30-day handler's createdAt
  filter). `checkInFrom`/`checkInTo` stay on guesty-all (unused now, harmless). Column copy →
  "bookings made in the last 365 days · by booking date, incl. upcoming stays". Verified:
  aggregate test 16/0, full `npm test` exit 0, build clean, check 335 = baseline.

- 2026-06-26 (dashboard "Total Revenue" column + daily revenue cron): Operator asked for a
  per-property TOTAL REVENUE over the trailing 365 days on the dashboard table, auto-updated
  daily. SHIPPED (`claude/dashboard-total-revenue`, PR #TBD). Pieces: (1) new `property_trailing_revenue`
  cache table (`shared/schema.ts` + `server/schema-maintenance.ts` CREATE TABLE IF NOT EXISTS +
  `storage.getPropertyTrailingRevenue`/`replacePropertyTrailingRevenue` — atomic wholesale replace
  so aged-out properties drop rather than show stale). (2) `server/property-revenue-scheduler.ts`
  (clone of `booking-confirmations.ts`): boot run + `setInterval` 24h = the "cron", single-flight,
  fail-soft, `PROPERTY_REVENUE_DISABLED=1` to disable. It LOOPBACK self-calls the existing
  `GET /api/bookings/guesty-all` (account-wide, committed-only, manual rows merged) with a NEW
  additive `checkInFrom`/`checkInTo` filter (so the recent year isn't truncated at `maxRows`), then
  sums the canonical `reservationRevenue()` per `operationsPropertyId`. Pure aggregator split into
  `server/property-revenue-aggregate.ts` (no DB import → unit-testable; re-filters merged manual rows
  by check-in). (3) endpoints `GET /api/dashboard/property-revenue` (fail-soft empty until table/first
  run) + `POST /api/admin/refresh-property-revenue` (manual/smoke) + `GET /api/admin/property-revenue-status`.
  (4) dashboard column (`client/src/pages/home.tsx`): sortable "Total Revenue", keyed by `property.id`,
  `formatCurrency`, "—" when no connected listing / no in-window stays (absence ≠ $0), tooltip shows
  stay count + last-updated. LOAD-BEARING: keying = `operationsPropertyId` matches `property.id` only
  for `guesty_property_map`-mapped listings (positive core ids + negative `-draftId`); attribution is by
  stay CHECK-IN date in the trailing 365 days. Verified: `tests/property-revenue-aggregate.test.ts` 12/0,
  full `npm test` exit 0, `npm run build` clean, `npm run check` 335 = baseline (0 new). Could NOT
  live-smoke the Guesty leg in-session (needs the running server + token) — confirm post-deploy via the
  admin refresh endpoint, then the column populates (scheduler also auto-runs ~90s after boot).

- 2026-06-22 (market-rate "is it the right resort + bedroom?" confirmation UI, Phase 1):
  Operator wanted glanceable proof that the bulk market-rate queue AND the Pricing-tab
  "Update Market Rates" use the CORRECT resort/community and the CORRECT bedroom size
  (his fear: looking up a 3BR for a 6BR listing and ×2-ing it). Investigated via a
  6-agent map workflow. KEY FINDINGS (don't re-chase): (a) the persisting path
  (`POST /api/property/:id/refresh-market-rates` → `refreshPricingTabMarketRates` →
  `refreshHybridPricingForTarget`) does NOT scale — it scans ONE exact-BR Airbnb P40 comp
  per DISTINCT bedroom size and stores one `property_market_rates` row per size; the combo
  "×N" is a read-time SUM of per-unit bases in `buildBulkGuestySeasonalPlan`
  (`routes.ts:888`), so a 6BR=3BR+3BR is two real 3BR comps summed, NOT a single comp
  doubled. The only literal `×2`/`×unitCount` is `applyAirbnbBiasAndCombo`
  (`shared/pricing-rates.ts:592`), reachable ONLY from the SECONDARY non-persisting path A
  (`POST /api/builder/refresh-market-rates`, wired to the legacy `refreshMarketRates`, NOT
  the visible button). (b) The provenance facts are ALREADY computed: resort `searchName`,
  `searchedBedrooms`, `unitCount` live on `pricingRecipe`, and the bulk-log already plumbs
  it to the client in `item.progress.pricingRecipe` + `confidence` (incl. `sampleCount`) —
  it was just collapsed into one truncated grey pill via `formatPricingRecipe`. So Phase 1
  is DISPLAY-ONLY, ~no server change. SHIPPED (branch `claude/elated-stonebraker-aee5cb`,
  PR #TBD): (1) bulk log (`home.tsx`) — replaced the recipe pill with discrete
  "🔎 Researched <resort>" + "🛏️ <NBR ×N · summed>" pills + a now-visible "<N> comps"
  pill (sampleCount was typed but never rendered); combo tooltip spells out "real comp of
  each unit's own size, summed — never a smaller comp scaled up". (2) Pricing tab
  (`GuestyListingBuilder/index.tsx`) — new `researchProvenance` memo + a "Research
  confirmation" block above the per-bedroom badges (resort, composition "6BR listing =
  3BR + 3BR", scaling note, and an amber "⚠ not curated" chip when the community isn't a
  curated `BUY_IN_MARKETS` key). (3) new shared `curatedResortSearchName` /
  `isCuratedBuyInMarket` (`shared/buy-in-market.ts`) mirror the server's
  `curatedAirbnbSearchQueries[0]` priority — MUST stay in sync if that priority changes
  (NOTE FOR CODEX inline). Trust signal is BADGE-ONLY (never blocks a push) per operator.
  Caveat: the Pricing-tab resort label is client-derived and does NOT reflect a server-side
  widened-fallback city anchor (only fires when the resort box returns 0 comps) — that, plus
  per-bedroom geo radius + a real default-resort-fallback / inferred-bedroom-split warning,
  is Phase 2/3 (deferred). Verified: `tests/research-confirmation.test.ts` green, full
  `npm test` green, build clean, `npm run check` 330 = baseline (0 new). Could NOT
  live-smoke the rendered UI (no portal creds in session) — confirm on the live bundle.

- 2026-06-19 (Check photo community, Poipu Kai 6BR: use the Google Lens AI Overview to
  confirm community photos): the tennis-court photo stayed "unconfirmed" even though a
  manual Google reverse-image AI Overview says "These are the tennis courts at the Poipu
  Kai Resort." Root cause: the Lens call already captured the AI Overview (`extraTexts`)
  but `judgeCommunityPhotoFromLensCore` scanned per-row conflicts first and short-circuited
  to "no" on the sibling "Poipu Sands" organic title before the overview's positive ID was
  used (then PR #771's same-area deferral → inconclusive → vision neutral → unconfirmed).
  FIX (`claude/lens-ai-overview`, PR #TBD): new `analyzeAiOverviewForCommunity` consulted
  at the TOP of the judge — overview names/supports expected → confirmed (green ✓) even
  over a sibling organic hit; overview names a different-AREA resort → hard no; same-area
  sibling → fall through to vision. `sharedResortPhraseKeys` takes a `{title,…}` object,
  not a string (legacy string calls silently return nothing). Verified: lens-logic 16/0
  (+5), full `npm test` green, build clean, `npm run check` 308 = baseline (0 new).
  Couldn't live-smoke (no SEARCHAPI key) — confirm by re-running the check; tennis court
  should flip to green. Full rationale: AGENTS.md #45 + the 2026-06-19 Decision Log line.

- 2026-06-19 (Check photo community, Poipu Kai 5BR = Regency at Poipu Kai: false
  community-amenity mismatches + same-room photos not clustering): FOUR fixes on
  `claude/photo-community-cluster-lens` (PR #TBD). (1) Shared/sibling Poipu resorts
  reuse pool/tennis/grounds photos → Google Lens cross-matched REAL community photos to
  "poipu sands"/"poipu kapili" and hard-flagged them red. `classifyCommunityPhotoFromLens`
  (`shared/community-photo-lens-logic.ts`) now downgrades a `contradicted` verdict to
  `inconclusive` (defer to vision) when the identified resort shares a geo-area token
  with the expected community/city (`communitySharesGeoArea`); different-area conflicts
  (Princeville/Hanalei) still hard-fail. Also derives `identifiedCommunity` from the
  conflict reason's `(key)` (full dict) so the same-area check actually fires. (2)
  `detectBedTypeFromCaption` maps plural "twin beds"→"Two Twin Beds" (was singular →
  "missing Two Twin Beds"). (3) `mergeBedroomClustersByCaption` (`shared/`, called in
  `bedroom-coverage-engine.ts` before the cap) folds hash-split same-room shots (two
  "Master" angles; "Twin Beds"+"Two Beds") back together, bounded by the expected
  bedroom count. (4) Client `communityPhotoVerdicts` badges a unit's bedroom tiles amber
  "?" when `bedInventoryMatch==="no"`. Full rationale in AGENTS.md #45 + the 2026-06-19
  Decision Log line. Verified: bedroom-v2 25/0, lens-logic 11/0, full `npm test` green,
  `npm run build` clean, `npm run check` 0 new TS errors (baseline 308). Couldn't
  live-smoke Lens/vision (no SEARCHAPI/ANTHROPIC key) — limitation noted: this removes
  false REDS on shared amenities; a false GREEN on a genuinely-wrong shared pool isn't
  fully solvable via reverse-image (vision is the backstop).

- 2026-06-19 (Check photo community: false "missing Queen Bed" + badge all interior
  photos): Bonita National 2BR showed a "Queen Bedroom" photo but the check reported
  "Bed inventory mismatch: missing Queen Bed", and only the first ~12 interior photos
  got a green ✓. TWO fixes on `claude/cranky-swartz-6cd6ae` (PR #TBD): (1)
  `capBedroomClustersToExpected` (`shared/photo-bedroom-coverage-logic.ts`) is now
  bed-type-diversity + `expectedBedInventory` aware — when there are more bedroom
  clusters than listing bedrooms it keeps DISTINCT bed types (covering the listing's
  inventory first) instead of the old size+master-King ranking that kept two Kings and
  dropped the unique Queen; a trim that still matches inventory is a clean duplicate
  merge (unit tier stays `pass`, no warn), so the review clears. (2)
  `verifyUnitAgainstCommunity` (`server/photo-community-check.ts`) now samples the
  whole unit folder (`UNIT_PHOTO_CAP=60`) and batches the vision call
  (`UNIT_VISION_BATCH_SIZE=9`, concurrency 3, anchors per batch) so EVERY tile gets a
  ✓/✕; a failed/empty batch yields `uncertain` (amber ?), never a default green. Full
  rationale in AGENTS.md Load-Bearing #45 + the 2026-06-19 Decision Log line. Verified:
  `npm test` green (+5 new bedroom tests), `npm run build` clean, `npm run check` net
  −1 error. Couldn't live-smoke the vision leg (no ANTHROPIC_API_KEY in session).

- 2026-06-18 (bulk combo listings: "always find and apply an address" — reverse-geocode
  rescue): Operator reported bulk add-combo-listing jobs frequently FAIL the address
  pre-check ("No usable street address"). Diagnosed as a recall gap in the
  2026-06-17 `discoverCommunityStreetAddress` (SearchAPI google_maps): it only
  accepted a candidate whose map `address` already had a numbered street, but
  google_maps usually returns a resort's correct `gps_coordinates` + name-matched
  title with the `address` as just the locality ("Princeville, HI") → direct street
  path found nothing → fail. FIX (surgical, additive, on branch
  `claude/combo-listings-address-resolution-vivwg9`): a precision-safe reverse-geocode
  RESCUE. New pure `selectCoordinateFallbackCandidate` (in
  `server/community-address-discovery.ts`) surfaces the first title-matched (SAME
  whole-word gate that keeps Alii Kai ≠ Halii Kai) streetless place that exposes
  coordinates; when no direct street hit is found across all queries,
  `reverseGeocodeToStreetAddress` (NEW in `server/walking-distance.ts`, Nominatim
  reverse, free/no-key, shares the existing 1-req/sec throttle) snaps those
  coordinates to a real numbered street. A real direct street always wins; the title
  gate having already confirmed the resort makes the coordinates trustworthy, so the
  rescue can't apply a wrong-resort street. Discovery still runs ONLY for non-curated
  resorts so a curated rule is never overridden. Verified:
  `tests/community-address-discovery.test.ts` 21/0 (+4 new), full `npm test` green,
  `npm run build` clean, `npm run check` 0 new TS errors. Could NOT live-smoke (no
  SEARCHAPI key in the cloud session) — confirm on the next bulk sweep.

- 2026-06-17 (guest inbox: "Do buy-in search" button — live read-only buy-in
  search on an inquiry): Operator asked to run the EXACT Operations "Auto-fill
  cheapest" search from inside a guest inquiry (sidecar + cheapest combos) and just
  SEE the results — no attach. Shipped on `claude/inbox-buy-in-search` as an
  additive, default-false `dryRun` mode on the existing auto-fill job
  (`server/auto-fill-job.ts`) — NOT a re-implementation, so it inherits every
  load-bearing rule. The whole trick: `attachPick` is the only attach boundary and
  every detach/rollback site is already guarded by `buyInId != null`, so a dry-run
  that records the would-be pick with `buyInId:null` + skips the two create/attach
  POSTs leaves all downstream control flow byte-identical with zero other server
  changes. Reservation-keyed persistence (started/loss-options/SIGTERM stamp) is
  skipped for dry-run (synthetic `inbox-search:` reservationId); profit gate
  disabled (inquiry has no committed revenue). New `POST /api/inbox/buy-in-search`
  resolves the inquiry (guestyPropertyMap → PROPERTY_UNIT_CONFIGS) + starts the job;
  the inbox polls the normal `GET /api/operations/auto-fill/:jobId` and renders
  `attached`/`comboOptions`/`cityEconomics` read-only (`InboxBuyInSearchResults`).
  Full rationale in AGENTS.md "Read-only inbox buy-in search (dry-run auto-fill)" +
  the 2026-06-17 Decision Log line. Verified: `tests/inbox-buy-in-search.test.ts`
  (20) green, full `npm test` green, `npm run build` clean, `npm run check` 0 new TS
  errors. Could NOT live-smoke (no Guesty/sidecar creds in the cloud session) —
  build + test + code-path verified; confirm live by opening an inquiry and clicking
  the button.

- 2026-06-15 ("sidecar randomly going off" = unattended inventory-feed sweep; OFF-REPO root cause):
  Operator reported the local Chrome sidecar firing unprompted. Diagnosed from the
  live worker log (`~/.vrbo-sidecar-daemon/sidecar-launchd.log`): an UNATTENDED
  inventory-feed sweep — every Kauai city (Koloa/Princeville/Poipu Beach/Wailua…) ×
  consecutive weekly windows × full-city `cityWideInventory` export, each city firing
  BOTH a `vrbo_search` and a `hometogo_search` — was being enqueued onto the PROD
  sidecar queue at ALL HOURS (bursts across Jun 11–15 incl. overnight), so the 8 local
  Chrome workers (which poll `admin.vacationrentalexpertz.com`) drove themselves for
  hours. NOT the already-gated Monday-3am `WEEKLY_AVAILABILITY_SCAN` sweep — a
  separate feed. **The feed scheduler is OFF-REPO:** it's in NO branch, NO worktree,
  NO local cron / Claude scheduled-task / `/loop`, and NOT on disk — only the deployed
  Railway artifact (prod runs code ahead of git, likely `railway up`'d from an
  uncommitted tree). **Why there is NO clean in-repo fix (the trap — don't gate it):**
  HomeToGo is NOT feed-only. As of a concurrent main merge it's a legit 2nd inventory
  source called from the shared city-scan core (`server/city-vrbo-inventory.ts`
  `runCityScanCore` → `searchHometogoViaSidecar`), so EVERY real operator scan
  (auto-fill / find-buy-in / bulk queue / expansion) now emits the SAME
  `vrbo_search` + `hometogo_search` cityWide pair. Feed and operator jobs are
  byte-identical at every layer this repo controls; a `hometogo_search` (or
  cityWide-1BR) kill-switch would degrade the operator's OWN buy-in coverage and still
  not stop the VRBO half. (An earlier cut of this PR added that guard — removed.)
  Immediate relief (DONE, holding): `POST /api/vrbo-sidecar/stop` (X-Admin-Secret)
  paused the live queue — cancels active + blocks new, both halves stop, worker idles
  (heartbeat stays green). `POST /api/vrbo-sidecar/start` re-enables your own scans.
  DURABLE FIX (off-repo, operator): disable the prod feed scheduler at its source, OR
  redeploy prod cleanly from git — current `main` has NO feed scheduler, so a
  git-based deploy drops it while keeping HomeToGo as a legit source — then un-pause.
  Until then the sweep resumes the moment the queue is un-paused. Full rationale in
  AGENTS.md Decision Log 2026-06-15. PR #674 is docs-only.

- 2026-06-10 (guest payment/refund RECEIPTS — auto-message + durable page):
  Operator asked: when he sends a refund (or takes a payment) via Guesty, auto-send
  the guest a message that's a receipt of it, store it in the guest inbox, "try
  another way too," and find a good place in the UI to see it was sent. SHIPPED on
  branch `claude/guest-receipt-messages` (built in an isolated worktree off `main`
  because the shared `claude/city-research-dedup-and-radius` branch had concurrent
  uncommitted edits to the same files). Discovery: a MANUAL "Send payment receipt"
  dialog already existed in `client/src/pages/inbox.tsx` (`buildReceiptBody` →
  Guesty `/send-message`); this AUTOMATES it and adds refunds. Pieces: (1) new
  scheduler `server/guest-receipts.ts` (clone of `booking-confirmations.ts`, every
  5 min) polls reservations by `-lastUpdatedAt`, detects collected payments + real
  refunds via the new canonical `server/guesty-money.ts` (verbatim MIRROR of the
  `dashboardRevenue30DayHandler` money helpers), and for each txn in a tight
  `RECEIPT_BACKFILL_HOURS`=48 window posts a receipt into the Guesty conversation
  (→ guest's channel + our inbox) and mints a durable `/receipt/:token` page (the
  "second way"; clone of `/alternatives/:token`). (2) dedup ledger `guest_receipts`
  (UNIQUE `dedup_key` = `reservationId|kind|day|amount`; day+amount is jitter-stable
  → never double-send). (3) rollout AUTO-ON with OFF toggle
  (`/api/inbox/guest-receipts/toggle`, env `GUEST_RECEIPTS_DISABLED`). (4) operator
  UI: primary = "Guest receipts sent" tile + feed in the Operations revenue dialog
  (`home.tsx`, from our own ledger); secondary = sky "Receipt sent" row badge on
  `bookings.tsx` (`POST /api/operations/guest-receipts/sent-status`) + "📄 Receipt"
  chip in the inbox thread. (5) `server/auth.ts` PUBLIC_PATH_PREFIXES widened with
  `/receipt/` (guest page only — see the matching Decision Log + Load-Bearing entry
  per the auth note's rule). Wording is channel-NEUTRAL ("a payment was processed" /
  "a refund was issued") because it fires for Airbnb/VRBO too where we don't hold the
  card. Built + reviewed via a 4-dimension adversarial Workflow (6 findings fixed:
  forward-only channel-skip, retry rebuilds body from current data, `sentAt`→ISO,
  dedup trade-off documented). Verified: `tests/receipt-message.test.ts` 28/0, full
  `npm test` green, `npm run build` clean, `npm run check` zero new TS errors
  (baseline 285). Full rationale in AGENTS.md "Guest payment/refund receipts
  auto-send" Load-Bearing subsection + the 2026-06-10 Decision Log line. NOTE: tables
  auto-create on deploy via `db:push` AND `server/schema-maintenance.ts`
  (`guest_receipts` CREATE TABLE IF NOT EXISTS); the feed/logs/sent-status endpoints
  fail-soft (return empty) until then.

- 2026-06-10 (city research: surface MULTIPLE distinct combos per pool — "find more
  than the duplicate combo"): Operator saw a bulk buy-in queue scan where the nearby-
  city expansion surfaced the SAME two listings across 4 different cities for a ~6BR
  Poipu Kai combo, and asked whether VRBO clusters one listing under multiple cities
  or it was a glitch — and if clustering, to expand the search to find more than the
  duplicate. DIAGNOSIS (from the LIVE sidecar daemon log `~/.vrbo-sidecar-daemon/
  sidecar-launchd.log`, NOT a guess): it's genuine VRBO behavior, NOT a code/worker
  glitch. A 2026-06-25→07-03 run had Koloa / Lawai / Eleele each return the IDENTICAL
  187-candidate pool (same `harvestTotal=191`, same `graphqlResponses=2/348`); each town
  navigated to a DISTINCT destination/regionId (so no stale-pool reuse), and VRBO's
  dropdown even drifted "Lawai" → "Lawai Beach, Koloa". VRBO's region boundaries for
  adjacent small Kauai towns overlap, so they return the same broad south-shore pool;
  it's INTERMITTENT (a 2026-12-27 run did NOT collapse: Kalaheo 255 / Eleele 191 /
  Hanapepe 266). The branch already had the collapse-guard (drop duplicate towns,
  8063ab4); this is its complement. KEY INSIGHT: that broad pool holds MANY distinct
  same-community clusters (confirmed Pili Mai / Poipu Sands / Poipu Kai / Makahuena /
  Kuhio Shores in one dump), but `suggestCityVrboComboPair` returned only the SINGLE
  cheapest and discarded the rest. FIX (server-side, Railway-deployable, additive):
  (1) NEW `suggestCityVrboComboPairs(listings, plan, nights, limit)` in
  `shared/city-vrbo-combo.ts` — greedy peel reusing the unchanged singular 100% so
  `result[0]` is byte-identical to `suggestCityVrboComboPair` (LOAD-BEARING: the
  attach + profit-gate decisions key off the single cheapest and must NOT change;
  locked by tests/city-vrbo-combo.test.ts), URL-disjoint combos with a cluster-
  diversity preference (a Kiahuna pair before a 2nd Poipu Kai pair).
  (2) `server/city-vrbo-inventory.ts` threads `suggestedPairs` onto `CityVrboScanResult`
  (computed once in `applyFiltersToPool`; `suggestedPair` is now `suggestedPairs[0]`).
  (3) `server/city-vrbo-expansion.ts` stamps `altPairs = scan.suggestedPairs.slice(1)`
  on the accepted "pair" + "unprofitable" rows.
  (4) `server/auto-fill-job.ts` `pushAlternativeComboOption` (isLoss:false,
  **isAlternative:true**) + `surfaceAlternativeCombos` (re-checks each alt against the
  profit gate → non-loss alternative vs over-budget loss card); home-city stage
  surfaces `payload.suggestedPairs.slice(1)` (covers the all-collapse-to-home case),
  the expansion terminal fold surfaces `c.altPairs`. `__lossKey` dedupe widened to be
  loss-agnostic so no pair appears as both a loss card and an alternative, and the
  same alt from a home + collapsed-nearby pool isn't shown twice. Live poll copy strips
  `altPairs` (lean ticks).
  (5) `server/bulk-auto-fill-job.ts` `item.altCombos = comboOptions.filter(!isLoss &&
  isAlternative)`.
  (6) `client/src/pages/bookings.tsx`: new `AlternateCombosPanel`; alternatives render
  in the manual `CityVrboInventoryPanel` (from `data.suggestedPairs.slice(1)`), the
  per-row auto-fill result, and the bulk dialog. LOAD-BEARING: alternatives are tagged
  `isAlternative` and kept OUT of `comboOptions` (so `ComboComparisonPanel` + the
  cancellation-advice math, which verify against the CONFIGURED resort, are unchanged —
  a cross-complex alt would be wrongly rejected there). Alternatives are OPERATOR-CLICK-
  ONLY (the CityVrboInventoryPanel auto-attach effect stays scoped to the single
  cheapest `comboOption`); attaching one goes through `attachComboMutation` which
  DETACHES every slot then re-attaches, so it REPLACES the current pick (no double-book).
  Tunable: `CITY_VRBO_TOP_COMBOS` (default 5). FUTURE LEVER (not built): for genuinely
  different sub-area inventory, the worker's existing map-bounds mode
  (`runVrboMapBoundsSearchVariant`) could search a tight box around a far town — heavier,
  needs worker+server wiring + VRBO sight+click compliance. Verified: combo suite 63/0
  (incl. 14 new plural tests + the element-0 equivalence lock), `npm test` fully green,
  `npm run build` clean (client+server), `npm run check` adds ZERO new TS errors
  (baseline-diffed across all 7 touched files). NOTE: this branch
  (`claude/city-research-dedup-and-radius`) is SHARED/unpushed with concurrent sessions
  (single-unit nearby walk + daemon external-monitor work) — committed only these 7
  files; did not merge.

- 2026-06-10 (bulk buy-in queue: make FAILED-scan logs diagnosable + green the test suite):
  Operator asked to review the most-recent buy-in queue's FAILED scans and confirm
  nothing went wrong in scraping / sorting / combo-finding. Audited the whole failure
  pipeline (`server/bulk-auto-fill-job.ts` → `server/auto-fill-job.ts` →
  `server/city-vrbo-inventory.ts` → `shared/city-vrbo-combo.ts` →
  `server/city-vrbo-expansion.ts`): the scrape→normalize→sort→combo LOGIC is correct
  and test-covered; the real defect was DIAGNOSTICS. A scan that ends 0-filled was
  always reported by the bulk queue with a single generic "No verified priced
  candidate was attached", DISCARDING the auto-fill job's precise terminal message —
  so a profit-gate loss (loss combos found), a genuinely-empty scrape, a thrown error,
  and a 50-min timeout were indistinguishable in the queue dialog (and the headline
  contradicted the loss-combo `LastBuyInSearchPanel` rendered right below it). Fixes:
  (1) `server/bulk-auto-fill-job.ts` `filled===0` branch now picks the reason by the
  auto-fill job's terminal STATE: `!done` → "Search timed out after N min"; status
  `failed` → the error / per-slot skip reasons; completed-0 → the auto-fill
  `doneMessage` (the rich "No profitable combination found … Best option …" economics,
  or the empty-scrape line). `item.error` now carries only the per-slot skip breakdown
  (no verbatim duplicate of the headline). The dialog already renders `item.message`
  (red) + `item.error` + the loss panel, so this is immediately visible.
  (2) `server/auto-fill-job.ts` `doneMessage` no-combo branch now appends SCRAPE
  COVERAGE — `Home city "<term>" returned N VRBO listings (M usable >=2BR)` (or the
  resort-scan count for single-unit) + nearby-city count — so a 0-listing SCRAPE
  problem reads differently from a matched-but-no-pair (combo-finding) outcome. This
  is the line that lets the operator tell "scraping went wrong" from "matcher found
  nothing" when reviewing a failed scan.
  Confirmed NOT a bug (don't re-chase): the Florida / non-Hawaii region geo-threading
  is already wired through all three layers — daemon guard `expectedState` (parsed
  from the "City, Florida" destination in `searchVrboViaSidecar`), server geo-drop
  `targetState` (from `BUY_IN_MARKET_LOCATIONS[community].state`, PR #618), and the
  expansion's `targetState` (`city-vrbo-expansion.ts` line ~443) — so the AGENTS.md
  "SIBLING STILL PENDING" Florida note in the geo-guard section is STALE.
  (3) Test hygiene: `npm test` had been RED since the auto-fill/bulk queue moved
  server-side (PRs #612 etc.) — `tests/pipeline-logic.test.ts` had FIVE meta-assertions
  still grepping client `bookings.tsx` for attach / walkability / PM-discovery
  internals that now live in `server/auto-fill-job.ts` + `shared/city-vrbo-combo.ts` +
  the attach route (`Buy-in units too far apart`). Repointed each to its true location
  (intent preserved), plus two drifted relocation-Guest-Page string guards
  (unconditional VRBO detail scrape; community gallery `slice(6→8)`). Suite now 0
  failures; `npm run build` passes; `npm run check` adds no new errors in touched files
  (the ~285 repo-wide TS errors are pre-existing). NOTE: could NOT pull the operator's
  live Railway runtime logs from the cloud session (no Railway/DB creds), so the audit
  was code-path based — the diagnostics fix is what makes the NEXT run's failed scans
  self-explaining in the dialog.

- 2026-06-08 (guest inbox: FULLY AUTOMATED auto-reply + attention banner):
  Operator asked to make the inbox responder fully automatic, with a top-of-inbox
  notice that surfaces the messages he should check (not-100%-confident or
  super-urgent), and to remove the "AI Draft Approval" tab. The Part B auto-send
  engine already existed (queue → review window → `runAutoSendQueue` re-validation,
  3-layer safety stack) but defaulted OFF. This change: (1) flips it ON via a
  one-time persisted rollout flag `auto_send.full_auto_rollout_v1` in
  `loadAutoSendConfig` (forces master_enabled=true + hold_recommendations=false at
  first boot regardless of stale state; a later operator OFF still sticks); (2)
  sharpens the HOLD rails — a SYSTEM_PROMPT "AUTO-SEND MODE" confidence gate, new
  urgency keywords in `RISK_KEYWORDS`, and `forceDraftForReview:true` on the clean
  path so held items keep a conservative reviewable draft; (3) removes the tab and
  moves review into a TOP ATTENTION BANNER (`client/src/pages/inbox.tsx`, above the
  now-controlled `<Tabs>`): status row (auto-send toggle / window / Check-now) +
  a red/amber "N messages need your review" list of HELD items (drafted/flagged/
  error, urgent-first), each Send/Save/Save&learn/Redo/Open-thread/Decline; clean
  replies auto-send silently. No schema change (urgency is client-side display via
  `AUTO_REPLY_URGENT_RE`; the server RISK_KEYWORDS hold is authoritative). The
  single OFF switch is the banner toggle. Full rationale in AGENTS.md
  ("Auto-reply is FULLY AUTOMATED" under #24 + Decision Log 2026-06-08).

- 2026-06-08 (sidecar CDP-wedge auto-heal, PR #595): diagnosed a live outage where
  EVERY VRBO scan exported 0 listings (`raw=0`, `connectOverCDP: Timeout 30000ms
  exceeded`) → no matches anywhere. Root cause: the sidecar's local Chrome
  instances were CDP-WEDGED — alive on HTTP (`/json/version` → 200) but the
  websocket DevTools protocol hung, so Playwright's `connectOverCDP` handshake
  timed out. `chrome-sidecar-manager.mjs recoverDeadLocalCdp` couldn't fix it (its
  health checks are all HTTP, which pass; `Browser.close` can't reach a wedged
  protocol), and the worker just reconnected to the same wedged Chrome on every
  retry. Immediate fix was manual: `pkill -f VrboSidecar-Chrome` (kills ONLY
  sidecar Chromes — they carry `--user-data-dir=.../VrboSidecar-Chrome*`; personal
  Chrome has none) + `launchctl kickstart -k gui/$(id -u)/com.vrbosidecar.worker`,
  then a fresh scan returned 290 listings. Permanent self-heal: added
  `forceRelaunchLocalCdp(cdpUrl, reason)` + `killLocalChromeProcess(instance)` to
  `chrome-sidecar-manager.mjs` (hard-kills by the instance's UNIQUE
  `--remote-debugging-port=<9222+index>` — safe, can't hit personal Chrome — then
  relaunches + `waitForCdp`), and `worker.mjs ensureBrowser` now detects a
  `connectOverCDP` timeout and calls it (bounded, `cdpRecoverAttempt < 2`) instead
  of throwing. Live worker is `~/.vrbo-sidecar-daemon/worker.mjs` +
  `chrome-sidecar-manager.mjs` (mirror of the repo daemon copies); after editing,
  `cp` BOTH to `~/.vrbo-sidecar-daemon/` then kickstart. Railway runs the server,
  NOT the daemon — a deploy doesn't ship this; the local cp+kickstart is what
  activates it.

- 2026-06-08 (Auto-fill cheapest → server-side background job, PR #590):
  Operator asked that clicking "Auto-fill cheapest" on the bookings page keep
  running even after leaving the page / not being on the tab. Root cause: the
  whole escalation ladder AND the buy-in attach lived in the client
  `autoFillMutation` (`client/src/pages/bookings.tsx`); the heavy search
  primitives were already server-side but the orchestration + the
  `POST /api/buy-ins` → `attach-buy-in` calls were client-driven, so unmounting
  the page abandoned everything not-yet-attached (PR #588's resume only re-fired
  on tab *return while still mounted*). Fix: new `server/auto-fill-job.ts`
  fire-and-forget job (modeled on `preflight-background-jobs.ts` +
  `city-vrbo-expansion.ts`) runs the full ladder (resort find-buy-in → home-city
  VRBO → nearby expansion → per-slot fallback) + attaches server-side via
  in-process LOOPBACK self-calls to the EXISTING endpoints (no re-implementation
  of the 4k-line find-buy-in handler; 127.0.0.1 bypasses ADMIN_SECRET). The
  button now just starts the job + hands off to `AutoFillJobPoller`; on
  mount/return the client rediscovers live jobs via
  `GET /api/operations/auto-fill/active` so it survives a full reload/navigation,
  and picks persist to Postgres as they attach. Full load-bearing rationale in
  AGENTS.md ("Auto-fill cheapest is a SERVER-SIDE background job"). Verified:
  `npm run check` (no new TS errors in touched files) + `npm run build` pass;
  Railway deploy live + smoked — `POST /api/operations/auto-fill` validates
  (400 on bad body), a job runs queued→running→completed with the correct
  serialize payload, and `GET …/active` returns `{jobs:{}}` (non-destructive
  smoke against an unknown property: find-buy-in 404s early, no sidecar driven,
  attached=0). The old client `CityExpansionJobPoller`/`expansionJobs` flow is
  now dead (expansion runs inside the server job) but left in place — don't wire
  it back to the button.

- 2026-06-06 (VRBO sidecar: stop Chrome stealing macOS foreground focus):
  Operator: when a sidecar job ran, Google Chrome popped to the foreground and
  knocked Safari/Claude out of focus — and even after it minimized, macOS didn't
  hand focus back, forcing a Dock re-click. Diagnosed: the LIVE env had
  `SIDECAR_CHROME_VISIBLE="1"` (visible/on-screen, direct binary spawn = focus
  steal, no minimize). Empirically proved on the operator's Mac (lsappinfo poll):
  the hidden background launch (`open -g -j -n` + `--no-startup-window` +
  off-screen) does NOT steal focus, but the **CDP page-create** does, and
  `open -b <bundleid>` reliably returns focus. Fix (two parts):
  (1) flipped the live env script + the installer default to
  `SIDECAR_CHROME_VISIBLE="0"` (hidden/off-screen + background launch — both
  `worker.mjs` and `chrome-sidecar-manager.mjs` honor it);
  (2) added a **macOS focus-guard** to `daemon/vrbo-sidecar/worker.mjs`
  (`captureFrontmostUserApp` via `lsappinfo` + `scheduleReturnFocus` via
  `open -b`, gated `SIDECAR_RETURN_FOCUS`, default on, no-op in visible mode /
  off macOS). It captures the operator's frontmost app before
  `chromeSidecarManager.acquire()` and re-activates it at 100/350/750/1400 ms
  after acquire + in `scheduleSidecarMinimize`. Uses `lsappinfo`/`open` (NO
  Accessibility/Automation TCC permission — works from the launchd daemon).
  CAPTCHA surfacing still works (`SIDECAR_CAPTCHA_SURFACE_WINDOW=1`). Verified
  end-to-end: restarted `com.vrbosidecar.worker`, killed the old visible Chromes
  (only the `VrboSidecar-Chrome`/`rct-sidecar-chrome` data-dirs — personal Chrome
  untouched), drove a real `pm_url_check` job → all 8 instances relaunched with
  `--start-minimized --no-startup-window` and Safari stayed frontmost 40/40
  poll ticks. Live worker is `~/.vrbo-sidecar-daemon/worker.mjs` (mirror of the
  repo copy; backed up to `worker.mjs.bak-focusguard-*`). **Don't revert the env
  to visible without operator ask.**

- 2026-06-06 (AI Draft voice → expert reservationist, PR #551):
  Operator asked to make the guest-inbox AI drafts "much better… think like an
  expert vacation rental booker," still signed John Carpenter. Both draft prompts
  were almost entirely DEFENSIVE (long "don't say X" + AI-tell lists) with no
  positive guidance on how an expert reservationist actually replies → safe but
  flat. Added an **EXPERT JUDGMENT** layer to BOTH prompts:
  `SYSTEM_PROMPT` in `server/auto-reply.ts` (the AI Draft Approval queue) and the
  `HUMAN_VOICE_RULES` block in `server/routes.ts` `POST /api/inbox/ai-draft`
  (the manual compose-box draft). The layer = read the question behind the
  question; be decisive/confident (state fetched facts plainly, drop hedging
  words); set expectations honestly (confirmed-now vs assigned-later, never
  over-promise the unit assignment); offer at MOST ONE fact-based anticipatory
  detail tied to the guest's stated need (explicit "skip if nothing fits" guard
  so it can't become amenity spam); calibrate warmth to the guest's tone.
  **Load-bearing / DON'T REVERT to defensive-only:** the expert layer is
  intentional and is designed to work WITH `humanize-reply.ts` (which deletes
  closers/warm-ups/em-dashes) — that's why "momentum" is reframed as confidence +
  clarity, NOT a closing line. The full AGENTS.md #24 safety stack
  (flag categories + the never-commit list + RISK_KEYWORDS + OUTPUT_RISK_PATTERNS)
  and the EXACT `John Carpenter / Reservationist / Magical Island Rentals`
  sign-off (matched by `ensureSignoff` + humanize `SIGNATURE_MARKERS`) are
  preserved verbatim-equivalent. Deliberately did NOT add any line that commits to
  an ADA/mobility accommodation — that stays a flag case (a candidate rewrite that
  did was rejected in review). Built via a 9-agent design workflow (4 expert
  lenses → adversarial critique → synthesis). Verified: `npm run check` adds no
  new errors in the two touched files, `npm run build` passes; Railway deploy
  `eacc7c38` SUCCESS + healthy (base 302→/login, gated API 401). Could not
  behaviorally smoke the drafting endpoint live — the `ADMIN_SECRET` portal gate
  is now active on this deploy and no secret was available; confirm via "Redo AI
  Draft" or the next auto-reply tick.

- 2026-06-06 (photos tab: "Check photo community" QA button):
  Operator asked for a button on the photos tab that confirms (1) the community
  name of the photos in the community folder, (2) that ALL community photos are
  of that community, and (3) for each unit, what community it's in and whether
  it's the SAME community as the community photos — plus "anything else useful."
  Shipped end-to-end:
  - **New module `server/photo-community-check.ts`** + endpoint
    `POST /api/builder/photo-community-check`. ONE Claude vision call
    (`claude-sonnet-4-6`) over a sampled set (community ≤10, each unit ≤6,
    total ≤24) with every photo inlined and delimited by text markers so the
    model judges community↔unitA↔unitB consistency holistically. Returns a
    structured verdict (pass/warn/fail) with: identified community + matches-
    expected (yes/no/uncertain) for the community folder, per-unit
    same-as-community, within-folder consistency, junk/mis-filed flags
    (floorplan/map/logo/screenshot/person/competitor watermark), and an overall
    summary + concerns.
  - **Extras added on top of the operator's 3 asks:** deterministic
    cross-folder duplicate detection via dHash (`server/photo-hashing.ts`) —
    the same image filed in two folders is the strongest "mixed-up" signal and
    runs even with no `ANTHROPIC_API_KEY`; per-folder "X of Y checked" counts;
    junk detection; competitor-watermark detection.
  - **Load-bearing (see AGENTS #45):** the check is CLIENT-DRIVEN and
    property-agnostic — `runCommunityCheck` in
    `client/src/components/GuestyListingBuilder/index.tsx` builds the request
    groups from the rendered `photos` array (folder+filename from the
    `/photos/<folder>/<file>` URL, role+label+expectedCommunity from each
    photo's `source` string), NOT from a `unitBuilderData` lookup. This is what
    makes it work for negative-id drafts + single listings, which is exactly
    when a pre-publish QA matters most. Don't refactor the endpoint to take just
    a propertyId. Prompt reserves a cross-community "no" for POSITIVE
    contradictions (different resort signage, wrong climate, incompatible
    building/view) — unit interiors always look different from community
    amenities, so "looks different" alone must stay "uncertain."
  - Button sits in the photos-tab header (cyan "🔎 Check photo community"),
    needs NO Guesty listing selected (it's a local-photo check). Verified:
    `npm run check` adds no new errors in touched files, `npm run build` passes,
    and a local harness exercised disk-read + sampling + dHash + the no-key bail
    (18 photos sampled across community + 2 units, 0 false dupes). Full vision
    leg verified live on Railway post-deploy.

- 2026-06-06 ("missing" Makahuena booking in global summary = canceled; added Include-canceled toggle):
  Operator reported a Makahuena at Poipu booking (made today, Booking.com) not
  showing in the Operations "All properties · global summary" view. Investigated
  live: the global endpoint `/api/bookings/guesty-all` is ALREADY fully account-
  wide (pulls every Guesty listing via `fetchOperationsGuestyListings` + all
  account reservations, NO hardcoded property list — `operationsListingTargetFor`
  always returns a target, even ad-hoc for unmapped listings, so new properties
  auto-appear). The booking was hidden purely because its Guesty `status` is
  **`canceled`** (reservation `6a240f0640199c00133967ab`, guest Nili Zur) and
  `isCommittedGuestyReservation` filters `cancel|declin|inquir|request|expired|
  closed|draft`. So it was NOT a coverage bug. Fix per operator choice: added an
  **"Include canceled"** checkbox (next to "Include past stays") that passes
  `includeCanceled=true` to BOTH `/api/bookings/guesty-all` and
  `/api/bookings/listing/:listingId`. Server now gates the status filter on that
  flag (`isRenderableGuestyReservation` = id+checkIn still required; committed-
  status gate skipped when including), and the row renders a red/amber status
  badge for non-committed reservations. Default stays committed-only (clean).
  **Load-bearing Guesty quirk:** the ACCOUNT-WIDE `/reservations` list (no
  listingId filter) silently OMITS canceled/declined/inquiry/expired rows unless
  an explicit `status $in [...]` filter asks for them — a listingId-filtered
  query (the per-listing endpoint) DOES return them, but the global query does
  NOT. So `/api/bookings/guesty-all`, when `includeCanceled`, runs a SECOND
  paginated pass with `filters=[...checkOut?, {status $in [canceled,cancelled,
  declined,expired,inquiry,closed,draft]}]` and merges by `_id` (adds only,
  never drops a committed row). Verified live: the client filter change alone
  fixed the per-listing view, but the global view ALSO needed the second query —
  don't delete it thinking the `isCommitted` bypass is sufficient.
  Diagnosis tip: Guesty token lives in PG `guesty_token_cache` but `DATABASE_URL`
  is the Railway-internal host (unreachable from a local `railway run`); fetch a
  fresh client-credentials token instead (one-off, doesn't touch the app's cache).

- 2026-06-06 (relocation: row "messaged" badge + city-scan auto-attach/override):
  THREE bookings-page changes (`client/src/pages/bookings.tsx` + one new server
  endpoint in `server/routes.ts`).
  1. **Persistent "Guest messaged ✓" badge.** `markBookingAlternativePageSent`
     already stamps `messageSentAt` per token, but each `RelocateGuestDialog`
     open mints a NEW token, so per-token tracking can't drive a row badge. New
     batch endpoint `POST /api/booking-alternatives/sent-status` takes
     `{reservationIds}` and returns, per reservation, the most recent SENT page
     (newest-first via `getBookingAlternativePagesByReservation`, first with
     `messageSentAt`) + its open-tracking. The bookings list queries it for the
     visible rows and renders an emerald "Guest messaged <date> · opened ✓"
     badge once per reservation (on the first filled slot, next to "Message
     guest"). The dialog's send-success invalidates `["/api/booking-alternatives/
     sent-status"]` so the badge appears immediately.
  2. **City VRBO scan auto-attaches the cheapest same-community pair.**
     `CityVrboInventoryPanel` previously required clicking "Attach matched
     combo". Now, on an OPERATOR-initiated "Scan city VRBO", if a `suggestedPair`
     comes back (server's `suggestCityVrboComboPair` = cheapest walkable pair
     sharing a resort phrase) AND the booking's slots are still empty, it calls
     `onAttachCombo` automatically + toasts. No pair → a "No matching pair"
     toast (the requested pop-up). **Load-bearing:** auto-attach is gated to
     manual scans via `manualScanRef` — `autoScanTrigger` (Auto-fill-cheapest)
     scans do NOT auto-attach here, because that flow does its OWN city attach
     (routes ~5854) and racing it would double-attach the empty slots. Also
     gated to `slotsAllEmpty` so we never clobber already-attached units.
  3. **Manual per-unit override.** The panel renders one `<select>` per unit
     slot (filtered to that slot's bedroom count, cheapest-first, dupes
     disabled), seeded from the suggested pair. "Attach selected units" builds
     an `AutoFillComboOption` (picks in slot order, so `attachComboMutation`'s
     `picks[index]→slots[index]` mapping holds) and attaches the custom pair.
  Verified: `npm run build` passes; typecheck adds no new errors in the touched
  regions (repo-wide pre-existing errors remain).

- 2026-06-06 (relocation message to guest via booking channel + open tracking, PR #532):
  New reservation-row button "Message guest about move" (`RelocateGuestDialog`
  in `bookings.tsx`, shown once buy-ins are attached on a non-manual booking).
  One click: builds the `/alternatives/:token` guest page from the attached
  units (photos + AI copy), drafts an apology that we moved the guest to a
  comparable community + the page URL, and sends it through the Guesty
  conversation — which routes to the channel the guest booked with (VRBO→VRBO,
  Booking.com→Booking.com, Airbnb→Airbnb) via the conversation `module`. Verified
  live end-to-end.
  - **Booking.com formatting (load-bearing):** `buildRelocationGuestMessage` +
    `sanitizeForBookingChannel` in `routes.ts` emit ASCII-only plain text
    (straight quotes, hyphens for dashes, no rich text/emoji) with the listing
    URL on its OWN line. Booking.com only delivers the link if the property
    allowlists guest-message links in the extranet security settings (operator
    toggles that). Don't reintroduce smart quotes/markdown/emoji into this path.
  - **Durable pages + open tracking (load-bearing):** alternative pages are now
    persisted in Postgres (`booking_alternative_pages`, created on boot via
    `db:push`) in ADDITION to the legacy ephemeral `tmp/booking-alternatives`
    file, so guest links survive deploys. `GET /alternatives/:token` reads DB
    first (tmp fallback) and records an open ONLY for UNAUTHENTICATED requests —
    operator previews carry the admin session (or `?preview=1`) and are NOT
    counted (`resolvePortalSession` check). This is what keeps "did the guest
    open it" honest; don't count authed opens. `GET
    /api/booking-alternatives/:token/tracking` returns opened/openCount/
    firstOpenedAt/lastOpenedAt; the dialog polls it after send. `send-guest-message`
    takes the `token` and stamps `messageSentAt`. Verified: guest open → count++,
    operator/preview open → no count, count is durable in PG.

- 2026-06-05 (guest alternatives page: VRBO photos + AI copy + correct walk resort, PR #530):
  e2e-fixed the city-wide buy-in → "Guest page" flow (`/alternatives/:token`).
  THREE things, verified live on prod:
  1. **VRBO photos now reach the guest page.** The city VRBO listings already
     carry `image`/`images` from the server (`city-vrbo-inventory.ts`), but the
     client dropped them. Carried through `CityVrboInventoryListing` →
     `cityComboOptionFromInventory`/`liveCandidateFromCityComboPick` → the buy-in
     notes via `buyInPhotoNotesSuffix()` which appends the existing
     `Manual photo URLs:` marker **LAST** in the notes. **Load-bearing:** the
     marker MUST stay last — `manualBuyInPhotoUrlsFromNotes` parses every URL
     after it, so the "Same-unit evidence:"/anchor URLs (which come earlier)
     would be mis-captured as photos if the order flips. Only NEW attaches get
     the marker; buy-ins attached before this deploy have empty photos until
     re-attached.
  2. **Guest page shows ALL attached units** (the full combination), each with
     its photos + an AI description (`draftAlternativeGuestDescription`, Claude),
     not just the clicked slot. The GET renderer now de-dupes the photo grid so
     the hero isn't shown twice.
  3. **Walk card shows the units' real resort, not the configured one.**
     `estimateAttachedBuyInProximity`/`estimateListingPairProximity` were
     labeling the walk with `COMMUNITY_LOCATION_BY_KEY[community].searchName`
     (e.g. "Mauna Kai Princeville") even when the attached city-wide units were
     from a different Princeville-area resort. Now `resortLabelForAttachedUnits`
     + `commonResortNameFromTitles` derive the resort from the attached units'
     own listing titles (cut at the first " - ", reject size-only/"Gorgeous …"
     descriptor leads), overriding the configured name only when it isn't in the
     titles. **Load-bearing:** the walk is still COMPUTED against the configured
     resort (geocode hints + `RESORT_DEFAULT_WALK_MINUTES` fallback minutes
     unchanged); only the DISPLAYED label + description are relabeled via
     `relabelWalkDescription`. Don't pass the derived label into
     `walkBetween`/`fallbackWalkForResort` — that would drift the fallback
     minute estimate. Verified: prod walk card now reads "within Princeville".
  Reviewed via an adversarial multi-agent workflow (4 confirmed findings, all
  fixed: junk-LCP label, fallback-minute drift, descriptor leak, duplicate hero
  photo). Note: `/alternatives/:token` pages live on Railway's EPHEMERAL FS
  (`tmp/booking-alternatives`), so existing links 404 after every deploy and are
  regenerated by the button — candidate to move to the volume later.

- 2026-06-05 (city VRBO inventory: full ~210 export end-to-end, follow-up to #528):
  e2e-tested `/api/operations/city-vrbo-inventory` against prod + the local
  sidecar for Princeville (propertyId 19, 2026-07-20→27, VRBO reports 210) and
  fixed THREE bugs in `daemon/vrbo-sidecar/worker.mjs` that left it at 0 then
  170 cards. All three are load-bearing — see AGENTS.md "VRBO city inventory
  export" under Load-Bearing Decisions for the why.
  1. **Date picker month disambiguation** (`findVisibleDay` in
     `applyVrboVisibleCalendarDates`): VRBO shows TWO months at once and the day
     cells are bare numbers, so "20" exists in both June and July. The old scorer
     gave a bare-number/role match enough points to win and clicked the FIRST
     "20" (current month) → requested July 20→27 landed on June 20→27, the
     homepage form-guard rejected it, and the search never ran (0 results). Fix
     is layered: strict month/year/ISO metadata match → month-grid container
     match → positional left→right column match → original offset slice.
  2. **GraphQL phase advancing the SRP** (`paginateVrboGraphqlInventory` +
     call site): GraphQL replay yields 0 rows on VRBO's list view, so the phase
     fell back to clicking UI-Next, silently advancing the SRP to page 4 before
     the dedicated walk even started — the walk then harvested only the tail
     ("151-200 of 210"). For city-wide export the call now passes
     `allowUiNext:false` so the phase stays replay-only and the SRP stays on
     page 1. The blue-Next-button walk owns pagination.
  3. **Walk truncating at a page boundary** (`walkVrboResultsUiPages`): after a
     Next click VRBO swaps the list async, so harvesting immediately scraped a
     transitional page and the next-button briefly vanished → premature stop.
     Added `waitForVrboResultsPageAdvance` (poll the "N-M of T" range until the
     start index advances), a re-check of next-availability before giving up,
     and a clean `range-end-reached` stop when end>=total. Keep the bottom-scroll
     (`scrollVrboResultsPaginationIntoView`) before each page's harvest — it drags
     all 50 virtualized cards through the viewport; resetting to the top instead
     only captured ~20/50.
  Verified run: walk steps 1-50 → 51-100 → 101-150 → 151-200 → 201-210, stop
  `range-end-reached`, 206 unique listings merged (multi-sort fallback NOT
  needed). The multi-sort union path (`exhaustiveCityHarvestAllSorts`, which
  re-navigates `/search?...&sort=` URLs) now only fires when the walk genuinely
  falls short — worth migrating off injected URLs later per the VRBO sight+click
  policy. Live worker is at `~/.vrbo-sidecar-daemon/worker.mjs` (managed by
  launchd `com.vrbosidecar.worker`; `launchctl kickstart -k gui/$(id -u)/com.vrbosidecar.worker`
  to restart) — NOT the stale `~/Downloads/vrbo-sidecar/` copy the older notes
  reference. Note: that daemon's stdout to `sidecar-launchd.log` is block-buffered,
  so prefer the JSON response's `sidecar.mapHarvest` for diagnostics over tailing
  the log mid-run.

- 2026-06-04 (RentCast photo discovery, PRs #503–#506): `server/rentcast-discovery.ts`
  harvests active sale listings; SearchAPI resolves addresses to Zillow/Realtor URLs;
  wired on `fetch-unit-photos`, find-unit, and find-clean-unit in parallel with Apify +
  Zillow SearchAPI. **RentCast never supplies photos** — see AGENTS.md Load-Bearing #43
  and `docs/rentcast-photo-discovery.md` for Railway log patterns and tuning env vars.

- 2026-05-04 (single-password portal gate, OFF by default): added
  `server/auth.ts` middleware that gates the entire portal behind one
  shared password. Activated by setting the `ADMIN_SECRET` env var on
  Railway; when unset (default state on this deploy) the middleware is
  a no-op so the deploy itself doesn't change anything for the
  operator. To turn it on: set `ADMIN_SECRET=<long random string>` in
  Railway's env vars; the next deploy enforces it.
  
  Auth modes: (1) browser cookie set by POST /login — value is
  HMAC-SHA256(secret, "nexstay-portal-authenticated-v1"), no
  server-side session storage; (2) `X-Admin-Secret` request header for
  CLI/curl, matching Load-Bearing #32's existing pattern.
  
  FOUR EXCLUSIONS (load-bearing — same list AGENTS.md scan flagged):
  /login + /logout, /api/admin/vrbo-sidecar/* (so the operator's
  local-Chrome sidecar from Decision Log 2026-04-29 keeps working
  without needing the secret), /assets/* + /photos/* + favicon /
  manifest / robots (so the SPA shell + login page can render),
  127.0.0.1 loopback (because availability-scheduler.ts does an HTTP
  self-call to /api/admin/refresh-all-market-rates). Loopback bypass
  reads from `req.socket.remoteAddress`, NOT `req.ip` / X-Forwarded-
  For — Railway's edge sets XFF to the client IP and an attacker
  could spoof "127.0.0.1" via XFF; the raw socket is the only safe
  signal. Inline NOTE FOR CODEX comments in `server/auth.ts` cover
  every exclusion.
  
  Client side: `client/src/lib/queryClient.ts` `apiRequest` and
  `getQueryFn` now detect 401 responses and `window.location.href`
  to `/login?next=...` instead of bubbling a cryptic 401 toast. A
  one-shot `_redirectedToLogin` guard prevents a burst of parallel
  401s (TanStack Query fans queries out aggressively) from racing
  multiple navigations.
  
  Login UI is a small inline-HTML form served from `/login` —
  intentionally NOT React, so the SPA bundle doesn't need to load
  before authentication (saves ~1 MB on the unauthenticated request).
  Cookie is HttpOnly + SameSite=Lax + Secure (in prod), 30-day
  Max-Age; rotating ADMIN_SECRET invalidates every existing session.
  Open-redirect guard on POST /login: `next` param must be a
  same-site relative path (starts with "/" but not "//") or it
  defaults to "/".
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
