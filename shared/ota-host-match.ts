// Which OTA platform does a listing URL belong to — HOST-FAMILY aware.
//
// The photo-listing scanner used to bucket Google Lens hits with bare
// substring checks ("airbnb.com" / "vrbo.com" / "booking.com"), which
// silently DROPPED matches Lens returns on regional or sibling domains:
// airbnb.co.uk / airbnb.ca / airbnb.fr, VRBO's brand family (homeaway.com,
// abritel.fr, fewo-direkt.de, stayz.com.au, bookabach.co.nz — all serve the
// SAME listing pool), and m.booking.com. That skew was a real reason the
// dashboard mostly showed Airbnb matches. These helpers are pure and
// unit-tested; the scanner consumes them for both bucketing and
// authorized-URL suppression.

export type OtaPlatformKey = "airbnb" | "vrbo" | "booking";

// VRBO brand family — same inventory, localized storefronts. A hit on any of
// these means the photos are live on the VRBO channel.
const VRBO_FAMILY_HOSTS = [
  "vrbo.com",
  "homeaway.com",
  "homeaway.co.uk",
  "abritel.fr",
  "fewo-direkt.de",
  "stayz.com.au",
  "bookabach.co.nz",
];

export function hostOfUrl(url: string | null | undefined): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

function hostInFamily(host: string, family: string): boolean {
  return host === family || host.endsWith(`.${family}`);
}

// Airbnb's registrable domain is "airbnb.<tld>" across ~40 country TLDs
// (airbnb.com, airbnb.ca, airbnb.fr, airbnb.co.uk, airbnb.com.au, …).
// Accept a host whose "airbnb" label is followed ONLY by 1-2 short TLD-ish
// labels — that shape rejects lookalikes such as "airbnb.evil.com" (where
// "evil" is not a TLD label) while covering every real country domain.
function isAirbnbHost(host: string): boolean {
  const labels = host.split(".");
  const idx = labels.indexOf("airbnb");
  if (idx === -1) return false;
  const after = labels.slice(idx + 1);
  if (after.length < 1 || after.length > 2) return false;
  return after.every((label) => /^[a-z]{2,3}$/.test(label));
}

export function otaPlatformForUrl(url: string | null | undefined): OtaPlatformKey | null {
  const host = hostOfUrl(url);
  if (!host) return null;
  if (isAirbnbHost(host)) return "airbnb";
  if (hostInFamily(host, "booking.com")) return "booking";
  for (const family of VRBO_FAMILY_HOSTS) {
    if (hostInFamily(host, family)) return "vrbo";
  }
  return null;
}

// Equivalent CANONICAL URLs for a regional/sibling-domain listing URL, used
// to test a Lens hit against the Guesty-derived authorized set (which stores
// our listings under their canonical hosts: airbnb.com/rooms/<id>,
// vrbo.com/<id>, booking.com/hotel/…). Without this, OUR OWN listing served
// from airbnb.co.uk or abritel.fr would evade suppression and light up as
// theft. Always includes the original URL itself.
export function canonicalOtaUrlCandidates(url: string): string[] {
  const out = [url];
  const host = hostOfUrl(url);
  if (!host) return out;
  let pathname = "";
  try {
    pathname = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).pathname;
  } catch {
    return out;
  }
  const platform = otaPlatformForUrl(url);
  if (platform === "airbnb" && host !== "airbnb.com") {
    // Airbnb paths are identical across country domains (/rooms/<id>).
    out.push(`https://www.airbnb.com${pathname}`);
  }
  if (platform === "booking" && host !== "booking.com") {
    out.push(`https://www.booking.com${pathname}`);
  }
  if (platform === "vrbo") {
    // The VRBO family embeds the same numeric listing id in localized paths:
    // vrbo.com/1234567, homeaway.com/vacation-rental/p1234567,
    // abritel.fr/location-vacances/p1234567vb. Canonicalize by id.
    const id = pathname.match(/\/p?(\d{6,})/)?.[1];
    if (id) out.push(`https://www.vrbo.com/${id}`);
  }
  return Array.from(new Set(out));
}
