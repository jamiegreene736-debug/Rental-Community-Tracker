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
//
// The result is upserted one row per folder into photo_listing_checks.
// The dashboard aggregates those rows by property-ID via the client's
// unit-builder-data lookup; the scanner itself is property-agnostic.

import { storage } from "./storage";
import type { PhotoListingCheck } from "@shared/schema";

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

// Pull a unit-number hint from a folder name so we can cross-validate
// Lens results. Returns null for community/placeholder folders we
// can't meaningfully verify (community-*, pili-mai-unit-a, etc.). The
// hint must contain at least one digit — otherwise a single letter
// or a non-unit word would produce too many false negatives during
// verification ("A" would match almost any Airbnb URL).
//
// Examples:
//   "unit-721"          → "721"
//   "kaha-lani-123"     → "123"
//   "mauna-kai-6a"      → "6a"
//   "kaiulani-52"       → "52"
//   "pili-mai-unit-a"   → null  (placeholder)
//   "community-kaha-lani" → null  (amenity photos, no unit)
export function unitHintFromFolder(folder: string): string | null {
  const m = folder.match(/-unit-([a-z0-9]+)$/i);
  if (m && /\d/.test(m[1])) return m[1];
  const tail = folder.split("-").pop() || "";
  if (/^[a-z0-9]{2,}$/i.test(tail) && /\d/.test(tail)) return tail;
  return null;
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
  const heros = visible.slice(0, PHOTOS_PER_FOLDER);

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

  const unitHint = unitHintFromFolder(folder);
  // Per-run cache so a listing URL that shows up for multiple photos
  // only costs ONE verification SERP, not N.
  const verifyCache = new Map<string, boolean>();
  // Cap verifications per (photo × host) so a Lens response with 30
  // airbnb.com hits doesn't burn the SERP budget. 3 is plenty — the
  // tally threshold is ≥ 2 photos matching anyway.
  const MAX_VERIFY_PER_HOST_PER_PHOTO = 3;

  const verify = async (listingUrl: string): Promise<boolean> => {
    if (!unitHint) return true; // community/placeholder folder — verification disabled
    const cached = verifyCache.get(listingUrl);
    if (cached !== undefined) return cached;
    const ok = await verifyUrlMentionsUnit(listingUrl, unitHint);
    verifyCache.set(listingUrl, ok);
    return ok;
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
        return link.includes(host.host);
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

// Returns the list of folders that have any labeled photos in the DB.
// The dashboard caller uses this as the universe of "scanable" folders.
export async function listScanableFolders(): Promise<string[]> {
  const rows = await storage.getAllPhotoLabels();
  const set = new Set<string>();
  for (const r of rows) set.add(r.folder);
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
  // Kick once after a 30s boot delay so DB and photo routes are up.
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, tickMs);
}
