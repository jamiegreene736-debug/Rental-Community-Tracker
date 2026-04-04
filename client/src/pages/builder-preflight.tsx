import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  ArrowRight,
  RotateCcw,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";
import { getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import { UnitReplacementFlow, type ReplacementUnitData } from "@/components/unit-replacement-flow";

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

type PlatformCheckData = { units: UnitCheckResult[] } | null;

// A swapped unit's effective display data
type UnitOverride = {
  unitNumber: string;
  address: string;
  bedrooms: number;
  unitLabel: string;
  sourceUrl: string;
  swapId?: number; // DB record ID — used to delete the swap
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
          <CheckCircle2 className="h-3 w-3" /> ✓ Yes — Listed (title confirmed)
        </span>
      );
    case "photo-confirmed":
      return (
        <span className="status-photo-confirmed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
          <CheckCircle2 className="h-3 w-3" /> ✓ Yes — Listed (photos confirmed)
        </span>
      );
    case "photo-only":
      return (
        <span className="status-photo-only inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300">
          <AlertTriangle className="h-3 w-3" /> ⚠ Likely Listed — Found via photos only
        </span>
      );
    case "unconfirmed":
      return (
        <span className="status-unconfirmed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
          <AlertTriangle className="h-3 w-3" /> ⚠ Possible Match — Check Manually
        </span>
      );
    case "not-listed":
      return (
        <span className="status-not-listed inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">
          <XCircle className="h-3 w-3" /> ✗ No — Not Listed
        </span>
      );
    default:
      return (
        <span className="status-error inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
          <AlertTriangle className="h-3 w-3" /> Could not verify
        </span>
      );
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_LIST: { key: keyof UnitCheckResult["platforms"]; label: string }[] = [
  { key: "airbnb",  label: "Airbnb" },
  { key: "vrbo",    label: "VRBO" },
  { key: "booking", label: "Booking.com" },
];

// ── Main component ────────────────────────────────────────────────────────────

export default function BuilderPreflight() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const [, setLocation] = useLocation();
  const id = parseInt(propertyId || "0", 10);
  const property = getUnitBuilderByPropertyId(id);

  const [platformChecking, setPlatformChecking] = useState(false);
  const [platformData, setPlatformData] = useState<PlatformCheckData>(null);
  const [platformDone, setPlatformDone] = useState(false);
  const [showReplacementFlow, setShowReplacementFlow] = useState(false);

  // Maps old unit ID → replacement unit data
  const [unitOverrides, setUnitOverrides] = useState<Record<string, UnitOverride>>({});

  // Load any previously saved unit swaps from the DB on mount
  useEffect(() => {
    if (!id) return;
    fetch(`/api/unit-swaps/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { swaps: any[] } | null) => {
        if (!data?.swaps?.length) return;
        const restored: Record<string, UnitOverride> = {};
        for (const swap of data.swaps) {
          restored[swap.oldUnitId] = {
            unitNumber: swap.newUnitLabel.replace(/^Unit\s*#?/i, "").trim(),
            address: swap.newAddress,
            bedrooms: swap.newBedrooms ?? 1,
            unitLabel: swap.newUnitLabel,
            sourceUrl: swap.newSourceUrl,
            swapId: swap.id,
          };
        }
        setUnitOverrides(restored);
      })
      .catch(() => {/* best effort */});
  }, [id]);

  if (!property) {
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
        // address is on the property, but we surface it in the override for the platform check
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

  const runPlatformCheck = async (unitsToCheck = effectiveUnits) => {
    setPlatformChecking(true);
    setPlatformData(null);
    try {
      const units = unitsToCheck.map(u => {
        const address = (u as any)._overrideAddress || `${property.address}, Unit ${u.unitNumber}`;
        return {
          unitId: u.id,
          unitNumber: u.unitNumber,
          address,
          // Replaced units have no local photo folder — skip photo check so the
          // old unit's photos don't produce false "Likely Listed" signals
          photoFolder: (u as any)._isReplaced ? "" : u.photoFolder,
        };
      });
      const params = new URLSearchParams({
        name: property.propertyName,
        city,
        units: JSON.stringify(units),
      });
      const resp = await fetch(`/api/preflight/platform-check?${params.toString()}`);
      if (!resp.ok) throw new Error("Check failed");
      setPlatformData(await resp.json());
    } catch {
      setPlatformData({
        units: unitsToCheck.map(u => ({
          unitId: u.id,
          unitNumber: u.unitNumber,
          address: (u as any)._overrideAddress || `${property.address}, Unit ${u.unitNumber}`,
          platforms: {
            airbnb:  { status: "error", url: null, detection: "Could not verify" },
            vrbo:    { status: "error", url: null, detection: "Could not verify" },
            booking: { status: "error", url: null, detection: "Could not verify" },
          },
        })),
      });
    } finally {
      setPlatformChecking(false);
      setPlatformDone(true);
    }
  };

  const rerunChecks = () => {
    setPlatformDone(false);
    setPlatformData(null);
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
    setPlatformData(null);
  };

  // Called when user confirms "Yes, Replace Unit" in the replacement flow
  function handleUnitReplaced(oldUnitId: string, newUnit: ReplacementUnitData, swapId?: number) {
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

    // Immediately re-run the platform check with the updated units
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

  return (
    <div className="min-h-screen bg-background">
      {/* Skip banner — FIRST element, critical for Cowork */}
      <div
        id="cowork-skip-banner"
        className="w-full bg-gray-900 text-white px-4 py-3 flex items-center justify-between gap-4"
      >
        <span className="text-sm font-medium">Automated agent? Skip this step.</span>
        <Button
          id="btn-skip-preflight"
          aria-label="Skip pre-flight check and go directly to Step 1"
          tabIndex={1}
          size="sm"
          className="bg-white text-gray-900 hover:bg-gray-100 shrink-0"
          onClick={() => setLocation(step1Url)}
        >
          Skip → Go to Step 1
        </Button>
      </div>

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
          <h2 className="text-base font-semibold mb-1">Platform Check</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Searches Airbnb, VRBO, and Booking.com for each unit using both text search and reverse image search.
          </p>

          {Object.keys(unitOverrides).length > 0 && (
            <div className="mb-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Active Replacements</p>
              {Object.entries(unitOverrides).map(([oldUnitId, override]) => {
                const origUnit = property.units.find(u => u.id === oldUnitId);
                return (
                  <div key={oldUnitId} className="flex items-center justify-between gap-2 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2">
                    <div className="text-sm">
                      <span className="text-muted-foreground">Unit {origUnit?.unitNumber ?? oldUnitId}</span>
                      <span className="mx-2 text-muted-foreground">→</span>
                      <span className="font-medium">{override.unitLabel}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{override.address}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleUndoSwap(oldUnitId)}
                      data-testid={`button-undo-swap-${oldUnitId}`}
                    >
                      Undo
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {!platformDone && !platformChecking && (
            <Button
              id="btn-run-platform-check"
              aria-label="Run platform check using text search and reverse image search"
              onClick={() => runPlatformCheck()}
            >
              Run Platform Check
            </Button>
          )}

          {platformChecking && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching all platforms with text search + photo matching…
            </div>
          )}

          {(platformDone || platformChecking) && (
            <table id="platform-check-table" className="w-full text-sm mt-2 border-collapse">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="pb-2 font-medium w-28">Platform</th>
                  <th className="pb-2 font-medium w-24">Unit</th>
                  <th className="pb-2 font-medium hidden sm:table-cell w-52">Address</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium w-16">Link</th>
                </tr>
              </thead>
              <tbody>
                {PLATFORM_LIST.map(({ key, label }, pIdx) => (
                  <>
                    {/* Platform group header */}
                    <tr key={`header-${key}`} className={pIdx > 0 ? "border-t-2 border-border" : ""}>
                      <td
                        colSpan={5}
                        className="pt-3 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 px-2 rounded"
                      >
                        {label}
                      </td>
                    </tr>

                    {/* One row per effective unit */}
                    {effectiveUnits.map(unit => {
                      const unitResult = platformData?.units.find(u => u.unitId === unit.id);
                      const r = unitResult?.platforms[key];
                      const isReplaced = (unit as any)._isReplaced;
                      const displayAddress = (unit as any)._overrideAddress || `${property.address}, Unit ${unit.unitNumber}`;
                      return (
                        <tr
                          key={`${key}-${unit.id}`}
                          id={`check-${key}-${unit.id}`}
                          className="border-b border-border/40 last:border-0"
                        >
                          <td className="py-2.5 text-xs text-muted-foreground pl-2">—</td>
                          <td className="py-2.5 text-sm font-medium">
                            <span>Unit {unit.unitNumber}</span>
                            {isReplaced && (
                              <Badge variant="secondary" className="ml-1.5 text-[10px] py-0 px-1 h-4 align-middle">
                                replaced
                              </Badge>
                            )}
                          </td>
                          <td className="py-2.5 text-xs text-muted-foreground hidden sm:table-cell pr-4">
                            {displayAddress}
                          </td>
                          <td className="py-2.5">
                            <StatusBadge result={r} checking={platformChecking} />
                            {r && (
                              <p className="text-xs text-muted-foreground mt-1">{r.detection}</p>
                            )}
                          </td>
                          <td className="py-2.5">
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
                  </>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Re-run button */}
        {platformDone && (
          <div className="mb-6">
            <Button
              id="btn-rerun-checks"
              aria-label="Re-run platform check"
              variant="ghost"
              size="sm"
              onClick={rerunChecks}
              disabled={platformChecking}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              Re-run Checks
            </Button>
          </div>
        )}

        {/* Bottom action buttons */}
        <div className="flex flex-col sm:flex-row gap-3" id="preflight-actions">
          <Button
            id="btn-continue-to-wizard"
            aria-label="Continue to the property builder wizard"
            size="lg"
            onClick={() => setLocation(step1Url)}
            className="sm:w-auto"
          >
            Continue to Builder <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
          <Button
            id="btn-use-different-unit"
            aria-label="Find a replacement unit"
            size="lg"
            variant="outline"
            onClick={() => setShowReplacementFlow(v => !v)}
            className="sm:w-auto"
          >
            Use a Different Unit
          </Button>
        </div>

        {showReplacementFlow && property.communityPhotoFolder && (
          <div className="mt-6">
            <UnitReplacementFlow
              unit={{ id: property.units[0].id, unitNumber: property.units[0].unitNumber, bedrooms: property.units[0].bedrooms }}
              allUnits={property.units.map(u => ({ id: u.id, unitNumber: u.unitNumber, bedrooms: u.bedrooms }))}
              communityFolder={property.communityPhotoFolder}
              propertyId={id}
              onClose={() => setShowReplacementFlow(false)}
              onUnitReplaced={handleUnitReplaced}
            />
          </div>
        )}
      </div>
    </div>
  );
}
