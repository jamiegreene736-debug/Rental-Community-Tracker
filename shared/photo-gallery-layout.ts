// Per-property PUBLISHED GALLERY LAYOUT — which unit leads, and whether a
// community photo divides the units (2026-07-18 operator ask).
//
// This module owns the *between-gallery* contract. It deliberately does NOT
// order photos WITHIN a gallery — that stays `shared/photo-order.ts`
// (`orderGallery`: manual sort_order wins, else hero-first by category). The
// split matters: `orderGallery` is per-folder and folder-scoped operations
// (drag-to-reorder, "best order", relabel) all key off it, while everything
// here is structural and never touches `photo_labels.sort_order`.
//
// The published order is:
//
//   cover collage → <lead unit> → [divider] → <next unit> → … → Community
//
// The collage is NOT handled here: `/api/builder/push-photos` GETs the listing,
// captures the "Cover Collage"-captioned picture and re-prepends it on every
// PUT (see AGENTS.md Load-Bearing #46). "Collage first" is already true; this
// module starts at the units.
//
// LOAD-BEARING — this module is the SINGLE source of truth for the layout and
// MUST be applied by BOTH push assemblies:
//   - client/src/pages/builder.tsx (`propertyData.photos`) — the Photos tab
//     gallery AND the body of the manual "Push Photos to Guesty" click, which
//     sends `propertyData.photos` verbatim.
//   - server/guesty-photo-repush.ts — the AUTOMATED re-push after a unit swap
//     / the retroactive sweep.
// Wire only one of them and an automated re-push silently reverts the
// operator's chosen order the next time a unit is replaced. Both call sites are
// source-guarded in tests/photo-gallery-layout.test.ts.
//
// DIVIDER POSTURE (load-bearing): a divider photo is MOVED out of the community
// block, never duplicated. A duplicate would show the same photo twice in the
// guest-facing OTA gallery and burn one of Airbnb's 100 picture slots. The
// divider is taken from the FRONT of the already-ordered community gallery (its
// hero), which means the operator picks the divider simply by dragging a
// community photo to position 1 — no extra UI. At least one community photo
// always remains in the community block, so the section can never vanish.

export const PHOTO_GALLERY_LAYOUT_SETTING_KEY = "photo_gallery_layout.v1";

/** Newest layouts kept on write; the store never grows without bound. */
export const PHOTO_GALLERY_LAYOUT_CAP = 500;

/**
 * Operator default (2026-07-18): dividers ON. A layout row that predates the
 * flag, or a property with no row at all, still gets a divider — that is the
 * chosen rollout. `unitDividers: false` is the explicit opt-out.
 */
export const DEFAULT_UNIT_DIVIDERS = true;

/** The community block never drops below this many photos to feed dividers. */
export const MIN_COMMUNITY_PHOTOS_AFTER_DIVIDERS = 1;

/** Guesty truncates long captions; keep the suffixed caption sane. */
export const MAX_PUBLISHED_PHOTO_CAPTION_LENGTH = 200;
export const MAX_DIVIDER_CAPTION_LENGTH = MAX_PUBLISHED_PHOTO_CAPTION_LENGTH;

