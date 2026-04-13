import { useState, useEffect, useCallback } from "react";
import { guestyService } from "@/services/guestyService";
import type { GuestyPropertyData, GuestyChannelStatus, BuildStepEntry } from "@/services/guestyService";

// ─── CSS — Light theme ────────────────────────────────────────────────────────
const CSS = `
  .glb {
    --bg: #ffffff;
    --bg-card: #f9fafb;
    --bg-hover: #f3f4f6;
    --border: #e5e7eb;
    --border-focus: #d1d5db;
    --green: #16a34a;
    --green-bg: #f0fdf4;
    --green-border: #bbf7d0;
    --red: #dc2626;
    --red-bg: #fef2f2;
    --red-border: #fecaca;
    --amber: #d97706;
    --amber-bg: #fffbeb;
    --amber-border: #fde68a;
    --blue: #2563eb;
    --text: #111827;
    --muted: #6b7280;
    --faint: #9ca3af;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 28px 32px;
    box-sizing: border-box;
  }
  .glb * { box-sizing: border-box; }

  /* Header */
  .glb-hdr { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:14px; margin-bottom:28px; }
  .glb-hdr h1 { font-size:22px; font-weight:700; letter-spacing:-0.3px; margin:0 0 4px; color:var(--text); }
  .glb-hdr p { font-size:12px; color:var(--faint); margin:0; }

  /* Connection pill */
  .glb-pill { display:inline-flex; align-items:center; gap:7px; padding:6px 14px; border-radius:100px; font-size:12px; font-weight:500; cursor:pointer; border:1px solid transparent; transition:all .2s; user-select:none; white-space:nowrap; }
  .glb-pill.connected { background:var(--green-bg); border-color:var(--green-border); color:var(--green); }
  .glb-pill.disconnected { background:var(--red-bg); border-color:var(--red-border); color:var(--red); }
  .glb-pill.checking { background:var(--amber-bg); border-color:var(--amber-border); color:var(--amber); }
  .glb-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .glb-pill.connected .glb-dot { animation:glb-blink 2s ease-in-out infinite; }
  @keyframes glb-blink { 0%,100%{opacity:1} 50%{opacity:0.4} }

  /* Section label */
  .glb-section-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.6px; color:var(--faint); margin-bottom:10px; }

  /* Selector row */
  .glb-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:24px; }
  .glb-sel { background:#fff; border:1px solid var(--border); color:var(--text); padding:8px 12px; border-radius:8px; font-size:13px; flex:1; min-width:200px; max-width:420px; cursor:pointer; outline:none; transition:border-color .2s; }
  .glb-sel:focus { border-color:var(--border-focus); box-shadow:0 0 0 3px rgba(0,0,0,.05); }

  /* Buttons */
  .glb-btn { display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; border:1px solid transparent; transition:all .18s; white-space:nowrap; }
  .glb-btn:disabled { opacity:.45; cursor:not-allowed; }
  .glb-btn-primary { background:#111827; color:#fff; border-color:#111827; }
  .glb-btn-primary:not(:disabled):hover { background:#1f2937; }
  .glb-btn-secondary { background:#fff; color:#374151; border-color:var(--border); }
  .glb-btn-secondary:not(:disabled):hover { background:var(--bg-hover); border-color:var(--border-focus); }
  .glb-btn-danger { background:#fff; color:var(--red); border-color:var(--red-border); }
  .glb-btn-danger:not(:disabled):hover { background:var(--red-bg); }

  /* Channel grid */
  .glb-channels { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:24px; }
  @media(max-width:680px){ .glb-channels{grid-template-columns:1fr;} }
  .glb-ch { background:#fff; border:1px solid var(--border); border-radius:10px; padding:16px; transition:border-color .2s; }
  .glb-ch.live { border-color:var(--green-border); background:var(--green-bg); }
  .glb-ch.dead { border-color:var(--red-border); }
  .glb-ch-hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
  .glb-ch-name { font-size:13px; font-weight:600; display:flex; align-items:center; gap:8px; color:var(--text); }
  .glb-ch-icon { width:26px; height:26px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0; background:var(--bg-hover); }
  .glb-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:100px; font-size:11px; font-weight:500; border:1px solid transparent; }
  .glb-badge.live { background:var(--green-bg); border-color:var(--green-border); color:var(--green); }
  .glb-badge.not-live { background:var(--red-bg); border-color:var(--red-border); color:var(--red); }
  .glb-badge.no-account { background:var(--bg-hover); border-color:var(--border); color:var(--faint); }
  .glb-badge-dot { width:5px; height:5px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .glb-ch-meta { font-size:11px; color:var(--muted); margin-top:6px; font-family:monospace; word-break:break-all; }

  /* Data panel */
  .glb-panel { background:#fff; border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:20px; }
  .glb-tabs { display:flex; border-bottom:1px solid var(--border); overflow-x:auto; scrollbar-width:none; background:var(--bg-card); }
  .glb-tabs::-webkit-scrollbar { display:none; }
  .glb-tab { padding:11px 18px; font-size:12px; font-weight:500; cursor:pointer; color:var(--muted); border-bottom:2px solid transparent; transition:all .15s; white-space:nowrap; background:none; border-top:none; border-left:none; border-right:none; letter-spacing:.2px; text-transform:capitalize; margin-bottom:-1px; }
  .glb-tab:hover { color:var(--text); }
  .glb-tab.active { color:#111827; border-bottom-color:#111827; font-weight:600; }
  .glb-tab-body { padding:20px; min-height:200px; }

  /* Photos tab */
  .glb-photo-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:8px; }
  .glb-photo-thumb { aspect-ratio:4/3; border-radius:8px; overflow:hidden; position:relative; background:var(--bg-hover); border:1px solid var(--border); }
  .glb-photo-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .glb-photo-idx { position:absolute; top:5px; left:5px; background:rgba(0,0,0,.55); color:#fff; font-size:10px; padding:1px 6px; border-radius:3px; font-family:monospace; }

  /* Amenities tab */
  .glb-amenity-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:6px; }
  .glb-amenity { display:flex; align-items:center; gap:8px; padding:7px 10px; background:var(--bg-card); border:1px solid var(--border); border-radius:7px; font-size:12px; color:var(--muted); }
  .glb-amenity-check { color:var(--green); font-size:11px; flex-shrink:0; font-weight:700; }

  /* Descriptions tab */
  .glb-desc-block { margin-bottom:16px; }
  .glb-desc-label { font-size:10px; font-weight:600; color:var(--faint); text-transform:uppercase; letter-spacing:.7px; margin-bottom:6px; }
  .glb-desc-text { font-size:13px; color:#374151; line-height:1.65; background:var(--bg-card); border:1px solid var(--border); border-radius:7px; padding:10px 14px; white-space:pre-wrap; }

  /* Pricing tab */
  .glb-price-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(155px,1fr)); gap:10px; }
  .glb-price-card { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:14px; }
  .glb-price-label { font-size:10px; font-weight:600; color:var(--faint); text-transform:uppercase; letter-spacing:.7px; margin-bottom:6px; }
  .glb-price-val { font-size:22px; font-weight:700; color:var(--text); }
  .glb-price-cur { font-size:11px; color:var(--faint); margin-left:3px; }

  /* Build log */
  .glb-log { background:#fff; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  .glb-log-hdr { display:flex; align-items:center; justify-content:space-between; padding:13px 18px; border-bottom:1px solid var(--border); background:var(--bg-card); }
  .glb-log-title { font-size:12px; font-weight:600; color:var(--text); text-transform:uppercase; letter-spacing:.4px; }
  .glb-progress-wrap { height:3px; background:var(--border); }
  .glb-progress-bar { height:100%; background:var(--green); transition:width .4s ease; }
  .glb-log-list { padding:14px 18px; display:flex; flex-direction:column; gap:8px; max-height:260px; overflow-y:auto; }
  .glb-log-entry { display:flex; align-items:flex-start; gap:10px; font-size:12px; }
  .glb-log-icon { font-size:13px; flex-shrink:0; margin-top:1px; font-weight:700; }
  .glb-log-step { color:var(--muted); flex:1; }
  .glb-log-time { color:var(--faint); font-size:10px; font-family:monospace; }
  .glb-log-err { color:var(--red); font-size:11px; margin-top:2px; }

  /* Empty state */
  .glb-empty { display:flex; align-items:center; justify-content:center; padding:40px 20px; color:var(--faint); font-size:13px; }

  /* Error banner */
  .glb-error-banner { margin-top:20px; padding:14px 18px; background:var(--red-bg); border:1px solid var(--red-border); border-radius:10px; font-size:13px; color:var(--red); line-height:1.6; }

  /* Divider */
  .glb-divider { border:none; border-top:1px solid var(--border); margin:24px 0; }
`;

