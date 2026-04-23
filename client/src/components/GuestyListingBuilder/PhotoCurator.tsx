// Simplified photo review surface for the Photos tab.
//
// Prior iteration grouped photos by AI-inferred category with a ⚠ flag on
// uncertain tiles — too much UI for a manual-review workflow. The user
// verifies against the source listing (Zillow) directly, so the tiles
// just need to flow in listing order with:
//
//   1. Editable caption (click to edit)
//   2. Delete button (soft-delete via the `hidden` flag)
//   3. Per-unit source link so they can cross-check against the Zillow
//      page when a unit looks short on photos
//   4. A channel-limits banner at the top showing total photo count vs.
//      Airbnb / VRBO / Booking.com maximums with green check / red X
//
// Photos flow in via the builder.tsx assembly step, which already orders
// them as: cover → community-begin → unit A → community-middle → unit B →
// … → community-end. This component renders sections keyed by the `source`
// field each photo carries.

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

// Published maxes per channel. Source: platform help docs as of 2026-04.
// If any channel changes its limit the value gets updated here — the UI
// pulls straight from this map.
const CHANNEL_LIMITS: Array<{ key: string; label: string; max: number }> = [
  { key: "airbnb",  label: "Airbnb",       max: 100 },
  { key: "vrbo",    label: "VRBO",          max: 50 },
  { key: "booking", label: "Booking.com",   max: 30 },
];

