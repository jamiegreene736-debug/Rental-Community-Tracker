// Server side of the license provenance ledger (2026-07-15). Persists in
// app_settings under `license_provenance.v1` via the same serialized
// promise-tail pattern as guesty-push-history / auto-replace-jobs stores.
// Everything here is fail-soft: provenance is display-only, so a storage
// hiccup must never break (or slow down) a license save.
import { storage } from "./storage";
import {
  applyLicenseProvenanceRecord,
  parseLicenseProvenanceStore,
  serializeLicenseProvenanceStore,
  type LicensePropertyProvenance,
  type LicenseProvenanceField,
  type LicenseProvenanceMethod,
  type LicenseProvenanceStore,
} from "@shared/license-provenance";

const LICENSE_PROVENANCE_SETTING_KEY = "license_provenance.v1";

let storeTail: Promise<void> = Promise.resolve();
function mutateStore(mutate: (store: LicenseProvenanceStore, nowIso: string) => void): Promise<void> {
  storeTail = storeTail.then(async () => {
    try {
      const nowIso = new Date().toISOString();
      const raw = await storage.getSetting(LICENSE_PROVENANCE_SETTING_KEY);
      const store = parseLicenseProvenanceStore(raw ?? null);
      mutate(store, nowIso);
      await storage.setSetting(LICENSE_PROVENANCE_SETTING_KEY, serializeLicenseProvenanceStore(store));
    } catch {
      // Fail-soft: the ledger is an upgrade, never a blocker.
    }
  });
  return storeTail;
}

// Fire-and-forget: called inline from the compliance PATCH, must never throw
// or delay the save response. savedAt is stamped HERE with server time —
// client clocks are never trusted for the timestamp.
export function recordLicenseProvenance(
  propertyId: number,
  patches: Partial<
    Record<LicenseProvenanceField, { method: LicenseProvenanceMethod; source?: string; sourceUrl?: string; value: string }>
  >,
): Promise<void> {
  if (!Number.isInteger(propertyId) || propertyId === 0) return Promise.resolve();
  return mutateStore((store, nowIso) => {
    for (const [field, patch] of Object.entries(patches)) {
      if (!patch) continue;
      applyLicenseProvenanceRecord(
        store,
        propertyId,
        field as LicenseProvenanceField,
        {
          savedAt: nowIso,
          method: patch.method,
          value: patch.value,
          source: patch.source,
          sourceUrl: patch.sourceUrl,
        },
        nowIso,
      );
    }
  });
}

export async function getLicenseProvenance(propertyId: number): Promise<LicensePropertyProvenance> {
  try {
    await storeTail; // let in-flight writes land so a just-saved pull shows
    const raw = await storage.getSetting(LICENSE_PROVENANCE_SETTING_KEY);
    const store = parseLicenseProvenanceStore(raw ?? null);
    return store.properties[String(propertyId)]?.fields ?? {};
  } catch {
    return {};
  }
}
