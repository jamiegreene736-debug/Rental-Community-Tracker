// Network-free unit tests for the arrival-details promise watchdog:
//   - looksLikeArrivalDetailsMessage (shared/arrival-details-message.ts) — the
//     shared "is this ACTUAL arrival details?" matcher used by BOTH the inbox
//     guest-stay timeline and GET /api/dashboard/arrival-details-coverage.
//   - shared/arrival-details-warning.ts — candidate selection, thread-scan
//     verdict fold, and the dismissal signature.
import {
  buildArrivalDetailsGuestMessage,
  looksLikeArrivalDetailsMessage,
} from "../shared/arrival-details-message";
import {
  arrivalDetailsCandidates,
  resolveArrivalDetailsWarning,
  arrivalDetailsWarningSignature,
  ARRIVAL_DETAILS_WINDOW_DAYS,
} from "../shared/arrival-details-warning";
import { buildBookingConfirmationMessage } from "../shared/booking-confirmation-message";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("looksLikeArrivalDetailsMessage: real arrival-details bodies match");
const builderAd = buildArrivalDetailsGuestMessage({
  guestFirstName: "Michelle",
  propertyName: "Mauna Kai 6BR",
  checkInIso: "2026-07-20",
  units: [
    { unitLabel: "Mauna Kai 7B", unitAddress: "3920 Wyllie Rd", accessCode: "4471", wifiName: "MK7B", parkingInfo: "Stall 7B" },
    { unitLabel: "Mauna Kai 8", accessCode: "9982" },
  ],
});
check("builder multi-unit AD matches", looksLikeArrivalDetailsMessage(builderAd), builderAd);
const builderSingle = buildArrivalDetailsGuestMessage({
  guestFirstName: "Sam",
  propertyName: "Kaha Lani 3BR",
  units: [{ unitLabel: "Kaha Lani 121", unitAddress: "4460 Nehe Rd", arrivalNotes: "Elevator to floor 2" }],
});
check("builder single-unit AD (no code, Unit: line) matches", looksLikeArrivalDetailsMessage(builderSingle), builderSingle);
check("hand-written 'Access code:' line matches", looksLikeArrivalDetailsMessage("Aloha!\nAccess code: 1234\nSee you soon"));
check("hand-written 'Door code:' line matches", looksLikeArrivalDetailsMessage("Door code: 9871"));
check("hand-written 'Lockbox code:' line matches", looksLikeArrivalDetailsMessage("Lockbox code: 55A"));
check("'Unit 2:' block header matches", looksLikeArrivalDetailsMessage("Unit 2: Poipu Sands 316"));

console.log("looksLikeArrivalDetailsMessage: promises and near-misses do NOT match");
const automatedConfirmation = buildBookingConfirmationMessage({
  guestFirstName: "Michelle",
  propertyName: "Gorgeous Princeville 6 bedroom condos for 16!",
  resortName: "Mauna Kai",
  unitCount: 2,
  totalBedrooms: 6,
  walkMinutes: 3,
  isHawaii: true,
  checkInIso: "2026-07-20",
  checkOutIso: "2026-07-27",
  nights: 7,
  confirmationCode: "HMABC123",
});
check(
  "the automated booking confirmation (the old regex's false positive) does NOT match",
  !looksLikeArrivalDetailsMessage(automatedConfirmation),
  automatedConfirmation,
);
check(
  "representative follow-up promise does NOT match",
  !looksLikeArrivalDetailsMessage("Your arrival details will arrive about 14 days before check-in."),
);
check(
  "agreement-request promise does NOT match",
  !looksLikeArrivalDetailsMessage("Once that is done, we will send your final arrival/access details 14 days before check-in."),
);
const stillConfirming = buildArrivalDetailsGuestMessage({ guestFirstName: "Sam", propertyName: "Kaha Lani", units: [] });
check("zero-unit 'still confirming' AD variant does NOT match", !looksLikeArrivalDetailsMessage(stillConfirming), stillConfirming);
check("casual 'Parking:' line alone does NOT match", !looksLikeArrivalDetailsMessage("Parking: level 2 is fine for the truck"));
check("casual 'Wi-Fi:' line alone does NOT match", !looksLikeArrivalDetailsMessage("Wi-Fi: BeachCondo / mahalo123"));
check("casual 'Address:' line alone does NOT match", !looksLikeArrivalDetailsMessage("Address: 4460 Nehe Rd"));
check("mid-sentence 'the access code: 1234' (guest-quote shape) does NOT match", !looksLikeArrivalDetailsMessage("the access code: 1234 didn't work last night"));
check("prose promise of codes does NOT match", !looksLikeArrivalDetailsMessage("we'll send your door and lockbox codes, parking, WiFi"));
check("empty/null-safe", !looksLikeArrivalDetailsMessage("") && !looksLikeArrivalDetailsMessage(null) && !looksLikeArrivalDetailsMessage(undefined));

