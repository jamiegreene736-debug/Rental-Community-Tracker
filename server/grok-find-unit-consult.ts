// One-off Grok consultation about our find-unit (replacement Zillow
// candidate discovery) architecture.
//
// PR #324: operator hit a recurring failure mode where 7 of 9 Zillow
// candidates for popular vacation-rental communities (Poipu Kai,
// Pili Mai, etc.) are already listed on VRBO — leaving 0 viable
// candidates for the channel-specific photo migration. We've widened
// the query pool and lowered the photo-count gate, but the
// fundamental tension remains: the more popular the resort, the
// more saturated VRBO is, and the harder it is to find an unlisted
// unit at the same resort.
//
// Grok's job: tell us a fundamentally different sourcing strategy.
// Maybe we should source replacement photos from outside the resort
// entirely (similar-style condo elsewhere). Maybe per-photo reverse-
// image-search rather than per-unit listing-presence is the right
// gate. Maybe Zillow itself isn't the right source.
//
// xAI's API is OpenAI-compatible. Env: XAI_API_KEY.
// Exposed at GET /api/operations/grok-find-unit-consult.

const FIND_UNIT_BRIEF = `
We're building a vacation-rental cross-listing tool. When the operator
detects their photos appear on a competitor's listing on a specific
channel (e.g. their own Pili Mai 3BR's photos showing up on someone
else's VRBO listing), we run an "Isolate + Replace + Disconnect" flow
on that channel:

  1. Find a Zillow unit at the same resort that's NOT listed on the
     contaminated channel (e.g. for VRBO contamination, find a Poipu
     Kai 3BR not currently on VRBO).
  2. Scrape that Zillow unit's photos.
  3. Upload them via the operator's home-IP Chrome (sidecar daemon)
     to the operator's VRBO partner-portal listing directly.
  4. Disconnect VRBO from Guesty admin so the operator's Guesty
     master photos don't override.

The flow's first step (find a clean Zillow unit) is the bottleneck.
For popular vacation-rental communities, MOST units listed on Zillow
are also listed on VRBO. Today's diagnostic on a real Poipu Kai 3BR
migration:

  Checked 9 Zillow candidates:
    - 7 found on VRBO (skipped — exactly what we wanted to filter,
      but also the entire pool)
    - 1 couldn't be verified (Google site:vrbo.com query inconclusive,
      sidecar fallback also empty)
    - 1 had too few photos (<12, since lowered to 8)
  Result: 0 viable replacements.

CURRENT IMPLEMENTATION (server/routes.ts /api/replacement/find-unit):

Step 1 — Google site:zillow.com queries to discover candidate URLs:
  site:zillow.com "${"<resort full address>"}"
  site:zillow.com "${"<resort name>"}"
  site:zillow.com "${"<resort name>"}" "for sale"
  site:zillow.com "${"<resort name>"}" condo
  site:zillow.com "${"<resort name>"}" ${"<city>"}
Each query via SearchAPI engine=google, num=10. Up to 15 unique
zillow.com/homedetails/... URLs harvested. Unit number extracted
from URL slug.

Step 2 — Per-candidate platform check. For each candidate run two
queries per OTA via SearchAPI Google, falling back to sidecar
(operator's home Chrome on residential IP) when SearchAPI errors:
  site:vrbo.com "${"<resort address>"}" "${"<unit>"}"
  site:vrbo.com "${"<resort name>"}" "${"<unit>"}"
  (and same pair per Airbnb / Booking)
Verdict: clean | found | unknown. We enforce only the contaminated
channel (VRBO in this case) — Airbnb/Booking presence is fine.

Step 3 — Per-candidate photo + vision gate:
  - Scrape Zillow photo URLs (anonymous fetch). Need ≥8.
  - 8-photo Claude vision probe: must contain bedroom OR bathroom.
  - Both pass → candidate accepted.

Step 4 — Upload accepted candidate's photos to VRBO partner portal
via sidecar. Disconnect VRBO from Guesty.

CONSTRAINTS:
- Operator's home Chrome (sidecar daemon) is the trust anchor for
  Google + VRBO + Booking interactions. It's online but Google has
  rate-limited it once recently (PR #314 disabled PM-domain Google
  searches; we re-enabled the per-channel platform check via sidecar
  fallback in PR #322).
- We do NOT have Vrbo API access. The sidecar can drive vrbo.com
  search pages but it's expensive (~30-90s per scan).
- We have ANTHROPIC, SEARCHAPI, BROWSERBASE, APIFY, OUTSCRAPER,
  SCRAPINGBEE keys.

QUESTIONS:

1. Source diversification — beyond Zillow:
   Realtor.com / Trulia / Redfin / MLS feeds — any of these have
   for-sale listings (less likely to be on VRBO) AND enough photos
   to populate a vacation rental? Specific source/site recommendation
   with example URL pattern + photo extractability rating?

2. Per-photo verification instead of per-listing:
   What if instead of "is this Zillow unit ON VRBO?", we ask "are
   THESE PHOTOS already on VRBO?" via reverse-image search? The
   risk we're avoiding is uploading photos that already appear on
   VRBO under someone else's listing. Per-photo check is more
   defensible than per-listing presence — a unit can be on VRBO
   with a totally different photo set.
   - What's the most reliable reverse-image API right now? Google
     Lens via SearchAPI engine=google_lens has been flaky; Yandex
     Images? Bing Visual Search? TinEye?
   - For 30+ photos per candidate, what's the cost-effective batching
     pattern?

3. Look outside the resort entirely:
   What if we source photos from a similar-style condo in a DIFFERENT
   community (e.g. Princeville for Poipu Kai)? Guests probably can't
   tell from photos alone, especially if interior style and view
   types match. Is this a defensible approach? What's the right way
   to match "similar style" — same architecture firm, same era,
   same square footage range?

4. Apify / Browserbase actors for Zillow with full photo extraction:
   Apify has multiple Zillow actors. Which one returns the largest
   photo set per listing reliably? Is there an Apify search-results
   actor that returns Zillow listings filtered by community + bedroom
   count, bypassing the Google-site:zillow detour?

5. Architectural alternative:
   Should we maintain a curated, pre-vetted clean-photo bank per
   community? Operator manually verifies a handful of source units
   per resort once, we cache the photo URLs, no per-migration
   discovery needed. Costs operator time upfront but guarantees
   migration success. Pros / cons / structure?

6. Anything else we're missing? The fundamental problem is "in a
   popular vacation rental community, find an off-market source for
   matching-style photos at scale, with high confidence the photos
   aren't already in use on the contaminated channel." Senior
   scraping/data-architecture take, please.

Be specific. Code-level recommendations preferred over high-level
strategy. Treat this as a technical architecture review.
`.trim();

export async function consultGrokAboutFindUnit(): Promise<string> {
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
              "vendors (Apify, ScrapingBee, Outscraper, Browserbase). You provide " +
              "specific, actionable, code-level recommendations.",
          },
          { role: "user", content: FIND_UNIT_BRIEF },
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
