// Claude-based arrival-details extraction from the guest alias inbox, with
// verbatim-evidence verification (shared/arrival-email-verification.ts).
//
// The "Message AD" refresh path calls refreshArrivalDetailsForReservation:
// for each attached buy-in with a minted traveler alias it (1) live-syncs the
// SimpleLogin forwarding mailbox over IMAP, (2) reads the stored emails with
// Claude — full text, so multi-code emails (lobby/pool/door), unit numbers
// and check-in times all survive — and (3) discards any field whose value is
// not verbatim-present in the cited email before PATCHing the buy_ins arrival
// columns. Falls back to the existing regex parser when ANTHROPIC_API_KEY is
// absent or the call fails, so the button degrades to today's behavior
// rather than erroring.

import { callClaudeJson } from "./claude-json";
import {
  isPlausiblePropertyAddressForBuyIn,
  isUsableArrivalField,
  stripHtmlForEmailParse,
} from "./buy-in-email";
import {
  ARRIVAL_EMAIL_SCALAR_FIELDS,
  hasGuestPortalHint,
  verifyExtractedField,
  type ArrivalEmailScalarField,
  type ArrivalExtractionFieldRecord,
  type ArrivalExtractionRecord,
} from "@shared/arrival-email-verification";
import { extractReadableFromStoredMimeBody } from "@shared/email-body-format";
import { mergeAliasThread } from "@shared/unified-buyin-alias";
import type { BuyIn, BuyInEmail, GuestInboxMessage, ReservationAlias } from "@shared/schema";

const MAX_EMAILS_FOR_EXTRACTION = 10;
const MAX_CHARS_PER_EMAIL = 7_000;

type ExtractionEmail = {
  subject: string;
  fromEmail: string;
  receivedAt: string;
  text: string;
};

type BuyInContext = Pick<BuyIn, "propertyName" | "unitLabel" | "notes" | "propertyId">;

type ClaudeFieldCandidate = { value?: string; quote?: string; emailIndex?: number } | null;

type ClaudeExtractionShape = {
  fields?: Partial<Record<ArrivalEmailScalarField, ClaudeFieldCandidate>>;
  noteLines?: Array<{ value?: string; quote?: string; emailIndex?: number }>;
  conflicts?: string[];
};

export function extractionEmailsFromMessages(messages: GuestInboxMessage[]): ExtractionEmail[] {
  // Newest first — the prompt tells Claude the first email wins conflicts.
  return [...messages]
    .filter((m) => m.direction !== "outbound")
    .sort((a, b) => new Date(b.receivedAt as any).getTime() - new Date(a.receivedAt as any).getTime())
    .slice(0, MAX_EMAILS_FOR_EXTRACTION)
    .map((m) => {
      // Legacy rows can hold a raw MIME fragment (the pre-2026-07-06 import
      // class); the display path heals those — extraction must read the SAME
      // text a human sees or codes inside encoded parts are invisible.
      const raw = String(m.body ?? "");
      const healed = extractReadableFromStoredMimeBody(raw) ?? raw;
      return {
        subject: String(m.subject ?? "").slice(0, 300),
        fromEmail: String(m.fromEmail ?? ""),
        receivedAt: new Date(m.receivedAt as any).toISOString(),
        text: stripHtmlForEmailParse(healed).slice(0, MAX_CHARS_PER_EMAIL),
      };
    });
}

/**
 * Every alias whose inbound mail belongs to THIS unit: the buy-in's
 * travelerEmail plus any reservation_aliases row scoped to its buyInId (the
 * two can differ — e.g. a legacy travelerEmail with a later unit-scoped alias
 * mint). A reservation-LEVEL alias row (buyInId null) is only attributable to
 * a unit when the reservation has exactly one attached buy-in; with siblings
 * its emails can't be pinned to a unit, so it is excluded (attribution-exact
 * rule — a sibling's door code must never land on this unit).
 */
export function aliasCandidatesForBuyIn(
  buyIn: Pick<BuyIn, "id" | "travelerEmail">,
  aliasRows: Array<Pick<ReservationAlias, "buyInId" | "aliasEmail">>,
  attachedBuyInCount: number,
): string[] {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    const email = String(value ?? "").trim().toLowerCase();
    if (email) out.add(email);
  };
  add(buyIn.travelerEmail);
  for (const row of aliasRows) {
    if (row.buyInId === buyIn.id) add(row.aliasEmail);
    else if (row.buyInId == null && attachedBuyInCount === 1) add(row.aliasEmail);
  }
  return Array.from(out);
}

/**
 * ONE extraction corpus per unit: the PM/vendor rows ingested into
 * buy_in_emails (keyed by buyInId — this is where arrival-instruction emails
 * land, the 2026-07-20 missed-door-code class) merged with the
 * guest_inbox_messages rows for the unit's aliases. Reuses the display-side
 * mergeAliasThread dedupe so an email captured by both IMAP ingesters is read
 * once. Output rows are message-shaped for extractionEmailsFromMessages.
 */
