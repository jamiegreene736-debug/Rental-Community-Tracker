// Helpers shared by client and server for reasoning about a photo
// folder name. The photo-listing scanner uses these to decide which
// folders are scannable; the dashboard aggregation uses the same rule
// so the Photo Match column doesn't pretend to await a scan that
// won't ever run.

import { tokensForFolder } from "./folder-unit-map";

// Pull a unit-number hint from a folder name so we can cross-validate
// Lens results against the candidate listing's page. Returns null when
// no real unit identifier is present — placeholder names ("a", "b",
// "main", "estate", "cottage") and community-* folders all give null,
// because verifying "does airbnb.com/rooms/123 mention 'Unit a'?" has
// no meaningful answer.
//
// Examples:
//   "unit-721"            → "721"
//   "kaha-lani-123"       → "123"
//   "mauna-kai-6a"        → "6a"
//   "kaiulani-52"         → "52"
//   "pili-mai-unit-a"     → null   (placeholder)
//   "kekaha-main"         → null   (no digit)
//   "keauhou-estate"      → null   (no digit)
//   "community-kaha-lani" → null   (no digit)
export function unitHintFromFolder(folder: string): string | null {
  const m = folder.match(/-unit-([a-z0-9]+)$/i);
  if (m && /\d/.test(m[1])) return m[1];
  const tail = folder.split("-").pop() || "";
  if (/^[a-z0-9]{2,}$/i.test(tail) && /\d/.test(tail)) return tail;
  return null;
}

// True when the folder is meaningfully scannable — i.e. we have a
// way to cross-validate Lens hits against a unit identity. Two paths
// qualify:
//   - the folder appears in `FOLDER_UNIT_TOKENS` (preferred — that
//     map carries the canonical claim regardless of folder name)
//   - the folder name itself encodes a digit hint
// Community-* folders and placeholder folders that meet neither
// path return false. Keep this as the single rule both the scanner
// and the dashboard use to decide whether a folder belongs in the
// scan universe at all.
export function isScannableFolder(folder: string): boolean {
  return tokensForFolder(folder) !== null || unitHintFromFolder(folder) !== null;
}

// Returns the list of unit-number tokens the scanner should verify
// against when checking Lens hits for this folder. Prefers the
// hand-maintained FOLDER_UNIT_TOKENS map (the canonical claim) and
// falls back to the folder-name hint for folders the map doesn't
// cover yet. Returns null only when neither source produces a hint —
// i.e. when `isScannableFolder(folder)` is also false.
export function verificationTokensForFolder(folder: string): string[] | null {
  const mapped = tokensForFolder(folder);
  if (mapped && mapped.length > 0) return mapped;
  const hint = unitHintFromFolder(folder);
  return hint ? [hint] : null;
}
