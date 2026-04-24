// Helpers shared by client and server for reasoning about a photo
// folder name. The photo-listing scanner uses these to decide which
// folders are scannable; the dashboard aggregation uses the same rule
// so the Photo Match column doesn't pretend to await a scan that
// won't ever run.

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

// True when the folder is meaningfully scannable — i.e. has a unit
// hint we can cross-validate. False for community-* and any folder
// whose unit identifier is a placeholder. Keep this as the single
// rule both sides use to decide whether a folder belongs in the scan
// universe at all.
export function isScannableFolder(folder: string): boolean {
  return unitHintFromFolder(folder) !== null;
}
