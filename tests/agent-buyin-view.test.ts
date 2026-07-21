// Agent-limited buy-in view (operator spec 2026-07-20): the agent sees the PM
// email back-and-forth for explicitly-shared reservations, NEVER financial
// data. This suite locks (a) the whitelist projection, (b) the auth allowlist
// rows, and (c) the route/UI wiring via source guards so the gate can't be
// silently removed or bypassed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BuyIn } from "../shared/schema";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { agentSafeBuyIn, AGENT_BLOCKED_BUYIN_FIELDS } = await import("../shared/agent-buyin-view");

console.log("agent buy-in view suite");

// ── 1. Projection whitelist ─────────────────────────────────────────────────
const fullBuyIn = {
  id: 540,
  propertyId: 19,
  unitId: "prop19-unit-a",
  propertyName: "Menehune Shores",
  unitLabel: "Unit 106",
  checkIn: "2026-08-01",
  checkOut: "2026-08-08",
  costPaid: "1405.00",
  airbnbConfirmation: "ABC123CONF",
  airbnbListingUrl: "https://www.vrbo.com/1234567",
  unitAddress: "760 S Kihei Rd #106, Kihei, HI",
  accessCode: "6509",
  wifiName: "Menehune106",
  wifiPassword: "aloha-wifi",
  parkingInfo: "Stall 106",
  managementCompany: "Alii Resorts",
  managementContact: "reservations@aliiresorts.com · +18088796284",
  managementContactSource: { quote: "secret provenance" },
  arrivalNotes: "Check in after 3pm",
  groundFloorStatus: "unknown",
  groundFloorEvidence: null,
  notes: "Found via Cowork web search — Kihei — Menehune 106 · $1,405 total · Instant-book backup: https://x — $1,522",
  status: "active",
  guestyReservationId: "res-abc",
  attachedAt: new Date("2026-07-01T00:00:00Z"),
  unitTypeConfidence: 90,
  unitTypeConfidenceBreakdown: null,
  bookingStatus: "booked",
  bookingConfirmation: "HA-XYZ-999",
  bookedAt: new Date("2026-07-02T00:00:00Z"),
  travelerEmail: "jacelyn.tsu.410862@emailprivaccy.com",
  bookingError: null,
  communityVerdict: "same_building",
  communityVerdictSource: "cowork",
  communityVerdictAt: null,
  guestHappyVerdict: null,
  guestHappyFeedback: null,
  guestHappySource: null,
  guestHappyAt: null,
  vrboLookupStatus: "kept_cheaper",
  vrboLookupNote: "VRBO total $1,690 — kept the $1,405 direct booking",
  vrboLookupAt: null,
  arrivalExtraction: { doorCode: { quote: "The door code is 6509." } },
  paidRate: "1522.50",
  paidRateSource: { quote: "Total charged $1,522.50" },
  createdAt: new Date("2026-06-30T00:00:00Z"),
} satisfies Record<string, unknown> as unknown as BuyIn;

const safe = agentSafeBuyIn(fullBuyIn);

// Exact whitelist — a new buy_ins column never leaks without being added here
// AND in shared/agent-buyin-view.ts deliberately.
assert.deepEqual(
  Object.keys(safe).sort(),
  [
    "accessCode",
    "airbnbConfirmation",
    "arrivalNotes",
    "bookingConfirmation",
    "bookingStatus",
    "checkIn",
    "checkOut",
    "communityVerdict",
    "communityVerdictAt",
    "communityVerdictSource",
    "costPaid",
    "groundFloorEvidence",
    "groundFloorStatus",
    "guestHappyAt",
    "guestHappyFeedback",
    "guestHappySource",
    "guestHappyVerdict",
    "guestyReservationId",
    "id",
    "listingUrl",
    "managementCompany",
    "managementContact",
    "notes",
    "paidRate",
    "parkingInfo",
    "propertyName",
    "status",
    "travelerEmail",
    "unitAddress",
    "unitId",
    "unitLabel",
    "wifiName",
    "wifiPassword",
  ],
);
// Expanded-row badge fields ride through for the shared badge helpers
// (2026-07-21 "as if I am clicking into it").
assert.equal((safe as any).communityVerdict, (fullBuyIn as any).communityVerdict ?? null);
assert.equal((safe as any).guestHappyVerdict, (fullBuyIn as any).guestHappyVerdict ?? null);
for (const blocked of AGENT_BLOCKED_BUYIN_FIELDS) {
  assert.equal(blocked in (safe as unknown as Record<string, unknown>), false, `blocked field leaked: ${blocked}`);
}
// 2026-07-21 REVERSAL (operator: "show the agent everything as I see it,
// including the financials"): the financial fields are now DELIBERATELY
// included for shared reservations. The whitelist posture survives for
// future columns; internal provenance blobs stay blocked.
assert.equal(safe.costPaid, "1405.00");
assert.equal(safe.paidRate, "1522.50");
assert.ok(String(safe.notes ?? "").length > 0, "notes must reach the agent now");
assert.equal(safe.unitLabel, "Unit 106");
assert.equal(safe.managementCompany, "Alii Resorts");
assert.equal(safe.accessCode, "6509"); // arrival info IS the point of the view
assert.equal(safe.listingUrl, "https://www.vrbo.com/1234567");
console.log("  ✓ agentSafeBuyIn whitelist now carries the financials (2026-07-21 directive); provenance blobs still blocked");