// Fixed clock: today = 2026-07-10 (UTC).
const NOW_MS = Date.UTC(2026, 6, 10, 12, 0, 0);
const res = (over: Record<string, unknown>) => ({
  _id: "r1",
  status: "confirmed",
  checkIn: "2026-07-20T15:00:00-10:00",
  checkInDateLocalized: "2026-07-20",
  guest: { fullName: "Michelle Ordonez" },
  integration: { platform: "vrbo" },
  listing: { nickname: "Mauna Kai 6BR" },
  confirmationCode: "HMABC123",
  slots: [
    { unitId: "u1", buyIn: { status: "booked" } },
    { unitId: "u2", buyIn: null },
  ],
  ...over,
});

console.log("arrivalDetailsCandidates: window + exclusions");
check("window constant is 14", ARRIVAL_DETAILS_WINDOW_DAYS === 14);
const inWindow = arrivalDetailsCandidates([res({})], NOW_MS);
check("check-in 10 days out is a candidate", inWindow.length === 1 && inWindow[0].daysUntilCheckIn === 10, inWindow);
check("candidate carries units attached/required (1/2)", inWindow[0]?.unitsAttached === 1 && inWindow[0]?.unitsRequired === 2, inWindow);
check("candidate prefers checkInDateLocalized", inWindow[0]?.checkIn === "2026-07-20", inWindow);
const today = arrivalDetailsCandidates([res({ checkInDateLocalized: "2026-07-10" })], NOW_MS);
check("checks in TODAY (0 days) is a candidate", today.length === 1 && today[0].daysUntilCheckIn === 0, today);
const edge = arrivalDetailsCandidates([res({ checkInDateLocalized: "2026-07-24" })], NOW_MS);
check("day 14 is included (inclusive window)", edge.length === 1 && edge[0].daysUntilCheckIn === 14, edge);
check("day 15 is excluded", arrivalDetailsCandidates([res({ checkInDateLocalized: "2026-07-25" })], NOW_MS).length === 0);
check("in-house (yesterday) is excluded", arrivalDetailsCandidates([res({ checkInDateLocalized: "2026-07-09" })], NOW_MS).length === 0);
check("manual rows are excluded", arrivalDetailsCandidates([res({ _id: "manual:42" })], NOW_MS).length === 0);
check("cancelled status is excluded", arrivalDetailsCandidates([res({ status: "canceled" })], NOW_MS).length === 0);
check("inquiry status is excluded", arrivalDetailsCandidates([res({ status: "inquiry" })], NOW_MS).length === 0);
check("missing check-in date is excluded", arrivalDetailsCandidates([res({ checkIn: null, checkInDateLocalized: null })], NOW_MS).length === 0);
const dupes = arrivalDetailsCandidates([res({}), res({})], NOW_MS);
check("duplicate reservation ids collapse to one", dupes.length === 1, dupes);
const sorted = arrivalDetailsCandidates(
  [res({ _id: "far", checkInDateLocalized: "2026-07-22" }), res({ _id: "soon", checkInDateLocalized: "2026-07-11" })],
  NOW_MS,
);
check("sorted most-imminent first", sorted[0]?.reservationId === "soon" && sorted[1]?.reservationId === "far", sorted);
const cancelledBuyIn = arrivalDetailsCandidates(
  [res({ slots: [{ unitId: "u1", buyIn: { status: "cancelled" } }] })],
  NOW_MS,
);
check("cancelled buy-in does not count as attached", cancelledBuyIn[0]?.unitsAttached === 0, cancelledBuyIn);

console.log("resolveArrivalDetailsWarning: thread-scan verdicts");
const candidate = inWindow[0];
const sentVerdict = resolveArrivalDetailsWarning(candidate, ["Aloha!", builderAd]);
check("host thread containing a real AD → adSent", sentVerdict.adSent === true && !sentVerdict.scanUnavailable, sentVerdict);
const promiseOnly = resolveArrivalDetailsWarning(candidate, [automatedConfirmation]);
check("host thread with only the confirmation promise → NOT sent", promiseOnly.adSent === false && !promiseOnly.scanUnavailable, promiseOnly);
const unavailable = resolveArrivalDetailsWarning(candidate, null);
check("unscannable thread → adSent false + scanUnavailable flag", unavailable.adSent === false && unavailable.scanUnavailable === true, unavailable);

console.log("arrivalDetailsWarningSignature: dismissal facts");
const a = { reservationId: "r1", checkIn: "2026-07-20", unitsRequired: 2, unitsAttached: 1 };
const b = { reservationId: "r2", checkIn: "2026-07-12", unitsRequired: 2, unitsAttached: 2 };
check("order-independent", arrivalDetailsWarningSignature([a, b]) === arrivalDetailsWarningSignature([b, a]));
check("empty → empty string", arrivalDetailsWarningSignature([]) === "");
check(
  "unit attachment change re-raises (signature differs)",
  arrivalDetailsWarningSignature([a]) !== arrivalDetailsWarningSignature([{ ...a, unitsAttached: 2 }]),
);
check(
  "check-in move re-raises (signature differs)",
  arrivalDetailsWarningSignature([a]) !== arrivalDetailsWarningSignature([{ ...a, checkIn: "2026-07-21" }]),
);

console.log(`\narrival-details-warning: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
