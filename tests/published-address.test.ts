// Network-free unit tests for the Guesty "separate published address"
// feature (2026-07-17): unit-designator stripping, the Address-controller PUT
// payload builder (structurally unit-free), the idempotence compare, the
// resolution-cache store, clubhouse query building + candidate selection, the
// ledger summary wording lock, and source guards on every wiring seam
// (manual route, admin backfill, push-descriptions hook, the five
// mapping-birth seams, the combo pre-resolve, and the audit-sweep fold).
import { readFileSync } from "node:fs";
import {
  CLUBHOUSE_TITLE_HINT_RE,
  PUBLISHED_ADDRESS_CACHE_CAP,
  addressLat,
  addressLng,
  buildGuestyPublishedAddress,
  foldAddressObjectStrings,
  hasNonAsciiAddressChars,
  clubhouseDiscoveryQueries,
  composePublishedFull,
  finiteCoord,
  genericPublishedPartsFromPrivateAddress,
  hasUnitDesignator,
  parsePublishedAddressStore,
  publishedAddressSatisfiesTarget,
  publishedStreetRoot,
  serializePublishedAddressStore,
  stripPublishedUnitTokens,
  summarizePublishedAddressPush,
  type PublishedAddressStore,
} from "../shared/published-address";
import { GUESTY_PUSH_TABS, isGuestyPushTab } from "../shared/guesty-push-history";
import { selectClubhouseCandidate } from "../server/community-address-discovery";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("published-address: generic parts from the private address");
{
  const parts = genericPublishedPartsFromPrivateAddress({
    full: "1831 Poipu Rd, Unit 423, Koloa, HI 96756, United States",
    street: "1831 Poipu Rd Unit 423",
    city: "Koloa",
    state: "HI",
    zipcode: 96756,
    country: "United States",
    unitNumber: "423",
    location: { lat: 21.88, lng: -159.45 },
  });
  check("strips the Unit segment from the street root", parts?.street === "1831 Poipu Rd", parts);
  check("keeps city/state/zip/country", parts?.city === "Koloa" && parts?.state === "HI" && parts?.zipcode === "96756" && parts?.country === "United States");
  check("keeps coordinates", parts?.lat === 21.88 && parts?.lng === -159.45);
  check("derived street has no unit designator", !hasUnitDesignator(parts?.street ?? ""));
}
{
  const parts = genericPublishedPartsFromPrivateAddress({
    full: "1777 Ala Moana Blvd #1834, Honolulu, HI 96815",
    city: "Honolulu",
    state: "HI",
  });
  check("strips the #1834 form", parts?.street === "1777 Ala Moana Blvd", parts);
}
{
  const parts = genericPublishedPartsFromPrivateAddress({
    full: "75-6082 Alii Dr, Apt B, Kailua-Kona, HI 96740",
  });
  check("Hawaii hyphenated house numbers survive the strip", parts?.street === "75-6082 Alii Dr", parts);
}
check(
  "no numbered street → null (caller falls back to local data, never guesses)",
  genericPublishedPartsFromPrivateAddress({ full: "Princeville, HI 96722", city: "Princeville" }) === null,
);
check("null address → null", genericPublishedPartsFromPrivateAddress(null) === null);
check("stripPublishedUnitTokens removes the bare # form", stripPublishedUnitTokens("1777 Ala Moana Blvd #1834") === "1777 Ala Moana Blvd");
check("stripPublishedUnitTokens removes Apt/Unit/Bldg tokens", stripPublishedUnitTokens("1831 Poipu Rd Unit 423 Bldg 3") === "1831 Poipu Rd");
check("stripPublishedUnitTokens is a no-op on a clean street", stripPublishedUnitTokens("2827 Poipu Rd") === "2827 Poipu Rd");
check("publishedStreetRoot returns '' when nothing numbered survives", publishedStreetRoot("Princeville, HI 96722") === "");
check("hasUnitDesignator flags the bare # form", hasUnitDesignator("1777 Ala Moana Blvd #1834"));

