// Interactive curation grid for the Photos tab.
//
// The prior gallery was read-only — photos flowed straight from the scraper
// + Claude labeler onto the page with no human correction step. Vision
// models misclassify often enough (a living room tagged "Bedroom", a
// kitchen tagged "Lanai") that a hands-on review step is required before
// pushing to Guesty / Airbnb / VRBO / Booking.com.
//
// This component:
//   - Groups photos by *effective* category (user override if set, else the
//     labeler's category), with the expected-per-unit count in each header.
//   - Surfaces low-confidence and missing-category tiles with a ⚠ badge.
//   - Lets you inline-edit a caption, reassign a category, or hide a photo
//     without leaving the builder flow.
//   - Persists every change to /api/photo-labels/:folder/:filename via the
//     new PUT endpoint. Hidden photos are skipped on push.
//
// The URLs flowing in here look like /photos/<folder>/<filename>.jpg — we
// parse folder+filename out of the URL rather than threading extra props
// through the builder, which keeps the integration tiny.

import { useCallback, useEffect, useMemo, useState } from "react";

type PhotoIn = { url: string; caption?: string; source?: string };

type LabelMeta = {
  label: string;
  category: string | null;
  confidence: number | null;
  userLabel: string | null;
  userCategory: string | null;
  hidden: boolean;
};

// Ordered to match the display priority we want on the page: bedrooms
// first, then bathrooms, then shared rooms, outdoor, and the long tail.
const CATEGORIES = [
  "Bedrooms",
  "Bathrooms",
  "Living Areas",
  "Kitchen",
  "Dining",
  "Outdoor & Lanai",
  "Views",
  "Building Exterior",
  "Pool & Spa",
  "Grounds & Landscaping",
  "Common Areas",
  "Beach Access",
  "Activities",
  "Other",
] as const;

type Category = (typeof CATEGORIES)[number];

