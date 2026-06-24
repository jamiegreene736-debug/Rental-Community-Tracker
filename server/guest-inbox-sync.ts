// Sync VRBO guest-thread emails from the SimpleLogin forwarding mailbox into
// guest_inbox_messages. SimpleLogin forwards alias mail to reservations@… with
// X-SimpleLogin-Envelope-To set to the guest alias; the inbound webhook path
// only works when explicitly configured, so we poll IMAP on guest-inbox fetch.

import { extractEmailAddress, SIMPLELOGIN_MAILBOX_EMAIL } from "./simplelogin";
import type { InsertGuestInboxMessage } from "@shared/schema";

const DEFAULT_GUEST_EMAIL_DOMAIN = "emailprivaccy.com";

const SYNC_MIN_INTERVAL_MS = 60_000;
const lastSyncAtByAlias = new Map<string, number>();

type ParsedRawEmail = {
  aliasEmail: string | null;
  fromEmail: string | null;
  subject: string;
  messageId: string | null;
  body: string;
  receivedAt: Date | null;
};

export function parseEmailHeaders(raw: string): Record<string, string> {
  const headerBlock = raw.split(/\r?\n\r?\n/)[0] ?? "";
  const headers: Record<string, string> = {};
  let currentName = "";
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && currentName) {
      headers[currentName] += ` ${line.trim()}`;
      continue;
    }
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    currentName = match[1].trim().toLowerCase();
    headers[currentName] = match[2].trim();
  }
  return headers;
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractBodyFromRawEmail(raw: string): string {
  const headers = parseEmailHeaders(raw);
  const contentType = headers["content-type"] || "text/plain";
  const splitAt = raw.search(/\r?\n\r?\n/);
  const body = splitAt >= 0 ? raw.slice(splitAt).replace(/^\r?\n\r?\n/, "") : "";

  if (/multipart/i.test(contentType)) {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = body.split(`--${boundary}`);
      for (const part of parts) {
        if (/content-type:\s*text\/plain/i.test(part)) {
          const partBody = part.split(/\r?\n\r?\n/).slice(1).join("\n\n");
          const text = decodeQuotedPrintable(partBody.trim());
          if (text) return text.slice(0, 500_000);
        }
      }
      for (const part of parts) {
        if (/content-type:\s*text\/html/i.test(part)) {
          const partBody = part.split(/\r?\n\r?\n/).slice(1).join("\n\n");
          const text = stripHtml(decodeQuotedPrintable(partBody.trim()));
          if (text) return text.slice(0, 500_000);
        }
      }
    }
  }

  const decoded = /text\/html/i.test(contentType)
    ? stripHtml(decodeQuotedPrintable(body.trim()))
    : decodeQuotedPrintable(body.trim());
  return decoded.slice(0, 500_000);
}

function guestAliasFromHeaders(headers: Record<string, string>): string | null {
  const candidates = [
    headers["x-simplelogin-envelope-to"],
    headers["x-simplelogin-envelope_to"],
    headers["to"],
  ];
  for (const raw of candidates) {
    const email = extractEmailAddress(String(raw ?? "")).trim().toLowerCase();
    if (email && isGuestBookingAliasEmail(email)) return email;
  }
  return null;
}

/** Resolve the guest booking alias from email headers (IMAP raw mail or webhook payload). */
export function resolveGuestAliasEmail(
  headers: Record<string, string>,
  fallbackTo?: string,
): string | null {
  const fromHeaders = guestAliasFromHeaders(headers);
  if (fromHeaders) return fromHeaders;
  const fb = extractEmailAddress(String(fallbackTo ?? "")).trim().toLowerCase();
  if (fb && isGuestBookingAliasEmail(fb)) return fb;
  return null;
}

/** Build a normalized header map from an inbound email webhook body + request headers. */
export function headersFromInboundEmailPayload(
  body: Record<string, unknown> | null | undefined,
  reqHeaders?: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (reqHeaders) {
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
    }
  }
  const bh = body?.headers;
  if (bh && typeof bh === "object" && !Array.isArray(bh)) {
    for (const [k, v] of Object.entries(bh as Record<string, unknown>)) {
      headers[String(k).trim().toLowerCase()] = String(v ?? "").trim();
    }
  }
  for (const key of [
    "x-simplelogin-envelope-to",
    "x-simplelogin-envelope-from",
    "x-simplelogin-original-from",
    "to",
    "from",
  ]) {
    const underscored = key.replace(/-/g, "_");
    const flat = body?.[key] ?? body?.[underscored];
    if (flat != null && String(flat).trim()) headers[key] = String(flat).trim();
  }
  return headers;
}

