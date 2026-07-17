// ─────────────────────────────────────────────────────────────────────────────
// Bedding PHOTO scan — pure logic (browser-safe, no fs/fetch).
//
// The Bedding tab's config is built from static defaults + regex-parsed
// AI-estimated text (draft-bedding.ts) — no photo evidence anywhere. This
// module is the pure half of the Claude-vision scan that proposes bedding
// grounded in the unit's ACTUAL photos:
//   • per distinct photographed bedroom: bed type(s) + quantity, plus en-suite
//     evidence ONLY when a photo actually shows the attached bathroom;
//   • per photographed bathroom: walk-in shower / shower-tub combo / soaking
//     or jetted tub / rain shower / double vanity, half-bath detection;
//   • honesty: unphotographed bedrooms are REPORTED, never guessed/padded.
//
// Consumers:
//   • server/bedding-photo-scan.ts — vision call + persistence
//     (`bedding_photo_scans.v1` app_setting) + the audit comparison vs the
//     Guesty listing's pushed bed layout;
//   • BeddingTab.tsx — a fresh operator-triggered scan applies VISION detections
//     above the auto-apply threshold, saves the resulting builder config, and
//     builds Guesty's supported Bedding projection from it when connected.
//     Caption fallback and hydrated/audit scans stay read-only.
//
// The audit-side comparison lives HERE (not in server/unit-audit-sweep.ts)
// deliberately: the sweep module is source-locked to never contain the string
// "listingRooms" (Load-Bearing "the layout stage NEVER auto-pushes"), so the
// engine module reads the Guesty rooms and this module words the findings.
// ─────────────────────────────────────────────────────────────────────────────

export const BEDDING_PHOTO_SCANS_SETTING_KEY = "bedding_photo_scans.v1";
export const BEDDING_SCAN_STORE_CAP = 200;

/** Review/audit floor; automatic application requires strictly greater confidence. */
export const BEDDING_SCAN_MIN_CONFIDENCE = 0.6;

/** The operator asked for detections "above 60%"; exactly 60% is not eligible. */
export function isBeddingScanAutoApplyEligible(
  confidence: number,
  minimumConfidence: number = BEDDING_SCAN_MIN_CONFIDENCE,
): boolean {
  return Number.isFinite(confidence) && confidence > minimumConfidence;
}

// Guesty bed-type vocabulary (the subset the Bedding tab edits/pushes).
export type BeddingScanBedType =
  | "KING_BED"
  | "QUEEN_BED"
  | "DOUBLE_BED"
  | "SINGLE_BED"
  | "SOFA_BED"
  | "BUNK_BED";

// Mirrors the Bedding tab's BathFeature vocabulary (bedding-config.ts).
export type BeddingScanBathFeature =
  | "walk-in-shower"
  | "shower-tub-combo"
  | "soaking-tub"
  | "jetted-tub"
  | "double-vanity"
  | "rain-shower";

export const BEDDING_SCAN_BED_LABELS: Record<BeddingScanBedType, string> = {
  KING_BED: "King bed",
  QUEEN_BED: "Queen bed",
  DOUBLE_BED: "Double bed",
  SINGLE_BED: "Twin bed",
  SOFA_BED: "Sofa bed",
  BUNK_BED: "Bunk bed",
};

export const BEDDING_SCAN_FEATURE_LABELS: Record<BeddingScanBathFeature, string> = {
  "walk-in-shower": "Walk-in shower",
  "shower-tub-combo": "Shower / tub combo",
  "soaking-tub": "Soaking tub",
  "jetted-tub": "Jetted tub",
  "double-vanity": "Double vanity",
  "rain-shower": "Rain shower",
};

export type DetectedBed = { type: BeddingScanBedType; quantity: number };

export type DetectedBedroom = {
  beds: DetectedBed[];
  /**
   * En-suite bathroom features PROVEN by a photo (the bathroom is visibly
   * attached/open to this bedroom). Empty array = no en-suite evidence — the
   * merge NEVER unsets an operator's en-suite flag from absence of evidence.
   */
  ensuiteFeatures: BeddingScanBathFeature[];
  confidence: number;
  /** Source photo filenames (resolved from the vision call's indexes). */
  photos: string[];
};

export type DetectedBathroom = {
  features: BeddingScanBathFeature[];
  isHalf: boolean;
  confidence: number;
  photos: string[];
};

