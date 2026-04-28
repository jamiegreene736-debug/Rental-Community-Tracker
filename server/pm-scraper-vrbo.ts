// Vrbo rate scraper.
//
// Vrbo (Expedia Group) uses Apollo/GraphQL at vrbo.com/graphql. When
// you load any property URL, the page automatically fires several
// GraphQL queries — one of them is `PropertyRatesDateSelectorQuery`,
// which returns a calendar of every date for the next ~2 years with
// per-night `displayPrice` and `available` flag. We don't even need
// to drive the date picker: the calendar response already has
// everything we need, embedded in the initial page load.
//
// Recon confirmed the response shape:
//
//   {
//     "data": {
//       "propertyRatesDateSelector": {
//         "configuration": {...},
//         "days": [
//           { "date": {"day":3,"month":7,"year":2026},
//             "displayPrice": "$1,050",
//             "available": true,
//             "theme": null,
//             "checkinValidity": "VALID",
//             "checkoutValidity": "VALID",
//             ... },
//           ...
//         ]
//       }
//     }
//   }
//
// Scraping flow:
//   1. Browserbase session (Vrbo blocks vanilla Playwright with CAPTCHA)
//   2. Navigate to the property URL — auto-fires the rate calendar query
//   3. Listen for the response and capture the body
//   4. Parse `days[]`, find the nights in our stay window, sum displayPrice
//   5. Return total
//
// Stay-window math: vacation rentals book by NIGHTS, so for a checkIn
// → checkOut range, the included nights are [checkIn, checkOut). The
// checkOut date itself is NOT a charged night. So we sum the nights
// from checkIn (inclusive) to checkOut (exclusive).

import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";
import type { AgentResult } from "./pm-rate-agent";

const PAGE_TIMEOUT_MS = 30_000;
const CALENDAR_WAIT_MS = 25_000;

function parseIsoDate(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}
function ymdToInt(d: { y: number; m: number; d: number }): number {
  return d.y * 10000 + d.m * 100 + d.d;
}

