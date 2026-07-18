import { occupancyForBedrooms } from "./occupancy";

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

// ── Sleeping-capacity explanation (2026-07-18) ───────────────────────────────
// Guests kept asking "how does a 4 bedroom sleep 12?" — the listings advertised
// the headline occupancy but never showed the arithmetic behind it. That
// arithmetic is not new: `occupancyForBedrooms` has always been "2 guests per
// bedroom + sleeper sofas" (+2 for a single condo, +4 for the two-condo
// combos). These helpers turn that rule into one guest-facing paragraph so
// every listing SHOWS its own math.
//
// Derived, never asserted independently: the totals come straight from
// occupancyForBedrooms, so this paragraph can never disagree with the title's
// "Sleeps N", the dashboard Guests column, or the Guesty `accommodates` field.
// A shape the rule cannot explain (0 bedrooms, a non-even sofa remainder)
// returns null and NOTHING is claimed — never invent a breakdown to fill a gap.

/** Sofa beds are described WITHOUT a size. The Bedding tab's living-room
 * config captures only a count (`hasSofaBed`/`count`, no bed size), so
 * "queen sleeper sofa" would be an invented fact — the same rule
 * buildSpaceDescription follows ("Never claim a size for the sofa bed"). */
export type SleepingCapacityExplanation = {
  /** Total bedrooms across every unit on the listing. */
  bedrooms: number;
  /** Units the listing is assembled from (1 = standalone, 2 = combo). */
  unitCount: number;
  /** Headline occupancy — occupancyForBedrooms(bedrooms). */
  sleeps: number;
  /** Guests the bedrooms alone hold, at 2 per bedroom. */
  bedroomGuests: number;
  /** Guests the sleeper sofas add (sleeps - bedroomGuests). */
  sofaGuests: number;
  /** Sleeper sofas implied by the occupancy rule, at 2 guests each. */
  sofaCount: number;
  /** The guest-facing paragraph. ASCII-only (Booking.com mangles the rest). */
  sentence: string;
};

/**
 * Build the "here is how a 4-bedroom sleeps 12" paragraph for a listing.
 *
 * Returns null when the occupancy rule cannot produce a clean breakdown —
 * no bedrooms, no headline occupancy, or a sofa remainder that isn't a whole
 * number of 2-guest sofas. Callers must treat null as "say nothing".
 */
export function buildSleepingCapacityExplanation(input: {
  bedrooms: number;
  unitCount: number;
}): SleepingCapacityExplanation | null {
  const bedrooms = Number(input?.bedrooms);
  const unitCount = Number(input?.unitCount);
  if (!Number.isFinite(bedrooms) || bedrooms <= 0) return null;
  if (!Number.isFinite(unitCount) || unitCount < 1) return null;

  const sleeps = occupancyForBedrooms(bedrooms);
  const bedroomGuests = bedrooms * 2;
  const sofaGuests = sleeps - bedroomGuests;
  // The rule always leaves a positive, even sofa remainder (+2 or +4). Anything
  // else means the rule changed underneath us — stay silent rather than print
  // arithmetic that doesn't add up in front of a guest.
  if (sofaGuests <= 0 || sofaGuests % 2 !== 0) return null;
  const sofaCount = sofaGuests / 2;

  // The rule only describes ONE sleeper sofa per unit — +2 for a standalone
  // condo, +4 for a two-condo combo. Any other shape (a standalone carrying the
  // combo +4, which would claim two sleeper sofas in one living room; or a
  // multi-unit listing whose sofa count doesn't cover its units) is one we
  // cannot describe truthfully, so we say NOTHING. The headline occupancy still
  // stands, it just goes unexplained — better than a guessed layout.
  if (sofaCount !== unitCount) return null;

  const sofaClause =
    unitCount > 1
      ? `each of the ${unitCount} units has a sleeper sofa in the living area that sleeps 2`
      : "the living area has a sleeper sofa that sleeps 2";

  const bedroomNoun = bedrooms === 1 ? "bedroom sleeps" : "bedrooms sleep";
  const sentence =
    `Here is how a ${bedrooms}-bedroom listing sleeps ${sleeps}: the ${bedrooms} ${bedroomNoun} ` +
    `${bedroomGuests} guests at 2 per bedroom, and ${sofaClause}, which adds ${sofaGuests} more. ` +
    `${bedroomGuests} plus ${sofaGuests} is ${sleeps} guests in total.`;

  return { bedrooms, unitCount, sleeps, bedroomGuests, sofaGuests, sofaCount, sentence };
}

