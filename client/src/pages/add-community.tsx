import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import AppBackButton from "@/components/AppBackButton";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft,
  ArrowRight,
  MapPin,
  Search,
  Loader2,
  CheckCircle2,
  X,
  XCircle,
  Building2,
  BedDouble,
  DollarSign,
  Camera,
  FileText,
  Plus,
  Star,
  ExternalLink,
  ShieldCheck,
  ShieldX,
  TrendingUp,
  CalendarDays,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { estimateNewCommunityScore, gradeColor, gradeBg } from "@/data/quality-score";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { checkCommunityType } from "@shared/community-type";
import {
  formatTypicalComboLabel,
  inferTypicalComboPair,
  isComboPairingAvailable,
  pickBestAvailableComboPairing,
} from "@shared/community-combo";
import { BUY_IN_RATES, suggestPricingArea } from "@shared/pricing-rates";
import { inferCommunityStreetAddress, validateCommunityStreetAddress } from "@shared/community-addresses";
import {
  bulkComboProgressPercent,
  bulkComboRemainingMs,
  formatBulkComboEta,
} from "@shared/bulk-combo-queue-progress";
import { OperationFailureActions } from "@/components/OperationFailureActions";
import { resolveLicenseComplianceProfile } from "@shared/license-compliance";
import {
  resortDedupKey as resortDedupKeyOf,
  computeSweepResortOwnership,
} from "@shared/sweep-resort-dedup";

const US_STATES = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut",
  "Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa",
  "Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan",
  "Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire",
  "New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio",
  "Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota",
  "Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia",
  "Wisconsin","Wyoming",
];

const STEPS = ["Location", "Research", "Select Units", "Photos", "Listing Draft"];
const ADD_COMBO_DRAFT_KEY = "nexstay_add_combo_listing_draft_v1";
const PHOTO_FETCH_REQUEST_TIMEOUT_MS = 180_000;
const PHOTO_FETCH_STALE_MS = 6 * 60_000;

type CommunityResult = {
  name: string;
  city: string;
  state: string;
  estimatedLowRate: number | null;
  estimatedHighRate: number | null;
  unitTypes: string;
  confidenceScore: number;
  researchSummary: string;
  sourceUrl: string;
  bedroomMix?: string;
  combinedBedroomsTypical?: number;
  combinabilityScore?: number;
  fromWorldKnowledge?: boolean;
  availableBedrooms?: number[];
  estimatedTotalUnits?: number;
  estimatedBedroomUnitCounts?: Record<string, number>;
  minimumStayNights?: number | null;
  minimumStayEvidence?: string | null;
  minimumStaySourceUrl?: string | null;
  addressHint?: string;
  /** True when operator already has a draft/listing for this exact resort name+city in community_drafts. */
  hasExistingListing?: boolean;
  existingComboLabels?: string[];
  reservedComboLabels?: string[];
};

type CommunityResearchHistory = {
  city: string;
  state: string;
  mode: string;
  resultCount: number;
  resultNames: string[];
  resultSummaries: Array<{
    name: string;
    confidenceScore: number | null;
    unitTypes: string | null;
    estimatedLowRate: number | null;
    estimatedHighRate: number | null;
  }>;
  error: string | null;
  lastSearchedAt: string;
  updatedAt: string;
};

type UnitResult = {
  url: string;
  title: string;
  bedrooms: number | null;
  price: number | null;
  source: string;
};

const positiveInteger = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const comboKeyForPairing = (pairing: Pick<SuggestedPairing, "unit1Beds" | "unit2Beds">): string => {
  const b1 = pairing.unit1Beds;
  const b2 = pairing.unit2Beds;
  return b1 <= b2 ? `${b1}+${b2}` : `${b2}+${b1}`;
};

const isPairingAvailable = (pairing: SuggestedPairing): boolean => isComboPairingAvailable(pairing);

// True when the operator already has this resort in the system (a saved/queued
// listing or any built/queued combo). The bulk "Select all" sweep must NEVER
// re-add a resort that's already covered — see queueSelectedSweepResorts. The
// server enforces the same thing city-agnostically as the 100%-sure backstop.
const resortAlreadyInSystem = (c: CommunityResult): boolean =>
  c.hasExistingListing === true
  || (c.existingComboLabels?.length ?? 0) > 0
  || (c.reservedComboLabels?.length ?? 0) > 0;

type SuggestedPairing = {
  unit1Beds: number;
  unit2Beds: number;
  totalBeds: number;
  estimatedUnit1Rate: number;
  estimatedUnit2Rate: number;
  estimatedSellRate: number;
  estimatedSellRateHigh: number;
  rationale: string;
  isTopPick: boolean;
  matchScore: number;
  availability?: "available" | "existing" | "reserved";
  alreadyExists?: boolean;
  reserved?: boolean;
  duplicateReason?: string | null;
};

type ComboInventoryItem = {
  key: string;
  label: string;
  unit1Beds: number;
  unit2Beds: number;
  totalBeds: number;
  source: "draft" | "reserved";
  status: string;
  draftId?: number;
  jobId?: string;
  itemId?: string;
  title?: string | null;
};

type CommunityProfile = {
  availableTypes: number[];
  airbnbListingCount: number;
  ratesByBR: Record<string, { median: number | null; count: number }>;
  comboInventory?: ComboInventoryItem[];
  existingComboLabels?: string[];
  reservedComboLabels?: string[];
  allCombosUsed?: boolean;
};

type PhotoItem = { url: string; label: string };

type PhotoCheckResult = { clean: boolean; matches: Array<{ platform: string; url: string }> };

function formatResearchHistoryTime(value: string | null | undefined): string {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatResortUnitMix(community: CommunityResult): string | null {
  const bedroomCounts = Object.entries(community.estimatedBedroomUnitCounts ?? {})
    .map(([bedrooms, count]) => ({
      bedrooms: Math.round(Number(String(bedrooms).replace(/[^\d.]/g, ""))),
      count: Math.round(Number(count)),
    }))
    .filter(({ bedrooms, count }) => Number.isFinite(bedrooms) && bedrooms > 0 && Number.isFinite(count) && count > 0)
    .sort((a, b) => a.bedrooms - b.bedrooms);

  const totalFromBreakout = bedroomCounts.reduce((sum, item) => sum + item.count, 0);
  const total = typeof community.estimatedTotalUnits === "number" && community.estimatedTotalUnits > 0
    ? Math.round(community.estimatedTotalUnits)
    : totalFromBreakout > 0
      ? totalFromBreakout
      : null;

  if (bedroomCounts.length > 0 && total) {
    const parts = bedroomCounts.map(({ bedrooms, count }) => `~${count.toLocaleString()} ${bedrooms}BR`);
    return `${parts.join(" + ")} = ~${total.toLocaleString()} total condos`;
  }

  if (total) {
    return `~${total.toLocaleString()} total condos`;
  }

  const bedroomMix = (community.availableBedrooms ?? [])
    .filter((bedrooms) => Number.isFinite(bedrooms) && bedrooms > 0)
    .sort((a, b) => a - b)
    .map((bedrooms) => `${bedrooms}BR`)
    .join(" / ");

  return bedroomMix ? `Bedroom mix: ${bedroomMix}` : null;
}

function hasFourBedroomComboPotential(community: CommunityResult): boolean {
  return hasBedroomPairPotential(community, [[2, 2]]);
}

function hasFiveBedroomComboPotential(community: CommunityResult): boolean {
  return hasBedroomPairPotential(community, [[2, 3]]);
}

function hasSixBedroomComboPotential(community: CommunityResult): boolean {
  return hasBedroomPairPotential(community, [[3, 3]]);
}

function getBedroomCounts(community: CommunityResult): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [rawBedrooms, rawCount] of Object.entries(community.estimatedBedroomUnitCounts ?? {})) {
    const bedrooms = Math.round(Number(String(rawBedrooms).replace(/[^\d.]/g, "")));
    const count = Math.round(Number(rawCount));
    if (Number.isFinite(bedrooms) && bedrooms > 0 && Number.isFinite(count) && count > 0) {
      counts.set(bedrooms, Math.max(counts.get(bedrooms) ?? 0, count));
    }
  }
  return counts;
}

function getAvailableBedrooms(community: CommunityResult): Set<number> {
  const bedrooms = new Set<number>();
  for (const value of community.availableBedrooms ?? []) {
    const normalized = Math.round(Number(value));
    if (Number.isFinite(normalized) && normalized > 0) bedrooms.add(normalized);
  }
  getBedroomCounts(community).forEach((_count, bedroom) => bedrooms.add(bedroom));
  return bedrooms;
}

function hasBedroomPairPotential(community: CommunityResult, pairs: Array<[number, number]>): boolean {
  const counts = getBedroomCounts(community);
  const availableBedrooms = getAvailableBedrooms(community);

  for (const [first, second] of pairs) {
    if (!availableBedrooms.has(first) || !availableBedrooms.has(second)) continue;
    if (first === second && counts.size > 0 && (counts.get(first) ?? 0) < 2) continue;
    return true;
  }

  return false;
}

function hasSevenEightBedroomComboPotential(community: CommunityResult): boolean {
  return hasBedroomPairPotential(community, [[3, 4], [4, 4]]);
}

type SeedComboBadge = {
  className: string;
  title: string;
  label: string;
  icon: "yes" | "no" | "pending";
};

type ComboBadgeKind = "four" | "five" | "six" | "sevenEight";

const COMBO_BADGE_META: Record<ComboBadgeKind, {
  prefix: string;
  yesClassName: string;
  yesTitle: string;
  noTitle: string;
  pendingTitle: string;
}> = {
  four: {
    prefix: "4BR combo",
    yesClassName: "bg-fuchsia-50 text-fuchsia-700",
    yesTitle: "Cached scan: two 2BR units can combine into a 4BR combo",
    noTitle: "Cached scan: no two-2BR 4BR combo potential",
    pendingTitle: "Run the market scan to verify 4BR combo potential",
  },
  five: {
    prefix: "5BR combo",
    yesClassName: "bg-indigo-50 text-indigo-700",
    yesTitle: "Cached scan: a 2BR + 3BR can combine into a 5BR combo",
    noTitle: "Cached scan: no 2BR+3BR 5BR combo potential",
    pendingTitle: "Run the market scan to verify 5BR combo potential",
  },
  six: {
    prefix: "6BR combo",
    yesClassName: "bg-emerald-50 text-emerald-700",
    yesTitle: "Cached scan: two 3BR units can combine into a 6BR combo",
    noTitle: "Cached scan: no two-3BR 6BR combo potential",
    pendingTitle: "Run the market scan to verify 6BR combo potential",
  },
  sevenEight: {
    prefix: "7/8BR combo",
    yesClassName: "bg-sky-50 text-sky-700",
    yesTitle: "Cached scan: 7BR/8BR combo potential confirmed",
    noTitle: "Cached scan: no 7BR/8BR combo potential",
    pendingTitle: "Run the market scan to verify 7BR/8BR combo potential",
  },
};

function seedComboBadge(possible: boolean | undefined, kind: ComboBadgeKind): SeedComboBadge {
  const meta = COMBO_BADGE_META[kind];
  if (possible === true) {
    return { className: meta.yesClassName, title: meta.yesTitle, label: `${meta.prefix}: yes`, icon: "yes" };
  }
  if (possible === false) {
    return { className: "bg-slate-100 text-slate-600", title: meta.noTitle, label: `${meta.prefix}: no`, icon: "no" };
  }
  return { className: "bg-amber-50 text-amber-700", title: meta.pendingTitle, label: `${meta.prefix}: scan needed`, icon: "pending" };
}

function formatMinimumStay(community: CommunityResult): { label: string; tone: "ok" | "warn" | "unknown"; evidence?: string } {
  const nights = community.minimumStayNights;
  const evidence = community.minimumStayEvidence?.trim() || undefined;
  if (typeof nights === "number" && nights > 0) {
    return {
      label: `Likely ${nights}-night minimum`,
      tone: "warn",
      evidence,
    };
  }
  if (nights === 0) {
    return {
      label: "No published minimum found",
      tone: "ok",
      evidence,
    };
  }
  return {
    label: "Minimum stay unknown",
    tone: "unknown",
    evidence: "Needs a bookable-channel sample or a published HOA/PM rule before relying on it.",
  };
}

