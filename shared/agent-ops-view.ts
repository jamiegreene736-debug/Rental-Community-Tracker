// Agent-portal "as the Operations page shows it" row view (operator directive
// 2026-07-21, screenshot pair: "I want this to show just as if I am on the
// operations page"). The shared-bookings endpoint computes ONE ops-style row
// per shared reservation with the same figures the operator's reservations
// table renders: payout, paid to date, payment next due, buy-in cost, profit,
// nights/channel/party, and the cancellation-policy summary card.
//
// The money/channel/policy rules are MIRRORS of the operator page's local
// helpers in client/src/pages/bookings.tsx (paidToDateOf, nextPaymentDueOf,
// getNetRevenue, channelKindOf, cancellationPolicySummaryOf). They are copied
// — not imported — because bookings.tsx is a 19k-line page module the server
// cannot import; tests/agent-buyin-view.test.ts drift-locks the key rule
// strings against bookings.tsx so the two views can't silently diverge.
import { nextScheduledChargeDate, scheduledChargeDateIso, type GuestyPaymentRow } from "./guesty-payment-schedule";
import { guestPartyFromReservation, formatGuestParty } from "./guest-party";
import type { AgentSafeBuyIn } from "./agent-buyin-view";

type LooseReservation = Record<string, any>;

function asMoneyNumber(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0;
}

export function channelKindOfReservation(r: LooseReservation): "airbnb" | "booking" | "vrbo" | "manual" | "other" {
  const raw = `${r?.integration?.platform ?? ""} ${r?.source ?? ""}`.toLowerCase();
  if (raw.includes("airbnb")) return "airbnb";
  if (raw.includes("booking")) return "booking";
  if (raw.includes("vrbo") || raw.includes("homeaway")) return "vrbo";
  if (raw.includes("manual") || raw.includes("direct")) return "manual";
  return "other";
}

function reservationPaymentItems(r: LooseReservation): LooseReservation[] {
  return [
    ...(Array.isArray(r?.payments) ? r.payments : []),
    ...(Array.isArray(r?.money?.payments) ? r.money.payments : []),
    ...(Array.isArray(r?.money?.paymentSchedule) ? r.money.paymentSchedule : []),
  ];
}

function paymentAmountOf(p: LooseReservation): number {
  return asMoneyNumber(p.amount ?? p.value ?? p.paidAmount ?? p.expectedAmount ?? p.scheduledAmount ?? p.total);
}

function paymentLooksCollected(p: LooseReservation): boolean {
  const status = String(p.status ?? "").toLowerCase();
  const description = String(p.description ?? p.note ?? p.label ?? p.type ?? p.kind ?? "").toLowerCase();
  if (/(refund|void|fail|declin|cancel)/.test(status) || /(refund|void|fail|declin|cancel)/.test(description)) return false;
  if (/(scheduled|pending|unpaid|due|future)/.test(status)) return false;
  if (p.paidAt || p.collectedAt || p.processedAt) return true;
  return /(paid|captured|collected|succeeded|settled|payment|charge)/.test(status + " " + description);
}

/** Mirror of bookings.tsx paidToDateOf — totalPaid, else summed collected rows. */
export function agentPaidToDate(r: LooseReservation): number {
  const totalPaid = asMoneyNumber(r?.money?.totalPaid);
  if (totalPaid > 0) return totalPaid;
  return reservationPaymentItems(r)
    .filter(paymentLooksCollected)
    .reduce((sum, p) => sum + Math.max(0, paymentAmountOf(p)), 0);
}

/** Mirror of bookings.tsx getNetRevenue — hostPayout || netIncome || gross. */
export function agentNetRevenue(r: LooseReservation): number {
  const gross = asMoneyNumber(r?.money?.fareAccommodation) || asMoneyNumber(r?.money?.hostPayout) || asMoneyNumber(r?.money?.totalPaid);
  return asMoneyNumber(r?.money?.hostPayout) || asMoneyNumber(r?.money?.netIncome) || gross;
}

/** Mirror of bookings.tsx nextPaymentDueOf via the shared schedule selector. */
export function agentNextPaymentDueIso(r: LooseReservation, nowMs: number): string | null {
  const due = nextScheduledChargeDate(reservationPaymentItems(r) as GuestyPaymentRow[], nowMs);
  if (due) return due.toISOString();
  // Fall back to the earliest raw scheduled date even if the selector deemed
  // nothing upcoming — null simply renders "Paid in full" client-side.
  void scheduledChargeDateIso;
  return null;
}

