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
import { findGuestyConversationById, sendGuestyConversationMessage, deliveryOutcome } from "./guesty-ota-messaging";
import { storage } from "./storage";
import {
  buildPaymentReceiptBody,
  buildRefundReceiptBody,
  receiptDedupKey,
  sameTransactionMoment,
  RECEIPT_SENDER_NAME,
  RECEIPT_BRAND_NAME,
  type ReceiptKind,
} from "@shared/receipt-message";
import {
  collectedPaymentsForReceipts,
  realRefundsForReceipts,
  reservationRevenue,
  paymentHistoryForReceipts,
  localizedStayDate,
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
      "_id status checkIn checkOut checkInDateLocalized checkOutDateLocalized listing listingId money payments refunds guest source integration confirmationCode conversationId createdAt updatedAt lastUpdatedAt",
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

async function processTransaction(item: PendingTxn, now: number, opts?: { allowResend?: boolean }): Promise<{ outcome: "sent" | "skipped" | "error"; body?: string; reason?: string }> {
  const { kind, txn, reservation } = item;
  const reservationId = String(reservation?._id ?? reservation?.id ?? "");
  // Per-transaction key, disambiguated by the stable Guesty txn id so a 50%
  // deposit and the auto-charged 50% balance (same day, same amount) get TWO
  // receipts instead of collapsing to one. Id-less rows reproduce the exact
  // legacy day+amount key (backward compatible).
  const dedupKey = receiptDedupKey({ reservationId, kind, dateIso: txn.dateIso, amount: txn.amount, id: txn.id });

  const channel = channelForReservation(reservation);
  const channelLc = channel.toLowerCase();
  // Forward match only: a configured token is treated as a substring of the
  // channel (e.g. "airbnb" mutes "airbnb2"). Do NOT also reverse-match — a
  // misconfigured longer token would silently swallow real channels.
  if (SKIP_CHANNELS.some((s) => channelLc.includes(s))) return { outcome: "skipped", reason: `channel ${channel} is muted` };

  // Already handled? done. "sent" = delivery confirmed; "unconfirmed" = posted
  // but not confirmed; "misroute" = filed off the guest's OTA channel. For the
  // 5-min SCHEDULER all three are TERMINAL — the message was already posted to
  // Guesty once, so re-posting would pile up duplicate receipts on the thread.
  // (A "pending"/"error" row is still reused below to retry a not-yet-posted
  // send.) The operator's manual force-send (`allowResend`) may deliberately
  // retry a non-confirmed send (e.g. after fixing the channel) — only a "sent"
  // row blocks it, matching the pre-hardening manual behavior.
  const terminalStatuses = opts?.allowResend ? ["sent"] : ["sent", "unconfirmed", "misroute"];
  const existing = await storage.getGuestReceiptByDedupKey(dedupKey);
  if (existing && terminalStatuses.includes(existing.status)) {
    const reason =
      existing.status === "sent" ? "already sent"
        : existing.status === "unconfirmed" ? "already posted (delivery unconfirmed) — not resending"
          : "previously misrouted off the guest channel — not resending";
    return { outcome: "skipped", reason, body: existing.messageBody ?? undefined };
  }

  // MIGRATION SHIM (self-expiring): receipts sent BEFORE the txn id was added to
  // the key used a day+amount-only key with no `|<id>` suffix. For an id-bearing
  // transaction whose new key has no row yet, also check that LEGACY key — but
  // only treat it as "already handled" if the legacy row was for THIS exact
  // charge (same capture moment). A legacy row for a DIFFERENT same-day,
  // same-amount charge (the deposit, when THIS is the balance) does NOT match,
  // so the balance still sends. Without this, every recently-receipted charge in
  // the backfill window would re-send once on the deploy that ships the new key.
  // Once pre-upgrade rows age out of the window this never matches again.
  if (txn.id && !existing) {
    const legacyKey = receiptDedupKey({ reservationId, kind, dateIso: txn.dateIso, amount: txn.amount });
    const legacyRow = await storage.getGuestReceiptByDedupKey(legacyKey);
    if (
      legacyRow &&
      terminalStatuses.includes(legacyRow.status) &&
      sameTransactionMoment(legacyRow.transactionDate, txn.dateIso)
    ) {
      return { outcome: "skipped", reason: "already sent (pre-id-upgrade receipt)", body: legacyRow.messageBody ?? undefined };
    }
  }

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
  // Localized calendar date — NOT the raw UTC checkIn (which slices to the wrong
  // day for negative-offset timezones like Hawaii). See localizedStayDate.
  const checkInIso = localizedStayDate(reservation, "in");
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
    checkOut: localizedStayDate(reservation, "out"),
    confirmationCode: reservation?.confirmationCode ?? null,
    channel,
    amount: txn.amount,
    currency: "USD",
    transactionDate: txn.dateIso,
    transactionId: txn.id ?? null,
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

  // Post the message through the delivery-verified OTA path (the same hardened
  // path as Message AD / the inbox compose box): resolve the proven-delivering
  // module from the reservation's integration.platform, send ONCE, and confirm
  // the channel actually accepted it via module.externalId. A bare Guesty
  // `pending` post is NOT proof the guest received the receipt — see AGENTS.md
  // #51 and the guesty-bookingcom-delivery-externalid memory.
  try {
    const conversation = await findGuestyConversationById(conversationId, reservationId, channel);
    const module = conversation?.module ?? { type: channel || "email" };
    const delivery = await sendGuestyConversationMessage({
      conversationId: conversation?.id ?? conversationId,
      body,
      module,
      reservation: conversation?.reservation ?? reservation,
      channelHint: channel,
      logPrefix: "guest-receipts",
    });
    const deliveredChannel = delivery.deliveryModuleType || delivery.deliveredVia || channel;
    const resolvedConversationId = conversation?.id ?? conversationId;

    switch (deliveryOutcome(delivery)) {
      case "delivered":
        await storage.markGuestReceiptSent(token, resolvedConversationId, deliveredChannel);
        console.log(`[guest-receipts] sent ${kind} receipt $${txn.amount.toFixed(2)} to reservation ${reservationId} (${deliveredChannel})`);
        return { outcome: "sent", body };
      case "misroute":
        // HARD non-delivery: Guesty filed the receipt off the guest's booking
        // channel (e.g. on email). Do NOT write a "sent" ledger row — record a
        // terminal misroute (so the scheduler stops re-posting email copies) and
        // surface it for the operator.
        // If this terminal mark fails the row stays non-terminal and the next
        // tick would re-post — log loudly rather than swallowing silently.
        await storage.markGuestReceiptMisrouted(token, delivery.reason ?? `not delivered to the ${deliveredChannel} guest channel`)
          .catch((markErr) => console.error(`[guest-receipts] failed to mark misroute for reservation ${reservationId}: ${markErr?.message ?? markErr}`));
        console.warn(`[guest-receipts] ${kind} receipt MISROUTE for reservation ${reservationId} (${deliveredChannel}): ${delivery.reason ?? ""}`);
        return { outcome: "error", body, reason: delivery.reason ?? "misrouted off the guest channel" };
      default:
        // "unconfirmed": posted to the OTA channel but not confirmed within the
        // verify window. The message WAS posted exactly once — record a terminal
        // "unconfirmed" so the 5-minute scheduler never posts a duplicate
        // receipt, but don't claim a clean delivery.
        // If this terminal mark fails the row stays "pending" and the next tick
        // would re-post — log loudly rather than swallowing silently.
        await storage.markGuestReceiptUnconfirmed(token, resolvedConversationId, deliveredChannel, delivery.reason ?? "delivery not confirmed yet")
          .catch((markErr) => console.error(`[guest-receipts] failed to mark unconfirmed for reservation ${reservationId}: ${markErr?.message ?? markErr}`));
        console.warn(`[guest-receipts] ${kind} receipt POSTED but ${deliveredChannel} delivery unconfirmed for reservation ${reservationId} — not resending: ${delivery.reason ?? ""}`);
        return { outcome: "sent", body };
    }
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
    "_id status checkIn checkOut checkInDateLocalized checkOutDateLocalized listing listingId money payments refunds guest source integration confirmationCode conversationId createdAt updatedAt lastUpdatedAt",
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
      // Manual operator force-send: allow retrying a non-confirmed
      // (unconfirmed/misroute) prior send; only a confirmed "sent" row blocks.
      const { outcome, body, reason } = await processTransaction(item, now, { allowResend: true });
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

// ── Manual on-demand receipt PAGE generation (no message send) ────────────
// Mints a durable /receipt/:token payment-details page from operator-supplied
// values WITHOUT posting any Guesty message. This backs the Guest Inbox
// "Generate payment details page URL" action: the operator gets a shareable,
// printable link they can copy, preview, or fold into the receipt message and
// send themselves.
//
// LOAD-BEARING dedup namespace: the key is prefixed `manual-page|…` and suffixed
// with the unique token so it can NEVER collide with the auto-scheduler's
// canonical `reservationId|kind|day|amount` key (receiptDedupKey). The 5-minute
// scheduler therefore keeps its own independent ledger row and still auto-sends
// its receipt for the same payment if it detects one — the manual page is a
// standalone artifact, not a substitute for the auto send. Status is "page" so
// the row is excluded from every "Receipt sent" badge / sent-status / dashboard
// count (all of which gate on status sent/unconfirmed) and from the GET
// /receipt/:token render (which only checks token + expiry, not status).
export async function createReceiptPage(opts: {
  reservationId: string;
  conversationId?: string | null;
  kind?: ReceiptKind;
  guestName?: string | null;
  guestFirstName?: string | null;
  propertyName?: string | null;
  listingId?: string | null;
  listingNickname?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  confirmationCode?: string | null;
  channel?: string | null;
  amount: number;
  currency?: string | null;
  transactionDate?: string | null;
  bookingTotal?: number | null;
  paymentHistory?: Array<{ date: string; amount: number }>;
  totalPaidToDate?: number | null;
}): Promise<{
  ok: boolean;
  token: string;
  url: string;
  messageBody: string;
  message: string;
  amount?: number;
  bookingTotal?: number;
  paymentHistory?: Array<{ date: string; amount: number }>;
  totalPaidToDate?: number;
  transactionDate?: string;
  kind?: ReceiptKind;
}> {
  const reservationId = String(opts.reservationId ?? "").trim();
  if (!reservationId) {
    return { ok: false, token: "", url: "", messageBody: "", message: "reservationId is required" };
  }

  const kind: ReceiptKind = opts.kind === "refund" ? "refund" : "payment";
  const now = Date.now();

  // AUTHORITATIVE money data. The bug this fixes: the inbox dialog passed a
  // client-built payment history that could be empty or still loading from
  // Guesty, so the minted page reported "$0 paid" for a guest who had actually
  // paid (e.g. Gary Dawes — half paid, page showed nothing). Fetch the
  // reservation and derive the REAL paid-to-date with the SAME detection the
  // auto-scheduler uses (collectedPaymentsForReceipts / reservationRevenue), so
  // the page can't contradict the auto-receipt. The fetch is best-effort: on
  // failure we fall back to the operator-supplied values.
  let reservation: any = null;
  try {
    const fields = encodeURIComponent(
      "_id status checkIn checkOut checkInDateLocalized checkOutDateLocalized listing listingId money payments refunds guest source integration confirmationCode conversationId createdAt updatedAt lastUpdatedAt",
    );
    const data = await guestyRequest("GET", `/reservations/${encodeURIComponent(reservationId)}?fields=${fields}`);
    reservation = data?.result ?? data?.data ?? (data && (data as any)._id ? data : null) ?? null;
  } catch (e: any) {
    console.warn(`[guest-receipts] createReceiptPage: could not fetch reservation ${reservationId} (${e?.message ?? e}) — using operator-supplied values`);
  }

  const token = randomBytes(12).toString("hex");
  const receiptUrl = `${baseUrl()}/receipt/${token}`;

  // Identity fields: operator-supplied first, reservation-derived as fallback.
  const guestFirst = String(
    opts.guestFirstName
      ?? (opts.guestName ? String(opts.guestName).trim().split(/\s+/)[0] : null)
      ?? (reservation ? guestFirstName(reservation) : null)
      ?? "",
  ).trim();
  const guestFull = opts.guestName ?? (reservation ? guestFullName(reservation) : null);
  const propertyName = String(
    opts.propertyName ?? opts.listingNickname ?? (reservation ? propertyNameForReceipt(reservation) : "") ?? "",
  ).trim();
  const listingNick = opts.listingNickname ?? (reservation ? listingNickname(reservation) : null) ?? propertyName ?? null;
  // Stay dates: prefer the reservation's LOCALIZED calendar date (authoritative,
  // correct for Hawaii/negative-offset timezones); fall back to the operator-
  // supplied value only when the Guesty fetch failed. The raw checkIn/checkOut
  // UTC timestamp must NOT be sliced directly — it drifts a day. See
  // localizedStayDate.
  const checkInIso = localizedStayDate(reservation, "in") ?? (opts.checkIn ? String(opts.checkIn).slice(0, 10) : null);
  const checkOutIso = localizedStayDate(reservation, "out") ?? (opts.checkOut ? String(opts.checkOut).slice(0, 10) : null);
  const confirmationCode = opts.confirmationCode ?? reservation?.confirmationCode ?? null;
  const channel = (String(opts.channel ?? "").trim() || (reservation ? channelForReservation(reservation) : "")) || null;
  const currency = String(opts.currency ?? "USD").trim() || "USD";

  // AUTHORITATIVE payment history + booking total (payment receipts only).
  const authHistory = reservation && kind === "payment" ? paymentHistoryForReceipts(reservation) : [];
  const authBookingTotal = reservation && kind === "payment" ? reservationRevenue(reservation) : 0;

  const clientHistory = Array.isArray(opts.paymentHistory)
    ? opts.paymentHistory
        .map((p) => ({ date: String(p?.date ?? "").slice(0, 10), amount: Number(p?.amount) || 0 }))
        .filter((p) => p.amount > 0)
    : [];
  // Trust Guesty's real history when we have it; fall back to whatever the
  // operator typed only when the fetch failed / returned nothing.
  const history = authHistory.length ? authHistory : clientHistory;
  const bookingTotal =
    authBookingTotal > 0 ? authBookingTotal : Number(opts.bookingTotal) > 0 ? Number(opts.bookingTotal) : 0;

  // Headline "this payment". If the operator typed a NEW charge they just ran,
  // use it. Otherwise (a plain payment-details statement, e.g. Gary) headline
  // the guest's MOST RECENT real payment so the page never reads "$0 paid".
  const clientAmount = Number(opts.amount) > 0 ? Number(opts.amount) : 0;
  let amount = clientAmount;
  let transactionDate = opts.transactionDate ? String(opts.transactionDate) : new Date(now).toISOString();
  if (!(amount > 0)) {
    const latest = [...history].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);
    if (latest && latest.amount > 0) {
      amount = latest.amount;
      transactionDate = latest.date || transactionDate;
    }
  }
  if (!(amount > 0)) {
    return {
      ok: false,
      token: "",
      url: "",
      messageBody: "",
      message:
        kind === "refund"
          ? "Enter a refund amount greater than 0."
          : "No collected payments found for this reservation yet. Enter a payment amount to record a charge.",
    };
  }

  // Split the full history into "past" + the headline payment so the builder's
  // total-paid math counts the headline exactly once. If the headline isn't in
  // the history (a brand-new charge not yet reflected in Guesty), it's added on
  // top; otherwise the matching row is removed from "past".
  const day = transactionDate.slice(0, 10);
  let matchedHeadline = false;
  const pastPayments = history.filter((p) => {
    if (!matchedHeadline && p.date === day && Math.abs(p.amount - amount) < 0.005) {
      matchedHeadline = true;
      return false;
    }
    return true;
  });
  const fullHistory =
    kind === "payment"
      ? (matchedHeadline ? history : [...history, { date: day, amount }])
          .slice()
          .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      : [];
  const totalPaidToDate = kind === "payment" ? pastPayments.reduce((s, p) => s + p.amount, 0) + amount : null;

  // Build the receipt MESSAGE body via the SAME shared builders the
  // auto-scheduler uses (so the page-link wording stays in lockstep). The body
  // is returned so the inbox can fold the link into the message it sends.
  let messageBody: string;
  if (kind === "payment") {
    messageBody = buildPaymentReceiptBody({
      guestFirstName: guestFirst,
      propertyName,
      checkInIso,
      paymentAmount: amount,
      paymentDateIso: transactionDate,
      bookingTotal,
      pastPayments,
      receiptUrl,
      channel,
    });
  } else {
    messageBody = buildRefundReceiptBody({
      guestFirstName: guestFirst,
      propertyName,
      checkInIso,
      refundAmount: amount,
      refundDateIso: transactionDate,
      receiptUrl,
      channel,
    });
  }

  const payload = {
    kind,
    brandName: RECEIPT_BRAND_NAME,
    senderName: RECEIPT_SENDER_NAME,
    guestFirstName: guestFirst,
    guestName: guestFull,
    propertyName,
    listingNickname: listingNick,
    checkIn: checkInIso,
    checkOut: checkOutIso,
    confirmationCode,
    channel,
    amount,
    currency,
    transactionDate,
    bookingTotal,
    paymentHistory: fullHistory,
    totalPaidToDate,
    receiptUrl,
    messageBody,
    generatedAt: new Date(now).toISOString(),
  };

  const dedupKey = `manual-page|${reservationId}|${kind}|${transactionDate.slice(0, 10)}|${amount.toFixed(2)}|${token}`;
  const insert: InsertGuestReceipt = {
    token,
    dedupKey,
    reservationId,
    conversationId: opts.conversationId ?? null,
    kind,
    amount: amount.toFixed(2),
    currency,
    transactionDate,
    guestName: guestFull,
    listingId: opts.listingId ?? reservation?.listingId ?? reservation?.listing?._id ?? null,
    listingNickname: listingNick,
    channel,
    messageBody,
    payload,
    status: "page",
    errorMessage: null,
    expiresAt: new Date(now + RECEIPT_PAGE_TTL_DAYS * 24 * 60 * 60 * 1000),
  };
  await storage.createGuestReceipt(insert);
  console.log(`[guest-receipts] minted manual receipt page ${token} for reservation ${reservationId} ($${amount.toFixed(2)} ${kind}, paid-to-date $${Number(totalPaidToDate ?? amount).toFixed(2)}${authHistory.length ? " from Guesty" : " from operator input"})`);
  return {
    ok: true,
    token,
    url: receiptUrl,
    messageBody,
    message: "Receipt page generated",
    amount,
    bookingTotal,
    paymentHistory: fullHistory,
    totalPaidToDate: totalPaidToDate ?? undefined,
    transactionDate,
    kind,
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
