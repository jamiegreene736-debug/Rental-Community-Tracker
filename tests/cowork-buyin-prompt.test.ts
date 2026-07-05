// Network-free unit tests for the Cowork buy-in prompt builder. Guards: the
// prompt embeds the reservation facts, names the same-community-first → city-wide
// fallback rule, explicitly forbids expanding beyond city-wide, and spells out
// the manual-attach API (create buy-in + attach-buy-in) per unit slot.
import {
  buildCoworkBuyInPrompt,
  buildCoworkCheckoutPrompt,
  resolveCoworkSearchTargets,
  DEFAULT_CARD_FILE_HINT,
  type CoworkBuyInPromptInput,
  type CoworkCheckoutPromptInput,
} from "../shared/cowork-buyin-prompt";

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
  "checkout: guest name for everything (name-on-card is the only exception)",
  checkout.includes("The guest's name for everything") && checkout.includes("(Jane Traveler)") && /name-on-card field/.test(checkout),
);
check(
  "checkout: traveler email = minted alias via the traveler-email endpoint",
  checkout.includes("POST https://app.example.com/api/buy-ins/<buyInId>/traveler-email") && checkout.includes("emailprivaccy.com"),
);
check(
  "checkout: guest first/last threaded into the mint call",
  checkout.includes('"guestFirstName": "Jane"') && checkout.includes('"guestLastName": "Traveler"'),
);
check("checkout: fixed operator booking phone", checkout.includes("407-449-7941"));
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
// CARD HYGIENE — the load-bearing safety property of this prompt.
check("checkout: card comes from the LOCAL file, path only", checkout.includes(DEFAULT_CARD_FILE_HINT));
check("checkout: forbids pasting card details anywhere", checkout.includes("Do NOT paste card details"));
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
// placeholder base URL when none provided.
const noBaseCheckout = buildCoworkCheckoutPrompt({ ...checkoutInput, baseUrl: undefined });
check("checkout: placeholder when no baseUrl", noBaseCheckout.includes("<APP_BASE_URL>/api/buy-ins"));

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

console.log(`\ncowork-buyin-prompt: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
