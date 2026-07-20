// Pure helpers for the PM "Compose arrival-details request" email
// (BuyInVendorEmailPanel, bookings.tsx).
//
// Operator, 2026-07-20: the composed request said the guest booked OUR Guesty
// listing's name ("Menehune Shores - 4BR Condos - Sleeps 12") — meaningless to
// the property manager, who knows the unit by THEIR listing's title ("Menehune
// Shores #623 - Top-Floor Penthouse with Stunning Ocean Views"). The booked
// listing's title lives in two places, in preference order:
//   1. the buy-in's notes (Cowork/combo attach templates embed the title);
//   2. the VRBO confirmation email already sitting in the unit's alias thread
//      ("Hosted by <title>'s rental company", and the bare title line above
//      "Vrbo reservation ID:").
// The booked listing URL is always included when known — the one identifier
// the PM can never mis-read. Keep this module free of Node/DB/React imports.

/**
 * The booked listing's title from the buy-in notes. Mirrors the confident
 * branches of routes.ts titleFromBuyInNoteText (combo / Cowork / auto-fill
 * templates) but returns "" instead of a boilerplate lead — a wrong title in a
 * PM email is worse than none.
 */
export function bookedListingTitleFromNotes(notes: string | null | undefined): string {
  const raw = String(notes ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const combo = raw.match(/Manually attached from combo\b[^—–-]*[—–-][^—–-]*[—–-]\s*([^·]+)/i);
  if (combo?.[1]?.trim()) return combo[1].trim();
  const cowork = raw.match(/Found via Cowork web search\s*[—–][^—–]*[—–]\s*([^·]+)/i);
  if (cowork?.[1]?.trim()) return cowork[1].trim().replace(/\.$/, "");
  const m =
    raw.match(/(?:Auto-filled from|Bought via)\s+[^—–-]+[—–-]\s*([^·]+)/i);
  if (m?.[1]?.trim()) return m[1].trim();
  return "";
}

const GENERIC_TITLE_RE = /^(your reservation|reservation confirm|booking confirm|thank you|welcome|payment|receipt|manage your trip|share with friends|get directions|check-?in|check-?out|guests?|here to help|message the host|send message|view )/i;

function plausibleListingTitle(candidate: string): string {
  const t = candidate.trim().replace(/\s+/g, " ");
  if (t.length < 8 || t.length > 160) return "";
  if (!/[a-z]/i.test(t)) return "";
  if (GENERIC_TITLE_RE.test(t)) return "";
  return t;
}

/**
 * The booked listing's title from a confirmation-email text. Two shapes VRBO
 * actually sends: "Hosted by <title>'s rental company" (suffix stripped) and
 * the standalone title line directly above "Vrbo reservation ID:".
 */
export function bookedListingTitleFromEmailText(text: string): string {
  const t = String(text ?? "");
  if (!t.trim()) return "";

  const hosted = t.match(/Hosted by\s+(.{4,180}?)(?:['’]s rental company)?\s*(?:\n|$)/i);
  if (hosted?.[1]) {
    const cleaned = plausibleListingTitle(hosted[1].replace(/['’]s rental company.*$/i, ""));
    if (cleaned) return cleaned;
  }

  const lines = t.split(/\r?\n/).map((l) => l.trim());
  const idIdx = lines.findIndex((l) => /^vrbo reservation id\b/i.test(l));
  if (idIdx > 0) {
    for (let i = idIdx - 1; i >= 0 && i >= idIdx - 4; i--) {
      const candidate = plausibleListingTitle(lines[i] ?? "");
      if (candidate) return candidate;
    }
  }
  return "";
}

/** First confident title across notes then the alias-thread email texts. */
export function resolveBookedListingTitle(input: {
  notes?: string | null;
  emailTexts?: Array<string | null | undefined>;
}): string {
  const fromNotes = bookedListingTitleFromNotes(input.notes);
  if (fromNotes) return fromNotes;
  for (const text of input.emailTexts ?? []) {
    const title = bookedListingTitleFromEmailText(String(text ?? ""));
    if (title) return title;
  }
  return "";
}

export type ArrivalRequestEmailInput = {
  /** The BOOKED listing's title (the PM's own listing name), when known. */
  listingTitle?: string | null;
  /** The booked listing URL — always included when present. */
  listingUrl?: string | null;
  guestName?: string | null;
  /** Preformatted stay dates (the caller owns date formatting). */
  checkInText?: string | null;
  checkOutText?: string | null;
  /** Fallback identity when no booked-listing title/URL is known. */
  fallbackPropertyName?: string | null;
  unitLabel?: string | null;
};

/**
 * Default subject + body for the PM arrival-details request. Identifies the
 * unit by the PM's OWN listing (title and/or URL); only with neither does it
 * fall back to the operator's internal property name.
 */
export function buildArrivalRequestEmail(input: ArrivalRequestEmailInput): { subject: string; body: string } {
  const title = String(input.listingTitle ?? "").trim();
  const url = String(input.listingUrl ?? "").trim();
  const guest = String(input.guestName ?? "").trim();
  const fallback = [String(input.fallbackPropertyName ?? "").trim(), String(input.unitLabel ?? "").trim()]
    .filter(Boolean)
    .join(" - ");

  const listingPhrase = title && url
    ? `your listing "${title}" (${url})`
    : title
      ? `your listing "${title}"`
      : url
        ? `your listing ${url}`
        : fallback || "your listing";

  const subject = `Arrival details request - ${title || fallback || "upcoming stay"}`;

  const stay = input.checkInText && input.checkOutText
    ? ` from ${input.checkInText} to ${input.checkOutText}`
    : "";

  const body = [
    `Hi,`,
    ``,
    `We booked ${listingPhrase} for ${guest || "our guest"}${stay}.`,
    `Can you please send the arrival details, property address, access code, Wi-Fi, parking instructions, and any check-in notes when available?`,
    ``,
    `Thank you,`,
    `${guest || "Reservations"}`,
  ].join("\n");

  return { subject, body };
}
