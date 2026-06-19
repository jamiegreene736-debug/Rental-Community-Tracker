/** Stable folder/filename key for mapping check verdicts to gallery tiles. */
export function normalizePhotoVerdictKey(folder: string, filename: string): string {
  try {
    const f = decodeURIComponent(folder).trim();
    const n = decodeURIComponent(filename).trim();
    return `${f}/${n}`;
  } catch {
    return `${folder}/${filename}`;
  }
}

export function photoVerdictKeyFromUrl(url: string): string | null {
  try {
    const path = url.startsWith("/") ? url : new URL(url, "http://local").pathname;
    const m = path.match(/^\/photos\/([^/?#]+)\/([^/?#]+)$/);
    if (!m) return null;
    return normalizePhotoVerdictKey(m[1], m[2]);
  } catch {
    return null;
  }
}
