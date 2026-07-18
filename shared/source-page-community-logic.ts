// Pure logic for the SOURCE-PAGE community verification leg — no fs / network /
// Claude / DB dependencies, so it is browser-safe and unit-testable.
//
// The "Check photo community" flow already confirms a unit's PHOTOS belong to the
// expected community (Google Lens + Claude vision). This leg adds a second, INDE-
// PENDENT signal: the listing's own SOURCE PAGE (the Zillow / Redfin / Realtor /
// VRBO / Airbnb / Guesty URL each unit's photos were scraped from). We extract the
// page's readable location signals (title, meta/OpenGraph, JSON-LD address, a text
// snippet) and ask Claude whether the listing sits in the expected community/area.
//
// POSTURE (mirrors the photo leg + the combo gate, 2026-06-26/07-08): a "no" is a
// POSITIVE finding only — the page names a clearly DIFFERENT community/city/region.
// Absence of proof (a JS-only page with no readable address, a fetch failure, a
// Guesty page behind auth) is "uncertain", never a fail. This keeps the gate from
// skipping a legitimate resort just because its source page could not be read.

export type SourcePageSignals = {
  title?: string;
  metaDescription?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogLocality?: string;
  ogRegion?: string;
  /** streetAddress / addressLocality / addressRegion / postalCode from JSON-LD or meta. */
  addressHints: string[];
  headings: string[];
  /** Stripped visible-text snippet, capped. */
  snippet?: string;
};

export type SourcePageMatch = "yes" | "no" | "uncertain";

export type SourcePageVerdict = {
  unitLabel: string;
  url: string;
  match: SourcePageMatch;
  /** What Claude read the listing's community/place to be (may be empty). */
  identifiedCommunity?: string;
  /** City/region the page places the listing in (may be empty). */
  identifiedLocation?: string;
  reason: string;
  /** 0..1 self-reported confidence, when available. */
  confidence?: number;
  /** True when the page could not be read at all (fetch failed / empty / auth-gated). */
  unreadable?: boolean;
};

const SNIPPET_MAX = 2200;
const HINTS_MAX = 12;
const HEADINGS_MAX = 8;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    // Decode &amp; LAST so a replacement can never re-form another entity that a
    // prior rule would then double-unescape (e.g. "&amp;#39;" must stay "&#39;").
    .replace(/&amp;/g, "&");
}

function firstMeta(html: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) {
      const v = decodeEntities(m[1]).trim();
      if (v) return v;
    }
  }
  return undefined;
}

/** Escape every regex metacharacter (backslash first) so a name is a literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** name/property="X" content="Y" OR content="Y" ... name="X" (attribute order varies). */
function metaContent(name: string): RegExp[] {
  const n = escapeRegExp(name);
  return [
    new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*\\scontent=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${n}["']`, "i"),
  ];
}

function collectJsonLdAddresses(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1];
    // Cheap field-scrape rather than a full JSON parse (many pages ship arrays /
    // trailing commas / multiple blocks). We only want the address strings.
    for (const field of ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"]) {
      const fre = new RegExp(`"${field}"\\s*:\\s*"([^"]{1,120})"`, "gi");
      let fm: RegExpExecArray | null;
      while ((fm = fre.exec(raw))) {
        const v = decodeEntities(fm[1]).trim();
        if (v && !out.includes(v)) out.push(v);
      }
    }
    if (out.length >= HINTS_MAX) break;
  }
  return out.slice(0, HINTS_MAX);
}

