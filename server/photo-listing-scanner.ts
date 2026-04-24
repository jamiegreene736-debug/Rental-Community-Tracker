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
      if (hits.length > 0) {
        tally[host.key].photoHitCount += 1;
        for (const h of hits.slice(0, 5)) {
          tally[host.key].matches.push({
            photoUrl,
            listingUrl: String(h.link || ""),
            title:  String(h.title  || ""),
            source: String(h.source || ""),
          });
        }
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
// scanable folder whose last check is older than `maxAgeMs` (7 days),
// runs a fresh check. Budgeted at PHOTOS_PER_FOLDER (3) Lens calls per
// folder, so one tick's worst-case cost is (folder_count × 3) × the
// per-Lens rate — ~45 calls/week for the current ~15 folders.
export function startPhotoListingScheduler(maxAgeMs = 7 * 24 * 60 * 60 * 1000, tickMs = 60 * 60 * 1000): void {
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