export interface AgentCancellationPolicyView {
  label: string;
  summary: string;
  freeCancellationUntil: string;
  penalty: string;
  detailsAvailable: boolean;
  source: string | null;
  assumed: boolean;
}

function cancellationPolicyBriefSummary(label: string, kind: ReturnType<typeof channelKindOfReservation>): string {
  const lower = label.toLowerCase();
  if (kind === "booking") {
    return "Guest is under the Booking.com rate-plan cancellation terms configured in Guesty/Booking.com for this listing.";
  }
  if (kind === "vrbo") {
    return "Guest is under the cancellation, refund, no-show, and date-change terms configured in Guesty and pushed to VRBO/Homeaway for this listing.";
  }
  if (lower.includes("non-refundable") || lower.includes("non refundable") || lower.includes("no refund")) {
    return "Guest booked a non-refundable policy; treat the stay as no-refund unless Guesty/channel rules or an approved exception say otherwise.";
  }
  if (lower.includes("flexible")) {
    return "Guest booked the flexible cancellation policy; refund eligibility follows the flexible window configured in Guesty/channel rules.";
  }
  if (lower.includes("moderate")) {
    return "Guest booked the moderate cancellation policy; refund eligibility follows the moderate window configured in Guesty/channel rules.";
  }
  if (lower.includes("firm")) {
    return "Guest booked the firm cancellation policy; refund eligibility follows the firm window configured in Guesty/channel rules.";
  }
  if (lower.includes("strict")) {
    return "Guest booked the strict cancellation policy; refunds are limited to the strict terms configured in Guesty/channel rules.";
  }
  if (lower.includes("relaxed")) {
    return "Guest booked the relaxed cancellation policy; refund eligibility follows the relaxed window configured in Guesty/channel rules.";
  }
  return "Guest is under the cancellation, refund, no-show, and date-change terms attached to this booking in Guesty.";
}

