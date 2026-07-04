// Failed / uncollected guest-payment warning (dashboard popup).
//
// Operator ask (2026-07-04): raise a red warning — same visual language as the
// refund-receipt alert — whenever (a) a guest payment FAILED (card declined,
// processor error) so he can message the guest and reprocess it in Guesty, or
// (b) a SCHEDULED balance charge (e.g. the "balance due ~90 days before
// arrival" auto-payment) blew past its due date without being collected.
// Retroactive lookback ~2 weeks. CANCELLED bookings are deliberately excluded —
// a cancelled booking's payment can't (and shouldn't) be reprocessed.
//
// Pure helpers only — the server route (GET /api/dashboard/payment-failures)
// owns the Guesty fetch and client/src/pages/home.tsx owns rendering, so this
// logic is regression-testable against real Guesty payment shapes.
//
// Payment-row facts this leans on (see shared/guesty-payment-schedule.ts +
// the payment-collected-detection memory):
//   • a scheduled row's charge date lives on `shouldBePaidAt` (NOT createdAt);
//   • Booking.com bookings can be isFullyPaid:true with totalPaid:0 (channel
//     collects) — gate "nothing owed" on isFullyPaid OR totalPaid>=totalPrice,
//     never on balanceDue===0.

import {
  paymentRowLooksCollected,
  paymentRowLooksScheduled,
  scheduledChargeDateIso,
  type GuestyPaymentRow,
} from "./guesty-payment-schedule";

export const PAYMENT_WARNING_WINDOW_DAYS = 14;
export const PAYMENT_WARNING_WINDOW_MS = PAYMENT_WARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
// A charge due <24h ago may still be mid-processing on Guesty's side — don't
// cry wolf on "due today".
export const PAYMENT_OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000;

export type PaymentIssueKind = "failed" | "overdue";

export type PaymentIssue = {
  kind: PaymentIssueKind;
  amount: number;
  // failed → when the charge attempt failed; overdue → when it was due.
  dateIso: string | null;
  // Raw Guesty payment-row status ("FAILED", "PENDING", …) for display.
  statusRaw: string;
};

export const PAYMENT_ISSUE_KIND_LABELS: Record<PaymentIssueKind, string> = {
  failed: "Payment FAILED — reprocess in Guesty",
  overdue: "Scheduled balance NOT collected",
};

const asNum = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

function rowStatus(row: GuestyPaymentRow): string {
  return String((row as any)?.status ?? (row as any)?.paymentStatus ?? "").trim();
}

function rowBlob(row: GuestyPaymentRow): string {
  const description = String(
    (row as any)?.description ?? (row as any)?.note ?? (row as any)?.label ?? (row as any)?.type ?? (row as any)?.kind ?? "",
  );
  return `${rowStatus(row)} ${description}`.toLowerCase();
}

function rowAmount(row: GuestyPaymentRow): number {
  return asNum(
    (row as any)?.amount ?? (row as any)?.paidAmount ?? (row as any)?.collectedAmount ?? (row as any)?.total ?? (row as any)?.value,
  );
}

// Refund-shaped rows are out of scope here — a failed REFUND is surfaced by the
// guest-receipts refund alert, not the payment warning.
function rowLooksRefund(row: GuestyPaymentRow): boolean {
  return /(refund|reversal|chargeback)/.test(rowBlob(row)) || rowAmount(row) < 0;
}

// A charge attempt Guesty marked failed/declined. STATUS-only match — the
// free-text description may legitimately contain "fail" ("retry if payment
// fails"). "cancel" is deliberately NOT failed: a voided/cancelled payment row
// on an active booking is usually an operator decision, not a decline.
export function paymentRowLooksFailed(row: GuestyPaymentRow | null | undefined): boolean {
  if (!row || typeof row !== "object") return false;
  if (rowLooksRefund(row)) return false;
  return /(fail|declin)/.test(rowStatus(row).toLowerCase());
}

// When did the charge fail? Guesty shapes vary; earlier fields win. Falls back
// to the row's scheduled charge date, then createdAt, then null.
const FAILURE_DATE_FIELDS = [
  "failedAt",
  "failureAt",
  "lastFailedAt",
  "attemptedAt",
  "processedAt",
  "updatedAt",
] as const;

export function paymentFailureDateIso(row: GuestyPaymentRow | null | undefined): string | null {
  if (!row || typeof row !== "object") return null;
  for (const field of FAILURE_DATE_FIELDS) {
    const raw = (row as Record<string, unknown>)[field];
    if (typeof raw === "string" && raw.trim()) return raw;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString();
  }
  const scheduled = scheduledChargeDateIso(row);
  if (scheduled) return scheduled;
  const created = (row as any)?.createdAt;
  if (typeof created === "string" && created.trim()) return created;
  return null;
}

// Mirror of routes.ts isCommittedGuestyReservation's status exclusions. The
// operator's explicit rule: NEVER warn on a cancelled booking (can't take a
// payment for it); inquiries/requests/expired/closed/draft have no confirmed
// money to collect either.
export function reservationExcludedFromPaymentWarnings(
  reservation: { status?: string | null } | null | undefined,
): boolean {
  const status = String(reservation?.status ?? "").toLowerCase();
  return /(cancel|declin|inquir|request|expired|closed|draft)/.test(status);
}

