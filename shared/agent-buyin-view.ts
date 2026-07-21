// Agent-portal buy-in view for SHARED reservations.
//
// HISTORY: the 2026-07-20 spec was a LIMITED view — financials (costPaid,
// paid rates, notes with $ totals, guest money) were whitelisted away.
// 2026-07-21 the operator reversed that half: "When I show the agent the
// booking have it show the agent everything as I see it, including the
// financials." The SHARE GATE is unchanged and still load-bearing — agents
// see ONLY reservations the operator shared one by one via "Show in agent
// portal" (reservation_agent_shares); everything else still 403s.
//
// STILL LOAD-BEARING: this remains a WHITELIST projection, not a raw row.
// Any column added to buy_ins in the future stays invisible to agents until
// it is deliberately listed here — the leak-by-default posture survives even
// though the financial set is now deliberately included. The remaining
// blocked fields are internal diagnostics/provenance blobs, not booking data.
import type { BuyIn } from "./schema";

export type AgentSafeBuyIn = {
  id: number;
  guestyReservationId: string | null;
  unitId: string;
  unitLabel: string;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  status: string;
  bookingStatus: string;
  travelerEmail: string | null;
  listingUrl: string | null;
  unitAddress: string | null;
  accessCode: string | null;
  wifiName: string | null;
  wifiPassword: string | null;
  parkingInfo: string | null;
  managementCompany: string | null;
  managementContact: string | null;
  arrivalNotes: string | null;
  // Financials + operator context (operator directive 2026-07-21: the agent
  // sees the shared booking "as I see it").
  costPaid: string | null;
  paidRate: string | null;
  notes: string | null;
  bookingConfirmation: string | null;
  airbnbConfirmation: string | null;
  // Expanded-row badges (2026-07-21 follow-up: "show the reservation as if I
  // am clicking into it") — feed the SAME shared badge helpers the operator's
  // slot cards use (community-verdict-badge / guest-happy-badge / host-friction).
  groundFloorStatus: string | null;
  groundFloorEvidence: string | null;
  communityVerdict: string | null;
  communityVerdictSource: string | null;
  communityVerdictAt: string | null;
  guestHappyVerdict: string | null;
  guestHappyFeedback: string | null;
  guestHappySource: string | null;
  guestHappyAt: string | null;
};

// Internal plumbing the projection still withholds — diagnostics and raw
// provenance blobs, not booking or financial data. Enumerated for the test
// suite's leak lock (tests/agent-buyin-view.test.ts).
export const AGENT_BLOCKED_BUYIN_FIELDS = [
  "paidRateSource",
  "bookingError",
  "vrboLookupNote",
  "arrivalExtraction",
  "managementContactSource",
] as const;

export function agentSafeBuyIn(buyIn: BuyIn): AgentSafeBuyIn {
  const extras = buyIn as unknown as {
    paidRate?: unknown;
    bookingConfirmation?: string | null;
    airbnbConfirmation?: string | null;
  };
  return {
    id: buyIn.id,
    guestyReservationId: buyIn.guestyReservationId ?? null,
    unitId: buyIn.unitId,
    unitLabel: buyIn.unitLabel,
    propertyName: buyIn.propertyName,
    checkIn: buyIn.checkIn,
    checkOut: buyIn.checkOut,
    status: buyIn.status,
    bookingStatus: buyIn.bookingStatus,
    travelerEmail: buyIn.travelerEmail ?? null,
    listingUrl: buyIn.airbnbListingUrl ?? null,
    unitAddress: buyIn.unitAddress ?? null,
    accessCode: buyIn.accessCode ?? null,
    wifiName: buyIn.wifiName ?? null,
    wifiPassword: buyIn.wifiPassword ?? null,
    parkingInfo: buyIn.parkingInfo ?? null,
    managementCompany: buyIn.managementCompany ?? null,
    managementContact: buyIn.managementContact ?? null,
    arrivalNotes: buyIn.arrivalNotes ?? null,
    costPaid: buyIn.costPaid != null ? String(buyIn.costPaid) : null,
    paidRate: extras.paidRate != null ? String(extras.paidRate) : null,
    notes: buyIn.notes ?? null,
    bookingConfirmation: extras.bookingConfirmation ?? null,
    airbnbConfirmation: extras.airbnbConfirmation ?? null,
    groundFloorStatus: loose(buyIn, "groundFloorStatus"),
    groundFloorEvidence: loose(buyIn, "groundFloorEvidence"),
    communityVerdict: loose(buyIn, "communityVerdict"),
    communityVerdictSource: loose(buyIn, "communityVerdictSource"),
    communityVerdictAt: looseIso(buyIn, "communityVerdictAt"),
    guestHappyVerdict: loose(buyIn, "guestHappyVerdict"),
    guestHappyFeedback: loose(buyIn, "guestHappyFeedback"),
    guestHappySource: loose(buyIn, "guestHappySource"),
    guestHappyAt: looseIso(buyIn, "guestHappyAt"),
  };
}

function loose(row: unknown, key: string): string | null {
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

function looseIso(row: unknown, key: string): string | null {
  const value = (row as Record<string, unknown>)[key];
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return typeof value === "string" && value ? value : null;
}

/**
 * Per-booking money roll-up for the agent card header — mirrors what the
 * operator reads off a bookings row: what the guest paid, our payout, what
 * the units cost, and the resulting margin (profit = hostPayout − Σ costPaid,
 * the canonical basis from shared/buy-in-profit.ts). Null-safe: absent money
 * or costs render as unknown, never as $0.
 */
export interface AgentBookingFinancials {
  guestTotal: number | null;
  guestPaid: number | null;
  hostPayout: number | null;
  currency: string | null;
  /** Sum of recorded unit costs; null when NO unit has a recorded cost. */
  unitCostTotal: number | null;
  /** hostPayout − unitCostTotal, only when both sides are known. */
  profit: number | null;
}

function finite(value: unknown): number | null {
  // null/undefined/"" must stay UNKNOWN — Number(null) is 0, and a $0 cost
  // reads as "we got the unit free", not "no cost recorded".
  if (value == null || value === "") return null;
  const n = typeof value === "string" ? Number(value.replace(/[$,]/g, "")) : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function agentBookingFinancials(
  money: unknown,
  units: Array<Pick<AgentSafeBuyIn, "costPaid" | "status">>,
): AgentBookingFinancials {
  const m = (money && typeof money === "object" ? money : {}) as Record<string, unknown>;
  const guestTotal = finite(m.totalPrice ?? m.netAmount);
  const guestPaid = finite(m.totalPaid);
  const hostPayout = finite(m.hostPayout);
  const currency = typeof m.currency === "string" && m.currency ? m.currency : null;
  let unitCostTotal: number | null = null;
  for (const unit of units ?? []) {
    if (!unit || unit.status === "cancelled") continue;
    const cost = finite(unit.costPaid);
    if (cost == null) continue;
    unitCostTotal = (unitCostTotal ?? 0) + cost;
  }
  const profit = hostPayout != null && unitCostTotal != null ? hostPayout - unitCostTotal : null;
  return { guestTotal, guestPaid, hostPayout, currency, unitCostTotal, profit };
}
