// Multi-channel buy-in cost-basis + live snapshot scanner.
//
// The Pricing tab's per-channel sell-price floor formula is
// `(buyIn × 1.20) / (1 - channelFee)`. That formula calibrates well
// only when `buyIn` is a stable median across comparable units.
//
// This helper keeps that median as the persisted cost basis (so the
// sell-price floor doesn't lurch around with one-off cheap deals) AND
// adds a parallel "live channel snapshot": the cheapest verified
// nightly across Airbnb / VRBO / Booking.com for the SAME 7-night
// window, pulled through the local-Chrome sidecar daemon.
// The snapshot is ephemeral — returned in the
// refresh response, surfaced in the Pricing tab, never persisted —
// so the operator can see when one channel's cheapest is materially
// below the median basis ("VRBO has $580/n today; basis is $620").
//
// Operator directive 2026-05-22: OTA pricing stays Playwright/local
// Chrome only: no Airbnb/VRBO/Booking APIs, and no PM website scraping
// for market buy-in. The upgraded daemon can use up to 8 Chrome
// windows/tabs, and the dashboard receives live thumbnail screenshots
// so those searches can be watched in-app instead of on a second
// monitor. Direct-booking discovery is handled separately from Airbnb
// listing images; the direct site is linked, not scraped for price.

import { fetchAmortizedNightlyByBR } from "./community-research";
import { STREAMLINE_SITES } from "./pm-scraper-streamline";
import { VRP_SITES } from "./pm-scraper-vrp";
import { getSidecarStopGeneration, hasSidecarStopGenerationChanged } from "./vrbo-sidecar-queue";
import type { SidecarPmSearchSite } from "./vrbo-sidecar-queue";

export type ChannelKey = "airbnb" | "vrbo" | "booking" | "pm";
export type RegionKey = "hawaii" | "florida";
export type MultiChannelProgressEvent = {
  label: string;
  channel: ChannelKey;
  bedrooms: number;
  completed: number;
  total: number;
  startedAt: number;
};

// Surfaced to the loading bar via RefreshProgressState.warnings.
// Lets the operator see "CAPTCHA on VRBO sidecar at HIGH season"
// instead of just a frozen-looking bar with no signal.
export type ScanWarning = {
  season: "LOW" | "HIGH" | "HOLIDAY";
  channel: ChannelKey | "engine";
  kind: "captcha" | "blocked" | "rate-limit" | "timeout" | "network" | "unknown";
  message: string;        // operator-facing one-liner
  reason?: string;        // raw daemon/wrapper reason for debugging
};

// Pattern-match a sidecar wrapper's `reason` string against common
// failure modes the operator cares about. Returns null when the
// reason looks routine ("completed with 0 results", "no candidates")
// — those aren't warnings, just empty pulls. Heuristic; if the
// daemon ever gains a structured error code the orchestrator can
// switch to it without touching the call sites.
export function classifyScanReason(reason: string | undefined | null): ScanWarning["kind"] | null {
  if (!reason) return null;
  const s = reason.toLowerCase();
  if (s.includes("captcha") || s.includes("recaptcha") || s.includes("not a robot") || s.includes("i'm not a robot")) return "captcha";
  if (s.includes("cloudflare") || s.includes("just a moment") || s.includes("ddos protection")) return "blocked";
  if (s.includes("403") || s.includes("bot detection") || s.includes("access denied")) return "blocked";
  if (s.includes("429") || s.includes("rate limit") || s.includes("too many requests")) return "rate-limit";
  if (s.includes("timeout") || s.includes("timed out") || s.includes("navigation timeout") || s.includes("walletbudget") || s.includes("budget")) return "timeout";
  if (s.includes("econnreset") || s.includes("enotfound") || s.includes("network error") || s.includes("net::")) return "network";
  // "worker likely offline" / "request expired" cover the daemon-down case;
  // those surface separately via daemonOnline so don't double-warn.
  return null;
}

function describeWarning(kind: ScanWarning["kind"], channel: ScanWarning["channel"], season: ScanWarning["season"]): string {
  const ch = channel === "engine" ? "Airbnb fallback" : channel.toUpperCase();
  switch (kind) {
    case "captcha":    return `${ch} hit a CAPTCHA during the ${season} scan — sidecar daemon may need manual unblock before retrying.`;
    case "blocked":    return `${ch} blocked the ${season} scan (Cloudflare / bot wall) — try again later or rotate the daemon's session.`;
    case "rate-limit": return `${ch} rate-limited the ${season} scan — back off a few minutes and retry.`;
    case "timeout":    return `${ch} timed out during the ${season} scan — daemon queue may be busy or the page didn't load.`;
    case "network":    return `${ch} network error during the ${season} scan — check daemon Mac connectivity.`;
    case "unknown":    return `${ch} reported an issue during the ${season} scan.`;
  }
}

function sidecarRunCancelledError(): Error {
  const err = new Error("sidecar run cancelled by operator stop");
  err.name = "SidecarRunCancelledError";
  return err;
}

function rethrowIfSidecarRunCancelled(error: unknown): void {
  if ((error as any)?.name === "SidecarRunCancelledError") throw error;
}

// Normalize every sidecar quote to an all-in nightly basis before it
// participates in channel medians or cheapest snapshots. OTA/PM cards vary:
// some expose the full stay with taxes and required fees, some say "total
// before taxes", and some expose only base/nightly rent. The scraper now
// reports that basis explicitly; older daemons are handled with conservative
// channel defaults.
const TAX_NORMALIZATION_FACTOR: Record<RegionKey, number> = {
  hawaii: 1.155,
  florida: 1.11,
};

type PriceBasis = "all_in" | "pre_tax_total" | "stay_total" | "nightly_base" | "unknown";

const REQUIRED_FEE_FACTOR: Record<ChannelKey, number> = {
  // OTA guest service fees are not identical by booking, but these estimates
  // prevent base-nightly snippets from undercutting true guest cost.
  airbnb: 1.14,
  vrbo: 1.10,
  booking: 1.00,
  pm: 1.00,
};

const CLEANING_FEE_BASE: Record<RegionKey, number> = {
  hawaii: 175,
  florida: 145,
};

const CLEANING_FEE_PER_BEDROOM: Record<RegionKey, number> = {
  hawaii: 55,
  florida: 45,
};

export function inferRegion(city: string, state: string): RegionKey {
  const s = state.toLowerCase();
  if (s === "hawaii" || s === "hi") return "hawaii";
  if (s === "florida" || s === "fl") return "florida";
  // Best guess — most of our inventory is Hawaii. Pricing tab
  // tooltip surfaces the inferred region so the operator can
  // sanity-check.
  return "hawaii";
}

function defaultPriceIncludesTaxes(channel: ChannelKey, basis?: PriceBasis): boolean {
  if (basis === "all_in") return true;
  if (basis === "pre_tax_total" || basis === "stay_total" || basis === "nightly_base" || basis === "unknown") return false;
  // Booking's sidecar historically derives the nightly from the full card stay
  // total. Treat missing metadata as all-in to avoid double-taxing old workers.
  return channel === "booking";
}

function defaultPriceIncludesFees(channel: ChannelKey, basis?: PriceBasis): boolean {
  if (basis === "nightly_base" || basis === "unknown") return false;
  if (basis === "all_in" || basis === "pre_tax_total" || basis === "stay_total") return true;
  // Older Airbnb/Vrbo workers primarily returned stay totals; PM cards are
  // much more likely to be base-nightly snippets unless flagged otherwise.
  return channel === "airbnb" || channel === "vrbo" || channel === "booking";
}

function estimatedCleaningFeeNightly(region: RegionKey, bedrooms: number, nights: number): number {
  const br = Number.isFinite(bedrooms) && bedrooms > 0 ? Math.round(bedrooms) : 2;
  const stayFee = CLEANING_FEE_BASE[region] + CLEANING_FEE_PER_BEDROOM[region] * Math.min(Math.max(br, 1), 8);
  return Math.round(stayFee / Math.max(1, nights));
}

