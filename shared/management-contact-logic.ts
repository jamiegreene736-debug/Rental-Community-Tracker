// Pure logic for the "Confirm on-site management contact" buy-in feature.
//
// Scenario (operator, 2026-07-20): a buy-in is booked, the confirmation email
// is in the unit's alias inbox, but the ARRIVAL DETAILS haven't been sent yet.
// The operator needs the LOCAL ON-SITE management company's contact details so
// they (or a Back-Office Task for the agent team) can call/message and chase
// the arrival info. This module builds the Claude web-search prompt, strictly
// parses the response, and — the load-bearing part — VALIDATES it so an
// invented phone number or email address can never be saved:
//
//   · email-sourced contacts must be verbatim-present in the cited email
//     (phone compared digit-for-digit, email/company case-insensitively);
//   · listing-page / web-sourced contacts must carry a real http(s) source URL
//     and clear a confidence floor;
//   · nothing confident → an honest "not found", never a guess.
//
// The confirmed values land in the EXISTING arrival-information columns
// buy_ins.managementCompany / managementContact (already rendered as
// "Local contact:" in the guest arrival-details message and used to pre-fill
// the PM compose form), plus a provenance record in
// buy_ins.managementContactSource. Keep this module free of Node/DB/React
// imports — it is shared by server and tests.

export const MANAGEMENT_CONTACT_MODEL_ENV = "MANAGEMENT_CONTACT_MODEL";
export const MANAGEMENT_CONTACT_DISABLED_ENV = "MANAGEMENT_CONTACT_LOOKUP_DISABLED";
export const DEFAULT_MANAGEMENT_CONTACT_MODEL = "claude-sonnet-4-6";

export type ManagementContactEmail = {
  subject: string;
  fromEmail: string;
  receivedAt: string;
  text: string;
};

export type ManagementContactLookupInput = {
  propertyName: string;
  unitLabel?: string | null;
  unitAddress?: string | null;
  listingUrl?: string | null;
  communityLabel?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  emails: ManagementContactEmail[];
};

export const MANAGEMENT_CONTACT_SOURCE_KINDS = ["email", "listing-page", "web"] as const;
export type ManagementContactSourceKind = (typeof MANAGEMENT_CONTACT_SOURCE_KINDS)[number];

export type ParsedManagementContact = {
  found: boolean;
  companyName: string;
  phone: string;
  email: string;
  website: string;
  sourceKind: ManagementContactSourceKind;
  sourceUrl: string;
  emailIndex: number | null;
  quote: string;
  confidence: number;
  note: string;
};

/** Provenance persisted on buy_ins.managementContactSource (jsonb). */
export type ManagementContactSourceRecord = {
  companyName: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  sourceKind: ManagementContactSourceKind;
  sourceUrl: string | null;
  emailSubject: string | null;
  emailDate: string | null;
  quote: string | null;
  confidence: number;
  searchCount: number;
  model: string;
  confirmedAt: string;
};

// Web-sourced contacts have no verbatim email to verify against, so the model
// must be confident before we persist anything. Email-sourced contacts are
// verified verbatim instead, so no floor applies there.
export const MANAGEMENT_CONTACT_WEB_CONFIDENCE_FLOOR = 0.6;

const MAX_PROMPT_EMAILS = 8;
const MAX_EMAIL_CHARS = 5_000;

