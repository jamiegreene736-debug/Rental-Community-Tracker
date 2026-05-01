// Multi-channel buy-in cost-basis + live snapshot scanner.
//
// The Pricing tab's per-channel sell-price floor formula is
// `(buyIn × 1.20) / (1 - channelFee)`. That formula calibrates well
// only when `buyIn` is a stable median across comparable units —
// historically Airbnb-engine 7-night-amortized median per bedroom,
// returned by `fetchAmortizedNightlyByBR`.
//
// This helper keeps that median as the persisted cost basis (so the
// sell-price floor doesn't lurch around with one-off cheap deals) AND
// adds a parallel "live channel snapshot": the cheapest verified
// nightly across Airbnb / VRBO / Booking for the SAME 7-night
// 30-day-out window, pulled through the local-Chrome sidecar daemon
// for VRBO and Booking. The snapshot is ephemeral — returned in the
// refresh response, surfaced in the Pricing tab, never persisted —
// so the operator can see when one channel's cheapest is materially
// below the median basis ("VRBO has $580/n today; basis is $620").
//
// When the daemon is offline, sidecar searches return empty and the
// snapshot collapses to just the Airbnb-engine cheapest. That's the
// same data the legacy refresh path produced, so this helper is a
// strict superset.

import { fetchAmortizedNightlyByBR } from "./community-research";
import { findAvailableGatherVacationsUnits } from "./pm-scraper-gather-vacations";
import { findAvailableStreamlineUnits, STREAMLINE_SITES } from "./pm-scraper-streamline";
import { findAvailableSuiteParadiseUnits } from "./pm-scraper-suite-paradise";
import { findAvailableVrpUnits, VRP_SITES } from "./pm-scraper-vrp";
import { checkPmUrlsBatchViaSidecar } from "./vrbo-sidecar-queue";

export type ChannelKey = "airbnb" | "vrbo" | "booking" | "pm";
export type RegionKey = "hawaii" | "florida";

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
  if (s.includes("timeout") || s.includes("timed out") || s.includes("navigation timeout") || s.includes("walletbudget")) return "timeout";
  if (s.includes("econnreset") || s.includes("enotfound") || s.includes("network error") || s.includes("net::")) return "network";
  // "worker likely offline" / "request expired" cover the daemon-down case;
  // those surface separately via daemonOnline so don't double-warn.
  return null;
}

function describeWarning(kind: ScanWarning["kind"], channel: ScanWarning["channel"], season: ScanWarning["season"]): string {
  const ch = channel === "engine" ? "Airbnb engine" : channel.toUpperCase();
  switch (kind) {
    case "captcha":    return `${ch} hit a CAPTCHA during the ${season} scan — sidecar daemon may need manual unblock before retrying.`;
    case "blocked":    return `${ch} blocked the ${season} scan (Cloudflare / bot wall) — try again later or rotate the daemon's session.`;
    case "rate-limit": return `${ch} rate-limited the ${season} scan — back off a few minutes and retry.`;
    case "timeout":    return `${ch} timed out during the ${season} scan — daemon queue may be busy or the page didn't load.`;
    case "network":    return `${ch} network error during the ${season} scan — check daemon Mac connectivity.`;
    case "unknown":    return `${ch} reported an issue during the ${season} scan.`;
  }
}

