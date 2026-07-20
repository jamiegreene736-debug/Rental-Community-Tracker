// Extracts the ACTUALLY-PAID rate for a buy-in from its alias inboxes and
// persists it on buy_ins.paid_rate (+ paid_rate_source provenance).
//
// Reads BOTH alias mailboxes — guest_inbox_messages (traveler-alias sync,
// keyed by buy_ins.travelerEmail) and buy_in_emails (PM/vendor thread, keyed
// by buyInId) — because both IMAP ingesters watch the same address and either
// can hold the confirmation email. The decision itself is the pure
// selectPaidRateFromEmails (shared/paid-rate-extraction.ts): inbound-only,
// label-anchored, booking-total beats paid-so-far, newest wins.
//
// Fired at the SAME seams as the auto-mark-bought-in feature (both ingestion
// ticks + both panel reads) so units whose confirmation emails were ingested
// before this shipped heal on the next panel open. Always fail-soft — an
// extraction failure must never fail an email import or a panel read.
// Kill switch: PAID_RATE_EXTRACT_DISABLED=1.

import {
  selectPaidRateFromEmails,
  paidRateSourceRecord,
  paidRateNeedsWrite,
  type PaidRateEmail,
} from "../shared/paid-rate-extraction";

/**
 * Recompute + persist the paid rate for one buy-in from its alias mailboxes.
 * Returns true when the stored value CHANGED (caller may surface a refresh).
 */
export async function refreshPaidRateForBuyIn(buyInId: number): Promise<boolean> {
  if (String(process.env.PAID_RATE_EXTRACT_DISABLED ?? "").trim() === "1") return false;
  if (!Number.isFinite(buyInId) || buyInId <= 0) return false;
  const { storage } = await import("./storage");
  const buyIn = await storage.getBuyIn(buyInId);
  if (!buyIn) return false;
  // A cancelled/detached buy-in was abandoned — don't keep stamping it.
  if (String(buyIn.status ?? "").trim().toLowerCase() === "cancelled") return false;

  const emails: PaidRateEmail[] = [];
  const alias = String(buyIn.travelerEmail ?? "").trim().toLowerCase();
  if (alias) {
    const messages = await storage.getGuestInboxMessages(alias, 100);
    for (const m of messages) {
      emails.push({
        mailbox: "guest-inbox",
        id: m.id,
        direction: m.direction,
        subject: m.subject,
        body: m.body,
        fromEmail: m.fromEmail,
        at: m.receivedAt ?? m.createdAt,
      });
    }
  }
  try {
    const { db } = await import("./db");
    const { buyInEmails } = await import("../shared/schema");
    const { eq, desc } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(buyInEmails)
      .where(eq(buyInEmails.buyInId, buyInId))
      .orderBy(desc(buyInEmails.sentAt))
      .limit(100);
    for (const r of rows) {
      emails.push({
        mailbox: "buy-in-email",
        id: r.id,
        direction: r.direction,
        subject: r.subject,
        body: r.body,
        fromEmail: r.fromEmail,
        at: r.sentAt,
      });
    }
  } catch (err: any) {
    console.warn("[paid-rate] buy_in_emails read failed:", err?.message ?? err);
  }
  if (emails.length === 0) return false;

  const picked = selectPaidRateFromEmails(emails);
  if (!picked) return false;
  if (!paidRateNeedsWrite(buyIn.paidRate, picked)) return false;

  await storage.updateBuyIn(buyInId, {
    paidRate: picked.amount.toFixed(2),
    paidRateSource: paidRateSourceRecord(picked, new Date()),
  } as any);
  console.log(
    `[paid-rate] buy-in ${buyInId} (${buyIn.unitLabel ?? "unit"}) paid rate $${picked.amount.toFixed(2)} from "${picked.quote}" (${picked.email.mailbox ?? "alias"} email)`,
  );
  return true;
}

/** Alias flavor: resolve the owning buy-in by its traveler alias. */
export async function refreshPaidRateForAlias(aliasEmail: string): Promise<boolean> {
  const alias = String(aliasEmail ?? "").trim().toLowerCase();
  if (!alias) return false;
  const { storage } = await import("./storage");
  const buyIn = await storage.getBuyInByTravelerEmail(alias);
  if (!buyIn) return false;
  return refreshPaidRateForBuyIn(buyIn.id);
}
