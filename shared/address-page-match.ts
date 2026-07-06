// Phase-1 recall booster for the address-on-OTA leg (see
// shared/address-listing-logic.ts + server/photo-listing-scanner.ts).
//
// The cheap leg only inspects Google's ~160-char SERP *snippet*, so a listing
// whose street address lives below the fold (in the description, house rules,
// reviews, or a JSON-LD block) is dropped even though Google's `site:host
// "street" "city"` quoted query already associated that page with our street.
// These helpers let the scanner deep-fetch exactly those dropped-but-promising
// candidates and confirm the street in the FULL page text.
//
// Everything here is network-free and deterministic so it can be unit tested
// without SearchAPI or a live fetch. The scanner supplies the fetched HTML.

import type { AddressPlatform, AddressSerpMatch, SerpRow } from "./address-listing-logic";

// Candidates worth a full-page read: rows that (a) are a real listing-page URL
// on the host but (b) did NOT already surface the street in the snippet — i.e.
// exactly the rows filterAddressSerpRows drops. Because the SERP query quotes
// the street, Google still returned these because the PAGE contains it; the
// snippet just didn't happen to show it. This is the disjoint complement of
// filterAddressSerpRows, so a deep-fetch match can never double-count a snippet
// match. Deduped by URL.
export function selectDeepFetchCandidates(
  rows: SerpRow[],
  platform: AddressPlatform,
  street: string,
): AddressSerpMatch[] {
  const streetLower = street.trim().toLowerCase();
  if (!streetLower) return [];
  const out: AddressSerpMatch[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const url = String(r?.link ?? "");
    if (!url) continue;
    if (!platform.urlPattern.test(url.toLowerCase())) continue;
    const title = String(r?.title ?? "");
    const snippet = String(r?.snippet ?? "");
    // Snippet already proves the street → handled by the cheap path; skip here.
    if (`${title} ${snippet}`.toLowerCase().includes(streetLower)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title, snippet });
  }
  return out;
}

// Flatten fetched HTML to a lowercased, whitespace-collapsed haystack. Tags are
// replaced with a space (not deleted) so adjacent tokens don't fuse; crucially
// this KEEPS the text BETWEEN <script>…</script> tags, so a street address that
// only appears in a JSON-LD `streetAddress` field is still searchable. A light
// entity decode covers the handful of escapes that show up inside addresses.
export function normalizePageTextForMatch(html: string): string {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCharCode(code) : " ";
    })
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type AddressTextMatchType = "street" | "street-no-number" | "none";
export type AddressTextMatch = { matched: boolean; matchType: AddressTextMatchType; evidence: string };

function evidenceAround(hay: string, needle: string): string {
  const i = hay.indexOf(needle);
  if (i < 0) return "";
  const start = Math.max(0, i - 40);
  const end = Math.min(hay.length, i + needle.length + 40);
  return `${start > 0 ? "…" : ""}${hay.slice(start, end)}${end < hay.length ? "…" : ""}`;
}

// Does the FULL page text contain our street? `matched` is true only for an
// EXACT street hit (e.g. "1831 poipu rd") — that preserves the cheap path's
// precision, since these candidates still pass the scanner's unit-number gate.
// A street-WITHOUT-number hit ("poipu rd") is reported for provenance but
// deliberately NOT acted on in Phase 1 (every unit on the road would match);
// it's the seam a later phase can escalate through the unit gate.
export function matchAddressInText(html: string, ctx: { street: string; city?: string }): AddressTextMatch {
  const hay = normalizePageTextForMatch(html);
  const street = String(ctx?.street ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!street || !hay) return { matched: false, matchType: "none", evidence: "" };
  if (hay.includes(street)) {
    return { matched: true, matchType: "street", evidence: evidenceAround(hay, street) };
  }
  const noNumber = street.replace(/^\d+\s+/, "").trim();
  if (noNumber && noNumber !== street && hay.includes(noNumber)) {
    return { matched: false, matchType: "street-no-number", evidence: evidenceAround(hay, noNumber) };
  }
  return { matched: false, matchType: "none", evidence: "" };
}
