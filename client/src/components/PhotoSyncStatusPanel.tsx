// Per-channel photo-sync status panel for the Guesty listing builder.
//
// Reads /api/listings/:id/photo-sync-status and renders one row per
// OTA channel (Airbnb / VRBO / Booking) with the current status
// (synced / isolated), last action timestamps, and per-channel
// actions:
//
//   - "Isolate + Replace + Disconnect" (VRBO & Booking only) — the
//     full migration flow: find a Zillow unit clean on this channel,
//     scrape its photos, sidecar-upload them to the channel's partner
//     portal, then sidecar-disconnect this channel from Guesty admin.
//     Streams NDJSON; live phase progress in the dialog. Default
//     primary action for these channels.
//
//   - "Isolate" (all three channels) — record-intent only. Captures
//     the current Guesty hashes as previousBadHashes and flips
//     status to isolated, but doesn't push photos or disconnect.
//     Useful for staging the change before doing the actual upload
//     manually.
//
//   - "Re-enable Master Sync" — flips back to synced, clears
//     previousBadHashes. Doesn't reconnect the Guesty integration
//     (manual operator step in Guesty admin).
//
// Airbnb gets only "Isolate" since the operator's decision is to
// keep Airbnb on Guesty's master sync.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ShieldOff, Shield, RotateCw, Zap, Check, X, Circle } from "lucide-react";

const CHANNELS = [
  { key: "airbnb", label: "Airbnb" },
  { key: "vrbo", label: "VRBO" },
  { key: "booking", label: "Booking.com" },
] as const;
type ChannelKey = typeof CHANNELS[number]["key"];

type AlertEntry = {
  id: number;
  folder: string;
  priorStatus: string;
  newStatus: string;
  matchedUrls: Array<{ photoUrl: string; listingUrl: string; title: string; source: string }>;
  detectedAt: string;
};

type ChannelStatus = {
  channel: string;
  status: "synced" | "isolated";
  isolatedAt: string | null;
  isolatedReason: string | null;
  reEnabledAt: string | null;
  updatedAt: string | null;
  partnerListingRef: string | null;
  hashCount: number;
  alerts: AlertEntry[];
};

type StatusResponse = {
  guestyListingId: string;
  channels: ChannelStatus[];
};

type FullFlowChannel = "vrbo" | "booking";

type Props = {
  guestyListingId: string;
  // For the full Isolate + Replace + Disconnect flow: the resort/
  // complex folder (e.g. "community-regency-poipu-kai") and the
  // listing's combined bedroom count, used by find-unit. Both are
  // optional; if not supplied, the full-flow buttons are disabled
  // with a tooltip explaining why.
  communityFolder?: string;
  bedrooms?: number;
  // Auto-fill source for partnerListingRef when the operator hasn't
  // saved one yet. Guesty stores the VRBO `advertiserId` (= partner
  // portal listing id) under channels.homeaway2 and the Booking
  // `hotelId` under channels.bookingCom — guestyService.
  // getChannelStatus surfaces both as ChannelInfo.id.
  channelIds?: {
    vrbo?: string | null;
    booking?: string | null;
  };
};

