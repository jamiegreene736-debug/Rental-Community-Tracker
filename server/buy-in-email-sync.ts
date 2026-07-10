// Sync PM/vendor reverse-alias replies from the SimpleLogin forwarding mailbox
// into buy_in_emails. When a PM replies to a unit's SimpleLogin alias, SimpleLogin
// forwards the mail to reservations@… with X-SimpleLogin-Envelope-To set to that
// unit alias. The inbound webhook (POST /api/buy-in-emails/inbound) only works
// when a relay is explicitly configured to POST to it — which it is NOT in
// production — so, exactly like the guest inbox (guest-inbox-sync.ts), we poll
// IMAP on demand. Before this, the guest inbox had an IMAP fallback but the
// PM/vendor "Alias email history" did not, so incoming vendor emails never
// appeared in the portal.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { extractEmailAddress } from "./simplelogin";
import {
  extractBodyFromRawEmail,
  guestInboxImapConfig,
  parseEmailHeaders,
} from "./guest-inbox-sync";
import { parseArrivalDetailsFromText } from "./buy-in-email";

const SYNC_MIN_INTERVAL_MS = 60_000;
const lastSyncAtByReservation = new Map<string, number>();

type ParsedVendorEmail = {
  aliasEmail: string;
  fromEmail: string | null;
  subject: string;
  messageId: string | null;
  body: string;
  receivedAt: Date | null;
};

/** Lowercased SimpleLogin envelope-to (the unit alias the PM replied to). */
function envelopeToFromHeaders(headers: Record<string, string>): string | null {
  const candidates = [
    headers["x-simplelogin-envelope-to"],
    headers["x-simplelogin-envelope_to"],
    headers["to"],
    headers["delivered-to"],
  ];
  for (const raw of candidates) {
    const email = extractEmailAddress(String(raw ?? "")).trim().toLowerCase();
    if (email) return email;
  }
  return null;
}

/** The PM's real sender address (SimpleLogin rewrites From; the original is in the SL headers). */
function senderFromHeaders(headers: Record<string, string>): string | null {
  return extractEmailAddress(
    headers["x-simplelogin-envelope-from"]
    || headers["x-simplelogin-original-from"]
    || headers["reply-to"]
    || headers["from"]
    || "",
  ).trim().toLowerCase() || null;
}

export function parseVendorEmailFromRaw(raw: string, aliasSet: Set<string>): ParsedVendorEmail | null {
  const headers = parseEmailHeaders(raw);
  const envelopeTo = envelopeToFromHeaders(headers);
  if (!envelopeTo || !aliasSet.has(envelopeTo)) return null;

  const subject = String(headers["subject"] ?? "").trim() || "(no subject)";
  const messageId = String(headers["message-id"] ?? "").trim().replace(/^<|>$/g, "") || null;
  const dateRaw = headers["date"];
  const receivedAt = dateRaw ? new Date(dateRaw) : null;
  const body = extractBodyFromRawEmail(raw);

  return {
    aliasEmail: envelopeTo,
    fromEmail: senderFromHeaders(headers),
    subject,
    messageId,
    body,
    receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
  };
}

// Stable dedup key for a vendor reply that lacks a Message-ID, so the same email
// re-scanned on every tick (or by both the scheduler and an on-open GET) is not
// re-inserted.
function surrogateMessageId(aliasEmail: string, parsed: ParsedVendorEmail): string {
  const basis = [
    aliasEmail,
    parsed.subject ?? "",
    parsed.receivedAt ? parsed.receivedAt.toISOString() : "",
    // Whitespace-normalized so the key is stable across body-formatting changes
    // (stripHtml now preserves newlines; rows imported before that were stored
    // flattened — hashing the raw body would re-key + re-import those emails).
    (parsed.body ?? "").replace(/\s+/g, " ").slice(0, 200),
  ].join("|");
  return `synth:${createHash("sha1").update(basis).digest("hex")}`;
}