export function isGuestBookingAliasEmail(email: string): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return false;
  const domain = e.split("@")[1] || "";
  const configured = (process.env.BUYIN_TRAVELER_EMAIL_DOMAIN || DEFAULT_GUEST_EMAIL_DOMAIN).trim().toLowerCase();
  const alternates = String(process.env.BUYIN_TRAVELER_EMAIL_DOMAIN_ALTS || "emailprivacy.com")
    .split(/[,;\s]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set([configured, ...alternates]);
  return allowed.has(domain);
}

export function parseGuestInboxEmailFromRaw(raw: string): ParsedRawEmail | null {
  const headers = parseEmailHeaders(raw);
  const aliasEmail = guestAliasFromHeaders(headers);
  if (!aliasEmail) return null;

  const fromEmail = extractEmailAddress(
    headers["x-simplelogin-envelope-from"]
    || headers["x-simplelogin-original-from"]
    || headers["from"]
    || "",
  ).trim().toLowerCase() || null;

  const subject = String(headers["subject"] ?? "").trim() || "(no subject)";
  const messageId = String(headers["message-id"] ?? "").trim().replace(/^<|>$/g, "") || null;
  const dateRaw = headers["date"];
  const receivedAt = dateRaw ? new Date(dateRaw) : null;
  const body = extractBodyFromRawEmail(raw);

  return {
    aliasEmail,
    fromEmail,
    subject,
    messageId,
    body,
    receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
  };
}

