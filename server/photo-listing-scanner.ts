// Reverse-image-search scanner.
//
// For each photo folder (e.g. "unit-721") we pick the top N non-hidden
// photos, ship them to Google Lens via SearchAPI, and check whether any
// of the visual matches are hosted on airbnb.com / vrbo.com /
// booking.com. If ≥ MIN_MATCHES of our photos hit the same platform we
// flag that platform as FOUND — meaning someone likely re-posted our
// photos on a listing we don't control.
//
// Heuristic choices (intentional, worth revisiting):
//   - N = 3 hero photos per folder. A full-gallery scan would be more
//     thorough but ~5x cost; 3 distinctive shots catch the common
//     case (someone copies bedroom + kitchen + exterior).
//   - MIN_MATCHES = 2, and each Lens hit must be strong (>=80%
//     confidence by SearchAPI score or top visual-result position). A
//     single partial/weak match can be a stock-photo false positive
//     (generic palm-tree exterior matches thousands of listings). Two
//     or more of OUR distinct private-unit photos hitting the same host
//     is much harder to explain away.
//   - Failure of EVERY Lens call → UNKNOWN (never silently "clean").
//   - URL cross-validation (see verifyUrlMentionsUnit): shared
//     buildings mean Lens can return a visually-similar listing for
//     a DIFFERENT unit at the same address (the 3920 Wyllie Rd
//     unit 2A → unit 9 false positive that motivated PR #81 on the
//     preflight). For folders whose name identifies a specific unit
//     (e.g. "unit-721", "kaha-lani-123", "mauna-kai-6a"), every Lens-
//     matched URL is verified via a targeted Google site: query —
//     that URL's page must surface the unit number with an explicit
//     marker ("Unit 721" / "#721" / "Apt 721" / "Suite 721"). URLs
//     that fail verification are dropped. Folders without a unit
//     hint (community-*, placeholder A/B) skip verification — a
//     match on a resort amenity photo is expected anyway.
//   - Authorized-URL suppression (see authorized-urls.ts): Lens will
//     happily return OUR own published listings when we search with
//     OUR own photos. Guesty knows which Airbnb/VRBO/Booking URLs we
//     own, so every Lens hit whose URL matches one of those is
//     dropped before it reaches the tally. No more red "FOUND" for a
//     listing that's legitimately ours.
//
// The result is upserted one row per folder into photo_listing_checks.
// The dashboard aggregates those rows by property-ID via the client's
// unit-builder-data lookup; the scanner itself is property-agnostic.

import { storage } from "./storage";
import type { PhotoListingCheck } from "@shared/schema";
import fs from "fs";
import path from "path";
import { normalizeUnitClaim, unitVerificationClaims } from "@shared/folder-unit-map";
import {
  draftPhotoFolderRef,
  isScannableFolder,
  replacementPhotoFolderRef,
  verificationTokensForFolder,
} from "@shared/photo-folder-utils";
import { replacementPhotoFolderForUnit } from "@shared/unit-swap-photos";
import { canonicalOtaUrlCandidates, otaPlatformForUrl } from "@shared/ota-host-match";
import { getAuthorizedChannelUrls, isAuthorizedUrl } from "./authorized-urls";
import { isCommunityOrSharedPhotoCandidate, isStrongLensMatch, lensMatchConfidence } from "./photo-match-guardrails";
import {
  communityEvidenceInResult,
  listingHaystackIncompatibleWithCommunity,
} from "@shared/preflight-platform-match";
import { communityAddressRuleForName } from "@shared/community-addresses";
import { decidePlatformStatus } from "@shared/photo-listing-decision";
import {
  ADDRESS_PLATFORMS,
  buildAddressQuery,
  filterAddressSerpRows,
  parseStreetCityState,
  type AddressPlatformKey,
} from "@shared/address-listing-logic";
import { isDuplicateHash } from "./photo-hashing";
import { getSearchApiKeys } from "./searchapi";
import { unitBuilderData } from "../client/src/data/unit-builder-data";

// Resolve to the FIRST available SearchAPI key (SEARCHAPI_API_KEY, then _2 / _SECONDARY). The
// global fetch fallback (installSearchApiFetchFallback) rotates to the other keys on a 429/quota
// response, so a dead primary key self-heals automatically. Reading via the resolver — instead of
// `process.env.SEARCHAPI_API_KEY` directly — fixes the case where the primary env is empty/dead
// but SEARCHAPI_API_KEY_2 holds the live key: the presence check and the initial request key both
// pick the live key. (A dead primary used to make every Lens call 429 → "photos inconclusive".)
const SEARCHAPI_KEY = getSearchApiKeys()[0] ?? "";
// The dashboard "Photos" match column depends on Google Lens reverse-image
// search. It was hard-disabled to preserve SearchAPI quota, which left every
// icon greyed ("unknown"). Re-enabled by default so the column works; the
// operator can still turn it off via env (PHOTO_LISTING_LENS_DISABLED=1)
// without a code change if quota becomes a concern.
const PHOTO_LISTING_LENS_DISABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.PHOTO_LISTING_LENS_DISABLED ?? "").trim(),
);
const PUBLIC_HOST = (() => {
  if (process.env.PUBLIC_PHOTO_BASE_URL) return process.env.PUBLIC_PHOTO_BASE_URL.replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return ""; // Dev: Lens won't be able to reach localhost photos.
})();

// Platform bucketing is HOST-FAMILY aware (shared/ota-host-match.ts): Lens
// frequently returns regional/sibling domains — airbnb.co.uk / airbnb.ca,
// VRBO's homeaway.com / abritel.fr / fewo-direkt.de / stayz.com.au /
// bookabach.co.nz, m.booking.com — and the old bare substring checks
// ("vrbo.com" etc.) silently dropped all of them, skewing the dashboard
// toward Airbnb-only matches. Suppression of our own listings must check the
// CANONICAL URL candidates too, or our own airbnb.co.uk mirror would flag as
// theft (canonicalOtaUrlCandidates).
const HOST_KEYS: Array<"airbnb" | "vrbo" | "booking"> = ["airbnb", "vrbo", "booking"];

