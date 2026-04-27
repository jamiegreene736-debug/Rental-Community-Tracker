// Suite Paradise rate scraper.
//
// Their public site uses RezCommerce (rcapi) under the hood — the
// orange "Search Availability" button on a unit page fires
// /rescms/ajax/item/pricing/simple with the unit's `eid` and the
// requested dates, and the response is a tiny JSON envelope
// containing rendered HTML with the total price.
//
// This module replicates that XHR server-side so we get rates in
// ~1s without driving a browser.
//
// Endpoint shape (confirmed via recon):
//
//   GET /rescms/ajax/item/pricing/simple
//     ?rcav[begin]=MM/DD/YYYY
//     &rcav[end]=MM/DD/YYYY
//     &rcav[adult]=2
//     &rcav[child]=0
//     &rcav[eid]=NNN          ← unit's RezCommerce entity id
//     &rcav[flex_type]=d
//
//   Headers: Accept: application/json, X-Requested-With: XMLHttpRequest,
//            Referer: <unit page URL>
//
//   Response 200:
//     Available:   {"status":1,"content":"<div class=\"rc-item-pricing\">...
//                   <span class=\"rc-price\">$2,291</span>...
//                   data-rc-ua-ecommerce-submit-addtocart=\"{...price:2291.48,...}\"...
//                   ..."}
//     Unavailable: {"status":1,"content":"<span class=\"rc-na\">Not Available</span>","reveals":""}
//
// The eid for a unit is embedded in the unit page HTML — `eid:156` and
// `item_id:156` for Regency 620. We fetch the page once and regex it
// out before hitting the pricing endpoint.

import type { AgentResult } from "./pm-rate-agent";

const PRICING_ENDPOINT = "https://www.suite-paradise.com/rescms/ajax/item/pricing/simple";

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
};

