// One-off Grok consultation about our Vrbo scraping architecture.
//
// xAI's API is OpenAI-compatible. We send a detailed methodology brief
// covering all five paths we've tried + their failure modes + the
// constraints/tools we have, and ask Grok for the most reliable
// architecture to extract priced+all-in Vrbo results.
//
// Exposed at GET /api/operations/grok-vrbo-consult — call once,
// inspect the response, implement the recommendation. Module-scoped
// to keep the brief in source control (auditable).
//
// Env: XAI_API_KEY

const VRBO_METHODOLOGY_BRIEF = `
We're building a vacation-rental cross-listing tool. When an operator
takes a guest reservation on one channel (e.g. Airbnb), our system
finds equivalent inventory on Vrbo / Booking / property-management
sites at the same resort for the same dates. The operator buys the
match cheaper, pockets the spread.

GOAL: Given a destination ("Poipu Kai, HI"), bedroom count (e.g. 3),
check-in (2026-09-12), and check-out (2026-09-19), return a list of
priced Vrbo properties with ALL-IN totals in USD (base + cleaning +
service fees + taxes). The all-in is what we'd pay if we booked.

WHAT'S WORKING — for property-management sites that use the WordPress
\`vrp_main\` plugin (Parrish Kauai, CB Island Vacations):
  - Sitemap walk → per-unit metadata via data-unit-* HTML attributes
    → public AJAX endpoints \`/?vrpjax=1&act=getUnitRates&unitId=N\`
    and \`/?vrpjax=1&act=getUnitBookedDates&par=<slug>\`.
  - For Amy's Christmas/NYE 2026 3BR Poipu Kai window we get 2
    priced+available units ($15,745, $19,591) end-to-end.

WHAT'S NOT WORKING — Vrbo specifically. Five parallel paths attempted:

PATH 1: Apify with easyapi/vrbo-property-listing-scraper
- Build Vrbo search URL: vrbo.com/search?destination=Koloa,+HI,+United+States
  &d1=2026-09-12&startDate=2026-09-12&d2=2026-09-19&endDate=2026-09-19
  &flexibility=0_DAY&adults=2&isInvalidatedDate=false&sort=RECOMMENDED
- POST to Apify run-sync-get-dataset-items.
- RESULT: HTTP 201 success, but rawItemsCount=0 consistently across
  multiple destinations. Actor's documented working URL example
  includes regionId=652645981589159936 and latLong=39.09,-120.03 for
  Lake Tahoe — without those, Vrbo's search page returns autocomplete
  interstitial / blank state.

PATH 2: Browserbase regionId resolver
- Fetch Vrbo's destination SEO page (vrbo.com/lodging/koloa-vacation-rentals)
  via Browserbase residential proxy, extract regionId from
  __APP_INITIAL_STATE__ window blob or JSON-LD <script> blocks.
- RESULT: resolver returns null. Either Vrbo's destination page
  doesn't ship regionId in HTML anymore (likely client-rendered now
  via React hydration), or our regex doesn't match the current shape.

PATH 3: Browserbase-driven Vrbo search
- Browserbase Chrome navigates to vrbo.com/search?... directly,
  Accept-Language: en-US, set_pi_session_currency=USD cookie, all
  date params in URL.
- Capture every vrbo.com/graphql response body, walk JSON for
  arrays of objects with URL + price shape.
- Captured ops include: getSessionConfig, oneKeyUniversalOnboarding,
  socialShareButton, randomAccessOne, productSpotlight,
  managedBannerContent, notification, propertyOffers (which contains
  a stickyBar.price.formattedDisplayPrice string like "$820" — the
  LEAD per-night rate, NOT the trip total), summary,
  experienceScoreInfo, aboutTheHost.
- RESULT: 0 priced. The search-page graphql ops captured don't
  include the trip-total query that fires on the booking widget;
  they're metadata for a single property page (Vrbo seems to redirect
  some search URLs to property pages or the search results aren't
  populating without disambiguators).

PATH 4: ScrapingBee with render_js=true & stealth_proxy=true
- Same Vrbo search URL via ScrapingBee. Parse __NEXT_DATA__ SSR blob.
- RESULT: 0 priced. Either Vrbo serves a near-empty SSR shell with
  results loaded post-hydration, or our walker misses the cards in
  the parsed JSON.

PATH 5: Outscraper at https://api.app.outscraper.com/vrbo-search
- RESULT: HTTP 404 (wrong endpoint slug — auth working since 404
  rather than 401). We don't know the correct Outscraper service
  slug for Vrbo.

PATH 6 (BASELINE, free): Google site:vrbo.com via SearchAPI
- Returns 8 unpriced URLs from Google's index. Operator can click
  through but no price data. Currently the ONLY path returning
  anything for the find-buy-in flow.

WORKING REFERENCE — individual Vrbo property page scraper
- For a SPECIFIC vrbo.com/<id> URL with arrival/departure params,
  Browserbase captures PropertyRatesDateSelectorQuery (the
  per-night rate calendar). Sums per-night displayPrice for the
  stay window → base nightly sum (~$497-$1,467/night USD depending
  on session locale, NOT all-in).
- The all-in total isn't in PropertyRatesDateSelectorQuery; it
  fires from a separate quote query that requires user interaction
  in the booking widget.

CONSTRAINTS
- Direct curl/WebFetch to vrbo.com or api.vrbo.com gets 429
  rate-limited from any non-residential IP.
- Vrbo's search page (/search?...) is more aggressively anti-botted
  than individual property pages (/<id>). Both Browserbase
  residential and ScrapingBee stealth-proxy come back with empty
  search results despite working on individual property pages.

AVAILABLE TOOLS (API keys on Railway)
- ANTHROPIC_API_KEY — Claude for vision / agent loops
- BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID — stealth Chrome,
  residential proxies, geolocation pinning, computer-use agents
- APIFY_API_TOKEN — actors, run-sync, web-scraper / cheerio-scraper
  generic actors available
- SCRAPINGBEE_API_KEY — render_js, stealth_proxy, country_code
- OUTSCRAPER_API_KEY — Outscraper services (don't know the right
  Vrbo slug)
- SEARCHAPI_API_KEY — Google search engine

QUESTION
Given the constraints and tools above, what's the most reliable
architecture to get priced+all-in Vrbo results for a destination +
date range? Specifically:

1. What's the actual Outscraper Vrbo endpoint slug? Do you know
   their service catalog? (We tried /vrbo-search → 404.)

2. Is there an Apify actor for Vrbo that's more mature / actually
   works? We've tried makework36/vrbo-scraper (returned 0) and
   easyapi/vrbo-property-listing-scraper (returns 0 without
   regionId).

3. For getting Vrbo's all-in trip total: does Vrbo's GraphQL
   schema have a quote query name we should be looking for? Our
   Browserbase captures only metadata ops on initial load; what
   triggers the quote query and how do we capture it?

4. Could we use Vrbo's own destination autocomplete API
   programmatically to resolve regionId for a destination? What's
   the endpoint?

5. Is there a fundamentally different approach we should consider
   — e.g., scraping a meta-search aggregator (Trivago, Hotels.com)
   that already includes Vrbo inventory with all-in totals?

6. Anything else we're missing?

Be specific. We need actionable code-level recommendations, not
generic "consider X" advice. Treat this as a technical review of
our architecture from a senior scraping engineer's perspective.
`.trim();

export async function consultGrokAboutVrbo(): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return "XAI_API_KEY not set on Railway";

  // xAI is OpenAI-compatible. Default to grok-4 as that's their
  // current flagship; older deploys may need grok-2 or grok-beta.
  const model = process.env.XAI_MODEL || "grok-4";
  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a senior web-scraping architect with deep knowledge " +
              "of Vrbo's frontend, GraphQL schema, and the major scraping " +
              "vendors (Apify, ScrapingBee, Outscraper, Browserbase). You " +
              "provide specific, actionable, code-level recommendations.",
          },
          { role: "user", content: VRBO_METHODOLOGY_BRIEF },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return `xAI HTTP ${r.status}: ${body.slice(0, 800)}`;
    }
    const data = await r.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? "(no content in response)";
    const usage = data?.usage ?? {};
    return `MODEL: ${data?.model ?? model}\nUSAGE: ${JSON.stringify(usage)}\n\n${content}`;
  } catch (e: any) {
    return `xAI request error: ${e?.message ?? e}`;
  }
}
