// CODEX NOTE (2026-05-04, claude/single-listing-stub-filter):
// One-off Grok consultation about the single-listing wizard's
// find-clean-unit + photo-scraper architecture.
//
// Sister to server/grok-find-unit-consult.ts (which covered the
// combo-flow replacement-photo discovery). This brief is scoped
// to the new "Add a Single Listing" wizard:
//   /api/single-listing/find-clean-unit (server/routes.ts)
//   client/src/pages/add-single-listing.tsx
// where the operator picks {community, bedrooms} and we discover
// a clean Zillow unit via SearchAPI Google + Apify scrape + an
// OTA cross-listing check (text-search + Google Lens reverse-
// image-search per Load-Bearing #38).
//
// Operator hit two false-positive / dead-end failure modes:
//   1. "Off market" Zillow stub URLs with no beds/baths/sqft
//      passing the text-only fallback path (no OTA match because
//      there's no real unit there to be on Airbnb either).
//   2. Apify+ScrapingBee both returning 0 photos for ~6
//      consecutive candidates at the same resort, even on
//      well-known vacation rental complexes (Santa Maria Resort,
//      Fort Myers Beach).
//
// We added basic stub filtering (homeType / homeStatus / bedroom
// data presence) but want a senior architect's take on what the
// MORE robust unit finder + photo scraper would look like.
//
// xAI's API is OpenAI-compatible. Env: XAI_API_KEY.
// Exposed at GET /api/operations/grok-single-listing-consult.

