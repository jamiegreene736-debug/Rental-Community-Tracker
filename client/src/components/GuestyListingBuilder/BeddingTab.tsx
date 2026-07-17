import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { guestyService } from "@/services/guestyService";
import {
  type PropertyBeddingConfig,
  type UnitBeddingConfig,
  type BedroomDetail,
  type BathroomDetail,
  type BathFeature,
  BATH_FEATURE_LABELS,
  BED_TYPE_LABELS,
  loadBeddingConfig,
  saveBeddingConfig,
  resetBeddingConfig,
  loadSpaceTextOverride,
  saveSpaceTextOverride,
  clearSpaceTextOverride,
  buildGuestyListingRooms,
  buildSpaceDescription,
  totalBedrooms,
  totalBathrooms,
  headlineSleeps,
  describeUnitBedding,
} from "@/data/bedding-config";
import type { GuestyBedType } from "@/data/guesty-listing-config";
import {
  BEDDING_SCAN_MIN_CONFIDENCE,
  BEDDING_SCAN_FEATURE_LABELS,
  autoApplyBeddingScanToUnits,
  describeDetectedBeds,
  isBeddingScanAutoApplyEligible,
  hydrateBeddingAuditApplication,
  mergeBeddingScanIntoUnit,
  type BeddingPhotoScanRecord,
  type BeddingScanUnit,
} from "@shared/bedding-photo-scan";

const BED_TYPES: GuestyBedType[] = ["KING_BED", "QUEEN_BED", "DOUBLE_BED", "SINGLE_BED", "SOFA_BED", "BUNK_BED"];
const BATH_FEATURES: BathFeature[] = ["walk-in-shower", "shower-tub-combo", "soaking-tub", "jetted-tub", "rain-shower", "double-vanity"];
const auditHydrationKey = (propertyId: number) => `nexstay_bedding_audit_application_${propertyId}`;

const cellStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  background: "#fff",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#6b7280",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 13,
  background: "#fff",
};

const chipBase: React.CSSProperties = {
  fontSize: 11,
  padding: "3px 9px",
  borderRadius: 999,
  border: "1px solid #d1d5db",
  cursor: "pointer",
  userSelect: "none",
  background: "#fff",
  color: "#374151",
};

const chipActive: React.CSSProperties = {
  ...chipBase,
  background: "#1e40af",
  color: "#fff",
  borderColor: "#1e40af",
};

interface Props {
  propertyId: number;
  guestyListingId: string | null;
  onGuestyPushRecorded?: (status: "success" | "error", message: string) => void;
}

type BeddingScanOutcome = {
  tone: "success" | "warning";
  message: string;
};

type BeddingScanWorkflowResult = {
  record?: BeddingPhotoScanRecord;
  configSnapshot?: string;
  applied: Record<string, string>;
  outcome?: BeddingScanOutcome;
  error?: string;
};

type ActiveBeddingScanWorkflow = {
  done: Promise<BeddingScanWorkflowResult>;
  finish: (result: BeddingScanWorkflowResult) => void;
};

// The parent unmounts this tab when the operator navigates elsewhere. Keep the
// one authoritative workflow outside the component so a remount cannot launch
// a duplicate scan/push while the original request is still completing.
const activeBeddingScanWorkflows = new Map<number, ActiveBeddingScanWorkflow>();
const completedBeddingScanWorkflows = new Map<number, BeddingScanWorkflowResult>();
const latestBeddingConfigs = new Map<number, PropertyBeddingConfig>();

function beginBeddingScanWorkflow(propertyId: number): ActiveBeddingScanWorkflow | null {
  if (activeBeddingScanWorkflows.has(propertyId)) return null;
  completedBeddingScanWorkflows.delete(propertyId);
  let finish = (_result: BeddingScanWorkflowResult) => {};
  const done = new Promise<BeddingScanWorkflowResult>((resolve) => { finish = resolve; });
  const workflow = { done, finish };
  activeBeddingScanWorkflows.set(propertyId, workflow);
  return workflow;
}

function finishBeddingScanWorkflow(
  propertyId: number,
  workflow: ActiveBeddingScanWorkflow,
  result: BeddingScanWorkflowResult,
): void {
  if (activeBeddingScanWorkflows.get(propertyId) === workflow) {
    activeBeddingScanWorkflows.delete(propertyId);
  }
  completedBeddingScanWorkflows.set(propertyId, result);
  workflow.finish(result);
}

