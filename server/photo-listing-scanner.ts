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
//   - MIN_MATCHES = 2. A single match can be a stock-photo false
//     positive (generic palm-tree exterior matches thousands of
//     listings). Two or more of OUR distinct photos hitting the same
//     host is much harder to explain away.
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
import { isScannableFolder, verificationTokensForFolder } from "@shared/photo-folder-utils";
import { getAuthorizedChannelUrls, isAuthorizedUrl } from "./authorized-urls";

const SEARCHAPI_KEY = process.env.SEARCHAPI_API_KEY;
const PUBLIC_HOST = (() => {
  if (process.env.PUBLIC_PHOTO_BASE_URL) return process.env.PUBLIC_PHOTO_BASE_URL.replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return ""; // Dev: Lens won't be able to reach localhost photos.
})();

const HOSTS: Array<{ key: "airbnb" | "vrbo" | "booking"; host: string }> = [
  { key: "airbnb",  host: "airbnb.com" },
  { key: "vrbo",    host: "vrbo.com" },
  { key: "booking", host: "booking.com" },
];

const PHOTOS_PER_FOLDER = 3;
const MIN_MATCHES = 2;

export type PlatformStatus = "clean" | "found" | "unknown";
export type Match = { photoUrl: string; listingUrl: string; title: string; source: string };

export type ScanResult = {
  folder: string;
  airbnbStatus: PlatformStatus;
  vrboStatus: PlatformStatus;
  bookingStatus: PlatformStatus;
  airbnbMatches: Match[];
  vrboMatches: Match[];
  bookingMatches: Match[];
  photosChecked: number;
  lensCalls: number;
  errorMessage?: string;
};

