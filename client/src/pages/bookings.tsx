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
  aliasAttachmentHref,
  filesToAliasEmailAttachments,
  formatAttachmentSize,
  parseAliasEmailAttachments,
  type AliasEmailAttachment,
} from "@/lib/emailAttachments";
import {
  ArrowLeft, Building2, Calendar, Search, Link2, Unlink, ExternalLink,
  RefreshCw, AlertCircle, CheckCircle2, TrendingUp, TrendingDown, BedDouble,
  ChevronDown, ChevronRight, Globe, ShoppingCart, Zap, Camera,
  ArrowUpDown, ArrowUp, ArrowDown, Star, Copy, FileText, XCircle,
  WalletCards, Landmark, Clock3, Loader2, Play, Square, Pause, Mail,
  MapPin, Footprints, MessageSquare, MonitorPlay, MousePointerClick, Download,
  ShieldCheck, Paperclip, X, Minimize2, Plus, Send,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BuyIn, GuestyPropertyMap, ReservationCancellationAudit } from "@shared/schema";
import { PROPERTY_UNIT_CONFIGS, type UnitConfig } from "@shared/property-units";
import { totalNightlyBuyInForMonth } from "@shared/pricing-rates";
import { buildBuyInSearchDebugLog, sanitizeForChatText } from "@shared/safe-log";
import type { GroundFloorRequirement, GroundFloorStatus } from "@shared/ground-floor";
import { haversineFeet, walkMinutesFromFeet, MAX_BUY_IN_WALK_MINUTES } from "@shared/walking-distance";
import { textMatchesResortPhrase } from "@shared/buy-in-market";
import { getUnitBuilderByPropertyId } from "@/data/unit-builder-data";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlotInfo extends UnitConfig {
  buyIn: BuyIn | null;
  adHoc?: boolean;
  sourceListingId?: string;
  community?: string | null;
}

type GuestyListingSummary = {
  _id?: string;
  id?: string;
  nickname?: string;
  title?: string;
  isListed?: boolean;
  active?: boolean;
  isActive?: boolean;
  status?: string;
  bedrooms?: number;
  bedroomsCount?: number;
  bedroomCount?: number;
  beds?: number;
  accommodates?: number;
  personCapacity?: number;
  address?: { full?: string; city?: string; state?: string; street?: string };
};

type OperationsPropertyOption = {
  value: string;
  propertyId: number | null;
  guestyListingId: string;
  name: string;
  mapped: boolean;
  buyInConfigured: boolean;
  buyInSetupLabel: string;
};

function virtualPropertyIdForGuestyListingId(listingId: string): number {
  let hash = 0;
  for (const ch of listingId) {
    hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  }
  return -(100000 + (hash % 900000));
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function inferBedroomsFromGuestyListing(listing: GuestyListingSummary | null | undefined): number | null {
  const direct = numberFromUnknown(
    listing?.bedrooms ?? listing?.bedroomsCount ?? listing?.bedroomCount ?? listing?.beds,
  );
  if (direct && direct > 0) return direct;
  const title = String(listing?.title ?? listing?.nickname ?? "").trim();
  const match = title.match(/(\d+)\s*(?:br|bed(?:room)?s?)/i);
  return match ? Number(match[1]) : null;
}

function buyInSetupLabelForOption(
  propertyId: number | null,
  listing: GuestyListingSummary | null | undefined,
  mapped: boolean,
): { configured: boolean; label: string } {
  const staticUnitCount = propertyId != null
    ? (PROPERTY_UNIT_CONFIGS[propertyId]?.units?.length ?? 0)
    : 0;
  if (staticUnitCount > 0) {
    return {
      configured: true,
      label: `${staticUnitCount} unit ${staticUnitCount === 1 ? "slot" : "slots"}`,
    };
  }

  const inferredBedrooms = inferBedroomsFromGuestyListing(listing);
  if (mapped) {
    return {
      configured: true,
      label: inferredBedrooms
        ? `${inferredBedrooms}BR auto buy-in target`
        : "auto buy-in target",
    };
  }

  return inferredBedrooms
    ? { configured: true, label: `${inferredBedrooms}BR auto buy-in target` }
    : { configured: false, label: "needs bedroom count" };
}

interface GuestyReservation {
  _id: string;
  status: string;
  listingId?: string;
  operationsListingId?: string;
  operationsPropertyId?: number;
  operationsPropertyName?: string;
  operationsMapped?: boolean;
  operationsBuyInConfigured?: boolean;
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
  cancellationPolicy?: string | null;
  cancellationPolicySummary?: string | null;
  cancellationPolicyFreeCancellationUntil?: string | null;
  cancellationPolicyPenalty?: string | null;
  cancellationPolicyDetailsAvailable?: boolean;
  cancellationPolicySource?: string | null;
  cancellationPolicyAssumed?: boolean;
  slots: SlotInfo[];
  slotsFilled: number;
  slotsTotal: number;
  fullyLinked: boolean;
  manualReservation?: {
    id: number;
    propertyId: number;
    guestName: string;
    guestEmail?: string | null;
    guestPhone?: string | null;
    totalRate?: number | string | null;
    notes?: string | null;
    status?: string | null;
  };
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

type ReservationAliasRecord = {
  id: number;
  reservationId: string;
  aliasEmail: string;
  simpleloginAliasId?: number | null;
  mailboxEmail: string;
  status?: string | null;
  expiresAt?: string | null;
};

type BuyInVendorContactRecord = {
  id: number;
  buyInId: number;
  reservationId: string;
  vendorName?: string | null;
  vendorEmail: string;
  reverseAliasEmail?: string | null;
};

type BuyInEmailRecord = {
  id: number;
  buyInId: number;
  direction: "outbound" | "inbound" | string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  attachmentsJson?: string | null;
  sentAt?: string;
  status?: string;
};

type BuyInCommunicationsResponse = {
  reservationId: string;
  alias: ReservationAliasRecord | null;
  buyIns: BuyIn[];
  contacts: BuyInVendorContactRecord[];
  emails: BuyInEmailRecord[];
};

type AutoFillSearchSummary = {
  bedrooms: number;
  scanned: number;
  priced: number;
  sourceCounts: { airbnb: number; vrbo: number; booking: number; pm: number };
  kept: number;
  targetFiltered: number;
  groundFloorOnly: boolean;
};

// Persistent "did we already message this guest about the move?" record, keyed
// by reservation. Drives the "Guest messaged ✓" badge on the bookings row.
type RelocationSentStatus = {
  token: string;
  messageSentAt: string | null;
  messageChannel: string | null;
  opened: boolean;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
};

type BuyInCancellationTier = "do_not_cancel" | "watch" | "consider_cancel" | "strong_cancel" | "cancel";

type BuyInCancellationAdvice = {
  score: number;
  tier: BuyInCancellationTier;
  confidence: "high" | "medium" | "low";
  basis: "verified_cost" | "no_inventory" | "insufficient_coverage";
  title: string;
  summary: string;
  evidence: string[];
  methodology: string[];
  projectedProfit: number | null;
  remainingBudget: number;
  proposedCost: number | null;
  providersSearched: number;
  providersClean: number;
  providersHardFailed: number;
  verifiedCount: number;
  pricedCount: number;
};


type DirectBookingProof = {
  verdict: "same_unit_direct_page" | "direct_price_available" | "direct_unavailable" | "needs_review";
  summary: string;
  sameUnit: {
    status: "passed" | "not_checked";
    method: string;
    matchedPhotoCount?: number;
    minConfidence?: number;
    maxConfidence?: number;
    requiredPhotoCount?: number;
    requiredConfidence?: number;
    matchedPhotoRoles?: string[];
    reason: string;
  };
  directPage: {
    status: "passed" | "needs_review";
    method: string;
    url?: string;
    domain?: string;
    reason: string;
  };
  availability: {
    status: "date_specific_available" | "date_specific_unavailable" | "unclear" | "not_checked";
    method: string;
    checkIn?: string;
    checkOut?: string;
    finalUrl?: string;
    reason: string;
  };
  price: {
    status: "date_specific_quote" | "airbnb_anchor_only" | "unavailable" | "unclear" | "not_checked";
    method: string;
    totalPrice?: number | null;
    nightlyPrice?: number | null;
    currency?: "USD";
    reason: string;
  };
};


type AutoFillComboOption = {
  label: string;
  bedrooms: number[];
  totalCost: number | null;
  selected: boolean;
  unavailableReason?: string;
  unavailableDetails?: string[];
  note?: string;
  picks: Array<{
    bedrooms: number;
    source?: "airbnb" | "vrbo" | "booking" | "pm";
    sourceLabel: string;
    title: string;
    totalPrice: number;
    nightlyPrice?: number;
    url: string;
    originalSourceUrl?: string;
    image?: string;
    images?: string[];
    airbnbAnchorUrl?: string | null;
    airbnbAnchorPrice?: number;
    directBookingUrl?: string;
    directBookingHost?: string;
    directBookingSource?: "airbnb_image_reverse_search";
    directBookingReason?: string;
    directProof?: DirectBookingProof;
    alternateUrls?: Array<string | null | undefined>;
    photoMatches?: Array<{ url?: string | null }>;
    identityKeys?: Array<string | null | undefined>;
    verified?: "yes" | "no" | "unclear" | "skipped";
    verifiedReason?: string;
    groundFloorStatus?: GroundFloorStatus;
    groundFloorEvidence?: string | null;
  }>;
  pools?: Array<{
    bedrooms: number;
    unavailableReason?: string;
    unavailableDetails?: string[];
    candidates: Array<{
      source: "airbnb" | "vrbo" | "booking" | "pm";
      sourceLabel: string;
      title: string;
      totalPrice: number;
      nightlyPrice: number;
      bedrooms?: number;
      url: string;
      originalSourceUrl?: string;
      image?: string;
      airbnbAnchorUrl?: string | null;
      airbnbAnchorPrice?: number;
      directBookingUrl?: string;
      directBookingHost?: string;
      directBookingSource?: "airbnb_image_reverse_search";
      directBookingReason?: string;
      directProof?: DirectBookingProof;
      alternateUrls?: Array<string | null | undefined>;
      photoMatches?: Array<{ url?: string | null }>;
      identityKeys?: Array<string | null | undefined>;
      verified?: "yes" | "no" | "unclear" | "skipped";
      verifiedReason?: string;
      groundFloorStatus?: GroundFloorStatus;
      groundFloorEvidence?: string | null;
    }>;
  }>;
};

type AutoFillAuditCandidate = {
  source: "airbnb" | "vrbo" | "booking" | "pm";
  sourceLabel: string;
  title: string;
  url: string;
  originalSourceUrl?: string;
  totalPrice: number;
  nightlyPrice: number;
  image?: string;
  verified?: "yes" | "no" | "unclear" | "skipped";
  verifiedReason?: string;
  groundFloorStatus?: GroundFloorStatus;
  groundFloorEvidence?: string | null;
};

type AutoFillSearchAudit = {
  bedrooms: number;
  generatedAt: string;
  counts: AutoFillSearchSummary;
  candidates: AutoFillAuditCandidate[];
  diagnostics?: FindBuyInDiagnostics;
};

type BuyInSearchConfirmationPayload = {
  title: string;
  description?: string;
  audits: AutoFillSearchAudit[];
};

type BulkBuyInQueueStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "cancelled";

type BulkBuyInQueueItem = {
  id: string;
  jobId: string;
  reservationId: string;
  propertyId: number;
  listingId: string | null;
  propertyName: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  queuedFor: string;
  status: BulkBuyInQueueStatus;
  message: string;
  error?: string;
  filled?: number;
  totalSlots?: number;
  startedAt?: string;
  finishedAt?: string;
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

type SidecarQueueRequest = {
  id: string;
  status: string;
  opType: string;
  label: string;
  summary?: string;
  detail?: string;
  providerLabel?: string;
  unitLabel?: string;
  dateLabel?: string;
  listingTitle?: string;
  stage?: string;
  pausedReason?: string;
  pausedAgeSec?: number;
  bedrooms?: number;
  destination?: string;
  siteCount?: number;
  ageSec: number;
  activeSec?: number;
};

type SidecarLaneOwner = {
  ownerType: string;
  ownerId: string;
  label: string;
  acquiredAt: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
};

type SidecarLaneWaiter = {
  ownerType: string;
  ownerId: string;
  label: string;
  enqueuedAt: number;
};

type SidecarQueueStatus = {
  total: number;
  pending: number;
  paused?: number;
  inProgress: number;
  completed: number;
  failed: number;
  oldestPendingAgeSec: number | null;
  newestRequestAt: string | null;
  byOpType?: Record<string, number>;
  activeRequests?: SidecarQueueRequest[];
  pendingRequests?: SidecarQueueRequest[];
  pausedRequests?: SidecarQueueRequest[];
  providerHealth?: Array<{
    provider: "airbnb" | "vrbo" | "booking" | string;
    status: "healthy" | "degraded" | "blocked" | "cooldown" | "unknown" | string;
    consecutiveFailures?: number;
    lastSuccessAt?: string | null;
    lastFailureAt?: string | null;
    failureReason?: string | null;
    cooldownUntil?: string | null;
    retryAfterMs?: number | null;
    updatedAt?: string | null;
  }>;
  searchVariations?: SidecarSearchVariationSummary[];
  sidecarLane?: {
    resourceKey?: string;
    leaseMs?: number;
    busy: boolean;
    owner: SidecarLaneOwner | null;
    waiting: SidecarLaneWaiter[];
  };
};

type OtaSearchProviderKey = "airbnb" | "vrbo" | "booking";

type SidecarSearchVariationAttempt = {
  term: string;
  typedQuery?: string;
  suggestionText?: string;
  source?: string;
  success: boolean;
  candidateCount: number;
  error?: string;
};

type SidecarSearchVariationSummary = {
  provider: OtaSearchProviderKey;
  communityKey: string;
  communityName: string;
  city: string | null;
  state: string | null;
  checkIn?: string;
  checkOut?: string;
  bedrooms?: number;
  tried: SidecarSearchVariationAttempt[];
  bestTerm: string | null;
  bestYieldCount: number;
  generatedTerms: string[];
};

type SidecarSearchVariationStatus = {
  communityKey: string;
  communityName: string;
  generatedTerms: string[];
  channels: Record<OtaSearchProviderKey, {
    preferredTerms: string[];
    untriedTerms?: string[];
    bestTerm: string | null;
    history: Array<{
      term: string;
      preferred: boolean;
      timesTried: number;
      lastYieldCount: number;
      totalYieldCount: number;
      lastError: string | null;
      lastSearchedAt: string | null;
      lastSuccessAt: string | null;
    }>;
    lastRun: SidecarSearchVariationSummary | null;
  }>;
};

type UnitProximityResponse =
  | {
      status: "not_enough";
      reservationId: string;
      message?: string;
    }
  | {
      status: "ready";
      reservationId: string;
      propertyId: number | null;
      community: string | null;
      resortName?: string | null;
      units: Array<{
        buyInId: number;
        unitId: string;
        unitLabel: string;
        listingUrl?: string | null;
        title: string;
        unitToken: string | null;
        address: string;
        addressSource: "saved" | "scraped" | "title-hint" | "resort";
      }>;
      walk: {
        minutes: number;
        feet: number;
        description: string;
        source: "geocoded" | "fallback";
      };
      confidence: "exact-address" | "listing-title" | "resort-default";
      withinLimit?: boolean;
      maxMinutes?: number;
      generatedAt: string;
    };

type ManualReservationFormState = {
  propertyId: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  checkIn: string;
  checkOut: string;
  totalRate: string;
  notes: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMoney(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  if (!v && v !== 0) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function guestInboxHref(r: GuestyReservation): string {
  const params = new URLSearchParams();
  params.set("reservationId", r._id);
  const guestName = r.guest?.fullName ?? r.guest?.firstName;
  if (guestName) params.set("guest", guestName);
  if (r.confirmationCode) params.set("confirmation", r.confirmationCode);
  return `/inbox?${params.toString()}`;
}

function isManualReservation(r: GuestyReservation): boolean {
  return !!r.manualReservation || r._id.startsWith("manual:") || channelKindOf(r) === "manual";
}

function groundFloorRequirementHref(r: GuestyReservation, propertyId: number): string {
  const params = new URLSearchParams();
  params.set("propertyId", String(propertyId));
  params.set("totalUnits", String(r.slots.length));
  if (r.confirmationCode) params.set("confirmationCode", r.confirmationCode);
  const guestName = r.guest?.fullName ?? r.guest?.firstName;
  if (guestName) params.set("guestName", guestName);
  const checkIn = r.checkInDateLocalized ?? r.checkIn;
  const checkOut = r.checkOutDateLocalized ?? r.checkOut;
  if (checkIn) params.set("checkIn", checkIn.slice(0, 10));
  if (checkOut) params.set("checkOut", checkOut.slice(0, 10));
  return `/api/bookings/${encodeURIComponent(r._id)}/ground-floor-requirement?${params.toString()}`;
}

function ManualReservationContactPanel({ reservation }: { reservation: GuestyReservation }) {
  const { toast } = useToast();
  const manual = reservation.manualReservation;
  const manualId = manual?.id;
  const guestName = reservation.guest?.fullName ?? reservation.guest?.firstName ?? "Guest";
  const firstName = guestName.split(/\s+/)[0] || guestName;
  const stayText = `${fmtDate(checkInOf(reservation))} to ${fmtDate(checkOutOf(reservation))}`;
  const [smsBody, setSmsBody] = useState(
    `Hi ${firstName}, this confirms your reservation from ${stayText}. Thanks, John Carpenter`,
  );
  const [emailSubject, setEmailSubject] = useState(`Reservation confirmation for ${stayText}`);
  const [emailBody, setEmailBody] = useState(
    `Aloha ${firstName},\n\nThis confirms your reservation from ${stayText}.\n\nMahalo,\nJohn Carpenter\nVacationRentalExpertz`,
  );

  const sendSms = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/manual-reservations/${manualId}/sms`, {
        to: manual?.guestPhone,
        body: smsBody,
      }).then((r) => r.json()),
    onSuccess: () => toast({ title: "Text sent" }),
    onError: (e: any) => toast({ title: "Text failed", description: e.message, variant: "destructive" }),
  });

  const sendEmail = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/manual-reservations/${manualId}/email`, {
        to: manual?.guestEmail,
        subject: emailSubject,
        body: emailBody,
      }).then((r) => r.json()),
    onSuccess: () => toast({ title: "Email sent" }),
    onError: (e: any) => toast({ title: "Email failed", description: e.message, variant: "destructive" }),
  });

  if (!manual || !manualId) return null;

  return (
    <div className="rounded border bg-background p-3 space-y-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">Manual guest contact</p>
          <p className="text-xs text-muted-foreground">
            Operations-only reservation. No Guesty or OTA message thread is connected.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {manual.guestPhone || "No phone"} · {manual.guestEmail || "No email"}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs">Text via QUO</Label>
          <Textarea
            value={smsBody}
            onChange={(e) => setSmsBody(e.target.value)}
            rows={4}
            className="text-sm"
            data-testid={`manual-sms-body-${manualId}`}
          />
          <Button
            size="sm"
            onClick={() => sendSms.mutate()}
            disabled={!manual.guestPhone || sendSms.isPending}
            data-testid={`button-send-manual-sms-${manualId}`}
          >
            <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
            {sendSms.isPending ? "Sending..." : "Send text"}
          </Button>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Email via Gmail/SMTP</Label>
          <Input
            value={emailSubject}
            onChange={(e) => setEmailSubject(e.target.value)}
            placeholder="Subject"
            data-testid={`manual-email-subject-${manualId}`}
          />
          <Textarea
            value={emailBody}
            onChange={(e) => setEmailBody(e.target.value)}
            rows={4}
            className="text-sm"
            data-testid={`manual-email-body-${manualId}`}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => sendEmail.mutate()}
            disabled={!manual.guestEmail || sendEmail.isPending}
            data-testid={`button-send-manual-email-${manualId}`}
          >
            <Mail className="h-3.5 w-3.5 mr-1.5" />
            {sendEmail.isPending ? "Sending..." : "Send email"}
          </Button>
        </div>
      </div>
    </div>
  );
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
function fmtDate(s: string | Date | undefined | null): string {
  if (!s) return "—";
  const raw = s instanceof Date ? s.toISOString() : s;
  // Pure YYYY-MM-DD — force mid-day UTC so timezone doesn't bump us to the
  // previous calendar day in western time zones.
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : raw;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function aliasExpirationSummary(expiresAt?: string | null) {
  if (!expiresAt) return { date: "Not set", relative: "expiration not saved yet", expired: false };
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return { date: "Not set", relative: "expiration not saved yet", expired: false };
  const days = Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return { date: fmtDate(expiresAt), relative: "expired", expired: true };
  if (days === 0) return { date: fmtDate(expiresAt), relative: "expires today", expired: false };
  return { date: fmtDate(expiresAt), relative: `${days} day${days === 1 ? "" : "s"} left`, expired: false };
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

const MANUAL_BUY_IN_PHOTO_MARKER = "Manual photo URLs:";

function parseUrlList(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\s,\n]+/)
    .map((url) => url.trim())
    .filter((url) => {
      if (!/^https?:\/\/\S+$/i.test(url)) return false;
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function manualBuyInPhotoUrlsFromNotes(notes: string | null | undefined): string[] {
  if (!notes?.includes(MANUAL_BUY_IN_PHOTO_MARKER)) return [];
  const afterMarker = notes.split(MANUAL_BUY_IN_PHOTO_MARKER).slice(1).join(MANUAL_BUY_IN_PHOTO_MARKER);
  return parseUrlList(afterMarker).slice(0, 12);
}

// Build the trailing "Manual photo URLs:" marker block from a candidate's
// listing photos (VRBO/Airbnb/etc.) so the guest-facing alternative page can
// render real listing photos. The marker MUST be appended LAST in the notes —
// manualBuyInPhotoUrlsFromNotes() parses every URL after it, so any other URLs
// in the notes (e.g. same-unit evidence links) must appear before this block.
function buyInPhotoNotesSuffix(photos: Array<string | null | undefined>): string {
  const urls = Array.from(new Set(
    photos.map((url) => String(url ?? "").trim()).filter((url) => /^https?:\/\/\S+$/i.test(url)),
  )).slice(0, 12);
  return urls.length ? ` · ${MANUAL_BUY_IN_PHOTO_MARKER} ${urls.join(" ")}` : "";
}

function isAirbnbUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return /(?:^|\.)airbnb\.com$/i.test(new URL(url).hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

function buyInFoundViaAirbnbGoogleLens(
  buyIn: Pick<BuyIn, "airbnbListingUrl" | "notes"> | null | undefined,
): boolean {
  if (!buyIn?.airbnbListingUrl || isAirbnbUrl(buyIn.airbnbListingUrl)) return false;
  const notes = String(buyIn.notes ?? "");
  return /found via airbnb google lens|google lens.*airbnb|airbnb.*google lens|direct booking link found from airbnb photos|photo-matched to airbnb listing|airbnb supplied the date-specific|airbnb anchor|auto-filled from direct (?:link|pm)/i.test(notes);
}

function airbnbAnchorUrlFromBuyInNotes(
  buyIn: Pick<BuyIn, "airbnbListingUrl" | "notes"> | null | undefined,
): string | null {
  if (!buyIn?.notes || isAirbnbUrl(buyIn.airbnbListingUrl)) return null;
  const match = String(buyIn.notes).match(/https?:\/\/(?:www\.)?airbnb\.[^\s)]+/i);
  if (!match?.[0]) return null;
  return match[0].replace(/[.,;:]+$/, "");
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

function UnitProximityCard({ reservation }: { reservation: GuestyReservation }) {
  const attachedSlots = reservation.slots.filter((slot) => !!slot.buyIn);
  const attachedKey = attachedSlots.map((slot) => slot.buyIn?.id).filter(Boolean).join(",");
  const query = useQuery<UnitProximityResponse>({
    queryKey: ["/api/bookings", reservation._id, "unit-proximity", attachedKey],
    queryFn: ({ signal }) => apiGetJson<UnitProximityResponse>(
      `/api/bookings/${encodeURIComponent(reservation._id)}/unit-proximity`,
      signal,
    ),
    enabled: attachedSlots.length >= 2,
    staleTime: 10 * 60 * 1000,
  });

  if (attachedSlots.length < 2) return null;

  const sourceText = (data: Extract<UnitProximityResponse, { status: "ready" }>) => {
    if (data.confidence === "exact-address") return "address verified";
    if (data.confidence === "listing-title") return "estimated from listing titles";
    return "resort footprint estimate";
  };

  const displayUnitLabel = (unit: Extract<UnitProximityResponse, { status: "ready" }>["units"][number]) => {
    const token = String(unit.unitToken ?? "").trim();
    const slotLabel = String(unit.unitLabel ?? "").trim();
    if (token && slotLabel && !slotLabel.toLowerCase().includes(token.toLowerCase())) {
      return `Buy-in #${token} for ${slotLabel}`;
    }
    return slotLabel || (token ? `Buy-in #${token}` : "Buy-in unit");
  };

  const addressAlreadyShowsToken = (unit: Extract<UnitProximityResponse, { status: "ready" }>["units"][number]) => {
    const token = String(unit.unitToken ?? "").trim();
    if (!token) return false;
    return new RegExp(`(?:#|unit\\s+|apt\\s+)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(unit.address);
  };

  const isTooFar = query.data?.status === "ready" && query.data.withinLimit === false;
  const limit = query.data?.status === "ready" ? query.data.maxMinutes ?? 10 : 10;
  const cardClass = isTooFar
    ? "rounded border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-950 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-100"
    : "rounded border border-sky-200 bg-sky-50/65 px-3 py-2 text-xs text-sky-950 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-100";
  const mutedClass = isTooFar ? "text-red-800 dark:text-red-200" : "text-sky-800 dark:text-sky-200";
  const tinyClass = isTooFar ? "text-red-700 dark:text-red-300" : "text-sky-700 dark:text-sky-300";

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 font-medium">
          <Footprints className="h-3.5 w-3.5" />
          Unit walking distance
        </span>
        {query.isLoading ? (
          <span className={`inline-flex items-center gap-1 ${mutedClass}`}>
            <Loader2 className="h-3 w-3 animate-spin" />
            checking addresses...
          </span>
        ) : query.isError ? (
          <span className="text-amber-700 dark:text-amber-300">Could not estimate automatically</span>
        ) : query.data?.status === "ready" ? (
          <>
            <Badge className={`${isTooFar ? "bg-red-700" : "bg-sky-700"} text-white text-[10px]`}>
              {query.data.walk.minutes} min walk
            </Badge>
            <span className={mutedClass}>
              {isTooFar
                ? `Too far to assign: ${query.data.walk.description} Buy-in units must be within ${limit} minutes.`
                : query.data.walk.description}
            </span>
            <span className={`text-[10px] ${tinyClass}`}>
              {sourceText(query.data)}
            </span>
          </>
        ) : (
          <span className={mutedClass}>waiting for two attached units</span>
        )}
      </div>
      {query.data?.status === "ready" && (
        <div className={`mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] ${mutedClass}`}>
          {query.data.units.map((unit) => (
            <span key={unit.buyInId} className="inline-flex items-center gap-1 min-w-0" title={unit.address}>
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="font-medium">{displayUnitLabel(unit)}</span>
              <span className="truncate max-w-[320px]">
                {unit.unitToken && !addressAlreadyShowsToken(unit) ? `#${unit.unitToken} · ` : ""}{unit.address}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function isGenericRentalTitle(title: string): boolean {
  const t = normalizedIdentityText(title);
  if (!t) return true;
  if (/^(?:condo|apartment|townhouse|home|house|villa|rental unit|guest suite|loft|cottage|bungalow|place)\s+in\s+[a-z ]+$/.test(t)) return true;
  if (/^(?:beautiful|lovely|spacious|modern|luxury|elegant)?\s*(?:\d+\s*(?:br|bedroom)\s*)?(?:condo|apartment|townhouse|home|house|villa|rental)$/.test(t)) return true;
  return false;
}

function sharedResortPhraseKeys(candidate: Pick<LiveCandidate, "title" | "sourceLabel">): string[] {
  const text = normalizedIdentityText([candidate.title, candidate.sourceLabel].filter(Boolean).join(" "));
  if (!text) return [];

  const keys = new Set<string>();
  const patterns = [
    /\b(villas? of [a-z0-9 ]{3,40}?)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? villas?)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? resort)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? plantation)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = normalizedIdentityText(match[1]);
      if (key.length >= 10 && !isGenericRentalTitle(key)) keys.add(key);
    }
  }
  return Array.from(keys);
}

function candidatesShareStrongResortPhrase(
  a: Pick<LiveCandidate, "title" | "sourceLabel">,
  b: Pick<LiveCandidate, "title" | "sourceLabel">,
): boolean {
  const aKeys = new Set(sharedResortPhraseKeys(a));
  if (aKeys.size === 0) return false;
  return sharedResortPhraseKeys(b).some((key) => aKeys.has(key));
}

function titleFromBuyInNotes(notes: string | null | undefined): string {
  const raw = String(notes ?? "");
  const manualCombo = raw.match(/Manually attached from combo\s+.+?\s+—\s+\d+\s*BR\s+[^—]+—\s*([^·]+)/i);
  if (manualCombo?.[1]) return manualCombo[1].trim();
  const autoFilled = raw.match(/(?:Auto-filled from|Bought via)\s+[^—-]+[—-]\s*([^·]+)/i);
  if (autoFilled?.[1]) return autoFilled[1].trim();
  const firstClause = raw.split(" · ")[0] ?? raw;
  const dash = firstClause.indexOf(" — ");
  if (dash >= 0) return firstClause.slice(dash + 3).trim();
  return "";
}

function cleanGuestAlternativeLabel(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s·\-–—|,:;]+|[\s·\-–—|,:;]+$/g, "")
    .trim();
}

function usableGuestAlternativeCommunity(value: string | null | undefined): string {
  const label = cleanGuestAlternativeLabel(value);
  if (!label || label.length < 4) return "";
  if (/manually attached from combo|auto-filled from|selected from saved|manual photo urls/i.test(label)) return "";
  if (/^\d+\s*(?:br|bd|bedrooms?)?\b/i.test(label)) return "";
  return label;
}

function alternativeCommunityFromBuyInNotes(notes: string | null | undefined, listingTitle: string): string {
  const raw = String(notes ?? "");
  const comboLabel = cleanGuestAlternativeLabel(
    raw.match(/Manually attached from combo\s+(.+?)\s+—\s+\d+\s*BR\s+[^—·]+—/i)?.[1],
  );
  const comboCommunity = usableGuestAlternativeCommunity(comboLabel.split(/\s*·\s*/).pop());
  if (comboCommunity) return comboCommunity;
  const titleLead = usableGuestAlternativeCommunity(listingTitle.split(/\s+[-–—|]\s+/)[0]);
  if (
    titleLead &&
    !/^(?:gorgeous|beautiful|stunning|luxury|spacious|updated|renovated|private|oceanfront|beachfront|sleeps?|bedrooms?|condos?|villas?|homes?|townhomes?|units?|studio)\b/i.test(titleLead)
  ) {
    return titleLead;
  }
  return "";
}

function originalCommunityForAlternativePage(reservation: GuestyReservation, slots: Array<SlotInfo & { buyIn: BuyIn }>): string {
  const propertyId = Number(slots[0]?.buyIn?.propertyId);
  const builder = Number.isFinite(propertyId) ? getUnitBuilderByPropertyId(propertyId) : undefined;
  return cleanGuestAlternativeLabel(
    builder?.complexName ??
      (Number.isFinite(propertyId) ? PROPERTY_UNIT_CONFIGS[propertyId]?.community : undefined) ??
      reservation.slots.find((slot) => slot.community)?.community ??
      slots[0]?.buyIn?.propertyName,
  );
}

function originalAreaForAlternativePage(reservation: GuestyReservation, slots: Array<SlotInfo & { buyIn: BuyIn }>): string {
  const propertyId = Number(slots[0]?.buyIn?.propertyId);
  return cleanGuestAlternativeLabel(
    (Number.isFinite(propertyId) ? PROPERTY_UNIT_CONFIGS[propertyId]?.community : undefined) ??
      reservation.slots.find((slot) => slot.community)?.community ??
      "",
  );
}

function listingIdentityKeys(item: {
  url?: string | null;
  sourceLabel?: string | null;
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

  const labelKey = normalizedIdentityText(item.sourceLabel);
  const labelLooksUnitSpecific = /\b(?:unit|apt|suite|condo|villa|regency|#)?\s*\d{2,4}\b/.test(labelKey);
  if (labelKey.length >= 12 && labelLooksUnitSpecific && !isGenericRentalTitle(labelKey)) {
    keys.add(`label:${labelKey}`);
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

function candidateMatchesBedroom(candidate: Pick<LiveCandidate, "bedrooms">, bedrooms: number): boolean {
  return typeof candidate.bedrooms !== "number" || Math.round(candidate.bedrooms) === bedrooms;
}

type CityVrboInventoryListing = {
  url: string;
  title: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  sleeps?: number | null;
  nightlyPrice?: number;
  totalPrice?: number;
  rating?: number | null;
  reviewCount?: number | null;
  lat?: number | null;
  lng?: number | null;
  sourceLabel?: string;
  locationText?: string | null;
  snippet?: string;
  basicDetails?: string[];
  image?: string | null;
  images?: string[];
};

type CityVrboInventoryResponse = {
  propertyId: number;
  community: string;
  citySearchTerm: string;
  nights: number;
  rawListings?: CityVrboInventoryListing[];
  listings: CityVrboInventoryListing[];
  byBedroom: Record<number, CityVrboInventoryListing[]>;
  suggestedPair: {
    resortPhrase: string;
    bedrooms: number[];
    picks: CityVrboInventoryListing[];
    totalCost: number;
    walkMinutes: number | null;
    walkSource: string;
    matchSource?: string;
    matchConfidence?: "high" | "medium" | "low";
  } | null;
  sidecar: {
    workerOnline: boolean;
    durationMs: number;
    reason: string;
    rawCount: number;
    mapHarvest: Record<string, unknown> | null;
  };
  filterPipeline?: {
    rawSidecar: number;
    droppedNoPrice: number;
    droppedBelowMinBedrooms: number;
    afterNormalize: number;
    phraseFilter: string | null;
    afterPhraseFilter: number;
    byBedroom: Record<number, number>;
    phraseBuckets: number;
    suggestedPair: boolean;
  };
  fromCache?: boolean;
};

function liveCandidateFromCityComboPick(
  pick: AutoFillComboOption["picks"][number],
  slotBedrooms: number,
  nights: number,
): LiveCandidate {
  return {
    source: "vrbo",
    sourceLabel: pick.sourceLabel,
    title: pick.title,
    url: pick.url,
    nightlyPrice: pick.nightlyPrice ?? Math.round(pick.totalPrice / Math.max(1, nights)),
    totalPrice: pick.totalPrice,
    bedrooms: slotBedrooms,
    image: pick.image,
    images: pick.images,
    verified: pick.verified ?? "yes",
    verifiedReason: pick.verifiedReason ?? "City VRBO map inventory title match",
    identityKeys: listingIdentityKeys({ url: pick.url, title: pick.title, sourceLabel: pick.sourceLabel }),
  };
}

function cityInventorySearchSummary(
  data: CityVrboInventoryResponse,
  slotBedrooms: number,
): AutoFillSearchSummary {
  const kept = data.byBedroom[slotBedrooms]?.length ?? 0;
  return {
    bedrooms: slotBedrooms,
    scanned: data.listings.length,
    priced: data.listings.length,
    sourceCounts: { airbnb: 0, vrbo: data.listings.length, booking: 0, pm: 0 },
    kept,
    targetFiltered: 0,
    groundFloorOnly: false,
  };
}

function cityComboOptionFromInventory(data: CityVrboInventoryResponse): AutoFillComboOption | null {
  const pair = data.suggestedPair;
  if (!pair?.picks?.length || pair.picks.length !== pair.bedrooms.length) return null;
  return {
    label: `${pair.bedrooms.map((b) => `${b}BR`).join(" + ")} · ${pair.resortPhrase}`,
    bedrooms: pair.bedrooms,
    totalCost: pair.totalCost,
    selected: true,
    note: `City VRBO inventory${pair.walkMinutes != null ? ` · ~${pair.walkMinutes} min walk` : ""}`,
    picks: pair.picks.map((pick, index) => ({
      bedrooms: pair.bedrooms[index] ?? (Number(pick.bedrooms) || 0),
      source: "vrbo",
      sourceLabel: pick.sourceLabel ?? "Vrbo",
      title: pick.title,
      totalPrice: Number(pick.totalPrice) || 0,
      nightlyPrice: pick.nightlyPrice,
      url: pick.url,
      // Carry the VRBO listing photos through so they reach the buy-in notes
      // and, ultimately, the guest-facing alternative page.
      image: pick.image ?? undefined,
      images: Array.isArray(pick.images) && pick.images.length
        ? pick.images
        : (pick.image ? [pick.image] : undefined),
      verified: "yes",
      verifiedReason: "Matched resort phrase in city VRBO dropdown inventory",
    })),
  };
}

// ── Nearby-city combo expansion (background job + polling) ──────────────────
// Mirrors the serialized shape returned by GET /api/operations/city-vrbo-
// inventory/expand/:jobId (server/city-vrbo-expansion.ts serializeExpansionJob).
// `combo` is the same payload shape as the city-vrbo-inventory GET response, so
// cityComboOptionFromInventory(combo) works unchanged when status === "found".
type CityExpansionCityResult = {
  citySearchTerm: string;
  placeName: string;
  driveMinutes: number;
  tier: 1 | 2;
  status: "pending" | "scanning" | "no-pair" | "pair" | "skipped" | "scan-error";
  listingsExported?: number;
  suggestedPair: boolean;
  workerOnline?: boolean;
  reason?: string;
  durationMs?: number;
};

type CityExpansionJobStatus = {
  jobId: string;
  status: "pending" | "running" | "found" | "exhausted" | "worker_offline" | "error";
  done: boolean;
  community: string;
  checkIn: string;
  checkOut: string;
  phase: { tier: 0 | 1 | 2; label: string };
  tier: number | null;
  currentCity: string | null;
  citiesSearched: string[];
  scannedCount: number;
  totalCount: number;
  cityResults: CityExpansionCityResult[];
  workerOnline: boolean;
  error: string | null;
  combo: CityVrboInventoryResponse | null;
  comboSourceCity: string | null;
  driveMinutes: number | null;
  timestamps: { createdAt: number; startedAt: number | null; finishedAt: number | null };
};

// Poll an expansion job to a terminal state (bulk path runs this inline inside
// autoFillMutation; each GET is a short request, so no edge-timeout risk).
// Returns the terminal status, or null if the job was lost (404 / server
// restart) or the safety cap elapsed.
async function pollExpansionToTerminal(
  jobId: string,
  opts?: { maxMs?: number; intervalMs?: number },
): Promise<CityExpansionJobStatus | null> {
  const maxMs = opts?.maxMs ?? 35 * 60_000;
  const intervalMs = opts?.intervalMs ?? 3000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    try {
      const data = await apiGetJson<CityExpansionJobStatus>(
        `/api/operations/city-vrbo-inventory/expand/${jobId}`,
      );
      if (data.done) return data;
    } catch (e: any) {
      // 404 → job lost (server restart): terminal, give up.
      if (/\b404\b/.test(String(e?.message ?? ""))) return null;
      // transient error → keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// Headless poller for the interactive path: polls every 3s, pushes live state to
// the row's progress UI, and fires onResolved exactly once when the job reaches a
// terminal state (or is lost). Version-agnostic setInterval style so it doesn't
// depend on react-query refetchInterval semantics.
function CityExpansionJobPoller({
  jobId,
  onState,
  onResolved,
}: {
  jobId: string;
  onState: (status: CityExpansionJobStatus) => void;
  onResolved: (status: CityExpansionJobStatus | null) => void;
}) {
  const resolvedRef = useRef(false);
  useEffect(() => {
    resolvedRef.current = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Cap on cumulative FOREGROUND/active polling time — deliberately NOT
    // wall-clock-from-mount. Mobile Safari suspends background tabs, so a
    // wall-clock cap would trip purely because the operator stepped away,
    // abandoning a job the server is still running (the "came back and it
    // paused" bug). We bill only the gaps between ticks while the tab was
    // visible, and never bill a suspended gap. Still > the server's worst case
    // (30-min budget + one ~8-min scan) so a real overrun isn't stranded and a
    // persistent error (e.g. 401 after session expiry) can't loop forever.
    const overallActiveCapMs = 45 * 60_000;
    // A gap larger than this between ticks means the tab was suspended
    // (backgrounded) — don't count it against the active budget.
    const SUSPEND_GAP_MS = 30_000;
    let activeElapsedMs = 0;
    let lastTickAt = Date.now();
    const tick = async () => {
      if (cancelled || resolvedRef.current) return;
      const now = Date.now();
      const sinceLast = now - lastTickAt;
      lastTickAt = now;
      if (sinceLast > 0 && sinceLast <= SUSPEND_GAP_MS) activeElapsedMs += sinceLast;
      if (activeElapsedMs > overallActiveCapMs) {
        resolvedRef.current = true;
        if (!cancelled) onResolved(null);
        return;
      }
      try {
        const data = await apiGetJson<CityExpansionJobStatus>(
          `/api/operations/city-vrbo-inventory/expand/${jobId}`,
        );
        if (cancelled || resolvedRef.current) return;
        onState(data);
        if (data.done) {
          resolvedRef.current = true;
          onResolved(data);
          return;
        }
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        // 404 (job lost / server restart) and 401/403 (portal session lost — this
        // local apiGetJson doesn't do apiRequest's login redirect) are terminal.
        if (/\b(404|401|403)\b/.test(msg)) {
          resolvedRef.current = true;
          if (!cancelled) onResolved(null);
          return;
        }
        // other transient errors: keep polling (bounded by overallActiveCapMs)
      }
      if (!cancelled && !resolvedRef.current) timer = setTimeout(tick, 3000);
    };
    // On return-to-foreground, poll immediately so the row updates right away
    // instead of waiting out a (possibly frozen) setTimeout cycle. Re-anchor
    // lastTickAt first so the suspended gap isn't billed to the active budget.
    const resumeTick = () => {
      if (cancelled || resolvedRef.current) return;
      if (document.visibilityState !== "visible") return;
      if (timer) { clearTimeout(timer); timer = null; }
      lastTickAt = Date.now();
      void tick();
    };
    window.addEventListener("focus", resumeTick);
    document.addEventListener("visibilitychange", resumeTick);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", resumeTick);
      document.removeEventListener("visibilitychange", resumeTick);
      // Only cancel the server job on a DELIBERATE unmount — the tab is visible,
      // so the operator navigated away / closed the row. When the tab is hidden
      // the unmount is almost certainly iOS suspending or discarding the page;
      // cancelling there would throw away live sidecar work the operator expects
      // to keep running (the reported bug). A hidden unmount leaves the job to
      // finish under its own server-side budget; the row re-attaches on return.
      const tabVisible = typeof document === "undefined" || document.visibilityState === "visible";
      if (!resolvedRef.current && tabVisible) {
        apiRequest("POST", `/api/operations/city-vrbo-inventory/expand/${jobId}/cancel`).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  return null;
}

// ── Auto-fill server job (mirror of server/auto-fill-job.ts serialize) ──────
// The full buy-in escalation ladder + the buy-in attach now run server-side as
// a fire-and-forget job, so "Auto-fill cheapest" keeps running AND keeps
// attaching even after the operator leaves the bookings page / backgrounds the
// tab. These poll/resolve helpers mirror the expansion poller above.
type AutoFillJobEscalation = {
  resort: EscalationStageStatus;
  resortLabel?: string;
  homeCity: EscalationStageStatus;
  homeCityTerm?: string;
  homeCityListings?: number;
  foundAt?: "resort" | "home-city" | "nearby" | null;
  nearbyStatus?: "searching" | "found" | "exhausted" | "worker_offline" | "error";
  tierResults?: CityExpansionCityResult[];
};
type AutoFillJobAttached = {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
  buyInId: number | null;
  title: string;
  sourceLabel: string;
  url: string;
  totalPrice: number;
  airbnbPick: boolean;
  stage: "resort" | "home-city" | "nearby" | "single-unit-city";
};
type AutoFillJobStatus = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  done: boolean;
  phase: string;
  message: string;
  progress: number;
  reservationId: string;
  escalation: AutoFillJobEscalation;
  attached: AutoFillJobAttached[];
  skipped: Array<{ unitId: string; unitLabel: string; reason: string }>;
  searchAudits: AutoFillSearchAudit[];
  comboOptions: AutoFillComboOption[];
  slotsTotal: number;
  slotsFilled: number;
  totalCost: number | null;
  error: string | null;
};

// The shape the auto-fill mutation returns / the bulk queue report consumes.
type AutoFillResultRow = {
  slot: { unitId: string; unitLabel: string; bedrooms: number };
  picked: { totalPrice: number; url: string; title: string; sourceLabel: string } | null;
  airbnbPick: boolean;
  skippedReasons: string[];
  searchSummary: AutoFillSearchSummary;
};
type AutoFillMutationResult = {
  reservation: GuestyReservation;
  results: AutoFillResultRow[];
  comboOptions: AutoFillComboOption[];
  searchAudits: AutoFillSearchAudit[];
  autoFillJob?: { jobId: string; reservationId: string };
};

// Poll an auto-fill job to terminal (the bulk path runs this inline so its
// pass/fail report reflects what actually attached).
async function pollAutoFillToTerminal(
  jobId: string,
  opts?: { maxMs?: number; intervalMs?: number },
): Promise<AutoFillJobStatus | null> {
  const maxMs = opts?.maxMs ?? 50 * 60_000;
  const intervalMs = opts?.intervalMs ?? 3000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    try {
      const data = await apiGetJson<AutoFillJobStatus>(`/api/operations/auto-fill/${jobId}`);
      if (data.done) return data;
    } catch (e: any) {
      if (/\b(404|401|403)\b/.test(String(e?.message ?? ""))) return null;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// Build the legacy {results, searchAudits, comboOptions} shape the bulk-queue
// reporting consumes, from a terminal auto-fill job payload.
function autoFillResultFromJob(
  reservation: GuestyReservation,
  terminal: AutoFillJobStatus | null,
): AutoFillMutationResult {
  const attachedByUnit = new Map((terminal?.attached ?? []).map((a) => [a.unitId, a] as const));
  const emptySlots = (reservation.slots ?? []).filter((s) => !s.buyIn);
  const results: AutoFillResultRow[] = emptySlots.map((slot) => {
    const summary: AutoFillSearchSummary = {
      bedrooms: slot.bedrooms,
      scanned: 0,
      priced: 0,
      sourceCounts: { airbnb: 0, vrbo: 0, booking: 0, pm: 0 },
      kept: 0,
      targetFiltered: 0,
      groundFloorOnly: false,
    };
    const a = attachedByUnit.get(slot.unitId);
    if (a) {
      return {
        slot: { unitId: slot.unitId, unitLabel: slot.unitLabel, bedrooms: slot.bedrooms },
        picked: { totalPrice: a.totalPrice, url: a.url, title: a.title, sourceLabel: a.sourceLabel },
        airbnbPick: a.airbnbPick,
        skippedReasons: [],
        searchSummary: summary,
      };
    }
    const skips = (terminal?.skipped ?? []).filter((s) => s.unitId === slot.unitId).map((s) => s.reason);
    return {
      slot: { unitId: slot.unitId, unitLabel: slot.unitLabel, bedrooms: slot.bedrooms },
      picked: null,
      airbnbPick: false,
      skippedReasons: skips.length ? skips : [terminal ? "No verified priced candidate attached" : "Auto-fill job was lost (server restart)"],
      searchSummary: summary,
    };
  });
  return {
    reservation,
    results,
    comboOptions: terminal?.comboOptions ?? [],
    searchAudits: terminal?.searchAudits ?? [],
  };
}

// Headless poller for the interactive path — mirrors CityExpansionJobPoller.
// Polls every 3s, pushes live state, fires onResolved once terminal/lost.
// Active-time budget (not wall-clock) so a backgrounded tab doesn't strand a
// job the server is still running.
function AutoFillJobPoller({
  jobId,
  onState,
  onResolved,
}: {
  jobId: string;
  onState: (status: AutoFillJobStatus) => void;
  onResolved: (status: AutoFillJobStatus | null) => void;
}) {
  const resolvedRef = useRef(false);
  useEffect(() => {
    resolvedRef.current = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const overallActiveCapMs = 55 * 60_000;
    const SUSPEND_GAP_MS = 30_000;
    let activeElapsedMs = 0;
    let lastTickAt = Date.now();
    const tick = async () => {
      if (cancelled || resolvedRef.current) return;
      const now = Date.now();
      const sinceLast = now - lastTickAt;
      lastTickAt = now;
      if (sinceLast > 0 && sinceLast <= SUSPEND_GAP_MS) activeElapsedMs += sinceLast;
      if (activeElapsedMs > overallActiveCapMs) {
        resolvedRef.current = true;
        if (!cancelled) onResolved(null);
        return;
      }
      try {
        const data = await apiGetJson<AutoFillJobStatus>(`/api/operations/auto-fill/${jobId}`);
        if (cancelled || resolvedRef.current) return;
        onState(data);
        if (data.done) {
          resolvedRef.current = true;
          onResolved(data);
          return;
        }
      } catch (e: any) {
        // 404 (job lost / server restart) + 401/403 (portal session lost) are terminal.
        if (/\b(404|401|403)\b/.test(String(e?.message ?? ""))) {
          resolvedRef.current = true;
          if (!cancelled) onResolved(null);
          return;
        }
      }
      if (!cancelled && !resolvedRef.current) timer = setTimeout(tick, 3000);
    };
    const resumeTick = () => {
      if (cancelled || resolvedRef.current) return;
      if (document.visibilityState !== "visible") return;
      if (timer) { clearTimeout(timer); timer = null; }
      lastTickAt = Date.now();
      void tick();
    };
    window.addEventListener("focus", resumeTick);
    document.addEventListener("visibilitychange", resumeTick);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", resumeTick);
      document.removeEventListener("visibilitychange", resumeTick);
      // NEVER cancel the server job on unmount — the whole point is that it keeps
      // running when the operator leaves the page. The job finishes under its own
      // server-side budget; the row re-discovers it on return via the active-jobs query.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  return null;
}

// ── Buy-in search-escalation tracker ────────────────────────────────────────
// Visualizes the 4-stage ladder the buy-in auto-fill walks:
//   1 Resort search → 2 Home city → 3 Cities within 20 min → 4 Cities within 45 min.
// Stages 1-2 come from the auto-fill mutation; stages 3-4 from the expansion job
// (server/city-vrbo-expansion.ts tier 1 = 20 min, tier 2 = 45 min).
type EscalationStageStatus = "idle" | "searching" | "found" | "no-pair" | "skipped";
type BuyInEscalation = {
  resort: EscalationStageStatus;
  resortLabel?: string;
  homeCity: EscalationStageStatus;
  homeCityTerm?: string;
  homeCityListings?: number;
  foundAt?: "resort" | "home-city" | "nearby" | null;
  // Snapshot of the nearby-city expansion captured when its job resolves, so the
  // tracker keeps showing the searched-cities ladder after the job is cleared
  // (the "we searched 20 towns and found nothing" view).
  tierResults?: CityExpansionCityResult[];
  nearbyStatus?: "searching" | "found" | "exhausted" | "worker_offline" | "error";
  startedAt: number;
};

function escalationStageBadge(status: EscalationStageStatus): { label: string; cls: string; spin?: boolean } {
  switch (status) {
    case "searching": return { label: "Searching", cls: "bg-amber-100 text-amber-800 border-amber-300", spin: true };
    case "found": return { label: "Pair found", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" };
    case "no-pair": return { label: "No pair", cls: "bg-slate-100 text-slate-600 border-slate-300" };
    case "skipped": return { label: "Skipped", cls: "bg-slate-50 text-slate-400 border-slate-200" };
    default: return { label: "Not run", cls: "bg-slate-50 text-slate-400 border-slate-200" };
  }
}

function BuyInEscalationStages({
  escalation,
  expansion,
}: {
  escalation: BuyInEscalation;
  expansion?: {
    status: "pending" | "running" | "found" | "exhausted" | "worker_offline" | "error";
    tier: number | null;
    currentCity: string | null;
    scannedCount: number;
    totalCount: number;
    cityResults: CityExpansionCityResult[];
  } | null;
}) {
  // Live results come from the running expansion job; once it resolves the row is
  // cleared, so fall back to the snapshot stored on the escalation state.
  const allCityResults = expansion?.cityResults ?? escalation.tierResults ?? [];
  const tier1 = allCityResults.filter((c) => c.tier === 1);
  const tier2 = allCityResults.filter((c) => c.tier === 2);
  const expRunning = expansion?.status === "running" || expansion?.status === "pending" || escalation.nearbyStatus === "searching";
  const workerOffline = expansion?.status === "worker_offline" || escalation.nearbyStatus === "worker_offline";
  const foundEarly = escalation.foundAt === "resort" || escalation.foundAt === "home-city";

  const tierStatus = (rows: CityExpansionCityResult[], tierNum: 1 | 2): EscalationStageStatus => {
    if (rows.some((r) => r.status === "pair")) return "found";
    if (foundEarly) return "skipped";
    if (rows.some((r) => r.status === "scanning")) return "searching";
    if (expRunning && rows.some((r) => r.status === "pending")) return "searching";
    if (rows.length > 0 && rows.every((r) => ["no-pair", "scan-error", "skipped"].includes(r.status))) return "no-pair";
    if (expRunning && tierNum === 1 && rows.length === 0) return "searching";
    return "idle";
  };

  const cityChip = (c: CityExpansionCityResult) => {
    const sym = c.status === "pair" ? "✓"
      : c.status === "scanning" ? "…"
      : c.status === "no-pair" ? "✗"
      : c.status === "scan-error" ? "!"
      : c.status === "skipped" ? "–"
      : "·";
    const cls = c.status === "pair" ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : c.status === "scanning" ? "bg-amber-100 text-amber-800 border-amber-300"
      : c.status === "no-pair" ? "bg-slate-100 text-slate-600 border-slate-200"
      : c.status === "pending" ? "bg-slate-50 text-slate-400 border-slate-200"
      : "bg-rose-50 text-rose-700 border-rose-200";
    return (
      <span key={`${c.tier}-${c.citySearchTerm}`} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${cls}`}>
        <span className="font-bold">{sym}</span>
        {c.placeName || c.citySearchTerm}{typeof c.driveMinutes === "number" ? ` · ${c.driveMinutes}m` : ""}
      </span>
    );
  };

  const StageRow = ({ n, title, sub, status }: { n: number; title: string; sub?: string; status: EscalationStageStatus }) => {
    const b = escalationStageBadge(status);
    return (
      <div className="flex items-center gap-2">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
          status === "found" ? "border-emerald-500 bg-emerald-500 text-white"
          : status === "searching" ? "border-amber-400 bg-amber-400 text-white"
          : status === "no-pair" ? "border-slate-300 bg-slate-300 text-white"
          : "border-slate-300 bg-white text-slate-400"
        }`}>{n}</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-800">{title}</div>
          {sub ? <div className="truncate text-[10px] text-slate-500">{sub}</div> : null}
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${b.cls}`}>
          {b.spin ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}{b.label}
        </span>
      </div>
    );
  };

  const t1Status = tierStatus(tier1, 1);
  const t2Status = tierStatus(tier2, 2);
  const subForTier = (rows: CityExpansionCityResult[]): string | undefined =>
    rows.length ? undefined : (foundEarly ? "skipped — pair found earlier" : undefined);

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-[11px] shadow-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-slate-700">Buy-in search escalation</span>
        {workerOffline ? <span className="text-[10px] font-medium text-rose-600">sidecar offline</span> : null}
      </div>
      <StageRow n={1} title="Resort search" sub={escalation.resortLabel} status={escalation.resort} />
      <StageRow
        n={2}
        title="Home city"
        sub={escalation.homeCityTerm ? `${escalation.homeCityTerm}${escalation.homeCityListings ? ` · ${escalation.homeCityListings} listings` : ""}` : undefined}
        status={escalation.homeCity}
      />
      <div>
        <StageRow n={3} title="Cities within 20 min" sub={subForTier(tier1)} status={t1Status} />
        {tier1.length > 0 ? <div className="ml-7 mt-1 flex flex-wrap gap-1">{tier1.map(cityChip)}</div> : null}
      </div>
      <div>
        <StageRow n={4} title="Cities within 45 min" sub={subForTier(tier2)} status={t2Status} />
        {tier2.length > 0 ? <div className="ml-7 mt-1 flex flex-wrap gap-1">{tier2.map(cityChip)}</div> : null}
      </div>
      {expRunning && expansion?.currentCity ? (
        <div className="text-[10px] text-slate-500">
          Scanning {expansion.currentCity}
          {expansion.totalCount > 0 ? ` · ${expansion.scannedCount}/${expansion.totalCount}` : ""}
        </div>
      ) : null}
    </div>
  );
}

function CityVrboInventoryPanel({
  propertyId,
  reservation,
  community,
  bedroomPlan,
  onAttachCombo,
  attaching,
  autoScanTrigger = 0,
}: {
  propertyId: number;
  reservation: GuestyReservation;
  community: string;
  bedroomPlan: number[];
  onAttachCombo: (option: AutoFillComboOption) => void;
  attaching?: boolean;
  /** Bumped by Auto-fill cheapest when resort search fails so the panel runs without a manual click. */
  autoScanTrigger?: number;
}) {
  const { toast } = useToast();
  // One auto-action per scan result: auto-attach the cheapest same-community
  // pair, or pop a "no matches" toast. Refs keep it from re-firing each render.
  const autoAttachSigRef = useRef<string>("");
  const noMatchSigRef = useRef<string>("");
  // Only the operator-initiated "Scan city VRBO" button auto-attaches/pops the
  // toast. Auto-fill-cheapest-triggered scans (autoScanTrigger) are left alone:
  // that flow does its OWN city attach, so racing it here would double-attach.
  const manualScanRef = useRef(false);
  // Operator override: chosen listing URL per unit slot (unitId -> url).
  const [manualPicks, setManualPicks] = useState<Record<string, string>>({});
  const toDateOnly = (s: string | undefined): string => {
    if (!s) return "";
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.slice(0, 10);
  };
  const checkIn = toDateOnly(reservation.checkInDateLocalized ?? reservation.checkIn);
  const checkOut = toDateOnly(reservation.checkOutDateLocalized ?? reservation.checkOut);
  const [scanNonce, setScanNonce] = useState(0);
  const effectiveScanNonce = Math.max(scanNonce, autoScanTrigger);
  useEffect(() => {
    if (autoScanTrigger > scanNonce) {
      manualScanRef.current = false;
      setScanNonce(autoScanTrigger);
    }
  }, [autoScanTrigger, scanNonce]);
  const { data, isFetching, isError, error } = useQuery<CityVrboInventoryResponse>({
    queryKey: ["/api/operations/city-vrbo-inventory", propertyId, checkIn, checkOut, effectiveScanNonce],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        propertyId: String(propertyId),
        checkIn,
        checkOut,
      });
      // A manual "Re-scan city VRBO" click forces a fresh sidecar export. Without
      // this the server's 20-min city-pool cache re-serves the prior result, so an
      // operator who sees a short/stale export ("cached pool · N exported") and
      // clicks Re-scan would keep getting the same cached count. Auto-fill-driven
      // scans (manualScanRef false) still use the cache to avoid burning a scrape.
      if (manualScanRef.current) params.set("nocache", "1");
      return apiGetJson<CityVrboInventoryResponse>(`/api/operations/city-vrbo-inventory?${params.toString()}`, signal);
    },
    enabled: effectiveScanNonce > 0 && !!checkIn && !!checkOut,
    staleTime: 0,
  });
  const comboOption = useMemo(() => (data ? cityComboOptionFromInventory(data) : null), [data]);
  const bedroomGroups = data
    ? Object.entries(data.byBedroom).sort(([a], [b]) => Number(b) - Number(a))
    : [];
  const harvest = data?.sidecar?.mapHarvest;
  const csvDownloadHref = useMemo(() => {
    if (!checkIn || !checkOut) return "";
    const params = new URLSearchParams({
      propertyId: String(propertyId),
      checkIn,
      checkOut,
      format: "csv",
    });
    return `/api/operations/city-vrbo-inventory?${params.toString()}`;
  }, [propertyId, checkIn, checkOut]);
  const rawExportCount = data?.rawListings?.length ?? data?.sidecar?.rawCount ?? 0;

  // Feature: when a scan completes, automatically attach the two cheapest
  // same-community units IF the slots are still empty (so we never silently
  // clobber units the operator/auto-fill already attached). If no pair is
  // found, pop a "no matches" toast. The operator can still override below.
  useEffect(() => {
    if (!data || !manualScanRef.current) return;
    const sig = String(effectiveScanNonce);
    if (comboOption && comboOption.totalCost != null && comboOption.picks.length === reservation.slots.length) {
      // Auto-attach only when the booking's units are still empty, so we never
      // silently clobber units the operator already attached. Override below.
      const slotsAllEmpty = reservation.slots.every((s) => !s.buyIn);
      if (slotsAllEmpty && autoAttachSigRef.current !== sig) {
        autoAttachSigRef.current = sig;
        onAttachCombo(comboOption);
        toast({
          title: "Attached the two cheapest units",
          description: `${comboOption.label} · ${fmtMoney(comboOption.totalCost)} — both in the same community.`,
        });
      }
    } else if (!comboOption) {
      if (noMatchSigRef.current !== sig) {
        noMatchSigRef.current = sig;
        toast({
          title: "No matching pair found",
          description: `No ${bedroomPlan.map((b) => `${b}BR`).join(" + ")} pair in the same community for these dates. Pick units manually below or try other dates.`,
          variant: "destructive",
        });
      }
    }
  }, [data, comboOption, effectiveScanNonce, reservation.slots, onAttachCombo, toast, bedroomPlan]);

  // Seed the manual-override selectors from the suggested pair (then cheapest
  // available) whenever a fresh scan result arrives. Operator edits stick until
  // the next scan replaces `data`.
  useEffect(() => {
    if (!data) return;
    const defaults: Record<string, string> = {};
    const used = new Set<string>();
    for (const slot of reservation.slots) {
      const rows = (data.byBedroom[slot.bedrooms] ?? []).filter((row) => !used.has(row.url));
      const suggestedUrl = comboOption?.picks.find((p, i) =>
        comboOption.bedrooms[i] === slot.bedrooms && !used.has(p.url))?.url;
      const chosen = (suggestedUrl && rows.find((row) => row.url === suggestedUrl)) ?? rows[0];
      if (chosen) {
        defaults[slot.unitId] = chosen.url;
        used.add(chosen.url);
      }
    }
    setManualPicks(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Build an attachable combo from the operator's manual per-unit selection.
  // Returns null until every slot has a distinct, priced pick.
  const manualOption = useMemo<AutoFillComboOption | null>(() => {
    if (!data) return null;
    const nights = Math.max(1, Number(data.nights) || 1);
    const picks: AutoFillComboOption["picks"] = [];
    const seen = new Set<string>();
    for (const slot of reservation.slots) {
      const url = manualPicks[slot.unitId];
      if (!url || seen.has(url)) return null;
      seen.add(url);
      const row = (data.byBedroom[slot.bedrooms] ?? []).find((r) => r.url === url);
      if (!row) return null;
      const total = Number(row.totalPrice) > 0
        ? Math.round(Number(row.totalPrice))
        : Number(row.nightlyPrice) > 0
          ? Math.round(Number(row.nightlyPrice) * nights)
          : 0;
      if (!(total > 0)) return null;
      picks.push({
        bedrooms: slot.bedrooms,
        source: "vrbo",
        sourceLabel: row.sourceLabel ?? "Vrbo",
        title: row.title,
        totalPrice: total,
        nightlyPrice: row.nightlyPrice ?? Math.round(total / nights),
        url: row.url,
        image: row.image ?? undefined,
        images: Array.isArray(row.images) && row.images.length ? row.images : (row.image ? [row.image] : undefined),
        verified: "yes",
        verifiedReason: "Operator manually selected from city VRBO inventory",
      });
    }
    if (picks.length !== reservation.slots.length) return null;
    const totalCost = picks.reduce((sum, p) => sum + p.totalPrice, 0);
    return {
      label: `${reservation.slots.map((s) => `${s.bedrooms}BR`).join(" + ")} · manual pick`,
      bedrooms: reservation.slots.map((s) => s.bedrooms),
      totalCost,
      selected: true,
      note: "Manually selected city VRBO units",
      picks,
    };
  }, [data, manualPicks, reservation.slots]);

  return (
    <div className="rounded border border-violet-200 bg-violet-50/40 px-3 py-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold text-violet-950">City VRBO inventory</p>
          <p className="text-[10px] text-muted-foreground">
            Runs automatically after Auto-fill cheapest if resort search fails. One city destination dropdown on VRBO ({community} + dates), exports all priced cards, then match {bedroomPlan.map((b) => `${b}BR`).join(" + ")} by shared title (not separate community names).
          </p>
        </div>
        <Button
          size="sm"
          className="h-7"
          disabled={isFetching || !checkIn || !checkOut}
          onClick={() => { manualScanRef.current = true; setScanNonce((n) => Math.max(n, autoScanTrigger) + 1); }}
        >
          {isFetching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1 h-3.5 w-3.5" />}
          {isFetching ? "Scanning city VRBO…" : effectiveScanNonce > 0 ? "Re-scan city VRBO" : "Scan city VRBO"}
        </Button>
        {data && csvDownloadHref && (
          <Button size="sm" variant="outline" className="h-7" asChild>
            <a href={csvDownloadHref}>
              <Download className="mr-1 h-3.5 w-3.5" />
              CSV
            </a>
          </Button>
        )}
      </div>
      {isError && (
        <p className="mt-1 text-red-700">{(error as Error)?.message ?? "City inventory scan failed"}</p>
      )}
      {data && (
        <>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Term: {data.citySearchTerm}
            {data.fromCache ? " · cached pool" : ""}
            {data.filterPipeline
              ? ` · ${rawExportCount} exported → ${data.filterPipeline.afterNormalize} priced 2BR+` +
                (data.filterPipeline.phraseFilter
                  ? ` → ${data.filterPipeline.afterPhraseFilter} phrase`
                  : "") +
                ` · ${data.listings.length} in view`
              : ` · ${data.listings.length} listing${data.listings.length === 1 ? "" : "s"} scraped`}
            {harvest && typeof harvest.mergedCount === "number" ? ` · merged ${harvest.mergedCount}` : ""}
            {harvest && typeof harvest.graphqlPaginationStop === "string" ? ` · stop ${harvest.graphqlPaginationStop}` : ""}
          </p>
          {comboOption ? (
            <div className="mt-1 space-y-1">
              <p className="font-medium text-emerald-900">
                Cheapest same-community pair: {comboOption.label} · {fmtMoney(comboOption.totalCost)}
              </p>
              {data.suggestedPair && (
                <p className="text-[10px] text-muted-foreground">
                  Matched via {{
                    coords: "map distance",
                    dictionary: "known complex name",
                    "complex-name": "complex name + unit number",
                    "shared-phrase": "shared resort phrase",
                    photo: "shared listing photo",
                    "property-manager": "same property manager",
                    unknown: "title match",
                  }[(data.suggestedPair.matchSource ?? data.suggestedPair.walkSource) as string] ?? "title match"}
                  {data.suggestedPair.matchConfidence ? ` · ${data.suggestedPair.matchConfidence} confidence` : ""}
                  {typeof data.suggestedPair.walkMinutes === "number" ? ` · ~${data.suggestedPair.walkMinutes} min walk` : ""}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                Auto-attached when this booking's units were empty. Re-attach the cheapest pair, or override per unit below.
              </p>
              <Button
                size="sm"
                className="h-7"
                disabled={attaching}
                onClick={() => onAttachCombo(comboOption)}
              >
                {attaching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Zap className="mr-1 h-3.5 w-3.5" />}
                Re-attach cheapest pair
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-amber-900">No walkable {bedroomPlan.map((b) => `${b}BR`).join(" + ")} pair with a shared resort title for these dates.</p>
          )}
          {/* Manual override — operator picks the specific listing for each unit
              slot (e.g. the 3BR and the 2BR), then attaches that custom pair. */}
          {data.listings.length > 0 && reservation.slots.length >= 2 && (
            <div className="mt-2 rounded border border-violet-200 bg-white/70 p-2">
              <p className="text-[10px] font-semibold text-violet-950">Override — pick a unit for each slot</p>
              <div className="mt-1 space-y-1.5">
                {reservation.slots.map((slot) => {
                  const rows = data.byBedroom[slot.bedrooms] ?? [];
                  const chosenElsewhere = new Set(
                    reservation.slots
                      .filter((s) => s.unitId !== slot.unitId)
                      .map((s) => manualPicks[s.unitId])
                      .filter(Boolean),
                  );
                  return (
                    <div key={slot.unitId} className="flex items-center gap-2">
                      <span className="w-24 shrink-0 text-[10px] font-medium text-slate-700">
                        {slot.unitLabel} · {slot.bedrooms}BR
                      </span>
                      <select
                        className="h-7 min-w-0 flex-1 rounded border border-slate-300 bg-white px-1 text-[11px]"
                        value={manualPicks[slot.unitId] ?? ""}
                        onChange={(e) => setManualPicks((prev) => ({ ...prev, [slot.unitId]: e.target.value }))}
                        data-testid={`select-city-override-${reservation._id}-${slot.unitId}`}
                      >
                        <option value="">— choose a {slot.bedrooms}BR unit ({rows.length}) —</option>
                        {rows.map((row) => (
                          <option key={row.url} value={row.url} disabled={chosenElsewhere.has(row.url)}>
                            {fmtMoney(row.totalPrice || row.nightlyPrice)} · {row.title}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={!manualOption || attaching}
                  onClick={() => manualOption && onAttachCombo(manualOption)}
                  data-testid={`button-attach-city-override-${reservation._id}`}
                >
                  {attaching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Zap className="mr-1 h-3.5 w-3.5" />}
                  Attach selected units
                </Button>
                {manualOption ? (
                  <span className="text-[10px] text-emerald-900">{fmtMoney(manualOption.totalCost)} total</span>
                ) : (
                  <span className="text-[10px] text-amber-800">Choose a different unit for each slot.</span>
                )}
              </div>
            </div>
          )}
          {bedroomGroups.length > 0 && (
            <div className="mt-1 max-h-32 space-y-1 overflow-y-auto">
              {bedroomGroups.map(([bedrooms, rows]) => (
                <div key={bedrooms}>
                  <p className="text-[10px] font-semibold text-slate-700">{bedrooms}BR ({rows.length})</p>
                  {rows.slice(0, 6).map((row) => (
                    <a
                      key={row.url}
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sky-800 underline underline-offset-2"
                      title={row.title}
                    >
                      {fmtMoney(row.totalPrice || row.nightlyPrice)} · {row.title}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function candidateWalkMinutes(a: Pick<LiveCandidate, "lat" | "lng">, b: Pick<LiveCandidate, "lat" | "lng">): number | null {
  const aLat = Number(a.lat);
  const aLng = Number(a.lng);
  const bLat = Number(b.lat);
  const bLng = Number(b.lng);
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return null;
  return walkMinutesFromFeet(haversineFeet(aLat, aLng, bLat, bLng));
}

function alternativePicksAreWalkable(picks: Array<Pick<LiveCandidate, "lat" | "lng">>): boolean {
  if (picks.length < 2) return true;
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const minutes = candidateWalkMinutes(picks[i], picks[j]);
      if (minutes === null || minutes > MAX_BUY_IN_WALK_MINUTES) return false;
    }
  }
  return true;
}

function candidateIsWalkableWithExistingPicks(
  candidate: Pick<LiveCandidate, "lat" | "lng" | "title" | "sourceLabel">,
  picks: Array<Pick<LiveCandidate, "lat" | "lng" | "title" | "sourceLabel">>,
): boolean {
  for (const pick of picks) {
    if (candidatesShareStrongResortPhrase(candidate, pick)) continue;
    const minutes = candidateWalkMinutes(candidate, pick);
    if (minutes !== null) {
      if (minutes > MAX_BUY_IN_WALK_MINUTES) return false;
      continue;
    }
    return false;
  }
  return true;
}


function UnitTypeConfidenceBadge({ confidence }: { confidence?: number | null }) {
  if (typeof confidence !== "number") return null;
  const color = confidence >= 85 ? "emerald" : confidence >= 70 ? "amber" : "rose";
  return (
    <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded bg-${color}-100 text-${color}-700 font-mono`}>
      {confidence}% unit type
    </span>
  );
}

type ForceDialogState = {
  reservationId: string;
  buyInId: number;
  confidence: number | null;
  threshold: number;
  bedrooms?: number | null;
  community?: string | null;
  message: string;
};

function ForceAttachConfirmDialog({
  open,
  onOpenChange,
  state,
  onConfirm,
  confirming,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  state: ForceDialogState | null;
  onConfirm: (note: string) => void;
  confirming?: boolean;
}) {
  const [note, setNote] = useState("");
  const canConfirm = note.trim().length >= 10;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Force attach below threshold?</DialogTitle>
          <DialogDescription>
            This buy-in has unit-type confidence {state?.confidence ?? "?"}% (threshold {state?.threshold ?? 85}%).
            For combo properties this gate exists to ensure the unit is the correct bedroom count in the right sub-community (e.g. Regency Poipu Kai vs Pili Mai).
            Only proceed with a clear manual verification note for the audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="force-audit-note" className="text-xs">Audit note (required, ≥10 chars)</Label>
          <Textarea
            id="force-audit-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Manually confirmed via VRP direct quote + Poipu Kai resort page; exact 3BR Regency Bldg 7 unit, not adjacent complex. Operator visual match on floorplan + address."
            rows={4}
            className="text-xs"
          />
          <p className="text-[10px] text-muted-foreground">This note will be appended to the buy-in record for audit.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setNote(""); onOpenChange(false); }} disabled={confirming}>Cancel</Button>
          <Button
            onClick={() => onConfirm(note.trim())}
            disabled={!canConfirm || confirming}
          >
            {confirming ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Force attach + log override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


type TwoUnitBedroomCombo = { bedrooms: number[] };

type AutoFillGroundCandidatePool = {
  bedrooms: number;
  candidates: LiveCandidate[];
};

function twoUnitBedroomCombos(totalNeeded: number, preferredBedrooms: number[]): TwoUnitBedroomCombo[] {
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
  addCombo(preferredBedrooms);
  const minLegBedrooms = totalNeeded >= 4 ? 2 : 1;
  for (let high = totalNeeded - minLegBedrooms; high >= Math.ceil(totalNeeded / 2); high--) {
    const low = totalNeeded - high;
    if (low < minLegBedrooms) continue;
    addCombo([high, low]);
  }
  return combos;
}

function isGroundFloorPick(candidate: LiveCandidate | null | undefined): boolean {
  return candidate?.groundFloorStatus === "confirmed";
}

function pickCheapestSetWithGroundFloor(
  pools: AutoFillGroundCandidatePool[],
  requiredCount: number,
  usedSeed: Set<string>,
  requiredIndexes?: Set<number>,
): { picks: Array<LiveCandidate | null>; reason?: string } {
  const used = new Set(usedSeed);
  const picks = pools.map((pool) => {
    const pick = pool.candidates.find((c) => !hasUsedListingIdentity(used, c)) ?? null;
    if (pick) addUsedListingIdentity(used, pick);
    return pick;
  });
  const requirementMet = () => {
    if (requiredIndexes?.size) {
      return Array.from(requiredIndexes).every((index) => isGroundFloorPick(picks[index]));
    }
    return picks.filter(isGroundFloorPick).length >= requiredCount;
  };
  if (requiredCount <= 0 || requirementMet()) {
    return { picks };
  }

  for (let guard = 0; guard < pools.length && !requirementMet(); guard++) {
    let bestSwap: { index: number; candidate: LiveCandidate; delta: number } | null = null;
    for (let i = 0; i < pools.length; i++) {
      if (requiredIndexes?.size && !requiredIndexes.has(i)) continue;
      if (isGroundFloorPick(picks[i])) continue;
      const otherUsed = new Set(usedSeed);
      picks.forEach((existing, index) => {
        if (existing && index !== i) addUsedListingIdentity(otherUsed, existing);
      });
      const candidate = pools[i].candidates.find((c) => c.groundFloorStatus === "confirmed" && !hasUsedListingIdentity(otherUsed, c));
      if (!candidate) continue;
      const currentTotal = picks[i]?.totalPrice ?? 0;
      const delta = candidate.totalPrice - currentTotal;
      if (!bestSwap || delta < bestSwap.delta) bestSwap = { index: i, candidate, delta };
    }
    if (!bestSwap) break;
    picks[bestSwap.index] = bestSwap.candidate;
  }

  const found = requiredIndexes?.size
    ? Array.from(requiredIndexes).filter((index) => isGroundFloorPick(picks[index])).length
    : picks.filter(isGroundFloorPick).length;
  if (!requirementMet()) {
    const targetLabel = requiredIndexes?.size
      ? ` for the required ${Array.from(requiredIndexes).map((index) => `${pools[index]?.bedrooms ?? "?"}BR`).join(" + ")} slot${requiredIndexes.size === 1 ? "" : "s"}`
      : "";
    return {
      picks,
      reason: `Only ${found} confirmed ground-floor option${found === 1 ? "" : "s"} found${targetLabel}; ${requiredCount} required by guest messages`,
    };
  }
  return { picks };
}

type BuyInSearchProviderKey = keyof AutoFillSearchSummary["sourceCounts"];
type FindBuyInDiagnosticSource = NonNullable<FindBuyInDiagnostics["sources"]>[number];

const BUY_IN_SEARCH_PROVIDER_CONFIG: Array<{
  key: BuyInSearchProviderKey;
  label: string;
  diagnosticName: RegExp;
}> = [
  { key: "airbnb", label: "Airbnb", diagnosticName: /^Airbnb$/i },
  { key: "vrbo", label: "VRBO", diagnosticName: /^Vrbo$/i },
  { key: "pm", label: "Direct/Lens", diagnosticName: /Airbnb Lens direct links|Direct/i },
];

const BUY_IN_OTA_PROVIDER_KEYS = ["airbnb", "vrbo"] as const satisfies BuyInSearchProviderKey[];

function metricNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pluralizeRows(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function compactDiagnosticMessage(value: string | undefined): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

function findBuyInDiagnosticSource(
  diagnostics: FindBuyInDiagnostics | undefined,
  key: BuyInSearchProviderKey,
): FindBuyInDiagnosticSource | undefined {
  const config = BUY_IN_SEARCH_PROVIDER_CONFIG.find((provider) => provider.key === key);
  if (!config) return undefined;
  return diagnostics?.sources?.find((source) => config.diagnosticName.test(source.source));
}

function buyInProviderStats(
  summary: AutoFillSearchSummary,
  diagnostics: FindBuyInDiagnostics | undefined,
  key: BuyInSearchProviderKey,
) {
  const diagnostic = findBuyInDiagnosticSource(diagnostics, key);
  const fallbackScanned = summary.sourceCounts[key] ?? 0;
  const keptFallback = diagnostic ? 0 : fallbackScanned;
  return {
    diagnostic,
    searched: diagnostic?.searched === true || /\bsidecarOnline=true\b/i.test(String(diagnostic?.message ?? "")),
    raw: metricNumber(diagnostic?.raw ?? fallbackScanned),
    kept: metricNumber(diagnostic?.kept ?? keptFallback),
    priced: metricNumber(diagnostic?.priced ?? 0),
    verified: metricNumber(diagnostic?.verified ?? 0),
    status: diagnostic?.status ?? (fallbackScanned > 0 ? "warning" : "skipped"),
  };
}

function buyInProviderSearchStatus(
  summary: AutoFillSearchSummary,
  diagnostics: FindBuyInDiagnostics | undefined,
  key: BuyInSearchProviderKey,
) {
  const config = BUY_IN_SEARCH_PROVIDER_CONFIG.find((provider) => provider.key === key)!;
  const stats = buyInProviderStats(summary, diagnostics, key);
  const hardFailed = stats.status === "error"
    || stats.status === "timeout"
    || /setDownloadBehavior|context management is not supported/i.test(
      `${stats.diagnostic?.failureReason ?? ""} ${stats.diagnostic?.reason ?? ""} ${stats.diagnostic?.message ?? ""}`,
    );
  const searched = stats.searched || stats.raw > 0;
  const passed = !hardFailed && stats.status === "ok" && searched && stats.raw > 0;
  const warned = !passed && !hardFailed && searched;
  const message = compactDiagnosticMessage(stats.diagnostic?.message);
  const failureReason = compactDiagnosticMessage(stats.diagnostic?.failureReason ?? undefined);
  const providerHealth = stats.diagnostic?.providerHealth || stats.diagnostic?.proxyHealth || null;
  const confidence = stats.diagnostic?.confidence || null;
  const retryAfterMs = stats.diagnostic?.retryAfterMs;
  const cooldownUntil = stats.diagnostic?.cooldownUntil;
  const searchTerm = stats.diagnostic?.searchTerm;
  const accessPattern = stats.diagnostic?.accessPattern;
  const dateLabel = stats.diagnostic?.datesSearched?.checkIn && stats.diagnostic?.datesSearched?.checkOut
    ? `${stats.diagnostic.datesSearched.checkIn} -> ${stats.diagnostic.datesSearched.checkOut}`
    : null;
  const bedroomFilterMode = stats.diagnostic?.bedroomFilter?.mode;
  const bedroomLabel = typeof stats.diagnostic?.bedroomFilter?.bedrooms === "number"
    ? stats.diagnostic.bedroomFilter.applied
      ? `${stats.diagnostic.bedroomFilter.bedrooms}BR filter applied`
      : `${stats.diagnostic.bedroomFilter.bedrooms}BR ${bedroomFilterMode || "server-side curation"}`
    : null;
  let reason: string;
  if (passed) {
    reason = stats.priced > 0
      ? `${pluralizeRows(stats.priced, "priced row")} returned`
      : `${pluralizeRows(stats.raw, "row")} returned`;
  } else if (hardFailed) {
    reason = failureReason || (stats.status === "timeout" ? "Timed out" : "Search failed");
  } else if (!searched) {
    reason = "Search did not complete";
  } else if (stats.raw === 0) {
    reason = "Search completed; no rows returned";
  } else if (stats.kept === 0) {
    reason = "Rows failed community/bedroom/date filters";
  } else if (stats.priced === 0) {
    reason = "Rows returned without live prices";
  } else {
    reason = `${stats.status} status`;
  }
  return {
    config,
    stats,
    passed,
    warned,
    hardFailed,
    reason,
    message,
    failureReason,
    providerHealth,
    confidence,
    retryAfterMs,
    cooldownUntil,
    searchTerm,
    accessPattern,
    dateLabel,
    bedroomLabel,
  };
}

function ProviderSearchStatusStrip({ audit }: { audit: AutoFillSearchAudit }) {
  const request = audit.diagnostics?.request;
  const dateLabel = request?.checkIn && request?.checkOut ? `${request.checkIn} -> ${request.checkOut}` : null;
  const locationLabel = request?.resortName || request?.community || null;
  return (
    <div className="border-b bg-slate-50/70 px-2 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        <span className="font-semibold uppercase tracking-wide text-slate-700">Provider status</span>
        {locationLabel && <span>{locationLabel}</span>}
        {dateLabel && <span>{dateLabel}</span>}
        {typeof audit.diagnostics?.elapsedMs === "number" && (
          <span>{Math.round(audit.diagnostics.elapsedMs / 1000)}s total</span>
        )}
      </div>
      <div className="grid gap-1.5 md:grid-cols-3">
        {BUY_IN_OTA_PROVIDER_KEYS.map((key) => {
          const status = buyInProviderSearchStatus(audit.counts, audit.diagnostics, key);
          const iconClass = status.passed
            ? "text-emerald-700"
            : status.warned
              ? "text-amber-700"
              : "text-red-700";
          const boxClass = status.passed
            ? "border-emerald-200 bg-emerald-50 text-emerald-950"
            : status.warned
            ? "border-amber-200 bg-amber-50 text-amber-950"
            : "border-red-200 bg-red-50 text-red-950";
          const retryLabel = typeof status.retryAfterMs === "number" && status.retryAfterMs > 0
            ? `retry in ${Math.ceil(status.retryAfterMs / 60000)}m`
            : status.cooldownUntil
              ? `retry after ${status.cooldownUntil}`
              : null;
          return (
            <div key={`${audit.bedrooms}-${key}-provider-status`} className={`rounded border px-2 py-1.5 ${boxClass}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {status.passed ? (
                    <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                  ) : status.warned ? (
                    <AlertCircle className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                  ) : (
                    <XCircle className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                  )}
                  <span className="truncate text-[11px] font-semibold">{status.config.label}</span>
                </div>
                <span className="shrink-0 text-[9px] uppercase tracking-wide">{status.passed ? "pass" : status.warned ? "warn" : "fail"}</span>
              </div>
              <p className="mt-0.5 text-[10px]">{status.reason}</p>
              <p className="mt-0.5 text-[10px] opacity-80">
                raw {status.stats.raw} · kept {status.stats.kept} · priced {status.stats.priced} · verified {status.stats.verified}
                {typeof status.stats.diagnostic?.durationMs === "number"
                  ? ` · ${Math.round(status.stats.diagnostic.durationMs / 1000)}s`
                  : ""}
                {status.confidence ? ` · confidence ${status.confidence}` : ""}
              </p>
              {(status.providerHealth || retryLabel) && (
                <p className="mt-0.5 text-[10px] opacity-80">
                  {status.providerHealth ? `provider ${status.providerHealth}` : ""}
                  {status.providerHealth && retryLabel ? " · " : ""}
                  {retryLabel ?? ""}
                </p>
              )}
              {(status.dateLabel || status.bedroomLabel || status.searchTerm) && (
                <p className="mt-0.5 line-clamp-2 text-[10px] opacity-75">
                  {[status.dateLabel, status.bedroomLabel, status.searchTerm ? `query ${status.searchTerm}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {status.stats.diagnostic?.searchVariationSummary?.tried?.length ? (
                <p className="mt-0.5 line-clamp-2 text-[10px] opacity-75">
                  variations {status.stats.diagnostic.searchVariationSummary.tried.length}
                  {status.stats.diagnostic.searchVariationSummary.bestTerm
                    ? ` · best ${status.stats.diagnostic.searchVariationSummary.bestTerm} (${status.stats.diagnostic.searchVariationSummary.bestYieldCount})`
                    : ""}
                </p>
              ) : null}
              {status.accessPattern && (
                <p className="mt-0.5 line-clamp-2 text-[10px] opacity-75">{status.accessPattern}</p>
              )}
              {status.message && (
                <p className="mt-0.5 line-clamp-2 text-[10px] opacity-75">{status.message}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BuyInSearchConfirmationDialog({
  open,
  onOpenChange,
  payload,
  onViewDiagnostics,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: BuyInSearchConfirmationPayload | null;
  onViewDiagnostics?: (diagnostics: FindBuyInDiagnostics) => void;
}) {
  if (!payload) return null;
  const providerRows = payload.audits.flatMap((audit, auditIndex) => (
    BUY_IN_OTA_PROVIDER_KEYS.map((key) => {
      const status = buyInProviderSearchStatus(audit.counts, audit.diagnostics, key);
      const diagnostic = status.stats.diagnostic;
      const request = audit.diagnostics?.request;
      const dates = diagnostic?.datesSearched ?? request;
      const datesLabel = dates?.checkIn && dates?.checkOut
        ? `${dates.checkIn} -> ${dates.checkOut}`
        : "Not reported";
      const locationLabel = status.searchTerm || request?.resortName || request?.community || "Not reported";
      const resultCounts = diagnostic?.resultCounts ?? {
        raw: status.stats.raw,
        kept: status.stats.kept,
        priced: status.stats.priced,
        verified: status.stats.verified,
      };
      const variationSummary = diagnostic?.searchVariationSummary ?? null;
      const variationLabel = variationSummary?.tried?.length
        ? variationSummary.tried
          .slice(0, 5)
          .map((attempt) => `${attempt.term}${attempt.candidateCount ? ` (${attempt.candidateCount})` : ""}`)
          .join(" · ")
        : null;
      return {
        key: `${audit.generatedAt}-${audit.bedrooms}-${auditIndex}-${key}`,
        audit,
        status,
        datesLabel,
        locationLabel,
        resultCounts,
        variationLabel,
      };
    })
  ));
  const totalIssues = payload.audits.reduce((sum, audit) => sum + (audit.diagnostics?.issues?.length ?? 0), 0);
  const generatedTimes = payload.audits
    .map((audit) => audit.diagnostics?.generatedAt ?? audit.generatedAt)
    .filter(Boolean)
    .sort();
  const latestGeneratedAt = generatedTimes[generatedTimes.length - 1];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{payload.title}</DialogTitle>
          <DialogDescription>
            {payload.description ?? "Provider search confirmation for the completed buy-in run."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded border bg-muted/30 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Search groups</p>
              <p className="mt-0.5 font-semibold">{payload.audits.length}</p>
            </div>
            <div className="rounded border bg-muted/30 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Provider checks</p>
              <p className="mt-0.5 font-semibold">{providerRows.length}</p>
            </div>
            <div className="rounded border bg-muted/30 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Completed</p>
              <p className="mt-0.5 font-semibold">{latestGeneratedAt ? new Date(latestGeneratedAt).toLocaleString() : "Now"}</p>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto rounded-md border">
            <div className="grid grid-cols-[110px_1fr] gap-0 border-b bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid-cols-[110px_150px_1.2fr_1fr_1fr]">
              <span>Website</span>
              <span className="hidden sm:block">Status</span>
              <span>Dates searched</span>
              <span className="hidden sm:block">Location name search</span>
              <span className="hidden sm:block">Counts</span>
            </div>
            {providerRows.map((row) => {
              const boxClass = row.status.passed
                ? "text-emerald-700"
                : row.status.warned
                ? "text-amber-700"
                : "text-red-700";
              return (
                <div
                  key={row.key}
                  className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 border-b px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[110px_150px_1.2fr_1fr_1fr]"
                >
                  <div className="font-semibold">{row.status.config.label}</div>
                  <div className={`hidden font-medium sm:flex sm:items-center sm:gap-1.5 ${boxClass}`}>
                    {row.status.passed ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : row.status.warned ? (
                      <AlertCircle className="h-3.5 w-3.5" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" />
                    )}
                    {row.status.passed ? "Confirmed" : row.status.warned ? "Warning" : "Failed"}
                  </div>
                  <div>
                    <span className="font-medium sm:hidden">Dates searched: </span>
                    {row.datesLabel}
                  </div>
                  <div className="col-span-2 min-w-0 break-words sm:col-span-1">
                    <span className="font-medium sm:hidden">Location name search: </span>
                    {row.locationLabel}
                  </div>
                  <div className="col-span-2 text-[11px] text-muted-foreground sm:col-span-1">
                    raw {row.resultCounts.raw ?? 0} · kept {row.resultCounts.kept ?? 0} · priced {row.resultCounts.priced ?? 0} · verified {row.resultCounts.verified ?? 0}
                    {typeof row.status.stats.diagnostic?.durationMs === "number"
                      ? ` · ${Math.round(row.status.stats.diagnostic.durationMs / 1000)}s`
                      : ""}
                  </div>
                  {(row.status.reason || row.status.failureReason) && (
                    <div className="col-span-2 text-[11px] text-muted-foreground sm:col-start-2 sm:col-span-4">
                      {row.status.failureReason || row.status.reason}
                    </div>
                  )}
                  {row.variationLabel && (
                    <div className="col-span-2 text-[11px] text-muted-foreground sm:col-start-2 sm:col-span-4">
                      Dropdown variations: {row.variationLabel}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {totalIssues > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
              {totalIssues} diagnostic item{totalIssues === 1 ? "" : "s"} were recorded. Use the detailed log for the full reason trail.
            </div>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="text-[11px] text-muted-foreground">
            Confirmation is based on the completed `/api/operations/find-buy-in` diagnostics.
          </div>
          <div className="flex gap-2">
            {payload.audits[0]?.diagnostics && onViewDiagnostics && (
              <Button
                type="button"
                variant="outline"
                onClick={() => onViewDiagnostics(payload.audits[0].diagnostics!)}
              >
                <FileText className="mr-1 h-3.5 w-3.5" />
                Detailed log
              </Button>
            )}
            <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBuyInProviderAvailability(
  summary: AutoFillSearchSummary,
  diagnostics: FindBuyInDiagnostics | undefined,
  bedrooms: number,
  key: BuyInSearchProviderKey,
): string {
  const config = BUY_IN_SEARCH_PROVIDER_CONFIG.find((provider) => provider.key === key)!;
  const stats = buyInProviderStats(summary, diagnostics, key);
  const message = compactDiagnosticMessage(stats.diagnostic?.message);
  const countSuffix = `raw ${stats.raw}, kept ${stats.kept}, priced ${stats.priced}, verified ${stats.verified}`;
  let lead: string;
  if (stats.verified > 0) {
    lead = `${config.label}: ${pluralizeRows(stats.verified, "verified bookable row")} for ${bedrooms}BR.`;
  } else if (stats.priced > 0) {
    lead = `${config.label}: ${pluralizeRows(stats.priced, "priced row")} for ${bedrooms}BR, but 0 verified bookable rows.`;
  } else if (stats.kept > 0) {
    lead = `${config.label}: ${pluralizeRows(stats.kept, "target-matching row")} for ${bedrooms}BR, but no live price.`;
  } else if (stats.raw > 0) {
    lead = `${config.label}: ${pluralizeRows(stats.raw, "raw row")} seen, but 0 survived the resort/bedroom/date filters for ${bedrooms}BR.`;
  } else {
    lead = `${config.label}: no ${bedrooms}BR rows were visible to this search.`;
  }
  return `${lead} (${stats.status}; ${countSuffix})${message ? ` ${message}` : ""}`;
}

function liveSearchSummaryFor(data: FindBuyInResponse, searchedBedrooms: number): AutoFillSearchSummary {
  const rawCounts = data.debug?.rawCounts ?? {};
  const rawSourceCounts = {
    airbnb: Number(rawCounts.airbnbWebsiteSidecar ?? rawCounts.airbnb ?? 0) || 0,
    vrbo: Number(rawCounts.vrbo ?? 0) || 0,
    booking: 0,
    pm: Number(rawCounts.pmFromWebsiteSidecar ?? rawCounts.pmWebsiteSidecarRaw ?? rawCounts.pm ?? 0) || 0,
  };
  const sourceCounts = {
    airbnb: data.sources?.airbnb?.length ?? 0,
    vrbo: data.sources?.vrboAll?.length ?? data.sources?.vrbo?.length ?? 0,
    booking: 0,
    pm: data.sources?.pm?.length ?? 0,
  };
  const allSourceCandidates = [
    ...(data.sources?.airbnb ?? []),
    ...(data.sources?.vrbo ?? []),
    ...(data.sources?.pm ?? []),
  ];
  const targetFilter = data.debug?.dropped?.targetFilter ?? {};
  const targetFiltered = Object.values(targetFilter).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const scannedSourceCounts = {
    airbnb: Math.max(sourceCounts.airbnb, rawSourceCounts.airbnb),
    vrbo: Math.max(sourceCounts.vrbo, rawSourceCounts.vrbo),
    booking: 0,
    pm: Math.max(sourceCounts.pm, rawSourceCounts.pm),
  };
  const scanned = Object.values(scannedSourceCounts).reduce((sum, value) => sum + value, 0);
  return {
    bedrooms: searchedBedrooms,
    scanned: Math.max(scanned, allSourceCandidates.length),
    priced: typeof data.totalPricedResults === "number"
      ? data.totalPricedResults
      : allSourceCandidates.filter((c) => c.totalPrice > 0).length,
    sourceCounts: scannedSourceCounts,
    kept: allSourceCandidates.length,
    targetFiltered,
    groundFloorOnly: !!data.groundFloorOnly,
  };
}

function buyInSearchAvailabilityDetails(
  summary: AutoFillSearchSummary,
  diagnostics: FindBuyInDiagnostics | undefined,
  bedrooms: number,
  opts: { onlyUnavailable?: boolean; includeIssues?: boolean } = {},
): string[] {
  const providerLines = BUY_IN_SEARCH_PROVIDER_CONFIG
    .filter((provider) => {
      if (!opts.onlyUnavailable) return true;
      return buyInProviderStats(summary, diagnostics, provider.key).verified === 0;
    })
    .map((provider) => formatBuyInProviderAvailability(summary, diagnostics, bedrooms, provider.key));

  const issueLines = opts.includeIssues === false
    ? []
    : (diagnostics?.issues ?? []).slice(0, 4).map((issue) =>
      `${issue.source}: ${issue.summary}${issue.detail ? ` (${compactDiagnosticMessage(issue.detail)})` : ""}`,
    );

  return [...providerLines, ...issueLines].filter(Boolean).slice(0, 8);
}

function buyInPoolUnavailableReason(
  summary: AutoFillSearchSummary,
  diagnostics: FindBuyInDiagnostics | undefined,
  bedrooms: number,
): string {
  const verifiedTotal = BUY_IN_SEARCH_PROVIDER_CONFIG.reduce(
    (sum, provider) => sum + buyInProviderStats(summary, diagnostics, provider.key).verified,
    0,
  );
  const pricedTotal = BUY_IN_SEARCH_PROVIDER_CONFIG.reduce(
    (sum, provider) => sum + buyInProviderStats(summary, diagnostics, provider.key).priced,
    0,
  );
  if (verifiedTotal === 0) {
    return `No verified available ${bedrooms}BR option on Airbnb, VRBO, or direct/Lens`;
  }
  if (pricedTotal === 0) {
    return `No live-priced ${bedrooms}BR option on Airbnb, VRBO, or direct/Lens`;
  }
  return `No unused distinct ${bedrooms}BR option remained after duplicate-unit filtering`;
}

function buyInCancellationTier(score: number): BuyInCancellationTier {
  if (score >= 95) return "cancel";
  if (score >= 85) return "strong_cancel";
  if (score >= 70) return "consider_cancel";
  if (score >= 50) return "watch";
  return "do_not_cancel";
}


function countAttachableBuyInCandidates(audits: AutoFillSearchAudit[]): number {
  return audits.flatMap((audit) => audit.candidates).filter((candidate) => {
    if (candidate.verified !== "yes") return false;
    if (candidate.source === "airbnb") return false;
    return true;
  }).length;
}

function providerSidecarProtocolFailed(status: ReturnType<typeof buyInProviderSearchStatus>): boolean {
  const hay = `${status.failureReason ?? ""} ${status.message ?? ""} ${status.stats.diagnostic?.reason ?? ""}`;
  return /setDownloadBehavior|context management is not supported/i.test(hay);
}

function buyInCancellationTitle(tier: BuyInCancellationTier): string {
  switch (tier) {
    case "cancel": return "Cancel likely justified";
    case "strong_cancel": return "Strong cancel signal";
    case "consider_cancel": return "Consider canceling";
    case "watch": return "Manual review needed";
    default: return "Do not cancel from this scan";
  }
}

function capBuyInCancellationScore(score: number, cap: number): number {
  return Math.min(score, cap);
}

function buyInCancellationAdviceClass(tier: BuyInCancellationTier): string {
  switch (tier) {
    case "cancel":
    case "strong_cancel":
      return "border-red-300 bg-red-50 text-red-950";
    case "consider_cancel":
      return "border-orange-300 bg-orange-50 text-orange-950";
    case "watch":
      return "border-amber-300 bg-amber-50 text-amber-950";
    default:
      return "border-emerald-200 bg-emerald-50 text-emerald-950";
  }
}

function buyInCancellationScoreFromLoss(projectedProfit: number, remainingBudget: number): number {
  if (projectedProfit >= 500) return 20;
  if (projectedProfit >= 200) return 30;
  if (projectedProfit >= 0) return 45;
  const loss = Math.abs(projectedProfit);
  const lossRatio = remainingBudget > 0 ? loss / remainingBudget : 1;
  if (loss >= 1500 || lossRatio >= 0.35) return 98;
  if (loss >= 750 || lossRatio >= 0.2) return 92;
  if (loss >= 250 || lossRatio >= 0.08) return 82;
  return 68;
}

function buildBuyInCancellationAdvice(args: {
  reservation: GuestyReservation;
  audits: AutoFillSearchAudit[];
  proposedCost?: number | null;
  currentSlotId?: string;
  noCompleteCombo?: boolean;
  attachableVerifiedCount?: number;
}): BuyInCancellationAdvice | null {
  const audits = args.audits.filter(Boolean);
  if (audits.length === 0) return null;

  const providerStatuses = audits.flatMap((audit) =>
    BUY_IN_OTA_PROVIDER_KEYS.map((key) => ({ key, status: buyInProviderSearchStatus(audit.counts, audit.diagnostics, key) })),
  );
  const providerWasSearched = (key: BuyInSearchProviderKey) => providerStatuses.some(({ key: providerKey, status }) =>
    providerKey === key && (status.stats.searched || status.stats.raw > 0 || status.stats.status === "ok" || status.stats.status === "warning"),
  );
  const providerHardFailed = (key: BuyInSearchProviderKey) => providerStatuses.some(({ key: providerKey, status }) =>
    providerKey === key && status.hardFailed,
  );
  const providerClean = (key: BuyInSearchProviderKey) => providerStatuses.some(({ key: providerKey, status }) =>
    providerKey === key
    && status.stats.searched
    && status.stats.status === "ok"
    && !status.hardFailed
    && !providerSidecarProtocolFailed(status),
  );
  const providersSearched = BUY_IN_OTA_PROVIDER_KEYS.filter(providerWasSearched).length;
  const providersClean = BUY_IN_OTA_PROVIDER_KEYS.filter(providerClean).length;
  const providersHardFailed = BUY_IN_OTA_PROVIDER_KEYS.filter(providerHardFailed).length;
  const providerVerifiedCount = providerStatuses.reduce((sum, { status }) => sum + status.stats.verified, 0);
  const attachableVerifiedCount = args.attachableVerifiedCount ?? countAttachableBuyInCandidates(audits);
  const verifiedCount = attachableVerifiedCount;
  const pricedCount = providerStatuses.reduce((sum, { status }) => sum + status.stats.priced, 0);
  const diagnosticsHardError = audits.some((audit) => audit.diagnostics?.severity === "error");
  const completedEnough = providersClean >= 2 && providersHardFailed === 0 && !diagnosticsHardError;
  const confidence: BuyInCancellationAdvice["confidence"] = completedEnough && providersClean >= 3
    ? "high"
    : completedEnough
      ? "medium"
      : "low";

  const candidateCost = args.noCompleteCombo
    ? null
    : args.proposedCost && args.proposedCost > 0
      ? args.proposedCost
      : attachableVerifiedCount > 0
        ? audits
          .flatMap((audit) => audit.candidates)
          .filter((candidate) => candidate.verified === "yes" && candidate.source !== "airbnb")
          .map((candidate) => candidate.totalPrice)
          .filter((price) => Number.isFinite(price) && price > 0)
          .sort((a, b) => a - b)[0] ?? null
        : null;

  const existingCost = args.reservation.slots.reduce((sum, slot) => {
    if (args.currentSlotId && slot.unitId === args.currentSlotId) return sum;
    return sum + parseFloat(String(slot.buyIn?.costPaid ?? 0));
  }, 0);
  const remainingBudget = getNetRevenue(args.reservation) - existingCost;
  const projectedProfit = candidateCost != null ? remainingBudget - candidateCost : null;

  let score: number;
  let summary: string;
  let basis: BuyInCancellationAdvice["basis"];
  const evidence: string[] = [];

  if (candidateCost == null || verifiedCount === 0 || args.noCompleteCombo) {
    basis = completedEnough ? "no_inventory" : "insufficient_coverage";
    score = providersClean >= 3 && providersHardFailed === 0 ? 84 : providersClean >= 2 && providersHardFailed === 0 ? 68 : 45;
    if (args.noCompleteCombo) {
      score = Math.max(score, providersClean >= 2 ? 78 : 68);
    }
    summary = args.noCompleteCombo
      ? "No complete two-unit buy-in combination was verified for this resort and stay. Consider canceling after scouting nearby communities or re-running per-slot searches."
      : providersClean >= 3
        ? "All three OTA checks completed cleanly and found no attachable bookable inventory. Treat this as a strong warning, then re-run or manually confirm before canceling."
        : completedEnough
          ? "No attachable bookable inventory was kept, but only two OTA checks completed cleanly. Treat this as manual-review evidence, not a cancel decision."
          : "No attachable bookable inventory was kept, and provider coverage was not strong enough for a cancellation call.";
    evidence.push(`${verifiedCount} attachable verified row${verifiedCount === 1 ? "" : "s"} across ${providersClean}/3 clean OTA provider checks (${providersSearched}/3 searched).`);
    if (providerVerifiedCount > verifiedCount) {
      evidence.push(`${providerVerifiedCount - verifiedCount} additional Airbnb-priced row${providerVerifiedCount - verifiedCount === 1 ? "" : "s"} could not be attached without a direct booking link.`);
    }
    if (pricedCount > 0) {
      evidence.push(`${pricedCount} priced row${pricedCount === 1 ? "" : "s"} appeared, but none survived attachable verification/identity checks.`);
    }
  } else {
    basis = "verified_cost";
    score = buyInCancellationScoreFromLoss(projectedProfit ?? 0, remainingBudget);
    if (confidence === "low") score = capBuyInCancellationScore(score, 69);
    if (confidence === "medium") score = capBuyInCancellationScore(score, 84);
    summary = projectedProfit != null && projectedProfit < 0
      ? `Cheapest verified buy-in is ${fmtMoney(candidateCost)}, leaving a projected loss of ${fmtMoney(Math.abs(projectedProfit))}.`
      : projectedProfit != null && projectedProfit < 200
        ? `Cheapest verified buy-in is ${fmtMoney(candidateCost)}, leaving only ${fmtMoney(projectedProfit)} projected margin.`
        : `Cheapest verified buy-in is ${fmtMoney(candidateCost)}, leaving ${fmtMoney(projectedProfit ?? 0)} projected margin.`;
    evidence.push(`Remaining booking budget after attached buy-ins: ${fmtMoney(remainingBudget)}.`);
    evidence.push(`Cheapest verified buy-in found: ${fmtMoney(candidateCost)}.`);
  }

  if (providersHardFailed > 0) {
    score = capBuyInCancellationScore(score, basis === "verified_cost" ? 69 : 45);
    evidence.push(`${providersHardFailed} provider check${providersHardFailed === 1 ? "" : "s"} failed or timed out, so the score is capped.`);
  }
  if (providersClean < 3) {
    evidence.push(`${providersClean}/3 OTA provider checks completed cleanly; missing or warning-provider coverage keeps this out of the hard-cancel tier.`);
  }
  if (remainingBudget <= 0) {
    evidence.push("This booking already has no remaining net budget after existing attached buy-ins.");
    score = basis === "verified_cost" && confidence === "high" && providersHardFailed === 0
      ? Math.max(score, 90)
      : Math.min(Math.max(score, 70), 84);
  }

  const tier = buyInCancellationTier(score);
  return {
    score,
    tier,
    confidence,
    basis,
    title: buyInCancellationTitle(tier),
    summary,
    evidence,
    methodology: [
      "Use only completed live search diagnostics for the same resort, dates, and bedroom count.",
      "Treat no-inventory as a warning signal, not a final cancellation decision, unless all three OTA providers completed cleanly and a human re-check confirms it.",
      "Compare the cheapest verified buy-in against net booking payout minus already-attached buy-ins.",
      "Reserve the hard-cancel tier for verified-cost loss with high provider coverage; cap no-inventory and partial-coverage scans to manual review.",
      "Cap the recommendation when providers failed, timed out, returned unclear coverage, or only two providers completed cleanly.",
    ],
    projectedProfit,
    remainingBudget,
    proposedCost: candidateCost,
    providersSearched,
    providersClean,
    providersHardFailed,
    verifiedCount,
    pricedCount,
  };
}

function BuyInCancellationAdviceCard({ advice }: { advice: BuyInCancellationAdvice | null }) {
  if (!advice) return null;
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${buyInCancellationAdviceClass(advice.tier)}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold uppercase tracking-wide">
            {advice.title} · {advice.score}/100
          </p>
          <p className="mt-0.5">{advice.summary}</p>
        </div>
        <Badge variant="outline" className="shrink-0 bg-white/70 text-[10px]">
          {advice.confidence} confidence
        </Badge>
      </div>
      {advice.basis !== "verified_cost" && advice.tier !== "do_not_cancel" && (
        <div className="mt-2 rounded border border-current/15 bg-white/50 px-2 py-1 text-[11px] font-medium">
          This is an availability warning, not a one-click cancel instruction. Re-run the scan or manually check the OTAs before canceling a guest.
        </div>
      )}
      <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
        <div className="rounded border border-current/15 bg-white/50 px-2 py-1">
          <p className="text-[10px] uppercase tracking-wide opacity-70">Remaining budget</p>
          <p className="font-semibold">{fmtMoney(advice.remainingBudget)}</p>
        </div>
        <div className="rounded border border-current/15 bg-white/50 px-2 py-1">
          <p className="text-[10px] uppercase tracking-wide opacity-70">Cheapest verified</p>
          <p className="font-semibold">{advice.proposedCost != null ? fmtMoney(advice.proposedCost) : "None found"}</p>
        </div>
        <div className="rounded border border-current/15 bg-white/50 px-2 py-1">
          <p className="text-[10px] uppercase tracking-wide opacity-70">Projected profit</p>
          <p className="font-semibold">{advice.projectedProfit != null ? fmtMoney(advice.projectedProfit) : "Unavailable"}</p>
        </div>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] font-medium">Evidence and scoring method</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {advice.evidence.map((line, index) => (
            <li key={`cancel-evidence-${index}`}>{line}</li>
          ))}
          <li>{advice.providersClean}/3 OTA provider checks completed cleanly; {advice.providersSearched}/3 searched; {advice.providersHardFailed} hard failure{advice.providersHardFailed === 1 ? "" : "s"}.</li>
          <li>{advice.verifiedCount} verified row{advice.verifiedCount === 1 ? "" : "s"}; {advice.pricedCount} priced row{advice.pricedCount === 1 ? "" : "s"}.</li>
        </ul>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 opacity-80">
          {advice.methodology.map((line, index) => (
            <li key={`cancel-method-${index}`}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}


function directBookingTargetResortName(community: string): string {
  if (community === "Poipu Kai") return "Poipu Kai";
  if (community === "Kapaa Beachfront") return "Kaha Lani Resort";
  if (community === "Pili Mai") return "Pili Mai at Poipu";
  return community;
}

function normalizeDirectTargetText(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function directCandidateFitsTarget(
  targetResortName: string,
  community: string,
  item: { domain?: string | null; title?: string | null; url?: string | null; sourceLabel?: string | null },
): boolean {
  const targetText = normalizeDirectTargetText(`${targetResortName} ${community}`);
  const hay = normalizeDirectTargetText(`${item.domain ?? ""} ${item.sourceLabel ?? ""} ${item.title ?? ""} ${item.url ?? ""}`);
  if (/\b(travelocity|easemytrip|orbitz|priceline|kayak|trivago|hotwire|hotelplanner|reservations|offerup|mercari|poshmark|depop|letgo|chairish|aptdeco|craigslist|ebay|etsy|amazon|walmart|target|wayfair|potterybarn|homedepot|lowes|costco|ikea|overstock|bedbathandbeyond|marketplace|for sale|classifieds|couch|sofa|sectional|loveseat|recliner|furniture|mattress|headboard|employer profile|career|careers|job|jobs|banyan harbor|lihue|kalapaki|springboard hospitality|blue tide|bluetidevillas|leilani house|kauai kailani|kapaa|kapa a|kuhio highway|kuhio|royal coconut coast|ocean forest villas|elliottbeachrentals|staywaileabeachvillas|glynlea|myrtle beach|port st lucie|wailea)\b/.test(hay)) {
    return false;
  }
  const targetIsRegencyPoipuKai = /\bregency\b/.test(targetText) && /\bpoipu kai\b/.test(targetText);
  if (targetIsRegencyPoipuKai) {
    if (/\b(nihi kai|kahala|manualoha|makanui|poipu sands|villas at poipu kai|poipu kai villas|aston|pili mai|kiahuna|makahuena|waikomo|blue tide|bluetidevillas|leilani house|kauai kailani|kapaa|kapa a|kuhio highway|kuhio|royal coconut coast)\b/.test(hay)) {
      return false;
    }
    return (/\bregency\b/.test(hay) && /\b(poipu kai|poipu|koloa|kauai)\b/.test(hay))
      || /\b1831\s+poipu\b/.test(hay);
  }
  const targetIsPoipuKai = /\bpoipu kai\b/.test(targetText);
  if (targetIsPoipuKai) {
    if (/\b(nihi kai|kipu|pili mai|kiahuna|makahuena|waikomo|waikomo stream|lawai beach|hale kahanalu|banyan harbor|lihue|kalapaki|springboard hospitality|employer profile|career|careers|job|jobs|blue tide|bluetidevillas|leilani house|kauai kailani|kapaa|kapa a|kuhio highway|kuhio|royal coconut coast|ocean forest villas|elliottbeachrentals|staywaileabeachvillas|glynlea|myrtle beach|port st lucie|wailea|kihei|lahaina|wailuku|maui|kona|kailua kona|ko olina|bonita springs|florida|la quinta|palm springs)\b/.test(hay)) return false;
    return /\bpoipu kai\b/.test(hay)
      || (/\b(poipu|koloa|kauai)\b/.test(hay) && /\b(regency|kahala|manualoha|makanui|poipu sands)\b/.test(hay))
      || /\bvillas?\s+at\s+poipu\s+kai\b/.test(hay)
      || /\bpoipu\s+kai\s+villas?\b/.test(hay)
      || /\b1831\s+poipu\b/.test(hay);
  }
  return true;
}

function directProofPrice(proof?: DirectBookingProof): { totalPrice: number; nightlyPrice: number | null } | null {
  if (!proof || proof.price.status !== "date_specific_quote") return null;
  const total = Number(proof.price.totalPrice ?? 0);
  const nightly = Number(proof.price.nightlyPrice ?? 0);
  if (Number.isFinite(total) && total > 0) {
    return { totalPrice: total, nightlyPrice: Number.isFinite(nightly) && nightly > 0 ? nightly : null };
  }
  if (Number.isFinite(nightly) && nightly > 0) {
    return { totalPrice: 0, nightlyPrice: nightly };
  }
  return null;
}

function directProofVerifiedStatus(proof?: DirectBookingProof): LiveCandidate["verified"] | undefined {
  if (!proof) return undefined;
  if (directProofPrice(proof)?.totalPrice) return "yes";
  if (proof.availability.status === "date_specific_unavailable") return "no";
  if (proof.availability.status === "unclear") return "unclear";
  return undefined;
}

function directProofShortLabel(proof?: DirectBookingProof): string {
  if (!proof) return "Direct proof not attached";
  if (proof.price.status === "date_specific_quote") return "Direct PM price proven";
  if (proof.availability.status === "date_specific_available") return "Direct PM availability proven";
  if (proof.availability.status === "date_specific_unavailable") return "Direct PM unavailable";
  if (proof.verdict === "same_unit_direct_page") return "Same-unit page proven";
  return "Direct proof needs review";
}

function comboOptionVisiblePicks(
  option: AutoFillComboOption,
  targetResortName: string,
  community: string,
) {
  return option.picks.filter((pick) => directCandidateFitsTarget(targetResortName, community, pick));
}

function comboOptionIsComplete(
  option: AutoFillComboOption,
  targetResortName: string,
  community: string,
): boolean {
  const visiblePicks = comboOptionVisiblePicks(option, targetResortName, community);
  return visiblePicks.length === option.bedrooms.length
    && option.picks.length === option.bedrooms.length
    && typeof option.totalCost === "number"
    && Number.isFinite(option.totalCost);
}

function targetLocationRejectReason(
  targetResortName: string,
  community: string,
  item: { domain?: string | null; title?: string | null; url?: string | null; sourceLabel?: string | null; snippet?: string | null },
): string | null {
  const targetText = normalizeDirectTargetText(`${targetResortName} ${community}`);
  const hay = normalizeDirectTargetText(`${item.domain ?? ""} ${item.sourceLabel ?? ""} ${item.title ?? ""} ${item.url ?? ""} ${item.snippet ?? ""}`);
  if (/\b(offerup|mercari|poshmark|depop|letgo|chairish|aptdeco|craigslist|ebay|etsy|amazon|walmart|target|wayfair|potterybarn|homedepot|lowes|costco|ikea|overstock|bedbathandbeyond|marketplace|for sale|classifieds|couch|sofa|sectional|loveseat|recliner|furniture|mattress|headboard)\b/.test(hay)) {
    return "not a direct booking site";
  }
  const targetIsRegencyPoipuKai = /\bregency\b/.test(targetText) && /\bpoipu kai\b/.test(targetText);
  if (targetIsRegencyPoipuKai && /\b(banyan harbor|lihue|kalapaki|springboard hospitality|blue tide|bluetidevillas|leilani house|kauai kailani|kapaa|kapa a|kuhio highway|kuhio|royal coconut coast|ocean forest villas|elliottbeachrentals|staywaileabeachvillas|glynlea|myrtle beach|port st lucie|wailea|pili mai|kiahuna|makahuena|waikomo|nihi kai|kahala|manualoha|makanui|poipu sands|villas at poipu kai|poipu kai villas|aston)\b/.test(hay)) {
    return `not in ${targetResortName}`;
  }
  if (/\bpoipu kai\b/.test(targetText) && /\b(banyan harbor|lihue|kalapaki|springboard hospitality|employer profile|career|careers|job|jobs|blue tide|bluetidevillas|leilani house|kauai kailani|kapaa|kapa a|kuhio highway|kuhio|royal coconut coast|ocean forest villas|elliottbeachrentals|staywaileabeachvillas|glynlea|myrtle beach|port st lucie|wailea|nihi kai|kipu|pili mai|kiahuna|makahuena|waikomo|waikomo stream|lawai beach|hale kahanalu|kihei|lahaina|wailuku|maui|kona|kailua kona|ko olina|bonita springs|florida|la quinta|palm springs)\b/.test(hay)) {
    return `not in ${community}`;
  }
  return null;
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

function sidecarLaneActive(status: SidecarQueueStatus | null | undefined): boolean {
  return !!status?.sidecarLane?.owner || (status?.sidecarLane?.waiting?.length ?? 0) > 0;
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientAutoFillErrorMessage(raw: string): boolean {
  const s = raw.toLowerCase();
  return /\b(?:429|502|503|504)\b/.test(s)
    || s.includes("application failed to respond")
    || s.includes("http 502")
    || s.includes("failed to fetch")
    || s.includes("load failed")
    || s.includes("networkerror")
    // Safari sometimes reports an interrupted fetch/navigation this way,
    // especially when the production app restarts while a long scan is open.
    || s.includes("the string did not match the expected pattern");
}

async function fetchFindBuyInWithRetry(url: string): Promise<FindBuyInResponse> {
  const delays = [1_500, 4_000, 8_000];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await apiRequest("GET", url);
      return await res.json() as FindBuyInResponse;
    } catch (e: any) {
      lastError = e;
      const raw = String(e?.message ?? e ?? "");
      if (!isTransientAutoFillErrorMessage(raw) || attempt >= delays.length) break;
      await wait(delays[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Find buy-in failed"));
}

function sidecarQueueProgressValue(status: SidecarQueueStatus | null | undefined): number {
  if (!status) return 12;
  const active = activeSidecarCount(status);
  const total = Math.max(1, status.total, status.pending + status.inProgress + status.completed + status.failed);
  const done = Math.max(0, status.completed + status.failed);
  if (active <= 0 && sidecarLaneActive(status)) return 18;
  if (active <= 0) return done > 0 ? 100 : 12;
  return Math.max(8, Math.min(96, Math.round((done / total) * 100)));
}

function sidecarLaneSummary(status: SidecarQueueStatus | null | undefined): string {
  const lane = status?.sidecarLane;
  if (!lane) return "";
  if (lane.owner?.label) return `lane held by ${lane.owner.label}`;
  const waiting = lane.waiting ?? [];
  if (waiting.length > 0) {
    const first = waiting[0]?.label || "next scan";
    return `${waiting.length} waiting for lane${first ? ` · next: ${first}` : ""}`;
  }
  return "";
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
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") void tick();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
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
  const laneActive = sidecarLaneActive(status);
  if (!forceVisible && active <= 0 && !laneActive) return null;

  const total = status ? Math.max(1, status.total, status.pending + status.inProgress + status.completed + status.failed) : 0;
  const opSummary = sidecarOpSummary(status);
  const laneSummary = sidecarLaneSummary(status);
  const message = status
    ? active > 0
      ? `${label}: ${status.inProgress} running, ${status.pending} queued, ${status.completed + status.failed}/${total} finished${opSummary ? ` · ${opSummary}` : ""}${laneSummary ? ` · ${laneSummary}` : ""}.`
      : laneSummary
        ? `${label}: ${laneSummary}.`
        : `${label}: queue idle${status.completed + status.failed > 0 ? ` after ${status.completed + status.failed} finished job${status.completed + status.failed === 1 ? "" : "s"}` : ""}.`
    : `${label}: waiting for queue status.`;

  const stopSidecar = async () => {
    setIsStopping(true);
    try {
      const response = await apiRequest("POST", "/api/vrbo-sidecar/stop", {
        reason: "stopped by operator from Operations progress bar",
      });
      const result = await response.json();
      toast({
        title: "Sidecar stopped",
        description: result.cancelled > 0
          ? `Cancelled ${result.cancelled} job${result.cancelled === 1 ? "" : "s"} and paused the queue. Click Start Queue when you're ready.`
          : "Queue is paused. Click Start Queue when you're ready.",
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
          {(active > 0 || laneActive) && <RefreshCw className="h-3 w-3 animate-spin shrink-0" />}
          <span>{message}</span>
        </span>
        {status?.oldestPendingAgeSec != null && status.pending > 0 && (
          <span className="tabular-nums text-blue-800/80">
            oldest {Math.round(status.oldestPendingAgeSec)}s
          </span>
        )}
        {(active > 0 || laneActive) && (
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

function otaSearchProviderLabel(provider: OtaSearchProviderKey): string {
  switch (provider) {
    case "airbnb": return "Airbnb";
    case "vrbo": return "Vrbo";
    case "booking": return "Booking.com";
  }
}

function variationTextareaValue(terms: string[]): string {
  return terms.join("\n");
}

function parseVariationTextarea(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,]+/)
      .map((term) => term.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  )).slice(0, 12);
}

function SidecarSearchVariationPanel({
  community,
  city,
  state,
  status,
  loading,
  onSaved,
  onRerunUntried,
  rerunUntriedOnly,
  disabled = false,
}: {
  community: string;
  city?: string | null;
  state?: string | null;
  status: SidecarSearchVariationStatus | undefined;
  loading: boolean;
  onSaved: () => void;
  onRerunUntried: () => void;
  rerunUntriedOnly: boolean;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<OtaSearchProviderKey, string>>({
    airbnb: "",
    vrbo: "",
    booking: "",
  });
  const [savingProvider, setSavingProvider] = useState<OtaSearchProviderKey | null>(null);

  useEffect(() => {
    if (!status) return;
    setDrafts((previous) => {
      const next = { ...previous };
      for (const provider of ["airbnb", "vrbo", "booking"] as OtaSearchProviderKey[]) {
        const channel = status.channels[provider];
        const terms = channel.preferredTerms.length
          ? channel.preferredTerms
          : Array.from(new Set([
            channel.bestTerm,
            ...status.generatedTerms,
          ].filter(Boolean) as string[])).slice(0, 6);
        next[provider] = variationTextareaValue(terms);
      }
      return next;
    });
  }, [status?.communityKey]);

  const saveProvider = async (provider: OtaSearchProviderKey) => {
    const terms = parseVariationTextarea(drafts[provider] ?? "");
    setSavingProvider(provider);
    try {
      const response = await apiRequest("POST", "/api/vrbo-sidecar/search-variations", {
        community,
        city,
        state,
        channel: provider,
        terms,
      });
      if (!response.ok) throw new Error(await response.text());
      onSaved();
      toast({
        title: `${otaSearchProviderLabel(provider)} variations saved`,
        description: terms.length ? `${terms.length} preferred term${terms.length === 1 ? "" : "s"}` : "Preferred terms cleared",
      });
    } catch (e) {
      toast({
        title: "Could not save variations",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSavingProvider(null);
    }
  };

  const generated = status?.generatedTerms ?? [];

  return (
    <div className="rounded-md border bg-slate-50/70 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-slate-800">Search variations</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {loading ? "Loading saved variation policy." : `${status?.communityName || community}${generated.length ? ` · generated ${generated.slice(0, 4).join(", ")}` : ""}`}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant={rerunUntriedOnly ? "default" : "outline"}
          className="h-7 text-[11px]"
          onClick={onRerunUntried}
          disabled={disabled}
        >
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Re-run untried
        </Button>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {(["airbnb", "vrbo", "booking"] as OtaSearchProviderKey[]).map((provider) => {
          const channel = status?.channels?.[provider];
          const lastRun = channel?.lastRun;
          const summary = lastRun?.tried?.length
            ? `${lastRun.tried.length} tried${lastRun.bestTerm ? ` · best ${lastRun.bestTerm} (${lastRun.bestYieldCount})` : ""}`
            : channel?.history?.length
              ? `${channel.history.length} saved/history`
              : "No history yet";
          const untried = channel?.untriedTerms ?? [];
          return (
            <div key={provider} className="rounded border bg-white p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <Label className="text-[11px] font-semibold">{otaSearchProviderLabel(provider)}</Label>
                <span className="truncate text-[10px] text-muted-foreground">{summary}</span>
              </div>
              <Textarea
                className="min-h-[76px] resize-y text-[11px]"
                value={drafts[provider] ?? ""}
                onChange={(event) => setDrafts((previous) => ({ ...previous, [provider]: event.target.value }))}
                disabled={disabled || savingProvider === provider}
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="truncate text-[10px] text-muted-foreground">
                  {untried.length
                    ? `untried: ${untried.slice(0, 2).join(", ")}${untried.length > 2 ? ` +${untried.length - 2}` : ""}`
                    : channel?.bestTerm ? `best: ${channel.bestTerm}` : "search policy"}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => saveProvider(provider)}
                  disabled={disabled || savingProvider === provider}
                >
                  {savingProvider === provider ? "Saving" : "Save"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
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
      const response = await apiRequest("POST", "/api/vrbo-sidecar/stop", {
        reason: "stopped by operator from Operations auto-fill progress",
      });
      const result = await response.json();
      toast({
        title: "Sidecar stopped",
        description: result.cancelled > 0
          ? `Cancelled ${result.cancelled} job${result.cancelled === 1 ? "" : "s"} and paused the queue. Click Start Queue when you're ready.`
          : "Queue is paused. Click Start Queue when you're ready.",
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

function GroundFloorRequirementNotice({
  reservation,
  propertyId,
}: {
  reservation: GuestyReservation;
  propertyId: number;
}) {
  const { data, isLoading, isError } = useQuery<GroundFloorRequirement & {
    conversationId?: string | null;
    sourceCounts?: { guestyPosts: number; sms: number };
  }>({
    queryKey: ["/api/bookings", reservation._id, "ground-floor-requirement", propertyId, reservation.slots.length],
    queryFn: () => apiGetJson(
      groundFloorRequirementHref(reservation, propertyId),
    ),
    enabled: !!reservation._id,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-muted-foreground">
        <RefreshCw className="mr-1 inline h-3 w-3 animate-spin" />
        Scanning guest messages for ground-floor requests...
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <AlertCircle className="mr-1 inline h-3 w-3" />
        Could not scan guest messages for ground-floor requests.
      </div>
    );
  }
  if (!data.requested) {
    return (
      <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-muted-foreground">
        <CheckCircle2 className="mr-1 inline h-3 w-3 text-slate-500" />
        No ground-floor request found in the linked guest conversation.
      </div>
    );
  }
  const targetBedrooms = groundFloorTargetBedrooms(data);

  return (
    <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
          {groundFloorRequirementLabel(data)}
        </p>
        <Badge variant="outline" className="border-amber-300 bg-white text-[10px] text-amber-900">
          {data.requiredUnits} ground-floor {data.requiredUnits === 1 ? "unit" : "units"} required
          {targetBedrooms.length ? ` · ${targetBedrooms.map((b) => `${b}BR`).join(" + ")}` : ""}
        </Badge>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-amber-900">
        Auto-fill will only attach confirmed ground-floor buy-ins for the required slot{data.requiredUnits === 1 ? "" : "s"}{targetBedrooms.length ? ` (${targetBedrooms.map((b) => `${b}BR`).join(" + ")})` : ""}.
        {data.scope === "unknown" ? " Scope is unclear, so the tool assumes at least one ground-floor unit until clarified." : ""}
      </p>
      {data.evidence?.[0] && (
        <p className="mt-1 truncate text-[11px] italic text-amber-800" title={data.evidence[0]}>
          Evidence: "{data.evidence[0]}"
        </p>
      )}
    </div>
  );
}

type ListingPairWalkResponse = {
  status: "ready";
  walk: {
    minutes: number;
    feet: number;
    description: string;
    source: "geocoded" | "fallback";
  };
  confidence: "exact-address" | "listing-title" | "resort-default";
  withinLimit: boolean;
  maxMinutes: number;
};

function ComboOptionWalkDistance({
  picks,
  community,
  proximityCommunity,
}: {
  picks: AutoFillComboOption["picks"];
  community: string;
  proximityCommunity?: string;
}) {
  const listings = picks.slice(0, 2).map((pick) => ({
    url: String(pick.originalSourceUrl || pick.airbnbAnchorUrl || pick.url || "").trim(),
    title: String(pick.title || "").trim() || `${pick.bedrooms}BR listing`,
  }));
  const walkCommunity = proximityCommunity?.trim() || community;
  const query = useQuery<ListingPairWalkResponse>({
    queryKey: ["/api/tools/listing-pair-proximity", walkCommunity, listings[0]?.url, listings[1]?.url],
    queryFn: async () => {
      const response = await apiRequest("POST", "/api/tools/listing-pair-proximity", {
        listings,
        community: walkCommunity,
      });
      return response.json() as Promise<ListingPairWalkResponse>;
    },
    enabled: listings.length === 2 && /^https?:\/\//i.test(listings[0]?.url ?? "") && /^https?:\/\//i.test(listings[1]?.url ?? ""),
    staleTime: 10 * 60 * 1000,
  });

  if (listings.length < 2) return null;

  const confidenceLabel = query.data?.confidence === "exact-address"
    ? "address verified"
    : query.data?.confidence === "listing-title"
      ? "estimated from listing titles"
      : "resort footprint estimate";
  const isTooFar = query.data?.withinLimit === false;

  return (
    <div className={`mt-2 border-t pt-1.5 text-[11px] ${isTooFar ? "text-red-900" : "text-muted-foreground"}`}>
      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <Footprints className="h-3 w-3 shrink-0" />
        {query.isLoading ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Estimating walking distance between units…</span>
          </>
        ) : !/^https?:\/\//i.test(listings[0]?.url ?? "") || !/^https?:\/\//i.test(listings[1]?.url ?? "") ? (
          <span>Walking distance needs two listing URLs</span>
        ) : query.isError || !query.data ? (
          <span>Walking distance unavailable{query.error instanceof Error ? ` (${query.error.message})` : ""}</span>
        ) : (
          <>
            <Badge className={`${isTooFar ? "bg-red-700" : "bg-sky-700"} text-white text-[9px]`}>
              {query.data.walk.minutes} min walk
            </Badge>
            <span className={isTooFar ? "text-red-800" : "text-foreground/80"}>
              {isTooFar
                ? `Too far for buy-in pairing (limit ${query.data.maxMinutes} min). ${query.data.walk.description}`
                : query.data.walk.description}
            </span>
            <span className="text-[10px]">{confidenceLabel}</span>
          </>
        )}
      </span>
    </div>
  );
}

function groundFloorTargetBedrooms(req?: GroundFloorRequirement | null): number[] {
  const explicit = (req?.targetBedrooms ?? [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (explicit.length > 0) return Array.from(new Set(explicit)).sort((a, b) => b - a);

  const text = [req?.summary, ...(req?.evidence ?? [])].filter(Boolean).join(" ");
  if (!text) return [];
  const targets = new Set<number>();
  const groundRe = /\b(ground[-\s]?floor|bottom[-\s]?floor|first[-\s]?floor|main[-\s]?floor|downstairs|lower[-\s]?level|street[-\s]?level|no\s+stairs?|stair[-\s]?free|accessible|accessibility|mobility)\b/i;
  const mandatoryRe = /\b(mandatory|required|require|requires|need|needs|needed|must|have to|has to|can't|cannot|unable|where\s+(?:she|he|they|we|my|our)\b.{0,30}\b(?:stay|staying|sleep|sleeping))\b/i;
  const optionalRe = /\b(would be nice|nice to have|if available|if you have|optional|prefer|preference|less desirable|not mandatory|not required|doesn't have to|does not have to)\b/i;
  const bedroomRe = /\b(\d{1,2})\s*[-\s]?(?:br|bd|bdr|bdrm|bed|beds|bedroom|bedrooms)\b/gi;
  for (const segment of text.split(/(?<=[.!?])\s+|\n+|;\s*/g)) {
    if (!groundRe.test(segment)) continue;
    if (optionalRe.test(segment) && !mandatoryRe.test(segment)) continue;
    bedroomRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = bedroomRe.exec(segment)) !== null) {
      const bedrooms = Number.parseInt(match[1], 10);
      if (Number.isFinite(bedrooms) && bedrooms > 0 && bedrooms < 20) targets.add(bedrooms);
    }
  }
  return Array.from(targets).sort((a, b) => b - a);
}

function ComboComparisonPanel({
  options,
  targetResortName,
  community,
  onAttachCombo,
  attachingComboLabel,
}: {
  options: AutoFillComboOption[];
  targetResortName: string;
  community: string;
  onAttachCombo?: (option: AutoFillComboOption) => void;
  attachingComboLabel?: string | null;
}) {
  if (options.length === 0) return null;
  const candidateVisibleForTarget = (candidate: {
    source?: "airbnb" | "vrbo" | "booking" | "pm";
    sourceLabel?: string | null;
    title?: string | null;
    url?: string | null;
  }) => directCandidateFitsTarget(targetResortName, community, candidate);
  const visibleOptions = options.map((option) => {
    const filteredPicks = comboOptionVisiblePicks(option, targetResortName, community);
    const isComplete = comboOptionIsComplete(option, targetResortName, community);
    const missingUnits = option.bedrooms.length - filteredPicks.length;
    return {
      ...option,
      selected: option.selected && isComplete,
      totalCost: isComplete ? option.totalCost : null,
      unavailableReason: isComplete
        ? option.unavailableReason
        : filteredPicks.length === 0
          ? option.unavailableReason ?? `No bookable ${option.label} combination found for ${targetResortName || community} on these dates.`
          : `Could not verify a complete ${option.label} combination — only ${filteredPicks.length}/${option.bedrooms.length} unit${filteredPicks.length === 1 ? "" : "s"} matched ${targetResortName || community}${missingUnits > 0 ? ` (${missingUnits} still missing)` : ""}.`,
      picks: isComplete ? filteredPicks : [],
      pools: option.pools?.map((pool) => ({
        ...pool,
        candidates: pool.candidates.filter(candidateVisibleForTarget),
      })),
    };
  });
  const completeVisibleOptions = visibleOptions.filter((option) =>
    comboOptionIsComplete(option, targetResortName, community),
  );
  const selected = completeVisibleOptions.find((option) => option.selected);
  const pricedVisibleOptions = completeVisibleOptions
    .sort((a, b) => (a.totalCost ?? Number.POSITIVE_INFINITY) - (b.totalCost ?? Number.POSITIVE_INFINITY));
  const primaryOption = selected ?? pricedVisibleOptions[0] ?? visibleOptions[0];
  const secondaryOption = pricedVisibleOptions.find((option) => option.label !== primaryOption?.label)
    ?? visibleOptions.find((option) => option.label !== primaryOption?.label);
  const summaryOptions = [primaryOption, secondaryOption].filter((option): option is typeof visibleOptions[number] => !!option);
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs">
      {completeVisibleOptions.length === 0 && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-2 text-amber-950">
          <p className="font-semibold">No complete two-unit combination found</p>
          <p className="mt-0.5 text-[11px]">
            We compared {visibleOptions.map((option) => option.label).join(" and ")} for {targetResortName || community} but could not verify two distinct bookable units for this stay.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-medium text-emerald-900">
          {completeVisibleOptions.length === 0
            ? "Two-unit combination search"
            : `Cheapest two-unit combination${selected ? `: ${selected.label} · ${fmtMoney(selected.totalCost)}` : ""}`}
        </p>
        {selected && (
          <Badge className="bg-emerald-600 text-white text-[10px]">Cheapest combo</Badge>
        )}
      </div>
      <div className="mt-2 space-y-2">
        {summaryOptions.map((option) => {
          const displayedPicks = option.picks;
          const displayedTotal = option.totalCost;
          const canAttachCombo = !!onAttachCombo && displayedTotal != null && displayedPicks.length === option.bedrooms.length;
          const attachingThisCombo = attachingComboLabel === option.label;
          return (
          <div
            key={option.label}
            className={`rounded border px-2 py-1.5 ${
              option.selected ? "border-emerald-300 bg-white/80" : "border-emerald-100 bg-white/50"
            }`}
          >
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  {option.label}
                  {option.selected && <span className="ml-1 text-emerald-700">cheapest combo</span>}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {displayedTotal == null
                    ? option.unavailableReason ?? "Not enough priced direct/Booking/VRBO options; Airbnb fallback checked"
                    : displayedPicks.map((pick) => `${pick.bedrooms}BR ${pick.sourceLabel} ${fmtMoney(pick.totalPrice)}`).join(" + ")}
                </p>
                {option.note && (
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{option.note}</p>
                )}
              </div>
              <div className="text-right font-semibold tabular-nums">
                {displayedTotal == null ? "—" : fmtMoney(displayedTotal)}
              </div>
            </div>
            {displayedTotal == null && (option.unavailableDetails?.length ?? 0) > 0 && (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-950">
                <p className="font-semibold">No complete combo could be built from the visible provider results.</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {option.unavailableDetails!.slice(0, 6).map((detail, index) => (
                    <li key={`${option.label}-detail-${index}`}>{detail}</li>
                  ))}
                </ul>
              </div>
            )}
            {displayedPicks.length > 0 && (
              <div className="mt-2 rounded border border-emerald-100 bg-white/80 px-2 py-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] font-medium text-emerald-950">Combo unit links</p>
                  {canAttachCombo && (
                    <Button
                      type="button"
                      size="sm"
                      variant={option.selected ? "default" : "outline"}
                      className="h-7 px-2 text-[11px]"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onAttachCombo?.(option);
                      }}
                      disabled={!!attachingComboLabel}
                    >
                      {attachingThisCombo ? (
                        <><RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" /> Attaching...</>
                      ) : (
                        <><Link2 className="mr-1 h-3.5 w-3.5" /> Attach this combo</>
                      )}
                    </Button>
                  )}
                </div>
                <div className="mt-1 grid gap-1">
                  {displayedPicks.map((pick, index) => (
                    <div
                      key={`${option.label}-pick-${index}-${pick.url}`}
                      onClick={(event) => event.stopPropagation()}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded border px-2 py-1 text-[11px] hover:bg-emerald-50"
                    >
                      <Badge className={`text-[9px] ${sourceBadgeClass(pick.source ?? "pm")}`}>{pick.bedrooms}BR</Badge>
                      <span className="min-w-0">
                        <span className="block truncate">{pick.sourceLabel} · {pick.title}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                          {pick.directBookingSource === "airbnb_image_reverse_search" && (
                            <span className="text-emerald-700" title={pick.directProof?.summary}>
                              {directProofShortLabel(pick.directProof)}
                            </span>
                          )}
                          {pick.originalSourceUrl && pick.originalSourceUrl !== pick.url && (
                            <button
                              type="button"
                              className="underline-offset-2 hover:text-foreground hover:underline"
                              onClick={() => window.open(pick.originalSourceUrl, "_blank", "noopener,noreferrer")}
                            >
                              Original URL
                            </button>
                          )}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="inline-flex items-center justify-end gap-1 font-semibold tabular-nums underline-offset-2 hover:underline"
                        onClick={() => window.open(pick.url, "_blank", "noopener,noreferrer")}
                      >
                        {fmtMoney(pick.totalPrice)}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(option.pools?.length ?? 0) > 0 && (
              <details className="mt-2 border-t border-emerald-100 pt-2">
                <summary className="cursor-pointer text-[11px] font-medium text-emerald-900">
                  Audit considered rows
                </summary>
                <div className="mt-2 space-y-2">
                  {(option.pools ?? []).map((pool) => (
                    <div key={`${option.label}-${pool.bedrooms}`}>
                      <p className="mb-1 text-[11px] font-medium text-emerald-900">{pool.bedrooms}BR options considered</p>
                      <div className="max-h-48 overflow-y-auto rounded border bg-white/70">
                        {pool.candidates.filter(candidateVisibleForTarget).length === 0 ? (
                          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                            <p className="font-medium text-amber-900">
                              {pool.unavailableReason ?? "No verified Airbnb, VRBO map, or direct/Lens option in this pool."}
                            </p>
                            {(pool.unavailableDetails?.length ?? 0) > 0 && (
                              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                                {pool.unavailableDetails!.slice(0, 5).map((detail, index) => (
                                  <li key={`${option.label}-${pool.bedrooms}-pool-detail-${index}`}>{detail}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ) : pool.candidates.filter(candidateVisibleForTarget).map((candidate, index) => (
                          <a
                            key={`${candidate.url}-${index}`}
                            href={candidate.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b px-2 py-1.5 last:border-b-0 hover:bg-emerald-50/70"
                          >
                            <Badge className={`text-[9px] ${sourceBadgeClass(candidate.source)}`}>{candidate.sourceLabel}</Badge>
                            <span className="min-w-0 truncate text-[11px]" title={candidate.title}>
                              {candidate.title}
                            </span>
                            <span className="text-right text-[11px] font-semibold tabular-nums">{fmtMoney(candidate.totalPrice)}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {displayedTotal != null && displayedPicks.length >= 2 && (
              <ComboOptionWalkDistance
                picks={displayedPicks}
                community={community}
                proximityCommunity={displayedPicks.some((pick) => (pick as { community?: string }).community)
                  ? (displayedPicks.find((pick) => (pick as { community?: string }).community) as { community?: string } | undefined)?.community
                  : undefined}
              />
            )}
          </div>
        )})}
      </div>
    </div>
  );
}

function AutoFillSearchAuditPanel({ audits }: { audits: AutoFillSearchAudit[] }) {
  if (audits.length === 0) return null;
  const totalRows = audits.reduce((sum, audit) => sum + audit.candidates.length, 0);
  const cheapestUrl = audits
    .flatMap((audit) => audit.candidates)
    .filter((candidate) => candidate.totalPrice > 0)
    .sort((a, b) => a.totalPrice - b.totalPrice)[0]?.url;
  return (
    <details className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-slate-900">
        Provider audit details ({totalRows} curated option{totalRows === 1 ? "" : "s"})
      </summary>
      <div className="mt-2 space-y-3">
        {audits.map((audit) => {
          const grouped = {
            airbnb: audit.candidates.filter((c) => c.source === "airbnb"),
            vrbo: audit.candidates.filter((c) => c.source === "vrbo"),
            booking: audit.candidates.filter((c) => c.source === "booking"),
            pm: audit.candidates.filter((c) => c.source === "pm"),
          };
          const availabilityDetails = buyInSearchAvailabilityDetails(
            audit.counts,
            audit.diagnostics,
            audit.bedrooms,
            { onlyUnavailable: audit.candidates.length === 0, includeIssues: true },
          );
          const hasSearchProblem =
            audit.candidates.length === 0
            || audit.counts.priced === 0
            || audit.diagnostics?.severity === "warning"
            || audit.diagnostics?.severity === "error";
          return (
            <div key={audit.bedrooms} className="rounded border bg-muted/10">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5">
                <div>
                  <p className="font-semibold">
                    {audit.bedrooms}BR search
                    {audit.diagnostics?.severity && audit.diagnostics.severity !== "ok" && (
                      <Badge variant="outline" className={`ml-1 text-[9px] ${diagnosticStatusClass(audit.diagnostics.severity)}`}>
                        {audit.diagnostics.severity}
                      </Badge>
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {audit.counts.scanned} scanned · {audit.counts.priced} priced · {audit.counts.kept} curated · Airbnb {audit.counts.sourceCounts.airbnb}, VRBO {audit.counts.sourceCounts.vrbo}, PM {audit.counts.sourceCounts.pm}
                    {audit.counts.groundFloorOnly ? " · ground-floor required" : ""}
                    {audit.counts.targetFiltered > 0
                      ? ` · ${audit.counts.targetFiltered} broad upstream result${audit.counts.targetFiltered === 1 ? "" : "s"} ignored`
                      : ""}
                  </p>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(audit.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
              <ProviderSearchStatusStrip audit={audit} />
              {availabilityDetails.length > 0 && (
                <div className={`border-b px-2 py-1.5 text-[11px] ${
                  hasSearchProblem ? "border-amber-200 bg-amber-50/80 text-amber-950" : "bg-slate-50 text-slate-700"
                }`}>
                  <p className="font-semibold">
                    {hasSearchProblem
                      ? "Provider availability diagnostics"
                      : "Provider availability checked"}
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {availabilityDetails.slice(0, 7).map((detail, index) => (
                      <li key={`${audit.bedrooms}-availability-${index}`}>{detail}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="max-h-72 overflow-y-auto divide-y">
                {audit.candidates.length === 0 ? (
                  <p className="px-2 py-2 text-[11px] text-muted-foreground">
                    No verified available {audit.bedrooms}BR option was kept for this search.
                  </p>
                ) : (
                  (["airbnb", "vrbo", "booking", "pm"] as const).map((source) => {
                    const rows = grouped[source];
                    if (rows.length === 0) return null;
                    return (
                      <div key={`${audit.bedrooms}-${source}`} className="p-2">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {source === "pm" ? "PM/direct" : source === "booking" ? "Booking.com" : source.toUpperCase()} ({rows.length})
                        </p>
                        <div className="space-y-1">
                          {rows.slice(0, 30).map((candidate, index) => {
                            const isCheapest = cheapestUrl && listingUrlKey(candidate.url) === listingUrlKey(cheapestUrl);
                            return (
                            <a
                              key={`${candidate.url}-${index}`}
                              href={candidate.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded border px-2 py-1.5 hover:bg-muted/50 ${
                                isCheapest ? "border-emerald-400 bg-emerald-50" : "bg-background"
                              }`}
                            >
                              <Badge className={`text-[9px] ${sourceBadgeClass(candidate.source)}`}>
                                {candidate.sourceLabel}
                              </Badge>
                              <span className="min-w-0 truncate text-[11px]" title={candidate.title}>
                                {isCheapest && (
                                  <Badge className="mr-1 bg-emerald-600 text-white text-[9px]">Cheapest</Badge>
                                )}
                                {candidate.title}
                                {candidate.verified && (
                                  <span className="ml-1 text-muted-foreground">· availability {candidate.verified}</span>
                                )}
                                {candidate.groundFloorStatus && (
                                  <Badge variant="outline" className={`ml-1 text-[9px] ${groundFloorBadge(candidate.groundFloorStatus).className}`}>
                                    {groundFloorBadge(candidate.groundFloorStatus).label}
                                  </Badge>
                                )}
                              </span>
                              <span className="text-[11px] font-semibold tabular-nums">
                                {candidate.totalPrice > 0 ? fmtMoney(candidate.totalPrice) : "No price"}
                              </span>
                            </a>
                          );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </details>
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

function refundDecisionLabel(decision: string): string {
  switch (decision) {
    case "no_payment": return "No payment taken";
    case "fully_refunded": return "Fully refunded";
    case "partial_refund": return "Partial refund";
    case "refund_review": return "Refund review needed";
    default: return "Unknown payment state";
  }
}

function refundDecisionClass(decision: string): string {
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

function parseLocalDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function monthInputValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
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

function cancellationPolicyBriefSummary(label: string, kind: ReturnType<typeof channelKindOf>): string {
  const lower = label.toLowerCase();
  if (kind === "booking") {
    return "Guest is under the Booking.com rate-plan cancellation terms configured in Guesty/Booking.com for this listing.";
  }
  if (kind === "vrbo") {
    return "Guest is under the cancellation, refund, no-show, and date-change terms configured in Guesty and pushed to VRBO/Homeaway for this listing.";
  }
  if (lower.includes("non-refundable") || lower.includes("non refundable") || lower.includes("no refund")) {
    return "Guest booked a non-refundable policy; treat the stay as no-refund unless Guesty/channel rules or an approved exception say otherwise.";
  }
  if (lower.includes("flexible")) {
    return "Guest booked the flexible cancellation policy; refund eligibility follows the flexible window configured in Guesty/channel rules.";
  }
  if (lower.includes("moderate")) {
    return "Guest booked the moderate cancellation policy; refund eligibility follows the moderate window configured in Guesty/channel rules.";
  }
  if (lower.includes("firm")) {
    return "Guest booked the firm cancellation policy; refund eligibility follows the firm window configured in Guesty/channel rules.";
  }
  if (lower.includes("strict")) {
    return "Guest booked the strict cancellation policy; refunds are limited to the strict terms configured in Guesty/channel rules.";
  }
  if (lower.includes("relaxed")) {
    return "Guest booked the relaxed cancellation policy; refund eligibility follows the relaxed window configured in Guesty/channel rules.";
  }
  return "Guest is under the cancellation, refund, no-show, and date-change terms attached to this booking in Guesty.";
}

function cancellationPolicyTerms(label: string, kind: ReturnType<typeof channelKindOf>) {
  const lower = label.toLowerCase();
  if (kind === "booking") {
    return {
      freeCancellationUntil: "Not exposed by Guesty for this Booking.com rate plan",
      penalty: "Check the Booking.com rate-plan/extranet terms; Guesty only returned the booking/rate-plan reference, not the penalty schedule.",
      detailsAvailable: false,
    };
  }
  if (kind === "vrbo") {
    if (lower.includes("relaxed")) {
      return { freeCancellationUntil: "14+ days before check-in", penalty: "7-14 days before check-in: 50% refund. Less than 7 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("moderate")) {
      return { freeCancellationUntil: "30+ days before check-in", penalty: "14-30 days before check-in: 50% refund. Less than 14 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("firm")) {
      return { freeCancellationUntil: "60+ days before check-in", penalty: "30-60 days before check-in: 50% refund. Less than 30 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("strict")) {
      return { freeCancellationUntil: "60+ days before check-in", penalty: "Less than 60 days before check-in: no refund.", detailsAvailable: true };
    }
  }
  if (lower.includes("non-refundable") || lower.includes("non refundable") || lower.includes("no refund")) {
    return { freeCancellationUntil: "No free-cancellation window", penalty: "Reservation is non-refundable once booked unless the channel/Guesty exception rules apply.", detailsAvailable: true };
  }
  if (lower.includes("flexible")) {
    return { freeCancellationUntil: "1 day / 24 hours before check-in", penalty: "After that cutoff, Guesty/channel cancellation fees apply; for Airbnb Flexible, the first night is generally not refunded after the cutoff.", detailsAvailable: true };
  }
  if (lower.includes("moderate")) {
    return { freeCancellationUntil: "5 days before check-in on Airbnb; 7 days before arrival for Guesty direct/manual policies", penalty: "After that cutoff, Guesty/channel cancellation fees apply; for Airbnb Moderate, the host is generally paid nights stayed, one extra night, and 50% of remaining nights.", detailsAvailable: true };
  }
  if (lower.includes("firm")) {
    return { freeCancellationUntil: "14-30 days before check-in, depending on channel policy", penalty: "After that cutoff, Guesty/channel cancellation fees apply; Airbnb Firm usually becomes 50% refundable until 7 days before check-in, then non-refundable.", detailsAvailable: true };
  }
  if (lower.includes("strict")) {
    return { freeCancellationUntil: "14-60 days before check-in, depending on channel policy", penalty: "After that cutoff, Guesty/channel cancellation fees apply; strict policies generally become non-refundable closer to check-in.", detailsAvailable: true };
  }
  if (lower.includes("relaxed")) {
    return { freeCancellationUntil: "14+ days before check-in", penalty: "7-14 days before check-in: 50% refund. Less than 7 days before check-in: no refund.", detailsAvailable: true };
  }
  return { freeCancellationUntil: "Configured in Guesty, but the exact cutoff was not exposed", penalty: "Use the Guesty/channel reservation policy details for the cancellation fee or no-show penalty.", detailsAvailable: false };
}

function cancellationPolicySummaryOf(r: GuestyReservation): { label: string; summary: string; freeCancellationUntil: string; penalty: string; detailsAvailable: boolean; source?: string | null; assumed: boolean } | null {
  const kind = channelKindOf(r);
  if (r.cancellationPolicy) {
    const terms = cancellationPolicyTerms(r.cancellationPolicy, kind);
    return {
      label: r.cancellationPolicy,
      summary: r.cancellationPolicySummary ?? cancellationPolicyBriefSummary(r.cancellationPolicy, kind),
      freeCancellationUntil: r.cancellationPolicyFreeCancellationUntil ?? terms.freeCancellationUntil,
      penalty: r.cancellationPolicyPenalty ?? terms.penalty,
      detailsAvailable: r.cancellationPolicyDetailsAvailable ?? terms.detailsAvailable,
      source: r.cancellationPolicySource,
      assumed: r.cancellationPolicyAssumed === true,
    };
  }
  if (kind === "booking") {
    const label = "Booking.com cancellation policy configured in Guesty";
    return {
      label,
      summary: cancellationPolicyBriefSummary(label, kind),
      ...cancellationPolicyTerms(label, kind),
      source: "Assumed from the policy Guesty pushed to Booking.com",
      assumed: true,
    };
  }
  if (kind === "vrbo") {
    const label = "VRBO cancellation policy configured in Guesty";
    return {
      label,
      summary: cancellationPolicyBriefSummary(label, kind),
      ...cancellationPolicyTerms(label, kind),
      source: "Assumed from the policy Guesty pushed to VRBO",
      assumed: true,
    };
  }
  return null;
}

function ReservationCancellationPolicyNotice({ reservation }: { reservation: GuestyReservation }) {
  const policy = cancellationPolicySummaryOf(reservation);
  if (!policy) return null;
  return (
    <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
          <div className="min-w-0">
            <p className="font-semibold">Cancellation policy</p>
            <p className="break-words">{policy.label}</p>
            <p className="mt-1 break-words text-[11px] leading-relaxed text-sky-900">
              <span className="font-semibold">Policy summary:</span> {policy.summary}
            </p>
            <dl className="mt-2 grid gap-1 text-[11px] leading-relaxed sm:grid-cols-[150px_1fr]">
              <dt className="font-semibold text-sky-900">Free until penalty:</dt>
              <dd className="break-words">{policy.freeCancellationUntil}</dd>
              <dt className="font-semibold text-sky-900">Penalty:</dt>
              <dd className="break-words">{policy.penalty}</dd>
            </dl>
          </div>
        </div>
        {policy.assumed && (
          <Badge variant="outline" className="w-fit border-sky-300 bg-white/70 text-[10px] text-sky-900">
            Assumed from Guesty
          </Badge>
        )}
      </div>
      {policy.source && (
        <p className="mt-1 pl-6 text-[11px] text-sky-800">{policy.source}</p>
      )}
    </div>
  );
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

function getGrossRevenue(r: GuestyReservation): number {
  return asMoneyNumber(r.money?.fareAccommodation) || asMoneyNumber(r.money?.hostPayout) || asMoneyNumber(r.money?.totalPaid);
}

function getNetRevenue(r: GuestyReservation): number {
  return asMoneyNumber(r.money?.hostPayout) || asMoneyNumber(r.money?.netIncome) || getGrossRevenue(r);
}

function getFundsLeftToCollect(r: GuestyReservation): number {
  return Math.max(0, asMoneyNumber(r.money?.balanceDue));
}

function getReservationNights(r: GuestyReservation): number {
  return r.nightsCount || nightsBetween(checkInOf(r), checkOutOf(r));
}

function getDepositAmount(r: GuestyReservation): number {
  return getNetRevenue(r);
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

function operationsLaunchParams() {
  const params = typeof window === "undefined"
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search);
  const propertyIdRaw = Number(params.get("propertyId") ?? "");
  return {
    propertyId: Number.isFinite(propertyIdRaw) && propertyIdRaw > 0 ? propertyIdRaw : null,
    listingId: params.get("listingId")?.trim() || null,
    reservationId: params.get("reservationId")?.trim() || null,
    includePast: params.get("includePast") === "true",
  };
}

function wordForSmallCount(count: number): string {
  return ({ 1: "one", 2: "two", 3: "three", 4: "four" } as Record<number, string>)[count] ?? String(count);
}

function bulkBuyInQueuedForText(
  reservation: GuestyReservation,
  propertyName: string,
  propertyId: number,
): string {
  const emptySlots = reservation.slots.filter((slot) => !slot.buyIn);
  const slots = emptySlots.length > 0 ? emptySlots : reservation.slots;
  const bedroomCounts = new Map<number, number>();
  for (const slot of slots) bedroomCounts.set(slot.bedrooms, (bedroomCounts.get(slot.bedrooms) ?? 0) + 1);
  const unitText = Array.from(bedroomCounts.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([bedrooms, count]) => (
      `${wordForSmallCount(count)} ${bedrooms} bedroom unit${count === 1 ? "" : "s"}`
    ))
    .join(" and ");
  const community = PROPERTY_UNIT_CONFIGS[propertyId]?.community
    ?? slots.find((slot) => slot.community)?.community
    ?? propertyName;
  return `Finding ${unitText || "buy-in units"} in ${community} and sub communities`;
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
  const launchParams = useMemo(() => operationsLaunchParams(), []);
  const focusedReservationId = launchParams.reservationId;
  const focusReservationScrolledRef = useRef(false);
  const [selectedPropertyId, setSelectedPropertyId] = useState<number | null>(() => launchParams.propertyId);
  const [selectedGuestyListingId, setSelectedGuestyListingId] = useState<string | null>(() => (
    launchParams.propertyId ? null : launchParams.listingId
  ));
  const [includePast, setIncludePast] = useState(() => launchParams.includePast);
  // When on, the bookings queries also return canceled/declined/inquiry/expired
  // reservations (badged in the UI) instead of the committed-only default.
  const [includeCanceled, setIncludeCanceled] = useState(false);
  const [reportMonth, setReportMonth] = useState(() => monthInputValue(new Date()));
  const emptyManualReservationForm = (): ManualReservationFormState => ({
    propertyId: selectedPropertyId?.toString() ?? "",
    guestName: "",
    guestEmail: "",
    guestPhone: "",
    checkIn: "",
    checkOut: "",
    totalRate: "",
    notes: "",
  });
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [manualForm, setManualForm] = useState<ManualReservationFormState>(() => emptyManualReservationForm());
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => (
    focusedReservationId ? { [focusedReservationId]: true } : {}
  ));
  const [picker, setPicker] = useState<
    | { reservation: GuestyReservation; slot: SlotInfo }
    | null
  >(null);
  const [manualBuyInTarget, setManualBuyInTarget] = useState<
    | { reservation: GuestyReservation; slot: SlotInfo; propertyId: number; propertyName: string }
    | null
  >(null);
  const [vrboGuestPageTarget, setVrboGuestPageTarget] = useState<
    | { reservation: GuestyReservation; propertyName: string }
    | null
  >(null);
  const [relocateGuestTarget, setRelocateGuestTarget] = useState<
    | { reservation: GuestyReservation }
    | null
  >(null);
  const [cancellationRange, setCancellationRange] = useState<"all" | "365" | "90">("all");
  const [verifyTarget, setVerifyTarget] = useState<
    | { buyIn: BuyIn; reservation: GuestyReservation }
    | null
  >(null);
  const [listingSitesTarget, setListingSitesTarget] = useState<
    | { buyIn: BuyIn; reservation: GuestyReservation; slot: SlotInfo }
    | null
  >(null);
  const [arrivalEditor, setArrivalEditor] = useState<BuyIn | null>(null);
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
  const [lastAutoFillAudits, setLastAutoFillAudits] = useState<Record<string, AutoFillSearchAudit[]>>({});
  const [cityInventoryScanTrigger, setCityInventoryScanTrigger] = useState<Record<string, number>>({});
  const rawReservationsRef = useRef<GuestyReservation[]>([]);

  const [bulkSelectedReservations, setBulkSelectedReservations] = useState<Record<string, boolean>>({});
  const [bulkBuyInQueueOpen, setBulkBuyInQueueOpen] = useState(false);
  const [bulkBuyInQueueItems, setBulkBuyInQueueItems] = useState<BulkBuyInQueueItem[]>([]);
  const [bulkBuyInQueueRunning, setBulkBuyInQueueRunning] = useState(false);
  const bulkBuyInCancelRef = useRef(false);

  // Sort controls: click a column header to sort by that field; click again
  // to toggle asc/desc. Default = check-in ascending (soonest first).
  type SortKey = "checkIn" | "guest" | "property" | "payout" | "buyIn" | "profit" | "status";
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
    queryKey: ["/api/guesty-listings-all?limit=100&maxPages=50&fields=_id%20nickname%20title%20isListed%20active%20isActive%20status%20bedrooms%20bedroomsCount%20bedroomCount%20beds%20accommodates%20personCapacity%20address.full%20address.city%20address.state%20address.street"],
    staleTime: 5 * 60_000,
  });
  const guestyListingId = (listing: GuestyListingSummary | null | undefined) =>
    String(listing?._id ?? listing?.id ?? "").trim();
  const unwrapGuestyListings = (d: any): GuestyListingSummary[] => {
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.results)) return d.results;
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d?.data?.results)) return d.data.results;
    return [];
  };
  const activeGuestyListings = useMemo(() => {
    return unwrapGuestyListings(guestyListings)
      .filter((listing) => {
        const status = String(listing.status ?? "").toLowerCase();
        const unavailable = /\b(?:archived|deleted|disabled)\b/.test(status);
        return guestyListingId(listing) && !unavailable;
      });
  }, [guestyListings]);
  const listingNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of unwrapGuestyListings(guestyListings)) {
      const id = guestyListingId(l);
      const name = l?.nickname ?? l?.title;
      if (id && name) map.set(id, name);
    }
    return map;
  }, [guestyListings]);
  const listingById = useMemo(() => {
    const map = new Map<string, GuestyListingSummary>();
    for (const l of unwrapGuestyListings(guestyListings)) {
      const id = guestyListingId(l);
      if (id) map.set(id, l);
    }
    return map;
  }, [guestyListings]);

  const sortedPropertyMap = useMemo(() => {
    return propertyMap
      .slice()
      .sort((a, b) => {
        const na = listingNameById.get(a.guestyListingId) ?? `~${a.propertyId}`;
        const nb = listingNameById.get(b.guestyListingId) ?? `~${b.propertyId}`;
        return na.localeCompare(nb);
      });
  }, [listingNameById, propertyMap]);

  const manualReservationPropertyMap = useMemo(() => {
    return sortedPropertyMap.filter((mapping) => {
      return (PROPERTY_UNIT_CONFIGS[mapping.propertyId]?.units?.length ?? 0) > 0;
    });
  }, [sortedPropertyMap]);

  const propertySelectOptions = useMemo<OperationsPropertyOption[]>(() => {
    const mappedListingIds = new Set(sortedPropertyMap.map((mapping) => mapping.guestyListingId));
    const mapped = sortedPropertyMap.map((mapping) => {
      const setup = buyInSetupLabelForOption(
        mapping.propertyId,
        listingById.get(mapping.guestyListingId),
        true,
      );
      return {
        value: String(mapping.propertyId),
        propertyId: mapping.propertyId,
        guestyListingId: mapping.guestyListingId,
        name: listingNameById.get(mapping.guestyListingId) ?? `Property ${mapping.propertyId}`,
        mapped: true,
        buyInConfigured: setup.configured,
        buyInSetupLabel: setup.label,
      };
    });
    const unmapped = activeGuestyListings
      .filter((listing) => !mappedListingIds.has(guestyListingId(listing)))
      .map((listing) => {
        const id = guestyListingId(listing);
        const setup = buyInSetupLabelForOption(null, listing, false);
        return {
          value: `guesty:${id}`,
          propertyId: null,
          guestyListingId: id,
          name: listing.nickname ?? listing.title ?? `Guesty listing ${id.slice(0, 8)}`,
          mapped: false,
          buyInConfigured: setup.configured,
          buyInSetupLabel: setup.label,
        };
    });
    return [...mapped, ...unmapped].sort((a, b) => a.name.localeCompare(b.name));
  }, [activeGuestyListings, listingById, listingNameById, sortedPropertyMap]);
  const globalPropertyTargets = useMemo(() => {
    return propertySelectOptions
      .filter((option) => option.buyInConfigured)
      .map((option) => ({
        guestyListingId: option.guestyListingId,
        propertyId: option.propertyId ?? virtualPropertyIdForGuestyListingId(option.guestyListingId),
        propertyName: option.name,
        mapped: option.mapped,
      }));
  }, [propertySelectOptions]);

  const selectedMapping = selectedPropertyId == null
    ? undefined
    : sortedPropertyMap.find((m) => m.propertyId === selectedPropertyId);
  const selectedListingId = selectedGuestyListingId ?? selectedMapping?.guestyListingId ?? null;
  const selectedHasBuyInConfig = selectedPropertyId != null
    && (PROPERTY_UNIT_CONFIGS[selectedPropertyId]?.units?.length ?? 0) > 0;
  const selectedGuestyOnlyOption = selectedGuestyListingId
    ? propertySelectOptions.find((option) => option.guestyListingId === selectedGuestyListingId)
    : undefined;
  const selectedDisplayName = selectedMapping
    ? listingNameById.get(selectedMapping.guestyListingId) ?? `Property ${selectedMapping.propertyId}`
    : selectedGuestyOnlyOption?.name ?? (selectedGuestyListingId ? `Guesty listing ${selectedGuestyListingId.slice(0, 8)}` : "");
  const isGlobalView = selectedPropertyId == null && selectedGuestyListingId == null;
  const selectedQueryPropertyId = selectedPropertyId
    ?? (selectedGuestyListingId ? virtualPropertyIdForGuestyListingId(selectedGuestyListingId) : null);

  const {
    data: bookingsData,
    isLoading: selectedBookingsLoading,
    isFetching: selectedBookingsFetching,
    isError: selectedBookingsError,
    error: selectedBookingsErr,
    refetch: refetchBookings,
  } = useQuery<{ reservations: GuestyReservation[]; total: number; unitSlots: UnitConfig[] }>({
    queryKey: ["/api/bookings/listing", selectedListingId, selectedQueryPropertyId, { includePast, includeCanceled }],
    queryFn: () => {
      if (!selectedListingId) {
        return Promise.resolve({ reservations: [], total: 0, unitSlots: [] });
      }
      const params = new URLSearchParams({ includePast: String(includePast) });
      if (includeCanceled) params.set("includeCanceled", "true");
      if (selectedQueryPropertyId) params.set("propertyId", String(selectedQueryPropertyId));
      const url = `/api/bookings/listing/${encodeURIComponent(selectedListingId)}?${params.toString()}`;
      return apiRequest("GET", url).then((r) => r.json());
    },
    enabled: !!selectedListingId,
    refetchInterval: 120_000,
  });

  const globalBookingsQuery = useQuery<{
    reservations: GuestyReservation[];
    total: number;
    listingCount: number;
    targetCount: number;
    missingListingIds?: string[];
  }>({
    queryKey: ["/api/bookings/guesty-all", { includePast, includeCanceled }],
    queryFn: () => apiRequest("GET", `/api/bookings/guesty-all?includePast=${includePast}${includeCanceled ? "&includeCanceled=true" : ""}`).then((r) => r.json()),
    enabled: isGlobalView,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const globalReservations = useMemo(() => {
    if (!isGlobalView) return [];
    return globalBookingsQuery.data?.reservations ?? [];
  }, [globalBookingsQuery.data?.reservations, isGlobalView]);

  const reservationPropertyMeta = useMemo(() => {
    const map = new Map<string, { propertyId: number; propertyName: string; guestyListingId: string; mapped: boolean }>();
    if (isGlobalView) {
      for (const reservation of globalBookingsQuery.data?.reservations ?? []) {
        const listingId = reservation.operationsListingId ?? reservation.listingId ?? "";
        if (!listingId) continue;
        map.set(reservation._id, {
          propertyId: reservation.operationsPropertyId ?? virtualPropertyIdForGuestyListingId(listingId),
          propertyName: reservation.operationsPropertyName ?? listingNameById.get(listingId) ?? `Guesty listing ${listingId.slice(0, 8)}`,
          guestyListingId: listingId,
          mapped: reservation.operationsMapped === true,
        });
      }
      return map;
    }
    if (selectedMapping) {
      const propertyName = listingNameById.get(selectedMapping.guestyListingId) ?? `Property ${selectedMapping.propertyId}`;
      for (const reservation of bookingsData?.reservations ?? []) {
        map.set(reservation._id, {
          propertyId: selectedMapping.propertyId,
          propertyName,
          guestyListingId: selectedMapping.guestyListingId,
          mapped: true,
        });
      }
    }
    return map;
  }, [bookingsData?.reservations, globalBookingsQuery.data?.reservations, isGlobalView, listingNameById, selectedMapping]);

  const globalBookingsLoading = isGlobalView && (globalBookingsQuery.isLoading || globalBookingsQuery.isFetching);
  const globalBookingsError = isGlobalView && globalBookingsQuery.isError;
  const globalBookingsErr = globalBookingsQuery.error;
  const bookingsLoading = isGlobalView ? globalBookingsLoading : (selectedBookingsLoading || selectedBookingsFetching);
  const bookingsError = isGlobalView ? globalBookingsError : selectedBookingsError;
  const bookingsErr = isGlobalView ? globalBookingsErr : selectedBookingsErr;

  const rawReservations = isGlobalView ? globalReservations : (bookingsData?.reservations ?? []);
  const unitSlots = isGlobalView ? [] : (bookingsData?.unitSlots ?? []);
  const hasBuyInSlots = unitSlots.length > 0;
  useEffect(() => { rawReservationsRef.current = rawReservations; }, [rawReservations]);
  const selectedBuyInPropertyId = !isGlobalView
    ? ((bookingsData as any)?.propertyId ?? selectedQueryPropertyId)
    : null;
  const buyInPropertyMetaForReservation = (reservation: GuestyReservation) => {
    const meta = reservationPropertyMeta.get(reservation._id);
    const propertyId = meta?.propertyId ?? selectedBuyInPropertyId ?? selectedQueryPropertyId;
    if (!propertyId) return null;
    return {
      propertyId,
      propertyName: meta?.propertyName || selectedDisplayName || `Property ${propertyId}`,
    };
  };

  const {
    data: cancellationsData,
    isLoading: cancellationsLoading,
    isError: cancellationsError,
    error: cancellationsErr,
  } = useQuery<{ propertyId: number; audits: ReservationCancellationAudit[] }>({
    queryKey: ["/api/operations/cancellations", selectedPropertyId],
    queryFn: () => {
      if (!selectedPropertyId) return Promise.resolve({ propertyId: 0, audits: [] });
      return apiRequest("GET", `/api/operations/cancellations?propertyId=${selectedPropertyId}`).then((r) => r.json());
    },
    enabled: !!selectedPropertyId && !isGlobalView,
    refetchInterval: 120_000,
  });

  const cancellationScanMutation = useMutation({
    mutationFn: () => {
      if (!selectedPropertyId) throw new Error("No property selected");
      return apiRequest("POST", "/api/operations/cancellations/scan", {
        propertyId: selectedPropertyId,
        range: cancellationRange,
      }).then((r) => r.json());
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/operations/cancellations", selectedPropertyId] });
      toast({
        title: "Cancelled bookings scanned",
        description: `${data?.saved ?? 0} cancellation audit row${data?.saved === 1 ? "" : "s"} refreshed from Guesty.`,
      });
    },
    onError: (e: any) => toast({ title: "Cancellation scan failed", description: e.message, variant: "destructive" }),
  });

  const cancellationUpdateMutation = useMutation({
    mutationFn: ({ id, operatorStatus, operatorNotes }: { id: number; operatorStatus?: string; operatorNotes?: string }) =>
      apiRequest("PATCH", `/api/operations/cancellations/${id}`, { operatorStatus, operatorNotes }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/operations/cancellations", selectedPropertyId] });
    },
    onError: (e: any) => toast({ title: "Cancellation update failed", description: e.message, variant: "destructive" }),
  });

  const estimateRemainingBuyInCost = (reservation: GuestyReservation, propertyId: number | null | undefined): number => {
    if (!propertyId) return 0;
    const config = PROPERTY_UNIT_CONFIGS[propertyId];
    if (!config) return 0;
    const openSlots = reservation.slots
      .filter((slot) => !slot.buyIn)
      .map((slot) => ({ bedrooms: slot.bedrooms }));
    if (openSlots.length === 0) return 0;
    const checkInDate = parseLocalDate(checkInOf(reservation));
    const yearMonth = checkInDate ? monthInputValue(checkInDate) : monthInputValue(new Date());
    return totalNightlyBuyInForMonth(config.community, openSlots, yearMonth, propertyId) * getReservationNights(reservation);
  };

  // Apply the current sort to the reservations before we render. Memoized so
  // a click on an attach button doesn't re-sort the entire list.
  const reservations = useMemo(() => {
    const list = [...rawReservations];
    const dir = sortDir === "asc" ? 1 : -1;
    const checkInTime = (reservation: GuestyReservation) => {
      const parsed = Date.parse(checkInOf(reservation) ?? "");
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    };
    list.sort((a, b) => {
      const diff = (() => {
        switch (sortBy) {
          case "checkIn": {
            return checkInTime(a) - checkInTime(b);
          }
          case "guest": {
            const an = (a.guest?.fullName ?? a.guest?.firstName ?? "").toLowerCase();
            const bn = (b.guest?.fullName ?? b.guest?.firstName ?? "").toLowerCase();
            return an.localeCompare(bn);
          }
          case "property": {
            const an = (reservationPropertyMeta.get(a._id)?.propertyName ?? "").toLowerCase();
            const bn = (reservationPropertyMeta.get(b._id)?.propertyName ?? "").toLowerCase();
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
  }, [rawReservations, reservationPropertyMeta, sortBy, sortDir]);

  // Persistent "guest already messaged about the move" status for the visible
  // rows, so the booking row shows a durable "Guest messaged ✓" badge (the
  // send dialog's own "Sent" state is per-token and vanishes once it closes).
  const visibleReservationIds = useMemo(() => reservations.map((r) => r._id), [reservations]);
  const relocationSentStatusQuery = useQuery<{ statuses: Record<string, RelocationSentStatus | null> }>({
    queryKey: ["/api/booking-alternatives/sent-status", visibleReservationIds],
    queryFn: async () => {
      const resp = await apiRequest("POST", "/api/booking-alternatives/sent-status", {
        reservationIds: visibleReservationIds,
      });
      return resp.json();
    },
    enabled: visibleReservationIds.length > 0,
    staleTime: 30_000,
  });
  const relocationSentStatus = relocationSentStatusQuery.data?.statuses ?? {};

  useEffect(() => {
    if (!focusedReservationId) return;
    const reservationIsVisible = reservations.some((reservation) => reservation._id === focusedReservationId);
    if (!reservationIsVisible) return;

    setExpanded((prev) => (
      prev[focusedReservationId] ? prev : { ...prev, [focusedReservationId]: true }
    ));

    if (focusReservationScrolledRef.current) return;
    focusReservationScrolledRef.current = true;
    const timer = window.setTimeout(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>("[data-reservation-id]"))
        .find((element) => element.dataset.reservationId === focusedReservationId);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [focusedReservationId, reservations]);

  const createManualReservationMutation = useMutation({
    mutationFn: (payload: ManualReservationFormState) =>
      apiRequest("POST", "/api/manual-reservations", {
        propertyId: Number(payload.propertyId),
        guestName: payload.guestName,
        guestEmail: payload.guestEmail,
        guestPhone: payload.guestPhone,
        checkIn: payload.checkIn,
        checkOut: payload.checkOut,
        totalRate: payload.totalRate,
        notes: payload.notes,
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing"] });
      setManualDialogOpen(false);
      setManualForm(emptyManualReservationForm());
      toast({ title: "Manual reservation added" });
    },
    onError: (e: any) => toast({ title: "Manual reservation failed", description: e.message, variant: "destructive" }),
  });

  const [forceDialog, setForceDialog] = useState<ForceDialogState | null>(null);
  const [forceConfirming, setForceConfirming] = useState(false);

  const attachMutation = useMutation({
    mutationFn: ({ reservationId, buyInId, force, overrideNote }: { reservationId: string; buyInId: number; force?: boolean; overrideNote?: string }) =>
      apiRequest("POST", `/api/bookings/${reservationId}/attach-buy-in`, { buyInId, force, overrideNote }).then((r) => r.json()),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      setPicker(null);
      setForceDialog(null);
      setForceConfirming(false);
      toast({ title: vars?.force ? "Buy-in attached (force override recorded)" : "Buy-in attached" });
    },
    onError: (e: any) => {
      const msg = String(e?.message ?? e ?? "");
      // Let the caller decide whether to open the force dialog for low-confidence cases.
      // Raw toasts for other errors (proximity, verified, etc.) still surface here if not intercepted.
      if (!/confidence too low|force override/i.test(msg)) {
        toast({ title: "Attach failed", description: e?.message ?? String(e), variant: "destructive" });
      }
    },
  });

  const requestForceAttach = (s: ForceDialogState) => {
    setForceDialog(s);
    setForceConfirming(false);
  };

  const performForceAttach = (note: string) => {
    if (!forceDialog) return;
    setForceConfirming(true);
    attachMutation.mutate({
      reservationId: forceDialog.reservationId,
      buyInId: forceDialog.buyInId,
      force: true,
      overrideNote: note,
    });
  };

  const guestAlternativePageMutation = useMutation({
    mutationFn: async ({ reservation, slot, buyIn }: { reservation: GuestyReservation; slot: SlotInfo; buyIn: BuyIn }) => {
      // Present the FULL alternative combination the operator attached (e.g. a
      // city-wide VRBO pair), not just the clicked slot — the guest message
      // refers to "the properties in this combination." Each unit carries its
      // own VRBO listing photos (from the Manual photo URLs marker) and gets an
      // AI-written description server-side.
      const attachedSlots = reservation.slots.filter(
        (s): s is SlotInfo & { buyIn: BuyIn } => !!s.buyIn,
      );
      const slotsForPage = attachedSlots.length
        ? attachedSlots
        : [{ ...slot, buyIn }];
      const proximity = attachedSlots.length >= 2
        ? await apiGetJson<UnitProximityResponse>(
            `/api/bookings/${encodeURIComponent(reservation._id)}/unit-proximity`,
          ).catch(() => null)
        : null;
      const readyProximity = proximity?.status === "ready" ? proximity : null;
      const originalCommunity = cleanGuestAlternativeLabel(
        readyProximity?.community ?? originalCommunityForAlternativePage(reservation, slotsForPage),
      );
      const originalCommunityName = originalCommunityForAlternativePage(reservation, slotsForPage);
      const originalArea = originalAreaForAlternativePage(reservation, slotsForPage);
      const sharedAlternativeCommunity = usableGuestAlternativeCommunity(readyProximity?.resortName);
      const alternatives = slotsForPage.map((s) => {
        const b = s.buyIn;
        const photoUrls = manualBuyInPhotoUrlsFromNotes(b.notes);
        const listingTitle = titleFromBuyInNotes(b.notes);
        const alternativeCommunity = alternativeCommunityFromBuyInNotes(b.notes, listingTitle)
          || sharedAlternativeCommunity
          || cleanGuestAlternativeLabel(b.propertyName);
        return {
          title: listingTitle,
          community: alternativeCommunity,
          originalCommunity: originalCommunityName || originalCommunity,
          alternativeCommunity,
          url: b.airbnbListingUrl,
          image: photoUrls[0] ?? "",
          photos: photoUrls,
          bedrooms: s.bedrooms,
          unitLabel: b.unitLabel,
          address: b.unitAddress,
          sourceLabel: sourceLabelForUrl(b.airbnbListingUrl),
          notes: b.notes,
        };
      });
      const primaryAlternativeCommunity = alternatives.find((item) => {
        const label = usableGuestAlternativeCommunity(item.alternativeCommunity);
        return label && label !== originalArea && label !== originalCommunityName;
      })?.alternativeCommunity || alternatives[0]?.alternativeCommunity || sharedAlternativeCommunity || "";
      const response = await apiRequest("POST", "/api/booking-alternatives", {
        reservationId: reservation._id,
        guestName: reservation.guest?.fullName ?? reservation.guest?.firstName ?? "Guest",
        checkIn: checkInOf(reservation),
        checkOut: checkOutOf(reservation),
        originalCommunity: originalCommunityName || originalCommunity,
        areaName: originalArea || originalCommunity,
        alternativeCommunity: primaryAlternativeCommunity,
        unitWalkMinutes: readyProximity?.walk?.minutes ?? null,
        walkMinutes: readyProximity?.walk?.minutes ?? null,
        alternatives,
      }).then((r) => r.json());
      if (!response?.url) throw new Error(response?.message || response?.error || "Alternative page create failed");
      return response as { url: string; expiresAt?: string };
    },
    onSuccess: async (data) => {
      try {
        await navigator.clipboard?.writeText(data.url);
        toast({ title: "Guest page ready", description: "Link copied and opened for review." });
      } catch {
        toast({ title: "Guest page ready", description: "Opened for review. Copy the URL from the new tab if needed." });
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
    },
    onError: (e: any) => toast({ title: "Guest page failed", description: e?.message ?? String(e), variant: "destructive" }),
  });

  const detachMutation = useMutation({
    mutationFn: ({ buyInId }: { buyInId: number; reservationId: string }) =>
      apiRequest("POST", `/api/bookings/detach-buy-in/${buyInId}`).then((r) => r.json()),
    onMutate: ({ reservationId }) => {
      setLastAutoFillCombos((prev) => {
        const next = { ...prev };
        delete next[reservationId];
        return next;
      });
      setLastAutoFillAudits((prev) => {
        const next = { ...prev };
        delete next[reservationId];
        return next;
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      toast({ title: "Buy-in detached" });
    },
    onError: (e: any) => toast({ title: "Detach failed", description: e.message, variant: "destructive" }),
  });

  const attachComboMutation = useMutation({
    mutationFn: async ({ reservation, option }: { reservation: GuestyReservation; option: AutoFillComboOption }) => {
      if (option.totalCost == null || option.picks.length !== reservation.slots.length) {
        throw new Error("This combo does not have a complete priced unit set to attach.");
      }
      const meta = reservationPropertyMeta.get(reservation._id);
      const propertyId = meta?.propertyId ?? selectedBuyInPropertyId ?? selectedQueryPropertyId;
      if (!propertyId) throw new Error("No property selected for this booking.");
      const propertyName = meta?.propertyName || selectedDisplayName || `Property ${propertyId}`;
      const toDateOnly = (s: string | undefined): string => {
        if (!s) return "";
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.slice(0, 10);
      };
      const ci = toDateOnly(reservation.checkInDateLocalized ?? reservation.checkIn);
      const co = toDateOnly(reservation.checkOutDateLocalized ?? reservation.checkOut);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ci) || !/^\d{4}-\d{2}-\d{2}$/.test(co)) {
        throw new Error("Combo attach needs valid check-in/check-out dates.");
      }

      for (const slot of reservation.slots) {
        if (!slot.buyIn?.id) continue;
        await apiRequest("POST", `/api/bookings/detach-buy-in/${slot.buyIn.id}`).then((r) => r.json());
      }

      const created: any[] = [];
      for (let index = 0; index < reservation.slots.length; index++) {
        const slot = reservation.slots[index];
        const pick = option.picks[index];
        const cost = Number(pick.totalPrice);
        if (!Number.isFinite(cost) || cost <= 0) {
          throw new Error(`${option.label} has an invalid price for ${slot.unitLabel}.`);
        }
        const anchorSuffix = pick.airbnbAnchorUrl && pick.airbnbAnchorPrice
          ? ` · Airbnb anchor: $${pick.airbnbAnchorPrice.toLocaleString()} (${pick.airbnbAnchorUrl}).`
          : "";
        const directProofSuffix = pick.directProof
          ? ` · Direct proof: ${pick.directProof.summary}`
          : "";
        const lensProvenanceSuffix = pick.airbnbAnchorUrl
          ? " · Found via Airbnb Google Lens search."
          : "";
        const evidenceUrls = Array.from(new Set([
          ...(pick.alternateUrls ?? []),
          pick.airbnbAnchorUrl,
          ...(pick.photoMatches ?? []).map((match) => match.url),
          pick.image,
        ].filter((url): url is string => !!url && listingUrlKey(url) !== listingUrlKey(pick.url)))).slice(0, 8);
        const identitySuffix = evidenceUrls.length > 0
          ? ` · Same-unit evidence: ${evidenceUrls.join(" ")}`
          : "";
        const createdBuyIn = await apiRequest("POST", "/api/buy-ins", {
          propertyId,
          propertyName,
          unitId: slot.unitId,
          unitLabel: slot.unitLabel,
          checkIn: ci,
          checkOut: co,
          costPaid: cost.toFixed(2),
          airbnbConfirmation: null,
          airbnbListingUrl: pick.url,
          groundFloorStatus: pick.groundFloorStatus ?? "unknown",
          groundFloorEvidence: pick.groundFloorEvidence ?? null,
          notes: `Manually attached from combo ${option.label} — ${pick.bedrooms}BR ${pick.sourceLabel} — ${pick.title} · Selected from saved auto-fill comparison for ${ci}→${co}.${anchorSuffix}${lensProvenanceSuffix}${directProofSuffix}${identitySuffix}${buyInPhotoNotesSuffix([pick.image, ...(pick.images ?? [])])}`,
          status: "active",
        }).then((r) => r.json());
        if (!createdBuyIn?.id) throw new Error(`Create failed for ${slot.unitLabel}`);
        await apiRequest("POST", `/api/bookings/${reservation._id}/attach-buy-in`, {
          buyInId: createdBuyIn.id,
        }).then((r) => r.json());
        created.push(createdBuyIn);
      }
      return { reservation, option, created };
    },
    onSuccess: ({ reservation, option }) => {
      const listingId = reservation.operationsListingId ?? reservation.listingId ?? selectedListingId;
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", listingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing"] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      setLastAutoFillCombos((prev) => ({
        ...prev,
        [reservation._id]: (prev[reservation._id] ?? []).map((combo) => ({
          ...combo,
          selected: combo.label === option.label,
        })),
      }));
      toast({
        title: `Attached ${option.label}`,
        description: `Replaced this booking's buy-ins with the selected combo: ${fmtMoney(option.totalCost)}.`,
      });
    },
    onError: (e: any) => toast({ title: "Combo attach failed", description: e.message, variant: "destructive" }),
    onSettled: (_data, _err, variables) => {
      // Keep the row in the "searching/attaching" state until the detach+recreate
      // settles, so the nearby-city expansion's auto-attach doesn't re-enable the
      // Auto-fill button mid-flight (a no-op for the manual panel attach paths,
      // whose reservations aren't tracked). See handleExpansionResolved.
      if (variables?.reservation?._id) stopTrackingAutoFill(variables.reservation._id);
    },
  });

  const saveArrivalDetails = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<BuyIn> }) =>
      apiRequest("PATCH", `/api/buy-ins/${id}`, data).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      setArrivalEditor(null);
      toast({ title: "Arrival details saved" });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  // Auto-fill: for every empty slot on a reservation, search live sources,
  // pick the cheapest priced candidate, create the buy-in, and attach it.
  // Collapses the 6-click flow (expand → Find → scroll → Record → Save → ...)
  // into a single button per booking.
  const [autoFillStartedByReservation, setAutoFillStartedByReservation] = useState<Record<string, number>>({});
  const [autoFillConfirmation, setAutoFillConfirmation] = useState<BuyInSearchConfirmationPayload | null>(null);
  const [autoFillConfirmationOpen, setAutoFillConfirmationOpen] = useState(false);
  const [autoFillConfirmationDiagnostics, setAutoFillConfirmationDiagnostics] = useState<FindBuyInDiagnostics | null>(null);
  const [autoFillConfirmationDiagnosticsOpen, setAutoFillConfirmationDiagnosticsOpen] = useState(false);
  const autoFillRunRef = useRef<Set<string>>(new Set());
  // Auto-fill runs that were interrupted by a transient/connection failure
  // (the classic case: iOS Safari backgrounded the tab and tore down the
  // in-flight fetch). Keyed by reservation id; the visibility-resume effect
  // below re-fires these when the operator returns to the foreground so the
  // search picks up where it left off (server recovery cache) instead of the
  // operator finding it silently stalled. Cleared on clean success.
  const autoFillResumeRef = useRef<Map<string, { reservation: GuestyReservation; propertyId?: number | null; listingId?: string | null }>>(new Map());

  // ── Nearby-city combo expansion (background job) per-reservation state ──────
  type ExpansionJobState = {
    jobId: string;
    // Matches the server's CityExpansionJobStatus.status. While the job is in
    // expansionJobs it's pending/running (terminal states are handled by
    // handleExpansionResolved, which snapshots + clears the row).
    status: "pending" | "running" | "found" | "exhausted" | "worker_offline" | "error";
    tier: number | null;
    currentCity: string | null;
    citiesSearched: string[];
    scannedCount: number;
    totalCount: number;
    message?: string;
    // Per-city, per-tier results (tier 1 = within 20 min, tier 2 = within 45 min)
    // so the escalation tracker can show each nearby city's pass/fail live.
    cityResults: CityExpansionCityResult[];
  };
  const [expansionJobs, setExpansionJobs] = useState<Record<string, ExpansionJobState>>({});
  // Server-side auto-fill jobs keyed by reservation id (one live job per row).
  // The job owns the whole escalation ladder + the attach; this map just tells
  // the row which job to mount AutoFillJobPoller for.
  const [autoFillJobs, setAutoFillJobs] = useState<Record<string, { jobId: string; reservationId: string }>>({});
  const autoFillJobMetaRef = useRef<
    Record<string, { reservation: GuestyReservation; propertyId?: number | null; listingId?: string | null; silent?: boolean }>
  >({});

  // ── Buy-in search-escalation tracker (the 4-stage ladder the operator sees) ──
  // resort search → home city → cities within 20 min → cities within 45 min.
  // Stages 1-2 are recorded live by the auto-fill mutation; stages 3-4 derive
  // from the expansion job above. Types + UI live at module scope
  // (BuyInEscalation / BuyInEscalationStages). Keyed by reservation id.
  const [escalationByReservation, setEscalationByReservation] = useState<Record<string, BuyInEscalation>>({});
  const setEscalation = (reservationId: string, patch: Partial<BuyInEscalation>) => {
    setEscalationByReservation((prev) => ({
      ...prev,
      [reservationId]: {
        resort: "idle",
        homeCity: "idle",
        foundAt: null,
        startedAt: Date.now(),
        ...(prev[reservationId] ?? {}),
        ...patch,
      },
    }));
  };
  const clearEscalation = (reservationId: string) => {
    setEscalationByReservation((prev) => {
      if (!(reservationId in prev)) return prev;
      const next = { ...prev };
      delete next[reservationId];
      return next;
    });
  };
  // Carries the originating mutate() variables (+ the reservation) so the poller
  // resolver can attach the found combo or re-invoke the per-slot safety net with
  // the same property/listing/silent context the original auto-fill used.
  const expansionJobMetaRef = useRef<
    Record<string, { reservation: GuestyReservation; propertyId?: number | null; listingId?: string | null; silent?: boolean }>
  >({});
  // Latest reservations snapshot, so the resolver can re-check slot state against
  // fresh data (no-clobber guard) without a stale render closure.
  const reservationsRef = useRef<GuestyReservation[]>([]);
  useEffect(() => {
    reservationsRef.current = reservations;
  }, [reservations]);
  const clearExpansionJob = (reservationId: string) => {
    setExpansionJobs((prev) => {
      if (!(reservationId in prev)) return prev;
      const next = { ...prev };
      delete next[reservationId];
      return next;
    });
    delete expansionJobMetaRef.current[reservationId];
  };

  const clearAutoFillDiagnostics = (reservationId: string) => {
    setLastAutoFillCombos((prev) => {
      if (!(reservationId in prev)) return prev;
      const next = { ...prev };
      delete next[reservationId];
      return next;
    });
    setLastAutoFillAudits((prev) => {
      if (!(reservationId in prev)) return prev;
      const next = { ...prev };
      delete next[reservationId];
      return next;
    });
    clearEscalation(reservationId);
  };
  const stopTrackingAutoFill = (reservationId?: string) => {
    if (!reservationId) {
      autoFillRunRef.current.clear();
      setAutoFillStartedByReservation({});
      return;
    }
    autoFillRunRef.current.delete(reservationId);
    setAutoFillStartedByReservation((prev) => {
      if (!(reservationId in prev)) return prev;
      const next = { ...prev };
      delete next[reservationId];
      return next;
    });
  };
  const autoFillMutation = useMutation({
    onMutate: ({ reservation }) => {
      clearAutoFillDiagnostics(reservation._id);
    },
    mutationFn: async ({
      reservation,
      propertyId,
      listingId,
      skipExpansion = false,
      awaitExpansionInline = false,
    }: {
      reservation: GuestyReservation;
      propertyId?: number | null;
      listingId?: string | null;
      silent?: boolean;
      // skipExpansion: re-invocation after a nearby-city expansion ended with no
      //   combo — run the per-slot + single-unit safety net WITHOUT starting
      //   another expansion job (prevents a loop).
      // awaitExpansionInline: bulk-queue path — poll the expansion job to
      //   terminal inside this mutation so result.results stays correct for the
      //   bulk pass/fail reporting (interactive path hands the job off instead).
      skipExpansion?: boolean;
      awaitExpansionInline?: boolean;
    }) => {
      const buyInPropertyId = propertyId ?? selectedBuyInPropertyId;
      const buyInListingId = listingId ?? selectedListingId;
      const staticPropertyId = buyInPropertyId && buyInPropertyId > 0 ? buyInPropertyId : selectedPropertyId;
      const staticUnitConfig = staticPropertyId ? PROPERTY_UNIT_CONFIGS[staticPropertyId] : undefined;
      if (!buyInPropertyId) throw new Error("No property selected");
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

      const groundFloorRequirement = staticUnitConfig && staticPropertyId
        ? await apiRequest(
            "GET",
            groundFloorRequirementHref(reservation, staticPropertyId),
          )
            .then((r) => r.json() as Promise<GroundFloorRequirement & { conversationId?: string | null }>)
            .catch((): GroundFloorRequirement => ({
              requested: false,
              scope: "none",
              requiredUnits: 0,
              confidence: "none",
              evidence: [],
              summary: "Ground-floor scan unavailable.",
            }))
        : ({
            requested: false,
            scope: "none",
            requiredUnits: 0,
            confidence: "none",
            evidence: [],
            summary: "Ground-floor scan skipped for auto-derived Guesty buy-in target.",
          } satisfies GroundFloorRequirement);
      const requiredGroundFloorUnits = Math.min(
        emptySlots.length,
        groundFloorRequirement.requested ? Math.max(1, groundFloorRequirement.requiredUnits) : 0,
      );
      const requiredGroundFloorBedrooms = new Set(
        groundFloorTargetBedrooms(groundFloorRequirement)
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0),
      );
      const requiresGroundFloorForBedrooms = (bedrooms: number): boolean => {
        if (requiredGroundFloorUnits <= 0) return false;
        if (requiredGroundFloorBedrooms.size > 0) return requiredGroundFloorBedrooms.has(bedrooms);
        return requiredGroundFloorUnits >= emptySlots.length && emptySlots.length > 0;
      };

      // ── Server-side auto-fill job (survives leaving the page) ──────────
      // The whole escalation ladder + the buy-in attach now run server-side
      // (server/auto-fill-job.ts), so the search keeps going and slots keep
      // filling even after the operator navigates away or backgrounds the tab.
      // We only START the job + hand it to the row poller here. See AGENTS.md
      // Load-Bearing "Auto-fill cheapest is a server-side background job".
      const autoFillCommunity =
        staticUnitConfig?.community
        ?? emptySlots.find((slot) => slot.community)?.community
        ?? "";
      const autoFillPropertyName =
        (buyInListingId ? listingNameById.get(buyInListingId) : undefined)
        || selectedDisplayName
        || `Property ${buyInPropertyId}`;
      const startResp = await apiRequest("POST", "/api/operations/auto-fill", {
        reservationId: reservation._id,
        propertyId: buyInPropertyId,
        listingId: buyInListingId ?? null,
        propertyName: autoFillPropertyName,
        community: autoFillCommunity || null,
        checkIn: ci,
        checkOut: co,
        slots: emptySlots.map((slot) => ({
          unitId: slot.unitId,
          unitLabel: slot.unitLabel,
          bedrooms: slot.bedrooms,
          community: slot.community ?? null,
        })),
        groundFloorBedrooms: Array.from(requiredGroundFloorBedrooms),
      }).then((r) => r.json());
      if (!startResp?.jobId) {
        throw new Error(startResp?.error || "Could not start the auto-fill search.");
      }
      if (awaitExpansionInline) {
        // Bulk path: poll the job to terminal inline so the pass/fail report below
        // (filled / skipped) reflects what actually attached server-side.
        const terminal = await pollAutoFillToTerminal(startResp.jobId);
        return autoFillResultFromJob(reservation, terminal);
      }
      // Interactive path: hand the job to the row poller and return now. The
      // poller mirrors job state into the escalation tracker + audits and
      // refreshes the bookings list as slots attach server-side.
      return {
        reservation,
        results: [],
        comboOptions: [],
        searchAudits: [],
        autoFillJob: { jobId: String(startResp.jobId), reservationId: reservation._id },
      } satisfies AutoFillMutationResult;
    },
    onSuccess: (payload, variables) => {
      const { reservation, results, comboOptions, searchAudits } = payload;
      // Completed cleanly (or handed off to the expansion poller) — drop any
      // pending mobile-resume entry so the visibility effect won't re-fire it.
      autoFillResumeRef.current.delete(reservation._id);
      const autoFillJob = "autoFillJob" in payload ? payload.autoFillJob : null;
      // Interactive handoff: the mutation started the server-side auto-fill job
      // and returned its handle. Register it so the row mounts AutoFillJobPoller
      // + progress UI, and DO NOT stopTrackingAutoFill (keeps the row "searching"
      // and the button disabled until the job resolves). The poller mirrors the
      // job's escalation/audits into the row and refreshes the bookings list as
      // slots attach server-side — so the search continues even if the operator
      // leaves this page entirely.
      if (autoFillJob) {
        autoFillJobMetaRef.current[reservation._id] = {
          reservation,
          propertyId: variables?.propertyId ?? null,
          listingId: variables?.listingId ?? null,
          silent: variables?.silent ?? false,
        };
        setAutoFillJobs((prev) => ({
          ...prev,
          [reservation._id]: { jobId: autoFillJob.jobId, reservationId: reservation._id },
        }));
        return;
      }
      stopTrackingAutoFill(reservation._id);
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", variables?.listingId ?? selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      if (comboOptions.length > 0) {
        setLastAutoFillCombos((prev) => ({ ...prev, [reservation._id]: comboOptions }));
      } else {
        setLastAutoFillCombos((prev) => {
          if (!(reservation._id in prev)) return prev;
          const next = { ...prev };
          delete next[reservation._id];
          return next;
        });
      }
      if (searchAudits.length > 0) {
        setLastAutoFillAudits((prev) => ({ ...prev, [reservation._id]: searchAudits }));
      } else {
        setLastAutoFillAudits((prev) => {
          if (!(reservation._id in prev)) return prev;
          const next = { ...prev };
          delete next[reservation._id];
          return next;
        });
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
      const comboTargetResort = directBookingTargetResortName(
        PROPERTY_UNIT_CONFIGS[selectedBuyInPropertyId ?? 0]?.community
          ?? reservation.slots.find((slot) => slot.community)?.community
          ?? "",
      );
      const comboCommunity = PROPERTY_UNIT_CONFIGS[selectedBuyInPropertyId ?? 0]?.community
        ?? reservation.slots.find((slot) => slot.community)?.community
        ?? "";
      const comboSummary = comboOptions.length > 0
        ? ` · Compared ${comboOptions
            .map((option) => {
              if (comboOptionIsComplete(option, comboTargetResort, comboCommunity)) {
                return `${option.label}: ${fmtMoney(option.totalCost ?? 0)}`;
              }
              return `${option.label}: no complete combination`;
            })
            .join("; ")}${selectedCombo ? ` · Selected ${selectedCombo.label}` : ""}`
        : "";
      if (!variables?.silent && searchAudits.length > 0) {
        const guestName = reservation.guest?.fullName ?? reservation.guest?.firstName ?? "Guest";
        const checkInLabel = checkInOf(reservation) ?? "unknown check-in";
        const checkOutLabel = checkOutOf(reservation) ?? "unknown check-out";
        setAutoFillConfirmation({
          title: `Buy-in search confirmation: ${guestName}`,
          description: `Auto-fill searched ${searchAudits.length} bedroom group${searchAudits.length === 1 ? "" : "s"} for ${checkInLabel} -> ${checkOutLabel}.`,
          audits: searchAudits,
        });
        setAutoFillConfirmationOpen(true);
      }
      if (!variables?.silent && searchAudits.length > 0) {
        const comboTargetResortForScout = directBookingTargetResortName(
          PROPERTY_UNIT_CONFIGS[selectedBuyInPropertyId ?? 0]?.community
            ?? reservation.slots.find((slot) => slot.community)?.community
            ?? "",
        );
        const comboCommunityForScout = PROPERTY_UNIT_CONFIGS[selectedBuyInPropertyId ?? 0]?.community
          ?? reservation.slots.find((slot) => slot.community)?.community
          ?? "";
        const completeComboOptionsForScout = comboOptions.filter((option) =>
          comboOptionIsComplete(option, comboTargetResortForScout, comboCommunityForScout),
        );
        const noCompleteComboForScout = completeComboOptionsForScout.length === 0;
        const selectedComboForScout = completeComboOptionsForScout.find((option) => option.selected);
        const fallbackCostForScout = completeComboOptionsForScout
          .map((option) => option.totalCost)
          .filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost) && cost > 0)
          .sort((a, b) => a - b)[0] ?? null;
        const postFillAdvice = buildBuyInCancellationAdvice({
          reservation,
          audits: searchAudits,
          proposedCost: noCompleteComboForScout ? null : selectedComboForScout?.totalCost ?? fallbackCostForScout,
          noCompleteCombo: noCompleteComboForScout,
          attachableVerifiedCount: countAttachableBuyInCandidates(searchAudits),
        });
      }
      if (variables?.silent) return;
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
        const sourceSummary = `Airbnb ${sourceCounts.airbnb}, Vrbo ${sourceCounts.vrbo}, PM ${sourceCounts.pm}`;
        const unavailableDetailSummary = searchAudits
          .flatMap((audit) =>
            buyInSearchAvailabilityDetails(audit.counts, audit.diagnostics, audit.bedrooms, {
              onlyUnavailable: true,
              includeIssues: false,
            }).slice(0, 2).map((detail) => `${audit.bedrooms}BR ${detail}`),
          )
          .slice(0, 3)
          .join(" · ");
        toast({
          title: "No verified priced candidates",
          description: scanned > 0
            ? `Found ${scanned} scanned option${scanned === 1 ? "" : "s"} (${sourceSummary}), but ${priced === 0 ? "none had a live price" : "none were verified bookable"} for these dates.${unavailableDetailSummary ? ` ${unavailableDetailSummary}` : ""} Click a slot's chevron to audit the live results.`
            : `No source returned a candidate for these dates.${unavailableDetailSummary ? ` ${unavailableDetailSummary}` : ""} Click Find buy-in on a slot to retry the live search.`,
        });
      } else if (zeroCostFills.length === filled.length) {
        const hasVrboPick = filled.some((r) => /(?:^|\.)vrbo\.com/.test(r.picked?.url ?? ""));
        toast({
          title: hasVrboPick
            ? `Attached ${filled.length} Vrbo link${filled.length > 1 ? "s" : ""} for review`
            : `Attached ${filled.length} direct link${filled.length > 1 ? "s" : ""} for review`,
          description: (hasVrboPick
            ? `A source returned a review link without a usable price. Re-run live search before confirming with the guest.`
            : `A direct-link row did not have a usable Airbnb-backed price. Re-run live search before confirming with the guest.`)
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
    onError: (e: any, variables) => {
      stopTrackingAutoFill(variables?.reservation?._id);
      if (variables?.silent) return;
      const raw = String(e?.message ?? "");
      // Railway returns a 502 JSON envelope when the find-buy-in
      // handler exceeds its edge timeout. Translate that into an
      // operator-friendly retry hint instead of dumping JSON in the
      // toast. The server's per-source wall-budget should prevent
      // this in steady state — if you're still seeing 502s, it
      // means several sources are simultaneously slow.
      const is502 = /\b502\b/.test(raw) && /Application failed to respond/.test(raw);
      const isTransient = isTransientAutoFillErrorMessage(raw);
      // Transient/interrupted failures are the iOS-background signature: the
      // tab was suspended and the in-flight fetch was torn down ("Load failed").
      // If the reservation still has empty slots, remember it so the
      // visibility-resume effect re-fires on return (server recovery cache makes
      // it near-instant). When the tab is hidden right now, the operator can't
      // see a toast anyway and we'll auto-resume — so skip the alarming toast.
      const reservation = variables?.reservation;
      const stillHasEmptySlots = !!reservation?.slots?.some((s) => !s.buyIn);
      const willAutoResume = (is502 || isTransient) && !!reservation?._id && stillHasEmptySlots;
      if (willAutoResume && reservation) {
        autoFillResumeRef.current.set(reservation._id, {
          reservation,
          propertyId: variables?.propertyId ?? null,
          listingId: variables?.listingId ?? null,
        });
        if (typeof document !== "undefined" && document.visibilityState !== "visible") {
          return; // hidden tab — defer to the visibility-resume effect, no toast
        }
      }
      toast({
        title: is502 || isTransient ? "Search interrupted — retry in a moment" : "Auto-fill failed",
        description: is502 || isTransient
          ? "The buy-in search was interrupted while the app or sidecar was reconnecting. It will resume automatically when you return to this tab — or click Auto-fill cheapest again (the scan cache is warm, so it's fast)."
          : raw,
        variant: "destructive",
      });
    },
  });
  // Stable handle to the auto-fill mutation so the visibility-resume effect
  // (registered once) can call the latest mutate without re-subscribing.
  const autoFillMutationRef = useRef(autoFillMutation);
  autoFillMutationRef.current = autoFillMutation;
  // Mobile resilience: when the operator returns to this tab, re-fire any
  // auto-fill run that was interrupted while backgrounded (iOS suspended the
  // tab and dropped the in-flight fetch). The server keeps the completed scan
  // in its recovery cache (?recover=1), so the re-fire is near-instant instead
  // of restarting a full sidecar scan. Heavily guarded so it can never re-run a
  // search the operator abandoned: only runs flagged in autoFillResumeRef (a
  // transient error with empty slots remaining) are eligible, each entry is
  // consumed exactly once, rows already (re)running are skipped, and a slot
  // filled in the meantime cancels the resume.
  useEffect(() => {
    const resumeInterrupted = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (autoFillResumeRef.current.size === 0) return;
      const pending = Array.from(autoFillResumeRef.current.entries());
      for (const [reservationId, ctx] of pending) {
        autoFillResumeRef.current.delete(reservationId);
        if (autoFillRunRef.current.has(reservationId)) continue;
        const fresh = reservationsRef.current.find((x) => x._id === reservationId) ?? ctx.reservation;
        const stillHasEmptySlots = fresh.slots?.some((s) => !s.buyIn);
        if (!stillHasEmptySlots) continue;
        autoFillRunRef.current.add(reservationId);
        setAutoFillStartedByReservation((prev) => ({ ...prev, [reservationId]: Date.now() }));
        autoFillMutationRef.current.mutate({
          reservation: fresh,
          propertyId: ctx.propertyId,
          listingId: ctx.listingId,
        });
      }
    };
    window.addEventListener("focus", resumeInterrupted);
    document.addEventListener("visibilitychange", resumeInterrupted);
    return () => {
      window.removeEventListener("focus", resumeInterrupted);
      document.removeEventListener("visibilitychange", resumeInterrupted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rediscover server-side auto-fill jobs still running for the visible rows.
  // THIS is what makes the search survive a full page reload / navigating away
  // and back: the job keeps running on the server regardless of this tab, and
  // on return we re-attach the row's progress poller (and the slots that already
  // attached server-side are visible because the bookings list reflects the DB).
  useEffect(() => {
    let cancelled = false;
    const rediscover = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const ids = reservationsRef.current
        .filter((r) => (r.slotsFilled ?? 0) < (r.slotsTotal ?? 0))
        .map((r) => r._id)
        .filter((id) => !(id in autoFillJobs));
      if (ids.length === 0) return;
      try {
        const data = await apiGetJson<{ jobs: Record<string, AutoFillJobStatus> }>(
          `/api/operations/auto-fill/active?reservationIds=${encodeURIComponent(ids.join(","))}`,
        );
        if (cancelled) return;
        for (const [reservationId, status] of Object.entries(data?.jobs ?? {})) {
          if (!status || status.done) continue;
          const fresh = reservationsRef.current.find((x) => x._id === reservationId);
          if (!fresh) continue;
          autoFillRunRef.current.add(reservationId);
          setAutoFillStartedByReservation((prev) => (reservationId in prev ? prev : { ...prev, [reservationId]: Date.now() }));
          autoFillJobMetaRef.current[reservationId] = { reservation: fresh, silent: false };
          setAutoFillJobs((prev) => (reservationId in prev ? prev : { ...prev, [reservationId]: { jobId: status.jobId, reservationId } }));
          updateAutoFillJobState(reservationId, status);
        }
      } catch { /* best effort — a 401/404/network hiccup just means try again next tick */ }
    };
    void rediscover();
    const onFocus = () => void rediscover();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations]);

  // ── Server-side auto-fill job: poller wiring ──────────────────────────────
  const clearAutoFillJob = (reservationId: string) => {
    setAutoFillJobs((prev) => {
      if (!(reservationId in prev)) return prev;
      const next = { ...prev };
      delete next[reservationId];
      return next;
    });
    delete autoFillJobMetaRef.current[reservationId];
  };
  // Live progress tick from AutoFillJobPoller — mirror the server escalation +
  // audits/combos into the row's existing tracker UI.
  const updateAutoFillJobState = (reservationId: string, s: AutoFillJobStatus) => {
    setEscalation(reservationId, {
      resort: s.escalation.resort,
      resortLabel: s.escalation.resortLabel,
      homeCity: s.escalation.homeCity,
      homeCityTerm: s.escalation.homeCityTerm,
      homeCityListings: s.escalation.homeCityListings,
      foundAt: s.escalation.foundAt ?? null,
      nearbyStatus: s.escalation.nearbyStatus,
      tierResults: s.escalation.tierResults,
    });
    if (s.searchAudits?.length) setLastAutoFillAudits((prev) => ({ ...prev, [reservationId]: s.searchAudits }));
    if (s.comboOptions?.length) setLastAutoFillCombos((prev) => ({ ...prev, [reservationId]: s.comboOptions }));
  };
  // Terminal handler for the interactive auto-fill job. Slots are ALREADY
  // attached server-side; here we just refresh the lists so they render, clear
  // the row's running state, and toast the outcome.
  const handleAutoFillResolved = (reservationId: string, status: AutoFillJobStatus | null) => {
    const meta = autoFillJobMetaRef.current[reservationId];
    const silent = meta?.silent ?? false;
    if (status) updateAutoFillJobState(reservationId, status);
    clearAutoFillJob(reservationId);
    stopTrackingAutoFill(reservationId);
    queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", meta?.listingId ?? selectedListingId] });
    queryClient.invalidateQueries({ queryKey: ["/api/bookings/guesty-all"] });
    queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
    if (silent) return;
    if (!status) {
      toast({
        title: "Auto-fill search ended",
        description: "The background search was lost (server restart). Click Auto-fill cheapest to retry — the scan cache is warm, so it's fast.",
      });
      return;
    }
    if (status.status === "failed") {
      toast({ title: "Auto-fill failed", description: status.error || status.message, variant: "destructive" });
      return;
    }
    if (status.slotsFilled === 0) {
      toast({ title: "No verified priced candidates", description: status.message, variant: "destructive" });
    } else {
      toast({
        title: `Filled ${status.slotsFilled} / ${status.slotsTotal} unit${status.slotsTotal === 1 ? "" : "s"}`,
        description: status.message,
      });
    }
  };

  // Live progress tick from CityExpansionJobPoller (interactive path).
  const updateExpansionJobState = (reservationId: string, s: CityExpansionJobStatus) => {
    setExpansionJobs((prev) => {
      if (!(reservationId in prev)) return prev; // already resolved/cleared
      return {
        ...prev,
        [reservationId]: {
          jobId: s.jobId,
          status: s.status, // pending/running while polling; terminal handled by resolver
          tier: s.tier,
          currentCity: s.currentCity,
          citiesSearched: s.citiesSearched,
          scannedCount: s.scannedCount,
          totalCount: s.totalCount,
          cityResults: s.cityResults ?? [],
        },
      };
    });
  };

  // Terminal handler for the interactive expansion job. On a found pair, attach
  // it (no-clobber: only if the booking's slots are still all empty). Otherwise
  // run the per-slot + single-unit safety net via a skipExpansion re-invocation.
  const handleExpansionResolved = (reservationId: string, status: CityExpansionJobStatus | null) => {
    const meta = expansionJobMetaRef.current[reservationId];
    const silent = meta?.silent ?? false;
    const fresh = reservationsRef.current.find((x) => x._id === reservationId) ?? meta?.reservation ?? null;
    // Snapshot the final nearby-city ladder onto the escalation tracker BEFORE
    // clearing the job row, so the operator keeps seeing which towns were searched
    // (and where the pair was found) after the job is gone.
    if (status) {
      const nearbyStatus =
        status.status === "found" ? "found" as const
        : status.status === "worker_offline" ? "worker_offline" as const
        : status.status === "error" ? "error" as const
        : "exhausted" as const;
      setEscalation(reservationId, {
        resort: "no-pair",
        homeCity: "no-pair",
        tierResults: status.cityResults ?? [],
        nearbyStatus,
        ...(status.status === "found" ? { foundAt: "nearby" as const } : {}),
      });
    }
    clearExpansionJob(reservationId);

    // FOUND + auto-attachable: attach the nearby-city pair. Keep the row TRACKED
    // here — attachComboMutation.onSettled clears tracking once the detach+
    // recreate finishes, so the Auto-fill button can't be re-clicked mid-attach.
    if (status?.status === "found" && status.combo) {
      const option = cityComboOptionFromInventory(status.combo);
      if (option && fresh) {
        const slotsAllEmpty = fresh.slots.every((slot) => !slot.buyIn);
        const matchesSlots = option.picks.length === fresh.slots.length;
        if (slotsAllEmpty && matchesSlots) {
          attachComboMutation.mutate({ reservation: fresh, option });
          if (!silent) {
            toast({
              title: "Found a same-community pair nearby",
              description: `${option.label}${status.comboSourceCity ? ` · ${status.comboSourceCity}` : ""}`
                + `${status.driveMinutes != null ? ` (~${status.driveMinutes} min away)` : ""} — attaching.`,
            });
          }
          return;
        }
        // Found, but the booking changed during the multi-minute search (a slot
        // got filled, or the pair no longer fits). Don't clobber the operator's
        // picks — fall through to fill any STILL-empty slots with the per-slot
        // safety net.
        if (!silent) {
          toast({
            title: "Nearby pair found, but the booking changed",
            description: `${option.label}${status.comboSourceCity ? ` · ${status.comboSourceCity}` : ""}. `
              + "Filling any remaining empty slots individually instead.",
          });
        }
      }
    } else if (!silent) {
      if (status?.status === "worker_offline") {
        toast({
          title: "Nearby-city search unavailable",
          description: "The local Chrome sidecar is offline or VRBO is temporarily blocking. Retry shortly, or fill slots manually. Filling any open slots individually for now…",
          variant: "destructive",
        });
      } else {
        const searched = status?.citiesSearched?.length ?? 0;
        toast({
          title: "No nearby-city combo found",
          description: searched > 0
            ? `Searched ${searched} ${searched === 1 ? "city" : "cities"} within 45 min — no same-community pair. Filling slots individually…`
            : "No nearby cities yielded a same-community pair. Filling slots individually…",
        });
      }
    }

    // SAFETY NET (reached for: not-found, worker-offline, error, lost job, AND
    // found-but-not-attachable). Run the per-slot + single-unit fill for any
    // still-empty slots. skipExpansion ⇒ the re-invocation won't start another
    // expansion job (no loop). Don't clearAutoFillDiagnostics — the re-invoke's
    // onSuccess refreshes combos/audits anyway.
    stopTrackingAutoFill(reservationId);
    if (!fresh) return;
    if (fresh.slots.every((slot) => !!slot.buyIn)) return; // operator already filled everything
    autoFillRunRef.current.add(reservationId);
    setAutoFillStartedByReservation((prev) => ({ ...prev, [reservationId]: Date.now() }));
    autoFillMutation.mutate({
      reservation: fresh,
      propertyId: meta?.propertyId ?? undefined,
      listingId: meta?.listingId ?? undefined,
      silent,
      skipExpansion: true,
    });
  };

  const activeAutoFillStartedAt = Object.values(autoFillStartedByReservation);
  const activeAutoFillCount = activeAutoFillStartedAt.length;
  const earliestAutoFillStartedAtMs = activeAutoFillStartedAt.length > 0
    ? Math.min(...activeAutoFillStartedAt)
    : null;
  const autoFillSidecarQueue = useSidecarQueueStatus(activeAutoFillCount > 0);
  const autoFillSidecarActive = activeAutoFillCount > 0
    && isSidecarStatusForSearch(autoFillSidecarQueue.status, earliestAutoFillStartedAtMs);

  const bulkQueueItemsByReservationId = useMemo(() => {
    return new Map(bulkBuyInQueueItems.map((item) => [item.reservationId, item]));
  }, [bulkBuyInQueueItems]);
  const selectedBulkReservationCount = Object.values(bulkSelectedReservations).filter(Boolean).length;
  const eligibleGlobalReservations = useMemo(() => (
    reservations.filter((reservation) => {
      const meta = reservationPropertyMeta.get(reservation._id);
      return !!meta?.propertyId
        && reservation.slotsTotal > 0
        && reservation.slots.some((slot) => !slot.buyIn);
    })
  ), [reservationPropertyMeta, reservations]);
  const selectedBulkEligibleReservations = useMemo(() => (
    eligibleGlobalReservations.filter((reservation) => bulkSelectedReservations[reservation._id])
  ), [bulkSelectedReservations, eligibleGlobalReservations]);
  const setBulkQueueItem = (reservationId: string, patch: Partial<BulkBuyInQueueItem>) => {
    setBulkBuyInQueueItems((prev) => prev.map((item) => (
      item.reservationId === reservationId ? { ...item, ...patch } : item
    )));
  };
  const logBulkBuyInQueueEvent = async (
    item: BulkBuyInQueueItem,
    level: "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    try {
      await apiRequest("POST", "/api/operations/bulk-buy-in-log", {
        level,
        message,
        jobId: item.jobId,
        reservationId: item.reservationId,
        propertyId: item.propertyId,
        listingId: item.listingId,
        propertyName: item.propertyName,
        guestName: item.guestName,
        queuedFor: item.queuedFor,
        status: item.status,
        error: item.error,
        meta,
      });
    } catch (error) {
      console.warn("[bulk-buy-ins] failed to write server log", error);
    }
  };
  const buildBulkQueueItem = (reservation: GuestyReservation, jobId: string): BulkBuyInQueueItem | null => {
    const meta = reservationPropertyMeta.get(reservation._id);
    if (!meta?.propertyId) return null;
    const guestName = reservation.guest?.fullName ?? reservation.guest?.firstName ?? "Guest";
    return {
      id: `${jobId}:${reservation._id}`,
      jobId,
      reservationId: reservation._id,
      propertyId: meta.propertyId,
      listingId: meta.guestyListingId,
      propertyName: meta.propertyName,
      guestName,
      checkIn: checkInOf(reservation) ?? "",
      checkOut: checkOutOf(reservation) ?? "",
      queuedFor: bulkBuyInQueuedForText(reservation, meta.propertyName, meta.propertyId),
      status: "queued",
      message: "Queued",
      totalSlots: reservation.slots.filter((slot) => !slot.buyIn).length,
    };
  };
  const selectAllEligibleGlobalBookings = () => {
    setBulkSelectedReservations((prev) => {
      const next = { ...prev };
      for (const reservation of eligibleGlobalReservations) next[reservation._id] = true;
      return next;
    });
  };
  const clearBulkBookingSelection = () => setBulkSelectedReservations({});
  const cancelBulkBuyInQueue = () => {
    bulkBuyInCancelRef.current = true;
    setBulkBuyInQueueItems((prev) => prev.map((item) => (
      item.status === "queued"
        ? { ...item, status: "cancelled", message: "Cancelled before running", finishedAt: new Date().toISOString() }
        : item
    )));
  };
  const startBulkBuyInQueue = async () => {
    const jobId = `bulk-buy-in-${Date.now()}`;
    const queue = selectedBulkEligibleReservations
      .map((reservation) => buildBulkQueueItem(reservation, jobId))
      .filter((item): item is BulkBuyInQueueItem => !!item);
    if (queue.length === 0) {
      toast({
        title: "No eligible bookings selected",
        description: "Select bookings with open buy-in slots from the global All bookings table.",
      });
      return;
    }

    bulkBuyInCancelRef.current = false;
    setBulkBuyInQueueItems(queue);
    setBulkBuyInQueueOpen(true);
    setBulkBuyInQueueRunning(true);
    await Promise.all(queue.map((item) => logBulkBuyInQueueEvent(item, "info", "Bulk buy-in queue item queued")));

    for (const item of queue) {
      if (bulkBuyInCancelRef.current) {
        setBulkQueueItem(item.reservationId, {
          status: "cancelled",
          message: "Cancelled by operator",
          finishedAt: new Date().toISOString(),
        });
        await logBulkBuyInQueueEvent({ ...item, status: "cancelled", message: "Cancelled by operator" }, "warn", "Bulk buy-in queue item cancelled");
        continue;
      }

      const reservation = reservations.find((row) => row._id === item.reservationId);
      if (!reservation) {
        const message = "Reservation disappeared from the global list before it could run";
        setBulkQueueItem(item.reservationId, {
          status: "failed",
          message,
          error: message,
          finishedAt: new Date().toISOString(),
        });
        await logBulkBuyInQueueEvent({ ...item, status: "failed", error: message }, "error", message);
        continue;
      }

      setBulkQueueItem(item.reservationId, {
        status: "running",
        message: "Running buy-in search",
        startedAt: new Date().toISOString(),
      });
      autoFillRunRef.current.add(item.reservationId);
      clearAutoFillDiagnostics(item.reservationId);
      setAutoFillStartedByReservation((prev) => ({ ...prev, [item.reservationId]: Date.now() }));

      try {
        const result = await autoFillMutation.mutateAsync({
          reservation,
          propertyId: item.propertyId,
          listingId: item.listingId,
          silent: true,
          // Bulk runs sequentially and is already long-running, so it polls the
          // nearby-city expansion inline (rather than handing off to the row
          // poller) — keeps result.results correct for the pass/fail report below.
          awaitExpansionInline: true,
        });
        const filled = result.results.filter((row) => row.picked).length;
        const total = result.results.length;
        const failedReasons = result.results
          .flatMap((row) => row.skippedReasons)
          .filter(Boolean);
        if (filled === 0) {
          const message = failedReasons[0] ?? "No verified priced candidate was attached";
          const updated = {
            ...item,
            status: "failed" as const,
            message,
            error: failedReasons.join(" | ") || message,
            filled,
            totalSlots: total,
            finishedAt: new Date().toISOString(),
          };
          setBulkQueueItem(item.reservationId, updated);
          await logBulkBuyInQueueEvent(updated, "error", "Bulk buy-in queue item failed to attach any buy-ins", {
            reasons: failedReasons,
            searchAudits: result.searchAudits,
            comboOptions: result.comboOptions,
          });
          continue;
        }

        const updated = {
          ...item,
          status: filled === total ? "completed" as const : "skipped" as const,
          message: filled === total
            ? `Attached ${filled}/${total} buy-in${total === 1 ? "" : "s"}`
            : `Attached ${filled}/${total}; review remaining slots`,
          filled,
          totalSlots: total,
          finishedAt: new Date().toISOString(),
        };
        setBulkQueueItem(item.reservationId, updated);
        await logBulkBuyInQueueEvent(
          updated,
          filled === total ? "info" : "warn",
          filled === total ? "Bulk buy-in queue item completed" : "Bulk buy-in queue item partially completed",
          {
            searchAudits: result.searchAudits,
            comboOptions: result.comboOptions,
          },
        );
      } catch (error: any) {
        const raw = String(error?.message ?? error ?? "Unknown bulk buy-in error");
        const updated = {
          ...item,
          status: "failed" as const,
          message: raw,
          error: raw,
          finishedAt: new Date().toISOString(),
        };
        setBulkQueueItem(item.reservationId, updated);
        console.error("[bulk-buy-ins] queue item failed", updated, error);
        await logBulkBuyInQueueEvent(updated, "error", "Bulk buy-in queue item crashed", {
          stack: error?.stack,
        });
      }
    }

    setBulkBuyInQueueRunning(false);
    queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing"] });
    queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
    toast({ title: "Bulk buy-in queue finished" });
  };

  const toggleExpanded = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const stats = useMemo(() => {
    if (!reservations.length) return null;
    const fully = reservations.filter((r) => r.fullyLinked).length;
    const totalRevenue = reservations.reduce((s, r) => s + getNetRevenue(r), 0);
    // Only count fully-linked bookings' buy-in costs to keep profit math honest
    const linkedCost = reservations
      .filter((r) => r.fullyLinked)
      .reduce((s, r) => s + r.slots.reduce((ss, sl) => ss + parseFloat(String(sl.buyIn?.costPaid ?? 0)), 0), 0);
    const linkedRevenue = reservations
      .filter((r) => r.fullyLinked)
      .reduce((s, r) => s + getNetRevenue(r), 0);
    return {
      total: reservations.length,
      fully,
      partial: reservations.filter((r) => r.slotsFilled > 0 && !r.fullyLinked).length,
      totalRevenue,
      linkedCost,
      profit: linkedRevenue - linkedCost,
    };
  }, [reservations]);

  const financialRows = useMemo(() => {
    return reservations
      .map((reservation) => {
        const checkInDate = parseLocalDate(checkInOf(reservation));
        const meta = reservationPropertyMeta.get(reservation._id);
        const propertyId = meta?.propertyId ?? selectedPropertyId ?? null;
        const attachedBuyInCost = getBuyInCost(reservation);
        const remainingBuyInCost = estimateRemainingBuyInCost(reservation, propertyId);
        const grossRevenue = getGrossRevenue(reservation);
        const netRevenue = getNetRevenue(reservation);
        const fundsLeftToCollect = getFundsLeftToCollect(reservation);
        const openSlots = Math.max(0, reservation.slotsTotal - reservation.slotsFilled);
        return {
          reservation,
          checkInDate,
          propertyName: meta?.propertyName ?? (selectedMapping
            ? listingNameById.get(selectedMapping.guestyListingId) ?? `Property ${selectedMapping.propertyId}`
            : "Property"),
          propertyId,
          grossRevenue,
          netRevenue,
          attachedBuyInCost,
          remainingBuyInCost,
          totalExpectedBuyInCost: attachedBuyInCost + remainingBuyInCost,
          fundsLeftToCollect,
          expectedProfit: netRevenue - attachedBuyInCost - remainingBuyInCost,
          openSlots,
        };
      })
      .filter((row): row is {
        reservation: GuestyReservation;
        checkInDate: Date;
        propertyName: string;
        propertyId: number | null;
        grossRevenue: number;
        netRevenue: number;
        attachedBuyInCost: number;
        remainingBuyInCost: number;
        totalExpectedBuyInCost: number;
        fundsLeftToCollect: number;
        expectedProfit: number;
        openSlots: number;
      } => !!row.checkInDate);
  }, [listingNameById, reservationPropertyMeta, reservations, selectedMapping, selectedPropertyId]);

  const globalBookingMonthSections = useMemo(() => {
    if (!isGlobalView) return [];
    const order = new Map(reservations.map((reservation, index) => [reservation._id, index]));
    const buckets = new Map<string, typeof financialRows>();
    for (const row of financialRows) {
      const key = monthInputValue(row.checkInDate);
      const bucket = buckets.get(key) ?? [];
      bucket.push(row);
      buckets.set(key, bucket);
    }

    const summarize = (rows: typeof financialRows) => ({
      bookingCount: rows.length,
      revenue: rows.reduce((sum, row) => sum + row.netRevenue, 0),
      buyInCost: rows.reduce((sum, row) => sum + row.totalExpectedBuyInCost, 0),
      profit: rows.reduce((sum, row) => sum + row.expectedProfit, 0),
      openSlots: rows.reduce((sum, row) => sum + row.openSlots, 0),
    });

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => {
        const sortedRows = [...rows].sort((a, b) => {
          const ai = order.get(a.reservation._id) ?? Number.MAX_SAFE_INTEGER;
          const bi = order.get(b.reservation._id) ?? Number.MAX_SAFE_INTEGER;
          return ai - bi;
        });
        return {
          key,
          label: monthLabel(key),
          rows: sortedRows,
          totals: summarize(sortedRows),
        };
      });
  }, [financialRows, isGlobalView, reservations]);

  const globalBookingGrandTotals = useMemo(() => {
    if (!isGlobalView || globalBookingMonthSections.length === 0) return null;
    return globalBookingMonthSections.reduce(
      (totals, section) => ({
        bookingCount: totals.bookingCount + section.totals.bookingCount,
        revenue: totals.revenue + section.totals.revenue,
        buyInCost: totals.buyInCost + section.totals.buyInCost,
        profit: totals.profit + section.totals.profit,
        openSlots: totals.openSlots + section.totals.openSlots,
      }),
      { bookingCount: 0, revenue: 0, buyInCost: 0, profit: 0, openSlots: 0 },
    );
  }, [globalBookingMonthSections, isGlobalView]);

  const arrivalStats = useMemo(() => {
    const today = startOfLocalDay(new Date());
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const threeMonthEnd = new Date(today.getFullYear(), today.getMonth() + 3, 1);

    const upcoming = financialRows
      .filter((row) => startOfLocalDay(row.checkInDate).getTime() >= today.getTime())
      .sort((a, b) => a.checkInDate.getTime() - b.checkInDate.getTime());

    const thisMonth = upcoming.filter((row) => (
      row.checkInDate.getTime() >= monthStart.getTime()
      && row.checkInDate.getTime() < nextMonthStart.getTime()
    ));

    const attentionHorizon = isGlobalView
      ? upcoming.filter((row) => row.checkInDate.getTime() < threeMonthEnd.getTime())
      : upcoming;
    const missingBuyInReservations = attentionHorizon.filter((row) => !row.reservation.fullyLinked);
    const laterMissingBuyInReservations = isGlobalView
      ? upcoming.filter((row) => !row.reservation.fullyLinked && row.checkInDate.getTime() >= threeMonthEnd.getTime()).length
      : 0;
    const missingSlots = upcoming.reduce(
      (sum, row) => sum + Math.max(0, row.reservation.slotsTotal - row.reservation.slotsFilled),
      0,
    );
    const thisMonthMissing = thisMonth.filter((row) => !row.reservation.fullyLinked).length;
    const nextArrival = upcoming[0] ?? null;
    const nextArrivalBuyInCost = nextArrival?.totalExpectedBuyInCost ?? 0;
    const nextArrivalRemainingBuyInCost = nextArrival?.remainingBuyInCost ?? 0;

    return {
      nextArrival,
      attentionRows: missingBuyInReservations.slice(0, 6),
      upcomingCount: upcoming.length,
      missingBuyInReservations: missingBuyInReservations.length,
      missingSlots,
      nextArrivalBuyInCost,
      nextArrivalRemainingBuyInCost,
      thisMonthCount: thisMonth.length,
      thisMonthMissing,
      laterMissingBuyInReservations,
    };
  }, [financialRows, isGlobalView]);

  const monthlyReport = useMemo(() => {
    if (!isGlobalView) return null;
    const match = /^(\d{4})-(\d{2})$/.exec(reportMonth);
    if (!match) return null;
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const monthStart = new Date(year, monthIndex, 1);
    const nextMonthStart = new Date(year, monthIndex + 1, 1);

    const rows = financialRows
      .filter((row) => row.checkInDate.getTime() >= monthStart.getTime()
        && row.checkInDate.getTime() < nextMonthStart.getTime())
      .sort((a, b) => a.checkInDate.getTime() - b.checkInDate.getTime());

    const bookingCount = rows.length;
    const totalRevenue = rows.reduce((sum, row) => sum + row.netRevenue, 0);
    const totalGrossRevenue = rows.reduce((sum, row) => sum + row.grossRevenue, 0);
    const totalBuyInCost = rows.reduce((sum, row) => sum + row.attachedBuyInCost, 0);
    const totalRemainingBuyInCost = rows.reduce((sum, row) => sum + row.remainingBuyInCost, 0);
    const totalFundsLeftToCollect = rows.reduce((sum, row) => sum + row.fundsLeftToCollect, 0);
    const totalProfit = rows.reduce((sum, row) => sum + row.expectedProfit, 0);
    const fullyLinked = rows.filter((row) => row.reservation.fullyLinked).length;
    const openSlots = rows.reduce((sum, row) => sum + row.openSlots, 0);
    const notFullyBoughtIn = rows.filter((row) => !row.reservation.fullyLinked).length;
    const monthIsPast = nextMonthStart.getTime() <= new Date().setHours(0, 0, 0, 0);

    return {
      label: monthLabel(reportMonth),
      rows,
      bookingCount,
      totalRevenue,
      totalGrossRevenue,
      totalBuyInCost,
      totalRemainingBuyInCost,
      totalFundsLeftToCollect,
      totalProfit,
      fullyLinked,
      openSlots,
      notFullyBoughtIn,
      monthIsPast,
    };
  }, [financialRows, isGlobalView, reportMonth]);

  const nextThreeMonthReports = useMemo(() => {
    if (!isGlobalView) return [];
    const today = new Date();
    return Array.from({ length: 3 }, (_, index) => {
      const monthStart = new Date(today.getFullYear(), today.getMonth() + index, 1);
      const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + index + 1, 1);
      const monthKey = monthInputValue(monthStart);
      const rows = financialRows
        .filter((row) => row.checkInDate.getTime() >= monthStart.getTime()
          && row.checkInDate.getTime() < nextMonthStart.getTime())
        .sort((a, b) => a.checkInDate.getTime() - b.checkInDate.getTime());
      return {
        key: monthKey,
        label: monthLabel(monthKey),
        rows,
        bookingCount: rows.length,
        attachedBuyInCost: rows.reduce((sum, row) => sum + row.attachedBuyInCost, 0),
        remainingBuyInCost: rows.reduce((sum, row) => sum + row.remainingBuyInCost, 0),
        grossRevenue: rows.reduce((sum, row) => sum + row.grossRevenue, 0),
        netRevenue: rows.reduce((sum, row) => sum + row.netRevenue, 0),
        fundsLeftToCollect: rows.reduce((sum, row) => sum + row.fundsLeftToCollect, 0),
        expectedProfit: rows.reduce((sum, row) => sum + row.expectedProfit, 0),
        openSlots: rows.reduce((sum, row) => sum + row.openSlots, 0),
      };
    });
  }, [financialRows, isGlobalView]);

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

  const cancellationRows = useMemo(() => {
    const rows = [...(cancellationsData?.audits ?? [])];
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
  }, [cancellationsData]);

  const cancellationStats = useMemo(() => {
    const rows = cancellationRows;
    const paymentTaken = rows.filter((r) => asMoneyNumber(r.totalPaid) > 0).length;
    const reviewNeeded = rows.filter((r) => r.operatorStatus === "needs_review").length;
    const resolved = rows.filter((r) => r.operatorStatus && r.operatorStatus !== "needs_review").length;
    const exposure = rows
      .filter((r) => r.operatorStatus === "needs_review")
      .reduce((sum, r) => sum + Math.max(0, asMoneyNumber(r.totalPaid) - asMoneyNumber(r.totalRefunded)), 0);
    return { total: rows.length, paymentTaken, reviewNeeded, resolved, exposure };
  }, [cancellationRows]);

  const totalBedrooms = unitSlots.reduce((s, u) => s + u.bedrooms, 0);
  const selectedPropertyStatusLabel = selectedHasBuyInConfig
    ? unitSlots.length > 0
      ? `${totalBedrooms} BR (${unitSlots.map((u) => `${u.bedrooms}BR`).join(" + ")})`
      : "buy-in configured"
    : hasBuyInSlots
      ? `${totalBedrooms} BR auto buy-in target`
    : selectedMapping
      ? "mapped in Guesty · auto buy-in target"
      : selectedGuestyListingId
        ? `Guesty listing · ${selectedGuestyOnlyOption?.buyInSetupLabel ?? "auto buy-in target"}`
        : "";
  const propertyLabel = !isGlobalView
    ? `${selectedDisplayName || "Selected Guesty listing"}${selectedPropertyStatusLabel ? ` · ${selectedPropertyStatusLabel}` : ""}`
    : "";
  const activeGuestyCount = activeGuestyListings.length || sortedPropertyMap.length;
  const scannedGuestyCount = globalBookingsQuery.data?.listingCount ?? activeGuestyCount;
  const globalLabel = `${scannedGuestyCount} Guesty ${scannedGuestyCount === 1 ? "listing" : "listings"} scanned · ${globalPropertyTargets.length} buy-in targets`;
  const operationsDataEnabled = isGlobalView || !!selectedListingId;
  const refreshVisibleBookings = () => {
    if (isGlobalView) {
      void globalBookingsQuery.refetch();
      return;
    }
    void refetchBookings();
  };
  const openReservationDetail = (reservationId: string) => {
    const meta = reservationPropertyMeta.get(reservationId);
    if (!meta?.propertyId) return;
    if (meta.mapped) {
      setSelectedGuestyListingId(null);
      setSelectedPropertyId(meta.propertyId);
    } else {
      setSelectedPropertyId(null);
      setSelectedGuestyListingId(meta.guestyListingId);
    }
    setExpanded({ [reservationId]: true });
  };
  const bulkQueueSummary = useMemo(() => {
    const total = bulkBuyInQueueItems.length;
    const completed = bulkBuyInQueueItems.filter((item) => item.status === "completed").length;
    const failed = bulkBuyInQueueItems.filter((item) => item.status === "failed").length;
    const skipped = bulkBuyInQueueItems.filter((item) => item.status === "skipped").length;
    const cancelled = bulkBuyInQueueItems.filter((item) => item.status === "cancelled").length;
    const running = bulkBuyInQueueItems.filter((item) => item.status === "running").length;
    const finished = completed + failed + skipped + cancelled;
    return {
      total,
      completed,
      failed,
      skipped,
      cancelled,
      running,
      finished,
      percent: total > 0 ? Math.round((finished / total) * 100) : 0,
    };
  }, [bulkBuyInQueueItems]);

  return (
    <div className="min-h-screen bg-background">
      <BuyInSearchConfirmationDialog
        payload={autoFillConfirmation}
        open={autoFillConfirmationOpen}
        onOpenChange={setAutoFillConfirmationOpen}
        onViewDiagnostics={(diagnostics) => {
          setAutoFillConfirmationOpen(false);
          setAutoFillConfirmationDiagnostics(diagnostics);
          setAutoFillConfirmationDiagnosticsOpen(true);
        }}
      />
      {autoFillConfirmationDiagnostics && (
        <SearchDiagnosticsDialog
          diagnostics={autoFillConfirmationDiagnostics}
          open={autoFillConfirmationDiagnosticsOpen}
          onOpenChange={setAutoFillConfirmationDiagnosticsOpen}
          onCopySuccess={() => toast({ title: "Search log copied" })}
        />
      )}
      {/* Header */}
      <div className="sticky top-[65px] z-40 flex flex-wrap items-center gap-3 border-b bg-card/95 px-4 py-3 shadow-sm backdrop-blur sm:gap-4 sm:px-6 sm:py-4">
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-1" data-testid="button-back-home">
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Button>
        </Link>
        <div className="hidden sm:block h-5 w-px bg-border" />
        <div className="min-w-0">
          <h1 className="font-semibold text-lg leading-tight">Operations</h1>
          <p className="text-xs text-muted-foreground">
            Bookings · Buy-in tracking · Live Airbnb search, VRBO map search, plus Airbnb Lens direct links
          </p>
        </div>
        <div className="w-full sm:ml-auto sm:w-auto flex flex-wrap items-center gap-2">
          <SidecarStatusBadge />
          <Button
            variant="outline"
            size="sm"
            onClick={refreshVisibleBookings}
            disabled={bookingsLoading}
            data-testid="button-refresh-bookings"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${bookingsLoading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-3 py-4 sm:px-6 sm:py-6 space-y-5">
        {/* Selectors */}
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-end">
              <div className="grow min-w-0 sm:min-w-[260px]">
                <Label className="text-xs mb-1.5 block">Property</Label>
                <Select
                  value={selectedGuestyListingId ? `guesty:${selectedGuestyListingId}` : selectedPropertyId?.toString() ?? "all"}
                  onValueChange={(v) => {
                    if (v === "all") {
                      setSelectedPropertyId(null);
                      setSelectedGuestyListingId(null);
                      setSortBy("checkIn");
                      setSortDir("asc");
                    } else if (v.startsWith("guesty:")) {
                      setSelectedPropertyId(null);
                      setSelectedGuestyListingId(v.slice("guesty:".length));
                    } else {
                      setSelectedPropertyId(parseInt(v, 10));
                      setSelectedGuestyListingId(null);
                    }
                    setExpanded({});
                  }}
                >
                  <SelectTrigger data-testid="select-property">
                    <SelectValue placeholder="All properties" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      All properties
                      <span className="text-muted-foreground text-xs ml-1.5">
                        · global summary
                      </span>
                    </SelectItem>
                    {propertySelectOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.name}
                        <span className="text-muted-foreground text-xs ml-1.5">
                          · {option.mapped ? `#${option.propertyId}` : "Guesty"}
                        </span>
                        <span className="text-muted-foreground text-xs ml-1.5">
                          · {option.buyInSetupLabel}
                        </span>
                        {!option.buyInConfigured && (
                          <span className="text-amber-700 text-xs ml-1.5">
                            · review setup
                          </span>
                        )}
                      </SelectItem>
                    ))}
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
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="include-canceled"
                  checked={includeCanceled}
                  onChange={(e) => setIncludeCanceled(e.target.checked)}
                  className="rounded"
                  data-testid="checkbox-include-canceled"
                />
                <Label htmlFor="include-canceled" className="text-sm cursor-pointer">Include canceled</Label>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setManualForm(emptyManualReservationForm());
                  setManualDialogOpen(true);
                }}
                disabled={!isGlobalView && !selectedHasBuyInConfig}
                data-testid="button-add-manual-reservation"
              >
                <Calendar className="h-3.5 w-3.5 mr-1.5" />
                Add manual reservation
              </Button>
              {!isGlobalView && propertyLabel && (
                <div className="text-xs text-muted-foreground bg-muted/40 px-3 py-2 rounded border">
                  <BedDouble className="h-3.5 w-3.5 inline mr-1 opacity-60" />
                  {propertyLabel}
                </div>
              )}
              {isGlobalView && (
                <div className="text-xs text-muted-foreground bg-muted/40 px-3 py-2 rounded border">
                  <Building2 className="h-3.5 w-3.5 inline mr-1 opacity-60" />
                  All properties · {globalLabel}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {isGlobalView && !bookingsLoading && !bookingsError && activeGuestyCount === 0 && !stats && (
          <Card>
            <CardContent className="py-12 text-center">
              <Building2 className="h-10 w-10 mx-auto mb-3 opacity-20" />
              <p className="font-medium mb-1">No Guesty listings found yet</p>
              <p className="text-sm text-muted-foreground">
                Once Guesty returns listings, all committed bookings for those listings will be scanned automatically.
              </p>
            </CardContent>
          </Card>
        )}

        {!isGlobalView && !selectedHasBuyInConfig && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="py-5">
              <p className="text-sm font-medium text-amber-950">
                <AlertCircle className="h-4 w-4 inline mr-1.5" />
                {hasBuyInSlots
                  ? "Guesty listing details created a buy-in target automatically."
                  : "Guesty bookings load automatically for this listing."}
              </p>
              <p className="text-sm text-amber-900/80 mt-1">
                {hasBuyInSlots
                  ? "You can now use Auto-fill cheapest or Find buy-in without manually configuring unit slots first."
                  : "Buy-in unit slots are only needed when Guesty does not expose enough bedroom/community detail to create a search target."}
              </p>
            </CardContent>
          </Card>
        )}

        {bookingsError && (
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

        {operationsDataEnabled && stats && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">{isGlobalView ? "Bookings across properties" : "Bookings"}</p>
                <p className="text-2xl font-semibold mt-1">{stats.total}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isGlobalView || hasBuyInSlots
                    ? `${stats.fully} fully linked · ${stats.partial} partial`
                    : "Pulled directly from Guesty"}
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

        {isGlobalView && stats && reservations.length > 0 && (
          <Card data-testid="card-global-bookings">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Calendar className="h-4 w-4" /> All bookings
                    {bookingsLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
                  </CardTitle>
                  <CardDescription>
                    Global booking list across every buy-in target, grouped by arrival month with revenue and profit subtotals.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="w-fit">
                    {reservations.length} booking{reservations.length === 1 ? "" : "s"}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={selectAllEligibleGlobalBookings}
                    disabled={bulkBuyInQueueRunning || eligibleGlobalReservations.length === 0}
                    data-testid="button-select-eligible-bulk-buy-ins"
                  >
                    Select open
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={clearBulkBookingSelection}
                    disabled={bulkBuyInQueueRunning || selectedBulkReservationCount === 0}
                    data-testid="button-clear-bulk-buy-ins"
                  >
                    Clear
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={startBulkBuyInQueue}
                    disabled={bulkBuyInQueueRunning || selectedBulkEligibleReservations.length === 0}
                    data-testid="button-run-bulk-buy-ins"
                  >
                    {bulkBuyInQueueRunning ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Zap className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Run bulk buy-ins ({selectedBulkEligibleReservations.length})
                  </Button>
                  {bulkBuyInQueueItems.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setBulkBuyInQueueOpen(true)}
                      data-testid="button-open-bulk-buy-in-queue"
                    >
                      Queue status
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded border">
                <div className="max-h-[560px] overflow-auto">
                  <div className="min-w-[1450px]">
                    <div className="sticky top-0 z-10 grid grid-cols-[42px_110px_1.1fr_1.45fr_1.2fr_1.8fr_.75fr_.85fr_.85fr_.85fr_.75fr_72px] gap-3 border-b bg-muted/95 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
                      <div>
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={eligibleGlobalReservations.length > 0 && eligibleGlobalReservations.every((reservation) => bulkSelectedReservations[reservation._id])}
                          onChange={(event) => {
                            if (event.target.checked) selectAllEligibleGlobalBookings();
                            else clearBulkBookingSelection();
                          }}
                          aria-label="Select all eligible global bookings"
                          data-testid="checkbox-select-all-bulk-buy-ins"
                        />
                      </div>
                      <SortHeader label="Check-in" active={sortBy === "checkIn"} dir={sortDir} onClick={() => toggleSort("checkIn")} />
                      <div>Queue</div>
                      <SortHeader label="Property" active={sortBy === "property"} dir={sortDir} onClick={() => toggleSort("property")} />
                      <SortHeader label="Guest" active={sortBy === "guest"} dir={sortDir} onClick={() => toggleSort("guest")} />
                      <div>Queued for</div>
                      <div>Channel</div>
                      <SortHeader label="Revenue" active={sortBy === "payout"} dir={sortDir} onClick={() => toggleSort("payout")} align="right" />
                      <SortHeader label="Buy-in" active={sortBy === "buyIn"} dir={sortDir} onClick={() => toggleSort("buyIn")} align="right" />
                      <SortHeader label="Net profit" active={sortBy === "profit"} dir={sortDir} onClick={() => toggleSort("profit")} align="right" />
                      <SortHeader label="Fill" active={sortBy === "status"} dir={sortDir} onClick={() => toggleSort("status")} />
                      <div className="text-right">Open</div>
                    </div>
                    <div className="divide-y">
                      {globalBookingMonthSections.map((section) => (
                        <div key={`global-booking-month-${section.key}`} className="divide-y">
                          <div className="grid grid-cols-[42px_110px_1.1fr_1.45fr_1.2fr_1.8fr_.75fr_.85fr_.85fr_.85fr_.75fr_72px] gap-3 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800">
                            <div style={{ gridColumn: "1 / span 7" }}>
                              {section.label}
                              <span className="ml-2 font-normal text-muted-foreground">
                                {section.totals.bookingCount} booking{section.totals.bookingCount === 1 ? "" : "s"}
                              </span>
                            </div>
                            <div className="text-right">{fmtMoney(section.totals.revenue)}</div>
                            <div className="text-right">{fmtMoney(section.totals.buyInCost)}</div>
                            <div className={`text-right ${section.totals.profit >= 0 ? "text-green-700" : "text-red-700"}`}>
                              {fmtMoney(section.totals.profit)}
                            </div>
                            <div className="text-[10px] font-normal text-muted-foreground" style={{ gridColumn: "11 / span 2" }}>
                              {section.totals.openSlots} open slot{section.totals.openSlots === 1 ? "" : "s"}
                            </div>
                          </div>
                          {section.rows.map((row) => {
                            const reservation = row.reservation;
                            const meta = reservationPropertyMeta.get(reservation._id);
                            const nights = reservation.nightsCount ?? nightsBetween(checkInOf(reservation), checkOutOf(reservation));
                            const channel = reservation.integration?.platform ?? reservation.source ?? "direct";
                            const guestName = reservation.guest?.fullName ?? reservation.guest?.firstName ?? "Guest";
                            const queueItem = bulkQueueItemsByReservationId.get(reservation._id);
                            const eligibleForBulk = !!meta?.propertyId && reservation.slots.some((slot) => !slot.buyIn);
                            const queuedFor = meta?.propertyId
                              ? bulkBuyInQueuedForText(reservation, meta.propertyName, meta.propertyId)
                              : "No mapped property";
                            const queueStatus = queueItem?.status
                              ?? (reservation.fullyLinked ? "completed" : eligibleForBulk ? "queued" : "skipped");
                            const queueLabel = queueItem?.message
                              ?? (reservation.fullyLinked ? "Filled" : eligibleForBulk ? "Ready" : "No open slots");
                            return (
                              <div
                                key={`global-booking-${reservation._id}`}
                                role="button"
                                tabIndex={0}
                                className="grid grid-cols-[42px_110px_1.1fr_1.45fr_1.2fr_1.8fr_.75fr_.85fr_.85fr_.85fr_.75fr_72px] gap-3 px-3 py-2.5 text-sm items-center transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                                onClick={() => openReservationDetail(reservation._id)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    openReservationDetail(reservation._id);
                                  }
                                }}
                                data-testid={`global-booking-row-${reservation._id}`}
                              >
                                <div onClick={(event) => event.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    className="rounded"
                                    checked={!!bulkSelectedReservations[reservation._id]}
                                    disabled={!eligibleForBulk || bulkBuyInQueueRunning}
                                    onChange={(event) => {
                                      const checked = event.target.checked;
                                      setBulkSelectedReservations((prev) => ({
                                        ...prev,
                                        [reservation._id]: checked,
                                      }));
                                    }}
                                    aria-label={`Select ${guestName} for bulk buy-in queue`}
                                    data-testid={`checkbox-bulk-buy-in-${reservation._id}`}
                                  />
                                </div>
                                <div>
                                  <p className="font-medium">{fmtDate(checkInOf(reservation))}</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {fmtDate(checkOutOf(reservation))}
                                  </p>
                                </div>
                                <div className="min-w-0">
                                  <Badge
                                    variant={queueStatus === "completed" ? "default" : "outline"}
                                    className={`max-w-full text-[10px] ${
                                      queueStatus === "completed"
                                        ? "bg-green-600 text-white"
                                        : queueStatus === "running"
                                          ? "border-blue-300 text-blue-700"
                                          : queueStatus === "failed"
                                            ? "border-red-300 text-red-700"
                                            : queueStatus === "skipped"
                                              ? "border-amber-300 text-amber-700"
                                              : queueStatus === "cancelled"
                                                ? "border-muted-foreground/30 text-muted-foreground"
                                                : ""
                                    }`}
                                  >
                                    {queueItem?.status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
                                    <span className="truncate">{queueLabel}</span>
                                  </Badge>
                                  {queueItem?.error && (
                                    <p className="mt-1 truncate text-[10px] text-red-700" title={queueItem.error}>
                                      {queueItem.error}
                                    </p>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate font-medium">{meta?.propertyName ?? "Property"}</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {meta?.mapped ? `#${meta.propertyId}` : "Guesty target"}
                                  </p>
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate font-medium">{guestName}</p>
                                  <p className="truncate text-[10px] text-muted-foreground">
                                    {reservation.confirmationCode ?? reservation._id}
                                  </p>
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate" title={queuedFor}>{queuedFor}</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {nights} night{nights === 1 ? "" : "s"} · {fmtDate(checkInOf(reservation))} to {fmtDate(checkOutOf(reservation))}
                                  </p>
                                </div>
                                <div>
                                  <Badge variant="outline" className="text-[10px] capitalize">
                                    {channel}
                                  </Badge>
                                </div>
                                <div className="text-right">
                                  <p className="font-medium">{fmtMoney(row.netRevenue)}</p>
                                  {(reservation.money?.balanceDue ?? 0) > 0 && (
                                    <p className="text-[10px] text-amber-700">
                                      {fmtMoney(reservation.money?.balanceDue ?? 0)} due
                                    </p>
                                  )}
                                </div>
                                <div className="text-right">
                                  <p className="font-medium">{fmtMoney(row.totalExpectedBuyInCost)}</p>
                                  {row.remainingBuyInCost > 0 ? (
                                    <p className="text-[10px] text-amber-700">
                                      {fmtMoney(row.remainingBuyInCost)} est.
                                    </p>
                                  ) : (
                                    <p className="text-[10px] text-muted-foreground">attached</p>
                                  )}
                                </div>
                                <div className="text-right">
                                  <p className={`font-medium ${row.expectedProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                                    {fmtMoney(row.expectedProfit)}
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">after buy-ins</p>
                                </div>
                                <div>
                                  <Badge
                                    variant={reservation.fullyLinked ? "default" : "outline"}
                                    className={`text-[10px] ${
                                      reservation.fullyLinked
                                        ? "bg-green-600 text-white"
                                        : reservation.slotsTotal > 0
                                          ? "border-amber-300 text-amber-700"
                                          : ""
                                    }`}
                                  >
                                    {reservation.slotsTotal > 0
                                      ? `${reservation.slotsFilled}/${reservation.slotsTotal}`
                                      : "Guesty"}
                                  </Badge>
                                </div>
                                <div className="text-right">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openReservationDetail(reservation._id);
                                    }}
                                  >
                                    Open
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                          <div className="grid grid-cols-[42px_110px_1.1fr_1.45fr_1.2fr_1.8fr_.75fr_.85fr_.85fr_.85fr_.75fr_72px] gap-3 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-950">
                            <div style={{ gridColumn: "1 / span 7" }}>
                              Subtotal for {section.label}
                            </div>
                            <div className="text-right">{fmtMoney(section.totals.revenue)}</div>
                            <div className="text-right">{fmtMoney(section.totals.buyInCost)}</div>
                            <div className={`text-right ${section.totals.profit >= 0 ? "text-green-700" : "text-red-700"}`}>
                              {fmtMoney(section.totals.profit)}
                            </div>
                            <div className="text-[10px] font-normal text-blue-900/80" style={{ gridColumn: "11 / span 2" }}>
                              {section.totals.bookingCount} booking{section.totals.bookingCount === 1 ? "" : "s"}
                            </div>
                          </div>
                        </div>
                      ))}
                      {globalBookingGrandTotals && (
                        <div className="grid grid-cols-[42px_110px_1.1fr_1.45fr_1.2fr_1.8fr_.75fr_.85fr_.85fr_.85fr_.75fr_72px] gap-3 border-t-2 border-slate-300 bg-slate-900 px-3 py-3 text-sm font-semibold text-white">
                          <div style={{ gridColumn: "1 / span 7" }}>
                            Total for all visible months
                            <span className="ml-2 font-normal text-slate-300">
                              {globalBookingGrandTotals.bookingCount} booking{globalBookingGrandTotals.bookingCount === 1 ? "" : "s"}
                            </span>
                          </div>
                          <div className="text-right">{fmtMoney(globalBookingGrandTotals.revenue)}</div>
                          <div className="text-right">{fmtMoney(globalBookingGrandTotals.buyInCost)}</div>
                          <div className={`text-right ${globalBookingGrandTotals.profit >= 0 ? "text-green-300" : "text-red-300"}`}>
                            {fmtMoney(globalBookingGrandTotals.profit)}
                          </div>
                          <div className="text-[10px] font-normal text-slate-300" style={{ gridColumn: "11 / span 2" }}>
                            {globalBookingGrandTotals.openSlots} open slot{globalBookingGrandTotals.openSlots === 1 ? "" : "s"}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {stats && arrivalStats && (
          <Card data-testid="card-upcoming-arrivals">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock3 className="h-4 w-4" /> {isGlobalView ? "Global upcoming arrivals" : "Upcoming arrivals"}
              </CardTitle>
              <CardDescription>
                {isGlobalView
                  ? "Buy-in readiness for future check-ins across all linked properties."
                  : "Buy-in readiness for future check-ins on this property."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded border bg-muted/20 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Next arrival</p>
                  {arrivalStats.nextArrival ? (
                    <>
                      <p className="text-sm font-semibold mt-1">
                        {fmtDate(checkInOf(arrivalStats.nextArrival.reservation))}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {arrivalStats.nextArrival.reservation.guest?.fullName
                          ?? arrivalStats.nextArrival.reservation.guest?.firstName
                          ?? "Guest"}
                      </p>
                      {isGlobalView && (
                        <p className="text-[10px] text-muted-foreground truncate">
                          {arrivalStats.nextArrival.propertyName}
                        </p>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Buy-in cost: {fmtMoney(arrivalStats.nextArrival.attachedBuyInCost)}
                        {arrivalStats.nextArrival.remainingBuyInCost > 0
                          ? ` · est. remaining ${fmtMoney(arrivalStats.nextArrival.remainingBuyInCost)}`
                          : ""}
                      </p>
                      <Badge
                        variant={arrivalStats.nextArrival.reservation.fullyLinked ? "default" : "outline"}
                        className={`mt-2 text-[10px] ${
                          arrivalStats.nextArrival.reservation.fullyLinked
                            ? "bg-green-600 text-white"
                            : "border-amber-300 text-amber-700"
                        }`}
                      >
                        {arrivalStats.nextArrival.reservation.fullyLinked
                          ? "Bought in"
                          : arrivalStats.nextArrival.reservation.slotsTotal > 0
                            ? `${arrivalStats.nextArrival.reservation.slotsFilled}/${arrivalStats.nextArrival.reservation.slotsTotal} bought in`
                            : "Guesty booking"}
                      </Badge>
                    </>
                  ) : (
                    <p className="text-sm font-medium mt-1 text-muted-foreground">No upcoming arrivals</p>
                  )}
                </div>

                <div className="rounded border bg-muted/20 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Not bought in</p>
                  <p className={`text-2xl font-semibold mt-1 ${
                    arrivalStats.missingBuyInReservations > 0 ? "text-amber-700" : "text-green-700"
                  }`}>
                    {arrivalStats.missingBuyInReservations}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {arrivalStats.missingSlots} open unit slot{arrivalStats.missingSlots === 1 ? "" : "s"}
                  </p>
                </div>

                <div className="rounded border bg-muted/20 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Next arrival buy-in cost</p>
                  <p className="text-2xl font-semibold mt-1">{fmtMoney(arrivalStats.nextArrivalBuyInCost)}</p>
                  <p className="text-xs text-muted-foreground">
                    {arrivalStats.nextArrival
                      ? `${arrivalStats.nextArrival.reservation.guest?.fullName
                        ?? arrivalStats.nextArrival.reservation.guest?.firstName
                        ?? "Next guest"}'s booking`
                      : "No upcoming arrival"}
                  </p>
                  {arrivalStats.nextArrivalRemainingBuyInCost > 0 && (
                    <p className="text-xs text-amber-700">
                      Est. remaining: {fmtMoney(arrivalStats.nextArrivalRemainingBuyInCost)}
                    </p>
                  )}
                </div>

                <div className="rounded border bg-muted/20 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Arrivals this month</p>
                  <p className="text-2xl font-semibold mt-1">{arrivalStats.thisMonthCount}</p>
                  <p className="text-xs text-muted-foreground">
                    {arrivalStats.thisMonthMissing} still need buy-in attention
                  </p>
                </div>
              </div>
              {isGlobalView && nextThreeMonthReports.length > 0 && (
                <div className="mt-4">
                  <div className="mb-2 flex flex-col gap-0.5 sm:flex-row sm:items-end sm:justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Next 3 arrival months
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Profit uses Guesty host payout minus attached and estimated remaining buy-ins.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                    {nextThreeMonthReports.map((month) => (
                      <div key={month.key} className="rounded border bg-muted/10 p-3">
                        <div className="mb-2 flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold">{month.label}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {month.bookingCount} arrival{month.bookingCount === 1 ? "" : "s"} · {month.openSlots} open slot{month.openSlots === 1 ? "" : "s"}
                            </p>
                          </div>
                          <p className={`text-sm font-semibold ${month.expectedProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                            {fmtMoney(month.expectedProfit)}
                          </p>
                        </div>
                        <div className="space-y-1.5 text-xs">
                          <div className="flex justify-between gap-3">
                            <span className="text-muted-foreground">Buy-in cost</span>
                            <span className="font-medium">{fmtMoney(month.attachedBuyInCost)}</span>
                          </div>
                          <div className="flex justify-between gap-3">
                            <span className="text-muted-foreground">Remaining buy-in est.</span>
                            <span className={`font-medium ${month.remainingBuyInCost > 0 ? "text-amber-700" : ""}`}>
                              {fmtMoney(month.remainingBuyInCost)}
                            </span>
                          </div>
                          <div className="flex justify-between gap-3">
                            <span className="text-muted-foreground">Gross revenue</span>
                            <span className="font-medium">{fmtMoney(month.grossRevenue)}</span>
                          </div>
                          <div className="flex justify-between gap-3">
                            <span className="text-muted-foreground">Funds left to collect</span>
                            <span className={`font-medium ${month.fundsLeftToCollect > 0 ? "text-amber-700" : ""}`}>
                              {fmtMoney(month.fundsLeftToCollect)}
                            </span>
                          </div>
                          <div className="flex justify-between gap-3 border-t pt-1.5">
                            <span className="text-muted-foreground">Expected profit</span>
                            <span className={`font-semibold ${month.expectedProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                              {fmtMoney(month.expectedProfit)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {isGlobalView && arrivalStats.attentionRows.length > 0 && (
                <div className="mt-4 rounded border bg-amber-50/60">
                  <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
                    <p className="text-xs font-semibold text-amber-900">Next 3 months needing buy-in attention</p>
                    <Badge variant="outline" className="border-amber-300 text-amber-800">
                      {arrivalStats.missingBuyInReservations} open
                    </Badge>
                  </div>
                  <div className="divide-y">
                    {arrivalStats.attentionRows.map((row) => {
                      const meta = reservationPropertyMeta.get(row.reservation._id);
                      return (
                        <button
                          key={row.reservation._id}
                          type="button"
                          className="w-full px-3 py-2 text-left hover:bg-amber-100/50"
                          onClick={() => {
                            openReservationDetail(row.reservation._id);
                          }}
                        >
                          <div className="grid grid-cols-1 gap-1 sm:grid-cols-[120px_1fr_110px_120px] sm:items-center">
                            <p className="text-xs font-semibold">{fmtDate(checkInOf(row.reservation))}</p>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">
                                {row.reservation.guest?.fullName ?? row.reservation.guest?.firstName ?? "Guest"}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {meta?.propertyName ?? "Property"}
                              </p>
                            </div>
                            <p className="text-xs text-amber-800">
                              {row.reservation.slotsFilled}/{row.reservation.slotsTotal} bought in
                            </p>
                            <p className="text-xs font-medium sm:text-right">
                              {fmtMoney(row.attachedBuyInCost)}
                              {row.remainingBuyInCost > 0 && (
                                <span className="block text-[10px] text-amber-700">
                                  + {fmtMoney(row.remainingBuyInCost)} est.
                                </span>
                              )}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {isGlobalView && arrivalStats.attentionRows.length === 0 && arrivalStats.laterMissingBuyInReservations > 0 && (
                <div className="mt-4 rounded border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  No open buy-ins in the next 3 months. {arrivalStats.laterMissingBuyInReservations} later reservation{arrivalStats.laterMissingBuyInReservations === 1 ? " has" : "s have"} open slots after this window.
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {isGlobalView && bookingsLoading && !stats && (
          <Card>
            <CardContent className="py-10 text-center">
              <RefreshCw className="h-8 w-8 mx-auto mb-3 animate-spin opacity-40" />
              <p className="font-medium">Loading global booking summary</p>
              <p className="text-sm text-muted-foreground">
                Pulling committed reservations directly from Guesty across the whole account.
              </p>
            </CardContent>
          </Card>
        )}

        {isGlobalView && !bookingsLoading && !bookingsError && !stats && scannedGuestyCount > 0 && (
          <Card>
            <CardContent className="py-10 text-center">
              <Calendar className="h-8 w-8 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No committed Guesty bookings found</p>
              <p className="text-sm text-muted-foreground">
                Try enabling past stays or select an individual property to inspect it.
              </p>
            </CardContent>
          </Card>
        )}

        {isGlobalView && stats && monthlyReport && (
          <Card data-testid="card-global-monthly-report">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <WalletCards className="h-4 w-4" /> Monthly buy-in report
                  </CardTitle>
                  <CardDescription>
                    Arrival-month view across all properties. Profit uses currently attached buy-ins.
                  </CardDescription>
                </div>
                <div className="w-full sm:w-48">
                  <Label htmlFor="global-report-month" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Report month
                  </Label>
                  <Input
                    id="global-report-month"
                    type="month"
                    value={reportMonth}
                    onChange={(e) => setReportMonth(e.target.value)}
                    className="mt-1"
                    data-testid="input-global-report-month"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded border bg-muted/20 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Profit for {monthlyReport.label}</p>
                  <p className={`text-2xl font-semibold mt-1 ${monthlyReport.totalProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                    {fmtMoney(monthlyReport.totalProfit)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Net revenue minus attached + estimated remaining buy-ins
                  </p>
                </div>
                <div className="rounded border bg-muted/20 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Buy-in cost</p>
                  <p className="text-2xl font-semibold mt-1">{fmtMoney(monthlyReport.totalBuyInCost)}</p>
                  <p className="text-xs text-muted-foreground">
                    Remaining est. {fmtMoney(monthlyReport.totalRemainingBuyInCost)}
                  </p>
                </div>
                <div className="rounded border bg-muted/20 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Gross revenue</p>
                  <p className="text-2xl font-semibold mt-1">{fmtMoney(monthlyReport.totalGrossRevenue)}</p>
                  <p className="text-xs text-muted-foreground">
                    Funds left: {fmtMoney(monthlyReport.totalFundsLeftToCollect)}
                  </p>
                </div>
                <div className="rounded border bg-muted/20 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Bookings</p>
                  <p className="text-2xl font-semibold mt-1">{monthlyReport.bookingCount}</p>
                  <p className={`text-xs ${monthlyReport.openSlots > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
                    {monthlyReport.fullyLinked} fully bought in · {monthlyReport.openSlots} open slots
                  </p>
                </div>
              </div>

              {monthlyReport.monthIsPast && !includePast && (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Turn on "Include past stays" to include completed bookings for older months.
                </div>
              )}

              {monthlyReport.rows.length > 0 ? (
                <div className="overflow-x-auto rounded border">
                  <div className="min-w-[900px]">
                    <div className="grid grid-cols-[110px_1.35fr_1.5fr_.8fr_.9fr_.9fr_.9fr_.75fr] gap-3 border-b bg-muted/40 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <div>Arrival</div>
                      <div>Guest</div>
                      <div>Property</div>
                      <div>Status</div>
                      <div className="text-right">Revenue</div>
                      <div className="text-right">Buy-in</div>
                      <div className="text-right">Profit</div>
                      <div className="text-right">Action</div>
                    </div>
                    <div className="divide-y">
                      {monthlyReport.rows.map((row) => {
                        const channel = row.reservation.integration?.platform ?? row.reservation.source ?? "direct";
                        return (
                          <div
                            key={`monthly-report-${row.reservation._id}`}
                            className="grid grid-cols-[110px_1.35fr_1.5fr_.8fr_.9fr_.9fr_.9fr_.75fr] gap-3 px-3 py-2.5 text-sm items-center"
                          >
                            <div>
                              <p className="font-medium">{fmtDate(checkInOf(row.reservation))}</p>
                              <p className="text-[10px] text-muted-foreground">
                                {row.reservation.nightsCount ?? nightsBetween(checkInOf(row.reservation), checkOutOf(row.reservation))} nights
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium truncate">
                                {row.reservation.guest?.fullName ?? row.reservation.guest?.firstName ?? "Guest"}
                              </p>
                              <p className="text-[10px] text-muted-foreground truncate">
                                {row.reservation.confirmationCode ?? row.reservation._id}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="truncate">{row.propertyName}</p>
                              <p className="text-[10px] text-muted-foreground capitalize">{channel}</p>
                            </div>
                            <div>
                              <Badge
                                variant={row.reservation.fullyLinked ? "default" : "outline"}
                                className={`text-[10px] ${
                                  row.reservation.fullyLinked
                                    ? "bg-green-600 text-white"
                                    : "border-amber-300 text-amber-700"
                                }`}
                              >
                                {row.reservation.fullyLinked
                                  ? "Bought in"
                                  : `${row.reservation.slotsFilled}/${row.reservation.slotsTotal}`}
                              </Badge>
                            </div>
                            <div className="text-right">
                              <p className="font-medium">{fmtMoney(row.grossRevenue)}</p>
                              {row.netRevenue !== row.grossRevenue && (
                                <p className="text-[10px] text-muted-foreground">
                                  net {fmtMoney(row.netRevenue)}
                                </p>
                              )}
                              {row.fundsLeftToCollect > 0 && (
                                <p className="text-[10px] text-amber-700">
                                  {fmtMoney(row.fundsLeftToCollect)} left
                                </p>
                              )}
                            </div>
                            <div className="text-right">
                              <p className="font-medium">{fmtMoney(row.attachedBuyInCost)}</p>
                              {row.remainingBuyInCost > 0 && (
                                <p className="text-[10px] text-amber-700">
                                  + {fmtMoney(row.remainingBuyInCost)} est.
                                </p>
                              )}
                            </div>
                            <p className={`text-right font-medium ${row.expectedProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                              {fmtMoney(row.expectedProfit)}
                            </p>
                            <div className="text-right">
                              {row.propertyId ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => {
                                    openReservationDetail(row.reservation._id);
                                  }}
                                >
                                  Open
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded border bg-muted/20 px-4 py-6 text-center">
                  <p className="font-medium">No arrivals found for {monthlyReport.label}</p>
                  <p className="text-sm text-muted-foreground">
                    Choose another month or turn on past stays if you are reporting on a completed month.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {isGlobalView && stats && (
          <Card>
            <CardContent className="py-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">Select a property to manage individual buy-ins</p>
                  <p className="text-sm text-muted-foreground">
                    The global view is read-only so attachments, searches, and expected deposits stay tied to one property at a time.
                  </p>
                </div>
                <Badge variant="outline" className="w-fit">
                  {globalLabel}
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {!isGlobalView && !bookingsError && (
          <Tabs defaultValue="bookings" className="space-y-4">
            <TabsList className="flex h-auto w-full max-w-full justify-start overflow-x-auto p-1 sm:w-auto" data-testid="tabs-operations">
              <TabsTrigger value="bookings" data-testid="tab-operations-bookings">
                <Calendar className="h-3.5 w-3.5 mr-1.5" /> Bookings
              </TabsTrigger>
              <TabsTrigger value="deposits" data-testid="tab-operations-deposits">
                <WalletCards className="h-3.5 w-3.5 mr-1.5" /> Expected Deposits
              </TabsTrigger>
              <TabsTrigger value="cancelled" data-testid="tab-operations-cancelled">
                <AlertCircle className="h-3.5 w-3.5 mr-1.5" /> Cancelled
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
                <div className="hidden px-4 py-2 border-b md:flex items-center gap-3">
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
                const rowAutoFillRunning = r._id in autoFillStartedByReservation;
                const rowSidecarOnly = rowAutoFillRunning
                  && !autoFillMutation.isPending
                  && autoFillSidecarActive;
                const comboOptions = lastAutoFillCombos[r._id] ?? [];
                const searchAudits = lastAutoFillAudits[r._id] ?? [];
                const manualReservation = isManualReservation(r);
                const reservationMeta = buyInPropertyMetaForReservation(r);
                return (
                  <div
                    key={r._id}
                    className={`border rounded-lg bg-card ${focusedReservationId === r._id ? "ring-2 ring-primary/40 ring-offset-2" : ""}`}
                    data-reservation-id={r._id}
                    data-testid={`booking-row-${r._id}`}
                  >
                    {/* Summary row */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleExpanded(r._id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleExpanded(r._id);
                        }
                      }}
                      className="w-full text-left px-3 py-3 sm:px-4 flex items-start md:items-center gap-3 hover:bg-muted/40 transition-colors rounded-lg"
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                      <div className="grow min-w-0 grid grid-cols-2 gap-3 md:grid-cols-[1.5fr_1.5fr_1fr_1fr_1fr_auto] md:items-center">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="font-medium text-sm truncate">{r.guest?.fullName ?? r.guest?.firstName ?? "Guest"}</p>
                            {manualReservation ? (
                              <Badge variant="outline" className="h-6 text-[10px]">Manual</Badge>
                            ) : (
                              <Button
                                asChild
                                size="sm"
                                variant="outline"
                                className="h-6 shrink-0 px-2 text-[10px]"
                                title="Open this guest's conversation in Inbox"
                                data-testid={`button-guest-inbox-${r._id}`}
                              >
                                <Link href={guestInboxHref(r)} onClick={(e) => e.stopPropagation()}>
                                  <MessageSquare className="h-3 w-3 mr-1" />
                                  Guest Inbox
                                </Link>
                              </Button>
                            )}
                            {/* Non-committed status badge (only ever rendered when
                                "Include canceled" surfaces these rows). */}
                            {(() => {
                              const status = String((r as any).status ?? "");
                              if (!/(cancel|declin|inquir|request|expired|closed|draft)/i.test(status)) return null;
                              const canceledLike = /(cancel|declin|expired|closed)/i.test(status);
                              return (
                                <Badge
                                  variant="outline"
                                  className={`h-6 text-[10px] capitalize ${canceledLike
                                    ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                                    : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"}`}
                                  title={`Guesty status: ${status}`}
                                  data-testid={`badge-reservation-status-${r._id}`}
                                >
                                  {status.replace(/_/g, " ")}
                                </Badge>
                              );
                            })()}
                          </div>
                          {r.confirmationCode && (
                            <p className="text-[10px] text-muted-foreground font-mono">
                              {r.confirmationCode}
                            </p>
                          )}
                        </div>
                        <div className="text-sm col-span-2 md:col-span-1">
                          <p>{fmtDate(checkInOf(r))} → {fmtDate(checkOutOf(r))}</p>
                          <p className="text-xs text-muted-foreground">{nights} nights · <Badge variant="outline" className="text-[10px] capitalize ml-1">{channel}</Badge></p>
                        </div>
                        <div className="text-sm md:text-right">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground md:hidden">Payout</p>
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
                                <p className="text-[10px] font-medium text-green-700 flex items-center md:justify-end gap-0.5">
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
                        <div className="text-sm md:text-right">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground md:hidden">Buy-in</p>
                          <p className="font-medium">{fmtMoney(totalBuyInCost)}</p>
                          <p className="text-[10px] text-muted-foreground">buy-in cost</p>
                        </div>
                        <div className="text-sm md:text-right">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground md:hidden">Profit</p>
                          {r.fullyLinked ? (
                            <span className={`font-medium ${payout - totalBuyInCost >= 0 ? "text-green-600" : "text-red-600"}`}>
                              {fmtMoney(payout - totalBuyInCost)}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                          <p className="text-[10px] text-muted-foreground">profit</p>
                        </div>
                        <div className="col-span-2 shrink-0 md:col-span-1">
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
                          ) : r.slotsTotal === 0 ? (
                            <Badge variant="outline" className="text-[10px]">
                              Guesty booking
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">
                              0 / {r.slotsTotal} filled
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Expanded: per-unit-slot detail */}
                    {isOpen && (
                      <div className="border-t px-4 py-3 bg-muted/20 space-y-2">
                        {r.slotsTotal === 0 && (
                          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                            This reservation came from Guesty, but the listing does not expose enough bedroom detail to create a buy-in search target yet.
                          </div>
                        )}
                        {selectedPropertyId && selectedHasBuyInConfig && !manualReservation && (
                          <GroundFloorRequirementNotice reservation={r} propertyId={selectedPropertyId} />
                        )}
                        {manualReservation && <ManualReservationContactPanel reservation={r} />}
                        {!manualReservation && <ReservationCancellationPolicyNotice reservation={r} />}
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 px-2 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setVrboGuestPageTarget({
                                reservation: r,
                                propertyName: reservationMeta?.propertyName ?? selectedDisplayName ?? "Vacation rental",
                              });
                            }}
                            data-testid={`button-vrbo-guest-page-${r._id}`}
                            title="Create a guest-facing custom page from one or more VRBO listing URLs"
                          >
                            <ExternalLink className="mr-1 h-3.5 w-3.5" />
                            VRBO guest page
                          </Button>
                        </div>
                        {/* Auto-fill: one click to search + attach cheapest
                            priced option for every empty slot on this row. */}
                        {r.slotsFilled < r.slotsTotal && (
                          <div className="bg-primary/5 border border-primary/20 rounded px-3 py-2">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div className="text-xs text-muted-foreground">
                                {r.slotsTotal - r.slotsFilled} empty {r.slotsTotal - r.slotsFilled === 1 ? "unit" : "units"} · auto-pick the cheapest live listing for each
                              </div>
                              <Button
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (autoFillRunRef.current.has(r._id)) return;
                                  autoFillRunRef.current.add(r._id);
                                  clearAutoFillDiagnostics(r._id);
                                  closeSlotSearchesForReservation(r);
                                  setAutoFillStartedByReservation((prev) => ({
                                    ...prev,
                                    [r._id]: Date.now(),
                                  }));
                                  autoFillMutation.mutate({ reservation: r });
                                }}
                                disabled={rowAutoFillRunning}
                                data-testid={`button-auto-fill-${r._id}`}
                              >
                                {rowAutoFillRunning && !rowSidecarOnly ? (
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
                        {expansionJobs[r._id] && (
                          <CityExpansionJobPoller
                            jobId={expansionJobs[r._id].jobId}
                            onState={(s) => updateExpansionJobState(r._id, s)}
                            onResolved={(s) => handleExpansionResolved(r._id, s)}
                          />
                        )}
                        {autoFillJobs[r._id] && (
                          <AutoFillJobPoller
                            jobId={autoFillJobs[r._id].jobId}
                            onState={(s) => updateAutoFillJobState(r._id, s)}
                            onResolved={(s) => handleAutoFillResolved(r._id, s)}
                          />
                        )}
                        {(escalationByReservation[r._id] || expansionJobs[r._id] || autoFillJobs[r._id]) && (
                          <BuyInEscalationStages
                            escalation={
                              escalationByReservation[r._id] ?? {
                                resort: "no-pair",
                                homeCity: "no-pair",
                                foundAt: null,
                                startedAt: 0,
                              }
                            }
                            expansion={expansionJobs[r._id] ?? null}
                          />
                        )}
                        {(searchAudits.length > 0 || comboOptions.length > 0) && (
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={(e) => {
                                e.stopPropagation();
                                clearAutoFillDiagnostics(r._id);
                                toast({ title: "Search results cleared" });
                              }}
                              data-testid={`button-clear-auto-fill-diagnostics-${r._id}`}
                            >
                              <XCircle className="mr-1 h-3.5 w-3.5" />
                              Clear search results
                            </Button>
                          </div>
                        )}
                        {comboOptions.length > 0 && (
                          <ComboComparisonPanel
                            options={comboOptions}
                            targetResortName={directBookingTargetResortName(
                              selectedPropertyId
                                ? PROPERTY_UNIT_CONFIGS[selectedPropertyId]?.community ?? ""
                                : r.slots.find((slot) => slot.community)?.community ?? "",
                            )}
                            community={selectedPropertyId
                              ? PROPERTY_UNIT_CONFIGS[selectedPropertyId]?.community ?? ""
                              : r.slots.find((slot) => slot.community)?.community ?? ""}
                            onAttachCombo={(option) => attachComboMutation.mutate({ reservation: r, option })}
                            attachingComboLabel={attachComboMutation.isPending ? attachComboMutation.variables?.option.label ?? null : null}
                          />
                        )}
                        {selectedPropertyId && (PROPERTY_UNIT_CONFIGS[selectedPropertyId]?.units.length ?? 0) >= 2 && (
                          <CityVrboInventoryPanel
                            propertyId={selectedPropertyId}
                            reservation={r}
                            community={PROPERTY_UNIT_CONFIGS[selectedPropertyId]?.community ?? ""}
                            bedroomPlan={PROPERTY_UNIT_CONFIGS[selectedPropertyId]!.units.map((unit) => unit.bedrooms)}
                            onAttachCombo={(option) => attachComboMutation.mutate({ reservation: r, option })}
                            attaching={attachComboMutation.isPending}
                            autoScanTrigger={cityInventoryScanTrigger[r._id] ?? 0}
                          />
                        )}
                        {searchAudits.length > 0 && (() => {
                          const comboTargetResort = directBookingTargetResortName(
                            selectedPropertyId
                              ? PROPERTY_UNIT_CONFIGS[selectedPropertyId]?.community ?? ""
                              : r.slots.find((slot) => slot.community)?.community ?? "",
                          );
                          const comboCommunity = selectedPropertyId
                            ? PROPERTY_UNIT_CONFIGS[selectedPropertyId]?.community ?? ""
                            : r.slots.find((slot) => slot.community)?.community ?? "";
                          const completeComboOptions = comboOptions.filter((option) =>
                            comboOptionIsComplete(option, comboTargetResort, comboCommunity),
                          );
                          const selectedCombo = completeComboOptions.find((option) => option.selected);
	                          const fallbackCost = completeComboOptions
	                            .map((option) => option.totalCost)
	                            .filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost) && cost > 0)
	                            .sort((a, b) => a - b)[0] ?? null;
	                          const noCompleteCombo = completeComboOptions.length === 0;
	                          const advice = buildBuyInCancellationAdvice({
	                            reservation: r,
	                            audits: searchAudits,
	                            proposedCost: noCompleteCombo ? null : selectedCombo?.totalCost ?? fallbackCost,
	                            noCompleteCombo,
	                            attachableVerifiedCount: countAttachableBuyInCandidates(searchAudits),
	                          });
	                          return (
	                            <div className="space-y-2">
	                              <BuyInCancellationAdviceCard advice={advice} />
	                            </div>
	                          );
	                        })()}
                        {searchAudits.length > 0 && <AutoFillSearchAuditPanel audits={searchAudits} />}
                        {r.slots.map((slot) => {
                          const slotIsExpanded = expandedSlots.has(slotKey(r._id, slot.unitId));
                          const firstBuyInId = r.slots.find((s) => s.buyIn)?.buyIn?.id ?? null;
                          const manualMeta = buyInPropertyMetaForReservation(r);
                          const manualPhotoUrls = manualBuyInPhotoUrlsFromNotes(slot.buyIn?.notes);
                          return (
                          <div
                            key={slot.unitId}
                            className="bg-background rounded border"
                            data-testid={`slot-${r._id}-${slot.unitId}`}
                          >
                          <div
                            className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center"
                          >
                            <div className="shrink-0 md:w-24">
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
                                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                      {(() => {
                                        const badge = groundFloorBadge(slot.buyIn.groundFloorStatus as GroundFloorStatus | undefined);
                                        return (
                                          <Badge variant="outline" className={`text-[9px] ${badge.className}`} title={slot.buyIn.groundFloorEvidence ?? undefined}>
                                            {badge.label}
                                          </Badge>
                                        );
                                      })()}
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
                                          {buyInFoundViaAirbnbGoogleLens(slot.buyIn)
                                            ? `view on Airbnb Lens direct site (${sourceLabelForUrl(slot.buyIn.airbnbListingUrl)})`
                                            : `view on ${sourceLabelForUrl(slot.buyIn.airbnbListingUrl)}`} <ExternalLink className="h-2.5 w-2.5" />
                                        </a>
                                      )}
                                      {buyInFoundViaAirbnbGoogleLens(slot.buyIn) && (
                                        <Badge
                                          variant="outline"
                                          className="border-sky-200 bg-sky-50 text-[9px] text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
                                          title="The direct booking website was found by reverse-image search from the Airbnb listing photos."
                                        >
                                          Found via Airbnb Google Lens
                                        </Badge>
                                      )}
                                      {(() => {
                                        const airbnbAnchorUrl = airbnbAnchorUrlFromBuyInNotes(slot.buyIn);
                                        if (!airbnbAnchorUrl) return null;
                                        return (
                                          <a
                                            href={airbnbAnchorUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={(e) => e.stopPropagation()}
                                            className="text-primary hover:underline inline-flex items-center gap-0.5"
                                            title="Original Airbnb listing that supplied the date-specific price and availability."
                                          >
                                            original Airbnb <ExternalLink className="h-2.5 w-2.5" />
                                          </a>
                                        );
                                      })()}
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
                                    </div>
                                    {manualPhotoUrls.length > 0 && (
                                      <div className="mt-2 flex max-w-full gap-1.5 overflow-x-auto pb-0.5">
                                        {manualPhotoUrls.slice(0, 6).map((url, idx) => (
                                          <a
                                            key={`${url}-${idx}`}
                                            href={url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={(e) => e.stopPropagation()}
                                            className="block h-14 w-20 shrink-0 overflow-hidden rounded border bg-muted"
                                            title="Manual buy-in photo"
                                          >
                                            <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
                                          </a>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <p className="text-xs text-muted-foreground italic">No buy-in attached for this unit</p>
                              )}
                            </div>
                            <div className="shrink-0 flex w-full flex-wrap items-center gap-1 md:w-auto md:justify-end">
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
                                    onClick={() => slot.buyIn && setArrivalEditor(slot.buyIn)}
                                    data-testid={`button-arrival-details-${r._id}-${slot.unitId}`}
                                    title="Edit unit address, access code, Wi-Fi, parking, and manager contact"
                                  >
                                    <FileText className="h-3.5 w-3.5 mr-1" />
                                    Unit details
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => slot.buyIn && guestAlternativePageMutation.mutate({ reservation: r, slot, buyIn: slot.buyIn })}
                                    disabled={guestAlternativePageMutation.isPending}
                                    data-testid={`button-guest-alternative-page-${r._id}-${slot.unitId}`}
                                    title="Create a guest-facing alternative option page"
                                  >
                                    {guestAlternativePageMutation.isPending
                                      ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                      : <ExternalLink className="h-3.5 w-3.5 mr-1" />}
                                    Guest page
                                  </Button>
                                  {!isManualReservation(r) && (
                                    <Button
                                      size="sm"
                                      onClick={(e) => { e.stopPropagation(); setRelocateGuestTarget({ reservation: r }); }}
                                      data-testid={`button-relocate-guest-${r._id}-${slot.unitId}`}
                                      title={`Draft + send the guest an apology with the alternative Guest Page link, through ${channelKindOf(r) === "booking" ? "Booking.com" : channelKindOf(r) === "vrbo" ? "VRBO" : channelKindOf(r) === "airbnb" ? "Airbnb" : "their booking channel"} (the channel they booked with), and track whether they open it`}
                                    >
                                      <Send className="h-3.5 w-3.5 mr-1" />
                                      Message guest
                                    </Button>
                                  )}
                                  {/* Persistent confirmation that the relocation message was already
                                      sent for this reservation (rendered once, on the first filled
                                      slot). Survives closing the dialog + reloads. */}
                                  {slot.unitId === (r.slots.find((s) => s.buyIn)?.unitId ?? null)
                                    && relocationSentStatus[r._id]?.messageSentAt && (() => {
                                    const st = relocationSentStatus[r._id]!;
                                    return (
                                      <span
                                        className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                                        title={`Relocation message sent${st.messageChannel ? ` via ${st.messageChannel}` : ""} on ${fmtDate(st.messageSentAt)}${st.opened ? ` · guest opened the link${st.openCount ? ` ${st.openCount}×` : ""}${st.lastOpenedAt ? ` (last ${fmtDate(st.lastOpenedAt)})` : ""}` : " · not opened yet"}`}
                                        data-testid={`badge-guest-messaged-${r._id}`}
                                      >
                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                        Guest messaged {fmtDate(st.messageSentAt)}
                                        {st.opened ? " · opened ✓" : ""}
                                      </span>
                                    );
                                  })()}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => slot.buyIn && detachMutation.mutate({ buyInId: slot.buyIn.id, reservationId: r._id })}
                                    disabled={detachMutation.isPending}
                                    data-testid={`button-detach-${r._id}-${slot.unitId}`}
                                  >
                                    <Unlink className="h-3.5 w-3.5 mr-1" /> Detach
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button
                                    size="sm"
                                    onClick={() => setPicker({ reservation: r, slot })}
                                    data-testid={`button-find-buyin-${r._id}-${slot.unitId}`}
                                  >
                                    <Search className="h-3.5 w-3.5 mr-1" />
                                    Find {slot.bedrooms}BR+ buy-in
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => manualMeta && setManualBuyInTarget({
                                      reservation: r,
                                      slot,
                                      propertyId: manualMeta.propertyId,
                                      propertyName: manualMeta.propertyName,
                                    })}
                                    disabled={!manualMeta}
                                    data-testid={`button-manual-buyin-${r._id}-${slot.unitId}`}
                                    title={manualMeta ? "Record and attach a manually booked buy-in" : "Select a buy-in property target first"}
                                  >
                                    <Plus className="h-3.5 w-3.5 mr-1" />
                                    Manual
                                  </Button>
                                </>
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
                          {slot.buyIn && (
                            <BuyInVendorEmailPanel
                              reservation={r}
                              buyIn={slot.buyIn}
                              showAliasControls={slot.buyIn.id === firstBuyInId}
                            />
                          )}
                          {slotIsExpanded && selectedBuyInPropertyId && (
                            <div className="border-t bg-muted/20 px-3 py-3">
                              <LiveSearchSection
                                reservation={r}
                                propertyId={selectedBuyInPropertyId}
                                slot={slot}
                                listingId={selectedListingId}
                                enableGroundFloorRequirement={selectedHasBuyInConfig}
                              />
                            </div>
                          )}
                          </div>
                          );
                        })}
                        <UnitProximityCard reservation={r} />
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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

            <TabsContent value="cancelled" className="space-y-4">
              <Card>
                <CardContent className="py-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="w-48">
                      <Label className="text-xs mb-1.5 block">Guesty scan range</Label>
                      <Select value={cancellationRange} onValueChange={(v) => setCancellationRange(v as "all" | "365" | "90")}>
                        <SelectTrigger data-testid="select-cancellation-range">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All history</SelectItem>
                          <SelectItem value="365">Last 365 days</SelectItem>
                          <SelectItem value="90">Last 90 days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      onClick={() => cancellationScanMutation.mutate()}
                      disabled={cancellationScanMutation.isPending || !selectedPropertyId}
                      data-testid="button-scan-cancellations"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${cancellationScanMutation.isPending ? "animate-spin" : ""}`} />
                      Scan cancelled bookings
                    </Button>
                    <p className="text-xs text-muted-foreground max-w-2xl">
                      Pulls cancelled Guesty reservations for this property and flags rows where money was collected but not fully refunded.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs text-muted-foreground">Cancelled bookings</p>
                    <p className="text-2xl font-semibold mt-1">{cancellationStats.total}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs text-muted-foreground">Payment taken</p>
                    <p className="text-2xl font-semibold mt-1">{cancellationStats.paymentTaken}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs text-muted-foreground">Refund review needed</p>
                    <p className={`text-2xl font-semibold mt-1 ${cancellationStats.reviewNeeded > 0 ? "text-red-600" : "text-green-600"}`}>
                      {cancellationStats.reviewNeeded}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{fmtMoney(cancellationStats.exposure)} possible exposure</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs text-muted-foreground">Resolved</p>
                    <p className="text-2xl font-semibold mt-1">{cancellationStats.resolved}</p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" /> Cancellation Refund Check
                    {(cancellationsLoading || cancellationScanMutation.isPending) && (
                      <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground ml-1" />
                    )}
                  </CardTitle>
                  <CardDescription>
                    Review Guesty cancellations where a guest may have paid. Mark each row once refund responsibility is handled.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {cancellationsError && (
                    <div className="border border-destructive rounded px-3 py-2 mb-3 text-sm text-destructive">
                      {(cancellationsErr as Error)?.message}
                    </div>
                  )}
                  {!cancellationsLoading && cancellationRows.length === 0 && (
                    <p className="text-sm text-muted-foreground py-6 text-center">
                      No cancelled bookings saved yet. Run a scan for this property.
                    </p>
                  )}
                  {cancellationRows.length > 0 && (
                    <div className="overflow-x-auto">
                      <div className="min-w-[1120px]">
                        <div className="grid grid-cols-[1.25fr_1.15fr_.95fr_.8fr_.8fr_.9fr_1fr_1.2fr] gap-3 px-3 py-2 border-b text-[10px] uppercase tracking-wider text-muted-foreground">
                          <div>Guest</div>
                          <div>Stay / Cancelled</div>
                          <div className="text-right">Paid</div>
                          <div className="text-right">Refunded</div>
                          <div className="text-right">Net held</div>
                          <div>Decision</div>
                          <div>Operator status</div>
                          <div>Notes</div>
                        </div>
                        <div className="divide-y">
                          {cancellationRows.map((row) => {
                            const paid = asMoneyNumber(row.totalPaid);
                            const refunded = asMoneyNumber(row.totalRefunded);
                            const netHeld = Math.max(0, paid - refunded);
                            return (
                              <div
                                key={row.id}
                                className="grid grid-cols-[1.25fr_1.15fr_.95fr_.8fr_.8fr_.9fr_1fr_1.2fr] gap-3 px-3 py-3 items-start text-sm"
                                data-testid={`cancellation-row-${row.id}`}
                              >
                                <div className="min-w-0">
                                  <p className="font-medium truncate">{row.guestName || "Guest"}</p>
                                  <p className="text-[10px] text-muted-foreground font-mono truncate">{row.confirmationCode || row.guestyReservationId}</p>
                                  <a
                                    href={`https://app.guesty.com/reservations/${row.guestyReservationId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5 mt-1"
                                  >
                                    Open in Guesty <ExternalLink className="h-2.5 w-2.5" />
                                  </a>
                                </div>
                                <div>
                                  <p>{fmtDate(row.checkIn)} → {fmtDate(row.checkOut)}</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    cancelled {fmtDate(row.cancelledAt)} · <span className="capitalize">{row.channel || "direct"}</span>
                                  </p>
                                </div>
                                <div className="text-right font-medium">{fmtMoney(paid)}</div>
                                <div className="text-right">{fmtMoney(refunded)}</div>
                                <div className={`text-right font-medium ${netHeld > 0 ? "text-red-600" : "text-green-600"}`}>
                                  {fmtMoney(netHeld)}
                                </div>
                                <div>
                                  <Badge
                                    variant={row.refundDecision === "unknown" ? "outline" : "default"}
                                    className={`text-[10px] ${refundDecisionClass(row.refundDecision)}`}
                                  >
                                    {refundDecisionLabel(row.refundDecision)}
                                  </Badge>
                                </div>
                                <div>
                                  <Select
                                    value={row.operatorStatus || "needs_review"}
                                    onValueChange={(operatorStatus) => cancellationUpdateMutation.mutate({ id: row.id, operatorStatus })}
                                  >
                                    <SelectTrigger className="h-8 text-xs" data-testid={`select-cancellation-status-${row.id}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="needs_review">Needs review</SelectItem>
                                      <SelectItem value="refunded">Refunded</SelectItem>
                                      <SelectItem value="no_refund_due">No refund due</SelectItem>
                                      <SelectItem value="disputed">Disputed</SelectItem>
                                      <SelectItem value="ignored">Ignore</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <Textarea
                                  defaultValue={row.operatorNotes ?? ""}
                                  rows={2}
                                  className="text-xs min-h-[52px]"
                                  placeholder="Add refund note..."
                                  onBlur={(e) => {
                                    const operatorNotes = e.currentTarget.value;
                                    if (operatorNotes !== (row.operatorNotes ?? "")) {
                                      cancellationUpdateMutation.mutate({ id: row.id, operatorNotes });
                                    }
                                  }}
                                  data-testid={`textarea-cancellation-notes-${row.id}`}
                                />
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

      <Dialog open={bulkBuyInQueueOpen} onOpenChange={setBulkBuyInQueueOpen}>
        <DialogContent className="max-w-6xl">
          <DialogHeader>
            <DialogTitle>Bulk buy-in queue</DialogTitle>
            <DialogDescription>
              Sequential buy-in searches using the same Auto-fill cheapest path as individual bookings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="rounded border bg-muted/20 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Queued</p>
                <p className="text-xl font-semibold">{bulkQueueSummary.total}</p>
              </div>
              <div className="rounded border bg-muted/20 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Finished</p>
                <p className="text-xl font-semibold">{bulkQueueSummary.finished}</p>
              </div>
              <div className="rounded border bg-muted/20 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Completed</p>
                <p className="text-xl font-semibold text-green-700">{bulkQueueSummary.completed}</p>
              </div>
              <div className="rounded border bg-muted/20 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Needs review</p>
                <p className="text-xl font-semibold text-amber-700">
                  {bulkQueueSummary.failed + bulkQueueSummary.skipped + bulkQueueSummary.cancelled}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {bulkBuyInQueueRunning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-green-700" />
                  )}
                  <span>
                    {bulkBuyInQueueRunning
                      ? `Running ${bulkQueueSummary.running || 1} item at a time`
                      : bulkQueueSummary.total > 0
                        ? "Queue finished"
                        : "No queue has run yet"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SidecarStatusBadge />
                  {bulkBuyInQueueRunning && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={cancelBulkBuyInQueue}
                      data-testid="button-cancel-bulk-buy-in-queue"
                    >
                      <Square className="h-3.5 w-3.5 mr-1.5" />
                      Cancel remaining
                    </Button>
                  )}
                </div>
              </div>
              <Progress value={bulkQueueSummary.percent} className="h-2" />
            </div>

            <div className="overflow-hidden rounded border">
              <div className="max-h-[460px] overflow-auto">
                <div className="min-w-[980px]">
                  <div className="sticky top-0 z-10 grid grid-cols-[120px_1.3fr_1.2fr_2fr_1.5fr] gap-3 border-b bg-muted/95 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
                    <div>Status</div>
                    <div>Listing name</div>
                    <div>Guest</div>
                    <div>Queued for</div>
                    <div>Log</div>
                  </div>
                  <div className="divide-y">
                    {bulkBuyInQueueItems.length === 0 ? (
                      <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                        Select bookings in the global table and click Run bulk buy-ins.
                      </div>
                    ) : (
                      bulkBuyInQueueItems.map((item) => (
                        <div
                          key={item.id}
                          className="grid grid-cols-[120px_1.3fr_1.2fr_2fr_1.5fr] gap-3 px-3 py-2.5 text-sm"
                          data-testid={`bulk-buy-in-queue-item-${item.reservationId}`}
                        >
                          <div>
                            <Badge
                              variant={item.status === "completed" ? "default" : "outline"}
                              className={`text-[10px] ${
                                item.status === "completed"
                                  ? "bg-green-600 text-white"
                                  : item.status === "running"
                                    ? "border-blue-300 text-blue-700"
                                    : item.status === "failed"
                                      ? "border-red-300 text-red-700"
                                      : item.status === "skipped"
                                        ? "border-amber-300 text-amber-700"
                                        : item.status === "cancelled"
                                          ? "border-muted-foreground/30 text-muted-foreground"
                                          : ""
                              }`}
                            >
                              {item.status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
                              {item.status}
                            </Badge>
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              {fmtDate(item.checkIn)} to {fmtDate(item.checkOut)}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{item.propertyName}</p>
                            <p className="text-[10px] text-muted-foreground">#{item.propertyId}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="truncate">{item.guestName}</p>
                            <p className="text-[10px] text-muted-foreground">{item.reservationId}</p>
                          </div>
                          <p className="text-xs text-muted-foreground">{item.queuedFor}</p>
                          <div className="min-w-0">
                            <p className={`text-xs ${item.status === "failed" ? "text-red-700" : "text-muted-foreground"}`}>
                              {item.message}
                            </p>
                            {item.error && (
                              <p className="mt-1 whitespace-pre-wrap break-words rounded bg-red-50 px-2 py-1 text-[10px] text-red-800">
                                {item.error}
                              </p>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={manualDialogOpen}
        onOpenChange={(open) => {
          setManualDialogOpen(open);
          if (!open) setManualForm(emptyManualReservationForm());
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add manual reservation</DialogTitle>
            <DialogDescription>
              Operations-only record for buy-in tracking. It will not create a Guesty booking or OTA message thread.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="manual-property">Property</Label>
              <Select
                value={manualForm.propertyId}
                onValueChange={(value) => setManualForm((prev) => ({ ...prev, propertyId: value }))}
              >
                <SelectTrigger id="manual-property" data-testid="select-manual-reservation-property">
                  <SelectValue placeholder="Choose a buy-in property" />
                </SelectTrigger>
                <SelectContent>
                  {manualReservationPropertyMap.map((mapping) => (
                    <SelectItem key={mapping.propertyId} value={String(mapping.propertyId)}>
                      {listingNameById.get(mapping.guestyListingId) ?? `Property ${mapping.propertyId}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-guest-name">Guest name</Label>
              <Input
                id="manual-guest-name"
                value={manualForm.guestName}
                onChange={(e) => setManualForm((prev) => ({ ...prev, guestName: e.target.value }))}
                placeholder="Guest name"
                data-testid="input-manual-reservation-guest"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-rate">Total rate</Label>
              <Input
                id="manual-rate"
                type="number"
                min="0"
                step="0.01"
                value={manualForm.totalRate}
                onChange={(e) => setManualForm((prev) => ({ ...prev, totalRate: e.target.value }))}
                placeholder="0.00"
                data-testid="input-manual-reservation-rate"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-check-in">Check-in</Label>
              <Input
                id="manual-check-in"
                type="date"
                value={manualForm.checkIn}
                onChange={(e) => setManualForm((prev) => ({ ...prev, checkIn: e.target.value }))}
                data-testid="input-manual-reservation-check-in"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-check-out">Check-out</Label>
              <Input
                id="manual-check-out"
                type="date"
                value={manualForm.checkOut}
                onChange={(e) => setManualForm((prev) => ({ ...prev, checkOut: e.target.value }))}
                data-testid="input-manual-reservation-check-out"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-email">Email</Label>
              <Input
                id="manual-email"
                type="email"
                value={manualForm.guestEmail}
                onChange={(e) => setManualForm((prev) => ({ ...prev, guestEmail: e.target.value }))}
                placeholder="guest@example.com"
                data-testid="input-manual-reservation-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-phone">Phone</Label>
              <Input
                id="manual-phone"
                value={manualForm.guestPhone}
                onChange={(e) => setManualForm((prev) => ({ ...prev, guestPhone: e.target.value }))}
                placeholder="+18085551234"
                data-testid="input-manual-reservation-phone"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="manual-notes">Notes</Label>
              <Textarea
                id="manual-notes"
                value={manualForm.notes}
                onChange={(e) => setManualForm((prev) => ({ ...prev, notes: e.target.value }))}
                rows={3}
                placeholder="Internal notes for this manual buy-in record"
                data-testid="textarea-manual-reservation-notes"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setManualDialogOpen(false);
                setManualForm(emptyManualReservationForm());
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                createManualReservationMutation.isPending ||
                !manualForm.propertyId ||
                !manualForm.guestName.trim() ||
                !manualForm.checkIn ||
                !manualForm.checkOut ||
                !manualForm.totalRate
              }
              onClick={() => createManualReservationMutation.mutate(manualForm)}
              data-testid="button-create-manual-reservation"
            >
              {createManualReservationMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Adding...
                </>
              ) : (
                "Add reservation"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          {picker && selectedBuyInPropertyId && (
            <CandidateList
              reservation={picker.reservation}
              propertyId={selectedBuyInPropertyId}
              slot={picker.slot}
              listingId={selectedListingId}
              enableGroundFloorRequirement={selectedHasBuyInConfig}
            />
          )}
        </DialogContent>
      </Dialog>

      {manualBuyInTarget && (
        <ManualBuyInDialog
          reservation={manualBuyInTarget.reservation}
          propertyId={manualBuyInTarget.propertyId}
          propertyName={manualBuyInTarget.propertyName}
          slot={manualBuyInTarget.slot}
          onClose={() => setManualBuyInTarget(null)}
        />
      )}

      {vrboGuestPageTarget && (
        <VrboGuestPageDialog
          reservation={vrboGuestPageTarget.reservation}
          propertyName={vrboGuestPageTarget.propertyName}
          onClose={() => setVrboGuestPageTarget(null)}
        />
      )}
      {relocateGuestTarget && (
        <RelocateGuestDialog
          reservation={relocateGuestTarget.reservation}
          onClose={() => setRelocateGuestTarget(null)}
        />
      )}

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
      {arrivalEditor && (
        <ArrivalDetailsDialog
          buyIn={arrivalEditor}
          isSaving={saveArrivalDetails.isPending}
          onClose={() => setArrivalEditor(null)}
          onSave={(data) => saveArrivalDetails.mutate({ id: arrivalEditor.id, data })}
        />
      )}
    </div>
  );
}

function BuyInVendorEmailPanel({
  reservation,
  buyIn,
  showAliasControls,
}: {
  reservation: GuestyReservation;
  buyIn: BuyIn;
  showAliasControls: boolean;
}) {
  const { toast } = useToast();
  const guestName = reservation.guest?.fullName ?? "";
  const [vendorName, setVendorName] = useState(buyIn.managementCompany ?? "");
  const [vendorEmail, setVendorEmail] = useState(() => extractEmailForInput(buyIn.managementContact ?? ""));
  const [subject, setSubject] = useState(() => `Arrival details request for ${buyIn.unitLabel || buyIn.propertyName}`);
  const [attachments, setAttachments] = useState<AliasEmailAttachment[]>([]);
  const [body, setBody] = useState(() => [
    `Aloha,`,
    ``,
    `We booked ${buyIn.propertyName}${buyIn.unitLabel ? ` - ${buyIn.unitLabel}` : ""} for ${guestName || "our guest"} from ${fmtDate(buyIn.checkIn)} to ${fmtDate(buyIn.checkOut)}.`,
    `Can you please send the arrival details, property address, access code, Wi-Fi, parking instructions, and any check-in notes when available?`,
    ``,
    `Mahalo,`,
    `John Carpenter`,
  ].join("\n"));

  const queryKey = ["/api/bookings", reservation._id, "buy-in-communications"];
  const { data, isLoading } = useQuery<BuyInCommunicationsResponse>({
    queryKey,
    enabled: !!reservation._id && !!buyIn.id,
    queryFn: () => apiRequest("GET", `/api/bookings/${reservation._id}/buy-in-communications`).then((r) => r.json()),
  });
  const contact = data?.contacts?.find((row) => row.buyInId === buyIn.id) ?? null;
  const emails = (data?.emails ?? []).filter((row) => row.buyInId === buyIn.id).slice(0, 3);

  const createAlias = useMutation({
    mutationFn: () => apiRequest("POST", `/api/bookings/${reservation._id}/simplelogin/alias`, { guestName }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Alias ready", description: "SimpleLogin alias saved for this booking." });
    },
    onError: (err: any) => toast({ title: "Alias failed", description: err?.message ?? "Could not create alias", variant: "destructive" }),
  });

  const saveContact = useMutation({
    mutationFn: () => apiRequest("POST", `/api/buy-ins/${buyIn.id}/vendor-contact`, {
      reservationId: reservation._id,
      guestName,
      vendorName,
      vendorEmail,
    }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Vendor contact saved", description: "Reverse alias created for this PM/vendor." });
    },
    onError: (err: any) => toast({ title: "Contact failed", description: err?.message ?? "Could not save vendor contact", variant: "destructive" }),
  });

  const sendEmail = useMutation({
    mutationFn: () => apiRequest("POST", `/api/buy-ins/${buyIn.id}/vendor-email`, {
      reservationId: reservation._id,
      guestName,
      vendorName,
      vendorEmail,
      subject,
      body,
      attachments,
    }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setAttachments([]);
      toast({ title: "Email sent", description: "The PM/vendor reply will come back through the alias." });
    },
    onError: (err: any) => toast({ title: "Email failed", description: err?.message ?? "Could not send vendor email", variant: "destructive" }),
  });

  const addAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const next = await filesToAliasEmailAttachments(files);
      setAttachments((prev) => [...prev, ...next]);
    } catch (err: any) {
      toast({ title: "Attachment skipped", description: err?.message ?? "Could not read attachment", variant: "destructive" });
    }
  };

  return (
    <div className="border-t bg-muted/15 px-3 py-2.5 space-y-2">
      {showAliasControls && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">Booking email alias</span>
          {data?.alias ? (
            <>
              <Badge variant="outline" className="font-mono text-[10px]">{data.alias.aliasEmail}</Badge>
              {(() => {
                const expiry = aliasExpirationSummary(data.alias.expiresAt);
                return (
                  <Badge variant={expiry.expired ? "destructive" : "secondary"} className="text-[10px]">
                    {expiry.expired ? "Expired" : `Expires ${expiry.date}`}
                  </Badge>
                );
              })()}
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => createAlias.mutate()}
              disabled={createAlias.isPending || isLoading}
            >
              {createAlias.isPending ? "Creating..." : "Create booking alias"}
            </Button>
          )}
          {contact?.reverseAliasEmail && (
            <Badge variant="secondary" className="font-mono text-[10px]">to PM via {contact.reverseAliasEmail}</Badge>
          )}
          {data?.alias && (
            <span className="basis-full text-[11px] text-muted-foreground">
              Saved alias messages and attachments stay in history after the alias expires.
            </span>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_auto] gap-2">
        <Input
          value={vendorName}
          onChange={(e) => setVendorName(e.target.value)}
          placeholder="PM / buy-in company"
          className="h-8 text-xs"
        />
        <Input
          value={vendorEmail}
          onChange={(e) => setVendorEmail(e.target.value)}
          placeholder="pm@example.com"
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => saveContact.mutate()}
          disabled={saveContact.isPending || !vendorEmail.trim()}
        >
          Save PM contact
        </Button>
      </div>
      <details className="group">
        <summary className="cursor-pointer text-xs text-primary font-medium">Compose arrival-details request</summary>
        <div className="mt-2 space-y-2">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-8 text-xs" />
          <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} className="text-xs" />
          <div className="rounded-md border bg-background/60 p-2">
            <Label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium">
              <Paperclip className="h-3 w-3" />
              Attachments
            </Label>
            <Input
              type="file"
              multiple
              className="h-8 text-xs"
              onChange={(event) => {
                void addAttachments(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
            {attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {attachments.map((attachment, index) => (
                  <Badge key={`${attachment.filename}-${index}`} variant="secondary" className="gap-1 text-[10px]">
                    <Paperclip className="h-3 w-3" />
                    <span className="max-w-[180px] truncate">{attachment.filename}</span>
                    {formatAttachmentSize(attachment.size) && <span>{formatAttachmentSize(attachment.size)}</span>}
                    <button
                      type="button"
                      className="ml-0.5 rounded-sm hover:bg-background/70"
                      onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                      aria-label={`Remove ${attachment.filename}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-muted-foreground">
              Sends from reservations mailbox to the SimpleLogin reverse alias so the vendor sees the guest alias.
            </div>
            <Button
              size="sm"
              onClick={() => sendEmail.mutate()}
              disabled={sendEmail.isPending || !vendorEmail.trim() || !subject.trim() || !body.trim()}
            >
              {sendEmail.isPending ? "Sending..." : "Send PM email"}
            </Button>
          </div>
        </div>
      </details>
      <details className="rounded-md border bg-background/70 p-2" open={emails.length > 0}>
        <summary className="cursor-pointer text-xs font-medium">Alias email history ({emails.length})</summary>
        <div className="mt-2 space-y-2">
          {emails.length === 0 && (
            <div className="text-[11px] text-muted-foreground">No PM/vendor emails saved for this unit yet.</div>
          )}
          {emails.map((email) => {
            const emailAttachments = parseAliasEmailAttachments(email.attachmentsJson);
            return (
              <div key={email.id} className="rounded border bg-muted/20 p-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{email.subject}</span>
                  <Badge variant={email.direction === "inbound" ? "secondary" : "outline"} className="text-[10px]">
                    {email.direction}
                  </Badge>
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {email.fromEmail} → {email.toEmail} · {email.status ?? "saved"}
                </div>
                <div className="mt-1 whitespace-pre-wrap leading-relaxed text-foreground">
                  {email.body}
                </div>
                {emailAttachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {emailAttachments.map((attachment, index) => {
                      const href = aliasAttachmentHref(attachment);
                      const label = `${attachment.filename}${formatAttachmentSize(attachment.size) ? ` · ${formatAttachmentSize(attachment.size)}` : ""}`;
                      return href ? (
                        <a
                          key={`${attachment.filename}-${index}`}
                          href={href}
                          download={attachment.filename}
                          target={attachment.url ? "_blank" : undefined}
                          rel={attachment.url ? "noreferrer" : undefined}
                          className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] text-primary hover:underline"
                        >
                          <Paperclip className="h-3 w-3 shrink-0" />
                          <span className="truncate">{label}</span>
                        </a>
                      ) : (
                        <span
                          key={`${attachment.filename}-${index}`}
                          className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          <Paperclip className="h-3 w-3 shrink-0" />
                          <span className="truncate">{label}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function extractEmailForInput(value: string): string {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] ?? "";
}

function ArrivalDetailsDialog({
  buyIn,
  isSaving,
  onClose,
  onSave,
}: {
  buyIn: BuyIn;
  isSaving: boolean;
  onClose: () => void;
  onSave: (data: Partial<BuyIn>) => void;
}) {
  const [form, setForm] = useState({
    unitAddress: buyIn.unitAddress ?? "",
    accessCode: buyIn.accessCode ?? "",
    wifiName: buyIn.wifiName ?? "",
    wifiPassword: buyIn.wifiPassword ?? "",
    parkingInfo: buyIn.parkingInfo ?? "",
    managementCompany: buyIn.managementCompany ?? "",
    managementContact: buyIn.managementContact ?? "",
    arrivalNotes: buyIn.arrivalNotes ?? "",
  });
  const set = (key: keyof typeof form, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Unit arrival details</DialogTitle>
          <DialogDescription>
            {buyIn.unitLabel} · {fmtDate(buyIn.checkIn)} → {fmtDate(buyIn.checkOut)}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>Unit address</Label>
            <Input value={form.unitAddress} onChange={(e) => set("unitAddress", e.target.value)} placeholder="Street address, unit number, resort/building" />
          </div>
          <div>
            <Label>Access code</Label>
            <Input value={form.accessCode} onChange={(e) => set("accessCode", e.target.value)} placeholder="Door / lockbox code" />
          </div>
          <div>
            <Label>Management company</Label>
            <Input value={form.managementCompany} onChange={(e) => set("managementCompany", e.target.value)} placeholder="Company name" />
          </div>
          <div>
            <Label>Wi-Fi name</Label>
            <Input value={form.wifiName} onChange={(e) => set("wifiName", e.target.value)} placeholder="Network name" />
          </div>
          <div>
            <Label>Wi-Fi password</Label>
            <Input value={form.wifiPassword} onChange={(e) => set("wifiPassword", e.target.value)} placeholder="Password" />
          </div>
          <div className="col-span-2">
            <Label>Management contact</Label>
            <Input value={form.managementContact} onChange={(e) => set("managementContact", e.target.value)} placeholder="Phone, email, after-hours contact" />
          </div>
          <div className="col-span-2">
            <Label>Parking info</Label>
            <Textarea rows={2} value={form.parkingInfo} onChange={(e) => set("parkingInfo", e.target.value)} placeholder="Assigned stall, permits, garage notes" />
          </div>
          <div className="col-span-2">
            <Label>Arrival notes</Label>
            <Textarea rows={4} value={form.arrivalNotes} onChange={(e) => set("arrivalNotes", e.target.value)} placeholder="Check-in desk, gate code, elevator, unit-specific instructions" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(form)} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save details"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Candidate list component ───────────────────────────────────────────────

function CandidateList({
  reservation,
  propertyId,
  slot,
  listingId,
  enableGroundFloorRequirement = true,
}: {
  reservation: GuestyReservation;
  propertyId: number;
  slot: SlotInfo;
  listingId?: string | null;
  enableGroundFloorRequirement?: boolean;
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
        listingId={listingId}
        enableGroundFloorRequirement={enableGroundFloorRequirement}
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

// ─── Live search across Airbnb, Vrbo map bounds, plus Airbnb Lens links ───

type LiveCandidate = {
  source: "airbnb" | "vrbo" | "booking" | "pm";
  sourceLabel: string;
  title: string;
  url: string;
  originalSourceUrl?: string;
  nightlyPrice: number;
  totalPrice: number;
  bedrooms?: number;
  image?: string;
  // Full listing photo gallery (VRBO/Airbnb/etc.) when the source card exposes
  // more than the single hero image. Carried through to the buy-in notes so the
  // guest-facing alternative page can show real listing photos.
  images?: string[];
  lat?: number;
  lng?: number;
  snippet?: string;
  // Reverse-image-search hits where the same photo appears on a non-OTA
  // site (typically a property-management company that has the same
  // unit listed for direct booking). Populated for the top N priced
  // Airbnb candidates server-side. Zero-length when no matches were
  // found OR the candidate isn't in the top-N pool.
  photoMatches?: Array<{
    url: string;
    title: string;
    domain: string;
    matchedPhotoCount?: number;
    minConfidence?: number;
    maxConfidence?: number;
    proof?: DirectBookingProof;
  }>;
  directBookingUrl?: string;
  directBookingHost?: string;
  directBookingConfidence?: "high" | "medium" | "low";
  directBookingSource?: "airbnb_image_reverse_search";
  directBookingReason?: string;
  directProof?: DirectBookingProof;
  // When this candidate is derived from a grouped physical unit, keep
  // every known listing URL in the cluster so Auto-fill can avoid
  // choosing the same unit again through another channel.
  alternateUrls?: string[];
  // Precomputed identity keys from a grouped physical unit. These
  // supplement URL/image/title matching when Auto-fill compares
  // combination candidates.
  identityKeys?: string[];
  // For PM candidates surfaced via reverse-image match against an
  // Airbnb listing: the anchor's URL + price are traceability only.
  // Auto-fill requires the PM page to verify its own bedroom count and
  // date-specific quote before this candidate can be attached.
  airbnbAnchorUrl?: string;
  airbnbAnchorPrice?: number;
  // Server-side verification state (find-buy-in pre-verifies top-N
  // priced PM candidates against actual PM page). The Cheapest panel
  // is gated on this — operators should never see "buy this" for a
  // unit that isn't confirmed bookable for the requested dates.
  verified?: "yes" | "no" | "unclear" | "skipped";
  verifiedNightlyPrice?: number | null;
  verifiedReason?: string;
  groundFloorStatus?: GroundFloorStatus;
  groundFloorEvidence?: string | null;
  lat?: number;
  lng?: number;
};

// Single channel inside a clustered unit (one row inside a UnitRow).
// Mirrors server's ListingChannel from /api/operations/find-buy-in.
type LiveUnitListing = {
  channel: "airbnb" | "vrbo" | "booking" | "pm";
  channelLabel: string;
  url: string;
  originalSourceUrl?: string;
  nightlyPrice: number;
  totalPrice: number;
  bedrooms?: number;
  lat?: number;
  lng?: number;
  verified?: "yes" | "no" | "unclear" | "skipped";
  verifiedReason?: string;
  airbnbAnchorUrl?: string;
  airbnbAnchorPrice?: number;
  directBookingUrl?: string;
  directBookingHost?: string;
  directBookingSource?: "airbnb_image_reverse_search";
  directBookingReason?: string;
  directProof?: DirectBookingProof;
  groundFloorStatus?: GroundFloorStatus;
  groundFloorEvidence?: string | null;
};

type LiveUnit = {
  unitTitle: string;
  bedrooms?: number;
  image?: string;
  lat?: number;
  lng?: number;
  groundFloorStatus?: GroundFloorStatus;
  groundFloorEvidence?: string | null;
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
  confidence?: number;
  matchedPhotoUrl?: string;
  matchedPhotoRole?: "main" | "living-room" | "interior";
  matchedPhotoLabel?: string | null;
  matchedPhotoCategory?: string | null;
  matchedPhotoCount?: number;
  minConfidence?: number;
  maxConfidence?: number;
  proof?: DirectBookingProof;
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
  groundFloorOnly?: boolean;
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
  comparisonSources?: {
    airbnb?: LiveCandidate[];
    vrbo?: LiveCandidate[];
    booking?: LiveCandidate[];
    pm?: LiveCandidate[];
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
  totalPricedResults?: number;
  debug?: {
    rawCounts?: {
      airbnb?: number;
      airbnbEngine?: number;
      airbnbWebsiteSidecar?: number;
      vrbo?: number;
      booking?: number;
      bookingWebsiteSidecar?: number;
      pm?: number;
      pmFromWebsiteSidecar?: number;
      pmWebsiteSidecarRaw?: number;
      photoMatches?: number;
    };
    dropped?: {
      airbnb?: { noResort: number; wrongBedrooms: number };
      vrbo?: { noResort: number; wrongBedrooms: number };
      booking?: { noResort: number; wrongBedrooms: number };
      photoMatchBedroomMismatch?: number;
      photoMatchLanding?: number;
      targetFilter?: { airbnb?: number; vrbo?: number; booking?: number; pm?: number };
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
    vrboMapSearch?: {
      scope?: string;
      scoutMarketKey?: string | null;
      resortPhrase?: string | null;
    };
    mapHarvest?: {
      vrbo?: Record<string, unknown>;
      booking?: Record<string, unknown>;
    };
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
    searched?: boolean;
    raw?: number;
    kept?: number;
    priced?: number;
    verified?: number;
    durationMs?: number;
    message?: string;
    failureReason?: string | null;
    providerHealth?: string | null;
    proxyHealth?: string | null;
    cooldownUntil?: string | null;
    retryAfterMs?: number | null;
    confidence?: "high" | "medium" | "low" | "none" | string;
    searchTerm?: string | null;
    accessPattern?: string | null;
    datesSearched?: { checkIn?: string; checkOut?: string; nights?: number };
    bedroomFilter?: { bedrooms?: number; applied?: boolean; mode?: string };
    resultCounts?: { raw?: number; kept?: number; priced?: number; verified?: number };
    searchVariationSummary?: SidecarSearchVariationSummary | null;
  }>;
  providerStatuses?: Array<{
    source: string;
    status: "ok" | "warning" | "error" | "timeout" | "skipped";
    searched?: boolean;
    raw?: number;
    kept?: number;
    priced?: number;
    verified?: number;
    durationMs?: number;
    message?: string;
    failureReason?: string | null;
    providerHealth?: string | null;
    proxyHealth?: string | null;
    cooldownUntil?: string | null;
    retryAfterMs?: number | null;
    confidence?: "high" | "medium" | "low" | "none" | string;
    searchTerm?: string | null;
    accessPattern?: string | null;
    datesSearched?: { checkIn?: string; checkOut?: string; nights?: number };
    bedroomFilter?: { bedrooms?: number; applied?: boolean; mode?: string };
    resultCounts?: { raw?: number; kept?: number; priced?: number; verified?: number };
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

function groundFloorBadge(status?: GroundFloorStatus | null) {
  switch (status) {
    case "confirmed":
      return { label: "Ground floor", className: "bg-emerald-100 text-emerald-800 border-emerald-300" };
    case "conflict":
      return { label: "Upper-floor conflict", className: "bg-red-100 text-red-800 border-red-300" };
    case "not_confirmed":
      return { label: "Ground floor not shown", className: "bg-amber-100 text-amber-800 border-amber-300" };
    default:
      return { label: "Floor unknown", className: "bg-slate-100 text-slate-700 border-slate-300" };
  }
}

function groundFloorRequirementLabel(req?: GroundFloorRequirement | null): string {
  if (!req?.requested) return "No ground-floor request found";
  const targetBedrooms = groundFloorTargetBedrooms(req);
  if (targetBedrooms.length) {
    return `Ground-floor needed: ${targetBedrooms.map((b) => `${b}BR`).join(" + ")} unit${targetBedrooms.length === 1 ? "" : "s"}`;
  }
  if (req.scope === "both") return "Ground-floor needed: both units";
  if (req.scope === "one") return "Ground-floor needed: at least one unit";
  return "Ground-floor/accessibility need found: clarify scope";
}

// Sidecar status indicator + manual stop/start controls.
// The buy-in tool delegates Airbnb, VRBO map, and PM website
// searches to a polling worker. In production that worker runs on
// Railway and drives a server Chrome service; local workers are still
// supported for development. Polls /heartbeat every 5s anywhere
// Operations is mounted (was 30s; tighter cadence now that the popover
// surfaces a live "active job for Ns" counter and the operator wants
// to see it tick during a search).
//
// CODEX NOTE (2026-05-05): these controls manage the Railway queue,
// not the macOS LaunchAgent process. Stop cancels active+pending work
// and pauses dispatch. Start clears the pause flag. If the badge is
// offline, the worker process/service must be restarted outside the web app.
type SidecarHeartbeat = {
  isOnline: boolean;
  everSeen: boolean;
  ageMs: number | null;
  lastWorkerPollAt: string | null;
  paused: boolean;
  pausedAt: string | null;
  pausedAgeMs: number | null;
  pausedReason: string | null;
  activeJob: {
    id: string;
    label: string;
    opType: string;
    stage?: string;
    activeSec: number;
  } | null;
  workerRuntime?: {
    slot?: string;
    workerRole?: string;
    browserMode?: string;
    chromePrimary?: string;
    source?: "server" | "local" | "unknown";
  } | null;
};

type SidecarScreenSnapshot = {
  slot: string;
  requestId?: string;
  opType?: string;
  label?: string;
  phase?: string;
  url?: string;
  title?: string;
  liveViewUrl?: string;
  screenshotDataUrl?: string;
  width?: number;
  height?: number;
  captcha?: boolean;
  active?: boolean;
  error?: string;
  at: string;
  ageMs: number;
};

type SidecarScreensResponse = {
  maxScreens: number;
  screens: SidecarScreenSnapshot[];
  heartbeat?: SidecarHeartbeat;
};

function sidecarScreenAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "now";
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  return `${Math.round(ageMs / 60_000)}m ago`;
}

function isServerSidecarRuntime(runtime: SidecarHeartbeat["workerRuntime"] | null | undefined): boolean {
  return runtime?.source === "server" ||
    runtime?.workerRole === "server" ||
    runtime?.browserMode === "server" ||
    runtime?.chromePrimary === "server";
}

function sidecarRuntimeName(runtime: SidecarHeartbeat["workerRuntime"] | null | undefined): string {
  if (isServerSidecarRuntime(runtime)) return "Railway sidecar worker";
  if (runtime?.source === "local" || runtime?.workerRole || runtime?.browserMode || runtime?.chromePrimary) return "Local sidecar worker";
  return "Sidecar worker";
}

function sidecarQueueAge(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "now";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const hourMinutes = minutes % 60;
  return hourMinutes > 0 ? `${hours}h ${hourMinutes}m` : `${hours}h`;
}

function SidecarQueueRequestRow({
  request,
  kind,
  acting,
  onAction,
}: {
  request: SidecarQueueRequest;
  kind: "active" | "pending" | "paused";
  acting: string | null;
  onAction: (request: SidecarQueueRequest, action: "cancel" | "pause" | "resume") => void;
}) {
  const busyCancel = acting === `${request.id}:cancel`;
  const busyPause = acting === `${request.id}:pause`;
  const busyResume = acting === `${request.id}:resume`;
  const statusText = kind === "active"
    ? `running ${sidecarQueueAge(request.activeSec)}`
    : kind === "paused"
      ? `paused ${sidecarQueueAge(request.pausedAgeSec)}`
      : `queued ${sidecarQueueAge(request.ageSec)}`;
  const headline = request.summary || request.label;
  const detail = request.detail || [request.destination, statusText].filter(Boolean).join(" · ");
  return (
    <div className="rounded-md border bg-background px-2 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-foreground">{headline}</div>
          {request.listingTitle && (
            <div className="mt-0.5 truncate text-[10px] font-medium text-foreground" title={request.listingTitle}>
              Listing: {request.listingTitle}
            </div>
          )}
          <div className="mt-0.5 text-[10px] font-medium leading-snug text-muted-foreground">
            {detail}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="outline" className="h-5 px-1.5 text-[9px]">{request.label}</Badge>
            {request.dateLabel && <Badge variant="secondary" className="h-5 px-1.5 text-[9px]">{request.dateLabel}</Badge>}
            <Badge variant="secondary" className="h-5 px-1.5 text-[9px]">{statusText}</Badge>
          </div>
          {(request.stage || request.pausedReason) && (
            <div className="mt-0.5 max-h-8 overflow-hidden text-[10px] italic text-muted-foreground">
              {request.stage || request.pausedReason}
            </div>
          )}
        </div>
        <Badge variant={kind === "active" ? "default" : kind === "paused" ? "outline" : "secondary"} className="shrink-0 text-[9px] capitalize">
          {kind}
        </Badge>
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        {kind === "paused" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            disabled={acting !== null}
            onClick={() => onAction(request, "resume")}
          >
            <Play className="mr-1 h-3 w-3" />
            {busyResume ? "Resuming" : "Resume"}
          </Button>
        ) : kind === "pending" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            disabled={acting !== null}
            onClick={() => onAction(request, "pause")}
          >
            <Pause className="mr-1 h-3 w-3" />
            {busyPause ? "Pausing" : "Pause"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 border-red-200 px-2 text-[10px] text-red-800 hover:bg-red-50"
          disabled={acting !== null}
          onClick={() => onAction(request, "cancel")}
        >
          <XCircle className="mr-1 h-3 w-3" />
          {busyCancel ? "Canceling" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

function SidecarScreensStrip() {
  const { data } = useQuery<SidecarScreensResponse>({
    queryKey: ["/api/vrbo-sidecar/screens", "operations-header"],
    queryFn: async () => {
      const r = await fetch("/api/vrbo-sidecar/screens", { cache: "no-store" });
      if (!r.ok) throw new Error(`Sidecar screens unavailable (${r.status})`);
      return r.json();
    },
    refetchInterval: 1_000,
    retry: false,
  });
  const [focusStatus, setFocusStatus] = useState<string | null>(null);
  const screens = data?.screens ?? [];
  const activeScreens = screens.filter((screen) => screen.active !== false && (screen.requestId || screen.phase));
  const captchaScreens = screens.filter((screen) => screen.captcha && screen.active !== false);
  const runtime = data?.heartbeat?.workerRuntime;
  const runtimeName = sidecarRuntimeName(runtime);
  const serverRuntime = isServerSidecarRuntime(runtime);

  const focusSidecarWindow = (screen: SidecarScreenSnapshot) => {
    setFocusStatus(`Focusing Chrome slot ${screen.slot}...`);
    void fetch("/api/vrbo-sidecar/screen-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot: screen.slot,
        requestId: screen.requestId,
        action: "surface",
        x: 0,
        y: 0,
      }),
    })
      .then((response) => {
        setFocusStatus(response.ok
          ? `Chrome slot ${screen.slot} focused and snapped back to the grid.`
          : `Chrome slot ${screen.slot} is no longer active.`);
      })
      .catch(() => {
        setFocusStatus(`Could not focus Chrome slot ${screen.slot}; try clicking the Chrome window directly.`);
      });
  };

  const restoreSidecarWindow = (screen: SidecarScreenSnapshot) => {
    setFocusStatus(`Shrinking Chrome slot ${screen.slot} back to the grid...`);
    void fetch("/api/vrbo-sidecar/screen-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot: screen.slot,
        requestId: screen.requestId,
        action: "restore",
        x: 0,
        y: 0,
      }),
    })
      .then((response) => {
        setFocusStatus(response.ok
          ? `Chrome slot ${screen.slot} snapped back to its grid size.`
          : `Chrome slot ${screen.slot} is no longer active.`);
      })
      .catch(() => {
        setFocusStatus(`Could not shrink Chrome slot ${screen.slot}; use the Chrome green button or try Focus again.`);
      });
  };

  return (
    <div className="w-full rounded-lg border bg-background/70 p-2 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <MonitorPlay className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-xs font-semibold">{runtimeName}</p>
            <p className="text-[11px] text-muted-foreground">
              {data?.heartbeat?.isOnline ? "Sidecar live" : "Sidecar offline"} · Google Chrome windows stay open in your external-monitor grid
              {data?.heartbeat?.activeJob ? ` · ${data.heartbeat.activeJob.label} ${data.heartbeat.activeJob.activeSec}s` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {serverRuntime ? "Server Chrome" : "Local Mac Chrome"}
          </Badge>
          {activeScreens.length > 0 && <Badge variant="secondary" className="text-[10px]">{activeScreens.length} active</Badge>}
        </div>
      </div>
      {captchaScreens.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-yellow-500 bg-yellow-100 px-3 py-2 text-xs text-yellow-950 shadow-sm animate-sidecar-captcha-flash">
          <span className="inline-flex items-center gap-2 font-semibold">
            <AlertCircle className="h-4 w-4" />
            CAPTCHA takeover needed on Chrome slot{captchaScreens.length === 1 ? "" : "s"} {captchaScreens.map((screen) => screen.slot).join(", ")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {captchaScreens.map((screen) => (
              <div key={screen.slot} className="inline-flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 border-yellow-600 bg-white px-2 text-[11px] text-yellow-950 hover:bg-yellow-50"
                  onClick={() => focusSidecarWindow(screen)}
                >
                  <MousePointerClick className="mr-1 h-3.5 w-3.5" />
                  Focus slot {screen.slot}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 border-yellow-600 bg-white px-2 text-[11px] text-yellow-950 hover:bg-yellow-50"
                  onClick={() => restoreSidecarWindow(screen)}
                  title="Shrink this Chrome window back to its grid size"
                >
                  <Minimize2 className="mr-1 h-3.5 w-3.5" />
                  Shrink
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {activeScreens.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {activeScreens.map((screen) => (
            <button
              key={`${screen.slot}-${screen.requestId ?? "active"}`}
              type="button"
              onClick={() => focusSidecarWindow(screen)}
              className={`rounded border px-2 py-1 text-[10px] transition hover:border-blue-400 ${
                screen.captcha ? "border-yellow-500 bg-yellow-50 text-yellow-950" : "bg-muted/40 text-muted-foreground"
              }`}
              title="Focus this Chrome sidecar window"
            >
              Slot {screen.slot}: {screen.captcha ? "CAPTCHA" : screen.phase ?? "working"} · {sidecarScreenAge(screen.ageMs)}
            </button>
          ))}
        </div>
      )}
      {focusStatus && <p className="mt-2 text-[11px] text-muted-foreground">{focusStatus}</p>}
    </div>
  );
}

function SidecarStatusBadge() {
  const { toast } = useToast();
  const [state, setState] = useState<{ data: SidecarHeartbeat | null; everSeen: boolean }>({
    data: null,
    everSeen: false,
  });
  const [acting, setActing] = useState<"stop" | "start" | "clear" | string | null>(null);
  const [showQueueStatus, setShowQueueStatus] = useState(false);
  const sidecarQueue = useSidecarQueueStatus(showQueueStatus || Boolean(state.data?.activeJob));

  const refresh = async (): Promise<SidecarHeartbeat | null> => {
    try {
      const r = await fetch("/api/vrbo-sidecar/heartbeat", { cache: "no-store" });
      if (!r.ok) return null;
      const data = (await r.json()) as SidecarHeartbeat;
      setState({ data, everSeen: data.everSeen ?? !!data.lastWorkerPollAt });
      return data;
    } catch {
      setState((p) => ({ ...p, data: p.data ? { ...p.data, isOnline: false } : null }));
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
    };
    tick();
    // 5s cadence so the active-job counter ticks visibly when a job
    // is running. Heartbeat endpoint is cheap (in-memory state read).
    const id = setInterval(tick, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const stopSidecar = async () => {
    setActing("stop");
    try {
      const r = await apiRequest("POST", "/api/vrbo-sidecar/stop", {
        reason: "Stop button (Operations UI)",
      });
      const j = await r.json();
      toast({
        title: "Sidecar queue stopped",
        description: j.cancelled > 0
          ? `Cancelled ${j.cancelled} job${j.cancelled === 1 ? "" : "s"}. Queue is paused; click Start Queue to resume dispatch.`
          : "Queue is paused; click Start Queue to resume dispatch.",
      });
      await refresh();
    } catch (e: any) {
      toast({ title: "Stop failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const startSidecar = async () => {
    setActing("start");
    try {
      await apiRequest("POST", "/api/vrbo-sidecar/start", {});
      toast({
        title: "Sidecar queue started",
        description: serverRuntime
          ? "Queue is unpaused. The Railway sidecar worker will pick up jobs when it is online."
          : "Queue is unpaused. If the badge stays offline, restart the sidecar worker.",
      });
      await refresh();
    } catch (e: any) {
      toast({ title: "Start failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const clearSidecarQueue = async () => {
    const confirmed = window.confirm(
      "Clear the sidecar queue? This cancels running/queued work, clears completed/failed queue history, and pauses new sidecar dispatch until you click Start Queue.",
    );
    if (!confirmed) return;
    setActing("clear");
    try {
      const r = await apiRequest("POST", "/api/vrbo-sidecar/clear", {
        reason: "Clear Queue button (Operations UI)",
      });
      const j = await r.json();
      toast({
        title: "Sidecar queue cleared",
        description: `Cleared ${j.cleared ?? 0} job${j.cleared === 1 ? "" : "s"}. Queue is paused; click Start Queue to resume dispatch.`,
      });
      await refresh();
    } catch (e: any) {
      toast({ title: "Clear queue failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const actOnRequest = async (request: SidecarQueueRequest, action: "cancel" | "pause" | "resume") => {
    setActing(`${request.id}:${action}`);
    try {
      await apiRequest("POST", `/api/vrbo-sidecar/request/${encodeURIComponent(request.id)}/${action}`, {
        reason: `${action} ${request.label} from Operations queue status`,
      });
      toast({
        title: action === "cancel" ? "Scan cancelled" : action === "pause" ? "Scan paused" : "Scan resumed",
        description: `${request.label} was ${action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "put back in the queue"}.`,
      });
      await refresh();
    } catch (e: any) {
      toast({
        title: `Could not ${action} scan`,
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setActing(null);
    }
  };

  const data = state.data;
  if (!data) {
    // First heartbeat poll hasn't returned yet — render nothing.
    return null;
  }
  const runtime = data.workerRuntime;
  const runtimeName = sidecarRuntimeName(runtime);
  const serverRuntime = isServerSidecarRuntime(runtime);

  // Three visual states (priority order: paused > offline > online):
  //   - Paused (by operator): yellow-orange "Paused" badge
  //   - Offline (worker down): amber "Sidecar offline"
  //   - Online idle: green "Sidecar live"
  //   - Online with active job: green "Sidecar working {Ns}"
  let statusIcon: React.ReactNode;
  let statusLabel: string;
  let statusDetail: string;
  let triggerClass: string;
  if (data.paused) {
    statusIcon = <Pause className="h-4 w-4" />;
    statusLabel = "Sidecar paused";
    statusDetail = "Queue stopped";
    triggerClass = "border-[hsl(var(--brand-orange)/0.40)] bg-[hsl(var(--brand-orange)/0.08)] text-orange-900 hover:bg-[hsl(var(--brand-orange)/0.12)]";
  } else if (!data.isOnline) {
    statusIcon = <AlertCircle className="h-4 w-4" />;
    statusLabel = "Sidecar offline";
    statusDetail = state.everSeen ? (serverRuntime ? "Check Railway" : "Reconnect worker") : "Not connected";
    triggerClass = "border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100";
  } else if (data.activeJob) {
    statusIcon = <Loader2 className="h-4 w-4 animate-spin" />;
    statusLabel = "Sidecar working";
    statusDetail = `${data.activeJob.activeSec}s`;
    triggerClass = "border-emerald-300 bg-emerald-50 text-emerald-950 hover:bg-emerald-100";
  } else {
    statusIcon = <CheckCircle2 className="h-4 w-4" />;
    statusLabel = "Sidecar live";
    statusDetail = "Ready";
    triggerClass = "border-emerald-300 bg-emerald-50 text-emerald-950 hover:bg-emerald-100";
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex h-11 min-w-[176px] items-center gap-2.5 rounded-lg border px-3 text-left shadow-sm transition-colors ${triggerClass}`}
          aria-label="Sidecar controls"
          data-testid="button-sidecar-status"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/75">
            {statusIcon}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-tight">{statusLabel}</span>
            <span className="block text-[11px] font-medium leading-tight opacity-75">{statusDetail}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] text-xs space-y-3" align="end">
        <div>
          <div className="font-semibold text-sm mb-1">{runtimeName}</div>
          <div className="text-muted-foreground leading-snug">
            {data.paused
              ? data.isOnline
                ? "Queue paused by operator. The worker is still polling, but it will not pick up jobs until you start the queue."
                : serverRuntime
                  ? "Queue paused by operator. Start Queue will resume dispatch after the Railway worker is online."
                  : "Queue paused by operator. Start Queue will resume dispatch, but the sidecar worker also needs to be running."
              : !data.isOnline
                ? state.everSeen
                  ? serverRuntime
                    ? `Last poll ${data.ageMs != null ? Math.round(data.ageMs / 60_000) + "m" : "?"} ago. Check the Railway rct-sidecar-worker service.`
                    : `Last poll ${data.ageMs != null ? Math.round(data.ageMs / 60_000) + "m" : "?"} ago. The sidecar worker is not polling.`
                  : serverRuntime
                    ? "Railway worker has not connected yet."
                    : "Sidecar worker has not connected yet."
                : data.activeJob
                  ? `Polled ${data.ageMs != null ? Math.round(data.ageMs / 1000) + "s" : "?"} ago. Currently driving ${serverRuntime ? "server Chrome" : "Chrome"}.`
                  : `Polled ${data.ageMs != null ? Math.round(data.ageMs / 1000) + "s" : "?"} ago. Idle, ready for work.`}
          </div>
        </div>

        {!data.isOnline && !serverRuntime && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-2 text-[10px] leading-snug text-amber-900">
            The web app can stop/start the queue, but a stopped local sidecar has to be restarted on this computer:
            <code className="mt-1 block rounded bg-white/70 px-1.5 py-1 font-mono text-[9px] text-amber-950">
              launchctl kickstart -k gui/$(id -u)/com.vrbosidecar.worker
            </code>
          </div>
        )}
        {!data.isOnline && serverRuntime && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-2 text-[10px] leading-snug text-amber-900">
            This queue is server-controlled. If it stays offline, check the Railway <code>rct-sidecar-worker</code> service rather than this Mac.
          </div>
        )}

        {data.activeJob && (
          <div className="border-l-2 border-emerald-400 pl-2 space-y-0.5">
            <div className="font-medium text-foreground flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin text-emerald-600" />
              {data.activeJob.label}
            </div>
            {data.activeJob.stage && (
              <div className="text-muted-foreground italic">{data.activeJob.stage}</div>
            )}
            <div className="font-mono text-[10px] text-muted-foreground">
              running {data.activeJob.activeSec}s
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 h-8 text-xs"
            disabled={acting !== null || data.paused}
            onClick={stopSidecar}
            data-testid="button-sidecar-stop"
          >
            <Square className="h-3 w-3 mr-1" />
            {acting === "stop" ? "Stopping…" : "Stop"}
          </Button>
          <Button
            size="sm"
            variant="default"
            className="flex-1 h-8 text-xs"
            disabled={acting !== null || !data.paused}
            onClick={startSidecar}
            data-testid="button-sidecar-start"
          >
            <Play className="h-3 w-3 mr-1" />
            {acting === "start" ? "Starting…" : "Start Queue"}
          </Button>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-full border-red-300 bg-red-50 text-xs text-red-900 hover:bg-red-100"
          disabled={acting !== null}
          onClick={clearSidecarQueue}
          data-testid="button-sidecar-clear-queue"
        >
          <XCircle className="h-3 w-3 mr-1" />
          {acting === "clear" ? "Clearing…" : "Clear Queue"}
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-8 w-full text-xs"
          onClick={() => setShowQueueStatus((value) => !value)}
          data-testid="button-sidecar-see-queue-status"
        >
          <Clock3 className="h-3 w-3 mr-1" />
          {showQueueStatus ? "Hide Queue Status" : "See Queue Status"}
        </Button>

        {showQueueStatus && (
          <div className="rounded-lg border bg-muted/25 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-semibold text-foreground">Scheduled scans</div>
              <Badge variant="outline" className="text-[10px]">
                {(sidecarQueue.status?.inProgress ?? 0)} running · {(sidecarQueue.status?.pending ?? 0)} queued · {(sidecarQueue.status?.paused ?? 0)} paused
              </Badge>
            </div>
            {!sidecarQueue.fetched ? (
              <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-3 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading queue…
              </div>
            ) : !sidecarQueue.status || (
              (sidecarQueue.status.activeRequests?.length ?? 0) === 0 &&
              (sidecarQueue.status.pendingRequests?.length ?? 0) === 0 &&
              (sidecarQueue.status.pausedRequests?.length ?? 0) === 0
            ) ? (
              <div className="rounded-md border bg-background px-2 py-3 text-[11px] text-muted-foreground">
                No active, queued, or paused sidecar scans right now.
              </div>
            ) : (
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {(sidecarQueue.status.activeRequests ?? []).map((request) => (
                  <SidecarQueueRequestRow key={request.id} request={request} kind="active" acting={acting} onAction={actOnRequest} />
                ))}
                {(sidecarQueue.status.pendingRequests ?? []).map((request) => (
                  <SidecarQueueRequestRow key={request.id} request={request} kind="pending" acting={acting} onAction={actOnRequest} />
                ))}
                {(sidecarQueue.status.pausedRequests ?? []).map((request) => (
                  <SidecarQueueRequestRow key={request.id} request={request} kind="paused" acting={acting} onAction={actOnRequest} />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="text-[10px] text-muted-foreground leading-snug space-y-1">
          <div>
            <strong>Stop</strong>: cancel running job + block new queue work.
            The sidecar worker idles if it is running.
          </div>
          <div>
            <strong>Start Queue</strong>: unblock new queue work. If the sidecar is offline, restart the {serverRuntime ? "Railway worker" : "sidecar worker"}.
          </div>
          <div>
            <strong>Clear Queue</strong>: cancel running/queued work, clear sidecar history/screens, and pause dispatch.
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LiveSearchSection({
  reservation,
  propertyId,
  slot,
  listingId,
  enableGroundFloorRequirement = true,
}: {
  reservation: GuestyReservation;
  propertyId: number;
  slot: SlotInfo;
  listingId?: string | null;
  enableGroundFloorRequirement?: boolean;
}) {
  const { toast } = useToast();
  const [recordTarget, setRecordTarget] = useState<LiveCandidate | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const confirmationKeyRef = useRef<string>("");
  const [searchStartedAtMs, setSearchStartedAtMs] = useState(() => Date.now());
  const [searchEnabled, setSearchEnabled] = useState(() => !slot.buyIn);
  const [rerunUntriedOnly, setRerunUntriedOnly] = useState(false);

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
  const variationCommunity = (slot.community || "").trim();
  const variationQueryKey = [
    "/api/vrbo-sidecar/search-variations",
    variationCommunity,
    checkInYmd,
    checkOutYmd,
    slot.bedrooms,
  ] as const;
  const { data: variationStatus, isLoading: variationStatusLoading } = useQuery<SidecarSearchVariationStatus>({
    queryKey: variationQueryKey,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        community: variationCommunity,
        checkIn: checkInYmd,
        checkOut: checkOutYmd,
        bedrooms: String(slot.bedrooms),
      });
      return apiGetJson<SidecarSearchVariationStatus>(`/api/vrbo-sidecar/search-variations?${params.toString()}`, signal);
    },
    enabled: !!variationCommunity && !!checkInYmd && !!checkOutYmd,
    staleTime: 5_000,
  });
  const { data: groundRequirement, isLoading: groundRequirementLoading } = useQuery<GroundFloorRequirement & { conversationId?: string | null }>({
    queryKey: ["/api/bookings", reservation._id, "ground-floor-requirement", propertyId, reservation.slots.length],
    queryFn: () => apiGetJson<GroundFloorRequirement & { conversationId?: string | null }>(
      groundFloorRequirementHref(reservation, propertyId),
    ),
    enabled: enableGroundFloorRequirement && !!reservation._id,
    staleTime: 60_000,
  });
  const confirmedGroundFloorSlots = reservation.slots.filter((s) => s.buyIn?.groundFloorStatus === "confirmed").length;
  const targetGroundFloorBedrooms = new Set(groundFloorTargetBedrooms(groundRequirement).map((n) => Number(n)));
  const groundFloorNeededForThisSlot = !!groundRequirement?.requested
    && (targetGroundFloorBedrooms.size > 0
      ? targetGroundFloorBedrooms.has(slot.bedrooms) && slot.buyIn?.groundFloorStatus !== "confirmed"
      : confirmedGroundFloorSlots < Math.min(reservation.slots.length, Math.max(1, groundRequirement.requiredUnits)));
  useEffect(() => {
    if (!slot.buyIn) return;
    setSearchEnabled(false);
    void queryClient.cancelQueries({ queryKey: ["/api/operations/find-buy-in", propertyId, slot.bedrooms, checkInYmd, checkOutYmd] });
  }, [slot.buyIn?.id, propertyId, slot.bedrooms, checkInYmd, checkOutYmd]);

  // Auto-fires when the component mounts (i.e. when user clicks "Find buy-in").
  // No gating button — the whole point of the workflow is to see cheap live
  // options immediately without maintaining a manual portfolio of buy-ins.
  const { data, isLoading, isFetching, isError, error, dataUpdatedAt, isPlaceholderData, refetch } = useQuery<FindBuyInResponse>({
    queryKey: ["/api/operations/find-buy-in", propertyId, listingId, slot.community, slot.bedrooms, checkInYmd, checkOutYmd, groundFloorNeededForThisSlot, rerunUntriedOnly, refreshNonce],
    queryFn: () => {
      const noCache = refreshNonce > 0 ? "&nocache=1" : "";
      const groundFloorParam = groundFloorNeededForThisSlot ? "&groundFloor=required" : "";
      const rerunParam = rerunUntriedOnly ? "&rerunUntried=1" : "";
      const context = new URLSearchParams();
      if (listingId) context.set("listingId", listingId);
      if (slot.community) context.set("community", slot.community);
      const contextSuffix = context.toString() ? `&${context.toString()}` : "";
      return fetchFindBuyInWithRetry(
        `/api/operations/find-buy-in?propertyId=${propertyId}&bedrooms=${slot.bedrooms}&checkIn=${checkInYmd}&checkOut=${checkOutYmd}${groundFloorParam}${rerunParam}${noCache}${contextSuffix}`,
      );
    },
    enabled: searchEnabled && !!checkInYmd && !!checkOutYmd && !groundRequirementLoading,
    staleTime: 0,
    refetchOnMount: "always",
    placeholderData: (previousData) => previousData,
  });
  const sidecarQueue = useSidecarQueueStatus(isLoading || isFetching || !!data);
  const liveSearchSidecarActive = isSidecarStatusForSearch(sidecarQueue.status, searchStartedAtMs);
  useEffect(() => {
    if (!searchEnabled) return;
    const resumeIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (isLoading || isFetching) void refetch();
    };
    window.addEventListener("focus", resumeIfVisible);
    document.addEventListener("visibilitychange", resumeIfVisible);
    return () => {
      window.removeEventListener("focus", resumeIfVisible);
      document.removeEventListener("visibilitychange", resumeIfVisible);
    };
  }, [searchEnabled, isLoading, isFetching, refetch]);
  const refreshLiveSearch = () => {
    setRerunUntriedOnly(false);
    setSearchStartedAtMs(Date.now());
    setRefreshNonce((n) => n + 1);
  };
  const rerunUntriedVariations = () => {
    setRerunUntriedOnly(true);
    setSearchStartedAtMs(Date.now());
    setRefreshNonce((n) => n + 1);
    setSearchEnabled(true);
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
  const confirmationAudit = useMemo<AutoFillSearchAudit | null>(() => {
    if (!searchDiagnostics) return null;
    if (!data) {
      if (!hardErrorDiagnostics) return null;
      return {
        bedrooms: slot.bedrooms,
        generatedAt: searchDiagnostics.generatedAt ?? new Date().toISOString(),
        counts: {},
        candidates: [],
        diagnostics: searchDiagnostics,
      };
    }
    const groupedCandidates = (data.cheapestUnits ?? []).flatMap((unit) =>
      (unit.listings ?? []).map((listing): AutoFillAuditCandidate => ({
        source: listing.channel,
        sourceLabel: listing.channelLabel,
        title: unit.unitTitle,
        url: listing.url,
        originalSourceUrl: listing.originalSourceUrl,
        totalPrice: listing.totalPrice,
        nightlyPrice: listing.nightlyPrice,
        image: unit.image,
        verified: listing.verified,
        verifiedReason: listing.verifiedReason,
        groundFloorStatus: listing.groundFloorStatus ?? unit.groundFloorStatus,
        groundFloorEvidence: listing.groundFloorEvidence ?? unit.groundFloorEvidence,
      })),
    );
    const flatCandidates = (groupedCandidates.length > 0
      ? groupedCandidates
      : (data.cheapest?.length ? data.cheapest : [
          ...(data.sources?.airbnb ?? []),
          ...(data.sources?.vrbo ?? []),
          ...(data.sources?.pm ?? []),
        ]).map((candidate): AutoFillAuditCandidate => ({
          source: candidate.source,
          sourceLabel: candidate.sourceLabel,
          title: candidate.title,
          url: candidate.url,
          originalSourceUrl: candidate.originalSourceUrl,
          totalPrice: candidate.totalPrice,
          nightlyPrice: candidate.nightlyPrice,
          image: candidate.image,
          verified: candidate.verified,
          verifiedReason: candidate.verifiedReason,
          groundFloorStatus: candidate.groundFloorStatus,
          groundFloorEvidence: candidate.groundFloorEvidence,
        })))
      .filter((candidate) => candidate.url);
    return {
      bedrooms: slot.bedrooms,
      generatedAt: searchDiagnostics.generatedAt ?? new Date().toISOString(),
      counts: liveSearchSummaryFor(data, slot.bedrooms),
      candidates: flatCandidates,
      diagnostics: searchDiagnostics,
    };
  }, [data, searchDiagnostics, hardErrorDiagnostics, slot.bedrooms]);
  const confirmationPayload = useMemo<BuyInSearchConfirmationPayload | null>(() => {
    if (!confirmationAudit) return null;
    const request = confirmationAudit.diagnostics?.request;
    return {
      title: `Buy-in search confirmation: ${slot.unitLabel}`,
      description: `Completed search for ${request?.resortName || request?.community || data?.resortName || data?.community || "selected location"} · ${slot.bedrooms}BR · ${checkInYmd} -> ${checkOutYmd}.`,
      audits: [confirmationAudit],
    };
  }, [confirmationAudit, slot.unitLabel, slot.bedrooms, checkInYmd, checkOutYmd, data?.resortName, data?.community]);
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
    if (confirmationPayload) return;
    if (autoOpenedSearchDiagnosticKeys.has(diagnosticKey)) return;
    autoOpenedSearchDiagnosticKeys.add(diagnosticKey);
    setDiagnosticsOpen(true);
  }, [searchDiagnostics, diagnosticKey, confirmationPayload]);
  useEffect(() => {
    if (!confirmationPayload || !searchDiagnostics || !data || isFetching || isPlaceholderData) return;
    const key = [
      propertyId,
      slot.unitId,
      slot.bedrooms,
      checkInYmd,
      checkOutYmd,
      searchDiagnostics.generatedAt,
      dataUpdatedAt,
    ].join("|");
    if (confirmationKeyRef.current === key) return;
    confirmationKeyRef.current = key;
    setConfirmationOpen(true);
  }, [
    confirmationPayload,
    searchDiagnostics,
    data,
    isFetching,
    isPlaceholderData,
    propertyId,
    slot.unitId,
    slot.bedrooms,
    checkInYmd,
    checkOutYmd,
    dataUpdatedAt,
  ]);
  useEffect(() => {
    if (!searchDiagnostics?.generatedAt || !variationCommunity) return;
    void queryClient.invalidateQueries({ queryKey: variationQueryKey });
  }, [searchDiagnostics?.generatedAt, variationCommunity]);

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
              Searches Airbnb and Vrbo map view for {slot.bedrooms}BR+ rentals at the resort
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
          Searching Airbnb (for photo matches), Vrbo map view, and property management companies for the cheapest {slot.bedrooms}BR+ rental covering {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}…
        </div>
        {variationCommunity && (
          <SidecarSearchVariationPanel
            community={variationCommunity}
            status={variationStatus}
            loading={variationStatusLoading}
            onSaved={() => queryClient.invalidateQueries({ queryKey: variationQueryKey })}
            onRerunUntried={rerunUntriedVariations}
            rerunUntriedOnly={rerunUntriedOnly}
            disabled={isFetching}
          />
        )}
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
  const vrbo    = data?.sources?.vrboAll ?? data?.sources?.vrbo ?? [];
  const booking: LiveCandidate[] = [];
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
  const focusedUnitCheapestPrice = availableCheapestUnits[0]
    ? availableCheapestUnits[0].listings
      .map((listing) => listing.totalPrice)
      .filter((price) => Number.isFinite(price) && price > 0)
      .sort((a, b) => a - b)[0] ?? null
    : null;
  const singleSearchAttachableCount = confirmationAudit
    ? countAttachableBuyInCandidates([confirmationAudit])
    : 0;
  const singleSearchCancellationAdvice = buildBuyInCancellationAdvice({
    reservation,
    audits: confirmationAudit ? [confirmationAudit] : [],
    proposedCost: singleSearchAttachableCount > 0
      ? focusedUnitCheapestPrice ?? availableCheapest[0]?.totalPrice ?? null
      : null,
    currentSlotId: slot.unitId,
    attachableVerifiedCount: singleSearchAttachableCount,
  });
  const singleSearchNoBookableReplacement = !!confirmationAudit && (
    singleSearchAttachableCount === 0
    || reservation.slots.filter((slot) => !slot.buyIn).length > 1
  );

  // Map a unit's primary listing back to a LiveCandidate so the existing
  // record-buy-in dialog can keep its current contract. PRs #275+ will
  // pass channel-specific listings instead, but until then the dialog
  // reads from a single LiveCandidate.
  const unitToCandidate = (u: LiveUnit, listing: LiveUnitListing): LiveCandidate => {
    const listingFloorConfirmed = listing.groundFloorStatus === "confirmed";
    return {
      source: listing.channel,
      sourceLabel: listing.channelLabel,
      title: u.unitTitle,
      url: listing.url,
      originalSourceUrl: listing.originalSourceUrl,
      nightlyPrice: listing.nightlyPrice,
      totalPrice: listing.totalPrice,
      bedrooms: listing.bedrooms ?? u.bedrooms,
      image: u.image,
      verified: listing.verified,
      verifiedReason: listing.verifiedReason,
      airbnbAnchorUrl: listing.airbnbAnchorUrl,
      airbnbAnchorPrice: listing.airbnbAnchorPrice,
      directBookingUrl: listing.directBookingUrl,
      directBookingHost: listing.directBookingHost,
      directBookingSource: listing.directBookingSource,
      directBookingReason: listing.directBookingReason,
      directProof: listing.directProof,
      groundFloorStatus: listingFloorConfirmed ? listing.groundFloorStatus : (u.groundFloorStatus ?? listing.groundFloorStatus),
      groundFloorEvidence: listingFloorConfirmed ? listing.groundFloorEvidence : (u.groundFloorEvidence ?? listing.groundFloorEvidence),
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
      {variationCommunity && (
        <SidecarSearchVariationPanel
          community={variationCommunity}
          status={variationStatus}
          loading={variationStatusLoading}
          onSaved={() => queryClient.invalidateQueries({ queryKey: variationQueryKey })}
          onRerunUntried={rerunUntriedVariations}
          rerunUntriedOnly={rerunUntriedOnly}
          disabled={isFetching}
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
          Direct-link count now reflects only Airbnb Google Lens matches;
          PM website discovery/scraping is intentionally not part of buy-in. */}
      {data?.debug?.rawCounts && (
        <div className="text-[11px] text-muted-foreground -mt-1 space-y-0.5">
          <div>
            Raw: airbnb site {data.debug.rawCounts.airbnb ?? 0} · airbnb priced {data.debug.rawCounts.airbnbEngine ?? 0} · vrbo {typeof (data.debug.rawCounts as { vrboExported?: number }).vrboExported === "number" ? (data.debug.rawCounts as { vrboExported: number }).vrboExported : (data.debug.rawCounts.vrbo ?? 0)} · direct links {pmSourceBreakdown.reduce((a, s) => a + (s.count ?? 0), 0)}
            {pmSourceBreakdown.length > 0 && (
              <> ({pmSourceBreakdown.filter((s) => s.count > 0).length}/{pmSourceBreakdown.length} direct-link sources had results)</>
            )}
            {typeof (data.debug.rawCounts as any).photoMatches === "number" && (
              <> · photo-matches {(data.debug.rawCounts as any).photoMatches}</>
            )}
          </div>
          {data.debug.dropped && (
            <div>
              Dropped (wrong resort / bedrooms):
              {" "}airbnb {data.debug.dropped.airbnb?.noResort ?? 0}/{data.debug.dropped.airbnb?.wrongBedrooms ?? 0} ·
              {" "}vrbo bedroom {data.debug.dropped.vrbo?.wrongBedrooms ?? 0} / title {data.debug.dropped.vrbo?.titleMismatch ?? 0}
              {typeof (data.debug.rawCounts as { vrboExported?: number }).vrboExported === "number" && (
                <> · vrbo exported {(data.debug.rawCounts as { vrboExported?: number }).vrboExported} → kept {(data.debug.rawCounts as { vrboFiltered?: number }).vrboFiltered ?? data.sources?.vrbo?.length ?? 0}</>
              )}
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
                : "No priced VRBO/direct candidates surfaced for these dates and bedrooms. Browse all scanned options below or click 'Refresh'."}
          </p>
        </div>
      )}

      {/* Sortable table of every scanned option across all sources. Auto-fill
          picks `cheapest[0]` (the highlighted row) — this table is the
          audit trail so the operator can see what else was scanned and
          override with one click. */}
      <details>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground flex items-center gap-2 py-1.5">
          <Badge className="text-[10px] bg-slate-100 text-slate-700 border border-slate-300">
            All scanned options
          </Badge>
          <span>
            {availableAirbnb.length + availableVrbo.length + availablePm.length} rows
            {hasCurrentFocusedRecommendation ? " hidden below the best pick" : ""}
          </span>
        </summary>
        <div className="mt-1.5">
          <ScannedOptionsTable
            airbnb={availableAirbnb}
            vrbo={availableVrbo}
            booking={[]}
            pm={availablePm}
            autoPickUrl={availableCheapestUnits[0]?.primaryUrl ?? availableCheapest[0]?.url}
            checkIn={checkInYmd}
            checkOut={checkOutYmd}
            onRecord={(c) => setRecordTarget(c)}
          />
        </div>
      </details>

      {/* By-source sections.
          Airbnb stays as a priced source plus photo bridge. Vrbo is
          sidecar-priced from map view. Direct rows are photo-discovered
          PM pages and only become priced when the direct verifier proves
          availability/rate on the PM site itself. */}
      {[
        { key: "airbnb",  label: "Airbnb (sidecar-priced + direct-link Lens)", items: availableAirbnb,  defaultOpen: false },
        { key: "vrbo",    label: "Vrbo (map-priced)", items: availableVrbo, defaultOpen: false },
        { key: "pm",      label: "Direct links from Airbnb photos", items: availablePm, defaultOpen: false },
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
              {s.key === "pm" && " (No clean direct-booking links were found from the Airbnb photo reverse search.)"}
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
      <BuyInSearchConfirmationDialog
        payload={confirmationPayload}
        open={confirmationOpen}
        onOpenChange={setConfirmationOpen}
        onViewDiagnostics={() => {
          setConfirmationOpen(false);
          setDiagnosticsOpen(true);
        }}
      />

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
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      Open result
                    </a>
                    {c.originalSourceUrl && c.originalSourceUrl !== c.url && (
                      <a
                        href={c.originalSourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        Original source
                      </a>
                    )}
                    {c.directBookingSource === "airbnb_image_reverse_search" && (
                      <span className="text-emerald-700" title={c.directProof?.summary}>
                        {directProofShortLabel(c.directProof)}
                      </span>
                    )}
                  </div>
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
  void sourceUrl;
  void title;
  void resortName;
  void community;

  const runLookup = async () => {
    if (!imageUrl || isLoading) return;
    setState({
      status: "error",
      message: "Google Lens reverse-image lookup is disabled to preserve SearchAPI quota.",
    });
  };

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/70 p-2 dark:border-slate-800 dark:bg-slate-950/20">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={runLookup}
          disabled
          title="Google Lens reverse-image lookup is disabled to preserve SearchAPI quota"
          data-testid="button-reverse-image-listings"
        >
          {isLoading ? (
            <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Camera className="h-3 w-3 mr-1" />
          )}
          Lookup disabled
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
          {unit.groundFloorStatus && (
            <Badge variant="outline" className={`mt-1 text-[9px] ${groundFloorBadge(unit.groundFloorStatus).className}`} title={unit.groundFloorEvidence ?? undefined}>
              {groundFloorBadge(unit.groundFloorStatus).label}
            </Badge>
          )}
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
            {l.groundFloorStatus && (
              <Badge variant="outline" className={`text-[9px] shrink-0 ${groundFloorBadge(l.groundFloorStatus).className}`} title={l.groundFloorEvidence ?? undefined}>
                {groundFloorBadge(l.groundFloorStatus).label}
              </Badge>
            )}
            <div className="grow min-w-0">
              {l.nightlyPrice > 0 ? (
                <p className="text-[12px]">
                  <span className="font-semibold">{fmtMoney(l.nightlyPrice)}</span>
                  <span className="text-muted-foreground">/night ({fmtMoney(l.totalPrice)} total)</span>
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground italic">{liveRateFallbackText(l.verified)}</p>
              )}
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                {l.directBookingSource === "airbnb_image_reverse_search" && (
                  <span className="text-emerald-700" title={l.directProof?.summary}>
                    {directProofShortLabel(l.directProof)}
                  </span>
                )}
                {l.airbnbAnchorUrl && (
                  <a
                    href={l.airbnbAnchorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Airbnb source
                  </a>
                )}
                {l.originalSourceUrl && l.originalSourceUrl !== l.url && (
                  <a
                    href={l.originalSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Original URL
                  </a>
                )}
              </div>
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
            {c.groundFloorStatus && (
              <Badge variant="outline" className={`text-[9px] ${groundFloorBadge(c.groundFloorStatus).className}`} title={c.groundFloorEvidence ?? undefined}>
                {groundFloorBadge(c.groundFloorStatus).label}
              </Badge>
            )}
            <p className="font-medium text-sm truncate">{c.title}</p>
          </div>
          {c.snippet && <p className="text-[11px] text-muted-foreground line-clamp-2">{c.snippet}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            {c.originalSourceUrl && c.originalSourceUrl !== c.url && (
              <button
                type="button"
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => window.open(c.originalSourceUrl, "_blank", "noopener,noreferrer")}
              >
                Original source URL
              </button>
            )}
            {c.airbnbAnchorUrl && (
              <button
                type="button"
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => window.open(c.airbnbAnchorUrl, "_blank", "noopener,noreferrer")}
              >
                Airbnb source
              </button>
            )}
          </div>
          {c.directBookingUrl && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
              <Badge variant="outline" className="h-5 border-emerald-300 bg-emerald-50 text-[10px] text-emerald-800">
                {c.directBookingSource === "airbnb_image_reverse_search"
                  ? directProofShortLabel(c.directProof)
                  : "Direct link found"}
              </Badge>
              <button
                type="button"
                className="max-w-[360px] truncate text-emerald-700 underline-offset-2 hover:underline"
                title={c.directProof?.summary ?? c.directBookingReason ?? c.directBookingUrl}
                onClick={() => window.open(c.directBookingUrl, "_blank", "noopener,noreferrer")}
              >
                {c.directBookingHost || sourceLabelForUrl(c.directBookingUrl)}
              </button>
              <span className="text-muted-foreground">
                {c.directProof?.price.status === "date_specific_quote"
                  ? "direct PM quote shown"
                  : c.directProof?.price.status === "airbnb_anchor_only"
                    ? "Airbnb anchor only"
                    : "direct rate not proven"}
              </span>
            </div>
          )}
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

function VrboGuestPageDialog({
  reservation,
  propertyName,
  onClose,
}: {
  reservation: GuestyReservation;
  propertyName: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [vrboUrls, setVrboUrls] = useState("");
  const [pageTitle, setPageTitle] = useState(propertyName);
  const [walkMinutes, setWalkMinutes] = useState("");
  const [notes, setNotes] = useState("");
  const [createdPage, setCreatedPage] = useState<{
    url: string;
    expiresAt?: string;
    guestMessage: string;
    alternatives?: Array<{ title: string; photoCount: number; photoSource: string; descriptionGeneratedBy: string }>;
  } | null>(null);
  const [guestMessage, setGuestMessage] = useState("");
  const parsedUrls = useMemo(() => parseUrlList(vrboUrls).filter((url) => /(?:^|\.)vrbo\.com$/i.test(new URL(url).hostname)), [vrboUrls]);
  const parsedWalkMinutes = Number(walkMinutes);
  const canCreate = parsedUrls.length > 0 && Number.isFinite(parsedWalkMinutes) && parsedWalkMinutes > 0;

  const createPage = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/booking-alternatives/from-vrbo", {
        reservationId: reservation._id,
        guestName: reservation.guest?.fullName ?? reservation.guest?.firstName ?? "Guest",
        checkIn: checkInOf(reservation),
        checkOut: checkOutOf(reservation),
        propertyName: pageTitle.trim() || propertyName,
        urls: parsedUrls,
        walkMinutes: parsedWalkMinutes,
        notes,
      }).then((r) => r.json());
      if (!response?.url) throw new Error(response?.message || response?.error || "Guest page create failed");
      return response as {
        url: string;
        expiresAt?: string;
        guestMessage: string;
        alternatives?: Array<{ title: string; photoCount: number; photoSource: string; descriptionGeneratedBy: string }>;
      };
    },
    onSuccess: async (data) => {
      const totalPhotos = (data.alternatives ?? []).reduce((sum, item) => sum + (item.photoCount ?? 0), 0);
      setCreatedPage(data);
      setGuestMessage(data.guestMessage || "");
      try {
        await navigator.clipboard?.writeText(data.url);
        toast({ title: "Guest page ready", description: `Link copied. ${totalPhotos} photo${totalPhotos === 1 ? "" : "s"} pulled through.` });
      } catch {
        toast({ title: "Guest page ready", description: `${totalPhotos} photo${totalPhotos === 1 ? "" : "s"} pulled through. Copy the URL from the new tab.` });
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
    },
    onError: (e: any) => toast({ title: "Guest page failed", description: e?.message ?? String(e), variant: "destructive" }),
  });

  const copyGuestMessage = async () => {
    if (!guestMessage.trim()) return;
    try {
      await navigator.clipboard?.writeText(guestMessage);
      toast({ title: "Message copied" });
    } catch {
      toast({ title: "Copy failed", description: "Select and copy the message manually.", variant: "destructive" });
    }
  };

  const sendGuestMessage = useMutation({
    mutationFn: async () => {
      if (!createdPage?.url) throw new Error("Create the guest page first");
      const response = await apiRequest("POST", "/api/booking-alternatives/send-guest-message", {
        reservationId: reservation._id,
        body: guestMessage,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.message || body?.error || `Guesty returned HTTP ${response.status}`);
      }
      return body as { ok: true; conversationId: string };
    },
    onSuccess: () => {
      toast({ title: "Guest message sent", description: "Sent through the Guesty conversation." });
      onClose();
    },
    onError: (e: any) => toast({ title: "Message send failed", description: e?.message ?? String(e), variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create guest page from VRBO URLs</DialogTitle>
          <DialogDescription>
            Paste the proposed property URLs. The guest page will present them as your alternative properties and will not mention VRBO or buy-ins.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded border bg-muted/30 p-3 text-xs">
            <p className="font-medium">{reservation.guest?.fullName ?? reservation.guest?.firstName ?? "Guest"}</p>
            <p className="text-muted-foreground">{fmtDate(checkInOf(reservation))} → {fmtDate(checkOutOf(reservation))}</p>
          </div>
          <div>
            <Label htmlFor="vrboGuestPageTitle" className="text-xs">Guest-facing property name</Label>
            <Input
              id="vrboGuestPageTitle"
              value={pageTitle}
              onChange={(e) => setPageTitle(e.target.value)}
              placeholder="Poipu Kai resort option"
              data-testid="input-vrbo-guest-page-title"
            />
          </div>
          <div>
            <Label htmlFor="vrboGuestPageUrls" className="text-xs">VRBO URLs</Label>
            <Textarea
              id="vrboGuestPageUrls"
              rows={5}
              value={vrboUrls}
              onChange={(e) => setVrboUrls(e.target.value)}
              placeholder="Paste one or two VRBO listing URLs, one per line"
              data-testid="input-vrbo-guest-page-urls"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {parsedUrls.length} valid VRBO URL{parsedUrls.length === 1 ? "" : "s"} detected.
            </p>
          </div>
          <div>
            <Label htmlFor="vrboGuestPageWalkMinutes" className="text-xs">Minutes walking between properties</Label>
            <Input
              id="vrboGuestPageWalkMinutes"
              type="number"
              min="1"
              step="1"
              value={walkMinutes}
              onChange={(e) => setWalkMinutes(e.target.value)}
              placeholder="5"
              data-testid="input-vrbo-guest-page-walk-minutes"
            />
          </div>
          <div>
            <Label htmlFor="vrboGuestPageNotes" className="text-xs">Optional description guidance</Label>
            <Textarea
              id="vrboGuestPageNotes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Mention anything the guest should know, like close to beach, good for families, ground-floor preference, etc."
              data-testid="input-vrbo-guest-page-notes"
            />
          </div>
          {createdPage && (
            <div className="space-y-2 rounded border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium">Guest page and message ready</p>
                  <a className="block truncate text-xs text-primary underline" href={createdPage.url} target="_blank" rel="noreferrer">
                    {createdPage.url}
                  </a>
                </div>
                <Button size="sm" variant="outline" onClick={() => window.open(createdPage.url, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  Open
                </Button>
              </div>
              <div>
                <Label htmlFor="vrboGuestMessage" className="text-xs">Guest inbox message</Label>
                <Textarea
                  id="vrboGuestMessage"
                  rows={11}
                  value={guestMessage}
                  onChange={(e) => setGuestMessage(e.target.value)}
                  data-testid="input-vrbo-guest-message"
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={copyGuestMessage} disabled={!guestMessage.trim()}>
                  <Copy className="mr-1 h-3.5 w-3.5" />
                  Copy message
                </Button>
                <Button type="button" onClick={() => sendGuestMessage.mutate()} disabled={!guestMessage.trim() || sendGuestMessage.isPending}>
                  {sendGuestMessage.isPending ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Mail className="mr-1 h-3.5 w-3.5" />
                      Send through inbox
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => createPage.mutate()}
            disabled={!canCreate || createPage.isPending}
            data-testid="button-create-vrbo-guest-page"
          >
            {createPage.isPending ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Pulling photos...
              </>
            ) : (
              <>
                <ExternalLink className="mr-1 h-3.5 w-3.5" />
                Create custom URL
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Dialog: draft + send the apology/relocation message to the guest through the
// channel they booked with (VRBO -> VRBO, Booking.com -> Booking.com, etc.).
// On open it builds the guest "alternatives" page from the attached buy-in units
// (photos + AI copy), drafts a channel-clean apology message containing that
// page's URL, sends it through the Guesty conversation (which routes to the
// booking channel), and then tracks whether the guest opened the link.
function RelocateGuestDialog({
  reservation,
  onClose,
}: {
  reservation: GuestyReservation;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const channel = channelKindOf(reservation);
  const channelLabel =
    channel === "booking" ? "Booking.com"
      : channel === "vrbo" ? "VRBO"
      : channel === "airbnb" ? "Airbnb"
      : "the booking channel";
  const guestName = reservation.guest?.fullName ?? reservation.guest?.firstName ?? "Guest";
  const attachedSlots = reservation.slots.filter((s): s is SlotInfo & { buyIn: BuyIn } => !!s.buyIn);
  const [createdPage, setCreatedPage] = useState<{ url: string; token: string } | null>(null);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const startedRef = useRef(false);

  const createPage = useMutation({
    mutationFn: async () => {
      if (attachedSlots.length === 0) throw new Error("Attach at least one buy-in unit before messaging the guest.");
      // Best-effort: pull the walk minutes + the units' real resort name so the
      // message can name the community and the walking distance.
      let walkMinutes: number | null = null;
      let propertyLabel: string | null = null;
      let originalCommunity: string | null = null;
      let alternativeCommunity: string | null = null;
      try {
        const prox = await apiGetJson<UnitProximityResponse>(
          `/api/bookings/${encodeURIComponent(reservation._id)}/unit-proximity`,
        );
        if (prox?.status === "ready") {
          walkMinutes = prox.walk?.minutes ?? null;
          // prox.community = the reservation's ORIGINAL community; prox.resortName
          // = the resort the attached (alternative) units actually belong to.
          // Send both so the server can compute the same-city drive distance.
          originalCommunity = prox.community ?? null;
          alternativeCommunity = prox.resortName ?? null;
          propertyLabel = prox.resortName ?? prox.community ?? null;
        }
      } catch { /* non-fatal — message still drafts without the walk/drive line */ }
      const alternatives = attachedSlots.map((s) => {
        const b = s.buyIn;
        const photoUrls = manualBuyInPhotoUrlsFromNotes(b.notes);
        const listingTitle = titleFromBuyInNotes(b.notes);
        return {
          title: listingTitle || `${b.propertyName} - ${b.unitLabel}`,
          community: b.propertyName,
          url: b.airbnbListingUrl,
          image: photoUrls[0] ?? "",
          photos: photoUrls,
          bedrooms: s.bedrooms,
          unitLabel: b.unitLabel,
          address: b.unitAddress,
          sourceLabel: sourceLabelForUrl(b.airbnbListingUrl),
          notes: b.notes,
        };
      });
      const resp = await apiRequest("POST", "/api/booking-alternatives", {
        reservationId: reservation._id,
        guestName,
        checkIn: checkInOf(reservation),
        checkOut: checkOutOf(reservation),
        channel,
        walkMinutes,
        unitWalkMinutes: walkMinutes,
        propertyLabel,
        originalCommunity,
        areaName: originalCommunity,
        alternativeCommunity,
        alternatives,
      }).then((r) => r.json());
      if (!resp?.url || !resp?.token) throw new Error(resp?.message || resp?.error || "Guest page create failed");
      return resp as { url: string; token: string; relocationMessage?: string };
    },
    onSuccess: (data) => {
      setCreatedPage({ url: data.url, token: data.token });
      setMessage(data.relocationMessage || "");
    },
    onError: (e: any) => toast({ title: "Could not prepare message", description: e?.message ?? String(e), variant: "destructive" }),
  });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    createPage.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMessage = useMutation({
    mutationFn: async () => {
      if (!createdPage?.token) throw new Error("Prepare the guest page first.");
      if (!message.trim()) throw new Error("The message is empty.");
      const response = await apiRequest("POST", "/api/booking-alternatives/send-guest-message", {
        reservationId: reservation._id,
        body: message,
        token: createdPage.token,
        channel,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.message || body?.error || `Guesty returned HTTP ${response.status}`);
      }
      return body as { ok: true; conversationId: string };
    },
    onSuccess: () => {
      setSent(true);
      // Refresh the bookings-row "Guest messaged ✓" badge immediately so the
      // operator sees the recorded confirmation without reopening anything.
      queryClient.invalidateQueries({ queryKey: ["/api/booking-alternatives/sent-status"] });
      toast({ title: `Message sent through ${channelLabel}`, description: "Recorded — tracking whether the guest opens the link." });
    },
    onError: (e: any) => toast({ title: "Message send failed", description: e?.message ?? String(e), variant: "destructive" }),
  });

  const tracking = useQuery<{
    opened: boolean;
    openCount: number;
    firstOpenedAt: string | null;
    lastOpenedAt: string | null;
    messageSentAt: string | null;
  }>({
    queryKey: ["/api/booking-alternatives", createdPage?.token, "tracking"],
    queryFn: ({ signal }) => apiGetJson(`/api/booking-alternatives/${createdPage!.token}/tracking`, signal),
    enabled: !!createdPage?.token && sent,
    refetchInterval: sent ? 12_000 : false,
  });

  const copyMessage = async () => {
    if (!message.trim()) return;
    try { await navigator.clipboard?.writeText(message); toast({ title: "Message copied" }); }
    catch { toast({ title: "Copy failed", variant: "destructive" }); }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Message guest about the move</DialogTitle>
          <DialogDescription>
            Drafts an apology that we've moved {guestName.split(/\s+/)[0] || "the guest"} to a comparable
            property, includes the new listing's guest page link, and sends it through {channelLabel} (the
            channel they booked with). You can edit the text before sending.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded border bg-muted/30 p-3 text-xs">
            <p className="font-medium">{guestName} · <span className="text-muted-foreground">{channelLabel}</span></p>
            <p className="text-muted-foreground">{fmtDate(checkInOf(reservation))} → {fmtDate(checkOutOf(reservation))} · {attachedSlots.length} unit{attachedSlots.length === 1 ? "" : "s"} attached</p>
          </div>

          {channel === "booking" && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
              Booking.com only delivers the link if the property allows guest-message links in the extranet
              security settings. The message below is plain-text formatted so Booking.com renders it cleanly.
            </div>
          )}

          {createPage.isPending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Building guest page + drafting message…
            </div>
          ) : createdPage ? (
            <>
              <div className="text-[11px] text-muted-foreground">
                Guest page:{" "}
                <a className="underline" href={`${createdPage.url}?preview=1`} target="_blank" rel="noreferrer">
                  {createdPage.url}
                </a>{" "}
                <span className="opacity-70">(your preview open isn't counted in tracking)</span>
              </div>
              <div>
                <Label htmlFor="relocateMessage" className="text-xs">Message to guest</Label>
                <Textarea
                  id="relocateMessage"
                  rows={12}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="text-sm font-mono"
                  data-testid="input-relocate-message"
                />
              </div>
              {sent && (
                <div className="rounded border border-sky-200 bg-sky-50/70 px-3 py-2 text-xs text-sky-950">
                  <p className="font-medium">Sent through {channelLabel}.</p>
                  <p className="mt-0.5">
                    {tracking.data?.opened
                      ? `Guest opened the link${tracking.data.openCount ? ` ${tracking.data.openCount} time${tracking.data.openCount === 1 ? "" : "s"}` : ""}${tracking.data.lastOpenedAt ? ` · last ${fmtDate(tracking.data.lastOpenedAt)}` : ""}. ✓`
                      : "Not opened yet — this updates automatically when the guest opens the link."}
                    {" "}
                    <button type="button" className="underline" onClick={() => tracking.refetch()}>refresh</button>
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-destructive py-4">
              Couldn't prepare the message. <button type="button" className="underline" onClick={() => createPage.mutate()}>Try again</button>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button type="button" variant="outline" onClick={copyMessage} disabled={!message.trim()}>
            <Copy className="mr-1 h-3.5 w-3.5" /> Copy
          </Button>
          <Button
            type="button"
            onClick={() => sendMessage.mutate()}
            disabled={!createdPage || !message.trim() || sendMessage.isPending || sent}
            data-testid="button-send-relocate-message"
          >
            {sendMessage.isPending ? (
              <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Sending…</>
            ) : sent ? (
              <><CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Sent</>
            ) : (
              <><Send className="mr-1 h-3.5 w-3.5" /> Send through {channelLabel}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Dialog: records an operator-sourced buy-in without running live OTA search.
// Photo URLs are persisted in notes so operators get durable visual context
// without requiring a schema migration for this narrow workflow.
function ManualBuyInDialog({
  reservation,
  propertyId,
  propertyName,
  slot,
  onClose,
}: {
  reservation: GuestyReservation;
  propertyId: number;
  propertyName: string;
  slot: SlotInfo;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const toDateOnly = (s: string | undefined): string => {
    if (!s) return "";
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.slice(0, 10);
  };
  const [costPaid, setCostPaid] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [listingUrl, setListingUrl] = useState("");
  const [photoUrlText, setPhotoUrlText] = useState("");
  const [unitAddress, setUnitAddress] = useState("");
  const [managementCompany, setManagementCompany] = useState("");
  const [managementContact, setManagementContact] = useState("");
  const [notes, setNotes] = useState("");
  const checkIn = toDateOnly(reservation.checkInDateLocalized ?? reservation.checkIn);
  const checkOut = toDateOnly(reservation.checkOutDateLocalized ?? reservation.checkOut);
  const photoUrls = useMemo(() => parseUrlList(photoUrlText).slice(0, 12), [photoUrlText]);
  const duplicateSlot = useMemo(() => {
    const candidateKeys = new Set(listingIdentityKeys({
      url: listingUrl,
      title: notes,
      alternateUrls: photoUrls,
    }));
    if (candidateKeys.size === 0) return null;
    return reservation.slots.find(
      (s) => s.unitId !== slot.unitId
        && s.buyIn
        && listingIdentityKeys({
          url: s.buyIn.airbnbListingUrl,
          title: titleFromBuyInNotes(s.buyIn.notes),
          alternateUrls: manualBuyInPhotoUrlsFromNotes(s.buyIn.notes),
        }).some((key) => candidateKeys.has(key)),
    ) ?? null;
  }, [listingUrl, notes, photoUrls, reservation.slots, slot.unitId]);
  const parsedCost = Number(costPaid);
  const canSave = Number.isFinite(parsedCost) && parsedCost > 0 && !!listingUrl.trim() && !duplicateSlot;

  const createAndAttach = useMutation({
    mutationFn: async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
        throw new Error("Manual buy-in needs valid check-in/check-out dates.");
      }
      if (!canSave) {
        throw new Error("Enter a positive total cost and a listing URL before saving.");
      }
      const noteParts = [
        `Manually recorded buy-in for ${slot.unitLabel}.`,
        notes.trim(),
        photoUrls.length > 0 ? `${MANUAL_BUY_IN_PHOTO_MARKER} ${photoUrls.join(" ")}` : "",
      ].filter(Boolean);
      const created = await apiRequest("POST", "/api/buy-ins", {
        propertyId,
        propertyName,
        unitId: slot.unitId,
        unitLabel: slot.unitLabel,
        checkIn,
        checkOut,
        costPaid: parsedCost.toFixed(2),
        airbnbConfirmation: confirmation.trim() || null,
        airbnbListingUrl: listingUrl.trim(),
        unitAddress: unitAddress.trim() || null,
        managementCompany: managementCompany.trim() || null,
        managementContact: managementContact.trim() || null,
        groundFloorStatus: "unknown",
        groundFloorEvidence: null,
        notes: noteParts.join(" "),
        status: "active",
      }).then((r) => r.json());
      if (!created?.id) throw new Error(created?.error || "Buy-in create failed");
      const attach = await apiRequest("POST", `/api/bookings/${reservation._id}/attach-buy-in`, {
        buyInId: created.id,
      }).then((r) => r.json());
      if (!attach?.id) throw new Error(attach?.error || "Attach failed");
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing"] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      toast({ title: "Manual buy-in recorded and attached" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manually add buy-in for {slot.unitLabel}</DialogTitle>
          <DialogDescription>
            {reservation.guest?.fullName ?? "Guest"} · {fmtDate(checkIn)} → {fmtDate(checkOut)} · {propertyName}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="manualCostPaid" className="text-xs">Total cost paid (USD)</Label>
                <Input
                  id="manualCostPaid"
                  type="number"
                  min="0"
                  step="0.01"
                  value={costPaid}
                  onChange={(e) => setCostPaid(e.target.value)}
                  data-testid="input-manual-buyin-cost"
                />
              </div>
              <div>
                <Label htmlFor="manualConfirmation" className="text-xs">Confirmation code</Label>
                <Input
                  id="manualConfirmation"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder="Confirmation or booking ID"
                  data-testid="input-manual-buyin-confirmation"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="manualListingUrl" className="text-xs">Listing URL</Label>
              <Input
                id="manualListingUrl"
                value={listingUrl}
                onChange={(e) => setListingUrl(e.target.value)}
                placeholder="https://..."
                data-testid="input-manual-buyin-listing-url"
              />
              {duplicateSlot && (
                <p className="mt-1 text-[11px] text-destructive">
                  This listing or photo evidence already matches {duplicateSlot.unitLabel}. Use a different physical unit for {slot.unitLabel}.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="manualPhotoUrls" className="text-xs">Image URLs</Label>
              <Textarea
                id="manualPhotoUrls"
                rows={4}
                value={photoUrlText}
                onChange={(e) => setPhotoUrlText(e.target.value)}
                placeholder="Paste one or more image URLs, separated by lines, commas, or spaces"
                data-testid="input-manual-buyin-photo-urls"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="manualUnitAddress" className="text-xs">Unit address</Label>
                <Input
                  id="manualUnitAddress"
                  value={unitAddress}
                  onChange={(e) => setUnitAddress(e.target.value)}
                  data-testid="input-manual-buyin-address"
                />
              </div>
              <div>
                <Label htmlFor="manualManagementCompany" className="text-xs">Management company</Label>
                <Input
                  id="manualManagementCompany"
                  value={managementCompany}
                  onChange={(e) => setManagementCompany(e.target.value)}
                  data-testid="input-manual-buyin-management-company"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="manualManagementContact" className="text-xs">Manager contact</Label>
              <Input
                id="manualManagementContact"
                value={managementContact}
                onChange={(e) => setManagementContact(e.target.value)}
                placeholder="Email, phone, or portal contact"
                data-testid="input-manual-buyin-management-contact"
              />
            </div>
            <div>
              <Label htmlFor="manualNotes" className="text-xs">Notes</Label>
              <Textarea
                id="manualNotes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Rate details, cancellation terms, payment status, or anything to verify later"
                data-testid="input-manual-buyin-notes"
              />
            </div>
          </div>
          <div className="space-y-3">
            <div className="rounded border bg-muted/30 p-3 text-xs">
              <p className="font-medium">{slot.unitLabel} · {slot.bedrooms}BR minimum</p>
              <p className="text-muted-foreground">{fmtDate(checkIn)} → {fmtDate(checkOut)}</p>
              <p className="mt-1 text-muted-foreground">{photoUrls.length} image URL{photoUrls.length === 1 ? "" : "s"} ready</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {photoUrls.length > 0 ? photoUrls.map((url, idx) => (
                <a
                  key={`${url}-${idx}`}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group overflow-hidden rounded border bg-background"
                  title={url}
                >
                  <div className="aspect-[4/3] bg-muted">
                    <img src={url} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.02]" loading="lazy" />
                  </div>
                  <div className="truncate px-2 py-1 text-[10px] text-muted-foreground">
                    {sourceLabelForUrl(url)}
                  </div>
                </a>
              )) : (
                <div className="col-span-2 rounded border border-dashed bg-background p-6 text-center text-xs text-muted-foreground">
                  Image previews appear here as soon as URLs are pasted.
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => createAndAttach.mutate()}
            disabled={!canSave || createAndAttach.isPending}
            data-testid="button-save-manual-buy-in"
          >
            {createAndAttach.isPending ? "Saving…" : "Save & attach"}
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
      const defaultNotes = candidate.airbnbAnchorUrl
        ? [
          `Bought via ${candidate.sourceLabel} — ${candidate.title}`,
          `Found via Airbnb Google Lens search.`,
          candidate.directProof?.summary ?? `Direct booking link found from Airbnb photos; direct PM proof was not attached to this row.`,
          candidate.directProof?.price.status === "date_specific_quote"
            ? `Direct PM proof: ${candidate.directProof.price.reason}`
            : `Direct PM proof pending: ${candidate.directProof?.price.reason ?? "no direct PM date-specific quote recorded"}`,
          `Airbnb anchor: ${candidate.airbnbAnchorUrl}`,
        ].join(" · ")
        : `Bought via ${candidate.sourceLabel} — ${candidate.title}`;
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
        groundFloorStatus: candidate.groundFloorStatus ?? "unknown",
        groundFloorEvidence: candidate.groundFloorEvidence ?? null,
        notes: notes || defaultNotes,
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
