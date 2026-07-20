// Per-unit alias-thread scoping (operator report 2026-07-20: "the email
// history is the same for both of the aliases" + "separate out the text
// history per unit as 'SMS/Text History'"). Locks the pure alias resolution,
// the guest-inbox route wiring, the pm-sms reservation scoping, and the UI
// section renames.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { guestThreadAliasesForBuyIn } = await import("../shared/unified-buyin-alias");

console.log("alias thread scope suite");

// ── guestThreadAliasesForBuyIn ──────────────────────────────────────────────
const A = { id: 539, travelerEmail: "jacelyn.tsu@x.com" };
const B = { id: 540, travelerEmail: "jacelyn.tsu.410862@x.com" };
const rows = [
  { buyInId: 539, aliasEmail: "jacelyn.tsu.ae9958.a@x.com" },
  { buyInId: 540, aliasEmail: "jacelyn.tsu.410862@x.com" },
];

// The live Menehune shape: unit A has a legacy base travelerEmail AND its own
// scoped alias — BOTH mailboxes belong to unit A (VRBO sends to the base, the
// PM replies land at the scoped alias). Scoped alias FIRST (primary).
assert.deepEqual(
  guestThreadAliasesForBuyIn({ buyInId: 539, travelerEmail: A.travelerEmail, siblings: [A, B], aliasRows: rows }),
  ["jacelyn.tsu.ae9958.a@x.com", "jacelyn.tsu@x.com"],
);
// Unit B: scoped alias == travelerEmail — one mailbox, no duplicate.
assert.deepEqual(
  guestThreadAliasesForBuyIn({ buyInId: 540, travelerEmail: B.travelerEmail, siblings: [A, B], aliasRows: rows }),
  ["jacelyn.tsu.410862@x.com"],
);
console.log("  ✓ scoped alias + distinct travelerEmail both count; scoped is primary");

// THE BLEED FIX: two units sharing one legacy travelerEmail. The unit that
// has its own scoped alias must NOT read the shared mailbox — that is what
// made both panels render the same history.
const S1 = { id: 1, travelerEmail: "shared@x.com" };
const S2 = { id: 2, travelerEmail: "shared@x.com" };
assert.deepEqual(
  guestThreadAliasesForBuyIn({
    buyInId: 2,
    travelerEmail: "shared@x.com",
    siblings: [S1, S2],
    aliasRows: [{ buyInId: 2, aliasEmail: "unit2.scoped@x.com" }],
  }),
  ["unit2.scoped@x.com"],
);
// …but with NO scoped alias the shared address is the only mailbox we have —
// keep it (legacy behavior beats an empty thread).
assert.deepEqual(
  guestThreadAliasesForBuyIn({ buyInId: 1, travelerEmail: "shared@x.com", siblings: [S1, S2], aliasRows: [{ buyInId: 2, aliasEmail: "unit2.scoped@x.com" }] }),
  ["shared@x.com"],
);
console.log("  ✓ a sibling-shared travelerEmail is excluded once the unit has its own scoped alias");

// Reservation-LEVEL alias rows (buyInId null): attributable only when the
// reservation has exactly one attached unit.
assert.deepEqual(
  guestThreadAliasesForBuyIn({
    buyInId: 7,
    travelerEmail: null,
    siblings: [{ id: 7 }],
    aliasRows: [{ buyInId: null, aliasEmail: "res.level@x.com" }],
  }),
  ["res.level@x.com"],
);
assert.deepEqual(
  guestThreadAliasesForBuyIn({
    buyInId: 7,
    travelerEmail: null,
    siblings: [{ id: 7 }, { id: 8 }],
    aliasRows: [{ buyInId: null, aliasEmail: "res.level@x.com" }],
  }),
  [],
);
console.log("  ✓ reservation-level alias counts only for a single-unit reservation");

// ── Source guards ───────────────────────────────────────────────────────────
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const routes = read("../server/routes.ts");
// /api/guest-inbox?buyInId= must resolve the unit's FULL alias set via the
// helper — a bare travelerEmail read reintroduces both halves of the bug
// (missed scoped mailbox + shared-address bleed).
assert.ok(routes.includes("guestThreadAliasesForBuyIn({"), "guest-inbox route must use guestThreadAliasesForBuyIn");
assert.ok(routes.includes("aliasEmails.map((candidate) => storage.getGuestInboxMessages(candidate, limit))"), "guest-inbox must union every unit alias mailbox");
// pm-sms: phone-matched texts scoped to this buy-in's reservation (inbound
// rows without a reservationId stay).
assert.ok(routes.includes("mRid === rid"), "pm-sms must scope messages to the buy-in's reservation");

const bookingsPage = read("../client/src/pages/bookings.tsx");
assert.ok(bookingsPage.includes("SMS/Text History"), "text section must be renamed SMS/Text History");
assert.equal(bookingsPage.includes("Text messages with PM{"), false, "old text-section label must be gone");
assert.ok(/Email history\{unitDisplayLabel/.test(bookingsPage), "email history summary must carry the unit label");
assert.ok(bookingsPage.includes("Only this unit's emails"), "email history must show its per-unit alias scoping note");
console.log("  ✓ source guards: route alias resolution, pm-sms scoping, and per-unit history labels intact");

console.log("alias thread scope suite passed");
