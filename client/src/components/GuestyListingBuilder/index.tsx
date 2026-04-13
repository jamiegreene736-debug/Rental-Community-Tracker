import { useState, useEffect, useCallback } from "react";
import { guestyService } from "@/services/guestyService";
import type { GuestyPropertyData, GuestyChannelStatus, BuildStepEntry } from "@/services/guestyService";

// ─── Inject fonts once ───────────────────────────────────────────────────────
const FONT_ID = "glb-fonts";
if (typeof document !== "undefined" && !document.getElementById(FONT_ID)) {
  const link = document.createElement("link");
  link.id = FONT_ID;
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&family=Inter:wght@300;400;500&display=swap";
  document.head.appendChild(link);
}

// ─── CSS ─────────────────────────────────────────────────────────────────────
const CSS = `
  .glb {
    --bg: #0A0C10;
    --bg-card: #111318;
    --bg-hover: #161A22;
    --border: #1E2330;
    --border-bright: #2A3045;
    --green: #00E676;
    --green-dim: rgba(0,230,118,0.12);
    --green-glow: 0 0 14px rgba(0,230,118,0.25);
    --red: #FF3B5C;
    --red-dim: rgba(255,59,92,0.12);
    --amber: #FFB300;
    --amber-dim: rgba(255,179,0,0.12);
    --blue: #448AFF;
    --text: #F0F2F8;
    --muted: #7B8299;
    --faint: #454D66;
    --ff-head: 'Syne', sans-serif;
    --ff-mono: 'JetBrains Mono', monospace;
    --ff-body: 'Inter', sans-serif;
    --r: 10px;
    --r-sm: 6px;
    font-family: var(--ff-body);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 28px 24px;
    box-sizing: border-box;
  }

  .glb * { box-sizing: border-box; }

  /* Header */
  .glb-hdr { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px; margin-bottom:28px; }
  .glb-hdr h1 { font-family:var(--ff-head); font-size:22px; font-weight:800; letter-spacing:-0.5px; margin:0 0 4px; }
  .glb-hdr p { font-family:var(--ff-mono); font-size:11px; color:var(--faint); text-transform:uppercase; letter-spacing:.5px; margin:0; }

  /* Connection pill */
  .glb-pill { display:flex; align-items:center; gap:8px; padding:7px 14px; border-radius:100px; font-size:12px; font-family:var(--ff-mono); font-weight:500; cursor:pointer; border:1px solid transparent; transition:all .2s; user-select:none; }
  .glb-pill.connected { background:var(--green-dim); border-color:rgba(0,230,118,.25); color:var(--green); }
  .glb-pill.disconnected { background:var(--red-dim); border-color:rgba(255,59,92,.25); color:var(--red); }
  .glb-pill.checking { background:var(--amber-dim); border-color:rgba(255,179,0,.25); color:var(--amber); }
  .glb-dot { width:8px; height:8px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .glb-pill.connected .glb-dot { animation:glb-blink 2s ease-in-out infinite; }
  @keyframes glb-blink { 0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(0,230,118,.5)} 50%{opacity:.7;box-shadow:0 0 0 5px transparent} }

  /* Selector row */
  .glb-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:24px; }
  .glb-sel { background:var(--bg-card); border:1px solid var(--border); color:var(--text); padding:9px 14px; border-radius:var(--r-sm); font-size:13px; font-family:var(--ff-body); flex:1; min-width:200px; max-width:400px; cursor:pointer; outline:none; }
  .glb-sel:focus { border-color:var(--border-bright); }

  /* Buttons */
  .glb-btn { display:inline-flex; align-items:center; gap:7px; padding:9px 16px; border-radius:var(--r-sm); font-size:12px; font-family:var(--ff-mono); font-weight:500; cursor:pointer; border:1px solid transparent; transition:all .18s; white-space:nowrap; letter-spacing:.3px; }
  .glb-btn:disabled { opacity:.4; cursor:not-allowed; }
  .glb-btn-primary { background:var(--green); color:#000; border-color:var(--green); }
  .glb-btn-primary:not(:disabled):hover { background:#33EE8A; box-shadow:var(--green-glow); }
  .glb-btn-secondary { background:transparent; color:var(--muted); border-color:var(--border); }
  .glb-btn-secondary:not(:disabled):hover { border-color:var(--border-bright); color:var(--text); background:var(--bg-hover); }
  .glb-btn-danger { background:transparent; color:var(--red); border-color:rgba(255,59,92,.25); }
  .glb-btn-danger:not(:disabled):hover { background:var(--red-dim); }

  /* Channel grid */
  .glb-channels { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:24px; }
  @media(max-width:680px){ .glb-channels{grid-template-columns:1fr;} }
  .glb-ch { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--r); padding:18px; transition:border-color .2s; }
  .glb-ch.live { border-color:rgba(0,230,118,.2); }
  .glb-ch.dead { border-color:rgba(255,59,92,.15); }
  .glb-ch-hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
  .glb-ch-name { font-family:var(--ff-head); font-size:14px; font-weight:700; display:flex; align-items:center; gap:8px; }
  .glb-ch-icon { width:28px; height:28px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:15px; flex-shrink:0; }
  .glb-badge { display:flex; align-items:center; gap:5px; padding:4px 10px; border-radius:100px; font-size:11px; font-family:var(--ff-mono); font-weight:500; border:1px solid transparent; }
  .glb-badge.live { background:var(--green-dim); border-color:rgba(0,230,118,.35); color:var(--green); }
  .glb-badge.not-live { background:var(--red-dim); border-color:rgba(255,59,92,.35); color:var(--red); }
  .glb-badge.no-account { background:transparent; border-color:var(--border); color:var(--faint); }
  .glb-badge-dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .glb-ch-meta { font-size:11px; color:var(--faint); font-family:var(--ff-mono); margin-top:8px; word-break:break-all; }

  /* Data panel */
  .glb-panel { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--r); overflow:hidden; margin-bottom:20px; }
  .glb-tabs { display:flex; border-bottom:1px solid var(--border); overflow-x:auto; scrollbar-width:none; }
  .glb-tabs::-webkit-scrollbar { display:none; }
  .glb-tab { padding:12px 18px; font-size:12px; font-family:var(--ff-mono); font-weight:500; cursor:pointer; color:var(--faint); border-bottom:2px solid transparent; transition:all .15s; white-space:nowrap; background:none; border-top:none; border-left:none; border-right:none; letter-spacing:.4px; text-transform:uppercase; margin-bottom:-1px; }
  .glb-tab:hover { color:var(--muted); }
  .glb-tab.active { color:var(--green); border-bottom-color:var(--green); }
  .glb-tab-body { padding:20px; min-height:220px; }

  /* Photos tab */
  .glb-photo-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; }
  .glb-photo-thumb { aspect-ratio:4/3; border-radius:var(--r-sm); overflow:hidden; position:relative; background:var(--bg-hover); border:1px solid var(--border); }
  .glb-photo-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .glb-photo-idx { position:absolute; top:5px; left:5px; background:rgba(0,0,0,.65); color:#fff; font-size:10px; font-family:var(--ff-mono); padding:2px 6px; border-radius:3px; }

  /* Amenities tab */
  .glb-amenity-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:6px; }
  .glb-amenity { display:flex; align-items:center; gap:8px; padding:7px 10px; background:var(--bg-hover); border:1px solid var(--border); border-radius:var(--r-sm); font-size:12px; color:var(--muted); }
  .glb-amenity-check { color:var(--green); font-size:11px; flex-shrink:0; }

  /* Descriptions tab */
  .glb-desc-block { margin-bottom:16px; }
  .glb-desc-label { font-size:10px; font-family:var(--ff-mono); color:var(--faint); text-transform:uppercase; letter-spacing:.8px; margin-bottom:6px; }
  .glb-desc-text { font-size:13px; color:var(--muted); line-height:1.6; background:var(--bg-hover); border:1px solid var(--border); border-radius:var(--r-sm); padding:10px 14px; white-space:pre-wrap; }

  /* Pricing tab */
  .glb-price-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .glb-price-card { background:var(--bg-hover); border:1px solid var(--border); border-radius:var(--r-sm); padding:14px; }
  .glb-price-label { font-size:10px; font-family:var(--ff-mono); color:var(--faint); text-transform:uppercase; letter-spacing:.8px; margin-bottom:6px; }
  .glb-price-val { font-size:20px; font-family:var(--ff-head); font-weight:700; color:var(--text); }
  .glb-price-cur { font-size:12px; color:var(--faint); font-family:var(--ff-mono); margin-left:3px; }

  /* Build log */
  .glb-log { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--r); overflow:hidden; }
  .glb-log-hdr { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border); }
  .glb-log-title { font-family:var(--ff-mono); font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .glb-progress-wrap { height:3px; background:var(--border); }
  .glb-progress-bar { height:100%; background:var(--green); transition:width .4s ease; }
  .glb-log-list { padding:14px 18px; display:flex; flex-direction:column; gap:8px; max-height:280px; overflow-y:auto; }
  .glb-log-entry { display:flex; align-items:flex-start; gap:10px; font-size:12px; font-family:var(--ff-mono); }
  .glb-log-icon { font-size:14px; flex-shrink:0; margin-top:1px; }
  .glb-log-step { color:var(--muted); flex:1; }
  .glb-log-time { color:var(--faint); font-size:10px; }
  .glb-log-err { color:var(--red); font-size:11px; margin-top:2px; }
  .glb-empty { display:flex; align-items:center; justify-content:center; padding:40px 20px; color:var(--faint); font-size:13px; font-family:var(--ff-mono); }
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
  if (status === "pending") return "…";
  return "·";
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function GuestyListingBuilder({ propertyData, onBuildComplete, onUpdateComplete }: Props) {
  const [conn, setConn] = useState<ConnState>("checking");
  const [listings, setListings] = useState<GuestyListing[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [channelStatus, setChannelStatus] = useState<GuestyChannelStatus | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [activeTab, setActiveTab] = useState<"photos" | "amenities" | "descriptions" | "pricing">("photos");
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);

  // ── Check connection + load listings on mount ──────────────────────────────
  useEffect(() => {
    async function init() {
      setConn("checking");
      const result = await guestyService.checkConnection();
      if (result.connected) {
        setConn("connected");
        try {
          const data = await guestyService.getListings(50, 0);
          setListings(data.results || []);
        } catch {
          // non-fatal
        }
      } else {
        setConn("disconnected");
      }
    }
    init();
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

    const totalSteps = [
      true,
      !!propertyData.descriptions,
      !!(propertyData.photos?.length),
      !!propertyData.pricing,
      !!propertyData.bookingSettings,
    ].filter(Boolean).length;

    let done = 0;

    const result = await guestyService.buildFullListing(propertyData, (step, status) => {
      setLog((prev) => {
        const idx = prev.findIndex((e) => e.step === step);
        const entry: LogEntry = {
          step,
          status: status as "pending" | "success" | "error",
          icon: statusIcon(status),
          timestamp: new Date().toISOString(),
        };
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = entry;
          return next;
        }
        return [...prev, entry];
      });
      if (status === "success" || status === "error") {
        done++;
        setProgress(Math.round((done / totalSteps) * 100));
      }
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

  // ── Push updates to existing listing ──────────────────────────────────────
  const handleUpdate = useCallback(async () => {
    if (!propertyData || !selectedId || building) return;
    setBuilding(true);
    setLog([]);
    setProgress(0);

    let done = 0;
    const totalSteps = [
      !!propertyData.descriptions,
      !!(propertyData.photos?.length),
      !!propertyData.pricing,
      !!propertyData.bookingSettings,
    ].filter(Boolean).length;

    const result = await guestyService.updateFullListing(selectedId, propertyData, (step, status) => {
      setLog((prev) => {
        const idx = prev.findIndex((e) => e.step === step);
        const entry: LogEntry = {
          step,
          status: status as "pending" | "success" | "error",
          icon: statusIcon(status),
          timestamp: new Date().toISOString(),
        };
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = entry;
          return next;
        }
        return [...prev, entry];
      });
      if (status === "success" || status === "error") {
        done++;
        setProgress(Math.round((done / totalSteps) * 100));
      }
    });

    setProgress(100);
    setBuilding(false);
    onUpdateComplete?.({ listingId: result.listingId });
  }, [propertyData, selectedId, building, onUpdateComplete]);

  const pillLabel =
    conn === "checking" ? "Checking…" :
    conn === "connected" ? "Guesty Connected" :
    "Guesty Disconnected";

  const photos = propertyData?.photos || [];
  const amenities = propertyData?.amenities || [];
  const descriptions = propertyData?.descriptions;
  const pricing = propertyData?.pricing;

  return (
    <>
      <style>{CSS}</style>
      <div className="glb">
        {/* Header */}
        <div className="glb-hdr">
          <div>
            <h1>Build Listing On Guesty</h1>
            <p>NexStay · Guesty Open API v1</p>
          </div>
          <button
            className={`glb-pill ${conn}`}
            onClick={() => { setConn("checking"); guestyService.checkConnection().then((r) => setConn(r.connected ? "connected" : "disconnected")); }}
            data-testid="btn-guesty-connection"
          >
            <span className="glb-dot" />
            {pillLabel}
          </button>
        </div>

        {/* Listing selector */}
        <div className="glb-row">
          <select
            className="glb-sel"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            data-testid="select-guesty-listing"
          >
            <option value="">— Select existing listing —</option>
            {listings.map((l) => (
              <option key={l._id} value={l._id}>
                {l.nickname || l.title || l._id}
              </option>
            ))}
          </select>

          {propertyData && (
            <button
              className="glb-btn glb-btn-primary"
              onClick={handleBuild}
              disabled={building || conn !== "connected"}
              data-testid="btn-build-new-listing"
            >
              {building ? "⟳ Building…" : "＋ Build New Listing"}
            </button>
          )}

          {selectedId && propertyData && (
            <button
              className="glb-btn glb-btn-secondary"
              onClick={handleUpdate}
              disabled={building || conn !== "connected"}
              data-testid="btn-push-updates"
            >
              ↑ Push Updates
            </button>
          )}

          {selectedId && (
            <button
              className="glb-btn glb-btn-danger"
              onClick={() => guestyService.unlistFromChannels(selectedId)}
              disabled={building}
              data-testid="btn-unlist"
            >
              Unlist
            </button>
          )}
        </div>

        {/* Channel status grid */}
        {(selectedId || loadingChannels) && (
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
        )}

        {/* Data stream panel */}
        {propertyData && (
          <div className="glb-panel">
            <div className="glb-tabs">
              {(["photos", "amenities", "descriptions", "pricing"] as const).map((t) => (
                <button
                  key={t}
                  className={`glb-tab ${activeTab === t ? "active" : ""}`}
                  onClick={() => setActiveTab(t)}
                  data-testid={`tab-${t}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="glb-tab-body">
              {activeTab === "photos" && (
                photos.length > 0
                  ? <div className="glb-photo-grid">
                      {photos.map((p, i) => (
                        <div key={i} className="glb-photo-thumb">
                          <img src={p.url} alt={p.caption || `Photo ${i + 1}`} />
                          <span className="glb-photo-idx">{i + 1}</span>
                        </div>
                      ))}
                    </div>
                  : <div className="glb-empty">No photos attached</div>
              )}

              {activeTab === "amenities" && (
                amenities.length > 0
                  ? <div className="glb-amenity-grid">
                      {amenities.map((a) => (
                        <div key={a} className="glb-amenity">
                          <span className="glb-amenity-check">✓</span>
                          {a.replace(/_/g, " ")}
                        </div>
                      ))}
                    </div>
                  : <div className="glb-empty">No amenities listed</div>
              )}

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

              {activeTab === "pricing" && (
                pricing
                  ? <div className="glb-price-grid">
                      {[
                        { label: "Base Price / Night", val: pricing.basePrice, prefix: "$" },
                        { label: "Weekend Price", val: pricing.weekendBasePrice, prefix: "$" },
                        { label: "Cleaning Fee", val: pricing.cleaningFee, prefix: "$" },
                        { label: "Security Deposit", val: pricing.securityDeposit, prefix: "$" },
                        { label: "Extra Person Fee", val: pricing.extraPersonFee, prefix: "$" },
                        { label: "Guests Included", val: pricing.guestsIncluded, prefix: "" },
                        { label: "Weekly Discount", val: pricing.weeklyDiscount != null ? `${Math.round((1 - pricing.weeklyDiscount) * 100)}%` : undefined, prefix: "" },
                        { label: "Monthly Discount", val: pricing.monthlyDiscount != null ? `${Math.round((1 - pricing.monthlyDiscount) * 100)}%` : undefined, prefix: "" },
                      ].filter((r) => r.val != null).map((r) => (
                        <div key={r.label} className="glb-price-card">
                          <div className="glb-price-label">{r.label}</div>
                          <div className="glb-price-val">
                            {r.prefix}{r.val}
                            {r.prefix === "$" && <span className="glb-price-cur">USD</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  : <div className="glb-empty">No pricing data</div>
              )}
            </div>
          </div>
        )}

        {/* Build log */}
        {log.length > 0 && (
          <div className="glb-log">
            <div className="glb-log-hdr">
              <span className="glb-log-title">Build Log</span>
              <span style={{ fontSize: 11, fontFamily: "var(--ff-mono)", color: "var(--faint)" }}>
                {progress}% complete
              </span>
            </div>
            <div className="glb-progress-wrap">
              <div className="glb-progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="glb-log-list" data-testid="build-log">
              {log.map((entry, i) => (
                <div key={i} className="glb-log-entry">
                  <span className="glb-log-icon" style={{
                    color: entry.status === "success" ? "var(--green)" : entry.status === "error" ? "var(--red)" : "var(--amber)"
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

        {conn === "disconnected" && (
          <div style={{
            marginTop: 20, padding: "14px 18px", background: "var(--red-dim)",
            border: "1px solid rgba(255,59,92,.25)", borderRadius: "var(--r)",
            fontFamily: "var(--ff-mono)", fontSize: 12, color: "var(--red)", lineHeight: 1.6
          }}>
            ✗ Cannot connect to Guesty. Make sure <strong>GUESTY_CLIENT_ID</strong> and <strong>GUESTY_CLIENT_SECRET</strong> are set in the Replit Secrets tab, then click the connection pill to retry.
          </div>
        )}
      </div>
    </>
  );
}
