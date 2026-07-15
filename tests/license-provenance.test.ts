// License provenance ledger — "last time this license was created/pulled"
// (2026-07-15).
//
// Guarantees locked here:
//   1. Store hygiene: parse/serialize round-trip, junk rejection, the
//      property cap eviction, and client-patch sanitization (method enum,
//      capped strings, http(s)-only source URLs).
//   2. Stamp semantics: pull methods ALWAYS re-stamp (a re-pull that
//      confirms the same value is a fresh online verification), while a
//      MANUAL record with an unchanged value keeps the existing entry —
//      the requirement-card input persists on every blur, and a no-op blur
//      must never clobber a real "pulled online" stamp.
//   3. Render gating: a stamp only describes the CURRENT value when its
//      value snapshot matches — values written by non-stamping paths read
//      "not recorded" instead of wearing another value's timestamp.
//   4. Wiring: the compliance GET/PATCH routes return + record provenance,
//      and every builder write path attributes itself (single-field pulls
//      as online-pull with the lookup source, the bulk resolve only for
//      fields it actually changed, samples as sample, blur as manual).
import { readFileSync } from "node:fs";
import {
  applyLicenseProvenanceRecord,
  describeLicenseProvenance,
  formatLicenseProvenanceAge,
  LICENSE_PROVENANCE_PROPERTY_CAP,
  licenseProvenanceMatchesValue,
  parseLicenseProvenanceStore,
  sanitizeLicenseProvenanceClientPatch,
  sanitizeLicenseProvenanceEntry,
  serializeLicenseProvenanceStore,
  type LicenseProvenanceEntry,
  type LicenseProvenanceStore,
} from "../shared/license-provenance";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("license-provenance: store + stamp semantics + wiring");

const NOW = "2026-07-15T20:00:00.000Z";
const entry = (over: Partial<LicenseProvenanceEntry> = {}): LicenseProvenanceEntry => ({
  savedAt: NOW,
  method: "online-pull",
  value: "TA-123-456-7890-01",
  ...over,
});

// ── 1. Entry sanitization ────────────────────────────────────────────────────
{
  check("valid entry passes", sanitizeLicenseProvenanceEntry(entry()) !== null);
  check("missing savedAt rejected", sanitizeLicenseProvenanceEntry({ ...entry(), savedAt: "nope" }) === null);
  check("unknown method rejected", sanitizeLicenseProvenanceEntry({ ...entry(), method: "guessed" }) === null);
  check("empty value rejected", sanitizeLicenseProvenanceEntry({ ...entry(), value: "   " }) === null);
  const withJunkUrl = sanitizeLicenseProvenanceEntry({ ...entry(), sourceUrl: "javascript:alert(1)" });
  check("non-http source URL dropped", withJunkUrl !== null && withJunkUrl.sourceUrl === undefined, withJunkUrl);
  const withUrl = sanitizeLicenseProvenanceEntry({ ...entry(), source: "  Kauai TVR registry  ", sourceUrl: "https://kauai.gov/tvr" });
  check("source trimmed + https URL kept", withUrl?.source === "Kauai TVR registry" && withUrl?.sourceUrl === "https://kauai.gov/tvr", withUrl);
  const longSource = sanitizeLicenseProvenanceEntry({ ...entry(), source: "x".repeat(500) });
  check("source capped at 160 chars", (longSource?.source ?? "").length === 160);
}

