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

const PAGE_TIMEOUT_MS = 25_000;
const CALENDAR_WAIT_MS = 15_000;

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
  const session = await bb.sessions.create({ projectId: bbProjectId });

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let calendarBody = "";

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
      if (body.includes("propertyRatesDateSelector")) {
        calendarBody = body;
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });

    // Wait up to CALENDAR_WAIT_MS for the rate query to fire.
    const waitStart = Date.now();
    while (!calendarBody && Date.now() - waitStart < CALENDAR_WAIT_MS) {
      await page.waitForTimeout(500);
    }

    if (!calendarBody) {
      return errResult(url, "vrbo-no-calendar", "Vrbo didn't fire PropertyRatesDateSelectorQuery within 15s");
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

    let total = 0;
    for (const day of stayDays) {
      const m = (day.displayPrice || "").match(/\$\s*([\d,]+(?:\.\d+)?)/);
      if (m) total += parseFloat(m[1].replace(/,/g, ""));
    }
    if (!(total > 0)) {
      return errResult(
        url,
        "vrbo-no-prices",
        `All ${stayDays.length} nights available but no displayPrice extractable`,
      );
    }

    const totalRounded = Math.round(total);
    const nightlyRounded = Math.round(total / nights);
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: true,
        totalPrice: totalRounded,
        nightlyPrice: nightlyRounded,
        dateMatch: true,
        reason: `Vrbo calendar: $${totalRounded.toLocaleString()} total for ${nights} nights`,
      },
      finalUrl: page.url(),
      title: await page.title().catch(() => "Vrbo"),
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [`vrbo-scraper: extracted $${total} (${stayDays.length} nights summed)`],
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
