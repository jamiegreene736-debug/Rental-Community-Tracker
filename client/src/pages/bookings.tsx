import { useState, useMemo } from "react";
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
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Building2, Calendar, Search, Link2, Unlink, ExternalLink,
  RefreshCw, AlertCircle, CheckCircle2, TrendingUp, TrendingDown, BedDouble,
  ChevronDown, ChevronRight, Globe, ShoppingCart, Zap,
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

      const results = await Promise.all(
        emptySlots.map(async (slot) => {
          const url = `/api/operations/find-buy-in?propertyId=${selectedPropertyId}&bedrooms=${slot.bedrooms}&checkIn=${ci}&checkOut=${co}`;
          const data = (await apiRequest("GET", url).then((r) => r.json())) as FindBuyInResponse;

          // Walk cheapest-first and run an availability pre-flight on each
          // Airbnb pick. Non-Airbnb sources aren't verifiable via SearchAPI
          // so they're treated as "unknown" (we don't block). We take the
          // first candidate that's verified-available or unknown. This
          // catches races where the listing got booked between initial
          // search and the attach click.
          // The server's `cheapest` is either up to 2 priced candidates OR
          // the single-entry unpriced PM fallback (PR #148) when nothing
          // priced exists. Split them so the verification loop only runs
          // on priced ones, and we still attach the unpriced PM URL when
          // the fallback fires (operator edits cost after booking).
          const allCheapest = data.cheapest ?? [];
          const pricedCandidates = allCheapest.filter((c) => c.totalPrice > 0);
          const unpricedFallback = allCheapest.filter((c) => c.totalPrice === 0);
          let pick: LiveCandidate | null = null;
          let verifiedPrice: number | null = null;
          let skippedReasons: string[] = [];

          for (const c of pricedCandidates.slice(0, 4)) {
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

          // No priced candidate verified. Try to extract real pricing from
          // the unpriced PM URLs by running the headless-screenshot +
          // Claude-vision verifier against the top few. First one that
          // yields { isUnitPage: true, available !== false, totalPrice > 0,
          // dateMatch !== false } wins, and we attach with the verified
          // price. If all extractions fail, fall back to attaching the top
          // unpriced URL at $0 (operator edits cost after contacting PM).
          let visionVerified: { reason?: string; screenshotBase64?: string } | null = null;
          if (!pick) {
            // Cap at 2 candidates to bound the auto-fill wall-clock time
            // (~10s per verify × 2 candidates × 2 slots ≈ 40s worst case).
            const unpricedPmCandidates = (data.sources?.pm ?? []).filter((c) => c.totalPrice === 0).slice(0, 2);
            for (const c of unpricedPmCandidates) {
              try {
                const v = await apiRequest("POST", "/api/operations/verify-pm-listing", {
                  url: c.url,
                  checkIn: ci,
                  checkOut: co,
                }).then((r) => r.json());
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
                  visionVerified = { reason: ex.reason, screenshotBase64: v.screenshotBase64 };
                  break;
                }
                skippedReasons.push(`${c.sourceLabel}: ${ex?.reason ?? v?.reason ?? "vision-no-price"}`);
              } catch (e: any) {
                skippedReasons.push(`${c.sourceLabel}: verify-error ${e?.message ?? ""}`.trim());
              }
            }
          }

          // Final fallback: server's unpricedFallback at $0. Lets the slot
          // at least point at a clickable PM URL when vision extraction
          // also failed (anti-bot interstitials, no unit pages, etc.).
          if (!pick && unpricedFallback.length > 0) {
            pick = unpricedFallback[0];
          }

          if (!pick) return { slot, picked: null, created: null, skippedReasons, visionVerified: false };

          const finalCost = verifiedPrice ?? pick.totalPrice;
          const propertyName =
            (selectedListingId && listingNameById.get(selectedListingId)) ||
            `Property ${selectedPropertyId}`;
          const noteSuffix = visionVerified
            ? ` · Verified via screenshot analysis ($${finalCost} for ${slot.bedrooms}BR ${ci}→${co})`
            : "";
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
            notes: `Auto-filled from ${pick.sourceLabel} — ${pick.title}${noteSuffix}`,
            status: "active",
          }).then((r) => r.json());
          if (!created?.id) throw new Error(`Create failed for ${slot.unitLabel}`);

          await apiRequest("POST", `/api/bookings/${reservation._id}/attach-buy-in`, {
            buyInId: created.id,
          }).then((r) => r.json());

          return { slot, picked: { ...pick, totalPrice: finalCost }, created, skippedReasons, visionVerified: visionVerified !== null };
        }),
      );
      return { reservation, results };
    },
    onSuccess: ({ reservation, results }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
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
            "Booking.com and PM Companies didn't return any candidates for the dates. Click 'Find buy-in' on any slot to see Airbnb listings (with reverse-image PM matches you can click through to book direct).",
          variant: "destructive",
        });
      } else if (zeroCostFills.length === filled.length) {
        // All picks are unpriced PM URLs.
        toast({
          title: `Attached ${filled.length} PM link${filled.length > 1 ? "s" : ""} — pricing pending`,
          description:
            `No priced PM/Booking candidate had live pricing, so we attached the top PM URL${filled.length > 1 ? "s" : ""} at $0. Click the link in the slot to see the PM site's actual price, then edit the buy-in cost.`
            + (skipped.length ? ` · No PM URL found for: ${skipped.join(", ")}` : ""),
        });
      } else {
        const visionVerifiedCount = filled.filter((r) => r.visionVerified).length;
        toast({
          title: `Filled ${filled.length} / ${results.length} units`,
          description:
            `Total buy-in cost: $${totalCost.toLocaleString()} · Est. profit: $${estProfit.toLocaleString()}`
            + (visionVerifiedCount > 0 ? ` · ${visionVerifiedCount} verified via screenshot analysis` : "")
            + (zeroCostFills.length > 0 ? ` · ${zeroCostFills.length} attached at $0 (PM URL — update cost after PM contact)` : "")
            + (skipped.length ? ` · No PM/Booking candidate for: ${skipped.join(", ")} (open Find buy-in for those)` : ""),
        });
      }
      setAutoFilling(null);
    },
    onError: (e: any) => {
      toast({ title: "Auto-fill failed", description: e.message, variant: "destructive" });
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
                          <div className="flex items-center justify-between gap-3 bg-primary/5 border border-primary/20 rounded px-3 py-2">
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
                        )}
                        {r.slots.map((slot) => (
                          <div
                            key={slot.unitId}
                            className="flex items-center gap-3 bg-background rounded border px-3 py-2.5"
                            data-testid={`slot-${r._id}-${slot.unitId}`}
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
                                    </p>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-xs text-muted-foreground italic">No buy-in attached for this unit</p>
                              )}
                            </div>
                            <div className="shrink-0">
                              {slot.buyIn ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => slot.buyIn && detachMutation.mutate(slot.buyIn.id)}
                                  disabled={detachMutation.isPending}
                                  data-testid={`button-detach-${r._id}-${slot.unitId}`}
                                >
                                  <Unlink className="h-3.5 w-3.5 mr-1" /> Detach
                                </Button>
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
                            </div>
                          </div>
                        ))}
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
              onAttach={(buyInId) =>
                attachMutation.mutate({ reservationId: picker.reservation._id, buyInId })
              }
              isPending={attachMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Candidate list component ───────────────────────────────────────────────

function CandidateList({
  reservation,
  propertyId,
  slot,
  onAttach,
  isPending,
}: {
  reservation: GuestyReservation;
  propertyId: number;
  slot: SlotInfo;
  onAttach: (buyInId: number) => void;
  isPending: boolean;
}) {
  // Server validates YYYY-MM-DD — slice off the time portion of Guesty's ISO
  // timestamps, or use the already-localized date-only field when available.
  const toDateOnly = (s: string | undefined): string => {
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s.slice(0, 10);
  };
  const checkInYmd = toDateOnly(reservation.checkInDateLocalized ?? reservation.checkIn);
  const checkOutYmd = toDateOnly(reservation.checkOutDateLocalized ?? reservation.checkOut);

  const { data, isLoading, isError, error } = useQuery<{ candidates: Candidate[]; bookingNights: number; count: number }>({
    queryKey: [
      "/api/bookings/candidates",
      reservation._id,
      propertyId,
      slot.unitId,
      checkInYmd,
      checkOutYmd,
    ],
    queryFn: () => {
      const url = `/api/bookings/${reservation._id}/buy-in-candidates?propertyId=${propertyId}&unitId=${encodeURIComponent(slot.unitId)}&checkIn=${checkInYmd}&checkOut=${checkOutYmd}`;
      return apiRequest("GET", url).then((r) => r.json());
    },
    enabled: !!checkInYmd && !!checkOutYmd,
  });

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
        Finding candidates…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="py-6 text-center text-sm text-destructive">
        <AlertCircle className="h-5 w-5 mx-auto mb-2" />
        {(error as Error).message}
      </div>
    );
  }

  const candidates = data?.candidates ?? [];

  // Skip the "no eligible buy-ins" dead-end — we go straight to live search
  // instead of asking the user to maintain their own buy-in portfolio.

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto">
      {/* ── Existing buy-ins from DB (hidden if none — no need to nag) ─── */}
      {candidates.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Existing buy-ins ({candidates.length})
          </p>
          {candidates.map((c, idx) => (
            <div
              key={c.buyIn.id}
              className={`border rounded-lg p-3 flex items-center gap-3 ${idx === 0 ? "border-green-500 bg-green-50/50 dark:bg-green-950/20" : ""}`}
              data-testid={`candidate-${c.buyIn.id}`}
            >
              <div className="grow min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <p className="font-medium text-sm truncate">{c.buyIn.unitLabel}</p>
                  {idx === 0 && <Badge className="bg-green-600 text-white text-[10px]">Cheapest</Badge>}
                  {c.wastedNights > 0 && (
                    <Badge variant="outline" className="text-[10px]">{c.wastedNights} unused nights</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-3">
                  <span>
                    <Calendar className="h-3 w-3 inline mr-0.5" />
                    {fmtDate(c.buyIn.checkIn)} → {fmtDate(c.buyIn.checkOut)} · {c.buyInNights}n
                  </span>
                  {c.buyIn.airbnbConfirmation && (
                    <span className="font-mono">#{c.buyIn.airbnbConfirmation}</span>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="font-semibold text-sm">{fmtMoney(c.totalCost)}</p>
                <p className="text-[10px] text-muted-foreground">
                  {fmtMoney(c.costPerNight)}/night
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => onAttach(c.buyIn.id)}
                disabled={isPending}
                data-testid={`button-attach-${c.buyIn.id}`}
              >
                <Link2 className="h-3.5 w-3.5 mr-1" /> Attach
              </Button>
            </div>
          ))}
        </div>
      )}

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
  source: "airbnb" | "booking" | "pm";
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
  // unit listed for direct booking). Only populated for the top 2
  // Airbnb candidates server-side. Zero-length when no matches were
  // found OR the candidate isn't one of the top 2.
  photoMatches?: Array<{ url: string; title: string; domain: string }>;
};

type FindBuyInResponse = {
  community: string;
  resortName?: string | null;
  listingTitle?: string | null;
  bedrooms: number;
  nights: number;
  // VRBO removed — same TOS subletting restriction as Airbnb makes it
  // an unusable buy-in channel. Airbnb stays as telemetry/photo-source.
  sources: {
    airbnb: LiveCandidate[];
    booking: LiveCandidate[];
    pm: LiveCandidate[];
  };
  cheapest: LiveCandidate[];
  debug?: {
    rawCounts?: { airbnb?: number; booking?: number; pm?: number; photoMatches?: number };
    dropped?: {
      airbnb?: { noResort: number; wrongBedrooms: number };
      booking?: { noResort: number; wrongBedrooms: number };
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
  const booking = data?.sources.booking ?? [];
  const pm      = data?.sources.pm      ?? [];
  const cheapest = data?.cheapest       ?? [];

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
        <Button size="sm" variant="ghost" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>
      {/* Raw hit counts + drop counts per source — lets us see why a source
          returned few results (upstream empty vs resort/bedroom filtered). */}
      {data?.debug?.rawCounts && (
        <div className="text-[11px] text-muted-foreground -mt-1 space-y-0.5">
          <div>
            Raw: airbnb {data.debug.rawCounts.airbnb ?? 0} · booking {data.debug.rawCounts.booking ?? 0} · pm {data.debug.rawCounts.pm ?? 0}
            {typeof (data.debug.rawCounts as any).photoMatches === "number" && (
              <> · photo-matches {(data.debug.rawCounts as any).photoMatches}</>
            )}
          </div>
          {data.debug.dropped && (
            <div>
              Dropped (wrong resort / bedrooms):
              {" "}airbnb {data.debug.dropped.airbnb?.noResort ?? 0}/{data.debug.dropped.airbnb?.wrongBedrooms ?? 0} ·
              {" "}booking {data.debug.dropped.booking?.noResort ?? 0}/{data.debug.dropped.booking?.wrongBedrooms ?? 0}
            </div>
          )}
        </div>
      )}

      {/* Cheapest callout */}
      {cheapest.length > 0 && (
        <div className="border-2 border-green-500 rounded-lg p-3 bg-green-50/50 dark:bg-green-950/20">
          <p className="text-xs font-semibold text-green-700 mb-2 uppercase tracking-wide">
            <TrendingDown className="h-3.5 w-3.5 inline mr-1" />
            Cheapest {cheapest.length} — buy these
          </p>
          <div className="space-y-2">
            {cheapest.map((c, i) => (
              <LiveRow key={`cheapest-${i}-${c.url}`} c={c} onRecord={() => setRecordTarget(c)} highlight />
            ))}
          </div>
        </div>
      )}

      {/* By-source sections.
          VRBO removed — same TOS bar on guest-side subletting as Airbnb,
          so any VRBO listing surfaced here would be an unusable channel.
          Airbnb stays as telemetry + photo source for the reverse-image
          matches rendered inside each Airbnb row (see LiveRow). */}
      {/* Section open-by-default rules:
          - Booking.com and PM Companies — ALWAYS open. These are the
            actually-bookable channels (PR #144 / #145 work — Airbnb's
            TOS bars subletting, so it's telemetry-only). The operator
            needs to see PM links every time they Find buy-in; making
            them click-to-expand was the bug Jamie reported.
          - Airbnb — open only when a small number of results (otherwise
            collapsed since it's reference-only, with reverse-image PM
            matches rendered under each row that the operator can
            actually click through). */}
      {[
        { key: "airbnb",  label: "Airbnb (telemetry — see PM matches below each row)", items: airbnb,  defaultOpen: airbnb.length > 0 && airbnb.length <= 3 },
        { key: "booking", label: "Booking.com",   items: booking, defaultOpen: true },
        { key: "pm",      label: "PM Companies (Google)", items: pm, defaultOpen: true },
      ].map((s) => (
        <details key={s.key} open={s.defaultOpen}>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground flex items-center gap-2 py-1.5">
            <Badge className={`text-[10px] ${sourceBadgeClass(s.key)}`}>{s.label}</Badge>
            <span>{s.items.length} results</span>
          </summary>
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
