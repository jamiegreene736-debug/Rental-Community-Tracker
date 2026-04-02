import { useState, useEffect, useRef } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  ArrowLeft,
  BedDouble,
  Bath,
  Users,
  Copy,
  Check,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  ClipboardList,
  Image,
  FileText,
  ListChecks,
  ChevronRight,
  DollarSign,
  TrendingUp,
  Upload,
  AlertCircle,
  Sparkles,
  Wand2,
  ShieldCheck,
  ShieldAlert,
  Shield,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getUnitBuilderByPropertyId, getMultiUnitPropertyIds, LISTING_DISCLOSURE } from "@/data/unit-builder-data";
import type { Unit, PropertyUnitBuilder, CommunityPhoto } from "@/data/unit-builder-data";
import {
  LODGIFY_AMENITY_CATEGORIES,
  getDefaultAmenities,
} from "@/data/lodgify-amenities";
import {
  getPropertyPricing,
  getSeasonLabel,
  getSeasonBadgeVariant,
  type PropertyPricing,
} from "@/data/pricing-data";

function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          data-testid={`button-copy-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Card className="p-3">
        <p className={`text-sm leading-relaxed ${multiline ? "whitespace-pre-line max-h-[300px] overflow-y-auto" : ""}`}
          data-testid={`text-field-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {value}
        </p>
      </Card>
    </div>
  );
}

