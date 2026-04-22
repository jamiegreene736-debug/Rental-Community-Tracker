// Availability / inventory scanner UI — phase 1+2 rewrite (Apr 2026).
//
// Replaces the old "shopping list of buy-ins" UX with a safety-guarantee
// heatmap: 52 rolling 7-day windows, each colored by how many independent
// complete buy-in SETS exist. Windows where we can't find enough sets
// get pushed as unavailable blocks to Guesty's calendar so they can't
// be oversold.

import { useCallback, useMemo, useRef, useState } from "react";

type Verdict = "open" | "tight" | "blocked" | "pending";

type CandidateListing = { id: string; url: string; title: string };

type WindowResult = {
  startDate: string;
  endDate: string;
  verdict: Verdict;
  maxSets?: number;
  minSets?: number;
  listingCounts?: Record<string, number>;
  sample?: Record<string, CandidateListing[]>;
  overridden?: boolean;
  overrideMode?: "force-open" | "force-block";
  overrideNote?: string | null;
};

type CandidatesEvent = {
  countsByBR: Record<string, number>;
  samplesByBR: Record<string, CandidateListing[]>;
  errors: Record<string, string>;
  baselineSets: number;
  baselineVerdict: Verdict;
};

type Unit = { unitId: string; unitLabel: string; bedrooms: number };

type ScanContext = {
  propertyId: number;
  guestyListingId: string | null;
  community: string;
  resortName: string | null;
  units: Unit[];
  minSets: number;
  weeks: number;
};

