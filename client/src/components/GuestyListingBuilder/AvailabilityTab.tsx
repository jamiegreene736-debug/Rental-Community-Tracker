// Availability / inventory scanner UI — phase 1+2 rewrite (Apr 2026).
//
// Replaces the old "shopping list of buy-ins" UX with a safety-guarantee
// heatmap: 52 rolling 7-day windows, each colored by how many independent
// complete buy-in SETS exist. Windows where we can't find enough sets
// get pushed as unavailable blocks to Guesty's calendar so they can't
// be oversold.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  // Default to 24 months — matches how Guesty's calendar horizon is typically
  // set, and gives the scanner enough lookahead to catch high-season buy-in
  // spikes when rates start publishing.
  const [weeks, setWeeks] = useState(104);
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
  // Weekly-pricing correlation state (populated after a scan + button click)
  type WeeklyPricingRow = {
    startDate: string;
    endDate: string;
    verdict: "open" | "tight" | "blocked";
    baseNightly: number;
    demandFactor: number;
    baseOnlyRate: number;
    targetRate: number;
    deltaVsBase: number;
  };
  const [pricingRows, setPricingRows] = useState<WeeklyPricingRow[] | null>(null);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [ratesSyncBusy, setRatesSyncBusy] = useState(false);
  const [ratesSyncResult, setRatesSyncResult] = useState<any>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Scheduler state (Phase 4)
  type Schedule = {
    id: number; propertyId: number; enabled: boolean;
    intervalHours: number;
    runInventory: boolean; runPricing: boolean; runSyncBlocks: boolean;
    targetMargin: string | number; minSets: number;
    lastRunAt: string | null; lastRunStatus: string | null; lastRunSummary: string | null;
  };
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [runNowBusy, setRunNowBusy] = useState(false);

  const fetchSchedule = useCallback(async () => {
    if (!propertyId) return;
    try {
      const r = await fetch(`/api/availability/schedule/${propertyId}`);
      const d = await r.json();
      setSchedule(d.schedule);
    } catch { /* ignore */ }
  }, [propertyId]);

  useEffect(() => {
    fetchSchedule();
    // Poll while a manual run is in flight so the lastRunSummary updates.
    const t = setInterval(fetchSchedule, 30_000);
    return () => clearInterval(t);
  }, [fetchSchedule]);

  const updateSchedule = useCallback(async (patch: Partial<Schedule>) => {
    if (!propertyId) return;
    try {
      const r = await fetch(`/api/availability/schedule/${propertyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      setSchedule(d.schedule);
    } catch { /* ignore */ }
  }, [propertyId]);

  // Auto-enable the scheduler for any property that's connected to a Guesty
  // listing. The historical default was `enabled: false`, which left many
  // connected properties with dormant schedules. Runs once, after the
  // initial fetch, when all three conditions hold: we have a Guesty
  // listingId, the schedule row is loaded, and it's currently disabled.
  // Declared *after* updateSchedule because the dep array references it —
  // putting the useEffect before updateSchedule hits a TDZ error.
  const autoEnableCheckedRef = useRef(false);
  useEffect(() => {
    if (autoEnableCheckedRef.current) return;
    if (!schedule || !listingId || !propertyId) return;
    if (schedule.enabled) { autoEnableCheckedRef.current = true; return; }
    autoEnableCheckedRef.current = true;
    updateSchedule({ enabled: true });
  }, [schedule, listingId, propertyId, updateSchedule]);

  const runNow = useCallback(async () => {
    if (!propertyId || runNowBusy) return;
    setRunNowBusy(true);
    try {
      await fetch(`/api/availability/run-now/${propertyId}`, { method: "POST" });
      // Pipeline runs in background; refresh status repeatedly until it
      // completes or 90s elapse.
      const start = Date.now();
      const startedAt = schedule?.lastRunAt ?? "";
      while (Date.now() - start < 90_000) {
        await new Promise((r) => setTimeout(r, 4000));
        const r = await fetch(`/api/availability/schedule/${propertyId}`);
        const d = await r.json();
        if (d.schedule?.lastRunAt && d.schedule.lastRunAt !== startedAt) {
          setSchedule(d.schedule);
          break;
        }
      }
    } finally {
      setRunNowBusy(false);
    }
  }, [propertyId, runNowBusy, schedule?.lastRunAt]);

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
    const blockedWindows = results.filter((r) => r.verdict === "blocked");
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
      // Enrich the receipt with when + the actual blocked date ranges that
      // got pushed. The server already tells us counts; adding a timestamp
      // and the list of blocked windows turns a vague "3 new" into a clear
      // audit trail.
      setSyncResult({
        ...data,
        syncedAt: new Date().toISOString(),
        blockedWindows: blockedWindows.map((w) => ({ startDate: w.startDate, endDate: w.endDate })),
      });
    } catch (e: any) {
      setSyncResult({ success: false, error: e?.message ?? String(e) });
    } finally {
      setSyncBusy(false);
    }
  }, [propertyId, results, minSets]);

  const computeWeeklyPricing = useCallback(async () => {
    if (!propertyId || results.length === 0) return;
    setPricingBusy(true);
    setPricingError(null);
    setPricingRows(null);
    try {
      const resp = await fetch(`/api/availability/weekly-pricing/${propertyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windows: results.map((r) => ({
            startDate: r.startDate,
            endDate: r.endDate,
            verdict: r.verdict,
          })),
          // 20% margin matches the scheduler default. If the scheduler row
          // has a different target margin configured for this property,
          // prefer that.
          targetMargin: schedule?.targetMargin != null
            ? parseFloat(String(schedule.targetMargin))
            : 0.20,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setPricingRows(data.rows);
    } catch (e: any) {
      setPricingError(e?.message ?? String(e));
    } finally {
      setPricingBusy(false);
    }
  }, [propertyId, results, schedule?.targetMargin]);

  const syncWeeklyRates = useCallback(async () => {
    if (!propertyId || !pricingRows || pricingRows.length === 0) return;
    setRatesSyncBusy(true);
    setRatesSyncResult(null);
    try {
      const resp = await fetch(`/api/availability/sync-weekly-rates/${propertyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: pricingRows }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setRatesSyncResult(data);
    } catch (e: any) {
      setRatesSyncResult({ ok: false, error: e?.message ?? String(e) });
    } finally {
      setRatesSyncBusy(false);
    }
  }, [propertyId, pricingRows]);

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
      {/* ── Scheduler card (Phase 4) ─────────────────────────── */}
      <div style={{
        marginBottom: 16, padding: "12px 14px",
        background: schedule?.enabled ? "#f0f9ff" : "var(--card)",
        border: `1px solid ${schedule?.enabled ? "#bae6fd" : "var(--border)"}`,
        borderRadius: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: schedule?.enabled ? "#075985" : "#374151" }}>
              ⏱ Auto-scan scheduler {schedule?.enabled ? "ON" : "OFF"}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
              When enabled, the server runs the inventory scan + price scan + Guesty block + rate sync every{" "}
              <b>{schedule?.intervalHours ?? 12}h</b> in the background.
              Last run: <b>{schedule?.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : "never"}</b>
              {schedule?.lastRunStatus && (
                <span style={{ color: schedule.lastRunStatus === "ok" ? "#16a34a" : "#dc2626", marginLeft: 6 }}>
                  ({schedule.lastRunStatus})
                </span>
              )}
              {schedule?.lastRunSummary && (
                <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
                  ↳ {schedule.lastRunSummary}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: 11, color: "#6b7280", display: "flex", alignItems: "center", gap: 4 }}>
              Every
              <select
                value={schedule?.intervalHours ?? 12}
                onChange={(e) => updateSchedule({ intervalHours: parseInt(e.target.value, 10) })}
                disabled={!schedule}
                style={{ padding: "2px 6px", fontSize: 11, border: "1px solid #e5e7eb", borderRadius: 4 }}
              >
                <option value={6}>6h</option>
                <option value={12}>12h</option>
                <option value={24}>24h</option>
                <option value={48}>48h</option>
              </select>
            </label>
            <button
              className="glb-btn"
              onClick={() => updateSchedule({ enabled: !schedule?.enabled })}
              style={{ fontSize: 11 }}
            >
              {schedule?.enabled ? "Disable" : "Enable"} auto-scan
            </button>
            <button
              className="glb-btn"
              onClick={runNow}
              disabled={runNowBusy}
              style={{ fontSize: 11 }}
            >
              {runNowBusy ? "Running…" : "▶ Run pipeline now"}
            </button>
          </div>
        </div>
        {schedule?.enabled && (
          <div style={{ marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "#6b7280" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={schedule.runInventory} onChange={(e) => updateSchedule({ runInventory: e.target.checked })} />
              Inventory check
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={schedule.runPricing} onChange={(e) => updateSchedule({ runPricing: e.target.checked })} />
              Price scan + rate push
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={schedule.runSyncBlocks} onChange={(e) => updateSchedule({ runSyncBlocks: e.target.checked })} />
              Sync blocks to Guesty
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              Min sets:
              <select
                value={schedule.minSets}
                onChange={(e) => updateSchedule({ minSets: parseInt(e.target.value, 10) })}
                style={{ padding: "1px 4px", fontSize: 11, border: "1px solid #e5e7eb", borderRadius: 4 }}
              >
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
                <option value={5}>5</option>
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              Margin:
              <input
                type="number"
                step="1"
                min="0"
                max="50"
                value={Math.round(parseFloat(String(schedule.targetMargin)) * 100)}
                onChange={(e) => updateSchedule({ targetMargin: parseFloat(e.target.value) / 100 })}
                style={{ width: 50, padding: "1px 4px", fontSize: 11, border: "1px solid #e5e7eb", borderRadius: 4 }}
              />%
            </label>
          </div>
        )}
      </div>

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
          <div>
            {syncResult.success ? "✓" : "⚠"}
            {" "}<b>On {syncResult.syncedAt ? new Date(syncResult.syncedAt).toLocaleString() : "now"}</b>
            {" — "}
            <b>{syncResult.created ?? 0}</b> new block(s) pushed to Guesty,
            {" "}<b>{syncResult.removed ?? 0}</b> cleared,
            {" "}<b>{syncResult.unchanged ?? 0}</b> unchanged.
          </div>
          {syncResult.blockedWindows && syncResult.blockedWindows.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#4b5563" }}>
              Blocked windows: {syncResult.blockedWindows.slice(0, 8).map((w: any) => `${fmtShort(w.startDate)}–${fmtShort(w.endDate)}`).join(", ")}
              {syncResult.blockedWindows.length > 8 && ` … +${syncResult.blockedWindows.length - 8} more`}
            </div>
          )}
          {syncResult.failures && syncResult.failures.length > 0 && (
            <div style={{ marginTop: 4, color: "#92400e" }}>
              {syncResult.failures.length} failure(s): {syncResult.failures.slice(0, 3).map((f: any) => f.error).join(" · ")}
            </div>
          )}
        </div>
      )}

      {/* ── 24-month summary table ──────────────────────────────
          Flat month-by-month view: one row per month over the scan
          horizon. Makes it obvious at a glance which months have
          blocks and which are clear, without scrolling through the
          per-week heatmap below. */}
      {results.length > 0 && (() => {
        // Generate a row for every month in the scanned horizon — even if
        // no windows land in it — so the table is dense, not sparse.
        const firstDate = results[0]?.startDate;
        const lastDate = results[results.length - 1]?.endDate ?? results[results.length - 1]?.startDate;
        if (!firstDate || !lastDate) return null;
        const start = new Date(firstDate + "T12:00:00");
        const end = new Date(lastDate + "T12:00:00");
        const months: string[] = [];
        const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
        const stop = new Date(end.getFullYear(), end.getMonth(), 1);
        while (cursor <= stop) {
          months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
          cursor.setMonth(cursor.getMonth() + 1);
        }
        return (
          <div style={{ marginBottom: 24, border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ padding: "8px 12px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", fontSize: 11, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {months.length}-Month Summary — blocks pushed to Guesty
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f9fafb", color: "#6b7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <th style={{ textAlign: "left", padding: "6px 12px", fontWeight: 600 }}>Month</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600 }}>Weeks</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600, color: "#166534" }}>Open</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600, color: "#92400e" }}>Tight</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600, color: "#991b1b" }}>Blocked</th>
                  <th style={{ textAlign: "left", padding: "6px 12px", fontWeight: 600 }}>Block dates</th>
                </tr>
              </thead>
              <tbody>
                {months.map((monthKey) => {
                  const [y, m] = monthKey.split("-");
                  const monthName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m) - 1];
                  const rows = byMonth[monthKey] ?? [];
                  const o = rows.filter((r) => r.verdict === "open").length;
                  const t = rows.filter((r) => r.verdict === "tight").length;
                  const b = rows.filter((r) => r.verdict === "blocked").length;
                  const blockLabels = rows.filter((r) => r.verdict === "blocked").map((r) => fmtShort(r.startDate)).join(", ");
                  return (
                    <tr key={monthKey} style={{ borderTop: "1px solid #f3f4f6", background: b > 0 ? "#fef2f2" : "transparent" }}>
                      <td style={{ padding: "6px 12px", fontWeight: 500 }}>{monthName} {y}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right", color: "#6b7280" }}>{rows.length}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right", color: o > 0 ? "#166534" : "#d1d5db" }}>{o}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right", color: t > 0 ? "#92400e" : "#d1d5db" }}>{t}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right", color: b > 0 ? "#991b1b" : "#d1d5db", fontWeight: b > 0 ? 600 : 400 }}>{b}</td>
                      <td style={{ padding: "6px 12px", color: "#991b1b", fontSize: 11 }}>{blockLabels || <span style={{ color: "#d1d5db" }}>—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* ── Weekly pricing correlation ──────────────────────────
          Per-week rate forecast that reacts to the scanner's demand
          signal. Tight weeks (inventory at or near the minSets floor)
          get a +12% demand markup; open weeks stay at baseline; blocked
          weeks are skipped (we're blocking, not pricing them). Push
          button applies the final rates to Guesty's calendar per-week
          instead of the coarser per-month push the scheduler does. */}
      {results.length > 0 && (
        <div style={{ marginBottom: 24, border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden" }}>
          <div style={{
            padding: "8px 12px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb",
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Weekly Pricing Correlation
            </span>
            <span style={{ fontSize: 11, color: "#6b7280" }}>
              Rates adjust upward when scanner verdict = <b>tight</b> (demand signal +12%). Blocked weeks skipped.
            </span>
            <div style={{ flex: 1 }} />
            {!pricingRows && (
              <button
                className="glb-btn"
                onClick={computeWeeklyPricing}
                disabled={pricingBusy}
                style={{ fontSize: 11 }}
              >
                {pricingBusy ? "Computing…" : "▶ Compute weekly rates"}
              </button>
            )}
            {pricingRows && (
              <button
                className="glb-btn"
                onClick={syncWeeklyRates}
                disabled={ratesSyncBusy || !listingId}
                title={!listingId ? "Select a Guesty listing first" : `Push ${pricingRows.filter((r) => r.verdict !== "blocked").length} weekly rates to Guesty`}
                style={{ fontSize: 11 }}
              >
                {ratesSyncBusy ? "Pushing…" : `↑ Push ${pricingRows.filter((r) => r.verdict !== "blocked").length} rates to Guesty`}
              </button>
            )}
            {pricingRows && (
              <button
                className="glb-btn"
                onClick={computeWeeklyPricing}
                disabled={pricingBusy}
                style={{ fontSize: 11 }}
              >
                {pricingBusy ? "Recomputing…" : "↺"}
              </button>
            )}
          </div>

          {pricingError && (
            <div style={{ padding: "8px 12px", background: "#fee2e2", color: "#991b1b", fontSize: 12 }}>
              {pricingError}
            </div>
          )}
          {ratesSyncResult && (
            <div style={{
              padding: "8px 12px",
              background: ratesSyncResult.ok ? "#f0fdf4" : "#fef3c7",
              borderBottom: "1px solid #e5e7eb",
              fontSize: 12,
            }}>
              {ratesSyncResult.ok ? "✓" : "⚠"}
              {" "}<b>On {new Date(ratesSyncResult.syncedAt ?? Date.now()).toLocaleString()}</b>
              {" — "}pushed <b>{ratesSyncResult.pushed ?? 0}</b> of <b>{ratesSyncResult.total ?? 0}</b> weekly rates to Guesty
              {ratesSyncResult.failures && ratesSyncResult.failures.length > 0 && (
                <span style={{ color: "#92400e" }}>, {ratesSyncResult.failures.length} failed</span>
              )}
              {ratesSyncResult.error && <span style={{ color: "#991b1b" }}> — {ratesSyncResult.error}</span>}
            </div>
          )}
          {pricingRows && pricingRows.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f9fafb", color: "#6b7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <th style={{ textAlign: "left", padding: "6px 12px", fontWeight: 600 }}>Week</th>
                  <th style={{ textAlign: "left", padding: "6px 12px", fontWeight: 600 }}>Verdict</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600 }}>Base cost / night</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600 }}>Baseline rate</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600 }}>Demand adj</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600 }}>Final rate</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", fontWeight: 600 }}>Δ vs base</th>
                </tr>
              </thead>
              <tbody>
                {pricingRows.map((r) => {
                  const isTight = r.verdict === "tight";
                  const isBlocked = r.verdict === "blocked";
                  const bgColor = isBlocked ? "#fef2f2" : isTight ? "#fef3c7" : "transparent";
                  return (
                    <tr key={r.startDate} style={{ borderTop: "1px solid #f3f4f6", background: bgColor }}>
                      <td style={{ padding: "5px 12px", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                        {fmtShort(r.startDate)} → {fmtShort(r.endDate)}
                      </td>
                      <td style={{ padding: "5px 12px" }}>
                        <span style={{
                          fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3,
                          background: isBlocked ? "#fee2e2" : isTight ? "#fde68a" : "#d1fae5",
                          color: isBlocked ? "#991b1b" : isTight ? "#92400e" : "#166534",
                          textTransform: "uppercase", letterSpacing: "0.04em",
                        }}>{r.verdict}</span>
                      </td>
                      <td style={{ padding: "5px 12px", textAlign: "right", color: "#6b7280" }}>${r.baseNightly}</td>
                      <td style={{ padding: "5px 12px", textAlign: "right", color: "#6b7280" }}>${r.baseOnlyRate}</td>
                      <td style={{ padding: "5px 12px", textAlign: "right", color: isTight ? "#92400e" : "#6b7280", fontWeight: isTight ? 600 : 400 }}>
                        {r.demandFactor === 0 ? "—" : r.demandFactor === 1 ? "1.00×" : `${r.demandFactor.toFixed(2)}×`}
                      </td>
                      <td style={{ padding: "5px 12px", textAlign: "right", fontWeight: 600, color: isBlocked ? "#9ca3af" : "#111827" }}>
                        {isBlocked ? "—" : `$${r.targetRate}`}
                      </td>
                      <td style={{ padding: "5px 12px", textAlign: "right", fontWeight: 600, color: r.deltaVsBase > 0 ? "#b45309" : r.deltaVsBase < 0 ? "#166534" : "#9ca3af" }}>
                        {isBlocked ? "—" : r.deltaVsBase === 0 ? "0%" : `${r.deltaVsBase > 0 ? "+" : ""}${(r.deltaVsBase * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!pricingRows && !pricingBusy && (
            <div style={{ padding: "12px 16px", fontSize: 12, color: "#6b7280", textAlign: "center" }}>
              Click <b>Compute weekly rates</b> to see per-week pricing based on this scan's tightness signal.
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