export default function AddCommunity() {
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState(1);

  // Step 1 — manual "Add a community" mode. Instead of researching a city and
  // picking a discovered community, the operator names the community + state and
  // pastes the two concrete unit listing URLs; the server seeds a bulk combo
  // listing job with those URLs and the existing job modal shows progress.
  const [manualMode, setManualMode] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualState, setManualState] = useState("");
  const [manualUnit1Url, setManualUnit1Url] = useState("");
  const [manualUnit2Url, setManualUnit2Url] = useState("");
  const [manualUnit1Beds, setManualUnit1Beds] = useState("");
  const [manualUnit2Beds, setManualUnit2Beds] = useState("");
  const [manualBuilding, setManualBuilding] = useState(false);

  // Step 1
  const [selectedState, setSelectedState] = useState("");
  const [cityInput, setCityInput] = useState("");
  // City typeahead. The dropdown opens while the input is focused
  // and there are suggestions; clicking a suggestion fills the
  // input and closes the dropdown. The blur handler is delayed by
  // ~150ms so a click on a suggestion lands before the dropdown
  // tears down.
  const [citySuggestions, setCitySuggestions] = useState<string[]>([]);
  const [citySuggestionsLoading, setCitySuggestionsLoading] = useState(false);
  const [showCitySuggestions, setShowCitySuggestions] = useState(false);
  const cityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cityRequestSeqRef = useRef(0);

  // Debounced fetch — server endpoint hits Nominatim, scoped to the
  // currently-selected state. Sequence counter prevents a slow
  // earlier response from clobbering a fresher one.
  useEffect(() => {
    if (cityDebounceRef.current) clearTimeout(cityDebounceRef.current);
    if (!selectedState || cityInput.trim().length < 2) {
      setCitySuggestions([]);
      setCitySuggestionsLoading(false);
      return;
    }
    setCitySuggestionsLoading(true);
    const mySeq = ++cityRequestSeqRef.current;
    cityDebounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/community/city-suggest?state=${encodeURIComponent(selectedState)}&query=${encodeURIComponent(cityInput.trim())}`,
        );
        const data = await r.json();
        // Drop stale responses
        if (mySeq !== cityRequestSeqRef.current) return;
        setCitySuggestions(Array.isArray(data?.cities) ? data.cities : []);
      } catch {
        if (mySeq !== cityRequestSeqRef.current) return;
        setCitySuggestions([]);
      } finally {
        if (mySeq === cityRequestSeqRef.current) setCitySuggestionsLoading(false);
      }
    }, 250);
    return () => {
      if (cityDebounceRef.current) clearTimeout(cityDebounceRef.current);
    };
  }, [cityInput, selectedState]);

  // Nearby cities within ~20min drive of the typed city (for quick pivot in
  // Add Combo flow). Fetched from server which uses Photon reverse geocode +
  // drive-time math so any city input yields real nearby research targets.
  const [nearbyCitySuggestions, setNearbyCitySuggestions] = useState<Array<{ label: string; minutes: number }>>([]);
  const [nearbySuggestionsLoading, setNearbySuggestionsLoading] = useState(false);
  const nearbyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nearbySeqRef = useRef(0);

  useEffect(() => {
    if (nearbyDebounceRef.current) clearTimeout(nearbyDebounceRef.current);
    const q = cityInput.trim();
    if (!selectedState || q.length < 3) {
      setNearbyCitySuggestions([]);
      setNearbySuggestionsLoading(false);
      return;
    }
    setNearbySuggestionsLoading(true);
    const mySeq = ++nearbySeqRef.current;
    nearbyDebounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/community/nearby-cities?state=${encodeURIComponent(selectedState)}&query=${encodeURIComponent(q)}`,
        );
        const data = await r.json();
        if (mySeq !== nearbySeqRef.current) return;
        const list = Array.isArray(data?.cities)
          ? data.cities.map((c: any) => ({ label: c?.name ?? String(c), minutes: Number(c?.minutes ?? 0) }))
          : [];
        setNearbyCitySuggestions(list);
      } catch {
        if (mySeq !== nearbySeqRef.current) return;
        setNearbyCitySuggestions([]);
      } finally {
        if (mySeq === nearbySeqRef.current) setNearbySuggestionsLoading(false);
      }
    }, 350);
    return () => {
      if (nearbyDebounceRef.current) clearTimeout(nearbyDebounceRef.current);
    };
  }, [cityInput, selectedState]);

  // Step 2
  const [communities, setCommunities] = useState<CommunityResult[]>([]);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchProgress, setResearchProgress] = useState(0);
  const [researchHistory, setResearchHistory] = useState<CommunityResearchHistory | null>(null);
  const [researchHistoryLoading, setResearchHistoryLoading] = useState(false);
  const [selectedCommunity, setSelectedCommunity] = useState<CommunityResult | null>(null);

  // Ramp a fake progress % while research is in-flight so the search area shows live status.
  // Mirrors the richer feedback in add-single-listing. Timer is client-only; real work is server-side.
  useEffect(() => {
    if (!researchLoading) return;
    const startedAt = Date.now();
    setResearchProgress((prev) => Math.max(prev, 8));
    const id = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      // Ramp 8 → ~92 over ~25s (typical research wall time), then hold until response arrives.
      const target = Math.min(92, 8 + Math.floor((elapsed / 25000) * 84));
      setResearchProgress((prev) => Math.max(prev, Math.min(92, Math.round(target))));
    }, 450);
    return () => window.clearInterval(id);
  }, [researchLoading]);

  // Top-markets sweep — scans a curated list of US vacation-rental hotspots
  type MarketResult = {
    city: string;
    state: string;
    tag?: string;
    estimatedComboLow?: number;
    estimatedComboHigh?: number;
    fourBedroomPossible?: boolean;
    fiveBedroomPossible?: boolean;
    sixBedroomPossible?: boolean;
    sevenEightBedroomPossible?: boolean;
    status: "pending" | "running" | "done" | "error" | "cancelled";
    count?: number;
    communities?: CommunityResult[];
    error?: string;
  };
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepMarkets, setSweepMarkets] = useState<MarketResult[]>([]);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepDone, setSweepDone] = useState(false);
  const [sweepJobId, setSweepJobId] = useState<string | null>(null);
  const ignoredSweepJobIdsRef = useRef<Set<string>>(new Set());
  // Cross-market resort breakdown: after a sweep finishes, the operator can
  // tick resorts grouped under EACH scanned market and bulk-queue them all at
  // once (rather than loading one market into Step 2 at a time). Keyed by
  // `${marketIndex}:${communityIndex}` so each checkbox is independent even when
  // the same resort surfaces under two adjacent towns (e.g. Pili Mai shows under
  // both Koloa and Poipu); the queue builder de-dupes by resort name+state.
  const [sweepResortSelection, setSweepResortSelection] = useState<Set<string>>(new Set());
  const [sweepQueueStarting, setSweepQueueStarting] = useState(false);
  const [sweepQueueProgress, setSweepQueueProgress] = useState<{ done: number; total: number } | null>(null);
  // One-click multi-batch: when a sweep queue hit the per-job batch cap, the
  // overflow stays selected and this arms an AUTO re-queue of the next batch as
  // soon as the current job completes — the operator selects communities ONCE
  // and the queue drains them all. Disarmed on job failure/cancel (operator
  // attention needed) and when nothing is left selected.
  const sweepAutoContinueArmedRef = useRef(false);
  const sweepAutoContinuedForJobRef = useRef<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const draftHydratedRef = useRef(false);
  const [draftAutosaveReady, setDraftAutosaveReady] = useState(false);
  const photoFetchRunRef = useRef(0);
  const photoAutoResumeRef = useRef(false);
  const photoStaleRestartRef = useRef(false);
  const restoredPhotoFetchJobIdsRef = useRef<Set<string>>(new Set());
  const pairingAutoResumeRef = useRef(false);
  // Two-phase flow for the sweep modal. "setup" shows a checkbox grid the
  // user picks markets from; "running" shows streaming per-market progress.
  // Avoids the old behavior of firing a ~30-minute sweep across all 20
  // markets the moment the user clicks the button.
  type SweepPhase = "setup" | "running";
  const [sweepPhase, setSweepPhase] = useState<SweepPhase>("setup");
  type SeedMarket = {
    city: string;
    state: string;
    tag: string;
    estimatedComboLow?: number;
    estimatedComboHigh?: number;
    fourBedroomPossible?: boolean;
    fiveBedroomPossible?: boolean;
    sixBedroomPossible?: boolean;
    sevenEightBedroomPossible?: boolean;
    qualifyingCount?: number;
    scannedAt?: string;
    scanError?: string | null;
  };
  const [seedMarkets, setSeedMarkets] = useState<SeedMarket[] | null>(null);
  const [cacheRefreshJobId, setCacheRefreshJobId] = useState<string | null>(null);
  const [cacheRefreshRunning, setCacheRefreshRunning] = useState(false);
  const [topMarketCacheStats, setTopMarketCacheStats] = useState<{ total: number; cached: number; uncached: number } | null>(null);
  const [selectedMarkets, setSelectedMarkets] = useState<Set<string>>(new Set());
  const keyFor = (m: { city: string; state: string }) => `${m.city}|${m.state}`;
  const countCachedComboScans = (markets: SeedMarket[] | null, total: number) => {
    if (!markets) return { cached: 0, uncached: total };
    const cached = markets.filter((m) => typeof m.sixBedroomPossible === "boolean").length;
    return { cached, uncached: Math.max(0, total - cached) };
  };
  const formatComboRange = (low?: number | null, high?: number | null) => {
    if (!low && !high) return "Range TBD";
    if (low && high) return `$${low.toLocaleString()}-${high.toLocaleString()}/night`;
    return `$${(low ?? high)!.toLocaleString()}/night`;
  };
  type TopMarketJobPayload = {
    id: string;
    status: "queued" | "running" | "done" | "error" | "cancelled";
    markets: MarketResult[];
    totalCommunities?: number;
    topCommunity?: CommunityResult | null;
    error?: string;
  };
  type ComboPhotoFetchJobPayload = {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    total?: number;
    completed?: number;
    failed?: number;
    cancelled?: number;
    items: Array<{
      id: string;
      label: string;
      status: "queued" | "running" | "completed" | "failed" | "cancelled";
      phase: string;
      message: string;
      unit1Photos: PhotoItem[];
      unit2Photos: PhotoItem[];
      unit1SourceUrl: string | null;
      unit2SourceUrl: string | null;
      error: string | null;
      progressPercent?: number;
      heartbeatAt?: string | null;
      attemptCount?: number;
    }>;
  };
  const [photoFetchJobId, setPhotoFetchJobId] = useState<string | null>(null);
  const [photoFetchJob, setPhotoFetchJob] = useState<ComboPhotoFetchJobPayload | null>(null);
  type BulkComboListingJobPayload = {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    currentIndex?: number;
    completed: number;
    failed: number;
    cancelled: number;
    lockedBy?: string | null;
    lockExpiresAt?: string | null;
    createdAt?: string | number | null;
    updatedAt?: string | null;
    items: Array<{
      id: string;
      label: string;
      status: "queued" | "running" | "completed" | "failed" | "cancelled";
      phase: string;
      message: string;
      draftId: number | null;
      error: string | null;
      attemptCount?: number;
      heartbeatAt?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      progressPercent?: number;
      etaSeconds?: number | null;
      unit1Photos?: Array<{ url: string }>;
      unit2Photos?: Array<{ url: string }>;
      unit1SourceUrl?: string | null;
      unit2SourceUrl?: string | null;
      effectiveUnit1Beds?: number | null;
      effectiveUnit2Beds?: number | null;
      remixApplied?: boolean;
      unit2PhotosReused?: boolean;
      pairing?: { unit1Beds: number; unit2Beds: number; totalBeds: number };
    }>;
  };
  type QueueJobEventPayload = {
    id: number;
    jobType: string;
    jobId: string;
    itemKey: string | null;
    phase: string;
    level: "info" | "warn" | "error" | string;
    message: string;
    createdAt: string;
  };
  const [bulkPairingIndexes, setBulkPairingIndexes] = useState<Set<number>>(new Set());
  const [duplicateOverrideKeys, setDuplicateOverrideKeys] = useState<Set<string>>(new Set());
  // Community-level bulk selection in Step 2 research results (for multi-resort queueing of best combos)
  const [bulkCommunityIndexes, setBulkCommunityIndexes] = useState<Set<number>>(new Set());
  const [bulkComboOpen, setBulkComboOpen] = useState(false);
  const [bulkComboStarting, setBulkComboStarting] = useState(false);
  const [bulkComboJobId, setBulkComboJobId] = useState<string | null>(null);
  const [bulkComboJob, setBulkComboJob] = useState<BulkComboListingJobPayload | null>(null);
  const [bulkComboEvents, setBulkComboEvents] = useState<QueueJobEventPayload[]>([]);
  const [bulkComboHistory, setBulkComboHistory] = useState<BulkComboListingJobPayload[]>([]);
  const closeBulkComboQueue = useCallback(() => {
    setBulkComboOpen(false);
    if (location.startsWith("/listing-queue")) {
      navigate("/add-community");
    }
  }, [location, navigate]);

  useEffect(() => {
    if (location.startsWith("/listing-queue")) {
      setBulkComboOpen(true);
    }
  }, [location]);

  const applySweepJob = useCallback((job: TopMarketJobPayload) => {
    if (ignoredSweepJobIdsRef.current.has(job.id)) return;
    setSweepJobId(job.id);
    setSweepMarkets((job.markets || []).map((market) => ({
      ...market,
      fourBedroomPossible: market.status === "done"
        ? (market.communities ?? []).some(hasFourBedroomComboPotential)
        : market.fourBedroomPossible,
      fiveBedroomPossible: market.status === "done"
        ? (market.communities ?? []).some(hasFiveBedroomComboPotential)
        : market.fiveBedroomPossible,
      sixBedroomPossible: market.status === "done"
        ? (market.communities ?? []).some(hasSixBedroomComboPotential)
        : market.sixBedroomPossible,
      sevenEightBedroomPossible: market.status === "done"
        ? (market.communities ?? []).some(hasSevenEightBedroomComboPotential)
        : market.sevenEightBedroomPossible,
    })));
    setSweepPhase("running");
    const terminal = job.status === "done" || job.status === "error" || job.status === "cancelled";
    setSweepRunning(!terminal);
    setSweepDone(terminal);
    if (job.status === "error" && job.error) {
      toast({ title: "Sweep error", description: job.error, variant: "destructive" });
    }
  }, [toast]);

  // Step 3
  const [unitSearchResults, setUnitSearchResults] = useState<{ units: UnitResult[]; grouped: Record<string, UnitResult[]> } | null>(null);
  const [communityProfile, setCommunityProfile] = useState<CommunityProfile | null>(null);
  const [suggestedPairings, setSuggestedPairings] = useState<SuggestedPairing[]>([]);
  const [selectedPairing, setSelectedPairing] = useState<SuggestedPairing | null>(null);
  const [unitSearchLoading, setUnitSearchLoading] = useState(false);
  const [selectedUnit1, setSelectedUnit1] = useState<UnitResult | null>(null);
  const [selectedUnit2, setSelectedUnit2] = useState<UnitResult | null>(null);

  // Step 4
  const [unit1Photos, setUnit1Photos] = useState<PhotoItem[]>([]);
  const [unit2Photos, setUnit2Photos] = useState<PhotoItem[]>([]);
  const [unit1PhotoSourceUrl, setUnit1PhotoSourceUrl] = useState<string | null>(null);
  const [unit2PhotoSourceUrl, setUnit2PhotoSourceUrl] = useState<string | null>(null);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photoFetchStartedAt, setPhotoFetchStartedAt] = useState<number | null>(null);
  const [photoChecks, setPhotoChecks] = useState<Record<string, PhotoCheckResult | "checking">>({});

  // Step 5 — extended draft shape that mirrors the existing
  // Listing Builder's Descriptions tab plus per-unit metadata
  // (bedding / sqft / sleeps / baths / short / long descriptions).
  // Fields default to empty so the existing flat title/description
  // path keeps working while the new structured fields populate
  // alongside.
  type UnitDraft = {
    bedrooms: number;
    bathrooms: string;
    sqft: string;
    maxGuests: number;
    bedding: string;
    shortDescription: string;
    longDescription: string;
  };
  type ListingDraft = {
    title: string;
    bookingTitle?: string;
    propertyType?: string;
    description: string;
    summary?: string;
    space?: string;
    neighborhood?: string;
    transit?: string;
    unitA?: UnitDraft | null;
    unitB?: UnitDraft | null;
    combinedBedrooms: number;
    suggestedRate: number;
    strPermitSample?: string;
    warning?: string;
  };
  const [listing, setListing] = useState<ListingDraft | null>(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [editedTitle, setEditedTitle] = useState("");
  const [editedBookingTitle, setEditedBookingTitle] = useState("");
  const [editedPropertyType, setEditedPropertyType] = useState<string>("Condominium");
  // Pricing area key — keys off BUY_IN_RATES in shared/pricing-rates.
  // Auto-seeded from the city/state via `suggestPricingArea` once
  // the operator hits Step 5; operator can override before saving.
  // "" means "no area selected" → buy-in calc falls through to the
  // per-bedroom default, which the dashboard renders as an
  // approximation.
  const [editedPricingArea, setEditedPricingArea] = useState<string>("");
  // Single complex-level street address. Most resort communities (Pili
  // Mai, named resort communities, etc.) live at one canonical street address shared
  // across all units; the preflight Platform Check appends "Unit X" to
  // it for per-unit text-search matching. Optional — blank falls back
  // to "city, state".
  const [editedStreetAddress, setEditedStreetAddress] = useState<string>("");
  const [editedDescription, setEditedDescription] = useState("");
  const [editedNeighborhood, setEditedNeighborhood] = useState("");
  const [editedTransit, setEditedTransit] = useState("");
  const [editedUnitA, setEditedUnitA] = useState<UnitDraft | null>(null);
  const [editedUnitB, setEditedUnitB] = useState<UnitDraft | null>(null);
  const [strPermit, setStrPermit] = useState("");
  const [dbprLicense, setDbprLicense] = useState("");
  const [touristTaxAccount, setTouristTaxAccount] = useState("");
  const [saving, setSaving] = useState(false);

  const unit1BedroomCount = positiveInteger(selectedUnit1?.bedrooms) ?? positiveInteger(selectedPairing?.unit1Beds);
  const unit2BedroomCount = positiveInteger(selectedUnit2?.bedrooms) ?? positiveInteger(selectedPairing?.unit2Beds);
  const combinedBedrooms = (unit1BedroomCount ?? 0) + (unit2BedroomCount ?? 0);
  const baseRate = (selectedUnit1?.price ?? 0) + (selectedUnit2?.price ?? 0);
  // Suggested nightly rate targets a 20% NET margin AFTER channel
  // costs (Airbnb takes 15.5%, the highest-volume channel for this
  // operator). Math: sell × (1 − 0.155) − cost = 0.20 × cost
  //                   sell = cost × 1.20 / 0.845 ≈ cost × 1.42
  // A flat 25% markup (the prior `* 1.25`) only nets ~5% after the
  // Airbnb fee, which is well below the 20% target Jamie wants the
  // wizard to recommend. Display below shows the actual NET margin
  // so the operator sees what they take home, not the gross markup.
  const NET_MARGIN_TARGET = 0.20;
  const AIRBNB_FEE = 0.155;
  const SELL_MARKUP = (1 + NET_MARGIN_TARGET) / (1 - AIRBNB_FEE); // ≈ 1.42
  const suggestedRate = baseRate > 0 ? Math.round(baseRate * SELL_MARKUP) : 0;
  const suggestedStreetAddress = useMemo(() => inferCommunityStreetAddress({
    communityName: selectedCommunity?.name,
    city: selectedCommunity?.city,
    state: selectedCommunity?.state,
    unitAddresses: [(selectedUnit1 as any)?.address, (selectedUnit2 as any)?.address],
    addressHint: (selectedCommunity as any)?.addressHint,
  }), [selectedCommunity, selectedUnit1, selectedUnit2]);
  const licenseProfile = useMemo(() => resolveLicenseComplianceProfile({
    city: selectedCommunity?.city ?? cityInput,
    state: selectedCommunity?.state ?? selectedState,
    address: [
      editedStreetAddress.trim() || suggestedStreetAddress,
      selectedCommunity?.name,
      selectedCommunity?.city ?? cityInput,
      selectedCommunity?.state ?? selectedState,
    ].filter(Boolean).join(" "),
  }), [selectedCommunity, cityInput, selectedState, editedStreetAddress, suggestedStreetAddress]);
  const researchHistoryNames = useMemo(
    () => (researchHistory?.resultNames ?? []).filter(Boolean).slice(0, 5),
    [researchHistory],
  );

  useEffect(() => {
    if (!editedStreetAddress.trim() && suggestedStreetAddress) {
      setEditedStreetAddress(suggestedStreetAddress);
    }
  }, [editedStreetAddress, suggestedStreetAddress]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ADD_COMBO_DRAFT_KEY);
      if (!raw) {
        draftHydratedRef.current = true;
        return;
      }
      const draft = JSON.parse(raw);
      if (typeof draft.step === "number") setStep(Math.min(Math.max(draft.step, 1), STEPS.length));
      if (typeof draft.selectedState === "string") setSelectedState(draft.selectedState);
      if (typeof draft.cityInput === "string") setCityInput(draft.cityInput);
      if (Array.isArray(draft.communities)) setCommunities(draft.communities);
      if (draft.selectedCommunity) setSelectedCommunity(draft.selectedCommunity);
      if (Array.isArray(draft.sweepMarkets)) setSweepMarkets(draft.sweepMarkets);
      if (typeof draft.sweepJobId === "string") setSweepJobId(draft.sweepJobId);
      if (typeof draft.sweepPhase === "string") setSweepPhase(draft.sweepPhase === "running" ? "running" : "setup");
      if (typeof draft.sweepDone === "boolean") setSweepDone(draft.sweepDone);
      if (typeof draft.photoFetchJobId === "string") {
        restoredPhotoFetchJobIdsRef.current.add(draft.photoFetchJobId);
        setPhotoFetchJobId(draft.photoFetchJobId);
      }
      if (typeof draft.bulkComboJobId === "string") {
        setBulkComboJobId(draft.bulkComboJobId);
        setBulkComboOpen(true);
      }
      // Manual "Add a community" mode + its form fields, so a reload mid-build
      // returns to the manual tab (not the search tab) with the operator's inputs.
      if (typeof draft.manualMode === "boolean") setManualMode(draft.manualMode);
      if (typeof draft.manualName === "string") setManualName(draft.manualName);
      if (typeof draft.manualState === "string") setManualState(draft.manualState);
      if (typeof draft.manualUnit1Url === "string") setManualUnit1Url(draft.manualUnit1Url);
      if (typeof draft.manualUnit2Url === "string") setManualUnit2Url(draft.manualUnit2Url);
      if (typeof draft.manualUnit1Beds === "string") setManualUnit1Beds(draft.manualUnit1Beds);
      if (typeof draft.manualUnit2Beds === "string") setManualUnit2Beds(draft.manualUnit2Beds);
      if (Array.isArray(draft.seedMarkets)) setSeedMarkets(draft.seedMarkets);
      if (Array.isArray(draft.selectedMarkets)) setSelectedMarkets(new Set(draft.selectedMarkets));
      if (draft.unitSearchResults) setUnitSearchResults(draft.unitSearchResults);
      if (draft.communityProfile) setCommunityProfile(draft.communityProfile);
      if (Array.isArray(draft.suggestedPairings)) setSuggestedPairings(draft.suggestedPairings);
      if (draft.selectedPairing) setSelectedPairing(draft.selectedPairing);
      if (draft.selectedUnit1) setSelectedUnit1(draft.selectedUnit1);
      if (draft.selectedUnit2) setSelectedUnit2(draft.selectedUnit2);
      if (Array.isArray(draft.unit1Photos)) setUnit1Photos(draft.unit1Photos);
      if (Array.isArray(draft.unit2Photos)) setUnit2Photos(draft.unit2Photos);
      if (typeof draft.unit1PhotoSourceUrl === "string") setUnit1PhotoSourceUrl(draft.unit1PhotoSourceUrl);
      if (typeof draft.unit2PhotoSourceUrl === "string") setUnit2PhotoSourceUrl(draft.unit2PhotoSourceUrl);
      if (draft.photoChecks && typeof draft.photoChecks === "object") setPhotoChecks(draft.photoChecks);
      if (draft.listing) setListing(draft.listing);
      if (typeof draft.editedTitle === "string") setEditedTitle(draft.editedTitle);
      if (typeof draft.editedBookingTitle === "string") setEditedBookingTitle(draft.editedBookingTitle);
      if (typeof draft.editedPropertyType === "string") setEditedPropertyType(draft.editedPropertyType);
      if (typeof draft.editedPricingArea === "string") setEditedPricingArea(draft.editedPricingArea);
      if (typeof draft.editedStreetAddress === "string") setEditedStreetAddress(draft.editedStreetAddress);
      if (typeof draft.editedDescription === "string") setEditedDescription(draft.editedDescription);
      if (typeof draft.editedNeighborhood === "string") setEditedNeighborhood(draft.editedNeighborhood);
      if (typeof draft.editedTransit === "string") setEditedTransit(draft.editedTransit);
      if (draft.editedUnitA) setEditedUnitA(draft.editedUnitA);
      if (draft.editedUnitB) setEditedUnitB(draft.editedUnitB);
      if (typeof draft.strPermit === "string") setStrPermit(draft.strPermit);
      if (typeof draft.dbprLicense === "string") setDbprLicense(draft.dbprLicense);
      if (typeof draft.touristTaxAccount === "string") setTouristTaxAccount(draft.touristTaxAccount);
      setDraftRestored(true);
    } catch (e) {
      console.warn("[add-community] failed to restore combo draft", e);
      window.localStorage.removeItem(ADD_COMBO_DRAFT_KEY);
    } finally {
      draftHydratedRef.current = true;
      window.setTimeout(() => setDraftAutosaveReady(true), 0);
    }
  }, []);

  useEffect(() => {
    if (!draftHydratedRef.current || !draftAutosaveReady) return;
    const payload = {
      step,
      selectedState,
      cityInput,
      communities,
      selectedCommunity,
      sweepMarkets,
      sweepJobId,
      sweepPhase,
      sweepDone,
      photoFetchJobId,
      bulkComboJobId,
      seedMarkets,
      selectedMarkets: Array.from(selectedMarkets),
      unitSearchResults,
      communityProfile,
      suggestedPairings,
      selectedPairing,
      selectedUnit1,
      selectedUnit2,
      unit1Photos,
      unit2Photos,
      unit1PhotoSourceUrl,
      unit2PhotoSourceUrl,
      photoChecks,
      listing,
      editedTitle,
      editedBookingTitle,
      editedPropertyType,
      editedPricingArea,
      editedStreetAddress,
      editedDescription,
      editedNeighborhood,
      editedTransit,
      editedUnitA,
      editedUnitB,
      strPermit,
      dbprLicense,
      touristTaxAccount,
      manualMode,
      manualName,
      manualState,
      manualUnit1Url,
      manualUnit2Url,
      manualUnit1Beds,
      manualUnit2Beds,
      savedAt: new Date().toISOString(),
    };
    try {
      window.localStorage.setItem(ADD_COMBO_DRAFT_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn("[add-community] failed to autosave combo draft", e);
    }
  }, [
    draftAutosaveReady,
    step, selectedState, cityInput, communities, selectedCommunity, sweepMarkets, sweepJobId,
    sweepPhase, sweepDone, photoFetchJobId, bulkComboJobId, seedMarkets, selectedMarkets, unitSearchResults, communityProfile,
    suggestedPairings, selectedPairing, selectedUnit1, selectedUnit2, unit1Photos, unit2Photos,
    unit1PhotoSourceUrl, unit2PhotoSourceUrl, photoChecks, listing, editedTitle,
    editedBookingTitle, editedPropertyType, editedPricingArea, editedStreetAddress,
    editedDescription, editedNeighborhood, editedTransit, editedUnitA, editedUnitB,
    strPermit, dbprLicense, touristTaxAccount,
    manualMode, manualName, manualState, manualUnit1Url, manualUnit2Url, manualUnit1Beds, manualUnit2Beds,
  ]);

  useEffect(() => {
    if (!sweepJobId) return;
    let cancelled = false;
    const fetchJob = async () => {
      try {
        const resp = await fetch(`/api/community/scan-top-markets-job/${encodeURIComponent(sweepJobId)}`, {
          credentials: "include",
        });
        if (!resp.ok) {
          if (resp.status === 404) {
            setSweepRunning(false);
            setSweepDone(true);
          }
          return;
        }
        const data = await resp.json();
        if (!cancelled && data.job && !ignoredSweepJobIdsRef.current.has(data.job.id)) applySweepJob(data.job);
      } catch (e: any) {
        if (!cancelled) console.warn("[add-community] sweep job poll failed", e?.message || e);
      }
    };
    fetchJob();
    if (sweepDone && !sweepRunning) {
      return () => { cancelled = true; };
    }
    const interval = window.setInterval(fetchJob, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sweepJobId, sweepDone, sweepRunning, applySweepJob]);

  const applyPhotoFetchJob = useCallback((job: ComboPhotoFetchJobPayload) => {
    const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    const restoredJob = restoredPhotoFetchJobIdsRef.current.has(job.id);
    if (terminal) {
      restoredPhotoFetchJobIdsRef.current.delete(job.id);
    }
    setPhotoFetchJob(job);
    setPhotoFetchJobId(terminal ? null : job.id);
    const item = job.items?.[0];
    if (item) {
      if (Array.isArray(item.unit1Photos) && item.unit1Photos.length > 0) setUnit1Photos(item.unit1Photos);
      if (Array.isArray(item.unit2Photos) && item.unit2Photos.length > 0) setUnit2Photos(item.unit2Photos);
      if (typeof item.unit1SourceUrl === "string") setUnit1PhotoSourceUrl(item.unit1SourceUrl);
      if (typeof item.unit2SourceUrl === "string") setUnit2PhotoSourceUrl(item.unit2SourceUrl);
    }
    setPhotosLoading(!terminal);
    if (terminal) {
      setPhotoFetchStartedAt(null);
      if (item?.error && !restoredJob) {
        toast({
          title: job.status === "failed" ? "Photo fetch failed" : "Photo fetch completed with notes",
          description: item.error,
          variant: job.status === "failed" ? "destructive" : undefined,
        });
      }
    }
  }, [toast]);

  useEffect(() => {
    if (!photoFetchJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await fetch(`/api/community/photo-fetch-jobs/${encodeURIComponent(photoFetchJobId)}`, {
          credentials: "include",
        });
        if (!resp.ok) {
          if (resp.status === 404 && !cancelled) {
            setPhotosLoading(false);
            setPhotoFetchJobId(null);
            setPhotoFetchJob(null);
          }
          return;
        }
        const data = await resp.json();
        if (!cancelled && data.job) applyPhotoFetchJob(data.job);
      } catch (e: any) {
        if (!cancelled) console.warn("[add-community] photo fetch job poll failed", e?.message || e);
      }
    };
    poll();
    const terminal = photoFetchJob?.status === "completed" || photoFetchJob?.status === "failed" || photoFetchJob?.status === "cancelled";
    if (terminal) {
      return () => { cancelled = true; };
    }
    const interval = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [photoFetchJobId, photoFetchJob?.status, applyPhotoFetchJob]);

  const cancelPhotoFetchJob = useCallback(async () => {
    if (!photoFetchJobId) return;
    try {
      const resp = await apiRequest("POST", `/api/community/photo-fetch-jobs/${encodeURIComponent(photoFetchJobId)}/cancel`, {});
      const data = await resp.json();
      if (data.job) applyPhotoFetchJob(data.job);
      toast({ title: "Photo fetch cancelled" });
    } catch (e: any) {
      toast({
        title: "Could not cancel photo fetch",
        description: e?.message ?? "The server job may have already finished.",
        variant: "destructive",
      });
    }
  }, [photoFetchJobId, applyPhotoFetchJob, toast]);

  useEffect(() => {
    if (!bulkComboJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await fetch(`/api/community/bulk-combo-listing-jobs/${encodeURIComponent(bulkComboJobId)}`, {
          credentials: "include",
        });
        if (!resp.ok) {
          if (resp.status === 404 && !cancelled) {
            setBulkComboJobId(null);
            setBulkComboJob(null);
          }
          return;
        }
        const data = await resp.json();
        if (!cancelled && data.job) {
          setBulkComboJob(data.job);
          if (Array.isArray(data.events)) setBulkComboEvents(data.events);
          const terminal = ["completed", "failed", "cancelled"].includes(data.job.status);
          if (terminal) queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
        }
      } catch (e: any) {
        if (!cancelled) console.warn("[add-community] bulk combo job poll failed", e?.message || e);
      }
    };
    poll();
    const terminal = bulkComboJob?.status === "completed" || bulkComboJob?.status === "failed" || bulkComboJob?.status === "cancelled";
    if (terminal) return () => { cancelled = true; };
    const interval = window.setInterval(poll, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [bulkComboJobId, bulkComboJob?.status, queryClient]);

  useEffect(() => {
    let cancelled = false;
    const loadHistory = async () => {
      try {
        const resp = await fetch("/api/community/bulk-combo-listing-jobs", { credentials: "include" });
        if (!resp.ok) return;
        const data = await resp.json();
        if (cancelled) return;
        setBulkComboHistory(Array.isArray(data.jobs) ? data.jobs : []);
        const active = Array.isArray(data.active) ? data.active[0] : null;
        if (active && !bulkComboJobId) {
          setBulkComboJob(active);
          setBulkComboJobId(active.id);
        }
      } catch (e: any) {
        if (!cancelled) console.warn("[add-community] bulk queue history poll failed", e?.message || e);
      }
    };
    loadHistory();
    const interval = window.setInterval(loadHistory, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [bulkComboJobId]);

  useEffect(() => {
    const city = cityInput.trim();
    if (!selectedState || city.length < 2) {
      setResearchHistory(null);
      setResearchHistoryLoading(false);
      return;
    }

    let cancelled = false;
    setResearchHistoryLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ city, state: selectedState, mode: "combo" });
        const resp = await fetch(`/api/community/research-history?${params.toString()}`, { credentials: "include" });
        const data = resp.ok ? await resp.json() : { history: null };
        if (!cancelled) setResearchHistory(data.history ?? null);
      } catch (e: any) {
        if (!cancelled) {
          console.warn("[add-community] research history lookup failed", e?.message || e);
          setResearchHistory(null);
        }
      } finally {
        if (!cancelled) setResearchHistoryLoading(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedState, cityInput]);

  const clearSavedComboDraft = useCallback(() => {
    window.localStorage.removeItem(ADD_COMBO_DRAFT_KEY);
    setDraftRestored(false);
    toast({ title: "Saved combo draft cleared", description: "This does not delete anything already saved to the dashboard." });
  }, [toast]);

  // ── Step 2: Research ────────────────────────────────────────
  const handleResearch = useCallback(async () => {
    if (!selectedState || !cityInput.trim()) {
      toast({ title: "Please select a state and enter a city", variant: "destructive" });
      return;
    }
    setResearchLoading(true);
    setResearchProgress(8);
    setCommunities([]);
    setBulkCommunityIndexes(new Set());
    try {
      const res = await apiRequest("POST", "/api/community/research", { city: cityInput.trim(), state: selectedState });
      const data = await res.json();
      setCommunities(data.communities || []);
      setResearchProgress(100);
      if (data.history) setResearchHistory(data.history);
      if ((data.communities || []).length === 0) {
        toast({ title: "No qualifying communities found", description: "Try a different city or state." });
      } else {
        setStep(2);
      }
    } catch (e: any) {
      toast({ title: "Research failed", description: e.message, variant: "destructive" });
    } finally {
      setResearchLoading(false);
      // reset after short delay so UI doesn't flash
      setTimeout(() => setResearchProgress(0), 800);
    }
  }, [selectedState, cityInput, toast]);

  // ── Open the sweep modal in setup mode. Fetches the curated list of
  // markets (if we haven't already) so the checkbox grid can render.
  const resetSweepToMarketPicker = useCallback(() => {
    if (sweepJobId) ignoredSweepJobIdsRef.current.add(sweepJobId);
    setSweepJobId(null);
    setSweepRunning(false);
    setSweepDone(false);
    setSweepMarkets([]);
    setSweepPhase("setup");
    // The resort selection is keyed by POSITION (`${marketIndex}:${communityIndex}`)
    // into the current sweep's markets, so it MUST be dropped whenever the market
    // set is torn down — otherwise leftover keys silently re-apply to whatever
    // resorts land at those positions in the next sweep.
    setSweepResortSelection(new Set());
    setSweepQueueProgress(null);
  }, [sweepJobId]);

  const loadTopMarketSeeds = useCallback(async () => {
    const resp = await fetch("/api/community/top-markets/seeds", { credentials: "include" });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(text || `HTTP ${resp.status}`);
    }
    const data = await resp.json() as {
      seeds?: SeedMarket[];
      markets?: SeedMarket[];
      cache?: { total: number; cached: number; uncached: number; refreshJobId?: string | null };
    };
    const list = data.seeds ?? data.markets ?? [];
    const total = data.cache?.total ?? list.length;
    setSeedMarkets(list);
    setTopMarketCacheStats(data.cache ?? countCachedComboScans(list, total));
    setCacheRefreshJobId(data.cache?.refreshJobId ?? null);
    setCacheRefreshRunning(!!data.cache?.refreshJobId);
    setSelectedMarkets(new Set(list.map(keyFor)));
    return data;
  }, []);

  const openSweepSetup = useCallback(async () => {
    setSweepOpen(true);
    if (sweepJobId && sweepRunning) {
      setSweepPhase("running");
      return;
    }
    resetSweepToMarketPicker();
    try {
      await loadTopMarketSeeds();
    } catch (e: any) {
      toast({ title: "Couldn't load market list", description: e.message, variant: "destructive" });
    }
  }, [sweepJobId, sweepRunning, resetSweepToMarketPicker, loadTopMarketSeeds, toast]);

  useEffect(() => {
    if (!cacheRefreshJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await fetch(`/api/community/scan-top-markets-job/${encodeURIComponent(cacheRefreshJobId)}`, {
          credentials: "include",
        });
        if (!resp.ok) {
          if (resp.status === 404 && !cancelled) {
            setCacheRefreshJobId(null);
            setCacheRefreshRunning(false);
            try {
              await loadTopMarketSeeds();
            } catch {
              /* server may restart refresh after deploy */
            }
          }
          return;
        }
        const data = await resp.json();
        const job = data.job as TopMarketJobPayload | undefined;
        if (!job || cancelled) return;
        setSeedMarkets((prev) => {
          if (!prev) return prev;
          const freshByKey = new Map((job.markets ?? []).map((m) => [keyFor(m), m]));
          const next = prev.map((seed) => {
            const fresh = freshByKey.get(keyFor(seed));
            if (!fresh || (fresh.status !== "done" && fresh.status !== "error")) return seed;
            return {
              ...seed,
              fourBedroomPossible: fresh.fourBedroomPossible ?? (fresh.communities ?? []).some(hasFourBedroomComboPotential),
              fiveBedroomPossible: fresh.fiveBedroomPossible ?? (fresh.communities ?? []).some(hasFiveBedroomComboPotential),
              sixBedroomPossible: fresh.sixBedroomPossible ?? (fresh.communities ?? []).some(hasSixBedroomComboPotential),
              sevenEightBedroomPossible: fresh.sevenEightBedroomPossible ?? (fresh.communities ?? []).some(hasSevenEightBedroomComboPotential),
              qualifyingCount: fresh.count,
              scannedAt: new Date().toISOString(),
              scanError: fresh.error ?? null,
            };
          });
          setTopMarketCacheStats((stats) => {
            const total = stats?.total ?? next.length;
            const counts = countCachedComboScans(next, total);
            return { total, ...counts };
          });
          return next;
        });
        const terminal = job.status === "done" || job.status === "error" || job.status === "cancelled";
        setCacheRefreshRunning(!terminal);
        if (terminal && !cancelled) {
          setCacheRefreshJobId(null);
          try {
            await loadTopMarketSeeds();
          } catch {
            /* best-effort resync */
          }
        }
      } catch (e: any) {
        if (!cancelled) console.warn("[add-community] cache refresh poll failed", e?.message || e);
      }
    };
    poll();
    const interval = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [cacheRefreshJobId, loadTopMarketSeeds]);

  const toggleMarket = (m: { city: string; state: string }) => {
    setSelectedMarkets((prev) => {
      const next = new Set(prev);
      const k = keyFor(m);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const selectAllMarkets = () => {
    if (seedMarkets) setSelectedMarkets(new Set(seedMarkets.map(keyFor)));
  };
  const clearAllMarkets = () => setSelectedMarkets(new Set());

  // ── Top-markets sweep: start a server-owned job and poll it. Keeping
  // the long-running work on the server means the scan keeps going if the
  // operator closes or leaves this tab, then resumes when they return.
  const runTopMarketsSweep = useCallback(async () => {
    if (!seedMarkets) return;
    const picked = seedMarkets.filter((m) => selectedMarkets.has(keyFor(m)));
    if (picked.length === 0) {
      toast({ title: "Pick at least one market", variant: "destructive" });
      return;
    }
    setSweepPhase("running");
    setSweepRunning(true);
    setSweepDone(false);
    // Fresh sweep ⇒ fresh market ordering, so any prior positional resort
    // selection is now meaningless — clear it before seeding the new markets.
    setSweepResortSelection(new Set());
    setSweepQueueProgress(null);
    setSweepMarkets(picked.map((m) => ({
      city: m.city,
      state: m.state,
      tag: m.tag,
      estimatedComboLow: m.estimatedComboLow,
      estimatedComboHigh: m.estimatedComboHigh,
      status: "pending",
    })));
    setSweepJobId(null);

    try {
      const resp = await fetch("/api/community/scan-top-markets-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ markets: picked, maxMarkets: picked.length }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        toast({ title: "Sweep failed", description: text || `HTTP ${resp.status}`, variant: "destructive" });
        setSweepRunning(false);
        return;
      }
      const data = await resp.json();
      if (data.job) applySweepJob(data.job);
    } catch (e: any) {
      toast({ title: "Sweep error", description: e.message, variant: "destructive" });
      setSweepRunning(false);
    }
  }, [seedMarkets, selectedMarkets, toast, applySweepJob]);

  const stopSweep = useCallback(async () => {
    if (!sweepJobId) {
      setSweepRunning(false);
      setSweepDone(true);
      return;
    }
    try {
      const resp = await fetch(`/api/community/scan-top-markets-job/${encodeURIComponent(sweepJobId)}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      const data = await resp.json().catch(() => null);
      if (data?.job) applySweepJob(data.job);
    } catch (e: any) {
      toast({ title: "Couldn't stop sweep", description: e.message, variant: "destructive" });
    }
  }, [sweepJobId, applySweepJob, toast]);

  // When a sweep result is chosen, load it into Step 2 as if the user had
  // searched that city directly, then jump them there.
  const selectSweepCity = useCallback((market: MarketResult) => {
    if (!market.communities || market.communities.length === 0) return;
    setSelectedState(market.state);
    setCityInput(market.city);
    setCommunities(market.communities);
    setSweepOpen(false);
    setStep(2);
  }, []);

  // ── Step 3: Pairing suggestions ─────────────────────────────
  const handleSelectCommunity = useCallback(async (community: CommunityResult, options?: { retryingRestore?: boolean }) => {
    const streetAddress = inferCommunityStreetAddress({
      communityName: community.name,
      city: community.city,
      state: community.state,
      addressHint: (community as any).addressHint,
    });
    setSelectedCommunity(community);
    setEditedStreetAddress(streetAddress);
    setUnitSearchLoading(true);
    setUnitSearchResults(null);
    setCommunityProfile(null);
    setSuggestedPairings([]);
    setBulkPairingIndexes(new Set());
    setDuplicateOverrideKeys(new Set());
    setSelectedPairing(null);
    setSelectedUnit1(null);
    setSelectedUnit2(null);
    setStep(3);
    try {
      const res = await apiRequest("POST", "/api/community/search-units", {
        communityName: community.name,
        city: community.city,
        state: community.state,
        unitTypes: community.unitTypes,
        streetAddress,
        availableBedrooms: community.availableBedrooms,
        bedroomMix: community.bedroomMix,
      });
      const data = await res.json();
      const pairings: SuggestedPairing[] = Array.isArray(data.suggestedPairings) ? data.suggestedPairings : [];
      setUnitSearchResults(data);
      if (data.communityProfile) setCommunityProfile(data.communityProfile);
      setSuggestedPairings(pairings);
      // Auto-select best unused combo type (surgical automation per user request).
      // Skips manual "choose combo type" when a strong unused recommendation exists.
      // If community already has e.g. 3+3, prefers next best like 2+3 if available.
      const best = pickBestAvailableComboPairing(pairings) ?? null;
      if (best) {
        setSelectedPairing(best);
        setSelectedUnit1({ url: "", title: `Unit A — ${best.unit1Beds}BR`, bedrooms: best.unit1Beds, price: best.estimatedUnit1Rate, source: "Algorithm" });
        setSelectedUnit2({ url: "", title: `Unit B — ${best.unit2Beds}BR`, bedrooms: best.unit2Beds, price: best.estimatedUnit2Rate, source: "Algorithm" });
      }
    } catch (e: any) {
      toast({
        title: options?.retryingRestore ? "Pairing retry failed" : "Pairing analysis failed",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setUnitSearchLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!draftHydratedRef.current || !draftAutosaveReady) return;
    if (step !== 3 || !selectedCommunity || unitSearchLoading || unitSearchResults || suggestedPairings.length > 0) return;
    if (pairingAutoResumeRef.current) return;
    pairingAutoResumeRef.current = true;
    window.setTimeout(() => {
      void handleSelectCommunity(selectedCommunity, { retryingRestore: true });
    }, 0);
  }, [
    draftAutosaveReady,
    step,
    selectedCommunity,
    unitSearchLoading,
    unitSearchResults,
    suggestedPairings.length,
    handleSelectCommunity,
  ]);

  const handleSelectPairing = useCallback((pairing: SuggestedPairing) => {
    const key = comboKeyForPairing(pairing);
    if (!isPairingAvailable(pairing) && !duplicateOverrideKeys.has(key)) {
      toast({
        title: pairing.availability === "reserved" ? "Combo is already queued" : "Combo already exists",
        description: "Use Queue duplicate anyway if you intentionally want another listing with this bedroom mix.",
        variant: "destructive",
      });
      return;
    }
    setSelectedPairing(pairing);
    // Create virtual unit records so downstream steps (Photos, Listing Draft) still work
    setSelectedUnit1({
      url: "",
      title: `Unit A — ${pairing.unit1Beds}BR`,
      bedrooms: pairing.unit1Beds,
      price: pairing.estimatedUnit1Rate,
      source: "Algorithm",
    });
    setSelectedUnit2({
      url: "",
      title: `Unit B — ${pairing.unit2Beds}BR`,
      bedrooms: pairing.unit2Beds,
      price: pairing.estimatedUnit2Rate,
      source: "Algorithm",
    });
  }, [duplicateOverrideKeys, toast]);

  // Quick city-bulk enabler: from research results, one-click queue the best *unused*
  // combo type for a resort (auto-picks via alreadyExists flag + matchScore sort).
  // This lets operator search a city, then bulk-add variants across many resorts
  // with almost zero per-resort clicking (no manual combo type choice).
  // Shared "research a resort and build one bulk-combo queue item" step used by
  // every path that queues a community's best unused combo (the per-card quick
  // queue, the Step 2 multi-select, and the cross-market sweep breakdown). Runs
  // search-units, picks the largest UNUSED pairing, and returns a ready queue
  // item — or null when the resort has no available combo left (all used).
  const buildBulkComboItemForCommunity = useCallback(async (
    community: CommunityResult,
    idSeed: string,
    opts?: { skipIfCommunityInSystem?: boolean },
  ): Promise<Record<string, any> | null> => {
    const street = inferCommunityStreetAddress({
      communityName: community.name,
      city: community.city,
      state: community.state,
      addressHint: (community as any).addressHint,
    });
    const res = await apiRequest("POST", "/api/community/search-units", {
      communityName: community.name,
      city: community.city,
      state: community.state,
      unitTypes: community.unitTypes,
      streetAddress: street,
      availableBedrooms: community.availableBedrooms,
      bedroomMix: community.bedroomMix,
    });
    const data = await res.json();
    const pairings: SuggestedPairing[] = Array.isArray(data.suggestedPairings) ? data.suggestedPairings : [];
    const best = pickBestAvailableComboPairing(pairings);
    if (!best) return null;
    const pricingArea = suggestPricingArea(community.city, community.state, community.name);
    return {
      id: `${idSeed}_${Math.random().toString(36).slice(2, 8)}`,
      community,
      pairing: best,
      streetAddress: street,
      pricingArea,
      strPermit: null,
      dbprLicense: null,
      touristTaxAccount: null,
      // Bulk select-all paths set this so the server drops the item if the
      // community is already in the system (city-agnostic backstop).
      ...(opts?.skipIfCommunityInSystem ? { skipIfCommunityInSystem: true } : {}),
    };
  }, []);

  const quickQueueBestCombo = useCallback(async (community: CommunityResult) => {
    try {
      const item = await buildBulkComboItemForCommunity(community, "quick");
      if (!item) {
        toast({ title: "All combos already used", description: "Open the community and choose Queue duplicate anyway if you intentionally want another listing.", variant: "destructive" });
        return;
      }
      const best = item.pairing as SuggestedPairing;
      const resp = await apiRequest("POST", "/api/community/bulk-combo-listing-jobs", { items: [item] });
      const jobData = await resp.json();
      setBulkComboJob(jobData.job);
      setBulkComboJobId(jobData.job.id);
      setBulkComboOpen(true);
      setBulkComboEvents([]);
      toast({ title: "Queued best combo", description: `${community.name} — ${best.unit1Beds}+${best.unit2Beds}BR (auto)` });
    } catch (e: any) {
      toast({ title: "Quick queue failed", description: e?.message || "See console", variant: "destructive" });
    }
  }, [toast, buildBulkComboItemForCommunity]);

  // Manual "Add a community": POST the operator-typed name/state + two unit URLs.
  // The server seeds a single bulk combo-listing job (URL-scraped photos → Claude
  // listing copy → community research/photo folder → dashboard draft → pricing),
  // and we reuse the existing bulk combo job modal + poller to show progress.
  const handleManualBuild = useCallback(async () => {
    const name = manualName.trim();
    const u1 = manualUnit1Url.trim();
    const u2 = manualUnit2Url.trim();
    if (!name) {
      toast({ title: "Community name required", description: "Enter the name of the community you're adding.", variant: "destructive" });
      return;
    }
    if (!manualState) {
      toast({ title: "State required", description: "Pick the state the community is in.", variant: "destructive" });
      return;
    }
    if (!u1 || !u2) {
      toast({ title: "Two unit URLs required", description: "Paste a listing URL for each of the two units.", variant: "destructive" });
      return;
    }
    setManualBuilding(true);
    try {
      const resp = await fetch("/api/community/manual-combo-listing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          communityName: name,
          state: manualState,
          unit1Url: u1,
          unit2Url: u2,
          unit1Bedrooms: manualUnit1Beds.trim() ? Number(manualUnit1Beds) : undefined,
          unit2Bedrooms: manualUnit2Beds.trim() ? Number(manualUnit2Beds) : undefined,
        }),
      });
      const data = await resp.json().catch(() => ({} as any));
      if (!resp.ok) {
        throw new Error(data?.reason || data?.error || `Request failed (${resp.status})`);
      }
      if (!data?.job) throw new Error("The server did not start a build job.");
      setBulkComboJob(data.job);
      setBulkComboJobId(data.job.id);
      setBulkComboEvents([]);
      setBulkComboOpen(true);
      // Clear the form so an accidental second click (the POST returns instantly
      // while the job runs for minutes) can't spawn a duplicate job — the manual
      // path sets allowDuplicate:true server-side, so there's no dedup backstop.
      // State is kept so the operator can add another community in the same state.
      setManualName("");
      setManualUnit1Url("");
      setManualUnit2Url("");
      setManualUnit1Beds("");
      setManualUnit2Beds("");
      toast({
        title: "Building your listing",
        description: `${name} — scraping unit photos, researching the community, and saving the dashboard draft. You can leave this page; it runs on the server.`,
      });
    } catch (e: any) {
      toast({ title: "Could not start the build", description: e?.message || "See console", variant: "destructive" });
    } finally {
      setManualBuilding(false);
    }
  }, [manualName, manualState, manualUnit1Url, manualUnit2Url, manualUnit1Beds, manualUnit2Beds, toast]);

  const toggleBulkCommunity = useCallback((index: number) => {
    setBulkCommunityIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const queueBestCombosForCommunities = useCallback(async (indexes: number[]) => {
    if (indexes.length === 0) return;
    const picked = [...indexes].sort((a, b) => a - b).map((i) => communities[i]).filter(Boolean);
    if (picked.length === 0) return;
    // Skip resorts already in the system — the operator wants bulk-add to ignore
    // anything already covered (the server enforces the same as the backstop).
    const inSystemCount = picked.filter(resortAlreadyInSystem).length;
    const selected = picked.filter((c) => !resortAlreadyInSystem(c));
    if (selected.length === 0) {
      toast({
        title: "Nothing to queue",
        description: `All ${inSystemCount} selected resort${inSystemCount === 1 ? " is" : "s are"} already in the system.`,
        variant: "destructive",
      });
      return;
    }
    setBulkComboStarting(true);
    setBulkComboOpen(true);
    try {
      // Research happens SERVER-SIDE (one durable job resolves each community's best
      // combo), so this hands off the raw list in a single POST and the operator can
      // leave the page — nothing is pinned to the browser.
      const resp = await apiRequest("POST", "/api/community/bulk-combo-listing-jobs/from-communities", { communities: selected });
      const jobData = await resp.json();
      const serverSkipped = Array.isArray(jobData.skipped) ? jobData.skipped.length : 0;
      const serverDeduped = Array.isArray(jobData.deduped) ? jobData.deduped.length : 0;
      const inSystemTotal = inSystemCount + serverSkipped;
      if (jobData.job) {
        setBulkComboJob(jobData.job);
        setBulkComboJobId(jobData.job.id);
        setBulkComboEvents([]);
        const queuedCount = Array.isArray(jobData.job.items) ? jobData.job.items.length : selected.length;
        const extras: string[] = [];
        if (inSystemTotal > 0) extras.push(`${inSystemTotal} already in the system`);
        if (serverDeduped > 0) extras.push(`${serverDeduped} duplicate${serverDeduped === 1 ? "" : "s"}`);
        toast({ title: "Bulk queued", description: [`${queuedCount} community best-combo draft${queuedCount === 1 ? "" : "s"} — safe to leave, the server does the rest`, ...extras].join(" · ") });
      } else {
        toast({
          title: "Nothing new to queue",
          description: inSystemTotal > 0
            ? `${inSystemTotal} selected resort${inSystemTotal === 1 ? " is" : "s are"} already in the system.`
            : "All selected resorts were duplicates or already covered.",
        });
      }
      setBulkCommunityIndexes(new Set());
    } catch (e: any) {
      toast({ title: "Bulk community queue failed", description: e?.message || "See console", variant: "destructive" });
    } finally {
      setBulkComboStarting(false);
    }
  }, [communities, toast]);

  // ── Cross-market sweep resort breakdown helpers ──────────────
  // De-dupe key: the same resort can surface under two adjacent towns (Koloa /
  // Poipu both return Pili Mai), and the bulk endpoint keys duplicates by
  // name|city|state — so two different cities would NOT collapse server-side and
  // would mint two identical drafts. Collapse by normalized name + state here.
  // Delegate to the shared pure key so the DISPLAY dedup (below) and the SELECTION
  // dedup (sweepSelectedCommunities) can never drift apart — see
  // shared/sweep-resort-dedup.ts.
  const resortDedupKey = useCallback((c: CommunityResult) => resortDedupKeyOf(c), []);

  // Cross-market ownership: the same resort can surface under two adjacent towns
  // (overlapping search regions), so we render each resort ONCE — under the first
  // scanned market that surfaced it — and note it as "also found here" under the
  // later markets. Keyed by market order, so it's deterministic once the sweep is
  // done (selection is only enabled at sweepDone). See shared/sweep-resort-dedup.ts.
  const sweepResortOwnership = useMemo(
    () => computeSweepResortOwnership(sweepMarkets),
    [sweepMarkets],
  );

  const toggleSweepResort = useCallback((key: string) => {
    setSweepResortSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Unique communities behind the current sweep selection (deduped by resort).
  const sweepSelectedCommunities = useMemo(() => {
    const out: CommunityResult[] = [];
    const seen = new Set<string>();
    sweepMarkets.forEach((m, mi) => {
      (m.communities ?? []).forEach((c, ci) => {
        if (!sweepResortSelection.has(`${mi}:${ci}`)) return;
        const dk = resortDedupKey(c);
        if (seen.has(dk)) return;
        seen.add(dk);
        out.push(c);
      });
    });
    return out;
  }, [sweepMarkets, sweepResortSelection, resortDedupKey]);

  const selectAllEligibleSweepResorts = useCallback(() => {
    const next = new Set<string>();
    sweepMarkets.forEach((m, mi) => {
      (m.communities ?? []).forEach((c, ci) => {
        // Only tick the VISIBLE (owner) checkbox for a resort — a resort that also
        // surfaced under another city is rendered once and has no checkbox here.
        if (!sweepResortOwnership.ownedIndicesByMarket.get(mi)?.has(ci)) return;
        if (!checkCommunityType(c.unitTypes, c.researchSummary).eligible) return;
        // Never auto-select a resort already in the system — the operator wants the
        // sweep to skip anything already covered (backstopped at queue + on the server).
        if (resortAlreadyInSystem(c)) return;
        next.add(`${mi}:${ci}`);
      });
    });
    setSweepResortSelection(next);
  }, [sweepMarkets, sweepResortOwnership]);

  const clearSweepResorts = useCallback(() => setSweepResortSelection(new Set()), []);

  // Queue every resort the operator ticked across all scanned markets. Respects
  // the server's 12-item-per-batch cap (warns on overflow) and skips resorts
  // whose combos are all already built/queued.
  // One durable server job now holds the whole batch and researches each resort
  // SERVER-SIDE, so the operator can start the sweep and background Safari — the
  // queue runs to completion with nothing pinned to the phone. Keep this in sync
  // with the server's BULK_COMBO_RESEARCH_MAX (default 60); a selection beyond it
  // still auto-continues in the next batch when the current job finishes.
  const BULK_COMBO_BATCH_MAX = 60;
  const queueSelectedSweepResorts = useCallback(async () => {
    // sweepSelectedCommunities is already deduped across cities (same resort in two
    // towns → one entry). 100%-sure backstop: also drop anything already in the
    // system here, so a manually-ticked "Existing" resort is never re-added.
    const alreadyInSystem = sweepSelectedCommunities.filter(resortAlreadyInSystem);
    const selected = sweepSelectedCommunities.filter((c) => !resortAlreadyInSystem(c));
    if (selected.length === 0) {
      toast({
        title: "Nothing to queue",
        description: alreadyInSystem.length > 0
          ? `${alreadyInSystem.length} selected resort${alreadyInSystem.length === 1 ? " is" : "s are"} already in the system — nothing new to add.`
          : "No resorts selected.",
        variant: "destructive",
      });
      return;
    }
    const capped = selected.slice(0, BULK_COMBO_BATCH_MAX);
    const overflow = selected.length - capped.length;
    setSweepQueueStarting(true);
    try {
      // Hand the RAW community list to the server in ONE fast POST. The server
      // dedups + skips already-in-system, then a single durable job researches each
      // resort's best combo SERVER-SIDE (no per-resort "Preparing" loop in the
      // browser), so the sweep survives the phone leaving Safari mid-run.
      const resp = await apiRequest("POST", "/api/community/bulk-combo-listing-jobs/from-communities", { communities: capped });
      const jobData = await resp.json();
      // Server may DROP resorts it caught as duplicates of each other (cross-city) or
      // already-in-system; surface those counts alongside the client-side skips.
      const serverSkippedNames: string[] = Array.isArray(jobData.skipped) ? jobData.skipped.map((s: any) => String(s?.communityName || "")).filter(Boolean) : [];
      const serverDeduped = Array.isArray(jobData.deduped) ? jobData.deduped.length : 0;
      // Name the already-in-system resorts (client flag + server backstop) so a rare
      // fuzzy over-skip is VISIBLE and the operator can re-add it via the wizard.
      const inSystemNames = Array.from(new Set([...alreadyInSystem.map((c) => c.name), ...serverSkippedNames])).filter(Boolean);
      const inSystemTotal = inSystemNames.length;
      const namedList = (names: string[]) => names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
      // De-select every resort this run accounted for (queued + already-in-system) so
      // any overflow stays ticked for a one-click "run again".
      const consumed = new Set([...capped, ...alreadyInSystem].map(resortDedupKey));
      const deselectConsumed = () => setSweepResortSelection((prev) => {
        const next = new Set<string>();
        sweepMarkets.forEach((m, mi) => {
          (m.communities ?? []).forEach((c, ci) => {
            const k = `${mi}:${ci}`;
            if (prev.has(k) && !consumed.has(resortDedupKey(c))) next.add(k);
          });
        });
        return next;
      });
      if (jobData.job) {
        setBulkComboJob(jobData.job);
        setBulkComboJobId(jobData.job.id);
        setBulkComboEvents([]);
        deselectConsumed();
        setBulkComboOpen(true);
        // Arm the one-click auto-continue: the moment this job completes, the
        // remaining (still-selected) overflow queues itself as the next batch.
        sweepAutoContinueArmedRef.current = overflow > 0;
        const queuedCount = Array.isArray(jobData.job.items) ? jobData.job.items.length : capped.length;
        const extras: string[] = [];
        if (inSystemTotal > 0) extras.push(`${inSystemTotal} already in the system (${namedList(inSystemNames)})`);
        if (serverDeduped > 0) extras.push(`${serverDeduped} duplicate${serverDeduped === 1 ? "" : "s"} across cities`);
        if (overflow > 0) {
          toast({
            title: "Bulk queued from sweep",
            description: `${queuedCount} queued${extras.length ? ` · ${extras.join(" · ")}` : ""} · ${overflow} still selected — the next batch queues automatically when this one finishes. Safe to leave — the server researches and builds each one.`,
          });
        } else {
          setSweepOpen(false);
          toast({ title: "Bulk queued from sweep", description: [`${queuedCount} resort${queuedCount === 1 ? "" : "s"} queued — safe to leave, the server does the rest`, ...extras].join(" · ") });
        }
      } else {
        // Nothing queued — the server dropped everything (all already in system or
        // collapsed as cross-city duplicates). De-select them so they don't re-run.
        sweepAutoContinueArmedRef.current = false;
        deselectConsumed();
        toast({
          title: "Nothing new to queue",
          description: inSystemTotal > 0
            ? `${inSystemTotal} selected resort${inSystemTotal === 1 ? " is" : "s are"} already in the system (${namedList(inSystemNames)})${serverDeduped > 0 ? ` · ${serverDeduped} duplicate${serverDeduped === 1 ? "" : "s"} across cities` : ""}.`
            : "All selected resorts were duplicates or already covered.",
        });
      }
    } catch (e: any) {
      sweepAutoContinueArmedRef.current = false;
      const msg = String(e?.message || "");
      const isDuplicate = msg.startsWith("409") || /already (exists|has|active)|already queue/i.test(msg);
      toast({
        title: "Bulk queue failed",
        description: isDuplicate
          ? "A selected resort already has that combo built or queued, so nothing was queued. Un-tick resorts badged “Existing” and try again."
          : (msg || "See console"),
        variant: "destructive",
      });
    } finally {
      setSweepQueueStarting(false);
      setSweepQueueProgress(null);
    }
  }, [sweepSelectedCommunities, sweepMarkets, resortDedupKey, toast]);

  // ONE-CLICK MULTI-BATCH: the server caps a bulk-combo job at
  // BULK_COMBO_BATCH_MAX items, so a big "Select all" used to need a manual
  // "Queue again" click per batch. When the active job COMPLETES and armed
  // overflow selections remain, queue the next batch automatically — the
  // operator selects communities once and walks away. A failed/cancelled job
  // disarms (needs operator attention); each job id auto-continues at most once
  // (guards double-fires from the 2.5s poll + the 15s history poll).
  useEffect(() => {
    const status = bulkComboJob?.status;
    const jobId = bulkComboJob?.id;
    if (!jobId || !status) return;
    if (status === "failed" || status === "cancelled") {
      sweepAutoContinueArmedRef.current = false;
      return;
    }
    if (status !== "completed") return;
    if (!sweepAutoContinueArmedRef.current) return;
    if (sweepQueueStarting) return;
    if (sweepAutoContinuedForJobRef.current === jobId) return;
    const remaining = sweepSelectedCommunities.filter((c) => !resortAlreadyInSystem(c)).length;
    if (remaining === 0) {
      sweepAutoContinueArmedRef.current = false;
      return;
    }
    sweepAutoContinuedForJobRef.current = jobId;
    sweepAutoContinueArmedRef.current = false; // re-armed by queueSelectedSweepResorts if overflow remains
    toast({
      title: "Queueing next sweep batch",
      description: `${remaining} selected resort${remaining === 1 ? "" : "s"} left — starting the next batch automatically.`,
    });
    void queueSelectedSweepResorts();
  }, [bulkComboJob?.status, bulkComboJob?.id, sweepQueueStarting, sweepSelectedCommunities, queueSelectedSweepResorts, toast]);

  const toggleBulkPairing = useCallback((index: number) => {
    setBulkPairingIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const startBulkComboListings = useCallback(async () => {
    if (!selectedCommunity || bulkPairingIndexes.size === 0) return;
    const picked = Array.from(bulkPairingIndexes)
      .sort((a, b) => a - b)
      .map((index) => suggestedPairings[index])
      .filter(Boolean);
    if (picked.length === 0) return;
    const blocked = picked.filter((pairing) => !isPairingAvailable(pairing) && !duplicateOverrideKeys.has(comboKeyForPairing(pairing)));
    if (blocked.length > 0) {
      toast({
        title: "Duplicate combo blocked",
        description: "One or more selected pairings already exist or are queued. Use Queue duplicate anyway on each pairing you want to override.",
        variant: "destructive",
      });
      return;
    }
    setBulkComboStarting(true);
    setBulkComboOpen(true);
    try {
      const resp = await apiRequest("POST", "/api/community/bulk-combo-listing-jobs", {
        items: picked.map((pairing, index) => ({
          id: `pairing_${index + 1}_${pairing.unit1Beds}_${pairing.unit2Beds}`,
          community: selectedCommunity,
          pairing,
          allowDuplicate: duplicateOverrideKeys.has(comboKeyForPairing(pairing)),
          streetAddress: editedStreetAddress.trim() || suggestedStreetAddress || undefined,
          pricingArea: editedPricingArea || suggestPricingArea(selectedCommunity.city, selectedCommunity.state, selectedCommunity.name),
          strPermit: strPermit.trim() || null,
          dbprLicense: dbprLicense.trim() || null,
          touristTaxAccount: touristTaxAccount.trim() || null,
        })),
      });
      const data = await resp.json();
      if (data.job) {
        setBulkComboJob(data.job);
        setBulkComboJobId(data.job.id);
        setBulkComboEvents([]);
        toast({ title: "Bulk listing queue started", description: `${picked.length} combo draft${picked.length === 1 ? "" : "s"} queued.` });
      }
    } catch (e: any) {
      toast({ title: "Bulk queue failed", description: e.message, variant: "destructive" });
    } finally {
      setBulkComboStarting(false);
    }
  }, [
    selectedCommunity,
    bulkPairingIndexes,
    suggestedPairings,
    duplicateOverrideKeys,
    editedStreetAddress,
    suggestedStreetAddress,
    editedPricingArea,
    strPermit,
    dbprLicense,
    touristTaxAccount,
    toast,
  ]);

  const cancelBulkComboListings = useCallback(async () => {
    if (!bulkComboJobId) return;
    try {
      const resp = await apiRequest("POST", `/api/community/bulk-combo-listing-jobs/${bulkComboJobId}/cancel`);
      const data = await resp.json();
      if (data.job) setBulkComboJob(data.job);
      toast({ title: "Bulk listing queue cancellation sent" });
    } catch (e: any) {
      toast({ title: "Cancel failed", description: e.message, variant: "destructive" });
    }
  }, [bulkComboJobId, toast]);

  const retryFailedBulkComboListings = useCallback(async () => {
    if (!bulkComboJobId) return;
    try {
      const resp = await apiRequest("POST", `/api/community/bulk-combo-listing-jobs/${bulkComboJobId}/retry-failed`);
      const data = await resp.json();
      if (data.job) {
        setBulkComboJob(data.job);
        setBulkComboOpen(true);
      }
      toast({ title: "Failed items re-queued", description: `${data.retried || 0} failed item${data.retried === 1 ? "" : "s"} queued for retry.` });
    } catch (e: any) {
      toast({ title: "Retry failed", description: e.message, variant: "destructive" });
    }
  }, [bulkComboJobId, toast]);

  // ── Step 4: Fetch photos ────────────────────────────────────
  const postJsonWithTimeout = useCallback(async (url: string, body: unknown, timeoutMs = PHOTO_FETCH_REQUEST_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`${response.status}: ${text || response.statusText}`);
      }
      return response.json();
    } catch (e: any) {
      if (e?.name === "AbortError") {
        throw new Error("Photo fetch timed out. Try again or pick a different unit source.");
      }
      throw e;
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  const startServerPhotoFetchJob = useCallback(async (): Promise<boolean> => {
    if (!selectedCommunity || !selectedUnit1 || !selectedUnit2) return false;
    if (!unit1BedroomCount || !unit2BedroomCount) {
      toast({
        title: "Bedroom counts required",
        description: "Pick a pairing with explicit bedroom counts before fetching photos.",
        variant: "destructive",
      });
      return false;
    }
    setStep(4);
    setPhotosLoading(true);
    setPhotoFetchStartedAt(null);
    setPhotoFetchJob(null);
    setUnit1Photos([]);
    setUnit2Photos([]);
    setUnit1PhotoSourceUrl(null);
    setUnit2PhotoSourceUrl(null);
    setPhotoChecks({});

    try {
      const resp = await apiRequest("POST", "/api/community/photo-fetch-jobs", {
        item: {
          id: "current-combo",
          label: `${selectedCommunity.name} photo fetch`,
          communityName: selectedCommunity.name,
          streetAddress: editedStreetAddress.trim() || suggestedStreetAddress || undefined,
          city: selectedCommunity.city,
          state: selectedCommunity.state,
          unit1: {
            url: selectedUnit1.url,
            title: selectedUnit1.title,
            bedrooms: unit1BedroomCount,
            address: (selectedUnit1 as any).address,
          },
          unit2: {
            url: selectedUnit2.url,
            title: selectedUnit2.title,
            bedrooms: unit2BedroomCount,
            address: (selectedUnit2 as any).address,
          },
        },
      });
      const data = await resp.json();
      if (data.job) {
        applyPhotoFetchJob(data.job);
        return true;
      }
      return false;
    } catch (e: any) {
      console.warn("[add-community] server photo fetch job failed; falling back to direct fetch", e?.message || e);
      setPhotoFetchJobId(null);
      setPhotoFetchJob(null);
      return false;
    }
  }, [
    selectedCommunity,
    selectedUnit1,
    selectedUnit2,
    editedStreetAddress,
    suggestedStreetAddress,
    unit1BedroomCount,
    unit2BedroomCount,
    applyPhotoFetchJob,
    toast,
  ]);

  const handleConfirmUnits = useCallback(async () => {
    if (!selectedUnit1 || !selectedUnit2) {
      toast({ title: "Please select two units to combine", variant: "destructive" });
      return;
    }
    if (selectedPairing && !isPairingAvailable(selectedPairing) && !duplicateOverrideKeys.has(comboKeyForPairing(selectedPairing))) {
      toast({
        title: "Duplicate combo blocked",
        description: "Use Queue duplicate anyway if you intentionally want another listing with this bedroom mix.",
        variant: "destructive",
      });
      return;
    }
    if (await startServerPhotoFetchJob()) return;
    const runId = photoFetchRunRef.current + 1;
    photoFetchRunRef.current = runId;
    const startedAt = Date.now();
    setStep(4);
    setPhotosLoading(true);
    setPhotoFetchStartedAt(startedAt);
    setUnit1Photos([]);
    setUnit2Photos([]);
    setUnit1PhotoSourceUrl(null);
    setUnit2PhotoSourceUrl(null);
    setPhotoChecks({});

    // Two call shapes for /fetch-unit-photos:
    //   - Direct: pass `url` when the user picked a specific Zillow
    //     listing on Step 3.
    //   - Discovery: when the unit came from an algorithm-suggested
    //     pairing (no URL), pass community + bedrooms so the server
    //     can search Zillow for a real listing matching the
    //     community + BR count and scrape its photos. Either way
    //     the response is `{ photos, sourceUrl, foundVia }`.
    //
    // We only short-circuit to the empty state when neither path
    // can run (no URL AND insufficient community info to search).
    const selectedBedroomsFor = (u: UnitResult) =>
      u === selectedUnit1 ? unit1BedroomCount : u === selectedUnit2 ? unit2BedroomCount : positiveInteger(u.bedrooms);
    const buildBody = (u: UnitResult, skipUrls: string[] = [], bedroomOverride?: number | "any") =>
      u.url
        ? { url: u.url }
        : {
            communityName: selectedCommunity?.name,
            streetAddress: editedStreetAddress.trim() || suggestedStreetAddress || undefined,
            city: selectedCommunity?.city,
            state: selectedCommunity?.state,
            bedrooms: bedroomOverride ?? selectedBedroomsFor(u) ?? undefined,
            skipUrls,
          };
    const canFetch = (u: UnitResult) => !!(u.url || (selectedCommunity?.name && selectedBedroomsFor(u)));

    if (!canFetch(selectedUnit1) && !canFetch(selectedUnit2)) {
      // Nothing we can fetch with — neither a URL nor enough
      // community info to search. The page's empty state covers it.
      setPhotosLoading(false);
      return;
    }

    try {
      const listingKey = (raw: string | null | undefined): string => {
        if (!raw) return "";
        try {
          const u = new URL(raw);
          return `${u.hostname.replace(/^www\./i, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
        } catch {
          return raw.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
        }
      };
      const photoSetLooksSame = (a: PhotoItem[], b: PhotoItem[]): boolean => {
        if (a.length === 0 || b.length === 0) return false;
        const keys = new Set(a.map((p) => p.url.replace(/[?#].*$/, "").toLowerCase()));
        const overlap = b.filter((p) => keys.has(p.url.replace(/[?#].*$/, "").toLowerCase())).length;
        return overlap / Math.min(a.length, b.length) >= 0.8;
      };
      const hasEnoughPhotos = (photos: PhotoItem[]) => photos.length >= 3;
      const fetchUnitPhotosWithRetries = async (
        unit: UnitResult,
        blockedUrls: string[] = [],
        avoidPhotos: PhotoItem[] = [],
      ): Promise<{ photos: PhotoItem[]; sourceUrl: string | null; relaxed: boolean }> => {
        const seenUrls = new Set(blockedUrls.filter(Boolean));
        const attempts: Array<{ bedroomOverride?: number | "any"; relaxed: boolean }> = [
          { relaxed: false },
          { relaxed: false },
          { bedroomOverride: "any", relaxed: true },
        ];
        let best: { photos: PhotoItem[]; sourceUrl: string | null; relaxed: boolean } = {
          photos: [],
          sourceUrl: null,
          relaxed: false,
        };
        for (const attempt of attempts) {
          if (photoFetchRunRef.current !== runId) {
            throw new Error("Photo fetch was restarted.");
          }
          const d = await postJsonWithTimeout(
            "/api/community/fetch-unit-photos",
            buildBody(unit, Array.from(seenUrls), attempt.bedroomOverride),
          );
          const sourceUrl = typeof d.sourceUrl === "string" ? d.sourceUrl : unit.url || null;
          const photos = ((d.photos || []) as PhotoItem[]).slice(0, 25);
          const duplicateSource = !!sourceUrl && Array.from(seenUrls).some((u) => listingKey(u) === listingKey(sourceUrl));
          const duplicatePhotos = avoidPhotos.length > 0 && photoSetLooksSame(avoidPhotos, photos);
          if (photos.length > best.photos.length && !duplicateSource && !duplicatePhotos) {
            best = { photos, sourceUrl, relaxed: attempt.relaxed };
          }
          if (sourceUrl) seenUrls.add(sourceUrl);
          if (hasEnoughPhotos(photos) && !duplicateSource && !duplicatePhotos) {
            return { photos, sourceUrl, relaxed: attempt.relaxed };
          }
        }
        return best;
      };
      let firstSourceUrl: string | null = null;
      let firstPhotos: PhotoItem[] = [];
      if (canFetch(selectedUnit1)) {
        const first = await fetchUnitPhotosWithRetries(selectedUnit1);
        firstSourceUrl = first.sourceUrl;
        firstPhotos = first.photos;
        setUnit1PhotoSourceUrl(firstSourceUrl);
        setUnit1Photos(firstPhotos);
      }
      if (canFetch(selectedUnit2)) {
        // When both combo units are discovered by "community + bedrooms"
        // (common for two 2BR units), the server otherwise returns the same
        // top Zillow/Realtor listing twice. Skip Unit A's source when finding
        // Unit B so the two draft folders do not persist identical photos.
        const skipUrls = firstSourceUrl && !selectedUnit2.url ? [firstSourceUrl] : [];
        const second = await fetchUnitPhotosWithRetries(selectedUnit2, skipUrls, firstPhotos);
        let secondPhotos = second.photos;
        if (!selectedUnit2.url && firstPhotos.length > 0 && photoSetLooksSame(firstPhotos, secondPhotos)) {
          toast({
            title: "Unit B photos need another source",
            description: "The search returned the same photo set as Unit A after multiple retries, so I did not attach duplicate Unit B photos. Try a different pairing or rerun after opening the source links.",
            variant: "destructive",
          });
          secondPhotos = [];
        }
        if (!hasEnoughPhotos(secondPhotos)) {
          toast({
            title: "Unit photos incomplete",
            description: "I could not find at least 3 independent photos for both units. The search now retries broader sources automatically, but this community may need a manually selected source.",
            variant: "destructive",
          });
        } else if (second.relaxed) {
          toast({
            title: "Unit B photos found with broader search",
            description: "Exact bedroom-count photo discovery was thin, so I used a broader same-community listing source for Unit B.",
          });
        }
        setUnit2PhotoSourceUrl(second.sourceUrl);
        setUnit2Photos(secondPhotos);
      }
    } catch (e: any) {
      if (photoFetchRunRef.current === runId) {
        toast({ title: "Photo fetch failed", description: e.message, variant: "destructive" });
      }
    } finally {
      if (photoFetchRunRef.current === runId) {
        setPhotosLoading(false);
        setPhotoFetchStartedAt(null);
      }
    }
  }, [selectedUnit1, selectedUnit2, selectedPairing, duplicateOverrideKeys, selectedCommunity, editedStreetAddress, suggestedStreetAddress, unit1BedroomCount, unit2BedroomCount, toast, postJsonWithTimeout, startServerPhotoFetchJob]);

  useEffect(() => {
    if (!draftHydratedRef.current || !draftAutosaveReady) return;
    if (step !== 4 || photosLoading) return;
    if (!selectedUnit1 || !selectedUnit2) return;
    if (unit1Photos.length + unit2Photos.length > 0) return;
    if (photoFetchJobId) return;
    if (photoAutoResumeRef.current) return;
    photoAutoResumeRef.current = true;
    window.setTimeout(() => {
      void handleConfirmUnits();
    }, 0);
  }, [
    draftAutosaveReady,
    step,
    photosLoading,
    selectedUnit1,
    selectedUnit2,
    photoFetchJobId,
    unit1Photos.length,
    unit2Photos.length,
    handleConfirmUnits,
  ]);

  useEffect(() => {
    if (!photosLoading || !photoFetchStartedAt) return;

    const maybeRestartStaleFetch = () => {
      if (!photosLoading || !photoFetchStartedAt || photoStaleRestartRef.current) return;
      if (Date.now() - photoFetchStartedAt < PHOTO_FETCH_STALE_MS) return;
      photoStaleRestartRef.current = true;
      photoFetchRunRef.current += 1;
      setPhotosLoading(false);
      setPhotoFetchStartedAt(null);
      toast({
        title: "Photo fetch restarted",
        description: "The previous photo request stopped responding after the tab was inactive, so I restarted Step 4.",
      });
      window.setTimeout(() => {
        photoStaleRestartRef.current = false;
        void handleConfirmUnits();
      }, 250);
    };

    const interval = window.setInterval(maybeRestartStaleFetch, 15_000);
    window.addEventListener("focus", maybeRestartStaleFetch);
    document.addEventListener("visibilitychange", maybeRestartStaleFetch);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", maybeRestartStaleFetch);
      document.removeEventListener("visibilitychange", maybeRestartStaleFetch);
    };
  }, [photosLoading, photoFetchStartedAt, handleConfirmUnits, toast]);

  // Run platform check on a photo URL
  const checkPhoto = useCallback(async (imageUrl: string) => {
    setPhotoChecks(prev => ({ ...prev, [imageUrl]: "checking" }));
    try {
      const res = await apiRequest("POST", "/api/community/check-photo-url", { imageUrl });
      const data = await res.json();
      setPhotoChecks(prev => ({ ...prev, [imageUrl]: data }));
    } catch {
      setPhotoChecks(prev => ({ ...prev, [imageUrl]: { clean: true, matches: [] } }));
    }
  }, []);

  const handleCheckAllPhotos = useCallback(() => {
    const allPhotos = [...unit1Photos.slice(0, 3), ...unit2Photos.slice(0, 3)];
    for (const p of allPhotos) checkPhoto(p.url);
  }, [unit1Photos, unit2Photos, checkPhoto]);

  // ── Step 5: Generate listing ────────────────────────────────
  const handleGenerateListing = useCallback(async () => {
    if (!selectedCommunity || !selectedUnit1 || !selectedUnit2) return;
    if (!unit1BedroomCount || !unit2BedroomCount) {
      toast({
        title: "Bedroom counts required",
        description: "Pick a pairing with explicit bedroom counts before generating the listing draft.",
        variant: "destructive",
      });
      return;
    }
    setListingLoading(true);
    setStep(5);
    try {
      const res = await apiRequest("POST", "/api/community/generate-listing", {
        communityName: selectedCommunity.name,
        city: selectedCommunity.city,
        state: selectedCommunity.state,
        unit1: {
          bedrooms: unit1BedroomCount,
          url: selectedUnit1.url,
          address: (selectedUnit1 as any).address,
        },
        unit2: {
          bedrooms: unit2BedroomCount,
          url: selectedUnit2.url,
          address: (selectedUnit2 as any).address,
        },
        suggestedRate,
      });
      const data: ListingDraft = await res.json();
      setListing(data);
      setEditedTitle(data.title || "");
      setEditedBookingTitle(data.bookingTitle || data.title || "");
      setEditedPropertyType(data.propertyType || "Condominium");
      setEditedDescription(data.description || "");
      setEditedNeighborhood(data.neighborhood || "");
      setEditedTransit(data.transit || "");
      setEditedUnitA(data.unitA ?? null);
      setEditedUnitB(data.unitB ?? null);
      if (!editedStreetAddress.trim() && suggestedStreetAddress) {
        setEditedStreetAddress(suggestedStreetAddress);
      }
      // Seed the pricing-area picker from the wizard's city/state
      // unless the operator already picked one. The same default
      // logic powers buy-in / quality calcs for the existing 11
      // active rows (Hawaii cities → Poipu Kai / Princeville /
      // Kapaa Beachfront / Kekaha Beachfront / Keauhou).
      if (!editedPricingArea && selectedCommunity?.city && selectedCommunity?.state) {
        const suggested = suggestPricingArea(selectedCommunity.city, selectedCommunity.state, selectedCommunity.name);
        if (suggested) setEditedPricingArea(suggested);
      }
      // Pre-fill the STR permit field with the county-aware sample
      // template so the operator sees what format to use. Empty
      // strPermit means we haven't pre-filled yet — don't clobber
      // edits the operator made on a prior generate.
      if (!strPermit && data.strPermitSample) {
        setStrPermit(data.strPermitSample);
      }
      if (data.warning) {
        toast({ title: "Draft fallback ready", description: data.warning });
      }
    } catch (e: any) {
      toast({ title: "Listing generation failed", description: e.message, variant: "destructive" });
    } finally {
      setListingLoading(false);
    }
  }, [selectedCommunity, selectedUnit1, selectedUnit2, unit1BedroomCount, unit2BedroomCount, suggestedRate, strPermit, editedStreetAddress, suggestedStreetAddress, toast]);

  // ── Save to dashboard ───────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!selectedCommunity) return;
    if (!unit1BedroomCount || !unit2BedroomCount) {
      toast({
        title: "Bedroom counts required",
        description: "Pick a pairing with explicit bedroom counts before saving to the dashboard.",
        variant: "destructive",
      });
      return;
    }
    const addressCheck = validateCommunityStreetAddress({
      communityName: selectedCommunity.name,
      city: selectedCommunity.city,
      state: selectedCommunity.state,
      streetAddress: editedStreetAddress.trim() || suggestedStreetAddress,
    });
    if (!addressCheck.ok) {
      toast({
        title: "Fix the property address",
        description: addressCheck.error,
        variant: "destructive",
      });
      if (addressCheck.expectedStreet) setEditedStreetAddress(addressCheck.expectedStreet);
      return;
    }
    setSaving(true);
    try {
      const saveResp = await apiRequest("POST", "/api/community/save", {
        name: selectedCommunity.name,
        city: selectedCommunity.city,
        state: selectedCommunity.state,
        estimatedLowRate: selectedCommunity.estimatedLowRate,
        estimatedHighRate: selectedCommunity.estimatedHighRate,
        estimatedTotalUnits: selectedCommunity.estimatedTotalUnits ?? null,
        unitTypes: selectedCommunity.unitTypes,
        confidenceScore: selectedCommunity.confidenceScore,
        researchSummary: selectedCommunity.researchSummary,
        sourceUrl: selectedCommunity.sourceUrl,
        minimumStayNights: selectedCommunity.minimumStayNights ?? null,
        minimumStayEvidence: selectedCommunity.minimumStayEvidence ?? null,
        minimumStaySourceUrl: selectedCommunity.minimumStaySourceUrl ?? null,
        unit1Url: selectedUnit1?.url || unit1PhotoSourceUrl || null,
        unit1Bedrooms: unit1BedroomCount,
        // Per-unit structured fields. Each is nullable on the
        // schema so a draft saved before the operator filled them
        // in (or saved with the AI fallback that doesn't produce
        // them) keeps working.
        unit1Bathrooms: editedUnitA?.bathrooms ?? null,
        unit1Sqft: editedUnitA?.sqft ?? null,
        unit1MaxGuests: editedUnitA?.maxGuests ?? null,
        unit1Bedding: editedUnitA?.bedding ?? null,
        unit1ShortDescription: editedUnitA?.shortDescription ?? null,
        unit1LongDescription: editedUnitA?.longDescription ?? null,
        unit2Url: selectedUnit2?.url || unit2PhotoSourceUrl || null,
        unit2Bedrooms: unit2BedroomCount,
        unit2Bathrooms: editedUnitB?.bathrooms ?? null,
        unit2Sqft: editedUnitB?.sqft ?? null,
        unit2MaxGuests: editedUnitB?.maxGuests ?? null,
        unit2Bedding: editedUnitB?.bedding ?? null,
        unit2ShortDescription: editedUnitB?.shortDescription ?? null,
        unit2LongDescription: editedUnitB?.longDescription ?? null,
        combinedBedrooms: combinedBedrooms || null,
        suggestedRate: suggestedRate || null,
        listingTitle: editedTitle || null,
        bookingTitle: editedBookingTitle || null,
        propertyType: editedPropertyType || null,
        pricingArea: editedPricingArea || null,
        streetAddress: addressCheck.streetAddress,
        listingDescription: editedDescription || null,
        neighborhood: editedNeighborhood || null,
        transit: editedTransit || null,
        strPermit: strPermit.trim() || null,
        dbprLicense: dbprLicense.trim() || null,
        touristTaxAccount: touristTaxAccount.trim() || null,
        status: "draft_ready",
      });
      // Persist Step 4 photos so the builder has them when the
      // operator promotes the draft. Unit photos are load-bearing for
      // the new combo listing, so do not navigate away on a proof or
      // download failure; keep the operator here with the exact error.
      const saved = await saveResp.json().catch(() => null) as { id?: number } | null;
      const draftId = saved?.id;
      if (draftId && (unit1Photos.length > 0 || unit2Photos.length > 0)) {
        try {
          await apiRequest("POST", `/api/community/${draftId}/persist-photos`, {
            unit1Photos: unit1Photos.map((p) => p.url),
            unit2Photos: unit2Photos.map((p) => p.url),
            unit1SourceUrl: selectedUnit1?.url || unit1PhotoSourceUrl || null,
            unit2SourceUrl: selectedUnit2?.url || unit2PhotoSourceUrl || null,
          });
        } catch (e: any) {
          console.warn(`[add-community] photo persist failed: ${e?.message}`);
          throw new Error(`Community draft saved, but photos did not persist: ${e?.message ?? "unknown error"}`);
        }
      }
      // Auto-fetch resort/community-level photos for the Photos tab.
      // Best-effort, fire-and-forget — ~5 SearchAPI calls + 6 image
      // downloads + Claude-vision labels run server-side. The endpoint
      // returns 200 even on partial failure (logs a `reason`), so a
      // search miss never blocks the save flow.
      if (draftId) {
        apiRequest("POST", `/api/community/${draftId}/persist-community-photos`, {})
          .catch((e: any) => console.warn(`[add-community] community-photos persist failed: ${e?.message}`));
      }
      // Auto-fetch per-bedroom live market rates for the Pricing tab.
      // Best-effort, fire-and-forget — runs the SearchAPI Airbnb-
      // engine 7-night-amortized lookup and persists per-BR medians
      // to `property_market_rates` (keyed by `-draftId`). The Pricing
      // tab's effective-buy-in lookup picks them up on the next
      // builder load, so the per-channel floor formula uses live
      // medians instead of just the static BUY_IN_RATES table.
      if (draftId) {
        apiRequest("POST", `/api/community/${draftId}/refresh-pricing`, {})
          .catch((e: any) => console.warn(`[add-community] refresh-pricing failed: ${e?.message}`));
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
      window.localStorage.removeItem(ADD_COMBO_DRAFT_KEY);
      toast({ title: "Community saved to dashboard!" });
      navigate("/");
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [selectedCommunity, selectedUnit1, selectedUnit2, unit1BedroomCount, unit2BedroomCount, combinedBedrooms, suggestedRate, editedTitle, editedBookingTitle, editedPropertyType, editedPricingArea, editedStreetAddress, suggestedStreetAddress, editedDescription, editedNeighborhood, editedTransit, editedUnitA, editedUnitB, strPermit, dbprLicense, touristTaxAccount, unit1Photos, unit2Photos, unit1PhotoSourceUrl, unit2PhotoSourceUrl, toast, navigate, queryClient]);

  const flaggedPhotos = Object.values(photoChecks).filter(v => v !== "checking" && !(v as PhotoCheckResult).clean);
  const activeBulkComboJobs = bulkComboHistory.filter((job) => job.status === "queued" || job.status === "running");
  const visibleBulkComboJobs = (() => {
    const byId = new Map<string, BulkComboListingJobPayload>();
    if (bulkComboJob) byId.set(bulkComboJob.id, bulkComboJob);
    for (const job of activeBulkComboJobs) byId.set(job.id, job);
    return Array.from(byId.values()).sort((a, b) => {
      const aTime = typeof a.createdAt === "number" ? a.createdAt : Date.parse(String(a.createdAt ?? ""));
      const bTime = typeof b.createdAt === "number" ? b.createdAt : Date.parse(String(b.createdAt ?? ""));
      return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
    });
  })();
  const visibleBulkComboItems = visibleBulkComboJobs.flatMap((job) => job.items.map((item) => ({ job, item })));
  const visibleBulkComboCompleted = visibleBulkComboItems.filter(({ item }) => item.status === "completed").length;
  const visibleBulkComboFailed = visibleBulkComboItems.filter(({ item }) => item.status === "failed").length;
  const visibleBulkComboCancelled = visibleBulkComboItems.filter(({ item }) => item.status === "cancelled").length;
  const visibleBulkComboRunning = visibleBulkComboItems.filter(({ item }) => item.status === "running").length;
  const visibleBulkComboQueued = visibleBulkComboItems.filter(({ item }) => item.status === "queued").length;

  const bulkComboQueueAhead = (job: BulkComboListingJobPayload, itemId: string) => {
    const index = job.items.findIndex((entry) => entry.id === itemId);
    if (index <= 0) return 0;
    return job.items.slice(0, index).filter((entry) => entry.status === "running" || entry.status === "queued").length;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-3 py-4 sm:px-4 sm:py-6">
        {/* Header */}
        <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <AppBackButton testId="button-back-home" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Add a New Community</h1>
            <p className="text-sm text-muted-foreground">Research, validate, and draft a new VacationRentalExpertz bundled listing</p>
          </div>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1" id="step-indicator" aria-label={`Step ${step} of ${STEPS.length}`}>
          {STEPS.map((label, i) => {
            const stepNum = i + 1;
            const isActive = step === stepNum;
            const isDone = step > stepNum;
            return (
              <div key={label} className="flex items-center gap-2 shrink-0">
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  isActive ? "bg-primary text-primary-foreground" :
                  isDone ? "bg-primary/20 text-primary" :
                  "bg-muted text-muted-foreground"
                }`} id={`step-indicator-${stepNum}`}>
                  {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="w-4 h-4 text-center leading-4">{stepNum}</span>}
                  {label}
                </div>
                {i < STEPS.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />}
              </div>
            );
          })}
        </div>
        <p className="text-sm text-muted-foreground mb-6" id="step-progress-label">Step {step} of {STEPS.length}: {STEPS[step - 1]}</p>
        {draftRestored && (
          <Card className="mb-6 border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>
                Saved combo-listing progress restored. You can leave this tab and come back without losing the current step.
                {sweepRunning ? " The top-market scan is still running in the background." : ""}
              </span>
              <Button variant="outline" size="sm" onClick={clearSavedComboDraft}>
                Clear saved draft
              </Button>
            </div>
          </Card>
        )}

        {/* ── STEP 1: Location ─────────────────────────────── */}
        {step === 1 && (
          <Card className="p-6" id="step-1-content">
            <div className="flex items-center gap-2 mb-4">
              <MapPin className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold" id="step-1-heading">{manualMode ? "Add a community manually" : "Step 1: Select Location"}</h2>
            </div>
            {/* Mode toggle — discover communities by city (default) vs. add one
                manually from a name + two pasted unit URLs. */}
            <div className="mb-5 inline-flex rounded-lg border bg-muted/40 p-1" role="tablist" aria-label="Add community mode">
              <button
                type="button"
                role="tab"
                aria-selected={!manualMode}
                onClick={() => setManualMode(false)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${!manualMode ? "bg-background shadow font-medium" : "text-muted-foreground hover:text-foreground"}`}
                data-testid="mode-search"
              >
                Search &amp; discover
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={manualMode}
                onClick={() => setManualMode(true)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${manualMode ? "bg-background shadow font-medium" : "text-muted-foreground hover:text-foreground"}`}
                data-testid="mode-manual"
              >
                Add manually
              </button>
            </div>
            {!manualMode && (<>
            <p className="text-muted-foreground text-sm mb-6">
              Choose a US state and city to research vacation rental communities suitable for bundled multi-unit listings.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              <div>
                <label htmlFor="select-state" className="text-sm font-medium mb-1.5 block">State</label>
                <Select value={selectedState} onValueChange={setSelectedState}>
                  <SelectTrigger data-testid="select-state" id="select-state" aria-label="Select US state">
                    <SelectValue placeholder="Select a state…" />
                  </SelectTrigger>
                  <SelectContent>
                    {US_STATES.map(s => (
                      <SelectItem key={s} value={s} id={`option-state-${s.replace(/\s/g, "-")}`}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="input-city" className="text-sm font-medium mb-1.5 block">City</label>
                <div className="relative">
                  <Input
                    id="input-city"
                    placeholder={selectedState ? "Start typing — e.g. Kissimmee, Myrtle Beach…" : "Pick a state first…"}
                    value={cityInput}
                    onChange={e => {
                      setCityInput(e.target.value);
                      setShowCitySuggestions(true);
                    }}
                    onFocus={() => setShowCitySuggestions(true)}
                    // Delay close so click-on-suggestion lands before
                    // blur tears the dropdown down. 200ms is enough
                    // for the click to register.
                    onBlur={() => setTimeout(() => setShowCitySuggestions(false), 200)}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        if (citySuggestions.length > 0 && showCitySuggestions) {
                          // Pressing Enter while suggestions are
                          // visible commits the top match — matches
                          // typical typeahead UX where a user types
                          // a few chars and hits Enter to accept.
                          setCityInput(citySuggestions[0]);
                          setShowCitySuggestions(false);
                        } else {
                          handleResearch();
                        }
                      } else if (e.key === "Escape") {
                        setShowCitySuggestions(false);
                      }
                    }}
                    disabled={!selectedState}
                    data-testid="input-city"
                    aria-label="Enter city name"
                    aria-autocomplete="list"
                    aria-expanded={showCitySuggestions && citySuggestions.length > 0}
                    autoComplete="off"
                  />
                  {showCitySuggestions && (citySuggestionsLoading || citySuggestions.length > 0) && (
                    <div
                      className="absolute top-full left-0 right-0 mt-1 bg-card border rounded-md shadow-lg z-20 max-h-60 overflow-auto"
                      data-testid="city-suggestions"
                    >
                      {citySuggestionsLoading && citySuggestions.length === 0 && (
                        <div className="px-3 py-2 text-xs text-muted-foreground italic">Looking up cities…</div>
                      )}
                      {citySuggestions.map((c) => (
                        <button
                          key={c}
                          type="button"
                          // onMouseDown fires before the input's onBlur,
                          // so the click registers even though the
                          // input is losing focus.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setCityInput(c);
                            setShowCitySuggestions(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                          data-testid={`city-suggestion-${c.replace(/\s+/g, "-")}`}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div id="summary-panel" className="mb-4 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
              <strong>Current selection:</strong> {selectedState || "No state selected"} — {cityInput || "No city entered"}
            </div>
            {(researchHistoryLoading || researchHistory) && (
              <div
                className="mb-4 rounded-md border border-blue-100 bg-blue-50/60 p-3 text-sm text-blue-950"
                data-testid="city-research-history"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-blue-700" />
                  <strong>Last city search:</strong>
                  {researchHistoryLoading ? (
                    <span className="text-blue-800/75">Checking history…</span>
                  ) : researchHistory ? (
                    <span>
                      {formatResearchHistoryTime(researchHistory.lastSearchedAt)} — yielded{" "}
                      <strong>{researchHistory.resultCount}</strong> communities
                    </span>
                  ) : null}
                </div>
                {!researchHistoryLoading && researchHistory?.error && (
                  <div className="mt-1 text-xs text-red-700">Last run failed: {researchHistory.error}</div>
                )}
                {!researchHistoryLoading && !researchHistory?.error && researchHistoryNames.length > 0 && (
                  <div className="mt-1 text-xs text-blue-900/75">
                    Results: {researchHistoryNames.join(", ")}
                    {researchHistory && researchHistory.resultNames.length > researchHistoryNames.length ? "…" : ""}
                  </div>
                )}
              </div>
            )}
            {nearbyCitySuggestions.length > 0 && (
              <div className="mb-4">
                <div className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                  <span>Nearby cities within ~20 min drive</span>
                  <span className="text-[9px]">(researched; click to pivot research)</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {nearbyCitySuggestions.map((n) => (
                    <Button
                      key={n.label}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setCityInput(n.label);
                        setShowCitySuggestions(false);
                      }}
                      data-testid={`nearby-city-${n.label.replace(/\s+/g, "-")}`}
                    >
                      {n.label} <span className="ml-1 opacity-70">({n.minutes}min)</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleResearch}
                disabled={researchLoading || !selectedState || !cityInput.trim()}
                data-testid="button-research"
                id="btn-next-step"
                aria-label="Research communities in the selected location"
              >
                {researchLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                {researchLoading ? "Researching…" : "Research Communities"}
              </Button>
              <Button
                variant="outline"
                onClick={openSweepSetup}
                disabled={researchLoading || sweepRunning}
                data-testid="button-scan-top-markets"
                aria-label="Open market picker for the top vacation rental markets"
              >
                <TrendingUp className="h-4 w-4 mr-2" />
                {sweepRunning ? "Sweeping…" : "Scan top markets"}
              </Button>
            </div>
            {researchLoading && (() => {
              const pct = Math.min(100, Math.max(0, researchProgress));
              const stage = pct < 25 ? { label: "Starting research", detail: "Sending city to community research service + Google." }
                : pct < 55 ? { label: "Finding communities", detail: "Querying vacation-rental condo/townhome clusters." }
                : pct < 78 ? { label: "AI scoring", detail: "Claude ranking by confidence + combinability for bundled listings." }
                : pct < 96 ? { label: "Finalizing shortlist", detail: "Preparing results with rates and unit mixes." }
                : { label: "Wrapping up", detail: "Loading researched communities." };
              return (
                <div className="mt-3 border rounded-lg p-3 bg-muted/20" id="status-message">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-2 min-w-0">
                      <Loader2 className="h-4 w-4 animate-spin text-primary mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">{stage.label}</div>
                        <div className="text-xs text-muted-foreground">{stage.detail}</div>
                      </div>
                    </div>
                    <div className="text-xs font-mono tabular-nums text-muted-foreground">{pct}%</div>
                  </div>
                  <div className="w-full h-2 bg-muted rounded-full overflow-hidden mt-2">
                    <div className="h-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1.5">
                    Server-side research continues even if you close this tab (results are computed on Railway). Re-open to see progress or re-run to retrieve.
                  </div>
                </div>
              );
            })()}
            </>)}
            {manualMode && (
              <div className="space-y-4" data-testid="manual-community-form">
                <p className="text-muted-foreground text-sm">
                  Already found the two units? Name the community, pick its state, and paste a
                  listing URL for each unit. We'll scrape the photos, research the community and
                  its amenity photos with AI, and build the combo listing on your dashboard — it
                  runs on the server, so you can leave this page.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2">
                    <label htmlFor="manual-name" className="text-sm font-medium mb-1.5 block">Community name</label>
                    <Input
                      id="manual-name"
                      placeholder="e.g. Poipu Kai Resort"
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                      data-testid="manual-name"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="manual-state" className="text-sm font-medium mb-1.5 block">State</label>
                    <Select value={manualState} onValueChange={setManualState}>
                      <SelectTrigger data-testid="manual-state" id="manual-state" aria-label="Select the community's state">
                        <SelectValue placeholder="Select a state…" />
                      </SelectTrigger>
                      <SelectContent>
                        {US_STATES.map((s) => (
                          <SelectItem key={s} value={s} id={`manual-option-state-${s.replace(/\s/g, "-")}`}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground mt-1">City and street address are detected automatically from the units + community name.</p>
                  </div>
                  <div>
                    <label htmlFor="manual-unit1-url" className="text-sm font-medium mb-1.5 block">Unit A listing URL</label>
                    <Input
                      id="manual-unit1-url"
                      placeholder="Zillow / Redfin / Realtor.com / Homes.com"
                      value={manualUnit1Url}
                      onChange={(e) => setManualUnit1Url(e.target.value)}
                      data-testid="manual-unit1-url"
                    />
                  </div>
                  <div>
                    <label htmlFor="manual-unit2-url" className="text-sm font-medium mb-1.5 block">Unit B listing URL</label>
                    <Input
                      id="manual-unit2-url"
                      placeholder="Zillow / Redfin / Realtor.com / Homes.com"
                      value={manualUnit2Url}
                      onChange={(e) => setManualUnit2Url(e.target.value)}
                      data-testid="manual-unit2-url"
                    />
                  </div>
                  <div>
                    <label htmlFor="manual-unit1-beds" className="text-sm font-medium mb-1.5 block">Unit A bedrooms <span className="font-normal text-muted-foreground">(optional)</span></label>
                    <Input
                      id="manual-unit1-beds"
                      type="number"
                      min={1}
                      max={8}
                      placeholder="auto-detect"
                      value={manualUnit1Beds}
                      onChange={(e) => setManualUnit1Beds(e.target.value)}
                      data-testid="manual-unit1-beds"
                    />
                  </div>
                  <div>
                    <label htmlFor="manual-unit2-beds" className="text-sm font-medium mb-1.5 block">Unit B bedrooms <span className="font-normal text-muted-foreground">(optional)</span></label>
                    <Input
                      id="manual-unit2-beds"
                      type="number"
                      min={1}
                      max={8}
                      placeholder="auto-detect"
                      value={manualUnit2Beds}
                      onChange={(e) => setManualUnit2Beds(e.target.value)}
                      data-testid="manual-unit2-beds"
                    />
                  </div>
                </div>
                <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
                  Use a <strong>Zillow, Redfin, Realtor.com, or Homes.com</strong> listing for each unit —
                  those expose full photo galleries. VRBO / Airbnb / Booking.com URLs can't be scraped
                  (and a combo is built from clean, non-OTA units anyway).
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={handleManualBuild}
                    disabled={manualBuilding || !manualName.trim() || !manualState || !manualUnit1Url.trim() || !manualUnit2Url.trim()}
                    data-testid="manual-build"
                    aria-label="Build the combo listing from the two unit URLs"
                  >
                    {manualBuilding ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                    {manualBuilding ? "Starting…" : "Build listing"}
                  </Button>
                  {bulkComboJob && (
                    <Button
                      variant="outline"
                      onClick={() => setBulkComboOpen(true)}
                      data-testid="manual-view-progress"
                    >
                      View build progress
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* ── TOP-MARKETS SWEEP MODAL ─────────────────────────── */}
        {sweepOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4"
            onClick={() => !sweepRunning && setSweepOpen(false)}
          >
            <div
              className="max-h-[calc(100vh-1rem)] w-full max-w-4xl overflow-y-auto rounded-lg bg-background p-3 shadow-xl sm:max-h-[90vh] sm:p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-primary" />
                    {sweepPhase === "setup" ? "Pick markets to scan" : "Top Markets Sweep"}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {sweepPhase === "setup"
                      ? "Combo potential badges are cached server-side for all top markets. A background scan fills any missing markets automatically (~90s each)."
                      : "Running the finder across your selected markets. Each takes ~90s."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {sweepRunning && (
                    <Button variant="destructive" size="sm" onClick={stopSweep}>Stop</Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setSweepOpen(false)} disabled={sweepRunning}>
                    Close
                  </Button>
                </div>
              </div>

              {/* ── SETUP PHASE — checkbox grid of candidate markets ── */}
              {sweepPhase === "setup" && (
                <div>
                  {!seedMarkets ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                      Loading market list…
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 mb-3 flex-wrap text-xs">
                        <Button size="sm" variant="outline" onClick={selectAllMarkets}>Select all</Button>
                        <Button size="sm" variant="outline" onClick={clearAllMarkets}>Clear</Button>
                        <span className="text-muted-foreground ml-2">
                          {selectedMarkets.size} of {seedMarkets.length} selected
                        </span>
                        {topMarketCacheStats && (
                          <span className="text-muted-foreground">
                            · {topMarketCacheStats.cached}/{topMarketCacheStats.total} combo scans cached
                          </span>
                        )}
                      </div>
                      {cacheRefreshRunning && (
                        <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                          Server is scanning uncached top markets in the background. Badges update as each city finishes.
                        </div>
                      )}
                      {(() => {
                        const byTag: Record<string, typeof seedMarkets> = {};
                        for (const m of seedMarkets) {
                          (byTag[m.tag] = byTag[m.tag] ?? []).push(m);
                        }
                        return (
                          <div className="space-y-3">
                            {Object.entries(byTag).map(([tag, markets]) => (
                              <div key={tag}>
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                                  {tag}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                  {markets.map((m) => {
                                    const k = keyFor(m);
                                    const checked = selectedMarkets.has(k);
                                    const comboBadges = [
                                      seedComboBadge(m.fourBedroomPossible, "four"),
                                      seedComboBadge(m.fiveBedroomPossible, "five"),
                                      seedComboBadge(m.sixBedroomPossible, "six"),
                                      seedComboBadge(m.sevenEightBedroomPossible, "sevenEight"),
                                    ];
                                    return (
                                      <label
                                        key={k}
                                        className={`flex items-start gap-2 px-3 py-2 rounded border cursor-pointer text-sm transition-colors ${
                                          checked ? "border-primary bg-primary/5" : "hover:border-muted-foreground/40"
                                        }`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() => toggleMarket(m)}
                                          className="accent-primary mt-1"
                                        />
                                        <span className="min-w-0 flex-1">
                                          <span className="block font-medium leading-snug">
                                            {m.city}, {m.state}
                                          </span>
                                          <span className="mt-1 flex flex-wrap gap-1">
                                            {comboBadges.map((badge) => (
                                              <span
                                                key={badge.label}
                                                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`}
                                                title={badge.title}
                                              >
                                                {badge.icon === "yes" ? (
                                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                                ) : badge.icon === "no" ? (
                                                  <XCircle className="h-3 w-3 mr-1" />
                                                ) : (
                                                  <Search className="h-3 w-3 mr-1" />
                                                )}
                                                {badge.label}
                                              </span>
                                            ))}
                                          </span>
                                          <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                                            <DollarSign className="h-3 w-3" />
                                            Est. combo rental {formatComboRange(m.estimatedComboLow, m.estimatedComboHigh)}
                                          </span>
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      <div className="mt-5 flex items-center justify-end gap-2">
                        <Button
                          className="w-full sm:w-auto"
                          onClick={runTopMarketsSweep}
                          disabled={selectedMarkets.size === 0}
                          data-testid="button-run-sweep"
                        >
                          <Search className="h-4 w-4 mr-2" />
                          Run scan on {selectedMarkets.size} market{selectedMarkets.size === 1 ? "" : "s"}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Overall progress (running/done phase) */}
              {sweepPhase === "running" && (
              <div className="mb-4 text-xs text-muted-foreground">
                {sweepMarkets.filter((m) => m.status === "done").length} of {sweepMarkets.length} markets complete
                {sweepDone && " — finished"}
              </div>
              )}

              {/* Per-market list (running/done phase). Once a market finishes,
                  its researched resorts list inline with checkboxes so the
                  operator can tick resorts ACROSS every scanned market and
                  bulk-queue them in one action (the global footer below). */}
              {sweepPhase === "running" && (
              <div className="space-y-2">
                {sweepMarkets.map((m, mi) => {
                  const marketResorts = m.communities ?? [];
                  // Only the resorts THIS market owns are rendered here; the rest
                  // surfaced first under an earlier city (shown there instead).
                  const ownedIndices = sweepResortOwnership.ownedIndicesByMarket.get(mi);
                  const ownsResort = (ci: number) => ownedIndices?.has(ci) === true;
                  const ownedResorts = marketResorts.filter((_, ci) => ownsResort(ci));
                  // "Best pick" summary should name a resort the operator can
                  // actually see under this market — pick the first OWNED resort.
                  const best = ownedResorts[0];
                  const bestScore = best ? best.confidenceScore + (best.combinabilityScore ?? 50) : 0;
                  // Resorts found here but displayed under an earlier city.
                  const movedResorts = sweepResortOwnership.movedByMarket.get(mi) ?? [];
                  const showResortBreakdown = m.status === "done" && (ownedResorts.length > 0 || movedResorts.length > 0);
                  const comboBadgeState = (
                    possible: boolean | undefined,
                    yesClassName: string,
                    yesTitle: string,
                    noTitle: string,
                  ) => {
                    if (m.status === "done") {
                      return possible
                        ? { className: yesClassName, title: yesTitle, label: "yes", icon: "yes" as const }
                        : { className: "border-slate-200 bg-slate-50 text-slate-600", title: noTitle, label: "no", icon: "no" as const };
                    }
                    if (m.status === "error" || m.status === "cancelled") {
                      return {
                        className: "border-slate-200 bg-slate-50 text-slate-600",
                        title: "This market was not checked successfully",
                        label: "not checked",
                        icon: "no" as const,
                      };
                    }
                    return {
                      className: "border-amber-200 bg-amber-50 text-amber-700",
                      title: "Checking this market's researched communities now",
                      label: "checking",
                      icon: "checking" as const,
                    };
                  };
                  const comboBadges = [
                    {
                      label: "4BR combo",
                      state: comboBadgeState(
                        m.fourBedroomPossible,
                        "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
                        "Has evidence for a 4BR combo using two 2BR condo units",
                        "Completed scan found no two-2BR 4BR combo potential for this market",
                      ),
                    },
                    {
                      label: "5BR combo",
                      state: comboBadgeState(
                        m.fiveBedroomPossible,
                        "border-indigo-200 bg-indigo-50 text-indigo-700",
                        "Has evidence for a 5BR combo using a 2BR + 3BR condo",
                        "Completed scan found no 2BR+3BR 5BR combo potential for this market",
                      ),
                    },
                    {
                      label: "6BR combo",
                      state: comboBadgeState(
                        m.sixBedroomPossible,
                        "border-emerald-200 bg-emerald-50 text-emerald-700",
                        "Has evidence for a 6BR combo using two 3BR condo/townhome units",
                        "Completed scan found no two-3BR 6BR combo potential for this market",
                      ),
                    },
                    {
                      label: "7/8BR combo",
                      state: comboBadgeState(
                        m.sevenEightBedroomPossible,
                        "border-sky-200 bg-sky-50 text-sky-700",
                        "Has evidence for 7BR/8BR combo potential using 3BR+4BR or 4BR+4BR attached inventory (requires 4BR units)",
                        "Completed scan found no 7BR/8BR combo potential for this market",
                      ),
                    },
                  ];
                  return (
                    <Card
                      key={`${m.city}-${m.state}`}
                      className={`p-3 ${
                        m.status === "done" && (m.count ?? 0) > 0 ? "border-green-200 bg-green-50/40" :
                        m.status === "error" ? "border-red-200 bg-red-50/30" :
                        m.status === "running" ? "border-blue-300 bg-blue-50/30" :
                        "opacity-60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-sm">{m.city}, {m.state}</p>
                            {m.tag && <Badge variant="outline" className="text-[10px]">{m.tag}</Badge>}
                            {comboBadges.map(({ label, state }) => (
                              <Badge
                                key={label}
                                variant="outline"
                                className={`text-[10px] ${state.className}`}
                                title={state.title}
                              >
                                {state.icon === "checking" ? (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                ) : state.icon === "yes" ? (
                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                ) : (
                                  <XCircle className="h-3 w-3 mr-1" />
                                )}
                                {label}: {state.label}
                              </Badge>
                            ))}
                            <Badge variant="outline" className="text-[10px] border-emerald-200 bg-emerald-50 text-emerald-700">
                              <DollarSign className="h-3 w-3 mr-1" />
                              {formatComboRange(m.estimatedComboLow, m.estimatedComboHigh)}
                            </Badge>
                            {m.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />}
                            {m.status === "done" && (
                              <Badge className={(m.count ?? 0) > 0 ? "bg-green-600 text-white" : "bg-gray-400 text-white"}>
                                {m.count ?? 0} qualifying
                              </Badge>
                            )}
                            {m.status === "error" && <Badge variant="destructive">Error</Badge>}
                            {m.status === "cancelled" && <Badge variant="outline">Cancelled</Badge>}
                          </div>
                          {best && (
                            <div className="mt-1 break-words text-xs text-muted-foreground sm:truncate">
                              Best pick: <span className="font-medium text-foreground">{best.name}</span>
                              {best.bedroomMix && <span className="italic ml-1">({best.bedroomMix})</span>}
                              {typeof best.combinabilityScore === "number" && (
                                <span className="ml-1.5">· combinability {best.combinabilityScore}</span>
                              )}
                              {(best.estimatedLowRate || best.estimatedHighRate) && (
                                <span className="ml-1.5">
                                  · resort est. {formatComboRange(best.estimatedLowRate, best.estimatedHighRate)}
                                </span>
                              )}
                              <span className="ml-1.5">· score {bestScore}</span>
                            </div>
                          )}
                          {m.error && (
                            <p className="text-xs text-red-700 mt-1">{m.error}</p>
                          )}
                        </div>
                        {m.status === "done" && (m.count ?? 0) > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 h-7 px-2 text-xs"
                            onClick={(e) => { e.stopPropagation(); selectSweepCity(m); }}
                            data-testid={`button-open-market-${mi}`}
                            title="Drill into just this market in Step 2"
                          >
                            Open in Step 2 <ArrowRight className="h-3.5 w-3.5 ml-1" />
                          </Button>
                        )}
                      </div>

                      {/* Resort breakdown for this market — tick resorts to bulk-queue */}
                      {showResortBreakdown && (
                        <div className="mt-3 border-t pt-2.5 space-y-1.5">
                          {marketResorts.map((c, ci) => {
                            // Render each resort ONCE: skip any that surfaced first
                            // under an earlier city (listed in the "also found here"
                            // note below instead of a second selectable checkbox).
                            if (!ownsResort(ci)) return null;
                            const selKey = `${mi}:${ci}`;
                            const elig = checkCommunityType(c.unitTypes, c.researchSummary);
                            const checked = sweepResortSelection.has(selKey);
                            const comboLabel = formatTypicalComboLabel(inferTypicalComboPair(c));
                            const alreadyQueued = (c.existingComboLabels?.length || c.reservedComboLabels?.length) ? true : false;
                            // True when we already have a listing/draft (or a queued combo) in this
                            // resort — surfaced as an icon next to the combo badge so the operator
                            // can see at a glance which resorts they already cover.
                            const hasListing = c.hasExistingListing === true || alreadyQueued;
                            const listingTooltip = `You already have a listing in this resort${
                              c.existingComboLabels?.length ? ` — ${c.existingComboLabels.join(", ")} built` : ""
                            }${
                              c.reservedComboLabels?.length ? ` · ${c.reservedComboLabels.join(", ")} queued` : ""
                            }`;
                            // Ticking is enabled only once the WHOLE sweep is done — until
                            // then a finished market's resorts render as a read-only preview
                            // (the queue footer that acts on them doesn't exist yet either).
                            const selectable = elig.eligible && sweepDone;
                            return (
                              <label
                                key={`${selKey}-${c.name}`}
                                className={`flex items-start gap-2 rounded border px-2 py-1.5 text-xs transition-colors ${
                                  !elig.eligible
                                    ? "opacity-60 cursor-not-allowed border-dashed bg-muted/20"
                                    : !selectable
                                      ? "border-muted bg-muted/10"
                                      : checked
                                        ? "border-primary bg-primary/5 cursor-pointer"
                                        : "cursor-pointer hover:border-muted-foreground/40"
                                }`}
                                title={!elig.eligible ? (elig.reason ?? "Only condo/townhome communities are supported") : !sweepDone ? "Available to select once the whole sweep finishes" : undefined}
                              >
                                <input
                                  type="checkbox"
                                  className="accent-primary mt-0.5"
                                  checked={checked}
                                  disabled={!selectable}
                                  onChange={() => toggleSweepResort(selKey)}
                                  data-testid={`checkbox-sweep-resort-${mi}-${ci}`}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-medium text-foreground">{c.name}</span>
                                    {typeof c.combinabilityScore === "number" && (
                                      <span
                                        className={`inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold ${
                                          c.combinabilityScore >= 70 ? "bg-green-600 text-white"
                                          : c.combinabilityScore >= 50 ? "bg-amber-500 text-white"
                                          : "bg-red-500 text-white"
                                        }`}
                                      >
                                        <BedDouble className="h-2.5 w-2.5 mr-0.5" />
                                        {c.combinabilityScore}{comboLabel}
                                      </span>
                                    )}
                                    {hasListing && (
                                      <span
                                        className="inline-flex items-center rounded bg-blue-600 px-1 py-0.5 text-[10px] font-semibold text-white"
                                        title={listingTooltip}
                                        data-testid={`badge-sweep-existing-listing-${mi}-${ci}`}
                                      >
                                        <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                                        Listed
                                      </span>
                                    )}
                                    {!elig.eligible && (
                                      <span className="inline-flex items-center rounded border border-red-300 bg-red-50 px-1 py-0.5 text-[10px] text-red-700">
                                        Not supported
                                      </span>
                                    )}
                                  </span>
                                  <span className="mt-0.5 block text-muted-foreground">
                                    {c.bedroomMix && <span className="italic">{c.bedroomMix} · </span>}
                                    {(c.estimatedLowRate || c.estimatedHighRate)
                                      ? `resort est. ${formatComboRange(c.estimatedLowRate, c.estimatedHighRate)}`
                                      : c.unitTypes}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                          {/* Resorts this city also returned but that are shown
                              under the first city that surfaced them — so each
                              resort appears (and is selectable) exactly once. */}
                          {movedResorts.length > 0 && (() => {
                            const movedNames = Array.from(new Set(movedResorts.map((r) => r.name).filter(Boolean)));
                            const ownerCities = Array.from(new Set(movedResorts.map((r) => r.shownUnderCity).filter(Boolean)));
                            const whereShown = ownerCities.length === 1
                              ? ` — shown under ${ownerCities[0]} to avoid a duplicate.`
                              : " — shown under the earlier cities that found them first, to avoid duplicates.";
                            return (
                              <p
                                className="text-[11px] italic text-muted-foreground pt-0.5"
                                data-testid={`text-sweep-moved-resorts-${mi}`}
                              >
                                {movedNames.length === 1 ? "Also found here: " : `Also found here (${movedNames.length}): `}
                                {movedNames.join(", ")}
                                {whereShown}
                              </p>
                            );
                          })()}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
              )}

              {/* ── Cross-market resort queue footer (done phase) ── */}
              {sweepPhase === "running" && sweepDone && (() => {
                const uniqueSelected = sweepSelectedCommunities.length;
                const rawSelected = sweepResortSelection.size;
                const collapsed = rawSelected - uniqueSelected;
                const marketsTouched = new Set(
                  Array.from(sweepResortSelection).map((k) => k.split(":")[0]),
                ).size;
                const queueLabel = sweepQueueStarting
                  ? "Queuing…"
                  : `Queue ${Math.min(uniqueSelected, BULK_COMBO_BATCH_MAX)} selected resort${uniqueSelected === 1 ? "" : "s"} (best combo each)`;
                return (
                  <div className="mt-4 space-y-2 border-t pt-3">
                    <div className="text-xs text-muted-foreground">
                      Tick resorts under any market to bulk-queue them, or use <span className="font-medium">Open in Step 2</span> to drill into one market.
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={selectAllEligibleSweepResorts}>
                        Select all eligible
                      </Button>
                      <Button size="sm" variant="outline" onClick={clearSweepResorts} disabled={rawSelected === 0}>
                        Clear
                      </Button>
                      <Button size="sm" variant="outline" onClick={resetSweepToMarketPicker}>
                        ← Scan different markets
                      </Button>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {uniqueSelected} resort{uniqueSelected === 1 ? "" : "s"} selected
                        {marketsTouched > 0 ? ` across ${marketsTouched} market${marketsTouched === 1 ? "" : "s"}` : ""}
                        {collapsed > 0 ? ` · ${collapsed} duplicate collapsed` : ""}
                      </span>
                    </div>
                    {uniqueSelected > BULK_COMBO_BATCH_MAX && !sweepQueueStarting && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                        Up to {BULK_COMBO_BATCH_MAX} resorts queue per batch — the first {BULK_COMBO_BATCH_MAX} start now and run entirely on the server (safe to leave), and the remaining {uniqueSelected - BULK_COMBO_BATCH_MAX} queue automatically when this batch finishes (keep this page open for the hand-off).
                      </div>
                    )}
                    <Button
                      className="w-full sm:w-auto"
                      onClick={queueSelectedSweepResorts}
                      disabled={uniqueSelected === 0 || sweepQueueStarting}
                      data-testid="button-queue-sweep-resorts"
                    >
                      {sweepQueueStarting ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4 mr-2" />
                      )}
                      {queueLabel}
                    </Button>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {bulkComboOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeBulkComboQueue();
            }}
          >
            <div
              className="max-h-[calc(100vh-1rem)] w-full max-w-4xl overflow-y-auto rounded-lg bg-background p-3 shadow-xl sm:max-h-[90vh] sm:p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Plus className="h-5 w-5 text-primary" />
                    Bulk combo listing queue
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Creates dashboard drafts one at a time: unit photos, listing copy, draft save, photo persistence, and pricing refresh.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {bulkComboJob?.failed ? (
                    <Button variant="outline" size="sm" onClick={retryFailedBulkComboListings}>
                      Retry failed only
                    </Button>
                  ) : null}
                  {bulkComboJob && !["completed", "failed", "cancelled"].includes(bulkComboJob.status) && (
                    <Button variant="destructive" size="sm" onClick={cancelBulkComboListings}>Cancel</Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={closeBulkComboQueue}
                  >
                    Close
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={closeBulkComboQueue}
                    aria-label="Close bulk combo listing queue"
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {!bulkComboJob ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {bulkComboStarting ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                      Starting queue…
                    </>
                  ) : (
                    "No bulk queue is active."
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {visibleBulkComboItems.some(({ item }) => item.status === "running" && item.heartbeatAt && Date.now() - new Date(item.heartbeatAt).getTime() > 5 * 60_000) && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      One running item has not heartbeated in more than 5 minutes. The server will clean it up if the lease expires; use Retry failed only after it turns failed.
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-md border p-2">
                      <p className="text-xs text-muted-foreground">Status</p>
                      <p className="text-sm font-semibold capitalize">
                        {visibleBulkComboJobs.length > 1 ? `${visibleBulkComboJobs.length} active jobs` : bulkComboJob.status}
                      </p>
                    </div>
                    <div className="rounded-md border p-2">
                      <p className="text-xs text-muted-foreground">Completed</p>
                      <p className="text-sm font-semibold">{visibleBulkComboCompleted} / {visibleBulkComboItems.length}</p>
                    </div>
                    <div className="rounded-md border p-2">
                      <p className="text-xs text-muted-foreground">Failed</p>
                      <p className="text-sm font-semibold">{visibleBulkComboFailed}</p>
                    </div>
                    <div className="rounded-md border p-2">
                      <p className="text-xs text-muted-foreground">Cancelled</p>
                      <p className="text-sm font-semibold">{visibleBulkComboCancelled}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <div className="rounded-md border bg-muted/30 p-2">
                      <span className="font-medium text-foreground">Items:</span>{" "}
                      {visibleBulkComboRunning} running, {visibleBulkComboQueued} queued
                    </div>
                    <div className="rounded-md border bg-muted/30 p-2">
                      <span className="font-medium text-foreground">Last heartbeat:</span>{" "}
                      {bulkComboJob.updatedAt ? new Date(bulkComboJob.updatedAt).toLocaleTimeString() : "None yet"}
                    </div>
                    <div className="rounded-md border bg-muted/30 p-2">
                      <span className="font-medium text-foreground">Worker lease:</span>{" "}
                      {bulkComboJob.lockExpiresAt ? `until ${new Date(bulkComboJob.lockExpiresAt).toLocaleTimeString()}` : "Not locked"}
                    </div>
                  </div>

                  <div className="max-h-96 overflow-y-auto rounded-md border">
                    {visibleBulkComboItems.map(({ job, item }) => {
                      const tone =
                        item.status === "completed" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : item.status === "failed" ? "bg-red-50 text-red-700 border-red-200"
                        : item.status === "cancelled" ? "bg-slate-50 text-slate-600 border-slate-200"
                        : item.status === "running" ? "bg-blue-50 text-blue-700 border-blue-200"
                        : "bg-amber-50 text-amber-700 border-amber-200";
                      const progressValue = typeof item.progressPercent === "number"
                        ? Math.min(100, Math.max(0, Math.round(item.progressPercent)))
                        : bulkComboProgressPercent(item);
                      const etaLabel = typeof item.etaSeconds === "number"
                        ? formatBulkComboEta(item.etaSeconds * 1000)
                        : formatBulkComboEta(bulkComboRemainingMs(item, { queueAhead: bulkComboQueueAhead(job, item.id) }));
                      const showProgress = item.status === "running" || item.status === "queued" || item.status === "completed";
                      return (
                        <div key={`${job.id}:${item.id}`} className="border-b px-3 py-3 last:border-b-0">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{item.label}</p>
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                {item.message || item.error || "Waiting for its turn"}
                              </p>
                              {showProgress && (
                                <div className="mt-2 space-y-1">
                                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                    <span>{progressValue}%</span>
                                    {etaLabel ? <span className="shrink-0 tabular-nums">{etaLabel}</span> : null}
                                  </div>
                                  <Progress value={progressValue} className="h-1.5" />
                                </div>
                              )}
                              <p className="mt-1.5 text-[11px] text-muted-foreground">
                                Phase: {item.phase || "queued"} · attempts {item.attemptCount ?? 0}
                                {item.heartbeatAt ? ` · heartbeat ${new Date(item.heartbeatAt).toLocaleTimeString()}` : ""}
                                {visibleBulkComboJobs.length > 1 ? ` · job ${job.id}` : ""}
                              </p>
                              {item.draftId && (
                                <p className="mt-0.5 text-xs text-emerald-700">Saved as dashboard draft #{item.draftId}</p>
                              )}
                              {(item.unit1Photos || item.unit2Photos || item.status === "running" || item.status === "completed") && (
                                <p className="mt-0.5 text-[11px] text-muted-foreground">
                                  Photos — Unit A: <span className="tabular-nums">{item.unit1Photos?.length ?? 0}</span>
                                  {" · "}Unit B: <span className="tabular-nums">{item.unit2Photos?.length ?? 0}</span>
                                  {item.unit2PhotosReused ? " (reused from Unit A)" : ""}
                                </p>
                              )}
                              {item.remixApplied && item.effectiveUnit1Beds && item.effectiveUnit2Beds && (
                                <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-sm border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                  🔀 Re-mixed{item.pairing ? ` ${item.pairing.unit1Beds}BR+${item.pairing.unit2Beds}BR` : ""} → {item.effectiveUnit1Beds}BR+{item.effectiveUnit2Beds}BR for a distinct 2nd unit
                                </span>
                              )}
                              {item.unit2PhotosReused && !item.remixApplied && (
                                <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                  ♻︎ Reused Unit A photos for Unit B
                                </span>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <Badge variant="outline" className={`capitalize ${tone}`}>
                                {item.status === "running" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                                {item.status}
                              </Badge>
                            </div>
                          </div>
                          {item.error && <p className="mt-1 text-xs text-red-700">{item.error}</p>}
                          {item.status === "failed" && (
                            <div className="mt-2">
                              <OperationFailureActions
                                jobType="bulk-combo-listing"
                                jobId={job.id}
                                itemKey={item.id}
                                onRemediated={async () => {
                                  if (!bulkComboJobId) return;
                                  try {
                                    const resp = await fetch(
                                      `/api/community/bulk-combo-listing-jobs/${encodeURIComponent(bulkComboJobId)}`,
                                      { credentials: "include" },
                                    );
                                    if (resp.ok) {
                                      const data = await resp.json();
                                      if (data.job) setBulkComboJob(data.job);
                                      if (Array.isArray(data.events)) setBulkComboEvents(data.events);
                                    }
                                  } catch { /* poll will catch up */ }
                                }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="rounded-md border">
                    <div className="border-b px-3 py-2">
                      <p className="text-sm font-semibold">Queue event history</p>
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {bulkComboEvents.length === 0 ? (
                        <p className="px-3 py-3 text-xs text-muted-foreground">No structured events recorded yet.</p>
                      ) : bulkComboEvents.slice(0, 20).map((event) => (
                        <div key={event.id} className="border-b px-3 py-2 last:border-b-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={`text-xs ${event.level === "error" ? "text-red-700" : event.level === "warn" ? "text-amber-700" : "text-muted-foreground"}`}>
                              <span className="font-medium text-foreground">{event.phase}</span>
                              {event.itemKey ? ` · ${event.itemKey}` : ""} — {event.message}
                            </p>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {new Date(event.createdAt).toLocaleTimeString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {["completed", "failed", "cancelled"].includes(bulkComboJob.status) && (
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setBulkComboJob(null);
                          setBulkComboJobId(null);
                          setBulkPairingIndexes(new Set());
                        }}
                      >
                        Clear queue
                      </Button>
                      <Link href="/">
                        <Button>Go to Dashboard</Button>
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── STEP 2: Research results ──────────────────────── */}
        {step === 2 && (
          <div id="step-2-content">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Search className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-2-heading">Step 2: Community Research</h2>
              </div>
              <Button className="w-full sm:w-auto" variant="outline" size="sm" onClick={() => setStep(1)} data-testid="button-back-step1" id="btn-prev-step" aria-label="Go back to Step 1: Select Location">
                <ArrowLeft className="h-4 w-4 mr-1" /> Change Location
              </Button>
            </div>
            <div id="summary-panel" className="mb-4 break-words rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              <strong>Location:</strong> {cityInput}, {selectedState} — <strong>{communities.length}</strong> communities found. Select one to continue.
              {researchHistory && (
                <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                  <CalendarDays className="h-3.5 w-3.5" />
                  <strong>Last searched:</strong> {formatResearchHistoryTime(researchHistory.lastSearchedAt)} — yielded {researchHistory.resultCount} communities
                  {researchHistoryNames.length > 0 ? ` (${researchHistoryNames.join(", ")}${researchHistory.resultNames.length > researchHistoryNames.length ? "…" : ""})` : ""}
                </div>
              )}
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {bulkCommunityIndexes.size > 0 && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => queueBestCombosForCommunities(Array.from(bulkCommunityIndexes))}
                    disabled={bulkComboStarting}
                    data-testid="button-bulk-queue-communities"
                  >
                    {bulkComboStarting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                    Queue {bulkCommunityIndexes.size} selected (best combo each)
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setBulkCommunityIndexes(new Set())}>
                    Clear selection
                  </Button>
                </>
              )}
              {communities.length > 0 && bulkCommunityIndexes.size === 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setBulkCommunityIndexes(new Set(
                    // Don't tick resorts already in the system — bulk-add skips them.
                    communities.map((c, i) => (resortAlreadyInSystem(c) ? -1 : i)).filter((i) => i >= 0),
                  ))}
                  data-testid="button-select-all-communities-bulk"
                >
                  Select all for bulk queue
                </Button>
              )}
            </div>
            <p className="text-muted-foreground text-sm mb-4">
              Found {communities.length} qualifying communities in <strong>{cityInput}, {selectedState}</strong>. Click a card to select it. Use checkboxes to multi-queue best combos.
            </p>
            <div className="grid grid-cols-1 gap-4">
              {communities.map((c, i) => {
                const qs = estimateNewCommunityScore({
                  state: c.state,
                  city: c.city,
                  estimatedLowRate: c.estimatedLowRate,
                  estimatedHighRate: c.estimatedHighRate,
                  unitTypes: c.unitTypes,
                  confidenceScore: c.confidenceScore,
                });
                const typeCheck = checkCommunityType(c.unitTypes, c.researchSummary);
                const resortUnitMix = formatResortUnitMix(c);
                const minimumStay = formatMinimumStay(c);
                const selectCommunity = () => {
                  if (!typeCheck.eligible) {
                    toast({
                      title: "Not a supported community type",
                      description: typeCheck.reason ?? "Only condo or townhome communities can be added.",
                      variant: "destructive",
                    });
                    return;
                  }
                  handleSelectCommunity(c);
                };
                return (
                <Card
                  key={i}
                  className={
                    typeCheck.eligible
                      ? "p-4 cursor-pointer hover:border-primary transition-colors"
                      : "p-4 opacity-60 cursor-not-allowed bg-muted/30 border-dashed"
                  }
                  role="button"
                  tabIndex={typeCheck.eligible ? 0 : -1}
                  onClick={selectCommunity}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectCommunity();
                    }
                  }}
                  data-testid={`card-community-${i}`}
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <label
                          className="flex items-center"
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={bulkCommunityIndexes.has(i)}
                            onChange={() => toggleBulkCommunity(i)}
                            className="accent-primary h-4 w-4 mr-1.5"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`checkbox-bulk-community-${i}`}
                          />
                        </label>
                        <h3 className="font-semibold text-base" data-testid={`text-community-name-${i}`}>{c.name}</h3>
                        {!typeCheck.eligible && (
                          <Badge variant="outline" className="text-[10px] border-red-400 text-red-700 bg-red-50">
                            <ShieldX className="h-3 w-3 mr-1" />
                            Not supported — {typeCheck.matchedDisqualifier ?? "condo/townhome only"}
                          </Badge>
                        )}
                        <Badge variant={c.confidenceScore >= 75 ? "default" : c.confidenceScore >= 50 ? "secondary" : "outline"}>
                          <Star className="h-3 w-3 mr-1" />
                          {c.confidenceScore}/100 confidence
                        </Badge>
                        {typeof c.combinabilityScore === "number" && (
                          <Badge
                            className={
                              c.combinabilityScore >= 70 ? "bg-green-600 text-white"
                              : c.combinabilityScore >= 50 ? "bg-amber-500 text-white"
                              : "bg-red-500 text-white"
                            }
                            data-testid={`badge-combinability-${i}`}
                          >
                            <BedDouble className="h-3 w-3 mr-1" />
                            Combinability {c.combinabilityScore}
                            {formatTypicalComboLabel(inferTypicalComboPair(c))}
                          </Badge>
                        )}
                        {c.fromWorldKnowledge && (
                          <Badge variant="outline" className="text-[10px] border-blue-300 text-blue-700">
                            From AI knowledge
                          </Badge>
                        )}
                        {c.hasExistingListing && (
                          <Badge className="bg-blue-600 text-white border-blue-700 text-[10px]">
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Already in system
                          </Badge>
                        )}
                        {(c.existingComboLabels?.length || c.reservedComboLabels?.length) ? (
                          <Badge variant="outline" className="text-[10px] border-blue-300 text-blue-700 bg-blue-50">
                            Existing: {[...(c.existingComboLabels ?? []), ...(c.reservedComboLabels ?? []).map((label) => `${label} queued`)].join(", ")}
                          </Badge>
                        ) : null}
                        {typeCheck.eligible && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[10px] border-primary/40 hover:bg-primary/5"
                            onClick={(e) => { e.stopPropagation(); quickQueueBestCombo(c); }}
                            data-testid={`button-quick-combo-${i}`}
                            title="Auto-pick best unused combo type and queue for bulk listing (no manual steps)"
                          >
                            ⚡ Best combo
                          </Button>
                        )}
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-semibold cursor-help ${gradeBg(qs.grade)}`}
                                data-testid={`badge-quality-community-${i}`}
                                onClick={e => e.stopPropagation()}
                              >
                                <TrendingUp className={`h-3 w-3 ${gradeColor(qs.grade)}`} />
                                <span className={gradeColor(qs.grade)}>{qs.total}</span>
                                <span className="text-muted-foreground font-normal">/10</span>
                                <span className={`font-bold ${gradeColor(qs.grade)}`}>{qs.grade}</span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="w-64 p-3">
                              <p className="font-semibold mb-2 flex items-center gap-1.5">
                                <TrendingUp className="h-3.5 w-3.5" />
                                Estimated Quality Score
                              </p>
                              <p className="text-xs text-muted-foreground mb-2">
                                Based on location, estimated rates, and unit configuration. Refines as more data is gathered.
                              </p>
                              <div className="space-y-1.5 text-xs">
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Market Value Gap</span>
                                  <span className="font-medium">{qs.marketDiscount.toFixed(1)} / 4</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Profit Margin</span>
                                  <span className="font-medium">{qs.profitMargin.toFixed(1)} / 2</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Location Demand</span>
                                  <span className="font-medium">{qs.locationDemand.toFixed(1)} / 2</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Group Scarcity</span>
                                  <span className="font-medium">{qs.groupScarcity.toFixed(1)} / 1</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Unit Pairing</span>
                                  <span className="font-medium">{qs.unitMatch.toFixed(1)} / 1</span>
                                </div>
                                <div className="border-t pt-1.5 mt-1.5 text-muted-foreground space-y-0.5">
                                  <div className="flex justify-between">
                                    <span>Est. standalone market rate</span>
                                    <span>${qs.marketRate.toLocaleString()}/night</span>
                                  </div>
                                  {qs.discountPct > 0 && (
                                    <div className="flex justify-between">
                                      <span>Projected savings vs market</span>
                                      <span className="text-emerald-600 font-medium">{qs.discountPct}% cheaper</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <p className="text-sm text-muted-foreground mb-2">
                        <MapPin className="h-3.5 w-3.5 inline mr-1" />{c.city}, {c.state} · {c.unitTypes}
                        {c.bedroomMix && <span className="ml-1 italic">({c.bedroomMix})</span>}
                      </p>
                      {resortUnitMix && (
                        <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                          <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                          <span><span className="font-medium text-foreground">Resort size:</span> {resortUnitMix}</span>
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span>
                          <span className="font-medium text-foreground">Min stay:</span>{" "}
                          <span
                            className={
                              minimumStay.tone === "warn" ? "text-amber-700 font-medium"
                              : minimumStay.tone === "ok" ? "text-emerald-700 font-medium"
                              : "text-muted-foreground"
                            }
                          >
                            {minimumStay.label}
                          </span>
                          {minimumStay.evidence ? ` · ${minimumStay.evidence}` : ""}
                        </span>
                      </p>
                      <p className="text-sm">{c.researchSummary}</p>
                      {(c.estimatedLowRate || c.estimatedHighRate) && (
                        <p className="text-sm font-medium text-green-600 mt-1">
                          <DollarSign className="h-3.5 w-3.5 inline" />
                          {c.estimatedLowRate && `$${c.estimatedLowRate}`}
                          {c.estimatedLowRate && c.estimatedHighRate && " – "}
                          {c.estimatedHighRate && `$${c.estimatedHighRate}`}/night est.
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                      {c.sourceUrl && (
                        <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                          <Button variant="ghost" size="sm"><ExternalLink className="h-4 w-4" /></Button>
                        </a>
                      )}
                      <Button
                        className="flex-1 sm:flex-none"
                        size="sm"
                        disabled={!typeCheck.eligible}
                        onClick={(e) => {
                          e.stopPropagation();
                          selectCommunity();
                        }}
                        data-testid={`button-select-community-${i}`}
                      >
                        {typeCheck.eligible ? "Select" : "Not supported"} <ArrowRight className="h-4 w-4 ml-1" />
                      </Button>
                    </div>
                  </div>
                </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* ── STEP 3: Community overview + pairing suggestions ── */}
        {step === 3 && (
          <div id="step-3-content">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-3-heading">Step 3: Select Unit Combination</h2>
              </div>
              <Button className="w-full sm:w-auto" variant="outline" size="sm" onClick={() => setStep(2)} data-testid="button-back-step2" id="btn-prev-step" aria-label="Go back to Step 2">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
            </div>

            {/* Community header card */}
            {selectedCommunity && (
              <div className="mb-6 p-4 rounded-xl border bg-muted/30">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-base">{selectedCommunity.name}</h3>
                      <Badge variant="secondary" className="text-xs">Vacation Rental Community</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      <MapPin className="h-3.5 w-3.5 inline mr-1" />
                      {selectedCommunity.city}, {selectedCommunity.state} · {selectedCommunity.unitTypes}
                    </p>
                    {selectedCommunity.researchSummary && (
                      <p className="text-sm mt-1">{selectedCommunity.researchSummary}</p>
                    )}
                    {communityProfile && (
                      <div className="mt-2 flex flex-col gap-1 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
                        {communityProfile.airbnbListingCount > 0 && (
                          <span className="text-muted-foreground">
                            <CheckCircle2 className="h-3.5 w-3.5 inline mr-1 text-green-600" />
                            {communityProfile.airbnbListingCount} active listings found on Airbnb/VRBO
                          </span>
                        )}
                        {communityProfile.availableTypes.length > 0 && (
                          <span className="text-muted-foreground">
                            Unit configs: {communityProfile.availableTypes.map(t => `${t}BR`).join(", ")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {communityProfile?.comboInventory && communityProfile.comboInventory.length > 0 && (
              <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50/60 p-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold text-blue-950">Existing community inventory</p>
                    <p className="text-xs text-blue-800">The next best combo picker skips these by default.</p>
                  </div>
                  {communityProfile.allCombosUsed && (
                    <Badge className="bg-amber-500 text-white border-0">All suggested combos used</Badge>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {communityProfile.comboInventory.map((item, index) => (
                    <Badge
                      key={`${item.source}-${item.key}-${item.draftId ?? item.jobId ?? index}`}
                      variant="outline"
                      className={item.source === "reserved" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-blue-300 bg-white text-blue-800"}
                    >
                      {item.label}
                      {item.source === "reserved" ? " queued" : item.draftId ? ` · Draft #${item.draftId}` : ""}
                    </Badge>
                  ))}
                </div>
                {suggestedPairings.some(isPairingAvailable) ? (
                  <p className="mt-2 text-xs text-blue-900">
                    Next unused: {(() => {
                      const next = pickBestAvailableComboPairing(suggestedPairings);
                      return next ? `${next.unit1Beds}+${next.unit2Beds}BR` : "None";
                    })()}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-amber-900">
                    No unused combo type remains. Use Queue duplicate anyway on a pairing only if you intentionally want another listing with the same bedroom mix.
                  </p>
                )}
              </div>
            )}

            {unitSearchLoading && (
              <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-sm font-medium">Analyzing community listings on Airbnb & VRBO…</p>
                <p className="text-xs">Generating algorithm-suggested unit combinations</p>
              </div>
            )}

            {!unitSearchLoading && suggestedPairings.length > 0 && (
              <>
                {bulkComboHistory.some((job) => job.status === "queued" || job.status === "running") && (
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                    <span>
                      {bulkComboHistory.filter((job) => job.status === "queued" || job.status === "running").length} background combo queue is active.
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const active = bulkComboHistory.find((job) => job.status === "queued" || job.status === "running");
                        if (active) {
                          setBulkComboJob(active);
                          setBulkComboJobId(active.id);
                        }
                        setBulkComboOpen(true);
                      }}
                    >
                      Resume queue
                    </Button>
                  </div>
                )}
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-sm">Algorithm-Suggested Combinations</h3>
                  <Badge variant="outline" className="text-xs ml-auto">Select one to continue</Badge>
                </div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 p-3 text-sm">
                  <span className="text-muted-foreground">
                    Select multiple combinations to schedule dashboard drafts in the background.
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setBulkPairingIndexes(new Set(suggestedPairings.map((pairing, index) => isPairingAvailable(pairing) ? index : -1).filter((index) => index >= 0)))}
                    >
                      Select available
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setBulkPairingIndexes(new Set())}
                      disabled={bulkPairingIndexes.size === 0}
                    >
                      Clear
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={startBulkComboListings}
                      disabled={bulkComboStarting || bulkPairingIndexes.size === 0}
                      data-testid="button-start-bulk-combo-listings"
                    >
                      {bulkComboStarting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                      Schedule {bulkPairingIndexes.size || ""} draft{bulkPairingIndexes.size === 1 ? "" : "s"}
                    </Button>
                  </div>
                </div>

                <div className="space-y-3 mb-6">
                  {suggestedPairings.map((p, i) => {
                    const isSelected = selectedPairing?.unit1Beds === p.unit1Beds && selectedPairing?.unit2Beds === p.unit2Beds;
                    const isBulkSelected = bulkPairingIndexes.has(i);
                    const pairingKey = comboKeyForPairing(p);
                    const isAvailable = isPairingAvailable(p);
                    const duplicateAllowed = duplicateOverrideKeys.has(pairingKey);
                    const isBlocked = !isAvailable && !duplicateAllowed;
                    const buyCost = p.estimatedUnit1Rate + p.estimatedUnit2Rate;
                    const profit = p.estimatedSellRate - buyCost;
                    return (
                      <div
                        key={i}
                        onClick={() => handleSelectPairing(p)}
                        className={`relative p-4 rounded-xl border-2 cursor-pointer transition-all ${
                          isSelected
                            ? "border-primary bg-primary/5 shadow-sm"
                            : isBlocked
                              ? "border-amber-200 bg-amber-50/40"
                            : "border-border hover:border-primary/40 hover:bg-muted/30"
                        }`}
                        data-testid={`card-pairing-${i}`}
                      >
                        <label
                          className="absolute top-3 left-3 z-10 flex items-center gap-1.5 rounded-md border bg-background/90 px-2 py-1 text-xs shadow-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={isBulkSelected}
                            disabled={isBlocked}
                            onChange={() => toggleBulkPairing(i)}
                            className="accent-primary"
                            data-testid={`checkbox-bulk-pairing-${i}`}
                          />
                          Queue
                        </label>
                        {p.isTopPick && (
                          <div className="absolute -top-2.5 left-24">
                            <Badge className="text-xs bg-amber-500 hover:bg-amber-500 text-white border-0 gap-1">
                              <Star className="h-3 w-3" /> Algorithm Top Pick
                            </Badge>
                          </div>
                        )}
                        {p.alreadyExists && (
                          <div className="absolute -top-2.5 right-3">
                            <Badge className={`text-xs text-white border-0 ${p.availability === "reserved" ? "bg-blue-600" : "bg-amber-500"}`}>
                              {p.availability === "reserved" ? "Reserved in queue" : "Already built"}
                            </Badge>
                          </div>
                        )}
                        {isSelected && (
                          <div className="absolute top-3 right-3">
                            <CheckCircle2 className="h-5 w-5 text-primary" />
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-8 sm:pt-5">
                          {/* Unit combo */}
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1.5">
                              <span className="w-7 h-7 rounded-md bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">{p.unit1Beds}BR</span>
                              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="w-7 h-7 rounded-md bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">{p.unit2Beds}BR</span>
                              <span className="text-muted-foreground text-xs mx-1">=</span>
                              <span className="w-9 h-7 rounded-md bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">{p.totalBeds}BR</span>
                            </div>
                            <span className="text-sm text-muted-foreground">combined listing</span>
                          </div>

                          {/* Estimated sell price */}
                          <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground">Est. sell price</span>
                            <span className="font-semibold text-green-600 text-base">
                              ${p.estimatedSellRate.toLocaleString()}–${p.estimatedSellRateHigh.toLocaleString()}<span className="text-xs font-normal text-muted-foreground">/night</span>
                            </span>
                          </div>

                          {/* Buy-in cost */}
                          <div className="flex flex-col">
                            <span
                              className="text-xs text-muted-foreground"
                              title="Amortized over a 7-night stay so cleaning + service fees are diluted across the week, not a single night"
                            >
                              Est. buy-in cost <span className="text-[10px]">(7-night avg)</span>
                            </span>
                            <span className="font-medium text-sm">
                              ${p.estimatedUnit1Rate.toLocaleString()} + ${p.estimatedUnit2Rate.toLocaleString()}<span className="text-xs font-normal text-muted-foreground">/night</span>
                            </span>
                          </div>

                          {/* Margin */}
                          {profit > 0 && (
                            <div className="flex flex-col">
                              <span className="text-xs text-muted-foreground">Est. margin</span>
                              <span className="font-semibold text-emerald-600 text-sm">+${profit.toLocaleString()}/night</span>
                            </div>
                          )}
                        </div>

                        {/* Rationale */}
                        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{p.rationale}</p>
                        {!isAvailable && (
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-white/70 px-3 py-2 text-xs text-amber-900">
                            <span>{p.duplicateReason || "This combo type is already used for this community."}</span>
                            {!duplicateAllowed ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs border-amber-300 text-amber-900 hover:bg-amber-50"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDuplicateOverrideKeys((prev) => new Set(prev).add(pairingKey));
                                  setBulkPairingIndexes((prev) => new Set(prev).add(i));
                                  handleSelectPairing({ ...p, availability: "available", alreadyExists: false, reserved: false, duplicateReason: null });
                                }}
                              >
                                Queue duplicate anyway
                              </Button>
                            ) : (
                              <Badge variant="outline" className="border-amber-300 text-amber-800">Duplicate override enabled</Badge>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {selectedPairing && (
                  <Button
                    className="w-full sm:w-auto"
                    onClick={handleConfirmUnits}
                    data-testid="button-confirm-units"
                    id="btn-next-step"
                  >
                    Confirm {selectedPairing.unit1Beds}BR + {selectedPairing.unit2Beds}BR Combination & Continue
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                )}
              </>
            )}

            {!unitSearchLoading && suggestedPairings.length === 0 && unitSearchResults && (
              <div className="text-center py-12 text-muted-foreground">
                <Building2 className="h-12 w-12 mx-auto mb-3 opacity-20" />
                <p className="font-medium">No pairing data available</p>
                <p className="text-sm mt-1">The algorithm couldn't find enough rate data for this community.</p>
              </div>
            )}

            {!unitSearchLoading && selectedCommunity && !unitSearchResults && suggestedPairings.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <Building2 className="h-12 w-12 mx-auto mb-3 opacity-20" />
                <p className="font-medium">Pairing analysis needs to run again</p>
                <p className="text-sm mt-1 mb-4">This saved draft restored before unit combinations were generated.</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleSelectCommunity(selectedCommunity)}
                  data-testid="button-retry-unit-pairing"
                >
                  <Search className="h-4 w-4 mr-2" />
                  Retry pairing analysis
                </Button>
              </div>
            )}
          </div>
        )}

        {/* ── STEP 4: Photos + platform check ──────────────── */}
        {step === 4 && (
          <div id="step-4-content">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Camera className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-4-heading">Step 4: Photos & Platform Check</h2>
              </div>
              <Button className="w-full sm:w-auto" variant="outline" size="sm" onClick={() => setStep(3)} data-testid="button-back-step3" id="btn-prev-step" aria-label="Go back to Step 3: Select Unit Pair">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
            </div>
            <div id="summary-panel" className="mb-4 break-words rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              <strong>Community:</strong> {selectedCommunity?.name} — <strong>Unit 1:</strong> {selectedUnit1?.title} — <strong>Unit 2:</strong> {selectedUnit2?.title}.{" "}
              {unit1Photos.length + unit2Photos.length > 0 ? `${unit1Photos.length + unit2Photos.length} photos loaded.` : photosLoading ? "Loading photos…" : "No photos loaded."}
              {Object.values(photoChecks).filter(v => v !== "checking" && !(v as PhotoCheckResult).clean).length > 0 &&
                ` ${Object.values(photoChecks).filter(v => v !== "checking" && !(v as PhotoCheckResult).clean).length} flagged photos.`}
            </div>

            {photosLoading && (
              (() => {
                const item = photoFetchJob?.items?.[0];
                const progressValue = Math.min(100, Math.max(5, Math.round(item?.progressPercent ?? (photoFetchJobId ? 12 : 8))));
                const heartbeat = item?.heartbeatAt;
                const heartbeatAgeSeconds = heartbeat
                  ? Math.max(0, Math.round((Date.now() - new Date(heartbeat).getTime()) / 1000))
                  : null;
                const heartbeatIsStale = heartbeatAgeSeconds != null && heartbeatAgeSeconds > 120;
                return (
                  <div className="flex flex-col items-center gap-4 py-10 justify-center text-muted-foreground">
                    <div className="w-full max-w-xl rounded-lg border bg-background p-4 shadow-sm">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {item?.message || "Fetching photos from Zillow listing pages…"}
                            </p>
                            <p className="text-xs capitalize text-muted-foreground">
                              {item?.phase ? `Phase: ${item.phase}` : "Preparing photo search"}
                            </p>
                          </div>
                        </div>
                        <span className="shrink-0 text-sm font-semibold text-foreground">{progressValue}%</span>
                      </div>
                      <Progress value={progressValue} className="h-2" />
                      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                        <div className="rounded-md bg-muted/50 px-2 py-1.5">
                          Unit A photos: <span className="font-medium text-foreground">{unit1Photos.length}</span>
                        </div>
                        <div className="rounded-md bg-muted/50 px-2 py-1.5">
                          Unit B photos: <span className="font-medium text-foreground">{unit2Photos.length}</span>
                        </div>
                        <div className="rounded-md bg-muted/50 px-2 py-1.5">
                          Heartbeat: <span className="font-medium text-foreground">{heartbeatAgeSeconds == null ? "waiting" : `${heartbeatAgeSeconds}s ago`}</span>
                        </div>
                      </div>
                      {photoFetchJobId && (
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <p className={`text-xs ${heartbeatIsStale ? "text-amber-700" : "text-muted-foreground"}`}>
                            {heartbeatIsStale
                              ? "The server heartbeat is stale. Cancel and retry if this does not recover shortly."
                              : "Server job running. You can leave this tab and come back; this page will reconnect to the job."}
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={cancelPhotoFetchJob}
                            data-testid="button-cancel-photo-fetch-job"
                          >
                            Cancel photo fetch
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()
            )}

            {photoFetchJob?.status === "failed" && photoFetchJobId && (
              <div className="mb-4 flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                <p>{photoFetchJob.items?.[0]?.error || photoFetchJob.items?.[0]?.message || "Photo fetch failed."}</p>
                <OperationFailureActions
                  jobType="combo-photo-fetch"
                  jobId={photoFetchJobId}
                  itemKey={photoFetchJob.items?.[0]?.id}
                  onRemediated={async () => {
                    try {
                      const resp = await fetch(
                        `/api/community/photo-fetch-jobs/${encodeURIComponent(photoFetchJobId)}`,
                        { credentials: "include" },
                      );
                      if (resp.ok) {
                        const data = await resp.json();
                        if (data.job) applyPhotoFetchJob(data.job);
                      }
                    } catch { /* ignore */ }
                  }}
                />
              </div>
            )}

            {!photosLoading && (
              <>
                {(unit1Photos.length > 0 || unit2Photos.length > 0) ? (
                  <>
                    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-muted-foreground">
                        Unit 1: {unit1Photos.length} photo{unit1Photos.length === 1 ? "" : "s"} · Unit 2: {unit2Photos.length} photo{unit2Photos.length === 1 ? "" : "s"}.
                      </p>
                      <Button className="w-full sm:w-auto" variant="outline" size="sm" onClick={handleCheckAllPhotos} data-testid="button-check-all-photos">
                        <ShieldCheck className="h-4 w-4 mr-2" />
                        Check All Photos
                      </Button>
                    </div>

                    {flaggedPhotos.length > 0 && (
                      <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm mb-4">
                        <ShieldX className="h-4 w-4 shrink-0" />
                        {flaggedPhotos.length} photo{flaggedPhotos.length > 1 ? "s" : ""} found on competing platforms. Consider selecting different units.
                      </div>
                    )}

                    {[
                      { key: "unit-1", label: `Unit 1 — ${unit1BedroomCount ?? "?"}BR`, photos: unit1Photos, sourceUrl: unit1PhotoSourceUrl },
                      { key: "unit-2", label: `Unit 2 — ${unit2BedroomCount ?? "?"}BR`, photos: unit2Photos, sourceUrl: unit2PhotoSourceUrl },
                    ].map(({ key, label, photos, sourceUrl }) => (
                      <div key={label} className="mb-6">
                        <div className="flex items-center gap-2 mb-3">
                          <h3 className="font-medium text-sm">{label}</h3>
                          <Badge variant={photos.length > 0 ? "default" : "outline"} className="text-[10px]">
                            {photos.length} photo{photos.length === 1 ? "" : "s"}
                          </Badge>
                          {sourceUrl && (
                            <a
                              href={sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline"
                            >
                              View source listing
                            </a>
                          )}
                        </div>
                        {photos.length > 0 ? (
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {photos.map((p, i) => {
                              const checkResult = photoChecks[p.url];
                              const isChecking = checkResult === "checking";
                              const isFlagged = checkResult && checkResult !== "checking" && !(checkResult as PhotoCheckResult).clean;
                              return (
                                <div key={i} className={`relative rounded-lg overflow-hidden border-2 transition-colors ${isFlagged ? "border-red-400" : "border-transparent"}`} data-testid={`photo-${key}-${i}`}>
                                  <img src={p.url} alt={p.label} className="w-full aspect-video object-cover" />
                                  {checkResult && checkResult !== "checking" && (
                                    <div className={`absolute top-1 right-1 rounded-full p-0.5 ${(checkResult as PhotoCheckResult).clean ? "bg-green-500" : "bg-red-500"}`}>
                                      {(checkResult as PhotoCheckResult).clean
                                        ? <ShieldCheck className="h-3.5 w-3.5 text-white" />
                                        : <ShieldX className="h-3.5 w-3.5 text-white" />
                                      }
                                    </div>
                                  )}
                                  {isChecking && (
                                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                                      <Loader2 className="h-5 w-5 text-white animate-spin" />
                                    </div>
                                  )}
                                  {isFlagged && (
                                    <div className="absolute bottom-0 left-0 right-0 bg-red-500 text-white text-xs px-2 py-0.5 text-center truncate">
                                      {((checkResult as PhotoCheckResult).matches[0]?.platform) ?? "Found"}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid={`photo-empty-${key}`}>
                            No photos attached for this unit from the last fetch.
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="text-center py-10 text-muted-foreground">
                    <Camera className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p>Photos could not be fetched from Zillow automatically.</p>
                    <p className="text-sm mt-1">You can proceed to generate the listing draft anyway.</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-4"
                      onClick={handleConfirmUnits}
                      data-testid="button-retry-photos"
                    >
                      Retry Photo Fetch
                    </Button>
                  </div>
                )}

                <Button className="w-full sm:w-auto" onClick={handleGenerateListing} data-testid="button-generate-listing" id="btn-next-step" aria-label="Generate listing draft and proceed to Step 5">
                  <FileText className="h-4 w-4 mr-2" />
                  Generate Listing Draft <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </>
            )}
          </div>
        )}

        {/* ── STEP 5: Listing draft ─────────────────────────── */}
        {step === 5 && (
          <div id="step-5-content">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-5-heading">Step 5: Listing Draft</h2>
              </div>
              <Button className="w-full sm:w-auto" variant="outline" size="sm" onClick={() => setStep(4)} data-testid="button-back-step4" id="btn-prev-step" aria-label="Go back to Step 4: Photos and Platform Check">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
            </div>

            <div id="summary-panel" className="mb-4 break-words rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              <strong>Community:</strong> {selectedCommunity?.name} — <strong>Units:</strong> {selectedUnit1?.title} + {selectedUnit2?.title}.{" "}
              <strong>Combined:</strong> {combinedBedrooms}BR. <strong>Suggested rate:</strong> ${suggestedRate > 0 ? suggestedRate.toLocaleString() : "—"}/night.{" "}
              <strong>Title:</strong> {editedTitle || (listing?.title ?? "Not generated yet")}.
            </div>

            {listingLoading && (
              <div className="flex items-center gap-3 py-12 justify-center text-muted-foreground" id="status-message">
                <Loader2 className="h-5 w-5 animate-spin" />
                Generating VRBO-ready listing with AI…
              </div>
            )}

            {!listingLoading && listing && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                  <Card className="p-4">
                    <p className="text-xs text-muted-foreground mb-1">Combined Bedrooms</p>
                    <p className="text-2xl font-bold" data-testid="text-combined-bedrooms" id="text-combined-bedrooms">{combinedBedrooms}BR</p>
                  </Card>
                  <Card className="p-4">
                    <p className="text-xs text-muted-foreground mb-1">Suggested Nightly Rate</p>
                    <p className="text-2xl font-bold text-green-600" data-testid="text-suggested-rate" id="text-suggested-rate">${suggestedRate > 0 ? suggestedRate.toLocaleString() : listing.suggestedRate?.toLocaleString() ?? "—"}</p>
                  </Card>
                  <Card className="p-4">
                    <p className="text-xs text-muted-foreground mb-1">Net margin (after Airbnb fees)</p>
                    <p className="text-2xl font-bold">{Math.round(NET_MARGIN_TARGET * 100)}%</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Sell × (1 − {Math.round(AIRBNB_FEE * 100)}%) − cost = {Math.round(NET_MARGIN_TARGET * 100)}% net
                    </p>
                  </Card>
                </div>

                <div className="space-y-5 mb-6">
                  {/* ── Listing identity ──────────────────────── */}
                  <Card className="p-4 space-y-4">
                    <div>
                      <label htmlFor="input-listing-title" className="text-sm font-medium mb-1.5 block">
                        Headline <span className="text-muted-foreground font-normal">({editedTitle.length}/80 chars · Airbnb truncates at 50)</span>
                      </label>
                      <Input
                        id="input-listing-title"
                        value={editedTitle}
                        onChange={e => setEditedTitle(e.target.value.slice(0, 80))}
                        className="font-medium"
                        data-testid="input-listing-title"
                        aria-label="Listing headline"
                      />
                    </div>
                    <div>
                      <label htmlFor="input-booking-title" className="text-sm font-medium mb-1.5 block">
                        Booking.com / VRBO Title <span className="text-muted-foreground font-normal">({editedBookingTitle.length}/110 chars)</span>
                      </label>
                      <Input
                        id="input-booking-title"
                        value={editedBookingTitle}
                        onChange={e => setEditedBookingTitle(e.target.value.slice(0, 110))}
                        className="font-medium"
                        data-testid="input-booking-title"
                      />
                    </div>
                    <div>
                      <label htmlFor="input-street-address" className="text-sm font-medium mb-1.5 block">
                        Street Address
                        <span className="text-muted-foreground font-normal ml-2 text-xs">— validated against the selected community</span>
                      </label>
                      <Input
                        id="input-street-address"
                        value={editedStreetAddress}
                        onChange={e => setEditedStreetAddress(e.target.value)}
                        placeholder={suggestedStreetAddress || "Street, e.g. 1661 Pe'e Rd"}
                        data-testid="input-street-address"
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Required before saving. Known resorts auto-fill their canonical street address so Guesty and Airbnb validate against the right community.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="select-property-type" className="text-sm font-medium mb-1.5 block">Property Type</label>
                        <Select value={editedPropertyType} onValueChange={setEditedPropertyType}>
                          <SelectTrigger id="select-property-type" data-testid="select-property-type">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {["Condominium", "Townhouse", "House", "Villa", "Apartment", "Estate", "Cottage", "Bungalow", "Loft"].map(t => (
                              <SelectItem key={t} value={t}>{t}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label htmlFor="select-pricing-area" className="text-sm font-medium mb-1.5 block">
                          Pricing Area
                          <span className="text-muted-foreground font-normal ml-2 text-xs">— buy-in / margin lookup</span>
                        </label>
                        <Select
                          value={editedPricingArea || "__none__"}
                          onValueChange={(v) => setEditedPricingArea(v === "__none__" ? "" : v)}
                        >
                          <SelectTrigger id="select-pricing-area" data-testid="select-pricing-area">
                            <SelectValue placeholder="Pick a pricing area…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">No pricing area (use default rate)</SelectItem>
                            {Object.keys(BUY_IN_RATES).map((k) => (
                              <SelectItem key={k} value={k}>{k}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Defaults to a per-bedroom estimate when none is picked. Hawaii cities auto-select; pick the closest match for other markets.
                        </p>
                      </div>
                    </div>
                  </Card>

                  {/* ── Description (combined / Airbnb summary) ── */}
                  <Card className="p-4 space-y-4">
                    <div>
                      <label htmlFor="textarea-listing-description" className="text-sm font-medium mb-1.5 block">
                        Combined Listing Description
                        <span className="text-muted-foreground font-normal ml-2">— rendered as the main listing body</span>
                      </label>
                      <Textarea
                        id="textarea-listing-description"
                        value={editedDescription}
                        onChange={e => setEditedDescription(e.target.value)}
                        rows={14}
                        className="font-mono text-xs leading-relaxed resize-y"
                        data-testid="textarea-listing-description"
                      />
                    </div>
                    <div>
                      <label htmlFor="textarea-neighborhood" className="text-sm font-medium mb-1.5 block">The Neighborhood</label>
                      <Textarea
                        id="textarea-neighborhood"
                        value={editedNeighborhood}
                        onChange={e => setEditedNeighborhood(e.target.value)}
                        rows={5}
                        className="text-sm leading-relaxed"
                        placeholder="What's around the property — beaches, dining, shops, vibe."
                        data-testid="textarea-neighborhood"
                      />
                    </div>
                    <div>
                      <label htmlFor="textarea-transit" className="text-sm font-medium mb-1.5 block">Getting Around</label>
                      <Textarea
                        id="textarea-transit"
                        value={editedTransit}
                        onChange={e => setEditedTransit(e.target.value)}
                        rows={4}
                        className="text-sm leading-relaxed"
                        placeholder="Distance to airport, rental car notes, rideshare availability."
                        data-testid="textarea-transit"
                      />
                    </div>
                  </Card>

                  {/* ── Per-unit details (Unit A / Unit B) ──── */}
                  {[
                    { key: "A", state: editedUnitA, setState: setEditedUnitA, brFallback: unit1BedroomCount ?? 0 },
                    { key: "B", state: editedUnitB, setState: setEditedUnitB, brFallback: unit2BedroomCount ?? 0 },
                  ].map(({ key, state, setState, brFallback }) => {
                    const unit = state ?? {
                      bedrooms: brFallback,
                      bathrooms: "",
                      sqft: "",
                      maxGuests: brFallback * 2,
                      bedding: "",
                      shortDescription: "",
                      longDescription: "",
                    };
                    const update = (patch: Partial<UnitDraft>) => setState({ ...unit, ...patch });
                    return (
                      <Card key={key} className="p-4 space-y-3" data-testid={`unit-${key}-card`}>
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-primary" />
                          <h3 className="font-semibold text-sm">Unit {key} — {unit.bedrooms}BR</h3>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                          <div>
                            <label className="text-xs font-medium mb-1 block">Bedrooms</label>
                            <Input
                              type="number"
                              min={1}
                              value={unit.bedrooms}
                              onChange={e => update({ bedrooms: Number(e.target.value) || 0 })}
                              data-testid={`input-unit-${key}-bedrooms`}
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium mb-1 block">Bathrooms</label>
                            <Input
                              value={unit.bathrooms}
                              onChange={e => update({ bathrooms: e.target.value })}
                              placeholder="2"
                              data-testid={`input-unit-${key}-bathrooms`}
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium mb-1 block">Sqft</label>
                            <Input
                              value={unit.sqft}
                              onChange={e => update({ sqft: e.target.value })}
                              placeholder="~1,200"
                              data-testid={`input-unit-${key}-sqft`}
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium mb-1 block">Sleeps</label>
                            <Input
                              type="number"
                              min={1}
                              value={unit.maxGuests}
                              onChange={e => update({ maxGuests: Number(e.target.value) || 0 })}
                              data-testid={`input-unit-${key}-max-guests`}
                            />
                          </div>
                        </div>
                        <div>
                          <label className="text-xs font-medium mb-1 block">Bedding</label>
                          <Input
                            value={unit.bedding}
                            onChange={e => update({ bedding: e.target.value })}
                            placeholder="King master, Queen second bedroom, Twin third, queen sleeper sofa"
                            data-testid={`input-unit-${key}-bedding`}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium mb-1 block">Short Description</label>
                          <Input
                            value={unit.shortDescription}
                            onChange={e => update({ shortDescription: e.target.value })}
                            placeholder="One-sentence highlight."
                            data-testid={`input-unit-${key}-short-desc`}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium mb-1 block">Long Description</label>
                          <Textarea
                            value={unit.longDescription}
                            onChange={e => update({ longDescription: e.target.value })}
                            rows={6}
                            className="text-sm leading-relaxed"
                            placeholder="Layout, beds, key amenities, why a family/group would love this unit."
                            data-testid={`textarea-unit-${key}-long-desc`}
                          />
                        </div>
                      </Card>
                    );
                  })}

                  {/* ── License Requirements ──────────────────── */}
                  <Card className="p-4">
                    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-sm font-medium">{licenseProfile.title}</p>
                        <p className="text-xs text-muted-foreground">{licenseProfile.summary}</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => toast({
                          title: licenseProfile.title,
                          description: licenseProfile.requirements.length
                            ? `Loaded ${licenseProfile.requirements.length} mapped license requirement${licenseProfile.requirements.length === 1 ? "" : "s"} for this address.`
                            : "No mapped license requirements found for this address yet.",
                        })}
                        data-testid="button-load-license-requirements"
                      >
                        Load license requirements
                      </Button>
                    </div>
                    {licenseProfile.requirements.length > 0 ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        {licenseProfile.requirements.map((req) => {
                          const editable = req.key === "strPermit" || req.key === "dbprLicense" || req.key === "touristTaxAccount";
                          const value =
                            req.key === "strPermit" ? strPermit :
                            req.key === "dbprLicense" ? dbprLicense :
                            req.key === "touristTaxAccount" ? touristTaxAccount :
                            "";
                          const onChange =
                            req.key === "strPermit" ? setStrPermit :
                            req.key === "dbprLicense" ? setDbprLicense :
                            req.key === "touristTaxAccount" ? setTouristTaxAccount :
                            undefined;
                          return (
                            <div key={req.key} className="rounded-md border border-border bg-muted/30 p-3">
                              <div className="mb-1 flex items-center justify-between gap-2">
                                <label htmlFor={`input-${req.key}`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  {req.shortLabel}
                                </label>
                                {req.required && <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">Required</span>}
                              </div>
                              {editable ? (
                                <Input
                                  id={`input-${req.key}`}
                                  value={value}
                                  onChange={e => onChange?.(e.target.value)}
                                  placeholder={req.key === "strPermit" ? (listing.strPermitSample ?? req.sample) : req.sample}
                                  className="font-mono"
                                  data-testid={`input-${req.key}`}
                                />
                              ) : (
                                <div className="break-words rounded-md border border-dashed border-border bg-background px-3 py-2 font-mono text-sm text-muted-foreground" data-testid={`sample-${req.key}`}>
                                  sample: {req.sample}
                                </div>
                              )}
                              <p className="mt-2 text-xs text-muted-foreground">{req.helpText}</p>
                              {req.requiredForOtas.length > 0 && (
                                <p className="mt-1 text-[11px] text-muted-foreground">OTA fields: {req.requiredForOtas.join(", ")}</p>
                              )}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-2 h-7 w-full px-2 text-xs sm:w-auto"
                                onClick={() => toast({
                                  title: req.shortLabel,
                                  description: editable
                                    ? "This requirement is ready for the real license value once you have it."
                                    : "This value is confirmed from the Builder compliance panel after the real property address is selected.",
                                })}
                                data-testid={`button-load-${req.key}`}
                              >
                                Pull {req.shortLabel}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                        No automatic license rule is mapped for this city/state yet. Verify local registration requirements before publishing.
                      </div>
                    )}
                    {licenseProfile.sources.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {licenseProfile.sources.map(source => (
                          <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                            {source.label}
                          </a>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <Button className="w-full sm:w-auto" onClick={handleSave} disabled={saving} data-testid="button-save-community" id="btn-next-step" aria-label="Save community to dashboard">
                    {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                    {saving ? "Saving…" : "Save to Dashboard"}
                  </Button>
                  <Button className="w-full sm:w-auto" variant="outline" onClick={handleGenerateListing} disabled={listingLoading} data-testid="button-regenerate" id="button-regenerate-listing" aria-label="Regenerate listing with AI">
                    Regenerate with AI
                  </Button>
                </div>
                {saving && <p id="status-message" className="text-sm text-muted-foreground mt-2">Saving community to dashboard…</p>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