function parseLocalPath(url: string): { folder: string; filename: string } | null {
  try {
    const path = url.startsWith("/") ? url : new URL(url).pathname;
    const m = path.match(/^\/photos\/([^/?#]+)\/([^/?#]+)$/);
    if (!m) return null;
    return { folder: m[1], filename: m[2] };
  } catch {
    return null;
  }
}

export type PhotoCuratorProps = {
  photos: PhotoIn[];
  // folder → source URL on Zillow/Airbnb/VRBO. Populated by the parent
  // from each unit's _source.json so we can render a "View on Zillow"
  // link next to each section header. Optional — links just won't
  // render for folders missing a source URL.
  sourceUrlsByFolder?: Record<string, string>;
  onOverridesChanged?: () => void;

  // Cover collage hookup — the canvas + upload pipeline lives in the
  // parent (GuestyListingBuilder), this component renders the banner.
  //
  // `coverCollageEnabled` controls whether the banner RENDERS at all —
  // gate it on having enough photos to pair (>=2). `coverCollageDisabledReason`
  // keeps the banner visible but disables the action button with an
  // inline explanation, used when the Guesty listing isn't selected yet
  // (the push target is unknown). This way the feature is discoverable
  // even before a listing is picked.
  coverCollageEnabled?: boolean;
  coverCollageDisabledReason?: string | null;
  onRequestCoverCollage?: () => void;
  coverCollageStatus?: {
    phase: "idle" | "generating" | "uploading" | "done" | "error";
    error?: string | null;
    preview?: string | null;
    picks?: { community: string; patio: string } | null;
  };
};

export default function PhotoCurator({
  photos,
  sourceUrlsByFolder,
  onOverridesChanged,
  coverCollageEnabled,
  coverCollageDisabledReason,
  onRequestCoverCollage,
  coverCollageStatus,
}: PhotoCuratorProps) {
  const [meta, setMeta] = useState<Map<string, LabelMeta>>(new Map());
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const localFolders = useMemo(() => {
    const set = new Set<string>();
    for (const p of photos) {
      const parsed = parseLocalPath(p.url);
      if (parsed) set.add(parsed.folder);
    }
    return Array.from(set);
  }, [photos]);

  useEffect(() => {
    let cancelled = false;
    if (localFolders.length === 0) {
      setMeta(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(
      localFolders.map((folder) =>
        fetch(`/api/photo-labels/${encodeURIComponent(folder)}`)
          .then((r) => r.json().then((j) => ({ folder, ok: r.ok, body: j })))
          .catch(() => ({ folder, ok: false, body: {} })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<string, LabelMeta>();
      for (const r of results) {
        if (!r.ok || !r.body?.labels) continue;
        for (const [filename, row] of Object.entries(r.body.labels as Record<string, LabelMeta>)) {
          next.set(`${r.folder}/${filename}`, row);
        }
      }
      setMeta(next);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [localFolders.join("|")]);  // eslint-disable-line react-hooks/exhaustive-deps

  const patchLabel = useCallback(
    async (folder: string, filename: string, patch: Partial<Pick<LabelMeta, "userLabel" | "hidden">>) => {
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
          throw new Error((body as any)?.error || `HTTP ${resp.status}`);
        }
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

  // Build the render sections. Each consecutive run of photos with the
  // same `source` becomes one section. Hidden photos are excluded from
  // the displayed count but still render (dimmed) so the user can
  // unhide them.
  type Section = { source: string; photos: Array<PhotoIn & { key: string; folder: string | null; filename: string | null; meta: LabelMeta | null }> };
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const p of photos) {
    const parsed = parseLocalPath(p.url);
    const key = parsed ? `${parsed.folder}/${parsed.filename}` : `ext:${p.url.slice(-80)}`;
    const m = parsed ? meta.get(key) ?? null : null;
    const src = p.source || "Other";
    if (!current || current.source !== src) {
      current = { source: src, photos: [] };
      sections.push(current);
    }
    current.photos.push({
      ...p,
      key,
      folder: parsed?.folder ?? null,
      filename: parsed?.filename ?? null,
      meta: m,
    });
  }

  // Tally visible photos (all sections combined, excluding hidden). The
  // banner at the top compares this against each channel's cap.
  const visibleCount = photos.reduce((acc, p) => {
    const parsed = parseLocalPath(p.url);
    if (!parsed) return acc + 1;  // external photos (Guesty CDN) count as visible
    const m = meta.get(`${parsed.folder}/${parsed.filename}`);
    return m?.hidden ? acc : acc + 1;
  }, 0);

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Channel-limits banner — quick visual check against each
          platform's photo cap. Green ✓ when visibleCount ≤ max, red ✗
          when over. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
        padding: "10px 14px", background: "#f9fafb", border: "1px solid #e5e7eb",
        borderRadius: 6, marginBottom: 14, fontSize: 12,
      }}>
        <div>
          <span style={{ fontWeight: 600, color: "#111827" }}>
            {visibleCount} photo{visibleCount === 1 ? "" : "s"}
          </span>
          <span style={{ color: "#6b7280", marginLeft: 6 }}>total</span>
        </div>
        <div style={{ color: "#d1d5db" }}>|</div>
        {CHANNEL_LIMITS.map((ch) => {
          const ok = visibleCount <= ch.max;
          return (
            <div key={ch.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 18, height: 18, borderRadius: "50%",
                background: ok ? "#dcfce7" : "#fee2e2",
                color: ok ? "#166534" : "#991b1b",
                fontWeight: 700, fontSize: 11,
              }}>{ok ? "✓" : "✗"}</span>
              <span>
                <b>{ch.label}</b>
                <span style={{ color: "#6b7280" }}> · max {ch.max}</span>
                {!ok && (
                  <span style={{ color: "#991b1b", marginLeft: 4 }}>
                    (over by {visibleCount - ch.max})
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {loading && <span style={{ marginLeft: "auto", color: "#9ca3af" }}>Loading labels…</span>}
      </div>

      {/* Cover collage banner — "sell the destination + sell the space"
          pairing: best community shot (resort pool, beach, aerial) on the
          left, best private patio/lanai on the right. Canvas + Guesty
          upload happens in the parent; this surface just renders the
          trigger + status. */}
      {coverCollageEnabled && onRequestCoverCollage && (() => {
        const phase = coverCollageStatus?.phase ?? "idle";
        const busy = phase === "generating" || phase === "uploading";
        const gated = !!coverCollageDisabledReason;
        const disabled = busy || gated;
        const buttonText =
          phase === "done" ? "↺ Regenerate Cover Collage" :
          busy ? (phase === "uploading" ? "⏳ Uploading to Guesty…" : "⏳ Building collage…") :
          "🖼 Auto-Set Cover Collage";
        return (
          <div style={{
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            padding: "10px 14px", background: "#f0f9ff", border: "1px solid #bae6fd",
            borderRadius: 6, marginBottom: 14, fontSize: 12,
          }}>
            <button
              onClick={onRequestCoverCollage}
              disabled={disabled}
              title={gated ? coverCollageDisabledReason! : undefined}
              style={{
                padding: "6px 12px", fontSize: 12, fontWeight: 600,
                background: disabled ? "#93c5fd" : "#0369a1", color: "white",
                border: 0, borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer",
                opacity: gated && !busy ? 0.7 : 1,
              }}
            >{buttonText}</button>
            <span style={{ color: "#075985" }}>
              Picks the best community shot + best private patio/lanai, stitches them into a 2-up cover, and sets it as the Guesty cover photo.
            </span>
            {gated && (
              <span style={{
                flexBasis: "100%", color: "#b45309",
                fontSize: 11, fontWeight: 500,
              }}>⚠ {coverCollageDisabledReason}</span>
            )}
            {coverCollageStatus?.picks && (
              <div style={{ flexBasis: "100%", fontSize: 11, color: "#0369a1" }}>
                Picks: <em>{coverCollageStatus.picks.community}</em> &nbsp;+&nbsp; <em>{coverCollageStatus.picks.patio}</em>
              </div>
            )}
            {phase === "done" && <span style={{ color: "#16a34a", fontWeight: 600 }}>✓ Set as cover on Guesty</span>}
            {phase === "error" && <span style={{ color: "#991b1b" }}>✗ {coverCollageStatus?.error}</span>}
            {coverCollageStatus?.preview && (
              <img
                src={coverCollageStatus.preview}
                alt="Cover collage preview"
                style={{ height: 40, borderRadius: 4, border: "1px solid #bae6fd", marginLeft: "auto" }}
              />
            )}
          </div>
        );
      })()}

      {/* Sections — one block per contiguous run of same-source photos. */}
      {sections.map((section, i) => {
        // All photos in this section should share a folder, but parsed
        // URLs handle the edge case of mixed sources gracefully.
        const firstFolder = section.photos.find((p) => p.folder)?.folder ?? null;
        const sourceUrl = firstFolder ? sourceUrlsByFolder?.[firstFolder] : undefined;
        const sectionVisible = section.photos.filter((p) => !p.meta?.hidden).length;

        return (
          <div key={`${section.source}-${i}`} style={{ marginBottom: 20 }}>
            <div style={{
              display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap",
              padding: "8px 0 6px", borderBottom: "1px solid #e5e7eb", marginBottom: 10,
            }}>
              <div style={{
                fontSize: 12, fontWeight: 600, color: "#6b7280",
                textTransform: "uppercase", letterSpacing: "0.05em",
              }}>
                {section.source} — {sectionVisible} photo{sectionVisible === 1 ? "" : "s"}
              </div>
              {sourceUrl && (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11, color: "#2563eb", textDecoration: "none",
                    padding: "2px 8px", background: "#eff6ff", border: "1px solid #bfdbfe",
                    borderRadius: 3,
                  }}
                  title="Open source listing in a new tab to verify photo coverage"
                >
                  ↗ View source listing
                </a>
              )}
            </div>
            <div style={{
              display: "grid", gap: 8,
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            }}>
              {section.photos.map((tile, tileIdx) => (
                <PhotoTile
                  key={tile.key}
                  tile={tile}
                  index={tileIdx + 1}
                  saving={savingKey === tile.key}
                  onEditCaption={(caption) => {
                    if (!tile.folder || !tile.filename) return;
                    patchLabel(tile.folder, tile.filename, { userLabel: caption.trim() || null });
                  }}
                  onDelete={() => {
                    if (!tile.folder || !tile.filename) return;
                    patchLabel(tile.folder, tile.filename, { hidden: !tile.meta?.hidden });
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}

      {photos.length === 0 && !loading && (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280", fontSize: 13 }}>
          No photos to review. Rescrape a unit to populate this view.
        </div>
      )}
    </div>
  );
}

function PhotoTile({
  tile,
  index,
  saving,
  onEditCaption,
  onDelete,
}: {
  tile: {
    key: string;
    url: string;
    caption?: string;
    folder: string | null;
    filename: string | null;
    meta: LabelMeta | null;
  };
  index: number;
  saving: boolean;
  onEditCaption: (caption: string) => void;
  onDelete: () => void;
}) {
  // Effective caption — user override wins, else labeler output, else
  // whatever the parent passed in (static label fallback), else blank.
  const effectiveCaption = tile.meta?.userLabel ?? tile.meta?.label ?? tile.caption ?? "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(effectiveCaption);
  useEffect(() => { setDraft(effectiveCaption); }, [effectiveCaption]);

  const hidden = !!tile.meta?.hidden;
  const cannotEdit = !tile.folder;

  return (
    <div style={{
      position: "relative",
      border: tile.meta?.userLabel ? "2px solid #16a34a" : "1px solid #e5e7eb",
      borderRadius: 6, background: "#fff",
      overflow: "hidden", opacity: hidden ? 0.4 : 1,
    }}>
      <div style={{ position: "relative", aspectRatio: "4/3", background: "#f3f4f6" }}>
        <img
          src={tile.url}
          alt={effectiveCaption}
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        <div style={{
          position: "absolute", top: 4, left: 4,
          background: "rgba(17,24,39,0.7)", color: "white", fontSize: 10, fontWeight: 600,
          padding: "2px 6px", borderRadius: 3,
        }}>{index}</div>
        {hidden && (
          <div style={{
            position: "absolute", inset: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.5)", color: "white",
            fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
          }}>DELETED</div>
        )}
      </div>

      <div style={{ padding: "6px 8px", fontSize: 11, display: "flex", flexDirection: "column", gap: 4 }}>
        {editing && !cannotEdit ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft.trim() !== (effectiveCaption || "")) onEditCaption(draft);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") { setDraft(effectiveCaption); setEditing(false); }
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
            {effectiveCaption || <span style={{ color: "#9ca3af" }}>(click to add caption)</span>}
          </div>
        )}
        <button
          disabled={cannotEdit || saving}
          onClick={onDelete}
          title={hidden ? "Restore this photo to the published set" : "Remove this photo from the published set"}
          style={{
            fontSize: 10, padding: "3px 6px",
            background: hidden ? "#dcfce7" : "#fee2e2",
            color: hidden ? "#166534" : "#991b1b",
            border: 0, borderRadius: 3, cursor: "pointer", fontWeight: 600,
            alignSelf: "flex-start",
          }}
        >{hidden ? "↺ restore" : "✕ delete"}</button>
      </div>
    </div>
  );
}