// ── 2. Store parse/serialize + cap ───────────────────────────────────────────
{
  check("null raw → empty store", Object.keys(parseLicenseProvenanceStore(null).properties).length === 0);
  check("garbage raw → empty store", Object.keys(parseLicenseProvenanceStore("{not json").properties).length === 0);

  const store: LicenseProvenanceStore = { version: 1, properties: {} };
  applyLicenseProvenanceRecord(store, 32, "getLicense", entry(), NOW);
  applyLicenseProvenanceRecord(store, -46, "strPermit", entry({ value: "STKM20120001", method: "manual" }), NOW);
  const roundTrip = parseLicenseProvenanceStore(serializeLicenseProvenanceStore(store));
  check("round-trip keeps core property entry", roundTrip.properties["32"]?.fields.getLicense?.value === "TA-123-456-7890-01", roundTrip.properties["32"]);
  check("round-trip keeps draft (negative id) entry", roundTrip.properties["-46"]?.fields.strPermit?.method === "manual", roundTrip.properties["-46"]);

  const junky = parseLicenseProvenanceStore(JSON.stringify({
    version: 1,
    properties: {
      "7": { fields: { getLicense: entry(), notAField: entry(), tatLicense: { savedAt: "bad" } }, updatedAt: NOW },
      "8": { fields: {} , updatedAt: NOW },
    },
  }));
  check("unknown fields + invalid entries dropped on parse", Object.keys(junky.properties["7"]?.fields ?? {}).join(",") === "getLicense", junky.properties["7"]);
  check("property with no valid fields dropped", junky.properties["8"] === undefined);

  const big: LicenseProvenanceStore = { version: 1, properties: {} };
  for (let i = 1; i <= LICENSE_PROVENANCE_PROPERTY_CAP + 25; i++) {
    const iso = new Date(Date.parse(NOW) + i * 1000).toISOString();
    applyLicenseProvenanceRecord(big, i, "getLicense", entry({ savedAt: iso }), iso);
  }
  const capped = parseLicenseProvenanceStore(serializeLicenseProvenanceStore(big));
  check("cap evicts least-recently-updated properties", Object.keys(capped.properties).length === LICENSE_PROVENANCE_PROPERTY_CAP);
  check("cap keeps the newest property", capped.properties[String(LICENSE_PROVENANCE_PROPERTY_CAP + 25)] !== undefined);
  check("cap evicts the oldest property", capped.properties["1"] === undefined);
}

// ── 3. Stamp semantics ───────────────────────────────────────────────────────
{
  const store: LicenseProvenanceStore = { version: 1, properties: {} };
  const pullAt = "2026-07-15T10:00:00.000Z";
  applyLicenseProvenanceRecord(store, 5, "tatLicense", entry({ savedAt: pullAt, method: "online-pull", value: "TA-111-222-3333-01" }), pullAt);

  // Manual no-op blur (same value) keeps the pull stamp.
  const noOp = applyLicenseProvenanceRecord(store, 5, "tatLicense", entry({ savedAt: NOW, method: "manual", value: "TA-111-222-3333-01" }), NOW);
  check("manual record with unchanged value is a no-op", noOp === false);
  check("pull stamp survives the no-op blur", store.properties["5"].fields.tatLicense?.method === "online-pull" && store.properties["5"].fields.tatLicense?.savedAt === pullAt, store.properties["5"].fields.tatLicense);

  // Manual edit that CHANGES the value re-stamps as manual.
  applyLicenseProvenanceRecord(store, 5, "tatLicense", entry({ savedAt: NOW, method: "manual", value: "TA-999-888-7777-01" }), NOW);
  check("manual record with changed value re-stamps", store.properties["5"].fields.tatLicense?.method === "manual" && store.properties["5"].fields.tatLicense?.value === "TA-999-888-7777-01");

  // A re-pull returning the SAME value refreshes the timestamp (fresh
  // online verification — the operator asked for "last time pulled").
  applyLicenseProvenanceRecord(store, 5, "getLicense", entry({ savedAt: pullAt, value: "GE-111" }), pullAt);
  applyLicenseProvenanceRecord(store, 5, "getLicense", entry({ savedAt: NOW, value: "GE-111" }), NOW);
  check("re-pull of same value refreshes savedAt", store.properties["5"].fields.getLicense?.savedAt === NOW);

  // Sample over an existing value re-stamps too (it changed the value class).
  applyLicenseProvenanceRecord(store, 5, "strPermit", entry({ savedAt: NOW, method: "sample", value: "STKM20240042" }), NOW);
  check("sample stamps", store.properties["5"].fields.strPermit?.method === "sample");

  check("propertyId 0 rejected", applyLicenseProvenanceRecord(store, 0, "getLicense", entry(), NOW) === false);
  check("non-integer propertyId rejected", applyLicenseProvenanceRecord(store, "abc", "getLicense", entry(), NOW) === false);
}