// ── financial roll-up ──
const { agentBookingFinancials } = await import("../shared/agent-buyin-view");
{
  const fin = agentBookingFinancials(
    { totalPrice: 6711, totalPaid: 3355.5, hostPayout: 5900, currency: "USD" },
    [
      { costPaid: "1405.00", status: "active" },
      { costPaid: "1837.00", status: "active" },
      { costPaid: "999.00", status: "cancelled" }, // cancelled never counts
    ],
  );
  assert.equal(fin.guestTotal, 6711);
  assert.equal(fin.guestPaid, 3355.5);
  assert.equal(fin.hostPayout, 5900);
  assert.equal(fin.unitCostTotal, 3242);
  assert.equal(fin.profit, 5900 - 3242);
  const empty = agentBookingFinancials(null, [{ costPaid: null, status: "active" }]);
  assert.equal(empty.guestTotal, null);
  assert.equal(empty.unitCostTotal, null, "no recorded costs must be unknown, never $0");
  assert.equal(empty.profit, null);
}
console.log("  ✓ agentBookingFinancials: payout − unit costs, cancelled excluded, unknowns stay null");

// ── ops-row view ("show just as if I am on the operations page", 2026-07-21) ──
const { agentOpsRowView, agentNetRevenue, agentPaidToDate, agentCancellationPolicy } = await import("../shared/agent-ops-view");
{
  const reservation = {
    source: "homeaway2",
    integration: { platform: "homeaway" },
    nightsCount: 5,
    guestsCount: 12,
    numberOfGuests: { numberOfAdults: 10, numberOfChildren: 2 },
    money: {
      hostPayout: 3480,
      totalPaid: 3480,
      balanceDue: 0,
      isFullyPaid: true,
      currency: "USD",
      payments: [{ status: "SUCCEEDED", amount: 3480, paidAt: "2026-07-01T00:00:00Z" }],
    },
  };
  const units = [
    { costPaid: "1405.00", status: "active" },
    { costPaid: "1837.00", status: "active" },
  ];
  const ops = agentOpsRowView(reservation, units as any, Date.parse("2026-07-21T00:00:00Z"));
  assert.equal(ops.channelKind, "vrbo");
  assert.equal(ops.channelLabel, "homeaway2");
  assert.equal(ops.nights, 5);
  assert.ok(String(ops.partyLabel).includes("12 guests"), `party label: ${ops.partyLabel}`);
  assert.equal(ops.payout, 3480);
  assert.equal(ops.paidToDate, 3480);
  assert.equal(ops.paidInFull, true);
  assert.equal(ops.buyInCost, 3242);
  assert.equal(ops.profit, 238);
  assert.ok(ops.cancellationPolicy, "VRBO channel must yield the assumed policy card");
  assert.equal(ops.cancellationPolicy!.assumed, true);
  assert.ok(/VRBO cancellation policy configured in Guesty/.test(ops.cancellationPolicy!.label));
  // Scheduled balance → next-due date surfaces
  const scheduled = {
    ...reservation,
    money: {
      ...reservation.money,
      isFullyPaid: false,
      balanceDue: 1740,
      totalPaid: 1740,
      payments: [
        { status: "SUCCEEDED", amount: 1740, paidAt: "2026-07-01T00:00:00Z" },
        { status: "PENDING", amount: 1740, shouldBePaidAt: "2026-09-01T00:00:00Z" },
      ],
    },
  };
  const ops2 = agentOpsRowView(scheduled, units as any, Date.parse("2026-07-21T00:00:00Z"));
  assert.equal(ops2.paidInFull, false);
  assert.ok(String(ops2.nextPaymentDueIso).startsWith("2026-09-01"), `next due: ${ops2.nextPaymentDueIso}`);
  // No money (manual) → unknowns stay null, unit costs still roll up
  const manual = agentOpsRowView(null, units as any, Date.now());
  assert.equal(manual.payout, null);
  assert.equal(manual.profit, null);
  assert.equal(manual.buyInCost, 3242);
}
console.log("  ✓ agentOpsRowView mirrors the ops table: payout/paid/next-due/profit/policy");

