// Pure helpers for the manual "add a buy-in" dialog.
//
// The dialog lets an operator paste a listing URL and auto-reads the
// stay cost so the buy-in is recorded "just like a VRBO URL". VRBO has
// a dedicated payment-schedule reader; every other bookable listing —
// direct-booking / property-manager sites like
// waikikibeachrentals.com — goes through the generic PM rate extractor
// (`/api/operations/verify-pm-listing` → verifyPmRate). This module
// holds the two load-bearing pure decisions so they're unit-testable
// and can't drift between client orchestration and any future server
// caller:
//   1. which extraction path a pasted URL should take, and
//   2. how to turn a PM extraction into a single cost number.
//
// Kept dependency-free (no client/server imports) on purpose.

export type BuyInUrlKind = "vrbo" | "direct" | "invalid";

/**
 * Classify a pasted buy-in listing URL into the extraction path the
 * manual buy-in dialog should use.
 *
 * - `vrbo`    → use the existing VRBO checkout reader.
 * - `direct`  → any other http(s) listing (direct-booking / PM site);
 *               use the generic PM rate extractor.
 * - `invalid` → empty, malformed, or a non-http(s) scheme.
 */
export function classifyBuyInListingUrl(raw: string | null | undefined): BuyInUrlKind {
  const value = String(raw ?? "").trim();
  if (!value) return "invalid";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "invalid";
  const host = parsed.hostname.toLowerCase();
  if (!host) return "invalid";
  // Match vrbo.com and its subdomains (www., m., etc.) but NOT a
  // look-alike like vrbo.com.evil.com — anchored to the end of host.
  if (/(?:^|\.)vrbo\.com$/.test(host)) return "vrbo";
  return "direct";
}

export type PmExtraction =
  | {
      totalPrice?: number | null;
      nightlyPrice?: number | null;
      available?: boolean | null;
      dateMatch?: boolean | null;
    }
  | null
  | undefined;

export type PmCostResolution =
  | { ok: true; cost: number; basis: "total" | "nightly" }
  | { ok: false; reason: "unavailable" | "no-price" };

/**
 * Resolve a single buy-in cost (USD) from a generic PM rate extraction.
 *
 * Preference order:
 *   1. A positive `totalPrice` (the all-in stay total the page showed).
 *   2. `nightlyPrice × nights` when only a per-night rate was read.
 *
 * Returns `{ ok: false }` when the page reported the dates as
 * unavailable, or when no positive price could be derived — the caller
 * then asks the operator to type the cost, exactly like the VRBO path
 * does when it can't read the checkout total.
 */
export function resolvePmExtractedCost(extracted: PmExtraction, nights: number): PmCostResolution {
  if (extracted && extracted.available === false) {
    return { ok: false, reason: "unavailable" };
  }
  const total = Number(extracted?.totalPrice);
  if (Number.isFinite(total) && total > 0) {
    return { ok: true, cost: Math.round(total * 100) / 100, basis: "total" };
  }
  const nightly = Number(extracted?.nightlyPrice);
  const n = Number.isFinite(nights) && nights > 0 ? Math.round(nights) : 0;
  if (Number.isFinite(nightly) && nightly > 0 && n > 0) {
    return { ok: true, cost: Math.round(nightly * n * 100) / 100, basis: "nightly" };
  }
  return { ok: false, reason: "no-price" };
}

/** Inclusive nights between two YYYY-MM-DD dates (noon-anchored to dodge DST). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = new Date(`${checkIn}T12:00:00`).getTime();
  const b = new Date(`${checkOut}T12:00:00`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}
