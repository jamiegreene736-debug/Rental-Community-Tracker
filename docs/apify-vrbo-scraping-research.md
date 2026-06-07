# Can Apify replace the local-Chrome VRBO sidecar? — Research & Plan

**Date:** 2026-06-07
**Author:** Claude Code (`claude/apify-vrbo-scraping-research`)
**Status:** Research + recommendation. **No production code changed.**

---

## TL;DR

- The sidecar exists for **one specific, documented reason**: VRBO's anti-bot
  (PerimeterX / "HUMAN Security") flags us at the **IP layer**. From a
  datacenter IP — *including Apify/Browserbase/ScrapingBee residential
  proxies* — the search either returns 0 priced results or sits behind a
  slider/"press-and-hold" CAPTCHA that stays blocking even after a manual
  solve. From the operator's **real residential IP + real Chrome + real
  logged-in cookies**, the same query returns full priced inventory
  (Decision Log 2026-04-29: 42 priced properties vs. Browserbase's bot wall).
- We have **already tried two Apify approaches** against the VRBO **web**
  frontend (`easyapi/vrbo-property-listing-scraper` and the generic
  `apify/web-scraper`). Both **construct a `vrbo.com/search?...` URL**, which
  is the **#1 documented trigger** for the persistent slider CAPTCHA. Both
  consistently returned **0 results** and are now **explicitly deprecated**
  for buy-in (see `server/apify-vrbo.ts` header + AGENTS.md VRBO policy).
- **However**, there is a genuinely **new and different** option that did not
  exist (in mature form) when those decisions were made: the
  **`makework36/vrbo-scraper` ("VRBO Scraper 2026")** actor now claims to scrape
  via **Expedia's official mobile API endpoint** (mobile-app User-Agent +
  headers) rather than driving the public web SRP. That is a **different attack
  vector** that, in principle, sidesteps both the URL-injection CAPTCHA trigger
  *and* the web-frontend fingerprinting — the two things that killed every
  prior datacenter approach.
- **Recommendation:** keep the sidecar as canonical. Run a **bounded, ~$5,
  one-day spike** to test the mobile-API actor against our two real benchmark
  queries (Princeville city-wide ~210; Poipu Kai resort, date-specific
  totals). If it returns date-specific all-in totals at full coverage from a
  datacenter IP, it becomes a strong candidate to **remove the Mac dependency**
  — but it needs operator sign-off because it is a **new vector not covered by
  the existing "no injected VRBO URL" policy**, and reverse-engineered private
  endpoints are fragile/ToS-adjacent.

---

## 1. What the sidecar actually does today

Two VRBO search modes, both driven through the operator's real Chrome on their
real home IP (`daemon/vrbo-sidecar/worker.mjs`, entry `searchVrboViaSidecar`
in `server/vrbo-sidecar-queue.ts`):

1. **Resort-name search** — types the resort/community prefix into VRBO's
   visible destination field, picks a confirmed autocomplete suggestion
   (filtered by the community-token policy), uses the visible date controls,
   clicks the visible Search button. Used by `find-buy-in` /
   `multichannel-buy-in.ts`.
2. **City-wide full inventory** — `searchVrboViaSidecar({cityWideInventory:true})`
   via `server/city-vrbo-inventory.ts`. Exports a city's *entire* VRBO
   inventory (~210 for Princeville, ~5 SRP pages of 50) by walking the real
   blue "Next" control and DOM-harvesting each page.

### The "GraphQL" mechanism is **passive capture + replay, not a direct API call**

The user described it as "GraphQL or other methods." Precisely (worker.mjs
~L5383–L6114, L7736–L7874):

- The worker **passively intercepts** VRBO's own `propertySearchListings`
  GraphQL request/response as the **real browser** issues it
  (`isVrboPropertySearchGraphqlOperation`, `collectVrboPropertySearchListings`).
- It then **replays that captured request template** *within the same
  authenticated, real-IP, real-cookie session* to paginate
  (`paginateVrboGraphqlInventory`).
- It does **not** forge a GraphQL query from scratch against a cold
  connection. The GraphQL leg only works *because* it rides on a session that
  already passed PerimeterX's IP/TLS/fingerprint/behavior checks via the real
  Chrome. On the list view, replay alone yields 0 rows, so the **UI page-walk**
  (`walkVrboResultsUiPages`) owns city-wide pagination.

