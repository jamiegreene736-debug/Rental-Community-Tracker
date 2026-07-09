// ─────────────────────────────────────────────────────────────────────────────
// Amenity photo-scan logic (PURE — no I/O, unit-tested).
//
// The photo-driven amenity scanner (server/amenity-scan.ts + the bulk-combo
// listing job) sends a property's community + unit photos to Claude vision and
// gets back the amenities it can SEE. This module owns the three pure pieces:
//   1. buildAmenityDetectionInstruction — the vision prompt (present-only).
//   2. parseAmenityDetectionJson — normalize + whitelist the model's JSON.
//   3. mergeDetectedAmenities — fold detections into the amenity selection.
//
// LOAD-BEARING (Jamie's choice, 2026-07-09): the scan is ADD-ONLY. It never
// removes an amenity — "not visible in a photo" almost never proves absence.
// And it fills out the standard baseline: a listing with no prior selection
// starts from the Hawaii baseline, THEN adds what the photos reveal. A listing
// that already has a curated selection keeps it and only gains the detected
// extras (never re-adds baseline items the operator may have trimmed).
// ─────────────────────────────────────────────────────────────────────────────

import type { AmenityVisionTarget } from "./guesty-amenity-catalog";

export type AmenityConfidence = "high" | "medium" | "low";

export type AmenityDetection = {
  key: string;
  confidence: AmenityConfidence;
  evidence: string;
};

export type AmenityDetectionParse = {
  /** Whitelisted keys the model confidently saw (confidence high|medium). */
  detected: string[];
  /** Full per-key detail (incl. dropped low-confidence rows for diagnostics). */
  detail: AmenityDetection[];
};

/**
 * Build the vision instruction. Present-only: for each target amenity the model
 * decides whether the photos CLEARLY show it, and returns only what it can see.
 */
export function buildAmenityDetectionInstruction(
  targets: AmenityVisionTarget[],
  opts: { communityName?: string; labelForKey?: (key: string) => string } = {},
): string {
  const labelFor = opts.labelForKey ?? ((k: string) => k);
  const lines = targets.map(
    (t) => `- ${t.key} (${labelFor(t.key)}): ${t.hint}`,
  );
  return [
    "You audit vacation-rental listing PHOTOS to detect which amenities are visibly present.",
    opts.communityName?.trim()
      ? `The property is "${opts.communityName.trim()}".`
      : "",
    "You will see photos from a COMMUNITY / resort folder and from one or more UNIT interiors,",
    "each image prefixed with a text label saying which folder it came from.",
    "",
    "For EACH amenity in the list below, decide whether the photos CLEARLY show it is present.",
    "Rules:",
    "  - Only include an amenity when you can point to SPECIFIC visual evidence in a photo. Do NOT guess.",
    "  - Community amenities (pool, hot tub, gym, tennis/pickleball, BBQ, grounds/views) count when shown in a COMMUNITY photo.",
    "  - Unit amenities (kitchen appliances, TV, bathtub, in-unit washer/dryer, lanai) count when shown in a UNIT photo.",
    "  - Views (ocean/mountain/garden/pool) count when visible through a window or from a lanai.",
    "  - Prefer the most specific key. Omit anything you cannot actually see — do NOT list an amenity just because a resort usually has it.",
    "  - Use ONLY keys from this list (exact spelling).",
    "",
    "Amenities to look for:",
    ...lines,
    "",
    'Respond with ONLY minified JSON, no prose:',
    '{"present":[{"key":"POOL","confidence":"high","evidence":"community photo 2 shows a large resort pool"}]}',
    'confidence is one of "high" | "medium" | "low". Omit an amenity entirely rather than guessing at low confidence.',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const CONF_ORDER: Record<AmenityConfidence, number> = { high: 3, medium: 2, low: 1 };

function coerceConfidence(v: unknown): AmenityConfidence {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "high") return "high";
  if (s === "low") return "low";
  return "medium"; // default any unknown/blank to medium (still passes the gate)
}

/**
 * Normalize the model's JSON into a whitelisted detection set.
 * - Keeps only keys present in `validKeys` (the vision-target keys).
 * - Drops "low" confidence (kept in `detail` for diagnostics only).
 * - Dedupes by key, keeping the highest confidence + its evidence.
 */
export function parseAmenityDetectionJson(
  parsed: unknown,
  validKeys: Set<string>,
): AmenityDetectionParse {
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.present)
      ? (parsed as any).present
      : Array.isArray((parsed as any)?.amenities)
        ? (parsed as any).amenities
        : [];

  const byKey = new Map<string, AmenityDetection>();
  for (const row of rows) {
    const key = typeof row === "string" ? row : String((row as any)?.key ?? "").trim();
    if (!key || !validKeys.has(key)) continue;
    const confidence = coerceConfidence(typeof row === "string" ? "medium" : (row as any)?.confidence);
    const evidence = typeof row === "string" ? "" : String((row as any)?.evidence ?? "").trim();
    const prev = byKey.get(key);
    if (!prev || CONF_ORDER[confidence] > CONF_ORDER[prev.confidence]) {
      byKey.set(key, { key, confidence, evidence });
    }
  }

  const detail = Array.from(byKey.values());
  const detected = detail
    .filter((d) => d.confidence !== "low")
    .map((d) => d.key);
  return { detected, detail };
}

export type MergeAmenitiesInput = {
  /** Current in-system / UI selection, or null/empty when there is none yet. */
  current: string[] | null | undefined;
  /** The standard baseline to fill from when there is no prior selection. */
  baseline: string[];
  /** Keys the vision scan detected. */
  detected: string[];
  /** Valid catalog keys — everything is filtered through this. */
  validKeys: Set<string>;
};

export type MergeAmenitiesResult = {
  /** The resulting amenity selection (add-only). */
  next: string[];
  /** Detected keys that were newly added on top of the base. */
  added: string[];
  /** The base the merge started from (current when present, else baseline). */
  base: string[];
  /** Whether the merge filled from the baseline (no prior selection). */
  filledFromBaseline: boolean;
};

/**
 * Add-only merge. When there is a prior selection we keep it verbatim and only
 * ADD detected amenities; when there is none we start from the baseline (so a
 * fresh listing is "filled out where available") and then add detections.
 * Nothing is ever removed. Order is preserved (base first, then new additions).
 */
export function mergeDetectedAmenities(input: MergeAmenitiesInput): MergeAmenitiesResult {
  const { validKeys } = input;
  const hasPrior = Array.isArray(input.current) && input.current.length > 0;
  const rawBase = hasPrior ? input.current! : input.baseline;

  const base: string[] = [];
  const baseSet = new Set<string>();
  for (const k of rawBase) {
    if (validKeys.has(k) && !baseSet.has(k)) {
      baseSet.add(k);
      base.push(k);
    }
  }

  const added: string[] = [];
  const addedSet = new Set<string>();
  for (const k of input.detected) {
    if (validKeys.has(k) && !baseSet.has(k) && !addedSet.has(k)) {
      addedSet.add(k);
      added.push(k);
    }
  }

  return {
    next: [...base, ...added],
    added,
    base,
    filledFromBaseline: !hasPrior,
  };
}
