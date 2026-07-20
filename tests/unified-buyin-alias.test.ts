// Unified per-unit buy-in alias (2026-07-19).
//
// Operator report: both attached units on one reservation showed the SAME
// booking email, and every unit rendered TWO alias blocks ("Unit email alias" +
// "VRBO guest thread"). Root cause: two independent SimpleLogin alias systems —
// the unit-scoped reservation_aliases engine (correctly per-unit) and the
// per-guest firstname.lastname travelerEmail scheme, whose "already exists"
// catch silently stored one shared address on two buy-ins.
//
// The fix: ONE alias per attached buy-in. ensureTravelerEmailForBuyIn now mints
// or reuses the (reservationId, buyInId) reservation alias; the alias engine
// backfills buy_ins.travelerEmail; the bookings page renders one merged panel.
// This suite locks the pure merge/heal logic + the wiring seams.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bookingMessageDuplicatesPmEmail,
  mergeAliasThread,
  normalizeProviderMessageId,
  travelerEmailNeedsRemint,
} from "../shared/unified-buyin-alias";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");

let passed = 0;
function ok(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  passed += 1;
}

// ── normalizeProviderMessageId ───────────────────────────────────────────────
ok(normalizeProviderMessageId("<ABC@Mail.Vrbo.Com>") === "abc@mail.vrbo.com", "message-id strips angle brackets + lowercases");
ok(normalizeProviderMessageId("  abc@x.com  ") === "abc@x.com", "message-id trims whitespace");
ok(normalizeProviderMessageId(null) === "", "null message-id normalizes to empty");

// ── bookingMessageDuplicatesPmEmail ──────────────────────────────────────────
const pmInbound = {
  id: 1,
  direction: "inbound",
  fromEmail: "pm@vtrips.com",
  toEmail: "jacelyn.tsu.ae9958.a@emailprivaccy.com",
  subject: "Arrival details for Unit 106",
  providerMessageId: "<m1@vtrips.com>",
  sentAt: "2026-07-19T20:00:00.000Z",
};
ok(
  bookingMessageDuplicatesPmEmail(
    { id: 9, direction: "inbound", fromEmail: "other@x.com", subject: "different", providerMessageId: "m1@vtrips.com", receivedAt: "2026-07-19T23:59:00.000Z" },
    pmInbound,
  ),
  "identical Message-ID (bracket/case-insensitive) is a duplicate regardless of subject",
);
ok(
  !bookingMessageDuplicatesPmEmail(
    { id: 9, direction: "inbound", fromEmail: "pm@vtrips.com", subject: "Arrival details for Unit 106", providerMessageId: "<m2@vtrips.com>", receivedAt: "2026-07-19T20:00:30.000Z" },
    pmInbound,
  ),
  "distinct Message-IDs are never folded, even with matching subject+sender+time",
);
ok(
  bookingMessageDuplicatesPmEmail(
    { id: 9, direction: "inbound", fromEmail: "PM@vtrips.com", subject: "Re: arrival details for unit 106", receivedAt: "2026-07-19T20:04:00.000Z" },
    pmInbound,
  ),
  "no Message-ID on one side: same sender + Re:-normalized subject + close timestamps folds",
);
ok(
  !bookingMessageDuplicatesPmEmail(
    { id: 9, direction: "inbound", fromEmail: "pm@vtrips.com", subject: "Arrival details for Unit 106", receivedAt: "2026-07-19T22:00:00.000Z" },
    pmInbound,
  ),
  "same subject+sender but 2h apart is NOT a duplicate (a genuine follow-up)",
);
ok(
  !bookingMessageDuplicatesPmEmail(
    { id: 9, direction: "outbound", fromEmail: "pm@vtrips.com", subject: "Arrival details for Unit 106", receivedAt: "2026-07-19T20:00:00.000Z" },
    pmInbound,
  ),
  "direction mismatch never folds (outbound PM email vs inbound host reply)",
);

// ── mergeAliasThread ─────────────────────────────────────────────────────────
{
  const emails = [
    pmInbound,
    { id: 2, direction: "outbound", fromEmail: "reservations@magicalislandvacations.com", toEmail: "reverse@simplelogin.co", subject: "Arrival details request", providerMessageId: null, sentAt: "2026-07-18T10:00:00.000Z" },
  ];
  const messages = [
    // duplicate of pmInbound through the other ingester
    { id: 11, direction: "inbound", fromEmail: "pm@vtrips.com", subject: "Arrival details for Unit 106", providerMessageId: "m1@vtrips.com", receivedAt: "2026-07-19T20:00:05.000Z" },
    // VRBO confirmation only in the booking thread
    { id: 12, direction: "inbound", fromEmail: "no-reply@vrbo.com", subject: "Your booking is confirmed", providerMessageId: "<v1@vrbo.com>", receivedAt: "2026-07-19T21:00:00.000Z" },
  ];
  const merged = mergeAliasThread(emails, messages);
  ok(merged.length === 3, "merge keeps both PM rows + the unique booking message, drops the cross-ingester duplicate");
  ok(merged[0].source === "booking" && (merged[0] as any).message.id === 12, "merged thread sorts newest-first");
  ok(merged.filter((r) => r.source === "pm").length === 2, "every PM row survives the merge (they carry attachments + reply path)");
  ok(mergeAliasThread([], []).length === 0, "empty inputs merge to an empty thread");
}