**Key takeaway:** the sidecar's value is *not* the GraphQL trick. It's the
**trusted session context** (residential IP + real browser fingerprint + real
cookies + human-like sight-and-click) that the GraphQL/UI harvest rides on.
Anything that wants to replace it has to reproduce *that*, not just the parse.

---

## 2. Why we use the sidecar — the original rationale (from the notes)

| Source | Finding |
|---|---|
| **Decision Log 2026-04-29** (the founding decision) | Operator: "You have to run the browser on my PC." Multi-PR investigation showed VRBO's anti-bot **fingerprints every Browserbase residential session even with persistent context + real-Chrome cookies** — an **IP-level flag** ("There is a robot on the same network as you"). Direct Chrome from the operator's home IP returned **42 priced properties** for the same query Browserbase couldn't load past the bot wall. → New local-Chrome sidecar architecture. |
| **AGENTS.md "VRBO / OTA Buy-In Search Policy"** (L40–65) | **Never inject a pre-constructed `vrbo.com/search?...` URL** — *"even 'realistic' ones via Apify, ScrapingBee, Browserbase, or manual `page.goto`"*. Direct URL navigation is the **#1 trigger for slider CAPTCHA that frequently remains blocking even after manual solve.** Hard runtime guard `assertSafeVrboNavigation` throws on any violation. Names `apify-vrbo` and `browserbase-vrbo-search` as legacy/deprecated for VRBO. |
| **`server/apify-vrbo.ts`** (header, L3–9) | "⚠️ DEPRECATED FOR VRBO BUY-IN. Direct construction of `vrbo.com/search` URLs is the #1 cause of persistent slider CAPTCHA … All production VRBO search for buy-in must go through the sidecar." |
| **`server/apify-vrbo.ts`** (L29) | `makework36/vrbo-scraper` was "Tried first (returned 0 consistently — actor is brand new with only ~21 lifetime runs and may not be reliable yet)." |
| **`server/apify-vrbo-web-scraper.ts`** (L1–25) | The generic `apify/web-scraper` path was a "seventh path" attempt after easyapi + makework36 "keep returning 0 raw items." Still injects a `vrbo.com/search` start URL. |
| **`daemon/.../README.md`** ("greatest hits") | The web-SRP path is also **brittle**: VRBO changed `data-stid` selectors (#301), card price format (#299), removed the Filters button (#301). The sidecar absorbs these with anchor-fallback selectors; a vendor actor breaks until its author patches it. |

**Net:** the sidecar is not a preference — it's the only path proven to beat
VRBO's IP-level bot wall, and the "no injected URL" rule is a hard-won
CAPTCHA-avoidance constraint. Every datacenter-IP / web-frontend approach we
tried (Apify easyapi, Apify web-scraper, Browserbase, ScrapingBee, Stagehand)
either hit the bot wall or returned 0.

---

## 3. Current state of Apify VRBO actors (web research, June 2026)

There are several VRBO actors on Apify. They split into **two fundamentally
different categories**, and the distinction is the whole ballgame:

### Category A — drive the VRBO **web** SRP (what we already tried, **don't revisit**)
- `easyapi/vrbo-property-listing-scraper` — takes a `vrbo.com/search` URL. **In our code, deprecated.**
- `apify/web-scraper` (our `apify-vrbo-web-scraper.ts`) — injects a `vrbo.com/search` start URL + page function.
- `jupri/vrbo-property` (Extractor 4.0), `parseforge/vrbo-scraper`,
  `ecomscrape/vrbo-property-search-scraper`, `powerai/*` — browser/web-based.

These all rely on rendering/hitting the **public web frontend** behind
PerimeterX. Per our own history *and* the 2026 anti-bot literature (Scrapfly,
ZenRows, ScrapingBee on bypassing PerimeterX/HUMAN press-and-hold), success
from a datacenter or proxy IP is unreliable and an arms race. **Re-testing
these is not worth it** — it re-litigates the 2026-04-29 decision.

### Category B — the **mobile-API** vector (genuinely new, **worth testing**)
- **`makework36/vrbo-scraper` — "VRBO Scraper 2026"**. Its current store page
  states it scrapes via **Expedia's official mobile API endpoint** using the
  **official mobile app's User-Agent + headers**, which it claims **bypasses
  both Akamai Bot Manager and DataDome** (the challenges that block
  conventional web scrapers).
  - **Input schema:** `locations[]` (cities/neighborhoods/regions),
    `checkIn`/`checkOut` (YYYY-MM-DD), `adults`, `maxResults` per location
    (1–500), `currency`, `locale`. → matches our exact need (date window +
    location + cap).
  - **Method:** HTTP-only (no browser), ~2s/page, ~10× faster than
    browser-based VRBO scrapers; a 500-property scrape in ~20s.
  - **Cost:** ~$2.50 / 1,000 property results (+ Apify residential proxy +
    compute at standard rates). A 50-property search ≈ $0.13.
  - **This is the SAME actor id** already in our code as the `makework36`
    fallback — but it has **matured** since the "~21 lifetime runs, returns 0"
    note. Whether it now returns **date-specific all-in totals** (vs. headline
    "from $X" nightlies) is the single most important thing to verify.

**Caveat from research:** VRBO has **no official public API** for general
developers (Expedia's Rapid `/calendars/availability` is partner-gated). So a
"mobile API" actor is **reverse-engineering a private endpoint** — it can break
without notice and sits in a grey ToS area. That's a durability/risk
consideration, not necessarily a blocker for an internal tool.

---

## 4. Assessment — would Apify be effective?

### What Apify can plausibly do well
- **City-wide full inventory** (the Princeville ~210 use case). A mobile-API
  actor with `maxResults: 500` + auto-pagination is *purpose-built* for this,
  and is far simpler/faster than our UI page-walk + GraphQL-replay machinery.
- **Remove the single biggest operational fragility:** the dependency on the
  operator's Mac being awake, on the right network, with a healthy launchd
  daemon, fresh cookies, and Chrome not flapping (see the long string of
  sidecar focus/relaunch fixes in CLAUDE.md, through 2026-06-07).

### Where Apify is likely to fall short / needs proof
1. **The IP wall is the crux.** Category-A web actors fail for the documented
   IP-level reason. Category-B *might* sidestep it because the mobile API has
   different (often weaker) bot protection than the web SRP — **but this is
   exactly the unproven claim that must be tested**, not assumed.
2. **Date-specific all-in totals.** Our buy-in math needs the **total for the
   requested dates** (the whole point — `apify-vrbo.ts` parses `price.total`).
   Many actors return headline/"from" nightly rates that inflate via
   cleaning/fees. Must verify the mobile-API actor returns true date-windowed
   totals.
3. **Resort resolution.** VRBO search resolves **cities/regions, not individual
   resorts** — `easyapi` returned 0 for "Poipu Kai" until we mapped it to the
   city. The mobile API almost certainly has the same limitation, so we'd
   reuse our existing **city search + post-hoc `mentionsResort` token filter**
   (already implemented in `apify-vrbo.ts` `matchesResort`). This is fine — the
   city-wide path already works this way.
4. **Policy collision.** AGENTS.md's "no injected VRBO URL — even via Apify"
   rule was written about the **web frontend**. A **mobile-API** actor is a
   *new category the policy doesn't explicitly cover* (it never touches
   `vrbo.com/search`). Adopting it is an **intentional deviation** that needs
   an operator decision + a new Decision Log line, not a silent swap.
5. **Durability.** A reverse-engineered private endpoint + a third-party actor
   = two layers that can break without us controlling either. The sidecar
   breaks too (selector churn), but *we* can patch it same-session.

### Verdict
- **As a drop-in replacement of the sidecar via web-SRP actors: No.** That
  re-runs a failed experiment and violates a load-bearing rule.
- **As a NEW mobile-API path worth a real, bounded test: Yes** — specifically
  `makework36/vrbo-scraper`. If it proves out, it's the most promising route to
  finally cut the Mac dependency, ideally as a **parallel/primary path with the
  sidecar as fallback**, not an outright deletion.

---

## 5. Proposed plan (bounded, low-cost, reversible)

### Phase 0 — Spike (½–1 day, ~$5 of Apify credit, **no app wiring**)
Run `makework36/vrbo-scraper` directly via the Apify API (we already hold
`APIFY_API_TOKEN`) against our two real benchmarks and score the output:

1. **Princeville city-wide**, e.g. 2026-07-20 → 2026-07-27, `maxResults: 500`.
   - ✅ coverage vs. the sidecar's ~210 benchmark?
   - ✅ returns `vrbo.com/<id>` property URLs + bedrooms + image?
2. **Poipu Kai resort** (search city "Koloa, HI", 3BR), a known date window.
   - ✅ does `mentionsResort` post-filter recover the resort units?
   - ✅ **date-specific all-in total present and sane** (not a 1-night "from"
     price)?
3. Score: block rate (any DataDome/empty?), latency, $ per run, field
   completeness vs. `SidecarVrboCandidate` (url, title, total, nightly, beds,
   image, lat/lng).

**Decision gate:** if (1) coverage ≥ ~80% of sidecar, (2) real date-windowed
totals, (3) no block from Railway's datacenter IP → proceed to Phase 1.
Otherwise: document the failure mode in this file + a Decision Log line, and
**stop** (sidecar stays sole path).

### Phase 1 — Wire as a *parallel* path behind the existing interface (if gate passes)
- Add `searchVrboViaApifyMobile()` (new module, e.g. `server/apify-vrbo-mobile.ts`)
  that returns the **same `SidecarVrboCandidate` shape** the sidecar/city
  pipeline already consumes (`city-vrbo-inventory.ts`, `multichannel-buy-in.ts`).
- Gate behind an env flag (`VRBO_APIFY_MOBILE_ENABLED`, default off). Run it
  **in parallel** with `searchVrboViaSidecar`; merge/dedupe by VRBO id; prefer
  whichever returns first with priced, date-specific results. This mirrors the
  existing multi-path dedupe pattern — no behavior change when the flag is off.
- **Do not** route it through any `vrbo.com/search` URL construction — it's an
  actor input (`locations`/`checkIn`/`checkOut`), so `assertSafeVrboNavigation`
  is irrelevant (it never drives our browser). Note this explicitly in code.

### Phase 2 — Promote / retire (only after live soak)
- If the mobile path proves reliable over ~1–2 weeks of real buy-in traffic,
  promote it to **primary** and demote the sidecar to **fallback** (keeps the
  real-IP escape hatch when the actor breaks). Only consider fully retiring the
  Mac daemon after a long clean soak.
- Update AGENTS.md: add a Load-Bearing entry distinguishing **mobile-API
  (allowed)** from **web-SRP URL injection (still banned)**, plus a Decision
  Log line capturing the operator's call.

### Operator decisions needed before Phase 1
1. OK to adopt a **mobile-API actor** as a new VRBO vector (intentional
   deviation from the "no Apify for VRBO" posture, which was about the web
   frontend)?
2. Comfort level with depending on a **third-party reverse-engineered endpoint**
   for a money-flow tool (vs. keeping the sidecar as the durable fallback)?

---

## 6. Files referenced
- `server/vrbo-sidecar-queue.ts` — `searchVrboViaSidecar` (canonical path).
- `server/city-vrbo-inventory.ts` — city-wide export pipeline + candidate shape.
- `server/multichannel-buy-in.ts`, `server/routes.ts` — buy-in call sites.
- `daemon/vrbo-sidecar/worker.mjs` — sight+click + GraphQL capture/replay + UI walk.
- `server/apify-vrbo.ts`, `server/apify-vrbo-web-scraper.ts` — **deprecated** web-SRP Apify paths.
- `AGENTS.md` — VRBO Buy-In Search Policy; Decision Log 2026-04-29 (founding sidecar decision).

## 7. Sources (web research, June 2026)
- [VRBO Scraper 2026 — makework36 · Apify](https://apify.com/makework36/vrbo-scraper) ([input schema](https://apify.com/makework36/vrbo-scraper/input-schema))
- [Vrbo Property Search Scraper — ecomscrape · Apify](https://apify.com/ecomscrape/vrbo-property-search-scraper)
- [VRBO Property Listing Scraper — easyapi · Apify](https://apify.com/easyapi/vrbo-property-listing-scraper/api)
- [Apify Proxy](https://apify.com/proxy) · [Scrape the web without getting blocked · Apify](https://apify.com/anti-blocking)
- [How to Bypass PerimeterX when Web Scraping in 2026 — Scrapfly](https://scrapfly.io/blog/posts/how-to-bypass-perimeterx-human-anti-scraping)
- [How to Bypass PerimeterX (HUMAN Security) in 2026 — ZenRows](https://www.zenrows.com/blog/perimeterx-bypass)
- [Bypass PerimeterX anti-bot in 2026 — ScrapingBee](https://www.scrapingbee.com/blog/how-to-bypass-perimeterx-anti-bot-system/)
- [Vrbo Availability Calendar — Expedia Group Developer Hub (partner-gated Rapid API)](https://developers.expediagroup.com/rapid/lodging/vacation-rentals/vrbo-availability-calendar)