export function PhotoSyncStatusPanel({ guestyListingId, communityFolder, bedrooms, channelIds }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isolating, setIsolating] = useState<{ channel: string; label: string } | null>(null);
  const [reason, setReason] = useState("");
  // Full-flow modal state. partnerListingRef is pre-filled from the
  // server's persisted value when available; the operator only
  // re-enters it on first run per (listing, channel).
  const [fullFlow, setFullFlow] = useState<{
    channel: FullFlowChannel;
    label: string;
    partnerListingRef: string;
    bedrooms: number;
    reason: string;
  } | null>(null);
  // Streaming progress state for the full flow. Per-step status so the
  // operator sees exactly which steps succeeded vs which failed —
  // single-phase + message wasn't enough signal for trust.
  type StepKey = "find" | "scrape" | "snapshot" | "isolate" | "upload" | "disconnect";
  type StepState = "pending" | "running" | "done" | "error" | "skipped";
  type StepRow = { key: StepKey; label: string; state: StepState; detail: string | null };
  const initialSteps = (channel: FullFlowChannel): StepRow[] => [
    { key: "find",       label: "Find a replacement Zillow unit",                   state: "pending", detail: null },
    { key: "scrape",     label: "Read candidate's photos",                          state: "pending", detail: null },
    { key: "snapshot",   label: "Snapshot current Guesty photos",                   state: "pending", detail: null },
    { key: "isolate",    label: "Mark channel isolated + capture bad-hash set",     state: "pending", detail: null },
    { key: "upload",     label: `Upload photos to ${prettyChannel(channel)} portal`, state: "pending", detail: null },
    { key: "disconnect", label: `Disconnect ${prettyChannel(channel)} from Guesty`, state: "pending", detail: null },
  ];
  const [fullFlowRun, setFullFlowRun] = useState<{
    channel: FullFlowChannel;
    steps: StepRow[];
    done: boolean;
    error: string | null;
  } | null>(null);

  const queryKey = ["/api/listings", guestyListingId, "photo-sync-status"];
  const { data, isLoading } = useQuery<StatusResponse>({
    queryKey,
    queryFn: async () => {
      const r = await fetch(`/api/listings/${guestyListingId}/photo-sync-status`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!guestyListingId,
    staleTime: 60_000,
  });

  const isolateMutation = useMutation({
    mutationFn: async (vars: { channel: string; reason: string | null }) => {
      const r = await fetch(`/api/listings/${guestyListingId}/isolate-channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: [vars.channel], reason: vars.reason || null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body;
    },
    onSuccess: (body, vars) => {
      const hashCount = body?.results?.[vars.channel]?.hashCount ?? 0;
      toast({
        title: `${prettyChannel(vars.channel)} isolated`,
        description: `Snapshotted ${hashCount} photo hash${hashCount === 1 ? "" : "es"}. Disconnect this channel in Guesty admin to make the isolation real, then upload your replacement photos directly to the channel.`,
      });
      setIsolating(null);
      setReason("");
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: any) => {
      toast({ title: "Couldn't isolate channel", description: e?.message ?? String(e), variant: "destructive" });
    },
  });

  const reEnableMutation = useMutation({
    mutationFn: async (vars: { channel: string }) => {
      const r = await fetch(`/api/listings/${guestyListingId}/re-enable-channel-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: vars.channel }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body;
    },
    onSuccess: (_body, vars) => {
      toast({
        title: `${prettyChannel(vars.channel)} re-enabled`,
        description: "Master Sync resumes on the next photo update from Guesty.",
      });
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: any) => {
      toast({ title: "Couldn't re-enable channel", description: e?.message ?? String(e), variant: "destructive" });
    },
  });

  // Full flow: NDJSON streaming. Updates fullFlowRun as events arrive
  // so the dialog shows live phase + message progress.
  // Helper: mutate one step in the steps[] array.
  const updateStep = (key: StepKey, patch: Partial<StepRow>) =>
    setFullFlowRun((s) => s ? {
      ...s,
      steps: s.steps.map((row) => row.key === key ? { ...row, ...patch } : row),
    } : s);

  // Helper: any later step that's still "pending" when an error fires
  // earlier should be marked "skipped" so the operator sees clearly
  // that the chain was halted, not that those steps mysteriously
  // didn't run.
  const skipPendingAfter = (failedKey: StepKey) =>
    setFullFlowRun((s) => {
      if (!s) return s;
      const failedIndex = s.steps.findIndex((r) => r.key === failedKey);
      return {
        ...s,
        steps: s.steps.map((r, i) => i > failedIndex && r.state === "pending" ? { ...r, state: "skipped" } : r),
      };
    });

  // Map a server `phase` name to the steps[] key (sometimes 1-to-many:
  // the server's "find-replacement" covers our find step; "isolate" is
  // implicit between snapshot-result and upload phase).
  const phaseToStep = (phase: string): StepKey | null => {
    if (phase === "find-replacement") return "find";
    if (phase === "scrape") return "scrape";
    if (phase === "snapshot") return "snapshot";
    if (phase === "upload") return "upload";
    if (phase === "disconnect") return "disconnect";
    return null;
  };

  // PR #318: master-sync remediation for Airbnb alerts.
  //
  // Airbnb stays on Guesty's master sync per operator policy — we
  // never disconnect it. So when an alert fires for Airbnb, the
  // remediation is: find a Zillow unit clean on Airbnb, swap the
  // alerted folder's photos with that candidate's, and push the
  // updated photos to Guesty (which fans out to Airbnb + any other
  // still-synced channel).
  //
  // Critical ordering: process VRBO/Booking alerts FIRST (those
  // isolate + disconnect from Guesty), THEN run this Airbnb master-
  // sync. If you do this first, Guesty fans out to whatever's still
  // synced — which may include the very channels you wanted to
  // isolate independently. The UI surfaces an ordering hint when
  // multiple channels have alerts.
  type AirbnbRemediateState = { phase: "running" | "done" | "error"; message: string; percent: number };
  const [airbnbRemediating, setAirbnbRemediating] = useState<Record<number, AirbnbRemediateState>>({});
  const setAirbnbStatus = (alertId: number, s: AirbnbRemediateState) =>
    setAirbnbRemediating((prev) => ({ ...prev, [alertId]: s }));
  const clearAirbnbStatus = (alertId: number) =>
    setAirbnbRemediating((prev) => { const n = { ...prev }; delete n[alertId]; return n; });
  const phasePercent = (name: string | undefined, current: number): number => {
    switch (name) {
      case "find-replacement": return 10;
      case "scrape": return 55;
      case "download-photos": return 75;
      case "downloadAndPrioritize": return 75;
      case "push": return 90;
      default: return current;
    }
  };
  const remediateAirbnbAlert = async (alertId: number) => {
    setAirbnbStatus(alertId, { phase: "running", message: "Starting…", percent: 5 });
    try {
      const resp = await fetch(`/api/photo-listing-alerts/${alertId}/remediate`, { method: "POST" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      if (!resp.body) throw new Error("No response body");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let didFinish = false;
      let lastError: string | null = null;
      let percent = 5;
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as any;
            if (ev.type === "phase") {
              percent = phasePercent(ev.name, percent);
              setAirbnbStatus(alertId, { phase: "running", message: ev.message ?? ev.name, percent });
            } else if (ev.type === "candidate") {
              percent = Math.max(percent, 40);
              setAirbnbStatus(alertId, { phase: "running", message: `Found ${ev.unitLabel}`, percent });
            } else if (ev.type === "swap") {
              percent = Math.max(percent, 80);
              setAirbnbStatus(alertId, { phase: "running", message: `Swapped ${ev.kept} photos`, percent });
            } else if (ev.type === "push") {
              percent = Math.max(percent, 90);
              setAirbnbStatus(alertId, {
                phase: "running",
                message: ev.success ? `Pushed ${ev.savedOnGuesty} to ${ev.listing}` : `Push failed: ${ev.listing}`,
                percent,
              });
            } else if (ev.type === "done") {
              didFinish = true;
            } else if (ev.type === "error") {
              lastError = ev.message ?? `${ev.phase} error`;
            }
          } catch { /* ignore malformed line */ }
        }
      }
      if (didFinish) {
        setAirbnbStatus(alertId, { phase: "done", message: "✓ Done!", percent: 100 });
        toast({
          title: "Airbnb photos replaced and pushed",
          description: "Guesty will sync new photos to Airbnb and other still-connected channels over the next few minutes.",
        });
        await new Promise((r) => setTimeout(r, 1500));
        clearAirbnbStatus(alertId);
        queryClient.invalidateQueries({ queryKey });
      } else {
        throw new Error(lastError ?? "Remediate did not finish");
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setAirbnbStatus(alertId, { phase: "error", message: `✗ ${msg}`, percent: 100 });
      toast({ title: "Couldn't remediate alert", description: msg, variant: "destructive" });
      setTimeout(() => clearAirbnbStatus(alertId), 8000);
    }
  };

  // Dismiss an alert (acknowledge it server-side without remediating).
  const dismissAlert = async (alertId: number) => {
    try {
      const r = await fetch(`/api/photo-listing-alerts/${alertId}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Alert dismissed" });
    } catch (e: any) {
      toast({ title: "Couldn't dismiss alert", description: e?.message, variant: "destructive" });
    }
  };

  const runFullFlow = async (params: { channel: FullFlowChannel; partnerListingRef: string; bedrooms: number; reason: string | null }) => {
    if (!communityFolder) {
      toast({ title: "Can't run full flow", description: "communityFolder missing — pass it as a prop from the builder.", variant: "destructive" });
      return;
    }
    setFullFlowRun({
      channel: params.channel,
      steps: initialSteps(params.channel),
      done: false,
      error: null,
    });
    console.info(`[isolate-replace-disconnect] click → POST /api/listings/${guestyListingId}/isolate-replace-disconnect`, params);
    try {
      const resp = await fetch(`/api/listings/${guestyListingId}/isolate-replace-disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: params.channel,
          partnerListingRef: params.partnerListingRef,
          communityFolder,
          bedrooms: params.bedrooms,
          reason: params.reason || null,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      if (!resp.body) throw new Error("No response body");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let didFinish = false;
      let lastError: string | null = null;
      let lastErrorPhase: string | null = null;
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as any;
            console.debug("[isolate-replace-disconnect] event:", ev);
            if (ev.type === "phase") {
              const stepKey = phaseToStep(ev.name);
              if (stepKey) updateStep(stepKey, { state: "running", detail: ev.message ?? null });
            } else if (ev.type === "candidate") {
              updateStep("find", { state: "done", detail: `${ev.unitLabel} (${ev.bedrooms ?? "?"}BR)` });
            } else if (ev.type === "scrape-result") {
              updateStep("scrape", { state: "done", detail: `${ev.count} photos read` });
              // Snapshot phase fires next on the server; the isolate
              // step is implicit (DB write between snapshot-result and
              // the upload phase) — we mark it done as soon as the
              // upload phase begins below.
            } else if (ev.type === "snapshot-result") {
              updateStep("snapshot", { state: "done", detail: `${ev.hashCount} hash${ev.hashCount === 1 ? "" : "es"} captured` });
              // Server immediately writes the photo_sync row + audit
              // before emitting the next "upload" phase event. Mark
              // isolate done as the implicit success.
              updateStep("isolate", { state: "done", detail: "photo_sync row written + audit logged" });
            } else if (ev.type === "upload-result") {
              if (ev.uploaded > 0) {
                updateStep("upload", {
                  state: "done",
                  detail: `${ev.uploaded} uploaded${ev.failed ? `, ${ev.failed} failed` : ""} in ${Math.round((ev.durationMs ?? 0) / 1000)}s`,
                });
              } else {
                updateStep("upload", {
                  state: "error",
                  detail: ev.workerOnline
                    ? `0/${ev.uploaded + (ev.failed ?? 0)} uploaded — sidecar reported all failed`
                    : "Sidecar worker offline",
                });
              }
            } else if (ev.type === "disconnect-result") {
              if (ev.ok) {
                updateStep("disconnect", { state: "done", detail: ev.message ?? "Disconnected" });
              } else {
                updateStep("disconnect", {
                  state: "error",
                  detail: ev.workerOnline ? `Failed: ${ev.message}` : "Sidecar worker offline",
                });
              }
            } else if (ev.type === "done") {
              didFinish = true;
            } else if (ev.type === "error") {
              lastError = ev.message ?? `${ev.phase} error`;
              lastErrorPhase = ev.phase ?? null;
              // Mark the failing step as error, then mark all later
              // pending steps as skipped.
              const stepKey = lastErrorPhase ? phaseToStep(lastErrorPhase) : null;
              if (stepKey) {
                updateStep(stepKey, { state: "error", detail: lastError });
                skipPendingAfter(stepKey);
              }
            }
          } catch { /* ignore malformed line */ }
        }
      }
      if (didFinish) {
        setFullFlowRun((s) => s ? { ...s, done: true, error: null } : s);
        toast({
          title: `${prettyChannel(params.channel)} migrated to channel-specific photos`,
          description: "Photos uploaded to the partner portal and Guesty integration disconnected. Manage this channel's photos directly in its portal from now on.",
        });
        setTimeout(() => {
          setFullFlowRun(null);
          setFullFlow(null);
          queryClient.invalidateQueries({ queryKey });
        }, 2200);
      } else {
        throw new Error(lastError ?? "Flow ended without a done event");
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error(`[isolate-replace-disconnect] error:`, msg);
      setFullFlowRun((s) => s ? { ...s, error: msg, done: false } : s);
      toast({ title: "Migration failed", description: msg, variant: "destructive" });
    }
  };

  if (!guestyListingId) return null;

  const channels = data?.channels ?? CHANNELS.map((c): ChannelStatus => ({
    channel: c.key,
    status: "synced",
    isolatedAt: null,
    isolatedReason: null,
    reEnabledAt: null,
    updatedAt: null,
    partnerListingRef: null,
    hashCount: 0,
    alerts: [],
  }));

  const isFullFlowChannel = (key: string): key is FullFlowChannel => key === "vrbo" || key === "booking";

  // Cross-channel ordering hint: when ≥1 of VRBO/Booking has an alert
  // AND Airbnb also has an alert, surface a banner reminding the
  // operator to resolve the isolatable channels first. Updating
  // Airbnb pushes to Guesty master, which fans out to every still-
  // synced channel — so we want VRBO/Booking already isolated by
  // the time Airbnb's master push happens.
  const airbnbRow = channels.find((c) => c.channel === "airbnb");
  const vrboRow = channels.find((c) => c.channel === "vrbo");
  const bookingRow = channels.find((c) => c.channel === "booking");
  const airbnbAlertCount = airbnbRow?.alerts?.length ?? 0;
  const otherUnsynced = ((vrboRow?.alerts?.length ?? 0) > 0 && vrboRow?.status === "synced")
    || ((bookingRow?.alerts?.length ?? 0) > 0 && bookingRow?.status === "synced");
  const showOrderingHint = airbnbAlertCount > 0 && otherUnsynced;

  return (
    <Card className="p-4 my-4" data-testid="photo-sync-status-panel">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold">Photo Sync Status (per channel)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Each channel is either synced from Guesty's master photos, or isolated and managed independently.
            Use <strong>Isolate + Replace + Disconnect</strong> for VRBO and Booking to migrate to channel-specific photos automatically (sidecar required). Airbnb stays on Guesty's master sync.
          </p>
        </div>
        {isLoading && <RotateCw className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>

      {showOrderingHint && (
        <div
          className="mb-2 text-xs px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-900 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-200"
          data-testid="photo-sync-ordering-hint"
        >
          <strong>Order matters:</strong> resolve VRBO/Booking alerts first (they isolate &
          disconnect from Guesty). Then run Airbnb's "Replace photos" — it pushes via Guesty
          master sync, which fans out to every still-synced channel.
        </div>
      )}

      <div className="space-y-2">
        {CHANNELS.map(({ key, label }) => {
          const row = channels.find((c) => c.channel === key) ?? {
            channel: key, status: "synced" as const, isolatedAt: null, isolatedReason: null,
            reEnabledAt: null, updatedAt: null, partnerListingRef: null, hashCount: 0,
            alerts: [] as AlertEntry[],
          };
          const isIsolated = row.status === "isolated";
          const supportsFullFlow = isFullFlowChannel(key);
          const alerts = row.alerts ?? [];
          const hasAlerts = alerts.length > 0;
          // Hint to resolve VRBO/Booking before Airbnb. We don't hard-
          // disable the Airbnb remediate button — operator may have a
          // reason — but we surface a tooltip and visual cue.
          const isAirbnbBlocked = key === "airbnb" && otherUnsynced;
          return (
            <div
              key={key}
              className={`text-xs border rounded-md ${hasAlerts ? "border-red-300 dark:border-red-700 bg-red-50/40 dark:bg-red-950/20" : ""}`}
              data-testid={`photo-sync-row-${key}`}
            >
              <div className="flex items-center gap-3 p-2">
                <span className="font-medium w-24">{label}</span>
                <Badge
                  variant="outline"
                  className={
                    isIsolated
                      ? "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/40 dark:text-orange-200"
                      : "bg-green-100 text-green-800 border-green-300 dark:bg-green-900/40 dark:text-green-200"
                  }
                  data-testid={`photo-sync-badge-${key}`}
                >
                  {isIsolated ? (
                    <>
                      <ShieldOff className="h-3 w-3 mr-1" />
                      Isolated
                    </>
                  ) : (
                    <>
                      <Shield className="h-3 w-3 mr-1" />
                      Synced
                    </>
                  )}
                </Badge>
                {hasAlerts && (
                  <Badge
                    variant="outline"
                    className="bg-red-100 text-red-800 border-red-300 dark:bg-red-900/40 dark:text-red-200"
                    data-testid={`photo-sync-alert-badge-${key}`}
                  >
                    ⚠ {alerts.length} alert{alerts.length === 1 ? "" : "s"}
                  </Badge>
                )}
                <span className="text-muted-foreground flex-1">
                  {isIsolated ? (
                    <>
                      Isolated {row.isolatedAt ? `on ${new Date(row.isolatedAt).toLocaleDateString()}` : ""}
                      {row.hashCount > 0 ? ` · ${row.hashCount} hashes captured` : ""}
                      {row.partnerListingRef ? ` · ref ${row.partnerListingRef}` : ""}
                      {row.isolatedReason ? ` · ${row.isolatedReason}` : ""}
                    </>
                  ) : (
                    <>Master Sync active{row.reEnabledAt ? ` (re-enabled ${new Date(row.reEnabledAt).toLocaleDateString()})` : ""}</>
                  )}
                </span>
                {supportsFullFlow && !isIsolated && (
                  <Button
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => setFullFlow({
                      channel: key,
                      label,
                      // Persisted server value wins over channelIds (operator
                      // override survives). channelIds is the auto-derived
                      // fallback from Guesty's advertiserId / hotelId on
                      // first-ever click for this channel.
                      partnerListingRef: row.partnerListingRef
                        ?? channelIds?.[key]
                        ?? "",
                      bedrooms: bedrooms ?? 0,
                      reason: "",
                    })}
                    disabled={!communityFolder || !!fullFlowRun}
                    title={
                      !communityFolder
                        ? "communityFolder not provided — full flow needs the resort's community folder."
                        : `Find a clean ${key.toUpperCase()} unit, push its photos to your ${label} listing via the sidecar, and disconnect ${label} from Guesty admin.`
                    }
                    data-testid={`btn-photo-sync-fullflow-${key}`}
                  >
                    <Zap className="h-3 w-3 mr-1" />
                    Isolate + Replace + Disconnect
                  </Button>
                )}
                {isIsolated ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs px-2"
                    onClick={() => reEnableMutation.mutate({ channel: key })}
                    disabled={reEnableMutation.isPending}
                    data-testid={`btn-photo-sync-reenable-${key}`}
                  >
                    Re-enable Master Sync
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs px-2"
                    onClick={() => { setIsolating({ channel: key, label }); setReason(""); }}
                    disabled={isolateMutation.isPending}
                    data-testid={`btn-photo-sync-isolate-${key}`}
                    title={supportsFullFlow ? "Just record isolation intent (no upload, no disconnect)." : "Mark this channel as isolated. Operator handles photo and integration changes manually."}
                  >
                    Isolate (record only)
                  </Button>
                )}
              </div>

              {/* PR #318: per-alert sub-rows. Each alerted unit gets
                  its own remediation button + dismiss. Channel-specific
                  buttons:
                    Airbnb  → "Replace photos" (master-sync remediate)
                    VRBO/Booking → reuses parent row's
                                   "Isolate + Replace + Disconnect" — we
                                   surface a hint instead of a dup button. */}
              {hasAlerts && (
                <div className="border-t border-red-200 dark:border-red-800 px-2 py-2 space-y-1.5">
                  {alerts.map((alert) => {
                    const firstUrl = alert.matchedUrls?.[0]?.listingUrl;
                    const remediateState = airbnbRemediating[alert.id];
                    const isRunning = remediateState?.phase === "running";
                    const isDone = remediateState?.phase === "done";
                    const isError = remediateState?.phase === "error";
                    return (
                      <div key={alert.id} className="flex flex-col gap-1" data-testid={`photo-sync-alert-${key}-${alert.id}`}>
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className="font-mono">{alert.folder}</span>
                          <span className="text-muted-foreground">{alert.priorStatus} → {alert.newStatus}</span>
                          {firstUrl && (
                            <a
                              href={firstUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              view listing ↗
                            </a>
                          )}
                          <span className="text-muted-foreground ml-auto">{new Date(alert.detectedAt).toLocaleString()}</span>
                          {key === "airbnb" ? (
                            <Button
                              size="sm"
                              className={`h-6 text-[11px] px-2 ${isDone ? "bg-green-600 hover:bg-green-600 text-white" : isError ? "bg-red-600 hover:bg-red-600 text-white" : ""}`}
                              onClick={() => remediateAirbnbAlert(alert.id)}
                              disabled={isRunning || isDone}
                              data-testid={`btn-replace-airbnb-${alert.id}`}
                              title={
                                isAirbnbBlocked
                                  ? "Tip: resolve VRBO/Booking alerts first. Master sync would otherwise fan out to those channels too."
                                  : "Find a Zillow unit clean on Airbnb, swap this folder's photos, and push to Guesty (Guesty fans out to Airbnb + still-synced channels)."
                              }
                            >
                              {isDone ? <Check className="h-3 w-3 mr-1" /> : <RotateCw className={`h-3 w-3 mr-1 ${isRunning ? "animate-spin" : ""}`} />}
                              {remediateState?.message ?? "Replace photos"}
                            </Button>
                          ) : (
                            <span
                              className="text-[10px] text-muted-foreground italic"
                              title={`Use the row's "Isolate + Replace + Disconnect" button above to resolve this alert.`}
                            >
                              ↑ use Isolate + Replace + Disconnect
                            </span>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[11px] px-2"
                            onClick={() => dismissAlert(alert.id)}
                            disabled={isRunning}
                            data-testid={`btn-dismiss-alert-${alert.id}`}
                          >
                            Dismiss
                          </Button>
                        </div>
                        {/* Progress bar for the Airbnb master-sync remediate. */}
                        {key === "airbnb" && (isRunning || isDone) && (
                          <div className="flex items-center gap-2 pl-1 pr-1">
                            <div
                              className="h-1.5 flex-1 rounded-full bg-red-200 dark:bg-red-900/40 overflow-hidden"
                              role="progressbar"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={remediateState?.percent ?? 0}
                            >
                              <div
                                className={`h-full transition-[width] duration-300 ease-out ${isDone ? "bg-green-600" : "bg-red-600"}`}
                                style={{ width: `${Math.max(0, Math.min(100, remediateState?.percent ?? 0))}%` }}
                              />
                            </div>
                            <span className="text-[10px] tabular-nums text-muted-foreground min-w-[2.5rem] text-right">
                              {Math.round(remediateState?.percent ?? 0)}%
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Simple Isolate dialog — record intent only. */}
      <Dialog open={!!isolating} onOpenChange={(open) => { if (!open) { setIsolating(null); setReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Isolate {isolating?.label} (record only)?</DialogTitle>
            <DialogDescription>
              Snapshots the photos currently on Guesty as <code>previousBadHashes</code> and marks this channel as isolated.
              Doesn't push new photos or disconnect Guesty's integration — those steps are manual after this.
              For the automated end-to-end flow, use <strong>Isolate + Replace + Disconnect</strong> instead.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Reason (optional, but recommended)</label>
            <Input
              placeholder="e.g. Photos found on competitor's listing — airbnb.com/rooms/50372680"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="input-isolate-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsolating(null); setReason(""); }} disabled={isolateMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => { if (isolating) isolateMutation.mutate({ channel: isolating.channel, reason: reason.trim() || null }); }}
              disabled={isolateMutation.isPending}
              data-testid="btn-isolate-confirm"
            >
              {isolateMutation.isPending ? "Isolating…" : `Isolate ${isolating?.label}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full-flow dialog — find / scrape / upload / disconnect. */}
      <Dialog open={!!fullFlow} onOpenChange={(open) => {
        if (!open && !fullFlowRun) { setFullFlow(null); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Migrate {fullFlow?.label} to channel-specific photos</DialogTitle>
            <DialogDescription>
              We'll find a Zillow unit that's clean on {fullFlow?.label}, push its photos to your {fullFlow?.label} listing
              via the sidecar (your authenticated browser), and then disconnect {fullFlow?.label} from Guesty admin.
              Airbnb is unaffected — it stays on Guesty's master sync.
            </DialogDescription>
          </DialogHeader>
          {fullFlowRun ? (
            <div className="space-y-1.5 py-2">
              {fullFlowRun.steps.map((step, idx) => (
                <div
                  key={step.key}
                  className="flex items-start gap-2 text-sm"
                  data-testid={`fullflow-step-${step.key}`}
                  data-state={step.state}
                >
                  <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center">
                    {step.state === "done" && (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-green-600 text-white">
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                    )}
                    {step.state === "error" && (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white">
                        <X className="h-3 w-3" strokeWidth={3} />
                      </span>
                    )}
                    {step.state === "running" && (
                      <RotateCw className="h-3.5 w-3.5 animate-spin text-blue-600" />
                    )}
                    {step.state === "pending" && (
                      <Circle className="h-3 w-3 text-muted-foreground" />
                    )}
                    {step.state === "skipped" && (
                      <Circle className="h-3 w-3 text-muted-foreground/40" />
                    )}
                  </span>
                  <div className="flex-1">
                    <div
                      className={
                        step.state === "done"
                          ? "text-green-700 dark:text-green-400"
                          : step.state === "error"
                          ? "text-red-700 dark:text-red-400"
                          : step.state === "running"
                          ? "text-blue-700 dark:text-blue-400"
                          : step.state === "skipped"
                          ? "text-muted-foreground/60 line-through"
                          : "text-muted-foreground"
                      }
                    >
                      <span className="text-muted-foreground/70 mr-1.5 font-mono text-xs">{idx + 1}.</span>
                      {step.label}
                    </div>
                    {step.detail && (
                      <div className="text-xs text-muted-foreground mt-0.5 ml-6">
                        {step.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {fullFlowRun.done && (
                <div className="mt-3 rounded-md bg-green-50 dark:bg-green-950/30 border border-green-300 dark:border-green-800 p-2 text-xs text-green-800 dark:text-green-200">
                  ✓ All steps complete. Closing in a moment…
                </div>
              )}
              {fullFlowRun.error && (
                <div className="mt-3 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-800 p-2 text-xs text-red-800 dark:text-red-200">
                  Stopped at the failed step. Audit trail is in <code>photo_sync_audit</code> — re-run after fixing the cause.
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">
                  {fullFlow?.label} partner-portal listing ID
                </label>
                <Input
                  placeholder={fullFlow?.channel === "vrbo" ? "e.g. 1234567 from vrbo.com/partner/listings/1234567" : "e.g. 56789 from Booking extranet URL"}
                  value={fullFlow?.partnerListingRef ?? ""}
                  onChange={(e) => setFullFlow((f) => f ? { ...f, partnerListingRef: e.target.value } : f)}
                  data-testid="input-fullflow-listing-ref"
                />
                <p className="text-xs text-muted-foreground">Saved per (listing, channel) — you'll only need to enter this once.</p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Bedrooms (for replacement search)</label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={fullFlow?.bedrooms || ""}
                  onChange={(e) => setFullFlow((f) => f ? { ...f, bedrooms: Number(e.target.value) || 0 } : f)}
                  data-testid="input-fullflow-bedrooms"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Reason (optional)</label>
                <Input
                  placeholder="e.g. Photos stolen on competitor's Airbnb listing"
                  value={fullFlow?.reason ?? ""}
                  onChange={(e) => setFullFlow((f) => f ? { ...f, reason: e.target.value } : f)}
                  data-testid="input-fullflow-reason"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            {fullFlowRun?.done || fullFlowRun?.error ? (
              <Button variant="outline" onClick={() => { setFullFlowRun(null); setFullFlow(null); }}>
                Close
              </Button>
            ) : fullFlowRun ? (
              <Button variant="outline" disabled>Running… (don't close)</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setFullFlow(null)}>Cancel</Button>
                <Button
                  onClick={() => {
                    if (!fullFlow) return;
                    if (!fullFlow.partnerListingRef.trim()) {
                      toast({ title: "Listing ID required", description: "Enter your partner-portal listing ID for this channel.", variant: "destructive" });
                      return;
                    }
                    if (!fullFlow.bedrooms || fullFlow.bedrooms < 1) {
                      toast({ title: "Bedrooms required", description: "Enter the listing's bedroom count.", variant: "destructive" });
                      return;
                    }
                    void runFullFlow({
                      channel: fullFlow.channel,
                      partnerListingRef: fullFlow.partnerListingRef.trim(),
                      bedrooms: fullFlow.bedrooms,
                      reason: fullFlow.reason.trim() || null,
                    });
                  }}
                  data-testid="btn-fullflow-confirm"
                >
                  <Zap className="h-3 w-3 mr-1" />
                  Run Full Flow
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function prettyChannel(key: string): string {
  return CHANNELS.find((c) => c.key === key)?.label ?? key;
}