export function buildManagementContactPrompt(input: ManagementContactLookupInput): string {
  const emails = input.emails.slice(0, MAX_PROMPT_EMAILS);
  const emailBlocks = emails
    .map(
      (e, i) =>
        `--- EMAIL ${i} ---\nSubject: ${e.subject}\nFrom: ${e.fromEmail}\nReceived: ${e.receivedAt}\n${e.text.slice(0, MAX_EMAIL_CHARS)}`,
    )
    .join("\n\n");

  const contextLines = [
    `Property: ${input.propertyName}${input.unitLabel ? ` — ${input.unitLabel}` : ""}`,
    input.communityLabel ? `Community/resort: ${input.communityLabel}` : null,
    input.unitAddress ? `Unit address on file: ${input.unitAddress}` : null,
    input.listingUrl ? `Booked listing page: ${input.listingUrl}` : null,
    input.checkIn && input.checkOut ? `Stay: ${input.checkIn} to ${input.checkOut}` : null,
  ].filter(Boolean);

  return [
    `You are helping a vacation-rental operator reach the LOCAL ON-SITE management team for a unit they just booked (front desk, on-site property manager, or the management company that services this specific building/resort). They need a phone number and/or email to call about missing arrival details.`,
    ``,
    `## Booking context`,
    contextLines.join("\n"),
    ``,
    emails.length
      ? `## Emails received at the booking alias inbox (newest first)\n${emailBlocks}`
      : `## Emails\n(none received yet)`,
    ``,
    `## What to do`,
    `1. FIRST check the emails above — booking confirmations often name the property manager or host company with a phone number or email. A contact found there is the best answer: cite the email index and copy the EXACT line(s) containing the contact into "quote" verbatim.`,
    `2. If the emails don't have it, check the booked listing page URL for the host/manager identity, then WEB-SEARCH for that company's (or the resort front desk's) phone/email. Prefer the manager's own website or the resort's official front-desk number over aggregator sites.`,
    `3. The contact must be for the LOCAL/on-site operation for THIS resort or building — never a national OTA support line (VRBO/Expedia/Booking.com customer service is NOT an answer), and never a different resort.`,
    ``,
    `## Output — respond with ONLY this JSON object`,
    `{`,
    `  "found": true|false,`,
    `  "companyName": "management company / front desk name",`,
    `  "phone": "phone number exactly as written in the source",`,
    `  "email": "contact email if available",`,
    `  "website": "company website if available",`,
    `  "sourceKind": "email" | "listing-page" | "web",`,
    `  "sourceUrl": "page URL the contact came from (required unless sourceKind is email)",`,
    `  "emailIndex": <number — required when sourceKind is email>,`,
    `  "quote": "verbatim line(s) from the email containing the contact (email source only)",`,
    `  "confidence": 0.0-1.0,`,
    `  "note": "one short sentence on how you confirmed this is the on-site team"`,
    `}`,
    ``,
    `Rules: NEVER invent or approximate a phone number or email — if you cannot find a real one, return {"found": false, "note": "<what you checked>"}. At least one of phone/email is required for found:true. Phone digits must appear character-for-character in your source.`,
  ].join("\n");
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const str = (v: unknown, max = 400) => String(v ?? "").trim().slice(0, max);

export function parseManagementContactJson(raw: unknown): ParsedManagementContact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kindRaw = str(o.sourceKind, 40).toLowerCase();
  const sourceKind: ManagementContactSourceKind = (MANAGEMENT_CONTACT_SOURCE_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as ManagementContactSourceKind)
    : "web";
  const emailIndexNum = Number(o.emailIndex);
  return {
    found: o.found === true,
    companyName: str(o.companyName, 200),
    phone: str(o.phone, 60),
    email: str(o.email, 200),
    website: str(o.website, 400),
    sourceKind,
    sourceUrl: str(o.sourceUrl, 600),
    emailIndex: Number.isInteger(emailIndexNum) && emailIndexNum >= 0 ? emailIndexNum : null,
    quote: str(o.quote, 1200),
    confidence: clamp01(Number(o.confidence)),
    note: str(o.note, 500),
  };
}

/** Digits-only view of a phone value ("(808) 555-0100" → "8085550100"). */
export function phoneDigits(value: string): string {
  return String(value ?? "").replace(/\D+/g, "");
}

/** A usable phone has 7–15 digits (local US up to full E.164). */
export function isPlausiblePhone(value: string): boolean {
  const digits = phoneDigits(value);
  return digits.length >= 7 && digits.length <= 15;
}

export function isPlausibleEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? "").trim());
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+\.\S+/i.test(String(value ?? "").trim());
}

/**
 * Fold text for quote comparison. OTA emails (the 2026-07-20 VRBO confirmation
 * class) are laced with en-dashes, curly apostrophes, and zero-width-non-joiner
 * padding; a model quoting honestly normalizes those to ASCII, so a strict
 * byte-collapse rejects a REAL quote. Folding both sides keeps the comparison
 * honest (words + digits still must match) while immune to punctuation form.
 */
export function foldForContactCompare(s: string): string {
  return String(s ?? "")
    .replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, "") // zero-width chars / soft hyphen
    .replace(/[\u2010-\u2015\u2212]/g, "-") // hyphen/en/em/figure/horizontal-bar dashes, minus sign
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u00A0/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is the model's quote genuinely lifted from the email? Three honest shapes:
 * (a) a contiguous excerpt (folded substring); (b) MULTIPLE lines that each
 * appear but are non-adjacent in the email — "Contact Alii Resorts …" and the
 * phone line sit two lines apart in a real VRBO confirmation, and the prompt
 * says "copy the EXACT line(s)"; (c) minor HTML-strip drift — >=90% of the
 * quote's significant tokens present AND every digit run present, so a
 * paraphrase that invents or alters ANY number always fails. The phone/email
 * payload checks in validateManagementContact stay digit-for-digit regardless.
 */
export function quoteSupportedByEmail(quote: string, emailHaystack: string): boolean {
  const q = foldForContactCompare(quote);
  const h = foldForContactCompare(emailHaystack);
  if (!q || !h) return false;
  if (h.includes(q)) return true;

  const lines = String(quote ?? "")
    .split(/\n+/)
    .map(foldForContactCompare)
    .filter((l) => l.length >= 3);
  if (lines.length > 1 && lines.every((l) => h.includes(l))) return true;

  const tokens = q.split(" ").filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const present = tokens.filter((t) => h.includes(t)).length;
  if (present / tokens.length < 0.9) return false;
  const digitRuns = q.match(/\d{2,}/g) ?? [];
  return digitRuns.every((run) => h.includes(run));
}

// National OTA support lines are never the answer — a lookup that "confirms"
// VRBO customer service as the on-site team is worse than no result.
const OTA_SUPPORT_NAME_RE = /\b(vrbo|expedia|booking\.com|airbnb|homeaway)\b.*\b(support|customer|service|help)\b|\b(support|customer|service|help)\b.*\b(vrbo|expedia|booking\.com|airbnb|homeaway)\b/i;

