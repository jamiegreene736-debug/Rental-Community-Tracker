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
