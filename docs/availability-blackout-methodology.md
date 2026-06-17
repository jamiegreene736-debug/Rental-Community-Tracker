# Availability black-out via SearchApi Airbnb — methodology & implementation plan

_Drafted 2026-06-17. Grounded in live SearchApi `engine=airbnb` calibration + a 10-agent
design/verification pass. Surgical extension of the PR #694 sourceability gate._

## TL;DR

- **Goal:** cheaply decide, per listing per 7-night week, whether to black out the week on
  Guesty because the unit sizes can't be sourced — using SearchApi instead of the slow sidecar.
- **It does NOT black everything out.** Two independent 90-day Poipu Kai simulations agree:
  geo-only flagged 0–3 of 13 weeks; the faithful alias-membership screen flagged **1 of 13**,
  and even that wouldn't auto-block without sidecar confirmation.
- **Two hard limits found live:** (1) the dated Airbnb search is **blind past ~12 months**
  (2yr-out returns 0 for everything) so a 2-year availability sweep is impossible — far-future
  must rely on buy-early cost-lock; (2) the Airbnb signal is **too noisy to block on alone**
  (it depends on whether hosts type "Poipu" in titles), so a sidecar confirm is mandatory.
- **Strategic caveat:** in a liquid market like Poipu, raw availability almost never runs dry.
  The thing that actually bites (sold a 6BR for \$12k, cheapest combo \$18.6k) is a **profit**
  problem, which a pure-availability gate will not catch.

## Key empirical findings (verified live, Poipu Kai, 2026-06-17)

| # | Finding |
|---|---|
| 1 | `engine=airbnb` listings have **no `bedrooms` field** (always null). Exact size is in `accommodations` (`["3 bedrooms","4 beds"]`). The current prod filter `p.bedrooms !== br` is a dead no-op. |
| 2 | The `bedrooms=N` query param is a **minimum** filter (a `=3` search returns 3/4/5-BR). Must post-filter `accommodations` for exact size. |
| 3 | `gps_coordinates` IS populated. The location query is **island-wide**: `q="Poipu Kai Resort"` returned 18 listings, **14 were 35–38 km away** (north shore); only 4 within 2 km. |
| 4 | **~12-month horizon ceiling.** Next-week and 1yr-out returned full pools; **2yr-out returned 0 for every query/size.** Airbnb lists ~12–15 months out. |
| 5 | First page ≈ 18–20 listings (saturates). Fine for a low block threshold, useless as a magnitude. |
| 6 | **Cluster overlap:** Poipu Kai, Poipu Brenneckes, Makahuena, Pili Mai sit 0.5–0.9 mi apart and all resolve to `"Koloa, Hawaii"`. **Geo radius ≠ community membership.** |
| 7 | The Poipu Kai alias regex is `/\b(?:poipu(?:\s+kai)?|regency\s+at\s+poipu|villas\s+at\s+poipu\s+kai)\b/i` — effectively "title contains *Poipu*." Noisy: excludes a real "Nihi Kai 827" Poipu Kai unit, includes any "Poipu Beach" listing. |
| 8 | SearchApi keys: prod `SEARCHAPI_API_KEY` was the **dead/exhausted** key; `SEARCHAPI_API_KEY_2` is the live 35,000/mo plan (~12,330 used). Repointed this session. |

## Simulation A — geo-only (1km vs 2.5km radius), 90-day rolling 7-night

| Radius | OPEN | SUSPECT |
|---|---|---|
| Tight 1.0 km | 10/13 | 3/13 (Jun 20, Aug 15, Aug 22) |
| Loose 2.5 km | 13/13 | 0/13 |

## Simulation B — faithful to the planned code (exact-BR + Poipu Kai alias + 3mi geo)

