import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Upload,
  AlertCircle,
  Download,
  Sparkles,
  Home,
  Image,
  Wifi,
  Utensils,
  Car,
  Waves,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  getUnitBuilderByPropertyId,
  LISTING_DISCLOSURE,
} from "@/data/unit-builder-data";
import type { PropertyUnitBuilder } from "@/data/unit-builder-data";
import {
  LODGIFY_AMENITY_CATEGORIES,
  getDefaultAmenities,
} from "@/data/lodgify-amenities";
import {
  getPropertyPricing,
  type PropertyPricing,
} from "@/data/pricing-data";

// ─── Step names ────────────────────────────────────────────────
const STEP_NAMES = [
  "Rental Name",
  "Location",
  "Photos",
  "Basics",
  "Amenities",
  "Price",
  "Description",
  "Reservation Type",
  "Push Rates to Lodgify",
];
const TOTAL_STEPS = STEP_NAMES.length;

// ─── Persisted wizard state ────────────────────────────────────
type BuilderState = {
  rentalName: string;
  internalName: string;
  country: string;
  streetAddress: string;
  city: string;
  zip: string;
  guests: number;
  bedrooms: number;
  bathrooms: number;
  selectedAmenities: string[];
  nightlyPrice: number;
  currency: string;
  description: string;
  reservationType: "instant" | "request";
  lodgifyPropertyId: string;
};

function stateKey(propertyId: number) {
  return `builder-state-${propertyId}`;
}

function loadState(propertyId: number, property: PropertyUnitBuilder | undefined): BuilderState {
  try {
    const saved = localStorage.getItem(stateKey(propertyId));
    if (saved) return JSON.parse(saved) as BuilderState;
  } catch {}
  const totalBedrooms = property?.units.reduce((s, u) => s + u.bedrooms, 0) ?? 0;
  const totalGuests = property?.units.reduce((s, u) => s + u.maxGuests, 0) ?? 0;
  return {
    rentalName: property?.bookingTitle ?? "",
    internalName: property?.propertyName ?? "",
    country: "United States",
    streetAddress: property?.address ?? "",
    city: "",
    zip: "",
    guests: totalGuests,
    bedrooms: totalBedrooms,
    bathrooms: 2,
    selectedAmenities: getDefaultAmenities(propertyId),
    nightlyPrice: 125,
    currency: "USD",
    description: property ? `${LISTING_DISCLOSURE}\n\n${property.combinedDescription}` : "",
    reservationType: "instant",
    lodgifyPropertyId: "",
  };
}

function saveState(propertyId: number, state: BuilderState) {
  try {
    localStorage.setItem(stateKey(propertyId), JSON.stringify(state));
  } catch {}
}

// ─── Stepper header ────────────────────────────────────────────
function StepHeader({ propertyId, stepNum, propertyName }: { propertyId: number; stepNum: number; propertyName: string }) {
  return (
    <div className="mb-6">
      <Link href="/">
        <Button variant="ghost" size="sm" id="link-back-to-dashboard" aria-label="Back to dashboard">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to Dashboard
        </Button>
      </Link>
      <div
        className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"
        id="step-indicator"
        aria-label={`Step ${stepNum} of ${TOTAL_STEPS} — ${STEP_NAMES[stepNum - 1]}`}
      >
        <span className="font-medium text-foreground">Step {stepNum} of {TOTAL_STEPS}</span>
        <span>—</span>
        <span>{STEP_NAMES[stepNum - 1]}</span>
        <span className="ml-auto text-xs">{propertyName}</span>
      </div>
      {/* Progress bar */}
      <div className="mt-2 h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-300"
          style={{ width: `${(stepNum / TOTAL_STEPS) * 100}%` }}
        />
      </div>
    </div>
  );
}

