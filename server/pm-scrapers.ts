// Per-PM rate dispatcher.
//
// Different property-management sites expose rates in totally different
// ways. Three patterns we've encountered so far:
//
//   1. Programmatic API — site has a public JSON endpoint that returns
//      rates for a unit + date range. Cleanest case; we replicate the
//      XHR server-side. (None yet — adds as we onboard PMs that have
//      one, e.g. Vacasa Direct.)
//
//   2. Browser-driveable — site has a working booking widget that
//      shows rates after the user picks dates and clicks Search.
//      The Browserbase + computer-use agent in pm-rate-agent.ts
//      handles these.
//
//   3. Manual-only — site has no programmatic rate path AND no
//      browser-driveable rate flow. They want a phone call or email
//      inquiry. Suite Paradise is the canonical example: their site
//      uses a Drupal entityform with reCAPTCHA that emails their team,
//      and the unit page never displays prices inline. Best UX is to
//      detect this fast (no wasted Browserbase session) and surface
//      the contact info to the operator.
//
// This dispatcher is the entry point: pm-rate-agent.ts calls
// `dispatchPmRate(url)` first, and if it returns a manual-only entry
// for the URL's domain, we skip the agent and return the manual-quote
// info immediately. Otherwise the agent runs as normal.

import type { AgentResult, AgentExtraction } from "./pm-rate-agent";

export type ManualOnlyEntry = {
  domain: string;
  name: string;
  reason: string;
  phone?: string;
  emailUrl?: string; // URL to a contact / inquiry form
};

// PMs we've confirmed cannot be scraped. Keep growing this list as we
// recon more PMs and find ones that need manual quotes.
const MANUAL_ONLY: ManualOnlyEntry[] = [
  {
    domain: "suite-paradise.com",
    name: "Suite Paradise",
    reason:
      "Suite Paradise's public site doesn't display rates inline — their booking flow is a Drupal inquiry form (reCAPTCHA-protected) that emails their team for a manual quote. No XHR or page state to scrape.",
    phone: "(855) 994-4148",
    emailUrl: "https://www.suite-paradise.com/vacation-rental-inquiry",
  },
];

export function manualEntryForUrl(url: string): ManualOnlyEntry | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return MANUAL_ONLY.find((e) => host.endsWith(e.domain)) ?? null;
  } catch {
    return null;
  }
}

// Build an AgentResult for a manual-only PM. Same response shape the
// agent would have returned, but with `manualOnly: true` so the
// client can render contact info instead of trying to verify.
export function manualOnlyResult(entry: ManualOnlyEntry, url: string): AgentResult & { manualOnly: true } {
  const extracted: AgentExtraction = {
    isUnitPage: true,
    available: null,
    totalPrice: null,
    nightlyPrice: null,
    dateMatch: null,
    reason: `${entry.name} requires a manual quote${entry.phone ? ` — call ${entry.phone}` : ""}.`,
  };
  return {
    ok: true,
    extracted,
    finalUrl: url,
    title: entry.name,
    screenshotBase64: "",
    iterations: 0,
    agentTrace: [`manual-only: ${entry.name} — no programmatic rate path`],
    manualOnly: true,
  } as AgentResult & { manualOnly: true };
}
