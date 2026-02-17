import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  DollarSign,
  TrendingUp,
  TrendingDown,
  ShoppingCart,
  RefreshCw,
  Plus,
  Trash2,
  Calendar,
  BarChart3,
  FileText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Search,
  Star,
  Sparkles,
  Award,
  BedDouble,
  MapPin,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { BuyIn, LodgifyBooking } from "@shared/schema";
import { getPropertyPricing, getAllUnitPricings, type PropertyPricing, type UnitPricing } from "@/data/pricing-data";
import { getAllMultiUnitProperties } from "@/data/unit-builder-data";

type ReportSummary = {
  totalBuyInCost: number;
  totalRevenue: number;
  totalProfit: number;
  totalBuyIns: number;
  activeBuyIns: number;
  totalBookings: number;
  monthlyBreakdown: {
    month: string;
    buyInCost: number;
    revenue: number;
    profit: number;
    buyIns: number;
    bookings: number;
  }[];
};

function formatCurrency(amount: number | string | null): string {
  const num = typeof amount === "string" ? parseFloat(amount) : (amount ?? 0);
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function NewBuyInDialog({ onSuccess }: { onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [selectedPropertyId, setSelectedPropertyId] = useState<number | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string>("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [costPaid, setCostPaid] = useState("");
  const [airbnbConfirmation, setAirbnbConfirmation] = useState("");
  const [airbnbListingUrl, setAirbnbListingUrl] = useState("");
  const [notes, setNotes] = useState("");
  const { toast } = useToast();

  const allProperties = getAllMultiUnitProperties();
  const selectedPricing = selectedPropertyId ? getPropertyPricing(selectedPropertyId) : null;
  const selectedProperty = allProperties.find(p => p.propertyId === selectedPropertyId);
  const selectedUnit = selectedPricing?.units.find(u => u.unitId === selectedUnitId);

  const suggestedCost = selectedUnit ? selectedUnit.baseBuyIn : null;

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/buy-ins", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/summary"] });
      toast({ title: "Buy-in recorded successfully" });
      resetForm();
      setOpen(false);
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create buy-in", description: err.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setSelectedPropertyId(null);
    setSelectedUnitId("");
    setCheckIn("");
    setCheckOut("");
    setCostPaid("");
    setAirbnbConfirmation("");
    setAirbnbListingUrl("");
    setNotes("");
  };

  const handleSubmit = () => {
    if (!selectedPropertyId || !selectedUnitId || !checkIn || !checkOut || !costPaid) {
      toast({ title: "Please fill in all required fields", variant: "destructive" });
      return;
    }

    const unitLabel = selectedUnit?.unitLabel || selectedUnitId;
    const propertyName = selectedProperty?.propertyName || `Property ${selectedPropertyId}`;

    createMutation.mutate({
      propertyId: selectedPropertyId,
      unitId: selectedUnitId,
      propertyName,
      unitLabel,
      checkIn,
      checkOut,
      costPaid,
      airbnbConfirmation: airbnbConfirmation || null,
      airbnbListingUrl: airbnbListingUrl || null,
      notes: notes || null,
      status: "active",
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-new-buyin">
          <Plus className="h-4 w-4 mr-2" />
          Record Buy-In
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record New Buy-In</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div>
            <Label>Property</Label>
            <Select
              value={selectedPropertyId ? String(selectedPropertyId) : ""}
              onValueChange={(v) => { setSelectedPropertyId(parseInt(v, 10)); setSelectedUnitId(""); }}
            >
              <SelectTrigger data-testid="select-property">
                <SelectValue placeholder="Select property" />
              </SelectTrigger>
              <SelectContent>
                {allProperties.map(p => (
                  <SelectItem key={p.propertyId} value={String(p.propertyId)}>
                    {p.propertyName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedPricing && (
            <div>
              <Label>Unit</Label>
              <Select value={selectedUnitId} onValueChange={setSelectedUnitId}>
                <SelectTrigger data-testid="select-unit">
                  <SelectValue placeholder="Select unit" />
                </SelectTrigger>
                <SelectContent>
                  {selectedPricing.units.map(u => (
                    <SelectItem key={u.unitId} value={u.unitId}>
                      {u.unitLabel} ({u.bedrooms}BR) - Buy-in: {formatCurrency(u.baseBuyIn)}/night
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {suggestedCost !== null && (
            <Card className="p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm text-muted-foreground">Suggested buy-in rate:</span>
                <span className="font-semibold text-lg">{formatCurrency(suggestedCost)}/night</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Base Airbnb rate for {selectedUnit?.unitLabel} ({selectedUnit?.bedrooms}BR) in {selectedUnit?.community}
              </p>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Check-in</Label>
              <Input type="date" value={checkIn} onChange={e => setCheckIn(e.target.value)} data-testid="input-checkin" />
            </div>
            <div>
              <Label>Check-out</Label>
              <Input type="date" value={checkOut} onChange={e => setCheckOut(e.target.value)} data-testid="input-checkout" />
            </div>
          </div>

          {checkIn && checkOut && suggestedCost !== null && (
            <Card className="p-3">
              <div className="text-sm text-muted-foreground">Estimated total cost:</div>
              <div className="font-semibold text-lg" data-testid="text-estimated-cost">
                {formatCurrency(
                  suggestedCost * Math.max(1, Math.ceil((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (1000 * 60 * 60 * 24)))
                )}
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  ({Math.max(1, Math.ceil((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (1000 * 60 * 60 * 24)))} nights)
                </span>
              </div>
            </Card>
          )}

          <div>
            <Label>Total Cost Paid ($)</Label>
            <Input
              type="number"
              step="0.01"
              value={costPaid}
              onChange={e => setCostPaid(e.target.value)}
              placeholder="e.g. 2125.00"
              data-testid="input-cost"
            />
          </div>

          <div>
            <Label>Airbnb Confirmation # (optional)</Label>
            <Input
              value={airbnbConfirmation}
              onChange={e => setAirbnbConfirmation(e.target.value)}
              placeholder="e.g. HMXYZ123"
              data-testid="input-confirmation"
            />
          </div>

          <div>
            <Label>Airbnb Listing URL (optional)</Label>
            <Input
              value={airbnbListingUrl}
              onChange={e => setAirbnbListingUrl(e.target.value)}
              placeholder="https://airbnb.com/rooms/..."
              data-testid="input-listing-url"
            />
          </div>

          <div>
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Any additional notes about this buy-in..."
              className="resize-none"
              data-testid="input-notes"
            />
          </div>

          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={createMutation.isPending}
            data-testid="button-submit-buyin"
          >
            {createMutation.isPending ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving...</>
            ) : (
              <><ShoppingCart className="h-4 w-4 mr-2" /> Record Buy-In</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type RankedUnit = {
  propertyId: number;
  propertyName: string;
  community: string;
  unitId: string;
  unitLabel: string;
  bedrooms: number;
  buyInPerNight: number;
  sellPerNight: number;
  profitPerNight: number;
  totalBuyInCost: number;
  totalSellRevenue: number;
  totalProfit: number;
  nights: number;
  available: boolean;
};

function BestBuyInFinder() {
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [results, setResults] = useState<RankedUnit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const allProperties = getAllMultiUnitProperties();
  const propertyMap = new Map(allProperties.map(p => [p.propertyId, p.propertyName]));

  const findBestUnits = async () => {
    if (!checkIn || !checkOut) {
      toast({ title: "Please select check-in and check-out dates", variant: "destructive" });
      return;
    }
    if (checkOut <= checkIn) {
      toast({ title: "Check-out must be after check-in", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/availability?checkIn=${checkIn}&checkOut=${checkOut}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Server error" }));
        throw new Error(errData.error || "Failed to check availability");
      }
      const bookedUnits: { propertyId: number; unitId: string; source: string }[] = await res.json();

      const bookedSet = new Set(bookedUnits.map(b => `${b.propertyId}-${b.unitId}`));

      const nights = Math.max(1, Math.ceil(
        (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (1000 * 60 * 60 * 24)
      ));

      const monthNames = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];

      const allUnits = getAllUnitPricings();

      const ranked: RankedUnit[] = allUnits.map(({ propertyId, community, unit }) => {
        let totalBuyInCost = 0;
        let totalSellRevenue = 0;
        const startDate = new Date(checkIn + "T12:00:00");

        for (let i = 0; i < nights; i++) {
          const nightDate = new Date(startDate);
          nightDate.setDate(nightDate.getDate() + i);
          const mIdx = nightDate.getMonth();
          const yr = nightDate.getFullYear();

          const monthRate = unit.monthlyRates.find(r => r.month === monthNames[mIdx] && r.year === yr);
          totalBuyInCost += monthRate ? monthRate.buyInRate : unit.baseBuyIn;
          totalSellRevenue += monthRate ? monthRate.sellRate : unit.baseSellRate;
        }

        const totalProfit = totalSellRevenue - totalBuyInCost;
        const buyInPerNight = Math.round(totalBuyInCost / nights);
        const sellPerNight = Math.round(totalSellRevenue / nights);
        const profitPerNight = sellPerNight - buyInPerNight;
        const isAvailable = !bookedSet.has(`${propertyId}-${unit.unitId}`);

        return {
          propertyId,
          propertyName: propertyMap.get(propertyId) || `Property ${propertyId}`,
          community,
          unitId: unit.unitId,
          unitLabel: unit.unitLabel,
          bedrooms: unit.bedrooms,
          buyInPerNight,
          sellPerNight,
          profitPerNight,
          totalBuyInCost,
          totalSellRevenue,
          totalProfit,
          nights,
          available: isAvailable,
        };
      });

      ranked.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return b.totalProfit - a.totalProfit;
      });

      setResults(ranked);
    } catch (err: any) {
      toast({ title: "Failed to find recommendations", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const topTwo = results ? results.filter(r => r.available).slice(0, 2) : [];
  const otherAvailable = results ? results.filter(r => r.available).slice(2) : [];
  const unavailable = results ? results.filter(r => !r.available) : [];

  return (
    <Card className="p-4 sm:p-6 mb-6">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Sparkles className="h-5 w-5 text-yellow-500" />
        <h2 className="font-semibold text-lg">Find Best Buy-Ins</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Pick your travel dates and we'll find the two most profitable units to buy in based on the highest profit margin (sell rate minus buy-in cost) and current availability.
      </p>

      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <Label className="text-sm">Check-in</Label>
          <Input
            type="date"
            value={checkIn}
            onChange={e => { setCheckIn(e.target.value); setResults(null); }}
            data-testid="input-finder-checkin"
          />
        </div>
        <div>
          <Label className="text-sm">Check-out</Label>
          <Input
            type="date"
            value={checkOut}
            onChange={e => { setCheckOut(e.target.value); setResults(null); }}
            data-testid="input-finder-checkout"
          />
        </div>
        <Button onClick={findBestUnits} disabled={loading} data-testid="button-find-best">
          {loading ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching...</>
          ) : (
            <><Search className="h-4 w-4 mr-2" /> Find Best Units</>
          )}
        </Button>
      </div>

      {results !== null && (
        <div className="mt-6 space-y-4">
          {topTwo.length === 0 ? (
            <div className="text-center py-6">
              <AlertCircle className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-muted-foreground">No available units found for these dates.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-2">
                <Award className="h-4 w-4 text-yellow-500" />
                <h3 className="font-semibold">Top 2 Recommendations</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {topTwo.map((unit, idx) => (
                  <Card key={`${unit.propertyId}-${unit.unitId}`} className="p-4 relative" data-testid={`card-recommendation-${idx}`}>
                    <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center justify-center w-7 h-7 rounded-full bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 text-sm font-bold">
                          {idx + 1}
                        </div>
                        <div>
                          <div className="font-semibold text-sm leading-tight">{unit.propertyName}</div>
                          <div className="text-xs text-muted-foreground">{unit.unitLabel}</div>
                        </div>
                      </div>
                      <Badge variant="default">
                        <Star className="h-3 w-3 mr-1" />
                        Best Pick
                      </Badge>
                    </div>

                    <div className="space-y-2 text-sm">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <MapPin className="h-3 w-3" />
                        <span>{unit.community}</span>
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <BedDouble className="h-3 w-3" />
                        <span>{unit.bedrooms} bedrooms</span>
                      </div>
                    </div>

                    <div className="mt-3 pt-3 border-t space-y-1">
                      <div className="flex justify-between gap-2 text-sm">
                        <span className="text-muted-foreground">Buy-in cost ({unit.nights} nights):</span>
                        <span className="font-medium">{formatCurrency(unit.totalBuyInCost)}</span>
                      </div>
                      <div className="flex justify-between gap-2 text-sm">
                        <span className="text-muted-foreground">Expected revenue:</span>
                        <span className="font-medium">{formatCurrency(unit.totalSellRevenue)}</span>
                      </div>
                      <div className="flex justify-between gap-2 text-sm">
                        <span className="text-muted-foreground">Per night rate:</span>
                        <span className="font-medium">{formatCurrency(unit.buyInPerNight)}/night</span>
                      </div>
                      <div className="flex justify-between gap-2 text-sm font-semibold pt-1 border-t">
                        <span className="text-green-600 dark:text-green-400">Estimated profit:</span>
                        <span className="text-green-600 dark:text-green-400">{formatCurrency(unit.totalProfit)}</span>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              {otherAvailable.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="button-show-all-available">
                    View all {otherAvailable.length + topTwo.length} available units ranked by profit
                  </summary>
                  <div className="mt-3 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Rank</TableHead>
                          <TableHead>Property</TableHead>
                          <TableHead>Unit</TableHead>
                          <TableHead>Community</TableHead>
                          <TableHead className="text-right">Buy-In Cost</TableHead>
                          <TableHead className="text-right">Revenue</TableHead>
                          <TableHead className="text-right">Profit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...topTwo, ...otherAvailable].map((unit, idx) => (
                          <TableRow key={`${unit.propertyId}-${unit.unitId}`} data-testid={`row-ranked-${idx}`}>
                            <TableCell>
                              <span className={`font-medium ${idx < 2 ? "text-yellow-600 dark:text-yellow-400" : ""}`}>
                                #{idx + 1}
                              </span>
                            </TableCell>
                            <TableCell className="font-medium max-w-[180px] truncate">{unit.propertyName}</TableCell>
                            <TableCell>{unit.unitLabel} ({unit.bedrooms}BR)</TableCell>
                            <TableCell>{unit.community}</TableCell>
                            <TableCell className="text-right">{formatCurrency(unit.totalBuyInCost)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(unit.totalSellRevenue)}</TableCell>
                            <TableCell className="text-right font-medium text-green-600 dark:text-green-400">
                              {formatCurrency(unit.totalProfit)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </details>
              )}

              {unavailable.length > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  {unavailable.length} unit{unavailable.length !== 1 ? "s" : ""} unavailable for these dates (already booked)
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function BuyInsTab() {
  const { toast } = useToast();
  const { data: buyIns = [], isLoading } = useQuery<BuyIn[]>({
    queryKey: ["/api/buy-ins"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/buy-ins/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/summary"] });
      toast({ title: "Buy-in deleted" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (buyIns.length === 0) {
    return (
      <div className="text-center py-12">
        <ShoppingCart className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <h3 className="font-medium text-lg">No buy-ins recorded yet</h3>
        <p className="text-muted-foreground text-sm mt-1">
          Use the "Record Buy-In" button to add your first Airbnb purchase
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Property</TableHead>
            <TableHead>Unit</TableHead>
            <TableHead>Check-in</TableHead>
            <TableHead>Check-out</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead>Confirmation</TableHead>
            <TableHead>Status</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {buyIns.map((buyIn) => (
            <TableRow key={buyIn.id} data-testid={`row-buyin-${buyIn.id}`}>
              <TableCell className="font-medium max-w-[200px] truncate">{buyIn.propertyName}</TableCell>
              <TableCell>{buyIn.unitLabel}</TableCell>
              <TableCell>{formatDate(buyIn.checkIn)}</TableCell>
              <TableCell>{formatDate(buyIn.checkOut)}</TableCell>
              <TableCell className="text-right font-medium">{formatCurrency(buyIn.costPaid)}</TableCell>
              <TableCell>
                {buyIn.airbnbConfirmation ? (
                  <div className="flex items-center gap-1">
                    <span className="text-sm">{buyIn.airbnbConfirmation}</span>
                    {buyIn.airbnbListingUrl && (
                      <a href={buyIn.airbnbListingUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </a>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-sm">-</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={buyIn.status === "active" ? "default" : "secondary"}>
                  {buyIn.status}
                </Badge>
              </TableCell>
              <TableCell>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    if (confirm("Delete this buy-in record?")) {
                      deleteMutation.mutate(buyIn.id);
                    }
                  }}
                  data-testid={`button-delete-buyin-${buyIn.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BookingsTab() {
  const { toast } = useToast();
  const { data: bookings = [], isLoading } = useQuery<LodgifyBooking[]>({
    queryKey: ["/api/lodgify/bookings"],
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/lodgify/sync-bookings");
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/lodgify/bookings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/summary"] });
      toast({
        title: "Booking sync complete",
        description: `${data.synced} bookings synced, ${data.skipped} skipped`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <p className="text-sm text-muted-foreground">
          Guest bookings synced from Lodgify (Booking.com, VRBO, etc.)
        </p>
        <Button
          variant="outline"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          data-testid="button-sync-bookings"
        >
          {syncMutation.isPending ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Syncing...</>
          ) : (
            <><RefreshCw className="h-4 w-4 mr-2" /> Sync from Lodgify</>
          )}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : bookings.length === 0 ? (
        <div className="text-center py-12">
          <Calendar className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <h3 className="font-medium text-lg">No bookings synced yet</h3>
          <p className="text-muted-foreground text-sm mt-1">
            Click "Sync from Lodgify" to pull in your latest guest reservations
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead>Guest</TableHead>
                <TableHead>Check-in</TableHead>
                <TableHead>Check-out</TableHead>
                <TableHead>Nights</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bookings.map((booking) => (
                <TableRow key={booking.id} data-testid={`row-booking-${booking.id}`}>
                  <TableCell className="font-medium max-w-[200px] truncate">
                    {booking.lodgifyPropertyName || `Lodgify #${booking.lodgifyPropertyId}`}
                  </TableCell>
                  <TableCell>{booking.guestName || "N/A"}</TableCell>
                  <TableCell>{formatDate(booking.checkIn)}</TableCell>
                  <TableCell>{formatDate(booking.checkOut)}</TableCell>
                  <TableCell>{booking.nights || "-"}</TableCell>
                  <TableCell className="text-right font-medium">
                    {booking.totalAmount ? formatCurrency(booking.totalAmount) : "-"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {booking.source || "Unknown"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={booking.status === "Booked" || booking.status === "Open" ? "default" : "secondary"}>
                      {booking.status || "N/A"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ReportsTab() {
  const { data: summary, isLoading } = useQuery<ReportSummary>({
    queryKey: ["/api/reports/summary"],
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="text-center py-12">
        <BarChart3 className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <h3 className="font-medium text-lg">No data available yet</h3>
        <p className="text-muted-foreground text-sm mt-1">
          Record buy-ins and sync bookings to see your profitability reports
        </p>
      </div>
    );
  }

  const hasData = summary.totalBuyIns > 0 || summary.totalBookings > 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Total Buy-In Cost</span>
          </div>
          <div className="text-2xl font-bold" data-testid="text-total-buyin-cost">
            {formatCurrency(summary.totalBuyInCost)}
          </div>
          <div className="text-xs text-muted-foreground mt-1">{summary.totalBuyIns} buy-ins ({summary.activeBuyIns} active)</div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Total Revenue</span>
          </div>
          <div className="text-2xl font-bold" data-testid="text-total-revenue">
            {formatCurrency(summary.totalRevenue)}
          </div>
          <div className="text-xs text-muted-foreground mt-1">{summary.totalBookings} guest bookings</div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            {summary.totalProfit >= 0 ? (
              <TrendingUp className="h-4 w-4 text-green-600" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-600" />
            )}
            <span className="text-sm text-muted-foreground">Total Profit</span>
          </div>
          <div className={`text-2xl font-bold ${summary.totalProfit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`} data-testid="text-total-profit">
            {formatCurrency(summary.totalProfit)}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {summary.totalRevenue > 0
              ? `${((summary.totalProfit / summary.totalBuyInCost) * 100).toFixed(1)}% margin`
              : "No revenue yet"}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Avg Profit / Buy-In</span>
          </div>
          <div className="text-2xl font-bold" data-testid="text-avg-profit">
            {summary.totalBuyIns > 0
              ? formatCurrency(summary.totalProfit / summary.totalBuyIns)
              : "$0"}
          </div>
          <div className="text-xs text-muted-foreground mt-1">per transaction</div>
        </Card>
      </div>

      {hasData && summary.monthlyBreakdown.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Monthly Breakdown
          </h3>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Buy-Ins</TableHead>
                  <TableHead className="text-right">Buy-In Cost</TableHead>
                  <TableHead className="text-right">Bookings</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.monthlyBreakdown.map((row) => (
                  <TableRow key={row.month} data-testid={`row-month-${row.month}`}>
                    <TableCell className="font-medium">{row.month}</TableCell>
                    <TableCell className="text-right">{row.buyIns}</TableCell>
                    <TableCell className="text-right">{formatCurrency(row.buyInCost)}</TableCell>
                    <TableCell className="text-right">{row.bookings}</TableCell>
                    <TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell>
                    <TableCell className={`text-right font-medium ${row.profit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                      {formatCurrency(row.profit)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {!hasData && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">
            Record buy-ins and sync bookings from Lodgify to see your monthly profitability breakdown
          </p>
        </div>
      )}
    </div>
  );
}

export default function BuyInTracker() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-4 sm:p-6">
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <Link href="/">
            <Button variant="ghost" size="icon" data-testid="button-back-home">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold" data-testid="text-page-title">Buy-In Tracker</h1>
            <p className="text-sm text-muted-foreground">Track Airbnb purchases, guest bookings, and profitability</p>
          </div>
          <NewBuyInDialog onSuccess={() => {}} />
        </div>

        <BestBuyInFinder />

        <Tabs defaultValue="buy-ins" className="space-y-4">
          <TabsList data-testid="tabs-tracker">
            <TabsTrigger value="buy-ins" data-testid="tab-buyins">
              <ShoppingCart className="h-4 w-4 mr-2" />
              Buy-Ins
            </TabsTrigger>
            <TabsTrigger value="bookings" data-testid="tab-bookings">
              <Calendar className="h-4 w-4 mr-2" />
              Guest Bookings
            </TabsTrigger>
            <TabsTrigger value="reports" data-testid="tab-reports">
              <BarChart3 className="h-4 w-4 mr-2" />
              Profitability
            </TabsTrigger>
          </TabsList>

          <TabsContent value="buy-ins">
            <Card className="p-4">
              <BuyInsTab />
            </Card>
          </TabsContent>

          <TabsContent value="bookings">
            <Card className="p-4">
              <BookingsTab />
            </Card>
          </TabsContent>

          <TabsContent value="reports">
            <ReportsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
