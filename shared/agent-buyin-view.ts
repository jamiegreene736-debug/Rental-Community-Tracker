// Agent-portal LIMITED buy-in view (operator spec 2026-07-20): the remote
// agent may see the back-and-forth email communication with the property
// management company for reservations the operator explicitly shared, but
// NEVER financial information (what the guest paid, what we paid for the
// unit, extracted paid rates, profit).
//
// LOAD-BEARING: this is a WHITELIST projection, not a blacklist. Any column
// added to buy_ins in the future is invisible to agents until it is
// deliberately listed here — so a new financial field can never leak by
// default. `notes` is deliberately EXCLUDED even though it looks harmless:
// Cowork attach notes carry " · $<total>" price segments and instant-book
// backup prices (see titleFromBuyInNoteText in server/routes.ts).
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
};

// The financial / operator-only columns the projection must never emit.
// Enumerated for the test suite's leak lock (tests/agent-buyin-view.test.ts).
export const AGENT_BLOCKED_BUYIN_FIELDS = [
  "costPaid",
  "paidRate",
  "paidRateSource",
  "notes",
  "airbnbConfirmation",
  "bookingConfirmation",
  "bookingError",
  "vrboLookupNote",
  "arrivalExtraction",
  "managementContactSource",
] as const;

export function agentSafeBuyIn(buyIn: BuyIn): AgentSafeBuyIn {
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
  };
}
