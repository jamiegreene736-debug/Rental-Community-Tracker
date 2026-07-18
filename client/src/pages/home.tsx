import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogDescription,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  Building2,
  BedDouble,
  DollarSign,
  Layers,
  Hammer,
  CalendarSearch,
  Plus,
  Trash2,
  MapPin,
  Star,
  TrendingUp,
  TrendingDown,
  Wallet,
  CheckCircle2,
  Ban,
  CreditCard,
  AlertTriangle,
  MessageSquare,
  PhoneMissed,
  Home as HomeIcon,
  Loader2,
  RefreshCw,
  Square,
  CheckSquare,
  StopCircle,
  Pause,
  Play,
  ExternalLink,
  History,
} from "lucide-react";
import { getActiveUnitBuilders, getAllUnitBuilders, getMultiUnitPropertyIds, getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import { occupancyForBedrooms } from "@/data/bedding-config";
import { isScannableFolder, replacementPhotoFolderRef } from "@shared/photo-folder-utils";
import { subThresholdVerifiedMatches } from "@shared/photo-listing-decision";
import { replacementPhotoFolderForUnit } from "@shared/unit-swap-photos";
import { inferCommunityStreetAddress } from "@shared/community-addresses";
import { UnitReplacementFlow, findLiveReplacementJobRef, type ReplacementUnitData } from "@/components/unit-replacement-flow";
import { draftUnitIdForSlot, isAutoReplacePhaseActive, type AutoReplaceJobRecord, type AutoReplacePhase } from "@shared/auto-replace-job-logic";
import { resolveCanonicalCommunityPhotoFolder } from "@shared/community-photo-folders";
import { useToast } from "@/hooks/use-toast";
import { extractBRList } from "@/data/quality-score";
import { getBuyInRate } from "@shared/pricing-rates";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { CommunityDraft, GuestyPropertyMap, ReservationCancellationAudit } from "@shared/schema";
import { resolveDraftUnitBedrooms } from "@shared/draft-unit-bedrooms";
import { photoCommunityStatusLabel, type PhotoCommunityRowStatus } from "@shared/photo-community-status-logic";
import { unitAuditBadge } from "@shared/unit-audit-sweep-logic";
import { UnitAuditDialog, type UnitAuditDashboardStatus } from "@/components/unit-audit-dialog";
import {
  guestyPushStatusForItem,
  summarizeBulkPricingGuestyPush,
  type GuestyPushProgress,
} from "@shared/bulk-pricing-push-logic";
import { selectBulkPricingJobToSurface } from "@shared/bulk-pricing-queue-surface";
import {
  distinctMatchedPhotoUrls,
  duplicatePhotoWarningSignature,
  formatDuplicatePhotoPlatforms,
  groupDuplicateListingLinksByUnit,
  groupLinksByPlatform,
  photoFilenameFromMatchUrl,
  photoReplaceRescanVerdict,
  DUPLICATE_PHOTO_PLATFORM_LABELS,
  type DuplicateLinkOwner,
  type DuplicatePhotoPlatform,
} from "@shared/duplicate-photo-warning";
import {
  ADDRESS_ALERT_PLATFORM_LABELS,
  addressAlertWarningSignature,
  addressFoundPlatforms,
  collectAddressAlertLinks,
  formatAddressAlertPlatforms,
  type AddressAlertPlatform,
  type AddressMatchRow,
} from "@shared/address-alert-warning";
import {
  paymentFailureWarningSignature,
  PAYMENT_ISSUE_KIND_LABELS,
  type PaymentFailureWarning,
} from "@shared/payment-failure-warning";
import {
  buyInCoverageWarningSignature,
  type BuyInCoverageWarning,
} from "@shared/buyin-coverage-warning";
import {
  arrivalDetailsWarningSignature,
  type ArrivalDetailsWarning,
} from "@shared/arrival-details-warning";
import { GuestyConnectDialog } from "@/components/GuestyConnectDialog";
import { RateChangeDisplay, RateChangesList } from "@/components/RateChangeDisplay";
import { usePortalSession } from "@/lib/auth";

const STATUS_LABELS: Record<string, string> = {
  researching: "Researching",
  draft_ready: "Draft Ready",
  active: "Active",
};

// `community` is the displayed complex name (Kaha Lani Resort, Regency at
// Poipu Kai, …) — kept in sync with `complexName` in unit-builder-data so
// the dashboard, builder, and PDF all agree on what to call a property.
// `pricingArea` is the lookup key for shared/pricing-rates BUY_IN_RATES
// and quality-score MARKET_RATE_PER_BR / LOCATION_DEMAND tables, which
// are keyed by area (Poipu Kai, Princeville, …) — multiple complexes
// can share an area, so the two fields stay separate. When adding a
// new property, set `community` to the specific complex and
// `pricingArea` to the area whose buy-in rates apply.
type Property = {
  id: number;
  // `draftId` is set when the row was sourced from a community
  // draft (`/api/community/drafts`) rather than the hard-coded
  // active list. `id` is then a synthetic negative number so
  // id-keyed caches (unit counts, baseRates, the `filtered`
  // sort) never collide with active property ids.
  draftId?: number;
  // Status pulled from the underlying community_drafts row.
  // "researching" / "draft_ready" → renders with DRAFT pill +
  // trash + Promote actions. "published" → renders as a regular
  // active row (no DRAFT pill, Build button targets the
  // builder via the synthetic negative id route). Active
  // hardcoded rows leave this undefined.
  draftStatus?: string;
  name: string;
  community: string;
  pricingArea: string;
  location: string;
  island: string;
  bedrooms: number;
  guests: number;
  bathrooms: number;
  lowPrice: number | null;
  highPrice: number | null;
  minimumStayNights?: number | null;
  minimumStayEvidence?: string | null;
  minimumStaySourceUrl?: string | null;
  minimumStayRangeLow?: number | null;
  minimumStayRangeHigh?: number | null;
  multiUnit: boolean;
  unitCount?: number;
  communityUnitCount?: number | null;
  communityUnitCountRangeLow?: number | null;
  communityUnitCountRangeHigh?: number | null;
  unitDetails: string;
  url: string;
  // When this listing was added into the system. Sourced from the
  // community_drafts row's `createdAt` for imported/draft rows (every
  // listing added via the wizard / bulk-combo queue / single-listing
  // flow). The 11 hard-coded core properties predate per-row tracking,
  // so they leave this undefined and render a "—" in the Added column.
  createdAt?: string | Date | null;
};

type BulkPhotoCommunityItemStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "cancelled";
type AutoFixActivityEvent = {
  id: number;
  jobId: string;
  propertyId: number | null;
  propertyName: string | null;
  unitId: string | null;
  unitLabel: string | null;
  origin: "operator" | "operator-audit" | "scheduled-audit" | "automatic-retry" | "legacy-recovery" | "unknown";
  status: "started" | "retry-scheduled" | "retry-started" | "succeeded" | "failed" | "skipped";
  attemptNumber: number;
  occurredAt: string;
  scheduledFor: string | null;
  message: string;
};

const AUTO_FIX_ACTIVITY_STATUS_LABELS: Record<AutoFixActivityEvent["status"], string> = {
  started: "Started",
  "retry-scheduled": "Retry scheduled",
  "retry-started": "Retry started",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
};

const AUTO_FIX_RETRY_STATUS_LABELS: Record<AutoFixActivityEvent["status"], string> = {
  started: "started",
  "retry-scheduled": "scheduled",
  "retry-started": "started",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "skipped",
};

const AUTO_FIX_ACTIVITY_STATUS_TONES: Record<AutoFixActivityEvent["status"], string> = {
  started: "border-blue-200 bg-blue-50 text-blue-700",
  "retry-scheduled": "border-violet-200 bg-violet-50 text-violet-700",
  "retry-started": "border-indigo-200 bg-indigo-50 text-indigo-700",
  succeeded: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-red-200 bg-red-50 text-red-700",
  skipped: "border-amber-200 bg-amber-50 text-amber-700",
};

const AUTO_FIX_ACTIVITY_ORIGIN_LABELS: Record<AutoFixActivityEvent["origin"], string> = {
  operator: "Dashboard action",
  "operator-audit": "Operator audit",
  "scheduled-audit": "Scheduled audit",
  "automatic-retry": "Automatic retry",
  "legacy-recovery": "Legacy recovery",
  unknown: "System",
};

const AUTO_REPLACE_PHASE_TONES: Record<AutoReplacePhase, string> = {
  queued: "bg-slate-100 text-slate-700 border-slate-200",
  finding: "bg-blue-50 text-blue-700 border-blue-200",
  committing: "bg-amber-50 text-amber-700 border-amber-200",
  verifying: "bg-sky-50 text-sky-700 border-sky-200",
  retry_wait: "bg-violet-50 text-violet-700 border-violet-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

type BulkPhotoCommunityJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested: boolean;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  items: Array<{
    propertyId: number;
    label: string;
    status: BulkPhotoCommunityItemStatus;
    startedAt: string | null;
    finishedAt: string | null;
    error?: string;
  }>;
};

type BulkPricingItemStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type BulkPricingJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type BulkPricingJob = {
  id: string;
  status: BulkPricingJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested: boolean;
  lockedBy?: string | null;
  lockExpiresAt?: string | null;
  currentIndex: number;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  dryRun?: boolean;
  items: Array<{
    id?: string;
    propertyId: number;
    label: string;
    status: BulkPricingItemStatus;
    startedAt: string | null;
    finishedAt: string | null;
    attemptCount?: number;
    heartbeatAt?: string | null;
    progress: {
      phase?: string;
      percent?: number;
      label?: string;
      error?: string;
      daemonOnline?: boolean;
      daemonLastPollAgeMs?: number | null;
      confidence?: {
        score?: number;
        level?: "green" | "yellow" | "red";
        summary?: string;
        acceptedCandidates?: number;
        rejectedCandidates?: number;
        sampleCount?: number;
        widened?: boolean;
        perBedroom?: Array<{
          bedrooms: number;
          score: number;
          level: "green" | "yellow" | "red";
          sampleCount: number;
          months?: number;
          geoKind?: "curated-bounds" | "center-radius" | "none" | null;
          geoRadiusMiles?: number | null;
          widened?: boolean;
        }>;
      } | null;
      pricingRecipe?: {
        community?: string;
        searchName?: string;
        percentileBasis?: number;
        unitCount?: number;
        searchedBedrooms?: number[];
        stayNights?: number;
        source?: string;
        resortConfident?: boolean;
        bedroomSplitInferred?: boolean;
      } | null;
      // Evidence-level "right community + right bedroom count" verdict computed
      // server-side from the persisted comp evidence when the item's refresh
      // lands (shared/market-rate-match-confirmation). Green only when the
      // evidence clears the 95%+ bar.
      matchConfirmation?: {
        verdict?: "verified" | "review" | "mismatch";
        level?: "green" | "yellow" | "red";
        headline?: string;
        reasons?: string[];
        comps?: number;
        bedroomVerifiedPct?: number | null;
        communityVerdict?: string;
        bedroomVerdict?: string;
      } | null;
      acceptedCandidates?: number;
      rejectedCandidates?: number;
      blackoutCount?: number;
      blackoutClosed?: number;
      rateChanges?: Array<{
        bedrooms: number;
        oldRate: string | number | null;
        newRate: string | number | null;
      }>;
      // Written by the server once the item's Guesty push resolves — the
      // per-property confirmation that rates actually landed on Guesty.
      guestyPush?: GuestyPushProgress;
    } | null;
    error: string | null;
  }>;
};

type QueueJobEventPayload = {
  id?: number;
  jobType?: string;
  jobId?: string;
  itemKey?: string | null;
  phase: string;
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown> | null;
  createdAt: string;
};

// "Clear queue" dismissals persist here so a bulk pricing queue that finished
// while the operator was away (phone locked / Safari closed) re-surfaces its
// terminal Guesty-push banner exactly once — and stays gone after dismissal,
// across reloads. Capped so the key can't grow unbounded.
const DISMISSED_BULK_PRICING_JOBS_KEY = "nexstay_dismissed_bulk_pricing_jobs";
function getDismissedBulkPricingJobIds(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_BULK_PRICING_JOBS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
function addDismissedBulkPricingJobId(jobId: string): void {
  try {
    const next = [...getDismissedBulkPricingJobIds().filter((id) => id !== jobId), jobId].slice(-20);
    window.localStorage.setItem(DISMISSED_BULK_PRICING_JOBS_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable (private mode) — dismissal just won't persist.
  }
}

// Parse street / city / state out of a property's display address — same
// tolerant split builder-preflight uses ("1831 Poipu Rd, Unit 423, Koloa, HI
// 96756" → street from parts[0], city/state from the last two segments), so
// the popup's Replace-photos flow feeds find-unit identical geo hints.
function parsePropertyDisplayAddress(addr: string): { street: string; city: string; state: string } {
  const parts = (addr || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return { street: addr || "", city: "", state: "" };
  const street = parts[0];
  let city = "";
  let state = "";
  if (parts.length >= 3) {
    city = parts[parts.length - 2];
    state = (parts[parts.length - 1].split(" ")[0] || "").trim();
  } else {
    city = parts[1];
    state = parts[2] ?? "";
  }
  return { street, city, state };
}

// Duplicate-photos warning popup: the signature of the currently-flagged
// units is stored on dismiss so the popup doesn't nag every page load, but
// re-raises whenever the facts change (new unit flagged, new platform, or a
// fresh scan re-confirming the duplicates — see duplicatePhotoWarningSignature).
const DUPLICATE_PHOTO_WARNING_DISMISSED_KEY = "nexstay_duplicate_photo_warning_dismissed";
const ADDRESS_ALERT_WARNING_DISMISSED_KEY = "nexstay_address_alert_warning_dismissed";

// Payment-failure warning popup (failed charge / overdue scheduled balance):
// same dismissal pattern — signature persisted on dismiss, re-raised when the
// facts change (new failed charge, new overdue balance, changed amount).
const PAYMENT_FAILURE_WARNING_DISMISSED_KEY = "nexstay_payment_failure_warning_dismissed";

// Missing buy-in warning popup (units not purchased for a check-in within 15
// days): same dismissal pattern — signature persisted on dismiss, re-raised
// when the facts change (new uncovered arrival, changed dates/missing units).
const BUYIN_COVERAGE_WARNING_DISMISSED_KEY = "nexstay_buyin_coverage_warning_dismissed";
// Arrival-details promise coverage (check-ins within 14 days whose Guesty
// thread shows no actual arrival-details message) — same dismissal pattern.
const ARRIVAL_DETAILS_WARNING_DISMISSED_KEY = "nexstay_arrival_details_warning_dismissed";
// Misrouted booking confirmations (posted off the guest's channel — guest
// never greeted; scheduler never retries, so the operator must resend).
const CONFIRMATION_ISSUES_DISMISSED_KEY = "nexstay_booking_confirmation_issues_dismissed";

type BulkAvailabilityQueueItemStatus = "pending" | "running" | "success" | "error" | "cancelled";
type BulkAvailabilityProgress = {
  scanned: number;
  total: number;
  percent: number;
  blocked: number;
  available: number;
  errors: number;
  label: string;
  updatedAt: string;
};
type BulkAvailabilityQueue = {
  id: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  weeksAhead: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  totals: {
    pending: number;
    running: number;
    success: number;
    error: number;
  };
  items: Array<{
    propertyId: number;
    name: string;
    community: string;
    bedrooms: number[];
    totalBedrooms: number;
    status: BulkAvailabilityQueueItemStatus;
    runId: number | null;
    message: string | null;
    startedAt: string | null;
    completedAt: string | null;
    progress: BulkAvailabilityProgress | null;
  }>;
};

type ScannableAvailabilityProperty = {
  id: number;
  name: string;
  community: string;
  bedrooms: number[];
  totalBedrooms: number;
};

type DashboardCancellationResponse = {
  windowDays: number;
  audits: ReservationCancellationAudit[];
  summary: {
    total: number;
    paymentTaken: number;
    reviewNeeded: number;
    resolved: number;
    exposure: number;
    lastSyncedAt: string | null;
  };
};

function moneyNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseJsonArray(value: unknown): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function refundDecisionLabel(decision: string | null | undefined): string {
  switch (decision) {
    case "no_payment": return "No payment taken";
    case "fully_refunded": return "Fully refunded";
    case "partial_refund": return "Partial refund";
    case "refund_review": return "Refund review needed";
    default: return "Unknown payment state";
  }
}

function refundDecisionClass(decision: string | null | undefined): string {
  switch (decision) {
    case "no_payment":
    case "fully_refunded":
      return "bg-green-600 text-white";
    case "partial_refund":
      return "bg-amber-500 text-white";
    case "refund_review":
      return "bg-red-600 text-white";
    default:
      return "";
  }
}

function operatorStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "refunded": return "Refunded";
    case "no_refund_due": return "No refund due";
    case "disputed": return "Disputed";
    case "ignored": return "Ignored";
    default: return "Needs review";
  }
}

function paymentLineAmount(item: any): number {
  return moneyNumber(item?.amount ?? item?.paidAmount ?? item?.collectedAmount ?? item?.expectedAmount ?? item?.scheduledAmount ?? item?.total ?? item?.value);
}

function paymentLineDate(item: any): string | null {
  return String(
    item?.paidAt ??
    item?.collectedAt ??
    item?.processedAt ??
    item?.paymentDate ??
    item?.dueDate ??
    item?.date ??
    item?.createdAt ??
    "",
  ) || null;
}

function paymentLineLabel(item: any): string {
  return String(item?.description ?? item?.note ?? item?.label ?? item?.type ?? item?.kind ?? item?.status ?? "Payment");
}

function compactCommunityName(name: string): string {
  const trimmed = name.trim();
  const known: Record<string, string> = {
    "Regency at Poipu Kai": "Regency at Poipu Kai",
    "Mauna Kai Princeville": "Mauna Kai Princeville",
    "Kaha Lani Resort": "Kaha Lani",
    "Makahuena at Poipu": "Makahuena at Poipu",
    "Kaiulani of Princeville": "Kaiulani of Princeville",
  };
  if (known[trimmed]) return known[trimmed];
  const withoutSuffix = trimmed.replace(/\s+(Resort|Villas?|Condos?|Townhomes?)$/i, "").trim();
  if (withoutSuffix.length <= 28) return withoutSuffix;
  return withoutSuffix.split(/\s+/).slice(0, 4).join(" ");
}

function normalizeCommunityUnitCountKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bat\b/g, " ")
    .replace(/\b(?:resort|villas?|condos?|condominiums?|townhomes?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const ESTIMATED_COMMUNITY_UNIT_COUNTS: Record<string, number> = {
  [normalizeCommunityUnitCountKey("Regency at Poipu Kai")]: 80,
  [normalizeCommunityUnitCountKey("Mauna Kai Princeville")]: 50,
  [normalizeCommunityUnitCountKey("Kaha Lani Resort")]: 74,
  [normalizeCommunityUnitCountKey("Makahuena at Poipu")]: 78,
  [normalizeCommunityUnitCountKey("Kaiulani of Princeville")]: 76,
  [normalizeCommunityUnitCountKey("Pili Mai")]: 140,
  [normalizeCommunityUnitCountKey("Menehune Shores")]: 154,
  [normalizeCommunityUnitCountKey("Na Hale O Keauhou")]: 44,
  [normalizeCommunityUnitCountKey("Ilikai")]: 575,
  [normalizeCommunityUnitCountKey("Waikiki Banyan")]: 876,
  [normalizeCommunityUnitCountKey("Fairway Villas Waikoloa")]: 165,
  [normalizeCommunityUnitCountKey("Banyan Harbor")]: 148,
  [normalizeCommunityUnitCountKey("Bonita National")]: 1450,
};

function communityUnitCountFor(communityName: string, explicit?: number | null): number | null {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.round(explicit);
  }
  return ESTIMATED_COMMUNITY_UNIT_COUNTS[normalizeCommunityUnitCountKey(communityName)] ?? null;
}

function communityUnitCountRangeFor(rowUnitCount: number | null | undefined): { low: number; high: number } {
  const low = Math.max(1, Math.round(Number(rowUnitCount) || 1));
  const high = Math.max(low, low === 1 ? 50 : 250);
  return { low, high };
}

function communityUnitCountFields(
  communityName: string,
  rowUnitCount: number,
  explicit?: number | null,
): Pick<Property, "communityUnitCount" | "communityUnitCountRangeLow" | "communityUnitCountRangeHigh"> {
  const exact = communityUnitCountFor(communityName, explicit);
  if (exact != null) {
    return {
      communityUnitCount: exact,
      communityUnitCountRangeLow: null,
      communityUnitCountRangeHigh: null,
    };
  }
  const range = communityUnitCountRangeFor(rowUnitCount);
  return {
    communityUnitCount: null,
    communityUnitCountRangeLow: range.low,
    communityUnitCountRangeHigh: range.high,
  };
}

function communityUnitCountSortValue(property: Pick<Property, "communityUnitCount" | "communityUnitCountRangeLow">): number {
  return property.communityUnitCount ?? property.communityUnitCountRangeLow ?? 1;
}

function communityUnitCountDisplay(property: Pick<Property, "community" | "communityUnitCount" | "communityUnitCountRangeLow" | "communityUnitCountRangeHigh">): { label: string; title: string } {
  if (property.communityUnitCount != null) {
    return {
      label: property.communityUnitCount.toLocaleString(),
      title: `Estimated total units in ${property.community}`,
    };
  }
  const low = Math.max(1, Math.round(Number(property.communityUnitCountRangeLow) || 1));
  const high = Math.max(low, Math.round(Number(property.communityUnitCountRangeHigh) || low));
  return {
    label: `${low.toLocaleString()}-${high.toLocaleString()}`,
    title: `Estimated unit-count range for ${property.community}; exact community unit total is not available yet.`,
  };
}

const properties: Property[] = [
  {
    id: 4,
    name: "Beautiful 6 Bedroom For 16 Villa in Poipu!",
    community: "Regency at Poipu Kai",
    pricingArea: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 6,
    guests: 16,
    bathrooms: 5,
    lowPrice: 1518,
    highPrice: 3201,
    multiUnit: true,
    unitDetails: "2 side-by-side 3BR villas in Poipu Kai",
    url: "https://thevacationrentalexperts.com/en/beautiful-6-bedroom-for-16-villa-in-poipu",
  },
  {
    id: 9,
    name: "Spacious 5 Bedrooms in Poipu Kai! AC!",
    community: "Regency at Poipu Kai",
    pricingArea: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 5,
    guests: 14,
    bathrooms: 4,
    lowPrice: 1313,
    highPrice: 2237,
    multiUnit: true,
    unitDetails: "2 adjacent units (3BR + 2BR)",
    url: "https://thevacationrentalexperts.com/en/spacious-5-bedrooms-in-poipu-kai-ac",
  },
  {
    id: 19,
    name: "Fabulous 5 bedroom for 14 townhome above Anini Beach!",
    community: "Mauna Kai Princeville",
    pricingArea: "Princeville",
    location: "Princeville",
    island: "Kauai",
    bedrooms: 5,
    guests: 14,
    bathrooms: 3,
    lowPrice: 1225,
    highPrice: 2092,
    multiUnit: true,
    unitDetails: "2 adjacent townhomes (3BR + 2BR)",
    url: "https://thevacationrentalexperts.com/en/fabulous-5-bedroom-for-10-townhome-above-famous-anini-beach",
  },
  {
    id: 20,
    name: "Fabulous 6 bedrooms for 16 above Anini Beach!",
    community: "Mauna Kai Princeville",
    pricingArea: "Princeville",
    location: "Princeville",
    island: "Kauai",
    bedrooms: 6,
    guests: 16,
    bathrooms: 5,
    lowPrice: 2035,
    highPrice: 2970,
    multiUnit: true,
    unitDetails: "2 adjacent condos (3BR + 3BR)",
    url: "https://thevacationrentalexperts.com/en/fabulous-7-bedrooms-for-16-above-famous-anini-beach",
  },
  {
    id: 23,
    name: "Gorgeous 5 br for 14 in Kapaa - Beachfront!",
    community: "Kaha Lani Resort",
    pricingArea: "Kapaa Beachfront",
    location: "Kapaa",
    island: "Kauai",
    bedrooms: 5,
    guests: 14,
    bathrooms: 5,
    lowPrice: 1577,
    highPrice: 1973,
    multiUnit: true,
    unitDetails: "3BR + 2BR oceanfront townhomes steps apart",
    url: "https://thevacationrentalexperts.com/en/gorgeous-5-br-for-12-in-kapaa---beachfront",
  },
  {
    id: 24,
    name: "Wonderful 5 br 14 Poipu ocean view! Oceanfront complex!",
    community: "Makahuena at Poipu",
    pricingArea: "Poipu Oceanfront",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 5,
    guests: 14,
    bathrooms: 5,
    lowPrice: 1518,
    highPrice: 2227,
    multiUnit: true,
    unitDetails: "3BR + 2BR units in oceanfront complex",
    url: "https://thevacationrentalexperts.com/en/wonderful-5-br-12-poipu-ocean-view-oceanfront-complex",
  },
  {
    id: 27,
    name: "Beautiful 4 bedroom Poipu Kai Condo!",
    community: "Regency at Poipu Kai",
    pricingArea: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 4,
    guests: 12,
    bathrooms: 4,
    lowPrice: 1049,
    highPrice: 1650,
    multiUnit: true,
    unitDetails: "2 x 2BR condos",
    url: "https://thevacationrentalexperts.com/en/beautiful-4-bedroom-poipu-kai-condo",
  },
  {
    id: 29,
    name: "Ocean view 7 bedrooms for 18 above Anini Beach!",
    community: "Kaiulani of Princeville",
    pricingArea: "Princeville",
    location: "Princeville",
    island: "Kauai",
    bedrooms: 7,
    guests: 18,
    bathrooms: 4,
    lowPrice: 1518,
    highPrice: 2897,
    multiUnit: true,
    unitDetails: "4BR + 3BR townhomes steps apart",
    url: "https://thevacationrentalexperts.com/en/ocean-view-7-bedrooms-for-14-above-famous-anini-beach",
  },
  {
    id: 32,
    name: "Gorgeous Poipu Townhomes for 14 with AC! 5 Bedrooms.",
    community: "Pili Mai",
    pricingArea: "Pili Mai",
    location: "Poipu",
    island: "Kauai",
    bedrooms: 5,
    guests: 14,
    bathrooms: 5,
    lowPrice: null,
    highPrice: null,
    multiUnit: true,
    unitDetails: "3BR + 2BR townhomes steps apart",
    url: "https://thevacationrentalexperts.com/en/gorgeous-poipu-townhomes-for-12-with-ac-5-bedrooms",
  },
  {
    id: 33,
    name: "Beautiful Poipu Townhomes for 16 with AC! 6 Bedrooms.",
    community: "Pili Mai",
    pricingArea: "Pili Mai",
    location: "Poipu",
    island: "Kauai",
    bedrooms: 6,
    guests: 16,
    bathrooms: 6,
    lowPrice: 1818,
    highPrice: 2771,
    multiUnit: true,
    unitDetails: "Two 3BR/3BA townhomes steps apart",
    url: "https://thevacationrentalexperts.com/en/beautiful-poipu-townhomes-for-12-with-ac-6-bedrooms",
  },
];

type SortField = "propertyId" | "name" | "community" | "bedrooms" | "guests" | "lowPrice" | "highPrice" | "island" | "unitCount" | "baseRate" | "minimumStay" | "dateAdded" | "totalRevenue" | "lastPriceScan" | "guestyListed";

// Per-property trailing-365-day revenue for the "Total Revenue" column.
type PropertyRevenueEntry = { revenue: number; bookings: number; currency: string; windowDays: number; computedAt: string | null };
type PropertyRevenueMap = Record<number, PropertyRevenueEntry>;

// Per-property "Last Price Scan" — the timestamp the market-rate pricing table
// was last refreshed AND pushed to Guesty (scanner_schedule.lastGuestyRatePushAt).
// status "seed" = one-time retroactive backfill (not a real push), "ok"/"error" =
// real weekly/manual Guesty push outcome.
type LastPriceScanEntry = { pushedAt: string | null; status: string | null; summary: string | null };
type LastPriceScanMap = Record<number, LastPriceScanEntry>;

function displayPropertyId(property: Pick<Property, "id" | "draftId">): string {
  const numericId = property.draftId ? 900000 + property.draftId : 100000 + property.id;
  return String(numericId).padStart(6, "0");
}

function propertyIdSortValue(property: Pick<Property, "id" | "draftId">): number {
  return Number(displayPropertyId(property));
}

// Total nightly buy-in cost across all units (sum of per-unit rates from
// shared/pricing-rates). Multi-unit properties get parsed from unitDetails
// (e.g. "3BR + 2BR" → sum of 3BR and 2BR rates); falls back to a single-unit
// lookup when parsing returns nothing useful. Pricing keys off pricingArea
// (e.g. "Poipu Kai") rather than the displayed complex name (e.g. "Regency
// at Poipu Kai") because BUY_IN_RATES is keyed by area.
function computeBaseRate(property: Property): number {
  const brs = property.multiUnit ? extractBRList(property.unitDetails) : [];
  if (brs.length >= 2 && brs.reduce((s, n) => s + n, 0) === property.bedrooms) {
    return brs.reduce((sum, br) => sum + getBuyInRate(property.pricingArea, br, property.id), 0);
  }
  return getBuyInRate(property.pricingArea, property.bedrooms, property.id);
}

const ESTIMATED_MINIMUM_STAY_BY_AREA: Record<string, { low: number; high: number; note: string }> = {
  "Kapaa Beachfront": {
    low: 4,
    high: 4,
    note: "Dashboard fallback based on current Kaha Lani / Kapaa beachfront Guesty-mapped rows.",
  },
  "Poipu Oceanfront": {
    low: 3,
    high: 3,
    note: "Dashboard fallback based on current Makahuena / Poipu oceanfront Guesty-mapped rows.",
  },
  "Pili Mai": {
    low: 4,
    high: 4,
    note: "Dashboard fallback based on current Pili Mai Guesty-mapped rows.",
  },
  "Princeville": {
    low: 4,
    high: 4,
    note: "Estimated from the currently mapped Princeville/Mauna Kai listing. Verify exact listing rules in Guesty when needed.",
  },
  "Poipu Kai": {
    low: 4,
    high: 4,
    note: "Estimated from currently mapped Regency/Poipu Kai listings. Verify exact listing rules in Guesty when needed.",
  },
};

function estimatedMinimumStayFor(property: Pick<Property, "pricingArea" | "community" | "island">) {
  return ESTIMATED_MINIMUM_STAY_BY_AREA[property.pricingArea]
    ?? ESTIMATED_MINIMUM_STAY_BY_AREA[property.community]
    ?? (property.island === "Kauai"
      ? {
          low: 3,
          high: 5,
          note: "Conservative Kauai fallback range used because no exact Guesty/research minimum is saved for this row.",
        }
      : {
          low: 2,
          high: 7,
          note: "Broad fallback range used because no exact Guesty/research minimum is saved for this row.",
        });
}

function minimumStayDisplay(property: Pick<Property, "minimumStayNights" | "minimumStayEvidence" | "minimumStaySourceUrl" | "minimumStayRangeLow" | "minimumStayRangeHigh" | "pricingArea" | "community" | "island">): {
  label: string;
  tone: "ok" | "warn" | "estimate";
  details: string;
} {
  const evidence = property.minimumStayEvidence?.trim();
  const source = property.minimumStaySourceUrl?.trim();
  if (
    typeof property.minimumStayRangeLow === "number" &&
    typeof property.minimumStayRangeHigh === "number" &&
    property.minimumStayRangeLow > 0 &&
    property.minimumStayRangeHigh >= property.minimumStayRangeLow
  ) {
    const low = property.minimumStayRangeLow;
    const high = property.minimumStayRangeHigh;
    return {
      label: low === high ? `${low} night${low === 1 ? "" : "s"}` : `${low}-${high} nights`,
      tone: "warn",
      details: evidence || "Known minimum-stay values for this community vary by mapped listing, so the dashboard shows the confirmed range.",
    };
  }
  if (typeof property.minimumStayNights === "number" && property.minimumStayNights > 0) {
    return {
      label: `${property.minimumStayNights} night${property.minimumStayNights === 1 ? "" : "s"}`,
      tone: "warn",
      details: evidence || "Research found a likely published community-wide minimum stay rule.",
    };
  }
  if (property.minimumStayNights === 0) {
    return {
      label: "No min found",
      tone: "ok",
      details: evidence || "Research found a reliable source indicating no community-wide minimum stay.",
    };
  }
  const estimate = estimatedMinimumStayFor(property);
  const label = estimate.low === estimate.high
    ? `~${estimate.low} night${estimate.low === 1 ? "" : "s"}`
    : `~${estimate.low}-${estimate.high} nights`;
  return {
    label,
    tone: "estimate",
    details: [
      estimate.note,
      "Shown as an estimate because no exact Guesty/research minimum is saved for this row.",
      source ? `Source checked: ${source}` : "",
    ].filter(Boolean).join(" "),
  };
}
type SortDir = "asc" | "desc";

type AgentArrivalUnit = {
  id: number;
  unitLabel: string;
  address: string;
  arrivalCode: string;
  parking: string;
  wifiName: string;
  wifiPassword: string;
  pmCompany: string;
  pmContact: string;
  arrivalNotes: string;
};

type AgentPropertyBooking = {
  id: string;
  status: string;
  guestName: string;
  checkIn: string | null;
  checkOut: string | null;
  nightsCount: number | null;
  listingName: string;
  source: string;
  confirmationCode: string;
  arrivalUnits: AgentArrivalUnit[];
};

type AgentMissedCall = {
  id: number;
  conversationId?: string | null;
  reservationId?: string | null;
  guestName?: string | null;
  guestPhone: string;
  disposition: "answered" | "missed" | "voicemail" | "unknown" | string;
  voicemailRecordingUrl?: string | null;
  voicemailTranscript?: string | null;
  voicemailDurationSeconds?: number | null;
  callCompletedAt?: string | null;
  callStartedAt?: string | null;
  createdAt?: string | null;
};

function formatAgentDate(value: string | null): string {
  if (!value) return "TBD";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatAgentPhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  if (last10.length !== 10) return String(value ?? "Unknown phone") || "Unknown phone";
  return `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`;
}

function formatAgentCallTime(call: AgentMissedCall): string {
  const value = call.callCompletedAt ?? call.callStartedAt ?? call.createdAt ?? null;
  if (!value) return "Time unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatAgentCallDuration(seconds?: number | null): string {
  const n = Math.max(0, Math.round(Number(seconds ?? 0)));
  if (!n) return "";
  const minutes = Math.floor(n / 60);
  const remainder = n % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function AgentArrivalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 break-words text-xs font-medium">{value || "None"}</div>
    </div>
  );
}

type AgentPortalProperty = ReturnType<typeof getAllUnitBuilders>[number];

function AgentPropertyBookings({ propertyId, compact = false }: { propertyId: number; compact?: boolean }) {
  const { data, isLoading } = useQuery<{ bookings: AgentPropertyBooking[] }>({
    queryKey: ["/api/agent/properties", propertyId, "bookings"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/agent/properties/${propertyId}/bookings`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const bookings = data?.bookings ?? [];

  if (compact) {
    if (isLoading) {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading
        </span>
      );
    }
    if (bookings.length === 0) return <span className="text-xs text-muted-foreground">None</span>;
    const next = bookings[0];
    return (
      <div className="min-w-0">
        <div className="text-sm font-medium">{bookings.length} booking{bookings.length === 1 ? "" : "s"}</div>
        <div className="truncate text-xs text-muted-foreground">
          Next: {next.guestName || "Guest"} · {formatAgentDate(next.checkIn)}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Bookings</div>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {!isLoading && bookings.length === 0 && (
        <div className="mt-2 text-xs text-muted-foreground">None</div>
      )}
      <div className="mt-2 space-y-3">
        {bookings.map((booking) => (
          <div key={booking.id} className="rounded-md border bg-muted/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-sm">{booking.guestName || "Guest"}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {formatAgentDate(booking.checkIn)} - {formatAgentDate(booking.checkOut)}
                  {booking.nightsCount ? ` · ${booking.nightsCount} night${booking.nightsCount === 1 ? "" : "s"}` : ""}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {booking.listingName || "Listing"} · {booking.confirmationCode || booking.id}
                </div>
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {booking.status || booking.source || "Booked"}
              </Badge>
            </div>

            {booking.arrivalUnits.length === 0 ? (
              <div className="mt-3 rounded-md border border-dashed bg-background p-2 text-xs text-muted-foreground">
                Arrival information: None
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {booking.arrivalUnits.map((unit) => (
                  <div key={unit.id} className="rounded-md bg-background p-2">
                    <div className="mb-2 text-xs font-semibold">{unit.unitLabel || "Assigned unit"}</div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <AgentArrivalField label="Address" value={unit.address} />
                      <AgentArrivalField label="Arrival Code" value={unit.arrivalCode} />
                      <AgentArrivalField label="Parking" value={unit.parking} />
                      <AgentArrivalField label="Wi-Fi Name" value={unit.wifiName} />
                      <AgentArrivalField label="Wi-Fi Password" value={unit.wifiPassword} />
                      <AgentArrivalField label="PM Company" value={unit.pmCompany} />
                      <AgentArrivalField label="PM Email / Phone" value={unit.pmContact} />
                      <AgentArrivalField label="Arrival Notes" value={unit.arrivalNotes} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentPropertyDetailsDialog({ property }: { property: AgentPortalProperty }) {
  const totalBedrooms = property.units.reduce((sum, unit) => sum + unit.bedrooms, 0);
  const totalGuests = property.units.reduce((sum, unit) => sum + unit.maxGuests, 0);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8" data-testid={`button-agent-property-details-${property.propertyId}`}>
          Details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{property.propertyName}</DialogTitle>
          <DialogDescription>
            {property.complexName} · {property.address}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Bedrooms</div>
            <div className="font-semibold">{totalBedrooms}</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Max guests</div>
            <div className="font-semibold">{totalGuests}</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Units</div>
            <div className="font-semibold">{property.units.length}</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-[10px] uppercase text-muted-foreground">Type</div>
            <div className="font-semibold">{property.propertyType ?? "Condominium"}</div>
          </div>
        </div>

        <AgentPropertyBookings propertyId={property.propertyId} />

        {(property.neighborhood || property.transit || property.accessibilityNote) && (
          <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
            {property.accessibilityNote && (
              <p><span className="font-medium text-foreground">Accessibility:</span> {property.accessibilityNote}</p>
            )}
            {property.neighborhood && (
              <p><span className="font-medium text-foreground">Area:</span> {property.neighborhood}</p>
            )}
            {property.transit && (
              <p><span className="font-medium text-foreground">Getting around:</span> {property.transit}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AgentPropertyRow({ property }: { property: AgentPortalProperty }) {
  const totalBedrooms = property.units.reduce((sum, unit) => sum + unit.bedrooms, 0);
  const totalGuests = property.units.reduce((sum, unit) => sum + unit.maxGuests, 0);

  return (
    <TableRow data-testid={`row-agent-property-${property.propertyId}`}>
      <TableCell className="min-w-[240px]">
        <div className="min-w-0">
          <div className="font-semibold leading-tight">{property.propertyName}</div>
          <div className="mt-1 text-xs text-muted-foreground">{property.complexName}</div>
        </div>
      </TableCell>
      <TableCell className="hidden min-w-[260px] text-sm text-muted-foreground lg:table-cell">
        <div className="flex items-start gap-2">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{property.address}</span>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm">{totalBedrooms} BR</TableCell>
      <TableCell className="whitespace-nowrap text-sm">{totalGuests} guests</TableCell>
      <TableCell className="hidden whitespace-nowrap text-sm md:table-cell">{property.units.length} unit{property.units.length === 1 ? "" : "s"}</TableCell>
      <TableCell className="min-w-[180px]">
        <AgentPropertyBookings propertyId={property.propertyId} compact />
      </TableCell>
      <TableCell className="text-right">
        <AgentPropertyDetailsDialog property={property} />
      </TableCell>
    </TableRow>
  );
}

function AgentPropertyPortal() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Active portfolio only — retired builder entries are not bookable
  // listings, so agents must never see or quote them.
  const properties = getActiveUnitBuilders();
  const [callbackCall, setCallbackCall] = useState<AgentMissedCall | null>(null);
  const [callbackSummary, setCallbackSummary] = useState("");

  const { data: missedCallData, isLoading: missedCallsLoading } = useQuery<{ calls: AgentMissedCall[]; count: number }>({
    queryKey: ["/api/inbox/calls/unacknowledged"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/inbox/calls/unacknowledged?limit=25");
      if (!r.ok) throw new Error(`Missed calls returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const missedCalls = missedCallData?.calls ?? [];
  const completeCallback = useMutation({
    mutationFn: async () => {
      if (!callbackCall) throw new Error("No missed call selected");
      const said = callbackSummary.trim();
      if (said.length < 2) throw new Error("Please add what the guest said.");
      const r = await apiRequest("POST", `/api/inbox/calls/${callbackCall.id}/callback`, { said });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.message ?? errBody.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (_data) => {
      const conversationId = callbackCall?.conversationId;
      setCallbackCall(null);
      setCallbackSummary("");
      queryClient.invalidateQueries({ queryKey: ["/api/inbox/calls/unacknowledged"] });
      if (conversationId) {
        queryClient.invalidateQueries({ queryKey: ["/api/inbox/internal-notes", conversationId] });
        queryClient.invalidateQueries({ queryKey: ["/api/inbox/calls/conversations", conversationId] });
      }
      toast({ title: "Callback saved", description: "The missed call was cleared and added to internal notes." });
    },
    onError: (e: any) => toast({ title: "Callback not saved", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-3 py-4 sm:px-4 sm:py-6">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl" data-testid="text-page-title">
              Agent Guest Portal
            </h1>
            <p className="text-sm text-muted-foreground mt-1 sm:text-base">
              Guest messages, missed calls, and read-only property details for arrival support.
            </p>
          </div>
          <Link href="/inbox">
            <Button className="w-full gap-2 sm:w-auto" data-testid="button-agent-open-inbox">
              <MessageSquare className="h-4 w-4" />
              Open Guest Inbox
            </Button>
          </Link>
        </div>

        <Card className="mb-5 border-red-200 bg-red-50/60 p-4" data-testid="panel-agent-missed-calls">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-red-100 text-red-700">
                  <PhoneMissed className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-red-950">Missed 808 calls</h2>
                  <p className="text-xs text-red-800">
                    Call the guest back from your phone, then save what they said here.
                  </p>
                </div>
              </div>
            </div>
            <Link href="/inbox">
              <Button variant="outline" className="w-full gap-2 border-red-200 bg-white text-red-900 hover:bg-red-50 lg:w-auto" data-testid="button-agent-open-call-inbox">
                <MessageSquare className="h-4 w-4" />
                Guest Inbox
              </Button>
            </Link>
          </div>

          <div className="mt-4">
            {missedCallsLoading ? (
              <div className="flex items-center gap-2 rounded-md border border-red-100 bg-white/80 px-3 py-3 text-sm text-red-800">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking missed calls...
              </div>
            ) : missedCalls.length === 0 ? (
              <div className="rounded-md border border-red-100 bg-white/80 px-3 py-3 text-sm text-red-800" data-testid="text-agent-no-missed-calls">
                No missed 808 calls waiting.
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {missedCalls.map((call) => {
                  const duration = formatAgentCallDuration(call.voicemailDurationSeconds);
                  return (
                    <div key={call.id} className="rounded-md border border-red-200 bg-white p-3 shadow-sm" data-testid={`card-agent-missed-call-${call.id}`}>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="font-semibold text-red-950">
                            {call.guestName || "Unknown caller"}
                          </div>
                          <div className="mt-0.5 text-sm text-red-900">
                            {formatAgentPhone(call.guestPhone)}
                          </div>
                          <div className="mt-1 text-xs text-red-800">
                            {call.disposition === "voicemail" ? "Voicemail" : "Missed call"} · {formatAgentCallTime(call)}
                            {duration && ` · ${duration}`}
                          </div>
                          {call.voicemailTranscript && (
                            <div className="mt-2 line-clamp-2 text-xs text-red-900">
                              {call.voicemailTranscript}
                            </div>
                          )}
                          {call.voicemailRecordingUrl && (
                            <audio controls src={call.voicemailRecordingUrl} className="mt-2 w-full max-w-[320px]" data-testid={`audio-agent-missed-call-${call.id}`} />
                          )}
                        </div>
                        <Button
                          size="sm"
                          className="shrink-0 bg-red-700 text-white hover:bg-red-800"
                          onClick={() => {
                            setCallbackCall(call);
                            setCallbackSummary("");
                          }}
                          data-testid={`button-agent-called-back-${call.id}`}
                        >
                          Called guest back
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        <Dialog open={!!callbackCall} onOpenChange={(open) => {
          if (!open) {
            setCallbackCall(null);
            setCallbackSummary("");
          }
        }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Complete guest callback</DialogTitle>
              <DialogDescription>
                Save what the guest said. This clears the missed-call notification and adds an internal note in the Guest Inbox.
              </DialogDescription>
            </DialogHeader>
            {callbackCall && (
              <div className="space-y-3">
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <div className="font-medium">{callbackCall.guestName || "Unknown caller"}</div>
                  <div className="text-muted-foreground">{formatAgentPhone(callbackCall.guestPhone)} · {formatAgentCallTime(callbackCall)}</div>
                </div>
                <div>
                  <label className="text-sm font-medium" htmlFor="agent-callback-summary">Said</label>
                  <Textarea
                    id="agent-callback-summary"
                    className="mt-1 min-h-[110px]"
                    value={callbackSummary}
                    onChange={(event) => setCallbackSummary(event.target.value)}
                    placeholder="Example: Guest confirmed arrival time and said they found the check-in email."
                    data-testid="textarea-agent-callback-summary"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setCallbackCall(null)} disabled={completeCallback.isPending}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => completeCallback.mutate()}
                    disabled={completeCallback.isPending || callbackSummary.trim().length < 2}
                    data-testid="button-agent-save-callback"
                  >
                    {completeCallback.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save callback
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead className="hidden lg:table-cell">Address</TableHead>
                <TableHead>Bedrooms</TableHead>
                <TableHead>Guests</TableHead>
                <TableHead className="hidden md:table-cell">Units</TableHead>
                <TableHead>Bookings</TableHead>
                <TableHead className="text-right">More</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {properties.map((property) => (
                <AgentPropertyRow key={property.propertyId} property={property} />
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

function AdminDashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [communityFilter, setCommunityFilter] = useState("all");
  const [islandFilter, setIslandFilter] = useState("all");
  const [multiUnitFilter, setMultiUnitFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("community");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // When the operator clicks an unmapped (gray) G-dot we open the
  // connect-to-existing dialog seeded with this row's id + name.
  const [connectTarget, setConnectTarget] = useState<{ id: number; name: string } | null>(null);
  const [selectedPricingIds, setSelectedPricingIds] = useState<Set<number>>(() => new Set());
  const [bulkPricingOpen, setBulkPricingOpen] = useState(false);
  const [bulkPricingJob, setBulkPricingJob] = useState<BulkPricingJob | null>(null);
  const [bulkPricingHistory, setBulkPricingHistory] = useState<BulkPricingJob[]>([]);
  const [bulkPricingEvents, setBulkPricingEvents] = useState<QueueJobEventPayload[]>([]);
  const [bulkPricingStarting, setBulkPricingStarting] = useState(false);
  const [bulkPricingCancelling, setBulkPricingCancelling] = useState(false);
  const [bulkPricingRetrying, setBulkPricingRetrying] = useState(false);
  const [bulkPricingClearing, setBulkPricingClearing] = useState(false);
  const [bulkAvailabilityOpen, setBulkAvailabilityOpen] = useState(false);
  const [bulkAvailabilityStarting, setBulkAvailabilityStarting] = useState(false);
  const [bulkAvailabilityAction, setBulkAvailabilityAction] = useState<"clear" | "pause" | "resume" | "cancel" | null>(null);
  const [bulkAvailabilityQueue, setBulkAvailabilityQueue] = useState<BulkAvailabilityQueue | null>(null);
  const [photoScanPollUntil, setPhotoScanPollUntil] = useState(0);
  // Progress modal for the dashboard "Run photo match scan" (deep) button.
  const [photoScanModalOpen, setPhotoScanModalOpen] = useState(false);
  const [photoScanFolders, setPhotoScanFolders] = useState<string[]>([]);
  const [photoScanStartedAt, setPhotoScanStartedAt] = useState(0);
  const [photoScanLabel, setPhotoScanLabel] = useState("");
  const [photoScanSearch, setPhotoScanSearch] = useState("");
  // Duplicate-photos warning popup ("Confirm photos replaced" → verify rescan).
  // photoReplaceRescans is keyed by folder; an entry means the operator
  // confirmed replacement and a verification rescan is pending/done. Entries
  // keep the unit's display facts so a now-clean unit (which drops out of the
  // duplicate list) can still render its green confirmation row.
  const [duplicatePhotoWarningOpen, setDuplicatePhotoWarningOpen] = useState(false);
  const [addressAlertWarningOpen, setAddressAlertWarningOpen] = useState(false);
  const [paymentFailureWarningOpen, setPaymentFailureWarningOpen] = useState(false);
  const [buyInCoverageWarningOpen, setBuyInCoverageWarningOpen] = useState(false);
  const [arrivalDetailsWarningOpen, setArrivalDetailsWarningOpen] = useState(false);
  const [confirmationIssuesOpen, setConfirmationIssuesOpen] = useState(false);
  const [confirmationResendPending, setConfirmationResendPending] = useState<Record<string, boolean>>({});
  const [photoReplaceRescans, setPhotoReplaceRescans] = useState<Record<string, {
    startedAt: number;
    propertyName: string;
    unitLabel: string;
    platforms: DuplicatePhotoPlatform[];
  }>>({});
  // "Replace photos (Unit X)" from the duplicate-photos popup: mounts the
  // preflight UnitReplacementFlow (find another unit in the SAME community
  // with the SAME bedroom count, real-estate sources only, Claude-vision
  // interior probe + OTA-clean gates) targeted at the flagged unit. This is
  // now the MANUAL path ("Pick manually") — the primary button fires the
  // one-click server-side auto-replace job instead.
  const [replacePhotosTarget, setReplacePhotosTarget] = useState<{ propertyId: number; unitId: string } | null>(null);
  // One-click auto-replace queue (server-side find → auto-commit → verify).
  const [autoReplaceQueueOpen, setAutoReplaceQueueOpen] = useState(false);
  const [bulkPhotoCommunityJob, setBulkPhotoCommunityJob] = useState<BulkPhotoCommunityJob | null>(null);
  const [bulkPhotoCommunityStarting, setBulkPhotoCommunityStarting] = useState(false);
  const [bulkPhotoCommunityCancelling, setBulkPhotoCommunityCancelling] = useState(false);
  const [selectedCancellationId, setSelectedCancellationId] = useState<number | null>(null);

  // Pull community drafts up here (early in the render) because
  // `allProperties` below depends on them and `baseRates` /
  // `filtered` all read `allProperties`. The fetch
  // is deduped by react-query so rendering it twice (here and the
  // existing useQuery further down used to delete drafts) is free.
  const { data: communityDraftsDataForRows } = useQuery<CommunityDraft[]>({
    queryKey: ["/api/community/drafts"],
  });

  type DashboardMinimumStay = {
    minimumStayNights: number | null;
    minimumStayEvidence: string | null;
    minimumStaySourceUrl: string | null;
  };
  type DashboardMinimumStayMap = Record<number, DashboardMinimumStay>;
  const { data: minimumStayData } = useQuery<DashboardMinimumStayMap>({
    queryKey: ["/api/dashboard/minimum-stays"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: scannableAvailabilityProperties = [] } = useQuery<ScannableAvailabilityProperty[]>({
    queryKey: ["/api/scanner/properties"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: missedCallData } = useQuery<{ calls?: unknown[]; count?: number }>({
    queryKey: ["/api/inbox/calls/unacknowledged"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/inbox/calls/unacknowledged?limit=100");
      if (!r.ok) return { calls: [], count: 0 };
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const missedCallCount = Number(missedCallData?.count ?? missedCallData?.calls?.length ?? 0) || 0;

  const communityMinimumStayData = useMemo(() => {
    const buckets = new Map<string, {
      values: Set<number>;
      evidence: string[];
      sourceUrl: string | null;
    }>();
    const addValue = (community: string, stay: DashboardMinimumStay | undefined, label: string) => {
      if (typeof stay?.minimumStayNights !== "number" || stay.minimumStayNights <= 0) return;
      const bucket = buckets.get(community) ?? { values: new Set<number>(), evidence: [], sourceUrl: null };
      bucket.values.add(stay.minimumStayNights);
      bucket.evidence.push(stay.minimumStayEvidence || `${label} has a ${stay.minimumStayNights}-night minimum in Guesty.`);
      if (!bucket.sourceUrl && stay.minimumStaySourceUrl) bucket.sourceUrl = stay.minimumStaySourceUrl;
      buckets.set(community, bucket);
    };

    for (const p of properties) {
      addValue(p.community, minimumStayData?.[p.id], p.name);
    }
    for (const d of communityDraftsDataForRows ?? []) {
      const community = d.name;
      const draftStay: DashboardMinimumStay | undefined =
        typeof d.minimumStayNights === "number"
          ? {
              minimumStayNights: d.minimumStayNights,
              minimumStayEvidence: d.minimumStayEvidence ?? null,
              minimumStaySourceUrl: d.minimumStaySourceUrl ?? null,
            }
          : minimumStayData?.[-d.id];
      addValue(community, draftStay, d.listingTitle || d.name);
    }

    const out = new Map<string, {
      minimumStayNights?: number;
      minimumStayRangeLow?: number;
      minimumStayRangeHigh?: number;
      minimumStayEvidence: string;
      minimumStaySourceUrl: string | null;
    }>();
    for (const [community, bucket] of buckets) {
      const values = [...bucket.values].sort((a, b) => a - b);
      if (values.length === 0) continue;
      const evidence = values.length === 1
        ? `Known rule applied across ${community}: ${values[0]} night${values[0] === 1 ? "" : "s"}. ${bucket.evidence[0] ?? ""}`.trim()
        : `Known minimum-stay values across ${community} mapped listings range from ${values[0]} to ${values[values.length - 1]} nights.`;
      out.set(community, values.length === 1
        ? {
            minimumStayNights: values[0],
            minimumStayEvidence: evidence,
            minimumStaySourceUrl: bucket.sourceUrl,
          }
        : {
            minimumStayRangeLow: values[0],
            minimumStayRangeHigh: values[values.length - 1],
            minimumStayEvidence: evidence,
            minimumStaySourceUrl: bucket.sourceUrl,
          });
    }
    return out;
  }, [communityDraftsDataForRows, minimumStayData]);

  const activeProperties = useMemo(() => {
    return properties.map((p) => {
      const stay = minimumStayData?.[p.id];
      const communityStay = communityMinimumStayData.get(p.community);
      const unitCount = getUnitBuilderByPropertyId(p.id)?.units.length ?? (p.multiUnit ? 2 : 1);
      const communityUnitCount = communityUnitCountFields(p.community, unitCount);
      if (!stay && !communityStay) return { ...p, unitCount, ...communityUnitCount };
      if (communityStay?.minimumStayRangeLow && communityStay.minimumStayRangeHigh) {
        return {
          ...p,
          unitCount,
          ...communityUnitCount,
          minimumStayNights: null,
          minimumStayEvidence: communityStay.minimumStayEvidence,
          minimumStaySourceUrl: communityStay.minimumStaySourceUrl,
          minimumStayRangeLow: communityStay.minimumStayRangeLow,
          minimumStayRangeHigh: communityStay.minimumStayRangeHigh,
        };
      }
      return {
        ...p,
        unitCount,
        ...communityUnitCount,
        minimumStayNights: stay?.minimumStayNights ?? communityStay?.minimumStayNights ?? null,
        minimumStayEvidence: stay?.minimumStayEvidence ?? communityStay?.minimumStayEvidence ?? null,
        minimumStaySourceUrl: stay?.minimumStaySourceUrl ?? communityStay?.minimumStaySourceUrl ?? null,
        minimumStayRangeLow: null,
        minimumStayRangeHigh: null,
      };
    });
  }, [communityMinimumStayData, minimumStayData]);

  // Map community drafts → Property-shaped rows so they show up in
  // the main table next to the active 11 properties. Synthetic
  // negative `id` ensures no collision with active property ids —
  // every cache keyed on `id` (unit counts, baseRates, the
  // useMemo `filtered` sort) stays unique.
  //
  // Empty / fallback fields:
  //   - `pricingArea` is "" so getBuyInRate / quality lookups
  //     fall through to fallbacks. Drafts don't yet belong to a
  //     known buy-in area; the operator picks one when promoting
  //     the draft into unit-builder-data.
  //   - `island` defaults to the state name (Florida, Hawaii, …)
  //     so the Island filter still has something to scope on.
  //   - `bathrooms` is the sum of per-unit bathrooms parsed from
  //     the AI draft strings ("2" / "2.5"); falls back to 0.
  const draftsAsProperties: Property[] = useMemo(() => {
    if (!communityDraftsDataForRows) return [];
    const parseBath = (s: string | null) => {
      const n = Number(String(s ?? "").replace(/[^\d.]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const positiveInt = (value: unknown): number | null => {
      const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const inferBedrooms = (d: CommunityDraft, unitKey: "unit1" | "unit2") =>
      resolveDraftUnitBedrooms(d, unitKey);
    const inferSleeps = (d: CommunityDraft, bedrooms: number) => {
      const stored = positiveInt(d.unit1MaxGuests);
      if (stored) return stored;
      const text = [d.listingTitle, d.bookingTitle, d.listingDescription, d.unit1Bedding]
        .filter(Boolean)
        .join(" ");
      const match = text.match(/\b(?:sleeps?|sleeping\s+up\s+to|for)\s*(\d{1,2})\b/i);
      return positiveInt(match?.[1]) ?? (bedrooms > 0 ? bedrooms * 2 : 0);
    };
    return communityDraftsDataForRows.map((d) => {
      // CODEX NOTE (2026-05-04, claude/single-listing): branch on
      // `singleListing` so standalone drafts render with `multiUnit:
      // false` and a single-unit unitDetails string. Combos keep the
      // existing two-unit behavior. Defaults to false so drafts saved
      // before the column existed are treated as combos (existing
      // behavior).
      const isSingle = (d as any).singleListing === true;
      const u1Br = inferBedrooms(d, "unit1");
      const u2Br = isSingle ? 0 : inferBedrooms(d, "unit2");
      const unitBedroomSum = u1Br + u2Br;
      const totalBr = isSingle ? u1Br : (unitBedroomSum > 0 ? unitBedroomSum : (inferCombinedBedrooms(d) ?? 0));
      const totalGuests = isSingle
        ? inferSleeps(d, u1Br)
        : (((d.unit1MaxGuests ?? 0) + (d.unit2MaxGuests ?? 0)) || totalBr * 2);
      const totalBath = isSingle
        ? parseBath(d.unit1Bathrooms ?? null)
        : parseBath(d.unit1Bathrooms ?? null) + parseBath(d.unit2Bathrooms ?? null);
      const unitDetails = isSingle
        ? (u1Br > 0 ? `${u1Br}BR standalone` : "Standalone (draft)")
        : (u1Br > 0 && u2Br > 0 ? `${u1Br}BR + ${u2Br}BR` : "Two units (draft)");
      const unitCount = isSingle ? 1 : 2;
      const communityUnitCount = communityUnitCountFields(d.name, unitCount, d.estimatedTotalUnits);
      const guestyStay = minimumStayData?.[-d.id];
      const communityStay = communityMinimumStayData.get(d.name);
      const communityRange = communityStay?.minimumStayRangeLow && communityStay.minimumStayRangeHigh
        ? communityStay
        : null;
      return {
        id: -d.id, // negative so id-keyed caches never collide with active rows
        draftId: d.id,
        draftStatus: d.status,
        name: d.listingTitle || d.name,
        community: d.name,
        // pricingArea is set on the wizard's Step 5 (auto-suggested
        // from city/state, operator can override). Empty = no area
        // → buy-in calc returns the per-bedroom default.
        pricingArea: d.pricingArea ?? "",
        location: d.city,
        island: d.state,
        bedrooms: totalBr,
        guests: totalGuests,
        bathrooms: totalBath,
        lowPrice: d.estimatedLowRate ?? d.suggestedRate ?? null,
        highPrice: d.estimatedHighRate ?? null,
        minimumStayNights: communityRange
          ? null
          : d.minimumStayNights ?? guestyStay?.minimumStayNights ?? communityStay?.minimumStayNights ?? null,
        minimumStayEvidence: communityRange?.minimumStayEvidence
          ?? d.minimumStayEvidence
          ?? guestyStay?.minimumStayEvidence
          ?? communityStay?.minimumStayEvidence
          ?? null,
        minimumStaySourceUrl: communityRange?.minimumStaySourceUrl
          ?? d.minimumStaySourceUrl
          ?? guestyStay?.minimumStaySourceUrl
          ?? communityStay?.minimumStaySourceUrl
          ?? null,
        minimumStayRangeLow: communityRange?.minimumStayRangeLow ?? null,
        minimumStayRangeHigh: communityRange?.minimumStayRangeHigh ?? null,
        multiUnit: !isSingle,
        unitCount,
        ...communityUnitCount,
        unitDetails,
        url: d.sourceUrl ?? "",
        // Real "date added into the system" for every imported/draft listing —
        // the community_drafts row stamps createdAt at insert (defaultNow,
        // notNull), so this is populated retroactively for all existing drafts.
        createdAt: d.createdAt,
      };
    });
  }, [communityDraftsDataForRows, communityMinimumStayData, minimumStayData]);

  // Combined list used by every downstream calc (baseRates,
  // communities/islands filters, the rendered rows).
  // Active properties first so they sort to the top by default;
  // drafts append below until the user changes sort order.
  const allProperties = useMemo(
    () =>
      [...activeProperties, ...draftsAsProperties].map((p) => {
        // Derive "Guests" (sleeps) from the single headline occupancy rule
        // (occupancyForBedrooms) keyed ONLY on the bedroom count, so the
        // dashboard column always matches the listing title, the summary, and
        // the Guesty `accommodates` we push. Anchors: 2→6, 4→12, 5→14, 6→16,
        // 7→18 (3→10, 8→20). This replaces the old bedrooms*2 + condos*2
        // formula, which gave a different number for 3-condo combos.
        return p.bedrooms > 0 ? { ...p, guests: occupancyForBedrooms(p.bedrooms) } : p;
      }),
    [activeProperties, draftsAsProperties],
  );

  // Subscribe to the live-buy-in feed so `baseRates` recomputes
  // after `App.tsx`'s MarketRatesHydrator populates the shared cache
  // in `@shared/pricing-rates`. Without this dep, the dashboard would
  // render once on mount with the static `BUY_IN_RATES` fallback and
  // never update — same fetch, deduped by react-query key.
  const { data: marketRatesData } = useQuery<unknown[]>({
    queryKey: ["/api/property/market-rates"],
  });
  // Trailing-365-day revenue per property (by booking date), refreshed
  // daily by the server property-revenue scheduler. Keyed by the dashboard
  // property id (= operationsPropertyId: positive core ids, negative -draftId
  // for mapped published drafts). Declared HERE — before the `filtered` useMemo
  // — so the sort comparator can close over it without a TDZ error. Only
  // Guesty-connected listings with in-window stays have an entry; everything
  // else is absent → the column renders "—".
  const { data: propertyRevenueData } = useQuery<PropertyRevenueMap>({
    queryKey: ["/api/dashboard/property-revenue"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  // Per-property "Last Price Scan" — when this listing's market-rate pricing
  // table was last refreshed and pushed to Guesty (the weekly market-rate cron,
  // or a manual "Update Market Rates"). Keyed by the dashboard property id
  // (= scanner_schedule.propertyId, the positive core id). Declared HERE — before
  // the `filtered` useMemo — so the sort comparator can close over it. Absent →
  // the column renders "—".
  const { data: priceScanData } = useQuery<LastPriceScanMap>({
    queryKey: ["/api/dashboard/price-scans"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  // Unit Audit Sweep — "Audit" column: last persisted receipt + any live sweep
  // per property. Polls faster while a sweep runs so the badge's stage counter
  // ticks; the dialog itself polls its own job every 3s.
  const { data: unitAuditStatus } = useQuery<UnitAuditDashboardStatus>({
    queryKey: ["/api/dashboard/unit-audit-status"],
    refetchInterval: (query) => (Object.keys(query.state.data?.active ?? {}).length > 0 ? 5_000 : 60_000),
    refetchOnWindowFocus: false,
  });
  // When a sweep FINISHES (a property leaves the active set), refresh the data
  // columns its auto-fix legs write to. Without this, the dashboard's column
  // queries (staleTime + no focus refetch) sit frozen on their page-load
  // snapshot, so an audit that refreshed + pushed rates updated the DB but the
  // "Last Price Scan" cell never moved until a full reload (2026-07-12
  // Coconut Plantation incident). Watching the active SET (not the dialog)
  // also covers bulk "Audit selected" and the weekly cron sweeps, which the
  // operator follows from the column badges with no dialog open.
  const prevActiveAuditIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(Object.keys(unitAuditStatus?.active ?? {}));
    const previous = prevActiveAuditIdsRef.current;
    prevActiveAuditIdsRef.current = current;
    const anyFinished = Array.from(previous).some((id) => !current.has(id));
    if (!anyFinished) return;
    void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/price-scans"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/builder/photo-community-status"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/photo-listing-check"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
  }, [unitAuditStatus?.active]);
  const [unitAuditDialog, setUnitAuditDialog] = useState<{ propertyId: number; propertyName: string } | null>(null);
  // Bulk "Audit selected" — one sweep per checked row, queued server-side one
  // at a time (each sweep is heavy on Lens/SearchAPI/vision budgets). The
  // Audit column badges show queued/running/receipt state per row.
  const [bulkAuditStarting, setBulkAuditStarting] = useState(false);
  const startBulkUnitAudit = async (propertyIds: number[]) => {
    if (propertyIds.length === 0 || bulkAuditStarting) return;
    setBulkAuditStarting(true);
    try {
      const res = await apiRequest("POST", "/api/unit-audit/bulk", {
        propertyIds,
        fullAutomation: true,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const started = Array.isArray(data?.started) ? data.started.length : 0;
      const skipped = Array.isArray(data?.skipped) ? data.skipped.length : 0;
      const firstSkipped = skipped > 0 ? String(data.skipped[0]?.error ?? "").trim() : "";
      toast({
        title: `Audit sweeps queued for ${started} propert${started === 1 ? "y" : "ies"}`,
        description: `They run one at a time server-side — watch the Audit column badges.${skipped > 0 ? ` ${skipped} could not start.${firstSkipped ? ` ${firstSkipped}` : ""}` : ""}`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/unit-audit-status"] });
    } catch (e: any) {
      toast({ title: "Audit sweeps failed to start", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setBulkAuditStarting(false);
    }
  };
  // Guesty listing mapping — drives BOTH the "G" connected-dot column and its
  // sort. Declared HERE — before the `filtered` useMemo — so the sort
  // comparator can close over `guestyConnected` without a TDZ error (the
  // fetch is deduped by react-query key with any later use).
  const { data: guestyMapData } = useQuery<GuestyPropertyMap[]>({
    queryKey: ["/api/guesty-property-map"],
  });
  const guestyConnected = useMemo(() => {
    if (!guestyMapData) return new Set<number>();
    return new Set(guestyMapData.map((m) => m.propertyId));
  }, [guestyMapData]);
  const baseRates = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of allProperties) {
      map.set(p.id, computeBaseRate(p));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProperties, marketRatesData]);

  const communities = useMemo(() => {
    const set = new Set(allProperties.map((p) => p.community));
    return Array.from(set).sort();
  }, [allProperties]);

  const islands = useMemo(() => {
    const set = new Set(allProperties.map((p) => p.island));
    return Array.from(set).sort();
  }, [allProperties]);

  const filtered = useMemo(() => {
    let result = allProperties;
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(lower) ||
          displayPropertyId(p).includes(lower) ||
          p.community.toLowerCase().includes(lower) ||
          p.location.toLowerCase().includes(lower) ||
          p.unitDetails.toLowerCase().includes(lower)
      );
    }
    if (communityFilter !== "all") {
      result = result.filter((p) => p.community === communityFilter);
    }
    if (islandFilter !== "all") {
      result = result.filter((p) => p.island === islandFilter);
    }
    if (multiUnitFilter !== "all") {
      const isMulti = multiUnitFilter === "yes";
      result = result.filter((p) => p.multiUnit === isMulti);
    }
    result = [...result].sort((a, b) => {
      if (sortField === "propertyId") {
        const aId = propertyIdSortValue(a);
        const bId = propertyIdSortValue(b);
        return sortDir === "asc" ? aId - bId : bId - aId;
      }
      if (sortField === "unitCount") {
        const aCount = communityUnitCountSortValue(a);
        const bCount = communityUnitCountSortValue(b);
        return sortDir === "asc" ? aCount - bCount : bCount - aCount;
      }
      if (sortField === "baseRate") {
        const aRate = baseRates.get(a.id) ?? 0;
        const bRate = baseRates.get(b.id) ?? 0;
        return sortDir === "asc" ? aRate - bRate : bRate - aRate;
      }
      if (sortField === "minimumStay") {
        const aStay = typeof a.minimumStayNights === "number" ? a.minimumStayNights : a.minimumStayRangeLow ?? Infinity;
        const bStay = typeof b.minimumStayNights === "number" ? b.minimumStayNights : b.minimumStayRangeLow ?? Infinity;
        return sortDir === "asc" ? aStay - bStay : bStay - aStay;
      }
      if (sortField === "dateAdded") {
        // Rows with no recorded add-date (the core 11 hard-coded properties)
        // always sort to the BOTTOM regardless of direction — they have no
        // value to compare, not an "earliest" one.
        const aT = a.createdAt ? new Date(a.createdAt).getTime() : null;
        const bT = b.createdAt ? new Date(b.createdAt).getTime() : null;
        if (aT === null && bT === null) return 0;
        if (aT === null) return 1;
        if (bT === null) return -1;
        return sortDir === "asc" ? aT - bT : bT - aT;
      }
      if (sortField === "totalRevenue") {
        // Properties with no Guesty-attributed revenue (unmapped listing, or no
        // in-window stays) always sort to the BOTTOM in both directions —
        // absence isn't $0.
        const aR = propertyRevenueData?.[a.id]?.revenue ?? null;
        const bR = propertyRevenueData?.[b.id]?.revenue ?? null;
        if (aR === null && bR === null) return 0;
        if (aR === null) return 1;
        if (bR === null) return -1;
        return sortDir === "asc" ? aR - bR : bR - aR;
      }
      if (sortField === "lastPriceScan") {
        // Never-pushed properties (no scanner_schedule push timestamp) always
        // sort to the BOTTOM in both directions — absence isn't "oldest".
        const at = priceScanData?.[a.id]?.pushedAt;
        const bt = priceScanData?.[b.id]?.pushedAt;
        const aT = at ? new Date(at).getTime() : null;
        const bT = bt ? new Date(bt).getTime() : null;
        if (aT === null && bT === null) return 0;
        if (aT === null) return 1;
        if (bT === null) return -1;
        return sortDir === "asc" ? aT - bT : bT - aT;
      }
      if (sortField === "guestyListed") {
        // Boolean "G" column: asc groups Guesty-connected rows (green dots)
        // first, desc groups unconnected first. Ties keep their prior order
        // (Array.prototype.sort is stable).
        const aC = guestyConnected.has(a.id) ? 0 : 1;
        const bC = guestyConnected.has(b.id) ? 0 : 1;
        return sortDir === "asc" ? aC - bC : bC - aC;
      }
      let aVal: string | number | null = a[sortField as keyof typeof a] as string | number | null;
      let bVal: string | number | null = b[sortField as keyof typeof b] as string | number | null;
      if (aVal === null) aVal = sortDir === "asc" ? Infinity : -Infinity;
      if (bVal === null) bVal = sortDir === "asc" ? Infinity : -Infinity;
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      const numA = aVal as number;
      const numB = bVal as number;
      return sortDir === "asc" ? numA - numB : numB - numA;
    });
    return result;
  }, [allProperties, searchTerm, communityFilter, islandFilter, multiUnitFilter, sortField, sortDir, baseRates, propertyRevenueData, priceScanData, guestyConnected]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    return sortDir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5 shrink-0" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5 shrink-0" />
    );
  };

  const dashboardRows = allProperties;
  const corePropertyCount = activeProperties.length;
  const importedDraftCount = draftsAsProperties.length;
  const dashboardRowCount = dashboardRows.length;
  const propertyCountBreakdown = importedDraftCount
    ? `${corePropertyCount} core + ${importedDraftCount} imported/draft`
    : `${corePropertyCount} core`;
  const avgBedrooms = dashboardRowCount
    ? Math.round((dashboardRows.reduce((s, p) => s + p.bedrooms, 0) / dashboardRowCount) * 10) / 10
    : 0;
  const pricedProperties = dashboardRows.filter((p) => p.lowPrice !== null);
  const avgLow = pricedProperties.length
    ? Math.round(pricedProperties.reduce((s, p) => s + (p.lowPrice || 0), 0) / pricedProperties.length)
    : 0;
  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  const formatShortDate = (value: string | Date | null | undefined) => {
    if (!value) return "N/A";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "N/A";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const formatShortDateTime = (value: string | Date | null | undefined) => {
    if (!value) return "N/A";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "N/A";
    return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  // "Date added" column — month/day/YEAR (the year matters: listings
  // accrue across seasons). Missing/invalid → "—" (the core 11 properties
  // predate per-row tracking).
  const formatDateAdded = (value: string | Date | null | undefined) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const unitBuilderIds = useMemo(() => new Set(getMultiUnitPropertyIds()), []);

  const { data: communityDraftsData } = useQuery<CommunityDraft[]>({
    queryKey: ["/api/community/drafts"],
  });

  // Per-property channel status for the Channels column. Single server call
  // that batches all mapped listings into one Guesty read. Refetches every
  // ~5 min so the dashboard stays roughly current without hammering Guesty.
  type ChannelFlag = { connected: boolean; live: boolean; syncFailed?: boolean };
  type ChannelStatusMap = Record<number, { airbnb: ChannelFlag; vrbo: ChannelFlag; bookingCom: ChannelFlag }>;
  const { data: channelStatusData } = useQuery<ChannelStatusMap>({
    queryKey: ["/api/dashboard/channel-status"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  type RevenueBookingSummary = {
    id: string;
    listingId: string | null;
    guestName: string;
    listingName: string;
    confirmationCode: string | null;
    source: string;
    status: string;
    bookedAt: string;
    checkIn: string | null;
    checkOut: string | null;
    nights: number;
    amount: number;
  };
  type DashboardRevenueSummary = {
    windowDays: number;
    revenue: number;
    fundsCollected30Days?: number;
    paymentsTaken30Days?: number;
    fundsCollected48Hours?: number;
    paymentsTaken48Hours?: number;
    refunds30Days?: number;
    refundCount30Days?: number;
    refunds48Hours?: number;
    refundCount48Hours?: number;
    netCollected30Days?: number;
    netCollected48Hours?: number;
    revenue48Hours?: number;
    bookingCount48Hours?: number;
    // Past-5-day slice + 3-day-average 12-month forecast.
    fundsCollected5Days?: number;
    paymentsTaken5Days?: number;
    refunds5Days?: number;
    netCollected5Days?: number;
    revenue5Days?: number;
    bookingCount5Days?: number;
    fundsCollected3Days?: number;
    revenue3Days?: number;
    fundsCollectedDailyAvg3Days?: number;
    revenueDailyAvg3Days?: number;
    fundsCollectedAnnualProjection?: number;
    revenueAnnualProjection?: number;
    bookingCount: number;
    refunds?: Array<{
      id: string;
      reservationId: string;
      listingId: string | null;
      guestName: string;
      listingName: string;
      confirmationCode: string | null;
      source: string;
      refundedAt: string;
      amount: number;
      description: string;
    }>;
    payments?: Array<{
      id: string;
      reservationId: string;
      listingId: string | null;
      guestName: string;
      listingName: string;
      confirmationCode: string | null;
      source: string;
      paidAt: string;
      amount: number;
      description: string;
    }>;
    // Auto-sent guest payment/refund receipts (the scheduler posted these to
    // guests; see server/guest-receipts.ts).
    guestReceiptsSent30Days?: number;
    guestReceiptPaymentsSent30Days?: number;
    guestReceiptRefundsSent30Days?: number;
    guestReceiptsSent48Hours?: number;
    guestReceipts?: Array<{
      id: number;
      reservationId: string;
      kind: string;
      amount: number;
      guestName: string | null;
      listingNickname: string | null;
      channel: string | null;
      token: string;
      sentAt: string;
      opened: boolean;
      openCount: number;
      // Refund-only SMS leg: "sent" | "error" | "no-phone" | "not-configured" | null
      smsStatus?: string | null;
      smsTo?: string | null;
      smsSentAt?: string | null;
    }>;
    // Refund confirmations that did NOT reach the guest (OTA channel failure
    // and/or the SMS-to-phone leg failed) — operator must resend.
    guestRefundReceiptIssues?: Array<{
      reservationId: string;
      token: string;
      amount: number;
      guestName: string | null;
      listingNickname: string | null;
      channel: string | null;
      status: string;
      createdAt: string;
      errorMessage: string | null;
      smsStatus?: string | null;
      smsError?: string | null;
    }>;
    guestRefundReceiptIssueCount?: number;
    bookings: RevenueBookingSummary[];
    largestBooking: RevenueBookingSummary | null;
    highestGrossingBooking: RevenueBookingSummary | null;
    highestListingEarner: {
      listingId: string;
      listingName: string;
      revenue: number;
      bookingCount: number;
    } | null;
    startDate: string;
    endDate: string;
    windowLabel?: string;
  };
  const { data: revenueSummary, isLoading: revenueSummaryLoading } = useQuery<DashboardRevenueSummary>({
    queryKey: ["/api/dashboard/revenue-30-days"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Failed / uncollected guest payments (14-day retroactive window; cancelled
  // bookings excluded server-side). Drives the auto-opening red warning popup +
  // persistent banner — same pattern as the duplicate-photos warning.
  const { data: paymentFailureData } = useQuery<{
    warnings: PaymentFailureWarning[];
    windowDays: number;
    checkedAt: string;
  }>({
    queryKey: ["/api/dashboard/payment-failures"],
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const paymentFailureWarnings = paymentFailureData?.warnings ?? [];
  const paymentFailureSignature = useMemo(
    () => paymentFailureWarningSignature(paymentFailureWarnings),
    [paymentFailureWarnings],
  );
  useEffect(() => {
    if (!paymentFailureSignature) return;
    let dismissed = "";
    try {
      dismissed = window.localStorage.getItem(PAYMENT_FAILURE_WARNING_DISMISSED_KEY) ?? "";
    } catch {
      // localStorage unavailable (private mode) — the popup just re-raises.
    }
    if (dismissed === paymentFailureSignature) return;
    setPaymentFailureWarningOpen(true);
  }, [paymentFailureSignature]);
  const closePaymentFailureWarning = () => {
    try {
      window.localStorage.setItem(PAYMENT_FAILURE_WARNING_DISMISSED_KEY, paymentFailureSignature);
    } catch {
      // localStorage unavailable — dismissal just won't persist across reloads.
    }
    setPaymentFailureWarningOpen(false);
  };
  // Missing buy-in units for check-ins within the next 15 days (in-house stays
  // included; cancelled bookings excluded server-side). Same red-flag popup +
  // persistent banner pattern as the payment-failure warning.
  const { data: buyInCoverageData } = useQuery<{
    warnings: BuyInCoverageWarning[];
    windowDays: number;
    checkedAt: string;
  }>({
    queryKey: ["/api/dashboard/buyin-coverage"],
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const buyInCoverageWarnings = buyInCoverageData?.warnings ?? [];
  const buyInCoverageSignature = useMemo(
    () => buyInCoverageWarningSignature(buyInCoverageWarnings),
    [buyInCoverageWarnings],
  );
  useEffect(() => {
    if (!buyInCoverageSignature) return;
    let dismissed = "";
    try {
      dismissed = window.localStorage.getItem(BUYIN_COVERAGE_WARNING_DISMISSED_KEY) ?? "";
    } catch {
      // localStorage unavailable (private mode) — the popup just re-raises.
    }
    if (dismissed === buyInCoverageSignature) return;
    setBuyInCoverageWarningOpen(true);
  }, [buyInCoverageSignature]);
  const closeBuyInCoverageWarning = () => {
    try {
      window.localStorage.setItem(BUYIN_COVERAGE_WARNING_DISMISSED_KEY, buyInCoverageSignature);
    } catch {
      // localStorage unavailable — dismissal just won't persist across reloads.
    }
    setBuyInCoverageWarningOpen(false);
  };
  // Arrival-details promise coverage: the automated booking confirmation tells
  // every guest "arrival details ~14 days before check-in", but sending them is
  // manual (Message AD) — this warns when a check-in inside the window has no
  // actual arrival-details message on its Guesty thread (server-scanned with
  // the same matcher the inbox timeline uses). Same popup + banner + dismissal
  // pattern as the buy-in coverage warning above.
  const { data: arrivalCoverageData } = useQuery<{
    warnings: ArrivalDetailsWarning[];
    windowDays: number;
    checkedAt: string;
  }>({
    queryKey: ["/api/dashboard/arrival-details-coverage"],
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const arrivalDetailsWarnings = arrivalCoverageData?.warnings ?? [];
  const arrivalDetailsSignature = useMemo(
    () => arrivalDetailsWarningSignature(arrivalDetailsWarnings),
    [arrivalDetailsWarnings],
  );
  useEffect(() => {
    if (!arrivalDetailsSignature) return;
    let dismissed = "";
    try {
      dismissed = window.localStorage.getItem(ARRIVAL_DETAILS_WARNING_DISMISSED_KEY) ?? "";
    } catch {
      // localStorage unavailable (private mode) — the popup just re-raises.
    }
    if (dismissed === arrivalDetailsSignature) return;
    setArrivalDetailsWarningOpen(true);
  }, [arrivalDetailsSignature]);
  const closeArrivalDetailsWarning = () => {
    try {
      window.localStorage.setItem(ARRIVAL_DETAILS_WARNING_DISMISSED_KEY, arrivalDetailsSignature);
    } catch {
      // localStorage unavailable — dismissal just won't persist across reloads.
    }
    setArrivalDetailsWarningOpen(false);
  };
  // Misrouted booking confirmations — the automated greeting was posted but
  // filed OFF the guest's OTA channel, and the scheduler never retries one
  // (AGENTS.md #51), so without this alert the guest silently never gets
  // greeted. Remediation is the per-row Resend button (manual force-send).
  const { data: confirmationIssuesData } = useQuery<{
    issues: Array<{
      id: number;
      reservationId: string;
      guestName: string | null;
      listingNickname: string | null;
      channel: string | null;
      status: string;
      errorMessage: string | null;
      sentAt: string;
    }>;
    checkedAt: string;
  }>({
    queryKey: ["/api/dashboard/booking-confirmation-issues"],
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const confirmationIssues = confirmationIssuesData?.issues ?? [];
  const confirmationIssuesSignature = useMemo(
    () =>
      confirmationIssues
        .map((i) => `${i.reservationId}:${i.status}:${i.sentAt}`)
        .sort()
        .join(";"),
    [confirmationIssues],
  );
  useEffect(() => {
    if (!confirmationIssuesSignature) return;
    let dismissed = "";
    try {
      dismissed = window.localStorage.getItem(CONFIRMATION_ISSUES_DISMISSED_KEY) ?? "";
    } catch {
      // localStorage unavailable (private mode) — the popup just re-raises.
    }
    if (dismissed === confirmationIssuesSignature) return;
    setConfirmationIssuesOpen(true);
  }, [confirmationIssuesSignature]);
  const closeConfirmationIssues = () => {
    try {
      window.localStorage.setItem(CONFIRMATION_ISSUES_DISMISSED_KEY, confirmationIssuesSignature);
    } catch {
      // localStorage unavailable — dismissal just won't persist across reloads.
    }
    setConfirmationIssuesOpen(false);
  };
  // Direct fetch (not apiRequest) so the 409/502 body's `detail` reaches the
  // toast — apiRequest throws on non-2xx and drops the structured reason (see
  // the apirequest-throws-on-non-2xx memory / PR #896).
  const resendBookingConfirmationFor = async (reservationId: string) => {
    setConfirmationResendPending((s) => ({ ...s, [reservationId]: true }));
    try {
      const res = await fetch("/api/inbox/booking-confirmations/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (res.ok && data?.ok) {
        toast({ title: "Confirmation resent", description: data.detail || "Delivered to the guest's booking channel." });
      } else {
        toast({
          title: "Resend failed",
          description: data?.detail || data?.error || `HTTP ${res.status}`,
          variant: "destructive",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/booking-confirmation-issues"] });
    } catch (err: any) {
      toast({ title: "Resend failed", description: err?.message ?? "Network error", variant: "destructive" });
    } finally {
      setConfirmationResendPending((s) => ({ ...s, [reservationId]: false }));
    }
  };
  // Card payments captured through Guesty settle into the bank ~5 business days
  // after capture, so each collected payment is projected forward to its
  // expected deposit date. This surfaces the next bank deposit (amount + date)
  // plus a per-day schedule, computed client-side from the same `payments` list
  // the funds-collected tile already loads.
  //
  // The schedule window spans 12 calendar days (today + the next ~2 weeks). A
  // 5-business-day settlement is ~7 calendar days out, so the freshest captures
  // (e.g. the "in last 48h" payments) deposit BEYOND a 5-day window — the
  // 12-day window guarantees every still-pending deposit from a recent payment
  // is shown, not just the ones landing in the next few days.
  const DEPOSIT_SETTLEMENT_BUSINESS_DAYS = 5;
  const DEPOSIT_SCHEDULE_WINDOW_DAYS = 12;
  const addBusinessDays = (start: Date, businessDays: number) => {
    const result = new Date(start);
    let added = 0;
    while (added < businessDays) {
      result.setDate(result.getDate() + 1);
      const day = result.getDay();
      if (day !== 0 && day !== 6) added += 1; // skip Sat/Sun
    }
    return result;
  };
  const depositProjection = useMemo(() => {
    const payments = revenueSummary?.payments ?? [];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    // Bucket expected deposits by local calendar day; drop deposits that would
    // already have landed (deposit date before today).
    const byDay = new Map<string, { date: Date; amount: number; count: number }>();
    for (const payment of payments) {
      const paidAt = new Date(payment.paidAt);
      if (Number.isNaN(paidAt.getTime())) continue;
      const depositDate = addBusinessDays(paidAt, DEPOSIT_SETTLEMENT_BUSINESS_DAYS);
      depositDate.setHours(0, 0, 0, 0);
      if (depositDate < todayStart) continue;
      const key = dayKey(depositDate);
      const entry = byDay.get(key) ?? { date: depositDate, amount: 0, count: 0 };
      entry.amount += payment.amount;
      entry.count += 1;
      byDay.set(key, entry);
    }
    const nextDeposit =
      Array.from(byDay.values()).sort((a, b) => a.date.getTime() - b.date.getTime())[0] ?? null;
    const scheduleDays = Array.from({ length: DEPOSIT_SCHEDULE_WINDOW_DAYS }, (_, i) => {
      const date = new Date(todayStart);
      date.setDate(date.getDate() + i);
      const entry = byDay.get(dayKey(date));
      return { date, amount: entry?.amount ?? 0, count: entry?.count ?? 0 };
    });
    const scheduleTotal = scheduleDays.reduce((sum, d) => sum + d.amount, 0);
    return { nextDeposit, scheduleDays, scheduleTotal };
  }, [revenueSummary?.payments]);
  const propertyNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const property of allProperties) map.set(property.id, property.name);
    return map;
  }, [allProperties]);
  const highestListingEarnerName = useMemo(() => {
    const listingId = revenueSummary?.highestListingEarner?.listingId;
    if (!listingId) return revenueSummary?.highestListingEarner?.listingName ?? null;
    const mapping = guestyMapData?.find((row) => row.guestyListingId === listingId);
    if (!mapping) return revenueSummary?.highestListingEarner?.listingName ?? null;
    return propertyNameById.get(mapping.propertyId) ?? revenueSummary?.highestListingEarner?.listingName ?? null;
  }, [guestyMapData, propertyNameById, revenueSummary?.highestListingEarner]);
  const propertyIdByGuestyListingId = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of guestyMapData ?? []) map.set(row.guestyListingId, row.propertyId);
    return map;
  }, [guestyMapData]);
  const operationsHrefForRevenueTarget = (
    listingId: string | null | undefined,
    reservationId?: string | null,
  ) => {
    const params = new URLSearchParams();
    const mappedPropertyId = listingId ? propertyIdByGuestyListingId.get(listingId) : undefined;
    if (mappedPropertyId) {
      params.set("propertyId", String(mappedPropertyId));
    } else if (listingId) {
      params.set("listingId", listingId);
    }
    if (reservationId) params.set("reservationId", reservationId);
    if (reservationId) params.set("includePast", "true");
    const query = params.toString();
    return query ? `/bookings?${query}` : "/bookings";
  };
  const operationsHrefForBooking = (booking: RevenueBookingSummary | null | undefined) =>
    booking ? operationsHrefForRevenueTarget(booking.listingId, booking.id) : "/bookings";

  const {
    data: cancellationData,
    isLoading: cancellationsLoading,
    isFetching: cancellationsFetching,
  } = useQuery<DashboardCancellationResponse>({
    queryKey: ["/api/dashboard/cancellations"],
    staleTime: 2 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const cancellationRows = useMemo(() => {
    const rows = [...(cancellationData?.audits ?? [])];
    const priority = (row: ReservationCancellationAudit) => {
      if (row.operatorStatus === "needs_review") return 0;
      if (row.refundDecision === "refund_review" || row.refundDecision === "partial_refund") return 1;
      return 2;
    };
    return rows.sort((a, b) => {
      const p = priority(a) - priority(b);
      if (p !== 0) return p;
      return new Date(b.cancelledAt ?? b.updatedAt ?? b.createdAt ?? 0).getTime()
        - new Date(a.cancelledAt ?? a.updatedAt ?? a.createdAt ?? 0).getTime();
    });
  }, [cancellationData]);

  const selectedCancellation = useMemo(() => {
    if (!selectedCancellationId) return null;
    return cancellationRows.find((row) => row.id === selectedCancellationId) ?? null;
  }, [cancellationRows, selectedCancellationId]);

  const selectedCancellationPayments = useMemo(
    () => parseJsonArray(selectedCancellation?.paymentsJson),
    [selectedCancellation],
  );
  const selectedCancellationRefunds = useMemo(
    () => parseJsonArray(selectedCancellation?.refundsJson),
    [selectedCancellation],
  );

  const cancellationSummary = cancellationData?.summary ?? {
    total: 0,
    paymentTaken: 0,
    reviewNeeded: 0,
    resolved: 0,
    exposure: 0,
    lastSyncedAt: null,
  };
  const cancellationWindowDays = cancellationData?.windowDays ?? 30;

  const cancellationScanMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/dashboard/cancellations/scan", { range: "30" }).then((r) => r.json()),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/cancellations"] });
      toast({
        title: "Cancelled bookings refreshed",
        description: `${data?.saved ?? 0} audit row${data?.saved === 1 ? "" : "s"} refreshed from Guesty.`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Cancellation refresh failed",
        description: error?.message ?? "Guesty could not be scanned for cancelled bookings.",
        variant: "destructive",
      });
    },
  });

  // Resolve a cancellation: stamps operatorStatus on the audit row via the
  // existing PATCH endpoint. "refunded" / "no_refund_due" both drop the row out
  // of `reviewNeeded`, so the "guest cancelled — payment on file" alert clears.
  const [resolvingCancellationId, setResolvingCancellationId] = useState<number | null>(null);
  const cancellationResolveMutation = useMutation({
    mutationFn: ({ id, operatorStatus, operatorNotes }: { id: number; operatorStatus: string; operatorNotes?: string }) =>
      apiRequest("PATCH", `/api/operations/cancellations/${id}`, { operatorStatus, operatorNotes }).then((r) => r.json()),
    onMutate: ({ id }) => setResolvingCancellationId(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/cancellations"] });
      const title = variables.operatorStatus === "refunded"
        ? "Refund confirmed"
        : variables.operatorStatus === "needs_review"
          ? "Reopened for review"
          : "Cancellation resolved";
      const description = variables.operatorStatus === "refunded"
        ? "Marked refunded — this booking will drop off the refund alert."
        : variables.operatorStatus === "needs_review"
          ? "Moved back to needs-review; it returns to the alert if money is still on file."
          : "Marked resolved — cleared from the refund alert.";
      toast({ title, description });
    },
    onError: (error: any) => {
      toast({
        title: "Could not update cancellation",
        description: error?.message ?? "The refund status change did not save.",
        variant: "destructive",
      });
    },
    onSettled: () => setResolvingCancellationId(null),
  });

  // Cancellations where money was taken and not (fully) refunded AND the
  // operator hasn't resolved them yet — the actionable "issue a refund" set
  // that drives the dashboard alert banner.
  const refundAlertRows = useMemo(
    () => cancellationRows.filter((row) =>
      row.operatorStatus === "needs_review" && moneyNumber(row.totalPaid) > moneyNumber(row.totalRefunded)
    ),
    [cancellationRows],
  );

  // Reverse-image-search status for the Photo Match column. One row
  // per photo folder. The per-property status is the WORST across that
  // property's folders. FOUND beats CLEAN/UNKNOWN because a match on
  // any one folder is what Jamie cares about; UNKNOWN is inconclusive,
  // not match evidence.
  type PhotoStatus = "clean" | "found" | "unknown";
  // `verified` marks a match that passed the scanner's FULL cross-validation (community +
  // unit-number-in-page-text). One verified match on a "clean" platform renders the display-only
  // amber REVIEW badge (subThresholdVerifiedMatches) — below the 2-photo red threshold, so it never
  // raises the red duplicate-photos popup and never feeds the auto-replace machinery.
  type PhotoMatchRow = { photoUrl: string; listingUrl: string; title: string; source: string; verified?: boolean };
  type PhotoCheckRow = {
    folder: string;
    airbnbStatus: PhotoStatus;
    vrboStatus: PhotoStatus;
    bookingStatus: PhotoStatus;
    airbnbMatches: PhotoMatchRow[];
    vrboMatches:   PhotoMatchRow[];
    bookingMatches: PhotoMatchRow[];
    airbnbAddressStatus?: PhotoStatus;
    vrboAddressStatus?: PhotoStatus;
    bookingAddressStatus?: PhotoStatus;
    addressMatches?: Array<{ platform: string; url: string; title: string; snippet: string }>;
    photosChecked: number;
    checkedAt: string | null;
    errorMessage: string | null;
  };
  type ActivePhotoFolderAlias = {
    propertyId: number;
    oldUnitId: string;
    originalFolder: string;
    activeFolder: string;
  };
  const isPhotoProviderUnavailableError = (message?: string | null) => {
    const text = (message ?? "").toLowerCase();
    if (!text.includes("searchapi")) return false;
    return (
      text.includes("http 429") ||
      text.includes("throttled or rejected") ||
      text.includes("used all of the searches") ||
      text.includes("timed out") ||
      text.includes("request failed") ||
      text.includes("not configured")
    );
  };
  const photoCheckErrorPreview = (message?: string | null) => {
    if (!message) return "";
    const text = message.toLowerCase();
    const cleaned = (text.includes("google lens/searchapi http 429") ||
      text.includes("used all of the searches") ||
      text.includes("upgrade your plan on searchapi.io"))
      ? message.replace(
        /Google Lens\/SearchAPI HTTP 429(?::.*?)(?=(?:;|$|\s+\(kept previous status))/i,
        "Google Lens/SearchAPI HTTP 429: SearchAPI throttled or rejected the Lens request; this is not proof that the monthly search balance is exhausted. Retry the scan.",
      )
      : message;
    return cleaned.replace(/\s+/g, " ").slice(0, 180);
  };
  const { data: photoCheckData } = useQuery<{ checks: PhotoCheckRow[]; activeFolderAliases?: ActivePhotoFolderAlias[] }>({
    queryKey: ["/api/photo-listing-check"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: () => Date.now() < photoScanPollUntil ? (photoScanModalOpen || duplicatePhotoWarningOpen ? 4_000 : 10_000) : false,
  });

  type PhotoCommunityStatusResponse = {
    statuses: Record<string, PhotoCommunityRowStatus>;
    activeJob: BulkPhotoCommunityJob | null;
  };
  const bulkPhotoCommunityActive =
    bulkPhotoCommunityJob?.status === "queued" || bulkPhotoCommunityJob?.status === "running";
  const { data: photoCommunityStatusData } = useQuery<PhotoCommunityStatusResponse>({
    queryKey: ["/api/builder/photo-community-status"],
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: bulkPhotoCommunityActive ? 8_000 : false,
  });
  const photoCommunityByProperty = useMemo(() => {
    const map = new Map<number, PhotoCommunityRowStatus>();
    for (const [k, v] of Object.entries(photoCommunityStatusData?.statuses ?? {})) {
      const id = Number(k);
      if (Number.isFinite(id)) map.set(id, v);
    }
    return map;
  }, [photoCommunityStatusData]);

  useEffect(() => {
    const active = photoCommunityStatusData?.activeJob;
    if (active && !bulkPhotoCommunityJob?.id) {
      setBulkPhotoCommunityJob(active);
    }
  }, [photoCommunityStatusData?.activeJob, bulkPhotoCommunityJob?.id]);

  useEffect(() => {
    if (!bulkPhotoCommunityJob?.id || !bulkPhotoCommunityActive) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/builder/bulk-photo-community-check/${bulkPhotoCommunityJob.id}`, { credentials: "include" });
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled) return;
        setBulkPhotoCommunityJob(data.job);
        if (data.job.status === "completed" || data.job.status === "failed" || data.job.status === "cancelled") {
          queryClient.invalidateQueries({ queryKey: ["/api/builder/photo-community-status"] });
        }
      } catch {
        // best-effort poll
      }
    };
    void poll();
    const timer = window.setInterval(poll, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bulkPhotoCommunityJob?.id, bulkPhotoCommunityActive, queryClient]);

  // PR #318: photo-listing alerts UI moved into the listing builder's
  // PhotoSyncStatusPanel (per channel row). The dashboard banner +
  // its master-sync-only "Replace & push" button were ripped out
  // because they couldn't represent the per-channel decision: an
  // Airbnb alert needs master-sync remediation (Airbnb stays
  // connected to Guesty), but a VRBO/Booking alert needs the
  // sidecar Isolate + Replace + Disconnect flow with the right
  // ordering (isolatable channels first, Airbnb last so its master
  // push doesn't fan out to channels you wanted to manage
  // independently). All of that lives next to the
  // already-channel-shaped buttons in the builder now.

  const photoCheckByFolder = useMemo(() => {
    const map = new Map<string, PhotoCheckRow>();
    for (const r of photoCheckData?.checks ?? []) map.set(r.folder, r);
    return map;
  }, [photoCheckData]);

  const activePhotoFolderByOriginal = useMemo(() => {
    const map = new Map<string, string>();
    for (const alias of photoCheckData?.activeFolderAliases ?? []) {
      if (!alias.originalFolder || !alias.activeFolder) continue;
      map.set(`${alias.propertyId}:${alias.originalFolder}`, alias.activeFolder);
    }
    return map;
  }, [photoCheckData]);

  // Aggregate folder-level rows into property-level status.
  // Returns { airbnb, vrbo, booking } for each property; each value is
  // the worst across that property's folders (priority: found > unknown > clean).
  // `null` = no data yet for any of this property's folders (never scanned).
  type PhotoAggStatus = PhotoStatus | null;
  type PhotoAgg = {
    airbnb: PhotoAggStatus;
    vrbo: PhotoAggStatus;
    booking: PhotoAggStatus;
    lastCheckedAt: string | null;
    matchCounts: { airbnb: number; vrbo: number; booking: number };
    matchedUnits: {
      airbnb: PhotoMatchedUnit[];
      vrbo: PhotoMatchedUnit[];
      booking: PhotoMatchedUnit[];
    };
    // REVIEW tier (display-only): verified sub-threshold matches — a platform that stayed "clean"
    // (below the 2-photo red bar) but has >=1 FULLY-VERIFIED match. Renders an amber "!" badge;
    // deliberately excluded from duplicateUnits so it never raises the red popup or any auto-fix.
    reviewCounts: { airbnb: number; vrbo: number; booking: number };
    reviewUnits: {
      airbnb: PhotoMatchedUnit[];
      vrbo: PhotoMatchedUnit[];
      booking: PhotoMatchedUnit[];
    };
    // Address-on-OTA leg: worst per-platform status + total address matches.
    addr: { airbnb: PhotoAggStatus; vrbo: PhotoAggStatus; booking: PhotoAggStatus };
    addressMatchCount: number;
    // Per-folder duplicate-photo detail feeding the warning popup: every
    // folder whose PHOTO status is FOUND on at least one OTA (address-only
    // hits are excluded — the popup's remedy is "replace the photos").
    duplicateUnits: Array<{
      folder: string;
      unitLabel: string;
      platforms: DuplicatePhotoPlatform[];
      matchCount: number;
      checkedAt: string | null;
    }>;
    // Per-folder ADDRESS-on-OTA hits feeding the SEPARATE address-alert popup:
    // every folder whose street address status is FOUND on at least one OTA.
    // Kept apart from duplicateUnits because the remedy is an OTA takedown, not
    // "replace the photos".
    addressUnits: Array<{
      folder: string;
      unitLabel: string;
      platforms: AddressAlertPlatform[];
      matches: AddressMatchRow[];
      checkedAt: string | null;
    }>;
    hasScannableFolders: boolean;
    folders: string[];
    checkedRows: number;
    errorMessages: string[];
    hasProviderError: boolean;
  };
  type PhotoPlatform = keyof PhotoAgg["matchedUnits"];
  type PhotoUnitOwner = { label: string; detailLabel: string };
  type PhotoMatchedUnit = PhotoUnitOwner & { folder: string; matches: number };
  const photoByProperty = useMemo(() => {
    const out = new Map<number, PhotoAgg>();
    const draftsByPropertyId = new Map<number, CommunityDraft>();
    for (const d of communityDraftsDataForRows ?? []) draftsByPropertyId.set(-d.id, d);
    const worst = (a: PhotoAggStatus, b: PhotoStatus): PhotoAggStatus => {
      const rank = (s: PhotoAggStatus) => s === "found" ? 3 : s === "unknown" ? 2 : s === "clean" ? 1 : 0;
      return rank(b) > rank(a) ? b : a;
    };
    const unitLaneLabel = (index: number) => index === 0 ? "Unit A" : index === 1 ? "Unit B" : `Unit ${index + 1}`;
    const unitOwner = (index: number, unitNumber?: string | null): PhotoUnitOwner => {
      const label = unitLaneLabel(index);
      const number = unitNumber?.trim();
      return { label, detailLabel: number ? `${label} (${number})` : label };
    };
    for (const p of allProperties) {
      const builder = getUnitBuilderByPropertyId(p.id);
      const folderSet = new Set<string>();
      const folderOwners = new Map<string, Map<string, PhotoUnitOwner>>();
      const addFolder = (folder?: string | null, owner?: PhotoUnitOwner) => {
        if (!folder || !isScannableFolder(folder)) return;
        folderSet.add(folder);
        if (!owner) return;
        if (!folderOwners.has(folder)) folderOwners.set(folder, new Map());
        folderOwners.get(folder)!.set(owner.label, owner);
      };
      if (builder) {
        // Unit folders only. communityPhotoFolder is excluded (shared
        // amenities, no unit signal). isScannableFolder consults the
        // FOLDER_UNIT_TOKENS map first and the folder-name hint
        // second, so any folder the scanner can verify against — by
        // name OR by canonical claim — qualifies. Folders the
        // scanner skips (no map entry AND no digit hint) drop out
        // here too, keeping the dashboard aggregation in lockstep
        // with what was scanned.
        builder.units.forEach((u, index) => {
          const activeFolder = u.photoFolder
            ? activePhotoFolderByOriginal.get(`${p.id}:${u.photoFolder}`) ?? u.photoFolder
            : u.photoFolder;
          addFolder(activeFolder, unitOwner(index, u.unitNumber));
        });
      }
      const draft = draftsByPropertyId.get(p.id);
      if (draft) {
        addFolder(draft.unit1PhotoFolder, unitOwner(0));
        if ((draft as any).singleListing !== true) addFolder(draft.unit2PhotoFolder, unitOwner(1));
      }
      if (p.draftId !== undefined) {
        // Conventional folder names are a FALLBACK for drafts whose folder
        // fields haven't loaded/persisted — never in ADDITION to a set field.
        // Adding them unconditionally kept ABANDONED pre-replacement folders
        // in the scan set forever (Waikoloa draft-12-unit-b stayed flagged
        // after the unit was replaced and repointed to its replacement-*
        // folder — builder properties only scan the ACTIVE folder after a
        // swap, and drafts must match).
        if (!draft?.unit1PhotoFolder) addFolder(`draft-${p.draftId}-unit-a`, unitOwner(0));
        if (p.multiUnit && !draft?.unit2PhotoFolder) addFolder(`draft-${p.draftId}-unit-b`, unitOwner(1));
      }
      const folders = Array.from(folderSet);
      let agg: PhotoAgg = {
        airbnb: null,
        vrbo: null,
        booking: null,
        lastCheckedAt: null,
        matchCounts: { airbnb: 0, vrbo: 0, booking: 0 },
        matchedUnits: { airbnb: [], vrbo: [], booking: [] },
        reviewCounts: { airbnb: 0, vrbo: 0, booking: 0 },
        reviewUnits: { airbnb: [], vrbo: [], booking: [] },
        addr: { airbnb: null, vrbo: null, booking: null },
        addressMatchCount: 0,
        duplicateUnits: [],
        addressUnits: [],
        hasScannableFolders: folders.length > 0,
        folders,
        checkedRows: 0,
        errorMessages: [],
        hasProviderError: false,
      };
      const addMatchedUnits = (platform: PhotoPlatform, folder: string, matches: number) => {
        if (matches <= 0) return;
        const owners = Array.from(folderOwners.get(folder)?.values() ?? []);
        const affected = owners.length > 0
          ? owners
          : [{ label: "Unit folder", detailLabel: folder }];
        for (const owner of affected) {
          const existing = agg.matchedUnits[platform].find((unit) => unit.label === owner.label);
          if (existing) {
            existing.matches += matches;
          } else {
            agg.matchedUnits[platform].push({ ...owner, folder, matches });
          }
        }
      };
      const addReviewUnits = (platform: PhotoPlatform, folder: string, matches: number) => {
        if (matches <= 0) return;
        agg.reviewCounts[platform] += matches;
        const owners = Array.from(folderOwners.get(folder)?.values() ?? []);
        const affected = owners.length > 0
          ? owners
          : [{ label: "Unit folder", detailLabel: folder }];
        for (const owner of affected) {
          const existing = agg.reviewUnits[platform].find((unit) => unit.label === owner.label);
          if (existing) {
            existing.matches += matches;
          } else {
            agg.reviewUnits[platform].push({ ...owner, folder, matches });
          }
        }
      };
      for (const f of folders) {
        const row = photoCheckByFolder.get(f);
        if (!row) continue;
        agg.checkedRows += 1;
        agg.airbnb  = worst(agg.airbnb,  row.airbnbStatus);
        agg.vrbo    = worst(agg.vrbo,    row.vrboStatus);
        agg.booking = worst(agg.booking, row.bookingStatus);
        // The address-on-OTA leg aggregates DIFFERENTLY from the photo leg. A
        // folder whose address check was SKIPPED (no resolvable unit street —
        // every community-*/amenity folder, plus unit folders with no saved
        // address) reports "unknown", and must NOT mask a real clean/found
        // result from a sibling unit folder. worst()'s unknown>clean ranking is
        // correct for the PHOTO leg (an inconclusive Lens result should surface)
        // but here it let a single community folder paint the whole property's
        // 📍 row grey — hiding that the actual units are address-clean. So fold
        // ONLY meaningful clean/found statuses and skip unknown/null. A property
        // with no address-checkable folder keeps addr=null → the 📍 row is
        // hidden (hasAddrData) instead of rendering an alarming all-grey row.
        const foldAddr = (cur: PhotoAggStatus, next: PhotoStatus | null | undefined): PhotoAggStatus =>
          next === "clean" || next === "found" ? worst(cur, next) : cur;
        agg.addr.airbnb  = foldAddr(agg.addr.airbnb,  row.airbnbAddressStatus);
        agg.addr.vrbo    = foldAddr(agg.addr.vrbo,    row.vrboAddressStatus);
        agg.addr.booking = foldAddr(agg.addr.booking, row.bookingAddressStatus);
        agg.addressMatchCount += row.addressMatches?.length ?? 0;
        agg.matchCounts.airbnb  += row.airbnbMatches?.length  ?? 0;
        agg.matchCounts.vrbo    += row.vrboMatches?.length    ?? 0;
        agg.matchCounts.booking += row.bookingMatches?.length ?? 0;
        addMatchedUnits("airbnb", f, row.airbnbMatches?.length ?? 0);
        addMatchedUnits("vrbo", f, row.vrboMatches?.length ?? 0);
        addMatchedUnits("booking", f, row.bookingMatches?.length ?? 0);
        // Review tier: verified matches on a NOT-found platform (one photo short of the red bar).
        addReviewUnits("airbnb", f, subThresholdVerifiedMatches(row.airbnbStatus, row.airbnbMatches));
        addReviewUnits("vrbo", f, subThresholdVerifiedMatches(row.vrboStatus, row.vrboMatches));
        addReviewUnits("booking", f, subThresholdVerifiedMatches(row.bookingStatus, row.bookingMatches));
        const foundPlatforms: DuplicatePhotoPlatform[] = [];
        if (row.airbnbStatus === "found") foundPlatforms.push("airbnb");
        if (row.vrboStatus === "found") foundPlatforms.push("vrbo");
        if (row.bookingStatus === "found") foundPlatforms.push("booking");
        if (foundPlatforms.length > 0) {
          const owners = Array.from(folderOwners.get(f)?.values() ?? []);
          agg.duplicateUnits.push({
            folder: f,
            unitLabel: owners.length > 0 ? owners.map((o) => o.detailLabel).join(" + ") : f,
            platforms: foundPlatforms,
            matchCount:
              (row.airbnbMatches?.length ?? 0) +
              (row.vrboMatches?.length ?? 0) +
              (row.bookingMatches?.length ?? 0),
            checkedAt: row.checkedAt,
          });
        }
        // Address-on-OTA leg → separate popup (takedown, not replace-photos).
        const addressFound = addressFoundPlatforms({
          airbnb: row.airbnbAddressStatus,
          vrbo: row.vrboAddressStatus,
          booking: row.bookingAddressStatus,
        });
        if (addressFound.length > 0) {
          const owners = Array.from(folderOwners.get(f)?.values() ?? []);
          agg.addressUnits.push({
            folder: f,
            unitLabel: owners.length > 0 ? owners.map((o) => o.detailLabel).join(" + ") : f,
            platforms: addressFound,
            matches: (row.addressMatches ?? []) as AddressMatchRow[],
            checkedAt: row.checkedAt,
          });
        }
        if (row.errorMessage && !agg.errorMessages.includes(row.errorMessage)) {
          agg.errorMessages.push(row.errorMessage);
        }
        if (isPhotoProviderUnavailableError(row.errorMessage)) {
          agg.hasProviderError = true;
        }
        if (row.checkedAt && (!agg.lastCheckedAt || row.checkedAt > agg.lastCheckedAt)) {
          agg.lastCheckedAt = row.checkedAt;
        }
      }
      out.set(p.id, agg);
    }
    return out;
  }, [allProperties, activePhotoFolderByOriginal, communityDraftsDataForRows, photoCheckByFolder]);

  // Duplicate-photos warning popup — one row per unit folder whose photos
  // were FOUND on Airbnb / VRBO / Booking.com. De-duped by folder because a
  // draft alias can surface the same folder under two dashboard rows.
  const duplicatePhotoUnits = useMemo(() => {
    const out: Array<{
      propertyId: number;
      propertyName: string;
      folder: string;
      unitLabel: string;
      platforms: DuplicatePhotoPlatform[];
      matchCount: number;
      checkedAt: string | null;
    }> = [];
    const seen = new Set<string>();
    for (const p of allProperties) {
      const agg = photoByProperty.get(p.id);
      for (const u of agg?.duplicateUnits ?? []) {
        if (seen.has(u.folder)) continue;
        seen.add(u.folder);
        out.push({ propertyId: p.id, propertyName: p.name, ...u });
      }
    }
    return out;
  }, [allProperties, photoByProperty]);
  const duplicatePhotoSignature = useMemo(
    () => duplicatePhotoWarningSignature(duplicatePhotoUnits),
    [duplicatePhotoUnits],
  );
  // Auto-raise the popup when duplicates exist and the operator hasn't
  // dismissed THIS exact set of facts yet (same pattern as the refund alert:
  // loud when actionable, silent once handled). Dismissal is persisted in
  // closeDuplicatePhotoWarning below.
  useEffect(() => {
    if (!duplicatePhotoSignature) return;
    let dismissed = "";
    try {
      dismissed = window.localStorage.getItem(DUPLICATE_PHOTO_WARNING_DISMISSED_KEY) ?? "";
    } catch {
      // localStorage unavailable (private mode) — the popup just re-raises.
    }
    if (dismissed === duplicatePhotoSignature) return;
    setDuplicatePhotoWarningOpen(true);
  }, [duplicatePhotoSignature]);
  const closeDuplicatePhotoWarning = () => {
    try {
      window.localStorage.setItem(DUPLICATE_PHOTO_WARNING_DISMISSED_KEY, duplicatePhotoSignature);
    } catch {
      // localStorage unavailable — dismissal just won't persist across reloads.
    }
    setDuplicatePhotoWarningOpen(false);
  };

  // ── Address-on-OTA alert popup (Phase 3) ───────────────────────────────────
  // Same dismissal pattern as the duplicate-photos popup, but a SEPARATE surface:
  // when a unit's street address (not its photos) turns up on someone else's
  // Airbnb / VRBO / Booking listing, the remedy is an OTA takedown, so this popup
  // links the offending listings to report rather than offering "Replace photos".
  const addressAlertUnits = useMemo(() => {
    const out: Array<{
      propertyId: number;
      propertyName: string;
      folder: string;
      unitLabel: string;
      platforms: AddressAlertPlatform[];
      matches: AddressMatchRow[];
      checkedAt: string | null;
    }> = [];
    const seen = new Set<string>();
    for (const p of allProperties) {
      const agg = photoByProperty.get(p.id);
      for (const u of agg?.addressUnits ?? []) {
        if (seen.has(u.folder)) continue;
        seen.add(u.folder);
        out.push({ propertyId: p.id, propertyName: p.name, ...u });
      }
    }
    return out;
  }, [allProperties, photoByProperty]);
  const addressAlertSignature = useMemo(
    () => addressAlertWarningSignature(addressAlertUnits),
    [addressAlertUnits],
  );
  useEffect(() => {
    if (!addressAlertSignature) return;
    let dismissed = "";
    try {
      dismissed = window.localStorage.getItem(ADDRESS_ALERT_WARNING_DISMISSED_KEY) ?? "";
    } catch {
      // localStorage unavailable — the popup just re-raises.
    }
    if (dismissed === addressAlertSignature) return;
    setAddressAlertWarningOpen(true);
  }, [addressAlertSignature]);
  const closeAddressAlertWarning = () => {
    try {
      window.localStorage.setItem(ADDRESS_ALERT_WARNING_DISMISSED_KEY, addressAlertSignature);
    } catch {
      // localStorage unavailable — dismissal just won't persist across reloads.
    }
    setAddressAlertWarningOpen(false);
  };

  // ── "Replace photos (Unit X)" wiring for the duplicate-photos popup ────────
  // Builder-like shape for the replace flow: the real builder for the core
  // properties (positive ids), or one synthesized from the community_drafts
  // row for promoted drafts (negative ids). 2026-07-05: draft rows previously
  // returned [] here ("their replacement flow lives in the builder
  // pre-flight") — which left flagged drafts like Waikoloa Villas with NO
  // Replace photos button at all. The server orchestrator + unit-swaps +
  // draft repoint (PATCH /api/unit-swaps/commit) all support negative ids,
  // so drafts now get the same one-click/manual actions.
  type ReplaceBuilderLike = {
    propertyName: string;
    complexName: string;
    address: string;
    communityPhotoFolder: string;
    units: Array<{ id: string; unitNumber: string; bedrooms: number; photoFolder?: string }>;
  };
  const replaceBuilderLikeFor = (propertyId: number): ReplaceBuilderLike | null => {
    if (propertyId > 0) {
      const builder = getUnitBuilderByPropertyId(propertyId);
      if (!builder?.communityPhotoFolder) return null;
      return {
        propertyName: builder.propertyName || builder.complexName,
        complexName: builder.complexName,
        address: builder.address ?? "",
        communityPhotoFolder: builder.communityPhotoFolder,
        units: builder.units.map((u) => ({
          id: u.id,
          unitNumber: u.unitNumber ?? "",
          bedrooms: u.bedrooms,
          photoFolder: u.photoFolder,
        })),
      };
    }
    const draft = (communityDraftsDataForRows ?? []).find((d) => -d.id === propertyId);
    if (!draft) return null;
    // Unit ids/folders mirror adapt-draft.ts (`draft<id>-unit-a/b`); the
    // unitNumber stays "" so labels read "Unit A", not "Unit A (A)".
    const units: ReplaceBuilderLike["units"] = [{
      id: draftUnitIdForSlot(draft.id, "a"),
      unitNumber: "",
      bedrooms: resolveDraftUnitBedrooms(draft, "unit1"),
      photoFolder: draft.unit1PhotoFolder ?? `draft-${draft.id}-unit-a`,
    }];
    if ((draft as any).singleListing !== true) {
      units.push({
        id: draftUnitIdForSlot(draft.id, "b"),
        unitNumber: "",
        bedrooms: resolveDraftUnitBedrooms(draft, "unit2"),
        photoFolder: draft.unit2PhotoFolder ?? `draft-${draft.id}-unit-b`,
      });
    }
    return {
      propertyName: draft.name,
      complexName: draft.name,
      address: [draft.streetAddress, draft.city, draft.state].filter(Boolean).join(", "),
      communityPhotoFolder: resolveCanonicalCommunityPhotoFolder(draft.name) ?? `community-draft-${draft.id}`,
      units,
    };
  };

  // Resolve a flagged folder back to EVERY unit it serves — some properties
  // share one folder between Unit A and Unit B (mauna-kai-t3, kaiulani-52),
  // and the operator needs a Replace button PER unit, not just the first
  // match. The folder may also already BE a replacement-* folder if a prior
  // swap's photos got flagged again.
  const resolveReplacePhotosUnits = (propertyId: number, folder: string) => {
    const builderLike = replaceBuilderLikeFor(propertyId);
    if (!builderLike) return [];
    const ref = replacementPhotoFolderRef(folder);
    const out: Array<{ unit: ReplaceBuilderLike["units"][number]; index: number; letter: string }> = [];
    builderLike.units.forEach((u, i) => {
      const active = u.photoFolder
        ? activePhotoFolderByOriginal.get(`${propertyId}:${u.photoFolder}`) ?? u.photoFolder
        : undefined;
      const owns = u.photoFolder === folder
        || active === folder
        // String-compare covers draft replacement folders too —
        // replacementPhotoFolderRef only parses positive-id folder names.
        || replacementPhotoFolderForUnit(propertyId, u.id) === folder
        || (ref ? u.id === ref.oldUnitId : false);
      if (!owns) return;
      out.push({ unit: u, index: i, letter: `Unit ${String.fromCharCode(65 + i)}` });
    });
    return out;
  };

  // Per-unit photo galleries for a flagged folder, so the popup can attribute
  // each offending listing to Unit A vs Unit B by the matched photo's
  // filename (groupDuplicateListingLinksByUnit). Owners must mirror the
  // photoByProperty folder loop: a unit owns the row when its ACTIVE (aliased)
  // folder is the row's folder.
  const duplicateLinkOwnersForRow = (propertyId: number, folder: string): DuplicateLinkOwner[] => {
    if (propertyId <= 0) return [];
    const builder = getUnitBuilderByPropertyId(propertyId);
    if (!builder) return [];
    const owners: DuplicateLinkOwner[] = [];
    builder.units.forEach((u, i) => {
      if (!u.photoFolder) return;
      const active = activePhotoFolderByOriginal.get(`${propertyId}:${u.photoFolder}`) ?? u.photoFolder;
      if (active !== folder) return;
      owners.push({
        label: `Unit ${String.fromCharCode(65 + i)}${u.unitNumber ? ` (${u.unitNumber})` : ""}`,
        filenames: (u.photos ?? []).map((p) => p.filename),
      });
    });
    return owners;
  };

  // Leave-your-phone survivability: the find-unit search runs SERVER-side, but
  // iOS Safari reloads the tab after app-switching, wiping replacePhotosTarget
  // — so the dialog (and its polling/commit UI) vanished while the job kept
  // running. On mount, auto-reopen the dialog for the most recently alive
  // replacement search (45-min freshness window, once per page load) so the
  // operator comes back to the live progress or the finished options list.
  const replaceFlowAutoReopenedRef = useRef(false);
  useEffect(() => {
    if (replaceFlowAutoReopenedRef.current || replacePhotosTarget) return;
    const builderIds = allProperties
      .filter((p) => p.id > 0 && !!getUnitBuilderByPropertyId(p.id))
      .map((p) => p.id);
    if (builderIds.length === 0) return;
    const live = findLiveReplacementJobRef(builderIds);
    if (!live) return;
    replaceFlowAutoReopenedRef.current = true;
    setReplacePhotosTarget({ propertyId: live.propertyId, unitId: live.targetUnitId });
    toast({
      title: "Resumed your replacement search",
      description: "The find-a-new-unit search kept running on the server while you were away — reopened it so you can review and commit the result.",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProperties, replacePhotosTarget]);

  // Existing swaps for the target property — feeds replacementLabel/sourceUrl
  // into the flow's unit picker and the skipUrls list (never re-suggest a
  // listing already used by a sibling unit).
  const { data: replaceUnitSwapsData } = useQuery<{
    swaps: Array<{ oldUnitId: string; newUnitLabel: string; newAddress: string; newSourceUrl: string }>;
  }>({
    queryKey: ["/api/unit-swaps", replacePhotosTarget?.propertyId ?? 0],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/unit-swaps/${replacePhotosTarget!.propertyId}`);
      if (!r.ok) throw new Error(`Unit swaps returned HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!replacePhotosTarget && replacePhotosTarget.propertyId !== 0,
    staleTime: 30_000,
  });

  // ── One-click auto-replace queue ────────────────────────────────────────
  // The server orchestrates find → auto-commit → verify; the dashboard just
  // watches the queue. Poll fast while anything is active, slow otherwise.
  const { data: autoReplaceQueue } = useQuery<{ activeCount: number; jobs: AutoReplaceJobRecord[] }>({
    queryKey: ["/api/replacement/auto-jobs"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/replacement/auto-jobs");
      if (!r.ok) throw new Error(`Auto-replace queue returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: (query) => ((query.state.data?.activeCount ?? 0) > 0 ? 6_000 : 60_000),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  // Durable automatic-fix history is separate from the clearable live queue.
  // Fetch it only when the operator opens the activity dialog; while open,
  // poll lightly so a scheduled retry or background completion appears there.
  const {
    data: autoFixActivity,
    isLoading: autoFixActivityLoading,
    isError: autoFixActivityError,
    refetch: refetchAutoFixActivity,
  } = useQuery<{ events: AutoFixActivityEvent[] }>({
    queryKey: ["/api/replacement/auto-fix-activity"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/replacement/auto-fix-activity?limit=100");
      if (!r.ok) throw new Error(`Photo replacement activity returned HTTP ${r.status}`);
      return r.json();
    },
    enabled: autoReplaceQueueOpen,
    refetchInterval: autoReplaceQueueOpen ? 15_000 : false,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  // When a job this page watched goes terminal: refresh the duplicate-photos
  // indicators (photo checks + Comm QA), keep the photo-check poll alive so
  // the verification rescan's verdict lands, and toast the outcome once.
  const autoReplaceSeenActiveRef = useRef<Set<string>>(new Set());
  const autoReplaceToastedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const job of autoReplaceQueue?.jobs ?? []) {
      if (isAutoReplacePhaseActive(job.phase)) {
        autoReplaceSeenActiveRef.current.add(job.jobId);
        continue;
      }
      if (!autoReplaceSeenActiveRef.current.has(job.jobId)) continue; // finished before this page load
      if (autoReplaceToastedRef.current.has(job.jobId)) continue;
      autoReplaceToastedRef.current.add(job.jobId);
      queryClient.invalidateQueries({ queryKey: ["/api/photo-listing-check"] });
      queryClient.invalidateQueries({ queryKey: ["/api/builder/photo-community-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/unit-swaps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/replacement/auto-fix-activity"] });
      // Draft jobs repoint unit{1,2}PhotoFolder server-side — refetch the
      // drafts so photoByProperty tracks the NEW folder (the stale row would
      // otherwise stay flagged and re-enable the Replace button for a second
      // destructive swap; the drafts query never refetches on its own).
      if (job.propertyId < 0) {
        queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
      }
      setPhotoScanPollUntil((prev) => Math.max(prev, Date.now() + 5 * 60_000));
      if (job.phase === "completed") {
        toast({
          title: `Photos replaced — ${job.propertyName} · ${job.unitLabel}`,
          description: job.message ?? "The new unit's photos are in place; verification is running.",
        });
      } else {
        toast({
          title: `Auto replace failed — ${job.propertyName} · ${job.unitLabel}`,
          description: job.error ?? "See the replacement queue for details.",
          variant: "destructive",
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReplaceQueue]);

  // "Clear queue": server drops finished (and unresumably-stuck) jobs from its
  // memory + persisted store, so the banner clears on EVERY device — not just
  // this browser. Actively-running jobs are never cleared server-side.
  const clearAutoReplaceQueueMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/replacement/auto-jobs/clear");
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      return data as { removed: number; activeCount: number; jobs: AutoReplaceJobRecord[] };
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/replacement/auto-jobs"], { activeCount: data.activeCount, jobs: data.jobs });
      queryClient.invalidateQueries({ queryKey: ["/api/replacement/auto-jobs"] });
      toast({
        title: "Replacement queue cleared",
        description: data.activeCount > 0
          ? `${data.removed} finished job${data.removed === 1 ? "" : "s"} removed — ${data.activeCount} still running.`
          : `${data.removed} job${data.removed === 1 ? "" : "s"} removed.`,
      });
    },
    onError: (e: any) => toast({ title: "Failed to clear the queue", description: e.message, variant: "destructive" }),
  });

  // The one-click button: fire-and-forget. Everything (search, commit,
  // verification) happens server-side; the queue chip is the only UI.
  const startAutoReplaceMutation = useMutation({
    mutationFn: async (vars: { propertyId: number; unitId: string; unitLabel: string }) => {
      const r = await apiRequest("POST", "/api/replacement/auto-jobs", vars);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      return data as { job: AutoReplaceJobRecord };
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/replacement/auto-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/replacement/auto-fix-activity"] });
      toast({
        title: `Auto replace started — ${vars.unitLabel}`,
        description: "Finding a clean same-community unit, committing it, and verifying — all in the background. You can leave; track it via the replacement queue banner.",
      });
    },
    onError: (e: any) => toast({ title: "Auto replace failed to start", description: e.message, variant: "destructive" }),
  });

  // After the flow commits a swap: the replacement folder is now the unit's
  // ACTIVE folder everywhere (scanner, dashboard, Comm QA). Kick off both
  // verification legs immediately: (1) deep OTA rescan of the NEW folder so
  // the popup/Photos cell get a fresh duplicate verdict, (2) the Claude-vision
  // photo-community check so the operator gets explicit confirmation the new
  // unit's gallery belongs to the community.
  const handleDuplicatePhotoUnitReplaced = async (oldUnitId: string, newUnit: ReplacementUnitData) => {
    const target = replacePhotosTarget;
    if (!target) return;
    const builder = replaceBuilderLikeFor(target.propertyId);
    const index = builder?.units.findIndex((u) => u.id === oldUnitId) ?? -1;
    const letter = index >= 0 ? `Unit ${String.fromCharCode(65 + index)}` : oldUnitId;
    const replacementFolder = replacementPhotoFolderForUnit(target.propertyId, oldUnitId);
    // Promoted drafts persist photos under unit{1,2}PhotoFolder — repoint the
    // draft at the replacement folder + new unit identity BEFORE the community
    // check kick, which reads the draft's own folder fields. Same PATCH as
    // builder-preflight's "Commit Replacements & Continue" but SCOPED to this
    // unit (an unscoped commit would silently apply a sibling unit's
    // abandoned preflight pick). On failure, STOP: the community check would
    // validate the OLD gallery and the success toast would lie.
    if (target.propertyId < 0) {
      try {
        await apiRequest("PATCH", `/api/unit-swaps/commit/${target.propertyId}`, { oldUnitId });
        queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
      } catch {
        toast({
          title: "Draft repoint failed",
          description: "The swap was recorded but the draft still points at the old photos — open builder pre-flight and use \"Commit Replacements & Continue\".",
          variant: "destructive",
        });
        queryClient.invalidateQueries({ queryKey: ["/api/unit-swaps", target.propertyId] });
        return;
      }
    }
    confirmPhotosReplacedMutation.mutate({
      folder: replacementFolder,
      propertyName: builder?.propertyName ?? `Property ${target.propertyId}`,
      unitLabel: `${letter} — replacement (${newUnit.unitLabel || newUnit.address || "new unit"})`,
      platforms: ["airbnb", "vrbo", "booking"],
    });
    void startBulkPhotoCommunityCheck([target.propertyId]);
    queryClient.invalidateQueries({ queryKey: ["/api/unit-swaps", target.propertyId] });
    toast({
      title: `Photos replaced for ${letter}`,
      description: `${newUnit.address || newUnit.unitLabel} is now the unit's photo source. Verifying the new photos are not on Airbnb/VRBO/Booking and that Claude vision confirms the unit is in the community…`,
    });
  };

  const isBulkPricingSelectable = (property: Property) => {
    if (property.draftStatus === "researching" || property.draftStatus === "draft_ready") return false;
    if (property.draftId !== undefined && property.draftStatus === "published") return true;
    return property.bedrooms > 0;
  };

  const visibleBulkPricingIds = filtered
    .filter(isBulkPricingSelectable)
    .map((property) => property.id);
  const selectedBulkPricingProperties = allProperties
    .filter((property) => selectedPricingIds.has(property.id) && isBulkPricingSelectable(property));
  const selectedBulkPricingCount = selectedBulkPricingProperties.length;
  const scannableAvailabilityIds = new Set(scannableAvailabilityProperties.map((property) => property.id));
  const selectedBulkAvailabilityProperties = selectedBulkPricingProperties
    .filter((property) => scannableAvailabilityIds.has(property.id));
  const selectedBulkAvailabilityCount = selectedBulkAvailabilityProperties.length;
  const allVisibleBulkPricingSelected =
    visibleBulkPricingIds.length > 0 && visibleBulkPricingIds.every((id) => selectedPricingIds.has(id));
  const bulkPricingTerminal =
    bulkPricingJob?.status === "completed" || bulkPricingJob?.status === "failed" || bulkPricingJob?.status === "cancelled";
  const activeBulkPricingHistory = bulkPricingHistory.find((job) => job.status === "queued" || job.status === "running");
  const runningBulkPricingItem = bulkPricingJob?.items.find((item) => item.status === "running") ?? null;
  const bulkPricingLastHeartbeat = bulkPricingJob?.items
    .map((item) => item.heartbeatAt ? Date.parse(item.heartbeatAt) : 0)
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => b - a)[0] ?? null;
  const bulkPricingLooksStale = !!(
    bulkPricingJob?.status === "running" &&
    bulkPricingLastHeartbeat &&
    Date.now() - bulkPricingLastHeartbeat > 5 * 60 * 1000
  );
  // Per-property Guesty push confirmation for the mass market update — a
  // completed item can still have SKIPPED the Guesty push, so this is the
  // "did every property's rates actually land on Guesty?" answer.
  const bulkPricingPushSummary =
    bulkPricingJob && !bulkPricingJob.dryRun ? summarizeBulkPricingGuestyPush(bulkPricingJob.items) : null;
  const bulkAvailabilityRunning = bulkAvailabilityQueue?.status === "running";
  const bulkAvailabilityActive = bulkAvailabilityQueue?.status === "running" || bulkAvailabilityQueue?.status === "paused";
  const formatBulkPricingTime = (value?: string | null) => {
    if (!value) return "—";
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return "—";
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  const formatPricingRecipe = (recipe?: NonNullable<BulkPricingJob["items"][number]["progress"]>["pricingRecipe"]) => {
    if (!recipe) return null;
    const searched = Array.isArray(recipe.searchedBedrooms) && recipe.searchedBedrooms.length > 0
      ? recipe.searchedBedrooms.map((br) => `${br}BR`).join(", ")
      : "unknown BR";
    const unitCount = Number(recipe.unitCount) > 1 ? `${recipe.unitCount} units` : "single unit";
    // Claude static-rate engine: web-researched seasonal anchors (no P40 window).
    if ((recipe as any).source === "claude-static") {
      const model = (recipe as any).model ? ` · ${(recipe as any).model}` : "";
      return `${recipe.searchName || recipe.community || "Market"} · ${unitCount} · ${searched} · Claude web research${model}`;
    }
    // 50th percentile == the Airbnb median (operator directive 2026-07-01).
    const percentile = recipe.percentileBasis === 50
      ? "median"
      : recipe.percentileBasis
        ? `p${recipe.percentileBasis}`
        : "median";
    const nights = recipe.stayNights ? `${recipe.stayNights}-night` : "7-night";
    return `${recipe.community || recipe.searchName || "Market"} · ${unitCount} · searching ${searched} · ${nights} ${percentile}`;
  };
  // Research confirmation — pull the resort actually searched and the
  // bedroom-size / combo scaling out of pricingRecipe as DISCRETE glanceable
  // facts (formatPricingRecipe above only collapses them into one truncated
  // pill, kept here for the full tooltip). The Pricing tab renders a mirrored
  // block from the same recipe. NOTE FOR CODEX: searchName is the resort the
  // scan actually used; prefer it over the raw community key.
  const pricingRecipeResort = (recipe?: NonNullable<BulkPricingJob["items"][number]["progress"]>["pricingRecipe"]) => {
    if (!recipe) return null;
    const resort = (recipe.searchName || recipe.community || "").trim();
    return resort || null;
  };
  const pricingRecipeScaling = (
    recipe?: NonNullable<BulkPricingJob["items"][number]["progress"]>["pricingRecipe"],
  ): { label: string; combo: boolean } | null => {
    if (!recipe) return null;
    const sizes = Array.isArray(recipe.searchedBedrooms)
      ? recipe.searchedBedrooms.filter((br) => Number.isFinite(br))
      : [];
    if (sizes.length === 0) return null;
    const unitCount = Number(recipe.unitCount) > 0 ? Number(recipe.unitCount) : sizes.length;
    if (unitCount <= 1) return { label: `${sizes[0]}BR · single unit`, combo: false };
    if (sizes.length === 1) return { label: `${sizes[0]}BR ×${unitCount} · summed`, combo: true };
    return { label: `${sizes.map((br) => `${br}BR`).join(" + ")} · summed across ${unitCount} units`, combo: true };
  };
  const confidenceTone = (level?: string) => (
    level === "green" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : level === "yellow" ? "border-amber-200 bg-amber-50 text-amber-700"
    : level === "red" ? "border-red-200 bg-red-50 text-red-700"
    : "border-slate-200 bg-slate-50 text-slate-600"
  );
  useEffect(() => {
    const validIds = new Set(allProperties.filter(isBulkPricingSelectable).map((property) => property.id));
    setSelectedPricingIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allProperties]);

  // Last observed completed-count per bulk pricing job, so the poll can tell
  // "an item just finished" (→ its Guesty push stamp is in the DB, refresh the
  // Last Price Scan column) apart from an ordinary tick.
  const bulkPricingCompletedCountRef = useRef<{ jobId: string; completed: number } | null>(null);
  useEffect(() => {
    if (!bulkPricingJob?.id || bulkPricingTerminal) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/pricing/bulk-refresh/${bulkPricingJob.id}`, { credentials: "include" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) {
          setBulkPricingJob(data.job);
          setBulkPricingEvents(Array.isArray(data.events) ? data.events : []);
          // Each finished item has ALREADY stamped scanner_schedule via the
          // push-seasonal-rates seam, but the "Last Price Scan" column query
          // (staleTime + no focus refetch) sits frozen on its page-load
          // snapshot unless someone invalidates it — the same class as the
          // 2026-07-12 audit-sweep incident, on the bulk-queue path. Refresh
          // it as items land (a long queue ticks row by row) and again at
          // terminal (covers cancel/fail after partial completions).
          const completedCount = typeof data.job?.completed === "number" ? data.job.completed : 0;
          const prevCompleted = bulkPricingCompletedCountRef.current;
          bulkPricingCompletedCountRef.current = { jobId: String(data.job?.id ?? ""), completed: completedCount };
          const itemJustCompleted = prevCompleted?.jobId === String(data.job?.id ?? "") && completedCount > prevCompleted.completed;
          const jobTerminal = ["completed", "failed", "cancelled"].includes(data.job?.status);
          if (itemJustCompleted || jobTerminal) {
            queryClient.invalidateQueries({ queryKey: ["/api/dashboard/price-scans"] });
          }
          if (jobTerminal) {
            queryClient.invalidateQueries({ queryKey: ["/api/property/market-rates"] });
            queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
          }
        }
      } catch {
        // Polling should never crash the dashboard. The next tick can recover.
      }
    };
    const timer = window.setInterval(poll, 2_500);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bulkPricingJob?.id, bulkPricingTerminal, queryClient]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/scanner/bulk-status", { credentials: "include" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setBulkAvailabilityQueue(data.queue ?? null);
      } catch {
        // Availability queue polling is best-effort; the next tick can recover.
      }
    };
    void poll();
    const timer = window.setInterval(poll, bulkAvailabilityRunning ? 5_000 : 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bulkAvailabilityRunning]);

  useEffect(() => {
    let cancelled = false;
    const loadHistory = async () => {
      try {
        const response = await fetch("/api/pricing/bulk-refresh", { credentials: "include" });
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled) return;
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        setBulkPricingHistory(jobs);
        if (!bulkPricingJob?.id) {
          // Surface a live queue OR one that finished while the operator was
          // away (started from a phone, Safari closed) — so the terminal
          // Guesty push-confirmation banner is actually seen. "Clear queue"
          // dismissals are honored via localStorage.
          const surface = selectBulkPricingJobToSurface(
            jobs as BulkPricingJob[],
            getDismissedBulkPricingJobIds(),
            Date.now(),
          );
          if (surface) {
            setBulkPricingJob(surface);
            const surfaceTerminal = surface.status !== "queued" && surface.status !== "running";
            if (surfaceTerminal) {
              // A terminal job never enters the live 2.5s poll (it only polls
              // non-terminal jobs), so load its event history once here.
              try {
                const detail = await fetch(`/api/pricing/bulk-refresh/${surface.id}`, { credentials: "include" });
                if (detail.ok) {
                  const detailData = await detail.json();
                  if (!cancelled && Array.isArray(detailData.events)) setBulkPricingEvents(detailData.events);
                }
              } catch {
                // Event history is best-effort; the banner reads item progress.
              }
            }
          }
        }
      } catch {
        // Dashboard history is best-effort; the active job poll handles recovery.
      }
    };
    void loadHistory();
    const timer = window.setInterval(loadHistory, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bulkPricingJob?.id]);

  const toggleBulkPricingRow = (propertyId: number) => {
    setSelectedPricingIds((prev) => {
      const next = new Set(prev);
      if (next.has(propertyId)) next.delete(propertyId);
      else next.add(propertyId);
      return next;
    });
  };

  const toggleVisibleBulkPricingRows = () => {
    setSelectedPricingIds((prev) => {
      const next = new Set(prev);
      if (allVisibleBulkPricingSelected) {
        for (const id of visibleBulkPricingIds) next.delete(id);
      } else {
        for (const id of visibleBulkPricingIds) next.add(id);
      }
      return next;
    });
  };

  const startBulkPricingRefresh = async () => {
    if (selectedBulkPricingProperties.length === 0) return;
    setBulkPricingStarting(true);
    try {
      const labels = Object.fromEntries(selectedBulkPricingProperties.map((property) => [String(property.id), property.name]));
      const response = await apiRequest("POST", "/api/pricing/bulk-refresh", {
        propertyIds: selectedBulkPricingProperties.map((property) => property.id),
        labels,
      });
      const data = await response.json();
      setBulkPricingJob(data.job);
      setBulkPricingEvents([]);
      toast({
        title: "Bulk pricing queued",
        description: `${selectedBulkPricingProperties.length} propert${selectedBulkPricingProperties.length === 1 ? "y" : "ies"} will run one at a time.`,
      });
    } catch (e: any) {
      toast({ title: "Bulk pricing failed to start", description: e.message, variant: "destructive" });
    } finally {
      setBulkPricingStarting(false);
    }
  };

  const startBulkAvailabilityScan = async () => {
    if (selectedBulkAvailabilityProperties.length === 0) return;
    setBulkAvailabilityStarting(true);
    try {
      const response = await apiRequest("POST", "/api/scanner/bulk-run", {
        propertyIds: selectedBulkAvailabilityProperties.map((property) => property.id),
        weeksAhead: 52,
      });
      const data = await response.json();
      setBulkAvailabilityQueue(data);
      toast({
        title: "Bulk availability queued",
        description: `${selectedBulkAvailabilityProperties.length} propert${selectedBulkAvailabilityProperties.length === 1 ? "y" : "ies"} will scan one at a time.`,
      });
    } catch (e: any) {
      toast({ title: "Bulk availability failed to start", description: e.message, variant: "destructive" });
    } finally {
      setBulkAvailabilityStarting(false);
    }
  };

  const runBulkAvailabilityAction = async (action: "clear" | "pause" | "resume" | "cancel") => {
    setBulkAvailabilityAction(action);
    try {
      const endpoint =
        action === "clear" ? "/api/scanner/bulk-clear"
        : action === "pause" ? "/api/scanner/bulk-pause"
        : action === "resume" ? "/api/scanner/bulk-resume"
        : "/api/scanner/bulk-cancel";
      const response = await apiRequest("POST", endpoint, {
        reason: action === "cancel" ? "cancelled from dashboard bulk availability modal" : `${action} from dashboard bulk availability modal`,
      });
      const data = await response.json();
      setBulkAvailabilityQueue(data.queue ?? null);
      toast({
        title:
          action === "clear" ? "Availability queue cleared"
          : action === "pause" ? "Availability queue paused"
          : action === "resume" ? "Availability queue resumed"
          : "Availability queue cancelled",
      });
    } catch (e: any) {
      toast({ title: "Availability queue action failed", description: e.message, variant: "destructive" });
    } finally {
      setBulkAvailabilityAction(null);
    }
  };

  const cancelBulkPricingRefresh = async () => {
    if (!bulkPricingJob?.id) return;
    setBulkPricingCancelling(true);
    try {
      const response = await apiRequest("POST", `/api/pricing/bulk-refresh/${bulkPricingJob.id}/cancel`);
      const data = await response.json();
      setBulkPricingJob(data.job);
      toast({ title: "Bulk pricing cancellation sent", description: "Queued items were cancelled. The active SearchAPI request may finish before the item stops." });
    } catch (e: any) {
      toast({ title: "Cancel failed", description: e.message, variant: "destructive" });
    } finally {
      setBulkPricingCancelling(false);
    }
  };

  // Clear the whole queue out of the way. If it isn't already in a terminal
  // state, force-terminate it server-side first (so a stuck/orphaned running
  // item can't keep the job "running" and immediately re-surface via polling),
  // then dismiss the local view.
  const clearBulkPricingQueue = async () => {
    if (!bulkPricingJob?.id) return;
    if (!bulkPricingTerminal && !window.confirm("This queue is still running. Clear it anyway? Any in-progress pricing will stop.")) {
      return;
    }
    setBulkPricingClearing(true);
    try {
      if (!bulkPricingTerminal) {
        await apiRequest("POST", `/api/pricing/bulk-refresh/${bulkPricingJob.id}/cancel?force=1`);
      }
      // Persist the dismissal so the discovery poll (which now re-surfaces
      // recently finished queues for operators returning from their phone)
      // doesn't bring this queue back.
      addDismissedBulkPricingJobId(bulkPricingJob.id);
      setBulkPricingJob(null);
      setSelectedPricingIds(new Set());
      setBulkPricingEvents([]);
    } catch (e: any) {
      toast({ title: "Couldn’t clear the queue", description: e.message, variant: "destructive" });
    } finally {
      setBulkPricingClearing(false);
    }
  };

  const retryFailedBulkPricingRefresh = async () => {
    if (!bulkPricingJob?.id || bulkPricingJob.failed === 0) return;
    setBulkPricingRetrying(true);
    try {
      const response = await apiRequest("POST", `/api/pricing/bulk-refresh/${bulkPricingJob.id}/retry-failed`);
      const data = await response.json();
      setBulkPricingJob(data.job);
      toast({ title: "Failed pricing rows re-queued", description: "The queue will retry only the failed properties." });
    } catch (e: any) {
      toast({ title: "Retry failed", description: e.message, variant: "destructive" });
    } finally {
      setBulkPricingRetrying(false);
    }
  };

  const deleteDraftMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/community/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
    },
  });

  // Promote a draft to "published" — flips the status flag so the
  // row renders as a regular active property (no DRAFT pill, Build
  // button enabled). The data stays in `community_drafts` rather
  // than moving to a separate `properties` table; the dashboard
  // and the builder both read from the same source. Reuses the
  // existing PATCH /api/community/:id endpoint.
  const promoteDraftMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await apiRequest("PATCH", `/api/community/${id}`, { status: "published" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
      toast({ title: "Promoted to active", description: "Row now appears as a regular property." });
    },
    onError: (e: any) => toast({ title: "Promote failed", description: e.message, variant: "destructive" }),
  });

  // Resend a refund confirmation that did not reach the guest's OTA channel.
  // Restricted to kind:"refund" so it can never re-fire an already-sent payment
  // receipt; the OTA delivery path de-dupes so the guest's channel is never
  // double-posted (an already-delivered copy is reused).
  const [resendingRefundFor, setResendingRefundFor] = useState<string | null>(null);
  const resendRefundReceiptMutation = useMutation({
    mutationFn: async (reservationId: string) => {
      // Direct fetch, NOT apiRequest: apiRequest throws on EVERY non-2xx, which
      // turned the endpoint's 422 "could not deliver" RESULT into a raw
      // "Resend failed / 422: Sent 0 of 1 receipt(s)…" error toast and made the
      // structured 422 handling below unreachable. Only auth/5xx/network
      // failures should throw; 422 carries the per-receipt outcome JSON.
      const r = await fetch("/api/inbox/guest-receipts/send-for-reservation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId, kind: "refund" }),
        credentials: "include",
      });
      if (!r.ok && r.status !== 422) {
        const err = await r.json().catch(() => ({} as { error?: string; message?: string }));
        throw new Error(err.error ?? err.message ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<{ ok: boolean; message: string; results?: Array<{ outcome: string; reason?: string }> }>;
    },
    onMutate: (reservationId: string) => setResendingRefundFor(reservationId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/revenue-30-days"] });
      const results = data.results ?? [];
      const sent = results.filter((x) => x.outcome === "sent").length;
      // A successful resend may be the SMS leg only (channel copy was already
      // delivered) — the server's reason says which, so prefer it over the
      // generic channel wording.
      const sentReason = results.find((x) => x.outcome === "sent" && x.reason)?.reason;
      toast({
        title: sent > 0 ? "Refund receipt sent" : "Refund receipt not delivered",
        description: sent > 0
          ? (sentReason || "The refund confirmation was sent to the guest on their booking channel.")
          : (data.message || "Could not deliver on the guest's OTA channel — check the conversation in Guesty."),
        variant: sent > 0 ? undefined : "destructive",
      });
    },
    onError: (e: any) => toast({ title: "Resend failed", description: e.message, variant: "destructive" }),
    onSettled: () => setResendingRefundFor(null),
  });

  const photoScanMutation = useMutation({
    mutationFn: async (vars?: { folders?: string[]; label?: string }) => {
      const folders = vars?.folders;
      const body = folders && folders.length > 0 ? { folders } : {};
      const r = await apiRequest("POST", "/api/photo-listing-check/run", body);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<{ started: boolean; folders: string[]; deep?: boolean }>;
    },
    onMutate: (vars) => {
      // Open the progress modal immediately (before the round-trip) so the
      // operator sees the deep scan is starting.
      setPhotoScanLabel(vars?.label ?? "All scannable listings");
      setPhotoScanSearch("");
      setPhotoScanStartedAt(Date.now());
      setPhotoScanModalOpen(true);
    },
    onSuccess: (data) => {
      setPhotoScanFolders(data.folders);
      // Deep scan touches many photos per folder, so it's slower than the old
      // 3-photo screen — budget ~60s/folder for the poll window.
      setPhotoScanPollUntil(Date.now() + Math.max(3 * 60_000, data.folders.length * 60_000));
      queryClient.invalidateQueries({ queryKey: ["/api/photo-listing-check"] });
      toast({
        title: "Deep photo scan started",
        description: `${data.folders.length} folder${data.folders.length === 1 ? "" : "s"} queued (full gallery + address). Progress is shown in the dialog.`,
      });
    },
    onError: (e: any) => {
      setPhotoScanModalOpen(false);
      toast({ title: "Photo scan failed", description: e.message, variant: "destructive" });
    },
  });

  // Verification rescan for one unit folder — fired automatically by the
  // manual "pick manually" flow on commit (handleDuplicatePhotoUnitReplaced)
  // and by the popup's "Rescan again" retry button (still-found/inconclusive
  // rows only; the one-click auto-replace job runs its own server-side
  // verification, so there is no standalone confirm step anymore). Fires the
  // same DEEP scan endpoint scoped to the one folder; the popup row then
  // walks pending → clean / still-found off the re-fetched photo-check row
  // (photoReplaceRescanVerdict). Deliberately does NOT open the big
  // deep-scan progress modal — progress renders inline in the popup.
  const confirmPhotosReplacedMutation = useMutation({
    mutationFn: async (vars: { folder: string; propertyName: string; unitLabel: string; platforms: DuplicatePhotoPlatform[] }) => {
      const r = await apiRequest("POST", "/api/photo-listing-check/run", { folders: [vars.folder] });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<{ started: boolean; folders: string[] }>;
    },
    onMutate: (vars) => {
      setPhotoReplaceRescans((prev) => ({
        ...prev,
        [vars.folder]: {
          startedAt: Date.now(),
          propertyName: vars.propertyName,
          unitLabel: vars.unitLabel,
          platforms: vars.platforms,
        },
      }));
    },
    onSuccess: (_data, vars) => {
      // Reuse the shared poll gate (never shrink an already-longer window).
      setPhotoScanPollUntil((prev) => Math.max(prev, Date.now() + 5 * 60_000));
      queryClient.invalidateQueries({ queryKey: ["/api/photo-listing-check"] });
      toast({
        title: "Verification rescan started",
        description: `Deep-rescanning ${vars.propertyName} · ${vars.unitLabel} to confirm the replaced photos are no longer on Airbnb, VRBO, or Booking.com.`,
      });
    },
    onError: (e: any, vars) => {
      if (vars) {
        setPhotoReplaceRescans((prev) => {
          const next = { ...prev };
          delete next[vars.folder];
          return next;
        });
      }
      toast({ title: "Rescan failed to start", description: e.message, variant: "destructive" });
    },
  });

  const startBulkPhotoCommunityCheck = async (propertyIds: number[]) => {
    const targets = allProperties.filter((p) => propertyIds.includes(p.id));
    if (targets.length === 0) {
      toast({
        title: "No properties selected",
        description: "Select one or more properties with the checkboxes, then run Check photo community.",
        variant: "destructive",
      });
      return;
    }
    setBulkPhotoCommunityStarting(true);
    try {
      const labels = Object.fromEntries(targets.map((p) => [String(p.id), p.name]));
      const response = await apiRequest("POST", "/api/builder/bulk-photo-community-check", {
        propertyIds: targets.map((p) => p.id),
        labels,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setBulkPhotoCommunityJob(data.job);
      queryClient.invalidateQueries({ queryKey: ["/api/builder/photo-community-status"] });
      toast({
        title: "Bulk photo community check queued",
        description: `${targets.length} propert${targets.length === 1 ? "y" : "ies"} will run one at a time (~1 min each).`,
      });
    } catch (e: any) {
      toast({ title: "Bulk photo community check failed", description: e.message, variant: "destructive" });
    } finally {
      setBulkPhotoCommunityStarting(false);
    }
  };

  const cancelBulkPhotoCommunityCheck = async () => {
    if (!bulkPhotoCommunityJob?.id) return;
    setBulkPhotoCommunityCancelling(true);
    try {
      const response = await apiRequest("POST", `/api/builder/bulk-photo-community-check/${bulkPhotoCommunityJob.id}/cancel`);
      const data = await response.json();
      setBulkPhotoCommunityJob(data.job);
      toast({ title: "Cancellation requested", description: "Queued items will be skipped." });
    } catch (e: any) {
      toast({ title: "Cancel failed", description: e.message, variant: "destructive" });
    } finally {
      setBulkPhotoCommunityCancelling(false);
    }
  };

  // Highlight south-shore (Poipu) properties with the primary badge tone.
  // Keys off pricingArea — the styling decision is per-area, not per the
  // displayed complex name, so it stays right when multiple complexes
  // share the same area.
  const communityVariant = (pricingArea: string): "default" | "secondary" | "outline" => {
    const poipuAreas = ["Poipu Kai", "Poipu Brenneckes", "Poipu Oceanfront", "Pili Mai"];
    if (poipuAreas.includes(pricingArea)) return "default";
    return "secondary";
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <div className="max-w-[1400px] mx-auto px-3 py-4 sm:px-4 sm:py-6">
        <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl" data-testid="text-page-title">
              VacationRentalExpertz Operations Portal
            </h1>
            <p className="text-sm text-muted-foreground mt-1 sm:text-base">
              Manage vacation-rental listings, guest messaging, buy-ins, and revenue workflows from one dashboard
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 mb-6">
          <Link href="/add-community">
            <Button
              variant="outline"
              className="h-auto min-h-[74px] w-full justify-start gap-3 rounded-lg border-[hsl(var(--brand-blue)/0.26)] px-4 py-3 text-left hover:bg-[hsl(var(--brand-blue)/0.05)]"
              data-testid="button-add-community"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--brand-blue)/0.10)] text-[hsl(var(--brand-blue))]">
                <Layers className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight">Add Combo Listing</span>
                <span className="block text-[11px] font-normal text-muted-foreground leading-snug mt-1">Bundle nearby units into one listing</span>
              </span>
            </Button>
          </Link>
          {/* CODEX NOTE (2026-05-04, claude/single-listing): standalone-
              unit counterpart to "Add New Combo Listing". Routes to a
              4-step wizard that requires the address to NOT already
              be listed on Airbnb / VRBO / Booking.com. Same backend
              save flow as the combo wizard (community_drafts table). */}
          <Link href="/add-single-listing">
            <Button
              variant="outline"
              className="h-auto min-h-[74px] w-full justify-start gap-3 rounded-lg border-[hsl(var(--brand-orange)/0.45)] px-4 py-3 text-left hover:bg-[hsl(var(--brand-orange)/0.08)]"
              data-testid="button-add-single-listing"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--brand-orange)/0.14)] text-[hsl(var(--brand-orange))]">
                <HomeIcon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight">Add Single Listing</span>
                <span className="block text-[11px] font-normal text-muted-foreground leading-snug mt-1">Verify one standalone condo or townhouse</span>
              </span>
            </Button>
          </Link>
          <Link href="/inbox">
            <Button
              variant="outline"
              className={`h-auto min-h-[74px] w-full justify-start gap-3 rounded-lg px-4 py-3 text-left ${
                missedCallCount > 0
                  ? "border-red-300 bg-red-50 hover:bg-red-100"
                  : "border-[hsl(var(--brand-teal)/0.35)] hover:bg-[hsl(var(--brand-teal)/0.06)]"
              }`}
              data-testid="button-inbox"
            >
              <span className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${
                missedCallCount > 0 ? "bg-red-100 text-red-700" : "bg-[hsl(var(--brand-teal)/0.10)] text-primary"
              }`}>
                {missedCallCount > 0 ? <PhoneMissed className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
                {missedCallCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
                    {missedCallCount > 99 ? "99+" : missedCallCount}
                  </span>
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight">Guest Inbox</span>
                <span className={`block text-[11px] font-normal leading-snug mt-1 ${missedCallCount > 0 ? "text-red-700" : "text-muted-foreground"}`}>
                  {missedCallCount > 0
                    ? `${missedCallCount} missed call${missedCallCount === 1 ? "" : "s"} to clear`
                    : "Messages, templates, and agreement follow-ups"}
                </span>
              </span>
            </Button>
          </Link>
          {/* Operations = consolidated Bookings + Buy-In Tracker + Availability Scanner.
              The individual pages remain accessible by URL for power users, but the
              everyday workflow (see booking → find buy-in → record it) lives here. */}
          <Link href="/bookings">
            <Button
              variant="outline"
              className="h-auto min-h-[74px] w-full justify-start gap-3 rounded-lg border-[hsl(var(--brand-orange)/0.45)] px-4 py-3 text-left hover:bg-[hsl(var(--brand-orange)/0.08)]"
              data-testid="button-operations"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--brand-orange)/0.14)] text-[hsl(var(--brand-orange))]">
                <CalendarSearch className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight">Operations</span>
                <span className="block text-[11px] font-normal text-muted-foreground leading-snug mt-1">Bookings, buy-ins, deposits, and availability</span>
              </span>
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 mb-6">
          <Card className="p-4">
            <div className="flex items-start gap-2 mb-1 min-h-8">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">Total Properties</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-total-properties">{dashboardRowCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">{propertyCountBreakdown}</p>
          </Card>
          <Card className="p-4 sm:col-span-2 lg:col-span-2">
            <div className="flex items-start gap-2 mb-1 min-h-8">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">Avg Low Price/Night + 30-day booking stats</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-avg-price">${avgLow.toLocaleString()}</p>
            <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <Link
                href={operationsHrefForBooking(revenueSummary?.largestBooking)}
                className="min-w-0 rounded-sm border-t px-1 pt-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                data-testid="link-largest-booking"
              >
                <p className="font-medium text-muted-foreground">Largest booking</p>
                <p className="truncate font-semibold">
                  {revenueSummaryLoading
                    ? "..."
                    : revenueSummary?.largestBooking
                      ? `${revenueSummary.largestBooking.guestName} · ${revenueSummary.largestBooking.nights || 0} nights`
                      : "No bookings"}
                </p>
              </Link>
              <Link
                href={operationsHrefForBooking(revenueSummary?.highestGrossingBooking)}
                className="min-w-0 rounded-sm border-t px-1 pt-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                data-testid="link-highest-grossing-booking"
              >
                <p className="font-medium text-muted-foreground">Highest grossing</p>
                <p className="truncate font-semibold">
                  {revenueSummaryLoading
                    ? "..."
                    : revenueSummary?.highestGrossingBooking
                      ? `${formatCurrency(revenueSummary.highestGrossingBooking.amount)} · ${revenueSummary.highestGrossingBooking.guestName}`
                      : "No bookings"}
                </p>
              </Link>
              <Link
                href={operationsHrefForRevenueTarget(revenueSummary?.highestListingEarner?.listingId)}
                className="min-w-0 rounded-sm border-t px-1 pt-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                data-testid="link-top-listing-earner"
              >
                <p className="font-medium text-muted-foreground">Top listing earner</p>
                <p className="truncate font-semibold">
                  {revenueSummaryLoading
                    ? "..."
                    : highestListingEarnerName
                      ? highestListingEarnerName
                      : "No listing revenue"}
                </p>
                {revenueSummary?.highestListingEarner && (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {formatCurrency(revenueSummary.highestListingEarner.revenue)}
                  </p>
                )}
              </Link>
            </div>
          </Card>
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="shadcn-card rounded-xl border bg-card border-card-border p-4 text-left text-card-foreground shadow-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div className="flex items-start gap-2 mb-1 min-h-8">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-medium">Funds collected, past 30 days</span>
                </div>
                <p className="text-2xl font-bold" data-testid="text-weekly-revenue">
                  {revenueSummaryLoading ? "..." : formatCurrency(revenueSummary?.fundsCollected30Days ?? 0)}
                </p>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  {revenueSummary
                    ? `${revenueSummary.paymentsTaken30Days ?? 0} payment${(revenueSummary.paymentsTaken30Days ?? 0) === 1 ? "" : "s"} taken`
                    : "Actual collected payments"}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  48 hours: {revenueSummaryLoading ? "..." : formatCurrency(revenueSummary?.fundsCollected48Hours ?? 0)}
                  {revenueSummary ? ` · ${revenueSummary.paymentsTaken48Hours ?? 0} payment${(revenueSummary.paymentsTaken48Hours ?? 0) === 1 ? "" : "s"}` : ""}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  Past 5 days: {revenueSummaryLoading ? "..." : formatCurrency(revenueSummary?.fundsCollected5Days ?? 0)}
                  {revenueSummary ? ` · ${revenueSummary.paymentsTaken5Days ?? 0} payment${(revenueSummary.paymentsTaken5Days ?? 0) === 1 ? "" : "s"}` : ""}
                </p>
                <p className="mt-1 text-xs font-medium leading-snug text-foreground">
                  12-mo forecast: {revenueSummaryLoading ? "..." : formatCurrency(revenueSummary?.fundsCollectedAnnualProjection ?? 0)}
                  <span className="font-normal text-muted-foreground"> · 3-day avg {formatCurrency(Math.round(revenueSummary?.fundsCollectedDailyAvg3Days ?? 0))}/day</span>
                </p>
                <p className="mt-1 text-xs font-medium leading-snug text-foreground" data-testid="text-next-deposit">
                  Next deposit:{" "}
                  {revenueSummaryLoading
                    ? "..."
                    : depositProjection.nextDeposit
                      ? `${formatCurrency(depositProjection.nextDeposit.amount)} · ${formatShortDate(depositProjection.nextDeposit.date)}`
                      : "None expected"}
                  {!revenueSummaryLoading && depositProjection.nextDeposit ? (
                    <span className="font-normal text-muted-foreground"> · {depositProjection.nextDeposit.count} payment{depositProjection.nextDeposit.count === 1 ? "" : "s"}</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground" data-testid="text-next-deposits-12-days">
                  Next 12 days: {revenueSummaryLoading ? "..." : formatCurrency(depositProjection.scheduleTotal)} expected
                  <span className="font-normal"> · 5 business days after card payment</span>
                </p>
                {revenueSummary && (revenueSummary.refunds30Days ?? 0) > 0 && (
                  <p className="mt-0.5 text-xs leading-snug text-rose-600 dark:text-rose-400">
                    − {formatCurrency(revenueSummary.refunds30Days ?? 0)} refunded · net {formatCurrency(revenueSummary.netCollected30Days ?? ((revenueSummary.fundsCollected30Days ?? 0) - (revenueSummary.refunds30Days ?? 0)))}
                  </p>
                )}
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-5xl overflow-hidden p-0">
              <div className="max-h-[85vh] overflow-y-auto p-6">
              <DialogHeader>
                <DialogTitle>Funds collected, past 30 days</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {revenueSummary?.windowLabel ?? "Rolling past 30 days"}
                    {revenueSummary ? ` · ${formatShortDate(revenueSummary.startDate)} to ${formatShortDate(revenueSummary.endDate)}` : ""}
                  </span>
                  <span className="font-semibold">
                    {formatCurrency(revenueSummary?.fundsCollected30Days ?? 0)} collected from {revenueSummary?.paymentsTaken30Days ?? 0} payment{(revenueSummary?.paymentsTaken30Days ?? 0) === 1 ? "" : "s"}
                    {(revenueSummary?.refunds30Days ?? 0) > 0
                      ? ` · −${formatCurrency(revenueSummary?.refunds30Days ?? 0)} refunded · net ${formatCurrency(revenueSummary?.netCollected30Days ?? ((revenueSummary?.fundsCollected30Days ?? 0) - (revenueSummary?.refunds30Days ?? 0)))}`
                      : ""}
                  </span>
                </div>
                <div className="grid gap-2 text-sm sm:grid-cols-4">
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Payments taken, 48 hours</p>
                    <p className="mt-1 text-lg font-semibold">{formatCurrency(revenueSummary?.fundsCollected48Hours ?? 0)}</p>
                    <p className="text-xs text-muted-foreground">{revenueSummary?.paymentsTaken48Hours ?? 0} payment{(revenueSummary?.paymentsTaken48Hours ?? 0) === 1 ? "" : "s"}</p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Refunds issued, 30 days</p>
                    <p className="mt-1 text-lg font-semibold text-rose-600 dark:text-rose-400">−{formatCurrency(revenueSummary?.refunds30Days ?? 0)}</p>
                    <p className="text-xs text-muted-foreground">
                      {revenueSummary?.refundCount30Days ?? 0} refund{(revenueSummary?.refundCount30Days ?? 0) === 1 ? "" : "s"} · net {formatCurrency(revenueSummary?.netCollected30Days ?? ((revenueSummary?.fundsCollected30Days ?? 0) - (revenueSummary?.refunds30Days ?? 0)))}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Bookings made, 30 days</p>
                    <p className="mt-1 text-lg font-semibold">{formatCurrency(revenueSummary?.revenue ?? 0)}</p>
                    <p className="text-xs text-muted-foreground">{revenueSummary?.bookingCount ?? 0} booking{(revenueSummary?.bookingCount ?? 0) === 1 ? "" : "s"}</p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Collection basis</p>
                    <p className="mt-1 text-sm font-semibold">Guesty paid records, net of refunds</p>
                    <p className="text-xs text-muted-foreground">Collected excludes scheduled/pending/failed/voided; refunds shown separately</p>
                  </div>
                </div>
                <div className="rounded-md border border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900 dark:bg-sky-950/30" data-testid="block-guest-receipts">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium text-sky-700 dark:text-sky-300">Guest receipts sent, 30 days</p>
                    <p className="text-xs text-muted-foreground">Auto-sent payment &amp; refund confirmations</p>
                  </div>
                  <p className="mt-1 text-lg font-semibold text-sky-700 dark:text-sky-300">
                    {revenueSummary?.guestReceiptsSent30Days ?? 0} receipt{(revenueSummary?.guestReceiptsSent30Days ?? 0) === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {revenueSummary?.guestReceiptPaymentsSent30Days ?? 0} payment · {revenueSummary?.guestReceiptRefundsSent30Days ?? 0} refund · {revenueSummary?.guestReceiptsSent48Hours ?? 0} in last 48h
                  </p>
                </div>
                {revenueSummary?.guestRefundReceiptIssues?.length ? (
                  <div className="rounded-md border border-red-300 bg-red-50/70 p-3 dark:border-red-900 dark:bg-red-950/30" data-testid="block-refund-receipt-issues">
                    <p className="text-xs font-semibold text-red-700 dark:text-red-300">
                      ⚠ {revenueSummary.guestRefundReceiptIssues.length} refund confirmation{revenueSummary.guestRefundReceiptIssues.length === 1 ? "" : "s"} did NOT fully reach the guest
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      A refund was issued in Guesty but the receipt couldn't be delivered on the guest's booking channel and/or the confirmation text to their phone failed. Resend so the guest is notified.
                    </p>
                    <div className="mt-2 space-y-1.5">
                      {revenueSummary.guestRefundReceiptIssues.map((issue) => (
                        <div key={issue.token} className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-200 bg-background p-2 dark:border-red-900" data-testid={`row-refund-issue-${issue.token}`}>
                          <div className="min-w-0 text-xs">
                            <span className="font-medium">{issue.guestName || "Guest"}</span>
                            <span className="text-muted-foreground"> · {issue.listingNickname || "—"} · {formatCurrency(issue.amount)} refund</span>
                            <span className="block text-muted-foreground">
                              {issue.channel || "unknown channel"} · {issue.status === "misroute" ? "filed off the guest channel" : issue.status} · {formatShortDateTime(issue.createdAt)}
                            </span>
                            {(issue.smsStatus === "error" || issue.smsStatus === "no-phone") && (
                              <span className="block font-medium text-red-600 dark:text-red-400" data-testid={`text-refund-issue-sms-${issue.token}`}>
                                📱 Text to guest {issue.smsStatus === "no-phone" ? "not sent — no phone number on file (save one in the Guest Inbox, then Resend)" : `failed${issue.smsError ? `: ${issue.smsError}` : ""}`}
                              </span>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={resendRefundReceiptMutation.isPending && resendingRefundFor === issue.reservationId}
                            onClick={() => resendRefundReceiptMutation.mutate(issue.reservationId)}
                            data-testid={`button-resend-refund-${issue.token}`}
                          >
                            {resendRefundReceiptMutation.isPending && resendingRefundFor === issue.reservationId ? "Resending…" : "Resend to guest"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="rounded-md border bg-muted/30 p-3" data-testid="block-expected-deposits">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium text-muted-foreground">Expected bank deposits</p>
                    <p className="text-xs text-muted-foreground">Card payments settle ~5 business days after capture</p>
                  </div>
                  <p className="mt-1 text-sm font-semibold">
                    {depositProjection.nextDeposit
                      ? `Next deposit: ${formatCurrency(depositProjection.nextDeposit.amount)} on ${formatShortDate(depositProjection.nextDeposit.date)} · ${depositProjection.nextDeposit.count} payment${depositProjection.nextDeposit.count === 1 ? "" : "s"}`
                      : "No deposits expected from recent payments"}
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {depositProjection.scheduleDays.map((day) => (
                      <div key={day.date.toISOString()} className="rounded-md border bg-background p-2">
                        <p className="text-xs text-muted-foreground">
                          {day.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                        </p>
                        <p className="mt-0.5 text-sm font-semibold">{day.amount > 0 ? formatCurrency(day.amount) : "—"}</p>
                        {day.count > 0 ? (
                          <p className="text-xs text-muted-foreground">{day.count} payment{day.count === 1 ? "" : "s"}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
                {revenueSummaryLoading ? (
                  <p className="text-sm text-muted-foreground">Loading payment details...</p>
                ) : revenueSummary?.payments?.length ? (
                  <div className="max-w-full overflow-x-auto rounded-md border">
                    <Table className="min-w-[860px] table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[130px]">Paid</TableHead>
                          <TableHead className="w-[170px]">Guest</TableHead>
                          <TableHead className="w-[220px]">Listing</TableHead>
                          <TableHead className="w-[120px]">Channel</TableHead>
                          <TableHead className="w-[150px]">Description</TableHead>
                          <TableHead className="w-[110px] text-right">Collected</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {revenueSummary.payments.map((payment) => (
                          <TableRow key={payment.id}>
                            <TableCell className="whitespace-nowrap align-top">{formatShortDateTime(payment.paidAt)}</TableCell>
                            <TableCell className="align-top">
                              <div className="font-medium">{payment.guestName}</div>
                              {payment.confirmationCode && (
                                <div className="text-xs text-muted-foreground">{payment.confirmationCode}</div>
                              )}
                            </TableCell>
                            <TableCell className="align-top">{payment.listingName}</TableCell>
                            <TableCell className="align-top">{payment.source}</TableCell>
                            <TableCell className="align-top">{payment.description || "Collected payment"}</TableCell>
                            <TableCell className="whitespace-nowrap text-right align-top font-medium">{formatCurrency(payment.amount)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No collected payment records found in this rolling 30-day window.</p>
                )}
                {revenueSummary?.refunds?.length ? (
                  <div className="max-w-full overflow-x-auto rounded-md border">
                    <div className="border-b bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                      Refunds issued in this 30-day window — netted out of funds collected above
                    </div>
                    <Table className="min-w-[760px] table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[130px]">Refunded</TableHead>
                          <TableHead className="w-[170px]">Guest</TableHead>
                          <TableHead className="w-[220px]">Listing</TableHead>
                          <TableHead className="w-[150px]">Description</TableHead>
                          <TableHead className="w-[110px] text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {revenueSummary.refunds.map((refund) => (
                          <TableRow key={refund.id}>
                            <TableCell className="whitespace-nowrap align-top">{formatShortDateTime(refund.refundedAt)}</TableCell>
                            <TableCell className="align-top">
                              <div className="font-medium">{refund.guestName}</div>
                              {refund.confirmationCode && (
                                <div className="text-xs text-muted-foreground">{refund.confirmationCode}</div>
                              )}
                            </TableCell>
                            <TableCell className="align-top">{refund.listingName}</TableCell>
                            <TableCell className="align-top">{refund.description || "Refund"}</TableCell>
                            <TableCell className="whitespace-nowrap text-right align-top font-medium text-rose-600 dark:text-rose-400">−{formatCurrency(refund.amount)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
                {revenueSummary?.guestReceipts?.length ? (
                  <div className="max-w-full overflow-x-auto rounded-md border" data-testid="block-guest-receipts-feed">
                    <div className="border-b bg-sky-50 px-3 py-2 text-xs font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                      Guest receipts auto-sent in this 30-day window (payment &amp; refund confirmations)
                    </div>
                    <Table className="min-w-[940px] table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[140px]">Sent</TableHead>
                          <TableHead className="w-[160px]">Guest</TableHead>
                          <TableHead className="w-[200px]">Listing</TableHead>
                          <TableHead className="w-[90px]">Type</TableHead>
                          <TableHead className="w-[110px]">Channel</TableHead>
                          <TableHead className="w-[120px]">Text</TableHead>
                          <TableHead className="w-[90px]">Opened</TableHead>
                          <TableHead className="w-[100px] text-right">Amount</TableHead>
                          <TableHead className="w-[70px]">Receipt</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {revenueSummary.guestReceipts.map((receipt) => (
                          <TableRow key={receipt.id} data-testid={`row-guest-receipt-${receipt.id}`}>
                            <TableCell className="whitespace-nowrap align-top">{formatShortDateTime(receipt.sentAt)}</TableCell>
                            <TableCell className="align-top">{receipt.guestName || "Guest"}</TableCell>
                            <TableCell className="align-top">{receipt.listingNickname || "—"}</TableCell>
                            <TableCell className="align-top">
                              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${receipt.kind === "refund" ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" : "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300"}`}>
                                {receipt.kind === "refund" ? "Refund" : "Payment"}
                              </span>
                            </TableCell>
                            <TableCell className="align-top">{receipt.channel || "—"}</TableCell>
                            {/* Refund-only SMS confirmation: proves the text to the
                                guest's phone actually sent (or shows why it didn't). */}
                            <TableCell className="align-top" data-testid={`cell-receipt-sms-${receipt.id}`}>
                              {receipt.kind !== "refund" ? (
                                <span className="text-muted-foreground">—</span>
                              ) : receipt.smsStatus === "sent" ? (
                                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" title={`Text sent${receipt.smsTo ? ` to ${receipt.smsTo}` : ""}${receipt.smsSentAt ? ` · ${formatShortDateTime(receipt.smsSentAt)}` : ""}`}>
                                  ✓ Text sent
                                </span>
                              ) : receipt.smsStatus === "error" ? (
                                <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/50 dark:text-red-300">✕ Text failed</span>
                              ) : receipt.smsStatus === "no-phone" ? (
                                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">No phone</span>
                              ) : receipt.smsStatus === "not-configured" ? (
                                <span className="text-muted-foreground" title="Add QUO_API_KEY / QUO_FROM_NUMBER in Railway to enable refund texts">SMS off</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="align-top">{receipt.opened ? `✓${receipt.openCount > 1 ? ` ×${receipt.openCount}` : ""}` : "—"}</TableCell>
                            <TableCell className={`whitespace-nowrap text-right align-top font-medium ${receipt.kind === "refund" ? "text-amber-700 dark:text-amber-300" : ""}`}>{formatCurrency(receipt.amount)}</TableCell>
                            <TableCell className="align-top">
                              <a href={`/receipt/${receipt.token}?preview=1`} target="_blank" rel="noreferrer" className="text-sky-600 underline hover:text-sky-700 dark:text-sky-400">View</a>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
                {revenueSummary?.bookings?.length ? (
                  <div className="max-w-full overflow-x-auto rounded-md border">
                    <div className="border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                      Supporting booking revenue created in this 30-day window
                    </div>
                    <Table className="min-w-[960px] table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[130px]">Booked</TableHead>
                          <TableHead className="w-[170px]">Guest</TableHead>
                          <TableHead className="w-[220px]">Listing</TableHead>
                          <TableHead className="w-[150px]">Stay</TableHead>
                          <TableHead className="w-[120px]">Channel</TableHead>
                          <TableHead className="w-[100px]">Status</TableHead>
                          <TableHead className="w-[110px] text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {revenueSummary.bookings.map((booking) => (
                          <TableRow key={booking.id || `${booking.guestName}-${booking.bookedAt}`}>
                            <TableCell className="whitespace-nowrap align-top">{formatShortDateTime(booking.bookedAt)}</TableCell>
                            <TableCell className="align-top">
                              <div className="font-medium">{booking.guestName}</div>
                              {booking.confirmationCode && (
                                <div className="text-xs text-muted-foreground">{booking.confirmationCode}</div>
                              )}
                            </TableCell>
                            <TableCell className="align-top">{booking.listingName}</TableCell>
                            <TableCell className="whitespace-nowrap align-top">
                              {formatShortDate(booking.checkIn)} - {formatShortDate(booking.checkOut)}
                            </TableCell>
                            <TableCell className="align-top">{booking.source}</TableCell>
                            <TableCell className="align-top">{booking.status || "N/A"}</TableCell>
                            <TableCell className="whitespace-nowrap text-right align-top font-medium">{formatCurrency(booking.amount)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
              </div>
              </div>
            </DialogContent>
          </Dialog>
          {/* Revenue, past 30 days — clickable tile that opens a modal with the
              line-by-line booking revenue detail. Mirrors the "Funds collected"
              dialog above; the data (revenueSummary.bookings) is already loaded
              and sums exactly to the `revenue` headline, so this is a UI-only
              affordance (no new endpoint). */}
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="shadcn-card rounded-xl border bg-card border-card-border p-4 text-left text-card-foreground shadow-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                data-testid="card-booking-revenue"
              >
                <div className="flex items-start gap-2 mb-1 min-h-8">
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-medium">Revenue, past 30 days</span>
                </div>
                <p className="text-2xl font-bold" data-testid="text-booking-revenue-30">
                  {revenueSummaryLoading ? "..." : formatCurrency(revenueSummary?.revenue ?? 0)}
                </p>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  {revenueSummary?.bookingCount ?? 0} booking{(revenueSummary?.bookingCount ?? 0) === 1 ? "" : "s"} made
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground" data-testid="text-booking-revenue-48">
                  48 hours: {revenueSummaryLoading ? "..." : formatCurrency(revenueSummary?.revenue48Hours ?? 0)}
                  {revenueSummary ? ` · ${revenueSummary.bookingCount48Hours ?? 0} booking${(revenueSummary.bookingCount48Hours ?? 0) === 1 ? "" : "s"}` : ""}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground" data-testid="text-booking-revenue-5d">
                  Past 5 days: {revenueSummaryLoading ? "..." : formatCurrency(revenueSummary?.revenue5Days ?? 0)}
                  {revenueSummary ? ` · ${revenueSummary.bookingCount5Days ?? 0} booking${(revenueSummary.bookingCount5Days ?? 0) === 1 ? "" : "s"}` : ""}
                </p>
                <p className="mt-1 text-xs font-medium leading-snug text-foreground" data-testid="text-booking-revenue-forecast">
                  12-mo forecast: {revenueSummaryLoading ? "..." : formatCurrency(revenueSummary?.revenueAnnualProjection ?? 0)}
                  <span className="font-normal text-muted-foreground"> · 3-day avg {formatCurrency(Math.round(revenueSummary?.revenueDailyAvg3Days ?? 0))}/day</span>
                </p>
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-5xl overflow-hidden p-0">
              <div className="max-h-[85vh] overflow-y-auto p-6">
              <DialogHeader>
                <DialogTitle>Revenue, past 30 days</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {revenueSummary?.windowLabel ?? "Rolling past 30 days"}
                    {revenueSummary ? ` · ${formatShortDate(revenueSummary.startDate)} to ${formatShortDate(revenueSummary.endDate)}` : ""}
                  </span>
                  <span className="font-semibold">
                    {formatCurrency(revenueSummary?.revenue ?? 0)} from {revenueSummary?.bookingCount ?? 0} booking{(revenueSummary?.bookingCount ?? 0) === 1 ? "" : "s"} made
                  </span>
                </div>
                <div className="grid gap-2 text-sm sm:grid-cols-4">
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Revenue, 48 hours</p>
                    <p className="mt-1 text-lg font-semibold">{formatCurrency(revenueSummary?.revenue48Hours ?? 0)}</p>
                    <p className="text-xs text-muted-foreground">{revenueSummary?.bookingCount48Hours ?? 0} booking{(revenueSummary?.bookingCount48Hours ?? 0) === 1 ? "" : "s"}</p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Revenue, past 5 days</p>
                    <p className="mt-1 text-lg font-semibold">{formatCurrency(revenueSummary?.revenue5Days ?? 0)}</p>
                    <p className="text-xs text-muted-foreground">{revenueSummary?.bookingCount5Days ?? 0} booking{(revenueSummary?.bookingCount5Days ?? 0) === 1 ? "" : "s"}</p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">12-mo forecast</p>
                    <p className="mt-1 text-lg font-semibold">{formatCurrency(revenueSummary?.revenueAnnualProjection ?? 0)}</p>
                    <p className="text-xs text-muted-foreground">3-day avg {formatCurrency(Math.round(revenueSummary?.revenueDailyAvg3Days ?? 0))}/day</p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Revenue basis</p>
                    <p className="mt-1 text-sm font-semibold">Gross fare of bookings made</p>
                    <p className="text-xs text-muted-foreground">By booking date; excludes cancelled/declined/inquiry</p>
                  </div>
                </div>
                {revenueSummaryLoading ? (
                  <p className="text-sm text-muted-foreground">Loading booking details...</p>
                ) : revenueSummary?.bookings?.length ? (
                  <div className="max-w-full overflow-x-auto rounded-md border" data-testid="block-booking-revenue-feed">
                    <div className="border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                      Bookings made in this 30-day window — newest first
                    </div>
                    <Table className="min-w-[960px] table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[130px]">Booked</TableHead>
                          <TableHead className="w-[170px]">Guest</TableHead>
                          <TableHead className="w-[220px]">Listing</TableHead>
                          <TableHead className="w-[150px]">Stay</TableHead>
                          <TableHead className="w-[120px]">Channel</TableHead>
                          <TableHead className="w-[100px]">Status</TableHead>
                          <TableHead className="w-[110px] text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {revenueSummary.bookings.map((booking) => (
                          <TableRow key={booking.id || `${booking.guestName}-${booking.bookedAt}`} data-testid={`row-booking-revenue-${booking.id}`}>
                            <TableCell className="whitespace-nowrap align-top">{formatShortDateTime(booking.bookedAt)}</TableCell>
                            <TableCell className="align-top">
                              <Link href={operationsHrefForBooking(booking)} className="font-medium text-sky-600 underline hover:text-sky-700 dark:text-sky-400">
                                {booking.guestName}
                              </Link>
                              {booking.confirmationCode && (
                                <div className="text-xs text-muted-foreground">{booking.confirmationCode}</div>
                              )}
                            </TableCell>
                            <TableCell className="align-top">{booking.listingName}</TableCell>
                            <TableCell className="whitespace-nowrap align-top">
                              {formatShortDate(booking.checkIn)} - {formatShortDate(booking.checkOut)}
                            </TableCell>
                            <TableCell className="align-top">{booking.source}</TableCell>
                            <TableCell className="align-top">{booking.status || "N/A"}</TableCell>
                            <TableCell className="whitespace-nowrap text-right align-top font-medium">{formatCurrency(booking.amount)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No bookings were made in this rolling 30-day window.</p>
                )}
              </div>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="shadcn-card rounded-xl border bg-card border-card-border p-4 text-left text-card-foreground shadow-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                data-testid="button-cancelled-bookings"
              >
                <div className="flex items-start gap-2 mb-1 min-h-8">
                  <Ban className={`h-4 w-4 ${cancellationSummary.reviewNeeded > 0 ? "text-red-600" : "text-muted-foreground"}`} />
                  <span className="text-xs text-muted-foreground font-medium">Cancelled bookings, past {cancellationWindowDays} days</span>
                </div>
                <p className="text-2xl font-bold" data-testid="text-cancelled-bookings">
                  {cancellationsLoading ? "..." : cancellationSummary.total}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {cancellationSummary.paymentTaken} with payments
                  {cancellationSummary.reviewNeeded > 0 ? ` · ${cancellationSummary.reviewNeeded} review` : " · clean"}
                </p>
              </button>
            </DialogTrigger>
            <DialogContent className="max-w-6xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Ban className="h-4 w-4" /> Cancelled bookings, past {cancellationWindowDays} days
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div className="rounded border bg-muted/20 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total cancelled, past {cancellationWindowDays} days</p>
                    <p className="mt-1 text-2xl font-semibold">{cancellationSummary.total}</p>
                  </div>
                  <div className="rounded border bg-muted/20 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Payments taken</p>
                    <p className="mt-1 text-2xl font-semibold">{cancellationSummary.paymentTaken}</p>
                  </div>
                  <div className="rounded border bg-muted/20 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Needs review</p>
                    <p className={`mt-1 text-2xl font-semibold ${cancellationSummary.reviewNeeded > 0 ? "text-red-600" : "text-green-700"}`}>
                      {cancellationSummary.reviewNeeded}
                    </p>
                  </div>
                  <div className="rounded border bg-muted/20 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Open exposure</p>
                    <p className={`mt-1 text-2xl font-semibold ${cancellationSummary.exposure > 0 ? "text-red-600" : ""}`}>
                      {formatCurrency(cancellationSummary.exposure)}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    {cancellationSummary.lastSyncedAt
                      ? `Last Guesty sync ${formatShortDateTime(cancellationSummary.lastSyncedAt)}`
                      : `No cancellation audit sync has run for the past ${cancellationWindowDays} days yet.`}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => cancellationScanMutation.mutate()}
                    disabled={cancellationScanMutation.isPending}
                    data-testid="button-refresh-cancelled-bookings"
                  >
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${cancellationScanMutation.isPending ? "animate-spin" : ""}`} />
                    Refresh from Guesty
                  </Button>
                </div>

                {cancellationsLoading || cancellationsFetching ? (
                  <div className="rounded border py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin opacity-50" />
                    Loading cancelled booking audits...
                  </div>
                ) : cancellationRows.length === 0 ? (
                  <div className="rounded border py-8 text-center">
                    <Ban className="mx-auto mb-2 h-6 w-6 opacity-30" />
                    <p className="font-medium">No cancelled bookings found in the past {cancellationWindowDays} days</p>
                    <p className="text-sm text-muted-foreground">Refresh from Guesty to populate the rolling {cancellationWindowDays}-day audit table for linked listings.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_.9fr]">
                    <div className="overflow-x-auto rounded border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Cancelled booking</TableHead>
                            <TableHead>Stay</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Paid</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {cancellationRows.map((row) => {
                            const paid = moneyNumber(row.totalPaid);
                            const refunded = moneyNumber(row.totalRefunded);
                            const isSelected = selectedCancellation?.id === row.id;
                            return (
                              <TableRow
                                key={row.id}
                                className={`cursor-pointer ${isSelected ? "bg-blue-50/70" : ""}`}
                                onClick={() => setSelectedCancellationId(row.id)}
                                data-testid={`row-cancelled-booking-${row.id}`}
                              >
                                <TableCell>
                                  <div className="font-medium">{row.guestName || "Guest"}</div>
                                  <div className="text-xs text-muted-foreground">
                                    {propertyNameById.get(row.propertyId) ?? `Property ${row.propertyId}`}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {row.confirmationCode ?? row.guestyReservationId}
                                  </div>
                                </TableCell>
                                <TableCell className="whitespace-nowrap text-sm">
                                  {formatShortDate(row.checkIn)} - {formatShortDate(row.checkOut)}
                                  <div className="text-[10px] text-muted-foreground">
                                    cancelled {formatShortDate(row.cancelledAt)}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <Badge className={`text-[10px] ${refundDecisionClass(row.refundDecision)}`} variant="outline">
                                    {refundDecisionLabel(row.refundDecision)}
                                  </Badge>
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    {operatorStatusLabel(row.operatorStatus)}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className={`font-medium ${paid > refunded ? "text-red-600" : ""}`}>
                                    {formatCurrency(paid)}
                                  </div>
                                  {refunded > 0 && (
                                    <div className="text-[10px] text-green-700">
                                      {formatCurrency(refunded)} refunded
                                    </div>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>

                    <div className="rounded border bg-muted/10 p-4">
                      {selectedCancellation ? (
                        <div className="space-y-4">
                          <div>
                            <p className="text-xs uppercase tracking-wider text-muted-foreground">Selected booking</p>
                            <h3 className="mt-1 font-semibold">{selectedCancellation.guestName || "Guest"}</h3>
                            <p className="text-sm text-muted-foreground">
                              {propertyNameById.get(selectedCancellation.propertyId) ?? `Property ${selectedCancellation.propertyId}`}
                            </p>
                          </div>

                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div className="rounded border bg-background px-3 py-2">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Paid</p>
                              <p className="font-semibold">{formatCurrency(moneyNumber(selectedCancellation.totalPaid))}</p>
                            </div>
                            <div className="rounded border bg-background px-3 py-2">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Refunded</p>
                              <p className="font-semibold">{formatCurrency(moneyNumber(selectedCancellation.totalRefunded))}</p>
                            </div>
                            <div className="rounded border bg-background px-3 py-2">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Balance due</p>
                              <p className="font-semibold">{formatCurrency(moneyNumber(selectedCancellation.balanceDue))}</p>
                            </div>
                            <div className="rounded border bg-background px-3 py-2">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Channel</p>
                              <p className="font-semibold capitalize">{selectedCancellation.channel || "Unknown"}</p>
                            </div>
                          </div>

                          {moneyNumber(selectedCancellation.totalPaid) > moneyNumber(selectedCancellation.totalRefunded) && (
                            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                              <AlertTriangle className="mr-1.5 inline h-4 w-4" />
                              Payment remains after refund audit: {formatCurrency(moneyNumber(selectedCancellation.totalPaid) - moneyNumber(selectedCancellation.totalRefunded))}
                            </div>
                          )}

                          {/* Resolve controls — same PATCH the dashboard alert
                              banner uses; keeps the modal and the alert in sync. */}
                          <div className="rounded border bg-background px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Refund status</p>
                              <span className="text-xs font-medium">{operatorStatusLabel(selectedCancellation.operatorStatus)}</span>
                            </div>
                            {selectedCancellation.operatorStatus === "needs_review" ? (
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                                  disabled={resolvingCancellationId === selectedCancellation.id && cancellationResolveMutation.isPending}
                                  onClick={() => cancellationResolveMutation.mutate({ id: selectedCancellation.id, operatorStatus: "refunded" })}
                                  data-testid={`button-modal-confirm-refund-${selectedCancellation.id}`}
                                >
                                  {resolvingCancellationId === selectedCancellation.id && cancellationResolveMutation.isPending
                                    ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                    : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
                                  Confirm refund done
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={resolvingCancellationId === selectedCancellation.id && cancellationResolveMutation.isPending}
                                  onClick={() => cancellationResolveMutation.mutate({ id: selectedCancellation.id, operatorStatus: "no_refund_due" })}
                                  data-testid={`button-modal-no-refund-${selectedCancellation.id}`}
                                >
                                  No refund due
                                </Button>
                              </div>
                            ) : (
                              <div className="mt-2 flex items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                                  <CheckCircle2 className="h-3.5 w-3.5" /> Resolved
                                </span>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-xs"
                                  disabled={resolvingCancellationId === selectedCancellation.id && cancellationResolveMutation.isPending}
                                  onClick={() => cancellationResolveMutation.mutate({ id: selectedCancellation.id, operatorStatus: "needs_review" })}
                                  data-testid={`button-modal-reopen-${selectedCancellation.id}`}
                                >
                                  Reopen
                                </Button>
                              </div>
                            )}
                          </div>

                          <div>
                            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                              <CreditCard className="h-4 w-4" /> Payments
                            </div>
                            {selectedCancellationPayments.length > 0 ? (
                              <div className="space-y-2">
                                {selectedCancellationPayments.slice(0, 8).map((payment, index) => (
                                  <div key={`${paymentLineLabel(payment)}-${index}`} className="rounded border bg-background px-3 py-2 text-sm">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="font-medium truncate">{paymentLineLabel(payment)}</p>
                                        <p className="text-xs text-muted-foreground">
                                          {paymentLineDate(payment) ? formatShortDateTime(paymentLineDate(payment)!) : "No date"} · {String(payment?.status ?? "status unknown")}
                                        </p>
                                      </div>
                                      <p className="font-semibold">{formatCurrency(paymentLineAmount(payment))}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="rounded border bg-background px-3 py-2 text-sm text-muted-foreground">
                                No payment line items were returned by Guesty for this cancellation.
                              </p>
                            )}
                          </div>

                          {selectedCancellationRefunds.length > 0 && (
                            <div>
                              <p className="mb-2 text-sm font-semibold">Refunds</p>
                              <div className="space-y-2">
                                {selectedCancellationRefunds.slice(0, 8).map((refund, index) => (
                                  <div key={`${paymentLineLabel(refund)}-refund-${index}`} className="rounded border bg-background px-3 py-2 text-sm">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="font-medium truncate">{paymentLineLabel(refund)}</p>
                                        <p className="text-xs text-muted-foreground">
                                          {paymentLineDate(refund) ? formatShortDateTime(paymentLineDate(refund)!) : "No date"} · {String(refund?.status ?? "status unknown")}
                                        </p>
                                      </div>
                                      <p className="font-semibold text-green-700">{formatCurrency(Math.abs(paymentLineAmount(refund)))}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
                          <CreditCard className="mb-2 h-7 w-7 opacity-30" />
                          <p className="font-medium">Click a cancelled booking</p>
                          <p className="max-w-xs text-sm text-muted-foreground">
                            The payment panel will show Guesty's paid, refunded, and remaining balance details for that cancellation.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Guest-cancelled-with-payment alert. Surfaces cancelled bookings that
            still have money collected and unrefunded, and that the operator
            hasn't resolved. "Confirm refund done" / "No refund due" PATCH the
            audit's operatorStatus, which drops the row out of `reviewNeeded` so
            the banner clears itself. Hidden entirely when there's nothing to act
            on. */}
        {refundAlertRows.length > 0 && (
          <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/40" data-testid="alert-refund-due">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-red-800 dark:text-red-200">
                  Guest cancelled — payment on file ({refundAlertRows.length})
                </h2>
                <p className="mt-0.5 text-xs text-red-700/80 dark:text-red-300/80">
                  These cancelled bookings still have money collected that hasn't been fully refunded. Issue the refund in Guesty, then confirm it here to clear the alert.
                </p>
                <div className="mt-3 space-y-2">
                  {refundAlertRows.map((row) => {
                    const owed = moneyNumber(row.totalPaid) - moneyNumber(row.totalRefunded);
                    const busy = resolvingCancellationId === row.id && cancellationResolveMutation.isPending;
                    return (
                      <div
                        key={row.id}
                        className="flex flex-col gap-2 rounded-lg border border-red-200 bg-white px-3 py-2.5 dark:border-red-900 dark:bg-background sm:flex-row sm:items-center sm:justify-between"
                        data-testid={`alert-refund-row-${row.id}`}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{row.guestName || "Guest"}</span>
                            <span className="text-xs text-muted-foreground">
                              {propertyNameById.get(row.propertyId) ?? `Property ${row.propertyId}`}
                            </span>
                            {row.channel && (
                              <Badge variant="outline" className="text-[10px] capitalize">{row.channel}</Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatShortDate(row.checkIn)} – {formatShortDate(row.checkOut)} · cancelled {formatShortDate(row.cancelledAt)} · {row.confirmationCode ?? row.guestyReservationId}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                          <span className="mr-1 text-sm font-semibold text-red-700 dark:text-red-300" title="Payment still on file (paid minus refunded)">
                            {formatCurrency(owed)} on file
                          </span>
                          <Button
                            size="sm"
                            className="bg-emerald-600 text-white hover:bg-emerald-700"
                            disabled={busy}
                            onClick={() => cancellationResolveMutation.mutate({ id: row.id, operatorStatus: "refunded" })}
                            data-testid={`button-confirm-refund-${row.id}`}
                          >
                            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
                            Confirm refund done
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => cancellationResolveMutation.mutate({ id: row.id, operatorStatus: "no_refund_due" })}
                            data-testid={`button-no-refund-${row.id}`}
                          >
                            No refund due
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PR #318: dashboard alerts banner removed. Alerts now live
            inside each listing's per-channel rows in the listing
            builder (PhotoSyncStatusPanel) so the operator can resolve
            each alert with the right channel-specific flow:
              Airbnb → "Replace photos" (master sync via Guesty)
              VRBO/Booking → "Isolate + Replace + Disconnect" (sidecar)
            See client/src/components/PhotoSyncStatusPanel.tsx. */}

        <Card className="p-4 mb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative flex-1 min-w-0 sm:min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                data-testid="input-search"
                id="input-search-properties"
                aria-label="Search properties by name, community, or location"
                placeholder="Search properties..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={communityFilter} onValueChange={setCommunityFilter}>
              <SelectTrigger className="w-full sm:w-[200px]" data-testid="select-community" id="select-community-filter" aria-label="Filter by community">
                <SelectValue placeholder="All Communities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Communities</SelectItem>
                {communities.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={islandFilter} onValueChange={setIslandFilter}>
              <SelectTrigger className="w-full sm:w-[160px]" data-testid="select-island" id="select-island-filter" aria-label="Filter by island">
                <SelectValue placeholder="All Islands" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Islands</SelectItem>
                {islands.map((i) => (
                  <SelectItem key={i} value={i}>
                    {i}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={multiUnitFilter} onValueChange={setMultiUnitFilter}>
              <SelectTrigger className="w-full sm:w-[160px]" data-testid="select-multi-unit" id="select-type-filter" aria-label="Filter by property type">
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="yes">Multi-Unit</SelectItem>
                <SelectItem value="no">Single Unit</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Card>

        <Card id="property-table-card">
          <div className="p-3 border-b flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" data-testid="text-showing-count" id="text-showing-count">
              Showing {filtered.length} of {dashboardRowCount} properties
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => setAutoReplaceQueueOpen(true)}
                data-testid="button-auto-fix-log"
                title="See when photo replacements and automatic retries were attempted"
              >
                <History className="h-3.5 w-3.5" />
                Replacement log
                {(autoReplaceQueue?.activeCount ?? 0) > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                    {autoReplaceQueue!.activeCount}
                  </Badge>
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                disabled={selectedBulkPricingCount === 0 || bulkAuditStarting}
                onClick={() => void startBulkUnitAudit(selectedBulkPricingProperties.map((p) => p.id))}
                data-testid="button-bulk-unit-audit"
                title={selectedBulkPricingCount === 0 ? "Select properties with the checkboxes first" : "Run a full audit sweep on each selected property (queued one at a time; auto-fix + bounded unit replacement on)"}
              >
                🔍 Audit selected
                {selectedBulkPricingCount > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                    {selectedBulkPricingCount}
                  </Badge>
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                disabled={selectedBulkPricingCount === 0 || bulkPhotoCommunityStarting || bulkPhotoCommunityActive}
                onClick={() => void startBulkPhotoCommunityCheck(selectedBulkPricingProperties.map((p) => p.id))}
                data-testid="button-bulk-photo-community-check"
                title={selectedBulkPricingCount === 0 ? "Select properties with the checkboxes first" : "Run photo community check on selected properties"}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${bulkPhotoCommunityStarting || bulkPhotoCommunityActive ? "animate-spin" : ""}`} />
                Check photo community
                {selectedBulkPricingCount > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                    {selectedBulkPricingCount}
                  </Badge>
                )}
              </Button>
              <Dialog open={bulkPricingOpen} onOpenChange={setBulkPricingOpen}>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5"
                    // Stays clickable with zero rows selected whenever there's a
                    // queue to show — an operator returning from their phone
                    // must be able to open the dialog and see the running queue
                    // or the finished Guesty push confirmation.
                    disabled={selectedBulkPricingCount === 0 && !bulkPricingJob}
                    data-testid="button-bulk-market-pricing"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Update market pricing
                    {selectedBulkPricingCount > 0 && (
                      <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                        {selectedBulkPricingCount}
                      </Badge>
                    )}
                    {bulkPricingJob && (
                      <Badge
                        variant="outline"
                        className={`ml-1 h-5 px-1.5 text-[10px] ${
                          bulkPricingJob.status === "running" || bulkPricingJob.status === "queued"
                            ? "border-blue-300 bg-blue-50 text-blue-700"
                            : bulkPricingJob.status === "completed"
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                              : bulkPricingJob.status === "failed"
                                ? "border-red-300 bg-red-50 text-red-700"
                                : "border-slate-300 bg-slate-50 text-slate-600"
                        }`}
                      >
                        {bulkPricingJob.status === "running" || bulkPricingJob.status === "queued" ? (
                          <>
                            <Loader2 className="mr-0.5 h-3 w-3 animate-spin" />
                            {bulkPricingJob.completed}/{bulkPricingJob.total}
                          </>
                        ) : (
                          `queue ${bulkPricingJob.status}`
                        )}
                      </Badge>
                    )}
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Bulk market pricing queue</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="rounded-md border bg-muted/20 p-3 text-sm">
                      <p className="font-medium">Runs one selected property at a time.</p>
                      <p className="mt-1 text-muted-foreground">
                        For each property, this scans SearchAPI Airbnb for real market comps and sets each month's buy-in rate from the Airbnb median — a 7-night sample per calendar month across ~12 months, with year-2 extrapolation. It then pushes the marked-up base rates to Guesty. The queue runs entirely on the server: you can close this tab, leave Safari, or lock your phone and it keeps going to the end (it even auto-resumes after a server restart). Come back any time — this dialog shows the live progress or the finished result with the Guesty push confirmation.
                      </p>
                    </div>
                    {!bulkPricingJob ? (
                      <div className="space-y-3">
                        {activeBulkPricingHistory && (
                          <div className="flex items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                            <div>
                              <p className="font-medium">A market-pricing queue is already running.</p>
                              <p className="text-blue-800">
                                {activeBulkPricingHistory.completed} / {activeBulkPricingHistory.total} complete · started {formatBulkPricingTime(activeBulkPricingHistory.startedAt || activeBulkPricingHistory.createdAt)}
                              </p>
                            </div>
                            <Button type="button" size="sm" variant="outline" onClick={() => setBulkPricingJob(activeBulkPricingHistory)}>
                              View queue
                            </Button>
                          </div>
                        )}
                        <div className="max-h-64 overflow-y-auto rounded-md border">
                          {selectedBulkPricingProperties.map((property) => (
                            <div key={property.id} className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{property.name}</p>
                                <p className="truncate text-xs text-muted-foreground">{property.community} · {property.bedrooms}BR</p>
                              </div>
                              <Badge variant="outline" className="shrink-0">Queued</Badge>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            onClick={startBulkPricingRefresh}
                            disabled={bulkPricingStarting || selectedBulkPricingCount === 0}
                            data-testid="button-start-bulk-market-pricing"
                          >
                            {bulkPricingStarting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                            Start queue
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {bulkPricingLooksStale && (
                          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                            This queue has not reported a heartbeat in over five minutes. It is saved on the server and will be re-claimed automatically if the worker died.
                          </div>
                        )}
                        {bulkPricingTerminal && bulkPricingPushSummary && bulkPricingPushSummary.total > 0 && (
                          bulkPricingPushSummary.allPushed ? (
                            <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="bulk-pricing-push-confirmed">
                              <p className="font-semibold">
                                ✓ Guesty push confirmed — all {bulkPricingPushSummary.pushed} of {bulkPricingPushSummary.total} properties pushed their rates to Guesty
                              </p>
                              <p className="mt-0.5 text-xs text-emerald-800">
                                Each push was verified against Guesty's calendar by read-back where Guesty allowed it. Per-property details are on each row below.
                              </p>
                            </div>
                          ) : (
                            <div
                              className={`rounded-md border p-3 text-sm ${bulkPricingPushSummary.failed > 0 ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}
                              data-testid="bulk-pricing-push-incomplete"
                            >
                              <p className="font-semibold">
                                ⚠ Guesty push confirmed for only {bulkPricingPushSummary.pushed} of {bulkPricingPushSummary.total} properties
                              </p>
                              {bulkPricingPushSummary.attention.length > 0 && (
                                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                                  {bulkPricingPushSummary.attention.slice(0, 12).map((a) => (
                                    <li key={`${a.propertyId}-${a.label}`}>
                                      <span className="font-medium">{a.label}</span>: {a.detail}
                                    </li>
                                  ))}
                                  {bulkPricingPushSummary.attention.length > 12 && (
                                    <li>+{bulkPricingPushSummary.attention.length - 12} more — see the rows below</li>
                                  )}
                                </ul>
                              )}
                              {bulkPricingPushSummary.cancelled > 0 && (
                                <p className="mt-1 text-xs">{bulkPricingPushSummary.cancelled} item(s) were cancelled before pushing.</p>
                              )}
                              <p className="mt-1 text-xs">
                                Use "Retry failed rows" (or re-run the queue for the listed properties) so every property's rates land on Guesty.
                              </p>
                            </div>
                          )
                        )}
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Status</p>
                            <p className="text-sm font-semibold capitalize">{bulkPricingJob.status}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Completed</p>
                            <p className="text-sm font-semibold">{bulkPricingJob.completed} / {bulkPricingJob.total}</p>
                          </div>
                          {bulkPricingPushSummary && (
                            <div className="rounded-md border p-2" title="Properties whose refreshed rates were confirmed pushed to Guesty (verified by read-back where available)">
                              <p className="text-xs text-muted-foreground">Pushed to Guesty</p>
                              <p className={`text-sm font-semibold ${bulkPricingPushSummary.pushed === bulkPricingPushSummary.total ? "text-emerald-700" : bulkPricingTerminal ? "text-amber-700" : ""}`}>
                                {bulkPricingPushSummary.pushed} / {bulkPricingPushSummary.total}
                              </p>
                            </div>
                          )}
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Failed</p>
                            <p className="text-sm font-semibold">{bulkPricingJob.failed}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Cancelled</p>
                            <p className="text-sm font-semibold">{bulkPricingJob.cancelled}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Current</p>
                            <p className="truncate text-sm font-semibold">{runningBulkPricingItem?.label || "—"}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Last heartbeat</p>
                            <p className="text-sm font-semibold">{bulkPricingLastHeartbeat ? new Date(bulkPricingLastHeartbeat).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Lease expires</p>
                            <p className="text-sm font-semibold">{formatBulkPricingTime(bulkPricingJob.lockExpiresAt)}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Worker</p>
                            <p className="truncate text-sm font-semibold">{bulkPricingJob.lockedBy || "—"}</p>
                          </div>
                        </div>
                        {bulkPricingJob.startedAt && <BulkPricingChangesSummary job={bulkPricingJob} />}
                        <div className="max-h-80 overflow-y-auto rounded-md border">
                          {bulkPricingJob.items.map((item, index) => {
                            const statusTone =
                              item.status === "completed" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : item.status === "failed" ? "bg-red-50 text-red-700 border-red-200"
                              : item.status === "cancelled" ? "bg-slate-50 text-slate-600 border-slate-200"
                              : item.status === "running" ? "bg-blue-50 text-blue-700 border-blue-200"
                              : "bg-amber-50 text-amber-700 border-amber-200";
                            const percent = typeof item.progress?.percent === "number" ? Math.max(0, Math.min(100, item.progress.percent)) : 0;
                            const recipeLabel = formatPricingRecipe(item.progress?.pricingRecipe);
                            const recipeResort = pricingRecipeResort(item.progress?.pricingRecipe);
                            const recipeScaling = pricingRecipeScaling(item.progress?.pricingRecipe);
                            const confidence = item.progress?.confidence;
                            const confidenceScore = typeof confidence?.score === "number" ? Math.round(confidence.score) : null;
                            const sampleCount = typeof confidence?.sampleCount === "number" ? confidence.sampleCount : null;
                            const resortUnconfident = item.progress?.pricingRecipe?.resortConfident === false;
                            const bedroomSplitInferred = item.progress?.pricingRecipe?.bedroomSplitInferred === true;
                            const communityConfirmation = (item.progress?.pricingRecipe as any)?.communityConfirmation as
                              | { community: string; searchLabel: string; expectedCity?: string; expectedState?: string; nameMatch: boolean; locationMatch: boolean; curated: boolean; confirmed: boolean; detail: string }
                              | undefined;
                            // Evidence verdict (lands when the item's refresh completes).
                            // While it's present it subsumes the target-level
                            // communityConfirmation chip — one verdict, not two.
                            const matchConfirmation = item.progress?.matchConfirmation ?? null;
                            const perBedroomConfidence = Array.isArray(confidence?.perBedroom) ? confidence.perBedroom : [];
                            const anyWidened = confidence?.widened === true || perBedroomConfidence.some((b) => b.widened);
                            const blackoutCount = typeof item.progress?.blackoutCount === "number" ? item.progress.blackoutCount : 0;
                            const blackoutClosed = typeof item.progress?.blackoutClosed === "number" ? item.progress.blackoutClosed : 0;
                            const rateChanges = Array.isArray(item.progress?.rateChanges) ? item.progress.rateChanges : [];
                            const pushStatus = bulkPricingJob.dryRun ? null : guestyPushStatusForItem(item);
                            const pushChip = pushStatus && (pushStatus.outcome === "pushed" || pushStatus.outcome === "skipped" || pushStatus.outcome === "failed")
                              ? pushStatus
                              : null;
                            const pushedDays = item.progress?.guestyPush && !item.progress.guestyPush.skipped
                              ? item.progress.guestyPush.seasonal?.pushedDays
                              : undefined;
                            const verifiedDays = item.progress?.guestyPush && !item.progress.guestyPush.skipped
                              ? item.progress.guestyPush.seasonal?.verifiedDays
                              : undefined;
                            return (
                              <div key={`${item.propertyId}-${index}`} className="border-b px-3 py-3 last:border-b-0">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{item.label}</p>
                                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                      {item.progress?.label || item.error || "Waiting for its turn"}
                                    </p>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                      Attempt {item.attemptCount ?? 0} · heartbeat {formatBulkPricingTime(item.heartbeatAt)}
                                    </p>
                                    {(pushChip || matchConfirmation || communityConfirmation || recipeResort || recipeScaling || confidenceScore != null || blackoutCount > 0 || resortUnconfident || bedroomSplitInferred) && (
                                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                                        {pushChip && (
                                          <span
                                            className={`inline-flex max-w-full items-center gap-1 rounded border px-2 py-0.5 font-medium ${
                                              pushChip.outcome === "pushed"
                                                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                                                : pushChip.outcome === "skipped"
                                                  ? "border-amber-300 bg-amber-50 text-amber-800"
                                                  : "border-red-300 bg-red-50 text-red-800"
                                            }`}
                                            title={pushChip.detail}
                                          >
                                            <span aria-hidden>{pushChip.outcome === "pushed" ? "✓" : pushChip.outcome === "skipped" ? "⚠" : "✕"}</span>
                                            <span className="truncate">
                                              {pushChip.outcome === "pushed"
                                                ? `Pushed to Guesty${typeof pushedDays === "number" ? ` · ${pushedDays} days` : ""}${typeof verifiedDays === "number" ? ` · ${verifiedDays} verified` : ""}`
                                                : pushChip.outcome === "skipped"
                                                  ? "NOT pushed to Guesty"
                                                  : "Guesty push not confirmed"}
                                            </span>
                                          </span>
                                        )}
                                        {matchConfirmation && (
                                          <span
                                            className={`inline-flex max-w-full items-center gap-1 rounded border px-2 py-0.5 font-semibold ${
                                              matchConfirmation.level === "green"
                                                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                                                : matchConfirmation.level === "red"
                                                  ? "border-red-300 bg-red-50 text-red-800"
                                                  : "border-amber-300 bg-amber-50 text-amber-800"
                                            }`}
                                            title={(matchConfirmation.reasons ?? []).join("\n")}
                                            data-testid={`bulk-pricing-match-${item.propertyId}`}
                                          >
                                            <span aria-hidden>{matchConfirmation.level === "green" ? "✓" : matchConfirmation.level === "red" ? "✕" : "⚠"}</span>
                                            <span className="truncate">{matchConfirmation.headline ?? "Community/bedroom verification"}</span>
                                          </span>
                                        )}
                                        {communityConfirmation && !matchConfirmation && (
                                          <span
                                            className={`inline-flex max-w-full items-center gap-1 rounded border px-2 py-0.5 font-medium ${communityConfirmation.confirmed ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-800"}`}
                                            title={`${communityConfirmation.detail} · researching: ${communityConfirmation.searchLabel}`}
                                          >
                                            <span aria-hidden>{communityConfirmation.confirmed ? "✓" : "⚠"}</span>
                                            <span className="truncate">
                                              {communityConfirmation.confirmed ? "Community confirmed" : "Confirm community"}: {communityConfirmation.community}
                                              {[communityConfirmation.expectedCity, communityConfirmation.expectedState].filter(Boolean).length > 0
                                                ? ` · ${[communityConfirmation.expectedCity, communityConfirmation.expectedState].filter(Boolean).join(", ")}`
                                                : ""}
                                            </span>
                                          </span>
                                        )}
                                        {resortUnconfident && !communityConfirmation && !matchConfirmation && (
                                          <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800" title="This draft's community could not be matched to a curated market, so the resort searched is a best-guess fallback. Verify the resort before trusting these rates.">
                                            ⚠ resort not confidently matched
                                          </span>
                                        )}
                                        {bedroomSplitInferred && (
                                          <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800" title="This combo's per-unit bedroom split was inferred from the combined total (no explicit per-unit data), so the sizes researched may be wrong — e.g. a real 4BR+2BR researched as 3BR+3BR. Verify the split.">
                                            ⚠ bedroom split inferred
                                          </span>
                                        )}
                                        {recipeResort && (
                                          <span
                                            className="inline-flex max-w-full items-center gap-1 truncate rounded border bg-muted/40 px-2 py-0.5 text-muted-foreground"
                                            title={recipeLabel ?? undefined}
                                          >
                                            <span aria-hidden>🔎</span>
                                            <span className="truncate">
                                              Scanned <span className="font-medium text-foreground">{recipeResort}</span>
                                            </span>
                                          </span>
                                        )}
                                        {recipeScaling && (
                                          <span
                                            className="inline-flex items-center gap-1 rounded border bg-muted/40 px-2 py-0.5 text-muted-foreground"
                                            title={recipeScaling.combo
                                              ? "Combo listing: each unit is priced from a real Airbnb comp of its OWN bedroom size, then summed — never a single smaller comp scaled up to the larger size."
                                              : "Single unit priced directly from an Airbnb comp of its own bedroom size."}
                                          >
                                            <span aria-hidden>🛏️</span>
                                            {recipeScaling.label}
                                          </span>
                                        )}
                                        {blackoutCount > 0 && (
                                          <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700" title="Windows with no confident exact-bedroom comps were blacked out and closed on the Guesty calendar">
                                            🚫 {blackoutCount} blacked out{blackoutClosed > 0 ? ` · ${blackoutClosed} closed` : ""}
                                          </span>
                                        )}
                                        {confidenceScore != null && (
                                          <span className={cn("rounded border px-2 py-0.5 font-medium", confidenceTone(confidence?.level))} title={confidence?.summary}>
                                            Confidence {confidenceScore}%
                                          </span>
                                        )}
                                        {typeof confidence?.acceptedCandidates === "number" && (
                                          <span className="rounded border bg-background px-2 py-0.5 text-muted-foreground">
                                            {confidence.acceptedCandidates} accepted
                                          </span>
                                        )}
                                        {typeof confidence?.rejectedCandidates === "number" && confidence.rejectedCandidates > 0 && (
                                          <span className="rounded border bg-background px-2 py-0.5 text-muted-foreground">
                                            {confidence.rejectedCandidates} rejected
                                          </span>
                                        )}
                                        {sampleCount != null && (
                                          <span
                                            className="rounded border bg-background px-2 py-0.5 text-muted-foreground"
                                            title="Total Airbnb comps that backed this property's basis across the scanned months. A very low count is the strongest tell that the resort query may be too thin or wrong."
                                          >
                                            {sampleCount} comp{sampleCount === 1 ? "" : "s"}
                                          </span>
                                        )}
                                        {anyWidened && (
                                          <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700" title="At least one month's basis came from a widened search box because the resort footprint had no priced comps — comps are nearby-area, not strictly the resort.">
                                            ↔ widened search area
                                          </span>
                                        )}
                                      </div>
                                    )}
                                    {perBedroomConfidence.length > 1 && (
                                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                                        <span className="text-muted-foreground">By size:</span>
                                        {perBedroomConfidence.map((b) => (
                                          <span
                                            key={b.bedrooms}
                                            className={cn("rounded border px-2 py-0.5 font-medium", confidenceTone(b.level))}
                                            title={`${b.bedrooms}BR researched: ${Math.round(b.score)}% confidence, ${b.sampleCount} comp${b.sampleCount === 1 ? "" : "s"}${b.geoRadiusMiles != null ? ` within ~${b.geoRadiusMiles}mi` : ""}${b.widened ? " (widened search area)" : ""}.`}
                                          >
                                            {b.bedrooms}BR {Math.round(b.score)}% · {b.sampleCount} comp{b.sampleCount === 1 ? "" : "s"}{b.widened ? " · ↔" : ""}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    {rateChanges.length > 0 && (
                                      <div className="mt-2 rounded border bg-background px-2 py-1.5">
                                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          Rate change
                                        </p>
                                        <RateChangesList
                                          changes={rateChanges}
                                          itemClassName="text-[11px]"
                                        />
                                      </div>
                                    )}
                                  </div>
                                  <Badge variant="outline" className={`shrink-0 capitalize ${statusTone}`}>
                                    {item.status === "running" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                                    {item.status}
                                  </Badge>
                                </div>
                                {(item.status === "running" || percent > 0) && (
                                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                                    <div className="h-full rounded-full bg-[hsl(var(--brand-blue))]" style={{ width: `${percent}%` }} />
                                  </div>
                                )}
                                {item.error && <p className="mt-1 text-xs text-red-700">{item.error}</p>}
                              </div>
                            );
                          })}
                        </div>
                        {bulkPricingEvents.length > 0 && (
                          <div className="rounded-md border">
                            <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Queue event history
                            </div>
                            <div className="max-h-40 overflow-y-auto">
                              {bulkPricingEvents.slice(0, 12).map((event, index) => (
                                <div key={`${event.createdAt}-${index}`} className="flex items-start justify-between gap-3 border-b px-3 py-2 text-xs last:border-b-0">
                                  <div className="min-w-0">
                                    <p className={event.level === "error" ? "font-medium text-red-700" : event.level === "warn" ? "font-medium text-amber-700" : "font-medium"}>
                                      {event.message}
                                    </p>
                                    <p className="text-muted-foreground">{event.phase}</p>
                                  </div>
                                  <span className="shrink-0 text-muted-foreground">{formatBulkPricingTime(event.createdAt)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={clearBulkPricingQueue}
                            disabled={bulkPricingClearing}
                            title={bulkPricingTerminal ? "Dismiss this finished queue" : "Stop and clear the whole queue (including any stuck item)"}
                          >
                            {bulkPricingClearing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            Clear queue
                          </Button>
                          <div className="flex items-center gap-2">
                            {bulkPricingJob.failed > 0 && bulkPricingTerminal && (
                              <Button
                                type="button"
                                variant="outline"
                                onClick={retryFailedBulkPricingRefresh}
                                disabled={bulkPricingRetrying}
                                data-testid="button-retry-failed-bulk-market-pricing"
                              >
                                {bulkPricingRetrying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                                Retry failed
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="destructive"
                              onClick={cancelBulkPricingRefresh}
                              disabled={bulkPricingTerminal || bulkPricingCancelling}
                              data-testid="button-cancel-bulk-market-pricing"
                            >
                              {bulkPricingCancelling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <StopCircle className="mr-2 h-4 w-4" />}
                              Cancel remaining
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
              <Dialog open={bulkAvailabilityOpen} onOpenChange={setBulkAvailabilityOpen}>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="hidden h-8 gap-1.5"
                    disabled={selectedBulkAvailabilityCount === 0}
                    data-testid="button-bulk-availability-scan"
                  >
                    <CalendarSearch className="h-3.5 w-3.5" />
                    Update availability
                    {selectedBulkAvailabilityCount > 0 && (
                      <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                        {selectedBulkAvailabilityCount}
                      </Badge>
                    )}
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-3xl">
                  <DialogHeader>
                    <DialogTitle>Bulk availability queue</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="rounded-md border bg-muted/20 p-3 text-sm">
                      <p className="font-medium">Runs one selected property at a time.</p>
                      <p className="mt-1 text-muted-foreground">
                        This uses the availability scanner for the selected dashboard rows and records each run in the Availability Scanner history. Select the rows you want, then start the queue here.
                      </p>
                      {selectedBulkPricingCount !== selectedBulkAvailabilityCount && (
                        <p className="mt-2 text-xs text-amber-700">
                          {selectedBulkPricingCount - selectedBulkAvailabilityCount} selected row{selectedBulkPricingCount - selectedBulkAvailabilityCount === 1 ? "" : "s"} cannot run availability yet because they are not in the scanner configuration.
                        </p>
                      )}
                    </div>

                    {!bulkAvailabilityQueue ? (
                      <div className="space-y-3">
                        <div className="max-h-64 overflow-y-auto rounded-md border">
                          {selectedBulkAvailabilityProperties.map((property) => (
                            <div key={property.id} className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{property.name}</p>
                                <p className="truncate text-xs text-muted-foreground">{property.community} · {property.bedrooms}BR</p>
                              </div>
                              <Badge variant="outline" className="shrink-0">Queued</Badge>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            onClick={startBulkAvailabilityScan}
                            disabled={bulkAvailabilityStarting || selectedBulkAvailabilityCount === 0}
                            data-testid="button-start-bulk-availability-scan"
                          >
                            {bulkAvailabilityStarting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CalendarSearch className="mr-2 h-4 w-4" />}
                            Start queue
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Status</p>
                            <p className="text-sm font-semibold capitalize">{bulkAvailabilityQueue.status}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Complete</p>
                            <p className="text-sm font-semibold">{bulkAvailabilityQueue.totals.success} / {bulkAvailabilityQueue.items.length}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Running</p>
                            <p className="text-sm font-semibold">{bulkAvailabilityQueue.totals.running}</p>
                          </div>
                          <div className="rounded-md border p-2">
                            <p className="text-xs text-muted-foreground">Errors</p>
                            <p className="text-sm font-semibold">{bulkAvailabilityQueue.totals.error}</p>
                          </div>
                        </div>
                        <div className="rounded-md border border-blue-100 bg-blue-50/60 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs text-blue-900">
                              This queue runs on the server, so it keeps going if you close this modal, change tabs, or leave the screen.
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              {bulkAvailabilityQueue.status === "running" && (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => runBulkAvailabilityAction("pause")}
                                    disabled={bulkAvailabilityAction !== null}
                                    data-testid="button-pause-bulk-availability"
                                  >
                                    {bulkAvailabilityAction === "pause" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Pause className="mr-2 h-4 w-4" />}
                                    Pause
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => runBulkAvailabilityAction("cancel")}
                                    disabled={bulkAvailabilityAction !== null}
                                    data-testid="button-cancel-bulk-availability"
                                  >
                                    {bulkAvailabilityAction === "cancel" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <StopCircle className="mr-2 h-4 w-4" />}
                                    Cancel
                                  </Button>
                                </>
                              )}
                              {bulkAvailabilityQueue.status === "paused" && (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => runBulkAvailabilityAction("resume")}
                                    disabled={bulkAvailabilityAction !== null}
                                    data-testid="button-resume-bulk-availability"
                                  >
                                    {bulkAvailabilityAction === "resume" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                                    Resume
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => runBulkAvailabilityAction("cancel")}
                                    disabled={bulkAvailabilityAction !== null}
                                    data-testid="button-cancel-paused-bulk-availability"
                                  >
                                    {bulkAvailabilityAction === "cancel" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <StopCircle className="mr-2 h-4 w-4" />}
                                    Cancel
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="max-h-80 overflow-y-auto rounded-md border">
                          {bulkAvailabilityQueue.items.map((item) => {
                            const statusTone =
                              item.status === "success" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : item.status === "error" ? "bg-red-50 text-red-700 border-red-200"
                              : item.status === "cancelled" ? "bg-slate-50 text-slate-600 border-slate-200"
                              : item.status === "running" ? "bg-blue-50 text-blue-700 border-blue-200"
                              : "bg-amber-50 text-amber-700 border-amber-200";
                            const percent = typeof item.progress?.percent === "number" ? Math.max(0, Math.min(100, item.progress.percent)) : 0;
                            const showProgress = item.status === "running" || percent > 0;
                            return (
                              <div key={item.propertyId} className="border-b px-3 py-3 last:border-b-0">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{item.name}</p>
                                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                      {item.progress?.label || item.message || `${item.community} · ${item.totalBedrooms} total BR`}
                                    </p>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                      {item.runId ? `Run #${item.runId}` : "No run yet"} · {item.progress ? `${item.progress.scanned}/${item.progress.total} windows` : "waiting"}
                                      {item.progress && ` · ${item.progress.available} available · ${item.progress.blocked} blocked · ${item.progress.errors} errors`}
                                      {" · "}updated {formatBulkPricingTime(item.progress?.updatedAt || item.completedAt || item.startedAt)}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <Badge variant="outline" className={`capitalize ${statusTone}`}>
                                      {item.status === "running" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                                      {item.status}
                                    </Badge>
                                    {item.status === "running" && (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-xs"
                                        onClick={() => runBulkAvailabilityAction("cancel")}
                                        disabled={bulkAvailabilityAction !== null}
                                        title="Cancel the running availability queue"
                                      >
                                        <StopCircle className="mr-1 h-3.5 w-3.5" />
                                        Cancel
                                      </Button>
                                    )}
                                  </div>
                                </div>
                                {showProgress && (
                                  <div className="mt-2">
                                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                                      <span>{percent}%</span>
                                      <span>{item.progress?.scanned ?? 0} / {item.progress?.total ?? 0}</span>
                                    </div>
                                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                                      <div className="h-full rounded-full bg-[hsl(var(--brand-blue))] transition-all" style={{ width: `${percent}%` }} />
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {bulkAvailabilityQueue.status === "running" && (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => runBulkAvailabilityAction("pause")}
                                disabled={bulkAvailabilityAction !== null}
                              >
                                {bulkAvailabilityAction === "pause" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Pause className="mr-2 h-4 w-4" />}
                                Pause queue
                              </Button>
                              <Button
                                type="button"
                                variant="destructive"
                                onClick={() => runBulkAvailabilityAction("cancel")}
                                disabled={bulkAvailabilityAction !== null}
                              >
                                {bulkAvailabilityAction === "cancel" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <StopCircle className="mr-2 h-4 w-4" />}
                                Cancel queue
                              </Button>
                            </>
                          )}
                          {bulkAvailabilityQueue.status === "paused" && (
                            <>
                              <Button
                                type="button"
                                onClick={() => runBulkAvailabilityAction("resume")}
                                disabled={bulkAvailabilityAction !== null}
                              >
                                {bulkAvailabilityAction === "resume" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                                Resume queue
                              </Button>
                              <Button
                                type="button"
                                variant="destructive"
                                onClick={() => runBulkAvailabilityAction("cancel")}
                                disabled={bulkAvailabilityAction !== null}
                              >
                                {bulkAvailabilityAction === "cancel" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <StopCircle className="mr-2 h-4 w-4" />}
                                Cancel queue
                              </Button>
                            </>
                          )}
                          {bulkAvailabilityQueue.status !== "running" && bulkAvailabilityQueue.status !== "paused" && (
                            <Button
                              type="button"
                              onClick={startBulkAvailabilityScan}
                              disabled={bulkAvailabilityStarting || selectedBulkAvailabilityCount === 0}
                            >
                              {bulkAvailabilityStarting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CalendarSearch className="mr-2 h-4 w-4" />}
                              Start selected queue
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => runBulkAvailabilityAction("clear")}
                            disabled={bulkAvailabilityAction !== null || bulkAvailabilityActive}
                          >
                            {bulkAvailabilityAction === "clear" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Clear queue
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
              <Badge variant="outline" className="text-xs">
                <BedDouble className="h-3 w-3 mr-1" />
                Avg {avgBedrooms} BR
              </Badge>
            </div>
          </div>
          {paymentFailureWarnings.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-300 bg-red-50/70 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/30" data-testid="banner-payment-failures">
              <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  {paymentFailureWarnings.length} booking{paymentFailureWarnings.length === 1 ? " has" : "s have"} a failed or uncollected guest payment
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setPaymentFailureWarningOpen(true)}
                data-testid="button-open-payment-failure-warning"
              >
                Review payments
              </Button>
            </div>
          )}
          {buyInCoverageWarnings.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-300 bg-red-50/70 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/30" data-testid="banner-buyin-coverage">
              <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  {buyInCoverageWarnings.length} booking{buyInCoverageWarnings.length === 1 ? " checks" : "s check"} in within {buyInCoverageData?.windowDays ?? 15} days with units NOT bought in{buyInCoverageWarnings.some((w) => w.kind === "unknown-requirements") ? " (some listings need a bedroom count fixed)" : ""}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setBuyInCoverageWarningOpen(true)}
                data-testid="button-open-buyin-coverage-warning"
              >
                Review units
              </Button>
            </div>
          )}
          {arrivalDetailsWarnings.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/30" data-testid="banner-arrival-details-coverage">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  {arrivalDetailsWarnings.length} booking{arrivalDetailsWarnings.length === 1 ? " checks" : "s check"} in within {arrivalCoverageData?.windowDays ?? 14} days without arrival details sent
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setArrivalDetailsWarningOpen(true)}
                data-testid="button-open-arrival-details-warning"
              >
                Review arrivals
              </Button>
            </div>
          )}
          {confirmationIssues.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-300 bg-red-50/70 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/30" data-testid="banner-confirmation-issues">
              <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  {confirmationIssues.length} booking confirmation{confirmationIssues.length === 1 ? "" : "s"} did NOT reach the guest
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setConfirmationIssuesOpen(true)}
                data-testid="button-open-confirmation-issues"
              >
                Review &amp; resend
              </Button>
            </div>
          )}
          {duplicatePhotoUnits.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-300 bg-red-50/70 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/30" data-testid="banner-duplicate-photos">
              <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  {duplicatePhotoUnits.length} unit{duplicatePhotoUnits.length === 1 ? " has" : "s have"} duplicate photos on Airbnb / VRBO / Booking.com
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setDuplicatePhotoWarningOpen(true)}
                data-testid="button-open-duplicate-photo-warning"
              >
                Review &amp; fix
              </Button>
            </div>
          )}
          {addressAlertUnits.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-orange-300 bg-orange-50/70 px-3 py-2 text-sm dark:border-orange-900 dark:bg-orange-950/30" data-testid="banner-address-alert">
              <div className="flex items-center gap-2 text-orange-700 dark:text-orange-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  {addressAlertUnits.length} unit{addressAlertUnits.length === 1 ? "'s address appears" : "s' addresses appear"} on another Airbnb / VRBO / Booking.com listing
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setAddressAlertWarningOpen(true)}
                data-testid="button-open-address-alert"
              >
                Review
              </Button>
            </div>
          )}
          {(autoReplaceQueue?.jobs.length ?? 0) > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm dark:border-sky-900 dark:bg-sky-950/30" data-testid="banner-auto-replace-queue">
              <div className="flex items-center gap-2">
                {(autoReplaceQueue?.activeCount ?? 0) > 0 ? (
                  <Loader2 className="h-4 w-4 animate-spin text-sky-700 dark:text-sky-300" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                )}
                <span>
                  {(autoReplaceQueue?.activeCount ?? 0) > 0
                    ? `Replacing photos for ${autoReplaceQueue!.activeCount} unit${autoReplaceQueue!.activeCount === 1 ? "" : "s"} in the background — safe to leave.`
                    : "Photo replacement finished — indicators refresh as verification lands."}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAutoReplaceQueueOpen(true)}
                  data-testid="button-open-auto-replace-queue"
                >
                  View activity
                </Button>
                {(autoReplaceQueue?.jobs ?? []).some((job) => !isAutoReplacePhaseActive(job.phase)) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={clearAutoReplaceQueueMutation.isPending}
                    onClick={() => clearAutoReplaceQueueMutation.mutate()}
                    data-testid="button-clear-auto-replace-queue"
                  >
                    {clearAutoReplaceQueueMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    Clear
                  </Button>
                )}
              </div>
            </div>
          )}
          {bulkPhotoCommunityJob && bulkPhotoCommunityActive && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-testid="bulk-photo-community-progress">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-amber-700" />
                <span>
                  Photo community check: {bulkPhotoCommunityJob.completed} / {bulkPhotoCommunityJob.total} complete
                  {bulkPhotoCommunityJob.items.find((item) => item.status === "running")
                    ? ` — running ${bulkPhotoCommunityJob.items.find((item) => item.status === "running")!.label}`
                    : ""}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={bulkPhotoCommunityCancelling}
                onClick={() => void cancelBulkPhotoCommunityCheck()}
              >
                {bulkPhotoCommunityCancelling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <StopCircle className="mr-2 h-4 w-4" />}
                Cancel
              </Button>
            </div>
          )}
          <div className="overflow-x-auto overscroll-x-contain [&>div]:overflow-visible">
          {/*
            table-fixed layout: every column width is declared explicitly via the
            per-<TableHead> `w-[Npx]` classes below (the first row drives the fixed
            layout). Do NOT reintroduce a <colgroup> here — the previous one had
            only 16 <col> entries for 20 columns (added incrementally: Scanned,
            Added, Total Revenue, Last Price Scan) and its positional widths landed
            on the wrong columns, starving the icon columns (Photos / Comm QA) so
            their fixed-minWidth badge rows spilled into neighbouring cells. Keeping
            the widths solely on the <th> keeps a single source of truth. The sum of
            the column widths (~1766px) exceeds min-w so the wrapping
            `overflow-x-auto` div scrolls horizontally on narrow / mobile viewports.
          */}
          <Table id="list-properties" className="min-w-[1340px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30px] text-center px-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={visibleBulkPricingIds.length === 0}
                    onClick={toggleVisibleBulkPricingRows}
                    title={allVisibleBulkPricingSelected ? "Clear visible bulk selections" : "Select visible properties for bulk pricing, availability, or photo community check"}
                    aria-label={allVisibleBulkPricingSelected ? "Clear visible bulk selections" : "Select visible properties for bulk pricing, availability, or photo community check"}
                    data-testid="button-select-visible-pricing"
                  >
                    {allVisibleBulkPricingSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                  </Button>
                </TableHead>
                <TableHead className="w-[78px] sticky left-0 bg-background z-10">Actions</TableHead>
                <TableHead className="w-[26px] text-center px-0 text-muted-foreground">#</TableHead>
                <TableHead className="w-[20px] text-center px-0" title="Guesty listing connected — click to sort (connected first)">
                  {/* Stacked label-over-icon so the sort control fits the fixed
                      20px column — table-fixed reads widths off this row, so
                      widening this <th> would reflow every other column. */}
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full flex-col gap-0 px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("guestyListed")}
                    data-testid="button-sort-guesty-listed"
                    id="button-sort-guesty-listed"
                    aria-label="Sort by Guesty connection"
                  >
                    G
                    <SortIcon field="guestyListed" />
                  </Button>
                </TableHead>
                <TableHead className="w-[80px] text-center px-0.5">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("propertyId")}
                    data-testid="button-sort-property-id"
                    id="button-sort-property-id"
                    aria-label="Sort by property ID"
                  >
                    Property ID
                    <SortIcon field="propertyId" />
                  </Button>
                </TableHead>
                <TableHead className="w-[86px] text-center px-1" title="Airbnb / VRBO / Booking.com — green = live & bookable, red = not live">Channels</TableHead>
                <TableHead className="w-[112px] text-center px-1" title="Reverse-image search (top row A/V/B) — green = photos not found on that platform, red = photos appear on another listing, gray = not checked or inconclusive. 📍 row = address-on-OTA check: does this unit's street address appear on an Airbnb/VRBO/Booking listing (unit-number gated, our own listings excluded). Note: Airbnb & VRBO hide exact addresses on public pages, so a green address dot there means 'not publicly published', not a guarantee the unit isn't relisted — Booking.com is the reliable address signal.">
                  <div className="flex items-center justify-center gap-1">
                    <span>Photos</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title="Run a DEEP photo match scan (full gallery + address) for all scannable listings"
                      aria-label="Run photo match scan"
                      disabled={photoScanMutation.isPending}
                      onClick={() => photoScanMutation.mutate({ label: "All scannable listings" })}
                      data-testid="button-run-photo-match-scan"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${photoScanMutation.isPending ? "animate-spin" : ""}`} />
                    </Button>
                  </div>
                </TableHead>
                <TableHead className="w-[84px] text-center px-1" title="Date & time the units' photos (Unit A/B) were last scanned against Airbnb / VRBO / Booking.com to confirm the units aren't listed there — runs automatically once a week. '—' = no scannable unit folders, 'Never' = not scanned yet, amber = older than the weekly cadence.">
                  Scanned
                </TableHead>
                <TableHead className="w-[104px] text-center px-1" title="Photo community QA: B = bedroom photo coverage, C = community folder matches resort, M = all folders same community">
                  Comm QA
                </TableHead>
                <TableHead className="w-[84px] text-center px-1" title="Unit Audit Sweep — one click verifies every data aspect of the listing (duplicate photos, community match + bedrooms, OTA reposts, descriptions, amenities, cover collage, layout, pricing, channels + licenses). Click the badge for the full per-stage receipt.">
                  Audit
                </TableHead>
                <TableHead className="w-[190px] max-w-[190px] px-1">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("name")}
                    data-testid="button-sort-name"
                    id="button-sort-name"
                    aria-label="Sort by property name"
                  >
                    Property Name
                    <SortIcon field="name" />
                  </Button>
                </TableHead>
                <TableHead className="w-[274px] pl-1 pr-2">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("community")}
                    data-testid="button-sort-community"
                    id="button-sort-community"
                    aria-label="Sort by community"
                  >
                    Community
                    <SortIcon field="community" />
                  </Button>
                </TableHead>
                <TableHead className="w-[92px] pl-1 pr-0.5" title="Community/resort-wide minimum-night rule from published evidence. Unknown is safer than guessing from one OTA listing.">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("minimumStay")}
                    data-testid="button-sort-minimum-stay"
                    id="button-sort-minimum-stay"
                    aria-label="Sort by minimum stay"
                  >
                    Min Stay
                    <SortIcon field="minimumStay" />
                  </Button>
                </TableHead>
                <TableHead className="text-right w-[88px] px-0.5">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("baseRate")}
                    data-testid="button-sort-base-rate"
                    id="button-sort-base-rate"
                    aria-label="Sort by base rate"
                  >
                    Base Rate
                    <SortIcon field="baseRate" />
                  </Button>
                </TableHead>
                <TableHead className="w-[72px] px-0.5">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("island")}
                    data-testid="button-sort-island"
                    id="button-sort-island"
                    aria-label="Sort by island"
                  >
                    Island
                    <SortIcon field="island" />
                  </Button>
                </TableHead>
                <TableHead className="text-center w-[42px]">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("bedrooms")}
                    data-testid="button-sort-bedrooms"
                    id="button-sort-bedrooms"
                    aria-label="Sort by bedrooms"
                  >
                    BR
                    <SortIcon field="bedrooms" />
                  </Button>
                </TableHead>
                <TableHead className="text-center w-[54px]">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("guests")}
                    data-testid="button-sort-guests"
                    id="button-sort-guests"
                    aria-label="Sort by guests"
                  >
                    Guests
                    <SortIcon field="guests" />
                  </Button>
                </TableHead>
                <TableHead className="text-center w-[46px]">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("unitCount")}
                    data-testid="button-sort-unit-count"
                    id="button-sort-unit-count"
                    aria-label="Sort by unit count"
                  >
                    Units
                    <SortIcon field="unitCount" />
                  </Button>
                </TableHead>
                <TableHead className="w-[88px] px-0.5" title="Date this listing was added into the system (from the community draft's created date). The 11 original core properties predate per-row tracking and show —.">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("dateAdded")}
                    data-testid="button-sort-date-added"
                    id="button-sort-date-added"
                    aria-label="Sort by date added"
                  >
                    Added
                    <SortIcon field="dateAdded" />
                  </Button>
                </TableHead>
                <TableHead className="w-[104px] px-0.5 text-right" title="Total revenue from bookings MADE in the last 365 days (by booking date, including upcoming stays), summed from connected Guesty listings plus manual bookings. Refreshed automatically once a day. Properties with no connected listing or no bookings in the window show —.">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("totalRevenue")}
                    data-testid="button-sort-total-revenue"
                    id="button-sort-total-revenue"
                    aria-label="Sort by total revenue (last 365 days, by booking date)"
                  >
                    Total Revenue
                    <SortIcon field="totalRevenue" />
                  </Button>
                </TableHead>
                <TableHead className="w-[96px] px-0.5 text-center" title="Date & time this listing's market-rate pricing table was last refreshed (SearchAPI Airbnb seasonal bases) AND pushed to Guesty — runs automatically once a week, or whenever you click 'Update Market Rates'. 'Seeded' = initial backfill (no live push yet), amber = older than the weekly cadence, red = the last push errored, '—' = never pushed.">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-0 min-w-0 max-w-full gap-1.5 whitespace-normal px-0 py-0 text-[11px] font-medium leading-tight"
                    onClick={() => handleSort("lastPriceScan")}
                    data-testid="button-sort-last-price-scan"
                    id="button-sort-last-price-scan"
                    aria-label="Sort by last price scan (market-rate Guesty push)"
                  >
                    Last Price Scan
                    <SortIcon field="lastPriceScan" />
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((property, idx) => {
                const unitCountDisplay = communityUnitCountDisplay(property);
                // Three states for the Actions column:
                //   1. Active hardcoded property (in unitBuilderIds) → Build link
                //   2. Draft awaiting promotion (draftStatus !== "published") →
                //      DRAFT pill + Promote (publish) + Delete
                //   3. Promoted draft (draftStatus === "published") → renders
                //      like an active row (Build link, regular styling) so the
                //      operator can click into the builder for it. Build links
                //      to `/builder/<negative-id>/preflight`; the preflight
                //      page falls back to fetching the draft when the property
                //      isn't in the static unitBuilderData list.
                const isDraft = property.draftId !== undefined;
                const isPublishedDraft = isDraft && property.draftStatus === "published";
                const isResearchDraft = isDraft && !isPublishedDraft;
                const minStay = minimumStayDisplay(property);
                return (
                <TableRow
                  key={property.id}
                  data-testid={`row-property-${property.id}`}
                  id={`item-property-${property.id}`}
                  className={isResearchDraft ? "bg-amber-50/40 dark:bg-amber-900/10" : ""}
                >
                  <TableCell className="px-0.5 py-2 text-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={!isBulkPricingSelectable(property)}
                      onClick={() => toggleBulkPricingRow(property.id)}
                      title={isBulkPricingSelectable(property) ? "Select for bulk pricing, availability, or photo community check" : "Publish this draft before bulk actions"}
                      aria-label={`Select ${property.name} for bulk pricing, availability, or photo community check`}
                      data-testid={`button-select-pricing-${property.id}`}
                    >
                      {selectedPricingIds.has(property.id) ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                    </Button>
                  </TableCell>
                  <TableCell
                    className="sticky left-0 z-10 px-1 py-2 bg-background"
                    style={{ background: isResearchDraft ? "#fffbeb" : undefined }}
                  >
                    {isResearchDraft ? (
                      <div className="flex items-center gap-1">
                        <Badge
                          variant="outline"
                          className="h-7 px-2 text-[10px] font-semibold bg-amber-100 border-amber-300 text-amber-900"
                          data-testid={`badge-draft-${property.draftId}`}
                        >
                          DRAFT
                        </Badge>
                        <button
                          onClick={() => promoteDraftMutation.mutate(property.draftId!)}
                          disabled={promoteDraftMutation.isPending}
                          className="text-emerald-700 hover:text-emerald-800 transition-colors p-1 disabled:opacity-50"
                          aria-label="Promote draft to active property"
                          data-testid={`button-promote-draft-${property.draftId}`}
                          title="Promote to active property"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => deleteDraftMutation.mutate(property.draftId!)}
                          className="text-muted-foreground hover:text-destructive transition-colors p-1"
                          aria-label="Delete draft"
                          data-testid={`button-delete-draft-${property.draftId}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ) : isPublishedDraft ? (
                      <Link href={`/builder/${property.id}/preflight`}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2 gap-1"
                          data-testid={`button-unit-builder-${property.id}`}
                          aria-label={`Open builder for ${property.name}`}
                        >
                          <Hammer className="h-3 w-3" />
                          Build
                        </Button>
                      </Link>
                    ) : unitBuilderIds.has(property.id) ? (
                      <Link href={`/builder/${property.id}/preflight`}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2 gap-1"
                          data-testid={`button-unit-builder-${property.id}`}
                          id={`btn-build-${property.id}`}
                          aria-label={`Build property ${property.name}`}
                        >
                          <Hammer className="h-3 w-3" />
                          Build
                        </Button>
                      </Link>
                    ) : null}
                  </TableCell>
                  <TableCell className="px-0 py-2 text-center text-xs text-muted-foreground">{idx + 1}</TableCell>
                  <TableCell className="px-0 py-2 text-center">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {guestyConnected.has(property.id) ? (
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full"
                              style={{ background: "#16a34a" }}
                              data-testid={`dot-guesty-${property.id}`}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConnectTarget({ id: property.id, name: property.name })}
                              className="inline-block w-2.5 h-2.5 rounded-full hover:ring-2 hover:ring-emerald-300 transition-shadow cursor-pointer"
                              style={{ background: "#d1d5db" }}
                              aria-label={`Connect ${property.name} to a Guesty listing`}
                              data-testid={`dot-guesty-${property.id}`}
                            />
                          )}
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {guestyConnected.has(property.id)
                            ? "Connected to Guesty"
                            : "Click to connect to a Guesty listing"}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                  <TableCell className="px-0.5 py-2 text-center" data-testid={`cell-property-id-${property.id}`}>
                    <span className="font-mono text-sm font-medium tabular-nums">
                      {displayPropertyId(property)}
                    </span>
                  </TableCell>
                  <TableCell className="px-0.5 py-2 text-center">
                    {(() => {
                      // Dashboard channel indicators: three badges per row
                      // with three states:
                      //   - green ✓  → Guesty + channel reporting live AND
                      //                last sync succeeded (cleanly bookable)
                      //   - amber ⚠  → listed on channel, but Guesty's last
                      //                sync FAILED. Listing probably exists
                      //                but has stale/partial data — needs
                      //                operator attention (e.g. re-publish
                      //                from Guesty Distribution)
                      //   - red ✗    → not integrated / not listed at all
                      // The amber "partially live" state catches listings
                      // like Pili Mai on VRBO where Guesty shows LIVE ⚠ in
                      // the builder — before this, the dashboard rendered
                      // that as a clean green tick, which misled.
                      const s = channelStatusData?.[property.id];
                      type Tone = "ok" | "warn" | "bad";
                      const toneOf = (f?: ChannelFlag): Tone => {
                        if (!f) return "bad";
                        if (f.live && f.syncFailed) return "warn";
                        if (f.live) return "ok";
                        return "bad";
                      };
                      const items: Array<{ letter: string; name: string; tone: Tone }> = [
                        { letter: "A", name: "Airbnb",       tone: toneOf(s?.airbnb) },
                        { letter: "V", name: "VRBO",         tone: toneOf(s?.vrbo) },
                        { letter: "B", name: "Booking.com",  tone: toneOf(s?.bookingCom) },
                      ];
                      const PAL: Record<Tone, { bg: string; glyph: string; desc: string }> = {
                        ok:   { bg: "#16a34a", glyph: "✓", desc: "Live & bookable" },
                        warn: { bg: "#f59e0b", glyph: "⚠", desc: "Listed, but Guesty's last sync failed — may be stale" },
                        bad:  { bg: "#dc2626", glyph: "✗", desc: "Not live" },
                      };
                      return (
                        <div className="flex gap-[1px] justify-center items-center" data-testid={`channels-${property.id}`}>
                          {items.map((it) => {
                            const p = PAL[it.tone];
                            return (
                              <span
                                key={it.letter}
                                title={`${it.name}: ${p.desc}`}
                                className="inline-flex items-center justify-center h-[18px] px-0.5 rounded text-[8px] font-bold leading-none"
                                style={{ background: p.bg, color: "white", minWidth: 20 }}
                                data-testid={`channel-${it.name.toLowerCase().replace(/\./g, "")}-${property.id}`}
                              >
                                {it.letter}{p.glyph}
                              </span>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="px-0.5 py-2 text-center">
                    {(() => {
                      // Photo-match indicators mirror the Channels column:
                      // three badges per row with the same color palette.
                      //   - green ✓  → photos not found on that platform
                      //   - red ✗    → photos matched to ≥2 other listings
                      //                on that platform (likely re-post)
                      //   - gray ?   → not yet scanned or inconclusive.
                      // Unknown is deliberately neutral here: it means
                      // the scanner could not classify the folder, not
                      // that a possible OTA photo match exists.
                      const agg = photoByProperty.get(property.id);
                      type Tone = "ok" | "unknown" | "bad" | "warn" | "na";
                      // "na" = the property has no scannable folders
                      // (all unit photoFolders are placeholders or
                      // community-*). The scanner won't write rows for
                      // these, so showing amber "never scanned" would
                      // be misleading — render grey + clarify in the
                      // tooltip that the unit folder name needs a
                      // real unit number to enable scanning.
                      const noFolders = !agg || !agg.hasScannableFolders;
                      const toneOf = (s: PhotoAggStatus): Tone => {
                        if (noFolders) return "na";
                        if (s === "clean") return "ok";
                        if (s === "found") return "bad";
                        if (agg?.hasProviderError) return "warn";
                        return "unknown"; // unknown or null: inconclusive, not a match
                      };
                      const PAL: Record<Tone, { bg: string; glyph: string }> = {
                        ok:      { bg: "#16a34a", glyph: "✓" },
                        unknown: { bg: "#9ca3af", glyph: "?" },
                        bad:     { bg: "#dc2626", glyph: "✗" },
                        warn:    { bg: "#f59e0b", glyph: "!" },
                        na:      { bg: "#9ca3af", glyph: "–" },
                      };
                      const unitList = (units: PhotoMatchedUnit[], key: "label" | "detailLabel" = "label") => {
                        const labels = units.map((unit) => unit[key]).filter(Boolean);
                        if (labels.length <= 1) return labels[0] ?? "unit folder";
                        return `${labels.slice(0, -1).join(", ")} + ${labels[labels.length - 1]}`;
                      };
                      const items: Array<{ letter: string; name: string; status: PhotoAggStatus; matches: number; units: PhotoMatchedUnit[]; review: number; reviewUnits: PhotoMatchedUnit[] }> = [
                        { letter: "A", name: "Airbnb",       status: agg?.airbnb  ?? null, matches: agg?.matchCounts.airbnb  ?? 0, units: agg?.matchedUnits.airbnb ?? [], review: agg?.reviewCounts.airbnb ?? 0, reviewUnits: agg?.reviewUnits.airbnb ?? [] },
                        { letter: "V", name: "VRBO",         status: agg?.vrbo    ?? null, matches: agg?.matchCounts.vrbo    ?? 0, units: agg?.matchedUnits.vrbo ?? [], review: agg?.reviewCounts.vrbo ?? 0, reviewUnits: agg?.reviewUnits.vrbo ?? [] },
                        { letter: "B", name: "Booking.com",  status: agg?.booking ?? null, matches: agg?.matchCounts.booking ?? 0, units: agg?.matchedUnits.booking ?? [], review: agg?.reviewCounts.booking ?? 0, reviewUnits: agg?.reviewUnits.booking ?? [] },
                      ];
                      const matchedSummary = items
                        .filter((it) => it.status === "found")
                        .map((it) => `${it.name}: ${unitList(it.units)}`);
                      // Address-on-OTA leg (complements the photo leg): did the
                      // unit's street address surface on a real listing page?
                      const addrItems: Array<{ letter: string; name: string; status: PhotoAggStatus }> = [
                        { letter: "A", name: "Airbnb",      status: agg?.addr.airbnb  ?? null },
                        { letter: "V", name: "VRBO",        status: agg?.addr.vrbo    ?? null },
                        { letter: "B", name: "Booking.com", status: agg?.addr.booking ?? null },
                      ];
                      const hasAddrData = addrItems.some((it) => it.status != null);
                      const addrFound = addrItems.filter((it) => it.status === "found").map((it) => it.name);
                      const folders = agg?.folders ?? [];
                      const stamp = agg?.lastCheckedAt ? new Date(agg.lastCheckedAt).toLocaleDateString() : "never";
                      const errorPreview = photoCheckErrorPreview(agg?.errorMessages?.[0]);
                      return (
                        <div className="flex flex-col items-center gap-0.5" data-testid={`photo-match-${property.id}`}>
                          <div className="flex gap-1 justify-center items-center">
                            {items.map((it) => {
                              // REVIEW tier: below the 2-photo red bar but with >=1 fully-verified
                              // match — amber "!" so a single-photo repost isn't invisible. Display
                              // only: red (found) still wins, and review never raises the popup.
                              const isReview = it.status !== "found" && it.review > 0;
                              const tone = it.status === "found" ? "bad" : isReview ? "warn" : toneOf(it.status);
                              const p = PAL[tone];
                              const affected = it.status === "found" ? `; change photos for ${unitList(it.units, "detailLabel")}` : "";
                              const tip =
                                noFolders ? `${it.name}: no scannable units — backfill real unit numbers in unit-builder-data to enable scanning` :
                                it.status === "found" ? `${it.name}: ${it.matches} match${it.matches === 1 ? "" : "es"} found${affected} (last checked ${stamp})` :
                                isReview ? `${it.name}: ${it.review} photo${it.review === 1 ? "" : "s"} verified on a listing (${unitList(it.reviewUnits, "detailLabel")}) — below the 2-photo red threshold; review manually (last checked ${stamp})` :
                                it.status === "clean" ? `${it.name}: no matches (last checked ${stamp})` :
                                it.status === "unknown" ? `${it.name}: inconclusive, not a match (${stamp})${errorPreview ? ` — ${errorPreview}` : ""}` :
                                `${it.name}: not checked yet`;
                              return (
                                <span
                                  key={it.letter}
                                  title={tip}
                                  className="inline-flex items-center justify-center h-[18px] px-0.5 rounded text-[8px] font-bold leading-none"
                                  style={{ background: p.bg, color: "white", minWidth: 20 }}
                                  data-testid={`photo-match-${it.name.toLowerCase().replace(/\./g, "")}-${property.id}`}
                                >
                                  {it.letter}{p.glyph}
                                </span>
                              );
                            })}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="ml-0.5 h-[18px] w-[18px] rounded"
                              title={folders.length > 0 ? `Run a DEEP photo match scan (full gallery + address) for ${property.name}` : `Run all photo match scans; no folders resolved for ${property.name}`}
                              aria-label={folders.length > 0 ? `Run photo match scan for ${property.name}` : `Run all photo match scans`}
                              disabled={photoScanMutation.isPending}
                              onClick={() => photoScanMutation.mutate(folders.length > 0 ? { folders, label: property.name } : { label: "All scannable listings" })}
                              data-testid={`button-run-photo-match-scan-${property.id}`}
                            >
                              <RefreshCw className={`h-3 w-3 ${photoScanMutation.isPending ? "animate-spin" : ""}`} />
                            </Button>
                          </div>
                          {matchedSummary.length > 0 ? (
                            <div className="max-w-[108px] truncate text-center text-[9px] font-semibold leading-tight text-red-700" data-testid={`photo-match-units-${property.id}`}>
                              {matchedSummary.join(" · ")}
                            </div>
                          ) : null}
                          {hasAddrData ? (
                            <div className="flex gap-1 justify-center items-center" data-testid={`photo-addr-${property.id}`}>
                              <span className="text-[8px] leading-none mr-[1px]" title="Address-on-OTA check: does this unit's street address appear on a real Airbnb / VRBO / Booking listing page? (unit-number gated; our own listings excluded). Airbnb & VRBO hide exact addresses publicly, so a green dot there = 'not publicly published', not proof it isn't relisted; Booking.com is the reliable address signal.">📍</span>
                              {addrItems.map((it) => {
                                const tone = toneOf(it.status);
                                const p = PAL[tone];
                                const tip =
                                  it.status === "found" ? `${it.name}: this unit's address is listed there (last checked ${stamp})` :
                                  it.status === "clean" ? `${it.name}: address not listed (last checked ${stamp})` :
                                  it.status === "unknown" ? `${it.name}: address check inconclusive (${stamp})` :
                                  `${it.name}: address not checked yet`;
                                return (
                                  <span
                                    key={it.letter}
                                    title={tip}
                                    className="inline-flex items-center justify-center h-[15px] px-0.5 rounded text-[7px] font-bold leading-none"
                                    style={{ background: p.bg, color: "white", minWidth: 16 }}
                                    data-testid={`photo-addr-${it.name.toLowerCase().replace(/\./g, "")}-${property.id}`}
                                  >
                                    {it.letter}{p.glyph}
                                  </span>
                                );
                              })}
                            </div>
                          ) : null}
                          {addrFound.length > 0 ? (
                            <div className="max-w-[108px] truncate text-center text-[9px] font-semibold leading-tight text-red-700" data-testid={`photo-addr-found-${property.id}`}>
                              Addr on {addrFound.join(" · ")}
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="px-1 py-2 text-center whitespace-nowrap" data-testid={`cell-photo-scan-${property.id}`}>
                    {(() => {
                      // "Scanned" — when this listing's unit photos (Unit A/B)
                      // were last reverse-image-searched against Airbnb / VRBO /
                      // Booking.com to confirm the units aren't listed elsewhere.
                      // Reuses the SAME per-property aggregation as the Photos
                      // column (photoByProperty[id].lastCheckedAt = the most
                      // recent checkedAt across the property's scannable unit
                      // folders), so the date here always matches the badge it
                      // annotates. Retroactive by construction: it reads the real
                      // persisted photo_listing_checks rows the weekly scheduler
                      // writes, so existing scans from the past week show up
                      // immediately. Display-only (like the neighbouring Photos
                      // and Comm QA status columns).
                      const agg = photoByProperty.get(property.id);
                      if (!agg || !agg.hasScannableFolders) {
                        return (
                          <span
                            className="text-xs text-muted-foreground"
                            title="No scannable unit folders — add real unit numbers in unit-builder-data to enable the listing scan"
                          >
                            —
                          </span>
                        );
                      }
                      if (!agg.lastCheckedAt) {
                        return (
                          <span
                            className="text-[11px] leading-tight text-muted-foreground"
                            title="Units not yet scanned against Airbnb / VRBO / Booking.com — the weekly scan will populate this"
                          >
                            Never
                          </span>
                        );
                      }
                      const when = new Date(agg.lastCheckedAt);
                      // Flag a property whose last scan is older than the weekly
                      // cadence (7d + 1d grace) so a missed cron run is visible.
                      const stale = Date.now() - when.getTime() > 8 * 24 * 60 * 60 * 1000;
                      const datePart = when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                      const timePart = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
                      return (
                        <span
                          className={`inline-flex flex-col items-center leading-tight ${stale ? "text-amber-600" : "text-muted-foreground"}`}
                          title={`Units last scanned against Airbnb / VRBO / Booking.com on ${formatShortDateTime(agg.lastCheckedAt)}${stale ? " — older than the weekly cadence" : ""}`}
                          data-testid={`photo-scan-stamp-${property.id}`}
                        >
                          <span className="text-[11px] font-medium">{datePart}</span>
                          <span className="text-[9px]">{timePart}</span>
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="px-0.5 py-2 text-center">
                    {(() => {
                      const row = photoCommunityByProperty.get(property.id);
                      type Tone = "ok" | "bad" | "warn" | "unknown" | "running" | "na";
                      const PAL: Record<Tone, { bg: string; glyph: string }> = {
                        ok:      { bg: "#16a34a", glyph: "✓" },
                        bad:     { bg: "#dc2626", glyph: "✗" },
                        warn:    { bg: "#f59e0b", glyph: "!" },
                        unknown: { bg: "#9ca3af", glyph: "?" },
                        running: { bg: "#f59e0b", glyph: "…" },
                        na:      { bg: "#9ca3af", glyph: "–" },
                      };
                      const bedroomTone = (running: boolean): Tone => {
                        if (running) return "running";
                        if (row?.bedroomsTier === "pass") return "ok";
                        if (row?.bedroomsTier === "fail") return "bad";
                        if (row?.bedroomsTier === "warn") return "warn";
                        if (row?.bedroomsOk === true) return "ok";
                        if (row?.bedroomsOk === false) return "bad";
                        return "unknown";
                      };
                      const toneFor = (ok: boolean | null | undefined, running: boolean): Tone => {
                        if (running) return "running";
                        if (ok === true) return "ok";
                        if (ok === false) return "bad";
                        return "unknown";
                      };
                      const running = !!row?.running || bulkPhotoCommunityJob?.items.some(
                        (item) => item.propertyId === property.id && item.status === "running",
                      );
                      const stamp = row?.checkedAt ? new Date(row.checkedAt).toLocaleDateString() : "never";
                      const allPass = row?.bedroomsTier === "pass" && row?.communityFolderOk === true && row?.sameCommunityOk === true;
                      if (allPass && !running) {
                        return (
                          <div className="flex justify-center" data-testid={`photo-community-${property.id}`}>
                            <span
                              title={`All photo community checks passed (${stamp})`}
                              className="inline-flex items-center justify-center h-[18px] px-1.5 rounded text-[9px] font-bold leading-none"
                              style={{ background: "#16a34a", color: "white", minWidth: 24 }}
                            >
                              ✓
                            </span>
                          </div>
                        );
                      }
                      const items: Array<{ letter: string; name: string; tone: Tone; tip: string }> = [
                        {
                          letter: "B",
                          name: "Bedrooms",
                          tone: bedroomTone(running),
                          tip: row?.bedroomsTier === "fail"
                            ? `Bedroom photos: ${row?.bedroomsFound ?? "?"}/${row?.bedroomsExpected ?? "?"} ✗ (${stamp})`
                            : row?.bedroomsTier === "warn"
                              ? `Bedroom photos: ${row?.bedroomsFound}/${row?.bedroomsExpected} ⚠ review unit breakdown (${stamp})`
                              : row?.bedroomsTier === "pass"
                                ? `Bedroom photos: ${row?.bedroomsFound}/${row?.bedroomsExpected} ✓ (${stamp})`
                                : running ? "Bedroom check running…" : `Bedroom photos: not checked (${stamp})`,
                        },
                        {
                          letter: "C",
                          name: "Community folder",
                          tone: toneFor(row?.communityFolderOk, running),
                          tip: row?.communityFolderOk === false
                            ? `Community folder does not match expected resort ✗${row?.communityPhotosChecked != null && row?.communityPhotosTotal != null ? ` (${row.communityPhotosChecked}/${row.communityPhotosTotal} audited)` : ""} (${stamp})`
                            : row?.communityFolderOk === true
                              ? `Community folder matches expected resort ✓ — ${row?.communityPhotosChecked ?? "?"}/${row?.communityPhotosTotal ?? "?"} photos audited${row?.communityAuditComplete === false ? " (partial — folder exceeds cap)" : ""} (${stamp})`
                              : running ? "Community folder check running…" : `Community folder: not checked (${stamp})`,
                        },
                        {
                          letter: "M",
                          name: "Same community",
                          tone: toneFor(row?.sameCommunityOk, running),
                          tip: row?.sameCommunityOk === false
                            ? `Community folder and unit photos are not all the same community ✗ (${stamp})`
                            : row?.sameCommunityOk === true
                              ? `All photo folders match the same community ✓ (${stamp})`
                              : running ? "Same-community check running…" : `Same community: not checked (${stamp})`,
                        },
                      ];
                      const summary = row ? photoCommunityStatusLabel(row) : null;
                      return (
                        <div className="flex flex-col items-center gap-0.5" data-testid={`photo-community-${property.id}`}>
                          <div className="flex gap-[1px] justify-center items-center">
                            {items.map((it) => {
                              const p = PAL[it.tone];
                              return (
                                <span
                                  key={it.letter}
                                  title={it.tip}
                                  className="inline-flex items-center justify-center h-[18px] px-0.5 rounded text-[8px] font-bold leading-none"
                                  style={{ background: p.bg, color: "white", minWidth: 20 }}
                                  data-testid={`photo-community-${it.letter.toLowerCase()}-${property.id}`}
                                >
                                  {it.letter}{p.glyph}
                                </span>
                              );
                            })}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="ml-0.5 h-[18px] w-[18px] rounded"
                              title={`Run photo community check for ${property.name}`}
                              aria-label={`Run photo community check for ${property.name}`}
                              disabled={bulkPhotoCommunityStarting || running}
                              onClick={() => void startBulkPhotoCommunityCheck([property.id])}
                              data-testid={`button-run-photo-community-check-${property.id}`}
                            >
                              <RefreshCw className={`h-3 w-3 ${running ? "animate-spin" : ""}`} />
                            </Button>
                          </div>
                          {row?.communityPhotosChecked != null && row?.communityPhotosTotal != null && row.communityPhotosTotal > 0 ? (
                            <div
                              className={`max-w-[100px] truncate text-center text-[9px] font-semibold leading-tight ${row.communityAuditComplete === false ? "text-amber-700" : "text-muted-foreground"}`}
                              title={`Community folder: ${row.communityPhotosChecked}/${row.communityPhotosTotal} photos audited`}
                              data-testid={`photo-community-c-coverage-${property.id}`}
                            >
                              C {row.communityPhotosChecked}/{row.communityPhotosTotal}
                            </div>
                          ) : null}
                          {row?.error ? (
                            <div className="max-w-[100px] truncate text-center text-[9px] font-semibold leading-tight text-red-700">
                              {row.error}
                            </div>
                          ) : summary && row?.overall === "fail" ? (
                            <div className="max-w-[100px] truncate text-center text-[9px] font-semibold leading-tight text-red-700" title={summary}>
                              {summary}
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-center px-1 py-2">
                    {(() => {
                      // Unit Audit Sweep badge — derived by the SHARED
                      // unitAuditBadge so the cell and the dialog can't drift.
                      // Clicking always opens the dialog (receipt or live run;
                      // never-audited opens with the "Run audit sweep" button).
                      const auditReport = unitAuditStatus?.reports?.[String(property.id)] ?? null;
                      const auditActive = unitAuditStatus?.active?.[String(property.id)] ?? null;
                      const badge = unitAuditBadge(
                        auditReport,
                        auditActive ? { status: auditActive.status, currentStage: auditActive.currentStage } : null,
                      );
                      const tone = badge.kind === "pass"
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : badge.kind === "attention"
                          ? "border-amber-300 bg-amber-50 text-amber-800"
                          : badge.kind === "failed"
                            ? "border-red-300 bg-red-50 text-red-700"
                            : badge.kind === "running"
                              ? "border-sky-300 bg-sky-50 text-sky-700"
                              : badge.kind === "error"
                                ? "border-slate-300 bg-slate-50 text-slate-600"
                                : "border-transparent text-muted-foreground";
                      return (
                        <button
                          type="button"
                          className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}
                          title={badge.title}
                          onClick={() => setUnitAuditDialog({ propertyId: property.id, propertyName: property.name })}
                          data-testid={`button-unit-audit-${property.id}`}
                        >
                          {badge.kind === "running" && (
                            <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-sky-200 border-t-sky-600" aria-hidden="true" />
                          )}
                          <span className="truncate">{badge.label}</span>
                        </button>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="max-w-[190px] px-1 py-2">
                    <div className="min-w-0">
                      <span className="font-medium text-sm leading-tight block truncate" data-testid={`text-name-${property.id}`} id={`text-name-${property.id}`} title={property.name}>
                        {property.name}
                      </span>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{property.unitDetails}</p>
                    </div>
                  </TableCell>
                  <TableCell className="pl-1 pr-2 py-2">
                    <Badge
                      variant={communityVariant(property.pricingArea)}
                    className="no-default-hover-elevate no-default-active-elevate inline-flex max-w-[240px] justify-start truncate text-xs"
                      data-testid={`badge-community-${property.id}`}
                      title={property.community}
                    >
                      {compactCommunityName(property.community)}
                    </Badge>
                  </TableCell>
                  <TableCell className="pl-1 pr-0.5 py-2">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className={
                              minStay.tone === "warn" ? "max-w-full whitespace-nowrap bg-amber-50 border-amber-200 text-amber-800 cursor-help"
                              : minStay.tone === "ok" ? "max-w-full whitespace-nowrap bg-emerald-50 border-emerald-200 text-emerald-800 cursor-help"
                              : "max-w-full whitespace-nowrap bg-blue-50 border-blue-200 text-blue-800 cursor-help"
                            }
                            data-testid={`badge-minimum-stay-${property.id}`}
                          >
                            <CalendarSearch className="h-3 w-3 mr-1" />
                            {minStay.label}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
                          <p>{minStay.details}</p>
                          {property.minimumStaySourceUrl && (
                            <p className="mt-1 text-muted-foreground break-all">{property.minimumStaySourceUrl}</p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                  <TableCell className="px-0.5 py-2 text-right text-sm tabular-nums" data-testid={`text-base-rate-${property.id}`}>
                    ${(baseRates.get(property.id) ?? 0).toLocaleString()}
                  </TableCell>
                  <TableCell className="px-0.5 py-2">
                    <span className="block truncate text-sm text-muted-foreground" title={property.island}>{property.island}</span>
                  </TableCell>
                  <TableCell className="px-1 py-2 text-center">
                    <span className="font-medium" data-testid={`text-bedrooms-${property.id}`}>
                      {property.bedrooms}
                    </span>
                  </TableCell>
                  <TableCell className="px-1 py-2 text-center">
                    <span className="font-medium" data-testid={`text-guests-${property.id}`}>
                      {property.guests}
                    </span>
                  </TableCell>
                  <TableCell className="px-1 py-2 text-center" data-testid={`cell-unit-count-${property.id}`}>
                    <Badge
                      variant="outline"
                      className="px-1.5 text-xs font-semibold"
                      data-testid={`badge-unit-count-${property.id}`}
                      title={unitCountDisplay.title}
                    >
                      {unitCountDisplay.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-1 py-2 text-center whitespace-nowrap" data-testid={`cell-date-added-${property.id}`}>
                    <span
                      className="text-xs text-muted-foreground"
                      title={property.createdAt ? `Added ${formatShortDateTime(property.createdAt)}` : "No recorded add-date (predates per-row tracking)"}
                    >
                      {formatDateAdded(property.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell className="px-1 py-2 text-right whitespace-nowrap" data-testid={`cell-total-revenue-${property.id}`}>
                    {(() => {
                      const rev = propertyRevenueData?.[property.id];
                      if (!rev || !(rev.revenue > 0)) {
                        return (
                          <span
                            className="text-xs text-muted-foreground"
                            title="No revenue attributed in the last 365 days (no connected Guesty listing, or no bookings made in the window)."
                          >
                            —
                          </span>
                        );
                      }
                      const stays = `${rev.bookings} booking${rev.bookings === 1 ? "" : "s"} made in the last 365 days`;
                      const updated = rev.computedAt ? ` · updated ${formatShortDate(rev.computedAt)}` : "";
                      return (
                        <span
                          className="text-xs font-semibold tabular-nums"
                          title={`${formatCurrency(rev.revenue)} from ${stays}${updated}`}
                        >
                          {formatCurrency(rev.revenue)}
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="px-1 py-2 text-center whitespace-nowrap" data-testid={`cell-last-price-scan-${property.id}`}>
                    {(() => {
                      // "Last Price Scan" — when this listing's market-rate
                      // pricing table was last refreshed AND pushed to Guesty
                      // (scanner_schedule.lastGuestyRatePushAt). Populated by the
                      // weekly market-rate cron and by any manual "Update Market
                      // Rates" push. status "seed" = the one-time retroactive
                      // backfill (rendered distinctly so it's never mistaken for a
                      // real push); "error" = the last push failed. Keyed by
                      // property.id (= the positive core property id the scanner
                      // schedule tracks), so drafts/unmapped listings show "—".
                      const scan = priceScanData?.[property.id];
                      if (!scan || !scan.pushedAt) {
                        return (
                          <span
                            className="text-xs text-muted-foreground"
                            title="Market-rate pricing has not been pushed to Guesty for this listing yet — the weekly scan (or 'Update Market Rates') will populate this."
                          >
                            —
                          </span>
                        );
                      }
                      const when = new Date(scan.pushedAt);
                      const isSeed = scan.status === "seed";
                      const isError = scan.status === "error";
                      // Flag a real push older than the weekly cadence (7d + 1d
                      // grace) so a missed cron run is visible. Seeds aren't real
                      // pushes, so don't staleness-flag them.
                      const stale = !isSeed && Date.now() - when.getTime() > 8 * 24 * 60 * 60 * 1000;
                      const datePart = when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                      const timePart = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
                      const tone = isError
                        ? "text-red-600"
                        : isSeed
                          ? "text-muted-foreground italic"
                          : stale
                            ? "text-amber-600"
                            : "text-muted-foreground";
                      const title = isSeed
                        ? `Seeded placeholder (no live Guesty push yet) dated ${formatShortDateTime(scan.pushedAt)} — the weekly scan will replace this with a real push`
                        : `Market-rate pricing ${isError ? "push FAILED" : "pushed to Guesty"} on ${formatShortDateTime(scan.pushedAt)}${stale ? " — older than the weekly cadence" : ""}${scan.summary ? ` · ${scan.summary}` : ""}`;
                      return (
                        <span
                          className={`inline-flex flex-col items-center leading-tight ${tone}`}
                          title={title}
                          data-testid={`last-price-scan-stamp-${property.id}`}
                        >
                          <span className="text-[11px] font-medium">{isSeed ? `${datePart} ·seed` : datePart}</span>
                          <span className="text-[9px]">{isError ? "push failed" : timePart}</span>
                        </span>
                      );
                    })()}
                  </TableCell>
                </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={21} className="text-center py-8 text-muted-foreground">

                    No properties match your filters
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        </Card>

        {/* Drafts now render as rows in the main table above (DRAFT
            badge in the Actions column, deletable inline). The
            standalone "New Communities in Research" cards section
            used to live here — removed because it duplicated what's
            in the table now. */}

        <div className="mt-4 text-xs text-muted-foreground text-center">
          VacationRentalExpertz portfolio data. Prices shown are nightly rates and may vary by season.
        </div>
      </div>

      <GuestyConnectDialog
        propertyId={connectTarget?.id ?? null}
        propertyName={connectTarget?.name ?? ""}
        open={connectTarget !== null}
        onOpenChange={(open) => { if (!open) setConnectTarget(null); }}
      />

      {/* Payment-failure warning popup — auto-raised when a guest payment
          FAILED or a scheduled balance charge blew past its due date without
          collecting (14-day retroactive window; cancelled bookings excluded
          server-side — can't take a payment on a cancelled booking). Same
          visual language as the refund alert. Remediation is manual by design:
          message the guest + reprocess the charge in Guesty — we never
          auto-charge a card from the dashboard. */}
      <Dialog
        open={paymentFailureWarningOpen}
        onOpenChange={(open) => (open ? setPaymentFailureWarningOpen(true) : closePaymentFailureWarning())}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" /> Guest payment failed or not collected
            </DialogTitle>
            <DialogDescription>
              A guest payment failed, or a scheduled balance (e.g. the balance due before arrival) was not
              collected on time — from the past {paymentFailureData?.windowDays ?? 14} days. Message the guest
              and reprocess the payment in Guesty. Cancelled bookings are excluded.
            </DialogDescription>
          </DialogHeader>
          {paymentFailureWarnings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No failed or uncollected guest payments in the past {paymentFailureData?.windowDays ?? 14} days.
            </p>
          ) : (
            <div className="max-h-96 space-y-1.5 overflow-y-auto">
              {paymentFailureWarnings.map((w) => (
                <div
                  key={w.reservationId}
                  className="rounded border border-red-200 bg-background p-2 dark:border-red-900"
                  data-testid={`row-payment-failure-${w.reservationId}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 text-xs">
                      <span className="font-medium">{w.guestName || "Guest"}</span>
                      <span className="text-muted-foreground">
                        {" "}· {w.listingNickname || "—"}
                        {w.checkIn ? ` · ${formatShortDate(w.checkIn)}${w.checkOut ? ` – ${formatShortDate(w.checkOut)}` : ""}` : ""}
                        {w.channel ? ` · ${w.channel}` : ""}
                        {w.confirmationCode ? ` · ${w.confirmationCode}` : ""}
                      </span>
                      {w.issues.map((issue, idx) => (
                        <span
                          key={`${issue.kind}-${idx}`}
                          className={`block font-medium ${issue.kind === "failed" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}
                          data-testid={`text-payment-issue-${w.reservationId}-${idx}`}
                        >
                          {issue.kind === "failed" ? "✕" : "⚠"} {PAYMENT_ISSUE_KIND_LABELS[issue.kind]} · {formatCurrency(issue.amount)}
                          {issue.dateIso ? ` · ${issue.kind === "overdue" ? "was due" : "failed"} ${formatShortDate(issue.dateIso)}` : ""}
                        </span>
                      ))}
                      {typeof w.totalPaid === "number" && typeof w.totalPrice === "number" && w.totalPrice > 0 ? (
                        <span className="block text-muted-foreground">
                          Paid {formatCurrency(w.totalPaid)} of {formatCurrency(w.totalPrice)}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => window.open(`https://app.guesty.com/reservations/${w.reservationId}`, "_blank")}
                        data-testid={`button-reprocess-payment-${w.reservationId}`}
                      >
                        Reprocess in Guesty
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(`/inbox?reservationId=${encodeURIComponent(w.reservationId)}`, "_blank")}
                        data-testid={`button-message-guest-payment-${w.reservationId}`}
                      >
                        Message guest
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={closePaymentFailureWarning} data-testid="button-dismiss-payment-failure-warning">
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Missing buy-in warning popup — auto-raised when a reservation checks
          in within the next 15 days (in-house stays included) and the units
          required to host it have NOT all been purchased. Same visual language
          as the payment-failure alert. Remediation is manual by design: the
          buttons jump to the Bookings page where the find-buy-in / auto-fill
          flows live — we never auto-purchase a unit from a popup. */}
      <Dialog
        open={buyInCoverageWarningOpen}
        onOpenChange={(open) => (open ? setBuyInCoverageWarningOpen(true) : closeBuyInCoverageWarning())}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" /> Units not bought in for upcoming stays
            </DialogTitle>
            <DialogDescription>
              These bookings check in within the next {buyInCoverageData?.windowDays ?? 15} days but the unit
              {buyInCoverageWarnings.length === 1 && buyInCoverageWarnings[0]?.missingUnits.length === 1 ? " has" : "s have"} not
              been bought in yet. A unit counts as bought in only once its alias inbox has received a booking
              email — attaching a unit is not enough. Book the missing units (or confirm the email arrived) on the
              Bookings page. Rows marked "requirements unknown" have a listing with no bedroom count at all, so
              coverage can&apos;t even be tracked — fix the listing first. Cancelled bookings are excluded.
            </DialogDescription>
          </DialogHeader>
          {buyInCoverageWarnings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every booking checking in within the next {buyInCoverageData?.windowDays ?? 15} days has all its units purchased.
            </p>
          ) : (
            <div className="max-h-96 space-y-1.5 overflow-y-auto">
              {buyInCoverageWarnings.map((w) => (
                <div
                  key={w.reservationId}
                  className="rounded border border-red-200 bg-background p-2 dark:border-red-900"
                  data-testid={`row-buyin-coverage-${w.reservationId}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 text-xs">
                      <span className="font-medium">{w.guestName || "Guest"}</span>
                      <span className="text-muted-foreground">
                        {" "}· {w.listingNickname || w.propertyName || "—"}
                        {w.checkIn ? ` · ${formatShortDate(w.checkIn)}${w.checkOut ? ` – ${formatShortDate(w.checkOut)}` : ""}` : ""}
                        {w.channel ? ` · ${w.channel}` : ""}
                        {w.confirmationCode ? ` · ${w.confirmationCode}` : ""}
                      </span>
                      <span
                        className="block font-medium text-red-600 dark:text-red-400"
                        data-testid={`text-buyin-coverage-issue-${w.reservationId}`}
                      >
                        {w.kind === "unknown-requirements"
                          ? "⚠ Unit requirements UNKNOWN — the listing has no bedroom count, so the system can't tell which units to buy. Set the bedroom count on the Guesty listing (or map it to a property) to restore coverage."
                          : <>
                              ✕ {w.missingUnits.length} of {w.slotsTotal} unit{w.slotsTotal === 1 ? "" : "s"} NOT bought in
                              {" "}({w.missingUnits
                                .map((u) => `${u.unitLabel} — ${u.reason === "no-email" ? "attached, no booking email yet" : "not attached"}`)
                                .join("; ")})
                            </>}
                        {" "}·{" "}
                        {w.daysUntilCheckIn < 0
                          ? "guest is ALREADY checked in"
                          : w.daysUntilCheckIn === 0
                            ? "checks in TODAY"
                            : `checks in in ${w.daysUntilCheckIn} day${w.daysUntilCheckIn === 1 ? "" : "s"}`}
                      </span>
                      {w.slotsFilled > 0 ? (
                        <span className="block text-muted-foreground">
                          {w.slotsFilled} of {w.slotsTotal} units already bought in (booking email received)
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {w.kind === "unknown-requirements" && w.listingId && !w.listingId.startsWith("manual:") ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => window.open(`https://app.guesty.com/properties/${w.listingId}`, "_blank")}
                          data-testid={`button-fix-listing-${w.reservationId}`}
                        >
                          Fix listing in Guesty
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => window.open("/bookings", "_blank")}
                          data-testid={`button-find-units-${w.reservationId}`}
                        >
                          Find &amp; attach units
                        </Button>
                      )}
                      {!w.reservationId.startsWith("manual:") ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => window.open(`https://app.guesty.com/reservations/${w.reservationId}`, "_blank")}
                          data-testid={`button-open-guesty-buyin-${w.reservationId}`}
                        >
                          Open in Guesty
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={closeBuyInCoverageWarning} data-testid="button-dismiss-buyin-coverage-warning">
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Arrival-details coverage popup — auto-raised when a reservation checks
          in within 14 days and its Guesty thread has NO actual arrival-details
          message. The automated booking confirmation PROMISES those details
          ~14 days out, so this is the watchdog behind that promise. Sending
          stays manual by design (codes must be verified first) — the button
          jumps to the Bookings page where the Message AD dialog lives. */}
      <Dialog
        open={arrivalDetailsWarningOpen}
        onOpenChange={(open) => (open ? setArrivalDetailsWarningOpen(true) : closeArrivalDetailsWarning())}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" /> Arrival details not sent yet
            </DialogTitle>
            <DialogDescription>
              These bookings check in within the next {arrivalCoverageData?.windowDays ?? 14} days and their
              conversation shows no arrival-details message (door codes, unit assignments). The booking
              confirmation promised details about 14 days before check-in — send them from the Bookings page
              (Message AD). Manual bookings are not tracked here.
            </DialogDescription>
          </DialogHeader>
          {arrivalDetailsWarnings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every booking checking in within the next {arrivalCoverageData?.windowDays ?? 14} days has arrival details on its thread.
            </p>
          ) : (
            <div className="max-h-96 space-y-1.5 overflow-y-auto">
              {arrivalDetailsWarnings.map((w) => (
                <div
                  key={w.reservationId}
                  className="rounded border border-amber-200 bg-background p-2 dark:border-amber-900"
                  data-testid={`row-arrival-details-${w.reservationId}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 text-xs">
                      <span className="font-medium">{w.guestName || "Guest"}</span>
                      <span className="text-muted-foreground">
                        {" "}· {w.listingNickname || "—"}
                        {w.checkIn ? ` · ${formatShortDate(w.checkIn)}` : ""}
                        {w.channel ? ` · ${w.channel}` : ""}
                        {w.confirmationCode ? ` · ${w.confirmationCode}` : ""}
                      </span>
                      <span
                        className="block font-medium text-amber-700 dark:text-amber-400"
                        data-testid={`text-arrival-details-issue-${w.reservationId}`}
                      >
                        {w.scanUnavailable ? "? Could not check the thread — verify manually" : "✕ Arrival details NOT sent"}
                        {" "}·{" "}
                        {w.daysUntilCheckIn === 0
                          ? "checks in TODAY"
                          : `checks in in ${w.daysUntilCheckIn} day${w.daysUntilCheckIn === 1 ? "" : "s"}`}
                      </span>
                      {w.unitsRequired > 0 && w.unitsAttached < w.unitsRequired ? (
                        <span className="block text-muted-foreground">
                          {w.unitsAttached} of {w.unitsRequired} units attached — attach units first, then send details
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Button
                        size="sm"
                        onClick={() => window.open("/bookings", "_blank")}
                        data-testid={`button-send-arrival-details-${w.reservationId}`}
                      >
                        Send arrival details
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(`https://app.guesty.com/reservations/${w.reservationId}`, "_blank")}
                        data-testid={`button-open-guesty-arrival-${w.reservationId}`}
                      >
                        Open in Guesty
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={closeArrivalDetailsWarning} data-testid="button-dismiss-arrival-details-warning">
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Misrouted booking-confirmation popup — the automated day-of-booking
          greeting was posted but filed OFF the guest's OTA channel (misroute),
          and the scheduler never retries one (AGENTS.md #51). Per-row Resend
          runs the manual force-send: rebuilds the message with current facts
          and posts through the delivery-verified path; a row already confirmed
          delivered is refused server-side (409) so it can't duplicate. */}
      <Dialog
        open={confirmationIssuesOpen}
        onOpenChange={(open) => (open ? setConfirmationIssuesOpen(true) : closeConfirmationIssues())}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" /> Booking confirmations that did not reach the guest
            </DialogTitle>
            <DialogDescription>
              These automated welcome messages were posted but landed off the guest's booking channel, so the
              guest never saw them. Resend posts a fresh copy through the delivery-verified path.
            </DialogDescription>
          </DialogHeader>
          {confirmationIssues.length === 0 ? (
            <p className="text-sm text-muted-foreground">No misrouted booking confirmations in the last 14 days.</p>
          ) : (
            <div className="max-h-96 space-y-1.5 overflow-y-auto">
              {confirmationIssues.map((issue) => (
                <div
                  key={issue.reservationId}
                  className="rounded border border-red-200 bg-background p-2 dark:border-red-900"
                  data-testid={`row-confirmation-issue-${issue.reservationId}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 text-xs">
                      <span className="font-medium">{issue.guestName || "Guest"}</span>
                      <span className="text-muted-foreground">
                        {" "}· {issue.listingNickname || "—"}
                        {issue.channel ? ` · ${issue.channel}` : ""}
                        {issue.sentAt ? ` · ${formatShortDate(issue.sentAt.slice(0, 10))}` : ""}
                      </span>
                      <span className="block font-medium text-red-600 dark:text-red-400">
                        ✕ Posted off the guest's channel — never delivered
                      </span>
                      {issue.errorMessage ? (
                        <span className="block text-muted-foreground">{issue.errorMessage}</span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={!!confirmationResendPending[issue.reservationId]}
                        onClick={() => resendBookingConfirmationFor(issue.reservationId)}
                        data-testid={`button-resend-confirmation-${issue.reservationId}`}
                      >
                        {confirmationResendPending[issue.reservationId] ? "Resending…" : "Resend to guest"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(`https://app.guesty.com/reservations/${issue.reservationId}`, "_blank")}
                        data-testid={`button-open-guesty-confirmation-${issue.reservationId}`}
                      >
                        Open in Guesty
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={closeConfirmationIssues} data-testid="button-dismiss-confirmation-issues">
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Duplicate-photos warning popup — auto-raised when a unit's photos are
          FOUND on Airbnb/VRBO/Booking (same visual language as the refund
          alert). Action per unit: one-click "Replace photos (Unit X)" — the
          server job finds, commits, AND verifies (deep rescan + Claude-vision
          community check) on its own, so there is deliberately NO separate
          "Confirm photos replaced" step (operator ask 2026-07-05: one click
          and done). The only extra button is "Rescan again", shown when a
          prior rescan came back still-found/inconclusive. NOTE FOR CODEX:
          this does NOT reintroduce the PR #318 dashboard "Replace & push"
          banner — no master-sync push happens here. */}
      {/* Address-on-OTA alert popup (Phase 3). SEPARATE from the duplicate-
          photos popup on purpose: a stolen ADDRESS means the physical unit was
          re-listed by someone else — a relister can swap the photos but not the
          address — so the remedy is an OTA takedown/report, NOT replacing our
          photos. This popup therefore surfaces the offending listings to report
          and has no Replace-photos action. */}
      <Dialog
        open={addressAlertWarningOpen}
        onOpenChange={(open) => (open ? setAddressAlertWarningOpen(true) : closeAddressAlertWarning())}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-orange-700 dark:text-orange-300">
              <AlertTriangle className="h-4 w-4" /> A unit's address appears on another listing
            </DialogTitle>
            <DialogDescription>
              The scanner found a unit's street address on an Airbnb / VRBO / Booking.com listing that isn't ours
              (the listing was unit-number matched; our own listings are excluded). A relister can swap the photos
              but not the physical address, so this is a strong signal the unit was re-listed by someone else. The
              fix is an OTA <span className="font-medium">takedown / report</span>, not replacing photos — open each
              listing below, confirm it's your unit, and report it to the platform.
            </DialogDescription>
          </DialogHeader>
          {addressAlertUnits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No units currently show their address on another Airbnb, VRBO, or Booking.com listing.
            </p>
          ) : (
            <div className="max-h-96 space-y-1.5 overflow-y-auto">
              {addressAlertUnits.map((u) => {
                const { links, more } = collectAddressAlertLinks(u.matches);
                return (
                  <div
                    key={u.folder}
                    className="rounded border border-orange-200 bg-background p-2 text-xs dark:border-orange-900"
                    data-testid={`row-address-alert-${u.folder}`}
                  >
                    <div>
                      <span className="font-medium">{u.propertyName}</span>
                      <span className="text-muted-foreground"> · {u.unitLabel}</span>
                      <span className="block text-orange-700 dark:text-orange-300">
                        Address found on {formatAddressAlertPlatforms(u.platforms)}
                      </span>
                    </div>
                    {links.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {links.map((l) => (
                          <a
                            key={l.url}
                            href={l.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-primary hover:underline"
                            title={l.snippet || l.url}
                          >
                            {ADDRESS_ALERT_PLATFORM_LABELS[l.platform]}: {l.title} ↗
                          </a>
                        ))}
                        {more > 0 && <span className="text-muted-foreground">+{more} more</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={closeAddressAlertWarning}
              data-testid="button-dismiss-address-alert"
            >
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={duplicatePhotoWarningOpen}
        onOpenChange={(open) => (open ? setDuplicatePhotoWarningOpen(true) : closeDuplicatePhotoWarning())}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" /> Duplicate photos found on other listings
            </DialogTitle>
            <DialogDescription>
              These units' photos were found on an Airbnb / VRBO / Booking.com listing that isn't ours.
              <span className="font-medium"> Replace photos (Unit X)</span> is one click and done: it finds
              another unit in the same community with the same bedroom count (real-estate sources only;
              Claude vision verifies the interiors and that the unit belongs to the community), commits its
              photos, then automatically deep-rescans to verify the new photos are no longer on Airbnb,
              VRBO, or Booking.com.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const rows = duplicatePhotoUnits.map((u) => ({ ...u, rescan: photoReplaceRescans[u.folder] }));
            // Units whose verification rescan came back clean drop out of the
            // duplicate list — keep them visible with their green confirmation.
            for (const [folder, rescan] of Object.entries(photoReplaceRescans)) {
              if (rows.some((r) => r.folder === folder)) continue;
              rows.push({
                propertyId: 0,
                propertyName: rescan.propertyName,
                unitLabel: rescan.unitLabel,
                folder,
                platforms: rescan.platforms,
                matchCount: 0,
                checkedAt: photoCheckByFolder.get(folder)?.checkedAt ?? null,
                rescan,
              });
            }
            if (rows.length === 0) {
              return (
                <p className="text-sm text-muted-foreground">
                  No units currently show duplicate photos on Airbnb, VRBO, or Booking.com.
                </p>
              );
            }
            return (
              <div className="max-h-96 space-y-1.5 overflow-y-auto">
                {rows.map((r) => {
                  const checkRow = photoCheckByFolder.get(r.folder);
                  const verdict = r.rescan
                    ? photoReplaceRescanVerdict({
                        rescanStartedAtMs: r.rescan.startedAt,
                        checkedAt: checkRow?.checkedAt,
                        statuses: {
                          airbnb: checkRow?.airbnbStatus,
                          vrbo: checkRow?.vrboStatus,
                          booking: checkRow?.bookingStatus,
                        },
                      })
                    : null;
                  const showRowActions = !verdict || verdict.state === "still_found" || verdict.state === "inconclusive";
                  return (
                    <div
                      key={r.folder}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-200 bg-background p-2 dark:border-red-900"
                      data-testid={`row-duplicate-photos-${r.folder}`}
                    >
                      <div className="min-w-0 text-xs">
                        <span className="font-medium">{r.propertyName}</span>
                        <span className="text-muted-foreground"> · {r.unitLabel}</span>
                        {!verdict || verdict.state === "still_found" ? (
                          <span className="block text-red-700 dark:text-red-300">
                            Photos found on {formatDuplicatePhotoPlatforms(verdict?.state === "still_found" ? verdict.platforms : r.platforms)}
                            {!verdict && r.matchCount > 0 ? ` · ${r.matchCount} match${r.matchCount === 1 ? "" : "es"}` : ""}
                            {verdict?.state === "still_found" ? " — STILL found after the rescan. Replace them again." : ""}
                          </span>
                        ) : null}
                        {verdict?.state === "pending" ? (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Rescanning — verifying the replaced photos are off Airbnb, VRBO, and Booking.com…
                          </span>
                        ) : null}
                        {verdict?.state === "clean" ? (
                          <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Confirmed — the replaced photos are no longer found on Airbnb, VRBO, or Booking.com.
                          </span>
                        ) : null}
                        {verdict?.state === "inconclusive" ? (
                          <span className="block text-amber-700 dark:text-amber-400">
                            Rescan inconclusive on {formatDuplicatePhotoPlatforms(verdict.platforms)} — run it again.
                          </span>
                        ) : null}
                        {(() => {
                          // Links to the actual OTA listings hosting the duplicated
                          // photos, ATTRIBUTED PER UNIT: when one folder serves two
                          // units, each offending listing is grouped under the unit
                          // whose configured gallery contains the matched photo(s),
                          // with thumbnails of OUR matched photos under every link.
                          // Units sharing one identical gallery (mauna-kai-t3) get
                          // an honest "shared gallery" note instead of fake
                          // attribution. The scanner already suppressed our own
                          // Guesty-authorized listing URLs, so every link here is a
                          // listing that is NOT ours. Hidden once the verify rescan
                          // confirms clean (the stale links are no longer evidence).
                          if (verdict?.state === "clean") return null;
                          const groups = groupDuplicateListingLinksByUnit(
                            {
                              airbnb: checkRow?.airbnbMatches,
                              vrbo: checkRow?.vrboMatches,
                              booking: checkRow?.bookingMatches,
                            },
                            duplicateLinkOwnersForRow(r.propertyId, r.folder),
                          );
                          if (groups.length === 0) return null;
                          const thumbSrc = (url: string) => {
                            try {
                              return new URL(url).pathname || url;
                            } catch {
                              return url;
                            }
                          };
                          return (
                            <span className="mt-1 block space-y-1.5">
                              {groups.map((g, gi) => {
                                const groupPhotos = distinctMatchedPhotoUrls(g.links);
                                const groupPhotoNames = groupPhotos
                                  .map((p) => photoFilenameFromMatchUrl(p))
                                  .filter((f): f is string => !!f);
                                const groupTitle = g.kind === "unit" ? g.label : r.unitLabel;
                                return (
                                  <span key={g.label ?? g.kind ?? gi} className="block space-y-0.5">
                                    {g.kind === "unit" ? (
                                      <span className="block font-semibold text-red-700 dark:text-red-300">
                                        {g.label} — photos found on other listings:
                                      </span>
                                    ) : null}
                                    {g.kind === "unassigned" ? (
                                      <span className="block font-medium text-muted-foreground">
                                        Matched photos not in either unit's configured gallery:
                                      </span>
                                    ) : null}
                                    {g.sharedGallery ? (
                                      <span className="block text-muted-foreground">
                                        One shared photo gallery serves {r.unitLabel} — each matched photo below is used by BOTH units.
                                      </span>
                                    ) : null}
                                    {groupPhotos.length > 0 ? (
                                      // At-a-glance "is this a real match?" rollup: exactly
                                      // WHICH of our photos matched, as thumbnails + names.
                                      <span className="block rounded border border-red-200 bg-red-50/50 p-1.5 dark:border-red-900 dark:bg-red-950/20">
                                        <span className="block font-medium text-red-700 dark:text-red-300">
                                          {groupTitle} matched {groupPhotos.length} of your photo{groupPhotos.length === 1 ? "" : "s"}
                                          {groupPhotoNames.length > 0 ? `: ${groupPhotoNames.slice(0, 5).join(", ")}${groupPhotoNames.length > 5 ? ", …" : ""}` : ""}
                                        </span>
                                        <span className="mt-1 flex flex-wrap items-center gap-1">
                                          {groupPhotos.slice(0, 8).map((p) => (
                                            <img
                                              key={p}
                                              src={thumbSrc(p)}
                                              alt={photoFilenameFromMatchUrl(p) ?? "matched photo"}
                                              title={photoFilenameFromMatchUrl(p) ?? p}
                                              loading="lazy"
                                              className="h-12 w-12 rounded border border-red-200 object-cover dark:border-red-900"
                                            />
                                          ))}
                                          {groupPhotos.length > 8 ? (
                                            <span className="text-muted-foreground">+{groupPhotos.length - 8} more</span>
                                          ) : null}
                                        </span>
                                      </span>
                                    ) : null}
                                    {groupLinksByPlatform(g.links).map((pg) => (
                                      <span key={pg.platform} className="block space-y-0.5">
                                        <span className="block font-medium text-red-700 dark:text-red-300">
                                          {DUPLICATE_PHOTO_PLATFORM_LABELS[pg.platform]} ({pg.links.length} listing{pg.links.length === 1 ? "" : "s"}):
                                        </span>
                                        {pg.links.map((link) => (
                                          <span key={link.url} className="block pl-2">
                                            <a
                                              href={link.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="flex items-center gap-1 text-red-700 underline underline-offset-2 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200"
                                              title={link.url}
                                              data-testid={`link-duplicate-listing-${r.folder}-${link.platform}`}
                                            >
                                              <ExternalLink className="h-3 w-3 shrink-0" />
                                              <span className="truncate">{link.title}</span>
                                            </a>
                                            {link.matchedPhotoUrls.length > 0 ? (
                                              <span className="mt-0.5 flex flex-wrap items-center gap-1 pl-4">
                                                <span className="text-muted-foreground">Your photos found there:</span>
                                                {link.matchedPhotoUrls.slice(0, 4).map((p) => (
                                                  <img
                                                    key={p}
                                                    src={thumbSrc(p)}
                                                    alt={photoFilenameFromMatchUrl(p) ?? "matched photo"}
                                                    title={photoFilenameFromMatchUrl(p) ?? p}
                                                    loading="lazy"
                                                    className="h-9 w-9 rounded border border-red-200 object-cover dark:border-red-900"
                                                  />
                                                ))}
                                                {link.matchedPhotoUrls.length > 4 ? (
                                                  <span className="text-muted-foreground">+{link.matchedPhotoUrls.length - 4} more</span>
                                                ) : null}
                                              </span>
                                            ) : null}
                                          </span>
                                        ))}
                                      </span>
                                    ))}
                                    {g.more > 0 ? (
                                      <span className="block text-muted-foreground">+{g.more} more matched listing{g.more === 1 ? "" : "s"}</span>
                                    ) : null}
                                  </span>
                                );
                              })}
                            </span>
                          );
                        })()}
                        {(() => {
                          // Claude-vision community confirmation for a REPLACEMENT
                          // folder (post-"Replace photos"): surfaces the bulk
                          // photo-community check verdict for this property so the
                          // operator sees "the new unit is in the community" right
                          // in the popup. Property id parses out of the folder name
                          // (rescue rows carry propertyId 0).
                          const ref = replacementPhotoFolderRef(r.folder);
                          const refPid = ref && typeof ref.propertyId === "number" ? ref.propertyId : null;
                          const st = refPid && refPid > 0 ? photoCommunityByProperty.get(refPid) : undefined;
                          if (!st) return null;
                          if (st.running) {
                            return (
                              <span className="flex items-center gap-1 text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" /> Claude vision is confirming the new unit belongs to the community…
                              </span>
                            );
                          }
                          if (st.sameCommunityOk === true) {
                            return (
                              <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Claude vision confirmed the replacement unit is within the community.
                              </span>
                            );
                          }
                          if (st.sameCommunityOk === false) {
                            return (
                              <span className="block text-red-700 dark:text-red-300">
                                ✕ Claude vision could NOT confirm the replacement unit is in the community — review it in the builder (Comm QA column).
                              </span>
                            );
                          }
                          return null;
                        })()}
                        <span className="block text-muted-foreground">
                          Last scanned {checkRow?.checkedAt ? formatShortDateTime(checkRow.checkedAt) : "—"}
                        </span>
                      </div>
                      {showRowActions ? (
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          {resolveReplacePhotosUnits(r.propertyId, r.folder).map((target) => {
                            const unitLabelFull = `${target.letter}${target.unit.unitNumber ? ` (${target.unit.unitNumber})` : ""}`;
                            const alreadyQueued = (autoReplaceQueue?.jobs ?? []).some(
                              (j) => j.propertyId === r.propertyId && j.unitId === target.unit.id && isAutoReplacePhaseActive(j.phase),
                            );
                            return (
                              <span key={target.unit.id} className="flex flex-col items-end gap-0.5">
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={startAutoReplaceMutation.isPending || alreadyQueued}
                                  onClick={() => startAutoReplaceMutation.mutate({
                                    propertyId: r.propertyId,
                                    unitId: target.unit.id,
                                    unitLabel: unitLabelFull,
                                  })}
                                  data-testid={`button-replace-photos-${r.folder}-${target.unit.id}`}
                                >
                                  {alreadyQueued ? (
                                    <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Replacing {target.letter}…</>
                                  ) : (
                                    <>Replace photos ({target.letter})</>
                                  )}
                                </Button>
                                <button
                                  type="button"
                                  className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                  onClick={() => setReplacePhotosTarget({ propertyId: r.propertyId, unitId: target.unit.id })}
                                  data-testid={`button-replace-photos-manual-${r.folder}-${target.unit.id}`}
                                >
                                  pick manually
                                </button>
                              </span>
                            );
                          })}
                          {/* Rescan retry only — the one-click Replace job verifies
                              itself, so a bare row never needs a manual confirm step.
                              This appears only after a rescan came back still-found or
                              inconclusive (and covers the "stale row after a scanner
                              fix deployed" case — rescanning is non-destructive). */}
                          {verdict ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
                              disabled={confirmPhotosReplacedMutation.isPending}
                              onClick={() => confirmPhotosReplacedMutation.mutate({
                                folder: r.folder,
                                propertyName: r.propertyName,
                                unitLabel: r.unitLabel,
                                platforms: r.platforms,
                              })}
                              data-testid={`button-confirm-photos-replaced-${r.folder}`}
                            >
                              Rescan again
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <p className="text-[11px] text-muted-foreground">
            The rescan reverse-image-searches the unit's full photo gallery (same depth as the weekly scan)
            and usually finishes within a minute or two. You can close this — the Photos column keeps updating.
          </p>
        </DialogContent>
      </Dialog>
      {/* Photo-replacement activity: live auto-replace work plus a durable attempt
          history that remains after the clearable queue receipts disappear. */}
      <Dialog open={autoReplaceQueueOpen} onOpenChange={setAutoReplaceQueueOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="dialog-auto-fix-activity">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-4 w-4" /> Photo replacement activity
            </DialogTitle>
            <DialogDescription>
              See when the system tried, retried, skipped, or completed a unit-photo replacement. Active work runs
              fully server-side, and the attempt history remains after finished queue items are cleared.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2" data-testid="section-auto-fix-active">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active now</p>
            {(autoReplaceQueue?.jobs ?? []).filter((job) => isAutoReplacePhaseActive(job.phase)).length === 0 ? (
              <p className="rounded border border-dashed px-3 py-3 text-sm text-muted-foreground" data-testid="text-auto-fix-none-active">
                No photo replacement is running right now.
              </p>
            ) : (
              <div className="max-h-44 space-y-1.5 overflow-y-auto">
                {(autoReplaceQueue?.jobs ?? []).filter((job) => isAutoReplacePhaseActive(job.phase)).map((job) => {
                  return (
                    <div key={job.jobId} className="rounded border p-2 text-xs" data-testid={`row-auto-replace-${job.jobId}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 font-medium">{job.propertyName} · {job.unitLabel}</span>
                        <Badge variant="outline" className={`capitalize ${AUTO_REPLACE_PHASE_TONES[job.phase]}`}>
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          {job.phase === "retry_wait" ? "retry scheduled" : job.phase}
                        </Badge>
                      </div>
                      {job.newUnitLabel || job.newAddress ? (
                        <p className="mt-0.5 text-emerald-700 dark:text-emerald-400">
                          New unit: {job.newUnitLabel || "—"}{job.newAddress ? ` · ${job.newAddress}` : ""}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-muted-foreground">{job.message ?? "—"}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {(autoReplaceQueue?.jobs ?? []).some((job) => !isAutoReplacePhaseActive(job.phase)) ? (
            <div className="space-y-2" data-testid="section-auto-fix-recent-receipts">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent queue receipts</p>
                <span className="text-[11px] text-muted-foreground">Fallback receipts remain for up to 2 hours.</span>
              </div>
              <div className="max-h-36 space-y-1.5 overflow-y-auto">
                {(autoReplaceQueue?.jobs ?? []).filter((job) => !isAutoReplacePhaseActive(job.phase)).map((job) => (
                  <div key={job.jobId} className="rounded border p-2 text-xs" data-testid={`row-auto-replace-receipt-${job.jobId}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 font-medium">{job.propertyName} · {job.unitLabel}</span>
                      <Badge variant="outline" className={`capitalize ${AUTO_REPLACE_PHASE_TONES[job.phase]}`}>
                        {job.phase}
                      </Badge>
                    </div>
                    {job.newUnitLabel || job.newAddress ? (
                      <p className="mt-0.5 text-emerald-700 dark:text-emerald-400">
                        New unit: {job.newUnitLabel || "—"}{job.newAddress ? ` · ${job.newAddress}` : ""}
                      </p>
                    ) : null}
                    <p className={`mt-0.5 ${job.phase === "failed" ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}`}>
                      {job.phase === "failed" ? (job.error ?? "Failed") : (job.message ?? "—")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-2" data-testid="section-auto-fix-history">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attempt history</p>
            {autoFixActivityLoading ? (
              <div className="flex items-center gap-2 rounded border border-dashed px-3 py-3 text-sm text-muted-foreground" data-testid="auto-fix-history-loading">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading photo replacement history…
              </div>
            ) : autoFixActivityError ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="auto-fix-history-error">
                <span>Photo replacement history could not be loaded.</span>
                <Button type="button" size="sm" variant="outline" onClick={() => void refetchAutoFixActivity()}>
                  Try again
                </Button>
              </div>
            ) : (autoFixActivity?.events ?? []).length === 0 ? (
              <p className="rounded border border-dashed px-3 py-3 text-sm text-muted-foreground" data-testid="auto-fix-history-empty">
                No photo replacement attempts have been recorded yet.
              </p>
            ) : (
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {(autoFixActivity?.events ?? []).map((event) => {
                  const statusLabel = event.attemptNumber > 0
                    ? `Retry ${event.attemptNumber} ${AUTO_FIX_RETRY_STATUS_LABELS[event.status]}`
                    : AUTO_FIX_ACTIVITY_STATUS_LABELS[event.status];
                  const propertyLabel = event.propertyName
                    || (event.propertyId ? `Property ${event.propertyId}` : "Photo replacement");
                  const unitLabel = event.unitLabel || event.unitId;
                  return (
                    <div key={event.id} className="rounded border p-2.5 text-xs" data-testid={`row-auto-fix-activity-${event.id}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {propertyLabel}{unitLabel ? ` · ${unitLabel}` : ""}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {formatShortDateTime(event.occurredAt)} · {AUTO_FIX_ACTIVITY_ORIGIN_LABELS[event.origin]}
                          </p>
                        </div>
                        <Badge variant="outline" className={AUTO_FIX_ACTIVITY_STATUS_TONES[event.status]}>
                          {statusLabel}
                        </Badge>
                      </div>
                      <p className={`mt-1 ${event.status === "failed" ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}`}>
                        {event.message || "No details recorded."}
                      </p>
                      {event.scheduledFor ? (
                        <p className="mt-1 font-medium text-violet-700 dark:text-violet-300">
                          Scheduled for {formatShortDateTime(event.scheduledFor)}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
            <span className="max-w-md text-xs text-muted-foreground" data-testid="text-auto-fix-history-retention">
              {(autoReplaceQueue?.activeCount ?? 0) > 0
                ? "Running jobs are never cleared. "
                : ""}
              Clearing finished queue items never deletes this attempt history.
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                clearAutoReplaceQueueMutation.isPending ||
                !(autoReplaceQueue?.jobs ?? []).some((job) => !isAutoReplacePhaseActive(job.phase))
              }
              onClick={() => clearAutoReplaceQueueMutation.mutate()}
              data-testid="button-clear-auto-replace-queue-dialog"
            >
              {clearAutoReplaceQueueMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Clear queue
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Replace-photos dialog — hosts the preflight UnitReplacementFlow for the
          unit flagged in the duplicate-photos popup (the MANUAL "pick manually"
          path). The flow itself owns the whole search → candidate → commit
          lifecycle (background find-unit job, resume, POST /api/unit-swaps); we
          only assemble its props the same way builder-preflight does and react
          to the committed swap. */}
      {replacePhotosTarget && (() => {
        const builder = replaceBuilderLikeFor(replacePhotosTarget.propertyId);
        if (!builder?.communityPhotoFolder) return null;
        const unitIndex = builder.units.findIndex((u) => u.id === replacePhotosTarget.unitId);
        const targetUnit = unitIndex >= 0 ? builder.units[unitIndex] : builder.units[0];
        const letterOf = (i: number) => `Unit ${String.fromCharCode(65 + i)}`;
        const overridesByUnit = new Map((replaceUnitSwapsData?.swaps ?? []).map((s) => [s.oldUnitId, s]));
        const parsed = parsePropertyDisplayAddress(builder.address);
        const streetAddress = inferCommunityStreetAddress({
          communityName: builder.complexName,
          city: parsed.city,
          state: parsed.state,
          addressHint: parsed.street || builder.address,
        }) || parsed.street;
        const skipUrls = Array.from(new Set(
          (replaceUnitSwapsData?.swaps ?? []).map((s) => s.newSourceUrl).filter(Boolean),
        ));
        return (
          <Dialog open onOpenChange={(open) => { if (!open) setReplacePhotosTarget(null); }}>
            <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  Replace photos — {builder.propertyName} · {unitIndex >= 0 ? letterOf(unitIndex) : targetUnit.unitNumber}
                </DialogTitle>
                <DialogDescription>
                  Searches real-estate sources (never OTA galleries) for another {targetUnit.bedrooms}BR unit
                  inside {builder.complexName}. Claude vision verifies the candidate has real furnished
                  interiors, its photos are checked as NOT already on Airbnb / VRBO / Booking.com, and after
                  you commit, Claude vision re-confirms the new unit's gallery belongs to {builder.complexName}.
                </DialogDescription>
              </DialogHeader>
              <UnitReplacementFlow
                unit={{
                  id: targetUnit.id,
                  unitNumber: targetUnit.unitNumber ?? "",
                  bedrooms: targetUnit.bedrooms,
                  photoFolder: targetUnit.photoFolder,
                  positionLabel: unitIndex >= 0 ? letterOf(unitIndex) : undefined,
                  replacementLabel: overridesByUnit.get(targetUnit.id)?.newUnitLabel,
                }}
                allUnits={builder.units.map((u, i) => ({
                  id: u.id,
                  unitNumber: u.unitNumber ?? "",
                  bedrooms: u.bedrooms,
                  photoFolder: u.photoFolder,
                  positionLabel: letterOf(i),
                  replacementLabel: overridesByUnit.get(u.id)?.newUnitLabel,
                  replacementSourceUrl: overridesByUnit.get(u.id)?.newSourceUrl,
                }))}
                communityFolder={builder.communityPhotoFolder}
                communityName={builder.complexName}
                propertyAddress={builder.address}
                streetAddress={streetAddress || undefined}
                city={parsed.city || undefined}
                state={parsed.state || undefined}
                propertyId={replacePhotosTarget.propertyId}
                skipUrls={skipUrls}
                onClose={() => setReplacePhotosTarget(null)}
                onUnitReplaced={handleDuplicatePhotoUnitReplaced}
              />
            </DialogContent>
          </Dialog>
        );
      })()}
      <Dialog open={photoScanModalOpen} onOpenChange={setPhotoScanModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Search className="h-4 w-4" /> Deep photo scan
            </DialogTitle>
            <DialogDescription>
              Reverse-image-searching the full photo gallery + the street address of{" "}
              <span className="font-medium">{photoScanLabel || "the selected listings"}</span>{" "}
              against Airbnb / VRBO / Booking.com. This runs in the background — you can close this and the badges keep updating.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const rows = photoScanFolders.map((folder) => {
              const row = photoCheckByFolder.get(folder);
              const done = !!(row?.checkedAt && new Date(row.checkedAt).getTime() >= photoScanStartedAt - 1000);
              return { folder, row, done };
            });
            const total = rows.length;
            const doneCount = rows.filter((r) => r.done).length;
            const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
            const q = photoScanSearch.trim().toLowerCase();
            const visible = q ? rows.filter((r) => r.folder.toLowerCase().includes(q)) : rows;
            const statusDot = (s?: string) =>
              s === "found" ? "bg-red-500" : s === "clean" ? "bg-emerald-500" : "bg-gray-300";
            return (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span>{doneCount} of {total} folder{total === 1 ? "" : "s"} scanned</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded bg-muted">
                    <div className="h-full rounded bg-primary transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={photoScanSearch}
                    onChange={(e) => setPhotoScanSearch(e.target.value)}
                    placeholder="Search folders…"
                    className="h-8 pl-7 text-sm"
                    data-testid="input-photo-scan-search"
                  />
                </div>
                <div className="max-h-72 overflow-y-auto rounded border divide-y">
                  {visible.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                      {total === 0 ? "Queuing…" : "No folders match your search."}
                    </div>
                  ) : visible.map(({ folder, row, done }) => (
                    <div key={folder} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs" data-testid={`photo-scan-row-${folder}`}>
                      <span className="truncate font-mono" title={folder}>{folder}</span>
                      {done ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="flex items-center gap-0.5" title="Photos — Airbnb / VRBO / Booking">
                            <span className={`h-2 w-2 rounded-full ${statusDot(row?.airbnbStatus)}`} />
                            <span className={`h-2 w-2 rounded-full ${statusDot(row?.vrboStatus)}`} />
                            <span className={`h-2 w-2 rounded-full ${statusDot(row?.bookingStatus)}`} />
                          </span>
                          <span className="flex items-center gap-0.5" title="Address — Airbnb / VRBO / Booking">
                            <MapPin className="h-3 w-3 text-muted-foreground" />
                            <span className={`h-2 w-2 rounded-full ${statusDot(row?.airbnbAddressStatus)}`} />
                            <span className={`h-2 w-2 rounded-full ${statusDot(row?.vrboAddressStatus)}`} />
                            <span className={`h-2 w-2 rounded-full ${statusDot(row?.bookingAddressStatus)}`} />
                          </span>
                          {(row?.airbnbStatus === "found" || row?.vrboStatus === "found" || row?.bookingStatus === "found" ||
                            row?.airbnbAddressStatus === "found" || row?.vrboAddressStatus === "found" || row?.bookingAddressStatus === "found") ? (
                            <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          )}
                        </div>
                      ) : (
                        <span className="flex items-center gap-1 shrink-0 text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> scanning…
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> not found</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> found</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-gray-300" /> inconclusive</span>
                  <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> address</span>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
      {unitAuditDialog && (
        <UnitAuditDialog
          propertyId={unitAuditDialog.propertyId}
          propertyName={unitAuditDialog.propertyName}
          open
          onOpenChange={(o) => { if (!o) setUnitAuditDialog(null); }}
          status={unitAuditStatus}
        />
      )}
    </div>
  );
}

// ─── Bulk pricing: "what changed" old→new summary ─────────────────────────────
// After a bulk MARKET-RATE update, surface the previous vs current basis per
// property/bedroom from pricing_update_logs (GET /api/pricing/update-logs),
// filtered to the logs this run produced (propertyId in the job + createdAt
// since the run started).
type PricingLogEntry = {
  propertyId: number;
  propertyName: string;
  bedrooms: number;
  oldRate: string | null;
  newRate: string | null;
  createdAt: string;
};
function BulkPricingChangesSummary({ job }: { job: BulkPricingJob }) {
  const { data } = useQuery<{ ok: boolean; logs: PricingLogEntry[] }>({
    queryKey: ["bulk-pricing-changes", job.id, job.status],
    queryFn: async () => {
      const r = await fetch(`/api/pricing/update-logs?limit=250`, { credentials: "include" });
      if (!r.ok) throw new Error(`pricing logs ${r.status}`);
      return r.json();
    },
    refetchInterval: job.status === "running" ? 8000 : false,
    staleTime: 4000,
  });
  const propertyIds = new Set(job.items.map((i) => i.propertyId));
  const sinceMs = job.startedAt ? new Date(job.startedAt).getTime() - 60_000 : 0;
  const logs = (data?.logs ?? []).filter(
    (l) => propertyIds.has(l.propertyId) && new Date(l.createdAt).getTime() >= sinceMs,
  );
  if (logs.length === 0) return null;
  // group by property → latest row per bedroom (logs newest-first)
  const byProp = new Map<number, { name: string; rows: Map<number, PricingLogEntry> }>();
  for (const l of logs) {
    if (!byProp.has(l.propertyId)) byProp.set(l.propertyId, { name: l.propertyName, rows: new Map() });
    const g = byProp.get(l.propertyId)!;
    if (!g.rows.has(l.bedrooms)) g.rows.set(l.bedrooms, l);
  }
  const groups = Array.from(byProp.values()).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="rounded-md border" data-testid="bulk-pricing-changes">
      <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold">
        What changed — strikethrough old rate, green ↑ / red ↓ on new rate
      </div>
      <div className="max-h-64 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.name} className="border-b px-3 py-2 last:border-b-0">
            <p className="truncate text-sm font-medium">{g.name}</p>
            <div className="mt-1">
              <RateChangesList
                changes={Array.from(g.rows.entries()).sort((a, b) => a[0] - b[0]).map(([br, l]) => ({
                  bedrooms: br,
                  oldRate: l.oldRate,
                  newRate: l.newRate,
                }))}
                itemClassName="text-xs"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const { data: session, isLoading } = usePortalSession();
  if (isLoading) return null;
  if (session?.role === "agent") return <AgentPropertyPortal />;
  return <AdminDashboard />;
}
