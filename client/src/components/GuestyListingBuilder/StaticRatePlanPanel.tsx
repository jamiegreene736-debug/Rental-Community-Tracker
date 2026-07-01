import { useCallback, useEffect, useState } from "react";

// Pricing-tab panel for the Claude-generated STATIC seasonal rate plan
// (server/static-rate-engine.ts). Replaces the live-SearchAPI "research
// confirmation" provenance with the actual researched anchors: one rate per
// LOW/HIGH/HOLIDAY per year, for the rolling 24-month calendar. Each anchor is
// editable and lockable — locked anchors survive regeneration, and every anchor
// still flows through the 20% markup + Guesty push unchanged.

type Season = "LOW" | "HIGH" | "HOLIDAY";
type YearKey = "year1" | "year2";

type SeasonAnchors = { LOW: number; HIGH: number; HOLIDAY: number };
type CommunityConfirmation = {
  community: string;
  searchLabel: string;
  expectedCity?: string;
  expectedState?: string;
  nameMatch: boolean;
  cityMatch: boolean;
  stateMatch: boolean;
  locationMatch: boolean;
  curated: boolean;
  claudeConfirmed?: boolean;
  verifiedResort?: string;
  confirmed: boolean;
  detail: string;
};
type ChannelEvidence = {
  season: Season;
  year: 1 | 2;
  channel: string;
  sourceUrl?: string;
  stayNights: number;
  rentNightly: number;
  cleaningPerStay: number | null;
  serviceFeePct: number | null;
  feesObserved: boolean;
  allInNightly: number;
  feeBasis: "all-in-observed" | "grossed-up";
};
type SeasonReconciliation = {
  season: Season;
  year: 1 | 2;
  chosen: number;
  channel: string | null;
  rule: string;
  spread: { min: number; median: number; max: number; n: number };
  dropped: string[];
};
type BedroomPlan = {
  bedrooms: number;
  anchors: { year1: SeasonAnchors; year2: SeasonAnchors };
  locks: { year1?: Partial<Record<Season, boolean>>; year2?: Partial<Record<Season, boolean>> };
  staticBasis: SeasonAnchors;
  confidence: number;
  reasoning: string;
  metricsUsed: string[];
  source?: string;
  generatedAt?: string;
  model?: string;
  summary?: string;
  communityConfirmation?: CommunityConfirmation;
  // ── ALL-IN provenance (optional; absent on legacy rows) ──
  allInBasis?: SeasonAnchors;
  evidence?: ChannelEvidence[];
  reconciliation?: SeasonReconciliation[];
  clampedSeasons?: string[];
  cleaningPerNight?: number;
};

const SEASONS: Season[] = ["LOW", "HIGH", "HOLIDAY"];
const YEARS: YearKey[] = ["year1", "year2"];
const SEASON_LABEL: Record<Season, string> = { LOW: "Low", HIGH: "High", HOLIDAY: "Holiday" };
const CHANNEL_LABEL: Record<string, string> = {
  pm: "PM/direct", resort: "Resort", vrbo: "VRBO", booking: "Booking.com", airbnb: "Airbnb", other: "Other",
};
const channelLabel = (c: string | null | undefined) => (c ? CHANNEL_LABEL[c] ?? c : "—");

function confidenceTone(score: number): { bg: string; fg: string } {
  if (score >= 80) return { bg: "#dcfce7", fg: "#166534" };
  if (score >= 55) return { bg: "#fef3c7", fg: "#92400e" };
  return { bg: "#fee2e2", fg: "#991b1b" };
}