const SINGLE_LISTING_BRIEF = `
We're building a vacation-rental dashboard ("NexStay"). New tool:
"Add a Single Listing" wizard for onboarding standalone vacation
rental condos / townhouses (one unit at a time, NOT combo).

WIZARD FLOW (4 steps):
  Step 1 — Operator picks city → top-20 communities (Claude-Sonnet
    research with named-resort recall anchors per market) → picks
    a community → picks bedroom count from the community's known
    mix.
  Step 2 — Backend auto-discovers a clean Zillow unit:
    /api/single-listing/find-clean-unit endpoint.
  Step 3 — Display photos scraped from the picked Zillow URL.
  Step 4 — Claude-Sonnet generates listing draft (title,
    description, neighborhood, transit, bedding, sqft, maxGuests,
    STR permit). Operator edits + saves.

THE FAILING STEP IS THE BACKEND DISCOVERY (Step 2 / find-clean-
unit). Algorithm:

  1. SearchAPI Google site:zillow.com queries (3 staged):
       site:zillow.com "{community}" {city} {state} {bedrooms} bedroom
       site:zillow.com "{community}" {bedrooms} bedroom
       site:zillow.com "{community}" {city} {state}
     Harvest up to 15 unique /homedetails/ URLs.

  2. Per candidate (sequential, up to 15):
     a. scrapeListingPhotos(url) — Apify primary, ScrapingBee
        fallback, returns photos[] + facts {bedrooms, bathrooms,
        homeType, homeStatus}.
     b. Reject candidate if homeType matches single-family / land
        / manufactured (we want condo / townhouse / apartment).
     c. Reject if homeStatus is sold / auction / pending.
     d. Reject if bedroom count doesn't match operator's pick.
     e. Reject if no bedroom data extracted at all (stub listing).
     f. Run runOtaQualifier(address, city, state, photoUrls):
        - Text-search per platform: site:airbnb.com / vrbo.com /
          booking.com "{streetPortion}" "{city}" via SearchAPI,
          strict snippet matching.
        - Photo reverse-image-search: first 3 photos through
          SearchAPI Google Lens, looking for hits on
          airbnb.com/(rooms|h)/, vrbo.com/\\d+,
          booking.com/(hotel|apartments)/.
        - listed = (text matches) || (photo matches).
     g. Track first text-clean candidate as fallback. Return
        immediately when a candidate is text-clean AND has ≥1
        scraped photo.

  3. After loop: prefer full-photo match, fall back to text-only.
     If neither: return found:false with diagnostic counts.

  4. Wizard's belt-and-suspenders: if find-clean-unit returns
     photos:[], wizard hits /api/community/fetch-unit-photos
     against the URL (same Apify→ScrapingBee). If THAT also empty,
     Step 3 of the wizard auto-fires a third retry. If all three
     fail, Step 3 shows an amber explainer with a Re-try button
     and a Skip-photos-for-now button.

OBSERVED FAILURE MODES (real production):

  A) Stub listings (just patched): Santa Maria Resort searches
     surfaced a Zillow URL "Santa-Maria-Resort-Condo-Hdr-Fort-
     Myers-Beach-FL-33931/295074738_zpid". The page is "Off market"
     with --/-- beds/baths/sqft, propertyType "SingleFamily",
     aerial satellite hero photo (no listing photos). Our text-
     only fallback accepted it as "clean" because the address
     text-search returned no Airbnb/VRBO/Booking matches (there's
     no real unit there to find).

  B) Photo scrape consistently empty: 6 consecutive Zillow
     candidates at Santa Maria Resort returned photos.length === 0
     from both Apify (maxcopell/zillow-detail-scraper) and
     ScrapingBee. Apify token had run out of credits — but even
     with a working token, this happens occasionally on Zillow's
     anti-bot IPs.

  C) Bathroom count missing: scrape returns photos and bedrooms
     but bathrooms is null (resoFacts schema variant the actor
     doesn't surface). Wizard displays "2 BR · ? BA" until Step 4
     where Claude estimates it.

CONSTRAINTS:
  - We have ANTHROPIC, SEARCHAPI (Google + Lens), APIFY,
    SCRAPINGBEE, BROWSERBASE, OUTSCRAPER keys.
  - The operator has a local Chrome MCP "sidecar daemon" running
    on residential IP — currently used for VRBO/Booking/PM
    bookable-rate scraping (Load-Bearing #25). Could in principle
    be extended to Zillow.
  - Apify and ScrapingBee both run from datacenter IPs, both hit
    Zillow's anti-bot occasionally.

QUESTIONS:

1. Stub-listing detection: beyond bedroom-count-null and
   homeType-singleFamily, what other Zillow signals reliably mark
   a listing as "stub / lot / building-page" rather than a usable
   unit? Specifically — how does Zillow flag "Off market with no
   data" vs "Off market but legitimately a unit you'd vacation-
   rent"? Field names + values please.

2. Photo scraper resilience for Zillow:
   - Best Apify actor for max-photo-extraction (we use
     maxcopell/zillow-detail-scraper; alternatives?)
   - When Apify+ScrapingBee both fail, is the residential-IP
     local-Chrome sidecar worth wiring up for Zillow? Cost vs
     reliability tradeoff?
   - Bright Data / Oxylabs scraping browsers — better than
     Apify+ScrapingBee for Zillow specifically?

3. Bathroom extraction: Zillow's payload exposes bathrooms under
   {bathrooms, bathroomsFull+bathroomsHalf, bathroomsTotalInteger,
   numberOfBathrooms, numberOfBathroomsTotal} — we walk all of
   them. Are there other field paths in Zillow's __NEXT_DATA__
   we're missing? Should we fall back to the JSON-LD or visible
   HTML when the actor's payload is partial?

4. End-to-end source diversification: should the single-listing
   wizard NOT depend on Zillow as the sole unit source? What
   alternative real-estate aggregators reliably return condo /
   townhouse listings with photos at vacation-rental resorts?
   (Realtor.com / Trulia / Redfin / Compass / MLS feeds /
   resort-specific PM sites?)

5. The OTA qualifier itself: is the current dual-source (text +
   reverse-image-search) the right approach for cleanliness
   verification, or is there a more reliable signal we're
   missing? (e.g. directly fetching the Vrbo property-search API
   for the address bbox, etc.)

6. Architectural take: senior web-scraping/data-architecture
   review. Anything obvious we're getting wrong with the
   "discover-then-verify" approach? Would "verify-then-discover"
   (start from the OTA-listing index and inverse-filter) be
   structurally better?

Be specific. Code-level + endpoint-shape recommendations preferred.
`.trim();

export async function consultGrokAboutSingleListing(): Promise<string> {
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
              "You are a senior web-scraping and data-sourcing architect with " +
              "deep knowledge of real-estate listing aggregators (Zillow, Realtor, " +
              "Trulia, Redfin), reverse-image-search APIs, and the major scraping " +
              "vendors (Apify, ScrapingBee, Outscraper, Browserbase, Bright Data, " +
              "Oxylabs). You provide specific, actionable, code-level recommendations.",
          },
          { role: "user", content: SINGLE_LISTING_BRIEF },
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