/** Strip script/style/tags to a plain-text snippet. */
export function stripToText(html: string): string {
  return decodeEntities(
    html
      // End tags matched with [^>]* so any junk before ">" is tolerated —
      // "</script >", "</style\n>", "</script\t\n bar>" are all removed (CodeQL
      // js/bad-tag-filter). We are extracting text for a model prompt, not
      // sanitizing for the DOM, but robust stripping keeps stray markup out.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the readable location signals from a listing page's raw HTML. Robust to
 * JS-heavy SPAs: even when the body is empty, title + OpenGraph + JSON-LD usually
 * carry the address. Returns empty-ish signals (no throw) on junk input.
 */
export function extractSourcePageSignals(html: string): SourcePageSignals {
  const safe = typeof html === "string" ? html : "";
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(safe);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : undefined;

  const headings: string[] = [];
  const hre = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hre.exec(safe)) && headings.length < HEADINGS_MAX) {
    const t = stripToText(hm[1]);
    if (t && !headings.includes(t)) headings.push(t.slice(0, 160));
  }

  const addressHints = collectJsonLdAddresses(safe);
  for (const hint of [
    firstMeta(safe, metaContent("og:street-address")),
    firstMeta(safe, metaContent("og:locality")),
    firstMeta(safe, metaContent("og:region")),
    firstMeta(safe, metaContent("og:postal-code")),
    firstMeta(safe, metaContent("place:location:latitude")),
  ]) {
    if (hint && !addressHints.includes(hint) && addressHints.length < HINTS_MAX) addressHints.push(hint);
  }

  const snippet = stripToText(safe).slice(0, SNIPPET_MAX) || undefined;

  return {
    title,
    metaDescription: firstMeta(safe, metaContent("description")),
    ogTitle: firstMeta(safe, metaContent("og:title")),
    ogDescription: firstMeta(safe, metaContent("og:description")),
    ogLocality: firstMeta(safe, metaContent("og:locality")),
    ogRegion: firstMeta(safe, metaContent("og:region")),
    addressHints,
    headings,
    snippet,
  };
}

/**
 * True when a fetched page is a bot-detection wall rather than the listing —
 * PerimeterX ("Access to this page has been denied" / press-and-hold), Imperva
 * ("Pardon Our Interruption"), Cloudflare ("Just a moment" / "Attention Required").
 * Zillow serves these with HTTP 200 from some edges, so a status check alone is
 * not enough. Conservative on purpose: title markers always count; body-only
 * markers (px-captcha etc.) count only on a COMPACT page, because a real listing
 * page can mention "cloudflare" in a script bundle. Mirrors the sidecar's
 * detectListingBotWall posture (compact-body guard against false positives).
 */
export function looksLikeBotWallPage(html: string): boolean {
  const safe = typeof html === "string" ? html : "";
  if (!safe) return false;
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(safe);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  if (/access (?:to this page )?has been denied|denied access|pardon our interruption|just a moment|attention required|robot or human|human verification|verify you are|security check/i.test(title)) {
    return true;
  }
  const text = stripToText(safe);
  if (text.length < 3500 && /px-?captcha|perimeterx|press\s*&\s*hold|press and hold|are you a (?:human|robot)|checking your browser/i.test(safe)) {
    return true;
  }
  return false;
}

/**
 * Build SourcePageSignals from a structured listing-scraper JSON item (an Apify
 * Zillow / Redfin / Realtor detail-actor result) instead of raw HTML. Used by the
 * Apify rescue tier when the listing page itself bot-walls plain fetches.
 *
 * Depth-bounded walk collecting address-ish string fields + the listing
 * description. LOAD-BEARING: side-panel subtrees (similarHomes, nearbyHomes,
 * comparableHomes, schools, priceHistory, ...) are SKIPPED — a "nearby homes"
 * card can name a DIFFERENT community and would poison the verdict toward a
 * false "no" (the exact class the photo pipeline's scoped walk guards against).
 */
