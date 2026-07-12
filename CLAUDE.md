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

- 2026-07-12 (audit receipt "Amenities unverified — aborted due to timeout" — verify-read RETRY over
  Guesty 429 pauses): Operator screenshot (Coconut Plantation receipt, stage 7 "Could not read the
  Guesty listing's amenities (The operation was aborted due to timeout)"); asked to investigate via
  Railway logs, fix, merge. DIAGNOSIS (don't re-chase): NOT a push failure — the sweep hit a live
  Guesty 429 mid-run (02:37:58Z, deployment 4ccfc1ed, mid deploy-burst); ALL Guesty calls serialize
  through guesty-sync.ts's global gate (500ms gaps + up-to-120s pause after any 429), the
  guesty-amenities route makes TWO serialized Guesty calls, and verifyAmenities had ONE 30s attempt —
  it aborted while the queue drained (the layout stage read the SAME listing fine seconds later).
  SHIPPED (`claude/unit-audit-amenities-fix-205063`): `loopbackVerifyRead` in unit-audit-sweep.ts —
  bounded retries + growing backoff (10s/20s) for the three verify-side Guesty reads (amenities 3×45s,
  layout + channels 2×45s), pure classification `unitAuditVerifyReadRetryable` (429/5xx/599 retry,
  other 4xx fail fast; GETs only) in shared/unit-audit-sweep-logic.ts; stage ceilings rebalanced
  (amenities 8→13m — scan timeout now explicitly subtracts BOTH verify calls' worst case, scan budget
  390s→420s no regression; layout/channels 90s→3m); exhausted retries still report `error` with the
  attempt count (honesty rule intact — see AGENTS.md Unit Audit Sweep #17). Verified: unit-audit-sweep
  122/0 (10 new), full `npm test` exit 0, build clean (strings bundle-grepped), `npm run check` 338 =
  baseline. The flagged receipt heals on the property's next sweep (re-run Audit or the weekly cron).

- 2026-07-12 (photo-listing cron: found→fix latency + outage retry + review tier + operator SMS):
  Operator asked to investigate the weekly photo-scan cron (photos found on Airbnb/VRBO/Booking →
  red flag → replace/swap) and implement all 4 improvements found, then merge. SHIPPED
  (`claude/listings-photo-detection-778279`): (1) FOUND-FLIP REACTION — the weekly scheduler now
  passes `onNewDetection` and a non-found→found flip immediately queues a Unit Audit Sweep for the
  owning property (`server/photo-found-reactions.ts`; source:"cron" so ALL replacement rails apply —
  proven shortfall, 28-day cooldown, SHARED weekly budget never reset reactively — and the fresh OTA
  row is reused, no double Lens). Flips only + scheduler-path only (on-demand checks and the sweep's
  own rescans never react — recursion guard); drafts must be Guesty-mapped; dedupe = startUnitAuditSweep
  returning the active job. Kill `PHOTO_FOUND_AUTO_AUDIT_DISABLED=1`. (2) INCONCLUSIVE rows (all-unknown,
  "Lens unavailable", or outage-preserved statuses) re-scan after `PHOTO_LISTING_INCONCLUSIVE_RETRY_HOURS`
  (24; 0 disables) instead of waiting the 7-day cadence — pure `photoListingScanWasInconclusive`;
  persist()'s preservation note is now the shared `INCONCLUSIVE_SCAN_NOTE` constant (drift-locked,
  don't inline-reword it). (3) REVIEW tier — verified hits carry `verified:true` in the match JSON;
  a "clean" platform with ≥1 verified match renders an amber "A!/V!/B!" badge (pure
  `subThresholdVerifiedMatches`) so a single-photo repost isn't invisible; DISPLAY-ONLY — never raises
  the red popup, never feeds auto-replace. (4) OPERATOR SMS ALERTS (`server/operator-alerts.ts`,
  sendQuoSms conversationId:null, fail-soft, app_settings dedup `operator_alerts.recent.v1`, ~1 text
  per condition per week) for photo-found flips (+queued-sweep outcome), address-found flips (takedown),
  and cron replace cooldown/budget blocks — DORMANT until the operator sets `OPERATOR_ALERT_PHONE` on
  Railway. Verified: photo-listing-decision 29/0 (9 source guards), full `npm test` exit 0, build clean
  (env/strings bundle-grepped in BOTH bundles), `npm run check` 338 = baseline (stash A/B identical
  error sets). Could NOT live-smoke Lens/SMS (no keys) — post-deploy: set OPERATOR_ALERT_PHONE to get
  texts; flip-reaction + 24h retry are automatic on the next scheduler tick.

- 2026-07-12 ("can't confirm photos" → PROVENANCE upgrade, 3 levers): Operator: "Is there anyway to
  improve the can't confirm photos issue?" → "Yes build all three and then merge PR with main."
  SHIPPED (`claude/unit-audit-sweep-tool-79apae`; see AGENTS.md Load-Bearing "Unit Audit Sweep" #16 —
  don't re-chase): (1) the photo-community check now upgrades UNCERTAIN votes + a too-few-decisive
  unit verdict when the gallery's ORIGIN is verified — operator pin > source-page match "yes" >
  committed unit-swap (pure `unitProvenanceFor`/`canUpgradeWithProvenance` in
  shared/photo-community-check-logic.ts; a positive "no" vote blocks EVERY kind, machine kinds need
  ≥1 corroborating "yes" vote, source-page "no" vetoes swap provenance); provenance fields are
  SERVER-stamped only (the route strips client-sent `swapVerified`/`operatorVerified`, then
  `enrichCheckGroupsWithProvenance` in server/photo-folder-verification.ts re-derives them from
  committed unit_swaps + the pin store; the bulk Comm-QA job enriches identically); the
  interior-sample-size warn is skipped for provenance-verified units. (2) the sweep's resolve stage
  BACKFILLS missing `_source.json` URLs (replacement-* folder → committed swap newSourceUrl; draft's
  own unit folder → draft unit1/2SourceUrl) via never-clobber `writeFolderSourceUrlIfMissing`
  (server/photo-folder-source.ts, storage-free so tests need no DATABASE_URL) so the source-page leg
  can run for older scrapes. (3) operator PIN: "✓ These photos are correct — mark verified" button in
  the SHARED photo-community-check-report component (unconfirmed units only, NEVER over a positive
  mismatch) → POST /api/builder/photo-folder-verification → app_settings
  `photo_folder_verifications.v1`, fingerprint-scoped (photoFolderFingerprint over the published
  filename set — any photo add/hide/replace silently un-applies; the pin takes effect on the NEXT
  check run). Verified: photo-community-check 89/0 (33 new incl. behavioral never-clobber tests on
  real temp folders), full `npm test` exit 0, build clean, check 338 = baseline, chip + pin flow
  smoked on the BUILT bundle (Playwright, preflight surface).

- 2026-07-12 (cron UNIT REPLACEMENT ON — "1 bedroom photo on a 3BR = swap it, 100% automated"): Operator
  directive; supersedes the same-day cron replacement-OFF default. Weekly auto-audit sweeps now run
  the FULL photo ladder including unit replacement (`UNIT_AUDIT_CRON_REPLACE=0` restores flag-only),
  made safe by three rails (AGENTS.md Unit Audit Sweep #15; don't remove): (a) PROVEN shortfall —
  `folderLabelsComplete` + wait + community re-check BEFORE the ladder acts, so the async-labeler
  0/N race (the 2026-07-07 class) can never trigger a swap; (b) 28-day anti-churn cooldown per unit
  (`AUDIT_REPLACE_COOLDOWN_DAYS`, `replaceRungOnCooldown` over unit_swaps; manual sweeps exempt);
  (c) per-run budget `UNIT_AUDIT_CRON_REPLACE_CAP`=3 reset by the scheduler each run. Cooldown/
  budget blocks = attention, never fail. POST-SWAP: descriptions regenerate from the NEW unit's
  source + collage re-composes within the same sweep (`replacedThisSweep` in-memory hint). Verified:
  unit-audit-sweep 112/0, full `npm test` exit 0, build clean, check 338 = baseline.


- 2026-07-12 (WEEKLY AUTO-AUDIT cron — "auto correct itself so Comm QA turns green"): Operator asked
  how the Comm QA column can self-correct to green. The fix side existed (sweep re-checks persist
  through the Comm QA engine); the gap was nobody clicking. SHIPPED
  (`claude/unit-audit-sweep-tool-79apae`): `server/unit-audit-scheduler.ts` (market-rate-scheduler
  clone) — every builder property + Guesty-MAPPED draft gets a full auto-fix sweep weekly via the
  bulk one-at-a-time queue; columns converge to green on their own; genuinely-unfixable judgment
  calls (yellow votes) surface as ⚠ with reasons. Deploy-safe: `unit_audit_auto.last_run_at` in
  app_settings, stamped at START, first-boot anchor → first run ~6d after deploy, never at boot.
  CRON posture (load-bearing): `record.source="cron"` → OTA stage reuses the weekly photo-cron's
  rows (`AUDIT_CRON_OTA_FRESH_HOURS`=192, prevents weekly double Lens spend) and unit replacement
  stays OFF unless `UNIT_AUDIT_CRON_REPLACE=1`. Kill `UNIT_AUDIT_AUTO_DISABLED=1`; manual trigger
  `POST /api/admin/run-unit-audit-cron`. Verified: unit-audit-sweep 105/0, full `npm test` exit 0,
  build clean, check 338 = baseline.

- 2026-07-12 (Unit Audit Sweep — first LIVE receipt fixes; Coconut Plantation screenshot): Operator
  ran a real sweep and asked to automate fixing everything it flagged. FOUR fixes shipped
  (`claude/unit-audit-sweep-tool-79apae`; don't re-chase): (1) "27 saved amenities not on the Guesty
  listing even after scan+push" was a VERIFY-side false alarm — the push resolves names via norm() +
  Guesty's canonical list + aliases ("Ocean View"→"Sea view") while the verify compared plain labels
  and never read otherAmenities; verify now uses the same guesty-amenities read-back + shared
  `normalizeGuestyAmenityName`/`amenityPresenceCandidates` (drift-locked to routes' norm()). (2) NEW
  community-folder ladder in photo-fix (the stage previously only fixed UNIT problems and said
  "nothing to fix" under a community-folder FAIL): auto-hide RED-vote/junk/community-side-cross-dupe
  photos (soft-delete PUT, floor 3, no-loss first, yellow votes NEVER touched) → still wrong →
  escalate to the existing community-photo-repull job → re-check + row upsert. (3) same-scene dedupe
  groups now AUTO-APPLY inside the sweep per operator directive (sweep-only exception to the
  review-only stance; `AUDIT_DEDUPE_SAME_SCENE=0` restores; Photos-tab manual flow unchanged).
  (4) photo-fix honesty: "nothing to fix" can't render under a failed photo stage. Verified:
  unit-audit-sweep 97/0, full `npm test` exit 0, build clean, check 338 = baseline.

- 2026-07-12 (Unit Audit Sweep PR 3 of 3 — PHOTO FIX LADDER + bulk queue; plan complete): Operator:
  "Please go and then when finished with this task in full merge pr with main". SHIPPED
  (`claude/unit-audit-sweep-tool-79apae`): NEW stage `photo-fix` (11 stages; after the photo
  verifies) — bounded ladder per failing unit from pure `photoFixRungsForUnit`: bedroom shortfall →
  re-scrape (`/rescrape-unit-photos`) → find-new-source (preflight photo-fetch job, findNewSource +
  targetFolder cores / draftMode drafts + sibling skipUrls) → replace unit (one-click auto-replace,
  polled, 40m ceiling); community mismatch skips re-scrape; OTA-found → replace ONLY (the replace
  find phase is OTA-clean-gated — justifies flipping the ota-scan row to `fixed` w/o a second deep
  scan). After each photo change: target re-resolved, auto-labeler awaited (waitForFolderLabels
  local twin — the 0/N class), community re-check; success UPSERTS the photo-community row
  ("(after photo fixes)") so the roll-up is post-fix honest. Replace gated `record.allowReplace`
  (dialog sub-checkbox default ON) + `AUDIT_REPLACE_DISABLED`; `AUDIT_PHOTO_FIX=0` skips. BULK:
  "🔍 Audit selected" header button → `POST /api/unit-audit/bulk` (dedupe, cap 40) → global
  one-at-a-time slot (`UNIT_AUDIT_CONCURRENCY`, queued heartbeat keeps resume window alive).
  Verified: unit-audit-sweep 83/0, full `npm test` exit 0 (city-vrbo-expansion smoke is
  timing-flaky under parallel CPU load only — 8/8 isolated), build clean, check 338 = baseline,
  UI on BUILT bundle. The 3-PR Unit Audit Sweep plan is COMPLETE.

- 2026-07-11 (Unit Audit Sweep PR 2 of 3 — AUTO-FIX chaining): Operator: "Go on pr 2". SHIPPED
  (`claude/unit-audit-sweep-tool-79apae`, follow-up to PR #1013): fixable stages repair through the
  EXISTING engines then RE-VERIFY (`fixed` verdict only on a passing re-check): dedupe → validated
  `/photo-dedupe-apply` hides HASH-proven extras only (same-scene = review-only, pure
  `dedupeAutoFixSelections`; target re-resolved after a hide so collage candidates never reference
  hidden files); descriptions → server-side twin of ↻ Regenerate (generate-listing w/ real source
  URLs, disclosure composition, `warning` refused, overrides persisted, ONLY regenerated fields
  pushed — `notes` compliance-owned; verify now reads EFFECTIVE fields, override wins);
  amenities → `/scan-amenities` loopback (scan+save+ADD-ONLY push in one call); collage →
  `/auto-cover-collage` with published-photo candidates; pricing → per-property refresh+push
  (drafts via `/api/community/:id/refresh-pricing`), fired ONLY on never/stale/failed/seed/
  missing-size/RED-confirmation, `AUDIT_PRICING_REFRESH=0` kills. LAYOUT stays flag-only ON PURPOSE
  (bedding push reads Bedding-tab localStorage — invisible server-side; source-locked no
  listingRooms/PUT). `record.autoFix` (dialog checkbox default ON; `UNIT_AUDIT_AUTOFIX_DISABLED=1`
  global kill). Stage ceilings raised (descriptions 6m/amenities 8m/collage 8m/pricing 20m/dedupe
  12m). Verified: unit-audit-sweep 67/0, full `npm test` exit 0, build clean, `npm run check` 338 =
  baseline, dialog UI re-verified on the BUILT bundle. PR 3 (photo fix ladder + bulk queue) next.

- 2026-07-11 (dashboard "Audit" column — Unit Audit Sweep, PR 1 of 3, VERIFY-ONLY): Operator asked for
  a one-click full-unit audit tool (AI descriptions, AI amenities, photos-match-community + enough
  bedroom photos else replace source/unit, AI collage, layout, pricing — per-stage UI progress +
  failures + a dashboard column; "every data aspect perfect"); plan confirmed, then "Please go".
  SHIPPED (`claude/unit-audit-sweep-tool-79apae`): NEW `shared/unit-audit-sweep-logic.ts` (10-stage
  vocabulary, job store `unit_audit_sweeps.v1` + per-property receipts `unit_audit_reports.v1`,
  resume rules, verdict roll-up, `unitAuditBadge`) + `server/unit-audit-sweep.ts` (orchestrator
  modeled on auto-replace-jobs: mutateStore promise-tail, boot watchdog `UNIT_AUDIT_RESUME_DISABLED`,
  cancel, per-stage timeouts) + `/api/unit-audit*` routes + `GET /api/dashboard/unit-audit-status` +
  home.tsx "Audit" column (after Comm QA; 21 columns now — empty-state colSpan bumped) +
  `client/src/components/unit-audit-dialog.tsx` (live checklist / receipt, Run/Re-run/Cancel).
  LOAD-BEARING (see AGENTS.md "Unit Audit Sweep"): (1) NOT the preflight "Full unit audit" (that's
  the OTA platform check) — never alias; (2) every stage REUSES the existing engine (photo groups via
  buildPhotoCommunityCheckRequestForProperty, dedupe scanForDuplicatePhotos, community check via
  loopback POST photo-community-check {propertyId} so Comm QA stays in sync, OTA deep scan w/ 24h
  fresh-row reuse `AUDIT_OTA_FRESH_HOURS`/`AUDIT_OTA_SCAN=0`, shared placeholder/license detectors,
  computeMarketRateMatchConfirmation) — source-guarded; (3) stage verdict `error` ≠ pass ≠ failed —
  an unverifiable check can never green the audit; (4) stage results append on COMPLETION only (the
  resume seam). PR 2 = auto-fix chaining (dedupe apply, regenerate+push, amenity push, collage,
  bedding push, pricing refresh); PR 3 = photo fix ladder (re-scrape → find-new → replace unit) +
  bulk "Audit selected" queue. Verified: unit-audit-sweep 51/0 (npm chain), full `npm test` exit 0,
  build clean, `npm run check` 338 = baseline (0 new), UI on the BUILT bundle (static SPA server +
  Playwright, all /api/* mocked: pass/attention/running/never badges, receipt dialog w/ review chips
  + expandable findings, Run POSTs propertyId → live checklist, running badge re-attaches). Could NOT
  live-run a sweep (no DB/keys in session) — post-deploy: click any Audit badge → "Run audit sweep";
  expect the 10-stage checklist to walk to a receipt in ~5-15 min (community + OTA legs are the long
  stages) and the column badge to stamp the verdict.

- 2026-07-11 (dashboard: sort by the "G" Listed-on-Guesty column): Operator asked to sort the
  dashboard by the Guesty-connected column without disturbing listing data or column widths.
  SHIPPED (`claude/dashboard-column-sorting-46df81`): `SortField` gained `"guestyListed"`; the
  comparator groups Guesty-connected rows (green G-dots, `guestyConnected.has(id)`) first on asc,
  unconnected first on desc — display-order only, ties keep stable order. LOAD-BEARING detail: the
  `/api/guesty-property-map` query + `guestyConnected` memo MOVED above the `filtered` useMemo
  (same react-query key = deduped, zero behavior change) because the sort comparator closes over
  it — declared below, it TDZ-crashes; same pattern as propertyRevenueData/priceScanData. Header
  keeps the exact `w-[20px]` (table-fixed reads widths off the header row) by stacking the "G"
  label ABOVE the sort icon (flex-col ghost button, `button-sort-guesty-listed`). Verified: full
  `npm test` exit 0, build clean (bundle-grepped), `npm run check` 338 = baseline (stash A/B —
  identical home.tsx error set, line shifts only), UI on the BUILT bundle (static SPA server +
  mocked endpoints, Playwright: asc/desc grouping, all 20 header widths byte-stable across sorts,
  G column stays 20px, no rows dropped, re-sort after another column works).

- 2026-07-11 (Amenities push: "4 amenities not pushed to Guesty" — Other-bucket delivery + honest
  per-name proof): Operator (Kamaole Beach Club toast "71/69 saved. 4 have no Guesty equivalent"):
  diagnose + fix. DIAGNOSIS (don't re-chase): the 4 (Keyless Entry / Streaming Services / Near
  Restaurants & Dining / Hiking Trails Nearby) are curated `GUESTY_UNSUPPORTED_AMENITY_KEYS` —
  re-verified against BOTH the 187-name snapshot and Guesty's API docs: the supported catalog has no
  truthful name for any of them, the documented amenities PUT body is `{ amenities }` ONLY
  (`otherAmenities` is documented on RESPONSES only), no Open API endpoint writes the free-text Other
  bucket, and Guesty's own help docs say to add unmapped amenities channel-side or in the description
  (Other amenities are display-only, never channel-synced). SHIPPED
  (`claude/amenity-guesty-equivalents-4missing`): push-amenities ATTEMPTS the undocumented
  `otherAmenities` body field — union with the property's CURRENT Other entries (add-only, cap
  50×120ch) — with a 4xx→retry-documented-body guard (the conversations-"skip" class can never break
  the canonical push); delivery is proven PER-NAME via the existing read-back
  (`suggestions[].deliveredAsOther`), never assumed from a 200. Raw catalog keys prettify to labels
  ("NEAR_RESTAURANTS" → "Near Restaurants & Dining") before hitting Guesty/UI. UI: emerald
  "✓ delivered to Guesty's Other amenities" bucket + kept-in-system copy now carries the
  channel-side/description guidance; toast counts both. If Guesty ignores the field, behavior is
  byte-equivalent to before and reported honestly. Locked: amenity-scan-logic 83/0 (7 new guards);
  full `npm test` exit 0, build clean (bundle-grepped), `npm run check` 338 = baseline, three-bucket
  UI verified on the BUILT bundle (Playwright + mocked push). Could NOT live-verify whether this
  Guesty account persists the undocumented field (no creds) — post-deploy: re-push any listing's
  amenities and read the toast/panel verdict.

- 2026-07-11 (Photos tab "Make Cover Collage" → ONE-CLICK Claude-vision pick + server compose + Guesty
  push + in-system save): Operator: "change this so it uses claude vision and finds the two best photos
  and creates a collage and then pushes it to Guesty and saves it within the system … Research what best
  photos are usually used." RESEARCHED (Vrbo guidelines, host-CRO guides, eye-tracking left-bias): best
  pair = destination shot (ocean/lanai/pool) LEFT + bright living space RIGHT; never bathrooms/floor
  plans/dark/portrait/close-ups/people; both must survive a square crop. SHIPPED
  (`claude/collage-vision-guesty-1b317f`): NEW pure `shared/cover-collage-logic.ts` (prompt with the
  ranked pairings + hard rules, strict `parseCollageVisionPick` — out-of-range/self-pair → reject,
  `heuristicCollagePick` = verbatim port of the old client caption scorer with a self-pair guard,
  SHORT-side `collageEsrganScale` for the 800px square panels) + `server/cover-collage.ts` (ONE batched
  downscaled-image vision call, `COVER_COLLAGE_MODEL` default claude-sonnet-4-6, cap
  `COVER_COLLAGE_VISION_CAP=60`, kill `COVER_COLLAGE_VISION_DISABLED=1`, FAIL-SOFT to the heuristic;
  sharp composes the same 1600×800 2-up the manual canvas drew) + `POST /api/builder/auto-cover-collage`
  (routes.ts): client sends its VISIBLE photos (client-driven like the community/dedupe checks — hidden
  photos never reach the pick), ESRGAN via the existing `upscaleWithReplicateKw` only for sub-panel
  picks, then the ImgBB→Guesty-pin tail EXTRACTED from upload-collage into shared
  `pushCoverCollageToGuesty` (manual flow byte-compatible), then SAVES IN-SYSTEM: bytes at
  `client/public/photos/cover-collages/<listingId>.jpg` (photos volume) + `app_settings`
  `cover_collages.v1` record (picks/method/reasoning/URL, newest 200) — saves best-effort/reported,
  never unwind the push; relabel-all-photos SKIPS the cover-collages folder (test-locked). UI: banner
  button is one-click AI ("⏳ Claude is picking…", "🤖 Claude picked: X + Y — reasoning", method chip
  honest about heuristic fallback); "pick manually" keeps the legacy 2-photo picker→canvas flow.
  Verified: cover-collage-logic tests green (in the npm chain), full `npm test` exit 0, build clean
  (bundle-grepped both bundles), `npm run check` 338 = baseline (stash A/B — identical error sets),
  engine exercised against REAL files on disk (1600×800 JPEG out, heuristic picks correct, ESRGAN hook
  fired only for a 270px-short-side photo at 3x, external/missing candidates excluded, <2-photos 422
  path), UI verified on the BUILT bundle (static SPA server + mocked endpoints, Playwright: one-click →
  picking phase → picks/reasoning/saved copy → POST contract → manual picker still opens). Could NOT
  live-smoke the vision/ImgBB/Guesty legs (no keys) — post-deploy: open any builder Photos tab with a
  listing selected, click "🖼 Make Cover Collage"; expect the picked pair + reasoning within ~15s and
  the collage first on the Guesty listing. See AGENTS.md "AI cover collage" + the 2026-07-11 Decision
  Log line.

- 2026-07-11 ("Check photo community" report: yellow/red flags now SHOW the photo + keep/remove):
  Operator (screenshot of a check report): "When a photo is flagged in either yellow and/or red
  please have in the UI in the photos tab like show me exactly which photo it is referring to so I
  can then decide like yes delete or no keep." SHIPPED (`claude/photo-flag-indicators-6527b1`): the
  SHARED `PhotoCommunityCheckReport` (photo-community-check-report.tsx — Load-Bearing #45: edit the
  one component, both Photos tab + preflight render it) now renders a flagged-photo card under every
  YELLOW (unconfirmed) / RED (mismatch) per-photo vote, every outlier/junk flag, and BOTH sides of
  every cross-folder duplicate: the actual thumbnail (`/photos/<folder>/<filename>`, click = full
  size), folder/filename, and inline "🗑 Remove photo" / "✓ Keep". Remove = the EXISTING
  photo_labels.hidden soft-delete (PUT /api/photo-labels/:folder/:filename, insert-on-miss upsert,
  files never unlinked) behind window.confirm, with ↺ Undo (failed undo STAYS removed so the button
  survives). Green rows deliberately stay compact — don't add thumbnails to them. Flag ids resolve
  via the group's photoVerdicts (folder+filename were already server-populated — no engine change);
  the synthetic "pre-screen" outlier gets no card. Photos tab passes onPhotoOverridesChanged so a
  removal refreshes the gallery; preflight passes none (no gallery; counts are on-disk). Verified:
  photo-community-check 50/0 (9 new source guards), full `npm test` exit 0, build clean
  (bundle-grepped), `npm run check` 338 = baseline (0 new), UI exercised on the BUILT bundle
  (static SPA server + mocked endpoints, Playwright: cards render for yellow/red only, Keep marks,
  Remove confirm → hidden:true, Undo → hidden:false, cancelled confirm → no PUT).

- 2026-07-11 (preflight Full unit audit: "1 OTA lookup didn't respond (API error)" — auto-retry +
  false-not-listed fix): Operator screenshot of the Platform Check card's red "some checks didn't
  respond" banner; asked to investigate/improve/fix. TWO bugs in `checkPlatformStrict`
  (GET /api/preflight/platform-check, routes.ts — don't re-chase): (1) ONE try/catch wrapped the whole
  query loop, so a single thrown 12s SearchAPI timeout abandoned the platform's remaining queries and
  errored the platform with zero retries — the banner told the OPERATOR to be the retry loop; (2) worse
  + silent: non-ok responses (429 quota / 5xx) just `continue`d, so all-queries-failed fell through to
  `notListedVerdict()` = a FALSE decisive "No matching listing found" with zero evidence (quota
  exhaustion would green the audit — the false-Clear class #721 guards against). SHIPPED
  (`claude/unit-audit-search-30645c`): route — per-query isolation + 2 bounded attempts (600ms backoff;
  quota fails FAST via `isSearchApiQuotaError`), "not-listed" only when EVERY query completed, else an
  "error" verdict with the real reason (quota / timed out / HTTP status / N-of-M partial) via pure
  `preflightPlatformFailureVerdict`; audit job — ONE automatic retry pass over errored units before the
  receipt (`AUDIT_UNIT_RETRY_PASSES=1`, 2s delay), merge is ADDITIVE-ONLY (`mergeRetriedAuditUnitResult`
  heals "error" slots, never flips a decided confirmed/not-listed — SearchAPI is non-deterministic);
  receipt tallies FINAL post-retry results (`tallyPreflightAuditOutcome`). Pure pieces in NEW
  `shared/preflight-audit-outcome.ts`; locked by tests/preflight-audit-outcome.test.ts (24, in the npm
  chain, incl. source guards on both wirings). Worst case stays inside the job's 120s per-unit loopback
  timeout. Client untouched. Verified: new suite 24/0, full `npm test` exit 0, build clean,
  `npm run check` 338 = baseline (stash A/B). Could NOT live-smoke SearchAPI (no key in session) —
  post-deploy: re-run a Full unit audit; a transient blip should self-heal (brief "Retrying N lookups…"
  message) instead of raising the red banner.

- 2026-07-11 (Guesty photo push: photos "look upscaled" — smart ESRGAN gating + validator sharpening):
  Operator: "When photos are pushed to Guesty I think they're like upscaled. Is there anything we can
  do to improve this?" TWO real degradations found in POST /api/builder/push-photos (don't re-chase):
  (a) upscale:true (ALL automated pushes — guesty-photo-repush, bulk-combo publish) ran Real-ESRGAN 2x
  on EVERY photo — big originals (4032px Zillow) were AI-upscaled to 8064px then immediately
  Lanczos-downscaled back to the 1920px spec by photo-validator = AI-smoothed look, zero benefit,
  ~30s + Replicate cost per photo; and 2x was too LITTLE for tiny photos (418px→836px, then
  plain-stretched). (b) upscale:false (manual Photos-tab toggle default + publish-all flow) had the
  validator stretch every sub-1920 photo to exactly 1920 with NO sharpening (needsSharpen only fired
  on downscale) — the literal "looks upscaled" blur. SHIPPED (`claude/guesty-photo-upscaling-x3jzqn`):
  NEW pure shared/photo-upscale-plan.ts — `esrganScaleForPhoto` skips the AI when the LONG side
  (validator rotates portraits) is already >= 1920, else picks the smallest scale 2–4 that clears
  1920 (so the classical resize after ESRGAN only ever SHRINKS = crisp); wired into push-photos +
  /api/builder/upscale-photo via a sharp metadata probe; `upscaleWithReplicateKw` gained a scale
  param (makeover flow keeps legacy 2x). photo-validator: `isAlreadyPushCompliant` byte-passthrough
  fast path (upright landscape JPEG at exactly 1920 wide, <=4MB → original bytes untouched; re-pushes
  no longer burn a JPEG generation) + Lanczos UPSCALES now get sharpened too (sigma 1.0/m1 0.4/m2 1.0,
  mirrors guest-photo-upscale.ts). Client: Photos-tab toggle now defaults ON ("AI-upscale small
  photos…") and the publish flow follows the toggle (was hardcoded false) — safe since only sub-spec
  photos reach Replicate now. LOAD-BEARING: the 1920px/4MB/JPEG push spec is UNCHANGED (Airbnb rejects
  >1920×1080 — don't raise it); gate on the LONG side, not width. Verified: photo-upscale-plan tests
  (pure + source guards) green, full `npm test` exit 0, build clean (bundle-grepped both bundles),
  `npm run check` 338 = baseline (0 new), validator smoked with real sharp-generated images
  (passthrough byte-identical; 418px → 1920 sharpened; 4032px → 1920; portrait rotate; PNG converts).
  Could NOT live-smoke the Replicate/Guesty legs (no keys) — post-deploy: re-push any gallery; expect
  large photos to push in seconds (no ESRGAN wait) and small ones to land noticeably sharper.

- 2026-07-11 (Photos tab: "🧹 Scan photos & remove duplicates" — operator-confirmed dedupe with undo):
  Operator: photo pulls leave "a lot of duplicated photos or photos of the same area or the same tree
  but a different angle" — wanted a Photos-tab button that scans all photos and deletes extras, with
  safeguards. SHIPPED (`claude/photo-dedup-scanner-wimfjv`): (1) pure `shared/photo-dedupe-logic.ts`
  (49 tests, in the npm chain) — within-folder union-find clustering over TWO merged signals: dHash
  pairs at `NEAR_DUPLICATE_DISTANCE=10` (keyless; ≤5 = "exact"; env `PHOTO_DEDUPE_HASH_DISTANCE`) +
  high-confidence Claude-vision same-scene groups (medium-confidence DISCARDED; a vision edge is
  dropped on category mismatch or differing `bedroomClusterId` — two distinct bedrooms can never
  fold; only an exact-hash dupe bridges categories); deterministic keeper pick (human-touched >
  manual sort_order > gallery position > file size); `validateDedupeSelection` = the apply-time
  guard. (2) `server/photo-dedupe.ts` — reuses stored `photo_labels.perceptual_hash` (computes +
  backfills missing), ONE downscaled-image Sonnet call per folder (`PHOTO_DEDUPE_MODEL`, cap
  `PHOTO_DEDUPE_VISION_CAP=60`, kill `PHOTO_DEDUPE_VISION_DISABLED=1`), FAIL-SOFT to hash-only (no
  key → scan still finds exact/near copies); proposals stored in-memory 30 min for apply validation.
  (3) routes: POST /api/builder/photo-dedupe-scan (client-driven groups from the rendered photos
  array — works for static/drafts/single listings, same posture as photo-community-check),
  /photo-dedupe-apply (validates vs the STORED scan: keep-one-per-group, never empty a folder, 410
  on expired scan → client says rescan), /photo-dedupe-restore (undo). LOAD-BEARING: removal is the
  EXISTING `photo_labels.hidden` soft-delete — files are NEVER unlinked (test-locked), which is what
  makes "↺ Undo removal" a true undo; and the scan NEVER auto-applies (Load-Bearing #4 forbids
  automatic photo dropping — the thumbnail review + confirm step is the safeguard). UI: amber button
  beside "🔎 Check photo community"; groups render thumbnails with green keep / red remove chips
  (extras pre-checked), warnings when a folder would drop below 3 visible, confirm dialog, then a
  green applied state with Undo. Verified: photo-dedupe 49/0, full `npm test` exit 0, build clean
  (bundle-grepped), `npm run check` 338 = baseline (stash A/B; 10 new TS2802/TS7006 fixed via
  Array.from), engine exercised against REAL files on disk (byte-dupe + recompressed near-dupe
  grouped, distinct photo untouched, guards enforced), UI verified on the BUILT bundle (static SPA
  server + mocked endpoints, Playwright: scan → groups → keep-one guard → confirm → applied → undo).
  Could NOT live-smoke the vision leg (no ANTHROPIC key in session) — post-deploy: open any builder
  Photos tab, click "🧹 Scan photos & remove duplicates"; expect same-scene groups (purple "same
  scene (AI)" chips) alongside the hash-dupe groups.

- 2026-07-10 (unit-builder Descriptions tab overhaul: dedupe + real facts + placeholder push guard +
  editable fields + "Regenerate descriptions" button): Operator asked to evaluate how the Descriptions
  tab builds copy, implement every improvement found, and add a regenerate button. SHIPPED
  (`claude/unit-builder-descriptions-review-65390b`): (1) NEW shared/description-copy.ts —
  `stripAreaSectionsFromDescription` removes the generator's "THE NEIGHBORHOOD"/"GETTING AROUND"
  sections from the flat draft description at ALL THREE summary assemblers (adapt-draft
  `descriptionForDraft`, builder.tsx `buildGuestySummary`, routes.ts `draftToGuestySummarySource`) —
  those sections are pushed as their own publicDescription fields, so drafts were duplicating
  neighborhood/transit on every OTA with raw ALL-CAPS headers mid-summary. (2) push guard (the
  license-placeholder posture applied to descriptions): POST /api/builder/push-descriptions 422s when
  any field contains generate-listing's fallback scaffolding ("Add specific nearby landmarks … before
  publishing") via `findDescriptionPlaceholders`; the phrase list is DRIFT-LOCKED against routes.ts
  `fallbackDraft` in tests/description-copy.test.ts — reword a fallback sentence there → update
  `DESCRIPTION_PLACEHOLDER_PHRASES` in the same PR. (3) generator grounded in real facts: the
  bulk-combo copy step now passes `item.unit1/2SourceUrl` + streetAddress (was `url: ""` — Claude
  invented bathrooms/sqft/bedding), and both prompt variants accept per-unit source-listing detail
  snippets + a prefer-provided-facts rule. (4) NEW `property_description_overrides` table (positive
  core id OR negative -draftId, property_amenities convention; schema + schema-maintenance CREATE) +
  GET/PATCH /api/builder/descriptions/:propertyId + the tab's fields are now TEXTAREAS
  (summary/space/neighborhood/transit/access/houseRules) with ✎-edited chips, per-field reset,
  summary char counter, and a "💾 Save edits" button; live edits merge into effectivePropertyData so
  what you see IS what pushes (title pattern), and a PATCH null clears an override back to generated
  copy. LOAD-BEARING: `notes` is deliberately NOT editable — publicDescription.notes is owned by the
  compliance push (OTA-facing license block); an override would clobber it. Combos also gained a
  default Guest Access blurb (separate keys per unit). (5) "↻ Regenerate descriptions" button
  (Descriptions tab) re-runs /api/community/generate-listing with each unit's REAL source URL (from
  sourceUrlsByFolder → _source.json) + the property address, recomposes summary (disclosures intact
  via `composeSummaryWithDisclosures`) + space (unit long descriptions + walk line), applies to the
  editable fields AND persists as overrides; a generator fallback (`warning` set) is REFUSED — never
  applied (the push guard would reject it anyway). Verified: description-copy 30/0 (incl. source
  locks on all wiring), full `npm test` exit 0, build clean (bundle-grepped), `npm run check` 338 =
  baseline (stash A/B — identical error sets). UI verified on the BUILT bundle (static SPA server +
  mocked GET overrides): 6 textareas render, saved override hydrates with ✎ chip + reset, Save
  enables on edit. Could NOT live-smoke the Claude leg (no key) — post-deploy: open any builder
  Descriptions tab, click "↻ Regenerate descriptions", expect rewritten copy grounded in the unit
  source listings; then "Push Descriptions to Guesty".

- 2026-07-10 (preflight: per-unit "Find new photos" / photo-source buttons now on STATIC properties —
  Kaha Lani screenshot "why is find new unit photos not showing here?"): ROOT CAUSE: the per-unit
  "Find new photos" button (#990) lives on the preflight Photo Sources card, which was gated
  `isPromotedDraft` (and `handleScrapePhotosForUnit` hard-returned for `id >= 0`) — static builder
  properties never rendered it; the gate existed because the photo-fetch job could only persist via
  the draft-only /api/community/:draftId/persist-photos. SHIPPED
  (`claude/preflight-community-photos-check-2fxyao`): Photo Sources renders on EVERY preflight page.
  Static rows act on the unit's ACTIVE folder (replacement-p<prop>-u<unit> once swapped, else the
  unit's own folder): "Re-pull all photos" DELEGATES to the existing per-folder rescrape job (same as
  the committed panel's "Rescrape photos" — no new scrape path), "Find new photos" / empty-folder
  "Find Photos" run the photo-fetch job with new `targetFolder` input, whose STATIC persist branch
  hands the discovered sourceUrl to /api/builder/rescrape-unit-photos (single-writer folder path:
  downloadAndPrioritize + _source.json restamp → the next "Rescrape photos" re-pulls the NEW source).
  LOAD-BEARING GUARDS: (1) static discovery NEVER accepts a thin gallery — `minAcceptable =
  MIN_INDEPENDENT_UNIT_PHOTOS` whenever `staticFolderMode` (no draft row), seeding or replacing;
  (2) static rows count the ACTIVE folder ON DISK (`overridePhotoCounts` now covers every static
  unit) because static `photos` arrays are mostly absent — the old fallback would render a full
  gallery as "Find Photos" and empty-mode discovery could clobber it; (3) sibling skipUrls resolve
  the sibling's ACTIVE folder source. Draft behavior byte-identical (#990 locks still pass).
  Verified: discovery-cache 43/0 (11 new locks), full `npm test` exit 0, build clean, `npm run check`
  338 = baseline (0 new; stash A/B'd per-file). UI verified on the BUILT bundle (mocked
  /api/unit-swaps + job endpoints): swapped + un-swapped static pages both show
  Re-pull/Find-new/View-source per unit; "Find new photos" POSTs targetFolder=<replacement folder>,
  draftId 0, current+sibling sources excluded; completion receipt renders; "Re-pull" drives the
  rescrape job with no sourceUrl override. Could NOT live-smoke discovery/scrape legs (no keys) —
  post-deploy: open a static property's preflight and click "Find new photos" on a unit.

- 2026-07-10 (unit-builder Descriptions-tab licenses: sample↔detector single source of truth + real
  county formats + Maui STRH registry pull): Operator asked to investigate the license section's
  samples/online pulls and make samples as-real-as-possible / pull real licenses where a source
  exists. SHIPPED (`claude/unit-builder-licenses-01ad99`): (1) LOAD-BEARING — `sampleLicensesForLocation`
  MOVED to NEW `shared/license-samples.ts` (adapt-draft re-exports) and `isPlaceholderLicenseValue`
  now enumerates EVERY generatable sample (probe matrix) + `LEGACY_SAMPLE_LICENSE_VALUES` (retired +
  static unit-builder-data demo families) + `isSampleTaxLicenseCore` (TA-/GE- filler cores, any
  suffix). The lists had drifted ~60 values, so push-compliance could push filler licenses (e.g.
  "TA-026-780-7890-01") to live OTA listings as REAL — now impossible; when adding a sample branch,
  add a probe location (test-locked). (2) Sample formats corrected to county reality: Big Island
  STVR-19-3461 (county form numbers them "STVR - 19 - ___"), Maui ST<region>YYYYNNNN (STKM/STWM/
  STRH fallback), Oahu NUC-89-0134 (NUCs are 1989-90 era; a "NUC-24-…" is impossible); Kauai
  TVR/TVNC kept (registry-consistent). (3) `HAWAII_STR_PATTERN` widened to the real shapes
  (STVR-19-####, ST<region>########, "TVNC #NNNN", NUC-##-####; longer alternatives first so
  nothing truncates) + the Guesty-notes branch now reuses it instead of a drifted inline copy.
  (4) NEW real pull: Maui County Approved STRH list (the Kauai-TVR-registry analog) —
  parse/match/fetch in server/hawaii-compliance-lookup.ts, TMK-root-required matching, FAIL-OPEN
  into the public search (most legal Maui STRs are permit-exempt condos; Molokai issues none).
  Verified against the REAL county PDF: 154/154 permits parse; GIS 12-digit TMK → permit end-to-end.
  DESCOPED: hitax.hawaii.gov GET/TAT search (hCaptcha-gated), Big Island/Honolulu registries (no
  machine-readable list). Old pipeline-logic fixtures using sample-family values as "real"
  repointed. Verified: license-compliance-samples 26/0 (new, in chain), full `npm test` exit 0,
  build clean (UI strings bundle-grepped), `npm run check` 338 = baseline (0 new; the 4
  hawaii-compliance-lookup TS18047s are pre-existing, A/B-verified). Could NOT live-smoke
  SearchAPI/Guesty legs (no creds) — post-deploy: "Pull real STR permit" on a Kihei property with a
  real TMK should return its STKM… permit from "County of Maui Approved STRH list".
- 2026-07-10 (guest inbox: TIER-1 basics auto-answered by the AI + tier badges in the UI): Operator asked
  for "basic tier 1 questions like Is there an ocean view" to be answered automatically (Hawaii lingo,
  signed John Carpenter, "use claude AI search as much as possible") with the UI showing "AI responded —
  tier 1" vs "tier 2 — no automatic response". SHIPPED (`claude/guest-inbox-tier1-auto-d60726`): a SCOPED
  exception to the 2026-06-09 drafts-only default — pure `shared/guest-question-tier.ts` (81 tests)
  classifies every incoming guest message; tier 1 = short question-shaped basic-property-fact ask
  (curated topic list: ocean view, parking, pool, AC, wifi, laundry, kitchen, BBQ, lanai, beach distance,
  check-in times, bedrooms/beds, TV, resort amenities, linens) with ZERO tier-2 signals (money/
  availability/dates/policy/complaint/accessibility/urgency/service); everything else tier 2. Tier-1
  candidates draft on `AUTO_REPLY_TIER1_MODEL` (default claude-sonnet-4-6) WITH the server-side
  `web_search` tool (pause_turn-resumed, searches audited into toolsUsed) + a Hawaii-voice prompt block,
  then queue through the EXISTING delivery-verified auto-send under `auto_send.tier1_enabled` (default
  ON, new key so no rollout flag; master auto-send stays OFF and independent). LOAD-BEARING: the 3-layer
  safety stack is UNCHANGED and every hold path (risk keyword, flag_for_human, output filter, error,
  unmapped listing) DOWNGRADES the row to tier 2 + held — the tier-1 badge can never claim the AI
  answered when it didn't. Tier persists on `auto_reply_log.tier/tier_reason` (schema +
  schema-maintenance ALTER); UI = conversation-row chips + thread-header verdict in inbox.tsx fed by
  cheap `GET /api/inbox/auto-reply/tiers` (agent-allowlisted; deliberately does NOT run
  dismissHandledAutoReplyDrafts) + admin "Tier 1 auto-answer" switch
  (`POST /api/inbox/auto-reply/tier1/toggle`; OFF reverts queued tier-1 rows to drafted). Verified:
  guest-question-tier 81/0, full `npm test` exit 0, build clean, `npm run check` 338 = baseline (0 new,
  stash-diffed), bundle-grep confirms chips + switch. Could NOT live-smoke the Guesty/Claude legs (no
  creds) — post-deploy: message a mapped listing something like "does the condo have AC?"; within ~2 min
  the row should show the emerald "Tier 1 · AI answered" chip and the guest gets the Aloha-style reply.
  See AGENTS.md Load-Bearing #24 "TIER-1 EXCEPTION" + the 2026-07-10 Decision Log line.
- 2026-07-10 (guest booking confirmations: representative-photos line + stay specifics + arrival-details
  watchdog + misroute resend + deeper Hawaii voice): Operator asked to research the automated day-of-booking
  messages (confirmation + two-units/representative expectations, Hawaii lingo) and implement all improvements.
  KEY FINDINGS (don't re-chase): the automated confirmation ALREADY existed (server/booking-confirmations.ts,
  5-min scheduler, PR #942) with the two-unit setup + Aloha voice; the gaps were (a) the "photos are
  representative" disclosure was MANUAL-only, (b) nothing enforced the 14-day arrival-details promise, (c) the
  inbox timeline's arrival-step regex false-marked itself sent off the confirmation's own promise text.
  SHIPPED (`claude/guest-booking-confirmations-8cc471`): (1) representative line in BOTH message variants —
  wording "assigned units will match" is LOAD-BEARING (auto-completes the timeline's manual unit-setup step);
  (2) "Your stay at a glance" (dates/nights/confirmation code; the reservations poll now passes explicit
  fields=) + scheduled-balance bullet via pure `scheduledBalanceDueFromReservation` (real Guesty schedule only:
  shouldBePaidAt + isFullyPaid guard (Booking.com totalPaid:0 quirk) + deposit collected + next-row amount ≈
  balance, else OMIT; wording must avoid "remaining balance" — invoice timeline regex); (3) NEW
  GET /api/dashboard/arrival-details-coverage + amber home.tsx popup (pure shared/arrival-details-warning.ts;
  manual rows excluded — no thread to verify; /posts fetched WITHOUT fields= per PR #917; 40-scan cap, 5-min
  cache, localStorage nexstay_arrival_details_warning_dismissed); (4) ONE shared matcher
  `looksLikeArrivalDetailsMessage` (line-anchored Access/Door/Lockbox/Gate/Entry code: or Unit N: labels;
  promises + the zero-unit "still confirming" AD + casual Parking:/Wi-Fi: lines do NOT match) drives both the
  timeline step and the coverage scan; (5) misroute visibility: GET /api/dashboard/booking-confirmation-issues
  (red popup) + POST /api/inbox/booking-confirmations/resend — force-send mirrors receipts #51d (confirmed
  "sent" row 409s; scheduler stays terminal on misroute/pending; storage.updateBookingConfirmation added);
  (6) Hawaii voice: "E komo mai!" + island naming via `hawaiianIslandLabel(resolveIslandRegion(...))`
  (shared/area-identity.ts — generic "Hawaii"/Florida regions render nothing), post-stay templates get
  "Mahalo nui loa" + "A hui hou" (keep "appreciate a review" verbatim — timeline regex). ASCII-clean
  everywhere (Booking.com). Verified: booking-confirmation-message 67/0 + arrival-details-warning 38/0 (new,
  in the npm chain), full `npm test` exit 0, build clean (UI strings bundle-grepped), `npm run check` 338 =
  baseline (0 new). Could NOT live-smoke Guesty sends (no creds) — post-deploy: next new booking gets the
  enriched message; expect the amber arrivals popup on first dashboard load (any <14-day check-in without
  arrival details on its thread raises it — that's the watchdog working, not a bug).
- 2026-07-10 (amenity scan: surrounding-area "nearby" amenities via Claude web search + fully-automatic
  save→push to Guesty): Operator (Amenities-tab screenshot): after the photo scan, auto-save against the
  listing + auto-push to Guesty; and "see why it's not checking off things like shopping nearby — research
  the surrounding area with Claude search." WHY nearby never checked (don't re-chase): the scan only ran
  `AMENITY_VISION_TARGETS` — photos can't prove "Shopping Nearby", and those keys aren't in the baseline.
  SHIPPED (`claude/amenities-scanning-guesty-sync-7cd6e8`): (1) NEW web-search leg — curated
  `AMENITY_LOCATION_TARGETS` (shared/guesty-amenity-catalog.ts; 13 keys incl. SHOPPING/NEAR_RESTAURANTS/
  GOLF/HIKING/NEAR_BEACH, hints carry distance thresholds, DISJOINT from vision targets) + pure
  `buildAmenityLocationResearchPrompt` (same JSON contract → `parseAmenityDetectionJson` parses both legs)
  + `server/amenity-location-research.ts` (`callClaudeWebSearchJson`, `AMENITY_LOCATION_MODEL` default
  claude-sonnet-4-6, ≤6 searches/120s, kill `AMENITY_LOCATION_RESEARCH_DISABLED=1`; confirms an amenity
  ONLY on a NAMED place within the threshold). Runs CONCURRENTLY with vision inside
  `scanAmenitiesForProperty`; unions into the same ADD-ONLY merge; result gains a `location` section the
  tab renders ("🌍 Area research…"). Fail-soft everywhere. (2) AUTOMATION GAP: scan already saved+pushed
  when a listing was MAPPED; unmapped scans (fresh drafts — the screenshot) waited for a manual push
  forever. NEW `autoPushSavedAmenitiesForProperty` (routes.ts) fires fire-and-forget wherever a
  property↔listing mapping is born — builder create (`schedule-sync`), dashboard Connect-to-Guesty
  (`/api/guesty-property-map`), Guesty import (both branches), `sync-now` — pushing the in-system saved
  set add-only via the extracted `pushAmenityKeysToGuestyListing` union helper (2-min cooldown absorbs
  the create flow's double-fire). LOAD-BEARING: the union with the listing's CURRENT Guesty amenities is
  what keeps auto-pushes add-only over push-amenities' PUT-replace; manual "Save to system" deliberately
  does NOT auto-push (the manual Push button stays the exact-replace path that can REMOVE). Bulk-combo
  amenities step inherits both. Verified: amenity-scan-logic 62/0 (33 new incl. source guards on every
  hook), full `npm test` exit 0, build clean (UI strings bundle-grepped), `npm run check` 338 = baseline
  (0 new; git-stash A/B). Could NOT live-smoke web-search/Guesty (no creds) — post-deploy: Scan on the
  Amenities tab → 🌍 line + nearby boxes check; publish a scanned draft → amenities land in Guesty
  with no click. See the AGENTS.md 2026-07-10 Decision Log line.

- 2026-07-10 (market-rate updates: REMOVED the lodging-tax checkout uplift — raw Airbnb median again):
  Operator: the queue + the manual market-rate button scan Airbnb via SearchAPI "and it will then add
  I think 13% more for taxes at check out — remove this 13% or that percentage uplift and update the
  methodology." That uplift was the 2026-07-01 `applyLodgingTaxGrossUp` (HI 18% / FL 12.5% — the
  "~13%" memory) applied in `server/hybrid-pricing.ts` where the SearchAPI median became the stored
  basis. REMOVED (`claude/remove-market-rate-tax-uplift-tt7z5s`, PR #994): the stored `monthlyRates`
  basis is the RAW SearchAPI Airbnb median again (extracted_total_price ÷ nights = rent + cleaning +
  service fees, occupancy tax NOT added); year-2 extrapolation inherits the untaxed year-1 basis (tax
  was never re-applied there); the thin-comp static fallback was never taxed; the 20%
  `MARKET_RATE_TARGET_MARGIN` markup at push time is UNTOUCHED (operator asked only about the tax).
  Scan-note methodology string now reads "raw median — no tax uplift"; client queue/Pricing-tab
  labels never mentioned the tax (verified), so no UI copy change. `LODGING_TAX_PCT` +
  `applyLodgingTaxGrossUp` STAY in shared/pricing-rates.ts SOLELY for the dormant Claude static/all-in
  engine (`STATIC_RATE_ENGINE=1`); `MARKET_RATE_LODGING_TAX_DISABLED` is now a no-op. SOURCE-GUARDED
  in tests/pipeline-logic.test.ts (hybrid-pricing must not reference the gross-up — re-wiring it
  trips the suite). Net ≈ −15% on pushed HI rates (÷1.18) / ≈ −11% FL, effective on each property's
  NEXT push — re-run the dashboard "Update market pricing" queue to apply everywhere. Verified: full
  `npm test` exit 0, build clean, `npm run check` 338 = baseline (0 new). See the AGENTS.md
  2026-07-10 Decision Log line (the 2026-07-01 all-in entry is marked SUPERSEDED, tax half only).

- 2026-07-10 (market-rate queue + Pricing tab: 95%+ "right community & bedroom count" MATCH CONFIRMATION):
  Operator asked for UI on the Pricing tab and/or the dashboard market-rate queue that confirms with
  ~95%+ accuracy that the rates being researched are for the CORRECT community and bedroom count.
  KEY INSIGHT (don't re-chase): the live median engine already persists everything needed per scanned
  month (`monthlyRates[ym].evidence`: exact query, `requestedBedrooms` pin, geo-box kind/radius/widened,
  per-comp tallies incl. exact-bedroom-parsed + coordinate-verified-in-box; wrong-size / out-of-box
  comps are REJECTED before pricing) — so this is a strict deterministic roll-up, no new scanning.
  SHIPPED (`claude/pricing-market-rate-confirm-sfabjv`): pure `shared/market-rate-match-confirmation.ts`
  (`computeMarketRateMatchConfirmation`, 14 scenario tests) renders ONE green/amber/red verdict chip on
  BOTH surfaces — dashboard queue items (server-computed in `runBulkPricingItem` →
  `progress.matchConfirmation` + terminal event metas + an `item-match-review` warn/error event) and
  the Pricing-tab "Research confirmation" block (client-computed from the getLiveBuyIn cache via the
  SAME function; `parseMonthlyRates` widened to keep the comp counters — test-locked, don't strip).
  GREEN only past the 95% bar: all live months geo-boxed to the community (widened/unboxed → amber),
  search label passes `confirmResearchCommunity` (wrong location → RED), every size query-pinned,
  ≥95% of accepted comps independently parsed at the exact size (≥3 comps/size), zero wrong-size
  accepted comps (→ RED), and researched sizes must cover the listing's TRUE unit sizes (miss → RED
  "Wrong bedroom research"). Absence of evidence NEVER reads verified (static/extrapolated months are
  reported, not counted). BONUS: the live engine's recipe now stamps `communityConfirmation` (the
  static engine's guard) so the queue shows "✓ Community confirmed" from the FIRST tick; the evidence
  verdict subsumes it at completion. Display-only — never blocks a push. Verified: new suite green,
  full `npm test` exit 0, build clean (new UI strings bundle-grepped), `npm run check` 338 = baseline
  (0 new). Could NOT live-run a queue (no SearchAPI/DB creds) — post-deploy: run "Update market
  pricing"; each item shows the community chip while scanning + the verdict chip on completion, and
  the Pricing tab gains the same verdict. See AGENTS.md "Market-rate MATCH CONFIRMATION" + the
  2026-07-10 Decision Log line.

- 2026-07-10 (preflight: the Photos-tab "🔎 Check photo community" FULL check + report, on the
  Community Match card): Operator asked for the Photos-tab "check community photos" button ("checks
  all photos for bedroom count, if the units match the community folder etc, it checks a lot") to be
  placed, identically, in the preflight UI. KEY FINDING (don't re-chase): preflight's Community Match
  card (#989) ALREADY ran the full engine — POST /api/builder/photo-community-check `{ propertyId }`
  → server-built hydrated groups (`buildPhotoCommunityCheckRequestForProperty`: photo_labels
  captions/categories, active swap folders, expectedListingBedrooms, per-unit `_source.json`
  sourceUrl; drafts via negative id) → persisted result — the ONLY gap was the card's slim rendering
  (no bedroom coverage / per-photo votes / junk / duplicates / photo counts). SHIPPED
  (`claude/preflight-community-photos-check-2fxyao`): the Photos-tab report block (388 lines)
  EXTRACTED VERBATIM into shared `client/src/components/photo-community-check-report.tsx`
  (`PhotoCommunityCheckReport` + the result mirror types; inline styles — the one `glb-btn` class
  dependency inlined so it renders identically off the builder stylesheet) and BOTH surfaces now
  render that one component. LOAD-BEARING (AGENTS.md #45 new bullet): edit the report in the shared
  component, never re-inline a copy on either surface — source-assertion-locked. Preflight card:
  button renamed to the Photos-tab "🔎 Check photo community", result state switched to the full
  type, "Mark as verified anyway" display state (reset per run; renders only for
  unconfirmed/likely/warn — never a hard fail, same as the Photos tab), and the persisting run now
  invalidates /api/builder/photo-community-status (parity with the Photos tab). The community-only
  "Check photos are correct" card (#991) + its slim types are untouched. Verified:
  photo-community-check 41/0 (11 new wiring assertions), full `npm test` exit 0, build clean,
  `npm run check` 338 = baseline (0 new; touched-file error counts identical pre/post via a
  git-stash A/B). UI verified against the BUILT bundle (static SPA server on dist/public + Playwright
  with mocked engine responses): pass state, mismatch/review state, and the mark-verified click all
  render the full report on /builder/4/preflight. Could NOT live-smoke the Lens/vision legs (no keys
  in session) — post-deploy: open any preflight page and click "🔎 Check photo community"; expect the
  exact Photos-tab report (bedroom x/x + rooms, per-photo votes, source pages, dupes).

- 2026-07-10 (preflight Community Photos: "Check photos are correct" YES/NO button + re-pull renamed):
  Operator asked for a button on the preflight Community Photos card that has Claude vision scan the
  CURRENT community-folder photos and answer plainly in the UI "yes, these are X community / no they're
  not", and to rename "Re-pull community photos" → "Find new community photos" (its real function).
  SHIPPED (`claude/elegant-haibt-cc4fe2`): the EXISTING photo-community-check engine (Google Lens per
  photo + Claude vision — the same community leg the Photos-tab / Community Match checks run) gains a
  `communityOnly: true` mode on POST /api/builder/photo-community-check — the server builds groups from
  propertyId as usual, then narrows to the community group via pure `communityOnlyCheckRequest`
  (shared/photo-community-check-logic.ts; also DROPS expectedListingBedrooms so a community-only run
  doesn't demand the ANTHROPIC key — bedroom coverage is a unit-leg concern). LOAD-BEARING: a
  community-only result is NOT persisted (`propertyId != null && !communityOnly` guard before
  savePhotoCommunityCheckResult) — it has no unit legs, so persisting would overwrite the dashboard
  Community QA status (derived from FULL checks) with a units-free "pass". UI (builder-preflight.tsx):
  new "Check photos are correct" button beside the renamed "Find new community photos" on the Community
  Photos card; the verdict renders via pure `communityPhotosCorrectAnswer` — green "YES — the photos in
  this folder are of X" / red "NO — these photos appear to be Y, not X" (alias-safe: an identified name
  that alias-matches the expected community never renders a self-contradicting "X, not X") / amber
  review — plus identified-as, N of M photos checked, and a flagged-photo list (the synthetic
  "pre-screen" dHash outlier is filtered from that list). Engine pass-summary for a 0-unit run no longer
  claims "unit photos" match. Verified: photo-community-check 30/0 (incl. source assertions on the
  routes guard + the rename), full `npm test` exit 0, build clean, `npm run check` 338 = baseline
  (0 new); UI verified against the BUILT bundle (static SPA server on dist/public + mocked engine
  responses — YES, NO, and error states all render). Could NOT live-smoke the Lens/vision legs (no keys
  in session) — post-deploy: open any preflight page and click "Check photos are correct".

- 2026-07-10 ("Check photo community" → also verify each unit's SOURCE PAGE, not just its photos):
  Operator asked for a button (already exists: "🔎 Check photo community" on the Photos tab) that
  confirms Unit A + Unit B are in the same community as the community folder by scanning their photos
  AND their source listing page with Claude, with clear yes/yes UI, and automated in the add-combo
  tool. SHIPPED (`claude/unit-community-verify-button-7945me`): the photo legs (Google Lens on the
  community folder + Claude vision per unit) already existed; this adds an INDEPENDENT source-page leg.
  (1) pure `shared/source-page-community-logic.ts` (39 tests: HTML → title/meta/OpenGraph/JSON-LD
  address/snippet extraction, Claude prompt, verdict parse w/ self-contradiction downgrade, tolerant
  name match, `sourcePageIsStrongContradiction`, roll-up). (2) `server/source-page-community-check.ts`
  `verifyUnitSourcePages` — bounded fail-open page fetch + one Claude JSON call per unit's source URL
  (`SOURCE_PAGE_COMMUNITY_MODEL`, default claude-sonnet-4-6); Guesty/auth-gated/JS-only/blocked pages →
  "uncertain" (never a false "no"), never throws. Kill switch `SOURCE_PAGE_COMMUNITY_CHECK_DISABLED=1`.
  (3) `runPhotoCommunityCheck` gains `sourceUrl?` per unit group + `sourcePages[]` on the result; a
  POSITIVE different-community source page contributes a fail, else warn/info. (4) source URLs resolved
  from each folder's `_source.json`: server `readFolderSourceUrl` in builder-photo-groups.ts (unit
  groups only) + client passes `sourceUrlsByFolder`. (5) UI: each roster row now shows TWO badges —
  Photos ✓ and Source page ✓ vs the community folder — plus a "Source page check" card (per-unit
  verdict, 📍 location, source link). (6) combo gate: `ComboPhotoGateInput.sourcePages` +
  `sourcePageContradictionReasons` skip leg (strong contradiction only; unreadable/no-URL fail-open;
  also blocks the bedroom-retry); wired into `runBulkComboListingItem`, disable with
  `COMBO_SOURCE_PAGE_GATE=0`. LOAD-BEARING: mirrors the 2026-06-26/07-08 posture — a source page only
  SKIPS on a POSITIVE different-community finding, never on absence of proof, so a legit resort whose
  page can't be read still publishes. Verified: source-page-community 39/0, full `npm test` exit 0,
  build clean, `npm run check` 338 = baseline (0 new). Could NOT live-smoke the Claude/fetch legs (no
  key) — post-deploy: click "Check photo community"; each unit shows a Photos + Source page badge.

- 2026-07-09 (amenities tab: photo-driven amenity scan → auto-fill + Guesty sync + combo step): Operator
  asked for a button that scans the community folder + ALL units' photos, adds amenities to the amenities
  tab, syncs to Guesty if the listing exists (else save in-system), fills out ALL amenities where
  available, and to add this step to the add-combo-listing function. TWO clarifying decisions FIRST:
  ADD-ONLY (never uncheck — "not visible in a photo" doesn't prove absence) + BASELINE + DETECTED (fresh
  listing starts from the Hawaii baseline, then adds detected; an existing curated selection only GAINS
  extras). SHIPPED (`claude/amenity-photo-scan`): (1) MOVED the amenity catalog + `HAWAII_BASE` to
  `shared/guesty-amenity-catalog.ts` (server+client single source; client re-exports + keeps the
  per-property profile map) + a curated `AMENITY_VISION_TARGETS` (~70 visually-detectable keys w/ hints);
  catalog/baseline/profiles proven byte-identical. (2) pure `shared/amenity-scan-logic.ts` (prompt/parse/
  add-only merge, 29 tests). (3) `server/amenity-scan.ts` `scanAmenitiesForProperty(propertyId)` — resolves
  folders via the SAME `buildPhotoCommunityCheckRequestForProperty` (positive core id AND negative
  `-draftId`), batched Claude vision (`claude-sonnet-4-6`), fail-soft (no key/photos → still fills baseline).
  (4) NEW `property_amenities` table (propertyId PK; FIRST durable home for amenity data — before this it
  was a static client map with NO persistence) + storage upsert + boot-migration. (5) routes
  `POST /api/builder/scan-amenities` (persist + Guesty sync), `/save-amenities`, `GET /property-amenities`.
  (6) Amenities tab: "🔎 Scan photos for amenities" + result panel + "💾 Save to system"; hydrates from the
  store. (7) bulk add-combo-listing: fail-soft `"amenities"` step on fresh drafts (`COMBO_AMENITY_SCAN=0`;
  never rolls back the draft). LOAD-BEARING (review fix): the Guesty sync is ADD-ONLY despite
  `push-amenities` being a full PUT-replace — the scan route UNIONS the scanned set with the listing's
  CURRENT Guesty amenities before pushing, so a Guesty-curated amenity is never dropped. Reviewed via a
  3-lens adversarial workflow (3 fixes: add-only Guesty union; savePropertyAmenities preserving scan
  provenance on a manual save; evenSampleIndices NaN-at-cap-1 guard). Verified: amenity-scan-logic 29/0,
  full `npm test` exit 0, build clean, `npm run check` 338 = baseline (0 new). Could NOT live-smoke the
  Claude-vision/Guesty legs (no creds) — post-deploy: open the Amenities tab, click Scan; a fresh combo
  draft auto-fills its amenities. See AGENTS.md 2026-07-09 Decision Log.

- 2026-07-09 (FOLLOW-UP: split guest issues → property vs Back-Office Issues tab): Operator, after the
  retroactive scan: "only genuine property-related issues / directions in [Guest Issues]; do NOT put
  refund requests here — make a Back-Office Issues tab with refund + cancellation requests." SHIPPED
  (`claude/back-office-issues-tab`): a `guest_issues.kind` column (`property` | `back_office`, default
  property; schema.ts + schema-maintenance ALTER-on-boot + a one-time re-classification of existing auto
  rows by title/desc). KIND is DERIVED from the complaint category (`complaintKindForCategory` in
  `shared/guest-complaint-logic.ts`) — billing (refund/overcharge/chargeback) + a NEW `cancellation`
  category → back_office; everything else → property. The Claude classifier scope widened past "something
  wrong" to also flag refund/cancellation REQUESTS, and dedup is now kind-aware (a refund can't fold into
  a maintenance issue). UI: one `GuestIssuesTab` parameterized by `kind`; new "Back-Office Issues" inbox
  tab (DollarSign icon) beside "Guest Issues"; `GET /api/inbox/guest-issues?kind=`; inbox splits the
  unresolved count into two tab badges; per-issue indigo "Back-office" chip. The "Scan for complaints"
  button stays only on the property tab (one sweep fills both). Verified: guest-complaint-logic 16/0,
  guest-issue-logic kind guards, full `npm test` exit 0, build clean, `npm run check` 338 = baseline.

- 2026-07-09 (FOLLOW-UP: Guesty `/communication/conversations` now 400s on `skip` — broke the complaint
  scanner AND auto-reply): Operator asked to run the retroactive scan; it created 0 issues. LIVE-DIAGNOSED
  (ADMIN_SECRET API + Railway logs, via `railway run` to keep the secret out of logs): the scanner status
  showed `backfillComplete:true, conversations:0, errors:1`, and the logs revealed
  `[guesty-error] … /communication/conversations?…&skip=0… → 400: "skip" is not allowed` PLUS
  `[auto-reply] Top-level error: … "skip" is not allowed` — Guesty removed `skip` support, silently
  breaking BOTH the new scanner's pagination and auto-reply's inbox poll (2026-05-04-class outage). Its
  cursor is ALSO unreliable on this endpoint (every `cursor[after]`/`cursor=`/`after=` variant returned an
  empty page in live probing), but a large `limit` returns the whole inbox in one request (verified:
  `limit=150`→all 113 conversations). FIX (`claude/guest-complaint-pagination-fix`): dropped skip-paging in
  BOTH `server/guest-complaint-scanner.ts` and `server/auto-reply.ts` `fetchOpenConversations` — single
  `limit=500` fetch (`GUEST_COMPLAINT_CONV_FETCH_LIMIT`/`AUTO_REPLY_CONV_SCAN_MAX`), ordered in-process;
  scanner backfill resumes by COUNT over a stable createdAt-ascending order and a fetch THROW leaves state
  untouched (a transient Guesty error can no longer falsely "complete" the backfill — the second bug that
  made it scan nothing). Also fixed my own false-complete-on-empty-page bug. `backfillSkip`→`backfillDoneCount`.
  NOTE: the other conversation fetches (`quo-sms`, the inbox list route, `guesty-ota-messaging`) never used
  `skip` (they cap at `limit=100`) so were unaffected — but they DO silently cap the inbox at 100. Verified:
  guest-complaint-logic 12/0, full `npm test` exit 0, build clean, `npm run check` 338 = baseline; then LIVE
  post-deploy — `POST /api/inbox/complaint-scan/run {full:true}` scanned all conversations and opened
  Auto-detected issues.

- 2026-07-09 (guest inbox: AUTOMATIC complaint scanner → guest-issue tracker): Operator asked to make
  the guest inbox scannable — detect a guest complaint, decide if it's already a complaint in the
  system (if so add timestamped notes; else create it as a task), scan the whole inbox ONCE then every
  new incoming message. KEY: the app ALREADY has the exact data model — the guest-issue tracker
  (`guest_issues` = complaint/task, `guest_issue_comments` = timestamped note, open→ongoing→resolved,
  per-conversation `GuestIssuesPanel` + cross-conversation `GuestIssuesTab`, routes `/api/inbox/guest-issues*`).
  So this is PURELY an auto-detection layer, no new tables/UI framework. SHIPPED (`claude/guest-complaint-scanner`):
  (1) pure `shared/guest-complaint-logic.ts` (unit-tested, in npm chain) — complaint keyword/heuristic
  gate (plural-tolerant, COMPLAINT-shaped so it ignores logistics/policy questions), Claude-JSON
  classification parse, `matchExistingComplaintIssue` (dedup vs UNRESOLVED same-category, category
  INFERRED from issue title/desc since guest_issues has no category column), a `[msg:<postIso>]`
  idempotency marker, note/title builders, scan-state (de)serialize. (2) `server/guest-complaint-scanner.ts`
  (5-min scheduler, modeled on guest-receipts, registered in index.ts) — two-phase: one-time BACKFILL
  (pages the whole inbox ASCENDING/stable, `GUEST_COMPLAINT_BACKFILL_DAYS`=365) → INCREMENTAL past a
  persisted `app_settings` watermark (`guest_complaint_scan.state`); per incoming guest post: keyword
  gate → Claude(Haiku `GUEST_COMPLAINT_MODEL`) confirm+classify (heuristic fallback w/ no key) → append
  a timestamped note to the matching unresolved issue OR open a new one. Auto rows attributed
  `auto-scan`/`system` → violet "Auto-detected" badge + friendly `authorLabel`. Internal-only (never
  messages the guest). (3) admin-only endpoints `/api/inbox/complaint-scan/{run,status,toggle}` (NOT in
  the agent allowlist + re-checked role==="admin"; auth-off resolves to admin) + a "Scan for complaints"
  button in the Guest Issues tab (`canDelete`/admin gated). LOAD-BEARING (see AGENTS.md "Guest issues
  tracker" point 6): the message marker makes re-scans / crash-replays / the `{full:true}` manual
  rescan idempotent (no dup issues/notes, no dedup table); the incremental watermark advances over a
  CONTIGUOUS oldest-first prefix and, when the per-run cap truncates a burst, only to the last
  fully-processed thread — a newest-first jump-to-now would leave a middle GAP of skipped fresh threads
  (caught in adversarial self-review). Verified: guest-complaint-logic 12/0, full `npm test` exit 0,
  build clean, `npm run check` 338 = baseline (0 new); bundle-grep confirms the scan button + badge.
  Could NOT live-smoke Guesty/Claude (no creds; don't boot prod schedulers locally) — post-deploy the
  scanner backfills over a few ticks, then a complaint message opens/updates an "Auto-detected" issue.

- 2026-07-08 (bulk-combo "many listings: Photo/Zillow step failed … missing-source-url, no-photos,
  too-few-distinct-photos:0 … no combination type produced two independently-photographed units
  (tried 2BR+2BR)"): DIAGNOSED live (ADMIN_SECRET API + the scrape tiers directly — no combo job
  needed). Infra HEALTHY: SearchAPI returns the right Zillow/Redfin for-sale URLs, Apify runs &
  succeeds (3.5/29 USD), Zillow scrapes fine (live Island Colony unit → 15 photos), Redfin returns
  FULL galleries for ACTIVE listings (Kiahuna/Turtle Bay units → 24–30). Two failure classes: (a)
  GENUINE SCARCITY (not a bug) — 1BR/studio-dominant buildings (Island Colony, Kepuhi/Kaluakoi
  Molokai), leasehold Kona condotels (Country Club Villas/Kona Pacific = the documented 0-portal-hit
  class), non-resort Kaneohe residential (Aikahi Gardens); no 2BR+ for-sale gallery exists, correctly
  skipped with the "Add a manual community" message. (b) THE FIXED BUG — discovery (#742) surfaces
  SOLD + active listings mixed; Redfin SOLD rows are stripped to ~1 og:image (Apify agrees, gallery
  genuinely gone) and often score at/above the active listing, and the `/api/community/fetch-unit-photos`
  discovery loop returned on the FIRST candidate with >=1 photo (`if (photos.length === 0) continue`),
  so a 1-photo sold row SHORT-CIRCUITED discovery before reaching an ACTIVE listing with a full 20+
  gallery LATER in the same pool → combo failed. PROVEN: Ocean Villas at Turtle Bay returned 1 photo
  one run, 24 (active unit-12) the next, purely on ordering. FIX (`claude/combo-photo-best-gallery`,
  PR #964, discovery loop only): a bedroom-matched candidate under MIN_INDEPENDENT_UNIT_PHOTOS no longer
  short-circuits — held as `bestThinMatch` while the loop scans on for a >= MIN gallery, returned only
  if the whole pool has none (preserves the old best-thin outcome for gallery-less resorts → proof
  still rejects → correct skip). `bestThinMatch` returns BEFORE the >=3BR representative/configured
  fallbacks (bedroom-EXACT still beats a wrong-BR representative — no >=3BR wizard change), and the
  UNBOUNDED add-community path gained a 130s wall budget so the extra scanning can't hit the 180s
  client timeout and surface as ZERO photos. DESCOPED (no current benefit): widening the Redfin/Homes
  rescue trigger `=== 0` → `< MIN`; the ≤1-photo Redfin cases are genuinely sold/stripped (Apify also
  ≤1). Reviewed via a 3-lens adversarial workflow (both real findings fixed). DO NOT "simplify" the
  scan-past-thin back to first-hit — it reintroduces this bug. Verified: full `npm test` exit 0,
  `npm run check` 338 = baseline, build clean; POST-DEPLOY smoked — Ocean Villas at Turtle Bay now
  reliably returns its 24-photo gallery; Coconut Plantation (all sold/stripped) scans all 6 →
  best-thin → correct skip. AGENTS.md Decision Log 2026-07-08.

- 2026-07-07 (bulk-combo STILL deleting every fresh draft — "added Wavecrest 2BR+2BR but nothing on
  the dashboard"): The EXACT symptom #951 (2026-07-06) claimed to fix, recurring — item "Completed"
  but message `Skipped — photo check: Unit A (2BR) shows only 0/2 bedrooms … Unit B 0/2`, no draft.
  DIAGNOSED live (ADMIN_SECRET API, DB URL not reachable this session): job `bcj_mrau4net_skfeia`
  skipped Wavecrest (34+16 photos → 0/2+0/2) AND Molokai Shores (16+36 → 0/1+0/2); the event log shows
  `persist` "completed" in 0.8s and the photo-community gate starting 65ms later. ROOT CAUSE — the #951
  fix was INCOMPLETE: `queueMissingPhotoLabels` is FIRE-AND-FORGET (a `void (async …)()` loop, ~1.4s +
  a Claude vision call per photo, returns after merely QUEUING), so #951's claim that `persist-photos`
  "already awaited" it is FALSE. The hydrated `buildPhotoCommunityCheckRequestForProperty(-draftId)`
  path therefore read an EMPTY `photo_labels` table; the bedroom-coverage engine selects bedroom
  candidates BY caption/category at EVERY mode (no caption-free fallback), found zero, reported 0/N for
  every unit, and the gate `deleteCommunityDraft`'d each draft. PROVEN: the rolled-back folders draft-67
  (Wavecrest) + draft-68 (Molokai Shores) NOW carry full `Bedrooms`-category labels (5/4 and 1/4),
  written by the background labeler MINUTES after the gate had already deleted them; #951's A/B on draft
  46 passed only because 46 was already published (labels long since written). FIX (this branch): the
  gate calls new `waitForFolderPhotoLabels(folder)` (bounded 240s/folder, polls `getPhotoLabelsByFolder`
  until every on-disk file is labeled), overlapped with the community-photo persist, BEFORE building the
  request; and passes `bedroomCoverageReliable = allLabelsReady` to `evaluateComboPhotoCommunityGate`
  (shared/combo-photo-community-gate.ts) so a 0/N from unwritten labels (timeout / no ANTHROPIC key /
  vision failures) is INFRA → never skips (community + unit-vision legs, which need no labels, still skip
  on a real mismatch). `"photo-community"` step timeout 6→10 min for headroom (a timeout there is already
  publish, never skip). Verified: `combo-photo-community-gate` suite green (new tests lock the exact live
  0/N signature → publish, reliable-true short-count → still skip, + source guards on the wait/flag),
  full `npm test` exit 0, `npm run check` 338 = baseline (0 new), build clean. Could NOT live-run the
  queue (booting the server here drives prod schedulers per the note below) — post-deploy, re-queue a
  previously-skipped Molokai/Kona resort and confirm it saves + appears. Drafts already lost to this bug
  (folders + labels on disk, DB row deleted) recover by simply re-running the queue for those resorts.

- 2026-07-07 (header Hawaii clock): Operator asked for a simple, nice-looking clock showing Hawaii
  time + date + weekday locked into the header by the logo, so he always knows the guests' local
  time. SHIPPED: pure `shared/hawaii-time.ts` (`hawaiiClockParts` — Intl with Pacific/Honolulu +
  a fixed UTC-10 offset fallback, correct because HST has never observed DST; U+202F meridiem
  space normalized; 22 tests) + `client/src/components/HawaiiClock.tsx` (leaf component, 1s tick)
  mounted in AppHeader TWICE: a two-line pill immediately right of the logo (>= sm) and a one-line
  strip under the header row on phones (the xs row has no spare width — hiding the clock on mobile
  would defeat its purpose). AppHeader's load-bearing `&fields=` conversations query untouched.
  Verified: hawaii-time 22/0 (added to the npm test chain), full `npm test` exit 0, build clean,
  `npm run check` 338 = baseline; both variants screenshotted against the BUILT bundle via a
  static `python3 -m http.server` on `dist/public` — do NOT `npm run dev` locally just for a UI
  check (server/index.ts boots the schedulers/watchdogs, incl. auto-ON guest receipts, against
  whatever DATABASE_URL the local .env holds).

- 2026-07-06 (bulk-combo drafts NOT showing on the dashboard — every fresh combo silently deleted):
  Operator: "I just added a lot of properties via the queue for the add bulk combo listing and none
  of them are showing on the dashboard." DIAGNOSED live (ADMIN_SECRET API + DATABASE_PUBLIC_URL psql,
  Railway logs too noisy — sidecar-poll flood): today's 3 bulk-combo jobs reported 17 "completed"
  items but `community_drafts` had ZERO new rows (max id still 46 from Jun 18). Every "completed" item
  was a SILENT SKIP — `Skipped — photo check: Unit A shows only 0/N bedrooms … Unit B 0/N` — uniformly
  0/N for EVERY unit even though items carried 30/24 scraped photos + valid Redfin URLs (the 5 `failed`
  items = genuine "no for-sale listings found" Kona scarcity, separate). ROOT CAUSE: the photo-community
  GATE (`runBulkComboListingItem`, server/routes.ts) fed `runPhotoCommunityCheck` FOLDER-ONLY groups
  (no captions/categories), but the bedroom-coverage engine (`server/bedroom-coverage-engine.ts`
  `matchesBedroomMode`) picks candidate bedroom photos BY caption/category — with none it selected ZERO
  → `bedroomsFound:0` → `matchesListing:"no"` → the gate rolled back (`deleteCommunityDraft`) every
  fresh draft. PROVED via a live A/B on published draft 46: folder-only groups → 0/2+0/2 FAIL vs the
  hydrated `propertyId=-46` path → 2/2+2/2 PASS; the rolled-back combos (draft-47…56) still had proper
  `photo_labels` with a `Bedrooms` category on disk, confirming labels existed and only the gate
  discarded them. FIX: the gate now builds groups via `buildPhotoCommunityCheckRequestForProperty(-draftId)`
  (the SAME photo_labels-hydrated path the pricing-tab check uses) — `persist-photos` already awaits
  `queueMissingPhotoLabels` + sets `unit1/2PhotoFolder` before the gate, so labels + folders resolve the
  same `draft-<id>-unit-a/b` folders WITH captions. Bed-TYPE inventory stays ignored (predicate only
  skips on bedroom COUNT + real community mismatch) so hydration can't reintroduce a bed-type nitpick.
  REPLACES the 2026-06-26 "folder-only groups" constraint (AGENTS.md combo-gate #3 + Decision Log).
  Verified: combo-photo-community-gate suite + new source guard green, full `npm test` exit 0, `npm run
  check` 338 = baseline (0 new), build clean. NOTE: this only un-blocks the FALSE 0/N skips — a resort
  with genuinely too few bedroom photos, or no for-sale listings to source at all, still legitimately
  skips/fails.

- 2026-07-06 (cowork buy-in prompt: LOSS-triggered city-wide rollback): Operator — "the cowork prompt
  tries same-community units first; if that only yields LOSS-making results, roll back to a city-wide
  search for two units of that bedroom size in the same community." Confirmed 2 decisions first:
  loss = the app's standing $100 max-loss cap (`DEFAULT_PROFIT_MIN_FLAT_USD`, shared/buy-in-profit.ts),
  rollback scope = a SAME-COMPLEX pair from the city scan. SHIPPED (`claude/recursing-fermi-50f5d8`):
  `buildCoworkBuyInPrompt` (shared/cowork-buyin-prompt.ts) gained an optional `netRevenue` input + a
  "## Profit guard" section — when net revenue is known, loss = (combined all-in pick cost) − netRevenue
  > $100; the city-wide rung now fires on COVERAGE **or** a >$100 loss (was coverage-only); the rollback
  hunts same-bedroom units in the SAME complex; rung 3 attaches the cheapest option anyway + FLAGS the
  loss loudly when even the whole city can't beat the cap (never leave a guest slot empty); the report +
  done-signal carry the profit math + which branch applied. LOAD-BEARING: the CLIENT
  (CoworkBuyInPromptButton) passes REMAINING net revenue — `getNetRevenue(reservation)` MINUS
  already-attached slot cost — because the button fills only the EMPTY slots (`units = slots.filter(!s.buyIn)`);
  the full net revenue would inflate the budget on a partially-filled combo (mirrors bookings.tsx's
  `remainingBudget = getNetRevenue − existingCost`). Unknown/<=0 net revenue disables the guard →
  guard-off output is BYTE-IDENTICAL to the pre-2026-07-06 prompt (degrade-safe, mirrors buy-in-profit.ts).
  Built + reviewed via a 3-lens adversarial workflow (1 MAJOR budget-basis bug caught + fixed; 2 cosmetics
  folded in; invariants intact: never-mention-card, never-attach-airbnb, STOP-at-city-wide, 409
  same-complex-only). Verified: cowork-buyin-prompt 209/0 (14 new), full `npm test` exit 0, build clean,
  `npm run check` 338 = baseline (0 new).

- 2026-07-06 ("Text failed / 500: Failed to send SMS" — but the guest GOT the text): Operator
  screenshot of the inbox Send Text button failing. LIVE DIAGNOSIS (Railway GraphQL logs +
  OpenPhone API + X-Admin-Secret probes): the text to Thien Tran was DELIVERED at 15:48:53Z;
  the 500 came AFTER the send, from `storage.createQuoSmsMessage` — the Dockerfile CMD runs
  `db:push` on EVERY boot and drizzle-kit DROPS any UNIQUE constraint `shared/schema.ts`
  doesn't declare, so `quo_sms_messages.provider_message_id` lost its UNIQUE and every
  onConflictDoUpdate insert failed ("no unique or exclusion constraint matching the ON
  CONFLICT specification"). quo_call_events never broke the same way ONLY because it has a
  separate CREATE UNIQUE INDEX IF NOT EXISTS boot heal. FIXES: `.unique(<boot-heal index
  name>)` declared in schema.ts for quo_sms_messages.provider_message_id +
  quo_call_events.provider_call_id + guest_phone_overrides.conversation_id (names match so
  push sees no diff); matching guarded CREATE UNIQUE INDEX boot heals added to
  schema-maintenance; `sendQuoSms` no longer bubbles a post-delivery mirror-insert failure
  as a send failure (logs loudly, returns synthetic row — prevents operator-retry
  double-texting); both SMS send routes now console.error the real cause; client
  `throwIfResNotOk` shows "error — message" so toasts carry the underlying reason. OPERATOR
  TODO: `QUO_WEBHOOK_SECRET` is unset on Railway → inbound Quo webhooks 500 and guest
  text/MMS replies are NOT mirrored into the inbox; set it + configure the OpenPhone webhook.
  Verified: full `npm test` exit 0 (repointed one pre-existing drifted #936 source assertion
  in listing-photo-resolution), build clean, `npm run check` 338 = baseline.

- 2026-07-06 (alias-inbox emails rendering as RAW MIME source — Generali/Thien Tran screenshot):
  Operator screenshot showed an inbound email on the Operations alias-inbox panel rendering as raw
  MIME: the inner boundary line ("------=_Part_1_…"), Content-Type/Content-Transfer-Encoding part
  headers, and raw `<html>` tags. ROOT CAUSE (two stacked): (a) `extractBodyFromRawEmail` regex-
  tested whole TOP-LEVEL multipart parts for "content-type: text/plain", so a NESTED
  multipart/alternative wrapper (inside multipart/mixed) matched via its inner part's header text
  and everything after the wrapper's first blank line — inner boundary + headers included — was
  stored as the body; (b) the Generali email declares that part text/plain while shipping a full
  Aspose-generated HTML document, so no tag-stripping ran. FIX: MIME extraction moved to pure
  browser-safe `shared/email-mime.ts` (`extractReadableTextFromMimeEmail`) — real multipart walk
  (per-part headers, recursion into nested multiparts depth ≤6, attachment-disposition parts
  skipped, numeric character references &#xa0;/&#8217; decoded) + `looksLikeHtmlContent` so a
  mislabeled text/plain part with `<html`/`<body` markers gets stripHtml'd; genuinely-plain parts
  still win over HTML. Server `server/guest-inbox-sync.ts` delegates to it (buy-in-email-sync
  inherits), `parseEmailHeaders` re-exported for existing importers/tests. STORED rows are immutable
  — `extractReadableFromStoredMimeBody` in shared/email-body-format.ts heals them at DISPLAY time
  (fires only when the first non-blank line is a boundary delimiter AND a Content-Type header
  follows; wraps the fragment in a synthetic multipart header and reuses the same walk), wired into
  `formatEmailBodyForDisplay` ahead of the legacy clump-reflow — so the live Thien Tran row renders
  readable on next load, no re-import. Dedup unaffected (real Message-ID keys; surrogate only for
  id-less mail). Verified: guest-inbox-sync + email-body-format + buy-in-email-sync +
  arrival-email-extraction suites green, full `npm test` exit 0, build clean, `npm run check` 338 =
  baseline.
- 2026-07-06 (FOLLOW-UP: /guest-photo signed upscaling proxy — PM-site originals really upscaled):
  Operator screenshot: Unit B (VRBO, rw=1200 rewrite) sharp, Unit A (waikikibeachrentals.com,
  genuine 418x270 originals — no larger variant exists) unchanged. SHIPPED the real-upscale leg:
  `GET /guest-photo` (server/guest-photo-upscale.ts + pure shared/guest-photo-proxy.ts, 23 tests) —
  the /alternatives renderer routes external non-VRBO-family photos through it at RENDER time
  (existing pages heal; VRBO/trvl-media bypass; relative /photos/ untouched). Endpoint: HMAC sig
  (GUEST_PHOTO_SIGN_KEY || ADMIN_SECRET) + SSRF host guard even with valid sig → fetch (12s/25MB,
  browser UA) → sharp probe → >=900px wide streams ORIGINAL bytes untouched; smaller → lanczos3 to
  1200w + unsharp + JPEG q82; LRU 80 + 7d immutable cache; ANY failure 302s to the source (never a
  broken guest image). Smoked locally: 418x270→1200x775, 1ms cached, 404 bad sig, 404 signed
  169.254.169.254, 302 on missing source, 2738px passthrough untouched. Classical interpolation +
  sharpening by DESIGN, not generative SR (no invented detail, no storage pipeline — recomputed on
  demand, deploy-safe). "/guest-photo" added to auth PUBLIC_PATH_EXACT (see AGENTS.md Decision Log
  + the inline NOTE in server/auth.ts). Verified: 23/0 new, full `npm test` exit 0, build clean,
  `npm run check` 338 = baseline.
- 2026-07-06 (find→commit photo pass-through — "two units still can't find replacements", part 2):
  Both re-runs FOUND units under the sidecar rescue but died at commit: the re-scrape hit Apify 403 +
  ScrapingBee MONTHLY QUOTA EXHAUSTED (1000/1000) + a 0-photo sidecar run at once, while the find
  phase had 40 photos in hand minutes earlier; the all-burned message then lied ("already used by
  another listing"). SHIPPED: POST /api/unit-swaps accepts optional photoUrls (find-phase gallery,
  stripped pre-parse, capped 120) and hydrateUnitSwapPhotoFolder falls back to them when the fresh
  re-scrape returns 0 — both callers (orchestrator c.photos[], UnitReplacementFlow result.photos)
  send them, so a find-proven gallery can never be lost at commit; the orchestrator's all-burned
  error now reports real burn reasons (N already used; M gallery unscrapeable). NOTE: ScrapingBee's
  monthly quota is exhausted — Zillow scrapes ride Apify+sidecar until reset. auto-replace-job 58/0.


- 2026-07-06 (guest-page photo SHARPNESS — CDN full-res, not AI upscaling): Operator asked whether
  scraped unit photos can be upscaled to look sharp. GROUND TRUTH (live Thien Tran page): the VRBO
  photos were OUR OWN fault — the sidecar harvest captures srcset THUMBNAILS
  (media.vrbo.com …?impolicy=resizecrop&rw=297) while the CDN serves the identical photo at
  2738x1825; the PM-site photos (waikikibeachrentals) are genuinely 418x270 with no larger variant
  published. SHIPPED: pure `shared/listing-photo-resolution.ts`
  (`upgradeListingPhotoUrlResolution`, 17 tests) rewrites verified-CDN thumbnail URLs to rw=1200
  (VRBO/Expedia trvl-media family ONLY — deliberately no invented variants on unverified hosts,
  which could 404 on a guest page; relative /photos/ + unknown hosts pass through; never
  downgrades). Wired at BOTH chokepoints in routes.ts: `safeGuestPhotoUrl` (GET — every EXISTING
  page self-heals at render, pure string rewrite, no latency) and page-build hydration post-vision
  + `pageCommunityPhotos` (new pages persist high-res). Dedupe unaffected (normalizeVrboPhotoKey
  strips the query). TRUE AI super-resolution for the genuinely-tiny PM photos was assessed and
  deliberately NOT built (needs download→upscale→store/serve infra and invents detail on a
  guest-facing page) — operator can ask if wanted.

- 2026-07-06 (FOLLOW-UP: same-community detection WITHOUT verdicts + guest-page fixes — Thien Tran /
  Ilikai live incident): Operator screenshot of a live /alternatives page showed the DIFFERENT-community
  copy ("1-minute drive from your old community") for two units in the SAME BUILDING (1777 Ala Moana
  Blvd #1834 + bare), plus Unit A stuck on "Photos are still being gathered" and a lowball "Sleeps 4"
  chip for a party of 6. DIAGNOSED FROM THE LIVE PAYLOAD (booking_alternative_pages via
  DATABASE_PUBLIC_URL psql, token b0adb0b5…): (a) the buy-ins had NO communityVerdict stamps and the
  "original community" was the raw Guesty LISTING TITLE ("Ilikai - 4BR Condos - Sleeps 12") leaking
  through the client slot fallback → name match failed → sameCommunity:false persisted, and geocoding
  the two labels for the same place minted the absurd 1-min drive; (b) Unit A's URL is a PM direct
  site (waikikibeachrentals.com) with no photo marker in the Cowork notes → the VRBO-only scrape never
  ran (photoSource "none"); (c) Unit A sleeps=null so the "total" sleeps was just Unit B's 4. FIXES
  (shared/relocation-scenario.ts + routes.ts, 82 tests): `stripListingTitleCruftFromCommunityLabel`
  (labels sanitized at POST + GET), `sameCommunityLabelMatch` (generic-word-stripped EXACT token
  equality — "Ilikai" vs "Ilikai resort" matches; bare city "Princeville" can NEVER match
  "Princeville Kamalii" — no subset matching), `sameBuildingFromAddresses` (all units resolve to the
  same numbered street root → SAME BUILDING, no verdict needed). sameCommunity now = verdict flag OR
  address proof OR label match, with the operator-verified "different" verdict as the ONLY binding
  veto (persisted as payload.sameCommunityVeto; a persisted sameCommunity:false WITHOUT the veto is a
  computation miss and the GET renderer self-heals old pages from the same signals — the live Thien
  page fixes itself on next load, no regenerate needed for the copy). Same-building pages/messages
  also drop the "N-minute walk between units" line/chip; the drive chip is gone whenever same
  community. Combined "Sleeps N" (chip + message + fit claim) now only renders when EVERY unit has a
  sleeps value — partial sums undercount and read as "too small for your party". Unit A photo fix:
  page-build hydration falls back to the host-agnostic `scrapeListingGalleryViaSidecar` (operator
  home-IP Chrome, 90s budget, kill SIDECAR_GALLERY_SCRAPE_ENABLED=0) when a unit has 0 photos and a
  non-VRBO URL → photoSource "sidecar-gallery"; EXISTING pages need a regenerate (Guest page /
  Alternative Unit button) to pick up photos. Also: guest-visible carousel alt text no longer uses the
  raw listing title (it carried "5 nights x $279" pricing cruft). Verified: relocation-scenario 82/0,
  full `npm test` exit 0, build clean, `npm run check` 338 = baseline.

- 2026-07-06 (Alternative Unit button: SAME-COMMUNITY bedroom-downgrade messaging): Operator's case —
  6 guests booked a 4BR listing (2x2BR); only a 2BR + 1BR could be sourced, but in the SAME community.
  The relocation message/page wrongly framed that as a community move. SHIPPED: pure
  `shared/relocation-scenario.ts` (57 tests) — verdict consensus over the attached buy-ins'
  `communityVerdict` columns (any missing/"different" verdict → no same-community claim; explicit
  "different" VETOES the server's name-match inference), `bedroomsFromListingTitleText` (honest
  per-unit bedrooms from the listing title; slot config = what the guest BOOKED stays the fallback),
  and `buildSameCommunityRelocationLines` (ASCII; "will fit your party comfortably" only when
  totalSleeps >= partySize). Client sends sameCommunity/sameBuilding + originalBedrooms (slot-config
  sum) + partySize (`guestPartyFromReservation`) from BOTH the Alternative Unit dialog and the Guest
  page button. Server: `buildRelocationGuestMessage` same-community branch leads with "same
  community/building you originally booked" then the bedroom change ("3 bedrooms in total instead of
  4, just one less bedroom" + combined sleeps vs party); drive-minutes framing nulled; flags persisted
  on the page payload; GET /alternatives/:token renders the same-community headline + a "Same
  Community/Building as Your Original Booking" chip; AI unit-description prompt told not to frame a
  move. LOAD-BEARING: this is a documented EXCEPTION to the 2026-06-06 "never name the original
  community" rule — propertyLabel names the original community ONLY when sameCommunity is
  verdict-confirmed; the different-community path is byte-identical. NOTE: the same-community pivot
  fires from the buy-ins' communityVerdict stamps (Verify community / operator ✓ buttons) — verify
  first, then send. Verified: relocation-scenario 57/0, full `npm test` exit 0, build clean,
  `npm run check` 338 = baseline.

- 2026-07-06 (top-markets search → one-click combo pipeline overhaul): Operator asked to find MORE
  condo communities, fix the two chronic constraints (units not on the major OTAs; usable street
  addresses), integrate Claude/Claude-vision verification (same community, right bedroom-photo
  count, not listed on Airbnb/VRBO/Booking), and make the queue one-click-and-done. SHIPPED on
  `claude/top-markets-vacation-rental-search-jeqtxn`: (1) RECALL — `researchCommunitiesForCity`
  `discoverBeyondSeeds` opt (sweep/scan-job/cache-refresh pass it): curated HI markets no longer
  short-circuit to seeds-only (seeds still merge + win dedupe; missing-key falls back to seeds),
  mainland sweep research upgraded Haiku→Sonnet with world-knowledge 3→10 / results 10→15, two
  round-up queries added, prompt defaults availableBedrooms [2,3] when confident-but-unsure (empty
  array HID real resorts from the sweep grid). (2) OTA-CLEAN FIX — strict combo mode never returns
  an OTA-listed "best" gallery on exhaustion (`rejectOtaListedFallback`); failure messages count
  OTA-rejected candidates; `COMBO_PHOTO_OTA_ATTEMPTS` env-tunable (default 8). (3) ADDRESS —
  discovery ladder extended: maps → reverse-geocode → NEW portal-SERP slug rescue
  (`selectSerpListingAddressCandidate`: title match or ≥2-listing snippet consensus; fixes the
  "maps indexes the resort under another name" class) → NEW Claude web-search rescue
  (deterministically gated by `acceptClaudeAddressCandidate`: numbered street + state + resort
  named in cited evidence; kill `BULK_COMBO_ADDRESS_CLAUDE=0`). (4) POST-SAVE OTA DEEP-SCAN GATE —
  new awaited `"ota-scan"` step (fresh drafts, kill `COMBO_POST_OTA_SCAN=0`) deep-scans
  `draft-<id>-unit-a/b` with the dashboard/cron engine and rolls back + skips on a positive found
  (fail-open on infra; events ota-scan-clean/found/infra; also seeds the Photos cell). Claude-vision
  same-community + bedroom-count enforcement already existed (photo-community gate) — untouched.
  (5) ONE-CLICK — sweep selections >12 auto-queue the next batch when the current job completes
  (`sweepAutoContinueArmedRef`; disarmed on failure/cancel); progress bar gains
  photo-community(90%)/ota-scan(94%) phases. Verified: combo-ota-scan-gate 11/0 (new),
  community-address-discovery 37/0 (+12), full `npm test` exit 0, build clean, `npm run check`
  338 = baseline. Could NOT live-smoke SearchAPI/Claude legs (no keys) — post-deploy: sweep a
  curated HI market and expect NEW non-seed resorts; queue >12 and watch batches chain; item events
  show "ota-scan-clean". See AGENTS.md "Bulk combo-listing post-save OTA deep-scan gate" + the
  2026-07-06 Decision Log line.
- 2026-07-06 (find-unit SIDECAR PHOTO RESCUE — "two units still can't find replacements"): Mauna Lani
  draft-13 re-run failed "13 for-sale listings — 5 OTA-found, 1 too few bedrooms, 7 had TOO FEW
  PHOTOS"; Pili Mai's earlier re-run dropped 4/9 the same way. The find-unit candidate loop scraped
  galleries with SCRAPE_WITHOUT_SIDECAR only, so Zillow/Redfin datacenter bot-walls killed
  otherwise-qualified candidates at the photo floor — the exact class the commit-phase useSidecar fix
  (PR #929) recovers (9K: 0 direct → 24 via sidecar). SHIPPED: bounded sidecar photo rescue in the
  candidate loop — under-floor candidates (after the equivalent-source fallback) get ONE
  scrapeListingPhotosDualSource(SCRAPE_WITH_SIDECAR) retry (110s step timeout), rescued photos/facts
  feed the unchanged bedroom/floor/vision gates; MAX_SIDECAR_PHOTO_RESCUES=2/pass (env
  REPLACEMENT_SIDECAR_PHOTO_RESCUES, 0 disables) + 135s budget reserve; continuation passes refresh
  the rescue budget. NEVER widen the primary scrape to sidecar wholesale (70-120 candidates × 90s
  wallet vs the 260-285s route budget). Note: draft-13 re-runs now require 4BR (the J201 repoint set
  unit1Bedrooms=4 — correct; the unit IS 4BR). Source-locked (auto-replace-job 57/0), full npm test
  exit 0, build clean, check 338 = baseline.


- 2026-07-05 (draft rows get the Replace photos button — Waikoloa/Mauna Lani missing-button report):
  Operator screenshot showed flagged DRAFT rows (draft-12-unit-b = Waikoloa Beach Villas Unit B,
  draft-13-unit-a = Mauna Lani Point) with NO Replace photos button — resolveReplacePhotosUnits
  bailed on propertyId <= 0 by design (2026-07-04: "drafts keep using builder pre-flight"). SHIPPED
  full draft parity: shared draftUnitIdForSlot/parseDraftUnitId (`draft<id>-unit-a/b`), orchestrator
  resolveAutoReplaceTarget draft branch + UNIT-SCOPED repoint PATCH after commit, guesty-photo-repush
  draft branch (live listing pictures[] replaced too), home.tsx replaceBuilderLikeFor (buttons +
  pick-manually dialog from the drafts query). SIX adversarial-review findings fixed, the crucial
  ones: replacementPhotoFolderRef's greedy regex made draft replacement folders
  (replacement-pdraft-12-udraft12-unit-b) UNPARSEABLE → unscannable (rescan 400, cron skip,
  dashboard drop) — fixed with a constrained (draft-\d+|\d+) prop slug (also fixes prop27-style
  builder ids); the repoint PATCH was unscoped and would silently commit a SIBLING unit's abandoned
  preflight pick — route + storage.commitUnitSwaps now take optional oldUnitId (preflight commit-all
  unchanged); conventional draft-<id>-unit-a/b folders are now fallback-only in the dashboard loop
  AND the scanner (an abandoned pre-replacement folder no longer pins the popup / burns Lens);
  terminal draft jobs invalidate /api/community/drafts; manual repoint failure stops the handler;
  verify phase surfaces a rejected rescan kick. tests/auto-replace-job.test.ts 56/0. NOTE draft-12's
  flagged row was an ABANDONED folder (its unit was replaced Jun 30, swap 49 never committed) — the
  aggregation fix clears the row; the live listing's photos get fixed by the (now draft-capable)
  retroactive repush POST /api/replacement/repush-guesty-photos {propertyIds:[-12]}.

- 2026-07-05 ("Replace photos not finding replacements for Pili Mai" = DEPLOY-BURST kill, not a finder
  gap): Operator's one-click auto-replace for prop32 (Pili Mai Bldg 38, unit prop32-kia-3br) started
  21:20:07Z and was killed THREE times by the Railway deploys from his own 5 PR merges (21:23/21:26/
  21:27/21:42/22:22Z); the server resume caps (2) exhausted, the persisted find record stuck
  status="running" forever (found via `app_settings.replacement_find_jobs.v1` over DATABASE_PUBLIC_URL
  psql — CLI logs had rotated), GET 404'd, and a retry re-attached to the dead find job →
  nextStepFromFindJob(null)→"fail" → the MISLEADING "no eligible unit found". Sibling prop33 (same
  community) completed fine between deploys — the finder itself was never broken. SHIPPED: resume caps
  2→6 (deploy bursts are routine); both watchdogs terminalize stuck-unresumable records with
  PHASE-AWARE errors (stuck "verifying" = swap COMMITTED → "use Push Photos to Guesty, do NOT re-run
  Replace photos"; "committing" = ambiguous; only queued/finding say retry); GET :jobId serves a
  terminal failure flagged `stuckUnresumable` instead of 404 (+ a RUNNING placeholder on store-READ
  errors so a DB blip isn't "job vanished"); the CLIENT (unit-replacement-flow.tsx) relaunches on
  failed+stuckUnresumable exactly like the old 404 (source-locked test — the 404 was its ONLY relaunch
  trigger); the auto-replace orchestrator RESTARTS a bounded fresh search (findRestarts ≤ 2, debounced
  3 polls) instead of fake-failing, and resumed mid-"verifying" jobs re-enter runAutoReplaceVerifyPhase
  (previously fell through every phase guard and sat "verifying" forever) with the cap exempted for
  that phase (verify legs are cheap/idempotent; window still bounds); supersedeRunningRecordsForProperty
  is now UNIT-scoped (Unit A's restart must not kill Unit B's live search — two-unit properties are the
  duplicate-photos norm), skips live in-process jobs, and is skipped entirely on watchdog resumes; a
  throttled 5-min durable heartbeat keeps >60-min exhaustive searches inside the resume window.
  Reviewed via a 3-dimension adversarial workflow (4 confirmed findings all fixed). Verified:
  replacement-job-persistence 24/0, auto-replace-job 39/0, full `npm test` exit 0, build clean,
  `npm run check` 338 = baseline. POST-DEPLOY LIVE RUN exposed the SECOND stacked failure (also the
  reason prop33-kia-3br-b's earlier find "succeeded" but never committed — the operator's "another
  unit"): the find leg surfaced Pili Mai units 9K + 2J, but the COMMIT's photo hydration
  (`hydrateUnitSwapPhotoFolder` in POST /api/unit-swaps) scraped 9K's Redfin gallery from Railway's
  datacenter IP WITHOUT the sidecar tier → bot-walled → "returned 0 photos" → 502 → the orchestrator
  treated it as job-fatal and never tried 2J. FOLLOW-UP FIX (same day): POST /api/unit-swaps now
  hydrates with `{ useSidecar: true }` (the bounded 90s residential-IP tier the manual-URL route
  already used; fires only when the datacenter scrape comes up short), and the orchestrator's commit
  loop burns a 502 photo-hydration failure like a 409 (candidate-level, not job-level — tries the
  next option; loopback timeout 180s→300s for the sidecar window). Both source-locked in
  tests/auto-replace-job.test.ts (41/0). Live-verified post-deploy: prop32 auto-replace ran
  find → commit → verify end-to-end and the swap landed.

- 2026-07-05 (guest PARTY SIZE — adults/children — on bookings rows, inbox panel + Cowork prompts):
  Operator asked to see how many adults/children booked each reservation (VRBO/Booking/etc), on the
  bookings page "when I am trying to buy in the unit" + anywhere relevant. SHIPPED: new pure
  `shared/guest-party.ts` (22 tests) — `guestPartyFromReservation` parses Guesty's `guestsCount`
  (total) + `numberOfGuests`, which is EITHER a plain number (legacy — inbox already fell back to
  it) OR the `{numberOfAdults, numberOfChildren, numberOfInfants, numberOfPets}` breakdown object;
  `formatGuestParty` → "4 guests (2 adults, 2 children)" (parens only when they add info; absence
  of data returns null, never "0 guests"). Channel caveat: Airbnb/VRBO reliably send the breakdown,
  Booking.com sometimes total-only, manual rows nothing (they render nothing). Server:
  `guestsCount numberOfGuests` appended to the reservation `fields=` lists of BOTH bookings
  endpoints (`/api/bookings/guesty-all` + `/api/bookings/listing/:listingId`) — enrichment spreads
  the raw reservation so nothing else changed. UI: 👥 party line on the global-summary row (under
  guest name, testid `text-guest-party-<resId>`) + the per-listing summary row (under dates), and
  a 4th "Guests" cell in the inbox reservation panel's dates grid (total + breakdown sub-line;
  the guesty-proxy reservation GET already returns the full document). COWORK PROMPTS (the buy-in
  payoff): optional `party` input on `buildCoworkBuyInPrompt` (Reservation block "Party size:"
  line + SIZE rule extension — single unit must SLEEP the whole party; combo picks' COMBINED
  "sleeps N" must cover it) and `buildCoworkCheckoutPrompt` (VRBO guest-count picker set to the
  real party instead of "a sensible guest count"; falls back to the old wording when unknown);
  both bookings.tsx buttons pass `party: guestPartyFromReservation(reservation)`. Verified:
  guest-party 22/0 (new, added to npm test chain), cowork-buyin-prompt 196/0 (6 new), full
  `npm test` exit 0, build clean, `npm run check` 338 = baseline. Could NOT live-smoke the Guesty
  leg (no creds) — post-deploy the 👥 line appears on any channel booking whose guest entered a
  party size.

- 2026-07-05 (Message AD pulls arrival details FROM the alias email — live scrape + verbatim-verified
  Claude extraction): Operator asked the send-arrival-details button to pull door codes / arrival
  instructions from the emails hosts send to the minted guest alias, and to be "100% or close" sure
  they're correct. SHIPPED on `claude/arrival-details-email-scrape-2uzmyq`: the Message AD dialog
  now AUTO-RUNS `POST /api/bookings/:reservationId/arrival-details/refresh` on open (+ a
  "Pull from email" button) — per attached buy-in it live-syncs the traveler-alias inbox over IMAP
  (`syncGuestInboxForAlias`, so the click sees mail the 5-min background tick hasn't ingested yet),
  then `server/arrival-email-extract.ts` reads the FULL email text with Claude
  (`ARRIVAL_EXTRACT_MODEL`, default claude-sonnet-4-6) — catching what the regex parser drops
  (multi-code emails like the Santa Maria LOBBY/POOL/DOOR trio, unit numbers, check-in times as
  arrivalNotes lines). ACCURACY IS ENFORCED, NOT TRUSTED (load-bearing —
  `shared/arrival-email-verification.ts`): attribution is exact because the SimpleLogin alias is
  unique per buy-in; every Claude field must cite a verbatim quote + emailIndex, and the server
  REJECTS any value not literally present in the cited email (codes compared digit-for-digit;
  note lines may reformat as "Label: value" but every digit token must come from their own quote;
  paraphrases with invented numbers fail) — a hallucinated code cannot reach the guest. Address
  additionally passes the existing state-plausibility gate. Verified values OVERWRITE stale
  columns (that's the point of the button); fields no email mentions keep manual entries; regex
  stays the no-ANTHROPIC_API_KEY fallback (fill-blank-only). Provenance persists in new
  `buy_ins.arrival_extraction` jsonb (schema + schema-maintenance ALTER) and renders as per-unit
  ✓ evidence chips (tooltip = source subject/date + quote) plus ⚠ warnings for email conflicts
  (newest wins) and guest-portal-only emails (flagged, never scraped — behind login). Send stays
  operator-reviewed. Verified: tests/arrival-email-extraction.test.ts green (incl.
  hallucination-rejection + wrong-state-address cases modeled on the two real alias emails), full
  `npm test` exit 0, build clean, `npm run check` 338 = baseline. Could NOT live-smoke the
  IMAP/Claude legs (no creds in session) — post-deploy, open Message AD on a booked reservation:
  the sky "Checking the guest booking-email inbox…" strip runs, then ✓ chips appear and the draft
  contains the host's actual codes.

- 2026-07-05 (Cowork prompt now BOOKS the buy-ins on VRBO — approval-gated Phase 2): Operator asked
  for the attached VRBO unit to actually get checked out/booked as the guest. He first asked for a
  button + automation, then REDIRECTED mid-build: "no, I just want a cowork prompt to do all of
  this" — research + attach, he double-checks, then it books. SHIPPED on
  `claude/vrbo-checkout-automation-81t24i`: Phase 2 appended to `buildCoworkBuyInPrompt`
  (shared/cowork-buyin-prompt.ts → the bookings-page "Create prompt for Cowork" button). The prompt
  now hard-stops after attach ("STOP and wait for my explicit approval") and, on the operator's go,
  books each unit on vrbo.com: DAMAGE WAIVER ONLY (all insurance/add-ons declined; deposit-only
  host = proceed + note), guest's name for everything INCLUDING name-on-card (operator follow-up — never the cardholder's name), traveler email = the
  minted per-guest alias (POST /api/buy-ins/:id/traveler-email), phone 808-460-6509, 15% price
  guard vs costPaid, one unit at a time, never blind-retry Book-now (check My Trips first), then
  PATCH /api/buy-ins/:id {bookingStatus:"booked", bookingConfirmation} (allowlist widened +
  enum-validated, bookedAt stamped server-side) which arms the existing never-re-book guard and the
  green "Bought in" badge. CARD RULE (load-bearing): card details never in the prompt/app/repo —
  the prompt reads the operator-maintained local file ~/Documents/vrbo-booking-card.txt
  (DEFAULT_CARD_FILE_HINT) at payment time only; a test asserts the prompt contains no 13+-digit
  runs. OPERATOR SETUP: create that file on the Mac (number, expiry, CVC, billing address/zip —
  one per line; NO name line needed — name-on-card gets the guest's name). DON'T RE-CHASE: the dormant AUTOMATED checkout scaffold (buy_ins booking
  columns, server/buy-in-checkout-job.ts, `vrbo_book` op type, "Buy this unit in"/"Payment terms"
  buttons) is already merged but its sidecar worker handler was never written — the operator chose
  the Cowork path instead; the scaffold stays dormant/intact. 2ND FOLLOW-UP (operator): both
  prompts now end with a TIDY-UP step — close every Chrome tab the agent opened (never the
  operator's pre-existing tabs; checkout never closes a tab mid-booking or before its
  confirmation is captured) because leftover tabs were clogging/slowing the browser. 3RD
  FOLLOW-UP (operator): the find prompt must NEVER attach an airbnb.com link — qualification
  rule 5 (CHANNEL): attach only VRBO / Booking.com / direct booking (PM) site URLs; Airbnb is
  discovery-only (find the same unit's non-Airbnb page and attach that); Airbnb-only units do
  not qualify. 7TH FOLLOW-UP (operator): CHANNEL PREFERENCE — VRBO FIRST with a 20% escape
  hatch: per slot compare the cheapest qualifying VRBO listing vs the cheapest non-VRBO
  (Booking.com/direct); pick VRBO unless the non-VRBO total is BELOW 80% of the VRBO total
  (worked example locks the math direction: VRBO $2,000 → $1,590 wins, $1,700 does not); no
  qualifying VRBO → cheapest non-VRBO wins; the preference never relaxes rules 1–5 or the
  PAIR RULE, and the report must show each slot's cheapest VRBO total + which branch applied. 4TH FOLLOW-UP (operator screenshot, Waikiki 2-unit attach — $1,975 owner-direct +
  $4,074 Booking.com pair showing "0.4 mi apart · estimated from listing titles" when they should
  share a building): DIAGNOSED — the 0.4 mi was FAKE: the Cowork buy-in had no unitAddress, so the
  proximity estimator geocoded the boilerplate notes string to a city-centroid pin; ALSO
  titleFromBuyInNoteText (routes.ts) had no branch for the Cowork note format, so
  "Manually recorded buy-in for Unit" leaked in as the card's resort label, and the legend's
  hardcoded "Buy-in #<token>" prefix made a scraped unit-number token look like a shared id.
  FIXES: (1) find prompt now REQUIRES "unitAddress" in the create body + a PAIR RULE (multi-slot
  picks must share a complex, ideally the SAME BUILDING; force-override is same-complex only) + a
  PRICE SANITY rule (>~50% gap between same-BR picks must be re-verified + reported with rejected
  alternatives); (2) routes.ts titleFromBuyInNoteText parses "Found via Cowork web search — <scope>
  — <title>" (em/en-dash split, scope may contain hyphens) and rejects the bare boilerplate lead
  (falls back to the honest resort-footprint estimate instead of geocoding junk);
  commonResortNameFromTitles rejects record-keeping leads (manually/auto-filled/bought via/…);
  legend prints "<slot> — unit #<token>"; (3) NEW "Verify community" button
  (CoworkCommunityVerifyButton + buildCoworkCommunityVerifyPrompt) — read-only Cowork prompt that
  pins each attached unit's building/complex + street address (map pin, no guessing), gives a
  SAME BUILDING / same complex / same community / DIFFERENT verdict with real walking distance,
  and PATCHes the confirmed unitAddress back onto the buy-in so the walking-distance panel flips
  to "address verified" with a real number. 6TH FOLLOW-UP (operator screenshot): the verify
  outcome needed a clickable/durable home in the UI — new buy_ins columns communityVerdict/
  Source/At (schema + schema-maintenance ALTER), POST /api/bookings/:reservationId/
  community-verdict (enum same_building|same_community|different, stamps ALL attached buy-ins,
  source cowork|operator), verdict surfaced on the unit-proximity response ONLY when every
  attached buy-in agrees (swapping a unit auto-clears it), walking-distance panel gains a
  "✓ Verified same building/community · via cowork" badge (red card + "✕ NOT the same community"
  when different) plus always-visible "✓ Same community/building" / "✕ Not same" ghost buttons
  (data-testid button-community-verdict-yes/no-<reservationId>) any human or agent can click;
  the verify prompt's step 4 now POSTs the verdict (API preferred over button-clicking). 9TH
  FOLLOW-UP (operator): NEW amber "Will guest be happy?" button (Star icon, same strip) →
  buildCoworkGuestHappyPrompt: guest's-eye evaluation of the attached units vs the ORIGINAL
  booked listing on 4 dimensions (community — recorded community-verdict counts as evidence;
  size; BEDDING LAYOUT — 2 Twins for a King = flagged DOWNGRADE; photo QUALITY — Cowork
  vision judges finish/furniture/view/condition). Verdict happy|concerns|unhappy + written
  feedback recorded via POST /api/bookings/:reservationId/guest-happy → buy_ins
  guestHappyVerdict/Feedback/Source/At columns (consensus display rule same as community
  verdict), rendered as a green/amber/red panel + feedback text on the walking-distance card.
  10TH FOLLOW-UP (operator): sky "Find property on VRBO" button (Search icon, same strip;
  shown when an attached UNBOOKED buy-in has a non-vrbo.com URL and no prior lookup) →
  buildCoworkVrboLookupPrompt: hunt the SAME physical unit (unit number/address/photo match —
  a similar unit in the building does NOT count) on vrbo.com; 20% hatch preserved (current
  < 80% of VRBO total → keep + record). Outcomes via POST /api/buy-ins/:id/vrbo-lookup →
  buy_ins vrboLookupStatus/Note/At: "switched" atomically re-points the listing URL
  (vrbo.com host-validated) + costPaid, 409 on booked units; "not_on_vrbo" → slate
  "Not on VRBO · checked <date>" slot badge; "kept_cheaper" → amber badge; switched →
  emerald "Re-channeled to VRBO" badge and the unit then flows into the VRBO checkout prompt.
  11TH FOLLOW-UP (operator): per-unit SAME-BUILDING marking in the UI — the verify prompt's
  verdict POST already stamped every attached buy-in, but the only visible surface was the
  walking-distance panel's consensus badge (renders only with 2+ attached units). New pure
  shared/community-verdict-badge.ts (`unitCommunityVerdictBadge`) derives a badge from each
  slot's OWN buy-in row (slots[] already carry full buy_ins rows, so no server change):
  emerald "✓ Same building" / "✓ Same community", red "✕ Not the same community", tooltip
  with source + ISO day, testid badge-unit-community-verdict-<res>-<unit>, rendered next to
  the ground-floor badge on every attached unit slot card in bookings.tsx (unknown/legacy
  verdict values render nothing). Verify prompt step 4 reworded: the POST "MARKS the units
  in the portal UI" and must NEVER be skipped even on a positive finding — a verdict only
  written in the chat report leaves the units unmarked. Verified: cowork-buyin-prompt 153/0,
  full `npm test` exit 0, build clean, `npm run check` 338 = baseline. 12TH FOLLOW-UP
  (operator): BOOKING MODE — the find prompt now prefers INSTANTLY BOOKABLE units.
  buildCoworkBuyInPrompt gains a BOOKING MODE block (after CHANNEL PREFERENCE): capture each
  qualifying listing's mode (INSTANT BOOK = immediate confirmation; REQUEST-ONLY = host
  approval ~24h); comparable options → pick the instant-book one; request-only stays fully
  acceptable (cheapest qualifying pick never rejected over it; subordinate to the channel
  preference + rules 1–5). BACKUP RULE: a request-only ATTACHED pick must come with the
  cheapest qualifying INSTANT-BOOK backup for that slot (rules 1–5, distinct URL, combo →
  ideally same complex as the sibling pick), NEVER attached/booked — recorded in the buy-in
  notes (" · Booking mode: <mode> · Instant-book backup: <url> — $<total>", conditional
  segment) AND the report (or explicit "no qualifying instant-book backup exists").
  NOTES-FORMAT SAFETY (load-bearing): segments are " · "-joined AFTER the listing title —
  titleFromBuyInNoteText's capture stops at "·", verified against the live regex; never move
  them before the title. Verified: cowork-buyin-prompt 175/0 (13 new), full `npm test` exit 0,
  build clean, `npm run check` 338 = baseline.
  5TH FOLLOW-UP (operator): VRBO bot checks made the
  agent SKIP VRBO — all three prompts now embed BOT_WALL_PROTOCOL: never skip/close on a bot
  check; alert loudly (5× afplay Sosumi + say + osascript notification, repeating ~60s up to 15×)
  so the operator hears it from another room; wait re-checking every ~30s (never reload — VRBO's
  wall gets stickier; never self-solve); resume the exact step once solved; ~15 min unsolved →
  pause with the tab open + a blocked-at report. 8TH FOLLOW-UP (operator): DONE SIGNAL — all
  three prompts end (very last step, after report + tab tidy-up) with an audible completion
  chime: Glass ×3 + say "Cowork is done — <actual outcome>" + notification on clean success;
  Basso ×3 + "needs your attention — <problem>" when something needs review; one burst, never
  looped; Sosumi stays the mid-task come-help alarm. Verified: cowork-buyin-prompt 91/0 (incl. source
  assertions on the routes/bookings fixes), full `npm test` exit 0, build clean, `npm run check`
  338 = baseline. FOLLOW-UP same day (operator): the
  checkout must be a SEPARATE prompt/button from the find prompt. buildCoworkBuyInPrompt reverted
  to search+attach-only (ends "This task ends at ATTACH … do NOT book"); new
  `buildCoworkCheckoutPrompt` (same shared file) is the book-only prompt — running it IS the
  approval (no internal checkpoint), embeds the attached buy-ins (buyInId/listing URL/costPaid) and
  keeps every money guard (waiver-only, guest name, alias email, 15% guard, skip-if-booked,
  no-blind-retry, card file). New emerald "Checkout prompt (books on VRBO)" button
  (`CoworkCheckoutPromptButton`, bookings.tsx expanded-row action strip) renders whenever a slot
  has an attached buy-in with bookingStatus !== "booked". Verified: cowork-buyin-prompt 65/0, full
  `npm test` exit 0, build clean, `npm run check` 338 = baseline.

- 2026-07-04 (photo-replacement queue: operator "Clear queue"): Operator (screenshot of the finished
  queue dialog) asked to be able to clear out the auto-replace queue. SHIPPED: pure
  `clearableAutoReplaceJobIds` in shared/auto-replace-job-logic.ts (7 new tests, suite 27/0) —
  clearable = TERMINAL jobs (completed/failed) + STUCK active records that can never resume
  (resume cap hit or outside the 90-min window; they'd otherwise pin the banner until the 24h store
  eviction); a job id in `liveJobIds` (the server's activeJobIds — actually running right now) is
  NEVER cleared, so a mid-flight destructive commit keeps its record. Server
  `clearAutoReplaceQueue()` (auto-replace-jobs.ts) deletes those ids from BOTH the in-memory map and
  the persisted `auto_replace_jobs.v1` store (via the same mutateStore promise-tail), so the queue
  clears on every device, then returns the fresh summary. Endpoint
  POST /api/replacement/auto-jobs/clear. home.tsx: "Clear" ghost button on the sky queue banner
  (shown only when a terminal job exists) + "Clear queue" in the View-queue dialog footer (disabled
  when nothing is clearable; note "Running jobs are never cleared"); success setQueryData's the
  fresh summary + closes the dialog when empty. Verified: full `npm test` exit 0, build clean,
  `npm run check` 338 = baseline.

- 2026-07-04 (dashboard MISSING-BUY-IN red-flag popup — units not purchased for a check-in within
  7 days): Operator asked for a card-failure-style red alert when a reservation's required units
  haven't been bought in within 7 days of check-in. SHIPPED: pure `shared/buyin-coverage-warning.ts`
  (41 tests) — `collectBuyInCoverageWarnings` warns when a committed reservation (same status
  exclusions as the payment warning; manual rows pass) checks in within 7 days (inclusive, incl.
  today AND in-house stays via the checkOut>=today clause — past stays never nag) and any unit slot
  lacks an attached buy-in (a CANCELLED buy-in does not count as coverage; a status-less legacy row
  does). Reservations with no configured slots are skipped (requirements unknown). Server
  `GET /api/dashboard/buyin-coverage` (routes.ts, after payment-failures) deliberately does NOT
  re-implement slot resolution — it loopback self-calls `GET /api/bookings/guesty-all?checkInTo=
  today+8` (the property-revenue-scheduler pattern), which already returns every committed Guesty +
  manual reservation with `slots[]` (required units + attached buyIn) across core properties,
  promoted drafts, and ad-hoc listings; checkInFrom is deliberately unset so in-house stays (past
  check-in, checkOut>=today default filter) come back. Client home.tsx: exact payment-failure
  pattern — auto-opening red Dialog + persistent "Review units" banner, dismissal signature in
  localStorage `nexstay_buyin_coverage_warning_dismissed` (re-raises when facts change: new
  uncovered arrival, moved check-in, different missing-unit set — and yes, buying ONE of two units
  re-raises with the remainder), per-booking rows show "✕ N of M units NOT purchased (Unit 812) ·
  checks in in X days" (TODAY / ALREADY checked in variants) + "Find & attach units" (/bookings) +
  "Open in Guesty" (hidden for manual: rows). Remediation stays MANUAL — no auto-purchase from a
  popup. Verified: 41/0 new tests, full `npm test` exit 0, build clean, `npm run check` 338 =
  baseline. Could NOT live-smoke the Guesty leg (no creds) — post-deploy the popup should
  auto-raise if any upcoming-7-day booking has an unfilled slot (most do per the buy-ins-table
  memory, so expect it to fire on first load).

- 2026-07-04 (SIBLING-UNIT look-alike false FOUND — Pili Mai 8J incident; diagnosed from RAILWAY
  LOGS, now accessible via RAILWAY_TOKEN env): Operator ran the one-click auto-replace on prop32
  Unit A; queue completed (committed Redfin unit #8J, 22 photos) and BOTH verification kicks fired
  (loopback POSTs 200 at 19:53:45Z), but the deep rescan re-flagged the NEW folder:
  "replacement-p32-uprop32-kia-3br: airbnb=clean, vrbo=found, booking=clean (19 photos)". Evidence
  links were Pili Mai 8K / 08D / 13F / 7J — SIBLING units' own VRBO listings. ROOT CAUSE: same-model
  condos in one community photograph nearly identically, so Lens VISUAL matches sibling listings for
  ANY unit we put there; the multi-photo-agreement fallback (no unit-text required) then declares
  FOUND forever = infinite replace loop. FIX: pure `shared/sibling-unit-lookalike.ts` (18 tests) —
  `unitTokensFromListingText` (conservative: digit+letter bare tokens like 8K/13F — 3BR/2BA can't
  match; marker-prefixed unit/apt/condo/# tokens; /unit-8j/ URL segments; leading-zero canonical
  08D==8D) + `isSiblingUnitLookalikeHit`. The scanner's strongHits (agreement) tally now SKIPS a
  community-compatible hit that names a DIFFERENT unit when the Lens source is merely "visual".
  LOAD-BEARING SAFETY: "known-source" hits (page provably contains OUR image) are NEVER suppressed,
  the VERIFIED path (page text mentions OUR unit token) is untouched, and unit-less reposts still
  count toward agreement — real theft still trips FOUND. Logs a
  "skipping sibling-unit visual look-alike" line per suppression. NOTE: the flagged row clears only
  on the NEXT rescan of that folder — post-deploy, tap "Rescan again" on the Pili Mai row (or
  re-run the photo scan) and it should walk to clean. `npm run check` baseline is now 338 (main
  moved; 0 new from this change), full `npm test` REAL exit 0, build clean.

- 2026-07-04 (ONE-CLICK auto-replace from the duplicate-photos warning): Operator asked for the
  Replace-photos button to be true one-click-and-done — no modal, background everything, progress
  via a dashboard queue. SHIPPED: server orchestrator `server/auto-replace-jobs.ts` chains the
  EXISTING machinery: startPreflightReplacementFindJob (first-hit mode — exhaustive pool-draining is
  wasted when auto-committing option 1) → auto-COMMIT via loopback POST /api/unit-swaps (a 409
  duplicate-source burns that URL and falls through to the next option — `pickCommitCandidate`) →
  kicks the deep OTA rescan of the new folder + the Claude-vision bulk photo-community check →
  completed. Pure decisions in `shared/auto-replace-job-logic.ts` (20 tests): persisted store
  (`auto_replace_jobs.v1`, same fail-soft promise-tail pattern), 90-min resume window + 2-resume cap
  (`startAutoReplaceResumeWatchdog` in index.ts, gate `AUTO_REPLACE_RESUME_DISABLED=1`; the find leg
  additionally survives via the #899 watchdog), one-active-job-per-property+unit double-tap guard,
  `nextStepFromFindJob` (completed-EMPTY = fail, never commit nothing). Endpoints: POST/GET
  /api/replacement/auto-jobs. home.tsx: the popup's destructive button now fires the auto job
  (spinner + disabled while queued); tiny "pick manually" link keeps the old UnitReplacementFlow
  dialog; sky-blue queue banner above the table ("Replacing photos for N units — safe to leave" /
  "finished") + "View queue" dialog with phase chips (queued/finding/committing/verifying/
  completed/failed); on a watched job going terminal the client invalidates photo-listing-check +
  photo-community-status + unit-swaps, extends the photo poll window, and toasts once. NOTE: this
  DOES auto-commit a destructive photo swap — operator explicitly chose that; the manual path
  remains one tap away. Verified: 20/0 new, full `npm test` REAL exit 0, build clean, `npm run
  check` 335 = baseline. Could NOT live-run (no SEARCHAPI key) — post-deploy: tap Replace photos,
  leave, return ~5 min later: queue banner shows the result and the Photos cell walks to green.

- 2026-07-04 (find-replacement search: SERVER-side restart survivability — durable job store + boot
  watchdog): Operator asked to click Replace photos, hop to another app (Twitter), and have the
  search "carry on until finished". AUDIT: already true EXCEPT one hole — the find-unit job lives in
  server memory, so a Railway redeploy/restart mid-search killed it, and the ONLY relauncher was the
  operator's browser (localStorage payload, fires when the tab next polls). In another app = no tab
  = search stalled until he returned. SHIPPED: pure `shared/replacement-job-persistence.ts` (13
  tests) — compact job records persisted in app_settings (`replacement_find_jobs.v1`, cap 10 newest,
  24h age eviction at write time, all I/O sequenced through a promise tail + fail-soft);
  `startReplacementFindResumeWatchdog` (wired in server/index.ts next to the bulk-pricing watchdog;
  boot pass ~20s after listen + 2-min interval; gate `REPLACEMENT_RESUME_DISABLED=1`) re-launches
  orphaned RUNNING records under the SAME job id (60-min freshness window, 2-resume server cap —
  separate from the client's 3), so the phone's stored jobId keeps working with nothing to
  reconcile. A NEW search for a property SUPERSEDES older running records (marked failed) so the
  watchdog can't run a duplicate sweep alongside a fresh operator search. GET
  /api/preflight/replacement-find-jobs/:jobId now falls back to the store when memory is empty:
  terminal records serve their snapshotted units/message (finished results survive restarts — the
  operator can come back an hour later to the options list), resumable running records serve a
  RUNNING "resuming after restart" placeholder so the polling client waits for the watchdog instead
  of double-launching. Verified: 13/0 new, full `npm test` REAL exit 0, build clean, `npm run check`
  335 = baseline. Post-deploy confirm: start a search, redeploy mid-run, watch
  "[replacement-find] boot-resume: re-launching orphaned running job" in Railway logs.

- 2026-07-04 (dashboard FAILED/UNCOLLECTED payment warning popup, PR #898): Operator asked for a
  refund-style warning when (a) a guest payment FAILED (message guest + reprocess in Guesty) or (b) a
  scheduled balance (e.g. due ~90 days before arrival) blew past its due date uncollected; retroactive
  ~2 weeks; NEVER warn on cancelled bookings. SHIPPED: pure `shared/payment-failure-warning.ts`
  (37 tests) — `collectReservationPaymentIssues` detects failed rows (STATUS-only /(fail|declin)/
  match — description text like "retry if payment fails" must not trip it; refund-shaped rows are the
  refund alert's job; payment-row status "cancel" = operator-voided, NOT failed) and overdue
  scheduled rows (`paymentRowLooksScheduled` + `shouldBePaidAt` via scheduledChargeDateIso, 24h
  processing grace, 14-day lookback). Skips: cancelled/inquiry/etc reservations
  (isCommittedGuestyReservation's exclusion set) and fully-paid ones (`money.isFullyPaid===true` OR
  totalPaid>=totalPrice — the Booking.com isFullyPaid-with-totalPaid:0 shape per the
  payment-collected-detection memory). Dedupe: failed attempt + still-pending schedule row of the
  SAME amount/day = ONE "failed" issue. Server `GET /api/dashboard/payment-failures`
  (routes.ts, after the revenue handlers) does TWO Guesty passes merged by _id: sort=-lastUpdatedAt
  until a page is older than 14d (a failed ATTEMPT bumps lastUpdatedAt) + upcoming check-ins
  (now-1d..now+180d, fail-soft) because a NEVER-attempted scheduled charge doesn't bump
  lastUpdatedAt — dropping pass B silently loses the dormant-overdue case. Client home.tsx:
  auto-opening red Dialog + persistent "Review payments" banner (duplicate-photos pattern: dismissal
  signature in localStorage `nexstay_payment_failure_warning_dismissed`, re-raises when facts
  change); per-booking rows show issue chips ("✕ Payment FAILED — reprocess in Guesty" red /
  "⚠ Scheduled balance NOT collected" amber), "Paid $X of $Y", and buttons "Reprocess in Guesty"
  (app.guesty.com/reservations/<id>) + "Message guest" (/inbox?reservationId= deep link). Remediation
  stays MANUAL by design — we never auto-charge a card from the dashboard. Verified: 37/0 new tests,
  full `npm test` exit 0, build clean, `npm run check` 335 = baseline. Could NOT live-smoke the
  Guesty leg (no creds) — post-deploy the popup should auto-raise if any recent payment failed.

- 2026-07-04 (refund-alert "Resend to guest" 422 fix, PR #896): Operator screenshot — clicking
  Resend on the dashboard refund-attention row (Cheryl Parker, homeaway2) always toasted "Resend
  failed / 422: Sent 0 of 1 receipt(s)". TWO stacked bugs. (1) SERVER: the row's CHANNEL receipt was
  already delivered (status "sent"); it was flagged only for the failed refund-SMS leg
  (refundSmsNeedsAttention). The manual force-send hit processTransaction's terminal "already sent"
  skip, which DID retry the SMS leg but threw the result away → ok:false → 422 forever, even when
  the retry delivered the text. FIX: `sendRefundReceiptSmsLeg` returns its outcome
  (sent/already-sent/no-phone/not-configured/error + detail); under allowResend BOTH terminal-skip
  branches (current-key + legacy-key shim) convert it via `manualResendVerdictFromSms` — delivered
  text = SENT resend (200, green toast), failed text = error with the actionable reason.
  Scheduler-tick (no allowResend) semantics unchanged; the OTA channel is still never re-posted.
  `sendReceiptForReservation.message` now appends per-receipt failure reasons. (2) CLIENT: the
  mutation's "422 is a result" branch was DEAD — `apiRequest` throws on every non-2xx. It now
  fetches directly, tolerates 422, and the success toast says which leg was resent. Guarded by 6
  source assertions in tests/receipt-message.test.ts (67/0); full `npm test` exit 0, build clean,
  `npm run check` 335 = baseline. Could NOT live-smoke Guesty/Quo (no creds). Post-deploy: HARD
  refresh the dashboard (the operator's Safari had a stale pre-#890 bundle — old alert copy, no 📱
  SMS-failure line), then Resend on Cheryl's row: green toast if her phone is on file, otherwise an
  explicit "no phone on file — save one in the Guest Inbox" error.

- 2026-07-04 (find-replacement-unit: EXHAUSTIVE mode + leave-your-phone auto-reopen): Operator asked
  (a) can he leave Safari mid-search (screenshot: "Still checking candidates… 94% · 7:42") and (b) a
  deep dive into how find-unit works + make it find ALL possible replacement units. (a) AUDIT: the
  search ALREADY runs fully server-side (preflight-background-jobs loopback job; localStorage
  payload ref auto-relaunches an evicted job, 45-min window, 3-restart cap) — the "Safe to leave
  this tab" label is true. REAL GAP: iOS Safari reloads the tab on return, wiping
  replacePhotosTarget, so the dashboard dialog (polling + the manual COMMIT step) vanished and the
  operator had to re-click Replace photos to rediscover his own search. FIX: exported
  `findLiveReplacementJobRef(propertyIds)` from unit-replacement-flow.tsx (most-recently-alive ref
  within the window) + a once-per-load home.tsx mount effect that auto-reopens the dialog + toast.
  Commit stays manual (destructive photo swap). (b) DEEP DIVE (don't re-chase): discovery = SearchAPI
  site: queries (zillow/realtor/redfin/homes, bedroom-aware, aliases, sold-listing sweep, Ko Olina
  branches) + Apify + RealtyAPI, pool target 40-80, per-pass cap 70/120 candidates + 220 SearchAPI
  calls + 260-285s route budget; gates: resort-street, internal-duplicate, bedroom, OTA-text,
  photo-floor, Haiku vision, reverse-image reuse. THE exhaustiveness gap: one pass returned after
  MAX_VIABLE_UNITS (4/5) cleans and the job runner broke at the FIRST pass with a unit — big
  communities never surfaced the rest. SHIPPED: `collectAllOptions` (client now always sends it) —
  find-unit raises per-pass viable cap to 8 and (KEY) returns a SUCCESS-path diagnostic
  (budgetStopped/capExceeded/uncheckedCandidates sliced from new `processedCandidates` counter —
  attempts.length undercounts on success); the job runner accumulates units across passes (dedupe by
  url, accepted urls join skipUrls) and continues while pool remains, until
  REPLACEMENT_EXHAUSTIVE_TARGET (default 12) options or the 12-pass cap; a later "no eligible units"
  failure AFTER options accumulated = pool drained = COMPLETED, not failed. Pass control is pure
  `shared/replacement-search-continuation.ts` (15 tests; legacy first-hit mode preserved when flag
  absent). NOTE: tests/pipeline-logic.test.ts Tier-2 meta-assertion repointed to the shared module.
  Verified: 15/0 new, full `npm test` REAL exit 0, build clean, `npm run check` 335 = baseline.
  FOLLOW-UP same day (operator screenshot: replaced Kapaa Unit A re-flagged by a Maui "Kamaole
  Sands" 1BD, a "Costa del Sol" house, and a "Wailea Hotels" Airbnb HUB page): FALSE POSITIVE —
  `folderCommunityContext` only resolved original-unit + draft folders, so a builder property's
  `replacement-p<prop>-u<unit>` folder scanned with ctx null → `listingMatchesFolderCommunity`
  returned true for EVERY hit → generic tropical look-alikes tripped multi-photo agreement into
  FOUND. FIX: the builder lookup now also matches `ref.propertyId > 0` from
  `replacementPhotoFolderRef` (folderAddressContext already did the analog via the unit-swap row);
  guarded by a pipeline-logic.test.ts source assertion. Post-deploy: "Rescan again" on the flagged
  replacement row should come back clean.

- 2026-07-04 (duplicate-photos popup: per-unit MATCHED-PHOTO rollup + Airbnb/VRBO/Booking breakout;
  scanner HOST-FAMILY bucketing fix): Operator asked to (a) see "Unit A matched photo x, y, z" at a
  glance to judge real-vs-false matches, (b) break out VRBO and Booking.com matches, and (c) make
  sure the scan actually matches those channels (he mostly saw Airbnb). (c) ROOT CAUSE FOUND: the
  scanner's Lens tally bucketed by bare substring (`link.includes("vrbo.com")` etc.) — Lens hits on
  regional/sibling domains were silently DROPPED: airbnb.co.uk/.ca/.com.au, VRBO's brand family
  (homeaway.com, abritel.fr, fewo-direkt.de, stayz.com.au, bookabach.co.nz — same listing pool!),
  m.booking.com. FIX: new pure `shared/ota-host-match.ts` (24 tests) — `otaPlatformForUrl`
  host-family matcher (rejects lookalikes like airbnb.evil.com via the TLD-label heuristic) +
  `canonicalOtaUrlCandidates` (regional URL → canonical airbnb.com path / vrbo.com/<numeric id> /
  booking.com path). LOAD-BEARING: the scanner's authorized-URL suppression now checks the CANONICAL
  candidates too — without that, widening hosts would flag OUR OWN airbnb.co.uk/abritel.fr mirrors
  as theft. (a)+(b) UI: each popup unit group now shows a red rollup box "Unit A (7B) matched N of
  your photos: x.jpg, y.jpg, z.jpg" with 48px thumbnails (dedup across links —
  `distinctMatchedPhotoUrls`), and links render under per-platform sub-headings "Airbnb (2 listings):
  / VRBO (1 listing): / Booking.com (…)" via `groupLinksByPlatform` (platform-ordered, empty
  platforms dropped). Tests 33/0 duplicate-photo-warning + 24/0 ota-host-match, full `npm test` exit
  0, build clean, `npm run check` 335 = baseline. Could NOT live-smoke a Lens scan (no SEARCHAPI
  key) — post-deploy, re-run the photo scan: VRBO/Booking columns should start picking up
  regional-domain reposts the old substring match missed.

- 2026-07-04 (duplicate-photos popup: PER-UNIT link attribution + matched-photo thumbnails):
  Operator (screenshot: Anini Beach 6BR row "Unit A (7B) + Unit B (8)" with one clumped link list)
  asked to show which photos/URLs belong to Unit A vs Unit B. ROOT CAUSE: some properties share ONE
  photo folder between both units — prop20 mauna-kai-t3 (7B + 8) and prop29 kaiulani-52 even share
  the IDENTICAL `photos` list — so the folder-keyed warning row inherently clumps them. SHIPPED:
  `collectDuplicateListingLinks` now accumulates each de-duped listing's matched OUR-photo URLs
  (scanner stamps `photoUrl = <host>/photos/<folder>/<file>`); new pure
  `groupDuplicateListingLinksByUnit(matches, owners)` attributes each offending listing to the
  unit(s) whose configured `photos[]` filename list contains the matched photo — a listing hosting
  both units' photos shows under BOTH; unmatched files go to an "unassigned" group; and owners with
  IDENTICAL galleries (the mauna-kai-t3 case) deliberately collapse to ONE group flagged
  `sharedGallery` (honest "one gallery serves both units" note — never fake attribution). Popup rows
  render per-unit "Unit A (7B) — photos found on:" sections + 36px THUMBNAILS of our matched photos
  under every link ("Your photos found there:") so the operator can identify the photo even in the
  shared-gallery case. ALSO: `resolveReplacePhotosUnit` → plural `resolveReplacePhotosUnits` — a
  shared-folder row now gets a "Replace photos (Unit X)" button PER owning unit (screenshot showed
  only Unit B's). Tests 30/0 (`tests/duplicate-photo-warning.test.ts`), full `npm test` exit 0,
  build clean, `npm run check` 335 = baseline.

- 2026-07-04 (duplicate-photos popup: per-unit "Replace photos (Unit X)" → find-new-unit flow +
  Claude-vision community confirmation): Operator asked for a button on each duplicate-photos
  warning to replace that unit's photos with another unit from the SAME community + SAME bedroom
  count, Claude/Claude-vision-confirmed. KEY DECISION (don't rebuild): reused the preflight
  `UnitReplacementFlow` component (client/src/components/unit-replacement-flow.tsx) wholesale — it
  already owns the background find-unit job (real-estate sources ONLY per PR #338, resort-street
  community gate, bedroom gate, Claude Haiku interior-vision probe, OTA text + reverse-image clean
  checks, resume-after-redeploy) and the `POST /api/unit-swaps` commit that hydrates the
  `replacement-p<prop>-u<unit>` folder which scanner/dashboard already treat as the unit's ACTIVE
  folder. home.tsx mounts it in a Dialog from a new per-flagged-unit destructive "Replace photos
  (Unit A/B)" button (only builder properties; drafts keep using builder pre-flight which owns
  draft-field repointing); props assembled exactly like builder-preflight (parse address +
  `inferCommunityStreetAddress`; skipUrls = existing swaps' newSourceUrl). On commit
  (`handleDuplicatePhotoUnitReplaced`): auto verify-rescan of the NEW replacement folder (reuses
  confirmPhotosReplacedMutation → popup pending→clean verdict + Photos cell) + auto
  `startBulkPhotoCommunityCheck([propertyId])` = the Claude SONNET vision community check. REAL GAP
  FIXED server-side: `buildPhotoCommunityCheckRequestForProperty` (server/builder-photo-groups.ts)
  verified units' ORIGINAL folders even after a swap — now resolves the ACTIVE folder via new pure
  `resolveActiveUnitPhotoFolders`/`latestUnitSwapsByUnit` (shared/unit-swap-photos.ts, 8 tests;
  mirrors routes.ts activeUnitPhotoFoldersForBuilder, falls back to the original folder if the
  replacement has no published photos yet). Popup rows for replacement-* folders show the community
  verdict chip (running → "Claude vision is confirming…", sameCommunityOk true → green confirmed,
  false → red review-in-builder); propertyId parsed from the folder name via
  `replacementPhotoFolderRef`. Verified: `tests/unit-swap-active-folders.test.ts` 8/0, full
  `npm test` exit 0, build clean, `npm run check` 335 = baseline (0 new). Could NOT live-smoke the
  find-unit/vision legs (no SEARCHAPI/ANTHROPIC keys) — confirm post-deploy by clicking "Replace
  photos (Unit X)" on a red-Photos unit: search ~2-5 min, commit, then the popup shows the OTA
  rescan verdict + the community-vision chip, and Comm QA re-runs for the property.

- 2026-07-03 (refund-receipt AUDIT + no-conversation hardening; header unread badge = REAL unread):
  Operator asked to (a) make sure a Guesty refund always sends the guest a refund receipt on their
  booking channel and (b) make the header unread-message badge match the actual unread messages.
  (a) AUDIT (don't re-chase): the whole path already shipped 2026-06-30 and is code-verified intact —
  `server/guest-receipts.ts` 5-min scheduler (auto-ON, `GUEST_RECEIPTS_DISABLED` to kill), refund
  detection covers nested/negative/refund-array shapes (`realRefundsForReceipts`), refunds BYPASS
  `RECEIPT_SKIP_CHANNELS`, delivery-verified OTA routing via `sendGuestyConversationMessage`
  (Airbnb→Airbnb, VRBO→VRBO, Booking→Booking), misroute/stale surfaced in the dashboard revenue
  dialog red alert with "Resend to guest". ONE real gap closed: a refund on a reservation with NO
  Guesty conversation yet was skipped WITHOUT a ledger row — if a conversation never appeared within
  the 48h backfill window the refund receipt died silently with no alert. Now a refund (only; payments
  keep old behavior) writes the `pending` row anyway (`conversationId` null, schema already nullable),
  later ticks retry it, and a stale pending row is flagged by `receiptNeedsAttention` → dashboard
  alert + Resend. Retry-path `updateGuestReceiptContent` now omits `conversationId` when unknown so a
  retry can't null-clobber a resolved one.
  (b) ROOT CAUSE of badge mismatch: before the inbox page's first mount, AppHeader fell back to the
  pending-AI-DRAFT count (a different signal), and it summed missed calls into the number. FIX: new
  pure `shared/inbox-unread-count.ts` (18 tests) — `countUnreadConversations` mirrors inbox.tsx
  semantics (`state.isLastPostFromGuest` explicit-first, legacy NEW/UNREAD/UNANSWERED fallback,
  right-click override honored unless superseded by newer guest activity); AppHeader now fetches the
  SAME conversations query (same queryKey → shared TanStack cache; the `&fields=` param is
  LOAD-BEARING per the 2026-05-04 note) and derives the real count + persisted localStorage overrides
  (`nexstay_inbox_read_overrides_v1`, key/parser now exported from the shared module and used by BOTH
  inbox.tsx and the header so they can't drift). The inbox-published count still wins once available.
  Badge now shows ONLY unread messages (missed calls keep their separate phone icon). Verified:
  `tests/inbox-unread-count.test.ts` 18/0, `tests/receipt-message.test.ts` 46/0, full `npm test` exit
  0, build clean, `npm run check` 335 = baseline. Could NOT live-smoke Guesty legs (no creds).

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
  SHIPPED (PR #887). FOLLOW-UP same day (operator ask): each warning row now links to the ACTUAL
  offending OTA listing(s) — pure `collectDuplicateListingLinks` (de-dupes the per-photo Lens match
  rows by listing URL, query/slash-insensitive; platform-ordered; capped 6 + "+N more"; tests now
  20/0) rendered as red external links under the warning text, hidden once a verify rescan confirms
  clean. Safe to trust the links: the scanner's authorized-URL suppression (server/authorized-urls.ts,
  Guesty `integrations[]`-derived) drops OUR OWN Airbnb/VRBO/Booking URLs before anything reaches
  `*_matches`, so a "found" verdict + its links are always someone ELSE's listing.

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
