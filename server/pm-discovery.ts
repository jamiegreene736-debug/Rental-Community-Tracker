// PM discovery — given a community name, surface the unique PM-ish
// domains that show up in Google's first two pages so the operator can
// see at a glance which property-management sites are surfacing for
// that community and which we don't have scrapers for yet.
//
// This is RECON-ONLY. No rate scraping. The output drives the operator's
// decision about whether to add a new `vrp_main` config (PR #202 pattern)
// or build a one-off scraper for a domain we keep seeing.
//
// Why generic-Google rather than `site:vrbo.com`: we tried 7+ paths to
// scrape Vrbo directly and they're all unreliable — but every PM that
// lists on Vrbo also has its own website, and those rank on page 1 of
// Google for "{community} rentals". Going one hop earlier in the funnel
// gets us out of Vrbo's anti-bot fight entirely. See AGENTS.md for the
// PR series (#211–#220) that established Vrbo's brittleness.
import { VRP_SITES } from "./pm-scraper-vrp";
import { detectVrpSites, type VrpDetectResult } from "./vrp-detect";

export type PmDiscoveryClassification =
  | "covered"      // we already have a scraper module for this domain
  | "ota"          // public booking marketplace; surfaced via other paths
  | "aggregator"   // travel directory/SEO site, not directly bookable
  | "unknown";     // candidate PM — operator review needed

export type PmCmsDetection = "vrp_main" | "unknown";

export interface DiscoveredDomain {
  hostname: string;
  hits: number;
  sampleUrls: string[];
  classification: PmDiscoveryClassification;
  knownAs?: string;
  /**
   * CMS fingerprint for `unknown` classifications (PR #308). When the
   * vrp_main probe is enabled (`probeForVrp: true` on
   * discoverPmDomains) and the hostname's `?vrpsitemap=1` returns the
   * canonical fingerprint, set to `"vrp_main"` — the operator can
   * then auto-add the site via a one-line VRP_SITES config.
   */
  cmsDetected?: PmCmsDetection;
  /** Probe ms wall (informational; cached after first probe per host). */
  cmsProbeMs?: number;
  /** Probe failure reason when cmsDetected==="unknown". */
  cmsProbeReason?: string;
  /** Number of /vrp/unit/ paths in the sitemap (vrp_main only). */
  vrpUnitCount?: number;
  /**
   * Which fingerprint path matched. `"sitemap"` is the canonical
   * route — a one-line VRP_SITES config will work. `"html-fallback"`
   * means the plugin markers were detected on the homepage but the
   * sitemap was non-XML; the host has likely customised vrp_main
   * (e.g. stripped the rate-quote AJAX) and a bespoke scraper is
   * required. PR #330.
   */
  cmsDetectionPath?: "sitemap" | "html-fallback";
  /**
   * True when `cmsDetectionPath === "html-fallback"`. Distinguishes
   * "drop into VRP_SITES" candidates from "needs investigation"
   * candidates in the operator's report.
   */
  cmsCustomized?: boolean;
  /**
   * Convenience flag: true iff this is `unknown`-classified AND the
   * CMS probe identified the canonical sitemap fingerprint
   * (`detectionPath === "sitemap"`). HTML-fallback hits are NOT
   * auto-addable — they need a custom scraper. Operator can add
   * sitemap-detected hosts by appending one block to VRP_SITES.
   */
  autoAddable?: boolean;
}

export interface PmDiscoveryResult {
  community: string;
  location?: string;
  queries: string[];
  rawHits: number;
  domains: DiscoveredDomain[];
  /**
   * Breakdown of which path served each Google query. `sidecar` is kept
   * for response compatibility, but is always 0 after the 2026-05-01
   * operator directive: Google search discovery must run through
   * SearchAPI only, never through the local Chrome sidecar.
   */
  sourceBreakdown?: { sidecar: number; searchapi: number };
}

// Public booking marketplaces. We get listings from these via
// `sources.airbnb` / `sources.vrbo` / `sources.booking` in find-buy-in,
// not via PM discovery.
const OTA_DOMAINS = new Set<string>([
  "vrbo.com",
  "homeaway.com",
  "airbnb.com",
  "booking.com",
  "expedia.com",
  "hotels.com",
  "tripadvisor.com",
  "kayak.com",
  "trivago.com",
  "hotwire.com",
  "agoda.com",
  "evolve.com", // hybrid managed marketplace; treat as OTA for buy-in
]);

