import { Copy, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import type { OperationDiagnostics } from "@shared/operation-diagnostics";
import { sanitizeForChatText } from "@shared/safe-log";

function severityClass(severity: OperationDiagnostics["severity"]): string {
  if (severity === "error") return "border-red-300 bg-red-50 text-red-900";
  if (severity === "warning") return "border-amber-300 bg-amber-50 text-amber-900";
  return "border-emerald-300 bg-emerald-50 text-emerald-900";
}

export function OperationDiagnosticsDialog({
  diagnostics,
  open,
  onOpenChange,
  onRemediate,
  remediateLoading,
  onCopySuccess,
}: {
  diagnostics: OperationDiagnostics | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemediate?: (playbook: string) => void;
  remediateLoading?: boolean;
  onCopySuccess?: () => void;
}) {
  if (!diagnostics) return null;
  const safeReport = sanitizeForChatText(diagnostics.report, { maxLength: 12_000 });
  const copyReport = async () => {
    await navigator.clipboard.writeText(safeReport);
    onCopySuccess?.();
  };
  const issueCount = diagnostics.issues?.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {diagnostics.title}
          </DialogTitle>
          <DialogDescription>
            Operator log for this failure. Use Fix it when a safe automatic retry is available.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className={`rounded-md border px-3 py-2 text-sm ${severityClass(diagnostics.severity)}`}>
            {diagnostics.summary}
          </div>

          {issueCount > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 mb-2">Issues</p>
              <div className="space-y-2">
                {diagnostics.issues!.map((issue, idx) => (
                  <div key={`${issue.source}-${idx}`} className="text-xs text-amber-950">
                    <span className="font-semibold">[{issue.severity}] {issue.source}:</span>{" "}
                    {issue.summary}
                    {issue.detail && <span className="text-amber-800"> — {issue.detail}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {diagnostics.remediation && diagnostics.remediation.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {diagnostics.remediation.map((action) => (
                <Button
                  key={action.playbook}
                  size="sm"
                  variant={action.autoRunnable ? "default" : "outline"}
                  disabled={!action.autoRunnable || remediateLoading || !onRemediate}
                  onClick={() => onRemediate?.(action.playbook)}
                  title={action.description}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Copy-friendly safe log
              </p>
              <Button size="sm" variant="outline" onClick={copyReport}>
                <Copy className="h-3.5 w-3.5 mr-1" /> Copy safe log
              </Button>
            </div>
            <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 text-slate-50 p-3 text-[11px] whitespace-pre-wrap">
              {safeReport}
            </pre>
          </div>

          {diagnostics.context?.failureClass && (
            <Badge variant="outline" className="text-[10px]">
              {String(diagnostics.context.failureClass)}
            </Badge>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
