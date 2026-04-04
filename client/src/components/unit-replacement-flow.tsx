import { useState } from "react";
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Home,
  ExternalLink,
  Search as SearchIcon,
  Repeat2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";

export type UnitStub = { id: string; unitNumber: string; bedrooms: number };

export type ReplacementUnitData = {
  url: string;
  address: string;
  unitLabel: string;
  bedrooms: number | null;
  source: string;
  photos: { url: string; label: string }[];
};

export function UnitReplacementFlow({
  unit,
  allUnits,
  communityFolder,
  propertyId,
  onClose,
  onUnitReplaced,
}: {
  unit: UnitStub;
  allUnits: UnitStub[];
  communityFolder: string;
  propertyId: number;
  onClose?: () => void;
  onUnitReplaced?: (oldUnitId: string, newUnit: ReplacementUnitData, swapId: number) => void;
}) {
  const [selectedUnitId, setSelectedUnitId] = useState(unit.id);
  const [stage, setStage] = useState<"idle" | "searching" | "checking" | "found" | "replacing" | "error">("idle");
  const [result, setResult] = useState<ReplacementUnitData | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  const selectedUnit = allUnits.find(u => u.id === selectedUnitId) || unit;

  async function search() {
    setResult(null);
    setSwapError(null);
    setStage("searching");
    setTimeout(() => setStage("checking"), 2000);
    try {
      const resp = await apiRequest("POST", "/api/replacement/find-unit", {
        communityFolder,
        requiredBedrooms: selectedUnit.bedrooms,
        skipUrls: [],
      });
      const data = await resp.json();
      if (data.error) {
        setStage("error");
        setResult(null);
        setSwapError(data.error);
      } else {
        setStage("found");
        setResult(data.unit);
      }
    } catch {
      setStage("error");
      setSwapError("Failed to connect. Please try again.");
    }
  }

  async function handleReplaceUnit() {
    if (!result) return;
    setStage("replacing");
    setSwapError(null);
    try {
      const resp = await apiRequest("POST", "/api/unit-swaps", {
        propertyId,
        communityFolder,
        oldUnitId: selectedUnit.id,
        oldUnitNumber: selectedUnit.unitNumber,
        oldBedrooms: selectedUnit.bedrooms,
        newAddress: result.address,
        newUnitLabel: result.unitLabel,
        newBedrooms: result.bedrooms,
        newSourceUrl: result.url,
        thumbnailUrl: result.photos[0]?.url || null,
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Failed to record unit swap");
      }
      const data = await resp.json();
      const swapId: number = data?.swap?.id ?? 0;
      // Notify parent to apply the replacement and re-run the platform check
      onUnitReplaced?.(selectedUnit.id, result, swapId);
      onClose?.();
    } catch (err: any) {
      setSwapError(err?.message || "Failed to record swap. Please try again.");
      setStage("found");
    }
  }

  const steps = ["Search Zillow", "Check Airbnb", "Confirm Clean"];
  const stepDone = stage === "checking"
    ? [true, false, false]
    : (stage === "found" || stage === "replacing")
      ? [true, true, true]
      : [false, false, false];
  const stepActive = stage === "searching"
    ? [true, false, false]
    : stage === "checking"
      ? [false, true, false]
      : [false, false, false];

  return (
    <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Find a New Unit
        </p>
        {onClose && (
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onClose} data-testid="button-close-replacement-flow">
            <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        )}
      </div>

      {/* Unit selector + search */}
      {(stage === "idle" || stage === "searching" || stage === "checking") && (
        <>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Which unit would you like to replace?</p>
            <Select value={selectedUnitId} onValueChange={setSelectedUnitId} disabled={stage !== "idle"}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-replacement-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allUnits.map(u => (
                  <SelectItem key={u.id} value={u.id} className="text-xs">
                    Unit #{u.unitNumber} — {u.bedrooms} BR
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {stage === "idle" && (
            <Button size="sm" className="w-full" onClick={search} data-testid="button-start-unit-search">
              <SearchIcon className="h-3.5 w-3.5 mr-1.5" />
              Find Replacement Unit
            </Button>
          )}

          {(stage === "searching" || stage === "checking") && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span>
                  {stage === "searching" ? "Searching Zillow & Homes.com…" : "Checking Airbnb for conflicts…"}
                </span>
              </div>
              <div className="flex gap-1.5">
                {steps.map((label, i) => (
                  <div
                    key={label}
                    className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${
                      stepDone[i]
                        ? "border-green-400 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30"
                        : stepActive[i]
                          ? "border-primary text-primary"
                          : "border-border text-muted-foreground"
                    }`}
                  >
                    {stepDone[i]
                      ? <CheckCircle2 className="h-2.5 w-2.5" />
                      : stepActive[i]
                        ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        : <div className="h-2.5 w-2.5 rounded-full border border-current opacity-40" />}
                    {label}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Error state */}
      {stage === "error" && (
        <div className="space-y-2">
          <p className="text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
            <XCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            {swapError || "Search failed. Please try again."}
          </p>
          <Button size="sm" variant="outline" onClick={() => { setStage("idle"); setSwapError(null); }} data-testid="button-retry-unit-search">
            Try Again
          </Button>
        </div>
      )}

      {/* Found unit — confirm replacement */}
      {(stage === "found" || stage === "replacing") && result && (
        <div className="space-y-2.5">
          <p className="text-xs font-medium text-green-700 dark:text-green-400 flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Clean replacement found — not on Airbnb
          </p>
          <div className="rounded border border-border bg-background px-3 py-2.5 space-y-2">
            <div className="flex items-start gap-2">
              <Home className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold leading-snug">{result.unitLabel}</p>
                <p className="text-[11px] text-muted-foreground leading-snug">{result.address}</p>
                <p className="text-[11px] text-muted-foreground">Source: {result.source}</p>
                {result.bedrooms && (
                  <p className="text-[11px] text-muted-foreground">
                    {result.bedrooms} Bedroom{result.bedrooms > 1 ? "s" : ""}
                  </p>
                )}
              </div>
            </div>
            {result.photos.length > 0 && (
              <div className="grid grid-cols-6 gap-1">
                {result.photos.map((photo, i) => (
                  <div key={i} className="aspect-square rounded overflow-hidden border border-border">
                    <img
                      src={photo.url}
                      alt={photo.label}
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  </div>
                ))}
              </div>
            )}
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-primary hover:underline flex items-center gap-1"
              data-testid="link-replacement-unit-source"
            >
              View on {result.source}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </div>

          {/* What will change */}
          <div className="rounded bg-muted/50 border border-border px-2.5 py-2 text-[11px] text-muted-foreground space-y-0.5">
            <p className="font-medium text-foreground text-xs mb-1">What this replaces:</p>
            <p><span className="line-through text-muted-foreground">Unit #{selectedUnit.unitNumber} ({selectedUnit.bedrooms} BR)</span> → <span className="font-medium text-foreground">{result.unitLabel} ({result.bedrooms ?? selectedUnit.bedrooms} BR)</span></p>
            <p className="text-[10px]">Address, unit number, bedroom count, and photo source will all update. Platform check will re-run automatically.</p>
          </div>

          {swapError && (
            <p className="text-[11px] text-red-600 dark:text-red-400">{swapError}</p>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleReplaceUnit}
              className="flex-1"
              disabled={stage === "replacing"}
              data-testid="button-push-to-builder"
            >
              {stage === "replacing" ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Replacing…</>
              ) : (
                <><Repeat2 className="h-3.5 w-3.5 mr-1.5" />Yes, Replace Unit</>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={stage === "replacing"}
              onClick={() => { setStage("idle"); setResult(null); setSwapError(null); }}
              data-testid="button-try-another-unit"
            >
              Try Another
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