export function BeddingTab({ propertyId, guestyListingId, onGuestyPushRecorded }: Props) {
  const { toast } = useToast();
  const [config, setConfig] = useState<PropertyBeddingConfig>(() => {
    const initial = loadBeddingConfig(propertyId);
    latestBeddingConfigs.set(propertyId, initial);
    return initial;
  });
  const [pushing, setPushing] = useState(false);
  // spaceDirty = the operator hand-edited the Space text; auto-regeneration is
  // paused and the text persists across tab switches until "Regenerate".
  const [spaceDirty, setSpaceDirty] = useState(() => loadSpaceTextOverride(propertyId) != null);
  const [spaceText, setSpaceText] = useState(() =>
    loadSpaceTextOverride(propertyId) ?? buildSpaceDescription(loadBeddingConfig(propertyId)));
  const [pushingSpace, setPushingSpace] = useState(false);
  // Bedding PHOTO scan — a fresh button click auto-applies detections strictly
  // above 60%, saves the merged config, then builds the supported Guesty
  // Bedding projection from it when a listing is connected.
  // Ordinary stored scans are read-only. A strict Dashboard audit application
  // receipt may hydrate once after its local save succeeds, so a no-Guesty
  // audit materializes without overwriting later operator edits.
  const [beddingScan, setBeddingScan] = useState<BeddingPhotoScanRecord | null>(null);
  const [beddingScanFresh, setBeddingScanFresh] = useState(false);
  const [beddingScanning, setBeddingScanning] = useState(() => activeBeddingScanWorkflows.has(propertyId));
  const [beddingScanError, setBeddingScanError] = useState<string | null>(null);
  const [beddingScanApplied, setBeddingScanApplied] = useState<Record<string, string>>({});
  const [beddingScanOutcome, setBeddingScanOutcome] = useState<BeddingScanOutcome | null>(null);
  const configRef = useRef(config);
  const activePropertyIdRef = useRef(propertyId);
  const latestScanTimestampRef = useRef(0);
  const scanInFlightRef = useRef(false);
  const pushInFlightRef = useRef(false);
  configRef.current = config;
  activePropertyIdRef.current = propertyId;

  const acceptScanRecord = useCallback((record: BeddingPhotoScanRecord, fresh: boolean): boolean => {
    const timestamp = Date.parse(record.scannedAt);
    const comparableTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
    if (comparableTimestamp < latestScanTimestampRef.current) return false;
    const completed = completedBeddingScanWorkflows.get(propertyId);
    const completedTimestamp = completed?.record ? Date.parse(completed.record.scannedAt) : Number.NaN;
    if (completed?.record && Number.isFinite(completedTimestamp) && comparableTimestamp > completedTimestamp) {
      // A newer audit/stored scan is read-only. Never attach an older explicit
      // click's "applied/pushed" outcome to that newer evidence record.
      completedBeddingScanWorkflows.delete(propertyId);
      setBeddingScanApplied({});
      setBeddingScanOutcome(null);
      setBeddingScanError(null);
    }
    latestScanTimestampRef.current = comparableTimestamp;
    setBeddingScan(record);
    setBeddingScanFresh(fresh);
    return true;
  }, [propertyId]);

  // Reload when property changes
  useEffect(() => {
    latestScanTimestampRef.current = 0;
    const c = loadBeddingConfig(propertyId);
    latestBeddingConfigs.set(propertyId, c);
    configRef.current = c;
    setConfig(c);
    const override = loadSpaceTextOverride(propertyId);
    setSpaceDirty(override != null);
    setSpaceText(override ?? buildSpaceDescription(c));
  }, [propertyId]);

  // If the tab remounts while its original workflow is still running, consume
  // its one shared result. Completed results remain available for later in-app
  // remounts so push failures and retry copy cannot disappear on a tab change.
  useEffect(() => {
    let cancelled = false;
    const workflow = activeBeddingScanWorkflows.get(propertyId);
    setBeddingScanning(workflow != null);
    const applyResult = (result: BeddingScanWorkflowResult) => {
      if (cancelled) return;
      // The workflow saved before resolving. Always hydrate the current
      // localStorage value so a later remount cannot replay its old snapshot
      // over manual edits made after completion.
      const saved = loadBeddingConfig(propertyId);
      latestBeddingConfigs.set(propertyId, saved);
      configRef.current = saved;
      setConfig(saved);
      setBeddingScanning(false);
      const accepted = result.record ? acceptScanRecord(result.record, true) : true;
      if (!accepted) {
        // A newer audit scan won the timestamp race while this click was still
        // pushing. Keep the newer evidence and never attach this older click's
        // outcome/applied notes to it.
        completedBeddingScanWorkflows.delete(propertyId);
        setBeddingScanApplied({});
        setBeddingScanOutcome(null);
        setBeddingScanError(null);
        return;
      }
      setBeddingScanApplied(result.applied);
      setBeddingScanOutcome(result.outcome ?? null);
      setBeddingScanError(result.error ?? null);
    };

    if (workflow) void workflow.done.then(applyResult);
    else {
      const completed = completedBeddingScanWorkflows.get(propertyId);
      if (completed) applyResult(completed);
    }
    return () => { cancelled = true; };
  }, [acceptScanRecord, propertyId]);

  // Hydrate the last stored photo scan (an audit sweep may have already paid
  // for one — the store is shared with the unit-audit layout stage).
  useEffect(() => {
    let cancelled = false;
    const hasWorkflowContext = activeBeddingScanWorkflows.has(propertyId)
      || completedBeddingScanWorkflows.has(propertyId);
    if (!hasWorkflowContext) {
      setBeddingScan(null);
      setBeddingScanFresh(false);
      setBeddingScanError(null);
      setBeddingScanApplied({});
      setBeddingScanOutcome(null);
    }
    fetch(`/api/builder/bedding-photo-scan/${propertyId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.record) return;
        const record = data.record as BeddingPhotoScanRecord;
        const fresh = data.fresh === true;
        if (!acceptScanRecord(record, fresh)) return;

        const application = record.auditApplication;
        let alreadyHydrated = false;
        try {
          alreadyHydrated = !!application && localStorage.getItem(auditHydrationKey(propertyId)) === application.id;
        } catch { /* storage unavailable: still show the durable server receipt */ }
        if (!fresh || !application || alreadyHydrated) return;

        const current = loadBeddingConfig(propertyId);
        const hydrated = hydrateBeddingAuditApplication(current, record);
        const nextConfig = hydrated.config as PropertyBeddingConfig;
        if (!saveBeddingConfig(nextConfig)) {
          setBeddingScanError("The Dashboard audit receipt could not be saved in this browser, so it was not marked as hydrated.");
          return;
        }
        try { localStorage.setItem(auditHydrationKey(propertyId), application.id); } catch {}
        if (cancelled) return;
        latestBeddingConfigs.set(propertyId, nextConfig);
        configRef.current = nextConfig;
        setConfig(nextConfig);
        setBeddingScanApplied(Object.fromEntries(
          Object.entries(hydrated.appliedByUnitId).map(([unitId, lines]) => [unitId, lines.join(" · ")]),
        ));
      })
      .catch(() => { /* proposal panel just stays hidden */ });
    return () => { cancelled = true; };
  }, [acceptScanRecord, propertyId]);

  // Auto-persist on change + refresh generated space text (unless hand-edited)
  useEffect(() => {
    if (!spaceDirty) setSpaceText(buildSpaceDescription(config));
    // A remounted tab initially holds the pre-scan config while the shared
    // workflow finishes. That stale render must never overwrite the config the
    // workflow explicitly saves immediately before its Guesty push.
    if (activeBeddingScanWorkflows.has(propertyId)) return;
    latestBeddingConfigs.set(propertyId, config);
    saveBeddingConfig(config);
    const completed = completedBeddingScanWorkflows.get(propertyId);
    if (completed?.configSnapshot && completed.configSnapshot !== JSON.stringify(config)) {
      completedBeddingScanWorkflows.delete(propertyId);
      setBeddingScanApplied({});
      setBeddingScanOutcome({
        tone: "warning",
        message: "Bedding was edited after the photo scan. The current edits are saved in this browser; push Bedding to Guesty when ready.",
      });
    }
  }, [config, spaceDirty]);

  const totals = useMemo(() => ({
    bedrooms: totalBedrooms(config),
    bathrooms: totalBathrooms(config),
    // "Sleeps" / the Guesty `accommodates` we push follow the single headline
    // occupancy rule (occupancyForBedrooms), NOT the literal bed capacity, so
    // this tab agrees with the listing title, summary, and dashboard. (Per-unit
    // "· sleeps N" lines below stay literal bed counts.)
    sleeps: headlineSleeps(propertyId, config),
    rooms: buildGuestyListingRooms(config).length,
  }), [config, propertyId]);

  // ── Mutators ────────────────────────────────────────────────────────────
  const updateUnit = useCallback((unitId: string, fn: (u: UnitBeddingConfig) => UnitBeddingConfig) => {
    setConfig(c => {
      const next = { ...c, units: c.units.map(u => u.unitId === unitId ? fn(u) : u) };
      latestBeddingConfigs.set(next.propertyId, next);
      return next;
    });
  }, []);

  const updateBedroom = (unitId: string, roomNumber: number, fn: (b: BedroomDetail) => BedroomDetail) =>
    updateUnit(unitId, u => ({ ...u, bedrooms: u.bedrooms.map(b => b.roomNumber === roomNumber ? fn(b) : b) }));

  const updateBathroom = (unitId: string, bathId: string, fn: (b: BathroomDetail) => BathroomDetail) =>
    updateUnit(unitId, u => ({ ...u, bathrooms: u.bathrooms.map(b => b.id === bathId ? fn(b) : b) }));

  const addBathroom = (unitId: string) => updateUnit(unitId, u => ({
    ...u, bathrooms: [...u.bathrooms, {
      id: `bath-${Date.now()}`, label: `Bath ${u.bathrooms.length + 1}`,
      isHalf: false, features: ["shower-tub-combo"],
    }],
  }));
  const removeBathroom = (unitId: string, bathId: string) =>
    updateUnit(unitId, u => ({ ...u, bathrooms: u.bathrooms.filter(b => b.id !== bathId) }));

  const addBedroom = (unitId: string) => updateUnit(unitId, u => ({
    ...u, bedrooms: [...u.bedrooms, {
      roomNumber: u.bedrooms.length + 1,
      label: `Bedroom ${u.bedrooms.length + 1}`,
      beds: [{ type: "QUEEN_BED", quantity: 1 }],
      hasEnsuite: false, ensuiteFeatures: [],
    }],
  }));
  const removeBedroom = (unitId: string, roomNumber: number) => updateUnit(unitId, u => ({
    ...u, bedrooms: u.bedrooms.filter(b => b.roomNumber !== roomNumber)
                              .map((b, i) => ({ ...b, roomNumber: i + 1 })),
  }));

  // ── Push to Guesty ──────────────────────────────────────────────────────
  const pushBeddingConfigToGuesty = useCallback(async (
    listingId: string,
    configToPush: PropertyBeddingConfig,
  ): Promise<{
    ok: boolean;
    bedrooms: number;
    bathrooms: number;
    sleeps: number;
    error?: string;
  }> => {
    const bedrooms = totalBedrooms(configToPush);
    const bathrooms = totalBathrooms(configToPush);
    const sleeps = headlineSleeps(configToPush.propertyId, configToPush);
    if (pushInFlightRef.current) {
      return { ok: false, bedrooms, bathrooms, sleeps, error: "A bedding push is already in progress." };
    }

    pushInFlightRef.current = true;
    setPushing(true);
    try {
      await guestyService.updateListingDetails(listingId, {
        bedrooms: bedrooms || undefined,
        bathrooms: bathrooms || undefined,
        accommodates: sleeps || undefined,
        listingRooms: buildGuestyListingRooms(configToPush),
      });
      const message = `Bedding updated: ${bedrooms} BR, ${bathrooms} bath, sleeps ${sleeps}`;
      onGuestyPushRecorded?.("success", message);
      return { ok: true, bedrooms, bathrooms, sleeps };
    } catch (e) {
      const error = (e as Error).message;
      onGuestyPushRecorded?.("error", error);
      return { ok: false, bedrooms, bathrooms, sleeps, error };
    } finally {
      pushInFlightRef.current = false;
      setPushing(false);
    }
  }, [onGuestyPushRecorded]);

  const handlePush = useCallback(async () => {
    if (!guestyListingId || pushing || beddingScanning) return;
    const result = await pushBeddingConfigToGuesty(guestyListingId, config);
    if (result.ok) {
      const completed = completedBeddingScanWorkflows.get(propertyId);
      if (completed?.outcome?.message.includes("Guesty push failed")) {
        const outcome: BeddingScanOutcome = {
          tone: "success",
          message: `Manual retry succeeded. Guesty now has ${result.bedrooms} bedrooms, ${result.bathrooms} bathrooms, sleeps ${result.sleeps}, and the saved bed layout.`,
        };
        completedBeddingScanWorkflows.set(propertyId, { ...completed, outcome, error: undefined });
        setBeddingScanOutcome(outcome);
        setBeddingScanError(null);
      }
      toast({
        title: "Bedding pushed to Guesty",
        description: `${result.bedrooms} bedroom${result.bedrooms !== 1 ? "s" : ""}, ${result.bathrooms} bath${result.bathrooms !== 1 ? "s" : ""}, sleeps ${result.sleeps}.`,
      });
      return;
    }
    toast({ title: "Push failed", description: result.error, variant: "destructive" });
  }, [beddingScanning, config, guestyListingId, propertyId, pushing, pushBeddingConfigToGuesty, toast]);

  // ── Bedding photo scan ────────────────────────────────────────────────────
  const handleBeddingScan = useCallback(async () => {
    if (beddingScanning || scanInFlightRef.current || pushInFlightRef.current) return;
    const scannedPropertyId = propertyId;
    const scannedGuestyListingId = guestyListingId;
    const workflow = beginBeddingScanWorkflow(scannedPropertyId);
    if (!workflow) return;
    const completion: BeddingScanWorkflowResult = { applied: {} };
    scanInFlightRef.current = true;
    setBeddingScanning(true);
    setBeddingScanError(null);
    setBeddingScanOutcome(null);
    setBeddingScanApplied({});
    try {
      const r = await fetch("/api/builder/bedding-photo-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId: scannedPropertyId }),
        cache: "no-store",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.record) throw new Error(data?.error ?? `HTTP ${r.status}`);
      const record = data.record as BeddingPhotoScanRecord;
      if (record.propertyId !== scannedPropertyId) {
        throw new Error("The bedding scan response did not match this property.");
      }
      completion.record = record;
      // A scan can take minutes. Never apply an old property's completion after
      // the operator has navigated to a different builder.
      if (activePropertyIdRef.current !== scannedPropertyId) {
        completion.outcome = {
          tone: "warning",
          message: "The scan and timestamp were saved, but this builder moved to another property before completion, so nothing was applied or pushed.",
        };
        return;
      }
      if (!acceptScanRecord(record, true)) {
        // Another scan/audit completed after this click and is already on
        // screen. Never apply or push older evidence over that newer record.
        completion.record = undefined;
        completion.outcome = {
          tone: "warning",
          message: "This scan finished after a newer bedding scan was already saved, so its older suggestions were not applied or pushed.",
        };
        setBeddingScanOutcome(completion.outcome);
        toast({ title: "Older bedding scan ignored", description: completion.outcome.message });
        return;
      }

      // A scan can outlive the component that started it. Merge into the latest
      // config from a remounted tab instead of the starter's stale closure.
      const liveConfig = latestBeddingConfigs.get(scannedPropertyId);
      const currentConfig = liveConfig?.propertyId === scannedPropertyId
        ? liveConfig
        : loadBeddingConfig(scannedPropertyId);
      const autoApplied = autoApplyBeddingScanToUnits(currentConfig.units, record.units);
      const nextConfig: PropertyBeddingConfig = { ...currentConfig, units: autoApplied.units };

      // Persist before any external write. A failed Guesty push never rolls back
      // the photo-proven builder config or the server-stamped scan record.
      if (!saveBeddingConfig(nextConfig)) {
        throw new Error("The scan finished, but the bedding layout could not be saved in this browser. Guesty was not updated.");
      }
      completion.configSnapshot = JSON.stringify(nextConfig);
      latestBeddingConfigs.set(scannedPropertyId, nextConfig);
      configRef.current = nextConfig;
      setConfig(nextConfig);
      completion.applied = Object.fromEntries(autoApplied.appliedUnits.map((unit) => [
        unit.unitId,
        unit.applied.join(" · "),
      ]));
      setBeddingScanApplied(completion.applied);

      const scannedAt = new Date(record.scannedAt).toLocaleString();
      const captionOnlyCount = autoApplied.skippedScanUnits.filter((unit) => unit.reason === "non-vision-evidence").length;
      const unmatchedCount = autoApplied.skippedScanUnits.length - captionOnlyCount;
      const captionSuffix = captionOnlyCount > 0
        ? ` ${captionOnlyCount} caption-derived unit result${captionOnlyCount === 1 ? " was" : "s were"} left review-only because Claude did not successfully inspect those photos.`
        : "";
      const unmatchedSuffix = unmatchedCount > 0
        ? ` ${unmatchedCount} unmatched unit result${unmatchedCount === 1 ? " was" : "s were"} left untouched.`
        : "";
      const skippedSuffix = captionSuffix + unmatchedSuffix;
      if (autoApplied.appliedUnits.length === 0) {
        const message = `Scan saved at ${scannedAt}. No vision-backed bed or full-bath feature strictly above 60% changed the configured layout, so nothing was applied or pushed.${skippedSuffix}`;
        completion.outcome = { tone: "warning", message };
        setBeddingScanOutcome(completion.outcome);
        toast({ title: "Bedding scan saved", description: message });
        return;
      }

      const appliedCount = autoApplied.appliedUnits.length;
      if (!scannedGuestyListingId) {
        const message = `Auto-applied and saved vision-backed suggestions above 60% for ${appliedCount} unit${appliedCount === 1 ? "" : "s"} at ${scannedAt}. No Guesty listing was connected when the scan began, so no push was attempted.${skippedSuffix}`;
        completion.outcome = { tone: "success", message };
        setBeddingScanOutcome(completion.outcome);
        toast({ title: "Bedding scan applied and saved", description: message });
        return;
      }

      // The property, listing id, and recording callback are all captured from
      // the click render. A later selection can never redirect this write.
      const pushed = await pushBeddingConfigToGuesty(scannedGuestyListingId, nextConfig);
      if (pushed.ok) {
        const message = `Auto-applied and saved vision-backed suggestions above 60% for ${appliedCount} unit${appliedCount === 1 ? "" : "s"}, then pushed the Guesty listing selected when the scan began: ${pushed.bedrooms} bedrooms, ${pushed.bathrooms} bathrooms, sleeps ${pushed.sleeps}, and the bed layout.${skippedSuffix}`;
        completion.outcome = { tone: "success", message };
        setBeddingScanOutcome(completion.outcome);
        toast({ title: "Bedding scan applied and pushed to Guesty", description: message });
        return;
      }

      const message = `The scan and auto-applied layout were saved at ${scannedAt}, but the Guesty push failed: ${pushed.error ?? "Unknown error"}. Use “Push Bedding to Guesty” to retry.${skippedSuffix}`;
      completion.outcome = { tone: "warning", message };
      setBeddingScanOutcome(completion.outcome);
      toast({ title: "Saved, but Guesty was not updated", description: message, variant: "destructive" });
    } catch (e) {
      completion.error = (e as Error).message;
      if (activePropertyIdRef.current === scannedPropertyId) {
        setBeddingScanError(completion.error);
        toast({ title: "Bedding photo workflow failed", description: completion.error, variant: "destructive" });
      }
    } finally {
      scanInFlightRef.current = false;
      setBeddingScanning(false);
      finishBeddingScanWorkflow(scannedPropertyId, workflow, completion);
    }
  }, [acceptScanRecord, beddingScanning, guestyListingId, propertyId, pushBeddingConfigToGuesty, toast]);

  const handleApplyBeddingScan = useCallback((scanUnit: BeddingScanUnit) => {
    const target = scanUnit.unitId
      ? config.units.find((unit) => unit.unitId === scanUnit.unitId)
      : undefined;
    if (!target || scanUnit.evidenceMethod !== "vision") {
      toast({ title: "Review only", description: "Only vision-backed results with a canonical unit ID can be applied." });
      return;
    }
    const result = mergeBeddingScanIntoUnit(target, scanUnit, { requireAboveMinimum: true });
    if (!result.changed) {
      toast({ title: "Nothing to apply", description: "No detection was above the 60% auto-apply threshold for this unit." });
      return;
    }
    updateUnit(target.unitId, () => result.unit);
    setBeddingScanApplied((prev) => ({ ...prev, [target.unitId]: result.applied.join(" · ") }));
    toast({
      title: `Applied photo-detected bedding to Unit ${target.unitLabel}`,
      description: [...result.applied, ...result.notes].join(" · ").slice(0, 300)
        + " — saved in the builder; push again if you want this re-apply sent to Guesty.",
    });
  }, [config.units, toast, updateUnit]);

  const handleReset = () => {
    if (!confirm("Reset bedding config for this property to defaults? Your edits will be lost.")) return;
    const c = resetBeddingConfig(propertyId);
    latestBeddingConfigs.set(propertyId, c);
    clearSpaceTextOverride(propertyId);
    setSpaceDirty(false);
    setConfig(c);
    setSpaceText(buildSpaceDescription(c));
  };

  const handleSpaceTextEdit = (text: string) => {
    setSpaceText(text);
    setSpaceDirty(true);
    saveSpaceTextOverride(propertyId, text);
  };

  const handleRegenerateSpace = () => {
    clearSpaceTextOverride(propertyId);
    setSpaceDirty(false);
    setSpaceText(buildSpaceDescription(config));
  };

  const handlePushSpace = useCallback(async () => {
    if (!guestyListingId || pushingSpace || !spaceText.trim()) return;
    setPushingSpace(true);
    try {
      await guestyService.updateSpaceDescription(guestyListingId, spaceText);
      toast({
        title: "Space description pushed to Guesty",
        description: "The bedroom names and configuration are now in your listing's Space field.",
      });
    } catch (e) {
      toast({ title: "Push failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setPushingSpace(false);
    }
  }, [guestyListingId, pushingSpace, spaceText, toast]);

  return (
    <fieldset
      data-testid="bedding-tab"
      disabled={beddingScanning || pushing}
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
    >
      {/* Summary header */}
      <div style={{ ...cellStyle, background: "#eff6ff", border: "1px solid #bfdbfe", display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
        <div>
          <div style={labelStyle}>Total Bedrooms</div>
          <div style={{ fontSize: 22, fontWeight: 700 }} data-testid="text-total-bedrooms">{totals.bedrooms}</div>
        </div>
        <div>
          <div style={labelStyle}>Total Bathrooms</div>
          <div style={{ fontSize: 22, fontWeight: 700 }} data-testid="text-total-bathrooms">{totals.bathrooms}</div>
        </div>
        <div>
          <div style={labelStyle}>Sleeps</div>
          <div style={{ fontSize: 22, fontWeight: 700 }} data-testid="text-total-sleeps">{totals.sleeps}</div>
        </div>
        <div>
          <div style={labelStyle}>Guesty Rooms Payload</div>
          <div style={{ fontSize: 13, color: "#374151" }}>
            {totals.rooms} room{totals.rooms !== 1 ? "s" : ""} (bedrooms + sofa-bed entries)
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={handleBeddingScan}
            disabled={beddingScanning || pushing}
            style={{
              ...inputStyle, cursor: beddingScanning || pushing ? "wait" : "pointer",
              background: beddingScanning ? "#c4b5fd" : "#7c3aed", color: "#fff",
              borderColor: "transparent", fontWeight: 600,
            }}
            data-testid="btn-bedding-scan"
            title="Runs a fresh scan, saves vision-backed suggestions above 60%, and pushes the supported bedding fields to the Guesty listing selected at click time"
          >
            {beddingScanning ? (pushing ? "⏳ Pushing scanned bedding…" : "⏳ Claude is reading the photos…") : "🔎 Scan photos for bedding"}
          </button>
          <button
            onClick={handleReset}
            style={{ ...inputStyle, cursor: "pointer", color: "#6b7280" }}
            data-testid="btn-reset-bedding"
          >
            Reset to defaults
          </button>
          <button
            onClick={handlePush}
            disabled={!guestyListingId || pushing || beddingScanning}
            style={{
              ...inputStyle, cursor: guestyListingId ? "pointer" : "not-allowed",
              background: pushing ? "#94a3b8" : "#0f766e", color: "#fff",
              borderColor: "transparent", fontWeight: 600,
            }}
            data-testid="btn-push-bedding"
            title={guestyListingId ? "Push bedrooms, bathrooms, and listingRooms to Guesty" : "Select a Guesty listing first"}
          >
            {pushing ? "Pushing…" : "↑ Push Bedding to Guesty"}
          </button>
        </div>
      </div>

      {/* Bedding photo scan — fresh button clicks auto-apply; stored scans stay review-only. */}
      {beddingScanError && (
        <div style={{ ...cellStyle, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 13 }}>
          Bedding photo workflow failed: {beddingScanError}
        </div>
      )}
      {beddingScan && (
        <div style={{ ...cellStyle, background: "#f5f3ff", border: "1px solid #ddd6fe" }} data-testid="bedding-scan-panel">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#5b21b6" }}>
              {beddingScan.method === "vision" ? "🤖 Claude read the unit photos" : "🏷 Proposal from existing photo labels (vision unavailable)"}
            </div>
            <div style={{ fontSize: 11, color: "#7c6f9f" }}>
              scanned <time dateTime={beddingScan.scannedAt}>{new Date(beddingScan.scannedAt).toLocaleString()}</time>
            </div>
            {!beddingScanFresh && Object.keys(beddingScan.fingerprints ?? {}).length > 0 && (
              <span style={{ fontSize: 11, background: "#fef3c7", border: "1px solid #fcd34d", color: "#92400e", borderRadius: 999, padding: "2px 8px" }}>
                photos changed since this scan — re-scan for current evidence
              </span>
            )}
            {beddingScan.auditApplication && (
              <span style={{ fontSize: 11, background: "#dcfce7", border: "1px solid #86efac", color: "#166534", borderRadius: 999, padding: "2px 8px" }}>
                Dashboard audit applied {new Date(beddingScan.auditApplication.appliedAt).toLocaleString()}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
            A fresh button click automatically applies and saves vision-backed bedding and full-bath suggestions strictly
            above 60%, then pushes Guesty's supported Bedding fields (bed layout, bedroom/bathroom counts, and occupancy)
            to the listing selected when you clicked. Caption fallback is review-only and never auto-pushes. Shower/tub
            details stay saved in this browser's builder config and generated Space copy because Guesty has no structured
            field for them. Bedrooms without photo evidence and suggestions at 60% or below stay exactly as configured.
            {beddingScan.auditApplication
              ? " This strict Dashboard-audit receipt may hydrate once by canonical unit ID; edits you make afterward remain yours."
              : " Stored scan hydration is read-only."}
          </div>
          {beddingScanOutcome && (
            <div style={{
              fontSize: 12,
              color: beddingScanOutcome.tone === "success" ? "#047857" : "#92400e",
              background: beddingScanOutcome.tone === "success" ? "#ecfdf5" : "#fffbeb",
              border: `1px solid ${beddingScanOutcome.tone === "success" ? "#a7f3d0" : "#fde68a"}`,
              borderRadius: 6,
              padding: "6px 8px",
              marginBottom: 10,
            }} data-testid="bedding-scan-outcome">
              {beddingScanOutcome.message}
            </div>
          )}
          {beddingScan.units.length === 0 && (
            <div style={{ fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "6px 8px" }}>
              The scan completed and was timestamped, but no unit photos were available to apply.
            </div>
          )}
          {beddingScan.units.map((su, i) => {
            const cfgUnit = su.unitId
              ? config.units.find((unit) => unit.unitId === su.unitId)
              : undefined;
            const confidentBedrooms = su.bedrooms.filter((b) =>
              isBeddingScanAutoApplyEligible(b.confidence));
            const lowBedrooms = su.bedrooms.length - confidentBedrooms.length;
            const confidentBaths = su.bathrooms.filter((b) =>
              isBeddingScanAutoApplyEligible(b.confidence));
            const actionableBaths = confidentBaths.filter((b) => !b.isHalf && b.features.length > 0);
            const canApply = su.evidenceMethod === "vision"
              && cfgUnit != null
              && (confidentBedrooms.length > 0 || actionableBaths.length > 0);
            const appliedNote = cfgUnit ? beddingScanApplied[cfgUnit.unitId] : undefined;
            return (
              <div key={`${su.folder}-${i}`} style={{ background: "#fff", border: "1px solid #e9e5f8", borderRadius: 6, padding: 10, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{su.label}</div>
                  <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace" }}>{su.folder}</div>
                  {su.photosScanned > 0 && (
                    <div style={{ fontSize: 11, color: "#6b7280" }}>{su.photosScanned} photos read</div>
                  )}
                  <div style={{ fontSize: 11, color: su.evidenceMethod === "vision" ? "#047857" : "#92400e" }}>
                    {su.evidenceMethod === "vision" ? "Vision evidence" : "Caption fallback — review only"}
                  </div>
                  {cfgUnit && (
                    <button
                      onClick={() => handleApplyBeddingScan(su)}
                      disabled={!canApply}
                      style={{
                        ...inputStyle, marginLeft: "auto", cursor: canApply ? "pointer" : "not-allowed",
                        background: canApply ? "#059669" : "#e5e7eb",
                        color: canApply ? "#fff" : "#9ca3af",
                        borderColor: "transparent", fontWeight: 600, fontSize: 12,
                      }}
                      data-testid={`btn-bedding-apply-${cfgUnit.unitId}`}
                    >
                      {appliedNote ? "↻ Reapply" : "✓ Apply"} to Unit {cfgUnit.unitLabel}
                    </button>
                  )}
                </div>
                {appliedNote && (
                  <div style={{ fontSize: 12, color: "#047857", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 6, padding: "4px 8px", marginBottom: 6 }}>
                    ✓ Applied and saved: {appliedNote}{beddingScan.auditApplication ? " — Dashboard audit receipt." : ""}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                  {confidentBedrooms.map((b, bi) => (
                    <span key={bi} style={{ fontSize: 12, background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3", borderRadius: 999, padding: "3px 10px" }}>
                      🛏 {describeDetectedBeds(b.beds)}
                      {b.ensuiteFeatures.length > 0 && ` · en-suite (${b.ensuiteFeatures.map((f) => BEDDING_SCAN_FEATURE_LABELS[f]).join(", ")})`}
                      {` · ${Math.round(b.confidence * 100)}%`}
                    </span>
                  ))}
                  {confidentBaths.map((b, bi) => (
                    <span key={`bath-${bi}`} style={{ fontSize: 12, background: "#ecfeff", border: "1px solid #a5f3fc", color: "#155e75", borderRadius: 999, padding: "3px 10px" }}>
                      🛁 {b.isHalf ? "Half bath" : b.features.map((f) => BEDDING_SCAN_FEATURE_LABELS[f]).join(", ")}
                      {` · ${Math.round(b.confidence * 100)}%`}
                      {b.isHalf && " · evidence only; counts stay unchanged"}
                    </span>
                  ))}
                  {confidentBedrooms.length === 0 && confidentBaths.length === 0 && (
                    <span style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>
                      No bed or bathroom could be confidently identified in this unit's photos.
                    </span>
                  )}
                </div>
                {(su.unphotographedBedrooms > 0 || lowBedrooms > 0 || su.warning) && (
                  <div style={{ fontSize: 11, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "4px 8px" }}>
                    {su.unphotographedBedrooms > 0 && (
                      <div>⚠ {su.unphotographedBedrooms} of {su.expectedBedrooms} claimed bedroom{su.expectedBedrooms === 1 ? "" : "s"} ha{su.unphotographedBedrooms === 1 ? "s" : "ve"} no bedroom photo — those slots stay as configured (verify manually or find better photos).</div>
                    )}
                    {lowBedrooms > 0 && (
                      <div>⚠ {lowBedrooms} detection{lowBedrooms === 1 ? "" : "s"} at or below {Math.round(BEDDING_SCAN_MIN_CONFIDENCE * 100)}% confidence — not applied.</div>
                    )}
                    {su.warning && <div>⚠ {su.warning}</div>}
                  </div>
                )}
              </div>
            );
          })}
          {beddingScan.units.some((scanUnit) =>
            !scanUnit.unitId || !config.units.some((unit) => unit.unitId === scanUnit.unitId)) && (
            <div style={{ fontSize: 11, color: "#92400e" }}>
              ⚠ One or more scan results could not be matched to a stable builder unit ID and were left untouched.
            </div>
          )}
        </div>
      )}

      {/* Per-unit cards */}
      {config.units.length === 0 && (
        <div style={{ ...cellStyle, color: "#6b7280", fontStyle: "italic" }}>
          No units configured for this property.
        </div>
      )}

      {config.units.map((unit) => (
        <div key={unit.unitId} style={cellStyle} data-testid={`unit-${unit.unitId}`}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #f3f4f6" }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{unit.unitLabel}</div>
              <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace" }}>{unit.unitId}</div>
            </div>
            <div style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280" }}>
              {unit.bedrooms.length}BR · {unit.bathrooms.reduce((s, b) => s + (b.isHalf ? 0.5 : 1), 0)}BA
              · sleeps {unit.bedrooms.reduce((s, br) => s + br.beds.reduce((bs, b) => bs + ({KING_BED:2,QUEEN_BED:2,DOUBLE_BED:2,SINGLE_BED:1,SOFA_BED:2,BUNK_BED:2}[b.type] ?? 2) * b.quantity, 0), 0) + (unit.livingRoom.hasSofaBed ? 2 * unit.livingRoom.count : 0)}
            </div>
          </div>

          {/* BEDROOMS */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ ...labelStyle, marginBottom: 0 }}>Bedrooms</div>
              <button onClick={() => addBedroom(unit.unitId)} style={{ ...inputStyle, fontSize: 11, padding: "2px 8px", cursor: "pointer" }} data-testid={`btn-add-bedroom-${unit.unitId}`}>+ Add</button>
            </div>
            {unit.bedrooms.map((br) => (
              <div key={br.roomNumber} style={{ background: "#f9fafb", borderRadius: 6, padding: 10, marginBottom: 8 }} data-testid={`bedroom-${unit.unitId}-${br.roomNumber}`}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                  <input
                    type="text"
                    value={br.label}
                    onChange={e => updateBedroom(unit.unitId, br.roomNumber, b => ({ ...b, label: e.target.value }))}
                    style={{ ...inputStyle, width: 180, fontWeight: 600 }}
                    data-testid={`input-bedroom-label-${unit.unitId}-${br.roomNumber}`}
                  />
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#374151", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={br.hasEnsuite}
                      onChange={e => updateBedroom(unit.unitId, br.roomNumber, b => ({ ...b, hasEnsuite: e.target.checked, ensuiteFeatures: e.target.checked ? (b.ensuiteFeatures.length ? b.ensuiteFeatures : ["walk-in-shower"]) : [] }))}
                      data-testid={`check-ensuite-${unit.unitId}-${br.roomNumber}`}
                    />
                    Ensuite bathroom
                  </label>
                  <button
                    onClick={() => removeBedroom(unit.unitId, br.roomNumber)}
                    style={{ ...inputStyle, marginLeft: "auto", color: "#dc2626", borderColor: "#fecaca", cursor: "pointer", fontSize: 11 }}
                    data-testid={`btn-remove-bedroom-${unit.unitId}-${br.roomNumber}`}
                  >
                    ✕ Remove
                  </button>
                </div>
                {/* Beds */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: br.hasEnsuite ? 8 : 0 }}>
                  <span style={{ fontSize: 11, color: "#6b7280", marginRight: 4 }}>Beds:</span>
                  {br.beds.map((bed, bi) => (
                    <div key={bi} style={{ display: "flex", gap: 3, alignItems: "center" }}>
                      <input
                        type="number"
                        value={bed.quantity}
                        min={1} max={6}
                        onChange={e => updateBedroom(unit.unitId, br.roomNumber, b => ({
                          ...b, beds: b.beds.map((x, i) => i === bi ? { ...x, quantity: parseInt(e.target.value) || 1 } : x),
                        }))}
                        style={{ ...inputStyle, width: 42, padding: "3px 5px", textAlign: "center" }}
                        data-testid={`input-bed-qty-${unit.unitId}-${br.roomNumber}-${bi}`}
                      />
                      <select
                        value={bed.type}
                        onChange={e => updateBedroom(unit.unitId, br.roomNumber, b => ({
                          ...b, beds: b.beds.map((x, i) => i === bi ? { ...x, type: e.target.value as GuestyBedType } : x),
                        }))}
                        style={{ ...inputStyle, padding: "3px 5px" }}
                        data-testid={`select-bed-type-${unit.unitId}-${br.roomNumber}-${bi}`}
                      >
                        {BED_TYPES.map(t => <option key={t} value={t}>{BED_TYPE_LABELS[t]}</option>)}
                      </select>
                      {br.beds.length > 1 && (
                        <button
                          onClick={() => updateBedroom(unit.unitId, br.roomNumber, b => ({ ...b, beds: b.beds.filter((_, i) => i !== bi) }))}
                          style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: 14, padding: "0 2px" }}
                          title="Remove bed"
                        >✕</button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => updateBedroom(unit.unitId, br.roomNumber, b => ({ ...b, beds: [...b.beds, { type: "QUEEN_BED", quantity: 1 }] }))}
                    style={{ ...inputStyle, fontSize: 11, padding: "2px 7px", cursor: "pointer" }}
                    data-testid={`btn-add-bed-${unit.unitId}-${br.roomNumber}`}
                  >+ bed</button>
                </div>
                {/* Ensuite features */}
                {br.hasEnsuite && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "#6b7280", marginRight: 4 }}>Ensuite features:</span>
                    {BATH_FEATURES.map(f => {
                      const active = br.ensuiteFeatures.includes(f);
                      return (
                        <span
                          key={f}
                          style={active ? chipActive : chipBase}
                          onClick={() => updateBedroom(unit.unitId, br.roomNumber, b => ({
                            ...b, ensuiteFeatures: active ? b.ensuiteFeatures.filter(x => x !== f) : [...b.ensuiteFeatures, f],
                          }))}
                          data-testid={`chip-ensuite-${unit.unitId}-${br.roomNumber}-${f}`}
                        >
                          {BATH_FEATURE_LABELS[f]}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* BATHROOMS */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ ...labelStyle, marginBottom: 0 }}>Bathrooms</div>
              <button onClick={() => addBathroom(unit.unitId)} style={{ ...inputStyle, fontSize: 11, padding: "2px 8px", cursor: "pointer" }} data-testid={`btn-add-bathroom-${unit.unitId}`}>+ Add</button>
              <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 6 }}>
                Half-baths count as 0.5 in Guesty's bathroom number.
              </span>
            </div>
            {unit.bathrooms.map((bath) => (
              <div key={bath.id} style={{ background: "#f9fafb", borderRadius: 6, padding: 10, marginBottom: 8 }} data-testid={`bathroom-${unit.unitId}-${bath.id}`}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                  <input
                    type="text"
                    value={bath.label}
                    onChange={e => updateBathroom(unit.unitId, bath.id, b => ({ ...b, label: e.target.value }))}
                    style={{ ...inputStyle, width: 180, fontWeight: 600 }}
                    data-testid={`input-bathroom-label-${unit.unitId}-${bath.id}`}
                  />
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#374151", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={bath.isHalf}
                      onChange={e => updateBathroom(unit.unitId, bath.id, b => ({ ...b, isHalf: e.target.checked, features: e.target.checked ? [] : (b.features.length ? b.features : ["shower-tub-combo"]) }))}
                      data-testid={`check-half-${unit.unitId}-${bath.id}`}
                    />
                    Half-bath (0.5)
                  </label>
                  <button
                    onClick={() => removeBathroom(unit.unitId, bath.id)}
                    style={{ ...inputStyle, marginLeft: "auto", color: "#dc2626", borderColor: "#fecaca", cursor: "pointer", fontSize: 11 }}
                    data-testid={`btn-remove-bathroom-${unit.unitId}-${bath.id}`}
                  >✕ Remove</button>
                </div>
                {!bath.isHalf && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "#6b7280", marginRight: 4 }}>Features:</span>
                    {BATH_FEATURES.map(f => {
                      const active = bath.features.includes(f);
                      return (
                        <span
                          key={f}
                          style={active ? chipActive : chipBase}
                          onClick={() => updateBathroom(unit.unitId, bath.id, b => ({
                            ...b, features: active ? b.features.filter(x => x !== f) : [...b.features, f],
                          }))}
                          data-testid={`chip-bath-${unit.unitId}-${bath.id}-${f}`}
                        >
                          {BATH_FEATURE_LABELS[f]}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* LIVING ROOM */}
          <div>
            <div style={{ ...labelStyle }}>Living Room</div>
            <div style={{ background: "#f9fafb", borderRadius: 6, padding: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={unit.livingRoom.hasSofaBed}
                  onChange={e => updateUnit(unit.unitId, u => ({ ...u, livingRoom: { ...u.livingRoom, hasSofaBed: e.target.checked, count: e.target.checked ? Math.max(1, u.livingRoom.count) : 0 } }))}
                  data-testid={`check-sofa-${unit.unitId}`}
                />
                Sofa bed in living room
              </label>
              {unit.livingRoom.hasSofaBed && (
                <>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>How many?</span>
                  <input
                    type="number"
                    value={unit.livingRoom.count}
                    min={1} max={4}
                    onChange={e => updateUnit(unit.unitId, u => ({ ...u, livingRoom: { ...u.livingRoom, count: parseInt(e.target.value) || 1 } }))}
                    style={{ ...inputStyle, width: 50, textAlign: "center" }}
                    data-testid={`input-sofa-count-${unit.unitId}`}
                  />
                  <span style={{ fontSize: 11, color: "#9ca3af" }}>
                    Each pushed to Guesty as roomNumber: 0 (common area).
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Auto-generated description preview */}
          <div style={{ marginTop: 12, padding: 10, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6 }}>
            <div style={{ ...labelStyle, color: "#92400e", marginBottom: 4 }}>Auto-generated description (for listing copy)</div>
            <div style={{ fontSize: 12, color: "#78350f", lineHeight: 1.5 }} data-testid={`text-bedding-desc-${unit.unitId}`}>
              {describeUnitBedding(unit)}
            </div>
          </div>
        </div>
      ))}

      {/* ── Space Description — streams bedroom names into listing copy ─── */}
      <div style={{ ...cellStyle, border: "1px solid #c7d2fe", background: "#eef2ff", marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <div>
            <div style={{ ...labelStyle, color: "#3730a3", marginBottom: 2 }}>Space Description (streams bedroom names into your listing)</div>
            <div style={{ fontSize: 11, color: "#6366f1", lineHeight: 1.4 }}>
              Guesty's API doesn't store room <em>names</em> — they stream through the Space field of your listing description.
              Edit below, then push to update the Space field in Guesty so guests see the bedroom names you've set.
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {spaceDirty && (
              <button
                onClick={handleRegenerateSpace}
                style={{ ...inputStyle, cursor: "pointer", color: "#4f46e5", whiteSpace: "nowrap" }}
                data-testid="btn-regenerate-space"
                title="Discard your manual edits and rebuild this text from the bedding config above"
              >
                ↻ Regenerate from bedding
              </button>
            )}
            <button
              onClick={handlePushSpace}
              disabled={!guestyListingId || pushingSpace}
              style={{
                ...inputStyle, cursor: guestyListingId ? "pointer" : "not-allowed",
                background: pushingSpace ? "#94a3b8" : "#4f46e5", color: "#fff",
                borderColor: "transparent", fontWeight: 600, whiteSpace: "nowrap",
              }}
              data-testid="btn-push-space"
              title={guestyListingId ? "Push this text to the Space field in Guesty" : "Select a Guesty listing first"}
            >
              {pushingSpace ? "Pushing…" : "↑ Push Space to Guesty"}
            </button>
          </div>
        </div>
        <textarea
          value={spaceText}
          onChange={e => handleSpaceTextEdit(e.target.value)}
          rows={Math.min(20, spaceText.split("\n").length + 2)}
          style={{
            width: "100%", padding: "8px 10px", fontSize: 12,
            border: "1px solid #c7d2fe", borderRadius: 6,
            background: "#fff", color: "#1e1b4b", lineHeight: 1.6,
            fontFamily: "inherit", resize: "vertical", boxSizing: "border-box",
          }}
          data-testid="textarea-space-description"
          placeholder="Space description will be generated from your bedding configuration..."
        />
        <div style={{ fontSize: 10, color: "#6366f1", marginTop: 4 }}>
          {spaceDirty
            ? "Manually edited — auto-regeneration is paused and your text is saved locally. Use ↻ Regenerate from bedding to rebuild it from the config above."
            : "Auto-regenerates as you edit the bedding config above. Editing this text pauses auto-regeneration and keeps your version."}
        </div>
      </div>

      {/* Footer note */}
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 8, lineHeight: 1.5 }}>
        Edits auto-save locally. <b>Push Bedding to Guesty</b> sends bedroom/bathroom counts and room configuration. <b>Push Space to Guesty</b> sends the prose description including bedroom names to the listing's Space field.
      </div>
    </fieldset>
  );
}
