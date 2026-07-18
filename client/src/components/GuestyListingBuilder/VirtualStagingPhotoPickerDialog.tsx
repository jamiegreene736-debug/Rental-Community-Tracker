import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ImageOff, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import type {
  VirtualStagingSourceChoiceDto,
  VirtualStagingSourceChoicesDto,
} from "@shared/virtual-staging";

import type { VirtualStagingUnit } from "./VirtualStagingDialog";

type VirtualStagingPhotoPickerDialogProps = {
  open: boolean;
  propertyId: number;
  unit: VirtualStagingUnit;
  onOpenChange: (open: boolean) => void;
  onStart: (selectedOriginalFilenames: string[]) => void;
  onResume: (jobId: string) => void;
  returnFocusElement?: HTMLElement | null;
  returnFocusFallbackElement?: HTMLElement | null;
};

function choicesFromPayload(payload: unknown): VirtualStagingSourceChoicesDto {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The virtual-staging service returned an invalid photo inventory.");
  }
  const value = payload as Partial<VirtualStagingSourceChoicesDto>;
  if (
    typeof value.propertyId !== "number"
    || typeof value.unitId !== "string"
    || typeof value.unitLabel !== "string"
    || typeof value.totalVisible !== "number"
    || typeof value.excludedCount !== "number"
    || (value.resumableJobId !== null && typeof value.resumableJobId !== "string")
    || !Array.isArray(value.photos)
  ) {
    throw new Error("The virtual-staging service returned an incomplete photo inventory.");
  }
  for (const photo of value.photos) {
    if (
      !photo
      || typeof photo !== "object"
      || typeof photo.originalFilename !== "string"
      || typeof photo.previewUrl !== "string"
      || typeof photo.roomLabel !== "string"
      || typeof photo.scene !== "string"
      || (photo.placement !== "indoor" && photo.placement !== "outdoor")
    ) {
      throw new Error("The virtual-staging service returned an invalid photo choice.");
    }
  }
  return value as VirtualStagingSourceChoicesDto;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function photoTestId(photo: Pick<VirtualStagingSourceChoiceDto, "originalFilename">): string {
  return `toggle-restage-source-${photo.originalFilename.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export default function VirtualStagingPhotoPickerDialog({
  open,
  propertyId,
  unit,
  onOpenChange,
  onStart,
  onResume,
  returnFocusElement,
  returnFocusFallbackElement,
}: VirtualStagingPhotoPickerDialogProps) {
  const [choices, setChoices] = useState<VirtualStagingSourceChoicesDto | null>(null);
  const [selectedFilenames, setSelectedFilenames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const [brokenPreviews, setBrokenPreviews] = useState<Set<string>>(new Set());
  const requestVersionRef = useRef(0);
  const transitionToReviewRef = useRef(false);
  const startGuardRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const requestVersion = ++requestVersionRef.current;
    transitionToReviewRef.current = false;
    startGuardRef.current = false;
    setChoices(null);
    setSelectedFilenames(new Set());
    setBrokenPreviews(new Set());
    setLoading(true);
    setLoadError(null);

    void apiRequest(
      "GET",
      `/api/virtual-staging/units/${encodeURIComponent(String(propertyId))}/${encodeURIComponent(unit.id)}/sources`,
    )
      .then((response) => response.json())
      .then((payload: unknown) => {
        if (requestVersionRef.current !== requestVersion) return;
        const nextChoices = choicesFromPayload(payload);
        if (nextChoices.propertyId !== propertyId || nextChoices.unitId !== unit.id) {
          throw new Error("The photo inventory no longer matches this property and unit.");
        }
        if (nextChoices.resumableJobId) {
          transitionToReviewRef.current = true;
          startGuardRef.current = true;
          onResume(nextChoices.resumableJobId);
          return;
        }
        setChoices(nextChoices);
        setSelectedFilenames(new Set(nextChoices.photos.map((photo) => photo.originalFilename)));
      })
      .catch((error: unknown) => {
        if (requestVersionRef.current === requestVersion) {
          setLoadError(errorMessage(error));
        }
      })
      .finally(() => {
        if (requestVersionRef.current === requestVersion) setLoading(false);
      });

    return () => {
      if (requestVersionRef.current === requestVersion) ++requestVersionRef.current;
    };
  }, [onResume, open, propertyId, reloadAttempt, unit.id]);

  const selectedPhotos = useMemo(
    () => choices?.photos.filter((photo) => selectedFilenames.has(photo.originalFilename)) ?? [],
    [choices?.photos, selectedFilenames],
  );
  const allSelected = !!choices?.photos.length && selectedPhotos.length === choices.photos.length;

  const togglePhoto = useCallback((filename: string) => {
    setSelectedFilenames((current) => {
      const next = new Set(current);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }, []);

  const startSelected = () => {
    if (startGuardRef.current || loading || selectedPhotos.length === 0) return;
    startGuardRef.current = true;
    transitionToReviewRef.current = true;
    onStart(selectedPhotos.map((photo) => photo.originalFilename));
  };

  const selectionSummary = choices
    ? `${selectedPhotos.length} of ${choices.photos.length} eligible photos selected`
    : `Loading ${unit.label}'s eligible photos`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,1100px)] max-w-5xl flex-col overflow-hidden p-0"
        data-testid="virtual-staging-photo-picker"
        aria-busy={loading}
        onCloseAutoFocus={(event) => {
          if (transitionToReviewRef.current) {
            event.preventDefault();
            return;
          }
          const triggerDisabled = returnFocusElement instanceof HTMLButtonElement && returnFocusElement.disabled;
          const focusTarget = triggerDisabled ? returnFocusFallbackElement : returnFocusElement;
          if (!focusTarget) return;
          event.preventDefault();
          focusTarget.focus();
        }}
      >
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-14">
          <DialogTitle>Select photos to restage — {unit.label}</DialogTitle>
          <DialogDescription>
            Only furnished rooms and private patios are eligible. Beach, view, exterior, pool, and shared-amenity photos are excluded.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin" /> Checking eligible {unit.label} photos…
            </div>
          )}

          {loadError && !loading && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4" role="alert">
              <p className="font-medium text-destructive">The photo picker could not load.</p>
              <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={() => setReloadAttempt((attempt) => attempt + 1)}
                data-testid="button-retry-restage-picker"
              >
                <RefreshCw /> Try again
              </Button>
            </div>
          )}

          {choices && !loading && (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
                <div>
                  <p className="text-sm font-medium" role="status" aria-live="polite" data-testid="restage-picker-selection-count">
                    {selectionSummary}
                  </p>
                  {choices.excludedCount > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {choices.excludedCount} of {choices.totalVisible} visible {unit.label} photos are intentionally excluded as non-stageable.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={choices.photos.length === 0 || allSelected}
                    onClick={() => setSelectedFilenames(new Set(choices.photos.map((photo) => photo.originalFilename)))}
                    data-testid="button-select-all-restage-sources"
                  >
                    Select all eligible
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={selectedPhotos.length === 0}
                    onClick={() => setSelectedFilenames(new Set())}
                    data-testid="button-clear-restage-sources"
                  >
                    Clear all
                  </Button>
                </div>
              </div>

              {choices.photos.length === 0 ? (
                <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                  No furnished room or private patio photos are currently eligible for {unit.label}.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {choices.photos.map((photo, index) => {
                    const selected = selectedFilenames.has(photo.originalFilename);
                    const label = photo.roomLabel.trim() || photo.originalFilename;
                    const previewBroken = brokenPreviews.has(photo.originalFilename);
                    return (
                      <button
                        key={photo.originalFilename}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`${selected ? "Deselect" : "Select"} photo ${index + 1}, ${label}, ${photo.originalFilename}, for virtual staging`}
                        className={`group relative overflow-hidden rounded-lg border bg-card text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          selected ? "border-violet-600 ring-2 ring-violet-200" : "hover:border-violet-300"
                        }`}
                        onClick={() => togglePhoto(photo.originalFilename)}
                        data-testid={photoTestId(photo)}
                      >
                        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/40">
                          {previewBroken ? (
                            <div className="flex flex-col items-center gap-2 px-3 text-center text-xs text-muted-foreground">
                              <ImageOff className="h-5 w-5" /> Preview unavailable
                            </div>
                          ) : (
                            <img
                              src={photo.previewUrl}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                              onError={() => setBrokenPreviews((current) => new Set(current).add(photo.originalFilename))}
                            />
                          )}
                        </div>
                        <div className="p-3">
                          <p className="truncate text-sm font-medium" title={label}>{label}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={photo.originalFilename}>
                            {photo.placement === "outdoor" ? "Private outdoor space" : "Indoor room"}
                          </p>
                        </div>
                        <span
                          aria-hidden="true"
                          className={`absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border shadow-sm ${
                            selected
                              ? "border-violet-700 bg-violet-700 text-white"
                              : "border-white/80 bg-white/90 text-transparent"
                          }`}
                        >
                          <Check className="h-4 w-4" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 items-center gap-3 border-t bg-background px-6 py-4 sm:justify-between sm:space-x-0">
          <p className="text-xs text-muted-foreground">
            Generation starts only after you confirm this selection. Originals remain preserved.
          </p>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={loading || !!loadError || selectedPhotos.length === 0}
              onClick={startSelected}
              data-testid="button-start-selected-restaging"
            >
              {`Restage ${selectedPhotos.length} ${selectedPhotos.length === 1 ? "Photo" : "Photos"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
