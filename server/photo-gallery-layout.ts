// Server side of the per-property published GALLERY LAYOUT (2026-07-18): which
// unit leads the pushed gallery, and whether a community photo divides the
// units. Pure decisions live in shared/photo-gallery-layout.ts.
//
// Store: app_settings `photo_gallery_layout.v1`, keyed by builder propertyId
// (positive core id OR negative -draftId — the established builder convention),
// with the same fail-soft promise-tail pattern as the other app_settings stores
// (server/photo-folder-verification.ts).
//
// WHY THE SERVER OWNS THIS (load-bearing): the layout must be readable by
// server/guesty-photo-repush.ts, which pushes photos to Guesty with no browser
// in the loop (after a unit swap, and in the retroactive sweep). Parking the
// setting in localStorage — the Bedding tab's approach — would make it
// invisible to every automated push, so a swap would silently revert the
// operator's chosen unit order. It is deliberately durable + server-side.

import { storage } from "./storage";
import {
  PHOTO_GALLERY_LAYOUT_SETTING_KEY,
  parsePhotoGalleryLayouts,
  photoGalleryLayoutKey,
  serializePhotoGalleryLayouts,
  type PhotoGalleryLayout,
  type PhotoGalleryLayoutMap,
} from "../shared/photo-gallery-layout";

let layoutTail: Promise<void> = Promise.resolve();

function mutateLayouts(fn: (map: PhotoGalleryLayoutMap) => void): Promise<void> {
  layoutTail = layoutTail.then(async () => {
    const raw = await storage.getSetting(PHOTO_GALLERY_LAYOUT_SETTING_KEY);
    const map = parsePhotoGalleryLayouts(raw ?? null);
    fn(map);
    await storage.setSetting(
      PHOTO_GALLERY_LAYOUT_SETTING_KEY,
      serializePhotoGalleryLayouts(map),
    );
  });
  return layoutTail;
}

export async function loadPhotoGalleryLayouts(): Promise<PhotoGalleryLayoutMap> {
  try {
    const raw = await storage.getSetting(PHOTO_GALLERY_LAYOUT_SETTING_KEY);
    return parsePhotoGalleryLayouts(raw ?? null);
  } catch {
    // Fail-soft: an unreadable store reads as "defaults everywhere", never a
    // crash — a push must not fail because a preference could not be read.
    return Object.create(null);
  }
}

/** The saved layout for one property, or null when it has never been set. */
export async function getPhotoGalleryLayout(
  propertyId: number,
): Promise<PhotoGalleryLayout | null> {
  const map = await loadPhotoGalleryLayouts();
  return map[photoGalleryLayoutKey(propertyId)] ?? null;
}

/**
 * Save the operator's layout for one property. Both fields are optional —
 * omitting one leaves the stored value alone, so the unit-order control and the
 * divider toggle can PATCH independently without clobbering each other.
 *
 * Unlike the read paths this deliberately does NOT swallow errors: a save the
 * operator clicked must report failure rather than silently no-op.
 */
export async function savePhotoGalleryLayout(
  propertyId: number,
  patch: { unitOrder?: string[]; unitDividers?: boolean },
): Promise<PhotoGalleryLayout> {
  const key = photoGalleryLayoutKey(propertyId);
  let saved: PhotoGalleryLayout = {};
  await mutateLayouts((map) => {
    const prev = map[key] ?? {};
    const next: PhotoGalleryLayout = {
      ...prev,
      ...(patch.unitOrder === undefined
        ? {}
        : {
            unitOrder: Array.from(
              new Set(patch.unitOrder.map((id) => String(id ?? "").trim()).filter(Boolean)),
            ),
          }),
      ...(patch.unitDividers === undefined ? {} : { unitDividers: patch.unitDividers }),
      updatedAt: new Date().toISOString(),
    };
    map[key] = next;
    saved = next;
  });
  return saved;
}
