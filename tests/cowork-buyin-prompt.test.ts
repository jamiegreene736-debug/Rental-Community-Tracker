// Network-free unit tests for the Cowork buy-in prompt builder. Guards: the
// prompt embeds the reservation facts, names the same-community-first → city-wide
// fallback rule, explicitly forbids expanding beyond city-wide, and spells out
// the manual-attach API (create buy-in + attach-buy-in) per unit slot.
import {
  buildCoworkBuyInPrompt,
  resolveCoworkSearchTargets,
  type CoworkBuyInPromptInput,
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
