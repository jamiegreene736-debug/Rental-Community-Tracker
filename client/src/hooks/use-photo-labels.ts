// Fetches Claude-generated photo labels for a set of folders and returns a
// lookup { folder: { filename: label } }. Callers use it to override the
// hardcoded labels in `unit-builder-data.ts` — falling back to the static
// label when the DB has nothing (e.g. before a relabel has run).
//
// Batches fetches by folder and dedupes — safe to call with duplicate
// folders across units. Each folder is queried once per component lifetime.

import { useEffect, useState } from "react";

type LabelMeta = {
  label: string;
  category: string | null;
  confidence?: number | null;
  userLabel?: string | null;
  userCategory?: string | null;
  hidden?: boolean;
};
type FolderLabels = Record<string, LabelMeta>;
type LabelsMap = Record<string, FolderLabels>;

export function usePhotoLabels(folders: readonly string[]): {
  labels: LabelsMap;
  loading: boolean;
  /**
   * Effective caption — user override wins, else Claude's label. Null when
   * we have no row for that photo at all (pre-rescrape defaults, or photos
   * from folders we didn't request).
   */
  labelFor: (folder: string, filename: string) => string | null;
  /** True when the user marked this photo as hidden in the curator. */
  isHidden: (folder: string, filename: string) => boolean;
} {
  const [labels, setLabels] = useState<LabelsMap>({});
  const [loading, setLoading] = useState(false);

  // Dedupe + sort the folder list into a stable key so the effect only
  // re-runs when the set of folders actually changes, not on every render.
  const sortedUniqueFolders = Array.from(new Set(folders.filter(Boolean))).sort();
  const key = sortedUniqueFolders.join("|");

  useEffect(() => {
    if (sortedUniqueFolders.length === 0) return;
    let cancelled = false;
    setLoading(true);
    Promise.all(
      sortedUniqueFolders.map(async (folder) => {
        try {
          const r = await fetch(`/api/photo-labels/${encodeURIComponent(folder)}`);
          if (!r.ok) return [folder, {}] as const;
          const data = await r.json() as { labels?: FolderLabels };
          return [folder, data.labels ?? {}] as const;
        } catch {
          return [folder, {}] as const;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const next: LabelsMap = {};
      for (const [folder, map] of results) next[folder] = map;
      setLabels(next);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const labelFor = (folder: string, filename: string): string | null => {
    const row = labels[folder]?.[filename];
    if (!row) return null;
    return row.userLabel || row.label || null;
  };
  const isHidden = (folder: string, filename: string): boolean => {
    return !!labels[folder]?.[filename]?.hidden;
  };

  return { labels, loading, labelFor, isHidden };
}