export type ManagementContactValidation =
  | { ok: true; contact: ParsedManagementContact }
  | { ok: false; reason: string };

/**
 * The honesty gate. Email-sourced contacts verify against the cited email's
 * text (quote verbatim-present; phone digit-for-digit; email address + company
 * name case-insensitively present in email or quote). Web/listing-page
 * contacts require an http(s) sourceUrl and the confidence floor. Everything
 * needs a company name and at least one plausible phone/email.
 */
export function validateManagementContact(
  parsed: ParsedManagementContact | null,
  emails: ManagementContactEmail[],
): ManagementContactValidation {
  if (!parsed) return { ok: false, reason: "Claude returned no parseable contact JSON" };
  if (!parsed.found) return { ok: false, reason: parsed.note || "No on-site management contact found" };
  if (!parsed.companyName) return { ok: false, reason: "Result had no company name" };
  if (OTA_SUPPORT_NAME_RE.test(parsed.companyName) || OTA_SUPPORT_NAME_RE.test(parsed.note)) {
    return { ok: false, reason: "Result was an OTA customer-support line, not the on-site team" };
  }

  const hasPhone = !!parsed.phone && isPlausiblePhone(parsed.phone);
  const hasEmail = !!parsed.email && isPlausibleEmailAddress(parsed.email);
  if (parsed.phone && !isPlausiblePhone(parsed.phone)) {
    return { ok: false, reason: `Phone "${parsed.phone}" is not a plausible phone number` };
  }
  if (parsed.email && !isPlausibleEmailAddress(parsed.email)) {
    return { ok: false, reason: `Email "${parsed.email}" is not a plausible address` };
  }
  if (!hasPhone && !hasEmail) return { ok: false, reason: "Result had neither a usable phone nor email" };

  if (parsed.sourceKind === "email") {
    if (parsed.emailIndex == null || parsed.emailIndex >= emails.length) {
      return { ok: false, reason: "Email-sourced contact did not cite a valid email" };
    }
    const source = emails[parsed.emailIndex];
    const rawHaystack = `${source.subject}\n${source.fromEmail}\n${source.text}`;
    if (!parsed.quote || !quoteSupportedByEmail(parsed.quote, rawHaystack)) {
      return { ok: false, reason: "Email-sourced contact's quote is not verbatim-present in the cited email" };
    }
    // Phone haystack deliberately excludes fromEmail — SES sender hashes are
    // digit soup an invented number could substring-match by chance.
    if (hasPhone && !phoneDigits(`${source.subject}\n${source.text}`).includes(phoneDigits(parsed.phone))) {
      return { ok: false, reason: "Phone number is not present in the cited email" };
    }
    if (hasEmail && !foldForContactCompare(rawHaystack).includes(parsed.email.toLowerCase())) {
      return { ok: false, reason: "Email address is not present in the cited email" };
    }
    return { ok: true, contact: parsed };
  }

  // listing-page / web
  if (!isHttpUrl(parsed.sourceUrl)) {
    return { ok: false, reason: "Web-sourced contact must cite the page URL it came from" };
  }
  if (parsed.confidence < MANAGEMENT_CONTACT_WEB_CONFIDENCE_FLOOR) {
    return { ok: false, reason: `Web-sourced contact confidence ${parsed.confidence.toFixed(2)} is below the ${MANAGEMENT_CONTACT_WEB_CONFIDENCE_FLOOR} floor` };
  }
  return { ok: true, contact: parsed };
}

/** Pretty display phone: 10-digit US → (808) 555-0100; 11-digit 1-prefixed → same; else as written. */
export function formatContactPhone(value: string): string {
  const digits = phoneDigits(value);
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return String(value ?? "").trim();
}

/** The buy_ins.managementContact column value: "(808) 555-0100 · desk@resort.com". */
export function formatManagementContactValue(contact: Pick<ParsedManagementContact, "phone" | "email">): string {
  return [
    contact.phone && isPlausiblePhone(contact.phone) ? formatContactPhone(contact.phone) : null,
    contact.email && isPlausibleEmailAddress(contact.email) ? contact.email.trim() : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function buildManagementContactSourceRecord(args: {
  contact: ParsedManagementContact;
  emails: ManagementContactEmail[];
  searchCount: number;
  model: string;
  now: Date;
}): ManagementContactSourceRecord {
  const { contact } = args;
  const sourceEmail = contact.sourceKind === "email" && contact.emailIndex != null ? args.emails[contact.emailIndex] : null;
  return {
    companyName: contact.companyName,
    phone: contact.phone || null,
    email: contact.email || null,
    website: contact.website || null,
    sourceKind: contact.sourceKind,
    sourceUrl: contact.sourceUrl || null,
    emailSubject: sourceEmail?.subject ?? null,
    emailDate: sourceEmail?.receivedAt ?? null,
    quote: contact.quote || null,
    confidence: contact.confidence,
    searchCount: args.searchCount,
    model: args.model,
    confirmedAt: args.now.toISOString(),
  };
}
