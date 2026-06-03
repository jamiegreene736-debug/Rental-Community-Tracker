import { useCallback, useState } from "react";
import { FileSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OperationDiagnostics, OperationJobType } from "@shared/operation-diagnostics";
import { apiRequest } from "@/lib/queryClient";
import { OperationDiagnosticsDialog } from "@/components/OperationDiagnosticsDialog";
import { useToast } from "@/hooks/use-toast";

export function OperationFailureActions({
  jobType,
  jobId,
  itemKey,
  startPayload,
  onRemediated,
  className,
}: {
  jobType: OperationJobType;
  jobId: string | null | undefined;
  itemKey?: string | null;
  startPayload?: Record<string, unknown>;
  onRemediated?: (result: { message: string; job?: unknown }) => void;
  className?: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [remediateLoading, setRemediateLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<OperationDiagnostics | null>(null);

  const fetchDiagnostics = useCallback(async () => {
    if (!jobId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ jobType, jobId });
      if (itemKey) params.set("itemKey", itemKey);
      const resp = await fetch(`/api/operations/diagnostics?${params.toString()}`, { credentials: "include" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      setDiagnostics(data.diagnostics);
      setOpen(true);
    } catch (e: any) {
      toast({ title: "Could not load logs", description: e?.message || String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [jobType, jobId, itemKey, toast]);

  const runRemediate = useCallback(async (playbook: string) => {
    if (!jobId) return;
    setRemediateLoading(true);
    try {
      const resp = await apiRequest("POST", "/api/operations/remediate", {
        jobType,
        jobId,
        playbook,
        itemKey: itemKey ?? null,
        startPayload: startPayload ?? undefined,
      });
      const data = await resp.json();
      if (data.diagnostics) setDiagnostics(data.diagnostics);
      if (!data.applied) {
        toast({ title: "Fix not applied", description: data.message, variant: "destructive" });
        return;
      }
      toast({ title: "Fix applied", description: data.message });
      onRemediated?.({ message: data.message, job: data.job });
      setOpen(false);
    } catch (e: any) {
      toast({ title: "Fix failed", description: e?.message || String(e), variant: "destructive" });
    } finally {
      setRemediateLoading(false);
    }
  }, [jobType, jobId, itemKey, startPayload, toast, onRemediated]);

  if (!jobId) return null;

  return (
    <div className={className}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={fetchDiagnostics}
        disabled={loading}
        data-testid="button-check-operation-logs"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5 mr-1.5" />}
        Check logs
      </Button>
      <OperationDiagnosticsDialog
        diagnostics={diagnostics}
        open={open}
        onOpenChange={setOpen}
        onRemediate={runRemediate}
        remediateLoading={remediateLoading}
        onCopySuccess={() => toast({ title: "Log copied" })}
      />
    </div>
  );
}