// ─── Nav buttons ────────────────────────────────────────────────
function NavButtons({
  propertyId,
  stepNum,
  canNext = true,
  onNext,
  nextLabel = "Next →",
  showDone = false,
}: {
  propertyId: number;
  stepNum: number;
  canNext?: boolean;
  onNext?: () => void;
  nextLabel?: string;
  showDone?: boolean;
}) {
  const [, navigate] = useLocation();
  const prev = () => navigate(`/builder/${propertyId}/step-${stepNum - 1}`);
  const next = () => {
    onNext?.();
    navigate(`/builder/${propertyId}/step-${stepNum + 1}`);
  };

  return (
    <div className="flex items-center gap-3 mt-8 pt-6 border-t">
      {stepNum > 1 && (
        <Button variant="outline" onClick={prev} id="btn-prev-step" aria-label={`Go back to Step ${stepNum - 1}: ${STEP_NAMES[stepNum - 2]}`}>
          ← Back
        </Button>
      )}
      {!showDone && stepNum < TOTAL_STEPS && (
        <Button onClick={next} disabled={!canNext} id="btn-next-step" aria-label={`Continue to Step ${stepNum + 1}: ${STEP_NAMES[stepNum]}`}>
          {nextLabel} <ArrowRight className="h-4 w-4 ml-1" />
        </Button>
      )}
      {showDone && (
        <Link href="/">
          <Button id="btn-done" aria-label="Finish and return to dashboard">
            Done — Back to Dashboard
          </Button>
        </Link>
      )}
    </div>
  );
}