// Tax/fee normalization to bring sidecar VRBO + Booking + PM rates onto
// the same all-in basis as the Airbnb engine.
//
// Airbnb engine returns `extracted_total_price` which already
// includes Airbnb's guest service fee + state/county taxes — so
// dividing by 7 nights gives a true all-in nightly.
//
// VRBO sidecar scrapes `$X for Y nights` from the search-card
// label, which is the listing total + Vrbo service fee BUT
// EXCLUDES state/local taxes (those land at checkout). Booking.com
// is the same shape. Some PM direct APIs return base nightly calendars
// without taxes/fees, while the browser sidecar often sees all-in totals
// once it submits the date search; callers flag which PM samples already
// include taxes.
//
// To make per-channel medians honest, multiply VRBO + Booking
// nightlies by the region's combined tax rate. Hawaii TAT (10.25%)
// + GET (4.71%) + County GET (0.5%) ≈ 15.5%, round to 1.155.
// Florida sales tax (6%) + tourist development tax (5%) ≈ 11%,
// round to 1.11. These are coarse — actual rates vary by county —
// but they get the median within ~1-2% of correct, which is
// already better than the old "raw mix of pre/post-tax" basis.
const TAX_NORMALIZATION_FACTOR: Record<RegionKey, number> = {
  hawaii: 1.155,
  florida: 1.11,
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

function applyTaxNormalization(
  rate: number,
  channel: ChannelKey,
  region: RegionKey,
): number {
  // Airbnb engine total already inclusive of taxes/fees — leave it.
  if (channel === "airbnb") return rate;
  return Math.round(rate * TAX_NORMALIZATION_FACTOR[region]);
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

function normalizeHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

const PM_DISCOVERY_EXCLUDED_HOSTS = /(?:^|\.)(?:airbnb\.[a-z.]+|vrbo\.com|homeaway\.[a-z.]+|booking\.com|tripadvisor\.com|expedia\.[a-z.]+|hotels\.com|kayak\.com|trivago\.com|priceline\.com|orbitz\.com|travelocity\.com|hotwire\.com|agoda\.com|google\.com|youtube\.com|facebook\.com|instagram\.com|pinterest\.com|reddit\.com|twitter\.com|x\.com|whimstay\.com|vacationrentals\.com|flipkey\.com|holidaylettings\.com)$/i;

function looksLikePmDetailUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (!path || path === "") return false;
    if (/\/(?:search|results?|availability|contact|about|blog|terms|privacy|faq|reviews?|rates?|specials?|deals?)$/i.test(path)) return false;
    if (/\/(?:vacation-rentals|rentals|properties|bedrooms?|category|collections?)$/i.test(path)) return false;
    return path.split("/").filter(Boolean).length >= 1;
  } catch {
    return false;
  }
}