async function searchUidsForAliases(
  client: import("imapflow").ImapFlow,
  aliases: string[],
  aliasSet: Set<string>,
  since: Date,
): Promise<number[]> {
  const found = new Set<number>();
  for (const alias of aliases) {
    // imapflow wants `header` as an OBJECT { "Header-Name": "substring" }. HEADER
    // is an IMAP SUBSTRING match, so the bare alias matches `<alias>` and `alias`.
    const headerQueries: Array<Record<string, unknown>> = [
      { header: { "X-SimpleLogin-Envelope-To": alias } },
      { header: { "To": alias } },
    ];
    for (const criteria of headerQueries) {
      try {
        const uids = await client.search({ since, ...criteria });
        if (Array.isArray(uids) && uids.length) uids.forEach((uid) => found.add(uid as number));
      } catch (err) {
        console.warn(`[buy-in-email] IMAP header search failed for ${alias}:`, (err as Error)?.message ?? err);
      }
    }
  }
  if (found.size > 0) return Array.from(found);

  // Fallback: some IMAP servers reject HEADER search — scan the recent window and
  // keep only mail whose envelope-to is one of this reservation's unit aliases.
  const uids = await client.search({ since });
  if (!Array.isArray(uids) || !uids.length) return [];
  for (const uid of uids.slice().reverse().slice(0, 300)) {
    const msg = await client.fetchOne(uid as number, { source: true });
    if (!msg) continue;
    const raw = msg.source?.toString("utf8") ?? "";
    if (!raw) continue;
    if (parseVendorEmailFromRaw(raw, aliasSet)) found.add(uid as number);
  }
  return Array.from(found);
}

/**
 * Poll the reservations IMAP mailbox for PM/vendor replies addressed to this
 * reservation's unit aliases and record them as inbound buy_in_emails rows.
 * Mirrors syncGuestInboxForAlias but keys on reservation_aliases +
 * buy_in_vendor_contacts instead of the guest booking domain.
 */