function normalizeQuotedNightly(
  rate: number,
  channel: ChannelKey,
  region: RegionKey,
  bedrooms: number,
  nights: number,
  opts?: {
    priceIncludesTaxes?: boolean;
    priceIncludesFees?: boolean;
    priceBasis?: PriceBasis;
  },
): number {
  if (!(rate > 0)) return 0;
  let normalized = Math.round(rate);
  const basis = opts?.priceBasis ?? "unknown";
  const includesFees = opts?.priceIncludesFees ?? defaultPriceIncludesFees(channel, basis);
  const includesTaxes = opts?.priceIncludesTaxes ?? defaultPriceIncludesTaxes(channel, basis);
  if (!includesFees) {
    normalized = Math.round(
      normalized * REQUIRED_FEE_FACTOR[channel] +
      estimatedCleaningFeeNightly(region, bedrooms, nights),
    );
  }
  if (!includesTaxes) {
    normalized = Math.round(normalized * TAX_NORMALIZATION_FACTOR[region]);
  }
  return normalized;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const start = new Date(`${checkIn}T12:00:00Z`).getTime();
  const end = new Date(`${checkOut}T12:00:00Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

function medianOfSorted(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : Math.round(sorted[mid]);
}

export function computeRobustCheapest(samples: number[]): number | null {
  const clean = samples
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  if (clean.length <= 2) return Math.round(clean[0]);
  const median = medianOfSorted(clean) ?? clean[0];
  const mean = clean.reduce((sum, n) => sum + n, 0) / clean.length;
  const variance = clean.reduce((sum, n) => sum + Math.pow(n - mean, 2), 0) / clean.length;
  const sigma = Math.sqrt(variance);
  const bounded = sigma > 0
    ? clean.filter((n) => n <= mean + 2 * sigma && n >= Math.max(1, mean - 2 * sigma))
    : clean;
  const floor = Math.max(1, median * 0.45);
  const candidates = (bounded.length > 0 ? bounded : clean).filter((n) => n >= floor);
  const lowEnd = (candidates.length > 0 ? candidates : clean).slice(0, 3);
  return Math.round(lowEnd.reduce((sum, n) => sum + n, 0) / lowEnd.length);
}

function normalizeHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

const PM_DISCOVERY_EXCLUDED_HOSTS = /(?:^|\.)(?:airbnb\.[a-z.]+|vrbo\.com|homeaway\.[a-z.]+|booking\.com|tripadvisor\.com|expedia\.[a-z.]+|hotels\.com|kayak\.com|trivago\.com|priceline\.com|orbitz\.com|travelocity\.com|hotwire\.com|agoda\.com|google\.com|youtube\.com|facebook\.com|instagram\.com|pinterest\.com|reddit\.com|twitter\.com|x\.com|whimstay\.com|vacationrentals\.com|flipkey\.com|holidaylettings\.com)$/i;

function bedroomTextMatches(haystack: string, bedrooms: number): boolean {
  const text = haystack.toLowerCase();
  const explicit = Array.from(text.matchAll(/\b(\d+)\s*(?:br|bd|bed(?:room)?s?)\b/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 20);
  if (explicit.length === 0) return true;
  return explicit.includes(bedrooms);
}

async function discoverPmSitesViaSearchApi(opts: {
  target: string;
  locality: string;
  bedrooms: number;
  checkIn: string;
  apiKey: string;
}): Promise<SidecarPmSearchSite[]> {
  void opts;
  // Retired 2026-05-23: buy-in scans must not use SearchAPI Google SERPs
  // to discover property-manager websites. Direct booking links are found
  // only from Airbnb listing images in the Operations flow, and are not
  // scraped for rates.
  return [];
}

type PmRateSample = {
  source: string;
  url: string;
  title: string;
  bedrooms: number;
  nightlyPrice: number;
  totalPrice: number;
  includesTaxes: boolean;
  includesFees: boolean;
  priceBasis?: PriceBasis;
};

async function buildPmSearchSites(args: {
  community: string;
  city: string;
  state: string;
  searchName?: string;
  bedrooms: number;
  checkIn: string;
  sidecarStopGeneration?: number;
  signal?: AbortSignal;
}): Promise<{ sites: SidecarPmSearchSite[]; knownCount: number; discoveredCount: number }> {
  const br = args.bedrooms;
  const assertSidecarRunCurrent = () => {
    if (args.signal?.aborted) {
      const err = new Error(args.signal.reason instanceof Error ? args.signal.reason.message : "PM site discovery cancelled");
      err.name = "AbortError";
      throw err;
    }
    if (hasSidecarStopGenerationChanged(args.sidecarStopGeneration)) {
      throw sidecarRunCancelledError();
    }
  };
  const target = args.searchName ?? args.community;
  const isHawaii = /hawaii|kauai|maui|oahu|honolulu|big\s*island|hawai|poipu|princeville|hanalei|wailua|kapaa|koloa|lihue|anini|pili\s*mai|wailea|kaanapali|kihei|lahaina|kaneohe/i
    .test(`${args.community} ${args.searchName ?? ""} ${args.city} ${args.state}`);
  const isPoipu = /poipu|pili\s*mai/i.test(`${args.community} ${args.searchName ?? ""} ${args.city}`);

  let discoveredSiteCount = 0;
  const apiKey = process.env.SEARCHAPI_API_KEY;
  const knownSites: SidecarPmSearchSite[] = [];
  if (isPoipu) {
    knownSites.push(
      { label: "Suite Paradise", baseUrl: "https://www.suite-paradise.com", searchUrl: "https://www.suite-paradise.com/poipu-vacation-rentals" },
      { label: VRP_SITES.parrishKauai.label, baseUrl: VRP_SITES.parrishKauai.baseUrl, searchUrl: "https://www.parrishkauai.com/kauai-rentals/" },
      { label: VRP_SITES.cbIslandVacations.label, baseUrl: VRP_SITES.cbIslandVacations.baseUrl, searchUrl: "https://www.cbislandvacations.com/browse-all-kauai-vacation-rentals/" },
      { label: VRP_SITES.pikoProperties.label, baseUrl: VRP_SITES.pikoProperties.baseUrl, searchUrl: "https://pikoproperties.com/rentals/" },
      { label: VRP_SITES.evrhi.label, baseUrl: VRP_SITES.evrhi.baseUrl, searchUrl: "https://evrhi.com/kauai-rentals/" },
      { label: "Gather Vacations", baseUrl: "https://www.gathervacations.com", searchUrl: "https://gathervacations.com/vacation-rentals/hawaii/kauai-rentals/" },
      { label: STREAMLINE_SITES.alekonaKauai.label, baseUrl: STREAMLINE_SITES.alekonaKauai.baseUrl, searchUrl: "https://alekonakauai.com/search-results/" },
      { label: STREAMLINE_SITES.princevilleVacationRentals.label, baseUrl: STREAMLINE_SITES.princevilleVacationRentals.baseUrl, searchUrl: `https://princevillevacationrentals.com/${br}-bedroom/` },
    );
  } else if (isHawaii) {
    knownSites.push(
      { label: VRP_SITES.parrishKauai.label, baseUrl: VRP_SITES.parrishKauai.baseUrl, searchUrl: "https://www.parrishkauai.com/kauai-rentals/" },
      { label: VRP_SITES.cbIslandVacations.label, baseUrl: VRP_SITES.cbIslandVacations.baseUrl, searchUrl: "https://www.cbislandvacations.com/browse-all-kauai-vacation-rentals/" },
      { label: VRP_SITES.evrhi.label, baseUrl: VRP_SITES.evrhi.baseUrl, searchUrl: "https://evrhi.com/kauai-rentals/" },
      { label: STREAMLINE_SITES.princevilleVacationRentals.label, baseUrl: STREAMLINE_SITES.princevilleVacationRentals.baseUrl, searchUrl: `https://princevillevacationrentals.com/${br}-bedroom/` },
    );
  }

  let discoveredSites: SidecarPmSearchSite[] = [];
  if (apiKey) {
    assertSidecarRunCurrent();
    discoveredSites = await discoverPmSitesViaSearchApi({
      target,
      locality: `${args.city} ${args.state}`,
      bedrooms: br,
      checkIn: args.checkIn,
      apiKey,
    });
    discoveredSiteCount = discoveredSites.length;
  }

  const seenHosts = new Set<string>();
  const sites = [...knownSites, ...discoveredSites].filter((site) => {
    try {
      const host = new URL(site.baseUrl).hostname.replace(/^www\./, "").toLowerCase();
      if (seenHosts.has(host)) return false;
      seenHosts.add(host);
      return true;
    } catch {
      return false;
    }
  });
  return { sites, knownCount: knownSites.length, discoveredCount: discoveredSiteCount };
}