export type BeddingScanUnit = {
  /** Stable builder unit id. Automatic application never falls back to position. */
  unitId?: string;
  /** Only fresh vision evidence is eligible for automatic external writes. */
  evidenceMethod?: "vision" | "captions";
  folder: string;
  label: string;
  expectedBedrooms: number | null;
  /** How many photos were actually sent to vision (or read in fallback). */
  photosScanned: number;
  bedrooms: DetectedBedroom[];
  bathrooms: DetectedBathroom[];
  /** max(0, expectedBedrooms − distinct confident photographed bedrooms). */
  unphotographedBedrooms: number;
  warning?: string;
};

export type BeddingPhotoScanRecord = {
  propertyId: number;
  scannedAt: string; // ISO
  /** "vision" = Claude looked at the photos; "captions" = label-derived fallback. */
  method: "vision" | "captions";
  model: string | null;
  units: BeddingScanUnit[];
  /** folder → photoFolderFingerprint at scan time (staleness detection). */
  fingerprints: Record<string, string>;
};

// ── Bed-type normalization ───────────────────────────────────────────────────

export function normalizeScanBedType(raw: unknown): BeddingScanBedType | null {
  const t = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!t) return null;
  if (/^CAL(IFORNIA)?_?KING(_BED)?$/.test(t) || /^KING(_BED)?$/.test(t)) return "KING_BED";
  if (/^QUEEN(_BED)?$/.test(t)) return "QUEEN_BED";
  if (/^(DOUBLE|FULL)(_BED)?$/.test(t)) return "DOUBLE_BED";
  if (/^(TWIN|SINGLE)(_BED)?$/.test(t)) return "SINGLE_BED";
  if (/^SOFA(_BED)?$/.test(t) || /^SLEEPER(_SOFA)?$/.test(t)) return "SOFA_BED";
  if (/^BUNK(_BED)?S?$/.test(t)) return "BUNK_BED";
  return null;
}

const BATH_FEATURE_SET = new Set<BeddingScanBathFeature>([
  "walk-in-shower",
  "shower-tub-combo",
  "soaking-tub",
  "jetted-tub",
  "double-vanity",
  "rain-shower",
]);

export function normalizeScanBathFeature(raw: unknown): BeddingScanBathFeature | null {
  const t = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (BATH_FEATURE_SET.has(t as BeddingScanBathFeature)) return t as BeddingScanBathFeature;
  // Tolerate close synonyms the model may emit despite the fixed vocabulary.
  if (t === "walkin-shower" || t === "walk-in") return "walk-in-shower";
  if (t === "shower-tub" || t === "tub-shower-combo" || t === "shower-over-tub") return "shower-tub-combo";
  if (t === "standalone-tub" || t === "freestanding-tub" || t === "bathtub") return "soaking-tub";
  if (t === "whirlpool-tub" || t === "jacuzzi-tub" || t === "jacuzzi") return "jetted-tub";
  return null;
}

// ── Vision prompt ────────────────────────────────────────────────────────────

export function buildBeddingVisionPrompt(input: {
  unitLabel: string;
  expectedBedrooms: number | null;
  photoCount: number;
}): string {
  const expected = input.expectedBedrooms != null && input.expectedBedrooms > 0
    ? `The listing claims ${input.expectedBedrooms} bedroom${input.expectedBedrooms === 1 ? "" : "s"}, but the photo set may cover fewer — report ONLY rooms you can actually see. NEVER pad to the claimed count.`
    : "Report ONLY rooms you can actually see.";
  return [
    `These ${input.photoCount} numbered photos are interior photos of ONE vacation-rental unit (${input.unitLabel}).`,
    "Identify every DISTINCT bedroom and every DISTINCT bathroom that is photographed, and describe the beds and bathroom fixtures.",
    "",
    "RULES",
    `- ${expected}`,
    "- Two photos can show the SAME room from different angles — fold them into ONE entry (list all of that room's photo numbers). Compare bedding, headboard, wall color, windows, and layout before deciding two bedroom photos are different rooms.",
    "- Beds: count only real beds visible in the photos. Types: KING, QUEEN, DOUBLE, TWIN, SOFA, BUNK. Two twins side by side = {\"type\":\"TWIN\",\"quantity\":2}. A sofa/daybed/futon in a living area is NOT a bedroom — skip it.",
    "- ensuiteFeatures: fill ONLY when a photo of that bedroom visibly shows its ATTACHED bathroom (open door / pass-through into the bathroom from the bedroom shot). Otherwise use []. Never infer an en-suite you cannot see.",
    "- Bathroom features (fixed vocabulary): walk-in-shower (glass/open shower, NO tub under the head), shower-tub-combo (shower head over a tub), soaking-tub (standalone tub, no shower head over it), jetted-tub (visible jets), rain-shower (ceiling-mounted head), double-vanity (two sinks).",
    "- isHalf: true only when the photo clearly shows the whole room and it has a toilet/vanity but NO shower and NO tub.",
    "- Fold multiple angles of the same bathroom into one entry, same as bedrooms.",
    "- confidence: 0.0-1.0 per entry. Below 0.6 means you are unsure.",
    "",
    "Respond with ONLY minified JSON (no code fences, no prose) in exactly this shape:",
    '{"bedrooms":[{"photos":[1,3],"beds":[{"type":"KING","quantity":1}],"ensuiteFeatures":["walk-in-shower"],"confidence":0.9}],"bathrooms":[{"photos":[2],"features":["shower-tub-combo"],"isHalf":false,"confidence":0.85}]}',
    'No bedrooms photographed → "bedrooms":[]. No bathrooms photographed → "bathrooms":[].',
  ].join("\n");
}