function bedroomTextMatches(haystack: string, bedrooms: number): boolean {
  const text = haystack.toLowerCase();
  const explicit = Array.from(text.matchAll(/\b(\d+)\s*(?:br|bd|bed(?:room)?s?)\b/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 20);
  if (explicit.length === 0) return true;
  return explicit.includes(bedrooms);
}

async function discoverPmUrlsViaSearchApi(opts: {
  target: string;
  locality: string;
  bedrooms: number;
  checkIn: string;
  apiKey: string;
}): Promise<string[]> {
  const queries = Array.from(new Set([
    `"${opts.target}" ${opts.bedrooms} bedroom vacation rental property management book directly`,
    `"${opts.target}" ${opts.bedrooms}BR condo rental direct booking ${opts.locality}`,
    `"${opts.target}" "${opts.checkIn.slice(0, 4)}" vacation rental ${opts.bedrooms} bedroom`,
  ]));
  const seen = new Set<string>();
  const urls: string[] = [];
  const batches = await Promise.all(queries.map(async (query) => {
    const params = new URLSearchParams({
      engine: "google",
      q: query,
      num: "10",
      api_key: opts.apiKey,
    });
    try {
      const r = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return [];
      const data = await r.json() as { organic_results?: Array<{ link?: string; title?: string; snippet?: string }> };
      return Array.isArray(data.organic_results) ? data.organic_results : [];
    } catch {
      return [];
    }
  }));
  for (const batch of batches) {
    for (const hit of batch) {
      const url = String(hit?.link ?? "");
      if (!url || seen.has(url)) continue;
      const host = normalizeHost(url);
      if (!host || PM_DISCOVERY_EXCLUDED_HOSTS.test(host)) continue;
      if (!looksLikePmDetailUrl(url)) continue;
      const hay = `${String(hit?.title ?? "")} ${String(hit?.snippet ?? "")}`;
      if (!bedroomTextMatches(hay, opts.bedrooms)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= 10) return urls;
    }
  }
  return urls;
}

type PmRateSample = {
  source: string;
  url: string;
  title: string;
  bedrooms: number;
  nightlyPrice: number;
  totalPrice: number;
  includesTaxes: boolean;
};

async function fetchPmMarketRatesForBedroom(args: {
  community: string;
  city: string;
  state: string;
  searchName?: string;
  bedrooms: number;
  checkIn: string;
  checkOut: string;
  region: RegionKey;
}): Promise<{
  br: number;
  medianNightly: number | null;
  sampleCount: number;
  workerOnline: boolean;
  reason?: string;
}> {
  const br = args.bedrooms;
  const target = args.searchName ?? args.community;
  const nights = nightsBetween(args.checkIn, args.checkOut);
  const samples: PmRateSample[] = [];
  const pushSample = (sample: PmRateSample) => {
    if (sample.bedrooms !== br || !(sample.nightlyPrice > 0)) return;
    samples.push(sample);
  };

  const isHawaii = /hawaii|kauai|maui|oahu|honolulu|big\s*island|hawai|poipu|princeville|hanalei|wailua|kapaa|koloa|lihue|anini|pili\s*mai|wailea|kaanapali|kihei|lahaina|kaneohe/i
    .test(`${args.community} ${args.searchName ?? ""} ${args.city} ${args.state}`);
  const isPoipu = /poipu|pili\s*mai/i.test(`${args.community} ${args.searchName ?? ""} ${args.city}`);

  const knownTasks: Array<Promise<void>> = [];
  if (isPoipu) {
    knownTasks.push((async () => {
      const units = await findAvailableSuiteParadiseUnits({ bedrooms: br, checkIn: args.checkIn, checkOut: args.checkOut, resortName: target, limit: 10 });
      for (const u of units) pushSample({ source: "Suite Paradise", url: u.url, title: u.title, bedrooms: u.bedrooms, nightlyPrice: u.nightlyPrice, totalPrice: u.totalPrice, includesTaxes: false });
    })());
  }
  if (isHawaii) {
    for (const site of Object.values(VRP_SITES)) {
      knownTasks.push((async () => {
        const units = await findAvailableVrpUnits({ site, bedrooms: br, checkIn: args.checkIn, checkOut: args.checkOut, resortName: target, limit: 10 });
        for (const u of units) pushSample({ source: u.sourceLabel, url: u.url, title: u.name, bedrooms: u.bedrooms, nightlyPrice: u.nightlyPrice, totalPrice: u.totalPrice, includesTaxes: false });
      })());
    }
    knownTasks.push((async () => {
      const units = await findAvailableGatherVacationsUnits({ bedrooms: br, checkIn: args.checkIn, checkOut: args.checkOut, resortName: target, limit: 10 });
      for (const u of units) pushSample({ source: "Gather Vacations", url: u.url, title: u.title, bedrooms: u.bedrooms, nightlyPrice: u.nightlyPrice, totalPrice: u.totalPrice, includesTaxes: false });
    })());
    for (const site of Object.values(STREAMLINE_SITES)) {
      knownTasks.push((async () => {
        const units = await findAvailableStreamlineUnits({ site, bedrooms: br, checkIn: args.checkIn, checkOut: args.checkOut, resortName: target, limit: 10 });
        for (const u of units) pushSample({ source: site.label, url: u.url, title: u.title, bedrooms: u.bedrooms, nightlyPrice: u.nightlyPrice, totalPrice: u.totalPrice, includesTaxes: true });
      })());
    }
  }

  const knownSettled = await Promise.allSettled(knownTasks);
  const knownErrors = knownSettled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason)).slice(0, 3);

  let workerOnline = false;
  let sidecarReason = "";
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (apiKey) {
    const urls = await discoverPmUrlsViaSearchApi({
      target,
      locality: `${args.city} ${args.state}`,
      bedrooms: br,
      checkIn: args.checkIn,
      apiKey,
    });
    if (urls.length > 0) {
      try {
        for (let i = 0; i < urls.length; i += 5) {
          const batch = urls.slice(i, i + 5);
          const r = await checkPmUrlsBatchViaSidecar({
            urls: batch,
            checkIn: args.checkIn,
            checkOut: args.checkOut,
            bedrooms: br,
            walletBudgetMs: 75_000,
          });
          workerOnline = workerOnline || r.workerOnline;
          sidecarReason = r.reason;
          for (const result of r.results) {
            if (result.available !== "yes") continue;
            if (typeof result.bedrooms === "number" && result.bedrooms !== br) continue;
            const total = typeof result.totalPrice === "number" && result.totalPrice > 0
              ? Math.round(result.totalPrice)
              : typeof result.nightlyPrice === "number" && result.nightlyPrice > 0
                ? Math.round(result.nightlyPrice * nights)
                : 0;
            if (!(total > 0)) continue;
            pushSample({
              source: normalizeHost(result.url) ?? "PM sidecar",
              url: result.url,
              title: result.url,
              bedrooms: result.bedrooms ?? br,
              nightlyPrice: Math.round(total / nights),
              totalPrice: total,
              includesTaxes: true,
            });
          }
        }
      } catch (e: any) {
        sidecarReason = e?.message ?? String(e);
      }
    }
  }

  const normalizedRates = samples
    .map((s) => s.includesTaxes ? s.nightlyPrice : applyTaxNormalization(s.nightlyPrice, "pm", args.region))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const medianNightly = medianOfSorted(normalizedRates);
  const reasonBits: string[] = [];
  if (samples.length > 0) reasonBits.push(`${samples.length} verified PM sample(s)`);
  if (sidecarReason) reasonBits.push(sidecarReason);
  if (knownErrors.length > 0) reasonBits.push(`PM direct scraper errors: ${knownErrors.join("; ")}`);

  return {
    br,
    medianNightly,
    sampleCount: normalizedRates.length,
    workerOnline,
    reason: reasonBits.join(" | "),
  };
}