export async function syncBuyInVendorEmailsForReservation(
  reservationId: string,
): Promise<{ imported: number; skipped?: string }> {
  const rid = String(reservationId ?? "").trim();
  if (!rid) return { imported: 0, skipped: "empty reservationId" };

  const now = Date.now();
  const last = lastSyncAtByReservation.get(rid) ?? 0;
  if (now - last < SYNC_MIN_INTERVAL_MS) return { imported: 0, skipped: "throttled" };
  lastSyncAtByReservation.set(rid, now);

  const imap = guestInboxImapConfig();
  if (!imap.configured) return { imported: 0, skipped: "IMAP not configured" };

  const { db } = await import("./db");
  const { storage } = await import("./storage");
  const { reservationAliases, buyInVendorContacts, buyInEmails } = await import("@shared/schema");

  const aliasRows = await db
    .select()
    .from(reservationAliases)
    .where(eq(reservationAliases.reservationId, rid));
  const aliasByEmail = new Map<string, { buyInId: number | null }>();
  for (const row of aliasRows) {
    const email = String(row.aliasEmail ?? "").trim().toLowerCase();
    if (email) aliasByEmail.set(email, { buyInId: row.buyInId ?? null });
  }
  if (aliasByEmail.size === 0) return { imported: 0, skipped: "no aliases" };
  const aliasSet = new Set(aliasByEmail.keys());

  const contactRows = await db
    .select()
    .from(buyInVendorContacts)
    .where(eq(buyInVendorContacts.reservationId, rid));
  const contactBySender = new Map<string, { id: number; buyInId: number }>();
  for (const row of contactRows) {
    const email = String(row.vendorEmail ?? "").trim().toLowerCase();
    if (email) contactBySender.set(email, { id: row.id, buyInId: row.buyInId });
  }

  // Fallback buy-in for legacy reservation-level aliases (buyInId null): the
  // earliest attached unit, matching how buy-in-communications picks its default.
  const buyIns = await storage.getBuyInsByReservation(rid);
  const fallbackBuyInId = buyIns
    .map((b) => b.id)
    .filter((id): id is number => Number.isFinite(id))
    .sort((a, b) => a - b)[0] ?? null;

  // Dedup against inbound rows already stored for this reservation.
  const existing = await db
    .select({ providerMessageId: buyInEmails.providerMessageId })
    .from(buyInEmails)
    .where(and(eq(buyInEmails.reservationId, rid), eq(buyInEmails.direction, "inbound")))
    .limit(500);
  const seenMessageIds = new Set(
    existing.map((r) => String(r.providerMessageId ?? "")).filter(Boolean),
  );

  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.port === 993,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
  });
  // ImapFlow emits 'error' on an async socket drop; with no listener Node crashes
  // the whole process (the try/catch around connect() does not catch the event).
  client.on("error", (err: any) => {
    console.warn("[buy-in-email] IMAP client error:", err?.message ?? err);
  });

  let imported = 0;
  const since = new Date(Date.now() - 45 * 24 * 60 * 60_000);

  try {
    await client.connect();
    const aliases = Array.from(aliasSet);
    const mailboxesToTry = ["INBOX", "[Gmail]/All Mail"];
    for (const mbName of mailboxesToTry) {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(mbName);
      } catch {
        continue;
      }
      try {
        const uids = await searchUidsForAliases(client, aliases, aliasSet, since);
        if (uids.length === 0) continue;
        for (const uid of uids.sort((a, b) => b - a)) {
          const msg = await client.fetchOne(uid, { source: true });
          if (!msg) continue;
          const raw = msg.source?.toString("utf8") ?? "";
          if (!raw) continue;
          const parsed = parseVendorEmailFromRaw(raw, aliasSet);
          if (!parsed) continue;
          if (!parsed.body && !parsed.messageId) continue;

          const dedupKey = parsed.messageId ?? surrogateMessageId(parsed.aliasEmail, parsed);
          if (seenMessageIds.has(dedupKey)) continue;
          seenMessageIds.add(dedupKey);

          const contact = parsed.fromEmail ? contactBySender.get(parsed.fromEmail) ?? null : null;
          const aliasInfo = aliasByEmail.get(parsed.aliasEmail);
          const buyInId = aliasInfo?.buyInId ?? contact?.buyInId ?? fallbackBuyInId;
          if (buyInId == null) continue; // nothing to attribute the email to

          const arrival = parseArrivalDetailsFromText(parsed.body);
          const arrivalUpdates = Object.fromEntries(
            Object.entries(arrival).filter(([, value]) => String(value ?? "").trim().length > 0),
          );
          if (Object.keys(arrivalUpdates).length > 0) {
            try {
              await storage.updateBuyIn(buyInId, arrivalUpdates);
            } catch (err: any) {
              console.warn("[buy-in-email] arrival update failed:", err?.message ?? err);
            }
          }

          const values: Record<string, unknown> = {
            buyInId,
            reservationId: rid,
            vendorContactId: contact?.id ?? null,
            direction: "inbound",
            fromEmail: parsed.fromEmail || "unknown@unknown",
            toEmail: parsed.aliasEmail,
            subject: parsed.subject,
            body: parsed.body || "(empty body)",
            attachmentsJson: null,
            providerMessageId: dedupKey,
            rawPayload: null,
            parsedArrivalDetails: JSON.stringify(arrivalUpdates),
            status: Object.keys(arrivalUpdates).length > 0 ? "parsed" : "received",
          };
          if (parsed.receivedAt) values.sentAt = parsed.receivedAt;
          await db.insert(buyInEmails).values(values as any);
          imported += 1;
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return { imported };
}

let _schedulerStarted = false;

export async function syncAllBuyInVendorEmails(): Promise<{ reservations: number; imported: number; skipped?: string }> {
  const imap = guestInboxImapConfig();
  if (!imap.configured) return { reservations: 0, imported: 0, skipped: "IMAP not configured" };

  const { db } = await import("./db");
  const { reservationAliases } = await import("@shared/schema");
  const rows = await db
    .select({ reservationId: reservationAliases.reservationId })
    .from(reservationAliases);
  const reservationIds = Array.from(new Set(
    rows.map((r) => String(r.reservationId ?? "").trim()).filter(Boolean),
  ));
  let imported = 0;
  for (const rid of reservationIds) {
    const result = await syncBuyInVendorEmailsForReservation(rid);
    imported += result.imported;
  }
  return { reservations: reservationIds.length, imported };
}

export function startBuyInVendorEmailSyncScheduler(): void {
  if (_schedulerStarted || process.env.BUY_IN_EMAIL_SYNC_DISABLED === "true") return;
  _schedulerStarted = true;
  const intervalMs = Number(process.env.BUY_IN_EMAIL_SYNC_INTERVAL_MS) > 0
    ? Number(process.env.BUY_IN_EMAIL_SYNC_INTERVAL_MS)
    : 5 * 60_000;
  const tick = () => {
    void syncAllBuyInVendorEmails()
      .then((r) => {
        if (r.imported > 0) {
          console.log(`[buy-in-email] background sync imported ${r.imported} message(s) across ${r.reservations} reservation(s)`);
        }
      })
      .catch((err) => console.warn("[buy-in-email] background sync failed:", err?.message ?? err));
  };
  setTimeout(tick, 45_000);
  setInterval(tick, intervalMs);
  console.log(`[buy-in-email] background sync scheduler started (every ${Math.round(intervalMs / 1000)}s)`);
}
