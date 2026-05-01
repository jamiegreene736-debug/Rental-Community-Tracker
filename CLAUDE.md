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
  compatibility, but it is intentionally always `0`.
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
