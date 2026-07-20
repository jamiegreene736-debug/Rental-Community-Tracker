// Actual-paid rate extraction from the unit alias inbox (operator ask
// 2026-07-19: "right next to the unit buy-in price, in green or red, put the
// rate that was ACTUALLY paid — pull it from the emails within the alias
// inboxes, and store it for reporting").
//
// The per-unit SimpleLogin alias receives the real booking paper trail — the
// VRBO/Booking confirmation, payment receipts, host messages. Confirmation
// emails carry the authoritative charged TOTAL, which is what gets compared
// against buy_ins.costPaid (the price recorded when the unit was attached,
// often a search-time estimate). This module is PURE and deterministic:
// label-anchored line scanning, no AI call — a money figure can only come
// from a line that literally names it, so a hallucinated amount is
// structurally impossible and every extraction carries its verbatim quote.
//
// TIER RULE (load-bearing): explicit TOTAL labels ("Total", "Grand total",
// "Total charged", "Booking total") outrank PAID-SO-FAR labels ("Amount
// paid", "Payment received"). A split-payment deposit receipt says "Amount
// paid $702.50" while the booking's real cost is the confirmation's "Total
// $1,405.00" — the operator wants the rate paid FOR THE UNIT, not the
// installment. Ties break to the newest email; within one email the LAST
// match of the winning tier wins (summaries sit at the bottom).

import { stripLinkMarkers } from "./email-mime";

export type PaidRateMailbox = "guest-inbox" | "buy-in-email";

export type PaidRateEmail = {
  direction?: string | null;
  subject?: string | null;
  body?: string | null;
  fromEmail?: string | null;
  /** receivedAt / sentAt — used only for newest-wins tie-breaking. */
  at?: string | Date | null;
  id?: number | null;
  mailbox?: PaidRateMailbox;
};

export type PaidAmountCandidate = {
  amount: number;
  /** Which label family matched — "total" | "paid". */
  label: string;
  /** 2 = booking-total labels, 1 = paid-so-far labels. Higher wins. */
  tier: number;
  /** Verbatim line(s) the amount came from — the operator-auditable proof. */
  quote: string;
};

export type PaidRateSelection = PaidAmountCandidate & {
  email: PaidRateEmail;
};

/** Durable provenance persisted in buy_ins.paid_rate_source (jsonb). */
export type PaidRateSourceRecord = {
  mailbox: PaidRateMailbox | null;
  emailId: number | null;
  fromEmail: string | null;
  subject: string | null;
  emailAt: string | null;
  label: string;
  quote: string;
  amount: number;
  extractedAt: string;
};

// Booking-total labels (tier 2). Word-anchored so "Total nights" without a
// dollar figure can never match (the money regex requires a currency mark).
const TOTAL_LABEL_RE = /\b(grand total|trip total|booking total|order total|total charged|total charge|total payment|total price|total cost|total)\b/i;
// Paid-so-far labels (tier 1) — used only when no email carries a total.
const PAID_LABEL_RE = /\b(amount paid|payment received|you paid|paid amount|charged to|payment of|amount charged)\b/i;
// Lines that talk about money NOT yet (or no longer) paid, or per-unit-of-time
// rates — never a source for "actually paid". "payment 1 of 2" style
// installment rows are excluded so a schedule table can't win over the total.
const EXCLUDE_LINE_RE = /\b(due|remaining|balance|owed|refund|refunded|per night|nightly|avg|average|payment \d|deposit)\b|\/\s*night/i;

// $1,405.00 / $1405 / USD 1,405.00 — currency-marked so bare counts never match.
const MONEY_RE = /(?:\$|usd\s*\$?\s*)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi;

const MAX_PLAUSIBLE_PAID = 100000;

function parseMoneyMatches(line: string): number[] {
  const out: number[] = [];
  MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY_RE.exec(line)) != null) {
    const whole = Number(m[1].replace(/,/g, ""));
    const cents = m[2] ? Number(`0.${m[2].padEnd(2, "0")}`) : 0;
    const amount = whole + cents;
    if (Number.isFinite(amount) && amount > 0 && amount < MAX_PLAUSIBLE_PAID) out.push(amount);
  }
  return out;
}

function trimQuote(text: string): string {
  const q = text.replace(/\s+/g, " ").trim();
  return q.length > 160 ? `${q.slice(0, 157)}...` : q;
}

/**
 * Scan one email's text for the charged amount. Label-anchored: a candidate
 * needs a total/paid label on the SAME line as the money figure, or on the
 * line directly above it (email tables flatten to label/amount on adjacent
 * lines). Excluded lines (due/balance/refund/per-night/installments) never
 * produce a candidate. Returns the best candidate or null.
 */
