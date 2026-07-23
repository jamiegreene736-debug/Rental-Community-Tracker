// Page-level status banner for headless Claude buy-in runs (operator ask
// 2026-07-21: "when I do a bulk run I need the UI on the all reservations
// page to show me like a status"). Renders on the bookings page whenever any
// run is live or ended within the last hour; each row shows the run's status,
// queue position, latest activity, and a Cancel for live runs. The per-row
// expanded panels stay the detailed live-log home — this is the glanceable
// roll-up so a bulk batch's progress is visible without expanding rows.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  ACTIVE_CLAUDE_FIND_RUN_STATUSES,
  type ClaudeFindRunClientView,
  type ClaudeFindRunOverview,
} from "@shared/claude-find-run";
import { Bot, ChevronDown, ChevronUp, Loader2, XCircle } from "lucide-react";

function etaLabel(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `~${Math.max(1, mins)}m left`;
  return `~${Math.round(mins / 60)}h left`;
}

function ageLabel(iso: string | null | undefined): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

function runStatusChip(run: ClaudeFindRunClientView): { label: string; className: string; pulse?: boolean } {
  switch (run.status) {
    case "queued": {
      const ahead = run.queueAhead ?? 0;
      return {
        label: ahead > 0 ? `Queued · ${ahead} ahead` : "Queued · next up",
        className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
      };
    }
    case "claimed":
      return { label: "Starting…", className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300", pulse: true };
    case "running":
      return { label: "Running", className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300", pulse: true };
    case "attention":
      return { label: "Needs you", className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" };
    case "completed":
      return { label: "Done", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" };
    case "failed":
      return { label: "Failed", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" };
    case "cancelled":
      return { label: "Cancelled", className: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" };
    default:
      return { label: run.status, className: "bg-slate-100 text-slate-700" };
  }
}

function runDetail(run: ClaudeFindRunClientView): string {
  if (run.status === "attention" && run.attentionReason) return run.attentionReason;
  if (run.status === "failed" && run.error) return run.error;
  if (run.status === "completed") return run.report ? run.report.replace(/\s+/g, " ").slice(0, 160) : "Finished — see the booking row.";
  const last = run.events[run.events.length - 1];
  return last ? last.text : "";
}

export function ClaudeRunStatusBanner({ onJumpToReservation }: { onJumpToReservation?: (reservationId: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [collapsed, setCollapsed] = useState(false);

  const { data } = useQuery<{ overview: ClaudeFindRunOverview; disabled?: boolean }>({
    queryKey: ["/api/claude-find-runs/overview"],
    queryFn: async () => (await apiRequest("GET", "/api/claude-find-runs/overview")).json(),
    // Fast poll while anything is live; lazy otherwise. The payload is tiny
    // (events stripped server-side), so this is cheap.
    refetchInterval: (query) =>
      (query.state.data?.overview?.active?.length ?? 0) > 0 ? 10_000 : 60_000,
  });

  const overview = data?.overview;
  const cancelRun = useMutation({
    mutationFn: async (runId: string) => {
      const r = await apiRequest("POST", `/api/claude-find-runs/${runId}/cancel`, {});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/claude-find-runs/overview"] });
      qc.invalidateQueries({ queryKey: ["/api/claude-find-runs/status"] });
      toast({ title: "Run cancelled" });
    },
    onError: (e: any) => toast({ title: "Cancel failed", description: e.message, variant: "destructive" }),
  });

  const rows = useMemo(() => [...(overview?.active ?? []), ...(overview?.recent ?? [])], [overview]);
  if (!overview || rows.length === 0) return null;

  const { counts } = overview;
  const summaryBits: string[] = [];
  if (counts.working > 0) summaryBits.push(`${counts.working} running`);
  if (counts.queued > 0) summaryBits.push(`${counts.queued} queued`);
  if (counts.attention > 0) summaryBits.push(`${counts.attention} need${counts.attention === 1 ? "s" : ""} you`);
  if (counts.completed > 0) summaryBits.push(`${counts.completed} done`);
  if (counts.failed > 0) summaryBits.push(`${counts.failed} failed`);
  if (counts.cancelled > 0) summaryBits.push(`${counts.cancelled} cancelled`);
  const anyActive = overview.active.length > 0;

  return (
    <div
      className={`mb-4 rounded-lg border ${anyActive ? "border-sky-300 bg-sky-50/70 dark:border-sky-900 dark:bg-sky-950/30" : "border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/40"}`}
      data-testid="claude-run-status-banner"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
        onClick={() => setCollapsed((v) => !v)}
        data-testid="button-run-banner-toggle"
      >
        {anyActive ? <Loader2 className="h-4 w-4 animate-spin text-sky-600" /> : <Bot className="h-4 w-4 text-slate-500" />}
        <span className="text-sm font-semibold">
          Headless buy-in runs
        </span>
        <span className="text-xs text-muted-foreground" data-testid="text-run-banner-summary">
          {summaryBits.join(" · ")}
        </span>
        <span className="ml-auto text-muted-foreground">
          {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </span>
      </button>

      {/* Cumulative bulk-batch progress — always visible so a "click 52 and walk
          away" batch reads "X of 52 done" at a glance without expanding. */}
      {(overview.batches ?? [])
        .filter((b) => b.total >= 2)
        .map((b) => {
          const pct = b.total > 0 ? Math.round((b.done / b.total) * 100) : 0;
          const bits: string[] = [];
          if (b.working > 0) bits.push(`${b.working} running`);
          if (b.queued > 0) bits.push(`${b.queued} queued`);
          if (b.attention > 0) bits.push(`${b.attention} need${b.attention === 1 ? "s" : ""} you`);
          if (b.failed > 0) bits.push(`${b.failed} failed`);
          const eta = etaLabel(b.etaMs);
          if (eta) bits.push(eta);
          return (
            <div key={b.batchId} className="border-t px-4 py-2" data-testid={`run-batch-progress-${b.batchId}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium">Bulk find · {b.done}/{b.total} done</span>
                <span className="text-muted-foreground" data-testid={`text-batch-summary-${b.batchId}`}>{bits.join(" · ")}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}

      {!collapsed && (
        <div className="divide-y border-t" data-testid="run-banner-rows">
          {rows.map((run) => {
            const chip = runStatusChip(run);
            const detail = runDetail(run);
            const live = ACTIVE_CLAUDE_FIND_RUN_STATUSES.has(run.status);
            return (
              <div key={run.id} className="flex flex-wrap items-center gap-2 px-4 py-2" data-testid={`run-banner-row-${run.id}`}>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.className}`}>
                  {chip.pulse && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />}
                  {chip.label}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {run.kind === "checkout" ? "Checkout" : "Find"}
                </span>
                <button
                  type="button"
                  className={`min-w-0 text-sm font-medium truncate ${onJumpToReservation ? "hover:underline" : "cursor-default"}`}
                  onClick={() => onJumpToReservation?.(run.reservationId)}
                  title={run.propertyName}
                >
                  {run.propertyName}
                  {run.guestName ? <span className="text-muted-foreground font-normal"> · {run.guestName}</span> : null}
                </button>
                {detail && (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={detail}>
                    {detail}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {ageLabel(run.endedAt ?? run.createdAt)}
                </span>
                {live && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-red-600 hover:text-red-700"
                    onClick={() => cancelRun.mutate(run.id)}
                    disabled={cancelRun.isPending}
                    data-testid={`button-run-banner-cancel-${run.id}`}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
