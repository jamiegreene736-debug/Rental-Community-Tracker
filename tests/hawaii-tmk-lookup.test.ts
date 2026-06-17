// Big Island / Maui / Oahu TMK lookup via the State of Hawaii Statewide GIS
// parcel layer (2026-06-17).
//
// Before this, only Kauai had an authoritative TMK source; every other Hawaii
// county fell through to public OTA snippet scraping, so Big Island resorts like
// Waikoloa Beach Villas returned "can't find any" TMK. lookupHawaiiStatewideTmkFromAddress
// geocodes the address and point-queries the "Statewide TMKs" layer, returning the
// master-parcel TMK in the same shape the tmk-lookup route already serves for Kauai.
//
// These tests mock global.fetch so they run offline and lock:
//   - the happy path parses tmk_txt + qpub_link + island label into a master-parcel result
//   - an empty parcel response throws the 404-mapped "No Hawaii parcel TMK found" message
//   - a failed geocode throws the shared "No geocoded Hawaii address found" message
import { lookupHawaiiStatewideTmkFromAddress } from "../server/hawaii-compliance-lookup";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const realFetch = global.fetch;
type FetchResponder = (url: string) => { ok: boolean; status?: number; body: unknown };
const installFetch = (responder: FetchResponder) => {
  global.fetch = (async (input: any) => {
    const url = String(input);
    const r = responder(url);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
    } as any;
  }) as any;
};

const GEOCODE_OK = {
  candidates: [{
    address: "69-180 Waikoloa Beach Dr, Waikoloa, Hawaii, 96738",
    score: 100,
    location: { x: -155.876654, y: 19.915576 },
  }],
};
const PARCEL_OK = {
  features: [{
    attributes: {
      tmk_txt: "369008014",
      cty_tmk: "69008014",
      county: "Hawaii",
      island: "HAW",
      qpub_link: "https://qpublic.schneidercorp.com/Application.aspx?AppID=1048&KeyValue=690080140000",
    },
  }],
};

console.log("hawaii-tmk-lookup: statewide GIS TMK lookup (Big Island / Maui / Oahu)");

(async () => {
  // Happy path — Waikoloa Beach Villas resolves a master-parcel TMK.
  installFetch((url) =>
    url.includes("geocode") ? { ok: true, body: GEOCODE_OK } : { ok: true, body: PARCEL_OK });
  const result = await lookupHawaiiStatewideTmkFromAddress("69-180 Waikoloa Beach Dr, Waikoloa, HI");
  check("returns the statewide master-parcel TMK (12-digit)", result.taxMapKey === "369008014000", result.taxMapKey);
  check("confidence is master-parcel", result.confidence === "master-parcel", result.confidence);
  check("note names the Big Island", /Big Island/.test(result.note), result.note);
  check("sourceUrl is the qPublic record link", result.sourceUrl?.includes("qpublic"), result.sourceUrl);
  check("geocodedAddress is carried through", /Waikoloa Beach Dr/.test(result.geocodedAddress), result.geocodedAddress);

  // Empty parcel response → 404-mapped error.
  installFetch((url) =>
    url.includes("geocode") ? { ok: true, body: GEOCODE_OK } : { ok: true, body: { features: [] } });
  let threwNoTmk = false;
  try { await lookupHawaiiStatewideTmkFromAddress("Nowhere Rd, HI"); }
  catch (e: any) { threwNoTmk = /No Hawaii parcel TMK found/.test(e?.message ?? ""); }
  check("empty parcels → 'No Hawaii parcel TMK found'", threwNoTmk);

  // Geocode miss → shared 404-mapped error.
  installFetch(() => ({ ok: true, body: { candidates: [] } }));
  let threwNoGeo = false;
  try { await lookupHawaiiStatewideTmkFromAddress("Gibberish, HI"); }
  catch (e: any) { threwNoGeo = /No geocoded Hawaii address found/.test(e?.message ?? ""); }
  check("geocode miss → 'No geocoded Hawaii address found'", threwNoGeo);

  global.fetch = realFetch;
  console.log(`hawaii-tmk-lookup: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