// Convert "2026-12-20" → "12/20/2026" (Suite Paradise's date format).
function toMdYY(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

// Pull the RezCommerce entity ID out of the unit page HTML. We've
// observed both `"eid":"156"` (JS config) and `eid:156` (inline)
// — match either.
function extractEid(html: string): number | null {
  // Most reliable: the JS config has `"eid":"156"` near `show_prices`.
  const cfgMatch = html.match(/"eid"\s*:\s*"(\d+)"/);
  if (cfgMatch) return parseInt(cfgMatch[1], 10);
  // Fallback: bare `eid:156` (without quotes, in JS object literal).
  const bareMatch = html.match(/(?:^|[^a-zA-Z0-9_])eid\s*:\s*"?(\d+)"?/);
  if (bareMatch) return parseInt(bareMatch[1], 10);
  return null;
}

// Parse the precise total price from the pricing response HTML.
// Prefers the float embedded in the add-to-cart data attribute (exact),
// falls back to the rendered "$X,XXX" span (rounded to dollars).
function parsePrice(content: string): { totalPrice: number; nightlyPrice: number | null } | null {
  if (!content) return null;
  // Unavailable path.
  if (/class=["'][^"']*\brc-na\b/.test(content)) return null;
  // Exact: data-rc-ua-ecommerce-submit-addtocart="{...&quot;price&quot;:2291.48,..."
  const exact = content.match(/&quot;price&quot;\s*:\s*([\d.]+)/);
  if (exact) {
    const total = parseFloat(exact[1]);
    if (isFinite(total) && total > 0) return { totalPrice: total, nightlyPrice: null };
  }
  // Approximate: rendered $-amount.
  const rendered = content.match(/class=["'][^"']*\brc-price\b[^>]*>\s*\$\s*([\d,]+(?:\.\d+)?)/);
  if (rendered) {
    const total = parseFloat(rendered[1].replace(/,/g, ""));
    if (isFinite(total) && total > 0) return { totalPrice: total, nightlyPrice: null };
  }
  return null;
}

export async function scrapeSuiteParadiseRate(opts: {
  url: string; // unit page URL, e.g. https://www.suite-paradise.com/poipu-vacation-rentals/regency-620
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
}): Promise<AgentResult & { manualOnly?: boolean }> {
  const { url, checkIn, checkOut } = opts;
  const nights = Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86400000,
    ),
  );

  // Step 1 — fetch the unit page HTML to extract the eid.
  let eid: number | null = null;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": COMMON_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const html = await r.text();
      eid = extractEid(html);
    }
  } catch (e: any) {
    console.warn(`[sp-scraper] page fetch error: ${e?.message ?? e}`);
  }

  if (!eid) {
    // Couldn't resolve eid — return unknown extraction so the caller
    // falls through to the agent or $0 attach.
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: null,
        totalPrice: null,
        nightlyPrice: null,
        dateMatch: null,
        reason: "Couldn't extract Suite Paradise unit eid from page HTML",
      },
      finalUrl: url,
      title: "Suite Paradise",
      screenshotBase64: "",
      iterations: 0,
      agentTrace: ["sp-scraper: eid not found in page HTML"],
    };
  }

  // Step 2 — hit the pricing endpoint.
  const params = new URLSearchParams({
    "rcav[begin]": toMdYY(checkIn),
    "rcav[end]": toMdYY(checkOut),
    "rcav[adult]": "2",
    "rcav[child]": "0",
    "rcav[eid]": String(eid),
    "rcav[flex_type]": "d",
  });
  let body = "";
  try {
    const r = await fetch(`${PRICING_ENDPOINT}?${params.toString()}`, {
      headers: { ...COMMON_HEADERS, Referer: url },
      signal: AbortSignal.timeout(10000),
    });
    body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e: any) {
    return {
      ok: false,
      reason: "sp-scraper-error",
      extracted: null,
      finalUrl: url,
      title: "Suite Paradise",
      screenshotBase64: "",
      iterations: 0,
      agentError: e?.message ?? String(e),
      agentTrace: [`sp-scraper: ${e?.message ?? e}`],
    };
  }

  // Parse the JSON envelope. The `content` field has the rendered HTML.
  let parsed: { status?: number; content?: string } = {};
  try { parsed = JSON.parse(body); } catch {}
  const content = parsed?.content ?? "";
  const isNotAvailable = /class=["'][^"']*\brc-na\b/.test(content);
  const priced = parsePrice(content);

  if (priced) {
    const nightly = Math.round(priced.totalPrice / nights);
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: true,
        totalPrice: Math.round(priced.totalPrice),
        nightlyPrice: nightly,
        dateMatch: true,
        reason: `Suite Paradise rcapi: $${Math.round(priced.totalPrice).toLocaleString()} total for ${nights} nights (eid=${eid})`,
      },
      finalUrl: url,
      title: "Suite Paradise",
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [`sp-scraper: extracted $${priced.totalPrice} for eid=${eid}`],
    };
  }

  if (isNotAvailable) {
    return {
      ok: true,
      extracted: {
        isUnitPage: true,
        available: false,
        totalPrice: null,
        nightlyPrice: null,
        dateMatch: true,
        reason: `Suite Paradise rcapi: unit not available for ${checkIn} → ${checkOut} (eid=${eid})`,
      },
      finalUrl: url,
      title: "Suite Paradise",
      screenshotBase64: "",
      iterations: 0,
      agentTrace: [`sp-scraper: unavailable, eid=${eid}`],
    };
  }

  // Fell through — unrecognized response shape.
  return {
    ok: true,
    extracted: {
      isUnitPage: true,
      available: null,
      totalPrice: null,
      nightlyPrice: null,
      dateMatch: null,
      reason: "Suite Paradise rcapi returned an unparseable response",
    },
    finalUrl: url,
    title: "Suite Paradise",
    screenshotBase64: "",
    iterations: 0,
    agentTrace: [`sp-scraper: unparseable response, body[:200]=${body.slice(0, 200)}`],
  };
}
