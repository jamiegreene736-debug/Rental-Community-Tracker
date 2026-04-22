import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { guestyService } from "@/services/guestyService";
import type { GuestyPropertyData, GuestyChannelStatus, BuildStepEntry } from "@/services/guestyService";
import { getPropertyPricing, getSeasonLabel, getSeasonBgClass, minProfitableRate, netPayoutAfterChannelFee, CHANNEL_HOST_FEE, MIN_PROFIT_MARGIN, type ChannelKey } from "@/data/pricing-data";
import { GUESTY_AMENITY_CATALOG, getGuestyAmenities, type AmenityEntry } from "@/data/guesty-amenities";
import { buildListingRooms, parseSqft } from "@/data/guesty-listing-config";
import { BeddingTab } from "./BeddingTab";
import { getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import { useToast } from "@/hooks/use-toast";

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
  .glb-pill.rate-limited { background:var(--amber-bg); border-color:var(--amber-border); color:var(--amber); }
  .glb-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .glb-pill.connected .glb-dot { animation:glb-blink 2s ease-in-out infinite; }
  @keyframes glb-blink { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @keyframes glb-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

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
  .glb-photo-caption { position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,.6); color:#fff; font-size:10px; padding:3px 6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

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

  /* Seasonal rate table */
  .glb-season-hdr { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; color:var(--faint); margin:22px 0 10px; }
  .glb-season-table { width:100%; border-collapse:collapse; font-size:12px; }
  .glb-season-table th { text-align:left; padding:6px 10px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; color:var(--faint); border-bottom:1px solid var(--border); }
  .glb-season-table td { padding:7px 10px; border-bottom:1px solid var(--border); color:var(--text); }
  .glb-season-table tr:last-child td { border-bottom:none; }
  .glb-season-table tr:hover td { background:var(--bg-hover); }
  .glb-season-badge { display:inline-block; padding:2px 8px; border-radius:100px; font-size:10px; font-weight:600; }
  .glb-season-badge.LOW { background:#f0fdf4; color:#16a34a; }
  .glb-season-badge.HIGH { background:#fffbeb; color:#d97706; }
  .glb-season-badge.HOLIDAY { background:#f5f3ff; color:#7c3aed; }
`;

// ─── Types ────────────────────────────────────────────────────────────────────
type ConnState = "checking" | "connected" | "disconnected" | "rate-limited";
type GuestyListing = { _id: string; nickname?: string; title?: string };
type LogEntry = BuildStepEntry & { icon: string };

type Props = {
  propertyData?: GuestyPropertyData | null;
  propertyId?: number;
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
  amenities: "Syncing amenities",
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
// Channel markup push card. Lets the user set a per-channel price uplift
// (e.g. +17% on Booking.com to recover the commission) and pushes it to
// Guesty. Guesty's schema for channel markup differs across accounts so
// the server tries multiple field shapes and reports which one stuck.
function ChannelMarkupCard({
  listingId,
  markupPct,
  setMarkupPct,
  seasonalMonths,
  guestyRatesByMonth,
}: {
  listingId: string | null;
  // Decimal form: { airbnb: 0.155, vrbo: 0, ... }. Inputs below translate to/from %.
  markupPct: Record<ChannelKey, number>;
  setMarkupPct: (m: Record<ChannelKey, number>) => void;
  seasonalMonths: Array<{ yearMonth: string; totalBuyIn: number }>;
  guestyRatesByMonth: Record<string, { avgRate: number; minRate: number; maxRate: number; days: number }>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  // User's target margin — defaults to 20% (the old hard-coded floor).
  // Configurable because some properties need a bigger cushion or can
  // accept tighter margins in slow months.
  const [targetMarginPct, setTargetMarginPct] = useState(20);
  const [seasonalPushResult, setSeasonalPushResult] = useState<any>(null);

  // Fee-differential markups: make every channel net the same as Direct
  // after that channel's fee. Result is a FLAT per-channel markup that
  // doesn't depend on the current Guesty rate or the buy-in — so it
  // equalizes channels instead of inflating low-season profit.
  //
  //   base * (1 + m) * (1 - fee_ch) = base * (1 - fee_direct)
  //   ⇒ m_ch = (1 - fee_direct) / (1 - fee_ch) - 1
  //
  // Pair this with per-month seasonal base rates (below) and every month
  // × every channel lands at exactly targetMargin%.
  const computeAutoMarkups = (): Record<ChannelKey, number> => {
    const feeDirect = CHANNEL_HOST_FEE.direct ?? 0;
    const result: Record<ChannelKey, number> = { airbnb: 0, vrbo: 0, booking: 0, direct: 0 };
    for (const ch of ["airbnb", "vrbo", "booking", "direct"] as ChannelKey[]) {
      const fee = CHANNEL_HOST_FEE[ch] ?? 0;
      const raw = (1 - feeDirect) / (1 - fee) - 1;
      // Round to 0.1% for clean display; no snap-up because fees are fixed.
      result[ch] = Math.max(0, Math.round(raw * 1000) / 1000);
    }
    return result;
  };

  // Seasonal base-rate plan: what Guesty's calendar SHOULD charge per night
  // so the Direct channel nets targetMargin% after Stripe's fee. Every
  // channel with the fee-differential markup above then lands at the same
  // margin. Returns one rate per month — server expands to daily.
  const computeSeasonalRates = (): Array<{ yearMonth: string; price: number; buyIn: number }> => {
    const feeDirect = CHANNEL_HOST_FEE.direct ?? 0;
    const m = targetMarginPct / 100;
    return seasonalMonths
      .filter((row) => row.totalBuyIn > 0)
      .map((row) => ({
        yearMonth: row.yearMonth,
        buyIn: row.totalBuyIn,
        // Direct channel: price × (1 - feeDirect) = (1 + m) × buyIn
        // ⇒ price = (1 + m) × buyIn / (1 - feeDirect)
        price: Math.round(((1 + m) * row.totalBuyIn) / (1 - feeDirect)),
      }));
  };

  const autoCalculate = () => {
    const next = computeAutoMarkups();
    setMarkupPct(next);
    setResult(null);
    setError(null);
  };

  const autoCalculateAndPush = async () => {
    const next = computeAutoMarkups();
    setMarkupPct(next);
    await pushMarkups(next);
  };

  const pushSeasonalRates = async () => {
    if (!listingId) return;
    setBusy(true);
    setError(null);
    setSeasonalPushResult(null);
    const plan = computeSeasonalRates();
    try {
      const r = await fetch("/api/builder/push-seasonal-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId,
          monthlyRates: plan.map(({ yearMonth, price }) => ({ yearMonth, price })),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSeasonalPushResult({ ...data, plan });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // One-click: push seasonal base rates AND channel-equalizing markups.
  // After this, every month × every channel should land at targetMargin%.
  const setUpCleanMargin = async () => {
    const markups = computeAutoMarkups();
    setMarkupPct(markups);
    await pushSeasonalRates();
    await pushMarkups(markups);
  };

  const pushMarkups = async (override?: Record<ChannelKey, number>) => {
    if (!listingId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const source = override ?? markupPct;
    // The server expects decimals (0.155 = +15.5%). We skip channels at 0
    // so Guesty doesn't reset a previously-set markup we intentionally
    // wanted to keep — callers pass 0 explicitly when they mean "clear it".
    const body = {
      listingId,
      markups: {
        airbnb: source.airbnb > 0 ? source.airbnb : undefined,
        vrbo: source.vrbo > 0 ? source.vrbo : undefined,
        booking: source.booking > 0 ? source.booking : undefined,
        direct: source.direct > 0 ? source.direct : undefined,
      },
    };
    try {
      const r = await fetch("/api/builder/push-channel-markups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const updateChannel = (ch: ChannelKey, input: string) => {
    const n = parseFloat(input);
    setMarkupPct({ ...markupPct, [ch]: isNaN(n) ? 0 : n / 100 });
  };

  // Show live "would-push" markup % per channel in the inputs (0 renders empty)
  const asInput = (v: number) => (v > 0 ? (v * 100).toFixed(1) : "");

  // Preview the auto-calc so the user can see what it WOULD set before clicking.
  const autoPreview = useMemo(() => computeAutoMarkups(), [seasonalMonths, guestyRatesByMonth]);
  const anyGapExists = (Object.keys(autoPreview) as ChannelKey[]).some((ch) => autoPreview[ch] > (markupPct[ch] ?? 0));

  const channelRows: Array<{ key: ChannelKey; label: string }> = [
    { key: "airbnb",  label: "Airbnb" },
    { key: "vrbo",    label: "Vrbo" },
    { key: "booking", label: "Booking.com" },
    { key: "direct",  label: "Direct" },
  ];

  // Preview the seasonal base rates for the banner / summary.
  const seasonalPlan = useMemo(() => computeSeasonalRates(), [seasonalMonths, targetMarginPct]);
  const seasonalPriceRange = seasonalPlan.length > 0
    ? { min: Math.min(...seasonalPlan.map((p) => p.price)), max: Math.max(...seasonalPlan.map((p) => p.price)) }
    : null;

  return (
    <div style={{ marginTop: 20, padding: "16px 20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        💵 Clean-margin pricing — seasonal base rates + channel markups
      </div>
      <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, maxWidth: 760 }}>
        Two things together deliver a steady margin across all 24 months:
        (1) Guesty's <b>base calendar rate scales with season</b> so low months aren't wildly over-profitable,
        (2) each channel's <b>markup covers only its fee differential vs Direct</b>. Click the one-click button
        below and Guesty will end up with the same target margin on every month × every channel.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 11, color: "#6b7280" }}>
          Target margin:
          <input
            type="number"
            step="1"
            min="0"
            max="50"
            value={targetMarginPct}
            onChange={(e) => setTargetMarginPct(parseFloat(e.target.value) || 0)}
            style={{ marginLeft: 6, padding: "3px 6px", border: "1px solid #e5e7eb", borderRadius: 4, fontSize: 12, width: 60 }}
            data-testid="input-target-margin"
          />
          <span style={{ marginLeft: 2 }}>%</span>
        </label>
        {seasonalPriceRange && (
          <span style={{ fontSize: 11, color: "#6b7280" }}>
            Seasonal base rates will range <b>${seasonalPriceRange.min.toLocaleString()}</b>–<b>${seasonalPriceRange.max.toLocaleString()}</b> per night.
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 10 }}>
        {channelRows.map(({ key, label }) => {
          const needed = autoPreview[key];
          const current = markupPct[key] ?? 0;
          const shortfall = needed > current + 1e-6;
          return (
            <label key={key} style={{ fontSize: 11, color: "#6b7280" }}>
              {label}
              {" "}
              <span style={{ color: "#9ca3af" }}>({(CHANNEL_HOST_FEE[key] * 100).toFixed(1)}% fee)</span>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
                <input
                  type="number"
                  step="0.5"
                  value={asInput(current)}
                  onChange={(e) => updateChannel(key, e.target.value)}
                  placeholder="0"
                  style={{ padding: "4px 8px", border: "1px solid #e5e7eb", borderRadius: 4, fontSize: 12, width: "100%" }}
                  data-testid={`input-markup-${key}`}
                />
                <span style={{ fontSize: 11, color: "#6b7280" }}>%</span>
              </div>
              <div style={{ fontSize: 10, marginTop: 2, color: shortfall ? "#b45309" : "#6b7280" }}>
                fee-differential vs Direct: <b>{(needed * 100).toFixed(1)}%</b>
              </div>
            </label>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="glb-btn glb-btn-primary"
          onClick={setUpCleanMargin}
          disabled={busy || !listingId || seasonalMonths.length === 0}
          style={{ fontSize: 12 }}
          data-testid="button-set-up-clean-margin"
          title="Push seasonal base rates AND channel-equalizing markups so every month × every channel nets the target margin"
        >
          {busy ? "Pushing…" : `⚡⬆ Set up clean ${targetMarginPct}% margin pricing`}
        </button>
        <button
          className="glb-btn"
          onClick={autoCalculate}
          disabled={busy || seasonalMonths.length === 0}
          style={{ fontSize: 12 }}
          data-testid="button-auto-calc-markups"
          title="Fill in fee-differential markups only (doesn't push, doesn't change base rates)"
        >
          ⚡ Auto-fill markups only
        </button>
        <button
          className="glb-btn"
          onClick={pushSeasonalRates}
          disabled={busy || !listingId || seasonalMonths.length === 0}
          style={{ fontSize: 12 }}
          data-testid="button-push-seasonal-rates"
          title="Push only the per-month base calendar rates to Guesty (skip markups)"
        >
          🗓 Push seasonal rates only
        </button>
        <button
          className="glb-btn"
          onClick={() => pushMarkups()}
          disabled={busy || !listingId}
          style={{ fontSize: 12 }}
          data-testid="button-push-channel-markups"
        >
          ⬆ Push markups only
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 10, fontSize: 11, color: "#991b1b", background: "#fee2e2", padding: 8, borderRadius: 4 }}>
          {error}
        </div>
      )}
      {seasonalPushResult && (
        <div style={{ marginTop: 10, padding: 8, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 4, fontSize: 11 }}>
          <div style={{ fontWeight: 600, color: "#166534", marginBottom: 4 }}>
            ✓ Seasonal base rates pushed —{" "}
            <b>{seasonalPushResult.pushedDays}</b> days in{" "}
            <b>{seasonalPushResult.pushedRanges}</b> ranges;{" "}
            <b>{seasonalPushResult.verifiedDays}</b> verified against Guesty read-back.
          </div>
          {seasonalPushResult.plan && (
            <details>
              <summary style={{ cursor: "pointer", color: "#166534", fontWeight: 600 }}>
                Month-by-month plan
              </summary>
              <div style={{ marginTop: 4, maxHeight: 220, overflow: "auto" }}>
                {seasonalPushResult.plan.map((p: any) => (
                  <div key={p.yearMonth} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span>{p.yearMonth}</span>
                    <span>buy-in ${p.buyIn.toLocaleString()} → base ${p.price.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {result && (
        <div style={{ marginTop: 10, fontSize: 11 }}>
          {/* Per-channel readback from Guesty — confirms the markup isn't just
              sent but was stored. If a row is missing, Guesty's account uses
              a different field shape and the markup won't reach the channel. */}
          <div style={{ padding: 8, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 4 }}>
            <div style={{ fontWeight: 600, color: "#166534", marginBottom: 4 }}>
              ✓ Guesty accepted the push — verified channel-side:
            </div>
            {(() => {
              const savedInt = (result as any)?.saved?.integrations ?? {};
              const savedFlat = (result as any)?.saved?.priceMarkup ?? {};
              const rows: Array<{ label: string; keys: string[]; flat: string }> = [
                { label: "Airbnb",     keys: ["airbnb2", "airbnb"],      flat: "airbnb" },
                { label: "Vrbo",       keys: ["homeaway", "vrbo"],       flat: "vrbo" },
                { label: "Booking.com",keys: ["bookingCom", "booking"],  flat: "booking" },
                { label: "Direct",     keys: ["manual", "direct"],       flat: "direct" },
              ];
              return rows.map((r) => {
                const hit = r.keys.map((k) => savedInt[k]?.priceMarkup).find((v) => typeof v === "number");
                const flatHit = savedFlat?.[r.flat];
                const value = typeof hit === "number" ? hit : (typeof flatHit === "number" ? flatHit : null);
                return (
                  <div key={r.label} style={{ fontSize: 11, color: value != null ? "#166534" : "#6b7280" }}>
                    {value != null ? "✓" : "—"} {r.label}:{" "}
                    {value != null ? <b>+{(value * 100).toFixed(1)}% stored</b> : <span>not set / not sent</span>}
                  </div>
                );
              });
            })()}
          </div>
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", color: "#166534", fontWeight: 600 }}>
              Raw response (which Guesty shape stuck)
            </summary>
            <pre style={{ marginTop: 6, padding: 8, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 4, fontSize: 10, overflow: "auto", maxHeight: 220 }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

export default function GuestyListingBuilder({ propertyData, propertyId, onBuildComplete, onUpdateComplete }: Props) {
  const { toast } = useToast();
  const [conn, setConn] = useState<ConnState>("checking");
  const [connError, setConnError] = useState<string | null>(null);
  const [listings, setListings] = useState<GuestyListing[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [channelStatus, setChannelStatus] = useState<GuestyChannelStatus | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [activeTab, setActiveTab] = useState<"photos" | "amenities" | "descriptions" | "pricing" | "availability" | "bedding">("descriptions");
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildSuccess, setBuildSuccess] = useState(false);
  const [editableTitle, setEditableTitle] = useState("");
  const [descPushState, setDescPushState] = useState<"idle" | "pushing" | "success" | "error">("idle");
  const [descPushError, setDescPushError] = useState<string | null>(null);
  const [amenityPushState, setAmenityPushState] = useState<"idle" | "pushing" | "success" | "error">("idle");
  const [amenityPushResult, setAmenityPushResult] = useState<{
    sent: number;
    saved: number;
    missing: string[];
    rejected?: string[];
    suggestions?: { name: string; suggestion: string | null; alternatives?: string[] }[];
    guestyCatalogSize?: number;
  } | null>(null);
  const [showGuestyCatalog, setShowGuestyCatalog] = useState(false);
  // pendingAmenities = set of keys the user has selected for the next push
  const [pendingAmenities, setPendingAmenities] = useState<Set<string>>(() =>
    new Set(propertyId ? getGuestyAmenities(propertyId) : [])
  );
  const [guestyLiveAmenities, setGuestyLiveAmenities] = useState<Set<string> | null>(null);
  const [fetchingLiveAmenities, setFetchingLiveAmenities] = useState(false);
  // Guesty's canonical amenity catalog: list of { name } strings (Guesty's supported amenities
  // endpoint returns only a name field — no id — so name is the key we send on PUT).
  const [guesty_amenityCatalog, setGuesty_amenityCatalog] = useState<{ name: string }[]>([]);
  // Map from our profile key → Guesty canonical name (populated once catalog is loaded).
  const [keyToGuestyId, setKeyToGuestyId] = useState<Record<string, string>>({});

  // Fetch Guesty's canonical amenity catalog once and build profile-key → Guesty-name map.
  useEffect(() => {
    fetch("/api/builder/guesty-supported-amenities")
      .then(r => r.json())
      .then((data: unknown) => {
        const raw: { name?: string; title?: string; displayName?: string }[] =
          Array.isArray(data) ? data : (data as any)?.results ?? (data as any)?.amenities ?? [];
        const catalog = raw
          .map(a => ({ name: (a.name ?? a.title ?? a.displayName ?? "").toString() }))
          .filter(a => a.name);
        setGuesty_amenityCatalog(catalog);

        // Build mapping: our UPPER_SNAKE key → Guesty canonical name.
        // Normalize both sides (lowercase, spaces, strip punctuation) and match.
        const normalize = (s: string) =>
          s.toLowerCase().replace(/[_\-/]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
        const guestyByNorm = new Map(catalog.map(a => [normalize(a.name), a.name]));
        const map: Record<string, string> = {};
        for (const entry of GUESTY_AMENITY_CATALOG) {
          const byLabel = guestyByNorm.get(normalize(entry.label));
          const byKey   = guestyByNorm.get(normalize(entry.key));
          if (byLabel) map[entry.key] = byLabel;
          else if (byKey) map[entry.key] = byKey;
        }
        setKeyToGuestyId(map);
        console.log("[amenity-catalog] loaded", catalog.length, "Guesty amenities, mapped", Object.keys(map).length, "of", GUESTY_AMENITY_CATALOG.length);
      })
      .catch(() => {}); // non-fatal — falls back to raw key push
  }, []);

  // Reverse lookup: normalized form → our profile key.
  // Built from (a) canonical Guesty-name mappings we resolved at catalog-load,
  // plus (b) each catalog entry's own label/key (so free-form otherAmenities
  // that echo back verbatim — e.g. "Beach Chairs" — still resolve to BEACH_CHAIRS).
  const nameToKey = useMemo(() => {
    const norm = (s: string) =>
      s.toLowerCase().replace(/[_\-/&]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const m: Record<string, string> = {};
    for (const [k, name] of Object.entries(keyToGuestyId)) m[norm(name)] = k;
    for (const entry of GUESTY_AMENITY_CATALOG) {
      m[norm(entry.label)] = entry.key;
      m[norm(entry.key)] = entry.key;
    }
    return m;
  }, [keyToGuestyId]);

  // Convert an array of Guesty amenity names (canonical or free-form) into a Set
  // of our profile keys. Unresolved names are dropped.
  const guestyNamesToProfileKeys = useCallback((names: string[]) => {
    const norm = (s: string) =>
      s.toLowerCase().replace(/[_\-/&]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    return new Set(names.map(n => nameToKey[norm(n)]).filter(Boolean) as string[]);
  }, [nameToKey]);

  // Keep profile-based checkboxes in sync if propertyId ever changes (navigation edge case)
  const prevPropertyIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (propertyId !== prevPropertyIdRef.current) {
      prevPropertyIdRef.current = propertyId;
      setPendingAmenities(new Set(propertyId ? getGuestyAmenities(propertyId) : []));
    }
  }, [propertyId]);

  // ── Booking rules state ────────────────────────────────────────────────────
  const [bookingRules, setBookingRules] = useState({
    minNights: 3,
    maxNights: 365,
    advanceNotice: 1,   // days
    preparationTime: 1, // days (cleaning buffer)
    instantBooking: true,
    cancellationPolicy: "flexible",
  });
  const [pushingBooking, setPushingBooking] = useState(false);

  useEffect(() => {
    setEditableTitle(propertyData?.descriptions?.title ?? "");
  }, [propertyData?.descriptions?.title]);

  const effectivePropertyData = useMemo(() => {
    if (!propertyData) return null;
    if (!propertyData.descriptions) return propertyData;
    return {
      ...propertyData,
      descriptions: {
        ...propertyData.descriptions,
        title: editableTitle || propertyData.descriptions.title,
      },
    };
  }, [propertyData, editableTitle]);

  // ── Availability windows ───────────────────────────────────────────────────
  type AvailStatus = "unscanned" | "scanning" | "available" | "low" | "none" | "error";
  type AvailWindow = {
    id: string; checkIn: string; checkOut: string;
    label: string; shortLabel: string; monthKey: string;
    status: AvailStatus;
    availableCount?: number; neededCount?: number;
    unitResults?: { bedrooms: number; needed: number; found: number }[];
    cheapestByBedroom?: Record<number, { price: number; title: string; link: string }>;
    estimatedBuyInCost?: number;
  };
  const [availWindows, setAvailWindows] = useState<AvailWindow[]>([]);
  const [scanningAll, setScanningAll] = useState(false);
  const [scanIdx, setScanIdx] = useState(0);
  const [scanCompletedAt, setScanCompletedAt] = useState<Date | null>(null);
  const scanAbort = useRef(false);

  function fmtDate(d: string) {
    const [, m, day] = d.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m)-1]} ${parseInt(day)}`;
  }

  useEffect(() => {
    const wins: AvailWindow[] = [];
    const today = new Date(); today.setHours(0,0,0,0);
    const endDate = new Date(today); endDate.setMonth(endDate.getMonth() + 24);
    let cur = new Date(today);
    while (cur < endDate) {
      const ci = cur.toISOString().split("T")[0];
      const next = new Date(cur); next.setDate(next.getDate() + 14);
      const co = next.toISOString().split("T")[0];
      const mk = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,"0")}`;
      wins.push({ id: `${ci}_${co}`, checkIn: ci, checkOut: co,
        label: `${fmtDate(ci)} – ${fmtDate(co)}, ${cur.getFullYear()}`,
        shortLabel: `${fmtDate(ci)} – ${fmtDate(co)}`,
        monthKey: mk, status: "unscanned" });
      cur = next;
    }
    setAvailWindows(wins);
  }, []);

  const scanWindow = useCallback(async (win: { id: string; checkIn: string; checkOut: string }) => {
    if (!propertyId) return;
    setAvailWindows(p => p.map(w => w.id === win.id ? { ...w, status: "scanning" } : w));
    try {
      const res = await fetch(`/api/builder/scan-window?propertyId=${propertyId}&checkIn=${win.checkIn}&checkOut=${win.checkOut}`);
      const data = await res.json();
      setAvailWindows(p => p.map(w => w.id === win.id ? {
        ...w,
        status: (data.status || "error") as AvailStatus,
        availableCount: data.availableCount, neededCount: data.neededCount,
        unitResults: data.unitResults,
        cheapestByBedroom: data.cheapestByBedroom,
        estimatedBuyInCost: data.estimatedBuyInCost,
      } : w));
    } catch {
      setAvailWindows(p => p.map(w => w.id === win.id ? { ...w, status: "error" } : w));
    }
  }, [propertyId]);

  const runScanAll = useCallback(async (windows?: typeof availWindows) => {
    if (scanningAll) { scanAbort.current = true; return; }
    scanAbort.current = false;
    setScanningAll(true);
    const toScan = (windows ?? availWindows).filter(w => w.status === "unscanned");
    for (let i = 0; i < toScan.length; i++) {
      if (scanAbort.current) break;
      setScanIdx(i + 1);
      await scanWindow(toScan[i]);
      await new Promise(r => setTimeout(r, 800));
    }
    setScanningAll(false);
    setScanIdx(0);
    setScanCompletedAt(new Date());
  }, [scanningAll, availWindows, scanWindow]);

  // Auto-trigger scan when user first opens the Availability tab
  const autoScanFired = useRef(false);
  useEffect(() => {
    if (activeTab === "availability" && !autoScanFired.current && !scanningAll && availWindows.length > 0 && propertyId) {
      autoScanFired.current = true;
      runScanAll(availWindows);
    }
  }, [activeTab, availWindows, scanningAll, propertyId, runScanAll]);

  const pushBlackouts = useCallback(async () => {
    if (!selectedId) return;
    const toBlock = availWindows.filter(w => w.status === "none" || w.status === "low");
    for (const w of toBlock) {
      await guestyService.blockCalendarDates(selectedId, w.checkIn, w.checkOut);
    }
    alert(`Pushed ${toBlock.length} blackout block(s) to Guesty.`);
  }, [availWindows, selectedId]);

  // ── Photo push: host on ImgBB (+ optional upscale) → push to Guesty ────────
  type UpscalePhase = "idle" | "pushing" | "done" | "error";
  const [upscalePhase, setUpscalePhase] = useState<UpscalePhase>("idle");
  const [upscaleCurrent, setUpscaleCurrent] = useState(0);
  const [upscaleTotal, setUpscaleTotal] = useState(0);
  const [upscaledCount, setUpscaledCount] = useState(0);
  const [upscaleError, setUpscaleError] = useState<string | null>(null);
  const [pushResults, setPushResults] = useState<{ localPath: string; success: boolean; error?: string }[]>([]);
  const [savingToGuesty, setSavingToGuesty] = useState(false);
  const [checkpointCount, setCheckpointCount] = useState(0);
  const [doUpscale, setDoUpscale] = useState(false);
  const pushAbortRef = useRef<AbortController | null>(null);

  // ── Normalize existing Guesty photos (rotate/resize/compress in-place) ──
  // Fetches each photo currently in Guesty, runs through validateAndFixPhoto
  // on the server, and PUTs the fixed ones back. Touches only photos that
  // need fixing — compliant photos are left alone.
  type NormalizePhase = "idle" | "running" | "done" | "error";
  const [normalizePhase, setNormalizePhase] = useState<NormalizePhase>("idle");
  const [normalizeScope, setNormalizeScope] = useState<"this" | "all">("this");
  const [normalizeCurrent, setNormalizeCurrent] = useState(0);
  const [normalizeTotal, setNormalizeTotal] = useState(0);
  const [normalizeListingName, setNormalizeListingName] = useState<string>("");
  const [normalizeFixed, setNormalizeFixed] = useState(0);
  const [normalizeSkipped, setNormalizeSkipped] = useState(0);
  const [normalizeFailed, setNormalizeFailed] = useState(0);
  const [normalizeListingCount, setNormalizeListingCount] = useState(0);
  const [normalizeError, setNormalizeError] = useState<string | null>(null);
  const [normalizeChanges, setNormalizeChanges] = useState<string[]>([]);
  const normalizeAbortRef = useRef<AbortController | null>(null);

  const runNormalize = useCallback(async (scope: "this" | "all") => {
    if (scope === "this" && !selectedId) return;
    setNormalizePhase("running");
    setNormalizeScope(scope);
    setNormalizeCurrent(0);
    setNormalizeTotal(0);
    setNormalizeListingName("");
    setNormalizeFixed(0);
    setNormalizeSkipped(0);
    setNormalizeFailed(0);
    setNormalizeListingCount(0);
    setNormalizeError(null);
    setNormalizeChanges([]);

    const controller = new AbortController();
    normalizeAbortRef.current = controller;

    try {
      const resp = await fetch("/api/builder/normalize-photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope === "all" ? { all: true } : { guestyListingId: selectedId }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        setNormalizeError(`HTTP ${resp.status}`);
        setNormalizePhase("error");
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "start") {
            setNormalizeListingCount(evt.listingCount);
          } else if (evt.type === "listing-start") {
            setNormalizeListingName(evt.name);
            setNormalizeTotal(evt.photoCount);
            setNormalizeCurrent(0);
          } else if (evt.type === "photo") {
            setNormalizeCurrent(evt.index);
            if (evt.success && evt.fixed) {
              setNormalizeFixed(n => n + 1);
              if (Array.isArray(evt.changes) && evt.changes.length) {
                setNormalizeChanges(prev => [`#${evt.index} ${evt.originalWidth}×${evt.originalHeight} → ${evt.finalWidth}×${evt.finalHeight} [${evt.changes.join(", ")}]`, ...prev].slice(0, 40));
              }
            } else if (evt.success && evt.skipped) {
              setNormalizeSkipped(n => n + 1);
            } else if (!evt.success) {
              setNormalizeFailed(n => n + 1);
            }
          } else if (evt.type === "listing-error") {
            setNormalizeFailed(n => n + 1);
          } else if (evt.type === "all-done") {
            setNormalizePhase("done");
            refreshGuestyPhotoCount();
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setNormalizeError(e.message);
        setNormalizePhase("error");
      } else {
        setNormalizePhase("idle");
      }
    } finally {
      normalizeAbortRef.current = null;
    }
  }, [selectedId]);

  const stopNormalize = () => normalizeAbortRef.current?.abort();

  // Persisted last-push summary (survives refresh)
  type PushSummary = { listingId: string; timestamp: number; successCount: number; total: number; upscaledCount: number; failed: number };
  const [lastPushSummary, setLastPushSummary] = useState<PushSummary | null>(null);

  // Live photo count from Guesty for the selected listing
  const [guestyPhotoCount, setGuestyPhotoCount] = useState<number | null>(null);
  const [guestyPhotoCountLoading, setGuestyPhotoCountLoading] = useState(false);

  const savePushSummary = useCallback((summary: PushSummary) => {
    setLastPushSummary(summary);
    try { localStorage.setItem(`nexstay_push_${summary.listingId}`, JSON.stringify(summary)); } catch { /* non-fatal */ }
  }, []);

  // Load persisted summary & fetch live photo count when listing selection changes
  useEffect(() => {
    if (!selectedId) { setLastPushSummary(null); setGuestyPhotoCount(null); setGuestyLiveAmenities(null); return; }
    // Restore from localStorage
    try {
      const stored = localStorage.getItem(`nexstay_push_${selectedId}`);
      if (stored) setLastPushSummary(JSON.parse(stored));
      else setLastPushSummary(null);
    } catch { setLastPushSummary(null); }
    // Fetch live listing data — photo count + current amenities
    setGuestyPhotoCount(null);
    setGuestyPhotoCountLoading(true);
    setGuestyLiveAmenities(null);
    setFetchingLiveAmenities(true);
    // Photo count comes from the listing; amenities from properties-api (Popular Amenities panel).
    Promise.all([
      fetch(`/api/guesty-proxy/listings/${selectedId}`).then(r => r.json()).catch(() => null),
      fetch(`/api/builder/guesty-amenities?listingId=${selectedId}`).then(r => r.json()).catch(() => null),
    ])
      .then(([listing, amen]) => {
        setGuestyPhotoCount(listing?.pictures?.length ?? 0);
        const canonical: string[] = Array.isArray(amen?.amenities) ? amen.amenities : [];
        const other: string[] = Array.isArray(amen?.otherAmenities) ? amen.otherAmenities : [];
        setGuestyLiveAmenities(guestyNamesToProfileKeys([...canonical, ...other]));
      })
      .catch(() => { setGuestyPhotoCount(null); setGuestyLiveAmenities(new Set()); })
      .finally(() => { setGuestyPhotoCountLoading(false); setFetchingLiveAmenities(false); });
  }, [selectedId, guestyNamesToProfileKeys]);

  // Refresh live count after a successful push
  const refreshGuestyPhotoCount = useCallback(() => {
    if (!selectedId) return;
    fetch(`/api/guesty-proxy/listings/${selectedId}`)
      .then(r => r.json())
      .then((d: any) => setGuestyPhotoCount(d?.pictures?.length ?? 0))
      .catch(() => {});
  }, [selectedId]);

  const cancelPush = useCallback(() => {
    pushAbortRef.current?.abort();
    pushAbortRef.current = null;
    setSavingToGuesty(false);
    setUpscalePhase("idle");
    setUpscaleCurrent(0);
    setUpscaleTotal(0);
    setPushResults([]);
    setUpscaleError(null);
  }, []);

  // ── Cover collage: score labels → pick best outdoor + indoor → canvas → ImgBB → Guesty ──
  type CollagePhase = "idle" | "upscaling" | "generating" | "uploading" | "done" | "error";
  const [collagePhase, setCollagePhase] = useState<CollagePhase>("idle");
  const [collageError, setCollageError] = useState<string | null>(null);
  const [collagePreviewUrl, setCollagePreviewUrl] = useState<string | null>(null);
  const [collagePicks, setCollagePicks] = useState<{ outdoor: string; indoor: string } | null>(null);

  function scoreOutdoor(label: string): number {
    const l = label.toLowerCase();
    return (l.includes("ocean") ? 10 : 0) + (l.includes("sunrise") ? 9 : 0) +
           (l.includes("pool") ? 8 : 0) + (l.includes("beach") ? 7 : 0) +
           (l.includes("coastal") ? 6 : 0) + (l.includes("bay") ? 6 : 0) +
           (l.includes("view") ? 4 : 0) + (l.includes("waterfront") ? 8 : 0) +
           (l.includes("resort") ? 3 : 0) + (l.includes("lanai") ? 3 : 0);
  }
  function scoreIndoor(label: string): number {
    const l = label.toLowerCase();
    return (l.includes("living room") ? 9 : 0) + (l.includes("great room") ? 8 : 0) +
           (l.includes("open kitchen") ? 7 : 0) + (l.includes("kitchen") ? 5 : 0) +
           (l.includes("master suite") || l.includes("king master") || l.includes("master king") ? 7 : 0) +
           (l.includes("master bedroom") ? 6 : 0) + (l.includes("ocean") ? 4 : 0) +
           (l.includes("bright") ? 2 : 0) + (l.includes("dining") ? 3 : 0);
  }

  function pickCollagePhotos(allPhotos: GuestyPropertyData["photos"]): { outdoor: typeof allPhotos[0]; indoor: typeof allPhotos[0] } | null {
    if (!allPhotos?.length) return null;
    let bestOutdoor = allPhotos[0], bestOutdoorScore = -1;
    let bestIndoor = allPhotos[0], bestIndoorScore = -1;
    for (const p of allPhotos) {
      const os = scoreOutdoor(p.caption || "");
      const is_ = scoreIndoor(p.caption || "");
      if (os > bestOutdoorScore) { bestOutdoorScore = os; bestOutdoor = p; }
      if (is_ > bestIndoorScore) { bestIndoorScore = is_; bestIndoor = p; }
    }
    return { outdoor: bestOutdoor, indoor: bestIndoor };
  }

  const generateCoverCollage = useCallback(async (allPhotos: GuestyPropertyData["photos"]) => {
    if (!selectedId) return;
    setCollagePhase("upscaling");
    setCollageError(null);
    setCollagePreviewUrl(null);
    setCollagePicks(null);

    const picks = pickCollagePhotos(allPhotos);
    if (!picks) { setCollageError("No photos available"); setCollagePhase("error"); return; }
    setCollagePicks({ outdoor: picks.outdoor.caption || picks.outdoor.url, indoor: picks.indoor.caption || picks.indoor.url });

    // Extract local path from URL (e.g. "/photos/kaha-lani-109/photo_00.jpg")
    const toLocalPath = (url: string): string => {
      try { return new URL(url, window.location.origin).pathname; }
      catch { return url.startsWith("/") ? url : `/${url}`; }
    };
    const outdoorLocal = toLocalPath(picks.outdoor.url);
    const indoorLocal  = toLocalPath(picks.indoor.url);

    // Upscale both picks via server (Real-ESRGAN → ImgBB), run in parallel
    let outdoorSrc = picks.outdoor.url;
    let indoorSrc = picks.indoor.url;
    if (outdoorLocal.startsWith("/photos/") || indoorLocal.startsWith("/photos/")) {
      const upscaleOne = async (localPath: string, fallback: string) => {
        try {
          const r = await fetch("/api/builder/upscale-photo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ localPath }),
          });
          if (!r.ok) return fallback;
          const d = await r.json() as any;
          return d.url || fallback;
        } catch { return fallback; }
      };
      [outdoorSrc, indoorSrc] = await Promise.all([
        outdoorLocal.startsWith("/photos/") ? upscaleOne(outdoorLocal, picks.outdoor.url) : Promise.resolve(picks.outdoor.url),
        indoorLocal.startsWith("/photos/")  ? upscaleOne(indoorLocal,  picks.indoor.url)  : Promise.resolve(picks.indoor.url),
      ]);
    }

    setCollagePhase("generating");

    // Load both images (upscaled or original)
    const loadImg = (src: string): Promise<HTMLImageElement> => new Promise((res, rej) => {
      const img = new Image(); img.crossOrigin = "anonymous";
      img.onload = () => res(img); img.onerror = rej; img.src = src;
    });

    let outdoorImg: HTMLImageElement, indoorImg: HTMLImageElement;
    try {
      [outdoorImg, indoorImg] = await Promise.all([loadImg(outdoorSrc), loadImg(indoorSrc)]);
    } catch {
      setCollageError("Failed to load photos for collage"); setCollagePhase("error"); return;
    }

    // Draw side-by-side on canvas — 1600×800 (2:1 landscape, ~1.5MB → well within limits)
    const W = 1600, H = 800, half = W / 2;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;

    const drawCover = (img: HTMLImageElement, x: number, w: number) => {
      const scale = Math.max(w / img.width, H / img.height);
      const sw = img.width * scale, sh = img.height * scale;
      ctx.drawImage(img, x + (w - sw) / 2, (H - sh) / 2, sw, sh);
    };

    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, half, H); ctx.clip();
    drawCover(outdoorImg, 0, half);
    ctx.restore();

    ctx.save(); ctx.beginPath(); ctx.rect(half, 0, half, H); ctx.clip();
    drawCover(indoorImg, half, half);
    ctx.restore();

    // Thin divider line
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillRect(half - 1, 0, 2, H);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    setCollagePreviewUrl(dataUrl);

    // Upload to ImgBB + set as Guesty cover
    setCollagePhase("uploading");
    try {
      const resp = await fetch("/api/builder/upload-collage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64: dataUrl, listingId: selectedId }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as any;
        throw new Error(err.error || `Server error ${resp.status}`);
      }
      const result = await resp.json() as any;
      setGuestyPhotoCount(result.totalPhotos);
      setCollagePhase("done");
    } catch (e: any) {
      setCollageError(e.message); setCollagePhase("error");
    }
  }, [selectedId]);

  const upscaleAndUpload = useCallback(async (photos: GuestyPropertyData["photos"], withUpscale: boolean) => {
    if (!selectedId || !photos?.length) return;
    setUpscalePhase("pushing");
    setUpscaleTotal(photos.length);
    setUpscaleCurrent(0);
    setUpscaledCount(0);
    setUpscaleError(null);
    setPushResults([]);
    setSavingToGuesty(false);
    setCheckpointCount(0);

    const origin = window.location.origin;

    // Extract local path from each photo URL (e.g. "/photos/pili-mai/photo_00.jpg")
    const photosPayload = photos.map(p => {
      let localPath: string;
      try {
        localPath = new URL(p.url).pathname;
      } catch {
        localPath = p.url.startsWith("/") ? p.url : p.url.replace(origin, "");
      }
      return { localPath, caption: p.caption || "" };
    });

    const controller = new AbortController();
    pushAbortRef.current = controller;

    try {
      // Streaming NDJSON: server sends one JSON line per photo as it completes.
      // This keeps the HTTP connection alive indefinitely — no timeout possible.
      const resp = await fetch("/api/builder/push-photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestyListingId: selectedId, photos: photosPayload, upscale: withUpscale }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as any;
        setUpscaleError(err.error || `Server error ${resp.status}`);
        setUpscalePhase("error");
        return;
      }

      // Read the streaming NDJSON body line-by-line
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!; // keep incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as {
              type: "photo" | "checkpoint" | "saving" | "done";
              index?: number;
              total?: number;
              saved?: number;
              localPath?: string;
              success?: boolean;
              url?: string;
              wasUpscaled?: boolean;
              error?: string;
              successCount?: number;
              upscaledCount?: number;
            };

            if (event.type === "photo") {
              setUpscaleCurrent(event.index ?? 0);
              if (event.wasUpscaled) setUpscaledCount(c => c + 1);
              setPushResults(prev => [...prev, {
                localPath: event.localPath || "",
                success: event.success ?? false,
                error: event.error,
              }]);
            } else if (event.type === "checkpoint") {
              // Intermediate save — update Guesty photo count so user can see progress
              setCheckpointCount(c => c + 1);
              refreshGuestyPhotoCount();
            } else if (event.type === "saving") {
              setSavingToGuesty(true);
            } else if (event.type === "done") {
              setSavingToGuesty(false);
              setUpscaledCount(event.upscaledCount ?? 0);
              const guestyError = (event as any).guestyError as string | undefined;
              if (guestyError) setUpscaleError(`Guesty save failed: ${guestyError}`);
              const sc = event.successCount ?? 0;
              const tot = event.total ?? 0;
              const succeeded = sc > 0 && !guestyError;
              setUpscalePhase(sc === 0 && tot > 0 ? "error" : "done");
              if (sc === 0 && tot > 0 && !guestyError) {
                setUpscaleError("All photos failed — check per-photo errors below");
              }
              // Persist summary to localStorage and refresh live count
              if (succeeded && selectedId) {
                savePushSummary({
                  listingId: selectedId,
                  timestamp: Date.now(),
                  successCount: sc,
                  total: tot,
                  upscaledCount: event.upscaledCount ?? 0,
                  failed: tot - sc,
                });
                // Guesty processes uploaded photos asynchronously — wait 3s then poll
                setTimeout(() => refreshGuestyPhotoCount(), 3000);
                setTimeout(() => refreshGuestyPhotoCount(), 8000);
              }
            }
          } catch { /* malformed line — skip */ }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        // User cancelled — state is already reset by cancelPush()
        return;
      }
      setUpscaleError(err?.message || "Network error — could not reach server");
      setUpscalePhase("error");
    } finally {
      pushAbortRef.current = null;
    }
  }, [selectedId]);

  // ── Check connection + load listings ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function init() {
      setConn("checking");
      setConnError(null);
      const result = await guestyService.checkConnection();
      if (cancelled) return;
      if (result.connected) {
        setConn("connected");
        try {
          const data = await guestyService.getListings(50, 0);
          if (!cancelled) setListings(data.results || []);
        } catch { /* non-fatal */ }
      } else {
        const isRateLimited = result.error === "RATE_LIMITED";
        setConn(isRateLimited ? "rate-limited" : "disconnected");
        setConnError(result.error || null);
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
    if (!effectivePropertyData) {
      toast({ title: "No property data", description: "Property data is missing. Try refreshing the page.", variant: "destructive" });
      return;
    }
    if (building) return;
    if (conn !== "connected") {
      toast({ title: "Not connected to Guesty", description: "Wait for the connection to establish, then try again.", variant: "destructive" });
      return;
    }

    setBuilding(true);
    setLog([]);
    setProgress(0);
    setBuildError(null);
    setBuildSuccess(false);

    toast({ title: "Creating listing on Guesty…", description: "Please wait while we build your listing." });

    const totalSteps = [true, !!effectivePropertyData.descriptions, !!(effectivePropertyData.photos?.length), !!effectivePropertyData.pricing, !!effectivePropertyData.bookingSettings].filter(Boolean).length;
    let done = 0;

    let result: Awaited<ReturnType<typeof guestyService.buildFullListing>>;
    try {
      result = await guestyService.buildFullListing(effectivePropertyData, (step, status) => {
        setLog((prev) => {
          const entry: LogEntry = { step, status: status as "pending" | "success" | "error", icon: statusIcon(status), timestamp: new Date().toISOString() };
          const idx = prev.findIndex((e) => e.step === step);
          if (idx >= 0) { const next = [...prev]; next[idx] = entry; return next; }
          return [...prev, entry];
        });
        if (status === "success" || status === "error") { done++; setProgress(Math.round((done / totalSteps) * 100)); }
      });
    } catch (e: any) {
      setBuilding(false);
      setProgress(0);
      const msg = e?.message || "Unexpected error";
      setBuildError(msg);
      toast({ title: "Listing creation failed", description: msg, variant: "destructive" });
      return;
    }

    setProgress(100);
    setBuilding(false);

    if (!result.listingId) {
      const firstErr = result.errors?.[0]?.error as string | undefined;
      const msg = firstErr || "Listing creation failed — check the build log for details.";
      setBuildError(msg);
      toast({ title: "Listing creation failed", description: msg, variant: "destructive" });
    } else {
      setBuildSuccess(true);
      toast({ title: "✓ Listing created on Guesty!", description: `ID: ${result.listingId} — it now appears in the dropdown above as a draft.` });
      const fresh = await guestyService.getListings(50, 0);
      setListings(fresh.results || []);
      setSelectedId(result.listingId);

      if (propertyId) {
        try {
          await fetch("/api/builder/schedule-sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ propertyId, guestyListingId: result.listingId, delayMinutes: 60 }),
          });
          toast({ title: "Availability sync scheduled", description: "Blackout dates will be pushed to Guesty in ~1 hour.", duration: 6000 });
        } catch {
          // non-fatal
        }
      }
    }
    onBuildComplete?.({ listingId: result.listingId });
  }, [effectivePropertyData, building, conn, onBuildComplete, toast]);

  // ── Push updates ──────────────────────────────────────────────────────────
  const handleUpdate = useCallback(async () => {
    if (!effectivePropertyData || !selectedId || building) return;
    setBuilding(true);
    setLog([]);
    setProgress(0);

    const totalSteps = [!!(effectivePropertyData.listingRooms?.length), !!effectivePropertyData.descriptions, !!(effectivePropertyData.photos?.length), !!effectivePropertyData.pricing, !!effectivePropertyData.bookingSettings].filter(Boolean).length;
    let done = 0;

    const result = await guestyService.updateFullListing(selectedId, effectivePropertyData, (step, status) => {
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
  }, [effectivePropertyData, selectedId, building, onUpdateComplete]);

  const pushDescriptions = useCallback(async () => {
    if (!effectivePropertyData?.descriptions || !selectedId || descPushState === "pushing") return;
    setDescPushState("pushing");
    setDescPushError(null);
    try {
      const res = await fetch("/api/builder/push-descriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: selectedId, descriptions: effectivePropertyData.descriptions }),
      });
      const data = await res.json() as { success: boolean; error?: string; returnedDescriptions?: Record<string, string> | null };
      if (!res.ok || !data.success) {
        setDescPushState("error");
        setDescPushError(data.error ?? `HTTP ${res.status}`);
      } else {
        setDescPushState("success");
        toast({ title: "Descriptions pushed to Guesty", description: "Summary, Space, Neighborhood, and other description fields updated." });
      }
    } catch (e) {
      setDescPushState("error");
      setDescPushError((e as Error).message);
    }
  }, [effectivePropertyData, selectedId, descPushState, toast]);

  const [syncingDetails, setSyncingDetails] = useState(false);
  const handleSyncDetails = useCallback(async () => {
    if (!selectedId || syncingDetails || building) return;
    setSyncingDetails(true);
    try {
      const propData = getUnitBuilderByPropertyId(propertyId);
      const rooms = buildListingRooms(propertyId);
      const sqft = propData ? propData.units.reduce((s, u) => s + parseSqft(u.sqft), 0) : 0;
      const beds = propData ? propData.units.reduce((s, u) => s + u.bedrooms, 0) : 0;
      const baths = propData ? propData.units.reduce((s, u) => s + parseFloat(u.bathrooms), 0) : 0;
      await guestyService.updateListingDetails(selectedId, {
        areaSquareFeet: sqft || undefined,
        bedrooms: beds || undefined,
        bathrooms: baths || undefined,
        listingRooms: rooms.length > 0 ? rooms : undefined,
      });
      toast({ title: "Rooms & Details Synced", description: `Pushed ${rooms.length} rooms, ${sqft.toLocaleString()} sqft to Guesty.` });
    } catch (e) {
      toast({ title: "Sync Failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSyncingDetails(false);
    }
  }, [selectedId, propertyId, syncingDetails, building, toast]);

  const pushAmenities = useCallback(async () => {
    if (!selectedId || amenityPushState === "pushing") return;
    setAmenityPushState("pushing");
    setAmenityPushResult(null);
    try {
      // Translate our profile keys → Guesty canonical IDs where we have a mapping
      const amenityPayload = [...pendingAmenities].map(k => keyToGuestyId[k] ?? k);
      const res = await fetch("/api/builder/push-amenities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: selectedId, amenities: amenityPayload }),
      });
      const data = await res.json() as {
        success: boolean;
        sent?: number;
        saved?: number;
        savedAmenities?: string[];
        otherAmenities?: string[];
        missing?: string[];
        rejected?: string[];
        suggestions?: { name: string; suggestion: string | null; alternatives?: string[] }[];
        guestyCatalogSize?: number;
        error?: string;
      };
      if (!res.ok || !data.success) {
        setAmenityPushState("error");
        toast({ title: "Amenities push failed", description: data.error ?? `HTTP ${res.status}`, variant: "destructive" });
      } else {
        setAmenityPushState("success");
        setAmenityPushResult({
          sent: data.sent ?? 0,
          saved: data.saved ?? 0,
          missing: data.missing ?? [],
          rejected: data.rejected ?? [],
          suggestions: data.suggestions ?? [],
          guestyCatalogSize: data.guestyCatalogSize,
        });
        // Refresh the diff panel with what Guesty actually confirmed post-push
        if (Array.isArray(data.savedAmenities) || Array.isArray(data.otherAmenities)) {
          const merged = [...(data.savedAmenities ?? []), ...(data.otherAmenities ?? [])];
          setGuestyLiveAmenities(guestyNamesToProfileKeys(merged));
        }
        toast({
          title: `Amenities pushed to Guesty`,
          description: data.missing && data.missing.length > 0
            ? `${data.saved}/${data.sent} saved. ${data.missing.length} names Guesty didn't recognise — check server logs.`
            : `${data.saved} amenities confirmed in Guesty's Popular Amenities panel.`,
          duration: 8000,
        });
      }
    } catch (e) {
      setAmenityPushState("error");
      toast({ title: "Amenities push failed", description: (e as Error).message, variant: "destructive" });
    }
  }, [selectedId, pendingAmenities, amenityPushState, toast, keyToGuestyId, guestyNamesToProfileKeys]);

  const pillLabel = conn === "checking" ? "Checking connection…" : conn === "connected" ? "Guesty Connected" : conn === "rate-limited" ? "Rate Limited — retry later" : "Guesty Disconnected";
  const photos = propertyData?.photos || [];
  const amenities = propertyData?.amenities || [];
  const descriptions = effectivePropertyData?.descriptions;
  const pricing = propertyData?.pricing;

  // Aggregate monthly rates across all units for the 24-month seasonal table
  const seasonalMonths = useMemo(() => {
    if (!propertyId) return [];
    const propPricing = getPropertyPricing(propertyId);
    if (!propPricing || !propPricing.units.length) return [];
    return propPricing.units[0].monthlyRates.map((row, i) => ({
      month: row.month,
      year: row.year,
      yearMonth: row.yearMonth,
      season: row.season,
      totalBuyIn: propPricing.units.reduce((s, u) => s + u.monthlyRates[i].buyInRate, 0),
      totalSell:  propPricing.units.reduce((s, u) => s + u.monthlyRates[i].sellRate, 0),
    }));
  }, [propertyId]);

  // ── Guesty-confirmed monthly rates + channel-aware profit floor ──
  // Fetches what Guesty is ACTUALLY charging per month so we can compare
  // against our pricing sheet at a glance. Also surfaces the minimum rate
  // needed to hit 20% margin given the selected channel's host fee.
  const [selectedChannel, setSelectedChannel] = useState<ChannelKey>("airbnb");
  const [guestyRatesByMonth, setGuestyRatesByMonth] = useState<Record<string, { avgRate: number; minRate: number; maxRate: number; days: number }>>({});
  const [guestyRatesLoading, setGuestyRatesLoading] = useState(false);
  const [guestyRatesError, setGuestyRatesError] = useState<string | null>(null);
  // Per-channel markup (decimal form: 0.155 = +15.5%). Hoisted from
  // ChannelMarkupCard so the profit columns in the pricing table can
  // reflect the uplift in real time — not just after it's been pushed.
  const [markupPct, setMarkupPct] = useState<Record<ChannelKey, number>>({
    airbnb: 0, vrbo: 0, booking: 0, direct: 0,
  });

  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    setGuestyRatesLoading(true);
    setGuestyRatesError(null);
    fetch(`/api/builder/guesty-monthly-rates/${propertyId}?months=24`)
      .then(async (r) => {
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data: any) => {
        if (cancelled) return;
        const byMonth: Record<string, { avgRate: number; minRate: number; maxRate: number; days: number }> = {};
        for (const m of data.months ?? []) {
          byMonth[m.yearMonth] = { avgRate: m.avgRate, minRate: m.minRate, maxRate: m.maxRate, days: m.days };
        }
        setGuestyRatesByMonth(byMonth);
      })
      .catch((e: any) => {
        if (!cancelled) setGuestyRatesError(e.message || "Failed to fetch Guesty rates");
      })
      .finally(() => {
        if (!cancelled) setGuestyRatesLoading(false);
      });
    return () => { cancelled = true; };
  }, [propertyId]);

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
              setConnError(null);
              guestyService.checkConnection().then((r) => {
                if (r.connected) {
                  setConn("connected");
                } else {
                  setConn(r.error === "RATE_LIMITED" ? "rate-limited" : "disconnected");
                  setConnError(r.error || null);
                }
              });
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
            onChange={(e) => { setSelectedId(e.target.value); setGuestyLiveAmenities(null); }}
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
            <button
              className="glb-btn glb-btn-secondary"
              onClick={handleSyncDetails}
              disabled={syncingDetails || building || conn !== "connected"}
              data-testid="btn-sync-rooms-details"
              title="Push bedroom count, square footage, and room/bed configuration to Guesty"
            >
              {syncingDetails ? "Syncing…" : "🛏 Sync Rooms & sqft"}
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
              disabled={building}
              data-testid="btn-build-new-listing"
              style={{ fontSize: 14, padding: "10px 20px" }}
            >
              {building ? "⟳ Building listing…" : "+ Build New Listing on Guesty"}
            </button>
            <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 8 }}>
              Creates a new unlisted draft in Guesty — push descriptions, photos, pricing, and booking rules in one click.
            </p>

            {/* Inline progress bar shown while building */}
            {building && (
              <div style={{ marginTop: 14, background: "var(--card-bg,#1e293b)", border: "1px solid var(--border,#334155)", borderRadius: 8, padding: "12px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text,#e2e8f0)" }}>Building listing on Guesty…</span>
                  <span style={{ fontSize: 12, color: "#9ca3af" }}>{progress}%</span>
                </div>
                <div style={{ height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#6366f1", borderRadius: 4, width: `${progress}%`, transition: "width 0.4s ease" }} />
                </div>
                {log.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                    {log.map((entry, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <span style={{ color: entry.status === "success" ? "#4ade80" : entry.status === "error" ? "#f87171" : "#fbbf24", minWidth: 16 }}>
                          {entry.icon}
                        </span>
                        <span style={{ color: "var(--text,#e2e8f0)" }}>{STEP_LABELS[entry.step] || entry.step}</span>
                        {entry.error && <span style={{ color: "#f87171", marginLeft: "auto" }}>{entry.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Success banner */}
            {buildSuccess && !building && (
              <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(74,222,128,0.1)", border: "1px solid #4ade80", borderRadius: 8, fontSize: 13, color: "#4ade80" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span>✓</span>
                  <span>Listing created successfully on Guesty! It appears in the dropdown above as a draft.</span>
                </div>
                <div style={{ fontSize: 12, color: "#86efac", paddingLeft: 22 }}>
                  Next: select the new listing from the dropdown, then click the <strong>Photos</strong> tab and hit <strong>"Push Photos to Guesty"</strong> to upload your photos.
                </div>
              </div>
            )}

            {/* Error banner */}
            {buildError && !building && (
              <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(248,113,113,0.1)", border: "1px solid #f87171", borderRadius: 8, fontSize: 13, color: "#f87171", display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ flexShrink: 0 }}>✗</span>
                <div>
                  <strong>Failed to create listing:</strong> {buildError}
                  <div style={{ marginTop: 4, fontSize: 11, color: "#9ca3af" }}>Scroll down to the build log for full details.</div>
                </div>
              </div>
            )}
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
                {(["descriptions", "bedding", "amenities", "pricing", "photos", "availability"] as const).map((t) => (
                  <button key={t} className={`glb-tab ${activeTab === t ? "active" : ""}`} onClick={() => setActiveTab(t)} data-testid={`tab-${t}`}>
                    {t === "photos" ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        {`Photos (${photos.length})`}
                        {selectedId && (
                          guestyPhotoCountLoading
                            ? <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#d1d5db", display: "inline-block" }} title="Checking Guesty…" />
                            : guestyPhotoCount === null
                            ? null
                            : guestyPhotoCount > 0
                            ? <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#16a34a", display: "inline-block" }} title={`${guestyPhotoCount} photos in Guesty`} />
                            : <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#dc2626", display: "inline-block" }} title="No photos in Guesty yet" />
                        )}
                      </span>
                    ) :
                     t === "amenities" ? `Amenities (${pendingAmenities.size})` :
                     t === "availability" ? "Availability" :
                     t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              <div className="glb-tab-body">

                {activeTab === "descriptions" && (
                  <div>
                    {propertyData?.address && (
                      <div className="glb-desc-block">
                        <div className="glb-desc-label">Address (sent to Guesty)</div>
                        <div className="glb-desc-text" style={{ fontFamily: "monospace", fontSize: 12 }}>
                          {propertyData.address.full}
                          {propertyData.areaSquareFeet ? ` · ${propertyData.areaSquareFeet.toLocaleString()} sqft` : ""}
                          {propertyData.bedrooms ? ` · ${propertyData.bedrooms} bed` : ""}
                          {propertyData.bathrooms ? ` · ${propertyData.bathrooms} bath` : ""}
                        </div>
                      </div>
                    )}
                    {descriptions ? (() => {
                      const FIELD_LABELS: Record<string, string> = {
                        title: "Listing Title",
                        summary: "Summary",
                        space: "The Space",
                        neighborhood: "The Neighborhood",
                        transit: "Getting Around",
                        access: "Guest Access",
                        houseRules: "House Rules",
                        notes: "Other Notes",
                      };
                      const FIELD_ORDER = ["title", "summary", "space", "neighborhood", "transit", "access", "houseRules", "notes"];
                      const orderedEntries = [
                        ...FIELD_ORDER.filter(k => k in descriptions),
                        ...Object.keys(descriptions).filter(k => !FIELD_ORDER.includes(k)),
                      ];
                      return orderedEntries.map((key) => {
                        const val = (descriptions as Record<string, string | undefined>)[key];
                        if (!val && key !== "title") return null;
                        if (key === "title") {
                          const len = editableTitle.length;
                          return (
                            <div key={key} className="glb-desc-block">
                              <div className="glb-desc-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span>Listing Title</span>
                                <span style={{ fontWeight: 400, fontSize: 10, color: len > 80 ? "#ef4444" : len > 50 ? "#f59e0b" : "#6b7280" }}>
                                  {len}/50 Airbnb · {len}/80 VRBO {len > 80 ? "⚠ too long" : len > 50 ? "⚠ Airbnb truncates" : "✓"}
                                </span>
                              </div>
                              <input
                                type="text"
                                value={editableTitle}
                                onChange={e => setEditableTitle(e.target.value)}
                                placeholder="Listing title (commas and dashes allowed)"
                                style={{
                                  width: "100%", padding: "6px 8px", fontSize: 13,
                                  border: `1px solid ${len > 80 ? "#ef4444" : len > 50 ? "#f59e0b" : "#e5e7eb"}`,
                                  borderRadius: 4, background: "transparent", color: "inherit", outline: "none",
                                }}
                                data-testid="input-listing-title"
                              />
                            </div>
                          );
                        }
                        return (
                          <div key={key} className="glb-desc-block">
                            <div className="glb-desc-label">{FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").trim()}</div>
                            <div className="glb-desc-text">{val}</div>
                          </div>
                        );
                      });
                    })()
                    : <div className="glb-empty">No descriptions provided</div>
                    }
                    {descriptions && (
                      <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <button
                            className="glb-btn"
                            disabled={!selectedId || descPushState === "pushing"}
                            onClick={() => pushDescriptions()}
                            data-testid="btn-push-descriptions"
                            style={{
                              background: descPushState === "success" ? "#10b981" : descPushState === "error" ? "#ef4444" : "#6366f1",
                              color: "#fff",
                              opacity: !selectedId || descPushState === "pushing" ? 0.6 : 1,
                            }}
                          >
                            {descPushState === "pushing" ? "Pushing…" : descPushState === "success" ? "✓ Pushed" : descPushState === "error" ? "✗ Failed — Retry" : "Push Descriptions to Guesty"}
                          </button>
                          {!selectedId && (
                            <span style={{ fontSize: 11, color: "var(--muted)" }}>Select or build a listing first</span>
                          )}
                          {descPushState === "error" && descPushError && (
                            <span style={{ fontSize: 11, color: "#ef4444", maxWidth: 400, wordBreak: "break-word" }}>
                              {descPushError}
                            </span>
                          )}
                          {descPushState === "success" && (
                            <span style={{ fontSize: 11, color: "#10b981" }}>
                              Summary, Space, Neighborhood & other fields updated in Guesty
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Compliance & Registration Section */}
                    {(effectivePropertyData?.taxMapKey || effectivePropertyData?.tatLicense || effectivePropertyData?.getLicense || effectivePropertyData?.strPermit) && (
                      <div style={{ marginTop: 24, padding: "16px 20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                            <span>🏛</span> Compliance &amp; Registration
                          </div>
                          <button
                            disabled={!selectedId}
                            onClick={async () => {
                              if (!selectedId) return;
                              try {
                                const res = await fetch("/api/builder/push-compliance", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    listingId: selectedId,
                                    taxMapKey: effectivePropertyData.taxMapKey,
                                    tatLicense: effectivePropertyData.tatLicense,
                                    getLicense: effectivePropertyData.getLicense,
                                  }),
                                });
                                const data = await res.json();
                                if (data.success) {
                                  const compTags = (data.savedTags || []).filter((t: string) => /^(TMK|TAT|GET):/.test(t)).join(", ");
                                  const licLine = data.licenseNumber?.ok === true
                                    ? `· License# field: ✓`
                                    : data.licenseNumber?.ok === false
                                    ? `· License# field: ✗ (not accepted by Guesty)`
                                    : "";
                                  const taxLine = data.taxId?.ok === true ? `· Tax ID field: ✓` : "";
                                  const vrboLine = data.vrbo?.saved
                                    ? `· VRBO channel fields: ✓`
                                    : `· VRBO channel fields: requires VRBO OAuth in Guesty`;
                                  toast({
                                    title: data.verified ? "Compliance pushed to Guesty" : "Pushed (partially verified)",
                                    description: [
                                      `Tags: ${compTags}`,
                                      data.notesUpdated ? "Notes: ✓" : "",
                                      licLine, taxLine, vrboLine,
                                    ].filter(Boolean).join("  "),
                                  });
                                } else {
                                  toast({ title: "Push failed", description: data.error || "Unknown error", variant: "destructive" });
                                }
                              } catch (e: any) {
                                toast({ title: "Push failed", description: e.message, variant: "destructive" });
                              }
                            }}
                            style={{
                              fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 6,
                              border: "1px solid transparent", cursor: selectedId ? "pointer" : "not-allowed",
                              background: selectedId ? "#1e40af" : "#94a3b8", color: "#fff",
                            }}
                            data-testid="btn-push-compliance"
                            title={selectedId ? "Pushes to: Guesty tags (internal) · publicDescription.notes (OTA-facing) · licenseNumber field · taxId field · VRBO channel fields (requires VRBO OAuth in Guesty)" : "Select a Guesty listing first"}
                          >
                            ↑ Push Compliance to Guesty
                          </button>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)", marginBottom: 4 }}>
                              Tax Map Key (TMK)
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "monospace", background: "var(--muted)", padding: "6px 10px", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                              data-testid="text-tmk-value">
                              <span>{effectivePropertyData.taxMapKey ?? "—"}</span>
                              {effectivePropertyData.taxMapKey && (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                  onClick={() => { navigator.clipboard.writeText(effectivePropertyData.taxMapKey!); toast({ title: "Copied TMK" }); }}
                                  title="Copy to clipboard"
                                >📋</button>
                              )}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)", marginBottom: 4 }}>
                              GET License (General Excise Tax)
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "monospace", background: "var(--muted)", padding: "6px 10px", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                              data-testid="text-get-value">
                              <span>{effectivePropertyData.getLicense ?? "—"}</span>
                              {effectivePropertyData.getLicense && (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                  onClick={() => { navigator.clipboard.writeText(effectivePropertyData.getLicense!); toast({ title: "Copied GET License" }); }}
                                  title="Copy to clipboard"
                                >📋</button>
                              )}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)", marginBottom: 4 }}>
                              TAT License (Transient Accom. Tax)
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "monospace", background: "var(--muted)", padding: "6px 10px", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                              data-testid="text-tat-value">
                              <span>{effectivePropertyData.tatLicense ?? "—"}</span>
                              {effectivePropertyData.tatLicense && (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                  onClick={() => { navigator.clipboard.writeText(effectivePropertyData.tatLicense!); toast({ title: "Copied TAT License" }); }}
                                  title="Copy to clipboard"
                                >📋</button>
                              )}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)", marginBottom: 4 }}>
                              STR Permit Number
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "monospace", background: "var(--muted)", padding: "6px 10px", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                              data-testid="text-str-permit-value">
                              <span>{effectivePropertyData.strPermit ?? "—"}</span>
                              {effectivePropertyData.strPermit && (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                  onClick={() => { navigator.clipboard.writeText(effectivePropertyData.strPermit!); toast({ title: "Copied STR Permit" }); }}
                                  title="Copy to clipboard"
                                >📋</button>
                              )}
                            </div>
                          </div>
                        </div>
                        <div style={{ fontSize: 10, color: "var(--muted-foreground)", marginTop: 10, lineHeight: 1.6 }}>
                          Push writes to <strong>4 destinations</strong>: (1) Guesty internal tags <code>GET:</code> / <code>TAT:</code> / <code>TMK:</code> — (2) <code>licenseNumber</code> field (TAT number → Guesty's "Registration Number") — (3) <code>taxId</code> field (GET number) — (4) <em>Notes</em> field with a structured Hawaii Tax Compliance block (the field VRBO reads for license compliance). VRBO channel compliance fields (<code>channels.homeaway</code>) are also attempted but only save once you connect VRBO OAuth in Guesty's channel settings. After pushing, the toast shows exactly what was accepted.
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "bedding" && (
                  <BeddingTab propertyId={propertyId} guestyListingId={selectedId || null} />
                )}

                {activeTab === "amenities" && (() => {
                  // Build category groups from full catalog
                  const groups: Record<string, AmenityEntry[]> = {};
                  for (const entry of GUESTY_AMENITY_CATALOG) {
                    if (!groups[entry.category]) groups[entry.category] = [];
                    groups[entry.category].push(entry);
                  }
                  const selectedCount = pendingAmenities.size;

                  return (
                    <div>
                      {/* Push header */}
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, padding: "10px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{selectedCount} amenities selected</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                            {guesty_amenityCatalog.length > 0
                              ? `Using Guesty canonical IDs (${Object.keys(keyToGuestyId).length}/${GUESTY_AMENITY_CATALOG.length} mapped)`
                              : "Loading Guesty amenity catalog…"}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <button
                            onClick={() => setPendingAmenities(new Set(propertyId ? getGuestyAmenities(propertyId) : []))}
                            style={{ padding: "5px 10px", fontSize: 11, border: "1px solid var(--border)", borderRadius: 6, background: "white", cursor: "pointer", color: "var(--muted)" }}
                          >
                            Reset to profile
                          </button>
                          <button
                            disabled={fetchingLiveAmenities || !selectedId}
                            onClick={async () => {
                              if (!selectedId) return;
                              setFetchingLiveAmenities(true);
                              try {
                                const res = await fetch(`/api/builder/guesty-amenities?listingId=${selectedId}`);
                                const data = await res.json();
                                const canonical: string[] = Array.isArray(data.amenities) ? data.amenities : [];
                                const other: string[] = Array.isArray(data.otherAmenities) ? data.otherAmenities : [];
                                setGuestyLiveAmenities(guestyNamesToProfileKeys([...canonical, ...other]));
                              } catch {
                                setGuestyLiveAmenities(new Set());
                              } finally {
                                setFetchingLiveAmenities(false);
                              }
                            }}
                            style={{ padding: "5px 10px", fontSize: 11, border: "1px solid var(--border)", borderRadius: 6, background: "white", cursor: selectedId ? "pointer" : "not-allowed", color: "var(--muted)", opacity: fetchingLiveAmenities ? 0.6 : 1 }}
                          >
                            {fetchingLiveAmenities ? "Fetching…" : guestyLiveAmenities !== null ? "↺ Refresh from Guesty" : "↓ Fetch from Guesty"}
                          </button>
                          <button
                            onClick={pushAmenities}
                            disabled={amenityPushState === "pushing" || !selectedId}
                            style={{
                              padding: "7px 14px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: selectedId ? "pointer" : "not-allowed",
                              background: amenityPushState === "success" ? "var(--green)" : amenityPushState === "error" ? "var(--red)" : "var(--blue)",
                              color: "white", border: "none", opacity: amenityPushState === "pushing" ? 0.7 : 1,
                            }}
                            data-testid="button-push-amenities"
                          >
                            {amenityPushState === "pushing" ? "Pushing…" : amenityPushState === "success" ? "✓ Pushed!" : amenityPushState === "error" ? "✗ Failed" : "Push Amenities to Guesty"}
                          </button>
                        </div>
                      </div>

                      {/* Live Guesty diff panel */}
                      {guestyLiveAmenities !== null && (() => {
                        const profileKeys = new Set(propertyId ? getGuestyAmenities(propertyId) : []);
                        const inProfileNotGuesty = [...profileKeys].filter(k => !guestyLiveAmenities.has(k));
                        const inGuestyNotProfile = [...guestyLiveAmenities].filter(k => !profileKeys.has(k));
                        const keyToLabel = Object.fromEntries(GUESTY_AMENITY_CATALOG.map(e => [e.key, e.label]));
                        const allMatch = inProfileNotGuesty.length === 0 && inGuestyNotProfile.length === 0;
                        return (
                          <div style={{ marginBottom: 14, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: allMatch ? "#f0fdf4" : "#fffbeb" }}>
                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: allMatch ? "#15803d" : "#b45309" }}>
                              {allMatch ? "✓ Guesty matches your profile exactly" : "⚠ Guesty vs Profile mismatch"}
                            </div>
                            {inProfileNotGuesty.length > 0 && (
                              <div style={{ marginBottom: 8 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: "#b45309", marginBottom: 3 }}>
                                  In profile but NOT in Guesty — needs push ({inProfileNotGuesty.length}):
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                  {inProfileNotGuesty.map(k => (
                                    <span key={k} style={{ fontSize: 11, padding: "2px 7px", borderRadius: 12, background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e" }}>
                                      {keyToLabel[k] ?? k}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {inGuestyNotProfile.length > 0 && (
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 600, color: "#1d4ed8", marginBottom: 3 }}>
                                  In Guesty but NOT in profile — manually added or outdated ({inGuestyNotProfile.length}):
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                  {inGuestyNotProfile.map(k => (
                                    <span key={k} style={{ fontSize: 11, padding: "2px 7px", borderRadius: 12, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af" }}>
                                      {keyToLabel[k] ?? k}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {!allMatch && (
                              <div style={{ fontSize: 10, color: "#78716c", marginTop: 8 }}>
                                Amber tags = profile says yes but Guesty doesn't have it → click "Push Amenities to Guesty" to sync.
                                Blue tags = Guesty has it but it's not in your profile → add it to the profile or it will be removed on next push.
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Verification result — rejected items with Guesty suggestions */}
                      {amenityPushResult && (amenityPushResult.rejected?.length ?? 0) > 0 && (
                        <div style={{ padding: "10px 12px", marginBottom: 12, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, fontSize: 11 }}>
                          <strong style={{ color: "#d97706" }}>
                            ⚠ Guesty doesn't recognise {amenityPushResult.rejected!.length} profile amenit{amenityPushResult.rejected!.length === 1 ? "y" : "ies"}
                          </strong>
                          <div style={{ color: "#78350f", marginTop: 4, marginBottom: 6 }}>
                            These names don't map to any of Guesty's {amenityPushResult.guestyCatalogSize ?? "?"} supported amenities. Guesty's closest match is shown — tell me which ones are right and I'll add aliases.
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {(amenityPushResult.suggestions ?? []).map(({ name, suggestion, alternatives }) => (
                              <div key={name} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, flexWrap: "wrap" }}>
                                <span style={{ padding: "2px 7px", borderRadius: 10, background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e", minWidth: 160 }}>{name}</span>
                                <span style={{ color: "#9ca3af" }}>→</span>
                                <span style={{ color: suggestion ? "#065f46" : "#9ca3af", fontStyle: suggestion ? "normal" : "italic" }}>
                                  {suggestion ? `Guesty: "${suggestion}"` : "no close match — Guesty may not support this"}
                                </span>
                                {alternatives && alternatives.length > 0 && (
                                  <span style={{ color: "#6b7280", fontSize: 10 }}>
                                    other matches: {alternatives.map(a => `"${a}"`).join(", ")}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {amenityPushResult && amenityPushResult.missing.length > 0 && (amenityPushResult.rejected?.length ?? 0) === 0 && (
                        <div style={{ padding: "8px 12px", marginBottom: 12, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, fontSize: 11 }}>
                          <strong style={{ color: "#d97706" }}>⚠ Guesty didn't save {amenityPushResult.missing.length} amenit{amenityPushResult.missing.length === 1 ? "y" : "ies"}</strong>
                          <div style={{ color: "#92400e", marginTop: 2 }}>{amenityPushResult.missing.join(" · ")}</div>
                        </div>
                      )}

                      {/* Guesty catalog viewer (collapsible) */}
                      <details
                        open={showGuestyCatalog}
                        onToggle={(e) => setShowGuestyCatalog((e.target as HTMLDetailsElement).open)}
                        style={{ marginBottom: 12, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "white" }}
                      >
                        <summary style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", cursor: "pointer" }}>
                          🔍 View Guesty's supported amenity catalog ({guesty_amenityCatalog.length})
                        </summary>
                        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 240, overflowY: "auto" }}>
                          {guesty_amenityCatalog.map(a => (
                            <span key={a.name} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 10, background: "#f3f4f6", border: "1px solid #e5e7eb", color: "#374151" }}>{a.name}</span>
                          ))}
                        </div>
                      </details>

                      {amenityPushResult && amenityPushResult.missing.length === 0 && amenityPushState === "success" && (
                        <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--green-bg)", border: "1px solid var(--green-border)", borderRadius: 6, fontSize: 11, color: "var(--green)" }}>
                          ✓ All {amenityPushResult.saved} amenities confirmed in Guesty.
                        </div>
                      )}

                      {/* No listing selected warning */}
                      {!selectedId && (
                        <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: 6, fontSize: 11, color: "var(--amber)" }}>
                          Select a Guesty listing above to push amenities.
                        </div>
                      )}

                      {/* Category groups with checkboxes */}
                      {Object.entries(groups).map(([cat, items]) => (
                        <div key={cat} style={{ marginBottom: 16 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", padding: "6px 0 5px", borderBottom: "1px solid #e5e7eb", marginBottom: 8 }}>
                            <span>{cat}</span>
                            <span style={{ fontWeight: 400, color: "#9ca3af" }}>
                              {items.filter(i => pendingAmenities.has(i.key)).length}/{items.length}
                            </span>
                          </div>
                          <div className="glb-amenity-grid">
                            {items.map(({ key, label }) => {
                              const checked = pendingAmenities.has(key);
                              return (
                                <label
                                  key={key}
                                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 5, cursor: "pointer", userSelect: "none", background: checked ? "#f0fdf4" : "transparent", border: `1px solid ${checked ? "#bbf7d0" : "transparent"}`, transition: "all 0.1s" }}
                                  data-testid={`amenity-${key}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      const next = new Set(pendingAmenities);
                                      if (e.target.checked) next.add(key);
                                      else next.delete(key);
                                      setPendingAmenities(next);
                                      if (amenityPushState !== "idle") setAmenityPushState("idle");
                                    }}
                                    style={{ accentColor: "var(--green)", width: 13, height: 13, flexShrink: 0 }}
                                  />
                                  <span style={{ fontSize: 12, color: checked ? "#15803d" : "#6b7280" }}>{label}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {activeTab === "pricing" && (
                  pricing
                    ? <div>
                        <div className="glb-price-grid">
                          {[
                            { label: "Base Price / Night", val: pricing.basePrice != null ? `$${pricing.basePrice.toLocaleString()}` : null },
                            { label: "Currency", val: pricing.currency || "USD" },
                          ].filter((r) => r.val != null).map((r) => (
                            <div key={r.label} className="glb-price-card">
                              <div className="glb-price-label">{r.label}</div>
                              <div className="glb-price-val">{r.val}</div>
                            </div>
                          ))}
                        </div>

                        {seasonalMonths.length > 0 && (
                          <>
                            <div className="glb-season-hdr" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                              <span>24-Month Rate Schedule</span>
                              <div style={{ fontSize: 11, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                                {guestyRatesLoading && <span style={{ color: "#9ca3af" }}>Loading Guesty rates…</span>}
                                {guestyRatesError && (
                                  <span style={{ color: "#dc2626" }} title={guestyRatesError}>
                                    Guesty rates unavailable
                                  </span>
                                )}
                              </div>
                            </div>
                            <table className="glb-season-table">
                              <thead>
                                <tr>
                                  <th>Month</th>
                                  <th>Season</th>
                                  <th>Buy-In / Night</th>
                                  <th>Sheet Rate / Night</th>
                                  <th>Guesty Rate / Night</th>
                                  <th colSpan={4} style={{ textAlign: "center", borderLeft: "1px solid #e5e7eb" }}>
                                    Net Profit per Channel (at Guesty rate) — {(MIN_PROFIT_MARGIN * 100).toFixed(0)}% floor target
                                  </th>
                                </tr>
                                <tr>
                                  <th colSpan={5}></th>
                                  {(["airbnb", "vrbo", "booking", "direct"] as ChannelKey[]).map((ch, i) => (
                                    <th
                                      key={ch}
                                      style={{
                                        textAlign: "right",
                                        borderLeft: i === 0 ? "1px solid #e5e7eb" : undefined,
                                        fontSize: 10,
                                      }}
                                    >
                                      {ch === "airbnb" ? "Airbnb" : ch === "vrbo" ? "Vrbo" : ch === "booking" ? "Booking" : "Direct"}
                                      <span style={{ color: "#9ca3af", fontWeight: 400 }}> ({(CHANNEL_HOST_FEE[ch] * 100).toFixed(1)}%)</span>
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {seasonalMonths.map((row) => {
                                  const guesty = guestyRatesByMonth[row.yearMonth];
                                  const sheet = row.totalSell;
                                  const buyIn = row.totalBuyIn;
                                  // For each channel, compute what the host actually nets
                                  // at the current Guesty rate, and whether it meets the 20% floor.
                                  const channelCells = (["airbnb", "vrbo", "booking", "direct"] as ChannelKey[]).map((ch) => {
                                    if (!guesty) return { ch, profit: null, margin: null, ok: null, min: minProfitableRate(buyIn, ch), mk: 0 };
                                    // Apply per-channel markup — what the guest actually pays
                                    // on this channel is Guesty base rate * (1 + markup).
                                    // Host then nets that * (1 - channel fee).
                                    const mk = markupPct[ch] ?? 0;
                                    const channelRate = guesty.avgRate * (1 + mk);
                                    const netGross = netPayoutAfterChannelFee(channelRate, ch);
                                    const profit = Math.round(netGross - buyIn);
                                    const margin = buyIn > 0 ? profit / buyIn : 0;
                                    const ok = margin >= MIN_PROFIT_MARGIN;
                                    return { ch, profit, margin, ok, min: minProfitableRate(buyIn, ch), mk };
                                  });
                                  return (
                                    <tr key={row.yearMonth}>
                                      <td style={{ fontWeight: 500 }}>{row.month} {row.year}</td>
                                      <td>
                                        <span className={`glb-season-badge ${row.season}`}>
                                          {getSeasonLabel(row.season)}
                                        </span>
                                      </td>
                                      <td>${buyIn.toLocaleString()}</td>
                                      <td style={{ fontWeight: 600 }}>${sheet.toLocaleString()}</td>
                                      <td style={{ fontWeight: 600 }}>
                                        {guesty ? `$${guesty.avgRate.toLocaleString()}` : <span style={{ color: "#9ca3af" }}>—</span>}
                                        {guesty && guesty.minRate !== guesty.maxRate && (
                                          <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>
                                            ${guesty.minRate.toLocaleString()}–${guesty.maxRate.toLocaleString()}
                                          </div>
                                        )}
                                      </td>
                                      {channelCells.map((c, i) => {
                                        if (c.profit === null) {
                                          return (
                                            <td
                                              key={c.ch}
                                              style={{
                                                textAlign: "right",
                                                borderLeft: i === 0 ? "1px solid #e5e7eb" : undefined,
                                                color: "#9ca3af",
                                              }}
                                            >
                                              —
                                            </td>
                                          );
                                        }
                                        const bg = c.ok ? "#dcfce7" : "#fee2e2";
                                        const textColor = c.ok ? "#166534" : "#991b1b";
                                        const mkPct = (c.mk * 100).toFixed(1);
                                        const hoverText =
                                          `Need ≥ $${c.min.toLocaleString()}/night at 0% markup to hit 20% on ${c.ch}.`
                                          + (c.mk > 0 ? ` Markup +${mkPct}% → channel rate $${Math.round(guesty!.avgRate * (1 + c.mk)).toLocaleString()}.` : "")
                                          + ` Current net: $${c.profit.toLocaleString()} (${(c.margin! * 100).toFixed(0)}%).`;
                                        return (
                                          <td
                                            key={c.ch}
                                            title={hoverText}
                                            style={{
                                              textAlign: "right",
                                              borderLeft: i === 0 ? "1px solid #e5e7eb" : undefined,
                                              background: bg,
                                              color: textColor,
                                              fontWeight: 600,
                                              fontSize: 11,
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            ${c.profit.toLocaleString()}
                                            <div style={{ fontSize: 9, fontWeight: 400, opacity: 0.75 }}>
                                              {(c.margin! * 100).toFixed(0)}% · min ${c.min.toLocaleString()}
                                              {c.mk > 0 && <> · <b>+{mkPct}%</b> mk</>}
                                            </div>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            <div style={{ marginTop: 10, fontSize: 11, color: "#6b7280", lineHeight: 1.5 }}>
                              <b>Legend.</b> Each channel cell shows <b>net profit per night</b> at Guesty's current rate (after subtracting that channel's host fee).
                              <span style={{ background: "#dcfce7", color: "#166534", padding: "0 4px", borderRadius: 3, marginLeft: 4 }}>Green</span> = clears 20% floor.
                              {" "}<span style={{ background: "#fee2e2", color: "#991b1b", padding: "0 4px", borderRadius: 3 }}>Red</span> = below floor on that channel — <b>raise the rate or add a channel markup</b>.
                              {" "}Second line shows actual margin % and the minimum rate needed on that channel. Hover a cell for the full breakdown.
                            </div>
                          </>
                        )}
                      </div>
                    : <div className="glb-empty">No pricing data</div>
                )}

                {/* ── Channel markup push card ───────────────────────────── */}
                {activeTab === "pricing" && (
                  <ChannelMarkupCard
                    listingId={selectedId}
                    markupPct={markupPct}
                    setMarkupPct={setMarkupPct}
                    seasonalMonths={seasonalMonths}
                    guestyRatesByMonth={guestyRatesByMonth}
                  />
                )}

                {/* ── Booking Rules card (always shown in Pricing tab) ───── */}
                {activeTab === "pricing" && (
                  <div style={{ marginTop: 20, padding: "16px 20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>📋 Booking Rules</div>
                      <button
                        disabled={!selectedId || pushingBooking}
                        onClick={async () => {
                          if (!selectedId) return;
                          setPushingBooking(true);
                          try {
                            await guestyService.updateBookingSettings(selectedId, {
                              minNights: bookingRules.minNights,
                              maxNights: bookingRules.maxNights,
                              advanceNotice: bookingRules.advanceNotice,
                              preparationTime: bookingRules.preparationTime,
                              instantBooking: bookingRules.instantBooking,
                              cancellationPolicy: bookingRules.cancellationPolicy,
                            });
                            toast({
                              title: "Booking rules pushed to Guesty",
                              description: `Min ${bookingRules.minNights} nights · ${bookingRules.advanceNotice}d advance notice · ${bookingRules.preparationTime}d prep time`,
                            });
                          } catch (e: any) {
                            toast({ title: "Push failed", description: e.message, variant: "destructive" });
                          } finally {
                            setPushingBooking(false);
                          }
                        }}
                        style={{
                          fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 6,
                          border: "none", cursor: selectedId ? "pointer" : "not-allowed",
                          background: pushingBooking ? "#94a3b8" : selectedId ? "#0f766e" : "#94a3b8",
                          color: "#fff",
                        }}
                        data-testid="btn-push-booking-rules"
                        title={selectedId ? "Push booking rules to Guesty" : "Select a Guesty listing first"}
                      >
                        {pushingBooking ? "Pushing…" : "↑ Push to Guesty"}
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                      {/* Min nights */}
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)" }}>
                          Min Nights Stay
                        </span>
                        <input
                          type="number" min={1} max={90}
                          value={bookingRules.minNights}
                          onChange={e => setBookingRules(r => ({ ...r, minNights: Math.max(1, parseInt(e.target.value) || 1) }))}
                          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 14, fontWeight: 700, width: "100%", background: "var(--background)" }}
                          data-testid="input-min-nights"
                        />
                        <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>1 = any length · 3+ recommended for group rentals</span>
                      </label>

                      {/* Advance notice */}
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)" }}>
                          Advance Notice (days)
                        </span>
                        <input
                          type="number" min={0} max={90}
                          value={bookingRules.advanceNotice}
                          onChange={e => setBookingRules(r => ({ ...r, advanceNotice: Math.max(0, parseInt(e.target.value) || 0) }))}
                          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 14, fontWeight: 700, width: "100%", background: "var(--background)" }}
                          data-testid="input-advance-notice"
                        />
                        <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>0 = same day · 1 = 24h before check-in · 2 = 48h, etc.</span>
                      </label>

                      {/* Preparation time */}
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)" }}>
                          Prep / Cleaning Days
                        </span>
                        <input
                          type="number" min={0} max={14}
                          value={bookingRules.preparationTime}
                          onChange={e => setBookingRules(r => ({ ...r, preparationTime: Math.max(0, parseInt(e.target.value) || 0) }))}
                          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 14, fontWeight: 700, width: "100%", background: "var(--background)" }}
                          data-testid="input-prep-time"
                        />
                        <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>Days blocked after checkout for cleaning/turnover</span>
                      </label>

                      {/* Max nights */}
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)" }}>
                          Max Nights Stay
                        </span>
                        <input
                          type="number" min={1} max={730}
                          value={bookingRules.maxNights}
                          onChange={e => setBookingRules(r => ({ ...r, maxNights: Math.max(1, parseInt(e.target.value) || 365) }))}
                          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 14, fontWeight: 700, width: "100%", background: "var(--background)" }}
                          data-testid="input-max-nights"
                        />
                        <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>365 = no cap</span>
                      </label>

                      {/* Cancellation policy */}
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)" }}>
                          Cancellation Policy
                        </span>
                        <select
                          value={bookingRules.cancellationPolicy}
                          onChange={e => setBookingRules(r => ({ ...r, cancellationPolicy: e.target.value }))}
                          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 13, background: "var(--background)", width: "100%" }}
                          data-testid="select-cancellation-policy"
                        >
                          <option value="flexible">Flexible (full refund 24h before)</option>
                          <option value="moderate">Moderate (full refund 5 days before)</option>
                          <option value="strict">Strict (50% refund up to 1 week)</option>
                          <option value="super_strict_30">Super Strict 30 days</option>
                          <option value="super_strict_60">Super Strict 60 days</option>
                          <option value="non_refundable">Non-refundable</option>
                        </select>
                      </label>

                      {/* Instant booking toggle */}
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)" }}>
                          Instant Booking
                        </span>
                        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                          {[true, false].map(v => (
                            <button
                              key={String(v)}
                              onClick={() => setBookingRules(r => ({ ...r, instantBooking: v }))}
                              style={{
                                flex: 1, padding: "6px 0", borderRadius: 6, border: "1px solid",
                                fontSize: 13, fontWeight: 600, cursor: "pointer",
                                borderColor: bookingRules.instantBooking === v ? "#0f766e" : "var(--border)",
                                background: bookingRules.instantBooking === v ? "#0f766e" : "var(--background)",
                                color: bookingRules.instantBooking === v ? "#fff" : "var(--foreground)",
                              }}
                              data-testid={`btn-instant-${v}`}
                            >
                              {v ? "On" : "Off (Request)"}
                            </button>
                          ))}
                        </div>
                        <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>Off = guests must request, you approve</span>
                      </label>
                    </div>
                  </div>
                )}

                {activeTab === "availability" && (() => {
                  const scanned = availWindows.filter(w => w.status !== "unscanned" && w.status !== "scanning");
                  const okCount = availWindows.filter(w => w.status === "available").length;
                  const lowCount = availWindows.filter(w => w.status === "low").length;
                  const noneCount = availWindows.filter(w => w.status === "none").length;

                  // Group windows by year-month
                  const months: Record<string, typeof availWindows> = {};
                  availWindows.forEach(w => {
                    if (!months[w.monthKey]) months[w.monthKey] = [];
                    months[w.monthKey].push(w);
                  });

                  const statusColor = (s: string) =>
                    s === "available" ? "#16a34a" : s === "low" ? "#d97706" : s === "none" ? "#dc2626" :
                    s === "scanning" ? "#2563eb" : s === "error" ? "#9ca3af" : "#9ca3af";
                  const statusBg = (s: string) =>
                    s === "available" ? "#f0fdf4" : s === "low" ? "#fffbeb" : s === "none" ? "#fef2f2" :
                    s === "scanning" ? "#eff6ff" : "#f9fafb";
                  const statusLabel = (s: string) =>
                    s === "available" ? "✓ Available" : s === "low" ? "⚠ Low" : s === "none" ? "✗ Blocked" :
                    s === "scanning" ? "…" : s === "error" ? "Error" : "—";

                  const toBlockCount = availWindows.filter(w => w.status === "none" || w.status === "low").length;

                  return (
                    <div>
                      {/* Status bar */}
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                        {scanningAll ? (
                          <span style={{ fontSize: 13, color: "#2563eb", display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#2563eb", animation: "glb-blink 1s infinite" }} />
                            Scanning {scanIdx} of {availWindows.length} windows…
                            <button
                              className="glb-btn"
                              onClick={() => { scanAbort.current = true; }}
                              data-testid="btn-stop-scan"
                              style={{ fontSize: 11, marginLeft: 4, padding: "2px 8px" }}
                            >
                              Stop
                            </button>
                          </span>
                        ) : scanCompletedAt ? (
                          <span style={{ fontSize: 13, color: "#6b7280", display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ color: "#16a34a" }}>✓</span>
                            Scan complete — {scanCompletedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            <button
                              className="glb-btn"
                              onClick={() => {
                                setAvailWindows(p => p.map(w => ({ ...w, status: "unscanned" as const, availableCount: undefined, neededCount: undefined, unitResults: undefined, cheapestByBedroom: undefined, estimatedBuyInCost: undefined })));
                                setScanCompletedAt(null);
                                autoScanFired.current = false;
                              }}
                              data-testid="btn-rescan"
                              style={{ fontSize: 11, padding: "2px 8px" }}
                            >
                              ↺ Rescan
                            </button>
                          </span>
                        ) : (
                          <span style={{ fontSize: 13, color: "#9ca3af" }}>Preparing scan…</span>
                        )}
                        {selectedId && toBlockCount > 0 && !scanningAll && (
                          <button
                            className="glb-btn"
                            onClick={pushBlackouts}
                            data-testid="btn-push-blackouts"
                            style={{ borderColor: "#dc2626", color: "#dc2626" }}
                          >
                            Push {toBlockCount} Blackout{toBlockCount !== 1 ? "s" : ""} to Guesty
                          </button>
                        )}
                      </div>

                      {/* Summary */}
                      {scanned.length > 0 && (
                        <div style={{ display: "flex", gap: 16, marginBottom: 16, fontSize: 13 }}>
                          <span style={{ color: "#16a34a", fontWeight: 600 }}>✓ {okCount} available</span>
                          <span style={{ color: "#d97706", fontWeight: 600 }}>⚠ {lowCount} low</span>
                          <span style={{ color: "#dc2626", fontWeight: 600 }}>✗ {noneCount} blocked</span>
                          <span style={{ color: "#9ca3af" }}>{availWindows.length - scanned.length} unscanned</span>
                        </div>
                      )}

                      {/* Calendar grid */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                        {Object.entries(months).map(([mk, wins]) => {
                          const [yr, mo] = mk.split("-");
                          const monthName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(mo)-1];
                          return (
                            <div key={mk}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                {monthName} {yr}
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {wins.map(w => (
                                  <div
                                    key={w.id}
                                    data-testid={`avail-window-${w.id}`}
                                    style={{
                                      border: `1px solid ${statusColor(w.status)}40`,
                                      background: statusBg(w.status),
                                      borderRadius: 8,
                                      padding: "8px 12px",
                                      minWidth: 190,
                                      cursor: w.status !== "scanning" && w.status !== "available" ? "pointer" : "default",
                                    }}
                                    onClick={() => w.status !== "scanning" && w.status !== "available" && scanWindow(w)}
                                  >
                                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>{w.shortLabel}</div>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                      <span style={{
                                        fontSize: 12, fontWeight: 700,
                                        color: statusColor(w.status),
                                        background: `${statusColor(w.status)}18`,
                                        borderRadius: 4, padding: "2px 6px",
                                      }}>
                                        {statusLabel(w.status)}
                                      </span>
                                      {w.neededCount !== undefined && (
                                        <span style={{ fontSize: 11, color: "#9ca3af" }}>
                                          {w.availableCount}/{w.neededCount} units
                                        </span>
                                      )}
                                    </div>
                                    {w.estimatedBuyInCost !== undefined && (
                                      <div style={{ marginTop: 5, fontSize: 11, fontWeight: 600, color: "#374151" }}>
                                        Est. buy-in: ~${w.estimatedBuyInCost.toLocaleString()}
                                      </div>
                                    )}
                                    {w.cheapestByBedroom && (
                                      <div style={{ marginTop: 3 }}>
                                        {Object.entries(w.cheapestByBedroom).map(([br, info]) => (
                                          <div key={br} style={{ fontSize: 10, color: "#6b7280" }}>
                                            {br}BR: ${info.price.toLocaleString()} cheapest ({info.title.slice(0, 20)}{info.title.length > 20 ? "…" : ""})
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {w.unitResults && !w.cheapestByBedroom && (
                                      <div style={{ marginTop: 4 }}>
                                        {w.unitResults.map(r => (
                                          <div key={r.bedrooms} style={{ fontSize: 10, color: "#9ca3af" }}>
                                            {r.bedrooms}BR: {r.found}/{r.needed}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {(w.status === "available" || w.status === "low") && propertyId && (
                                      <a
                                        href={`/buy-in-tracker?propertyId=${propertyId}&checkIn=${w.checkIn}&checkOut=${w.checkOut}`}
                                        data-testid={`btn-find-buyin-${w.id}`}
                                        onClick={e => e.stopPropagation()}
                                        style={{
                                          display: "inline-block", marginTop: 6,
                                          fontSize: 11, fontWeight: 600,
                                          color: "#2563eb", textDecoration: "none",
                                          background: "#eff6ff", borderRadius: 4,
                                          padding: "2px 8px", border: "1px solid #bfdbfe",
                                        }}
                                      >
                                        Find Buy-Ins →
                                      </a>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Rate Trend Summary */}
                      {(() => {
                        const scannedWithCost = availWindows.filter(w => w.estimatedBuyInCost !== undefined);
                        if (scannedWithCost.length === 0) return null;
                        const monthMap: Record<string, number> = {};
                        scannedWithCost.forEach(w => {
                          const cur = monthMap[w.monthKey];
                          if (cur === undefined || w.estimatedBuyInCost! < cur) {
                            monthMap[w.monthKey] = w.estimatedBuyInCost!;
                          }
                        });
                        const sortedMonths = Object.keys(monthMap).sort();
                        if (sortedMonths.length === 0) return null;
                        return (
                          <div style={{ marginTop: 24, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
                              Rate Trend — Cheapest Est. Buy-In per Month
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} data-testid="rate-trend-summary">
                              {sortedMonths.map(mk => {
                                const [yr, mo] = mk.split("-");
                                const monthName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(mo)-1];
                                const cost = monthMap[mk];
                                return (
                                  <div key={mk} style={{
                                    background: "#f9fafb", border: "1px solid #e5e7eb",
                                    borderRadius: 8, padding: "6px 10px", textAlign: "center",
                                    minWidth: 70,
                                  }}>
                                    <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>{monthName} {yr.slice(2)}</div>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginTop: 2 }}>${Math.round(cost / 100) * 100 === cost ? cost.toLocaleString() : Math.round(cost).toLocaleString()}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {!propertyId && (
                        <div className="glb-empty">No propertyId — cannot scan</div>
                      )}
                    </div>
                  );
                })()}

                {activeTab === "photos" && (
                  photos.length > 0
                    ? <div>
                        {/* Push Photos header */}
                        <div style={{ marginBottom: 16 }}>
                          {upscalePhase !== "pushing" ? (
                            <>
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                                <button
                                  className="glb-btn glb-btn-primary"
                                  onClick={() => upscaleAndUpload(photos, doUpscale)}
                                  disabled={!selectedId}
                                  data-testid="btn-upscale-upload"
                                  style={{ fontSize: 13 }}
                                >
                                  {upscalePhase === "done" ? "↺ Re-push Photos to Guesty" : "⬆ Push Photos to Guesty"}
                                </button>

                                {/* Upscale toggle */}
                                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b7280", cursor: "pointer", userSelect: "none" }}>
                                  <input
                                    type="checkbox"
                                    checked={doUpscale}
                                    onChange={e => setDoUpscale(e.target.checked)}
                                    data-testid="toggle-upscale"
                                    style={{ width: 14, height: 14, cursor: "pointer" }}
                                  />
                                  Upscale 2× before pushing
                                  <span style={{ color: "#9ca3af" }}>(slower — ~30s/photo)</span>
                                </label>

                                {!selectedId && (
                                  <span style={{ fontSize: 12, color: "#9ca3af" }}>Select a Guesty listing above first</span>
                                )}

                                {/* Live Guesty photo count pill */}
                                {selectedId && (
                                  <span style={{
                                    display: "inline-flex", alignItems: "center", gap: 5,
                                    fontSize: 11, padding: "2px 8px", borderRadius: 12,
                                    background: guestyPhotoCountLoading ? "#f3f4f6" : (guestyPhotoCount ?? 0) > 0 ? "#dcfce7" : "#fee2e2",
                                    color: guestyPhotoCountLoading ? "#9ca3af" : (guestyPhotoCount ?? 0) > 0 ? "#15803d" : "#b91c1c",
                                    fontWeight: 500,
                                  }}>
                                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: guestyPhotoCountLoading ? "#9ca3af" : (guestyPhotoCount ?? 0) > 0 ? "#16a34a" : "#dc2626", display: "inline-block" }} />
                                    {guestyPhotoCountLoading ? "Checking Guesty…" : `${guestyPhotoCount ?? 0} photos in Guesty`}
                                  </span>
                                )}
                              </div>

                              {/* Normalize existing Guesty photos (rotate/resize/compress in-place) */}
                              {selectedId && (guestyPhotoCount ?? 0) > 0 && (
                                <div style={{ marginBottom: 10, padding: 10, background: "#fefce8", border: "1px solid #fde68a", borderRadius: 6 }}>
                                  {normalizePhase === "idle" || normalizePhase === "done" || normalizePhase === "error" ? (
                                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                      <button
                                        className="glb-btn"
                                        onClick={() => runNormalize("this")}
                                        disabled={!selectedId}
                                        style={{ fontSize: 12, background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" }}
                                        data-testid="btn-normalize-this"
                                      >
                                        🔧 Normalize photos already in Guesty
                                      </button>
                                      <span style={{ fontSize: 11, color: "#92400e" }}>
                                        Rotates portraits, resizes to 1920×1080, JPEG q90 4:4:4. Skips the cover collage. Fixes Booking.com "still processing" errors.
                                      </span>
                                      {normalizePhase === "done" && (
                                        <div style={{ width: "100%", fontSize: 12, color: "#15803d", marginTop: 4 }}>
                                          ✓ Done — {normalizeFixed} fixed, {normalizeSkipped} already OK, {normalizeFailed} failed
                                          {normalizeScope === "all" && normalizeListingCount > 0 && ` across ${normalizeListingCount} listings`}
                                        </div>
                                      )}
                                      {normalizePhase === "error" && (
                                        <div style={{ width: "100%", fontSize: 12, color: "#b91c1c", marginTop: 4 }}>✗ {normalizeError}</div>
                                      )}
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: 12, color: "#92400e" }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                                        <span>
                                          ⏳ {normalizeScope === "all" ? `${normalizeListingName || "starting…"} — ` : ""}
                                          photo {normalizeCurrent}/{normalizeTotal}
                                        </span>
                                        <span style={{ fontSize: 11, color: "#15803d" }}>✓ {normalizeFixed} fixed</span>
                                        <span style={{ fontSize: 11, color: "#6b7280" }}>○ {normalizeSkipped} ok</span>
                                        {normalizeFailed > 0 && <span style={{ fontSize: 11, color: "#b91c1c" }}>✗ {normalizeFailed} failed</span>}
                                        <button
                                          className="glb-btn"
                                          onClick={stopNormalize}
                                          style={{ fontSize: 11, background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca", marginLeft: "auto" }}
                                        >
                                          Stop
                                        </button>
                                      </div>
                                      {normalizeTotal > 0 && (
                                        <div style={{ height: 4, background: "#fde68a", borderRadius: 2, overflow: "hidden" }}>
                                          <div style={{ height: "100%", background: "#d97706", width: `${(normalizeCurrent / Math.max(normalizeTotal, 1)) * 100}%`, transition: "width 0.2s" }} />
                                        </div>
                                      )}
                                      {normalizeChanges.length > 0 && (
                                        <div style={{ marginTop: 6, maxHeight: 80, overflowY: "auto", fontSize: 10, fontFamily: "ui-monospace, monospace", color: "#6b7280" }}>
                                          {normalizeChanges.map((c, i) => <div key={i}>{c}</div>)}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Cover collage generator */}
                              {selectedId && (guestyPhotoCount ?? 0) > 0 && (
                                <div style={{ marginBottom: 10 }}>
                                  {collagePhase === "idle" || collagePhase === "done" || collagePhase === "error" ? (
                                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                                      <div>
                                        <button
                                          className="glb-btn"
                                          onClick={() => { setCollagePhase("idle"); generateCoverCollage(photos); }}
                                          disabled={collagePhase === "generating" || collagePhase === "uploading"}
                                          style={{ fontSize: 12, background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd" }}
                                        >
                                          {collagePhase === "done" ? "↺ Regenerate Cover Collage" : "🖼 Auto-Set Cover Collage"}
                                        </button>
                                        {collagePicks && (
                                          <div style={{ fontSize: 10, color: "#6b7280", marginTop: 3 }}>
                                            Picks: <em>{collagePicks.outdoor}</em> + <em>{collagePicks.indoor}</em>
                                          </div>
                                        )}
                                        {collagePhase === "done" && <div style={{ fontSize: 11, color: "#16a34a", marginTop: 2 }}>✓ Set as cover photo in Guesty</div>}
                                        {collagePhase === "error" && <div style={{ fontSize: 11, color: "#dc2626", marginTop: 2 }}>✗ {collageError}</div>}
                                      </div>
                                      {collagePreviewUrl && (
                                        <img src={collagePreviewUrl} alt="Cover collage preview" style={{ height: 54, borderRadius: 4, border: "1px solid #e5e7eb", objectFit: "cover" }} />
                                      )}
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: 12, color: "#2563eb" }}>
                                      {collagePhase === "upscaling" ? "⏳ Upscaling photos for best quality… (~30s)" :
                                       collagePhase === "generating" ? "⏳ Generating collage…" :
                                       "⏳ Uploading to Guesty…"}
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Persisted last-push summary — shown after refresh */}
                              {upscalePhase === "idle" && lastPushSummary && lastPushSummary.listingId === selectedId && (
                                <div style={{ fontSize: 12, color: "#374151", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "6px 10px", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                                  <span style={{ color: "#16a34a", fontWeight: 600 }}>✓ Last push:</span>
                                  {lastPushSummary.successCount}/{lastPushSummary.total} photos
                                  {lastPushSummary.upscaledCount > 0 && ` (${lastPushSummary.upscaledCount} upscaled)`}
                                  {lastPushSummary.failed > 0 && <span style={{ color: "#b45309" }}> — {lastPushSummary.failed} failed</span>}
                                  <span style={{ color: "#9ca3af", marginLeft: "auto" }}>
                                    {new Date(lastPushSummary.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                  </span>
                                </div>
                              )}

                              {upscalePhase === "done" && (() => {
                                const failed = pushResults.filter(r => !r.success);
                                const succeeded = pushResults.filter(r => r.success);
                                return (
                                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <span style={{ fontSize: 13, color: failed.length > 0 ? "#d97706" : "#16a34a" }}>
                                      ✓ {succeeded.length}/{upscaleTotal} photos pushed to Guesty
                                      {upscaledCount > 0 && ` (${upscaledCount} upscaled)`}
                                      {failed.length > 0 && ` — ${failed.length} failed`}
                                    </span>
                                    <button onClick={cancelPush} style={{ fontSize: 11, color: "#6b7280", background: "none", border: "1px solid #d1d5db", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}>
                                      Reset
                                    </button>
                                  </div>
                                );
                              })()}
                              {upscalePhase === "error" && (
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <span style={{ fontSize: 13, color: "#dc2626" }}>✗ {upscaleError}</span>
                                  <button onClick={cancelPush} style={{ fontSize: 11, color: "#6b7280", background: "none", border: "1px solid #d1d5db", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}>
                                    Reset
                                  </button>
                                </div>
                              )}
                            </>
                          ) : (
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#2563eb", animation: "glb-blink 1s infinite" }} />
                                <span style={{ fontSize: 13, color: "#2563eb", fontWeight: 500, flex: 1 }}>
                                  {savingToGuesty
                                    ? `Saving ${upscaleCurrent} photos to Guesty…`
                                    : upscaleCurrent > 0
                                    ? `${upscaleCurrent} / ${upscaleTotal} photos uploaded${upscaledCount > 0 ? ` (${upscaledCount} upscaled)` : ""}…`
                                    : `Starting — processing ${upscaleTotal} photos…`}
                                </span>
                                {!savingToGuesty && (
                                  <button
                                    onClick={cancelPush}
                                    style={{ fontSize: 11, color: "#6b7280", background: "none", border: "1px solid #d1d5db", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}
                                  >
                                    Cancel
                                  </button>
                                )}
                              </div>
                              <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden", marginBottom: 4 }}>
                                <div style={{
                                  height: "100%", borderRadius: 3, background: savingToGuesty ? "#16a34a" : "#2563eb",
                                  width: savingToGuesty ? "100%" : upscaleTotal > 0 ? `${Math.round((upscaleCurrent / upscaleTotal) * 100)}%` : "5%",
                                  transition: "width 0.4s ease",
                                }} />
                              </div>
                              <div style={{ fontSize: 11, color: "#9ca3af" }}>
                                {savingToGuesty
                                  ? "Saving final batch to Guesty…"
                                  : checkpointCount > 0
                                  ? `✓ ${checkpointCount * 5} photos already saved to Guesty — uploading remainder…`
                                  : doUpscale
                                  ? "Upscaling + hosting on ImgBB — ~30s per photo. Progress saved to Guesty every 5 photos."
                                  : "Hosting on ImgBB — a few seconds per photo. Progress saved to Guesty every 5 photos."}
                              </div>
                              {/* Live per-photo results */}
                              {pushResults.length > 0 && (
                                <div style={{ marginTop: 8, maxHeight: 120, overflowY: "auto", fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>
                                  {pushResults.slice(-6).map((r, i) => (
                                    <div key={i} style={{ color: r.success ? "#16a34a" : "#dc2626" }}>
                                      {r.success ? "✓" : "✗"} {r.localPath.split("/").pop()}{r.error ? ` — ${r.error}` : ""}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {/* Per-photo error details after done */}
                        {upscalePhase === "done" && pushResults.some(r => !r.success) && (
                          <div style={{ marginBottom: 12, padding: "8px 12px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 6, fontSize: 12 }}>
                            <div style={{ fontWeight: 600, color: "#92400e", marginBottom: 4 }}>Some photos failed:</div>
                            {pushResults.filter(r => !r.success).map((r, i) => (
                              <div key={i} style={{ color: "#b45309" }}>• {r.localPath.split("/").pop()} — {r.error}</div>
                            ))}
                          </div>
                        )}

                        {/* Photo groups */}
                        {(() => {
                          const groups: { source: string; items: typeof photos }[] = [];
                          photos.forEach((p, i) => {
                            const src = p.source || "Other";
                            const last = groups[groups.length - 1];
                            if (last && last.source === src) last.items.push(p);
                            else groups.push({ source: src, items: [p] });
                          });
                          let globalIdx = 0;
                          return groups.map((g) => (
                            <div key={g.source} style={{ marginBottom: 16 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", padding: "8px 0 6px", borderBottom: "1px solid #e5e7eb", marginBottom: 8 }}>
                                {g.source} — {g.items.length} photo{g.items.length !== 1 ? "s" : ""}
                              </div>
                              <div className="glb-photo-grid">
                                {g.items.map((p) => {
                                  const idx = ++globalIdx;
                                  return (
                                    <div key={idx} className="glb-photo-thumb" title={p.caption || ""}>
                                      <img src={p.url} alt={p.caption || `Photo ${idx}`} loading="lazy" />
                                      <span className="glb-photo-idx">{idx}</span>
                                      {p.caption && <span className="glb-photo-caption">{p.caption}</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ));
                        })()}
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
        {conn === "rate-limited" && (
          <div className="glb-error-banner" style={{ background: "var(--amber-bg)", borderColor: "var(--amber-border)", color: "var(--amber)" }}>
            <strong>Guesty API rate limited.</strong> Guesty limits how often new auth tokens can be requested (~5 per 24 hours). Your token will auto-refresh when the limit resets. Click the pill above to retry — it will reconnect automatically once the limit clears.
          </div>
        )}
        {conn === "disconnected" && (
          <div className="glb-error-banner">
            {connError?.includes("Missing GUESTY") ? (
              <>
                <strong>Guesty credentials not set.</strong> Add <code>GUESTY_CLIENT_ID</code> and <code>GUESTY_CLIENT_SECRET</code> to the Replit Secrets tab, then click the connection pill above to retry.
              </>
            ) : (
              <>
                <strong>Cannot connect to Guesty.</strong> {connError ? `Error: ${connError}. ` : ""}Click the connection pill above to retry, or check that your Guesty API credentials are valid.
              </>
            )}
          </div>
        )}

      </div>
    </>
  );
}