async function callGoogleLens(imageUrl: string): Promise<any[] | null> {
  if (!SEARCHAPI_KEY) return null;
  try {
    const resp = await fetch(
      `https://www.searchapi.io/api/v1/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SEARCHAPI_KEY}`,
    );
    if (!resp.ok) {
      console.error(`[photo-listing-scanner] Lens HTTP ${resp.status} for ${imageUrl}`);
      return null;
    }
    const data = await resp.json() as any;
    // SearchAPI returns visual_matches; fall back to organic_results.
    const matches = data.visual_matches || data.organic_results || [];
    return Array.isArray(matches) ? matches : [];
  } catch (e: any) {
    console.error(`[photo-listing-scanner] Lens error for ${imageUrl}: ${e?.message}`);
    return null;
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
  const n = unitHint.trim();
  if (!n || !url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.replace(/^www\./, "");
  // Strip file extensions (.html, .zh-cn.html) and trailing slashes so
  // Google indexes the listing as one canonical path.
  const pathClean = parsed.pathname.replace(/\.[a-z0-9.-]+$/i, "").replace(/\/+$/, "");
  if (!pathClean) return false;
  const markers = [`"Unit ${n}"`, `"#${n}"`, `"Apt ${n}"`, `"Suite ${n}"`].join(" OR ");
  const q = `site:${host}${pathClean} (${markers})`;
  try {
    const params = new URLSearchParams({ engine: "google", q, api_key: SEARCHAPI_KEY, num: "3" });
    const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
    if (!resp.ok) {
      console.error(`[photo-listing-scanner] verify HTTP ${resp.status} for ${url}`);
      return false;
    }
    const data = await resp.json() as any;
    return ((data.organic_results || []) as any[]).length > 0;
  } catch (e: any) {
    console.error(`[photo-listing-scanner] verify error for ${url}: ${e?.message}`);
    return false;
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

export async function runPhotoListingCheckForFolder(folder: string): Promise<ScanResult> {
  const result: ScanResult = {
    folder,
    airbnbStatus: "unknown",
    vrboStatus: "unknown",
    bookingStatus: "unknown",
    airbnbMatches: [],
    vrboMatches: [],
    bookingMatches: [],
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
  if (!isScannableFolder(folder)) {
    result.errorMessage = "Folder has no unit-number identifier — verification disabled, scan skipped to avoid false positives";
    return result;
  }

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
    await persist(result);
    return result;
  }
  if (!PUBLIC_HOST) {
    result.errorMessage = "No public host configured (PUBLIC_PHOTO_BASE_URL or RAILWAY_PUBLIC_DOMAIN)";
    await persist(result);
    return result;
  }

  const labels = await storage.getPhotoLabelsByFolder(folder);
  const visible = labels.filter((l) => !l.hidden).sort((a, b) => a.filename.localeCompare(b.filename));
  // Prefer interior categories for the hero set. "Building Exterior"
  // and "Views" shots are usually shared resort-amenity images — every
  // host at the same complex re-uses the pool / lobby / oceanfront
  // photo, so a Lens match on those is legitimate re-use, not theft.
  // We only fall back to the first-N-by-filename behavior when the
  // folder has fewer than N labeled interiors (brand-new folders that
  // haven't been through the labeler yet, or unit folders whose entire
  // gallery is exterior shots — rare).
  const INTERIOR_CATEGORIES = new Set([
    "Bedrooms", "Bathrooms", "Kitchen", "Living Areas", "Dining", "Outdoor & Lanai",
  ]);
  const effectiveCategory = (l: typeof labels[number]) => l.userCategory ?? l.category ?? "";
  const interior = visible.filter((l) => INTERIOR_CATEGORIES.has(effectiveCategory(l)));
  const heros = interior.length >= PHOTOS_PER_FOLDER
    ? interior.slice(0, PHOTOS_PER_FOLDER)
    : visible.slice(0, PHOTOS_PER_FOLDER);

  if (heros.length === 0) {
    result.errorMessage = "No visible photos in folder";
    await persist(result);
    return result;
  }

  // Tally per-host: how many of OUR photos produced at least one match
  // on this host, and the list of (our photo URL → their listing URL)
  // pairs for the UI.
  const tally: Record<"airbnb" | "vrbo" | "booking", { photoHitCount: number; matches: Match[] }> = {
    airbnb:  { photoHitCount: 0, matches: [] },
    vrbo:    { photoHitCount: 0, matches: [] },
    booking: { photoHitCount: 0, matches: [] },
  };
  let anyLensSucceeded = false;

  // Verification tokens come from `verificationTokensForFolder`,
  // which prefers the hand-maintained FOLDER_UNIT_TOKENS map (the
  // canonical claim per shared/folder-unit-map.ts) and falls back
  // to the folder-name hint for folders not in the map. A Lens hit
  // is accepted when the matched listing's page mentions ANY of
  // these tokens — this lets shared folders (one folder claimed by
  // multiple units) and folders whose name has drifted from the
  // unit number both produce real signals instead of being skipped.
  const verifyTokens = verificationTokensForFolder(folder);
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

  const verify = async (listingUrl: string): Promise<boolean> => {
    if (!verifyTokens || verifyTokens.length === 0) return true; // can't verify, accept
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
    const matches = await callGoogleLens(photoUrl);
    if (matches === null) continue;
    anyLensSucceeded = true;

    for (const host of HOSTS) {
      const hits = matches.filter((m: any) => {
        const link = String(m.link || "").toLowerCase();
        if (!link.includes(host.host)) return false;
        // Drop OUR own listings right at the filter stage so they
        // never consume a verification budget slot below. A Lens hit
        // on our published Airbnb/VRBO/Booking URL is the expected
        // outcome — not a theft signal.
        if (isAuthorizedUrl(link, authorizedUrls)) return false;
        return true;
      });
      if (hits.length === 0) continue;
      // Cross-validate up to MAX_VERIFY_PER_HOST_PER_PHOTO hits.
      // A photo counts as "matched this platform" only when at least
      // one of its verified hits mentions our unit number.
      const verifiedHits: Match[] = [];
      for (const h of hits.slice(0, MAX_VERIFY_PER_HOST_PER_PHOTO)) {
        const link = String(h.link || "");
        if (!link) continue;
        const ok = await verify(link);
        if (!ok) continue;
        verifiedHits.push({
          photoUrl,
          listingUrl: link,
          title:  String(h.title  || ""),
          source: String(h.source || ""),
        });
      }
      if (verifiedHits.length > 0) {
        tally[host.key].photoHitCount += 1;
        tally[host.key].matches.push(...verifiedHits);
      }
    }
  }

  const finalize = (key: "airbnb" | "vrbo" | "booking"): PlatformStatus => {
    if (!anyLensSucceeded) return "unknown";
    return tally[key].photoHitCount >= MIN_MATCHES ? "found" : "clean";
  };

  result.airbnbStatus  = finalize("airbnb");
  result.vrboStatus    = finalize("vrbo");
  result.bookingStatus = finalize("booking");
  result.airbnbMatches  = tally.airbnb.matches.slice(0, 20);
  result.vrboMatches    = tally.vrbo.matches.slice(0, 20);
  result.bookingMatches = tally.booking.matches.slice(0, 20);

  await persist(result);
  await alertOnStateWorsen(prior, result);
  return result;
}

async function persist(r: ScanResult): Promise<PhotoListingCheck> {
  return storage.upsertPhotoListingCheck({
    photoFolder: r.folder,
    airbnbStatus:  r.airbnbStatus,
    vrboStatus:    r.vrboStatus,
    bookingStatus: r.bookingStatus,
    airbnbMatches:  r.airbnbMatches.length  ? JSON.stringify(r.airbnbMatches)  : null,
    vrboMatches:    r.vrboMatches.length    ? JSON.stringify(r.vrboMatches)    : null,
    bookingMatches: r.bookingMatches.length ? JSON.stringify(r.bookingMatches) : null,
    photosChecked: r.photosChecked,
    lensCalls:     r.lensCalls,
    errorMessage:  r.errorMessage ?? null,
  });
}

// Returns the list of folders that have any labeled photos in the DB
// AND can be meaningfully cross-validated. The latter excludes
// community-* (shared amenity shots that every host uses) and any
// folder whose unit identifier is a placeholder ("a", "b", "main",
// "estate", "cottage") — both produce nothing but false positives,
// because we can't ask Google "does this URL mention Unit a" and get
// a useful answer. See `isScannableFolder` in shared/photo-folder-
// utils.ts for the exact rule.
export async function listScanableFolders(): Promise<string[]> {
  const rows = await storage.getAllPhotoLabels();
  const set = new Set<string>();
  for (const r of rows) if (isScannableFolder(r.folder)) set.add(r.folder);
  return Array.from(set).sort();
}

// Run one folder at a time, pausing between to avoid SearchAPI rate
// limits. Used by both the manual "Run now" endpoint (with a specific
// folder list) and the weekly scheduler (with the stale-folder list).
export async function runPhotoListingCheckForFolders(
  folders: string[],
  opts: { pauseMs?: number } = {},
): Promise<ScanResult[]> {
  const pause = opts.pauseMs ?? 1500;
  const results: ScanResult[] = [];
  for (let i = 0; i < folders.length; i++) {
    const f = folders[i];
    try {
      const r = await runPhotoListingCheckForFolder(f);
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

// Background tick. Runs at boot and then every hour. For each
// scanable folder whose last check is older than `maxAgeMs` (default:
// 24 hours → daily cadence), runs a fresh check. Budgeted at
// PHOTOS_PER_FOLDER (3) Lens calls + up to ~3 verification SERP calls
// per folder, so one tick's worst-case cost is (folder_count × ~6) ×
// the per-call rate — ~90 calls/day for the current ~15 folders.
// Raised from 7-day cadence in response to "detection should be faster
// than weekly" feedback.
export function startPhotoListingScheduler(maxAgeMs = 24 * 60 * 60 * 1000, tickMs = 60 * 60 * 1000): void {
  const tick = async () => {
    try {
      const known = await listScanableFolders();
      const stale = await storage.getStalePhotoListingFolders(maxAgeMs, known);
      if (stale.length === 0) {
        console.error(`[photo-listing-scanner] tick: ${known.length} folders, all fresh`);
        return;
      }
      console.error(`[photo-listing-scanner] tick: ${stale.length}/${known.length} folders stale — scanning`);
      await runPhotoListingCheckForFolders(stale);
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
