import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  Images,
  Plus,
  Trash2,
  MapPin,
  Star,
  TrendingUp,
  MessageSquare,
  Camera,
} from "lucide-react";
import { getMultiUnitPropertyIds, getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import { useToast } from "@/hooks/use-toast";
import { computeQualityScore, extractBRList, gradeColor, gradeBg } from "@/data/quality-score";
import { getBuyInRate } from "@shared/pricing-rates";
import { apiRequest } from "@/lib/queryClient";
import type { CommunityDraft, GuestyPropertyMap } from "@shared/schema";

const STATUS_LABELS: Record<string, string> = {
  researching: "Researching",
  draft_ready: "Draft Ready",
  active: "Active",
};

type Property = {
  id: number;
  name: string;
  community: string;
  location: string;
  island: string;
  bedrooms: number;
  guests: number;
  bathrooms: number;
  lowPrice: number | null;
  highPrice: number | null;
  multiUnit: boolean;
  unitDetails: string;
  url: string;
};

const properties: Property[] = [
  {
    id: 1,
    name: "Poipu Kai for large groups!",
    community: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 7,
    guests: 18,
    bathrooms: 5,
    lowPrice: 1577,
    highPrice: 3168,
    multiUnit: true,
    unitDetails: "Multiple adjacent villas in Poipu Kai",
    url: "https://thevacationrentalexperts.com/en/poipu-kai-for-large-groups",
  },
  {
    id: 4,
    name: "Beautiful 6 Bedroom For 16 Villa in Poipu!",
    community: "Poipu Kai",
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
    community: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 5,
    guests: 12,
    bathrooms: 4,
    lowPrice: 1313,
    highPrice: 2237,
    multiUnit: true,
    unitDetails: "2 adjacent units (3BR + 2BR)",
    url: "https://thevacationrentalexperts.com/en/spacious-5-bedrooms-in-poipu-kai-ac",
  },
  {
    id: 19,
    name: "Fabulous 5 bedroom for 10 townhome above Anini Beach!",
    community: "Princeville",
    location: "Princeville",
    island: "Kauai",
    bedrooms: 5,
    guests: 10,
    bathrooms: 3,
    lowPrice: 1225,
    highPrice: 2092,
    multiUnit: true,
    unitDetails: "2 adjacent townhomes (3BR + 2BR)",
    url: "https://thevacationrentalexperts.com/en/fabulous-5-bedroom-for-10-townhome-above-famous-anini-beach",
  },
  {
    id: 20,
    name: "Fabulous 7 bedrooms for 16 above Anini Beach!",
    community: "Princeville",
    location: "Princeville",
    island: "Kauai",
    bedrooms: 7,
    guests: 16,
    bathrooms: 5,
    lowPrice: 2035,
    highPrice: 2970,
    multiUnit: true,
    unitDetails: "3 adjacent townhomes (3BR + 2BR + 2BR)",
    url: "https://thevacationrentalexperts.com/en/fabulous-7-bedrooms-for-16-above-famous-anini-beach",
  },
  {
    id: 23,
    name: "Gorgeous 5 br for 12 in Kapaa - Beachfront!",
    community: "Kapaa Beachfront",
    location: "Kapaa",
    island: "Kauai",
    bedrooms: 5,
    guests: 11,
    bathrooms: 5,
    lowPrice: 1577,
    highPrice: 1973,
    multiUnit: true,
    unitDetails: "3BR + 2BR oceanfront townhomes steps apart",
    url: "https://thevacationrentalexperts.com/en/gorgeous-5-br-for-12-in-kapaa---beachfront",
  },
  {
    id: 24,
    name: "Wonderful 5 br 12 Poipu ocean view! Oceanfront complex!",
    community: "Poipu Oceanfront",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 5,
    guests: 12,
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
    community: "Poipu Kai",
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
    name: "Ocean view 7 bedrooms for 14 above Anini Beach!",
    community: "Princeville",
    location: "Princeville",
    island: "Kauai",
    bedrooms: 7,
    guests: 14,
    bathrooms: 4,
    lowPrice: 1518,
    highPrice: 2897,
    multiUnit: true,
    unitDetails: "4BR + 3BR townhomes steps apart",
    url: "https://thevacationrentalexperts.com/en/ocean-view-7-bedrooms-for-14-above-famous-anini-beach",
  },
  {
    id: 32,
    name: "Gorgeous Poipu Townhomes for 12 with AC! 5 Bedrooms.",
    community: "Pili Mai",
    location: "Poipu",
    island: "Kauai",
    bedrooms: 5,
    guests: 12,
    bathrooms: 5,
    lowPrice: null,
    highPrice: null,
    multiUnit: true,
    unitDetails: "3BR + 2BR townhomes steps apart",
    url: "https://thevacationrentalexperts.com/en/gorgeous-poipu-townhomes-for-12-with-ac-5-bedrooms",
  },
  {
    id: 33,
    name: "Beautiful Poipu Townhomes for 12 with AC! 6 Bedrooms.",
    community: "Pili Mai",
    location: "Poipu",
    island: "Kauai",
    bedrooms: 6,
    guests: 12,
    bathrooms: 6,
    lowPrice: 1818,
    highPrice: 2771,
    multiUnit: true,
    unitDetails: "Two 3BR/3BA townhomes steps apart",
    url: "https://thevacationrentalexperts.com/en/beautiful-poipu-townhomes-for-12-with-ac-6-bedrooms",
  },
];

type SortField = "name" | "community" | "bedrooms" | "guests" | "lowPrice" | "highPrice" | "island" | "quality" | "baseRate";

// Total nightly buy-in cost across all units (sum of per-unit rates from
// shared/pricing-rates). Multi-unit properties get parsed from unitDetails
// (e.g. "3BR + 2BR" → sum of 3BR and 2BR rates); falls back to a single-unit
// lookup when parsing returns nothing useful.
function computeBaseRate(property: Property): number {
  const brs = property.multiUnit ? extractBRList(property.unitDetails) : [];
  if (brs.length >= 2 && brs.reduce((s, n) => s + n, 0) === property.bedrooms) {
    return brs.reduce((sum, br) => sum + getBuyInRate(property.community, br), 0);
  }
  return getBuyInRate(property.community, property.bedrooms);
}
type SortDir = "asc" | "desc";

export default function Home() {
  const [searchTerm, setSearchTerm] = useState("");
  const [communityFilter, setCommunityFilter] = useState("all");
  const [islandFilter, setIslandFilter] = useState("all");
  const [multiUnitFilter, setMultiUnitFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("community");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const qualityScores = useMemo(() => {
    const map = new Map<number, ReturnType<typeof computeQualityScore>>();
    for (const p of properties) {
      map.set(p.id, computeQualityScore(p));
    }
    return map;
  }, []);

  const baseRates = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of properties) {
      map.set(p.id, computeBaseRate(p));
    }
    return map;
  }, []);

  const communities = useMemo(() => {
    const set = new Set(properties.map((p) => p.community));
    return Array.from(set).sort();
  }, []);

  const islands = useMemo(() => {
    const set = new Set(properties.map((p) => p.island));
    return Array.from(set).sort();
  }, []);

  const filtered = useMemo(() => {
    let result = properties;
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(lower) ||
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
      if (sortField === "quality") {
        const aScore = qualityScores.get(a.id)?.total ?? 0;
        const bScore = qualityScores.get(b.id)?.total ?? 0;
        return sortDir === "asc" ? aScore - bScore : bScore - aScore;
      }
      if (sortField === "baseRate") {
        const aRate = baseRates.get(a.id) ?? 0;
        const bRate = baseRates.get(b.id) ?? 0;
        return sortDir === "asc" ? aRate - bRate : bRate - aRate;
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
  }, [searchTerm, communityFilter, islandFilter, multiUnitFilter, sortField, sortDir, qualityScores, baseRates]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="ml-1 h-3.5 w-3.5 text-muted-foreground" />;
    return sortDir === "asc" ? (
      <ArrowUp className="ml-1 h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="ml-1 h-3.5 w-3.5" />
    );
  };

  const multiUnitCount = properties.filter((p) => p.multiUnit).length;
  const avgBedrooms = Math.round((properties.reduce((s, p) => s + p.bedrooms, 0) / properties.length) * 10) / 10;
  const pricedProperties = properties.filter((p) => p.lowPrice !== null);
  const avgLow = pricedProperties.length
    ? Math.round(pricedProperties.reduce((s, p) => s + (p.lowPrice || 0), 0) / pricedProperties.length)
    : 0;

  const unitBuilderIds = useMemo(() => new Set(getMultiUnitPropertyIds()), []);

  const { data: communityDraftsData } = useQuery<CommunityDraft[]>({
    queryKey: ["/api/community/drafts"],
  });

  const { data: guestyMapData } = useQuery<GuestyPropertyMap[]>({
    queryKey: ["/api/guesty-property-map"],
  });
  const guestyConnected = useMemo(() => {
    if (!guestyMapData) return new Set<number>();
    return new Set(guestyMapData.map((m) => m.propertyId));
  }, [guestyMapData]);

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

  // Reverse-image-search status for the Photo Match column. One row
  // per photo folder. The per-property status is the WORST across that
  // property's folders (FOUND beats UNKNOWN beats CLEAN) — a match on
  // any one folder is what Jamie cares about.
  type PhotoStatus = "clean" | "found" | "unknown";
  type PhotoCheckRow = {
    folder: string;
    airbnbStatus: PhotoStatus;
    vrboStatus: PhotoStatus;
    bookingStatus: PhotoStatus;
    airbnbMatches: Array<{ photoUrl: string; listingUrl: string; title: string; source: string }>;
    vrboMatches:   Array<{ photoUrl: string; listingUrl: string; title: string; source: string }>;
    bookingMatches:Array<{ photoUrl: string; listingUrl: string; title: string; source: string }>;
    photosChecked: number;
    checkedAt: string | null;
    errorMessage: string | null;
  };
  const { data: photoCheckData } = useQuery<{ checks: PhotoCheckRow[] }>({
    queryKey: ["/api/photo-listing-check"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const photoCheckByFolder = useMemo(() => {
    const map = new Map<string, PhotoCheckRow>();
    for (const r of photoCheckData?.checks ?? []) map.set(r.folder, r);
    return map;
  }, [photoCheckData]);

  // Aggregate folder-level rows into property-level status.
  // Returns { airbnb, vrbo, booking } for each property; each value is
  // the worst across that property's folders (priority: found > unknown > clean).
  // `null` = no data yet for any of this property's folders (never scanned).
  type PhotoAggStatus = PhotoStatus | null;
  type PhotoAgg = { airbnb: PhotoAggStatus; vrbo: PhotoAggStatus; booking: PhotoAggStatus; lastCheckedAt: string | null; matchCounts: { airbnb: number; vrbo: number; booking: number } };
  const photoByProperty = useMemo(() => {
    const out = new Map<number, PhotoAgg>();
    const worst = (a: PhotoAggStatus, b: PhotoStatus): PhotoAggStatus => {
      const rank = (s: PhotoAggStatus) => s === "found" ? 3 : s === "unknown" ? 2 : s === "clean" ? 1 : 0;
      return rank(b) > rank(a) ? b : a;
    };
    for (const p of properties) {
      const builder = getUnitBuilderByPropertyId(p.id);
      const folderSet = new Set<string>();
      if (builder) {
        for (const u of builder.units) if (u.photoFolder) folderSet.add(u.photoFolder);
        if (builder.communityPhotoFolder) folderSet.add(builder.communityPhotoFolder);
      }
      const folders = Array.from(folderSet);
      let agg: PhotoAgg = { airbnb: null, vrbo: null, booking: null, lastCheckedAt: null, matchCounts: { airbnb: 0, vrbo: 0, booking: 0 } };
      for (const f of folders) {
        const row = photoCheckByFolder.get(f);
        if (!row) continue;
        agg.airbnb  = worst(agg.airbnb,  row.airbnbStatus);
        agg.vrbo    = worst(agg.vrbo,    row.vrboStatus);
        agg.booking = worst(agg.booking, row.bookingStatus);
        agg.matchCounts.airbnb  += row.airbnbMatches?.length  ?? 0;
        agg.matchCounts.vrbo    += row.vrboMatches?.length    ?? 0;
        agg.matchCounts.booking += row.bookingMatches?.length ?? 0;
        if (row.checkedAt && (!agg.lastCheckedAt || row.checkedAt > agg.lastCheckedAt)) {
          agg.lastCheckedAt = row.checkedAt;
        }
      }
      out.set(p.id, agg);
    }
    return out;
  }, [photoCheckByFolder]);

  const { toast } = useToast();
  const [runningPhotoScan, setRunningPhotoScan] = useState(false);
  const runPhotoScan = async () => {
    setRunningPhotoScan(true);
    try {
      const resp = await apiRequest("POST", "/api/photo-listing-check/run", {});
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to start scan");
      toast({
        title: "Photo scan started",
        description: `Scanning ${data.folders?.length ?? "?"} folders in the background. Refresh in a few minutes.`,
      });
    } catch (e: any) {
      toast({ title: "Couldn't start photo scan", description: e?.message, variant: "destructive" });
    } finally {
      setRunningPhotoScan(false);
    }
  };

  const queryClient = useQueryClient();

  const deleteDraftMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/community/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
    },
  });

  const communityVariant = (community: string): "default" | "secondary" | "outline" => {
    const poipuCommunities = ["Poipu Kai", "Poipu Brenneckes", "Poipu Oceanfront", "Pili Mai"];
    if (poipuCommunities.includes(community)) return "default";
    return "secondary";
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
              NexStay — Property Research
            </h1>
            <p className="text-muted-foreground mt-1">
              NexStay portfolio of vacation rental communities with pricing and performance data
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/add-community">
              <Button data-testid="button-add-community">
                <Plus className="h-4 w-4 mr-2" />
                Add New Community
              </Button>
            </Link>
            <Link href="/community-photo-finder">
              <Button variant="outline" data-testid="button-community-photo-finder">
                <Images className="h-4 w-4 mr-2" />
                Community Photos
              </Button>
            </Link>
            <Link href="/inbox">
              <Button variant="outline" data-testid="button-inbox">
                <MessageSquare className="h-4 w-4 mr-2" />
                Guest Inbox
              </Button>
            </Link>
            {/* Operations = consolidated Bookings + Buy-In Tracker + Availability Scanner.
                The individual pages remain accessible by URL for power users, but the
                everyday workflow (see booking → find buy-in → record it) lives here. */}
            <Link href="/bookings">
              <Button variant="outline" data-testid="button-operations">
                <CalendarSearch className="h-4 w-4 mr-2" />
                Operations
              </Button>
            </Link>
            <Button
              variant="outline"
              onClick={runPhotoScan}
              disabled={runningPhotoScan}
              data-testid="button-run-photo-scan"
              title="Reverse-image-search every property's photos on Airbnb, VRBO, and Booking.com"
            >
              <Camera className="h-4 w-4 mr-2" />
              {runningPhotoScan ? "Starting…" : "Run Photo Scan"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">Total Properties</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-total-properties">{properties.length}</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">Multi-Unit Combos</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-multi-unit-count">{multiUnitCount}</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">Avg Low Price/Night</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-avg-price">${avgLow.toLocaleString()}</p>
          </Card>
        </div>

        <Card className="p-4 mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
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
              <SelectTrigger className="w-[200px]" data-testid="select-community" id="select-community-filter" aria-label="Filter by community">
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
              <SelectTrigger className="w-[160px]" data-testid="select-island" id="select-island-filter" aria-label="Filter by island">
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
              <SelectTrigger className="w-[160px]" data-testid="select-multi-unit" id="select-type-filter" aria-label="Filter by property type">
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
              Showing {filtered.length} of {properties.length} properties
            </p>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                <BedDouble className="h-3 w-3 mr-1" />
                Avg {avgBedrooms} BR
              </Badge>
            </div>
          </div>
          <div className="overflow-x-auto">
          <Table id="list-properties" style={{ minWidth: 0 }}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[70px] sticky left-0 bg-background z-10">Actions</TableHead>
                <TableHead className="w-[26px] text-center px-0 text-muted-foreground">#</TableHead>
                <TableHead className="w-[20px] text-center px-0" title="Guesty listing connected">G</TableHead>
                <TableHead className="w-[84px] text-center px-1" title="Airbnb / VRBO / Booking.com — green = live & bookable, red = not live">Channels</TableHead>
                <TableHead className="w-[84px] text-center px-1" title="Reverse-image search: green = photos not found on that platform, red = photos appear on another listing, amber = not yet checked / Lens error">Photo Match</TableHead>
                <TableHead className="w-[180px] max-w-[180px] px-2">
                  <Button
                    variant="ghost"
                    className="font-medium px-1"
                    onClick={() => handleSort("name")}
                    data-testid="button-sort-name"
                    id="button-sort-name"
                    aria-label="Sort by property name"
                  >
                    Property Name
                    <SortIcon field="name" />
                  </Button>
                </TableHead>
                <TableHead className="w-[120px] px-2">
                  <Button
                    variant="ghost"
                    className="font-medium px-1"
                    onClick={() => handleSort("community")}
                    data-testid="button-sort-community"
                    id="button-sort-community"
                    aria-label="Sort by community"
                  >
                    Community
                    <SortIcon field="community" />
                  </Button>
                </TableHead>
                <TableHead className="text-right w-[95px] px-2">
                  <Button
                    variant="ghost"
                    className="font-medium px-1"
                    onClick={() => handleSort("baseRate")}
                    data-testid="button-sort-base-rate"
                    id="button-sort-base-rate"
                    aria-label="Sort by base rate"
                  >
                    Base Rate
                    <SortIcon field="baseRate" />
                  </Button>
                </TableHead>
                <TableHead className="w-[80px] px-2">
                  <Button
                    variant="ghost"
                    className="font-medium px-1"
                    onClick={() => handleSort("island")}
                    data-testid="button-sort-island"
                    id="button-sort-island"
                    aria-label="Sort by island"
                  >
                    Island
                    <SortIcon field="island" />
                  </Button>
                </TableHead>
                <TableHead className="text-center w-[50px]">
                  <Button
                    variant="ghost"
                    className="font-medium px-1"
                    onClick={() => handleSort("bedrooms")}
                    data-testid="button-sort-bedrooms"
                    id="button-sort-bedrooms"
                    aria-label="Sort by bedrooms"
                  >
                    BR
                    <SortIcon field="bedrooms" />
                  </Button>
                </TableHead>
                <TableHead className="text-center w-[70px]">
                  <Button
                    variant="ghost"
                    className="font-medium px-1"
                    onClick={() => handleSort("guests")}
                    data-testid="button-sort-guests"
                    id="button-sort-guests"
                    aria-label="Sort by guests"
                  >
                    Guests
                    <SortIcon field="guests" />
                  </Button>
                </TableHead>
                <TableHead className="text-center w-[90px]">
                  <Button
                    variant="ghost"
                    className="font-medium px-1"
                    onClick={() => handleSort("quality")}
                    data-testid="button-sort-quality"
                    id="button-sort-quality"
                    aria-label="Sort by quality score"
                  >
                    <TrendingUp className="h-3.5 w-3.5 mr-1" />
                    Quality
                    <SortIcon field="quality" />
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((property, idx) => (
                <TableRow key={property.id} data-testid={`row-property-${property.id}`} id={`item-property-${property.id}`}>
                  <TableCell className="sticky left-0 bg-background z-10 px-2">
                    {unitBuilderIds.has(property.id) ? (
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
                  <TableCell className="text-center text-muted-foreground text-xs">{idx + 1}</TableCell>
                  <TableCell className="text-center px-0">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full"
                            style={{ background: guestyConnected.has(property.id) ? "#16a34a" : "#d1d5db" }}
                            data-testid={`dot-guesty-${property.id}`}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {guestyConnected.has(property.id) ? "Connected to Guesty" : "Not in Guesty"}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                  <TableCell className="text-center px-1">
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
                        <div className="flex gap-0.5 justify-center items-center" data-testid={`channels-${property.id}`}>
                          {items.map((it) => {
                            const p = PAL[it.tone];
                            return (
                              <span
                                key={it.letter}
                                title={`${it.name}: ${p.desc}`}
                                className="inline-flex items-center justify-center h-[18px] px-1 rounded text-[9px] font-bold leading-none"
                                style={{ background: p.bg, color: "white", minWidth: 22 }}
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
                  <TableCell className="text-center px-1">
                    {(() => {
                      // Photo-match indicators mirror the Channels column:
                      // three badges per row with the same color palette.
                      //   - green ✓  → photos not found on that platform
                      //   - red ✗    → photos matched to ≥2 other listings
                      //                on that platform (likely re-post)
                      //   - amber ⚠  → not yet scanned OR Lens errored.
                      //                Check back after the weekly scan,
                      //                or click "Run Photo Scan".
                      const agg = photoByProperty.get(property.id);
                      type Tone = "ok" | "warn" | "bad";
                      const toneOf = (s: PhotoAggStatus): Tone => {
                        if (s === "clean") return "ok";
                        if (s === "found") return "bad";
                        return "warn"; // unknown or null
                      };
                      const PAL: Record<Tone, { bg: string; glyph: string }> = {
                        ok:   { bg: "#16a34a", glyph: "✓" },
                        warn: { bg: "#f59e0b", glyph: "⚠" },
                        bad:  { bg: "#dc2626", glyph: "✗" },
                      };
                      const items: Array<{ letter: string; name: string; status: PhotoAggStatus; matches: number }> = [
                        { letter: "A", name: "Airbnb",       status: agg?.airbnb  ?? null, matches: agg?.matchCounts.airbnb  ?? 0 },
                        { letter: "V", name: "VRBO",         status: agg?.vrbo    ?? null, matches: agg?.matchCounts.vrbo    ?? 0 },
                        { letter: "B", name: "Booking.com",  status: agg?.booking ?? null, matches: agg?.matchCounts.booking ?? 0 },
                      ];
                      const stamp = agg?.lastCheckedAt ? new Date(agg.lastCheckedAt).toLocaleDateString() : "never";
                      return (
                        <div className="flex gap-0.5 justify-center items-center" data-testid={`photo-match-${property.id}`}>
                          {items.map((it) => {
                            const tone = toneOf(it.status);
                            const p = PAL[tone];
                            const tip =
                              it.status === "clean" ? `${it.name}: no matches (last checked ${stamp})` :
                              it.status === "found" ? `${it.name}: ${it.matches} match${it.matches === 1 ? "" : "es"} found (last checked ${stamp})` :
                              it.status === "unknown" ? `${it.name}: Lens error on last run (${stamp}) — will retry` :
                              `${it.name}: never scanned — click Run Photo Scan`;
                            return (
                              <span
                                key={it.letter}
                                title={tip}
                                className="inline-flex items-center justify-center h-[18px] px-1 rounded text-[9px] font-bold leading-none"
                                style={{ background: p.bg, color: "white", minWidth: 22 }}
                                data-testid={`photo-match-${it.name.toLowerCase().replace(/\./g, "")}-${property.id}`}
                              >
                                {it.letter}{p.glyph}
                              </span>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="max-w-[180px] px-2">
                    <div className="min-w-0">
                      <span className="font-medium text-sm leading-tight block truncate" data-testid={`text-name-${property.id}`} id={`text-name-${property.id}`} title={property.name}>
                        {property.name}
                      </span>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{property.unitDetails}</p>
                    </div>
                  </TableCell>
                  <TableCell className="px-2">
                    <Badge
                      variant={communityVariant(property.community)}
                      className="no-default-hover-elevate no-default-active-elevate text-xs"
                      data-testid={`badge-community-${property.id}`}
                    >
                      {property.community}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right px-2 tabular-nums text-sm" data-testid={`text-base-rate-${property.id}`}>
                    ${(baseRates.get(property.id) ?? 0).toLocaleString()}
                  </TableCell>
                  <TableCell className="px-2">
                    <span className="text-sm text-muted-foreground">{property.island}</span>
                  </TableCell>
                  <TableCell className="text-center">
                    <span className="font-medium" data-testid={`text-bedrooms-${property.id}`}>
                      {property.bedrooms}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    <span className="font-medium" data-testid={`text-guests-${property.id}`}>
                      {property.guests}
                    </span>
                  </TableCell>
                  <TableCell className="text-center" data-testid={`cell-quality-${property.id}`}>
                    {(() => {
                      const qs = qualityScores.get(property.id);
                      if (!qs) return null;
                      return (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs font-semibold cursor-help ${gradeBg(qs.grade)}`}
                                data-testid={`badge-quality-${property.id}`}
                              >
                                <span className={gradeColor(qs.grade)}>{qs.total}</span>
                                <span className="text-muted-foreground font-normal">/10</span>
                                <span className={`ml-0.5 font-bold ${gradeColor(qs.grade)}`}>{qs.grade}</span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="w-64 p-3">
                              <p className="font-semibold mb-2 flex items-center gap-1.5">
                                <TrendingUp className="h-3.5 w-3.5" />
                                Arbitrage Quality Score
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
                                <div className="border-t pt-1.5 mt-1.5 flex justify-between font-semibold">
                                  <span>Total</span>
                                  <span>{qs.total} / 10 ({qs.grade})</span>
                                </div>
                                <div className="border-t pt-1.5 mt-0.5 text-muted-foreground space-y-0.5">
                                  <div className="flex justify-between">
                                    <span>Est. standalone market rate</span>
                                    <span>${qs.marketRate.toLocaleString()}/night</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>Our listing savings</span>
                                    <span className="text-emerald-600 font-medium">{qs.discountPct}% cheaper</span>
                                  </div>
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      );
                    })()}
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center py-8 text-muted-foreground">
                    No properties match your filters
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        </Card>

        {/* Community Drafts Section */}
        {communityDraftsData && communityDraftsData.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Plus className="h-5 w-5 text-primary" />
                  New Communities in Research
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Communities discovered through the Add New Community workflow
                </p>
              </div>
              <Link href="/add-community">
                <Button size="sm" data-testid="button-add-community-small">
                  <Plus className="h-4 w-4 mr-1" /> Add Another
                </Button>
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {communityDraftsData.map(draft => (
                <Card key={draft.id} className="p-4 relative" data-testid={`card-draft-${draft.id}`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-sm truncate" data-testid={`text-draft-name-${draft.id}`}>{draft.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3 inline mr-0.5" />{draft.city}, {draft.state}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Badge variant="outline" className="text-xs">
                        {STATUS_LABELS[draft.status] ?? draft.status}
                      </Badge>
                      <button
                        className="text-muted-foreground hover:text-destructive transition-colors p-1"
                        onClick={() => deleteDraftMutation.mutate(draft.id)}
                        data-testid={`button-delete-draft-${draft.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                    {draft.combinedBedrooms && (
                      <span><BedDouble className="h-3 w-3 inline mr-0.5" />{draft.combinedBedrooms}BR combined</span>
                    )}
                    {draft.suggestedRate && (
                      <span><DollarSign className="h-3 w-3 inline" />${draft.suggestedRate}/night</span>
                    )}
                    {draft.confidenceScore && (
                      <span><Star className="h-3 w-3 inline mr-0.5" />{draft.confidenceScore}/100</span>
                    )}
                  </div>
                  {draft.researchSummary && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{draft.researchSummary}</p>
                  )}
                  {draft.listingTitle && (
                    <p className="text-xs font-medium mt-1 truncate">{draft.listingTitle}</p>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 text-xs text-muted-foreground text-center">
          NexStay portfolio data. Prices shown are nightly rates and may vary by season.
        </div>
      </div>
    </div>
  );
}