// ── Strict parse ─────────────────────────────────────────────────────────────

function parsePhotoIndexes(raw: unknown, photoCount: number, used: Set<number>): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? Math.trunc(v) : Number.parseInt(String(v), 10);
    if (!Number.isFinite(n) || n < 1 || n > photoCount) continue;
    if (used.has(n) || out.includes(n)) continue; // a photo belongs to ONE room
    out.push(n);
  }
  return out;
}

function parseConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

export type ParsedBeddingVision = {
  bedrooms: Array<{ photoIndexes: number[]; beds: DetectedBed[]; ensuiteFeatures: BeddingScanBathFeature[]; confidence: number }>;
  bathrooms: Array<{ photoIndexes: number[]; features: BeddingScanBathFeature[]; isHalf: boolean; confidence: number }>;
};

/**
 * Strict, per-entry validating parse. Malformed top-level shape → null (the
 * caller falls back / warns — never invents bedding). Individual bad entries
 * (out-of-range photo numbers, photo already claimed by another room, no valid
 * beds) are DROPPED, not repaired.
 */
export function parseBeddingVisionJson(parsed: unknown, photoCount: number): ParsedBeddingVision | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rawBedrooms = (parsed as any).bedrooms;
  const rawBathrooms = (parsed as any).bathrooms;
  if (!Array.isArray(rawBedrooms) && !Array.isArray(rawBathrooms)) return null;

  const usedBedroomPhotos = new Set<number>();
  const bedrooms: ParsedBeddingVision["bedrooms"] = [];
  for (const entry of Array.isArray(rawBedrooms) ? rawBedrooms : []) {
    if (!entry || typeof entry !== "object") continue;
    const photoIndexes = parsePhotoIndexes((entry as any).photos, photoCount, usedBedroomPhotos);
    if (photoIndexes.length === 0) continue;
    const beds: DetectedBed[] = [];
    for (const b of Array.isArray((entry as any).beds) ? (entry as any).beds : []) {
      const type = normalizeScanBedType(b?.type);
      if (!type) continue;
      const qRaw = typeof b?.quantity === "number" ? Math.trunc(b.quantity) : Number.parseInt(String(b?.quantity ?? "1"), 10);
      const quantity = Number.isFinite(qRaw) ? Math.max(1, Math.min(6, qRaw)) : 1;
      const existing = beds.find((x) => x.type === type);
      if (existing) existing.quantity = Math.min(6, existing.quantity + quantity);
      else beds.push({ type, quantity });
    }
    // A bedroom entry with no recognizable bed is not actionable — drop it.
    if (beds.length === 0) continue;
    const ensuiteFeatures = (Array.isArray((entry as any).ensuiteFeatures) ? (entry as any).ensuiteFeatures : [])
      .map(normalizeScanBathFeature)
      .filter((f: BeddingScanBathFeature | null): f is BeddingScanBathFeature => f != null);
    photoIndexes.forEach((i) => usedBedroomPhotos.add(i));
    bedrooms.push({
      photoIndexes,
      beds,
      ensuiteFeatures: Array.from(new Set(ensuiteFeatures)),
      confidence: parseConfidence((entry as any).confidence),
    });
  }

  const usedBathroomPhotos = new Set<number>();
  const bathrooms: ParsedBeddingVision["bathrooms"] = [];
  for (const entry of Array.isArray(rawBathrooms) ? rawBathrooms : []) {
    if (!entry || typeof entry !== "object") continue;
    const photoIndexes = parsePhotoIndexes((entry as any).photos, photoCount, usedBathroomPhotos);
    if (photoIndexes.length === 0) continue;
    const features = (Array.isArray((entry as any).features) ? (entry as any).features : [])
      .map(normalizeScanBathFeature)
      .filter((f: BeddingScanBathFeature | null): f is BeddingScanBathFeature => f != null);
    const isHalf = (entry as any).isHalf === true;
    // No recognizable feature and not a half bath → nothing actionable.
    if (features.length === 0 && !isHalf) continue;
    photoIndexes.forEach((i) => usedBathroomPhotos.add(i));
    bathrooms.push({
      photoIndexes,
      features: Array.from(new Set(features)),
      isHalf,
      confidence: parseConfidence((entry as any).confidence),
    });
  }

  return { bedrooms, bathrooms };
}

