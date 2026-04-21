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
  ChevronDown, ChevronRight, Globe, ShoppingCart,
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
  money?: { hostPayout?: number; fareAccommodation?: number; netIncome?: number };
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
            Bookings · Buy-in tracking · Live search across Airbnb, Vrbo, Booking.com, and PM companies
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
              {/* Sortable column headers — click any to re-sort */}
              {reservations.length > 0 && (
                <div className="px-4 py-2 border-b text-[10px] uppercase tracking-wider text-muted-foreground grid grid-cols-[1.5fr_1.5fr_1fr_1fr_1fr_auto] gap-3 items-center">
                  <span className="pl-7" /> {/* spacer for chevron + expand icon */}
                  <SortHeader label="Guest" active={sortBy === "guest"} dir={sortDir} onClick={() => toggleSort("guest")} />
                  <SortHeader label="Check-in" active={sortBy === "checkIn"} dir={sortDir} onClick={() => toggleSort("checkIn")} />
                  <SortHeader label="Payout" active={sortBy === "payout"} dir={sortDir} onClick={() => toggleSort("payout")} align="right" />
                  <SortHeader label="Buy-in" active={sortBy === "buyIn"} dir={sortDir} onClick={() => toggleSort("buyIn")} align="right" />
                  <SortHeader label="Profit" active={sortBy === "profit"} dir={sortDir} onClick={() => toggleSort("profit")} align="right" />
                  <SortHeader label="Fill" active={sortBy === "status"} dir={sortDir} onClick={() => toggleSort("status")} />
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
                          <p className="text-[10px] text-muted-foreground">guest payout</p>
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
                                          view on Airbnb <ExternalLink className="h-2.5 w-2.5" />
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
                  {fmtDate(picker.reservation.checkIn)} → {fmtDate(picker.reservation.checkOut)} ·{" "}
                  {picker.reservation.nightsCount ?? nightsBetween(picker.reservation.checkIn, picker.reservation.checkOut)} nights
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
  const { data, isLoading, isError, error } = useQuery<{ candidates: Candidate[]; bookingNights: number; count: number }>({
    queryKey: [
      "/api/bookings/candidates",
      reservation._id,
      propertyId,
      slot.unitId,
      reservation.checkIn,
      reservation.checkOut,
    ],
    queryFn: () => {
      const url = `/api/bookings/${reservation._id}/buy-in-candidates?propertyId=${propertyId}&unitId=${encodeURIComponent(slot.unitId)}&checkIn=${reservation.checkIn}&checkOut=${reservation.checkOut}`;
      return apiRequest("GET", url).then((r) => r.json());
    },
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

  if (candidates.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <Search className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="font-medium mb-1">No eligible buy-ins found</p>
        <p className="text-xs">
          No active buy-ins for {slot.unitLabel} ({slot.bedrooms} BR) cover {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}.
          Add one in the Buy-In Tracker first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto">
      {/* ── Existing buy-ins from DB ─────────────────────────────────── */}
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

      {candidates.length === 0 && (
        <div className="py-4 text-center text-sm text-muted-foreground border rounded-lg bg-muted/30">
          <Search className="h-5 w-5 mx-auto mb-1 opacity-40" />
          No existing buy-ins cover these dates — shop live below.
        </div>
      )}

      {/* ── Live multi-source search ─────────────────────────────────── */}
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
};

type FindBuyInResponse = {
  community: string;
  bedrooms: number;
  nights: number;
  sources: {
    airbnb: LiveCandidate[];
    vrbo: LiveCandidate[];
    booking: LiveCandidate[];
    pm: LiveCandidate[];
  };
  cheapest: LiveCandidate[];
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
  const [enabled, setEnabled] = useState(false);
  const [recordTarget, setRecordTarget] = useState<LiveCandidate | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery<FindBuyInResponse>({
    queryKey: ["/api/operations/find-buy-in", propertyId, slot.bedrooms, reservation.checkIn, reservation.checkOut],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/operations/find-buy-in?propertyId=${propertyId}&bedrooms=${slot.bedrooms}&checkIn=${reservation.checkIn}&checkOut=${reservation.checkOut}`,
      ).then((r) => r.json()),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  if (!enabled) {
    return (
      <div className="border rounded-lg p-4 bg-blue-50 dark:bg-blue-950/20">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="font-medium text-sm flex items-center gap-1.5">
              <Globe className="h-4 w-4" /> Live search
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Searches Airbnb, Vrbo, Booking.com, and Google for {slot.bedrooms}BR rentals in the area
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
        Searching Airbnb, Vrbo, Booking.com, and PM companies…
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Live results — {data?.community} · {slot.bedrooms}BR · {data?.nights} nights
        </p>
        <Button size="sm" variant="ghost" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>

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

      {/* By-source sections */}
      {[
        { key: "airbnb",  label: "Airbnb",        items: airbnb  },
        { key: "vrbo",    label: "Vrbo",          items: vrbo    },
        { key: "booking", label: "Booking.com",   items: booking },
        { key: "pm",      label: "PM Companies (Google)", items: pm },
      ].map((s) => (
        <details key={s.key} open={s.items.length > 0 && s.items.length <= 3}>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground flex items-center gap-2 py-1.5">
            <Badge className={`text-[10px] ${sourceBadgeClass(s.key)}`}>{s.label}</Badge>
            <span>{s.items.length} results</span>
          </summary>
          {s.items.length === 0 ? (
            <p className="text-xs text-muted-foreground pl-2 py-2">No results.</p>
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
  return (
    <div
      className={`border rounded-lg p-2.5 flex items-start gap-2.5 ${highlight ? "bg-white dark:bg-background" : ""}`}
    >
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
        {c.nightlyPrice > 0 && (
          <Button
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={onRecord}
          >
            <ShoppingCart className="h-3 w-3 mr-1" /> Record
          </Button>
        )}
      </div>
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

  const createAndAttach = useMutation({
    mutationFn: async () => {
      const body = {
        propertyId,
        unitId: slot.unitId,
        unitLabel: slot.unitLabel,
        bedrooms: slot.bedrooms,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
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
