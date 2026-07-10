import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  ArrowRight,
  RotateCcw,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  Camera,
  Search,
  MapPin,
  Link2,
} from "lucide-react";
import { getUnitBuilderByPropertyId, type PropertyUnitBuilder } from "@/data/unit-builder-data";
import { useAssistantContext } from "@/lib/assistant-context";
import { loadDraftPropertyByNegativeId } from "@/data/adapt-draft";
import { apiRequest } from "@/lib/queryClient";
import { UnitReplacementFlow, type ReplacementUnitData } from "@/components/unit-replacement-flow";
import { OperationFailureActions } from "@/components/OperationFailureActions";
import { useToast } from "@/hooks/use-toast";
import { replacementPhotoFolderForUnit } from "@shared/unit-swap-photos";
import {
  communityAddressRuleForName,
  inferCommunityStreetAddress,
  parseCityFromMailingAddress,
} from "@shared/community-addresses";
import { mergeUnitVerdict, DEEP_PHOTO_MIN } from "@shared/preflight-verdict";
import { confirmCommunityLocation, type LocationConfirmation } from "@shared/photo-location-confirmation";
import { communityPhotosCorrectAnswer } from "@shared/photo-community-check-logic";

type PreflightPhotoFetchJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  message: string;
  progress: number;
  unitId: string;
  savedCount: number | null;
  /** What a re-pull changed on disk: "gallery already current — no changes" / "3 new, 1 removed…". */
  changeNote?: string | null;
  sourceUrl: string | null;
  proof?: Record<string, unknown> | null;
  diagnostic?: Record<string, unknown> | null;
  error: string | null;
};

type CommunityRepullJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  message: string;
  progress: number;
  communityName: string;
  communityFolder: string;
  researchSummary: string | null;
  candidatesFound: number | null;
  savedCount: number | null;
  removedCount: number | null;
  verifiedCount: number | null;
  verdict: string | null;
  removed: Array<{ filename?: string; reason: string }>;
  locationConfirmation: LocationConfirmation | null;
  error: string | null;
};

// Renders the state/city confirmation for a community re-pull or a unit photo
// fetch: red when the location contradicts the expected state (e.g. a "Bay
// Watch" unit filed under Florida when Bay Watch is in South Carolina), green
// when the state is positively confirmed, amber when it could not be confirmed.
function LocationConfirmationNote({ confirmation }: { confirmation: LocationConfirmation | null }) {
  if (!confirmation) return null;
  const status = confirmation.status;
  const cls =
    status === "mismatch"
      ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
      : status === "match"
        ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300"
        : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300";
  const Icon = status === "mismatch" ? AlertTriangle : status === "match" ? CheckCircle2 : MapPin;
  // The overall verdict is state-driven, so a `mismatch` is always a wrong state.
  const label = status === "match" ? "Location confirmed" : status === "mismatch" ? "Wrong state" : "Location";
  return (
    <div className={`mt-1.5 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${cls}`}>
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span><span className="font-medium">{label}:</span> {confirmation.note}</span>
    </div>
  );
}

// A sticky, dismissible "last processed" receipt for a long-running operation
// (re-pulling a unit's photos, running the OTA unit audit). The operator asked
// for a confirmation that STAYS on screen after the work finishes — telling
// them when it last ran and whether it succeeded — until they click the × to
// dismiss it. Green when the operation succeeded, red when it failed.
type OperationReceipt = {
  timestamp: number; // ms epoch
  success: boolean;
  title: string; // e.g. "Photos re-pulled" / "Full unit audit"
  detail: string; // human summary or error message
  jobId?: string; // de-dupes repeat records for the same finished job
};