// ── Caption fallback (no vision available) ───────────────────────────────────

export type CaptionFallbackFile = {
  filename: string;
  caption?: string;
  category?: string;
  bedroomClusterId?: string;
  bedType?: string;
};

function bedFromCaption(caption: string): DetectedBed | null {
  const t = caption.toLowerCase();
  // A room number ("Bedroom 2 with Queen Bed") is not a bed quantity. Only a
  // number immediately attached to the bed noun, or a plural noun, means two.
  if (/\bking\b/.test(t)) {
    const quantity = /\b(?:two|2)\s+kings?\b|\bkings\b/.test(t) ? 2 : 1;
    return { type: "KING_BED", quantity };
  }
  if (/\bqueen/.test(t)) {
    const quantity = /\b(?:two|2)\s+queens?\b|\bqueens\b/.test(t) ? 2 : 1;
    return { type: "QUEEN_BED", quantity };
  }
  if (/\b(double|full)\b/.test(t)) {
    const quantity = /\b(?:two|2)\s+(?:double|full)s?\b|\b(?:doubles|fulls)\b/.test(t) ? 2 : 1;
    return { type: "DOUBLE_BED", quantity };
  }
  if (/\b(twin|single)/.test(t)) {
    const quantity = /\b(?:two|2)\s+(?:twin|single)s?\b|\b(?:twins|singles)\b/.test(t) ? 2 : 1;
    return { type: "SINGLE_BED", quantity };
  }
  if (/\bbunk/.test(t)) {
    const quantity = /\b(?:two|2)\s+bunks?\b|\bbunks\b/.test(t) ? 2 : 1;
    return { type: "BUNK_BED", quantity };
  }
  return null;
}

function bathFeaturesFromCaption(caption: string): { features: BeddingScanBathFeature[]; isHalf: boolean } {
  const t = caption.toLowerCase();
  const features: BeddingScanBathFeature[] = [];
  if (/jetted|whirlpool|jacuzzi/.test(t)) features.push("jetted-tub");
  else if (/(?:soaking|freestanding|standalone)\s+tub/.test(t)) features.push("soaking-tub");
  else if (/\btub\b/.test(t)) features.push("shower-tub-combo");
  if (/walk-?in shower|\bshower\b/.test(t) && !/\btub\b/.test(t)) features.push("walk-in-shower");
  if (/rain shower/.test(t)) features.push("rain-shower");
  if (/double vanity/.test(t)) features.push("double-vanity");
  const isHalf = /half bath/.test(t);
  return { features: Array.from(new Set(features)), isHalf };
}

/**
 * Label-derived fallback when the vision call can't run. The captions were
 * themselves written by the vision photo-labeler ("King Bedroom",
 * "Bathroom With Jetted Tub"), so this is weaker but not blind. Bedrooms
 * group by the precomputed bedroomClusterId (caption text when absent);
 * bathrooms group by caption.
 */
