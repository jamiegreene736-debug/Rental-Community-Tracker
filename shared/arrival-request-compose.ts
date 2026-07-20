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

import { stripLinkMarkers } from "./email-mime";

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
  // "[link: …]" markers (preserved hyperlinks, shared/email-mime.ts) would
  // ride along on the title/hosted-by lines and fail plausibleListingTitle.
  const t = stripLinkMarkers(String(text ?? ""));
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

/**
 * "on VRBO" / "on Booking.com" / "on Airbnb" channel mention derived from the
 * booked listing URL — the operator's preferred identifier over pasting the
 * raw URL into the PM email (2026-07-20 template edit). PM/direct sites → "".
 */
export function channelLabelFromListingUrl(url: string | null | undefined): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  const host = raw.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0]!.toLowerCase();
  if (/(^|\.)((vrbo|homeaway|abritel|fewo-direkt|stayz|bookabach)\.[a-z.]+)$/.test(host)) return "VRBO";
  if (/(^|\.)booking\.com$/.test(host)) return "Booking.com";
  if (/(^|\.)airbnb\.[a-z.]+$/.test(host)) return "Airbnb";
  return "";
}

export type ArrivalRequestEmailInput = {
  /** The BOOKED listing's title (the PM's own listing name), when known. */
  listingTitle?: string | null;
  /** The booked listing URL — used for the channel mention (and as the
   * identifier of last resort when no title is known). */
  listingUrl?: string | null;
  /** Signs the email (operator rule: the PM ties the request to the booking). */
  guestName?: string | null;
  /** Preformatted stay dates (the caller owns date formatting). */
  checkInText?: string | null;
  checkOutText?: string | null;
  /** Mention that the booking is settled ("Everything should be paid in
   * full.") — pass true for booked units (operator template, 2026-07-20). */
  paidInFull?: boolean;
  /** Fallback identity when no booked-listing title/URL is known. */
  fallbackPropertyName?: string | null;
  unitLabel?: string | null;
};

/**
 * Default subject + body for the PM arrival-details request, matching the
 * operator's hand-edited template (2026-07-20): identify the unit by the PM's
 * OWN listing title + the CHANNEL name ("on VRBO") — never the raw URL when a
 * title is known, no "for <guest>" clause — and state the booking is paid in
 * full for booked units. The raw URL survives only as the identifier of last
 * resort (no title), and the internal property name only with neither.
 */
export function buildArrivalRequestEmail(input: ArrivalRequestEmailInput): { subject: string; body: string } {
  const title = String(input.listingTitle ?? "").trim();
  const url = String(input.listingUrl ?? "").trim();
  const guest = String(input.guestName ?? "").trim();
  const channel = channelLabelFromListingUrl(url);
  const fallback = [String(input.fallbackPropertyName ?? "").trim(), String(input.unitLabel ?? "").trim()]
    .filter(Boolean)
    .join(" - ");

  const listingPhrase = title
    ? `your listing "${title}"`
    : url
      ? `your listing ${url}`
      : fallback || "your listing";

  const subject = `Arrival details request - ${title || fallback || "upcoming stay"}`;

  const stay = input.checkInText && input.checkOutText
    ? ` from ${input.checkInText} to ${input.checkOutText}`
    : "";

  const bookedSentence = `We booked ${listingPhrase}${channel && title ? ` on ${channel}` : ""}${stay}.`
    + (input.paidInFull ? " Everything should be paid in full." : "");

  const body = [
    `Hi,`,
    ``,
    bookedSentence,
    `Can you please send the arrival details, property address, access code, Wi-Fi, parking instructions, and any check-in notes when available?`,
    ``,
    `Thank you,`,
    `${guest || "Reservations"}`,
  ].join("\n");

  return { subject, body };
}
