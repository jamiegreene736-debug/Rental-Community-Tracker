// Guest payment/refund receipt auto-send.
//
// When the operator takes a payment or issues a refund in Guesty, the money
// lands on the reservation's `money` object. This scheduler polls recently-
// updated Guesty reservations, detects each collected payment and real refund
// (reusing the SAME extraction the Operations revenue tile uses — see
// server/guesty-money.ts), and for any transaction dated within a tight
// backfill window that we have not receipted yet, it:
//   1. mints a durable /receipt/:token page (stored in guest_receipts),
//   2. posts a receipt MESSAGE into the guest's Guesty conversation — which
//      routes to the channel they booked with (Airbnb/VRBO/Booking.com/email)
//      and so also shows up in our Guest Inbox thread,
//   3. records the send so the same transaction is never messaged twice
//      (guest_receipts.dedup_key is UNIQUE).
//
// Rollout: auto-on (disable with GUEST_RECEIPTS_DISABLED=true or the
// /api/inbox/guest-receipts/toggle endpoint). A TIGHT backfill window
// (RECEIPT_BACKFILL_HOURS, default 48) means the first run after deploy only
// messages transactions from the last ~2 days — it never blasts historical
// payments/refunds. A per-run send cap (RECEIPT_MAX_SENDS_PER_RUN, default 25)
// is a burst guard; the remainder send on the next tick.
//
// Modeled on server/booking-confirmations.ts (same cadence + toggle shape).

import { randomBytes } from "crypto";
import { guestyRequest } from "./guesty-sync";
import { storage } from "./storage";
import {
  buildPaymentReceiptBody,
  buildRefundReceiptBody,
  receiptDedupKey,
  RECEIPT_SENDER_NAME,
  RECEIPT_BRAND_NAME,
  type ReceiptKind,
} from "@shared/receipt-message";
import {
  collectedPaymentsForReceipts,
  realRefundsForReceipts,
  reservationRevenue,
  paymentHistoryForReceipts,
  type ReceiptTransaction,
} from "./guesty-money";
import type { InsertGuestReceipt } from "@shared/schema";

let _enabled = process.env.GUEST_RECEIPTS_DISABLED !== "true";
let _lastRunAt: Date | null = null;
let _lastRunResult: { processed: number; sent: number; skipped: number; errors: number; message: string } | null = null;

