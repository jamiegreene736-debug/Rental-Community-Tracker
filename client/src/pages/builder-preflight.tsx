import { useState, useEffect, useRef, Fragment } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  ArrowRight,
  RotateCcw,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  Camera,
  Search,
} from "lucide-react";
import { getUnitBuilderByPropertyId, type PropertyUnitBuilder } from "@/data/unit-builder-data";
import { apiRequest } from "@/lib/queryClient";
import type { CommunityDraft } from "@shared/schema";
import { UnitReplacementFlow, type ReplacementUnitData } from "@/components/unit-replacement-flow";
import { useToast } from "@/hooks/use-toast";

// ── Types ─────────────────────────────────────────────────────────────────────

type UnitPlatformResult = {
  status: "confirmed" | "photo-confirmed" | "photo-only" | "unconfirmed" | "not-listed" | "error";
  url: string | null;
  detection: string;
};

type UnitCheckResult = {
  unitId: string;
  unitNumber: string;
  address: string;
  platforms: {
    airbnb: UnitPlatformResult;
    vrbo: UnitPlatformResult;
    booking: UnitPlatformResult;
  };
};

// Maps unitId → per-platform result (populated progressively as checks complete)
type ProgressiveResults = Record<string, UnitCheckResult>;

// A swapped unit's effective display data
type UnitOverride = {
  unitNumber: string;
  address: string;
  bedrooms: number;
  unitLabel: string;
  sourceUrl: string;
  swapId?: number;
};

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({
  result,
  checking,
}: {
  result: UnitPlatformResult | undefined;
  checking: boolean;
}) {
  if (checking || !result) {
    return (
      <span className="status-checking inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-muted text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking…
      </span>
    );
  }
  switch (result.status) {
    case "confirmed":
      return (
        <span className="status-confirmed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
          <CheckCircle2 className="h-3 w-3" /> Yes — Listed (title confirmed)
        </span>
      );
    case "photo-confirmed":
      return (
        <span className="status-photo-confirmed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
          <CheckCircle2 className="h-3 w-3" /> Yes — Listed (photos confirmed)
        </span>
      );
    case "photo-only":
      return (
        <span className="status-photo-only inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300">
          <AlertTriangle className="h-3 w-3" /> Likely Listed — Found via photos only
        </span>
      );
    case "unconfirmed":
      return (
        <span className="status-unconfirmed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
          <AlertTriangle className="h-3 w-3" /> Possible Match — Check Manually
        </span>
      );
    case "not-listed":
      return (
        <span className="status-not-listed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">
          <XCircle className="h-3 w-3" /> Not Found — Likely Safe to Use
        </span>
      );
    default:
      return (
        <span className="status-error inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
          <AlertTriangle className="h-3 w-3" /> Could not verify
        </span>
      );
  }
}