export default function StaticRatePlanPanel({ propertyId, version }: { propertyId?: number; version?: number }) {
  const [plans, setPlans] = useState<BedroomPlan[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local edit buffer: `${bedrooms}:${year}:${season}` -> string value.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingFor, setSavingFor] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (typeof propertyId !== "number" || propertyId === 0) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/property/${propertyId}/static-rate`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setPlans(Array.isArray(data?.bedrooms) ? data.bedrooms : []);
      setEdits({});
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setPlans(null);
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    load();
  }, [load, version]);

  const cellKey = (b: number, y: YearKey, s: Season) => `${b}:${y}:${s}`;

  const saveBedroom = useCallback(async (plan: BedroomPlan) => {
    if (typeof propertyId !== "number") return;
    setSavingFor(plan.bedrooms);
    try {
      for (const y of YEARS) {
        for (const s of SEASONS) {
          const key = cellKey(plan.bedrooms, y, s);
          const editVal = edits[key];
          const locked = !!plan.locks?.[y]?.[s];
          const current = plan.anchors[y][s];
          const next = editVal != null && editVal !== "" ? Math.round(Number(editVal)) : current;
          // Only POST when the value actually changed (lock toggles POST inline).
          if (editVal != null && Number.isFinite(next) && next > 0 && next !== current) {
            await fetch(`/api/property/${propertyId}/static-rate/override`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bedrooms: plan.bedrooms, year: y, season: s, value: next, locked }),
            });
          }
        }
      }
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSavingFor(null);
    }
  }, [edits, load, propertyId]);

  const toggleLock = useCallback(async (plan: BedroomPlan, y: YearKey, s: Season) => {
    if (typeof propertyId !== "number") return;
    const nextLocked = !plan.locks?.[y]?.[s];
    try {
      await fetch(`/api/property/${propertyId}/static-rate/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bedrooms: plan.bedrooms, year: y, season: s, locked: nextLocked }),
      });
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [load, propertyId]);

  if (typeof propertyId !== "number" || propertyId === 0) return null;

  return (
    <div style={{ marginTop: 8, marginBottom: 4, padding: "10px 12px", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 11, color: "#374151" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, color: "#111827", fontSize: 12 }}>📊 Static rate plan</span>
        <span style={{ color: "#6b7280" }}>Claude web-researches PM / VRBO / Booking.com / Airbnb for the real buy-in cost · ALL-IN nightly (rent + cleaning + service + taxes, amortized over a 7-night stay) · ONE rate per Low/High/Holiday per year, rolling 24 months · markup on push · per-unit rows are summed for the combo</span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          style={{ marginLeft: "auto", fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid #d1d5db", background: loading ? "#f3f4f6" : "#fff", cursor: loading ? "wait" : "pointer" }}
        >
          {loading ? "Loading…" : "↻ Reload"}
        </button>
      </div>

      {(() => {
        const conf = plans?.find((p) => p.communityConfirmation)?.communityConfirmation;
        if (!conf) return null;
        const ok = conf.confirmed;
        const loc = [conf.expectedCity, conf.expectedState].filter(Boolean).join(", ");
        return (
          <div
            style={{
              marginBottom: 8,
              padding: "7px 10px",
              borderRadius: 6,
              border: `1px solid ${ok ? "#bbf7d0" : "#fde68a"}`,
              background: ok ? "#f0fdf4" : "#fffbeb",
              color: ok ? "#166534" : "#92400e",
            }}
            title={conf.detail}
          >
            <div style={{ fontWeight: 700, marginBottom: 2 }}>
              {ok ? "✓ Community confirmed" : "⚠ Confirm community"} — {conf.detail}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 11 }}>
              <span><span style={{ color: "#6b7280" }}>Listing community:</span> <b>{conf.community}</b></span>
              {loc && <span><span style={{ color: "#6b7280" }}>Location:</span> <b>{loc}</b></span>}
              <span><span style={{ color: "#6b7280" }}>Researching:</span> <b>{conf.searchLabel}</b></span>
              <span style={{ color: (conf.nameMatch || conf.claudeConfirmed) ? "#166534" : "#92400e" }}>
                Name {conf.nameMatch ? "✓" : conf.claudeConfirmed ? "✓ (Claude-verified)" : conf.curated ? "(curated)" : "✕"}
              </span>
              <span style={{ color: conf.locationMatch ? "#166534" : "#92400e" }}>
                Location {conf.locationMatch ? "✓" : "✕"}
              </span>
              {conf.verifiedResort && (
                <span style={{ color: "#6b7280" }} title="The resort Claude confirmed via web search">
                  Verified: {conf.verifiedResort}
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {error && <div style={{ color: "#991b1b", marginBottom: 6 }}>Couldn’t load static rates: {error}</div>}
      {!error && plans && plans.length === 0 && (
        <div style={{ color: "#6b7280" }}>No static rate plan yet. Click “Update Market Rates Now” to have Claude research this resort and generate one.</div>
      )}

      {plans && plans.map((plan) => {
        const tone = confidenceTone(plan.confidence ?? 0);
        const isFallback = plan.source === "static-fallback";
        const evidence = Array.isArray(plan.evidence) ? plan.evidence : [];
        const hasEvidence = evidence.length > 0;
        const estimatedFees = isFallback || !hasEvidence || evidence.some((e) => e.feeBasis !== "all-in-observed");
        const clamped = Array.isArray(plan.clampedSeasons) ? plan.clampedSeasons : [];
        const recon = Array.isArray(plan.reconciliation) ? plan.reconciliation : [];
        return (
          <div key={plan.bedrooms} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px dashed #e5e7eb" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <span style={{ fontWeight: 700, color: "#111827" }}>{plan.bedrooms}BR</span>
              <span style={{ padding: "1px 7px", borderRadius: 4, background: tone.bg, color: tone.fg, fontWeight: 600 }}>
                {plan.confidence ?? 0}% confidence
              </span>
              {isFallback ? (
                <span title="Web research was unavailable; rates fell back to the operator buy-in table × season multipliers." style={{ padding: "1px 7px", borderRadius: 4, background: "#fef3c7", color: "#92400e", fontWeight: 500 }}>
                  ⚠ table fallback (no web research)
                </span>
              ) : (
                <span title={`Researched with ${plan.model ?? "Claude"} via web search.`} style={{ padding: "1px 7px", borderRadius: 4, background: "#ede9fe", color: "#5b21b6", fontWeight: 500 }}>
                  🔎 web-researched{plan.model ? ` · ${plan.model}` : ""}
                </span>
              )}
              {hasEvidence && (
                <span title="Number of real channel data points (PM/VRBO/Booking/Airbnb) reconciled into these anchors." style={{ padding: "1px 7px", borderRadius: 4, background: "#e0f2fe", color: "#075985", fontWeight: 500 }}>
                  {evidence.length} channel comp{evidence.length === 1 ? "" : "s"}
                </span>
              )}
              {estimatedFees && (
                <span title="Some cleaning/service fees weren't shown on the source page, so they were estimated from regional defaults before taxes were applied." style={{ padding: "1px 7px", borderRadius: 4, background: "#fef3c7", color: "#92400e", fontWeight: 500 }}>
                  ⚠ some fees estimated
                </span>
              )}
              {clamped.length > 0 && (
                <span title={`These season anchors hit the sanity clamp (0.55×–3× of the all-in basis): ${clamped.join(", ")}. Review/lock if a legit rate was capped.`} style={{ padding: "1px 7px", borderRadius: 4, background: "#fee2e2", color: "#991b1b", fontWeight: 500 }}>
                  clamped: {clamped.join(", ")}
                </span>
              )}
              {plan.generatedAt && (
                <span style={{ color: "#9ca3af" }}>· {new Date(plan.generatedAt).toLocaleDateString()}</span>
              )}
            </div>

            <table style={{ borderCollapse: "collapse", fontSize: 11, marginBottom: 4 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "2px 8px 2px 0", color: "#6b7280", fontWeight: 600 }}>Season</th>
                  {YEARS.map((y) => (
                    <th key={y} style={{ textAlign: "left", padding: "2px 8px", color: "#6b7280", fontWeight: 600 }}>{y === "year1" ? "Year 1" : "Year 2"}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SEASONS.map((s) => (
                  <tr key={s}>
                    <td style={{ padding: "2px 8px 2px 0", color: "#374151", fontWeight: 500 }}>
                      {SEASON_LABEL[s]}
                      <span style={{ color: "#9ca3af", marginLeft: 4 }} title="Operator table estimate (prior)">~${plan.staticBasis?.[s]}</span>
                    </td>
                    {YEARS.map((y) => {
                      const key = cellKey(plan.bedrooms, y, s);
                      const locked = !!plan.locks?.[y]?.[s];
                      const val = edits[key] != null ? edits[key] : String(plan.anchors[y][s]);
                      return (
                        <td key={y} style={{ padding: "2px 8px", whiteSpace: "nowrap" }}>
                          <span style={{ color: "#374151" }}>$</span>
                          <input
                            type="number"
                            value={val}
                            min={0}
                            onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                            style={{ width: 64, padding: "1px 4px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 11, background: locked ? "#f3f4f6" : "#fff" }}
                            title={locked ? "Locked — regeneration won’t overwrite this value." : "Editable. Locked anchors survive regeneration."}
                          />
                          <button
                            type="button"
                            onClick={() => toggleLock(plan, y, s)}
                            title={locked ? "Locked (click to unlock)" : "Unlocked (click to lock)"}
                            style={{ marginLeft: 4, border: "none", background: "transparent", cursor: "pointer", fontSize: 12, padding: 0 }}
                          >
                            {locked ? "🔒" : "🔓"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            {plan.reasoning && (
              <div style={{ color: "#6b7280", marginBottom: 4, maxWidth: 720 }}>
                <span style={{ fontWeight: 600, color: "#4b5563" }}>Why: </span>{plan.reasoning}
              </div>
            )}
            {plan.metricsUsed && plan.metricsUsed.length > 0 && (
              <div style={{ color: "#9ca3af", marginBottom: 4 }}>
                Sources: {plan.metricsUsed.join(", ")}
              </div>
            )}

            {(hasEvidence || plan.cleaningPerNight) && (
              <div style={{ marginTop: 2, marginBottom: 6, padding: "6px 8px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 5 }}>
                <div style={{ fontWeight: 600, color: "#4b5563", marginBottom: 3 }}>All-in buy-in (taxes + fees, 7-night sample)</div>
                {plan.cleaningPerNight ? (
                  <div style={{ color: "#92400e", marginBottom: 4 }}>
                    Includes ~${plan.cleaningPerNight}/night amortized cleaning. ⓘ Zero the Guesty guest-facing cleaning fee on this combo listing so the guest isn’t charged cleaning twice.
                  </div>
                ) : null}
                {recon.filter((r) => r.year === 1 && r.chosen > 0).length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, marginBottom: 4 }}>
                    {recon.filter((r) => r.year === 1 && r.chosen > 0).map((r, i) => (
                      <div key={i} style={{ color: "#374151" }}>
                        <b>{SEASON_LABEL[r.season]}</b> Yr 1 → <b>${r.chosen}</b>/night
                        {r.channel ? ` via ${channelLabel(r.channel)}` : ""}
                        {r.spread.n > 1 ? ` · ${r.spread.n} channels $${r.spread.min}–$${r.spread.max}` : ""}
                        {/(second-cheapest|tie-break)/.test(r.rule) ? ` · ${r.rule}` : ""}
                      </div>
                    ))}
                  </div>
                )}
                {hasEvidence && (
                  <details>
                    <summary style={{ cursor: "pointer", color: "#2563eb" }}>Channel evidence ({evidence.length})</summary>
                    <table style={{ borderCollapse: "collapse", fontSize: 10.5, marginTop: 4 }}>
                      <thead>
                        <tr style={{ color: "#6b7280" }}>
                          {["Season", "Channel", "Rent/n", "Clean", "Svc", "All-in/n", "Src"].map((h) => (
                            <th key={h} style={{ textAlign: "left", padding: "1px 6px 1px 0", fontWeight: 600 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {evidence.map((e, i) => (
                          <tr key={i} style={{ color: "#374151" }}>
                            <td style={{ padding: "1px 6px 1px 0", whiteSpace: "nowrap" }}>{SEASON_LABEL[e.season]} Y{e.year}</td>
                            <td style={{ padding: "1px 6px 1px 0" }}>{channelLabel(e.channel)}</td>
                            <td style={{ padding: "1px 6px 1px 0" }}>${e.rentNightly}{e.stayNights !== 7 ? ` (${e.stayNights}n)` : ""}</td>
                            <td style={{ padding: "1px 6px 1px 0" }}>{e.cleaningPerStay != null ? `$${e.cleaningPerStay}` : <span style={{ color: "#9ca3af" }}>est</span>}</td>
                            <td style={{ padding: "1px 6px 1px 0" }}>{e.serviceFeePct != null ? `${Math.round(e.serviceFeePct * 100)}%` : <span style={{ color: "#9ca3af" }}>est</span>}</td>
                            <td style={{ padding: "1px 6px 1px 0", fontWeight: 600 }}>${e.allInNightly}{e.feeBasis === "grossed-up" ? <span title="some fees estimated" style={{ color: "#92400e" }}> ~</span> : ""}</td>
                            <td style={{ padding: "1px 6px 1px 0" }}>{e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "#2563eb" }}>link</a> : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => saveBedroom(plan)}
              disabled={savingFor === plan.bedrooms}
              style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, border: "1px solid #2563eb", background: savingFor === plan.bedrooms ? "#bfdbfe" : "#2563eb", color: "#fff", cursor: savingFor === plan.bedrooms ? "wait" : "pointer", fontWeight: 600 }}
            >
              {savingFor === plan.bedrooms ? "Saving…" : "Save edits"}
            </button>
            <span style={{ color: "#9ca3af", marginLeft: 8 }}>Edits re-expand the 24-month calendar. Push to Guesty with “Update Market Rates Now”.</span>
          </div>
        );
      })}
    </div>
  );
}
