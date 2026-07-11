// ── Shared "Check photo community" full report ───────────────────────────────
// Renders the COMPLETE result of POST /api/builder/photo-community-check: the
// same-community roster (Photos + Source-page badge per unit), the source-page
// check card, bedroom photo coverage (x/x listing bedrooms + per-room detail),
// the verdict strip, concerns, per-folder cards with per-photo votes and
// junk/outlier flags, cross-folder duplicates, and the analysis footer.
//
// Extracted VERBATIM (2026-07-10) from the builder Photos tab
// (GuestyListingBuilder/index.tsx, the "🔎 Check photo community" button) so the
// preflight page can show the EXACT same report. LOAD-BEARING: both surfaces
// render THIS component — if the report needs a change, edit it here; do NOT
// re-inline a copy on either surface or the two reports will drift. Styling is
// intentionally inline (no builder stylesheet dependency) so it renders
// identically wherever it's mounted.
//
// Flagged-photo review (2026-07-11): every YELLOW (unconfirmed) / RED
// (mismatch) per-photo vote, outlier/junk flag, and cross-folder duplicate
// renders the ACTUAL photo (thumbnail + folder/filename + open-full-size) with
// an inline "🗑 Remove photo" / "✓ Keep" decision. Remove is the EXISTING
// photo_labels.hidden soft-delete (PUT /api/photo-labels/:folder/:filename
// { hidden: true }) — files are NEVER unlinked, the photo just leaves the
// gallery + future Guesty pushes, and "↺ Undo" flips it straight back. Removal
// is ALWAYS operator-confirmed via window.confirm — the check itself never
// auto-drops a photo (AGENTS.md Load-Bearing #4).
import { useState } from "react";
import type { CSSProperties } from "react";

// Shape of POST /api/builder/photo-community-check's JSON response. Mirrors
// the server's PhotoCommunityCheckResult (server/photo-community-check.ts) —
// kept as a client-local type so the client bundle doesn't import server code.
export type CommunityCheckFlag = { id: string; caption?: string; reason: string };
export type CommunityCheckPhotoVerdict = {
  id: string;
  folder?: string;
  filename?: string;
  caption?: string;
  match: "yes" | "no" | "uncertain";
  reason: string;
  lensIdentifiedCommunity?: string;
  status?: "verified" | "likely" | "unconfirmed" | "mismatch";
  confidenceScore?: number;
};
export type CommunityCheckGroup = {
  role: "community" | "unit";
  label: string;
  folder: string;
  photosChecked: number;
  photosTotal: number;
  interiorPhotosChecked?: number;
  identifiedCommunity?: string;
  communityFingerprint?: string;
  matchesExpected?: "yes" | "no";
  matchReason?: string;
  sameAsCommunity?: "yes" | "no";
  reason?: string;
  allSameCommunity?: boolean;
  allSameUnit?: boolean;
  photoVerdicts?: CommunityCheckPhotoVerdict[];
  outliers: CommunityCheckFlag[];
  junk: CommunityCheckFlag[];
  confidence: number;
  overallStatus?: "verified" | "likely" | "unconfirmed" | "mismatch";
  recommendation?: string;
  confidenceScore?: number;
};
export type CommunityCheckDuplicate = {
  scope: "cross-folder" | "within-folder";
  a: { folder: string; filename: string; id: string };
  b: { folder: string; filename: string; id: string };
  distance: number;
};
export type CommunityCheckSourcePage = {
  unitLabel: string;
  url: string;
  match: "yes" | "no" | "uncertain";
  identifiedCommunity?: string;
  identifiedLocation?: string;
  reason: string;
  confidence?: number;
  unreadable?: boolean;
};
export type PhotoCommunityCheckResult = {
  ok: boolean;
  verdict: "pass" | "warn" | "fail";
  expectedCommunity: string;
  summary: string;
  concerns: string[];
  allSameCommunity: "yes" | "no";
  unitsSameCommunity?: "yes" | "no" | "n/a";
  community: CommunityCheckGroup | null;
  units: CommunityCheckGroup[];
  bedroomCoverage?: {
    expectedListingBedrooms: number | null;
    bedroomsFoundCombined: number;
    matchesListing: "yes" | "no" | "n/a";
    reason: string;
    units: Array<{
      label: string;
      folder: string;
      expectedBedrooms: number | null;
      bedroomsFound: number;
      bedroomPhotosTotal: number;
      matchesListing: "yes" | "no" | "n/a";
      reason: string;
      rooms: Array<{
        name: string;
        description: string;
        photoCount: number;
        photoIds: string[];
        filenames?: string[];
        altViewCount: number;
        bedType?: string | null;
      }>;
      bedInventoryMatch?: "yes" | "no" | "n/a";
      bedInventoryReason?: string;
      tier?: "pass" | "warn" | "fail";
    }>;
  } | null;
  duplicates: CommunityCheckDuplicate[];
  sourcePages?: CommunityCheckSourcePage[];
  model: string;
  photosChecked: number;
  elapsedMs: number;
  warning?: string;
};