const UNIT_ROOM_SUFFIX_RE = /\s+\(Unit\s+[A-Z]\)\s*$/i;
const UNIT_LETTER_RE = /^Unit\s+([A-Z])(?:\s|\(|$)/i;
const ROOM_CATEGORY_RE = /^(?:bedrooms?|bathrooms?)$/i;
// Fallback for static/pre-label rows that have no category metadata. Keep this
// anchored to structured room labels so copy such as "Living Room Near Bathroom"
// is never mistaken for a bathroom photo.
const STRUCTURED_ROOM_CAPTION_RE =
  /^(?:(?:master|primary|guest|king|queen|twin|bunk|second|third|fourth|fifth|sixth)\s+bedroom\b|bedroom(?:\s+\d+)?\b|(?:master|primary|guest)\s+bath(?:room)?\b|bathroom(?:\s+\d+)?\b|half\s+bath\b|powder\s+room\b)/i;

function roomCaptionClassification(
  caption: string,
  category: string | null | undefined,
): boolean {
  const normalizedCategory = String(category ?? "").trim();
  if (normalizedCategory) return ROOM_CATEGORY_RE.test(normalizedCategory);
  return STRUCTURED_ROOM_CAPTION_RE.test(caption);
}

/**
 * Remove the generated terminal "(Unit A)" / "(Unit B)" presentation suffix
 * from a bedroom or bathroom caption.
 *
 * `photo_labels` is keyed only by physical folder + filename, while one folder
 * can back multiple logical units (and even different A/B identities across
 * properties). The unit suffix must therefore never be persisted there.
 */
export function stripUnitRoomCaptionSuffix(
  caption: string | null | undefined,
  category?: string | null,
): string {
  const text = String(caption ?? "").trim();
  const match = text.match(UNIT_ROOM_SUFFIX_RE);
  if (!match) return text;
  const base = text.slice(0, text.length - match[0].length).trim();
  return ROOM_CATEGORY_RE.test(String(category ?? "").trim())
    || STRUCTURED_ROOM_CAPTION_RE.test(base)
    ? base
    : text;
}

/**
 * Decorate a bedroom/bathroom caption with its logical, natural unit identity.
 *
 * The category is authoritative when present (`Bedrooms` / `Bathrooms`); the
 * narrow caption-prefix fallback covers static rows without category metadata.
 * Existing unit suffixes are replaced, not compounded, and the suffix itself is
 * never truncated.
 */
export function captionWithUnitRoomSuffix(
  caption: string | null | undefined,
  unitLabel: string | null | undefined,
  category?: string | null,
): string {
  const base = stripUnitRoomCaptionSuffix(caption, category);
  if (!roomCaptionClassification(base, category)) return base;

  const unitMatch = String(unitLabel ?? "").trim().match(UNIT_LETTER_RE);
  if (!unitMatch) return base;
  const suffix = ` (Unit ${unitMatch[1].toUpperCase()})`;
  const maxBaseLength = Math.max(0, MAX_PUBLISHED_PHOTO_CAPTION_LENGTH - suffix.length);
  const boundedBase = base.slice(0, maxBaseLength).trimEnd();
  return boundedBase ? `${boundedBase}${suffix}` : base;
}

/** Caption used when a community photo has no usable caption of its own. */
export const FALLBACK_DIVIDER_CAPTION = "Shared resort amenities";

export type PhotoGalleryLayout = {
  /**
   * Builder unit ids, front to back. Ids missing from this list keep their
   * natural (unit A, B, …) order behind the ones listed, so a stale id or a
   * newly added unit can never drop a gallery from the push.
   */
  unitOrder?: string[];
  /** Insert one community photo between consecutive units. Default ON. */
  unitDividers?: boolean;
  /** ISO timestamp of the last operator change. */
  updatedAt?: string;
};

export type PhotoGalleryLayoutMap = Record<string, PhotoGalleryLayout>;

// Same prototype-pollution defense as the other app_settings stores.
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** app_settings key for one builder property (positive core id OR -draftId). */
export function photoGalleryLayoutKey(propertyId: number): string {
  return String(propertyId);
}

export function parsePhotoGalleryLayouts(raw: string | null | undefined): PhotoGalleryLayoutMap {
  const out: PhotoGalleryLayoutMap = Object.create(null);
  if (!raw) return out;
  try {
    const doc: unknown = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
    for (const key of Object.keys(doc as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const row = (doc as Record<string, unknown>)[key];
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const rawOrder = (row as any).unitOrder;
      const unitOrder = Array.isArray(rawOrder)
        ? Array.from(
            new Set(
              rawOrder
                .map((id: unknown) => String(id ?? "").trim())
                .filter((id: string) => id.length > 0),
            ),
          )
        : undefined;
      const rawDividers = (row as any).unitDividers;
      const unitDividers = typeof rawDividers === "boolean" ? rawDividers : undefined;
      const updatedAt = String((row as any).updatedAt ?? "").trim() || undefined;
      // A row that carries no signal at all is dropped rather than stored as
      // an empty object — keeps the store honest about what was actually set.
      if (!unitOrder?.length && unitDividers === undefined) continue;
      out[key] = {
        ...(unitOrder?.length ? { unitOrder } : {}),
        ...(unitDividers === undefined ? {} : { unitDividers }),
        ...(updatedAt ? { updatedAt } : {}),
      };
    }
  } catch {
    // Fail-soft: an unreadable store reads as "no layouts" (= defaults).
  }
  return out;
}

export function serializePhotoGalleryLayouts(map: PhotoGalleryLayoutMap): string {
  const keys = Object.keys(map).filter((k) => !UNSAFE_KEYS.has(k));
  // Newest-updated wins when the cap trims; rows without a timestamp sort last.
  const ordered = keys
    .map((k) => ({ k, t: Date.parse(map[k]?.updatedAt ?? "") }))
    .sort((a, b) => (Number.isFinite(b.t) ? b.t : -Infinity) - (Number.isFinite(a.t) ? a.t : -Infinity))
    .slice(0, PHOTO_GALLERY_LAYOUT_CAP);
  const out: PhotoGalleryLayoutMap = {};
  for (const { k } of ordered) out[k] = map[k];
  return JSON.stringify(out);
}

/** True when this property should get a community photo between its units. */
export function unitDividersEnabled(layout: PhotoGalleryLayout | null | undefined): boolean {
  return layout?.unitDividers ?? DEFAULT_UNIT_DIVIDERS;
}

/**
 * Apply the operator's saved unit order to the natural (A, B, …) gallery list.
 *
 * Rules: ids named in `unitOrder` lead, in that order; every unit NOT named
 * keeps its natural relative order behind them. Never drops, duplicates, or
 * invents a unit — a stale id in the saved order is simply ignored, so
 * replacing or adding a unit can't lose its photos from the push.
 *
 * Returns a NEW array and never mutates the input.
 */
export function applyUnitOrder<T extends { unitId: string }>(
  units: ReadonlyArray<T>,
  unitOrder: ReadonlyArray<string> | null | undefined,
): T[] {
  const list = Array.isArray(units) ? units.slice() : [];
  if (!unitOrder?.length) return list;
  const byId = new Map<string, T>();
  for (const u of list) if (u && typeof u.unitId === "string" && !byId.has(u.unitId)) byId.set(u.unitId, u);
  const out: T[] = [];
  const taken = new Set<string>();
  for (const id of unitOrder) {
    const hit = byId.get(String(id ?? "").trim());
    if (!hit || taken.has(hit.unitId)) continue;
    taken.add(hit.unitId);
    out.push(hit);
  }
  for (const u of list) if (!taken.has(u?.unitId)) out.push(u);
  return out;
}

/**
 * Caption for a divider photo: the community photo's OWN caption plus a
 * "next unit" suffix, so the photo still describes itself (it really is a pool
 * shot) while telling the guest a second unit starts here.
 *
 * Idempotent — re-suffixing an already-suffixed caption is a no-op, so a
 * caption that ever round-tripped back into photo_labels can't compound.
 */
export function dividerCaptionFor(
  communityCaption: string | null | undefined,
  unitLabel: string | null | undefined,
): string {
  const label = String(unitLabel ?? "").trim();
  const base = stripDividerCaptionSuffix(communityCaption) || FALLBACK_DIVIDER_CAPTION;
  if (!label) return base.slice(0, MAX_DIVIDER_CAPTION_LENGTH);
  return `${base} — next: ${label}`.slice(0, MAX_DIVIDER_CAPTION_LENGTH);
}

/**
 * Inverse of the divider suffix — recovers the community photo's own caption.
 * Used before writing a caption back to photo_labels so the "— next: Unit B"
 * tail can never be persisted as the photo's real label (which would then be
 * re-suffixed on the next assembly).
 */
export function stripDividerCaptionSuffix(caption: string | null | undefined): string {
  const text = String(caption ?? "").trim();
  const match = text.match(/\s+—\s+next:\s+.+$/);
  return match ? text.slice(0, text.length - match[0].length).trim() : text;
}

/**
 * How many dividers this property can actually place: one before every unit
 * after the first, capped so the community block keeps at least
 * MIN_COMMUNITY_PHOTOS_AFTER_DIVIDERS photos. A thin community folder just
 * gets fewer dividers (earlier gaps first) — never a duplicated photo and
 * never an empty community section.
 */
export function dividerCount(unitCount: number, communityPhotoCount: number, enabled: boolean): number {
  if (!enabled) return 0;
  const gaps = Math.max(0, (Number(unitCount) || 0) - 1);
  const spare = Math.max(0, (Number(communityPhotoCount) || 0) - MIN_COMMUNITY_PHOTOS_AFTER_DIVIDERS);
  return Math.min(gaps, spare);
}

/**
 * Guest-facing unit label for a divider caption — "Unit B (3BR)".
 *
 * LOAD-BEARING: the index is the unit's NATURAL position (A, B, … as the
 * property defines them), NOT its position after the operator's reorder.
 * Showing Unit B first must not rename it to "Unit A" — the letter is the
 * unit's identity everywhere else in the app (descriptions, bedding, audit).
 *
 * Both push assemblies call this so the caption is byte-identical whether the
 * gallery was pushed by the operator's click or by an automated re-push. It is
 * deliberately separate from the section `source` string in builder.tsx, which
 * other systems match on ("Unit A (3BR)") and must not change shape.
 */
export function unitGalleryLabel(index: number, bedrooms?: unknown): string {
  const letter = String.fromCharCode(65 + Math.max(0, Number(index) || 0));
  const br = Number(bedrooms);
  return Number.isFinite(br) && br > 0 ? `Unit ${letter} (${br}BR)` : `Unit ${letter}`;
}

// ── Divider identity ────────────────────────────────────────────────────────
// A divider photo KEEPS the community `source` string. It really is a community
// photo — it just renders between two unit galleries — and every source-driven
// consumer of the assembled gallery classifies photos by that string: the
// photo-community check's role/group key, the dedupe scan's folder label, and
// the cover-collage community/unit pools. Giving the divider a source of its
// own made all three mis-classify it (a bogus one-photo "unit" group in the
// community check, most visibly). It is marked with an explicit flag instead,
// which only the renderer needs to look at.
export type UnitDividerMarks = {
  /** True for the community photo published between two unit galleries. */
  isUnitDivider?: boolean;
  /** Label of the unit that STARTS after this divider ("Unit B (3BR)"). */
  dividerNextUnitLabel?: string;
};

export type LayoutUnitGallery<T> = {
  unitId: string;
  /** Guest-facing unit label, e.g. "Unit B (3BR)" — used in the divider caption. */
  label: string;
  /** Photos ALREADY ordered within the gallery (orderGallery). */
  photos: T[];
};

export type LaidOutPhoto<T> = {
  photo: T;
  kind: "unit" | "divider" | "community";
  /** Unit photos: the owning unit. Dividers: the unit that STARTS after it. */
  unitId?: string;
  unitLabel?: string;
};

/**
 * Lay out the published gallery: lead unit → [divider] → next unit → … →
 * community. Photos must already be ordered WITHIN each gallery.
 *
 * `T` is constrained to carry a `caption` so the divider's caption is rewritten
 * here, once, for every caller — the client and server assemblies cannot drift
 * on the guest-facing wording.
 *
 * Returns a flat list; callers map each item to their own entry shape.
 */
export function planGalleryLayout<T extends { caption: string; category?: string | null }>(input: {
  units: ReadonlyArray<LayoutUnitGallery<T>>;
  community: ReadonlyArray<T>;
  layout?: PhotoGalleryLayout | null;
}): LaidOutPhoto<T>[] {
  const units = applyUnitOrder(
    (input.units ?? []).map((u) => ({ ...u, unitId: String(u?.unitId ?? "") })),
    input.layout?.unitOrder,
  );
  const community = (input.community ?? []).slice();

  const dividers = dividerCount(units.length, community.length, unitDividersEnabled(input.layout));
  // Dividers come off the FRONT of the ordered community gallery (its hero
  // shots) and are removed from the community block — moved, never copied.
  const dividerPhotos = community.slice(0, dividers);
  const communityRest = community.slice(dividers);

  const out: LaidOutPhoto<T>[] = [];
  const appendUnitRoomSuffix = units.length > 1;
  units.forEach((unit, index) => {
    if (index > 0) {
      const divider = dividerPhotos[index - 1];
      if (divider) {
        out.push({
          photo: { ...divider, caption: dividerCaptionFor(divider.caption, unit.label) },
          kind: "divider",
          unitId: unit.unitId,
          unitLabel: unit.label,
        });
      }
    }
    for (const photo of unit.photos ?? []) {
      out.push({
        photo: appendUnitRoomSuffix
          ? {
              ...photo,
              caption: captionWithUnitRoomSuffix(photo.caption, unit.label, photo.category),
            }
          : photo,
        kind: "unit",
        unitId: unit.unitId,
        unitLabel: unit.label,
      });
    }
  });
  for (const photo of communityRest) out.push({ photo, kind: "community" });
  return out;
}

/**
 * Filenames the layout will lift out of the community folder to use as
 * dividers. The Photos tab badges these tiles in the community grid so the
 * operator can see WHICH photo moves, while the community section itself stays
 * whole and fully reorderable (splitting the folder across two draggable
 * sections would persist a partial sort_order — see
 * storage.reorderPhotosInFolder, which only stamps the filenames it is given).
 */
export function dividerFilenames(
  communityFilenames: ReadonlyArray<string>,
  unitCount: number,
  layout: PhotoGalleryLayout | null | undefined,
): string[] {
  const files = (communityFilenames ?? []).filter((f) => typeof f === "string" && f.length > 0);
  return files.slice(0, dividerCount(unitCount, files.length, unitDividersEnabled(layout)));
}