async function fetchPmMarketRatesForBedroom(args: {
  community: string;
  city: string;
  state: string;
  searchName?: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  region: RegionKey;
  sidecarQueueBudgetMs?: number;
  pmPerSiteLimit?: number;
  pmMaxSites?: number;
  pmWalletBudgetMs?: number;
  sidecarStopGeneration?: number;
  signal?: AbortSignal;
}): Promise<{
  br: number;
  medianNightly: number | null;
  sampleCount: number;
  workerOnline: boolean;
  reason?: string;
}> {
  const br = args.bedrooms;
  const assertSidecarRunCurrent = () => {
    if (args.signal?.aborted) {
      const err = new Error(args.signal.reason instanceof Error ? args.signal.reason.message : "monthly PM scan cancelled");
      err.name = "AbortError";
      throw err;
    }
    if (hasSidecarStopGenerationChanged(args.sidecarStopGeneration)) {
      throw sidecarRunCancelledError();
    }
  };
  const target = args.searchName ?? args.community;
  const nights = nightsBetween(args.checkIn, args.checkOut);
  const samples: PmRateSample[] = [];
  const pushSample = (sample: PmRateSample) => {
    if (sample.bedrooms !== br || !(sample.nightlyPrice > 0)) return;
    samples.push(sample);
  };

  let workerOnline = false;
  let sidecarReason = "";
  const { sites, knownCount, discoveredCount } = await buildPmSearchSites(args);

  if (sites.length > 0) {
    try {
      assertSidecarRunCurrent();
      const { searchPmSitesViaSidecar } = await import("./vrbo-sidecar-queue");
      const r = await searchPmSitesViaSidecar({
        sites,
        searchTerm: target,
        checkIn: args.checkIn,
        checkOut: args.checkOut,
        bedrooms: br,
        perSiteLimit: args.pmPerSiteLimit ?? 8,
        maxSites: Math.min(args.pmMaxSites ?? 30, sites.length),
        walletBudgetMs: args.pmWalletBudgetMs ?? 240_000,
        queueBudgetMs: args.sidecarQueueBudgetMs ?? 285_000,
        signal: args.signal,
        stopGeneration: args.sidecarStopGeneration,
      });
      workerOnline = r.workerOnline;
      sidecarReason = r.reason;
      for (const c of r.candidates) {
        if (typeof c.bedrooms === "number" && c.bedrooms !== br) continue;
        const total = c.totalPrice > 0
          ? Math.round(c.totalPrice)
          : c.nightlyPrice > 0
            ? Math.round(c.nightlyPrice * nights)
            : 0;
        if (!(total > 0)) continue;
        pushSample({
          source: c.sourceLabel || normalizeHost(c.url) || "PM sidecar",
          url: c.url,
          title: c.title || c.url,
          bedrooms: c.bedrooms ?? br,
          nightlyPrice: Math.round(total / nights),
          totalPrice: total,
          includesTaxes: c.priceIncludesTaxes ?? defaultPriceIncludesTaxes("pm", c.priceBasis),
          includesFees: c.priceIncludesFees ?? defaultPriceIncludesFees("pm", c.priceBasis),
          priceBasis: c.priceBasis,
        });
      }
    } catch (e: any) {
      rethrowIfSidecarRunCancelled(e);
      sidecarReason = e?.message ?? String(e);
    }
  }

  const normalizedRates = samples
    .map((s) => normalizeQuotedNightly(s.nightlyPrice, "pm", args.region, br, nights, {
      priceIncludesTaxes: s.includesTaxes,
      priceIncludesFees: s.includesFees,
      priceBasis: s.priceBasis,
    }))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const medianNightly = medianOfSorted(normalizedRates);
  const reasonBits: string[] = [];
  if (samples.length > 0) reasonBits.push(`${samples.length} verified PM sample(s)`);
  reasonBits.push(`${sites.length} PM site(s): ${knownCount} known + ${discoveredCount} discovered (PM scanning disabled by default)`);
  if (sidecarReason) reasonBits.push(sidecarReason);

  return {
    br,
    medianNightly,
    sampleCount: normalizedRates.length,
    workerOnline,
    reason: reasonBits.join(" | "),
  };
}

async function fetchPmMarketRatesForBedroomSet(args: {
  community: string;
  city: string;
  state: string;
  searchName?: string;
  bedroomCounts: number[];
  checkIn: string;
  checkOut: string;
  region: RegionKey;
  sidecarQueueBudgetMs?: number;
  pmPerSiteLimit?: number;
  pmMaxSites?: number;
  pmWalletBudgetMs?: number;
  sidecarStopGeneration?: number;
  signal?: AbortSignal;
}): Promise<{
  br: number;
  medianNightly: number | null;
  sampleCount: number;
  workerOnline: boolean;
  reason?: string;
}[]> {
  const targetBrs = Array.from(new Set(args.bedroomCounts))
    .filter((br) => Number.isFinite(br) && br > 0)
    .sort((a, b) => a - b);
  const searchBedrooms = targetBrs[0];
  if (!searchBedrooms || targetBrs.length <= 1) {
    const br = searchBedrooms ?? args.bedroomCounts[0];
    return [await fetchPmMarketRatesForBedroom({ ...args, bedrooms: br })];
  }

  const target = args.searchName ?? args.community;
  const nights = nightsBetween(args.checkIn, args.checkOut);
  const samplesByBr = new Map<number, PmRateSample[]>();
  for (const br of targetBrs) samplesByBr.set(br, []);
  let workerOnline = false;
  let sidecarReason = "";
  const { sites, knownCount, discoveredCount } = await buildPmSearchSites({
    ...args,
    bedrooms: searchBedrooms,
  });

  if (sites.length > 0) {
    try {
      if (args.signal?.aborted) {
        const err = new Error(args.signal.reason instanceof Error ? args.signal.reason.message : "shared PM scan cancelled");
        err.name = "AbortError";
        throw err;
      }
      if (hasSidecarStopGenerationChanged(args.sidecarStopGeneration)) throw sidecarRunCancelledError();
      const { searchPmSitesViaSidecar } = await import("./vrbo-sidecar-queue");
      const r = await searchPmSitesViaSidecar({
        sites,
        searchTerm: target,
        checkIn: args.checkIn,
        checkOut: args.checkOut,
        bedrooms: searchBedrooms,
        perSiteLimit: Math.max(args.pmPerSiteLimit ?? 8, 8),
        maxSites: Math.min(args.pmMaxSites ?? 30, sites.length),
        walletBudgetMs: args.pmWalletBudgetMs ?? 240_000,
        queueBudgetMs: args.sidecarQueueBudgetMs ?? 285_000,
        signal: args.signal,
        stopGeneration: args.sidecarStopGeneration,
      });
      workerOnline = r.workerOnline;
      sidecarReason = r.reason;
      for (const c of r.candidates) {
        const candidateBr = typeof c.bedrooms === "number" && Number.isFinite(c.bedrooms) ? c.bedrooms : null;
        const matchingBrs = candidateBr === null ? [searchBedrooms] : targetBrs.filter((br) => br === candidateBr);
        if (matchingBrs.length === 0) continue;
        const total = c.totalPrice > 0
          ? Math.round(c.totalPrice)
          : c.nightlyPrice > 0
            ? Math.round(c.nightlyPrice * nights)
            : 0;
        if (!(total > 0)) continue;
        for (const br of matchingBrs) {
          samplesByBr.get(br)?.push({
            source: c.sourceLabel || normalizeHost(c.url) || "PM sidecar",
            url: c.url,
            title: c.title || c.url,
            bedrooms: br,
            nightlyPrice: Math.round(total / nights),
            totalPrice: total,
            includesTaxes: c.priceIncludesTaxes ?? defaultPriceIncludesTaxes("pm", c.priceBasis),
            includesFees: c.priceIncludesFees ?? defaultPriceIncludesFees("pm", c.priceBasis),
            priceBasis: c.priceBasis,
          });
        }
      }
    } catch (e: any) {
      rethrowIfSidecarRunCancelled(e);
      sidecarReason = e?.message ?? String(e);
    }
  }

  return targetBrs.map((br) => {
    const samples = samplesByBr.get(br) ?? [];
    const normalizedRates = samples
      .map((s) => normalizeQuotedNightly(s.nightlyPrice, "pm", args.region, br, nights, {
        priceIncludesTaxes: s.includesTaxes,
        priceIncludesFees: s.includesFees,
        priceBasis: s.priceBasis,
      }))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const reasonBits: string[] = [];
    if (samples.length > 0) reasonBits.push(`${samples.length} verified PM sample(s)`);
    reasonBits.push(`shared PM scan for ${targetBrs.join("/")}BR: ${sites.length} PM site(s): ${knownCount} known + ${discoveredCount} discovered (PM scanning disabled by default)`);
    if (sidecarReason) reasonBits.push(sidecarReason);
    return {
      br,
      medianNightly: medianOfSorted(normalizedRates),
      sampleCount: normalizedRates.length,
      workerOnline,
      reason: reasonBits.join(" | "),
    };
  });
}

export type MultiChannelBuyInResult = {
  // Per-bedroom Airbnb.com sidecar rate samples. Same shape as the
  // legacy `fetchAmortizedNightlyByBR().ratesByBR` so the persisted-
  // median computation in the existing refresh endpoint stays
  // unchanged. These are retained as the fallback distribution when
  // no verified non-Airbnb channel signal is available for a BR/season.
  ratesByBR: Record<number, number[]>;
  // Live channel snapshot — per bedroom, per channel, the cheapest
  // verified nightly that the operator could actually book today.
  // null means we didn't find a verifiable priced listing on that
  // channel for that BR (daemon offline, no inventory, etc.).
  channelCheapestByBR: Record<
    number,
    {
      airbnb: number | null;
      vrbo: number | null;
      booking: number | null;
      pm: number | null;
    }
  >;
  rawChannelCheapestByBR?: Record<
    number,
    {
      airbnb: number | null;
      vrbo: number | null;
      booking: number | null;
      pm: number | null;
    }
  >;
  consensusCheapestByBR?: Record<number, number | null>;
  cheapestConfidence?: Record<
    number,
    {
      sampleCount: number;
      sourceDiversity: number;
      singleSourceWarning?: boolean;
    }
  >;
  // Live availability counts from the same exact dated search window.
  // These are raw channel counts and may double-count cross-listed
  // homes; the Availability tab applies a de-dupe discount before
  // deciding whether a season is open/tight/blocked.
  channelAvailableCountsByBR: Record<
    number,
    {
      airbnb: number;
      vrbo: number;
      booking: number;
      pm: number;
      total: number;
    }
  >;
  // Window the snapshot was taken on, so the UI can label "Live
  // 2026-05-29 → 06-05: Airbnb $620 · VRBO $580 · Booking $605 · PM $590".
  snapshotCheckIn: string;
  snapshotCheckOut: string;
  // Was the local daemon online during the scan? Used for the UI to
  // distinguish "Booking offline today" from "Booking has no
  // inventory in the window" (both surface as null cheapest).
  daemonOnline: boolean;
  // Region the helper inferred from city/state for the tax
  // normalization factor — surfaced so the UI can show
  // "+15.5% tax for Hawaii" in the tooltip.
  region: RegionKey;
  taxFactor: number;
  durationMs: number;
  // PR #312: per-channel issues observed during the scan (CAPTCHA,
  // bot-block, rate-limit, etc.) so the orchestrator can surface
  // them in the loading bar without inspecting raw `reason` strings.
  // Empty when the scan ran clean. Pre-seeded with the season label
  // by the season orchestrator after Promise resolution; the per-BR
  // helper sets `season: "LOW"` as a placeholder.
  warnings: ScanWarning[];
};