export function captionFallbackBedding(files: CaptionFallbackFile[]): {
  bedrooms: DetectedBedroom[];
  bathrooms: DetectedBathroom[];
} {
  // This score supports review/audit comparison. Automatic application also
  // requires evidenceMethod:"vision", so stale labels can never auto-push.
  const CAPTION_CONFIDENCE = 0.7;
  const bedroomGroups = new Map<string, { files: string[]; bed: DetectedBed | null }>();
  const bathroomGroups = new Map<string, { files: string[]; features: BeddingScanBathFeature[]; isHalf: boolean }>();
  for (const f of files) {
    const caption = String(f.caption ?? "");
    const category = String(f.category ?? "");
    if (category === "Bedrooms") {
      const key = f.bedroomClusterId || caption.toLowerCase() || f.filename;
      const g = bedroomGroups.get(key) ?? { files: [], bed: null };
      g.files.push(f.filename);
      g.bed = g.bed ?? normalizeScanBedTypeToBed(f.bedType) ?? bedFromCaption(caption);
      bedroomGroups.set(key, g);
    } else if (category === "Bathrooms") {
      const { features, isHalf } = bathFeaturesFromCaption(caption);
      if (features.length === 0 && !isHalf) continue;
      const key = caption.toLowerCase() || f.filename;
      const g = bathroomGroups.get(key) ?? { files: [], features, isHalf };
      g.files.push(f.filename);
      bathroomGroups.set(key, g);
    }
  }
  const bedrooms: DetectedBedroom[] = [];
  for (const g of Array.from(bedroomGroups.values())) {
    if (!g.bed) continue; // caption without a bed type proves nothing
    bedrooms.push({ beds: [g.bed], ensuiteFeatures: [], confidence: CAPTION_CONFIDENCE, photos: g.files });
  }
  const bathrooms: DetectedBathroom[] = [];
  for (const g of Array.from(bathroomGroups.values())) {
    bathrooms.push({ features: g.features, isHalf: g.isHalf, confidence: CAPTION_CONFIDENCE, photos: g.files });
  }
  return { bedrooms, bathrooms };
}

function normalizeScanBedTypeToBed(raw: unknown): DetectedBed | null {
  const type = normalizeScanBedType(raw);
  if (!type) return null;
  // The precomputed bed-type strings can carry "Two Twin Beds"-style labels.
  const qty = /\btwo\b/i.test(String(raw ?? "")) ? 2 : 1;
  return { type, quantity: qty };
}

// ── Apply / merge into the Bedding-tab config ────────────────────────────────

// Structural mirrors of bedding-config.ts types (client-only module — the
// shared layer must not import it). TS structural typing lets the tab pass
// its UnitBeddingConfig straight in.
export type MergeBedroomSlot = {
  roomNumber: number;
  label: string;
  beds: Array<{ type: string; quantity: number }>;
  hasEnsuite: boolean;
  ensuiteFeatures: string[];
};
export type MergeBathroomSlot = {
  id: string;
  label: string;
  isHalf: boolean;
  features: string[];
};
export type MergeUnitShape = {
  bedrooms: MergeBedroomSlot[];
  bathrooms: MergeBathroomSlot[];
};

const BED_SIZE_RANK: Record<BeddingScanBedType, number> = {
  KING_BED: 6,
  QUEEN_BED: 5,
  DOUBLE_BED: 4,
  BUNK_BED: 3,
  SINGLE_BED: 2,
  SOFA_BED: 1,
};

function bedroomRank(b: DetectedBedroom): number {
  return Math.max(0, ...b.beds.map((x) => BED_SIZE_RANK[x.type] ?? 0));
}

export function describeDetectedBeds(beds: DetectedBed[]): string {
  return beds
    .map((b) => `${b.quantity > 1 ? `${b.quantity}× ` : ""}${BEDDING_SCAN_BED_LABELS[b.type] ?? b.type}`)
    .join(" + ");
}

export type BeddingScanMergeResult<T extends MergeUnitShape = MergeUnitShape> = {
  /**
   * The updated unit. Runtime-preserves every extra field of the input via
   * spread (unitId, livingRoom, …) — the Bedding tab casts back to its own
   * UnitBeddingConfig type.
   */
  unit: T;
  /** Human-readable notes on what was applied. */
  applied: string[];
  /** What was deliberately left alone (unphotographed / low confidence / overflow). */
  notes: string[];
  changed: boolean;
};

/**
 * Apply a scan's PHOTO-PROVEN findings onto one unit's bedding config.
 * Only fills what the photos prove:
 *   • confident bedrooms (≥ minConfidence) replace the bed lists of config
 *     slots in size order (biggest bed → Master); unphotographed slots are
 *     untouched and named in `notes`;
 *   • en-suite evidence SETS hasEnsuite + unions features; it never unsets;
 *   • confident bathrooms replace features on existing slots (full↔full,
 *     half↔half, in order); bathroom/bedroom COUNTS never change — those are
 *     listing-level facts the scan can't prove (the same bath can be
 *     photographed twice).
 * The caller chooses whether the confidence boundary is inclusive (manual /
 * audit compatibility) or strict (the explicit Bedding-tab auto-apply flow).
 */
