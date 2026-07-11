// Unit Audit Sweep dialog — the dashboard "Audit" column's click target.
//
// One surface, two states:
//   • live sweep — 10-stage checklist updating from GET /api/unit-audit/:jobId
//     (3s poll; the job runs server-side, so closing the dialog / leaving the
//     page never stops it — reopening re-attaches via the dashboard status).
//   • receipt — the last persisted report for this property, with per-stage
//     verdicts + findings and a "Run audit sweep" / "Re-run" button.
//
// Stage vocabulary + labels come from shared/unit-audit-sweep-logic.ts so the
// server, this dialog, and the column badge can never drift.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  UNIT_AUDIT_STAGE_IDS,
  UNIT_AUDIT_STAGE_LABELS,
  isUnitAuditStatusActive,
  rollUpUnitAuditVerdict,
  unitAuditHeadline,
  type UnitAuditJobRecord,
  type UnitAuditStageId,
  type UnitAuditStageResult,
  type UnitAuditStageVerdict,
} from "@shared/unit-audit-sweep-logic";

export type UnitAuditDashboardStatus = {
  reports: Record<string, { verdict: "pass" | "attention" | "failed" | "error"; finishedAt: string; headline: string; stages: UnitAuditStageResult[]; jobId: string }>;
  active: Record<string, { jobId: string; status: UnitAuditJobRecord["status"]; currentStage: UnitAuditStageId | null }>;
};

const VERDICT_STYLE: Record<UnitAuditStageVerdict, { icon: string; color: string; chip?: string; chipBg?: string }> = {
  pass: { icon: "✓", color: "#067647" },
  fixed: { icon: "🔧", color: "#047a70", chip: "fixed", chipBg: "#e4f5f3" },
  attention: { icon: "⚠", color: "#9a5b00", chip: "review", chipBg: "#fdf3e0" },
  failed: { icon: "✕", color: "#b42318", chip: "failed", chipBg: "#fdecea" },
  error: { icon: "?", color: "#6b7280", chip: "unverified", chipBg: "#eef1f4" },
  skipped: { icon: "▫", color: "#9ca3af" },
};