export async function scrapeVrboRate(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
  bbApiKey: string;
  bbProjectId: string;
}): Promise<AgentResult & { manualOnly?: boolean }> {
  const { url, checkIn, checkOut, bbApiKey, bbProjectId } = opts;
  const nights = Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T12:00:00").getTime() -
        new Date(checkIn + "T12:00:00").getTime()) /
        86400000,
    ),
  );

  const bb = new Browserbase({ apiKey: bbApiKey });
  // Vrbo aggressively rate-limits Browserbase's default IP pool — first
  // few hits work but subsequent ones get a "Too Many Requests" wall
  // page. Enable Browserbase's residential proxy network so each session
  // gets a fresh residential IP.
  //
  // Earlier (PR #187) we tried pinning the proxy to a US IP via
  // `proxies: [{ type: "browserbase", geolocation: { country: "US" } }]`
  // to stop Vrbo serving CAD when the proxy landed in Canada. That
  // syntax broke Vrbo entirely — sessions returned 0 GraphQL ops and a
  // blank page title (some combination of bad SDK shape, US-IP
  // anti-bot variance, or both). Reverting to `proxies: true` and
  // forcing USD locale via the `Accept-Language` header + Vrbo's
  // currency cookie + a `?currency=USD` URL hint instead.
  const session = await bb.sessions.create({ projectId: bbProjectId, proxies: true });

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let calendarBody = "";
  const graphqlOps: string[] = []; // for diagnostics
  // Capture EVERY graphql response body. The calendar query gives base
  // nightly rates; another op (named `PropertyQuoteQuery` /
  // `TripQuoteQuery` / `PropertyDealsQuery` depending on the rev — Vrbo
  // doesn't publish op names) returns the all-in total when the URL
  // carries arrival/departure. We don't know the exact op name across
  // Vrbo deploys, so we keep all bodies and pattern-match for a quote
  // total below. Capped at 50 to bound memory.
  const graphqlBodies: Array<{ op: string; body: string }> = [];

  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());

    // Force USD locale — defense in depth across three vectors:
    //   1. Accept-Language: en-US — Vrbo's locale resolver checks this
    //      header before falling back to GeoIP.
    //   2. `pi_session_currency=USD` cookie — Vrbo's product-info
    //      service reads this for the booking widget's currency. (We
    //      had `set_pi_session_currency` earlier, which is the
    //      response-side header name Vrbo emits when SETTING this
    //      cookie — but the cookie itself is `pi_session_currency`.
    //      Per Grok review.)
    //   3. `?currency=USD` URL param (added below) — last-resort hint.
    //
    // Together these pin the page to USD even when Browserbase rotates
    // to a Canadian IP. Earlier version (PR #187) tried the cleaner
    // `proxies.geolocation.country: "US"` route — broke Vrbo entirely,
    // see comment on the session creation above.
    await ctx.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await ctx.addCookies([
      { name: "pi_session_currency", value: "USD", domain: ".vrbo.com", path: "/" },
      { name: "preferred_currency", value: "USD", domain: ".vrbo.com", path: "/" },
    ]);

    // Tap every graphql response and grab the rate-calendar one when it lands.
    page.on("response", async (resp) => {
      const u = resp.url();
      if (!u.includes("vrbo.com/graphql")) return;
      const ct = resp.headers()["content-type"] || "";
      if (!/json/i.test(ct)) return;
      const body = await resp.text().catch(() => "");
      // Record operation names that fired so we can debug if the rate
      // query doesn't show up.
      const opMatch = body.match(/"data":\{"(\w+)"/);
      const op = opMatch?.[1] ?? "unknown";
      graphqlOps.push(op);
      if (graphqlBodies.length < 50) graphqlBodies.push({ op, body });
      if (body.includes("propertyRatesDateSelector")) {
        calendarBody = body;
      }
    });

    // Vrbo's frontend is lazy about firing PropertyRatesDateSelectorQuery
    // — without date params in the URL, it only fires the discovery
    // module + session config and waits for the user to pick dates.
    // Injecting arrival/departure/adults into the URL triggers the
    // rate calendar query on initial load. Recon confirmed this is
    // the difference between firing 2 ops vs 18+.
    let urlWithDates = url;
    try {
      const u = new URL(url);
      if (!u.searchParams.has("arrival")) u.searchParams.set("arrival", checkIn);
      if (!u.searchParams.has("departure")) u.searchParams.set("departure", checkOut);
      if (!u.searchParams.has("adults")) u.searchParams.set("adults", "2");
      // USD nudge alongside the cookie + Accept-Language. Vrbo accepts
      // this for its booking widget when set explicitly.
      if (!u.searchParams.has("currency")) u.searchParams.set("currency", "USD");
      urlWithDates = u.toString();
    } catch { /* invalid URL — fall back to original */ }

    await page.goto(urlWithDates, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });

    // Wait up to CALENDAR_WAIT_MS for the rate query to fire.
    const waitStart = Date.now();
    while (!calendarBody && Date.now() - waitStart < CALENDAR_WAIT_MS) {
      await page.waitForTimeout(500);
    }

    // NOTE: PR #218 attempted to click the booking widget's "Reserve"
    // button to trigger PropertyQuoteQuery (per Grok review). That
    // click navigated Vrbo to a separate booking-flow page and broke
    // the rest of the scrape — verify-pm-listing started returning
    // ok=false with an empty agentTrace. Reverted here. The JSON
    // scan improvements from PR #218 (quote-shape patterns + sort
    // quote/trip ops to the front of the body walk) are kept since
    // they're zero-risk; only the click was harmful.
    //
    // If we want to revisit triggering the quote query, the next move
    // would be to either (a) catch and stop the post-click navigation
    // before it commits, or (b) issue the GraphQL request directly
    // ourselves with the property id + dates rather than driving the
    // widget. Both are non-trivial and not justified by the marginal
    // value of all-in vs base-rate when auto-fill skips Vrbo URLs
    // anyway due to TOS.

    if (!calendarBody) {
      const finalUrl = page.url();
      const title = await page.title().catch(() => "");
      return {
        ok: false,
        reason: "vrbo-no-calendar",
        extracted: null,
        finalUrl,
        title,
        screenshotBase64: "",
        iterations: 0,
        agentError: `Vrbo didn't fire PropertyRatesDateSelectorQuery within ${CALENDAR_WAIT_MS / 1000}s. Page title: "${title}". Operations seen: [${graphqlOps.join(", ").slice(0, 300)}]`,
        agentTrace: [
          `vrbo-scraper: title="${title}"`,
          `vrbo-scraper: ${graphqlOps.length} graphql ops fired`,
          `vrbo-scraper: ops=${graphqlOps.slice(0, 10).join(", ")}`,
        ],
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(calendarBody);
    } catch (e: any) {
      return errResult(url, "vrbo-parse-error", `Couldn't parse Vrbo response: ${e?.message ?? e}`);
    }
    const data = Array.isArray(parsed) ? parsed[0] : parsed;
    const sel = data?.data?.propertyRatesDateSelector;
    if (!sel) {
      return errResult(url, "vrbo-no-selector", "Response has no propertyRatesDateSelector");
    }
    const days: any[] = Array.isArray(sel.days) ? sel.days : [];

    const ci = parseIsoDate(checkIn);
    const co = parseIsoDate(checkOut);
    const ciInt = ymdToInt(ci);
    const coInt = ymdToInt(co);

    const stayDays = days.filter((day) => {
      const dt = day?.date;
      if (!dt) return false;
      const dn = ymdToInt({ y: dt.year, m: dt.month, d: dt.day });
      return dn >= ciInt && dn < coInt;
    });

    if (stayDays.length === 0) {
      return errResult(
        url,
        "vrbo-dates-out-of-calendar",
        `Calendar has ${days.length} entries but none in ${checkIn} → ${checkOut}`,
      );
    }

    const unavailableCount = stayDays.filter((d) => !d.available).length;
    if (unavailableCount > 0) {
      return {
        ok: true,
        extracted: {
          isUnitPage: true,
          available: false,
          totalPrice: null,
          nightlyPrice: null,
          dateMatch: true,
          reason: `Vrbo calendar: ${unavailableCount}/${stayDays.length} nights unavailable for ${checkIn} → ${checkOut}`,
        },
        finalUrl: page.url(),
        title: await page.title().catch(() => "Vrbo"),
        screenshotBase64: "",
        iterations: 0,
        agentTrace: [`vrbo-scraper: ${unavailableCount}/${stayDays.length} nights unavailable`],
      };
    }

    // CAD-leak guard. If any displayPrice carries a non-USD prefix
    // ("CA$", "C$", "AU$", "£", "€"), abort — the locale forcing didn't
    // land and we'd silently store a non-USD number as USD. Better to
    // bail than to write wrong data; the caller falls through to other
    // channels and a future session may get a different IP that does
    // serve USD.
    const allPrices = stayDays.map((d) => String(d?.displayPrice || ""));
    const hasNonUsdPrefix = allPrices.some((p) =>
      /\bCA\$|\bC\$|\bA\$|\bAU\$|£\s*[\d,]|€\s*[\d,]|MXN/i.test(p),
    );
    if (hasNonUsdPrefix) {
      return errResult(
        url,
        "vrbo-non-usd-locale",
        `Vrbo served prices in a non-USD currency despite locale nudges. Sample displayPrice: "${allPrices[0]}"`,
      );
    }

    // Sum the calendar `displayPrice` per night. This is the BASE rate
    // Vrbo serves through PropertyRatesDateSelectorQuery — does NOT
    // include cleaning, service fees, or taxes.
    let baseTotal = 0;
    for (const day of stayDays) {
      const m = (day.displayPrice || "").match(/\$\s*([\d,]+(?:\.\d+)?)/);
      if (m) baseTotal += parseFloat(m[1].replace(/,/g, ""));
    }
    if (!(baseTotal > 0)) {
      return errResult(
        url,
        "vrbo-no-prices",
        `All ${stayDays.length} nights available but no displayPrice extractable`,
      );
    }

    // Now try to read the ALL-IN total. The calendar's displayPrice is
    // base nightly rate — for buy-in accounting we want what the operator
    // would actually pay (base + cleaning + service + taxes). Two layers:
    //
    //   1. JSON: scan every captured Vrbo GraphQL body for a numeric
    //      "total" field that's > base sum AND <= ~5× base sum. The op
    //      that returns the quote varies across Vrbo revs, but the field
    //      shapes are stable: {"totalPrice":{"value":NNNN}},
    //      {"total":{"amount":NNNN}}, {"grandTotal":NNNN}, etc.
    //   2. DOM: scan visible page text for "$X" amounts near a "total" /
    //      "includes tax" / "includes fees" marker (within 100 chars on
    //      either side). Same plausibility filter (must exceed base).
    //
    // We try both, take the smallest plausible value (fees-included
    // total should be just barely > base, not crazy 10× — guards against
    // a rogue page-summary number sneaking in). Bail to calendar base if
    // neither layer finds anything.
    //
    // Timeout for DOM render: 4s. With the new US proxy + dates in URL,
    // the widget renders quickly when it's going to render at all; a
    // longer wait just adds latency in the failure case.
    const candidates: number[] = [];

    // ── Layer 1: GraphQL bodies ──
    // Three-tier scan, increasing in breadth. Plausibility filter
    // (n > baseTotal AND n < baseTotal × 5) protects against false
    // positives — per-night rates won't pass; ID/timestamp numbers
    // won't pass; multi-trip booking page totals won't pass.
    //
    // Recon notes (Vrbo deploy as of 2026-04): observed op names
    // include `getSessionConfig`, `oneKeyUniversalOnboarding`,
    // `socialShareButton`, `notification`, `propertyOffers`,
    // `propertyInfo`, `randomAccessOne`, `productSpotlight`. None
    // of those obviously screams "trip quote", but `propertyInfo`
    // and `propertyOffers` are the most likely to carry pricing.
    // Rather than guess the exact op, we scan ALL captured bodies
    // (still skipping the per-night calendar response) with a
    // progressively wider net.
    // Quote-query bodies first — these are the most likely to carry
    // the all-in. We sort `quote`/`trip`/`stay`-named ops to the front
    // of the scan so a real quote total wins over an offer/discount
    // banner total elsewhere on the page.
    const quoteFirstOrder = [...graphqlBodies].sort((a, b) => {
      const aIsQuote = /quote|trip|stay|booking|priceDetails|priceSummary/i.test(a.op) ? 0 : 1;
      const bIsQuote = /quote|trip|stay|booking|priceDetails|priceSummary/i.test(b.op) ? 0 : 1;
      return aIsQuote - bIsQuote;
    });

    for (const { op, body } of quoteFirstOrder) {
      if (op === "propertyRatesDateSelector") continue; // base rates, not total

      // Tier A: explicit field names with structured value/amount.
      const tierA = [
        /"total(?:Price|Amount|Charges|Cost|Charge|Quote)?":\s*\{\s*"(?:value|amount|formatted|raw)":\s*"?\$?([\d,]+(?:\.\d+)?)/gi,
        /"grandTotal":\s*"?\$?([\d,]+(?:\.\d+)?)/gi,
        /"(?:tripTotal|finalPrice|totalChargesAmount|priceTotal|fullPrice)":\s*"?\$?([\d,]+(?:\.\d+)?)/gi,
        /"displayPrice":\s*"\$\s*([\d,]+(?:\.\d+)?)/gi,
        /"formattedAmount":\s*"\$\s*([\d,]+(?:\.\d+)?)/gi,
        // Quote-query specific shapes (per Grok review):
        //   { quote: { total: { amount: 22729, currency: "USD" } } }
        //   { priceDetails: { total: 22729 } }
        //   { tripQuote: { totalAmount: 22729 } }
        /"quote"\s*:\s*\{[^}]*?"total"\s*:\s*\{[^}]*?"amount"\s*:\s*([\d.]+)/gi,
        /"priceDetails"\s*:\s*\{[^}]*?"total"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/gi,
        /"tripQuote"\s*:\s*\{[^}]*?"total(?:Amount|Price)?"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/gi,
      ];

      // Tier B: bare "total":N (catches simpler/older shapes).
      const tierB = [
        /"total":\s*"?\$?([\d,]+(?:\.\d+)?)/gi,
        /"amount":\s*([\d.]+)\s*,\s*"currency":\s*"USD"/gi,
      ];

      // Tier C: "$X" string within ~50 chars of total/trip/price/charge
      // keyword. Catches localized formatting like "Total: $22,729" or
      // "Trip total $22,729 USD" embedded in a stringified amount field.
      const tierCWindow = 50;

      const collect = (n: number) => {
        if (Number.isFinite(n) && n > baseTotal && n < baseTotal * 5) {
          candidates.push(n);
        }
      };

      for (const re of [...tierA, ...tierB]) {
        for (const m of body.matchAll(re)) {
          collect(parseFloat(m[1].replace(/,/g, "")));
        }
      }

      // Tier C: scan keyword positions and look for $N nearby.
      for (const kw of body.matchAll(/\b(?:total|trip|grand|charge|booking|stay|reservation)\b/gi)) {
        const idx = kw.index ?? 0;
        const around = body.slice(Math.max(0, idx - tierCWindow), Math.min(body.length, idx + tierCWindow));
        for (const dm of around.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)) {
          collect(parseFloat(dm[1].replace(/,/g, "")));
        }
      }
    }

    // ── Layer 2: DOM text near "total"/"tax"/"fees" markers ──
    let domCandidates: number[] = [];
    try {
      await page.waitForFunction(
        () => /\$\s*[\d,]+/i.test(document.body.innerText) &&
              /total|includes\s*tax|includes\s*fees/i.test(document.body.innerText),
        { timeout: 4_000 },
      ).catch(() => {});
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
      // Find each "total" / "includes tax" / "includes fees" marker, then
      // look for $X amounts within 100 chars on either side. This catches
      // layouts where the price and label are in adjacent DOM elements
      // (rendered as "$22,729\ntotal\nincludes taxes" by innerText) —
      // adjacency-required regexes miss those.
      const markerRegex = /\b(?:total|includes\s+tax(?:es)?|includes\s+fees|total\s+price)\b/gi;
      for (const marker of bodyText.matchAll(markerRegex)) {
        const idx = marker.index ?? 0;
        const window = bodyText.slice(Math.max(0, idx - 100), Math.min(bodyText.length, idx + 100));
        for (const m of window.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)) {
          const n = parseFloat(m[1].replace(/,/g, ""));
          if (Number.isFinite(n) && n > baseTotal && n < baseTotal * 5) {
            domCandidates.push(n);
          }
        }
      }
    } catch { /* fall through */ }
    candidates.push(...domCandidates);

    // ── Recon dump when no candidates found ──
    // When neither JSON nor DOM scan finds a plausible all-in total,
    // surface inspectable samples in agentTrace so we can iterate on
    // the regex / pattern set without redeploying. Each body capped
    // at 800 chars to keep trace size bounded but still informative
    // (typical Vrbo GraphQL bodies are 50-200KB; the first 800 chars
    // include the op name + first object's structure).
    //
    // Also dumps a sample of the visible page text so we can see
    // what locale Vrbo served us and where the widget total renders
    // (or doesn't).
    const dumpForRecon: string[] = [];
    if (candidates.length === 0) {
      dumpForRecon.push(`vrbo-recon: 0 candidates from ${graphqlBodies.length} graphql bodies + ${domCandidates.length} DOM hits`);
      for (const { op, body } of graphqlBodies.slice(0, 8)) {
        // Pull a few hundred chars near "$" or "price"/"total"/"amount"
        // keywords, since those are the regions that might carry the
        // all-in we're missing.
        const interesting = body.match(/.{0,200}(?:\$|"price|"total|"amount|"display|"formatted|currency).{0,300}/i);
        const sample = interesting ? interesting[0] : body.slice(0, 400);
        dumpForRecon.push(`[graphql:${op}] ${sample.slice(0, 600).replace(/\s+/g, " ")}`);
      }
      // Pull a 500-char window from the visible page text near any
      // dollar amount — likely contains the widget's price cluster.
      try {
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
        const dollarMatch = bodyText.match(/.{0,150}\$\s*[\d,]+.{0,300}/);
        if (dollarMatch) {
          dumpForRecon.push(`[dom-sample] ${dollarMatch[0].slice(0, 500).replace(/\s+/g, " ")}`);
        }
      } catch { /* ignore */ }
    }

    // Take the SMALLEST plausible candidate. If both layers found
    // numbers, they should be the same; smallest = safety against a
    // marketing-banner number being scooped up.
    let allInTotal = 0;
    let allInSource: "widget" | "calendar-base" = "calendar-base";
    if (candidates.length > 0) {
      allInTotal = Math.min(...candidates);
      allInSource = "widget";
    }

    const total = allInTotal > 0 ? allInTotal : baseTotal;
    const totalRounded = Math.round(total);
    const nightlyRounded = Math.round(total / nights);
    const reason = allInSource === "widget"
      ? `Vrbo widget: $${totalRounded.toLocaleString()} total (incl. fees) for ${nights} nights`
      : `Vrbo calendar (base): $${totalRounded.toLocaleString()} for ${nights} nights — widget total unreadable, this excludes fees/taxes`;
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: true,
        totalPrice: totalRounded,
        nightlyPrice: nightlyRounded,
        dateMatch: true,
        reason,
      },
      finalUrl: page.url(),
      title: await page.title().catch(() => "Vrbo"),
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [
        `vrbo-scraper: base sum=$${baseTotal} from ${stayDays.length} nights`,
        `vrbo-scraper: ${graphqlBodies.length} graphql bodies captured (ops: ${graphqlOps.slice(0, 8).join(", ")})`,
        `vrbo-scraper: candidate totals=[${candidates.slice(0, 8).join(", ")}] (graphql+DOM, ${domCandidates.length} from DOM)`,
        `vrbo-scraper: chosen total=${allInTotal > 0 ? `$${allInTotal}` : "calendar-base"} (using ${allInSource})`,
        ...dumpForRecon,
      ],
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await bb.sessions
      .update(session.id, { projectId: bbProjectId, status: "REQUEST_RELEASE" })
      .catch(() => {});
  }
}

function errResult(url: string, reason: string, msg: string): AgentResult {
  return {
    ok: false,
    reason,
    extracted: null,
    finalUrl: url,
    title: "Vrbo",
    screenshotBase64: "",
    iterations: 0,
    agentError: msg,
    agentTrace: [`vrbo-scraper: ${msg}`],
  };
}