const BACKFILL_HOURS = Number(process.env.RECEIPT_BACKFILL_HOURS) > 0 ? Number(process.env.RECEIPT_BACKFILL_HOURS) : 48;
const MAX_SENDS_PER_RUN = Number(process.env.RECEIPT_MAX_SENDS_PER_RUN) > 0 ? Number(process.env.RECEIPT_MAX_SENDS_PER_RUN) : 25;
// Channels to NOT auto-receipt (e.g. "airbnb,vrbo" if the OTA's own receipts
// make ours redundant). Matched loosely against the resolved channel.
const SKIP_CHANNELS = String(process.env.RECEIPT_SKIP_CHANNELS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const PAGE_LIMIT = 100;
const MAX_PAGES = 12;
const RECEIPT_PAGE_TTL_DAYS = 365;

export function getGuestReceiptStatus() {
  return { enabled: _enabled, lastRunAt: _lastRunAt, lastRunResult: _lastRunResult, backfillHours: BACKFILL_HOURS };
}

export function setGuestReceiptsEnabled(v: boolean) {
  _enabled = v;
  console.log(`[guest-receipts] ${v ? "Enabled" : "Disabled"}`);
}

// Public base URL for the durable receipt link. No `req` here (scheduler), so
// it must come from env — same precedence as routes.ts agreementBaseUrl().
function baseUrl(): string {
  const configured =
    process.env.PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://admin.vacationrentalexpertz.com");
  const withProtocol = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  return withProtocol.replace(/\/+$/, "");
}

function unwrapReservations(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function guestFirstName(reservation: any): string {
  const g = reservation?.guest ?? {};
  const full = g.fullName ?? g.full_name;
  return String(g.firstName ?? g.first_name ?? (typeof full === "string" ? full.split(" ")[0] : "") ?? "").trim();
}

function guestFullName(reservation: any): string | null {
  const g = reservation?.guest ?? {};
  const joined = [g.firstName ?? g.first_name, g.lastName ?? g.last_name].filter(Boolean).join(" ").trim();
  return joined || (g.fullName ?? g.full_name ?? g.name ?? null);
}

function listingNickname(reservation: any): string | null {
  const l = reservation?.listing ?? {};
  return l.nickname ?? l.title ?? null;
}

function propertyNameForReceipt(reservation: any): string {
  const l = reservation?.listing ?? {};
  return String(l.nickname ?? l.title ?? "").trim();
}

// The Guesty send-message `module.type` to reply through: bookingCom | airbnb2
// | homeaway | email. Prefer the integration platform; fall back to the source
// label. (Same mapping as routes.ts findGuestyConversationForReservation.)
function channelForReservation(reservation: any): string {
  const platform = String(reservation?.integration?.platform ?? "").trim();
  if (platform) return platform;
  const src = String(reservation?.source ?? "").toLowerCase();
  if (/booking\.?com/.test(src)) return "bookingCom";
  if (/airbnb/.test(src)) return "airbnb2";
  if (/vrbo|homeaway|expedia/.test(src)) return "homeaway";
  return "email";
}

function conversationIdForReservation(reservation: any): string | null {
  const id = reservation?.conversationId ?? reservation?.conversation?._id ?? reservation?.conversation?.id;
  return id ? String(id) : null;
}

async function sendGuestyMessage(conversationId: string, body: string, channelType: string): Promise<void> {
  // Guesty's /send-message rejects extra module keys, so send only `type`.
  const module: Record<string, unknown> = { type: channelType || "email" };
  await guestyRequest("POST", `/communication/conversations/${conversationId}/send-message`, { body, module });
}

type PendingTxn = { kind: ReceiptKind; txn: ReceiptTransaction; reservation: any };

export async function runGuestReceipts(): Promise<NonNullable<typeof _lastRunResult>> {
  if (!_enabled) {
    const r = { processed: 0, sent: 0, skipped: 0, errors: 0, message: "Guest receipts disabled" };
    _lastRunAt = new Date();
    _lastRunResult = r;
    return r;
  }

  let processed = 0, sent = 0, skipped = 0, errors = 0;
  const now = Date.now();
  const cutoff = now - BACKFILL_HOURS * 60 * 60 * 1000;

  try {
    const fields = encodeURIComponent(
      "_id status checkIn checkOut listing listingId money payments refunds guest source integration confirmationCode conversationId createdAt updatedAt lastUpdatedAt",
    );
    const updatedAtOf = (r: any): number => {
      const raw = r?.lastUpdatedAt ?? r?.updatedAt ?? r?.createdAt;
      const t = raw ? new Date(String(raw)).getTime() : NaN;
      return Number.isFinite(t) ? t : 0;
    };

    // Page recently-updated reservations first (a payment/refund bumps the
    // money object -> lastUpdatedAt), so a refund on a months-old booking is
    // still seen. Pick the first sort the account accepts, then page until a
    // full page is entirely older than the window.
    const reservations: any[] = [];
    const sortCandidates = ["-lastUpdatedAt", "-updatedAt", "-createdAt"];
    let usedSort = "";
    for (const sort of sortCandidates) {
      try {
        const data = await guestyRequest("GET", `/reservations?limit=${PAGE_LIMIT}&skip=0&sort=${sort}&fields=${fields}`);
        reservations.push(...unwrapReservations(data));
        usedSort = sort;
        break;
      } catch {
        // try the next sort field
      }
    }
    if (!usedSort) throw new Error("Guesty rejected every reservation list sort");

    if (reservations.length === PAGE_LIMIT) {
      for (let page = 1; page < MAX_PAGES; page++) {
        const data = await guestyRequest("GET", `/reservations?limit=${PAGE_LIMIT}&skip=${page * PAGE_LIMIT}&sort=${usedSort}&fields=${fields}`);
        const pageRows = unwrapReservations(data);
        if (pageRows.length === 0) break;
        reservations.push(...pageRows);
        const allOlderThanWindow = pageRows.every((r) => updatedAtOf(r) < cutoff);
        if (pageRows.length < PAGE_LIMIT || allOlderThanWindow) break;
      }
    }

    // Collect every payment/refund transaction inside the backfill window.
    const inWindow = (t: ReceiptTransaction) => t.date.getTime() >= cutoff && t.date.getTime() <= now + 60_000;
    const pending: PendingTxn[] = [];
    for (const reservation of reservations) {
      processed++;
      const reservationId = String(reservation?._id ?? reservation?.id ?? "");
      if (!reservationId) { skipped++; continue; }
      for (const txn of collectedPaymentsForReceipts(reservation)) {
        if (inWindow(txn)) pending.push({ kind: "payment", txn, reservation });
      }
      for (const txn of realRefundsForReceipts(reservation)) {
        if (inWindow(txn)) pending.push({ kind: "refund", txn, reservation });
      }
    }
    // Oldest-first so a per-run cap never starves the earliest transaction.
    pending.sort((a, b) => a.txn.date.getTime() - b.txn.date.getTime());

    let sendsThisRun = 0;
    for (const item of pending) {
      if (sendsThisRun >= MAX_SENDS_PER_RUN) { skipped++; continue; }
      try {
        const { outcome } = await processTransaction(item, now);
        if (outcome === "sent") { sent++; sendsThisRun++; }
        else if (outcome === "error") { errors++; }
        else { skipped++; }
      } catch (e: any) {
        errors++;
        console.error(`[guest-receipts] error processing ${item.kind}: ${e?.message ?? e}`);
      }
    }
  } catch (e: any) {
    errors++;
    console.error(`[guest-receipts] top-level error: ${e?.message ?? e}`);
  }

  _lastRunAt = new Date();
  _lastRunResult = {
    processed, sent, skipped, errors,
    message: `Processed ${processed} reservations — sent ${sent}, skipped ${skipped}, errors ${errors}`,
  };
  console.log(`[guest-receipts] ${_lastRunResult.message}`);
  return _lastRunResult;
}

async function processTransaction(item: PendingTxn, now: number): Promise<{ outcome: "sent" | "skipped" | "error"; body?: string; reason?: string }> {
  const { kind, txn, reservation } = item;
  const reservationId = String(reservation?._id ?? reservation?.id ?? "");
  const dedupKey = receiptDedupKey({ reservationId, kind, dateIso: txn.dateIso, amount: txn.amount });

  const channel = channelForReservation(reservation);
  const channelLc = channel.toLowerCase();
  // Forward match only: a configured token is treated as a substring of the
  // channel (e.g. "airbnb" mutes "airbnb2"). Do NOT also reverse-match — a
  // misconfigured longer token would silently swallow real channels.
  if (SKIP_CHANNELS.some((s) => channelLc.includes(s))) return { outcome: "skipped", reason: `channel ${channel} is muted` };

  // Already sent? done. (A pending/error row is reused below to retry.)
  const existing = await storage.getGuestReceiptByDedupKey(dedupKey);
  if (existing && existing.status === "sent") return { outcome: "skipped", reason: "already sent", body: existing.messageBody ?? undefined };

  // Need a conversation to post into. If none yet, do NOT write a row — retry
  // on a later tick once Guesty has a conversation for the reservation.
  const conversationId = conversationIdForReservation(reservation);
  if (!conversationId) return { outcome: "skipped", reason: "no Guesty conversation for reservation yet" };

  // Reuse the token from a prior attempt so the durable link stays stable, but
  // ALWAYS rebuild the body/payload from the CURRENT reservation so a RETRY
  // re-sends up-to-date data (never a stale body cached at the first attempt).
  const token = existing?.token ?? randomBytes(12).toString("hex");
  const receiptUrl = `${baseUrl()}/receipt/${token}`;

  const propertyName = propertyNameForReceipt(reservation);
  const guestFirst = guestFirstName(reservation);
  const checkInIso = reservation?.checkIn ? String(reservation.checkIn).slice(0, 10) : null;
  const bookingTotal = reservationRevenue(reservation);
  const history = paymentHistoryForReceipts(reservation);

  let body: string;
  if (kind === "payment") {
    // Split the full collected history into "past" + "this payment" so the
    // builder's totalPaid is not double-counted (it adds this payment back).
    // Removing the first date+amount match is order-independent for the math:
    // two identical same-day payments are indistinguishable, and the day+amount
    // dedup key means only one is ever receipted anyway.
    const day = txn.dateIso.slice(0, 10);
    let removedThis = false;
    const pastPayments = history.filter((p) => {
      if (!removedThis && p.date === day && Math.abs(p.amount - txn.amount) < 0.005) {
        removedThis = true;
        return false;
      }
      return true;
    });
    body = buildPaymentReceiptBody({
      guestFirstName: guestFirst,
      propertyName,
      checkInIso,
      paymentAmount: txn.amount,
      paymentDateIso: txn.dateIso,
      bookingTotal,
      pastPayments,
      receiptUrl,
      channel,
    });
  } else {
    body = buildRefundReceiptBody({
      guestFirstName: guestFirst,
      propertyName,
      checkInIso,
      refundAmount: txn.amount,
      refundDateIso: txn.dateIso,
      receiptUrl,
      channel,
    });
  }

  const payload = {
    kind,
    brandName: RECEIPT_BRAND_NAME,
    senderName: RECEIPT_SENDER_NAME,
    guestFirstName: guestFirst,
    guestName: guestFullName(reservation),
    propertyName,
    listingNickname: listingNickname(reservation),
    checkIn: checkInIso,
    checkOut: reservation?.checkOut ? String(reservation.checkOut).slice(0, 10) : null,
    confirmationCode: reservation?.confirmationCode ?? null,
    channel,
    amount: txn.amount,
    currency: "USD",
    transactionDate: txn.dateIso,
    bookingTotal,
    paymentHistory: kind === "payment" ? history : [],
    totalPaidToDate: kind === "payment" ? history.reduce((s, p) => s + p.amount, 0) : null,
    receiptUrl,
    messageBody: body,
    generatedAt: new Date(now).toISOString(),
  };

  if (!existing) {
    const insert: InsertGuestReceipt = {
      token,
      dedupKey,
      reservationId,
      conversationId,
      kind,
      amount: txn.amount.toFixed(2),
      currency: "USD",
      transactionDate: txn.dateIso,
      guestName: guestFullName(reservation),
      listingId: reservation?.listingId ?? reservation?.listing?._id ?? null,
      listingNickname: listingNickname(reservation),
      channel,
      messageBody: body,
      payload,
      status: "pending",
      errorMessage: null,
      expiresAt: new Date(now + RECEIPT_PAGE_TTL_DAYS * 24 * 60 * 60 * 1000),
    };
    try {
      await storage.createGuestReceipt(insert);
    } catch {
      // UNIQUE(dedup_key) race — another tick already created it. Let that one
      // own the send; re-check and skip if it already went out.
      const reread = await storage.getGuestReceiptByDedupKey(dedupKey);
      if (!reread || reread.status === "sent") return { outcome: "skipped", reason: "concurrent tick owns this send" };
      return { outcome: "skipped", reason: "concurrent tick owns this send" };
    }
  } else {
    // Retry path: refresh the stored body + page payload so the durable page and
    // the re-sent message both reflect current data.
    await storage.updateGuestReceiptContent(token, { messageBody: body, payload, conversationId }).catch(() => {});
  }

  // Post the message, then mark the row's send outcome.
  try {
    await sendGuestyMessage(conversationId, body, channel);
    await storage.markGuestReceiptSent(token, conversationId, channel);
    console.log(`[guest-receipts] sent ${kind} receipt $${txn.amount.toFixed(2)} to reservation ${reservationId} (${channel})`);
    return { outcome: "sent", body };
  } catch (e: any) {
    await storage.markGuestReceiptError(token, e?.message ?? String(e)).catch(() => {});
    console.error(`[guest-receipts] send failed (${kind}, reservation ${reservationId}): ${e?.message ?? e}`);
    return { outcome: "error", body, reason: e?.message ?? String(e) };
  }
}

// ── Manual force-send for a single reservation ────────────────────────────
// Operator escape hatch for when a refund/payment was issued in Guesty but the
// auto-scheduler did not pick it up (e.g. it fell outside the backfill window,
// or Guesty exposed the money in a shape detection missed). Fetches just this
// reservation, runs the SAME body-build + send + ledger path as the scheduler,
// and — unlike the scheduler — ignores the backfill window. An explicit
// {amount,dateIso} forces a receipt even if detection still cannot see the txn.
export async function sendReceiptForReservation(opts: {
  reservationId?: string;
  confirmationCode?: string;
  kind?: ReceiptKind;
  amount?: number;
  dateIso?: string;
}): Promise<{
  ok: boolean;
  reservationId: string | null;
  results: Array<{ kind: ReceiptKind; amount: number; outcome: string; reason?: string; body?: string }>;
  message: string;
}> {
  const fields = encodeURIComponent(
    "_id status checkIn checkOut listing listingId money payments refunds guest source integration confirmationCode conversationId createdAt updatedAt lastUpdatedAt",
  );

  let reservation: any = null;
  if (opts.reservationId) {
    const data = await guestyRequest("GET", `/reservations/${encodeURIComponent(opts.reservationId)}?fields=${fields}`).catch(() => null);
    reservation = data?.result ?? data?.data ?? (data && data._id ? data : null) ?? null;
  }
  if (!reservation && opts.confirmationCode) {
    const filters = encodeURIComponent(JSON.stringify([{ field: "confirmationCode", operator: "$eq", value: opts.confirmationCode }]));
    const data = await guestyRequest("GET", `/reservations?limit=1&fields=${fields}&filters=${filters}`).catch(() => null);
    reservation = unwrapReservations(data)[0] ?? null;
  }
  if (!reservation) {
    return { ok: false, reservationId: opts.reservationId ?? null, results: [], message: "Reservation not found in Guesty" };
  }

  const reservationId = String(reservation?._id ?? reservation?.id ?? "");
  const now = Date.now();
  const pending: PendingTxn[] = [];

  if (opts.amount && opts.amount > 0) {
    // Explicit override — trust the operator's amount/date, skip detection.
    const kind: ReceiptKind = opts.kind ?? "refund";
    const date = opts.dateIso ? new Date(opts.dateIso) : new Date(now);
    const dateIso = Number.isNaN(date.getTime()) ? new Date(now).toISOString() : date.toISOString();
    pending.push({ kind, txn: { amount: opts.amount, date: new Date(dateIso), dateIso, description: `Manual ${kind} receipt` }, reservation });
  } else {
    // Detection path — no backfill-window filter, so an older txn still sends.
    if (!opts.kind || opts.kind === "payment") {
      for (const txn of collectedPaymentsForReceipts(reservation)) pending.push({ kind: "payment", txn, reservation });
    }
    if (!opts.kind || opts.kind === "refund") {
      for (const txn of realRefundsForReceipts(reservation)) pending.push({ kind: "refund", txn, reservation });
    }
  }

  if (pending.length === 0) {
    return {
      ok: false,
      reservationId,
      results: [],
      message: "No payment or refund transactions detected on this reservation. Pass an explicit amount (and date) to force-send.",
    };
  }

  const results: Array<{ kind: ReceiptKind; amount: number; outcome: string; reason?: string; body?: string }> = [];
  for (const item of pending) {
    try {
      const { outcome, body, reason } = await processTransaction(item, now);
      results.push({ kind: item.kind, amount: item.txn.amount, outcome, reason, body });
    } catch (e: any) {
      results.push({ kind: item.kind, amount: item.txn.amount, outcome: "error", reason: e?.message ?? String(e) });
    }
  }
  const sent = results.filter((r) => r.outcome === "sent").length;
  return {
    ok: sent > 0,
    reservationId,
    results,
    message: `Sent ${sent} of ${results.length} receipt(s) for reservation ${reservationId}`,
  };
}

export function startGuestReceiptScheduler() {
  // Stagger after the other schedulers finish booting.
  setTimeout(() => { runGuestReceipts().catch(() => {}); }, 60_000);

  // Every 5 minutes — same cadence as booking confirmations, so a payment or
  // refund taken in Guesty is receipted within ~5 minutes.
  const INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => { runGuestReceipts().catch(() => {}); }, INTERVAL_MS);

  console.log(`[guest-receipts] Scheduler started (every 5 minutes, ${BACKFILL_HOURS}h backfill window)`);
}