| check_in | raw / exact-3BR / alias / final | 6BR final | decision |
|---|---|---|---|
| Jun 20 | 18 / 11 / **0** / 0 | 0 | ⚠️ SUSPECT |
| Jun 27 | 18 / 15 / 4 / 4 | 0 | OPEN |
| Jul 04 | 18 / 10 / 1 / 1 | 1 | OPEN |
| Jul 11 | 18 / 15 / 7 / 7 | 0 | OPEN |
| Jul 18 | 18 / 14 / 14 / 14 | 2 | OPEN |
| Jul 25 | 18 / 16 / 16 / 16 | 1 | OPEN |
| Aug 01 | 18 / 14 / 6 / 6 | 1 | OPEN |
| Aug 08 | 19 / 17 / 8 / 8 | 1 | OPEN |
| Aug 15 | 18 / 13 / 11 / 11 | 1 | OPEN |
| Aug 22 | 19 / 13 / 13 / 13 | 2 | OPEN |
| Aug 29 | 20 / 14 / 5 / 5 | 2 | OPEN |
| Sep 05 | 20 / 13 / 13 / 13 | 1 | OPEN |
| Sep 12 | 18 / 16 / 11 / 11 | 1 | OPEN |

**OPEN 12/13, SUSPECT 1/13.** Geo never excluded anything — **alias was always the binding
constraint.** The lone SUSPECT (Jun 20) is a **false shortage**: 11 real 3BRs existed nearby,
but none happened to carry "Poipu" in the title. This is precisely why an Airbnb-only block is
unsafe and Tier-2 sidecar confirmation is mandatory.

## The methodology (two tiers)

**Tier 1 — Airbnb screen (cheap, daily, ≤~12 months), deduped per `(town, size, week)`:**
dated `engine=airbnb` entire-home search → post-filter by (a) exact bedrooms from
`accommodations`, (b) **alias-name membership** (the precision layer), (c) gps distance as a
loose disambiguator → set test (6BR plan needs ≥1 same-community 6BR; 3BR+3BR needs ≥2 same
3BR; 3BR+2BR needs ≥1 each). ≥1 set → OPEN, 0 → SUSPECT. **Fail-safe OPEN** on any
error/empty/far-future-zero/thin-page.

**Tier 2 — sidecar confirm, only on SUSPECT weeks** (small N): the only same-community-accurate
source. Block on Guesty **only** after Airbnb + sidecar **both** come up empty, confirmed across
2 sweeps. Tier-2 yields to the operator's bulk queue.

**Horizon:** daily ≤21 days, weekly to 365; **block only ≤300 days** (inside Airbnb's fuzzy
listing cliff); far-future stays OPEN for buy-early.

## Quota (recomputed)

12 distinct `(community,size)` cells (town-cache collapses the 3 Koloa communities). Near tier
12 daily windows, far tier 49 weekly windows → **≈ 6,875 calls/month.** With ~12,330 already
used of 35,000, total ≈ 19,200 — fits with ~15,800 spare. Global monthly counter
(`SEARCHAPI_MONTHLY_BUDGET=18000`) caps the gate's own spend.

## Implementation summary (files)

| File | Change |
|---|---|
| `server/availability-search.ts` | `exactBedroomsFromAirbnbListing` + `matchesCommunityName`; town-keyed raw-payload cache (near sweep-scoped / far 7-day TTL); alias-first + exact-BR + loose-geo filter; layered fail-safes; global quota consume |
| `server/sourceability-gate-core.ts` | `generateWeeklyWindows` tiered (daily ≤21 / weekly →365) |
| `server/sourceability-gate.ts` | horizon 90→365; block ceiling 300d; SUSPECT→Tier-2 (mandatory for clustered communities, yields to `bulkAutoFillActive`); cache-hit doesn't advance streak |
| `server/availability-policy.ts` | `isDueForWeeklyPolicyPass` |
| `server/availability-scheduler.ts` | independent near(daily)/far(weekly) latches; stamp timestamp only on `ran===true` |
| `server/search-quota.ts` (new) | global monthly call counter, decremented on fetch only |
| `tests/*` | exact-BR, alias-excludes-Makahuena, tiers/ceilings, set test, fail-safes, cache↔streak, town dedup, quota-stop, Tier-2 matrix |

## Load-bearing decisions

- **Fail-safe is OPEN everywhere.** A false block silently kills revenue.
- **Alias membership — not geo radius — is the same-community precision layer.** Geo is a loose
  (3mi, bounds-derived) disambiguator only.
