import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  BedDouble,
  Bath,
  Users,
  MapPin,
  Download,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Info,
  Copy,
  Check,
  Square,
  Ruler,
  AlertTriangle,
  ClipboardList,
  DollarSign,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  ExternalLink,
  Loader2,
  Search,
} from "lucide-react";
import { getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import type { Unit, PropertyUnitBuilder } from "@/data/unit-builder-data";
import { usePhotoLabels } from "@/hooks/use-photo-labels";

function PhotoGallery({ unit }: { unit: Unit }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { labelFor } = usePhotoLabels([unit.photoFolder]);

  if (unit.photos.length === 0) {
    return (
      <div className="aspect-[16/10] rounded-md bg-muted flex items-center justify-center">
        <div className="text-center text-muted-foreground p-4">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
          <p className="text-sm font-medium">No photos yet</p>
          <p className="text-xs mt-1">Photos will be added once the unit is identified</p>
        </div>
      </div>
    );
  }

  const photo = unit.photos[currentIndex];
  const photoPath = `/photos/${unit.photoFolder}/${photo.filename}`;
  // Prefer Claude-vision label from DB; fall back to the static label
  // baked into unit-builder-data.ts. Once relabel-all has run, every
  // photo here will show the AI-generated caption instead of the stale
  // hardcoded one.
  const displayLabel = labelFor(unit.photoFolder, photo.filename) ?? photo.label;

  const goNext = () => setCurrentIndex((prev) => (prev + 1) % unit.photos.length);
  const goPrev = () => setCurrentIndex((prev) => (prev - 1 + unit.photos.length) % unit.photos.length);

  return (
    <div>
      <div className="relative group">
        <div className="aspect-[16/10] overflow-hidden rounded-md bg-muted">
          <img
            src={photoPath}
            alt={photo.label}
            className="w-full h-full object-cover"
            data-testid={`img-photo-${unit.id}`}
          />
        </div>
        <Button
          size="icon"
          variant="secondary"
          className="absolute left-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={goPrev}
          aria-label="Previous photo"
          data-testid={`button-prev-photo-${unit.id}`}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={goNext}
          aria-label="Next photo"
          data-testid={`button-next-photo-${unit.id}`}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={() => setIsFullscreen(true)}
          aria-label="View fullscreen"
          data-testid={`button-fullscreen-${unit.id}`}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1 rounded-full" data-testid={`text-photo-counter-${unit.id}`}>
          {currentIndex + 1} / {unit.photos.length}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mt-2 text-center" data-testid={`text-photo-label-${unit.id}`}>
        {displayLabel}
      </p>

      <div className="flex gap-1.5 mt-3 overflow-x-auto pb-2">
        {unit.photos.map((p, idx) => {
          const thumbLabel = labelFor(unit.photoFolder, p.filename) ?? p.label;
          return (
            <div
              key={p.filename}
              onClick={() => setCurrentIndex(idx)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setCurrentIndex(idx); }}
              className={`flex-shrink-0 rounded overflow-hidden border-2 transition-colors cursor-pointer ${
                idx === currentIndex ? "border-primary" : "border-transparent"
              }`}
              data-testid={`button-thumbnail-${unit.id}-${idx}`}
              title={thumbLabel}
            >
              <img
                src={`/photos/${unit.photoFolder}/${p.filename}`}
                alt={thumbLabel}
                className="w-16 h-12 object-cover"
              />
            </div>
          );
        })}
      </div>

      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setIsFullscreen(false)}
          data-testid={`modal-fullscreen-${unit.id}`}
        >
          <Button
            size="icon"
            variant="secondary"
            className="absolute top-4 right-4"
            onClick={() => setIsFullscreen(false)}
            data-testid={`button-close-fullscreen-${unit.id}`}
          >
            <Square className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            className="absolute left-4 top-1/2 -translate-y-1/2"
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            aria-label="Previous photo"
            data-testid={`button-fullscreen-prev-${unit.id}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <img
            src={photoPath}
            alt={photo.label}
            className="max-w-[90vw] max-h-[85vh] object-contain"
            onClick={(e) => e.stopPropagation()}
            data-testid={`img-fullscreen-${unit.id}`}
          />
          <Button
            size="icon"
            variant="secondary"
            className="absolute right-4 top-1/2 -translate-y-1/2"
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            aria-label="Next photo"
            data-testid={`button-fullscreen-next-${unit.id}`}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm">
            {photo.label} ({currentIndex + 1} / {unit.photos.length})
          </div>
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button variant="outline" onClick={handleCopy} data-testid={`button-copy-${label}`}>
      {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
      {copied ? "Copied" : `Copy ${label}`}
    </Button>
  );
}

function getAllPhotoFolders(property: PropertyUnitBuilder): string[] {
  const folders = new Set<string>();
  for (const unit of property.units) {
    if (unit.photos.length > 0 && unit.photoFolder) {
      folders.add(unit.photoFolder);
    }
  }
  return Array.from(folders);
}

function getDownloadAllUrl(property: PropertyUnitBuilder): string {
  const folders = getAllPhotoFolders(property);
  const name = property.complexName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  let url = `/api/photos/zip-multi?folders=${folders.join(",")}&name=${name}`;
  if (property.communityPhotos && property.communityPhotos.length > 0 && property.communityPhotoFolder) {
    const beginningPhotos = property.communityPhotos.filter(p => p.position === "beginning").map(p => p.filename).join(",");
    const endPhotos = property.communityPhotos.filter(p => p.position === "end").map(p => p.filename).join(",");
    url += `&communityFolder=${property.communityPhotoFolder}&beginningPhotos=${encodeURIComponent(beginningPhotos)}&endPhotos=${encodeURIComponent(endPhotos)}`;
  }
  return url;
}

type BuyInMarketsResponse = {
  propertyId: number;
  baseCommunity: string;
  markets: string[];
  defaultMarkets: string[];
  threshold?: number;
  defaultThreshold?: number;
  saved: boolean;
  availableMarkets: string[];
  updatedAt: string | null;
};

type OtaVisibilityPlatform = "booking" | "vrbo";
type OtaVisibilityStatus = "queued" | "running" | "found" | "not_found" | "error";
type OtaVisibilityJob = {
  id: string;
  platform: OtaVisibilityPlatform;
  status: OtaVisibilityStatus;
  message: string;
  updatedAt: string;
  searchedAt: string | null;
  completedAt: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  searchTerm: string | null;
  searchUrl: string | null;
  publicUrl: string | null;
  found: boolean;
  foundPage: number | null;
  foundPosition: number | null;
  foundUrl: string | null;
  matchedTitle: string | null;
  candidatesChecked: number;
  bestCandidate: {
    title: string;
    url: string;
    score: number;
    reason: string;
    position: number;
    page: number;
  } | null;
  candidates: Array<{
    title: string;
    url: string;
    score: number;
    reason: string;
    position: number;
    page: number;
  }>;
  positionLog: string[];
  sidecarReason: string | null;
  durationMs: number | null;
  error: string | null;
};

type OtaVisibilityResponse = {
  propertyId: number;
  booking: OtaVisibilityJob | null;
  vrbo: OtaVisibilityJob | null;
};

function formatVisibilityDate(value: string | null): string {
  if (!value) return "Not checked";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function OtaVisibilityCard({
  platform,
  job,
  running,
  onRun,
}: {
  platform: OtaVisibilityPlatform;
  job: OtaVisibilityJob | null;
  running: boolean;
  onRun: (platform: OtaVisibilityPlatform) => void;
}) {
  const label = platform === "booking" ? "Booking.com" : "VRBO";
  const isActive = job?.status === "queued" || job?.status === "running" || running;
  const statusLabel = !job
    ? "Needs check"
    : job.status === "found"
      ? "Found"
      : job.status === "not_found"
        ? "Not found"
        : job.status === "error"
          ? "Error"
          : "Running";
  const statusClass = job?.status === "found"
    ? "bg-green-100 text-green-700 border-green-200"
    : job?.status === "not_found" || job?.status === "error"
      ? "bg-red-100 text-red-700 border-red-200"
      : "bg-muted text-muted-foreground border-border";

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-semibold">{label}</p>
            <Badge variant="outline" className={statusClass}>{statusLabel}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {job?.checkIn && job?.checkOut
              ? `${job.checkIn} to ${job.checkOut}${job.nights ? ` · ${job.nights} nights` : ""}`
              : "Finds the next Guesty-available stay window before searching."}
          </p>
        </div>
        <Button
          type="button"
          variant={job?.status === "found" ? "outline" : "default"}
          onClick={() => onRun(platform)}
          disabled={isActive}
          data-testid={`button-run-${platform}-visibility`}
        >
          {isActive ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
          {isActive ? "Checking" : `Run ${label}`}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs">
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-muted-foreground">Searched at</p>
          <p className="font-medium">{formatVisibilityDate(job?.searchedAt ?? null)}</p>
        </div>
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-muted-foreground">Last update</p>
          <p className="font-medium">{formatVisibilityDate(job?.updatedAt ?? null)}</p>
        </div>
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-muted-foreground">Result page</p>
          <p className="font-medium">{job?.foundPage ? `Page ${job.foundPage}, position ${job.foundPosition}` : "—"}</p>
        </div>
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-muted-foreground">Cards checked</p>
          <p className="font-medium">{job?.candidatesChecked ?? "—"}</p>
        </div>
      </div>

      {job && (
        <div className="mt-3 space-y-2 text-sm">
          <p className={job.status === "error" ? "text-red-700" : "text-muted-foreground"}>{job.message}</p>
          {job.matchedTitle && <p className="font-medium">{job.matchedTitle}</p>}
          {job.bestCandidate && !job.found && (
            <p className="text-xs text-muted-foreground">
              Best near match: {job.bestCandidate.title} · score {job.bestCandidate.score} ({job.bestCandidate.reason})
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {job.searchUrl && (
              <Button asChild size="sm" variant="outline">
                <a href={job.searchUrl} target="_blank" rel="noopener noreferrer">
                  Search URL <ExternalLink className="h-3.5 w-3.5 ml-1" />
                </a>
              </Button>
            )}
            {job.foundUrl && (
              <Button asChild size="sm" variant="outline">
                <a href={job.foundUrl} target="_blank" rel="noopener noreferrer">
                  Found listing <ExternalLink className="h-3.5 w-3.5 ml-1" />
                </a>
              </Button>
            )}
            {job.publicUrl && (
              <Button asChild size="sm" variant="outline">
                <a href={job.publicUrl} target="_blank" rel="noopener noreferrer">
                  Guesty public URL <ExternalLink className="h-3.5 w-3.5 ml-1" />
                </a>
              </Button>
            )}
          </div>
          {job.sidecarReason && <p className="text-[11px] text-muted-foreground">Sidecar: {job.sidecarReason}</p>}
          {job.positionLog?.length > 0 && (
            <div className="rounded-md border bg-muted/20 p-2">
              <p className="mb-1 text-xs font-medium">Result position log</p>
              <div className="space-y-1">
                {job.positionLog.slice(0, 6).map((line, index) => (
                  <p key={`${job.id}-position-${index}`} className="text-[11px] text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          )}
          {job.error && <p className="text-xs text-red-700">{job.error}</p>}
        </div>
      )}
    </Card>
  );
}

function OtaVisibilityTab({ propertyId }: { propertyId: number }) {
  const [data, setData] = useState<OtaVisibilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<Partial<Record<OtaVisibilityPlatform, boolean>>>({});
  const [error, setError] = useState<string | null>(null);

  const loadVisibility = async () => {
    try {
      const response = await fetch(`/api/builder/ota-visibility/${propertyId}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? "Failed to load OTA visibility");
      setData(payload);
      setError(null);
      const nextRunning: Partial<Record<OtaVisibilityPlatform, boolean>> = {};
      for (const platform of ["booking", "vrbo"] as const) {
        const job = payload?.[platform] as OtaVisibilityJob | null;
        nextRunning[platform] = job?.status === "queued" || job?.status === "running";
      }
      setRunning(nextRunning);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadVisibility();
  }, [propertyId]);

  useEffect(() => {
    if (!running.booking && !running.vrbo) return;
    const timer = window.setInterval(() => void loadVisibility(), 2500);
    return () => window.clearInterval(timer);
  }, [running.booking, running.vrbo, propertyId]);

  const runPlatform = async (platform: OtaVisibilityPlatform) => {
    setRunning((prev) => ({ ...prev, [platform]: true }));
    setError(null);
    try {
      const response = await fetch(`/api/builder/ota-visibility/${propertyId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? `Failed to start ${platform} visibility check`);
      setData((prev) => ({ propertyId, booking: prev?.booking ?? null, vrbo: prev?.vrbo ?? null, [platform]: payload }));
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setRunning((prev) => ({ ...prev, [platform]: false }));
    }
  };

  if (loading) {
    return <Card className="p-4 text-sm text-muted-foreground">Loading OTA visibility...</Card>;
  }

  return (
    <Card className="p-4 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold">OTA Visibility</h2>
          <p className="text-sm text-muted-foreground">
            Uses Guesty calendar availability, then searches Booking.com and VRBO through the local sidecar.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void runPlatform("booking");
            void runPlatform("vrbo");
          }}
          disabled={!!running.booking || !!running.vrbo}
          data-testid="button-run-all-ota-visibility"
        >
          {(running.booking || running.vrbo) ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
          Run all
        </Button>
      </div>

      {error && (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <OtaVisibilityCard platform="booking" job={data?.booking ?? null} running={!!running.booking} onRun={runPlatform} />
        <OtaVisibilityCard platform="vrbo" job={data?.vrbo ?? null} running={!!running.vrbo} onRun={runPlatform} />
      </div>
    </Card>
  );
}

function BuyInMarketsTab({ propertyId }: { propertyId: number }) {
  const [data, setData] = useState<BuyInMarketsResponse | null>(null);
  const [markets, setMarkets] = useState<string[]>([]);
  const [threshold, setThreshold] = useState<number>(85);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMarkets = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/property/${propertyId}/buy-in-markets`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? "Failed to load buy-in markets");
      setData(payload);
      setMarkets(Array.isArray(payload.markets) ? payload.markets.slice(0, 3) : []);
      setThreshold(typeof payload.threshold === "number" ? payload.threshold : 85);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMarkets();
  }, [propertyId]);

  const availableMarkets = (data?.availableMarkets ?? []).filter((market) => market !== data?.baseCommunity);
  const chooseMarket = (index: number, value: string) => {
    setMarkets((prev) => prev.map((market, i) => (i === index ? value : market)));
  };
  const addMarket = () => {
    const next = availableMarkets.find((market) => !markets.includes(market));
    if (!next) return;
    setMarkets((prev) => [...prev, next].slice(0, 3));
  };
  const removeMarket = (index: number) => {
    setMarkets((prev) => prev.filter((_, i) => i !== index));
  };
  const saveMarkets = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleaned = markets.map((market) => market.trim()).filter(Boolean);
      const response = await fetch(`/api/property/${propertyId}/buy-in-markets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markets: cleaned, unitTypeConfidenceThreshold: threshold }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? "Failed to save buy-in markets");
      setData(payload);
      setMarkets(Array.isArray(payload.markets) ? payload.markets.slice(0, 3) : []);
      if (typeof payload.threshold === "number") setThreshold(payload.threshold);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };
  const resetMarkets = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/property/${propertyId}/buy-in-markets`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? "Failed to reset buy-in markets");
      setData(payload);
      setMarkets(Array.isArray(payload.markets) ? payload.markets.slice(0, 3) : []);
      setThreshold(85);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        Loading buy-in markets...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-muted/20 p-3">
        <p className="text-xs text-muted-foreground mb-1">Base community</p>
        <p className="text-sm font-medium" data-testid={`text-buy-in-base-${propertyId}`}>
          {data?.baseCommunity ?? "Unknown"}
        </p>
      </div>

      <div className="rounded-md border bg-muted/10 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Unit-type confidence threshold for attach</p>
            <p className="text-[11px] text-muted-foreground max-w-[42ch]">
              85+ (default) requires strong proof the candidate matches the exact bedroom count + sub-community for combo slots (Poipu Kai examples: Regency vs Pili Mai). Lower = more manual review allowed. Applies to cheapest buy-in and city-wide VRBO combo matching.
            </p>
          </div>
          <input
            type="number"
            min={60}
            max={95}
            step={1}
            value={threshold}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v)) setThreshold(Math.max(60, Math.min(95, v)));
            }}
            className="h-9 w-20 rounded-md border border-input bg-background px-3 text-sm font-mono text-right"
            data-testid={`input-buy-in-threshold-${propertyId}`}
            aria-label="Unit type confidence threshold"
          />
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">Current effective: <span className="font-mono">{threshold}</span>% (higher = stricter correctness for multi-unit bookings)</p>
      </div>

      <div className="space-y-2">
        {markets.map((market, index) => (
          <div key={`${index}-${market}`} className="flex items-center gap-2">
            <select
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              value={market}
              onChange={(event) => chooseMarket(index, event.target.value)}
              data-testid={`select-buy-in-market-${propertyId}-${index}`}
            >
              {availableMarkets.map((option) => (
                <option key={option} value={option} disabled={markets.includes(option) && option !== market}>
                  {option}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => removeMarket(index)}
              aria-label={`Remove market ${index + 1}`}
              data-testid={`button-remove-buy-in-market-${propertyId}-${index}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {markets.length === 0 && (
          <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No custom recommended markets saved.
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={addMarket} disabled={markets.length >= 3 || saving} data-testid={`button-add-buy-in-market-${propertyId}`}>
          <Plus className="h-4 w-4 mr-2" />
          Add market
        </Button>
        <Button type="button" onClick={saveMarkets} disabled={saving} data-testid={`button-save-buy-in-markets-${propertyId}`}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? "Saving" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={resetMarkets} disabled={saving} data-testid={`button-reset-buy-in-markets-${propertyId}`}>
          <RotateCcw className="h-4 w-4 mr-2" />
          Defaults
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {data?.saved ? "Custom markets + threshold saved for this property." : "Using default markets and 85% threshold."}
      </p>
    </div>
  );
}

function UnitCard({ unit, propertyId, complexName }: { unit: Unit; propertyId: number; complexName: string }) {
  return (
    <Card className="overflow-visible">
      <div className="p-4 md:p-6">
        <div className="mb-4">
          <h3 className="text-base font-bold" data-testid={`text-unit-title-${unit.id}`}>
            {complexName} #{unit.unitNumber}
          </h3>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <Badge variant="secondary">
              <BedDouble className="h-3 w-3 mr-1" />
              {unit.bedrooms} BR
            </Badge>
            <Badge variant="secondary">
              <Bath className="h-3 w-3 mr-1" />
              {unit.bathrooms} BA
            </Badge>
            <Badge variant="secondary">
              <Users className="h-3 w-3 mr-1" />
              {unit.maxGuests} Guests
            </Badge>
            <Badge variant="secondary">
              <Ruler className="h-3 w-3 mr-1" />
              {unit.sqft} sq ft
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PhotoGallery unit={unit} />

          <Tabs defaultValue="title" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="title" className="flex-1" data-testid={`tab-title-${unit.id}`}>
                Details
              </TabsTrigger>
              <TabsTrigger value="short" className="flex-1" data-testid={`tab-short-${unit.id}`}>
                Short Desc
              </TabsTrigger>
              <TabsTrigger value="long" className="flex-1" data-testid={`tab-long-${unit.id}`}>
                Full Desc
              </TabsTrigger>
              <TabsTrigger value="buy-in-markets" className="flex-1" data-testid={`tab-buy-in-markets-${unit.id}`}>
                Buy In Markets
              </TabsTrigger>
            </TabsList>

            <TabsContent value="title" className="mt-3">
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Unit Number</p>
                  <Card className="p-3">
                    <p className="text-sm font-medium" data-testid={`text-unit-number-${unit.id}`}>
                      {unit.unitNumber === "TBD" ? "To be determined" : `#${unit.unitNumber}`}
                    </p>
                  </Card>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Configuration</p>
                  <Card className="p-3">
                    <p className="text-sm">
                      {unit.bedrooms} Bedrooms / {unit.bathrooms} Bathrooms / {unit.sqft} sq ft / Up to {unit.maxGuests} guests
                    </p>
                  </Card>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="short" className="mt-3">
              <div className="space-y-3">
                <Card className="p-3">
                  <p className="text-sm leading-relaxed" data-testid={`text-short-desc-${unit.id}`}>
                    {unit.shortDescription}
                  </p>
                </Card>
                <CopyButton text={unit.shortDescription} label={`short-desc-${unit.id}`} />
              </div>
            </TabsContent>

            <TabsContent value="long" className="mt-3">
              <div className="space-y-3">
                <Card className="p-3 max-h-[400px] overflow-y-auto">
                  <p className="text-sm leading-relaxed whitespace-pre-line" data-testid={`text-long-desc-${unit.id}`}>
                    {unit.longDescription}
                  </p>
                </Card>
                <CopyButton text={unit.longDescription} label={`long-desc-${unit.id}`} />
              </div>
            </TabsContent>

            <TabsContent value="buy-in-markets" className="mt-3">
              <BuyInMarketsTab propertyId={propertyId} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </Card>
  );
}

export default function UnitBuilder() {
  const params = useParams<{ id: string }>();
  const propertyId = parseInt(params.id || "0", 10);
  const property = getUnitBuilderByPropertyId(propertyId);


  if (!property) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-[1400px] mx-auto px-4 py-6">
          <Link href="/">
            <Button variant="ghost" data-testid="button-back-dashboard">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Button>
          </Link>
          <div className="mt-8 text-center">
            <h1 className="text-xl font-bold">Property not found</h1>
            <p className="text-muted-foreground mt-2">No unit builder data exists for this property.</p>
          </div>
        </div>
      </div>
    );
  }

  const totalUnitPhotos = property.units.reduce((sum, u) => sum + u.photos.length, 0);
  const totalPhotos = totalUnitPhotos + (property.communityPhotos?.length || 0);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="mb-6">
          <Link href="/">
            <Button variant="ghost" data-testid="button-back-dashboard">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Button>
          </Link>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
              Unit Builder - {property.propertyName}
            </h1>
            <p className="text-muted-foreground mt-1">
              {property.complexName} - {property.units.length} unit{property.units.length > 1 ? "s" : ""} in this listing
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/buy-in-tracker">
              <Button variant="default" data-testid="button-buy-in">
                <DollarSign className="h-4 w-4 mr-2" />
                Buy In
              </Button>
            </Link>
            <Link href={`/builder/${property.propertyId}/preflight`}>
              <Button variant="outline" data-testid="button-build-guesty">
                <ClipboardList className="h-4 w-4 mr-2" />
                Build Listing
              </Button>
            </Link>
            {totalPhotos > 0 && (
              <Button
                variant="outline"
                asChild
                data-testid="button-download-all"
              >
                <a href={getDownloadAllUrl(property)} download>
                  <Download className="h-4 w-4 mr-2" />
                  Download All {totalPhotos} Photos
                </a>
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Booking.com Listing Title (max 255 chars)</p>
            <p className="text-sm font-medium" data-testid="text-booking-title">{property.bookingTitle}</p>
            <p className="text-xs text-muted-foreground mt-1">{property.bookingTitle.length} / 255 characters</p>
            <div className="mt-2">
              <CopyButton text={property.bookingTitle} label="title" />
            </div>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Property Address</p>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="text-sm font-medium" data-testid="text-address">{property.address}</p>
            </div>
            <div className="mt-2">
              <CopyButton text={property.address} label="address" />
            </div>
          </Card>
        </div>

        <Card className="p-4 mb-6">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium mb-1">Sample Property Disclaimer</p>
              <p className="text-sm text-muted-foreground" data-testid="text-disclaimer">
                {property.sampleDisclaimer}
              </p>
            </div>
          </div>
        </Card>

        {!property.hasPhotos && (
          <Card className="p-4 mb-6 border-dashed">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium mb-1">Placeholder - Units Not Yet Identified</p>
                <p className="text-sm text-muted-foreground">
                  The individual units for this property have not been identified yet. Once specific units are found that are not on Booking.com or VRBO, their details, photos, and descriptions will be populated below.
                </p>
              </div>
            </div>
          </Card>
        )}

        <OtaVisibilityTab propertyId={property.propertyId} />

        <div className="space-y-6">
          {property.units.map((unit) => (
            <UnitCard key={unit.id} unit={unit} propertyId={property.propertyId} complexName={property.complexName} />
          ))}
        </div>

        <div className="mt-6 text-xs text-muted-foreground text-center">
          VacationRentalExpertz property data. Unit status verified against Booking.com and VRBO.
        </div>
      </div>
    </div>
  );
}