export async function fetchMultiChannelBuyInByBR(args: {
  // Identity tuple used for OTA resort/location context.
  community: string;
  city: string;
  state: string;
  streetAddress?: string;
  bboxCenterOverride?: { lat: number; lng: number };
  // Sidecar searches need a destination string suitable for VRBO /
  // Booking autocomplete. Falls back to `community` when the caller
  // doesn't pin a `searchName` (drafts).
  searchName?: string;
  bedroomCounts: number[];
  propertyId?: number;
  // PR #282: optional explicit dates. When supplied, all sidecar
  // website searches hit this window. When omitted, defaults to
  // the legacy 7-night, 30-day-out window.
  dateOverride?: { checkIn: string; checkOut: string };
  // Optional escape hatch for low-cost probes. Normal pricing and
  // availability scans do not skip sidecar: LOW/HIGH/HOLIDAY all use
  // Airbnb + VRBO + Booking.com local-Chrome searches.
  skipSidecar?: boolean;
  // Pricing refreshes can split the full market-rate check into
  // reusable stages. PM/direct scanning is legacy-only and disabled.
  skipOta?: boolean;
  skipPm?: boolean;
  // Manual market-rate refreshes run in the background now, so they can
  // tolerate a deeper local Chrome queue than request/response flows.
  sidecarQueueBudgetMs?: number;
  warningSeason?: ScanWarning["season"];
  // Monthly pricing refreshes can reuse one minimum-bedroom OTA search
  // across larger bedroom counts because the sidecar applies "at least N
  // bedrooms" filters for Airbnb/VRBO/Booking and returns parsed BR counts
  // per card.
  reuseSharedOtaSearch?: boolean;
  // Legacy PM tuning knobs retained for API compatibility. They are ignored
  // while PM/direct scanning is disabled.
  reuseSharedPmSearch?: boolean;
  pmPerSiteLimit?: number;
  pmMaxSites?: number;
  pmWalletBudgetMs?: number;
  // Producer-level stop boundary. Long background scans pass the value
  // captured at scan start so a later operator Stop cancels the whole
  // scan, even if Start Queue is clicked again.
  sidecarStopGeneration?: number;
  signal?: AbortSignal;
  onProgress?: (event: MultiChannelProgressEvent) => void;
}): Promise<MultiChannelBuyInResult> {
  const startedAt = Date.now();
  const sidecarStopGeneration = args.sidecarStopGeneration ?? getSidecarStopGeneration();
  const assertSidecarRunCurrent = () => {
    if (args.signal?.aborted) {
      const err = new Error(args.signal.reason instanceof Error ? args.signal.reason.message : "monthly window scan cancelled");
      err.name = "AbortError";
      throw err;
    }
    if (hasSidecarStopGenerationChanged(sidecarStopGeneration)) {
      throw sidecarRunCancelledError();
    }
  };

  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  let checkIn: string;
  let checkOut: string;
  if (args.dateOverride) {
    checkIn = args.dateOverride.checkIn;
    checkOut = args.dateOverride.checkOut;
  } else {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    const checkInDate = new Date(now);
    checkInDate.setUTCDate(checkInDate.getUTCDate() + 30);
    const checkOutDate = new Date(checkInDate);
    checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 7);
    checkIn = ymd(checkInDate);
    checkOut = ymd(checkOutDate);
  }

  const targetDest = args.searchName ?? args.community;
  const nights = nightsBetween(checkIn, checkOut);
  const region = inferRegion(args.city, args.state);
  const sidecarQueueBudgetMs = args.sidecarQueueBudgetMs ?? 285_000;
  const warningSeason = args.warningSeason ?? "LOW";
  if (!args.skipSidecar) assertSidecarRunCurrent();

  // Fan out every OTA website search concurrently. SearchAPI is not
  // used for OTA pricing here; Airbnb, VRBO, and Booking.com all run
  // through the operator's local Chrome sidecar.
  const airbnbFallbackPromise = args.skipSidecar
    ? fetchAmortizedNightlyByBR(
        args.community,
        args.city,
        args.state,
        args.streetAddress,
        args.bboxCenterOverride,
        args.dateOverride ? { checkIn, checkOut } : undefined,
      )
    : Promise.resolve({ ratesByBR: {} as Record<number, number[]> });

  type SidecarOp = {
    br: number;
    channel: ChannelKey;
    cheapestNightly: number | null;
    availableCount: number;
    // Sidecar channel prices are normalized to all-in nightly before
    // landing here. These legacy flags remain optional for old callers
    // and diagnostics, but final aggregation no longer re-normalizes.
    cheapestIncludesTaxes?: boolean;
    cheapestIncludesFees?: boolean;
    cheapestPriceBasis?: PriceBasis;
    rates?: number[];
    workerOnline: boolean;
    // PR #312: capture the wrapper's `reason` string so the
    // orchestrator can pattern-match for CAPTCHA / bot-block / etc.
    // without changing every call site.
    reason?: string;
  };
  const sortedBedroomCounts = Array.from(new Set(args.bedroomCounts))
    .filter((br) => Number.isFinite(br) && br > 0)
    .sort((a, b) => a - b);
  const sharedOtaBedroomCount = sortedBedroomCounts[0] ?? args.bedroomCounts[0];
  const reuseSharedOtaSearch = args.reuseSharedOtaSearch !== false && sortedBedroomCounts.length > 1;
  const otaSearchBedroomCounts = reuseSharedOtaSearch
    ? [sharedOtaBedroomCount]
    : args.bedroomCounts;
  const reuseSharedPmSearch = args.reuseSharedPmSearch !== false && sortedBedroomCounts.length > 1;
  const pmSearchCount = reuseSharedPmSearch ? 1 : args.bedroomCounts.length;
  const pmSearchEnabled = false;
  const progressTotal = args.skipSidecar
    ? 0
    : (args.skipOta ? 0 : otaSearchBedroomCounts.length * 3) +
      (args.skipPm || !pmSearchEnabled ? 0 : pmSearchCount);
  let progressCompleted = 0;
  const emitProgress = (
    label: string,
    channel: ChannelKey,
    bedrooms: number,
    completed = progressCompleted,
  ) => {
    if (!args.onProgress || progressTotal <= 0) return;
    args.onProgress({
      label,
      channel,
      bedrooms,
      completed: Math.max(0, Math.min(progressTotal, completed)),
      total: progressTotal,
      startedAt: Date.now(),
    });
  };
  const markProgressDone = (label: string, channel: ChannelKey, bedrooms: number) => {
    if (progressTotal <= 0) return;
    progressCompleted = Math.max(0, Math.min(progressTotal, progressCompleted + 1));
    emitProgress(label, channel, bedrooms, progressCompleted);
  };

  const targetBrsForSearch = (searchBedrooms: number): number[] =>
    reuseSharedOtaSearch && searchBedrooms === sharedOtaBedroomCount
      ? sortedBedroomCounts
      : [searchBedrooms];
  const candidateTargetBrs = (
    candidateBedrooms: unknown,
    searchBedrooms: number,
    targetBrs: number[],
  ): number[] => {
    if (typeof candidateBedrooms === "number" && Number.isFinite(candidateBedrooms)) {
      return targetBrs.filter((br) => candidateBedrooms === br);
    }
    // Preserve the old exact-search behavior for unknown-card bedroom data:
    // count the candidate only against the search BR, not every reused BR.
    return targetBrs.includes(searchBedrooms) ? [searchBedrooms] : [];
  };
  const sidecarFailureOps = (
    searchBedrooms: number,
    channel: ChannelKey,
    reason: string,
  ): SidecarOp[] =>
    targetBrsForSearch(searchBedrooms).map((br) => ({
      br,
      channel,
      cheapestNightly: null,
      availableCount: 0,
      rates: channel === "airbnb" ? [] : undefined,
      workerOnline: false,
      reason,
    }));

  const sidecarOps: Promise<SidecarOp[]>[] = [];
  const pmOps: Promise<{
    br: number;
    medianNightly: number | null;
    sampleCount: number;
    workerOnline: boolean;
    reason?: string;
  }[]>[] = [];
  // When caller asks us to skip sidecar, we still build the channel
  // map but browser-backed entries stay null. Normal pricing refreshes
  // do not skip sidecar: LOW/HIGH/HOLIDAY all use Airbnb + VRBO +
  // Booking.com searches now.
  if (!args.skipSidecar && !args.skipOta) for (const br of otaSearchBedroomCounts) {
    sidecarOps.push(
      (async (): Promise<SidecarOp[]> => {
        const progressLabel = `Airbnb ${br}+BR (8-window sidecar)`;
        try {
          assertSidecarRunCurrent();
          const { searchAirbnbViaSidecar } = await import("./vrbo-sidecar-queue");
          const r = await searchAirbnbViaSidecar({
            destination: targetDest,
            searchTerm: targetDest,
            checkIn,
            checkOut,
            bedrooms: br,
            walletBudgetMs: 120_000,
            queueBudgetMs: sidecarQueueBudgetMs,
            signal: args.signal,
            stopGeneration: sidecarStopGeneration,
          });
          const targetBrs = targetBrsForSearch(br);
          const byBr = new Map<number, { cheapest: number; availableCount: number; rates: number[] }>();
          for (const targetBr of targetBrs) {
            byBr.set(targetBr, { cheapest: Infinity, availableCount: 0, rates: [] });
          }
          for (const c of r.candidates) {
            const total = c.totalPrice > 0
              ? Math.round(c.totalPrice)
              : c.nightlyPrice > 0
                ? Math.round(c.nightlyPrice * nights)
                : 0;
            if (!(total > 0)) continue;
            const rawNightly = Math.round(total / nights);
            for (const targetBr of candidateTargetBrs(c.bedrooms, br, targetBrs)) {
              const bucket = byBr.get(targetBr);
              if (!bucket) continue;
              const nightly = normalizeQuotedNightly(rawNightly, "airbnb", region, targetBr, nights, {
                priceIncludesTaxes: c.priceIncludesTaxes,
                priceIncludesFees: c.priceIncludesFees,
                priceBasis: c.priceBasis,
              });
              bucket.rates.push(nightly);
              bucket.availableCount++;
              if (nightly < bucket.cheapest) bucket.cheapest = nightly;
            }
          }
          return targetBrs.map((targetBr) => {
            const bucket = byBr.get(targetBr);
            return {
              br: targetBr,
              channel: "airbnb",
              cheapestNightly: bucket && Number.isFinite(bucket.cheapest) ? Math.round(bucket.cheapest) : null,
              availableCount: bucket?.availableCount ?? 0,
              rates: bucket?.rates ?? [],
              workerOnline: r.workerOnline,
              reason: r.reason,
            };
          });
        } catch (e: any) {
          rethrowIfSidecarRunCancelled(e);
          return sidecarFailureOps(br, "airbnb", e?.message ?? String(e));
        } finally {
          markProgressDone(progressLabel, "airbnb", br);
        }
      })(),
    );
    sidecarOps.push(
      (async (): Promise<SidecarOp[]> => {
        const progressLabel = `VRBO ${br}+BR (8-window sidecar)`;
        try {
          assertSidecarRunCurrent();
          const { searchVrboViaSidecar } = await import("./vrbo-sidecar-queue");
          const r = await searchVrboViaSidecar({
            destination: targetDest,
            checkIn,
            checkOut,
            bedrooms: br,
            // 60s was hitting the wall when the daemon was busy with
            // back-to-back property refreshes from the cron. 90s
            // gives the LOW-season VRBO + Booking pulls room to
            // finish even on a queued daemon. Worst-case wall per
            // property = 90s VRBO + 90s Booking serialized = 180s,
            // still well under Railway's 5-min edge timeout.
            walletBudgetMs: 90_000,
            queueBudgetMs: sidecarQueueBudgetMs,
            signal: args.signal,
            stopGeneration: sidecarStopGeneration,
          });
          if (!r) return sidecarFailureOps(br, "vrbo", "wrapper returned null");
          // Filter to listings that actually quote a per-night and
          // (when bedroom count is known) match the requested BR.
          // Sidecar VRBO scrape returns nightlyPrice already
          // amortized from the multi-night total.
          //
          // Normalize each candidate before choosing cheapest so all-in and
          // pre-tax Vrbo card formats compare fairly.
          const targetBrs = targetBrsForSearch(br);
          const byBr = new Map<number, {
            cheapest: number;
            availableCount: number;
            cheapestIncludesTaxes: boolean;
            cheapestIncludesFees: boolean;
            cheapestPriceBasis?: PriceBasis;
          }>();
          for (const targetBr of targetBrs) {
            byBr.set(targetBr, { cheapest: Infinity, availableCount: 0, cheapestIncludesTaxes: false, cheapestIncludesFees: true });
          }
          for (const c of r.candidates) {
            if (!(c.nightlyPrice > 0)) continue;
            for (const targetBr of candidateTargetBrs(c.bedrooms, br, targetBrs)) {
              const bucket = byBr.get(targetBr);
              if (!bucket) continue;
              bucket.availableCount++;
              const nightly = normalizeQuotedNightly(c.nightlyPrice, "vrbo", region, targetBr, nights, {
                priceIncludesTaxes: c.priceIncludesTaxes,
                priceIncludesFees: c.priceIncludesFees,
                priceBasis: c.priceBasis,
              });
              if (nightly < bucket.cheapest) {
                bucket.cheapest = nightly;
                bucket.cheapestIncludesTaxes = c.priceIncludesTaxes ?? defaultPriceIncludesTaxes("vrbo", c.priceBasis);
                bucket.cheapestIncludesFees = c.priceIncludesFees ?? defaultPriceIncludesFees("vrbo", c.priceBasis);
                bucket.cheapestPriceBasis = c.priceBasis;
              }
            }
          }
          return targetBrs.map((targetBr) => {
            const bucket = byBr.get(targetBr);
            return {
              br: targetBr,
              channel: "vrbo",
              cheapestNightly: bucket && Number.isFinite(bucket.cheapest) ? Math.round(bucket.cheapest) : null,
              availableCount: bucket?.availableCount ?? 0,
              cheapestIncludesTaxes: bucket?.cheapestIncludesTaxes ?? false,
              cheapestIncludesFees: bucket?.cheapestIncludesFees ?? true,
              cheapestPriceBasis: bucket?.cheapestPriceBasis,
              workerOnline: r.workerOnline,
              reason: r.reason,
            };
          });
        } catch (e: any) {
          rethrowIfSidecarRunCancelled(e);
          return sidecarFailureOps(br, "vrbo", e?.message ?? String(e));
        } finally {
          markProgressDone(progressLabel, "vrbo", br);
        }
      })(),
    );
    sidecarOps.push(
      (async (): Promise<SidecarOp[]> => {
        const progressLabel = `Booking.com ${br}+BR (8-window sidecar)`;
        try {
          assertSidecarRunCurrent();
          const { searchBookingViaSidecar } = await import("./vrbo-sidecar-queue");
          const r = await searchBookingViaSidecar({
            destination: targetDest,
            checkIn,
            checkOut,
            bedrooms: br,
            // 60s was hitting the wall when the daemon was busy with
            // back-to-back property refreshes from the cron. 90s
            // gives the LOW-season VRBO + Booking pulls room to
            // finish even on a queued daemon. Worst-case wall per
            // property = 90s VRBO + 90s Booking serialized = 180s,
            // still well under Railway's 5-min edge timeout.
            walletBudgetMs: 90_000,
            queueBudgetMs: sidecarQueueBudgetMs,
            signal: args.signal,
            stopGeneration: sidecarStopGeneration,
          });
          // Booking sidecar publishes `totalPrice` and leaves
          // `nightlyPrice = 0` for the caller to derive (see the
          // BookingSearch processor in worker.mjs). Compute nightly
          // from this exact sampled window.
          const targetBrs = targetBrsForSearch(br);
            const byBr = new Map<number, { cheapest: number; availableCount: number }>();
          for (const targetBr of targetBrs) {
            byBr.set(targetBr, { cheapest: Infinity, availableCount: 0 });
          }
            for (const c of r.candidates) {
              if (!(c.totalPrice > 0)) continue;
              const rawNightly = Math.round(c.totalPrice / nights);
              for (const targetBr of candidateTargetBrs(c.bedrooms, br, targetBrs)) {
                const bucket = byBr.get(targetBr);
                if (!bucket) continue;
                bucket.availableCount++;
                const nightly = normalizeQuotedNightly(rawNightly, "booking", region, targetBr, nights, {
                  priceIncludesTaxes: c.priceIncludesTaxes,
                  priceIncludesFees: c.priceIncludesFees,
                  priceBasis: c.priceBasis,
                });
                if (nightly < bucket.cheapest) bucket.cheapest = nightly;
              }
            }
          return targetBrs.map((targetBr) => {
            const bucket = byBr.get(targetBr);
            return {
              br: targetBr,
              channel: "booking",
              cheapestNightly: bucket && Number.isFinite(bucket.cheapest) ? bucket.cheapest : null,
              availableCount: bucket?.availableCount ?? 0,
              workerOnline: r.workerOnline,
              reason: r.reason,
            };
          });
        } catch (e: any) {
          rethrowIfSidecarRunCancelled(e);
          return sidecarFailureOps(br, "booking", e?.message ?? String(e));
        } finally {
          markProgressDone(progressLabel, "booking", br);
        }
      })(),
    );
  }
  if (!args.skipSidecar && !args.skipPm && pmSearchEnabled) {
    if (reuseSharedPmSearch) {
      pmOps.push((async () => {
        const progressLabel = `PM/direct sites ${sortedBedroomCounts.join("/")}BR`;
        try {
          return await fetchPmMarketRatesForBedroomSet({
            community: args.community,
            city: args.city,
            state: args.state,
            searchName: args.searchName,
            bedroomCounts: sortedBedroomCounts,
            checkIn,
            checkOut,
            region: inferRegion(args.city, args.state),
            sidecarQueueBudgetMs,
            pmPerSiteLimit: args.pmPerSiteLimit,
            pmMaxSites: args.pmMaxSites,
            pmWalletBudgetMs: args.pmWalletBudgetMs,
            sidecarStopGeneration,
            signal: args.signal,
          });
        } finally {
          markProgressDone(progressLabel, "pm", sharedOtaBedroomCount);
        }
      })());
    } else for (const br of args.bedroomCounts) {
      pmOps.push((async () => {
        const progressLabel = `PM/direct sites ${br}BR`;
      try {
        return [await fetchPmMarketRatesForBedroom({
          community: args.community,
          city: args.city,
          state: args.state,
          searchName: args.searchName,
          bedrooms: br,
          checkIn,
          checkOut,
          region: inferRegion(args.city, args.state),
          sidecarQueueBudgetMs,
          pmPerSiteLimit: args.pmPerSiteLimit,
          pmMaxSites: args.pmMaxSites,
          pmWalletBudgetMs: args.pmWalletBudgetMs,
          sidecarStopGeneration,
          signal: args.signal,
        })];
      } finally {
        markProgressDone(progressLabel, "pm", br);
      }
      })());
    }
  }
  const [airbnbFallbackResult, sidecarResults, pmResults] = await Promise.all([
    airbnbFallbackPromise,
    Promise.all(sidecarOps).then((groups) => groups.flat()),
    Promise.all(pmOps).then((groups) => groups.flat()),
  ]);

  const daemonOnline =
    sidecarResults.some((r) => r.workerOnline) ||
    pmResults.some((r) => r.workerOnline);

  // Sanity floor for outlier channel rates. Surfaced 2026-04-29: the
  // Booking scraper was regex-matching a "$28 savings" badge instead
  // of the listing total, returning a $28 nightly that polluted the
  // median for 2BR Hawaii rentals (real basis ~$300+).
  //
  // Strategy: when Airbnb.com returns a baseline, drop any other
  // channel rate that's < SANITY_FLOOR_RATIO of it. Airbnb's sidecar
  // result cards are date-filtered and all-in enough to serve as a
  // reasonable lower bound for "what a real rental for these dates
  // looks like." Anything below half of that is almost
  // certainly a scraper bug.
  //
  // When Airbnb returned no samples (daemon offline / no inventory), we
  // can't compute a baseline; pass channel rates through unfiltered
  // and let downstream handle it. Region-tier minimums could be
  // added here later if needed (Hawaii ~$100/n floor, FL ~$40).
  const SANITY_FLOOR_RATIO = 0.5;
  const passSanity = (rate: number, baseline: number | null): boolean => {
    if (baseline == null || baseline <= 0) return true;
    return rate >= baseline * SANITY_FLOOR_RATIO;
  };

  // Build the channel cheapest map, normalized to all-in nightly.
  // Airbnb sidecar totals are left as-is; VRBO + Booking sidecar
  // scrapes are often pre-tax, so we multiply them by the
  // region's combined tax factor (see TAX_NORMALIZATION_FACTOR comment
  // above).
  const channelCheapestByBR: MultiChannelBuyInResult["channelCheapestByBR"] = {};
  const channelAvailableCountsByBR: MultiChannelBuyInResult["channelAvailableCountsByBR"] = {};
  const ratesByBR: Record<number, number[]> = {};
  for (const br of args.bedroomCounts) {
    const airbnbSidecar = sidecarResults.find(
      (r) => r.br === br && r.channel === "airbnb",
    );
    const airbnbSamples = airbnbSidecar?.rates?.length
      ? airbnbSidecar.rates
      : (airbnbFallbackResult.ratesByBR[br] ?? []);
    ratesByBR[br] = airbnbSamples;
    const airbnbCheapest =
      airbnbSidecar?.cheapestNightly != null
        ? airbnbSidecar.cheapestNightly
        : airbnbSamples.length > 0
          ? Math.min(...airbnbSamples)
          : null;
    const vrboSidecar = sidecarResults.find(
      (r) => r.br === br && r.channel === "vrbo",
    );
    const bookingSidecar = sidecarResults.find(
      (r) => r.br === br && r.channel === "booking",
    );
    const pmRates = pmResults.find((r) => r.br === br);

    // Channel sidecar workers normalize each candidate to all-in nightly
    // before cheapest selection, so final aggregation just sanity-checks.
    const vrboNormalized = vrboSidecar?.cheapestNightly ?? null;
    const bookingNormalized = bookingSidecar?.cheapestNightly ?? null;

    channelCheapestByBR[br] = {
      airbnb: airbnbCheapest,
      vrbo: vrboNormalized != null && passSanity(vrboNormalized, airbnbCheapest)
        ? vrboNormalized
        : null,
      booking: bookingNormalized != null && passSanity(bookingNormalized, airbnbCheapest)
        ? bookingNormalized
        : null,
      pm: pmRates?.medianNightly != null && passSanity(pmRates.medianNightly, airbnbCheapest)
        ? pmRates.medianNightly
        : null,
    };
    const airbnbCount = airbnbSidecar?.availableCount ?? airbnbSamples.length;
    const vrboCount = vrboSidecar?.availableCount ?? 0;
    const bookingCount = bookingSidecar?.availableCount ?? 0;
    const pmCount = pmRates?.sampleCount ?? 0;
    channelAvailableCountsByBR[br] = {
      airbnb: airbnbCount,
      vrbo: vrboCount,
      booking: bookingCount,
      pm: pmCount,
      total: airbnbCount + vrboCount + bookingCount + pmCount,
    };
  }
  const rawChannelCheapestByBR = Object.fromEntries(
    Object.entries(channelCheapestByBR).map(([br, values]) => [Number(br), { ...values }]),
  ) as NonNullable<MultiChannelBuyInResult["rawChannelCheapestByBR"]>;

  // Cross-BR monotonicity filter (PR #289, relaxed in PR #305).
  // A larger bedroom count should never have a basis dramatically
  // below a smaller one — vacation rental pricing is monotonic in
  // bedrooms. This is a backstop for when the per-BR-vs-Airbnb
  // sanity floor can't catch a scraper bug (because Airbnb returned
  // 0 listings for that BR + window).
  //
  // Concrete case from 2026-04-29: Kaha Lani 3BR LOW window had no
  // Airbnb data at all (sidecar returned no priced result cards) and
  // sidecar Booking returned a $58/night (× 1.155 tax = $67 chip)
  // — the Booking scraper's regex matched a discount/per-person
  // rate. The 2BR Airbnb LOW was $256 so the $67 was clearly junk.
  //
  // Original filter used a strict "larger < smaller floor" threshold,
  // which dropped legitimate 3BR rates that came in slightly below
  // the 2BR cheapest due to scan-to-scan variance (e.g. Pili Mai 3BR
  // VRBO $400 vs 2BR floor $407). Relaxed to 50% of smaller-BR floor
  // — matches the per-BR sanity floor philosophy: catches obvious
  // garbage like the original $67/$256 case but allows
  // close-to-neighbor rates through.
  //
  // Walks BRs ascending. For each BR > the smallest, computes a
  // floor from the previous (smaller) BR's lowest non-null channel,
  // then nulls any channel on the larger BR that falls below half
  // of that floor.
  const sortedBRs = [...args.bedroomCounts].sort((a, b) => a - b);
  for (let i = 1; i < sortedBRs.length; i++) {
    const smallerBR = sortedBRs[i - 1];
    const largerBR = sortedBRs[i];
    const smaller = channelCheapestByBR[smallerBR];
    const larger = channelCheapestByBR[largerBR];
    if (!smaller || !larger) continue;
    const smallerCandidates = [smaller.airbnb, smaller.vrbo, smaller.booking]
      .filter((n): n is number => typeof n === "number" && n > 0);
    if (smallerCandidates.length === 0) continue;
    const floor = Math.min(...smallerCandidates) * 0.5;
    if (larger.airbnb != null && larger.airbnb < floor) larger.airbnb = null;
    if (larger.vrbo != null && larger.vrbo < floor) larger.vrbo = null;
    if (larger.booking != null && larger.booking < floor) larger.booking = null;
    if (larger.pm != null && larger.pm < floor) larger.pm = null;
  }

  const consensusCheapestByBR: NonNullable<MultiChannelBuyInResult["consensusCheapestByBR"]> = {};
  const cheapestConfidence: NonNullable<MultiChannelBuyInResult["cheapestConfidence"]> = {};
  for (const br of args.bedroomCounts) {
    const channelValues = channelCheapestByBR[br];
    const availableCounts = channelAvailableCountsByBR[br];
    const values = channelValues
      ? [channelValues.airbnb, channelValues.vrbo, channelValues.booking, channelValues.pm]
          .filter((n): n is number => typeof n === "number" && n > 0)
      : [];
    const sourceDiversity = values.length;
    const sampleCount = availableCounts
      ? availableCounts.airbnb + availableCounts.vrbo + availableCounts.booking + availableCounts.pm
      : values.length;
    consensusCheapestByBR[br] = computeRobustCheapest(values);
    cheapestConfidence[br] = {
      sampleCount,
      sourceDiversity,
      ...(sourceDiversity < 2 ? { singleSourceWarning: true } : {}),
    };
  }

  // Scan sidecar results for surfaceable warnings (CAPTCHA, bot wall,
  // rate-limit, timeout, etc.). De-dup by (channel, kind) so an op
  // that hit CAPTCHA on every BR doesn't flood the UI with three
  // identical banners. Season is filled in placeholder-style here;
  // the per-season orchestrator overwrites with the real label.
  const warnings: ScanWarning[] = [];
  const seen = new Set<string>();
  for (const op of sidecarResults) {
    const kind = classifyScanReason(op.reason);
    if (!kind) continue;
    const key = `${op.channel}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push({
      season: warningSeason,
      channel: op.channel,
      kind,
      message: describeWarning(kind, op.channel, warningSeason),
      reason: op.reason,
    });
  }
  for (const pm of pmResults) {
    const kind = classifyScanReason(pm.reason);
    if (!kind) continue;
    const key = `pm|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push({
      season: warningSeason,
      channel: "pm",
      kind,
      message: describeWarning(kind, "pm", warningSeason),
      reason: pm.reason,
    });
  }

  return {
    ratesByBR,
    channelCheapestByBR,
    rawChannelCheapestByBR,
    consensusCheapestByBR,
    cheapestConfidence,
    channelAvailableCountsByBR,
    snapshotCheckIn: checkIn,
    snapshotCheckOut: checkOut,
    daemonOnline,
    region,
    taxFactor: TAX_NORMALIZATION_FACTOR[region],
    durationMs: Date.now() - startedAt,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────
// Per-season scan wrapper (PR #282)
// ─────────────────────────────────────────────────────────────────
//
// Picks one 7-night window in each of LOW / HIGH / HOLIDAY seasons
// (region-aware), runs the multi-channel scan against each, and
// returns a per-season basis per bedroom. Intended use: feeds the
// Pricing tab's per-season buy-in basis instead of the legacy
// "single LOW window × seasonal multipliers" model.
//
// LOW/HIGH/HOLIDAY all run the OTA path now:
// sidecar Airbnb + sidecar VRBO + sidecar Booking.
// PM/direct websites are not discovered or scraped for buy-in rates.
//
// Total wall time depends on sidecar queue depth and bedroom counts;
// the outer deadline below returns partial seasons after 15 minutes.

export type SeasonKey = "LOW" | "HIGH" | "HOLIDAY";

export type MultiSeasonBuyInResult = {
  perSeason: Record<SeasonKey, MultiChannelBuyInResult | null>;
  region: RegionKey;
  durationMs: number;
};

// Pick a 7-night window for a given season, starting from the next
// matching month after `today`. Returns null when no window in the
// next 24 months matches (shouldn't happen for our season tables —
// every region has at least one LOW + HIGH month per year — but
// nullable so the caller can skip cleanly).
function pickSeasonWindow(
  region: RegionKey,
  season: SeasonKey,
): { checkIn: string; checkOut: string } | null {
  const HAWAII_SEASONS: Record<string, "LOW" | "HIGH"> = {
    "2026-04": "HIGH", "2026-05": "LOW",  "2026-06": "HIGH", "2026-07": "HIGH",
    "2026-08": "HIGH", "2026-09": "LOW",  "2026-10": "LOW",  "2026-11": "LOW",
    "2026-12": "HIGH", "2027-01": "HIGH", "2027-02": "LOW",  "2027-03": "HIGH",
    "2027-04": "HIGH", "2027-05": "LOW",  "2027-06": "HIGH", "2027-07": "HIGH",
    "2027-08": "HIGH", "2027-09": "LOW",  "2027-10": "LOW",  "2027-11": "LOW",
    "2027-12": "HIGH", "2028-01": "HIGH", "2028-02": "LOW",  "2028-03": "HIGH",
    "2028-04": "HIGH",
  };
  const FLORIDA_SEASONS: Record<string, "LOW" | "HIGH"> = {
    "2026-04": "HIGH", "2026-05": "LOW",  "2026-06": "HIGH", "2026-07": "HIGH",
    "2026-08": "HIGH", "2026-09": "LOW",  "2026-10": "LOW",  "2026-11": "LOW",
    "2026-12": "HIGH", "2027-01": "LOW",  "2027-02": "LOW",  "2027-03": "HIGH",
    "2027-04": "HIGH", "2027-05": "LOW",  "2027-06": "HIGH", "2027-07": "HIGH",
    "2027-08": "HIGH", "2027-09": "LOW",  "2027-10": "LOW",  "2027-11": "LOW",
    "2027-12": "HIGH", "2028-01": "LOW",  "2028-02": "LOW",  "2028-03": "HIGH",
    "2028-04": "HIGH",
  };
  const seasonMap = region === "florida" ? FLORIDA_SEASONS : HAWAII_SEASONS;
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  if (season === "HOLIDAY") {
    // Pick the next upcoming holiday range from the 5 in pricing-data.
    // Sample mid-range: e.g. Christmas/NYE → Dec 23-30.
    const holidays: Array<{ sm: number; sd: number; em: number; ed: number }> = [
      { sm: 12, sd: 20, em: 1, ed: 5 },   // Christmas / NY (year-wrap)
      { sm: 7, sd: 1, em: 7, ed: 7 },     // Independence Day
      { sm: 11, sd: 22, em: 11, ed: 30 }, // Thanksgiving
      { sm: 3, sd: 15, em: 4, ed: 5 },    // Spring Break
      { sm: 2, sd: 14, em: 2, ed: 17 },   // Presidents Weekend
    ];
    // Try this year and next; pick whichever gives the soonest
    // future window.
    let best: { d: Date } | null = null;
    for (const yearOffset of [0, 1]) {
      for (const h of holidays) {
        const year = today.getUTCFullYear() + yearOffset;
        // Use the start of the holiday range as the check-in. For
        // year-wrapping ranges (Christmas/NY) start of the range
        // belongs to the earlier year.
        const checkIn = new Date(Date.UTC(year, h.sm - 1, h.sd + 2));
        if (checkIn <= today) continue;
        if (!best || checkIn < best.d) best = { d: checkIn };
      }
    }
    if (!best) return null;
    const checkOut = new Date(best.d);
    checkOut.setUTCDate(checkOut.getUTCDate() + 7);
    return { checkIn: ymd(best.d), checkOut: ymd(checkOut) };
  }

  // LOW or HIGH: walk forward until we find a matching month, then
  // pick the 15th + 7 nights.
  for (let monthOffset = 1; monthOffset <= 24; monthOffset++) {
    const target = new Date(today);
    target.setUTCMonth(target.getUTCMonth() + monthOffset);
    const yearMonth = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}`;
    if (seasonMap[yearMonth] === season) {
      const checkIn = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 15));
      const checkOut = new Date(checkIn);
      checkOut.setUTCDate(checkOut.getUTCDate() + 7);
      return { checkIn: ymd(checkIn), checkOut: ymd(checkOut) };
    }
  }
  return null;
}

// In-memory progress state for the manual refresh button. Keyed by
// propertyId. Lifecycle: set on scan start, updated as each phase
// completes, cleared after `done`. The Pricing tab polls this every
// 1.5s while a refresh is in flight to render the progress bar.
//
// Phases (in rough order) — all three seasons run sidecar VRBO + Booking
// after PR #305 (was LOW-only before that):
//   starting → airbnb-low → airbnb-high → airbnb-holiday →
//   sidecar-low → sidecar-high → sidecar-holiday → persisting →
//   done | error
//
// Each season queues Airbnb / VRBO / Booking.com / PM website work
// through the daemon's single Chrome. Season-band pricing refreshes also
// include exact window counters so the UI can show completed 7-night
// samples instead of relying on a rough phase estimate.
export type RefreshProgressState = {
  propertyId: number;
  startedAt: number;
  phase:
    | "starting"
    | "monthly" | "banded"
    | "airbnb-low" | "airbnb-high" | "airbnb-holiday"
    | "sidecar-low" | "sidecar-high" | "sidecar-holiday"
    | "persisting" | "done" | "error";
  percent: number;
  label: string;
  error?: string;
  // Optional exact work-unit counters for long season-band market-rate
  // scans. `percent` remains the generic fallback, but the Pricing tab
  // prefers these when present so the bar reflects real windows
  // completed instead of a rough phase estimate.
  progressDone?: number;
  progressTotal?: number;
  progressCurrent?: number;
  progressWindowLabel?: string;
  progressWindowStartedAt?: number;
  progressSubDone?: number;
  progressSubTotal?: number;
  progressSubLabel?: string;
  progressSubChannel?: ChannelKey;
  progressSubBedrooms?: number;
  progressSubStartedAt?: number;
  // Freeze-detection fields (PR #311). lastTickAt is updated by a
  // 15-second heartbeat AND every setPhase call — so the client can
  // tell the scan is still alive even when no phase boundary has
  // passed for several minutes (typical during sidecar phases that
  // serialize through the daemon's queue). daemonOnline mirrors
  // getHeartbeat().isOnline so the UI can warn "daemon offline" vs
  // just "no progress yet".
  lastTickAt: number;
  daemonOnline?: boolean;
  daemonLastPollAgeMs?: number | null;
  // PR #312: surfaceable issues (CAPTCHA on VRBO sidecar, Cloudflare
  // on Booking, rate-limit, etc.) the operator should know about
  // without reading server logs. Accumulates as seasons complete; the
  // loading bar renders them as inline warnings. Empty when the scan
  // ran clean.
  warnings?: ScanWarning[];
};
const _refreshProgress = new Map<number, RefreshProgressState>();
export function setRefreshProgress(state: Omit<RefreshProgressState, "lastTickAt"> & { lastTickAt?: number }): void {
  _refreshProgress.set(state.propertyId, { ...state, lastTickAt: state.lastTickAt ?? Date.now() });
}
export function getRefreshProgress(propertyId: number): RefreshProgressState | null {
  return _refreshProgress.get(propertyId) ?? null;
}
export function clearRefreshProgress(propertyId: number): void {
  // Keep "done" or "error" terminal states long enough for the Pricing
  // tab to reattach after a Safari reload/sleep or a React remount. The
  // client persists its own dismissible "last scan" notice after it sees
  // this terminal state.
  setTimeout(() => _refreshProgress.delete(propertyId), 10 * 60_000);
}

// Heartbeat ticker. Every 15s during a non-terminal scan, refresh
// `lastTickAt` and pull current daemon status into the progress
// state. Lets the client distinguish "scan still running, daemon
// alive, just queued behind other work" from "scan actually frozen
// — daemon dead or process wedged."
//
// Returns a cleanup function the caller invokes in `finally` to stop
// the interval.
function startProgressHeartbeat(propertyId: number): () => void {
  const tick = async () => {
    const current = _refreshProgress.get(propertyId);
    if (!current) return;
    if (current.phase === "done" || current.phase === "error") return;
    try {
      const { getHeartbeat } = await import("./vrbo-sidecar-queue");
      const hb = getHeartbeat();
      _refreshProgress.set(propertyId, {
        ...current,
        lastTickAt: Date.now(),
        daemonOnline: hb.isOnline,
        daemonLastPollAgeMs: hb.ageMs,
      });
    } catch {
      // Don't let heartbeat errors poison the scan; just refresh the
      // tick timestamp so the client at least knows the scan loop
      // itself is alive.
      _refreshProgress.set(propertyId, { ...current, lastTickAt: Date.now() });
    }
  };
  // Tick once immediately so the first heartbeat lands within ms,
  // then every 15s.
  void tick();
  const interval = setInterval(tick, 15_000);
  return () => clearInterval(interval);
}

export async function fetchMultiChannelBuyInBySeason(args: {
  community: string;
  city: string;
  state: string;
  streetAddress?: string;
  bboxCenterOverride?: { lat: number; lng: number };
  searchName?: string;
  bedroomCounts: number[];
  propertyId: number; // for progress tracking
  sidecarQueueBudgetMs?: number;
  seasonDeadlineMs?: number;
  reuseSharedOtaSearch?: boolean;
  sidecarStopGeneration?: number;
}): Promise<MultiSeasonBuyInResult> {
  const startedAt = Date.now();
  const region: RegionKey = args.state.toLowerCase().match(/^(florida|fl)$/) ? "florida" : "hawaii";
  const sidecarStopGeneration = args.sidecarStopGeneration ?? getSidecarStopGeneration();
  const assertSidecarRunCurrent = () => {
    if (hasSidecarStopGenerationChanged(sidecarStopGeneration)) {
      throw sidecarRunCancelledError();
    }
  };

  const setPhase = (phase: RefreshProgressState["phase"], percent: number, label: string) =>
    setRefreshProgress({ propertyId: args.propertyId, startedAt, phase, percent, label });

  // Start the daemon-heartbeat ticker so lastTickAt + daemonOnline
  // refresh every 15s during long sidecar phases. Stopped in finally.
  const stopHeartbeat = startProgressHeartbeat(args.propertyId);
  try {
  setPhase("starting", 0, "Starting multi-season scan");

  // All three seasons get the full multichannel website scan (Airbnb
  // + VRBO + Booking + PM through sidecar). Run the seasons in a
  // deterministic sequence instead of queueing all three at once:
  // the local sidecar has a single Chrome worker, so concurrent
  // season launches can push HOLIDAY behind LOW/HIGH and make the
  // outer deadline return before holiday gets a fair run.
  const lowWindow = pickSeasonWindow(region, "LOW");
  const highWindow = pickSeasonWindow(region, "HIGH");
  const holidayWindow = pickSeasonWindow(region, "HOLIDAY");
  const seasonWindows: Record<SeasonKey, { checkIn: string; checkOut: string } | null> = {
    LOW: lowWindow,
    HIGH: highWindow,
    HOLIDAY: holidayWindow,
  };

  setPhase("airbnb-low", 3, `Queueing Airbnb/VRBO/Booking/PM sidecar scans (LOW: ${lowWindow?.checkIn ?? "—"})`);
  let highestPercent = 0;
  const accumulatedWarnings: ScanWarning[] = [];
  const setPhaseAtLeast = (phase: RefreshProgressState["phase"], percent: number, label: string) => {
    if (percent > highestPercent) highestPercent = percent;
    const current = _refreshProgress.get(args.propertyId);
    setRefreshProgress({
      propertyId: args.propertyId,
      startedAt,
      phase,
      percent: highestPercent,
      label,
      // Preserve daemon fields and warnings across phase changes —
      // the heartbeat updates daemon fields independently, but this
      // setPhase call would otherwise drop them.
      daemonOnline: current?.daemonOnline,
      daemonLastPollAgeMs: current?.daemonLastPollAgeMs,
      warnings: accumulatedWarnings.length > 0 ? [...accumulatedWarnings] : undefined,
    });
  };
  const ingestSeasonWarnings = (
    season: SeasonKey,
    result: MultiChannelBuyInResult | null,
  ) => {
    if (!result?.warnings || result.warnings.length === 0) return;
    for (const w of result.warnings) {
      accumulatedWarnings.push({
        ...w,
        season,
        message: describeWarning(w.kind, w.channel, season),
      });
    }
  };

  const deadlineMs = args.seasonDeadlineMs ?? 25 * 60_000;
  const waitWithDeadline = async <T>(p: Promise<T>, season: SeasonKey): Promise<T | null> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => {
            accumulatedWarnings.push({
              season,
              channel: "engine",
              kind: "timeout",
              message: `${season} scan exceeded ${Math.round(deadlineMs / 60_000)} minutes; using the seasonal fallback if no rate landed.`,
            });
            resolve(null);
          }, deadlineMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const perSeason: Record<SeasonKey, MultiChannelBuyInResult | null> = { LOW: null, HIGH: null, HOLIDAY: null };
  const scanSeason = async (
    season: SeasonKey,
    startPhase: RefreshProgressState["phase"],
    donePhase: RefreshProgressState["phase"],
    startPercent: number,
    donePercent: number,
  ) => {
    const window = seasonWindows[season];
    if (!window) {
      setPhaseAtLeast(donePhase, donePercent, `${season} season has no matching sample window`);
      return;
    }
    setPhaseAtLeast(startPhase, startPercent, `${season} season multichannel scan (${window.checkIn} to ${window.checkOut})`);
    assertSidecarRunCurrent();
    const result = await waitWithDeadline(
      fetchMultiChannelBuyInByBR({
        ...args,
        dateOverride: window,
        sidecarQueueBudgetMs: args.sidecarQueueBudgetMs,
        warningSeason: season,
        sidecarStopGeneration,
      }),
      season,
    );
    assertSidecarRunCurrent();
    perSeason[season] = result;
    ingestSeasonWarnings(season, result);
    setPhaseAtLeast(
      donePhase,
      donePercent,
      result
        ? `${season} season multichannel scan done`
        : `${season} season timed out; fallback will be used if needed`,
    );
  };

  try {
    await scanSeason("LOW", "airbnb-low", "sidecar-low", 3, 35);
    await scanSeason("HIGH", "airbnb-high", "sidecar-high", 38, 65);
    await scanSeason("HOLIDAY", "airbnb-holiday", "sidecar-holiday", 68, 90);
  } catch (error: any) {
    if (error?.name === "SidecarRunCancelledError") {
      setRefreshProgress({
        propertyId: args.propertyId,
        startedAt,
        phase: "error",
        percent: 100,
        label: "Market-rate scan cancelled",
        error: "Cancelled by Sidecar Stop",
      });
    }
    throw error;
  }

  setPhaseAtLeast("persisting", 95, "Persisting medians");

  return {
    perSeason,
    region,
    durationMs: Date.now() - startedAt,
  };
  } finally {
    stopHeartbeat();
  }
}
