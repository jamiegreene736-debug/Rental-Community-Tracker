// Network-free unit tests for the Cowork buy-in prompt builder. Guards: the
// prompt embeds the reservation facts, names the same-community-first → city-wide
// fallback rule, explicitly forbids expanding beyond city-wide, and spells out
// the manual-attach API (create buy-in + attach-buy-in) per unit slot.
import {
  buildCoworkBuyInPrompt,
  buildCoworkBulkBuyInPrompt,
  buildCoworkCheckoutPrompt,
  buildCoworkCommunityVerifyPrompt,
  buildCoworkGuestHappyPrompt,
  buildCoworkVrboLookupPrompt,
  resolveCoworkSearchTargets,
  COWORK_BULK_FIND_MAX,
  DEFAULT_CARD_FILE_HINT,
  type CoworkBuyInPromptInput,
  type CoworkCheckoutPromptInput,
} from "../shared/cowork-buyin-prompt";
import { DEFAULT_PROFIT_MIN_FLAT_USD } from "../shared/buy-in-profit";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("cowork-buyin-prompt: prompt builder");

const baseInput: CoworkBuyInPromptInput = {
  reservationId: "abc123",
  guestName: "Jane Traveler",
  propertyId: 8,
  propertyName: "Poipu Kai 6BR Combo",
  community: "Poipu Kai",
  checkIn: "2026-07-20",
  checkOut: "2026-07-27",
  units: [
    { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
    { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
  ],
  baseUrl: "https://app.example.com/",
};

// ── resolveCoworkSearchTargets ───────────────────────────────────────────────
const targets = resolveCoworkSearchTargets("Poipu Kai");
check("resolves resort search name", targets.resortSearchName === "Poipu Kai", targets);
check("resolves city", targets.city === "Koloa", targets);
check("resolves city-wide search", targets.cityWideSearch === "Koloa, Hawaii", targets);

const unknown = resolveCoworkSearchTargets("Nowhere Unmapped Place");
check("unknown community falls back to itself", unknown.resortSearchName === "Nowhere Unmapped Place", unknown);
check("unknown community has null city", unknown.city === null, unknown);

// ── buildCoworkBuyInPrompt ───────────────────────────────────────────────────
const prompt = buildCoworkBuyInPrompt(baseInput);

check("includes reservation id", prompt.includes("abc123"));
check("includes guest name", prompt.includes("Jane Traveler"));
check("includes property id", prompt.includes("propertyId 8"));
check("computes nights (7)", prompt.includes("Nights: 7"), prompt.match(/Nights:.*/)?.[0]);
check("includes bedroom plan", prompt.includes("3BR + 3BR"));
check("lists both unit slots", prompt.includes('unitId "A"') && prompt.includes('unitId "B"'));

// Same-community-first → city-wide fallback → stop.
check("names community-first search", prompt.includes("Same community first"));
check("names city-wide fallback", prompt.includes("city-wide search of Koloa, Hawaii"));
check("forbids beyond city-wide", /STOP at city-wide/i.test(prompt) && /Do \*\*NOT\*\* expand beyond the city/.test(prompt));
check("no nearby-city expansion", prompt.includes("no nearby towns"));

// Pair proximity + price sanity (operator 2026-07-05, Waikiki incident:
// $1,975 vs $4,074 picks that were supposed to share a building).
check(
  "find prompt: multi-slot picks must share a complex, ideally the building",
  /PAIR RULE/.test(prompt) && /SAME complex — ideally the SAME BUILDING/.test(prompt) &&
    /NOT an acceptable pair/.test(prompt),
);
check(
  "find prompt: >50% price gap must be re-verified + reported",
  /PRICE SANITY/.test(prompt) && /more than ~50%/.test(prompt),
);
check(
  "find prompt: create body carries the unit's street address",
  prompt.includes('"unitAddress"') && /exact street address/.test(prompt),
);
check(
  "find prompt: force-override is same-complex only",
  /same complex\/community per your research/.test(prompt) && /never to push through units in different parts of the city/.test(prompt),
);
// Single-unit prompt: no pair rule (there's no pair).
const singleForPair = buildCoworkBuyInPrompt({ ...baseInput, units: [baseInput.units[0]] });
check("single-unit find prompt has no PAIR RULE", !/PAIR RULE/.test(singleForPair));

// Channel preference (operator 2026-07-05): VRBO first, 20% escape hatch.
check(
  "find prompt: VRBO-first channel preference",
  /CHANNEL PREFERENCE — VRBO FIRST/.test(prompt) && /Pick the \*\*VRBO\*\* listing UNLESS/.test(prompt),
);
check(
  "find prompt: non-VRBO must be MORE than 20% cheaper (below 80% of VRBO total)",
  /more than 20% cheaper/i.test(prompt) && /BELOW 80% of the VRBO\s+total/.test(prompt),
);
check(
  "find prompt: worked example locks the math direction",
  prompt.includes("$1,590 direct-site unit wins") && prompt.includes("$1,700 one does NOT"),
);
check(
  "find prompt: no qualifying VRBO → cheapest non-VRBO wins",
  /If NO qualifying VRBO listing exists for a slot, the cheapest qualifying\s+non-VRBO listing wins/.test(prompt),
);
check(
  "find prompt: preference never relaxes the qualification or pair rules",
  /never relaxes rules 1–5/.test(prompt) && /same-complex pair still beats a cross-complex one regardless of channel/.test(prompt),
);
check(
  "find prompt: report shows the VRBO comparison + branch taken",
  /show each slot's cheapest VRBO total next to what you picked/.test(prompt),
);
check(
  "single-unit find prompt: preference present without the pair-rule clause",
  /CHANNEL PREFERENCE — VRBO FIRST/.test(singleForPair) && /never relaxes rules 1–5 —/.test(singleForPair),
);

// Booking mode (operator 2026-07-05): prefer instant book; request-only is OK
// but must come with an instant-book backup recorded in notes + report.
check(
  "find prompt: booking-mode section prefers INSTANT BOOK",
  /BOOKING MODE — prefer INSTANT BOOK; request-only is OK but needs a backup/.test(prompt),
);
check(
  "find prompt: defines both booking modes",
  /INSTANT BOOK — checkout confirms the stay immediately/.test(prompt) &&
    /REQUEST-ONLY — the host must approve first/.test(prompt),
);
check(
  "find prompt: comparable options → pick the instant-book one",
  /otherwise comparable[\s\S]*pick the INSTANT-BOOK one/.test(prompt),
);
check(
  "find prompt: request-only stays acceptable (never rejected over it)",
  /never reject the cheapest\s+qualifying pick just because it is request-only/.test(prompt),
);
check(
  "find prompt: booking-mode preference never overrides channel preference or rules 1–5",
  /never\s+overrides the CHANNEL PREFERENCE above or relaxes rules 1–5/.test(prompt),
);
check(
  "find prompt: BACKUP RULE — request-only pick needs cheapest qualifying instant-book backup",
  /BACKUP RULE — whenever the pick you ATTACH for a slot is REQUEST-ONLY/.test(prompt) &&
    /cheapest qualifying INSTANT-BOOK\s+listing\*\*/.test(prompt),
);
check(
  "find prompt: backup is never attached or booked",
  /Do NOT attach the backup and do NOT book it/.test(prompt),
);
check(
  "find prompt: backup must be a distinct URL; combo prefers same complex as siblings",
  /a DISTINCT URL from every attached pick;\s*\nfor this combo, ideally in the same complex as the other attached unit\(s\)/.test(prompt),
);
check(
  "single-unit find prompt: backup rule present without the combo clause",
  /BACKUP RULE/.test(singleForPair) && !/other attached unit\(s\)/.test(singleForPair),
);
check(
  "find prompt: candidate capture includes booking mode",
  /and the BOOKING MODE \(instant book vs request-only/.test(prompt),
);
check(
  "find prompt: notes template records booking mode + optional backup, ·-joined",
  prompt.includes("· Booking mode: <instant book | request-only> · Instant-book backup: <backup listing URL> — $<backup all-in total>"),
);
check(
  "find prompt: backup notes segment is conditional (request-only + found)",
  /"Instant-book backup:" segment ONLY when this pick is request-only AND you\s+found a backup/.test(prompt),
);
check(
  "find prompt: report carries booking mode + backup (or explicit none)",
  /its BOOKING MODE \(instant book \/ request-only\)/.test(prompt) &&
    /no qualifying instant-book backup exists/.test(prompt),
);

// Channel rule (operator 2026-07-05): never attach an Airbnb link.
check(
  "find prompt forbids attaching airbnb.com links",
  /NEVER\s+attach an airbnb\.com link/i.test(prompt) && prompt.includes("does not qualify"),
);
check(
  "find prompt allows VRBO / Booking.com / direct sites",
  /VRBO\*\*, \*\*Booking\.com\*\*, or \*\*direct\s+booking site/.test(prompt),
);
check(
  "find prompt: Airbnb is discovery-only",
  /use Airbnb to DISCOVER/i.test(prompt),
);
check(
  "create-body URL field carries the never-airbnb note",
  prompt.includes("never airbnb.com; the field name is legacy"),
);

// Manual-attach method = the two API calls.
check("describes create endpoint", prompt.includes("POST https://app.example.com/api/buy-ins"));
check("describes attach endpoint", prompt.includes("/api/bookings/abc123/attach-buy-in"));
check("mentions force/override on 409", prompt.includes('"force": true') && prompt.includes("overrideNote"));
check("dates threaded into create body", prompt.includes('"checkIn": "2026-07-20"') && prompt.includes('"checkOut": "2026-07-27"'));

// baseUrl optional → placeholder.
const noBase = buildCoworkBuyInPrompt({ ...baseInput, baseUrl: undefined });
check("placeholder when no baseUrl", noBase.includes("<APP_BASE_URL>/api/buy-ins"));

// ── SPLIT (operator spec 2026-07-05): the FIND prompt never books ────────────
check("find prompt ends at attach — explicit do-not-book", prompt.includes("This task ends at ATTACH") && /Do \*\*NOT\*\* book/.test(prompt));
check("find prompt has no booking/checkout steps", !prompt.includes("Book now / Confirm and pay") && !/damage waiver/i.test(prompt));
check("find prompt never mentions the card file", !prompt.includes(DEFAULT_CARD_FILE_HINT) && !/card/i.test(prompt));
check("find prompt points at the separate checkout prompt", /separate checkout prompt/i.test(prompt));
check(
  "find prompt closes its own tabs when done (operator: tabs clog the browser)",
  /close every Chrome tab you opened/i.test(prompt) && /already open before you started untouched/i.test(prompt),
);

// ── PROFIT GUARD → loss-triggered city-wide rollback (operator 2026-07-06) ────
// When the reservation's net revenue is known, the cheapest same-community set
// that would lose more than the app's $100 max-loss cap must roll the search
// back to a cheaper city-wide SAME-COMPLEX pair — not just settle for the loss.
const lossPrompt = buildCoworkBuyInPrompt({ ...baseInput, netRevenue: 4200 });
check(
  "loss guard: profit-guard section names the net revenue + $100 cap",
  /## Profit guard — don't settle for a loss/.test(lossPrompt) &&
    lossPrompt.includes("$4200.00") &&
    lossPrompt.includes("$100"),
);
check(
  "loss guard: $100 cap is sourced from DEFAULT_PROFIT_MIN_FLAT_USD",
  lossPrompt.includes(`$${DEFAULT_PROFIT_MIN_FLAT_USD}`),
);
check(
  "loss guard: city-wide rung fires on coverage OR a loss",
  /City-wide fallback — for coverage OR to escape a loss/.test(lossPrompt) &&
    /LOSS: the cheapest qualifying same-community set you CAN find is a LOSS over the \$100 cap/.test(lossPrompt) &&
    lossPrompt.includes("city-wide search of Koloa, Hawaii"),
);
check(
  "loss guard: rollback hunts a same-complex pair of the required bedroom size",
  lossPrompt.includes("TWO qualifying 3BR + 3BR listings that sit in the SAME complex as each other") &&
    lossPrompt.includes("take the CHEAPEST qualifying same-complex pair that stays within the $100 loss cap") &&
    lossPrompt.includes("The PAIR RULE still holds"),
);
check(
  "loss guard: if the whole city is still a loss, attach cheapest + flag (never leave empty)",
  lossPrompt.includes("attach that cheapest option") &&
    lossPrompt.includes("a covered guest beats an empty slot") &&
    /FLAG the loss prominently/.test(lossPrompt),
);
check(
  "loss guard: report carries the profit math + which branch applied",
  lossPrompt.includes("Also report the PROFIT MATH") &&
    lossPrompt.includes("(b) rolled back to a city-wide same-complex pair") &&
    lossPrompt.includes("(c) attached at a loss because no option within the $100 cap"),
);
check(
  "loss guard: done signal's problem example mentions an unavoidable loss",
  lossPrompt.includes("a set you had to attach at a loss over the cap"),
);
check(
  "loss guard: the search ladder is otherwise intact (community-first + STOP at city-wide)",
  lossPrompt.includes("Same community first") && /STOP at city-wide/i.test(lossPrompt),
);
check(
  "loss guard: find prompt still never mentions a payment card",
  !/card/i.test(lossPrompt),
);
// Single-unit + guard on → the rollback is the SINGLE variant, no pair language.
const lossSingle = buildCoworkBuyInPrompt({ ...baseInput, units: [baseInput.units[0]], netRevenue: 4200 });
check(
  "loss guard (single): rollback seeks a cheaper same-bedroom unit, not a pair",
  lossSingle.includes("a cheaper qualifying same-bedroom listing") &&
    !lossSingle.includes("TWO qualifying") &&
    !lossSingle.includes("The PAIR RULE still holds") &&
    lossSingle.includes("(b) rolled back to a city-wide unit to escape a same-community loss"),
);
// Degrade-safe: unknown / <=0 net revenue disables the guard entirely, and the
// guard-off output is byte-identical to the pre-2026-07-06 prompt.
const guardOffZero = buildCoworkBuyInPrompt({ ...baseInput, netRevenue: 0 });
const guardOffNeg = buildCoworkBuyInPrompt({ ...baseInput, netRevenue: -50 });
check(
  "loss guard: net revenue 0 / negative disables the guard (no profit-guard section)",
  !guardOffZero.includes("Profit guard") && !guardOffNeg.includes("Profit guard"),
);
check(
  "loss guard: no netRevenue disables the guard (baseInput prompt has no guard) + keeps the original city-wide fallback wording",
  !prompt.includes("Profit guard") &&
    prompt.includes("2. **City-wide fallback.** If you cannot find a qualifying listing"),
);
check(
  "loss guard: guard-off output is byte-identical to omitting netRevenue",
  guardOffZero === prompt,
);

// ── buildCoworkCheckoutPrompt: the separate BOOK-ONLY prompt ─────────────────
const checkoutInput: CoworkCheckoutPromptInput = {
  reservationId: "abc123",
  guestName: "Jane Traveler",
  propertyName: "Poipu Kai 6BR Combo",
  checkIn: "2026-07-20",
  checkOut: "2026-07-27",
  units: [
    { buyInId: 41, unitLabel: "Unit A", listingUrl: "https://www.vrbo.com/1234567", costPaid: "1820.00" },
    { buyInId: 42, unitLabel: "Unit B", listingUrl: "https://www.vrbo.com/7654321", costPaid: 1990 },
  ],
  baseUrl: "https://app.example.com/",
};
const checkout = buildCoworkCheckoutPrompt(checkoutInput);

check("checkout: book-only title", checkout.includes("Book the 2 attached buy-in units on vrbo.com"));
check(
  "checkout: running the prompt IS the approval (no further checkpoint)",
  checkout.includes("running this\nprompt is my approval") && !checkout.includes("STOP and wait for my explicit approval"),
);
check("checkout: never re-searches", checkout.includes("Do not re-run the search") && !checkout.includes("Same community first"));
check(
  "checkout: embeds the attached units (ids, URLs, approved costs)",
  checkout.includes("buyInId 41") && checkout.includes("buyInId 42") &&
    checkout.includes("https://www.vrbo.com/1234567") && checkout.includes("https://www.vrbo.com/7654321") &&
    checkout.includes("$1820.00") && checkout.includes("$1990.00"),
);
check(
  "checkout: damage waiver ONLY — everything else declined",
  checkout.includes("Damage waiver ONLY") && /decline travel\/trip insurance/i.test(checkout) && /every other optional add-on/i.test(checkout),
);
check(
  "checkout: deposit-only hosts are proceed + note (mandated, not an upsell)",
  /refundable damage deposit[\s\S]{0,120}host-mandated: proceed/i.test(checkout),
);
check(
  "checkout: guest name for everything INCLUDING name-on-card",
  checkout.includes("INCLUDING the name-on-card field") && checkout.includes("(Jane Traveler)") &&
    /Do NOT use the\s+cardholder's own name/.test(checkout) &&
    /name-on-card field, which\s+gets the GUEST's name/.test(checkout),
);
check(
  "checkout: traveler email = minted alias via the traveler-email endpoint",
  checkout.includes("POST https://app.example.com/api/buy-ins/<buyInId>/traveler-email") && checkout.includes("emailprivaccy.com"),
);
check(
  "checkout: guest first/last threaded into the mint call",
  checkout.includes('"guestFirstName": "Jane"') && checkout.includes('"guestLastName": "Traveler"'),
);
check("checkout: fixed operator booking phone", checkout.includes("808-460-6509"));
check("checkout: 15% price guard", checkout.includes("15% above") && /do NOT book/.test(checkout));
check("checkout: skip-if-booked idempotency guard", /"bookingStatus" is "booked"/.test(checkout));
check("checkout: sanity-check attach data before booking", /on any mismatch, stop and ask/i.test(checkout));
check("checkout: never blind-retry the final click", checkout.includes("Never blind-retry") && /My Trips/.test(checkout));
check("checkout: dates via the page's own picker, never URL params", /never edit URL parameters/.test(checkout));
check(
  "checkout: records the booking on the buy-in row",
  checkout.includes('"bookingStatus": "booked"') && checkout.includes('"bookingConfirmation"'),
);
check("checkout: one unit at a time", /One unit at a time/.test(checkout));
check(
  "checkout: closes its own tabs when done, but never mid-booking",
  /close every Chrome tab you opened/i.test(checkout) &&
    /already open before you started untouched/i.test(checkout) &&
    /Do NOT close a checkout tab\s+mid-booking/i.test(checkout),
);
// CARD HYGIENE — the load-bearing safety property of this prompt.
check("checkout: card comes from the LOCAL file, path only", checkout.includes(DEFAULT_CARD_FILE_HINT));
check("checkout: forbids pasting card details anywhere", /Do NOT paste card\s+details/.test(checkout));
check(
  "checkout: prompt can never contain card digits (no 13+ digit runs)",
  !/\d[\d\s-]{12,}\d/.test(checkout),
);
const customCard = buildCoworkCheckoutPrompt({ ...checkoutInput, cardFileHint: "~/Notes/card.txt" });
check("checkout: cardFileHint override respected", customCard.includes("~/Notes/card.txt") && !customCard.includes(DEFAULT_CARD_FILE_HINT));
// Unknown guest name → the prompt tells the agent to read it off the reservation.
const namelessCheckout = buildCoworkCheckoutPrompt({ ...checkoutInput, guestName: null });
check("checkout: unknown guest name → read it off the reservation row", namelessCheckout.includes("read it off the reservation row"));
// Missing listing URL → explicit fallback instruction, never a silent blank.
const noUrl = buildCoworkCheckoutPrompt({
  ...checkoutInput,
  units: [{ buyInId: 7, unitLabel: "Unit C", listingUrl: null, costPaid: null }],
});
check("checkout: single-unit title", noUrl.includes("Book the attached buy-in unit on vrbo.com"));
check(
  "checkout: missing URL/cost degrade loudly",
  noUrl.includes("no URL recorded") && noUrl.includes("(not recorded)"),
);

// ── Party size (operator 2026-07-05: show adults/children so buy-ins sleep everyone) ──
const party = { total: 8, adults: 4, children: 4, infants: null, pets: null };
const partyPrompt = buildCoworkBuyInPrompt({ ...baseInput, party });
check(
  "find prompt: party size line renders",
  partyPrompt.includes("- Party size: 8 guests (4 adults, 4 children)"),
);
check(
  "find prompt (combo): SIZE rule requires combined sleeps capacity",
  /COMBINED stated max occupancy/.test(partyPrompt) && /"sleeps N"/.test(partyPrompt),
);
const partySingle = buildCoworkBuyInPrompt({
  ...baseInput,
  units: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }],
  party,
});
check(
  "find prompt (single unit): SIZE rule requires the unit sleep the whole party",
  /SLEEP the whole party/.test(partySingle),
);
check(
  "find prompt: no party → no party line, no sleeps rule",
  !prompt.includes("Party size:") && !/COMBINED stated max occupancy|SLEEP the whole party/.test(prompt),
);
const partyCheckout = buildCoworkCheckoutPrompt({ ...checkoutInput, party });
check(
  "checkout: party line + real guest count replace the 'sensible' guess",
  partyCheckout.includes("- Party size: 8 guests (4 adults, 4 children)") &&
    partyCheckout.includes("the guest count for the reservation's party — 8 guests (4 adults, 4 children)") &&
    !/a sensible\s+guest count/.test(partyCheckout),
);
check(
  "checkout: no party → sensible-guest-count fallback preserved",
  /a sensible\s+guest count/.test(checkout) && !checkout.includes("Party size:"),
);
// placeholder base URL when none provided.
const noBaseCheckout = buildCoworkCheckoutPrompt({ ...checkoutInput, baseUrl: undefined });
check("checkout: placeholder when no baseUrl", noBaseCheckout.includes("<APP_BASE_URL>/api/buy-ins"));

// ── buildCoworkCommunityVerifyPrompt: the "Verify community" button ──────────
const verify = buildCoworkCommunityVerifyPrompt({
  reservationId: "abc123",
  propertyName: "Waikiki 4BR Combo",
  community: "Ilikai",
  units: [
    { buyInId: 51, unitLabel: "Unit A", listingUrl: "https://www.vrbo.com/1234567", unitAddress: "1777 Ala Moana Blvd, Honolulu, HI" },
    { buyInId: 52, unitLabel: "Unit B", listingUrl: "https://www.booking.com/hotel/us/some-condo.html", unitAddress: null },
  ],
  baseUrl: "https://app.example.com",
});
check("verify: same-building framing for a pair", verify.includes("ideally the SAME BUILDING"));
check(
  "verify: read-only apart from address/notes recording",
  /Do NOT book anything, do NOT attach or\s+detach anything/.test(verify),
);
check("verify: embeds both buy-ins", verify.includes("buyInId 51") && verify.includes("buyInId 52"));
check("verify: shows the address on file + the missing one", verify.includes("1777 Ala Moana Blvd") && verify.includes("(none — that's part of why this check exists)"));
check("verify: uses the map pin, forbids guessing", /map pin/.test(verify) && /do NOT guess an address/.test(verify));
check(
  "verify: records confirmed addresses via PATCH",
  verify.includes("PATCH https://app.example.com/api/buy-ins/<buyInId>") && verify.includes('"unitAddress"'),
);
check(
  "verify: verdict scale includes SAME BUILDING → DIFFERENT communities",
  verify.includes("SAME BUILDING / same complex / same community") && verify.includes("DIFFERENT communities"),
);
check("verify: recommends, never detaches", /do NOT\s+detach or change anything yourself/.test(verify));
check(
  "verify: records the verdict via the community-verdict endpoint",
  verify.includes("POST https://app.example.com/api/bookings/abc123/community-verdict") &&
    verify.includes('"source": "cowork"') &&
    /same_building \| same_community \| different/.test(verify),
);
check(
  "verify: maps the verdict scale onto the enum",
  /SAME BUILDING → "same_building"/.test(verify) && /anything else → "different"/.test(verify),
);
// Operator spec 2026-07-05 follow-up: recording the verdict is what MARKS the
// units in the portal UI — the prompt must say so and forbid skipping it.
check(
  "verify: verdict POST is framed as MARKING the units in the portal UI",
  verify.includes("MARKS the units in the\n   portal UI") || /MARKS the units in the\s+portal UI/.test(verify),
);
check(
  "verify: names the per-unit badges the POST produces",
  verify.includes('"✓ Same building"') && verify.includes('"✓ Same community"') && verify.includes('"✕ Not the same community"'),
);
check(
  "verify: forbids skipping the verdict POST even on a positive finding",
  /NEVER skip this step/.test(verify) && /leaves the units UNMARKED/.test(verify),
);
check("verify: tidies up its tabs", /close every Chrome tab you opened/i.test(verify));
check("verify: names the configured community", verify.includes("Configured community: Ilikai"));
const verifySingle = buildCoworkCommunityVerifyPrompt({
  reservationId: "r1",
  propertyName: "Solo Condo",
  community: null,
  units: [{ buyInId: 9, unitLabel: "Unit", listingUrl: null, unitAddress: null }],
});
check(
  "verify single: judges against configured community / property name",
  verifySingle.includes("attached buy-in unit is") && verifySingle.includes("(none configured — judge against the property name and the units themselves)"),
);

// ── Bot-check protocol (operator 2026-07-05): beep loudly + WAIT, never skip ──
for (const [label, p] of [["find", prompt], ["checkout", checkout], ["verify", verify]] as const) {
  check(
    `${label} prompt: bot check → never skip, leave the tab at the challenge`,
    /NEVER skip a site over this/.test(p) && /Do NOT skip that site and do NOT close the tab/.test(p),
  );
  check(
    `${label} prompt: loud repeating alert (afplay + say + notification)`,
    p.includes("afplay /System/Library/Sounds/Sosumi.aiff") && /\bsay -r 170\b/.test(p) && p.includes("display notification"),
  );
  check(
    `${label} prompt: waits and resumes where it left off`,
    /Re-check the challenged tab every ~30 seconds/.test(p) && /CONTINUE\s+the task from exactly where you left off/.test(p),
  );
  check(
    `${label} prompt: never reloads or self-solves the challenge`,
    /do NOT reload the page/.test(p) && /Do NOT\s+attempt the challenge yourself/.test(p),
  );
}

// ── buildCoworkGuestHappyPrompt: "Will guest be happy?" evaluation ──────────
const guestHappy = buildCoworkGuestHappyPrompt({
  reservationId: "abc123",
  guestName: "Jane Traveler",
  propertyName: "Spacious - 2 BR / 2 BA Condo w/ Beautiful Ocean Views",
  community: "Ilikai",
  bookedChannel: "homeaway2",
  units: [
    { buyInId: 41, unitLabel: "Unit A", listingUrl: "https://www.vrbo.com/1234567", bedrooms: 2 },
    { buyInId: 42, unitLabel: "Unit B", listingUrl: null, bedrooms: 2 },
  ],
  baseUrl: "https://app.example.com",
});
check("guest-happy: framed through the guest's eyes", /put yourself in the guest's shoes/i.test(guestHappy));
check(
  "guest-happy: studies the ORIGINAL listing first",
  guestHappy.includes("Study the ORIGINAL listing") && guestHappy.includes("Spacious - 2 BR / 2 BA Condo w/ Beautiful Ocean Views"),
);
check(
  "guest-happy: four comparison dimensions",
  /COMMUNITY:/.test(guestHappy) && /SIZE:/.test(guestHappy) && /BEDDING LAYOUT:/.test(guestHappy) && /QUALITY:/.test(guestHappy),
);
check(
  "guest-happy: bedding downgrade is called out",
  /2 Twins replacing a King is a DOWNGRADE/.test(guestHappy),
);
check(
  "guest-happy: photo quality is a visual judgment",
  /LOOK at the\s+photos/.test(guestHappy) && /finish, furniture, view/i.test(guestHappy.replace(/\s+/g, " ")),
);
check(
  "guest-happy: records verdict + feedback via the endpoint",
  guestHappy.includes("POST https://app.example.com/api/bookings/abc123/guest-happy") &&
    /happy \| concerns \| unhappy/.test(guestHappy) &&
    guestHappy.includes('"source": "cowork"'),
);
check(
  "guest-happy: feedback example matches the operator's ask",
  /guest will\s+be happy: two 2BR condos in the same community/i.test(guestHappy.replace(/\s+/g, " ")),
);
check(
  "guest-happy: read-only apart from the verdict write",
  /Do NOT book, attach, or detach anything/.test(guestHappy),
);
check("guest-happy: embeds the attached units", guestHappy.includes("buyInId 41") && guestHappy.includes("buyInId 42"));
check("guest-happy: has the bot-wall protocol", /NEVER skip a site over this/.test(guestHappy));
check("guest-happy: tidies tabs + done signal", /close every Chrome tab you opened/i.test(guestHappy) && /## Done signal/.test(guestHappy));
check(
  "guest-happy: done signal names the evaluation outcome",
  guestHappy.includes("the guest-happiness check is complete and the feedback is recorded"),
);

// ── buildCoworkVrboLookupPrompt: "Find property on VRBO" re-channel ─────────
const vrboLookup = buildCoworkVrboLookupPrompt({
  reservationId: "abc123",
  propertyName: "Waikiki 4BR Combo",
  checkIn: "2026-07-07",
  checkOut: "2026-07-12",
  units: [
    { buyInId: 61, unitLabel: "Unit A", listingUrl: "https://waikikibeachrentals.com/unit-1834", unitAddress: "1777 Ala Moana Blvd, Honolulu, HI", costPaid: "1975.00" },
    { buyInId: 62, unitLabel: "Unit B", listingUrl: "https://www.booking.com/hotel/us/some-condo.html", unitAddress: null, costPaid: 3935 },
  ],
  baseUrl: "https://app.example.com",
});
check("vrbo-lookup: hunts for the unit's OWN listing on VRBO", /OWN listing on VRBO and re-channel/.test(vrboLookup));
check(
  "vrbo-lookup: SAME-UNIT-ONLY match rule (similar unit is not a match)",
  /SAME-UNIT-ONLY match rule/.test(vrboLookup) && /similar or nicer unit in the same\s+building is NOT a match/.test(vrboLookup),
);
check(
  "vrbo-lookup: switch recorded atomically via the vrbo-lookup endpoint",
  vrboLookup.includes("POST https://app.example.com/api/buy-ins/<buyInId>/vrbo-lookup") &&
    vrboLookup.includes('"status": "switched"') && vrboLookup.includes('"vrboUrl"') && vrboLookup.includes('"vrboTotal"'),
);
check(
  "vrbo-lookup: keeps the 20% price hatch (kept_cheaper)",
  vrboLookup.includes('"status": "kept_cheaper"') && /more than 20%\s+cheaper/i.test(vrboLookup) && /current < 80% of VRBO/.test(vrboLookup),
);
check(
  "vrbo-lookup: genuine no-listing outcome recorded as not_on_vrbo",
  vrboLookup.includes('"status": "not_on_vrbo"'),
);
check(
  "vrbo-lookup: never books, never touches booked units",
  /Do NOT book\s+anything/.test(vrboLookup) && /never touch a unit that is\s+already booked/.test(vrboLookup),
);
check(
  "vrbo-lookup: dates via the page's own picker, never URL params",
  /never construct URLs with search\s+parameters/.test(vrboLookup),
);
check("vrbo-lookup: embeds the non-VRBO units + costs", vrboLookup.includes("buyInId 61") && vrboLookup.includes("buyInId 62") && vrboLookup.includes("$1975.00"));
check("vrbo-lookup: has the bot-wall protocol + done signal", /NEVER skip a site over this/.test(vrboLookup) && /## Done signal/.test(vrboLookup));

// ── Done signal (operator 2026-07-05): audible chime when the task finishes ──
for (const [label, p] of [["find", prompt], ["checkout", checkout], ["verify", verify]] as const) {
  check(
    `${label} prompt: done signal plays Glass on success + Basso on problems`,
    p.includes("afplay /System/Library/Sounds/Glass.aiff") && p.includes("afplay /System/Library/Sounds/Basso.aiff"),
  );
  check(
    `${label} prompt: speaks the actual outcome`,
    p.includes('say -r 170 "Cowork is done —') && p.includes("Cowork finished, but needs your attention"),
  );
  check(
    `${label} prompt: done signal is one burst, never a loop, and fires LAST`,
    /ONE burst only, never loop these/.test(p) &&
      p.indexOf("## Done signal") > p.indexOf("TIDY UP THE BROWSER"),
  );
  check(
    `${label} prompt: done chime stays distinct from the Sosumi bot alarm`,
    /\(Sosumi\) stays separate/.test(p),
  );
}
check("find done signal: attached-units outcome", prompt.includes("both buy-in units are attached"));
check("checkout done signal: booked-and-recorded outcome", checkout.includes("every unit is booked on VRBO and the confirmations are recorded"));
check("verify done signal: verdict-recorded outcome", verify.includes("the community check is complete and the verdict is recorded"));

// ── Source assertions: the walking-distance card must digest Cowork notes ────
// (2026-07-05 Waikiki incident: boilerplate notes became the "resort" label,
// and a junk geocode produced a fake 0.4 mi walk.) These lock the routes.ts /
// bookings.tsx fixes; imports would drag the whole server up, so grep instead.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const routesSrc = fs.readFileSync(path.join(here, "../server/routes.ts"), "utf8");
  const bookingsSrc = fs.readFileSync(path.join(here, "../client/src/pages/bookings.tsx"), "utf8");
  check(
    "routes: titleFromBuyInNoteText parses the Cowork note format",
    /Found via Cowork web search\\s\*\[—–\]\[\^—–\]\*\[—–\]/.test(routesSrc),
  );
  check(
    "routes: bare 'Manually recorded buy-in' lead is rejected as a title",
    /\^Manually recorded buy-in\\b/.test(routesSrc),
  );
  check(
    "routes: record-keeping boilerplate can never become the resort label",
    /\^\(\?:manually\|auto-\?filled\|bought via\|attached\|recorded\)\\b/.test(routesSrc),
  );
  check(
    "bookings: proximity legend no longer prints the token as 'Buy-in #'",
    !bookingsSrc.includes("`Buy-in #${token} for") && bookingsSrc.includes("— unit #${token}"),
  );
}

// ── single-unit reservation (Unit 3104, 2BR off a non-combo listing) ─────────
const single = buildCoworkBuyInPrompt({
  reservationId: "HA-PGf8rgW",
  guestName: "Cheryl Parker",
  propertyId: 99,
  propertyName: "Homeaway2 · Unit 3104",
  community: "",
  checkIn: "2026-07-03",
  checkOut: "2026-07-06",
  units: [{ unitId: "3104", unitLabel: "Unit 3104", bedrooms: 2 }],
  baseUrl: "https://app.example.com",
});
check("single: count-aware heading", single.includes("Find the cheapest buy-in unit for a reservation"));
check("single: one listing total", single.includes("one listing total"));
check("single: still same-community first", single.includes("Same community first"));
check("single: still forbids beyond city-wide", /STOP at city-wide/i.test(single));
check("single: no 'repeat for second unit' line", !single.includes("second unit slot"));
check("single: empty community → infer hint", single.includes("infer from the property name"));
check("single: attach endpoint still present", single.includes("/api/bookings/HA-PGf8rgW/attach-buy-in"));

// ── MISLABELED community (Santa Maria condo mis-mapped to Bonita National) ───
// The real incident: a Fort Myers Beach "Santa Maria Resort" condo whose configured
// community resolved to the inland "Bonita National", sending the search to the wrong
// place. The prompt must anchor on the property's own resort name, not the community.
const mislabeled = buildCoworkBuyInPrompt({
  reservationId: "6a2716f69466d1001379f5dd",
  guestName: "Cheryl Parker",
  propertyId: -5,
  propertyName: "Santa Maria Resort - 2BR Condo - Sleeps",
  community: "Bonita National", // MISLABELED for this property
  checkIn: "2026-07-03",
  checkOut: "2026-07-06",
  units: [{ unitId: "main", unitLabel: "Unit 3104", bedrooms: 2 }],
  baseUrl: "https://app.example.com",
});
check("mislabeled: anchors on the property resort name", mislabeled.includes("Resort to search (PRIMARY — anchor on this): Santa Maria Resort"), mislabeled.match(/Resort to search.*/)?.[0]);
check("mislabeled: does NOT anchor the search on Bonita National", !/inside \*\*Bonita National\*\*/.test(mislabeled));
check("mislabeled: warns the configured community may be wrong", /MAY BE MISLABELED/.test(mislabeled));
check("mislabeled: requires the condo unit type", /a \*\*condo\*\*/.test(mislabeled));
check("mislabeled: same-city does not qualify", mislabeled.includes("same CITY does NOT qualify"));
check("mislabeled: distrusts the curated city", mislabeled.includes("determine it from the resort's own listing"));

// A property whose name CORROBORATES the community keeps trusting the curated city.
const corroborated = buildCoworkBuyInPrompt({ ...baseInput, propertyName: "Poipu Kai Resort - 3BR Condo" });
check("corroborated: keeps the curated resort as anchor", corroborated.includes("anchor on this): Poipu Kai"), corroborated.match(/Resort to search.*/)?.[0]);
check("corroborated: keeps the curated city-wide (Koloa)", corroborated.includes("city-wide search of Koloa, Hawaii"));
check("corroborated: no mislabel warning", !/MAY BE MISLABELED/.test(corroborated));

// ── unitCommunityVerdictBadge: per-unit UI marker for the recorded verdict ───
// (operator spec 2026-07-05: verified same-building units must be marked on
// the unit cards themselves, not only on the walking-distance panel.)
{
  const { unitCommunityVerdictBadge } = await import("../shared/community-verdict-badge");
  const building = unitCommunityVerdictBadge({
    communityVerdict: "same_building",
    communityVerdictSource: "cowork",
    communityVerdictAt: "2026-07-05T18:30:00.000Z",
  });
  check("badge: same_building → ✓ Same building", building?.label === "✓ Same building" && building.different === false, building);
  check(
    "badge: title carries source + ISO day + meaning",
    !!building && building.title.includes("via cowork") && building.title.includes("on 2026-07-05") && building.title.includes("SAME BUILDING"),
    building?.title,
  );
  const community = unitCommunityVerdictBadge({ communityVerdict: "same_community", communityVerdictSource: "operator", communityVerdictAt: null });
  check("badge: same_community → ✓ Same community", community?.label === "✓ Same community" && community.different === false, community);
  check("badge: no date → title omits 'on'", !!community && !community.title.includes(" on ") && community.title.includes("via operator"), community?.title);
  const different = unitCommunityVerdictBadge({ communityVerdict: "different", communityVerdictSource: "cowork", communityVerdictAt: new Date("2026-07-05T00:00:00Z") });
  check("badge: different → red ✕ badge", different?.label === "✕ Not the same community" && different.different === true, different);
  check("badge: no verdict → null", unitCommunityVerdictBadge({ communityVerdict: null }) === null);
  check("badge: missing buy-in → null", unitCommunityVerdictBadge(null) === null && unitCommunityVerdictBadge(undefined) === null);
  check("badge: junk legacy value → null (never render junk)", unitCommunityVerdictBadge({ communityVerdict: "maybe?" }) === null);
  check(
    "badge: whitespace/case tolerated, invalid date dropped from title",
    unitCommunityVerdictBadge({ communityVerdict: "  SAME_BUILDING ", communityVerdictAt: "not-a-date" })?.label === "✓ Same building" &&
      !unitCommunityVerdictBadge({ communityVerdict: "same_building", communityVerdictAt: "not-a-date" })!.title.includes(" on "),
  );

  // Source assertion: the bookings slot card actually renders this badge from
  // the slot's OWN buy-in row (grep, not import — bookings.tsx drags in the
  // whole client bundle).
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bookingsSrc = fs.readFileSync(path.join(here, "../client/src/pages/bookings.tsx"), "utf8");
  check(
    "bookings: slot card derives the badge from slot.buyIn via unitCommunityVerdictBadge",
    bookingsSrc.includes("unitCommunityVerdictBadge(slot.buyIn)"),
  );
  check(
    "bookings: per-unit badge has a stable testid",
    bookingsSrc.includes("badge-unit-community-verdict-${r._id}-${slot.unitId}"),
  );

  // ── unitGuestHappyBadge: per-unit UI marker for the guest-happy verdict ───
  // (operator spec 2026-07-05: after the guest-happiness evaluation, Cowork
  // must PUT the verdict on the units in the portal — "yes, guest will be
  // 100% happy" / "no — bedding is off" — not just report it in chat.)
  const { unitGuestHappyBadge } = await import("../shared/guest-happy-badge");
  const happy = unitGuestHappyBadge({
    guestHappyVerdict: "happy",
    guestHappyFeedback: "Yes, guest will be happy: bedding and finish match.",
    guestHappySource: "cowork",
    guestHappyAt: "2026-07-05T18:30:00.000Z",
  });
  check("gh-badge: happy → ★ emerald", happy?.label === "★ Guest happy" && happy.tone === "emerald", happy);
  check(
    "gh-badge: title carries source + ISO day + the recorded feedback",
    !!happy &&
      happy.title.includes("via cowork") &&
      happy.title.includes("on 2026-07-05") &&
      happy.title.includes("bedding and finish match"),
    happy?.title,
  );
  const concerns = unitGuestHappyBadge({ guestHappyVerdict: "concerns", guestHappySource: "operator", guestHappyAt: null });
  check("gh-badge: concerns → ⚠ amber", concerns?.label === "⚠ Guest concerns" && concerns.tone === "amber", concerns);
  check("gh-badge: no date/feedback → title omits them", !!concerns && !concerns.title.includes(" on ") && !concerns.title.trimEnd().endsWith(":"), concerns?.title);
  const unhappy = unitGuestHappyBadge({
    guestHappyVerdict: "unhappy",
    guestHappyFeedback: "No — bedding is off (2 Twins where they booked a King).",
    guestHappySource: "cowork",
    guestHappyAt: new Date("2026-07-05T00:00:00Z"),
  });
  check(
    "gh-badge: unhappy → ✕ red with the why on hover",
    unhappy?.label === "✕ Guest NOT happy" && unhappy.tone === "red" && unhappy.title.includes("bedding is off"),
    unhappy,
  );
  check("gh-badge: no verdict → null", unitGuestHappyBadge({ guestHappyVerdict: null }) === null);
  check("gh-badge: missing buy-in → null", unitGuestHappyBadge(null) === null && unitGuestHappyBadge(undefined) === null);
  check("gh-badge: junk legacy value → null (never render junk)", unitGuestHappyBadge({ guestHappyVerdict: "maybe?" }) === null);
  check(
    "gh-badge: whitespace/case tolerated, invalid date dropped from title",
    unitGuestHappyBadge({ guestHappyVerdict: "  HAPPY " })?.label === "★ Guest happy" &&
      !unitGuestHappyBadge({ guestHappyVerdict: "happy", guestHappyAt: "not-a-date" })!.title.includes(" on "),
  );

  // Source assertions: the bookings slot card actually renders the badge.
  check(
    "bookings: slot card derives the guest-happy badge from slot.buyIn",
    bookingsSrc.includes("unitGuestHappyBadge(slot.buyIn)"),
  );
  check(
    "bookings: per-unit guest-happy badge has a stable testid",
    bookingsSrc.includes("badge-unit-guest-happy-${r._id}-${slot.unitId}"),
  );
}

// The guest-happy prompt's recording step must read as MANDATORY portal
// marking (mirror of the community-verify step 4 rewording): a verdict only
// written in the chat report leaves the units unmarked.
check(
  "guest-happy: recording step MARKS the units in the portal UI",
  /Record the verdict \+ feedback in the app — this is what MARKS the units\s+in the portal UI/.test(guestHappy),
);
check(
  "guest-happy: recording step must NEVER be skipped, even on a 100%-happy verdict",
  /NEVER skip this step/.test(guestHappy) && /yes, guest will be 100% happy/.test(guestHappy) && /UNMARKED/.test(guestHappy),
);
check(
  "guest-happy: names the per-unit badges the POST produces",
  guestHappy.includes("★ Guest happy") && guestHappy.includes("✕ Guest NOT happy"),
);
check(
  "guest-happy: feedback example covers the negative bedding case",
  /bedding is off \(2 Twins where they booked a King\)/.test(guestHappy),
);

// ── buildCoworkBulkBuyInPrompt: the bulk route through Cowork ────────────────
// (operator spec 2026-07-13: "run bulk buy in queue … change this so that it
// routes through cowork"). ONE batch task works N reservations one at a time;
// each brief is the EXACT single prompt with the bot-wall protocol hoisted
// once and the closing (tidy-up + done signal) fired once after the last brief.
console.log("cowork-buyin-prompt: bulk batch builder");

const bulkResB: CoworkBuyInPromptInput = {
  reservationId: "res-B-777",
  guestName: "Bulk Guest B",
  propertyId: 12,
  propertyName: "Kiahuna Plantation - 2BR Condo",
  community: "Kiahuna Plantation",
  checkIn: "2026-09-01",
  checkOut: "2026-09-08",
  units: [{ unitId: "kia-2br", unitLabel: "Unit 2BR", bedrooms: 2 }],
  netRevenue: 3000,
  baseUrl: "https://app.example.com",
};

check("bulk: empty input → empty string", buildCoworkBulkBuyInPrompt([]) === "");
check(
  "bulk: ONE reservation → byte-identical to the single Auto Cowork prompt (load-bearing equivalence)",
  buildCoworkBulkBuyInPrompt([baseInput]) === buildCoworkBuyInPrompt(baseInput),
);
check(
  "bulk: default single prompt keeps its own protocol + closing (bulkBrief opt-in only)",
  buildCoworkBuyInPrompt(baseInput).includes("## Bot-check protocol")
    && buildCoworkBuyInPrompt(baseInput).includes("TIDY UP THE BROWSER")
    && buildCoworkBuyInPrompt(baseInput).includes("## Done signal"),
);

const bulk = buildCoworkBulkBuyInPrompt([baseInput, bulkResB]);
const bulkCount = (re: RegExp) => (bulk.match(re) ?? []).length;
check("bulk: batch title counts the reservations", bulk.includes("# Task: Bulk buy-in search — 2 reservations, one at a time"));
check(
  "bulk: delimited brief headers carry guest @ property (dates)",
  bulk.includes("RESERVATION 1 of 2 — Jane Traveler @ Poipu Kai 6BR Combo (2026-07-20 → 2026-07-27)")
    && bulk.includes("RESERVATION 2 of 2 — Bulk Guest B @ Kiahuna Plantation - 2BR Condo (2026-09-01 → 2026-09-08)"),
);
check("bulk: brief order preserved", bulk.indexOf("RESERVATION 1 of 2") < bulk.indexOf("RESERVATION 2 of 2"));
check("bulk: bot-check protocol hoisted EXACTLY once (batch level)", bulkCount(/## Bot-check protocol/g) === 1);
check("bulk: protocol hoisted ABOVE the first brief", bulk.indexOf("## Bot-check protocol") < bulk.indexOf("RESERVATION 1 of 2"));
check("bulk: each brief points at the batch-level protocol", bulkCount(/batch-level protocol at the TOP of this task/g) === 2);
check(
  "bulk: done signal EXACTLY once, after the last brief",
  bulkCount(/## Done signal/g) === 1 && bulk.indexOf("## Done signal") > bulk.indexOf("RESERVATION 2 of 2"),
);
check("bulk: browser tidy-up EXACTLY once", bulkCount(/TIDY UP THE BROWSER/g) === 1);
check("bulk: every brief still ends at ATTACH (never books)", bulkCount(/This task ends at ATTACH/g) === 2);
check(
  "bulk: each reservation keeps its OWN attach endpoint",
  bulk.includes("/api/bookings/abc123/attach-buy-in") && bulk.includes("/api/bookings/res-B-777/attach-buy-in"),
);
check("bulk: one-at-a-time sequencing rule", /Work them STRICTLY one at a/.test(bulk));
check("bulk: failure isolation — one stuck reservation never sinks the batch", /FAILURE ISOLATION/.test(bulk) && /never sink the batch/.test(bulk));
check("bulk: cross-reservation contamination forbidden", /NEVER carry a unit, price, or URL from one/.test(bulk));
{
  const brief1 = bulk.slice(bulk.indexOf("RESERVATION 1 of 2"), bulk.indexOf("RESERVATION 2 of 2"));
  const brief2 = bulk.slice(bulk.indexOf("RESERVATION 2 of 2"), bulk.indexOf("AFTER THE LAST RESERVATION"));
  check(
    "bulk: profit guard scoped PER BRIEF (off for guard-less A, on for B with its own budget)",
    !brief1.includes("## Profit guard") && brief2.includes("## Profit guard") && brief2.includes("$3000.00"),
  );
}
check(
  "bulk: consolidated final report + once-only closing section",
  bulk.includes("AFTER THE LAST RESERVATION — final report, tidy up, done signal") && bulk.includes("ONE consolidated report"),
);
check("bulk: done-signal success example counts the whole batch", bulk.includes("all 2 reservations have their buy-in units attached"));
check("bulk: batch cap constant is 8", COWORK_BULK_FIND_MAX === 8);

// Source assertions: the bookings page actually routes the bulk process
// through Cowork with the open-slots-only + remaining-budget semantics
// (grep, not import — bookings.tsx drags in the whole client bundle).
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bookingsSrc = fs.readFileSync(path.join(here, "../client/src/pages/bookings.tsx"), "utf8");
  check(
    "bookings: Auto Cowork bulk button exists and builds the batch via the shared builder",
    bookingsSrc.includes('data-testid="button-run-bulk-cowork"') && bookingsSrc.includes("buildCoworkBulkBuyInPrompt(inputs)"),
  );
  check(
    "bookings: the batch launches through the shared Cowork launcher",
    /const result = await launchCoworkPrompt\(prompt\)/.test(bookingsSrc),
  );
  check(
    "bookings: Cowork bulk fills OPEN slots only (never detaches)",
    bookingsSrc.includes("selectedBulkEligibleReservations.filter((r) => r.slots.some((slot) => !slot.buyIn))")
      && bookingsSrc.includes("reservation.slots.filter((slot) => !slot.buyIn)"),
  );
  check(
    "bookings: batch sliced to COWORK_BULK_FIND_MAX with an operator note for the overflow",
    bookingsSrc.includes("withOpenSlots.slice(0, COWORK_BULK_FIND_MAX)") && bookingsSrc.includes("run Auto Cowork bulk again for the remaining"),
  );
  check(
    "bookings: remaining-budget rule mirrored from the single button (net revenue minus attached costs, twice: single + bulk)",
    (bookingsSrc.match(/getNetRevenue\(reservation\)\s*-\s*reservation\.slots\.reduce/g) ?? []).length === 2,
  );
  check(
    "bookings: server engine still available as the fallback (relabeled, same handler)",
    bookingsSrc.includes("Run bulk buy-ins (server)") && bookingsSrc.includes("onClick={startBulkBuyInQueue}"),
  );
}

console.log(`\ncowork-buyin-prompt: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