export function extractionMessagesFromSources(
  guestMessages: GuestInboxMessage[],
  pmEmails: Array<Pick<BuyInEmail, "id" | "direction" | "fromEmail" | "toEmail" | "subject" | "body" | "providerMessageId" | "sentAt">>,
): GuestInboxMessage[] {
  const merged = mergeAliasThread(pmEmails, guestMessages);
  return merged.map((row) =>
    row.source === "pm"
      ? ({
          id: row.email.id,
          direction: row.email.direction,
          fromEmail: row.email.fromEmail,
          toEmail: row.email.toEmail,
          subject: row.email.subject,
          body: row.email.body,
          receivedAt: row.email.sentAt,
        } as unknown as GuestInboxMessage)
      : row.message,
  );
}

export function buildArrivalExtractionPrompt(emails: ExtractionEmail[], buyIn?: BuyInContext | null): string {
  const blocks = emails
    .map((e, i) =>
      `[EMAIL ${i + 1}] (newest first)\nFrom: ${e.fromEmail}\nDate: ${e.receivedAt}\nSubject: ${e.subject}\n---\n${e.text}\n[END EMAIL ${i + 1}]`)
    .join("\n\n");
  const unitHint = buyIn
    ? `The booking is for "${buyIn.propertyName}" (${buyIn.unitLabel}). `
    : "";
  return `You are extracting guest ARRIVAL DETAILS from emails a vacation-rental host/manager sent to the guest's booking email address. ${unitHint}These are the emails, newest first:

${blocks}

Extract the arrival details a guest needs. Respond with ONLY this JSON:
{
  "fields": {
    "unitAddress": {"value": "...", "quote": "...", "emailIndex": 1} | null,
    "accessCode": {"value": "...", "quote": "...", "emailIndex": 1} | null,
    "wifiName": {"value": "...", "quote": "...", "emailIndex": 1} | null,
    "wifiPassword": {"value": "...", "quote": "...", "emailIndex": 1} | null,
    "parkingInfo": {"value": "...", "quote": "...", "emailIndex": 1} | null
  },
  "noteLines": [{"value": "Lobby code: 1025", "quote": "LOBBY CODE: 1025", "emailIndex": 1}],
  "conflicts": ["accessCode"]
}

HARD RULES — violating any of these makes the output unusable:
- Every "value" MUST be copied verbatim from the email text (the server rejects anything it cannot find verbatim). NEVER guess, infer, reformat codes, or fill gaps from general knowledge.
- Every field MUST carry "quote": the exact contiguous excerpt (<=200 chars) of the email that contains the value, and "emailIndex": which [EMAIL N] it came from.
- A field that is not explicitly stated in any email is null. An empty "noteLines" array is fine.
- "accessCode" is the MAIN door/unit entry code only. Put secondary codes (gate, garage, lobby, pool, elevator), unit number, check-in/check-out times, lockbox location and any other arrival instructions in "noteLines" as short "Label: value" lines, each with its own verbatim quote.
- "unitAddress" is the rental property's street address — never the guest's own mailing address, and never a corporate/OTA office address.
- "parkingInfo": condense to the essential instruction (<=300 chars) but keep the wording from the email.
- If two emails state DIFFERENT values for the same field, use the NEWEST email's value and add the field name to "conflicts".
- Ignore marketing, review requests, OneKeyCash promos, and OTA verification-code emails ("your secure code is ..." is a login code, NOT a door code).`;
}

function fieldRecordFrom(
  verified: { value: string; quote: string },
  email: ExtractionEmail,
): ArrivalExtractionFieldRecord {
  return {
    value: verified.value,
    quote: verified.quote.slice(0, 300),
    sourceSubject: email.subject,
    sourceFrom: email.fromEmail,
    sourceDate: email.receivedAt,
    verified: true,
  };
}

/**
 * Run Claude over the alias emails and keep only fields that survive
 * verbatim verification. Exported with an injectable caller for tests.
 */
