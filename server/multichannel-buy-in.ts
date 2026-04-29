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
}): Promise<MultiChannelBuyInResult> {
  const startedAt = Date.now();

  // 7-night, 30-day-out window — matches fetchAmortizedNightlyByBR's
  // window so the snapshot rates are directly comparable to the
  // Airbnb-engine basis. (If we sampled a different window, the
  // operator couldn't tell whether a $580 VRBO quote was a
  // genuine deal or just a different season.)
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const checkInDate = new Date(now);
  checkInDate.setUTCDate(checkInDate.getUTCDate() + 30);
  const checkOutDate = new Date(checkInDate);
  checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 7);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const checkIn = ymd(checkInDate);
  const checkOut = ymd(checkOutDate);

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
  );

  type SidecarOp = {
    br: number;
    channel: ChannelKey;
    cheapestNightly: number | null;
    workerOnline: boolean;
  };
  const sidecarOps: Promise<SidecarOp>[] = [];
  for (const br of args.bedroomCounts) {
    sidecarOps.push(
      (async (): Promise<SidecarOp> => {
        try {
          const { searchVrboViaSidecar } = await import("./vrbo-sidecar-queue");
          const r = await searchVrboViaSidecar({
            destination: targetDest,
            checkIn,
            checkOut,
            bedrooms: br,
            walletBudgetMs: 60_000,
          });
          if (!r) return { br, channel: "vrbo", cheapestNightly: null, workerOnline: false };
          // Filter to listings that actually quote a per-night and
          // (when bedroom count is known) match the requested BR.
          // Sidecar VRBO scrape returns nightlyPrice already
          // amortized from the multi-night total.
          let cheapest = Infinity;
          for (const c of r.candidates) {
            if (!(c.nightlyPrice > 0)) continue;
            if (c.bedrooms != null && c.bedrooms !== br) continue;
            if (c.nightlyPrice < cheapest) cheapest = c.nightlyPrice;
          }
          return {
            br,
            channel: "vrbo",
            cheapestNightly: Number.isFinite(cheapest) ? Math.round(cheapest) : null,
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
            walletBudgetMs: 60_000,
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

  const daemonOnline = sidecarResults.some((r) => r.workerOnline);

  // Build the channel cheapest map. Airbnb cheapest = min of the
  // engine samples for that BR (samples are already filtered by
  // bbox + bedroom).
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
    channelCheapestByBR[br] = {
      airbnb: airbnbCheapest,
      vrbo: vrboSidecar?.cheapestNightly ?? null,
      booking: bookingSidecar?.cheapestNightly ?? null,
    };
  }

  return {
    ratesByBR: airbnbResult.ratesByBR,
    channelCheapestByBR,
    snapshotCheckIn: checkIn,
    snapshotCheckOut: checkOut,
    daemonOnline,
    durationMs: Date.now() - startedAt,
  };
}