console.log("published-address: review-hardened strip + coord edge cases");
// Trailing hyphenated building-unit form (Kamaole Sands style) — the
// canonical streetRootFromAddress misses it (internal hyphen).
check("strips the trailing 'Rd 10-201' building-unit form", stripPublishedUnitTokens("2695 S Kihei Rd 10-201") === "2695 S Kihei Rd");
check("publishedStreetRoot strips it from a full address", publishedStreetRoot("2695 S Kihei Rd 10-201, Kihei, HI 96753") === "2695 S Kihei Rd");
check("hasUnitDesignator flags the trailing hyphenated form", hasUnitDesignator("2695 S Kihei Rd 10-201"));
check("LEADING Hawaii hyphenated house numbers survive", publishedStreetRoot("75-6082 Alii Dr, Kailua-Kona, HI 96740") === "75-6082 Alii Dr");
// Villa is only a unit designator when the next token is unit-shaped —
// real street names must never be mangled into a different street.
check("'100 Villa Del Mar Dr' is left intact", stripPublishedUnitTokens("100 Villa Del Mar Dr") === "100 Villa Del Mar Dr");
check("'70 Venice Villas Ln' is left intact", stripPublishedUnitTokens("70 Venice Villas Ln") === "70 Venice Villas Ln");
check("'Villa 2903' still strips", stripPublishedUnitTokens("1831 Poipu Rd Villa 2903") === "1831 Poipu Rd");
check("'Villa B' still strips", stripPublishedUnitTokens("1831 Poipu Rd Villa B") === "1831 Poipu Rd");
// Null-coordinate coercion (Number(null) === 0 — the Null Island trap).
check("finiteCoord rejects null", finiteCoord(null, 90) === null);
check("finiteCoord rejects out-of-range", finiteCoord(123, 90) === null && finiteCoord(123, 180) === 123);
check("addressLat treats {lat:null} as absent", addressLat({ location: { lat: null, lng: null } }) === null);
check("addressLng falls through null nested to flat", addressLng({ location: { lng: null }, lng: -159.45 }) === -159.45);
{
  const parts = genericPublishedPartsFromPrivateAddress({
    full: "1831 Poipu Rd, Koloa, HI",
    location: { lat: null, lng: null },
  });
  check("null coords never become lat/lng 0 on derived parts", parts != null && parts.lat === undefined && parts.lng === undefined, parts);
  const body = buildGuestyPublishedAddress({ street: "1831 Poipu Rd", lat: 0 as any, lng: 0 as any });
  check("payload builder still accepts a legitimate 0,0-adjacent coord only when finite-in-range", JSON.stringify((body as any).location) === JSON.stringify({ lat: 0, lng: 0 }));
}
check(
  "empty-string full falls through to street in the satisfies compare",
  publishedAddressSatisfiesTarget({ full: "", street: "1831 Poipu Rd", city: "Koloa" }, { street: "1831 Poipu Rd", city: "Koloa" }),
);