const PHOTOS_PER_FOLDER = 3;
const MIN_MATCHES = 2;
// Daily SearchAPI/Lens budget for the on-demand preflight deep check (circuit-breaker). Counted as
// the sum of lensCalls across today's photo_listing_checks rows.
//
// 2026-06-17 (operator ask — "remove our 200 photo check limit a day"): the old 200/day cap was the
// thing leaving units stuck on "photos inconclusive" — once the day's audits crossed 200 Lens calls
// the batch stopped before scanning a folder, so its row never resolved to clean/found and the audit
// stayed a "maybe". The cap is now UNLIMITED by default (null). Set PHOTO_CHECK_DAILY_CAP to a finite
// number to re-impose a ceiling; 0 still hard-disables the on-demand deep check (the read path keeps
// working). The background scheduler is unaffected (it passes no cap).
const PHOTO_CHECK_DAILY_CAP: number | null = (() => {
  const raw = String(process.env.PHOTO_CHECK_DAILY_CAP ?? "").trim();
  if (!raw) return null; // unset → no daily cap
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
})();
// The on-demand "Full unit audit" deep check reverse-image-searches EVERY distinct interior photo
// (after dHash de-dup), not just a small sample. A thorough clean scan is exactly what lets the
// verdict be a confident NO ("not found — safe") instead of "inconclusive", and gives a listed unit
// every chance to surface the ≥2 matches that make a confident YES. Bounded so a pathological folder
// can't fire hundreds of Lens calls. The background scheduler still uses the cheap PHOTOS_PER_FOLDER.
export const PHOTO_AUDIT_MAX_PHOTOS = (() => {
  const n = Number(process.env.PREFLIGHT_PHOTO_AUDIT_MAX_PHOTOS);
  // 30 effectively covers the whole gallery (interior photos dedupe to ~10-15 distinct rooms), while
  // bounding the worst-case Lens spend on a pathologically large folder.
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
})();
// How many DISTINCT interior photos the BACKGROUND weekly cron reverse-image-searches per folder.
// 2026-06-29 (operator ask — "be 95-100% sure the unit's photos aren't listed on Airbnb/VRBO/Booking"):
// the cron used to scan only PHOTOS_PER_FOLDER (3) hero shots, so a repost that copied the 4th+ photo
// could slip past the AUTOMATIC weekly audit (only the on-demand deep button scanned the whole gallery).
// The weekly cron now defaults to the SAME full deduped gallery depth as the deep audit, so the
// unattended audit has the deep audit's recall. Set PHOTO_LISTING_SCAN_MAX_PHOTOS to a small number
// (e.g. 3) to restore the cheap weekly screen if SearchAPI credits ever become a concern; the on-demand
// deep audit is unaffected (it always passes PHOTO_AUDIT_MAX_PHOTOS).
const PHOTO_LISTING_SCAN_MAX_PHOTOS = (() => {
  const raw = String(process.env.PHOTO_LISTING_SCAN_MAX_PHOTOS ?? "").trim();
  if (!raw) return PHOTO_AUDIT_MAX_PHOTOS; // deep by default
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(PHOTO_AUDIT_MAX_PHOTOS, Math.floor(n)) : PHOTO_AUDIT_MAX_PHOTOS;
})();
// Balanced multi-photo agreement threshold (2026-06-29). Baseline: a platform is "found" when
// >= MIN_MATCHES (2) distinct photos pass the FULL verify gate (community-compatible AND the unit
// number appears in the listing's Google-indexed page text). But a determined repost can hide the unit
// number from page text (JS-rendered, image-only, or simply omitted), which made the strict gate
// silently drop real theft. So we ALSO flag "found" when >= MULTI_PHOTO_AGREEMENT (3) distinct interior
// photos of OURS converge on the SAME host with a STRONG Lens score on a community-compatible listing —
// even without the per-hit unit-text confirmation. Three of our own distinct interior shots landing on
// one host is itself strong, neighbour-resistant evidence (a similar-looking neighbour unit does not own
// three of our exact photos), and community/amenity photos are already excluded from the hero set while
// our own authorized OTA URLs are suppressed — so this can never fire on shared amenities or our real
// listings. Tunable via PHOTO_LISTING_AGREEMENT_THRESHOLD; values < 2 are ignored.
const MULTI_PHOTO_AGREEMENT = (() => {
  const n = Number(process.env.PHOTO_LISTING_AGREEMENT_THRESHOLD);
  if (!Number.isFinite(n) || n < 2) return 3;
  return Math.floor(n);
})();
// Address-on-OTA detection leg (the complement to the photo reverse-image leg). For each scanned unit
// folder we also run one Google `site:` text search per platform for the unit's street + city and check
// whether the unit's address surfaces on a real Airbnb/VRBO/Booking listing page. A thief can swap the
// photos but not the physical address, so this catches a relist the photo scan alone would miss. Set
// PHOTO_LISTING_ADDRESS_SCAN_DISABLED=1 to turn it off (e.g. to preserve SearchAPI quota).
const PHOTO_LISTING_ADDRESS_SCAN_DISABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.PHOTO_LISTING_ADDRESS_SCAN_DISABLED ?? "").trim(),
);
// Background re-scan cadence for the dashboard listing scan (the per-folder reverse-image check of
// each unit's photos against Airbnb/VRBO/Booking). 2026-06-26 (operator ask — "ensure that this is
// cron job once a week"): each scannable folder is re-scanned when its last check is older than this
// many days. Default 7 → a WEEKLY cron, surfaced in the dashboard "Scanned" column. Override with
// PHOTO_LISTING_SCAN_INTERVAL_DAYS without a code change (e.g. set to 1 to restore the prior daily
// cadence). Supersedes the earlier 24h default (which had itself superseded an even-earlier weekly one).
const PHOTO_LISTING_SCAN_INTERVAL_DAYS = (() => {
  const n = Number(process.env.PHOTO_LISTING_SCAN_INTERVAL_DAYS);
  if (!Number.isFinite(n) || n < 1) return 7;
  // Clamp the upper bound so a fat-fingered override (e.g. 1000000) can't
  // silently disable re-scanning entirely — a huge value would push the
  // staleness cutoff past every folder's checkedAt so nothing ever re-scans.
  // 366d ≈ "at most once a year" is the loosest sane cadence.
  return Math.min(366, Math.floor(n));
})();
export const PHOTO_LISTING_SCAN_MAX_AGE_MS = PHOTO_LISTING_SCAN_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
const LENS_TIMEOUT_MS = 45_000;
const VERIFY_TIMEOUT_MS = 20_000;
const IMAGE_EXT = /\.(?:jpe?g|png|webp)$/i;
const STANDALONE_DRAFT_NO_UNIT_TOKEN = "__standalone_draft_no_unit_token__";

export type PlatformStatus = "clean" | "found" | "unknown";
export type Match = { photoUrl: string; listingUrl: string; title: string; source: string };
export type AddressMatch = { platform: AddressPlatformKey; url: string; title: string; snippet: string };
type LensCallResult = { ok: true; rows: any[] } | { ok: false; error: string };
type PhotoCandidate = {
  filename: string;
  hidden?: boolean | null;
  label?: string | null;
  userLabel?: string | null;
  category?: string | null;
  userCategory?: string | null;
  perceptualHash?: string | null;
};

export type ScanResult = {
  folder: string;
  airbnbStatus: PlatformStatus;
  vrboStatus: PlatformStatus;
  bookingStatus: PlatformStatus;
  airbnbMatches: Match[];
  vrboMatches: Match[];
  bookingMatches: Match[];
  airbnbAddressStatus: PlatformStatus;
  vrboAddressStatus: PlatformStatus;
  bookingAddressStatus: PlatformStatus;
  addressMatches: AddressMatch[];
  photosChecked: number;
  lensCalls: number;
  errorMessage?: string;
};

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

