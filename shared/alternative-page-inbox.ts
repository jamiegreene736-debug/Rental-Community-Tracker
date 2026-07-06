// Pure helpers for surfacing an existing alternative-unit guest page
// (`/alternatives/:token`) inside the Guest Inbox reservation panel, so the
// operator can copy the URL and paste it into a text/message to the guest.
//
// The heavy lifting (creating + sending the page) already lives in the bookings
// page RelocateGuestDialog; this module only decides WHICH stored page to show
// for a reservation and distills a one-glance unit summary. Kept network- and
// DOM-free so it can be unit-tested and imported from both server and client.

export interface AlternativePageLike {
  token: string;
  messageSentAt?: Date | string | null;
  createdAt?: Date | string | null;
  payload?: unknown;
}

function toMillis(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Sort key for "most recent activity": a page's send time if it was sent,
// otherwise its creation time. Used to pick the freshest page within a pool.
function recencyKey(page: AlternativePageLike): number {
  return Math.max(toMillis(page.messageSentAt), toMillis(page.createdAt));
}

// Choose which alternative page to surface for a reservation in the inbox.
//
// The guest actually received the most recently SENT page, so prefer that — it
// is the canonical "link the guest has". If none was ever sent (the operator
// generated a page but hasn't messaged it yet), fall back to the most recently
// created page so the URL is still available to copy. Returns null when there
// is no page for the reservation.
//
// Input is expected newest-first (as getBookingAlternativePagesByReservation
// returns), but we compute recency defensively so ordering can't matter.
export function selectInboxAlternativePage<T extends AlternativePageLike>(
  pages: T[] | null | undefined,
): T | null {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const sent = pages.filter((p) => !!p && !!p.messageSentAt);
  const pool = sent.length > 0 ? sent : pages;
  let best: T | null = null;
  for (const page of pool) {
    if (!page) continue;
    if (best === null || recencyKey(page) > recencyKey(best)) best = page;
  }
  return best;
}

export interface AlternativePageSummary {
  unitCount: number;
  unitTitles: string[];
}

// Distill the stored render payload into a glance-able unit summary for the
// inbox chip. `payload.alternatives` is the array of attached units (same shape
// the GET /alternatives/:token renderer consumes). Titles can be empty strings
// for units without a usable guest-facing community label, so those are dropped
// from the title list while still counting toward unitCount (the honest number
// of units on the page).
export function summarizeAlternativePagePayload(payload: unknown): AlternativePageSummary {
  const alts = payload && typeof payload === "object" && Array.isArray((payload as any).alternatives)
    ? (payload as any).alternatives as unknown[]
    : [];
  const unitTitles: string[] = [];
  for (const alt of alts) {
    const title = alt && typeof alt === "object" && typeof (alt as any).title === "string"
      ? (alt as any).title.trim()
      : "";
    if (title) unitTitles.push(title);
  }
  return { unitCount: alts.length, unitTitles: unitTitles.slice(0, 6) };
}
