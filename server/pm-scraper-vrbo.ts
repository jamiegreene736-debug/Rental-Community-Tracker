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
  // Pin the proxy to a US IP (`geolocation: { country: "US" }`). Without
  // this Browserbase rotates across regions and a CA IP would make Vrbo
  // serve prices in CAD — both the calendar GraphQL `displayPrice` and
  // the booking-widget total would render in CAD. Our number extraction
  // is currency-naive (regex `\$\s*([\d,]+)`), so a CAD value silently
  // becomes a USD-tagged number ~28% off. Forcing US locale solves both
  // currency display and Vrbo's CAD-only locale quirks.
  const session = await bb.sessions.create({
    projectId: bbProjectId,
    proxies: [
      { type: "browserbase", geolocation: { country: "US" } },
    ] as any,
  });

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let calendarBody = "";
  const graphqlOps: string[] = []; // for diagnostics

  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());

    // Tap every graphql response and grab the rate-calendar one when it lands.
    page.on("response", async (resp) => {
      const u = resp.url();
      if (!u.includes("vrbo.com/graphql")) return;
      const ct = resp.headers()["content-type"] || "";
      if (!/json/i.test(ct)) return;
      const body = await resp.text().catch(() => "");
      // Record operation names that fired so we can debug if the rate
      // query doesn't show up.
      const ops = body.match(/"data":\{"(\w+)"/g) || [];
      ops.forEach((m) => {
        const name = m.match(/"data":\{"(\w+)"/)?.[1];
        if (name) graphqlOps.push(name);
      });
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
      urlWithDates = u.toString();
    } catch { /* invalid URL — fall back to original */ }

    await page.goto(urlWithDates, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });

    // Wait up to CALENDAR_WAIT_MS for the rate query to fire.
    const waitStart = Date.now();
    while (!calendarBody && Date.now() - waitStart < CALENDAR_WAIT_MS) {
      await page.waitForTimeout(500);
    }

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

    // Now try to read the ALL-IN total from the booking widget DOM.
    // The calendar's displayPrice is a base nightly rate — for buy-in
    // accounting we want what the operator would actually pay (base +
    // cleaning + service + taxes). Vrbo's booking widget renders this
    // as a "$X total" string near "includes taxes & fees" once the page
    // settles with arrival/departure params present.
    //
    // We give it a short window (~10s) to render after navigation, then
    // pull the largest "$X" amount that appears next to "total" or
    // "includes taxes" in the visible page text. The regex looks for:
    //   "$31,568 total", "$31,568 includes taxes", "Total: $31,568"
    //
    // If the DOM scrape fails, we fall back to the calendar base sum
    // — preferable to a hard error, but the operator should know the
    // attached buy-in is base-only (note suffix in caller).
    let allInTotal = 0;
    let allInSource: "widget" | "calendar-base" = "calendar-base";
    try {
      // Wait for ANY total-looking text to appear; the booking widget
      // can take a beat after domcontentloaded to fully render.
      await page.waitForFunction(
        () => /\$\s*[\d,]+\s*(?:total|includes\s*tax|includes\s*fees)/i.test(document.body.innerText),
        { timeout: 10_000 },
      ).catch(() => {});
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
      const matches = Array.from(
        bodyText.matchAll(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:total|includes\s*tax|includes\s*fees)/gi),
      );
      const widgetTotals = matches
        .map((m) => parseFloat(m[1].replace(/,/g, "")))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (widgetTotals.length > 0) {
        // The widget renders multiple "$X total" strings (per-property
        // summary, mobile-collapsed view, etc.) — they should all be
        // the same number; take the max as a paranoia hedge against
        // a stale per-night value sneaking in.
        allInTotal = Math.max(...widgetTotals);
        allInSource = "widget";
      }
    } catch { /* fall through to base */ }

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
        `vrbo-scraper: widget total=${allInTotal > 0 ? `$${allInTotal}` : "not found"} (using ${allInSource})`,
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