export async function extractArrivalDetailsWithClaude(
  messages: GuestInboxMessage[],
  buyIn: BuyInContext | null,
  communityState: string | null,
  callJson: typeof callClaudeJson = callClaudeJson,
): Promise<ArrivalExtractionRecord | null> {
  const emails = extractionEmailsFromMessages(messages);
  if (!emails.length) return null;

  const res = await callJson<ClaudeExtractionShape>({
    model: process.env.ARRIVAL_EXTRACT_MODEL || "claude-sonnet-4-6",
    maxTokens: Number(process.env.ARRIVAL_EXTRACT_MAX_TOKENS) || 2_000,
    prompt: buildArrivalExtractionPrompt(emails, buyIn),
    temperature: 0,
    timeoutMs: 90_000,
  });
  if (!res.ok) {
    console.warn("[arrival-extract] Claude extraction failed:", res.error);
    return null;
  }

  const record: ArrivalExtractionRecord = {
    method: "claude",
    extractedAt: new Date().toISOString(),
    messageCount: emails.length,
    fields: {},
    conflicts: Array.isArray(res.data?.conflicts)
      ? res.data.conflicts.map((c) => String(c)).slice(0, 10)
      : [],
    portalHint: emails.some((e) => hasGuestPortalHint(e.text)),
  };

  const emailAt = (index: unknown): ExtractionEmail | null => {
    const i = Number(index);
    return Number.isInteger(i) && i >= 1 && i <= emails.length ? emails[i - 1] : null;
  };

  for (const field of ARRIVAL_EMAIL_SCALAR_FIELDS) {
    const candidate = res.data?.fields?.[field];
    if (!candidate) continue;
    const email = emailAt(candidate.emailIndex);
    if (!email) continue;
    const verified = verifyExtractedField(field, candidate, email.text);
    if (!verified) continue;
    if (!isUsableArrivalField(field, verified.value)) continue;
    if (field === "unitAddress" && !isPlausiblePropertyAddressForBuyIn(verified.value, buyIn, communityState)) {
      continue;
    }
    record.fields[field] = fieldRecordFrom(verified, email);
  }

  const noteLines: string[] = [];
  let noteSource: ExtractionEmail | null = null;
  for (const line of (res.data?.noteLines ?? []).slice(0, 12)) {
    const email = emailAt(line?.emailIndex);
    if (!email) continue;
    const verified = verifyExtractedField("arrivalNotes", line, email.text);
    if (!verified) continue;
    noteLines.push(verified.value.slice(0, 300));
    noteSource = noteSource ?? email;
  }
  if (noteLines.length && noteSource) {
    record.fields.arrivalNotes = {
      value: Array.from(new Set(noteLines)).join("\n").slice(0, 2000),
      sourceSubject: noteSource.subject,
      sourceFrom: noteSource.fromEmail,
      sourceDate: noteSource.receivedAt,
      verified: true,
    };
  }

  return Object.keys(record.fields).length || record.portalHint ? record : null;
}

/** Regex fallback (no API key / Claude down): same record shape, method "regex". */
export async function extractArrivalDetailsWithRegex(
  messages: GuestInboxMessage[],
  buyIn: BuyIn,
  communityState: string | null,
): Promise<ArrivalExtractionRecord | null> {
  const emails = extractionEmailsFromMessages(messages);
  if (!emails.length) return null;
  const { parseArrivalDetailsFromGuestEmail } = await import("./guest-inbox-arrival");

  const record: ArrivalExtractionRecord = {
    method: "regex",
    extractedAt: new Date().toISOString(),
    messageCount: emails.length,
    fields: {},
    portalHint: emails.some((e) => hasGuestPortalHint(e.text)),
  };
  // Oldest → newest so the newest email's value wins each field.
  for (const email of [...emails].reverse()) {
    const parsed = parseArrivalDetailsFromGuestEmail(email.subject, email.text, buyIn, communityState);
    for (const key of [...ARRIVAL_EMAIL_SCALAR_FIELDS, "arrivalNotes"] as const) {
      const value = String(parsed[key] ?? "").trim();
      if (!value) continue;
      record.fields[key] = {
        value,
        sourceSubject: email.subject,
        sourceFrom: email.fromEmail,
        sourceDate: email.receivedAt,
        // Regex output is lifted from the email text by construction.
        verified: true,
      };
    }
  }
  return Object.keys(record.fields).length || record.portalHint ? record : null;
}

export type ArrivalRefreshUnitResult = {
  buyInId: number;
  unitId: string;
  unitLabel: string;
  aliasEmail: string | null;
  synced: { imported: number; skipped?: string } | null;
  messageCount: number;
  extraction: ArrivalExtractionRecord | null;
  updatedFields: string[];
};

/**
 * Live-sync each attached buy-in's alias inbox, extract + verify arrival
 * details, and PATCH the buy_ins arrival columns. Email-verified values
 * OVERWRITE stale column values (this endpoint is the operator explicitly
 * asking "pull what the host emailed"); fields the emails never mention are
 * left untouched so manual entries survive.
 */