export function mergeBeddingScanIntoUnit<T extends MergeUnitShape>(
  unit: T,
  scan: BeddingScanUnit,
  options: {
    minConfidence?: number;
    requireAboveMinimum?: boolean;
  } = {},
): BeddingScanMergeResult<T> {
  const minConfidence = options.minConfidence ?? BEDDING_SCAN_MIN_CONFIDENCE;
  const eligible = options.requireAboveMinimum
    ? (confidence: number) => isBeddingScanAutoApplyEligible(confidence, minConfidence)
    : (confidence: number) => confidence >= minConfidence;
  const applied: string[] = [];
  const notes: string[] = [];
  let changed = false;

  const confidentBedrooms = scan.bedrooms
    .filter((b) => eligible(b.confidence))
    .slice()
    .sort((a, b) => bedroomRank(b) - bedroomRank(a));
  const lowConfidence = scan.bedrooms.length - confidentBedrooms.length;
  if (lowConfidence > 0) {
    const threshold = `${Math.round(minConfidence * 100)}%`;
    notes.push(options.requireAboveMinimum
      ? `${lowConfidence} detected bedroom${lowConfidence === 1 ? "" : "s"} not above the ${threshold} auto-apply threshold — not applied`
      : `${lowConfidence} detected bedroom${lowConfidence === 1 ? "" : "s"} below the ${threshold} confidence floor — not applied`);
  }

  const bedrooms = unit.bedrooms.map((slot, i) => {
    const detected = confidentBedrooms[i];
    if (!detected) return slot;
    const next = { ...slot, beds: detected.beds.map((b) => ({ type: b.type as string, quantity: b.quantity })) };
    let line = `${slot.label || `Bedroom ${i + 1}`}: ${describeDetectedBeds(detected.beds)}`;
    if (detected.ensuiteFeatures.length > 0) {
      next.hasEnsuite = true;
      next.ensuiteFeatures = Array.from(new Set([...(slot.ensuiteFeatures ?? []), ...detected.ensuiteFeatures]));
      line += ` (en-suite: ${detected.ensuiteFeatures.map((f) => BEDDING_SCAN_FEATURE_LABELS[f]).join(", ")})`;
    }
    applied.push(line);
    changed = true;
    return next;
  });

  if (confidentBedrooms.length > unit.bedrooms.length) {
    const extra = confidentBedrooms.length - unit.bedrooms.length;
    notes.push(`Photos show ${extra} more distinct bedroom${extra === 1 ? "" : "s"} than configured — add bedroom slots manually if real`);
  } else if (confidentBedrooms.length < unit.bedrooms.length) {
    const untouched = unit.bedrooms.slice(confidentBedrooms.length).map((b, i) => b.label || `Bedroom ${confidentBedrooms.length + i + 1}`);
    notes.push(`No photo evidence for ${untouched.join(", ")} — left unchanged (verify manually)`);
  }

  const confidentFullBaths = scan.bathrooms
    .filter((b) => eligible(b.confidence) && !b.isHalf && b.features.length > 0)
    .slice()
    .sort((a, b) => b.features.length - a.features.length);
  const configFullBaths = unit.bathrooms.filter((b) => !b.isHalf);
  const bathFeatureBySlotId = new Map<string, string[]>();
  configFullBaths.forEach((slot, i) => {
    const detected = confidentFullBaths[i];
    if (!detected) return;
    bathFeatureBySlotId.set(slot.id, detected.features.slice());
    applied.push(`${slot.label || `Bath ${i + 1}`}: ${detected.features.map((f) => BEDDING_SCAN_FEATURE_LABELS[f]).join(", ")}`);
    changed = true;
  });
  if (confidentFullBaths.length > configFullBaths.length) {
    notes.push("Photos show more full bathrooms than configured — bathroom count is a listing fact; adjust manually if real");
  }

  const bathrooms = unit.bathrooms.map((slot) => {
    const features = bathFeatureBySlotId.get(slot.id);
    return features ? { ...slot, features } : slot;
  });

  return { unit: { ...unit, bedrooms, bathrooms } as T, applied, notes, changed };
}

export type BeddingScanAutoApplyUnit = {
  unitId: string;
  applied: string[];
  notes: string[];
};

export type BeddingScanAutoApplySkip = {
  unitId: string | null;
  label: string;
  reason: "missing-unit-id" | "duplicate-unit-id" | "no-config-unit" | "non-vision-evidence";
};

/**
 * Auto-apply a fresh scan by canonical unit id. Position is intentionally never
 * used: a unit without published photos is omitted from the scan array, so an
 * index fallback could write Unit B's evidence onto Unit A.
 */
