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
import { RotateCcw, RotateCw } from "lucide-react";

type PhotoIn = { url: string; caption?: string; source?: string };
export type CoverCollageSelection = { left: PhotoIn; right: PhotoIn };

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

export type CommunityPhotoVerdict = {
  match: "yes" | "no";
  reason?: string;
};

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
  //
  // `coverCollageCurrentUrl` is the URL of the Cover Collage currently
  // set on Guesty (if any). When set, rendered as a standalone tile
  // above the section grid so the operator can see it from the Photos
  // tab without navigating to Guesty. Survives page reloads because the
  // parent re-fetches it from the Guesty listing on mount.
  coverCollageEnabled?: boolean;
  coverCollageDisabledReason?: string | null;
  coverCollageCurrentUrl?: string | null;
  onRequestCoverCollage?: (selection: CoverCollageSelection) => void;
  coverCollageStatus?: {
    phase: "idle" | "generating" | "uploading" | "done" | "error";
    error?: string | null;
    preview?: string | null;
    picks?: { community: string; patio: string } | null;
  };
  /** Per community-folder photo verdict from Check photo community (folder/filename key). */
  communityPhotoVerdicts?: Record<string, CommunityPhotoVerdict>;
};

export default function PhotoCurator({
  photos,
  sourceUrlsByFolder,
  onOverridesChanged,
  coverCollageEnabled,
  coverCollageDisabledReason,
  coverCollageCurrentUrl,
  onRequestCoverCollage,
  coverCollageStatus,
  communityPhotoVerdicts,
}: PhotoCuratorProps) {
  const [meta, setMeta] = useState<Map<string, LabelMeta>>(new Map());
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [rotatingKey, setRotatingKey] = useState<string | null>(null);
  const [cacheBusters, setCacheBusters] = useState<Map<string, number>>(new Map());
  const [collagePickerOpen, setCollagePickerOpen] = useState(false);
  const [collageSelection, setCollageSelection] = useState<string[]>([]);

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

  const rotatePhoto = useCallback(
    async (folder: string, filename: string, degrees: 90 | 270) => {
      const key = `${folder}/${filename}`;
      setRotatingKey(key);
      try {
        const resp = await fetch("/api/photos/rotate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder, filename, degrees }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error((body as any)?.error || `HTTP ${resp.status}`);
        }
        setCacheBusters((prev) => {
          const next = new Map(prev);
          next.set(key, Date.now());
          return next;
        });
        onOverridesChanged?.();
      } catch (e: any) {
        alert(`Rotate failed: ${e.message}`);
      } finally {
        setRotatingKey(null);
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
  const selectableCollagePhotos = sections
    .flatMap((section) => section.photos)
    .filter((p) => !p.meta?.hidden);
  const selectedCollagePhotos = collageSelection
    .map((key) => selectableCollagePhotos.find((p) => p.key === key))
    .filter((p): p is (typeof selectableCollagePhotos)[number] => !!p);
  const closeCollagePicker = () => {
    setCollagePickerOpen(false);
    setCollageSelection([]);
  };
  const toggleCollagePhoto = (key: string) => {
    setCollageSelection((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= 2) return prev;
      return [...prev, key];
    });
  };
  const confirmCollageSelection = () => {
    if (selectedCollagePhotos.length !== 2) return;
    onRequestCoverCollage?.({
      left: {
        url: selectedCollagePhotos[0].url,
        caption: selectedCollagePhotos[0].caption,
        source: selectedCollagePhotos[0].source,
      },
      right: {
        url: selectedCollagePhotos[1].url,
        caption: selectedCollagePhotos[1].caption,
        source: selectedCollagePhotos[1].source,
      },
    });
    closeCollagePicker();
  };

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
          phase === "done" ? "↺ Make New Cover Collage" :
          busy ? (phase === "uploading" ? "⏳ Uploading to Guesty…" : "⏳ Building collage…") :
          "🖼 Make Cover Collage";
        return (
          <div style={{
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            padding: "10px 14px", background: "#f0f9ff", border: "1px solid #bae6fd",
            borderRadius: 6, marginBottom: 14, fontSize: 12,
          }}>
            <button
              onClick={() => {
                setCollageSelection([]);
                setCollagePickerOpen(true);
              }}
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
              Choose the two photos to stitch into a 2-up cover and set as the Guesty cover photo.
            </span>
            {gated && (
              <span style={{
                flexBasis: "100%", color: "#b45309",
                fontSize: 11, fontWeight: 500,
              }}>⚠ {coverCollageDisabledReason}</span>
            )}
            {coverCollageStatus?.picks && (
              <div style={{ flexBasis: "100%", fontSize: 11, color: "#0369a1" }}>
                Selected: <em>{coverCollageStatus.picks.community}</em> &nbsp;+&nbsp; <em>{coverCollageStatus.picks.patio}</em>
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

      {collagePickerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(15, 23, 42, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div style={{
            width: "min(1040px, 100%)",
            maxHeight: "88vh",
            background: "white",
            borderRadius: 8,
            boxShadow: "0 24px 80px rgba(15, 23, 42, 0.35)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "16px 18px",
              borderBottom: "1px solid #e5e7eb",
            }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>
                  Select 2 Photos For The Cover Collage
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                  Pick the left image first, then the right image. Hidden photos are excluded.
                </div>
              </div>
              <button
                onClick={closeCollagePicker}
                style={{
                  border: "1px solid #e5e7eb",
                  background: "white",
                  color: "#374151",
                  borderRadius: 6,
                  width: 32,
                  height: 32,
                  cursor: "pointer",
                  fontSize: 18,
                  lineHeight: "28px",
                }}
                aria-label="Close collage photo picker"
              >
                ×
              </button>
            </div>

            <div style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) 260px",
              gap: 0,
              minHeight: 0,
            }}>
              <div style={{
                padding: 16,
                overflow: "auto",
                maxHeight: "calc(88vh - 137px)",
              }}>
                <div style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                }}>
                  {selectableCollagePhotos.map((photo) => {
                    const order = collageSelection.indexOf(photo.key);
                    const selected = order >= 0;
                    const disabledByLimit = !selected && collageSelection.length >= 2;
                    const cacheBust = cacheBusters.get(photo.key);
                    const imgSrc = cacheBust
                      ? `${photo.url}${photo.url.includes("?") ? "&" : "?"}v=${cacheBust}`
                      : photo.url;
                    return (
                      <button
                        key={photo.key}
                        type="button"
                        onClick={() => toggleCollagePhoto(photo.key)}
                        disabled={disabledByLimit}
                        style={{
                          position: "relative",
                          border: selected ? "3px solid #0369a1" : "1px solid #e5e7eb",
                          borderRadius: 8,
                          padding: 0,
                          background: "white",
                          overflow: "hidden",
                          cursor: disabledByLimit ? "not-allowed" : "pointer",
                          opacity: disabledByLimit ? 0.45 : 1,
                          textAlign: "left",
                        }}
                        title={disabledByLimit ? "Deselect one photo before choosing another" : "Select for collage"}
                      >
                        <div style={{ aspectRatio: "4/3", background: "#f3f4f6" }}>
                          <img
                            src={imgSrc}
                            alt={photo.caption || "Listing photo"}
                            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                          />
                        </div>
                        {selected && (
                          <div style={{
                            position: "absolute",
                            top: 8,
                            left: 8,
                            width: 28,
                            height: 28,
                            borderRadius: "50%",
                            background: "#0369a1",
                            color: "white",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 14,
                            fontWeight: 800,
                            boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                          }}>
                            {order + 1}
                          </div>
                        )}
                        <div style={{
                          padding: "7px 9px",
                          fontSize: 11,
                          color: "#374151",
                          minHeight: 42,
                          lineHeight: 1.25,
                        }}>
                          <div style={{
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            fontWeight: 600,
                          }}>
                            {photo.source || "Photo"}
                          </div>
                          <div style={{
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            color: "#6b7280",
                          }}>
                            {photo.meta?.userLabel || photo.caption || photo.meta?.label || "No caption"}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{
                borderLeft: "1px solid #e5e7eb",
                padding: 16,
                background: "#f9fafb",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>
                  {selectedCollagePhotos.length}/2 selected
                </div>
                {[0, 1].map((slot) => {
                  const photo = selectedCollagePhotos[slot];
                  return (
                    <div
                      key={slot}
                      style={{
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        background: "white",
                        overflow: "hidden",
                      }}
                    >
                      <div style={{
                        height: 92,
                        background: "#eef2f7",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#9ca3af",
                        fontSize: 12,
                      }}>
                        {photo ? (
                          <img
                            src={photo.url}
                            alt={photo.caption || `Selected collage photo ${slot + 1}`}
                            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                          />
                        ) : (
                          slot === 0 ? "Left image" : "Right image"
                        )}
                      </div>
                      <div style={{ padding: "7px 9px", fontSize: 11, color: "#4b5563" }}>
                        {photo
                          ? (photo.meta?.userLabel || photo.caption || photo.meta?.label || photo.source || `Photo ${slot + 1}`)
                          : "Not selected"}
                      </div>
                    </div>
                  );
                })}
                <div style={{ marginTop: "auto", display: "flex", gap: 8 }}>
                  <button
                    onClick={closeCollagePicker}
                    style={{
                      flex: 1,
                      padding: "9px 10px",
                      border: "1px solid #d1d5db",
                      borderRadius: 6,
                      background: "white",
                      color: "#374151",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmCollageSelection}
                    disabled={selectedCollagePhotos.length !== 2}
                    style={{
                      flex: 1.4,
                      padding: "9px 10px",
                      border: 0,
                      borderRadius: 6,
                      background: selectedCollagePhotos.length === 2 ? "#0369a1" : "#93c5fd",
                      color: "white",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: selectedCollagePhotos.length === 2 ? "pointer" : "not-allowed",
                    }}
                  >
                    Create Collage
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cover collage tile — rendered above the regular sections when
          Guesty has a "Cover Collage"-captioned picture on the listing.
          Read-only (no delete/rename/hide); operator regenerates via
          the banner above. Persists across page reloads because the
          parent refreshes this URL from Guesty on every mount. */}
      {coverCollageCurrentUrl && (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap",
            padding: "8px 0 6px", borderBottom: "1px solid #e5e7eb", marginBottom: 10,
          }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: "#0369a1",
              textTransform: "uppercase", letterSpacing: "0.05em",
            }}>
              Cover Collage — live on Guesty
            </div>
            <a
              href={coverCollageCurrentUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 11, color: "#2563eb", textDecoration: "none",
                padding: "2px 8px", background: "#eff6ff", border: "1px solid #bfdbfe",
                borderRadius: 3,
              }}
              title="Open the full-size collage image"
            >
              ↗ Open full size
            </a>
          </div>
          <div style={{
            display: "grid", gap: 8,
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          }}>
            <div style={{
              position: "relative",
              border: "2px solid #0369a1",
              borderRadius: 6, background: "#fff",
              overflow: "hidden",
            }}>
              <div style={{ position: "relative", aspectRatio: "2/1", background: "#f3f4f6" }}>
                <img
                  src={coverCollageCurrentUrl}
                  alt="Cover Collage"
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
                <div style={{
                  position: "absolute", top: 6, left: 6,
                  background: "#0369a1", color: "white", fontSize: 10, fontWeight: 700,
                  padding: "3px 8px", borderRadius: 3,
                  textTransform: "uppercase", letterSpacing: "0.05em",
                }}>Cover</div>
              </div>
              <div style={{ padding: "6px 10px", fontSize: 11, color: "#6b7280" }}>
                Auto-generated 2-up community + patio collage. Regenerate via the banner above.
              </div>
            </div>
          </div>
        </div>
      )}

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
              {section.photos.map((tile, tileIdx) => {
                const verdictKey = tile.folder && tile.filename ? `${tile.folder}/${tile.filename}` : null;
                const communityVerdict = verdictKey ? communityPhotoVerdicts?.[verdictKey] : undefined;
                const isCommunitySection = /^Community\s/i.test(section.source);
                return (
                <PhotoTile
                  key={tile.key}
                  tile={tile}
                  index={tileIdx + 1}
                  saving={savingKey === tile.key}
                  rotating={rotatingKey === tile.key}
                  cacheBust={cacheBusters.get(tile.key)}
                  communityVerdict={isCommunitySection ? communityVerdict : undefined}
                  onEditCaption={(caption) => {
                    if (!tile.folder || !tile.filename) return;
                    patchLabel(tile.folder, tile.filename, { userLabel: caption.trim() || null });
                  }}
                  onDelete={() => {
                    if (!tile.folder || !tile.filename) return;
                    patchLabel(tile.folder, tile.filename, { hidden: !tile.meta?.hidden });
                  }}
                  onRotate={(degrees) => {
                    if (!tile.folder || !tile.filename) return;
                    rotatePhoto(tile.folder, tile.filename, degrees);
                  }}
                />
              );})}
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
  rotating,
  cacheBust,
  onEditCaption,
  onDelete,
  onRotate,
  communityVerdict,
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
  rotating: boolean;
  cacheBust?: number;
  onEditCaption: (caption: string) => void;
  onDelete: () => void;
  onRotate: (degrees: 90 | 270) => void;
  communityVerdict?: CommunityPhotoVerdict;
}) {
  // Effective caption — user override wins, else labeler output, else
  // whatever the parent passed in (static label fallback), else blank.
  const effectiveCaption = tile.meta?.userLabel ?? tile.meta?.label ?? tile.caption ?? "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(effectiveCaption);
  useEffect(() => { setDraft(effectiveCaption); }, [effectiveCaption]);

  const hidden = !!tile.meta?.hidden;
  const cannotEdit = !tile.folder;
  const displayUrl = cacheBust
    ? `${tile.url}${tile.url.includes("?") ? "&" : "?"}v=${cacheBust}`
    : tile.url;

  return (
    <div style={{
      position: "relative",
      border: tile.meta?.userLabel ? "2px solid #16a34a" : "1px solid #e5e7eb",
      borderRadius: 6, background: "#fff",
      overflow: "hidden", opacity: hidden ? 0.4 : 1,
    }}>
      <div style={{ position: "relative", aspectRatio: "4/3", background: "#f3f4f6" }}>
        <img
          src={displayUrl}
          alt={effectiveCaption}
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        <div style={{
          position: "absolute", top: 4, left: 4,
          background: "rgba(17,24,39,0.7)", color: "white", fontSize: 10, fontWeight: 600,
          padding: "2px 6px", borderRadius: 3,
        }}>{index}</div>
        {communityVerdict && (
          <div
            title={communityVerdict.reason || (communityVerdict.match === "yes" ? "Confirmed for this community" : "Does not belong in this community folder")}
            style={{
              position: "absolute", top: 4, right: 4,
              width: 22, height: 22, borderRadius: "50%",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 800, lineHeight: 1,
              background: communityVerdict.match === "yes" ? "#16a34a" : "#dc2626",
              color: "#fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
            }}
          >{communityVerdict.match === "yes" ? "✓" : "✕"}</div>
        )}
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
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button
            disabled={cannotEdit || saving || rotating}
            onClick={() => onRotate(270)}
            title="Rotate photo left and save"
            aria-label="Rotate photo left and save"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 24, background: "#eef2ff", color: "#3730a3",
              border: 0, borderRadius: 3, cursor: cannotEdit || saving || rotating ? "not-allowed" : "pointer",
              opacity: cannotEdit || saving || rotating ? 0.55 : 1,
            }}
          >
            <RotateCcw size={13} />
          </button>
          <button
            disabled={cannotEdit || saving || rotating}
            onClick={() => onRotate(90)}
            title="Rotate photo right and save"
            aria-label="Rotate photo right and save"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 24, background: "#eef2ff", color: "#3730a3",
              border: 0, borderRadius: 3, cursor: cannotEdit || saving || rotating ? "not-allowed" : "pointer",
              opacity: cannotEdit || saving || rotating ? 0.55 : 1,
            }}
          >
            <RotateCw size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