function OperationReceiptNote({
  receipt,
  relative,
  onDismiss,
  testId,
}: {
  receipt: OperationReceipt;
  relative: (ts: number) => string;
  onDismiss: () => void;
  testId?: string;
}) {
  const cls = receipt.success
    ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300"
    : "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200";
  const Icon = receipt.success ? CheckCircle2 : AlertTriangle;
  return (
    <div
      className={`basis-full flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px] ${cls}`}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <span className="font-medium">{receipt.title}</span>{" "}
        <span className="opacity-90">· last run {relative(receipt.timestamp)}</span>
        <p className="opacity-90">{receipt.detail}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto text-base leading-none px-1 opacity-70 hover:opacity-100"
        aria-label="Dismiss confirmation"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

const communityRepullJobStorageKey = (propertyId: number) => `preflight.communityRepullJob.v1:${propertyId}`;

const photoFetchJobStorageKey = (propertyId: number) => `preflight.photoFetchJob.v1:${propertyId}`;
const loadPhotoFetchJobIds = (propertyId: number): Record<string, string> => {
  try {
    const raw = localStorage.getItem(photoFetchJobStorageKey(propertyId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};
const savePhotoFetchJobIds = (propertyId: number, next: Record<string, string>) => {
  try {
    if (Object.keys(next).length === 0) {
      localStorage.removeItem(photoFetchJobStorageKey(propertyId));
    } else {
      localStorage.setItem(photoFetchJobStorageKey(propertyId), JSON.stringify(next));
    }
  } catch { /* ignore */ }
};

// Full unit audit / platform check — one in-flight job per property, persisted so
// the operator can leave the tab and re-attach on return.
const auditJobStorageKey = (propertyId: number) => `preflight.auditJob.v1:${propertyId}`;
const loadAuditJobId = (propertyId: number): string | null => {
  try { return localStorage.getItem(auditJobStorageKey(propertyId)); } catch { return null; }
};
const saveAuditJobId = (propertyId: number, jobId: string | null) => {
  try {
    if (jobId) localStorage.setItem(auditJobStorageKey(propertyId), jobId);
    else localStorage.removeItem(auditJobStorageKey(propertyId));
  } catch { /* ignore */ }
};

// Per-unit rescrape — a map of photoFolder → in-flight jobId, persisted per property.
const rescrapeJobStorageKey = (propertyId: number) => `preflight.rescrapeJobs.v1:${propertyId}`;
const loadRescrapeJobIds = (propertyId: number): Record<string, string> => {
  try {
    const raw = localStorage.getItem(rescrapeJobStorageKey(propertyId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
};
const saveRescrapeJobIds = (propertyId: number, next: Record<string, string>) => {
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(rescrapeJobStorageKey(propertyId));
    else localStorage.setItem(rescrapeJobStorageKey(propertyId), JSON.stringify(next));
  } catch { /* ignore */ }
};

// ── Types ─────────────────────────────────────────────────────────────────────

type UnitPlatformResult = {
  status: "confirmed" | "photo-confirmed" | "not-listed" | "error";
  url: string | null;
  detection: string;
};

type UnitCheckResult = {
  unitId: string;
  unitNumber: string;
  address: string;
  platforms: {
    airbnb: UnitPlatformResult;
    vrbo: UnitPlatformResult;
    booking: UnitPlatformResult;
  };
};

// Maps unitId → per-platform result (populated progressively as checks complete)
type ProgressiveResults = Record<string, UnitCheckResult>;

// A swapped unit's effective display data
type UnitOverride = {
  unitNumber: string;
  address: string;
  bedrooms: number;
  unitLabel: string;
  sourceUrl: string;
  photoFolder?: string;
  swapId?: number;
};

// Friendly name for the scrape source (Zillow / Redfin / VRBO …) from the
// stored `_source.json` platform field, falling back to the URL hostname.
function sourcePlatformLabel(source: { url: string; platform?: string } | null | undefined): string {
  if (!source) return "source";
  const p = (source.platform || "").toLowerCase();
  if (p === "zillow") return "Zillow";
  if (p === "redfin") return "Redfin";
  if (p === "homes.com") return "Homes.com";
  if (p === "realtor") return "Realtor.com";
  if (p === "vrbo") return "VRBO";
  if (p === "airbnb") return "Airbnb";
  try {
    const host = new URL(source.url).hostname.replace(/^www\./, "");
    if (/zillow/i.test(host)) return "Zillow";
    if (/redfin/i.test(host)) return "Redfin";
    if (/realtor/i.test(host)) return "Realtor.com";
    if (/homes\.com/i.test(host)) return "Homes.com";
    if (/vrbo/i.test(host)) return "VRBO";
    if (/airbnb/i.test(host)) return "Airbnb";
    return host;
  } catch {
    return "source";
  }
}

function formatUnitDisplayLabel(unitNumber: string): string {
  const raw = String(unitNumber || "").trim();
  if (!raw) return "Unit";
  if (/^(unit|units|apt\.?|apartment|suite|ste\.?|building|townhome|main|guest)\b/i.test(raw)) {
    return raw;
  }
  return `Unit ${raw}`;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({
  result,
  checking,
}: {
  result: UnitPlatformResult | undefined;
  checking: boolean;
}) {
  if (checking) {
    return (
      <span className="status-checking inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-muted text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking…
      </span>
    );
  }
  if (!result) {
    // Check finished with no data — show "Unavailable", never the spinner.
    return (
      <span className="status-error inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
        <AlertTriangle className="h-3 w-3" /> Unavailable
      </span>
    );
  }
  switch (result.status) {
    case "confirmed":
    case "photo-confirmed":
      return (
        <span className="status-confirmed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
          <CheckCircle2 className="h-3 w-3" /> Yes — Listed
        </span>
      );
    case "not-listed":
      return (
        <span className="status-not-listed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">
          <XCircle className="h-3 w-3" /> No — Not Listed
        </span>
      );
    default:
      return (
        <span className="status-error inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
          <AlertTriangle className="h-3 w-3" /> Could not verify
        </span>
      );
  }
}

function CompactStatusBadge({
  result,
  checking,
}: {
  result: UnitPlatformResult | undefined;
  checking: boolean;
}) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium whitespace-nowrap";
  if (checking) {
    return (
      <span className={`${base} bg-muted text-muted-foreground`}>
        <Loader2 className="h-3 w-3 animate-spin" /> Checking
      </span>
    );
  }
  if (!result) {
    // The unit's check already finished but this platform has no result (e.g. the
    // text check is off / unavailable). NEVER fall back to the spinner here — a
    // missing result with checking=false is exactly what made it "spin forever".
    return (
      <span className={`${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400`}>
        <AlertTriangle className="h-3 w-3" /> Unavailable
      </span>
    );
  }
  switch (result.status) {
    case "confirmed":
    case "photo-confirmed":
      return (
        <span className={`${base} bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300`}>
          <CheckCircle2 className="h-3 w-3" /> Yes
        </span>
      );
    case "not-listed":
      return (
        <span className={`${base} bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300`}>
          <XCircle className="h-3 w-3" /> No
        </span>
      );
    default:
      return (
        <span className={`${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400`}>
          <AlertTriangle className="h-3 w-3" /> Error
        </span>
      );
  }
}

// Whether a status is "listed" (should suggest replacing the unit)
function isListedStatus(status: UnitPlatformResult["status"]) {
  return status === "confirmed" || status === "photo-confirmed";
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_LIST: { key: keyof UnitCheckResult["platforms"]; label: string }[] = [
  { key: "airbnb",  label: "Airbnb" },
  { key: "vrbo",    label: "VRBO" },
  { key: "booking", label: "Booking.com" },
];

// Cached photo-listing-check row for one unit folder (from /api/preflight/photo-check).
// status: "found" = the unit's interior photos match a live listing on that channel;
// "clean" = checked, no match; "unknown" = couldn't check (API hiccup); undefined = not scanned.
type PhotoMatchStatus = "clean" | "found" | "unknown";
type PhotoCheckRow = {
  folder: string;
  scanned: boolean;
  airbnb?: PhotoMatchStatus;
  vrbo?: PhotoMatchStatus;
  booking?: PhotoMatchStatus;
  airbnbMatches?: Array<{ listingUrl?: string; title?: string }>;
  vrboMatches?: Array<{ listingUrl?: string; title?: string }>;
  bookingMatches?: Array<{ listingUrl?: string; title?: string }>;
  // How many photos this scan reverse-image-searched. The deep Full-unit-audit scans the whole
  // gallery; the background scheduler only scans 3. Used to decide whether a "clean" is decisive.
  photosChecked?: number;
  checkedAt?: string;
  error?: string | null;
};

// Server-side "Full unit audit" / "Run check" job (server/preflight-background-jobs.ts).
// The check now runs server-side so the operator can fire it and leave the tab;
// the client polls this and rehydrates the platform-check UI from it.
type PreflightAuditJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: "queued" | "text" | "photo" | "completed" | "failed";
  message: string;
  progress: number;
  fullPhotoAudit: boolean;
  totalUnits: number;
  completedCount: number;
  results: Record<string, UnitCheckResult>;
  receipt: { timestamp: number; success: boolean; title: string; detail: string } | null;
  photoChecks: Record<string, PhotoCheckRow> | null;
  photoBudget: { used: number; cap: number | null; remaining: number | null } | null;
  deepPhotoStarted: boolean;
  startedAt: number | null;
  error: string | null;
};

// Server-side per-unit "Rescrape photos" job.
type PreflightRescrapeJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: "queued" | "scraping" | "completed" | "failed";
  message: string;
  progress: number;
  folder: string;
  needsUrl: boolean;
  savedCount: number | null;
  bedroomCount: number | null;
  bathroomCount: number | null;
  sourceUrl: string | null;
  urlSource: string | null;
  coverage: { bedroomsShortfall?: number; bathroomsShortfall?: number; bedroomsExpected?: number; bedroomsFound?: number } | null;
  error: string | null;
};

// ── Main component ────────────────────────────────────────────────────────────

// ── Community Match check (photos + source pages vs the community folder) ──
// Preflight surface for the builder Photos-tab "Check photo community" engine:
// POST /api/builder/photo-community-check with { propertyId } alone makes the
// SERVER rebuild the photo groups (published folders + captions + each unit
// folder's _source.json source URL) via buildPhotoCommunityCheckRequestForProperty,
// run Google Lens + Claude vision on the photos AND a Claude read of each unit's
// source listing page, and persist the result. Types mirror only the fields this
// card renders from PhotoCommunityCheckResult (server/photo-community-check.ts).
type CommunityMatchSourcePage = {
  unitLabel: string;
  url: string;
  match: "yes" | "no" | "uncertain";
  identifiedCommunity?: string;
  identifiedLocation?: string;
  reason: string;
  unreadable?: boolean;
};
type CommunityMatchFlaggedPhoto = { id: string; caption?: string; reason: string };
type CommunityMatchResult = {
  ok: boolean;
  verdict: "pass" | "warn" | "fail";
  summary: string;
  concerns: string[];
  expectedCommunity: string;
  allSameCommunity: "yes" | "no";
  community: {
    label: string;
    identifiedCommunity: string;
    matchesExpected: "yes" | "no";
    overallStatus?: string;
    photosChecked?: number;
    photosTotal?: number;
    matchReason?: string;
    recommendation?: string;
    outliers?: CommunityMatchFlaggedPhoto[];
    junk?: CommunityMatchFlaggedPhoto[];
  } | null;
  units: Array<{ label: string; sameAsCommunity: "yes" | "no"; reason: string }>;
  sourcePages?: CommunityMatchSourcePage[];
};

export default function BuilderPreflight() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const [, setLocation] = useLocation();
  const id = parseInt(propertyId || "0", 10);
  const staticProperty = getUnitBuilderByPropertyId(id);

  // Draft fallback: when the static lookup misses AND the id is
  // negative (the convention the dashboard uses for promoted
  // drafts: -draftId), fetch /api/community/drafts and adapt the
  // matching draft to PropertyUnitBuilder shape. Lets the builder
  // operate on promoted drafts without migrating them into the
  // static unitBuilderData array. Per-unit photo folders are
  // fetched alongside so the units' photos array is populated
  // (the wizard persists photos to disk via /persist-photos on
  // save; this just lists them).
  const [draftProperty, setDraftProperty] = useState<PropertyUnitBuilder | null>(null);
  const [draftLoading, setDraftLoading] = useState<boolean>(!staticProperty && id < 0);
  useEffect(() => {
    if (staticProperty || id >= 0) return;
    setDraftLoading(true);
    loadDraftPropertyByNegativeId(id)
      .then((p) => { if (p) setDraftProperty(p); })
      .catch(() => { /* leave draftProperty null → renders the not-found state */ })
      .finally(() => setDraftLoading(false));
  }, [id, staticProperty]);
  const property = staticProperty ?? draftProperty;
  const isPromotedDraft = id < 0;

  // Publish what the operator is looking at to the dashboard assistant ("Magical")
  // so it acts on this listing (community, address, units) instead of asking.
  useAssistantContext(
    property
      ? {
          page: "Pre-flight check — is this unit already listed?",
          description:
            "Operator is reviewing a listing's photos and checking whether its units are already on Airbnb/VRBO/Booking before publishing.",
          data: {
            propertyId: id,
            community: property.complexName,
            propertyName: property.propertyName,
            address: property.address,
            units: property.units.map((u) => ({ id: u.id, bedrooms: u.bedrooms })),
          },
        }
      : null,
  );

  const { toast } = useToast();

  // Community Match: one-click "are Unit A + Unit B in the same community as the
  // community folder?" — photos AND source pages. See the type block above.
  const [communityMatchRunning, setCommunityMatchRunning] = useState(false);
  const [communityMatchResult, setCommunityMatchResult] = useState<CommunityMatchResult | null>(null);
  const [communityMatchError, setCommunityMatchError] = useState<string | null>(null);
  const runCommunityMatchCheck = async () => {
    setCommunityMatchRunning(true);
    setCommunityMatchError(null);
    setCommunityMatchResult(null);
    try {
      // Plain fetch (not apiRequest): the check runs Lens + batched vision and can
      // take minutes; we also want the JSON error body on a non-2xx.
      const resp = await fetch("/api/builder/photo-community-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId: id }),
      });
      const data = (await resp.json().catch(() => null)) as
        | CommunityMatchResult
        | { error?: string }
        | null;
      if (!resp.ok || !data || !("verdict" in data)) {
        setCommunityMatchError((data as { error?: string } | null)?.error || `HTTP ${resp.status}`);
        return;
      }
      setCommunityMatchResult(data);
    } catch (e: any) {
      setCommunityMatchError(e?.message ?? String(e));
    } finally {
      setCommunityMatchRunning(false);
    }
  };

  // Community Photos card: "are the CURRENT community folder photos actually of
  // this community?" — same engine as the Community Match card but scoped to the
  // community folder only ({ communityOnly: true }); the server never persists a
  // community-only result over the dashboard Community QA status.
  const [communityPhotosCheckRunning, setCommunityPhotosCheckRunning] = useState(false);
  const [communityPhotosCheckResult, setCommunityPhotosCheckResult] = useState<CommunityMatchResult | null>(null);
  const [communityPhotosCheckError, setCommunityPhotosCheckError] = useState<string | null>(null);
  const runCommunityPhotosCheck = async () => {
    setCommunityPhotosCheckRunning(true);
    setCommunityPhotosCheckError(null);
    setCommunityPhotosCheckResult(null);
    try {
      // Plain fetch (not apiRequest): Lens runs per community photo, so this can
      // take minutes; we also want the JSON error body on a non-2xx.
      const resp = await fetch("/api/builder/photo-community-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId: id, communityOnly: true }),
      });
      const data = (await resp.json().catch(() => null)) as
        | CommunityMatchResult
        | { error?: string }
        | null;
      if (!resp.ok || !data || !("verdict" in data)) {
        setCommunityPhotosCheckError((data as { error?: string } | null)?.error || `HTTP ${resp.status}`);
        return;
      }
      setCommunityPhotosCheckResult(data);
    } catch (e: any) {
      setCommunityPhotosCheckError(e?.message ?? String(e));
    } finally {
      setCommunityPhotosCheckRunning(false);
    }
  };


  // Sticky rescrape results — persisted to localStorage so the user can
  // navigate away and come back and still see when they last rescraped a
  // folder + how many bedrooms/bathrooms came back. Keyed by folder so
  // multiple swaps for the same property each remember their own state.
  type RescrapeReceipt = {
    folder: string;
    timestamp: number;       // ms epoch
    savedCount: number;
    bedroomCount: number;
    bathroomCount: number;
    sourceUrl?: string;
    urlSource?: string;      // "supplied" | "_source.json" | "unit_swap" | "community_map"
  };
  const RESCRAPE_RECEIPTS_KEY = "preflight.rescrapeReceipts.v1";
  const loadReceipts = (): Record<string, RescrapeReceipt> => {
    try {
      const raw = localStorage.getItem(RESCRAPE_RECEIPTS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  };
  const saveReceipts = (next: Record<string, RescrapeReceipt>) => {
    try { localStorage.setItem(RESCRAPE_RECEIPTS_KEY, JSON.stringify(next)); } catch {}
  };
  const [rescrapeReceipts, setRescrapeReceipts] = useState<Record<string, RescrapeReceipt>>(() => loadReceipts());
  const recordRescrape = (folder: string, data: RescrapeReceipt) => {
    setRescrapeReceipts((prev) => {
      const next = { ...prev, [folder]: data };
      saveReceipts(next);
      return next;
    });
  };
  const dismissReceipt = (folder: string) => {
    setRescrapeReceipts((prev) => {
      const next = { ...prev };
      delete next[folder];
      saveReceipts(next);
      return next;
    });
  };
  // Tick every 30s so the relative timestamps ("2m ago") stay fresh.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const fmtRelative = (ts: number): string => {
    const diff = nowTick - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  };

  // ── Sticky "last processed" receipts ──────────────────────────────────────
  // The operator asked that re-scraping a unit's photos and running the OTA
  // unit audit each leave a confirmation that sticks (with an × to dismiss),
  // showing when it last ran and whether it succeeded. Persisted to
  // localStorage per property so it survives leaving and returning to the page.
  // Photo-fetch receipts are keyed by unitId; the platform check has one.
  const photoFetchReceiptsKey = (propertyId: number) => `preflight.photoFetchReceipts.v1:${propertyId}`;
  const platformCheckReceiptKey = (propertyId: number) => `preflight.platformCheckReceipt.v1:${propertyId}`;
  const [photoFetchReceipts, setPhotoFetchReceipts] = useState<Record<string, OperationReceipt>>(() => {
    try {
      const raw = localStorage.getItem(photoFetchReceiptsKey(id));
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const recordPhotoFetchReceipt = (unitId: string, receipt: OperationReceipt) => {
    setPhotoFetchReceipts((prev) => {
      // Skip a repeat record for the SAME finished job (the poll loop can
      // re-deliver a terminal job) so the timestamp doesn't churn on reload.
      if (receipt.jobId && prev[unitId]?.jobId === receipt.jobId) return prev;
      const next = { ...prev, [unitId]: receipt };
      try { localStorage.setItem(photoFetchReceiptsKey(id), JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const dismissPhotoFetchReceipt = (unitId: string) => {
    setPhotoFetchReceipts((prev) => {
      const next = { ...prev };
      delete next[unitId];
      try { localStorage.setItem(photoFetchReceiptsKey(id), JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const [platformCheckReceipt, setPlatformCheckReceipt] = useState<OperationReceipt | null>(() => {
    try {
      const raw = localStorage.getItem(platformCheckReceiptKey(id));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  const recordPlatformCheckReceipt = (receipt: OperationReceipt | null) => {
    setPlatformCheckReceipt(receipt);
    try {
      if (receipt) localStorage.setItem(platformCheckReceiptKey(id), JSON.stringify(receipt));
      else localStorage.removeItem(platformCheckReceiptKey(id));
    } catch {}
  };

  // ── Photo source scraper for promoted drafts ─────────────────────────────
  // Drafts whose Step 4 wizard scrape didn't find a matching Zillow listing
  // arrive at preflight with no photos persisted on the volume. Without
  // photos, the reverse-image-search half of the Platform Check is fully
  // skipped (it has nothing to feed Google Lens), so the check returns "no
  // signals" regardless of whether the property is actually listed somewhere.
  //
  // Mirrors the same real-estate discovery logic /api/replacement/find-unit
  // uses for active properties: searches Zillow/Realtor by community +
  // street address + bedroom count, supplements with Apify when a resort
  // street root is known, then scrapes the first usable detail result.
  // Operator clicks one button per unit; URL paste isn't needed.
  const [photoFetchJobIdsByUnit, setPhotoFetchJobIdsByUnit] = useState<Record<string, string>>(() =>
    id < 0 ? loadPhotoFetchJobIds(id) : {},
  );
  const [photoFetchJobsByUnit, setPhotoFetchJobsByUnit] = useState<Record<string, PreflightPhotoFetchJob>>({});
  const [photoFetchTick, setPhotoFetchTick] = useState(0);
  // The audit (platform check / full unit audit) now runs as a server-side
  // background job — the client just starts it, persists the id, and polls. This
  // is what lets the operator fire it and leave the tab. Declared here (before
  // the apply/poll effects below) so it's in scope for them.
  const [auditJobId, setAuditJobId] = useState<string | null>(() => loadAuditJobId(id));
  // Per-folder rescrape jobs (server-side background). Map of folder → jobId for
  // polling/persistence; the latest job object per folder for the spinner/receipt.
  const [rescrapeJobIdsByFolder, setRescrapeJobIdsByFolder] = useState<Record<string, string>>(() => loadRescrapeJobIds(id));
  const [rescrapeJobsByFolder, setRescrapeJobsByFolder] = useState<Record<string, PreflightRescrapeJob>>({});
  // Track URLs the operator has already accepted/rejected so the
  // "Try another" path skips them. Reset when the property changes.
  const [skippedUrlsByUnit, setSkippedUrlsByUnit] = useState<Record<string, string[]>>({});
  const photoFetchStartPayloadByUnit = useRef<Record<string, Record<string, unknown>>>({});

  const activePhotoFetchUnitIds = Object.entries(photoFetchJobIdsByUnit)
    .filter(([unitId, jobId]) => {
      const job = photoFetchJobsByUnit[unitId];
      return jobId && (!job || job.status === "queued" || job.status === "running");
    })
    .map(([unitId]) => unitId);
  const scrapingUnitId = activePhotoFetchUnitIds[0] ?? null;

  useEffect(() => {
    if (activePhotoFetchUnitIds.length === 0) return;
    const t = setInterval(() => setPhotoFetchTick((tick) => tick + 1), 1_000);
    return () => clearInterval(t);
  }, [activePhotoFetchUnitIds.length]);

  useEffect(() => {
    if (!id || id >= 0) return;
    setPhotoFetchJobIdsByUnit(loadPhotoFetchJobIds(id));
  }, [id]);

  const applyPhotoFetchJob = (unitId: string, job: PreflightPhotoFetchJob, restored = false) => {
    setPhotoFetchJobsByUnit((prev) => ({ ...prev, [unitId]: job }));
    const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    if (!terminal) return;
    setPhotoFetchJobIdsByUnit((prev) => {
      const next = { ...prev };
      delete next[unitId];
      savePhotoFetchJobIds(id, next);
      return next;
    });
    // Leave a sticky "last processed" receipt the operator dismisses with ×.
    if (job.status === "completed") {
      let sourceNote = "";
      if (job.sourceUrl) {
        try { sourceNote = ` from ${new URL(job.sourceUrl).hostname}`; } catch { /* keep blank */ }
      }
      // Surface what the re-pull actually CHANGED — a fast re-pull of the same
      // listing legitimately yields identical photos, so spell that out instead
      // of leaving the operator wondering whether it ran.
      const changeNote = typeof job.changeNote === "string" && job.changeNote ? ` — ${job.changeNote}` : "";
      recordPhotoFetchReceipt(unitId, {
        timestamp: Date.now(),
        success: true,
        title: "Photos re-pulled",
        detail: `${job.savedCount ?? 0} photo${job.savedCount === 1 ? "" : "s"} re-scraped${sourceNote}${changeNote}.`,
        jobId: job.id,
      });
    } else if (job.status === "failed") {
      recordPhotoFetchReceipt(unitId, {
        timestamp: Date.now(),
        success: false,
        title: "Photo re-pull failed",
        detail: job.error || job.message || "No photos were saved.",
        jobId: job.id,
      });
    }
    if (job.status === "completed") {
      void loadDraftPropertyByNegativeId(id).then((updated) => {
        if (updated) setDraftProperty(updated);
      });
      if (!restored) {
        const host = job.sourceUrl ? `From ${new URL(job.sourceUrl).hostname}. ` : "";
        const changeLine = typeof job.changeNote === "string" && job.changeNote ? `${job.changeNote}. ` : "";
        toast({
          title: `Re-pulled ${job.savedCount ?? 0} photo${job.savedCount === 1 ? "" : "s"}`,
          description: `${host}${changeLine}Re-run the Platform Check to reverse-image-search them.`,
        });
        if (job.sourceUrl) {
          setSkippedUrlsByUnit((prev) => ({
            ...prev,
            [unitId]: [...(prev[unitId] ?? []), job.sourceUrl!],
          }));
        }
      }
    } else if (!restored && job.error) {
      toast({
        title: "No more photo candidates",
        description: job.error,
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    const jobIds = Object.entries(photoFetchJobIdsByUnit).filter(([, jobId]) => !!jobId);
    if (jobIds.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      for (const [unitId, jobId] of jobIds) {
        try {
          const resp = await fetch(`/api/preflight/photo-fetch-jobs/${encodeURIComponent(jobId)}`, {
            credentials: "include",
          });
          if (!resp.ok) {
            if (resp.status === 404 && !cancelled) {
              setPhotoFetchJobIdsByUnit((prev) => {
                const next = { ...prev };
                delete next[unitId];
                savePhotoFetchJobIds(id, next);
                return next;
              });
            }
            continue;
          }
          const data = await resp.json();
          if (!cancelled && data.job) applyPhotoFetchJob(unitId, data.job as PreflightPhotoFetchJob);
        } catch {
          // keep polling
        }
      }
    };
    poll();
    const interval = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, photoFetchJobIdsByUnit]);

  // ── Audit job (platform check / full unit audit) — re-attach + poll ─────────
  // The audit runs server-side; the client mirrors the job into the existing
  // platform-check UI state. Declared above the early `if (!property)` return so
  // the hook count stays stable, and it reads ONLY job + setters (never
  // `property`/`effectiveUnits`) so it's safe to run before the property loads.
  const applyAuditJob = (job: PreflightAuditJob) => {
    const running = job.status === "queued" || job.status === "running";
    setTotalUnits(job.totalUnits);
    setCompletedCount(job.completedCount);
    setResults(job.results || {});
    if (job.photoChecks) setPhotoChecks(job.photoChecks);
    if (job.photoBudget) setPhotoBudget(job.photoBudget);
    if (job.startedAt) setCheckStartedAt(job.startedAt);
    setPlatformChecking(running);
    setFullAuditRunning(job.fullPhotoAudit && running);
    setPhotoScanning(job.phase === "photo" && running);
    setCheckPhase(job.phase === "photo" ? "photo" : running ? "text" : "done");

    const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    if (!terminal) return;

    // Terminal: stop polling, mark done, stamp the receipt the server computed.
    setPlatformChecking(false);
    setFullAuditRunning(false);
    setPhotoScanning(false);
    setCheckStartedAt(null);
    setCheckPhase("done");
    setPlatformDone(true);
    setLastCheckWasFullAudit(job.fullPhotoAudit);
    if (job.receipt) {
      recordPlatformCheckReceipt(job.receipt);
    } else if (job.error) {
      recordPlatformCheckReceipt({ timestamp: Date.now(), success: false, title: "Unit audit", detail: job.error });
    }
    setAuditJobId(null);
    saveAuditJobId(id, null);
  };

  useEffect(() => {
    if (!auditJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await fetch(`/api/preflight/audit-jobs/${encodeURIComponent(auditJobId)}`, { credentials: "include" });
        if (!resp.ok) {
          // 404 = the job was evicted (redeploy / 2h TTL). Drop it and clear the
          // "checking" UI so the operator just re-runs — picks already rendered
          // stay; the deep photo scan it kicked off persists via its 24h cache.
          if (resp.status === 404 && !cancelled) {
            setAuditJobId(null);
            saveAuditJobId(id, null);
            setPlatformChecking(false);
            setFullAuditRunning(false);
            setPhotoScanning(false);
            setCheckStartedAt(null);
            setCheckPhase("done");
          }
          return;
        }
        const data = await resp.json();
        if (!cancelled && data.job) applyAuditJob(data.job as PreflightAuditJob);
      } catch {
        // keep polling
      }
    };
    poll();
    const interval = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, auditJobId]);

  // ── Per-unit rescrape job — start / re-attach + poll ───────────────────────
  const handledRescrapeJobsRef = useRef<Set<string>>(new Set());
  // Folders whose rescrape the operator started THIS session — they get the
  // toast / needs-URL prompt on completion. Jobs only re-attached on mount
  // (restored) update the sticky receipt silently.
  const sessionRescrapeFoldersRef = useRef<Set<string>>(new Set());

  const startRescrapeJob = async (folder: string, sourceUrl?: string) => {
    sessionRescrapeFoldersRef.current.add(folder);
    try {
      const resp = await apiRequest("POST", "/api/preflight/rescrape-jobs", { folder, ...(sourceUrl ? { sourceUrl } : {}) });
      const data = await resp.json();
      if (!data?.job?.id) throw new Error(data?.error || "Rescrape job did not start");
      setRescrapeJobIdsByFolder((prev) => {
        const next = { ...prev, [folder]: data.job.id as string };
        saveRescrapeJobIds(id, next);
        return next;
      });
      setRescrapeJobsByFolder((prev) => ({ ...prev, [folder]: data.job as PreflightRescrapeJob }));
    } catch (e: any) {
      toast({ title: "Rescrape failed to start", description: e?.message || String(e), variant: "destructive" });
    }
  };

  const applyRescrapeJob = (folder: string, job: PreflightRescrapeJob) => {
    const restored = !sessionRescrapeFoldersRef.current.has(folder);
    setRescrapeJobsByFolder((prev) => ({ ...prev, [folder]: job }));
    const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    if (!terminal) return;
    setRescrapeJobIdsByFolder((prev) => {
      const next = { ...prev };
      delete next[folder];
      saveRescrapeJobIds(id, next);
      return next;
    });
    if (handledRescrapeJobsRef.current.has(job.id)) return;
    handledRescrapeJobsRef.current.add(job.id);

    if (job.status === "completed") {
      const saved = Number(job.savedCount ?? 0);
      const beds = Number(job.bedroomCount ?? 0);
      const baths = Number(job.bathroomCount ?? 0);
      recordRescrape(folder, {
        folder,
        timestamp: Date.now(),
        savedCount: saved,
        bedroomCount: beds,
        bathroomCount: baths,
        sourceUrl: job.sourceUrl ?? undefined,
        urlSource: job.urlSource ?? undefined,
      });
      if (!restored) {
        const noInteriors = beds === 0 && baths === 0;
        const bedShortfall = Number(job.coverage?.bedroomsShortfall ?? 0);
        const expectedBeds = job.coverage?.bedroomsExpected;
        // Use the true distinct-room count from coverage, NOT `beds` —
        // `bedroomCount` is max(found, claimed) for display, so it would render the
        // self-contradictory "Only 3 found — listing claims 3" when a gap exists.
        const foundBeds = Number(
          job.coverage?.bedroomsFound
          ?? (typeof expectedBeds === "number" ? expectedBeds - bedShortfall : beds),
        );
        const shortfallNote = bedShortfall > 0
          ? ` ⚠ Only ${foundBeds} unique bedrooms found — listing claims ${expectedBeds}. Click "Change" if you need a richer source.`
          : "";
        toast({
          title: noInteriors
            ? `Rescraped ${saved} photos — no bedrooms found`
            : `Photos rescraped — ${beds} bedroom${beds !== 1 ? "s" : ""}, ${baths} bathroom${baths !== 1 ? "s" : ""}`,
          description: noInteriors
            ? `That listing's photos are all kitchen/exterior/views — no bedrooms detected. Click "Change" to search for a different replacement with actual interior shots.`
            : `${saved} saved (source: ${job.urlSource ?? "manual"}). Hard-refresh the builder page to see them.${shortfallNote}`,
          duration: 10000,
        });
      }
    } else if (job.needsUrl && !restored) {
      // The one interactive case: no source URL on file. Prompt and start a
      // fresh background job with the pasted URL.
      const url = window.prompt(
        "No source URL on file for this unit. Paste the Zillow/Redfin listing URL — I'll save it for next time.",
        "",
      );
      if (url && /^https?:\/\//i.test(url)) {
        void startRescrapeJob(folder, url.trim());
      } else if (url) {
        toast({ title: "That doesn't look like a URL", description: "Paste a full https:// listing URL and try again.", variant: "destructive" });
      }
    } else if (!restored) {
      toast({ title: "Rescrape failed", description: job.error || job.message || "No photos were saved.", variant: "destructive" });
    }
  };

  useEffect(() => {
    const jobIds = Object.entries(rescrapeJobIdsByFolder).filter(([, jobId]) => !!jobId);
    if (jobIds.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      for (const [folder, jobId] of jobIds) {
        try {
          const resp = await fetch(`/api/preflight/rescrape-jobs/${encodeURIComponent(jobId)}`, { credentials: "include" });
          if (!resp.ok) {
            if (resp.status === 404 && !cancelled) {
              setRescrapeJobIdsByFolder((prev) => {
                const next = { ...prev };
                delete next[folder];
                saveRescrapeJobIds(id, next);
                return next;
              });
            }
            continue;
          }
          const data = await resp.json();
          if (!cancelled && data.job) applyRescrapeJob(folder, data.job as PreflightRescrapeJob);
        } catch {
          // keep polling
        }
      }
    };
    poll();
    const interval = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rescrapeJobIdsByFolder]);

  // Re-load persisted in-flight job ids when the property changes (mirrors the
  // photo-fetch restore; covers a route change without a full remount).
  useEffect(() => {
    setAuditJobId(loadAuditJobId(id));
    setRescrapeJobIdsByFolder(loadRescrapeJobIds(id));
  }, [id]);

  // Parse street / city / state out of the property's display address
  // ("9000 Treasure Trove Lane, Kissimmee, Florida"). For HI properties
  // the address often has a building suffix ("…, Bldg 38, Koloa, HI
  // 96756") which we tolerate by taking position[-2] / position[-1].
  const parsePropertyAddress = (addr: string): { street: string; city: string; state: string } => {
    const parts = (addr || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return { street: addr || "", city: "", state: "" };
    const street = parts[0];
    let city = "";
    let state = "";
    if (parts.length >= 3) {
      city = parts[parts.length - 2];
      state = (parts[parts.length - 1].split(" ")[0] || "").trim(); // "FL 34747" → "FL"
    } else {
      city = parts[1];
      state = parts[2] ?? "";
    }
    return { street, city, state };
  };

  // Confirm the state/city the units sit in (all units share the property's
  // community), so getting new unit photos surfaces — and flags — a unit whose
  // community is filed under the wrong state (e.g. a Bay Watch unit under
  // Florida; Bay Watch is a South Carolina resort). Recall-safe: only a KNOWN
  // mis-location is flagged. See shared/community-location-guard.ts.
  const unitLocationConfirmation: LocationConfirmation | null = property
    ? confirmCommunityLocation({
        communityName: property.complexName,
        expectedCity: parsePropertyAddress(property.address).city || null,
        expectedState: parsePropertyAddress(property.address).state || null,
      })
    : null;

  const handleScrapePhotosForUnit = async (unitIndex: 0 | 1, unit: { id: string; bedrooms: number; photos?: { url: string }[]; photoFolder?: string }) => {
    if (id >= 0 || !property) return; // promoted drafts only
    const draftId = -id;
    const { street: parsedStreet, city, state } = parsePropertyAddress(property.address);
    const street = inferCommunityStreetAddress({
      communityName: property.complexName,
      city,
      state,
      addressHint: parsedStreet || property.address,
    }) || parsedStreet;
    const loadSourceUrl = async (folder?: string): Promise<string | null> => {
      if (!folder) return null;
      try {
        const r = await apiRequest("GET", `/api/builder/photo-source/${encodeURIComponent(folder)}`);
        const data = await r.json() as { source?: { sourceListing?: { url?: string } } | null };
        const url = data?.source?.sourceListing?.url;
        return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
      } catch {
        return null;
      }
    };
    try {
      const replacingExistingPhotos = (unit.photos?.length ?? 0) > 0;
      const currentSourceUrl = await loadSourceUrl(unit.photoFolder);
      // skipUrls only governs the DISCOVERY fallback (when the unit's own
      // saved listing is dead/thin). Block sibling sources so discovery can't
      // re-save the same listing on both units, and block this unit's own
      // source so the fallback doesn't re-pick the dead listing the rescrape
      // already tried. When both units are still empty (initial find), leave
      // sibling URLs open so sparse resorts can surface a representative gallery.
      const siblingSourceUrls = (await Promise.all(
        property.units
          .filter((u) => u.id !== unit.id)
          .filter((u) => !replacingExistingPhotos || photoCountForUnit(u.id, u.photos?.length ?? 0) > 0)
          .map((u) => loadSourceUrl(u.photoFolder)),
      )).filter((u): u is string => !!u);
      const skipUrls = Array.from(new Set([
        ...(skippedUrlsByUnit[unit.id] ?? []),
        ...(replacingExistingPhotos && currentSourceUrl ? [currentSourceUrl] : []),
        ...siblingSourceUrls,
      ]));
      const startPayload = {
        draftId,
        propertyId: id,
        unitId: unit.id,
        unitIndex,
        bedrooms: unit.bedrooms,
        communityName: property.complexName,
        streetAddress: street || undefined,
        city: city || undefined,
        state: state || undefined,
        skipUrls,
        replacingExistingPhotos,
        skipFirst: skipUrls.length === 0 && replacingExistingPhotos ? 1 : 0,
        // "Re-pull all photos" rescrapes THIS unit's own saved listing first
        // (full gallery), instead of discovering a different listing. Discovery
        // only runs as a fallback if the saved source is off-market / too thin.
        rescrapeSourceUrl: replacingExistingPhotos && currentSourceUrl ? currentSourceUrl : undefined,
      };
      photoFetchStartPayloadByUnit.current[unit.id] = startPayload;
      const resp = await apiRequest("POST", "/api/preflight/photo-fetch-jobs", startPayload);
      const data = await resp.json();
      if (!data?.job?.id) throw new Error("Photo fetch job did not start");
      setPhotoFetchJobIdsByUnit((prev) => {
        const next = { ...prev, [unit.id]: data.job.id as string };
        savePhotoFetchJobIds(id, next);
        return next;
      });
      applyPhotoFetchJob(unit.id, data.job as PreflightPhotoFetchJob);
      setPhotoFetchTick(0);
    } catch (e: any) {
      // The job-start API didn't respond (or errored) — leave a sticky red
      // receipt, not just a transient toast, so the failure is visible after.
      recordPhotoFetchReceipt(unit.id, {
        timestamp: Date.now(),
        success: false,
        title: "Photo re-pull failed",
        detail: `Couldn't start the photo re-pull — the service didn't respond (${e?.message || String(e)}). Try again.`,
      });
      toast({ title: "Scrape failed", description: e?.message || String(e), variant: "destructive" });
    }
  };

  // ── Find new community photos (re-pull) ──────────────────────────────────
  // Researches the community via Claude, finds correct community photo URLs,
  // scrapes them into the community folder, then verifies every photo with AI
  // vision + Google Lens reverse image search (deleting any mismatches).
  const [communityRepullJobId, setCommunityRepullJobId] = useState<string | null>(() => {
    if (!Number.isFinite(id)) return null;
    try {
      return localStorage.getItem(communityRepullJobStorageKey(id));
    } catch {
      return null;
    }
  });
  const [communityRepullJob, setCommunityRepullJob] = useState<CommunityRepullJob | null>(null);

  const persistRepullJobId = (jobId: string | null) => {
    try {
      if (jobId) localStorage.setItem(communityRepullJobStorageKey(id), jobId);
      else localStorage.removeItem(communityRepullJobStorageKey(id));
    } catch { /* ignore */ }
  };

  const repullActive =
    !!communityRepullJobId &&
    (!communityRepullJob || communityRepullJob.status === "queued" || communityRepullJob.status === "running");

  useEffect(() => {
    if (!communityRepullJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await fetch(
          `/api/preflight/community-photo-repull/${encodeURIComponent(communityRepullJobId)}`,
          { credentials: "include" },
        );
        if (resp.status === 404) {
          if (!cancelled) { setCommunityRepullJobId(null); persistRepullJobId(null); }
          return;
        }
        if (!resp.ok) return;
        const data = await resp.json();
        if (cancelled || !data?.job) return;
        const job = data.job as CommunityRepullJob;
        setCommunityRepullJob(job);
        const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
        if (terminal) {
          setCommunityRepullJobId(null);
          persistRepullJobId(null);
          if (job.status === "completed") {
            toast({ title: "New community photos found", description: job.message });
          } else if (job.error) {
            toast({ title: "Finding new photos failed", description: job.error, variant: "destructive" });
          }
        }
      } catch { /* keep polling */ }
    };
    void poll();
    const interval = window.setInterval(poll, 2_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityRepullJobId]);

  const handleRepullCommunityPhotos = async () => {
    if (!property?.communityPhotoFolder) {
      toast({ title: "No community folder", description: "This listing has no community photo folder to refresh.", variant: "destructive" });
      return;
    }
    try {
      const resp = await apiRequest("POST", "/api/preflight/community-photo-repull", {
        communityName: property.complexName,
        communityFolder: property.communityPhotoFolder,
        city: parseCityFromMailingAddress(property.address) || undefined,
        state: parsePropertyAddress(property.address).state || undefined,
      });
      const data = await resp.json();
      if (!data?.job?.id) throw new Error("Re-pull job did not start");
      setCommunityRepullJob(data.job as CommunityRepullJob);
      setCommunityRepullJobId(data.job.id as string);
      persistRepullJobId(data.job.id as string);
      toast({ title: "Finding new community photos", description: "Researching the community and finding fresh photos — safe to leave this tab." });
    } catch (e: any) {
      toast({ title: "Could not start photo search", description: e?.message || String(e), variant: "destructive" });
    }
  };

  const [platformChecking, setPlatformChecking] = useState(false);
  // Units still being checked are derived from the audit job (results vs total)
  // below — see `checkingUnitIds` after effectiveUnits.
  const [completedCount, setCompletedCount] = useState(0);
  const [totalUnits, setTotalUnits] = useState(0);
  const [checkPhase, setCheckPhase] = useState<"text" | "photo" | "done" | null>(null);
  const [checkStartedAt, setCheckStartedAt] = useState<number | null>(null);
  const [progressTick, setProgressTick] = useState(0);
  const [results, setResults] = useState<ProgressiveResults>({});
  const [platformDone, setPlatformDone] = useState(false);
  const [fullAuditRunning, setFullAuditRunning] = useState(false);
  const [lastCheckWasFullAudit, setLastCheckWasFullAudit] = useState(false);
  const [showReplacementFlow, setShowReplacementFlow] = useState(false);
  const [replacementTargetId, setReplacementTargetId] = useState<string | null>(null);
  const [replacementSkipUrl, setReplacementSkipUrl] = useState<string | null>(null);
  const [manualReplaceUnitId, setManualReplaceUnitId] = useState<string | null>(null);
  const [manualReplaceUrl, setManualReplaceUrl] = useState("");
  const [manualReplacingUnitId, setManualReplacingUnitId] = useState<string | null>(null);
  const [swapsCommitted, setSwapsCommitted] = useState(false);
  const [committing, setCommitting] = useState(false);
  const autoRunFired = useRef(false);
  // Set on unmount so the long deep-photo poll loop (up to ~9 min) stops promptly when the operator
  // navigates away, instead of polling + setState on an unmounted component.
  const pollAbortedRef = useRef(false);
  useEffect(() => () => { pollAbortedRef.current = true; }, []);

  // Photo cross-check (credit-aware scanner via /api/preflight/photo-check).
  const [photoChecks, setPhotoChecks] = useState<Record<string, PhotoCheckRow>>({});
  // cap/remaining are null when the daily photo-check cap is removed (the default) — "unlimited".
  const [photoBudget, setPhotoBudget] = useState<{ used: number; cap: number | null; remaining: number | null } | null>(null);
  const [photoScanning, setPhotoScanning] = useState(false);

  // Maps old unit ID → replacement unit data
  const [unitOverrides, setUnitOverrides] = useState<Record<string, UnitOverride>>({});
  // Replacement photos live in a separate folder until commit; fetch counts
  // so Photo Sources reflects the swapped unit, not the original scrape.
  const [overridePhotoCounts, setOverridePhotoCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const folders = Object.entries(unitOverrides)
      .map(([unitId, o]) => [unitId, o.photoFolder] as const)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1]);
    if (!folders.length) {
      setOverridePhotoCounts({});
      return;
    }
    let cancelled = false;
    (async () => {
      const counts: Record<string, number> = {};
      await Promise.all(folders.map(async ([unitId, folder]) => {
        try {
          const r = await fetch(`/api/photos/community/${encodeURIComponent(folder)}`, { credentials: "include" });
          if (!r.ok) return;
          // GET /api/photos/community/:folder returns a BARE ARRAY of
          // { url, filename } (already image-only) — NOT a { files: [...] }
          // object. Reading `data.files` always yielded 0, so a replacement
          // unit (whose photos live in a `replacement-…` folder) counted 0
          // photos and the "Re-pull all photos" button fell back to "Find
          // Photos" — which then runs a discovery search and can substitute a
          // different listing. Read the array, matching the other callers
          // (adapt-draft.ts, builder.tsx).
          const data = (await r.json()) as Array<{ filename?: string }> | null;
          counts[unitId] = Array.isArray(data)
            ? data.filter((f) => /\.(?:jpe?g|png|webp)$/i.test(f?.filename ?? "")).length
            : 0;
        } catch { /* ignore */ }
      }));
      if (!cancelled) setOverridePhotoCounts(counts);
    })();
    return () => { cancelled = true; };
  }, [unitOverrides]);

  const isCheckRunning = platformChecking;
  useEffect(() => {
    if (!isCheckRunning) return;
    const id = setInterval(() => setProgressTick(t => t + 1), 1_000);
    return () => clearInterval(id);
  }, [isCheckRunning]);

  // Load any previously saved unit swaps from the DB, then auto-run the
  // platform check for static builder properties if no swaps are blocking it.
  // Promoted drafts can arrive with freshly scraped photos and should not kick
  // off reverse-image search until the operator explicitly asks for it.
  useEffect(() => {
    if (!id || !property) return;
    fetch(`/api/unit-swaps/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { swaps: any[] } | null) => {
        if (!data?.swaps?.length) {
          if (!isPromotedDraft && !autoRunFired.current && !auditJobId) {
            autoRunFired.current = true;
            runPlatformCheck();
          }
          return;
        }
        const restored: Record<string, UnitOverride> = {};
        let allCommitted = true;
        for (const swap of data.swaps) {
          if (!swap?.oldUnitId || restored[swap.oldUnitId]) continue;
          const photoFolder =
            typeof swap.photoFolder === "string" && swap.photoFolder.trim()
              ? swap.photoFolder
              : replacementPhotoFolderForUnit(id, swap.oldUnitId);
          restored[swap.oldUnitId] = {
            unitNumber: swap.newUnitLabel.replace(/^Unit\s*#?/i, "").trim(),
            address: swap.newAddress,
            bedrooms: swap.newBedrooms ?? 1,
            unitLabel: swap.newUnitLabel,
            sourceUrl: swap.newSourceUrl,
            photoFolder,
            swapId: swap.id,
          };
          if (!swap.committed) allCommitted = false;
        }
        setUnitOverrides(restored);
        setSwapsCommitted(allCommitted);
      })
      .catch(() => {
        if (!isPromotedDraft && !autoRunFired.current) {
          autoRunFired.current = true;
          runPlatformCheck();
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, property]);

  const commitAndContinue = async () => {
    setCommitting(true);
    try {
      await fetch(`/api/unit-swaps/commit/${id}`, { method: "PATCH" });
      setSwapsCommitted(true);
      if (isPromotedDraft) {
        const updated = await loadDraftPropertyByNegativeId(id);
        if (updated) setDraftProperty(updated);
      }
    } catch { /* best effort */ } finally {
      setCommitting(false);
    }
    setLocation(`/builder/${id}/step-1`);
  };

  // Auto-load cached photo signals (no credits) once the units' folders are known.
  // MUST stay ABOVE the `if (!property)` early return below — otherwise the hook count
  // changes between the loading render and the loaded render (React #310). Self-contained
  // (reads property + unitOverrides directly) so it never depends on values declared after
  // the early return.
  const photoFolderKey = (property?.units ?? [])
    .map((u) => (unitOverrides[u.id]?.photoFolder ?? (u as any).photoFolder) || "")
    .join("|");
  useEffect(() => {
    const folders = Array.from(new Set(
      (property?.units ?? [])
        .map((u) => (unitOverrides[u.id]?.photoFolder ?? (u as any).photoFolder) as string | undefined)
        .filter((f): f is string => !!f),
    ));
    if (folders.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/preflight/photo-check", {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ folders, run: false }),
        });
        if (!resp.ok || cancelled) return;
        const data = await resp.json();
        if (cancelled) return;
        const map: Record<string, PhotoCheckRow> = {};
        for (const c of (data.checks ?? [])) map[c.folder] = c;
        setPhotoChecks(map);
        if (data.budget) setPhotoBudget(data.budget);
      } catch { /* non-fatal — the photo sub-badges just stay "not checked" */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoFolderKey]);

  // Load the original scrape source (Zillow/Redfin/etc.) for each unit's folder
  // from its _source.json, so the Photo Sources card can show a "View source"
  // button next to Re-pull that reveals the listing URL the photos came from.
  // Stays ABOVE the `if (!property)` early return (stable hook count) and reads
  // property/unitOverrides directly. Re-runs after a re-pull (receipt timestamp
  // changes) so the URL refreshes if discovery picked a new listing.
  const [unitSourceByFolder, setUnitSourceByFolder] = useState<Record<string, { url: string; platform?: string } | null>>({});
  const [revealedSourceUnitIds, setRevealedSourceUnitIds] = useState<Set<string>>(new Set());
  const toggleRevealSource = (unitId: string) => {
    setRevealedSourceUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId); else next.add(unitId);
      return next;
    });
  };
  const sourceRefreshKey = (property?.units ?? [])
    .map((u) => photoFetchReceipts[u.id]?.timestamp ?? 0)
    .join("|");
  useEffect(() => {
    const folders = Array.from(new Set(
      (property?.units ?? [])
        .map((u) => (unitOverrides[u.id]?.photoFolder ?? (u as any).photoFolder) as string | undefined)
        .filter((f): f is string => !!f),
    ));
    if (folders.length === 0) return;
    let cancelled = false;
    (async () => {
      const map: Record<string, { url: string; platform?: string } | null> = {};
      await Promise.all(folders.map(async (folder) => {
        try {
          const r = await fetch(`/api/builder/photo-source/${encodeURIComponent(folder)}`, { credentials: "include" });
          if (!r.ok) return;
          const data = await r.json();
          const sl = data?.source?.sourceListing;
          const url = typeof sl?.url === "string" && /^https?:\/\//i.test(sl.url) ? sl.url : null;
          map[folder] = url ? { url, platform: typeof sl?.platform === "string" ? sl.platform : undefined } : null;
        } catch { /* leave folder absent → button shows "no source on file" */ }
      }));
      if (!cancelled) setUnitSourceByFolder((prev) => ({ ...prev, ...map }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoFolderKey, sourceRefreshKey]);

  if (!property) {
    if (draftLoading) {
      return (
        <div className="max-w-2xl mx-auto p-8 text-center">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">Loading promoted draft…</p>
        </div>
      );
    }
    return (
      <div className="max-w-2xl mx-auto p-8 text-center">
        <p className="text-muted-foreground">Property not found.</p>
        <Button variant="outline" className="mt-4" onClick={() => setLocation("/")}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const step1Url = `/builder/${id}/step-1`;

  // Build the effective unit list — replace any overridden units with their new data
  const effectiveUnits = property.units.map(u => {
    const override = unitOverrides[u.id];
    if (override) {
      return {
        ...u,
        unitNumber: override.unitNumber,
        bedrooms: override.bedrooms,
        photoFolder: override.photoFolder ?? u.photoFolder,
        _overrideAddress: override.address,
        _isReplaced: true,
        _replacedLabel: override.unitLabel,
        _replacedSourceUrl: override.sourceUrl,
        _originalUnitNumber: u.unitNumber,
      };
    }
    return { ...u, _overrideAddress: undefined, _isReplaced: false, _replacedLabel: undefined, _replacedSourceUrl: undefined, _originalUnitNumber: u.unitNumber };
  });

  // Units still "checking" while the audit job runs = those without a result yet.
  // Derived (not state) so it can't drift from the server-driven job.
  const checkingUnitIds = new Set<string>(
    isCheckRunning ? effectiveUnits.filter((u) => !results[u.id]).map((u) => u.id) : [],
  );

  const photoCountForUnit = (unitId: string, fallback: number) =>
    unitOverrides[unitId]?.photoFolder
      ? (overridePhotoCounts[unitId] ?? fallback)
      : fallback;

  const addressRule = communityAddressRuleForName(property.complexName);
  const city =
    parseCityFromMailingAddress(property.address)
    || addressRule?.city
    || property.complexName;
  const searchCommunityName = property.complexName?.trim() || property.propertyName;

  // ── Start the server-side audit job (platform check / full unit audit) ──────
  // The check now runs ENTIRELY server-side (server/preflight-background-jobs.ts)
  // so the operator can fire it and leave the tab — the old version looped over
  // units with parallel fetches and held results in React state, so a tab close
  // aborted the fetches and discarded everything. We POST the job, persist its
  // id, and the audit poll effect (above) rehydrates results / receipt / deep
  // photo results from the job. Name kept as runPlatformCheck so every existing
  // call site (rerunChecks, the auto-run effect) is unchanged.
  const runPlatformCheck = async (
    unitsToCheck = effectiveUnits,
    opts: { fullPhotoAudit?: boolean } = {},
  ) => {
    const fullPhotoAudit = opts.fullPhotoAudit === true;
    const singleUnitListing = property.units.length === 1;
    const unitPayload = unitsToCheck.map((unit) => {
      const address = (unit as any)._overrideAddress
        || (singleUnitListing ? property.address : `${property.address}, ${formatUnitDisplayLabel(unit.unitNumber)}`);
      return {
        unitId: unit.id,
        unitNumber: unit.unitNumber,
        address,
        bedrooms: (unit as any).bedrooms,
        photoFolder: (unit as any).photoFolder || "",
      };
    });
    // For a full audit, the server also drives the deep reverse-image scan over
    // these folders (it kicks off the persistent /photo-check job server-side).
    const deepPhotoFolders = fullPhotoAudit
      ? Array.from(new Set(
          unitsToCheck
            .map((u) => (u as any).photoFolder as string | undefined)
            .filter((f): f is string => !!f),
        ))
      : [];

    // Optimistic reset so the UI flips to "checking" instantly; the poll then
    // drives every field from the job (results, progress, receipt, photo scan).
    setPlatformChecking(true);
    setFullAuditRunning(fullPhotoAudit);
    setLastCheckWasFullAudit(false);
    setPlatformDone(false);
    setResults({});
    if (fullPhotoAudit) setPhotoChecks({});
    setCompletedCount(0);
    setTotalUnits(unitsToCheck.length);
    setCheckPhase("text");
    setCheckStartedAt(Date.now());
    setProgressTick(0);

    try {
      const resp = await apiRequest("POST", "/api/preflight/audit-jobs", {
        name: searchCommunityName,
        city,
        singleListing: singleUnitListing,
        fullPhotoAudit,
        units: unitPayload,
        deepPhotoFolders,
      });
      const data = await resp.json();
      if (!data?.job?.id) throw new Error(data?.error || "Audit job did not start");
      setAuditJobId(data.job.id as string);
      saveAuditJobId(id, data.job.id as string);
      applyAuditJob(data.job as PreflightAuditJob);
    } catch (e: any) {
      // The job-start API didn't respond — leave a sticky red receipt (not just
      // a transient toast) so the failure is visible after the operator returns.
      setPlatformChecking(false);
      setCheckStartedAt(null);
      recordPlatformCheckReceipt({
        timestamp: Date.now(),
        success: false,
        title: "Unit audit",
        detail: `Couldn't start the check — the service didn't respond (${e?.message || String(e)}). Try again.`,
      });
      toast({ title: "Couldn't start the check", description: e?.message || String(e), variant: "destructive" });
    }
  };

  const rerunChecks = () => {
    setPlatformDone(false);
    setResults({});
    runPlatformCheck();
  };

  // The full unit audit is the ONE comprehensive button. The server-side audit
  // job runs the text platform check AND the reverse-image photo scan of every
  // interior photo — it drives the persistent /api/preflight/photo-check job
  // internally (via loopback) — so the whole audit survives a tab close. The
  // client `runDeepPhotoCheck` below is now dead (the server owns the deep scan)
  // but kept in place; don't wire it back to a button.
  const runFullUnitAudit = async () => {
    await runPlatformCheck(effectiveUnits, { fullPhotoAudit: true });
  };

  // ── Photo cross-check ───────────────────────────────────────────────────────
  const photoFoldersForUnits = (): string[] =>
    Array.from(new Set(effectiveUnits.map((u) => (u as any).photoFolder as string | undefined).filter((f): f is string => !!f)));

  // READ-only: pull cached photo-listing rows for the units' folders. ZERO credits.
  const loadPhotoChecks = async () => {
    const folders = photoFoldersForUnits();
    if (folders.length === 0) return;
    try {
      const resp = await fetch("/api/preflight/photo-check", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ folders, run: false }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const map: Record<string, PhotoCheckRow> = {};
      for (const c of (data.checks ?? [])) map[c.folder] = c;
      setPhotoChecks(map);
      if (data.budget) setPhotoBudget(data.budget);
    } catch { /* non-fatal — photo signal just won't show */ }
  };

  // On-demand DEEP check: spends credits (every interior photo/unit), skips folders checked
  // < 24h ago, refuses past the daily cap, then polls the read path until results land.
  const runDeepPhotoCheck = async (opts: { force?: boolean } = {}) => {
    const folders = photoFoldersForUnits();
    if (folders.length === 0) {
      toast({ title: "No unit photos to check", description: "Use Find Photos to add interior photos first." });
      return;
    }
    setPhotoScanning(true);
    try {
      const resp = await fetch("/api/preflight/photo-check", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        cache: opts.force ? "no-store" : "default",
        body: JSON.stringify({ folders, run: true, ...(opts.force ? { force: true } : {}) }),
      });
      const data = await resp.json().catch(() => ({} as any));
      if (data.budget) setPhotoBudget(data.budget);
      if (data.budgetReached) {
        toast({ title: "Daily photo-check budget reached", description: `${data.budget?.used}/${data.budget?.cap} SearchAPI credits used today. Try again tomorrow.`, variant: "destructive" });
        return;
      }
      if (!data.started) {
        await loadPhotoChecks();
        toast({ title: "Already checked recently", description: "Reusing photo results from the last 24h — no credits spent." });
        return;
      }
      const scanning: string[] = data.scanning ?? folders;
      toast({ title: "Deep photo check started", description: `Reverse-image-searching every interior photo for ${scanning.length} unit(s) — this can take 1-3 min each.` });
      const before: Record<string, string | undefined> = {};
      for (const f of scanning) before[f] = photoChecks[f]?.checkedAt;
      // Poll up to ~9 min (90 × 6s): a full-gallery scan of several units is slower than the old
      // 5-photo sample. If it outruns the poll the background job still finishes and the page-load
      // effect picks up the result on the next visit. Bails immediately if the page unmounts.
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 6000));
        if (pollAbortedRef.current) return;
        let d2: any;
        try {
          const resp2 = await fetch("/api/preflight/photo-check", {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
            body: JSON.stringify({ folders, run: false }),
          });
          if (!resp2.ok) continue;
          d2 = await resp2.json();
        } catch { continue; }
        const map: Record<string, PhotoCheckRow> = {};
        for (const c of (d2.checks ?? [])) map[c.folder] = c;
        setPhotoChecks(map);
        if (d2.budget) setPhotoBudget(d2.budget);
        if (scanning.every((f) => map[f]?.checkedAt && map[f]?.checkedAt !== before[f])) break;
      }
    } catch (e: any) {
      toast({ title: "Photo check failed", description: e?.message || String(e), variant: "destructive" });
    } finally {
      setPhotoScanning(false);
    }
  };

  // Undo a saved unit swap — deletes from DB and removes from state
  const handleUndoSwap = async (oldUnitId: string) => {
    const override = unitOverrides[oldUnitId];
    if (override?.swapId) {
      await fetch(`/api/unit-swaps/${override.swapId}`, { method: "DELETE" }).catch(() => {});
    }
    const remaining = { ...unitOverrides };
    delete remaining[oldUnitId];
    setUnitOverrides(remaining);
    setPlatformDone(false);
    setResults({});
  };

  // Called when user confirms "Yes, Replace Unit" in the replacement flow
  function handleUnitReplaced(oldUnitId: string, newUnit: ReplacementUnitData, swapId?: number) {
    if (!property) return;
    const newOverride: UnitOverride = {
      unitNumber: newUnit.unitLabel.replace(/^Unit\s*#?/i, ""),
      address: newUnit.address,
      bedrooms: newUnit.bedrooms ?? property.units.find(u => u.id === oldUnitId)?.bedrooms ?? 1,
      unitLabel: newUnit.unitLabel,
      sourceUrl: newUnit.url,
      photoFolder: newUnit.photoFolder ?? replacementPhotoFolderForUnit(id, oldUnitId),
      swapId,
    };
    const updatedOverrides = { ...unitOverrides, [oldUnitId]: newOverride };
    setUnitOverrides(updatedOverrides);
    setShowReplacementFlow(false);
    setReplacementTargetId(null);
    setReplacementSkipUrl(null);

    // Re-run the platform check with updated units
    const updatedUnits = property.units.map(u => {
      const override = updatedOverrides[u.id];
      if (override) {
        return {
          ...u,
          unitNumber: override.unitNumber,
          bedrooms: override.bedrooms,
          photoFolder: override.photoFolder ?? u.photoFolder,
          _overrideAddress: override.address,
          _isReplaced: true,
          _replacedLabel: override.unitLabel,
          _replacedSourceUrl: override.sourceUrl,
          _originalUnitNumber: u.unitNumber,
        };
      }
      return { ...u, _overrideAddress: undefined, _isReplaced: false, _replacedLabel: undefined, _replacedSourceUrl: undefined, _originalUnitNumber: u.unitNumber };
    });
    runPlatformCheck(updatedUnits);
  }

  async function handleManualReplaceFromUrl(unit: { id: string; unitNumber: string; bedrooms: number }) {
    if (!property?.communityPhotoFolder) return;
    const url = manualReplaceUrl.trim();
    if (!url) {
      toast({ title: "Paste a listing URL", description: "Add the Zillow, Redfin, or Realtor URL for the replacement unit.", variant: "destructive" });
      return;
    }
    setManualReplacingUnitId(unit.id);
    try {
      const resp = await apiRequest("POST", "/api/preflight/manual-unit-replacement", {
        propertyId: id,
        communityFolder: property.communityPhotoFolder,
        oldUnitId: unit.id,
        oldUnitNumber: unit.unitNumber,
        oldBedrooms: unit.bedrooms,
        sourceUrl: url,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
      const swapId = Number(data?.swap?.id ?? 0);
      const unitPayload = data?.unit as ReplacementUnitData | undefined;
      if (!unitPayload?.url) throw new Error("Replacement saved but response was incomplete.");
      handleUnitReplaced(unit.id, {
        ...unitPayload,
        photoFolder: data.photoFolder ?? unitPayload.photoFolder,
        photoCount: data.savedPhotoCount ?? unitPayload.photoCount,
      }, swapId || undefined);
      setManualReplaceUnitId(null);
      setManualReplaceUrl("");
      toast({
        title: "Unit replaced",
        description: `${unitPayload.unitLabel} — ${data.savedPhotoCount ?? 0} photos scraped from your listing URL.`,
        duration: 8000,
      });
    } catch (e: any) {
      toast({ title: "Manual replacement failed", description: e.message, variant: "destructive" });
    } finally {
      setManualReplacingUnitId(null);
    }
  }

  const hasAnyResults = Object.keys(results).length > 0;
  const photoFetchJobForUnit = (unitId: string) => photoFetchJobsByUnit[unitId];
  const photoFetchElapsedSeconds = photoFetchTick;
  const photoFetchProgressValue = (unitId: string) => {
    const job = photoFetchJobForUnit(unitId);
    if (job && (job.status === "queued" || job.status === "running")) {
      return Math.min(94, Math.max(8, job.progress));
    }
    return scrapingUnitId === unitId ? Math.min(94, 16 + photoFetchElapsedSeconds * 1.4) : 0;
  };
  const photoFetchPhaseForUnit = (unitId: string) =>
    photoFetchJobForUnit(unitId)?.message ?? "Finding photos";
  const isPhotoFetchActive = (unitId: string) =>
    !!photoFetchJobIdsByUnit[unitId]
    && (!photoFetchJobForUnit(unitId)
      || photoFetchJobForUnit(unitId)!.status === "queued"
      || photoFetchJobForUnit(unitId)!.status === "running");

  const unitsNeedingPhotos = property?.units.filter((u) => (u.photos?.length ?? 0) === 0) ?? [];
  const showFindAllPhotosButton = unitsNeedingPhotos.length >= 2;
  const anyUnitNeedingPhotosFetching = unitsNeedingPhotos.some((u) => isPhotoFetchActive(u.id));

  const handleScrapePhotosForAllUnits = async () => {
    if (id >= 0 || !property) return;
    const targets = property.units
      .map((unit, i) => ({ unit, unitIndex: (i === 0 ? 0 : 1) as 0 | 1 }))
      .filter(
        ({ unit }) => (unit.photos?.length ?? 0) === 0 && !isPhotoFetchActive(unit.id),
      );
    if (targets.length < 2) return;
    await Promise.all(
      targets.map(({ unit, unitIndex }) => handleScrapePhotosForUnit(unitIndex, unit)),
    );
  };

  const actualProgress = totalUnits > 0 ? (completedCount / totalUnits) * 100 : 0;
  const elapsedSeconds = checkStartedAt ? Math.max(progressTick, Math.floor((Date.now() - checkStartedAt) / 1000)) : 0;
  const activeProgressCap = totalUnits > 0
    ? Math.min(96, ((completedCount + 0.85) / totalUnits) * 100)
    : 0;
  const estimatedWorkingProgress = isCheckRunning && totalUnits > 0
    ? Math.min(activeProgressCap, actualProgress + 8 + elapsedSeconds * (checkPhase === "photo" ? 1.8 : 2.5))
    : actualProgress;
  const platformProgressValue = Math.max(actualProgress, estimatedWorkingProgress);
  const visiblePlatformProgressValue = isCheckRunning
    ? Math.max(14, platformProgressValue)
    : platformProgressValue;
  const checkingLabels = effectiveUnits
    .filter((unit) => checkingUnitIds.has(unit.id))
    .map((unit) => formatUnitDisplayLabel(unit.unitNumber))
    .join(", ");
  const canFullUnitAudit = effectiveUnits.some((unit) => !!(unit as any).photoFolder);
  const targetUnit = replacementTargetId
    ? property.units.find(u => u.id === replacementTargetId) ?? property.units[0]
    : property.units[0];
  const parsedReplacementAddress = parsePropertyAddress(property.address);
  const replacementStreetAddress = inferCommunityStreetAddress({
    communityName: property.complexName,
    city: parsedReplacementAddress.city,
    state: parsedReplacementAddress.state,
    addressHint: parsedReplacementAddress.street || property.address,
  }) || parsedReplacementAddress.street;
  const replacementSkipUrls = Array.from(new Set([
    ...Object.values(unitOverrides).map(o => o.sourceUrl).filter(Boolean),
    ...(replacementSkipUrl ? [replacementSkipUrl] : []),
  ]));

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Back link */}
        <button
          id="link-back-to-dashboard"
          aria-label="Back to previous page"
          onClick={() => window.history.back()}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        {/* Property info */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-1" id="preflight-heading">
            Pre-Flight Check — Is this unit already listed?
          </h1>
          <p className="text-muted-foreground text-sm" id="preflight-property-name">
            {property.propertyName}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5" id="preflight-property-address">
            {property.address}
          </p>
        </div>

        {/* ── Community Photos ──
            Two buttons: "Check photos are correct" verifies the CURRENT folder
            photos with Claude vision + Google Lens and answers YES/NO; "Find
            new community photos" researches the community via Claude, finds
            correct photo URLs, scrapes them into the community folder, then
            double-checks every photo with AI vision + Google Lens
            reverse-image search and removes any that aren't this community. */}
        {property.communityPhotoFolder && (
          <Card className="p-6 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <h2 className="text-base font-semibold">Community Photos</h2>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runCommunityPhotosCheck()}
                  disabled={communityPhotosCheckRunning || repullActive}
                  className="h-8 text-xs"
                  data-testid="button-check-community-photos"
                  title={`Claude vision + Google Lens reverse-image search on every photo in the community folder — confirms they really show ${property.complexName}.`}
                >
                  {communityPhotosCheckRunning ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Checking photos…</>
                  ) : (
                    <><Search className="h-3 w-3 mr-1" /> Check photos are correct</>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleRepullCommunityPhotos()}
                  disabled={repullActive}
                  className="h-8 text-xs"
                  data-testid="button-repull-community-photos"
                >
                  {repullActive ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Finding new photos…</>
                  ) : (
                    <><RefreshCw className="h-3 w-3 mr-1" /> Find new community photos</>
                  )}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Use <strong>Check photos are correct</strong> to confirm the photos already in
              the folder are really <strong>{property.complexName}</strong> — Claude vision
              scans each one (with Google Lens reverse-image search) and answers yes or no.
              Use <strong>Find new community photos</strong> to research the community with
              Claude, find the correct photo URLs, scrape fresh amenity photos (pool,
              grounds, building exteriors), then verify every photo the same way — removing
              any that aren&apos;t actually this community.
            </p>

            {communityPhotosCheckRunning && (
              <p className="mb-3 text-xs text-cyan-700 dark:text-cyan-300">
                Scanning each community photo with Google Lens reverse-image search + Claude
                vision — this can take a few minutes for large folders…
              </p>
            )}
            {communityPhotosCheckError && (
              <p className="mb-3 text-sm text-red-600" data-testid="text-community-photos-check-error">
                ✗ {communityPhotosCheckError}
              </p>
            )}
            {communityPhotosCheckResult && (() => {
              const r = communityPhotosCheckResult;
              const a = communityPhotosCorrectAnswer(
                r.expectedCommunity || property.complexName,
                r.verdict,
                r.community,
              );
              const headline =
                a.answer === "yes"
                  ? {
                      cls: "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300",
                      Icon: CheckCircle2,
                    }
                  : a.answer === "no"
                    ? {
                        cls: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200",
                        Icon: XCircle,
                      }
                    : {
                        cls: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200",
                        Icon: AlertTriangle,
                      };
              // The "pre-screen" outlier is the dHash diversity note, not a photo.
              const flagged = [
                ...(r.community?.outliers ?? []),
                ...(r.community?.junk ?? []),
              ].filter((f) => f.id !== "pre-screen");
              return (
                <div className="mb-3" data-testid="result-community-photos-check">
                  <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm font-medium ${headline.cls}`}>
                    <headline.Icon className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{a.headline}</span>
                  </div>
                  {r.community && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        Identified as <strong className="text-foreground">{r.community.identifiedCommunity || "—"}</strong>
                      </span>
                      {typeof r.community.photosChecked === "number" && (
                        <span>
                          {r.community.photosChecked}
                          {typeof r.community.photosTotal === "number" ? ` of ${r.community.photosTotal}` : ""} photos checked
                        </span>
                      )}
                    </div>
                  )}
                  {flagged.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-xs text-red-700 dark:text-red-300">
                      {flagged.slice(0, 6).map((f, i) => (
                        <li key={i}>
                          {f.caption || f.id}: {f.reason}
                        </li>
                      ))}
                      {flagged.length > 6 && <li>…and {flagged.length - 6} more flagged photo(s).</li>}
                    </ul>
                  )}
                  {a.answer !== "yes" && (r.community?.recommendation || r.community?.matchReason) && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {r.community?.recommendation || r.community?.matchReason}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">{r.summary}</p>
                </div>
              );
            })()}

            {repullActive && communityRepullJob && (
              <div className="rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="font-medium">{communityRepullJob.message}</span>
                  <span className="text-blue-700 dark:text-blue-300">
                    {Math.round(communityRepullJob.progress)}% · safe to leave this tab
                  </span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900"
                  role="progressbar"
                  aria-label="Finding new community photos"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(communityRepullJob.progress)}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 transition-all duration-700"
                    style={{ width: `${communityRepullJob.progress}%` }}
                  />
                </div>
              </div>
            )}

            {!repullActive && communityRepullJob?.status === "completed" && (
              <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300">
                <div className="flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {communityRepullJob.message}
                </div>
                {communityRepullJob.researchSummary && (
                  <p className="mt-1 text-green-700 dark:text-green-400">{communityRepullJob.researchSummary}</p>
                )}
                {communityRepullJob.removed.length > 0 && (
                  <ul className="mt-1.5 list-disc pl-4 text-green-700 dark:text-green-400">
                    {communityRepullJob.removed.slice(0, 5).map((r, i) => (
                      <li key={i}>Removed {r.filename ?? "a photo"} — {r.reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {!repullActive && communityRepullJob?.status === "failed" && (
              <div className="rounded-md border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
                {communityRepullJob.error || communityRepullJob.message}
              </div>
            )}

            {/* Confirms what state the community is actually in (catches a
                community filed under the wrong state, e.g. Bay Watch = SC not FL). */}
            <LocationConfirmationNote confirmation={communityRepullJob?.locationConfirmation ?? null} />
          </Card>
        )}

        {/* ── Photo Sources (promoted drafts only) ──
            The reverse-image-search half of the Platform Check needs
            photos to scan. When the wizard's Step 4 scrape didn't
            find a matching Zillow listing, the unit photo folders
            arrive empty. This card calls the same multi-query Zillow
            discovery that /api/replacement/find-unit uses for active
            properties — operator clicks one button per unit, no URL
            paste needed. "Try another" walks through subsequent
            results so a bad first match isn't a dead end. */}
        {isPromotedDraft && (
          <Card className="p-6 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <h2 className="text-base font-semibold">Photo Sources</h2>
              {showFindAllPhotosButton && (
                <Button
                  size="sm"
                  onClick={() => void handleScrapePhotosForAllUnits()}
                  disabled={anyUnitNeedingPhotosFetching}
                  className="h-8 text-xs"
                  data-testid="button-scrape-photos-all-units"
                >
                  {anyUnitNeedingPhotosFetching ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Finding photos for all units…
                    </>
                  ) : (
                    <>
                      <Search className="h-3 w-3 mr-1" />
                      Find Photos for All Units
                    </>
                  )}
                </Button>
              )}
            </div>
            {/* Confirms what state/city the units are in (catches a unit whose
                community is filed under the wrong state, e.g. Bay Watch = SC not FL). */}
            <LocationConfirmationNote confirmation={unitLocationConfirmation} />
            {(() => {
              const allUnitsHavePhotos = effectiveUnits.length > 0
                && effectiveUnits.every((unit) => photoCountForUnit(unit.id, unit.photos?.length ?? 0) > 0);
              const someUnitsHavePhotos = effectiveUnits.some((unit) =>
                photoCountForUnit(unit.id, unit.photos?.length ?? 0) > 0);
              if (allUnitsHavePhotos) {
                return (
                  <p className="text-sm text-muted-foreground mb-4">
                    Photos are already saved for every unit at{" "}
                    <strong>{property.complexName}</strong>. The Platform Check
                    can use the photos on file when you click <strong>Run check</strong>{" "}
                    below. Use <strong>Re-pull all photos</strong> to rescrape this
                    unit&apos;s own listing and refresh its full gallery. To swap in a
                    different unit entirely, use <strong>Replace with URL</strong> (paste a listing you chose) or <strong>Find / Replace a Unit</strong> (automatic search).
                  </p>
                );
              }
              if (someUnitsHavePhotos) {
                return (
                  <p className="text-sm text-muted-foreground mb-4">
                    Some units already have photos saved. Click <strong>Find Photos</strong>{" "}
                    for any unit without photos, or <strong>Re-pull all photos</strong>{" "}
                    to rescrape a unit&apos;s own listing and refresh its gallery. Then click{" "}
                    <strong>Run check</strong> on the Platform Check.
                  </p>
                );
              }
              return (
                <p className="text-sm text-muted-foreground mb-4">
                  The reverse-image-search half of the Platform Check below needs
                  photos to scan. Click <strong>Find Photos for All Units</strong>{" "}
                  (or <strong>Find Photos</strong> per unit) and we&apos;ll search
                  Zillow for representative listings at{" "}
                  <strong>{property.complexName}</strong>, scrape their photos, and
                  save them to the draft. Then click <strong>Run check</strong>{" "}
                  on the Platform Check.
                </p>
              );
            })()}
            <div className="space-y-3">
              {effectiveUnits.map((unit, i) => {
                const savedPhotoCount = photoCountForUnit(unit.id, unit.photos?.length ?? 0);
                const folderHasPhotos = savedPhotoCount > 0;
                const skippedCount = (skippedUrlsByUnit[unit.id] ?? []).length;
                const isScrapingThisUnit = isPhotoFetchActive(unit.id);
                const unitProgress = photoFetchProgressValue(unit.id);
                const isReplaced = !!unitOverrides[unit.id];
                const unitFolder = (unit as any).photoFolder as string | undefined;
                const unitSource = unitFolder ? unitSourceByFolder[unitFolder] : undefined;
                const sourceRevealed = revealedSourceUnitIds.has(unit.id);
                return (
                  <div key={unit.id} className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium w-20 flex-shrink-0">
                      Unit {String.fromCharCode(65 + i)}
                    </span>
                    <span className="text-xs text-muted-foreground flex-1">
                      {unit.bedrooms}BR · ~{unit.sqft || "?"} sqft
                      {isReplaced && (unit as any)._replacedLabel ? (
                        <span className="block text-[10px] text-green-700 dark:text-green-400 truncate">
                          → {(unit as any)._replacedLabel}
                        </span>
                      ) : null}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => handleScrapePhotosForUnit(i === 0 ? 0 : 1, unit)}
                      disabled={isScrapingThisUnit}
                      className="h-8 text-xs"
                      data-testid={`button-scrape-photos-${unit.id}`}
                    >
                      {isScrapingThisUnit ? (
                        <>
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          Searching… {photoFetchElapsedSeconds}s
                        </>
                      ) : folderHasPhotos ? (
                        <><RefreshCw className="h-3 w-3 mr-1" /> Re-pull all photos</>
                      ) : (
                        <><Search className="h-3 w-3 mr-1" /> Find Photos</>
                      )}
                    </Button>
                    {folderHasPhotos && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggleRevealSource(unit.id)}
                        className="h-8 text-xs flex-shrink-0"
                        data-testid={`button-view-source-${unit.id}`}
                        title="Show the original listing (Zillow, Redfin, etc.) these photos were scraped from"
                      >
                        <ExternalLink className="h-3 w-3 mr-1" />
                        {sourceRevealed ? "Hide source" : "View source"}
                      </Button>
                    )}
                    {folderHasPhotos && (
                      <Badge variant="outline" className="text-[10px] flex-shrink-0">
                        {savedPhotoCount} on file
                      </Badge>
                    )}
                    {!swapsCommitted && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (manualReplaceUnitId === unit.id) {
                            setManualReplaceUnitId(null);
                            setManualReplaceUrl("");
                          } else {
                            setManualReplaceUnitId(unit.id);
                            setManualReplaceUrl(unitOverrides[unit.id]?.sourceUrl ?? "");
                          }
                        }}
                        disabled={manualReplacingUnitId === unit.id}
                        className="h-8 text-xs flex-shrink-0"
                        data-testid={`button-manual-replace-${unit.id}`}
                      >
                        {manualReplacingUnitId === unit.id ? (
                          <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Replacing…</>
                        ) : (
                          <><Link2 className="h-3 w-3 mr-1" /> Replace with URL</>
                        )}
                      </Button>
                    )}
                    {/* Reveal the original scrape source URL on demand. */}
                    {folderHasPhotos && sourceRevealed && (
                      <div
                        className="basis-full rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs"
                        data-testid={`source-panel-${unit.id}`}
                      >
                        {unitSource === undefined ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Loading source…
                          </span>
                        ) : unitSource ? (
                          <div className="flex items-start gap-1.5">
                            <MapPin className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
                            <span className="min-w-0">
                              <span className="font-medium">Scraped from {sourcePlatformLabel(unitSource)}:</span>{" "}
                              <a
                                href={unitSource.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline break-all"
                              >
                                {unitSource.url}
                              </a>
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            No original source URL on file for this unit. A re-pull will record one if it discovers a listing.
                          </span>
                        )}
                      </div>
                    )}
                    {manualReplaceUnitId === unit.id && !manualReplacingUnitId && (
                      <div
                        className="basis-full rounded-md border border-amber-200 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30 px-3 py-2 space-y-2"
                        data-testid={`manual-replace-panel-${unit.id}`}
                      >
                        <p className="text-xs text-amber-900 dark:text-amber-200">
                          Paste the Zillow, Redfin, or Realtor URL for the unit you want instead. We&apos;ll scrape its photos, replace this unit&apos;s gallery, and update the listing.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Input
                            value={manualReplaceUrl}
                            onChange={(e) => setManualReplaceUrl(e.target.value)}
                            placeholder="https://www.zillow.com/homedetails/..."
                            className="h-8 text-xs flex-1"
                            data-testid={`input-manual-replace-url-${unit.id}`}
                          />
                          <Button
                            size="sm"
                            className="h-8 text-xs flex-shrink-0"
                            onClick={() => void handleManualReplaceFromUrl(unit)}
                            data-testid={`button-confirm-manual-replace-${unit.id}`}
                          >
                            Scrape &amp; replace unit
                          </Button>
                        </div>
                      </div>
                    )}
                    {skippedCount > 0 && !folderHasPhotos && (
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        skipped {skippedCount}
                      </span>
                    )}
                    {photoFetchJobForUnit(unit.id)?.status === "failed" && (
                      <div className="basis-full space-y-1 rounded-md border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-900">
                        <p>{photoFetchJobForUnit(unit.id)?.error || photoFetchJobForUnit(unit.id)?.message}</p>
                        <OperationFailureActions
                          jobType="preflight-photo-fetch"
                          jobId={photoFetchJobForUnit(unit.id)?.id}
                          startPayload={photoFetchStartPayloadByUnit.current[unit.id]}
                          onRemediated={({ job }) => {
                            if (job && typeof job === "object" && "id" in job) {
                              const next = job as PreflightPhotoFetchJob;
                              setPhotoFetchJobIdsByUnit((prev) => {
                                const updated = { ...prev, [unit.id]: next.id };
                                savePhotoFetchJobIds(id, updated);
                                return updated;
                              });
                              applyPhotoFetchJob(unit.id, next);
                            }
                          }}
                        />
                      </div>
                    )}
                    {isScrapingThisUnit && (
                      <div className="basis-full rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs text-blue-900">
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <span className="font-medium">
                            {photoFetchPhaseForUnit(unit.id)}
                          </span>
                          <span className="text-blue-700">
                            {Math.round(unitProgress)}% · safe to leave this tab
                          </span>
                        </div>
                        <div
                          className="h-2 overflow-hidden rounded-full bg-blue-100"
                          role="progressbar"
                          aria-label={`Finding photos for Unit ${String.fromCharCode(65 + i)}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(unitProgress)}
                        >
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 transition-all duration-700"
                            style={{ width: `${unitProgress}%` }}
                          />
                        </div>
                      </div>
                    )}
                    {/* Sticky receipt: when this unit's photos were last
                        re-pulled and whether it worked (× dismisses). */}
                    {!isScrapingThisUnit && photoFetchReceipts[unit.id] && (
                      <OperationReceiptNote
                        receipt={photoFetchReceipts[unit.id]}
                        relative={fmtRelative}
                        onDismiss={() => dismissPhotoFetchReceipt(unit.id)}
                        testId={`receipt-photo-fetch-${unit.id}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* ── Community Match — are Unit A + Unit B in the SAME community as the
            community folder? Photos (Google Lens + Claude vision) AND each unit's
            source listing page are Claude-checked. Same engine as the builder
            Photos-tab "Check photo community" button, surfaced on preflight so
            the operator can confirm before continuing to the builder. */}
        <Card className="p-6 mb-6" data-testid="card-community-match">
          <div className="flex items-start justify-between gap-4 mb-1">
            <h2 className="text-base font-semibold">Community Match</h2>
            <Button
              id="btn-community-match-check"
              aria-label="Confirm units are in the same community as the community folder"
              variant="outline"
              size="sm"
              onClick={runCommunityMatchCheck}
              disabled={communityMatchRunning}
              className="h-7 px-2 text-xs flex-shrink-0"
              data-testid="btn-preflight-community-match"
              title="Claude-checks every unit's photos AND its source listing page against the community folder."
            >
              {communityMatchRunning ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Checking…</>
              ) : (
                <><Search className="h-3 w-3 mr-1" /> Confirm units match community</>
              )}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Confirms {property.units.length >= 2 ? "Unit A and Unit B are" : "each unit is"} in the
            same community as the <strong>{property.complexName}</strong> community folder — unit
            photos are checked with Claude vision against the community photos, and each unit's
            source listing page is read to confirm it names this community.
          </p>
          {communityMatchRunning && (
            <p className="mt-2 text-xs text-cyan-700 dark:text-cyan-300">
              Reverse-image search + Claude vision on the photos, then a Claude read of each unit's
              source page — this can take a few minutes for large folders…
            </p>
          )}
          {communityMatchError && (
            <p className="mt-2 text-sm text-red-600" data-testid="text-community-match-error">✗ {communityMatchError}</p>
          )}
          {communityMatchResult && (() => {
            const r = communityMatchResult;
            const spByLabel = new Map((r.sourcePages ?? []).map((sp) => [sp.unitLabel, sp]));
            const pill = (tone: "green" | "red" | "amber" | "slate", label: string) => {
              const cls =
                tone === "green"
                  ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300"
                  : tone === "red"
                    ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                    : tone === "amber"
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
              return (
                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${cls}`}>
                  {label}
                </span>
              );
            };
            const sourcePill = (sp?: CommunityMatchSourcePage) =>
              !sp
                ? pill("slate", "Source page: no URL")
                : sp.match === "yes"
                  ? pill("green", "✓ Source page confirms")
                  : sp.match === "no"
                    ? pill("red", "✕ Source page differs")
                    : pill("amber", sp.unreadable ? "Source page unreadable" : "Source page unclear");
            const headline =
              r.allSameCommunity === "yes" && r.verdict === "pass"
                ? {
                    cls: "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300",
                    Icon: CheckCircle2,
                    text: `YES — all units match the ${r.expectedCommunity || property.complexName} community folder`,
                  }
                : r.verdict === "fail"
                  ? {
                      cls: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200",
                      Icon: XCircle,
                      text: "NO — a community mismatch was found. Review the details below.",
                    }
                  : {
                      cls: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200",
                      Icon: AlertTriangle,
                      text: "Review — the community match could not be fully confirmed.",
                    };
            return (
              <div className="mt-3" data-testid="result-community-match">
                <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm font-medium ${headline.cls}`}>
                  <headline.Icon className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{headline.text}</span>
                </div>
                <div className="mt-3 space-y-2">
                  {r.community && (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{r.community.label}</span>
                      <span className="text-muted-foreground">identified as</span>
                      <strong>{r.community.identifiedCommunity || "—"}</strong>
                      <span className="ml-auto">
                        {r.community.matchesExpected === "yes"
                          ? pill("green", "✓ Matches expected community")
                          : r.community.overallStatus === "mismatch"
                            ? pill("red", "✕ Different place")
                            : pill("amber", "Unconfirmed")}
                      </span>
                    </div>
                  )}
                  {r.units.map((u) => {
                    const sp = spByLabel.get(u.label);
                    return (
                      <div key={u.label} className="flex flex-wrap items-center gap-2 border-t pt-2 text-sm">
                        <span className="font-medium">{u.label}</span>
                        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                          {u.sameAsCommunity === "yes"
                            ? pill("green", "✓ Photos match community")
                            : pill("red", "✕ Photos differ")}
                          {sourcePill(sp)}
                          {sp?.url ? (
                            <a
                              href={sp.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-0.5 text-xs text-cyan-700 hover:underline dark:text-cyan-300"
                            >
                              source <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : null}
                        </span>
                        {u.sameAsCommunity === "no" && (
                          <div className="w-full text-xs text-red-700 dark:text-red-300">{u.reason}</div>
                        )}
                        {sp && sp.match !== "yes" && (
                          <div className="w-full text-xs text-muted-foreground">
                            {sp.reason}
                            {sp.identifiedLocation ? ` · 📍 ${sp.identifiedLocation}` : ""}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {r.concerns.length > 0 && (
                  <ul
                    className={`mt-3 list-disc pl-5 text-xs ${
                      r.verdict === "fail" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"
                    }`}
                  >
                    {r.concerns.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-muted-foreground">{r.summary}</p>
              </div>
            );
          })()}
        </Card>

        {/* ── Platform Check ── */}
        <Card className="p-6 mb-6">
          <div className="flex items-start justify-between gap-4 mb-1">
            <h2 className="text-base font-semibold">Platform Check</h2>
            {!isCheckRunning && (
              <div className="flex flex-wrap justify-end gap-2">
                {canFullUnitAudit && (
                  <Button
                    id="btn-full-unit-audit"
                    aria-label="Run full unit audit (text + reverse-image photos)"
                    variant="outline"
                    size="sm"
                    onClick={runFullUnitAudit}
                    disabled={photoScanning}
                    className="h-7 px-2 text-xs flex-shrink-0"
                    title="Text search + reverse-image photo check (every interior photo per unit) against Airbnb / VRBO / Booking. Listed only when both text and photos confirm the same unit; otherwise Not Listed."
                  >
                    {photoScanning ? (
                      <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Auditing photos…</>
                    ) : (
                      <><Camera className="h-3 w-3 mr-1" /> Full unit audit</>
                    )}
                  </Button>
                )}
                <Button
                  id={platformDone ? "btn-rerun-checks" : "btn-run-checks"}
                  aria-label={platformDone ? "Re-run platform check" : "Run platform check"}
                  variant="ghost"
                  size="sm"
                  onClick={rerunChecks}
                  disabled={photoScanning}
                  className="h-7 px-2 text-xs flex-shrink-0"
                >
                  {platformDone ? (
                    <>
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Re-run
                    </>
                  ) : (
                    <>
                      <Search className="h-3 w-3 mr-1" />
                      Run check
                    </>
                  )}
                </Button>
                {photoBudget && (
                  <span
                    className="self-center text-[10px] text-muted-foreground"
                    title="SearchAPI credits used today for photo checks (resets daily)"
                  >
                    {photoBudget.cap == null
                      ? `${photoBudget.used} photo checks today`
                      : `${photoBudget.used}/${photoBudget.cap} photo credits today`}
                  </span>
                )}
              </div>
            )}
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {isPromotedDraft
              ? "Click Run check when you're ready. It searches Airbnb, VRBO, and Booking.com for each unit using text search and reverse image search."
              : "Searches Airbnb, VRBO, and Booking.com for each unit using text search and reverse image search."}
          </p>
          {lastCheckWasFullAudit && hasAnyResults && (
            <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
              Full unit audit complete — each unit was checked by text search and by a reverse-image scan of <strong>every interior photo</strong> against Airbnb, VRBO, and Booking.com. Each platform shows a decisive verdict: <strong>Listed</strong> only when <strong>both</strong> text search and photo scan confirm the same unit, or <strong>Not Listed</strong> otherwise.
            </div>
          )}
          {/* Sticky receipt: when the OTA unit audit last ran and whether it
              succeeded — stays until the operator clicks × to dismiss. */}
          {!isCheckRunning && platformCheckReceipt && (
            <div className="mb-4">
              <OperationReceiptNote
                receipt={platformCheckReceipt}
                relative={fmtRelative}
                onDismiss={() => recordPlatformCheckReceipt(null)}
                testId="receipt-platform-check"
              />
            </div>
          )}

          {/* Committed swaps summary — renders every unit (swapped OR original)
              so the user can rescrape any one of them directly. */}
          {property.units.length > 0 && swapsCommitted && (
            <div className="mb-5 rounded-md border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                  <p className="text-sm font-semibold text-green-800 dark:text-green-300">
                    {Object.keys(unitOverrides).length > 0
                      ? `Unit replacement${Object.keys(unitOverrides).length > 1 ? "s" : ""} committed`
                      : "Units confirmed — none needed replacement"}
                  </p>
                </div>
                <Button
                  id="btn-recheck-committed"
                  size="sm"
                  variant="outline"
                  onClick={rerunChecks}
                  disabled={isCheckRunning}
                  className="h-7 px-3 text-xs border-green-400 dark:border-green-600 text-green-800 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/40 flex-shrink-0"
                >
                  {isCheckRunning ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Checking…</>
                  ) : (
                    <><RotateCcw className="h-3 w-3 mr-1" /> Recheck these units</>
                  )}
                </Button>
              </div>
              <div className="space-y-1.5">
                {property.units.map((origUnit, idx) => {
                  const override = unitOverrides[origUnit.id];
                  const unitPhotoFolder = override?.photoFolder ?? origUnit.photoFolder;
                  const positionLabel = `Unit ${String.fromCharCode(65 + idx)}`;
                  // Rescrape now runs as a server-side background job, so the
                  // operator can fire it and leave the tab. The completion toast /
                  // needs-URL prompt / sticky receipt are handled by the rescrape
                  // poll effect (applyRescrapeJob).
                  const rescrapeHandler = () => {
                    if (!unitPhotoFolder) {
                      toast({ title: "Can't rescrape", description: "No photoFolder on this unit.", variant: "destructive" });
                      return;
                    }
                    void startRescrapeJob(unitPhotoFolder);
                    toast({ title: "Rescrape started", description: "Re-pulling this unit's photos — safe to leave this tab." });
                  };
                  const rescrapeActive = !!(unitPhotoFolder && rescrapeJobIdsByFolder[unitPhotoFolder]);
                  const receipt = unitPhotoFolder ? rescrapeReceipts[unitPhotoFolder] : undefined;
                  return (
                    <div key={origUnit.id} className="rounded border border-green-200 dark:border-green-700 bg-white/60 dark:bg-background/40 px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="text-xs text-muted-foreground font-medium">{positionLabel}</span>
                        {override ? (
                          <>
                            <span className="text-muted-foreground line-through text-xs">Unit {origUnit.unitNumber}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="font-medium">{override.unitLabel}</span>
                            <span className="text-xs text-muted-foreground truncate">{override.address}</span>
                          </>
                        ) : (
                          <>
                            <span className="font-medium">Unit {origUnit.unitNumber}</span>
                            <span className="text-xs text-muted-foreground">({origUnit.bedrooms}BR · original, no swap)</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs border-blue-400 dark:border-blue-600 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40"
                          disabled={rescrapeActive}
                          onClick={rescrapeHandler}
                          data-testid={`button-rescrape-unit-${origUnit.id}`}
                        >
                          {rescrapeActive ? (
                            <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Rescraping…</>
                          ) : (
                            <><RefreshCw className="h-3 w-3 mr-1" /> Rescrape photos</>
                          )}
                        </Button>
                        {override ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs border-green-400 dark:border-green-600 text-green-800 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/40"
                              onClick={async () => {
                                const skipReplacementUrl = unitOverrides[origUnit.id]?.sourceUrl ?? null;
                                setSwapsCommitted(false);
                                await handleUndoSwap(origUnit.id);
                                setReplacementSkipUrl(skipReplacementUrl);
                                setReplacementTargetId(origUnit.id);
                                setShowReplacementFlow(true);
                              }}
                              data-testid={`button-change-committed-swap-${origUnit.id}`}
                            >
                              Change
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              onClick={() => { setSwapsCommitted(false); handleUndoSwap(origUnit.id); }}
                              data-testid={`button-undo-committed-swap-${origUnit.id}`}
                            >
                              Undo
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs border-amber-400 dark:border-amber-600 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                            onClick={() => {
                              setSwapsCommitted(false);
                              setReplacementSkipUrl(null);
                              setReplacementTargetId(origUnit.id);
                              setShowReplacementFlow(true);
                            }}
                            data-testid={`button-find-replacement-${origUnit.id}`}
                          >
                            Find replacement
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* Sticky rescrape receipt — survives navigation via
                        localStorage so the user remembers what they did. */}
                    {receipt && (
                      <div
                        className="flex items-center gap-2 rounded bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-700 px-2 py-1 text-[11px] text-blue-800 dark:text-blue-300"
                        data-testid={`receipt-rescrape-${origUnit.id}`}
                      >
                        <CheckCircle2 className="h-3 w-3 flex-shrink-0" />
                        <span className="font-medium">
                          Rescraped {fmtRelative(receipt.timestamp)}
                        </span>
                        <span className="text-blue-600 dark:text-blue-400">
                          · {receipt.savedCount} photo{receipt.savedCount !== 1 ? "s" : ""}
                          {receipt.bedroomCount > 0 ? ` · ${receipt.bedroomCount} bedroom${receipt.bedroomCount !== 1 ? "s" : ""}` : ""}
                          {receipt.bathroomCount > 0 ? ` · ${receipt.bathroomCount} bathroom${receipt.bathroomCount !== 1 ? "s" : ""}` : ""}
                          {receipt.bedroomCount === 0 && receipt.bathroomCount === 0 ? " · ⚠ no interior shots" : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => receipt.folder && dismissReceipt(receipt.folder)}
                          className="ml-auto text-blue-500 hover:text-blue-700 text-base leading-none px-1"
                          aria-label="Dismiss confirmation"
                          title="Dismiss"
                        >
                          ×
                        </button>
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-green-700 dark:text-green-400">
                <strong>Rescrape photos</strong> pulls the latest photo set from the same Zillow listing · <strong>Change</strong> searches for a different replacement unit · <strong>Recheck</strong> re-verifies the current ones aren't already listed on Airbnb/VRBO/Booking.
              </p>
            </div>
          )}

          {/* Pending (not yet committed) swaps summary */}
          {Object.keys(unitOverrides).length > 0 && !swapsCommitted && (
            <div className="mb-5 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  Saved unit replacement{Object.keys(unitOverrides).length > 1 ? "s" : ""} active
                </p>
              </div>
              <div className="space-y-2">
                {Object.entries(unitOverrides).map(([oldUnitId, override]) => {
                  const origUnit = property.units.find(u => u.id === oldUnitId);
                  return (
                    <div key={oldUnitId} className="flex items-center justify-between gap-2 rounded border border-amber-200 dark:border-amber-700 bg-white/60 dark:bg-background/40 px-3 py-2">
                      <div className="text-sm flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="text-muted-foreground line-through text-xs">Unit {origUnit?.unitNumber ?? oldUnitId}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-medium">{override.unitLabel}</span>
                        <span className="text-xs text-muted-foreground truncate">{override.address}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 flex-shrink-0"
                        onClick={() => handleUndoSwap(oldUnitId)}
                        data-testid={`button-undo-swap-${oldUnitId}`}
                      >
                        Undo
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Progress bar */}
          {isCheckRunning && totalUnits > 0 && (
            <div className="mb-4 space-y-2 rounded-md border border-primary/15 bg-primary/5 p-3">
              <style>{`
                @keyframes preflight-progress-stripes {
                  from { background-position: 0 0; }
                  to { background-position: 32px 0; }
                }
              `}</style>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5 font-medium">
                  {fullAuditRunning ? (
                    <><Camera className="h-3.5 w-3.5 animate-pulse text-primary" /> Running full unit photo audit…</>
                  ) : checkPhase === "photo" ? (
                    <><Camera className="h-3.5 w-3.5 animate-pulse text-primary" /> Running photo reverse-image search…</>
                  ) : checkPhase === "text" ? (
                    <><Search className="h-3.5 w-3.5 animate-pulse text-primary" /> Searching Airbnb, VRBO &amp; Booking.com…</>
                  ) : (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</>
                  )}
                </span>
                <span>{completedCount} / {totalUnits} unit{totalUnits !== 1 ? "s" : ""} done · {elapsedSeconds}s</span>
              </div>
              <div
                className="relative h-3 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(visiblePlatformProgressValue)}
                aria-label="Platform check progress"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
                  style={{
                    width: `${Math.min(100, visiblePlatformProgressValue)}%`,
                    backgroundImage:
                      "linear-gradient(45deg, rgba(255,255,255,0.28) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0.28) 75%, transparent 75%, transparent)",
                    backgroundSize: "32px 32px",
                    animation: "preflight-progress-stripes 1s linear infinite",
                  }}
                />
                <div className="absolute inset-0 animate-pulse bg-primary/10" />
              </div>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <p>
                  {fullAuditRunning
                    ? "Checking every available unit photo with Google Lens."
                    : checkPhase === "photo"
                    ? "Uploading photos for reverse-image matches."
                    : "Checking address and unit-number matches."}
                </p>
                <p className="font-medium text-foreground/80">
                  {checkingLabels ? `Working on ${checkingLabels}` : "Finalizing results..."}
                </p>
              </div>
              {/* Per-platform progress: how many units each search has resolved. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-primary/10 pt-2 text-[11px] text-muted-foreground">
                {PLATFORM_LIST.map(({ key, label }) => {
                  const done = Math.min(
                    totalUnits,
                    effectiveUnits.reduce((n, u) => n + (results[u.id]?.platforms?.[key] ? 1 : 0), 0),
                  );
                  const allDone = totalUnits > 0 && done >= totalUnits;
                  return (
                    <span key={key} className="inline-flex items-center gap-1.5">
                      {allDone
                        ? <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" />
                        : <Loader2 className="h-3 w-3 animate-spin" />}
                      <span className="font-medium text-foreground/70">{label}</span>
                      <span>{done}/{totalUnits}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Results — compact unit-first cards */}
          {(isCheckRunning || hasAnyResults) && (
            <div id="platform-check-table" className="mt-3 space-y-2">
              {effectiveUnits.map((unit) => {
                const unitResult = results[unit.id];
                const isReplaced = (unit as any)._isReplaced;
                const displayAddress = (unit as any)._overrideAddress || `${property.address}, ${formatUnitDisplayLabel(unit.unitNumber)}`;
                const unitChecking = checkingUnitIds.has(unit.id);

                return (
                  <div
                    key={unit.id}
                    id={`check-${unit.id}`}
                    className="rounded-md border border-border/70 bg-background/75 px-3 py-3"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                      <div className="min-w-0 lg:w-64 lg:flex-shrink-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{formatUnitDisplayLabel(unit.unitNumber)}</p>
                          {isReplaced && !swapsCommitted && (
                            <Badge variant="secondary" className="text-[10px] py-0 px-1.5 h-5">
                              replaced
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate" title={displayAddress}>
                          {displayAddress}
                        </p>
                      </div>

                      <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
                        {PLATFORM_LIST.map(({ key, label }) => {
                          const folder = (unit as any).photoFolder as string | undefined;
                          const pc = folder ? photoChecks[folder] : undefined;
                          // Per-platform photo verdict for this folder, only once the folder was scanned.
                          const ps = (pc && pc.scanned ? pc[key as "airbnb" | "vrbo" | "booking"] : undefined) as PhotoMatchStatus | undefined;
                          // A "clean" only decides the verdict when it came from a DEEP scan (full
                          // gallery), not a shallow 3-photo background row — else we'd assert a false NO.
                          const photoDeep = !!pc && pc.scanned && (Number(pc.photosChecked) || 0) >= DEEP_PHOTO_MIN;
                          const inFullAudit = lastCheckWasFullAudit || fullAuditRunning;
                          const photoPending = inFullAudit && !!folder && (photoScanning || !pc?.scanned);
                          const r = mergeUnitVerdict(unitResult?.platforms[key], ps, photoDeep, {
                            requireDual: inFullAudit && !!folder,
                            photoPending,
                            hasPhotoFolder: !!folder,
                          });
                          return (
                            <div key={key} id={`check-${key}-${unit.id}`} className="rounded border border-border/60 bg-muted/20 px-2.5 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {label}
                                </span>
                                {r?.url && (
                                  <a
                                    id={`link-${key}-${unit.id}`}
                                    href={r.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-primary hover:underline text-[11px]"
                                  >
                                    View <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                              </div>
                              <div className="mt-1.5">
                                <CompactStatusBadge result={r} checking={unitChecking || photoPending} />
                              </div>
                              {r?.detection && (
                                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground" title={r.detection}>
                                  {r.detection}
                                </p>
                              )}
                              {(() => {
                                if (!folder) return null;
                                const matches = (pc as any)?.[`${key}Matches`] as Array<{ listingUrl?: string }> | undefined;
                                const matchUrl = matches?.find((m) => m?.listingUrl)?.listingUrl;
                                if (photoScanning && (!pc || ps === undefined)) {
                                  return (
                                    <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                      <Loader2 className="h-3 w-3 animate-spin" /> Photo check…
                                    </p>
                                  );
                                }
                                if (!pc || !pc.scanned || ps === undefined) {
                                  return <p className="mt-1 text-[10px] text-muted-foreground/60"><Camera className="inline h-3 w-3 mr-0.5" />photos not checked</p>;
                                }
                                if (ps === "found") {
                                  return (
                                    <p className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 dark:text-red-300" title="This unit's interior photos appear on a live listing here">
                                      <Camera className="h-3 w-3" /> Photos match a listing
                                      {matchUrl && <a href={matchUrl} target="_blank" rel="noopener noreferrer" className="underline">view</a>}
                                    </p>
                                  );
                                }
                                if (ps === "clean") {
                                  return <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400" title="Interior photos reverse-image-searched — no match found here"><Camera className="h-3 w-3" /> Photos clear</p>;
                                }
                                return <p className="mt-1 text-[10px] text-muted-foreground/60"><Camera className="inline h-3 w-3 mr-0.5" />photos inconclusive</p>;
                              })()}
                            </div>
                          );
                        })}
                      </div>

                      {property.communityPhotoFolder && !swapsCommitted && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2.5 text-xs lg:flex-shrink-0"
                          data-testid={`button-replace-unit-${unit.id}`}
                          onClick={() => {
                            setReplacementTargetId(unit.id);
                            setShowReplacementFlow(true);
                          }}
                        >
                          <RefreshCw className="h-3 w-3 mr-1" />
                          {isReplaced ? "Change" : "Replace"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Status legend */}
          {hasAnyResults && (
            <div className="mt-4 pt-4 border-t border-border/60 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-600" /> Yes — community, location, and unit all matched</span>
              <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-red-500" /> No — no verified listing match</span>
            </div>
          )}
        </Card>

        {/* Bottom action buttons */}
        <div className="flex flex-col sm:flex-row gap-3" id="preflight-actions">
          {Object.keys(unitOverrides).length > 0 && !swapsCommitted ? (
            <Button
              id="btn-commit-and-continue"
              aria-label="Commit replacement units and continue to builder"
              size="lg"
              onClick={commitAndContinue}
              disabled={committing}
              className="sm:w-auto"
            >
              {committing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</>
              ) : (
                <>Commit Replacements &amp; Continue <ArrowRight className="h-4 w-4 ml-2" /></>
              )}
            </Button>
          ) : (
            <Button
              id="btn-continue-to-wizard"
              aria-label="Continue to the property builder wizard"
              size="lg"
              onClick={() => setLocation(step1Url)}
              className="sm:w-auto"
            >
              Continue to Builder <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          )}
          {property.communityPhotoFolder && (
            <Button
              id="btn-use-different-unit"
              aria-label="Find a replacement unit"
              size="lg"
              variant="outline"
              onClick={() => {
                setReplacementTargetId(null);
                setReplacementSkipUrl(null);
                setShowReplacementFlow(v => !v);
              }}
              className="sm:w-auto"
            >
              Find / Replace a Unit
            </Button>
          )}
        </div>

        {/* Unit replacement flow */}
        {showReplacementFlow && property.communityPhotoFolder && (
          <div className="mt-6">
            <UnitReplacementFlow
              unit={{
                id: targetUnit.id,
                unitNumber: targetUnit.unitNumber,
                bedrooms: targetUnit.bedrooms,
                photoFolder: (targetUnit as any).photoFolder,
                positionLabel: (() => {
                  const idx = property.units.findIndex(u => u.id === targetUnit.id);
                  return idx >= 0 ? `Unit ${String.fromCharCode(65 + idx)}` : undefined;
                })(),
                replacementLabel: unitOverrides[targetUnit.id]?.unitLabel,
              }}
              allUnits={property.units.map((u, i) => ({
                id: u.id,
                unitNumber: u.unitNumber,
                bedrooms: u.bedrooms,
                photoFolder: u.photoFolder,
                positionLabel: `Unit ${String.fromCharCode(65 + i)}`,
                replacementLabel: unitOverrides[u.id]?.unitLabel,
                replacementSourceUrl: unitOverrides[u.id]?.sourceUrl,
              }))}
              communityFolder={property.communityPhotoFolder}
              communityName={property.complexName}
              propertyAddress={property.address}
              streetAddress={replacementStreetAddress || undefined}
              city={parsedReplacementAddress.city || undefined}
              state={parsedReplacementAddress.state || undefined}
              propertyId={id}
              skipUrls={replacementSkipUrls}
              onClose={() => { setShowReplacementFlow(false); setReplacementTargetId(null); setReplacementSkipUrl(null); }}
              onUnitReplaced={handleUnitReplaced}
            />
          </div>
        )}
      </div>
    </div>
  );
}
