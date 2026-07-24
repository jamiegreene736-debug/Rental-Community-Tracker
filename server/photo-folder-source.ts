// fs-only helpers for a photo folder's `_source.json` provenance stamp.
// Deliberately NO ./storage import — tests exercise the never-clobber write
// behavior against real temp folders, and importing storage would demand a
// DATABASE_URL. builder-photo-groups re-exports these for existing importers.

import fs from "fs";
import path from "path";
import { isOtaPhotoSourceUrl } from "@shared/photo-source-ota-guard";

const INTERNAL_STAGING_FOLDER_RE = /^\.[a-zA-Z0-9_-]+\.staging-\d+-[a-f0-9]{8}$/;

/**
 * Keep the hydration pipeline's tightly-scoped hidden staging folder intact
 * while continuing to sanitize every public/user-supplied folder name. The
 * staged replacement audit must read the disposable files before atomic
 * rename; replacing its leading dot with "-" points at a non-existent path.
 */
export function photoFolderDiskName(folder: string): string {
  return INTERNAL_STAGING_FOLDER_RE.test(folder)
    ? folder
    : folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export function publicPhotoDir(folder: string): string {
  const safe = photoFolderDiskName(folder);
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

/**
 * Read the source listing URL a folder's photos were scraped from (stamped into
 * `_source.json` by the last rescrape / Guesty import). Feeds the source-page
 * community-verification leg. Fail-soft: returns undefined on any error.
 *
 * OTA PHOTO-SOURCE GATE (2026-07-23): a stamp naming a live OTA listing is
 * reported as ABSENT. It is not provenance we can act on — every consumer
 * (source-page community check, the audit sweep's find-new skip list and its
 * description grounding) treats this value as "the listing this unit's photos
 * legitimately came from", which a VRBO/Airbnb/Booking page never is. The
 * `unit-621` folder carried https://www.vrbo.com/982364 for three months.
 * Note this does NOT rewrite the file — `writeFolderSourceUrlIfMissing` still
 * refuses to clobber an existing stamp, so the operator's record is intact.
 */
export async function readFolderSourceUrl(folder: string): Promise<string | undefined> {
  const sourcePath = path.join(publicPhotoDir(folder), "_source.json");
  try {
    const doc = JSON.parse(await fs.promises.readFile(sourcePath, "utf8")) as {
      sourceListing?: { url?: string } | null;
    };
    const url = doc?.sourceListing?.url;
    if (typeof url !== "string" || !url.trim()) return undefined;
    return isOtaPhotoSourceUrl(url.trim()) ? undefined : url.trim();
  } catch {
    return undefined;
  }
}

/**
 * Backfill a folder's `_source.json` provenance with a source-listing URL —
 * used by the unit-audit sweep when a folder has photos but no recorded
 * source (older scrapes / manual imports predate the stamp). NEVER clobbers:
 * writes only when the folder exists on disk AND no usable url is already
 * recorded; an unparseable existing file is left untouched. Other fields in an
 * existing `_source.json` are preserved (merge, not replace).
 */
export async function writeFolderSourceUrlIfMissing(folder: string, url: string): Promise<boolean> {
  const trimmed = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // OTA PHOTO-SOURCE GATE (2026-07-23): never record a live OTA listing as a
  // folder's photo provenance. A stamp here is read back by the re-pull job,
  // rescrape-unit-photos, and the source-page community check — writing one
  // would recreate exactly the `unit-621` → vrbo.com/982364 poisoning this
  // guard exists to end. See shared/photo-source-ota-guard.ts.
  if (isOtaPhotoSourceUrl(trimmed)) return false;
  const dir = publicPhotoDir(folder);
  const sourcePath = path.join(dir, "_source.json");
  let doc: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(sourcePath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      doc = parsed as Record<string, unknown>;
    } catch {
      return false; // unparseable — never destroy whatever is there
    }
    const existing = (doc as any)?.sourceListing?.url;
    if (typeof existing === "string" && existing.trim()) return false; // already has provenance
  } catch {
    // No _source.json yet — only create one inside a real photo folder.
    try {
      await fs.promises.access(dir);
    } catch {
      return false;
    }
  }
  const sourceListing =
    doc.sourceListing && typeof doc.sourceListing === "object" && !Array.isArray(doc.sourceListing)
      ? (doc.sourceListing as Record<string, unknown>)
      : {};
  doc.sourceListing = { ...sourceListing, url: trimmed };
  (doc as any).sourceUrlBackfilledAt = new Date().toISOString();
  try {
    await fs.promises.writeFile(sourcePath, JSON.stringify(doc, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