// DRIFT LOCK: the shared mirrors and the operator page must keep the same
// money + channel rules. If bookings.tsx changes these, update
// shared/agent-ops-view.ts in the same PR (and vice versa).
{
  const bookingsSrc = readFileSync(fileURLToPath(new URL("../client/src/pages/bookings.tsx", import.meta.url)), "utf8");
  const opsViewSrc = readFileSync(fileURLToPath(new URL("../shared/agent-ops-view.ts", import.meta.url)), "utf8");
  for (const rule of [
    'raw.includes("vrbo") || raw.includes("homeaway")', // channel kind
    "asMoneyNumber(r?.money?.hostPayout) || asMoneyNumber(r?.money?.netIncome)".replace("r?.money", "r.money"), // net revenue chain (bookings shape)
  ]) {
    void rule;
  }
  assert.ok(bookingsSrc.includes('raw.includes("vrbo") || raw.includes("homeaway")'), "bookings channel rule moved — re-sync agent-ops-view");
  assert.ok(opsViewSrc.includes('raw.includes("vrbo") || raw.includes("homeaway")'), "agent-ops-view channel rule drifted");
  assert.ok(bookingsSrc.includes("asMoneyNumber(r.money?.hostPayout) || asMoneyNumber(r.money?.netIncome)"), "bookings net-revenue chain moved — re-sync agent-ops-view");
  assert.ok(opsViewSrc.includes("asMoneyNumber(r?.money?.hostPayout) || asMoneyNumber(r?.money?.netIncome)"), "agent-ops-view net-revenue chain drifted");
  assert.ok(bookingsSrc.includes("Assumed from the policy Guesty pushed to VRBO"), "bookings VRBO assumed-policy copy moved — re-sync agent-ops-view");
  assert.ok(opsViewSrc.includes("Assumed from the policy Guesty pushed to VRBO"), "agent-ops-view VRBO assumed-policy copy drifted");
}
console.log("  ✓ drift locks: agent ops view stays in sync with the operator page rules");
void agentNetRevenue; void agentPaidToDate; void agentCancellationPolicy;

// ── 2. Auth allowlist rows ──────────────────────────────────────────────────
process.env.AGENT_LOGINS ||= "testagent:test-pass-123";
const { isAgentAllowedPath } = await import("../server/auth");
const req = (method: string, path: string) => ({ method, path }) as any;
assert.equal(isAgentAllowedPath(req("GET", "/api/agent/shared-bookings")), true);
assert.equal(isAgentAllowedPath(req("POST", "/api/buy-ins/42/vendor-email")), true);
assert.equal(isAgentAllowedPath(req("GET", "/api/bookings/res1/buy-in-communications")), true);
assert.equal(isAgentAllowedPath(req("GET", "/api/agent-shares")), false);
assert.equal(isAgentAllowedPath(req("POST", "/api/agent-shares")), false);
assert.equal(isAgentAllowedPath(req("GET", "/api/reports/buy-in-paid-rates")), false);
assert.equal(isAgentAllowedPath(req("GET", "/api/bookings/guesty-all")), false);
console.log("  ✓ allowlist: shared-bookings + vendor-email reachable; share toggle + money reports blocked");