export function signalsFromListingJson(item: unknown): SourcePageSignals {
  const addressHints: string[] = [];
  let title: string | undefined;
  let description: string | undefined;

  const skipKeys = new Set([
    "similarHomes", "nearbyHomes", "nearbySchools", "schools", "priceHistory",
    "relatedHomes", "collections", "agentListings", "comparableHomes",
    "nearbyCities", "nearbyNeighborhoods", "nearbyZipcodes", "nearbyRegions",
    "similarListings", "nearbyListings", "comps", "photos", "images", "imageUrls",
    // Agent/broker subtrees: their OFFICE address (often a different city) must
    // never read as the listing's location, and their `name` is not a title.
    "attributionInfo", "listingAgent", "agent", "agents", "broker", "brokerage", "office", "contactRecipients",
  ]);
  const addressKeyRe = /^(streetAddress|street|streetName|city|state|stateOrProvince|zipcode|zip|postalCode|postal_code|addressLocality|addressRegion|addressLine1|addressLine2|unparsedAddress|fullAddress|formattedAddress|abbreviatedAddress|neighborhood|subdivision|county|community)$/i;
  // Deliberately NO bare `name` here — Zillow items carry the listing AGENT's
  // name in shallow `name` fields (live-verified: "Chris Coscarella" won the
  // title over the street address). Address-shaped keys make honest titles.
  const titleKeyRe = /^(title|headline|abbreviatedAddress|unparsedAddress|fullAddress|formattedAddress)$/i;
  const descriptionKeyRe = /^(description|homeDescription|listingDescription|remarks|publicRemarks|marketingRemarks)$/i;

  function push(v: string): void {
    const s = v.replace(/\s+/g, " ").trim();
    if (s && s.length <= 160 && !addressHints.includes(s) && addressHints.length < HINTS_MAX) {
      addressHints.push(s);
    }
  }

  function walk(o: unknown, depth: number): void {
    if (depth > 8 || !o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (skipKeys.has(k)) continue;
      if (typeof v === "string" || typeof v === "number") {
        const s = String(v);
        if (addressKeyRe.test(k)) push(s);
        if (!title && titleKeyRe.test(k) && typeof v === "string" && v.trim().length > 3) {
          title = v.replace(/\s+/g, " ").trim().slice(0, 200);
        }
        if (!description && descriptionKeyRe.test(k) && typeof v === "string" && v.trim().length > 20) {
          description = v.replace(/\s+/g, " ").trim().slice(0, 1500);
        }
      } else {
        walk(v, depth + 1);
      }
    }
  }
  walk(item, 0);

  // `address` as a plain string is common on Redfin/Realtor items.
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const addr = (item as Record<string, unknown>).address;
    if (typeof addr === "string") {
      push(addr);
      if (!title) title = addr.replace(/\s+/g, " ").trim().slice(0, 200);
    }
  }

  return {
    title,
    metaDescription: description,
    addressHints,
    headings: [],
    snippet: description,
  };
}

/** True when the extracted signals carry no usable location text at all. */
export function signalsAreEmpty(sig: SourcePageSignals): boolean {
  return (
    !sig.title &&
    !sig.metaDescription &&
    !sig.ogTitle &&
    !sig.ogDescription &&
    sig.addressHints.length === 0 &&
    sig.headings.length === 0 &&
    (!sig.snippet || sig.snippet.length < 40)
  );
}

/** Build the Claude prompt asking whether a source page is in the expected community. */
export function buildSourcePageCommunityPrompt(
  expectedCommunity: string,
  unitLabel: string,
  sig: SourcePageSignals,
): string {
  const lines: string[] = [];
  if (sig.title) lines.push(`Page title: ${sig.title}`);
  if (sig.ogTitle && sig.ogTitle !== sig.title) lines.push(`OpenGraph title: ${sig.ogTitle}`);
  if (sig.metaDescription) lines.push(`Meta description: ${sig.metaDescription}`);
  if (sig.ogDescription && sig.ogDescription !== sig.metaDescription) lines.push(`OpenGraph description: ${sig.ogDescription}`);
  if (sig.addressHints.length) lines.push(`Structured address fields: ${sig.addressHints.join(" · ")}`);
  if (sig.headings.length) lines.push(`Headings: ${sig.headings.join(" · ")}`);
  if (sig.snippet) lines.push(`Page text excerpt: ${sig.snippet}`);

  return [
    "You are verifying that a for-sale/rental LISTING PAGE is for a property located in a specific vacation-rental community (resort/condo complex) or, failing an exact name, at least the same town/area.",
    "",
    `Expected community: "${expectedCommunity.trim() || "(unspecified)"}".`,
    `Unit: ${unitLabel}. (This is OUR internal slot label — "Unit A"/"Unit B" — NOT a unit-number claim. Do NOT compare it against the unit/apartment number on the page; only the COMMUNITY/location matters.)`,
    "",
    "Below are the readable signals scraped from the listing's own source page:",
    "---",
    lines.join("\n") || "(no readable location text was found on the page)",
    "---",
    "",
    "Decide whether this listing is in the EXPECTED community/area. Rules:",
    '  - "yes": the page names the expected community/resort, OR an address/town that clearly places it in the same community or immediate area.',
    '  - "no": ONLY when the page POSITIVELY names a DIFFERENT community, city, or region that could not be the expected one (e.g. a different resort name, a different state, a far-away city).',
    '  - "uncertain": the page has no usable location text, is a login/blocked page, or you cannot tell. Do NOT guess "no" from missing evidence.',
    "",
    "Respond with ONLY minified JSON:",
    '{"match":"yes|no|uncertain","identifiedCommunity":"resort/complex name or empty","identifiedLocation":"city, state or empty","confidence":0.0,"reason":"one short sentence"}',
  ].join("\n");
}