// ── 4. Render gating + display builders ─────────────────────────────────────
{
  const e = entry({ value: "TVR-2022-014" });
  check("matching value renders", licenseProvenanceMatchesValue(e, "TVR-2022-014") === true);
  check("whitespace-padded current value still matches", licenseProvenanceMatchesValue(e, "  TVR-2022-014  ") === true);
  check("different value never wears the stamp", licenseProvenanceMatchesValue(e, "TVR-2023-999") === false);
  check("empty current value never matches", licenseProvenanceMatchesValue(e, "") === false);
  check("missing entry never matches", licenseProvenanceMatchesValue(null, "TVR-2022-014") === false);

  check("online-pull wording", describeLicenseProvenance(entry()).label === "Pulled online");
  check("manual wording", describeLicenseProvenance(entry({ method: "manual" })).label === "Entered manually");
  check("sample wording", describeLicenseProvenance(entry({ method: "sample" })).label === "Sample generated");
  check("sample tone is amber-class", describeLicenseProvenance(entry({ method: "sample" })).tone === "sample");

  check("age: just now", formatLicenseProvenanceAge("2026-07-15T19:59:40.000Z", NOW) === "just now");
  check("age: minutes", formatLicenseProvenanceAge("2026-07-15T19:12:00.000Z", NOW) === "48m ago");
  check("age: hours", formatLicenseProvenanceAge("2026-07-15T14:00:00.000Z", NOW) === "6h ago");
  check("age: days", formatLicenseProvenanceAge("2026-07-12T20:00:00.000Z", NOW) === "3d ago");
  check("age: >30d switches to absolute date", formatLicenseProvenanceAge("2026-05-01T00:00:00.000Z", NOW) === "on May 1, 2026");
  check("age: future/garbage clamps safely", formatLicenseProvenanceAge("2027-01-01T00:00:00.000Z", NOW) === "just now" && formatLicenseProvenanceAge("bad", NOW) === "");
}

// ── 5. Client patch sanitization ─────────────────────────────────────────────
{
  const clean = sanitizeLicenseProvenanceClientPatch({
    getLicense: { method: "online-pull", source: " Guesty listing compliance fields ", sourceUrl: "https://x.test/a" },
    strPermit: { method: "invented" },
    notAField: { method: "manual" },
    tatLicense: "not-an-object",
  });
  check("valid field kept with trimmed source", clean.getLicense?.method === "online-pull" && clean.getLicense?.source === "Guesty listing compliance fields");
  check("invalid method dropped", clean.strPermit === undefined);
  check("unknown field dropped", (clean as Record<string, unknown>).notAField === undefined);
  check("non-object patch dropped", clean.tatLicense === undefined);
  check("non-object input → empty patch", Object.keys(sanitizeLicenseProvenanceClientPatch("junk")).length === 0);
}

