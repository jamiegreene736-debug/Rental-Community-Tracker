// Missing buy-in warning for imminent check-ins — pure-logic tests.
// Operator rules (2026-07-04, window widened to 15 days on 2026-07-07): red-flag
// any reservation checking in within the next 15 days whose required units have
// NOT all been bought in; include stays already in-house; never warn on
// cancelled bookings or reservations with no configured unit slots.
// 2026-07-09: "bought in" now REQUIRES email activity in the unit's alias inbox
// (slot.buyIn.hasInboundEmail === true), not merely an attached buy-in row.
import {
  buyInCoverageWarningSignature,
  buyInSlotAttached,
  buyInSlotCovered,
  buyInSlotHasEmailActivity,
  checkInWithinBuyInWarningWindow,
  collectBuyInCoverageWarnings,
  daysUntilCheckIn,
  missingBuyInUnits,
  reservationExcludedFromBuyInWarnings,
  BUYIN_COVERAGE_WINDOW_DAYS,
  type BuyInCoverageReservationLike,
} from "../shared/buyin-coverage-warning";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
};

const NOW = new Date("2026-07-04T18:00:00Z").getTime();
const dayAhead = (d: number) => new Date(NOW + d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// "attached" now means fully bought in: a live buy-in AND a booking email in
// the alias inbox. "attachedNoEmail" is attached-but-not-yet-purchased.
const attached = { status: "active", hasInboundEmail: true } as const;
const attachedNoEmail = { status: "active", hasInboundEmail: false } as const;
const slot = (
  unitId: string,
  buyIn: { status?: string | null; hasInboundEmail?: boolean | null } | null = null,
) => ({
  unitId,
  unitLabel: `Unit ${unitId}`,
  buyIn,
});

const reservation = (
  overrides: Partial<BuyInCoverageReservationLike> & { checkInDays?: number; checkOutDays?: number } = {},
): BuyInCoverageReservationLike => {
  const { checkInDays = 3, checkOutDays = 10, ...rest } = overrides;
  return {
    _id: "res1",
    status: "confirmed",
    checkInDateLocalized: dayAhead(checkInDays),
    checkOutDateLocalized: dayAhead(checkOutDays),
    confirmationCode: "ABC123",
    guest: { firstName: "Jamie", lastName: "Guest" },
    integration: { platform: "airbnb2" },
    listing: { nickname: "Poipu Kai 6BR" },
    operationsPropertyId: 4,
    operationsPropertyName: "Poipu Kai",
    slots: [slot("721"), slot("812")],
    ...rest,
  };
};

console.log("buyin-coverage-warning: window + urgency");
{
  check("check-in 3 days out is in window", checkInWithinBuyInWarningWindow(reservation(), NOW));
  check("check-in today (0 days) is in window", checkInWithinBuyInWarningWindow(reservation({ checkInDays: 0 }), NOW));
  check(
    "check-in exactly 15 days out is in window (inclusive)",
    checkInWithinBuyInWarningWindow(reservation({ checkInDays: 15, checkOutDays: 20 }), NOW),
  );
  check(
    "check-in 16 days out is OUT of window",
    !checkInWithinBuyInWarningWindow(reservation({ checkInDays: 16, checkOutDays: 21 }), NOW),
  );
  check(
    "in-house stay (checked in 2 days ago, out in 4) is in window",
    checkInWithinBuyInWarningWindow(reservation({ checkInDays: -2, checkOutDays: 4 }), NOW),
  );
  check(
    "past stay (checked out 3 days ago) is OUT of window",
    !checkInWithinBuyInWarningWindow(reservation({ checkInDays: -10, checkOutDays: -3 }), NOW),
  );
  check("no parseable check-in date is OUT of window", !checkInWithinBuyInWarningWindow(reservation({ checkInDateLocalized: null, checkIn: "soon" }), NOW));
  check("daysUntilCheckIn counts whole days", daysUntilCheckIn(reservation({ checkInDays: 5 }), NOW) === 5);
  check("daysUntilCheckIn negative when in-house", daysUntilCheckIn(reservation({ checkInDays: -2 }), NOW) === -2);
  check(
    "full ISO checkIn falls back when localized missing",
    daysUntilCheckIn({ checkIn: new Date(NOW + 2 * 86400000).toISOString() }, NOW) === 2,
  );
  check("window constant is 15 days", BUYIN_COVERAGE_WINDOW_DAYS === 15);
}

console.log("buyin-coverage-warning: slot coverage");
{
  check("attached buy-in WITH inbound email covers the slot", buyInSlotCovered(slot("721", attached)));
  check("attached buy-in with NO email does NOT cover", !buyInSlotCovered(slot("721", attachedNoEmail)));
  check("no buy-in = uncovered", !buyInSlotCovered(slot("721")));
  check("cancelled buy-in does NOT cover even with email", !buyInSlotCovered(slot("721", { status: "cancelled", hasInboundEmail: true })));
  check("buy-in with no status but an email counts as covered", buyInSlotCovered(slot("721", { hasInboundEmail: true })));
  check("attach helper: active buy-in is attached", buyInSlotAttached(slot("721", attachedNoEmail)));
  check("attach helper: cancelled buy-in is NOT attached", !buyInSlotAttached(slot("721", { status: "cancelled" })));
  check("email helper: hasInboundEmail true", buyInSlotHasEmailActivity(slot("721", attached)));
  check("email helper: hasInboundEmail false", !buyInSlotHasEmailActivity(slot("721", attachedNoEmail)));

  const missing = missingBuyInUnits(reservation({ slots: [slot("721", attached), slot("812")] }));
  check("missing units lists only uncovered slots", missing.length === 1 && missing[0].unitId === "812", missing);
  check("missing unit keeps its label", missing[0]?.unitLabel === "Unit 812");
  check("missing unit with no buy-in has reason not-attached", missing[0]?.reason === "not-attached");
  const missingNoEmail = missingBuyInUnits(reservation({ slots: [slot("721", attached), slot("812", attachedNoEmail)] }));
  check("attached-but-no-email unit is missing with reason no-email", missingNoEmail.length === 1 && missingNoEmail[0]?.reason === "no-email", missingNoEmail);
}

console.log("buyin-coverage-warning: collection rules");
{
  const warnings = collectBuyInCoverageWarnings([reservation()], NOW);
  check("uncovered reservation in window warns", warnings.length === 1, warnings);
  check("warning carries both missing units", warnings[0]?.missingUnits.length === 2);
  check("warning slots math", warnings[0]?.slotsTotal === 2 && warnings[0]?.slotsFilled === 0);
  check("warning carries guest name", warnings[0]?.guestName === "Jamie Guest");
  check("warning carries channel", warnings[0]?.channel === "airbnb2");
  check("warning carries check-in day", warnings[0]?.checkIn === dayAhead(3));

  check(
    "fully purchased reservation does NOT warn",
    collectBuyInCoverageWarnings([reservation({ slots: [slot("721", attached), slot("812", attached)] })], NOW).length === 0,
  );
  const partial = collectBuyInCoverageWarnings(
    [reservation({ slots: [slot("721", attached), slot("812")] })],
    NOW,
  );
  check("partially purchased reservation warns with the missing unit only", partial.length === 1 && partial[0].missingUnits.length === 1 && partial[0].missingUnits[0].unitId === "812");
  check("partial warning slotsFilled counts the purchased unit", partial[0]?.slotsFilled === 1);

  // Core 2026-07-09 behavior: units attached but never actually booked (no email
  // in the alias inbox) still red-flag — attachment alone is not proof of purchase.
  const attachedButUnpaid = collectBuyInCoverageWarnings(
    [reservation({ slots: [slot("721", attachedNoEmail), slot("812", attachedNoEmail)] })],
    NOW,
  );
  check(
    "reservation with both units attached but NO email still warns",
    attachedButUnpaid.length === 1 && attachedButUnpaid[0].missingUnits.length === 2,
    attachedButUnpaid,
  );
  check(
    "attached-no-email warning slotsFilled is 0 (nothing bought in)",
    attachedButUnpaid[0]?.slotsFilled === 0,
  );
  check(
    "attached-no-email missing units carry reason no-email",
    attachedButUnpaid[0]?.missingUnits.every((u) => u.reason === "no-email"),
  );

  check(
    "cancelled reservation never warns",
    collectBuyInCoverageWarnings([reservation({ status: "canceled" })], NOW).length === 0,
  );
  check(
    "inquiry never warns",
    collectBuyInCoverageWarnings([reservation({ status: "inquiry" })], NOW).length === 0,
  );
  check("exclusion helper matches cancelled", reservationExcludedFromBuyInWarnings({ status: "cancelled" }));
  check("exclusion helper passes confirmed", !reservationExcludedFromBuyInWarnings({ status: "confirmed" }));
  check(
    "manual reservation (status manual, manual:id) warns",
    collectBuyInCoverageWarnings([reservation({ _id: "manual:5", status: "manual", integration: { platform: "Manual" } })], NOW).length === 1,
  );
  check(
    "no configured slots → no warning (requirements unknown)",
    collectBuyInCoverageWarnings([reservation({ slots: [] })], NOW).length === 0,
  );
  check(
    "check-in beyond window → no warning",
    collectBuyInCoverageWarnings([reservation({ checkInDays: 30 })], NOW).length === 0,
  );
  check(
    "duplicate reservation ids collapse to one warning",
    collectBuyInCoverageWarnings([reservation(), reservation()], NOW).length === 1,
  );
  check(
    "reservation with no id is dropped",
    collectBuyInCoverageWarnings([reservation({ _id: null })], NOW).length === 0,
  );
  const sorted = collectBuyInCoverageWarnings(
    [reservation({ _id: "later", checkInDays: 6 }), reservation({ _id: "sooner", checkInDays: 1 })],
    NOW,
  );
  check("most imminent arrival sorts first", sorted[0]?.reservationId === "sooner" && sorted[1]?.reservationId === "later", sorted.map((w) => w.reservationId));
}

console.log("buyin-coverage-warning: dismissal signature");
{
  const a = collectBuyInCoverageWarnings([reservation()], NOW);
  const b = collectBuyInCoverageWarnings([reservation()], NOW);
  check("same facts → same signature", buyInCoverageWarningSignature(a) === buyInCoverageWarningSignature(b));
  check("empty warnings → empty signature", buyInCoverageWarningSignature([]) === "");
  const oneBought = collectBuyInCoverageWarnings(
    [reservation({ slots: [slot("721", attached), slot("812")] })],
    NOW,
  );
  check(
    "buying a unit changes the signature",
    buyInCoverageWarningSignature(a) !== buyInCoverageWarningSignature(oneBought),
  );
  const dateMoved = collectBuyInCoverageWarnings([reservation({ checkInDays: 5 })], NOW);
  check(
    "check-in date change changes the signature",
    buyInCoverageWarningSignature(a) !== buyInCoverageWarningSignature(dateMoved),
  );
  // Attaching a unit without booking it (not-attached → no-email) is a fact
  // change that must re-raise a dismissed popup.
  const attachedNoEmailWarn = collectBuyInCoverageWarnings(
    [reservation({ slots: [slot("721", attachedNoEmail), slot("812")] })],
    NOW,
  );
  const bothUnattached = collectBuyInCoverageWarnings(
    [reservation({ slots: [slot("721"), slot("812")] })],
    NOW,
  );
  check(
    "reason change (attach without email) changes the signature",
    buyInCoverageWarningSignature(attachedNoEmailWarn) !== buyInCoverageWarningSignature(bothUnattached),
  );
  const two = collectBuyInCoverageWarnings(
    [reservation({ _id: "r1" }), reservation({ _id: "r2", checkInDays: 5 })],
    NOW,
  );
  const twoReversed = collectBuyInCoverageWarnings(
    [reservation({ _id: "r2", checkInDays: 5 }), reservation({ _id: "r1" })],
    NOW,
  );
  check(
    "signature is order-independent",
    buyInCoverageWarningSignature(two) === buyInCoverageWarningSignature(twoReversed),
  );
}

console.log(`\nbuyin-coverage-warning tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
