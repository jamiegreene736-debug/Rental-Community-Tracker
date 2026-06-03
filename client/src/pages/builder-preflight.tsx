import { useState, useEffect, useRef } from "react";
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
  RefreshCw,
  Camera,
  Search,
} from "lucide-react";
import { getUnitBuilderByPropertyId, type PropertyUnitBuilder } from "@/data/unit-builder-data";
import { loadDraftPropertyByNegativeId } from "@/data/adapt-draft";
import { apiRequest } from "@/lib/queryClient";
import { UnitReplacementFlow, type ReplacementUnitData } from "@/components/unit-replacement-flow";
import { useToast } from "@/hooks/use-toast";
import { replacementPhotoFolderForUnit } from "@shared/unit-swap-photos";
import { inferCommunityStreetAddress } from "@shared/community-addresses";

type PreflightPhotoFetchJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  message: string;
  progress: number;
  unitId: string;
  savedCount: number | null;
  sourceUrl: string | null;
  error: string | null;
};

const photoFetchJobStorageKey = (propertyId: number) => `preflight.photoFetchJob.v1:${propertyId}`;
const loadPhotoFetchJobIds = (propertyId: number): Record<string, string> => {
  try {
    const raw = localStorage.getItem(photoFetchJobStorageKey(propertyId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};
const savePhotoFetchJobIds = (propertyId: number, next: Record<string, string>) => {
  try {
    if (Object.keys(next).length === 0) {
      localStorage.removeItem(photoFetchJobStorageKey(propertyId));
    } else {
      localStorage.setItem(photoFetchJobStorageKey(propertyId), JSON.stringify(next));
    }
  } catch { /* ignore */ }
};

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
  photoFolder?: string;
  swapId?: number;
};

function formatUnitDisplayLabel(unitNumber: string): string {
  const raw = String(unitNumber || "").trim();
  if (!raw) return "Unit";
  if (/^(unit|units|apt\.?|apartment|suite|ste\.?|building|townhome|main|guest)\b/i.test(raw)) {
    return raw;
  }
  return `Unit ${raw}`;
}

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

function CompactStatusBadge({
  result,
  checking,
}: {
  result: UnitPlatformResult | undefined;
  checking: boolean;
}) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium whitespace-nowrap";
  if (checking || !result) {
    return (
      <span className={`${base} bg-muted text-muted-foreground`}>
        <Loader2 className="h-3 w-3 animate-spin" /> Checking
      </span>
    );
  }
  switch (result.status) {
    case "confirmed":
    case "photo-confirmed":
      return (
        <span className={`${base} bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300`}>
          <CheckCircle2 className="h-3 w-3" /> Listed
        </span>
      );
    case "photo-only":
      return (
        <span className={`${base} bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300`}>
          <AlertTriangle className="h-3 w-3" /> Likely
        </span>
      );
    case "unconfirmed":
      return (
        <span className={`${base} bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300`}>
          <AlertTriangle className="h-3 w-3" /> Review
        </span>
      );
    case "not-listed":
      return (
        <span className={`${base} bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300`}>
          <XCircle className="h-3 w-3" /> Clear
        </span>
      );
    default:
      return (
        <span className={`${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400`}>
          <AlertTriangle className="h-3 w-3" /> Error
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
  // static unitBuilderData array. Per-unit photo folders are
  // fetched alongside so the units' photos array is populated
  // (the wizard persists photos to disk via /persist-photos on
  // save; this just lists them).
  const [draftProperty, setDraftProperty] = useState<PropertyUnitBuilder | null>(null);
  const [draftLoading, setDraftLoading] = useState<boolean>(!staticProperty && id < 0);
  useEffect(() => {
    if (staticProperty || id >= 0) return;
    setDraftLoading(true);
    loadDraftPropertyByNegativeId(id)
      .then((p) => { if (p) setDraftProperty(p); })
      .catch(() => { /* leave draftProperty null → renders the not-found state */ })
      .finally(() => setDraftLoading(false));
  }, [id, staticProperty]);
  const property = staticProperty ?? draftProperty;
  const isPromotedDraft = id < 0;

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

  // ── Photo source scraper for promoted drafts ─────────────────────────────
  // Drafts whose Step 4 wizard scrape didn't find a matching Zillow listing
  // arrive at preflight with no photos persisted on the volume. Without
  // photos, the reverse-image-search half of the Platform Check is fully
  // skipped (it has nothing to feed Google Lens), so the check returns "no
  // signals" regardless of whether the property is actually listed somewhere.
  //
  // Mirrors the same real-estate discovery logic /api/replacement/find-unit
  // uses for active properties: searches Zillow/Realtor by community +
  // street address + bedroom count, supplements with Apify when a resort
  // street root is known, then scrapes the first usable detail result.
  // Operator clicks one button per unit; URL paste isn't needed.
  const [photoFetchJobIdsByUnit, setPhotoFetchJobIdsByUnit] = useState<Record<string, string>>(() =>
    id < 0 ? loadPhotoFetchJobIds(id) : {},
  );
  const [photoFetchJobsByUnit, setPhotoFetchJobsByUnit] = useState<Record<string, PreflightPhotoFetchJob>>({});
  const [photoFetchTick, setPhotoFetchTick] = useState(0);
  // Track URLs the operator has already accepted/rejected so the
  // "Try another" path skips them. Reset when the property changes.
  const [skippedUrlsByUnit, setSkippedUrlsByUnit] = useState<Record<string, string[]>>({});

  const activePhotoFetchUnitIds = Object.entries(photoFetchJobIdsByUnit)
    .filter(([unitId, jobId]) => {
      const job = photoFetchJobsByUnit[unitId];
      return jobId && (!job || job.status === "queued" || job.status === "running");
    })
    .map(([unitId]) => unitId);
  const scrapingUnitId = activePhotoFetchUnitIds[0] ?? null;

  useEffect(() => {
    if (activePhotoFetchUnitIds.length === 0) return;
    const t = setInterval(() => setPhotoFetchTick((tick) => tick + 1), 1_000);
    return () => clearInterval(t);
  }, [activePhotoFetchUnitIds.length]);

  useEffect(() => {
    if (!id || id >= 0) return;
    setPhotoFetchJobIdsByUnit(loadPhotoFetchJobIds(id));
  }, [id]);

  const applyPhotoFetchJob = (unitId: string, job: PreflightPhotoFetchJob, restored = false) => {
    setPhotoFetchJobsByUnit((prev) => ({ ...prev, [unitId]: job }));
    const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    if (!terminal) return;
    setPhotoFetchJobIdsByUnit((prev) => {
      const next = { ...prev };
      delete next[unitId];
      savePhotoFetchJobIds(id, next);
      return next;
    });
    if (job.status === "completed") {
      void loadDraftPropertyByNegativeId(id).then((updated) => {
        if (updated) setDraftProperty(updated);
      });
      if (!restored) {
        toast({
          title: `Saved ${job.savedCount ?? 0} photo${job.savedCount === 1 ? "" : "s"}`,
          description: job.sourceUrl
            ? `From ${new URL(job.sourceUrl).hostname}. Re-run the Platform Check to reverse-image-search them.`
            : "Re-run the Platform Check below to reverse-image-search them.",
        });
        if (job.sourceUrl) {
          setSkippedUrlsByUnit((prev) => ({
            ...prev,
            [unitId]: [...(prev[unitId] ?? []), job.sourceUrl!],
          }));
        }
      }
    } else if (!restored && job.error) {
      toast({
        title: "No more photo candidates",
        description: job.error,
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    const jobIds = Object.entries(photoFetchJobIdsByUnit).filter(([, jobId]) => !!jobId);
    if (jobIds.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      for (const [unitId, jobId] of jobIds) {
        try {
          const resp = await fetch(`/api/preflight/photo-fetch-jobs/${encodeURIComponent(jobId)}`, {
            credentials: "include",
          });
          if (!resp.ok) {
            if (resp.status === 404 && !cancelled) {
              setPhotoFetchJobIdsByUnit((prev) => {
                const next = { ...prev };
                delete next[unitId];
                savePhotoFetchJobIds(id, next);
                return next;
              });
            }
            continue;
          }
          const data = await resp.json();
          if (!cancelled && data.job) applyPhotoFetchJob(unitId, data.job as PreflightPhotoFetchJob);
        } catch {
          // keep polling
        }
      }
    };
    poll();
    const interval = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, photoFetchJobIdsByUnit]);

  // Parse street / city / state out of the property's display address
  // ("9000 Treasure Trove Lane, Kissimmee, Florida"). For HI properties
  // the address often has a building suffix ("…, Bldg 38, Koloa, HI
  // 96756") which we tolerate by taking position[-2] / position[-1].
  const parsePropertyAddress = (addr: string): { street: string; city: string; state: string } => {
    const parts = (addr || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return { street: addr || "", city: "", state: "" };
    const street = parts[0];
    let city = "";
    let state = "";
    if (parts.length >= 3) {
      city = parts[parts.length - 2];
      state = (parts[parts.length - 1].split(" ")[0] || "").trim(); // "FL 34747" → "FL"
    } else {
      city = parts[1];
      state = parts[2] ?? "";
    }
    return { street, city, state };
  };

  const handleScrapePhotosForUnit = async (unitIndex: 0 | 1, unit: { id: string; bedrooms: number; photos?: { url: string }[]; photoFolder?: string }) => {
    if (id >= 0 || !property) return; // promoted drafts only
    const draftId = -id;
    const { street: parsedStreet, city, state } = parsePropertyAddress(property.address);
    const street = inferCommunityStreetAddress({
      communityName: property.complexName,
      city,
      state,
      addressHint: parsedStreet || property.address,
    }) || parsedStreet;
    const loadSourceUrl = async (folder?: string): Promise<string | null> => {
      if (!folder) return null;
      try {
        const r = await apiRequest("GET", `/api/builder/photo-source/${encodeURIComponent(folder)}`);
        const data = await r.json() as { source?: { sourceListing?: { url?: string } } | null };
        const url = data?.source?.sourceListing?.url;
        return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
      } catch {
        return null;
      }
    };
    try {
      const replacingExistingPhotos = (unit.photos?.length ?? 0) > 0;
      const currentSourceUrl = await loadSourceUrl(unit.photoFolder);
      const siblingSourceUrls = replacingExistingPhotos
        ? []
        : (await Promise.all(
            property.units
              .filter((u) => u.id !== unit.id)
              .map((u) => loadSourceUrl(u.photoFolder)),
          )).filter((u): u is string => !!u);
      const skipUrls = Array.from(new Set([
        ...(skippedUrlsByUnit[unit.id] ?? []),
        ...(currentSourceUrl ? [currentSourceUrl] : []),
        ...siblingSourceUrls,
      ]));
      const resp = await apiRequest("POST", "/api/preflight/photo-fetch-jobs", {
        draftId,
        propertyId: id,
        unitId: unit.id,
        unitIndex,
        bedrooms: unit.bedrooms,
        communityName: property.complexName,
        streetAddress: street || undefined,
        city: city || undefined,
        state: state || undefined,
        skipUrls,
        replacingExistingPhotos,
        skipFirst: skipUrls.length === 0 && replacingExistingPhotos ? 1 : 0,
      });
      const data = await resp.json();
      if (!data?.job?.id) throw new Error("Photo fetch job did not start");
      setPhotoFetchJobIdsByUnit((prev) => {
        const next = { ...prev, [unit.id]: data.job.id as string };
        savePhotoFetchJobIds(id, next);
        return next;
      });
      applyPhotoFetchJob(unit.id, data.job as PreflightPhotoFetchJob);
      setPhotoFetchTick(0);
    } catch (e: any) {
      toast({ title: "Scrape failed", description: e?.message || String(e), variant: "destructive" });
    }
  };

  const [platformChecking, setPlatformChecking] = useState(false);
  // Track which unit IDs are still being checked (for per-row spinner)
  const [checkingUnitIds, setCheckingUnitIds] = useState<Set<string>>(new Set());
  const [completedCount, setCompletedCount] = useState(0);
  const [totalUnits, setTotalUnits] = useState(0);
  const [checkPhase, setCheckPhase] = useState<"text" | "photo" | "done" | null>(null);
  const [checkStartedAt, setCheckStartedAt] = useState<number | null>(null);
  const [progressTick, setProgressTick] = useState(0);
  const [results, setResults] = useState<ProgressiveResults>({});
  const [platformDone, setPlatformDone] = useState(false);
  const [fullAuditRunning, setFullAuditRunning] = useState(false);
  const [lastCheckWasFullAudit, setLastCheckWasFullAudit] = useState(false);
  const [showReplacementFlow, setShowReplacementFlow] = useState(false);
  const [replacementTargetId, setReplacementTargetId] = useState<string | null>(null);
  const [swapsCommitted, setSwapsCommitted] = useState(false);
  const [committing, setCommitting] = useState(false);
  const autoRunFired = useRef(false);

  // Maps old unit ID → replacement unit data
  const [unitOverrides, setUnitOverrides] = useState<Record<string, UnitOverride>>({});

  const isCheckRunning = platformChecking || checkingUnitIds.size > 0;
  useEffect(() => {
    if (!isCheckRunning) return;
    const id = setInterval(() => setProgressTick(t => t + 1), 1_000);
    return () => clearInterval(id);
  }, [isCheckRunning]);

  // Load any previously saved unit swaps from the DB, then auto-run the
  // platform check for static builder properties if no swaps are blocking it.
  // Promoted drafts can arrive with freshly scraped photos and should not kick
  // off reverse-image search until the operator explicitly asks for it.
  useEffect(() => {
    if (!id || !property) return;
    fetch(`/api/unit-swaps/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { swaps: any[] } | null) => {
        if (!data?.swaps?.length) {
          if (!isPromotedDraft && !autoRunFired.current) {
            autoRunFired.current = true;
            runPlatformCheck();
          }
          return;
        }
        const restored: Record<string, UnitOverride> = {};
        let allCommitted = true;
        for (const swap of data.swaps) {
          if (!swap?.oldUnitId || restored[swap.oldUnitId]) continue;
          const photoFolder =
            typeof swap.photoFolder === "string" && swap.photoFolder.trim()
              ? swap.photoFolder
              : replacementPhotoFolderForUnit(id, swap.oldUnitId);
          restored[swap.oldUnitId] = {
            unitNumber: swap.newUnitLabel.replace(/^Unit\s*#?/i, "").trim(),
            address: swap.newAddress,
            bedrooms: swap.newBedrooms ?? 1,
            unitLabel: swap.newUnitLabel,
            sourceUrl: swap.newSourceUrl,
            photoFolder,
            swapId: swap.id,
          };
          if (!swap.committed) allCommitted = false;
        }
        setUnitOverrides(restored);
        setSwapsCommitted(allCommitted);
      })
      .catch(() => {
        if (!isPromotedDraft && !autoRunFired.current) {
          autoRunFired.current = true;
          runPlatformCheck();
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, property]);

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
        photoFolder: override.photoFolder ?? u.photoFolder,
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
  const runPlatformCheck = async (
    unitsToCheck = effectiveUnits,
    opts: { fullPhotoAudit?: boolean } = {},
  ) => {
    const fullPhotoAudit = opts.fullPhotoAudit === true;
    setPlatformChecking(true);
    setFullAuditRunning(fullPhotoAudit);
    setLastCheckWasFullAudit(false);
    setPlatformDone(false);
    setResults({});
    setCompletedCount(0);
    setTotalUnits(unitsToCheck.length);
    setCheckPhase("text");
    setCheckStartedAt(Date.now());
    setProgressTick(0);
    const pendingIds = new Set(unitsToCheck.map(u => u.id));
    setCheckingUnitIds(new Set(pendingIds));

    const hasPhotos = unitsToCheck.some(u => !!(u as any).photoFolder);
    if (hasPhotos) setCheckPhase("text");

    await Promise.all(
      unitsToCheck.map(async (unit) => {
        const singleUnitListing = property.units.length === 1;
        const address = (unit as any)._overrideAddress || (singleUnitListing ? property.address : `${property.address}, ${formatUnitDisplayLabel(unit.unitNumber)}`);
        const hasUnitPhoto = !!(unit as any).photoFolder;
        const unitPayload = [{
          unitId: unit.id,
          unitNumber: unit.unitNumber,
          address,
          photoFolder: hasUnitPhoto ? unit.photoFolder : "",
        }];
        const params = new URLSearchParams({
          name: property.propertyName,
          city,
          units: JSON.stringify(unitPayload),
          photoMode: fullPhotoAudit ? "full" : "sample",
          singleListing: singleUnitListing ? "1" : "0",
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
    setFullAuditRunning(false);
    setCheckStartedAt(null);
    setPlatformDone(true);
    setLastCheckWasFullAudit(fullPhotoAudit);
  };

  const rerunChecks = () => {
    setPlatformDone(false);
    setResults({});
    runPlatformCheck();
  };

  const runFullUnitAudit = () => {
    setPlatformDone(false);
    setResults({});
    runPlatformCheck(effectiveUnits, { fullPhotoAudit: true });
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
      photoFolder: newUnit.photoFolder ?? replacementPhotoFolderForUnit(id, oldUnitId),
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
          photoFolder: override.photoFolder ?? u.photoFolder,
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

  const hasAnyResults = Object.keys(results).length > 0;
  const photoFetchJobForUnit = (unitId: string) => photoFetchJobsByUnit[unitId];
  const photoFetchElapsedSeconds = photoFetchTick;
  const photoFetchProgressValue = (unitId: string) => {
    const job = photoFetchJobForUnit(unitId);
    if (job && (job.status === "queued" || job.status === "running")) {
      return Math.min(94, Math.max(8, job.progress));
    }
    return scrapingUnitId === unitId ? Math.min(94, 16 + photoFetchElapsedSeconds * 1.4) : 0;
  };
  const photoFetchPhaseForUnit = (unitId: string) =>
    photoFetchJobForUnit(unitId)?.message ?? "Finding photos";
  const isPhotoFetchActive = (unitId: string) =>
    !!photoFetchJobIdsByUnit[unitId]
    && (!photoFetchJobForUnit(unitId)
      || photoFetchJobForUnit(unitId)!.status === "queued"
      || photoFetchJobForUnit(unitId)!.status === "running");

  const unitsNeedingPhotos = property?.units.filter((u) => (u.photos?.length ?? 0) === 0) ?? [];
  const showFindAllPhotosButton = unitsNeedingPhotos.length >= 2;
  const anyUnitNeedingPhotosFetching = unitsNeedingPhotos.some((u) => isPhotoFetchActive(u.id));

  const handleScrapePhotosForAllUnits = async () => {
    if (id >= 0 || !property) return;
    const targets = property.units
      .map((unit, i) => ({ unit, unitIndex: (i === 0 ? 0 : 1) as 0 | 1 }))
      .filter(
        ({ unit }) => (unit.photos?.length ?? 0) === 0 && !isPhotoFetchActive(unit.id),
      );
    if (targets.length < 2) return;
    await Promise.all(
      targets.map(({ unit, unitIndex }) => handleScrapePhotosForUnit(unitIndex, unit)),
    );
  };

  const actualProgress = totalUnits > 0 ? (completedCount / totalUnits) * 100 : 0;
  const elapsedSeconds = checkStartedAt ? Math.max(progressTick, Math.floor((Date.now() - checkStartedAt) / 1000)) : 0;
  const activeProgressCap = totalUnits > 0
    ? Math.min(96, ((completedCount + 0.85) / totalUnits) * 100)
    : 0;
  const estimatedWorkingProgress = isCheckRunning && totalUnits > 0
    ? Math.min(activeProgressCap, actualProgress + 8 + elapsedSeconds * (checkPhase === "photo" ? 1.8 : 2.5))
    : actualProgress;
  const platformProgressValue = Math.max(actualProgress, estimatedWorkingProgress);
  const visiblePlatformProgressValue = isCheckRunning
    ? Math.max(14, platformProgressValue)
    : platformProgressValue;
  const checkingLabels = effectiveUnits
    .filter((unit) => checkingUnitIds.has(unit.id))
    .map((unit) => formatUnitDisplayLabel(unit.unitNumber))
    .join(", ");
  const canFullUnitAudit = effectiveUnits.some((unit) => !!(unit as any).photoFolder);
  const targetUnit = replacementTargetId
    ? property.units.find(u => u.id === replacementTargetId) ?? property.units[0]
    : property.units[0];
  const parsedReplacementAddress = parsePropertyAddress(property.address);

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

        {/* ── Photo Sources (promoted drafts only) ──
            The reverse-image-search half of the Platform Check needs
            photos to scan. When the wizard's Step 4 scrape didn't
            find a matching Zillow listing, the unit photo folders
            arrive empty. This card calls the same multi-query Zillow
            discovery that /api/replacement/find-unit uses for active
            properties — operator clicks one button per unit, no URL
            paste needed. "Try another" walks through subsequent
            results so a bad first match isn't a dead end. */}
        {isPromotedDraft && (
          <Card className="p-6 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <h2 className="text-base font-semibold">Photo Sources</h2>
              {showFindAllPhotosButton && (
                <Button
                  size="sm"
                  onClick={() => void handleScrapePhotosForAllUnits()}
                  disabled={anyUnitNeedingPhotosFetching}
                  className="h-8 text-xs"
                  data-testid="button-scrape-photos-all-units"
                >
                  {anyUnitNeedingPhotosFetching ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Finding photos for all units…
                    </>
                  ) : (
                    <>
                      <Search className="h-3 w-3 mr-1" />
                      Find Photos for All Units
                    </>
                  )}
                </Button>
              )}
            </div>
            {(() => {
              const allUnitsHavePhotos = property.units.length > 0
                && property.units.every((unit) => (unit.photos?.length ?? 0) > 0);
              const someUnitsHavePhotos = property.units.some((unit) => (unit.photos?.length ?? 0) > 0);
              if (allUnitsHavePhotos) {
                return (
                  <p className="text-sm text-muted-foreground mb-4">
                    Photos are already saved for every unit at{" "}
                    <strong>{property.complexName}</strong>. The Platform Check
                    can use the photos on file when you click <strong>Run check</strong>{" "}
                    below. Use <strong>Find different photos</strong> only if the saved
                    Zillow match looks wrong or you want to replace a unit&apos;s photo set.
                  </p>
                );
              }
              if (someUnitsHavePhotos) {
                return (
                  <p className="text-sm text-muted-foreground mb-4">
                    Some units already have photos saved. Click <strong>Find Photos</strong>{" "}
                    for any unit without photos, or <strong>Find different photos</strong>{" "}
                    if an existing saved match looks wrong. Then click <strong>Run check</strong>{" "}
                    on the Platform Check.
                  </p>
                );
              }
              return (
                <p className="text-sm text-muted-foreground mb-4">
                  The reverse-image-search half of the Platform Check below needs
                  photos to scan. Click <strong>Find Photos for All Units</strong>{" "}
                  (or <strong>Find Photos</strong> per unit) and we&apos;ll search
                  Zillow for representative listings at{" "}
                  <strong>{property.complexName}</strong>, scrape their photos, and
                  save them to the draft. Then click <strong>Run check</strong>{" "}
                  on the Platform Check.
                </p>
              );
            })()}
            <div className="space-y-3">
              {property.units.map((unit, i) => {
                const folderHasPhotos = (unit.photos?.length ?? 0) > 0;
                const skippedCount = (skippedUrlsByUnit[unit.id] ?? []).length;
                const isScrapingThisUnit = isPhotoFetchActive(unit.id);
                const unitProgress = photoFetchProgressValue(unit.id);
                return (
                  <div key={unit.id} className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium w-20 flex-shrink-0">
                      Unit {String.fromCharCode(65 + i)}
                    </span>
                    <span className="text-xs text-muted-foreground flex-1">
                      {unit.bedrooms}BR · ~{unit.sqft || "?"} sqft
                    </span>
                    <Button
                      size="sm"
                      onClick={() => handleScrapePhotosForUnit(i === 0 ? 0 : 1, unit)}
                      disabled={isScrapingThisUnit}
                      className="h-8 text-xs"
                      data-testid={`button-scrape-photos-${unit.id}`}
                    >
                      {isScrapingThisUnit ? (
                        <>
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          Searching… {photoFetchElapsedSeconds}s
                        </>
                      ) : folderHasPhotos ? (
                        <><RefreshCw className="h-3 w-3 mr-1" /> Find different photos</>
                      ) : (
                        <><Search className="h-3 w-3 mr-1" /> Find Photos</>
                      )}
                    </Button>
                    {folderHasPhotos && (
                      <Badge variant="outline" className="text-[10px] flex-shrink-0">
                        {unit.photos.length} on file
                      </Badge>
                    )}
                    {skippedCount > 0 && !folderHasPhotos && (
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        skipped {skippedCount}
                      </span>
                    )}
                    {isScrapingThisUnit && (
                      <div className="basis-full rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs text-blue-900">
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <span className="font-medium">
                            {photoFetchPhaseForUnit(unit.id)}
                          </span>
                          <span className="text-blue-700">
                            {Math.round(unitProgress)}% · safe to leave this tab
                          </span>
                        </div>
                        <div
                          className="h-2 overflow-hidden rounded-full bg-blue-100"
                          role="progressbar"
                          aria-label={`Finding photos for Unit ${String.fromCharCode(65 + i)}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(unitProgress)}
                        >
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 transition-all duration-700"
                            style={{ width: `${unitProgress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* ── Platform Check ── */}
        <Card className="p-6 mb-6">
          <div className="flex items-start justify-between gap-4 mb-1">
            <h2 className="text-base font-semibold">Platform Check</h2>
            {!isCheckRunning && (
              <div className="flex flex-wrap justify-end gap-2">
                {canFullUnitAudit && (
                  <Button
                    id="btn-full-unit-audit"
                    aria-label="Run full unit photo audit"
                    variant="outline"
                    size="sm"
                    onClick={runFullUnitAudit}
                    className="h-7 px-2 text-xs flex-shrink-0"
                  >
                    <Camera className="h-3 w-3 mr-1" />
                    Full unit audit
                  </Button>
                )}
                <Button
                  id={platformDone ? "btn-rerun-checks" : "btn-run-checks"}
                  aria-label={platformDone ? "Re-run platform check" : "Run platform check"}
                  variant="ghost"
                  size="sm"
                  onClick={rerunChecks}
                  className="h-7 px-2 text-xs flex-shrink-0"
                >
                  {platformDone ? (
                    <>
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Re-run
                    </>
                  ) : (
                    <>
                      <Search className="h-3 w-3 mr-1" />
                      Run check
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {isPromotedDraft
              ? "Click Run check when you're ready. It searches Airbnb, VRBO, and Booking.com for each unit using text search and reverse image search."
              : "Searches Airbnb, VRBO, and Booking.com for each unit using text search and reverse image search."}
          </p>
          {lastCheckWasFullAudit && hasAnyResults && (
            <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
              Full unit audit complete: every available photo in each unit folder was checked against Airbnb, VRBO, and Booking.com.
            </div>
          )}

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
                  const unitPhotoFolder = override?.photoFolder ?? origUnit.photoFolder;
                  const positionLabel = `Unit ${String.fromCharCode(65 + idx)}`;
                  const rescrapeHandler = async () => {
                    if (!unitPhotoFolder) {
                      toast({ title: "Can't rescrape", description: "No photoFolder on this unit.", variant: "destructive" });
                      return;
                    }
                    setRescrapingUnitId(origUnit.id);
                    const folder = unitPhotoFolder;
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
                  const receipt = unitPhotoFolder ? rescrapeReceipts[unitPhotoFolder] : undefined;
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
            <div className="mb-4 space-y-2 rounded-md border border-primary/15 bg-primary/5 p-3">
              <style>{`
                @keyframes preflight-progress-stripes {
                  from { background-position: 0 0; }
                  to { background-position: 32px 0; }
                }
              `}</style>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5 font-medium">
                  {fullAuditRunning ? (
                    <><Camera className="h-3.5 w-3.5 animate-pulse text-primary" /> Running full unit photo audit…</>
                  ) : checkPhase === "photo" ? (
                    <><Camera className="h-3.5 w-3.5 animate-pulse text-primary" /> Running photo reverse-image search…</>
                  ) : checkPhase === "text" ? (
                    <><Search className="h-3.5 w-3.5 animate-pulse text-primary" /> Searching Airbnb, VRBO &amp; Booking.com…</>
                  ) : (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</>
                  )}
                </span>
                <span>{completedCount} / {totalUnits} unit{totalUnits !== 1 ? "s" : ""} done · {elapsedSeconds}s</span>
              </div>
              <div
                className="relative h-3 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(visiblePlatformProgressValue)}
                aria-label="Platform check progress"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
                  style={{
                    width: `${Math.min(100, visiblePlatformProgressValue)}%`,
                    backgroundImage:
                      "linear-gradient(45deg, rgba(255,255,255,0.28) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0.28) 75%, transparent 75%, transparent)",
                    backgroundSize: "32px 32px",
                    animation: "preflight-progress-stripes 1s linear infinite",
                  }}
                />
                <div className="absolute inset-0 animate-pulse bg-primary/10" />
              </div>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <p>
                  {fullAuditRunning
                    ? "Checking every available unit photo with Google Lens."
                    : checkPhase === "photo"
                    ? "Uploading photos for reverse-image matches."
                    : "Checking address and unit-number matches."}
                </p>
                <p className="font-medium text-foreground/80">
                  {checkingLabels ? `Working on ${checkingLabels}` : "Finalizing results..."}
                </p>
              </div>
            </div>
          )}

          {/* Results — compact unit-first cards */}
          {(isCheckRunning || hasAnyResults) && (
            <div id="platform-check-table" className="mt-3 space-y-2">
              {effectiveUnits.map((unit) => {
                const unitResult = results[unit.id];
                const isReplaced = (unit as any)._isReplaced;
                const displayAddress = (unit as any)._overrideAddress || `${property.address}, ${formatUnitDisplayLabel(unit.unitNumber)}`;
                const unitChecking = checkingUnitIds.has(unit.id);

                return (
                  <div
                    key={unit.id}
                    id={`check-${unit.id}`}
                    className="rounded-md border border-border/70 bg-background/75 px-3 py-3"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                      <div className="min-w-0 lg:w-64 lg:flex-shrink-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{formatUnitDisplayLabel(unit.unitNumber)}</p>
                          {isReplaced && !swapsCommitted && (
                            <Badge variant="secondary" className="text-[10px] py-0 px-1.5 h-5">
                              replaced
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate" title={displayAddress}>
                          {displayAddress}
                        </p>
                      </div>

                      <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
                        {PLATFORM_LIST.map(({ key, label }) => {
                          const r = unitResult?.platforms[key];
                          return (
                            <div key={key} id={`check-${key}-${unit.id}`} className="rounded border border-border/60 bg-muted/20 px-2.5 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {label}
                                </span>
                                {r?.url && (
                                  <a
                                    id={`link-${key}-${unit.id}`}
                                    href={r.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-primary hover:underline text-[11px]"
                                  >
                                    View <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                              </div>
                              <div className="mt-1.5">
                                <CompactStatusBadge result={r} checking={unitChecking} />
                              </div>
                              {r?.detection && (
                                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground" title={r.detection}>
                                  {r.detection}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {property.communityPhotoFolder && !swapsCommitted && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2.5 text-xs lg:flex-shrink-0"
                          data-testid={`button-replace-unit-${unit.id}`}
                          onClick={() => {
                            setReplacementTargetId(unit.id);
                            setShowReplacementFlow(true);
                          }}
                        >
                          <RefreshCw className="h-3 w-3 mr-1" />
                          {isReplaced ? "Change" : "Replace"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
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
          {property.communityPhotoFolder && (
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
              Find / Replace a Unit
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
                replacementSourceUrl: unitOverrides[u.id]?.sourceUrl,
              }))}
              communityFolder={property.communityPhotoFolder}
              communityName={property.complexName}
              propertyAddress={property.address}
              streetAddress={parsedReplacementAddress.street || undefined}
              city={parsedReplacementAddress.city || undefined}
              state={parsedReplacementAddress.state || undefined}
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
