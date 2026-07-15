// Per-field "when was this license value created/pulled" ledger for the
// unit-builder Descriptions-tab licenses section (2026-07-15). Before this,
// license values (TMK / GET / TAT / STR / DBPR / TDT) carried no history at
// all — property_compliance_overrides has only a whole-row updatedAt and
// drafts have none — so the operator couldn't tell a fresh county-registry
// pull from a months-old manual entry or a generated sample.
//
// Store shape: app_settings `license_provenance.v1`, keyed by the builder
// propertyId (positive core id OR negative -draftId — the same convention as
// property_amenities / property_description_overrides), one entry per license
// field. Persisting here instead of new columns keeps drafts + core
// properties in ONE place with zero schema churn.
//
// LOAD-BEARING rules (test-locked):
//  • Every entry snapshots the VALUE it was stamped for. The UI renders a
//    stamp only when that snapshot matches the field's current value — a
//    write path that bypasses stamping (e.g. combo-draft creation seeding
//    strPermit) renders honestly as "not recorded" instead of showing a
//    stale stamp for a different value.
//  • A "manual" record whose value is unchanged keeps the existing entry —
//    the requirement-card input persists on EVERY blur, and a no-op blur
//    must not clobber a real "pulled online" stamp with "entered manually".
//  • Pull methods always re-stamp, even for an identical value: a re-pull
//    that confirms the same license IS a fresh online verification and the
//    operator asked for "the last time it was pulled".
//
// Display-only feature: nothing here may ever block or fail a license save.

export const LICENSE_PROVENANCE_FIELDS = [
  "taxMapKey",
  "tatLicense",
  "getLicense",
  "strPermit",
  "dbprLicense",
  "touristTaxAccount",
] as const;
export type LicenseProvenanceField = (typeof LICENSE_PROVENANCE_FIELDS)[number];

export const LICENSE_PROVENANCE_METHODS = ["online-pull", "manual", "sample"] as const;
export type LicenseProvenanceMethod = (typeof LICENSE_PROVENANCE_METHODS)[number];

export type LicenseProvenanceEntry = {
  savedAt: string; // ISO timestamp — SERVER-stamped, never client-supplied
  method: LicenseProvenanceMethod;
  value: string; // snapshot of the saved value (render gate — see above)
  source?: string; // e.g. "County of Maui Approved STRH list"
  sourceUrl?: string;
};

export type LicensePropertyProvenance = Partial<Record<LicenseProvenanceField, LicenseProvenanceEntry>>;

export type LicenseProvenanceStore = {
  version: 1;
  properties: Record<string, { fields: LicensePropertyProvenance; updatedAt: string }>;
};

export const LICENSE_PROVENANCE_PROPERTY_CAP = 300;
export const LICENSE_PROVENANCE_SOURCE_MAX_CHARS = 160;
export const LICENSE_PROVENANCE_URL_MAX_CHARS = 500;
export const LICENSE_PROVENANCE_VALUE_MAX_CHARS = 160;

const isValidIso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(new Date(value).getTime());

export function isLicenseProvenanceField(value: unknown): value is LicenseProvenanceField {
  return typeof value === "string" && (LICENSE_PROVENANCE_FIELDS as readonly string[]).includes(value);
}

export function isLicenseProvenanceMethod(value: unknown): value is LicenseProvenanceMethod {
  return typeof value === "string" && (LICENSE_PROVENANCE_METHODS as readonly string[]).includes(value);
}

const normalizeValueSnapshot = (value: unknown): string => String(value ?? "").trim();

export function sanitizeLicenseProvenanceEntry(value: unknown): LicenseProvenanceEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isValidIso(v.savedAt)) return null;
  if (!isLicenseProvenanceMethod(v.method)) return null;
  const snapshot = normalizeValueSnapshot(v.value).slice(0, LICENSE_PROVENANCE_VALUE_MAX_CHARS);
  if (!snapshot) return null;
  const entry: LicenseProvenanceEntry = {
    savedAt: new Date(v.savedAt as string).toISOString(),
    method: v.method,
    value: snapshot,
  };
  const source = typeof v.source === "string" ? v.source.trim().slice(0, LICENSE_PROVENANCE_SOURCE_MAX_CHARS) : "";
  if (source) entry.source = source;
  const sourceUrl = typeof v.sourceUrl === "string" ? v.sourceUrl.trim().slice(0, LICENSE_PROVENANCE_URL_MAX_CHARS) : "";
  if (/^https?:\/\//i.test(sourceUrl)) entry.sourceUrl = sourceUrl;
  return entry;
}

export function parseLicenseProvenanceStore(raw: string | null | undefined): LicenseProvenanceStore {
  const empty: LicenseProvenanceStore = { version: 1, properties: {} };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<LicenseProvenanceStore> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.properties || typeof parsed.properties !== "object") {
      return empty;
    }
    const properties: LicenseProvenanceStore["properties"] = {};
    for (const [propertyId, rec] of Object.entries(parsed.properties)) {
      if (!propertyId || !rec || typeof rec !== "object") continue;
      const fieldsIn = (rec as { fields?: unknown }).fields;
      if (!fieldsIn || typeof fieldsIn !== "object") continue;
      const fields: LicensePropertyProvenance = {};
      for (const [field, entry] of Object.entries(fieldsIn as Record<string, unknown>)) {
        if (!isLicenseProvenanceField(field)) continue;
        const clean = sanitizeLicenseProvenanceEntry(entry);
        if (clean) fields[field] = clean;
      }
      if (Object.keys(fields).length === 0) continue;
      const updatedAtRaw = (rec as { updatedAt?: unknown }).updatedAt;
      const updatedAt = isValidIso(updatedAtRaw)
        ? new Date(updatedAtRaw).toISOString()
        : new Date(0).toISOString();
      properties[propertyId] = { fields, updatedAt };
    }
    return { version: 1, properties };
  } catch {
    return empty;
  }
}

