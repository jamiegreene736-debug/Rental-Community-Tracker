// Cross-market resort de-duplication for the Top Markets sweep display.
//
// WHY: adjacent towns (e.g. Paia / Spreckelsville / Kahului on Maui, or
// Koloa / Poipu on Kauai) have OVERLAPPING search regions, so the same physical
// resort surfaces under more than one scanned city. The server stamps each
// researched community's `city` with the SEARCH city (not the resort's true
// city), so "Sugar Cove under Paia" and "Sugar Cove under Spreckelsville" are the
// SAME resort with two different city labels.
//
// The operator wants each resort to appear ONCE in the sweep breakdown. This
// module decides, deterministically, which market "owns" (renders) each resort:
// the FIRST market in scan order that surfaced it. Every later market that also
// found the resort lists it as "moved" (shown under the owner's city) instead of
// re-rendering a second, selectable checkbox.
//
// LOAD-BEARING: the owner key must match the collapse rule used by the sweep
// SELECTION memo (`sweepSelectedCommunities`, also first-market-order by
// name|state) so that what the operator SEES is exactly what gets QUEUED. Keep
// `resortDedupKey` identical to the component's selection dedup key.

export type SweepResortLike = {
  name?: string | null;
  state?: string | null;
};

export type SweepMarketLike = {
  city?: string | null;
  state?: string | null;
  communities?: SweepResortLike[] | null;
};

/**
 * Normalized de-dup key for a resort: lowercased, whitespace-collapsed name +
 * lowercased state. MUST stay identical to the selection dedup key in
 * add-community.tsx so the display and the queue agree on what's a duplicate.
 */
export function resortDedupKey(c: SweepResortLike): string {
  const name = String(c?.name || "").trim().toLowerCase().replace(/\s+/g, " ");
  const state = String(c?.state || "").trim().toLowerCase();
  return `${name}|${state}`;
}

export type MovedResort = {
  /** community index within its own market (unchanged) */
  communityIndex: number;
  /** display name of the resort */
  name: string;
  /** the city under which this resort IS shown (its owning market) */
  shownUnderCity: string;
};

export type SweepResortOwnership = {
  /** dedup key -> owning "marketIndex:communityIndex" */
  ownerByKey: Map<string, string>;
  /** market index -> set of community indices this market OWNS (renders) */
  ownedIndicesByMarket: Map<number, Set<number>>;
  /** market index -> resorts found here but shown under an EARLIER market */
  movedByMarket: Map<number, MovedResort[]>;
};

/**
 * Compute per-market resort ownership across the whole sweep.
 *
 * Ownership is assigned by market order (index), then community order: the first
 * time a resort's key is seen, that market owns it; any later occurrence (in the
 * same or a later market) is "moved" and points at the owner's city.
 *
 * De-dup is by `resortDedupKey` (name|state) — IDENTICAL to the component's
 * selection/queue collapse (`sweepSelectedCommunities`). This uniformity is
 * load-bearing: if the ownership rule and the queue rule disagreed for any input
 * (e.g. a name-less row), the display would render a checkbox that the queue then
 * silently drops. Name-less rows collapse by their `"|state"` key just like the
 * queue does — they are non-buildable and indistinguishable anyway, so showing
 * one is what the operator actually gets.
 */
export function computeSweepResortOwnership(
  markets: readonly SweepMarketLike[] | null | undefined,
): SweepResortOwnership {
  const ownerByKey = new Map<string, string>();
  const ownerCityByKey = new Map<string, string>();
  const ownedIndicesByMarket = new Map<number, Set<number>>();
  const movedByMarket = new Map<number, MovedResort[]>();

  (markets ?? []).forEach((m, mi) => {
    const owned = new Set<number>();
    const moved: MovedResort[] = [];
    const ownerCity = String(m?.city || "").trim();
    (m?.communities ?? []).forEach((c, ci) => {
      const key = resortDedupKey(c);
      if (!ownerByKey.has(key)) {
        // First market to surface this resort owns/renders it.
        ownerByKey.set(key, `${mi}:${ci}`);
        ownerCityByKey.set(key, ownerCity);
        owned.add(ci);
      } else {
        // Already surfaced by an earlier market — list it as "also found here".
        moved.push({
          communityIndex: ci,
          name: String(c?.name || ""),
          shownUnderCity: ownerCityByKey.get(key) || "",
        });
      }
    });
    ownedIndicesByMarket.set(mi, owned);
    movedByMarket.set(mi, moved);
  });

  return { ownerByKey, ownedIndicesByMarket, movedByMarket };
}

/** True when this market owns (should render) the community at `communityIndex`. */
export function marketOwnsResort(
  ownership: SweepResortOwnership,
  marketIndex: number,
  communityIndex: number,
): boolean {
  return ownership.ownedIndicesByMarket.get(marketIndex)?.has(communityIndex) === true;
}
