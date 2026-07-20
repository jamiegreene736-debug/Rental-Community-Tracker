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
    "arrivalNotes",
    "bookingStatus",
    "checkIn",
    "checkOut",
    "guestyReservationId",
    "id",
    "listingUrl",
    "managementCompany",
    "managementContact",
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
for (const blocked of AGENT_BLOCKED_BUYIN_FIELDS) {
  assert.equal(blocked in (safe as unknown as Record<string, unknown>), false, `blocked field leaked: ${blocked}`);
}
// The serialized payload carries none of the money strings.
const serialized = JSON.stringify(safe);
for (const moneyMarker of ["1405", "1522", "1,405", "1,522", "1,690"]) {
  assert.equal(serialized.includes(moneyMarker), false, `money value leaked: ${moneyMarker}`);
}
assert.equal(safe.unitLabel, "Unit 106");
assert.equal(safe.managementCompany, "Alii Resorts");
assert.equal(safe.accessCode, "6509"); // arrival info IS the point of the view
assert.equal(safe.listingUrl, "https://www.vrbo.com/1234567");
console.log("  ✓ agentSafeBuyIn is an exact whitelist — costPaid/paidRate/notes never leak");

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
// shared-bookings summary must stay a field-limited Guesty read — no `money`.
const safeFieldsMatch = routes.match(/const safeFields = encodeURIComponent\(\s*"([^"]+)"/);
assert.ok(safeFieldsMatch, "shared-bookings safeFields missing");
assert.equal(/\bmoney\b/.test(safeFieldsMatch![1]), false, "shared-bookings Guesty fields must not include money");
assert.ok(routes.includes('app.get("/api/agent/shared-bookings"'), "shared-bookings route missing");
assert.ok(routes.includes('app.post("/api/agent-shares"'), "agent-shares toggle route missing");
assert.ok(routes.includes(".map(agentSafeBuyIn)"), "routes must project via agentSafeBuyIn");

const schemaMaintenance = read("../server/schema-maintenance.ts");
assert.ok(schemaMaintenance.includes("CREATE TABLE IF NOT EXISTS reservation_agent_shares"), "boot CREATE TABLE missing");

const auth = read("../server/auth.ts");
assert.ok(auth.includes('path === "/api/agent/shared-bookings"'), "auth allowlist missing shared-bookings");
assert.ok(auth.includes("\\/vendor-email$"), "auth allowlist missing vendor-email");

const homePage = read("../client/src/pages/home.tsx");
assert.ok(homePage.includes("<AgentSharedBookings />"), "agent portal must render AgentSharedBookings");

const bookingsPage = read("../client/src/pages/bookings.tsx");
assert.ok(bookingsPage.includes("<AgentShareToggleButton reservationId={r._id} />"), "bookings page must render the share toggle");
assert.ok(bookingsPage.includes('"/api/agent-shares"'), "share toggle must call /api/agent-shares");

const agentPanel = read("../client/src/components/agent-shared-bookings.tsx");
assert.ok(agentPanel.includes("/vendor-email"), "agent panel must reply via vendor-email");
assert.ok(agentPanel.includes("buy-in-communications"), "agent panel must read the comms endpoint");
console.log("  ✓ source guards: share gate, projection, field-limited Guesty read, and UI wiring intact");

console.log("agent buy-in view suite passed");
