// Operator-verified photo-folder pin — "I looked at these photos, they ARE this
// community." Pure logic only (no fs / DB), browser-safe so client + server can
// compute the identical fingerprint.
//
// POSTURE (load-bearing): the pin is scoped to the EXACT published photo set at
// the moment the operator clicked verify. `photoFolderFingerprint` hashes the
// sorted unique filename list; the moment any photo is added, hidden, or
// replaced the fingerprint stops matching and the pin silently stops applying
// (it is NOT deleted — restoring the same photo set restores it). This is what
// makes a human "these are correct" click safe to persist forever: it can never
// bless photos the operator has not seen.
//
// The pin is PROVENANCE, not an override: the photo-community check uses it to
// upgrade UNCERTAIN votes only — a positive "no" (real mismatch) always wins.

export const PHOTO_FOLDER_VERIFICATIONS_SETTING_KEY = "photo_folder_verifications.v1";

/** Newest pins kept on write; stale folders age out instead of growing forever. */
export const PHOTO_FOLDER_VERIFICATIONS_CAP = 500;

export type PhotoFolderVerification = {
  folder: string;
  /** photoFolderFingerprint() of the published set when the operator verified. */
  fingerprint: string;
  /** ISO timestamp of the operator click. */
  verifiedAt: string;
};

// Same prototype-pollution defense as the unit-audit stores: never let a
// persisted key act as a magic property on a normal object.
const UNSAFE_PIN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Deterministic fingerprint of a folder's published photo set. Pure JS FNV-1a
 * (no node:crypto — browser-safe), order-insensitive, duplicate-insensitive.
 * The length prefix means an accidental hash collision would ALSO need the
 * same photo count to false-match.
 */
export function photoFolderFingerprint(filenames: string[]): string {
  const names = Array.from(
    new Set((Array.isArray(filenames) ? filenames : []).map((f) => String(f ?? "").trim()).filter(Boolean)),
  ).sort();
  const text = names.join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v1:${names.length}:${hash.toString(16).padStart(8, "0")}`;
}

export function parsePhotoFolderVerifications(
  raw: string | null | undefined,
): Record<string, PhotoFolderVerification> {
  const out: Record<string, PhotoFolderVerification> = Object.create(null);
  if (!raw) return out;
  try {
    const doc: unknown = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
    for (const key of Object.keys(doc as Record<string, unknown>)) {
      if (UNSAFE_PIN_KEYS.has(key)) continue;
      const row = (doc as Record<string, unknown>)[key];
      if (!row || typeof row !== "object") continue;
      const fingerprint = String((row as any).fingerprint ?? "").trim();
      const verifiedAt = String((row as any).verifiedAt ?? "").trim();
      if (!fingerprint || !verifiedAt) continue;
      out[key] = { folder: key, fingerprint, verifiedAt };
    }
  } catch {
    // Fail-soft: an unreadable store reads as "no pins", never a crash.
  }
  return out;
}

export function serializePhotoFolderVerifications(
  map: Record<string, PhotoFolderVerification>,
): string {
  const rows = Object.keys(map)
    .filter((k) => !UNSAFE_PIN_KEYS.has(k))
    .map((k) => map[k])
    .filter((r): r is PhotoFolderVerification => !!r && !!r.fingerprint && !!r.verifiedAt)
    .sort((a, b) => (a.verifiedAt < b.verifiedAt ? 1 : a.verifiedAt > b.verifiedAt ? -1 : 0))
    .slice(0, PHOTO_FOLDER_VERIFICATIONS_CAP);
  const out: Record<string, { fingerprint: string; verifiedAt: string }> = {};
  for (const r of rows) {
    out[r.folder] = { fingerprint: r.fingerprint, verifiedAt: r.verifiedAt };
  }
  return JSON.stringify(out);
}
