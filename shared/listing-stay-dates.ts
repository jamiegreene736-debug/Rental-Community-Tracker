// Stay-date URL decoration — append a reservation's check-in/check-out to a
// listing URL so clicking it lands on the unit page with the dates already
// filled in the booking widget (operator ask, 2026-07-19).
//
// This is the ONE home for the per-platform date-param spellings. It was
// extracted from the inline `withStayDates` closure in server/routes.ts
// (find-buy-in handler), which now delegates here, and is also used by the
// bookings-page attached-unit link (client) so buy-ins attached BEFORE the
// Cowork prompt learned to embed dates still open with the dates filled.
//
// Rules (load-bearing):
// - NEVER clobber a param the URL already carries — a Cowork-attached URL may
//   already have the correct dates baked in; re-decorating must be a no-op.
// - Unparseable URLs pass through untouched (never break a link).
// - Missing/unparseable dates → the URL is returned unchanged.

import { otaPlatformForUrl } from "./ota-host-match";

export type StayDateUrlSource = "airbnb" | "vrbo" | "booking" | "pm";

/** Platform bucket for date-param spelling. Unknown hosts (PM/direct sites)
 *  get the "pm" sprinkle of every common param name. */
export function stayDateSourceForUrl(url: string | null | undefined): StayDateUrlSource {
  return otaPlatformForUrl(url) ?? "pm";
}

/** Normalize a date-ish string ("2026-07-20", "2026-07-20T15:00:00-10:00")
 *  to YYYY-MM-DD. String-prefix based on purpose — no Date() timezone math,
 *  so a Guesty ISO datetime keeps its stated calendar day. */
export function toStayDateYmd(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? "").trim());
  return m ? m[1] : null;
}

/**
 * Append the stay dates to a listing URL using the platform's own query-param
 * spellings. `source` may be passed explicitly (the server's find-buy-in
 * handler knows which engine surfaced the candidate); when omitted it is
 * inferred from the host.
 */
export function withListingStayDates(
  rawUrl: string | null | undefined,
  checkIn: string | null | undefined,
  checkOut: string | null | undefined,
  source?: StayDateUrlSource,
): string {
  const url = String(rawUrl ?? "").trim();
  const ci = toStayDateYmd(checkIn);
  const co = toStayDateYmd(checkOut);
  if (!url || !ci || !co) return url;
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const set = (k: string, v: string) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };
  switch (source ?? stayDateSourceForUrl(url)) {
    case "airbnb":
      set("check_in", ci);
      set("check_out", co);
      set("adults", "2");
      break;
    case "vrbo":
      // Vrbo accepts two URL date conventions; we set both to be safe.
      // - arrival/departure: legacy params, also what Vrbo's Apollo SSR
      //   reads to fire the rate-calendar GraphQL on initial load (the
      //   Vrbo scraper relies on this — see pm-scraper-vrbo.ts).
      // - startDate/endDate: modern booking-widget params; pre-fills
      //   the date picker when the operator clicks through to the page.
      //   Without these, the widget renders with empty date inputs even
      //   when arrival/departure are present.
      set("arrival", ci);
      set("departure", co);
      set("startDate", ci);
      set("endDate", co);
      break;
    case "booking":
      set("checkin", ci);
      set("checkout", co);
      set("group_adults", "2");
      break;
    case "pm":
      // No universal convention across PM sites — sprinkle every common
      // param name. Sites that use one of these will pre-fill dates;
      // sites that don't will ignore unknown params.
      set("checkin", ci);
      set("checkout", co);
      set("check_in", ci);
      set("check_out", co);
      set("arrival", ci);
      set("departure", co);
      break;
  }
  return u.toString();
}
