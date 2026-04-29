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
  RotateCw,
  Check,
} from "lucide-react";
import { getMultiUnitPropertyIds, getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import { isScannableFolder } from "@shared/photo-folder-utils";
import { useToast } from "@/hooks/use-toast";
import { computeQualityScore, extractBRList, gradeColor, gradeBg } from "@/data/quality-score";
import { getBuyInRate } from "@shared/pricing-rates";
import { apiRequest } from "@/lib/queryClient";
import type { CommunityDraft, GuestyPropertyMap } from "@shared/schema";
import { GuestyConnectDialog } from "@/components/GuestyConnectDialog";

const STATUS_LABELS: Record<string, string> = {
  researching: "Researching",
  draft_ready: "Draft Ready",
  active: "Active",
};

// `community` is the displayed complex name (Kaha Lani Resort, Regency at
// Poipu Kai, …) — kept in sync with `complexName` in unit-builder-data so
// the dashboard, builder, and PDF all agree on what to call a property.
// `pricingArea` is the lookup key for shared/pricing-rates BUY_IN_RATES
// and quality-score MARKET_RATE_PER_BR / LOCATION_DEMAND tables, which
// are keyed by area (Poipu Kai, Princeville, …) — multiple complexes
// can share an area, so the two fields stay separate. When adding a
// new property, set `community` to the specific complex and
// `pricingArea` to the area whose buy-in rates apply.
type Property = {
  id: number;
  // `draftId` is set when the row was sourced from a community
  // draft (`/api/community/drafts`) rather than the hard-coded
  // active list. `id` is then a synthetic negative number so
  // id-keyed caches (qualityScores, baseRates, the `filtered`
  // sort) never collide with active property ids.
  draftId?: number;
  // Status pulled from the underlying community_drafts row.
  // "researching" / "draft_ready" → renders with DRAFT pill +
  // trash + Promote actions. "published" → renders as a regular
  // active row (no DRAFT pill, Build button targets the
  // builder via the synthetic negative id route). Active
  // hardcoded rows leave this undefined.
  draftStatus?: string;
  name: string;
  community: string;
  pricingArea: string;
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
    community: "Regency at Poipu Kai",
    pricingArea: "Poipu Kai",
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
    community: "Regency at Poipu Kai",
    pricingArea: "Poipu Kai",
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
    community: "Regency at Poipu Kai",
    pricingArea: "Poipu Kai",
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
    community: "Mauna Kai Princeville",
    pricingArea: "Princeville",
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
    community: "Mauna Kai Princeville",
    pricingArea: "Princeville",
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
    community: "Kaha Lani Resort",
    pricingArea: "Kapaa Beachfront",
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
    community: "Makahuena at Poipu",
    pricingArea: "Poipu Oceanfront",
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
    community: "Regency at Poipu Kai",
    pricingArea: "Poipu Kai",
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
    community: "Kaiulani of Princeville",
    pricingArea: "Princeville",
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
    pricingArea: "Pili Mai",
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
    pricingArea: "Pili Mai",
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
// lookup when parsing returns nothing useful. Pricing keys off pricingArea
// (e.g. "Poipu Kai") rather than the displayed complex name (e.g. "Regency
// at Poipu Kai") because BUY_IN_RATES is keyed by area.
function computeBaseRate(property: Property): number {
  const brs = property.multiUnit ? extractBRList(property.unitDetails) : [];
  if (brs.length >= 2 && brs.reduce((s, n) => s + n, 0) === property.bedrooms) {
    return brs.reduce((sum, br) => sum + getBuyInRate(property.pricingArea, br, property.id), 0);
  }
  return getBuyInRate(property.pricingArea, property.bedrooms, property.id);
}
type SortDir = "asc" | "desc";

export default function Home() {
  const [searchTerm, setSearchTerm] = useState("");
  const [communityFilter, setCommunityFilter] = useState("all");
  const [islandFilter, setIslandFilter] = useState("all");
  const [multiUnitFilter, setMultiUnitFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("community");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // When the operator clicks an unmapped (gray) G-dot we open the
  // connect-to-existing dialog seeded with this row's id + name.
  const [connectTarget, setConnectTarget] = useState<{ id: number; name: string } | null>(null);

  // Pull community drafts up here (early in the render) because
  // `allProperties` below depends on them and `qualityScores` /
  // `baseRates` / `filtered` all read `allProperties`. The fetch
  // is deduped by react-query so rendering it twice (here and the
  // existing useQuery further down used to delete drafts) is free.
  const { data: communityDraftsDataForRows } = useQuery<CommunityDraft[]>({
    queryKey: ["/api/community/drafts"],
  });

  // Map community drafts → Property-shaped rows so they show up in
  // the main table next to the active 11 properties. Synthetic
  // negative `id` ensures no collision with active property ids —
  // every cache keyed on `id` (qualityScores, baseRates, the
  // useMemo `filtered` sort) stays unique.
  //
  // Empty / fallback fields:
  //   - `pricingArea` is "" so getBuyInRate / quality lookups
  //     fall through to fallbacks. Drafts don't yet belong to a
  //     known buy-in area; the operator picks one when promoting
  //     the draft into unit-builder-data.
  //   - `island` defaults to the state name (Florida, Hawaii, …)
  //     so the Island filter still has something to scope on.
  //   - `bathrooms` is the sum of per-unit bathrooms parsed from
  //     the AI draft strings ("2" / "2.5"); falls back to 0.
  const draftsAsProperties: Property[] = useMemo(() => {
    if (!communityDraftsDataForRows) return [];
    const parseBath = (s: string | null) => {
      const n = Number(String(s ?? "").replace(/[^\d.]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    return communityDraftsDataForRows.map((d) => {
      const u1Br = d.unit1Bedrooms ?? 0;
      const u2Br = d.unit2Bedrooms ?? 0;
      const totalBr = d.combinedBedrooms ?? (u1Br + u2Br);
      const totalGuests =
        ((d.unit1MaxGuests ?? 0) + (d.unit2MaxGuests ?? 0)) ||
        // Fallback: 2 guests/BR, the rough rule the existing 11
        // properties follow.
        totalBr * 2;
      const totalBath =
        parseBath(d.unit1Bathrooms ?? null) + parseBath(d.unit2Bathrooms ?? null);
      const unitDetails =
        u1Br > 0 && u2Br > 0
          ? `${u1Br}BR + ${u2Br}BR`
          : "Two units (draft)";
      return {
        id: -d.id, // negative so id-keyed caches never collide with active rows
        draftId: d.id,
        draftStatus: d.status,
        name: d.listingTitle || d.name,
        community: d.name,
        // pricingArea is set on the wizard's Step 5 (auto-suggested
        // from city/state, operator can override). Empty = no area
        // → buy-in calc returns the per-bedroom default.
        pricingArea: d.pricingArea ?? "",
        location: d.city,
        island: d.state,
        bedrooms: totalBr,
        guests: totalGuests,
        bathrooms: totalBath,
        lowPrice: d.estimatedLowRate ?? d.suggestedRate ?? null,
        highPrice: d.estimatedHighRate ?? null,
        multiUnit: true,
        unitDetails,
        url: d.sourceUrl ?? "",
      };
    });
  }, [communityDraftsDataForRows]);

  // Combined list used by every downstream calc (qualityScores,
  // baseRates, communities/islands filters, the rendered rows).
  // Active properties first so they sort to the top by default;
  // drafts append below until the user changes sort order.
  const allProperties = useMemo(
    () => [...properties, ...draftsAsProperties],
    [draftsAsProperties],
  );

  const qualityScores = useMemo(() => {
    const map = new Map<number, ReturnType<typeof computeQualityScore>>();
    // Quality score is only meaningful for active properties — it
    // depends on a real lowPrice and pricingArea-keyed market data.
    // Drafts get rendered with "—" in the Quality column so the
    // operator doesn't read a misleading number.
    for (const p of properties) {
      // computeQualityScore reads `community` as a pricing/demand key
      // (MARKET_RATE_PER_BR, LOCATION_DEMAND), so feed pricingArea — the
      // displayed complex name (Regency at Poipu Kai, Mauna Kai
      // Princeville, …) won't match those tables.
      map.set(p.id, computeQualityScore({ ...p, community: p.pricingArea }));
    }
    return map;
  }, []);

  // Subscribe to the live-buy-in feed so `baseRates` recomputes
  // after `App.tsx`'s MarketRatesHydrator populates the shared cache
  // in `@shared/pricing-rates`. Without this dep, the dashboard would
  // render once on mount with the static `BUY_IN_RATES` fallback and
  // never update — same fetch, deduped by react-query key.
  const { data: marketRatesData } = useQuery<unknown[]>({
    queryKey: ["/api/property/market-rates"],
  });
  const baseRates = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of allProperties) {
      map.set(p.id, computeBaseRate(p));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProperties, marketRatesData]);

  const communities = useMemo(() => {
    const set = new Set(allProperties.map((p) => p.community));
    return Array.from(set).sort();
  }, [allProperties]);

  const islands = useMemo(() => {
    const set = new Set(allProperties.map((p) => p.island));
    return Array.from(set).sort();
  }, [allProperties]);

  const filtered = useMemo(() => {
    let result = allProperties;
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
  }, [allProperties, searchTerm, communityFilter, islandFilter, multiUnitFilter, sortField, sortDir, qualityScores, baseRates]);

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

  // Unacknowledged photo-theft alerts. Each alert is one platform
  // transitioning from clean/unknown → found. Dismissed from the
  // banner below via POST /api/photo-listing-alerts/:id/acknowledge.
  type PhotoAlert = {
    id: number;
    folder: string;
    platform: "airbnb" | "vrbo" | "booking";
    priorStatus: PhotoStatus;
    newStatus: PhotoStatus;
    matchedUrls: Array<{ photoUrl: string; listingUrl: string; title: string; source: string }>;
    detectedAt: string;
  };
  const { data: photoAlertsData, refetch: refetchAlerts } = useQuery<{ alerts: PhotoAlert[] }>({
    queryKey: ["/api/photo-listing-alerts?unacknowledged=1"],
    queryFn: async () => {
      const resp = await fetch("/api/photo-listing-alerts?unacknowledged=1");
      if (!resp.ok) throw new Error("Failed to load alerts");
      return resp.json();
    },
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  // Hide community-* alerts from the banner. They fire one-time when
  // a shared amenity photo legitimately appears on another host's
  // listing — no signal value. The scanner stopped writing new ones
  // as of the "skip community folders" change, but a few old rows
  // remain in the DB; filter them out client-side rather than
  // running a destructive DB cleanup.
  const alerts = (photoAlertsData?.alerts ?? []).filter((a) => !a.folder.startsWith("community-"));
  const acknowledgeAlert = async (id: number) => {
    try {
      const resp = await apiRequest("POST", `/api/photo-listing-alerts/${id}/acknowledge`, {});
      if (!resp.ok) throw new Error("Acknowledge failed");
      refetchAlerts();
    } catch (e: any) {
      toast({ title: "Couldn't acknowledge alert", description: e?.message, variant: "destructive" });
    }
  };

  // Per-alert "Replace & push" status. Idle when absent. The state is
  //   { phase: "running" | "done" | "error", message, percent }
  // so the row can render a green "✓ Done!" pill for ~1.5s before the
  // refetch removes it, surface errors inline + sticky (not just in
  // a transient toast that the operator can miss), and show a visual
  // progress bar that advances as phase events stream in (PR #316).
  type RemediateState = { phase: "running" | "done" | "error"; message: string; percent: number };
  const [remediating, setRemediating] = useState<Record<number, RemediateState>>({});
  const setStatus = (id: number, s: RemediateState) =>
    setRemediating((r) => ({ ...r, [id]: s }));
  const clearStatus = (id: number) =>
    setRemediating((r) => { const n = { ...r }; delete n[id]; return n; });

  // Map a server phase name to the cumulative percent the operator
  // should see when that phase STARTS. Tuned to the rough wall-time
  // distribution of a typical remediate (find ~30%, scrape ~30%,
  // download+vision ~25%, push ~10%):
  //   start            5%  — set immediately on click
  //   find-replacement 10% — kicks off Zillow + platform-check fan-out
  //   candidate        40% — replacement unit chosen
  //   scrape           55% — downloading photos from Zillow
  //   download         75% — vision rerank + write into folder
  //   push             90% — Guesty channel-republish
  //   done            100% — final inline pill
  // Server emits: phase events for "find-replacement", "scrape",
  // "download-photos", "push"; plus "candidate", "swap", "push", "done".
  // Anything we don't recognize falls back to whatever percent we're at.
  const phasePercent = (phaseName: string | undefined, currentPercent: number): number => {
    switch (phaseName) {
      case "find-replacement": return 10;
      case "scrape":           return 55;
      case "download-photos":  return 75;
      case "downloadAndPrioritize": return 75; // alt name some emit paths use
      case "push":             return 90;
      default:                 return currentPercent;
    }
  };

  const remediateAlert = async (id: number) => {
    // Console breadcrumb so a silent client-side failure (network drop,
    // adblocker, etc) is visible to anyone debugging via DevTools.
    console.info(`[remediate] click → POST /api/photo-listing-alerts/${id}/remediate`);
    setStatus(id, { phase: "running", message: "Starting…", percent: 5 });
    try {
      const resp = await fetch(`/api/photo-listing-alerts/${id}/remediate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      console.info(`[remediate] alert ${id} → HTTP ${resp.status} ${resp.ok ? "(streaming)" : "(error)"}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${resp.status}`);
      }
      if (!resp.body) throw new Error("No response body");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let didFinish = false;
      let lastError: string | null = null;
      let percent = 5;
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as any;
            console.debug(`[remediate] alert ${id} event:`, ev);
            if (ev.type === "phase") {
              percent = phasePercent(ev.name, percent);
              setStatus(id, { phase: "running", message: ev.message ?? ev.name, percent });
            } else if (ev.type === "candidate") {
              percent = Math.max(percent, 40);
              setStatus(id, { phase: "running", message: `Found ${ev.unitLabel}`, percent });
            } else if (ev.type === "swap") {
              percent = Math.max(percent, 80);
              setStatus(id, { phase: "running", message: `Swapped ${ev.kept} photos`, percent });
            } else if (ev.type === "push") {
              percent = Math.max(percent, 90);
              setStatus(id, {
                phase: "running",
                message: ev.success ? `Pushed ${ev.savedOnGuesty} to ${ev.listing}` : `Push failed: ${ev.listing}`,
                percent,
              });
            } else if (ev.type === "done") {
              didFinish = true;
            } else if (ev.type === "error") {
              lastError = ev.message ?? `${ev.phase} error`;
            }
          } catch { /* ignore malformed line */ }
        }
      }
      if (didFinish) {
        console.info(`[remediate] alert ${id} → success`);
        // Brief inline confirmation BEFORE the row disappears, so the
        // operator sees the click "took". Toast also fires for context.
        setStatus(id, { phase: "done", message: "✓ Done!", percent: 100 });
        toast({
          title: "Photos replaced and pushed",
          description: "Guesty will sync new photos to Airbnb/VRBO/Booking over the next few minutes.",
        });
        await new Promise((r) => setTimeout(r, 1500));
        clearStatus(id);
        refetchAlerts();
      } else {
        throw new Error(lastError ?? "Remediate did not finish");
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error(`[remediate] alert ${id} → error:`, msg);
      // Sticky inline error (cleared after 8s) so the operator can read
      // it even if they miss the toast. Toast still fires for emphasis.
      setStatus(id, { phase: "error", message: `✗ ${msg}`, percent: 100 });
      toast({ title: "Couldn't remediate alert", description: msg, variant: "destructive" });
      setTimeout(() => clearStatus(id), 8000);
    }
  };

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
  type PhotoAgg = { airbnb: PhotoAggStatus; vrbo: PhotoAggStatus; booking: PhotoAggStatus; lastCheckedAt: string | null; matchCounts: { airbnb: number; vrbo: number; booking: number }; hasScannableFolders: boolean };
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
        // Unit folders only. communityPhotoFolder is excluded (shared
        // amenities, no unit signal). isScannableFolder consults the
        // FOLDER_UNIT_TOKENS map first and the folder-name hint
        // second, so any folder the scanner can verify against — by
        // name OR by canonical claim — qualifies. Folders the
        // scanner skips (no map entry AND no digit hint) drop out
        // here too, keeping the dashboard aggregation in lockstep
        // with what was scanned.
        for (const u of builder.units) {
          if (u.photoFolder && isScannableFolder(u.photoFolder)) folderSet.add(u.photoFolder);
        }
      }
      const folders = Array.from(folderSet);
      let agg: PhotoAgg = { airbnb: null, vrbo: null, booking: null, lastCheckedAt: null, matchCounts: { airbnb: 0, vrbo: 0, booking: 0 }, hasScannableFolders: folders.length > 0 };
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

  // Promote a draft to "published" — flips the status flag so the
  // row renders as a regular active property (no DRAFT pill, Build
  // button enabled). The data stays in `community_drafts` rather
  // than moving to a separate `properties` table; the dashboard
  // and the builder both read from the same source. Reuses the
  // existing PATCH /api/community/:id endpoint.
  const promoteDraftMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await apiRequest("PATCH", `/api/community/${id}`, { status: "published" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
      toast({ title: "Promoted to active", description: "Row now appears as a regular property." });
    },
    onError: (e: any) => toast({ title: "Promote failed", description: e.message, variant: "destructive" }),
  });

  // Highlight south-shore (Poipu) properties with the primary badge tone.
  // Keys off pricingArea — the styling decision is per-area, not per the
  // displayed complex name, so it stays right when multiple complexes
  // share the same area.
  const communityVariant = (pricingArea: string): "default" | "secondary" | "outline" => {
    const poipuAreas = ["Poipu Kai", "Poipu Brenneckes", "Poipu Oceanfront", "Pili Mai"];
    if (poipuAreas.includes(pricingArea)) return "default";
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

        {alerts.length > 0 && (
          <Card className="p-3 mb-4 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30" data-testid="photo-alert-banner">
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                ⚠ {alerts.length} photo-listing alert{alerts.length === 1 ? "" : "s"} detected
              </p>
              <p className="text-xs text-muted-foreground">
                Your photos appear on a listing you don't control. Review and dismiss once actioned.
              </p>
            </div>
            <div className="space-y-1.5">
              {alerts.slice(0, 5).map((a) => {
                const platformLabel = a.platform === "airbnb" ? "Airbnb" : a.platform === "vrbo" ? "VRBO" : "Booking.com";
                const firstUrl = a.matchedUrls?.[0]?.listingUrl;
                const status = remediating[a.id];
                const isRunning = status?.phase === "running";
                const isDone = status?.phase === "done";
                const isError = status?.phase === "error";
                return (
                  <div key={a.id} className="flex flex-col gap-1" data-testid={`photo-alert-${a.id}`}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 font-medium">
                        {platformLabel}
                      </span>
                      <span className="font-mono text-[11px]">{a.folder}</span>
                      <span className="text-muted-foreground">{a.priorStatus} → {a.newStatus}</span>
                      {firstUrl && (
                        <a
                          href={firstUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          view listing ↗
                        </a>
                      )}
                      <span className="text-muted-foreground ml-auto">{new Date(a.detectedAt).toLocaleString()}</span>
                      {(() => {
                        const colorClass = isDone
                          ? "bg-green-600 hover:bg-green-600 text-white"
                          : isError
                          ? "bg-red-600 hover:bg-red-600 text-white"
                          : "";
                        return (
                          <Button
                            size="sm"
                            className={`h-6 text-xs px-2 ${colorClass}`}
                            onClick={() => remediateAlert(a.id)}
                            disabled={isRunning || isDone}
                            data-testid={`button-remediate-alert-${a.id}`}
                            title="Find a clean replacement unit on Zillow, swap the photos in this folder, and re-push to Guesty (which fans out to Airbnb/VRBO/Booking)."
                          >
                            {isDone ? (
                              <Check className="h-3 w-3 mr-1" />
                            ) : (
                              <RotateCw className={`h-3 w-3 mr-1 ${isRunning ? "animate-spin" : ""}`} />
                            )}
                            {status?.message ?? "Replace & push"}
                          </Button>
                        );
                      })()}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs px-2"
                        onClick={() => acknowledgeAlert(a.id)}
                        disabled={isRunning}
                        data-testid={`button-acknowledge-alert-${a.id}`}
                      >
                        Dismiss
                      </Button>
                    </div>
                    {/* Progress bar (PR #316). Visible while running and
                        for ~1.5s after done so the operator sees the
                        bar fill to 100% before the row disappears. */}
                    {(isRunning || isDone) && (
                      <div className="flex items-center gap-2 pl-1 pr-1">
                        <div
                          className="h-1.5 flex-1 rounded-full bg-red-200 dark:bg-red-900/40 overflow-hidden"
                          data-testid={`progress-remediate-alert-${a.id}`}
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={status?.percent ?? 0}
                          aria-label={`Replace & push progress: ${status?.message ?? ""}`}
                        >
                          <div
                            className={`h-full transition-[width] duration-300 ease-out ${isDone ? "bg-green-600" : "bg-red-600"}`}
                            style={{ width: `${Math.max(0, Math.min(100, status?.percent ?? 0))}%` }}
                          />
                        </div>
                        <span className="text-[10px] tabular-nums text-muted-foreground min-w-[2.5rem] text-right">
                          {Math.round(status?.percent ?? 0)}%
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
              {alerts.length > 5 && (
                <p className="text-xs text-muted-foreground pt-1">
                  … and {alerts.length - 5} more.
                </p>
              )}
            </div>
          </Card>
        )}

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
              {filtered.map((property, idx) => {
                // Three states for the Actions column:
                //   1. Active hardcoded property (in unitBuilderIds) → Build link
                //   2. Draft awaiting promotion (draftStatus !== "published") →
                //      DRAFT pill + Promote (publish) + Delete
                //   3. Promoted draft (draftStatus === "published") → renders
                //      like an active row (Build link, regular styling) so the
                //      operator can click into the builder for it. Build links
                //      to `/builder/<negative-id>/preflight`; the preflight
                //      page falls back to fetching the draft when the property
                //      isn't in the static unitBuilderData list.
                const isDraft = property.draftId !== undefined;
                const isPublishedDraft = isDraft && property.draftStatus === "published";
                const isResearchDraft = isDraft && !isPublishedDraft;
                return (
                <TableRow
                  key={property.id}
                  data-testid={`row-property-${property.id}`}
                  id={`item-property-${property.id}`}
                  className={isResearchDraft ? "bg-amber-50/40 dark:bg-amber-900/10" : ""}
                >
                  <TableCell
                    className="sticky left-0 z-10 px-2"
                    style={{ background: isResearchDraft ? "rgba(254, 243, 199, 0.4)" : undefined }}
                  >
                    {isResearchDraft ? (
                      <div className="flex items-center gap-1">
                        <Badge
                          variant="outline"
                          className="h-7 px-2 text-[10px] font-semibold bg-amber-100 border-amber-300 text-amber-900"
                          data-testid={`badge-draft-${property.draftId}`}
                        >
                          DRAFT
                        </Badge>
                        <button
                          onClick={() => promoteDraftMutation.mutate(property.draftId!)}
                          disabled={promoteDraftMutation.isPending}
                          className="text-emerald-700 hover:text-emerald-800 transition-colors p-1 disabled:opacity-50"
                          aria-label="Promote draft to active property"
                          data-testid={`button-promote-draft-${property.draftId}`}
                          title="Promote to active property"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => deleteDraftMutation.mutate(property.draftId!)}
                          className="text-muted-foreground hover:text-destructive transition-colors p-1"
                          aria-label="Delete draft"
                          data-testid={`button-delete-draft-${property.draftId}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ) : isPublishedDraft ? (
                      <Link href={`/builder/${property.id}/preflight`}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2 gap-1"
                          data-testid={`button-unit-builder-${property.id}`}
                          aria-label={`Open builder for ${property.name}`}
                        >
                          <Hammer className="h-3 w-3" />
                          Build
                        </Button>
                      </Link>
                    ) : unitBuilderIds.has(property.id) ? (
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
                          {guestyConnected.has(property.id) ? (
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full"
                              style={{ background: "#16a34a" }}
                              data-testid={`dot-guesty-${property.id}`}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConnectTarget({ id: property.id, name: property.name })}
                              className="inline-block w-2.5 h-2.5 rounded-full hover:ring-2 hover:ring-emerald-300 transition-shadow cursor-pointer"
                              style={{ background: "#d1d5db" }}
                              aria-label={`Connect ${property.name} to a Guesty listing`}
                              data-testid={`dot-guesty-${property.id}`}
                            />
                          )}
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {guestyConnected.has(property.id)
                            ? "Connected to Guesty"
                            : "Click to connect to a Guesty listing"}
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
                      type Tone = "ok" | "warn" | "bad" | "na";
                      // "na" = the property has no scannable folders
                      // (all unit photoFolders are placeholders or
                      // community-*). The scanner won't write rows for
                      // these, so showing amber "never scanned" would
                      // be misleading — render grey + clarify in the
                      // tooltip that the unit folder name needs a
                      // real unit number to enable scanning.
                      const noFolders = agg ? !agg.hasScannableFolders : false;
                      const toneOf = (s: PhotoAggStatus): Tone => {
                        if (noFolders) return "na";
                        if (s === "clean") return "ok";
                        if (s === "found") return "bad";
                        return "warn"; // unknown or null
                      };
                      const PAL: Record<Tone, { bg: string; glyph: string }> = {
                        ok:   { bg: "#16a34a", glyph: "✓" },
                        warn: { bg: "#f59e0b", glyph: "⚠" },
                        bad:  { bg: "#dc2626", glyph: "✗" },
                        na:   { bg: "#9ca3af", glyph: "–" },
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
                              noFolders ? `${it.name}: no scannable units — backfill real unit numbers in unit-builder-data to enable scanning` :
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
                      variant={communityVariant(property.pricingArea)}
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
                      // Drafts don't get a quality score — the
                      // calculation needs a real listed price and a
                      // pricingArea-keyed market rate, neither of
                      // which exists yet for a research-stage draft.
                      // Render "—" so the cell isn't visually broken.
                      if (!qs) return <span className="text-muted-foreground text-xs">—</span>;
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
                );
              })}
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

        {/* Drafts now render as rows in the main table above (DRAFT
            badge in the Actions column, deletable inline). The
            standalone "New Communities in Research" cards section
            used to live here — removed because it duplicated what's
            in the table now. */}

        <div className="mt-4 text-xs text-muted-foreground text-center">
          NexStay portfolio data. Prices shown are nightly rates and may vary by season.
        </div>
      </div>

      <GuestyConnectDialog
        propertyId={connectTarget?.id ?? null}
        propertyName={connectTarget?.name ?? ""}
        open={connectTarget !== null}
        onOpenChange={(open) => { if (!open) setConnectTarget(null); }}
      />
    </div>
  );
}
