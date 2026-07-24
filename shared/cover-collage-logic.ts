// Pure decisions for the AI cover collage (Photos tab "Make Cover Collage" →
// POST /api/builder/auto-cover-collage → engine server/cover-collage.ts).
//
// One click now has Claude vision pick the two best photos for the 2-up
// cover, the server composes + pushes it to Guesty, and the collage is saved
// in-system (disk copy + app_settings record). Everything decidable without
// IO lives here so tests/cover-collage-logic.test.ts can lock it:
//   - the vision prompt (pair rules researched from VR-listing CRO guides:
//     LEFT = the scroll-stopping destination shot, RIGHT = proof of the
//     space; hard rules against bathrooms/floor plans/dark/portrait picks)
//   - the reply parser (strict JSON, in-range, two DIFFERENT photos)
//   - the caption-scoring heuristic fallback (port of the pre-2026-07-11
//     client pickCollagePhotos — used when vision is unavailable/fails)
//   - the ESRGAN gate for collage panels (SHORT side vs the 800px square
//     panel — cover-crop scales by the short side, unlike the 1920 push
//     spec's long-side gate in shared/photo-upscale-plan.ts)

import { ESRGAN_MAX_SCALE, ESRGAN_MIN_SCALE } from "./photo-upscale-plan";

export type CollageCandidate = {
  url: string;
  caption?: string | null;
  source?: string | null;
};

export type CollagePickIndices = {
  leftIndex: number;
  rightIndex: number;
  reasoning: string | null;
  /** Claude's visual classification of the right panel. */
  rightScene?: "patio" | "lanai" | "balcony" | "deck" | "porch" | "outdoor-transition" | "interior" | "other";
};

/** Collage geometry — mirrors the client canvas the manual flow draws
 * (1600×800 2:1, two square 800×800 cover-cropped panels + a thin divider).
 * Well under every OTA cap (Airbnb rejects >1920×1080). */
export const COLLAGE_WIDTH = 1600;
export const COLLAGE_HEIGHT = 800;
export const COLLAGE_PANEL_PX = COLLAGE_WIDTH / 2;

/** Disk home for the in-system copy of generated collages
 * (client/public/photos/<this>/<listingId>.jpg — inside the photos root so it
 * lands on the Railway volume and survives deploys). Folder-level sweeps that
 * enumerate the photos root must SKIP it — collages are synthetic composites,
 * not gallery photos (see the relabel-all-photos filter in server/routes.ts). */
export const COVER_COLLAGE_DISK_FOLDER = "cover-collages";

/** app_settings key holding the map of listingId → saved-collage record. */
export const COVER_COLLAGE_SETTING_KEY = "cover_collages.v1";

export type PersistedCoverCollagePreview = {
  collageUrl: string;
  previewUrl: string;
};

function validHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2_000) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Turn a durable cover-collage receipt into a safe fast-preview hint.
 *
 * Only a receipt that records a successful Guesty sync can appear while the
 * authoritative live gallery read is still running. The local preview path is
 * constrained to the synthetic cover-collage folder; malformed or legacy
 * paths fall back to the verified remote URL.
 */
export function parsePersistedCoverCollagePreview(raw: unknown): PersistedCoverCollagePreview | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.guestySynced !== true) return null;
  const collageUrl = validHttpUrl(record.collageUrl);
  if (!collageUrl) return null;
  const localPath = typeof record.localPath === "string" ? record.localPath.trim() : "";
  const safeLocalPath = new RegExp(
    `^/photos/${COVER_COLLAGE_DISK_FOLDER}/[a-zA-Z0-9_-]+\\.jpe?g$`,
    "i",
  ).test(localPath)
    ? localPath
    : null;
  return {
    collageUrl,
    previewUrl: safeLocalPath ?? collageUrl,
  };
}

/** Parse a local gallery URL ("/photos/<folder>/<file>", absolute URLs
 * tolerated) into its folder + filename. Returns null for external photos —
 * the vision pick needs bytes on disk. */
