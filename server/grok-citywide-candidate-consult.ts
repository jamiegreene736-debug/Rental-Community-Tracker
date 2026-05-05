// One-off Grok consultation about the find-clean-unit city-wide
// candidate-pool problem.
//
// 2026-05-04: Jamie reported that a city-wide search for an entire
// city (Fort Myers Beach, FL — population ~6k, but heavy condo
// inventory) only surfaces ~35 unique candidate URLs even after we
// widened the query set + bumped num=20 + raised the candidate cap
// to 60. Of those 35, ~16 turned out to be Zillow OFF-MARKET STUB
// listings (no bed/bath data, no photos, just a slug + a satellite
// image), 8 were already on Airbnb/VRBO, 2 sold, 1 wrong type — so
// 0 of 35 were viable single-listing candidates.
//
// We need Grok's architecture review: how do we get a much bigger,
// higher-quality candidate pool for an entire-city search?
//
// xAI's API is OpenAI-compatible. Env: XAI_API_KEY.
// Exposed at GET /api/operations/grok-citywide-candidate-consult.

const BRIEF = `
We're building a "find a clean condo unit" pipeline for a vacation-
rental management portal. The operator picks a city (e.g. "Fort Myers
Beach, FL"), and we scan public real-estate listing sites for condos
that are NOT already listed on Airbnb / VRBO / Booking.com — those
clean units become candidates the operator imports into their PMS as
new managed properties.

PROBLEM: city-wide search only finds ~35 candidates for an entire
city, and most of those are unusable.

CURRENT IMPLEMENTATION (Node.js / Express, deployed on Railway):

Stage 1 — Candidate URL discovery via SearchAPI Google engine.
We run 7-8 site-restricted Google queries per platform (Zillow +
Realtor.com), in parallel, num=20:

  site:zillow.com condo "Fort Myers Beach" "Florida"
  site:zillow.com condominium "Fort Myers Beach" "Florida"
  site:zillow.com townhouse "Fort Myers Beach" "Florida"
  site:zillow.com "Fort Myers Beach, Florida" condo
  site:zillow.com/homedetails "Fort Myers Beach" "Florida" condo
  site:zillow.com apartment "Fort Myers Beach" "Florida"
  site:zillow.com condo for sale "Fort Myers Beach" "Florida"
  site:zillow.com "Fort Myers Beach" "Florida" condo townhouse
  (mirrored for site:realtor.com)

Filter URLs by /homedetails/ (Zillow) or /realestateandhomes-detail/
(Realtor). Dedupe. Cap at 60 candidates.

Result for Fort Myers Beach: 35 unique URLs total. We never hit the
60 cap — Google's index for site:zillow.com + city-name simply
doesn't return more than ~35 unique homedetails URLs even across 8
query variations. SearchAPI returns 10-20 results per query, but
they overlap heavily across query variations.

Stage 2 — Per-candidate scrape (Apify "Zillow Detail Scraper" first,
ScrapingBee fallback, residential-IP Chrome sidecar last) +
extraction of bedrooms/bathrooms/photoCount/homeType/propertySubType
from JSON-LD + __NEXT_DATA__.

Stage 3 — Reject:
  - Pre-filter against OTA address index (community mode only — OFF
    in city-wide; we have no community to scope OTA index queries to)
  - Stub listing (bedrooms == null after scrape) → rejected
  - photoCount < 3 → rejected
  - Wrong homeType (single_family, lot, manufactured, mobile)
  - Wrong propertySubType (lot, land, mobile, co-op)
  - homeStatus in {RECENTLY_SOLD, SOLD, AUCTION, FORE_AUCTION, PENDING}

Stage 4 — OTA qualifier (3× SearchAPI Google site: queries against
airbnb.com/vrbo.com/booking.com for "<address> <city>") plus up to
3× Google Lens reverse-image-search on the scraped photos. Reject
if listed on any OTA.

Real run, Fort Myers Beach city-wide, "Any" bedrooms:
  35 candidates discovered
  27 processed before user cancelled
    16× Stub / off-market listing
    8× Listed on Airbnb / VRBO / Booking
    2× Sold / auction / pending
    1× Wrong property type
  0 clean

The 16 stubs are particularly painful — Zillow has tons of
"off-market" homedetails URLs that match our slug filter but have
zero useful data. They burn ~10-15s of Apify+HTML-fallback per
candidate before we reject them.

CONSTRAINTS:
- We have ANTHROPIC, SEARCHAPI, BROWSERBASE, APIFY, OUTSCRAPER,
  SCRAPINGBEE, OPENAI keys.
- We have a residential-IP Chrome "sidecar" daemon on the operator's
  home network for slow but high-trust fetches.
- 12-min wall budget per city-wide search. ~15-25s per Apify scrape
  + qualifier round-trip.
- Scope is currently Florida + Hawaii vacation markets (Fort Myers
  Beach, Naples, Panama City Beach, Kauai, Maui, etc.).

QUESTIONS:

1. CANDIDATE-POOL EXPANSION — bypass Google entirely:
   What's the right Apify actor (or alternative) to query Zillow's
   own search-results API for "all condos in Fort Myers Beach FL"
   and get 200-500 listing URLs back? Same question for Realtor.com.
   Specific actor names + ID + cost-per-1k preferred.

2. STUB-LISTING ELIMINATION upstream:
   Is there a discovery method that ONLY returns ACTIVE listings
   (i.e. for-sale or for-rent right now), filtering out off-market
   stubs at discovery time? Zillow's Search REST API has filters
   like \`isForSale: true\` — can we hit those via a public/scraped
   endpoint without our own MLS feed? Apify actors that respect
   "for sale only"?

3. ALTERNATIVE LISTING SOURCES we haven't considered:
   We currently use Zillow + Realtor.com. Trulia (Zillow-owned),
   Redfin, Homes.com, Movoto, Coldwell Banker, RE/MAX, Compass —
   any of these have public listings APIs (or public search HTML)
   that would surface MORE inventory in a coastal Florida city than
   site:zillow.com Google does? Specific URL patterns + scrape
   feasibility ratings preferred.

4. ZIP-CODE DRILL-DOWN:
   Should we query by ZIP code (Fort Myers Beach ≈ 33931) instead
   of city name? Does Zillow's search return more URLs when scoped
   to a single ZIP vs a city name (which can include neighbors)?

5. RENTAL LISTINGS (not for-sale):
   We've been searching for-sale listings. Most coastal-Florida
   condos are vacation rentals already — should we be searching
   rental listings (Zillow Rental Manager / Rent.com / Apartments.
   com / RentByOwner) and then filtering OUT the ones already on
   Airbnb/VRBO? The operator doesn't need to BUY the unit, just
   identify it; rental listings might have a much bigger pool in
   tourist markets.

6. PAGINATION on Google site: queries:
   SearchAPI's Google engine accepts \`start=20\`, \`start=40\` for
   pagination. We're currently only fetching the first page per
   query. Is paginating to 5 pages × 8 queries = 40 SearchAPI calls
   too aggressive for the budget? What's the diminishing-returns
   curve on Google site: query pagination?

7. SHORT-CIRCUIT THE STUBS:
   Can we tell from a Zillow URL slug alone whether it's a stub vs
   an active listing — without scraping? URL pattern signals that
   correlate with off-market status?

8. ARCHITECTURAL ALTERNATIVE:
   Should we maintain a curated, periodically-refreshed inventory
   per city (e.g. nightly Apify run of all Fort Myers Beach condos,
   stored in our DB), and the find-clean-unit search just queries
   that local DB + the OTA-presence check? Costs scraper budget
   nightly but turns a 12-min search into a 30s search.

Be specific. Code-level recommendations preferred. Treat this as a
technical architecture review by a senior real-estate-data
sourcing architect.
`.trim();

export async function consultGrokAboutCitywideCandidates(): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return "XAI_API_KEY not set on Railway";

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
              "You are a senior web-scraping and real-estate-data " +
              "architect. You know Zillow's, Realtor.com's, Trulia's, " +
              "Redfin's, Homes.com's public surfaces, the major Apify " +
              "actors (and their costs), Outscraper, ScrapingBee, " +
              "Browserbase, and SearchAPI. You give specific actionable " +
              "code-level recommendations, not high-level strategy. " +
              "When you cite a vendor product (Apify actor, etc.), " +
              "include the actor ID and cost-per-1k where you know it.",
          },
          { role: "user", content: BRIEF },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(180_000),
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
