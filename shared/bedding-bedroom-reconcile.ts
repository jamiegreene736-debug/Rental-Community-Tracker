// ─────────────────────────────────────────────────────────────────────────────
// Bedding-tab bedroom-count reconciliation — pure logic (browser-safe).
//
// WHY THIS EXISTS (root-caused 2026-07-18, Cliffs at Princeville draft 20):
// the Bedding tab's config lives in this browser's localStorage
// (`nexstay_bedding_<propertyId>`), while a unit's TRUE bedroom count lives in
// the community_drafts row (resolveDraftUnitBedrooms) or unit-builder-data.
// `loadBeddingConfig` merges stored-over-default by unitId, and `normalizeUnit`
// used to take the stored `bedrooms` array WHOLESALE. So when draft 20's
// unit1Bedrooms was corrected 3 → 2, the tab kept its third bedroom slot
// forever: the header read 7 BR (3+4) instead of 6, `headlineSleeps` inflated
// `accommodates` to 18 instead of 16, and — because `totalBedrooms(config)` is
// literally what the Guesty push sends — the LIVE listing was written as a 7BR
// under a "Stunning 6BR for 16" title.
//
// The bedroom COUNT is a listing-level fact owned upstream (it drives the
// title, pricing, descriptions, and the audit's layout stage). The Bedding tab
// owns what is IN each bedroom, not how many there are — the photo scan makes
// the same split deliberately ("bedroom/bathroom COUNTS never change", see
// shared/bedding-photo-scan.ts). Reconciling here is what keeps the tab from
// out-voting the record it is supposed to describe.
//
// HONESTY RULES (both test-locked):
//   • an EMPTY authoritative list is treated as "unknown", never as "zero
//     bedrooms" — absence of a default must not empty a real config (and must
//     not let the push send `bedrooms: undefined` + empty listingRooms);
//   • a reconciliation is REPORTED, never silent. Dropping a slot may be
//     discarding an operator's hand-added bedroom, so the tab surfaces it.
//
// Structural types (not an import of client/src/data/bedding-config.ts) —
// the shared layer must not import client modules. Same convention as
// MergeUnitShape in shared/bedding-photo-scan.ts; TS structural typing lets
// the tab pass its UnitBeddingConfig straight in and get it back.
// ─────────────────────────────────────────────────────────────────────────────

export type ReconcileBedroomSlot = {
  roomNumber: number;
  label: string;
  beds: Array<{ type: string; quantity: number }>;
  hasEnsuite: boolean;
  ensuiteFeatures: string[];
};

export type BedroomSlotReconciliation<T extends ReconcileBedroomSlot> = {
  /** The reconciled slot list — exactly `authoritative.length` long when known. */
  bedrooms: T[];
  /** Slots removed because the stored config claimed more bedrooms than the record. */
  dropped: number;
  /** Slots appended from the defaults because the record grew. */
  added: number;
  changed: boolean;
};

/**
 * Reconcile one unit's stored bedroom slots against the authoritative
 * (freshly-derived) default slots.
 *
 * Operator edits on the surviving slots are preserved verbatim — only the
 * LENGTH is corrected. Excess slots are dropped from the END (deterministic,
 * and it mirrors how `buildDefaultUnitBedding` pads and how the tab's
 * `removeBedroom` renumbers); a short list is topped up from the defaults.
 * `roomNumber` is renumbered 1..N because `buildGuestyListingRooms` and the
 * tab's per-bedroom mutators key on it.
 */
export function reconcileUnitBedroomSlots<T extends ReconcileBedroomSlot>(
  stored: T[],
  authoritative: T[],
): BedroomSlotReconciliation<T> {
  const storedSlots = Array.isArray(stored) ? stored : [];
  const target = Array.isArray(authoritative) ? authoritative.length : 0;

  // Unknown authoritative count → leave the stored config exactly as-is.
  // Never read an absent default as "this unit has zero bedrooms".
  if (target === 0) {
    return { bedrooms: storedSlots, dropped: 0, added: 0, changed: false };
  }
  if (storedSlots.length === target) {
    return { bedrooms: storedSlots, dropped: 0, added: 0, changed: false };
  }

  const dropped = Math.max(0, storedSlots.length - target);
  const added = Math.max(0, target - storedSlots.length);
  const kept = storedSlots.slice(0, target);
  const padding = authoritative.slice(storedSlots.length, target);
  const bedrooms = [...kept, ...padding].map((slot, index) => ({
    ...slot,
    roomNumber: index + 1,
  }));

  return { bedrooms, dropped, added, changed: true };
}

/** Operator-facing one-liner for a reconciled unit. Null when nothing changed. */
export function describeBedroomReconciliation(
  unitLabel: string,
  result: Pick<BedroomSlotReconciliation<ReconcileBedroomSlot>, "dropped" | "added">,
): string | null {
  if (result.dropped > 0) {
    return `Unit ${unitLabel}: removed ${result.dropped} bedroom${result.dropped === 1 ? "" : "s"} `
      + `that this listing's records no longer claim.`;
  }
  if (result.added > 0) {
    return `Unit ${unitLabel}: added ${result.added} bedroom${result.added === 1 ? "" : "s"} `
      + `to match this listing's records.`;
  }
  return null;
}

/**
 * Push guard. The Guesty `bedrooms` field must never contradict the
 * authoritative per-unit counts — a listing written as 7BR under a "6BR"
 * title desyncs the title, pricing, descriptions, and the audit layout stage
 * all at once. Returns an operator-facing reason to BLOCK, or null to allow.
 *
 * `authoritativeBedrooms` of 0 means "unknown" (defaults not registered yet,
 * e.g. a draft whose row has not loaded) and never blocks — same honesty rule
 * as the reconciler above.
 */
export function blockedBeddingPushReason(
  configBedrooms: number,
  authoritativeBedrooms: number,
): string | null {
  if (!Number.isFinite(configBedrooms) || !Number.isFinite(authoritativeBedrooms)) return null;
  if (authoritativeBedrooms <= 0) return null;
  if (configBedrooms === authoritativeBedrooms) return null;
  return `Bedding shows ${configBedrooms} bedroom${configBedrooms === 1 ? "" : "s"} but this listing's `
    + `records say ${authoritativeBedrooms}. Pushing would put the wrong bedroom count on the live `
    + `listing, so nothing was sent. Reload the tab to re-sync, or correct the unit's bedroom count `
    + `first if ${configBedrooms} is right.`;
}