async function listDiskPhotoCandidates(folder: string): Promise<PhotoCandidate[]> {
  try {
    const files = await fs.promises.readdir(publicPhotoDir(folder));
    return files
      .filter((f) => IMAGE_EXT.test(f) && !f.startsWith(".") && !f.startsWith("_"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((filename) => ({ filename, label: filename, category: "Living Areas" }));
  } catch {
    return [];
  }
}

async function folderHasDiskPhotos(folder: string): Promise<boolean> {
  const photos = await listDiskPhotoCandidates(folder);
  return photos.length > 0;
}

async function dynamicVerificationTokensForFolder(folder: string): Promise<string[] | null> {
  const mapped = verificationTokensForFolder(folder);
  if (mapped && mapped.length > 0) return mapped;

  const ref = draftPhotoFolderRef(folder) ?? replacementPhotoFolderRef(folder);
  if (!ref) return null;
  const swap = await storage.getLatestUnitSwap(ref.propertyId, ref.oldUnitId);
  if (!swap) {
    if (ref.propertyId < 0 && /unit-a$/i.test(ref.oldUnitId)) {
      const draft = await storage.getCommunityDraft(Math.abs(ref.propertyId));
      if ((draft as any)?.singleListing === true) {
        const tokens = unitVerificationClaims(
          draft?.name ?? "",
          [draft?.streetAddress, draft?.city, draft?.state].filter(Boolean).join(", "),
        );
        // Some imported single-listing condos have a valid resort address
        // but no unit number. We still scan them: authorized URL suppression
        // removes our own OTA pages, and the two-photo threshold keeps this
        // from treating one generic exterior match as a repost.
        return tokens.length > 0 ? Array.from(new Set(tokens)) : [STANDALONE_DRAFT_NO_UNIT_TOKEN];
      }
    }
    if (ref.propertyId < 0) {
      const draft = await storage.getCommunityDraft(Math.abs(ref.propertyId));
      if (draft && (draft as any)?.status === "published") {
        const unitSlot = /unit-b$/i.test(ref.oldUnitId) ? "unit2" : "unit1";
        const unitLabel = unitSlot === "unit2"
          ? ((draft as any)?.unit2Address || (draft as any)?.unit2Description || "Unit B")
          : ((draft as any)?.unit1Address || (draft as any)?.unit1Description || "Unit A");
        const address = [
          unitSlot === "unit2" ? (draft as any)?.unit2Address : (draft as any)?.unit1Address,
          draft?.streetAddress,
          draft?.city,
          draft?.state,
        ].filter(Boolean).join(", ");
        const tokens = unitVerificationClaims(unitLabel, address);
        // Published draft combo listings can have real
        // representative unit photo folders but no concrete condo number yet.
        // Do not block those forever: authorized-URL suppression plus the
        // two-distinct-photo threshold still guards against one-off resort
        // amenity false positives, while letting copied OTA/private photos
        // surface as red dashboard badges.
        return tokens.length > 0 ? Array.from(new Set(tokens)) : [STANDALONE_DRAFT_NO_UNIT_TOKEN];
      }
    }
    return null;
  }

  const tokens = unitVerificationClaims(swap.newUnitLabel ?? "", swap.newAddress ?? "");
  return tokens.length > 0 ? Array.from(new Set(tokens)) : null;
}

type FolderCommunityContext = { complexName: string; city: string };

async function folderCommunityContext(folder: string): Promise<FolderCommunityContext | null> {
  const ref = draftPhotoFolderRef(folder) ?? replacementPhotoFolderRef(folder);
  // The community-compat brake must ALSO resolve for replacement-p<prop>-u<unit>
  // folders on BUILDER properties (positive embedded id) — before this, a
  // replaced unit's folder got NO community context, listingMatchesFolderCommunity
  // returned true for EVERY Lens hit, and generic tropical-interior look-alikes
  // (a Maui "Kamaole Sands" 1BD, a "Costa del Sol" beach house, an Airbnb hub
  // page) tripped the multi-photo-agreement rule into a false FOUND right after
  // a photo swap (operator report 2026-07-04). folderAddressContext already
  // resolves these via the unit-swap row; this brings the photo leg's community
  // gate to parity.
  const builder = unitBuilderData.find((b) =>
    b.communityPhotoFolder === folder ||
    b.units.some((u) => u.photoFolder === folder) ||
    (ref !== null && ref.propertyId > 0 && b.propertyId === ref.propertyId),
  );
  if (builder?.complexName) {
    const rule = communityAddressRuleForName(builder.complexName);
    return { complexName: builder.complexName, city: rule?.city || builder.address?.split(",")[1]?.trim() || "" };
  }
  if (ref?.propertyId && ref.propertyId < 0) {
    const draft = await storage.getCommunityDraft(Math.abs(ref.propertyId));
    if (draft?.name) {
      return { complexName: String(draft.name), city: String(draft.city ?? "") };
    }
  }
  return null;
}

function listingMatchesFolderCommunity(
  title: string,
  source: string,
  link: string,
  ctx: FolderCommunityContext | null,
): boolean {
  if (!ctx?.complexName) return true;
  const haystack = `${title} ${source} ${link}`;
  if (listingHaystackIncompatibleWithCommunity(haystack, ctx.complexName, ctx.city)) return false;
  return communityEvidenceInResult({ title, snippet: source, link }, ctx.complexName);
}

type FolderAddressContext = { street: string; city: string; state: string };

// Resolve the street + city to text-search for this folder. Prefers the
// resort's canonical street from community-addresses (shared across units;
// the unit-number gate disambiguates), falling back to the unit-builder /
// draft address string. Returns null when no usable street is known — the
// address leg is then skipped (the photo leg still runs).
async function folderAddressContext(folder: string): Promise<FolderAddressContext | null> {
  const builder = unitBuilderData.find((b) =>
    b.communityPhotoFolder === folder || b.units.some((u) => u.photoFolder === folder),
  );
  if (builder) {
    const rule = communityAddressRuleForName(builder.complexName);
    // parseStreetCityState skips an embedded "Unit N"/"Bldg N" segment so a 4-part
    // address ("1831 Poipu Rd, Unit 423, Koloa, HI 96756") yields city "Koloa", not
    // "Unit 423" (the old parts[1] parse fed a bogus city into the SERP query).
    const parsed = parseStreetCityState(builder.address ?? "");
    const street = (rule?.street || parsed.street).trim();
    const city = (rule?.city || parsed.city).trim();
    const state = (rule?.state || parsed.state).trim();
    if (street && city) return { street, city, state };
    return null;
  }
  const ref = draftPhotoFolderRef(folder) ?? replacementPhotoFolderRef(folder);
  if (ref?.propertyId && ref.propertyId < 0) {
    const draft = await storage.getCommunityDraft(Math.abs(ref.propertyId));
    if (draft) {
      const rule = communityAddressRuleForName(String(draft.name ?? ""));
      const parsed = parseStreetCityState(String((draft as any).streetAddress ?? ""));
      const street = (rule?.street || parsed.street).trim();
      const city = (rule?.city || parsed.city || String(draft.city ?? "")).trim();
      const state = (rule?.state || parsed.state || String((draft as any).state ?? "")).trim();
      if (street && city) return { street, city, state };
    }
  }
  // Replacement / swap-backed folder (e.g. `replacement-p4-uunit-423`). These have a
  // POSITIVE propertyId so they never hit the draft branch above — the prior code returned
  // null here, which is why every replacement folder showed address "inconclusive". The
  // candidate unit's real street address lives on the latest unit-swap row.
  if (ref) {
    const swap = await storage.getLatestUnitSwap(ref.propertyId, ref.oldUnitId);
    if (swap?.newAddress) {
      const parsed = parseStreetCityState(swap.newAddress);
      if (parsed.street && parsed.city) {
        return { street: parsed.street, city: parsed.city, state: parsed.state };
      }
    }
  }
  return null;
}

async function callGoogleTextSearch(query: string): Promise<LensCallResult> {
  if (!SEARCHAPI_KEY) return { ok: false, error: "SEARCHAPI_API_KEY not configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ engine: "google", q: query, api_key: SEARCHAPI_KEY, num: "10" });
    const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`, { signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const msg = describeSearchApiHttpError(resp.status, body);
      console.error(`[photo-listing-scanner] address ${msg} for "${query}"`);
      return { ok: false, error: msg };
    }
    const data = await resp.json() as any;
    return { ok: true, rows: Array.isArray(data.organic_results) ? data.organic_results : [] };
  } catch (e: any) {
    const msg = e?.name === "AbortError"
      ? `Google/SearchAPI timed out after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s`
      : `Google/SearchAPI request failed: ${e?.message ?? String(e)}`;
    console.error(`[photo-listing-scanner] address ${msg} for "${query}"`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

// Address-on-OTA leg. For each platform, one `site:host "street" "city"`
// query, then keep only real listing-page URLs that surface the street.
// Our own authorized listings are suppressed, and (unless this is a
// standalone unique-address listing) each hit must also pass the unit-
// number gate so a shared-resort address can't paint every owner's
// listing red. Returns per-platform status + the matches for the UI.
async function checkAddressOnOtas(
  ctx: FolderAddressContext,
  deps: {
    authorizedUrls: Awaited<ReturnType<typeof getAuthorizedChannelUrls>>;
    allowUnverifiedStandalone: boolean;
    verifyUnit: (url: string) => Promise<boolean>;
  },
): Promise<{
  statuses: Record<AddressPlatformKey, PlatformStatus>;
  matches: AddressMatch[];
  anySucceeded: boolean;
  errors: string[];
}> {
  const statuses: Record<AddressPlatformKey, PlatformStatus> = { airbnb: "unknown", vrbo: "unknown", booking: "unknown" };
  const matches: AddressMatch[] = [];
  const errors: string[] = [];
  let anySucceeded = false;

  for (const platform of ADDRESS_PLATFORMS) {
    const query = buildAddressQuery(platform.site, ctx.street, ctx.city);
    const serp = await callGoogleTextSearch(query);
    if (!serp.ok) {
      errors.push(serp.error);
      continue; // leave this platform "unknown"
    }
    anySucceeded = true;
    const candidates = filterAddressSerpRows(serp.rows as any[], platform, ctx.street);
    const kept: AddressMatch[] = [];
    for (const c of candidates) {
      if (isAuthorizedUrl(c.url.toLowerCase(), deps.authorizedUrls)) continue; // our own listing — expected, not theft
      // Unit-number gate (skipped for standalone unique-address listings):
      // require the listing page to also surface our unit number so a
      // sibling owner at the same resort street doesn't trip the flag.
      if (!deps.allowUnverifiedStandalone) {
        const ok = await deps.verifyUnit(c.url);
        if (!ok) continue;
      }
      kept.push({ platform: platform.key, url: c.url, title: c.title, snippet: c.snippet });
    }
    statuses[platform.key] = kept.length > 0 ? "found" : "clean";
    matches.push(...kept.slice(0, 5));
  }

  return { statuses, matches, anySucceeded, errors };
}

function compactErrorDetail(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function describeSearchApiHttpError(status: number, text: string): string {
  const detail = compactErrorDetail(text);
  if (status === 429) {
    return "Google Lens/SearchAPI HTTP 429: SearchAPI throttled or rejected the Lens request. This is not proof that the monthly search balance is exhausted; verify Railway SEARCHAPI_API_KEY matches the active key and retry the scan.";
  }
  if (status === 401 || status === 403) {
    return `Google Lens/SearchAPI HTTP ${status}: SearchAPI rejected the configured API key${detail ? ` (${detail})` : ""}`;
  }
  if (status >= 500) {
    return `Google Lens/SearchAPI HTTP ${status}: SearchAPI provider error${detail ? ` (${detail})` : ""}`;
  }
  return `Google Lens/SearchAPI HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

export function normalizeSearchApiErrorMessage(message?: string | null): string | null {
  if (!message) return message ?? null;
  const text = message.toLowerCase();
  if (
    text.includes("google lens/searchapi http 429") ||
    text.includes("you have used all of the searches") ||
    text.includes("upgrade your plan on searchapi.io")
  ) {
    return message.replace(
      /Google Lens\/SearchAPI HTTP 429(?::.*?)(?=(?:;|$|\s+\(kept previous status))/i,
      "Google Lens/SearchAPI HTTP 429: SearchAPI throttled or rejected the Lens request. This is not proof that the monthly search balance is exhausted; verify Railway SEARCHAPI_API_KEY matches the active key and retry the scan.",
    );
  }
  return message;
}

function parseStoredMatches(raw?: string | null): Match[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isProviderUnavailableError(message?: string): boolean {
  const text = (message ?? "").toLowerCase();
  if (!text.includes("searchapi")) return false;
  return (
    text.includes("http 429") ||
    text.includes("used all of the searches") ||
    text.includes("timed out") ||
    text.includes("request failed") ||
    text.includes("not configured")
  );
}

async function callGoogleLens(imageUrl: string): Promise<LensCallResult> {
  if (PHOTO_LISTING_LENS_DISABLED) {
    return {
      ok: false,
      error: "Google Lens reverse-image search is disabled (PHOTO_LISTING_LENS_DISABLED) to preserve SearchAPI quota.",
    };
  }
  if (!SEARCHAPI_KEY) return { ok: false, error: "SEARCHAPI_API_KEY not configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LENS_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `https://www.searchapi.io/api/v1/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SEARCHAPI_KEY}`,
      { signal: controller.signal },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const msg = describeSearchApiHttpError(resp.status, body);
      console.error(`[photo-listing-scanner] ${msg} for ${imageUrl}`);
      return { ok: false, error: msg };
    }
    const data = await resp.json() as any;
    const rowsFrom = (source: string, rows: any[] | undefined): any[] =>
      Array.isArray(rows)
        ? rows.map((row, idx) => ({ ...row, __lensSource: source, __lensPosition: Number(row?.position ?? idx + 1) }))
        : [];
    return { ok: true, rows: [
      ...rowsFrom("visual", data.visual_matches),
      ...rowsFrom("page", data.pages_with_matching_images),
      ...rowsFrom("image", data.image_results),
      ...rowsFrom("organic", data.organic_results),
    ] };
  } catch (e: any) {
    const msg = e?.name === "AbortError"
      ? `Google Lens/SearchAPI timed out after ${Math.round(LENS_TIMEOUT_MS / 1000)}s`
      : `Google Lens/SearchAPI request failed: ${e?.message ?? String(e)}`;
    console.error(`[photo-listing-scanner] ${msg} for ${imageUrl}`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

// Confirm that a Lens-matched listing URL actually references the unit
// identified by `unitHint`. Runs one targeted Google site: query
// scoped to the listing's path. If the candidate page doesn't surface
// the unit number with an explicit marker, we treat it as a
// shared-building false positive and reject.
//
// Mirrors the preflight's verifyUrlMentionsUnit from PR #81.
async function verifyUrlMentionsUnit(url: string, unitHint: string): Promise<boolean> {
  if (!SEARCHAPI_KEY) return false;
  const n = normalizeUnitClaim(unitHint);
  if (!n || !url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.replace(/^www\./, "");
  // Strip file extensions (.html, .zh-cn.html) and trailing slashes so
  // Google indexes the listing as one canonical path.
  const pathClean = parsed.pathname.replace(/\.[a-z0-9.-]+$/i, "").replace(/\/+$/, "");
  if (!pathClean) return false;
  const variants = Array.from(new Set([
    n,
    n.replace(/\s+/g, "-"),
    n.replace(/[\s-]+/g, ""),
  ].filter((v) => v && (v === n || v.length >= 3))));
  const markers = variants.flatMap((variant) => [
    `"Unit ${variant}"`,
    `"#${variant}"`,
    `"Apt ${variant}"`,
    `"Apartment ${variant}"`,
    `"Suite ${variant}"`,
  ]).join(" OR ");
  const q = `site:${host}${pathClean} (${markers})`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ engine: "google", q, api_key: SEARCHAPI_KEY, num: "3" });
    const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`, { signal: controller.signal });
    if (!resp.ok) {
      console.error(`[photo-listing-scanner] verify HTTP ${resp.status} for ${url}`);
      return false;
    }
    const data = await resp.json() as any;
    return ((data.organic_results || []) as any[]).length > 0;
  } catch (e: any) {
    const msg = e?.name === "AbortError"
      ? `timed out after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s`
      : e?.message;
    console.error(`[photo-listing-scanner] verify error for ${url}: ${msg}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Emit alerts for every platform whose status just worsened to
// "found" (from "clean" or "unknown"). We deliberately ignore
// "found → found" (already alerted) and "found → anything else"
// (problem resolved — no need to raise a new flag). Alerts are one-
// row-per-transition so operators can walk the history of events
// instead of just seeing the current state.
async function alertOnStateWorsen(
  prior: { airbnbStatus: PlatformStatus; vrboStatus: PlatformStatus; bookingStatus: PlatformStatus } | null,
  next: ScanResult,
): Promise<void> {
  const platforms: Array<{
    key: "airbnb" | "vrbo" | "booking";
    prior: PlatformStatus;
    newStatus: PlatformStatus;
    matches: Match[];
  }> = [
    { key: "airbnb",  prior: prior?.airbnbStatus  ?? "unknown", newStatus: next.airbnbStatus,  matches: next.airbnbMatches },
    { key: "vrbo",    prior: prior?.vrboStatus    ?? "unknown", newStatus: next.vrboStatus,    matches: next.vrboMatches },
    { key: "booking", prior: prior?.bookingStatus ?? "unknown", newStatus: next.bookingStatus, matches: next.bookingMatches },
  ];
  for (const p of platforms) {
    if (p.newStatus !== "found") continue;
    if (p.prior === "found") continue; // already alerted last run
    try {
      await storage.createPhotoListingAlert({
        photoFolder: next.folder,
        platform: p.key,
        priorStatus: p.prior,
        newStatus: p.newStatus,
        matchedUrls: p.matches.length ? JSON.stringify(p.matches.slice(0, 5)) : null,
      });
      console.error(
        `[photo-listing-scanner] ALERT: ${next.folder} ${p.key} flipped ${p.prior} → found (${p.matches.length} match${p.matches.length === 1 ? "" : "es"})`,
      );
    } catch (e: any) {
      console.error(`[photo-listing-scanner] failed to record alert for ${next.folder}/${p.key}: ${e?.message}`);
    }
  }
}

export async function runPhotoListingCheckForFolder(
  folder: string,
  opts: { maxPhotos?: number } = {},
): Promise<ScanResult> {
  // How many DISTINCT interior photos to reverse-image (1 Lens call each). Background scheduler uses
  // the cheap default (3); the on-demand preflight deep check passes a large number so it scans the
  // whole deduped gallery (clamped to PHOTO_AUDIT_MAX_PHOTOS).
  const maxPhotos = Math.max(1, Math.min(PHOTO_AUDIT_MAX_PHOTOS, Math.floor(opts.maxPhotos ?? PHOTOS_PER_FOLDER)));
  console.error(`[photo-listing-scanner] ${folder}: starting (maxPhotos=${maxPhotos})`);
  const result: ScanResult = {
    folder,
    airbnbStatus: "unknown",
    vrboStatus: "unknown",
    bookingStatus: "unknown",
    airbnbMatches: [],
    vrboMatches: [],
    bookingMatches: [],
    airbnbAddressStatus: "unknown",
    vrboAddressStatus: "unknown",
    bookingAddressStatus: "unknown",
    addressMatches: [],
    photosChecked: 0,
    lensCalls: 0,
  };

  // Skip folders we can't cross-validate. Without a real unit-number
  // hint, every Lens match is accepted blindly — and in a condo
  // complex with similar interiors, that produces false positives by
  // matching to OTHER unit owners' legitimate listings. Examples:
  //   community-* (shared amenity photos)
  //   pili-mai-unit-a / pili-mai-unit-b (placeholder unit IDs)
  //   kekaha-main, keauhou-estate (no digit in name)
  // Once these folders are renamed to include a real unit number
  // (e.g. pili-mai-12c), they'll start scanning automatically.
  const rawVerifyTokens = await dynamicVerificationTokensForFolder(folder);
  if (!rawVerifyTokens || rawVerifyTokens.length === 0) {
    result.errorMessage = "Folder has no unit-number identifier — verification disabled, scan skipped to avoid false positives";
    await persist(result);
    return result;
  }
  const allowUnverifiedStandalone = rawVerifyTokens.includes(STANDALONE_DRAFT_NO_UNIT_TOKEN);
  const verifyTokens = rawVerifyTokens.filter((token) => token !== STANDALONE_DRAFT_NO_UNIT_TOKEN);
  const communityCtx = await folderCommunityContext(folder);

  // Capture the prior status row BEFORE upserting so we can emit
  // state-worsen alerts after the new row lands. Null → never scanned.
  const priorRow = await storage.getPhotoListingCheckByFolder(folder);
  const prior = priorRow ? {
    airbnbStatus:  priorRow.airbnbStatus  as PlatformStatus,
    vrboStatus:    priorRow.vrboStatus    as PlatformStatus,
    bookingStatus: priorRow.bookingStatus as PlatformStatus,
  } : null;

  if (!SEARCHAPI_KEY) {
    result.errorMessage = "SEARCHAPI_API_KEY not configured";
    await persist(result, priorRow);
    return result;
  }
  if (!PUBLIC_HOST) {
    result.errorMessage = "No public host configured (PUBLIC_PHOTO_BASE_URL or RAILWAY_PUBLIC_DOMAIN)";
    await persist(result);
    return result;
  }

  // Lazy backfill of perceptual hashes for legacy rows. Cheap if
  // already done (skips rows that have a hash). Runs before we read
  // labels so the smart selector + cross-channel-leak check downstream
  // always have hashes to work with on at least the freshly-touched
  // folders.
  try {
    const { backfillFolderHashes } = await import("./photo-hashing");
    await backfillFolderHashes(folder);
  } catch (e: any) {
    console.error(`[photo-listing-scanner] backfill ${folder}: ${e?.message ?? e}`);
  }

  const labels = await storage.getPhotoLabelsByFolder(folder);
  let visible: PhotoCandidate[] = labels.filter((l) => !l.hidden).sort((a, b) => a.filename.localeCompare(b.filename));
  if (visible.length === 0) {
    visible = await listDiskPhotoCandidates(folder);
  }
  // Prefer private/interior categories for the hero set and never fall
  // back to obvious community/shared amenity photos. Pool, lobby,
  // grounds, exterior, view, and logo-style images are intentionally
  // reused across many hosts in the same resort; they are not reliable
  // duplicate-listing evidence.
  const INTERIOR_CATEGORIES = new Set([
    "Bedrooms", "Bathrooms", "Kitchen", "Living Areas", "Dining", "Outdoor & Lanai",
  ]);
  const effectiveCategory = (l: PhotoCandidate) => l.userCategory ?? l.category ?? "";
  const privateUnitPhotos = visible.filter((l) => !isCommunityOrSharedPhotoCandidate({
    folder,
    filename: l.filename,
    category: effectiveCategory(l),
    label: l.userLabel ?? l.label,
  }));
  const interior = privateUnitPhotos.filter((l) => INTERIOR_CATEGORIES.has(effectiveCategory(l)));
  // dHash de-dup so the maxPhotos Lens calls cover DISTINCT rooms, not near-identical
  // shots of the same room — maximises coverage (and confidence in a "clean" verdict)
  // per credit. Photos without a perceptual hash are kept (can't compare them).
  const dedupeByHash = (cands: PhotoCandidate[]): PhotoCandidate[] => {
    const kept: PhotoCandidate[] = [];
    for (const c of cands) {
      const h = c.perceptualHash;
      if (!h || !kept.some((k) => k.perceptualHash && isDuplicateHash(h, k.perceptualHash))) kept.push(c);
    }
    return kept;
  };
  const interiorDistinct = dedupeByHash(interior);
  const privateDistinct = dedupeByHash(privateUnitPhotos);
  const heros = (interiorDistinct.length >= PHOTOS_PER_FOLDER ? interiorDistinct : privateDistinct).slice(0, maxPhotos);

  if (heros.length === 0) {
    result.errorMessage = "No visible photos in folder";
    await persist(result);
    return result;
  }

  // Tally per-host:
  //  - photoHitCount  = how many of OUR photos produced at least one FULLY-VERIFIED match
  //    (community-compatible AND unit number in the listing's page text). >= MIN_MATCHES → found.
  //  - photoStrongCount = how many of OUR distinct photos produced at least one STRONG,
  //    community-compatible match on this host, WHETHER OR NOT the unit number was confirmed in
  //    page text. >= MULTI_PHOTO_AGREEMENT → found (the Balanced multi-photo-agreement signal;
  //    photoStrongCount is always >= photoHitCount since a verified hit is also strong+community).
  //  - matches = (our photo URL → their listing URL) pairs for the dashboard tooltip.
  const tally: Record<"airbnb" | "vrbo" | "booking", { photoHitCount: number; photoStrongCount: number; matches: Match[] }> = {
    airbnb:  { photoHitCount: 0, photoStrongCount: 0, matches: [] },
    vrbo:    { photoHitCount: 0, photoStrongCount: 0, matches: [] },
    booking: { photoHitCount: 0, photoStrongCount: 0, matches: [] },
  };
  let anyLensSucceeded = false;
  const lensErrors: string[] = [];

  // Verification tokens prefer the hand-maintained FOLDER_UNIT_TOKENS
  // map, then the folder-name hint, then the latest replacement-unit
  // swap. The dynamic swap path lets promoted draft folders like
  // draft-2-unit-a verify against Unit A5 without hardcoding every
  // temporary draft folder in the static map.
  // "Our own" listings — Guesty-authorized URLs for every property we
  // manage. A Lens hit that resolves to one of these is us, not a
  // thief, and gets suppressed before the tally. Cached across runs
  // inside authorized-urls.ts; empty set if Guesty is unreachable
  // (scanner proceeds without suppression rather than silently
  // skipping).
  const authorizedUrls = await getAuthorizedChannelUrls();
  // Per-run cache: maps listing URL → boolean. The first verify call
  // on a URL pays the SERP cost(s); later checks reuse the answer
  // even when a different photo surfaces the same listing.
  const verifyCache = new Map<string, boolean>();
  // Cap verifications per (photo × host) so a Lens response with 30
  // airbnb.com hits doesn't burn the SERP budget. 3 is plenty — the
  // tally threshold is ≥ 2 photos matching anyway.
  const MAX_VERIFY_PER_HOST_PER_PHOTO = 3;

  const verify = async (listingUrl: string, title = "", source = ""): Promise<boolean> => {
    if (!listingMatchesFolderCommunity(title, source, listingUrl, communityCtx)) return false;
    if (allowUnverifiedStandalone) return true;
    if (!verifyTokens || verifyTokens.length === 0) return false;
    const cached = verifyCache.get(listingUrl);
    if (cached !== undefined) return cached;
    // Accept if the URL's page mentions ANY of the unit tokens. Stop
    // at the first hit so we don't burn extra SERPs on already-
    // verified URLs.
    for (const token of verifyTokens) {
      if (await verifyUrlMentionsUnit(listingUrl, token)) {
        verifyCache.set(listingUrl, true);
        return true;
      }
    }
    verifyCache.set(listingUrl, false);
    return false;
  };

  for (const label of heros) {
    const photoUrl = `${PUBLIC_HOST}/photos/${folder}/${label.filename}`;
    result.photosChecked += 1;
    result.lensCalls += 1;
    const lens = await callGoogleLens(photoUrl);
    if (!lens.ok) {
      lensErrors.push(lens.error);
      continue;
    }
    const matches = lens.rows;
    anyLensSucceeded = true;

    for (const hostKey of HOST_KEYS) {
      const hits = matches.filter((m: any) => {
        const link = String(m.link || "").toLowerCase();
        if (otaPlatformForUrl(link) !== hostKey) return false;
        if (!isStrongLensMatch(m, String(m.__lensSource || ""), Number(m.__lensPosition ?? m.position ?? 999))) return false;
        // Drop OUR own listings right at the filter stage so they
        // never consume a verification budget slot below. A Lens hit
        // on our published Airbnb/VRBO/Booking URL is the expected
        // outcome — not a theft signal. Checked against the canonical
        // URL candidates too, so our own listing served from a
        // regional domain (airbnb.co.uk, abritel.fr) stays suppressed.
        if (canonicalOtaUrlCandidates(link).some((c) => isAuthorizedUrl(c, authorizedUrls))) return false;
        return true;
      });
      if (hits.length === 0) continue;
      // Verify the STRONGEST hits first so the per-photo verification budget is never spent on
      // weaker matches while a high-confidence repost ranked further down goes unverified.
      hits.sort((a: any, b: any) =>
        lensMatchConfidence(b, String(b.__lensSource || ""), Number(b.__lensPosition ?? b.position ?? 999)) -
        lensMatchConfidence(a, String(a.__lensSource || ""), Number(a.__lensPosition ?? a.position ?? 999)),
      );
      // Cross-validate up to MAX_VERIFY_PER_HOST_PER_PHOTO hits. A photo counts as a VERIFIED match
      // when at least one hit is community-compatible AND mentions our unit number; it counts toward
      // multi-photo AGREEMENT when at least one hit is strong + community-compatible (unit text not
      // required). Multi-photo agreement (>= MULTI_PHOTO_AGREEMENT distinct photos) is the Balanced
      // fallback that catches reposts which hide the unit number from indexed page text.
      const verifiedHits: Match[] = [];
      const strongHits: Match[] = [];
      for (const h of hits.slice(0, MAX_VERIFY_PER_HOST_PER_PHOTO)) {
        const link = String(h.link || "");
        if (!link) continue;
        const title = String(h.title || "");
        const source = String(h.source || "");
        const communityOk = listingMatchesFolderCommunity(title, source, link, communityCtx);
        if (communityOk) strongHits.push({ photoUrl, listingUrl: link, title, source });
        const ok = await verify(link, title, source);
        if (ok) verifiedHits.push({ photoUrl, listingUrl: link, title, source });
      }
      if (verifiedHits.length > 0) {
        tally[hostKey].photoHitCount += 1;
        tally[hostKey].matches.push(...verifiedHits);
      } else if (strongHits.length > 0) {
        // No unit-text-verified hit, but a strong community-compatible one — keep a single piece of
        // evidence so a found-by-agreement verdict still shows the operator a listing URL.
        tally[hostKey].matches.push(strongHits[0]);
      }
      if (strongHits.length > 0) tally[hostKey].photoStrongCount += 1;
    }
  }

  // Per-platform photo verdict. Address detection is a SEPARATE leg (its own columns), so this
  // judges photos only — multi-photo agreement (>= MULTI_PHOTO_AGREEMENT strong photos) lets a
  // repost that hides the unit number from page text still flag as "found".
  const finalize = (key: "airbnb" | "vrbo" | "booking"): PlatformStatus =>
    decidePlatformStatus({
      photoHitCount: tally[key].photoHitCount,
      photoStrongCount: tally[key].photoStrongCount,
      hasAddressHit: false,
      anyLensSucceeded,
      minMatches: MIN_MATCHES,
      agreementThreshold: MULTI_PHOTO_AGREEMENT,
    });

  result.airbnbStatus  = finalize("airbnb");
  result.vrboStatus    = finalize("vrbo");
  result.bookingStatus = finalize("booking");
  if (!anyLensSucceeded && lensErrors.length > 0) {
    const distinct = Array.from(new Set(lensErrors)).slice(0, 2);
    result.errorMessage = `Lens unavailable for selected unit photos: ${distinct.join("; ")}`;
  }
  result.airbnbMatches  = tally.airbnb.matches.slice(0, 20);
  result.vrboMatches    = tally.vrbo.matches.slice(0, 20);
  result.bookingMatches = tally.booking.matches.slice(0, 20);

  // Address-on-OTA leg: does this unit's street address surface on a real
  // OTA listing page? (A relist can swap photos but not the address.) One
  // SERP per platform; unit-number gated unless this is a standalone
  // unique-address listing. Runs alongside the photo leg; leaving statuses
  // "unknown" when disabled or no street is known is correct (not "clean").
  if (!PHOTO_LISTING_ADDRESS_SCAN_DISABLED) {
    try {
      const addrCtx = await folderAddressContext(folder);
      if (addrCtx) {
        // Unit-number gate for the address leg, separate cache from the
        // photo leg's community-aware verify (street+city already proves
        // the resort, so we only need the unit-number confirmation here).
        const addressVerifyCache = new Map<string, boolean>();
        const verifyUnitForAddress = async (url: string): Promise<boolean> => {
          const cached = addressVerifyCache.get(url);
          if (cached !== undefined) return cached;
          for (const token of verifyTokens) {
            if (await verifyUrlMentionsUnit(url, token)) {
              addressVerifyCache.set(url, true);
              return true;
            }
          }
          addressVerifyCache.set(url, false);
          return false;
        };
        const addr = await checkAddressOnOtas(addrCtx, {
          authorizedUrls,
          allowUnverifiedStandalone,
          verifyUnit: verifyUnitForAddress,
        });
        result.airbnbAddressStatus  = addr.statuses.airbnb;
        result.vrboAddressStatus    = addr.statuses.vrbo;
        result.bookingAddressStatus = addr.statuses.booking;
        result.addressMatches = addr.matches.slice(0, 15);
        if (!addr.anySucceeded && addr.errors.length > 0 && !result.errorMessage) {
          const distinct = Array.from(new Set(addr.errors)).slice(0, 2);
          result.errorMessage = `Address search unavailable: ${distinct.join("; ")}`;
        }
      }
    } catch (e: any) {
      console.error(`[photo-listing-scanner] address leg failed for ${folder}: ${e?.message ?? e}`);
    }
  }

  // A scan where NO photo returned a Lens result is inconclusive by construction — it is not
  // evidence that a previously-detected repost vanished. Flag it so persist() preserves prior
  // non-unknown statuses regardless of whether the underlying error string happened to match
  // isProviderUnavailableError (a 401/403/5xx can carry "SearchAPI" without the matched substrings).
  await persist(result, priorRow, { inconclusive: !anyLensSucceeded });
  await alertOnStateWorsen(prior, result);
  return result;
}

async function persist(
  r: ScanResult,
  prior?: PhotoListingCheck | null,
  opts: { inconclusive?: boolean } = {},
): Promise<PhotoListingCheck> {
  // Provider outages/quota errors — and ANY scan where no Lens call succeeded — are inconclusive, not
  // evidence that previous matches disappeared. Preserve the last known platform statuses so one
  // exhausted/failed SearchAPI run cannot repaint the dashboard from red/green to gray. (Previously this
  // keyed only off isProviderUnavailableError's substring match, so an unrecognized 401/403/5xx could
  // silently downgrade a confirmed "found" to "unknown".)
  if (prior && (isProviderUnavailableError(r.errorMessage) || opts.inconclusive)) {
    if (r.airbnbStatus === "unknown") {
      r.airbnbStatus = prior.airbnbStatus as PlatformStatus;
      r.airbnbMatches = parseStoredMatches(prior.airbnbMatches);
    }
    if (r.vrboStatus === "unknown") {
      r.vrboStatus = prior.vrboStatus as PlatformStatus;
      r.vrboMatches = parseStoredMatches(prior.vrboMatches);
    }
    if (r.bookingStatus === "unknown") {
      r.bookingStatus = prior.bookingStatus as PlatformStatus;
      r.bookingMatches = parseStoredMatches(prior.bookingMatches);
    }
    // Same inconclusive-outage rule for the address leg: don't repaint a
    // known red/green address verdict to gray just because today's SERP
    // failed. addressMatches is restored when we fall back to the prior
    // status so the UI keeps the cited URLs.
    let restoredAddress = false;
    if (r.airbnbAddressStatus === "unknown" && (prior as any).airbnbAddressStatus) {
      r.airbnbAddressStatus = (prior as any).airbnbAddressStatus as PlatformStatus;
      restoredAddress = true;
    }
    if (r.vrboAddressStatus === "unknown" && (prior as any).vrboAddressStatus) {
      r.vrboAddressStatus = (prior as any).vrboAddressStatus as PlatformStatus;
      restoredAddress = true;
    }
    if (r.bookingAddressStatus === "unknown" && (prior as any).bookingAddressStatus) {
      r.bookingAddressStatus = (prior as any).bookingAddressStatus as PlatformStatus;
      restoredAddress = true;
    }
    if (restoredAddress && r.addressMatches.length === 0) {
      r.addressMatches = parseStoredAddressMatches((prior as any).addressMatches);
    }
    r.errorMessage = `${r.errorMessage} (kept previous status because the provider failure was inconclusive)`;
  }

  return storage.upsertPhotoListingCheck({
    photoFolder: r.folder,
    airbnbStatus:  r.airbnbStatus,
    vrboStatus:    r.vrboStatus,
    bookingStatus: r.bookingStatus,
    airbnbMatches:  r.airbnbMatches.length  ? JSON.stringify(r.airbnbMatches)  : null,
    vrboMatches:    r.vrboMatches.length    ? JSON.stringify(r.vrboMatches)    : null,
    bookingMatches: r.bookingMatches.length ? JSON.stringify(r.bookingMatches) : null,
    airbnbAddressStatus:  r.airbnbAddressStatus,
    vrboAddressStatus:    r.vrboAddressStatus,
    bookingAddressStatus: r.bookingAddressStatus,
    addressMatches: r.addressMatches.length ? JSON.stringify(r.addressMatches) : null,
    photosChecked: r.photosChecked,
    lensCalls:     r.lensCalls,
    errorMessage:  r.errorMessage ?? null,
  });
}

function parseStoredAddressMatches(raw?: string | null): AddressMatch[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Address-ONLY re-check (2026-06-30). Runs JUST the address-on-OTA leg for a folder and merges the
// result into the existing row, WITHOUT touching the photo verdict or re-spending the (much costlier,
// up to PHOTO_AUDIT_MAX_PHOTOS) reverse-image Lens calls. Why this exists: the address leg shipped in
// PR #858, but every folder last scanned BEFORE that deploy still carries the default "unknown"
// address status and reads as "inconclusive" on the dashboard until the next DEEP cron happens to
// re-scan it (7-day cadence). A full deep re-scan just to populate the address columns would waste
// ~30 Lens calls per folder; this backfill spends only the ~3-6 SERPs the address leg needs and
// preserves the existing photo result verbatim. Returns null (no write) when the address leg is
// disabled, there's no prior photo row, the folder has no unit identity, or no street is resolvable.
export async function runAddressOnlyCheckForFolder(folder: string): Promise<ScanResult | null> {
  if (PHOTO_LISTING_ADDRESS_SCAN_DISABLED || !SEARCHAPI_KEY) return null;
  const prior = await storage.getPhotoListingCheckByFolder(folder);
  if (!prior) return null; // first-time scan belongs to runPhotoListingCheckForFolder (it owns photos)
  const rawVerifyTokens = await dynamicVerificationTokensForFolder(folder);
  if (!rawVerifyTokens || rawVerifyTokens.length === 0) return null;
  const allowUnverifiedStandalone = rawVerifyTokens.includes(STANDALONE_DRAFT_NO_UNIT_TOKEN);
  const verifyTokens = rawVerifyTokens.filter((token) => token !== STANDALONE_DRAFT_NO_UNIT_TOKEN);
  const addrCtx = await folderAddressContext(folder);
  if (!addrCtx) return null; // no resolvable street — leave the row's address columns as-is

  const authorizedUrls = await getAuthorizedChannelUrls();
  const addressVerifyCache = new Map<string, boolean>();
  const verifyUnitForAddress = async (url: string): Promise<boolean> => {
    const cached = addressVerifyCache.get(url);
    if (cached !== undefined) return cached;
    for (const token of verifyTokens) {
      if (await verifyUrlMentionsUnit(url, token)) {
        addressVerifyCache.set(url, true);
        return true;
      }
    }
    addressVerifyCache.set(url, false);
    return false;
  };

  const addr = await checkAddressOnOtas(addrCtx, {
    authorizedUrls,
    allowUnverifiedStandalone,
    verifyUnit: verifyUnitForAddress,
  });

  // Outage preservation for the address leg: if every platform's SERP failed, keep the prior address
  // statuses/matches rather than repainting a known red/green to gray.
  const priorAddr = {
    airbnb:  (prior as any).airbnbAddressStatus  as PlatformStatus | undefined,
    vrbo:    (prior as any).vrboAddressStatus    as PlatformStatus | undefined,
    booking: (prior as any).bookingAddressStatus as PlatformStatus | undefined,
  };
  const pick = (fresh: PlatformStatus, p?: PlatformStatus): PlatformStatus =>
    (!addr.anySucceeded && fresh === "unknown" && p) ? p : fresh;

  const addressMatches = (!addr.anySucceeded && addr.matches.length === 0)
    ? parseStoredAddressMatches((prior as any).addressMatches)
    : addr.matches.slice(0, 15);

  // Merge: keep the prior PHOTO verdict + matches + photo error verbatim; write only the address leg.
  await storage.upsertPhotoListingCheck({
    photoFolder: folder,
    airbnbStatus:  prior.airbnbStatus,
    vrboStatus:    prior.vrboStatus,
    bookingStatus: prior.bookingStatus,
    airbnbMatches:  prior.airbnbMatches  ?? null,
    vrboMatches:    prior.vrboMatches    ?? null,
    bookingMatches: prior.bookingMatches ?? null,
    airbnbAddressStatus:  pick(addr.statuses.airbnb,  priorAddr.airbnb),
    vrboAddressStatus:    pick(addr.statuses.vrbo,    priorAddr.vrbo),
    bookingAddressStatus: pick(addr.statuses.booking, priorAddr.booking),
    addressMatches: addressMatches.length ? JSON.stringify(addressMatches) : null,
    photosChecked: prior.photosChecked ?? 0,
    lensCalls: prior.lensCalls ?? 0, // address-only — spent no NEW Lens calls
    errorMessage: prior.errorMessage ?? null,
  });

  return {
    folder,
    airbnbStatus:  prior.airbnbStatus  as PlatformStatus,
    vrboStatus:    prior.vrboStatus    as PlatformStatus,
    bookingStatus: prior.bookingStatus as PlatformStatus,
    airbnbMatches: [], vrboMatches: [], bookingMatches: [],
    airbnbAddressStatus:  pick(addr.statuses.airbnb,  priorAddr.airbnb),
    vrboAddressStatus:    pick(addr.statuses.vrbo,    priorAddr.vrbo),
    bookingAddressStatus: pick(addr.statuses.booking, priorAddr.booking),
    addressMatches,
    photosChecked: prior.photosChecked ?? 0,
    lensCalls: 0,
  };
}

// Backfill the address leg across folders whose address status is still "unknown" (default: every such
// folder with an existing photo row). Cheap relative to a deep re-scan — one address-only check per
// folder. Sequential with a pause to stay under SearchAPI rate limits. Fire-and-forget from the admin
// endpoint; returns a small tally for the manual/smoke caller.
export async function runAddressBackfill(
  opts: { folders?: string[]; pauseMs?: number; max?: number } = {},
): Promise<{ scanned: number; updated: number; found: number }> {
  let folders = opts.folders;
  if (!folders) {
    const rows = await storage.getAllPhotoListingChecks();
    folders = rows
      .filter((r) =>
        [(r as any).airbnbAddressStatus, (r as any).vrboAddressStatus, (r as any).bookingAddressStatus]
          .every((s) => (s ?? "unknown") === "unknown"),
      )
      .map((r) => r.photoFolder);
  }
  const pause = opts.pauseMs ?? 1200;
  let scanned = 0, updated = 0, found = 0;
  for (let i = 0; i < folders.length; i++) {
    if (opts.max && scanned >= opts.max) break;
    const f = folders[i];
    try {
      const r = await runAddressOnlyCheckForFolder(f);
      scanned++;
      if (r) {
        updated++;
        const anyFound = [r.airbnbAddressStatus, r.vrboAddressStatus, r.bookingAddressStatus].includes("found");
        if (anyFound) found++;
        console.error(`[photo-listing-scanner] address-backfill ${f}: a=${r.airbnbAddressStatus} v=${r.vrboAddressStatus} b=${r.bookingAddressStatus}`);
      }
    } catch (e: any) {
      console.error(`[photo-listing-scanner] address-backfill ${f} crashed: ${e?.message}`);
    }
    if (i < folders.length - 1) await new Promise((rr) => setTimeout(rr, pause));
  }
  console.error(`[photo-listing-scanner] address-backfill done: ${updated}/${scanned} updated, ${found} found`);
  return { scanned, updated, found };
}

// Returns folders that have photos (label rows or files on disk) AND
// can be meaningfully cross-validated. Replacement/draft folders get
// their verification unit from the latest unit-swap row, so promoted
// drafts can be checked without adding temporary folder names to the
// static FOLDER_UNIT_TOKENS map.
export async function listScanableFolders(): Promise<string[]> {
  const rows = await storage.getAllPhotoLabels();
  const set = new Set<string>();
  const foldersWithLabels = new Set<string>();
  for (const r of rows) {
    foldersWithLabels.add(r.folder);
    if (isScannableFolder(r.folder)) set.add(r.folder);
  }

  // The dashboard Photo Match column is keyed from unit-builder-data,
  // not from photo_labels. Some long-lived static folders have photos
  // on disk but no DB label rows yet, which made the dashboard show
  // permanent A?/V?/B? badges because the scheduler never discovered
  // them. Seed the scan universe from the same unit folders the
  // dashboard aggregates, then let folderHasDiskPhotos decide whether
  // there is anything to scan.
  for (const builder of unitBuilderData) {
    for (const unit of builder.units) {
      if (unit.photoFolder && isScannableFolder(unit.photoFolder)) {
        set.add(unit.photoFolder);
      }
    }
  }

  const swaps = await storage.getAllUnitSwaps();
  const seenSwaps = new Set<string>();
  for (const swap of swaps) {
    const key = `${swap.propertyId}:${swap.oldUnitId}`;
    if (seenSwaps.has(key)) continue;
    seenSwaps.add(key);
    const builder = unitBuilderData.find((b) => b.propertyId === swap.propertyId);
    const oldUnit = builder?.units.find((unit) => unit.id === swap.oldUnitId);
    if (oldUnit?.photoFolder) set.delete(oldUnit.photoFolder);
    set.add(replacementPhotoFolderForUnit(swap.propertyId, swap.oldUnitId));
    const draft = String(swap.oldUnitId).match(/^draft(\d+)-unit-([a-z0-9_-]+)$/i);
    if (draft) set.add(`draft-${draft[1]}-unit-${draft[2]}`);
  }

  // Published drafts can have valid local photo folders without any
  // photo-label rows and without a unit-swap row. Santa Maria hit this
  // path as a single listing; some draft listings hit the same shape as a
  // published combo draft with draft-1-unit-a / draft-1-unit-b photos.
  // Seed these folders from drafts so the scheduler and dashboard use
  // the same scan universe.
  try {
    const drafts = await storage.getCommunityDrafts();
    for (const draft of drafts) {
      if ((draft as any)?.singleListing !== true && (draft as any)?.status !== "published") continue;
      const folder = typeof (draft as any)?.unit1PhotoFolder === "string" && (draft as any).unit1PhotoFolder.trim()
        ? (draft as any).unit1PhotoFolder.trim()
        : `draft-${draft.id}-unit-a`;
      if (isScannableFolder(folder)) set.add(folder);
      if ((draft as any)?.singleListing !== true) {
        const unit2Folder = typeof (draft as any)?.unit2PhotoFolder === "string" && (draft as any).unit2PhotoFolder.trim()
          ? (draft as any).unit2PhotoFolder.trim()
          : `draft-${draft.id}-unit-b`;
        if (isScannableFolder(unit2Folder)) set.add(unit2Folder);
      }
    }
  } catch (e: any) {
    console.error(`[photo-listing-scanner] failed to enumerate imported draft folders: ${e?.message ?? e}`);
  }

  const out: string[] = [];
  for (const folder of set) {
    const tokens = await dynamicVerificationTokensForFolder(folder);
    if (!tokens || tokens.length === 0) continue;
    if (foldersWithLabels.has(folder) || await folderHasDiskPhotos(folder)) out.push(folder);
  }
  return out.sort();
}

// Run one folder at a time, pausing between to avoid SearchAPI rate
// limits. Used by both the manual "Run now" endpoint (with a specific
// folder list) and the weekly scheduler (with the stale-folder list).
// Sum of Lens calls spent TODAY across all photo-listing scans. Each scan upserts one row
// per folder with that scan's lensCalls + checkedAt, so this is durable across deploys (the
// in-memory counter would reset on every redeploy). Powers the daily circuit-breaker + the
// "credits used today" indicator. With skip-if-fresh each folder spends ~once/day, so re-scans
// don't inflate the sum.
export async function getLensCallsUsedToday(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  try {
    const rows = await storage.getAllPhotoListingChecks();
    return rows.reduce((sum, r) => {
      const at = r.checkedAt ? new Date(r.checkedAt as any).getTime() : 0;
      return at >= startOfDay.getTime() ? sum + (Number(r.lensCalls) || 0) : sum;
    }, 0);
  } catch {
    return 0;
  }
}

export async function getPhotoCheckBudget(): Promise<{ used: number; cap: number | null; remaining: number | null }> {
  const used = await getLensCallsUsedToday();
  // cap === null → unlimited (the default since the 200/day cap was removed). remaining null means
  // "no ceiling", which the endpoint and client treat as "never budget-blocked".
  if (PHOTO_CHECK_DAILY_CAP == null) return { used, cap: null, remaining: null };
  return { used, cap: PHOTO_CHECK_DAILY_CAP, remaining: Math.max(0, PHOTO_CHECK_DAILY_CAP - used) };
}

export async function runPhotoListingCheckForFolders(
  folders: string[],
  opts: { pauseMs?: number; maxPhotos?: number; budgetCap?: number } = {},
): Promise<ScanResult[]> {
  const pause = opts.pauseMs ?? 1500;
  const results: ScanResult[] = [];
  for (let i = 0; i < folders.length; i++) {
    const f = folders[i];
    // Circuit-breaker: if today's Lens spend already hit the cap, stop before this folder.
    // Scans run sequentially, so the DB sum reflects every folder already done this batch.
    if (opts.budgetCap && opts.budgetCap > 0) {
      const used = await getLensCallsUsedToday();
      if (used >= opts.budgetCap) {
        console.error(`[photo-listing-scanner] daily Lens budget ${used}/${opts.budgetCap} reached — stopping batch, ${folders.length - i} folder(s) skipped`);
        break;
      }
    }
    try {
      const r = await runPhotoListingCheckForFolder(f, { maxPhotos: opts.maxPhotos });
      results.push(r);
      console.error(
        `[photo-listing-scanner] ${f}: airbnb=${r.airbnbStatus}, vrbo=${r.vrboStatus}, booking=${r.bookingStatus} (${r.photosChecked} photos, ${r.lensCalls} lens calls)`,
      );
    } catch (e: any) {
      console.error(`[photo-listing-scanner] ${f} crashed: ${e?.message}`);
    }
    if (i < folders.length - 1) await new Promise((r) => setTimeout(r, pause));
  }
  return results;
}

// Background tick. Runs at boot and then every hour (the hourly tick is a
// cheap staleness check against the DB — only folders past the cadence
// window actually spend Lens calls). For each scanable folder whose last
// check is older than `maxAgeMs` (default: 7 days → WEEKLY cadence, per
// the operator's 2026-06-26 "ensure that this is cron job once a week"
// request; override with PHOTO_LISTING_SCAN_INTERVAL_DAYS), runs a fresh
// check. 2026-06-29: each stale folder now gets a DEEP scan
// (PHOTO_LISTING_SCAN_MAX_PHOTOS, default = the full deduped interior
// gallery) PLUS the address-on-OTA leg, so the unattended weekly audit has
// the same ~95-100% recall as the on-demand deep button — not the old
// 3-photo screen. Budgeted at up to PHOTO_LISTING_SCAN_MAX_PHOTOS Lens
// calls + ~3 verification SERPs + 3 address SERPs per folder; tune depth
// via PHOTO_LISTING_SCAN_MAX_PHOTOS. The 7-day default supersedes the
// prior 24h daily cadence; the dashboard "Scanned" column shows each
// property's most-recent folder checkedAt so a missed weekly run is
// visible (it renders amber once older than the cadence).
export function startPhotoListingScheduler(maxAgeMs = PHOTO_LISTING_SCAN_MAX_AGE_MS, tickMs = 60 * 60 * 1000): void {
  const tick = async () => {
    try {
      const known = await listScanableFolders();
      const stale = await storage.getStalePhotoListingFolders(maxAgeMs, known);
      if (stale.length === 0) {
        console.error(`[photo-listing-scanner] tick: ${known.length} folders, all fresh`);
        return;
      }
      console.error(`[photo-listing-scanner] tick: ${stale.length}/${known.length} folders stale — scanning (deep, maxPhotos=${PHOTO_LISTING_SCAN_MAX_PHOTOS})`);
      await runPhotoListingCheckForFolders(stale, { maxPhotos: PHOTO_LISTING_SCAN_MAX_PHOTOS });
    } catch (e: any) {
      console.error(`[photo-listing-scanner] scheduler crashed: ${e?.message}`);
    }
  };
  // Cleanup pass on boot: ack legacy alerts that are community-photo
  // false positives so they stop showing in the dashboard. Runs ONCE at
  // startup; future scans won't recreate them because the hero-pick
  // step now prefers interior categories.
  setTimeout(() => { void acknowledgeAmenityFalsePositives(); }, 10_000);
  // Kick once after a 30s boot delay so DB and photo routes are up.
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, tickMs);
}

// One-time cleanup: acknowledge unacknowledged photo-listing alerts that
// are community-photo false positives. Two cases get acked:
//   1. The alert's photoFolder is community-* — these shouldn't exist
//      after the "skip community folders" change but legacy rows linger.
//   2. Every hero photo cited in matchedUrls has a non-interior category
//      (Building Exterior / Views / Other / Reject / community-amenity
//      vocabulary). Per the operator: "they will always find those" —
//      shared resort amenity photos legitimately appear on every host
//      at the same complex.
// Alerts with at least one interior-category match are left alone — those
// represent the actual signal we care about (someone copied a unique
// bedroom / kitchen / living-area shot).
async function acknowledgeAmenityFalsePositives(): Promise<void> {
  const INTERIOR = new Set(["Bedrooms", "Bathrooms", "Kitchen", "Living Areas", "Dining", "Outdoor & Lanai"]);
  try {
    const open = await storage.getUnacknowledgedPhotoListingAlerts();
    if (open.length === 0) return;
    let acked = 0;
    // Build a folder → (filename → category) lookup once. Cheaper than
    // querying photoLabels per alert when many alerts share folders.
    // Honors userCategory (human override) over category (Claude's pick).
    const foldersInvolved = Array.from(new Set(open.map((r) => r.photoFolder)));
    const labelLookup = new Map<string, Map<string, string>>();
    for (const f of foldersInvolved) {
      const rows = await storage.getPhotoLabelsByFolder(f);
      labelLookup.set(f, new Map(rows.map((r) => [r.filename, r.userCategory ?? r.category ?? ""])));
    }
    for (const alert of open) {
      if (alert.photoFolder.startsWith("community-")) {
        await storage.acknowledgePhotoListingAlert(alert.id);
        acked++;
        continue;
      }
      let matches: Array<{ photoUrl?: string }> = [];
      try { matches = JSON.parse(alert.matchedUrls ?? "[]"); } catch { /* ignore */ }
      if (matches.length === 0) continue;
      const folderLabels = labelLookup.get(alert.photoFolder);
      if (!folderLabels) continue;
      // Extract our filename from each photoUrl. Skip matches we can't
      // resolve (don't let an unknown photo flip an alert into "all
      // amenity" — better to err on keeping the alert open).
      const categories: string[] = [];
      for (const m of matches) {
        if (typeof m?.photoUrl !== "string") continue;
        const filename = m.photoUrl.split("/").pop()?.split("?")[0];
        if (!filename) continue;
        const cat = folderLabels.get(filename);
        if (!cat) { categories.push("__unknown__"); continue; }
        categories.push(cat);
      }
      if (categories.length === 0) continue;
      const hasInterior = categories.some((c) => INTERIOR.has(c));
      if (!hasInterior) {
        await storage.acknowledgePhotoListingAlert(alert.id);
        acked++;
      }
    }
    if (acked > 0) {
      console.error(`[photo-listing-scanner] startup cleanup: acked ${acked}/${open.length} amenity false-positive alerts`);
    }
  } catch (e: any) {
    console.error(`[photo-listing-scanner] startup cleanup failed: ${e?.message ?? e}`);
  }
}
