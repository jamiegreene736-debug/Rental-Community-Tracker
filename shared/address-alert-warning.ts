// Address-on-OTA alert popup logic (dashboard) — Phase 3.
//
// Complements the duplicate-PHOTOS warning. When the photo-listing scanner's
// ADDRESS leg (shared/address-listing-logic.ts + address-page-match.ts +
// address-geo-match.ts) marks a unit's street address as FOUND on a real
// Airbnb / VRBO / Booking.com listing that isn't ours, the dashboard raises a
// SEPARATE warning.
//
// This is deliberately distinct from the duplicate-photos popup: the remedy for
// a stolen ADDRESS is an OTA takedown / report of a relisted physical unit, NOT
// "replace the photos" — a relister can swap the photos but not the address, so
// swapping our photos does nothing about the relist. This popup therefore has
// no Replace-photos action; it just surfaces the offending listings to report.
//
// Pure helpers only (signature + link collection). The React side in
// client/src/pages/home.tsx owns fetching and rendering.

export type AddressAlertPlatform = "airbnb" | "vrbo" | "booking";
export type AddressAlertStatus = "clean" | "found" | "unknown";

export const ADDRESS_ALERT_PLATFORMS: AddressAlertPlatform[] = ["airbnb", "vrbo", "booking"];

export const ADDRESS_ALERT_PLATFORM_LABELS: Record<AddressAlertPlatform, string> = {
  airbnb: "Airbnb",
  vrbo: "VRBO",
  booking: "Booking.com",
};

export function formatAddressAlertPlatforms(platforms: AddressAlertPlatform[]): string {
  return platforms.map((p) => ADDRESS_ALERT_PLATFORM_LABELS[p]).join(" / ");
}

// Which platforms report the address as FOUND for a folder.
export function addressFoundPlatforms(
  statuses: Partial<Record<AddressAlertPlatform, AddressAlertStatus | null | undefined>>,
): AddressAlertPlatform[] {
  return ADDRESS_ALERT_PLATFORMS.filter((p) => statuses[p] === "found");
}

export type AddressAlertUnitFacts = {
  folder: string;
  platforms: AddressAlertPlatform[];
  // checkedAt of the scan row that produced the FOUND verdict — so a LATER scan
  // that still finds the address re-raises a dismissed warning (fresh facts),
  // while mere page reloads stay quiet.
  checkedAt?: string | null;
};

// Order-independent signature of the current address-alert facts. Persisted on
// dismiss; the popup only auto-reopens when the signature changes.
export function addressAlertWarningSignature(units: AddressAlertUnitFacts[]): string {
  if (units.length === 0) return "";
  return units
    .map((u) => `${u.folder}|${[...u.platforms].sort().join(",")}|${u.checkedAt ?? ""}`)
    .sort()
    .join(";");
}

export type AddressMatchRow = {
  platform?: string | null;
  url?: string | null;
  title?: string | null;
  snippet?: string | null;
};

export type AddressAlertLink = {
  platform: AddressAlertPlatform;
  url: string;
  title: string;
  snippet: string;
};

// Flatten the scanner's addressMatches into de-duped, clickable links to the OTA
// listings that surface our address. The scanner has ALREADY suppressed our own
// Guesty-authorized URLs and unit-number-gated each hit, so every URL here is a
// listing that is NOT ours. De-duped by URL (query/slash-insensitive) and
// platform-ordered (Airbnb, VRBO, Booking.com); `limit` caps the rendered list.
export function collectAddressAlertLinks(
  matches: AddressMatchRow[] | null | undefined,
  limit = 6,
): { links: AddressAlertLink[]; more: number } {
  const byKey = new Map<string, AddressAlertLink>();
  const links: AddressAlertLink[] = [];
  for (const platform of ADDRESS_ALERT_PLATFORMS) {
    for (const m of matches ?? []) {
      if (String(m?.platform ?? "").toLowerCase() !== platform) continue;
      const url = String(m?.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const key = url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
      if (byKey.has(key)) continue;
      const link: AddressAlertLink = {
        platform,
        url,
        title: String(m?.title ?? "").trim() || url,
        snippet: String(m?.snippet ?? "").trim(),
      };
      byKey.set(key, link);
      links.push(link);
    }
  }
  return { links: links.slice(0, limit), more: Math.max(0, links.length - limit) };
}
