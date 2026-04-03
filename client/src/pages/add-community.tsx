import { useState, useCallback } from "react";
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
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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
};

type UnitResult = {
  url: string;
  title: string;
  bedrooms: number | null;
  price: number | null;
  source: string;
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

  // Step 2
  const [communities, setCommunities] = useState<CommunityResult[]>([]);
  const [researchLoading, setResearchLoading] = useState(false);
  const [selectedCommunity, setSelectedCommunity] = useState<CommunityResult | null>(null);

  // Step 3
  const [unitSearchResults, setUnitSearchResults] = useState<{ units: UnitResult[]; grouped: Record<string, UnitResult[]> } | null>(null);
  const [unitSearchLoading, setUnitSearchLoading] = useState(false);
  const [selectedUnit1, setSelectedUnit1] = useState<UnitResult | null>(null);
  const [selectedUnit2, setSelectedUnit2] = useState<UnitResult | null>(null);

  // Step 4
  const [unit1Photos, setUnit1Photos] = useState<PhotoItem[]>([]);
  const [unit2Photos, setUnit2Photos] = useState<PhotoItem[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photoChecks, setPhotoChecks] = useState<Record<string, PhotoCheckResult | "checking">>({});

  // Step 5
  const [listing, setListing] = useState<{ title: string; description: string; combinedBedrooms: number; suggestedRate: number } | null>(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [editedTitle, setEditedTitle] = useState("");
  const [editedDescription, setEditedDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const combinedBedrooms = (selectedUnit1?.bedrooms ?? 0) + (selectedUnit2?.bedrooms ?? 0);
  const baseRate = (selectedUnit1?.price ?? 0) + (selectedUnit2?.price ?? 0);
  const suggestedRate = baseRate > 0 ? Math.round(baseRate * 1.25) : 0;

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

  // ── Step 3: Unit search ─────────────────────────────────────
  const handleSelectCommunity = useCallback(async (community: CommunityResult) => {
    setSelectedCommunity(community);
    setUnitSearchLoading(true);
    setUnitSearchResults(null);
    setSelectedUnit1(null);
    setSelectedUnit2(null);
    setStep(3);
    try {
      const res = await apiRequest("POST", "/api/community/search-units", {
        communityName: community.name,
        city: community.city,
        state: community.state,
      });
      const data = await res.json();
      setUnitSearchResults(data);
    } catch (e: any) {
      toast({ title: "Unit search failed", description: e.message, variant: "destructive" });
    } finally {
      setUnitSearchLoading(false);
    }
  }, [toast]);

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

    try {
      const [r1, r2] = await Promise.all([
        apiRequest("POST", "/api/community/fetch-unit-photos", { url: selectedUnit1.url }),
        apiRequest("POST", "/api/community/fetch-unit-photos", { url: selectedUnit2.url }),
      ]);
      const d1 = await r1.json();
      const d2 = await r2.json();
      setUnit1Photos((d1.photos || []).slice(0, 8));
      setUnit2Photos((d2.photos || []).slice(0, 8));
    } catch (e: any) {
      toast({ title: "Photo fetch failed", description: e.message, variant: "destructive" });
    } finally {
      setPhotosLoading(false);
    }
  }, [selectedUnit1, selectedUnit2, toast]);

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
        unit1: { bedrooms: selectedUnit1.bedrooms ?? 2, url: selectedUnit1.url },
        unit2: { bedrooms: selectedUnit2.bedrooms ?? 2, url: selectedUnit2.url },
        suggestedRate,
      });
      const data = await res.json();
      setListing(data);
      setEditedTitle(data.title || "");
      setEditedDescription(data.description || "");
    } catch (e: any) {
      toast({ title: "Listing generation failed", description: e.message, variant: "destructive" });
    } finally {
      setListingLoading(false);
    }
  }, [selectedCommunity, selectedUnit1, selectedUnit2, suggestedRate, toast]);

  // ── Save to dashboard ───────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!selectedCommunity) return;
    setSaving(true);
    try {
      await apiRequest("POST", "/api/community/save", {
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
        unit2Url: selectedUnit2?.url ?? null,
        unit2Bedrooms: selectedUnit2?.bedrooms ?? null,
        combinedBedrooms: combinedBedrooms || null,
        suggestedRate: suggestedRate || null,
        listingTitle: editedTitle || null,
        listingDescription: editedDescription || null,
        status: "draft_ready",
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
      toast({ title: "Community saved to dashboard!" });
      navigate("/");
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [selectedCommunity, selectedUnit1, selectedUnit2, combinedBedrooms, suggestedRate, editedTitle, editedDescription, toast, navigate, queryClient]);

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
                <Input
                  id="input-city"
                  placeholder="e.g. Kissimmee, Myrtle Beach…"
                  value={cityInput}
                  onChange={e => setCityInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleResearch()}
                  data-testid="input-city"
                  aria-label="Enter city name"
                />
              </div>
            </div>
            <div id="summary-panel" className="mb-4 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
              <strong>Current selection:</strong> {selectedState || "No state selected"} — {cityInput || "No city entered"}
            </div>
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
            {researchLoading && (
              <p className="text-sm text-muted-foreground mt-3" id="status-message">
                Searching for communities and scoring with AI — this takes 20–40 seconds…
              </p>
            )}
          </Card>
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
              {communities.map((c, i) => (
                <Card
                  key={i}
                  className="p-4 cursor-pointer hover:border-primary transition-colors"
                  onClick={() => handleSelectCommunity(c)}
                  data-testid={`card-community-${i}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-base" data-testid={`text-community-name-${i}`}>{c.name}</h3>
                        <Badge variant={c.confidenceScore >= 75 ? "default" : c.confidenceScore >= 50 ? "secondary" : "outline"}>
                          <Star className="h-3 w-3 mr-1" />
                          {c.confidenceScore}/100
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mb-2">
                        <MapPin className="h-3.5 w-3.5 inline mr-1" />{c.city}, {c.state} · {c.unitTypes}
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
              ))}
            </div>
          </div>
        )}

        {/* ── STEP 3: Unit pair selection ───────────────────── */}
        {step === 3 && (
          <div id="step-3-content">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BedDouble className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold" id="step-3-heading">Step 3: Select Unit Pair</h2>
              </div>
              <Button variant="outline" size="sm" onClick={() => setStep(2)} data-testid="button-back-step2" id="btn-prev-step" aria-label="Go back to Step 2: Community Research">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
            </div>
            <div id="summary-panel" className="mb-4 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
              <strong>Community:</strong> {selectedCommunity?.name || "None selected"} in {selectedCommunity ? `${selectedCommunity.city}, ${selectedCommunity.state}` : "—"}.{" "}
              <strong>Unit 1:</strong> {selectedUnit1?.title || "Not selected"}.{" "}
              <strong>Unit 2:</strong> {selectedUnit2?.title || "Not selected"}.
            </div>

            {selectedCommunity && (
              <div className="flex items-center gap-2 mb-4 p-3 rounded-lg bg-muted/50">
                <Building2 className="h-4 w-4 text-primary shrink-0" />
                <span className="font-medium">{selectedCommunity.name}</span>
                <span className="text-muted-foreground text-sm">— {selectedCommunity.city}, {selectedCommunity.state}</span>
              </div>
            )}

            {unitSearchLoading && (
              <div className="flex items-center gap-3 py-12 justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                Searching Zillow and Homes.com for available units…
              </div>
            )}

            {!unitSearchLoading && unitSearchResults && (
              <>
                {unitSearchResults.units.length === 0 ? (
                  <div className="text-center py-10 text-muted-foreground">
                    <Building2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p>No units found automatically.</p>
                    <p className="text-sm mt-1">Enter the Zillow URLs manually below.</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground mb-4">
                    Found {unitSearchResults.units.length} unit listings. Select one as Unit 1 and one as Unit 2 to combine.
                  </p>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                  {/* Unit 1 selection */}
                  <div>
                    <h3 className="font-medium text-sm mb-2 flex items-center gap-1">
                      <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center">1</span>
                      Unit 1 {selectedUnit1 && <CheckCircle2 className="h-4 w-4 text-green-600 ml-1" />}
                    </h3>
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {unitSearchResults.units.map((u, i) => (
                        <div
                          key={i}
                          onClick={() => selectedUnit1?.url === u.url ? setSelectedUnit1(null) : setSelectedUnit1(u)}
                          className={`p-3 rounded-lg border cursor-pointer text-sm transition-colors ${
                            selectedUnit1?.url === u.url ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                          } ${selectedUnit2?.url === u.url ? "opacity-40 pointer-events-none" : ""}`}
                          data-testid={`card-unit1-${i}`}
                        >
                          <div className="font-medium truncate">{u.title}</div>
                          <div className="text-muted-foreground flex items-center gap-3 mt-0.5">
                            {u.bedrooms && <span><BedDouble className="h-3 w-3 inline mr-0.5" />{u.bedrooms}BR</span>}
                            {u.price && <span><DollarSign className="h-3 w-3 inline" />${u.price.toLocaleString()}/mo</span>}
                            <span className="text-xs">{u.source}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Unit 2 selection */}
                  <div>
                    <h3 className="font-medium text-sm mb-2 flex items-center gap-1">
                      <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center">2</span>
                      Unit 2 {selectedUnit2 && <CheckCircle2 className="h-4 w-4 text-green-600 ml-1" />}
                    </h3>
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {unitSearchResults.units.map((u, i) => (
                        <div
                          key={i}
                          onClick={() => selectedUnit2?.url === u.url ? setSelectedUnit2(null) : setSelectedUnit2(u)}
                          className={`p-3 rounded-lg border cursor-pointer text-sm transition-colors ${
                            selectedUnit2?.url === u.url ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                          } ${selectedUnit1?.url === u.url ? "opacity-40 pointer-events-none" : ""}`}
                          data-testid={`card-unit2-${i}`}
                        >
                          <div className="font-medium truncate">{u.title}</div>
                          <div className="text-muted-foreground flex items-center gap-3 mt-0.5">
                            {u.bedrooms && <span><BedDouble className="h-3 w-3 inline mr-0.5" />{u.bedrooms}BR</span>}
                            {u.price && <span><DollarSign className="h-3 w-3 inline" />${u.price.toLocaleString()}/mo</span>}
                            <span className="text-xs">{u.source}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Manual URL fallback */}
                {unitSearchResults.units.length === 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="text-sm font-medium mb-1.5 block">Unit 1 — Zillow/Homes.com URL</label>
                      <Input
                        placeholder="https://www.zillow.com/homedetails/…"
                        onChange={e => setSelectedUnit1(e.target.value ? { url: e.target.value, title: "Unit 1", bedrooms: null, price: null, source: "Manual" } : null)}
                        data-testid="input-unit1-url"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1.5 block">Unit 2 — Zillow/Homes.com URL</label>
                      <Input
                        placeholder="https://www.zillow.com/homedetails/…"
                        onChange={e => setSelectedUnit2(e.target.value ? { url: e.target.value, title: "Unit 2", bedrooms: null, price: null, source: "Manual" } : null)}
                        data-testid="input-unit2-url"
                      />
                    </div>
                  </div>
                )}

                {/* Combined summary */}
                {selectedUnit1 && selectedUnit2 && (
                  <div className="flex items-center gap-4 p-4 rounded-lg bg-primary/5 border border-primary/20 mb-4">
                    <div className="flex items-center gap-2">
                      <BedDouble className="h-5 w-5 text-primary" />
                      <span className="font-semibold text-lg">{combinedBedrooms}BR</span>
                      <span className="text-muted-foreground text-sm">combined listing</span>
                    </div>
                    {suggestedRate > 0 && (
                      <div className="flex items-center gap-1">
                        <DollarSign className="h-5 w-5 text-green-600" />
                        <span className="font-semibold text-lg text-green-600">${suggestedRate}</span>
                        <span className="text-muted-foreground text-sm">/night (25% markup)</span>
                      </div>
                    )}
                  </div>
                )}

                <Button
                  onClick={handleConfirmUnits}
                  disabled={!selectedUnit1 || !selectedUnit2}
                  data-testid="button-confirm-units"
                  id="btn-next-step"
                  aria-label="Confirm selected unit pair and proceed to photos"
                >
                  Confirm Unit Pair & Fetch Photos <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </>
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
                    <p className="text-xs text-muted-foreground mb-1">Markup</p>
                    <p className="text-2xl font-bold">25%</p>
                  </Card>
                </div>

                <div className="space-y-4 mb-6">
                  <div>
                    <label htmlFor="input-listing-title" className="text-sm font-medium mb-1.5 block">
                      Headline <span className="text-muted-foreground font-normal">({editedTitle.length}/80 chars)</span>
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
                    <label htmlFor="textarea-listing-description" className="text-sm font-medium mb-1.5 block">Description</label>
                    <Textarea
                      id="textarea-listing-description"
                      value={editedDescription}
                      onChange={e => setEditedDescription(e.target.value)}
                      rows={16}
                      className="font-mono text-xs leading-relaxed resize-y"
                      data-testid="textarea-listing-description"
                      aria-label="Listing description"
                    />
                  </div>
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
