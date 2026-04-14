import { useState, useEffect, useRef } from "react";
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
  Plus,
  Trash2,
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
  Check,
  CircleDot,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { BuyIn } from "@shared/schema";
import {
  getPropertyPricing,
  calcSellRateFromBuyIn,
  getDominantSeason,
  getSeasonalRateReference,
  getSeasonLabel,
  getSeasonBgClass,
  getCommunityRegion,
  PLATFORM_FEE,
  BUSINESS_MARKUP,
  type PropertyPricing,
  type UnitPricing,
} from "@/data/pricing-data";
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

type AirbnbProperty = {
  id: string;
  title: string;
  description: string;
  link: string;
  bookingLink: string;
  rating: number | null;
  reviews: number | null;
  price: {
    total_price: string;
    extracted_total_price: number;
    qualifier: string;
    extracted_qualifier: number;
    price_per_qualifier: string;
    extracted_price_per_qualifier: number;
    original_price?: string;
    extracted_original_price?: number;
  } | null;
  accommodations: string[];
  images: string[];
  badges: string[];
  source?: "airbnb" | "vrbo" | "suite-paradise";
};

type SearchBucket = {
  count: number;
  totalResults: number;
  properties: AirbnbProperty[];
  error?: string;
  searchUrl?: string;
  vrboSearchUrl?: string;
  note?: string;
};

type AirbnbSearchResults = {
  community: string;
  searchLocation: string;
  checkIn: string;
  checkOut: string;
  unitsNeeded: { bedrooms: number; count: number }[];
  searches: Record<string, SearchBucket>;
};

type OtherPlatformResults = {
  community: string;
  checkIn: string;
  checkOut: string;
  unitsNeeded: { bedrooms: number; count: number }[];
  vrbo: Record<string, SearchBucket>;
  suiteParadise: Record<string, SearchBucket>;
};

const PLATFORM_LABELS: Record<string, { name: string; color: string; bookLabel: string }> = {
  airbnb: { name: "Airbnb", color: "text-rose-600 dark:text-rose-400", bookLabel: "Book on Airbnb" },
  vrbo: { name: "VRBO & Others", color: "text-blue-600 dark:text-blue-400", bookLabel: "View Listing" },
  "suite-paradise": { name: "Suite Paradise", color: "text-emerald-600 dark:text-emerald-400", bookLabel: "View on Suite Paradise" },
};

