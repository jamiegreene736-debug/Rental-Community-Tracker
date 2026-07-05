// Pure parsing + formatting of a reservation's guest party (how many people
// booked — adults / children / infants / pets) from Guesty's reservation
// shapes. Channel coverage varies: Airbnb + VRBO reliably send the
// adults/children breakdown, Booking.com sometimes sends only the total, and
// manual/direct rows usually have nothing — so every field is nullable and
// the formatter degrades gracefully ("4 guests (2 adults, 2 children)" →
// "4 guests" → null).
//
// Guesty quirk (load-bearing): `numberOfGuests` is EITHER a plain number
// (legacy shape — inbox.tsx has treated it as a guestsCount fallback since
// 2026) OR the breakdown object
// { numberOfAdults, numberOfChildren, numberOfInfants, numberOfPets }.
// Both shapes appear on live reservations; parse both.

export interface GuestParty {
  /** Total guests the guest entered at booking (adults + children; infants/pets usually excluded by the channels). */
  total: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  pets: number | null;
}

const countOf = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

const firstPositive = (...vals: Array<number | null>): number | null => {
  for (const v of vals) if (v !== null && v > 0) return v;
  return null;
};

/**
 * Extract the guest party from a Guesty reservation (or any object carrying
 * the same fields). Returns null when the reservation carries no usable
 * count at all — absence of data is NOT a party of zero.
 */
export function guestPartyFromReservation(reservation: unknown): GuestParty | null {
  const r = (reservation ?? {}) as Record<string, unknown>;
  const nog = r.numberOfGuests as Record<string, unknown> | number | null | undefined;
  const breakdown = nog && typeof nog === "object" ? nog : null;

  const adults = countOf(breakdown?.numberOfAdults);
  const children = countOf(breakdown?.numberOfChildren);
  const infants = countOf(breakdown?.numberOfInfants);
  const pets = countOf(breakdown?.numberOfPets);

  const breakdownTotal =
    adults !== null || children !== null
      ? (adults ?? 0) + (children ?? 0)
      : null;

  const total =
    firstPositive(
      countOf(r.guestsCount),
      typeof nog === "number" ? countOf(nog) : null,
      breakdownTotal,
    ) ?? null;

  const anySignal =
    (total !== null && total > 0) ||
    [adults, children, infants, pets].some((v) => v !== null && v > 0);
  if (!anySignal) return null;

  return { total, adults, children, infants, pets };
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * "4 guests (2 adults, 2 children)" — breakdown parens only when they add
 * information beyond the total (children/infants/pets present, or the adult
 * count differs from the total). "4 guests" when only the total is known.
 */
export function formatGuestParty(party: GuestParty | null | undefined): string | null {
  if (!party) return null;
  const total = party.total ?? (party.adults !== null || party.children !== null
    ? (party.adults ?? 0) + (party.children ?? 0)
    : null);
  const parts: string[] = [];
  if (party.adults !== null && party.adults > 0) parts.push(plural(party.adults, "adult", "adults"));
  if (party.children !== null && party.children > 0) parts.push(plural(party.children, "child", "children"));
  if (party.infants !== null && party.infants > 0) parts.push(plural(party.infants, "infant", "infants"));
  if (party.pets !== null && party.pets > 0) parts.push(plural(party.pets, "pet", "pets"));

  if (total === null || total <= 0) {
    return parts.length > 0 ? parts.join(", ") : null;
  }
  const totalLabel = plural(total, "guest", "guests");
  // Parens are noise when they'd just repeat the total ("2 guests (2 adults)").
  const informative =
    parts.length > 1 ||
    (parts.length === 1 && party.adults !== total);
  return informative ? `${totalLabel} (${parts.join(", ")})` : totalLabel;
}

/** Convenience: reservation → formatted label in one call. */
export function guestPartyLabelFromReservation(reservation: unknown): string | null {
  return formatGuestParty(guestPartyFromReservation(reservation));
}