export function parseLocalPhotoUrl(url: string): { folder: string; filename: string } | null {
  if (typeof url !== "string" || !url) return null;
  let pathname = url;
  if (!url.startsWith("/")) {
    try { pathname = new URL(url).pathname; } catch { return null; }
  }
  const m = pathname.match(/^\/photos\/([^/?#]+)\/([^/?#]+)$/);
  if (!m) return null;
  return { folder: m[1], filename: m[2] };
}

// ── Heuristic fallback (no ANTHROPIC key / vision failure) ──────────────────
// Verbatim scoring port of the client-side pickCollagePhotos that predated the
// AI pick, so the keyless outcome matches the old button exactly.

/** Community scene: resort amenities, grounds, aerial shots — the "sell the
 * destination" photos. */
export function scoreCommunityShot(label: string): number {
  const l = label.toLowerCase();
  return (l.includes("ocean") ? 10 : 0) + (l.includes("beach") ? 9 : 0) +
         (l.includes("pool") ? 9 : 0) + (l.includes("sunset") || l.includes("sunrise") ? 8 : 0) +
         (l.includes("waterfront") ? 8 : 0) + (l.includes("aerial") ? 7 : 0) +
         (l.includes("coastal") ? 7 : 0) + (l.includes("resort") ? 6 : 0) +
         (l.includes("grounds") ? 5 : 0) + (l.includes("view") ? 4 : 0) +
         (l.includes("property") ? 3 : 0);
}

/** Patio scene: the unit's own private outdoor space, scenic-backdrop bonus. */
export function scorePatioShot(label: string): number {
  const l = label.toLowerCase();
  let s = 0;
  if (l.includes("lanai")) s += 10;
  if (l.includes("balcony")) s += 9;
  if (l.includes("patio")) s += 9;
  if (l.includes("covered") && (l.includes("deck") || l.includes("porch"))) s += 8;
  if (l.includes("deck")) s += 7;
  if (l.includes("porch")) s += 6;
  if (l.includes("ocean")) s += 4;
  if (l.includes("golf")) s += 2;
  if (l.includes("mountain") || l.includes("garden")) s += 2;
  return s;
}

/**
 * Caption-scoring pair pick. LEFT = best community shot (candidates whose
 * `source` starts with "Community", falling back to the whole set), RIGHT =
 * best patio/outdoor unit shot (non-community candidates, same fallback).
 * Unlike the old client port, the two picks are guaranteed DIFFERENT — a
 * two-photo gallery where one photo tops both scorers must not collage a
 * photo with itself.
 */
export function heuristicCollagePick(candidates: CollageCandidate[]): CollagePickIndices | null {
  if (!candidates || candidates.length < 2) return null;
  const isCommunity = (c: CollageCandidate) => (c.source ?? "").toLowerCase().startsWith("community");
  const communityIdx = candidates.map((_, i) => i).filter((i) => isCommunity(candidates[i]));
  const unitIdx = candidates.map((_, i) => i).filter((i) => !isCommunity(candidates[i]));
  const allIdx = candidates.map((_, i) => i);

  const pickBest = (pool: number[], scorer: (l: string) => number, exclude?: number): number | null => {
    const searchIn = (pool.length > 0 ? pool : allIdx).filter((i) => i !== exclude);
    if (searchIn.length === 0) return null;
    let best = searchIn[0];
    let bestScore = -1;
    for (const i of searchIn) {
      const s = scorer(candidates[i].caption || "");
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return best;
  };

  const left = pickBest(communityIdx, scoreCommunityShot);
  if (left == null) return null;
  const right = pickBest(unitIdx, scorePatioShot, left);
  if (right == null) return null;
  return { leftIndex: left, rightIndex: right, reasoning: null };
}

// ── Operator-chosen pair ("pick manually") ──────────────────────────────────

/** The operator's two picked photo URLs, straight off the PhotoCurator picker. */
export type ForcedCollagePick = { leftUrl: string; rightUrl: string };

/** Compare key for a candidate URL. Local gallery URLs compare on
 * folder/filename so an absolute URL and its "/photos/…" form match; anything
 * else falls back to the trimmed string. */
function collageUrlKey(url: string): string {
  const parsed = parseLocalPhotoUrl(url);
  return parsed ? `${parsed.folder}/${parsed.filename}` : String(url ?? "").trim();
}

/**
 * Resolve the operator's manually picked pair onto the resolved candidate
 * list. Returns null when either URL isn't in the list (external photo, file
 * missing on disk) or both picks are the same photo.
 *
 * NOTE FOR CODEX (load-bearing — this IS the 2026-07-18 bug): a null here must
 * make the caller FAIL, never degrade to the vision/heuristic pick. The
 * operator reported picking two photos and getting Claude's pair back instead;
 * a silent fallback would reproduce exactly that. See
 * server/cover-collage.ts's forcedPick branch.
 */
export function resolveForcedCollagePick(
  candidates: CollageCandidate[],
  forced: ForcedCollagePick,
): CollagePickIndices | null {
  if (!candidates?.length || !forced) return null;
  const leftKey = collageUrlKey(forced.leftUrl);
  const rightKey = collageUrlKey(forced.rightUrl);
  if (!leftKey || !rightKey || leftKey === rightKey) return null;
  const indexOf = (key: string) => candidates.findIndex((c) => collageUrlKey(c.url) === key);
  const leftIndex = indexOf(leftKey);
  const rightIndex = indexOf(rightKey);
  if (leftIndex < 0 || rightIndex < 0 || leftIndex === rightIndex) return null;
  return { leftIndex, rightIndex, reasoning: null };
}

// ── Vision prompt + parser ───────────────────────────────────────────────────

/**
 * Instruction appended after the numbered candidate images. This deliberately
 * mirrors Load-Bearing #8 and the deterministic fallback: community hero LEFT,
 * unit patio/lanai RIGHT. The `section` marker attached to each image is the
 * source of truth for community-vs-unit ownership; Claude judges photo quality
 * and whether the unit image is genuinely an outdoor transition space.
 */
export function buildCollageVisionPrompt(photoCount: number): string {
  return [
    `You just saw ${photoCount} candidate photos from one vacation-rental listing, numbered 1-${photoCount} in the marker line before each image.`,
    "",
    "Pick the TWO best photos for the listing's cover collage — a side-by-side 2-up hero image shown as the FIRST photo on Airbnb/VRBO/Booking.com. Guests decide from thumbnails, so this pair drives clicks.",
    "",
    'LEFT panel — choose the strongest image whose marker says section: "Community…": resort pool, beach/ocean, grounds, or community exterior. This must be a COMMUNITY image when one is available.',
    'RIGHT panel — choose the strongest PATIO/LANAI/BALCONY/DECK/PORCH image from a NON-community unit section. Prefer an ocean/view-facing outdoor transition space. This must be a UNIT image when one is available.',
    "",
    "Preferred pairings, most desirable first:",
    "1. Community pool or beachfront grounds + ocean-view unit lanai",
    "2. Community ocean/beach view + bright unit patio or balcony",
    "3. Community exterior/grounds + the unit's best deck or porch",
    "4. If no true unit patio exists, use the strongest non-community unit outdoor-transition image; do not substitute an ordinary interior while a patio/lanai candidate exists.",
    "",
    "Hard rules:",
    "- Both picks must be landscape-oriented, bright daylight, level horizon, and decluttered.",
    "- The two picks must show DIFFERENT subjects — never two angles of the same room or view.",
    "- Honor the section markers: do not put a unit photo on the community side or a community photo on the unit-patio side when both source groups are available.",
    "- Prefer a pair with matching color temperature and brightness so the collage reads as one image.",
    "- Each panel is center-cropped to a SQUARE, so the subject must survive a square crop.",
    "- NEVER pick: bathrooms, floor plans, maps, close-up/detail shots, dark or blurry or heavily filtered photos, photos with people or pets, screenshots, or watermarked images.",
    "",
    'Respond with ONLY this JSON (no prose, no markdown fences):',
    'Classify the chosen right image as exactly one of: "patio", "lanai", "balcony", "deck", "porch", "outdoor-transition", "interior", or "other".',
    '{"left": <photo number>, "right": <photo number>, "rightScene": "<classification>", "reasoning": "<one short sentence on why this pair>"}',
  ].join("\n");
}

/**
 * Validate the vision reply. Accepts the parsed JSON object; returns
 * 0-based indices or null when the reply is unusable (out of range,
 * non-integer, or the same photo twice) — the caller then falls back to the
 * heuristic instead of composing garbage.
 */
export function parseCollageVisionPick(raw: unknown, photoCount: number): CollagePickIndices | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const left = Number(obj.left);
  const right = Number(obj.right);
  if (!Number.isInteger(left) || !Number.isInteger(right)) return null;
  if (left < 1 || left > photoCount || right < 1 || right > photoCount) return null;
  if (left === right) return null;
  const reasoning = typeof obj.reasoning === "string" && obj.reasoning.trim()
    ? obj.reasoning.trim().slice(0, 500)
    : null;
  const rightScene = typeof obj.rightScene === "string"
    && ["patio", "lanai", "balcony", "deck", "porch", "outdoor-transition", "interior", "other"].includes(obj.rightScene)
    ? obj.rightScene as CollagePickIndices["rightScene"]
    : undefined;
  return {
    leftIndex: left - 1,
    rightIndex: right - 1,
    reasoning,
    ...(rightScene ? { rightScene } : {}),
  };
}

/**
 * ESRGAN gate for a collage panel. Cover-cropping into an 800×800 square
 * scales by the SHORT side, so — unlike the push spec's long-side gate — a
 * photo only needs AI upscaling when min(width, height) is under the panel
 * size. Returns null to skip Real-ESRGAN, else the smallest scale in
 * [ESRGAN_MIN_SCALE, ESRGAN_MAX_SCALE] whose output short side clears the
 * panel (capped at max — sharp's classical resize finishes any remainder).
 */
export function collageEsrganScale(
  width: number | undefined,
  height: number | undefined,
  panelPx: number = COLLAGE_PANEL_PX,
): number | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const shortSide = Math.min(w, h);
  if (shortSide >= panelPx) return null;
  for (let scale = ESRGAN_MIN_SCALE; scale <= ESRGAN_MAX_SCALE; scale += 1) {
    if (shortSide * scale >= panelPx) return scale;
  }
  return ESRGAN_MAX_SCALE;
}

/** Even-spread sampling of n items down to cap (first + last always kept).
 * Same shape as the dedupe/amenity samplers, incl. the cap<=1 NaN guard. */
export function evenSampleIndices(n: number, cap: number): number[] {
  if (n <= 0 || cap <= 0) return [];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  if (cap === 1) return [0];
  const out = new Set<number>();
  for (let i = 0; i < cap; i++) {
    out.add(Math.min(n - 1, Math.round((i * (n - 1)) / (cap - 1))));
  }
  return Array.from(out).sort((a, b) => a - b);
}
