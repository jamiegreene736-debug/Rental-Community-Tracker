import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  ArrowUpDown, ArrowUp, ArrowDown, Star,
} from "lucide-react";
import type { BuyIn, GuestyPropertyMap } from "@shared/schema";
import type { UnitConfig } from "@shared/property-units";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlotInfo extends UnitConfig {
  buyIn: BuyIn | null;
}

interface GuestyReservation {
  _id: string;
  status: string;
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
  };
  source?: string;
  integration?: { platform?: string };
  confirmationCode?: string;
  slots: SlotInfo[];
  slotsFilled: number;
  slotsTotal: number;
  fullyLinked: boolean;
}

interface Candidate {
  buyIn: BuyIn;
  buyInNights: number;
  totalCost: number;
  costPerNight: number;
  wastedNights: number;
  effectiveCost: number;
  score: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMoney(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  if (!v && v !== 0) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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

// Auto-fill progress bar — gives the operator visual confirmation that
// the mutation is still running (the verify-pm-listing call can take
// 30-90s per slot, which feels frozen without feedback). Indeterminate
// in nature: ramps to 95% over the expected duration based on slot
// count, snaps to 100% only when the mutation completes (parent
// unmounts this component when autoFilling clears).
function AutoFillProgress({ slotCount }: { slotCount: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, []);
  // Slots run SEQUENTIALLY (each slot needs to know which URLs earlier
  // slots picked, so it can choose a different unit). Budget ~70s per
  // slot for the slowest verify, scaled by slotCount. Without this
  // scaling the bar pegs at 95% halfway through a multi-slot run and
  // looks frozen for ~60s while the remaining slots finish.
  const expectedSeconds = Math.max(70, 70 * slotCount);
  const value = Math.min(95, Math.round((elapsed / expectedSeconds) * 100));
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          Searching candidates and verifying rates ({slotCount} {slotCount === 1 ? "slot" : "slots"}, sequential — each slot waits for the previous to finish so they pick different units) — vision step can take up to 90s per slot
        </span>
        <span className="tabular-nums">{elapsed}s</span>
      </div>
      <Progress value={value} className="h-1.5" />
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
  // Slots whose inline live-search panel is expanded. Auto-fill flips
  // every slot it touched into this set so the operator sees the
  // scanned-options table for each slot inline (per operator request:
  // "auto-fill should also show me the tables"). Operators can also
  // toggle any slot manually via the chevron button.
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
      const findBuyInCache = new Map<number, Promise<FindBuyInResponse>>();
      const getFindBuyInForBedrooms = (bedrooms: number): Promise<FindBuyInResponse> => {
        const existing = findBuyInCache.get(bedrooms);
        if (existing) return existing;
        const url = `/api/operations/find-buy-in?propertyId=${selectedPropertyId}&bedrooms=${bedrooms}&checkIn=${ci}&checkOut=${co}`;
        const promise = apiRequest("GET", url).then((r) => r.json()) as Promise<FindBuyInResponse>;
        findBuyInCache.set(bedrooms, promise);
        return promise;
      };

      // Sequential per-slot picking with shared pickedUrls. Multi-unit
      // reservations (e.g. Amy's 2× 3BR) need DIFFERENT physical units
      // attached to each slot — same Vrbo URL on both Unit 721 and Unit
      // 812 means we'd be paying for one listing twice and have nothing
      // for the second guest's actual unit. The shared find-buy-in cache
      // (`getFindBuyInForBedrooms`) means both slots see the same ranked
      // candidate list; without de-duplication, both would pick the
      // cheapest verified candidate and end up with the same URL.
      //
      // Trade-off: we lose parallelism (slots process serially), so a
      // 2-slot reservation takes ~2× the verify time of a 1-slot one.
      // Accepted because (a) most reservations are 1-2 slots, (b) the
      // verify loop already takes the bulk of the time and runs PMs
      // sequentially within a single slot anyway.
      const pickedUrls = new Set<string>();
      const results: Array<{
        slot: typeof emptySlots[number];
        picked: (LiveCandidate & { totalPrice: number }) | null;
        created: any;
        skippedReasons: string[];
        visionVerified: boolean;
        airbnbLastResort: boolean;
      }> = [];
      for (const slot of emptySlots) {
        const slotResult = await (async () => {
          const data = await getFindBuyInForBedrooms(slot.bedrooms);

          // Pre-flight: walk cheapest-first and verify availability before
          // picking. Two-tier verification, mirroring the dialog UI's
          // ScannedOptionsTable auto-verify (PR #237):
          //
          //   1. Trust-by-source. Airbnb / Vrbo / Booking rows came from
          //      engines that already vouched for priced inventory for
          //      the requested dates. Treated as verified-yes for free.
          //
          //   2. PM rows are the gap (photo-matched price is anchored
          //      from Airbnb; PM-side availability is not). Run the
          //      Haiku batch verifier on the top 10 cheapest priced PM
          //      candidates — same endpoint the dialog uses, same 5-min
          //      cache. ~$0.05 worst case per slot; cache hits free.
          //
          //   3. Walk pricedCandidates cheapest-first, pick the first
          //      verified-yes URL. This is what makes auto-fill stop
          //      attaching units that the dialog's verifier already
          //      flagged as unavailable.
          //
          // `pickedUrls` carries URLs already attached to earlier slots
          // in this same auto-fill run; filter them out so each slot
          // gets a distinct candidate.
          const notAlreadyPicked = (c: LiveCandidate) => !pickedUrls.has(c.url);
          const allCheapest = data.cheapest ?? [];
          const pricedCandidates = allCheapest.filter((c) => c.totalPrice > 0).filter(notAlreadyPicked);
          const unpricedFallback = allCheapest.filter((c) => c.totalPrice === 0).filter(notAlreadyPicked);
          let pick: LiveCandidate | null = null;
          let verifiedPrice: number | null = null;
          let skippedReasons: string[] = [];

          // Build verified-yes AND verified-no sets from the Haiku
          // batch. Airbnb anchors are trusted-by-source (engine
          // filters by availability for the requested dates).
          // Everything else (PM + Vrbo + Booking) goes through the
          // Haiku verifier — dropping Vrbo's trust-by-source closes
          // the "Vrbo URL pre-filled dates but unit wasn't bookable"
          // gap Jamie hit.
          const verifiedYesUrls = new Set<string>();
          const verifiedNoUrls = new Set<string>();
          for (const c of pricedCandidates) {
            if (c.source === "airbnb") verifiedYesUrls.add(c.url);
          }
          const toVerify = pricedCandidates
            .filter((c) => c.source !== "airbnb")
            .slice(0, 15)
            .map((c) => c.url);
          if (toVerify.length > 0) {
            try {
              const batchResp = await apiRequest(
                "POST",
                "/api/buy-in-candidates/verify-availability-batch",
                { urls: toVerify, checkIn: ci, checkOut: co },
              ).then((r) => r.json());
              const results = (batchResp?.results ?? {}) as Record<
                string,
                { available?: string; nightlyPriceUsd?: number | null; reason?: string }
              >;
              for (const [url, result] of Object.entries(results)) {
                if (result?.available === "yes") verifiedYesUrls.add(url);
                else if (result?.available === "no") verifiedNoUrls.add(url);
              }
            } catch (e: any) {
              // Batch verifier failure is non-fatal — fall through to
              // the per-row pre-flight loop below, which uses the
              // older verify-listing endpoint as a backstop.
              skippedReasons.push(`batch-verify-error: ${e?.message ?? "unknown"}`);
            }
          }

          // Pass 1: pick cheapest verified-yes priced candidate.
          for (const c of pricedCandidates) {
            if (!verifiedYesUrls.has(c.url)) continue;
            pick = c;
            break;
          }

          // Pass 2: if Haiku found nothing verified-yes (peak season,
          // batch errored, or everything came back unclear), fall back
          // to the older SearchAPI pre-flight on the top 4 priced.
          // CRITICAL: skip URLs that Haiku already flagged as
          // verified-no — otherwise Pass 2 attaches a unit Haiku just
          // told us is unavailable. SearchAPI returns "available: null"
          // for most PM URLs (it can't decisively check them), so
          // without this gate Pass 2 picks the cheapest unverified row
          // even when Haiku said "no."
          if (!pick) {
            for (const c of pricedCandidates.slice(0, 4)) {
              if (verifiedNoUrls.has(c.url)) {
                skippedReasons.push(`${c.sourceLabel}: Haiku flagged unavailable`);
                continue;
              }
              const verifyUrl = `/api/operations/verify-listing?url=${encodeURIComponent(c.url)}&checkIn=${ci}&checkOut=${co}&q=${encodeURIComponent(data.resortName ?? data.community ?? "")}&bedrooms=${slot.bedrooms}`;
              const v = await apiRequest("GET", verifyUrl).then((r) => r.json()).catch(() => ({ available: null as boolean | null }));
              if (v?.available === false) {
                skippedReasons.push(`${c.sourceLabel}: ${v.reason ?? "unavailable"}`);
                continue;
              }
              pick = c;
              if (typeof v?.currentTotalPrice === "number" && v.currentTotalPrice > 0) {
                verifiedPrice = v.currentTotalPrice;
              }
              break;
            }
          }

          // No priced candidate worked → walk multiple unpriced PM URLs
          // and verify each. The dispatcher in pm-rate-agent picks the
          // right path per URL: programmatic scrapers for PMs we've
          // reverse-engineered (Suite Paradise via /rescms/ajax/...),
          // Browserbase agent for unknown PMs.
          //
          // We prioritize known-fast-scraper PMs first: Suite Paradise
          // returns in ~1s, while the agent path takes 60-180s. Sorting
          // those URLs to the front means we usually finish in seconds.
          //
          // Stop on the first verified price (cheapest available will
          // usually be one of the first few candidates anyway). If
          // available:false comes back from a scraper, skip and try
          // the next URL — the unit's just booked, not a permanent
          // failure.
          let visionVerified = false;
          // Track the explicit-unavailable count from scrapers so we can
          // pick a smarter fallback. When most fast-scraper hits came
          // back available:false (peak season), the operator wants to
          // see Vrbo URLs to do their own manual research — Vrbo isn't
          // bookable for sublet but listings there are useful for
          // cross-checking.
          let unavailableCount = 0;
          let allCheckedUrls: { sourceLabel: string; url: string; status: string }[] = [];
          if (!pick) {
            const allUnpricedPm = (data.sources?.pm ?? []).filter((c) => c.totalPrice === 0).filter(notAlreadyPicked);
            const allUnpricedVrbo = (data.sources?.vrbo ?? []).filter((c) => c.totalPrice === 0).filter(notAlreadyPicked);
            // Fast-scrape PMs (~1-10s): Suite Paradise direct rcapi,
            // Vrbo via Browserbase + GraphQL calendar parse.
            const isFastScrape = (u: string) =>
              /(?:^|\.)(?:suite-paradise|vrbo)\.com/.test(u);
            const ordered = [
              // Suite Paradise URLs (rcapi, ~1s) → fastest
              ...allUnpricedPm.filter((c) => /(?:^|\.)suite-paradise\.com/.test(c.url)),
              // Vrbo URLs (Browserbase + GraphQL parse, ~6-10s)
              ...allUnpricedVrbo,
              // Other PM URLs that fall through to the agent (~60-180s)
              ...allUnpricedPm.filter((c) => !isFastScrape(c.url)),
            ].slice(0, 8); // cap at 8: covers ~3 SP + ~4 Vrbo + 1 PM, enough
                           // to find availability in normal weeks; in peak
                           // weeks we'd hit unavailable on all and fall
                           // through to the alternative-fallback below.

            for (const c of ordered) {
              try {
                // 30s timeout for fast-scrape PMs (Vrbo can be 10s+
                // when Browserbase cold-starts); 95s for agent-path.
                const timeoutMs = isFastScrape(c.url) ? 30000 : 95000;
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), timeoutMs);
                const resp = await fetch("/api/operations/verify-pm-listing", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({ url: c.url, checkIn: ci, checkOut: co }),
                  signal: controller.signal,
                }).finally(() => clearTimeout(t));
                const v = resp.ok ? await resp.json() : null;
                const ex = v?.extracted;
                if (
                  v?.ok &&
                  ex?.isUnitPage === true &&
                  ex?.available !== false &&
                  ex?.dateMatch !== false &&
                  typeof ex?.totalPrice === "number" &&
                  ex.totalPrice > 0
                ) {
                  pick = c;
                  verifiedPrice = ex.totalPrice;
                  visionVerified = true;
                  break;
                }
                if (ex?.available === false) unavailableCount++;
                const status = ex?.available === false ? "BOOKED" : (ex?.reason ? "no-price" : "verify-failed");
                allCheckedUrls.push({ sourceLabel: c.sourceLabel, url: c.url, status });
                skippedReasons.push(`${c.sourceLabel}: ${ex?.reason ?? v?.reason ?? "vision-no-price"}`);
              } catch (e: any) {
                allCheckedUrls.push({ sourceLabel: c.sourceLabel, url: c.url, status: "error" });
                skippedReasons.push(`${c.sourceLabel}: verify-error ${e?.message ?? ""}`.trim());
              }
            }
          }

          // Fallback: if vision couldn't extract from any source, attach
          // the most-useful unpriced URL we have. Two regimes:
          //   1. Most candidates explicitly came back available:false
          //      (peak season, everything's booked) → attach the top
          //      Vrbo URL so the operator can see what's listed there
          //      and do manual research. This addresses the "nothing for
          //      VRBO popped up" complaint when the bookable PMs are
          //      all confirmed booked.
          //   2. Otherwise (mixed failures, errors, no-price) → attach
          //      the server's PM unpriced fallback (Parrish Kauai et al)
          //      because PM is the canonical bookable channel.
          const peakSeasonAllBooked = unavailableCount >= 3;
          if (!pick && peakSeasonAllBooked) {
            const topVrbo = (data.sources?.vrbo ?? []).filter((c) => c.totalPrice === 0).filter(notAlreadyPicked)[0];
            if (topVrbo) pick = topVrbo;
          }
          if (!pick && unpricedFallback.length > 0) {
            pick = unpricedFallback[0];
          }
          // Last-resort Airbnb walk. Operator opted Airbnb back into the
          // bookable pool as a final safety net when no PM/Booking/Vrbo
          // candidate produced a usable URL — better than leaving the
          // slot empty. Walk priced Airbnb candidates (cheapest first)
          // and verify each via verify-listing; take the first verified
          // one. If verification fails for all (or returns unknown),
          // attach the cheapest priced Airbnb URL anyway — the operator
          // can confirm availability themselves.
          //
          // Airbnb's TOS prohibits sublet, so the buy-in record gets a
          // TOS-warning suffix in its notes (added below). This is
          // tracked separately so the toast and notes can flag it.
          let airbnbLastResort = false;
          if (!pick) {
            const airbnbPriced = (data.sources?.airbnb ?? []).filter((c) => c.totalPrice > 0).filter(notAlreadyPicked);
            for (const c of airbnbPriced.slice(0, 4)) {
              const verifyUrl = `/api/operations/verify-listing?url=${encodeURIComponent(c.url)}&checkIn=${ci}&checkOut=${co}&q=${encodeURIComponent(data.resortName ?? data.community ?? "")}&bedrooms=${slot.bedrooms}`;
              const v = await apiRequest("GET", verifyUrl).then((r) => r.json()).catch(() => ({ available: null as boolean | null }));
              if (v?.available === false) {
                skippedReasons.push(`Airbnb: ${v.reason ?? "unavailable"}`);
                continue;
              }
              pick = c;
              airbnbLastResort = true;
              if (typeof v?.currentTotalPrice === "number" && v.currentTotalPrice > 0) {
                verifiedPrice = v.currentTotalPrice;
              }
              break;
            }
            if (!pick && airbnbPriced.length > 0) {
              pick = airbnbPriced[0];
              airbnbLastResort = true;
            }
          }
          if (!pick) {
            const fallbackVrbo = (data.sources?.vrbo ?? []).filter((c) => c.totalPrice === 0).filter(notAlreadyPicked)[0];
            if (fallbackVrbo) pick = fallbackVrbo;
          }

          if (!pick) return { slot, picked: null, created: null, skippedReasons, visionVerified: false, airbnbLastResort: false };

          const finalCost = verifiedPrice ?? pick.totalPrice;
          const propertyName =
            (selectedListingId && listingNameById.get(selectedListingId)) ||
            `Property ${selectedPropertyId}`;
          const noteSuffix = visionVerified
            ? ` · Verified via screenshot analysis ($${finalCost} for ${slot.bedrooms}BR ${ci}→${co})`
            : "";
          const tosSuffix = airbnbLastResort
            ? ` · ⚠️ Last-resort Airbnb pick — Airbnb TOS prohibits sublet. No PM/Booking/Vrbo candidate was available for these dates. Open Find buy-in on this slot for reverse-image PM matches you can book direct.`
            : "";
          // PM URL discovered via reverse-image-match against an Airbnb
          // listing — disclose the anchor + that the PM rate may differ
          // slightly from the inherited Airbnb price. Both pieces are
          // important: the anchor URL lets the operator click through
          // to verify the photos match, and the disclaimer keeps them
          // from over-relying on the inherited price.
          const anchorSuffix = pick.airbnbAnchorUrl && pick.airbnbAnchorPrice
            ? ` · 📷 Photo-matched to Airbnb listing $${pick.airbnbAnchorPrice.toLocaleString()} (${pick.airbnbAnchorUrl}). Same physical unit, bookable on PM site. PM rate may differ slightly — verify on PM page before confirming with guest.`
            : "";
          // When we attached the URL because of the peak-season fallback
          // (most/all candidates came back booked), record what was
          // checked so the operator can see what's listed elsewhere
          // without having to open Find buy-in. Top 6 entries to keep
          // the notes field readable.
          const attemptsNote = allCheckedUrls.length > 0
            ? `\n\nChecked ${allCheckedUrls.length} alternative${allCheckedUrls.length === 1 ? "" : "s"} — ${unavailableCount} confirmed booked for ${ci} → ${co}:\n` +
              allCheckedUrls.slice(0, 6).map((a) => `  • [${a.status}] ${a.sourceLabel} — ${a.url}`).join("\n")
            : "";
          // Wrap create+attach in a try/catch — if one slot fails (DB
          // hiccup, race in attachBuyIn's "same-slot already attached"
          // check, etc.) we don't want the whole sequential loop to
          // throw and leave LATER slots without a chance to fill at all.
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
              notes: `Auto-filled from ${pick.sourceLabel} — ${pick.title}${noteSuffix}${tosSuffix}${anchorSuffix}${attemptsNote}`,
              status: "active",
            }).then((r) => r.json());
            if (!created?.id) throw new Error(`Create failed for ${slot.unitLabel}`);

