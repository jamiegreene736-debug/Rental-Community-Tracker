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

export type ChannelKey = "airbnb" | "vrbo" | "booking";
export type RegionKey = "hawaii" | "florida";

// Tax/fee normalization to bring sidecar VRBO + Booking rates onto
// the same all-in basis as the Airbnb engine.
//
// Airbnb engine returns `extracted_total_price` which already
// includes Airbnb's guest service fee + state/county taxes — so
// dividing by 7 nights gives a true all-in nightly.
//
// VRBO sidecar scrapes `$X for Y nights` from the search-card
// label, which is the listing total + Vrbo service fee BUT
// EXCLUDES state/local taxes (those land at checkout). Booking.com
// is the same shape.
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

function inferRegion(city: string, state: string): RegionKey {
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

export type MultiChannelBuyInResult = {
  // Per-bedroom rate samples — same shape as
  // fetchAmortizedNightlyByBR's `ratesByBR` so the persisted-median
  // computation in the existing refresh endpoint stays unchanged.
  // Sourced from the Airbnb engine ONLY (the cost basis that
  // calibrates the sell-price floor; mixing in sidecar singletons
  // would skew the median toward outliers).
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
    }
  >;
  // Window the snapshot was taken on, so the UI can label "Live
  // 2026-05-29 → 06-05: Airbnb $620 · VRBO $580 · Booking $605".
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
  // PR #282: optional flag to skip sidecar (used for HIGH/HOLIDAY
  // seasons where we only sample via the Airbnb engine — the sidecar
  // budget is reserved for the LOW-season scan where the operator
  // is actively hunting buy-in deals).
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
    // PR #299: when daemon used Vrbo's new "$X total includes taxes &
    // fees" format, cheapestNightly is already all-in. Skip the
    // per-region tax-normalization multiplier downstream.
    cheapestIncludesTaxes?: boolean;
    workerOnline: boolean;
  };
  const sidecarOps: Promise<SidecarOp>[] = [];
  // PR #282: when caller asked us to skip sidecar (HIGH/HOLIDAY
  // seasons), we still build the channel map but the VRBO + Booking
  // entries stay null. The basis ends up Airbnb-only for those
  // seasons — same coverage as the legacy refresh path for those
  // months, just with the per-season window pulled directly.
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
          if (!r) return { br, channel: "vrbo", cheapestNightly: null, workerOnline: false };
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
          let cheapestIncludesTaxes = false;
          for (const c of r.candidates) {
            if (!(c.nightlyPrice > 0)) continue;
            if (c.bedrooms != null && c.bedrooms !== br) continue;
            if (c.nightlyPrice < cheapest) {
              cheapest = c.nightlyPrice;
              cheapestIncludesTaxes = c.priceIncludesTaxes ?? false;
            }
          }
          return {
            br,
            channel: "vrbo",
            cheapestNightly: Number.isFinite(cheapest) ? Math.round(cheapest) : null,
            cheapestIncludesTaxes,
            workerOnline: r.workerOnline,
          };
        } catch {
          return { br, channel: "vrbo", cheapestNightly: null, workerOnline: false };
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
          // from the requested 7-night window.
          let cheapest = Infinity;
          for (const c of r.candidates) {
            if (!(c.totalPrice > 0)) continue;
            if (c.bedrooms != null && c.bedrooms !== br) continue;
            const nightly = Math.round(c.totalPrice / 7);
            if (nightly < cheapest) cheapest = nightly;
          }
          return {
            br,
            channel: "booking",
            cheapestNightly: Number.isFinite(cheapest) ? cheapest : null,
            workerOnline: r.workerOnline,
          };
        } catch {
          return { br, channel: "booking", cheapestNightly: null, workerOnline: false };
        }
      })(),
    );
  }

  const [airbnbResult, ...sidecarResults] = await Promise.all([
    airbnbPromise,
    ...sidecarOps,
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

  const daemonOnline = sidecarResults.some((r) => r.workerOnline);
  const region = inferRegion(args.city, args.state);

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
  }

  return {
    ratesByBR: airbnbResult.ratesByBR,
    channelCheapestByBR,
    snapshotCheckIn: checkIn,
    snapshotCheckOut: checkOut,
    daemonOnline,
    region,
    taxFactor: TAX_NORMALIZATION_FACTOR[region],
    durationMs: Date.now() - startedAt,
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
// Optimization: only the LOW window pulls sidecar VRBO + Booking.
// HIGH and HOLIDAY use the Airbnb engine alone (parallel-fetched
// in ~5s, no daemon serialization). The reason: the sidecar's
// value-add is for the LOW-season basis where the operator is
// actively hunting cheap inventory; HIGH/HOLIDAY rates are largely
// market-driven and the Airbnb engine median is a reasonable proxy.
// Trading 2× sidecar budget for the per-season precision wouldn't
// move the needle enough to justify 6-12min refresh wall times.
//
// Total wall time: ~30-90s per property (Airbnb engine 3 calls in
// parallel + LOW sidecar). Same as a single multi-channel scan.

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
export type RefreshProgressState = {
  propertyId: number;
  startedAt: number;
  phase: "starting" | "airbnb-low" | "airbnb-high" | "airbnb-holiday" | "sidecar-low" | "persisting" | "done" | "error";
  percent: number;
  label: string;
  error?: string;
};
const _refreshProgress = new Map<number, RefreshProgressState>();
export function setRefreshProgress(state: RefreshProgressState): void {
  _refreshProgress.set(state.propertyId, state);
}
export function getRefreshProgress(propertyId: number): RefreshProgressState | null {
  return _refreshProgress.get(propertyId) ?? null;
}
export function clearRefreshProgress(propertyId: number): void {
  // Keep "done" or "error" terminal states for 30s so the Pricing tab
  // sees the final result before the cleanup race.
  setTimeout(() => _refreshProgress.delete(propertyId), 30_000);
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

  setPhase("starting", 0, "Starting multi-season scan");

  // LOW window — full multichannel (engine + sidecar VRBO + Booking).
  // HIGH and HOLIDAY — Airbnb engine only (skipSidecar=true).
  const lowWindow = pickSeasonWindow(region, "LOW");
  const highWindow = pickSeasonWindow(region, "HIGH");
  const holidayWindow = pickSeasonWindow(region, "HOLIDAY");

  setPhase("airbnb-low", 5, `Scanning Airbnb engine (LOW: ${lowWindow?.checkIn ?? "—"})`);

  const lowPromise = lowWindow
    ? fetchMultiChannelBuyInByBR({ ...args, dateOverride: lowWindow })
    : Promise.resolve(null);
  const highPromise = highWindow
    ? fetchMultiChannelBuyInByBR({ ...args, dateOverride: highWindow, skipSidecar: true })
    : Promise.resolve(null);
  const holidayPromise = holidayWindow
    ? fetchMultiChannelBuyInByBR({ ...args, dateOverride: holidayWindow, skipSidecar: true })
    : Promise.resolve(null);

  // Update progress as each season finishes.
  void highPromise.then(() => setPhase("airbnb-high", 30, "HIGH season Airbnb pull done"));
  void holidayPromise.then(() => setPhase("airbnb-holiday", 50, "HOLIDAY season Airbnb pull done"));
  void lowPromise.then(() => setPhase("sidecar-low", 90, "LOW season multichannel done"));

  const [low, high, holiday] = await Promise.all([lowPromise, highPromise, holidayPromise]);

  setPhase("persisting", 95, "Persisting medians");

  return {
    perSeason: { LOW: low, HIGH: high, HOLIDAY: holiday },
    region,
    durationMs: Date.now() - startedAt,
  };
}
