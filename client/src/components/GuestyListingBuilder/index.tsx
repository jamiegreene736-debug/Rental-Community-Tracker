import { Component, useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type CSSProperties } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { guestyService } from "@/services/guestyService";
import type { GuestyPropertyData, GuestyChannelStatus, BuildStepEntry, GuestyListingSummary } from "@/services/guestyService";
import { getPropertyPricing, getSeasonLabel, getSeasonBgClass, minProfitableRate, netPayoutAfterChannelFee, setLivePropertyMarketRates, getLiveBuyIn, getBuyInRate, cleanBaseRateFromBuyIn, CHANNEL_HOST_FEE, MIN_PROFIT_MARGIN, type ChannelKey, type LivePropertyMarketRateInput } from "@/data/pricing-data";
import { GUESTY_AMENITY_CATALOG, getGuestyAmenities, type AmenityEntry } from "@/data/guesty-amenities";
import { buildListingRooms, parseSqft, syncSleepsInTitle } from "@/data/guesty-listing-config";
import {
  loadBeddingConfig as loadBuilderBeddingConfig,
  buildGuestyListingRooms as buildBeddingListingRooms,
  totalBedrooms as totalBeddingBedrooms,
  totalBathrooms as totalBeddingBathrooms,
  totalSleeps as totalBeddingSleeps,
} from "@/data/bedding-config";
import { BeddingTab } from "./BeddingTab";
import AvailabilityTab from "./AvailabilityTab";
import PhotoCurator, { type CoverCollageSelection } from "./PhotoCurator";
import { PhotoSyncStatusPanel } from "@/components/PhotoSyncStatusPanel";
import { getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import { sampleLicensesForLocation } from "@/data/adapt-draft";
import { useToast } from "@/hooks/use-toast";
import { isFloridaLicenseJurisdiction, isPlaceholderLicenseValue, resolveLicenseComplianceProfile, type LicenseFieldKey, type LicenseRequirement } from "@shared/license-compliance";

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
  .glb-listing-bar { position:sticky; top:72px; z-index:30; margin:0 0 24px; padding:10px 0 12px; background:rgba(255,255,255,.96); border-bottom:1px solid var(--border); backdrop-filter:blur(8px); }
  .glb-listing-bar .glb-section-label { margin-bottom:8px; }
  .glb-listing-row { margin-bottom:0; }
  .glb-sel { background:#fff; border:1px solid var(--border); color:var(--text); padding:8px 12px; border-radius:8px; font-size:13px; flex:1; min-width:260px; max-width:720px; cursor:pointer; outline:none; transition:border-color .2s; }
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
  .glb-badge.live-warn { background:#fffbeb; border-color:#f59e0b; color:#b45309; }
  .glb-badge.not-live { background:var(--red-bg); border-color:var(--red-border); color:var(--red); }
  .glb-badge.no-account { background:var(--bg-hover); border-color:var(--border); color:var(--faint); }
  .glb-badge-dot { width:5px; height:5px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .glb-ch-meta { font-size:11px; color:var(--muted); margin-top:6px; font-family:monospace; word-break:break-all; }

  /* Data panel */
  .glb-panel { background:#fff; border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:20px; }
  .glb-data-push-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:10px; padding:10px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:10px; }
  .glb-data-push-meta { display:flex; gap:8px; flex-wrap:wrap; flex:1; min-width:260px; }
  .glb-data-push-item { display:flex; align-items:center; gap:6px; padding:5px 8px; background:#fff; border:1px solid var(--border); border-radius:8px; font-size:11px; color:var(--muted); }
  .glb-data-push-item strong { color:var(--text); font-weight:600; }
  .glb-data-push-item.success { border-color:var(--green-border); background:var(--green-bg); color:#166534; }
  .glb-data-push-item.error { border-color:var(--red-border); background:var(--red-bg); color:#991b1b; }
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
type GuestyListing = GuestyListingSummary;
type LogEntry = BuildStepEntry & { icon: string };
type DataPushRow = "descriptions" | "bedding" | "amenities" | "photos" | "bookable" | "availability" | "pricing";
type DataPushStatus = "success" | "error";
type DataPushLog = Partial<Record<DataPushRow, { pushedAt: string; status: DataPushStatus; message: string }>>;
type DataPushTab = Exclude<DataPushRow, "bookable">;
type ComplianceLookupResult = {
  value: string;
  confidence: string;
  note: string;
  searchedAddress?: string;
  geocodedAddress?: string;
  taxMapKey?: string;
  source: string;
  sourceUrl?: string;
};
type TmkLookupResult = ComplianceLookupResult & {
  taxMapKey: string;
  confidence: "unit-cpr" | "master-parcel" | "public-listing";
  searchedAddress: string;
  geocodedAddress: string;
};

type Props = {
  propertyData?: GuestyPropertyData | null;
  propertyId?: number;
  // folder → source listing URL (Zillow/Airbnb/VRBO). Fed straight to the
  // PhotoCurator so each unit section can show a "View source listing" link.
  sourceUrlsByFolder?: Record<string, string>;
  isSingleListing?: boolean;
  onBuildComplete?: (result: { listingId: string | null }) => void;
  onUpdateComplete?: (result: { listingId: string | null }) => void;
  // Fired after the user mutates a photo label (delete/restore/rename) in
  // the PhotoCurator. The builder page uses this to re-fetch
  // `usePhotoLabels` so the page's isHidden filter picks up the new state
  // and `propertyData.photos` rebuilds without a full page reload — the
  // tab badge "Photos (N)" and the deleted tile disappear immediately.
  onPhotoOverridesChanged?: () => void;
};

const DEFAULT_BOOKING_RULES = {
  minNights: 3,
  maxNights: 365,
  advanceNotice: 7,
  preparationTime: 1,
  instantBooking: true,
  cancellationPolicies: {
    airbnb: "firm",
    vrbo: "FIRM",
    booking: "strict",
  },
};

type OtaVisibilityPlatform = "booking" | "vrbo";
type OtaVisibilityStatus = "queued" | "running" | "found" | "not_found" | "error";
type OtaVisibilityJob = {
  id: string;
  platform: OtaVisibilityPlatform;
  status: OtaVisibilityStatus;
  propertyId: number;
  startedAt: string;
  searchedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  searchUrl: string | null;
  foundUrl: string | null;
  foundPage: number | null;
  foundPosition: number | null;
  candidatesChecked: number;
  positionLog: string[];
  error: string | null;
};

type OtaVisibilityResponse = {
  propertyId: number;
  booking: OtaVisibilityJob | null;
  vrbo: OtaVisibilityJob | null;
};

function formatOtaVisibilityTime(value: string | null | undefined) {
  if (!value) return "Not run yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function OtaVisibilityStatusBadge({ status }: { status: OtaVisibilityStatus | null | undefined }) {
  const label = status ? status.replace("_", " ") : "not run";
  const color =
    status === "found" ? "#166534" :
    status === "running" || status === "queued" ? "#1d4ed8" :
    status === "error" ? "#991b1b" :
    "#6b7280";
  const bg =
    status === "found" ? "#dcfce7" :
    status === "running" || status === "queued" ? "#dbeafe" :
    status === "error" ? "#fee2e2" :
    "#f3f4f6";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, color, background: bg, textTransform: "capitalize" }}>
      {label}
    </span>
  );
}

function otaVisibilityStep(status: OtaVisibilityStatus | null | undefined): number {
  if (status === "found" || status === "not_found" || status === "error") return 100;
  if (status === "running") return 60;
  if (status === "queued") return 25;
  return 0;
}

function OtaVisibilityPanel({ propertyId }: { propertyId?: number }) {
  const { toast } = useToast();
  const [data, setData] = useState<OtaVisibilityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<Partial<Record<OtaVisibilityPlatform, boolean>>>({});

  const loadVisibility = useCallback(async () => {
    if (!propertyId) return;
    try {
      const response = await fetch(`/api/builder/ota-visibility/${propertyId}`);
      if (!response.ok) throw new Error(`Visibility load failed (${response.status})`);
      const payload = await response.json() as OtaVisibilityResponse;
      setData(payload);
      const nextRunning: Partial<Record<OtaVisibilityPlatform, boolean>> = {};
      for (const platform of ["booking", "vrbo"] as const) {
        const job = payload[platform];
        nextRunning[platform] = job?.status === "queued" || job?.status === "running";
      }
      setRunning(nextRunning);
    } catch (error) {
      console.error("[ota-visibility] load failed", error);
    }
  }, [propertyId]);

  useEffect(() => {
    void loadVisibility();
  }, [loadVisibility]);

  useEffect(() => {
    if (!running.booking && !running.vrbo) return;
    const timer = window.setInterval(() => void loadVisibility(), 2500);
    return () => window.clearInterval(timer);
  }, [loadVisibility, running.booking, running.vrbo]);

  const runPlatform = async (platform: OtaVisibilityPlatform) => {
    if (!propertyId) return;
    setLoading(true);
    setRunning((prev) => ({ ...prev, [platform]: true }));
    try {
      const response = await fetch(`/api/builder/ota-visibility/${propertyId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || `Visibility search failed (${response.status})`);
      }
      await loadVisibility();
    } catch (error) {
      toast({
        title: "Visibility search failed",
        description: error instanceof Error ? error.message : "Could not start the OTA search.",
        variant: "destructive",
      });
      setRunning((prev) => ({ ...prev, [platform]: false }));
    } finally {
      setLoading(false);
    }
  };

  const runBoth = async () => {
    if (!propertyId || loading || running.booking || running.vrbo) return;
    setLoading(true);
    setRunning({ booking: true, vrbo: true });
    try {
      await Promise.all((["booking", "vrbo"] as const).map(async (platform) => {
        const response = await fetch(`/api/builder/ota-visibility/${propertyId}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(payload?.error || `Could not start ${platform} visibility search (${response.status})`);
        }
      }));
      await loadVisibility();
    } catch (error) {
      toast({
        title: "Visibility search failed",
        description: error instanceof Error ? error.message : "Could not start both OTA searches.",
        variant: "destructive",
      });
      setRunning({});
    } finally {
      setLoading(false);
    }
  };

  const bookingJob = data?.booking ?? null;
  const vrboJob = data?.vrbo ?? null;
  const overallProgress = Math.round((otaVisibilityStep(bookingJob?.status) + otaVisibilityStep(vrboJob?.status)) / 2);
  const activeCount = Number(!!running.booking) + Number(!!running.vrbo);
  const finishedCount = [bookingJob, vrboJob].filter((job) => job?.status === "found" || job?.status === "not_found" || job?.status === "error").length;
  const progressLabel = activeCount > 0
    ? `${activeCount} search${activeCount === 1 ? "" : "es"} running`
    : finishedCount === 2
      ? "Both searches finished"
      : finishedCount === 1
        ? "1 of 2 searches finished"
        : "Ready to search";

  const renderJob = (platform: OtaVisibilityPlatform, label: string) => {
    const job = data?.[platform] ?? null;
    const isRunning = !!running[platform];
    return (
      <div key={platform} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, background: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{label}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {job?.checkIn && job?.checkOut ? `${job.checkIn} to ${job.checkOut} (${job.nights} nights)` : "Uses the next Guesty available date window."}
            </div>
          </div>
          <OtaVisibilityStatusBadge status={job?.status} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 12 }}>
          {[
            ["Searched", formatOtaVisibilityTime(job?.searchedAt)],
            ["Updated", formatOtaVisibilityTime(job?.updatedAt)],
            ["Page", job?.foundPage ? String(job.foundPage) : "—"],
            ["Position", job?.foundPosition ? String(job.foundPosition) : "—"],
          ].map(([k, v]) => (
            <div key={k} style={{ background: "var(--bg-card)", borderRadius: 6, padding: "7px 8px", minWidth: 0 }}>
              <div style={{ fontSize: 10, color: "var(--faint)", textTransform: "uppercase", letterSpacing: ".4px" }}>{k}</div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</div>
            </div>
          ))}
        </div>
        {job?.foundUrl && (
          <a href={job.foundUrl} target="_blank" rel="noreferrer" style={{ display: "inline-block", fontSize: 12, color: "#1d4ed8", marginBottom: 10 }}>
            Open found listing
          </a>
        )}
        {job?.positionLog?.length ? (
          <div style={{ background: "#f8fafc", border: "1px solid var(--border)", borderRadius: 6, padding: 9, marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 5 }}>Result position log</div>
            {job.positionLog.slice(0, 8).map((line, index) => (
              <div key={`${platform}-pos-${index}`} style={{ fontFamily: "monospace", fontSize: 11, color: "#374151", lineHeight: 1.5 }}>{line}</div>
            ))}
          </div>
        ) : null}
        {job?.error && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 10 }}>{job.error}</div>}
        <button
          type="button"
          className="glb-btn"
          disabled={!propertyId || loading || isRunning}
          onClick={() => runPlatform(platform)}
          data-testid={`btn-ota-visibility-${platform}`}
        >
          {isRunning ? "Searching…" : `Search ${label}`}
        </button>
      </div>
    );
  };

  if (!propertyId) {
    return <div style={{ color: "var(--muted)", fontSize: 13 }}>Save or select a dashboard property before running OTA visibility checks.</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>OTA Visibility Search</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)" }}>
            Finds the listing in Booking.com and VRBO search results for the next Guesty-available date window, then logs dates, page, and result position.
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--faint)" }}>
            Run both starts Booking.com and VRBO together; each card updates from queued to running to finished.
          </p>
        </div>
        <button
          type="button"
          className="glb-btn glb-btn-primary"
          disabled={loading || running.booking || running.vrbo}
          onClick={() => void runBoth()}
          data-testid="btn-ota-visibility-all"
        >
          {loading || running.booking || running.vrbo ? "Running…" : "Run both"}
        </button>
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--bg-card)", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{progressLabel}</span>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{overallProgress}%</span>
        </div>
        <div style={{ height: 8, borderRadius: 999, background: "#e5e7eb", overflow: "hidden" }}>
          <div
            style={{
              width: `${overallProgress}%`,
              height: "100%",
              borderRadius: 999,
              background: "linear-gradient(90deg, #3aa7b4, #1d4ed8)",
              transition: "width .25s ease",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
          <span>Booking.com: {bookingJob?.status?.replace("_", " ") ?? "not run"}</span>
          <span>VRBO: {vrboJob?.status?.replace("_", " ") ?? "not run"}</span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        {renderJob("booking", "Booking.com")}
        {renderJob("vrbo", "VRBO")}
      </div>
    </div>
  );
}

