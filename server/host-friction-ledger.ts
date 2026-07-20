// app_settings store + retroactive scanner for the HOST FRICTION LEDGER
// (shared/host-friction.ts holds the pure logic). The ledger records what
// each management company ACTUALLY demanded of us in past buy-ins —
// contract/e-sign requests, ID-verification demands, guest registration
// forms vs plain arrival instructions — classified from the alias inboxes.
//
// REUSE SEAM (load-bearing — don't re-implement): the scan reads each
// buy-in's merged per-unit thread through the SAME helpers the arrival-
// details extractor uses — aliasCandidatesForBuyIn (attribution-exact alias
// set) + extractionMessagesFromSources (buy_in_emails ∪ guest_inbox_messages,
// mergeAliasThread-deduped) + extractionEmailsFromMessages (inbound-only,
// MIME-healed, HTML-stripped). Classifying raw stored bodies instead would
// miss codes/demands inside encoded MIME parts (the 2026-07-20 door-code
// class) and double-count emails both IMAP ingesters captured.
//
// The ledger is a DERIVED CACHE: every scan rebuilds it wholesale from the
// stored emails (DB reads only — no IMAP sync here; the 5-minute ingesters
// own freshness of the underlying rows), so scans are idempotent and a
// classifier fix heals the whole ledger on the next pass. Fail-soft
// everywhere — a store/scan failure means the badge just doesn't render.

import { storage } from "./storage";
import { db } from "./db";
import { buyInEmails, reservationAliases } from "@shared/schema";
import type { BuyInEmail, GuestInboxMessage, ReservationAlias } from "@shared/schema";
import { desc, inArray } from "drizzle-orm";
import {
  HOST_FRICTION_LEDGER_KEY,
  buildHostFrictionLedger,
  frictionSignalsFromEmailText,
  normalizeManagementCompanyKey,
  parseHostFrictionLedger,
  serializeHostFrictionLedger,
  type HostFrictionLedger,
  type HostFrictionObservation,
} from "@shared/host-friction";
import {
  aliasCandidatesForBuyIn,
  extractionEmailsFromMessages,
  extractionMessagesFromSources,
} from "./arrival-email-extract";

// Re-scan lazily when the stored ledger is older than this (the GET endpoint
// calls ensureHostFrictionLedgerFresh fire-and-forget). DB-only work, so a
// generous freshness window is about noise, not cost.
const LEDGER_FRESH_MS = 12 * 60 * 60 * 1000;

let tail: Promise<void> = Promise.resolve();
function writeLedger(ledger: HostFrictionLedger): Promise<void> {
  tail = tail.then(async () => {
    try {
      await storage.setSetting(HOST_FRICTION_LEDGER_KEY, serializeHostFrictionLedger(ledger));
    } catch (err: any) {
      console.warn("[host-friction] ledger write failed:", err?.message ?? err);
    }
  });
  return tail;
}

export async function loadHostFrictionLedger(): Promise<HostFrictionLedger> {
  try {
    const raw = await storage.getSetting(HOST_FRICTION_LEDGER_KEY);
    return parseHostFrictionLedger(raw ?? null);
  } catch {
    return { entries: [], scannedAt: null };
  }
}

export interface HostFrictionScanSummary {
  companies: number;
  buyInsScanned: number;
  emailsScanned: number;
  scannedAt: string;
}

/**
 * Full rebuild: walk every buy-in that names a usable management company,
 * read its merged alias thread from the DB, classify the inbound emails, and
 * replace the ledger with the aggregate.
 */