// Evicts the least-recently-updated properties past the cap at write time so
// the app_settings blob can't grow unbounded.
export function serializeLicenseProvenanceStore(store: LicenseProvenanceStore): string {
  const ids = Object.keys(store.properties);
  if (ids.length > LICENSE_PROVENANCE_PROPERTY_CAP) {
    ids
      .sort((a, b) => (store.properties[b].updatedAt || "").localeCompare(store.properties[a].updatedAt || ""))
      .slice(LICENSE_PROVENANCE_PROPERTY_CAP)
      .forEach((id) => {
        delete store.properties[id];
      });
  }
  return JSON.stringify(store);
}

// Records one field's save. Returns true when the store changed. The manual
// no-op guard lives HERE (not in the route) so every caller inherits it.
export function applyLicenseProvenanceRecord(
  store: LicenseProvenanceStore,
  propertyId: number | string,
  field: LicenseProvenanceField,
  entry: LicenseProvenanceEntry,
  nowIso: string,
): boolean {
  const idNum = Number(propertyId);
  if (!Number.isInteger(idNum) || idNum === 0) return false;
  const id = String(idNum);
  const clean = sanitizeLicenseProvenanceEntry(entry);
  if (!clean) return false;
  const rec = store.properties[id] ?? { fields: {}, updatedAt: nowIso };
  const existing = rec.fields[field];
  // A no-op manual blur (same value) must not overwrite a pull/sample stamp.
  if (clean.method === "manual" && existing && existing.value === clean.value) {
    return false;
  }
  rec.fields[field] = clean;
  rec.updatedAt = nowIso;
  store.properties[id] = rec;
  return true;
}

// Render gate: the stamp only describes the CURRENT value when the snapshot
// matches it (trimmed). Anything else means the value changed through a path
// that didn't stamp — the UI must fall back to "not recorded".
export function licenseProvenanceMatchesValue(
  entry: LicenseProvenanceEntry | null | undefined,
  currentValue: string | null | undefined,
): boolean {
  if (!entry) return false;
  const current = normalizeValueSnapshot(currentValue);
  return current.length > 0 && entry.value === current;
}

// Operator-facing wording — the builder renders these verbatim (test-locked).
export function describeLicenseProvenance(entry: LicenseProvenanceEntry): {
  icon: string;
  label: string;
  tone: "pulled" | "manual" | "sample";
} {
  if (entry.method === "online-pull") return { icon: "🌐", label: "Pulled online", tone: "pulled" };
  if (entry.method === "sample") return { icon: "⚠", label: "Sample generated", tone: "sample" };
  return { icon: "✎", label: "Entered manually", tone: "manual" };
}

// Compact age for the provenance line. Recent saves read as relative time;
// older than 30 days switches to the absolute date (UTC — deterministic
// across the operator's devices and the test runner).
export function formatLicenseProvenanceAge(savedAtIso: string, nowIso: string): string {
  const saved = new Date(savedAtIso).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(saved) || !Number.isFinite(now)) return "";
  const deltaMs = Math.max(0, now - saved);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  const d = new Date(saved);
  return `on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

// ── Client → server provenance payload ───────────────────────────────────────
// The PATCH body's optional `provenance` map carries HOW each field got its
// value; the server owns savedAt + the value snapshot. Client input is a
// trust boundary — unknown fields/methods are dropped, strings are capped.
export type LicenseProvenanceClientPatch = Partial<
  Record<LicenseProvenanceField, { method: LicenseProvenanceMethod; source?: string; sourceUrl?: string }>
>;

export function sanitizeLicenseProvenanceClientPatch(value: unknown): LicenseProvenanceClientPatch {
  const out: LicenseProvenanceClientPatch = {};
  if (!value || typeof value !== "object") return out;
  for (const [field, patch] of Object.entries(value as Record<string, unknown>)) {
    if (!isLicenseProvenanceField(field)) continue;
    if (!patch || typeof patch !== "object") continue;
    const p = patch as Record<string, unknown>;
    if (!isLicenseProvenanceMethod(p.method)) continue;
    const clean: { method: LicenseProvenanceMethod; source?: string; sourceUrl?: string } = { method: p.method };
    const source = typeof p.source === "string" ? p.source.trim().slice(0, LICENSE_PROVENANCE_SOURCE_MAX_CHARS) : "";
    if (source) clean.source = source;
    const sourceUrl = typeof p.sourceUrl === "string" ? p.sourceUrl.trim().slice(0, LICENSE_PROVENANCE_URL_MAX_CHARS) : "";
    if (/^https?:\/\//i.test(sourceUrl)) clean.sourceUrl = sourceUrl;
    out[field] = clean;
  }
  return out;
}