            await apiRequest("POST", `/api/bookings/${reservation._id}/attach-buy-in`, {
              buyInId: created.id,
            }).then((r) => r.json());

            return { slot, picked: { ...pick, totalPrice: finalCost }, created, skippedReasons, visionVerified, airbnbLastResort };
          } catch (e: any) {
            skippedReasons.push(`${slot.unitLabel}: attach-error ${e?.message ?? ""}`.trim());
            return { slot, picked: null, created: null, skippedReasons, visionVerified: false, airbnbLastResort: false };
          }
        })();
        // Reserve the picked URL so subsequent slots in this same
        // auto-fill run skip it and find a different unit.
        if (slotResult.picked?.url) pickedUrls.add(slotResult.picked.url);
        results.push(slotResult);
      }
      return { reservation, results };
    },
    onSuccess: ({ reservation, results }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      // Per operator request: auto-fill should also surface the live-
      // search table for each slot it touched, so the operator can see
      // what was scanned and override the auto-pick if needed. Flip the
      // expanded-search bit for every slot in this reservation.
      setExpandedSlots((prev) => {
        const next = new Set(prev);
        for (const r of results) {
          next.add(slotKey(reservation._id, r.slot.unitId));
        }
        return next;
      });
      const filled = results.filter((r) => r.picked);
      const totalCost = filled.reduce((s, r) => s + (r.picked?.totalPrice ?? 0), 0);
      const payout = reservation.money?.hostPayout ?? 0;
      const existingCost = reservation.slots.reduce(
        (s, sl) => s + parseFloat(String(sl.buyIn?.costPaid ?? 0)),
        0,
      );
      const estProfit = payout - existingCost - totalCost;
      const skipped = results.filter((r) => !r.picked).map((r) => r.slot.unitLabel);
      // Some picks can come back at $0 — that's the unpriced-PM
      // fallback (server-side, /api/operations/find-buy-in): when no
      // priced PM/Booking candidate exists, auto-fill grabs a top PM
      // URL and attaches it with totalPrice=0 so the slot at least
      // points at a clickable PM company instead of staying empty.
      // Operator updates the cost after contacting the PM.
      const zeroCostFills = filled.filter((r) => (r.picked?.totalPrice ?? 0) === 0);
      if (filled.length === 0) {
        toast({
          title: "No auto-fill candidates",
          description:
            "Booking.com, PM Companies, Vrbo, and Airbnb all returned nothing for these dates. Click 'Find buy-in' on any slot to retry the search manually (and to see reverse-image PM matches under each Airbnb row that you can click through to book direct).",
          variant: "destructive",
        });
      } else if (zeroCostFills.length === filled.length) {
        // All picks are unpriced. Detect whether at least one slot
        // attached a Vrbo URL (peak-season fallback when PM scrapers
        // confirmed booked) so the toast acknowledges that.
        const hasVrboPick = filled.some((r) => /(?:^|\.)vrbo\.com/.test(r.picked?.url ?? ""));
        toast({
          title: hasVrboPick
            ? `Attached ${filled.length} link${filled.length > 1 ? "s" : ""} — peak-season fallback`
            : `Attached ${filled.length} PM link${filled.length > 1 ? "s" : ""} — click 🔍 Verify rate per slot`,
          description: hasVrboPick
            ? `Most candidates were confirmed booked for these dates (peak season). Attached Vrbo URL${filled.length > 1 ? "s" : ""} for cross-check — click through to see what's listed there. The buy-in's Notes show every URL we checked and its booking status.`
            : `No priced PM/Booking candidate had live pricing, so we attached the top PM URL${filled.length > 1 ? "s" : ""} at $0. Use the 🔍 Verify rate button on each slot to fetch a screenshot of the page and (when possible) extract the price.`
            + (skipped.length ? ` · No URL found for: ${skipped.join(", ")}` : ""),
        });
      } else {
        const visionVerifiedCount = filled.filter((r) => r.visionVerified).length;
        const airbnbLastResortCount = filled.filter((r) => r.airbnbLastResort).length;
        toast({
          title: airbnbLastResortCount > 0
            ? `Filled ${filled.length} / ${results.length} units — ${airbnbLastResortCount} via Airbnb last-resort`
            : `Filled ${filled.length} / ${results.length} units`,
          description:
            `Total buy-in cost: $${totalCost.toLocaleString()} · Est. profit: $${estProfit.toLocaleString()}`
            + (visionVerifiedCount > 0 ? ` · ${visionVerifiedCount} verified via screenshot analysis` : "")
            + (zeroCostFills.length > 0 ? ` · ${zeroCostFills.length} attached at $0 (PM URL — update cost after PM contact)` : "")
            + (airbnbLastResortCount > 0 ? ` · ⚠️ ${airbnbLastResortCount} Airbnb URL${airbnbLastResortCount > 1 ? "s" : ""} attached as last-resort (TOS prohibits sublet — see slot notes)` : "")
            + (skipped.length ? ` · No PM/Booking/Airbnb candidate for: ${skipped.join(", ")} (open Find buy-in for those)` : ""),
        });
      }
      setAutoFilling(null);
    },
    onError: (e: any) => {
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
      setAutoFilling(null);
    },
  });

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
            Bookings · Buy-in tracking · Live search across Airbnb (telemetry), Booking.com, and PM companies (with reverse-image matches)
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
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

        {/* Bookings list — each is expandable to show unit slots */}
        {selectedPropertyId && !bookingsError && (
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
                          {r.fullyLinked ? (
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
                                  setAutoFilling(r._id);
                                  autoFillMutation.mutate({ reservation: r });
                                }}
                                disabled={autoFillMutation.isPending && autoFilling === r._id}
                                data-testid={`button-auto-fill-${r._id}`}
                              >
                                {autoFillMutation.isPending && autoFilling === r._id ? (
                                  <><RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" /> Searching…</>
                                ) : (
                                  <><Zap className="h-3.5 w-3.5 mr-1" /> Auto-fill cheapest</>
                                )}
                              </Button>
                            </div>
                            {autoFillMutation.isPending && autoFilling === r._id && (
                              <AutoFillProgress slotCount={r.slotsTotal - r.slotsFilled} />
                            )}
                          </div>
                        )}
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
                                  Find {slot.bedrooms}BR buy-in
                                </Button>
                              )}
                              {/* Per-slot toggle for the inline live-search
                                  panel. Auto-fill flips this on for every
                                  slot it touches; operators can also open
                                  it manually to compare alternatives. */}
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
        )}
      </div>

      {/* Candidate picker dialog — scoped to one slot */}
      <Dialog open={!!picker} onOpenChange={(open) => { if (!open) setPicker(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Find buy-in for {picker?.slot.unitLabel} <span className="text-muted-foreground font-normal">({picker?.slot.bedrooms} BR)</span>
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

type FindBuyInResponse = {
  community: string;
  resortName?: string | null;
  listingTitle?: string | null;
  bedrooms: number;
  nights: number;
  // Booking + PM are the preferred bookable channels and populate the
  // server's `cheapest` array. Vrbo is surfaced for awareness/manual
  // outreach. Airbnb is the CLIENT-SIDE last-resort: when nothing else
  // returns a usable URL, auto-fill walks `sources.airbnb` and attaches
  // the cheapest verified-priced one with a TOS-warning suffix in the
  // buy-in notes (Airbnb TOS prohibits sublet — operator handles the
  // booking channel manually).
  sources: {
    airbnb: LiveCandidate[];
    vrbo: LiveCandidate[];
    booking: LiveCandidate[];
    pm: LiveCandidate[];
  };
  cheapest: LiveCandidate[];
  // Same units as `cheapest` but grouped: when the same physical unit
  // is listed across multiple channels (Airbnb + VRBO + a PM site, all
  // sharing photos), they collapse into ONE row with a per-channel
  // sub-list. Shipped in PR #275 alongside the redundant-VRBO-provider
  // teardown — older deploys may not return this field, so the panel
  // falls back to the flat `cheapest` list.
  cheapestUnits?: LiveUnit[];
  debug?: {
    rawCounts?: { airbnb?: number; vrbo?: number; booking?: number; pm?: number; photoMatches?: number };
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
      available: boolean;
    };
    searchLocation?: string;
    vrboDestination?: string;
    resortName?: string | null;
  };
};

function sourceBadgeClass(src: string) {
  switch (src) {
    case "airbnb":  return "bg-[#FF5A5F] text-white";
    case "vrbo":    return "bg-blue-600 text-white";
    case "booking": return "bg-blue-800 text-white";
    case "pm":      return "bg-slate-600 text-white";
    default:        return "bg-muted";
  }
}

// Local-Mac sidecar status indicator. The buy-in tool delegates VRBO
// (and soon Booking + PM) scrapes to a daemon running on the
// operator's Mac, which drives their real Chrome via CDP. When the
// Mac is asleep / Claude Code closed without the daemon installed /
// daemon crashed, find-buy-in falls back to its existing 8 paths
// gracefully — but the operator should know they're getting the
// fallback experience, not the rich one. Polls /heartbeat every 30s
// while the buy-in panel is mounted.
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
        className="text-[10px] bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-300 cursor-help"
        title={
          state.ageMs != null
            ? `Local Mac sidecar polled ${Math.round(state.ageMs / 1000)}s ago — VRBO (and soon Booking/PM) drives through your real Chrome.`
            : "Local Mac sidecar online."
        }
      >
        🟢 Local sidecar online
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
      className="text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border-amber-400 cursor-help"
      title={tooltip}
    >
      ⚠ Can't reach Mac sidecar — fallback mode
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
  const [recordTarget, setRecordTarget] = useState<LiveCandidate | null>(null);

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

  // Auto-fires when the component mounts (i.e. when user clicks "Find buy-in").
  // No gating button — the whole point of the workflow is to see cheap live
  // options immediately without maintaining a manual portfolio of buy-ins.
  const { data, isLoading, isError, error, refetch } = useQuery<FindBuyInResponse>({
    queryKey: ["/api/operations/find-buy-in", propertyId, slot.bedrooms, checkInYmd, checkOutYmd],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/operations/find-buy-in?propertyId=${propertyId}&bedrooms=${slot.bedrooms}&checkIn=${checkInYmd}&checkOut=${checkOutYmd}`,
      ).then((r) => r.json()),
    enabled: !!checkInYmd && !!checkOutYmd,
    staleTime: 5 * 60 * 1000,
  });

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
              Searches Airbnb (telemetry), Booking.com, and PM companies for {slot.bedrooms}BR rentals in the area
              covering {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}.
            </p>
          </div>
          <Button size="sm" onClick={() => setEnabled(true)} data-testid="button-run-live-search">
            <Search className="h-3.5 w-3.5 mr-1.5" /> Search now
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="border rounded-lg p-6 text-center text-sm text-muted-foreground">
        <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
        Searching Airbnb (for photo matches), Booking.com, and property management companies for the cheapest {slot.bedrooms}BR rental covering {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="border rounded-lg p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 inline mr-1" /> Search failed: {(error as Error).message}
        <Button size="sm" variant="outline" className="ml-2" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  const airbnb  = data?.sources.airbnb  ?? [];
  const vrbo    = data?.sources.vrbo    ?? [];
  const booking = data?.sources.booking ?? [];
  const pm      = data?.sources.pm      ?? [];
  const cheapest = data?.cheapest       ?? [];
  const cheapestUnits = data?.cheapestUnits ?? [];
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
            Live results — {data?.resortName ?? data?.community} · {slot.bedrooms}BR · {data?.nights} nights
          </p>
          {data?.resortName && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Only listings within <b>{data.resortName}</b> are shown.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SidecarStatusBadge />
          <Button size="sm" variant="ghost" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </div>
      </div>
      {/* Raw hit counts + drop counts per source — lets us see why a source
          returned few results (upstream empty vs resort/bedroom filtered).
          PR #340: pm count now sums every per-PM scraper from
          pmSourceBreakdown rather than just the (legacy) Google-PM
          rawCount, which was always 0 since we deprecated the
          Google-PM path in PR #315. */}
      {data?.debug?.rawCounts && (
        <div className="text-[11px] text-muted-foreground -mt-1 space-y-0.5">
          <div>
            Raw: airbnb {data.debug.rawCounts.airbnb ?? 0} · vrbo {data.debug.rawCounts.vrbo ?? 0} · booking {data.debug.rawCounts.booking ?? 0} · pm {pmSourceBreakdown.reduce((a, s) => a + (s.count ?? 0), 0)}
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
      {cheapestUnits.length > 0 ? (
        <div className="border-2 border-green-500 rounded-lg p-3 bg-green-50/50 dark:bg-green-950/20">
          <p className="text-xs font-semibold text-green-700 mb-2 uppercase tracking-wide flex items-center gap-1.5">
            <TrendingDown className="h-3.5 w-3.5" />
            Cheapest {cheapestUnits.length} {cheapestUnits.length === 1 ? "unit" : "units"} — buy these
            {data?.debug?.verification?.attempted ? (
              <span className="text-[10px] font-normal text-green-700/80 normal-case tracking-normal ml-1">
                · verified bookable for {checkInYmd} → {checkOutYmd}
              </span>
            ) : null}
          </p>
          <div className="space-y-2">
            {cheapestUnits.map((u, i) => (
              <UnitRow
                key={`unit-${i}-${u.primaryUrl}`}
                unit={u}
                onRecord={(listing) => setRecordTarget(unitToCandidate(u, listing))}
                highlight
              />
            ))}
          </div>
        </div>
      ) : cheapest.length > 0 ? (
        // Backwards-compat fallback for old deploys that don't return
        // cheapestUnits — render the flat list as before.
        <div className="border-2 border-green-500 rounded-lg p-3 bg-green-50/50 dark:bg-green-950/20">
          <p className="text-xs font-semibold text-green-700 mb-2 uppercase tracking-wide flex items-center gap-1.5">
            <TrendingDown className="h-3.5 w-3.5" />
            Cheapest {cheapest.length} — buy these
            {data?.debug?.verification?.attempted ? (
              <span className="text-[10px] font-normal text-green-700/80 normal-case tracking-normal ml-1">
                · {data.debug.verification.yes} verified bookable for {checkInYmd} → {checkOutYmd}
              </span>
            ) : null}
          </p>
          <div className="space-y-2">
            {cheapest.map((c, i) => (
              <LiveRow key={`cheapest-${i}-${c.url}`} c={c} onRecord={() => setRecordTarget(c)} highlight />
            ))}
          </div>
        </div>
      ) : (
        <div className="border-2 border-dashed border-amber-400 rounded-lg p-3 bg-amber-50/50 dark:bg-amber-950/20">
          <p className="text-xs font-semibold text-amber-700 mb-1 uppercase tracking-wide flex items-center gap-1.5">
            <TrendingDown className="h-3.5 w-3.5" />
            No verified bookable options
          </p>
          <p className="text-[11px] text-amber-700/90">
            {data?.debug?.verification?.available === false
              ? "Verification path is unavailable on this deploy (BROWSERBASE_API_KEY / ANTHROPIC_API_KEY not set). All scanned options are listed below — verify each manually before recording."
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
      <ScannedOptionsTable
        airbnb={airbnb}
        vrbo={vrbo}
        booking={booking}
        pm={pm}
        autoPickUrl={cheapestUnits[0]?.primaryUrl ?? cheapest[0]?.url}
        checkIn={checkInYmd}
        checkOut={checkOutYmd}
        onRecord={(c) => setRecordTarget(c)}
      />

      {/* By-source sections.
          Airbnb stays as telemetry + photo source (the reverse-image PM
          matches under each row are bookable). Vrbo rows are now
          sidecar-priced only — raw Google/manual-quote rows are filtered
          server-side. Booking.com + PM Companies are the direct-bookable
          channels — both ALWAYS open. */}
      {[
        { key: "airbnb",  label: "Airbnb (telemetry — see PM matches below each row)", items: airbnb,  defaultOpen: airbnb.length > 0 && airbnb.length <= 3 },
        { key: "vrbo",    label: "Vrbo (sidecar-priced)", items: vrbo, defaultOpen: vrbo.length > 0 },
        { key: "booking", label: "Booking.com",   items: booking, defaultOpen: true },
        { key: "pm",      label: "PM Companies", items: pm, defaultOpen: true },
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

type SortKey = "source" | "title" | "total" | "nightly";
type SortDir = "asc" | "desc";

type VerifyState = {
  status: "idle" | "loading" | "yes" | "no" | "unclear" | "error";
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
        if (c.verified === "yes" && c.totalPrice > 0) {
          next[c.url] = {
            status: "yes",
            reason: c.verifiedReason ?? "Server returned this listing verified and priced for these dates",
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
    const nonAirbnb = all.filter((c) => c.source !== "airbnb" && c.verified !== "yes");
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

  const pricedCount = all.filter((c) => c.totalPrice > 0).length;
  const verifiedYesCount = sorted.filter((c) => verifyByUrl[c.url]?.status === "yes").length;
  const verifyingCount = sorted.filter((c) => verifyByUrl[c.url]?.status === "loading").length;
  const hiddenCount = sorted.length - visible.length;

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
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-1.5 text-[10px]"
        onClick={onVerify}
        title="Drives the listing page with Haiku to confirm availability for these dates (~$0.01)"
      >
        <CheckCircle2 className="h-2.5 w-2.5 mr-1" /> Verify
      </Button>
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
}: {
  unit: LiveUnit;
  onRecord: (listing: LiveUnitListing) => void;
  highlight?: boolean;
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
            ) : null}
            <div className="grow min-w-0">
              {l.nightlyPrice > 0 ? (
                <p className="text-[12px]">
                  <span className="font-semibold">{fmtMoney(l.nightlyPrice)}</span>
                  <span className="text-muted-foreground">/night ({fmtMoney(l.totalPrice)} total)</span>
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground italic">manual quote</p>
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
            >
              <ShoppingCart className="h-3 w-3 mr-1" /> Record
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveRow({ c, onRecord, highlight }: { c: LiveCandidate; onRecord: () => void; highlight?: boolean }) {
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
                ? Unclear — verify manually
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
            <p className="text-[11px] text-muted-foreground italic">manual quote</p>
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
          >
            <ShoppingCart className="h-3 w-3 mr-1" /> Record
          </Button>
        </div>
      </div>
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
                {manualPm.name} requires a manual quote
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
        costPaid: Number(costPaid),
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
      if (!attach?.success) throw new Error(attach?.error || "Attach failed");
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
            disabled={!costPaid || createAndAttach.isPending}
            data-testid="button-save-buy-in"
          >
            {createAndAttach.isPending ? "Saving…" : "Save & attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