export async function scanHostFrictionLedger(): Promise<HostFrictionScanSummary> {
  const now = new Date();
  const allBuyIns = await storage.getBuyIns();
  const candidates = allBuyIns.filter((b) => normalizeManagementCompanyKey(b.managementCompany) !== "");

  let aliasRows: ReservationAlias[] = [];
  try {
    aliasRows = await db.select().from(reservationAliases);
  } catch (err: any) {
    console.warn("[host-friction] alias rows read failed:", err?.message ?? err);
  }
  const aliasRowsByReservation = new Map<string, ReservationAlias[]>();
  for (const row of aliasRows) {
    const list = aliasRowsByReservation.get(row.reservationId) ?? [];
    list.push(row);
    aliasRowsByReservation.set(row.reservationId, list);
  }

  // Attached-sibling counts per reservation drive aliasCandidatesForBuyIn's
  // attribution-exact rule (a reservation-level alias is only attributable to
  // a unit when it is the reservation's ONLY attached buy-in).
  const attachedCountByReservation = new Map<string, number>();
  for (const b of allBuyIns) {
    if (!b.guestyReservationId) continue;
    attachedCountByReservation.set(
      b.guestyReservationId,
      (attachedCountByReservation.get(b.guestyReservationId) ?? 0) + 1,
    );
  }

  let pmEmailRows: BuyInEmail[] = [];
  const candidateIds = candidates.map((b) => b.id);
  if (candidateIds.length > 0) {
    try {
      pmEmailRows = await db
        .select()
        .from(buyInEmails)
        .where(inArray(buyInEmails.buyInId, candidateIds))
        .orderBy(desc(buyInEmails.sentAt))
        .limit(5_000);
    } catch (err: any) {
      console.warn("[host-friction] buy_in_emails read failed:", err?.message ?? err);
    }
  }

  const observations: HostFrictionObservation[] = [];
  let emailsScanned = 0;
  for (const buyIn of candidates) {
    const reservationAliasRows = buyIn.guestyReservationId
      ? aliasRowsByReservation.get(buyIn.guestyReservationId) ?? []
      : [];
    const attachedCount = buyIn.guestyReservationId
      ? attachedCountByReservation.get(buyIn.guestyReservationId) ?? 1
      : 1;
    const aliases = aliasCandidatesForBuyIn(buyIn, reservationAliasRows, attachedCount);
    const unitPmEmails = pmEmailRows.filter((e) => e.buyInId === buyIn.id);
    if (!aliases.length && !unitPmEmails.length) continue;

    const guestMessages: GuestInboxMessage[] = [];
    const seenMessageIds = new Set<number>();
    for (const alias of aliases) {
      try {
        for (const msg of await storage.getGuestInboxMessages(alias, 100)) {
          if (seenMessageIds.has(msg.id)) continue;
          seenMessageIds.add(msg.id);
          guestMessages.push(msg);
        }
      } catch (err: any) {
        console.warn(`[host-friction] inbox read failed for ${alias}:`, err?.message ?? err);
      }
    }

    const merged = extractionMessagesFromSources(guestMessages, unitPmEmails);
    const emails = extractionEmailsFromMessages(merged);
    emailsScanned += emails.length;
    const signals = new Map<string, { kind: any; quote: string }>();
    for (const email of emails) {
      for (const sig of frictionSignalsFromEmailText(email.subject, email.text)) {
        if (!signals.has(sig.kind)) signals.set(sig.kind, sig);
      }
    }
    if (signals.size === 0) continue;
    observations.push({
      company: String(buyIn.managementCompany ?? ""),
      buyInId: buyIn.id,
      signals: Array.from(signals.values()),
    });
  }

  const ledger = buildHostFrictionLedger(observations, now);
  await writeLedger(ledger);
  console.log(
    `[host-friction] ledger rebuilt: ${ledger.entries.length} companies from ${observations.length} evidenced buy-ins (${candidates.length} scanned, ${emailsScanned} emails)`,
  );
  return {
    companies: ledger.entries.length,
    buyInsScanned: candidates.length,
    emailsScanned,
    scannedAt: now.toISOString(),
  };
}

// Lazy freshness: fire-and-forget rebuild when the stored ledger is stale.
// Single-flight so a burst of GETs can't stack scans.
let scanInFlight = false;
export function ensureHostFrictionLedgerFresh(ledger: HostFrictionLedger): void {
  if (scanInFlight) return;
  const scannedAt = ledger.scannedAt ? Date.parse(ledger.scannedAt) : NaN;
  if (Number.isFinite(scannedAt) && Date.now() - scannedAt < LEDGER_FRESH_MS) return;
  scanInFlight = true;
  void scanHostFrictionLedger()
    .catch((err: any) => console.warn("[host-friction] lazy scan failed:", err?.message ?? err))
    .finally(() => {
      scanInFlight = false;
    });
}