/**
 * The occupancy a listing TITLE advertises, or null when it names none.
 *
 * Mirrors the two title formats generate-listing pins with syncTitleOccupancy
 * ("... - Sleeps 14" and "6BR for 16 ..."), so a stale title can be caught
 * before we publish prose that contradicts it in front of a guest. Title text
 * is guest-visible in a way `accommodates` is not, so it gets its own check.
 */
export function advertisedOccupancyFromTitle(title: string | null | undefined): number | null {
  const text = String(title ?? "");
  const match = text.match(/\bsleeps\s+(\d{1,2})\b/i) ?? text.match(/\bfor\s+(\d{1,2})\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Sofa-bed wording a capacity explanation may use — shared with the bed-type
 * audit's sofa pattern below so the two can't drift. */
const SOFA_BED_MENTION_RE =
  /\b(?:sofa\s*-?\s*beds?|sleeper\s+sofas?|sofa\s+sleepers?|pull[-\s]?out\s+(?:sofa|couch|bed)s?)\b/i;

/**
 * Does this prose already explain the sleeping capacity?
 *
 * Accepts any wording that names a sleeper sofa AND both numbers (bedroom
 * guests and the total) — not just our canonical sentence, because the prompt
 * asks Claude to write its own version and a false NEGATIVE would append a
 * second, duplicate explanation to live guest copy.
 *
 * All three signals must land in the SAME PARAGRAPH. Scanning the whole
 * summary was too loose in practice: a live 5BR listing (sleeps 14, 10 bedroom
 * guests) matched on a "sofa bed" in its Unit A blurb, "14 guests" in its
 * opening line, and the 10 from "a short 10-minute walk" three paragraphs
 * later — three unrelated facts read as an explanation, so the backfill
 * skipped a listing that was genuinely unexplained. A real explanation states
 * its arithmetic in one breath.
 */
export function describesSleepingCapacity(
  text: string | null | undefined,
  explanation: SleepingCapacityExplanation | null | undefined,
): boolean {
  const body = String(text ?? "");
  if (!body.trim() || !explanation) return false;
  const mentions = (paragraph: string, n: number) => new RegExp(`\\b${n}\\b`).test(paragraph);
  return body
    .split(/\n\s*\n/)
    .some((paragraph) =>
      SOFA_BED_MENTION_RE.test(paragraph)
      && mentions(paragraph, explanation.sleeps)
      && mentions(paragraph, explanation.bedroomGuests));
}

/** Distinctive leads of the disclosure blocks the builder sandwiches around a
 * summary body (client/src/data/unit-builder-data.ts). The capacity paragraph
 * belongs to the BODY, so placement must never land inside one of these.
 * tests/description-copy.test.ts source-asserts these stay in sync with the
 * disclosure constants — reword a disclosure there, update this list. */
export const SUMMARY_DISCLOSURE_LEADS: readonly string[] = [
  "unit assignment note:",
  "please note: this listing combines two units",
];

function looksLikeDisclosureBlock(block: string): boolean {
  const head = String(block ?? "").trim().toLowerCase();
  return SUMMARY_DISCLOSURE_LEADS.some((lead) => head.startsWith(lead));
}

/**
 * Ensure a composed Guesty summary carries the capacity explanation exactly
 * once, as a paragraph of the summary BODY.
 *
 * A composed summary is `[top disclosure?] --- body --- [bottom disclosure]`
 * (SUMMARY_DISCLOSURE_SEPARATOR). Appending blindly would push the paragraph
 * below the "Unit assignment note" legalese; this targets the LAST
 * non-disclosure block instead, so a combo (top/body/bottom) and a single
 * listing (body/bottom) both land in the right place. When every block is a
 * disclosure the paragraph becomes its own block ahead of the final one,
 * rather than being swallowed by one.
 */
export function ensureSleepingCapacityExplanation(
  summary: string | null | undefined,
  explanation: SleepingCapacityExplanation | null | undefined,
): string {
  const text = String(summary ?? "");
  if (!explanation) return text;
  if (describesSleepingCapacity(text, explanation)) return text;
  if (!text.trim()) return explanation.sentence;

  const blocks = text.split(SUMMARY_DISCLOSURE_SEPARATOR);
  let target = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].trim() && !looksLikeDisclosureBlock(blocks[i])) {
      target = i;
      break;
    }
  }
  if (target === -1) {
    const insertAt = Math.max(0, blocks.length - 1);
    blocks.splice(insertAt, 0, explanation.sentence);
    return blocks.join(SUMMARY_DISCLOSURE_SEPARATOR);
  }
  blocks[target] = `${blocks[target].trim()}\n\n${explanation.sentence}`;
  return blocks.join(SUMMARY_DISCLOSURE_SEPARATOR);
}