- **Block ceiling 300d, strictly inside the 365d scan ceiling.** Far-future stays OPEN for buy-early.
- **Dedup cache is per-TOWN, in-memory, sweep/TTL-scoped.** A cache hit never advances the 2-sweep streak.
- **For VRBO-first/clustered communities, an enforced block requires a Tier-2 sidecar double-empty.**
  Airbnb-only cannot block them. Tier-2 ships *with* enforce and yields to the operator's queue.
- **MANDATORY pre-enforce smoke:** verify against live Guesty that a price-only PUT does not reset
  availability `status` (else the daily pricing push would silently unblock the gate).

## Profit-aware gate (CHOSEN direction, 2026-06-17) — Airbnb high-end as assumed buy-in cost

Availability rarely binds in liquid Poipu; the real pain is **profit** (sold a 6BR for \$12k,
cheapest combo \$18.6k). The chosen design adds a profit gate computed **for free** from the
**same Airbnb fetch** already used for availability — no extra API calls, no sidecar for the
common case:

- `assumedCost` = **p90 / near-max** (operator choice: most conservative) of same-community,
  same-size, **own-listings-excluded** Airbnb nightly × nights, over the **cheapest sourcing
  path** = `min(2 × 3BR, 1 × 6BR)`.
- `sellPrice` = our **actual Guesty calendar price** for the week (sum of 7 nightly `price`).
- **BLOCK if** `assumedCost > sellPrice × (1 − minMargin)` (loss). Plus the availability path
  (0 sets → SUSPECT → sidecar). Both run through the 2-sweep confirm + fail-safe-OPEN.

### Live validation (Poipu Kai 6BR combo, listing `69e14c85c7e5d000139296a5`, real sell prices)

| Check-in | Sell/wk | Cost (p90) | Path | Margin | Gate |
|---|---|---|---|---|---|
| Jun 27 | $15,981 | $10,812 | 3+3 | +32% | OPEN |
| Jul 11 | $13,895 | $12,445 | 3+3 | +10% | OPEN |
| Jul 25 | $13,895 | $13,895 | 6BR | 0%* | OPEN |
| Aug 01 | $13,895 | $11,800 | 3+3 | +15% | OPEN |
| **Aug 29** | **$10,843** | **$10,857** | 3+3 | **−0%** | **BLOCK (loss)** |
| Sep 12 | $8,554 | $8,554 | 6BR | 0%* | OPEN |

**BLOCK 1/13, OPEN 11/13, SKIP 1/13** (Jun 20 had no same-community comps → fail-safe open).
\*0% weeks are self-reference artifacts — see rule 1.

### Two load-bearing data-quality rules the validation exposed

1. **Exclude our own listings from the cost pool.** Our "Poipu Kai - 6BR Villas" ($1,985/n)
   appears in the Airbnb 6BR results; including it pins `cost ≈ sell` (the exact-0% weeks).
   Filter the cost pool by our Guesty listing id / nickname / title before computing the percentile.
2. **p90 is noisy run-to-run.** Aug 01's p90 swung $31.5k → $11.8k between two fetches as one
   luxury listing appeared/vanished. p90/near-max is outlier-sensitive, so the **2-sweep
   confirmation + light tail-trim (drop the top outlier on small n)** are load-bearing — a single
   noisy p90 must never block alone.

### Implementation delta (on top of the availability plan above)
- In the per-`(community,size,week)` cell, alongside the availability count, compute
  `highEndNightly` = trimmed p90 of own-excluded same-community same-size `extracted_total_price/nights`.
- New helper `assumedComboCost(plan, highEndBySize, nights)` = cheapest sourcing path.
- `decideSourceability` gains a **loss branch**: `block` when `assumedCost > sell×(1−minMargin)`,
  fed by a new `sellPriceForWindow(propertyId, window)` that reads the Guesty calendar
  (`/availability-pricing/api/calendar/listings/{id}`, sum 7 nightly `price`).
- Env: `SOURCEABILITY_GATE_COST_PERCENTILE` (default 0.90), `SOURCEABILITY_GATE_MIN_MARGIN`
  (default 0), `SOURCEABILITY_GATE_PROFIT_ENABLED`.
- Fail-safe: no own-excluded comps, or no sell price ⇒ **skip** (never block on missing data).
