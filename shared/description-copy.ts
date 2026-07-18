// Pure helpers for the unit-builder Descriptions tab copy pipeline.
// Shared between the client builder (adapt-draft.ts, builder.tsx,
// GuestyListingBuilder) and the server (push-descriptions guard, the
// reflow-description-disclaimers repair route), so the three summary
// assemblers can't drift apart again.
//
// Background (2026-07-10): /api/community/generate-listing stores a FLAT
// description on the draft — summary + space + "THE NEIGHBORHOOD" +
// "GETTING AROUND" sections glued together for the wizard's Step-5
// textarea. The builder ALSO pushes neighborhood/transit as their own
// Guesty publicDescription fields, so leaving those sections inside the
// summary duplicated them on every OTA (with raw ALL-CAPS headers
// mid-summary). stripAreaSectionsFromDescription removes them at the
// point the flat description becomes a listing summary.

/** Section headers the generate-listing endpoint glues into the flat
 * draft description. Matched as whole lines (case-insensitive) so prose
 * that merely mentions "the neighborhood" is never truncated. */
export const AREA_SECTION_HEADERS = ["THE NEIGHBORHOOD", "GETTING AROUND"] as const;

const AREA_HEADER_RE = /^(?:the neighborhood|getting around)\s*:?\s*$/i;

/**
 * Remove the "THE NEIGHBORHOOD" / "GETTING AROUND" headed sections from a
 * flat draft description. The generator always appends them AFTER the
 * summary/space body, so everything from the first header line onward is
 * dropped. Text without a standalone header line passes through unchanged.
 */
export function stripAreaSectionsFromDescription(text: string): string {
  const raw = String(text ?? "");
  if (!raw.trim()) return raw.trim();
  const lines = raw.split("\n");
  const headerIdx = lines.findIndex((line) => AREA_HEADER_RE.test(line.trim()));
  if (headerIdx === -1) return raw.trim();
  return lines
    .slice(0, headerIdx)
    .join("\n")
    // Drop a trailing paragraph-separator / "---" divider left behind.
    .replace(/(?:\s*-{3,}\s*)+$/, "")
    .trim();
}

/**
 * Known scaffolding phrases from generate-listing's no-key / Claude-error
 * fallback copy. These are operator instructions ("Add specific nearby
 * landmarks … before publishing") that must never reach a live OTA
 * listing. tests/description-copy.test.ts source-asserts that the
 * fallback copy in server/routes.ts stays covered by this list — when
 * you edit a fallback sentence there, update this list in the same PR.
 */
export const DESCRIPTION_PLACEHOLDER_PHRASES: readonly string[] = [
  "add specific nearby landmarks and drive times before publishing",
  "add airport distance, parking details, and walkability notes",
  "once the exact unit details are confirmed",
  "once the exact units are confirmed",
  "once the exact unit location is confirmed",
  "update the bedroom layout, bedding, bathrooms, and amenities",
  "update bedding, bathrooms, and amenity details",
];

export type DescriptionPlaceholderHit = { field: string; phrase: string };

/**
 * Scan description fields for fallback scaffolding phrases. Returns one
 * hit per (field, phrase) pair; empty array = clean. Case-insensitive
 * substring match — the phrases are long enough that false positives on
 * operator-written copy are implausible.
 */
export function findDescriptionPlaceholders(
  fields: Record<string, string | null | undefined>,
): DescriptionPlaceholderHit[] {
  const hits: DescriptionPlaceholderHit[] = [];
  for (const [field, value] of Object.entries(fields ?? {})) {
    const text = String(value ?? "").toLowerCase();
    if (!text) continue;
    for (const phrase of DESCRIPTION_PLACEHOLDER_PHRASES) {
      if (text.includes(phrase)) hits.push({ field, phrase });
    }
  }
  return hits;
}

/** Descriptions-tab fields the operator can override per property
 * (property_description_overrides). `notes` is deliberately absent —
 * publicDescription.notes is owned by the compliance push. */
export const DESCRIPTION_OVERRIDE_FIELDS = [
  "title",
  "summary",
  "space",
  "neighborhood",
  "transit",
  "access",
  "houseRules",
] as const;
export type PropertyDescriptionOverrideField = (typeof DESCRIPTION_OVERRIDE_FIELDS)[number];

export type DescriptionReadbackMismatch = {
  field: string;
  sent: string;
  saved: string;
};

/**
 * Guesty may normalize line endings and surrounding whitespace while storing
 * public-description fields. Those representation-only changes are accepted;
 * every character inside the trimmed value must still round-trip exactly.
 */
