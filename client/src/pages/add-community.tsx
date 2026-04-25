import { useState, useCallback, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  ArrowRight,
  MapPin,
  Search,
  Loader2,
  CheckCircle2,
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
import { BUY_IN_RATES, suggestPricingArea } from "@shared/pricing-rates";

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
};

type UnitResult = {
  url: string;
  title: string;
  bedrooms: number | null;
  price: number | null;
  source: string;
};

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
};

type CommunityProfile = {
  availableTypes: number[];
  airbnbListingCount: number;
  ratesByBR: Record<string, { median: number | null; count: number }>;
};

type PhotoItem = { url: string; label: string };

type PhotoCheckResult = { clean: boolean; matches: Array<{ platform: string; url: string }> };

export default function AddCommunity() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState(1);

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

  // Step 2
  const [communities, setCommunities] = useState<CommunityResult[]>([]);
  const [researchLoading, setResearchLoading] = useState(false);
  const [selectedCommunity, setSelectedCommunity] = useState<CommunityResult | null>(null);

  // Top-markets sweep — scans a curated list of US vacation-rental hotspots
  type MarketResult = {
    city: string;
    state: string;
    tag?: string;
    status: "pending" | "running" | "done" | "error";
    count?: number;
    communities?: CommunityResult[];
    error?: string;
  };
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepMarkets, setSweepMarkets] = useState<MarketResult[]>([]);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepDone, setSweepDone] = useState(false);
  const sweepAbortRef = useRef<AbortController | null>(null);
  // Two-phase flow for the sweep modal. "setup" shows a checkbox grid the
  // user picks markets from; "running" shows streaming per-market progress.
  // Avoids the old behavior of firing a ~30-minute sweep across all 20
  // markets the moment the user clicks the button.
  type SweepPhase = "setup" | "running";
  const [sweepPhase, setSweepPhase] = useState<SweepPhase>("setup");
  const [seedMarkets, setSeedMarkets] = useState<Array<{ city: string; state: string; tag: string }> | null>(null);
  const [selectedMarkets, setSelectedMarkets] = useState<Set<string>>(new Set());
  const keyFor = (m: { city: string; state: string }) => `${m.city}|${m.state}`;

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
  const [photosLoading, setPhotosLoading] = useState(false);
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
  // Mai, Caribe Cove, etc.) live at one canonical street address shared
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
  const [saving, setSaving] = useState(false);

  const combinedBedrooms = (selectedUnit1?.bedrooms ?? 0) + (selectedUnit2?.bedrooms ?? 0);
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

  // ── Step 2: Research ────────────────────────────────────────
  const handleResearch = useCallback(async () => {
    if (!selectedState || !cityInput.trim()) {
      toast({ title: "Please select a state and enter a city", variant: "destructive" });
      return;
    }
    setResearchLoading(true);
    setCommunities([]);
    try {
      const res = await apiRequest("POST", "/api/community/research", { city: cityInput.trim(), state: selectedState });
      const data = await res.json();
      setCommunities(data.communities || []);
      if ((data.communities || []).length === 0) {
        toast({ title: "No qualifying communities found", description: "Try a different city or state." });
      } else {
        setStep(2);
      }
    } catch (e: any) {
      toast({ title: "Research failed", description: e.message, variant: "destructive" });
    } finally {
      setResearchLoading(false);
    }
  }, [selectedState, cityInput, toast]);

  // ── Open the sweep modal in setup mode. Fetches the curated list of
  // markets (if we haven't already) so the checkbox grid can render.
  const openSweepSetup = useCallback(async () => {
    setSweepOpen(true);
    setSweepPhase("setup");
    setSweepDone(false);
    setSweepMarkets([]);
    if (!seedMarkets) {
      try {
        const resp = await fetch("/api/community/top-markets/seeds");
        const data = await resp.json() as { seeds?: Array<{ city: string; state: string; tag: string }> };
        const list = data.seeds ?? [];
        setSeedMarkets(list);
        // Pre-select everything so the user can hit Run immediately if
        // they want the original auto-all behavior. They can uncheck what
        // they don't want.
        setSelectedMarkets(new Set(list.map(keyFor)));
      } catch (e: any) {
        toast({ title: "Couldn't load market list", description: e.message, variant: "destructive" });
      }
    }
  }, [seedMarkets, toast]);

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

  // ── Top-markets sweep: stream per-market progress for the selected
  // markets. Kicked off by the Run button inside the modal's setup phase.
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
    setSweepMarkets(picked.map((m) => ({ city: m.city, state: m.state, tag: m.tag, status: "pending" })));

    const controller = new AbortController();
    sweepAbortRef.current = controller;

    try {
      const resp = await fetch("/api/community/scan-top-markets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markets: picked, maxMarkets: picked.length }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        toast({ title: "Sweep failed", description: `HTTP ${resp.status}`, variant: "destructive" });
        setSweepRunning(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }

          if (evt.type === "start") {
            setSweepMarkets((evt.markets as any[]).map((m) => ({
              city: m.city, state: m.state, tag: m.tag, status: "pending",
            })));
          } else if (evt.type === "market-start") {
            setSweepMarkets((prev) => prev.map((m) =>
              m.city === evt.city && m.state === evt.state ? { ...m, status: "running" } : m
            ));
          } else if (evt.type === "market-done") {
            setSweepMarkets((prev) => prev.map((m) =>
              m.city === evt.city && m.state === evt.state
                ? { ...m, status: "done", count: evt.count, communities: evt.communities }
                : m
            ));
          } else if (evt.type === "market-error") {
            setSweepMarkets((prev) => prev.map((m) =>
              m.city === evt.city && m.state === evt.state
                ? { ...m, status: "error", error: evt.error }
                : m
            ));
          } else if (evt.type === "all-done") {
            setSweepDone(true);
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        toast({ title: "Sweep error", description: e.message, variant: "destructive" });
      }
    } finally {
      setSweepRunning(false);
      sweepAbortRef.current = null;
    }
  }, [seedMarkets, selectedMarkets, toast]);

  const stopSweep = () => sweepAbortRef.current?.abort();

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
  const handleSelectCommunity = useCallback(async (community: CommunityResult) => {
    setSelectedCommunity(community);
    setUnitSearchLoading(true);
    setUnitSearchResults(null);
    setCommunityProfile(null);
    setSuggestedPairings([]);
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
      });
      const data = await res.json();
      setUnitSearchResults(data);
      if (data.communityProfile) setCommunityProfile(data.communityProfile);
      if (data.suggestedPairings?.length) setSuggestedPairings(data.suggestedPairings);
    } catch (e: any) {
      toast({ title: "Pairing analysis failed", description: e.message, variant: "destructive" });
    } finally {
      setUnitSearchLoading(false);
    }
  }, [toast]);

  const handleSelectPairing = useCallback((pairing: SuggestedPairing) => {
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
  }, []);

  // ── Step 4: Fetch photos ────────────────────────────────────
  const handleConfirmUnits = useCallback(async () => {
    if (!selectedUnit1 || !selectedUnit2) {
      toast({ title: "Please select two units to combine", variant: "destructive" });
      return;
    }
    setStep(4);
    setPhotosLoading(true);
    setUnit1Photos([]);
    setUnit2Photos([]);
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
    const buildBody = (u: UnitResult) =>
      u.url
        ? { url: u.url }
        : {
            communityName: selectedCommunity?.name,
            city: selectedCommunity?.city,
            state: selectedCommunity?.state,
            bedrooms: u.bedrooms ?? undefined,
          };
    const canFetch = (u: UnitResult) => !!(u.url || (selectedCommunity?.name && u.bedrooms));

    const fetches: Array<Promise<void>> = [];
    if (canFetch(selectedUnit1)) {
      fetches.push(
        apiRequest("POST", "/api/community/fetch-unit-photos", buildBody(selectedUnit1))
          .then((r) => r.json())
          .then((d) => setUnit1Photos((d.photos || []).slice(0, 25))),
      );
    }
    if (canFetch(selectedUnit2)) {
      fetches.push(
        apiRequest("POST", "/api/community/fetch-unit-photos", buildBody(selectedUnit2))
          .then((r) => r.json())
          .then((d) => setUnit2Photos((d.photos || []).slice(0, 25))),
      );
    }

    if (fetches.length === 0) {
      // Nothing we can fetch with — neither a URL nor enough
      // community info to search. The page's empty state covers it.
      setPhotosLoading(false);
      return;
    }

    try {
      await Promise.all(fetches);
    } catch (e: any) {
      toast({ title: "Photo fetch failed", description: e.message, variant: "destructive" });
    } finally {
      setPhotosLoading(false);
    }
  }, [selectedUnit1, selectedUnit2, selectedCommunity, toast]);

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
    setListingLoading(true);
    setStep(5);
    try {
      const res = await apiRequest("POST", "/api/community/generate-listing", {
        communityName: selectedCommunity.name,
        city: selectedCommunity.city,
        state: selectedCommunity.state,
        unit1: {
          bedrooms: selectedUnit1.bedrooms ?? 2,
          url: selectedUnit1.url,
          address: (selectedUnit1 as any).address,
        },
        unit2: {
          bedrooms: selectedUnit2.bedrooms ?? 2,
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
      // Seed the pricing-area picker from the wizard's city/state
      // unless the operator already picked one. The same default
      // logic powers buy-in / quality calcs for the existing 11
      // active rows (Hawaii cities → Poipu Kai / Princeville /
      // Kapaa Beachfront / Kekaha Beachfront / Keauhou).
      if (!editedPricingArea && selectedCommunity?.city && selectedCommunity?.state) {
        const suggested = suggestPricingArea(selectedCommunity.city, selectedCommunity.state);
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
        toast({ title: "AI draft incomplete", description: data.warning, variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Listing generation failed", description: e.message, variant: "destructive" });
    } finally {
      setListingLoading(false);
    }
  }, [selectedCommunity, selectedUnit1, selectedUnit2, suggestedRate, strPermit, toast]);

  // ── Save to dashboard ───────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!selectedCommunity) return;
    setSaving(true);
    try {
      const saveResp = await apiRequest("POST", "/api/community/save", {
        name: selectedCommunity.name,
        city: selectedCommunity.city,
        state: selectedCommunity.state,
        estimatedLowRate: selectedCommunity.estimatedLowRate,
        estimatedHighRate: selectedCommunity.estimatedHighRate,
        unitTypes: selectedCommunity.unitTypes,
        confidenceScore: selectedCommunity.confidenceScore,
        researchSummary: selectedCommunity.researchSummary,
        sourceUrl: selectedCommunity.sourceUrl,
        unit1Url: selectedUnit1?.url ?? null,
        unit1Bedrooms: selectedUnit1?.bedrooms ?? null,
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
        unit2Url: selectedUnit2?.url ?? null,
        unit2Bedrooms: selectedUnit2?.bedrooms ?? null,
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
        streetAddress: editedStreetAddress.trim() || null,
        listingDescription: editedDescription || null,
        neighborhood: editedNeighborhood || null,
        transit: editedTransit || null,
        strPermit: strPermit.trim() || null,
        status: "draft_ready",
      });
      // Persist Step 4 photos so the builder has them when the
      // operator promotes the draft. Best-effort — a failure here
      // doesn't roll back the draft save (the operator can re-run
      // photo persistence later by editing + re-saving).
      const saved = await saveResp.json().catch(() => null) as { id?: number } | null;
      const draftId = saved?.id;
      if (draftId && (unit1Photos.length > 0 || unit2Photos.length > 0)) {
        try {
          await apiRequest("POST", `/api/community/${draftId}/persist-photos`, {
            unit1Photos: unit1Photos.map((p) => p.url),
            unit2Photos: unit2Photos.map((p) => p.url),
          });
        } catch (e: any) {
          console.warn(`[add-community] photo persist failed: ${e?.message}`);
          // Surface a soft warning but don't block — the draft saved successfully.
          toast({
            title: "Saved (photos pending)",
            description: "Community saved, but the photos didn't persist. Edit + re-save to retry.",
          });
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
      toast({ title: "Community saved to dashboard!" });
      navigate("/");
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [selectedCommunity, selectedUnit1, selectedUnit2, combinedBedrooms, suggestedRate, editedTitle, editedBookingTitle, editedPropertyType, editedPricingArea, editedStreetAddress, editedDescription, editedNeighborhood, editedTransit, editedUnitA, editedUnitB, strPermit, unit1Photos, unit2Photos, toast, navigate, queryClient]);

  const flaggedPhotos = Object.values(photoChecks).filter(v => v !== "checking" && !(v as PhotoCheckResult).clean);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="button-back-home">
              <ArrowLeft className="h-4 w-4 mr-1" /> Dashboard
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Add a New Community</h1>
            <p className="text-sm text-muted-foreground">Research, validate, and draft a new NexStay bundled listing</p>
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

        {/* ── STEP 1: Location ─────────────────────────────── */}
        {step === 1 && (
          <Card className="p-6" id="step-1-content">
            <div className="flex items-center gap-2 mb-4">
              <MapPin className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold" id="step-1-heading">Step 1: Select Location</h2>
            </div>
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
            {researchLoading && (
              <p className="text-sm text-muted-foreground mt-3" id="status-message">
                Searching for communities and scoring with AI — this takes 20–40 seconds…
              </p>
            )}
          </Card>
        )}

        {/* ── TOP-MARKETS SWEEP MODAL ─────────────────────────── */}
        {sweepOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
            onClick={() => !sweepRunning && setSweepOpen(false)}
          >
            <div
              className="bg-background rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-primary" />
                    {sweepPhase === "setup" ? "Pick markets to scan" : "Top Markets Sweep"}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {sweepPhase === "setup"
                      ? "Check the markets you want to research. Each one takes ~90s. Start with 2–3 to keep the wait short."
                      : "Running the finder across your selected markets. Each takes ~90s."}
                  </p>
                </div>
                <div className="flex gap-2">
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
                      </div>
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
                                    return (
                                      <label
                                        key={k}
                                        className={`flex items-center gap-2 px-3 py-2 rounded border cursor-pointer text-sm transition-colors ${
                                          checked ? "border-primary bg-primary/5" : "hover:border-muted-foreground/40"
                                        }`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() => toggleMarket(m)}
                                          className="accent-primary"
                                        />
                                        <span>
                                          {m.city}, {m.state}
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

              {/* Per-market list (running/done phase) */}
              {sweepPhase === "running" && (
              <div className="space-y-2">
                {sweepMarkets.map((m) => {
                  const best = m.communities?.[0];
                  const bestScore = best ? best.confidenceScore + (best.combinabilityScore ?? 50) : 0;
                  return (
                    <Card
                      key={`${m.city}-${m.state}`}
                      className={`p-3 ${
                        m.status === "done" && (m.count ?? 0) > 0 ? "border-green-200 bg-green-50/40 hover:border-green-500 cursor-pointer" :
                        m.status === "error" ? "border-red-200 bg-red-50/30" :
                        m.status === "running" ? "border-blue-300 bg-blue-50/30" :
                        "opacity-60"
                      }`}
                      onClick={() => m.status === "done" && (m.count ?? 0) > 0 && selectSweepCity(m)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-sm">{m.city}, {m.state}</p>
                            {m.tag && <Badge variant="outline" className="text-[10px]">{m.tag}</Badge>}
                            {m.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />}
                            {m.status === "done" && (
                              <Badge className={(m.count ?? 0) > 0 ? "bg-green-600 text-white" : "bg-gray-400 text-white"}>
                                {m.count ?? 0} qualifying
                              </Badge>
                            )}
                            {m.status === "error" && <Badge variant="destructive">Error</Badge>}
                          </div>
                          {best && (
                            <div className="text-xs text-muted-foreground mt-1 truncate">
                              Best pick: <span className="font-medium text-foreground">{best.name}</span>
                              {best.bedroomMix && <span className="italic ml-1">({best.bedroomMix})</span>}
                              {typeof best.combinabilityScore === "number" && (
                                <span className="ml-1.5">· combinability {best.combinabilityScore}</span>
                              )}
                              <span className="ml-1.5">· score {bestScore}</span>
                            </div>
                          )}
                          {m.error && (
                            <p className="text-xs text-red-700 mt-1">{m.error}</p>
                          )}
                        </div>
                        {m.status === "done" && (m.count ?? 0) > 0 && (
                          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
              )}

              {sweepPhase === "running" && sweepDone && (
                <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-xs text-muted-foreground">
                    Click any green market to load its results into Step 2.
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setSweepPhase("setup"); setSweepMarkets([]); setSweepDone(false); }}
                  >
                    ← Scan different markets
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── STEP 2: Research results ──────────────────────── */}
        {step === 2 && (
          <div id="step-2-content">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Search className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-2-heading">Step 2: Community Research</h2>
              </div>
              <Button variant="outline" size="sm" onClick={() => setStep(1)} data-testid="button-back-step1" id="btn-prev-step" aria-label="Go back to Step 1: Select Location">
                <ArrowLeft className="h-4 w-4 mr-1" /> Change Location
              </Button>
            </div>
            <div id="summary-panel" className="mb-4 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
              <strong>Location:</strong> {cityInput}, {selectedState} — <strong>{communities.length}</strong> communities found. Select one to continue.
            </div>
            <p className="text-muted-foreground text-sm mb-4">
              Found {communities.length} qualifying communities in <strong>{cityInput}, {selectedState}</strong>. Click a card to select it.
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
                return (
                <Card
                  key={i}
                  className={
                    typeCheck.eligible
                      ? "p-4 cursor-pointer hover:border-primary transition-colors"
                      : "p-4 opacity-60 cursor-not-allowed bg-muted/30 border-dashed"
                  }
                  onClick={() => {
                    if (!typeCheck.eligible) {
                      toast({
                        title: "Not a supported community type",
                        description: typeCheck.reason ?? "Only condo or townhome communities can be added.",
                        variant: "destructive",
                      });
                      return;
                    }
                    handleSelectCommunity(c);
                  }}
                  data-testid={`card-community-${i}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
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
                            {c.combinedBedroomsTypical ? ` · 2×${Math.round(c.combinedBedroomsTypical / 2)}BR=${c.combinedBedroomsTypical}BR` : ""}
                          </Badge>
                        )}
                        {c.fromWorldKnowledge && (
                          <Badge variant="outline" className="text-[10px] border-blue-300 text-blue-700">
                            From AI knowledge
                          </Badge>
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
                    <div className="flex items-center gap-2 shrink-0">
                      {c.sourceUrl && (
                        <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                          <Button variant="ghost" size="sm"><ExternalLink className="h-4 w-4" /></Button>
                        </a>
                      )}
                      <Button size="sm" data-testid={`button-select-community-${i}`}>
                        Select <ArrowRight className="h-4 w-4 ml-1" />
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
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-3-heading">Step 3: Select Unit Combination</h2>
              </div>
              <Button variant="outline" size="sm" onClick={() => setStep(2)} data-testid="button-back-step2" id="btn-prev-step" aria-label="Go back to Step 2">
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
                      <div className="flex items-center gap-4 mt-2 text-sm">
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

            {unitSearchLoading && (
              <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-sm font-medium">Analyzing community listings on Airbnb & VRBO…</p>
                <p className="text-xs">Generating algorithm-suggested unit combinations</p>
              </div>
            )}

            {!unitSearchLoading && suggestedPairings.length > 0 && (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-sm">Algorithm-Suggested Combinations</h3>
                  <Badge variant="outline" className="text-xs ml-auto">Select one to continue</Badge>
                </div>

                <div className="space-y-3 mb-6">
                  {suggestedPairings.map((p, i) => {
                    const isSelected = selectedPairing?.unit1Beds === p.unit1Beds && selectedPairing?.unit2Beds === p.unit2Beds;
                    const buyCost = p.estimatedUnit1Rate + p.estimatedUnit2Rate;
                    const profit = p.estimatedSellRate - buyCost;
                    return (
                      <div
                        key={i}
                        onClick={() => handleSelectPairing(p)}
                        className={`relative p-4 rounded-xl border-2 cursor-pointer transition-all ${
                          isSelected
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-border hover:border-primary/40 hover:bg-muted/30"
                        }`}
                        data-testid={`card-pairing-${i}`}
                      >
                        {p.isTopPick && (
                          <div className="absolute -top-2.5 left-4">
                            <Badge className="text-xs bg-amber-500 hover:bg-amber-500 text-white border-0 gap-1">
                              <Star className="h-3 w-3" /> Algorithm Top Pick
                            </Badge>
                          </div>
                        )}
                        {isSelected && (
                          <div className="absolute top-3 right-3">
                            <CheckCircle2 className="h-5 w-5 text-primary" />
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
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
                      </div>
                    );
                  })}
                </div>

                {selectedPairing && (
                  <Button
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
          </div>
        )}

        {/* ── STEP 4: Photos + platform check ──────────────── */}
        {step === 4 && (
          <div id="step-4-content">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Camera className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-4-heading">Step 4: Photos & Platform Check</h2>
              </div>
              <Button variant="outline" size="sm" onClick={() => setStep(3)} data-testid="button-back-step3" id="btn-prev-step" aria-label="Go back to Step 3: Select Unit Pair">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
            </div>
            <div id="summary-panel" className="mb-4 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
              <strong>Community:</strong> {selectedCommunity?.name} — <strong>Unit 1:</strong> {selectedUnit1?.title} — <strong>Unit 2:</strong> {selectedUnit2?.title}.{" "}
              {unit1Photos.length + unit2Photos.length > 0 ? `${unit1Photos.length + unit2Photos.length} photos loaded.` : photosLoading ? "Loading photos…" : "No photos loaded."}
              {Object.values(photoChecks).filter(v => v !== "checking" && !(v as PhotoCheckResult).clean).length > 0 &&
                ` ${Object.values(photoChecks).filter(v => v !== "checking" && !(v as PhotoCheckResult).clean).length} flagged photos.`}
            </div>

            {photosLoading && (
              <div className="flex items-center gap-3 py-12 justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                Fetching photos from Zillow listing pages…
              </div>
            )}

            {!photosLoading && (
              <>
                {(unit1Photos.length > 0 || unit2Photos.length > 0) ? (
                  <>
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-sm text-muted-foreground">
                        {unit1Photos.length + unit2Photos.length} photos fetched. Run a platform check to verify they don't appear on Airbnb/VRBO/Booking.com.
                      </p>
                      <Button variant="outline" size="sm" onClick={handleCheckAllPhotos} data-testid="button-check-all-photos">
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
                      { label: `Unit 1 — ${selectedUnit1?.bedrooms ?? "?"}BR`, photos: unit1Photos },
                      { label: `Unit 2 — ${selectedUnit2?.bedrooms ?? "?"}BR`, photos: unit2Photos },
                    ].map(({ label, photos }) => (
                      <div key={label} className="mb-6">
                        <h3 className="font-medium text-sm mb-3">{label}</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          {photos.map((p, i) => {
                            const checkResult = photoChecks[p.url];
                            const isChecking = checkResult === "checking";
                            const isFlagged = checkResult && checkResult !== "checking" && !(checkResult as PhotoCheckResult).clean;
                            return (
                              <div key={i} className={`relative rounded-lg overflow-hidden border-2 transition-colors ${isFlagged ? "border-red-400" : "border-transparent"}`} data-testid={`photo-${label.replace(/\s/g,"-")}-${i}`}>
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
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="text-center py-10 text-muted-foreground">
                    <Camera className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p>Photos could not be fetched from Zillow automatically.</p>
                    <p className="text-sm mt-1">You can proceed to generate the listing draft anyway.</p>
                  </div>
                )}

                <Button onClick={handleGenerateListing} data-testid="button-generate-listing" id="btn-next-step" aria-label="Generate listing draft and proceed to Step 5">
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
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-5-heading">Step 5: Listing Draft</h2>
              </div>
              <Button variant="outline" size="sm" onClick={() => setStep(4)} data-testid="button-back-step4" id="btn-prev-step" aria-label="Go back to Step 4: Photos and Platform Check">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
            </div>

            <div id="summary-panel" className="mb-4 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
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
                        <span className="text-muted-foreground font-normal ml-2 text-xs">— complex-level (e.g. "1661 Pe'e Rd"); preflight appends Unit A / Unit B</span>
                      </label>
                      <Input
                        id="input-street-address"
                        value={editedStreetAddress}
                        onChange={e => setEditedStreetAddress(e.target.value)}
                        placeholder={selectedCommunity ? `${selectedCommunity.city}, ${selectedCommunity.state}` : "Street, e.g. 1661 Pe'e Rd"}
                        data-testid="input-street-address"
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Optional. Leave blank and the dashboard / preflight fall back to "{selectedCommunity?.city}, {selectedCommunity?.state}".
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
                    { key: "A", state: editedUnitA, setState: setEditedUnitA, brFallback: selectedUnit1?.bedrooms ?? 0 },
                    { key: "B", state: editedUnitB, setState: setEditedUnitB, brFallback: selectedUnit2?.bedrooms ?? 0 },
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

                  {/* ── STR Permit ────────────────────────────── */}
                  <Card className="p-4">
                    <label htmlFor="input-str-permit" className="text-sm font-medium mb-1.5 block">
                      STR Permit Number
                      <span className="text-muted-foreground font-normal ml-2">— Obtain from county once property is secured</span>
                    </label>
                    <Input
                      id="input-str-permit"
                      value={strPermit}
                      onChange={e => setStrPermit(e.target.value)}
                      placeholder={listing.strPermitSample ?? "e.g. TVR-2024-012 or TVNC-0342"}
                      className="font-mono"
                      data-testid="input-str-permit"
                    />
                    <div className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground mb-1">Format by county:</p>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
                        <span><span className="font-mono font-semibold">TVR-YYYY-##</span> — Kauai, VDA zone (Poipu, Princeville)</span>
                        <span><span className="font-mono font-semibold">TVNC-####</span> — Kauai, non-VDA/residential (Kekaha, Kapaa)</span>
                        <span><span className="font-mono font-semibold">STVR-YYYY-######</span> — Hawaii County (Big Island)</span>
                        <span><span className="font-mono font-semibold">STRH-########</span> — Maui County</span>
                        <span><span className="font-mono font-semibold">NUC-##-###-####</span> — Honolulu (Oahu)</span>
                      </div>
                    </div>
                  </Card>
                </div>

                <div className="flex items-center gap-3">
                  <Button onClick={handleSave} disabled={saving} data-testid="button-save-community" id="btn-next-step" aria-label="Save community to dashboard">
                    {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                    {saving ? "Saving…" : "Save to Dashboard"}
                  </Button>
                  <Button variant="outline" onClick={handleGenerateListing} disabled={listingLoading} data-testid="button-regenerate" id="button-regenerate-listing" aria-label="Regenerate listing with AI">
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
