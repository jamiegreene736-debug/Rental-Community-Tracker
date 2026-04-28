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

export type PmDiscoveryClassification =
  | "covered"      // we already have a scraper module for this domain
  | "ota"          // public booking marketplace; surfaced via other paths
  | "aggregator"   // travel directory/SEO site, not directly bookable
  | "unknown";     // candidate PM — operator review needed

export interface DiscoveredDomain {
  hostname: string;
  hits: number;
  sampleUrls: string[];
  classification: PmDiscoveryClassification;
  knownAs?: string;
}

export interface PmDiscoveryResult {
  community: string;
  location?: string;
  queries: string[];
  rawHits: number;
  domains: DiscoveredDomain[];
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

async function fetchOrganic(
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

export async function discoverPmDomains(opts: {
  community: string;
  location?: string;
  apiKey: string;
  pages?: number;
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

  for (const query of queries) {
    for (let page = 1; page <= pages; page++) {
      const organic = await fetchOrganic(query, page, opts.apiKey);
      rawHits += organic.length;
      for (const o of organic) {
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

  return { community, location, queries, rawHits, domains };
}
