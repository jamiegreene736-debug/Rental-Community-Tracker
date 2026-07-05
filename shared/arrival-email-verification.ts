// Verbatim-evidence verification for arrival details extracted from guest
// alias emails (door codes, Wi-Fi, parking, address).
//
// The extraction layer (server/arrival-email-extract.ts) may use an LLM to
// read the full email like a human — which is what actually catches
// "LOBBY CODE: 1025 / POOL CODE: 5747 / DOOR CODE: 3438*" style emails the
// regex parser drops fields from. The LLM is NOT trusted: every field it
// returns must cite a verbatim quote from a specific email, and this module
// verifies (a) the quote really appears in that email and (b) the value
// really appears in the email (for codes: digit-for-digit). A value that
// fails verification is discarded, so a hallucinated door code can never
// reach the guest message. This is what makes the pipeline "as close to
// 100% as extraction can be": attribution is exact (the alias is unique per
// buy-in), and content is exact (only strings the host actually wrote
// survive).

export const ARRIVAL_EMAIL_SCALAR_FIELDS = [
  "unitAddress",
  "accessCode",
  "wifiName",
  "wifiPassword",
  "parkingInfo",
] as const;

export type ArrivalEmailScalarField = typeof ARRIVAL_EMAIL_SCALAR_FIELDS[number];

export type ArrivalExtractionFieldRecord = {
  value: string;
  /** Verbatim excerpt from the source email that contains the value. */
  quote?: string;
  /** Subject of the email the value came from. */
  sourceSubject?: string;
  sourceFrom?: string;
  /** ISO date of the source email. */
  sourceDate?: string;
  /** True when the value passed verbatim verification against the email text. */
  verified: boolean;
};

export type ArrivalExtractionRecord = {
  method: "claude" | "regex";
  extractedAt: string;
  aliasEmail?: string;
  messageCount: number;
  fields: Partial<Record<ArrivalEmailScalarField | "arrivalNotes", ArrivalExtractionFieldRecord>>;
  /** Field keys where two emails disagreed (newest email's value was used). */
  conflicts?: string[];
  /** True when the email points at a guest portal login and details may live behind it. */
  portalHint?: boolean;
  error?: string;
};

function collapse(text: string): string {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Strip everything except letters/digits/#/* so "3438 *" matches "3438*". */
function compactToken(text: string): string {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9#*]/g, "");
}

function digitRunsOf(text: string): string[] {
  return String(text ?? "").match(/\d{2,}/g) ?? [];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every digit-bearing token of `value` must appear as a whole word in `text`. */
function digitTokensPresentAsWords(value: string, text: string): boolean {
  const tokens = collapse(value).split(" ").filter((t) => /\d/.test(t));
  return tokens.every((t) =>
    new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`).test(collapse(text)),
  );
}

/**
 * Does `value` appear verbatim in `emailText`?
 * - Codes must match compacted (whitespace/punctuation-insensitive) so
 *   "3438 *" == "3438*", but every digit must be the host's.
 * - Texty fields accept a whitespace-collapsed substring match, or (HTML
 *   mangling tolerance) >=90% of significant tokens present AND every digit
 *   run present — a paraphrase that invents numbers always fails.
 */
export function valueVerbatimInText(
  field: ArrivalEmailScalarField | "arrivalNotes",
  value: string,
  emailText: string,
): boolean {
  const v = String(value ?? "").trim();
  const text = String(emailText ?? "");
  if (!v || !text) return false;

  if (field === "accessCode") {
    const compactValue = compactToken(v);
    if (!compactValue) return false;
    return compactToken(text).includes(compactValue);
  }

  const collapsedText = collapse(text);
  if (collapsedText.includes(collapse(v))) return true;

  const tokens = collapse(v).split(" ").filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const present = tokens.filter((t) => collapsedText.includes(t)).length;
  if (present / tokens.length < 0.9) return false;
  // Numbers are the payload — a paraphrase that invents or alters ANY digit
  // token ("maximum of 3 vehicles" when the host wrote 2) must fail even when
  // the surrounding words all match.
  return digitTokensPresentAsWords(v, text);
}

/** Verify one extracted field against its cited email; returns the verified record or null. */
export function verifyExtractedField(
  field: ArrivalEmailScalarField | "arrivalNotes",
  candidate: { value?: unknown; quote?: unknown },
  emailText: string,
): { value: string; quote: string } | null {
  const value = String(candidate?.value ?? "").trim();
  const quote = String(candidate?.quote ?? "").trim();
  if (!value || !quote) return null;
  // The quote itself must exist in the email (whitespace-insensitive).
  if (!collapse(emailText).includes(collapse(quote)) && !valueVerbatimInText(field, quote, emailText)) {
    return null;
  }
  // Any digits the extractor put in the value must come from its own quote —
  // catches a real quote paired with an invented number.
  const compactQuote = compactToken(quote);
  if (!digitRunsOf(value).every((run) => compactQuote.includes(run))) return null;

  if (field === "arrivalNotes") {
    // Note lines are extractor-formatted "Label: value" — the label is
    // authored, but the payload after ":" must be lifted from the quote:
    // every digit token as a whole word, and most words present.
    const payload = value.includes(":") ? value.slice(value.indexOf(":") + 1).trim() : value;
    if (!payload) return null;
    if (!digitTokensPresentAsWords(payload, quote)) return null;
    const tokens = collapse(payload).split(" ").filter((t) => t.length >= 3);
    if (tokens.length) {
      const present = tokens.filter((t) => collapse(quote).includes(t)).length;
      if (present / tokens.length < 0.6) return null;
    }
    return { value, quote };
  }

  // Scalar fields: the value must be verbatim in the email (not just "supported by" it).
  if (!valueVerbatimInText(field, value, emailText)) return null;
  return { value, quote };
}

const PORTAL_LINK_RE = /guest\s*portal|portal\s*access|log\s*in\s+to\s+(?:your|the)\s+portal|trackhs\.com\/guest|guestportal|door code will appear in the guest portal/i;

/** Emails that defer details to a login portal — surfaced as an operator hint. */
export function hasGuestPortalHint(emailText: string): boolean {
  return PORTAL_LINK_RE.test(String(emailText ?? ""));
}

/** Human summary of an extraction record for logs/UI fallbacks. */
export function summarizeArrivalExtraction(record: ArrivalExtractionRecord | null | undefined): string {
  if (!record) return "";
  const fields = Object.entries(record.fields ?? {})
    .filter(([, rec]) => rec?.verified && rec.value)
    .map(([key]) => key);
  if (!fields.length) return "";
  const src = record.method === "claude" ? "email (verified)" : "email";
  return `${fields.join(", ")} from ${src}`;
}