function StageRow({ stageId, result, running }: {
  stageId: UnitAuditStageId;
  result: UnitAuditStageResult | undefined;
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const idx = UNIT_AUDIT_STAGE_IDS.indexOf(stageId) + 1;
  const style = result ? VERDICT_STYLE[result.verdict] : null;
  const items = result?.items ?? [];
  return (
    <li
      className="grid grid-cols-[24px_1fr_auto] items-start gap-x-2 border-b px-1 py-2 text-sm last:border-b-0"
      data-testid={`unit-audit-stage-${stageId}`}
    >
      <span className="text-center" style={{ color: style?.color ?? "#9ca3af" }} aria-hidden="true">
        {running ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-200 border-t-sky-600" />
        ) : (
          style?.icon ?? "○"
        )}
      </span>
      <span className={`font-medium ${result || running ? "" : "text-muted-foreground"}`}>
        {idx} · {UNIT_AUDIT_STAGE_LABELS[stageId]}
      </span>
      <span className="text-right">
        {style?.chip && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: style.color, background: style.chipBg }}>
            {style.chip}
          </span>
        )}
      </span>
      {(result?.detail || running) && (
        <span className="col-start-2 col-end-4 text-xs text-muted-foreground">
          {running && !result ? "Running…" : result?.detail}
          {items.length > 0 && (
            <button
              type="button"
              className="ml-1.5 font-semibold text-sky-700 hover:underline"
              onClick={() => setExpanded((v) => !v)}
              data-testid={`unit-audit-stage-toggle-${stageId}`}
            >
              {expanded ? "hide details" : `details (${items.length})`}
            </button>
          )}
        </span>
      )}
      {expanded && items.length > 0 && (
        <ul className="col-start-2 col-end-4 mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {items.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function UnitAuditDialog({ propertyId, propertyName, open, onOpenChange, status }: {
  propertyId: number;
  propertyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: UnitAuditDashboardStatus | undefined;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  // Auto-fix (default ON — the operator-confirmed default): fixable stages
  // repair + re-verify (hide hash-duplicate photos, regenerate + push
  // descriptions, amenity scan + add-only push, make the cover collage,
  // refresh + push stale pricing). Unchecked = verify-only.
  const [autoFix, setAutoFix] = useState(true);

  // Re-attach to a live sweep the dashboard status already knows about
  // (started on another device / before a reload).
  const activeFromStatus = status?.active?.[String(propertyId)]?.jobId ?? null;
  useEffect(() => {
    if (open && !jobId && activeFromStatus) setJobId(activeFromStatus);
  }, [open, jobId, activeFromStatus]);

  const { data: jobData } = useQuery<{ ok: boolean; job: UnitAuditJobRecord }>({
    queryKey: [`/api/unit-audit/${jobId}`],
    enabled: open && !!jobId,
    refetchInterval: (query) => {
      const job = query.state.data?.job;
      return job && !isUnitAuditStatusActive(job.status) ? false : 3000;
    },
  });
  const job = jobId ? jobData?.job ?? null : null;
  const jobActive = !!job && isUnitAuditStatusActive(job.status);

  // When a watched sweep lands, refresh the column badge + Comm QA (the
  // community stage persists a fresh full check).
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobStatus || isUnitAuditStatusActive(jobStatus)) return;
    void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/unit-audit-status"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/builder/photo-community-status"] });
  }, [jobStatus, queryClient]);

  const report = status?.reports?.[String(propertyId)] ?? null;
  // The freshest finished source wins: a just-finished job beats a stale report.
  const finishedStages: UnitAuditStageResult[] | null = job && !jobActive && job.status === "completed"
    ? job.stages
    : !jobActive && report
      ? report.stages
      : null;

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/unit-audit", { propertyId, autoFix });
      return (await res.json()) as { ok: boolean; job: UnitAuditJobRecord };
    },
    onSuccess: (data) => {
      setJobId(data.job.jobId);
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/unit-audit-status"] });
    },
    onError: (e: any) => {
      toast({ title: "Audit sweep failed to start", description: e?.message ?? String(e), variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!jobId) return;
      await apiRequest("POST", `/api/unit-audit/${jobId}/cancel`);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [`/api/unit-audit/${jobId}`] }),
  });

  const stageResults = useMemo(() => {
    const source = jobActive || (job && job.status !== "completed" && !report) ? job?.stages ?? [] : finishedStages ?? job?.stages ?? [];
    return new Map(source.map((s) => [s.stage, s]));
  }, [job, jobActive, finishedStages, report]);

  const doneCount = job ? job.stages.length : finishedStages?.length ?? 0;
  const overall = finishedStages ? rollUpUnitAuditVerdict(finishedStages) : null;
  const headline = finishedStages ? unitAuditHeadline(finishedStages) : null;
  const showChecklist = jobActive || !!job || !!finishedStages;
  const finishedAtLabel = !jobActive && !job && report?.finishedAt
    ? new Date(report.finishedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto" data-testid="unit-audit-dialog">
        <DialogHeader>
          <DialogTitle>🔍 Audit sweep — {propertyName}</DialogTitle>
          <DialogDescription>
            {jobActive
              ? job?.message ?? "Running…"
              : finishedStages
                ? `${headline}${finishedAtLabel ? ` · finished ${finishedAtLabel}` : ""}`
                : "Verifies every data aspect of this listing — duplicate photos, community match + bedroom coverage, OTA reposts, descriptions, amenities, cover collage, layout, pricing, channels + licenses — and reports each stage honestly."}
          </DialogDescription>
        </DialogHeader>

        {jobActive && (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={UNIT_AUDIT_STAGE_IDS.length}>
            <div className="h-full rounded-full bg-sky-600 transition-all" style={{ width: `${Math.round((doneCount / UNIT_AUDIT_STAGE_IDS.length) * 100)}%` }} />
          </div>
        )}

        {overall && !jobActive && (
          <div
            className="rounded-md border px-3 py-2 text-sm font-medium"
            style={
              overall === "pass"
                ? { background: "#e8f6ee", borderColor: "#b5e2c8", color: "#067647" }
                : overall === "attention"
                  ? { background: "#fdf3e0", borderColor: "#f0d9a8", color: "#9a5b00" }
                  : overall === "failed"
                    ? { background: "#fdecea", borderColor: "#f5c1bb", color: "#b42318" }
                    : { background: "#eef1f4", borderColor: "#d5dae0", color: "#4b5563" }
            }
            data-testid="unit-audit-overall-verdict"
          >
            {overall === "pass" ? "✓ Every check passed — this listing's data looks perfect." : headline}
          </div>
        )}

        {job?.status === "failed" && job.error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{job.error}</div>
        )}

        {showChecklist ? (
          <ol className="rounded-md border">
            {UNIT_AUDIT_STAGE_IDS.map((stageId) => (
              <StageRow
                key={stageId}
                stageId={stageId}
                result={stageResults.get(stageId)}
                running={jobActive && job?.currentStage === stageId}
              />
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            This property has never been audited. A full sweep typically takes 5–15 minutes (the community-photo and OTA
            legs run real Lens + Claude-vision checks) and runs server-side — you can close this and come back.
          </p>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {jobActive ? (
            <span className="text-xs text-muted-foreground">
              Runs server-side — safe to close this dialog or leave the page.
              {job && !job.autoFix ? " (verify-only run)" : ""}
            </span>
          ) : (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoFix}
                onChange={(e) => setAutoFix(e.target.checked)}
                data-testid="checkbox-unit-audit-autofix"
              />
              <span>
                <span className="font-medium">Auto-fix issues</span> — hide duplicate photos, regenerate bad copy, scan + push
                amenities, make the collage, refresh stale pricing (all re-verified; photo/unit replacement stays manual)
              </span>
            </label>
          )}
          <div className="flex shrink-0 gap-2">
            {jobActive ? (
              <Button variant="outline" size="sm" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} data-testid="button-cancel-unit-audit">
                Cancel sweep
              </Button>
            ) : (
              <Button size="sm" onClick={() => startMutation.mutate()} disabled={startMutation.isPending} data-testid="button-run-unit-audit">
                {startMutation.isPending ? "Starting…" : finishedStages ? "Re-run audit sweep" : "Run audit sweep"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
