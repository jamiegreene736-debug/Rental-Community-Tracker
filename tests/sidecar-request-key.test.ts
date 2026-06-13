// Regression guard for the 2026-06-12 HomeToGo "July-on-June" incident: makeRequestKey
// had no `hometogo_search` case and no default, so every HomeToGo search returned
// `undefined` and they all collided on one dedup key — a July search's offers got
// served to a June reservation's expansion. These tests lock that each op type
// produces a DISTINCT, dates-aware key and that NO op type ever returns undefined.
// vrbo-sidecar-queue transitively imports server/db (needs DATABASE_URL just to
// construct a lazy pool). Set a dummy URL, then dynamic-import the pure function.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
const { makeRequestKey } = await import("../server/vrbo-sidecar-queue");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("sidecar-request-key: dedup/cache key correctness");

const htg = (over: Record<string, unknown> = {}) => ({
  destination: "Lawai, Hawaii, United States",
  searchTerm: "Lawai, Hawaii",
  checkIn: "2026-06-13",
  checkOut: "2026-06-20",
  ...over,
}) as any;

// ── The actual incident: same town, DIFFERENT dates must NOT share a key ──
const june = makeRequestKey("hometogo_search", htg());
const july = makeRequestKey("hometogo_search", htg({ checkIn: "2026-07-20", checkOut: "2026-07-27" }));
check("hometogo: never returns undefined", typeof june === "string" && june.length > 0, june);
check("hometogo: June and July (same town) get DIFFERENT keys", june !== july, { june, july });
check("hometogo: key contains the dates", june.includes("2026-06-13") && june.includes("2026-06-20"), june);

// Different town, same dates → different key.
const lawai = makeRequestKey("hometogo_search", htg());
const koloa = makeRequestKey("hometogo_search", htg({ destination: "Koloa, Hawaii", searchTerm: "Koloa, Hawaii" }));
check("hometogo: different towns get DIFFERENT keys", lawai !== koloa, { lawai, koloa });

// City-wide vs resort scope → different key (don't fold a city scan onto a resort scan).
const city = makeRequestKey("hometogo_search", htg({ cityWideInventory: true }));
const resort = makeRequestKey("hometogo_search", htg({ cityWideInventory: false }));
check("hometogo: city-wide vs resort scope differ", city !== resort, { city, resort });

// Identical search (same town+dates+scope) SHOULD dedup → same key.
check("hometogo: identical search yields the same key (legit dedup)",
  makeRequestKey("hometogo_search", htg()) === makeRequestKey("hometogo_search", htg()));

// ── vrbo_book: was also missing → undefined. Now dates-aware. ──
const book = makeRequestKey("vrbo_book", { buyInId: 1, listingUrl: "https://www.vrbo.com/123", checkIn: "2026-06-13", checkOut: "2026-06-20", firstName: "", lastName: "", email: "", phone: "" } as any);
const bookJuly = makeRequestKey("vrbo_book", { buyInId: 1, listingUrl: "https://www.vrbo.com/123", checkIn: "2026-07-20", checkOut: "2026-07-27", firstName: "", lastName: "", email: "", phone: "" } as any);
check("vrbo_book: never returns undefined", typeof book === "string" && book.length > 0, book);
check("vrbo_book: different dates get different keys", book !== bookJuly);

// ── Exhaustiveness: NO op type may return undefined/empty (the silent-collision bug). ──
const OP_PARAMS: Array<[string, any]> = [
  ["airbnb_search", { destination: "x", searchTerm: "x", checkIn: "2026-06-13", checkOut: "2026-06-20", bedrooms: 3 }],
  ["vrbo_search", { destination: "x", searchTerm: "x", checkIn: "2026-06-13", checkOut: "2026-06-20", bedrooms: 3 }],
  ["hometogo_search", htg()],
  ["booking_search", { destination: "x", searchTerm: "x", checkIn: "2026-06-13", checkOut: "2026-06-20", bedrooms: 3 }],
  ["vrbo_photo_scrape", { url: "https://www.vrbo.com/1" }],
  ["zillow_photo_scrape", { url: "https://www.zillow.com/1" }],
  ["google_serp", { query: "q" }],
  ["pm_site_search", { sites: ["a"], searchTerm: "x", checkIn: "2026-06-13", checkOut: "2026-06-20", bedrooms: 3 }],
  ["pm_url_check", { url: "https://x", checkIn: "2026-06-13", checkOut: "2026-06-20" }],
  ["pm_url_check_batch", { urls: ["https://x"], checkIn: "2026-06-13", checkOut: "2026-06-20" }],
  ["vrbo_upload_photos", { partnerListingRef: "r", photos: [{ url: "https://x" }] }],
  ["booking_upload_photos", { partnerListingRef: "r", photos: [{ url: "https://x" }] }],
  ["guesty_disconnect_channel", { guestyListingId: "g", channel: "airbnb" }],
  ["vrbo_book", { buyInId: 1, listingUrl: "https://www.vrbo.com/1", checkIn: "2026-06-13", checkOut: "2026-06-20", firstName: "", lastName: "", email: "", phone: "" }],
  // An UNHANDLED op type must hit the safe default, not undefined.
  ["some_future_op" as any, { foo: "bar", checkIn: "2026-06-13" }],
];
let allKeyed = true;
const seen = new Set<string>();
for (const [op, p] of OP_PARAMS) {
  const k = makeRequestKey(op as any, p);
  if (typeof k !== "string" || k.length === 0) { allKeyed = false; console.error("   undefined/empty key for", op); }
  seen.add(k);
}
check("exhaustive: every op type (incl. an unhandled one) returns a non-empty key", allKeyed);
check("exhaustive: distinct op types get distinct keys", seen.size === OP_PARAMS.length, { distinct: seen.size, total: OP_PARAMS.length });

console.log(`\nsidecar-request-key: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