// Travel directories / SEO-arbitrage sites. They list PMs but aren't
// directly bookable, so a discovery hit on one of these is noise.
const AGGREGATOR_DOMAINS = new Set<string>([
  "to-hawaii.com",
  "hawaiigaga.com",
  "poipu365.com",
  "kauai.com",
  "hawaii.com",
  "tripsavvy.com",
  "yelp.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "reddit.com",
  "wikipedia.org",
  "google.com",
]);

function normalizeHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function coveredHostnames(): Map<string, string> {
  const map = new Map<string, string>();
  for (const site of Object.values(VRP_SITES)) {
    const h = normalizeHostname(site.baseUrl);
    if (h) map.set(h, site.label);
  }
  // Suite Paradise has its own dedicated scraper (server/pm-scraper-suite-paradise.ts),
  // not a vrp_main config.
  map.set("suite-paradise.com", "Suite Paradise");
  // Gather Vacations runs a customised vrp_main fork (rate-quote AJAX
  // stripped, calendar rendered server-side) — bespoke scraper at
  // server/pm-scraper-gather-vacations.ts (PR #332).
  map.set("gathervacations.com", "Gather Vacations");
  // Streamline VRS — generic JSON-API scraper at
  // server/pm-scraper-streamline.ts handles every tenant via the same
  // streamlinecore-api-request gateway (PR #333). Add new Streamline
  // hosts to STREAMLINE_SITES (and to this map) as auto-discovery
  // surfaces them.
  map.set("alekonakauai.com", "Alekona Kauai");
  map.set("princevillevacationrentals.com", "Princeville Vacation Rentals");
  return map;
}

function classify(
  hostname: string,
  covered: Map<string, string>,
): { classification: PmDiscoveryClassification; knownAs?: string } {
  if (OTA_DOMAINS.has(hostname)) return { classification: "ota" };
  if (AGGREGATOR_DOMAINS.has(hostname)) return { classification: "aggregator" };
  const knownAs = covered.get(hostname);
  if (knownAs) return { classification: "covered", knownAs };
  return { classification: "unknown" };
}

async function fetchOrganicViaSearchApi(
  query: string,
  page: number,
  apiKey: string,
): Promise<Array<{ link: string }>> {
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: "10",
    page: String(page),
    api_key: apiKey,
  });
  const r = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
  if (!r.ok) return [];
  const data = (await r.json()) as { organic_results?: Array<{ link?: string }> };
  return Array.isArray(data.organic_results)
    ? data.organic_results.filter((o): o is { link: string } => typeof o?.link === "string")
    : [];
}

/**
 * SearchAPI-only Google fetch. Sidecar/Chrome is deliberately not used
 * for google.com because it gets the operator's browser flagged. The
 * sidecar is reserved for direct URL rate/availability checks.
 */
async function fetchOrganicViaSearchApiOnly(
  query: string,
  pages: number,
  apiKey: string,
): Promise<{ hits: Array<{ link: string }>; source: "searchapi"; durationMs: number }> {
  // PR #327/#latest operator directive: sidecar Google SERP path
  // REMOVED. Driving Google search through Playwright kept
  // tripping Google's bot detection — Chrome would zoom in/out and
  // exhibit unusual scroll behavior that flagged the session, then
  // every subsequent VRBO/Booking partner-portal scrape inherited
  // the polluted session. Architecture is now:
  //   1. SearchAPI handles Google queries (server-to-server, no
  //      browser, no bot detection at our end).
  //   2. Sidecar handles direct-URL browsing only (VRBO/Booking
  //      partner portals via cookies + residential IP).
  // Sidecar never visits google.com — keeps the daemon's session
  // clean for the scrapers that actually need a real browser.

  // SearchAPI — paginate as before.
  const apiStart = Date.now();
  const all: Array<{ link: string }> = [];
  for (let page = 1; page <= pages; page++) {
    const hits = await fetchOrganicViaSearchApi(query, page, apiKey);
    all.push(...hits);
  }
  return { hits: all, source: "searchapi", durationMs: Date.now() - apiStart };
}