export function extractPaidAmountFromEmailText(
  subject: string | null | undefined,
  body: string | null | undefined,
): PaidAmountCandidate | null {
  // "[link: …]" markers (preserved hyperlinks) are stripped first — a receipt
  // URL's digit runs must never be mistaken for a money figure, and a marker
  // on a labeled line would pollute the verbatim quote.
  const text = stripLinkMarkers(`${subject ?? ""}\n${body ?? ""}`);
  const lines = text.split(/\r?\n/);
  let best: PaidAmountCandidate | null = null;
  const consider = (tier: number, label: string, amount: number, quote: string) => {
    // Higher tier wins; same tier → LAST occurrence wins (final summary).
    if (!best || tier > best.tier || tier === best.tier) {
      best = { amount, label, tier, quote: trimQuote(quote) };
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (EXCLUDE_LINE_RE.test(line)) continue;
    const totalMatch = TOTAL_LABEL_RE.exec(line);
    const paidMatch = totalMatch ? null : PAID_LABEL_RE.exec(line);
    const match = totalMatch ?? paidMatch;
    if (!match) continue;
    const tier = totalMatch ? 2 : 1;
    const labelKind = totalMatch ? "total" : "paid";
    const sameLine = parseMoneyMatches(line);
    if (sameLine.length > 0) {
      consider(tier, labelKind, sameLine[sameLine.length - 1], line);
      continue;
    }
    // Table layout: the amount sits on the next non-empty line.
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && !EXCLUDE_LINE_RE.test(lines[j])) {
      const nextLine = parseMoneyMatches(lines[j]);
      if (nextLine.length > 0) consider(tier, labelKind, nextLine[0], `${line.trim()} ${lines[j].trim()}`);
    }
  }
  return best;
}

function emailTimestamp(e: PaidRateEmail): number {
  const raw = e.at;
  if (!raw) return 0;
  const t = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pick the authoritative paid rate across the whole alias mailbox. INBOUND
 * emails only (our own outbound composes prove nothing). Highest tier wins
 * across all emails; within a tier the newest email wins.
 */
export function selectPaidRateFromEmails(emails: ReadonlyArray<PaidRateEmail>): PaidRateSelection | null {
  const inbound = emails.filter(
    (e) => String(e?.direction ?? "").trim().toLowerCase() === "inbound",
  );
  const sorted = [...inbound].sort((a, b) => emailTimestamp(b) - emailTimestamp(a));
  let best: PaidRateSelection | null = null;
  for (const email of sorted) {
    const candidate = extractPaidAmountFromEmailText(email.subject, email.body);
    if (!candidate) continue;
    // sorted newest-first, so the first candidate at a given tier is already
    // the newest — only a strictly HIGHER tier later in the walk replaces it.
    if (!best || candidate.tier > best.tier) {
      best = { ...candidate, email };
    }
    if (best.tier >= 2 && candidate.tier >= 2) break; // newest total found — done
  }
  return best;
}

/** Build the durable jsonb provenance record for a selection. */
export function paidRateSourceRecord(picked: PaidRateSelection, extractedAt: Date): PaidRateSourceRecord {
  const at = picked.email.at;
  return {
    mailbox: picked.email.mailbox ?? null,
    emailId: picked.email.id ?? null,
    fromEmail: picked.email.fromEmail ?? null,
    subject: picked.email.subject ?? null,
    emailAt: at ? (at instanceof Date ? at.toISOString() : new Date(at).toISOString()) : null,
    label: picked.label,
    quote: picked.quote,
    amount: picked.amount,
    extractedAt: extractedAt.toISOString(),
  };
}

/**
 * Green/red verdict for the UI: RED when the extracted paid rate exceeds the
 * recorded buy-in cost by more than $1 (or 0.5%, whichever is larger) — we
 * paid more than the books say. GREEN otherwise, including when no cost was
 * recorded (paid rate is then the only truth; nothing contradicts it).
 */
export function paidRateTone(
  costPaid: string | number | null | undefined,
  paidRate: string | number | null | undefined,
): "green" | "red" | null {
  const paid = Number(paidRate);
  if (!Number.isFinite(paid) || paid <= 0) return null;
  const cost = Number(costPaid);
  if (!Number.isFinite(cost) || cost <= 0) return "green";
  const tolerance = Math.max(1, cost * 0.005);
  return paid > cost + tolerance ? "red" : "green";
}

/**
 * Should the extraction be persisted? Write when nothing is stored yet or the
 * amount changed (a newer/better email supersedes). A same-amount re-extract
 * is skipped so panel-read reconciles don't churn the row.
 */
export function paidRateNeedsWrite(
  existingRate: string | number | null | undefined,
  next: PaidRateSelection,
): boolean {
  const existing = Number(existingRate);
  if (!Number.isFinite(existing) || existing <= 0) return true;
  return Math.abs(existing - next.amount) > 0.009;
}
