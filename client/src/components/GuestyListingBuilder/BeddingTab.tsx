import { useEffect, useMemo, useState, useCallback } from "react";
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
  describeDetectedBeds,
  mergeBeddingScanIntoUnit,
  type BeddingPhotoScanRecord,
  type BeddingScanUnit,
} from "@shared/bedding-photo-scan";

const BED_TYPES: GuestyBedType[] = ["KING_BED", "QUEEN_BED", "DOUBLE_BED", "SINGLE_BED", "SOFA_BED", "BUNK_BED"];
const BATH_FEATURES: BathFeature[] = ["walk-in-shower", "shower-tub-combo", "soaking-tub", "jetted-tub", "rain-shower", "double-vanity"];

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

export function BeddingTab({ propertyId, guestyListingId, onGuestyPushRecorded }: Props) {
  const { toast } = useToast();
  const [config, setConfig] = useState<PropertyBeddingConfig>(() => loadBeddingConfig(propertyId));
  const [pushing, setPushing] = useState(false);
  // spaceDirty = the operator hand-edited the Space text; auto-regeneration is
  // paused and the text persists across tab switches until "Regenerate".
  const [spaceDirty, setSpaceDirty] = useState(() => loadSpaceTextOverride(propertyId) != null);
  const [spaceText, setSpaceText] = useState(() =>
    loadSpaceTextOverride(propertyId) ?? buildSpaceDescription(loadBeddingConfig(propertyId)));
  const [pushingSpace, setPushingSpace] = useState(false);
  // Bedding PHOTO scan — Claude vision proposal over the unit's actual photos.
  // NOTHING auto-applies: the operator reviews the panel and clicks Apply per
  // unit (their manual edits keep winning — apply just writes the config state,
  // which persists through the normal localStorage save).
  const [beddingScan, setBeddingScan] = useState<BeddingPhotoScanRecord | null>(null);
  const [beddingScanFresh, setBeddingScanFresh] = useState(false);
  const [beddingScanning, setBeddingScanning] = useState(false);
  const [beddingScanError, setBeddingScanError] = useState<string | null>(null);
  const [beddingScanApplied, setBeddingScanApplied] = useState<Record<string, string>>({});

  // Reload when property changes
  useEffect(() => {
    const c = loadBeddingConfig(propertyId);
    setConfig(c);
    const override = loadSpaceTextOverride(propertyId);
    setSpaceDirty(override != null);
    setSpaceText(override ?? buildSpaceDescription(c));
  }, [propertyId]);

  // Hydrate the last stored photo scan (an audit sweep may have already paid
  // for one — the store is shared with the unit-audit layout stage).
  useEffect(() => {
    let cancelled = false;
    setBeddingScan(null);
    setBeddingScanFresh(false);
    setBeddingScanError(null);
    setBeddingScanApplied({});
    fetch(`/api/builder/bedding-photo-scan/${propertyId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.record) return;
        setBeddingScan(data.record as BeddingPhotoScanRecord);
        setBeddingScanFresh(data.fresh === true);
      })
      .catch(() => { /* proposal panel just stays hidden */ });
    return () => { cancelled = true; };
  }, [propertyId]);

  // Auto-persist on change + refresh generated space text (unless hand-edited)
  useEffect(() => {
    saveBeddingConfig(config);
    if (!spaceDirty) setSpaceText(buildSpaceDescription(config));
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
    setConfig(c => ({ ...c, units: c.units.map(u => u.unitId === unitId ? fn(u) : u) }));
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
  const handlePush = useCallback(async () => {
    if (!guestyListingId || pushing) return;
    setPushing(true);
    try {
      await guestyService.updateListingDetails(guestyListingId, {
        bedrooms: totals.bedrooms || undefined,
        bathrooms: totals.bathrooms || undefined,
        accommodates: totals.sleeps || undefined,
        listingRooms: buildGuestyListingRooms(config),
      });
      const message = `Bedding updated: ${totals.bedrooms} BR, ${totals.bathrooms} bath, sleeps ${totals.sleeps}`;
      onGuestyPushRecorded?.("success", message);
      toast({
        title: "Bedding pushed to Guesty",
        description: `${totals.bedrooms} bedroom${totals.bedrooms !== 1 ? "s" : ""}, ${totals.bathrooms} bath${totals.bathrooms !== 1 ? "s" : ""}, sleeps ${totals.sleeps}.`,
      });
    } catch (e) {
      const message = (e as Error).message;
      onGuestyPushRecorded?.("error", message);
      toast({ title: "Push failed", description: message, variant: "destructive" });
    } finally {
      setPushing(false);
    }
  }, [guestyListingId, pushing, totals, config, onGuestyPushRecorded, toast]);

  // ── Bedding photo scan ────────────────────────────────────────────────────
  const handleBeddingScan = useCallback(async () => {
    if (beddingScanning) return;
    setBeddingScanning(true);
    setBeddingScanError(null);
    try {
      const r = await fetch("/api/builder/bedding-photo-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.record) throw new Error(data?.error ?? `HTTP ${r.status}`);
      setBeddingScan(data.record as BeddingPhotoScanRecord);
      setBeddingScanFresh(true);
      setBeddingScanApplied({});
      toast({
        title: "Bedding photo scan complete",
        description: data.record.method === "vision"
          ? "Claude looked at the unit photos — review the proposal below, then Apply."
          : "Vision was unavailable — the proposal is derived from existing photo labels.",
      });
    } catch (e) {
      setBeddingScanError((e as Error).message);
      toast({ title: "Bedding photo scan failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBeddingScanning(false);
    }
  }, [beddingScanning, propertyId, toast]);

  const handleApplyBeddingScan = useCallback((scanUnit: BeddingScanUnit, unitIndex: number) => {
    const target = config.units[unitIndex];
    if (!target) return;
    const result = mergeBeddingScanIntoUnit(target, scanUnit);
    if (!result.changed) {
      toast({ title: "Nothing to apply", description: "No detection cleared the confidence floor for this unit." });
      return;
    }
    updateUnit(target.unitId, () => result.unit as UnitBeddingConfig);
    setBeddingScanApplied((prev) => ({ ...prev, [target.unitId]: result.applied.join(" · ") }));
    toast({
      title: `Applied photo-detected bedding to Unit ${target.unitLabel}`,
      description: [...result.applied, ...result.notes].join(" · ").slice(0, 300)
        + " — review below, then Push Bedding to Guesty.",
    });
  }, [config.units, toast, updateUnit]);

  const handleReset = () => {
    if (!confirm("Reset bedding config for this property to defaults? Your edits will be lost.")) return;
    const c = resetBeddingConfig(propertyId);
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
    <div data-testid="bedding-tab">
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
            disabled={beddingScanning}
            style={{
              ...inputStyle, cursor: beddingScanning ? "wait" : "pointer",
              background: beddingScanning ? "#c4b5fd" : "#7c3aed", color: "#fff",
              borderColor: "transparent", fontWeight: 600,
            }}
            data-testid="btn-bedding-scan"
            title="Claude vision reads the unit photos and proposes bed types, en-suite evidence, and bathroom fixtures — nothing is applied until you click Apply"
          >
            {beddingScanning ? "⏳ Claude is reading the photos…" : "🔎 Scan photos for bedding"}
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
            disabled={!guestyListingId || pushing}
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

      {/* Bedding photo-scan proposal — photo-proven bedding, explicit Apply */}
      {beddingScanError && (
        <div style={{ ...cellStyle, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 13 }}>
          Bedding photo scan failed: {beddingScanError}
        </div>
      )}
      {beddingScan && beddingScan.units.length > 0 && (
        <div style={{ ...cellStyle, background: "#f5f3ff", border: "1px solid #ddd6fe" }} data-testid="bedding-scan-panel">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#5b21b6" }}>
              {beddingScan.method === "vision" ? "🤖 Claude read the unit photos" : "🏷 Proposal from existing photo labels (vision unavailable)"}
            </div>
            <div style={{ fontSize: 11, color: "#7c6f9f" }}>
              scanned {new Date(beddingScan.scannedAt).toLocaleString()}
            </div>
            {!beddingScanFresh && (
              <span style={{ fontSize: 11, background: "#fef3c7", border: "1px solid #fcd34d", color: "#92400e", borderRadius: 999, padding: "2px 8px" }}>
                photos changed since this scan — re-scan for current evidence
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
            Only what the photos prove: confident detections fill the matching unit below when you click Apply;
            bedrooms with no photo evidence are flagged and left exactly as configured. Your edits always win —
            nothing applies automatically, and you can hand-edit after applying.
          </div>
          {beddingScan.units.map((su, i) => {
            const cfgUnit = config.units[i];
            const confidentBedrooms = su.bedrooms.filter((b) => b.confidence >= BEDDING_SCAN_MIN_CONFIDENCE);
            const lowBedrooms = su.bedrooms.length - confidentBedrooms.length;
            const confidentBaths = su.bathrooms.filter((b) => b.confidence >= BEDDING_SCAN_MIN_CONFIDENCE);
            const appliedNote = cfgUnit ? beddingScanApplied[cfgUnit.unitId] : undefined;
            return (
              <div key={`${su.folder}-${i}`} style={{ background: "#fff", border: "1px solid #e9e5f8", borderRadius: 6, padding: 10, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{su.label}</div>
                  <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace" }}>{su.folder}</div>
                  {su.photosScanned > 0 && (
                    <div style={{ fontSize: 11, color: "#6b7280" }}>{su.photosScanned} photos read</div>
                  )}
                  {cfgUnit && (
                    <button
                      onClick={() => handleApplyBeddingScan(su, i)}
                      disabled={confidentBedrooms.length === 0 && confidentBaths.length === 0}
                      style={{
                        ...inputStyle, marginLeft: "auto", cursor: confidentBedrooms.length || confidentBaths.length ? "pointer" : "not-allowed",
                        background: confidentBedrooms.length || confidentBaths.length ? "#059669" : "#e5e7eb",
                        color: confidentBedrooms.length || confidentBaths.length ? "#fff" : "#9ca3af",
                        borderColor: "transparent", fontWeight: 600, fontSize: 12,
                      }}
                      data-testid={`btn-bedding-apply-${cfgUnit.unitId}`}
                    >
                      ✓ Apply to Unit {cfgUnit.unitLabel}
                    </button>
                  )}
                </div>
                {appliedNote && (
                  <div style={{ fontSize: 12, color: "#047857", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 6, padding: "4px 8px", marginBottom: 6 }}>
                    ✓ Applied: {appliedNote} — review + Push Bedding to Guesty.
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
                      <div>⚠ {lowBedrooms} detection{lowBedrooms === 1 ? "" : "s"} below the {Math.round(BEDDING_SCAN_MIN_CONFIDENCE * 100)}% confidence floor — not applied.</div>
                    )}
                    {su.warning && <div>⚠ {su.warning}</div>}
                  </div>
                )}
              </div>
            );
          })}
          {beddingScan.units.length !== config.units.length && (
            <div style={{ fontSize: 11, color: "#92400e" }}>
              ⚠ The scan found {beddingScan.units.length} photographed unit{beddingScan.units.length === 1 ? "" : "s"} but this property has {config.units.length} configured — Apply matches by position, so double-check unit order.
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
    </div>
  );
}
