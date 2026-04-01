import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  ExternalLink,
  Building2,
  BedDouble,
  Users,
  DollarSign,
  Layers,
  MapPin,
  Hammer,
  ClipboardList,
  Loader2,
  CalendarSearch,
  Images,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import { getMultiUnitPropertyIds, getAllMultiUnitProperties } from "@/data/unit-builder-data";
import { apiRequest } from "@/lib/queryClient";
import type { CommunityDraft } from "@shared/schema";

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
    id: 7,
    name: "Beautiful 8 brs for 22 near Poipu Beach Park!",
    community: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 8,
    guests: 22,
    bathrooms: 7,
    lowPrice: 2369,
    highPrice: 3894,
    multiUnit: true,
    unitDetails: "3 adjacent villas (3BR + 3BR + 2BR)",
    url: "https://thevacationrentalexperts.com/en/beautiful-8-brs-for-22-near-poipu-beach-park",
  },
  {
    id: 8,
    name: "Wonderful Large Group option in Poipu Kai!",
    community: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 6,
    guests: 16,
    bathrooms: 5,
    lowPrice: 1577,
    highPrice: 1577,
    multiUnit: true,
    unitDetails: "2 adjacent 3BR units in Poipu Kai",
    url: "https://thevacationrentalexperts.com/en/wonderful-large-group-option-in-poipu-kai",
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
    id: 10,
    name: "Fabulous 5 br for 15 private beachfront Estate!",
    community: "Kekaha Beachfront",
    location: "Kekaha",
    island: "Kauai",
    bedrooms: 5,
    guests: 15,
    bathrooms: 3,
    lowPrice: 2105,
    highPrice: 2105,
    multiUnit: true,
    unitDetails: "Main house + guest quarters on beachfront estate",
    url: "https://thevacationrentalexperts.com/en/fabulous-5-br-for-15-private-beachfront-estate",
  },
  {
    id: 12,
    name: "Incredible Kekaha Beachfront Estate for 10!",
    community: "Kekaha Beachfront",
    location: "Kekaha",
    island: "Kauai",
    bedrooms: 5,
    guests: 10,
    bathrooms: 4,
    lowPrice: 1577,
    highPrice: 1782,
    multiUnit: true,
    unitDetails: "Main house + guest quarters",
    url: "https://thevacationrentalexperts.com/en/incredible-kekaha-beachfront-estate-for-10",
  },
  {
    id: 14,
    name: "Fabulous 7 br 22 ocean view pool estate!",
    community: "Keauhou",
    location: "Kahaluu-Keauhou",
    island: "Big Island",
    bedrooms: 7,
    guests: 22,
    bathrooms: 5,
    lowPrice: 2237,
    highPrice: 2237,
    multiUnit: true,
    unitDetails: "Main house + guest quarters estate",
    url: "https://thevacationrentalexperts.com/en/fabulous-7-br-22-ocean-view-pool-estate",
  },
  {
    id: 18,
    name: "Fabulous Six BR for 16 Poipu Kai! Steps to 3 Beaches!",
    community: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 6,
    guests: 16,
    bathrooms: 5,
    lowPrice: 2046,
    highPrice: 3293,
    multiUnit: true,
    unitDetails: "2 adjacent 3BR units in Poipu Kai",
    url: "https://thevacationrentalexperts.com/en/fabulous-six-br-for-16-poipu-kai-steps-to-the-3-beaches",
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
    id: 21,
    name: "Fabulous 8 bedrooms Poipu Kai steps to beach!",
    community: "Poipu Kai",
    location: "Poipu",
    island: "Kauai",
    bedrooms: 8,
    guests: 16,
    bathrooms: 6,
    lowPrice: 2105,
    highPrice: 3300,
    multiUnit: true,
    unitDetails: "2 adjacent villas in same building",
    url: "https://thevacationrentalexperts.com/en/fabulous-8-bedrooms-poipu-kai-steps-to-beach",
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
    id: 26,
    name: "Fabulous 7 bedroom for 23 near Magic Sands Beach!",
    community: "Keauhou",
    location: "Kahaluu-Keauhou",
    island: "Big Island",
    bedrooms: 7,
    guests: 23,
    bathrooms: 4,
    lowPrice: 1650,
    highPrice: 2897,
    multiUnit: true,
    unitDetails: "Main house + guest quarters with private pool",
    url: "https://thevacationrentalexperts.com/en/fabulous-7-bedroom-for-23-near-magic-sands-beach",
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
    id: 28,
    name: "Beautiful ocean view Poipu 7 brs for 17! 60 yards to Beach!",
    community: "Poipu Brenneckes",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 7,
    guests: 17,
    bathrooms: 6,
    lowPrice: 3135,
    highPrice: 3399,
    multiUnit: true,
    unitDetails: "4BR home + 3BR home 10 feet apart",
    url: "https://thevacationrentalexperts.com/en/beautiful-ocean-view-poipu-7-brs-for-17-60-yards-to-beach",
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
    id: 31,
    name: "Fabulous 7 bedroom for 14 oceanfront Poipu pool home!",
    community: "Poipu Brenneckes",
    location: "Poipu",
    island: "Kauai",
    bedrooms: 7,
    guests: 14,
    bathrooms: 4,
    lowPrice: 3894,
    highPrice: 3953,
    multiUnit: true,
    unitDetails: "5BR main home + 2BR guest quarters",
    url: "https://thevacationrentalexperts.com/en/fabulous-7-bedroom-for-14-oceanfront-poipu-pool-home",
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
  {
    id: 34,
    name: "Wonderful 6 Bedroom For 16 Villa in Poipu!",
    community: "Poipu Kai",
    location: "Koloa",
    island: "Kauai",
    bedrooms: 6,
    guests: 16,
    bathrooms: 4,
    lowPrice: 1445,
    highPrice: 3333,
    multiUnit: true,
    unitDetails: "2 side-by-side 3BR condos",
    url: "https://thevacationrentalexperts.com/en/wonderful-6-bedroom-for-16-villa-in-poipu",
  },
];