console.log("published-address: okina 400-retry fold (live Na Hale O Keauhou class)");
{
  const body = {
    address: { full: "78-6833 Ali‘i Dr, Kailua-Kona, HI 96740, USA", street: "78-6833 Ali‘i Drive", location: { lat: 19.57, lng: -155.96 } },
    publishedAddress: { full: "78-6833 Alii Dr, Kailua-Kona, HI 96740", street: "78-6833 Alii Dr" },
    isPublishedAddressEnabled: true,
  };
  check("non-ASCII detector fires on the okina body", hasNonAsciiAddressChars(body));
  check("non-ASCII detector quiet on clean bodies", !hasNonAsciiAddressChars({ address: { full: "1831 Poipu Rd" } }));
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[ʻʼ‘’']/g, "");
  const folded = foldAddressObjectStrings(body, fold) as typeof body;
  check("fold drops the okina from every string field", folded.address.full.startsWith("78-6833 Alii Dr") && folded.address.street === "78-6833 Alii Drive");
  check("fold leaves numbers + booleans untouched", folded.address.location.lat === 19.57 && folded.isPublishedAddressEnabled === true);
  check("fold does not mutate the original", body.address.street === "78-6833 Ali‘i Drive");
}
check(
  "flat lat/lng (listing-document shape) is read too",
  genericPublishedPartsFromPrivateAddress({ full: "1831 Poipu Rd, Koloa, HI", lat: 1, lng: 2 })?.lat === 1,
);

console.log("published-address: PUT payload builder is structurally unit-free");
{
  const body = buildGuestyPublishedAddress({
    street: "1831 Poipu Rd",
    city: "Koloa",
    state: "HI",
    zipcode: "96756",
    country: "United States",
    lat: 21.88,
    lng: -159.45,
  });
  check("full is composed from the parts", body.full === "1831 Poipu Rd, Koloa, HI 96756, United States", body.full);
  check("street/city/state/zip/country present", body.street === "1831 Poipu Rd" && body.city === "Koloa" && body.state === "HI" && body.zipcode === "96756");
  check("location nested {lat,lng}", JSON.stringify(body.location) === JSON.stringify({ lat: 21.88, lng: -159.45 }));
  const forbidden = ["unitNumber", "apartment", "floor", "buildingName"];
  check("NEVER emits unit designator keys", forbidden.every((k) => !(k in body)), Object.keys(body));
}
{
  const body = buildGuestyPublishedAddress({ street: "1831 Poipu Rd", city: "Koloa" });
  check("location omitted without finite coords", !("location" in body));
  check("optional parts omitted when absent", !("state" in body) && !("zipcode" in body) && !("country" in body));
  check("minimal full composes street + city", body.full === "1831 Poipu Rd, Koloa");
}
check("composePublishedFull skips empty parts", composePublishedFull({ street: "10 Main St" }) === "10 Main St");

console.log("published-address: idempotence compare");
{
  const target = { street: "1831 Poipu Rd", city: "Koloa" };
  check("exact match satisfies", publishedAddressSatisfiesTarget({ full: "1831 Poipu Rd, Koloa, HI 96756" }, target));
  check(
    "suffix abbreviation + case tolerated (Road vs Rd)",
    publishedAddressSatisfiesTarget({ full: "1831 POIPU ROAD, Koloa, HI" }, target),
  );
  check(
    "current published address that still carries a unit does NOT satisfy",
    // streetRootFromAddress strips the unit before comparing, so guard via city:
    // a unit-only difference on the same street root is treated as satisfied —
    // the published display is the same generic street either way.
    publishedAddressSatisfiesTarget({ full: "1831 Poipu Rd Unit 423, Koloa, HI" }, target) === true,
  );
  check("different street rejects", !publishedAddressSatisfiesTarget({ full: "2253 Poipu Rd, Koloa, HI" }, target));
  check("different city rejects", !publishedAddressSatisfiesTarget({ full: "1831 Poipu Rd", city: "Lihue" }, target));
  check("missing current city still satisfies on street match", publishedAddressSatisfiesTarget({ full: "1831 Poipu Rd" }, target));
  check("empty/streetless current never satisfies", !publishedAddressSatisfiesTarget({ full: "Koloa, HI" }, target));
  check("null current never satisfies", !publishedAddressSatisfiesTarget(null, target));
}

console.log("published-address: resolution-cache store");
{
  const store: PublishedAddressStore = { version: 1, properties: {} };
  store.properties["4"] = {
    street: "1831 Poipu Rd",
    city: "Koloa",
    state: "HI",
    source: "clubhouse",
    label: "Poipu Kai Resort Clubhouse",
    resolvedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    lat: 21.88,
    lng: -159.45,
  };
  const roundTrip = parsePublishedAddressStore(serializePublishedAddressStore(store));
  const e = roundTrip.properties["4"];
  check("round-trips an entry", e?.street === "1831 Poipu Rd" && e?.source === "clubhouse" && e?.lat === 21.88);
  check("parse fail-softs on junk", Object.keys(parsePublishedAddressStore("{nope").properties).length === 0);
  check("parse drops streetless entries", Object.keys(parsePublishedAddressStore(JSON.stringify({ version: 1, properties: { x: { city: "Koloa" } } })).properties).length === 0);
  check(
    "unknown source coerces to community",
    parsePublishedAddressStore(JSON.stringify({ version: 1, properties: { x: { street: "10 Main St", source: "wat" } } })).properties["x"]?.source === "community",
  );
  const big: PublishedAddressStore = { version: 1, properties: {} };
  for (let i = 0; i < PUBLISHED_ADDRESS_CACHE_CAP + 25; i++) {
    big.properties[String(i)] = {
      street: `${i + 1} Main St`,
      source: "community",
      label: "main building address",
      resolvedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    };
  }
  const capped = parsePublishedAddressStore(serializePublishedAddressStore(big));
  check("serialize LRU-evicts past the cap", Object.keys(capped.properties).length === PUBLISHED_ADDRESS_CACHE_CAP);
  check("eviction drops the OLDEST entries", !capped.properties["0"] && !!capped.properties[String(PUBLISHED_ADDRESS_CACHE_CAP + 24)]);
}

console.log("published-address: clubhouse discovery pieces");
{
  const queries = clubhouseDiscoveryQueries("Poipu Kai", "Koloa", "HI");
  check("clubhouse queries lead with name+clubhouse+city+state", queries[0] === "Poipu Kai clubhouse Koloa HI", queries);
  check("includes a city-less fallback", queries.includes("Poipu Kai clubhouse HI"));
  check("empty name → no queries", clubhouseDiscoveryQueries("", "Koloa", "HI").length === 0);
  check("hint regex matches clubhouse/front desk/office titles", CLUBHOUSE_TITLE_HINT_RE.test("Poipu Kai Resort Clubhouse") && CLUBHOUSE_TITLE_HINT_RE.test("Front Desk — Poipu Kai") && !CLUBHOUSE_TITLE_HINT_RE.test("Poipu Kai Resort"));
}
{
  const candidates = [
    // Sibling resort with a clubhouse title — must be rejected by the token gate.
    { title: "Poipu Sands Clubhouse", address: "1613 Pee Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.87, longitude: -159.44 } },
    // The resort's generic pin (no clubhouse hint) with a usable street.
    { title: "Poipu Kai Resort", address: "1941 Poipu Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.883, longitude: -159.451 } },
    // The real clubhouse POI, later in relevance order.
    { title: "Poipu Kai Resort Clubhouse", address: "2827 Poipu Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.884, longitude: -159.452 } },
  ];
  const hit = selectClubhouseCandidate(candidates as any, "Poipu Kai", "Poipu Kai clubhouse Koloa HI");
  check("clubhouse-hinted title wins over the earlier generic pin", hit?.street === "2827 Poipu Rd", hit);
  check("carries coordinates", hit?.lat === 21.884 && hit?.lng === -159.452);
  const noHint = selectClubhouseCandidate(
    [{ title: "Poipu Kai Resort", address: "1941 Poipu Rd, Koloa, HI 96756" }] as any,
    "Poipu Kai",
    "q",
  );
  check("generic resort pin still acceptable when no clubhouse POI exists", noHint?.street === "1941 Poipu Rd");
  const siblingOnly = selectClubhouseCandidate(
    [{ title: "Poipu Sands Clubhouse", address: "1613 Pee Rd, Koloa, HI" }] as any,
    "Poipu Kai",
    "q",
  );
  check("sibling resort clubhouse rejected by the whole-word title gate", siblingOnly === null);
  const streetless = selectClubhouseCandidate(
    [{ title: "Poipu Kai Clubhouse", address: "Koloa, HI 96756" }] as any,
    "Poipu Kai",
    "q",
  );
  check("streetless clubhouse POI rejected (coords rescue handles it upstream)", streetless === null);
  // A PM/realty storefront NAMED after the resort must never win the hint
  // pass — and an off-site hint candidate (different street, far coords)
  // loses to the resort's own rank-1 pin.
  const pmStorefront = selectClubhouseCandidate(
    [
      { title: "Poipu Kai Resort", address: "1941 Poipu Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.883, longitude: -159.451 } },
      { title: "Poipu Kai Vacation Rentals Office", address: "5356 Koloa Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.906, longitude: -159.47 } },
    ] as any,
    "Poipu Kai",
    "q",
  );
  check("resort-named PM storefront loses to the rank-1 resort pin", pmStorefront?.street === "1941 Poipu Rd", pmStorefront);
  const offsiteOffice = selectClubhouseCandidate(
    [
      { title: "Poipu Kai Resort", address: "1941 Poipu Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.883, longitude: -159.451 } },
      { title: "Poipu Kai Office", address: "5356 Koloa Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.999, longitude: -159.6 } },
    ] as any,
    "Poipu Kai",
    "q",
  );
  check("off-site hint candidate (far coords, different street) loses to the resort pin", offsiteOffice?.street === "1941 Poipu Rd", offsiteOffice);
  const onSiteFrontDesk = selectClubhouseCandidate(
    [
      { title: "Poipu Kai Resort", address: "1941 Poipu Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.883, longitude: -159.451 } },
      { title: "Poipu Kai Front Desk", address: "1941 Poipu Rd, Koloa, HI 96756", gps_coordinates: { latitude: 21.8831, longitude: -159.4511 } },
    ] as any,
    "Poipu Kai",
    "q",
  );
  check("on-site front desk (same street root) still wins over the generic pin", onSiteFrontDesk?.matchedTitle === "Poipu Kai Front Desk", onSiteFrontDesk);
}

console.log("published-address: ledger kind + summary wording lock");
check("GUESTY_PUSH_TABS includes published-address", (GUESTY_PUSH_TABS as readonly string[]).includes("published-address"));
check("isGuestyPushTab accepts it", isGuestyPushTab("published-address"));
check(
  "summary wording — clubhouse",
  summarizePublishedAddressPush("2827 Poipu Rd", "clubhouse") === "Published address pushed (2827 Poipu Rd · clubhouse)",
);
check(
  "summary wording — main building",
  summarizePublishedAddressPush("1831 Poipu Rd", "community") === "Published address pushed (1831 Poipu Rd · main building)",
);

console.log("published-address: source guards (wiring seams)");
{
  const routesSrc = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const engineSrc = readFileSync(new URL("../server/published-address.ts", import.meta.url), "utf8");
  const sweepSrc = readFileSync(new URL("../server/unit-audit-sweep.ts", import.meta.url), "utf8");
  const clientSrc = readFileSync(new URL("../client/src/components/GuestyListingBuilder/index.tsx", import.meta.url), "utf8");
  const discoverySrc = readFileSync(new URL("../server/community-address-discovery.ts", import.meta.url), "utf8");

  // Engine: the Address-controller contract — GET first, echo the private
  // address, PUT all three keys, verify by read-back. Don't let a refactor
  // "simplify" to PUT /listings/{id} (which doesn't accept publishedAddress).
  check("engine PUTs /address/{id}/update", engineSrc.includes("`/address/${addressEntityId}/update`"));
  check("engine sends isPublishedAddressEnabled: true", engineSrc.includes("isPublishedAddressEnabled: true"));
  check("engine echoes the private address verbatim", engineSrc.includes("address: privateEcho"));
  check("engine never PUTs publishedAddress to /listings/", !/guestyRequest\(\s*"PUT",\s*`\/listings\/[^`]*`,\s*putBody/.test(engineSrc));
  check("engine verifies via read-back GET /address", engineSrc.includes("parseAddressEntity(await guestyGetWithRetry(`/address/${addressEntityId}`))"));
  check("engine stamps the published-address ledger kind", engineSrc.includes('recordGuestyPush(listingId, "published-address", "success"'));
  check("ensure hooks honor the kill switch", engineSrc.includes('PUBLISHED_ADDRESS_AUTO_PUSH_DISABLED'));

  // Routes: manual button endpoint + admin backfill + the success hook on
  // push-descriptions + all five mapping-birth seams + the combo pre-resolve.
  check("manual route exists", routesSrc.includes('app.post("/api/builder/push-published-address"'));
  check("admin backfill route exists", routesSrc.includes('app.post("/api/admin/push-published-addresses"'));
  check("push-descriptions success hook fires", routesSrc.includes('ensurePublishedAddressForListing(listingId, "push-descriptions")'));
  const mappingSeams = [
    'ensurePublishedAddressForMapping(propertyId, guestyListingId.trim(), "guesty-property-map")',
    'ensurePublishedAddressForMapping(propertyId, guestyListingId, "schedule-sync")',
    'ensurePublishedAddressForMapping(propertyId, guestyListingId, "sync-now")',
    'ensurePublishedAddressForMapping(requestedPropertyId, guestyListingId, "guesty-import")',
    'ensurePublishedAddressForMapping(-draft.id, guestyListingId, "guesty-import-create")',
  ];
  for (const seam of mappingSeams) {
    check(`mapping seam wired: ${seam.slice(seam.lastIndexOf('"', seam.length - 3) + 0, seam.length - 1) || seam}`, routesSrc.includes(seam), seam);
  }
  check("combo pipeline pre-resolves the published address", routesSrc.includes("preResolvePublishedAddressForProperty(-draftId)"));

  // Audit sweep: the descriptions stage ensures the feature per audit.
  check("audit sweep calls the engine", sweepSrc.includes("pushPublishedAddressForListing({"));
  check("audit sweep reason is unit-audit", sweepSrc.includes('reason: "unit-audit"'));
  check("audit sweep kill switch", sweepSrc.includes('AUDIT_PUBLISHED_ADDRESS !== "0"'));
  check("audit failure line is rail-A retryable", sweepSrc.includes("`Auto-fix failed: separate published address — ${publishedAddressIssue}`"));

  // Client: the Descriptions-tab button + POST + durable timestamp line.
  check("client button testid", clientSrc.includes('data-testid="btn-push-published-address"'));
  check("client POSTs the manual route", clientSrc.includes('fetch("/api/builder/push-published-address"'));
  check("client timestamp line reads the durable ledger", clientSrc.includes('serverPushHistory["published-address"]'));
  check("client timestamp testid", clientSrc.includes('data-testid="text-published-address-last-push"'));

  // Discovery: clubhouse leg exists with its own kill switch and reuses the
  // whole-word title gate.
  check("clubhouse discovery exported", discoverySrc.includes("export async function discoverCommunityClubhouseAddress"));
  check("clubhouse kill switch", discoverySrc.includes('PUBLISHED_ADDRESS_CLUBHOUSE_DISCOVERY === "0"'));
  check("clubhouse selection uses titleMatchesResort", /selectClubhouseCandidate[\s\S]{0,2400}titleMatchesResort/.test(discoverySrc));

  // Review-hardening locks (2026-07-17 adversarial review):
  // 1. The manual button's force must bypass the in-process clubhouse cache.
  check("clubhouse discovery honors forceRefresh (cache-read bypass)", discoverySrc.includes("input.forceRefresh !== true && clubhouseCache.has(cacheKey)"));
  // 2. A transient discovery failure must never durably cache the generic
  //    fallback (the combo pre-resolve fires mid-bulk-run, 429s are routine).
  check("discovery returns the transient flag", discoverySrc.includes("return { found, transient: !found && anyTransientError }"));
  check("engine skips the durable cache write on transient-degraded resolutions", engineSrc.includes("clubhouseTransient") && engineSrc.includes("definitive"));
  // 3. PM storefronts named after the resort never win the hint pass.
  check("PM storefront negative guard exists", discoverySrc.includes("PM_STOREFRONT_TITLE_RE"));
  // 4. Clubhouse city guard: a parsed "city" that is itself a numbered street
  //    (the "Star Route, 1000 Kamehameha V Hwy, …" maps shape) must lose to
  //    the fallback city.
  check("clubhouse city rejects street-shaped values", engineSrc.includes("!isLikelyStreetAddress(parsedFull.city)"));
  // 5. Operator-wins: non-force hooks never clobber a custom published
  //    address set in Guesty's dashboard.
  check("operator-set published address left in place (non-force)", engineSrc.includes("operator-set published address left in place"));
  // 6. Audit's own loopback delivery suppresses the route hook (no
  //    double-push per audited listing).
  check("audit loopback sends skipPublishedAddressEnsure", sweepSrc.includes("skipPublishedAddressEnsure: true"));
  check("route hook honors skipPublishedAddressEnsure", routesSrc.includes("skipPublishedAddressEnsure !== true"));
  // 7. Admin backfill streams NDJSON (Railway cuts buffered responses at 15m).
  check("admin backfill streams NDJSON", /push-published-addresses[\s\S]{0,2500}application\/x-ndjson/.test(routesSrc));
  // 8. Manual route rejects a coerced propertyId 0 (shared cache-key trap).
  check("manual route propertyId integer-and-nonzero guard", /push-published-address[\s\S]{0,900}Number\.isInteger\(rawPid\) && rawPid !== 0/.test(routesSrc));
  // 9. Client refreshes the ledger line on failure and resets on a listing
  //    switch (stale success banner carried another listing's street).
  check("client resets the panel on listing switch", clientSrc.includes("pubAddrListingRef.current = selectedId"));
  check("client reloads the ledger in the catch path", /catch \(e: any\) \{[\s\S]{0,700}reloadServerPushHistory\(\);[\s\S]{0,400}aborted/.test(clientSrc));
  // 10. Okina 400-retry: the engine retries a 400'd PUT once with folded
  //     diacritics — never on the first attempt (echo-verbatim stays the rule).
  check("engine folds + retries on 400 with non-ASCII", engineSrc.includes("hasNonAsciiAddressChars(putBody)") && engineSrc.includes("foldAddressObjectStrings(putBody, foldHawaiianDiacritics)"));
}

console.log(`\npublished-address: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