// ── travelerEmailNeedsRemint (the legacy shared-address heal) ────────────────
const shared = "jacelyn.tsu@emailprivaccy.com";
ok(
  travelerEmailNeedsRemint({
    buyInId: 2,
    travelerEmail: shared,
    bookingStatus: "idle",
    siblings: [{ id: 1, travelerEmail: shared }, { id: 2, travelerEmail: shared }],
  }),
  "unbooked unit sharing its travelerEmail with a sibling gets re-minted",
);
ok(
  !travelerEmailNeedsRemint({
    buyInId: 2,
    travelerEmail: shared,
    bookingStatus: "booked",
    siblings: [{ id: 1, travelerEmail: shared }, { id: 2, travelerEmail: shared }],
  }),
  "a BOOKED unit never loses its address — VRBO already has it on the live booking",
);
ok(
  !travelerEmailNeedsRemint({
    buyInId: 2,
    travelerEmail: "own.alias.b@emailprivaccy.com",
    bookingStatus: "idle",
    siblings: [{ id: 1, travelerEmail: shared }, { id: 2, travelerEmail: "own.alias.b@emailprivaccy.com" }],
  }),
  "a distinct travelerEmail is kept",
);
ok(
  !travelerEmailNeedsRemint({ buyInId: 2, travelerEmail: "", bookingStatus: "idle", siblings: [{ id: 1, travelerEmail: shared }] }),
  "no travelerEmail yet = the normal mint path, not a heal",
);
ok(
  travelerEmailNeedsRemint({
    buyInId: 2,
    travelerEmail: ` ${shared.toUpperCase()} `,
    bookingStatus: null,
    siblings: [{ id: 1, travelerEmail: shared }],
  }),
  "shared-address comparison is case/whitespace-insensitive",
);

// ── Source guards: the wiring seams ──────────────────────────────────────────
const checkoutJob = read("server/buy-in-checkout-job.ts");
ok(
  checkoutJob.includes("getOrCreateReservationAlias({") &&
    checkoutJob.includes("travelerEmailNeedsRemint({"),
  "ensureTravelerEmailForBuyIn must mint the unit-scoped reservation alias and run the shared-duplicate heal",
);
ok(
  !checkoutJob.includes("unitEmailIndexForBuyIn") && !checkoutJob.includes("guestEmailLocalPart"),
  "the legacy per-guest firstname.lastname traveler-email scheme must stay deleted (its collision path stored one address on two units)",
);

const reservationAlias = read("server/reservation-alias.ts");
ok(
  reservationAlias.includes("backfillBuyInTravelerEmail") &&
    reservationAlias.includes('if (String(buyIn.travelerEmail ?? "").trim()) return;'),
  "minting/looking up a unit alias stamps it as the buy-in's travelerEmail, but NEVER clobbers an existing one",
);
ok(
  reservationAlias.includes("aliasPrefixCandidates") && reservationAlias.includes("isSimpleLoginAliasExistsError"),
  "the extracted alias engine keeps the per-unit prefix walk (unit token → .b<id> → entropy)",
);

const routes = read("server/routes.ts");
ok(
  routes.includes('} from "./reservation-alias"') &&
    !/\n  async function getOrCreateReservationAlias\(/.test(routes),
  "routes.ts must import the alias engine from server/reservation-alias.ts, not re-inline it",
);

const bookings = read("client/src/pages/bookings.tsx");
ok(
  !bookings.includes("<BuyInGuestThreadPanel"),
  "the separate 'VRBO guest thread' block must stay merged into the unit-alias panel (one email block per unit)",
);
ok(
  bookings.includes("mergeAliasThread(emails, bookingMessages)"),
  "the unit panel must render ONE deduped history (PM emails + booking thread)",
);
ok(
  bookings.includes("booking email (legacy):"),
  "a legacy travelerEmail that differs from the unit alias must stay visible (VRBO still mails it)",
);

console.log(`unified-buyin-alias: ${passed}/${passed} assertions passed`);
