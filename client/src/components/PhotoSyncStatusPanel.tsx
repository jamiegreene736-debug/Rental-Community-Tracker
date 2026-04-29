// Per-channel photo-sync status panel for the Guesty listing builder.
//
// Reads /api/listings/:id/photo-sync-status and renders one row per
// OTA channel (Airbnb / VRBO / Booking) with the current status
// (synced / isolated), last action timestamps, and per-channel
// actions (Isolate, Re-enable Master Sync).
//
// Isolation is the destructive action — opens a small dialog asking
// for a reason. Re-enable is one-click. Both refetch on success so
// the badge color flips immediately.

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
import { ShieldOff, Shield, RotateCw } from "lucide-react";

const CHANNELS = [
  { key: "airbnb", label: "Airbnb" },
  { key: "vrbo", label: "VRBO" },
  { key: "booking", label: "Booking.com" },
] as const;

type ChannelStatus = {
  channel: string;
  status: "synced" | "isolated";
  isolatedAt: string | null;
  isolatedReason: string | null;
  reEnabledAt: string | null;
  updatedAt: string | null;
  hashCount: number;
};

type StatusResponse = {
  guestyListingId: string;
  channels: ChannelStatus[];
};

export function PhotoSyncStatusPanel({ guestyListingId }: { guestyListingId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isolating, setIsolating] = useState<{ channel: string; label: string } | null>(null);
  const [reason, setReason] = useState("");

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

  if (!guestyListingId) return null;

  const channels = data?.channels ?? CHANNELS.map((c): ChannelStatus => ({
    channel: c.key,
    status: "synced",
    isolatedAt: null,
    isolatedReason: null,
    reEnabledAt: null,
    updatedAt: null,
    hashCount: 0,
  }));

  return (
    <Card className="p-4 my-4" data-testid="photo-sync-status-panel">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold">Photo Sync Status (per channel)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Each channel is either synced from Guesty's master photos, or isolated and managed independently.
            Isolation captures the photo hashes live at the time so the daily scanner can flag re-theft.
          </p>
        </div>
        {isLoading && <RotateCw className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>

      <div className="space-y-2">
        {CHANNELS.map(({ key, label }) => {
          const row = channels.find((c) => c.channel === key) ?? {
            channel: key, status: "synced" as const, isolatedAt: null, isolatedReason: null,
            reEnabledAt: null, updatedAt: null, hashCount: 0,
          };
          const isIsolated = row.status === "isolated";
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
                    {row.isolatedReason ? ` · ${row.isolatedReason}` : ""}
                  </>
                ) : (
                  <>Master Sync active{row.reEnabledAt ? ` (re-enabled ${new Date(row.reEnabledAt).toLocaleDateString()})` : ""}</>
                )}
              </span>
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
                >
                  Isolate
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <Dialog open={!!isolating} onOpenChange={(open) => { if (!open) { setIsolating(null); setReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Isolate {isolating?.label} from Guesty Master Sync?</DialogTitle>
            <DialogDescription>
              We'll snapshot the photos currently on this listing as the "previous bad hashes" and mark this channel as isolated.
              You'll need to manually disconnect the {isolating?.label} integration in Guesty admin
              and upload replacement photos directly to the channel — Phase 1 just records intent.
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
    </Card>
  );
}

function prettyChannel(key: string): string {
  return CHANNELS.find((c) => c.key === key)?.label ?? key;
}