export async function refreshArrivalDetailsForReservation(reservationId: string): Promise<{
  units: ArrivalRefreshUnitResult[];
}> {
  const { storage } = await import("./storage");
  const { syncGuestInboxForAlias } = await import("./guest-inbox-sync");
  const { expectedStateHintFromBuyIn } = await import("./buy-in-email");
  const { BUY_IN_MARKET_LOCATIONS, resolveBuyInMarket } = await import("@shared/buy-in-market");
  const { db } = await import("./db");
  const { buyInEmails, reservationAliases } = await import("@shared/schema");
  const { desc, eq } = await import("drizzle-orm");

  // Pull PM/vendor mail into buy_in_emails first — arrival-instruction emails
  // land THERE (delivered to the unit-scoped alias), not necessarily in
  // guest_inbox_messages for the travelerEmail. Throttled + fail-soft.
  try {
    const { syncBuyInVendorEmailsForReservation } = await import("./buy-in-email-sync");
    await syncBuyInVendorEmailsForReservation(reservationId);
  } catch (err: any) {
    console.warn("[arrival-extract] vendor-email sync failed:", err?.message ?? err);
  }

  const attached = await storage.getBuyInsByReservation(reservationId);
  let aliasRows: ReservationAlias[] = [];
  try {
    aliasRows = await db
      .select()
      .from(reservationAliases)
      .where(eq(reservationAliases.reservationId, reservationId));
  } catch (err: any) {
    console.warn("[arrival-extract] alias rows read failed:", err?.message ?? err);
  }
  let pmEmailRows: BuyInEmail[] = [];
  try {
    pmEmailRows = await db
      .select()
      .from(buyInEmails)
      .where(eq(buyInEmails.reservationId, reservationId))
      .orderBy(desc(buyInEmails.sentAt))
      .limit(200);
  } catch (err: any) {
    console.warn("[arrival-extract] buy_in_emails read failed:", err?.message ?? err);
  }

  const units: ArrivalRefreshUnitResult[] = [];

  for (const buyIn of attached) {
    const aliases = aliasCandidatesForBuyIn(buyIn, aliasRows, attached.length);
    const result: ArrivalRefreshUnitResult = {
      buyInId: buyIn.id,
      unitId: buyIn.unitId,
      unitLabel: buyIn.unitLabel,
      aliasEmail: aliases[0] ?? null,
      synced: null,
      messageCount: 0,
      extraction: null,
      updatedFields: [],
    };
    units.push(result);
    const unitPmEmails = pmEmailRows.filter((e) => e.buyInId === buyIn.id);
    if (!aliases.length && !unitPmEmails.length) continue;

    const guestMessages: GuestInboxMessage[] = [];
    const seenMessageIds = new Set<number>();
    for (const alias of aliases) {
      try {
        const synced = await syncGuestInboxForAlias(alias);
        result.synced = result.synced
          ? { imported: result.synced.imported + synced.imported, skipped: result.synced.skipped ?? synced.skipped }
          : synced;
      } catch (err: any) {
        result.synced = result.synced ?? { imported: 0, skipped: err?.message ?? "sync failed" };
      }
      for (const msg of await storage.getGuestInboxMessages(alias, 100)) {
        if (seenMessageIds.has(msg.id)) continue;
        seenMessageIds.add(msg.id);
        guestMessages.push(msg);
      }
    }

    const messages = extractionMessagesFromSources(guestMessages, unitPmEmails);
    result.messageCount = messages.length;
    if (!messages.length) continue;

    const marketKey = resolveBuyInMarket({ name: buyIn.propertyName, listingTitle: buyIn.unitLabel });
    const communityState = expectedStateHintFromBuyIn(
      buyIn,
      marketKey ? BUY_IN_MARKET_LOCATIONS[marketKey]?.state : null,
    );

    let extraction: ArrivalExtractionRecord | null = null;
    try {
      extraction = await extractArrivalDetailsWithClaude(messages, buyIn, communityState);
    } catch (err: any) {
      console.warn("[arrival-extract] Claude path threw:", err?.message ?? err);
    }
    if (!extraction) {
      extraction = await extractArrivalDetailsWithRegex(messages, buyIn, communityState);
    }
    if (!extraction) continue;
    if (result.aliasEmail) extraction.aliasEmail = result.aliasEmail;
    result.extraction = extraction;

    const patch: Record<string, unknown> = {};
    for (const [key, rec] of Object.entries(extraction.fields)) {
      if (!rec?.verified || !rec.value) continue;
      const current = String((buyIn as any)[key] ?? "").trim();
      if (rec.value === current) continue;
      // Claude-verified values overwrite; regex values keep the historical
      // fill-blank-only behavior (regex can't distinguish a better value
      // from a worse one, so it must not clobber a manual correction).
      if (extraction.method === "regex" && current) continue;
      patch[key] = rec.value;
      result.updatedFields.push(key);
    }
    patch.arrivalExtraction = extraction;
    try {
      await storage.updateBuyIn(buyIn.id, patch as any);
    } catch (err: any) {
      console.warn(`[arrival-extract] buy-in ${buyIn.id} patch failed:`, err?.message ?? err);
    }
  }

  return { units };
}
