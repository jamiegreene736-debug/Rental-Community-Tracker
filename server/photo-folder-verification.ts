// Server side of the operator-verified photo-folder pin + the PROVENANCE
// enrichment the photo-community check routes run before the engine.
//
// Pin store: app_settings `photo_folder_verifications.v1` — same fail-soft
// promise-tail pattern as the unit-audit stores. The pin itself is pure logic
// (shared/photo-folder-verification.ts): fingerprint of the published photo
// set; any photo change silently un-applies the pin (never deleted, so
// restoring the set restores it).
//
// Enrichment (enrichCheckGroupsWithProvenance) stamps SERVER-derived facts on
// each unit group before runPhotoCommunityCheck:
//  - sourceUrl (when the caller didn't send one) from the folder's _source.json
//  - swapVerified when the folder is a replacement-* folder whose unit has a
//    COMMITTED unit_swaps row (an abandoned preflight folder without a
//    committed swap gets nothing)
//  - operatorVerified(+At) when the folder pin exists AND its fingerprint
//    still matches the CURRENT published photo set
// The engine then upgrades UNCERTAIN votes only — a "no" vote always wins
// (see shared/photo-community-check-logic.ts canUpgradeWithProvenance).

import { storage } from "./storage";
import {
  PHOTO_FOLDER_VERIFICATIONS_SETTING_KEY,
  parsePhotoFolderVerifications,
  photoFolderFingerprint,
  serializePhotoFolderVerifications,
  type PhotoFolderVerification,
} from "../shared/photo-folder-verification";
import { latestUnitSwapsByUnit } from "../shared/unit-swap-photos";
import { replacementPhotoFolderRef } from "../shared/photo-folder-utils";
import { listPublishedFilenames, readFolderSourceUrl } from "./builder-photo-groups";
import type { CheckGroupInput } from "./photo-community-check";

let pinTail: Promise<void> = Promise.resolve();
function mutatePins(
  fn: (map: Record<string, PhotoFolderVerification>) => void,
): Promise<void> {
  pinTail = pinTail.then(async () => {
    try {
      const raw = await storage.getSetting(PHOTO_FOLDER_VERIFICATIONS_SETTING_KEY);
      const map = parsePhotoFolderVerifications(raw ?? null);
      fn(map);
      await storage.setSetting(
        PHOTO_FOLDER_VERIFICATIONS_SETTING_KEY,
        serializePhotoFolderVerifications(map),
      );
    } catch {
      // Fail-soft: the pin is an upgrade, never a blocker.
    }
  });
  return pinTail;
}

async function loadPins(): Promise<Record<string, PhotoFolderVerification>> {
  try {
    const raw = await storage.getSetting(PHOTO_FOLDER_VERIFICATIONS_SETTING_KEY);
    return parsePhotoFolderVerifications(raw ?? null);
  } catch {
    return Object.create(null);
  }
}

/**
 * Save (verified=true) or clear (verified=false) the operator pin for a folder.
 * The fingerprint is computed from the CURRENT published photo set — the pin
 * only ever blesses photos the operator was looking at when they clicked.
 */
export async function setPhotoFolderVerification(
  folder: string,
  verified: boolean,
): Promise<PhotoFolderVerification | null> {
  if (!verified) {
    await mutatePins((map) => {
      delete map[folder];
    });
    return null;
  }
  const filenames = await listPublishedFilenames(folder);
  if (filenames.length === 0) {
    throw new Error(`No published photos in folder "${folder}" — nothing to verify.`);
  }
  const row: PhotoFolderVerification = {
    folder,
    fingerprint: photoFolderFingerprint(filenames),
    verifiedAt: new Date().toISOString(),
  };
  await mutatePins((map) => {
    map[folder] = row;
  });
  return row;
}

/**
 * The pin, but ONLY if it still applies: fingerprint must match the folder's
 * current published photo set. Returns null for no pin / changed photos /
 * empty folder.
 */
export async function activeFolderVerification(
  folder: string,
  pins?: Record<string, PhotoFolderVerification>,
): Promise<PhotoFolderVerification | null> {
  const map = pins ?? (await loadPins());
  const pin = Object.prototype.hasOwnProperty.call(map, folder) ? map[folder] : null;
  if (!pin) return null;
  const filenames = await listPublishedFilenames(folder);
  if (filenames.length === 0) return null;
  return photoFolderFingerprint(filenames) === pin.fingerprint ? pin : null;
}

/**
 * Stamp server-derived provenance onto unit groups (mutates in place).
 * Called by the photo-community-check route (covers client-driven groups, the
 * server-built no-groups path, and the unit-audit sweep's loopback call) and
 * by the bulk photo-community job. Fail-soft per group — enrichment can only
 * ever ADD signals, never block a check.
 */
export async function enrichCheckGroupsWithProvenance(
  groups: CheckGroupInput[] | undefined,
): Promise<void> {
  const unitGroups = (Array.isArray(groups) ? groups : []).filter(
    (g) => g && g.role === "unit" && typeof g.folder === "string" && g.folder.length > 0,
  );
  if (unitGroups.length === 0) return;
  const pins = await loadPins();
  // One swaps fetch per property id (a two-unit property shares the list).
  const swapsCache = new Map<number, Map<string, { oldUnitId: string }>>();
  for (const g of unitGroups) {
    try {
      if (!g.sourceUrl) {
        g.sourceUrl = await readFolderSourceUrl(g.folder);
      }
      if (g.swapVerified == null) {
        const ref = replacementPhotoFolderRef(g.folder);
        if (ref) {
          let byUnit = swapsCache.get(ref.propertyId);
          if (!byUnit) {
            const swaps = await storage.getUnitSwaps(ref.propertyId).catch(() => []);
            byUnit = latestUnitSwapsByUnit(swaps);
            swapsCache.set(ref.propertyId, byUnit);
          }
          if (byUnit.has(ref.oldUnitId)) g.swapVerified = true;
        }
      }
      if (g.operatorVerified == null) {
        const pin = await activeFolderVerification(g.folder, pins);
        if (pin) {
          g.operatorVerified = true;
          g.operatorVerifiedAt = pin.verifiedAt;
        }
      }
    } catch {
      // Fail-soft per group.
    }
  }
}