// `manualVerified` + `onMarkVerified` = the "Mark as verified anyway" control
// (client-side display state only; each surface owns its own useState and
// resets it when a new check starts). `onPhotoOverridesChanged` fires after a
// flagged photo is hidden/restored so the host surface can refresh its gallery
// (the Photos tab passes its existing onPhotoOverridesChanged through).
export function PhotoCommunityCheckReport({
  result,
  manualVerified,
  onMarkVerified,
  onPhotoOverridesChanged,
}: {
  result: PhotoCommunityCheckResult;
  manualVerified: boolean;
  onMarkVerified: () => void;
  onPhotoOverridesChanged?: () => void;
}) {
  const r = result;
  const communityStatus = r.community?.overallStatus;
  const effectiveStatus = manualVerified ? "verified" : communityStatus;
  const vStyle =
    manualVerified || r.verdict === "pass"
    ? { bg: "#dcfce7", fg: "#15803d", label: manualVerified ? "✓ Verified (manual)" : "✓ Pass" }
    : effectiveStatus === "mismatch" || r.verdict === "fail"
    ? { bg: "#fef3c7", fg: "#b45309", label: "⚠ Mismatch — review photos" }
    : effectiveStatus === "unconfirmed"
    ? { bg: "#fef9c3", fg: "#92400e", label: "ⓘ Unconfirmed — manual review recommended" }
    : effectiveStatus === "likely"
    ? { bg: "#ecfdf5", fg: "#047857", label: "✓ Likely match" }
    : r.verdict === "warn"
    ? { bg: "#fef9c3", fg: "#92400e", label: "⚠ Review needed" }
    : { bg: "#dcfce7", fg: "#15803d", label: "✓ Pass" };
  const yn = (s?: "yes" | "no") =>
    s === "no" ? { bg: "#fee2e2", fg: "#b91c1c", label: "No" }
    : { bg: "#dcfce7", fg: "#15803d", label: "Yes" };
  const photoStatusOf = (v: CommunityCheckPhotoVerdict) =>
    v.status ?? (v.match === "no" ? "mismatch" : v.match === "uncertain" ? "unconfirmed" : "verified");
  const photoStatusBadge = (v: CommunityCheckPhotoVerdict) => {
    const st = photoStatusOf(v);
    if (st === "mismatch") return { bg: "#fee2e2", fg: "#b91c1c", label: "Mismatch" };
    if (st === "unconfirmed") return { bg: "#fef9c3", fg: "#92400e", label: "Unconfirmed" };
    if (st === "likely") return { bg: "#ecfdf5", fg: "#047857", label: "Likely" };
    return { bg: "#dcfce7", fg: "#15803d", label: "Verified" };
  };

  // ── Flagged-photo review state ────────────────────────────────────────────
  // Keyed "<folder>/<filename>" so the SAME photo appearing in more than one
  // place (a red vote AND an outlier flag, or both sides of a duplicate pair)
  // shows one consistent decision everywhere. Display-only local state except
  // remove/undo, which PUT the existing photo_labels.hidden soft-delete.
  type PhotoDecision = { state: "idle" | "removing" | "removed" | "restoring" | "kept"; error?: string };
  const [photoDecisions, setPhotoDecisions] = useState<Record<string, PhotoDecision>>({});
  const decisionKeyOf = (folder: string, filename: string) => `${folder}/${filename}`;
  const setDecision = (key: string, d: PhotoDecision | null) =>
    setPhotoDecisions((prev) => {
      const next = { ...prev };
      if (d) next[key] = d;
      else delete next[key];
      return next;
    });
  const setPhotoHidden = async (folder: string, filename: string, hidden: boolean) => {
    const key = decisionKeyOf(folder, filename);
    if (hidden) {
      // Operator-confirmed, one photo at a time — the check NEVER auto-drops a
      // photo (Load-Bearing #4); this dialog is the safeguard.
      const confirmed = window.confirm(
        `Remove "${filename}" from the listing?\n\n` +
        `It is hidden from the gallery and future Guesty pushes — the file stays on disk, and you can Undo right after.`,
      );
      if (!confirmed) return;
    }
    setDecision(key, { state: hidden ? "removing" : "restoring" });
    try {
      const resp = await fetch(
        `/api/photo-labels/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden }),
        },
      );
      const data = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!resp.ok || !data?.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      setDecision(key, hidden ? { state: "removed" } : null);
      onPhotoOverridesChanged?.();
    } catch (e: any) {
      // Failed remove → back to undecided (error shown); failed undo → STAY
      // "removed" so the Undo button survives (a transient error must never
      // strand a hidden photo with no way back — same posture as dedupe undo).
      const error = e?.message ?? String(e);
      setDecision(key, hidden ? { state: "idle", error } : { state: "removed", error });
    }
  };
  const miniBtn = (fg: string, border: string, bg: string): CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 6,
    fontSize: 10.5, fontWeight: 600, cursor: "pointer", background: bg, color: fg, border: `1px solid ${border}`,
  });
  // The card that answers "which photo is this flag about?": thumbnail
  // (click = full size in a new tab), folder/filename, and the keep/remove
  // decision. `tone` mirrors the flag severity (red mismatch / amber review).
  const flaggedPhotoCard = (folder: string | undefined, filename: string | undefined, tone: "red" | "amber") => {
    if (!folder || !filename) return null;
    const key = decisionKeyOf(folder, filename);
    const d = photoDecisions[key];
    const src = `/photos/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
    const busy = d?.state === "removing" || d?.state === "restoring";
    const removed = d?.state === "removed";
    const border = removed ? "#94a3b8" : tone === "red" ? "#dc2626" : "#d97706";
    return (
      <div
        data-testid={`flagged-photo-${folder}-${filename}`}
        style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 4, marginBottom: 2, padding: 6, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, maxWidth: 470 }}
      >
        <a href={src} target="_blank" rel="noreferrer" title="Open full-size in a new tab" style={{ flexShrink: 0 }}>
          <img
            src={src}
            alt={filename}
            loading="lazy"
            style={{ width: 96, height: 64, objectFit: "cover", display: "block", borderRadius: 4, border: `2px solid ${border}`, opacity: removed ? 0.45 : 1 }}
          />
        </a>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10, color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${folder}/${filename}`}>
            <code>{folder}/{filename}</code>
            <a href={src} target="_blank" rel="noreferrer" style={{ marginLeft: 6, color: "#0e7490" }}>open ↗</a>
          </div>
          {d?.error ? (
            <div style={{ fontSize: 10, color: "#b91c1c", marginTop: 2 }}>✗ {d.error}</div>
          ) : null}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
            {removed ? (
              <>
                <span style={{ fontSize: 10.5, fontWeight: 600, color: "#b91c1c" }}>Removed — hidden from the gallery + future pushes</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setPhotoHidden(folder, filename, false)}
                  style={miniBtn("#0e7490", "#a5f3fc", "#ecfeff")}
                  data-testid={`btn-flagged-photo-undo-${folder}-${filename}`}
                >
                  ↺ Undo
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setPhotoHidden(folder, filename, true)}
                  style={{ ...miniBtn("#b91c1c", "#fecaca", "#fef2f2"), opacity: busy ? 0.6 : 1 }}
                  data-testid={`btn-flagged-photo-remove-${folder}-${filename}`}
                >
                  {d?.state === "removing" ? "Removing…" : d?.state === "restoring" ? "Restoring…" : "🗑 Remove photo"}
                </button>
                {d?.state === "kept" ? (
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: "#15803d" }}>✓ Keeping this photo</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDecision(key, { state: "kept" })}
                    style={miniBtn("#15803d", "#bbf7d0", "#f0fdf4")}
                    data-testid={`btn-flagged-photo-keep-${folder}-${filename}`}
                  >
                    ✓ Keep
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };
  // Resolve an outlier/junk flag id (e.g. "C6", "U1-3") back to its photo via
  // the group's per-photo verdicts (which carry folder+filename). Synthetic
  // ids like the dHash "pre-screen" outlier have no photo — no card renders.
  const photoByIdFor = (g: { folder?: string; photoVerdicts?: CommunityCheckPhotoVerdict[] } | null | undefined) => {
    const m = new Map<string, { folder?: string; filename?: string }>();
    for (const v of g?.photoVerdicts ?? []) {
      if (v.filename) m.set(v.id, { folder: v.folder ?? g?.folder, filename: v.filename });
    }
    return m;
  };
  const badge = (c: { bg: string; fg: string }): CSSProperties => ({
    display: "inline-block", fontSize: 10.5, fontWeight: 600, padding: "1px 7px",
    borderRadius: 10, background: c.bg, color: c.fg,
  });
  const card: CSSProperties = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px", marginTop: 6 };
  const rowS: CSSProperties = { fontSize: 11.5, color: "#334155", marginTop: 2 };
  const muted: CSSProperties = { color: "#64748b" };
  // `resolvePhoto` maps a flag id back to its folder/filename (built from the
  // group's per-photo verdicts) so each flagged line can show its photo.
  const flagList = (
    flags: CommunityCheckFlag[],
    heading: string,
    color: string,
    tone: "red" | "amber",
    resolvePhoto?: Map<string, { folder?: string; filename?: string }>,
  ) =>
    flags.length > 0 ? (
      <div style={{ marginTop: 3 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color }}>{heading}:</span>
        <ul style={{ margin: "2px 0 0 0", paddingLeft: 18, fontSize: 11, color: "#475569" }}>
          {flags.map((f, i) => {
            const photo = resolvePhoto?.get(f.id);
            return (
              <li key={i}>
                <code style={{ color: "#0e7490" }}>{f.id}</code>{f.caption ? ` "${f.caption}"` : ""} — {f.reason}
                {photo ? flaggedPhotoCard(photo.folder, photo.filename, tone) : null}
              </li>
            );
          })}
        </ul>
      </div>
    ) : null;
  const photoVerdictList = (verdicts: CommunityCheckPhotoVerdict[] | undefined) =>
    verdicts && verdicts.length > 0 ? (
      <div style={{ marginTop: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#334155" }}>Per-photo votes:</span>
        <ul style={{ margin: "2px 0 0 0", paddingLeft: 18, fontSize: 11, color: "#475569" }}>
          {verdicts.map((v, i) => {
            const pb = photoStatusBadge(v);
            const st = photoStatusOf(v);
            // Yellow/red rows show the ACTUAL photo so the operator can decide
            // keep vs remove without hunting through the gallery. Green rows
            // stay compact.
            const flagged = st === "mismatch" || st === "unconfirmed";
            return (
            <li key={i}>
              <code style={{ color: "#0e7490" }}>{v.id}</code>
              <span style={{ ...badge(pb), marginLeft: 6 }}>{pb.label}</span>
              {v.confidenceScore != null ? (
                <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: 4 }}>({v.confidenceScore}%)</span>
              ) : null}
              {v.caption ? ` "${v.caption}"` : ""} — {v.reason}
              {flagged ? flaggedPhotoCard(v.folder, v.filename, st === "mismatch" ? "red" : "amber") : null}
            </li>
          );})}
        </ul>
      </div>
    ) : null;
  const crossDupes = r.duplicates.filter((d) => d.scope === "cross-folder");

  // ── Same-community roll-up (the operator's core question) ──────
  // One glanceable, BINARY answer: name each folder's community and
  // give a single GREEN "YES" / RED "FAILED" verdict — never a maybe.
  // The server now decides each folder yes/no ("no" ONLY on a positive
  // different-community contradiction; see asYesNo), so the headline is:
  //   • RED "FAILED" on ANY positive contradiction (community folder
  //     ≠ the UI community, or any unit ≠ the community folder).
  //   • GREEN "YES" otherwise — no contradiction found = same community.
  // The only non-binary state left is purely factual, NOT a maybe: a
  // single photo set has nothing to compare against (neutral grey).
  const communityMatch = r.community?.matchesExpected;
  const unitMatches = r.units.map((u) => u.sameAsCommunity);
  const comparableSets = (r.community ? 1 : 0) + r.units.length;
  const anyDifferent =
    !manualVerified && (
      effectiveStatus === "mismatch"
      || communityMatch === "no"
      || unitMatches.some((m) => m === "no")
      || (r.allSameCommunity === "no" && effectiveStatus !== "unconfirmed" && effectiveStatus !== "likely")
    );
  const nothingToCompare = !anyDifferent && comparableSets < 2;
  const sameStyle =
    manualVerified
      ? { bg: "#dcfce7", fg: "#15803d", label: "✓ YES — marked verified by admin" }
      : anyDifferent
      ? { bg: "#fef3c7", fg: "#b45309", label: "⚠ Review — possible community mismatch" }
      : effectiveStatus === "unconfirmed"
      ? { bg: "#fef9c3", fg: "#92400e", label: "ⓘ Unconfirmed — photos look consistent but not indexed online" }
      : effectiveStatus === "likely"
      ? { bg: "#ecfdf5", fg: "#047857", label: "✓ Likely — same community" }
      : nothingToCompare
      ? { bg: "#f1f5f9", fg: "#475569", label: "ⓘ Only one photo set — attach units to compare" }
      : { bg: "#dcfce7", fg: "#15803d", label: "✓ YES — all the same community" };
  // Source-page verdicts keyed by unit label — the second,
  // independent signal (the listing's own source page names the
  // community, not just its photos).
  const sourceByLabel = new Map((r.sourcePages ?? []).map((sp) => [sp.unitLabel, sp]));
  const sourceBadge = (sp?: CommunityCheckSourcePage) => {
    if (!sp) return { bg: "#f1f5f9", fg: "#64748b", label: "—" };
    if (sp.match === "yes") return { bg: "#dcfce7", fg: "#15803d", label: "✓ Confirms" };
    if (sp.match === "no") return { bg: "#fee2e2", fg: "#b91c1c", label: "✕ Different" };
    return { bg: "#fef9c3", fg: "#92400e", label: sp.unreadable ? "ⓘ Unreadable" : "ⓘ Unclear" };
  };
  // Roster: community folder first, then each unit, each as
  // "<label> is <identified community>" + a Photos badge and a
  // Source-page badge (units only) vs the community folder.
  const rosterRows: Array<{ role: "community" | "unit"; label: string; identified: string; status?: "yes" | "no"; vsLabel: string; sourcePage?: CommunityCheckSourcePage }> = [];
  if (r.community) {
    rosterRows.push({
      role: "community",
      label: r.community.label,
      identified: r.community.identifiedCommunity || r.community.communityFingerprint || "community folder",
      status: r.community.matchesExpected,
      vsLabel: r.expectedCommunity ? `vs UI “${r.expectedCommunity}”` : "reference set",
    });
  }
  for (const u of r.units) {
    rosterRows.push({
      role: "unit",
      label: u.label,
      identified: u.sameAsCommunity === "yes"
        ? (r.community?.identifiedCommunity || r.expectedCommunity || "same community")
        : (u.reason || "different community"),
      status: u.sameAsCommunity,
      vsLabel: r.community ? "vs community folder" : "vs other units",
      sourcePage: sourceByLabel.get(u.label),
    });
  }

  return (
    <div style={{ marginTop: 10 }}>
      {/* Headline answer to the operator's literal question:
          "Community folder is X, Unit A is X, Unit B is X" +
          one green YES / red FAILED verdict. Only on a real
          analysis — error results (no photos / no API key /
          vision failed) fall through to the summary below,
          which explains the failure. */}
      {r.ok && (
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
          Same community?
        </div>
        <span style={{ ...badge(sameStyle), fontSize: 13, padding: "3px 12px", borderRadius: 12 }}>{sameStyle.label}</span>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 7 }}>
          {rosterRows.map((row, i) => {
            const t = yn(row.status);
            const sp = row.sourcePage;
            const sb = sourceBadge(sp);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, flexWrap: "wrap", borderTop: i > 0 ? "1px solid #f1f5f9" : undefined, paddingTop: i > 0 ? 7 : 0 }}>
                <span style={{ fontWeight: 600, color: "#0f172a" }}>{row.label}</span>
                <span style={{ color: "#64748b" }}>is</span>
                <b style={{ color: "#0f172a" }}>{row.identified}</b>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {/* Photos signal (Lens + Claude vision) */}
                  <span style={{ fontSize: 9.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3 }}>Photos</span>
                  <span style={{ ...badge(t) }}>{t.label}</span>
                  {/* Source-page signal (units only) */}
                  {row.role === "unit" && (
                    <>
                      <span style={{ fontSize: 9.5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.3 }}>Source page</span>
                      <span
                        style={{ ...badge(sb) }}
                        title={sp ? `${sp.identifiedCommunity || sp.identifiedLocation || "source page"} — ${sp.reason}` : "No source listing URL recorded for this unit."}
                      >
                        {sb.label}
                      </span>
                    </>
                  )}
                </div>
                <span style={{ fontSize: 10, color: "#94a3b8", width: "100%", textAlign: "right" }}>{row.vsLabel}</span>
              </div>
            );
          })}
        </div>
        {r.expectedCommunity ? (
          <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 7 }}>UI community: “{r.expectedCommunity}”</div>
        ) : null}
      </div>
      )}

      {/* ── Source-page check — verifies each unit's SOURCE
          LISTING PAGE (Zillow/Redfin/VRBO/…) names the
          expected community, independent of the photos. */}
      {r.sourcePages && r.sourcePages.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
            Source page check
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
            Confirms the listing page each unit's photos were scraped from is in the expected community.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {r.sourcePages.map((sp, i) => {
              const sb = sp.match === "yes"
                ? { bg: "#dcfce7", fg: "#15803d", label: "✓ Confirms community" }
                : sp.match === "no"
                ? { bg: "#fee2e2", fg: "#b91c1c", label: "✕ Different community" }
                : { bg: "#fef9c3", fg: "#92400e", label: sp.unreadable ? "ⓘ Page unreadable" : "ⓘ Unclear" };
              let host = "";
              try { host = new URL(sp.url).hostname.replace(/^www\./, ""); } catch { host = sp.url; }
              return (
                <div key={i} style={{ borderTop: i > 0 ? "1px solid #f1f5f9" : undefined, paddingTop: i > 0 ? 8 : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, fontSize: 12, color: "#0f172a" }}>{sp.unitLabel}</span>
                    <span style={{ ...badge(sb), fontSize: 11, padding: "1px 8px" }}>{sb.label}</span>
                    {sp.identifiedLocation ? (
                      <span style={{ fontSize: 11, color: "#475569" }}>📍 {sp.identifiedLocation}</span>
                    ) : null}
                    {sp.url ? (
                      <a href={sp.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#0e7490", marginLeft: "auto" }}>
                        {host} ↗
                      </a>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>{sp.reason}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Bedroom photo coverage — the operator's x/x listing bedrooms question */}
      {r.bedroomCoverage && r.bedroomCoverage.units.length > 0 && (() => {
        const bc = r.bedroomCoverage!;
        const expected = bc.expectedListingBedrooms;
        const found = bc.bedroomsFoundCombined;
        const covStyle =
          bc.matchesListing === "yes"
            ? { bg: "#dcfce7", fg: "#15803d", label: expected ? `✓ ${found}/${expected} bedroom photos` : `✓ ${found} bedroom(s) detected` }
            : bc.matchesListing === "no"
            ? { bg: "#fee2e2", fg: "#b91c1c", label: expected ? `✗ ${found}/${expected} bedroom photos` : `✗ Incomplete bedroom coverage` }
            : { bg: "#f1f5f9", fg: "#475569", label: `${found} bedroom(s) detected` };
        return (
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
              Bedroom photo coverage
            </div>
            <span style={{ ...badge(covStyle), fontSize: 13, padding: "3px 12px", borderRadius: 12 }}>{covStyle.label}</span>
            <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 6 }}>{bc.reason}</div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {bc.units.map((u, ui) => {
                const uStyle =
                  u.matchesListing === "yes"
                    ? { bg: "#dcfce7", fg: "#15803d" }
                    : u.matchesListing === "no"
                    ? { bg: "#fee2e2", fg: "#b91c1c" }
                    : { bg: "#f1f5f9", fg: "#475569" };
                const uLabel = u.expectedBedrooms
                  ? `${u.bedroomsFound}/${u.expectedBedrooms} bedrooms`
                  : `${u.bedroomsFound} bedroom(s)`;
                return (
                  <div key={ui} style={{ borderTop: ui > 0 ? "1px solid #f1f5f9" : undefined, paddingTop: ui > 0 ? 8 : 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, fontSize: 12, color: "#0f172a" }}>{u.label}</span>
                      <span style={{ ...badge(uStyle), fontSize: 10.5 }}>{uLabel}</span>
                      <span style={{ fontSize: 10, color: "#94a3b8" }}>{u.bedroomPhotosTotal} bedroom photo{u.bedroomPhotosTotal === 1 ? "" : "s"}</span>
                    </div>
                    {u.rooms.length > 0 ? (
                      <ul style={{ margin: "4px 0 0 0", paddingLeft: 18, fontSize: 11.5, color: "#334155" }}>
                        {u.rooms.map((room, ri) => (
                          <li key={ri}>
                            <b>{room.name}:</b> {room.description}
                            {room.photoCount > 1 ? (
                              <span style={{ color: "#94a3b8" }}> ({room.photoCount} photos — same room)</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div style={{ fontSize: 11, color: "#b45309", marginTop: 4 }}>No bedroom-tagged photos found in this unit folder.</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ ...badge(vStyle), fontSize: 12, padding: "2px 10px" }}>{vStyle.label}</span>
        <span style={{ ...badge(yn(r.allSameCommunity)), fontSize: 11, padding: "1px 8px" }}>
          All same community: {yn(r.allSameCommunity).label}
        </span>
        {r.community?.overallStatus && (
          <span style={{ fontSize: 11, color: "#64748b" }}>
            Status: <b>{r.community.overallStatus}</b>
            {r.community.confidenceScore != null ? ` · ${r.community.confidenceScore}% confidence` : ""}
          </span>
        )}
        {(r.community?.overallStatus === "unconfirmed" || r.community?.overallStatus === "likely" || r.verdict === "warn") && !manualVerified && (
          <button
            type="button"
            onClick={() => onMarkVerified()}
            // Inline equivalent of the builder's `.glb-btn` class (defined in a
            // <style> block inside GuestyListingBuilder) so the button renders
            // identically on surfaces that don't load that stylesheet (preflight).
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", fontSize: 11, background: "#ecfdf5", color: "#047857", border: "1px solid #bbf7d0" }}
          >
            Mark as verified anyway
          </button>
        )}
        {r.unitsSameCommunity && r.unitsSameCommunity !== "n/a" && (
          <span style={{ ...badge(yn(r.unitsSameCommunity)), fontSize: 11, padding: "1px 8px" }}>
            Units match each other: {yn(r.unitsSameCommunity).label}
          </span>
        )}
        <span style={{ fontSize: 12, color: "#334155", flex: 1, minWidth: 200 }}>{r.summary}</span>
      </div>

      {r.concerns.length > 0 && (
        <ul style={{ margin: "6px 0 4px 0", paddingLeft: 18, fontSize: 11.5, color: r.verdict === "fail" ? "#b91c1c" : "#92400e" }}>
          {r.concerns.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}

      {r.community && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 12, color: "#0f172a" }}>{r.community.label}</span>
            <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: "auto" }}>{r.community.photosChecked}/{r.community.photosTotal} checked</span>
          </div>
          <div style={rowS}>Identified as: <b>{r.community.identifiedCommunity}</b></div>
          {r.community.recommendation && (
            <div style={{ ...rowS, color: "#64748b", fontStyle: "italic" }}>{r.community.recommendation}</div>
          )}
          <div style={rowS}>
            Matches expected{r.expectedCommunity ? ` ("${r.expectedCommunity}")` : ""}: <span style={badge(yn(r.community.matchesExpected))}>{yn(r.community.matchesExpected).label}</span>
            {r.community.matchReason ? <span style={muted}> — {r.community.matchReason}</span> : null}
          </div>
          <div style={rowS}>
            All community photos same place: <span style={badge(yn(r.community.allSameCommunity ? "yes" : "no"))}>{yn(r.community.allSameCommunity ? "yes" : "no").label}</span>
          </div>
          {photoVerdictList(r.community.photoVerdicts)}
          {flagList(r.community.outliers, "Different-community photos", "#b45309", "red", photoByIdFor(r.community))}
          {flagList(r.community.junk, "Junk / mis-filed", "#b45309", "amber", photoByIdFor(r.community))}
        </div>
      )}

      {r.units.map((u, i) => {
        const t = yn(u.sameAsCommunity);
        return (
          <div key={i} style={card}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 12, color: "#0f172a" }}>{u.label}</span>
              <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: "auto" }}>
                {u.photosChecked}/{u.photosTotal} checked
                {typeof u.interiorPhotosChecked === "number" ? ` · ${u.interiorPhotosChecked} interior` : ""}
              </span>
            </div>
            <div style={rowS}>
              Same community as community folder: <span style={badge(t)}>{t.label}</span>
              {u.reason ? <span style={muted}> — {u.reason}</span> : null}
            </div>
            {photoVerdictList(u.photoVerdicts)}
            {u.allSameUnit === false && (
              <div style={{ ...rowS, color: "#b45309" }}>⚠ Not all photos look like the same unit.</div>
            )}
            {flagList(u.outliers, "Possible odd-one-out photos", "#b45309", "red", photoByIdFor(u))}
            {flagList(u.junk, "Junk / mis-filed", "#b45309", "amber", photoByIdFor(u))}
          </div>
        );
      })}

      {crossDupes.length > 0 && (
        <div style={{ ...card, background: "#fffbeb", borderColor: "#fde68a" }}>
          <div style={{ fontWeight: 600, fontSize: 11.5, color: "#92400e", marginBottom: 3 }}>⚠ Same photo found in more than one folder</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "#92400e" }}>
            {crossDupes.map((d, i) => (
              <li key={i}>
                <code>{d.a.folder}/{d.a.filename}</code> ↔ <code>{d.b.folder}/{d.b.filename}</code>
                {/* Both copies, side by side, each removable — the operator
                    decides which folder keeps the photo. */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {flaggedPhotoCard(d.a.folder, d.a.filename, "amber")}
                  {flaggedPhotoCard(d.b.folder, d.b.filename, "amber")}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 6 }}>
        {r.photosChecked} photos analyzed · {(r.elapsedMs / 1000).toFixed(0)}s · {r.model}
        {r.warning && r.ok ? ` · note: ${r.warning}` : ""}
      </div>
    </div>
  );}