/** The CONTEXT + rule lines that make Claude write this explanation itself.
 * Kept next to the deterministic helpers so the prompt and the fallback can
 * never describe different arithmetic. */
export function sleepingCapacityPromptContext(
  explanation: SleepingCapacityExplanation | null | undefined,
): string {
  if (!explanation) return "";
  const { bedrooms, sleeps, bedroomGuests, sofaGuests, sofaCount, unitCount } = explanation;
  const sofaWhere =
    unitCount > 1 && sofaCount === unitCount
      ? `one sleeper sofa in the living area of each of the ${unitCount} units`
      : `${sofaCount} sleeper sofa${sofaCount === 1 ? "" : "s"} in the living area`;
  return (
    `- Sleeping capacity math (authoritative — use these exact numbers): ${bedrooms} bedrooms sleep ` +
    `${bedroomGuests} guests at 2 per bedroom, plus ${sofaWhere} sleeping 2 each for ${sofaGuests} more, ` +
    `so the listing sleeps ${sleeps} in total.`
  );
}

export const SLEEPING_CAPACITY_RULE =
  "- The summary MUST explain how the listing reaches its advertised total occupancy, because guests routinely ask how a 4-bedroom sleeps 12. Use the sleeping capacity math from CONTEXT: state the guests the bedrooms hold at 2 per bedroom, that the sleeper sofa in each unit's living area sleeps 2 more, and the resulting total. Name both numbers as digits. Never claim a size for a sleeper sofa (never 'queen sleeper sofa') and never state totals that differ from the CONTEXT math.";

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
 * bare labels like "King" / "2 Twin / Singles" / "2 Queens" / "sofa
 * bed").
 *
 * Prose patterns deliberately require the word "bed"/"bedroom" next to
 * the size token ("king bed", "Queen Bedroom") so phrases like "a single
 * bedroom unit" or "full kitchen" can't false-positive; "single"/"full"
 * additionally never match on "bedroom". Confirmed patterns tolerate
 * describeUnitBedding's bare-"s" pluralization ("2 Kings", "2 sofa
 * beds"). Returns the canonical labels of bed types the prose claims but
 * the confirmed config does not contain — empty when the confirmed
 * string is empty (no basis to audit).
 *
 * `confirmedBedding` may be one describeUnitBedding string or an array
 * of them (one per unit, for a whole-listing audit). Each entry is cut
 * at its own "Bathrooms:" section BEFORE matching — bathroom labels and
 * features ("Full Bath", "Double vanity") would otherwise satisfy the
 * confirmed regexes and mask an invented double/full bed. The living-
 * room sofa line precedes "Bathrooms:", so sofa evidence survives the
 * cut.
 */