// "Nothing owed" gate. isFullyPaid is authoritative when true (Booking.com
// channel-collected bookings report totalPaid:0 while fully paid — see the
// payment-collected-detection memory). Otherwise a totalPaid that covers the
// total price means a failed attempt was since recovered — don't nag.
export function reservationLooksFullyPaid(reservation: any): boolean {
  const money = reservation?.money ?? {};
  if (money?.isFullyPaid === true) return true;
  const totalPrice = asNum(money?.totalPrice ?? reservation?.totalPrice);
  const totalPaid = asNum(money?.totalPaid);
  return totalPrice > 0 && totalPaid >= totalPrice - 0.5;
}

function reservationPaymentRows(reservation: any): GuestyPaymentRow[] {
  const money = reservation?.money ?? {};
  return [
    ...(Array.isArray(money?.payments) ? money.payments : []),
    ...(Array.isArray(reservation?.payments) ? reservation.payments : []),
    ...(Array.isArray(money?.paymentSchedule) ? money.paymentSchedule : []),
  ].filter((r): r is GuestyPaymentRow => !!r && typeof r === "object");
}

const dayOf = (iso: string | null): string => (iso ? iso.slice(0, 10) : "");

// All actionable payment issues on one reservation, deduped (the same Guesty
// row often appears in both money.payments and reservation.payments; and a
// scheduled row that FAILED must surface once as "failed", not also "overdue").
export function collectReservationPaymentIssues(
  reservation: any,
  nowMs: number,
  opts?: { windowMs?: number; graceMs?: number; fallbackDateIso?: string | null },
): PaymentIssue[] {
  if (reservationExcludedFromPaymentWarnings(reservation)) return [];
  if (reservationLooksFullyPaid(reservation)) return [];

  const windowMs = opts?.windowMs ?? PAYMENT_WARNING_WINDOW_MS;
  const graceMs = opts?.graceMs ?? PAYMENT_OVERDUE_GRACE_MS;
  const windowStart = nowMs - windowMs;

  const inWindow = (iso: string | null): boolean => {
    const resolved = iso ?? opts?.fallbackDateIso ?? null;
    // No date anywhere → surface rather than silently hide (the dismissal
    // signature keeps an undated row from nagging forever).
    if (!resolved) return true;
    const t = new Date(resolved).getTime();
    if (!Number.isFinite(t)) return true;
    return t >= windowStart;
  };

  const issues: PaymentIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: PaymentIssue) => {
    const key = `${issue.kind}|${issue.amount.toFixed(2)}|${dayOf(issue.dateIso)}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };
  // A failed charge's amount+day also blocks the overdue variant of the SAME
  // charge (Guesty may keep the schedule row pending alongside the failed
  // attempt row) — the "failed" framing is the actionable one.
  const failedAmountDays = new Set<string>();

  const rows = reservationPaymentRows(reservation);
  for (const row of rows) {
    if (!paymentRowLooksFailed(row)) continue;
    const amount = Math.abs(rowAmount(row));
    if (amount <= 0) continue;
    const dateIso = paymentFailureDateIso(row);
    if (!inWindow(dateIso)) continue;
    failedAmountDays.add(`${amount.toFixed(2)}|${dayOf(dateIso)}`);
    push({ kind: "failed", amount, dateIso, statusRaw: rowStatus(row) });
  }

  for (const row of rows) {
    if (paymentRowLooksFailed(row) || rowLooksRefund(row)) continue;
    if (paymentRowLooksCollected(row)) continue;
    if (!paymentRowLooksScheduled(row)) continue;
    const dueIso = scheduledChargeDateIso(row);
    if (!dueIso) continue;
    const dueMs = new Date(dueIso).getTime();
    if (!Number.isFinite(dueMs)) continue;
    if (dueMs > nowMs - graceMs) continue; // not (meaningfully) overdue yet
    if (dueMs < windowStart) continue; // outside the retroactive lookback
    const amount = Math.abs(rowAmount(row));
    if (amount <= 0) continue;
    if (failedAmountDays.has(`${amount.toFixed(2)}|${dayOf(dueIso)}`)) continue;
    push({ kind: "overdue", amount, dateIso: dueIso, statusRaw: rowStatus(row) });
  }

  return issues;
}

export type PaymentFailureWarning = {
  reservationId: string;
  confirmationCode: string | null;
  guestName: string | null;
  listingNickname: string | null;
  channel: string | null;
  checkIn: string | null;
  checkOut: string | null;
  conversationId: string | null;
  totalPrice: number | null;
  totalPaid: number | null;
  issues: PaymentIssue[];
};

// Order-independent signature of the current payment-issue facts (mirrors
// duplicatePhotoWarningSignature). Persisted on dismiss; the popup only
// auto-reopens when the facts change — a new failed charge, a new overdue
// balance, or a changed amount re-raises a dismissed warning, while page
// reloads stay quiet.
export function paymentFailureWarningSignature(warnings: PaymentFailureWarning[]): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  return warnings
    .map((w) =>
      `${w.reservationId}:${w.issues
        .map((i) => `${i.kind}|${i.amount.toFixed(2)}|${dayOf(i.dateIso)}`)
        .sort()
        .join(",")}`,
    )
    .sort()
    .join(";");
}