// ─── Summary panel ─────────────────────────────────────────────
function SummaryPanel({ state }: { state: BuilderState }) {
  return (
    <div id="summary-panel" className="mt-6 p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground leading-relaxed">
      <span className="font-semibold">Summary so far: </span>
      {state.rentalName && <span>Name: "{state.rentalName}". </span>}
      {state.streetAddress && <span>Address: {state.streetAddress}, {state.city} {state.zip}, {state.country}. </span>}
      {state.bedrooms > 0 && <span>Bedrooms: {state.bedrooms}. Guests: {state.guests}. </span>}
      {state.nightlyPrice > 0 && <span>Rate: ${state.nightlyPrice}/night ({state.currency}). </span>}
      {state.reservationType && <span>Booking: {state.reservationType === "instant" ? "Instant booking" : "Booking request"}. </span>}
      {state.lodgifyPropertyId && <span>Lodgify ID: #{state.lodgifyPropertyId}. </span>}
    </div>
  );
}

// ─── Stepper ────────────────────────────────────────────────────
function Stepper({ checked }: { checked: boolean[] }) {
  return (
    <div className="hidden md:flex items-center gap-1 mb-4 overflow-x-auto pb-1">
      {STEP_NAMES.map((name, i) => {
        const done = checked[i];
        return (
          <div key={name} className="flex items-center gap-1 shrink-0">
            <div className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${done ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
              {done ? <CheckCircle2 className="h-3 w-3" /> : <span>{i + 1}</span>}
              {name}
            </div>
            {i < STEP_NAMES.length - 1 && <span className="text-muted-foreground text-xs">›</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── STEP 1 — Rental Name ──────────────────────────────────────
function Step1({ state, onChange }: { state: BuilderState; onChange: (s: Partial<BuilderState>) => void }) {
  return (
    <div id="step-1-content">
      <h2 className="text-xl font-bold mb-2" id="step-1-heading">What is the name of your rental?</h2>
      <p className="text-muted-foreground text-sm mb-6">This will be the public name guests see when booking.</p>

      <div className="space-y-4 max-w-xl">
        <div>
          <label htmlFor="input-rental-name" className="text-sm font-medium mb-1.5 block">
            Listing title / public name <span className="text-muted-foreground font-normal">({state.rentalName.length}/60 chars)</span>
          </label>
          <Input
            id="input-rental-name"
            aria-label="Listing title or public name for guests"
            value={state.rentalName}
            onChange={e => onChange({ rentalName: e.target.value.slice(0, 60) })}
            placeholder="e.g. Poipu Kai 4BR Beach Retreat"
            maxLength={60}
          />
        </div>
        <div>
          <label htmlFor="input-internal-name" className="text-sm font-medium mb-1.5 block">
            Internal name <span className="text-muted-foreground font-normal">(optional, for your reference)</span>
          </label>
          <Input
            id="input-internal-name"
            aria-label="Internal name for your own reference"
            value={state.internalName}
            onChange={e => onChange({ internalName: e.target.value })}
            placeholder="e.g. PK-4BR-A"
          />
        </div>
      </div>
    </div>
  );
}

// ─── STEP 2 — Location ─────────────────────────────────────────
function Step2({ state, onChange }: { state: BuilderState; onChange: (s: Partial<BuilderState>) => void }) {
  return (
    <div id="step-2-content">
      <h2 className="text-xl font-bold mb-2" id="step-2-heading">Where is your rental located?</h2>
      <p className="text-muted-foreground text-sm mb-6">Enter the property's full address as it should appear in Lodgify.</p>

      <div className="space-y-4 max-w-xl">
        <div>
          <label htmlFor="select-country" className="text-sm font-medium mb-1.5 block">Country</label>
          <select
            id="select-country"
            aria-label="Select country"
            value={state.country}
            onChange={e => onChange({ country: e.target.value })}
            className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="United States">United States</option>
            <option value="Canada">Canada</option>
            <option value="Mexico">Mexico</option>
            <option value="United Kingdom">United Kingdom</option>
            <option value="Australia">Australia</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div>
          <label htmlFor="input-street-address" className="text-sm font-medium mb-1.5 block">Street address</label>
          <Input
            id="input-street-address"
            aria-label="Full street address"
            value={state.streetAddress}
            onChange={e => onChange({ streetAddress: e.target.value })}
            placeholder="e.g. 1941 Poipu Rd"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="input-city" className="text-sm font-medium mb-1.5 block">City</label>
            <Input
              id="input-city"
              aria-label="City"
              value={state.city}
              onChange={e => onChange({ city: e.target.value })}
              placeholder="e.g. Koloa"
            />
          </div>
          <div>
            <label htmlFor="input-zip" className="text-sm font-medium mb-1.5 block">Zip / Postal code</label>
            <Input
              id="input-zip"
              aria-label="Zip or postal code"
              value={state.zip}
              onChange={e => onChange({ zip: e.target.value })}
              placeholder="e.g. 96756"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── STEP 3 — Photos ───────────────────────────────────────────
function Step3({
  property,
  state,
}: {
  property: PropertyUnitBuilder;
  state: BuilderState;
}) {
  const [activeTab, setActiveTab] = useState<"community" | string>("community");
  const [makingOver, setMakingOver] = useState(false);
  const [makeoverProgress, setMakeoverProgress] = useState(0);
  const [makeoverTotal, setMakeoverTotal] = useState(0);
  const [makeoverDone, setMakeoverDone] = useState(false);
  const [makeoverError, setMakeoverError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const { toast } = useToast();

  const communityFolder = property.communityPhotoFolder;

  const { data: communityPhotoUrls } = useQuery<{ url: string; filename: string }[]>({
    queryKey: ["/api/photos/community", communityFolder],
    queryFn: async () => {
      const res = await fetch(`/api/photos/community/${encodeURIComponent(communityFolder)}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!communityFolder,
  });

  const { data: unitPhotos } = useQuery<Record<string, { url: string; filename: string }[]>>({
    queryKey: ["/api/photos/units", property.propertyId],
    queryFn: async () => {
      const result: Record<string, { url: string; filename: string }[]> = {};
      await Promise.all(
        property.units.map(async (unit) => {
          try {
            const res = await fetch(`/api/photos/unit/${encodeURIComponent(unit.photoFolder)}`);
            if (res.ok) result[unit.id] = await res.json();
          } catch {}
        })
      );
      return result;
    },
  });

  const startMakeover = useCallback(async () => {
    setMakingOver(true);
    setMakeoverProgress(0);
    setMakeoverTotal(0);
    setMakeoverDone(false);
    setMakeoverError(null);

    try {
      const beginningPhotos = property.communityPhotos
        .filter(p => p.position === "beginning")
        .map(p => p.filename);
      const endPhotos = property.communityPhotos
        .filter(p => p.position === "end")
        .map(p => p.filename);
      const resp = await fetch("/api/photos/ai-makeover/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folders: property.units.map(u => u.photoFolder),
          communityFolder: property.communityPhotoFolder,
          beginningPhotos,
          endPhotos,
          name: property.propertyName,
        }),
      });
      if (!resp.ok) throw new Error("Failed to start makeover");
      const data = await resp.json();
      const jId = data.jobId;
      setJobId(jId);

      const es = new EventSource(`/api/photos/ai-makeover/events/${jId}`);
      esRef.current = es;

      es.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "progress") {
            setMakeoverProgress(msg.processed ?? 0);
            setMakeoverTotal(msg.total ?? 0);
          } else if (msg.type === "done") {
            setMakeoverDone(true);
            setMakeoverProgress(msg.processedCount ?? 0);
            setMakeoverTotal(msg.totalCount ?? 0);
            es.close();
            const a = document.createElement("a");
            a.href = `/api/photos/ai-makeover/download/${jId}`;
            a.download = `${property.propertyName.replace(/[^a-zA-Z0-9_-]/g, "-")}-ai-makeover.zip`;
            a.click();
          } else if (msg.type === "error") {
            setMakeoverError(msg.message ?? "Unknown error");
            es.close();
          }
        } catch {}
      };
      es.onerror = () => {
        setMakeoverError("Connection lost during makeover.");
        es.close();
      };
    } catch (err: any) {
      setMakeoverError(err.message);
      setMakingOver(false);
    }
  }, [property]);

  const downloadZip = async () => {
    const a = document.createElement("a");
    a.href = `/api/photos/download-zip/${property.propertyId}`;
    a.download = `${property.propertyName.replace(/[^a-zA-Z0-9_-]/g, "-")}-photos.zip`;
    a.click();
  };

  const totalUnitPhotos = property.units.reduce((s, u) => s + (unitPhotos?.[u.id]?.length ?? u.photos.length), 0);

  return (
    <div id="step-3-content">
      <h2 className="text-xl font-bold mb-2" id="step-3-heading">What does your rental look like?</h2>
      <p className="text-muted-foreground text-sm mb-4">Review community and unit photos. Use Upscale All + ZIP to run Real-ESRGAN 2× upscaling on all interior photos, then download them as a ZIP ready to upload to Lodgify.</p>

      {/* Action buttons — visible immediately, no scroll required */}
      <div className="flex flex-wrap gap-3 mb-6 p-4 bg-muted/30 rounded-lg border">
        <Button
          id="btn-ai-makeover"
          aria-label="Run AI 2x upscaling on all photos and download ZIP"
          onClick={startMakeover}
          disabled={makingOver}
        >
          {makingOver ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
          Upscale All + ZIP
        </Button>
        <Button
          id="btn-download-zip"
          aria-label="Download all photos as ZIP without AI processing"
          variant="outline"
          onClick={downloadZip}
        >
          <Download className="h-4 w-4 mr-2" />
          Download All Photos (ZIP)
        </Button>
        <span className="text-xs text-muted-foreground self-center">
          {(communityPhotoUrls?.length ?? property.communityPhotos.length)} community + {totalUnitPhotos} unit photos
        </span>
      </div>

      {/* Makeover progress */}
      {makingOver && (
        <div className="mb-4 p-4 rounded-lg border bg-background">
          {makeoverError ? (
            <p className="text-sm text-red-600 flex items-center gap-2"><AlertCircle className="h-4 w-4" /> {makeoverError}</p>
          ) : makeoverDone ? (
            <p className="text-sm text-green-700 flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> {makeoverProgress} of {makeoverTotal} photos upscaled — ZIP downloading</p>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm mb-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Upscaling {makeoverTotal > 0 ? `${makeoverProgress} / ${makeoverTotal}` : "…"} photos
              </div>
              {makeoverTotal > 0 && (
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${(makeoverProgress / makeoverTotal) * 100}%` }} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex gap-1 mb-3 flex-wrap" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "community"}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${activeTab === "community" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
          onClick={() => setActiveTab("community")}
          id="tab-community-photos"
        >
          Community Photos ({communityPhotoUrls?.length ?? property.communityPhotos.length})
        </button>
        {property.units.map(unit => (
          <button
            key={unit.id}
            role="tab"
            aria-selected={activeTab === unit.id}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${activeTab === unit.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
            onClick={() => setActiveTab(unit.id)}
            id={`tab-unit-${unit.id}`}
          >
            Unit {unit.unitNumber} ({unitPhotos?.[unit.id]?.length ?? unit.photos.length} photos)
          </button>
        ))}
      </div>

      {/* Community photos */}
      {activeTab === "community" && (
        <div id="list-community-photos" className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {(communityPhotoUrls ?? property.communityPhotos.map(p => ({ url: `/api/photos/community/${communityFolder}/${p.filename}`, filename: p.filename }))).map((p, i) => (
            <div key={i} id={`item-community-photo-${i}`} className="relative aspect-square rounded overflow-hidden border bg-muted">
              <img src={p.url} alt={`Community photo ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
            </div>
          ))}
          {!communityPhotoUrls && property.communityPhotos.length === 0 && (
            <p className="col-span-full text-sm text-muted-foreground py-6 text-center">No community photos found.</p>
          )}
        </div>
      )}

      {/* Unit photos */}
      {property.units.map(unit => activeTab === unit.id && (
        <div key={unit.id} id={`list-unit-photos-${unit.id}`} className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {(unitPhotos?.[unit.id] ?? unit.photos.map(p => ({
            url: `/api/photos/unit/${unit.photoFolder}/${p.filename}`,
            filename: p.filename,
          }))).map((p, i) => (
            <div key={i} id={`item-unit-photo-${unit.id}-${i}`} className="relative aspect-square rounded overflow-hidden border bg-muted">
              <img src={p.url} alt={`Unit ${unit.unitNumber} photo ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
            </div>
          ))}
          {(unitPhotos?.[unit.id]?.length ?? unit.photos.length) === 0 && (
            <p className="col-span-full text-sm text-muted-foreground py-6 text-center">No photos found for this unit.</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── STEP 4 — Basics ───────────────────────────────────────────
function Step4({ state, onChange }: { state: BuilderState; onChange: (s: Partial<BuilderState>) => void }) {
  const stepper = (field: "guests" | "bedrooms" | "bathrooms", dir: 1 | -1) => {
    const min = field === "bathrooms" ? 1 : 1;
    const max = field === "guests" ? 50 : field === "bedrooms" ? 20 : 15;
    onChange({ [field]: Math.max(min, Math.min(max, state[field] + dir)) });
  };

  const StepperRow = ({ label, field, idBase }: { label: string; field: "guests" | "bedrooms" | "bathrooms"; idBase: string }) => (
    <div className="flex items-center justify-between py-3 border-b last:border-0">
      <label htmlFor={`input-${idBase}`} className="text-sm font-medium">{label}</label>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          id={`btn-${idBase}-minus`}
          aria-label={`Decrease ${label}`}
          onClick={() => stepper(field, -1)}
        >−</Button>
        <input
          id={`input-${idBase}`}
          aria-label={label}
          type="number"
          value={state[field]}
          onChange={e => onChange({ [field]: Math.max(1, parseInt(e.target.value) || 1) })}
          className="w-12 text-center text-sm font-semibold border border-input rounded h-8 bg-background"
          min={1}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          id={`btn-${idBase}-plus`}
          aria-label={`Increase ${label}`}
          onClick={() => stepper(field, 1)}
        >+</Button>
      </div>
    </div>
  );

  return (
    <div id="step-4-content">
      <h2 className="text-xl font-bold mb-2" id="step-4-heading">Share some basics about your place</h2>
      <p className="text-muted-foreground text-sm mb-6">Enter the combined capacity for your multi-unit rental.</p>

      <Card className="p-4 max-w-sm">
        <StepperRow label="Guests" field="guests" idBase="guests" />
        <StepperRow label="Bedrooms" field="bedrooms" idBase="bedrooms" />
        <StepperRow label="Bathrooms" field="bathrooms" idBase="bathrooms" />
      </Card>
    </div>
  );
}

// ─── STEP 5 — Amenities ────────────────────────────────────────
function Step5({ state, onChange }: { state: BuilderState; onChange: (s: Partial<BuilderState>) => void }) {
  const toggle = (item: string) => {
    const next = state.selectedAmenities.includes(item)
      ? state.selectedAmenities.filter(a => a !== item)
      : [...state.selectedAmenities, item];
    onChange({ selectedAmenities: next });
  };

  const amenityId = (name: string) => `amenity-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <div id="step-5-content">
      <h2 className="text-xl font-bold mb-2" id="step-5-heading">Tell guests what your place has to offer</h2>
      <p className="text-muted-foreground text-sm mb-6">
        {state.selectedAmenities.length} amenities selected. Check all that apply to your combined listing.
      </p>

      <div id="list-amenities" className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {LODGIFY_AMENITY_CATEGORIES.map(cat => (
          <div key={cat.name} id={`item-amenity-category-${cat.name.toLowerCase().replace(/\s+/g, "-")}`}>
            <h3 className="text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wide">{cat.name}</h3>
            <div className="space-y-1.5">
              {cat.items.map(item => {
                const checked = state.selectedAmenities.includes(item);
                const itemId = amenityId(item);
                return (
                  <label key={item} htmlFor={itemId} className="flex items-center gap-2.5 cursor-pointer text-sm hover:text-foreground">
                    <input
                      type="checkbox"
                      id={itemId}
                      aria-label={item}
                      checked={checked}
                      onChange={() => toggle(item)}
                      className="h-4 w-4 rounded border-gray-300 accent-primary cursor-pointer"
                    />
                    {item}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── STEP 6 — Price ────────────────────────────────────────────
function Step6({ state, onChange }: { state: BuilderState; onChange: (s: Partial<BuilderState>) => void }) {
  return (
    <div id="step-6-content">
      <h2 className="text-xl font-bold mb-2" id="step-6-heading">What is the price per night?</h2>
      <p className="text-muted-foreground text-sm mb-6">Set a base nightly price. You can add seasonal rates in Lodgify after setup.</p>

      <div className="space-y-4 max-w-sm">
        <div>
          <label htmlFor="input-nightly-price" className="text-sm font-medium mb-1.5 block">Nightly price (USD)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <Input
              id="input-nightly-price"
              aria-label="Nightly price in USD"
              type="number"
              min={1}
              value={state.nightlyPrice}
              onChange={e => onChange({ nightlyPrice: parseInt(e.target.value) || 125 })}
              className="pl-7"
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">Default: $125/night. Seasonal rates are pushed in Step 9.</p>
        </div>
        <div>
          <label htmlFor="select-currency" className="text-sm font-medium mb-1.5 block">Currency</label>
          <select
            id="select-currency"
            aria-label="Select currency"
            value={state.currency}
            onChange={e => onChange({ currency: e.target.value })}
            className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="USD">USD — US Dollar</option>
            <option value="EUR">EUR — Euro</option>
            <option value="GBP">GBP — British Pound</option>
            <option value="CAD">CAD — Canadian Dollar</option>
            <option value="AUD">AUD — Australian Dollar</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ─── STEP 7 — Description ──────────────────────────────────────
function Step7({ state, onChange, property }: { state: BuilderState; onChange: (s: Partial<BuilderState>) => void; property: PropertyUnitBuilder }) {
  const [generating, setGenerating] = useState(false);
  const { toast } = useToast();

  const generateDescription = () => {
    setGenerating(true);
    setTimeout(() => {
      onChange({ description: `${LISTING_DISCLOSURE}\n\n${property.combinedDescription}` });
      setGenerating(false);
      toast({ title: "Description generated", description: "Pre-filled from your property data." });
    }, 600);
  };

  return (
    <div id="step-7-content">
      <h2 className="text-xl font-bold mb-2" id="step-7-heading">How would you describe your place?</h2>
      <p className="text-muted-foreground text-sm mb-4">Write a description for guests. Include the legal disclosure for multi-unit listings.</p>

      <div className="flex gap-2 mb-3">
        <Button
          id="btn-generate-description"
          aria-label="Auto-fill description from property data"
          variant="outline"
          size="sm"
          onClick={generateDescription}
          disabled={generating}
        >
          {generating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
          Generate description
        </Button>
        <span className="text-xs text-muted-foreground self-center">{state.description.length} characters</span>
      </div>

      <Textarea
        id="input-description"
        aria-label="Property description for guests"
        value={state.description}
        onChange={e => onChange({ description: e.target.value })}
        rows={18}
        className="font-mono text-xs leading-relaxed resize-y w-full"
        placeholder="Describe your rental for guests. Be sure to include the two-unit disclosure language…"
      />
    </div>
  );
}

// ─── STEP 8 — Reservation Type ─────────────────────────────────
function Step8({ state, onChange }: { state: BuilderState; onChange: (s: Partial<BuilderState>) => void }) {
  return (
    <div id="step-8-content">
      <h2 className="text-xl font-bold mb-2" id="step-8-heading">How would you like to accept reservations?</h2>
      <p className="text-muted-foreground text-sm mb-6">Choose how guests book your property.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
        <label
          htmlFor="radio-instant-booking"
          className={`flex flex-col gap-2 p-5 rounded-lg border-2 cursor-pointer transition-colors ${state.reservationType === "instant" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
        >
          <div className="flex items-center gap-2">
            <input
              type="radio"
              id="radio-instant-booking"
              name="reservation-type"
              aria-label="Instant booking — guests book immediately without approval"
              value="instant"
              checked={state.reservationType === "instant"}
              onChange={() => onChange({ reservationType: "instant" })}
              className="accent-primary"
            />
            <span className="font-semibold text-sm">Instant booking</span>
            {state.reservationType === "instant" && <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />}
          </div>
          <p className="text-xs text-muted-foreground pl-5">Guests book immediately. No approval needed — maximizes bookings.</p>
        </label>

        <label
          htmlFor="radio-booking-request"
          className={`flex flex-col gap-2 p-5 rounded-lg border-2 cursor-pointer transition-colors ${state.reservationType === "request" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
        >
          <div className="flex items-center gap-2">
            <input
              type="radio"
              id="radio-booking-request"
              name="reservation-type"
              aria-label="Booking request — you approve each reservation before confirming"
              value="request"
              checked={state.reservationType === "request"}
              onChange={() => onChange({ reservationType: "request" })}
              className="accent-primary"
            />
            <span className="font-semibold text-sm">Booking request</span>
            {state.reservationType === "request" && <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />}
          </div>
          <p className="text-xs text-muted-foreground pl-5">You approve each reservation. More control over who stays.</p>
        </label>
      </div>
    </div>
  );
}

// ─── STEP 9 — Push Rates ───────────────────────────────────────
function Step9({
  state,
  onChange,
  propertyId,
  pricing,
}: {
  state: BuilderState;
  onChange: (s: Partial<BuilderState>) => void;
  propertyId: number;
  pricing: PropertyPricing | null;
}) {
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const { toast } = useToast();

  const combinedRates = pricing
    ? (pricing.units[0]?.monthlyRates.map((rate, idx) => ({
        month: rate.month,
        year: rate.year,
        sellRate: pricing.units.reduce((sum, u) => sum + u.monthlyRates[idx].sellRate, 0),
        season: rate.season,
        minStay: 5,
      })) ?? [])
    : [];

  const minRate = combinedRates.length > 0 ? Math.min(...combinedRates.map(r => r.sellRate)) : 0;
  const maxRate = combinedRates.length > 0 ? Math.max(...combinedRates.map(r => r.sellRate)) : 0;

  const saveLodgifyId = async (id: string) => {
    if (!id.trim()) return;
    try {
      await apiRequest("PUT", `/api/lodgify/property-map/${propertyId}`, { lodgifyPropertyId: id.trim() });
      queryClient.invalidateQueries({ queryKey: ["/api/lodgify/property-map"] });
    } catch {}
  };

  const handlePush = async () => {
    const id = state.lodgifyPropertyId.trim();
    if (!id) {
      toast({ title: "Enter a Lodgify Property ID first", variant: "destructive" });
      return;
    }
    setPushing(true);
    setResult(null);
    await saveLodgifyId(id);
    try {
      const response = await apiRequest("POST", "/api/lodgify/push-rates", {
        lodgifyPropertyId: id,
        rates: combinedRates,
      });
      const data = await response.json();
      if (data.success) {
        const roomSummary = data.results?.map((r: any) => `"${r.roomTypeName}" (${r.rateEntriesSubmitted} months)`).join(", ") || "";
        setResult({ success: true, message: `Rates pushed to Lodgify property ${id}. ${data.roomTypesProcessed} room type(s) updated: ${roomSummary}.` });
      } else {
        const hasExternalRatesError = data.results?.some((r: any) => r.error?.code === 940 || r.httpStatus === 406);
        if (hasExternalRatesError) {
          setResult({ success: false, message: `"External Rates" is not enabled on this Lodgify property. Go to Lodgify > Settings > External Rates and enable it, then try again.` });
        } else {
          setResult({ success: false, message: data.error || "Some room types failed to update." });
        }
      }
    } catch (err: any) {
      let msg = "Failed to push rates";
      try { msg = JSON.parse(err.message)?.error || err.message || msg; } catch { msg = err.message || msg; }
      setResult({ success: false, message: msg });
    } finally {
      setPushing(false);
    }
  };

  return (
    <div id="step-9-content">
      <h2 className="text-xl font-bold mb-2" id="step-9-heading">Push your rates to Lodgify</h2>
      <p className="text-muted-foreground text-sm mb-6">
        Your rental has been created in Lodgify. Find your new Lodgify Property ID in your Lodgify dashboard under Rentals, then enter it below to push your rates.
      </p>

      {/* Rate summary */}
      {pricing && combinedRates.length > 0 && (
        <Card className="p-4 mb-6 max-w-lg">
          <h3 className="text-sm font-semibold mb-3">Rates being pushed</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Rate range</p>
              <p className="font-semibold">${minRate} – ${maxRate}/night</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Months covered</p>
              <p className="font-semibold">{combinedRates.length} months</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Min stay (all seasons)</p>
              <p className="font-semibold">5 nights</p>
            </div>
          </div>
          <div className="mt-3 max-h-40 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left py-0.5">Month</th>
                  <th className="text-left py-0.5">Season</th>
                  <th className="text-right py-0.5">$/night</th>
                </tr>
              </thead>
              <tbody>
                {combinedRates.slice(0, 12).map((r, i) => (
                  <tr key={i} className="border-t border-border/30">
                    <td className="py-0.5">{r.month} {r.year}</td>
                    <td className="py-0.5">{r.season}</td>
                    <td className="text-right py-0.5">${r.sellRate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Lodgify ID input + push */}
      <div className="max-w-lg space-y-4">
        <div>
          <label htmlFor="input-lodgify-property-id" className="text-sm font-medium mb-1.5 block">
            Lodgify Property ID
          </label>
          <Input
            id="input-lodgify-property-id"
            aria-label="Lodgify property ID number"
            placeholder="e.g. 766525"
            value={state.lodgifyPropertyId}
            onChange={e => onChange({ lodgifyPropertyId: e.target.value })}
          />
          <p className="text-xs text-muted-foreground mt-1">Find this in your Lodgify dashboard under Rentals → select your property → the ID appears in the URL.</p>
        </div>

        <Button
          id="btn-push-rates"
          aria-label="Push seasonal rates to Lodgify"
          onClick={handlePush}
          disabled={!state.lodgifyPropertyId.trim() || pushing || combinedRates.length === 0}
          size="lg"
          className="w-full sm:w-auto"
        >
          {pushing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
          {pushing ? "Pushing rates…" : "Push Rates to Lodgify"}
        </Button>

        {result && (
          <div
            id="status-message"
            className={`flex items-start gap-2 p-4 rounded-lg text-sm ${result.success ? "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800" : "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800"}`}
          >
            {result.success ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" /> : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />}
            <span>{result.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main builder component ─────────────────────────────────────
export default function Builder() {
  const params = useParams<{ propertyId: string; step: string }>();
  const [, navigate] = useLocation();

  const propertyId = parseInt(params.propertyId || "0", 10);
  const stepNum = parseInt((params.step || "step-1").replace("step-", ""), 10) || 1;

  const property = getUnitBuilderByPropertyId(propertyId);
  const pricing = getPropertyPricing(propertyId);

  const [wizardState, setWizardState] = useState<BuilderState>(() => loadState(propertyId, property));

  const updateState = useCallback((partial: Partial<BuilderState>) => {
    setWizardState(prev => {
      const next = { ...prev, ...partial };
      saveState(propertyId, next);
      return next;
    });
  }, [propertyId]);

  // Redirect step out of range
  useEffect(() => {
    if (stepNum < 1) navigate(`/builder/${propertyId}/step-1`, { replace: true });
    if (stepNum > TOTAL_STEPS) navigate(`/builder/${propertyId}/step-${TOTAL_STEPS}`, { replace: true });
  }, [stepNum, propertyId, navigate]);

  if (!property) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto px-4 py-8">
          <Link href="/"><Button variant="ghost" id="link-back-to-dashboard"><ArrowLeft className="h-4 w-4 mr-1" /> Back to Dashboard</Button></Link>
          <div className="mt-12 text-center">
            <h1 className="text-xl font-bold">Property not found</h1>
            <p className="text-muted-foreground mt-2">No builder data exists for property #{propertyId}.</p>
          </div>
        </div>
      </div>
    );
  }

  const checkedSteps = STEP_NAMES.map((_, i) => i + 1 < stepNum);

  const renderStep = () => {
    switch (stepNum) {
      case 1: return <Step1 state={wizardState} onChange={updateState} />;
      case 2: return <Step2 state={wizardState} onChange={updateState} />;
      case 3: return <Step3 property={property} state={wizardState} />;
      case 4: return <Step4 state={wizardState} onChange={updateState} />;
      case 5: return <Step5 state={wizardState} onChange={updateState} />;
      case 6: return <Step6 state={wizardState} onChange={updateState} />;
      case 7: return <Step7 state={wizardState} onChange={updateState} property={property} />;
      case 8: return <Step8 state={wizardState} onChange={updateState} />;
      case 9: return <Step9 state={wizardState} onChange={updateState} propertyId={propertyId} pricing={pricing} />;
      default: return null;
    }
  };

  const canNext = stepNum === 1 ? !!wizardState.rentalName.trim() : true;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <StepHeader propertyId={propertyId} stepNum={stepNum} propertyName={property.propertyName} />
        <Stepper checked={checkedSteps} />

        <Card className="p-6">
          {renderStep()}
          <SummaryPanel state={wizardState} />
          <NavButtons
            propertyId={propertyId}
            stepNum={stepNum}
            canNext={canNext}
            showDone={stepNum === TOTAL_STEPS}
          />
        </Card>
      </div>
    </div>
  );
}