function AmenitiesChecklist({ propertyId }: { propertyId: number }) {
  const defaults = getDefaultAmenities(propertyId);
  const [checked, setChecked] = useState<Set<string>>(new Set(defaults));
  const [copied, setCopied] = useState(false);

  const toggle = (item: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  };

  const copyAmenities = async () => {
    const lines: string[] = [];
    for (const cat of LODGIFY_AMENITY_CATEGORIES) {
      const selected = cat.items.filter((i) => checked.has(i));
      if (selected.length > 0) {
        lines.push(`${cat.name}:`);
        selected.forEach((s) => lines.push(`  - ${s}`));
        lines.push("");
      }
    }
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const selectAll = () => {
    const all = new Set<string>();
    LODGIFY_AMENITY_CATEGORIES.forEach((c) => c.items.forEach((i) => all.add(i)));
    setChecked(all);
  };

  const clearAll = () => setChecked(new Set());
  const resetDefaults = () => setChecked(new Set(defaults));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={copyAmenities} data-testid="button-copy-amenities">
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
          {copied ? "Copied" : "Copy Selected Amenities"}
        </Button>
        <Button variant="ghost" size="sm" onClick={selectAll} data-testid="button-select-all-amenities">
          Select All
        </Button>
        <Button variant="ghost" size="sm" onClick={clearAll} data-testid="button-clear-amenities">
          Clear All
        </Button>
        <Button variant="ghost" size="sm" onClick={resetDefaults} data-testid="button-reset-amenities">
          Reset Defaults
        </Button>
        <Badge variant="secondary">{checked.size} selected</Badge>
      </div>

      <Accordion type="multiple" defaultValue={LODGIFY_AMENITY_CATEGORIES.map((c) => c.name)}>
        {LODGIFY_AMENITY_CATEGORIES.map((cat) => {
          const catCount = cat.items.filter((i) => checked.has(i)).length;
          return (
            <AccordionItem key={cat.name} value={cat.name}>
              <AccordionTrigger className="text-sm py-2" data-testid={`accordion-${cat.name.toLowerCase().replace(/\s+/g, "-")}`}>
                <span className="flex items-center gap-2">
                  {cat.name}
                  <Badge variant="secondary" className="text-xs">
                    {catCount}/{cat.items.length}
                  </Badge>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pl-1">
                  {cat.items.map((item) => (
                    <label
                      key={item}
                      className="flex items-center gap-2 py-1 px-2 rounded cursor-pointer hover-elevate"
                      data-testid={`checkbox-amenity-${item.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked.has(item)}
                        onChange={() => toggle(item)}
                        className="rounded border-muted-foreground"
                      />
                      <span className="text-sm">{item}</span>
                    </label>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}

// Matches server logic — any unit photo without exterior keywords is treated as interior.
// Generic names like photo_00.jpg default to interior because community/exterior photos
// are already kept in their own community folder (never in unit folders).
const EXTERIOR_KEYWORDS = ["pool", "community", "exterior", "outside", "beach", "ocean", "view", "patio", "balcony", "garden", "yard", "front", "aerial", "court", "tennis", "hot-tub", "hottub", "resort", "grounds", "walkway", "entrance", "driveway"];

function isInteriorPhoto(filename: string): boolean {
  const lower = filename.toLowerCase();
  return !EXTERIOR_KEYWORDS.some(k => lower.includes(k));
}

type FlowStep = "audit" | "makeover" | "done";

interface AuditUnitInput {
  id: string;
  label: string;
  photoFolder: string;
  photos: Array<{ filename: string; label: string }>;
  bedrooms: number;
  communityName: string;
  location: string;
}
interface AuditUnitResult {
  unitId: string;
  unitLabel: string;
  photoFilename: string;
  photoServePath: string;
  status: "checking" | "passed" | "flagged" | "error";
  airbnbUrl?: string;
  matchTitle?: string;
  matchLocation?: string;
  matchConfidence?: "high" | "medium" | "low";
  replacement?: Array<{ url: string; thumbnail: string; label: string }> | null;
  findingReplacement?: boolean;
}
interface MakeoverPhotoState {
  index: number;
  servePath: string;
  zipName: string;
  isInterior: boolean;
  status: "pending" | "processing" | "done" | "failed";
  hasResult: boolean;
}

interface MakeoverFlowModalProps {
  isOpen: boolean;
  onClose: () => void;
  propertyName: string;
  folders: string[];
  communityFolder?: string;
  beginningPhotos?: string[];
  endPhotos?: string[];
  unitsToAudit: AuditUnitInput[];
}

function MakeoverFlowModal({ isOpen, onClose, propertyName, folders, communityFolder, beginningPhotos, endPhotos, unitsToAudit }: MakeoverFlowModalProps) {
  const [step, setStep] = useState<FlowStep>("audit");
  const [auditResults, setAuditResults] = useState<AuditUnitResult[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<MakeoverPhotoState[]>([]);
  const [processedCount, setProcessedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [interiorCount, setInteriorCount] = useState(0);
  const [makeoverError, setMakeoverError] = useState<string | null>(null);
  const [makeoverDone, setMakeoverDone] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const findBedroomPhoto = (unitPhotos: Array<{ filename: string; label: string }>) => {
    const byLabel = unitPhotos.find(p => p.label.toLowerCase().includes("bedroom") || p.label.toLowerCase().includes("bed"));
    if (byLabel) return byLabel;
    const byFilename = unitPhotos.find(p => p.filename.toLowerCase().includes("bedroom") || p.filename.toLowerCase().includes("bed"));
    if (byFilename) return byFilename;
    const anyInterior = unitPhotos.find(p => isInteriorPhoto(p.filename));
    if (anyInterior) return anyInterior;
    return unitPhotos[0] || null;
  };

  const runAudit = async () => {
    const initial: AuditUnitResult[] = unitsToAudit
      .filter(u => u.photos.length > 0)
      .map(u => {
        const photo = findBedroomPhoto(u.photos);
        return {
          unitId: u.id,
          unitLabel: u.label,
          photoFilename: photo?.filename || "",
          photoServePath: photo ? `/photos/${u.photoFolder}/${photo.filename}` : "",
          status: "checking" as const,
        };
      });
    setAuditResults(initial);

    const checked = await Promise.all(
      initial.map(async (unit, i) => {
        if (!unit.photoFilename) return { ...unit, status: "error" as const };
        try {
          const auditUnit = unitsToAudit[i];
          const resp = await fetch("/api/photos/platform-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folder: auditUnit.photoFolder,
              filename: unit.photoFilename,
              communityName: auditUnit.communityName,
              location: auditUnit.location,
            }),
          });
          if (!resp.ok) return { ...unit, status: "error" as const };
          const data = await resp.json();
          const airbnbMatch = (data.platforms || []).find((p: any) => (p.url || "").includes("airbnb.com"));
          return {
            ...unit,
            status: (airbnbMatch ? "flagged" : "passed") as "flagged" | "passed",
            airbnbUrl: airbnbMatch?.url,
            matchTitle: airbnbMatch?.title || "",
            matchLocation: airbnbMatch?.matchLocation || "",
            matchConfidence: airbnbMatch?.confidence,
          };
        } catch {
          return { ...unit, status: "error" as const };
        }
      })
    );
    setAuditResults(checked);
    const hasFlags = checked.some(r => r.status === "flagged");
    if (!hasFlags) setTimeout(() => startMakeover(), 1500);
  };

  const startMakeover = async () => {
    setStep("makeover");
    setMakeoverError(null);
    setMakeoverDone(false);
    setPhotos([]);
    setProcessedCount(0);
    try {
      const resp = await fetch("/api/photos/ai-makeover/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folders, communityFolder, beginningPhotos, endPhotos, name: propertyName }),
      });
      if (!resp.ok) throw new Error("Failed to start makeover");
      const data = await resp.json();
      setJobId(data.jobId);
      setTotalCount(data.totalCount);
      setInteriorCount(data.interiorCount);
      const initialPhotos: MakeoverPhotoState[] = (data.photos || []).map((p: any) => ({
        index: p.index, servePath: p.servePath, zipName: p.zipName, isInterior: p.isInterior,
        status: "pending" as const, hasResult: false,
      }));
      setPhotos(initialPhotos);

      const es = new EventSource(`/api/photos/ai-makeover/events/${data.jobId}`);
      esRef.current = es;
      es.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.type === "photo_start") {
          setPhotos(prev => prev.map(p => p.index === event.index ? { ...p, status: "processing" } : p));
        } else if (event.type === "photo_done") {
          setProcessedCount(event.processedCount ?? 0);
          setPhotos(prev => prev.map(p => p.index === event.index ? { ...p, status: event.status, hasResult: event.hasResult } : p));
        } else if (event.type === "complete") {
          setProcessedCount(event.processedCount);
          setMakeoverDone(true);
          es.close();
          triggerDownload(data.jobId, propertyName);
          setTimeout(() => setStep("done"), 800);
        } else if (event.type === "error") {
          setMakeoverError(event.message);
          es.close();
        }
      };
      es.onerror = () => {
        es.close();
        setConnectionLost(true);
      };
    } catch (err: any) {
      setMakeoverError(err.message || "Failed to start");
    }
  };

  const findReplacement = async (unitIdx: number) => {
    const unit = unitsToAudit[unitIdx];
    setAuditResults(prev => prev.map((r, i) => i === unitIdx ? { ...r, findingReplacement: true } : r));
    try {
      const resp = await fetch(`/api/photos/find-replacement?communityName=${encodeURIComponent(unit.communityName)}&location=${encodeURIComponent(unit.location)}&bedrooms=${unit.bedrooms}`);
      const data = await resp.json();
      setAuditResults(prev => prev.map((r, i) => i === unitIdx ? { ...r, findingReplacement: false, replacement: data.images || [] } : r));
    } catch {
      setAuditResults(prev => prev.map((r, i) => i === unitIdx ? { ...r, findingReplacement: false, replacement: [] } : r));
    }
  };

  const reAuditReplacement = async (unitIdx: number, imageUrl: string) => {
    const auditUnit = unitsToAudit[unitIdx];
    try {
      const resp = await fetch("/api/photos/platform-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl,
          communityName: auditUnit.communityName,
          location: auditUnit.location,
        }),
      });
      if (!resp.ok) throw new Error("Check failed");
      const data = await resp.json();
      const airbnbMatch = (data.platforms || []).find((p: any) => (p.url || "").includes("airbnb.com"));
      if (!airbnbMatch) {
        setAuditResults(prev => prev.map((r, i) => i === unitIdx
          ? { ...r, photoServePath: imageUrl, status: "passed", replacement: null }
          : r));
        const anyFlagged = auditResults.some((r, i) => i !== unitIdx && r.status === "flagged");
        if (!anyFlagged) setTimeout(() => startMakeover(), 1200);
      } else {
        alert("This replacement photo was also found on Airbnb. Try another or continue anyway.");
      }
    } catch {
      alert("Could not check replacement photo.");
    }
  };

  const dismissFlag = (unitIdx: number) => {
    setAuditResults(prev => {
      const updated = prev.map((r, i) =>
        i === unitIdx ? { ...r, status: "passed" as const, airbnbUrl: undefined, matchTitle: undefined, matchLocation: undefined, replacement: null } : r
      );
      const stillFlagged = updated.some(r => r.status === "flagged");
      if (!stillFlagged) setTimeout(() => startMakeover(), 800);
      return updated;
    });
  };

  const triggerDownload = (jId: string, name: string) => {
    const a = document.createElement("a");
    a.href = `/api/photos/ai-makeover/download/${jId}`;
    a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, "-")}-ai-makeover.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  useEffect(() => {
    if (isOpen) {
      setStep("audit");
      setAuditResults([]);
      setJobId(null);
      setPhotos([]);
      setProcessedCount(0);
      setTotalCount(0);
      setInteriorCount(0);
      setMakeoverError(null);
      setMakeoverDone(false);
      setConnectionLost(false);
      runAudit();
    } else {
      esRef.current?.close();
    }
  }, [isOpen]);

  const auditDone = auditResults.length > 0 && auditResults.every(r => r.status !== "checking");
  const hasFlags = auditResults.some(r => r.status === "flagged");
  const doneCount = photos.filter(p => p.status === "done" || p.status === "failed").length;
  const processingIdx = photos.findIndex(p => p.status === "processing");
  const allPhotosForDisplay = photos.filter(p => p.isInterior);

  const STEPS: FlowStep[] = ["audit", "makeover", "done"];
  const stepLabels = { audit: "Photo Audit", makeover: "Upscale", done: "Complete" };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-1.5 mb-1">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
                  step === s
                    ? "bg-primary text-primary-foreground"
                    : STEPS.indexOf(step) > i
                    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`} data-testid={`step-indicator-${s}`}>
                  {i + 1}. {stepLabels[s]}
                </span>
              </div>
            ))}
          </div>
          <DialogTitle>
            {step === "audit" ? "Step 1: Photo Audit" : step === "makeover" ? "Step 2: 2× Upscaling" : "All Done!"}
          </DialogTitle>
          <DialogDescription>
            {step === "audit" && "Checking if your bedroom photos appear on any active Airbnb listing..."}
            {step === "makeover" && `Upscaling all ${totalCount} photos to 2× resolution using Real-ESRGAN. Your real photos are enhanced, not replaced.`}
            {step === "done" && (
              processedCount === 0
                ? `ZIP downloaded with ${totalCount} original photos — upscaling couldn't run (Replicate API key may be invalid).`
                : `${processedCount} of ${totalCount} photos upscaled 2×. ZIP downloaded with all ${totalCount} photos.`
            )}
          </DialogDescription>
        </DialogHeader>

        {/* ── STEP 1: AUDIT ── */}
        {step === "audit" && (
          <div className="space-y-3 mt-2">
            {auditResults.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" /> Preparing audit...
              </div>
            )}
            {auditResults.map((result, idx) => (
              <div key={result.unitId} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-start gap-3">
                  {result.photoServePath && (
                    <img src={result.photoServePath} alt={result.unitLabel}
                      className="w-16 h-16 object-cover rounded border flex-shrink-0"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold">{result.unitLabel}</p>
                    <p className="text-xs text-muted-foreground mb-1 truncate">
                      {result.photoFilename || "No photo available"}
                    </p>
                    {result.status === "checking" && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Searching reverse image index...
                      </span>
                    )}
                    {result.status === "passed" && (
                      <span className="flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400">
                        <ShieldCheck className="h-3.5 w-3.5" /> Audit Passed ✓ — not found on Airbnb
                      </span>
                    )}
                    {result.status === "flagged" && (
                      <div className="space-y-2">
                        <span className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
                          <ShieldAlert className="h-3.5 w-3.5" />
                          Flagged — photo found on an Airbnb listing
                          {result.matchConfidence && (
                            <span className={`ml-1 px-1 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                              result.matchConfidence === "high" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                              : result.matchConfidence === "medium" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
                              : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300"
                            }`}>
                              {result.matchConfidence} confidence
                            </span>
                          )}
                        </span>
                        {(result.matchTitle || result.matchLocation) && (
                          <div className="rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-2 py-1.5 space-y-0.5">
                            {result.matchTitle && (
                              <p className="text-xs font-medium text-red-900 dark:text-red-200 leading-snug">{result.matchTitle}</p>
                            )}
                            {result.matchLocation && (
                              <p className="text-[11px] text-red-700 dark:text-red-400 capitalize">{result.matchLocation}</p>
                            )}
                          </div>
                        )}
                        {result.airbnbUrl && (
                          <a href={result.airbnbUrl} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                            <ExternalLink className="h-3 w-3" /> View matching Airbnb listing
                          </a>
                        )}
                        {!result.replacement && (
                          <div className="flex gap-2 flex-wrap">
                            <Button size="sm" variant="outline" className="h-7 text-xs"
                              disabled={result.findingReplacement}
                              onClick={() => findReplacement(idx)}
                              data-testid={`button-find-new-unit-${result.unitId}`}>
                              {result.findingReplacement
                                ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Searching...</>
                                : <><RefreshCw className="h-3 w-3 mr-1" />Find New Unit</>}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-green-700 dark:hover:text-green-400"
                              onClick={() => dismissFlag(idx)}
                              data-testid={`button-not-a-match-${result.unitId}`}>
                              <ShieldCheck className="h-3 w-3 mr-1" />Not a Match
                            </Button>
                          </div>
                        )}
                        {result.replacement && result.replacement.length > 0 && (
                          <div className="space-y-1.5">
                            <p className="text-xs font-medium text-muted-foreground">Select a replacement bedroom photo:</p>
                            <div className="grid grid-cols-4 gap-1.5 max-h-32 overflow-y-auto">
                              {result.replacement.map((img, imgIdx) => (
                                <button key={imgIdx} onClick={() => reAuditReplacement(idx, img.url)}
                                  className="aspect-square rounded overflow-hidden border hover:border-primary transition-colors"
                                  data-testid={`button-replacement-photo-${imgIdx}`}>
                                  <img src={img.thumbnail} alt={img.label}
                                    className="w-full h-full object-cover"
                                    onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.3"; }} />
                                </button>
                              ))}
                            </div>
                            <p className="text-[10px] text-muted-foreground">Click a photo to re-audit it and use it instead.</p>
                          </div>
                        )}
                        {result.replacement !== undefined && result.replacement?.length === 0 && (
                          <p className="text-xs text-muted-foreground">No replacement photos found. Try continuing anyway.</p>
                        )}
                      </div>
                    )}
                    {result.status === "error" && (
                      <span className="text-xs text-muted-foreground">Could not check — skipping this unit</span>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {auditDone && hasFlags && (
              <div className="flex gap-2 pt-1 border-t">
                <Button size="sm" onClick={() => startMakeover()} data-testid="button-continue-anyway">
                  <Wand2 className="h-3.5 w-3.5 mr-1.5" />Continue Anyway
                </Button>
                <Button size="sm" variant="outline" onClick={onClose} data-testid="button-cancel-makeover">
                  Cancel
                </Button>
              </div>
            )}
            {auditDone && !hasFlags && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> All units passed — starting AI makeover...
              </p>
            )}
          </div>
        )}

        {/* ── STEP 2: MAKEOVER ── */}
        {step === "makeover" && (
          <div className="space-y-4 mt-2">
            {makeoverError ? (
              <div className="text-sm text-red-600 bg-red-50 dark:bg-red-950/30 rounded-lg p-3">
                <strong>Error:</strong> {makeoverError}
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      {connectionLost
                        ? `Connection lost after photo ${doneCount} — ZIP may still be ready`
                        : processingIdx >= 0
                        ? `Upscaling photo ${doneCount + 1} of ${totalCount}…`
                        : makeoverDone
                        ? `Complete — ${processedCount} photos upscaled 2×`
                        : totalCount > 0 ? "Starting upscaling job…" : "Building ZIP…"}
                    </span>
                    <span>{doneCount}/{totalCount}</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-purple-500 transition-all duration-500"
                      style={{ width: `${totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%` }} />
                  </div>
                </div>

                {connectionLost && jobId && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 space-y-2">
                    <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                      Live connection dropped — the job may still be running on the server.
                    </p>
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => triggerDownload(jobId, propertyName)}
                      data-testid="button-manual-download">
                      <Download className="h-3 w-3 mr-1.5" />Download ZIP (what's ready so far)
                    </Button>
                  </div>
                )}

                {allPhotosForDisplay.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Interior Photos — Before / After (2× Upscaled)</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-72 overflow-y-auto pr-1">
                      {allPhotosForDisplay.map(p => (
                        <div key={p.index} className="space-y-1" data-testid={`photo-makeover-${p.index}`}>
                          <div className="flex gap-1">
                            <div className="w-1/2">
                              <div className="aspect-square bg-muted rounded overflow-hidden">
                                {p.servePath && <img src={p.servePath} alt="Before" className="w-full h-full object-cover" />}
                              </div>
                              <p className="text-[9px] text-muted-foreground text-center mt-0.5">Original</p>
                            </div>
                            <div className="w-1/2">
                              <div className="aspect-square bg-muted rounded overflow-hidden relative">
                                {p.status === "processing" && (
                                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-purple-900/50">
                                    <Loader2 className="h-4 w-4 text-purple-200 animate-spin" />
                                    <span className="text-[9px] text-purple-200 mt-0.5">↑2×</span>
                                  </div>
                                )}
                                {p.hasResult && jobId && (
                                  <img src={`/api/photos/ai-makeover/result/${jobId}/photo/${p.index}`}
                                    alt="Upscaled" className="w-full h-full object-cover" />
                                )}
                              </div>
                              <p className="text-[9px] text-muted-foreground text-center mt-0.5">Upscaled</p>
                            </div>
                          </div>
                          <div className="text-center">
                            {p.status === "pending" && <span className="text-[10px] text-muted-foreground">Pending</span>}
                            {p.status === "processing" && (
                              <span className="text-[10px] text-purple-500 flex items-center justify-center gap-0.5">
                                <Loader2 className="h-2.5 w-2.5 animate-spin" /> Upscaling…
                              </span>
                            )}
                            {p.status === "done" && (
                              <span className="text-[10px] text-green-600 flex items-center justify-center gap-0.5">
                                <Check className="h-2.5 w-2.5" /> Done ✓
                              </span>
                            )}
                            {p.status === "failed" && <span className="text-[10px] text-muted-foreground">Original kept</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!jobId && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting upscaling job…
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── STEP 3: DONE ── */}
        {step === "done" && (
          <div className="space-y-3 mt-2">
            {processedCount === 0 ? (
              <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                <div className="h-10 w-10 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-amber-600 dark:text-amber-400 font-bold text-sm">!</span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">ZIP Downloaded — Upscaling Failed</p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    {totalCount} original photos bundled (renamed in correct order). Upscaling couldn't run — the Replicate API key may be invalid or expired. Update the <strong>REPLICATE_API_KEY</strong> secret and redeploy to enable upscaling.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <div className="h-10 w-10 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center flex-shrink-0">
                  <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-green-800 dark:text-green-200">ZIP Downloaded!</p>
                  <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
                    {processedCount} of {totalCount} photo{totalCount !== 1 ? "s" : ""} upscaled 2× with Real-ESRGAN. All {totalCount} photos bundled in the ZIP.
                  </p>
                </div>
              </div>
            )}
            <Button size="sm" variant="outline" onClick={onClose} data-testid="button-close-makeover-modal">
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type PlatformMatch = { name: string; url: string };
type PhotoCheckStatus = "idle" | "checking" | "clear" | "found" | "error";
type PhotoCheckResult = { status: PhotoCheckStatus; platforms: PlatformMatch[] };
type ReplacementPhoto = { url: string; label: string };

function usePlatformCheck(folder: string, communityFolder?: string) {
  const [results, setResults] = useState<Record<string, PhotoCheckResult>>({});
  const [isChecking, setIsChecking] = useState(false);
  const [replacement, setReplacement] = useState<null | { photos: ReplacementPhoto[]; source: string; error?: string }>(null);
  const [findingReplacement, setFindingReplacement] = useState(false);
  const [replacementCheckResults, setReplacementCheckResults] = useState<Record<number, PhotoCheckResult>>({});

  const checkPhotos = async (filenames: string[]) => {
    setIsChecking(true);
    const init: Record<string, PhotoCheckResult> = {};
    for (const f of filenames) init[f] = { status: "checking", platforms: [] };
    setResults(init);

    await Promise.all(
      filenames.map(async (filename) => {
        try {
          const resp = await fetch("/api/photos/platform-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder, filename }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          setResults(prev => ({
            ...prev,
            [filename]: { status: data.platforms.length > 0 ? "found" : "clear", platforms: data.platforms },
          }));
        } catch {
          setResults(prev => ({ ...prev, [filename]: { status: "error", platforms: [] } }));
        }
      })
    );
    setIsChecking(false);
  };

  const checkReplacementPhotos = async (photos: ReplacementPhoto[]) => {
    const init: Record<number, PhotoCheckResult> = {};
    for (let i = 0; i < photos.length; i++) init[i] = { status: "checking", platforms: [] };
    setReplacementCheckResults(init);

    await Promise.all(
      photos.map(async (photo, idx) => {
        try {
          const resp = await fetch("/api/photos/platform-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: photo.url }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          setReplacementCheckResults(prev => ({
            ...prev,
            [idx]: { status: data.platforms.length > 0 ? "found" : "clear", platforms: data.platforms },
          }));
        } catch {
          setReplacementCheckResults(prev => ({ ...prev, [idx]: { status: "error", platforms: [] } }));
        }
      })
    );
  };

  const findReplacement = async () => {
    if (!communityFolder) return;
    setFindingReplacement(true);
    setReplacement(null);
    setReplacementCheckResults({});
    try {
      const resp = await fetch("/api/photos/find-replacement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ communityFolder }),
      });
      const data = await resp.json();
      setReplacement(data);
      if (data.photos?.length > 0) {
        await checkReplacementPhotos(data.photos.slice(0, 3));
      }
    } catch {
      setReplacement({ photos: [], error: "Failed to search for a replacement unit.", source: "" });
    }
    setFindingReplacement(false);
  };

  const hasFlags = Object.values(results).some(r => r.status === "found");
  const replacementHasFlags = Object.values(replacementCheckResults).some(r => r.status === "found");

  return { results, isChecking, checkPhotos, hasFlags, findReplacement, findingReplacement, replacement, replacementCheckResults, replacementHasFlags };
}

function PlatformBadge({ result }: { result?: PhotoCheckResult }) {
  if (!result || result.status === "idle") return null;
  if (result.status === "checking") {
    return (
      <div className="flex items-center gap-0.5 text-[9px] text-muted-foreground mt-0.5">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        <span>Checking...</span>
      </div>
    );
  }
  if (result.status === "error") {
    return <div className="text-[9px] text-muted-foreground mt-0.5">Check failed</div>;
  }
  if (result.status === "clear") {
    return (
      <div className="flex items-center gap-0.5 text-[9px] text-green-700 dark:text-green-400 mt-0.5">
        <ShieldCheck className="h-2.5 w-2.5" />
        <span>Not found</span>
      </div>
    );
  }
  // found
  return (
    <div className="mt-0.5 space-y-0.5">
      {result.platforms.map((p, i) => (
        <a
          key={i}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 text-[9px] text-red-600 dark:text-red-400 hover:underline"
          title={`Found on ${p.name}: ${p.url}`}
        >
          <ShieldAlert className="h-2.5 w-2.5 flex-shrink-0" />
          <span className="truncate">{p.name}</span>
          <ExternalLink className="h-2 w-2 flex-shrink-0" />
        </a>
      ))}
    </div>
  );
}

function PhotoOrderPreview({ unit, communityPhotoFolder }: { unit: Unit; communityPhotos?: CommunityPhoto[]; communityPhotoFolder?: string }) {
  const [showMakeoverModal, setShowMakeoverModal] = useState(false);
  const { results: checkResults, isChecking, checkPhotos, hasFlags, findReplacement, findingReplacement, replacement, replacementCheckResults, replacementHasFlags } = usePlatformCheck(unit.photoFolder, communityPhotoFolder);

  const { data: fileData } = useQuery<{ folder: string; files: string[] }>({
    queryKey: [`/api/photos/community-files?folder=${communityPhotoFolder}`],
    enabled: !!communityPhotoFolder,
  });
  const communityFiles = fileData?.files || [];
  const hasCommunity = communityPhotoFolder && communityFiles.length > 0;
  const totalPhotos = unit.photos.length + communityFiles.length;

  if (unit.photos.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center">
        No photos available for this unit yet.
      </div>
    );
  }

  const downloadUrl = hasCommunity
    ? `/api/photos/zip-multi?folders=${unit.photoFolder}&name=${encodeURIComponent(unit.id)}&communityFolder=${communityPhotoFolder}&beginningPhotos=${encodeURIComponent(communityFiles.join(","))}&endPhotos=`
    : `/api/photos/zip/${unit.photoFolder}`;

  const photosToCheck = unit.photos.slice(0, 3).map(p => p.filename);
  const anyChecked = Object.keys(checkResults).length > 0;

  const unitForAudit: AuditUnitInput = {
    id: unit.id,
    label: unit.id,
    photoFolder: unit.photoFolder,
    photos: unit.photos,
    bedrooms: unit.bedrooms,
    communityName: unit.id.split("-")[0] || unit.id,
    location: "",
  };

  return (
    <>
      <MakeoverFlowModal
        isOpen={showMakeoverModal}
        onClose={() => setShowMakeoverModal(false)}
        propertyName={unit.id}
        folders={[unit.photoFolder]}
        communityFolder={communityPhotoFolder}
        beginningPhotos={communityFiles}
        endPhotos={[]}
        unitsToAudit={[unitForAudit]}
      />
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {totalPhotos} photos total ({unit.photos.length} unit{hasCommunity ? ` + ${communityFiles.length} community` : ""}) in Lodgify upload order
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => checkPhotos(photosToCheck)}
            disabled={isChecking}
            data-testid={`button-platform-check-${unit.id}`}
            title="Reverse-image-searches the first 3 photos on Airbnb, VRBO, and Booking.com"
          >
            {isChecking ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Checking...</>
            ) : anyChecked ? (
              <><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Re-check Photos</>
            ) : (
              <><Shield className="h-3.5 w-3.5 mr-1.5" />Check Photos</>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowMakeoverModal(true)}
            data-testid={`button-ai-makeover-${unit.id}`}
            title="Audits bedroom photo for Airbnb conflicts, then enhances all interior photos with professional AI."
          >
            <Wand2 className="h-3.5 w-3.5 mr-1.5" />AI Makeover + ZIP
          </Button>
          <Button
            variant="default"
            size="sm"
            asChild
            data-testid={`button-download-photos-${unit.id}`}
          >
            <a href={downloadUrl} download={`${unit.id}-photos.zip`}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download ZIP
            </a>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
        {unit.photos.map((photo, idx) => {
          const willBeProcessed = false;
          const checkResult = checkResults[photo.filename];
          return (
            <div
              key={photo.filename}
              className="relative group"
              data-testid={`photo-preview-${unit.id}-${idx}`}
            >
              <div className={`aspect-square rounded overflow-hidden border ${idx === 0 ? "border-primary ring-2 ring-primary/30" : checkResult?.status === "found" ? "border-red-400" : checkResult?.status === "clear" ? "border-green-400" : "border-transparent"}`}>
                <img
                  src={`/photos/${unit.photoFolder}/${photo.filename}`}
                  alt={photo.label}
                  className={`w-full h-full object-cover transition-opacity ${willBeProcessed ? "opacity-40" : "opacity-100"}`}
                />
                {willBeProcessed && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-purple-900/40 rounded">
                    <Loader2 className="h-4 w-4 text-purple-300 animate-spin" />
                    <span className="text-[8px] text-purple-200 mt-0.5 font-medium">AI</span>
                  </div>
                )}
              </div>
              <div className="absolute top-0.5 left-0.5 bg-black/70 text-white text-[10px] px-1 rounded">
                {idx + 1}
              </div>
              <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-[9px] px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity truncate">
                {photo.label}
              </div>
              {idx === 0 && (
                <Badge variant="default" className="absolute -top-1.5 -right-1.5 text-[9px] px-1 py-0">
                  Main
                </Badge>
              )}
              {checkResult && <PlatformBadge result={checkResult} />}
            </div>
          );
        })}
      </div>

      {hasFlags && communityPhotoFolder && (
        <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2.5 space-y-2">
          <p className="text-xs font-medium text-red-700 dark:text-red-400 flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5" />
            One or more photos were found on other booking platforms. Consider replacing this unit's photos.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
            onClick={findReplacement}
            disabled={findingReplacement}
            data-testid={`button-find-replacement-${unit.id}`}
          >
            {findingReplacement ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Searching for another unit...</>
            ) : (
              <><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Find Another Property</>
            )}
          </Button>
        </div>
      )}

      {replacement && (
        <div className="rounded border border-border bg-muted/30 px-3 py-3 space-y-2">
          {replacement.error ? (
            <p className="text-xs text-muted-foreground">{replacement.error}</p>
          ) : (
            <>
              <p className="text-xs font-medium flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                Now showing photos from <span className="font-semibold">{replacement.source}</span>
              </p>
              <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-1.5">
                {replacement.photos.map((photo, idx) => (
                  <div key={idx} className="space-y-0.5">
                    <div className={`aspect-square rounded overflow-hidden border ${replacementCheckResults[idx]?.status === "found" ? "border-red-400" : replacementCheckResults[idx]?.status === "clear" ? "border-green-400" : "border-border"}`}>
                      <img
                        src={photo.url}
                        alt={photo.label}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    </div>
                    <PlatformBadge result={replacementCheckResults[idx]} />
                  </div>
                ))}
              </div>
              {Object.values(replacementCheckResults).every(r => r.status !== "checking") && replacementHasFlags && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  Some replacement photos were also found on booking platforms. Try running the search again to find a cleaner unit.
                </p>
              )}
              {Object.values(replacementCheckResults).every(r => r.status !== "checking") && !replacementHasFlags && Object.keys(replacementCheckResults).length > 0 && (
                <p className="text-xs text-green-700 dark:text-green-400 flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" /> Replacement photos appear clean — not found on other platforms.
                </p>
              )}
            </>
          )}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Photos are numbered in optimal order: living/main areas first, then bedrooms/bathrooms, then exterior/community.
        The first photo becomes the main listing image in Lodgify.
      </p>
    </div>
    </>
  );
}

function CommunityPhotosSection({ property }: { property: PropertyUnitBuilder }) {
  const [showMakeoverModal, setShowMakeoverModal] = useState(false);

  const { data: fileData, isLoading: filesLoading } = useQuery<{ folder: string; files: string[] }>({
    queryKey: [`/api/photos/community-files?folder=${property.communityPhotoFolder}`],
    enabled: !!property.communityPhotoFolder,
  });

  const communityFiles = fileData?.files || [];
  const unitFolders = property.units.map(u => u.photoFolder).filter(Boolean);
  const totalUnitPhotos = property.units.reduce((sum, u) => sum + u.photos.length, 0);
  const totalPhotos = totalUnitPhotos + communityFiles.length;

  const downloadUrl = communityFiles.length > 0
    ? `/api/photos/zip-multi?folders=${unitFolders.join(",")}&name=${encodeURIComponent(property.propertyName)}&communityFolder=${property.communityPhotoFolder}&beginningPhotos=${encodeURIComponent(communityFiles.join(","))}&endPhotos=`
    : `/api/photos/zip-multi?folders=${unitFolders.join(",")}&name=${encodeURIComponent(property.propertyName)}`;

  const unitsToAudit: AuditUnitInput[] = property.units.map(u => ({
    id: u.id,
    label: `${property.complexName} #${u.unitNumber}`,
    photoFolder: u.photoFolder,
    photos: u.photos,
    bedrooms: u.bedrooms,
    communityName: property.complexName,
    location: property.address || "",
  }));

  if (!property.communityPhotoFolder) return null;

  return (
    <>
      <MakeoverFlowModal
        isOpen={showMakeoverModal}
        onClose={() => setShowMakeoverModal(false)}
        propertyName={property.propertyName}
        folders={unitFolders}
        communityFolder={property.communityPhotoFolder}
        beginningPhotos={communityFiles}
        endPhotos={[]}
        unitsToAudit={unitsToAudit}
      />
    <Card className="p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <h3 className="text-sm font-bold flex items-center gap-2" data-testid="text-community-photos-title">
            <Image className="h-4 w-4" />
            Community & Resort Photos
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {filesLoading ? "Loading community photos..." : `${communityFiles.length} community photos + ${totalUnitPhotos} unit photos = ${totalPhotos} total`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowMakeoverModal(true)}
            data-testid="button-ai-makeover-all"
            title="Audits bedroom photos for Airbnb conflicts, then enhances all interior photos with professional AI. Community and exterior photos are kept as-is."
          >
            <Wand2 className="h-3.5 w-3.5 mr-1.5" />AI Makeover All + ZIP
          </Button>
          <Button
            variant="default"
            size="sm"
            asChild
            data-testid="button-download-all-photos"
          >
            <a href={downloadUrl} download={`${property.propertyName}-all-photos.zip`}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download All Photos (ZIP)
            </a>
          </Button>
        </div>
      </div>
      {filesLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading community photos...
        </div>
      )}

      {!filesLoading && communityFiles.length === 0 && (
        <div className="text-xs text-muted-foreground bg-muted/30 rounded px-3 py-3">
          No community photos found. Use the <strong>Community Photos</strong> tool from the dashboard to find and save photos for this resort.
        </div>
      )}

      {!filesLoading && communityFiles.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            Community Photos (uploaded before unit photos)
          </p>
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
            {communityFiles.map((filename, idx) => (
              <div key={filename} className="relative group" data-testid={`photo-community-${idx}`}>
                <div className="aspect-square rounded overflow-hidden border border-blue-300 dark:border-blue-700">
                  <img
                    src={`/photos/${property.communityPhotoFolder}/${filename}`}
                    alt={`Community photo ${idx + 1}`}
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.2"; }}
                  />
                </div>
                <div className="absolute top-0.5 left-0.5 bg-blue-600/80 text-white text-[10px] px-1 rounded">
                  {idx + 1}
                </div>
                <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-[9px] px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity truncate">
                  {filename}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs font-medium text-muted-foreground">
            Unit Photos (follow after community photos) — see individual unit tabs below
          </p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground mt-3">
        Download includes: community photos first, then all unit photos. Files are numbered sequentially for correct Lodgify upload order.
      </p>
    </Card>
    </>
  );
}

function UnitPrepCard({ unit, complexName, propertyId, communityPhotos, communityPhotoFolder }: { unit: Unit; complexName: string; propertyId: number; communityPhotos?: CommunityPhoto[]; communityPhotoFolder?: string }) {
  return (
    <Card className="overflow-visible">
      <div className="p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
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
            </div>
          </div>
        </div>

        <div className="mb-3">
          <CopyField
            label="Room Configuration"
            value={`${unit.bedrooms} Bedrooms, ${unit.bathrooms} Bathrooms, Sleeps ${unit.maxGuests}, ${unit.sqft} sq ft`}
          />
        </div>

        <Tabs defaultValue="amenities" className="w-full">
          <TabsList className="w-full flex-wrap">
            <TabsTrigger value="amenities" className="flex-1 gap-1" data-testid={`tab-amenities-${unit.id}`}>
              <ListChecks className="h-3.5 w-3.5" />
              Amenities
            </TabsTrigger>
            <TabsTrigger value="photos" className="flex-1 gap-1" data-testid={`tab-photos-${unit.id}`}>
              <Image className="h-3.5 w-3.5" />
              Photos ({unit.photos.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="amenities" className="mt-4">
            <AmenitiesChecklist propertyId={propertyId} />
          </TabsContent>

          <TabsContent value="photos" className="mt-4">
            <PhotoOrderPreview unit={unit} communityPhotos={communityPhotos} communityPhotoFolder={communityPhotoFolder} />
          </TabsContent>
        </Tabs>
      </div>
    </Card>
  );
}

function LodgifySyncStatus({ propertyId }: { propertyId: number }) {
  const { data: mapData = [], isLoading } = useQuery<{ propertyId: number; lodgifyPropertyId: string }[]>({
    queryKey: ["/api/lodgify/property-map"],
  });
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState("");
  const [saving, setSaving] = useState(false);

  const entry = mapData.find(e => e.propertyId === propertyId);
  const lodgifyId = entry?.lodgifyPropertyId ?? null;

  const handleSave = async () => {
    const trimmed = inputVal.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await apiRequest("PUT", `/api/lodgify/property-map/${propertyId}`, { lodgifyPropertyId: trimmed });
      queryClient.invalidateQueries({ queryKey: ["/api/lodgify/property-map"] });
      toast({ title: "Lodgify ID saved", description: `Property ID #${trimmed} recorded.` });
      setEditing(false);
      setInputVal("");
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!confirm("Remove the Lodgify Property ID from this property?")) return;
    setSaving(true);
    try {
      await apiRequest("DELETE", `/api/lodgify/property-map/${propertyId}`);
      queryClient.invalidateQueries({ queryKey: ["/api/lodgify/property-map"] });
      toast({ title: "Lodgify ID removed" });
    } catch (err: any) {
      toast({ title: "Failed to remove", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Lodgify status…
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        {lodgifyId ? (
          <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
        ) : (
          <XCircle className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {lodgifyId ? (
              <>
                <span className="text-sm font-medium text-green-700 dark:text-green-400">In Lodgify</span>
                <span className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">#{lodgifyId}</span>
              </>
            ) : (
              <span className="text-sm font-medium">Not in Lodgify</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {lodgifyId
              ? "This property has been built out in Lodgify. Use the ID above to push rates or manage the listing."
              : "Enter the Lodgify Property ID once this listing is created in Lodgify."}
          </p>

          {editing ? (
            <div className="flex items-center gap-2 mt-3">
              <Input
                placeholder="e.g. 784523"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") { setEditing(false); setInputVal(""); } }}
                className="h-8 text-sm w-48"
                autoFocus
                data-testid="input-lodgify-property-id-map"
              />
              <Button size="sm" className="h-8" onClick={handleSave} disabled={saving || !inputVal.trim()} data-testid="button-save-lodgify-id">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => { setEditing(false); setInputVal(""); }}>Cancel</Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-3">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => { setEditing(true); setInputVal(lodgifyId ?? ""); }}
                data-testid="button-edit-lodgify-id"
              >
                {lodgifyId ? "Change ID" : "Enter Lodgify ID"}
              </Button>
              {lodgifyId && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={handleClear}
                  disabled={saving}
                  data-testid="button-clear-lodgify-id"
                >
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function LodgifyEntryGuide() {
  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <ClipboardList className="h-4 w-4" />
        Step-by-Step Lodgify Entry Guide
      </h3>
      <div className="space-y-3">
        {[
          {
            step: 1,
            title: "Create New Property",
            desc: "In Lodgify, go to Properties and click 'Add Property'. Choose 'Apartment' or 'Condo' as the property type.",
          },
          {
            step: 2,
            title: "Set Property Name",
            desc: "Use the Booking Title above as the property name in Lodgify.",
          },
          {
            step: 3,
            title: "Add Description",
            desc: "Go to the Description section. Copy the Combined Property Description above and paste it as the main listing text. This single description covers all units in the listing.",
          },
          {
            step: 4,
            title: "Configure Rooms",
            desc: "Set the number of bedrooms, bathrooms, and max guests. Add bed types for each room using the Room Configuration info.",
          },
          {
            step: 5,
            title: "Select Amenities",
            desc: "Go to Rental Amenities. Use the checklist in the Amenities tab to check off each amenity. Categories match Lodgify's layout.",
          },
          {
            step: 6,
            title: "Upload Photos",
            desc: "Click 'Download Photos to Folder' to save all photos in order. Then drag and drop the entire folder into Lodgify's photo upload area. The first photo (marked 'Main') should be set as the cover image.",
          },
          {
            step: 7,
            title: "Set Location & Pricing",
            desc: "Add the property address, set your nightly rates, cleaning fees, and minimum stay requirements.",
          },
          {
            step: 8,
            title: "Publish",
            desc: "Review all details, then activate the listing. Connect to channels (Airbnb, VRBO, Booking.com) if desired.",
          },
        ].map((item) => (
          <div key={item.step} className="flex gap-3" data-testid={`guide-step-${item.step}`}>
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
              {item.step}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PricingSummaryCard({ pricing }: { pricing: PropertyPricing }) {
  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <DollarSign className="h-4 w-4" />
        Buy-In & Sell Rate Summary
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        Average Airbnb buy-in rate (including taxes & fees) marked up 20%.
      </p>

      <div className="space-y-3">
        {pricing.units.map((unit) => (
          <div key={unit.unitId} className="flex items-center justify-between gap-4 py-2 border-b last:border-b-0" data-testid={`pricing-unit-${unit.unitId}`}>
            <div className="min-w-0">
              <p className="text-sm font-medium">{unit.unitLabel}</p>
              <p className="text-xs text-muted-foreground">{unit.bedrooms}BR in {unit.community}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-xs text-muted-foreground">Buy-in: ${unit.baseBuyIn}/night</p>
              <p className="text-sm font-bold text-green-700 dark:text-green-400">Sell: ${unit.baseSellRate}/night</p>
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between gap-4 pt-2 border-t-2">
          <div>
            <p className="text-sm font-bold">Combined Total</p>
            <p className="text-xs text-muted-foreground">{pricing.units.length} units</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Buy-in: ${pricing.totalBaseBuyIn}/night</p>
            <p className="text-base font-bold text-green-700 dark:text-green-400">Sell: ${pricing.totalBaseSellRate}/night</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

function SeasonalityTable({ pricing }: { pricing: PropertyPricing }) {
  const months = pricing.units[0]?.monthlyRates || [];

  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <TrendingUp className="h-4 w-4" />
        24-Month Rate Schedule (Feb 2026 - Jan 2028)
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        Seasonal rates based on Hawaii vacation rental demand patterns. High season: Dec-Mar & Jul-Aug. Low season: Sep-Nov.
      </p>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-background z-10 min-w-[120px]">Month</TableHead>
              <TableHead className="min-w-[70px]">Season</TableHead>
              {pricing.units.map((unit) => (
                <TableHead key={`buy-${unit.unitId}`} className="min-w-[100px] text-right">
                  {unit.unitLabel} Buy-In
                </TableHead>
              ))}
              {pricing.units.map((unit) => (
                <TableHead key={`sell-${unit.unitId}`} className="min-w-[100px] text-right">
                  {unit.unitLabel} Sell
                </TableHead>
              ))}
              <TableHead className="min-w-[100px] text-right">Total Buy-In</TableHead>
              <TableHead className="min-w-[100px] text-right font-bold">Total Sell</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.map((monthData, idx) => {
              const totalBuyIn = pricing.units.reduce((sum, u) => sum + u.monthlyRates[idx].buyInRate, 0);
              const totalSell = pricing.units.reduce((sum, u) => sum + u.monthlyRates[idx].sellRate, 0);

              return (
                <TableRow key={`${monthData.month}-${monthData.year}`} data-testid={`rate-row-${idx}`}>
                  <TableCell className="sticky left-0 bg-background z-10 font-medium text-sm">
                    {monthData.month} {monthData.year}
                  </TableCell>
                  <TableCell>
                    <Badge variant={getSeasonBadgeVariant(monthData.season)} className="text-xs">
                      {getSeasonLabel(monthData.season)}
                    </Badge>
                  </TableCell>
                  {pricing.units.map((unit) => (
                    <TableCell key={`buy-${unit.unitId}`} className="text-right text-sm text-muted-foreground">
                      ${unit.monthlyRates[idx].buyInRate}
                    </TableCell>
                  ))}
                  {pricing.units.map((unit) => (
                    <TableCell key={`sell-${unit.unitId}`} className="text-right text-sm font-medium">
                      ${unit.monthlyRates[idx].sellRate}
                    </TableCell>
                  ))}
                  <TableCell className="text-right text-sm text-muted-foreground">
                    ${totalBuyIn}
                  </TableCell>
                  <TableCell className="text-right text-sm font-bold text-green-700 dark:text-green-400">
                    ${totalSell}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function PushRatesToLodgify({ pricing }: { pricing: PropertyPricing }) {
  const [lodgifyId, setLodgifyId] = useState("");
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const combinedRates = pricing.units[0]?.monthlyRates.map((rate, idx) => {
    const totalSell = pricing.units.reduce((sum, u) => sum + u.monthlyRates[idx].sellRate, 0);
    return {
      month: rate.month,
      year: rate.year,
      sellRate: totalSell,
      season: rate.season,
      minStay: rate.season === "HIGH" ? 7 : 5,
    };
  }) || [];

  const handlePush = async () => {
    if (!lodgifyId.trim()) return;

    setPushing(true);
    setResult(null);

    try {
      const response = await apiRequest("POST", "/api/lodgify/push-rates", {
        lodgifyPropertyId: lodgifyId.trim(),
        rates: combinedRates,
      });

      const data = await response.json();

      if (data.success) {
        const roomSummary = data.results?.map((r: any) => `"${r.roomTypeName}" (${r.rateEntriesSubmitted} months)`).join(", ") || "";
        setResult({
          success: true,
          message: `Rates pushed to Lodgify property ${lodgifyId}. ${data.roomTypesProcessed} room type(s) updated: ${roomSummary}.`,
        });
      } else {
        const failedResults = data.results?.filter((r: any) => !r.success) || [];
        const hasExternalRatesError = failedResults.some((r: any) => r.error?.code === 940 || r.httpStatus === 406);
        if (hasExternalRatesError) {
          setResult({
            success: false,
            message: `This Lodgify property doesn't have "External Rates" enabled. Go to your Lodgify account > Settings > External Rates and enable it for this property, then try again.`,
          });
        } else {
          const failedRooms = failedResults.map((r: any) => r.roomTypeName).join(", ") || "";
          setResult({
            success: false,
            message: data.error || `Some room types failed: ${failedRooms}`,
          });
        }
      }
    } catch (err: any) {
      let errorMsg = "Failed to push rates to Lodgify";
      try {
        const errData = JSON.parse(err.message || "{}");
        errorMsg = errData.error || errData.message || errorMsg;
      } catch {
        if (err.message) errorMsg = err.message;
      }
      setResult({ success: false, message: errorMsg });
    } finally {
      setPushing(false);
    }
  };

  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <Upload className="h-4 w-4" />
        Push Rates to Lodgify
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        Enter your Lodgify property ID and push the current 24-month sell rates directly to Lodgify. This sets nightly rates for each month based on the seasonal schedule above.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Lodgify Property ID
          </label>
          <Input
            type="text"
            placeholder="e.g. 766525"
            value={lodgifyId}
            onChange={(e) => setLodgifyId(e.target.value)}
            data-testid="input-lodgify-property-id"
          />
        </div>
        <Button
          onClick={handlePush}
          disabled={!lodgifyId.trim() || pushing}
          data-testid="button-push-rates"
        >
          {pushing ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Upload className="h-4 w-4 mr-2" />
          )}
          {pushing ? "Pushing..." : "Push Rates to Lodgify"}
        </Button>
      </div>

      {result && (
        <div
          className={`flex items-start gap-2 p-3 rounded-md text-sm ${
            result.success
              ? "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300"
              : "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300"
          }`}
          data-testid="text-push-result"
        >
          {result.success ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          )}
          <span>{result.message}</span>
        </div>
      )}

      <div className="mt-3 text-xs text-muted-foreground">
        <p>Combined nightly sell rate being pushed: ${combinedRates[0]?.sellRate || 0} - ${combinedRates[combinedRates.length - 1]?.sellRate || 0}/night (varies by season)</p>
        <p className="mt-1">Minimum stay: 7 nights (high season), 5 nights (mid/low season)</p>
      </div>
    </Card>
  );
}

function getAverageSqft(property: PropertyUnitBuilder): string {
  const nums = property.units.map((u) => {
    const n = parseInt(u.sqft.replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }).filter((n) => n > 0);
  if (nums.length === 0) return "N/A";
  const avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  return `~${avg.toLocaleString()} sq ft`;
}

export default function LodgifyPrep() {
  const params = useParams<{ id: string }>();
  const propertyId = parseInt(params.id || "0", 10);
  const property = getUnitBuilderByPropertyId(propertyId);
  const pricing = getPropertyPricing(propertyId);

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
            <p className="text-muted-foreground mt-2">No data exists for this property.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="button-back-dashboard">
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Dashboard
            </Button>
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <Link href={`/unit-builder/${propertyId}`}>
            <Button variant="ghost" size="sm" data-testid="button-back-unit-builder">
              Unit Builder
            </Button>
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Prepare for Lodgify</span>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
            Prepare for Lodgify
          </h1>
          <p className="text-muted-foreground mt-1">
            {property.propertyName} - {property.complexName}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <div className="lg:col-span-2">
            <LodgifySyncStatus propertyId={propertyId} />
          </div>
          <div className="space-y-4">
            <CopyField label="Property Address" value={property.address} />
            <CopyField label="Average Square Footage" value={getAverageSqft(property)} />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div className="lg:col-span-2">
            <CopyField label="Booking Title" value={property.bookingTitle} />
          </div>
          <LodgifyEntryGuide />
        </div>

        <div className="mb-6">
          <CopyField label="Combined Property Description (copy into Lodgify)" value={LISTING_DISCLOSURE + "\n\n" + property.combinedDescription} multiline />
        </div>

        {pricing && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
              <PricingSummaryCard pricing={pricing} />
              <div className="lg:col-span-2">
                <SeasonalityTable pricing={pricing} />
              </div>
            </div>
            <div className="mb-6">
              <PushRatesToLodgify pricing={pricing} />
            </div>
          </>
        )}

        <div className="mb-6">
          <CommunityPhotosSection property={property} />
        </div>

        <div className="space-y-6">
          {property.units.map((unit) => (
            <UnitPrepCard
              key={unit.id}
              unit={unit}
              complexName={property.complexName}
              propertyId={propertyId}
              communityPhotos={property.communityPhotos}
              communityPhotoFolder={property.communityPhotoFolder}
            />
          ))}
        </div>

        <div className="mt-6 text-xs text-muted-foreground text-center">
          Data prepared for manual entry into Lodgify. Use copy buttons to transfer each field.
        </div>
      </div>
    </div>
  );
}