export function autoApplyBeddingScanToUnits<
  T extends MergeUnitShape & { unitId: string },
>(
  units: readonly T[],
  scanUnits: readonly BeddingScanUnit[],
  minimumConfidence: number = BEDDING_SCAN_MIN_CONFIDENCE,
): {
  units: T[];
  appliedUnits: BeddingScanAutoApplyUnit[];
  skippedScanUnits: BeddingScanAutoApplySkip[];
} {
  const scansByUnitId = new Map<string, BeddingScanUnit[]>();
  const skippedScanUnits: BeddingScanAutoApplySkip[] = [];

  for (const scanUnit of scanUnits) {
    const unitId = scanUnit.unitId?.trim();
    if (!unitId) {
      skippedScanUnits.push({ unitId: null, label: scanUnit.label, reason: "missing-unit-id" });
      continue;
    }
    if (scanUnit.evidenceMethod !== "vision") {
      skippedScanUnits.push({ unitId, label: scanUnit.label, reason: "non-vision-evidence" });
      continue;
    }
    const matches = scansByUnitId.get(unitId) ?? [];
    matches.push(scanUnit);
    scansByUnitId.set(unitId, matches);
  }

  const configUnitIds = new Set(units.map((unit) => unit.unitId));
  for (const [unitId, matches] of Array.from(scansByUnitId.entries())) {
    if (matches.length > 1) {
      skippedScanUnits.push(...matches.map((scanUnit) => ({
        unitId,
        label: scanUnit.label,
        reason: "duplicate-unit-id" as const,
      })));
      continue;
    }
    if (!configUnitIds.has(unitId)) {
      skippedScanUnits.push({ unitId, label: matches[0].label, reason: "no-config-unit" });
    }
  }

  const appliedUnits: BeddingScanAutoApplyUnit[] = [];
  const nextUnits = units.map((unit) => {
    const matches = scansByUnitId.get(unit.unitId);
    if (!matches || matches.length !== 1) return unit;
    const result = mergeBeddingScanIntoUnit(unit, matches[0], {
      minConfidence: minimumConfidence,
      requireAboveMinimum: true,
    });
    if (result.changed) {
      appliedUnits.push({ unitId: unit.unitId, applied: result.applied, notes: result.notes });
    }
    return result.unit;
  });

  return { units: nextUnits, appliedUnits, skippedScanUnits };
}

// ── Audit comparison vs the Guesty listing's pushed bed layout ───────────────

export type GuestyRoomLike = { roomNumber: number; beds: DetectedBed[] };

/** Tolerant parse of the Guesty listing document's room array. */
export function parseGuestyListingRoomsForScan(raw: unknown): GuestyRoomLike[] | null {
  if (!Array.isArray(raw)) return null;
  const out: GuestyRoomLike[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const roomNumber = Number((r as any).roomNumber);
    if (!Number.isFinite(roomNumber)) continue;
    const beds: DetectedBed[] = [];
    for (const b of Array.isArray((r as any).beds) ? (r as any).beds : []) {
      const type = normalizeScanBedType(b?.type);
      if (!type) continue;
      const q = Number(b?.quantity);
      beds.push({ type, quantity: Number.isFinite(q) && q > 0 ? Math.trunc(q) : 1 });
    }
    out.push({ roomNumber, beds });
  }
  return out;
}

export type BeddingAuditComparison = {
  /** Receipt lines, ready to append to the layout stage's items. */
  items: string[];
  /** A photo-proven bed-type disagreement with the pushed layout. */
  mismatch: boolean;
  /** Some claimed bedrooms have no photo evidence (honesty note, not a fail). */
  unverified: boolean;
};

export function summarizeDetectedBedding(units: BeddingScanUnit[], minConfidence: number = BEDDING_SCAN_MIN_CONFIDENCE): string {
  const parts: string[] = [];
  for (const u of units) {
    const confident = u.bedrooms.filter((b) => b.confidence >= minConfidence);
    if (confident.length === 0) continue;
    parts.push(confident.map((b) => describeDetectedBeds(b.beds)).join(", "));
  }
  return parts.join(" · ");
}

/**
 * Compare the photo-detected bedding against the Guesty listing's pushed bed
 * layout. TYPE-presence only — never quantities (a second twin can be out of
 * frame) and never "Guesty has a type the photos lack" unless every claimed
 * bedroom is photographed (an unphotographed bedroom could hold it). Sofa beds
 * are excluded entirely (they live in the living room, not a bedroom claim).
 */
