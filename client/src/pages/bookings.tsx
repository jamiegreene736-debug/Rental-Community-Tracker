import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Building2, Calendar, Search, Link2, Unlink, ExternalLink,
  RefreshCw, AlertCircle, CheckCircle2, TrendingUp, TrendingDown, BedDouble,
  ChevronDown, ChevronRight, Globe, ShoppingCart, Zap, Camera,
  ArrowUpDown, ArrowUp, ArrowDown, Star, Copy, FileText, XCircle,
  WalletCards, Landmark, Clock3,
} from "lucide-react";
import type { BuyIn, GuestyPropertyMap } from "@shared/schema";
import type { UnitConfig } from "@shared/property-units";
import { buildBuyInSearchDebugLog, sanitizeForChatText } from "@shared/safe-log";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlotInfo extends UnitConfig {
  buyIn: BuyIn | null;
}

interface GuestyReservation {
  _id: string;
  status: string;
  createdAt?: string;
  checkIn: string;
  checkOut: string;
  // Guesty exposes timezone-localized date-only versions of check-in/out
  // that avoid UTC-vs-local off-by-one bugs for Hawaii/Pacific listings.
  checkInDateLocalized?: string;
  checkOutDateLocalized?: string;
  nightsCount?: number;
  guest?: { fullName?: string; firstName?: string; email?: string };
  money?: {
    hostPayout?: number;
    fareAccommodation?: number;
    netIncome?: number;
    // Payment status — surfaced in Guesty's Payments tab
    totalPaid?: number;
    balanceDue?: number;
    isFullyPaid?: boolean;
    totalRefunded?: number;
    payments?: GuestyPayment[];
    paymentSchedule?: GuestyPayment[];
  };
  payments?: GuestyPayment[];
  source?: string;
  integration?: { platform?: string };
  confirmationCode?: string;
  slots: SlotInfo[];
  slotsFilled: number;
  slotsTotal: number;
  fullyLinked: boolean;
}

interface GuestyPayment {
  amount?: number | string;
  value?: number | string;
  paidAmount?: number | string;
  expectedAmount?: number | string;
  scheduledAmount?: number | string;
  total?: number | string;
  paidAt?: string;
  collectedAt?: string;
  processedAt?: string;
  paymentDate?: string;
  dueAt?: string;
  dueDate?: string;
  scheduledAt?: string;
  chargeDate?: string;
  createdAt?: string;
  date?: string;
  status?: string;
  description?: string;
  note?: string;
  label?: string;
  type?: string;
  kind?: string;
  [key: string]: unknown;
}

type AutoFillSearchSummary = {
  bedrooms: number;
  scanned: number;
  priced: number;
  sourceCounts: { airbnb: number; vrbo: number; booking: number; pm: number };
};

type AutoFillComboOption = {
  label: string;
  bedrooms: number[];
  totalCost: number | null;
  selected: boolean;
  unavailableReason?: string;
  picks: Array<{
    bedrooms: number;
    sourceLabel: string;
    title: string;
    totalPrice: number;
    url: string;
  }>;
};

interface Candidate {
  buyIn: BuyIn;
  buyInNights: number;
  totalCost: number;
  costPerNight: number;
  wastedNights: number;
  effectiveCost: number;
  score: number;
}