// ── 3. Source guards — the wiring the projection depends on ─────────────────
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const routes = read("../server/routes.ts");
// buy-in-communications: agent sessions must pass the share gate and get the
// projected rows. Removing either line reopens the costPaid leak this feature
// closed (the route is agent-allowlisted).
assert.ok(routes.includes("This reservation is not shared with the agent portal"), "agent share gate missing from routes.ts");
assert.ok(routes.includes("isAgentSession ? responseBuyIns.map(agentSafeBuyIn) : responseBuyIns"), "buy-in-communications must project buy-ins for agents");
// vendor-email send: agents may only send for a shared reservation AND a
// buy-in that belongs to it.
assert.ok(routes.includes("reservationBuyIns.some((b) => b.id === buyInId)"), "vendor-email agent gate missing");
// shared-bookings summary is still a field-limited Guesty read, and since
// 2026-07-21 it MUST include `money` — the agent card's financial strip
// reads it. (This reverses the 2026-07-20 no-money lock by operator
// directive.)
const safeFieldsMatch = routes.match(/const safeFields = encodeURIComponent\(\s*"([^"]+)"/);
assert.ok(safeFieldsMatch, "shared-bookings safeFields missing");
assert.equal(/\bmoney\b/.test(safeFieldsMatch![1]), true, "shared-bookings Guesty fields must include money (2026-07-21 directive)");
assert.ok(routes.includes("agentBookingFinancials(reservationMoney, units)"), "shared-bookings must emit the financial roll-up");
assert.ok(routes.includes("agentOpsRowView(reservationRaw, units, Date.now())"), "shared-bookings must emit the ops-row view");
// pm-sms GET is agent-reachable but SHARE-GATED in the handler (the send
// route stays operator-only).
assert.ok(/pm-sms[\s\S]{0,1200}isAgentSmsSession[\s\S]{0,600}not shared with the agent portal/.test(routes), "pm-sms agent share gate missing");
assert.ok(/safeFields = encodeURIComponent\([\s\S]{0,400}payments cancellationPolicy/.test(routes), "shared-bookings fields must include payments + cancellation policy");
assert.ok(routes.includes('app.get("/api/agent/shared-bookings"'), "shared-bookings route missing");
assert.ok(routes.includes('app.post("/api/agent-shares"'), "agent-shares toggle route missing");
assert.ok(routes.includes(".map(agentSafeBuyIn)"), "routes must project via agentSafeBuyIn");

const schemaMaintenance = read("../server/schema-maintenance.ts");
assert.ok(schemaMaintenance.includes("CREATE TABLE IF NOT EXISTS reservation_agent_shares"), "boot CREATE TABLE missing");

const auth = read("../server/auth.ts");
assert.ok(auth.includes('path === "/api/agent/shared-bookings"'), "auth allowlist missing shared-bookings");
assert.ok(auth.includes("\\/vendor-email$"), "auth allowlist missing vendor-email");
assert.ok(auth.includes("\\/pm-sms$"), "auth allowlist missing agent pm-sms read");

const homePage = read("../client/src/pages/home.tsx");
assert.ok(homePage.includes("<AgentSharedBookings />"), "agent portal must render AgentSharedBookings");

const bookingsPage = read("../client/src/pages/bookings.tsx");
assert.ok(bookingsPage.includes("<AgentShareToggleButton reservationId={r._id} />"), "bookings page must render the share toggle");
assert.ok(bookingsPage.includes('"/api/agent-shares"'), "share toggle must call /api/agent-shares");

const agentPanel = read("../client/src/components/agent-shared-bookings.tsx");
assert.ok(agentPanel.includes("/vendor-email"), "agent panel must reply via vendor-email");
assert.ok(agentPanel.includes("buy-in-communications"), "agent panel must read the comms endpoint");
assert.ok(agentPanel.includes("BookingFinancialsStrip"), "agent panel must keep the financials fallback strip");
assert.ok(agentPanel.includes("agent-unit-paid-rate-"), "agent panel must render the per-unit cost/paid header line");
assert.ok(agentPanel.includes('data-testid="agent-ops-summary"'), "agent panel must render the ops-style summary row");
assert.ok(agentPanel.includes("Payment next due"), "agent panel must render the ops column labels");
assert.ok(agentPanel.includes('data-testid="agent-cancellation-policy"'), "agent panel must render the cancellation-policy card");
// Expanded-row parity (2026-07-21 follow-up): unit badges via the SAME shared
// helpers the operator's slot cards use, arrival-details block, collapsed
// Email history + SMS/Text History sections, alias chip.
assert.ok(agentPanel.includes("unitCommunityVerdictBadge") && agentPanel.includes("unitGuestHappyBadge") && agentPanel.includes("unitHostFrictionBadge"), "agent unit badges must use the shared badge helpers");
assert.ok(agentPanel.includes("agent-unit-arrival-"), "agent panel must render the arrival-details block");
assert.ok(agentPanel.includes("SMS/Text History") && agentPanel.includes("/pm-sms"), "agent panel must render the SMS history section");
assert.ok(agentPanel.includes("Email history —"), "agent panel must render the collapsed email-history section");
assert.ok(agentPanel.includes("agent-unit-alias-"), "agent panel must render the unit alias chip");
console.log("  ✓ source guards: share gate, projection, field-limited Guesty read, and UI wiring intact");

console.log("agent buy-in view suite passed");