export function compareDetectedBeddingToGuestyRooms(
  units: BeddingScanUnit[],
  guestyRooms: GuestyRoomLike[] | null,
  minConfidence: number = BEDDING_SCAN_MIN_CONFIDENCE,
): BeddingAuditComparison {
  const items: string[] = [];
  let mismatch = false;

  const confidentBedrooms = units.flatMap((u) => u.bedrooms.filter((b) => b.confidence >= minConfidence));
  const unphotographed = units.reduce((s, u) => s + Math.max(0, u.unphotographedBedrooms), 0);
  const unverified = unphotographed > 0;

  const detectedTypes = new Set<BeddingScanBedType>();
  for (const b of confidentBedrooms) for (const bed of b.beds) if (bed.type !== "SOFA_BED") detectedTypes.add(bed.type);

  const detectedSummary = summarizeDetectedBedding(units, minConfidence);

  if (confidentBedrooms.length === 0) {
    items.push("Bedding photo check: no bedroom could be confidently identified in the photos — bed types unverifiable");
    return { items, mismatch: false, unverified: true };
  }

  const guestyBedroomRooms = (guestyRooms ?? []).filter((r) => r.roomNumber > 0);
  if (!guestyRooms || guestyBedroomRooms.length === 0) {
    mismatch = true;
    items.push(`Bedding photo check: photos show ${detectedSummary || "photographed bedrooms"}, but the Guesty listing has NO bed layout pushed — open the Bedding tab and click Scan photos for bedding to auto-apply and push`);
  } else {
    const guestyTypes = new Set<BeddingScanBedType>();
    for (const r of guestyBedroomRooms) for (const bed of r.beds) if (bed.type !== "SOFA_BED") guestyTypes.add(bed.type);

    for (const t of Array.from(detectedTypes)) {
      if (!guestyTypes.has(t)) {
        mismatch = true;
        items.push(`Bedding photo check: photos show a ${BEDDING_SCAN_BED_LABELS[t]} but the pushed Guesty bed layout lists none — update the Bedding tab and push`);
      }
    }
    // Only when EVERY claimed bedroom is photographed can a missing type be a
    // real finding — otherwise the unphotographed room could hold it.
    if (!unverified && confidentBedrooms.length >= guestyBedroomRooms.length) {
      for (const t of Array.from(guestyTypes)) {
        if (!detectedTypes.has(t)) {
          mismatch = true;
          items.push(`Bedding photo check: Guesty advertises a ${BEDDING_SCAN_BED_LABELS[t]} but no photographed bedroom shows one — verify the Bedding tab against the photos`);
        }
      }
    }
    if (confidentBedrooms.length > guestyBedroomRooms.length) {
      mismatch = true;
      items.push(`Bedding photo check: photos show ${confidentBedrooms.length} distinct bedrooms but the pushed layout has ${guestyBedroomRooms.length} — the Guesty bed layout is missing bedrooms`);
    }
    if (!mismatch) {
      items.push(`Bedding photo check: photographed beds match the pushed Guesty layout (${detectedSummary}) ✓`);
    }
  }

  if (unverified) {
    items.push(`Bedding photo check: ${unphotographed} claimed bedroom${unphotographed === 1 ? "" : "s"} ha${unphotographed === 1 ? "s" : "ve"} no bedroom photo — bed types for ${unphotographed === 1 ? "it" : "them"} are unverifiable from photos`);
  }

  return { items, mismatch, unverified };
}

// ── Store (de)serialization ──────────────────────────────────────────────────

export function parseBeddingScanStore(raw: string | null | undefined): Record<string, BeddingPhotoScanRecord> {
  if (!raw) return Object.create(null);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.create(null);
    const out: Record<string, BeddingPhotoScanRecord> = Object.create(null);
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = value as BeddingPhotoScanRecord;
      if (!rec || typeof rec !== "object" || !Array.isArray((rec as any).units)) continue;
      if (typeof (rec as any).scannedAt !== "string") continue;
      out[key] = rec;
    }
    return out;
  } catch {
    return Object.create(null);
  }
}

export function serializeBeddingScanStore(
  map: Record<string, BeddingPhotoScanRecord>,
  cap: number = BEDDING_SCAN_STORE_CAP,
): string {
  const entries = Object.entries(map)
    .sort((a, b) => String(b[1]?.scannedAt ?? "").localeCompare(String(a[1]?.scannedAt ?? "")))
    .slice(0, Math.max(1, cap));
  return JSON.stringify(Object.fromEntries(entries));
}