export async function discoverPmDomains(opts: {
  community: string;
  location?: string;
  apiKey: string;
  pages?: number;
  /**
   * When true (PR #308), every `unknown` hostname is probed for the
   * vrp_main fingerprint via `detectVrpSites`. Adds ~1-3s wall per
   * unknown domain (parallel, capped at 5 concurrent), then 7-day
   * in-memory cache for repeat calls. Set true on the admin
   * "auto-discover" endpoint where the operator wants the
   * actionable signal; leave false on the recon-only endpoint.
   */
  probeForVrp?: boolean;
}): Promise<PmDiscoveryResult> {
  const community = opts.community.trim();
  const location = opts.location?.trim() || undefined;
  const pages = opts.pages ?? 2;

  // Three angles. Quoting the community name forces Google to keep it
  // verbatim instead of relaxing it to a nearby term.
  const queries = [
    `"${community}" rentals`,
    location ? `"${community}" ${location} vacation rental` : null,
    `"${community}" rental management`,
  ].filter((q): q is string => !!q);

  const covered = coveredHostnames();
  const byHost = new Map<string, DiscoveredDomain>();
  let rawHits = 0;
  // Track which path served each Google query. `sidecarQueryCount`
  // intentionally stays 0; retained so older admin clients that render
  // `sourceBreakdown.sidecar` don't break.
  let sidecarQueryCount = 0;
  let searchapiQueryCount = 0;

  for (const query of queries) {
    const r = await fetchOrganicViaSearchApiOnly(query, pages, opts.apiKey);
    searchapiQueryCount++;
    rawHits += r.hits.length;
    for (const o of r.hits) {
      const host = normalizeHostname(o.link);
      if (!host) continue;
      const existing = byHost.get(host);
      if (existing) {
        existing.hits += 1;
        if (existing.sampleUrls.length < 3 && !existing.sampleUrls.includes(o.link)) {
          existing.sampleUrls.push(o.link);
        }
      } else {
        const c = classify(host, covered);
        byHost.set(host, {
          hostname: host,
          hits: 1,
          sampleUrls: [o.link],
          classification: c.classification,
          knownAs: c.knownAs,
        });
      }
    }
  }

  // Operator-friendly ordering: unknown PMs (the actionable bucket) first,
  // then already-covered (sanity check), then aggregators and OTAs (noise).
  const order: Record<PmDiscoveryClassification, number> = {
    unknown: 0,
    covered: 1,
    aggregator: 2,
    ota: 3,
  };
  const domains: DiscoveredDomain[] = [];
  byHost.forEach((d) => domains.push(d));
  domains.sort((a, b) => {
    if (order[a.classification] !== order[b.classification]) {
      return order[a.classification] - order[b.classification];
    }
    return b.hits - a.hits;
  });

  // PR #308: optionally probe each `unknown` hostname for the
  // vrp_main fingerprint. Augments each domain with cmsDetected +
  // autoAddable flags so the operator can see at a glance which
  // unknowns can be added with a one-line config vs. which need a
  // bespoke scraper.
  if (opts.probeForVrp) {
    const unknowns = domains.filter((d) => d.classification === "unknown");
    if (unknowns.length > 0) {
      const probes = await detectVrpSites(
        unknowns.map((d) => d.hostname),
        { concurrency: 5 },
      );
      const byHostProbe = new Map<string, VrpDetectResult>();
      for (const p of probes) byHostProbe.set(p.hostname, p);
      for (const d of unknowns) {
        const p = byHostProbe.get(d.hostname);
        if (!p) continue;
        d.cmsDetected = p.isVrpMain ? "vrp_main" : "unknown";
        d.cmsProbeMs = p.durationMs;
        if (p.isVrpMain) {
          d.vrpUnitCount = p.unitCount;
          d.cmsDetectionPath = p.detectionPath;
          d.cmsCustomized = p.customized ?? false;
          // Only canonical-sitemap matches are auto-addable to
          // VRP_SITES — HTML-fallback hits (PR #330) need a
          // bespoke scraper. We surface the detection result in
          // the report regardless so the operator can see them.
          d.autoAddable = p.detectionPath === "sitemap";
          // Carry the why-we-fell-back hint through to the
          // report when the html-fallback path triggered.
          if (p.detectionPath === "html-fallback" && p.reason) {
            d.cmsProbeReason = p.reason;
          }
        } else {
          d.cmsProbeReason = p.reason;
          d.autoAddable = false;
        }
      }
    }
  }

  return {
    community,
    location,
    queries,
    rawHits,
    domains,
    sourceBreakdown: { sidecar: sidecarQueryCount, searchapi: searchapiQueryCount },
  };
}
