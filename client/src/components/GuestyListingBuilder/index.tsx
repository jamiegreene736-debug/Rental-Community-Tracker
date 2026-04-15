import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { guestyService } from "@/services/guestyService";
import type { GuestyPropertyData, GuestyChannelStatus, BuildStepEntry } from "@/services/guestyService";
import { getPropertyPricing, getSeasonLabel, getSeasonBgClass } from "@/data/pricing-data";
import { GUESTY_AMENITY_CATALOG } from "@/data/guesty-amenities";
import { buildListingRooms, parseSqft } from "@/data/guesty-listing-config";
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
export default function GuestyListingBuilder({ propertyData, propertyId, onBuildComplete, onUpdateComplete }: Props) {
  const { toast } = useToast();
  const [conn, setConn] = useState<ConnState>("checking");
  const [connError, setConnError] = useState<string | null>(null);
  const [listings, setListings] = useState<GuestyListing[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [channelStatus, setChannelStatus] = useState<GuestyChannelStatus | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [activeTab, setActiveTab] = useState<"photos" | "amenities" | "descriptions" | "pricing" | "availability">("descriptions");
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildSuccess, setBuildSuccess] = useState(false);

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

  // ── Photo upscale + upload ─────────────────────────────────────────────────
  type UpscalePhase = "idle" | "upscaling" | "uploading" | "done" | "error";
  const [upscalePhase, setUpscalePhase] = useState<UpscalePhase>("idle");
  const [upscaleCurrent, setUpscaleCurrent] = useState(0);
  const [upscaleTotal, setUpscaleTotal] = useState(0);
  const [upscaledCount, setUpscaledCount] = useState(0);
  const [upscaleError, setUpscaleError] = useState<string | null>(null);

  const upscaleAndUpload = useCallback(async (photos: GuestyPropertyData["photos"]) => {
    if (!selectedId || !photos?.length) return;
    setUpscalePhase("upscaling");
    setUpscaleTotal(photos.length);
    setUpscaleCurrent(0);
    setUpscaledCount(0);
    setUpscaleError(null);

    const origin = window.location.origin;
    const upgradedPhotos: { url: string; caption: string }[] = [];

    for (let i = 0; i < photos.length; i++) {
      setUpscaleCurrent(i + 1);
      const p = photos[i];
      // Extract local path from absolute URL (e.g. "/photos/pili-mai/photo_00.jpg")
      let localPath: string;
      try {
        localPath = new URL(p.url).pathname;
      } catch {
        localPath = p.url.startsWith("/") ? p.url : p.url.replace(origin, "");
      }

      try {
        const resp = await fetch("/api/builder/upscale-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ localPath }),
        });
        const data = await resp.json();
        if (resp.ok && data.url) {
          upgradedPhotos.push({ url: data.url, caption: p.caption || "" });
          if (data.wasUpscaled) setUpscaledCount(c => c + 1);
        } else {
          // Fall back to original URL if upscale fails for this photo
          upgradedPhotos.push({ url: p.url, caption: p.caption || "" });
        }
      } catch {
        upgradedPhotos.push({ url: p.url, caption: p.caption || "" });
      }
    }

    setUpscalePhase("uploading");
    try {
      await guestyService.uploadPhotos(selectedId, upgradedPhotos.map(p => ({ ...p, source: "" })));
      setUpscalePhase("done");
    } catch (err: any) {
      setUpscaleError(err?.message || "Upload to Guesty failed");
      setUpscalePhase("error");
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
    if (!propertyData) {
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

    const totalSteps = [true, !!propertyData.descriptions, !!(propertyData.photos?.length), !!propertyData.pricing, !!propertyData.bookingSettings].filter(Boolean).length;
    let done = 0;

    let result: Awaited<ReturnType<typeof guestyService.buildFullListing>>;
    try {
      result = await guestyService.buildFullListing(propertyData, (step, status) => {
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
  }, [propertyData, building, conn, onBuildComplete, toast]);

  // ── Push updates ──────────────────────────────────────────────────────────
  const handleUpdate = useCallback(async () => {
    if (!propertyData || !selectedId || building) return;
    setBuilding(true);
    setLog([]);
    setProgress(0);

    const totalSteps = [!!(propertyData.listingRooms?.length), !!propertyData.descriptions, !!(propertyData.photos?.length), !!propertyData.pricing, !!propertyData.bookingSettings].filter(Boolean).length;
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

  const pillLabel = conn === "checking" ? "Checking connection…" : conn === "connected" ? "Guesty Connected" : conn === "rate-limited" ? "Rate Limited — retry later" : "Guesty Disconnected";
  const photos = propertyData?.photos || [];
  const amenities = propertyData?.amenities || [];
  const descriptions = propertyData?.descriptions;
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
              <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(74,222,128,0.1)", border: "1px solid #4ade80", borderRadius: 8, fontSize: 13, color: "#4ade80", display: "flex", alignItems: "center", gap: 8 }}>
                <span>✓</span>
                <span>Listing created successfully on Guesty! It appears in the dropdown above as a draft.</span>
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
                {(["descriptions", "amenities", "pricing", "photos", "availability"] as const).map((t) => (
                  <button key={t} className={`glb-tab ${activeTab === t ? "active" : ""}`} onClick={() => setActiveTab(t)} data-testid={`tab-${t}`}>
                    {t === "photos" ? `Photos (${photos.length})` :
                     t === "amenities" ? `Amenities (${amenities.length})` :
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
                    {descriptions
                      ? (Object.entries(descriptions) as [string, string | undefined][]).map(([key, val]) =>
                          val ? (
                            <div key={key} className="glb-desc-block">
                              <div className="glb-desc-label">{key.replace(/([A-Z])/g, " $1").trim()}</div>
                              <div className="glb-desc-text">{val}</div>
                            </div>
                          ) : null
                        )
                      : <div className="glb-empty">No descriptions provided</div>
                    }
                  </div>
                )}

                {activeTab === "amenities" && (
                  amenities.length > 0
                    ? (() => {
                        const amenitySet = new Set(amenities);
                        const groups: Record<string, { key: string; label: string }[]> = {};
                        for (const entry of GUESTY_AMENITY_CATALOG) {
                          if (!amenitySet.has(entry.key)) continue;
                          if (!groups[entry.category]) groups[entry.category] = [];
                          groups[entry.category].push({ key: entry.key, label: entry.label });
                        }
                        const ungrouped = amenities.filter(a => !GUESTY_AMENITY_CATALOG.find(e => e.key === a));
                        if (ungrouped.length) {
                          if (!groups["Other"]) groups["Other"] = [];
                          ungrouped.forEach(a => groups["Other"].push({ key: a, label: a.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) }));
                        }
                        return (
                          <div>
                            {Object.entries(groups).map(([cat, items]) => (
                              <div key={cat} style={{ marginBottom: 16 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", padding: "6px 0 5px", borderBottom: "1px solid #e5e7eb", marginBottom: 8 }}>
                                  {cat} — {items.length}
                                </div>
                                <div className="glb-amenity-grid">
                                  {items.map(({ key, label }) => (
                                    <div key={key} className="glb-amenity">
                                      <span className="glb-amenity-check">✓</span>
                                      {label}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()
                    : <div className="glb-empty">No amenities listed</div>
                )}

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
                            <div className="glb-season-hdr">24-Month Rate Schedule</div>
                            <table className="glb-season-table">
                              <thead>
                                <tr>
                                  <th>Month</th>
                                  <th>Season</th>
                                  <th>Buy-In / Night</th>
                                  <th>Guest Charge / Night</th>
                                  <th>Profit / Night</th>
                                </tr>
                              </thead>
                              <tbody>
                                {seasonalMonths.map((row) => (
                                  <tr key={row.yearMonth}>
                                    <td style={{ fontWeight: 500 }}>{row.month} {row.year}</td>
                                    <td>
                                      <span className={`glb-season-badge ${row.season}`}>
                                        {getSeasonLabel(row.season)} Season
                                      </span>
                                    </td>
                                    <td>${row.totalBuyIn.toLocaleString()}</td>
                                    <td style={{ fontWeight: 600 }}>${row.totalSell.toLocaleString()}</td>
                                    <td style={{ color: "#16a34a" }}>${(row.totalSell - row.totalBuyIn).toLocaleString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </>
                        )}
                      </div>
                    : <div className="glb-empty">No pricing data</div>
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
                        {/* Upscale & Upload header */}
                        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                          {upscalePhase === "idle" || upscalePhase === "done" || upscalePhase === "error" ? (
                            <>
                              <button
                                className="glb-btn glb-btn-primary"
                                onClick={() => upscaleAndUpload(photos)}
                                disabled={!selectedId || upscalePhase === "upscaling" || upscalePhase === "uploading"}
                                data-testid="btn-upscale-upload"
                                style={{ fontSize: 13 }}
                              >
                                {upscalePhase === "done" ? "↺ Upscale & Re-upload to Guesty" : "⬆ Upscale & Upload to Guesty"}
                              </button>
                              {!selectedId && (
                                <span style={{ fontSize: 12, color: "#9ca3af" }}>Select a Guesty listing above first</span>
                              )}
                              {upscalePhase === "done" && (
                                <span style={{ fontSize: 13, color: "#16a34a" }}>
                                  ✓ Done — {upscaledCount} of {upscaleTotal} photos upscaled, all sent to Guesty
                                </span>
                              )}
                              {upscalePhase === "error" && (
                                <span style={{ fontSize: 13, color: "#dc2626" }}>✗ {upscaleError}</span>
                              )}
                            </>
                          ) : (
                            <div style={{ flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#2563eb", animation: "glb-blink 1s infinite" }} />
                                <span style={{ fontSize: 13, color: "#2563eb", fontWeight: 500 }}>
                                  {upscalePhase === "upscaling"
                                    ? `Upscaling photo ${upscaleCurrent} of ${upscaleTotal}…`
                                    : "Sending upscaled photos to Guesty…"}
                                </span>
                              </div>
                              <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden" }}>
                                <div style={{
                                  height: "100%", borderRadius: 3, background: "#2563eb",
                                  width: upscalePhase === "uploading" ? "100%" : `${Math.round((upscaleCurrent / upscaleTotal) * 100)}%`,
                                  transition: "width 0.3s ease",
                                }} />
                              </div>
                              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                                {upscaledCount} upscaled so far — Real-ESRGAN 2× via Replicate
                              </div>
                            </div>
                          )}
                        </div>

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