function verdictColor(v: Verdict): { bg: string; fg: string; border: string } {
  switch (v) {
    case "open":    return { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" };
    case "tight":   return { bg: "#fef3c7", fg: "#92400e", border: "#fcd34d" };
    case "blocked": return { bg: "#fee2e2", fg: "#991b1b", border: "#fecaca" };
    case "pending": return { bg: "#f3f4f6", fg: "#6b7280", border: "#e5e7eb" };
  }
}

function fmtShort(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function AvailabilityTab({ propertyId, listingId }: { propertyId: number | undefined; listingId: string | null }) {
  const [weeks, setWeeks] = useState(52);
  const [minSets, setMinSets] = useState(3);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [ctx, setCtx] = useState<ScanContext | null>(null);
  const [candidates, setCandidates] = useState<CandidatesEvent | null>(null);
  const [results, setResults] = useState<WindowResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  const abortRef = useRef<AbortController | null>(null);

  const summary = useMemo(() => {
    const open = results.filter((r) => r.verdict === "open").length;
    const tight = results.filter((r) => r.verdict === "tight").length;
    const blocked = results.filter((r) => r.verdict === "blocked").length;
    return { open, tight, blocked, total: results.length };
  }, [results]);

  // Group results by month for the heatmap rendering.
  const byMonth = useMemo(() => {
    const m: Record<string, WindowResult[]> = {};
    for (const r of results) {
      const mk = r.startDate.slice(0, 7);
      (m[mk] = m[mk] ?? []).push(r);
    }
    return m;
  }, [results]);

  const runScan = useCallback(async () => {
    if (!propertyId) return;
    setScanning(true);
    setResults([]);
    setCtx(null);
    setCandidates(null);
    setError(null);
    setProgress(null);
    setSelectedIdx(null);
    setSyncResult(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch(
        `/api/availability/scan/${propertyId}?weeks=${weeks}&minSets=${minSets}`,
        { signal: controller.signal },
      );
      if (!resp.ok || !resp.body) {
        setError(`HTTP ${resp.status}`);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let total = weeks;
      let done = 0;
      const collected: WindowResult[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "start") {
            total = evt.weeks ?? total;
            setCtx({
              propertyId: evt.propertyId,
              guestyListingId: evt.guestyListingId ?? null,
              community: evt.community,
              resortName: evt.resortName ?? null,
              units: evt.units ?? [],
              minSets: evt.minSets,
              weeks: evt.weeks,
            });
            setProgress({ done: 0, total });
          } else if (evt.type === "candidates") {
            setCandidates(evt as CandidatesEvent);
          } else if (evt.type === "window") {
            done++;
            collected.push(evt as WindowResult);
            setResults([...collected]);
            setProgress({ done, total });
          } else if (evt.type === "done") {
            /* finished — total stays */
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message ?? String(e));
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  }, [propertyId, weeks, minSets]);

  const stopScan = () => abortRef.current?.abort();

  const syncBlocks = useCallback(async () => {
    if (!propertyId || results.length === 0) return;
    setSyncBusy(true);
    setSyncResult(null);
    try {
      const resp = await fetch(`/api/availability/sync-blocks/${propertyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windows: results.map((r) => ({
            startDate: r.startDate,
            endDate: r.endDate,
            verdict: r.verdict,
            maxSets: r.maxSets,
            minSets: r.minSets ?? minSets,
          })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setSyncResult(data);
    } catch (e: any) {
      setSyncResult({ success: false, error: e?.message ?? String(e) });
    } finally {
      setSyncBusy(false);
    }
  }, [propertyId, results, minSets]);

  const applyOverride = useCallback(async (window: WindowResult, mode: "force-open" | "force-block" | null) => {
    if (!propertyId) return;
    try {
      if (mode === null) {
        await fetch(`/api/availability/overrides/${propertyId}/${window.startDate}`, { method: "DELETE" });
      } else {
        await fetch(`/api/availability/overrides/${propertyId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startDate: window.startDate,
            endDate: window.endDate,
            mode,
          }),
        });
      }
      // Reflect locally so the user gets instant feedback. Next scan will
      // replace this with the authoritative override-applied verdict.
      setResults((prev) => prev.map((r) =>
        r.startDate === window.startDate
          ? { ...r, overridden: mode !== null, overrideMode: mode ?? undefined, verdict: mode === "force-block" ? "blocked" : mode === "force-open" ? "open" : r.verdict }
          : r,
      ));
    } catch { /* swallow — non-critical */ }
  }, [propertyId]);

  const selected = selectedIdx != null ? results[selectedIdx] : null;

  const blockedCount = summary.blocked;
  const tightCount = summary.tight;

  if (!propertyId) {
    return (
      <div style={{ padding: 20, fontSize: 13, color: "#6b7280" }}>
        Select a property to scan availability.
      </div>
    );
  }

  return (
    <div>
      {/* ── Controls ─────────────────────────────────────────── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "#6b7280", display: "flex", alignItems: "center", gap: 6 }}>
          Weeks ahead:
          <select
            value={weeks}
            onChange={(e) => setWeeks(parseInt(e.target.value, 10))}
            disabled={scanning}
            style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4 }}
          >
            <option value={26}>26 (~6 mo)</option>
            <option value={52}>52 (1 yr)</option>
            <option value={78}>78 (~18 mo)</option>
            <option value={104}>104 (2 yr)</option>
          </select>
        </label>
        <label style={{ fontSize: 12, color: "#6b7280", display: "flex", alignItems: "center", gap: 6 }}>
          Minimum sets needed:
          <select
            value={minSets}
            onChange={(e) => setMinSets(parseInt(e.target.value, 10))}
            disabled={scanning}
            style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4 }}
          >
            <option value={2}>2 (tight)</option>
            <option value={3}>3 (recommended)</option>
            <option value={4}>4 (conservative)</option>
            <option value={5}>5 (paranoid)</option>
          </select>
        </label>
        <button
          className="glb-btn glb-btn-primary"
          onClick={runScan}
          disabled={scanning}
          style={{ fontSize: 12 }}
        >
          {scanning ? "Scanning…" : results.length > 0 ? "↺ Re-scan" : "▶ Run inventory scan"}
        </button>
        {scanning && (
          <button className="glb-btn" onClick={stopScan} style={{ fontSize: 12 }}>
            Stop
          </button>
        )}
        {progress && (
          <span style={{ fontSize: 11, color: "#6b7280" }}>
            {progress.done} / {progress.total} weeks
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="glb-btn"
          onClick={syncBlocks}
          disabled={scanning || syncBusy || results.length === 0 || !listingId}
          style={{ fontSize: 12, borderColor: blockedCount > 0 ? "#dc2626" : undefined, color: blockedCount > 0 ? "#dc2626" : undefined }}
          title={!listingId ? "Select a Guesty listing first" : blockedCount === 0 ? "Nothing to block" : `Push ${blockedCount} blocked week${blockedCount === 1 ? "" : "s"} to Guesty`}
        >
          {syncBusy ? "Syncing…" : `Sync ${blockedCount} block${blockedCount === 1 ? "" : "s"} to Guesty`}
        </button>
      </div>

      {/* ── Context + summary ────────────────────────────────── */}
      {ctx && (
        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10, lineHeight: 1.6 }}>
          Scanning <b>{ctx.resortName ?? ctx.community}</b> —{" "}
          needed units: {ctx.units.map((u) => `${u.bedrooms}BR`).join(" + ")}.
          {" "}A "set" = one listing per unit slot (no reuse). Window is <b>blocked</b> when fewer than <b>{ctx.minSets}</b> independent sets exist.
        </div>
      )}
      {candidates && (
        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10, padding: 8, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 4, lineHeight: 1.6 }}>
          <b>Candidate inventory found at this resort</b> — {Object.entries(candidates.countsByBR).map(([br, n]) => (
            <span key={br} style={{ marginRight: 12 }}>{br}BR: <b>{n}</b> listings</span>
          ))} · max independent sets: <b>{candidates.baselineSets}</b>
          {candidates.baselineSets < (ctx?.minSets ?? 3) && (
            <span style={{ color: "#991b1b", marginLeft: 8 }}>
              (below {ctx?.minSets ?? 3}-set floor → all weeks block)
            </span>
          )}
          <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
            Counts are static per scan — listings don't appear/disappear week-to-week, so a single search powers all {ctx?.weeks ?? 52} windows. Re-run the scan to refresh.
          </div>
        </div>
      )}
      {results.length > 0 && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16, fontSize: 12 }}>
          <span style={{ color: "#166534", fontWeight: 600 }}>✓ {summary.open} open</span>
          <span style={{ color: "#92400e", fontWeight: 600 }}>⚠ {summary.tight} tight</span>
          <span style={{ color: "#991b1b", fontWeight: 600 }}>✗ {summary.blocked} blocked</span>
          {tightCount > 0 && (
            <span style={{ color: "#6b7280" }}>
              · Tight weeks can still be booked but won't auto-block.
            </span>
          )}
        </div>
      )}
      {error && (
        <div style={{ padding: 8, background: "#fee2e2", color: "#991b1b", borderRadius: 4, fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {syncResult && (
        <div
          style={{
            padding: 10,
            background: syncResult.success ? "#f0fdf4" : "#fef3c7",
            border: `1px solid ${syncResult.success ? "#bbf7d0" : "#fcd34d"}`,
            borderRadius: 4,
            fontSize: 12,
            marginBottom: 12,
          }}
        >
          {syncResult.success ? "✓" : "⚠"} Sync:
          {" "}<b>{syncResult.created ?? 0}</b> new block(s) pushed,
          {" "}<b>{syncResult.removed ?? 0}</b> cleared,
          {" "}<b>{syncResult.unchanged ?? 0}</b> unchanged.
          {syncResult.failures && syncResult.failures.length > 0 && (
            <div style={{ marginTop: 4, color: "#92400e" }}>
              {syncResult.failures.length} failure(s): {syncResult.failures.slice(0, 3).map((f: any) => f.error).join(" · ")}
            </div>
          )}
        </div>
      )}

      {/* ── Heatmap ──────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {Object.entries(byMonth).map(([monthKey, weekRows]) => {
          const [y, m] = monthKey.split("-");
          const monthName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m) - 1];
          return (
            <div key={monthKey}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                {monthName} {y}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {weekRows.map((r) => {
                  const colors = verdictColor(r.verdict);
                  const idx = results.indexOf(r);
                  const selectedMe = selectedIdx === idx;
                  return (
                    <div
                      key={r.startDate}
                      onClick={() => setSelectedIdx(idx)}
                      style={{
                        border: `2px solid ${selectedMe ? "#2563eb" : colors.border}`,
                        background: colors.bg,
                        color: colors.fg,
                        borderRadius: 6,
                        padding: "6px 10px",
                        minWidth: 110,
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      <div style={{ fontSize: 10, opacity: 0.8 }}>{fmtShort(r.startDate)} → {fmtShort(r.endDate)}</div>
                      <div style={{ fontWeight: 700, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em", marginTop: 2 }}>
                        {r.overridden ? `forced ${r.overrideMode === "force-open" ? "open" : "blocked"}` : r.verdict}
                      </div>
                      {typeof r.maxSets === "number" && !r.overridden && (
                        <div style={{ fontSize: 10, opacity: 0.8 }}>
                          {r.maxSets} set{r.maxSets === 1 ? "" : "s"} / need {r.minSets ?? minSets}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Detail panel for the selected week ───────────────── */}
      {selected && (
        <div style={{ marginTop: 18, padding: 16, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                Week of {fmtShort(selected.startDate)} → {fmtShort(selected.endDate)}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                Verdict: <b style={{ color: verdictColor(selected.verdict).fg }}>{selected.verdict}</b>
                {typeof selected.maxSets === "number" && <> · {selected.maxSets} set{selected.maxSets === 1 ? "" : "s"} found · need {selected.minSets ?? minSets}</>}
                {selected.listingCounts && (
                  <> · listings: {Object.entries(selected.listingCounts).map(([br, n]) => `${br}BR=${n}`).join(" · ")}</>
                )}
              </div>
              {selected.overridden && (
                <div style={{ fontSize: 11, color: "#92400e", marginTop: 4 }}>
                  ⚠ Manual override: {selected.overrideMode === "force-open" ? "forced open" : "forced blocked"}
                  {selected.overrideNote && ` — ${selected.overrideNote}`}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="glb-btn"
                onClick={() => applyOverride(selected, "force-open")}
                style={{ fontSize: 11 }}
                title="Force this week to be bookable regardless of inventory"
              >
                Force open
              </button>
              <button
                className="glb-btn"
                onClick={() => applyOverride(selected, "force-block")}
                style={{ fontSize: 11 }}
                title="Force this week to be blocked regardless of inventory"
              >
                Force block
              </button>
              {selected.overridden && (
                <button
                  className="glb-btn"
                  onClick={() => applyOverride(selected, null)}
                  style={{ fontSize: 11 }}
                >
                  Clear override
                </button>
              )}
            </div>
          </div>

          {/* Candidate inventory — same listings power every week, listed
              here so the operator can spot-check a few before booking. */}
          {selected.sample && Object.keys(selected.sample).length > 0 ? (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Sample candidate listings at this resort
              </div>
              {Object.entries(selected.sample).map(([br, listings]) => (
                <div key={br} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: "#374151", marginBottom: 2 }}>
                    <b>{br}BR</b>{" "}
                    <span style={{ color: "#6b7280" }}>({selected.listingCounts?.[br] ?? listings.length} found · {listings.length} shown)</span>
                  </div>
                  {listings.length === 0 ? (
                    <div style={{ fontSize: 11, color: "#9ca3af", paddingLeft: 12 }}>None found.</div>
                  ) : (
                    listings.map((l) => (
                      <div key={l.id} style={{ fontSize: 11, paddingLeft: 12, lineHeight: 1.5 }}>
                        <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: "#2563eb", textDecoration: "underline" }}>
                          {l.title || `Airbnb ${l.id}`}
                        </a>
                      </div>
                    ))
                  )}
                </div>
              ))}
              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 6 }}>
                Inventory count is the same for every week in this scan — daily re-runs catch listings appearing/disappearing.
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              {selected.verdict === "blocked" && "No inventory found at this resort for the required bedroom mix. Will be blocked on Guesty if you click Sync."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
