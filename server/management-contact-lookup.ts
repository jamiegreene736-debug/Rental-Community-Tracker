// "Confirm on-site management contact" engine (operator ask, 2026-07-20).
//
// For an ATTACHED buy-in whose confirmation emails have arrived but whose
// arrival details haven't, look up the LOCAL on-site management team's contact
// details and save them into the arrival-information columns
// (buy_ins.managementCompany / managementContact) + provenance
// (managementContactSource). ONE Claude web-search call over:
//   · the unit's merged alias inbox (buy_in_emails ∪ guest_inbox_messages —
//     the same corpus the arrival-details extractor reads, so a confirmation
//     email naming the PM company is seen), and
//   · the booked listing page URL + property/community context,
// then the shared validation gate (shared/management-contact-logic.ts) rejects
// anything not verbatim-backed (email source) or not URL-cited + confident
// (web source). No ANTHROPIC key → honest failure, no regex guessing — an
// invented phone number is worse than none.
//
// Kill switch: MANAGEMENT_CONTACT_LOOKUP_DISABLED=1. Model override:
// MANAGEMENT_CONTACT_MODEL (default claude-sonnet-4-6).

import { callClaudeWebSearchJson } from "./claude-json";
import {
  aliasCandidatesForBuyIn,
  extractionEmailsFromMessages,
  extractionMessagesFromSources,
} from "./arrival-email-extract";
import {
  DEFAULT_MANAGEMENT_CONTACT_MODEL,
  MANAGEMENT_CONTACT_DISABLED_ENV,
  MANAGEMENT_CONTACT_MODEL_ENV,
  buildManagementContactPrompt,
  buildManagementContactSourceRecord,
  formatManagementContactValue,
  parseManagementContactJson,
  validateManagementContact,
  type ManagementContactSourceRecord,
} from "@shared/management-contact-logic";
import type { BuyInEmail, GuestInboxMessage, ReservationAlias } from "@shared/schema";

export type ManagementContactLookupResult =
  | {
      ok: true;
      contact: ManagementContactSourceRecord;
      applied: { managementCompany: string; managementContact: string };
      emailCount: number;
    }
  | { ok: false; message: string; emailCount?: number };

export async function lookupManagementContactForBuyIn(buyInId: number): Promise<ManagementContactLookupResult> {
  if (process.env[MANAGEMENT_CONTACT_DISABLED_ENV] === "1") {
    return { ok: false, message: "Management-contact lookup is disabled (MANAGEMENT_CONTACT_LOOKUP_DISABLED=1)" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, message: "ANTHROPIC_API_KEY is not configured — the lookup needs Claude web search" };
  }

  const { storage } = await import("./storage");
  const buyIn = await storage.getBuyIn(buyInId);
  if (!buyIn) return { ok: false, message: "Buy-in not found" };

  // Gather the unit's alias-inbox corpus — same sources as the arrival-details
  // extractor. Vendor-mail sync first (throttled, fail-soft) so a confirmation
  // email that arrived minutes ago is readable; skip the slow per-alias IMAP
  // loop (the 5-min background tick owns that) to keep the button responsive.
  const reservationId = String(buyIn.guestyReservationId ?? "").trim();
  let guestMessages: GuestInboxMessage[] = [];
  let pmEmails: BuyInEmail[] = [];
  let attachedCount = 1;
  try {
    const { db } = await import("./db");
    const { buyInEmails, reservationAliases } = await import("@shared/schema");
    const { desc, eq } = await import("drizzle-orm");

    if (reservationId) {
      try {
        const { syncBuyInVendorEmailsForReservation } = await import("./buy-in-email-sync");
        await syncBuyInVendorEmailsForReservation(reservationId);
      } catch (err: any) {
        console.warn("[mgmt-contact] vendor-email sync failed:", err?.message ?? err);
      }
    }

    let aliasRows: ReservationAlias[] = [];
    if (reservationId) {
      try {
        aliasRows = await db
          .select()
          .from(reservationAliases)
          .where(eq(reservationAliases.reservationId, reservationId));
        attachedCount = (await storage.getBuyInsByReservation(reservationId)).length || 1;
      } catch (err: any) {
        console.warn("[mgmt-contact] alias rows read failed:", err?.message ?? err);
      }
    }
    const aliases = aliasCandidatesForBuyIn(buyIn, aliasRows, attachedCount);
    const seen = new Set<number>();
    for (const alias of aliases) {
      for (const msg of await storage.getGuestInboxMessages(alias, 100)) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        guestMessages.push(msg);
      }
    }
    try {
      pmEmails = await db
        .select()
        .from(buyInEmails)
        .where(eq(buyInEmails.buyInId, buyIn.id))
        .orderBy(desc(buyInEmails.sentAt))
        .limit(100);
    } catch (err: any) {
      console.warn("[mgmt-contact] buy_in_emails read failed:", err?.message ?? err);
    }
  } catch (err: any) {
    console.warn("[mgmt-contact] email gathering failed:", err?.message ?? err);
  }

  const emails = extractionEmailsFromMessages(extractionMessagesFromSources(guestMessages, pmEmails));

  const listingUrl = String(buyIn.airbnbListingUrl ?? "").trim() || null;
  const prompt = buildManagementContactPrompt({
    propertyName: buyIn.propertyName,
    unitLabel: buyIn.unitLabel,
    unitAddress: buyIn.unitAddress,
    listingUrl,
    communityLabel: null,
    checkIn: buyIn.checkIn,
    checkOut: buyIn.checkOut,
    emails,
  });

  const model = process.env[MANAGEMENT_CONTACT_MODEL_ENV] || DEFAULT_MANAGEMENT_CONTACT_MODEL;
  const res = await callClaudeWebSearchJson<Record<string, unknown>>({
    model,
    maxTokens: 1500,
    prompt,
    maxSearches: 6,
    timeoutMs: 150_000,
  });
  if (!res.ok) return { ok: false, message: `Lookup failed: ${res.error}`, emailCount: emails.length };

  const parsed = parseManagementContactJson(res.data);
  const verdict = validateManagementContact(parsed, emails);
  if (!verdict.ok) return { ok: false, message: verdict.reason, emailCount: emails.length };

  const record = buildManagementContactSourceRecord({
    contact: verdict.contact,
    emails,
    searchCount: res.searchCount ?? 0,
    model,
    now: new Date(),
  });
  const managementContact = formatManagementContactValue(verdict.contact);

  await storage.updateBuyIn(buyIn.id, {
    managementCompany: verdict.contact.companyName,
    managementContact,
    managementContactSource: record,
  } as any);

  return {
    ok: true,
    contact: record,
    applied: { managementCompany: verdict.contact.companyName, managementContact },
    emailCount: emails.length,
  };
}