function BestBuyInFinder() {
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [results, setResults] = useState<AirbnbSearchResults | null>(null);
  const [otherResults, setOtherResults] = useState<OtherPlatformResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [feePercent, setFeePercent] = useState(15);
  const [selectedListings, setSelectedListings] = useState<Record<string, AirbnbProperty[]>>({});
  const [recording, setRecording] = useState(false);
  const [activePlatform, setActivePlatform] = useState<"airbnb" | "vrbo" | "suite-paradise">("airbnb");
  const { toast } = useToast();
  const autoSearchFired = useRef(false);

  const allProperties = getAllMultiUnitProperties();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paramPropId = params.get("propertyId");
    const paramCheckIn = params.get("checkIn");
    const paramCheckOut = params.get("checkOut");
    if (paramPropId) setSelectedPropertyId(paramPropId);
    if (paramCheckIn) setCheckIn(paramCheckIn);
    if (paramCheckOut) setCheckOut(paramCheckOut);
  }, []);

  useEffect(() => {
    if (autoSearchFired.current) return;
    if (!selectedPropertyId || !checkIn || !checkOut) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("propertyId") || !params.get("checkIn") || !params.get("checkOut")) return;
    autoSearchFired.current = true;
    findBestUnitsFromParams(selectedPropertyId, checkIn, checkOut);
  }, [selectedPropertyId, checkIn, checkOut]);

  const findBestUnitsFromParams = async (propId: string, ci: string, co: string) => {
    if (co <= ci) return;
    setLoading(true);
    setResults(null);
    setOtherResults(null);
    setSelectedListings({});
    setActivePlatform("airbnb");
    try {
      const [airbnbRes, otherRes] = await Promise.all([
        fetch(`/api/airbnb/search?propertyId=${propId}&checkIn=${ci}&checkOut=${co}`),
        fetch(`/api/vrbo/search?propertyId=${propId}&checkIn=${ci}&checkOut=${co}`),
      ]);
      let airbnbData: AirbnbSearchResults | null = null;
      let otherData: OtherPlatformResults | null = null;
      if (airbnbRes.ok) {
        airbnbData = await airbnbRes.json();
        for (const key of Object.keys(airbnbData!.searches)) {
          for (const prop of airbnbData!.searches[key].properties) prop.source = "airbnb";
        }
        setResults(airbnbData);
      }
      if (otherRes.ok) {
        otherData = await otherRes.json();
        for (const key of Object.keys(otherData!.vrbo)) {
          for (const prop of otherData!.vrbo[key].properties) prop.source = "vrbo";
        }
        for (const key of Object.keys(otherData!.suiteParadise)) {
          for (const prop of otherData!.suiteParadise[key].properties) prop.source = "suite-paradise";
        }
        setOtherResults(otherData);
      }
      if (airbnbData) autoSelectCheapest(airbnbData, otherData);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const toggleListingSelection = (bedroomKey: string, property: AirbnbProperty, maxCount: number) => {
    setSelectedListings(prev => {
      const current = prev[bedroomKey] || [];
      const isSelected = current.some(p => p.id === property.id);
      if (isSelected) {
        return { ...prev, [bedroomKey]: current.filter(p => p.id !== property.id) };
      }
      if (current.length >= maxCount) {
        return { ...prev, [bedroomKey]: [...current.slice(1), property] };
      }
      return { ...prev, [bedroomKey]: [...current, property] };
    });
  };

  const isListingSelected = (bedroomKey: string, propertyId: string) => {
    return (selectedListings[bedroomKey] || []).some(p => p.id === propertyId);
  };

  const getSelectedTotalCost = () => {
    const feeMultiplier = 1 + feePercent / 100;
    let total = 0;
    for (const listings of Object.values(selectedListings)) {
      for (const listing of listings) {
        if (listing.source === "airbnb") {
          total += Math.round((listing.price?.extracted_total_price ?? 0) * feeMultiplier);
        } else {
          total += Math.round(listing.price?.extracted_total_price ?? 0);
        }
      }
    }
    return total;
  };

  const autoSelectCheapest = (airbnbData: AirbnbSearchResults, otherData: OtherPlatformResults | null) => {
    const fm = 1 + feePercent / 100;
    const newSelections: Record<string, AirbnbProperty[]> = {};

    for (const need of airbnbData.unitsNeeded) {
      const key = `${need.bedrooms}BR`;
      const allCandidates: AirbnbProperty[] = [];

      const airbnbSearch = airbnbData.searches[key];
      if (airbnbSearch && !airbnbSearch.error) {
        for (const p of airbnbSearch.properties) {
          allCandidates.push({ ...p, source: "airbnb" });
        }
      }

      if (otherData) {
        const vrboSearch = otherData.vrbo[key];
        if (vrboSearch && !vrboSearch.error) {
          for (const p of vrboSearch.properties) {
            allCandidates.push({ ...p, source: "vrbo" });
          }
        }
        const spSearch = otherData.suiteParadise[key];
        if (spSearch && !spSearch.error) {
          for (const p of spSearch.properties) {
            allCandidates.push({ ...p, source: "suite-paradise" });
          }
        }
      }

      const withPrice = allCandidates.filter(p => p.price?.extracted_total_price);
      withPrice.sort((a, b) => {
        const costA = a.source === "airbnb"
          ? (a.price!.extracted_total_price * fm)
          : a.price!.extracted_total_price;
        const costB = b.source === "airbnb"
          ? (b.price!.extracted_total_price * fm)
          : b.price!.extracted_total_price;
        return costA - costB;
      });

      newSelections[key] = withPrice.slice(0, need.count);
    }

    setSelectedListings(newSelections);
  };

  const getTotalSelectedCount = () => {
    return Object.values(selectedListings).reduce((sum, arr) => sum + arr.length, 0);
  };

  const getTotalNeededCount = () => {
    if (!results) return 0;
    return results.unitsNeeded.reduce((sum, n) => sum + n.count, 0);
  };

  const allUnitsSelected = () => {
    if (!results) return false;
    return results.unitsNeeded.every(need => {
      const key = `${need.bedrooms}BR`;
      return (selectedListings[key] || []).length === need.count;
    });
  };

  const recordBuyIns = async () => {
    if (!results || !selectedPropertyId) return;
    const propId = parseInt(selectedPropertyId);
    const pricing = getPropertyPricing(propId);
    const selectedProp = allProperties.find(p => p.propertyId === propId);
    if (!pricing || !selectedProp) return;

    const feeMultiplier = 1 + feePercent / 100;

    setRecording(true);
    try {
      const unitsByBedroom: Record<number, typeof pricing.units> = {};
      for (const unit of pricing.units) {
        if (!unitsByBedroom[unit.bedrooms]) unitsByBedroom[unit.bedrooms] = [];
        unitsByBedroom[unit.bedrooms].push(unit);
      }

      const unitAssignmentIndex: Record<number, number> = {};

      for (const need of results.unitsNeeded) {
        const key = `${need.bedrooms}BR`;
        const selected = selectedListings[key] || [];
        for (const listing of selected) {
          if (!unitAssignmentIndex[need.bedrooms]) unitAssignmentIndex[need.bedrooms] = 0;
          const assignIdx = unitAssignmentIndex[need.bedrooms];
          const availableUnits = unitsByBedroom[need.bedrooms] || [];
          const assignedUnit = availableUnits[assignIdx] || availableUnits[0];
          unitAssignmentIndex[need.bedrooms] = assignIdx + 1;

          const isAirbnb = listing.source === "airbnb";
          const estimatedCost = isAirbnb
            ? Math.round((listing.price?.extracted_total_price ?? 0) * feeMultiplier)
            : Math.round(listing.price?.extracted_total_price ?? 0);
          const sourceName = (listing.source || "airbnb").charAt(0).toUpperCase() + (listing.source || "airbnb").slice(1);

          await apiRequest("POST", "/api/buy-ins", {
            propertyId: propId,
            unitId: assignedUnit?.unitId || "unknown",
            propertyName: selectedProp.propertyName,
            unitLabel: assignedUnit?.unitLabel || `${need.bedrooms}BR Unit`,
            checkIn: results.checkIn,
            checkOut: results.checkOut,
            costPaid: String(estimatedCost),
            airbnbConfirmation: null,
            airbnbListingUrl: listing.bookingLink || listing.link || null,
            notes: `${sourceName} listing: ${listing.title} (${isAirbnb ? `Listed: $${listing.price?.extracted_total_price ?? 0}, Est. checkout: $${estimatedCost}` : `Total: $${estimatedCost} (fees incl.)`})`,
            status: "active",
          });
        }
      }

      queryClient.invalidateQueries({ queryKey: ["/api/buy-ins"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/summary"] });
      toast({ title: "Buy-ins recorded!", description: `${getTotalSelectedCount()} buy-in record${getTotalSelectedCount() > 1 ? "s" : ""} created` });
      setSelectedListings({});
    } catch (err: any) {
      toast({ title: "Failed to record buy-ins", description: err.message, variant: "destructive" });
    } finally {
      setRecording(false);
    }
  };

  const findBestUnits = async () => {
    if (!selectedPropertyId) {
      toast({ title: "Please select a property", variant: "destructive" });
      return;
    }
    if (!checkIn || !checkOut) {
      toast({ title: "Please select check-in and check-out dates", variant: "destructive" });
      return;
    }
    if (checkOut <= checkIn) {
      toast({ title: "Check-out must be after check-in", variant: "destructive" });
      return;
    }

    setLoading(true);
    setResults(null);
    setOtherResults(null);
    setSelectedListings({});
    setActivePlatform("airbnb");
    try {
      const [airbnbRes, otherRes] = await Promise.all([
        fetch(`/api/airbnb/search?propertyId=${selectedPropertyId}&checkIn=${checkIn}&checkOut=${checkOut}`),
        fetch(`/api/vrbo/search?propertyId=${selectedPropertyId}&checkIn=${checkIn}&checkOut=${checkOut}`),
      ]);

      let airbnbData: AirbnbSearchResults | null = null;
      let otherData: OtherPlatformResults | null = null;

      if (airbnbRes.ok) {
        airbnbData = await airbnbRes.json();
        for (const key of Object.keys(airbnbData!.searches)) {
          for (const prop of airbnbData!.searches[key].properties) {
            prop.source = "airbnb";
          }
        }
        setResults(airbnbData);
      } else {
        const errData = await airbnbRes.json().catch(() => ({ error: "Server error" }));
        toast({ title: "Airbnb search issue", description: errData.error || "Failed to search Airbnb", variant: "destructive" });
      }

      if (otherRes.ok) {
        otherData = await otherRes.json();
        for (const key of Object.keys(otherData!.vrbo)) {
          for (const prop of otherData!.vrbo[key].properties) {
            prop.source = "vrbo";
          }
        }
        for (const key of Object.keys(otherData!.suiteParadise)) {
          for (const prop of otherData!.suiteParadise[key].properties) {
            prop.source = "suite-paradise";
          }
        }
        setOtherResults(otherData);
      }

      if (airbnbData) {
        autoSelectCheapest(airbnbData, otherData);
      }
    } catch (err: any) {
      toast({ title: "Search failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const selectedProp = allProperties.find(p => p.propertyId === parseInt(selectedPropertyId));
  const pricing = selectedPropertyId ? getPropertyPricing(parseInt(selectedPropertyId)) : null;

  return (
    <Card className="p-4 sm:p-6 mb-6">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Sparkles className="h-5 w-5 text-yellow-500" />
        <h2 className="font-semibold text-lg">Find Best Buy-Ins</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Select your property, enter the guest's travel dates, and we'll search Airbnb, VRBO, and Suite Paradise in real-time for the cheapest available units to buy in for that stay.
      </p>

      <div className="flex items-end gap-3 flex-wrap">
        <div className="min-w-[220px]">
          <Label className="text-sm">Property</Label>
          <Select
            value={selectedPropertyId}
            onValueChange={v => { setSelectedPropertyId(v); setResults(null); setOtherResults(null); }}
          >
            <SelectTrigger data-testid="select-finder-property">
              <SelectValue placeholder="Select property..." />
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
        <div>
          <Label className="text-sm">Check-in</Label>
          <Input
            type="date"
            value={checkIn}
            onChange={e => { setCheckIn(e.target.value); setResults(null); setOtherResults(null); }}
            data-testid="input-finder-checkin"
          />
        </div>
        <div>
          <Label className="text-sm">Check-out</Label>
          <Input
            type="date"
            value={checkOut}
            onChange={e => { setCheckOut(e.target.value); setResults(null); setOtherResults(null); }}
            data-testid="input-finder-checkout"
          />
        </div>
        <Button onClick={findBestUnits} disabled={loading} data-testid="button-find-best">
          {loading ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching All Platforms...</>
          ) : (
            <><Search className="h-4 w-4 mr-2" /> Find Best Buy-Ins</>
          )}
        </Button>
      </div>

      {selectedProp && pricing && !results && !loading && (
        <div className="mt-4 p-3 rounded-md bg-muted/50">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{selectedProp.propertyName}</span> in {selectedProp.complexName} needs:
          </p>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {pricing.units.map((u, i) => (
              <Badge key={i} variant="secondary">
                <BedDouble className="h-3 w-3 mr-1" />
                {u.bedrooms}BR - {u.unitLabel}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className="mt-6 flex flex-col items-center py-8 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Searching Airbnb, VRBO & Suite Paradise...</p>
          <p className="text-xs text-muted-foreground">This may take a few seconds</p>
        </div>
      )}

      {results !== null && !loading && (() => {
        const propId = parseInt(selectedPropertyId);
        const feeMultiplier = 1 + feePercent / 100;

        // ── Buy-in from live search (all required units) ──────────────────
        const listedBuyInCost = results.unitsNeeded.reduce((total, need) => {
          const key = `${need.bedrooms}BR`;
          const searchData = results.searches[key];
          if (!searchData || searchData.error) return total;
          const topPicks = searchData.properties.slice(0, need.count);
          return total + topPicks.reduce((sum, p) => sum + (p.price?.extracted_total_price ?? 0), 0);
        }, 0);

        const estimatedBuyInCost = Math.round(listedBuyInCost * feeMultiplier);

        const hasAllPrices = results.unitsNeeded.every(need => {
          const key = `${need.bedrooms}BR`;
          const searchData = results.searches[key];
          if (!searchData || searchData.error) return false;
          const topPicks = searchData.properties.slice(0, need.count);
          return topPicks.length === need.count && topPicks.every(p => p.price?.extracted_total_price);
        });

        // ── Sell rate built from actual buy-in + transparent markup ───────
        const sellBreakdown = calcSellRateFromBuyIn(estimatedBuyInCost);

        // ── Season detection for this stay ────────────────────────────────
        const pricing = getPropertyPricing(propId);
        const community = pricing ? pricing.units[0]?.community : results.community;
        const region = getCommunityRegion(community);
        const dominantSeason = getDominantSeason(results.checkIn, results.checkOut, region);
        const seasonRef = getSeasonalRateReference(propId);
        const totalNights = Math.round(
          (new Date(results.checkOut + "T12:00:00").getTime() - new Date(results.checkIn + "T12:00:00").getTime())
          / (1000 * 60 * 60 * 24)
        );

        // ── Platform result counts ────────────────────────────────────────
        const vrboTotalCount = otherResults ? Object.values(otherResults.vrbo).reduce((sum, s) => sum + s.totalResults, 0) : 0;
        const spTotalCount = otherResults ? Object.values(otherResults.suiteParadise).reduce((sum, s) => sum + s.totalResults, 0) : 0;
        const airbnbTotalCount = Object.values(results.searches).reduce((sum, s) => sum + (s.totalResults || 0), 0);

        const getActiveSearchData = (key: string) => {
          if (activePlatform === "airbnb") return results.searches[key];
          if (activePlatform === "vrbo" && otherResults) return otherResults.vrbo[key];
          if (activePlatform === "suite-paradise" && otherResults) return otherResults.suiteParadise[key];
          return null;
        };

        return (
        <div className="mt-6 space-y-6">
          <div className="flex items-center gap-2 flex-wrap">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Searching near <span className="font-medium text-foreground">{results.community}</span> for {formatDate(results.checkIn)} – {formatDate(results.checkOut)}
            </span>
          </div>

          {hasAllPrices && listedBuyInCost > 0 && activePlatform === "airbnb" && (
            <Card className="p-4 border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/20" data-testid="card-profitability-summary">
              {/* Header */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <DollarSign className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h3 className="font-semibold">Pricing Breakdown</h3>
                <Badge variant="secondary" className="text-xs">{totalNights} nights</Badge>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${getSeasonBgClass(dominantSeason.season)}`}>
                  {getSeasonLabel(dominantSeason.season)} Season
                  {dominantSeason.holidayLabel && ` — ${dominantSeason.holidayLabel}`}
                </span>
              </div>

              {/* Buy-In → Sell Rate flow */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-0 border border-border rounded-lg overflow-hidden text-sm mb-4">
                {/* Step 1: Listed price */}
                <div className="p-3 bg-muted/30 border-b sm:border-b-0 sm:border-r border-border">
                  <p className="text-xs text-muted-foreground mb-1">① Listed on Airbnb</p>
                  <p className="font-bold text-base">{formatCurrency(listedBuyInCost)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {results.unitsNeeded.map(n => `${n.count}×${n.bedrooms}BR`).join(" + ")} — before fees
                  </p>
                </div>
                {/* Step 2: Checkout cost */}
                <div className="p-3 bg-muted/30 border-b sm:border-b-0 sm:border-r border-border" data-testid="text-buyin-cost">
                  <p className="text-xs text-muted-foreground mb-1">② Your Buy-In Cost</p>
                  <p className="font-bold text-base">{formatCurrency(estimatedBuyInCost)}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-xs text-muted-foreground">+</span>
                    <Input
                      type="number"
                      value={feePercent}
                      onChange={e => setFeePercent(Math.max(0, Math.min(50, parseInt(e.target.value) || 0)))}
                      className="w-12 h-5 text-xs text-center px-1"
                      min={0} max={50}
                      data-testid="input-fee-percent"
                    />
                    <span className="text-xs text-muted-foreground">% Airbnb fees & taxes</span>
                  </div>
                </div>
                {/* Step 3: Your sell rate */}
                <div className="p-3 border-b sm:border-b-0 sm:border-r border-border" data-testid="text-sell-rate">
                  <p className="text-xs text-muted-foreground mb-1">③ You Charge Guest</p>
                  <p className="font-bold text-base text-blue-700 dark:text-blue-300">{formatCurrency(sellBreakdown.sellRate)}</p>
                  <div className="text-xs text-muted-foreground mt-0.5 space-y-0.5">
                    <div>+{Math.round(PLATFORM_FEE * 100)}% platform fee: {formatCurrency(sellBreakdown.platformFeeAmount)}</div>
                    <div>+{Math.round(BUSINESS_MARKUP * 100)}% your markup: {formatCurrency(sellBreakdown.markupAmount)}</div>
                  </div>
                </div>
                {/* Step 4: Profit */}
                <div className="p-3" data-testid="text-profit">
                  <p className="text-xs text-muted-foreground mb-1">④ Your Profit</p>
                  <p className={`font-bold text-base ${sellBreakdown.profit >= 0 ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                    {formatCurrency(sellBreakdown.profit)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {sellBreakdown.margin}% margin · {formatCurrency(Math.round(sellBreakdown.sellRate / totalNights))}/night
                  </p>
                </div>
              </div>

              {/* Seasonal Rate Reference */}
              {seasonRef && (
                <div className="border-t border-border pt-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Seasonal Rate Reference — {seasonRef.community} ({results.unitsNeeded.map(n => `${n.count}×${n.bedrooms}BR`).join("+")}, per night)
                  </p>
                  <div className="flex gap-4 flex-wrap">
                    {seasonRef.rates.map(r => (
                      <div key={r.season} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${getSeasonBgClass(r.season)} ${dominantSeason.season === r.season ? "ring-2 ring-offset-1 ring-current" : ""}`}>
                        {getSeasonLabel(r.season)}: {formatCurrency(r.nightly)}/night
                        <span className="opacity-70">({Math.round(r.multiplier * 100)}%)</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Sell rate = Buy-in × (1 + {Math.round(PLATFORM_FEE * 100)}% platform fee) × (1 + {Math.round(BUSINESS_MARKUP * 100)}% markup). Holiday dates: Christmas/New Year, July 4th, Thanksgiving, Spring Break.
                  </p>
                </div>
              )}
            </Card>
          )}

          <div className="flex gap-2 flex-wrap" data-testid="platform-tabs">
            <Button
              size="sm"
              variant={activePlatform === "airbnb" ? "default" : "outline"}
              onClick={() => setActivePlatform("airbnb")}
              data-testid="button-platform-airbnb"
            >
              <span className="text-rose-500 mr-1.5">●</span>
              Airbnb
              <Badge variant="secondary" className="ml-2 text-xs">{airbnbTotalCount}</Badge>
            </Button>
            <Button
              size="sm"
              variant={activePlatform === "vrbo" ? "default" : "outline"}
              onClick={() => setActivePlatform("vrbo")}
              data-testid="button-platform-vrbo"
            >
              <span className="text-blue-500 mr-1.5">●</span>
              VRBO
              <Badge variant="secondary" className="ml-2 text-xs">{vrboTotalCount}</Badge>
            </Button>
            <Button
              size="sm"
              variant={activePlatform === "suite-paradise" ? "default" : "outline"}
              onClick={() => setActivePlatform("suite-paradise")}
              data-testid="button-platform-sp"
            >
              <span className="text-emerald-500 mr-1.5">●</span>
              Suite Paradise
              <Badge variant="secondary" className="ml-2 text-xs">{spTotalCount}</Badge>
            </Button>
          </div>

          {activePlatform === "vrbo" && (
            <div className="p-3 rounded-md bg-muted/50 text-xs text-muted-foreground">
              Vacation rental listings from Google's aggregated data (VRBO, Booking.com, and other platforms). Prices are per-night estimates multiplied by your stay length — actual totals may vary with cleaning fees and taxes. Use the direct VRBO links to see exact pricing.
            </div>
          )}
          {activePlatform === "suite-paradise" && (
            <div className="p-3 rounded-md bg-emerald-50 dark:bg-emerald-950/30 text-xs text-muted-foreground">
              Suite Paradise manages many vacation rentals in Poipu and across Kauai. Their inventory can't be searched automatically, so use the direct search links below to browse their full inventory with your dates pre-filled. Booking direct with Suite Paradise can save up to 15% vs third-party sites.
            </div>
          )}

          {results.unitsNeeded.map(need => {
            const key = `${need.bedrooms}BR`;
            const searchData = getActiveSearchData(key);
            if (!searchData) return null;

            const platformInfo = PLATFORM_LABELS[activePlatform];

            return (
              <div key={`${activePlatform}-${key}`} className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <BedDouble className="h-4 w-4" />
                  <h3 className="font-semibold">
                    {need.count}x {need.bedrooms}-Bedroom Unit{need.count > 1 ? "s" : ""} Needed
                  </h3>
                  {searchData.error && (
                    <Badge variant="destructive">Search Error</Badge>
                  )}
                  {!searchData.error && (
                    <Badge variant="secondary">{searchData.totalResults} found on {platformInfo.name}</Badge>
                  )}
                  {!searchData.error && searchData.geoFiltered && activePlatform === "airbnb" && (
                    <Badge variant="outline" className="text-xs text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-700">
                      <MapPin className="h-3 w-3 mr-1" />
                      Community area only
                    </Badge>
                  )}
                  {!searchData.error && (selectedListings[key] || []).length > 0 && (
                    <Badge variant="default">
                      <Check className="h-3 w-3 mr-1" />
                      {(selectedListings[key] || []).length}/{need.count} selected
                    </Badge>
                  )}
                </div>

                {searchData.error ? (
                  <div className="p-4 rounded-md bg-destructive/10 text-sm">
                    <AlertCircle className="h-4 w-4 inline mr-2" />
                    {searchData.error}
                  </div>
                ) : searchData.properties.length === 0 ? (
                  <div className={`text-center py-6 rounded-lg ${activePlatform === "suite-paradise" ? "bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800" : ""}`}>
                    {(activePlatform === "suite-paradise" || activePlatform === "vrbo") && (searchData.searchUrl || searchData.vrboSearchUrl) ? (
                      <>
                        {activePlatform === "suite-paradise" ? (
                          <>
                            <div className="text-3xl mb-2">🏖️</div>
                            <p className="font-medium text-sm mb-1">Search Suite Paradise for {need.bedrooms}-Bedroom Rentals</p>
                            <p className="text-muted-foreground text-xs mb-4 max-w-md mx-auto">
                              {searchData.note || "Browse Suite Paradise's full inventory with your dates pre-filled."}
                            </p>
                            <a
                              href={searchData.searchUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-2 px-6 py-3 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors text-sm font-medium"
                              data-testid={`link-direct-search-suite-paradise-${key}`}
                            >
                              <ExternalLink className="h-4 w-4" />
                              Search {need.bedrooms}BR on Suite Paradise
                            </a>
                          </>
                        ) : (
                          <>
                            <ExternalLink className="h-8 w-8 mx-auto text-blue-500 mb-2" />
                            <p className="text-muted-foreground mb-3">
                              {searchData.note || `No ${need.bedrooms}-bedroom listings found in automated search. Try browsing directly.`}
                            </p>
                            <a
                              href={searchData.vrboSearchUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white transition-colors text-sm font-medium"
                              data-testid={`link-direct-search-vrbo-${key}`}
                            >
                              <ExternalLink className="h-4 w-4" />
                              Search VRBO Directly
                            </a>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                        <p className="text-muted-foreground">No {need.bedrooms}-bedroom listings found on {platformInfo.name}.</p>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {searchData.properties.map((prop, idx) => {
                      const selected = isListingSelected(key, prop.id);
                      return (
                      <Card key={prop.id} className={`p-4 cursor-pointer transition-colors ${selected ? "border-green-500 dark:border-green-400 bg-green-50/30 dark:bg-green-950/20" : ""}`} data-testid={`card-${activePlatform}-${key}-${idx}`} onClick={() => toggleListingSelection(key, prop, need.count)}>
                        <div className="flex gap-4">
                          <div className="flex flex-col items-center gap-2 flex-shrink-0">
                            {prop.images && prop.images.length > 0 && (
                              <div className="w-24 h-24 rounded-md overflow-hidden">
                                <img
                                  src={prop.images[0]}
                                  alt={prop.title}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                            )}
                            <Button
                              size="sm"
                              variant={selected ? "default" : "outline"}
                              className="w-full"
                              onClick={(e) => { e.stopPropagation(); toggleListingSelection(key, prop, need.count); }}
                              data-testid={`button-select-${key}-${idx}`}
                            >
                              {selected ? <><Check className="h-3 w-3 mr-1" /> Selected</> : <><CircleDot className="h-3 w-3 mr-1" /> Select</>}
                            </Button>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2 flex-wrap">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <div className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold flex-shrink-0 ${
                                    activePlatform === "airbnb" ? "bg-rose-100 dark:bg-rose-900 text-rose-700 dark:text-rose-300" :
                                    activePlatform === "vrbo" ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300" :
                                    "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
                                  }`}>
                                    {idx + 1}
                                  </div>
                                  <h4 className="font-semibold text-sm truncate">{prop.title}</h4>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{prop.description}</p>
                              </div>
                              {idx === 0 && (
                                <Badge variant="default">
                                  <Star className="h-3 w-3 mr-1" />
                                  Best Price
                                </Badge>
                              )}
                              {prop.source && prop.source !== activePlatform && (
                                <Badge variant="outline" className="text-xs">
                                  {PLATFORM_LABELS[prop.source]?.name || prop.source}
                                </Badge>
                              )}
                            </div>

                            <div className="flex items-center gap-4 mt-2 flex-wrap">
                              {prop.price && (
                                <span data-testid={`text-price-${key}-${idx}`}>
                                  {prop.source === "airbnb" ? (
                                    <>
                                      <span className="font-semibold text-green-600 dark:text-green-400">
                                        {formatCurrency(Math.round((prop.price.extracted_total_price ?? 0) * feeMultiplier))}
                                      </span>
                                      <span className="text-xs font-normal text-muted-foreground ml-1">
                                        est. checkout
                                      </span>
                                      <span className="text-xs text-muted-foreground ml-2 line-through">
                                        {prop.price.total_price}
                                      </span>
                                      <span className="text-xs text-muted-foreground ml-1">listed</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="font-semibold text-green-600 dark:text-green-400">
                                        {formatCurrency(prop.price.extracted_total_price ?? 0)}
                                      </span>
                                      <span className="text-xs font-normal text-muted-foreground ml-1">
                                        total (all fees incl.)
                                      </span>
                                      {(prop.price as any).price_per_night && (
                                        <span className="text-xs text-muted-foreground ml-2">
                                          ({formatCurrency((prop.price as any).price_per_night)}/night)
                                        </span>
                                      )}
                                    </>
                                  )}
                                </span>
                              )}
                              {!prop.price && prop.source !== "airbnb" && (
                                <span className="text-xs text-muted-foreground italic">Price not available - check listing</span>
                              )}
                              {prop.rating && (
                                <span className="text-xs text-muted-foreground flex items-center gap-1">
                                  <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                                  {prop.rating} ({prop.reviews} reviews)
                                </span>
                              )}
                              {prop.accommodations && prop.accommodations.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  {prop.accommodations.join(" · ")}
                                </span>
                              )}
                            </div>

                            {prop.badges && prop.badges.length > 0 && (
                              <div className="flex gap-1 mt-1.5 flex-wrap">
                                {prop.badges.map((badge, bi) => (
                                  <Badge key={bi} variant="secondary" className="text-xs">
                                    {badge}
                                  </Badge>
                                ))}
                              </div>
                            )}

                            <div className="flex gap-2 mt-3 flex-wrap">
                              {(prop.bookingLink || prop.link) && (
                                <a href={prop.bookingLink || prop.link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                  <Button size="sm" data-testid={`button-book-${key}-${idx}`}>
                                    <ExternalLink className="h-3 w-3 mr-1" />
                                    {PLATFORM_LABELS[prop.source || activePlatform]?.bookLabel || "View Listing"}
                                  </Button>
                                </a>
                              )}
                              {prop.source === "airbnb" && prop.link && prop.link !== prop.bookingLink && (
                                <a href={prop.link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                  <Button size="sm" variant="outline" data-testid={`button-view-${key}-${idx}`}>
                                    View Listing
                                  </Button>
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      </Card>
                      );
                    })}
                    {activePlatform === "vrbo" && searchData.vrboSearchUrl && (
                      <div className="text-center pt-2">
                        <a
                          href={searchData.vrboSearchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                          data-testid={`link-vrbo-all-${key}`}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Browse all {need.bedrooms}BR listings on VRBO
                        </a>
                      </div>
                    )}
                    {activePlatform === "suite-paradise" && searchData.searchUrl && (
                      <div className="text-center pt-2">
                        <a
                          href={searchData.searchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 hover:underline"
                          data-testid={`link-sp-all-${key}`}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Browse all listings on Suite Paradise
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {getTotalSelectedCount() > 0 && (() => {
            const allSelected = Object.values(selectedListings).flat();
            const sourceCounts: Record<string, number> = {};
            for (const s of allSelected) {
              const src = s.source || "unknown";
              sourceCounts[src] = (sourceCounts[src] || 0) + 1;
            }
            const sourceLabels = Object.entries(sourceCounts).map(([src, cnt]) => `${cnt} ${PLATFORM_LABELS[src]?.name || src}`).join(", ");
            const selectedBuyIn = getSelectedTotalCost();
            const selectedSell = calcSellRateFromBuyIn(selectedBuyIn);

            return (
            <Card className="p-4 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/30 sticky bottom-0" data-testid="card-selection-summary">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-4 flex-wrap">
                  <div>
                    <p className="text-xs text-muted-foreground">Selected</p>
                    <p className="font-semibold">{getTotalSelectedCount()}/{getTotalNeededCount()} units</p>
                    <p className="text-xs text-muted-foreground">{sourceLabels}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Your Buy-In</p>
                    <p className="font-semibold">{formatCurrency(selectedBuyIn)}</p>
                    <p className="text-xs text-muted-foreground">incl. fees & taxes</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">You Charge Guest</p>
                    <p className="font-semibold text-blue-700 dark:text-blue-300">{formatCurrency(selectedSell.sellRate)}</p>
                    <p className="text-xs text-muted-foreground">+{Math.round(PLATFORM_FEE*100)}% + {Math.round(BUSINESS_MARKUP*100)}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Est. Profit</p>
                    <p className={`font-semibold ${selectedSell.profit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                      {formatCurrency(selectedSell.profit)}
                    </p>
                    <p className="text-xs text-muted-foreground">{selectedSell.margin}% margin</p>
                  </div>
                </div>
                <Button
                  onClick={recordBuyIns}
                  disabled={recording || !allUnitsSelected()}
                  data-testid="button-record-buyins"
                >
                  {recording ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Recording...</>
                  ) : (
                    <><ShoppingCart className="h-4 w-4 mr-2" /> Record {getTotalSelectedCount()} Buy-In{getTotalSelectedCount() > 1 ? "s" : ""}</>
                  )}
                </Button>
              </div>
              {!allUnitsSelected() && (
                <p className="text-xs text-muted-foreground mt-2">
                  Select all {getTotalNeededCount()} units needed to record buy-ins
                </p>
              )}
            </Card>
            );
          })()}
        </div>
        );
      })()}
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
          Use the "Record Buy-In" button to add your first buy-in purchase
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
                {buyIn.airbnbConfirmation || buyIn.airbnbListingUrl ? (
                  <div className="flex items-center gap-1">
                    {buyIn.airbnbConfirmation && (
                      <span className="text-sm">{buyIn.airbnbConfirmation}</span>
                    )}
                    {buyIn.airbnbListingUrl && (
                      <a href={buyIn.airbnbListingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline text-xs">
                        {!buyIn.airbnbConfirmation && "View listing "}
                        <ExternalLink className="h-3 w-3" />
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
            Record buy-ins and sync bookings from your PMS to see your monthly profitability breakdown
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

          <TabsContent value="reports">
            <ReportsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