const BED_TYPE_MENTION_PATTERNS: ReadonlyArray<{
  label: string;
  prose: RegExp;
  confirmed: RegExp;
}> = [
  { label: "King bed", prose: /\b(?:california\s+)?king(?:[-\s]sized?)?\s+bed(?:room)?s?\b/i, confirmed: /\bkings?\b/i },
  { label: "Queen bed", prose: /\bqueen(?:[-\s]sized?)?\s+bed(?:room)?s?\b/i, confirmed: /\bqueens?\b/i },
  { label: "Double/Full bed", prose: /\b(?:double(?:[-\s]sized?)?\s+bed(?:room)?s?|full(?:[-\s]sized?)?\s+beds?)\b/i, confirmed: /\b(?:double|full)s?\b/i },
  { label: "Twin/Single bed", prose: /\b(?:twin(?:[-\s]sized?)?\s+bed(?:room)?s?|single(?:[-\s]sized?)?\s+beds?)\b/i, confirmed: /\b(?:twin|single)s?\b/i },
  { label: "Bunk bed", prose: /\bbunk\s+bed(?:room)?s?\b/i, confirmed: /\bbunk\b/i },
  // Reuses SOFA_BED_MENTION_RE (declared above) so the capacity-explanation
  // detector and this audit can never recognise different sofa wording.
  { label: "Sofa bed", prose: SOFA_BED_MENTION_RE, confirmed: /\bsofa\s*beds?\b/i },
];

/** The bed-claims portion of a describeUnitBedding string: everything
 * before its "Bathrooms:" section. */
export function confirmedBeddingBedPortion(confirmed: string | null | undefined): string {
  return String(confirmed ?? "").split(/\bbathrooms\s*:/i)[0].trim();
}

export function unconfirmedBedTypeMentions(
  prose: string | null | undefined,
  confirmedBedding: string | string[] | null | undefined,
): string[] {
  const text = String(prose ?? "");
  const confirmed = (Array.isArray(confirmedBedding) ? confirmedBedding : [confirmedBedding])
    .map((entry) => confirmedBeddingBedPortion(entry))
    .filter(Boolean)
    .join(" ");
  if (!text.trim() || !confirmed) return [];
  const out: string[] = [];
  for (const pattern of BED_TYPE_MENTION_PATTERNS) {
    if (pattern.prose.test(text) && !pattern.confirmed.test(confirmed)) {
      out.push(pattern.label);
    }
  }
  return out;
}

/**
 * Structural-completeness comparison between the first generated draft
 * and its bedding-accuracy corrective retry: field names that were
 * non-empty in the first parse but are empty/missing in the retry. The
 * retry is only adopted when this is EMPTY — an audit-clean retry that
 * dropped unitA (or gutted a longDescription) must never replace a
 * complete first draft, because the response assembly would silently
 * substitute generic fallback filler for the missing pieces.
 */
export function generatedDraftCompletenessRegressions(first: unknown, retry: unknown): string[] {
  const f = (first ?? {}) as Record<string, unknown>;
  const r = (retry ?? {}) as Record<string, unknown>;
  const filled = (v: unknown) => String(v ?? "").trim().length > 0;
  const out: string[] = [];
  for (const field of ["title", "bookingTitle", "summary", "space", "neighborhood", "transit", "access", "houseRules"]) {
    if (filled(f[field]) && !filled(r[field])) out.push(field);
  }
  for (const unit of ["unitA", "unitB"]) {
    const fu = f[unit];
    if (!fu || typeof fu !== "object") continue;
    const ru = r[unit];
    if (!ru || typeof ru !== "object") { out.push(unit); continue; }
    for (const key of ["bedding", "shortDescription", "longDescription"]) {
      if (filled((fu as Record<string, unknown>)[key]) && !filled((ru as Record<string, unknown>)[key])) {
        out.push(`${unit}.${key}`);
      }
    }
  }
  return out;
}