// ── 6. Wiring source guards ──────────────────────────────────────────────────
{
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  check("compliance PATCH records provenance", /recordLicenseProvenance\(propertyId, patches\)/.test(routes));
  check("compliance routes return provenance", (routes.match(/provenance: await getLicenseProvenance\(propertyId\)/g) ?? []).length >= 4);
  check("client provenance sanitized server-side", routes.includes("sanitizeLicenseProvenanceClientPatch(body.provenance)"));
  check("unattributed saves default to manual", routes.includes('{ method: "manual" as const }'));

  const serverStore = readFileSync(new URL("../server/license-provenance.ts", import.meta.url), "utf8");
  check("server store uses the promise-tail pattern", serverStore.includes("storeTail = storeTail.then") && serverStore.includes("license_provenance.v1"));
  check("server stamps savedAt with server time", serverStore.includes("savedAt: nowIso"));

  // Server-side pull persistence (2026-07-15): the pull must complete +
  // stamp even when the operator leaves the tab mid-lookup — the client
  // fetch dies with the tab, so the LOOKUP ROUTE owns the save.
  check("single-field lookups persist server-side on persist=1", routes.includes('String(req.query.persist ?? "") === "1"') && routes.includes("persistPulledComplianceValues(req.query.propertyId, { [field]: result.value }"));
  check("tmk lookup persists server-side on persist=1", routes.includes("persistPulledComplianceValues(req.query.propertyId, { taxMapKey: String(payload.taxMapKey) }"));
  check("bulk resolve persists server-side on persist", routes.includes('body.persist === true || body.persist === 1 || body.persist === "1"') && routes.includes("persistPulledComplianceValues(body.propertyId, {"));
  check("server-side pull persist refuses placeholders", routes.includes("if (!text || isPlaceholderLicenseValue(text)) continue;"));
  check("server-side pull persist only stamps attributed fields", routes.includes("if (attribution) stamps[field as LicenseProvenanceField] = { ...attribution, value };"));
  check("bulk resolve attributes only lookup-filled fields", routes.includes("if (!resolvedTaxMapKeyValue && publicLookup.taxMapKey) lookupAttributions.taxMapKey = hawaiiAttribution;"));

  // Guesty rate-limit patience (2026-07-15, same day): the compliance
  // listing read queues behind guesty-sync's global gate (up-to-120s pause
  // after a 429), so it must wait out a full pause on its ONE queued
  // request, and a Guesty read failure must FALL THROUGH to the
  // registry/public legs instead of aborting the lookup.
  check("compliance Guesty read uses the patient window", routes.includes("COMPLIANCE_GUESTY_PATIENT_TIMEOUT_MS = 150_000") && routes.includes("COMPLIANCE_GUESTY_PATIENT_TIMEOUT_MS,\n    );"));
  const hawaiiLookup = readFileSync(new URL("../server/hawaii-compliance-lookup.ts", import.meta.url), "utf8");
  check("Guesty read failure falls through to registry/public sources", hawaiiLookup.includes("guestyFetchError = e?.message ?? String(e);") && hawaiiLookup.includes("falling through to registry/public sources"));
  check("no-value error stays honest about the skipped Guesty source", hawaiiLookup.includes("The Guesty listing itself could not be read:"));

  const builder = readFileSync(new URL("../client/src/components/GuestyListingBuilder/index.tsx", import.meta.url), "utf8");
  check("client pull wait widened past the old 28s", builder.includes("COMPLIANCE_FETCH_TIMEOUT_MS = 45_000"));
  check("client pull requests ask the server to persist", (builder.match(/params\.set\("persist", "1"\)/g) ?? []).length >= 2 && builder.includes("persist: true,"));
  check("client skips its own PATCH when the server persisted", (builder.match(/if \(data\.persisted\) \{/g) ?? []).length >= 3);
  check("returning to the tab re-reads compliance values + provenance", builder.includes("reloadComplianceValues") && builder.includes('document.addEventListener("visibilitychange", maybeReload)'));
  check("focus refresh merges (never clobbers unsaved edits)", builder.includes("setComplianceOverrides((prev) => ({ ...prev, ...loaded }))"));
  check("builder renders the provenance line on summary boxes", (builder.match(/renderLicenseProvenance\(complianceSummaryFields\.title\d, complianceSummaryValues\.title\d, "summary"\)/g) ?? []).length === 4);
  check("builder renders the provenance line on requirement cards", builder.includes('renderLicenseProvenance(req.key as LicenseProvenanceField, value, "card")'));
  check("unrecorded values read honestly", builder.includes("Last pull not recorded"));
  check("single-field pulls attribute online-pull with the lookup source", builder.includes('void persistComplianceValues({ [options.field]: value }, {') && builder.includes('method: "online-pull"'));
  check("sample generation attributes sample", builder.includes('{ [req.key]: { method: "sample" } } as LicenseProvenanceClientPatch'));
  check("manual blur attributes manual", builder.includes('{ [req.key]: { method: "manual" } } as LicenseProvenanceClientPatch'));
  check("bulk resolve only stamps fields it changed", builder.includes("returned && returned !== sentValues[field]"));
  check("compliance persist goes through the single stamping seam", builder.includes("`/api/builder/compliance/${propertyId}`") && !builder.includes("`/api/community/${Math.abs(propertyId)}`"));
  check("stamps hydrate with the compliance GET", builder.includes("setComplianceProvenance(data.provenance as LicensePropertyProvenance)"));
}

console.log(`license-provenance: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
