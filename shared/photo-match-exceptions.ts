// Operator-confirmed photo-match exceptions (2026-07-20).
//
// The duplicate-photos warning popup flags OTA listings whose pages matched a
// unit's photos. Some matches are permanent FALSE POSITIVES the operator has
// personally reviewed (a look-alike listing, a legitimately shared gallery, a
// listing we co-manage that Guesty doesn't report as ours). This module is the
// pure side of a per-folder allowlist of listing URLs the operator confirmed
// as "okay — stop warning": the scanner suppresses ONLY these exact listings
// (same seam as the Guesty authorized-URL suppression), so any NEW/different
// listing that surfaces still raises the warning.
//
// Keyed by (photo folder, normalized listing URL) — normalization identical to
// server/authorized-urls.ts so `vrbo.com/p123?x=1` and `www.vrbo.com/p123/`
// collapse to one exception. Store lives in app_settings under
// PHOTO_MATCH_EXCEPTIONS_SETTING_KEY. Keep this module free of Node/DB/React
// imports — server and tests share it.

export const PHOTO_MATCH_EXCEPTIONS_SETTING_KEY = "photo_match_exceptions.v1";

/** Max confirmed listings kept per folder / folders kept overall (LRU-ish by confirmedAt). */
export const MAX_EXCEPTIONS_PER_FOLDER = 40;
export const MAX_EXCEPTION_FOLDERS = 400;

/**
 * Normalize a listing URL for comparison: lowercase host without www, path
 * without extension/trailing slash, no query/fragment. MUST stay identical to
 * server/authorized-urls.ts normalizeListingUrl (which re-exports this).
 */
export function normalizeListingUrlForMatch(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname
    .replace(/\.[a-z0-9.-]+$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!host || !path) return null;
  return `${host}${path}`;
}

export type PhotoMatchException = {
  /** The listing URL as the operator saw it (display). */
  url: string;
  /** normalizeListingUrlForMatch(url) — the comparison key. */
  normalized: string;
  confirmedAt: string;
  /** Optional listing title snapshot for the settings/undo UI. */
  title?: string;
};

export type PhotoMatchExceptionStore = Record<string, PhotoMatchException[]>;

export function parsePhotoMatchExceptions(raw: string | null | undefined): PhotoMatchExceptionStore {
  if (!raw) return Object.create(null);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return Object.create(null);
    const out: PhotoMatchExceptionStore = Object.create(null);
    for (const [folder, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const rows: PhotoMatchException[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const url = String(o.url ?? "").trim();
        const normalized = String(o.normalized ?? "").trim() || normalizeListingUrlForMatch(url) || "";
        if (!url || !normalized) continue;
        rows.push({
          url: url.slice(0, 600),
          normalized: normalized.slice(0, 600),
          confirmedAt: String(o.confirmedAt ?? "").slice(0, 40),
          ...(o.title ? { title: String(o.title).slice(0, 200) } : {}),
        });
      }
      if (rows.length) out[folder] = rows.slice(0, MAX_EXCEPTIONS_PER_FOLDER);
    }
    return out;
  } catch {
    return Object.create(null);
  }
}

export function serializePhotoMatchExceptions(store: PhotoMatchExceptionStore): string {
  // Cap total folders, keeping the most recently confirmed ones.
  const entries = Object.entries(store);
  if (entries.length > MAX_EXCEPTION_FOLDERS) {
    entries.sort((a, b) => {
      const newest = (rows: PhotoMatchException[]) =>
        rows.reduce((m, r) => (r.confirmedAt > m ? r.confirmedAt : m), "");
      return newest(b[1]).localeCompare(newest(a[1]));
    });
    entries.length = MAX_EXCEPTION_FOLDERS;
  }
  return JSON.stringify(Object.fromEntries(entries));
}

/** Add (idempotently, by normalized URL) an operator-confirmed listing. */
export function addPhotoMatchException(
  store: PhotoMatchExceptionStore,
  folder: string,
  url: string,
  now: Date,
  title?: string,
): PhotoMatchException | null {
  const f = String(folder ?? "").trim();
  const normalized = normalizeListingUrlForMatch(url);
  if (!f || !normalized) return null;
  const rows = store[f] ?? (store[f] = []);
  const existing = rows.find((r) => r.normalized === normalized);
  if (existing) return existing;
  const row: PhotoMatchException = {
    url: String(url).trim().slice(0, 600),
    normalized,
    confirmedAt: now.toISOString(),
    ...(title ? { title: String(title).slice(0, 200) } : {}),
  };
  rows.unshift(row);
  if (rows.length > MAX_EXCEPTIONS_PER_FOLDER) rows.length = MAX_EXCEPTIONS_PER_FOLDER;
  return row;
}

/** Remove a confirmed listing (undo). Returns true when something was removed. */
export function removePhotoMatchException(
  store: PhotoMatchExceptionStore,
  folder: string,
  url: string,
): boolean {
  const f = String(folder ?? "").trim();
  const normalized = normalizeListingUrlForMatch(url);
  const rows = store[f];
  if (!rows || !normalized) return false;
  const before = rows.length;
  const next = rows.filter((r) => r.normalized !== normalized);
  if (next.length === before) return false;
  if (next.length) store[f] = next;
  else delete store[f];
  return true;
}

/** The comparison-key set for one folder — what the scanner consults. */
export function exceptionSetForFolder(
  store: PhotoMatchExceptionStore,
  folder: string,
): Set<string> {
  const rows = store[String(folder ?? "").trim()] ?? [];
  return new Set(rows.map((r) => r.normalized));
}

/** Is this candidate URL operator-confirmed for the folder? */
export function isConfirmedMatchUrl(set: Set<string>, url: string | null | undefined): boolean {
  const n = normalizeListingUrlForMatch(url);
  return !!n && set.has(n);
}