// ─── Types ────────────────────────────────────────────────────────────────────
type ConnState = "checking" | "connected" | "disconnected";
type GuestyListing = { _id: string; nickname?: string; title?: string };
type LogEntry = BuildStepEntry & { icon: string };

type Props = {
  propertyData?: GuestyPropertyData | null;
  onBuildComplete?: (result: { listingId: string | null }) => void;
  onUpdateComplete?: (result: { listingId: string | null }) => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const STEP_LABELS: Record<string, string> = {
  create_listing: "Creating listing shell",
  descriptions: "Pushing descriptions",
  photos: "Uploading photos",
  financials: "Setting pricing & fees",
  booking_settings: "Configuring booking rules",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusIcon(status: string) {
  if (status === "success") return "✓";
  if (status === "error") return "✗";
  return "…";
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function GuestyListingBuilder({ propertyData, onBuildComplete, onUpdateComplete }: Props) {
  const [conn, setConn] = useState<ConnState>("checking");
  const [listings, setListings] = useState<GuestyListing[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [channelStatus, setChannelStatus] = useState<GuestyChannelStatus | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [activeTab, setActiveTab] = useState<"photos" | "amenities" | "descriptions" | "pricing">("descriptions");
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);

  // ── Check connection + load listings ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function init() {
      setConn("checking");
      const result = await guestyService.checkConnection();
      if (cancelled) return;
      if (result.connected) {
        setConn("connected");
        try {
          const data = await guestyService.getListings(50, 0);
          if (!cancelled) setListings(data.results || []);
        } catch { /* non-fatal */ }
      } else {
        setConn("disconnected");
      }
    }
    init();
    return () => { cancelled = true; };
  }, []);

  // ── Load channel status when selection changes ─────────────────────────────
  useEffect(() => {
    if (!selectedId) { setChannelStatus(null); return; }
    setLoadingChannels(true);
    guestyService.getChannelStatus(selectedId)
      .then(setChannelStatus)
      .catch(() => setChannelStatus(null))
      .finally(() => setLoadingChannels(false));
  }, [selectedId]);

  // ── Build new listing ──────────────────────────────────────────────────────
  const handleBuild = useCallback(async () => {
    if (!propertyData || building) return;
    setBuilding(true);
    setLog([]);
    setProgress(0);

    const totalSteps = [true, !!propertyData.descriptions, !!(propertyData.photos?.length), !!propertyData.pricing, !!propertyData.bookingSettings].filter(Boolean).length;
    let done = 0;

    const result = await guestyService.buildFullListing(propertyData, (step, status) => {
      setLog((prev) => {
        const entry: LogEntry = { step, status: status as "pending" | "success" | "error", icon: statusIcon(status), timestamp: new Date().toISOString() };
        const idx = prev.findIndex((e) => e.step === step);
        if (idx >= 0) { const next = [...prev]; next[idx] = entry; return next; }
        return [...prev, entry];
      });
      if (status === "success" || status === "error") { done++; setProgress(Math.round((done / totalSteps) * 100)); }
    });

    setProgress(100);
    setBuilding(false);

    if (result.listingId) {
      const fresh = await guestyService.getListings(50, 0);
      setListings(fresh.results || []);
      setSelectedId(result.listingId);
    }
    onBuildComplete?.({ listingId: result.listingId });
  }, [propertyData, building, onBuildComplete]);

  // ── Push updates ──────────────────────────────────────────────────────────
  const handleUpdate = useCallback(async () => {
    if (!propertyData || !selectedId || building) return;
    setBuilding(true);
    setLog([]);
    setProgress(0);

    const totalSteps = [!!propertyData.descriptions, !!(propertyData.photos?.length), !!propertyData.pricing, !!propertyData.bookingSettings].filter(Boolean).length;
    let done = 0;

    const result = await guestyService.updateFullListing(selectedId, propertyData, (step, status) => {
      setLog((prev) => {
        const entry: LogEntry = { step, status: status as "pending" | "success" | "error", icon: statusIcon(status), timestamp: new Date().toISOString() };
        const idx = prev.findIndex((e) => e.step === step);
        if (idx >= 0) { const next = [...prev]; next[idx] = entry; return next; }
        return [...prev, entry];
      });
      if (status === "success" || status === "error") { done++; setProgress(Math.round((done / totalSteps) * 100)); }
    });

    setProgress(100);
    setBuilding(false);
    onUpdateComplete?.({ listingId: result.listingId });
  }, [propertyData, selectedId, building, onUpdateComplete]);

  const pillLabel = conn === "checking" ? "Checking connection…" : conn === "connected" ? "Guesty Connected" : "Guesty Disconnected";
  const photos = propertyData?.photos || [];
  const amenities = propertyData?.amenities || [];
  const descriptions = propertyData?.descriptions;
  const pricing = propertyData?.pricing;

  return (
    <>
      <style>{CSS}</style>
      <div className="glb">

        {/* ── Header ────────────────────────────────────────────── */}
        <div className="glb-hdr">
          <div>
            <h1>Build Listing on Guesty</h1>
            <p>Push this property to your Guesty account to list on Airbnb, VRBO, and Booking.com</p>
          </div>
          <button
            className={`glb-pill ${conn}`}
            onClick={() => {
              setConn("checking");
              guestyService.checkConnection().then((r) => setConn(r.connected ? "connected" : "disconnected"));
            }}
            data-testid="btn-guesty-connection"
            title="Click to retry connection"
          >
            <span className="glb-dot" />
            {pillLabel}
          </button>
        </div>

        {/* ── Selector + Actions ────────────────────────────────── */}
        <div className="glb-section-label">Existing Guesty Listings</div>
        <div className="glb-row">
          <select
            className="glb-sel"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            data-testid="select-guesty-listing"
            disabled={conn !== "connected"}
          >
            <option value="">— Select an existing listing to view or update —</option>
            {listings.map((l) => (
              <option key={l._id} value={l._id}>{l.nickname || l.title || l._id}</option>
            ))}
          </select>

          {selectedId && propertyData && (
            <button className="glb-btn glb-btn-secondary" onClick={handleUpdate} disabled={building || conn !== "connected"} data-testid="btn-push-updates">
              {building ? "Pushing…" : "↑ Push Updates"}
            </button>
          )}

          {selectedId && (
            <button className="glb-btn glb-btn-danger" onClick={() => guestyService.unlistFromChannels(selectedId)} disabled={building} data-testid="btn-unlist">
              Unlist
            </button>
          )}
        </div>

        {/* ── Build New ─────────────────────────────────────────── */}
        {propertyData && (
          <div style={{ marginBottom: 24 }}>
            <div className="glb-section-label">Create New Listing</div>
            <button
              className="glb-btn glb-btn-primary"
              onClick={handleBuild}
              disabled={building || conn !== "connected"}
              data-testid="btn-build-new-listing"
              style={{ fontSize: 14, padding: "10px 20px" }}
            >
              {building ? "⟳ Building listing…" : "+ Build New Listing on Guesty"}
            </button>
            <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 8 }}>
              Creates a new unlisted draft in Guesty — push descriptions, photos, pricing, and booking rules in one click.
            </p>
          </div>
        )}

        <hr className="glb-divider" />

        {/* ── Channel Status Grid ───────────────────────────────── */}
        {selectedId && (
          <>
            <div className="glb-section-label">Channel Status</div>
            <div className="glb-channels">
              {(["airbnb", "vrbo", "bookingCom"] as const).map((ch) => {
                const LABELS = { airbnb: "Airbnb", vrbo: "VRBO", bookingCom: "Booking.com" };
                const ICONS = { airbnb: "🏠", vrbo: "🏖️", bookingCom: "🔵" };
                const info = channelStatus?.[ch];
                const isLive = info?.live;
                const isConnected = info?.connected;
                const cardClass = `glb-ch ${isLive ? "live" : isConnected ? "dead" : ""}`;
                const badgeClass = `glb-badge ${isLive ? "live" : isConnected ? "not-live" : "no-account"}`;
                const badgeLabel = loadingChannels ? "…" : isLive ? "LIVE" : isConnected ? "Not Live" : "No Account";
                return (
                  <div key={ch} className={cardClass} data-testid={`channel-card-${ch}`}>
                    <div className="glb-ch-hdr">
                      <span className="glb-ch-name">
                        <span className="glb-ch-icon">{ICONS[ch]}</span>
                        {LABELS[ch]}
                      </span>
                      <span className={badgeClass}>
                        {!loadingChannels && <span className="glb-badge-dot" />}
                        {badgeLabel}
                      </span>
                    </div>
                    {info?.id && <div className="glb-ch-meta">ID: {info.id}</div>}
                    {info?.status && <div className="glb-ch-meta">Status: {info.status}</div>}
                  </div>
                );
              })}
            </div>
            <hr className="glb-divider" />
          </>
        )}

        {/* ── Data Preview Panel ────────────────────────────────── */}
        {propertyData && (
          <>
            <div className="glb-section-label">Property Data Preview</div>
            <div className="glb-panel">
              <div className="glb-tabs">
                {(["descriptions", "amenities", "pricing", "photos"] as const).map((t) => (
                  <button key={t} className={`glb-tab ${activeTab === t ? "active" : ""}`} onClick={() => setActiveTab(t)} data-testid={`tab-${t}`}>
                    {t === "photos" ? `Photos (${photos.length})` : t === "amenities" ? `Amenities (${amenities.length})` : t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              <div className="glb-tab-body">

                {activeTab === "descriptions" && (
                  descriptions
                    ? <div>
                        {(Object.entries(descriptions) as [string, string | undefined][]).map(([key, val]) =>
                          val ? (
                            <div key={key} className="glb-desc-block">
                              <div className="glb-desc-label">{key.replace(/([A-Z])/g, " $1").trim()}</div>
                              <div className="glb-desc-text">{val}</div>
                            </div>
                          ) : null
                        )}
                      </div>
                    : <div className="glb-empty">No descriptions provided</div>
                )}

                {activeTab === "amenities" && (
                  amenities.length > 0
                    ? <div className="glb-amenity-grid">
                        {amenities.map((a) => (
                          <div key={a} className="glb-amenity">
                            <span className="glb-amenity-check">✓</span>
                            {a.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}
                          </div>
                        ))}
                      </div>
                    : <div className="glb-empty">No amenities listed</div>
                )}

                {activeTab === "pricing" && (
                  pricing
                    ? <div className="glb-price-grid">
                        {[
                          { label: "Base Price / Night", val: pricing.basePrice != null ? `$${pricing.basePrice}` : null },
                          { label: "Weekend Price", val: pricing.weekendBasePrice != null ? `$${pricing.weekendBasePrice}` : null },
                          { label: "Cleaning Fee", val: pricing.cleaningFee != null ? `$${pricing.cleaningFee}` : null },
                          { label: "Security Deposit", val: pricing.securityDeposit != null ? `$${pricing.securityDeposit}` : null },
                          { label: "Extra Person Fee", val: pricing.extraPersonFee != null ? `$${pricing.extraPersonFee}` : null },
                          { label: "Guests Included", val: pricing.guestsIncluded != null ? `${pricing.guestsIncluded}` : null },
                          { label: "Weekly Discount", val: pricing.weeklyDiscount != null ? `${Math.round((1 - pricing.weeklyDiscount) * 100)}% off` : null },
                          { label: "Monthly Discount", val: pricing.monthlyDiscount != null ? `${Math.round((1 - pricing.monthlyDiscount) * 100)}% off` : null },
                          { label: "Currency", val: pricing.currency || "USD" },
                        ].filter((r) => r.val != null).map((r) => (
                          <div key={r.label} className="glb-price-card">
                            <div className="glb-price-label">{r.label}</div>
                            <div className="glb-price-val">{r.val}</div>
                          </div>
                        ))}
                      </div>
                    : <div className="glb-empty">No pricing data</div>
                )}

                {activeTab === "photos" && (
                  photos.length > 0
                    ? <div className="glb-photo-grid">
                        {photos.map((p, i) => (
                          <div key={i} className="glb-photo-thumb">
                            <img src={p.url} alt={p.caption || `Photo ${i + 1}`} loading="lazy" />
                            <span className="glb-photo-idx">{i + 1}</span>
                          </div>
                        ))}
                      </div>
                    : <div className="glb-empty">No photos attached to this property</div>
                )}

              </div>
            </div>
          </>
        )}

        {/* ── Build Log ─────────────────────────────────────────── */}
        {log.length > 0 && (
          <div className="glb-log" style={{ marginTop: 20 }}>
            <div className="glb-log-hdr">
              <span className="glb-log-title">Build Progress</span>
              <span style={{ fontSize: 12, color: "#9ca3af" }}>{progress}% complete</span>
            </div>
            <div className="glb-progress-wrap">
              <div className="glb-progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="glb-log-list" data-testid="build-log">
              {log.map((entry, i) => (
                <div key={i} className="glb-log-entry">
                  <span className="glb-log-icon" style={{
                    color: entry.status === "success" ? "#16a34a" : entry.status === "error" ? "#dc2626" : "#d97706"
                  }}>{entry.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div className="glb-log-step">{STEP_LABELS[entry.step] || entry.step}</div>
                    {entry.error && <div className="glb-log-err">{entry.error}</div>}
                  </div>
                  <span className="glb-log-time">{fmt(entry.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Error banner ──────────────────────────────────────── */}
        {conn === "disconnected" && (
          <div className="glb-error-banner">
            <strong>Cannot connect to Guesty.</strong> Make sure <code>GUESTY_CLIENT_ID</code> and <code>GUESTY_CLIENT_SECRET</code> are set in the Replit Secrets tab, then click the connection pill above to retry.
          </div>
        )}

      </div>
    </>
  );
}
