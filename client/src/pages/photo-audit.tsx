import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle, AlertTriangle, XCircle, Search, Loader2, ExternalLink, Camera, Building2, ShieldCheck, ShieldAlert } from "lucide-react";
import { unitBuilderData } from "@/data/unit-builder-data";

interface UnitAudit {
  id: string;
  unitNumber: string;
  photoFolder: string;
  photoCount: number;
  extractedUnitNum: string | null;
  isGeneric: boolean;
  isStockPhoto: boolean;
  needsVrboCheck: boolean;
}

interface PropertyAudit {
  propertyId: number;
  propertyName: string;
  complexName: string;
  communityPhotoFolder: string;
  communityPhotoCount: number;
  communityMatch: boolean;
  units: UnitAudit[];
}

interface VrboCheckResult {
  unitNumber: string;
  complexName: string;
  vrboListings: { title: string; url: string; snippet: string }[];
  hasConflict: boolean;
  isListedOnVrbo: boolean;
  checkedAt: string;
}

function buildAuditData(): PropertyAudit[] {
  return unitBuilderData.map((prop) => {
    const communityFolderName = prop.communityPhotoFolder || "";
    const complexNameNormalized = (prop.complexName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const communityFolderNormalized = communityFolderName.replace("community-", "").replace(/-/g, "");
    const complexWords = (prop.complexName || "").toLowerCase().split(/\s+/).filter(w => w.length > 3).map(w => w.replace(/[^a-z0-9]/g, ""));
    const communityMatch = !communityFolderName ||
      communityFolderNormalized.includes(complexNameNormalized.slice(0, 6)) ||
      complexNameNormalized.includes(communityFolderNormalized.slice(0, 6)) ||
      complexWords.some(word => communityFolderNormalized.includes(word));

    const units = prop.units.map((unit) => {
      const folder = unit.photoFolder;
      const unitNumMatch = folder.match(/(?:unit-)?(\d+)$/);
      const extractedUnitNum = unitNumMatch ? unitNumMatch[1] : null;
      const isGeneric = !extractedUnitNum;
      const isStockPhoto = folder.includes("pili-mai") || folder === "";

      return {
        id: unit.id,
        unitNumber: unit.unitNumber,
        photoFolder: folder,
        photoCount: unit.photos.length,
        extractedUnitNum,
        isGeneric,
        isStockPhoto,
        needsVrboCheck: !!extractedUnitNum && !isStockPhoto,
      };
    });

    return {
      propertyId: prop.propertyId,
      propertyName: prop.propertyName,
      complexName: prop.complexName,
      communityPhotoFolder: communityFolderName,
      communityPhotoCount: prop.communityPhotos?.length || 0,
      communityMatch,
      units,
    };
  });
}

export default function PhotoAudit() {
  const [vrboResults, setVrboResults] = useState<Record<string, VrboCheckResult | "loading" | "error">>({});

  const auditData = useMemo(() => buildAuditData(), []);

  const checkVrbo = async (unitNumber: string, complexName: string) => {
    const key = `${complexName}-${unitNumber}`;
    if (vrboResults[key] && vrboResults[key] !== "error") return;

    setVrboResults(prev => ({ ...prev, [key]: "loading" }));
    try {
      const res = await fetch(`/api/photo-audit/check-vrbo?unitNumber=${encodeURIComponent(unitNumber)}&complexName=${encodeURIComponent(complexName)}`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setVrboResults(prev => ({ ...prev, [key]: data }));
    } catch {
      setVrboResults(prev => ({ ...prev, [key]: "error" }));
    }
  };

  const checkAllVrbo = async () => {
    const uniqueChecks = new Map<string, { unitNumber: string; complexName: string }>();
    for (const prop of auditData) {
      for (const unit of prop.units) {
        if (unit.needsVrboCheck && unit.extractedUnitNum) {
          const key = `${prop.complexName}-${unit.extractedUnitNum}`;
          if (!uniqueChecks.has(key)) {
            uniqueChecks.set(key, { unitNumber: unit.extractedUnitNum, complexName: prop.complexName });
          }
        }
      }
    }

    for (const [, check] of uniqueChecks) {
      await checkVrbo(check.unitNumber, check.complexName);
      await new Promise(r => setTimeout(r, 1500));
    }
  };

  const getVrboStatus = (complexName: string, unitNumber: string | null) => {
    if (!unitNumber) return null;
    const key = `${complexName}-${unitNumber}`;
    return vrboResults[key] || null;
  };

  const totalUnits = auditData.reduce((sum, p) => sum + p.units.length, 0);
  const unitsNeedingCheck = auditData.reduce((sum, p) => sum + p.units.filter(u => u.needsVrboCheck).length, 0);
  const stockPhotoUnits = auditData.reduce((sum, p) => sum + p.units.filter(u => u.isStockPhoto).length, 0);
  const genericUnits = auditData.reduce((sum, p) => sum + p.units.filter(u => u.isGeneric && !u.isStockPhoto).length, 0);
  const communityMismatches = auditData.filter(p => !p.communityMatch).length;

  const checkedCount = Object.values(vrboResults).filter(v => v !== "loading").length;
  const conflictCount = Object.values(vrboResults).filter(v => typeof v === "object" && v !== null && v.hasConflict).length;
  const listedCount = Object.values(vrboResults).filter(v => typeof v === "object" && v !== null && v.isListedOnVrbo).length;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-6xl mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="link-back-home">
              <ArrowLeft className="h-4 w-4 mr-1" /> Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="text-page-title">Photo Audit</h1>
            <p className="text-sm text-gray-500">Verify photo sources and check for VRBO conflicts</p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <Card>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold" data-testid="text-total-units">{totalUnits}</div>
              <div className="text-xs text-gray-500">Total Units</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-amber-600" data-testid="text-needs-check">{unitsNeedingCheck}</div>
              <div className="text-xs text-gray-500">Need VRBO Check</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-green-600" data-testid="text-stock-photos">{stockPhotoUnits}</div>
              <div className="text-xs text-gray-500">Stock Photos</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-blue-600">{genericUnits}</div>
              <div className="text-xs text-gray-500">Generic Names</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div className={`text-2xl font-bold ${communityMismatches > 0 ? "text-red-600" : "text-green-600"}`}>{communityMismatches}</div>
              <div className="text-xs text-gray-500">Community Mismatches</div>
            </CardContent>
          </Card>
        </div>

        {unitsNeedingCheck > 0 && (
          <div className="mb-6 flex items-center gap-3">
            <Button onClick={checkAllVrbo} variant="outline" data-testid="button-check-all-vrbo">
              <Search className="h-4 w-4 mr-2" />
              Check All Units on VRBO ({unitsNeedingCheck} units)
            </Button>
            {checkedCount > 0 && (
              <span className="text-sm text-gray-500">
                Checked: {checkedCount} | Found on VRBO: {listedCount} | Conflicts: {conflictCount}
              </span>
            )}
          </div>
        )}

        <div className="space-y-4">
          {auditData.map((prop) => (
            <Card key={prop.propertyId} data-testid={`card-property-${prop.propertyId}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{prop.propertyName}</CardTitle>
                    <p className="text-sm text-gray-500 mt-1">
                      <Building2 className="h-3.5 w-3.5 inline mr-1" />
                      {prop.complexName} (ID: {prop.propertyId})
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {prop.communityMatch ? (
                      <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50">
                        <CheckCircle className="h-3 w-3 mr-1" /> Community Match
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-red-700 border-red-300 bg-red-50">
                        <XCircle className="h-3 w-3 mr-1" /> Community Mismatch
                      </Badge>
                    )}
                  </div>
                </div>
                {prop.communityPhotoFolder && (
                  <p className="text-xs text-gray-400 mt-1">
                    <Camera className="h-3 w-3 inline mr-1" />
                    Community folder: {prop.communityPhotoFolder} ({prop.communityPhotoCount} photos)
                  </p>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-2">
                  {prop.units.map((unit) => {
                    const vrboStatus = getVrboStatus(prop.complexName, unit.extractedUnitNum);
                    return (
                      <div
                        key={unit.id}
                        className={`flex items-center justify-between p-3 rounded-lg border ${
                          vrboStatus && typeof vrboStatus === "object" && vrboStatus.hasConflict
                            ? "border-red-300 bg-red-50 dark:bg-red-950/20"
                            : vrboStatus && typeof vrboStatus === "object" && vrboStatus.isListedOnVrbo
                            ? "border-amber-300 bg-amber-50 dark:bg-amber-950/20"
                            : unit.isStockPhoto
                            ? "border-green-200 bg-green-50/50 dark:bg-green-950/10"
                            : "border-gray-200 dark:border-gray-700"
                        }`}
                        data-testid={`row-unit-${unit.id}`}
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{unit.unitNumber}</span>
                            <span className="text-xs text-gray-400">({unit.photoCount} photos)</span>
                            {unit.isStockPhoto && (
                              <Badge variant="outline" className="text-green-700 border-green-300 text-xs py-0">
                                <ShieldCheck className="h-3 w-3 mr-1" /> Stock Photos
                              </Badge>
                            )}
                            {unit.isGeneric && !unit.isStockPhoto && (
                              <Badge variant="outline" className="text-blue-700 border-blue-300 text-xs py-0">
                                <ShieldCheck className="h-3 w-3 mr-1" /> Generic Name
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            Folder: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{unit.photoFolder || "(none)"}</code>
                            {unit.extractedUnitNum && (
                              <span className="ml-2 text-amber-600">
                                Source unit: #{unit.extractedUnitNum}
                              </span>
                            )}
                          </div>
                          {vrboStatus && typeof vrboStatus === "object" && vrboStatus.vrboListings.length > 0 && (
                            <div className="mt-2 space-y-1">
                              {vrboStatus.vrboListings.map((listing, i) => (
                                <div key={i} className="text-xs flex items-start gap-1">
                                  <ShieldAlert className="h-3 w-3 text-red-500 mt-0.5 flex-shrink-0" />
                                  <div>
                                    <a href={listing.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                                      {listing.title} <ExternalLink className="h-2.5 w-2.5 inline" />
                                    </a>
                                    <p className="text-gray-400 line-clamp-1">{listing.snippet}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          {unit.needsVrboCheck && (
                            <>
                              {vrboStatus === "loading" && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                              {vrboStatus === "error" && (
                                <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => {
                                  setVrboResults(prev => { const n = {...prev}; delete n[`${prop.complexName}-${unit.extractedUnitNum}`]; return n; });
                                  checkVrbo(unit.extractedUnitNum!, prop.complexName);
                                }}>
                                  Retry
                                </Button>
                              )}
                              {typeof vrboStatus === "object" && vrboStatus !== null && (
                                vrboStatus.hasConflict ? (
                                  <Badge variant="destructive" className="text-xs">
                                    <XCircle className="h-3 w-3 mr-1" /> Conflict Found
                                  </Badge>
                                ) : vrboStatus.isListedOnVrbo ? (
                                  <Badge variant="outline" className="text-amber-700 border-amber-300 text-xs">
                                    <AlertTriangle className="h-3 w-3 mr-1" /> On VRBO
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="text-green-700 border-green-300 text-xs">
                                    <CheckCircle className="h-3 w-3 mr-1" /> Not Found
                                  </Badge>
                                )
                              )}
                              {!vrboStatus && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs h-7"
                                  onClick={() => checkVrbo(unit.extractedUnitNum!, prop.complexName)}
                                  data-testid={`button-check-${unit.id}`}
                                >
                                  <Search className="h-3 w-3 mr-1" /> Check VRBO
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