// Parse "/photos/<folder>/<filename>" out of a URL. Returns null for
// external URLs (Guesty CDN, Zillow CDN, etc.) — those aren't in our DB
// so they can't be edited here.
function parseLocalPath(url: string): { folder: string; filename: string } | null {
  try {
    // Support both absolute ("https://...") and site-relative ("/photos/...")
    const path = url.startsWith("/") ? url : new URL(url).pathname;
    const m = path.match(/^\/photos\/([^/]+)\/([^/?#]+)$/);
    if (!m) return null;
    return { folder: m[1], filename: m[2] };
  } catch {
    return null;
  }
}

function groupPhotosByUnit(photos: PhotoIn[]): Map<string, PhotoIn[]> {
  const out = new Map<string, PhotoIn[]>();
  for (const p of photos) {
    const src = p.source || "Other";
    if (!out.has(src)) out.set(src, []);
    out.get(src)!.push(p);
  }
  return out;
}

export type PhotoCuratorProps = {
  photos: PhotoIn[];
  // Called when the user hides/unhides a photo — lets the parent refresh
  // its internal "photo count" indicators.
  onOverridesChanged?: () => void;
  // Called when the user clicks "Generate Cover Collage" — the parent owns
  // the Canvas + upload flow (restored from commit 106f15a).
  onRequestCoverCollage?: () => void;
  // Whether the cover-collage restore is available (i.e. there's at least
  // one photo + a selected Guesty listing).
  coverCollageEnabled?: boolean;
  // UI-only feedback strings driven by the parent.
  coverCollageStatus?: { phase: "idle" | "generating" | "uploading" | "done" | "error"; error?: string | null; preview?: string | null };
};

export default function PhotoCurator({
  photos,
  onOverridesChanged,
  onRequestCoverCollage,
  coverCollageEnabled,
  coverCollageStatus,
}: PhotoCuratorProps) {
  // folder/filename → metadata loaded from DB
  const [meta, setMeta] = useState<Map<string, LabelMeta>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filterSuspicious, setFilterSuspicious] = useState(false);

  // Extract every local folder we need to load labels for.
  const localFolders = useMemo(() => {
    const set = new Set<string>();
    for (const p of photos) {
      const parsed = parseLocalPath(p.url);
      if (parsed) set.add(parsed.folder);
    }
    return Array.from(set);
  }, [photos]);

  // Fetch labels for each folder.
  useEffect(() => {
    let cancelled = false;
    if (localFolders.length === 0) {
      setMeta(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    Promise.all(
      localFolders.map((folder) =>
        fetch(`/api/photo-labels/${encodeURIComponent(folder)}`)
          .then((r) => r.json().then((j) => ({ folder, ok: r.ok, body: j })))
          .catch((e) => ({ folder, ok: false, body: { error: e.message } })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<string, LabelMeta>();
      const errs: string[] = [];
      for (const r of results) {
        if (!r.ok || !r.body?.labels) { errs.push(`${r.folder}: ${r.body?.error ?? "unknown"}`); continue; }
        for (const [filename, row] of Object.entries(r.body.labels as Record<string, LabelMeta>)) {
          next.set(`${r.folder}/${filename}`, row);
        }
      }
      setMeta(next);
      setLoadError(errs.length > 0 ? errs.join(" · ") : null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [localFolders.join("|")]);  // eslint-disable-line react-hooks/exhaustive-deps

  const patchLabel = useCallback(
    async (folder: string, filename: string, patch: Partial<Pick<LabelMeta, "userLabel" | "userCategory" | "hidden">>) => {
      const key = `${folder}/${filename}`;
      setSavingKey(key);
      try {
        const resp = await fetch(`/api/photo-labels/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error(body?.error || `HTTP ${resp.status}`);
        }
        // Optimistically merge into local state.
        setMeta((prev) => {
          const next = new Map(prev);
          const existing = next.get(key) ?? {
            label: "", category: null, confidence: null,
            userLabel: null, userCategory: null, hidden: false,
          };
          next.set(key, { ...existing, ...patch });
          return next;
        });
        onOverridesChanged?.();
      } catch (e: any) {
        alert(`Save failed: ${e.message}`);
      } finally {
        setSavingKey(null);
      }
    },
    [onOverridesChanged],
  );

  // Build the grouped view. For each (folder, photo), resolve the effective
  // category and caption from the override fallthrough chain.
  type TileData = {
    key: string;
    photo: PhotoIn;
    folder: string | null;
    filename: string | null;
    meta: LabelMeta | null;
    effectiveCategory: string;
    effectiveCaption: string;
    suspicious: boolean;
  };

  const tiles: TileData[] = useMemo(() => {
    return photos.map((p, i) => {
      const parsed = parseLocalPath(p.url);
      const key = parsed ? `${parsed.folder}/${parsed.filename}` : `external/${i}`;
      const m = parsed ? meta.get(key) ?? null : null;
      const effectiveCaption = m?.userLabel ?? m?.label ?? p.caption ?? "";
      const effectiveCategory = m?.userCategory ?? m?.category ?? "Other";
      // Flag a tile as suspicious when:
      //   - labeler confidence is low (<0.70 — the old hard floor)
      //   - OR it ended up in "Other" (either a sanity-check demotion or
      //     the labeler genuinely had no idea)
      //   - OR the user hasn't picked a category and the labeler didn't
      //     assign one either.
      const suspicious = !!m && (
        (m.confidence != null && m.confidence < 0.70) ||
        effectiveCategory === "Other"
      );
      return {
        key,
        photo: p,
        folder: parsed?.folder ?? null,
        filename: parsed?.filename ?? null,
        meta: m,
        effectiveCategory,
        effectiveCaption,
        suspicious,
      };
    });
  }, [photos, meta]);

  // Group tiles by (unit source → category) for the section headers.
  // Units are expected to appear in the same order the photos array
  // presents them.
  const unitOrder: string[] = [];
  const unitMap = new Map<string, TileData[]>();
  for (const t of tiles) {
    const src = t.photo.source || "Other";
    if (!unitMap.has(src)) { unitMap.set(src, []); unitOrder.push(src); }
    unitMap.get(src)!.push(t);
  }

  const byCategory = (items: TileData[]): Map<string, TileData[]> => {
    const m = new Map<string, TileData[]>();
    for (const cat of CATEGORIES) m.set(cat, []);
    for (const t of items) {
      if (t.meta?.hidden && !showHidden) continue;
      if (filterSuspicious && !t.suspicious && !t.meta?.hidden) continue;
      const cat = CATEGORIES.includes(t.effectiveCategory as Category) ? t.effectiveCategory : "Other";
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat)!.push(t);
    }
    return m;
  };

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        padding: "10px 12px", background: "#f9fafb", border: "1px solid #e5e7eb",
        borderRadius: 6, marginBottom: 12, fontSize: 12,
      }}>
        <div style={{ fontWeight: 600, color: "#111827" }}>Photo Curation</div>
        <div style={{ color: "#6b7280" }}>
          {loading ? "Loading labels…" :
            loadError ? `⚠ ${loadError}` :
              `${tiles.length} photos · ${tiles.filter((t) => t.meta?.hidden).length} hidden · ${tiles.filter((t) => t.suspicious && !t.meta?.hidden).length} flagged`}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={filterSuspicious} onChange={(e) => setFilterSuspicious(e.target.checked)} />
            Show only flagged
          </label>
          <label style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden
          </label>
        </div>
      </div>

      {/* Cover collage */}
      {coverCollageEnabled && onRequestCoverCollage && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "8px 12px", background: "#f0f9ff", border: "1px solid #bae6fd",
          borderRadius: 6, marginBottom: 12, fontSize: 12,
        }}>
          <button
            onClick={onRequestCoverCollage}
            disabled={coverCollageStatus?.phase === "generating" || coverCollageStatus?.phase === "uploading"}
            style={{
              padding: "6px 12px", background: "#0369a1", color: "white",
              border: 0, borderRadius: 4, fontSize: 12, fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {coverCollageStatus?.phase === "done" ? "↺ Regenerate Cover Collage" : "🖼 Auto-Set Cover Collage"}
          </button>
          <span style={{ color: "#0369a1" }}>
            Picks the best outdoor + best indoor photo, stitches them into a 2400×1200 cover, uploads to Guesty.
          </span>
          {coverCollageStatus?.phase === "generating" && <span style={{ color: "#2563eb" }}>⏳ Generating…</span>}
          {coverCollageStatus?.phase === "uploading" && <span style={{ color: "#2563eb" }}>⏳ Uploading…</span>}
          {coverCollageStatus?.phase === "done" && <span style={{ color: "#16a34a" }}>✓ Set as cover</span>}
          {coverCollageStatus?.phase === "error" && <span style={{ color: "#dc2626" }}>✗ {coverCollageStatus.error}</span>}
          {coverCollageStatus?.preview && (
            <img src={coverCollageStatus.preview} alt="Cover preview" style={{ height: 36, borderRadius: 3, border: "1px solid #bae6fd" }} />
          )}
        </div>
      )}

      {/* Per-unit category grids */}
      {unitOrder.map((unit) => {
        const unitTiles = unitMap.get(unit) ?? [];
        const byCat = byCategory(unitTiles);
        const hasContent = Array.from(byCat.values()).some((arr) => arr.length > 0);
        if (!hasContent) return null;

        return (
          <div key={unit} style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: "#6b7280",
              textTransform: "uppercase", letterSpacing: "0.05em",
              padding: "10px 0 8px", borderBottom: "2px solid #111827",
              marginBottom: 10,
            }}>
              {unit} — {unitTiles.filter((t) => !t.meta?.hidden).length} visible photo{unitTiles.filter((t) => !t.meta?.hidden).length !== 1 ? "s" : ""}
            </div>

            {CATEGORIES.map((cat) => {
              const items = byCat.get(cat) ?? [];
              if (items.length === 0) return null;
              return (
                <div key={cat} style={{ marginBottom: 12 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: "#111827",
                    padding: "4px 0 4px", marginBottom: 6,
                  }}>
                    {cat} <span style={{ color: "#6b7280", fontWeight: 400 }}>({items.length})</span>
                  </div>
                  <div style={{
                    display: "grid", gap: 8,
                    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                  }}>
                    {items.map((tile) => (
                      <PhotoTile
                        key={tile.key}
                        tile={tile}
                        saving={savingKey === tile.key}
                        onPatch={(patch) => {
                          if (!tile.folder || !tile.filename) return;
                          patchLabel(tile.folder, tile.filename, patch);
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {tiles.length === 0 && !loading && (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280", fontSize: 13 }}>
          No photos to curate yet. Rescrape a unit to populate this view.
        </div>
      )}
    </div>
  );
}

function PhotoTile({
  tile,
  saving,
  onPatch,
}: {
  tile: {
    key: string;
    photo: { url: string; caption?: string; source?: string };
    folder: string | null;
    filename: string | null;
    meta: LabelMeta | null;
    effectiveCategory: string;
    effectiveCaption: string;
    suspicious: boolean;
  };
  saving: boolean;
  onPatch: (patch: Partial<Pick<LabelMeta, "userLabel" | "userCategory" | "hidden">>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftCaption, setDraftCaption] = useState(tile.effectiveCaption);

  useEffect(() => {
    // Reset draft when the underlying caption changes (e.g. rescrape)
    setDraftCaption(tile.effectiveCaption);
  }, [tile.effectiveCaption]);

  const confidence = tile.meta?.confidence ?? null;
  const hasOverride = !!(tile.meta?.userLabel || tile.meta?.userCategory);
  const hidden = !!tile.meta?.hidden;
  const cannotEdit = !tile.folder;  // external (Guesty CDN) photos aren't in our DB

  return (
    <div style={{
      position: "relative",
      border: tile.suspicious ? "2px solid #d97706" : hasOverride ? "2px solid #16a34a" : "1px solid #e5e7eb",
      borderRadius: 6, background: "#fff",
      overflow: "hidden", opacity: hidden ? 0.5 : 1,
    }}>
      <div style={{ position: "relative", aspectRatio: "4/3", background: "#f3f4f6" }}>
        <img
          src={tile.photo.url}
          alt={tile.effectiveCaption}
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        {tile.suspicious && !hidden && (
          <div style={{
            position: "absolute", top: 4, left: 4,
            background: "#d97706", color: "white", fontSize: 10, fontWeight: 600,
            padding: "2px 6px", borderRadius: 3,
          }}>⚠ check</div>
        )}
        {hasOverride && (
          <div style={{
            position: "absolute", top: 4, right: 4,
            background: "#16a34a", color: "white", fontSize: 10, fontWeight: 600,
            padding: "2px 6px", borderRadius: 3,
          }}>edited</div>
        )}
        {hidden && (
          <div style={{
            position: "absolute", inset: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.4)", color: "white",
            fontSize: 12, fontWeight: 600, letterSpacing: "0.05em",
          }}>HIDDEN</div>
        )}
      </div>

      <div style={{ padding: "6px 8px", fontSize: 11, display: "flex", flexDirection: "column", gap: 4 }}>
        {editing && !cannotEdit ? (
          <input
            autoFocus
            value={draftCaption}
            onChange={(e) => setDraftCaption(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draftCaption.trim() !== (tile.effectiveCaption || "")) {
                onPatch({ userLabel: draftCaption.trim() || null });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") { setDraftCaption(tile.effectiveCaption); setEditing(false); }
            }}
            style={{
              fontSize: 11, padding: "4px 6px",
              border: "1px solid #2563eb", borderRadius: 3,
              width: "100%", outline: "none",
            }}
          />
        ) : (
          <div
            onClick={() => !cannotEdit && setEditing(true)}
            title={cannotEdit ? "External photo — not editable" : "Click to edit caption"}
            style={{
              fontWeight: 500, color: "#111827",
              cursor: cannotEdit ? "default" : "text",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {tile.effectiveCaption || <span style={{ color: "#9ca3af" }}>(no caption)</span>}
          </div>
        )}

        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <select
            value={tile.effectiveCategory}
            disabled={cannotEdit || saving}
            onChange={(e) => onPatch({ userCategory: e.target.value === (tile.meta?.category ?? "") ? null : e.target.value })}
            style={{
              fontSize: 10, padding: "2px 4px",
              border: "1px solid #d1d5db", borderRadius: 3,
              flex: 1, minWidth: 0,
            }}
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            disabled={cannotEdit || saving}
            onClick={() => onPatch({ hidden: !hidden })}
            title={hidden ? "Restore to published set" : "Hide from published set"}
            style={{
              fontSize: 10, padding: "2px 6px",
              background: hidden ? "#16a34a" : "#fee2e2",
              color: hidden ? "white" : "#dc2626",
              border: 0, borderRadius: 3, cursor: "pointer", fontWeight: 600,
            }}
          >{hidden ? "restore" : "hide"}</button>
        </div>

        {confidence != null && (
          <div style={{ color: "#9ca3af", fontSize: 10 }}>
            conf {confidence.toFixed(2)}
            {tile.meta?.category && tile.meta.category !== tile.effectiveCategory && (
              <> · was <em>{tile.meta.category}</em></>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