type SortField = "name" | "community" | "bedrooms" | "guests" | "lowPrice" | "highPrice" | "island";
type SortDir = "asc" | "desc";

export default function Home() {
  const [searchTerm, setSearchTerm] = useState("");
  const [communityFilter, setCommunityFilter] = useState("all");
  const [islandFilter, setIslandFilter] = useState("all");
  const [multiUnitFilter, setMultiUnitFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("community");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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
      let aVal: string | number | null = a[sortField];
      let bVal: string | number | null = b[sortField];
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
  }, [searchTerm, communityFilter, islandFilter, multiUnitFilter, sortField, sortDir]);

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
  const poipuKaiCount = properties.filter((p) => p.community === "Poipu Kai").length;
  const avgBedrooms = Math.round((properties.reduce((s, p) => s + p.bedrooms, 0) / properties.length) * 10) / 10;
  const pricedProperties = properties.filter((p) => p.lowPrice !== null);
  const avgLow = pricedProperties.length
    ? Math.round(pricedProperties.reduce((s, p) => s + (p.lowPrice || 0), 0) / pricedProperties.length)
    : 0;

  const unitBuilderIds = useMemo(() => new Set(getMultiUnitPropertyIds()), []);

  const multiUnitProps = useMemo(() => getAllMultiUnitProperties(), []);

  const { data: lodgifyData, isLoading: lodgifyLoading } = useQuery<{ count: number | null; items: any[] }>({
    queryKey: ["/api/lodgify/properties"],
  });

  const { data: communityDraftsData } = useQuery<CommunityDraft[]>({
    queryKey: ["/api/community/drafts"],
  });

  const queryClient = useQueryClient();

  const deleteDraftMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/community/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
    },
  });

  const lodgifyStatusMap = useMemo(() => {
    const map = new Map<number, { found: boolean; lodgifyName?: string; lodgifyId?: number }>();
    if (!lodgifyData?.items) return map;
    const lodgifyProps = lodgifyData.items as any[];
    const usedLodgifyIds = new Set<number>();

    const candidates: { propertyId: number; lodgifyProp: any; score: number }[] = [];

    for (const mp of multiUnitProps) {
      const dashProp = properties.find(p => p.id === mp.propertyId);
      if (!dashProp) continue;

      for (const lp of lodgifyProps) {
        const name = (lp.name || "").toLowerCase();
        const complexLower = mp.complexName.toLowerCase();
        const propNameLower = mp.propertyName.toLowerCase();
        const nameMatchesComplex = name.includes(complexLower) || complexLower.includes(name);
        const nameMatchesProp = name.includes(propNameLower) || propNameLower.includes(name);
        if (!nameMatchesComplex && !nameMatchesProp) continue;

        let score = 0;
        const brMatch = name.match(/(\d+)\s*br/i) || name.match(/(\d+)\s*bedroom/i);
        const sleepsMatch = name.match(/sleeps\s*(\d+)/i);

        if (brMatch) {
          if (parseInt(brMatch[1]) === dashProp.bedrooms) score += 10;
          else continue;
        }
        if (sleepsMatch) {
          if (parseInt(sleepsMatch[1]) === dashProp.guests) score += 10;
          else continue;
        }
        if (nameMatchesProp) score += 5;
        if (nameMatchesComplex) score += 2;

        candidates.push({ propertyId: mp.propertyId, lodgifyProp: lp, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const c of candidates) {
      if (usedLodgifyIds.has(c.lodgifyProp.id)) continue;
      if (map.has(c.propertyId) && map.get(c.propertyId)!.found) continue;
      usedLodgifyIds.add(c.lodgifyProp.id);
      map.set(c.propertyId, { found: true, lodgifyName: c.lodgifyProp.name, lodgifyId: c.lodgifyProp.id });
    }

    for (const mp of multiUnitProps) {
      if (!map.has(mp.propertyId)) {
        map.set(mp.propertyId, { found: false });
      }
    }

    return map;
  }, [lodgifyData, multiUnitProps]);

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
            <Link href="/availability-scanner">
              <Button variant="outline" data-testid="button-availability-scanner">
                <CalendarSearch className="h-4 w-4 mr-2" />
                Availability Scanner
              </Button>
            </Link>
            <Link href="/buy-in-tracker">
              <Button variant="outline" data-testid="button-buy-in-tracker">
                <DollarSign className="h-4 w-4 mr-2" />
                Buy-In Tracker
              </Button>
            </Link>
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
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">Poipu Kai Properties</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-poipu-kai-count">{poipuKaiCount}</p>
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
                placeholder="Search properties..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={communityFilter} onValueChange={setCommunityFilter}>
              <SelectTrigger className="w-[200px]" data-testid="select-community">
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
              <SelectTrigger className="w-[160px]" data-testid="select-island">
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
              <SelectTrigger className="w-[160px]" data-testid="select-multi-unit">
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

        <Card>
          <div className="p-3 border-b flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" data-testid="text-showing-count">
              Showing {filtered.length} of {properties.length} properties
            </p>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                <BedDouble className="h-3 w-3 mr-1" />
                Avg {avgBedrooms} BR
              </Badge>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30px] text-center">#</TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    className="font-medium"
                    onClick={() => handleSort("name")}
                    data-testid="button-sort-name"
                  >
                    Property Name
                    <SortIcon field="name" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    className="font-medium"
                    onClick={() => handleSort("community")}
                    data-testid="button-sort-community"
                  >
                    Community
                    <SortIcon field="community" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    className="font-medium"
                    onClick={() => handleSort("island")}
                    data-testid="button-sort-island"
                  >
                    Island
                    <SortIcon field="island" />
                  </Button>
                </TableHead>
                <TableHead className="text-center">
                  <Button
                    variant="ghost"
                    className="font-medium"
                    onClick={() => handleSort("bedrooms")}
                    data-testid="button-sort-bedrooms"
                  >
                    BR
                    <SortIcon field="bedrooms" />
                  </Button>
                </TableHead>
                <TableHead className="text-center">
                  <Button
                    variant="ghost"
                    className="font-medium"
                    onClick={() => handleSort("guests")}
                    data-testid="button-sort-guests"
                  >
                    Guests
                    <SortIcon field="guests" />
                  </Button>
                </TableHead>
                <TableHead className="text-right">
                  <Button
                    variant="ghost"
                    className="font-medium"
                    onClick={() => handleSort("lowPrice")}
                    data-testid="button-sort-low-price"
                  >
                    Low $/Night
                    <SortIcon field="lowPrice" />
                  </Button>
                </TableHead>
                <TableHead className="text-right">
                  <Button
                    variant="ghost"
                    className="font-medium"
                    onClick={() => handleSort("highPrice")}
                    data-testid="button-sort-high-price"
                  >
                    High $/Night
                    <SortIcon field="highPrice" />
                  </Button>
                </TableHead>
                <TableHead className="text-center">Type</TableHead>
                <TableHead className="text-center w-[60px]">Lodgify</TableHead>
                <TableHead className="w-[40px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((property, idx) => (
                <TableRow key={property.id} data-testid={`row-property-${property.id}`}>
                  <TableCell className="text-center text-muted-foreground text-xs">{idx + 1}</TableCell>
                  <TableCell>
                    <div className="max-w-[280px]">
                      <span className="font-medium text-sm leading-tight" data-testid={`text-name-${property.id}`}>
                        {property.name}
                      </span>
                      <p className="text-xs text-muted-foreground mt-0.5">{property.unitDetails}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={communityVariant(property.community)}
                      className="no-default-hover-elevate no-default-active-elevate text-xs"
                      data-testid={`badge-community-${property.id}`}
                    >
                      {property.community}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">{property.island}</span>
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      <BedDouble className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium" data-testid={`text-bedrooms-${property.id}`}>
                        {property.bedrooms}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium" data-testid={`text-guests-${property.id}`}>
                        {property.guests}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="font-medium" data-testid={`text-low-price-${property.id}`}>
                      {property.lowPrice ? `$${property.lowPrice.toLocaleString()}` : "N/A"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="font-medium" data-testid={`text-high-price-${property.id}`}>
                      {property.highPrice ? `$${property.highPrice.toLocaleString()}` : "N/A"}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    {property.multiUnit ? (
                      <Badge variant="outline" className="text-xs">
                        <Layers className="h-3 w-3 mr-1" />
                        Multi
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">Single</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {property.multiUnit ? (
                      lodgifyLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground mx-auto" data-testid={`status-lodgify-loading-${property.id}`} />
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex justify-center" data-testid={`status-lodgify-${property.id}`}>
                              <div className={`h-3 w-3 rounded-full ${lodgifyStatusMap.get(property.id)?.found ? "bg-green-500" : "bg-red-500"}`} />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            {lodgifyStatusMap.get(property.id)?.found
                              ? `In Lodgify: "${lodgifyStatusMap.get(property.id)?.lodgifyName}"`
                              : "Not yet built out in Lodgify"}
                          </TooltipContent>
                        </Tooltip>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {unitBuilderIds.has(property.id) && (
                        <>
                          <Link href={`/unit-builder/${property.id}`}>
                            <Button size="icon" variant="ghost" data-testid={`button-unit-builder-${property.id}`}>
                              <Hammer className="h-4 w-4" />
                            </Button>
                          </Link>
                          <Link href={`/lodgify-prep/${property.id}`}>
                            <Button size="icon" variant="ghost" data-testid={`button-lodgify-prep-${property.id}`}>
                              <ClipboardList className="h-4 w-4" />
                            </Button>
                          </Link>
                        </>
                      )}
                      <a
                        href={property.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`link-property-${property.id}`}
                      >
                        <Button size="icon" variant="ghost">
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </a>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                    No properties match your filters
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
