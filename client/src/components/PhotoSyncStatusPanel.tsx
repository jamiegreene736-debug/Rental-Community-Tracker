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
import { ShieldOff, Shield, RotateCw, Zap } from "lucide-react";

const CHANNELS = [
  { key: "airbnb", label: "Airbnb" },
  { key: "vrbo", label: "VRBO" },
  { key: "booking", label: "Booking.com" },
] as const;
type ChannelKey = typeof CHANNELS[number]["key"];

type ChannelStatus = {
  channel: string;
  status: "synced" | "isolated";
  isolatedAt: string | null;
  isolatedReason: string | null;
  reEnabledAt: string | null;
  updatedAt: string | null;
  partnerListingRef: string | null;
  hashCount: number;
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
  // Streaming progress state for the full flow. While running, button
  // is disabled and the dialog shows phase + last message.
  const [fullFlowRun, setFullFlowRun] = useState<{
    channel: FullFlowChannel;
    phase: string;
    message: string;
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
  const runFullFlow = async (params: { channel: FullFlowChannel; partnerListingRef: string; bedrooms: number; reason: string | null }) => {
    if (!communityFolder) {
      toast({ title: "Can't run full flow", description: "communityFolder missing — pass it as a prop from the builder.", variant: "destructive" });
      return;
    }
    setFullFlowRun({ channel: params.channel, phase: "starting", message: "Connecting to server…", done: false, error: null });
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
              setFullFlowRun((s) => s ? { ...s, phase: ev.name, message: ev.message ?? ev.name } : s);
            } else if (ev.type === "candidate") {
              setFullFlowRun((s) => s ? { ...s, message: `Found ${ev.unitLabel} (${ev.bedrooms ?? "?"}BR)` } : s);
            } else if (ev.type === "scrape-result") {
              setFullFlowRun((s) => s ? { ...s, message: `Scraped ${ev.count} photos` } : s);
            } else if (ev.type === "snapshot-result") {
              setFullFlowRun((s) => s ? { ...s, message: `Snapshotted ${ev.hashCount} current hashes` } : s);
            } else if (ev.type === "upload-result") {
              setFullFlowRun((s) => s ? { ...s, message: `Uploaded ${ev.uploaded} (${ev.failed} failed) in ${Math.round(ev.durationMs / 1000)}s` } : s);
            } else if (ev.type === "disconnect-result") {
              setFullFlowRun((s) => s ? { ...s, message: ev.ok ? "Disconnected from Guesty" : `Disconnect failed: ${ev.message}` } : s);
            } else if (ev.type === "done") {
              didFinish = true;
            } else if (ev.type === "error") {
              lastError = ev.message ?? `${ev.phase} error`;
            }
          } catch { /* ignore malformed line */ }
        }
      }
      if (didFinish) {
        setFullFlowRun((s) => s ? { ...s, phase: "done", message: "✓ Done", done: true, error: null } : s);
        toast({
          title: `${prettyChannel(params.channel)} migrated to channel-specific photos`,
          description: "New photos uploaded to the partner portal and Guesty integration disconnected. From now on, manage photos for this channel directly in its portal.",
        });
        // Brief pause so the operator sees the "✓ Done" state, then close.
        setTimeout(() => {
          setFullFlowRun(null);
          setFullFlow(null);
          queryClient.invalidateQueries({ queryKey });
        }, 1800);
      } else {
        throw new Error(lastError ?? "Flow ended without a done event");
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error(`[isolate-replace-disconnect] error:`, msg);
      setFullFlowRun((s) => s ? { ...s, phase: "error", message: msg, done: false, error: msg } : s);
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
  }));

  const isFullFlowChannel = (key: string): key is FullFlowChannel => key === "vrbo" || key === "booking";

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

      <div className="space-y-2">
        {CHANNELS.map(({ key, label }) => {
          const row = channels.find((c) => c.channel === key) ?? {
            channel: key, status: "synced" as const, isolatedAt: null, isolatedReason: null,
            reEnabledAt: null, updatedAt: null, partnerListingRef: null, hashCount: 0,
          };
          const isIsolated = row.status === "isolated";
          const supportsFullFlow = isFullFlowChannel(key);
          return (
            <div
              key={key}
              className="flex items-center gap-3 text-xs border rounded-md p-2"
              data-testid={`photo-sync-row-${key}`}
            >
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
            <div className="space-y-2 py-2">
              <div className="text-xs">
                <span className="font-mono uppercase text-muted-foreground">{fullFlowRun.phase}</span>
                {!fullFlowRun.done && !fullFlowRun.error && <RotateCw className="inline-block ml-2 h-3 w-3 animate-spin" />}
              </div>
              <div className={`text-sm ${fullFlowRun.error ? "text-red-600" : fullFlowRun.done ? "text-green-700" : ""}`}>
                {fullFlowRun.message}
              </div>
              {fullFlowRun.error && (
                <div className="text-xs text-muted-foreground">
                  Audit trail of what happened is in <code>photo_sync_audit</code> — re-run after fixing.
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