export function normalizeDescriptionReadback(value: unknown): string {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

/** Compare only fields included in the write payload. */
export function findDescriptionReadbackMismatches(
  sent: Record<string, unknown>,
  saved: Record<string, unknown>,
): DescriptionReadbackMismatch[] {
  const mismatches: DescriptionReadbackMismatch[] = [];
  for (const [field, value] of Object.entries(sent)) {
    const normalizedSent = normalizeDescriptionReadback(value);
    const normalizedSaved = normalizeDescriptionReadback(saved[field]);
    if (normalizedSent !== normalizedSaved) {
      mismatches.push({ field, sent: normalizedSent, saved: normalizedSaved });
    }
  }
  return mismatches;
}

/** Paragraph separator used between disclosure blocks and the summary
 * body — mirrored by the client builder and the server reflow route. */
export const SUMMARY_DISCLOSURE_SEPARATOR = "\n\n---\n\n";

/**
 * Compose the Guesty summary from its parts: optional top disclosure
 * (combo setup), the description body, and the bottom disclosure
 * (representative accommodations / single-listing sample). Disclosure
 * TEXT stays owned by client/src/data/unit-builder-data.ts (and the
 * server mirror); this helper only owns placement + separators.
 */
export function composeSummaryWithDisclosures(
  body: string,
  disclosures: { top?: string | null; bottom?: string | null },
): string {
  return [disclosures.top ?? "", String(body ?? "").trim(), disclosures.bottom ?? ""]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(SUMMARY_DISCLOSURE_SEPARATOR);
}

/**
 * Compose "The Space" from per-unit long descriptions plus the optional
 * walking-distance line — the same shape builder.tsx assembles for the
 * Descriptions tab, reused by the Regenerate-descriptions flow.
 */
export function composeSpaceFromUnitDescriptions(
  units: Array<{ label: string; text: string }>,
  walkDescription?: string | null,
): string {
  const body = (units ?? [])
    .filter((u) => String(u?.text ?? "").trim())
    .map((u) => `${u.label}: ${String(u.text).trim()}`)
    .join("\n\n");
  const walk = String(walkDescription ?? "").trim();
  return [body, walk].filter(Boolean).join("\n\n");
}

// ── Generator grounding (2026-07-17) ─────────────────────────────────────────
// The Descriptions-tab "↻ Regenerate descriptions" button and the audit
// sweep's regenerate twin ground /api/community/generate-listing in what the
// system actually KNOWS about the property: the per-photo Claude-vision
// captions (photo_labels), the saved Amenities-tab set, and — from the
// client only, because it lives in browser localStorage — the operator's
// CONFIRMED Bedding-tab config. These helpers are the pure pieces of that
// grounding: snippet clamping, caption digests, and the bed-type accuracy
// audit that backs the endpoint's single corrective retry.

/** Same cap as the endpoint's source-listing fact snippet: enough for a
 * full gallery digest, small enough that no fact line can blow up the
 * prompt. */
export const GROUNDING_SNIPPET_MAX_CHARS = 700;

/** Collapse whitespace and cap a grounding fact line for prompt use. */
export function clampGroundingSnippet(
  text: unknown,
  maxChars: number = GROUNDING_SNIPPET_MAX_CHARS,
): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

/**
 * Digest a gallery's photo captions into one prompt-ready line: order
 * preserved (hero-first), case-insensitive dedupe (thirty "Ocean View
 * Lanai" shots contribute one entry), capped so a huge gallery stays a
 * digest rather than a dump.
 */
export function photoCaptionDigest(
  captions: Array<string | null | undefined>,
  opts?: { maxItems?: number },
): string {
  const maxItems = Math.max(1, opts?.maxItems ?? 40);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of captions ?? []) {
    const caption = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!caption) continue;
    const key = caption.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(caption);
    if (out.length >= maxItems) break;
  }
  return out.join("; ");
}

/**
 * Bed-type accuracy audit for generated copy against a CONFIRMED
 * Bedding-tab string (describeUnitBedding shape — bed types appear as
 * bare labels like "King" / "2 Twin / Singles" / "sofa bed").
 *
 * Prose patterns deliberately require the word "bed"/"bedroom" next to
 * the size token ("king bed", "Queen Bedroom") so phrases like "a single
 * bedroom unit" or "full kitchen" can't false-positive; "single"/"full"
 * additionally never match on "bedroom". Returns the canonical labels of
 * bed types the prose claims but the confirmed config does not contain —
 * empty when the confirmed string is empty (no basis to audit).
 */
const BED_TYPE_MENTION_PATTERNS: ReadonlyArray<{
  label: string;
  prose: RegExp;
  confirmed: RegExp;
}> = [
  { label: "King bed", prose: /\b(?:california\s+)?king(?:[-\s]sized?)?\s+bed(?:room)?s?\b/i, confirmed: /\bking\b/i },
  { label: "Queen bed", prose: /\bqueen(?:[-\s]sized?)?\s+bed(?:room)?s?\b/i, confirmed: /\bqueen\b/i },
  { label: "Double/Full bed", prose: /\b(?:double(?:[-\s]sized?)?\s+bed(?:room)?s?|full(?:[-\s]sized?)?\s+beds?)\b/i, confirmed: /\b(?:double|full)\b/i },
  { label: "Twin/Single bed", prose: /\b(?:twin(?:[-\s]sized?)?\s+bed(?:room)?s?|single(?:[-\s]sized?)?\s+beds?)\b/i, confirmed: /\b(?:twin|single)\b/i },
  { label: "Bunk bed", prose: /\bbunk\s+bed(?:room)?s?\b/i, confirmed: /\bbunk\b/i },
  { label: "Sofa bed", prose: /\b(?:sofa\s*-?\s*beds?|sleeper\s+sofas?|sofa\s+sleepers?|pull[-\s]?out\s+(?:sofa|couch|bed)s?)\b/i, confirmed: /\bsofa\s*bed\b/i },
];

export function unconfirmedBedTypeMentions(
  prose: string | null | undefined,
  confirmedBedding: string | null | undefined,
): string[] {
  const text = String(prose ?? "");
  const confirmed = String(confirmedBedding ?? "").trim();
  if (!text.trim() || !confirmed) return [];
  const out: string[] = [];
  for (const pattern of BED_TYPE_MENTION_PATTERNS) {
    if (pattern.prose.test(text) && !pattern.confirmed.test(confirmed)) {
      out.push(pattern.label);
    }
  }
  return out;
}