export type MultiChannelBuyInResult = {
  // Per-bedroom rate samples — same shape as
  // fetchAmortizedNightlyByBR's `ratesByBR` so the persisted-median
  // computation in the existing refresh endpoint stays unchanged.
  // Sourced from the Airbnb engine ONLY. These are retained as the
  // fallback distribution when no verified channel signal is available
  // for a BR/season; the primary persisted basis is built from the
  // normalized channel signals below.
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
  // Same identity tuple `fetchAmortizedNightlyByBR` takes, used for
  // the Airbnb engine + bbox geofencing.
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
  // PR #282: optional explicit dates. When supplied, the engine + the
  // sidecar searches all hit this window. When omitted, defaults to
  // the legacy 7-night, 30-day-out window.
  dateOverride?: { checkIn: string; checkOut: string };
  // Optional escape hatch for low-cost probes. Normal pricing and
  // availability scans do not skip sidecar: LOW/HIGH/HOLIDAY all use
  // VRBO + Booking + PM verification.
  skipSidecar?: boolean;
}): Promise<MultiChannelBuyInResult> {
  const startedAt = Date.now();

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

  // Fan out everything in parallel. The Airbnb engine doesn't go
  // through the daemon (single fast SearchAPI call); sidecar VRBO +
  // Booking searches DO go through the daemon and serialize there
  // (single Chrome instance), but starting them concurrently still
  // wins because the Airbnb engine returns immediately while the
  // daemon works through its queue.
  const airbnbPromise = fetchAmortizedNightlyByBR(
    args.community,
    args.city,
    args.state,
    args.streetAddress,
    args.bboxCenterOverride,
    args.dateOverride ? { checkIn, checkOut } : undefined,
  );

  type SidecarOp = {
    br: number;
    channel: ChannelKey;
    cheapestNightly: number | null;
    availableCount: number;
    // PR #299: when daemon used Vrbo's new "$X total includes taxes &
    // fees" format, cheapestNightly is already all-in. Skip the
    // per-region tax-normalization multiplier downstream.
    cheapestIncludesTaxes?: boolean;
    workerOnline: boolean;
    // PR #312: capture the wrapper's `reason` string so the
    // orchestrator can pattern-match for CAPTCHA / bot-block / etc.
    // without changing every call site.
    reason?: string;
  };
  const sidecarOps: Promise<SidecarOp>[] = [];
  const pmOps: Promise<{
    br: number;
    medianNightly: number | null;
    sampleCount: number;
    workerOnline: boolean;
    reason?: string;
  }>[] = [];
  // When caller asks us to skip sidecar, we still build the channel
  // map but browser-backed entries stay null. Normal pricing refreshes
  // do not skip sidecar: LOW/HIGH/HOLIDAY all use VRBO + Booking + PM
  // verification now.
  if (!args.skipSidecar) for (const br of args.bedroomCounts) {
    sidecarOps.push(
      (async (): Promise<SidecarOp> => {
        try {
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
          });
          if (!r) return { br, channel: "vrbo", cheapestNightly: null, availableCount: 0, workerOnline: false, reason: "wrapper returned null" };
          // Filter to listings that actually quote a per-night and
          // (when bedroom count is known) match the requested BR.
          // Sidecar VRBO scrape returns nightlyPrice already
          // amortized from the multi-night total.
          //
          // PR #299: also track whether the cheapest came from Vrbo's
          // new all-in format ("$X total includes taxes & fees"). If
          // so, downstream skips the per-region tax multiplier — the
          // value is already fully loaded.
          let cheapest = Infinity;
          let availableCount = 0;
          let cheapestIncludesTaxes = false;
          for (const c of r.candidates) {
            if (!(c.nightlyPrice > 0)) continue;
            if (c.bedrooms != null && c.bedrooms !== br) continue;
            availableCount++;
            if (c.nightlyPrice < cheapest) {
              cheapest = c.nightlyPrice;
              cheapestIncludesTaxes = c.priceIncludesTaxes ?? false;
            }
          }
          return {
            br,
            channel: "vrbo",
            cheapestNightly: Number.isFinite(cheapest) ? Math.round(cheapest) : null,
            availableCount,
            cheapestIncludesTaxes,
            workerOnline: r.workerOnline,
            reason: r.reason,
          };
        } catch (e: any) {
          return { br, channel: "vrbo", cheapestNightly: null, availableCount: 0, workerOnline: false, reason: e?.message ?? String(e) };
        }
      })(),
    );
    sidecarOps.push(
      (async (): Promise<SidecarOp> => {
        try {
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
          });
          // Booking sidecar publishes `totalPrice` and leaves
          // `nightlyPrice = 0` for the caller to derive (see the
          // BookingSearch processor in worker.mjs). Compute nightly
          // from this exact sampled window.
          let cheapest = Infinity;
          let availableCount = 0;
          for (const c of r.candidates) {
            if (!(c.totalPrice > 0)) continue;
            if (c.bedrooms != null && c.bedrooms !== br) continue;
            availableCount++;
            const nightly = Math.round(c.totalPrice / nights);
            if (nightly < cheapest) cheapest = nightly;
          }
          return {
            br,
            channel: "booking",
            cheapestNightly: Number.isFinite(cheapest) ? cheapest : null,
            availableCount,
            workerOnline: r.workerOnline,
            reason: r.reason,
          };
        } catch (e: any) {
          return { br, channel: "booking", cheapestNightly: null, availableCount: 0, workerOnline: false, reason: e?.message ?? String(e) };
        }
      })(),
    );
    pmOps.push(fetchPmMarketRatesForBedroom({
      community: args.community,
      city: args.city,
      state: args.state,
      searchName: args.searchName,
      bedrooms: br,
      checkIn,
      checkOut,
      region: inferRegion(args.city, args.state),
    }));
  }

  const [airbnbResult, sidecarResults, pmResults] = await Promise.all([
    airbnbPromise,
    Promise.all(sidecarOps),
    Promise.all(pmOps),
  ]);

  // Sparse-BR retry (PR #288). The initial engine call is unfiltered
  // by bedroom count — it returns whatever 2BR/3BR/4BR listings sit
  // inside the bbox, then we bucket by extracted BR. Tight bboxes
  // (e.g. Kapaa Beachfront's 2.7×2.6km) sometimes return zero 3BR
  // listings even when 3BR rentals exist nearby. For each BR the
  // caller asked about, if we got zero samples, fire one targeted
  // fallback call: bedrooms=N pinned to the engine + 2× wider bbox.
  // One extra SearchAPI hit per missing BR, only when the cheap
  // unfiltered pull came up dry — bounded extra cost per refresh.
  for (const br of args.bedroomCounts) {
    if ((airbnbResult.ratesByBR[br] ?? []).length > 0) continue;
    try {
      const fallback = await fetchAmortizedNightlyByBR(
        args.community,
        args.city,
        args.state,
        args.streetAddress,
        args.bboxCenterOverride,
        args.dateOverride ? { checkIn, checkOut } : undefined,
        { bedrooms: br, bboxScale: 2 },
      );
      const samples = fallback.ratesByBR[br] ?? [];
      if (samples.length > 0) airbnbResult.ratesByBR[br] = samples;
    } catch {
      /* sparse-BR retry failure is non-fatal — caller falls back to
         BUY_IN_RATES static for any BR that stayed empty. */
    }
  }

  const region = inferRegion(args.city, args.state);
  const daemonOnline =
    sidecarResults.some((r) => r.workerOnline) ||
    pmResults.some((r) => r.workerOnline);

  // Sanity floor for outlier channel rates. Surfaced 2026-04-29: the
  // Booking scraper was regex-matching a "$28 savings" badge instead
  // of the listing total, returning a $28 nightly that polluted the
  // median for 2BR Hawaii rentals (real basis ~$300+).
  //
  // Strategy: when the Airbnb engine returns a baseline, drop any
  // sidecar channel rate that's < SANITY_FLOOR_RATIO of it. Airbnb
  // is always all-in and engine-validated, so its cheapest sample
  // is a reasonable lower bound for "what a real rental for these
  // dates looks like." Anything below half of that is almost
  // certainly a scraper bug.
  //
  // When Airbnb returned no samples (rare — engine offline), we
  // can't compute a baseline; pass channel rates through unfiltered
  // and let downstream handle it. Region-tier minimums could be
  // added here later if needed (Hawaii ~$100/n floor, FL ~$40).
  const SANITY_FLOOR_RATIO = 0.5;
  const passSanity = (rate: number, baseline: number | null): boolean => {
    if (baseline == null || baseline <= 0) return true;
    return rate >= baseline * SANITY_FLOOR_RATIO;
  };

  // Build the channel cheapest map, normalized to all-in nightly.
  // Airbnb engine totals already include service fee + taxes; VRBO +
  // Booking sidecar scrapes are pre-tax, so we multiply them by the
  // region's combined tax factor (see TAX_NORMALIZATION_FACTOR comment
  // above).
  const channelCheapestByBR: MultiChannelBuyInResult["channelCheapestByBR"] = {};
  const channelAvailableCountsByBR: MultiChannelBuyInResult["channelAvailableCountsByBR"] = {};
  for (const br of args.bedroomCounts) {
    const airbnbSamples = airbnbResult.ratesByBR[br] ?? [];
    const airbnbCheapest =
      airbnbSamples.length > 0 ? Math.min(...airbnbSamples) : null;
    const vrboSidecar = sidecarResults.find(
      (r) => r.br === br && r.channel === "vrbo",
    );
    const bookingSidecar = sidecarResults.find(
      (r) => r.br === br && r.channel === "booking",
    );
    const pmRates = pmResults.find((r) => r.br === br);

    // PR #299: Vrbo's new card format ("$X total includes taxes & fees")
    // gives us all-in nightly directly — skip the per-region tax
    // normalization in that case. Old "$X for Y nights" format (pre-
    // tax) still gets multiplied by the tax factor as before.
    const vrboNormalized = vrboSidecar?.cheapestNightly != null
      ? (vrboSidecar.cheapestIncludesTaxes
          ? vrboSidecar.cheapestNightly
          : applyTaxNormalization(vrboSidecar.cheapestNightly, "vrbo", region))
      : null;
    const bookingNormalized = bookingSidecar?.cheapestNightly != null
      ? applyTaxNormalization(bookingSidecar.cheapestNightly, "booking", region)
      : null;

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
    const airbnbCount = airbnbSamples.length;
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

  // Cross-BR monotonicity filter (PR #289, relaxed in PR #305).
  // A larger bedroom count should never have a basis dramatically
  // below a smaller one — vacation rental pricing is monotonic in
  // bedrooms. This is a backstop for when the per-BR-vs-Airbnb
  // sanity floor can't catch a scraper bug (because Airbnb returned
  // 0 listings for that BR + window).
  //
  // Concrete case from 2026-04-29: Kaha Lani 3BR LOW window had no
  // Airbnb data at all (engine + sparse-BR retry both empty) and
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
      season: "LOW",  // placeholder; orchestrator rewrites with real season
      channel: op.channel,
      kind,
      message: describeWarning(kind, op.channel, "LOW"),
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
      season: "LOW",
      channel: "pm",
      kind,
      message: describeWarning(kind, "pm", "LOW"),
      reason: pm.reason,
    });
  }

  return {
    ratesByBR: airbnbResult.ratesByBR,
    channelCheapestByBR,
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
// LOW/HIGH/HOLIDAY all run the full multichannel path now:
// Airbnb engine + sidecar VRBO + sidecar Booking + verified PM rates.
// PM rates include known direct-booking APIs plus SearchAPI-discovered
// PM detail pages verified through the local Chrome sidecar.
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
// Each season's Airbnb engine returns fast (one SearchAPI call); the
// sidecar work serializes through the daemon's single Chrome, so the
// sidecar-* phases account for ~85% of the wall time and the
// percentages reflect that.
export type RefreshProgressState = {
  propertyId: number;
  startedAt: number;
  phase:
    | "starting"
    | "airbnb-low" | "airbnb-high" | "airbnb-holiday"
    | "sidecar-low" | "sidecar-high" | "sidecar-holiday"
    | "persisting" | "done" | "error";
  percent: number;
  label: string;
  error?: string;
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
  // Keep "done" or "error" terminal states for 30s so the Pricing tab
  // sees the final result before the cleanup race.
  setTimeout(() => _refreshProgress.delete(propertyId), 30_000);
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
}): Promise<MultiSeasonBuyInResult> {
  const startedAt = Date.now();
  const region: RegionKey = args.state.toLowerCase().match(/^(florida|fl)$/) ? "florida" : "hawaii";

  const setPhase = (phase: RefreshProgressState["phase"], percent: number, label: string) =>
    setRefreshProgress({ propertyId: args.propertyId, startedAt, phase, percent, label });

  // Start the daemon-heartbeat ticker so lastTickAt + daemonOnline
  // refresh every 15s during long sidecar phases. Stopped in finally.
  const stopHeartbeat = startProgressHeartbeat(args.propertyId);
  try {
  setPhase("starting", 0, "Starting multi-season scan");

  // All three seasons get the full multichannel scan (Airbnb engine
  // + sidecar VRBO + Booking). Pre-PR #305 only LOW used the sidecar;
  // operator wanted HIGH and HOLIDAY medians grounded in real
  // VRBO/Booking observations too. Daemon serializes the sidecar
  // calls (single Chrome instance), so total wall ≈ N_BRs × 2 channels
  // × 3 seasons × 90s = 5–18 min for typical 1–2 BR portfolios.
  const lowWindow = pickSeasonWindow(region, "LOW");
  const highWindow = pickSeasonWindow(region, "HIGH");
  const holidayWindow = pickSeasonWindow(region, "HOLIDAY");

  setPhase("airbnb-low", 3, `Scanning Airbnb engine (LOW: ${lowWindow?.checkIn ?? "—"})`);

  const lowPromise = lowWindow
    ? fetchMultiChannelBuyInByBR({ ...args, dateOverride: lowWindow })
    : Promise.resolve(null);
  const highPromise = highWindow
    ? fetchMultiChannelBuyInByBR({ ...args, dateOverride: highWindow })
    : Promise.resolve(null);
  const holidayPromise = holidayWindow
    ? fetchMultiChannelBuyInByBR({ ...args, dateOverride: holidayWindow })
    : Promise.resolve(null);

  // Progress phases as each season's full result resolves. Airbnb
  // engine pulls usually finish in ~5–10s while the sidecar is still
  // queued, so these `airbnb-*` markers fire early; the `sidecar-*`
  // markers represent the season fully done. Percentages tier the
  // sidecar work since it dominates wall time.
  //
  // Order isn't deterministic — daemon dequeues in FIFO order so
  // whichever season was enqueued first finishes first. The percent
  // we set is a floor, not a step counter (later phases can only
  // raise the percent, never lower it) so a Promise resolving in a
  // surprise order doesn't make the bar jump backward.
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
  // Helper: when a season's per-BR result lands, re-label its
  // placeholder warnings with the real season key and merge into
  // the accumulator. setPhaseAtLeast then surfaces them on the next
  // progress write.
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
  void lowPromise.then((r) => {
    ingestSeasonWarnings("LOW", r);
    setPhaseAtLeast("sidecar-low", 35, "LOW season multichannel scan done");
  });
  void highPromise.then((r) => {
    ingestSeasonWarnings("HIGH", r);
    setPhaseAtLeast("sidecar-high", 65, "HIGH season multichannel scan done");
  });
  void holidayPromise.then((r) => {
    ingestSeasonWarnings("HOLIDAY", r);
    setPhaseAtLeast("sidecar-holiday", 90, "HOLIDAY season multichannel scan done");
  });

  // Outer deadline: 15 min hard cap. Sidecar daemon could in theory
  // wedge on a single op (Chrome crashes, network blip, etc.); the
  // per-op walletBudgetMs covers individual ops but the sum across
  // 6–18 ops can pile up. If we exceed 15 min, abort the wait —
  // partial perSeason results (whichever Promises resolved) get
  // returned so the caller can salvage what completed.
  const DEADLINE_MS = 15 * 60_000;
  const waitWithDeadline = <T>(p: Promise<T>): Promise<T | null> =>
    Promise.race([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DEADLINE_MS)),
    ]);

  const [low, high, holiday] = await Promise.all([
    waitWithDeadline(lowPromise),
    waitWithDeadline(highPromise),
    waitWithDeadline(holidayPromise),
  ]);
  const hitDeadline = (low === null && lowWindow !== null) ||
    (high === null && highWindow !== null) ||
    (holiday === null && holidayWindow !== null);
  if (hitDeadline) {
    console.warn(`[multichannel-buy-in] hit 15-min deadline, returning partial seasons`);
  }

  setPhaseAtLeast("persisting", 95, "Persisting medians");

  return {
    perSeason: { LOW: low, HIGH: high, HOLIDAY: holiday },
    region,
    durationMs: Date.now() - startedAt,
  };
  } finally {
    stopHeartbeat();
  }
}