type SidecarQueueStatus = {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  oldestPendingAgeSec: number | null;
  newestRequestAt: string | null;
  byOpType?: Record<string, number>;
  activeRequests?: Array<{
    id: string;
    status: string;
    opType: string;
    label: string;
    stage?: string;
    bedrooms?: number;
    destination?: string;
    siteCount?: number;
    ageSec: number;
    activeSec?: number;
  }>;
  pendingRequests?: Array<{
    id: string;
    status: string;
    opType: string;
    label: string;
    stage?: string;
    bedrooms?: number;
    destination?: string;
    siteCount?: number;
    ageSec: number;
    activeSec?: number;
  }>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMoney(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  if (!v && v !== 0) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

async function apiGetJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) {
    const text = sanitizeForChatText((await res.text()) || res.statusText, { maxLength: 4_000 });
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// Accepts both pure date strings ("2026-10-17") and full ISO timestamps
// ("2026-10-18T01:00:00.000Z"). Guesty returns the former as
// `checkInDateLocalized` and the latter as `checkIn`.
function fmtDate(s: string | undefined | null): string {
  if (!s) return "—";
  // Pure YYYY-MM-DD — force mid-day UTC so timezone doesn't bump us to the
  // previous calendar day in western time zones.
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Best-effort source label from a URL. The buy-in's listing URL field
// is named airbnbListingUrl for legacy reasons but actually holds any
// channel's URL (Airbnb / Booking.com / PM company site). Show the user
// where the link actually points so a Suite Paradise URL doesn't say
// "view on Airbnb".
function sourceLabelForUrl(url: string | null | undefined): string {
  if (!url) return "site";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (/airbnb\.com$/.test(host)) return "Airbnb";
    if (/booking\.com$/.test(host)) return "Booking.com";
    if (/vrbo\.com$/.test(host)) return "Vrbo";
    if (/expedia\.com$/.test(host)) return "Expedia";
    if (/tripadvisor\.com$/.test(host)) return "Tripadvisor";
    return host;
  } catch {
    return "site";
  }
}

// Canonicalize listing URLs for de-duping across reservation slots.
// Date/search params differ by scan, but the path identifies the same
// physical listing page for Airbnb/VRBO/Booking/PM sites.
function listingUrlKey(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [
      "checkin",
      "checkout",
      "check_in",
      "check_out",
      "arrival",
      "departure",
      "startDate",
      "endDate",
      "adults",
      "group_adults",
    ]) {
      u.searchParams.delete(key);
    }
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return String(url).split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function normalizedIdentityText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function imageUrlKey(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return String(url).split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function isGenericRentalTitle(title: string): boolean {
  const t = normalizedIdentityText(title);
  if (!t) return true;
  if (/^(?:condo|apartment|townhouse|home|house|villa|rental unit|guest suite|loft|cottage|bungalow|place)\s+in\s+[a-z ]+$/.test(t)) return true;
  if (/^(?:beautiful|lovely|spacious|modern|luxury|elegant)?\s*(?:\d+\s*(?:br|bedroom)\s*)?(?:condo|apartment|townhouse|home|house|villa|rental)$/.test(t)) return true;
  return false;
}

function titleFromBuyInNotes(notes: string | null | undefined): string {
  const raw = String(notes ?? "");
  const firstClause = raw.split(" · ")[0] ?? raw;
  const dash = firstClause.indexOf(" — ");
  if (dash >= 0) return firstClause.slice(dash + 3).trim();
  const bought = firstClause.match(/^Bought via .+? — (.+)$/i);
  return bought?.[1]?.trim() ?? "";
}

function listingIdentityKeys(item: {
  url?: string | null;
  title?: string | null;
  image?: string | null;
  airbnbAnchorUrl?: string | null;
  alternateUrls?: Array<string | null | undefined>;
  photoMatches?: Array<{ url?: string | null }>;
  identityKeys?: Array<string | null | undefined>;
}): string[] {
  const keys = new Set<string>();
  for (const identityKey of item.identityKeys ?? []) {
    if (identityKey) keys.add(identityKey);
  }
  const urlKey = listingUrlKey(item.url);
  if (urlKey) keys.add(`url:${urlKey}`);

  const anchorKey = listingUrlKey(item.airbnbAnchorUrl);
  if (anchorKey) keys.add(`url:${anchorKey}`);

  for (const alternateUrl of item.alternateUrls ?? []) {
    const alternateKey = listingUrlKey(alternateUrl);
    if (alternateKey) keys.add(`url:${alternateKey}`);
  }

  const imgKey = imageUrlKey(item.image);
  if (imgKey) keys.add(`image:${imgKey}`);

  const titleKey = normalizedIdentityText(item.title);
  if (titleKey.length >= 12 && !isGenericRentalTitle(titleKey)) {
    keys.add(`title:${titleKey}`);
  }

  for (const match of item.photoMatches ?? []) {
    const matchKey = listingUrlKey(match.url);
    if (matchKey) keys.add(`url:${matchKey}`);
  }

  return Array.from(keys);
}

function hasUsedListingIdentity(used: Set<string>, item: Parameters<typeof listingIdentityKeys>[0]): boolean {
  return listingIdentityKeys(item).some((key) => used.has(key));
}

function addUsedListingIdentity(used: Set<string>, item: Parameters<typeof listingIdentityKeys>[0]) {
  for (const key of listingIdentityKeys(item)) used.add(key);
}

// Mirror of server/pm-scrapers.ts MANUAL_ONLY list. PMs that don't
// expose rates programmatically — auto-fill / Verify-rate calls return
// instantly with manualOnly:true and the slot row should show the
// contact info inline so the operator knows the next action is a
// phone call. Keep in sync with server/pm-scrapers.ts.
//
// Empty for now — Suite Paradise was here briefly until we found their
// rcapi endpoint and built a programmatic scraper. New PMs land here
// when recon shows they truly have no scrapable rate path.
type ManualOnlyPm = { name: string; phone?: string; emailUrl?: string };
function manualOnlyPmForUrl(_url: string | null | undefined): ManualOnlyPm | null {
  return null;
}

function activeSidecarCount(status: SidecarQueueStatus | null | undefined): number {
  return Math.max(0, (status?.pending ?? 0) + (status?.inProgress ?? 0));
}

function sidecarNewestRequestMs(status: SidecarQueueStatus | null | undefined): number | null {
  if (!status?.newestRequestAt) return null;
  const ms = Date.parse(status.newestRequestAt);
  return Number.isFinite(ms) ? ms : null;
}

function isSidecarStatusForSearch(
  status: SidecarQueueStatus | null | undefined,
  startedAtMs: number | null,
): boolean {
  const active = activeSidecarCount(status);
  if (active <= 0) return false;
  const newestMs = sidecarNewestRequestMs(status);
  if (!startedAtMs || !newestMs) return active > 0;
  return newestMs >= startedAtMs - 15_000;
}

function sidecarQueueProgressValue(status: SidecarQueueStatus | null | undefined): number {
  if (!status) return 12;
  const active = activeSidecarCount(status);
  const total = Math.max(1, status.total, status.pending + status.inProgress + status.completed + status.failed);
  const done = Math.max(0, status.completed + status.failed);
  if (active <= 0) return done > 0 ? 100 : 12;
  return Math.max(8, Math.min(96, Math.round((done / total) * 100)));
}

function sidecarOpSummary(status: SidecarQueueStatus | null | undefined): string {
  const activeStages = (status?.activeRequests ?? [])
    .map((r) => {
      const stage = r.stage || r.label;
      const seconds = typeof r.activeSec === "number" ? ` ${r.activeSec}s` : "";
      return `${stage}${seconds}`;
    })
    .filter(Boolean);
  const pendingStages = (status?.pendingRequests ?? [])
    .map((r) => r.label)
    .filter(Boolean);
  if (activeStages.length > 0) {
    const next = pendingStages.length > 0
      ? ` · next: ${pendingStages.slice(0, 3).join(", ")}${pendingStages.length > 3 ? ` +${pendingStages.length - 3}` : ""}`
      : "";
    return `now: ${activeStages.slice(0, 2).join(" · ")}${next}`;
  }
  const counts = status?.byOpType ?? {};
  const labels: Array<[string, string]> = [
    ["airbnb_search", "Airbnb search"],
    ["vrbo_search", "Vrbo search"],
    ["booking_search", "Booking.com search"],
    ["pm_site_search", "PM websites"],
    ["pm_url_check_batch", "PM batches"],
    ["pm_url_check", "PM checks"],
    ["google_serp", "Google discovery"],
    ["vrbo_photo_scrape", "Vrbo photos"],
  ];
  return labels
    .map(([key, label]) => {
      const count = counts[key] ?? 0;
      return count > 0 ? `${label} ${count}` : "";
    })
    .filter(Boolean)
    .slice(0, 3)
    .join(" · ");
}

function useSidecarQueueStatus(enabled: boolean): { status: SidecarQueueStatus | null; fetched: boolean } {
  const [state, setState] = useState<{ status: SidecarQueueStatus | null; fetched: boolean }>({
    status: null,
    fetched: false,
  });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch("/api/vrbo-sidecar/status", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json() as SidecarQueueStatus;
        if (!cancelled) setState({ status, fetched: true });
      } catch {
        if (!cancelled) setState((previous) => ({ ...previous, fetched: true }));
      }
    };

    tick();
    const id = setInterval(tick, enabled ? 1_500 : 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return state;
}

function SidecarQueueProgress({
  status,
  label = "Chrome sidecar verification",
  forceVisible = false,
  className = "",
}: {
  status: SidecarQueueStatus | null;
  label?: string;
  forceVisible?: boolean;
  className?: string;
}) {
  const { toast } = useToast();
  const [isStopping, setIsStopping] = useState(false);
  const active = activeSidecarCount(status);
  if (!forceVisible && active <= 0) return null;

  const total = status ? Math.max(1, status.total, status.pending + status.inProgress + status.completed + status.failed) : 0;
  const opSummary = sidecarOpSummary(status);
  const message = status
    ? active > 0
      ? `${label}: ${status.inProgress} running, ${status.pending} queued, ${status.completed + status.failed}/${total} finished${opSummary ? ` · ${opSummary}` : ""}.`
      : `${label}: queue idle${status.completed + status.failed > 0 ? ` after ${status.completed + status.failed} finished job${status.completed + status.failed === 1 ? "" : "s"}` : ""}.`
    : `${label}: waiting for queue status.`;

  const stopSidecar = async () => {
    setIsStopping(true);
    try {
      const response = await apiRequest("POST", "/api/vrbo-sidecar/cancel", {
        reason: "cancelled by operator from Operations UI",
      });
      const result = await response.json();
      toast({
        title: "Sidecar stop requested",
        description: result.cancelled > 0
          ? `Cancelled ${result.cancelled} job${result.cancelled === 1 ? "" : "s"}. The active Chrome task should close within a few seconds.`
          : "No active sidecar jobs were running.",
      });
    } catch (e) {
      toast({
        title: "Could not stop sidecar",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className={`border border-blue-200 bg-blue-50/70 text-blue-900 rounded-md px-3 py-2 text-[11px] space-y-1.5 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2">
          {active > 0 && <RefreshCw className="h-3 w-3 animate-spin shrink-0" />}
          <span>{message}</span>
        </span>
        {status?.oldestPendingAgeSec != null && status.pending > 0 && (
          <span className="tabular-nums text-blue-800/80">
            oldest {Math.round(status.oldestPendingAgeSec)}s
          </span>
        )}
        {active > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 border-blue-300 bg-white/80 text-[11px] text-blue-900 hover:bg-blue-100"
            onClick={stopSidecar}
            disabled={isStopping}
          >
            <XCircle className="h-3.5 w-3.5 mr-1" />
            {isStopping ? "Stopping" : "Stop"}
          </Button>
        )}
      </div>
      <Progress value={sidecarQueueProgressValue(status)} className="h-1.5" />
    </div>
  );
}

// Auto-fill progress bar — gives the operator visual confirmation that
// the mutation is still running while the server-side find-buy-in scan
// collects and verifies candidates. Indeterminate in nature: ramps to
// 95% over the expected cold-cache duration, snaps to 100% only when the
// mutation completes (parent unmounts this component when autoFilling
// clears).
function AutoFillProgress({
  slotCount,
  sidecarStatus,
}: {
  slotCount: number;
  sidecarStatus: SidecarQueueStatus | null;
}) {
  const { toast } = useToast();
  const [elapsed, setElapsed] = useState(0);
  const [isStopping, setIsStopping] = useState(false);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, []);
  // find-buy-in is deduped per bedroom group, so a 2-slot booking should
  // not pay two full scans. Cold cache can still be a couple minutes
  // because VRBO + PM sidecar checks share one local worker.
  const expectedSeconds = Math.max(180, 180 + Math.max(0, slotCount - 1) * 15);
  const timedValue = Math.min(95, Math.round((elapsed / expectedSeconds) * 100));
  const active = activeSidecarCount(sidecarStatus);
  const value = active > 0
    ? Math.max(timedValue, sidecarQueueProgressValue(sidecarStatus))
    : timedValue;
  const stageText = sidecarOpSummary(sidecarStatus);
  const queueText = active > 0
    ? ` Chrome sidecar: ${sidecarStatus?.inProgress ?? 0} running, ${sidecarStatus?.pending ?? 0} queued${stageText ? ` - ${stageText}` : ""}.`
    : "";
  const stopSidecar = async () => {
    setIsStopping(true);
    try {
      const response = await apiRequest("POST", "/api/vrbo-sidecar/cancel", {
        reason: "cancelled by operator from Operations UI",
      });
      const result = await response.json();
      toast({
        title: "Sidecar stop requested",
        description: result.cancelled > 0
          ? `Cancelled ${result.cancelled} job${result.cancelled === 1 ? "" : "s"}. The active Chrome task should close within a few seconds.`
          : "No active sidecar jobs were running.",
      });
    } catch (e) {
      toast({
        title: "Could not stop sidecar",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="min-w-0">
          Searching candidates and verifying rates ({slotCount} {slotCount === 1 ? "slot" : "slots"}) — cold-cache scans can take a few minutes
          {queueText}
        </span>
        <span className="inline-flex shrink-0 items-center gap-2">
          <SidecarStatusBadge />
          <span className="tabular-nums">{elapsed}s</span>
          {active > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 border-blue-300 bg-white/80 px-2 text-[11px] text-blue-900 hover:bg-blue-100"
              onClick={stopSidecar}
              disabled={isStopping}
            >
              <XCircle className="h-3.5 w-3.5 mr-1" />
              {isStopping ? "Stopping" : "Stop"}
            </Button>
          )}
        </span>
      </div>
      <Progress value={value} className="h-1.5" />
    </div>
  );
}

function ComboComparisonPanel({ options }: { options: AutoFillComboOption[] }) {
  if (options.length === 0) return null;
  const selected = options.find((option) => option.selected);
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium text-emerald-900">
          Cheapest combination{selected ? `: ${selected.label} · ${fmtMoney(selected.totalCost)}` : ""}
        </p>
        {selected && <Badge className="bg-emerald-600 text-white text-[10px]">Selected</Badge>}
      </div>
      <div className="mt-2 space-y-1">
        {options.map((option) => (
          <div
            key={option.label}
            className={`grid grid-cols-[1fr_auto] gap-3 rounded border px-2 py-1.5 ${
              option.selected ? "border-emerald-300 bg-white/80" : "border-emerald-100 bg-white/50"
            }`}
          >
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {option.label}
                {option.selected && <span className="ml-1 text-emerald-700">selected</span>}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {option.totalCost == null
                  ? option.unavailableReason ?? "Not enough verified options"
                  : option.picks.map((pick) => `${pick.bedrooms}BR ${pick.sourceLabel} ${fmtMoney(pick.totalPrice)}`).join(" + ")}
              </p>
            </div>
            <div className="text-right font-semibold tabular-nums">
              {option.totalCost == null ? "—" : fmtMoney(option.totalCost)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function nightsBetween(a: string | undefined | null, b: string | undefined | null): number {
  if (!a || !b) return 1;
  const da = new Date(a);
  const db = new Date(b);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return 1;
  return Math.max(1, Math.round((+db - +da) / 86400000));
}

function asMoneyNumber(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function nextBusinessDay(date: Date): Date {
  const d = new Date(date);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function parseDateCandidate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

type DepositStatus = "airbnb_expected" | "collected" | "scheduled" | "partial" | "not_collected" | "unknown";
type PaymentSourceKind = "airbnb" | "guesty_card" | "booking_vcc" | "booking_payout" | "not_visible" | "unknown";
type DepositTriggerSource = "airbnb_arrival" | "payment" | "schedule" | "reservation" | "unknown";

function channelKindOf(r: GuestyReservation): "airbnb" | "booking" | "vrbo" | "manual" | "other" {
  const raw = `${r.integration?.platform ?? ""} ${r.source ?? ""}`.toLowerCase();
  if (raw.includes("airbnb")) return "airbnb";
  if (raw.includes("booking")) return "booking";
  if (raw.includes("vrbo") || raw.includes("homeaway")) return "vrbo";
  if (raw.includes("manual") || raw.includes("direct")) return "manual";
  return "other";
}

function collectedPaymentDateOf(r: GuestyReservation): { date: Date | null; source: "payment" | "reservation" | "unknown" } {
  const payments = [
    ...(Array.isArray(r.payments) ? r.payments : []),
    ...(Array.isArray(r.money?.payments) ? r.money.payments : []),
    ...(Array.isArray(r.money?.paymentSchedule) ? r.money.paymentSchedule : []),
  ];
  const paidDates = payments
    .filter((p) => {
      const status = String(p.status ?? "").toLowerCase();
      if (!status) return true;
      return !/(scheduled|pending|unpaid|due|failed|cancel)/.test(status);
    })
    .map((p) => parseDateCandidate(p.paidAt ?? p.collectedAt ?? p.processedAt ?? p.date ?? p.createdAt))
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime());
  if (paidDates.length > 0) return { date: paidDates[0], source: "payment" };

  const created = parseDateCandidate(r.createdAt);
  if ((r.money?.totalPaid ?? 0) > 0 && created) return { date: created, source: "reservation" };
  return { date: null, source: "unknown" };
}

function reservationPaymentItems(r: GuestyReservation): GuestyPayment[] {
  return [
    ...(Array.isArray(r.payments) ? r.payments : []),
    ...(Array.isArray(r.money?.payments) ? r.money.payments : []),
    ...(Array.isArray(r.money?.paymentSchedule) ? r.money.paymentSchedule : []),
  ];
}

function paymentAmountOf(p: GuestyPayment): number {
  return asMoneyNumber(
    p.amount ?? p.value ?? p.paidAmount ?? p.expectedAmount ?? p.scheduledAmount ?? p.total,
  );
}

function paymentDateOf(p: GuestyPayment): Date | null {
  return parseDateCandidate(p.paidAt ?? p.collectedAt ?? p.processedAt ?? p.paymentDate ?? p.date ?? p.createdAt);
}

function scheduledDateOf(p: GuestyPayment): Date | null {
  return parseDateCandidate(p.dueAt ?? p.dueDate ?? p.scheduledAt ?? p.chargeDate ?? p.paymentDate ?? p.date ?? p.createdAt);
}

function paymentDescriptionOf(p: GuestyPayment): string {
  return String(p.description ?? p.note ?? p.label ?? p.type ?? p.kind ?? "");
}

function paymentLooksCollected(p: GuestyPayment): boolean {
  const status = String(p.status ?? "").toLowerCase();
  const description = paymentDescriptionOf(p).toLowerCase();
  if (/(refund|void|fail|declin|cancel)/.test(status) || /(refund|void|fail|declin|cancel)/.test(description)) return false;
  if (/(scheduled|pending|unpaid|due|future)/.test(status)) return false;
  if (p.paidAt || p.collectedAt || p.processedAt) return true;
  return /(paid|captured|collected|succeeded|settled|payment|charge)/.test(status + " " + description);
}

function paymentLooksScheduled(p: GuestyPayment): boolean {
  const status = String(p.status ?? "").toLowerCase();
  const description = paymentDescriptionOf(p).toLowerCase();
  if (paymentLooksCollected(p)) return false;
  return /(scheduled|pending|unpaid|due|future|installment|payment)/.test(status + " " + description);
}

function getBuyInCost(r: GuestyReservation): number {
  return r.slots.reduce((s, sl) => s + parseFloat(String(sl.buyIn?.costPaid ?? 0)), 0);
}

function getDepositAmount(r: GuestyReservation): number {
  return asMoneyNumber(r.money?.hostPayout) || asMoneyNumber(r.money?.netIncome) || asMoneyNumber(r.money?.totalPaid);
}

function depositStatusOf(r: GuestyReservation): DepositStatus {
  if (channelKindOf(r) === "airbnb") return "airbnb_expected";
  const totalPaid = asMoneyNumber(r.money?.totalPaid);
  const balanceDue = asMoneyNumber(r.money?.balanceDue);
  const fullyPaid = r.money?.isFullyPaid === true || (balanceDue <= 0 && totalPaid > 0);
  if (fullyPaid) return "collected";
  if (totalPaid > 0) return "partial";
  if (balanceDue > 0) return "not_collected";
  return "unknown";
}

function paymentSourceOf(r: GuestyReservation): { kind: PaymentSourceKind; label: string; detail: string } {
  const channel = channelKindOf(r);
  if (channel === "airbnb") {
    return { kind: "airbnb", label: "Airbnb payout", detail: "arrival-based estimate" };
  }

  const totalPaid = asMoneyNumber(r.money?.totalPaid);
  const balanceDue = asMoneyNumber(r.money?.balanceDue);
  const payload = JSON.stringify({
    payments: r.payments,
    moneyPayments: r.money?.payments,
    paymentSchedule: r.money?.paymentSchedule,
    money: r.money,
  }).toLowerCase();

  if (channel === "booking") {
    if (/virtual\s*credit|vcc|virtual[_\s-]*card|booking virtual/.test(payload)) {
      return { kind: "booking_vcc", label: "Booking.com VCC", detail: "virtual card evidence in Guesty" };
    }
    if (/payments?\s+by\s+booking|payment_via_booking|booking\.com\s+payout|payout[_\s-]*type|bank\s+transfer|stripe\s+payout/.test(payload)) {
      return { kind: "booking_payout", label: "Booking.com payout", detail: "Booking.com payout evidence in Guesty" };
    }
    if (/credit\s*card|card[_\s-]*not[_\s-]*present|visa|mastercard|amex|stripe|guesty\s*pay|guesty_pay/.test(payload)) {
      return { kind: "guesty_card", label: "Card payment", detail: "card/processor evidence in Guesty" };
    }
    if (totalPaid <= 0 && balanceDue > 0) {
      return { kind: "not_visible", label: "Payment type unknown", detail: "no collected payment visible in Guesty" };
    }
    return { kind: "unknown", label: "Payment type unknown", detail: "Guesty money fields do not identify source" };
  }

  if (/credit\s*card|visa|mastercard|amex|stripe|guesty\s*pay|guesty_pay/.test(payload)) {
    return { kind: "guesty_card", label: "Card payment", detail: "card/processor evidence in Guesty" };
  }
  if (totalPaid <= 0 && balanceDue > 0) {
    return { kind: "not_visible", label: "Payment not visible", detail: "no collected payment visible in Guesty" };
  }
  return { kind: "unknown", label: "Payment source unknown", detail: "Guesty money fields do not identify source" };
}

function depositTimingFor(r: GuestyReservation): {
  triggerDate: Date | null;
  triggerSource: DepositTriggerSource;
  expectedPayout: Date | null;
  expectedBank: Date | null;
} {
  if (channelKindOf(r) === "airbnb") {
    const checkIn = parseDateCandidate(checkInOf(r));
    const expectedPayout = checkIn ? addDays(checkIn, 1) : null;
    return {
      triggerDate: checkIn,
      triggerSource: checkIn ? "airbnb_arrival" : "unknown",
      expectedPayout,
      expectedBank: expectedPayout ? nextBusinessDay(expectedPayout) : null,
    };
  }

  const status = depositStatusOf(r);
  if (status !== "collected" && status !== "partial") {
    return { triggerDate: null, triggerSource: "unknown", expectedPayout: null, expectedBank: null };
  }

  const payment = collectedPaymentDateOf(r);
  const expectedPayout = payment.date ? addDays(payment.date, 7) : null;
  return {
    triggerDate: payment.date,
    triggerSource: payment.source,
    expectedPayout,
    expectedBank: expectedPayout ? nextBusinessDay(expectedPayout) : null,
  };
}

function depositInstallmentsFor(r: GuestyReservation): Array<{
  installmentLabel: string;
  status: DepositStatus;
  amount: number;
  triggerDate: Date | null;
  triggerSource: DepositTriggerSource;
  expectedPayout: Date | null;
  expectedBank: Date | null;
}> {
  if (channelKindOf(r) === "airbnb") {
    const timing = depositTimingFor(r);
    return [{
      installmentLabel: "Airbnb payout",
      status: "airbnb_expected",
      amount: getDepositAmount(r),
      triggerDate: timing.triggerDate,
      triggerSource: timing.triggerSource,
      expectedPayout: timing.expectedPayout,
      expectedBank: timing.expectedBank,
    }];
  }

  const items = reservationPaymentItems(r);
  const installments: Array<{
    installmentLabel: string;
    status: DepositStatus;
    amount: number;
    triggerDate: Date | null;
    triggerSource: DepositTriggerSource;
    expectedPayout: Date | null;
    expectedBank: Date | null;
  }> = [];
  const seen = new Set<string>();

  const addInstallment = (
    status: DepositStatus,
    amount: number,
    triggerDate: Date | null,
    triggerSource: DepositTriggerSource,
    label: string,
  ) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const key = `${status}|${triggerDate?.toISOString().slice(0, 10) ?? ""}|${amount.toFixed(2)}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    const expectedPayout = triggerDate ? addDays(triggerDate, 7) : null;
    installments.push({
      installmentLabel: label,
      status,
      amount,
      triggerDate,
      triggerSource,
      expectedPayout,
      expectedBank: expectedPayout ? nextBusinessDay(expectedPayout) : null,
    });
  };

  for (const item of items) {
    const amount = paymentAmountOf(item);
    if (paymentLooksCollected(item)) {
      addInstallment("collected", amount, paymentDateOf(item), "payment", paymentDescriptionOf(item) || "Collected payment");
    } else if (paymentLooksScheduled(item)) {
      addInstallment("scheduled", amount, scheduledDateOf(item), "schedule", paymentDescriptionOf(item) || "Scheduled payment");
    }
  }

  if (installments.length > 0) {
    return installments.sort((a, b) => {
      const ad = a.triggerDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bd = b.triggerDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ad - bd;
    }).map((row, index) => ({
      ...row,
      installmentLabel: /^collected payment$|^scheduled payment$/i.test(row.installmentLabel)
        ? `Payment ${index + 1}`
        : row.installmentLabel,
    }));
  }

  const status = depositStatusOf(r);
  const timing = depositTimingFor(r);
  const amount = status === "collected" || status === "partial" ? getDepositAmount(r) : 0;
  return [{
    installmentLabel: "Reservation balance",
    status,
    amount,
    triggerDate: timing.triggerDate,
    triggerSource: timing.triggerSource,
    expectedPayout: timing.expectedPayout,
    expectedBank: timing.expectedBank,
  }];
}

// Prefer Guesty's timezone-normalized date field when present, fall back to
// the UTC timestamp. Avoids off-by-one-day drift for Hawaii listings.
function checkInOf(r: { checkIn?: string; checkInDateLocalized?: string }): string | undefined {
  return r.checkInDateLocalized ?? r.checkIn;
}
function checkOutOf(r: { checkOut?: string; checkOutDateLocalized?: string }): string | undefined {
  return r.checkOutDateLocalized ?? r.checkOut;
}

// Column header that toggles sort when clicked. Shows an up/down caret when
// the column is the active sort target.
function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <button
      onClick={onClick}
      className={`cursor-pointer hover:text-foreground transition-colors text-[10px] uppercase tracking-wider ${
        active ? "text-foreground font-semibold" : ""
      } ${align === "right" ? "text-right" : "text-left"}`}
      data-testid={`sort-header-${label.toLowerCase()}`}
    >
      {label}
      {active && <span className="ml-0.5">{dir === "asc" ? "↑" : "↓"}</span>}
    </button>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Bookings() {
  const { toast } = useToast();
  const [selectedPropertyId, setSelectedPropertyId] = useState<number | null>(null);
  const [includePast, setIncludePast] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [picker, setPicker] = useState<
    | { reservation: GuestyReservation; slot: SlotInfo }
    | null
  >(null);
  const [verifyTarget, setVerifyTarget] = useState<
    | { buyIn: BuyIn; reservation: GuestyReservation }
    | null
  >(null);
  const [listingSitesTarget, setListingSitesTarget] = useState<
    | { buyIn: BuyIn; reservation: GuestyReservation; slot: SlotInfo }
    | null
  >(null);
  // Slots whose inline live-search panel is expanded. Operators can open
  // these manually for an audit search after Auto-fill finishes. Auto-fill
  // itself keeps them closed so it does not launch a second, unrelated
  // live search after the buy-ins are already attached.
  const [expandedSlots, setExpandedSlots] = useState<Set<string>>(new Set());
  const slotKey = (reservationId: string, unitId: string) => `${reservationId}__${unitId}`;
  const toggleSlotSearch = (reservationId: string, unitId: string) => {
    setExpandedSlots((prev) => {
      const next = new Set(prev);
      const k = slotKey(reservationId, unitId);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const closeSlotSearchesForReservation = (reservation: GuestyReservation) => {
    if (selectedPropertyId) {
      void queryClient.cancelQueries({ queryKey: ["/api/operations/find-buy-in", selectedPropertyId] });
    }
    setExpandedSlots((prev) => {
      const next = new Set(prev);
      for (const slot of reservation.slots) {
        next.delete(slotKey(reservation._id, slot.unitId));
      }
      return next;
    });
  };
  const [lastAutoFillCombos, setLastAutoFillCombos] = useState<Record<string, AutoFillComboOption[]>>({});

  // Sort controls: click a column header to sort by that field; click again
  // to toggle asc/desc. Default = check-in ascending (soonest first).
  type SortKey = "checkIn" | "guest" | "payout" | "buyIn" | "profit" | "status";
  const [sortBy, setSortBy] = useState<SortKey>("checkIn");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir(key === "checkIn" ? "asc" : "desc");
    }
  };

  const { data: propertyMap = [] } = useQuery<GuestyPropertyMap[]>({
    queryKey: ["/api/guesty-property-map"],
  });

  // Pull Guesty's listing names so we can show human-readable property names
  // (e.g. "Poipu Kai - 6BR Villas, Pool - Sleeps 16") instead of internal IDs.
  const { data: guestyListings } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/listings?limit=100&fields=_id%20nickname%20title"],
    staleTime: 5 * 60_000,
  });
  const listingNameById = useMemo(() => {
    const map = new Map<string, string>();
    const unwrap = (d: any): any[] => {
      if (Array.isArray(d)) return d;
      if (Array.isArray(d?.results)) return d.results;
      if (Array.isArray(d?.data)) return d.data;
      if (Array.isArray(d?.data?.results)) return d.data.results;
      return [];
    };
    for (const l of unwrap(guestyListings)) {
      const id = l?._id;
      const name = l?.nickname ?? l?.title;
      if (id && name) map.set(id, name);
    }
    return map;
  }, [guestyListings]);

  const selectedMapping = propertyMap.find((m) => m.propertyId === selectedPropertyId);
  const selectedListingId = selectedMapping?.guestyListingId ?? null;

  const {
    data: bookingsData,
    isLoading: bookingsLoading,
    isError: bookingsError,
    error: bookingsErr,
    refetch: refetchBookings,
  } = useQuery<{ reservations: GuestyReservation[]; total: number; unitSlots: UnitConfig[] }>({
    queryKey: ["/api/bookings/listing", selectedListingId, selectedPropertyId, { includePast }],
    queryFn: () => {
      if (!selectedListingId || !selectedPropertyId) {
        return Promise.resolve({ reservations: [], total: 0, unitSlots: [] });
      }
      const url = `/api/bookings/listing/${encodeURIComponent(selectedListingId)}?propertyId=${selectedPropertyId}&includePast=${includePast}`;
      return apiRequest("GET", url).then((r) => r.json());
    },
    enabled: !!selectedListingId && !!selectedPropertyId,
    refetchInterval: 120_000,
  });

  const rawReservations = bookingsData?.reservations ?? [];
  const unitSlots = bookingsData?.unitSlots ?? [];

  // Apply the current sort to the reservations before we render. Memoized so
  // a click on an attach button doesn't re-sort the entire list.
  const reservations = useMemo(() => {
    const list = [...rawReservations];
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const diff = (() => {
        switch (sortBy) {
          case "checkIn": {
            const ad = new Date(checkInOf(a) ?? 0).getTime() || 0;
            const bd = new Date(checkInOf(b) ?? 0).getTime() || 0;
            return ad - bd;
          }
          case "guest": {
            const an = (a.guest?.fullName ?? a.guest?.firstName ?? "").toLowerCase();
            const bn = (b.guest?.fullName ?? b.guest?.firstName ?? "").toLowerCase();
            return an.localeCompare(bn);
          }
          case "payout": {
            return (a.money?.hostPayout ?? 0) - (b.money?.hostPayout ?? 0);
          }
          case "buyIn": {
            const ac = a.slots.reduce((s, sl) => s + parseFloat(String(sl.buyIn?.costPaid ?? 0)), 0);
            const bc = b.slots.reduce((s, sl) => s + parseFloat(String(sl.buyIn?.costPaid ?? 0)), 0);
            return ac - bc;
          }
          case "profit": {
            // Unlinked bookings sort to the bottom regardless of direction
            if (!a.fullyLinked && !b.fullyLinked) return 0;
            if (!a.fullyLinked) return 1;
            if (!b.fullyLinked) return -1;
            const ap = (a.money?.hostPayout ?? 0) - a.slots.reduce((s, sl) => s + parseFloat(String(sl.buyIn?.costPaid ?? 0)), 0);
            const bp = (b.money?.hostPayout ?? 0) - b.slots.reduce((s, sl) => s + parseFloat(String(sl.buyIn?.costPaid ?? 0)), 0);
            return ap - bp;
          }
          case "status": {
            // Ordering by fill progress then by status
            const as = a.fullyLinked ? 2 : a.slotsFilled > 0 ? 1 : 0;
            const bs = b.fullyLinked ? 2 : b.slotsFilled > 0 ? 1 : 0;
            return as - bs;
          }
          default:
            return 0;
        }
      })();
      return diff * dir;
    });
    return list;
  }, [rawReservations, sortBy, sortDir]);

  const attachMutation = useMutation({
    mutationFn: ({ reservationId, buyInId }: { reservationId: string; buyInId: number }) =>
      apiRequest("POST", `/api/bookings/${reservationId}/attach-buy-in`, { buyInId }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      setPicker(null);
      toast({ title: "Buy-in attached" });
    },
    onError: (e: any) => toast({ title: "Attach failed", description: e.message, variant: "destructive" }),
  });

  const detachMutation = useMutation({
    mutationFn: (buyInId: number) =>
      apiRequest("POST", `/api/bookings/detach-buy-in/${buyInId}`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      toast({ title: "Buy-in detached" });
    },
    onError: (e: any) => toast({ title: "Detach failed", description: e.message, variant: "destructive" }),
  });

  // Auto-fill: for every empty slot on a reservation, search live sources,
  // pick the cheapest priced candidate, create the buy-in, and attach it.
  // Collapses the 6-click flow (expand → Find → scroll → Record → Save → ...)
  // into a single button per booking.
  const [autoFilling, setAutoFilling] = useState<string | null>(null);
  const [autoFillStartedAtMs, setAutoFillStartedAtMs] = useState<number | null>(null);
  const autoFillRunRef = useRef<string | null>(null);
  const autoFillMutation = useMutation({
    mutationFn: async ({ reservation }: { reservation: GuestyReservation }) => {
      if (!selectedPropertyId) throw new Error("No property selected");
      const emptySlots = reservation.slots.filter((s) => !s.buyIn);
      if (emptySlots.length === 0) throw new Error("All slots already filled");

      const toDateOnly = (s: string | undefined): string => {
        if (!s) return "";
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.slice(0, 10);
      };
      const ci = toDateOnly(reservation.checkInDateLocalized ?? reservation.checkIn);
      const co = toDateOnly(reservation.checkOutDateLocalized ?? reservation.checkOut);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ci) || !/^\d{4}-\d{2}-\d{2}$/.test(co)) {
        throw new Error("Auto-fill needs valid check-in/check-out dates before it can search.");
      }

      // Deduplicate find-buy-in calls. When a reservation has multiple
      // empty slots with the SAME bedrooms (Amy Vanbuskirk's 2x 3BR
      // case), each slot was previously firing its own find-buy-in
      // call in parallel. Two simultaneous SearchAPI/Google scrape
      // calls with identical params occasionally return different
      // result sets (Google rate-limits, transient timeouts in upstream
      // services) — the slot whose call returned a thinner response
      // got `picked: null` because its unpricedFallback was empty.
      // Symptom: 1-of-2 slots filled even though both should have
      // gotten the same Suite Paradise URL.
      // Fix: one call per (bedrooms) group, shared across all slots
      // with that bedroom count. Bonus: half the API spend for
      // multi-unit reservations.
      const findBuyInCache = new Map<string, Promise<FindBuyInResponse>>();
      const getFindBuyInForBedrooms = (
        bedrooms: number,
        opts: { includePm?: boolean } = {},
      ): Promise<FindBuyInResponse> => {
        const includePm = opts.includePm !== false;
        const key = `${bedrooms}|${includePm ? "pm" : "ota"}`;
        const existing = findBuyInCache.get(key);
        if (existing) return existing;
        const params = new URLSearchParams({
          propertyId: String(selectedPropertyId),
          bedrooms: String(bedrooms),
          checkIn: ci,
          checkOut: co,
        });
        if (!includePm) params.set("includePm", "0");
        const url = `/api/operations/find-buy-in?${params.toString()}`;
        const promise = apiRequest("GET", url).then((r) => r.json()) as Promise<FindBuyInResponse>;
        findBuyInCache.set(key, promise);
        return promise;
      };

      // Sequential picking with shared pickedUrls. Multi-unit reservations
      // need DIFFERENT physical units attached to each slot — same URL on
      // both Unit 721 and Unit 812 means we'd be paying for one listing
      // twice and have nothing for the second guest's actual unit.
      const pickedIdentities = new Set<string>();
      for (const slot of reservation.slots) {
        if (!slot.buyIn) continue;
        addUsedListingIdentity(pickedIdentities, {
          url: slot.buyIn.airbnbListingUrl,
          title: titleFromBuyInNotes(slot.buyIn.notes),
        });
      }

      type AutoFillResult = {
        slot: typeof emptySlots[number];
        picked: (LiveCandidate & { totalPrice: number }) | null;
        created: any;
        skippedReasons: string[];
        airbnbPick: boolean;
        searchSummary: AutoFillSearchSummary;
      };

      const searchSummaryFor = (data: FindBuyInResponse, searchedBedrooms: number): AutoFillSearchSummary => {
        const sourceCounts = {
          airbnb: data.sources?.airbnb?.length ?? 0,
          vrbo: data.sources?.vrbo?.length ?? 0,
          booking: data.sources?.booking?.length ?? 0,
          pm: data.sources?.pm?.length ?? 0,
        };
        const allSourceCandidates = [
          ...(data.sources?.airbnb ?? []),
          ...(data.sources?.vrbo ?? []),
          ...(data.sources?.booking ?? []),
          ...(data.sources?.pm ?? []),
        ];
        return {
          bedrooms: searchedBedrooms,
          scanned: allSourceCandidates.length,
          priced: allSourceCandidates.filter((c) => c.totalPrice > 0).length,
          sourceCounts,
        };
      };

      const bedroomFromCandidateText = (c: LiveCandidate): number | null => {
        const text = `${c.title} ${c.snippet ?? ""} ${c.url}`.toLowerCase();
        const direct = text.match(/(\d+)\s*(?:br|bd|bdr|bedrooms?)\b/);
        if (direct) return parseInt(direct[1], 10);
        const slash = text.match(/\b([1-9])\s*\/\s*(?:[1-9](?:\.5)?)\b/);
        if (slash) return parseInt(slash[1], 10);
        const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
        for (const [word, count] of Object.entries(words)) {
          if (new RegExp(`\\b${word}[\\s-]bedroom\\b`).test(text)) return count;
        }
        return null;
      };
      const candidateBedrooms = (c: LiveCandidate, fallbackBedrooms: number): number => {
        const explicit = bedroomFromCandidateText(c);
        if (explicit !== null) return explicit;
        return typeof c.bedrooms === "number" && Number.isFinite(c.bedrooms)
          ? c.bedrooms
          : fallbackBedrooms;
      };
      const rankCandidates = (items: LiveCandidate[]): LiveCandidate[] =>
        [...items].sort((a, b) => {
          const aRank = a.verified === "yes" ? 0 : 1;
          const bRank = b.verified === "yes" ? 0 : 1;
          if (aRank !== bRank) return aRank - bRank;
          return (a.totalPrice || 999999) - (b.totalPrice || 999999);
        });
      const getCandidatePool = async (
        searchedBedrooms: number,
        exactBedroomForCombo: boolean,
        includePm = true,
      ): Promise<{ data: FindBuyInResponse; searchSummary: AutoFillSearchSummary; candidates: LiveCandidate[] }> => {
        const data = await getFindBuyInForBedrooms(searchedBedrooms, { includePm });
        const safeForAutoFill = data.autoFillSafe ?? data.diagnostics?.severity === "ok";
        if (!safeForAutoFill) {
          const detail = data.diagnostics?.summary || "The live scan returned partial results or warnings.";
          throw new Error(`Auto-fill stopped before attaching buy-ins: ${detail} Open the slot's live search to review the audit results manually.`);
        }
        const searchSummary = searchSummaryFor(data, searchedBedrooms);
        const unitCandidates: LiveCandidate[] = (data.cheapestUnits ?? [])
          .map((unit): LiveCandidate | null => {
            const listing = [...(unit.listings ?? [])]
              .filter((l) => l.totalPrice > 0)
              .sort((a, b) => {
                const aRank = a.verified === "yes" ? 0 : 1;
                const bRank = b.verified === "yes" ? 0 : 1;
                if (aRank !== bRank) return aRank - bRank;
                return (a.totalPrice || 999999) - (b.totalPrice || 999999);
              })[0];
            if (!listing) return null;
            const alternateUrls = (unit.listings ?? []).map((l) => l.url).filter(Boolean);
            const identityKeys = listingIdentityKeys({
              url: listing.url,
              title: unit.unitTitle,
              image: unit.image,
              alternateUrls,
            });
            return {
              source: listing.channel,
              sourceLabel: listing.channelLabel,
              title: unit.unitTitle,
              url: listing.url,
              nightlyPrice: listing.nightlyPrice,
              totalPrice: listing.totalPrice,
              bedrooms: listing.bedrooms ?? unit.bedrooms,
              image: unit.image,
              alternateUrls,
              identityKeys,
              verified: listing.verified,
              verifiedReason: listing.verifiedReason,
            };
          })
          .filter((c): c is LiveCandidate => c !== null);
        const sourceCandidates = unitCandidates.length > 0 ? unitCandidates : (data.cheapest ?? []);
        const candidates = rankCandidates(
          sourceCandidates
            .filter((c) => c.totalPrice > 0)
            .filter((c) => {
              const actualBedrooms = candidateBedrooms(c, searchedBedrooms);
              return exactBedroomForCombo
                ? actualBedrooms === searchedBedrooms
                : actualBedrooms >= searchedBedrooms;
            }),
        );
        return { data, searchSummary, candidates };
      };

      const createAndAttachPick = async (
        slot: typeof emptySlots[number],
        pick: LiveCandidate,
        searchedBedrooms: number,
        searchSummary: AutoFillSearchSummary,
        comboLabel?: string,
      ): Promise<AutoFillResult> => {
        const skippedReasons: string[] = [];
        const finalCost = pick.totalPrice;
        if (!Number.isFinite(finalCost) || finalCost <= 0) {
          skippedReasons.push(`${slot.unitLabel}: skipped invalid price`);
          return { slot, picked: null, created: null, skippedReasons, airbnbPick: false, searchSummary };
        }
        const actualBedrooms = candidateBedrooms(pick, searchedBedrooms);
        const airbnbPick = pick.source === "airbnb";
        const propertyName =
          (selectedListingId && listingNameById.get(selectedListingId)) ||
          `Property ${selectedPropertyId}`;
        if (hasUsedListingIdentity(pickedIdentities, pick)) {
          skippedReasons.push(`${slot.unitLabel}: skipped duplicate physical listing`);
          return { slot, picked: null, created: null, skippedReasons, airbnbPick: false, searchSummary };
        }
        addUsedListingIdentity(pickedIdentities, pick);
        const verifySuffix = pick.verified === "yes"
          ? ` · Verified by find-buy-in for ${actualBedrooms}BR ${ci}→${co}`
          : "";
        const comboSuffix = comboLabel
          ? ` · ${comboLabel}; selected ${actualBedrooms}BR for this slot`
          : actualBedrooms > slot.bedrooms
            ? ` · Selected ${actualBedrooms}BR for ${slot.bedrooms}BR slot because larger units can satisfy the bedroom requirement`
            : "";
        const tosSuffix = airbnbPick
          ? ` · ⚠️ Airbnb pick — Airbnb TOS prohibits sublet. Operator should handle channel-specific compliance before booking.`
          : "";
        const anchorSuffix = pick.airbnbAnchorUrl && pick.airbnbAnchorPrice
          ? ` · 📷 Photo-matched to Airbnb listing $${pick.airbnbAnchorPrice.toLocaleString()} (${pick.airbnbAnchorUrl}). Same physical unit, bookable on PM site. PM rate may differ slightly — verify on PM page before confirming with guest.`
          : "";
        const sameUnitEvidenceUrls = Array.from(new Set([
          ...(pick.alternateUrls ?? []),
          pick.airbnbAnchorUrl,
          ...(pick.photoMatches ?? []).map((m) => m.url),
          pick.image,
        ].filter((u): u is string => !!u && listingUrlKey(u) !== listingUrlKey(pick.url)))).slice(0, 8);
        const identitySuffix = sameUnitEvidenceUrls.length > 0
          ? ` · Same-unit evidence: ${sameUnitEvidenceUrls.join(" ")}`
          : "";
        try {
          const created = await apiRequest("POST", "/api/buy-ins", {
            propertyId: selectedPropertyId,
            propertyName,
            unitId: slot.unitId,
            unitLabel: slot.unitLabel,
            checkIn: ci,
            checkOut: co,
            costPaid: finalCost.toFixed(2),
            airbnbConfirmation: null,
            airbnbListingUrl: pick.url,
            notes: `Auto-filled from ${pick.sourceLabel} — ${pick.title}${verifySuffix}${comboSuffix}${tosSuffix}${anchorSuffix}${identitySuffix}`,
            status: "active",
          }).then((r) => r.json());
          if (!created?.id) throw new Error(`Create failed for ${slot.unitLabel}`);

          await apiRequest("POST", `/api/bookings/${reservation._id}/attach-buy-in`, {
            buyInId: created.id,
          }).then((r) => r.json());

          return { slot, picked: { ...pick, totalPrice: finalCost }, created, skippedReasons, airbnbPick, searchSummary };
        } catch (e: any) {
          skippedReasons.push(`${slot.unitLabel}: attach-error ${e?.message ?? ""}`.trim());
          return { slot, picked: null, created: null, skippedReasons, airbnbPick: false, searchSummary };
        }
      };

      type TwoUnitBedroomCombo = { bedrooms: number[] };
      const twoUnitBedroomCombos = (): TwoUnitBedroomCombo[] => {
        if (emptySlots.length !== 2) return [];
        const totalNeeded = emptySlots.reduce((sum, s) => sum + s.bedrooms, 0);
        if (totalNeeded <= 0) return [];
        const combos: TwoUnitBedroomCombo[] = [];
        const seen = new Set<string>();
        const addCombo = (combo: number[]) => {
          if (combo.length !== 2 || combo.some((n) => !Number.isFinite(n) || n <= 0)) return;
          if (combo[0] + combo[1] !== totalNeeded) return;
          const key = [...combo].sort((a, b) => b - a).join("+");
          if (seen.has(key)) return;
          seen.add(key);
          combos.push({ bedrooms: combo });
        };
        addCombo(emptySlots.map((s) => s.bedrooms));
        const minLegBedrooms = totalNeeded >= 4 ? 2 : 1;
        for (let high = totalNeeded - minLegBedrooms; high >= Math.ceil(totalNeeded / 2); high--) {
          const low = totalNeeded - high;
          if (low < minLegBedrooms) continue;
          addCombo([high, low]);
        }
        return combos;
      };

      type EvaluatedCombo = {
        combo: TwoUnitBedroomCombo;
        picks: LiveCandidate[];
        summaries: AutoFillSearchSummary[];
        totalCost: number | null;
        unavailableReason?: string;
      };
      const comboOptionFrom = (evaluated: EvaluatedCombo, selected = false): AutoFillComboOption => ({
        label: evaluated.combo.bedrooms.map((b) => `${b}BR`).join(" + "),
        bedrooms: evaluated.combo.bedrooms,
        totalCost: evaluated.totalCost,
        selected,
        unavailableReason: evaluated.unavailableReason,
        picks: evaluated.picks.map((pick, index) => ({
          bedrooms: evaluated.combo.bedrooms[index],
          sourceLabel: pick.sourceLabel,
          title: pick.title,
          totalPrice: pick.totalPrice,
          url: pick.url,
        })),
      });
      const evaluateTwoUnitCombos = async (): Promise<{
        best: EvaluatedCombo | null;
        options: AutoFillComboOption[];
      }> => {
        const combos = twoUnitBedroomCombos();
        if (combos.length === 0) return { best: null, options: [] };
        const poolCache = new Map<string, Promise<{ data: FindBuyInResponse; searchSummary: AutoFillSearchSummary; candidates: LiveCandidate[] }>>();
        const poolFor = (bedroomCount: number) => {
          const key = `${bedroomCount}|pm`;
          const existing = poolCache.get(key);
          if (existing) return existing;
          const promise = getCandidatePool(bedroomCount, true, true);
          poolCache.set(key, promise);
          return promise;
        };

        const evaluatedCombos: EvaluatedCombo[] = [];
        let best: EvaluatedCombo | null = null;
        for (const combo of combos) {
          const used = new Set(pickedIdentities);
          const picks: LiveCandidate[] = [];
          const summaries: AutoFillSearchSummary[] = [];
          let unavailableReason = "";
          for (const bedroomCount of combo.bedrooms) {
            const pool = await poolFor(bedroomCount);
            summaries.push(pool.searchSummary);
            const pick = pool.candidates.find((c) => !hasUsedListingIdentity(used, c));
            if (!pick) {
              unavailableReason = `No unused verified ${bedroomCount}BR option`;
              break;
            }
            addUsedListingIdentity(used, pick);
            picks.push(pick);
          }
          const totalCost = picks.length === combo.bedrooms.length
            ? picks.reduce((sum, p) => sum + p.totalPrice, 0)
            : null;
          const evaluated: EvaluatedCombo = {
            combo,
            picks,
            summaries,
            totalCost,
            unavailableReason: totalCost === null ? unavailableReason || "Not enough distinct verified options" : undefined,
          };
          evaluatedCombos.push(evaluated);
          if (totalCost !== null && (!best || totalCost < (best.totalCost ?? Infinity))) {
            best = evaluated;
          }
        }
        return {
          best,
          options: evaluatedCombos.map((option) => comboOptionFrom(option, option === best)),
        };
      };

      const results: AutoFillResult[] = [];
      const comboEvaluation = await evaluateTwoUnitCombos();
      const comboChoice = comboEvaluation.best;
      if (comboChoice) {
        const totalBedrooms = comboChoice.combo.bedrooms.reduce((sum, n) => sum + n, 0);
        const comboLabel = `Two-unit ${comboChoice.combo.bedrooms.join("+")}BR combo for ${totalBedrooms}BR booking`;
        for (let i = 0; i < emptySlots.length; i++) {
          const result = await createAndAttachPick(
            emptySlots[i],
            comboChoice.picks[i],
            comboChoice.combo.bedrooms[i],
            comboChoice.summaries[i],
            comboLabel,
          );
          results.push(result);
        }
        return { reservation, results, comboOptions: comboEvaluation.options };
      }

      const plannedPicks: Array<{
        slot: typeof emptySlots[number];
        pick: LiveCandidate | null;
        searchSummary: AutoFillSearchSummary;
      }> = [];
      const plannedIdentities = new Set(pickedIdentities);
      for (const slot of emptySlots) {
        const pool = await getCandidatePool(slot.bedrooms, false);
        const pick = pool.candidates.find((c) => !hasUsedListingIdentity(plannedIdentities, c)) ?? null;
        if (pick) addUsedListingIdentity(plannedIdentities, pick);
        plannedPicks.push({ slot, pick, searchSummary: pool.searchSummary });
      }
      for (const planned of plannedPicks) {
        const slotResult = planned.pick
          ? await createAndAttachPick(planned.slot, planned.pick, planned.slot.bedrooms, planned.searchSummary)
          : {
              slot: planned.slot,
              picked: null,
              created: null,
              skippedReasons: ["find-buy-in returned no unused cheapest candidates"],
              airbnbPick: false,
              searchSummary: planned.searchSummary,
            };
        results.push(slotResult);
      }
      return { reservation, results, comboOptions: comboEvaluation.options };
    },
    onSuccess: ({ reservation, results, comboOptions }) => {
      autoFillRunRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      setAutoFilling(null);
      setAutoFillStartedAtMs(null);
      if (comboOptions.length > 0) {
        setLastAutoFillCombos((prev) => ({ ...prev, [reservation._id]: comboOptions }));
      }
      const filled = results.filter((r) => r.picked);
      const totalCost = filled.reduce((s, r) => s + (r.picked?.totalPrice ?? 0), 0);
      const payout = reservation.money?.hostPayout ?? 0;
      const existingCost = reservation.slots.reduce(
        (s, sl) => s + parseFloat(String(sl.buyIn?.costPaid ?? 0)),
        0,
      );
      const estProfit = payout - existingCost - totalCost;
      const skipped = results.filter((r) => !r.picked).map((r) => r.slot.unitLabel);
      const zeroCostFills = filled.filter((r) => (r.picked?.totalPrice ?? 0) === 0);
      const selectedCombo = comboOptions.find((option) => option.selected);
      const comboSummary = comboOptions.length > 0
        ? ` · Compared ${comboOptions
            .map((option) => `${option.label}: ${option.totalCost == null ? option.unavailableReason ?? "unavailable" : fmtMoney(option.totalCost)}`)
            .join("; ")}${selectedCombo ? ` · Selected ${selectedCombo.label}` : ""}`
        : "";
      if (filled.length === 0) {
        const uniqueSummaries = Array.from(
          new Map(results.map((r) => [r.searchSummary.bedrooms, r.searchSummary])).values(),
        );
        const scanned = uniqueSummaries.reduce((sum, s) => sum + s.scanned, 0);
        const priced = uniqueSummaries.reduce((sum, s) => sum + s.priced, 0);
        const sourceCounts = uniqueSummaries.reduce(
          (acc, r) => ({
            airbnb: acc.airbnb + r.sourceCounts.airbnb,
            vrbo: acc.vrbo + r.sourceCounts.vrbo,
            booking: acc.booking + r.sourceCounts.booking,
            pm: acc.pm + r.sourceCounts.pm,
          }),
          { airbnb: 0, vrbo: 0, booking: 0, pm: 0 },
        );
        const sourceSummary = `Airbnb ${sourceCounts.airbnb}, Vrbo ${sourceCounts.vrbo}, Booking.com ${sourceCounts.booking}, PM ${sourceCounts.pm}`;
        toast({
          title: "No verified priced candidates",
          description: scanned > 0
            ? `Found ${scanned} scanned option${scanned === 1 ? "" : "s"} (${sourceSummary}), but ${priced === 0 ? "none had a live price" : "none were verified bookable"} for these dates. Click a slot's chevron to audit the live results.`
            : "No source returned a candidate for these dates. Click Find buy-in on a slot to retry the live search.",
        });
      } else if (zeroCostFills.length === filled.length) {
        const hasVrboPick = filled.some((r) => /(?:^|\.)vrbo\.com/.test(r.picked?.url ?? ""));
        toast({
          title: hasVrboPick
            ? `Attached ${filled.length} Vrbo link${filled.length > 1 ? "s" : ""} for review`
            : `Attached ${filled.length} PM link${filled.length > 1 ? "s" : ""} for review`,
          description: (hasVrboPick
            ? `A source returned a review link without a usable price. Re-run live search before confirming with the guest.`
            : `A PM source returned a link without a usable price. Re-run live search before confirming with the guest.`)
            + comboSummary
            + (skipped.length ? ` · No URL found for: ${skipped.join(", ")}` : ""),
        });
      } else {
        const airbnbPickCount = filled.filter((r) => r.airbnbPick).length;
        toast({
          title: airbnbPickCount > 0
            ? `Filled ${filled.length} / ${results.length} units — ${airbnbPickCount} via Airbnb`
            : `Filled ${filled.length} / ${results.length} units`,
          description:
            `Total buy-in cost: $${totalCost.toLocaleString()} · Est. profit: $${estProfit.toLocaleString()}`
            + comboSummary
            + (zeroCostFills.length > 0 ? ` · ${zeroCostFills.length} attached without live price — review before confirming` : "")
            + (airbnbPickCount > 0 ? ` · ⚠️ ${airbnbPickCount} Airbnb URL${airbnbPickCount > 1 ? "s" : ""} attached (TOS prohibits sublet — see slot notes)` : "")
            + (skipped.length ? ` · No PM/Booking/Airbnb candidate for: ${skipped.join(", ")} (open Find buy-in for those)` : ""),
        });
      }
    },
    onError: (e: any) => {
      autoFillRunRef.current = null;
      setAutoFilling(null);
      setAutoFillStartedAtMs(null);
      const raw = String(e?.message ?? "");
      // Railway returns a 502 JSON envelope when the find-buy-in
      // handler exceeds its edge timeout. Translate that into an
      // operator-friendly retry hint instead of dumping JSON in the
      // toast. The server's per-source wall-budget should prevent
      // this in steady state — if you're still seeing 502s, it
      // means several sources are simultaneously slow.
      const is502 = /\b502\b/.test(raw) && /Application failed to respond/.test(raw);
      toast({
        title: is502 ? "Search took too long — retry in a moment" : "Auto-fill failed",
        description: is502
          ? "The buy-in search exceeded the upstream timeout (likely a slow scraper). Click Auto-fill cheapest again — the second run usually warms the cache and completes in under 30s."
          : raw,
        variant: "destructive",
      });
    },
  });

  const autoFillSidecarQueue = useSidecarQueueStatus(!!autoFilling);
  const autoFillSidecarActive = !!autoFilling
    && isSidecarStatusForSearch(autoFillSidecarQueue.status, autoFillStartedAtMs);

  useEffect(() => {
    if (!autoFilling) return;
    if (autoFillMutation.isPending || autoFillSidecarActive) return;
    if (!autoFillSidecarQueue.fetched) return;

    const id = setTimeout(() => {
      autoFillRunRef.current = null;
      setAutoFilling(null);
      setAutoFillStartedAtMs(null);
    }, 3_000);
    return () => clearTimeout(id);
  }, [
    autoFilling,
    autoFillMutation.isPending,
    autoFillSidecarActive,
    autoFillSidecarQueue.fetched,
  ]);

  const toggleExpanded = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const stats = useMemo(() => {
    if (!reservations.length) return null;
    const fully = reservations.filter((r) => r.fullyLinked).length;
    const totalRevenue = reservations.reduce((s, r) => s + (r.money?.hostPayout ?? 0), 0);
    // Only count fully-linked bookings' buy-in costs to keep profit math honest
    const linkedCost = reservations
      .filter((r) => r.fullyLinked)
      .reduce((s, r) => s + r.slots.reduce((ss, sl) => ss + parseFloat(String(sl.buyIn?.costPaid ?? 0)), 0), 0);
    const linkedRevenue = reservations
      .filter((r) => r.fullyLinked)
      .reduce((s, r) => s + (r.money?.hostPayout ?? 0), 0);
    return {
      total: reservations.length,
      fully,
      partial: reservations.filter((r) => r.slotsFilled > 0 && !r.fullyLinked).length,
      totalRevenue,
      linkedCost,
      profit: linkedRevenue - linkedCost,
    };
  }, [reservations]);

  const depositRows = useMemo(() => {
    return reservations.flatMap((r) => {
      const guestPaid = asMoneyNumber(r.money?.totalPaid);
      const balanceDue = asMoneyNumber(r.money?.balanceDue);
      const buyInCost = getBuyInCost(r);
      const paymentSource = paymentSourceOf(r);
      const installments = depositInstallmentsFor(r);
      return installments.map((installment, index) => ({
        reservation: r,
        rowId: `${r._id}-${index}-${installment.triggerDate?.toISOString().slice(0, 10) ?? "unknown"}-${installment.amount.toFixed(2)}`,
        installmentLabel: installments.length > 1 ? `Payment ${index + 1}` : installment.installmentLabel,
        triggerDate: installment.triggerDate,
        triggerSource: installment.triggerSource,
        expectedPayout: installment.expectedPayout,
        expectedBank: installment.expectedBank,
        amount: installment.amount,
        guestPaid,
        balanceDue,
        openBalance: installment.status === "not_collected" ? balanceDue : 0,
        buyInCost: index === 0 ? buyInCost : 0,
        netAfterBuyIns: installment.amount > 0 ? installment.amount - (index === 0 ? buyInCost : 0) : 0,
        paymentSource,
        status: installment.status,
      }));
    }).sort((a, b) => {
      const ad = a.expectedBank?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bd = b.expectedBank?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });
  }, [reservations]);

  const depositStats = useMemo(() => {
    if (!depositRows.length) return null;
    const expected = depositRows.reduce((s, r) => s + r.amount, 0);
    const net = depositRows.reduce((s, r) => s + r.netAfterBuyIns, 0);
    const openBalance = depositRows.reduce((s, r) => s + r.openBalance, 0);
    const dated = depositRows.filter((r) => r.expectedBank).length;
    return { expected, net, openBalance, dated };
  }, [depositRows]);

  const totalBedrooms = unitSlots.reduce((s, u) => s + u.bedrooms, 0);
  const propertyLabel = selectedPropertyId
    ? `Property ${selectedPropertyId}${unitSlots.length > 1 ? ` · ${totalBedrooms} BR (${unitSlots.map((u) => `${u.bedrooms}BR`).join(" + ")})` : ""}`
    : "";

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 flex items-center gap-4">
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-1" data-testid="button-back-home">
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Button>
        </Link>
        <div className="h-5 w-px bg-border" />
        <div>
          <h1 className="font-semibold text-lg leading-tight">Operations</h1>
          <p className="text-xs text-muted-foreground">
            Bookings · Buy-in tracking · Live sidecar search across Airbnb, VRBO, Booking.com, and PM rental sites
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SidecarStatusBadge />
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetchBookings()}
            disabled={bookingsLoading}
            data-testid="button-refresh-bookings"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${bookingsLoading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        {/* Selectors */}
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="grow min-w-[260px]">
                <Label className="text-xs mb-1.5 block">Property</Label>
                <Select
                  value={selectedPropertyId?.toString() ?? ""}
                  onValueChange={(v) => {
                    setSelectedPropertyId(v ? parseInt(v, 10) : null);
                    setExpanded({});
                  }}
                >
                  <SelectTrigger data-testid="select-property">
                    <SelectValue placeholder="Select a property..." />
                  </SelectTrigger>
                  <SelectContent>
                    {propertyMap
                      .slice()
                      .sort((a, b) => {
                        // Sort by Guesty nickname if we have it, fall back to propertyId
                        const na = listingNameById.get(a.guestyListingId) ?? `~${a.propertyId}`;
                        const nb = listingNameById.get(b.guestyListingId) ?? `~${b.propertyId}`;
                        return na.localeCompare(nb);
                      })
                      .map((m) => {
                        const name = listingNameById.get(m.guestyListingId);
                        return (
                          <SelectItem key={m.propertyId} value={m.propertyId.toString()}>
                            {name ?? `Property ${m.propertyId}`}
                            <span className="text-muted-foreground text-xs ml-1.5">
                              · #{m.propertyId}
                            </span>
                          </SelectItem>
                        );
                      })}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="include-past"
                  checked={includePast}
                  onChange={(e) => setIncludePast(e.target.checked)}
                  className="rounded"
                  data-testid="checkbox-include-past"
                />
                <Label htmlFor="include-past" className="text-sm cursor-pointer">Include past stays</Label>
              </div>
              {selectedPropertyId && unitSlots.length > 0 && (
                <div className="text-xs text-muted-foreground bg-muted/40 px-3 py-2 rounded border">
                  <BedDouble className="h-3.5 w-3.5 inline mr-1 opacity-60" />
                  {propertyLabel}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {!selectedPropertyId && (
          <Card>
            <CardContent className="py-12 text-center">
              <Building2 className="h-10 w-10 mx-auto mb-3 opacity-20" />
              <p className="font-medium mb-1">Select a property to view bookings</p>
              <p className="text-sm text-muted-foreground">
                Bookings are pulled live from Guesty.
              </p>
            </CardContent>
          </Card>
        )}

        {selectedPropertyId && bookingsError && (
          <Card className="border-destructive">
            <CardContent className="py-6">
              <p className="text-sm text-destructive font-medium">
                <AlertCircle className="h-4 w-4 inline mr-1.5" />
                Failed to load bookings
              </p>
              <p className="text-xs text-muted-foreground mt-1 font-mono">{(bookingsErr as Error)?.message}</p>
            </CardContent>
          </Card>
        )}

        {selectedPropertyId && stats && (
          <div className="grid grid-cols-4 gap-3">
            <Card>
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Bookings</p>
                <p className="text-2xl font-semibold mt-1">{stats.total}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {stats.fully} fully linked · {stats.partial} partial
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Guest Revenue</p>
                <p className="text-2xl font-semibold mt-1">{fmtMoney(stats.totalRevenue)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Buy-In Cost (fully linked)</p>
                <p className="text-2xl font-semibold mt-1">{fmtMoney(stats.linkedCost)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Profit (fully linked)</p>
                <p className={`text-2xl font-semibold mt-1 ${stats.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {stats.profit >= 0 ? <TrendingUp className="h-4 w-4 inline mr-1" /> : <TrendingDown className="h-4 w-4 inline mr-1" />}
                  {fmtMoney(stats.profit)}
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {selectedPropertyId && !bookingsError && (
          <Tabs defaultValue="bookings" className="space-y-4">
            <TabsList data-testid="tabs-operations">
              <TabsTrigger value="bookings" data-testid="tab-operations-bookings">
                <Calendar className="h-3.5 w-3.5 mr-1.5" /> Bookings
              </TabsTrigger>
              <TabsTrigger value="deposits" data-testid="tab-operations-deposits">
                <WalletCards className="h-3.5 w-3.5 mr-1.5" /> Expected Deposits
              </TabsTrigger>
            </TabsList>

            <TabsContent value="bookings" className="space-y-4">
          {/* Bookings list — each is expandable to show unit slots */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="h-4 w-4" /> Reservations
                {bookingsLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
              </CardTitle>
              <CardDescription>
                Click a booking to expand and attach buy-ins for each physical unit. A buy-in can only cover one reservation; candidates are filtered to matching unit ID + covering dates.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {!bookingsLoading && reservations.length === 0 && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No bookings found for this listing.
                </p>
              )}
              {/* Sortable column headers — mirrors the data row exactly so
                  every column lines up: chevron-spacer + 6-col grid. */}
              {reservations.length > 0 && (
                <div className="px-4 py-2 border-b flex items-center gap-3">
                  <span className="w-4 h-4 shrink-0" /> {/* matches chevron icon in row */}
                  <div className="grow min-w-0 grid grid-cols-[1.5fr_1.5fr_1fr_1fr_1fr_auto] gap-3 items-center">
                    <SortHeader label="Guest" active={sortBy === "guest"} dir={sortDir} onClick={() => toggleSort("guest")} />
                    <SortHeader label="Check-in" active={sortBy === "checkIn"} dir={sortDir} onClick={() => toggleSort("checkIn")} />
                    <SortHeader label="Payout" active={sortBy === "payout"} dir={sortDir} onClick={() => toggleSort("payout")} align="right" />
                    <SortHeader label="Buy-in" active={sortBy === "buyIn"} dir={sortDir} onClick={() => toggleSort("buyIn")} align="right" />
                    <SortHeader label="Profit" active={sortBy === "profit"} dir={sortDir} onClick={() => toggleSort("profit")} align="right" />
                    <SortHeader label="Fill" active={sortBy === "status"} dir={sortDir} onClick={() => toggleSort("status")} />
                  </div>
                </div>
              )}
              {reservations.map((r) => {
                const isOpen = !!expanded[r._id];
                const nights = r.nightsCount ?? nightsBetween(checkInOf(r), checkOutOf(r));
                const payout = r.money?.hostPayout ?? 0;
                const totalBuyInCost = r.slots.reduce(
                  (s, sl) => s + parseFloat(String(sl.buyIn?.costPaid ?? 0)),
                  0,
                );
                const channel = r.integration?.platform ?? r.source ?? "direct";
                const rowAutoFillRunning = autoFilling === r._id
                  && (autoFillMutation.isPending || autoFillSidecarActive);
                const rowSidecarOnly = autoFilling === r._id
                  && !autoFillMutation.isPending
                  && autoFillSidecarActive;
                const comboOptions = lastAutoFillCombos[r._id] ?? [];
                return (
                  <div key={r._id} className="border rounded-lg bg-card" data-testid={`booking-row-${r._id}`}>
                    {/* Summary row */}
                    <button
                      onClick={() => toggleExpanded(r._id)}
                      className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted/40 transition-colors rounded-lg"
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                      <div className="grow min-w-0 grid grid-cols-[1.5fr_1.5fr_1fr_1fr_1fr_auto] gap-3 items-center">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{r.guest?.fullName ?? r.guest?.firstName ?? "Guest"}</p>
                          {r.confirmationCode && (
                            <p className="text-[10px] text-muted-foreground font-mono">{r.confirmationCode}</p>
                          )}
                        </div>
                        <div className="text-sm">
                          <p>{fmtDate(checkInOf(r))} → {fmtDate(checkOutOf(r))}</p>
                          <p className="text-xs text-muted-foreground">{nights} nights · <Badge variant="outline" className="text-[10px] capitalize ml-1">{channel}</Badge></p>
                        </div>
                        <div className="text-sm text-right">
                          <p className="font-medium">{fmtMoney(payout)}</p>
                          {(() => {
                            // Payment status from Guesty's money object (same
                            // data as the Payments tab in Guesty's reservation
                            // view). Three states: paid / partial / unpaid.
                            const totalPaid = r.money?.totalPaid ?? 0;
                            const balanceDue = r.money?.balanceDue ?? 0;
                            const fullyPaid = r.money?.isFullyPaid === true || (balanceDue <= 0 && totalPaid > 0);
                            if (fullyPaid) {
                              return (
                                <p className="text-[10px] font-medium text-green-700 flex items-center justify-end gap-0.5">
                                  <CheckCircle2 className="h-2.5 w-2.5" /> Paid in full
                                </p>
                              );
                            }
                            if (totalPaid > 0) {
                              return (
                                <p className="text-[10px] text-amber-700">
                                  {fmtMoney(totalPaid)} paid · {fmtMoney(balanceDue)} due
                                </p>
                              );
                            }
                            if (balanceDue > 0) {
                              return (
                                <p className="text-[10px] text-red-700 font-medium">
                                  {fmtMoney(balanceDue)} unpaid
                                </p>
                              );
                            }
                            return <p className="text-[10px] text-muted-foreground">guest payout</p>;
                          })()}
                        </div>
                        <div className="text-sm text-right">
                          <p className="font-medium">{fmtMoney(totalBuyInCost)}</p>
                          <p className="text-[10px] text-muted-foreground">buy-in cost</p>
                        </div>
                        <div className="text-sm text-right">
                          {r.fullyLinked ? (
                            <span className={`font-medium ${payout - totalBuyInCost >= 0 ? "text-green-600" : "text-red-600"}`}>
                              {fmtMoney(payout - totalBuyInCost)}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                          <p className="text-[10px] text-muted-foreground">profit</p>
                        </div>
                        <div className="shrink-0">
                          {rowAutoFillRunning ? (
                            <Badge className="bg-blue-600 text-white text-[10px]">
                              <RefreshCw className="h-2.5 w-2.5 mr-1 animate-spin" />
                              {rowSidecarOnly ? "Sidecar running" : "Searching"}
                            </Badge>
                          ) : r.fullyLinked ? (
                            <Badge className="bg-green-600 text-white text-[10px]">
                              <CheckCircle2 className="h-2.5 w-2.5 mr-1" /> All slots filled
                            </Badge>
                          ) : r.slotsFilled > 0 ? (
                            <Badge className="bg-amber-500 text-white text-[10px]">
                              {r.slotsFilled} / {r.slotsTotal} filled
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">
                              0 / {r.slotsTotal} filled
                            </Badge>
                          )}
                        </div>
                      </div>
                    </button>

                    {/* Expanded: per-unit-slot detail */}
                    {isOpen && (
                      <div className="border-t px-4 py-3 bg-muted/20 space-y-2">
                        {/* Auto-fill: one click to search + attach cheapest
                            priced option for every empty slot on this row. */}
                        {r.slotsFilled < r.slotsTotal && (
                          <div className="bg-primary/5 border border-primary/20 rounded px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-xs text-muted-foreground">
                                {r.slotsTotal - r.slotsFilled} empty {r.slotsTotal - r.slotsFilled === 1 ? "unit" : "units"} · auto-pick the cheapest live listing for each
                              </div>
                              <Button
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (autoFillRunRef.current || autoFillMutation.isPending || autoFilling) return;
                                  autoFillRunRef.current = r._id;
                                  closeSlotSearchesForReservation(r);
                                  setAutoFillStartedAtMs(Date.now());
                                  setAutoFilling(r._id);
                                  autoFillMutation.mutate({ reservation: r });
                                }}
                                disabled={rowAutoFillRunning || autoFillMutation.isPending || !!autoFilling}
                                data-testid={`button-auto-fill-${r._id}`}
                              >
                                {autoFillMutation.isPending && autoFilling === r._id ? (
                                  <><RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" /> Searching…</>
                                ) : rowSidecarOnly ? (
                                  <><RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" /> Sidecar verifying…</>
                                ) : (
                                  <><Zap className="h-3.5 w-3.5 mr-1" /> Auto-fill cheapest</>
                                )}
                              </Button>
                            </div>
                            {rowAutoFillRunning && (
                              <AutoFillProgress
                                slotCount={r.slotsTotal - r.slotsFilled}
                                sidecarStatus={autoFillSidecarQueue.status}
                              />
                            )}
                          </div>
                        )}
                        {comboOptions.length > 0 && <ComboComparisonPanel options={comboOptions} />}
                        {r.slots.map((slot) => {
                          const slotIsExpanded = expandedSlots.has(slotKey(r._id, slot.unitId));
                          return (
                          <div
                            key={slot.unitId}
                            className="bg-background rounded border"
                            data-testid={`slot-${r._id}-${slot.unitId}`}
                          >
                          <div
                            className="flex items-center gap-3 px-3 py-2.5"
                          >
                            <div className="shrink-0 w-24">
                              <p className="text-sm font-medium">{slot.unitLabel}</p>
                              <p className="text-[10px] text-muted-foreground">{slot.bedrooms} BR</p>
                            </div>
                            <div className="grow min-w-0">
                              {slot.buyIn ? (
                                <div className="flex items-center gap-2">
                                  <Link2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                                  <div className="min-w-0">
                                    <p className="text-sm truncate">
                                      {fmtMoney(slot.buyIn.costPaid)}
                                      {" · "}
                                      {fmtDate(slot.buyIn.checkIn)} → {fmtDate(slot.buyIn.checkOut)}
                                    </p>
                                    <p className="text-[10px] text-muted-foreground truncate">
                                      {slot.buyIn.airbnbConfirmation && (
                                        <span className="font-mono">#{slot.buyIn.airbnbConfirmation}</span>
                                      )}
                                      {slot.buyIn.airbnbListingUrl && (
                                        <a
                                          href={slot.buyIn.airbnbListingUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="ml-2 text-primary hover:underline inline-flex items-center gap-0.5"
                                        >
                                          view on {sourceLabelForUrl(slot.buyIn.airbnbListingUrl)} <ExternalLink className="h-2.5 w-2.5" />
                                        </a>
                                      )}
                                      {/* Manual-quote PMs (Suite Paradise, etc.) — show
                                          phone number inline so the operator knows the
                                          next action is a call, not a click-through. */}
                                      {(() => {
                                        const m = manualOnlyPmForUrl(slot.buyIn.airbnbListingUrl);
                                        if (!m || !m.phone) return null;
                                        return (
                                          <span className="ml-2 text-amber-700 dark:text-amber-400 inline-flex items-center gap-0.5">
                                            · 📞 quote: <a href={`tel:${m.phone.replace(/[^\d+]/g, "")}`} onClick={(e) => e.stopPropagation()} className="underline hover:no-underline">{m.phone}</a>
                                          </span>
                                        );
                                      })()}
                                    </p>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-xs text-muted-foreground italic">No buy-in attached for this unit</p>
                              )}
                            </div>
                            <div className="shrink-0 flex items-center gap-1">
                              {slot.buyIn ? (
                                <>
                                  {/* Verify rate — on-demand vision check
                                      against the buy-in's PM URL. Only show
                                      when there's a URL to verify; the
                                      dialog handles the loading state and
                                      manual cost edit. */}
                                  {slot.buyIn.airbnbListingUrl && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => slot.buyIn && setVerifyTarget({ buyIn: slot.buyIn, reservation: r })}
                                      data-testid={`button-verify-rate-${r._id}-${slot.unitId}`}
                                      title="Take a screenshot of the PM page and try to extract the rate"
                                    >
                                      <Camera className="h-3.5 w-3.5 mr-1" />
                                      {parseFloat(String(slot.buyIn.costPaid ?? 0)) === 0 ? "Verify rate" : "Re-verify"}
                                    </Button>
                                  )}
                                  {slot.buyIn.airbnbListingUrl && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => slot.buyIn && setListingSitesTarget({ buyIn: slot.buyIn, reservation: r, slot })}
                                      data-testid={`button-listing-sites-${r._id}-${slot.unitId}`}
                                      title="Scan this listing's private photos for other websites"
                                    >
                                      <Globe className="h-3.5 w-3.5 mr-1" />
                                      Find sites
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => slot.buyIn && detachMutation.mutate(slot.buyIn.id)}
                                    disabled={detachMutation.isPending}
                                    data-testid={`button-detach-${r._id}-${slot.unitId}`}
                                  >
                                    <Unlink className="h-3.5 w-3.5 mr-1" /> Detach
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  size="sm"
                                  onClick={() => setPicker({ reservation: r, slot })}
                                  data-testid={`button-find-buyin-${r._id}-${slot.unitId}`}
                                >
                                  <Search className="h-3.5 w-3.5 mr-1" />
                                  Find {slot.bedrooms}BR+ buy-in
                                </Button>
                              )}
                              {/* Per-slot toggle for the inline live-search
                                  panel. This starts a fresh audit search,
                                  so Auto-fill leaves it closed after attaching
                                  picks. */}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => toggleSlotSearch(r._id, slot.unitId)}
                                data-testid={`button-toggle-search-${r._id}-${slot.unitId}`}
                                title={slotIsExpanded ? "Hide live search" : "Show live search"}
                              >
                                {slotIsExpanded
                                  ? <ChevronDown className="h-3.5 w-3.5" />
                                  : <ChevronRight className="h-3.5 w-3.5" />}
                              </Button>
                            </div>
                          </div>
                          {slotIsExpanded && selectedPropertyId && (
                            <div className="border-t bg-muted/20 px-3 py-3">
                              <LiveSearchSection
                                reservation={r}
                                propertyId={selectedPropertyId}
                                slot={slot}
                              />
                            </div>
                          )}
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
            </TabsContent>

            <TabsContent value="deposits" className="space-y-4">
              {depositStats && (
                <div className="grid grid-cols-4 gap-3">
                  <Card>
                    <CardContent className="py-4">
                      <p className="text-xs text-muted-foreground">Expected Deposits</p>
                      <p className="text-2xl font-semibold mt-1">{fmtMoney(depositStats.expected)}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="py-4">
                      <p className="text-xs text-muted-foreground">Expected Net</p>
                      <p className={`text-2xl font-semibold mt-1 ${depositStats.net >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {fmtMoney(depositStats.net)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">after attached buy-ins</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="py-4">
                      <p className="text-xs text-muted-foreground">Open Balance</p>
                      <p className="text-2xl font-semibold mt-1">{fmtMoney(depositStats.openBalance)}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="py-4">
                      <p className="text-xs text-muted-foreground">Dated Rows</p>
                      <p className="text-2xl font-semibold mt-1">{depositStats.dated}</p>
                    </CardContent>
                  </Card>
                </div>
              )}

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Landmark className="h-4 w-4" /> Expected Deposits
                    {bookingsLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
                  </CardTitle>
                  <CardDescription>
                    Split-payment reservations show each collected or scheduled installment separately when Guesty exposes the payment schedule.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!bookingsLoading && depositRows.length === 0 && (
                    <p className="text-sm text-muted-foreground py-6 text-center">
                      No deposit rows found for this listing.
                    </p>
                  )}
                  {depositRows.length > 0 && (
                    <div className="overflow-x-auto">
                      <div className="min-w-[980px]">
                        <div className="grid grid-cols-[1.35fr_1.15fr_.95fr_.95fr_.9fr_.9fr_.9fr_.85fr] gap-3 px-3 py-2 border-b text-[10px] uppercase tracking-wider text-muted-foreground">
                          <div>Guest</div>
                          <div>Stay</div>
                          <div className="text-right">Deposit</div>
                          <div>Trigger Date</div>
                          <div>Expected Bank</div>
                          <div className="text-right">Buy-in</div>
                          <div className="text-right">Net</div>
                          <div>Status</div>
                        </div>
                        <div className="divide-y">
                          {depositRows.map((row) => {
                            const r = row.reservation;
                            const channel = r.integration?.platform ?? r.source ?? "direct";
                            const statusClasses = {
                              airbnb_expected: "bg-blue-600 text-white",
                              collected: "bg-green-600 text-white",
                              scheduled: "bg-blue-600 text-white",
                              partial: "bg-amber-500 text-white",
                              not_collected: "bg-red-600 text-white",
                              unknown: "",
                            } as const;
                            const statusLabel = {
                              airbnb_expected: "arrival payout",
                              collected: "collected",
                              scheduled: "scheduled",
                              partial: "partial",
                              not_collected: "not collected",
                              unknown: "unknown",
                            }[row.status];
                            return (
                              <div
                                key={`deposit-${row.rowId}`}
                                className="grid grid-cols-[1.35fr_1.15fr_.95fr_.95fr_.9fr_.9fr_.9fr_.85fr] gap-3 px-3 py-3 items-center text-sm"
                                data-testid={`deposit-row-${r._id}`}
                              >
                                <div className="min-w-0">
                                  <p className="font-medium truncate">{r.guest?.fullName ?? r.guest?.firstName ?? "Guest"}</p>
                                  <p className="text-[10px] text-muted-foreground font-mono truncate">{r.confirmationCode ?? r._id}</p>
                                  <p className="text-[10px] text-muted-foreground truncate">{row.installmentLabel}</p>
                                </div>
                                <div className="min-w-0">
                                  <p>{fmtDate(checkInOf(r))} → {fmtDate(checkOutOf(r))}</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {r.nightsCount ?? nightsBetween(checkInOf(r), checkOutOf(r))} nights · <span className="capitalize">{channel}</span>
                                  </p>
                                </div>
                                <div className="text-right">
                                  <p className="font-medium">{row.amount > 0 ? fmtMoney(row.amount) : "—"}</p>
                                  {row.guestPaid > 0 && row.guestPaid !== row.amount && (
                                    <p className="text-[10px] text-muted-foreground">{fmtMoney(row.guestPaid)} paid</p>
                                  )}
                                  {row.amount <= 0 && row.openBalance > 0 && (
                                    <p className="text-[10px] text-muted-foreground">not collected</p>
                                  )}
                                </div>
                                <div>
                                  <p>{row.triggerDate ? fmtDate(row.triggerDate.toISOString()) : "—"}</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {row.triggerSource === "airbnb_arrival"
                                      ? "arrival"
                                      : row.triggerSource === "payment"
                                        ? "payment"
                                        : row.triggerSource === "schedule"
                                          ? "scheduled"
                                          : row.triggerSource === "reservation"
                                            ? "reservation"
                                            : "unknown"}
                                  </p>
                                </div>
                                <div>
                                  <p className="font-medium">{row.expectedBank ? fmtDate(row.expectedBank.toISOString()) : "—"}</p>
                                  {row.expectedPayout && row.expectedBank && row.expectedPayout.toDateString() !== row.expectedBank.toDateString() && (
                                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                                      <Clock3 className="h-2.5 w-2.5" /> {fmtDate(row.expectedPayout.toISOString())} payout
                                    </p>
                                  )}
                                </div>
                                <div className="text-right">
                                  <p>{fmtMoney(row.buyInCost)}</p>
                                  {!r.fullyLinked && r.slotsTotal > 0 && (
                                    <p className="text-[10px] text-amber-700">{r.slotsFilled} / {r.slotsTotal} linked</p>
                                  )}
                                </div>
                                <div className="text-right">
                                  {row.amount > 0 ? (
                                    <p className={`font-medium ${row.netAfterBuyIns >= 0 ? "text-green-600" : "text-red-600"}`}>
                                      {fmtMoney(row.netAfterBuyIns)}
                                    </p>
                                  ) : (
                                    <p className="text-muted-foreground">—</p>
                                  )}
                                </div>
                                <div>
                                  <Badge
                                    variant={row.status === "unknown" ? "outline" : "default"}
                                    className={`text-[10px] capitalize ${statusClasses[row.status]}`}
                                  >
                                    {statusLabel}
                                  </Badge>
                                  {row.openBalance > 0 && (
                                    <p className="text-[10px] text-muted-foreground mt-1">{fmtMoney(row.openBalance)} due</p>
                                  )}
                                  <p className="text-[10px] text-muted-foreground mt-1" title={row.paymentSource.detail}>
                                    {row.paymentSource.label}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* Candidate picker dialog — scoped to one slot */}
      <Dialog open={!!picker} onOpenChange={(open) => { if (!open) setPicker(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Find buy-in for {picker?.slot.unitLabel} <span className="text-muted-foreground font-normal">({picker?.slot.bedrooms} BR minimum)</span>
            </DialogTitle>
            <DialogDescription>
              {picker && (
                <span>
                  {picker.reservation.guest?.fullName ?? "Guest"} ·{" "}
                  {fmtDate(checkInOf(picker.reservation))} → {fmtDate(checkOutOf(picker.reservation))} ·{" "}
                  {picker.reservation.nightsCount ?? nightsBetween(checkInOf(picker.reservation), checkOutOf(picker.reservation))} nights
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {picker && selectedPropertyId && (
            <CandidateList
              reservation={picker.reservation}
              propertyId={selectedPropertyId}
              slot={picker.slot}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Per-slot Verify rate dialog — runs verify-pm-listing on demand
          and shows the screenshot inline. Decoupled from auto-fill so a
          slow PM site can't block the broader flow. */}
      {verifyTarget && (
        <VerifyRateDialog
          buyIn={verifyTarget.buyIn}
          reservationCheckIn={checkInOf(verifyTarget.reservation) ?? verifyTarget.buyIn.checkIn}
          reservationCheckOut={checkOutOf(verifyTarget.reservation) ?? verifyTarget.buyIn.checkOut}
          onClose={() => setVerifyTarget(null)}
        />
      )}
      {listingSitesTarget && (
        <BuyInListingSitesDialog
          buyIn={listingSitesTarget.buyIn}
          unitLabel={listingSitesTarget.slot.unitLabel}
          onClose={() => setListingSitesTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Candidate list component ───────────────────────────────────────────────

function CandidateList({
  reservation,
  propertyId,
  slot,
}: {
  reservation: GuestyReservation;
  propertyId: number;
  slot: SlotInfo;
}) {
  // Existing-buy-ins picker was removed (was here historically): when
  // auto-fill creates buy-in records and the operator detaches them,
  // the records stay in the DB with `guestyReservationId=NULL` and
  // pile up as ghost rows of the same listing repeated N times. The
  // canonical path is now ALWAYS a fresh live search via
  // <LiveSearchSection> below — so this dialog skips the DB picker
  // entirely. Buy-ins that were intentionally pre-purchased can still
  // be attached from the buy-in tracker page directly.

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto">
      {/* ── Live multi-source search (auto-runs) ─────────────────────── */}
      <LiveSearchSection
        reservation={reservation}
        propertyId={propertyId}
        slot={slot}
      />
    </div>
  );
}

function photoRoleLabel(role: BuyInListingSitePhoto["role"]): string {
  if (role === "living-room") return "Living room";
  if (role === "interior") return "Interior";
  if (role === "main") return "Main";
  return "Skipped";
}

function BuyInListingSitesDialog({
  buyIn,
  unitLabel,
  onClose,
}: {
  buyIn: BuyIn;
  unitLabel: string;
  onClose: () => void;
}) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const { data, isLoading, isFetching, isError, error } = useQuery<BuyInListingSitesResponse>({
    queryKey: ["/api/buy-ins", buyIn.id, "listing-sites", refreshNonce],
    queryFn: () => apiRequest(
      "POST",
      `/api/buy-ins/${buyIn.id}/listing-sites${refreshNonce > 0 ? "?nocache=1" : ""}`,
      refreshNonce > 0 ? { nocache: true } : {},
    ).then((r) => r.json()),
    staleTime: 12 * 60 * 60_000,
  });
  const photos = data?.photos ?? [];
  const searchedPhotos = photos.filter((photo) => photo.searched);
  const skippedPhotos = photos.filter((photo) => photo.skippedReason);
  const backupPhotos = photos.filter((photo) => !photo.searched && !photo.skippedReason);
  const matches = data?.matches ?? [];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Find sites for {unitLabel}</DialogTitle>
          <DialogDescription>
            {buyIn.airbnbListingUrl ? (
              <a
                href={buyIn.airbnbListingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                Source listing on {sourceLabelForUrl(buyIn.airbnbListingUrl)}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              "No source listing URL attached"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {(isLoading || isFetching) && !data && (
            <div className="rounded-lg border p-6 text-sm text-muted-foreground text-center">
              <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
              Scanning listing photos and checking matching websites…
            </div>
          )}

          {isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 inline mr-1" />
              {(error as Error).message}
            </div>
          )}

          {data && (
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-xs text-muted-foreground">
                  {searchedPhotos.length} photo{searchedPhotos.length === 1 ? "" : "s"} searched
                  {skippedPhotos.length > 0 ? ` · ${skippedPhotos.length} skipped` : ""}
                  {backupPhotos.length > 0 ? ` · ${backupPhotos.length} held as backup` : ""}
                  {data.fromCache ? " · cached" : ""}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRefreshNonce((n) => n + 1)}
                  disabled={isFetching}
                >
                  <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>

              {data.message && (
                <div className="rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-900">
                  {data.message}
                </div>
              )}

              {photos.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {photos.slice(0, 8).map((photo, idx) => (
                    <div key={`${photo.url}-${idx}`} className={`rounded-md border overflow-hidden ${photo.searched ? "bg-background" : "bg-muted/30 opacity-75"}`}>
                      <div className="aspect-video bg-muted">
                        <img src={photo.url} alt="" className="h-full w-full object-cover" />
                      </div>
                      <div className="p-2 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant={photo.searched ? "default" : "outline"} className="text-[9px]">
                            {photoRoleLabel(photo.role)}
                          </Badge>
                          {photo.confidence != null && (
                            <span className="text-[9px] text-muted-foreground">{Math.round(photo.confidence * 100)}%</span>
                          )}
                        </div>
                        <p className="text-[11px] font-medium truncate" title={photo.label ?? photo.category ?? ""}>
                          {photo.label ?? photo.category ?? "Photo"}
                        </p>
                        {photo.skippedReason && (
                          <p className="text-[10px] text-muted-foreground line-clamp-2" title={photo.skippedReason}>
                            {photo.skippedReason}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-lg border overflow-hidden">
                <div className="px-3 py-2 border-b bg-muted/30 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Matching websites
                  </p>
                  <span className="text-[11px] text-muted-foreground">
                    {matches.length} found
                  </span>
                </div>
                {matches.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    No other listing sites found from the selected private photos.
                  </p>
                ) : (
                  <div className="divide-y">
                    {matches.map((match, idx) => (
                      <a
                        key={`${match.domain}-${idx}`}
                        href={match.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors"
                        data-testid={`buy-in-listing-site-${idx}`}
                      >
                        <Badge className={`text-[9px] shrink-0 ${sourceBadgeClass(match.platformKey)}`}>
                          {match.platform}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate" title={match.title}>{match.title}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {match.domain}
                            {match.matchedPhotoRole ? ` · ${photoRoleLabel(match.matchedPhotoRole)}` : ""}
                            {match.matchedPhotoLabel ? ` · ${match.matchedPhotoLabel}` : ""}
                          </p>
                        </div>
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Live search across Airbnb, Vrbo, Booking.com, and PM companies ─────────

type LiveCandidate = {
  source: "airbnb" | "vrbo" | "booking" | "pm";
  sourceLabel: string;
  title: string;
  url: string;
  nightlyPrice: number;
  totalPrice: number;
  bedrooms?: number;
  image?: string;
  snippet?: string;
  // Reverse-image-search hits where the same photo appears on a non-OTA
  // site (typically a property-management company that has the same
  // unit listed for direct booking). Populated for the top N priced
  // Airbnb candidates server-side. Zero-length when no matches were
  // found OR the candidate isn't in the top-N pool.
  photoMatches?: Array<{ url: string; title: string; domain: string }>;
  // When this candidate is derived from a grouped physical unit, keep
  // every known listing URL in the cluster so Auto-fill can avoid
  // choosing the same unit again through another channel.
  alternateUrls?: string[];
  // Precomputed identity keys from a grouped physical unit. These
  // supplement URL/image/title matching when Auto-fill compares
  // combination candidates.
  identityKeys?: string[];
  // For PM candidates surfaced via reverse-image match against an
  // Airbnb listing: the anchor's URL + price. Auto-fill annotates the
  // buy-in note with these so the operator knows the price is a proxy
  // (Airbnb's, attached because Airbnb verifies availability at the
  // resort for those exact dates) and the actual PM rate may differ.
  airbnbAnchorUrl?: string;
  airbnbAnchorPrice?: number;
  // Server-side verification state (find-buy-in pre-verifies top-N
  // priced PM candidates against actual PM page). The Cheapest panel
  // is gated on this — operators should never see "buy this" for a
  // unit that isn't confirmed bookable for the requested dates.
  verified?: "yes" | "no" | "unclear" | "skipped";
  verifiedNightlyPrice?: number | null;
  verifiedReason?: string;
};

// Single channel inside a clustered unit (one row inside a UnitRow).
// Mirrors server's ListingChannel from /api/operations/find-buy-in.
type LiveUnitListing = {
  channel: "airbnb" | "vrbo" | "booking" | "pm";
  channelLabel: string;
  url: string;
  nightlyPrice: number;
  totalPrice: number;
  bedrooms?: number;
  verified?: "yes" | "no" | "unclear" | "skipped";
  verifiedReason?: string;
};

type LiveUnit = {
  unitTitle: string;
  bedrooms?: number;
  image?: string;
  minNightlyPrice: number;
  primaryUrl: string;
  primaryChannel: "airbnb" | "vrbo" | "booking" | "pm";
  listings: LiveUnitListing[];
};

type ReverseImageListingMatch = {
  platformKey: "airbnb" | "vrbo" | "booking" | "pm" | "other";
  platform: string;
  domain: string;
  title: string;
  url: string;
  source: string;
  position: number;
  matchedPhotoUrl?: string;
  matchedPhotoRole?: "main" | "living-room" | "interior";
  matchedPhotoLabel?: string | null;
  matchedPhotoCategory?: string | null;
};

type ReverseImageLookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; matches: ReverseImageListingMatch[]; fromCache: boolean }
  | { status: "error"; message: string };

type BuyInListingSitePhoto = {
  url: string;
  role: "main" | "living-room" | "interior" | null;
  label: string | null;
  category: string | null;
  confidence: number | null;
  searched: boolean;
  skippedReason: string | null;
};

type BuyInListingSitesResponse = {
  buyInId: number;
  sourceUrl: string;
  sourceLabel: string;
  photos: BuyInListingSitePhoto[];
  matches: ReverseImageListingMatch[];
  rawCount: number;
  generatedAt: string;
  message?: string;
  fromCache?: boolean;
};

type FindBuyInResponse = {
  community: string;
  resortName?: string | null;
  listingTitle?: string | null;
  bedrooms: number;
  nights: number;
  fromCache?: boolean;
  cacheAgeSec?: number;
  // Server-side `cheapest` is the source of truth for Auto-fill. It is
  // already filtered to the verified, date-specific candidates that are
  // safe to attach without running another client-side PM verifier.
  // Airbnb can appear there by operator directive; Auto-fill adds a TOS
  // warning to the buy-in notes when it selects an Airbnb URL.
  sources: {
    airbnb: LiveCandidate[];
    vrbo: LiveCandidate[];
    booking: LiveCandidate[];
    pm: LiveCandidate[];
  };
  diagnostics?: FindBuyInDiagnostics;
  scanComplete?: boolean;
  autoFillSafe?: boolean;
  cheapest: LiveCandidate[];
  // Same units as `cheapest` but grouped: when the same physical unit
  // is listed across multiple channels (Airbnb + VRBO + a PM site, all
  // sharing photos), they collapse into ONE row with a per-channel
  // sub-list. Shipped in PR #275 alongside the redundant-VRBO-provider
  // teardown — older deploys may not return this field, so the panel
  // falls back to the flat `cheapest` list.
  cheapestUnits?: LiveUnit[];
  debug?: {
    rawCounts?: { airbnb?: number; airbnbEngine?: number; vrbo?: number; booking?: number; pm?: number; photoMatches?: number };
    dropped?: {
      airbnb?: { noResort: number; wrongBedrooms: number };
      vrbo?: { noResort: number; wrongBedrooms: number };
      booking?: { noResort: number; wrongBedrooms: number };
      photoMatchBedroomMismatch?: number;
      photoMatchLanding?: number;
    };
    verification?: {
      attempted: number;
      yes: number;
      no: number;
      unclear: number;
      sidecarReasonSummary?: string;
      available: boolean;
    };
    searchLocation?: string;
    vrboDestination?: string;
    resortName?: string | null;
  };
};

type FindBuyInDiagnostics = {
  severity: "ok" | "warning" | "error";
  title: string;
  summary: string;
  generatedAt: string;
  elapsedMs?: number;
  request?: {
    propertyId?: number;
    community?: string;
    resortName?: string | null;
    bedrooms?: number;
    checkIn?: string;
    checkOut?: string;
    nights?: number;
  };
  sources?: Array<{
    source: string;
    status: "ok" | "warning" | "error" | "timeout" | "skipped";
    raw?: number;
    kept?: number;
    priced?: number;
    verified?: number;
    durationMs?: number;
    message?: string;
  }>;
  issues?: Array<{
    severity: "warning" | "error";
    source: string;
    summary: string;
    detail?: string;
  }>;
  report: string;
};

const autoOpenedSearchDiagnosticKeys = new Set<string>();

function sourceBadgeClass(src: string) {
  switch (src) {
    case "airbnb":  return "bg-[#FF5A5F] text-white";
    case "vrbo":    return "bg-blue-600 text-white";
    case "booking": return "bg-blue-800 text-white";
    case "pm":      return "bg-slate-600 text-white";
    default:        return "bg-muted";
  }
}

// Local-Mac sidecar status indicator. The buy-in tool delegates Airbnb,
// VRBO, Booking.com, and PM website searches to a daemon running on the
// operator's Mac, which drives their real Chrome via CDP. When the
// Mac is asleep / Claude Code closed without the daemon installed /
// daemon crashed, the operator should know immediately. Polls /heartbeat
// every 30s anywhere Operations is mounted.
function SidecarStatusBadge() {
  const [state, setState] = useState<{
    isOnline: boolean | null;
    ageMs: number | null;
    everSeen: boolean;
  }>({ isOnline: null, ageMs: null, everSeen: false });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/vrbo-sidecar/heartbeat");
        if (!r.ok) return;
        const data = await r.json() as { isOnline: boolean; ageMs: number | null; lastWorkerPollAt: string | null };
        if (cancelled) return;
        setState({
          isOnline: data.isOnline,
          ageMs: data.ageMs,
          everSeen: !!data.lastWorkerPollAt,
        });
      } catch {
        if (!cancelled) setState((p) => ({ ...p, isOnline: false }));
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (state.isOnline === null) {
    // First heartbeat poll hasn't returned yet — render nothing rather
    // than flicker a "checking…" state.
    return null;
  }
  if (state.isOnline) {
    return (
      <Badge
        className="gap-1 text-[10px] bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-300 cursor-help"
        title={
          state.ageMs != null
            ? `Local Mac sidecar polled ${Math.round(state.ageMs / 1000)}s ago. Airbnb, VRBO, Booking.com, and PM searches drive through your real Chrome.`
            : "Local Mac sidecar online."
        }
      >
        <CheckCircle2 className="h-3 w-3" /> Sidecar live
      </Badge>
    );
  }
  // Offline: distinguish "never seen" from "stale" so the operator
  // knows whether to install the daemon or just wake their Mac.
  const tooltip = state.everSeen
    ? `Last poll ${state.ageMs != null ? Math.round(state.ageMs / 60_000) + "m" : "?"} ago — Mac may be asleep, daemon crashed, or Claude Code closed without launchd handoff. find-buy-in is using its server-side fallback paths instead.`
    : "Local Mac daemon never connected. find-buy-in is using server-side fallbacks. Install instructions: ~/Downloads/vrbo-sidecar/README.md";
  return (
    <Badge
      className="gap-1 text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border-amber-400 cursor-help"
      title={tooltip}
    >
      <AlertCircle className="h-3 w-3" /> Sidecar offline
    </Badge>
  );
}

function LiveSearchSection({
  reservation,
  propertyId,
  slot,
}: {
  reservation: GuestyReservation;
  propertyId: number;
  slot: SlotInfo;
}) {
  const { toast } = useToast();
  const [recordTarget, setRecordTarget] = useState<LiveCandidate | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [searchStartedAtMs, setSearchStartedAtMs] = useState(() => Date.now());
  const [searchEnabled, setSearchEnabled] = useState(() => !slot.buyIn);

  // Server validates dates as YYYY-MM-DD; Guesty returns `checkIn` as a full
  // ISO timestamp (2026-06-13T01:00:00.000Z). Prefer the localized date-only
  // field when present, otherwise slice the first 10 chars of the ISO string.
  const toDateOnly = (s: string | undefined): string => {
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s.slice(0, 10);
  };
  const checkInYmd = toDateOnly(reservation.checkInDateLocalized ?? reservation.checkIn);
  const checkOutYmd = toDateOnly(reservation.checkOutDateLocalized ?? reservation.checkOut);
  useEffect(() => {
    if (!slot.buyIn) return;
    setSearchEnabled(false);
    void queryClient.cancelQueries({ queryKey: ["/api/operations/find-buy-in", propertyId, slot.bedrooms, checkInYmd, checkOutYmd] });
  }, [slot.buyIn?.id, propertyId, slot.bedrooms, checkInYmd, checkOutYmd]);

  // Auto-fires when the component mounts (i.e. when user clicks "Find buy-in").
  // No gating button — the whole point of the workflow is to see cheap live
  // options immediately without maintaining a manual portfolio of buy-ins.
  const { data, isLoading, isFetching, isError, error, dataUpdatedAt, isPlaceholderData } = useQuery<FindBuyInResponse>({
    queryKey: ["/api/operations/find-buy-in", propertyId, slot.bedrooms, checkInYmd, checkOutYmd, refreshNonce],
    queryFn: ({ signal }) => {
      const noCache = refreshNonce > 0 ? "&nocache=1" : "";
      return apiGetJson<FindBuyInResponse>(
        `/api/operations/find-buy-in?propertyId=${propertyId}&bedrooms=${slot.bedrooms}&checkIn=${checkInYmd}&checkOut=${checkOutYmd}${noCache}`,
        signal,
      );
    },
    enabled: searchEnabled && !!checkInYmd && !!checkOutYmd,
    staleTime: 0,
    refetchOnMount: "always",
    placeholderData: (previousData) => previousData,
  });
  const sidecarQueue = useSidecarQueueStatus(isLoading || isFetching || !!data);
  const liveSearchSidecarActive = isSidecarStatusForSearch(sidecarQueue.status, searchStartedAtMs);
  const refreshLiveSearch = () => {
    setSearchStartedAtMs(Date.now());
    setRefreshNonce((n) => n + 1);
  };

  const hardErrorDiagnostics = useMemo<FindBuyInDiagnostics | null>(() => {
    if (!isError || data) return null;
    const message = (error as Error | undefined)?.message ?? "Unknown search failure";
    const generatedAt = new Date().toISOString();
    const report = [
      "Find buy-in diagnostic report",
      `Generated: ${generatedAt}`,
      `Request: propertyId=${propertyId}; reservation=${reservation._id}; slot=${slot.unitId}; bedrooms=${slot.bedrooms}; checkIn=${checkInYmd}; checkOut=${checkOutYmd}`,
      "Severity: error",
      `Summary: Search request failed before returning source-level results.`,
      "",
      "Issues:",
      `- [error] Find buy-in request: ${message}`,
    ].join("\n");
    return {
      severity: "error",
      title: "Search failed before results returned",
      summary: message,
      generatedAt,
      request: { propertyId, bedrooms: slot.bedrooms, checkIn: checkInYmd, checkOut: checkOutYmd },
      sources: [],
      issues: [{ severity: "error", source: "Find buy-in request", summary: message }],
      report,
    };
  }, [isError, data, error, propertyId, reservation._id, slot.unitId, slot.bedrooms, checkInYmd, checkOutYmd]);
  const searchDiagnostics = data?.diagnostics ?? hardErrorDiagnostics;
  const diagnosticKey = searchDiagnostics
    ? [
      propertyId,
      slot.bedrooms,
      checkInYmd,
      checkOutYmd,
      searchDiagnostics.generatedAt,
      searchDiagnostics.severity,
    ].join("|")
    : "";
  useEffect(() => {
    if (!searchDiagnostics || searchDiagnostics.severity === "ok" || !diagnosticKey) return;
    if (autoOpenedSearchDiagnosticKeys.has(diagnosticKey)) return;
    autoOpenedSearchDiagnosticKeys.add(diagnosticKey);
    setDiagnosticsOpen(true);
  }, [searchDiagnostics, diagnosticKey]);

  const attachedElsewhereKeys = useMemo(() => new Set(
    reservation.slots
      .filter((s) => s.unitId !== slot.unitId)
      .map((s) => listingUrlKey(s.buyIn?.airbnbListingUrl))
      .filter(Boolean),
  ), [reservation.slots, slot.unitId]);

  const isAttachedElsewhere = (url: string | null | undefined): boolean => {
    const key = listingUrlKey(url);
    return !!key && attachedElsewhereKeys.has(key);
  };

  const copySafeSearchLog = async (status: "success" | "error") => {
    const log = buildBuyInSearchDebugLog({
      status,
      request: {
        propertyId,
        reservationId: reservation._id,
        unitId: slot.unitId,
        unitLabel: slot.unitLabel,
        bedrooms: slot.bedrooms,
        checkIn: checkInYmd,
        checkOut: checkOutYmd,
        uiState: {
          isFetching,
          isPlaceholderData,
          dataUpdatedAt: dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null,
          sidecarQueue: sidecarQueue.status,
        },
      },
      response: data ?? null,
      error: status === "error" ? error : undefined,
    });

    try {
      await navigator.clipboard.writeText(log);
      if (searchDiagnostics && searchDiagnostics.severity !== "ok") {
        setDiagnosticsOpen(true);
      }
      toast({ title: "Safe debug log copied", description: "Raw URLs and secrets were redacted; cache state is included." });
    } catch {
      toast({ title: "Could not copy debug log", variant: "destructive" });
    }
  };

  // Dead-code preserved for reference — used to gate on a button click
  if (false as boolean) {
    return (
      <div className="border rounded-lg p-4 bg-blue-50 dark:bg-blue-950/20">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="font-medium text-sm flex items-center gap-1.5">
              <Globe className="h-4 w-4" /> Live search
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Searches Airbnb (telemetry), Booking.com, and PM companies for {slot.bedrooms}BR+ rentals in the area
              covering {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}.
            </p>
          </div>
          <Button size="sm" onClick={() => setSearchEnabled(true)} data-testid="button-run-live-search">
            <Search className="h-3.5 w-3.5 mr-1.5" /> Search now
          </Button>
        </div>
      </div>
    );
  }

  if (!searchEnabled && slot.buyIn) {
    return (
      <div className="border rounded-lg p-4 text-sm bg-background flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-medium text-sm">Buy-in attached</p>
          <p className="text-xs text-muted-foreground truncate">
            {fmtMoney(slot.buyIn.costPaid)} · {sourceLabelForUrl(slot.buyIn.airbnbListingUrl)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setSearchStartedAtMs(Date.now());
            setRefreshNonce((n) => n + 1);
            setSearchEnabled(true);
          }}
        >
          <Search className="h-3.5 w-3.5 mr-1" /> Run audit search
        </Button>
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="border rounded-lg p-6 text-sm text-muted-foreground space-y-4">
        <div className="text-center">
          <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
          Searching Airbnb (for photo matches), Booking.com, Vrbo, and property management companies for the cheapest {slot.bedrooms}BR+ rental covering {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}…
        </div>
        <SidecarQueueProgress
          status={sidecarQueue.status}
          label="Chrome sidecar verification"
          forceVisible
        />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <>
        <div className="border rounded-lg p-4 text-sm text-destructive flex items-center justify-between gap-3 flex-wrap">
          <span>
            <AlertCircle className="h-4 w-4 inline mr-1" /> Search failed: {(error as Error).message}
          </span>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setDiagnosticsOpen(true)}>
              <FileText className="h-3.5 w-3.5 mr-1" /> Error log
            </Button>
            <Button size="sm" variant="outline" onClick={() => copySafeSearchLog("error")}>
              <Copy className="h-3.5 w-3.5 mr-1" /> Copy Safe Log
            </Button>
            <Button size="sm" variant="outline" onClick={refreshLiveSearch}>Retry</Button>
          </span>
        </div>
        {searchDiagnostics && (
          <SearchDiagnosticsDialog
            diagnostics={searchDiagnostics}
            open={diagnosticsOpen}
            onOpenChange={setDiagnosticsOpen}
            onCopySuccess={() => toast({ title: "Search log copied" })}
          />
        )}
      </>
    );
  }

  const airbnb  = data?.sources?.airbnb  ?? [];
  const vrbo    = data?.sources?.vrbo    ?? [];
  const booking = data?.sources?.booking ?? [];
  const pm      = data?.sources?.pm      ?? [];
  const cheapest = data?.cheapest        ?? [];
  const cheapestUnits = data?.cheapestUnits ?? [];
  const availableAirbnb = airbnb.filter((c) => !isAttachedElsewhere(c.url));
  const availableVrbo = vrbo.filter((c) => !isAttachedElsewhere(c.url));
  const availableBooking = booking.filter((c) => !isAttachedElsewhere(c.url));
  const availablePm = pm.filter((c) => !isAttachedElsewhere(c.url));
  const availableCheapest = cheapest.filter((c) => !isAttachedElsewhere(c.url));
  const availableCheapestUnits = cheapestUnits.filter((u) => {
    if (isAttachedElsewhere(u.primaryUrl)) return false;
    return !u.listings.some((l) => isAttachedElsewhere(l.url));
  });
  const focusedCheapestUnits = availableCheapestUnits.slice(0, 1);
  const additionalCheapestUnits = availableCheapestUnits.slice(1);
  const focusedCheapest = availableCheapest.slice(0, 1);
  const additionalCheapest = availableCheapest.slice(1);
  const hasFocusedRecommendation = focusedCheapestUnits.length > 0 || focusedCheapest.length > 0;
  const recommendationsReady = (data?.autoFillSafe ?? data?.diagnostics?.severity === "ok") && !isFetching && !isPlaceholderData;
  const hasCurrentFocusedRecommendation = hasFocusedRecommendation && recommendationsReady;
  const lastScanLabel = data?.diagnostics?.generatedAt
    ? new Date(data.diagnostics.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : dataUpdatedAt
      ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
      : null;
  const hiddenAlreadyAttachedCount =
    (airbnb.length - availableAirbnb.length)
    + (vrbo.length - availableVrbo.length)
    + (booking.length - availableBooking.length)
    + (pm.length - availablePm.length);
  // PR #337: per-PM-source breakdown so the operator can see at a glance
  // which scrapers contributed and which came up empty (vs. wondering
  // whether we even searched them). Server populates one entry per
  // PM scraper attempted, regardless of result count.
  const pmSourceBreakdown: Array<{ label: string; count: number }> =
    (data as any)?.pmSourceBreakdown ?? [];

  // Map a unit's primary listing back to a LiveCandidate so the existing
  // record-buy-in dialog can keep its current contract. PRs #275+ will
  // pass channel-specific listings instead, but until then the dialog
  // reads from a single LiveCandidate.
  const unitToCandidate = (u: LiveUnit, listing: LiveUnitListing): LiveCandidate => {
    return {
      source: listing.channel,
      sourceLabel: listing.channelLabel,
      title: u.unitTitle,
      url: listing.url,
      nightlyPrice: listing.nightlyPrice,
      totalPrice: listing.totalPrice,
      bedrooms: listing.bedrooms ?? u.bedrooms,
      image: u.image,
      verified: listing.verified,
      verifiedReason: listing.verifiedReason,
    };
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Live results — {data?.resortName ?? data?.community} · {slot.bedrooms}BR+ · {data?.nights} nights
          </p>
          {data?.resortName && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Only listings within <b>{data.resortName}</b> are shown.
            </p>
          )}
          {lastScanLabel && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Last completed scan {lastScanLabel}
              {data?.fromCache ? ` · server cache ${data.cacheAgeSec ?? "?"}s old` : ""}
              {isPlaceholderData || (isFetching && data) ? " · refreshing now" : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SidecarStatusBadge />
          <Button size="sm" variant="ghost" onClick={refreshLiveSearch}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => copySafeSearchLog("success")}>
            <Copy className="h-3.5 w-3.5 mr-1" /> Copy Safe Log
          </Button>
        </div>
      </div>
      {(isFetching || liveSearchSidecarActive) && (
        <SidecarQueueProgress
          status={sidecarQueue.status}
          label={isFetching ? "Refreshing live rates" : "Chrome sidecar verification"}
          forceVisible={isFetching}
        />
      )}
      {isError && data && (
        <div className="border border-amber-300 bg-amber-50/70 text-amber-800 rounded-md px-3 py-2 text-[11px] flex items-center justify-between gap-2">
          <span>
            Latest refresh failed: {(error as Error).message}. Showing the last completed scan.
          </span>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={refreshLiveSearch}>Retry</Button>
        </div>
      )}
      {searchDiagnostics && searchDiagnostics.severity !== "ok" && (
        <div className="border border-amber-300 bg-amber-50/70 text-amber-900 rounded-md px-3 py-2 text-[11px] flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span>{searchDiagnostics.summary}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px] shrink-0"
            onClick={() => setDiagnosticsOpen(true)}
          >
            View log
          </Button>
        </div>
      )}
      {hiddenAlreadyAttachedCount > 0 && (
        <div className="border border-amber-300 bg-amber-50/70 text-amber-800 rounded-md px-3 py-2 text-[11px]">
          Hidden {hiddenAlreadyAttachedCount} option{hiddenAlreadyAttachedCount === 1 ? "" : "s"} already attached to another unit in this reservation.
        </div>
      )}
      {/* Raw hit counts + drop counts per source — lets us see why a source
          returned few results (upstream empty vs resort/bedroom filtered).
          PR #340: pm count now sums every per-PM scraper from
          pmSourceBreakdown rather than just the (legacy) Google-PM
          rawCount, which was always 0 since we deprecated the
          Google-PM path in PR #315. */}
      {data?.debug?.rawCounts && (
        <div className="text-[11px] text-muted-foreground -mt-1 space-y-0.5">
          <div>
            Raw: airbnb site {data.debug.rawCounts.airbnb ?? 0} · airbnb priced {data.debug.rawCounts.airbnbEngine ?? 0} · vrbo {data.debug.rawCounts.vrbo ?? 0} · booking {data.debug.rawCounts.booking ?? 0} · pm {pmSourceBreakdown.reduce((a, s) => a + (s.count ?? 0), 0)}
            {pmSourceBreakdown.length > 0 && (
              <> ({pmSourceBreakdown.filter((s) => s.count > 0).length}/{pmSourceBreakdown.length} PM sources had results)</>
            )}
            {typeof (data.debug.rawCounts as any).photoMatches === "number" && (
              <> · photo-matches {(data.debug.rawCounts as any).photoMatches}</>
            )}
          </div>
          {data.debug.dropped && (
            <div>
              Dropped (wrong resort / bedrooms):
              {" "}airbnb {data.debug.dropped.airbnb?.noResort ?? 0}/{data.debug.dropped.airbnb?.wrongBedrooms ?? 0} ·
              {" "}vrbo {data.debug.dropped.vrbo?.noResort ?? 0}/{data.debug.dropped.vrbo?.wrongBedrooms ?? 0} ·
              {" "}booking {data.debug.dropped.booking?.noResort ?? 0}/{data.debug.dropped.booking?.wrongBedrooms ?? 0}
            </div>
          )}
        </div>
      )}

      {/* Cheapest callout — gated server-side on verified=yes (real
          availability + real per-night rate confirmed for these dates).
          When the verify pass came back empty, show a clear "no
          verified options" state rather than promoting un-verified
          inherited-price rows. */}
      {recommendationsReady && availableCheapestUnits.length > 0 ? (
        <div className="border-2 border-green-500 rounded-lg p-3 bg-green-50/50 dark:bg-green-950/20">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide flex items-center gap-1.5">
                <TrendingDown className="h-3.5 w-3.5" />
                Best option for {slot.unitLabel}
              </p>
              <p className="text-[11px] text-green-700/80 mt-0.5">
                Showing the cheapest verified unit first
                {additionalCheapestUnits.length > 0 ? ` · ${additionalCheapestUnits.length} more available below` : ""}
                {data?.debug?.verification?.attempted ? ` · bookable for ${checkInYmd} → ${checkOutYmd}` : ""}
              </p>
            </div>
            <Badge className="text-[10px] bg-green-600 text-white shrink-0">Focused</Badge>
          </div>
          <div className="space-y-2">
            {focusedCheapestUnits.map((u, i) => (
              <UnitRow
                key={`unit-${i}-${u.primaryUrl}`}
                unit={u}
                onRecord={(listing) => setRecordTarget(unitToCandidate(u, listing))}
                highlight
                showImageSearch
                resortName={data?.resortName ?? null}
                community={data?.community}
              />
            ))}
          </div>
          {additionalCheapestUnits.length > 0 && (
            <details className="mt-2 rounded-md border border-green-200 bg-white/60 dark:bg-background/40">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-green-800 flex items-center justify-between gap-2">
                <span>Show {additionalCheapestUnits.length} more verified option{additionalCheapestUnits.length === 1 ? "" : "s"}</span>
                <span className="text-green-700/70">audit only</span>
              </summary>
              <div className="border-t border-green-100 p-2 space-y-2 max-h-[520px] overflow-y-auto">
                {additionalCheapestUnits.map((u, i) => (
                  <UnitRow
                    key={`unit-more-${i}-${u.primaryUrl}`}
                    unit={u}
                    onRecord={(listing) => setRecordTarget(unitToCandidate(u, listing))}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      ) : recommendationsReady && availableCheapest.length > 0 ? (
        // Backwards-compat fallback for old deploys that don't return
        // cheapestUnits — render the flat list as before.
        <div className="border-2 border-green-500 rounded-lg p-3 bg-green-50/50 dark:bg-green-950/20">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide flex items-center gap-1.5">
                <TrendingDown className="h-3.5 w-3.5" />
                Best option for {slot.unitLabel}
              </p>
              <p className="text-[11px] text-green-700/80 mt-0.5">
                Showing the cheapest verified option first
                {additionalCheapest.length > 0 ? ` · ${additionalCheapest.length} more available below` : ""}
                {data?.debug?.verification?.attempted ? ` · ${data.debug.verification.yes} verified for ${checkInYmd} → ${checkOutYmd}` : ""}
              </p>
            </div>
            <Badge className="text-[10px] bg-green-600 text-white shrink-0">Focused</Badge>
          </div>
          <div className="space-y-2">
            {focusedCheapest.map((c, i) => (
              <LiveRow
                key={`cheapest-${i}-${c.url}`}
                c={c}
                onRecord={() => setRecordTarget(c)}
                highlight
                showImageSearch
                resortName={data?.resortName ?? null}
                community={data?.community}
              />
            ))}
          </div>
          {additionalCheapest.length > 0 && (
            <details className="mt-2 rounded-md border border-green-200 bg-white/60 dark:bg-background/40">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-green-800 flex items-center justify-between gap-2">
                <span>Show {additionalCheapest.length} more verified option{additionalCheapest.length === 1 ? "" : "s"}</span>
                <span className="text-green-700/70">audit only</span>
              </summary>
              <div className="border-t border-green-100 p-2 space-y-2 max-h-[520px] overflow-y-auto">
                {additionalCheapest.map((c, i) => (
                  <LiveRow key={`cheapest-more-${i}-${c.url}`} c={c} onRecord={() => setRecordTarget(c)} />
                ))}
              </div>
            </details>
          )}
        </div>
      ) : (
        <div className="border-2 border-dashed border-amber-400 rounded-lg p-3 bg-amber-50/50 dark:bg-amber-950/20">
          <p className="text-xs font-semibold text-amber-700 mb-1 uppercase tracking-wide flex items-center gap-1.5">
            <TrendingDown className="h-3.5 w-3.5" />
            No verified bookable options
          </p>
          <p className="text-[11px] text-amber-700/90">
            {hasFocusedRecommendation && !recommendationsReady
              ? "This scan is still refreshing or completed with warnings, so verified candidates are audit-only for now. Auto-fill will not attach from this result. Open the diagnostics log or refresh once the slow source settles."
              : data?.debug?.verification?.available === false
              ? "No source returned a live priced, verified option during this scan. All scanned options are listed below with their automatic verification state."
              : data?.debug?.verification?.attempted
                ? `Tried to verify ${data.debug.verification.attempted} top-priced candidates: ${data.debug.verification.yes} bookable, ${data.debug.verification.no} unavailable, ${data.debug.verification.unclear} unclear. Browse all scanned options below.`
                : "No priced PM/Booking candidates surfaced for these dates and bedrooms. Browse all scanned options below or click 'Refresh'."}
          </p>
        </div>
      )}

      {/* Sortable table of every scanned option across all sources. Auto-fill
          picks `cheapest[0]` (the highlighted ⭐ row) — this table is the
          audit trail so the operator can see what else was scanned and
          override with one click. */}
      <details open={!hasCurrentFocusedRecommendation}>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground flex items-center gap-2 py-1.5">
          <Badge className="text-[10px] bg-slate-100 text-slate-700 border border-slate-300">
            All scanned options
          </Badge>
          <span>
            {availableAirbnb.length + availableVrbo.length + availableBooking.length + availablePm.length} rows
            {hasCurrentFocusedRecommendation ? " hidden below the best pick" : ""}
          </span>
        </summary>
        <div className="mt-1.5">
          <ScannedOptionsTable
            airbnb={availableAirbnb}
            vrbo={availableVrbo}
            booking={availableBooking}
            pm={availablePm}
            autoPickUrl={availableCheapestUnits[0]?.primaryUrl ?? availableCheapest[0]?.url}
            checkIn={checkInYmd}
            checkOut={checkOutYmd}
            onRecord={(c) => setRecordTarget(c)}
          />
        </div>
      </details>

      {/* By-source sections.
          Airbnb stays as telemetry + photo source (the reverse-image PM
          matches under each row are bookable). Vrbo rows are now
          sidecar-priced only — raw Google/manual-quote rows are filtered
          server-side. Booking.com + PM Companies are the direct-bookable
          channels — both ALWAYS open. */}
      {[
        { key: "airbnb",  label: "Airbnb (telemetry — see PM matches below each row)", items: availableAirbnb,  defaultOpen: !hasCurrentFocusedRecommendation && availableAirbnb.length > 0 && availableAirbnb.length <= 3 },
        { key: "vrbo",    label: "Vrbo (sidecar-priced)", items: availableVrbo, defaultOpen: !hasCurrentFocusedRecommendation && availableVrbo.length > 0 },
        { key: "booking", label: "Booking.com",   items: availableBooking, defaultOpen: !hasCurrentFocusedRecommendation },
        { key: "pm",      label: "PM Companies", items: availablePm, defaultOpen: !hasCurrentFocusedRecommendation },
      ].map((s) => (
        <details key={s.key} open={s.defaultOpen}>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground flex items-center gap-2 py-1.5">
            <Badge className={`text-[10px] ${sourceBadgeClass(s.key)}`}>{s.label}</Badge>
            <span>{s.items.length} results</span>
          </summary>
          {/* PR #337: PM-source coverage panel. Lists every PM scraper
              we tried plus its count, so the operator can see we DID
              search Suite Paradise / Parrish Kauai / Alekona / etc.
              even when a particular community/window has no available
              units in that PM's inventory. Only renders for the PM
              section. */}
          {s.key === "pm" && pmSourceBreakdown.length > 0 && (
            <div className="text-[11px] text-muted-foreground pl-2 pt-1 pb-2 flex flex-wrap gap-x-3 gap-y-0.5">
              <span className="font-medium">Searched:</span>
              {pmSourceBreakdown.map((src) => (
                <span key={src.label} className={src.count > 0 ? "text-foreground" : "opacity-60"}>
                  {src.label}: <span className={src.count > 0 ? "font-semibold" : ""}>{src.count}</span>
                </span>
              ))}
            </div>
          )}
          {s.items.length === 0 ? (
            <p className="text-xs text-muted-foreground pl-2 py-2">
              No results.
              {s.key === "pm" && " (Try clicking 'Open' on the top Airbnb row above — its reverse-image PM matches give you direct booking links even when this section is empty.)"}
            </p>
          ) : (
            <div className="space-y-2 mt-1.5 pl-2">
              {s.items.map((c, i) => (
                <LiveRow key={`${s.key}-${i}-${c.url}`} c={c} onRecord={() => setRecordTarget(c)} />
              ))}
            </div>
          )}
        </details>
      ))}

      {searchDiagnostics && (
        <SearchDiagnosticsDialog
          diagnostics={searchDiagnostics}
          open={diagnosticsOpen}
          onOpenChange={setDiagnosticsOpen}
          onCopySuccess={() => toast({ title: "Search log copied" })}
        />
      )}

      {recordTarget && (
        <RecordBuyInDialog
          candidate={recordTarget}
          reservation={reservation}
          propertyId={propertyId}
          slot={slot}
          onClose={() => setRecordTarget(null)}
        />
      )}
    </div>
  );
}

function diagnosticStatusClass(status: string) {
  switch (status) {
    case "ok":
      return "bg-emerald-100 text-emerald-800 border-emerald-300";
    case "error":
      return "bg-red-100 text-red-800 border-red-300";
    case "timeout":
      return "bg-orange-100 text-orange-800 border-orange-300";
    case "warning":
      return "bg-amber-100 text-amber-800 border-amber-300";
    case "skipped":
      return "bg-slate-100 text-slate-700 border-slate-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function SearchDiagnosticsDialog({
  diagnostics,
  open,
  onOpenChange,
  onCopySuccess,
}: {
  diagnostics: FindBuyInDiagnostics;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopySuccess?: () => void;
}) {
  const safeReport = sanitizeForChatText(diagnostics.report, { maxLength: 12_000 });
  const copyReport = async () => {
    await navigator.clipboard.writeText(safeReport);
    onCopySuccess?.();
  };
  const issueCount = diagnostics.issues?.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {diagnostics.title}
          </DialogTitle>
          <DialogDescription>
            This report stays available after you close the popup. Results underneath are still visible.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className={`rounded-md border px-3 py-2 text-sm ${diagnostics.severity === "error" ? "border-red-300 bg-red-50 text-red-900" : diagnostics.severity === "warning" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-emerald-300 bg-emerald-50 text-emerald-900"}`}>
            {diagnostics.summary}
          </div>

          {diagnostics.sources && diagnostics.sources.length > 0 && (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Raw</TableHead>
                    <TableHead className="text-right">Kept</TableHead>
                    <TableHead className="text-right">Priced</TableHead>
                    <TableHead className="text-right">Verified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diagnostics.sources.map((source) => (
                    <TableRow key={source.source}>
                      <TableCell>
                        <div className="font-medium">{source.source}</div>
                        {source.message && (
                          <div className="text-[11px] text-muted-foreground max-w-xl">{source.message}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${diagnosticStatusClass(source.status)}`}>
                          {source.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{source.raw ?? 0}</TableCell>
                      <TableCell className="text-right">{source.kept ?? 0}</TableCell>
                      <TableCell className="text-right">{source.priced ?? 0}</TableCell>
                      <TableCell className="text-right">{source.verified ?? 0}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {issueCount > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 mb-2">
                Issues
              </p>
              <div className="space-y-2">
                {diagnostics.issues!.map((issue, idx) => (
                  <div key={`${issue.source}-${idx}`} className="text-xs text-amber-950">
                    <span className="font-semibold">[{issue.severity}] {issue.source}:</span>{" "}
                    {issue.summary}
                    {issue.detail && <span className="text-amber-800"> — {issue.detail}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Copy-friendly safe report
              </p>
              <Button size="sm" variant="outline" onClick={copyReport}>
                <Copy className="h-3.5 w-3.5 mr-1" /> Copy safe log
              </Button>
            </div>
            <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 text-slate-50 p-3 text-[11px] whitespace-pre-wrap">
              {safeReport}
            </pre>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type SortKey = "source" | "title" | "total" | "nightly";
type SortDir = "asc" | "desc";

type VerifyState = {
  status: "idle" | "loading" | "yes" | "no" | "unclear" | "skipped" | "error";
  reason?: string;
  nightlyPriceUsd?: number | null;
};

function ScannedOptionsTable({
  airbnb,
  vrbo,
  booking,
  pm,
  autoPickUrl,
  checkIn,
  checkOut,
  onRecord,
}: {
  airbnb: LiveCandidate[];
  vrbo: LiveCandidate[];
  booking: LiveCandidate[];
  pm: LiveCandidate[];
  autoPickUrl: string | undefined;
  checkIn: string;
  checkOut: string;
  onRecord: (c: LiveCandidate) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [verifyByUrl, setVerifyByUrl] = useState<Record<string, VerifyState>>({});
  const [verifiedOnly, setVerifiedOnly] = useState<boolean>(true);
  const [autoVerifyState, setAutoVerifyState] = useState<"idle" | "running" | "done">("idle");

  const verifyOne = async (url: string) => {
    setVerifyByUrl((prev) => ({ ...prev, [url]: { status: "loading" } }));
    try {
      const r = await apiRequest("POST", "/api/buy-in-candidates/verify-availability", {
        url, checkIn, checkOut,
      });
      const j = await r.json();
      setVerifyByUrl((prev) => ({
        ...prev,
        [url]: {
          status: j.available ?? "unclear",
          reason: j.reason,
          nightlyPriceUsd: j.nightlyPriceUsd ?? null,
        },
      }));
    } catch (e: any) {
      setVerifyByUrl((prev) => ({
        ...prev,
        [url]: { status: "error", reason: e?.message ?? "request failed" },
      }));
    }
  };

  // Flatten all sources, dedupe by URL (some PM candidates also appear as
  // photo-matches under Airbnb rows; first writer wins so we keep the
  // top-level entry with its original source label).
  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: LiveCandidate[] = [];
    for (const c of [...airbnb, ...vrbo, ...booking, ...pm]) {
      if (!c.url || seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
    return out;
  }, [airbnb, vrbo, booking, pm]);

  // Auto-verify on load.
  //
  // Cost-discipline rules:
  //   - Trust server-side `verified=yes` rows from any source. The
  //     server already asked the source-specific engine/sidecar for a
  //     date-specific quote, so these rows should render as rated
  //     immediately instead of showing a manual verify/check button.
  //   - Airbnb engine rows are also trusted for backwards-compatible
  //     deploys that predate the `verified` field.
  //   - Verify queue only includes rows that the server did not already
  //     verify. Selection: top 10 cheapest priced unknowns.
  useEffect(() => {
    if (all.length === 0) return;
    if (autoVerifyState !== "idle") return;
    if (!checkIn || !checkOut) return;

    // Trust pre-verified server rows. Synchronous, free.
    setVerifyByUrl((prev) => {
      const next = { ...prev };
      for (const c of all) {
        if (next[c.url]) continue; // don't clobber existing state
        if (c.verified) {
          next[c.url] = {
            status: c.verified,
            reason: c.verifiedReason ?? "Server returned this listing with an availability outcome",
            nightlyPriceUsd: c.verifiedNightlyPrice ?? c.nightlyPrice ?? null,
          };
        } else if (c.source === "airbnb" && c.totalPrice > 0) {
          next[c.url] = {
            status: "yes",
            reason: "Airbnb engine returned this listing priced for these dates",
            nightlyPriceUsd: c.nightlyPrice || null,
          };
        }
      }
      return next;
    });

    // Build verify queue.
    const nonAirbnb = all.filter((c) => c.source !== "airbnb" && !c.verified);
    const pricedToVerify = nonAirbnb
      .filter((c) => c.totalPrice > 0)
      .sort((a, b) => a.totalPrice - b.totalPrice)
      .slice(0, 10)
      .map((c) => c.url);
    const toVerify = Array.from(new Set(pricedToVerify));

    if (toVerify.length === 0) {
      setAutoVerifyState("done");
      return;
    }

    setAutoVerifyState("running");
    // Mark each row as loading so the UI shows progress immediately.
    setVerifyByUrl((prev) => {
      const next = { ...prev };
      for (const url of toVerify) {
        if (!next[url]) next[url] = { status: "loading" };
      }
      return next;
    });

    (async () => {
      try {
        const r = await apiRequest("POST", "/api/buy-in-candidates/verify-availability-batch", {
          urls: toVerify, checkIn, checkOut,
        });
        const j = await r.json();
        const results = (j?.results ?? {}) as Record<string, { available: string; reason: string; nightlyPriceUsd: number | null }>;
        setVerifyByUrl((prev) => {
          const next = { ...prev };
          for (const [url, result] of Object.entries(results)) {
            next[url] = {
              status: (result.available as VerifyState["status"]) ?? "unclear",
              reason: result.reason,
              nightlyPriceUsd: result.nightlyPriceUsd ?? null,
            };
          }
          // Any URL we asked for but didn't get a result → unclear (server skipped it).
          for (const url of toVerify) {
            if (!results[url] && next[url]?.status === "loading") {
              next[url] = { status: "unclear", reason: "no result returned by batch verifier" };
            }
          }
          return next;
        });
      } catch (e: any) {
        // On failure, mark loaders as error so the operator can retry one-off.
        setVerifyByUrl((prev) => {
          const next = { ...prev };
          for (const url of toVerify) {
            if (next[url]?.status === "loading") {
              next[url] = { status: "error", reason: e?.message ?? "batch request failed" };
            }
          }
          return next;
        });
      } finally {
        setAutoVerifyState("done");
      }
    })();
  }, [all, autoVerifyState, checkIn, checkOut]);

  const sorted = useMemo(() => {
    const arr = [...all];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      // Un-priced rows always sink to the bottom regardless of direction —
      // they're the least actionable rows.
      if (sortKey === "total" || sortKey === "nightly") {
        const av = sortKey === "total" ? a.totalPrice : a.nightlyPrice;
        const bv = sortKey === "total" ? b.totalPrice : b.nightlyPrice;
        const aPriced = av > 0;
        const bPriced = bv > 0;
        if (aPriced && !bPriced) return -1;
        if (!aPriced && bPriced) return 1;
        if (!aPriced && !bPriced) return 0;
        return (av - bv) * dir;
      }
      if (sortKey === "source") return a.source.localeCompare(b.source) * dir;
      return a.title.localeCompare(b.title) * dir;
    });
    return arr;
  }, [all, sortKey, sortDir]);

  // Apply the verified-only filter. Keep rows whose verify status is
  // "yes" or "loading" (still being checked). Hide "no" / "unclear" /
  // "error" / "idle" — these are either confirmed-not-bookable or
  // never got verified, both unsafe to record.
  const visible = useMemo(() => {
    if (!verifiedOnly) return sorted;
    return sorted.filter((c) => {
      const v = verifyByUrl[c.url];
      if (!v) return false;
      return v.status === "yes" || v.status === "loading";
    });
  }, [sorted, verifiedOnly, verifyByUrl]);

  // Live "auto-pick" highlight — star the cheapest verified-yes priced
  // row. Falls back to the server's `cheapest[0]` (passed in via
  // autoPickUrl) until at least one row has verified, so the star is
  // always somewhere reasonable. After auto-verify settles, this lines
  // up with what auto-fill cheapest will actually attach (PR #243's
  // verified-pick logic in autoFillMutation).
  const livePickUrl = useMemo(() => {
    const verifiedPriced = sorted
      .filter((c) => c.totalPrice > 0 && verifyByUrl[c.url]?.status === "yes")
      .sort((a, b) => a.totalPrice - b.totalPrice);
    if (verifiedPriced.length > 0) return verifiedPriced[0].url;
    return autoPickUrl;
  }, [sorted, verifyByUrl, autoPickUrl]);

  const pricedCount = all.filter((c) => c.totalPrice > 0).length;
  const verifiedYesCount = sorted.filter((c) => verifyByUrl[c.url]?.status === "yes").length;
  const verifyingCount = sorted.filter((c) => verifyByUrl[c.url]?.status === "loading").length;
  const hiddenCount = sorted.length - visible.length;

  useEffect(() => {
    if (autoVerifyState !== "done") return;
    if (!verifiedOnly) return;
    if (all.length === 0) return;
    if (verifiedYesCount > 0 || verifyingCount > 0) return;
    setVerifiedOnly(false);
  }, [all.length, autoVerifyState, verifiedOnly, verifiedYesCount, verifyingCount]);

  if (all.length === 0) return null;

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "total" || key === "nightly" ? "asc" : "asc");
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 inline opacity-40" />;
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 inline" />
      : <ArrowDown className="h-3 w-3 inline" />;
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-muted/40 border-b flex items-center justify-between flex-wrap gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            All scanned options ({all.length} total · {pricedCount} priced · {verifiedYesCount} verified)
          </p>
          {autoVerifyState === "running" && verifyingCount > 0 && (
            <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
              <RefreshCw className="h-2.5 w-2.5 animate-spin" />
              Auto-verifying {verifyingCount} PM listing{verifyingCount === 1 ? "" : "s"} (Haiku, ~\$0.005 each)…
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
            />
            Verified only
            {verifiedOnly && hiddenCount > 0 && (
              <span className="text-muted-foreground">
                ({hiddenCount} hidden)
              </span>
            )}
          </label>
          <p className="text-[11px] text-muted-foreground">
            <Star className="h-3 w-3 inline fill-amber-400 text-amber-500 mr-0.5" />
            = auto-pick · click columns to sort
          </p>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8"></TableHead>
            <TableHead
              className="cursor-pointer select-none w-24 text-[11px]"
              onClick={() => toggleSort("source")}
            >
              Source <SortIcon col="source" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none text-[11px]"
              onClick={() => toggleSort("title")}
            >
              Listing <SortIcon col="title" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none w-24 text-right text-[11px]"
              onClick={() => toggleSort("total")}
            >
              Total <SortIcon col="total" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none w-20 text-right text-[11px]"
              onClick={() => toggleSort("nightly")}
            >
              /night <SortIcon col="nightly" />
            </TableHead>
            <TableHead className="w-32 text-[11px]">Anchor</TableHead>
            <TableHead className="w-24 text-[11px]">Avail</TableHead>
            <TableHead className="w-28 text-right text-[11px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 && verifiedOnly && (
            <TableRow>
              <TableCell colSpan={8} className="text-center py-6 text-xs text-muted-foreground">
                {autoVerifyState === "running"
                  ? "Verifying… visible rows will appear as Haiku confirms each."
                  : "No verified-available candidates yet. Toggle off \"Verified only\" to see all scanned options."}
              </TableCell>
            </TableRow>
          )}
          {visible.map((c) => {
            const isAutoPick = !!livePickUrl && c.url === livePickUrl;
            return (
              <TableRow
                key={c.url}
                className={isAutoPick ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}
              >
                <TableCell className="py-1.5">
                  {isAutoPick && (
                    <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
                  )}
                </TableCell>
                <TableCell className="py-1.5">
                  <Badge className={`text-[9px] ${sourceBadgeClass(c.source)}`}>
                    {c.sourceLabel}
                  </Badge>
                </TableCell>
                <TableCell className="py-1.5 max-w-0">
                  <p className="text-xs font-medium truncate">{c.title}</p>
                  {c.bedrooms ? (
                    <p className="text-[10px] text-muted-foreground">{c.bedrooms}BR</p>
                  ) : null}
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  {c.totalPrice > 0 ? (
                    <span className="text-xs font-semibold">{fmtMoney(c.totalPrice)}</span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground italic">—</span>
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  {c.nightlyPrice > 0 ? (
                    <span className="text-[11px] text-muted-foreground">{fmtMoney(c.nightlyPrice)}</span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground italic">—</span>
                  )}
                </TableCell>
                <TableCell className="py-1.5">
                  {c.airbnbAnchorUrl ? (
                    <a
                      href={c.airbnbAnchorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    >
                      <Camera className="h-2.5 w-2.5" />
                      Airbnb {c.airbnbAnchorPrice ? fmtMoney(c.airbnbAnchorPrice) : ""}
                    </a>
                  ) : null}
                </TableCell>
                <TableCell className="py-1.5">
                  <VerifyCell
                    state={verifyByUrl[c.url] ?? { status: "idle" }}
                    onVerify={() => verifyOne(c.url)}
                  />
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => window.open(c.url, "_blank", "noopener,noreferrer")}
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                    </Button>
                    <Button
                      size="sm"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => onRecord(c)}
                      disabled={!canRecordLiveResult(c)}
                      title={canRecordLiveResult(c) ? "Record this verified live rate" : "Record is disabled until a live date-specific rate is verified"}
                    >
                      <ShoppingCart className="h-2.5 w-2.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function VerifyCell({ state, onVerify }: { state: VerifyState; onVerify: () => void }) {
  if (state.status === "idle") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-slate-600 dark:text-slate-400"
        title="This row did not receive an automatic verification state in the last scan"
      >
        <AlertCircle className="h-3 w-3" />
        Not checked
      </span>
    );
  }
  if (state.status === "loading") {
    return (
      <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
        <RefreshCw className="h-2.5 w-2.5 animate-spin" /> Checking…
      </span>
    );
  }
  if (state.status === "yes") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-green-700 dark:text-green-400"
        title={state.reason}
      >
        <CheckCircle2 className="h-3 w-3" />
        {state.nightlyPriceUsd ? `Avail · ${fmtMoney(state.nightlyPriceUsd)}/n` : "Available"}
      </span>
    );
  }
  if (state.status === "no") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-red-700 dark:text-red-400"
        title={state.reason}
      >
        <AlertCircle className="h-3 w-3" />
        Not avail
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <button
        type="button"
        className="text-[10px] text-muted-foreground italic underline"
        title={state.reason}
        onClick={onVerify}
      >
        retry
      </button>
    );
  }
  if (state.status === "skipped") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-slate-600 dark:text-slate-400"
        title={state.reason}
      >
        <AlertCircle className="h-3 w-3" />
        Not checked
      </span>
    );
  }
  // unclear
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400"
      title={state.reason}
    >
      <AlertCircle className="h-3 w-3" />
      Unclear
    </span>
  );
}

function liveRateFallbackText(verified: LiveCandidate["verified"] | LiveUnitListing["verified"]): string {
  if (verified === "no") return "not available";
  if (verified === "unclear") return "no live rate found";
  if (verified === "skipped") return "not auto-checked";
  return "no live rate";
}

function canRecordLiveResult(item: { verified?: string; totalPrice?: number }): boolean {
  return item.verified === "yes" && (item.totalPrice ?? 0) > 0;
}

function ReverseImageListingLookup({
  imageUrl,
  sourceUrl,
  title,
  resortName,
  community,
}: {
  imageUrl?: string;
  sourceUrl?: string;
  title: string;
  resortName?: string | null;
  community?: string;
}) {
  const [state, setState] = useState<ReverseImageLookupState>({ status: "idle" });
  const isLoading = state.status === "loading";

  const runLookup = async () => {
    if (!imageUrl || isLoading) return;
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/operations/reverse-image-listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          imageUrl,
          sourceUrl,
          title,
          resortName,
          community,
          maxResults: 15,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || `Reverse image lookup failed (${response.status})`);
      }
      setState({
        status: "loaded",
        matches: Array.isArray(body?.matches) ? body.matches : [],
        fromCache: body?.fromCache === true,
      });
    } catch (e: any) {
      setState({ status: "error", message: e?.message ?? "Reverse image lookup failed" });
    }
  };

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/70 p-2 dark:border-slate-800 dark:bg-slate-950/20">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={runLookup}
          disabled={!imageUrl || isLoading}
          title={imageUrl ? "Find other listing sites from the first listing photo" : "No image available for reverse image search"}
          data-testid="button-reverse-image-listings"
        >
          {isLoading ? (
            <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Camera className="h-3 w-3 mr-1" />
          )}
          {isLoading ? "Searching..." : state.status === "loaded" ? "Refresh listing sites" : "Find listing sites"}
        </Button>
        {state.status === "loaded" && (
          <span className="text-[10px] text-muted-foreground">
            {state.matches.length} site{state.matches.length === 1 ? "" : "s"}{state.fromCache ? " · cached" : ""}
          </span>
        )}
      </div>

      {state.status === "error" && (
        <p className="mt-2 text-[11px] text-destructive">{state.message}</p>
      )}

      {state.status === "loaded" && (
        <div className="mt-2 rounded-md border bg-background p-1.5">
          {state.matches.length === 0 ? (
            <p className="px-1 py-1 text-[11px] text-muted-foreground">No other listing sites found from this image.</p>
          ) : (
            <div className="space-y-1">
              {state.matches.map((m, idx) => (
                <a
                  key={`${m.domain}-${idx}`}
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-[11px] hover:bg-muted/50 transition-colors"
                  data-testid={`reverse-image-listing-${idx}`}
                >
                  <Badge className={`text-[9px] shrink-0 ${sourceBadgeClass(m.platformKey)}`}>
                    {m.platform}
                  </Badge>
                  <span className="w-[110px] shrink-0 truncate font-medium text-muted-foreground" title={m.domain}>
                    {m.domain}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground" title={m.title}>
                    {m.title}
                  </span>
                  <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One row in the cheapest panel — represents a SINGLE physical unit
// with possibly multiple channel listings (Airbnb + VRBO + PM site).
// The row header shows the unit identity (title + bedrooms + thumb).
// Below it, each channel renders as a sub-row with its rate + Open
// + Record buttons. This is what the operator sees when the same
// unit cross-lists across OTAs and PM sites — instead of 3 separate
// rows competing for the cheapest slot, it's one unit with a
// transparent breakdown of where it's listed and at what price.
function UnitRow({
  unit,
  onRecord,
  highlight,
  showImageSearch,
  resortName,
  community,
}: {
  unit: LiveUnit;
  onRecord: (listing: LiveUnitListing) => void;
  highlight?: boolean;
  showImageSearch?: boolean;
  resortName?: string | null;
  community?: string;
}) {
  const verifiedListings = unit.listings.filter((l) => l.verified === "yes" && l.nightlyPrice > 0);
  const otherListings = unit.listings.filter((l) => !(l.verified === "yes" && l.nightlyPrice > 0));
  return (
    <div
      className={`border rounded-lg p-2.5 ${highlight ? "bg-white dark:bg-background" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        {unit.image && (
          <img src={unit.image} alt="" className="h-14 w-14 rounded object-cover shrink-0" />
        )}
        <div className="grow min-w-0">
          <p className="font-medium text-sm truncate" title={unit.unitTitle}>
            {unit.unitTitle}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {unit.bedrooms ? `${unit.bedrooms}BR · ` : ""}
            from <span className="font-semibold text-emerald-700">{fmtMoney(unit.minNightlyPrice)}/night</span>
            {" "}across {unit.listings.length} {unit.listings.length === 1 ? "listing" : "listings"}
          </p>
        </div>
      </div>

      {showImageSearch && (
        <ReverseImageListingLookup
          imageUrl={unit.image}
          sourceUrl={unit.primaryUrl}
          title={unit.unitTitle}
          resortName={resortName}
          community={community}
        />
      )}

      {/* Per-channel listings — verified bookable on top, then everything
          else (no/unclear/skipped). Each row has its own Open + Record
          so the operator can pick the channel they want to book through. */}
      <div className="mt-2 pt-2 border-t border-dashed border-border space-y-1">
        {[...verifiedListings, ...otherListings].map((l, idx) => (
          <div
            key={`${unit.primaryUrl}-listing-${idx}`}
            className="flex items-center gap-2 px-1 py-1 rounded hover:bg-muted/40 transition-colors"
          >
            <Badge className={`text-[9px] ${sourceBadgeClass(l.channel)} shrink-0`}>
              {l.channelLabel}
            </Badge>
            {l.verified === "yes" ? (
              <Badge className="text-[9px] bg-emerald-600 text-white shrink-0" title={l.verifiedReason ?? undefined}>
                ✓
              </Badge>
            ) : l.verified === "no" ? (
              <Badge className="text-[9px] bg-red-600 text-white shrink-0" title={l.verifiedReason ?? undefined}>
                ✗
              </Badge>
            ) : l.verified === "unclear" ? (
              <Badge className="text-[9px] bg-amber-500 text-white shrink-0" title={l.verifiedReason ?? undefined}>
                ?
              </Badge>
            ) : l.verified === "skipped" ? (
              <Badge className="text-[9px] bg-slate-500 text-white shrink-0" title={l.verifiedReason ?? undefined}>
                -
              </Badge>
            ) : null}
            <div className="grow min-w-0">
              {l.nightlyPrice > 0 ? (
                <p className="text-[12px]">
                  <span className="font-semibold">{fmtMoney(l.nightlyPrice)}</span>
                  <span className="text-muted-foreground">/night ({fmtMoney(l.totalPrice)} total)</span>
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground italic">{liveRateFallbackText(l.verified)}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] shrink-0"
              onClick={() => window.open(l.url, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="h-3 w-3 mr-1" /> Open
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[10px] shrink-0"
              onClick={() => onRecord(l)}
              disabled={!canRecordLiveResult(l)}
              title={canRecordLiveResult(l) ? "Record this verified live rate" : "Record is disabled until a live date-specific rate is verified"}
            >
              <ShoppingCart className="h-3 w-3 mr-1" /> Record
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveRow({
  c,
  onRecord,
  highlight,
  showImageSearch,
  resortName,
  community,
}: {
  c: LiveCandidate;
  onRecord: () => void;
  highlight?: boolean;
  showImageSearch?: boolean;
  resortName?: string | null;
  community?: string;
}) {
  const photoMatches = c.photoMatches ?? [];
  return (
    <div
      className={`border rounded-lg p-2.5 ${highlight ? "bg-white dark:bg-background" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        {c.image && (
          <img src={c.image} alt="" className="h-14 w-14 rounded object-cover shrink-0" />
        )}
        <div className="grow min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <Badge className={`text-[9px] ${sourceBadgeClass(c.source)}`}>{c.sourceLabel}</Badge>
            {c.verified === "yes" ? (
              <Badge className="text-[9px] bg-emerald-600 text-white" title={c.verifiedReason ?? undefined}>
                ✓ Verified bookable
              </Badge>
            ) : c.verified === "no" ? (
              <Badge className="text-[9px] bg-red-600 text-white" title={c.verifiedReason ?? undefined}>
                ✗ Not bookable
              </Badge>
            ) : c.verified === "unclear" ? (
              <Badge className="text-[9px] bg-amber-500 text-white" title={c.verifiedReason ?? undefined}>
                ? No live rate found
              </Badge>
            ) : c.verified === "skipped" ? (
              <Badge className="text-[9px] bg-slate-500 text-white" title={c.verifiedReason ?? undefined}>
                - Not auto-checked
              </Badge>
            ) : null}
            {c.bedrooms ? (
              <Badge variant="outline" className="text-[9px]">
                {c.bedrooms}BR
              </Badge>
            ) : null}
            <p className="font-medium text-sm truncate">{c.title}</p>
          </div>
          {c.snippet && <p className="text-[11px] text-muted-foreground line-clamp-2">{c.snippet}</p>}
        </div>
        <div className="text-right shrink-0 min-w-[80px]">
          {c.nightlyPrice > 0 ? (
            <>
              <p className="font-semibold text-sm">{fmtMoney(c.totalPrice)}</p>
              <p className="text-[10px] text-muted-foreground">{fmtMoney(c.nightlyPrice)}/night</p>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground italic">{liveRateFallbackText(c.verified)}</p>
          )}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => window.open(c.url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="h-3 w-3 mr-1" /> Open
          </Button>
          {/* Record is always available — even if price is unknown you can
              enter it manually in the dialog after you negotiate with the PM. */}
          <Button
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={onRecord}
            disabled={!canRecordLiveResult(c)}
            title={canRecordLiveResult(c) ? "Record this verified live rate" : "Record is disabled until a live date-specific rate is verified"}
          >
            <ShoppingCart className="h-3 w-3 mr-1" /> Record
          </Button>
        </div>
      </div>
      {showImageSearch && (
        <ReverseImageListingLookup
          imageUrl={c.image}
          sourceUrl={c.url}
          title={c.title}
          resortName={resortName}
          community={community}
        />
      )}
      {/* Reverse-image matches: when this candidate's photo also appears
          on a non-OTA site, surface those URLs so the operator can click
          through to the property-management company that has the same
          unit listed for direct (commercial-OK) booking. Only set on
          the top 2 Airbnb candidates server-side; absent everywhere
          else (the conditional below skips render for empty arrays). */}
      {photoMatches.length > 0 && (
        <div className="mt-2 pt-2 border-t border-dashed border-border">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 font-semibold">
            Same photo also at — bookable for commercial use
          </p>
          <div className="space-y-1">
            {photoMatches.map((m, idx) => (
              <a
                key={`${c.url}-match-${idx}`}
                href={m.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-2 py-1 text-[11px] rounded hover:bg-muted/50 transition-colors"
                data-testid={`photo-match-${idx}`}
              >
                <Badge className="text-[9px] bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-300">
                  {m.domain}
                </Badge>
                <span className="truncate flex-1 text-foreground">{m.title}</span>
                <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Dialog: per-slot on-demand "verify rate" against the buy-in's PM URL.
// Calls /api/operations/verify-pm-listing (Playwright + Claude vision),
// shows the screenshot inline, and lets the operator either accept the
// extracted price or type a manual cost. Decoupled from auto-fill so a
// slow/hung verify never blocks the broader flow.
function VerifyRateDialog({
  buyIn,
  reservationCheckIn,
  reservationCheckOut,
  onClose,
}: {
  buyIn: BuyIn;
  reservationCheckIn: string;
  reservationCheckOut: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  type Extracted = {
    isUnitPage?: boolean;
    available?: boolean | null;
    totalPrice?: number | null;
    nightlyPrice?: number | null;
    dateMatch?: boolean | null;
    reason?: string;
  };
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; screenshot: string | null; extracted: Extracted | null; reason?: string; manualOnly?: boolean }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [manualCost, setManualCost] = useState("");
  const manualPm = manualOnlyPmForUrl(buyIn.airbnbListingUrl);

  const toDateOnly = (s: string): string =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.slice(0, 10);
  const ci = toDateOnly(reservationCheckIn);
  const co = toDateOnly(reservationCheckOut);

  // Kick off the verify call once when the dialog mounts.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);
    (async () => {
      try {
        const resp = await fetch("/api/operations/verify-pm-listing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            url: buyIn.airbnbListingUrl,
            checkIn: ci,
            checkOut: co,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (cancelled) return;
        if (!resp.ok) {
          setState({ kind: "error", message: `Server returned ${resp.status}` });
          return;
        }
        const data = await resp.json();
        if (cancelled) return;
        setState({
          kind: "loaded",
          screenshot: data?.screenshotBase64 ?? null,
          extracted: data?.extracted ?? null,
          reason: data?.reason,
          manualOnly: data?.manualOnly === true,
        });
        if (data?.extracted?.totalPrice && data.extracted.totalPrice > 0) {
          setManualCost(String(data.extracted.totalPrice));
        }
      } catch (e: any) {
        clearTimeout(timeoutId);
        if (cancelled) return;
        setState({
          kind: "error",
          message: e?.name === "AbortError" ? "Verify timed out (90s)" : (e?.message ?? "Network error"),
        });
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
    // Only run once on mount — buyIn.id is stable for the dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateCost = useMutation({
    mutationFn: (cost: number) =>
      apiRequest("PATCH", `/api/buy-ins/${buyIn.id}`, { costPaid: cost.toFixed(2) }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing"] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      toast({ title: "Cost updated" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const sourceHost = sourceLabelForUrl(buyIn.airbnbListingUrl);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Verify rate — {sourceHost}</DialogTitle>
          <DialogDescription>
            Loading {sourceHost} for {fmtDate(ci)} → {fmtDate(co)}, taking a screenshot, and asking Claude to read the price off the page.
          </DialogDescription>
        </DialogHeader>

        {state.kind === "loading" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              This usually takes 10-60s — PM sites with read-only date pickers are slow.
            </p>
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <p className="font-medium text-destructive">Verify failed</p>
            <p className="text-muted-foreground mt-1">{state.message}</p>
            <p className="text-xs text-muted-foreground mt-2">
              You can still click the link in the slot row to load the page yourself, then type the cost below.
            </p>
          </div>
        )}

        {state.kind === "loaded" && state.manualOnly && manualPm && (
          <div className="space-y-3">
            <div className="rounded-md border-2 border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                {manualPm.name} does not expose an automatic rate
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300">
                {state.extracted?.reason ?? `${manualPm.name}'s public site doesn't display rates inline. Their booking flow is a contact form (reCAPTCHA-protected) that emails their team for a quote.`}
              </p>
              {manualPm.phone && (
                <p className="text-sm">
                  <span className="text-muted-foreground">Call: </span>
                  <a
                    href={`tel:${manualPm.phone.replace(/[^\d+]/g, "")}`}
                    className="font-mono font-semibold text-amber-900 dark:text-amber-200 underline"
                  >
                    {manualPm.phone}
                  </a>
                </p>
              )}
              {manualPm.emailUrl && (
                <p className="text-xs">
                  <span className="text-muted-foreground">Or fill their inquiry form: </span>
                  <a
                    href={manualPm.emailUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline hover:no-underline"
                  >
                    Request Info <ExternalLink className="h-2.5 w-2.5 inline" />
                  </a>
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="verify-cost" className="text-xs">
                Once you have the quote, enter the buy-in cost (USD)
              </Label>
              <Input
                id="verify-cost"
                type="number"
                inputMode="decimal"
                value={manualCost}
                onChange={(e) => setManualCost(e.target.value)}
                placeholder="e.g. 4500"
                min="0"
                step="0.01"
              />
            </div>
          </div>
        )}
        {state.kind === "loaded" && !(state.manualOnly && manualPm) && (
          <div className="space-y-3">
            {/* Extracted info badges */}
            <div className="flex items-center gap-2 flex-wrap text-xs">
              {state.extracted?.isUnitPage === true && (
                <Badge className="bg-green-100 text-green-800">Unit page</Badge>
              )}
              {state.extracted?.isUnitPage === false && (
                <Badge variant="outline">Not a unit page</Badge>
              )}
              {state.extracted?.dateMatch === true && (
                <Badge className="bg-green-100 text-green-800">Dates loaded</Badge>
              )}
              {state.extracted?.dateMatch === false && (
                <Badge variant="outline">Dates not entered</Badge>
              )}
              {state.extracted?.available === true && (
                <Badge className="bg-green-100 text-green-800">Available</Badge>
              )}
              {state.extracted?.available === false && (
                <Badge variant="destructive">Unavailable</Badge>
              )}
              {typeof state.extracted?.totalPrice === "number" && state.extracted.totalPrice > 0 && (
                <Badge className="bg-blue-100 text-blue-800">
                  ${state.extracted.totalPrice.toLocaleString()} total
                  {state.extracted.nightlyPrice ? ` · $${state.extracted.nightlyPrice}/nt` : ""}
                </Badge>
              )}
            </div>
            {state.extracted?.reason && (
              <p className="text-xs text-muted-foreground italic">{state.extracted.reason}</p>
            )}

            {/* Screenshot */}
            {state.screenshot && (
              <div className="border rounded-md overflow-hidden">
                <img
                  src={state.screenshot}
                  alt="PM site screenshot"
                  className="w-full block"
                />
              </div>
            )}

            {/* Cost input */}
            <div className="space-y-1.5">
              <Label htmlFor="verify-cost" className="text-xs">
                Buy-in cost (USD)
              </Label>
              <Input
                id="verify-cost"
                type="number"
                inputMode="decimal"
                value={manualCost}
                onChange={(e) => setManualCost(e.target.value)}
                placeholder="e.g. 4500"
                min="0"
                step="0.01"
              />
              <p className="text-[11px] text-muted-foreground">
                Pre-filled from the extracted total when available. If the screenshot shows a price the bot missed, type it here.
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            onClick={() => {
              const n = parseFloat(manualCost);
              if (!isFinite(n) || n < 0) {
                toast({ title: "Enter a valid cost", variant: "destructive" });
                return;
              }
              updateCost.mutate(n);
            }}
            disabled={updateCost.isPending || state.kind === "loading"}
          >
            {updateCost.isPending ? "Saving..." : "Save cost"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Dialog: pre-fills the buy-in form with the live candidate's data, posts to
// /api/buy-ins, then attaches the new buy-in to the reservation slot.
function RecordBuyInDialog({
  candidate,
  reservation,
  propertyId,
  slot,
  onClose,
}: {
  candidate: LiveCandidate;
  reservation: GuestyReservation;
  propertyId: number;
  slot: SlotInfo;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [costPaid, setCostPaid] = useState(String(candidate.totalPrice || ""));
  const [confirmation, setConfirmation] = useState("");
  const [listingUrl, setListingUrl] = useState(candidate.url);
  const [notes, setNotes] = useState("");
  const duplicateSlot = useMemo(() => {
    const candidateKeys = new Set(listingIdentityKeys({
      url: listingUrl,
      title: candidate.title,
      image: candidate.image,
      airbnbAnchorUrl: candidate.airbnbAnchorUrl,
      alternateUrls: candidate.alternateUrls,
      photoMatches: candidate.photoMatches,
      identityKeys: candidate.identityKeys,
    }));
    if (candidateKeys.size === 0) return null;
    return reservation.slots.find(
      (s) => s.unitId !== slot.unitId
        && s.buyIn
        && listingIdentityKeys({
          url: s.buyIn.airbnbListingUrl,
          title: titleFromBuyInNotes(s.buyIn.notes),
        }).some((key) => candidateKeys.has(key)),
    ) ?? null;
  }, [candidate, listingUrl, reservation.slots, slot.unitId]);

  const toDateOnly = (s: string | undefined): string => {
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s.slice(0, 10);
  };

  const createAndAttach = useMutation({
    mutationFn: async () => {
      const body = {
        propertyId,
        unitId: slot.unitId,
        unitLabel: slot.unitLabel,
        bedrooms: slot.bedrooms,
        checkIn: toDateOnly(reservation.checkInDateLocalized ?? reservation.checkIn),
        checkOut: toDateOnly(reservation.checkOutDateLocalized ?? reservation.checkOut),
        costPaid: Number(costPaid).toFixed(2),
        airbnbConfirmation: confirmation || null,
        airbnbListingUrl: listingUrl || null,
        notes: notes || `Bought via ${candidate.sourceLabel} — ${candidate.title}`,
        status: "active",
      };
      const created = await apiRequest("POST", "/api/buy-ins", body).then((r) => r.json());
      if (!created?.id) throw new Error("Buy-in create failed");
      const attach = await apiRequest("POST", `/api/bookings/${reservation._id}/attach-buy-in`, {
        buyInId: created.id,
      }).then((r) => r.json());
      if (!attach?.id) throw new Error(attach?.error || "Attach failed");
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing"] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      toast({ title: "Buy-in recorded and attached" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record buy-in from {candidate.sourceLabel}</DialogTitle>
          <DialogDescription>
            Once you've actually booked it on {candidate.sourceLabel}, fill in the confirmation
            and save. This creates the buy-in and attaches it to {slot.unitLabel}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-xs bg-muted rounded p-2">
            <p className="font-medium truncate">{candidate.title}</p>
            <p className="text-muted-foreground">
              {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)} · {slot.unitLabel} ({slot.bedrooms} BR)
            </p>
          </div>
          <div>
            <Label htmlFor="costPaid" className="text-xs">Total cost paid (USD)</Label>
            <Input
              id="costPaid"
              type="number"
              step="0.01"
              value={costPaid}
              onChange={(e) => setCostPaid(e.target.value)}
              data-testid="input-cost-paid"
            />
          </div>
          <div>
            <Label htmlFor="confirmation" className="text-xs">Confirmation code</Label>
            <Input
              id="confirmation"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="HM4TZJTE8P"
              data-testid="input-confirmation"
            />
          </div>
          <div>
            <Label htmlFor="listingUrl" className="text-xs">Listing URL</Label>
            <Input
              id="listingUrl"
              value={listingUrl}
              onChange={(e) => setListingUrl(e.target.value)}
              data-testid="input-listing-url"
            />
            {duplicateSlot && (
              <p className="text-[11px] text-destructive mt-1">
                This listing is already attached to {duplicateSlot.unitLabel}. Pick a different physical unit for {slot.unitLabel}.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="notes" className="text-xs">Notes</Label>
            <Textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={`Bought via ${candidate.sourceLabel}`}
              data-testid="input-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => createAndAttach.mutate()}
            disabled={!costPaid || !!duplicateSlot || createAndAttach.isPending}
            data-testid="button-save-buy-in"
          >
            {createAndAttach.isPending ? "Saving…" : "Save & attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