function guestNameFromAlias(aliasEmail: string): string | null {
  const localPart = aliasEmail.split("@")[0] || "";
  return localPart
    .split(/[._]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || null;
}

function guestInboxImapConfig(): {
  configured: boolean;
  host: string;
  port: number;
  user: string;
  pass: string;
} {
  const user = (
    process.env.GUEST_INBOX_IMAP_USER
    || process.env.RESERVATIONS_IMAP_USER
    || SIMPLELOGIN_MAILBOX_EMAIL
  ).trim();
  const pass = (
    process.env.GUEST_INBOX_IMAP_PASSWORD
    || process.env.RESERVATIONS_IMAP_PASSWORD
    || process.env.GMAIL_APP_PASSWORD
    || ""
  ).replace(/\s+/g, "");
  const host = (process.env.GUEST_INBOX_IMAP_HOST || "imap.gmail.com").trim();
  const port = Number(process.env.GUEST_INBOX_IMAP_PORT || 993);
  return { configured: !!(user && pass), host, port, user, pass };
}

async function importParsedEmail(parsed: ParsedRawEmail, filterAlias?: string): Promise<boolean> {
  const { storage } = await import("./storage");
  const aliasEmail = parsed.aliasEmail!;
  if (filterAlias && aliasEmail !== filterAlias.toLowerCase()) return false;
  if (!parsed.body && !parsed.messageId) return false;

  if (parsed.messageId) {
    const recent = await storage.getGuestInboxMessages(aliasEmail, 100);
    if (recent.some((m) => m.providerMessageId && m.providerMessageId === parsed.messageId)) {
      return false;
    }
  }

  const buyIn = await storage.getBuyInByTravelerEmail(aliasEmail);
  const values: InsertGuestInboxMessage = {
    aliasEmail,
    guestName: guestNameFromAlias(aliasEmail),
    buyInId: buyIn?.id ?? null,
    reservationId: buyIn?.guestyReservationId ?? null,
    direction: "inbound",
    fromEmail: parsed.fromEmail || "unknown@unknown",
    toEmail: aliasEmail,
    subject: parsed.subject,
    body: parsed.body || "(empty body)",
    attachmentsJson: null,
    providerMessageId: parsed.messageId,
    rawPayload: null,
  };
  if (parsed.receivedAt) {
    (values as InsertGuestInboxMessage & { receivedAt?: Date }).receivedAt = parsed.receivedAt;
  }
  await storage.createGuestInboxMessage(values);
  try {
    const { applyArrivalDetailsFromGuestMessage } = await import("./guest-inbox-arrival");
    await applyArrivalDetailsFromGuestMessage({
      aliasEmail,
      subject: parsed.subject,
      body: parsed.body,
    });
  } catch (err: any) {
    console.warn("[guest-inbox] arrival extract failed:", err?.message ?? err);
  }
  return true;
}

const IMAP_FALLBACK_SCAN_CAP = 300;

async function searchUidsForGuestAlias(
  client: import("imapflow").ImapFlow,
  alias: string,
  since: Date,
): Promise<number[]> {
  const found = new Set<number>();
  const headerQueries: Array<Record<string, unknown>> = [
    { header: ["X-SimpleLogin-Envelope-To", alias] },
    { header: ["X-SimpleLogin-Envelope-To", `<${alias}>`] },
    { header: ["To", alias] },
  ];
  for (const criteria of headerQueries) {
    try {
      const uids = await client.search({ since, ...criteria });
      if (uids?.length) uids.forEach((uid) => found.add(uid as number));
    } catch {
      // Some IMAP servers reject HEADER search — fall back below.
    }
  }
  if (found.size > 0) return [...found];

  const uids = await client.search({ since });
  if (!uids?.length) return [];
  for (const uid of uids.slice().reverse().slice(0, IMAP_FALLBACK_SCAN_CAP)) {
    const msg = await client.fetchOne(uid as number, { source: true });
    const raw = msg.source?.toString("utf8") ?? "";
    if (!raw) continue;
    const parsed = parseGuestInboxEmailFromRaw(raw);
    if (parsed?.aliasEmail === alias) found.add(uid as number);
  }
  return [...found];
}

export async function syncGuestInboxForAlias(aliasEmail: string): Promise<{ imported: number; skipped?: string }> {
  const alias = String(aliasEmail ?? "").trim().toLowerCase();
  if (!alias) return { imported: 0, skipped: "empty alias" };

  const now = Date.now();
  const last = lastSyncAtByAlias.get(alias) ?? 0;
  if (now - last < SYNC_MIN_INTERVAL_MS) return { imported: 0, skipped: "throttled" };
  lastSyncAtByAlias.set(alias, now);

  const imap = guestInboxImapConfig();
  if (!imap.configured) {
    return { imported: 0, skipped: "IMAP not configured" };
  }

  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.port === 993,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
  });

  let imported = 0;
  const since = new Date(Date.now() - 45 * 24 * 60 * 60_000);

  try {
    await client.connect();
    const mailboxesToTry = ["INBOX", "[Gmail]/All Mail"];
    for (const mbName of mailboxesToTry) {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
      try {
        lock = await client.getMailboxLock(mbName);
      } catch {
        continue;
      }
      try {
        const uids = await searchUidsForGuestAlias(client, alias, since);
        if (uids.length === 0) continue;
        for (const uid of uids.sort((a, b) => b - a)) {
          const msg = await client.fetchOne(uid, { source: true });
          const raw = msg.source?.toString("utf8") ?? "";
          if (!raw) continue;
          const parsed = parseGuestInboxEmailFromRaw(raw);
          if (!parsed?.aliasEmail) continue;
          if (await importParsedEmail(parsed, alias)) imported += 1;
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

export async function syncAllGuestInboxAliases(): Promise<{ aliases: number; imported: number; skipped?: string }> {
  const imap = guestInboxImapConfig();
  if (!imap.configured) return { aliases: 0, imported: 0, skipped: "IMAP not configured" };

  const { db } = await import("./db");
  const { buyIns } = await import("@shared/schema");
  const { isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({ email: buyIns.travelerEmail })
    .from(buyIns)
    .where(isNotNull(buyIns.travelerEmail));
  const aliases = [...new Set(
    rows
      .map((r) => String(r.email ?? "").trim().toLowerCase())
      .filter((e) => e && isGuestBookingAliasEmail(e)),
  )];
  let imported = 0;
  for (const alias of aliases) {
    const result = await syncGuestInboxForAlias(alias);
    imported += result.imported;
  }
  return { aliases: aliases.length, imported };
}

export function startGuestInboxSyncScheduler(): void {
  if (_schedulerStarted || process.env.GUEST_INBOX_SYNC_DISABLED === "true") return;
  _schedulerStarted = true;
  const intervalMs = Number(process.env.GUEST_INBOX_SYNC_INTERVAL_MS) > 0
    ? Number(process.env.GUEST_INBOX_SYNC_INTERVAL_MS)
    : 5 * 60_000;
  const tick = () => {
    void syncAllGuestInboxAliases()
      .then((r) => {
        if (r.imported > 0) {
          console.log(`[guest-inbox] background sync imported ${r.imported} message(s) across ${r.aliases} alias(es)`);
        }
      })
      .catch((err) => console.warn("[guest-inbox] background sync failed:", err?.message ?? err));
  };
  setTimeout(tick, 30_000);
  setInterval(tick, intervalMs);
  console.log(`[guest-inbox] background sync scheduler started (every ${Math.round(intervalMs / 1000)}s)`);
}
