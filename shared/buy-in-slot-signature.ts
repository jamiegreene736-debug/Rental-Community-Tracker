// Buy-in slot fingerprints — pure, browser-safe.
//
// WHY THIS EXISTS: Cowork attaches buy-ins OUT OF BAND. It runs in Claude
// Desktop and calls the portal's own API, so the operator's open bookings tab
// gets no job id, no server handle, and no poller telling it a slot just got
// filled. The row keeps rendering its stale `slots[].buyIn` and the
// "Prepare checkout in Cowork" button (which requires an attached, unbooked
// buy-in) simply isn't there when the operator switches back.
//
// The bookings queries DO poll (120s), but `refetchIntervalInBackground`
// defaults false, so hidden ticks are skipped — a returning operator can face
// a button-less row for up to two minutes.
//
// LOAD-BEARING: the fix must NOT be "refetch the bookings query on focus".
// `slots[].buyIn` comes from our own `buy_ins` table; the Guesty reservation
// document is completely unchanged by a Cowork attach. Refetching
// /api/bookings/guesty-all runs an account-wide listing fetch plus a paginated
// /reservations loop through Guesty's global rate gate — the exact traffic
// behind three documented 429/timeout incidents — to learn something one local
// SELECT answers. So: probe a cheap buy_ins-only endpoint, compare THIS
// signature, and invalidate the expensive queries only when it actually moved.

export type BuyInSlotStatusRow = {
  unitId: string;
  buyInId: number | null;
  bookingStatus: string | null;
  listingUrl: string | null;
  /**
   * Accepts a string ON PURPOSE. Postgres `numeric` reaches the client as
   * "1234.00" through the bookings payload but as a JS number through the
   * probe endpoint — comparing them raw would report a change on every single
   * probe. normalizeMoney() is what makes the two sides comparable.
   */
  costPaid: number | string | null;
};

/** Null/undefined and "" must fingerprint identically — the DB returns both. */
function field(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Collapse "1234.00" / 1234 / "1234" to one canonical form so a numeric-string
 * vs number representation difference never reads as a real change. Non-numeric
 * input falls back to the raw string rather than silently becoming "".
 */
function normalizeMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toFixed(2);
}

/**
 * Order-independent fingerprint of everything a bookings row's Cowork buttons
 * READ off its slots.
 *
 * `listingUrl` and `costPaid` are included ON PURPOSE, not for completeness:
 * the "Find property on VRBO" flow re-points BOTH on an existing buy-in (no
 * id change, no status change), and `costPaid` is the input to the checkout
 * prompt's 15% price guard — a stale value mis-arms that guard in either
 * direction, so it has to count as a change.
 */
export function buyInSlotSignature(rows: BuyInSlotStatusRow[]): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return rows
    .map((row) =>
      [
        field(row?.unitId),
        field(row?.buyInId),
        field(row?.bookingStatus),
        field(row?.listingUrl),
        normalizeMoney(row?.costPaid),
      ].join("|"),
    )
    // Sort the RENDERED rows, not the input array: slot order is not stable
    // across the two bookings endpoints and must not read as a change.
    .sort()
    .join(";");
}

export function buyInSlotSignatureMap(
  byReservation: Record<string, BuyInSlotStatusRow[]> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!byReservation || typeof byReservation !== "object") return out;
  for (const [reservationId, rows] of Object.entries(byReservation)) {
    out[reservationId] = buyInSlotSignature(Array.isArray(rows) ? rows : []);
  }
  return out;
}
