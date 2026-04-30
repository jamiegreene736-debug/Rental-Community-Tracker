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
import { ShieldOff, Shield, RotateCw, Zap, Check, X, Circle, Copy, ClipboardCheck, AlertTriangle } from "lucide-react";

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
  // PR #319: bedroom count of the specific UNIT this alert is for
  // (e.g. unit-423 → 3BR). Used to pre-fill the
  // Isolate+Replace+Disconnect modal so the replacement search
  // looks for a 3BR Zillow unit, not the listing's 6BR total
  // (which would never match for multi-unit aggregates).
  unitBedrooms: number | null;
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
  // PR #319: kept for backward compat but now defaults to
  // `Math.max(...unitBedroomCounts)` when populated. Pili Mai's
  // 5BR Townhomes listing aggregates two 3BR units — total = 6,
  // but the resort has no 6BR units, so a 6BR search returns
  // nothing. Use the LARGEST unit's bedroom count as the row-
  // level default; per-alert remediation overrides with the
  // alerted unit's actual bedrooms via `alert.unitBedrooms`.
  bedrooms?: number;
  unitBedroomCounts?: number[];
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

export function PhotoSyncStatusPanel({ guestyListingId, communityFolder, bedrooms, unitBedroomCounts, channelIds }: Props) {
  // PR #319: row-level default = MAX unit bedroom count when we know
  // the per-unit list, else fall back to the bedrooms prop (legacy
  // sum). Picks a value that's actually findable in the community.
  const defaultBedrooms = (() => {
    if (unitBedroomCounts && unitBedroomCounts.length > 0) {
      const max = Math.max(...unitBedroomCounts);
      if (max > 0) return max;
    }
    return bedrooms ?? 0;
  })();
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

  // PR #334: structured diagnostic report opened in a dialog when
  // any of the channel-remediation actions fails. Captures every
  // observable signal (HTTP status, NDJSON event timeline, server
  // diagnostic blob, browser/timestamp metadata) so the operator
  // can one-click copy a markdown-formatted blob to share with
  // Claude in chat — no DevTools spelunking required.
  type DiagnosticReport = {
    open: boolean;
    action: string;          // human-readable action label
    listingId: string;
    alertId?: number;
    channel?: string;
    httpStatus?: number;
    httpOk?: boolean;
    error?: string;
    serverDiagnostic?: unknown;
    events: Array<{ at: number; raw: string; parsed: unknown }>;
    finalState?: "running-then-disconnected" | "errored" | "completed-without-done";
    startedAt: number;
    endedAt?: number;
  };
  const emptyReport: DiagnosticReport = {
    open: false,
    action: "",
    listingId: guestyListingId,
    events: [],
    startedAt: Date.now(),
  };
  const [diagnostic, setDiagnostic] = useState<DiagnosticReport>(emptyReport);
  const [copied, setCopied] = useState(false);

  // Format the diagnostic report as a markdown blob the operator
  // can paste into chat verbatim. Includes a banner explaining
  // what's needed so the recipient (me) can act on it without
  // asking follow-up questions.
  const formatDiagnostic = (r: DiagnosticReport): string => {
    const lines: string[] = [];
    lines.push("# NexStay action failed — diagnostic report");
    lines.push("");
    lines.push(`**Action:** ${r.action}`);
    lines.push(`**Listing ID:** \`${r.listingId}\``);
    if (r.alertId != null) lines.push(`**Alert ID:** ${r.alertId}`);
    if (r.channel) lines.push(`**Channel:** ${r.channel}`);
    lines.push(`**Started:** ${new Date(r.startedAt).toISOString()}`);
    if (r.endedAt) lines.push(`**Ended:** ${new Date(r.endedAt).toISOString()} (${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s)`);
    lines.push(`**User agent:** ${typeof navigator !== "undefined" ? navigator.userAgent : "n/a"}`);
    lines.push(`**Page URL:** ${typeof window !== "undefined" ? window.location.href : "n/a"}`);
    lines.push("");
    lines.push("## Outcome");
    if (r.httpStatus != null) lines.push(`- HTTP ${r.httpStatus} ${r.httpOk ? "(stream opened)" : "(error response)"}`);
    if (r.finalState) lines.push(`- Final state: \`${r.finalState}\``);
    if (r.error) {
      lines.push("- **Error:**");
      lines.push("");
      lines.push("  ```");
      lines.push("  " + r.error.split("\n").join("\n  "));
      lines.push("  ```");
    }
    lines.push("");
    lines.push(`## Server events received (${r.events.length})`);
    if (r.events.length === 0) {
      lines.push("");
      lines.push("_(none — request didn't produce any NDJSON events before failure)_");
    } else {
      lines.push("");
      lines.push("```");
      const startedAt = r.startedAt;
      for (const ev of r.events) {
        const t = ((ev.at - startedAt) / 1000).toFixed(2).padStart(6, " ");
        const summary = (() => {
          const p = ev.parsed as any;
          if (!p || typeof p !== "object") return ev.raw.slice(0, 200);
          if (p.type === "phase") return `phase ${p.name}: ${p.message ?? ""}`;
          if (p.type === "candidate") return `candidate ${p.unitLabel} (${p.bedrooms}BR) ${p.url}`;
          if (p.type === "swap") return `swap ${p.kept} kept`;
          if (p.type === "push") return `push ${p.success ? "ok" : "FAIL"} → ${p.listing}`;
          if (p.type === "done") return "done";
          if (p.type === "error") {
            const r = p.routing ? ` [routing=${JSON.stringify(p.routing)}]` : "";
            return `error in phase=${p.phase}: ${p.message}${r}`;
          }
          return ev.raw.slice(0, 200);
        })();
        lines.push(`+${t}s  ${summary}`);
      }
      lines.push("```");
    }
    if (r.serverDiagnostic !== undefined) {
      lines.push("");
      lines.push("## Server diagnostic");
      lines.push("");
      lines.push("```json");
      try { lines.push(JSON.stringify(r.serverDiagnostic, null, 2).slice(0, 8000)); }
      catch { lines.push(String(r.serverDiagnostic)); }
      lines.push("```");
    }
    return lines.join("\n");
  };

  const copyDiagnostic = async () => {
    const text = formatDiagnostic(diagnostic);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API can fail (insecure context, permission denied);
      // fall back to a manual textarea copy.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch {}
      document.body.removeChild(ta);
    }
  };
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
    // PR #334: capture every observable signal as we go. On any
    // failure path, open the diagnostic dialog with a one-click
    // "Copy" button so the operator can paste a markdown-formatted
    // report into chat without opening DevTools.
    const report: DiagnosticReport = {
      open: false,
      action: `Replace photos (Airbnb master sync)`,
      listingId: guestyListingId,
      alertId,
      channel: "airbnb",
      events: [],
      startedAt: Date.now(),
    };
    const recordEvent = (raw: string, parsed: unknown) => {
      report.events.push({ at: Date.now(), raw, parsed });
    };

    console.info(`[airbnb-remediate] click → POST /api/photo-listing-alerts/${alertId}/remediate`);
    setAirbnbStatus(alertId, { phase: "running", message: "Starting…", percent: 5 });
    toast({
      title: "Replacing Airbnb photos",
      description: `Finding a clean replacement unit for alert ${alertId}…`,
    });
    try {
      const resp = await fetch(`/api/photo-listing-alerts/${alertId}/remediate`, { method: "POST" });
      report.httpStatus = resp.status;
      report.httpOk = resp.ok;
      console.info(`[airbnb-remediate] alert ${alertId} → HTTP ${resp.status} ${resp.ok ? "(streaming)" : "(error)"}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err && typeof err === "object" && "diagnostic" in err) {
          report.serverDiagnostic = (err as any).diagnostic;
        }
        throw new Error((err as any)?.error || `HTTP ${resp.status}`);
      }
      if (!resp.body) throw new Error("No response body");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let didFinish = false;
      let lastError: string | null = null;
      let lastServerDiagnostic: unknown = undefined;
      let percent = 5;
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any = null;
          try { ev = JSON.parse(line); }
          catch (parseErr) {
            console.warn(`[airbnb-remediate] malformed event line:`, line.slice(0, 200), parseErr);
            recordEvent(line, null);
            continue;
          }
          recordEvent(line, ev);
          console.debug(`[airbnb-remediate] alert ${alertId} event:`, ev);
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
            // Some error events carry a `diagnostic` payload (find-unit
            // attaches per-candidate verdicts); preserve it for the
            // copy-to-clipboard report.
            if (ev.diagnostic !== undefined) lastServerDiagnostic = ev.diagnostic;
          }
        }
      }
      if (didFinish) {
        console.info(`[airbnb-remediate] alert ${alertId} → success`);
        setAirbnbStatus(alertId, { phase: "done", message: "✓ Done!", percent: 100 });
        toast({
          title: "Airbnb photos replaced and pushed",
          description: "Guesty will sync new photos to Airbnb and other still-connected channels over the next few minutes.",
        });
        await new Promise((r) => setTimeout(r, 1500));
        clearAirbnbStatus(alertId);
        queryClient.invalidateQueries({ queryKey });
      } else {
        report.serverDiagnostic = lastServerDiagnostic ?? report.serverDiagnostic;
        report.finalState = lastError ? "errored" : "completed-without-done";
        throw new Error(lastError ?? "Remediate did not finish");
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      report.error = msg;
      report.endedAt = Date.now();
      if (!report.finalState) report.finalState = "errored";
      console.error(`[airbnb-remediate] alert ${alertId} → error:`, msg, e);
      setAirbnbStatus(alertId, { phase: "error", message: `✗ ${msg}`, percent: 100 });
      // PR #334: open the diagnostic dialog directly. Operator clicks
      // Copy → pastes the blob in chat → I have everything I need to
      // diagnose without asking follow-up questions.
      setDiagnostic({ ...report, open: true });
      setTimeout(() => clearAirbnbStatus(alertId), 30_000);
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
    // PR #334: capture every event for the diagnostic dialog. On any
    // failure we open the dialog with a one-click Copy button so the
    // operator can paste the markdown blob into chat.
    const report: DiagnosticReport = {
      open: false,
      action: `Isolate + Replace + Disconnect (${prettyChannel(params.channel)})`,
      listingId: guestyListingId,
      channel: params.channel,
      events: [],
      startedAt: Date.now(),
    };
    const recordEvent = (raw: string, parsed: unknown) => {
      report.events.push({ at: Date.now(), raw, parsed });
    };
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
      report.httpStatus = resp.status;
      report.httpOk = resp.ok;
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err && typeof err === "object" && "diagnostic" in err) {
          report.serverDiagnostic = (err as any).diagnostic;
        }
        throw new Error((err as any)?.error || `HTTP ${resp.status}`);
      }
      if (!resp.body) throw new Error("No response body");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let didFinish = false;
      let lastError: string | null = null;
      let lastErrorPhase: string | null = null;
      let lastServerDiagnostic: unknown = undefined;
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any = null;
          try { ev = JSON.parse(line); }
          catch (parseErr) {
            console.warn(`[isolate-replace-disconnect] malformed event line:`, line.slice(0, 200), parseErr);
            recordEvent(line, null);
            continue;
          }
          recordEvent(line, ev);
          console.debug("[isolate-replace-disconnect] event:", ev);
          {
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
              if (ev.diagnostic !== undefined) lastServerDiagnostic = ev.diagnostic;
            }
          }
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
        report.serverDiagnostic = lastServerDiagnostic ?? report.serverDiagnostic;
        report.finalState = lastError ? "errored" : "completed-without-done";
        throw new Error(lastError ?? "Flow ended without a done event");
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      report.error = msg;
      report.endedAt = Date.now();
      if (!report.finalState) report.finalState = "errored";
      console.error(`[isolate-replace-disconnect] error:`, msg);
      setFullFlowRun((s) => s ? { ...s, error: msg, done: false } : s);
      // PR #334: open the diagnostic dialog directly. Operator clicks
      // Copy → pastes the blob in chat.
      setDiagnostic({ ...report, open: true });
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

  // PR #340: ordering-hint computation removed — every channel uses
  // the same master-sync Replace photos flow now, so there's no
  // tradeoff to communicate. isFullFlowChannel kept because the
  // legacy fullFlow modal (still rendered for backward compat with
  // any in-flight runs) typeguards against it.
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

      {/* PR #340: order-matters banner removed alongside the
          isolate/disconnect machinery. Every channel now uses the
          same master-sync Replace photos flow, so there's no
          ordering tradeoff to communicate. */}

      <div className="space-y-2">
        {CHANNELS.map(({ key, label }) => {
          const row = channels.find((c) => c.channel === key) ?? {
            channel: key, status: "synced" as const, isolatedAt: null, isolatedReason: null,
            reEnabledAt: null, updatedAt: null, partnerListingRef: null, hashCount: 0,
            alerts: [] as AlertEntry[],
          };
          const isIsolated = row.status === "isolated";
          const alerts = row.alerts ?? [];
          const hasAlerts = alerts.length > 0;
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
                {/* PR #340: row-level "Isolate + Replace + Disconnect"
                    + "Isolate (record only)" buttons removed (operator
                    directive — every channel uses the simpler master-
                    sync Replace photos flow now). The only row-level
                    action that survived is "Re-enable Master Sync"
                    for any rows still in the legacy "isolated" state
                    so the operator can flip them back. */}
                {isIsolated && (
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
                )}
              </div>

              {/* PR #340: per-alert sub-rows now use the same Replace
                  photos button on EVERY channel. The remediate flow
                  passes `cleanChannel: alert.platform`, so find-unit
                  picks a Zillow/Realtor/Redfin candidate that's not
                  on whichever channel fired the alert, then pushes
                  via Guesty master sync to all still-synced channels.
                  No more isolate/disconnect complexity. */}
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
                          <Button
                            size="sm"
                            className={`h-6 text-[11px] px-2 ${isDone ? "bg-green-600 hover:bg-green-600 text-white" : isError ? "bg-red-600 hover:bg-red-600 text-white" : ""}`}
                            onClick={() => remediateAirbnbAlert(alert.id)}
                            disabled={isRunning || isDone}
                            data-testid={`btn-replace-${key}-${alert.id}`}
                            title={`Find a unit not on ${label}, swap this folder's photos, and push to Guesty (Guesty fans out to ${label} + still-synced channels).`}
                          >
                            {isDone ? <Check className="h-3 w-3 mr-1" /> : <RotateCw className={`h-3 w-3 mr-1 ${isRunning ? "animate-spin" : ""}`} />}
                            {remediateState?.message ?? "Replace photos"}
                          </Button>
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
                        {(isRunning || isDone) && (
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

      {/* PR #334: failure diagnostic dialog. Opens automatically when
          a channel-remediation action fails. Operator clicks "Copy
          diagnostic" to grab a markdown-formatted report (HTTP
          status, NDJSON event timeline, server diagnostic, browser
          metadata) and pastes it into chat — no DevTools spelunking
          needed for me to triage. */}
      <Dialog open={diagnostic.open} onOpenChange={(open) => { if (!open) setDiagnostic({ ...diagnostic, open: false }); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              {diagnostic.action} failed
            </DialogTitle>
            <DialogDescription>
              Click <strong>Copy diagnostic</strong> below and paste the blob into chat with Claude. It contains
              everything Claude needs to triage without asking follow-up questions: HTTP status, every server
              event, the failure reason, and your browser/page context.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs">
              <div className="font-semibold text-red-700 dark:text-red-300 mb-1">What went wrong</div>
              <pre className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded p-2 whitespace-pre-wrap break-words text-[11px] max-h-32 overflow-auto">
                {diagnostic.error || "(no error message captured)"}
              </pre>
            </div>
            <div className="text-xs">
              <div className="font-semibold mb-1">Quick summary</div>
              <ul className="text-[11px] space-y-0.5 text-muted-foreground">
                <li>• Action: <span className="font-mono">{diagnostic.action}</span></li>
                {diagnostic.alertId != null && <li>• Alert ID: <span className="font-mono">{diagnostic.alertId}</span></li>}
                {diagnostic.channel && <li>• Channel: <span className="font-mono">{diagnostic.channel}</span></li>}
                {diagnostic.httpStatus != null && (
                  <li>• HTTP: <span className="font-mono">{diagnostic.httpStatus}</span> {diagnostic.httpOk ? "(stream opened)" : "(error response)"}</li>
                )}
                <li>• Events received: <span className="font-mono">{diagnostic.events.length}</span></li>
                {diagnostic.endedAt && (
                  <li>• Wall: <span className="font-mono">{((diagnostic.endedAt - diagnostic.startedAt) / 1000).toFixed(1)}s</span></li>
                )}
              </ul>
            </div>
            <div className="text-xs">
              <details>
                <summary className="cursor-pointer font-semibold mb-1">Preview the full report ({formatDiagnostic(diagnostic).length} chars)</summary>
                <pre className="mt-2 bg-gray-50 dark:bg-gray-900 border rounded p-2 whitespace-pre-wrap break-words text-[10px] font-mono max-h-64 overflow-auto">
                  {formatDiagnostic(diagnostic)}
                </pre>
              </details>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDiagnostic({ ...diagnostic, open: false })} data-testid="btn-diagnostic-close">
              Close
            </Button>
            <Button onClick={copyDiagnostic} data-testid="btn-diagnostic-copy" className={copied ? "bg-green-600 hover:bg-green-600" : ""}>
              {copied ? <ClipboardCheck className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
              {copied ? "Copied! Paste into chat" : "Copy diagnostic"}
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
