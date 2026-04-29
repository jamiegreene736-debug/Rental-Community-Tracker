// One-off Grok consultation about per-channel photo independence.
//
// xAI's API is OpenAI-compatible. We send a detailed brief covering
// the problem (photo theft + Guesty's single-pictures[] limitation +
// the "no clean Zillow candidate exists" reality at OTA-saturated
// resorts) and ask Grok to validate or critique the operator's
// proposed channel-independence design.
//
// Exposed at GET /api/operations/grok-channel-independence-consult.
// Module-scoped brief is auditable in source control like the
// VRBO consult.
//
// Env: XAI_API_KEY

const CHANNEL_INDEPENDENCE_BRIEF = `
We're a vacation-rental operator (NexStay) running ~11 Hawaii resort
condos. Channel manager is Guesty; Guesty fans out one listing to
Airbnb, Vrbo, and Booking.com.

PROBLEM
Reverse-image-search scanner detected that one of our units (unit-621
at Regency at Poipu Kai) has its hero photos appearing on a
competitor's Airbnb listing — airbnb.com/rooms/50372680, titled
"Regency at Poipu Kai 621 By Parrish Kauai". Either Parrish Kauai
is reusing our photos, or we're both pulling from the same source
listing. Either way, our Airbnb listing now visually duplicates a
competitor's listing.

WHAT WE BUILT
A "Replace & push" remediation: finds a clean Zillow unit at the
same community via SearchAPI, OTA-pre-checks the candidate against
Airbnb / Vrbo / Booking (any "found" verdict on any platform → skip),
scrapes its photos into the unit folder, and PUTs the new
\`pictures: [{ original, caption }]\` array to Guesty. Guesty then
fans the new photos out to all three OTAs.

UNFORTUNATE REALITY
Regency at Poipu Kai is OTA-saturated. find-unit returned 9 Zillow
candidates (units 720, 823, 912, 113, 510, 324, 513, 424, 920). EVERY
SINGLE ONE was already on at least one OTA. There is no "clean
across all three" Zillow-indexed unit at this community. The
constraint "not on Airbnb, Vrbo, or Booking" is unsatisfiable here.

GUESTY LIMITATION
Per Guesty's Open API docs, photos are a single listing-level
\`pictures[]\` array. There are NO \`channels.airbnb2.pictures\` /
\`channels.homeaway.pictures\` / \`channels.bookingCom.pictures\`
override paths. License fields, custom titles, etc. CAN be set
per-channel; photos cannot. Guesty's "Room Photos" beta tags
photos to rooms within a unit, not to channels. So natively, we
can't give Airbnb one photo set and Vrbo another from inside Guesty.

OPERATOR'S PROPOSED DESIGN ("Option 3 — Channel Independence")
Per-channel break + bespoke replacement:
  1. AIRBNB: pick a Zillow unit that is clean on Airbnb (Vrbo/Booking
     presence OK). Scrape its photos. Upload them DIRECTLY to our
     Airbnb listing via Airbnb's host UI. Disable Guesty's photo sync
     to Airbnb so Guesty doesn't overwrite.
  2. VRBO: pick a Zillow unit that is clean on Vrbo (Airbnb/Booking
     OK). Scrape and upload directly to our Vrbo listing via Vrbo's
     partner portal. Disable Guesty's photo sync to Vrbo.
  3. BOOKING: keep as-is. The Booking listing wasn't flagged.
The trigger would still be the same alert, but the button changes
from "Replace & push" to "Set up channel independence + replace".

TOOLS WE HAVE
- Sidecar: a Mac Chrome extension + daemon already wired for
  authenticated VRBO and Booking partner-portal scraping (cookie
  auto-sync, op-typed task queue, used today for find-buy-in).
  Runs in the operator's real browser via Playwright. Could be
  extended to handle Vrbo/Booking photo uploads.
- Airbnb has a Hospitality / Partner API but we don't have partner
  status. Manual UI uploads or browser automation are the realistic
  paths.
- Railway-hosted Node/Express, Postgres (Drizzle), Anthropic API for
  vision labeling, SearchAPI for Google, Apify+Browserbase+
  ScrapingBee for scraping, Playwright on Railway for compliance
  forms (used today for Hawaii STR tax uploads).

QUESTIONS

1. Is "channel independence" the right architectural call here, or
   is there a less invasive option we're missing? Specifically:
   could we iterate the strict-replace-everything filter (e.g. allow
   "clean on the alerted channel only" candidates), or pursue a DMCA
   takedown against the offending Airbnb listing as the primary
   action and use Replace & push only for genuinely cross-channel
   theft?

2. If channel independence IS the right call, what's the cheapest
   reliable way to upload photos to Airbnb without partner API
   access? Pure Playwright UI automation in our own Chrome (the
   sidecar's sweet spot), or some headless approach? Airbnb is
   notoriously bot-detection-heavy; what failure modes should we
   plan for?

3. Vrbo partner portal photo upload — does Vrbo's UI support bulk
   upload that's automatable? Any specific gotchas vs. their
   listing-edit API?

4. How do we cleanly "disable Guesty's photo sync per channel"?
   Guesty's docs don't surface a per-channel-photo-only sync toggle.
   Options: (a) channel-level overrides (we know channels.* fields
   exist for SOME data — confirm whether channels.X.pictures even
   exists as a write path despite docs silence); (b) disable the
   integration entirely and hand-manage that channel; (c) just stop
   sending pictures in our PUT to Guesty for non-Booking channels
   and hope Guesty's side-effects don't blow up. Which is the
   cleanest?

5. After we've manually uploaded Airbnb-only photos and Vrbo-only
   photos, what's the long-term maintenance cost? Every operational
   change (price change, amenity update, description edit) currently
   pushes through Guesty fanout. If we break photo sync for two
   channels, do other Guesty-managed fields keep working? Or do we
   pay a recurring tax of "now we manage everything per-channel"?

6. Is there a fundamentally different approach we should consider —
   e.g., attribute the original photo theft to a specific upstream
   source (Zillow listing the photographer also uploaded to,
   competitor scraping our public site, etc.) and address THAT
   instead of treating the symptom? Or commission new photography
   for unit-621 specifically and move on?

Be specific and pragmatic. We'd rather hear "your design is wrong
because X" than a polite version of "all options are fine."
`.trim();

export async function consultGrokAboutChannelIndependence(): Promise<string> {
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
              "You are a senior architect for vacation-rental tech, " +
              "specifically Property Management Systems and OTA channel " +
              "managers (Guesty, Hospitable, Hostfully). Deep knowledge " +
              "of Airbnb / Vrbo / Booking.com partner APIs and host UIs, " +
              "Playwright browser automation, photo distribution flows, " +
              "and the operational tradeoffs of channel-independent " +
              "vs centrally-managed listings. You give specific, " +
              "actionable, opinionated recommendations — not polite " +
              "non-answers.",
          },
          { role: "user", content: CHANNEL_INDEPENDENCE_BRIEF },
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