// Whether a status is "listed" (should suggest replacing the unit)
function isListedStatus(status: UnitPlatformResult["status"]) {
  return status === "confirmed" || status === "photo-confirmed" || status === "photo-only";
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_LIST: { key: keyof UnitCheckResult["platforms"]; label: string }[] = [
  { key: "airbnb",  label: "Airbnb" },
  { key: "vrbo",    label: "VRBO" },
  { key: "booking", label: "Booking.com" },
];

// Adapt a CommunityDraft (the AI-generated rich shape from the
// Add a New Community wizard) into the PropertyUnitBuilder shape
// the rest of the builder/preflight code expects. Promoted drafts
// take this path because they don't (yet) live in the static
// `unit-builder-data.ts` array; this adapter lets the existing
// builder UI render against draft data without a code-side
// migration. Photos and Guesty wiring still come up empty for
// promoted drafts (those are operations that happen AFTER the
// draft is fully realized as a property), but the descriptive
// fields all flow through.
function adaptDraftToPropertyUnitBuilder(draft: CommunityDraft): PropertyUnitBuilder {
  const u1Br = draft.unit1Bedrooms ?? 2;
  const u2Br = draft.unit2Bedrooms ?? 2;
  const blank = "";
  return {
    propertyId: -draft.id, // matches the synthetic negative id the dashboard uses
    propertyName: draft.listingTitle || draft.name,
    complexName: draft.name,
    address: `${draft.city}, ${draft.state}`,
    bookingTitle: draft.bookingTitle || draft.listingTitle || draft.name,
    sampleDisclaimer: blank,
    combinedDescription: draft.listingDescription ?? blank,
    propertyType: draft.propertyType ?? "Condominium",
    neighborhood: draft.neighborhood ?? blank,
    transit: draft.transit ?? blank,
    taxMapKey: blank,
    tatLicense: blank,
    getLicense: blank,
    strPermit: draft.strPermit ?? blank,
    hasPhotos: false,
    communityPhotos: [],
    communityPhotoFolder: blank,
    units: [
      {
        id: `draft${draft.id}-unit-a`,
        unitNumber: "A",
        bedrooms: u1Br,
        bathrooms: draft.unit1Bathrooms ?? "",
        sqft: draft.unit1Sqft ?? "",
        maxGuests: draft.unit1MaxGuests ?? u1Br * 2,
        shortDescription: draft.unit1ShortDescription ?? "",
        longDescription: draft.unit1LongDescription ?? "",
        photoFolder: "",
        photos: [],
      },
      {
        id: `draft${draft.id}-unit-b`,
        unitNumber: "B",
        bedrooms: u2Br,
        bathrooms: draft.unit2Bathrooms ?? "",
        sqft: draft.unit2Sqft ?? "",
        maxGuests: draft.unit2MaxGuests ?? u2Br * 2,
        shortDescription: draft.unit2ShortDescription ?? "",
        longDescription: draft.unit2LongDescription ?? "",
        photoFolder: "",
        photos: [],
      },
    ],
  } as PropertyUnitBuilder;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function BuilderPreflight() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const [, setLocation] = useLocation();
  const id = parseInt(propertyId || "0", 10);
  const staticProperty = getUnitBuilderByPropertyId(id);

  // Draft fallback: when the static lookup misses AND the id is
  // negative (the convention the dashboard uses for promoted
  // drafts: -draftId), fetch /api/community/drafts and adapt the
  // matching draft to PropertyUnitBuilder shape. Lets the builder
  // operate on promoted drafts without migrating them into the
  // static unitBuilderData array.
  const [draftProperty, setDraftProperty] = useState<PropertyUnitBuilder | null>(null);
  const [draftLoading, setDraftLoading] = useState<boolean>(!staticProperty && id < 0);
  useEffect(() => {
    if (staticProperty || id >= 0) return;
    const draftId = -id;
    setDraftLoading(true);
    apiRequest("GET", "/api/community/drafts")
      .then((r) => r.json() as Promise<CommunityDraft[]>)
      .then((drafts) => {
        const match = drafts.find((d) => d.id === draftId);
        if (match) setDraftProperty(adaptDraftToPropertyUnitBuilder(match));
      })
      .catch(() => { /* leave draftProperty null → renders the not-found state */ })
      .finally(() => setDraftLoading(false));
  }, [id, staticProperty]);
  const property = staticProperty ?? draftProperty;

  const { toast } = useToast();

  // Per-row rescrape state so each row can show its own spinner/result.
  const [rescrapingUnitId, setRescrapingUnitId] = useState<string | null>(null);

  // Sticky rescrape results — persisted to localStorage so the user can
  // navigate away and come back and still see when they last rescraped a
  // folder + how many bedrooms/bathrooms came back. Keyed by folder so
  // multiple swaps for the same property each remember their own state.
  type RescrapeReceipt = {
    folder: string;
    timestamp: number;       // ms epoch
    savedCount: number;
    bedroomCount: number;
    bathroomCount: number;
    sourceUrl?: string;
    urlSource?: string;      // "supplied" | "_source.json" | "unit_swap" | "community_map"
  };
  const RESCRAPE_RECEIPTS_KEY = "preflight.rescrapeReceipts.v1";
  const loadReceipts = (): Record<string, RescrapeReceipt> => {
    try {
      const raw = localStorage.getItem(RESCRAPE_RECEIPTS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  };
  const saveReceipts = (next: Record<string, RescrapeReceipt>) => {
    try { localStorage.setItem(RESCRAPE_RECEIPTS_KEY, JSON.stringify(next)); } catch {}
  };
  const [rescrapeReceipts, setRescrapeReceipts] = useState<Record<string, RescrapeReceipt>>(() => loadReceipts());
  const recordRescrape = (folder: string, data: RescrapeReceipt) => {
    setRescrapeReceipts((prev) => {
      const next = { ...prev, [folder]: data };
      saveReceipts(next);
      return next;
    });
  };
  const dismissReceipt = (folder: string) => {
    setRescrapeReceipts((prev) => {
      const next = { ...prev };
      delete next[folder];
      saveReceipts(next);
      return next;
    });
  };
  // Tick every 30s so the relative timestamps ("2m ago") stay fresh.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const fmtRelative = (ts: number): string => {
    const diff = nowTick - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  };

  const [platformChecking, setPlatformChecking] = useState(false);
  // Track which unit IDs are still being checked (for per-row spinner)
  const [checkingUnitIds, setCheckingUnitIds] = useState<Set<string>>(new Set());
  const [completedCount, setCompletedCount] = useState(0);
  const [totalUnits, setTotalUnits] = useState(0);
  const [checkPhase, setCheckPhase] = useState<"text" | "photo" | "done" | null>(null);
  const [results, setResults] = useState<ProgressiveResults>({});
  const [platformDone, setPlatformDone] = useState(false);
  const [showReplacementFlow, setShowReplacementFlow] = useState(false);
  const [replacementTargetId, setReplacementTargetId] = useState<string | null>(null);
  const [swapsCommitted, setSwapsCommitted] = useState(false);
  const [committing, setCommitting] = useState(false);
  const autoRunFired = useRef(false);

  // Maps old unit ID → replacement unit data
  const [unitOverrides, setUnitOverrides] = useState<Record<string, UnitOverride>>({});

  // Load any previously saved unit swaps from the DB on mount
  useEffect(() => {
    if (!id) return;
    fetch(`/api/unit-swaps/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { swaps: any[] } | null) => {
        if (!data?.swaps?.length) {
          // No saved swaps — auto-run the platform check immediately
          if (!autoRunFired.current && property) {
            autoRunFired.current = true;
            runPlatformCheck();
          }
          return;
        }
        const restored: Record<string, UnitOverride> = {};
        let allCommitted = true;
        for (const swap of data.swaps) {
          restored[swap.oldUnitId] = {
            unitNumber: swap.newUnitLabel.replace(/^Unit\s*#?/i, "").trim(),
            address: swap.newAddress,
            bedrooms: swap.newBedrooms ?? 1,
            unitLabel: swap.newUnitLabel,
            sourceUrl: swap.newSourceUrl,
            swapId: swap.id,
          };
          if (!swap.committed) allCommitted = false;
        }
        setUnitOverrides(restored);
        setSwapsCommitted(allCommitted);
      })
      .catch(() => {
        // On error, still auto-run
        if (!autoRunFired.current && property) {
          autoRunFired.current = true;
          runPlatformCheck();
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const commitAndContinue = async () => {
    setCommitting(true);
    try {
      await fetch(`/api/unit-swaps/commit/${id}`, { method: "PATCH" });
      setSwapsCommitted(true);
    } catch { /* best effort */ } finally {
      setCommitting(false);
    }
    setLocation(`/builder/${id}/step-1`);
  };

  if (!property) {
    if (draftLoading) {
      return (
        <div className="max-w-2xl mx-auto p-8 text-center">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">Loading promoted draft…</p>
        </div>
      );
    }
    return (
      <div className="max-w-2xl mx-auto p-8 text-center">
        <p className="text-muted-foreground">Property not found.</p>
        <Button variant="outline" className="mt-4" onClick={() => setLocation("/")}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const step1Url = `/builder/${id}/step-1`;

  // Build the effective unit list — replace any overridden units with their new data
  const effectiveUnits = property.units.map(u => {
    const override = unitOverrides[u.id];
    if (override) {
      return {
        ...u,
        unitNumber: override.unitNumber,
        bedrooms: override.bedrooms,
        _overrideAddress: override.address,
        _isReplaced: true,
        _replacedLabel: override.unitLabel,
        _replacedSourceUrl: override.sourceUrl,
        _originalUnitNumber: u.unitNumber,
      };
    }
    return { ...u, _overrideAddress: undefined, _isReplaced: false, _replacedLabel: undefined, _replacedSourceUrl: undefined, _originalUnitNumber: u.unitNumber };
  });

  // Extract city from address like "4460 Nehe Rd, Lihue, HI 96766"
  const cityMatch = property.address.match(/,\s*([^,]+),\s*[A-Z]{2}\s+\d/);
  const city = cityMatch ? cityMatch[1].trim() : property.address;

  // ── Check one unit at a time, updating results as each completes ──────────
  const runPlatformCheck = async (unitsToCheck = effectiveUnits) => {
    setPlatformChecking(true);
    setPlatformDone(false);
    setResults({});
    setCompletedCount(0);
    setTotalUnits(unitsToCheck.length);
    setCheckPhase("text");
    const pendingIds = new Set(unitsToCheck.map(u => u.id));
    setCheckingUnitIds(new Set(pendingIds));

    const hasPhotos = unitsToCheck.some(u => !(u as any)._isReplaced && (u as any).photoFolder);
    if (hasPhotos) setCheckPhase("text");

    await Promise.all(
      unitsToCheck.map(async (unit) => {
        const address = (unit as any)._overrideAddress || `${property.address}, Unit ${unit.unitNumber}`;
        const hasUnitPhoto = !(unit as any)._isReplaced && (unit as any).photoFolder;
        const unitPayload = [{
          unitId: unit.id,
          unitNumber: unit.unitNumber,
          address,
          photoFolder: (unit as any)._isReplaced ? "" : unit.photoFolder,
        }];
        const params = new URLSearchParams({
          name: property.propertyName,
          city,
          units: JSON.stringify(unitPayload),
        });
        if (hasUnitPhoto) setCheckPhase("photo");
        try {
          const resp = await fetch(`/api/preflight/platform-check?${params.toString()}`);
          if (resp.ok) {
            const data = await resp.json();
            const unitResult: UnitCheckResult | undefined = data?.units?.[0];
            if (unitResult) {
              setResults(prev => ({ ...prev, [unit.id]: unitResult }));
            }
          } else {
            setResults(prev => ({
              ...prev,
              [unit.id]: {
                unitId: unit.id,
                unitNumber: unit.unitNumber,
                address,
                platforms: {
                  airbnb:  { status: "error", url: null, detection: "Could not verify" },
                  vrbo:    { status: "error", url: null, detection: "Could not verify" },
                  booking: { status: "error", url: null, detection: "Could not verify" },
                },
              },
            }));
          }
        } catch {
          setResults(prev => ({
            ...prev,
            [unit.id]: {
              unitId: unit.id,
              unitNumber: unit.unitNumber,
              address,
              platforms: {
                airbnb:  { status: "error", url: null, detection: "Could not verify" },
                vrbo:    { status: "error", url: null, detection: "Could not verify" },
                booking: { status: "error", url: null, detection: "Could not verify" },
              },
            },
          }));
        } finally {
          setCheckingUnitIds(prev => {
            const next = new Set(prev);
            next.delete(unit.id);
            return next;
          });
          setCompletedCount(prev => prev + 1);
        }
      })
    );

    setCheckPhase("done");
    setPlatformChecking(false);
    setPlatformDone(true);
  };

  const rerunChecks = () => {
    setPlatformDone(false);
    setResults({});
    runPlatformCheck();
  };

  // Undo a saved unit swap — deletes from DB and removes from state
  const handleUndoSwap = async (oldUnitId: string) => {
    const override = unitOverrides[oldUnitId];
    if (override?.swapId) {
      await fetch(`/api/unit-swaps/${override.swapId}`, { method: "DELETE" }).catch(() => {});
    }
    const remaining = { ...unitOverrides };
    delete remaining[oldUnitId];
    setUnitOverrides(remaining);
    setPlatformDone(false);
    setResults({});
  };

  // Called when user confirms "Yes, Replace Unit" in the replacement flow
  function handleUnitReplaced(oldUnitId: string, newUnit: ReplacementUnitData, swapId?: number) {
    if (!property) return;
    const newOverride: UnitOverride = {
      unitNumber: newUnit.unitLabel.replace(/^Unit\s*#?/i, ""),
      address: newUnit.address,
      bedrooms: newUnit.bedrooms ?? property.units.find(u => u.id === oldUnitId)?.bedrooms ?? 1,
      unitLabel: newUnit.unitLabel,
      sourceUrl: newUnit.url,
      swapId,
    };
    const updatedOverrides = { ...unitOverrides, [oldUnitId]: newOverride };
    setUnitOverrides(updatedOverrides);
    setShowReplacementFlow(false);
    setReplacementTargetId(null);

    // Re-run the platform check with updated units
    const updatedUnits = property.units.map(u => {
      const override = updatedOverrides[u.id];
      if (override) {
        return {
          ...u,
          unitNumber: override.unitNumber,
          bedrooms: override.bedrooms,
          _overrideAddress: override.address,
          _isReplaced: true,
          _replacedLabel: override.unitLabel,
          _replacedSourceUrl: override.sourceUrl,
          _originalUnitNumber: u.unitNumber,
        };
      }
      return { ...u, _overrideAddress: undefined, _isReplaced: false, _replacedLabel: undefined, _replacedSourceUrl: undefined, _originalUnitNumber: u.unitNumber };
    });
    runPlatformCheck(updatedUnits);
  }

  const isCheckRunning = platformChecking || checkingUnitIds.size > 0;
  const hasAnyResults = Object.keys(results).length > 0;
  const targetUnit = replacementTargetId
    ? property.units.find(u => u.id === replacementTargetId) ?? property.units[0]
    : property.units[0];

  // Does any unit across any platform show a "listed" status?
  const anyUnitListed = effectiveUnits.some(unit => {
    const r = results[unit.id];
    if (!r) return false;
    return PLATFORM_LIST.some(({ key }) => isListedStatus(r.platforms[key].status));
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Back link */}
        <button
          id="link-back-to-dashboard"
          aria-label="Back to previous page"
          onClick={() => window.history.back()}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        {/* Property info */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-1" id="preflight-heading">
            Pre-Flight Check — Is this unit already listed?
          </h1>
          <p className="text-muted-foreground text-sm" id="preflight-property-name">
            {property.propertyName}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5" id="preflight-property-address">
            {property.address}
          </p>
        </div>

        {/* ── Platform Check ── */}
        <Card className="p-6 mb-6">
          <div className="flex items-start justify-between gap-4 mb-1">
            <h2 className="text-base font-semibold">Platform Check</h2>
            {platformDone && (
              <Button
                id="btn-rerun-checks"
                aria-label="Re-run platform check"
                variant="ghost"
                size="sm"
                onClick={rerunChecks}
                disabled={isCheckRunning}
                className="h-7 px-2 text-xs flex-shrink-0"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Re-run
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Searches Airbnb, VRBO, and Booking.com for each unit using text search and reverse image search.
          </p>

          {/* Committed swaps summary — renders every unit (swapped OR original)
              so the user can rescrape any one of them directly. */}
          {property.units.length > 0 && swapsCommitted && (
            <div className="mb-5 rounded-md border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                  <p className="text-sm font-semibold text-green-800 dark:text-green-300">
                    {Object.keys(unitOverrides).length > 0
                      ? `Unit replacement${Object.keys(unitOverrides).length > 1 ? "s" : ""} committed`
                      : "Units confirmed — none needed replacement"}
                  </p>
                </div>
                <Button
                  id="btn-recheck-committed"
                  size="sm"
                  variant="outline"
                  onClick={rerunChecks}
                  disabled={isCheckRunning}
                  className="h-7 px-3 text-xs border-green-400 dark:border-green-600 text-green-800 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/40 flex-shrink-0"
                >
                  {isCheckRunning ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Checking…</>
                  ) : (
                    <><RotateCcw className="h-3 w-3 mr-1" /> Recheck these units</>
                  )}
                </Button>
              </div>
              <div className="space-y-1.5">
                {property.units.map((origUnit, idx) => {
                  const override = unitOverrides[origUnit.id];
                  const positionLabel = `Unit ${String.fromCharCode(65 + idx)}`;
                  const rescrapeHandler = async () => {
                    if (!origUnit.photoFolder) {
                      toast({ title: "Can't rescrape", description: "No photoFolder on this unit.", variant: "destructive" });
                      return;
                    }
                    setRescrapingUnitId(origUnit.id);
                    const folder = origUnit.photoFolder;
                    try {
                      const r = await fetch("/api/builder/rescrape-unit-photos", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ folder }),
                      });
                      const data = await r.json();
                      if (r.status === 409 && data?.needsUrl) {
                        const url = window.prompt(
                          `No source URL on file for ${positionLabel}. Paste the Zillow listing URL — I'll save it for next time.`,
                          "",
                        );
                        if (!url) return;
                        const r2 = await fetch("/api/builder/rescrape-unit-photos", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ folder, sourceUrl: url }),
                        });
                        const d2 = await r2.json();
                        if (!r2.ok) throw new Error(d2?.error ?? `HTTP ${r2.status}`);
                        recordRescrape(folder, {
                          folder,
                          timestamp: Date.now(),
                          savedCount: Number(d2.savedCount ?? 0),
                          bedroomCount: Number(d2.bedroomCount ?? 0),
                          bathroomCount: Number(d2.bathroomCount ?? 0),
                          sourceUrl: d2.sourceUrl,
                          urlSource: d2.urlSource,
                        });
                        toast({ title: "Photos rescraped", description: `${d2.savedCount} saved. Hard-refresh the builder page.`, duration: 8000 });
                        return;
                      }
                      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
                      const saved = Number(data.savedCount ?? 0);
                      const beds = Number(data.bedroomCount ?? 0);
                      const baths = Number(data.bathroomCount ?? 0);
                      const noInteriors = beds === 0 && baths === 0;
                      const cov = data.coverage ?? null;
                      const bedShortfall = Number(cov?.bedroomsShortfall ?? 0);
                      const bathShortfall = Number(cov?.bathroomsShortfall ?? 0);
                      const expectedBeds = cov?.bedroomsExpected;
                      recordRescrape(folder, {
                        folder,
                        timestamp: Date.now(),
                        savedCount: saved,
                        bedroomCount: beds,
                        bathroomCount: baths,
                        sourceUrl: data.sourceUrl,
                        urlSource: data.urlSource,
                      });
                      const shortfallNote = bedShortfall > 0
                        ? ` ⚠ Only ${beds} unique bedrooms found — listing claims ${expectedBeds}. Click "Change" if you need a richer source.`
                        : "";
                      toast({
                        title: noInteriors
                          ? `Rescraped ${saved} photos — no bedrooms found`
                          : `Photos rescraped — ${beds} bedroom${beds !== 1 ? "s" : ""}, ${baths} bathroom${baths !== 1 ? "s" : ""}`,
                        description: noInteriors
                          ? `That Zillow listing's photos are all kitchen/exterior/views — no bedrooms detected by Claude Vision. Click "Change" to search for a different replacement with actual interior shots.`
                          : `${saved} saved (source: ${data.urlSource ?? "manual"}). Bedrooms are renamed Master / Bedroom 2 / Bedroom 3 by bed type. Hard-refresh the builder page to see them.${shortfallNote}`,
                        duration: 10000,
                      });
                    } catch (e: any) {
                      toast({ title: "Rescrape failed", description: e.message, variant: "destructive" });
                    } finally {
                      setRescrapingUnitId(null);
                    }
                  };
                  const receipt = origUnit.photoFolder ? rescrapeReceipts[origUnit.photoFolder] : undefined;
                  return (
                    <div key={origUnit.id} className="rounded border border-green-200 dark:border-green-700 bg-white/60 dark:bg-background/40 px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="text-xs text-muted-foreground font-medium">{positionLabel}</span>
                        {override ? (
                          <>
                            <span className="text-muted-foreground line-through text-xs">Unit {origUnit.unitNumber}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="font-medium">{override.unitLabel}</span>
                            <span className="text-xs text-muted-foreground truncate">{override.address}</span>
                          </>
                        ) : (
                          <>
                            <span className="font-medium">Unit {origUnit.unitNumber}</span>
                            <span className="text-xs text-muted-foreground">({origUnit.bedrooms}BR · original, no swap)</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs border-blue-400 dark:border-blue-600 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40"
                          disabled={rescrapingUnitId === origUnit.id}
                          onClick={rescrapeHandler}
                          data-testid={`button-rescrape-unit-${origUnit.id}`}
                        >
                          {rescrapingUnitId === origUnit.id ? (
                            <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Rescraping…</>
                          ) : (
                            <><RefreshCw className="h-3 w-3 mr-1" /> Rescrape photos</>
                          )}
                        </Button>
                        {override ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs border-green-400 dark:border-green-600 text-green-800 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/40"
                              onClick={async () => {
                                setSwapsCommitted(false);
                                await handleUndoSwap(origUnit.id);
                                setReplacementTargetId(origUnit.id);
                                setShowReplacementFlow(true);
                              }}
                              data-testid={`button-change-committed-swap-${origUnit.id}`}
                            >
                              Change
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              onClick={() => { setSwapsCommitted(false); handleUndoSwap(origUnit.id); }}
                              data-testid={`button-undo-committed-swap-${origUnit.id}`}
                            >
                              Undo
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs border-amber-400 dark:border-amber-600 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                            onClick={() => {
                              setSwapsCommitted(false);
                              setReplacementTargetId(origUnit.id);
                              setShowReplacementFlow(true);
                            }}
                            data-testid={`button-find-replacement-${origUnit.id}`}
                          >
                            Find replacement
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* Sticky rescrape receipt — survives navigation via
                        localStorage so the user remembers what they did. */}
                    {receipt && (
                      <div
                        className="flex items-center gap-2 rounded bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-700 px-2 py-1 text-[11px] text-blue-800 dark:text-blue-300"
                        data-testid={`receipt-rescrape-${origUnit.id}`}
                      >
                        <CheckCircle2 className="h-3 w-3 flex-shrink-0" />
                        <span className="font-medium">
                          Rescraped {fmtRelative(receipt.timestamp)}
                        </span>
                        <span className="text-blue-600 dark:text-blue-400">
                          · {receipt.savedCount} photo{receipt.savedCount !== 1 ? "s" : ""}
                          {receipt.bedroomCount > 0 ? ` · ${receipt.bedroomCount} bedroom${receipt.bedroomCount !== 1 ? "s" : ""}` : ""}
                          {receipt.bathroomCount > 0 ? ` · ${receipt.bathroomCount} bathroom${receipt.bathroomCount !== 1 ? "s" : ""}` : ""}
                          {receipt.bedroomCount === 0 && receipt.bathroomCount === 0 ? " · ⚠ no interior shots" : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => receipt.folder && dismissReceipt(receipt.folder)}
                          className="ml-auto text-blue-500 hover:text-blue-700 text-base leading-none px-1"
                          aria-label="Dismiss confirmation"
                          title="Dismiss"
                        >
                          ×
                        </button>
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-green-700 dark:text-green-400">
                <strong>Rescrape photos</strong> pulls the latest photo set from the same Zillow listing · <strong>Change</strong> searches for a different replacement unit · <strong>Recheck</strong> re-verifies the current ones aren't already listed on Airbnb/VRBO/Booking.
              </p>
            </div>
          )}

          {/* Pending (not yet committed) swaps summary */}
          {Object.keys(unitOverrides).length > 0 && !swapsCommitted && (
            <div className="mb-5 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  Saved unit replacement{Object.keys(unitOverrides).length > 1 ? "s" : ""} active
                </p>
              </div>
              <div className="space-y-2">
                {Object.entries(unitOverrides).map(([oldUnitId, override]) => {
                  const origUnit = property.units.find(u => u.id === oldUnitId);
                  return (
                    <div key={oldUnitId} className="flex items-center justify-between gap-2 rounded border border-amber-200 dark:border-amber-700 bg-white/60 dark:bg-background/40 px-3 py-2">
                      <div className="text-sm flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="text-muted-foreground line-through text-xs">Unit {origUnit?.unitNumber ?? oldUnitId}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-medium">{override.unitLabel}</span>
                        <span className="text-xs text-muted-foreground truncate">{override.address}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 flex-shrink-0"
                        onClick={() => handleUndoSwap(oldUnitId)}
                        data-testid={`button-undo-swap-${oldUnitId}`}
                      >
                        Undo
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Progress bar */}
          {isCheckRunning && totalUnits > 0 && (
            <div className="mb-5 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5 font-medium">
                  {checkPhase === "photo" ? (
                    <><Camera className="h-3.5 w-3.5 animate-pulse text-primary" /> Running photo reverse-image search…</>
                  ) : checkPhase === "text" ? (
                    <><Search className="h-3.5 w-3.5 animate-pulse text-primary" /> Searching Airbnb, VRBO &amp; Booking.com…</>
                  ) : (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</>
                  )}
                </span>
                <span>{completedCount} / {totalUnits} unit{totalUnits !== 1 ? "s" : ""} done</span>
              </div>
              <Progress value={totalUnits > 0 ? (completedCount / totalUnits) * 100 : 0} className="h-2" />
              <p className="text-xs text-muted-foreground">
                {checkPhase === "photo"
                  ? "Uploading photos to run Google Lens reverse image search — this takes 15–30 s per unit."
                  : "Querying search engines for address and unit number matches across all platforms."}
              </p>
            </div>
          )}

          {/* Results table — shown as soon as any check starts or has results */}
          {(isCheckRunning || hasAnyResults) && (
            <table id="platform-check-table" className="w-full text-sm mt-2 border-collapse">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="pb-2 font-medium w-24">Unit</th>
                  <th className="pb-2 font-medium hidden sm:table-cell">Address</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium w-16 text-right">Link</th>
                </tr>
              </thead>
              <tbody>
                {PLATFORM_LIST.map(({ key, label }, pIdx) => (
                  <Fragment key={key}>
                    {/* Platform group header */}
                    <tr className={pIdx > 0 ? "border-t-2 border-border" : ""}>
                      <td
                        colSpan={4}
                        className="pt-3 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 px-2 rounded"
                      >
                        {label}
                      </td>
                    </tr>

                    {/* One row per effective unit */}
                    {effectiveUnits.map(unit => {
                      const unitResult = results[unit.id];
                      const r = unitResult?.platforms[key];
                      const isReplaced = (unit as any)._isReplaced;
                      const displayAddress = (unit as any)._overrideAddress || `${property.address}, Unit ${unit.unitNumber}`;
                      const unitChecking = checkingUnitIds.has(unit.id);
                      const listed = r && isListedStatus(r.status);
                      return (
                        <tr
                          key={`${key}-${unit.id}`}
                          id={`check-${key}-${unit.id}`}
                          className="border-b border-border/40 last:border-0"
                        >
                          <td className="py-2.5 text-sm font-medium">
                            <span>Unit {unit.unitNumber}</span>
                            {isReplaced && !swapsCommitted && (
                              <Badge variant="secondary" className="ml-1.5 text-[10px] py-0 px-1 h-4 align-middle">
                                replaced
                              </Badge>
                            )}
                          </td>
                          <td className="py-2.5 text-xs text-muted-foreground hidden sm:table-cell pr-4">
                            {displayAddress}
                          </td>
                          <td className="py-2.5">
                            <StatusBadge result={r} checking={unitChecking} />
                            {r && (
                              <p className="text-xs text-muted-foreground mt-1">{r.detection}</p>
                            )}
                            {/* Per-row replace button only on Airbnb row (avoid 3x repetition) */}
                            {key === "airbnb" && listed && !isReplaced && property.communityPhotoFolder && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-2 h-7 px-2 text-xs"
                                data-testid={`button-replace-unit-${unit.id}`}
                                onClick={() => {
                                  setReplacementTargetId(unit.id);
                                  setShowReplacementFlow(true);
                                }}
                              >
                                <RefreshCw className="h-3 w-3 mr-1" />
                                Replace this unit
                              </Button>
                            )}
                          </td>
                          <td className="py-2.5 text-right">
                            {r?.url && (
                              <a
                                id={`link-${key}-${unit.id}`}
                                href={r.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline text-xs"
                              >
                                View <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}

          {/* Status legend */}
          {hasAnyResults && (
            <div className="mt-4 pt-4 border-t border-border/60 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-600" /> Listed &amp; verified</span>
              <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-orange-500" /> Likely listed — review recommended</span>
              <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-yellow-500" /> Possible match — check manually</span>
              <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-red-500" /> Not found — safe to use</span>
            </div>
          )}
        </Card>

        {/* Bottom action buttons */}
        <div className="flex flex-col sm:flex-row gap-3" id="preflight-actions">
          {Object.keys(unitOverrides).length > 0 && !swapsCommitted ? (
            <Button
              id="btn-commit-and-continue"
              aria-label="Commit replacement units and continue to builder"
              size="lg"
              onClick={commitAndContinue}
              disabled={committing}
              className="sm:w-auto"
            >
              {committing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</>
              ) : (
                <>Commit Replacements &amp; Continue <ArrowRight className="h-4 w-4 ml-2" /></>
              )}
            </Button>
          ) : (
            <Button
              id="btn-continue-to-wizard"
              aria-label="Continue to the property builder wizard"
              size="lg"
              onClick={() => setLocation(step1Url)}
              className="sm:w-auto"
            >
              Continue to Builder <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          )}
          {anyUnitListed && property.communityPhotoFolder && (
            <Button
              id="btn-use-different-unit"
              aria-label="Find a replacement unit"
              size="lg"
              variant="outline"
              onClick={() => {
                setReplacementTargetId(null);
                setShowReplacementFlow(v => !v);
              }}
              className="sm:w-auto"
            >
              Use a Different Unit
            </Button>
          )}
        </div>

        {/* Unit replacement flow */}
        {showReplacementFlow && property.communityPhotoFolder && (
          <div className="mt-6">
            <UnitReplacementFlow
              unit={{
                id: targetUnit.id,
                unitNumber: targetUnit.unitNumber,
                bedrooms: targetUnit.bedrooms,
                photoFolder: (targetUnit as any).photoFolder,
                positionLabel: (() => {
                  const idx = property.units.findIndex(u => u.id === targetUnit.id);
                  return idx >= 0 ? `Unit ${String.fromCharCode(65 + idx)}` : undefined;
                })(),
                replacementLabel: unitOverrides[targetUnit.id]?.unitLabel,
              }}
              allUnits={property.units.map((u, i) => ({
                id: u.id,
                unitNumber: u.unitNumber,
                bedrooms: u.bedrooms,
                photoFolder: u.photoFolder,
                positionLabel: `Unit ${String.fromCharCode(65 + i)}`,
                replacementLabel: unitOverrides[u.id]?.unitLabel,
              }))}
              communityFolder={property.communityPhotoFolder}
              propertyId={id}
              skipUrls={Object.values(unitOverrides).map(o => o.sourceUrl).filter(Boolean)}
              onClose={() => { setShowReplacementFlow(false); setReplacementTargetId(null); }}
              onUnitReplaced={handleUnitReplaced}
            />
          </div>
        )}
      </div>
    </div>
  );
}