/**
 * Extract the LAST complete top-level JSON object from free text. The model
 * occasionally emits a JSON verdict, reconsiders aloud, then emits a corrected
 * JSON verdict (observed live on the Wavecrest Unit A check) — a first-brace-to-
 * last-brace parse spans both objects plus prose and fails. The LAST object is
 * the model's final answer. String-aware brace scan; returns null when no
 * balanced object parses.
 */
export function extractLastJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== "string" || !text) return null;
  let last: Record<string, unknown> | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { if (depth > 0) inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              last = parsed as Record<string, unknown>;
            }
          } catch { /* unbalanced-looking span that isn't valid JSON — keep scanning */ }
          start = -1;
        }
      }
    }
  }
  return last;
}

const NORM = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Tolerant "is this the same community?" — casing/punctuation + phrase-subset. */
export function sourceCommunityNamesMatch(a: string, b: string): boolean {
  const na = NORM(a);
  const nb = NORM(b);
  if (!na || !nb) return false;
  return na === nb || ` ${na} `.includes(` ${nb} `) || ` ${nb} `.includes(` ${na} `);
}

/**
 * Normalize a raw Claude JSON row into a SourcePageVerdict. Defensive: an
 * unparseable/empty match falls back to "uncertain". A "no" whose identified
 * community actually MATCHES the expected one is downgraded to "yes" (the model
 * contradicted itself — never emit "looks like X, not X").
 */
export function parseSourcePageVerdict(
  raw: unknown,
  unitLabel: string,
  url: string,
  expectedCommunity: string,
): SourcePageVerdict {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawMatch = String(row.match ?? "").trim().toLowerCase();
  let match: SourcePageMatch = rawMatch === "yes" ? "yes" : rawMatch === "no" ? "no" : "uncertain";
  const identifiedCommunity = String(row.identifiedCommunity ?? "").trim() || undefined;
  const identifiedLocation = String(row.identifiedLocation ?? "").trim() || undefined;
  const reason = String(row.reason ?? "").trim() || "Source page checked.";
  const confRaw = Number(row.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : undefined;

  if (match === "no" && identifiedCommunity && expectedCommunity && sourceCommunityNamesMatch(identifiedCommunity, expectedCommunity)) {
    match = "yes";
  }

  return { unitLabel, url, match, identifiedCommunity, identifiedLocation, reason, confidence };
}

/**
 * A source-page verdict is a STRONG contradiction (safe to fail/skip on) only when
 * it POSITIVELY identifies a different community with reasonable confidence. Used by
 * the combo gate; the manual UI surfaces every "no" but this decides a hard skip.
 */
export function sourcePageIsStrongContradiction(v: SourcePageVerdict | undefined | null): boolean {
  if (!v || v.match !== "no" || v.unreadable) return false;
  // Need something concrete the page actually named — an empty-handed "no" is not
  // trustworthy enough to skip a resort.
  const named = Boolean((v.identifiedCommunity && v.identifiedCommunity.length > 1) || (v.identifiedLocation && v.identifiedLocation.length > 1));
  if (!named) return false;
  // If confidence is reported, require it to be meaningful.
  if (typeof v.confidence === "number" && v.confidence < 0.55) return false;
  return true;
}

/** Roll a set of unit source-page verdicts into a one-line summary. */
export function summarizeSourcePages(verdicts: SourcePageVerdict[]): {
  overall: "yes" | "no" | "uncertain" | "n/a";
  checked: number;
  matched: number;
  contradicted: number;
} {
  const checked = verdicts.filter((v) => !v.unreadable).length;
  const matched = verdicts.filter((v) => v.match === "yes").length;
  const contradicted = verdicts.filter((v) => sourcePageIsStrongContradiction(v)).length;
  let overall: "yes" | "no" | "uncertain" | "n/a" = "n/a";
  if (verdicts.length === 0) overall = "n/a";
  else if (contradicted > 0) overall = "no";
  else if (matched > 0 && matched === verdicts.length) overall = "yes";
  else if (checked === 0) overall = "uncertain";
  else overall = matched > 0 ? "yes" : "uncertain";
  return { overall, checked, matched, contradicted };
}