class BuilderSectionErrorBoundary extends Component<
  { resetKey: string; fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[GuestyListingBuilder] optional section render failed", error);
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

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

function fmtDateTime(value?: string | number | null) {
  if (value == null) return "never";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusIcon(status: string) {
  if (status === "success") return "✓";
  if (status === "error") return "✗";
  return "…";
}

function normalizeListingName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[–—-]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guestyListingId(listing: GuestyListing | null | undefined): string {
  return String(listing?._id ?? listing?.id ?? "").trim();
}

function guestyListingAddress(listing: GuestyListing | null | undefined): string {
  const address = listing?.address;
  if (!address) return "";
  if (typeof address === "string") return address.trim();
  return [
    address.full,
    [address.city, address.state].filter(Boolean).join(", "),
    address.zipcode,
  ].find((part) => String(part ?? "").trim())?.trim() ?? "";
}

function guestyListingOptionLabel(listing: GuestyListing): string {
  const name = listing.nickname || listing.title || guestyListingId(listing);
  const address = guestyListingAddress(listing);
  return address ? `${name} - ${address}` : name;
}

function dataPushStorageKey(listingId: string, propertyId?: number) {
  return `nexstay_data_push_${listingId}_${propertyId ?? "unknown"}`;
}

// Live status of the market-pricing refresh + Guesty rate push kicked off by
// the unified "Push … & Pricing" button. The pricing step is ASYNC — the
// button queues a /api/pricing/bulk-refresh job that first runs the SearchAPI
// Airbnb P40 refresh and only THEN pushes the marked-up base rates to Guesty —
// so the operator needs to see when the rate push actually lands, not just
// that the refresh was queued. Mirrors the bulk-refresh item's progress shape
// (phase: searchapi-airbnb -> pushing-guesty -> done). Persisted per-property
// so it survives a builder remount / reload while the job runs in the cloud.
type PricingPushStatus = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  percent: number;
  label: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};
function pricingPushStatusKeyFor(propertyId?: number) {
  return `nexstay.market-rate-push.${propertyId ?? "unknown"}.status`;
}

function formatDataPushTime(value?: string) {
  if (!value) return "Never pushed";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Never pushed";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDataPushTabTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function dataPushTabLabel(tab: DataPushTab, photosCount: number) {
  if (tab === "photos") return `Photos (${photosCount})`;
  if (tab === "availability") return "Availability";
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

type GuestyMonthlyRate = {
  avgRate: number;
  minRate: number;
  maxRate: number;
  days: number;
};

// ─── Market-rate old→new summary ──────────────────────────────────────────────
// Shows the previous vs current market-rate basis (per bedroom) from the most
// recent pricing_update_logs row, captured at each market-rate refresh (manual
// or bulk). The basis is the LOW-season medianNightly that drives the seasonal
// rates table below it. See GET /api/pricing/update-logs.
type PricingUpdateLogRow = {
  bedrooms: number;
  oldRate: string | null;
  newRate: string | null;
  triggerType: string;
  createdAt: string;
};
function MarketRateChangeSummary({ propertyId }: { propertyId?: number }) {
  const { data } = useQuery<{ ok: boolean; logs: PricingUpdateLogRow[] }>({
    queryKey: ["/api/pricing/update-logs", propertyId],
    queryFn: async () => {
      const r = await fetch(`/api/pricing/update-logs?propertyId=${propertyId}&limit=30`, { credentials: "include" });
      if (!r.ok) throw new Error(`pricing logs ${r.status}`);
      return r.json();
    },
    enabled: typeof propertyId === "number" && propertyId > 0,
    staleTime: 30_000,
  });
  const logs = data?.logs ?? [];
  if (logs.length === 0) return null;
  // logs are newest-first → keep the latest row per bedroom
  const byBR = new Map<number, PricingUpdateLogRow>();
  for (const l of logs) if (!byBR.has(l.bedrooms)) byBR.set(l.bedrooms, l);
  const rows = Array.from(byBR.values()).sort((a, b) => a.bedrooms - b.bedrooms);
  const latestAt = rows.reduce((m, r) => Math.max(m, new Date(r.createdAt).getTime()), 0);
  return (
    <div style={{ marginBottom: 8, padding: 8, background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 11 }} data-testid="market-rate-change-summary">
      <div style={{ fontWeight: 600, color: "#334155", marginBottom: 4 }}>
        Market rate (basis) — old → new{latestAt ? ` · last updated ${new Date(latestAt).toLocaleString()}` : ""}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {rows.map((r) => {
          const oldN = r.oldRate != null ? Number(r.oldRate) : null;
          const newN = r.newRate != null ? Number(r.newRate) : null;
          const delta = oldN != null && newN != null && oldN > 0 ? (newN - oldN) / oldN : null;
          const color = delta == null ? "#6b7280" : delta > 0 ? "#b45309" : delta < 0 ? "#166534" : "#6b7280";
          return (
            <span key={r.bedrooms} style={{ color }}>
              <b>{r.bedrooms}BR</b>{" "}
              {oldN != null ? `$${Math.round(oldN).toLocaleString()}` : "—"}
              {" → "}
              <b>{newN != null ? `$${Math.round(newN).toLocaleString()}` : "—"}</b>
              {delta != null && <span> ({delta > 0 ? "+" : ""}{(delta * 100).toFixed(1)}%)</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
// Pushes the marked-up base calendar rates to Guesty. Guesty owns any
// downstream channel pricing adjustments.
function GuestyRatePushCard({
  listingId,
  propertyId,
  seasonalMonths,
  targetMarginPct,
  setTargetMarginPct,
  lastGuestyRatePushAt,
  lastGuestyRatePushStatus,
  lastGuestyRatePushSummary,
  onGuestyRatePushRecorded,
  refetchGuestyRates,
}: {
  listingId: string | null;
  propertyId?: number;
  seasonalMonths: Array<{ yearMonth: string; totalBuyIn: number; totalSell: number }>;
  targetMarginPct: number;
  setTargetMarginPct: (value: number) => void;
  lastGuestyRatePushAt?: string | null;
  lastGuestyRatePushStatus?: string | null;
  lastGuestyRatePushSummary?: string | null;
  onGuestyRatePushRecorded?: () => void | Promise<void>;
  /** Re-read Guesty calendar after a verified push (eventual consistency). */
  refetchGuestyRates?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seasonalPushResult, setSeasonalPushResult] = useState<any>(null);
  const [targetMarginInput, setTargetMarginInput] = useState(String(targetMarginPct));

  useEffect(() => {
    setTargetMarginInput(String(targetMarginPct));
  }, [targetMarginPct]);

  const marginMinPct = -99;
  const marginMaxPct = 100;
  const applyTargetMarginInput = (raw: string) => {
    setTargetMarginInput(raw);
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    setTargetMarginPct(Math.max(marginMinPct, Math.min(marginMaxPct, parsed)));
  };
  const normalizeTargetMarginInput = () => {
    const parsed = parseFloat(targetMarginInput);
    const next = Number.isFinite(parsed)
      ? Math.max(marginMinPct, Math.min(marginMaxPct, parsed))
      : targetMarginPct;
    setTargetMarginPct(next);
    setTargetMarginInput(String(next));
  };

  // Marked-up base-rate plan: what Guesty's calendar should charge per night
  // after applying the target margin to the saved buy-in basis. Guesty
  // handles channel-specific adjustments after this base rate lands.
  const computeSeasonalRates = (): Array<{ yearMonth: string; price: number; buyIn: number }> => {
    const m = targetMarginPct / 100;
    return seasonalMonths
      .filter((row) => row.totalBuyIn > 0)
      .map((row) => ({
        yearMonth: row.yearMonth,
        buyIn: row.totalBuyIn,
        // Match the pricing table's Sheet Base column (per-unit ceil, then sum).
        price: cleanBaseRateFromBuyIn(row.totalBuyIn, m),
      }));
  };

  const pushMarkedUpRates = async () => {
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
          propertyId,
          targetMargin: targetMarginPct / 100,
          monthlyRates: plan.map(({ yearMonth, price }) => ({ yearMonth, price })),
        }),
      });
      const data = await r.json();
      if (!r.ok || data.success === false) {
        const failed = Array.isArray(data.failedRanges) && data.failedRanges.length > 0
          ? ` First failed range: ${data.failedRanges[0]?.range?.startDate ?? "unknown"}-${data.failedRanges[0]?.range?.endDate ?? "unknown"}`
          : "";
        throw new Error(data.error || `Guesty calendar push did not fully verify.${failed}`.trim());
      }
      setSeasonalPushResult({ ...data, plan });
      await onGuestyRatePushRecorded?.();
      refetchGuestyRates?.();
      window.setTimeout(() => refetchGuestyRates?.(), 4000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Manual market-rate refresh (Pricing tab button) — surgical v1 for the user spec.
  const refreshMarketRates = async () => {
    if (!propertyId) return;
    setMarketRefreshing(true);
    try {
      const propPricing = getPropertyPricing(propertyId);
      const units = propPricing?.units ?? [];
      const brs = Array.from(new Set(units.map((u) => u.bedrooms)));
      const r = await fetch("/api/builder/refresh-market-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ community: units[0]?.community ?? "unknown", bedrooms: brs, unitCount: units.length, sameBrCombo: brs.length === 1 && units.length > 1 }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "refresh failed");
      setLiveMarket(data);
      setSeasonalPushResult((prev: any) => ({ ...(prev || {}), marketRefreshed: Date.now(), live: data }));
    } catch (e: any) { console.warn("[refresh-market]", e.message); } finally { setMarketRefreshing(false); }
  };

  // One-click: push seasonal base rates AND channel-equalizing markups.
  // After this, every month × every channel should land at targetMargin%.
  const setUpCleanMargin = async () => {
    // eslint-disable-next-line no-console
    console.log("[GuestyRatePushCard] setUpCleanMargin clicked", { listingId, seasonalMonths: seasonalMonths.length });
    if (!listingId) {
      setError("No Guesty listing selected. Pick one in the dropdown at the top of the builder first.");
      return;
    }
    if (seasonalMonths.length === 0) {
      setError("No pricing data loaded for this property.");
      return;
    }
    setError(null);
    await pushMarkedUpRates();
  };

  const seasonalPlan = useMemo(() => computeSeasonalRates(), [seasonalMonths, targetMarginPct]);
  const seasonalPriceRange = seasonalPlan.length > 0
    ? { min: Math.min(...seasonalPlan.map((p) => p.price)), max: Math.max(...seasonalPlan.map((p) => p.price)) }
    : null;

  return (
    <div style={{ marginTop: 20, padding: "16px 20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        💵 Guesty rate push — marked-up base calendar rates
      </div>
      <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, maxWidth: 760 }}>
        Pushes the <b>buy-in cost plus target margin</b> to Guesty's base calendar rate for each month.
        Guesty will apply its channel pricing rules after this base rate is stored.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 11, color: "#6b7280" }}>
          Target margin:
          <input
            type="number"
            step="0.1"
            min={marginMinPct}
            max={marginMaxPct}
            value={targetMarginInput}
            onChange={(e) => applyTargetMarginInput(e.target.value)}
            onBlur={normalizeTargetMarginInput}
            style={{ marginLeft: 6, padding: "3px 6px", border: "1px solid #e5e7eb", borderRadius: 4, fontSize: 12, width: 72 }}
            data-testid="input-target-margin"
          />
          <span style={{ marginLeft: 2 }}>%</span>
        </label>
        {seasonalPriceRange && (
          <span style={{ fontSize: 11, color: "#6b7280" }}>
            Marked-up Guesty rates will range <b>${seasonalPriceRange.min.toLocaleString()}</b>–<b>${seasonalPriceRange.max.toLocaleString()}</b> per night.
          </span>
        )}
        {lastGuestyRatePushAt && (
          <span style={{ fontSize: 11, color: lastGuestyRatePushStatus === "error" ? "#991b1b" : "#166534" }}>
            Last Guesty rate push: <b>{fmtDateTime(lastGuestyRatePushAt)}</b>
            {lastGuestyRatePushSummary ? ` · ${lastGuestyRatePushSummary}` : ""}
          </span>
        )}
      </div>
      {!listingId && (
        <div style={{ marginBottom: 10, padding: "8px 12px", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 4, fontSize: 11, color: "#92400e" }}>
          ⚠ <b>Select a Guesty listing</b> in the dropdown at the top of the builder before pushing rates.
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="glb-btn glb-btn-primary"
          onClick={setUpCleanMargin}
          disabled={busy || !listingId || seasonalMonths.length === 0}
          style={{ fontSize: 12 }}
          data-testid="button-set-up-clean-margin"
          title={!listingId ? "Select a Guesty listing in the dropdown at the top of the builder first" : "Push marked-up monthly base calendar rates to Guesty"}
        >
          {busy ? "Pushing…" : `⬆ Push marked-up ${targetMarginPct}% rates to Guesty`}
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
            ✓ Marked-up Guesty rates pushed —{" "}
            <b>{seasonalPushResult.pushedDays}</b> days in{" "}
            <b>{seasonalPushResult.pushedRanges}</b> ranges;{" "}
            <b>{seasonalPushResult.verifiedDays}</b> verified against Guesty read-back.
          </div>
          {(() => {
            const plan = (seasonalPushResult as any)?.plan as Array<{ yearMonth: string; price: number }> | undefined;
            if (!plan || plan.length === 0) return null;
            const prices = plan.map((p) => p.price);
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            return (
              <div style={{ fontSize: 11, color: "#166534" }}>
                Pushed rates: <b>${minP.toLocaleString()}/night</b> (low season) → <b>${maxP.toLocaleString()}/night</b> (high season).
                {" "}The table above now reflects this Guesty push.
              </div>
            );
          })()}
          {seasonalPushResult.plan && (
            <details>
              <summary style={{ cursor: "pointer", color: "#166534", fontWeight: 600 }}>
                Month-by-month plan
              </summary>
              <div style={{ marginTop: 4, maxHeight: 220, overflow: "auto" }}>
                {seasonalPushResult.plan.map((p: any) => (
                  <div key={p.yearMonth} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span>{p.yearMonth}</span>
                    <span>buy-in ${p.buyIn.toLocaleString()} → Guesty ${p.price.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// Shape of POST /api/builder/photo-community-check's JSON response. Mirrors
// the server's PhotoCommunityCheckResult (server/photo-community-check.ts) —
// kept as a local type so the client bundle doesn't import server code.
type CommunityCheckFlag = { id: string; caption?: string; reason: string };
type CommunityCheckGroup = {
  role: "community" | "unit";
  label: string;
  folder: string;
  photosChecked: number;
  photosTotal: number;
  identifiedCommunity: string;
  // Binary by design — the server answers each folder yes/no, never "uncertain"
  // (see asYesNo in server/photo-community-check.ts). The operator wants a
  // definite verdict, not a maybe.
  matchesExpected?: "yes" | "no";
  matchReason?: string;
  sameAsCommunity?: "yes" | "no";
  reason?: string;
  allSameCommunity?: boolean;
  allSameUnit?: boolean;
  outliers: CommunityCheckFlag[];
  junk: CommunityCheckFlag[];
  confidence: number;
};
type CommunityCheckDuplicate = {
  scope: "cross-folder" | "within-folder";
  a: { folder: string; filename: string; id: string };
  b: { folder: string; filename: string; id: string };
  distance: number;
};
type PhotoCommunityCheckResult = {
  ok: boolean;
  verdict: "pass" | "warn" | "fail";
  expectedCommunity: string;
  summary: string;
  concerns: string[];
  allSameCommunity: "yes" | "no" | "uncertain";
  community: CommunityCheckGroup | null;
  units: CommunityCheckGroup[];
  duplicates: CommunityCheckDuplicate[];
  model: string;
  photosChecked: number;
  elapsedMs: number;
  warning?: string;
};

export default function GuestyListingBuilder({ propertyData, propertyId, sourceUrlsByFolder, isSingleListing = false, onBuildComplete, onUpdateComplete, onPhotoOverridesChanged }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [conn, setConn] = useState<ConnState>("checking");
  const [connError, setConnError] = useState<string | null>(null);
  const [listings, setListings] = useState<GuestyListing[]>([]);
  const [selectedId, setSelectedId] = useState("");
  // Cached guesty-property-map. We fetch it for the auto-select effect
  // and re-use it on dropdown change to navigate to the listing's
  // mapped property (rather than just changing the push target while
  // the rest of the page stays on the previous property's data).
  const [propertyMap, setPropertyMap] = useState<Array<{ propertyId: number; guestyListingId: string }>>([]);
  const autoMapAttemptRef = useRef<string | null>(null);
  const [channelStatus, setChannelStatus] = useState<GuestyChannelStatus | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [listingStateBusy, setListingStateBusy] = useState<"list" | "unlist" | null>(null);
  // Per-listing "Push Compliance" button state so multiple in-flight
  // compliance submits don't step on each other if the user switches
  // listings mid-request.
  const [complianceStateByListing, setComplianceStateByListing] = useState<Record<string, "idle" | "busy">>({});
  const [complianceOverrides, setComplianceOverrides] = useState<Partial<Pick<GuestyPropertyData, "taxMapKey" | "tatLicense" | "getLicense" | "strPermit" | "dbprLicense" | "touristTaxAccount">>>({});
  const [licenseLookupBusy, setLicenseLookupBusy] = useState(false);
  const [tmkLookupBusy, setTmkLookupBusy] = useState(false);
  const [tmkLookupResult, setTmkLookupResult] = useState<TmkLookupResult | null>(null);
  const [getLookupBusy, setGetLookupBusy] = useState(false);
  const [getLookupResult, setGetLookupResult] = useState<ComplianceLookupResult | null>(null);
  const [tatLookupBusy, setTatLookupBusy] = useState(false);
  const [tatLookupResult, setTatLookupResult] = useState<ComplianceLookupResult | null>(null);
  const [strLookupBusy, setStrLookupBusy] = useState(false);
  const [strLookupResult, setStrLookupResult] = useState<ComplianceLookupResult | null>(null);

  const rememberPropertyMap = useCallback((propertyIdToMap: number, guestyListingId: string) => {
    setPropertyMap((prev) => [
      ...prev.filter((m) => m.propertyId !== propertyIdToMap),
      { propertyId: propertyIdToMap, guestyListingId },
    ]);
    queryClient.invalidateQueries({ queryKey: ["/api/guesty-property-map"] });
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard/channel-status"] });
  }, [queryClient]);
  const listingOptions = useMemo(() => {
    if (!selectedId || listings.some((listing) => guestyListingId(listing) === selectedId)) return listings;
    const mapped = propertyMap.find((m) => m.guestyListingId === selectedId);
    const label = mapped?.propertyId === propertyId
      ? propertyData?.nickname || propertyData?.title || propertyData?.descriptions?.title || selectedId
      : selectedId;
    return [{ _id: selectedId, nickname: label, address: propertyData?.address }, ...listings];
  }, [listings, propertyMap, propertyData?.address, propertyData?.descriptions?.title, propertyData?.nickname, propertyData?.title, propertyId, selectedId]);
  // Same idea, separate state for VRBO so the user can submit Airbnb and
  // VRBO compliance back-to-back without one button's busy spinner
  // blocking the other. Server-side, the VRBO push hits Guesty's UI via
  // the rebrowser-playwright session helper at
  // /api/admin/guesty/submit-vrbo-compliance — see AGENTS.md #28.
  const [vrboComplianceStateByListing, setVrboComplianceStateByListing] = useState<Record<string, "idle" | "busy" | "done">>({});
  // Per-listing per-channel "Publish to Channel" busy state. Three
  // channels can be in flight independently (Airbnb / VRBO / Booking.com)
  // because each runs in its own /api/admin/guesty/publish-channel
  // request, so the state is keyed `${listingId}:${channel}`. Server-
  // side this hits Guesty's Distribution page and clicks the publish-
  // like button scoped to the channel's row — see AGENTS.md #29.
  const [publishStateByListingChannel, setPublishStateByListingChannel] = useState<Record<string, "idle" | "busy">>({});
  const [activeTab, setActiveTab] = useState<"photos" | "amenities" | "descriptions" | "pricing" | "availability" | "bedding" | "otaVisibility">("descriptions");
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildSuccess, setBuildSuccess] = useState(false);
  const [editableTitle, setEditableTitle] = useState("");
  const [descPushState, setDescPushState] = useState<"idle" | "pushing" | "success" | "error">("idle");
  const [descPushError, setDescPushError] = useState<string | null>(null);
  const [dataPushBusy, setDataPushBusy] = useState(false);
  const [dataPushLog, setDataPushLog] = useState<DataPushLog>({});
  // Async Guesty rate-push status for the unified "Push … & Pricing" button.
  const [pricingPushStatus, setPricingPushStatus] = useState<PricingPushStatus | null>(null);
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
  // Default advance notice is 7 days. Operators can tighten or loosen
  // specific listings in the Pricing tab's Booking Rules card.
  //
  // Cancellation is split per-channel because Airbnb, VRBO, and
  // Booking.com each have their own enum of accepted policy IDs —
  // the old single "flexible|moderate|..." field couldn't express
  // channel-specific policies cleanly. Defaults hit the operator's
  // requested floor: "30+ days notice for a full refund, 50%+ penalty
  // for late cancellation."
  const [bookingRules, setBookingRules] = useState(DEFAULT_BOOKING_RULES);
  const [pushingBooking, setPushingBooking] = useState(false);
  const [bookingRulesPushInfo, setBookingRulesPushInfo] = useState<{
    lastPushedAt: string | null;
    lastPushStatus: string | null;
    lastPushSummary: string | null;
  } | null>(null);

  useEffect(() => {
    // Show the title with its "Sleeps N" already synced to the bed-derived
    // occupancy, so the builder doesn't display a stale count (guarded: a
    // 0/not-yet-loaded bedding config leaves the title untouched).
    const initSleeps = typeof propertyId === "number" ? totalBeddingSleeps(loadBuilderBeddingConfig(propertyId)) : 0;
    setEditableTitle(syncSleepsInTitle(propertyData?.descriptions?.title ?? "", initSleeps));
  }, [propertyData?.descriptions?.title, propertyId]);

  useEffect(() => {
    if (!propertyId || !selectedId) {
      setBookingRules(DEFAULT_BOOKING_RULES);
      setBookingRulesPushInfo(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/builder/booking-rules/${propertyId}?listingId=${encodeURIComponent(selectedId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const saved = data?.rules;
        if (!saved) {
          setBookingRules(DEFAULT_BOOKING_RULES);
          setBookingRulesPushInfo(null);
          return;
        }
        setBookingRules({
          minNights: Number(saved.minNights ?? DEFAULT_BOOKING_RULES.minNights),
          maxNights: Number(saved.maxNights ?? DEFAULT_BOOKING_RULES.maxNights),
          advanceNotice: Number(saved.advanceNotice ?? DEFAULT_BOOKING_RULES.advanceNotice),
          preparationTime: Number(saved.preparationTime ?? DEFAULT_BOOKING_RULES.preparationTime),
          instantBooking: saved.instantBooking !== false,
          cancellationPolicies: {
            ...DEFAULT_BOOKING_RULES.cancellationPolicies,
            ...(saved.cancellationPolicies ?? {}),
          },
        });
        setBookingRulesPushInfo({
          lastPushedAt: saved.lastPushedAt ?? null,
          lastPushStatus: saved.lastPushStatus ?? null,
          lastPushSummary: saved.lastPushSummary ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setBookingRulesPushInfo(null);
      });
    return () => { cancelled = true; };
  }, [propertyId, selectedId]);

  useEffect(() => {
    setComplianceOverrides({});
    setTmkLookupResult(null);
    setGetLookupResult(null);
    setTatLookupResult(null);
    setStrLookupResult(null);
    setGetLookupBusy(false);
    setTatLookupBusy(false);
    setStrLookupBusy(false);
    setTmkLookupBusy(false);
    setLicenseLookupBusy(false);
    if (!propertyId) return;
    let cancelled = false;
    fetch(`/api/builder/compliance/${propertyId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.values) return;
        const loaded: Partial<Pick<GuestyPropertyData, "taxMapKey" | "tatLicense" | "getLicense" | "strPermit" | "dbprLicense" | "touristTaxAccount">> = {};
        for (const [key, value] of Object.entries(data.values)) {
          const text = String(value ?? "").trim();
          if (text) {
            loaded[key as keyof typeof loaded] = text;
          }
        }
        if (Object.keys(loaded).length > 0) setComplianceOverrides(loaded);
      })
      .catch(() => { /* non-fatal — builder still works from static property data */ });
    return () => { cancelled = true; };
  }, [propertyId]);

  const effectivePropertyData = useMemo(() => {
    if (!propertyData) return null;
    const withCompliance = { ...propertyData, ...complianceOverrides };
    if (!propertyData.descriptions) return withCompliance;
    return {
      ...withCompliance,
      descriptions: {
        ...propertyData.descriptions,
        title: editableTitle || propertyData.descriptions.title,
      },
    };
  }, [propertyData, complianceOverrides, editableTitle]);

  useEffect(() => {
    if (!selectedId) {
      setDataPushLog({});
      return;
    }
    try {
      const raw = localStorage.getItem(dataPushStorageKey(selectedId, propertyId));
      setDataPushLog(raw ? JSON.parse(raw) as DataPushLog : {});
    } catch {
      setDataPushLog({});
    }
  }, [selectedId, propertyId]);

  const recordDataPush = useCallback((row: DataPushRow, status: DataPushStatus, message: string) => {
    if (!selectedId) return;
    const entry = { pushedAt: new Date().toISOString(), status, message };
    setDataPushLog((prev) => {
      const next = { ...prev, [row]: entry };
      try {
        localStorage.setItem(dataPushStorageKey(selectedId, propertyId), JSON.stringify(next));
      } catch {
        // Local push history is advisory; the Guesty push itself already completed.
      }
      return next;
    });
  }, [selectedId, propertyId]);

  // Drop a row back to the "…" pending state (no ✓/✗). Used for pricing while
  // the async Guesty rate push is still in flight, so the chip doesn't show a
  // premature green check the instant the refresh is merely queued.
  const markDataPushPending = useCallback((row: DataPushRow) => {
    if (!selectedId) return;
    setDataPushLog((prev) => {
      if (!prev[row]) return prev;
      const next = { ...prev };
      delete next[row];
      try {
        localStorage.setItem(dataPushStorageKey(selectedId, propertyId), JSON.stringify(next));
      } catch {
        // advisory only
      }
      return next;
    });
  }, [selectedId, propertyId]);

  const complianceProfile = useMemo(() => {
    return resolveLicenseComplianceProfile({
      address: effectivePropertyData?.address?.full,
      city: effectivePropertyData?.address?.city,
      state: effectivePropertyData?.address?.state,
    });
  }, [effectivePropertyData?.address?.full, effectivePropertyData?.address?.city, effectivePropertyData?.address?.state]);

  const complianceValueFor = useCallback((key: LicenseFieldKey): string | undefined => {
    if (!effectivePropertyData) return undefined;
    if (isFloridaLicenseJurisdiction(complianceProfile.jurisdiction)) {
      if (key === "dbprLicense") return effectivePropertyData.dbprLicense || effectivePropertyData.taxMapKey;
      if (key === "touristTaxAccount") return effectivePropertyData.touristTaxAccount || effectivePropertyData.tatLicense;
    }
    return effectivePropertyData[key as keyof typeof effectivePropertyData] as string | undefined;
  }, [effectivePropertyData, complianceProfile.jurisdiction]);

  const complianceDisplayValue = useCallback((value?: string | null): string => {
    const raw = String(value ?? "").trim();
    return raw || "—";
  }, []);

  const canCopyComplianceValue = useCallback((value?: string | null): boolean => {
    return Boolean(String(value ?? "").trim());
  }, []);

  const complianceSummaryValues = useMemo(() => {
    const isFloridaProfile = isFloridaLicenseJurisdiction(complianceProfile.jurisdiction);
    return {
      title1: complianceValueFor(isFloridaProfile ? "dbprLicense" : "taxMapKey"),
      title2: complianceValueFor("getLicense"),
      title3: complianceValueFor(isFloridaProfile ? "touristTaxAccount" : "tatLicense"),
      title4: complianceValueFor("strPermit"),
    };
  }, [complianceProfile.jurisdiction, complianceValueFor]);

  const persistComplianceValues = useCallback(async (
    values: Partial<Pick<GuestyPropertyData, "taxMapKey" | "tatLicense" | "getLicense" | "strPermit" | "dbprLicense" | "touristTaxAccount">>,
  ) => {
    if (!propertyId) return;
    const payload: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const text = String(value ?? "").trim();
      if (text) payload[key] = text;
    }
    if (Object.keys(payload).length === 0) return;
    const url = propertyId < 0
      ? `/api/community/${Math.abs(propertyId)}`
      : `/api/builder/compliance/${propertyId}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const error = await resp.json().catch(() => ({}));
      throw new Error(error?.error || error?.message || `Save failed (${resp.status})`);
    }
    if (propertyId < 0) {
      await queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
    }
  }, [propertyId, queryClient]);

  const generateSampleForRequirement = useCallback(async (req: LicenseRequirement) => {
    const address = effectivePropertyData?.address;
    const city = typeof address === "object" && address ? address.city ?? "" : "";
    const state = typeof address === "object" && address ? address.state ?? "" : "";
    const fullAddress = typeof address === "object" && address ? address.full ?? "" : "";
    const propertyType = effectivePropertyData?.propertyType
      ?? effectivePropertyData?.otaRoomType
      ?? effectivePropertyData?.roomType
      ?? "";
    const samples = sampleLicensesForLocation(city, state, { address: fullAddress, propertyType });
    const isFloridaProfile = isFloridaLicenseJurisdiction(complianceProfile.jurisdiction);
    const sample = isFloridaProfile
      ? req.key === "dbprLicense" ? samples.taxMapKey
        : req.key === "touristTaxAccount" ? samples.tatLicense
          : req.key === "getLicense" ? samples.getLicense
            : req.key === "strPermit" ? samples.strPermit
              : undefined
      : req.key === "taxMapKey" ? samples.taxMapKey
        : req.key === "tatLicense" ? samples.tatLicense
          : req.key === "getLicense" ? samples.getLicense
            : req.key === "strPermit" ? samples.strPermit
              : undefined;
    if (!sample) return;
    setComplianceOverrides((prev) => ({ ...prev, [req.key]: sample }));
    try {
      await persistComplianceValues({ [req.key]: sample } as Partial<Pick<GuestyPropertyData, "taxMapKey" | "tatLicense" | "getLicense" | "strPermit" | "dbprLicense" | "touristTaxAccount">>);
      toast({
        title: `Sample ${req.shortLabel} applied`,
        description: "County/state-shaped placeholder — replace with the real license before publishing, or pull the real value from Guesty/public records above.",
      });
    } catch (err: any) {
      toast({ title: "Sample save failed", description: err?.message || String(err), variant: "destructive" });
    }
  }, [
    complianceProfile.jurisdiction,
    effectivePropertyData?.address,
    effectivePropertyData?.otaRoomType,
    effectivePropertyData?.propertyType,
    effectivePropertyData?.roomType,
    persistComplianceValues,
    toast,
  ]);

  const pullLicenseRequirements = useCallback(async () => {
    if (!effectivePropertyData?.address) return;
    setLicenseLookupBusy(true);
    try {
      const isFloridaProfile = isFloridaLicenseJurisdiction(complianceProfile.jurisdiction);
      const r = await fetch("/api/builder/resolve-license-requirements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: effectivePropertyData.address.full,
          city: effectivePropertyData.address.city,
          state: effectivePropertyData.address.state,
          listingName: effectivePropertyData.title || effectivePropertyData.nickname || effectivePropertyData.descriptions?.title,
          taxMapKey: effectivePropertyData.taxMapKey,
          tatLicense: effectivePropertyData.tatLicense,
          getLicense: effectivePropertyData.getLicense,
          strPermit: effectivePropertyData.strPermit,
          dbprLicense: effectivePropertyData.dbprLicense || (isFloridaProfile ? effectivePropertyData.taxMapKey : undefined),
          touristTaxAccount: effectivePropertyData.touristTaxAccount || (isFloridaProfile ? effectivePropertyData.tatLicense : undefined),
        }),
      });
      const data = await r.json();
      if (!r.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      setComplianceOverrides((prev) => ({
        ...prev,
        ...(data.values?.taxMapKey ? { taxMapKey: data.values.taxMapKey } : {}),
        ...(data.values?.tatLicense ? { tatLicense: data.values.tatLicense } : {}),
        ...(data.values?.getLicense ? { getLicense: data.values.getLicense } : {}),
        ...(data.values?.strPermit ? { strPermit: data.values.strPermit } : {}),
        ...(data.values?.dbprLicense ? { dbprLicense: data.values.dbprLicense } : {}),
        ...(data.values?.touristTaxAccount ? { touristTaxAccount: data.values.touristTaxAccount } : {}),
      }));
      await persistComplianceValues(data.values ?? {});
      const missingRequired = (data.profile?.requirements ?? [])
        .filter((req: any) => req.required && isPlaceholderLicenseValue(data.values?.[req.key]))
        .map((req: any) => req.shortLabel || req.label);
      toast({
        title: data.profile?.title ?? "License requirements loaded",
        description: missingRequired.length
          ? `${data.lookup?.note ? `${data.lookup.note} ` : ""}Still missing real values: ${missingRequired.join(", ")}`
          : "All mapped required license values are present.",
      });
    } catch (e: any) {
      toast({ title: "License lookup failed", description: e.message, variant: "destructive" });
    } finally {
      setLicenseLookupBusy(false);
    }
  }, [effectivePropertyData, complianceProfile.jurisdiction, persistComplianceValues, toast]);

  // Compliance card labels swap by state. The four data fields
  // (taxMapKey / getLicense / tatLicense / strPermit) are reused
  // across jurisdictions but represent different things — Hawaii
  // ties to TMK / GE / TAT / per-county STR; Florida ties to DBPR
  // VR License / Sales Tax / County TDT / LBTR. Detect from the
  // address rather than from a separate flag so the labels stay
  // in sync with whatever location the operator typed. The
  // `address` field on GuestyPropertyData is an object
  // ({full, city, state, …}) — earlier revision treated it as a
  // string and crashed the page with "X.toLowerCase is not a
  // function" on every render. Read .state first when present
  // (cheapest, most accurate); fall back to scanning .full.
  const complianceLabels = useMemo(() => {
    const addr = effectivePropertyData?.address;
    const stateField = (typeof addr === "object" && addr ? (addr as any).state : "") ?? "";
    const fullField = (typeof addr === "object" && addr ? (addr as any).full : (typeof addr === "string" ? addr : "")) ?? "";
    const blob = `${stateField} ${fullField}`.toLowerCase();
    const isHawaii  = /\b(hawaii|hi)\b/.test(blob);
    const isFlorida = /\b(florida|fl)\b/.test(blob);
    if (isFlorida) {
      return {
        title1: "DBPR Vacation Rental License",
        title2: "Florida Sales Tax Certificate",
        title3: "Tourist Development Tax (County)",
        title4: "Local Business Tax Receipt (LBTR)",
        notesHint: "Florida tax compliance — DBPR license + DOR sales tax + county TDT + county LBTR",
      };
    }
    if (isHawaii) {
      return {
        title1: "Tax Map Key (TMK)",
        title2: "GET License (General Excise Tax)",
        title3: "TAT License (Transient Accom. Tax)",
        title4: "STR Permit Number",
        notesHint: "Hawaii tax compliance — TMK + GE + TAT + per-county STR",
      };
    }
    return {
      title1: "Tax Map Key / Parcel ID",
      title2: "Sales Tax / GE License",
      title3: "Lodging / TAT License",
      title4: "STR / Local Permit",
      notesHint: "tax compliance — confirm the relevant jurisdiction fields",
    };
  }, [effectivePropertyData?.address]);

  const isHawaiiCompliance = useMemo(() => {
    const addr = effectivePropertyData?.address;
    const stateField = (typeof addr === "object" && addr ? (addr as any).state : "") ?? "";
    const fullField = (typeof addr === "object" && addr ? (addr as any).full : (typeof addr === "string" ? addr : "")) ?? "";
    return /\b(hawaii|hi)\b/i.test(`${stateField} ${fullField}`);
  }, [effectivePropertyData?.address]);

  const COMPLIANCE_FETCH_TIMEOUT_MS = 28_000;
  const complianceListingName = useMemo(() => (
    effectivePropertyData?.title
    || effectivePropertyData?.nickname
    || effectivePropertyData?.descriptions?.title
    || ""
  ), [effectivePropertyData?.descriptions?.title, effectivePropertyData?.nickname, effectivePropertyData?.title]);

  const pullRealTaxMapKey = useCallback(async () => {
    if (!effectivePropertyData?.address) return;
    const fullAddress = typeof effectivePropertyData.address === "object"
      ? effectivePropertyData.address.full
      : String(effectivePropertyData.address);
    if (!fullAddress) {
      toast({ title: "Missing Guesty address", description: "A full Hawaii Guesty listing address is needed before TMK lookup.", variant: "destructive" });
      return;
    }
    setTmkLookupBusy(true);
    setTmkLookupResult(null);
    try {
      const params = new URLSearchParams({
        address: fullAddress,
      });
      if (complianceListingName) params.set("listingName", complianceListingName);
      const resp = await fetch(`/api/builder/tmk-lookup?${params.toString()}`, {
        signal: AbortSignal.timeout(COMPLIANCE_FETCH_TIMEOUT_MS),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || data?.message || "TMK lookup failed");
      setComplianceOverrides((prev) => ({ ...prev, taxMapKey: data.taxMapKey }));
      void persistComplianceValues({ taxMapKey: data.taxMapKey }).catch((err) => {
        toast({ title: "License save failed", description: err?.message || String(err), variant: "destructive" });
      });
      setTmkLookupResult(data as TmkLookupResult);
      toast({
        title: data.confidence === "public-listing"
          ? "Public listing TMK / MAP applied"
          : data.confidence === "unit-cpr" ? "Guesty-address unit TMK applied" : "Guesty-address parcel TMK applied",
        description: data.note,
      });
    } catch (err: any) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      toast({
        title: "TMK lookup failed",
        description: timedOut
          ? "Kauai TMK lookup timed out. Try again in a moment."
          : err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setTmkLookupBusy(false);
    }
  }, [complianceListingName, effectivePropertyData?.address, persistComplianceValues, toast]);

  const pullHawaiiComplianceField = useCallback(async (options: {
    field: "getLicense" | "tatLicense" | "strPermit";
    endpoint: string;
    label: string;
    setBusy: (busy: boolean) => void;
    setResult: (result: ComplianceLookupResult | null) => void;
    requiresListing?: boolean;
  }) => {
    if (!effectivePropertyData?.address) return;
    const fullAddress = typeof effectivePropertyData.address === "object"
      ? effectivePropertyData.address.full
      : String(effectivePropertyData.address);
    if (!fullAddress) {
      toast({ title: "Missing Guesty address", description: `A full Hawaii Guesty listing address is needed before ${options.label} lookup.`, variant: "destructive" });
      return;
    }
    if (options.requiresListing && !selectedId) {
      toast({ title: "Select a Guesty listing", description: `Connect/select a Guesty listing first so ${options.label} can be pulled from Guesty compliance fields.`, variant: "destructive" });
      return;
    }
    options.setBusy(true);
    options.setResult(null);
    try {
      const params = new URLSearchParams({ address: fullAddress });
      if (complianceListingName) params.set("listingName", complianceListingName);
      if (selectedId) params.set("listingId", selectedId);
      if (propertyId) params.set("propertyId", String(propertyId));
      if (effectivePropertyData.taxMapKey) params.set("taxMapKey", effectivePropertyData.taxMapKey);
      const resp = await fetch(`${options.endpoint}?${params.toString()}`, {
        signal: AbortSignal.timeout(COMPLIANCE_FETCH_TIMEOUT_MS),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || data?.message || `${options.label} lookup failed`);
      const value = String(data.value || data[options.field] || "").trim();
      if (!value) throw new Error(`${options.label} lookup returned no value`);
      if (isPlaceholderLicenseValue(value)) {
        throw new Error(
          `The ${options.label} returned is still a sample/placeholder. Connect a Guesty listing with real Hawaii compliance fields, or enter the official ${options.label} manually.`,
        );
      }
      const previous = complianceValueFor(options.field);
      const unchanged = previous
        && !isPlaceholderLicenseValue(previous)
        && previous.replace(/\W/g, "").toLowerCase() === value.replace(/\W/g, "").toLowerCase();
      setComplianceOverrides((prev) => ({ ...prev, [options.field]: value }));
      void persistComplianceValues({ [options.field]: value }).catch((err) => {
        toast({ title: "License save failed", description: err?.message || String(err), variant: "destructive" });
      });
      options.setResult(data as ComplianceLookupResult);
      if (unchanged) {
        toast({
          title: `${options.label} unchanged`,
          description: `Already set to ${value}. ${data.note || ""}`.trim(),
        });
      } else {
        toast({ title: `${options.label} applied`, description: data.note });
      }
    } catch (err: any) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      toast({
        title: `${options.label} lookup failed`,
        description: timedOut
          ? `${options.label} lookup timed out (Guesty or county registry may be slow). Try again in a moment.`
          : err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      options.setBusy(false);
    }
  }, [complianceListingName, complianceValueFor, effectivePropertyData?.address, effectivePropertyData?.taxMapKey, persistComplianceValues, propertyId, selectedId, toast]);

  const pullRealGetLicense = useCallback(async () => {
    await pullHawaiiComplianceField({
      field: "getLicense",
      endpoint: "/api/builder/get-lookup",
      label: "GET license",
      setBusy: setGetLookupBusy,
      setResult: setGetLookupResult,
    });
  }, [pullHawaiiComplianceField]);

  const pullRealTatLicense = useCallback(async () => {
    await pullHawaiiComplianceField({
      field: "tatLicense",
      endpoint: "/api/builder/tat-lookup",
      label: "TAT license",
      setBusy: setTatLookupBusy,
      setResult: setTatLookupResult,
    });
  }, [pullHawaiiComplianceField]);

  const pullRealStrPermit = useCallback(async () => {
    await pullHawaiiComplianceField({
      field: "strPermit",
      endpoint: "/api/builder/str-permit-lookup",
      label: "STR permit",
      setBusy: setStrLookupBusy,
      setResult: setStrLookupResult,
    });
  }, [pullHawaiiComplianceField]);

  const renderComplianceLookupMeta = (result: ComplianceLookupResult | null) => {
    if (!result) return null;
    return (
      <div style={{ fontSize: 10.5, color: "var(--muted-foreground)", lineHeight: 1.35 }}>
        {result.confidence.replace(/-/g, " ")} · {result.source}
        {result.sourceUrl && (
          <>
            {" · "}
            <a href={result.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "var(--primary)" }}>
              source
            </a>
          </>
        )}
        <br />
        {result.note}
      </div>
    );
  };

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
  const [normalizePhotoListingName, setNormalizePhotoListingName] = useState<string>("");
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
    setNormalizePhotoListingName("");
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
            setNormalizePhotoListingName(evt.name);
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

  // ── Photo Community Check ─────────────────────────────────────────────────
  // Operator-clicked QA: confirms the community-folder photos match this
  // property's community, that they're all of that one community, and that each
  // unit's photos are the SAME community. Plus junk/mis-filed flags and
  // cross-folder duplicate detection. The callback that builds the request is
  // defined after `photos` (further down) because it reads that array.
  type CommunityCheckPhase = "idle" | "running" | "done" | "error";
  const [communityCheckPhase, setCommunityCheckPhase] = useState<CommunityCheckPhase>("idle");
  const [communityCheckResult, setCommunityCheckResult] = useState<PhotoCommunityCheckResult | null>(null);
  const [communityCheckError, setCommunityCheckError] = useState<string | null>(null);

  // Persisted last-push summary (survives refresh)
  type PushSummary = { listingId: string; timestamp: number; successCount: number; total: number; upscaledCount: number; failed: number };
  const [lastPushSummary, setLastPushSummary] = useState<PushSummary | null>(null);

  // Live photo count from Guesty for the selected listing
  const [guestyPhotoCount, setGuestyPhotoCount] = useState<number | null>(null);
  const [guestyPhotoCountLoading, setGuestyPhotoCountLoading] = useState(false);

  // The cover-collage picture URL on Guesty (by caption === "Cover Collage").
  // Used to render the collage as a tile in the PhotoCurator so the
  // operator can see what's currently set as the cover without leaving
  // the Photos tab. Null when there's no collage on the listing.
  const [guestyCoverCollageUrl, setGuestyCoverCollageUrl] = useState<string | null>(null);

  // URLs successfully pushed in the most recent push-photos run, with
  // captions preserved. The cover-collage push uses this (when non-
  // empty) to prepend the collage on top of the caller's known-good
  // list — side-stepping Guesty's read-after-write consistency lag on
  // GET-after-PUT, which was losing ~3-5 photos in practice.
  const [lastPushedPictures, setLastPushedPictures] = useState<Array<{ original: string; caption: string }>>([]);

  const savePushSummary = useCallback((summary: PushSummary) => {
    setLastPushSummary(summary);
    try { localStorage.setItem(`nexstay_push_${summary.listingId}`, JSON.stringify(summary)); } catch { /* non-fatal */ }
  }, []);

  const readGuestyPictures = useCallback(async (listingId: string): Promise<{ pictures: any[]; collageUrl: string | null }> => {
    const encodedId = encodeURIComponent(listingId);
    const read = async (suffix: string) => {
      const response = await fetch(`/api/guesty-proxy/listings/${encodedId}${suffix}`);
      if (!response.ok) throw new Error(`Guesty listing read failed (${response.status})`);
      return response.json();
    };

    let listing = await read("?fields=pictures");
    let pictures: any[] = Array.isArray(listing?.pictures) ? listing.pictures : [];
    if (!Array.isArray(listing?.pictures)) {
      // Some Guesty responses omit fields when a projection is rejected or
      // stale; fall back to the full listing before showing a zero count.
      listing = await read("");
      pictures = Array.isArray(listing?.pictures) ? listing.pictures : [];
    }

    const collage = pictures.find((p) => (p?.caption || "") === "Cover Collage");
    return { pictures, collageUrl: collage?.original || collage?.url || null };
  }, []);

  // Load persisted summary & fetch live photo count when listing selection changes
  useEffect(() => {
    if (!selectedId) { setLastPushSummary(null); setGuestyPhotoCount(null); setGuestyCoverCollageUrl(null); setLastPushedPictures([]); setGuestyLiveAmenities(null); return; }
    // Restore from localStorage
    let storedSummary: PushSummary | null = null;
    try {
      const stored = localStorage.getItem(`nexstay_push_${selectedId}`);
      if (stored) {
        storedSummary = JSON.parse(stored);
        setLastPushSummary(storedSummary);
      }
      else setLastPushSummary(null);
    } catch { setLastPushSummary(null); }
    // Fetch live listing data — photo count + current amenities
    setGuestyPhotoCount(null);
    setGuestyPhotoCountLoading(true);
    setGuestyLiveAmenities(null);
    setFetchingLiveAmenities(true);
    // Photo count comes from the listing; amenities from properties-api (Popular Amenities panel).
    Promise.all([
      readGuestyPictures(selectedId).catch(() => null),
      fetch(`/api/builder/guesty-amenities?listingId=${selectedId}`).then(r => r.json()).catch(() => null),
    ])
      .then(([photoRead, amen]) => {
        const liveCount = photoRead?.pictures.length ?? 0;
        const fallbackCount = storedSummary?.successCount && storedSummary.successCount > 0
          ? storedSummary.successCount
          : null;
        setGuestyPhotoCount(liveCount > 0 ? liveCount : fallbackCount);
        setGuestyCoverCollageUrl(photoRead?.collageUrl ?? null);
        const canonical: string[] = Array.isArray(amen?.amenities) ? amen.amenities : [];
        const other: string[] = Array.isArray(amen?.otherAmenities) ? amen.otherAmenities : [];
        setGuestyLiveAmenities(guestyNamesToProfileKeys([...canonical, ...other]));
      })
      .catch(() => { setGuestyPhotoCount(null); setGuestyCoverCollageUrl(null); setGuestyLiveAmenities(new Set()); })
      .finally(() => { setGuestyPhotoCountLoading(false); setFetchingLiveAmenities(false); });
  }, [selectedId, guestyNamesToProfileKeys, readGuestyPictures]);

  // Refresh live count + cover-collage URL after a successful push
  const refreshGuestyPhotoCount = useCallback(() => {
    if (!selectedId) return;
    readGuestyPictures(selectedId)
      .then(({ pictures, collageUrl }) => {
        const fallbackCount = lastPushSummary?.listingId === selectedId && lastPushSummary.successCount > 0
          ? lastPushSummary.successCount
          : null;
        setGuestyPhotoCount(pictures.length > 0 ? pictures.length : fallbackCount);
        setGuestyCoverCollageUrl(collageUrl);
      })
      .catch(() => {});
  }, [selectedId, lastPushSummary, readGuestyPictures]);

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

  // ── Cover collage: operator selects two photos → canvas → ImgBB → Guesty ──
  type CollagePhase = "idle" | "upscaling" | "generating" | "uploading" | "done" | "error";
  const [collagePhase, setCollagePhase] = useState<CollagePhase>("idle");
  const [collageError, setCollageError] = useState<string | null>(null);
  const [collagePreviewUrl, setCollagePreviewUrl] = useState<string | null>(null);
  const [collagePicks, setCollagePicks] = useState<{ community: string; patio: string } | null>(null);

  // Community scene: resort amenities, grounds, aerial shots. These are
  // the "sell the destination" photos — ocean views, pool complexes,
  // beach access, coastline. We pull from the Community source tiles
  // specifically so the collage doesn't pick a unit-balcony view as the
  // "community" half.
  function scoreCommunityShot(label: string): number {
    const l = label.toLowerCase();
    return (l.includes("ocean") ? 10 : 0) + (l.includes("beach") ? 9 : 0) +
           (l.includes("pool") ? 9 : 0) + (l.includes("sunset") || l.includes("sunrise") ? 8 : 0) +
           (l.includes("waterfront") ? 8 : 0) + (l.includes("aerial") ? 7 : 0) +
           (l.includes("coastal") ? 7 : 0) + (l.includes("resort") ? 6 : 0) +
           (l.includes("grounds") ? 5 : 0) + (l.includes("view") ? 4 : 0) +
           (l.includes("property") ? 3 : 0);
  }

  // Patio scene: the unit's own private outdoor space — lanai, balcony,
  // covered patio, deck. Bonus for scenic backdrop (ocean/golf/mountain).
  // Falls back to generic unit-exterior scoring when the listing has no
  // captioned lanai.
  function scorePatioShot(label: string): number {
    const l = label.toLowerCase();
    let s = 0;
    if (l.includes("lanai")) s += 10;
    if (l.includes("balcony")) s += 9;
    if (l.includes("patio")) s += 9;
    if (l.includes("covered") && (l.includes("deck") || l.includes("porch"))) s += 8;
    if (l.includes("deck")) s += 7;
    if (l.includes("porch")) s += 6;
    // Scenic bonus — a lanai with an ocean view wins over a plain lanai.
    if (l.includes("ocean")) s += 4;
    if (l.includes("golf")) s += 2;
    if (l.includes("mountain") || l.includes("garden")) s += 2;
    return s;
  }

  // Pick best-community + best-patio pair. Community candidates pull from
  // photos whose `source` field starts with "Community" (so we don't mix a
  // unit-interior shot in as "community"). Patio candidates come from the
  // unit-level photos with outdoor keywords in the caption. If either
  // pool is empty we fall back to the overall best-scoring photo of that
  // type anywhere in the set.
  function pickCollagePhotos(
    allPhotos: GuestyPropertyData["photos"],
  ): { community: NonNullable<GuestyPropertyData["photos"]>[0]; patio: NonNullable<GuestyPropertyData["photos"]>[0] } | null {
    if (!allPhotos?.length) return null;
    const communityPool = allPhotos.filter((p) => (p.source ?? "").toLowerCase().startsWith("community"));
    const unitPool = allPhotos.filter((p) => !((p.source ?? "").toLowerCase().startsWith("community")));

    const pickBest = <T extends { caption?: string }>(pool: T[], scorer: (l: string) => number, fallback: T[]): T | null => {
      const searchIn = pool.length > 0 ? pool : fallback;
      if (searchIn.length === 0) return null;
      let best = searchIn[0];
      let bestScore = -1;
      for (const p of searchIn) {
        const s = scorer(p.caption || "");
        if (s > bestScore) { bestScore = s; best = p; }
      }
      return best;
    };

    const community = pickBest(communityPool, scoreCommunityShot, allPhotos);
    const patio = pickBest(unitPool, scorePatioShot, allPhotos);
    if (!community || !patio) return null;
    return { community, patio };
  }

  const generateCoverCollage = useCallback(async (
    allPhotos: GuestyPropertyData["photos"],
    selection?: CoverCollageSelection,
  ) => {
    if (!selectedId) return;
    setCollagePhase("upscaling");
    setCollageError(null);
    setCollagePreviewUrl(null);
    setCollagePicks(null);

    const picks = selection
      ? {
          community: selection.left as NonNullable<GuestyPropertyData["photos"]>[0],
          patio: selection.right as NonNullable<GuestyPropertyData["photos"]>[0],
        }
      : pickCollagePhotos(allPhotos);
    if (!picks) { setCollageError("No photos available"); setCollagePhase("error"); return; }
    setCollagePicks({ community: picks.community.caption || picks.community.url, patio: picks.patio.caption || picks.patio.url });

    // Extract local path from URL (e.g. "/photos/kaha-lani-109/photo_00.jpg")
    const toLocalPath = (url: string): string => {
      try { return new URL(url, window.location.origin).pathname; }
      catch { return url.startsWith("/") ? url : `/${url}`; }
    };
    const communityLocal = toLocalPath(picks.community.url);
    const patioLocal  = toLocalPath(picks.patio.url);

    // Upscale both picks via server (Real-ESRGAN → ImgBB), run in parallel
    let communitySrc = picks.community.url;
    let patioSrc = picks.patio.url;
    if (communityLocal.startsWith("/photos/") || patioLocal.startsWith("/photos/")) {
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
      [communitySrc, patioSrc] = await Promise.all([
        communityLocal.startsWith("/photos/") ? upscaleOne(communityLocal, picks.community.url) : Promise.resolve(picks.community.url),
        patioLocal.startsWith("/photos/")  ? upscaleOne(patioLocal,  picks.patio.url)  : Promise.resolve(picks.patio.url),
      ]);
    }

    setCollagePhase("generating");

    // Load both images (upscaled or original)
    const loadImg = (src: string): Promise<HTMLImageElement> => new Promise((res, rej) => {
      const img = new Image(); img.crossOrigin = "anonymous";
      img.onload = () => res(img); img.onerror = rej; img.src = src;
    });

    let communityImg: HTMLImageElement, patioImg: HTMLImageElement;
    try {
      [communityImg, patioImg] = await Promise.all([loadImg(communitySrc), loadImg(patioSrc)]);
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
    drawCover(communityImg, 0, half);
    ctx.restore();

    ctx.save(); ctx.beginPath(); ctx.rect(half, 0, half, H); ctx.clip();
    drawCover(patioImg, half, half);
    ctx.restore();

    // Thin divider line
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillRect(half - 1, 0, 2, H);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    setCollagePreviewUrl(dataUrl);

    // Upload to ImgBB + set as Guesty cover
    setCollagePhase("uploading");
    try {
      // Prefer passing the URLs we know were just pushed (race-free
      // against Guesty read-after-write lag). When we have no recent
      // push on record the server falls back to a fresh GET.
      const resp = await fetch("/api/builder/upload-collage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64: dataUrl,
          listingId: selectedId,
          existingPhotos: lastPushedPictures.length > 0 ? lastPushedPictures : undefined,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as any;
        throw new Error(err.error || `Server error ${resp.status}`);
      }
      const result = await resp.json() as any;
      setGuestyPhotoCount(result.totalPhotos);
      if (result.collageUrl) setGuestyCoverCollageUrl(result.collageUrl);
      setCollagePhase("done");
    } catch (e: any) {
      setCollageError(e.message); setCollagePhase("error");
    }
  }, [selectedId, lastPushedPictures]);

  type PhotoPushResult = { successCount: number; total: number; shortfall: number; error?: string };

  const upscaleAndUpload = useCallback(async (photos: GuestyPropertyData["photos"], withUpscale: boolean): Promise<PhotoPushResult> => {
    if (!selectedId || !photos?.length) {
      return { successCount: 0, total: photos?.length ?? 0, shortfall: 0, error: "No photos available to push." };
    }
    setUpscalePhase("pushing");
    setUpscaleTotal(photos.length);
    setUpscaleCurrent(0);
    setUpscaledCount(0);
    setUpscaleError(null);
    setPushResults([]);
    setSavingToGuesty(false);
    setCheckpointCount(0);
    // Reset the known-pushed-pictures list at the start of each push so
    // a follow-up cover-collage operation only sees URLs from THIS run.
    setLastPushedPictures([]);

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
    let finalResult: PhotoPushResult | null = null;

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
        const message = err.error || `Server error ${resp.status}`;
        setUpscaleError(message);
        setUpscalePhase("error");
        return { successCount: 0, total: photos.length, shortfall: photos.length, error: message };
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
              type: "photo" | "checkpoint" | "saving" | "verify" | "done";
              index?: number;
              total?: number;
              saved?: number;
              localPath?: string;
              success?: boolean;
              url?: string;
              wasUpscaled?: boolean;
              error?: string;
              successCount?: number;
              verifiedCount?: number;
              shortfall?: number;
              upscaledCount?: number;
              trimmed?: number;
              maxPhotos?: number;
              // "verify" event fields
              attempt?: number;
              expected?: number;
              got?: number;
            };

            if (event.type === "photo") {
              setUpscaleCurrent(event.index ?? 0);
              if (event.wasUpscaled) setUpscaledCount(c => c + 1);
              setPushResults(prev => [...prev, {
                localPath: event.localPath || "",
                success: event.success ?? false,
                error: event.error,
              }]);
              // Accumulate the ImgBB URL + its caption for the follow-up
              // cover-collage flow. Preserving the same 1-based index the
              // server emits keeps the ordering intact, which is the order
              // the push PUTs to Guesty — so the collage prepend gets
              // added to a list that matches what's actually live.
              if (event.success && event.url && typeof event.index === "number") {
                const caption = photos[event.index - 1]?.caption ?? "";
                setLastPushedPictures(prev => [...prev, { original: event.url!, caption }]);
              }
            } else if (event.type === "checkpoint") {
              // Intermediate save — update Guesty photo count so user can see progress
              setCheckpointCount(c => c + 1);
              refreshGuestyPhotoCount();
            } else if (event.type === "saving") {
              setSavingToGuesty(true);
            } else if (event.type === "verify") {
              // The server re-checks Guesty after the final PUT and
              // retries up to 3 times if pictures were silently dropped
              // (ImgBB CDN propagation lag causes Guesty to strip URLs
              // it can't fetch). Reflect that in-flight verification in
              // the UI so the "saving" spinner stays honest.
              setSavingToGuesty(true);
            } else if (event.type === "done") {
              setSavingToGuesty(false);
              setUpscaledCount(event.upscaledCount ?? 0);
              const guestyError = (event as any).guestyError as string | undefined;
              if (guestyError) setUpscaleError(`Guesty save failed: ${guestyError}`);
              const trimmed = event.trimmed ?? 0;
              if (trimmed > 0) {
                const maxPhotos = event.maxPhotos ?? event.total ?? 50;
                toast({
                  title: `Trimmed to ${maxPhotos} photos`,
                  description: `Kept the first ${maxPhotos} photos (community + units) and dropped ${trimmed} lower-priority photos to stay within the Guesty master photo limit.`,
                  duration: 10000,
                });
              }
              // Use the server-verified count (what's actually on Guesty
              // after retries) as the authoritative "succeeded" number,
              // not the blind upload count. Falls back to successCount
              // for backwards-compat with old server builds that don't
              // emit verifiedCount.
              const sc = event.verifiedCount ?? event.successCount ?? 0;
              const shortfall = event.shortfall ?? 0;
              const tot = event.total ?? 0;
              const succeeded = sc > 0 && !guestyError;
              finalResult = {
                successCount: sc,
                total: tot,
                shortfall,
                error: guestyError || (sc === 0 && tot > 0 ? "All photos failed — check per-photo errors below" : undefined),
              };
              if (!guestyError) setGuestyPhotoCount(sc);
              setUpscalePhase(sc === 0 && tot > 0 ? "error" : "done");
              if (sc === 0 && tot > 0 && !guestyError) {
                setUpscaleError("All photos failed — check per-photo errors below");
              }
              if (shortfall > 0) {
                toast({
                  title: `Guesty dropped ${shortfall} photo${shortfall === 1 ? "" : "s"}`,
                  description: `Uploaded ${event.successCount ?? sc}, but only ${sc} persisted on Guesty after 3 verify retries. Usually caused by ImgBB CDN lag — re-pushing in ~30s normally recovers them.`,
                  variant: "destructive",
                  duration: 12000,
                });
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
        return { successCount: 0, total: photos.length, shortfall: photos.length, error: "Photo push cancelled." };
      }
      const message = err?.message || "Network error — could not reach server";
      setUpscaleError(message);
      setUpscalePhase("error");
      return { successCount: 0, total: photos.length, shortfall: photos.length, error: message };
    } finally {
      pushAbortRef.current = null;
    }
    return finalResult ?? { successCount: 0, total: photos.length, shortfall: photos.length, error: "Photo push finished without a server completion event." };
  }, [selectedId, refreshGuestyPhotoCount, savePushSummary, toast]);

  // ── Check connection + load listings ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function init() {
      setConn("checking");
      setConnError(null);
      try {
        const data = await guestyService.getListings(200, 0);
        if (cancelled) return;
        setListings(data.results || []);
        setConn("connected");
        return;
      } catch (listError: any) {
        if (cancelled) return;
        const result = await guestyService.checkConnection();
        if (cancelled) return;
        if (result.connected) {
          setConn("connected");
        } else {
          const isRateLimited = result.error === "RATE_LIMITED" || listError?.message === "RATE_LIMITED";
          setConn(isRateLimited ? "rate-limited" : "disconnected");
          setConnError(result.error || listError?.message || null);
        }
      }
    }
    init();
    return () => { cancelled = true; };
  }, []);

  // ── Load the guesty-property-map once ──────────────────────────────────────
  // Used both to pre-select the dropdown when the user lands on a
  // property AND to navigate when the user picks a different listing
  // from the dropdown (each Guesty listing maps to at most one
  // propertyId). One fetch per mount, cached in state.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/guesty-property-map")
      .then((r) => r.json())
      .then((maps: Array<{ propertyId: number; guestyListingId: string }>) => {
        if (!cancelled && Array.isArray(maps)) {
          setPropertyMap(maps);
          const match = propertyId ? maps.find((m) => m.propertyId === propertyId) : null;
          if (match?.guestyListingId) {
            setSelectedId(match.guestyListingId);
            setConn((current) => current === "checking" || current === "rate-limited" ? "connected" : current);
            setConnError((current) => current === "RATE_LIMITED" ? null : current);
          }
        }
      })
      .catch(() => { /* non-fatal — auto-select and dropdown-navigate degrade gracefully */ });
    return () => { cancelled = true; };
  }, []);

  // ── Sync the Guesty listing dropdown to the current property ───────────────
  // Two responsibilities:
  //   1. Pre-select the dropdown to whichever Guesty listing is mapped
  //      to the current propertyId — users landing on a property's
  //      builder expect the correct push target to be ready.
  //   2. Reset the dropdown to "" when navigating to a property that
  //      has no mapping. Without this reset, switching from a draft
  //      (e.g. propertyId -1, no Guesty listing yet) to
  //      another property left the dropdown stuck on the previously-
  //      selected listing — and the property-keyed tabs (pricing,
  //      bedding, photos) showed the new property's data while the
  //      "push target" stayed pointed at the old one.
  useEffect(() => {
    if (!propertyId || propertyMap.length === 0) return;
    const match = propertyMap.find((m) => m.propertyId === propertyId);
    if (match?.guestyListingId) {
      setSelectedId(match.guestyListingId);
      if (conn === "checking" || conn === "rate-limited") {
        setConn("connected");
        setConnError(null);
      }
    } else {
      setSelectedId("");
    }
  }, [conn, propertyId, propertyMap]);

  // ── Repair old draft pages that have a matching Guesty listing but no usable map ──
  // Earlier builds could import a just-created Guesty listing into a *new*
  // draft and leave the builder's current draft unmapped. When we can prove
  // there is exactly one Guesty listing with the same title/nickname, connect
  // it automatically so the dropdown and dashboard green G recover together.
  // Guesty commonly truncates listing nicknames around 40 chars, so recovery
  // accepts a one-sided prefix match only when the shared prefix is long enough
  // to remain unambiguous.
  useEffect(() => {
    if (!propertyId || propertyId >= 0 || listings.length === 0) return;
    const existingMap = propertyMap.find((m) => m.propertyId === propertyId);
    const existingMapIsValid = existingMap && listings.some((l) => guestyListingId(l) === existingMap.guestyListingId);
    if (existingMapIsValid) return;
    try {
      const candidateNames = new Set<string>();
      for (const name of [propertyData?.nickname, propertyData?.title, propertyData?.descriptions?.title]) {
        const normalized = normalizeListingName(name);
        if (normalized) candidateNames.add(normalized);
      }
      if (candidateNames.size === 0) return;
      const isRecoverableNameMatch = (candidate: string, listingName: string) => {
        if (!candidate || !listingName) return false;
        if (candidate === listingName) return true;
        const minLength = Math.min(candidate.length, listingName.length);
        return minLength >= 32 && (candidate.startsWith(listingName) || listingName.startsWith(candidate));
      };
      const exactMatches: GuestyListing[] = [];
      for (const listing of listings) {
        for (const name of [listing.nickname, listing.title]) {
          const normalized = normalizeListingName(name);
          let matched = false;
          for (const candidate of candidateNames) {
            if (isRecoverableNameMatch(candidate, normalized)) {
              matched = true;
              break;
            }
          }
          if (matched) {
            exactMatches.push(listing);
            break;
          }
        }
      }
      const uniqueMatches = Array.from(new Map(exactMatches.map((listing) => [guestyListingId(listing), listing])).values())
        .filter((listing) => guestyListingId(listing));
      if (uniqueMatches.length === 0) return;
      if (uniqueMatches.length > 1) {
        console.warn("[GuestyListingBuilder] multiple draft Guesty listing matches; using the first Guesty result", {
          propertyId,
          matches: uniqueMatches.map((listing) => ({ id: guestyListingId(listing), name: listing.nickname || listing.title || "" })),
        });
      }

      const match = uniqueMatches[0];
      const matchId = guestyListingId(match);
      const attemptKey = `${propertyId}:${matchId}`;
      if (autoMapAttemptRef.current === attemptKey) return;
      autoMapAttemptRef.current = attemptKey;

      fetch("/api/guesty-property-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId, guestyListingId: matchId }),
      })
        .then(async (resp) => {
          if (!resp.ok) throw new Error("Guesty property map repair failed");
          rememberPropertyMap(propertyId, matchId);
          setSelectedId(matchId);
          toast({
            title: "Guesty listing matched",
            description: "This builder draft is now connected to the matching Guesty listing.",
            duration: 6000,
          });
        })
        .catch(() => { /* non-fatal; the user can still select manually */ });
    } catch (e) {
      console.warn("[GuestyListingBuilder] draft auto-map skipped after unexpected data shape", e);
    }
  }, [propertyId, listings, propertyMap, propertyData?.nickname, propertyData?.title, propertyData?.descriptions?.title, rememberPropertyMap, toast]);

  // Last-resort draft recovery for Guesty payloads whose name fields differ
  // slightly from our local title but still share the distinctive opening
  // phrase. This keeps promoted single listings from landing on a blank
  // dropdown when Guesty truncates or strips the final "Sleeps N" suffix.
  useEffect(() => {
    if (!propertyId || propertyId >= 0 || selectedId || listings.length === 0) return;
    const titleNorm = normalizeListingName(propertyData?.descriptions?.title || propertyData?.title || propertyData?.nickname);
    const titlePrefix = titleNorm.split(" ").slice(0, 5).join(" ");
    if (titlePrefix.length < 18) return;
    const matches = listings.filter((listing) => {
      const id = guestyListingId(listing);
      const nameNorm = normalizeListingName(listing.nickname || listing.title);
      return id && (nameNorm.startsWith(titlePrefix) || titleNorm.startsWith(nameNorm));
    });
    const uniqueMatches = Array.from(new Map(matches.map((listing) => [guestyListingId(listing), listing])).values());
    if (uniqueMatches.length === 0) return;
    const id = guestyListingId(uniqueMatches[0]);
    if (!id) return;
    rememberPropertyMap(propertyId, id);
    setSelectedId(id);
    fetch("/api/guesty-property-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyId, guestyListingId: id }),
    }).catch(() => { /* non-fatal; local selection is still useful */ });
  }, [propertyId, selectedId, listings, propertyData?.nickname, propertyData?.title, propertyData?.descriptions?.title, rememberPropertyMap]);

  // ── Load channel status when selection changes ─────────────────────────────
  const refreshChannelStatus = useCallback(() => {
    if (!selectedId) { setChannelStatus(null); return; }
    setLoadingChannels(true);
    guestyService.getChannelStatus(selectedId)
      .then((status) => {
        setChannelStatus(status);
        setConn("connected");
        setConnError(null);
      })
      .catch((e: any) => {
        setChannelStatus((current) => current);
        if (e?.message !== "RATE_LIMITED") {
          setConnError(e?.message ?? "Failed to load channel status");
        }
      })
      .finally(() => setLoadingChannels(false));
  }, [selectedId]);
  useEffect(() => { refreshChannelStatus(); }, [refreshChannelStatus]);

  const describeChannelVerification = useCallback((status: GuestyChannelStatus) => {
    const names: Record<"airbnb" | "vrbo" | "bookingCom", string> = {
      airbnb: "Airbnb",
      vrbo: "VRBO",
      bookingCom: "Booking.com",
    };
    const live = (["airbnb", "vrbo", "bookingCom"] as const)
      .filter((key) => status[key]?.live)
      .map((key) => names[key]);
    const connectedBlocked = (["airbnb", "vrbo", "bookingCom"] as const)
      .filter((key) => status[key]?.connected && !status[key]?.live)
      .map((key) => `${names[key]} (${status[key]?.status || "connected, not live"})`);
    const missing = (["airbnb", "vrbo", "bookingCom"] as const)
      .filter((key) => !status[key]?.connected)
      .map((key) => names[key]);

    if (!status.isListed) return "Guesty still reports this listing as not listed/bookable.";
    const parts = [`Guesty reports the listing is bookable${live.length ? `; live on ${live.join(", ")}` : ""}.`];
    if (connectedBlocked.length) parts.push(`Connected but not live yet: ${connectedBlocked.join(", ")}.`);
    if (missing.length) parts.push(`No connected channel account found for: ${missing.join(", ")}.`);
    return parts.join(" ");
  }, []);

  const handleListOnChannels = useCallback(async () => {
    if (!selectedId || listingStateBusy || building || conn !== "connected") return;
    setListingStateBusy("list");
    try {
      const status = await guestyService.listOnChannelsAndVerify(selectedId);
      setChannelStatus(status);
      toast({
        title: status.isListed ? "Listing marked bookable" : "Guesty did not confirm bookable",
        description: describeChannelVerification(status),
        variant: status.isListed ? undefined : "destructive",
        duration: 8000,
      });
    } catch (e) {
      toast({
        title: "Could not mark listing bookable",
        description: (e as Error).message,
        variant: "destructive",
        duration: 8000,
      });
      refreshChannelStatus();
    } finally {
      setListingStateBusy(null);
    }
  }, [selectedId, listingStateBusy, building, conn, toast, describeChannelVerification, refreshChannelStatus]);

  const handleUnlistFromChannels = useCallback(async () => {
    if (!selectedId || listingStateBusy || building || conn !== "connected") return;
    setListingStateBusy("unlist");
    try {
      const status = await guestyService.unlistFromChannelsAndVerify(selectedId);
      setChannelStatus(status);
      toast({
        title: status.isListed ? "Guesty still reports listed" : "Listing unlisted",
        description: status.isListed ? "Guesty accepted the request but still reports isListed=true. Check Guesty for a channel-specific blocker." : "Guesty reports this listing is no longer globally bookable/listed.",
        variant: status.isListed ? "destructive" : undefined,
        duration: 8000,
      });
    } catch (e) {
      toast({
        title: "Could not unlist listing",
        description: (e as Error).message,
        variant: "destructive",
        duration: 8000,
      });
      refreshChannelStatus();
    } finally {
      setListingStateBusy(null);
    }
  }, [selectedId, listingStateBusy, building, conn, toast, refreshChannelStatus]);

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
      // The build sequence ends with list_on_channels (flips isListed:false →
      // true), so the listing is live on connected channels by default. If
      // that step failed, the build log shows it and the user can flip it
      // manually in Guesty admin.
      const listStep = result.steps.find((s) => s.step === "list_on_channels");
      const listed = listStep?.status === "success";
      toast({
        title: "✓ Listing created on Guesty!",
        description: listed
          ? `ID: ${result.listingId} — listed on connected channels. It now appears in the dropdown above.`
          : `ID: ${result.listingId} — created as a draft (list-on-channels step didn't complete, check the build log). It now appears in the dropdown above.`,
      });
      const fresh = await guestyService.getListings(200, 0);
      setListings(fresh.results || []);
      setSelectedId(result.listingId);

      let syncPropertyId = propertyId;
      try {
        const importRes = await fetch("/api/community/import-guesty-listing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guestyListingId: result.listingId, propertyId }),
        });
        if (importRes.ok) {
          const imported = await importRes.json().catch(() => null) as {
            draft?: { id?: number; name?: string; listingTitle?: string | null };
            mapping?: { propertyId?: number };
            imported?: boolean;
          } | null;
          const importedDraftId = imported?.draft?.id;
          if (typeof imported?.mapping?.propertyId === "number") {
            syncPropertyId = imported.mapping.propertyId;
          } else if (typeof importedDraftId === "number") {
            syncPropertyId = -importedDraftId;
          }
          if (syncPropertyId) rememberPropertyMap(syncPropertyId, result.listingId);
          await queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
          if (imported?.imported) {
            toast({
              title: "Saved to dashboard",
              description: `${imported.draft?.listingTitle || imported.draft?.name || "Guesty listing"} is now available on the dashboard.`,
              duration: 7000,
            });
          }
        } else {
          const error = await importRes.json().catch(() => ({})) as { error?: string; message?: string };
          console.warn("Guesty listing created but dashboard import failed", error);
        }
      } catch (e) {
        console.warn("Guesty listing created but dashboard import failed", e);
      }

      if (syncPropertyId) {
        try {
          await fetch("/api/builder/schedule-sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ propertyId: syncPropertyId, guestyListingId: result.listingId, delayMinutes: 60 }),
          });
          rememberPropertyMap(syncPropertyId, result.listingId);
          toast({ title: "Availability sync scheduled", description: "Blackout dates will be pushed to Guesty in ~1 hour.", duration: 6000 });
        } catch {
          // non-fatal
        }
      }
    }
    onBuildComplete?.({ listingId: result.listingId });
  }, [effectivePropertyData, building, conn, onBuildComplete, propertyId, queryClient, rememberPropertyMap, toast]);

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

  const pushDescriptionsToGuesty = useCallback(async (showToast = true) => {
    if (!effectivePropertyData?.descriptions || !selectedId) {
      throw new Error("Select a Guesty listing and make sure descriptions are available.");
    }
    setDescPushState("pushing");
    setDescPushError(null);
    // Keep the title's "Sleeps N" in sync with the bed-derived occupancy so the
    // Guesty title/nickname can't drift from the actual sleeping capacity (the
    // operator hit a title saying "Sleeps 14" while the beds sleep 16).
    const sleeps = typeof propertyId === "number" ? totalBeddingSleeps(loadBuilderBeddingConfig(propertyId)) : 0;
    const descriptions = {
      ...effectivePropertyData.descriptions,
      title: syncSleepsInTitle(effectivePropertyData.descriptions.title ?? "", sleeps),
    };
    const res = await fetch("/api/builder/push-descriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listingId: selectedId, descriptions }),
    });
    const data = await res.json() as { success: boolean; error?: string; returnedDescriptions?: Record<string, string> | null };
    if (!res.ok || !data.success) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    setDescPushState("success");
    recordDataPush("descriptions", "success", "Descriptions updated");
    if (showToast) {
        toast({ title: "Descriptions pushed to Guesty", description: "Summary, Space, Neighborhood, and other description fields updated." });
    }
    return data;
  }, [effectivePropertyData, selectedId, recordDataPush, toast, propertyId]);

  const pushDescriptions = useCallback(async () => {
    if (descPushState === "pushing") return;
    try {
      await pushDescriptionsToGuesty(true);
    } catch (e) {
      setDescPushState("error");
      setDescPushError((e as Error).message);
      recordDataPush("descriptions", "error", (e as Error).message);
    }
  }, [descPushState, pushDescriptionsToGuesty, recordDataPush]);

  const [syncingDetails, setSyncingDetails] = useState(false);
  const syncBeddingAndSqftToGuesty = useCallback(async (showToast = true) => {
    if (!selectedId) throw new Error("Select a Guesty listing first.");
    if (typeof propertyId !== "number") throw new Error("Property data is missing a local property id.");

    const propData = getUnitBuilderByPropertyId(propertyId);
    const beddingConfig = loadBuilderBeddingConfig(propertyId);
    const beddingRooms = buildBeddingListingRooms(beddingConfig);
    const rooms = beddingRooms.length > 0 ? beddingRooms : buildListingRooms(propertyId);
    const sqft = propData
      ? propData.units.reduce((s, u) => s + parseSqft(u.sqft), 0)
      : effectivePropertyData?.areaSquareFeet ?? 0;
    const beds = totalBeddingBedrooms(beddingConfig) || propData?.units.reduce((s, u) => s + u.bedrooms, 0) || 0;
    const baths = totalBeddingBathrooms(beddingConfig) || propData?.units.reduce((s, u) => s + parseFloat(u.bathrooms), 0) || 0;
    const sleeps = totalBeddingSleeps(beddingConfig);

    await guestyService.updateListingDetails(selectedId, {
      areaSquareFeet: sqft || undefined,
      bedrooms: beds || undefined,
      bathrooms: baths || undefined,
      accommodates: sleeps || undefined,
      listingRooms: rooms.length > 0 ? rooms : undefined,
    });

    const message = `Bedding/sqft updated: ${beds || "?"} BR, ${rooms.length} rooms, ${sqft ? `${sqft.toLocaleString()} sqft` : "sqft unavailable"}`;
    recordDataPush("bedding", "success", message);
    if (showToast) {
      toast({
        title: "Bedding & sqft pushed to Guesty",
        description: `${rooms.length} rooms, ${sqft.toLocaleString()} sqft, sleeps ${sleeps || "n/a"}.`,
      });
    }
    return { rooms, sqft, beds, baths, sleeps };
  }, [selectedId, propertyId, effectivePropertyData?.areaSquareFeet, recordDataPush, toast]);

  const handleSyncDetails = useCallback(async () => {
    if (syncingDetails || building) return;
    setSyncingDetails(true);
    try {
      await syncBeddingAndSqftToGuesty(true);
    } catch (e) {
      recordDataPush("bedding", "error", (e as Error).message);
      toast({ title: "Sync Failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSyncingDetails(false);
    }
  }, [syncingDetails, building, syncBeddingAndSqftToGuesty, recordDataPush, toast]);

  const pushAmenitiesToGuesty = useCallback(async (showToast = true) => {
    if (!selectedId) throw new Error("Select a Guesty listing first.");
    setAmenityPushState("pushing");
    setAmenityPushResult(null);
    // Translate our profile keys -> Guesty canonical IDs where we have a mapping.
    const amenityPayload = Array.from(pendingAmenities).map(k => keyToGuestyId[k] ?? k);
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
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    setAmenityPushState("success");
    setAmenityPushResult({
      sent: data.sent ?? 0,
      saved: data.saved ?? 0,
      missing: data.missing ?? [],
      rejected: data.rejected ?? [],
      suggestions: data.suggestions ?? [],
      guestyCatalogSize: data.guestyCatalogSize,
    });
    if (Array.isArray(data.savedAmenities) || Array.isArray(data.otherAmenities)) {
      const merged = [...(data.savedAmenities ?? []), ...(data.otherAmenities ?? [])];
      setGuestyLiveAmenities(guestyNamesToProfileKeys(merged));
    }
    recordDataPush("amenities", "success", `${data.saved ?? 0}/${data.sent ?? amenityPayload.length} amenities confirmed`);
    if (showToast) {
        toast({
          title: `Amenities pushed to Guesty`,
          description: data.missing && data.missing.length > 0
            ? `${data.saved}/${data.sent} saved. ${data.missing.length} names Guesty didn't recognise — check server logs.`
            : `${data.saved} amenities confirmed in Guesty's Popular Amenities panel.`,
          duration: 8000,
        });
    }
    return data;
  }, [selectedId, pendingAmenities, toast, keyToGuestyId, guestyNamesToProfileKeys, recordDataPush]);

  const pushAmenities = useCallback(async () => {
    if (amenityPushState === "pushing") return;
    try {
      await pushAmenitiesToGuesty(true);
    } catch (e) {
      setAmenityPushState("error");
      recordDataPush("amenities", "error", (e as Error).message);
      toast({ title: "Amenities push failed", description: (e as Error).message, variant: "destructive" });
    }
  }, [amenityPushState, pushAmenitiesToGuesty, recordDataPush, toast]);

  const pushBookableToGuestyOnce = useCallback(async () => {
    if (!selectedId) throw new Error("Select a Guesty listing first.");
    if (dataPushLog.bookable?.status === "success") {
      return { changed: false, message: "Bookable status was already pushed once." };
    }
    if (channelStatus?.isListed) {
      recordDataPush("bookable", "success", "Already bookable in Guesty; no update sent");
      return { changed: false, message: "Listing was already bookable in Guesty." };
    }

    const status = await guestyService.listOnChannelsAndVerify(selectedId);
    setChannelStatus(status);
    if (!status.isListed) {
      const message = describeChannelVerification(status);
      recordDataPush("bookable", "error", message);
      throw new Error(message);
    }

    const message = describeChannelVerification(status);
    recordDataPush("bookable", "success", message);
    return { changed: true, message };
  }, [
    selectedId,
    dataPushLog.bookable?.status,
    channelStatus?.isListed,
    recordDataPush,
    describeChannelVerification,
  ]);

  const queueMarketPricingRefresh = useCallback(async () => {
    if (!propertyId) throw new Error("Select a property before refreshing market pricing.");
    const label = propertyData?.nickname
      || propertyData?.title
      || effectivePropertyData?.descriptions?.title
      || `Property ${propertyId}`;
    const resp = await fetch("/api/pricing/bulk-refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        propertyIds: [propertyId],
        labels: { [String(propertyId)]: label },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.ok === false) {
      throw new Error(data?.error || `Market pricing refresh failed with HTTP ${resp.status}`);
    }
    return data?.job as { id?: string } | undefined;
  }, [effectivePropertyData?.descriptions?.title, propertyData?.nickname, propertyData?.title, propertyId]);

  const handlePushPropertyDataPreview = useCallback(async () => {
    if (!selectedId || dataPushBusy || building || conn !== "connected") return;
    setDataPushBusy(true);
    const failures: string[] = [];
    let bookableChanged = false;
    let pricingMessage = "";

    try {
      await pushDescriptionsToGuesty(false);
    } catch (e) {
      const message = (e as Error).message;
      failures.push(`Descriptions: ${message}`);
      setDescPushState("error");
      setDescPushError(message);
      recordDataPush("descriptions", "error", message);
    }

    try {
      await syncBeddingAndSqftToGuesty(false);
    } catch (e) {
      const message = (e as Error).message;
      failures.push(`Bedding: ${message}`);
      recordDataPush("bedding", "error", message);
    }

    try {
      await pushAmenitiesToGuesty(false);
    } catch (e) {
      const message = (e as Error).message;
      failures.push(`Amenities: ${message}`);
      setAmenityPushState("error");
      recordDataPush("amenities", "error", message);
    }

    try {
      const photoPush = await upscaleAndUpload(effectivePropertyData?.photos ?? [], false);
      if (photoPush.error || photoPush.successCount <= 0) {
        throw new Error(photoPush.error ?? "No photos were saved to Guesty.");
      }
      const photoMessage = `${photoPush.successCount}/${photoPush.total} photos pushed to Guesty${photoPush.shortfall > 0 ? ` (${photoPush.shortfall} dropped by Guesty)` : ""}`;
      recordDataPush("photos", "success", photoMessage);
    } catch (e) {
      const message = (e as Error).message;
      failures.push(`Photos: ${message}`);
      recordDataPush("photos", "error", message);
    }

    try {
      const bookable = await pushBookableToGuestyOnce();
      bookableChanged = bookable.changed;
    } catch (e) {
      const message = (e as Error).message;
      failures.push(`Bookable status: ${message}`);
    }

    try {
      const job = await queueMarketPricingRefresh();
      if (job?.id && propertyId) {
        // The rate push is async (refresh P40 -> then push to Guesty). Seed the
        // live status; the poller effect below tracks it through to the actual
        // Guesty rate push and the chip is left pending (not a premature ✓)
        // until the job terminates.
        const queued: PricingPushStatus = {
          jobId: job.id,
          status: "queued",
          phase: "queued",
          percent: 5,
          label: "Market pricing refresh queued; Guesty rate push runs after refresh",
          startedAt: Date.now(),
        };
        setPricingPushStatus(queued);
        try {
          localStorage.setItem(pricingPushStatusKeyFor(propertyId), JSON.stringify(queued));
        } catch {
          // advisory persistence only
        }
        markDataPushPending("pricing");
        pricingMessage = `Market pricing refresh queued (${job.id}); the Guesty rate push runs after the SearchAPI Airbnb refresh — watch the status below the button.`;
      } else {
        pricingMessage = "Market pricing refresh queued; Guesty rate push runs after refresh.";
      }
    } catch (e) {
      const message = (e as Error).message;
      failures.push(`Market pricing: ${message}`);
      recordDataPush("pricing", "error", message);
    }

    setDataPushBusy(false);
    if (failures.length > 0) {
      toast({
        title: "Some Guesty pushes failed",
        description: failures.join(" | "),
        variant: "destructive",
        duration: 9000,
      });
      return;
    }

    toast({
      title: "Property data pushed to Guesty",
      description: bookableChanged
        ? `Descriptions, bedding/sqft, amenities, photos, bookable status, and market pricing were handled. ${pricingMessage}`
        : `Descriptions, bedding/sqft, amenities, photos, and market pricing were handled. Bookable status was already handled. ${pricingMessage}`,
      duration: 7000,
    });
  }, [
    selectedId,
    dataPushBusy,
    building,
    conn,
    pushDescriptionsToGuesty,
    syncBeddingAndSqftToGuesty,
    pushAmenitiesToGuesty,
    effectivePropertyData?.photos,
    upscaleAndUpload,
    pushBookableToGuestyOnce,
    queueMarketPricingRefresh,
    recordDataPush,
    markDataPushPending,
    propertyId,
    toast,
  ]);

  const pillLabel = conn === "checking" ? "Checking connection…" : conn === "connected" ? "Guesty Connected" : conn === "rate-limited" ? "Rate Limited — retry later" : "Guesty Disconnected";
  const photos = propertyData?.photos || [];

  // Build the photo-community-check request from the photos currently shown in
  // the tab (the curated set the operator will actually push) and POST it. Each
  // photo's `source` tells us its role/label: "Community — {complex}" vs.
  // "Unit A (3BR)"; the folder + filename come from the /photos/<folder>/<file>
  // URL. Works for static props, drafts, and single listings because it reads
  // only from the rendered photo list — no dependence on static unit-builder
  // data being present for this property.
  const runCommunityCheck = useCallback(async () => {
    setCommunityCheckPhase("running");
    setCommunityCheckError(null);
    setCommunityCheckResult(null);
    try {
      const parse = (url: string): { folder: string; filename: string } | null => {
        try {
          const p = url.startsWith("/") ? url : new URL(url, window.location.origin).pathname;
          const m = p.match(/^\/photos\/([^/?#]+)\/([^/?#]+)$/);
          return m ? { folder: m[1], filename: m[2] } : null;
        } catch { return null; }
      };
      type ReqGroup = { role: "community" | "unit"; label: string; folder: string; filenames: string[]; captions: Record<string, string> };
      const byFolder = new Map<string, ReqGroup>();
      let expectedCommunity = "";
      for (const p of photos) {
        const parsed = parse(p.url);
        if (!parsed) continue;
        const src = String(p.source ?? "");
        const role: "community" | "unit" = /^community\b/i.test(src) ? "community" : "unit";
        if (role === "community" && !expectedCommunity) {
          expectedCommunity = src.replace(/^community\s*[—–-]\s*/i, "").trim();
        }
        let g = byFolder.get(parsed.folder);
        if (!g) {
          g = { role, label: src || parsed.folder, folder: parsed.folder, filenames: [], captions: {} };
          byFolder.set(parsed.folder, g);
        }
        if (!g.filenames.includes(parsed.filename)) g.filenames.push(parsed.filename);
        if (p.caption) g.captions[parsed.filename] = p.caption;
      }
      const groups = Array.from(byFolder.values())
        .sort((a, b) => (a.role === b.role ? a.label.localeCompare(b.label) : a.role === "community" ? -1 : 1));
      if (groups.length === 0) {
        setCommunityCheckError("No local photo folders found to check.");
        setCommunityCheckPhase("error");
        return;
      }
      const resp = await fetch("/api/builder/photo-community-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId, expectedCommunity, groups }),
      });
      const data = await resp.json().catch(() => null) as PhotoCommunityCheckResult | { error?: string } | null;
      if (!resp.ok || !data) {
        setCommunityCheckError((data as any)?.error || `HTTP ${resp.status}`);
        setCommunityCheckPhase("error");
        return;
      }
      setCommunityCheckResult(data as PhotoCommunityCheckResult);
      setCommunityCheckPhase("done");
    } catch (e: any) {
      setCommunityCheckError(e?.message ?? String(e));
      setCommunityCheckPhase("error");
    }
  }, [photos, propertyId]);

  const amenities = propertyData?.amenities || [];
  const descriptions = effectivePropertyData?.descriptions;
  const pricing = propertyData?.pricing;

  // Live per-property market-rate cache. Hydrated from
  // GET /api/property/market-rates on mount and after a manual
  // refresh (Refresh market rates button below). The version
  // counter is the seasonalMonths useMemo's signal that the
  // module-level live-buy-in cache changed and the per-channel
  // floor formula should be recomputed against the new median.
  const [marketRatesVersion, setMarketRatesVersion] = useState(0);
  const [marketRatesRefreshing, setMarketRatesRefreshing] = useState(false);
  // Live per-channel cheapest snapshot from the most recent refresh.
  // Ephemeral (not persisted on the server, not in property_market_rates)
  // — refresh response carries it; we render a card showing "Cheapest
  // right now: airbnb $620 · vrbo $580 · booking $605 · pm $590" so the operator
  // can see when one channel diverges materially from the median basis.
  const [liveSnapshot, setLiveSnapshot] = useState<{
    seasons: {
      LOW:     { checkIn: string; checkOut: string; daemonOnline: boolean } | null;
      HIGH:    { checkIn: string; checkOut: string; daemonOnline: boolean } | null;
      HOLIDAY: { checkIn: string; checkOut: string; daemonOnline: boolean } | null;
    };
    region: "hawaii" | "florida" | null;
    perBR: Array<{
      bedrooms: number;
      // Per-season basis from the multi-season scan. LOW always
      // present (or 0 if the scan had no data); HIGH/HOLIDAY null
      // when the scan didn't cover that season.
      low: number;
      high: number | null;
      holiday: number | null;
      basisSource: "static-buy-in" | "optimized-buy-in" | "live-multichannel-median" | "monthly-multichannel-median" | "season-band-multichannel-median" | "hybrid-airbnb-layered" | "airbnb" | "none";
      channelCount: number;
      // LOW-season per-channel breakdown. HIGH/HOLIDAY are persisted
      // as basis numbers, but the compact chip row shows the LOW
      // channel mix from the most recent scan.
      channels: { airbnb: number | null; vrbo: number | null; booking: number | null; pm: number | null };
    }>;
  } | null>(null);

  // Live progress state for the in-flight refresh — polled every
  // 1.5s while marketRatesRefreshing is true.
  //
  // PR #311: also surface lastTickAt + daemonOnline so the UI can
  // distinguish "scan still running, daemon alive, just queued behind
  // other ops" from "scan actually frozen — daemon dead or wedged."
  // Server emits a heartbeat tick every 15s during non-terminal
  // phases so lastTickAt stays fresh even when no phase boundary
  // passes for several minutes (typical during sidecar phases).
  type ScanWarning = {
    season: "LOW" | "HIGH" | "HOLIDAY";
    channel: "airbnb" | "vrbo" | "booking" | "pm" | "engine";
    kind: "captcha" | "blocked" | "rate-limit" | "timeout" | "network" | "unknown";
    message: string;
    reason?: string;
  };
  type MarketRefreshProgress = {
    phase: string;
    percent: number;
    label: string;
    startedAt?: number;
    error?: string;
    progressDone?: number;
    progressTotal?: number;
    progressCurrent?: number;
    progressWindowLabel?: string;
    progressWindowStartedAt?: number;
    progressSubDone?: number;
    progressSubTotal?: number;
    progressSubLabel?: string;
    progressSubChannel?: "airbnb" | "vrbo" | "booking" | "pm";
    progressSubBedrooms?: number;
    progressSubStartedAt?: number;
    lastTickAt?: number;
    daemonOnline?: boolean;
    daemonLastPollAgeMs?: number | null;
    warnings?: ScanWarning[];
  };
  type MarketRefreshNotice = {
    propertyId: number;
    status: "done" | "error";
    finishedAt: number;
    startedAt?: number;
    label: string;
    error?: string;
  };
  type ScannerScheduleSnapshot = {
    targetMargin?: string | number | null;
    lastGuestyRatePushAt?: string | null;
    lastGuestyRatePushStatus?: string | null;
    lastGuestyRatePushSummary?: string | null;
  };
  type PricingUpdateLog = {
    id: number;
    propertyId: number;
    propertyName: string;
    bedrooms: number;
    triggerType: string;
    oldRate: string | number | null;
    newRate: string | number | null;
    status: string;
    notes?: string | null;
    layersJson?: Array<Record<string, any>>;
    calendarJson?: Record<string, any>;
    createdAt: string;
  };
  const refreshNoticeKeyFor = (id: number) => `nexstay.market-rate-refresh.${id}.notice`;
  const refreshNoticeDismissKeyFor = (id: number) => `nexstay.market-rate-refresh.${id}.server-dismissed-at`;
  const REFRESH_TRACKING_LOST_MESSAGE = "Refresh tracking was interrupted, likely by a deploy, server restart, or computer sleep. Start a fresh pricing update when the server is stable.";
  const [refreshProgress, setRefreshProgress] = useState<MarketRefreshProgress | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<MarketRefreshNotice | null>(null);
  const [pricingUpdateLogs, setPricingUpdateLogs] = useState<PricingUpdateLog[]>([]);
  const [pricingLogsLoading, setPricingLogsLoading] = useState(false);
  const [dismissedServerRefreshAt, setDismissedServerRefreshAt] = useState<number>(0);
  const handledTerminalProgressRef = useRef<string | null>(null);
  const marketRatesRefreshingRef = useRef(false);
  const refreshProgressRef = useRef<MarketRefreshProgress | null>(null);
  const missingProgressPollsRef = useRef(0);
  const lostProgressRecordedRef = useRef(false);
  const screenWakeLockRef = useRef<any>(null);
  const activeMarketPricingQueueJobRef = useRef<string | null>(null);
  // 1Hz ticker so the elapsed-time display + staleness warning re-
  // render between the 1.5s progress polls. Cheap (no network); keyed
  // off marketRatesRefreshing so it stops when the scan ends.
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    marketRatesRefreshingRef.current = marketRatesRefreshing;
  }, [marketRatesRefreshing]);
  useEffect(() => {
    refreshProgressRef.current = refreshProgress;
  }, [refreshProgress]);
  useEffect(() => {
    if (!marketRatesRefreshing) return;
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [marketRatesRefreshing]);
  useEffect(() => {
    if (!marketRatesRefreshing || typeof navigator === "undefined" || typeof document === "undefined") return;
    let cancelled = false;
    const requestWakeLock = async () => {
      try {
        const wakeLock = (navigator as any).wakeLock;
        if (!wakeLock?.request || document.visibilityState !== "visible") return;
        screenWakeLockRef.current = await wakeLock.request("screen");
      } catch (e: any) {
        console.info(`[refresh-market-rates] screen wake lock unavailable: ${e?.message ?? e}`);
      }
    };
    const handleVisibilityChange = () => {
      if (!cancelled && document.visibilityState === "visible" && !screenWakeLockRef.current) {
        void requestWakeLock();
      }
    };
    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const wakeLock = screenWakeLockRef.current;
      screenWakeLockRef.current = null;
      if (wakeLock?.release) {
        void wakeLock.release().catch(() => undefined);
      }
    };
  }, [marketRatesRefreshing]);
  const [refreshStartedAt, setRefreshStartedAt] = useState<number | null>(null);
  // AbortController for the in-flight pricing fetch. The server owns
  // progress/lock state, so cancel also calls the server cleanup endpoint.
  const refreshAbortRef = useRef<AbortController | null>(null);
  const cancelRefresh = useCallback(() => {
    if (!propertyId) return;
    const startedAt = refreshProgressRef.current?.startedAt ?? refreshStartedAt ?? Date.now();
    if (refreshAbortRef.current) {
      console.info("[refresh-market-rates] operator cancelled");
      refreshAbortRef.current.abort();
      refreshAbortRef.current = null;
    }
    const activeQueueJobId = activeMarketPricingQueueJobRef.current;
    if (activeQueueJobId) {
      void fetch(`/api/pricing/bulk-refresh/${activeQueueJobId}/cancel`, { method: "POST" }).catch(() => undefined);
      activeMarketPricingQueueJobRef.current = null;
    }
    void fetch(`/api/property/${propertyId}/refresh-progress/cancel`, { method: "POST" }).catch(() => undefined);
    const cancelledNotice: MarketRefreshNotice = {
      propertyId,
      status: "error",
      finishedAt: Date.now(),
      startedAt,
      label: "Pricing refresh cancelled",
      error: "Cancelled by operator",
    };
    setRefreshProgress({
      phase: "error",
      percent: 100,
      label: "Pricing refresh cancelled",
      error: "Cancelled by operator",
      startedAt,
    });
    setRefreshNotice(cancelledNotice);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(refreshNoticeKeyFor(propertyId), JSON.stringify(cancelledNotice));
      }
    } catch {}
    setRefreshStartedAt(null);
    setMarketRatesRefreshing(false);
  }, [propertyId, refreshStartedAt]);
  useEffect(() => {
    handledTerminalProgressRef.current = null;
    missingProgressPollsRef.current = 0;
    lostProgressRecordedRef.current = false;
    if (!propertyId || typeof window === "undefined") {
      setRefreshNotice(null);
      setDismissedServerRefreshAt(0);
      return;
    }
    try {
      const dismissedRaw = window.localStorage.getItem(refreshNoticeDismissKeyFor(propertyId));
      const dismissedAt = dismissedRaw ? Number.parseInt(dismissedRaw, 10) : 0;
      setDismissedServerRefreshAt(Number.isFinite(dismissedAt) && dismissedAt > 0 ? dismissedAt : 0);
      const raw = window.localStorage.getItem(refreshNoticeKeyFor(propertyId));
      if (!raw) {
        setRefreshNotice(null);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<MarketRefreshNotice>;
      if (
        parsed.propertyId === propertyId &&
        (parsed.status === "done" || parsed.status === "error") &&
        typeof parsed.finishedAt === "number" &&
        Number.isFinite(parsed.finishedAt)
      ) {
        setRefreshNotice({
          propertyId,
          status: parsed.status,
          finishedAt: parsed.finishedAt,
          startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : undefined,
          label: typeof parsed.label === "string" && parsed.label.trim() ? parsed.label : "Pricing update finished",
          error: typeof parsed.error === "string" ? parsed.error : undefined,
        });
      } else {
        window.localStorage.removeItem(refreshNoticeKeyFor(propertyId));
        setRefreshNotice(null);
      }
    } catch {
      window.localStorage.removeItem(refreshNoticeKeyFor(propertyId));
      setRefreshNotice(null);
    }
  }, [propertyId]);
  const recordRefreshNotice = useCallback((notice: Omit<MarketRefreshNotice, "propertyId">) => {
    if (!propertyId) return;
    const next: MarketRefreshNotice = { ...notice, propertyId };
    setRefreshNotice(next);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(refreshNoticeKeyFor(propertyId), JSON.stringify(next));
      }
    } catch {}
  }, [propertyId]);
  const dismissRefreshNotice = useCallback(() => {
    setRefreshNotice(null);
    try {
      if (propertyId && typeof window !== "undefined") {
        window.localStorage.removeItem(refreshNoticeKeyFor(propertyId));
        const dismissedAt = Date.now();
        window.localStorage.setItem(refreshNoticeDismissKeyFor(propertyId), String(dismissedAt));
        setDismissedServerRefreshAt(dismissedAt);
      }
    } catch {}
  }, [propertyId]);
  const formatRefreshNoticeTime = useCallback((value: number) => {
    if (!Number.isFinite(value)) return "unknown time";
    try {
      return new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return new Date(value).toLocaleString();
    }
  }, []);
  const recordLostRefreshTracking = useCallback(() => {
    if (lostProgressRecordedRef.current) return;
    lostProgressRecordedRef.current = true;
    const previous = refreshProgressRef.current;
    setMarketRatesRefreshing(false);
    setRefreshStartedAt(null);
    setRefreshProgress({
      phase: "error",
      percent: previous?.percent ?? 100,
      label: "Refresh tracking interrupted",
      error: REFRESH_TRACKING_LOST_MESSAGE,
      startedAt: previous?.startedAt,
      progressDone: previous?.progressDone,
      progressTotal: previous?.progressTotal,
      progressCurrent: previous?.progressCurrent,
      progressWindowLabel: previous?.progressWindowLabel,
      progressWindowStartedAt: previous?.progressWindowStartedAt,
      progressSubDone: previous?.progressSubDone,
      progressSubTotal: previous?.progressSubTotal,
      progressSubLabel: previous?.progressSubLabel,
      progressSubChannel: previous?.progressSubChannel,
      progressSubBedrooms: previous?.progressSubBedrooms,
      progressSubStartedAt: previous?.progressSubStartedAt,
      lastTickAt: previous?.lastTickAt,
      daemonOnline: previous?.daemonOnline,
      daemonLastPollAgeMs: previous?.daemonLastPollAgeMs,
      warnings: previous?.warnings,
    });
    recordRefreshNotice({
      status: "error",
      finishedAt: Date.now(),
      startedAt: previous?.startedAt,
      label: "Refresh tracking interrupted",
      error: REFRESH_TRACKING_LOST_MESSAGE,
    });
  }, [recordRefreshNotice]);
  const reloadMarketRates = useCallback(async () => {
    try {
      const r = await fetch("/api/property/market-rates");
      if (!r.ok) return;
      const rates = (await r.json()) as LivePropertyMarketRateInput[];
      if (Array.isArray(rates)) {
        setLivePropertyMarketRates(rates);
        setMarketRatesVersion((v) => v + 1);
      }
    } catch (e: any) {
      console.warn(`[GuestyListingBuilder] market-rates fetch failed: ${e?.message}`);
    }
  }, []);
  useEffect(() => {
    void reloadMarketRates();
  }, [reloadMarketRates]);
  const reloadPricingLogs = useCallback(async () => {
    if (!propertyId) return;
    setPricingLogsLoading(true);
    try {
      const r = await fetch(`/api/pricing/update-logs?propertyId=${propertyId}&limit=25`, { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json().catch(() => ({}));
      setPricingUpdateLogs(Array.isArray(data?.logs) ? data.logs : []);
    } catch (e: any) {
      console.warn(`[GuestyListingBuilder] pricing logs fetch failed: ${e?.message}`);
    } finally {
      setPricingLogsLoading(false);
    }
  }, [propertyId]);
  useEffect(() => {
    void reloadPricingLogs();
  }, [reloadPricingLogs, marketRatesVersion]);
  type MarketRefreshProgressRead =
    | { kind: "active"; progress: MarketRefreshProgress }
    | { kind: "missing" }
    | { kind: "failed"; message: string };
  const readServerRefreshProgress = useCallback(async (): Promise<MarketRefreshProgressRead> => {
    if (!propertyId) return { kind: "missing" };
    const r = await fetch(`/api/property/${propertyId}/refresh-progress`, { cache: "no-store" });
    if (r.status === 404) return { kind: "missing" };
    if (!r.ok) return { kind: "failed", message: `HTTP ${r.status}` };
    const p = await r.json() as MarketRefreshProgress;
    const next: MarketRefreshProgress = {
      phase: String(p.phase ?? ""),
      percent: Number.isFinite(p.percent) ? p.percent : 0,
      label: String(p.label ?? ""),
      startedAt: typeof p.startedAt === "number" ? p.startedAt : undefined,
      error: typeof p.error === "string" ? p.error : undefined,
      progressDone: typeof p.progressDone === "number" ? p.progressDone : undefined,
      progressTotal: typeof p.progressTotal === "number" ? p.progressTotal : undefined,
      progressCurrent: typeof p.progressCurrent === "number" ? p.progressCurrent : undefined,
      progressWindowLabel: typeof p.progressWindowLabel === "string" ? p.progressWindowLabel : undefined,
      progressWindowStartedAt: typeof p.progressWindowStartedAt === "number" ? p.progressWindowStartedAt : undefined,
      progressSubDone: typeof p.progressSubDone === "number" ? p.progressSubDone : undefined,
      progressSubTotal: typeof p.progressSubTotal === "number" ? p.progressSubTotal : undefined,
      progressSubLabel: typeof p.progressSubLabel === "string" ? p.progressSubLabel : undefined,
      progressSubChannel: p.progressSubChannel === "airbnb" || p.progressSubChannel === "vrbo" || p.progressSubChannel === "booking" || p.progressSubChannel === "pm" ? p.progressSubChannel : undefined,
      progressSubBedrooms: typeof p.progressSubBedrooms === "number" ? p.progressSubBedrooms : undefined,
      progressSubStartedAt: typeof p.progressSubStartedAt === "number" ? p.progressSubStartedAt : undefined,
      lastTickAt: typeof p.lastTickAt === "number" ? p.lastTickAt : undefined,
      daemonOnline: typeof p.daemonOnline === "boolean" ? p.daemonOnline : undefined,
      daemonLastPollAgeMs: typeof p.daemonLastPollAgeMs === "number" ? p.daemonLastPollAgeMs : null,
      warnings: Array.isArray(p.warnings) ? p.warnings : undefined,
    };
    setRefreshProgress(next);
    return { kind: "active", progress: next };
  }, [propertyId]);
  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    const poll = async () => {
      const result = await readServerRefreshProgress().catch((e: any) => ({ kind: "failed" as const, message: e?.message ?? "Progress check failed" }));
      if (cancelled) return;
      if (result.kind === "missing") {
        if (activeMarketPricingQueueJobRef.current) return;
        const localProgress = refreshProgressRef.current;
        const hadRunningLocalRefresh =
          marketRatesRefreshingRef.current ||
          (localProgress != null && localProgress.phase !== "done" && localProgress.phase !== "error");
        if (hadRunningLocalRefresh) {
          missingProgressPollsRef.current += 1;
          if (missingProgressPollsRef.current >= 3) recordLostRefreshTracking();
        }
        return;
      }
      if (result.kind === "failed") return;
      missingProgressPollsRef.current = 0;
      lostProgressRecordedRef.current = false;
      const p = result.progress;
      const isTerminal = p.phase === "done" || p.phase === "error";
      if (isTerminal) {
        setMarketRatesRefreshing(false);
        setRefreshStartedAt(null);
        const terminalKey = `${propertyId}|${p.phase}|${p.startedAt ?? ""}|${p.error ?? ""}|${p.label ?? ""}`;
        if (handledTerminalProgressRef.current !== terminalKey) {
          handledTerminalProgressRef.current = terminalKey;
          recordRefreshNotice({
            status: p.phase === "error" ? "error" : "done",
            finishedAt: Date.now(),
            startedAt: p.startedAt,
            label: p.phase === "error"
              ? (p.label || "Pricing update failed")
              : "Pricing update finished",
            error: p.error,
          });
          if (p.phase === "done") {
            await reloadMarketRates();
            await reloadPricingLogs();
          }
        }
        return;
      }
      handledTerminalProgressRef.current = null;
      setRefreshNotice(null);
      setMarketRatesRefreshing(true);
      setRefreshStartedAt((current) => current ?? p.startedAt ?? Date.now());
    };
    void poll();
    const timer = window.setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [propertyId, readServerRefreshProgress, recordLostRefreshTracking, recordRefreshNotice, reloadMarketRates, reloadPricingLogs]);

  const refreshThisPropertyMarketRates = useCallback(async () => {
    if (!propertyId || marketRatesRefreshing) return;
    const startedAt = Date.now();
    missingProgressPollsRef.current = 0;
    lostProgressRecordedRef.current = false;
    setMarketRatesRefreshing(true);
    setRefreshNotice(null);
    setRefreshStartedAt(startedAt);
    setRefreshProgress({ phase: "starting", percent: 1, label: "Running SearchAPI Airbnb seasonal pricing…", startedAt });

    try {
      const controller = new AbortController();
      refreshAbortRef.current = controller;
      const queuedJob = await queueMarketPricingRefresh();
      const jobId = queuedJob?.id;
      if (!jobId) throw new Error("Market pricing queue did not return a job id.");
      activeMarketPricingQueueJobRef.current = jobId;
      setRefreshProgress({
        phase: "queued",
        percent: 5,
        label: "Queued SearchAPI Airbnb P40 pricing update; Guesty base-rate push will run after refresh",
        startedAt,
        lastTickAt: Date.now(),
      });

      const deadline = Date.now() + 4 * 60 * 60 * 1000;
      while (Date.now() < deadline) {
        if (controller.signal.aborted) throw Object.assign(new Error("Cancelled by operator"), { name: "AbortError" });
        const r = await fetch(`/api/pricing/bulk-refresh/${jobId}`, { signal: controller.signal });
        const data = await r.json().catch(() => ({} as Record<string, any>));
        if (!r.ok || data?.ok === false || !data?.job) {
          throw new Error(data?.error || `Market pricing queue status failed with HTTP ${r.status}`);
        }
        const job = data.job as {
          status: string;
          completed: number;
          total: number;
          failed: number;
          cancelled: number;
          items?: Array<{
            propertyId: number;
            status: string;
            progress?: { phase?: string; percent?: number; label?: string } | null;
            error?: string | null;
            heartbeatAt?: string | null;
            startedAt?: string | null;
          }>;
        };
        const item = job.items?.find((candidate) => candidate.propertyId === propertyId) ?? job.items?.[0];
        const queuePercent = job.total > 0 ? Math.round((Math.max(0, job.completed) / job.total) * 100) : 5;
        const itemPercent = typeof item?.progress?.percent === "number" ? item.progress.percent : queuePercent;
        const heartbeatMs = item?.heartbeatAt ? Date.parse(item.heartbeatAt) : Date.now();
        setRefreshProgress({
          phase: item?.progress?.phase || item?.status || job.status || "running",
          percent: Math.max(5, Math.min(100, itemPercent)),
          label: item?.progress?.label || `Bulk market pricing queue ${job.completed}/${job.total} complete`,
          startedAt,
          lastTickAt: Number.isFinite(heartbeatMs) ? heartbeatMs : Date.now(),
        });
        if (item?.status === "completed") break;
        if (item?.status === "failed") throw new Error(item.error || "Market pricing queue item failed");
        if (item?.status === "cancelled" || job.status === "cancelled") {
          throw Object.assign(new Error("Cancelled by operator"), { name: "AbortError" });
        }
        if (job.status === "failed") throw new Error("Market pricing queue failed");
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
      }
      if (Date.now() >= deadline) throw new Error("Market pricing queue is still running after 4 hours. You can refresh the page later to load any completed rates.");
      setLiveSnapshot(null);
      await reloadMarketRates();
      await reloadPricingLogs();
      recordRefreshNotice({
        status: "done",
        finishedAt: Date.now(),
        startedAt,
        label: "Pricing update finished",
      });
      // Persistent green-check confirmation — only goes away when the
      // user clicks the X (PR #305). Default Radix duration auto-
      // dismisses at 5s; Infinity keeps it open until manual dismiss.
      // The check goes in `description` (not `title`) because Radix
      // Root extends HTMLAttributes whose `title: string` collapses
      // the union back to string-only.
      toast({
        duration: Infinity,
        title: "Market rates refreshed",
        description: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#16a34a"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Airbnb SearchAPI pricing basis updated
          </span>
        ),
      });
    } catch (e: any) {
      // AbortError = operator cancelled, distinct copy.
      if (e?.name === "AbortError") {
        setRefreshProgress({ phase: "error", percent: 100, label: "Refresh cancelled", error: "Cancelled by operator", startedAt });
        recordRefreshNotice({
          status: "error",
          finishedAt: Date.now(),
          startedAt,
          label: "Pricing update cancelled",
          error: "Cancelled by operator",
        });
        toast({ title: "Refresh cancelled", description: "Pricing update was cancelled." });
      } else {
        setRefreshProgress({ phase: "error", percent: 100, label: "Refresh failed", error: e?.message, startedAt });
        recordRefreshNotice({
          status: "error",
          finishedAt: Date.now(),
          startedAt,
          label: "Pricing update failed",
          error: e?.message,
        });
        toast({ title: "Refresh failed", description: e?.message, variant: "destructive" });
      }
    } finally {
      activeMarketPricingQueueJobRef.current = null;
      refreshAbortRef.current = null;
      setRefreshStartedAt(null);
      setMarketRatesRefreshing(false);
    }
  }, [propertyId, marketRatesRefreshing, queueMarketPricingRefresh, recordRefreshNotice, reloadMarketRates, reloadPricingLogs, toast]);

  // Per-bedroom snapshot of the market rate as it was BEFORE the most recent
  // refresh, so the seasonal table can render an old → new diff per month.
  // pricing_update_logs are written once per bedroom per market-rate refresh
  // (the only writer) newest-first, and each carries calendarJson = that run's
  // full per-month medianNightly map. The FIRST log per bedroom is the current
  // run; the SECOND is the immediately-prior state we diff against.
  const priorMonthlyByBedroom = useMemo(() => {
    const seenCurrent = new Set<number>();
    const prior = new Map<number, Record<string, any>>();
    for (const log of pricingUpdateLogs) {
      const br = Number(log.bedrooms);
      if (!Number.isFinite(br)) continue;
      if (!seenCurrent.has(br)) { seenCurrent.add(br); continue; } // skip the current (latest) run
      if (prior.has(br)) continue;                                  // keep only the immediately-prior run
      if (log.calendarJson && typeof log.calendarJson === "object") prior.set(br, log.calendarJson);
    }
    return prior;
  }, [pricingUpdateLogs]);

  // ── Async Guesty rate-push status (unified "Push … & Pricing" button) ──
  // Restore the last/in-flight status for the selected property so it survives
  // a builder remount or page reload while the cloud job keeps running.
  useEffect(() => {
    if (!propertyId || typeof window === "undefined") {
      setPricingPushStatus(null);
      return;
    }
    try {
      const raw = window.localStorage.getItem(pricingPushStatusKeyFor(propertyId));
      if (!raw) {
        setPricingPushStatus(null);
        return;
      }
      const parsed = JSON.parse(raw) as PricingPushStatus;
      setPricingPushStatus(parsed && typeof parsed.jobId === "string" ? parsed : null);
    } catch {
      setPricingPushStatus(null);
    }
  }, [propertyId]);

  const dismissPricingPushStatus = useCallback(() => {
    setPricingPushStatus(null);
    try {
      if (propertyId && typeof window !== "undefined") {
        window.localStorage.removeItem(pricingPushStatusKeyFor(propertyId));
      }
    } catch {
      // advisory only
    }
  }, [propertyId]);

  // Poll the queued /api/pricing/bulk-refresh job until the Guesty rate push
  // terminates. Re-subscribes only on jobId / status-bucket / property change
  // (the in-run "running" → "running" updates keep the same status string so
  // the interval is not torn down each tick); the top guard makes a restored
  // TERMINAL status a no-op. Bulk-pricing jobs are DB-durable, so a 404 means
  // a genuinely unknown job, not a redeploy gap.
  useEffect(() => {
    const jobId = pricingPushStatus?.jobId;
    const startedAt = pricingPushStatus?.startedAt ?? Date.now();
    if (!jobId || !propertyId) return;
    if (
      pricingPushStatus &&
      (pricingPushStatus.status === "completed" ||
        pricingPushStatus.status === "failed" ||
        pricingPushStatus.status === "cancelled")
    ) {
      return;
    }
    let stopped = false;
    let misses = 0;
    const deadline = startedAt + 4 * 60 * 60 * 1000;
    const persist = (next: PricingPushStatus) => {
      try {
        window.localStorage.setItem(pricingPushStatusKeyFor(propertyId), JSON.stringify(next));
      } catch {
        // advisory only
      }
    };
    const apply = (next: PricingPushStatus) => {
      setPricingPushStatus(next);
      persist(next);
    };
    const poll = async () => {
      if (stopped) return;
      if (Date.now() > deadline) {
        apply({
          jobId,
          startedAt,
          status: "failed",
          phase: "error",
          percent: 100,
          label: "Still running after 4h — reopen the builder later to confirm the Guesty rate push.",
          finishedAt: Date.now(),
        });
        return;
      }
      let resp: Response;
      let data: any;
      try {
        resp = await fetch(`/api/pricing/bulk-refresh/${jobId}`);
        data = await resp.json().catch(() => ({}));
      } catch {
        return; // transient network blip — retry next tick
      }
      if (stopped) return;
      if (!resp.ok || data?.ok === false || !data?.job) {
        misses += 1;
        if (misses >= 3) {
          apply({
            jobId,
            startedAt,
            status: "failed",
            phase: "error",
            percent: 100,
            label: "Pricing job status could not be read. Re-run the push to confirm the Guesty rates.",
            finishedAt: Date.now(),
          });
        }
        return;
      }
      misses = 0;
      const job = data.job as {
        status?: string;
        completed?: number;
        total?: number;
        items?: Array<{
          propertyId?: number;
          status?: string;
          progress?: { phase?: string; percent?: number; label?: string } | null;
          error?: string | null;
        }>;
      };
      const items = Array.isArray(job.items) ? job.items : [];
      const item = items.find((c) => c.propertyId === propertyId) ?? items[0];
      const itemStatus = String(item?.status || job.status || "running");
      const isCompleted = itemStatus === "completed";
      const isFailed = itemStatus === "failed" || job.status === "failed";
      const isCancelled = itemStatus === "cancelled" || job.status === "cancelled";
      const total = typeof job.total === "number" ? job.total : 0;
      const completed = typeof job.completed === "number" ? job.completed : 0;
      const queuePercent = total > 0 ? Math.round((Math.max(0, completed) / total) * 100) : 5;
      const itemPercent = typeof item?.progress?.percent === "number" ? item.progress.percent : queuePercent;
      const label =
        item?.progress?.label ||
        (isCompleted ? "Marked-up Guesty rates pushed" : `Market pricing ${completed}/${total} complete`);
      const next: PricingPushStatus = {
        jobId,
        startedAt,
        status: isCompleted ? "completed" : isFailed ? "failed" : isCancelled ? "cancelled" : "running",
        phase: String(item?.progress?.phase || item?.status || job.status || "running"),
        percent: Math.max(0, Math.min(100, itemPercent)),
        label,
        error: item?.error || undefined,
        finishedAt: isCompleted || isFailed || isCancelled ? Date.now() : undefined,
      };
      apply(next);
      if (isCompleted) {
        recordDataPush("pricing", "success", label);
        void reloadMarketRates();
        void reloadPricingLogs();
        stopped = true;
      } else if (isFailed || isCancelled) {
        recordDataPush("pricing", "error", item?.error || label);
        stopped = true;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pricingPushStatus?.jobId, pricingPushStatus?.status, pricingPushStatus?.startedAt, propertyId, recordDataPush, reloadMarketRates, reloadPricingLogs]);

  // Aggregate monthly rates across all units for the 24-month seasonal table
  // Target markup margin (slider in the Guesty rate-push card, persisted to the
  // scanner schedule). Declared HERE — ahead of the seasonalMonths memo that
  // consumes it — so the "Sheet Base / Night" target recomputes when the
  // operator changes the markup (e.g. 20% -> 10%).
  const [targetMarginPct, setTargetMarginPct] = useState(MIN_PROFIT_MARGIN * 100);
  const pricingMarginTarget = targetMarginPct / 100;
  const seasonalMonths = useMemo(() => {
    if (!propertyId) return [];
    const propPricing = getPropertyPricing(propertyId);
    if (!propPricing || !propPricing.units.length) return [];
    return propPricing.units[0].monthlyRates.map((row) => {
      const monthlySampleRates = propPricing.units.map((u) => {
        const sample = getLiveBuyIn(propertyId, u.bedrooms)?.monthlyRates[row.yearMonth]?.medianNightly;
        return typeof sample === "number" && Number.isFinite(sample) && sample > 0 ? sample : null;
      });
      const monthlySampleComplete = monthlySampleRates.every((n) => n != null);
      const monthlySampleTotal = monthlySampleComplete
        ? Math.round(monthlySampleRates.reduce((s, n) => s + (n ?? 0), 0))
        : null;
      const totalBuyIn = propPricing.units.reduce(
        (s, u) => s + getBuyInRate(u.community, u.bedrooms, propertyId, row.season, row.yearMonth),
        0,
      );
      // Buy-in (= the market rate the queue rewrites) as it was BEFORE the most
      // recent refresh, summed across units. Null unless EVERY unit has a prior
      // value for this month, so the old → new diff is apples-to-apples.
      const previousUnitBuyIns = propPricing.units.map((u) => {
        const v = Number((priorMonthlyByBedroom.get(u.bedrooms)?.[row.yearMonth] as any)?.medianNightly);
        return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
      });
      const previousBuyInTotal = previousUnitBuyIns.every((n) => n != null)
        ? previousUnitBuyIns.reduce((s, n) => s + (n ?? 0), 0)
        : null;
      return {
        month: row.month,
        year: row.year,
        yearMonth: row.yearMonth,
        season: row.season,
        totalBuyIn,
        // Sheet base = buy-in × (1 + TARGET MARGIN), summed-then-rounded —
        // IDENTICAL to the marked-up Guesty push (computeSeasonalRates uses
        // cleanBaseRateFromBuyIn(totalBuyIn, m)). Tracking pricingMarginTarget
        // here is what makes "Sheet Base / Night" follow the markup slider so
        // the table stops showing a phantom "drift vs sheet" once the operator
        // changes the markup (e.g. 20% -> 10%).
        totalSell: cleanBaseRateFromBuyIn(totalBuyIn, pricingMarginTarget),
        monthlySampleTotal,
        previousBuyInTotal,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, marketRatesVersion, priorMonthlyByBedroom, pricingMarginTarget]);
  const displayedBasePrice = seasonalMonths[0]?.totalSell ?? pricing?.basePrice ?? null;

  // Per-bedroom live-buy-in summary for the Pricing tab header. Pulls
  // straight from the module-level cache so it reflects whatever
  // setLivePropertyMarketRates wrote on the most recent reload.
  const liveBuyInSummary = useMemo(() => {
    if (!propertyId) return [];
    const propPricing = getPropertyPricing(propertyId);
    if (!propPricing) return [];
    const seenBR = new Set<number>();
    const bedrooms: number[] = [];
    for (const u of propPricing.units) {
      if (!seenBR.has(u.bedrooms)) { seenBR.add(u.bedrooms); bedrooms.push(u.bedrooms); }
    }
    bedrooms.sort((a, b) => a - b);
    return bedrooms.map((br) => ({
      bedrooms: br,
      community: propPricing.units.find((u) => u.bedrooms === br)?.community ?? propPricing.units[0]?.community ?? "",
      live: getLiveBuyIn(propertyId, br),
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, marketRatesVersion]);

  const latestServerMarketRateNotice = useMemo<MarketRefreshNotice | null>(() => {
    if (!propertyId) return null;
    let latest = 0;
    for (const entry of liveBuyInSummary) {
      const ms = entry.live?.refreshedAt ? Date.parse(entry.live.refreshedAt) : NaN;
      if (Number.isFinite(ms) && ms > latest) latest = ms;
    }
    if (latest <= 0) return null;
    return {
      propertyId,
      status: "done",
      finishedAt: latest,
      label: "Hybrid pricing basis saved from the server queue",
    };
  }, [propertyId, liveBuyInSummary]);

  const effectiveRefreshNotice = useMemo<MarketRefreshNotice | null>(() => {
    const serverNotice = latestServerMarketRateNotice &&
      latestServerMarketRateNotice.finishedAt > dismissedServerRefreshAt
      ? latestServerMarketRateNotice
      : null;
    if (!serverNotice) return refreshNotice;
    if (!refreshNotice) return serverNotice;
    return serverNotice.finishedAt > refreshNotice.finishedAt
      ? serverNotice
      : refreshNotice;
  }, [dismissedServerRefreshAt, latestServerMarketRateNotice, refreshNotice]);

  // ── Guesty-confirmed monthly rates + channel-aware profit floor ──
  // Fetches what Guesty is charging per month so we can compare against
  // our pricing sheet at a glance (never overlay computed "intent" rates).
  const [guestyRatesByMonth, setGuestyRatesByMonth] = useState<Record<string, GuestyMonthlyRate>>({});
  const [guestyRatesLoading, setGuestyRatesLoading] = useState(false);
  const [guestyRatesError, setGuestyRatesError] = useState<string | null>(null);
  // Live market refresh state (from the new /refresh-market-rates endpoint)
  const [liveMarket, setLiveMarket] = useState<any>(null);
  const [marketRefreshing, setMarketRefreshing] = useState(false);
  const [scannerSchedule, setScannerSchedule] = useState<ScannerScheduleSnapshot | null>(null);

  const refreshScannerSchedule = useCallback(async () => {
    if (!propertyId) {
      setScannerSchedule(null);
      return;
    }
    await fetch(`/api/availability/schedule/${propertyId}`)
      .then((r) => r.json())
      .then((data: any) => {
        const nextSchedule = (data?.schedule ?? null) as ScannerScheduleSnapshot | null;
        setScannerSchedule(nextSchedule);
        const margin = Number.parseFloat(String(data?.schedule?.targetMargin ?? ""));
        if (Number.isFinite(margin)) {
          setTargetMarginPct(Math.max(-99, Math.min(100, margin * 100)));
        }
      })
      .catch(() => {});
  }, [propertyId]);

  useEffect(() => {
    void refreshScannerSchedule();
  }, [refreshScannerSchedule]);

  useEffect(() => {
    if (!propertyId) return;
    const timer = window.setTimeout(() => {
      void fetch(`/api/availability/schedule/${propertyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetMargin: targetMarginPct / 100 }),
      }).catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [propertyId, targetMarginPct]);

  const refetchGuestyRates = useCallback(() => {
    if (!propertyId) return;
    setGuestyRatesLoading(true);
    setGuestyRatesError(null);
    const qs = new URLSearchParams({ months: "24" });
    if (selectedId) qs.set("listingId", selectedId);
    fetch(`/api/builder/guesty-monthly-rates/${propertyId}?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data: any) => {
        const byMonth: Record<string, GuestyMonthlyRate> = {};
        for (const m of data.months ?? []) {
          byMonth[m.yearMonth] = { avgRate: m.avgRate, minRate: m.minRate, maxRate: m.maxRate, days: m.days };
        }
        setGuestyRatesByMonth(byMonth);
      })
      .catch((e: any) => {
        setGuestyRatesError(e.message || "Failed to fetch Guesty rates");
      })
      .finally(() => {
        setGuestyRatesLoading(false);
      });
  }, [propertyId, selectedId]);

  useEffect(() => {
    refetchGuestyRates();
  }, [refetchGuestyRates]);

  useEffect(() => {
    if (!propertyId || marketRatesVersion < 1) return;
    refetchGuestyRates();
    const t = window.setTimeout(refetchGuestyRates, 6000);
    return () => window.clearTimeout(t);
  }, [marketRatesVersion, propertyId, refetchGuestyRates]);

  // ── Market comparables ─────────────────────────────────────────────────
  // Per-season distribution of area rates for properties with the SAME
  // total bedroom count. Used to flag rows where our rate sits above the
  // local villa/bundle market — i.e. where a guest can find something
  // equivalent cheaper nearby and won't book us.
  type SeasonStats = {
    n: number;
    enough: boolean;
    min: number | null;
    max: number | null;
    p25: number | null;
    p40: number | null;
    median: number | null;
    p75: number | null;
    p90: number | null;
  };
  type CompSample = { title: string; url: string; bedrooms: number | null; nightlyRate: number; tier?: string; propertyType?: string };
  type MarketSeason = {
    season: "LOW" | "HIGH" | "HOLIDAY";
    checkIn: string;
    checkOut: string;
    // Split by property type so the row badge can compare against a real
    // apples-to-apples peer (condo) and show the villa tier separately
    // as the premium ceiling.
    condo: { stats: SeasonStats; sample: CompSample[] };
    villa: { stats: SeasonStats; sample: CompSample[] };
    all:   { stats: SeasonStats; sample: CompSample[] };
    error?: string;
    rawCount?: number;
    qualifyingCount?: number;
  };
  const [marketComps, setMarketComps] = useState<{
    totalBR: number;
    seasons: Record<"LOW" | "HIGH" | "HOLIDAY", MarketSeason>;
  } | null>(null);
  const [marketCompsLoading, setMarketCompsLoading] = useState(false);

  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    setMarketCompsLoading(true);
    setMarketComps(null);
    fetch(`/api/builder/market-comps/${propertyId}?nights=7`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then((data: any) => {
        if (cancelled) return;
        setMarketComps({ totalBR: data.totalBR, seasons: data.seasons });
      })
      .catch(() => {
        // Market comps are advisory — a failure shouldn't block the
        // pricing tab. Just leave the column blank.
      })
      .finally(() => { if (!cancelled) setMarketCompsLoading(false); });
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

        {/* ── Selector ──────────────────────────────────────────── */}
        <div className="glb-listing-bar">
          <div className="glb-section-label">Existing Guesty Listings</div>
          <div className="glb-row glb-listing-row">
            <select
              className="glb-sel"
              value={selectedId}
              onChange={(e) => {
                const newId = e.target.value;
                setGuestyLiveAmenities(null);
                // If the picked listing maps to a property that isn't the
                // one currently in the URL, navigate there — otherwise the
                // dropdown only retargets the push button while the
                // property-keyed tabs (pricing schedule, bedding, photos)
                // keep showing the previous property's data, which is
                // exactly the bug the operator hit when switching from
                // an unmapped draft to a Hawaii listing. The auto-select effect
                // above will set selectedId on the new page.
                if (newId) {
                  const mapped = propertyMap.find((m) => m.guestyListingId === newId);
                  if (mapped && mapped.propertyId !== propertyId) {
                    navigate(`/builder/${mapped.propertyId}`);
                    return;
                  }
                }
                setSelectedId(newId);
                if (newId && typeof propertyId === "number" && propertyId < 0) {
                  rememberPropertyMap(propertyId, newId);
                  fetch("/api/guesty-property-map", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ propertyId, guestyListingId: newId }),
                  }).catch(() => { /* non-fatal; selection still works for this page */ });
                }
              }}
              data-testid="select-guesty-listing"
              disabled={conn !== "connected"}
            >
              <option value="">— Select an existing listing to view or update —</option>
              {listingOptions.map((l) => {
                const id = guestyListingId(l);
                if (!id) return null;
                return <option key={id} value={id}>{guestyListingOptionLabel(l)}</option>;
              })}
            </select>
          </div>
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
          <BuilderSectionErrorBoundary
            resetKey={`channel-status:${selectedId}`}
            fallback={
              <div className="glb-error-banner" style={{ marginBottom: 20 }}>
                Channel status could not render for this Guesty listing, but the builder is still usable.
              </div>
            }
          >
          <>
            <div className="glb-section-label">Channel Status</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "-4px 0 12px" }}>
              <span className={`glb-badge ${channelStatus?.isListed ? "live" : "not-live"}`}>
                {!loadingChannels && <span className="glb-badge-dot" />}
                {loadingChannels ? "Checking Guesty…" : channelStatus?.isListed ? "Guesty Bookable" : "Guesty Not Bookable"}
              </span>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                This is Guesty's global <code>isListed</code> status. Channel cards below show whether each OTA is connected and live.
              </span>
            </div>
            <div className="glb-channels">
              {(["airbnb", "vrbo", "bookingCom"] as const).map((ch) => {
                const LABELS = { airbnb: "Airbnb", vrbo: "VRBO", bookingCom: "Booking.com" };
                const ICONS = { airbnb: "🏠", vrbo: "🏖️", bookingCom: "🔵" };
                const info = channelStatus?.[ch];
                const isLive = info?.live;
                const isConnected = info?.connected;
                // Guesty reports the last sync operation's result in `status`.
                // "FAILED" means the listing still exists on the channel but
                // Guesty's most recent push errored out — the page is live
                // but Guesty and the channel are out of sync until the user
                // re-publishes from Guesty's Distribution page directly
                // (our Push Updates writes data to Guesty but does NOT
                // retry Guesty's queued channel sync, which is what has
                // actually failed).
                const lastSyncFailed = isLive && info?.status === "FAILED";
                const cardClass = `glb-ch ${isLive ? "live" : isConnected ? "dead" : ""}`;
                const badgeClass = `glb-badge ${isLive ? (lastSyncFailed ? "live-warn" : "live") : isConnected ? "not-live" : "no-account"}`;
                const badgeLabel = loadingChannels
                  ? "…"
                  : isLive
                    ? (lastSyncFailed ? "LIVE ⚠" : "LIVE")
                    : isConnected ? "Not Live" : "No Account";
                const badgeTitle = lastSyncFailed
                  ? "Listing is on the channel, but Guesty's last sync to Airbnb failed. Fix: open app.guesty.com → this listing → Distribution → Airbnb row → click PUBLISH TO CHANNEL to retry. Push Updates here won't do it."
                  : undefined;
                // Click-to-open: when the listing is live AND we have a
                // public URL (Airbnb: constructed from ID; VRBO/Booking:
                // only when Guesty stamped listingUrl), the whole card
                // opens the channel's public listing page in a new tab.
                // Uses onClick on a <div> rather than wrapping in <a>
                // because the Airbnb card has a nested <button> for the
                // compliance push — <button> inside <a> is invalid HTML
                // and the click conflict would fire both handlers. The
                // compliance button calls stopPropagation so clicks on
                // it don't bubble up and trigger the card navigation.
                const publicUrl = isLive ? info?.publicUrl ?? null : null;
                const interactive = !!publicUrl;
                const openChannel = () => {
                  if (publicUrl) window.open(publicUrl, "_blank", "noopener,noreferrer");
                };
                return (
                  <div
                    key={ch}
                    className={cardClass}
                    data-testid={`channel-card-${ch}`}
                    onClick={interactive ? openChannel : undefined}
                    onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openChannel(); } } : undefined}
                    role={interactive ? "link" : undefined}
                    tabIndex={interactive ? 0 : undefined}
                    style={interactive ? { cursor: "pointer" } : undefined}
                    title={interactive ? `Open ${LABELS[ch]} listing in a new tab` : undefined}
                  >
                    <div className="glb-ch-hdr">
                      <span className="glb-ch-name">
                        <span className="glb-ch-icon">{ICONS[ch]}</span>
                        {LABELS[ch]}
                      </span>
                      <span className={badgeClass} title={badgeTitle}>
                        {!loadingChannels && <span className="glb-badge-dot" />}
                        {badgeLabel}
                      </span>
                    </div>
                    {info?.id && <div className="glb-ch-meta">ID: {info.id}</div>}
                    {info?.status && <div className="glb-ch-meta">Status: {info.status}</div>}
                    {interactive && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openChannel();
                        }}
                        style={{
                          marginTop: 8,
                          width: "100%",
                          fontSize: 12,
                          padding: "4px 10px",
                          borderRadius: 4,
                          border: "1px solid #93c5fd",
                          background: "#eff6ff",
                          color: "#1d4ed8",
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                        data-testid={`btn-view-public-url-${ch}`}
                      >
                        ↗ View public URL
                      </button>
                    )}
                    {isLive && !interactive && (
                      <div className="glb-ch-meta" style={{ color: "#9ca3af", fontSize: 10, marginTop: 4 }}>
                        Public URL not yet in Guesty payload — check the channel dashboard.
                      </div>
                    )}

                    {/* Publish-to-channel button. Hits
                        /api/admin/guesty/publish-channel which drives
                        Guesty's Distribution page and clicks the publish-
                        like button scoped to this channel's row. The
                        same backend click works for both:
                          * "Create listing" — channel is connected (OAuth
                            done) but not yet listed → click creates the
                            listing on the channel
                          * "Re-publish" — channel is already listed →
                            click pushes the latest Guesty state to the
                            channel (same as the manual PUBLISH TO CHANNEL
                            step the Airbnb compliance flow leaves to the
                            operator)
                        Hidden when no integration exists at all (`No
                        Account` state) because there's nothing to
                        publish — the operator needs to set up OAuth in
                        Guesty UI first. See AGENTS.md #29. */}
                    {false && isConnected && (() => {
                      const publishKey = `${selectedId}:${ch}`;
                      const publishBusy = publishStateByListingChannel[publishKey] === "busy";
                      const buttonLabel = isLive
                        ? `↑ Re-publish to ${LABELS[ch]}`
                        : `+ Create listing on ${LABELS[ch]}`;
                      const handlePublishChannel = async () => {
                        if (!selectedId) return;
                        setPublishStateByListingChannel((prev) => ({ ...prev, [publishKey]: "busy" }));
                        try {
                          const r = await fetch("/api/admin/guesty/publish-channel", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ listingId: selectedId, channel: ch }),
                          });
                          const data = await r.json();
                          if (!r.ok || !data.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
                          const clicked = !!data.clickResult?.clicked;
                          // The most useful screenshot for the operator
                          // is the post-click one — shows whether Guesty
                          // accepted the publish or surfaced an error
                          // toast.
                          const shotPath: string | null =
                            (typeof data.postClickShotUrl === "string" && data.postClickShotUrl) || null;
                          const shotSuffix = shotPath ? ` · Screenshot: ${window.location.origin}${shotPath}` : "";
                          toast({
                            title: clicked
                              ? `Clicked publish on ${LABELS[ch]}${data.modalConfirmed ? " + confirmed modal" : ""}`
                              : `Couldn't find a publish button for ${LABELS[ch]}`,
                            description: clicked
                              ? `Label: "${data.clickResult?.label ?? "?"}" · Scope: ${data.clickResult?.scope ?? "?"}.${shotSuffix}`
                              : `${data.clickResult?.reason ?? "no reason given"}. Verify the channel's OAuth is connected in Guesty's Distribution page.${shotSuffix}`,
                            variant: clicked ? "default" : "destructive",
                            duration: 20000,
                          });
                          refreshChannelStatus?.();
                        } catch (e: any) {
                          toast({ title: `Publish to ${LABELS[ch]} failed`, description: e.message, variant: "destructive" });
                        } finally {
                          setPublishStateByListingChannel((prev) => ({ ...prev, [publishKey]: "idle" }));
                        }
                      };
                      return (
                        <div style={{ marginTop: 8 }}>
                          <button
                            type="button"
                            onClick={(e) => {
                              // Channel cards become click-to-open-listing
                              // when live. Stop bubbling so this button
                              // doesn't also fire that handler.
                              e.stopPropagation();
                              handlePublishChannel();
                            }}
                            disabled={publishBusy}
                            style={{
                              fontSize: 12, padding: "4px 10px", borderRadius: 4,
                              border: "1px solid #16a34a",
                              background: publishBusy ? "#dcfce7" : "#f0fdf4",
                              color: "#14532d", cursor: publishBusy ? "wait" : "pointer", fontWeight: 500,
                              width: "100%",
                            }}
                            data-testid={`btn-publish-channel-${ch}`}
                            title={`Drive Guesty's Distribution page and click the publish-to-${LABELS[ch]} button. Same as the manual click in app.guesty.com → Distribution → ${LABELS[ch]} row.`}
                          >
                            {publishBusy ? `⏳ Driving Guesty…` : buttonLabel}
                          </button>
                        </div>
                      );
                    })()}

                    {/* Airbnb-only compliance sub-block. Appears once the listing
                        is live on Airbnb (so the regulations form page exists).
                        Three states: already-success (✓), regulation pending (button),
                        or no regulations object yet (button — likely brand-new listing). */}
                    {false && ch === "airbnb" && isLive && (() => {
                      const compliance = info?.compliance;
                      const isComplianceDone = compliance?.status === "success";
                      const complianceBusy = complianceStateByListing[selectedId] === "busy";
                      const handlePushCompliance = async () => {
                        if (!selectedId || !effectivePropertyData?.taxMapKey || !effectivePropertyData?.tatLicense) {
                          toast({ title: "Missing data", description: "Need both TMK and TAT to submit Airbnb compliance.", variant: "destructive" });
                          return;
                        }
                        setComplianceStateByListing((prev) => ({ ...prev, [selectedId]: "busy" }));
                        try {
                          const r = await fetch("/api/admin/airbnb/submit-compliance", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              listingId: info.id,  // Airbnb numeric ID, not Guesty ID
                              jurisdiction: compliance?.jurisdiction ?? "kauai_county_hawaii",
                              taxMapKey: effectivePropertyData.taxMapKey,
                              tatLicense: effectivePropertyData.tatLicense,
                            }),
                          });
                          const data = await r.json();
                          if (!r.ok || !data.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
                          const airbnbErrors: string[] = Array.isArray(data.errorMessages) ? data.errorMessages : [];
                          const screenshotUrl: string | null = typeof data.screenshotUrl === "string" ? data.screenshotUrl : null;
                          const shotSuffix = screenshotUrl ? ` · Screenshot: ${window.location.origin}${screenshotUrl}` : "";
                          // submissionComplete: Submit clicked on review page AND URL advanced
                          // advanced:           Next clicked on step 1 AND URL advanced
                          // Both false:         form filled but step 1 didn't advance
                          const fullySubmitted = !!data.submissionComplete;
                          const step1Only = !fullySubmitted && !!data.advanced;
                          // On success Guesty won't auto-sync the regulation back — the
                          // operator has to open Guesty's Distribution page and click
                          // PUBLISH TO CHANNEL on the Airbnb row. Without that, permits
                          // stay empty and the "Compliance not submitted" badge persists.
                          const republishReminder = fullySubmitted
                            ? " ⚠ NEXT STEP: open app.guesty.com → this listing → Distribution → Airbnb row → click PUBLISH TO CHANNEL. Guesty will NOT sync on its own."
                            : "";
                          toast({
                            title: fullySubmitted
                              ? "Airbnb compliance submitted — now re-publish from Guesty"
                              : step1Only
                                ? "Stuck on review page"
                                : "Compliance form filled",
                            description: fullySubmitted
                              ? `Both steps on Airbnb completed.${republishReminder}${shotSuffix}`
                              : step1Only
                                ? `Filled + advanced to Airbnb's review page, but Submit didn't finalize. Check the screenshot.${shotSuffix}`
                                : airbnbErrors.length > 0
                                  ? `Airbnb rejected the form: ${airbnbErrors.join(" · ")}${shotSuffix}`
                                  : `Submitted but page didn't advance — no visible Airbnb error captured. Final URL: ${data.finalUrl}${shotSuffix}`,
                            variant: fullySubmitted ? "default" : "destructive",
                            duration: 20000,
                          });
                          // Kick a channel-status refresh so the badge flips if the status updated.
                          refreshChannelStatus?.();
                        } catch (e: any) {
                          toast({ title: "Airbnb compliance failed", description: e.message, variant: "destructive" });
                        } finally {
                          setComplianceStateByListing((prev) => ({ ...prev, [selectedId]: "idle" }));
                        }
                      };
                      return (
                        <div className="glb-ch-compliance" style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed rgba(0,0,0,0.1)", fontSize: 12 }}>
                          {isComplianceDone ? (
                            <div style={{ color: "#16a34a", display: "flex", alignItems: "center", gap: 6 }}>
                              <span>✓</span>
                              <div>
                                <div style={{ fontWeight: 600 }}>Compliance on file</div>
                                <div style={{ fontSize: 11, color: "#6b7280" }}>
                                  {(compliance?.jurisdiction ?? "regulated jurisdiction").replace(/_/g, " ")}
                                  {compliance?.regulationType ? ` — ${compliance.regulationType}` : ""}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div style={{ color: "#b45309", fontWeight: 600, marginBottom: 6 }}>
                                ⚠ Compliance not submitted
                              </div>
                              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
                                Airbnb requires TMK + TAT for this listing's jurisdiction.
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  // Airbnb card becomes click-to-open-listing
                                  // when live. Stop bubbling so clicking this
                                  // button doesn't also fire that handler.
                                  e.stopPropagation();
                                  handlePushCompliance();
                                }}
                                disabled={complianceBusy || !effectivePropertyData?.taxMapKey || !effectivePropertyData?.tatLicense}
                                style={{
                                  fontSize: 12, padding: "4px 10px", borderRadius: 4,
                                  border: "1px solid #d97706", background: complianceBusy ? "#fef3c7" : "#fffbeb",
                                  color: "#92400e", cursor: complianceBusy ? "wait" : "pointer", fontWeight: 500,
                                }}
                                data-testid="btn-push-airbnb-compliance"
                              >
                                {complianceBusy ? "⏳ Submitting…" : "↗ Push Compliance to Airbnb"}
                              </button>
                              {/* Persistent reminder about the mandatory follow-up step.
                                  Airbnb's compliance submission succeeds on its own, but
                                  Guesty won't pull the new regulation state until the
                                  operator re-publishes from Guesty Distribution. Without
                                  this step the "Compliance not submitted" badge persists
                                  indefinitely. */}
                              <div style={{ marginTop: 8, fontSize: 10, color: "#92400e", lineHeight: 1.5, background: "#fef3c7", padding: "6px 8px", borderRadius: 4, border: "1px dashed #d97706" }}>
                                <div style={{ fontWeight: 600, marginBottom: 2 }}>After this succeeds — one more manual step</div>
                                Open <a href="https://app.guesty.com/" target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#92400e", textDecoration: "underline" }}>app.guesty.com</a> → this listing → Distribution → Airbnb row → click <strong>PUBLISH TO CHANNEL</strong>. Guesty won't re-sync on its own; this badge stays stuck until you do.
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* VRBO-only compliance sub-block. Sister to the Airbnb
                        one above, but the underlying mechanic differs:
                        Airbnb publishes a regulations form we drive
                        directly with Playwright; VRBO has no equivalent,
                        so /api/admin/guesty/submit-vrbo-compliance drives
                        Guesty's UI (Owners & License → Vrbo license
                        requirements → Edit → fill TMK/TAT/GET → Save),
                        then navigates to Distribution and triggers the
                        Publish-to-channel click on the VRBO row so Guesty
                        re-syncs to VRBO. Step 4 is the equivalent of
                        Airbnb's manual republish reminder being automated
                        for VRBO. See AGENTS.md #28. */}
                    {false && ch === "vrbo" && isLive && (() => {
                      // Persistent VRBO compliance state lives on the
                      // listing payload at channels.homeaway.{licenseNumber,
                      // taxId, parcelNumber}. getChannelStatus surfaces it
                      // as info.vrboLicense (null when nothing's set, else
                      // an object with each field independently nullable).
                      // We use that as the source of truth so the green
                      // check survives page reloads — the session-local
                      // "done" flag below is just a fast-path for the gap
                      // between "click Submit" and "next channel-status
                      // refresh lands".
                      const vrboLicense = info?.vrboLicense ?? null;
                      const expectedTat = effectivePropertyData?.tatLicense || null;
                      const expectedGet = effectivePropertyData?.getLicense || null;
                      const expectedTmk = effectivePropertyData?.taxMapKey || null;
                      // "Complete" = every field the property record has
                      // a value for is also set in Guesty. Property GET is
                      // optional, so if it's blank we don't require Guesty
                      // to have it either. Same logic the push endpoint
                      // uses (only writes fields the caller provided).
                      const guestyHasTat = !!vrboLicense?.licenseNumber;
                      const guestyHasTmk = !!vrboLicense?.parcelNumber;
                      const guestyHasGet = !!vrboLicense?.taxId;
                      const guestyHasAny = guestyHasTat || guestyHasTmk || guestyHasGet;
                      const guestyHasAllExpected =
                        (!expectedTat || guestyHasTat) &&
                        (!expectedTmk || guestyHasTmk) &&
                        (!expectedGet || guestyHasGet);
                      // "Stale" = Guesty has a value that doesn't match
                      // the property record. Distinct from "missing":
                      // missing is "we haven't pushed yet", stale is "we
                      // pushed something old and the property record has
                      // since changed".
                      const isStale = guestyHasAny && (
                        (!!expectedTat && guestyHasTat && vrboLicense?.licenseNumber !== expectedTat) ||
                        (!!expectedTmk && guestyHasTmk && vrboLicense?.parcelNumber !== expectedTmk) ||
                        (!!expectedGet && guestyHasGet && vrboLicense?.taxId !== expectedGet)
                      );
                      const localState = vrboComplianceStateByListing[selectedId] ?? "idle";
                      const isVrboBusy = localState === "busy";
                      // Show the "on file" state if either (a) we just
                      // submitted this session OR (b) Guesty already has
                      // every expected field AND nothing is stale.
                      const isVrboDone = localState === "done" || (guestyHasAllExpected && guestyHasAny && !isStale);
                      // Distinguish "Guesty has SOME data but not all /
                      // not current" from "Guesty has nothing at all" —
                      // they're different operator-facing prompts.
                      const needsUpdate = !isVrboDone && (isStale || (guestyHasAny && !guestyHasAllExpected));
                      const handlePushVrboCompliance = async () => {
                        if (!selectedId || !effectivePropertyData?.taxMapKey || !effectivePropertyData?.tatLicense) {
                          toast({ title: "Missing data", description: "Need both TMK and TAT to submit VRBO compliance.", variant: "destructive" });
                          return;
                        }
                        setVrboComplianceStateByListing((prev) => ({ ...prev, [selectedId]: "busy" }));
                        try {
                          const r = await fetch("/api/admin/guesty/submit-vrbo-compliance", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              // Server-side endpoint takes the GUESTY listing
                              // ID (24-char hex) — unlike Airbnb which takes
                              // the Airbnb numeric ID — because the
                              // automation drives Guesty's own URL space.
                              listingId: selectedId,
                              taxMapKey: effectivePropertyData.taxMapKey,
                              tatLicense: effectivePropertyData.tatLicense,
                              getLicense: effectivePropertyData.getLicense,
                            }),
                          });
                          const data = await r.json();
                          if (!r.ok || !data.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
                          // Surface the most-relevant screenshot URL so the
                          // operator can verify out-of-band — VRBO has no
                          // Guesty API round-trip that confirms the channel
                          // got the update.
                          const shotPath: string | null =
                            (typeof data.distributionShotUrl === "string" && data.distributionShotUrl) ||
                            (typeof data.postSaveShotUrl === "string" && data.postSaveShotUrl) ||
                            null;
                          const shotSuffix = shotPath ? ` · Final screenshot: ${window.location.origin}${shotPath}` : "";
                          const republished = !!data.republishResult?.clicked;
                          const fieldsFilled: number = data.fillResult?.filled?.length ?? 0;
                          toast({
                            title: republished
                              ? "VRBO compliance submitted + republished"
                              : "VRBO compliance saved (republish not confirmed)",
                            description: republished
                              ? `Filled ${fieldsFilled} field(s) in Guesty's VRBO license form, clicked Save, then triggered a republish to VRBO from Distribution.${shotSuffix}`
                              : `Filled ${fieldsFilled} field(s) and saved, but the Distribution republish button wasn't found. Open app.guesty.com → this listing → Distribution → VRBO row → click PUBLISH TO CHANNEL manually.${shotSuffix}`,
                            variant: "default",
                            duration: 20000,
                          });
                          setVrboComplianceStateByListing((prev) => ({ ...prev, [selectedId]: "done" }));
                          refreshChannelStatus?.();
                        } catch (e: any) {
                          // Surface the failure for long enough that the
                          // operator actually catches it — Playwright runs
                          // for 10-30s, so the default 3-5s toast often
                          // disappears between when they click and when
                          // they look back at the page. If the error looks
                          // like a Guesty login failure (stale cookies →
                          // Google SSO challenge, the most common failure
                          // mode per AGENTS.md #28), append a remediation
                          // hint instead of just the raw stack message.
                          const msg: string = e?.message ?? String(e);
                          const looksLikeLoginFailure = /google|cookie|password field|verify it's you|captcha|okta|session/i.test(msg);
                          const description = looksLikeLoginFailure
                            ? `${msg}\n\nFix: refresh GUESTY_SESSION_COOKIES + GUESTY_OKTA_TOKEN_STORAGE on Railway from a freshly-logged-in browser (Cookie-Editor extension on app.guesty.com).`
                            : msg;
                          toast({ title: "VRBO compliance failed", description, variant: "destructive", duration: 30000 });
                          setVrboComplianceStateByListing((prev) => ({ ...prev, [selectedId]: "idle" }));
                        }
                      };
                      // Compact masked summary of whatever Guesty already
                      // has, so the operator can confirm at a glance
                      // (without exposing the full bare TMK in case of
                      // shoulder-surfing). Shows last-4 digits if present.
                      const tail = (s: string | null | undefined) => (s && s.length > 4 ? `…${s.slice(-4)}` : (s || "—"));
                      const guestyValuesLine = vrboLicense
                        ? `TAT ${tail(vrboLicense.licenseNumber)} · TMK ${tail(vrboLicense.parcelNumber)}${vrboLicense.taxId ? ` · GET ${tail(vrboLicense.taxId)}` : ""}`
                        : "";
                      return (
                        <div className="glb-ch-compliance" style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed rgba(0,0,0,0.1)", fontSize: 12 }}>
                          {isVrboDone ? (
                            <div style={{ color: "#16a34a", display: "flex", alignItems: "flex-start", gap: 6 }}>
                              <span style={{ flexShrink: 0 }}>✓</span>
                              <div>
                                <div style={{ fontWeight: 600 }}>Compliance on file in Guesty</div>
                                {guestyValuesLine && (
                                  <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>
                                    {guestyValuesLine}
                                  </div>
                                )}
                                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                                  {localState === "done"
                                    ? "Just submitted this session — Guesty re-syncs to VRBO via Distribution."
                                    : "Read from Guesty's listing payload. Re-push if the property record changes."}
                                </div>
                              </div>
                            </div>
                          ) : needsUpdate ? (
                            <div>
                              <div style={{ color: "#b45309", fontWeight: 600, marginBottom: 6 }}>
                                ⚠ Compliance on file but {isStale ? "out of date" : "incomplete"}
                              </div>
                              {guestyValuesLine && (
                                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, fontFamily: "monospace" }}>
                                  Currently in Guesty: {guestyValuesLine}
                                </div>
                              )}
                              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
                                {isStale
                                  ? "Guesty's saved values don't match the property record. Re-push to refresh."
                                  : "Guesty has some compliance fields but not all of the ones we'd push. Re-push to fill the rest."}
                              </div>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handlePushVrboCompliance(); }}
                                disabled={isVrboBusy || !effectivePropertyData?.taxMapKey || !effectivePropertyData?.tatLicense}
                                style={{
                                  fontSize: 12, padding: "4px 10px", borderRadius: 4,
                                  border: "1px solid #d97706", background: isVrboBusy ? "#fef3c7" : "#fffbeb",
                                  color: "#92400e", cursor: isVrboBusy ? "wait" : "pointer", fontWeight: 500,
                                }}
                                data-testid="btn-push-vrbo-compliance"
                                title={!effectivePropertyData?.taxMapKey || !effectivePropertyData?.tatLicense ? "TMK and TAT must both be set on the property record." : undefined}
                              >
                                {isVrboBusy ? "⏳ Re-pushing via Guesty…" : "↻ Re-push Compliance to VRBO via Guesty"}
                              </button>
                            </div>
                          ) : (
                            <div>
                              <div style={{ color: "#1d4ed8", fontWeight: 600, marginBottom: 6 }}>
                                ⓘ VRBO compliance not yet in Guesty
                              </div>
                              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
                                Pushes TMK / TAT / GET into Guesty's "Vrbo license requirements" form, then republishes to VRBO from Distribution — both steps automated.
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  // VRBO card opens the public listing on
                                  // click when live; stopPropagation so the
                                  // button click doesn't trigger that.
                                  e.stopPropagation();
                                  handlePushVrboCompliance();
                                }}
                                disabled={isVrboBusy || !effectivePropertyData?.taxMapKey || !effectivePropertyData?.tatLicense}
                                style={{
                                  fontSize: 12, padding: "4px 10px", borderRadius: 4,
                                  border: "1px solid #1d4ed8", background: isVrboBusy ? "#dbeafe" : "#eff6ff",
                                  color: "#1e3a8a", cursor: isVrboBusy ? "wait" : "pointer", fontWeight: 500,
                                }}
                                data-testid="btn-push-vrbo-compliance"
                                title={!effectivePropertyData?.taxMapKey || !effectivePropertyData?.tatLicense ? "TMK and TAT must both be set on the property record." : undefined}
                              >
                                {isVrboBusy ? "⏳ Submitting via Guesty…" : "↗ Push Compliance to VRBO via Guesty"}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
            <hr className="glb-divider" />
          </>
          </BuilderSectionErrorBoundary>
        )}

        {/* ── Photo Sync Status (per channel) ──────────────────────
            Shows whether each OTA channel (Airbnb / VRBO / Booking)
            is on Guesty's master photo sync or has been isolated for
            independent photo management. Lives next to the Re-publish
            channel cards so all per-channel controls are one band.
            communityFolder + bedrooms come from unit-builder-data so
            the full Isolate + Replace + Disconnect flow can call
            find-unit without the operator re-entering them. */}
        {selectedId && (
          <BuilderSectionErrorBoundary
            resetKey={`photo-sync:${propertyId ?? "unknown"}:${selectedId}`}
            fallback={
              <div className="glb-error-banner" style={{ marginBottom: 20 }}>
                Photo sync status could not render for this Guesty listing. The rest of the builder is still usable.
              </div>
            }
          >
        {(() => {
          const builder = propertyId ? getUnitBuilderByPropertyId(propertyId) : undefined;
          // Promoted drafts do not live in the static unit-builder map yet.
          // The per-channel photo-isolation panel needs that canonical
          // community folder to drive its replacement flow, so skip it for
          // draft-only listings instead of letting an optional OTA panel
          // take down the builder page.
          if (!builder) return null;
          const totalBedrooms = builder?.units.reduce((s, u) => s + (u.bedrooms ?? 0), 0);
          // Pre-fill partnerListingRef from Guesty's per-channel
          // identifiers — VRBO's advertiserId IS the partner-portal
          // listing id; Booking's hotelId is the extranet id.
          // channelStatus is already loaded by the existing channel-
          // info effect.
          // PR #319: pass per-unit bedroom counts so the panel can
          // default the row-level Isolate+Replace+Disconnect modal
          // to the largest unit (likely findable in the community)
          // instead of the listing total (Pili Mai 5BR Townhomes
          // = 6 listing total, but the resort has no 6BR units).
          const unitBedroomCounts = (builder?.units ?? []).map((u) => u.bedrooms ?? 0).filter((n) => n > 0);
          return (
            <PhotoSyncStatusPanel
              guestyListingId={selectedId}
              communityFolder={builder?.communityPhotoFolder}
              bedrooms={totalBedrooms && totalBedrooms > 0 ? totalBedrooms : undefined}
              unitBedroomCounts={unitBedroomCounts}
              channelIds={{
                vrbo: channelStatus?.vrbo?.id ?? null,
                booking: channelStatus?.bookingCom?.id ?? null,
              }}
            />
          );
        })()}
          </BuilderSectionErrorBoundary>
        )}

        {/* ── Data Preview Panel ────────────────────────────────── */}
        {propertyData && (
          <>
            <div className="glb-section-label">Property Data Preview</div>
            <div className="glb-data-push-row" data-testid="property-data-push-row">
              <button
                type="button"
                className="glb-btn glb-btn-secondary"
                onClick={handlePushPropertyDataPreview}
                disabled={!selectedId || dataPushBusy || building || conn !== "connected"}
                data-testid="btn-push-property-data-preview"
                title={selectedId ? "Push descriptions, bedding/sqft, amenities, photos, and market pricing to Guesty" : "Select a Guesty listing first"}
              >
                {dataPushBusy ? "Pushing property data..." : "Push Descriptions, Bedding, Amenities, Photos & Pricing"}
              </button>
              <div className="glb-data-push-meta" aria-label="Guesty property data push history">
                {([
                  ["descriptions", "Descriptions"] as const,
                  ["bedding", "Bedding + sqft"] as const,
                  ["amenities", "Amenities"] as const,
                  ["photos", "Photos"] as const,
                  ["bookable", "Bookable"] as const,
                  ["pricing", "Pricing"] as const,
                ]).map(([key, label]) => {
                  const entry = dataPushLog[key];
                  return (
                    <div
                      key={key}
                      className={`glb-data-push-item ${entry?.status ?? ""}`}
                      title={entry?.message}
                      data-testid={`data-push-log-${key}`}
                    >
                      <span aria-hidden="true">{entry ? statusIcon(entry.status) : "…"}</span>
                      <strong>{label}</strong>
                      <span>{formatDataPushTime(entry?.pushedAt)}</span>
                    </div>
                  );
                })}
              </div>
              {!selectedId && (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Select a Guesty listing first</span>
              )}
            </div>
            {/* Async Guesty rate-push status. The pricing step queues a refresh
                that pushes marked-up rates to Guesty only AFTER the SearchAPI
                Airbnb P40 refresh finishes, so surface the live phase + the
                terminal "rates pushed" / failure outcome here under the button. */}
            {pricingPushStatus && (() => {
              const s = pricingPushStatus;
              const running = s.status === "queued" || s.status === "running";
              const done = s.status === "completed";
              const failed = s.status === "failed";
              const cancelled = s.status === "cancelled";
              const pushing = s.phase === "pushing-guesty";
              const palette = done
                ? { bg: "#ecfdf5", border: "#a7f3d0", fg: "#065f46", dot: "#16a34a" }
                : failed
                  ? { bg: "#fef2f2", border: "#fecaca", fg: "#991b1b", dot: "#dc2626" }
                  : cancelled
                    ? { bg: "#fffbeb", border: "#fde68a", fg: "#92400e", dot: "#b45309" }
                    : { bg: "#eff6ff", border: "#bfdbfe", fg: "#1e40af", dot: "#2563eb" };
              const title = done
                ? "✓ Marked-up rates pushed to Guesty"
                : failed
                  ? "✗ Guesty rate push didn’t finish"
                  : cancelled
                    ? "Rate push cancelled"
                    : pushing
                      ? "Pushing marked-up rates to Guesty…"
                      : "Refreshing market rates (SearchAPI Airbnb P40)…";
              return (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="pricing-push-status"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    margin: "8px 0 0",
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: `1px solid ${palette.border}`,
                    background: palette.bg,
                    color: palette.fg,
                    fontSize: 12,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 9,
                      height: 9,
                      marginTop: 4,
                      borderRadius: "50%",
                      background: palette.dot,
                      flexShrink: 0,
                      animation: running ? "glb-pulse 1.2s ease-in-out infinite" : undefined,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {title}
                      {running ? ` · ${s.percent}%` : ""}
                    </div>
                    <div style={{ marginTop: 2, opacity: 0.85, wordBreak: "break-word" }}>{s.label}</div>
                    {failed && s.error && s.error !== s.label && (
                      <div style={{ marginTop: 2, color: "#991b1b", opacity: 0.95 }}>{s.error}</div>
                    )}
                    {running && (
                      <div style={{ marginTop: 2, opacity: 0.7 }}>
                        Safe to leave this page — the push runs in the cloud.
                      </div>
                    )}
                  </div>
                  {!running && (
                    <button
                      type="button"
                      onClick={dismissPricingPushStatus}
                      aria-label="Dismiss rate-push status"
                      data-testid="pricing-push-status-dismiss"
                      style={{
                        border: "none",
                        background: "transparent",
                        color: palette.fg,
                        cursor: "pointer",
                        fontSize: 16,
                        lineHeight: 1,
                        padding: 0,
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })()}
            <div className="glb-panel">
              <div className="glb-tabs">
                {(["descriptions", "bedding", "amenities", "pricing", "photos", "availability", "otaVisibility"] as const).map((t) => {
                  const pushTab: DataPushTab | null = t === "otaVisibility" ? null : t;
                  const entry = pushTab ? dataPushLog[pushTab] : undefined;
                  const pushedTime = formatDataPushTabTime(entry?.pushedAt);
                  const photosCount = photos.length + (guestyCoverCollageUrl ? 1 : 0);
                  const label = t === "otaVisibility"
                    ? "OTA Visibility"
                    : t === "amenities"
                      ? `Amenities (${pendingAmenities.size})`
                      : dataPushTabLabel(t, photosCount);
                  const statusTitle = !pushTab
                    ? label
                    : entry
                      ? `${label} ${entry.status === "success" ? "pushed" : "failed"} ${pushedTime || formatDataPushTime(entry.pushedAt)}${entry.message ? `: ${entry.message}` : ""}`
                      : `${label} has not been pushed from this browser session`;
                  return (
                    <button key={t} className={`glb-tab ${activeTab === t ? "active" : ""}`} onClick={() => setActiveTab(t)} data-testid={`tab-${t}`} title={statusTitle}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        {label}
                        {selectedId && t === "photos" && (
                          guestyPhotoCountLoading
                            ? <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#d1d5db", display: "inline-block" }} title="Checking Guesty…" />
                            : guestyPhotoCount === null
                            ? null
                            : guestyPhotoCount > 0
                            ? <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#16a34a", display: "inline-block" }} title={`${guestyPhotoCount} photos in Guesty`} />
                            : <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#dc2626", display: "inline-block" }} title="No photos in Guesty yet" />
                        )}
                        {pushTab && (
                          <span
                            aria-label={entry ? `${label} ${entry.status} ${pushedTime}` : `${label} not pushed`}
                            title={statusTitle}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 3,
                              fontSize: 10,
                              lineHeight: 1,
                              color: entry?.status === "success" ? "#166534" : entry?.status === "error" ? "#991b1b" : "#9ca3af",
                              textTransform: "none",
                              letterSpacing: 0,
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                background: entry?.status === "success" ? "#16a34a" : entry?.status === "error" ? "#dc2626" : "#d1d5db",
                                display: "inline-block",
                              }}
                            />
                            {pushedTime && <span>{pushedTime}</span>}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
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

                    {/* Compliance & Registration Section
                        Field labels swap based on the property's state
                        because the four slots represent different things
                        per jurisdiction. Hawaii: TMK / GE / TAT / STR.
                        Florida: DBPR Vacation Rental / Sales Tax Cert /
                        County TDT / Local Business Tax Receipt. The
                        underlying data field names stay HI-flavored
                        (taxMapKey / getLicense / tatLicense / strPermit);
                        only display labels change. */}
                    {(complianceProfile.requirements.length > 0 || effectivePropertyData?.taxMapKey || effectivePropertyData?.tatLicense || effectivePropertyData?.getLicense || effectivePropertyData?.strPermit || effectivePropertyData?.dbprLicense || effectivePropertyData?.touristTaxAccount) && (
                      <div style={{ marginTop: 24, padding: "16px 20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 13, fontWeight: 600, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                            <span>🏛 {complianceProfile.title}</span>
                            <span style={{ fontSize: 11, fontWeight: 400, color: "var(--muted-foreground)", lineHeight: 1.45 }}>
                              {complianceProfile.summary}
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            disabled={licenseLookupBusy}
                            onClick={pullLicenseRequirements}
                            style={{
                              fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 6,
                              border: "1px solid var(--border)", cursor: licenseLookupBusy ? "wait" : "pointer",
                              background: "#fff", color: "var(--text)",
                            }}
                            data-testid="btn-pull-license-requirements"
                          >
                            {licenseLookupBusy ? "Checking..." : "Check requirements / pull public licenses"}
                          </button>
                          <button
                            disabled={!selectedId}
                            onClick={async () => {
                              if (!selectedId) return;
                              try {
                                const isFloridaProfile = isFloridaLicenseJurisdiction(complianceProfile.jurisdiction);
                                const res = await fetch("/api/builder/push-compliance", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    listingId: selectedId,
                                    taxMapKey: effectivePropertyData.taxMapKey,
                                    tatLicense: effectivePropertyData.tatLicense,
                                    getLicense: effectivePropertyData.getLicense,
                                    strPermit: effectivePropertyData.strPermit,
                                    dbprLicense: effectivePropertyData.dbprLicense || (isFloridaProfile ? effectivePropertyData.taxMapKey : undefined),
                                    touristTaxAccount: effectivePropertyData.touristTaxAccount || (isFloridaProfile ? effectivePropertyData.tatLicense : undefined),
                                  }),
                                });
                                const data = await res.json();
                                if (data.success) {
                                  const compTags = (data.savedTags || []).filter((t: string) => /^(TMK|TAT|GET|STR|DBPR|TDT):/.test(t)).join(", ");
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
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)", marginBottom: 4 }}>
                              {complianceLabels.title1}
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "monospace", background: "var(--muted)", padding: "6px 10px", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                              data-testid="text-tmk-value">
                              <span>{complianceDisplayValue(complianceSummaryValues.title1)}</span>
                              {canCopyComplianceValue(complianceSummaryValues.title1) && (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                  onClick={() => { navigator.clipboard.writeText(complianceSummaryValues.title1!); toast({ title: `Copied ${complianceLabels.title1}` }); }}
                                  title="Copy to clipboard"
                                >📋</button>
                              )}
                            </div>
                            {isHawaiiCompliance && (
                              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                                <button
                                  type="button"
                                  onClick={pullRealTaxMapKey}
                                  disabled={tmkLookupBusy || !effectivePropertyData.address}
                                  style={{
                                    width: "100%",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    padding: "6px 8px",
                                    borderRadius: 5,
                                    border: "1px solid var(--border)",
                                    background: tmkLookupBusy ? "var(--muted)" : "#fff",
                                    color: "var(--text)",
                                    cursor: tmkLookupBusy ? "wait" : "pointer",
                                  }}
                                  data-testid="button-pull-real-tmk"
                                >
                                  {tmkLookupBusy ? "Pulling Guesty-address TMK..." : "Pull real TMK from Guesty address"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const req = complianceProfile.requirements.find((candidate) => candidate.key === "taxMapKey");
                                    if (req) void generateSampleForRequirement(req);
                                  }}
                                  style={{
                                    width: "100%",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    padding: "6px 8px",
                                    borderRadius: 5,
                                    border: "1px solid var(--border)",
                                    background: "#fff",
                                    color: "var(--text)",
                                    cursor: "pointer",
                                  }}
                                  data-testid="button-generate-sample-tmk-map"
                                >
                                  Generate sample TMK / MAP
                                </button>
                                <div style={{ fontSize: 10.5, color: "var(--muted-foreground)", lineHeight: 1.35 }}>
                                  Uses the exact address that will be pushed to Guesty for Airbnb license verification.
                                </div>
                                {tmkLookupResult && (
                                  <div style={{ fontSize: 10.5, color: "var(--muted-foreground)", lineHeight: 1.35 }}>
                                    {tmkLookupResult.confidence === "unit-cpr" ? "Guesty-address CPR match" : "Guesty-address parcel match"} · {tmkLookupResult.source}
                                    {tmkLookupResult.sourceUrl && (
                                      <>
                                        {" · "}
                                        <a href={tmkLookupResult.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "var(--primary)" }}>
                                          source
                                        </a>
                                      </>
                                    )}
                                    <br />
                                    {tmkLookupResult.note}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)", marginBottom: 4 }}>
                              {complianceLabels.title2}
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "monospace", background: "var(--muted)", padding: "6px 10px", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                              data-testid="text-get-value">
                              <span>{complianceDisplayValue(complianceSummaryValues.title2)}</span>
                              {canCopyComplianceValue(complianceSummaryValues.title2) && (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                  onClick={() => { navigator.clipboard.writeText(complianceSummaryValues.title2!); toast({ title: `Copied ${complianceLabels.title2}` }); }}
                                  title="Copy to clipboard"
                                >📋</button>
                              )}
                            </div>
                            {isHawaiiCompliance && (
                              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                                <button
                                  type="button"
                                  onClick={pullRealGetLicense}
                                  disabled={getLookupBusy || !effectivePropertyData.address}
                                  style={{
                                    width: "100%",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    padding: "6px 8px",
                                    borderRadius: 5,
                                    border: "1px solid var(--border)",
                                    background: getLookupBusy ? "var(--muted)" : "#fff",
                                    color: "var(--text)",
                                    cursor: getLookupBusy ? "wait" : "pointer",
                                  }}
                                  data-testid="button-pull-real-get"
                                >
                                  {getLookupBusy ? "Pulling real GET..." : "Pull real GET license"}
                                </button>
                                <div style={{ fontSize: 10.5, color: "var(--muted-foreground)", lineHeight: 1.35 }}>
                                  Pulls from the connected Guesty listing compliance fields only (not static sample data).
                                </div>
                                {renderComplianceLookupMeta(getLookupResult)}
                              </div>
                            )}
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)", marginBottom: 4 }}>
                              {complianceLabels.title3}
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "monospace", background: "var(--muted)", padding: "6px 10px", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                              data-testid="text-tat-value">
                              <span>{complianceDisplayValue(complianceSummaryValues.title3)}</span>
                              {canCopyComplianceValue(complianceSummaryValues.title3) && (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                  onClick={() => { navigator.clipboard.writeText(complianceSummaryValues.title3!); toast({ title: `Copied ${complianceLabels.title3}` }); }}
                                  title="Copy to clipboard"
                                >📋</button>
                              )}
                            </div>
                            {isHawaiiCompliance && (
                              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                                <button
                                  type="button"
                                  onClick={pullRealTatLicense}
                                  disabled={tatLookupBusy || !effectivePropertyData.address}
                                  style={{
                                    width: "100%",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    padding: "6px 8px",
                                    borderRadius: 5,
                                    border: "1px solid var(--border)",
                                    background: tatLookupBusy ? "var(--muted)" : "#fff",
                                    color: "var(--text)",
                                    cursor: tatLookupBusy ? "wait" : "pointer",
                                  }}
                                  data-testid="button-pull-real-tat"
                                >
                                  {tatLookupBusy ? "Pulling real TAT..." : "Pull real TAT license"}
                                </button>
                                <div style={{ fontSize: 10.5, color: "var(--muted-foreground)", lineHeight: 1.35 }}>
                                  Pulls from the connected Guesty listing compliance fields only (not static sample data).
                                </div>
                                {renderComplianceLookupMeta(tatLookupResult)}
                              </div>
                            )}
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted-foreground)", marginBottom: 4 }}>
                              {complianceLabels.title4}
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "monospace", background: "var(--muted)", padding: "6px 10px", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                              data-testid="text-str-permit-value">
                              <span>{complianceDisplayValue(complianceSummaryValues.title4)}</span>
                              {canCopyComplianceValue(complianceSummaryValues.title4) && (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                  onClick={() => { navigator.clipboard.writeText(complianceSummaryValues.title4!); toast({ title: `Copied ${complianceLabels.title4}` }); }}
                                  title="Copy to clipboard"
                                >📋</button>
                              )}
                            </div>
                            {isHawaiiCompliance && (
                              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                                <button
                                  type="button"
                                  onClick={pullRealStrPermit}
                                  disabled={strLookupBusy || !effectivePropertyData.address}
                                  style={{
                                    width: "100%",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    padding: "6px 8px",
                                    borderRadius: 5,
                                    border: "1px solid var(--border)",
                                    background: strLookupBusy ? "var(--muted)" : "#fff",
                                    color: "var(--text)",
                                    cursor: strLookupBusy ? "wait" : "pointer",
                                  }}
                                  data-testid="button-pull-real-str"
                                >
                                  {strLookupBusy ? "Pulling real STR permit..." : "Pull real STR permit from Guesty address"}
                                </button>
                                <div style={{ fontSize: 10.5, color: "var(--muted-foreground)", lineHeight: 1.35 }}>
                                  Uses the connected Guesty listing when available, otherwise matches the Kauai County TVR registry by TMK.
                                </div>
                                {renderComplianceLookupMeta(strLookupResult)}
                              </div>
                            )}
                          </div>
                        </div>
                        {complianceProfile.requirements.length > 0 && (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginTop: 14 }}>
                            {complianceProfile.requirements.map((req) => {
                              const value = complianceValueFor(req.key);
                              const isPlaceholder = isPlaceholderLicenseValue(value);
                              const inputValue = String(value ?? "").trim();
                              const canPublicPull = (complianceProfile.jurisdiction === "fort_myers_beach_fl" && req.key === "strPermit")
                                || (isFloridaLicenseJurisdiction(complianceProfile.jurisdiction) && req.key === "dbprLicense")
                                || (isHawaiiCompliance && req.key === "taxMapKey");
                              const sampleButtonLabel = req.key === "taxMapKey" && isHawaiiCompliance
                                ? "Generate sample TMK / MAP"
                                : `Generate sample ${req.shortLabel}`;
                              return (
                                <div key={req.key} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, background: "var(--muted)" }}>
                                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: "var(--muted-foreground)", marginBottom: 4 }}>
                                    {req.shortLabel}{req.required ? " Required" : ""}
                                  </div>
                                  <div style={{ fontSize: 13, fontFamily: "monospace", display: "flex", justifyContent: "space-between", gap: 8 }}>
                                    <span>{value ? `${isPlaceholder ? "sample: " : ""}${value}` : `sample: ${req.sample}`}</span>
                                    {value && !isPlaceholder && (
                                      <button
                                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}
                                        onClick={() => { navigator.clipboard.writeText(value); toast({ title: `Copied ${req.shortLabel}` }); }}
                                        title="Copy to clipboard"
                                      >📋</button>
                                    )}
                                  </div>
                                  {isPlaceholder && (
                                    <div style={{ fontSize: 10, color: "#b45309", marginTop: 5, lineHeight: 1.35 }}>
                                      Sample value only. Enter the real {req.shortLabel}, generate a sample placeholder below{canPublicPull ? `, or pull it from the public ${req.key === "dbprLicense" ? "Florida DBPR records" : req.key === "taxMapKey" ? "county GIS" : "Fort Myers STR portal"}` : ""} before pushing compliance.
                                    </div>
                                  )}
                                  <input
                                    value={inputValue}
                                    onChange={(event) => {
                                      const next = event.target.value;
                                      setComplianceOverrides((prev) => ({ ...prev, [req.key]: next }));
                                    }}
                                    onBlur={(event) => {
                                      persistComplianceValues({ [req.key]: event.target.value } as Partial<Pick<GuestyPropertyData, "taxMapKey" | "tatLicense" | "getLicense" | "strPermit" | "dbprLicense" | "touristTaxAccount">>)
                                        .catch((err) => toast({ title: "License save failed", description: err.message, variant: "destructive" }));
                                    }}
                                    placeholder={req.sample}
                                    style={{
                                      width: "100%",
                                      marginTop: 8,
                                      fontSize: 12,
                                      fontFamily: "monospace",
                                      padding: "6px 8px",
                                      borderRadius: 5,
                                      border: "1px solid var(--border)",
                                      background: "#fff",
                                      color: "var(--text)",
                                    }}
                                    data-testid={`input-compliance-${req.key}`}
                                  />
                                  <div style={{ fontSize: 10, color: "var(--muted-foreground)", marginTop: 5, lineHeight: 1.35 }}>
                                    {req.helpText}
                                  </div>
                                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                                    {canPublicPull && (
                                      <button
                                        type="button"
                                        disabled={licenseLookupBusy}
                                        onClick={req.key === "taxMapKey" && isHawaiiCompliance ? pullRealTaxMapKey : pullLicenseRequirements}
                                        style={{
                                          fontSize: 11,
                                          fontWeight: 600,
                                          padding: "4px 8px",
                                          borderRadius: 5,
                                          border: "1px solid var(--border)",
                                          background: "#fff",
                                          color: "var(--text)",
                                          cursor: licenseLookupBusy ? "wait" : "pointer",
                                        }}
                                        data-testid={`btn-pull-${req.key}`}
                                      >
                                        {value && !isPlaceholder ? `Refresh public ${req.shortLabel}` : `Pull public ${req.shortLabel}`}
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => { void generateSampleForRequirement(req); }}
                                      style={{
                                        fontSize: 11,
                                        fontWeight: 600,
                                        padding: "4px 8px",
                                        borderRadius: 5,
                                        border: "1px solid var(--border)",
                                        background: "#fff",
                                        color: "var(--text)",
                                        cursor: "pointer",
                                      }}
                                      data-testid={canPublicPull ? `btn-sample-${req.key}` : `btn-pull-${req.key}`}
                                    >
                                      {sampleButtonLabel}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {complianceProfile.sources.length > 0 && (
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, fontSize: 11 }}>
                            {complianceProfile.sources.map((source) => (
                              <a key={source.url} href={source.url} target="_blank" rel="noreferrer" style={{ color: "#1e40af", textDecoration: "underline" }}>
                                {source.label}
                              </a>
                            ))}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: "var(--muted-foreground)", marginTop: 10, lineHeight: 1.6 }}>
                          Push writes to <strong>4 destinations</strong>: (1) Guesty internal tags <code>GET:</code> / <code>TAT:</code> / <code>TMK:</code> / <code>STR:</code> / <code>DBPR:</code> / <code>TDT:</code> — (2) <code>licenseNumber</code> field — (3) <code>taxId</code> field when available — (4) <em>Notes</em> field with a structured license compliance block. VRBO channel compliance fields (<code>channels.homeaway</code>) are also attempted but only save once you connect VRBO OAuth in Guesty's channel settings. After pushing, the toast shows exactly what was accepted.
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "bedding" && (
                  <BeddingTab
                    propertyId={propertyId}
                    guestyListingId={selectedId || null}
                    onGuestyPushRecorded={(status, message) => recordDataPush("bedding", status, message)}
                  />
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
                            { label: "Base Price / Night", val: displayedBasePrice != null ? `$${displayedBasePrice.toLocaleString()}` : null },
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
                              <div style={{ fontSize: 11, fontWeight: 400, textTransform: "none", letterSpacing: 0, display: "flex", alignItems: "center", gap: 10 }}>
                                {/* Sync summary — how many of the visible months
                                    actually have a live rate in Guesty's calendar.
                                    Lets the user tell at a glance whether "Push
                                    seasonal rates" has been run yet. */}
                                {(() => {
                                  const total = seasonalMonths.length;
                                  const synced = seasonalMonths.filter((r) => !!guestyRatesByMonth[r.yearMonth]).length;
                                  if (guestyRatesLoading) return <span style={{ color: "#9ca3af" }}>Loading Guesty rates…</span>;
                                  if (guestyRatesError) return <span style={{ color: "#dc2626" }} title={guestyRatesError}>Guesty rates unavailable</span>;
                                  if (total === 0) return null;
                                  const allSynced = synced === total;
                                  const noneSynced = synced === 0;
                                  const bg = allSynced ? "#dcfce7" : noneSynced ? "#fee2e2" : "#fef3c7";
                                  const fg = allSynced ? "#166534" : noneSynced ? "#991b1b" : "#92400e";
                                  return (
                                    <span style={{ background: bg, color: fg, padding: "3px 8px", borderRadius: 4, fontWeight: 600 }}>
                                      {allSynced ? "✓" : noneSynced ? "✗" : "⚠"} {synced} / {total} months pushed to Guesty
                                    </span>
                                  );
                                })()}
                              </div>
                            </div>
                            {/* Live buy-in summary. One badge per bedroom-count
                                showing the persisted Airbnb SearchAPI layered
                                basis for the market-rate tool. */}
                            {liveBuyInSummary.length > 0 && (
                              <div style={{ marginTop: 6, marginBottom: 8, fontSize: 11, color: "#6b7280", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                                <span style={{ color: "#374151", fontWeight: 600 }} title="Buy-in basis = Airbnb SearchAPI seasonal sample after specialized layered markups.">
                                  Buy-in basis (Airbnb SearchAPI layered):
                                </span>
                                {liveBuyInSummary.map(({ bedrooms, live }) => {
                                  if (!live) {
                                    return (
                                      <span key={bedrooms} title="No Airbnb SearchAPI layered rate has been saved for this bedroom count yet. Click 'Update Market Rates Now' to fetch."
                                        style={{ background: "#f3f4f6", color: "#6b7280", padding: "2px 6px", borderRadius: 4, fontWeight: 500 }}>
                                        {bedrooms}BR no rate
                                      </span>
                                    );
                                  }
                                  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(live.refreshedAt).getTime()) / (24 * 60 * 60 * 1000)));
                                  const stale = ageDays > 14;
                                  const bg = stale ? "#fef3c7" : "#dbeafe";
                                  const fg = stale ? "#92400e" : "#1e40af";
                                  // Surface which methodology produced the
                                  // basis: the multi-channel median is the
                                  // intended path; an Airbnb-only basis means
                                  // the other channels returned no usable rate.
                                  const isMultichannel = live.source === "live-multichannel-median" || live.source === "season-band-multichannel-median";
                                  const sourceLabel = live.source === "static-buy-in"
                                    ? "legacy static buy-in basis"
                                    : isMultichannel
                                    ? live.source === "season-band-multichannel-median"
                                      ? `season-band median across ${live.sampleCount} channel sample${live.sampleCount === 1 ? "" : "s"}`
                                      : `median across ${live.sampleCount} channel${live.sampleCount === 1 ? "" : "s"}`
                                    : live.source === "hybrid-airbnb-layered"
                                      ? `layered Airbnb basis across ${live.sampleCount} Airbnb sample${live.sampleCount === 1 ? "" : "s"}`
                                    : live.source === "airbnb"
                                      ? "Airbnb-only channel basis"
                                      : live.source === "monthly-multichannel-median"
                                        ? "monthly channel median"
                                      : live.source;
                                  return (
                                    <span key={bedrooms}
                                      title={`${bedrooms}BR buy-in $${Math.round(live.medianNightly).toLocaleString()} · ${live.sampleCount} channel${live.sampleCount === 1 ? "" : "s"} · ${sourceLabel} · refreshed ${ageDays} day${ageDays === 1 ? "" : "s"} ago`}
                                      style={{ background: bg, color: fg, padding: "2px 6px", borderRadius: 4, fontWeight: 600 }}>
                                      {bedrooms}BR ${Math.round(live.medianNightly).toLocaleString()}
                                      <span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 4 }}>· {ageDays}d</span>
                                    </span>
                                  );
                                })}
                                <button
                                  type="button"
                                  onClick={refreshThisPropertyMarketRates}
                                  disabled={marketRatesRefreshing}
                                  style={{
                                    marginLeft: "auto",
                                    fontSize: 11,
                                    fontWeight: 500,
                                    padding: "3px 10px",
                                    borderRadius: 4,
                                    border: "1px solid #d1d5db",
                                    background: marketRatesRefreshing ? "#f3f4f6" : "#ffffff",
                                    color: marketRatesRefreshing ? "#9ca3af" : "#1f2937",
                                    cursor: marketRatesRefreshing ? "wait" : "pointer",
                                  }}
                                      title="Refreshes Airbnb SearchAPI seasonal pricing and pushes marked-up base rates to Guesty."
                                >
                                  {marketRatesRefreshing ? "Refreshing…" : "↻ Update Market Rates Now"}
                                </button>
                              </div>
                            )}
                            {/* Inline progress bar for the server-owned pricing refresh. */}
                            {marketRatesRefreshing && refreshProgress && (() => {
                              // Computed values for freeze detection.
                              // nowTick is unused-but-referenced so React
                              // re-renders this block each second.
                              void nowTick;
                              const now = Date.now();
                              const startedAtForDisplay = refreshStartedAt ?? refreshProgress.startedAt ?? null;
                              const elapsedMs = startedAtForDisplay ? now - startedAtForDisplay : 0;
                              const elapsedMin = Math.floor(elapsedMs / 60000);
                              const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
                              const elapsedStr = `${elapsedMin}:${String(elapsedSec).padStart(2, "0")}`;
                              const ageSinceTickMs = refreshProgress.lastTickAt ? now - refreshProgress.lastTickAt : 0;
                              const ageSinceTickSec = Math.round(ageSinceTickMs / 1000);
                              // Stale if no server tick in 60s. The endpoint
                              // is quick, so that usually means the request
                              // was interrupted by a deploy/restart.
                              const STALE_MS = 60_000;
                              const isStale = !!refreshProgress.lastTickAt && ageSinceTickMs > STALE_MS;
                              const daemonStatus = refreshProgress.daemonOnline === true
                                ? { label: "Daemon online", color: "#15803d" }
                                : refreshProgress.daemonOnline === false
                                ? { label: "Daemon offline", color: "#b91c1c" }
                                : null;
                              const hasWindowProgress =
                                typeof refreshProgress.progressDone === "number" &&
                                typeof refreshProgress.progressTotal === "number" &&
                                refreshProgress.progressTotal > 0;
                              const completedWindows = hasWindowProgress
                                ? Math.max(0, Math.min(refreshProgress.progressTotal!, refreshProgress.progressDone!))
                                : 0;
                              const totalWindows = hasWindowProgress ? refreshProgress.progressTotal! : 0;
                              const currentWindow = hasWindowProgress && typeof refreshProgress.progressCurrent === "number"
                                ? Math.max(1, Math.min(totalWindows, refreshProgress.progressCurrent))
                                : null;
                              const hasSubProgress =
                                typeof refreshProgress.progressSubDone === "number" &&
                                typeof refreshProgress.progressSubTotal === "number" &&
                                refreshProgress.progressSubTotal > 0;
                              const completedSubChecks = hasSubProgress
                                ? Math.max(0, Math.min(refreshProgress.progressSubTotal!, refreshProgress.progressSubDone!))
                                : 0;
                              const totalSubChecks = hasSubProgress ? refreshProgress.progressSubTotal! : 0;
                              const subWindowFraction = hasSubProgress
                                ? Math.max(0, Math.min(1, completedSubChecks / totalSubChecks))
                                : 0;
                              const completedPercent = hasWindowProgress
                                ? Math.round(((completedWindows + subWindowFraction) / totalWindows) * 100)
                                : Math.max(0, Math.min(100, refreshProgress.percent));
                              const activeWindowPercent = hasWindowProgress && currentWindow != null
                                ? Math.round(((Math.max(0, currentWindow - 1) + Math.max(subWindowFraction, 0.05)) / totalWindows) * 100)
                                : completedPercent;
                              const currentWindowElapsedMs = refreshProgress.progressWindowStartedAt
                                ? Math.max(0, now - refreshProgress.progressWindowStartedAt)
                                : 0;
                              const currentWindowElapsedMin = Math.floor(currentWindowElapsedMs / 60000);
                              const currentWindowElapsedSec = Math.floor((currentWindowElapsedMs % 60000) / 1000);
                              const currentWindowElapsedStr = `${currentWindowElapsedMin}:${String(currentWindowElapsedSec).padStart(2, "0")}`;
                              const subElapsedMs = refreshProgress.progressSubStartedAt
                                ? Math.max(0, now - refreshProgress.progressSubStartedAt)
                                : 0;
                              const subElapsedMin = Math.floor(subElapsedMs / 60000);
                              const subElapsedSec = Math.floor((subElapsedMs % 60000) / 1000);
                              const subElapsedStr = `${subElapsedMin}:${String(subElapsedSec).padStart(2, "0")}`;
                              const progressText = hasWindowProgress
                                ? `${currentWindow != null ? `window ${currentWindow}/${totalWindows}` : `${completedWindows}/${totalWindows} windows`}${hasSubProgress ? ` · ${completedSubChecks}/${totalSubChecks} checks` : ""} · ${completedPercent}%`
                                : `${Math.max(0, Math.min(100, refreshProgress.percent))}%`;
                              return (
                                <div style={{ marginBottom: 8, padding: "6px 10px", border: `1px solid ${isStale ? "#fca5a5" : "#cfe2ff"}`, background: isStale ? "#fef2f2" : "#eef4ff", borderRadius: 4, fontSize: 11, color: isStale ? "#7f1d1d" : "#1e3a8a" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 8 }}>
                                    <span style={{ fontWeight: 500 }}>Running SearchAPI Airbnb seasonal pricing…</span>
                                    <span style={{ fontFamily: "ui-monospace, monospace" }}>{elapsedStr}</span>
                                    <span style={{ fontFamily: "ui-monospace, monospace" }}>{progressText}</span>
                                    <button
                                      type="button"
                                      onClick={cancelRefresh}
                                      title="Cancel the in-flight pricing refresh and clear the server lock."
                                      style={{
                                        fontSize: 10,
                                        padding: "1px 6px",
                                        borderRadius: 3,
                                        border: `1px solid ${isStale ? "#fca5a5" : "#93c5fd"}`,
                                        background: "#ffffff",
                                        color: isStale ? "#991b1b" : "#1e3a8a",
                                        cursor: "pointer",
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                  <div style={{ position: "relative", height: 6, background: isStale ? "#fee2e2" : "#dbeafe", borderRadius: 3, overflow: "hidden" }}>
                                    {hasWindowProgress && currentWindow != null && (
                                      <div
                                        style={{
                                          position: "absolute",
                                          left: 0,
                                          top: 0,
                                          width: `${Math.max(0, Math.min(100, activeWindowPercent))}%`,
                                          height: "100%",
                                          background: isStale ? "#fecaca" : "#bfdbfe",
                                          transition: "width 250ms ease",
                                        }}
                                      />
                                    )}
                                    <div
                                      style={{
                                        position: "absolute",
                                        left: 0,
                                        top: 0,
                                        width: `${Math.max(0, Math.min(100, completedPercent))}%`,
                                        height: "100%",
                                        background: isStale ? "#dc2626" : "#2563eb",
                                        transition: "width 250ms ease",
                                      }}
                                    />
                                  </div>
                                  <div style={{ marginTop: 4, fontSize: 10, opacity: 0.85 }}>{refreshProgress.label}</div>
                                  {hasWindowProgress && refreshProgress.progressWindowLabel && currentWindow != null && (
                                    <div style={{ marginTop: 2, fontSize: 9, opacity: 0.7 }}>
                                      Current window {currentWindow}/{totalWindows}: {refreshProgress.progressWindowLabel}
                                      {refreshProgress.progressWindowStartedAt && ` · ${currentWindowElapsedStr} on this window`}
                                    </div>
                                  )}
                                  {hasSubProgress && refreshProgress.progressSubLabel && (
                                    <div style={{ marginTop: 2, fontSize: 9, opacity: 0.7 }}>
                                      Latest completed check: {refreshProgress.progressSubLabel}
                                      {refreshProgress.progressSubStartedAt && ` · ${subElapsedStr} since this update`}
                                    </div>
                                  )}
                                  {hasWindowProgress && currentWindow != null && (
                                    <div style={{ marginTop: 2, fontSize: 9, opacity: 0.7 }}>
                                      The bar advances as Airbnb seasonal samples are saved and marked-up Guesty base rates are pushed.
                                    </div>
                                  )}
                                  {/* Heartbeat row: confirms the server-side pricing request is still updating progress. */}
                                  <div style={{ marginTop: 4, display: "flex", gap: 12, fontSize: 9, opacity: 0.85 }}>
                                    {daemonStatus && <span style={{ color: daemonStatus.color, fontWeight: 500 }}>● {daemonStatus.label}</span>}
                                    {refreshProgress.lastTickAt && (
                                      <span style={{ opacity: 0.7 }}>
                                        Heartbeat: {ageSinceTickSec}s ago
                                      </span>
                                    )}
                                  </div>
                                  {isStale && (
                                    <div style={{ marginTop: 4, padding: "4px 6px", border: "1px solid #fca5a5", background: "#ffffff", borderRadius: 3, fontSize: 10, color: "#7f1d1d" }}>
                                      No heartbeat for {ageSinceTickSec}s (expected every 15s). Scan loop may be wedged. You can cancel and retry when the server is stable.
                                    </div>
                                  )}
                                  {/* Per-window / per-channel warnings (CAPTCHA, bot wall, rate-limit, etc.). Yellow-amber banner so it stands apart from both the blue progress and the red staleness state. */}
                                  {refreshProgress.warnings && refreshProgress.warnings.length > 0 && (
                                    <div style={{ marginTop: 4 }}>
                                      {refreshProgress.warnings.map((w, i) => {
                                        const icon = w.kind === "captcha" ? "🤖" : w.kind === "blocked" ? "🚧" : w.kind === "rate-limit" ? "⏱" : w.kind === "timeout" ? "⌛" : w.kind === "network" ? "🌐" : "⚠";
                                        return (
                                          <div
                                            key={`${w.season}|${w.channel}|${w.kind}|${i}`}
                                            style={{ padding: "4px 6px", marginBottom: 3, border: "1px solid #fcd34d", background: "#fffbeb", borderRadius: 3, fontSize: 10, color: "#78350f" }}
                                          >
                                            <span style={{ marginRight: 4 }}>{icon}</span>
                                            <strong>{w.season}</strong>: {w.message}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                  <div style={{ marginTop: 2, fontSize: 9, opacity: 0.6 }}>
                                    Airbnb SearchAPI seasonal pricing refresh with layered markups.
                                  </div>
                                </div>
                              );
                            })()}
                            {!marketRatesRefreshing && effectiveRefreshNotice && (
                              <div
                                style={{
                                  marginBottom: 8,
                                  padding: "8px 10px",
                                  border: `1px solid ${effectiveRefreshNotice.status === "done" ? "#bbf7d0" : "#fecaca"}`,
                                  background: effectiveRefreshNotice.status === "done" ? "#f0fdf4" : "#fef2f2",
                                  borderRadius: 4,
                                  color: effectiveRefreshNotice.status === "done" ? "#14532d" : "#7f1d1d",
                                  fontSize: 11,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 12,
                                  flexWrap: "wrap",
                                }}
                              >
                                <div>
                                  <div style={{ fontWeight: 600 }}>
                                    {effectiveRefreshNotice.status === "done" ? "Finished last scan" : "Last scan failed"}: {formatRefreshNoticeTime(effectiveRefreshNotice.finishedAt)}
                                  </div>
                                  <div style={{ marginTop: 2, opacity: 0.82 }}>
                                    {effectiveRefreshNotice.status === "done"
                                      ? "Airbnb SearchAPI pricing basis has been saved. This notice stays here until you dismiss it."
                                      : (effectiveRefreshNotice.error || effectiveRefreshNotice.label || "The pricing refresh did not complete.")}
                                  </div>
                                  {scannerSchedule?.lastGuestyRatePushAt && (
                                    <div style={{ marginTop: 4, opacity: 0.88 }}>
                                      Last Guesty rate push: <b>{fmtDateTime(scannerSchedule.lastGuestyRatePushAt)}</b>
                                      {scannerSchedule.lastGuestyRatePushStatus === "error" ? " (needs review)" : ""}
                                      {scannerSchedule.lastGuestyRatePushSummary ? ` · ${scannerSchedule.lastGuestyRatePushSummary}` : ""}
                                    </div>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={dismissRefreshNotice}
                                  style={{
                                    fontSize: 10,
                                    padding: "3px 8px",
                                    borderRadius: 4,
                                    border: `1px solid ${effectiveRefreshNotice.status === "done" ? "#86efac" : "#fca5a5"}`,
                                    background: "#ffffff",
                                    color: effectiveRefreshNotice.status === "done" ? "#14532d" : "#7f1d1d",
                                    cursor: "pointer",
                                  }}
                                >
                                  Dismiss
                                </button>
                              </div>
                            )}
                            {/* Per-season basis card — ALWAYS visible
                                when there's persisted basis data for
                                this property. Earlier this only rendered
                                from `liveSnapshot` which is component
                                state set after a successful refresh —
                                meaning the card disappeared on page
                                reload. Now we read primarily from
                                `liveBuyInSummary` (loaded from the cache
                                on mount) and overlay transient channel
                                chips + window dates from `liveSnapshot`
                                when a fresh refresh is available.
                                Survives page reloads. */}
                            {liveBuyInSummary.length > 0 && liveBuyInSummary.some(({ live }) => live != null) && (
                              <div style={{ marginBottom: 10, padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 6, background: "#fafafa", fontSize: 11, color: "#374151" }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
                                  <span style={{ fontWeight: 600 }}>
                                    Airbnb SearchAPI layered basis
                                    {liveSnapshot?.region && (
                                      <span style={{ fontSize: 10, fontWeight: 400, color: "#6b7280", marginLeft: 6 }}>
                                        ({liveSnapshot.region})
                                      </span>
                                    )}
                                  </span>
                                  <span style={{ fontSize: 10, color: "#6b7280" }} title="Rows use persisted 7-night samples from each contiguous season band over the 24-month calendar.">
                                    Auto-refresh weekly · click ↻ to scan now
                                  </span>
                                </div>
                                {/* Window labels — only shown after a
                                    fresh refresh sets liveSnapshot. On
                                    cold load the card still renders
                                    without dates. */}
                                {liveSnapshot && (
                                  <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>
                                    Sample windows:{" "}
                                    {liveSnapshot.seasons.LOW && <>LOW {liveSnapshot.seasons.LOW.checkIn}→{liveSnapshot.seasons.LOW.checkOut}{liveSnapshot.seasons.LOW.daemonOnline ? " 🟢" : " ○"}</>}
                                    {liveSnapshot.seasons.HIGH && <> · HIGH {liveSnapshot.seasons.HIGH.checkIn}→{liveSnapshot.seasons.HIGH.checkOut}</>}
                                    {liveSnapshot.seasons.HOLIDAY && <> · HOLIDAY {liveSnapshot.seasons.HOLIDAY.checkIn}→{liveSnapshot.seasons.HOLIDAY.checkOut}</>}
                                  </div>
                                )}
                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                  {liveBuyInSummary.map(({ bedrooms, community, live }) => {
                                    // Prefer liveSnapshot.perBR row when fresh — it has channel breakdown.
                                    // Otherwise build from cache (live) — no channel chips, just basis values.
                                    const snapshotRow = liveSnapshot?.perBR.find((r) => r.bedrooms === bedrooms);
                                    const low = snapshotRow?.low ?? live?.medianNightly ?? null;
                                    const high = snapshotRow?.high ?? live?.medianNightlyHigh ?? null;
                                    const holiday = snapshotRow?.holiday ?? live?.medianNightlyHoliday ?? null;
                                    const basisSource = snapshotRow?.basisSource
                                      ?? (live?.source === "static-buy-in" ? "static-buy-in" as const
                                        : live?.source === "optimized-buy-in" ? "optimized-buy-in" as const
                                        : live?.source === "live-multichannel-median" ? "live-multichannel-median" as const
                                        : live?.source === "monthly-multichannel-median" ? "monthly-multichannel-median" as const
                                        : live?.source === "season-band-multichannel-median" ? "season-band-multichannel-median" as const
                                        : live?.source === "hybrid-airbnb-layered" ? "hybrid-airbnb-layered" as const
                                        : live?.source === "airbnb" ? "airbnb" as const
                                        : live ? "airbnb" as const : "none" as const);
                                    const channelCount = snapshotRow?.channelCount ?? live?.sampleCount ?? 0;
                                    const channels = snapshotRow?.channels ?? { airbnb: null, vrbo: null, booking: null, pm: null };
                                    const fmtBasis = (n: number | null) => n != null && n > 0 ? `$${n.toLocaleString()}` : "—";
                                    const fmtChip = (n: number | null) => n != null ? `$${n.toLocaleString()}` : "—";
                                    const seasonChip = (season: "LOW" | "HIGH" | "HOLIDAY", value: number | null, color: string) => (
                                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 4, background: value != null && value > 0 ? color : "#f3f4f6", color: value != null && value > 0 ? "#ffffff" : "#9ca3af", fontWeight: 600 }}>
                                        <span style={{ fontSize: 9, opacity: 0.85 }}>{season}</span>
                                        <span>{fmtBasis(value)}</span>
                                      </span>
                                    );
                                    const miniChip = (label: string, value: number | null) => (
                                      <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 5px", borderRadius: 3, background: value != null ? "#e5e7eb" : "transparent", color: "#6b7280", fontSize: 10, fontWeight: 400 }}>
                                        {label} {fmtChip(value)}
                                      </span>
                                    );
                                    return (
                                      <div key={bedrooms} style={{ borderTop: "1px dashed #e5e7eb", paddingTop: 6 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                          <span style={{ fontWeight: 700, minWidth: 38 }}>{bedrooms}BR</span>
                                          {seasonChip("LOW", low, "#059669")}
                                          {seasonChip("HIGH", high, "#d97706")}
                                          {seasonChip("HOLIDAY", holiday, "#dc2626")}
                                          <span style={{ marginLeft: "auto", fontSize: 10, color: "#6b7280" }}>
                                            {basisSource === "static-buy-in"
                                              ? "legacy static buy-in cost basis"
                                              : basisSource === "optimized-buy-in"
                                              ? `LOW = median of ${channelCount} channels`
                                              : basisSource === "monthly-multichannel-median"
                                              ? `LOW = monthly median across ${channelCount} channel samples`
                                              : basisSource === "hybrid-airbnb-layered"
                                              ? `Layered Airbnb SearchAPI basis from ${channelCount} sample${channelCount === 1 ? "" : "s"}`
                                              : basisSource === "season-band-multichannel-median"
                                              ? `LOW = season-band median across ${channelCount} channel samples`
                                              : basisSource === "live-multichannel-median"
                                              ? `LOW = median of ${channelCount} channels`
                                              : basisSource === "airbnb"
                                                ? "LOW = Airbnb-only channel basis"
                                                : "no data"}
                                          </span>
                                        </div>
                                        {/* LOW per-channel mini chips */}
                                        <div style={{ display: "flex", gap: 6, marginTop: 4, paddingLeft: 46, fontSize: 10 }}>
                                          {miniChip("airbnb", channels.airbnb)}
                                          {miniChip("vrbo", channels.vrbo)}
                                          {miniChip("booking", channels.booking)}
                                          {miniChip("pm", channels.pm)}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                                <div style={{ marginTop: 6, fontSize: 10, color: "#6b7280" }}>
                                  Each month uses the persisted Airbnb SearchAPI LOW/HIGH/HOLIDAY basis after specialized layered markups.
                                </div>
                              </div>
                            )}
                            <div style={{ marginBottom: 10, padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 6, background: "#ffffff", fontSize: 11, color: "#374151" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                                <span style={{ fontWeight: 700 }}>Pricing update logs</span>
                                <button
                                  type="button"
                                  onClick={() => void reloadPricingLogs()}
                                  style={{ fontSize: 10, padding: "2px 8px", border: "1px solid #d1d5db", borderRadius: 4, background: "#fff", cursor: "pointer" }}
                                >
                                  Refresh logs
                                </button>
                              </div>
                              {pricingLogsLoading ? (
                                <div style={{ color: "#6b7280" }}>Loading pricing logs...</div>
                              ) : pricingUpdateLogs.length === 0 ? (
                                <div style={{ color: "#6b7280" }}>No hybrid pricing updates have been logged for this property yet.</div>
                              ) : (
                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                  {pricingUpdateLogs.slice(0, 8).map((log) => {
                                    const oldRate = log.oldRate != null ? Number(log.oldRate) : null;
                                    const newRate = log.newRate != null ? Number(log.newRate) : null;
                                    const layers = Array.isArray(log.layersJson) ? log.layersJson : [];
                                    const created = new Date(log.createdAt);
                                    return (
                                      <details key={log.id} style={{ borderTop: "1px dashed #e5e7eb", paddingTop: 6 }}>
                                        <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                          <span style={{ minWidth: 118, color: "#6b7280" }}>{Number.isNaN(created.getTime()) ? log.createdAt : created.toLocaleString()}</span>
                                          <span style={{ fontWeight: 700 }}>{log.triggerType}</span>
                                          <span>{log.bedrooms}BR</span>
                                          <span>{oldRate ? `$${Math.round(oldRate).toLocaleString()}` : "none"} -&gt; {newRate ? `$${Math.round(newRate).toLocaleString()}` : "none"}</span>
                                          <span style={{ padding: "1px 6px", borderRadius: 4, background: log.status === "ok" ? "#dcfce7" : "#fee2e2", color: log.status === "ok" ? "#166534" : "#991b1b", fontWeight: 700 }}>
                                            {log.status}
                                          </span>
                                        </summary>
                                        <div style={{ marginTop: 6, paddingLeft: 8, color: "#4b5563" }}>
                                          {log.notes && <div style={{ marginBottom: 4 }}>{log.notes}</div>}
                                          {layers.length > 0 && (
                                            <div style={{ display: "grid", gap: 3 }}>
                                              {layers.map((layer, idx) => (
                                                <div key={idx} style={{ fontFamily: "ui-monospace, monospace", fontSize: 10 }}>
                                                  L{String(layer.layer ?? idx + 1)} {String(layer.name ?? "Layer")}: x{Number(layer.multiplier ?? 1).toFixed(2)} -&gt; ${Number(layer.after ?? 0).toLocaleString()}
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      </details>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                            {marketComps && (
                              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8, lineHeight: 1.6 }}>
                                <div>
                                  <b>Market benchmark</b> — {marketComps.totalBR}BR comparables in the area, split into <b>Condo tier</b> (direct peers to your bundle — apartments, townhomes, condos) and <b>Villa tier</b> (premium ceiling — detached houses, villas, estates).
                                </div>
                                {(["LOW", "HIGH", "HOLIDAY"] as const).map((s) => {
                                  const season = marketComps.seasons[s];
                                  if (!season) return null;
                                  const condoOk = season.condo.stats.enough;
                                  const villaOk = season.villa.stats.enough;
                                  if (!condoOk && !villaOk) return null;
                                  return (
                                    <div key={s}>
                                      <b>{s}:</b>
                                      {condoOk && (
                                        <span style={{ marginLeft: 6 }}>
                                          Condo median <b>${season.condo.stats.median?.toLocaleString()}</b>
                                          <span style={{ color: "#9ca3af" }}> (p25 ${season.condo.stats.p25?.toLocaleString()} · p75 ${season.condo.stats.p75?.toLocaleString()} · n={season.condo.stats.n})</span>
                                        </span>
                                      )}
                                      {villaOk && (
                                        <span style={{ marginLeft: 12 }}>
                                          Villa median <b>${season.villa.stats.median?.toLocaleString()}</b>
                                          <span style={{ color: "#9ca3af" }}> (p25 ${season.villa.stats.p25?.toLocaleString()} · p75 ${season.villa.stats.p75?.toLocaleString()} · n={season.villa.stats.n})</span>
                                        </span>
                                      )}
                                      {/* Clickable sample listings per tier so the
                                          user can sanity-check whether a comp is
                                          actually comparable (same area, unit type,
                                          bed count). If the classifier mis-tagged
                                          something the link is how you find out. */}
                                      {(condoOk || villaOk) && (
                                        <details style={{ marginLeft: 14, display: "inline" }}>
                                          <summary style={{ cursor: "pointer", color: "#2563eb", display: "inline-block", fontSize: 10 }}>
                                            see comp listings ({(condoOk ? season.condo.sample.length : 0) + (villaOk ? season.villa.sample.length : 0)})
                                          </summary>
                                          <div style={{ marginTop: 4, paddingLeft: 14, borderLeft: "2px solid #e5e7eb" }}>
                                            {condoOk && season.condo.sample.length > 0 && (
                                              <div style={{ marginBottom: 4 }}>
                                                <div style={{ fontWeight: 600, fontSize: 10, color: "#1e40af", marginBottom: 2 }}>
                                                  Condo tier ({season.condo.sample.length} shown)
                                                </div>
                                                {season.condo.sample.map((c, i) => (
                                                  <div key={`condo-${i}`} style={{ fontSize: 10, lineHeight: 1.5 }}>
                                                    <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: "#2563eb", textDecoration: "underline" }}>
                                                      {c.title}
                                                    </a>
                                                    <span style={{ color: "#6b7280" }}>
                                                      {" · "}${c.nightlyRate.toLocaleString()}/night
                                                      {c.bedrooms != null && ` · ${c.bedrooms}BR`}
                                                      {c.propertyType && ` · ${c.propertyType}`}
                                                    </span>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                            {villaOk && season.villa.sample.length > 0 && (
                                              <div>
                                                <div style={{ fontWeight: 600, fontSize: 10, color: "#92400e", marginBottom: 2 }}>
                                                  Villa tier ({season.villa.sample.length} shown)
                                                </div>
                                                {season.villa.sample.map((c, i) => (
                                                  <div key={`villa-${i}`} style={{ fontSize: 10, lineHeight: 1.5 }}>
                                                    <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: "#2563eb", textDecoration: "underline" }}>
                                                      {c.title}
                                                    </a>
                                                    <span style={{ color: "#6b7280" }}>
                                                      {" · "}${c.nightlyRate.toLocaleString()}/night
                                                      {c.bedrooms != null && ` · ${c.bedrooms}BR`}
                                                      {c.propertyType && ` · ${c.propertyType}`}
                                                    </span>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        </details>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            <MarketRateChangeSummary propertyId={propertyId} />
                            <table className="glb-season-table">
                              <thead>
                                <tr>
                                  <th>Month</th>
                                  <th>Season</th>
                                  <th>Buy-In / Night</th>
                                  <th>Sheet Base / Night</th>
                                  <th>Guesty Base / Night</th>
                                  <th>Market Position</th>
                                  <th colSpan={4} style={{ textAlign: "center", borderLeft: "1px solid #e5e7eb" }}>
                                    Estimated Channel Sell Rate + Net Profit — Guesty handles channel rules
                                  </th>
                                </tr>
                                <tr>
                                  <th colSpan={6}></th>
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
                                  const guestyDrift = guesty && Math.abs(guesty.avgRate - sheet) >= 2;
                                  // Guesty now owns channel-level pricing adjustments. For
                                  // display, estimate the sell rate each channel needs to
                                  // clear the margin floor after its host fee.
                                  const channelCells = (["airbnb", "vrbo", "booking", "direct"] as ChannelKey[]).map((ch) => {
                                    const min = minProfitableRate(buyIn, ch, pricingMarginTarget);
                                    if (!guesty) return { ch, sellRate: null, profit: null, margin: null, ok: null, min };
                                    const channelRate = ch === "direct"
                                      ? guesty.avgRate
                                      : Math.max(guesty.avgRate, min);
                                    const netGross = netPayoutAfterChannelFee(channelRate, ch);
                                    // Compute margin from the UN-rounded profit, then round
                                    // profit only for display. Rounding first made cells with
                                    // a margin of 20.003% render as 19.989% (371/1856 vs
                                    // 371.25/1856) — they'd go red even though they cleared
                                    // the floor mathematically.
                                    const rawProfit = netGross - buyIn;
                                    const margin = buyIn > 0 ? rawProfit / buyIn : 0;
                                    const profit = Math.round(rawProfit);
                                    // 0.5bp tolerance so 19.9995% rounds up to "clears the
                                    // floor" instead of flipping cells red on dust.
                                    const ok = margin >= pricingMarginTarget - 0.0005;
                                    return { ch, sellRate: Math.round(channelRate), profit, margin, ok, min };
                                  });
                                  return (
                                    <tr key={row.yearMonth}>
                                      <td style={{ fontWeight: 500 }}>{row.month} {row.year}</td>
                                      <td>
                                        <span className={`glb-season-badge ${row.season}`}>
                                          {getSeasonLabel(row.season)}
                                        </span>
                                      </td>
                                      <td>
                                        {row.previousBuyInTotal != null && row.previousBuyInTotal !== buyIn ? (
                                          <span
                                            title={`Market rate changed from $${row.previousBuyInTotal.toLocaleString()} to $${buyIn.toLocaleString()} on the most recent refresh (${buyIn >= row.previousBuyInTotal ? "+" : ""}${(((buyIn - row.previousBuyInTotal) / row.previousBuyInTotal) * 100).toFixed(1)}%).`}
                                          >
                                            <span style={{ color: "#dc2626", textDecoration: "line-through", fontWeight: 500 }}>
                                              ${row.previousBuyInTotal.toLocaleString()}
                                            </span>
                                            <span style={{ color: "#9ca3af" }}> / </span>
                                            <span style={{ color: "#16a34a", fontWeight: 700 }}>
                                              ${buyIn.toLocaleString()}
                                            </span>
                                            <span style={{ color: buyIn >= row.previousBuyInTotal ? "#b45309" : "#166534", fontSize: 9, marginLeft: 4, fontWeight: 600 }}>
                                              {buyIn >= row.previousBuyInTotal ? "▲" : "▼"}{Math.abs(Math.round(((buyIn - row.previousBuyInTotal) / row.previousBuyInTotal) * 100))}%
                                            </span>
                                          </span>
                                        ) : (
                                          <>${buyIn.toLocaleString()}</>
                                        )}
                                        {row.monthlySampleTotal != null && Math.abs(row.monthlySampleTotal - buyIn) >= 1 && (
                                          <div
                                            style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}
                                            title="Monthly SearchAPI sample total differs from the buy-in shown — reload market rates or check for a partial unit sample."
                                          >
                                            sample ${row.monthlySampleTotal.toLocaleString()} vs buy-in ${buyIn.toLocaleString()}
                                          </div>
                                        )}
                                      </td>
                                      <td style={{ fontWeight: 600 }}>${sheet.toLocaleString()}</td>
                                      <td style={{ fontWeight: 600 }}>
                                        {guesty ? (
                                          <>
                                            ${guesty.avgRate.toLocaleString()}
                                            {guesty.minRate !== guesty.maxRate && (
                                              <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>
                                                ${guesty.minRate.toLocaleString()}–${guesty.maxRate.toLocaleString()}
                                              </div>
                                            )}
                                            {guestyDrift ? (
                                              <div
                                                style={{ display: "inline-block", marginTop: 2, background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600 }}
                                                title={`Guesty calendar shows $${guesty.avgRate.toLocaleString()}/night but the sheet base is $${sheet.toLocaleString()}. Push marked-up rates below to sync.`}
                                              >
                                                ⚠ drift vs sheet (${sheet.toLocaleString()} target)
                                              </div>
                                            ) : (
                                              <div
                                                style={{ display: "inline-block", marginTop: 2, background: "#dcfce7", color: "#166534", padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600 }}
                                                title={`Guesty has ${guesty.days} day${guesty.days === 1 ? "" : "s"} of rate data for this month.`}
                                              >
                                                ✓ in Guesty
                                              </div>
                                            )}
                                          </>
                                        ) : (
                                          <>
                                            <span style={{ color: "#9ca3af" }}>—</span>
                                            <div
                                              style={{ display: "inline-block", marginTop: 2, background: "#fee2e2", color: "#991b1b", padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600 }}
                                              title="No rate published to Guesty's calendar for this month. Click the Guesty rate push button below to populate."
                                            >
                                              ✗ not synced
                                            </div>
                                          </>
                                        )}
                                      </td>
                                      {/* Market positioning — compares this month's
                                          Guesty rate against the CONDO tier (direct
                                          peers) when we have enough samples, otherwise
                                          against the VILLA tier adjusted by a 30%
                                          implied condo-bundle discount. Falls through
                                          to the combined distribution if both tiers
                                          are sparse. */}
                                      <td style={{ fontSize: 11 }}>
                                        {(() => {
                                          const seasonComps = marketComps?.seasons[row.season];
                                          if (!guesty || !seasonComps) {
                                            if (marketCompsLoading) return <span style={{ color: "#9ca3af" }}>…</span>;
                                            return <span style={{ color: "#9ca3af" }}>—</span>;
                                          }
                                          const rate = guesty.avgRate;
                                          // Pick the benchmark tier, in priority order:
                                          //   1. Condo tier (direct peers — ideal)
                                          //   2. Villa tier with 30% premium stripped
                                          //      (villas command a premium over condo
                                          //      bundles; the ceiling comp isn't a
                                          //      fair apples-to-apples number)
                                          //   3. All-comps (last resort)
                                          const VILLA_PREMIUM = 0.30;
                                          let benchmark: { stats: SeasonStats; label: string; disclaimer?: string } | null = null;
                                          if (seasonComps.condo.stats.enough) {
                                            benchmark = { stats: seasonComps.condo.stats, label: "vs condo peers" };
                                          } else if (seasonComps.villa.stats.enough) {
                                            // Scale villa percentiles down by the premium
                                            // to approximate what a condo-bundle equivalent
                                            // would fetch in this market.
                                            const scale = 1 / (1 + VILLA_PREMIUM);
                                            const v = seasonComps.villa.stats;
                                            benchmark = {
                                              stats: {
                                                n: v.n, enough: true,
                                                min:    v.min    != null ? Math.round(v.min    * scale) : null,
                                                max:    v.max    != null ? Math.round(v.max    * scale) : null,
                                                p25:    v.p25    != null ? Math.round(v.p25    * scale) : null,
                                                p40:    v.p40    != null ? Math.round(v.p40    * scale) : null,
                                                median: v.median != null ? Math.round(v.median * scale) : null,
                                                p75:    v.p75    != null ? Math.round(v.p75    * scale) : null,
                                                p90:    v.p90    != null ? Math.round(v.p90    * scale) : null,
                                              },
                                              label: "vs villas −30% premium",
                                              disclaimer: "No condo comps found — villa median discounted 30% as a proxy for condo-bundle equivalent.",
                                            };
                                          } else if (seasonComps.all.stats.enough) {
                                            benchmark = { stats: seasonComps.all.stats, label: "vs all comps" };
                                          }
                                          if (!benchmark) return <span style={{ color: "#9ca3af" }}>—</span>;
                                          const { p25, p40, median, p75, p90 } = benchmark.stats as {
                                            p25: number; p40: number; median: number; p75: number; p90: number;
                                          };
                                          type Verdict = { label: string; bg: string; fg: string };
                                          let v: Verdict;
                                          if (rate <= p25)        v = { label: "Very competitive", bg: "#dcfce7", fg: "#166534" };
                                          else if (rate <= p40)   v = { label: "Competitive",       bg: "#dcfce7", fg: "#166534" };
                                          else if (rate <= p75)   v = { label: "Realistic",         bg: "#dbeafe", fg: "#1e40af" };
                                          else if (rate <= p90)   v = { label: "Premium — slower",  bg: "#fef3c7", fg: "#92400e" };
                                          else                    v = { label: "Too high",           bg: "#fee2e2", fg: "#991b1b" };
                                          const vsMedian = median > 0 ? Math.round(((rate - median) / median) * 100) : 0;
                                          const hoverText =
                                            `Your rate $${rate.toLocaleString()} ${benchmark.label} median $${median.toLocaleString()}`
                                            + ` (${vsMedian >= 0 ? "+" : ""}${vsMedian}%). p25 $${p25.toLocaleString()} · p75 $${p75.toLocaleString()} · p90 $${p90.toLocaleString()} · n=${benchmark.stats.n}.`
                                            + (benchmark.disclaimer ? ` ${benchmark.disclaimer}` : "");
                                          return (
                                            <span
                                              title={hoverText}
                                              style={{ background: v.bg, color: v.fg, padding: "2px 6px", borderRadius: 4, fontWeight: 600, fontSize: 10, whiteSpace: "nowrap" }}
                                            >
                                              {v.label}
                                              <span style={{ marginLeft: 4, fontWeight: 400, opacity: 0.75 }}>
                                                {vsMedian >= 0 ? "+" : ""}{vsMedian}% · {benchmark.label}
                                              </span>
                                            </span>
                                          );
                                        })()}
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
                                        const hoverText =
                                          `Estimated ${c.ch} sell rate after Guesty's channel rules: $${c.sellRate!.toLocaleString()}/night.`
                                          + ` Pushed Guesty base rate: $${guesty!.avgRate.toLocaleString()}/night.`
                                          + ` Floor to hit ${(pricingMarginTarget * 100).toFixed(0)}% on ${c.ch}: $${c.min.toLocaleString()}/night.`
                                          + ` Estimated net profit: $${c.profit.toLocaleString()} (${(c.margin! * 100).toFixed(0)}%).`;
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
                                            <div style={{ fontSize: 12, fontWeight: 700 }}>
                                              Sell ${c.sellRate!.toLocaleString()}
                                            </div>
                                            <div style={{ fontSize: 9, fontWeight: 600, opacity: 0.9 }}>
                                              Net ${c.profit.toLocaleString()} · {(c.margin! * 100).toFixed(0)}%
                                            </div>
                                            <div style={{ fontSize: 9, fontWeight: 400, opacity: 0.75 }}>
                                              base ${guesty!.avgRate.toLocaleString()} · floor ${c.min.toLocaleString()}
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
                              <b>Legend.</b> <b>Guesty Base</b> is the marked-up calendar rate pushed to Guesty. Guesty handles channel pricing rules after this base rate is stored. Channel cells show the estimated sell rate needed to clear that channel's host fee.
                              <span style={{ background: "#dcfce7", color: "#166534", padding: "0 4px", borderRadius: 3, marginLeft: 4 }}>Green</span> = clears {(pricingMarginTarget * 100).toFixed(0)}% floor.
                              {" "}<span style={{ background: "#fee2e2", color: "#991b1b", padding: "0 4px", borderRadius: 3 }}>Red</span> = below floor on that channel — <b>raise the marked-up Guesty rate</b>.
                              {" "}<b>Floor</b> is the minimum guest sell rate needed on that channel. Hover a cell for the full breakdown.
                            </div>
                          </>
                        )}
                      </div>
                    : <div className="glb-empty">No pricing data</div>
                )}

                {/* ── Guesty rate push card ──────────────────────────────── */}
                {activeTab === "pricing" && (
                  <GuestyRatePushCard
                    listingId={selectedId}
                    propertyId={propertyId}
                    seasonalMonths={seasonalMonths}
                    targetMarginPct={targetMarginPct}
                    setTargetMarginPct={setTargetMarginPct}
                    lastGuestyRatePushAt={scannerSchedule?.lastGuestyRatePushAt ?? null}
                    lastGuestyRatePushStatus={scannerSchedule?.lastGuestyRatePushStatus ?? null}
                    lastGuestyRatePushSummary={scannerSchedule?.lastGuestyRatePushSummary ?? null}
                    onGuestyRatePushRecorded={refreshScannerSchedule}
                    refetchGuestyRates={refetchGuestyRates}
                  />
                )}

                {/* ── Booking Rules card (always shown in Pricing tab) ───── */}
                {activeTab === "pricing" && (
                  <div style={{ marginTop: 20, padding: "16px 20px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>📋 Booking Rules</div>
                      {bookingRulesPushInfo?.lastPushedAt && (
                        <span style={{ fontSize: 11, color: bookingRulesPushInfo.lastPushStatus === "error" ? "#991b1b" : "#166534" }}>
                          Last push: <b>{fmtDateTime(bookingRulesPushInfo.lastPushedAt)}</b>
                          {bookingRulesPushInfo.lastPushSummary ? ` · ${bookingRulesPushInfo.lastPushSummary}` : ""}
                        </span>
                      )}
                      <button
                        disabled={!selectedId || !propertyId || pushingBooking}
                        onClick={async () => {
                          if (!selectedId || !propertyId) return;
                          setPushingBooking(true);
                          try {
                            const response = await fetch(`/api/builder/booking-rules/${propertyId}`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ listingId: selectedId, rules: bookingRules }),
                            });
                            const data = await response.json().catch(() => ({}));
                            if (!response.ok || data.success === false) {
                              throw new Error(data.error || data.summary || `Booking rules push failed (${response.status})`);
                            }
                            const saved = data.rules;
                            setBookingRulesPushInfo({
                              lastPushedAt: saved?.lastPushedAt ?? new Date().toISOString(),
                              lastPushStatus: saved?.lastPushStatus ?? "ok",
                              lastPushSummary: saved?.lastPushSummary ?? data.summary ?? null,
                            });
                            toast({
                              title: "Booking rules pushed to Guesty",
                              description: data.summary || `Min ${bookingRules.minNights} nights · ${bookingRules.advanceNotice}d advance notice · ${bookingRules.preparationTime}d prep time`,
                            });
                          } catch (e: any) {
                            toast({ title: "Push failed", description: e.message, variant: "destructive" });
                          } finally {
                            setPushingBooking(false);
                          }
                        }}
                        style={{
                          fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 6,
                          border: "none", cursor: selectedId && propertyId ? "pointer" : "not-allowed",
                          background: pushingBooking ? "#94a3b8" : selectedId && propertyId ? "#0f766e" : "#94a3b8",
                          color: "#fff",
                        }}
                        data-testid="btn-push-booking-rules"
                        title={selectedId && propertyId ? "Push booking rules to Guesty" : "Select a Guesty listing first"}
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

                    {/* Cancellation policies — one per channel.
                        Airbnb / VRBO / Booking.com each have their own
                        enum of accepted policy IDs. The defaults hit
                        "30+ days notice for full refund, 50%+ penalty
                        for late cancellation" where each channel's
                        vocabulary allows it (see state defaults above). */}
                    <div style={{ marginTop: 14, padding: "12px 14px", background: "var(--muted)", borderRadius: 6, border: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                        Cancellation policies by channel
                      </div>
                      <div style={{ fontSize: 10, color: "#92400e", marginBottom: 10, fontStyle: "italic" }}>
                        ⚠ The Airbnb policy syncs to Guesty's top-level booking terms via this button.
                        VRBO &amp; Booking.com choices are saved here for your records; use Guesty's own
                        channel Booking-Rules UI to enforce those per-channel overrides.
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                        {/* Airbnb */}
                        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: "#FF385C" }}>Airbnb</span>
                          <select
                            value={bookingRules.cancellationPolicies.airbnb}
                            onChange={e => setBookingRules(r => ({ ...r, cancellationPolicies: { ...r.cancellationPolicies, airbnb: e.target.value } }))}
                            style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 12, background: "var(--background)", width: "100%" }}
                            data-testid="select-cancellation-policy-airbnb"
                          >
                            <option value="flexible">Flexible — full refund 24h before</option>
                            <option value="moderate">Moderate — full refund 5 days before</option>
                            <option value="firm">Firm — 30d full / 14d 50% / &lt;14d none</option>
                            <option value="strict">Strict — 50% up to 7 days / no refund after</option>
                            <option value="super_strict_30">Super Strict 30 — 50% up to 30 days / none after</option>
                            <option value="super_strict_60">Super Strict 60 — 50% up to 60 days / none after</option>
                            <option value="non_refundable">Non-refundable</option>
                          </select>
                        </label>

                        {/* VRBO */}
                        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: "#245ABC" }}>VRBO</span>
                          <select
                            value={bookingRules.cancellationPolicies.vrbo}
                            onChange={e => setBookingRules(r => ({ ...r, cancellationPolicies: { ...r.cancellationPolicies, vrbo: e.target.value } }))}
                            style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 12, background: "var(--background)", width: "100%" }}
                            data-testid="select-cancellation-policy-vrbo"
                          >
                            <option value="RELAXED">Relaxed — 14d full / 7d 50%</option>
                            <option value="MODERATE">Moderate — 30d full / 14d 50%</option>
                            <option value="FIRM">Firm — 60d full / 30d 50% / &lt;30d none</option>
                            <option value="STRICT">Strict — 60d full / 30d 50% / &lt;30d none (stricter enforcement)</option>
                            <option value="NO_REFUND">No refund</option>
                          </select>
                        </label>

                        {/* Booking.com */}
                        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: "#003580" }}>Booking.com</span>
                          <select
                            value={bookingRules.cancellationPolicies.booking}
                            onChange={e => setBookingRules(r => ({ ...r, cancellationPolicies: { ...r.cancellationPolicies, booking: e.target.value } }))}
                            style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 12, background: "var(--background)", width: "100%" }}
                            data-testid="select-cancellation-policy-booking"
                          >
                            <option value="flexible">Flexible — free cancellation until X days</option>
                            <option value="moderate">Moderate — partial refund</option>
                            <option value="strict">Strict — limited refund</option>
                            <option value="non_refundable">Non-refundable</option>
                          </select>
                          <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>Exact day thresholds are configured in the Booking Extranet — this picks the shape.</span>
                        </label>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === "availability" && (
                  <AvailabilityTab propertyId={propertyId} listingId={selectedId} />
                )}

                {activeTab === "otaVisibility" && (
                  <OtaVisibilityPanel propertyId={propertyId} />
                )}

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
                                          ⏳ {normalizeScope === "all" ? `${normalizePhotoListingName || "starting…"} — ` : ""}
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

                              {/* ── Photo Community Check ─────────────────────
                                  Operator QA: confirms the community folder +
                                  every unit are the same community, and flags
                                  junk / mis-filed photos + cross-folder dupes.
                                  Local-photo check — no Guesty listing needed. */}
                              <div style={{ marginBottom: 10, padding: 10, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                  <button
                                    className="glb-btn"
                                    onClick={runCommunityCheck}
                                    disabled={communityCheckPhase === "running"}
                                    data-testid="btn-photo-community-check"
                                    style={{ fontSize: 12, background: "#ecfeff", color: "#155e75", border: "1px solid #a5f3fc" }}
                                  >
                                    {communityCheckPhase === "running" ? "🔎 Checking photos…" : "🔎 Check photo community"}
                                  </button>
                                  <span style={{ fontSize: 11, color: "#64748b", flex: 1, minWidth: 220 }}>
                                    AI-confirms the community folder and each unit are all the SAME community, and flags junk / mis-filed photos and the same photo appearing in two folders.
                                  </span>
                                </div>

                                {communityCheckPhase === "running" && (
                                  <div style={{ fontSize: 11, color: "#0e7490", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#06b6d4", animation: "glb-blink 1s infinite" }} />
                                    Analyzing photos with AI vision — usually 20-40 seconds…
                                  </div>
                                )}

                                {communityCheckPhase === "error" && (
                                  <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 8 }}>✗ {communityCheckError}</div>
                                )}

                                {communityCheckPhase === "done" && communityCheckResult && (() => {
                                  const r = communityCheckResult;
                                  const vStyle = r.verdict === "pass"
                                    ? { bg: "#dcfce7", fg: "#15803d", label: "✓ Pass" }
                                    : r.verdict === "fail"
                                    ? { bg: "#fee2e2", fg: "#b91c1c", label: "✗ Problem found" }
                                    : { bg: "#fef9c3", fg: "#92400e", label: "⚠ Review needed" };
                                  // Binary badge for the same-community axis — never "Uncertain".
                                  // Defaults to Yes (no positive contradiction = same community),
                                  // mirroring the server's asYesNo() mapping so the operator always
                                  // gets a definite yes/no, not a maybe.
                                  const yn = (s?: "yes" | "no") =>
                                    s === "no" ? { bg: "#fee2e2", fg: "#b91c1c", label: "No" }
                                    : { bg: "#dcfce7", fg: "#15803d", label: "Yes" };
                                  const badge = (c: { bg: string; fg: string }): CSSProperties => ({
                                    display: "inline-block", fontSize: 10.5, fontWeight: 600, padding: "1px 7px",
                                    borderRadius: 10, background: c.bg, color: c.fg,
                                  });
                                  const card: CSSProperties = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px", marginTop: 6 };
                                  const rowS: CSSProperties = { fontSize: 11.5, color: "#334155", marginTop: 2 };
                                  const muted: CSSProperties = { color: "#64748b" };
                                  const flagList = (flags: CommunityCheckFlag[], heading: string, color: string) =>
                                    flags.length > 0 ? (
                                      <div style={{ marginTop: 3 }}>
                                        <span style={{ fontSize: 11, fontWeight: 600, color }}>{heading}:</span>
                                        <ul style={{ margin: "2px 0 0 0", paddingLeft: 18, fontSize: 11, color: "#475569" }}>
                                          {flags.map((f, i) => (
                                            <li key={i}><code style={{ color: "#0e7490" }}>{f.id}</code>{f.caption ? ` "${f.caption}"` : ""} — {f.reason}</li>
                                          ))}
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
                                    communityMatch === "no" ||
                                    unitMatches.some((m) => m === "no") ||
                                    r.allSameCommunity === "no";
                                  const nothingToCompare = !anyDifferent && comparableSets < 2;
                                  const sameStyle =
                                    anyDifferent
                                      ? { bg: "#fee2e2", fg: "#b91c1c", label: "✗ FAILED — NOT all the same community" }
                                      : nothingToCompare
                                      ? { bg: "#f1f5f9", fg: "#475569", label: "ⓘ Only one photo set — attach units to compare" }
                                      : { bg: "#dcfce7", fg: "#15803d", label: "✓ YES — all the same community" };
                                  // Roster: community folder first, then each unit, each as
                                  // "<label> is <identified community>" + a same/different badge.
                                  const rosterRows: Array<{ label: string; identified: string; status?: "yes" | "no"; vsLabel: string }> = [];
                                  if (r.community) {
                                    rosterRows.push({
                                      label: r.community.label,
                                      identified: r.community.identifiedCommunity,
                                      status: r.community.matchesExpected,
                                      vsLabel: r.expectedCommunity ? `vs UI “${r.expectedCommunity}”` : "reference set",
                                    });
                                  }
                                  for (const u of r.units) {
                                    rosterRows.push({
                                      label: u.label,
                                      identified: u.identifiedCommunity,
                                      status: u.sameAsCommunity,
                                      vsLabel: r.community ? "vs community folder" : "vs other units",
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
                                        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                                          {rosterRows.map((row, i) => {
                                            const t = yn(row.status);
                                            return (
                                              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12, flexWrap: "wrap" }}>
                                                <span style={{ fontWeight: 600, color: "#0f172a" }}>{row.label}</span>
                                                <span style={{ color: "#64748b" }}>is</span>
                                                <b style={{ color: "#0f172a" }}>{row.identified}</b>
                                                <span style={{ ...badge(t), marginLeft: "auto" }}>{t.label}</span>
                                                <span style={{ fontSize: 10, color: "#94a3b8" }}>{row.vsLabel}</span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                        {r.expectedCommunity ? (
                                          <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 7 }}>UI community: “{r.expectedCommunity}”</div>
                                        ) : null}
                                      </div>
                                      )}

                                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                        <span style={{ ...badge(vStyle), fontSize: 12, padding: "2px 10px" }}>{vStyle.label}</span>
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
                                          <div style={rowS}>
                                            Matches expected{r.expectedCommunity ? ` ("${r.expectedCommunity}")` : ""}: <span style={badge(yn(r.community.matchesExpected))}>{yn(r.community.matchesExpected).label}</span>
                                            {r.community.matchReason ? <span style={muted}> — {r.community.matchReason}</span> : null}
                                          </div>
                                          {!r.community.allSameCommunity && (
                                            <div style={{ ...rowS, color: "#b45309" }}>⚠ Not all community photos look like the same place.</div>
                                          )}
                                          {flagList(r.community.outliers, "Possible different-community photos", "#b45309")}
                                          {flagList(r.community.junk, "Junk / mis-filed", "#b45309")}
                                        </div>
                                      )}

                                      {r.units.map((u, i) => {
                                        const t = yn(u.sameAsCommunity);
                                        return (
                                          <div key={i} style={card}>
                                            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                                              <span style={{ fontWeight: 600, fontSize: 12, color: "#0f172a" }}>{u.label}</span>
                                              <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: "auto" }}>{u.photosChecked}/{u.photosTotal} checked</span>
                                            </div>
                                            <div style={rowS}>Identified as: <b>{u.identifiedCommunity}</b></div>
                                            <div style={rowS}>
                                              Same community as community photos: <span style={badge(t)}>{t.label}</span>
                                              {u.reason ? <span style={muted}> — {u.reason}</span> : null}
                                            </div>
                                            {u.allSameUnit === false && (
                                              <div style={{ ...rowS, color: "#b45309" }}>⚠ Not all photos look like the same unit.</div>
                                            )}
                                            {flagList(u.outliers, "Possible odd-one-out photos", "#b45309")}
                                            {flagList(u.junk, "Junk / mis-filed", "#b45309")}
                                          </div>
                                        );
                                      })}

                                      {crossDupes.length > 0 && (
                                        <div style={{ ...card, background: "#fffbeb", borderColor: "#fde68a" }}>
                                          <div style={{ fontWeight: 600, fontSize: 11.5, color: "#92400e", marginBottom: 3 }}>⚠ Same photo found in more than one folder</div>
                                          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "#92400e" }}>
                                            {crossDupes.map((d, i) => (
                                              <li key={i}><code>{d.a.folder}/{d.a.filename}</code> ↔ <code>{d.b.folder}/{d.b.filename}</code></li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}

                                      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 6 }}>
                                        {r.photosChecked} photos analyzed · {(r.elapsedMs / 1000).toFixed(0)}s · {r.model}
                                        {r.warning && r.ok ? ` · note: ${r.warning}` : ""}
                                      </div>
                                    </div>
                                  );
                                })()}
                              </div>

                              {/* Cover collage lives inside PhotoCurator now —
                                  see the banner at the top of the tile grid. */}

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
                                  ? "Upscaling + hosting for Guesty — ~30s per photo. Progress saved to Guesty every 5 photos."
                                  : "Hosting for Guesty — a few seconds per photo. Progress saved to Guesty every 5 photos."}
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

                        {/* Curation grid — simple tiles in Zillow's order,
                            with a cover-collage banner at the top that lets
                            the operator choose two photos, stitches them into
                            a single 2-up cover, and sets it as the Guesty
                            listing cover. */}
                        <PhotoCurator
                          photos={photos}
                          sourceUrlsByFolder={sourceUrlsByFolder}
                          onOverridesChanged={onPhotoOverridesChanged}
                          coverCollageEnabled={photos.length >= 2}
                          coverCollageDisabledReason={!selectedId ? "Select a Guesty listing above to push the collage as cover." : null}
                          coverCollageCurrentUrl={guestyCoverCollageUrl}
                          onRequestCoverCollage={(selection) => { setCollagePhase("idle"); generateCoverCollage(photos, selection); }}
                          coverCollageStatus={{
                            phase: collagePhase === "upscaling" ? "generating" : collagePhase,
                            error: collageError,
                            preview: collagePreviewUrl,
                            picks: collagePicks
                              ? { community: collagePicks.community, patio: collagePicks.patio }
                              : null,
                          }}
                        />

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
