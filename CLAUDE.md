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