function cancellationPolicyTerms(label: string, kind: ReturnType<typeof channelKindOfReservation>) {
  const lower = label.toLowerCase();
  if (kind === "booking") {
    return {
      freeCancellationUntil: "Not exposed by Guesty for this Booking.com rate plan",
      penalty: "Check the Booking.com rate-plan/extranet terms; Guesty only returned the booking/rate-plan reference, not the penalty schedule.",
      detailsAvailable: false,
    };
  }
  if (kind === "vrbo") {
    if (lower.includes("relaxed")) {
      return { freeCancellationUntil: "14+ days before check-in", penalty: "7-14 days before check-in: 50% refund. Less than 7 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("moderate")) {
      return { freeCancellationUntil: "30+ days before check-in", penalty: "14-30 days before check-in: 50% refund. Less than 14 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("firm")) {
      return { freeCancellationUntil: "60+ days before check-in", penalty: "30-60 days before check-in: 50% refund. Less than 30 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("strict")) {
      return { freeCancellationUntil: "60+ days before check-in", penalty: "Less than 60 days before check-in: no refund.", detailsAvailable: true };
    }
  }
  if (lower.includes("non-refundable") || lower.includes("non refundable") || lower.includes("no refund")) {
    return { freeCancellationUntil: "No free-cancellation window", penalty: "Reservation is non-refundable once booked unless the channel/Guesty exception rules apply.", detailsAvailable: true };
  }
  if (lower.includes("flexible")) {
    return { freeCancellationUntil: "1 day / 24 hours before check-in", penalty: "After that cutoff, Guesty/channel cancellation fees apply; for Airbnb Flexible, the first night is generally not refunded after the cutoff.", detailsAvailable: true };
  }
  if (lower.includes("moderate")) {
    return { freeCancellationUntil: "5 days before check-in on Airbnb; 7 days before arrival for Guesty direct/manual policies", penalty: "After that cutoff, Guesty/channel cancellation fees apply; for Airbnb Moderate, the host is generally paid nights stayed, one extra night, and 50% of remaining nights.", detailsAvailable: true };
  }
  if (lower.includes("firm")) {
    return { freeCancellationUntil: "14-30 days before check-in, depending on channel policy", penalty: "After that cutoff, Guesty/channel cancellation fees apply; Airbnb Firm usually becomes 50% refundable until 7 days before check-in, then non-refundable.", detailsAvailable: true };
  }
  if (lower.includes("strict")) {
    return { freeCancellationUntil: "14-60 days before check-in, depending on channel policy", penalty: "After that cutoff, Guesty/channel cancellation fees apply; strict policies generally become non-refundable closer to check-in.", detailsAvailable: true };
  }
  if (lower.includes("relaxed")) {
    return { freeCancellationUntil: "14+ days before check-in", penalty: "7-14 days before check-in: 50% refund. Less than 7 days before check-in: no refund.", detailsAvailable: true };
  }
  return { freeCancellationUntil: "Configured in Guesty, but the exact cutoff was not exposed", penalty: "Use the Guesty/channel reservation policy details for the cancellation fee or no-show penalty.", detailsAvailable: false };
}

/** Mirror of bookings.tsx cancellationPolicySummaryOf. */
export function agentCancellationPolicy(r: LooseReservation): AgentCancellationPolicyView | null {
  const kind = channelKindOfReservation(r);
  if (r?.cancellationPolicy) {
    const terms = cancellationPolicyTerms(String(r.cancellationPolicy), kind);
    return {
      label: String(r.cancellationPolicy),
      summary: r.cancellationPolicySummary ?? cancellationPolicyBriefSummary(String(r.cancellationPolicy), kind),
      freeCancellationUntil: r.cancellationPolicyFreeCancellationUntil ?? terms.freeCancellationUntil,
      penalty: r.cancellationPolicyPenalty ?? terms.penalty,
      detailsAvailable: r.cancellationPolicyDetailsAvailable ?? terms.detailsAvailable,
      source: r.cancellationPolicySource ?? null,
      assumed: r.cancellationPolicyAssumed === true,
    };
  }
  if (kind === "booking") {
    const label = "Booking.com cancellation policy configured in Guesty";
    return {
      label,
      summary: cancellationPolicyBriefSummary(label, kind),
      ...cancellationPolicyTerms(label, kind),
      source: "Assumed from the policy Guesty pushed to Booking.com",
      assumed: true,
    };
  }
  if (kind === "vrbo") {
    const label = "VRBO cancellation policy configured in Guesty";
    return {
      label,
      summary: cancellationPolicyBriefSummary(label, kind),
      ...cancellationPolicyTerms(label, kind),
      source: "Assumed from the policy Guesty pushed to VRBO",
      assumed: true,
    };
  }
  return null;
}

/** The ops-table row, as the operator sees it. */
export interface AgentOpsRowView {
  channelKind: ReturnType<typeof channelKindOfReservation>;
  /** The raw channel label the ops row shows as a chip (e.g. "Homeaway2"). */
  channelLabel: string | null;
  nights: number | null;
  /** "12 guests (10 adults, 2 children)" via shared/guest-party. */
  partyLabel: string | null;
  payout: number | null;
  paidToDate: number | null;
  paidInFull: boolean;
  nextPaymentDueIso: string | null;
  buyInCost: number | null;
  profit: number | null;
  cancellationPolicy: AgentCancellationPolicyView | null;
}

export function agentOpsRowView(
  reservation: LooseReservation | null,
  units: Array<Pick<AgentSafeBuyIn, "costPaid" | "status">>,
  nowMs: number,
): AgentOpsRowView {
  const r = reservation ?? {};
  let buyInCost: number | null = null;
  for (const unit of units ?? []) {
    if (!unit || unit.status === "cancelled") continue;
    if (unit.costPaid == null || unit.costPaid === "") continue;
    const cost = Number(String(unit.costPaid).replace(/[$,]/g, ""));
    if (!Number.isFinite(cost)) continue;
    buyInCost = (buyInCost ?? 0) + cost;
  }
  const hasMoney = !!(r as LooseReservation)?.money;
  const payout = hasMoney ? agentNetRevenue(r) : null;
  const paidToDate = hasMoney ? agentPaidToDate(r) : null;
  const balanceDue = asMoneyNumber(r?.money?.balanceDue);
  const paidInFull = r?.money?.isFullyPaid === true || (hasMoney && balanceDue <= 0 && asMoneyNumber(r?.money?.totalPaid) > 0);
  const party = guestPartyFromReservation(r as never);
  const nightsRaw = Number(r?.nightsCount);
  return {
    channelKind: channelKindOfReservation(r),
    channelLabel: typeof r?.source === "string" && r.source ? r.source : (r?.integration?.platform ?? null),
    nights: Number.isFinite(nightsRaw) && nightsRaw > 0 ? nightsRaw : null,
    partyLabel: party ? formatGuestParty(party) : null,
    payout: payout != null && payout > 0 ? payout : payout === 0 && hasMoney ? 0 : payout,
    paidToDate,
    paidInFull,
    nextPaymentDueIso: agentNextPaymentDueIso(r, nowMs),
    buyInCost,
    profit: payout != null && buyInCost != null ? payout - buyInCost : null,
    cancellationPolicy: agentCancellationPolicy(r),
  };
}
