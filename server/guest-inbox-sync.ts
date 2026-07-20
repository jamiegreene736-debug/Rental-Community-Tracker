// Sync VRBO guest-thread emails from the SimpleLogin forwarding mailbox into
// guest_inbox_messages. SimpleLogin forwards alias mail to reservations@… with
// X-SimpleLogin-Envelope-To set to the guest alias; the inbound webhook path
// only works when explicitly configured, so we poll IMAP on guest-inbox fetch.

import { createHash } from "node:crypto";
import { extractEmailAddress, SIMPLELOGIN_MAILBOX_EMAIL } from "./simplelogin";
import { extractReadableTextFromMimeEmail, parseEmailHeaders } from "@shared/email-mime";
import { aliasEmailProvesPurchase } from "@shared/alias-bought-in";
import type { InsertGuestInboxMessage } from "@shared/schema";

// Re-exported for the existing importers/tests (buy-in-email-sync.ts,
// tests/pipeline-logic.test.ts) — the implementation moved to shared/email-mime.ts
// so the client-side display healer (shared/email-body-format.ts) can reuse it.
export { parseEmailHeaders };

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

// The readable body of a raw MIME email. Implementation lives in
// shared/email-mime.ts: a real multipart walk that recurses into NESTED
// multiparts (multipart/mixed → multipart/alternative), reads each part's OWN
// headers, and strips HTML shipped inside a mislabeled text/plain part — the
// old top-level-only regex scan stored nested emails (e.g. the Generali policy
// email) with the inner boundary + part headers as literal body text.
export function extractBodyFromRawEmail(raw: string): string {
  return extractReadableTextFromMimeEmail(raw);
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

export function guestInboxImapConfig(): {
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

// Deterministic dedup key for an email with no Message-ID. The basis fields
// (alias + subject + the email's own Date + a body prefix) are stable across sync
// ticks, so the same email re-scanned every tick (or by both the scheduler and an
// on-open GET) won't insert a duplicate row.
function surrogateMessageId(aliasEmail: string, parsed: ParsedRawEmail): string {
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

async function importParsedEmail(parsed: ParsedRawEmail, filterAlias?: string): Promise<boolean> {
  const { storage } = await import("./storage");
  const aliasEmail = parsed.aliasEmail!;
  if (filterAlias && aliasEmail !== filterAlias.toLowerCase()) return false;
  if (!parsed.body && !parsed.messageId) return false;

  // Dedup UNCONDITIONALLY — a real Message-ID when present, else a stable
  // surrogate — so a body-bearing email that lacks a Message-ID isn't re-inserted
  // on every sync tick.
  const dedupKey = parsed.messageId ?? surrogateMessageId(aliasEmail, parsed);
  const recent = await storage.getGuestInboxMessages(aliasEmail, 100);
  if (recent.some((m) => m.providerMessageId && m.providerMessageId === dedupKey)) {
    return false;
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
    providerMessageId: dedupKey,
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
  // A freshly-ingested INBOUND email is proof of purchase — flip the owning
  // buy-in to bought in right away (the 5-min background tick reaches here
  // with no operator involvement). Fail-soft: a mark failure must never make
  // the import look failed (the email row is already persisted).
  try {
    await autoMarkBoughtInFromAliasEmails(aliasEmail);
  } catch (err: any) {
    console.warn("[guest-inbox] auto-mark bought-in failed:", err?.message ?? err);
  }
  // The same inbound email may carry the charged total (VRBO confirmation
  // "Total", payment receipt) — extract + persist the actually-paid rate.
  try {
    const { refreshPaidRateForAlias } = await import("./paid-rate-extract");
    await refreshPaidRateForAlias(aliasEmail);
  } catch (err: any) {
    console.warn("[guest-inbox] paid-rate extract failed:", err?.message ?? err);
  }
  return true;
}

// Any INBOUND email at a buy-in's unit alias verifies the purchase — the alias
// exists only as that unit's booking email, so nothing mails it before a real
// booking (VRBO confirmation, host welcome, PM arrival details). Marks the
// owning buy-in "booked" via the SAME durable transition the bookings-row
// "Mark as bought in" button records (bookedAt stamped = the proof time,
// never-re-book guard armed, the unit's checkout button auto-hides). The
// decision itself is the pure aliasEmailProvesPurchase (shared/alias-bought-in.ts):
// inbound-only, never re-marks a booked row, skips cancelled buy-ins.
// Kill switch: ALIAS_AUTO_BOUGHT_IN_DISABLED=1.
//
// TWO alias mailboxes feed this (both call in here): guest_inbox_messages
// (this file's traveler-alias sync) and buy_in_emails (buy-in-email-sync.ts,
// the bookings-row "Alias email history" panel).
export async function markBuyInBoughtInFromInboundEmail(
  buyInId: number,
  aliasEmail: string,
  source: string,
): Promise<boolean> {
  if (String(process.env.ALIAS_AUTO_BOUGHT_IN_DISABLED ?? "").trim() === "1") return false;
  if (!Number.isFinite(buyInId) || buyInId <= 0) return false;
  const { storage } = await import("./storage");
  const buyIn = await storage.getBuyIn(buyInId);
  // The caller vouches that an inbound email exists — the predicate still owns
  // the buy-in-side rules (never re-mark booked, skip cancelled).
  if (!aliasEmailProvesPurchase(buyIn, [{ direction: "inbound" }])) return false;
  await storage.updateBuyIn(buyInId, {
    bookingStatus: "booked",
    bookedAt: new Date(),
    bookingError: null,
  });
  console.log(
    `[guest-inbox] auto-marked buy-in ${buyInId} (${buyIn?.unitLabel ?? "unit"}) bought in — inbound email at ${aliasEmail} (${source})`,
  );
  return true;
}

/** Traveler-alias flavor: resolve the buy-in by alias, require a stored inbound email. */
export async function autoMarkBoughtInFromAliasEmails(aliasEmail: string): Promise<boolean> {
  const alias = String(aliasEmail ?? "").trim().toLowerCase();
  if (!alias) return false;
  const { storage } = await import("./storage");
  const buyIn = await storage.getBuyInByTravelerEmail(alias);
  if (!buyIn) return false;
  const messages = await storage.getGuestInboxMessages(alias, 50);
  if (!aliasEmailProvesPurchase(buyIn, messages)) return false;
  return markBuyInBoughtInFromInboundEmail(buyIn.id, alias, "guest-inbox");
}

const IMAP_FALLBACK_SCAN_CAP = 300;

async function searchUidsForGuestAlias(
  client: import("imapflow").ImapFlow,
  alias: string,
  since: Date,
): Promise<number[]> {
  const found = new Set<number>();
  // imapflow expects `header` as an OBJECT { "Header-Name": "substring" }, NOT a
  // two-element array — an array compiles to Object.keys(['a','b']) = ['0','1'] and
  // emits `HEADER 0 ... / HEADER 1 ...` which matches nothing, so the per-alias
  // search always returned empty and silently fell back to the 300-message full
  // scan (PR #826's "scan only the relevant per-guest mail" optimization was dead
  // on arrival). HEADER is an IMAP SUBSTRING match, so the bare alias matches both
  // `<alias>` and `alias` — no separate angle-bracket query needed.
  const headerQueries: Array<Record<string, unknown>> = [
    { header: { "X-SimpleLogin-Envelope-To": alias } },
    { header: { "To": alias } },
  ];
  for (const criteria of headerQueries) {
    try {
      const uids = await client.search({ since, ...criteria });
      if (Array.isArray(uids) && uids.length) uids.forEach((uid) => found.add(uid as number));
    } catch (err) {
      // Some IMAP servers reject HEADER search — log and fall back to the scan below.
      console.warn(`[guest-inbox] IMAP header search failed for ${alias}:`, (err as Error)?.message ?? err);
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
  // ImapFlow is an EventEmitter: an async socket drop (e.g. "Connection not
  // available" during compress/startSession) emits 'error', which with no
  // listener CRASHES the whole process (Node's unhandled-'error' rule). The
  // try/catch around connect() does NOT catch this async event. Attaching a
  // listener makes it non-fatal — the awaited call still rejects and is handled.
  client.on("error", (err: any) => {
    console.warn("[guest-inbox] IMAP client error:", err?.message ?? err);
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
