import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Building2, Calendar, DollarSign, Search, Link2, Unlink, ExternalLink,
  RefreshCw, AlertCircle, CheckCircle2, TrendingUp, TrendingDown,
} from "lucide-react";
import type { BuyIn, GuestyPropertyMap } from "@shared/schema";

// ─── Types ───────────────────────────────────────────────────────────────────

interface GuestyReservation {
  _id: string;
  status: string;
  checkIn: string;
  checkOut: string;
  nightsCount?: number;
  guest?: { fullName?: string; firstName?: string; email?: string };
  money?: { hostPayout?: number; fareAccommodation?: number; netIncome?: number };
  source?: string;
  integration?: { platform?: string };
  confirmationCode?: string;
  attachedBuyIn?: BuyIn | null;
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

function fmtDate(s: string | undefined | null): string {
  if (!s) return "—";
  return new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function nightsBetween(a: string, b: string): number {
  return Math.max(1, Math.round((+new Date(b) - +new Date(a)) / 86400000));
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Bookings() {
  const { toast } = useToast();
  const [selectedPropertyId, setSelectedPropertyId] = useState<number | null>(null);
  const [includePast, setIncludePast] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerReservation, setPickerReservation] = useState<GuestyReservation | null>(null);

  // Load Guesty property map so we can present listings by propertyId
  const { data: propertyMap = [] } = useQuery<GuestyPropertyMap[]>({
    queryKey: ["/api/guesty-property-map"],
  });

  const selectedMapping = propertyMap.find((m) => m.propertyId === selectedPropertyId);
  const selectedListingId = selectedMapping?.guestyListingId ?? null;

  // Bookings for the selected listing
  const {
    data: bookingsData,
    isLoading: bookingsLoading,
    isError: bookingsError,
    error: bookingsErr,
    refetch: refetchBookings,
  } = useQuery<{ reservations: GuestyReservation[]; total: number }>({
    queryKey: ["/api/bookings/listing", selectedListingId, { includePast }],
    queryFn: () => {
      if (!selectedListingId) return Promise.resolve({ reservations: [], total: 0 });
      const url = `/api/bookings/listing/${encodeURIComponent(selectedListingId)}?includePast=${includePast}`;
      return apiRequest("GET", url).then((r) => r.json());
    },
    enabled: !!selectedListingId,
    refetchInterval: 120_000,
  });

  const reservations = bookingsData?.reservations ?? [];

  // Attach / detach mutations
  const attachMutation = useMutation({
    mutationFn: ({ reservationId, buyInId }: { reservationId: string; buyInId: number }) =>
      apiRequest("POST", `/api/bookings/${reservationId}/attach-buy-in`, { buyInId }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      setPickerOpen(false);
      setPickerReservation(null);
      toast({ title: "Buy-in attached" });
    },
    onError: (e: any) => toast({ title: "Attach failed", description: e.message, variant: "destructive" }),
  });

  const detachMutation = useMutation({
    mutationFn: (reservationId: string) =>
      apiRequest("POST", `/api/bookings/${reservationId}/detach-buy-in`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings/listing", selectedListingId] });
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      toast({ title: "Buy-in detached" });
    },
    onError: (e: any) => toast({ title: "Detach failed", description: e.message, variant: "destructive" }),
  });

  const openPicker = (r: GuestyReservation) => {
    setPickerReservation(r);
    setPickerOpen(true);
  };

  // Summary stats for current view
  const stats = useMemo(() => {
    if (!reservations.length) return null;
    const linked = reservations.filter((r) => r.attachedBuyIn);
    const totalRevenue = reservations.reduce((s, r) => s + (r.money?.hostPayout ?? 0), 0);
    const totalBuyInCost = linked.reduce((s, r) => s + parseFloat(String(r.attachedBuyIn?.costPaid ?? 0)), 0);
    return {
      total: reservations.length,
      linked: linked.length,
      unlinked: reservations.length - linked.length,
      totalRevenue,
      totalBuyInCost,
      profit: totalRevenue - totalBuyInCost,
    };
  }, [reservations]);

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
          <h1 className="font-semibold text-lg leading-tight">Bookings</h1>
          <p className="text-xs text-muted-foreground">Guesty reservations · attach buy-ins for cost tracking</p>
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
              <div className="grow min-w-[240px]">
                <Label className="text-xs mb-1.5 block">Property</Label>
                <Select
                  value={selectedPropertyId?.toString() ?? ""}
                  onValueChange={(v) => setSelectedPropertyId(v ? parseInt(v, 10) : null)}
                >
                  <SelectTrigger data-testid="select-property">
                    <SelectValue placeholder="Select a property..." />
                  </SelectTrigger>
                  <SelectContent>
                    {propertyMap
                      .slice()
                      .sort((a, b) => a.propertyId - b.propertyId)
                      .map((m) => (
                        <SelectItem key={m.propertyId} value={m.propertyId.toString()}>
                          Property {m.propertyId}{" "}
                          <span className="text-muted-foreground">· listing {m.guestyListingId.slice(-8)}</span>
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
            </div>
          </CardContent>
        </Card>

        {!selectedPropertyId && (
          <Card>
            <CardContent className="py-12 text-center">
              <Building2 className="h-10 w-10 mx-auto mb-3 opacity-20" />
              <p className="font-medium mb-1">Select a property to view bookings</p>
              <p className="text-sm text-muted-foreground">
                Bookings are pulled from Guesty for the linked listing.
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
                  {stats.linked} with buy-in · {stats.unlinked} without
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
                <p className="text-xs text-muted-foreground">Buy-In Cost (linked)</p>
                <p className="text-2xl font-semibold mt-1">{fmtMoney(stats.totalBuyInCost)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Profit (linked)</p>
                <p className={`text-2xl font-semibold mt-1 ${stats.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {stats.profit >= 0 ? <TrendingUp className="h-4 w-4 inline mr-1" /> : <TrendingDown className="h-4 w-4 inline mr-1" />}
                  {fmtMoney(stats.profit)}
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Bookings table */}
        {selectedPropertyId && !bookingsError && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="h-4 w-4" /> Reservations
                {bookingsLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
              </CardTitle>
              <CardDescription>
                Attach a buy-in to each reservation to track cost/profit. Only buy-ins whose dates fully cover the guest stay are eligible.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!bookingsLoading && reservations.length === 0 && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No bookings found for this listing.
                </p>
              )}
              {reservations.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Guest</TableHead>
                      <TableHead>Dates</TableHead>
                      <TableHead className="text-center">Nights</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead className="text-right">Guest Payout</TableHead>
                      <TableHead>Buy-In</TableHead>
                      <TableHead className="text-right">Profit</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reservations.map((r) => {
                      const nights = r.nightsCount ?? nightsBetween(r.checkIn, r.checkOut);
                      const payout = r.money?.hostPayout ?? 0;
                      const buyInCost = r.attachedBuyIn ? parseFloat(String(r.attachedBuyIn.costPaid)) : 0;
                      const profit = r.attachedBuyIn ? payout - buyInCost : null;
                      const channel = r.integration?.platform ?? r.source ?? "direct";
                      return (
                        <TableRow key={r._id} data-testid={`booking-row-${r._id}`}>
                          <TableCell>
                            <div className="min-w-0">
                              <p className="font-medium text-sm truncate">{r.guest?.fullName ?? r.guest?.firstName ?? "Guest"}</p>
                              {r.confirmationCode && (
                                <p className="text-[10px] text-muted-foreground font-mono">{r.confirmationCode}</p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm">
                            <p>{fmtDate(r.checkIn)}</p>
                            <p className="text-muted-foreground text-xs">→ {fmtDate(r.checkOut)}</p>
                          </TableCell>
                          <TableCell className="text-center text-sm">{nights}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] capitalize">{channel}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-medium">{fmtMoney(payout)}</TableCell>
                          <TableCell>
                            {r.attachedBuyIn ? (
                              <div>
                                <p className="text-sm font-medium">{fmtMoney(r.attachedBuyIn.costPaid)}</p>
                                <p className="text-[10px] text-muted-foreground truncate max-w-[200px]">
                                  {r.attachedBuyIn.airbnbConfirmation ?? r.attachedBuyIn.unitLabel}
                                  {r.attachedBuyIn.airbnbListingUrl && (
                                    <a
                                      href={r.attachedBuyIn.airbnbListingUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="ml-1 text-primary hover:underline inline-flex items-center"
                                    >
                                      <ExternalLink className="h-2.5 w-2.5" />
                                    </a>
                                  )}
                                </p>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground italic">No buy-in</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {profit !== null ? (
                              <span className={`font-medium ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                                {fmtMoney(profit)}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {r.attachedBuyIn ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => detachMutation.mutate(r._id)}
                                disabled={detachMutation.isPending}
                                data-testid={`button-detach-${r._id}`}
                              >
                                <Unlink className="h-3.5 w-3.5 mr-1" /> Detach
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => openPicker(r)}
                                data-testid={`button-find-buyin-${r._id}`}
                              >
                                <Search className="h-3.5 w-3.5 mr-1" /> Find buy-in
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Candidate picker dialog */}
      <Dialog open={pickerOpen} onOpenChange={(open) => { if (!open) { setPickerOpen(false); setPickerReservation(null); } }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Find a buy-in</DialogTitle>
            <DialogDescription>
              {pickerReservation && (
                <span>
                  {pickerReservation.guest?.fullName ?? "Guest"} · {fmtDate(pickerReservation.checkIn)} → {fmtDate(pickerReservation.checkOut)}
                  {" · "}
                  {pickerReservation.nightsCount ?? nightsBetween(pickerReservation.checkIn, pickerReservation.checkOut)} nights
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {pickerReservation && selectedPropertyId && (
            <CandidateList
              reservation={pickerReservation}
              propertyId={selectedPropertyId}
              onAttach={(buyInId) =>
                attachMutation.mutate({ reservationId: pickerReservation._id, buyInId })
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
  onAttach,
  isPending,
}: {
  reservation: GuestyReservation;
  propertyId: number;
  onAttach: (buyInId: number) => void;
  isPending: boolean;
}) {
  const { data, isLoading, isError, error } = useQuery<{ candidates: Candidate[]; bookingNights: number; count: number }>({
    queryKey: ["/api/bookings/candidates", reservation._id, propertyId, reservation.checkIn, reservation.checkOut],
    queryFn: () => {
      const url = `/api/bookings/${reservation._id}/buy-in-candidates?propertyId=${propertyId}&checkIn=${reservation.checkIn}&checkOut=${reservation.checkOut}`;
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
          No active buy-ins for Property {propertyId} cover {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}.
          Add a buy-in in the Buy-In Tracker first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-[400px] overflow-y-auto">
      <p className="text-xs text-muted-foreground mb-2">
        <CheckCircle2 className="h-3.5 w-3.5 inline mr-1 text-green-600" />
        {candidates.length} eligible — sorted cheapest first
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
  );
}
