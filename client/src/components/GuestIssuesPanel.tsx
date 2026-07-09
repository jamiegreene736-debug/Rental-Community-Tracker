import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle, Plus, Trash2, Loader2, CheckCircle, Clock, RotateCcw, Send, X, MessageSquare, ScanSearch,
} from "lucide-react";
import {
  GUEST_ISSUE_SEVERITIES,
  guestIssueStatusLabel,
  guestIssueSeverityLabel,
  summarizeGuestIssueStatuses,
} from "@shared/guest-issue-logic";

// All guest-issue queries are keyed under this prefix (per-conversation panel,
// the tab list, and the tab's open-count badge), so invalidating the prefix
// refreshes every surface at once — the badge clears the moment one is resolved.
const GUEST_ISSUES_KEY = "/api/inbox/guest-issues";

// Mirrors the server shapes (shared/schema.ts guestIssues / guestIssueComments).
type GuestIssueComment = {
  id: number;
  issueId: number;
  conversationId: string;
  body: string;
  statusChange: string | null;
  authorName: string;
  authorRole: string;
  source: string;
  createdAt: string;
};

type GuestIssue = {
  id: number;
  conversationId: string;
  reservationId: string | null;
  guestName: string | null;
  listingId: string | null;
  title: string;
  description: string | null;
  severity: string;
  kind: string; // property | back_office
  status: string;
  createdBy: string;
  createdByRole: string;
  createdAt: string;
  updatedAt: string;
  lastCommentAt: string | null;
  resolvedAt: string | null;
  comments: GuestIssueComment[];
};

interface GuestIssuesPanelProps {
  conversationId: string;
  reservationId?: string | null;
  guestName?: string | null;
  listingId?: string | null;
  /** Only the operator (admin) may permanently delete an issue. */
  canDelete?: boolean;
}

const STATUS_TONE: Record<string, string> = {
  open: "bg-amber-100 text-amber-900 border border-amber-200",
  ongoing: "bg-blue-100 text-blue-900 border border-blue-200",
  resolved: "bg-green-100 text-green-900 border border-green-200",
};

const SEVERITY_TONE: Record<string, string> = {
  low: "bg-slate-100 text-slate-600",
  normal: "bg-slate-100 text-slate-600",
  high: "bg-orange-100 text-orange-800",
  urgent: "bg-red-100 text-red-800",
};

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString([], {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function authorLabel(name: string, role: string): string {
  // The automatic complaint scanner writes issues/comments with role "system"
  // (author "auto-scan") — show a single friendly label, not "auto-scan (system)".
  if (role === "system") return "auto-detected";
  const roleWord = role === "admin" ? "operator" : role === "agent" ? "agent" : (role || "agent");
  // The shared "agent" login has username === role, so just show the role word;
  // a distinct username (future per-agent accounts) gets "name (role)".
  return name && name !== role ? `${name} (${roleWord})` : roleWord;
}

export function GuestIssuesPanel({
  conversationId,
  reservationId,
  guestName,
  listingId,
  canDelete = false,
}: GuestIssuesPanelProps) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("normal");

  const queryKey = [GUEST_ISSUES_KEY, conversationId];

  const { data, isLoading } = useQuery<{ issues: GuestIssue[] }>({
    queryKey,
    enabled: !!conversationId,
    // apiRequest throws on any non-2xx (throwIfResNotOk), so no manual r.ok check.
    queryFn: async () => (await apiRequest("GET", `/api/inbox/guest-issues/${conversationId}?limit=50`)).json(),
    refetchInterval: 30_000,
  });

  const issues = data?.issues ?? [];
  const counts = summarizeGuestIssueStatuses(issues);

  // Invalidate the whole prefix so the tab list + tab badge refresh too.
  const invalidate = () => qc.invalidateQueries({ queryKey: [GUEST_ISSUES_KEY] });

  const createIssue = useMutation({
    mutationFn: async () => {
      const t = title.trim();
      if (t.length < 2) throw new Error("Please add a short title for the issue.");
      const r = await apiRequest("POST", "/api/inbox/guest-issues", {
        conversationId,
        reservationId: reservationId ?? null,
        guestName: guestName ?? null,
        listingId: listingId ?? null,
        title: t,
        description: description.trim() || null,
        severity,
      });
      return r.json();
    },
    onSuccess: () => {
      setTitle("");
      setDescription("");
      setSeverity("normal");
      setShowNew(false);
      invalidate();
      toast({ title: "Issue logged", description: "The guest issue was added." });
    },
    onError: (e: any) =>
      toast({ title: "Could not log issue", description: e.message, variant: "destructive" }),
  });

  if (!conversationId) return null;

  return (
    <div className="rounded-lg border bg-card p-3" data-testid="panel-guest-issues">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-rose-600" />
          <div className="text-sm font-semibold">Guest issues</div>
          {counts.unresolved > 0 ? (
            <Badge className="bg-rose-100 text-rose-800 hover:bg-rose-100" data-testid="badge-guest-issues-unresolved">
              {counts.unresolved} open
            </Badge>
          ) : counts.total > 0 ? (
            <Badge className="bg-green-100 text-green-800 hover:bg-green-100">All resolved</Badge>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={showNew ? "secondary" : "outline"}
          className="h-7 px-2 text-xs"
          onClick={() => setShowNew((v) => !v)}
          data-testid="button-guest-issue-new"
        >
          {showNew ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          <span className="ml-1">{showNew ? "Cancel" : "New issue"}</span>
        </Button>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        Track guest problems here. You and remote agents can comment and mark each one ongoing or resolved.
      </p>

      {showNew && (
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2" data-testid="form-guest-issue-new">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short title (e.g. AC not cooling in bedroom)"
            aria-label="Issue title"
            className="h-8 text-sm"
            maxLength={200}
            data-testid="input-guest-issue-title"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Details (optional)"
            aria-label="Issue details"
            className="min-h-[56px] text-sm"
            data-testid="textarea-guest-issue-description"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Severity</span>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="h-8 w-28 text-xs" data-testid="select-guest-issue-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GUEST_ISSUE_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {guestIssueSeverityLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={createIssue.isPending || title.trim().length < 2}
              onClick={() => createIssue.mutate()}
              data-testid="button-guest-issue-create"
            >
              {createIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              <span className="ml-1">Log issue</span>
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading issues…
          </div>
        ) : issues.length === 0 ? (
          <div className="text-xs text-muted-foreground" data-testid="text-guest-issues-empty">
            No issues logged for this guest yet.
          </div>
        ) : (
          issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              canDelete={canDelete}
              onChanged={invalidate}
            />
          ))
        )}
      </div>
    </div>
  );
}

function IssueCard({
  issue,
  canDelete,
  onChanged,
  onOpenConversation,
}: {
  issue: GuestIssue;
  canDelete: boolean;
  onChanged: () => void;
  /** When set (tab view), shows the guest + a jump-to-conversation link. */
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { toast } = useToast();
  const [comment, setComment] = useState("");

  const addComment = useMutation({
    mutationFn: async (statusChange?: string) => {
      const body = comment.trim();
      if (!body && !statusChange) throw new Error("Type a comment or choose a status.");
      const r = await apiRequest("POST", `/api/inbox/guest-issues/${issue.id}/comments`, {
        body: body || undefined,
        statusChange,
      });
      return r.json();
    },
    onSuccess: () => {
      setComment("");
      onChanged();
    },
    onError: (e: any) =>
      toast({ title: "Update not saved", description: e.message, variant: "destructive" }),
  });

  const deleteIssue = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("DELETE", `/api/inbox/guest-issues/${issue.id}`);
      return r.json();
    },
    onSuccess: () => {
      onChanged();
      toast({ title: "Issue deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Could not delete", description: e.message, variant: "destructive" }),
  });

  const isResolved = issue.status === "resolved";
  const busy = addComment.isPending;

  return (
    <div className="rounded-md border bg-background p-2.5" data-testid={`guest-issue-${issue.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_TONE[issue.status] ?? STATUS_TONE.open}`}
              data-testid={`badge-guest-issue-status-${issue.id}`}
            >
              {guestIssueStatusLabel(issue.status)}
            </span>
            {issue.severity && issue.severity !== "normal" && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_TONE[issue.severity] ?? SEVERITY_TONE.normal}`}>
                {guestIssueSeverityLabel(issue.severity)}
              </span>
            )}
            {issue.createdByRole === "system" && (
              <span
                className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-800"
                title="Opened automatically by the guest-inbox complaint scanner"
                data-testid={`badge-guest-issue-auto-${issue.id}`}
              >
                Auto-detected
              </span>
            )}
            {issue.kind === "back_office" && (
              <span
                className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800"
                title="Back-office matter (refund / billing / cancellation)"
                data-testid={`badge-guest-issue-kind-${issue.id}`}
              >
                Back-office
              </span>
            )}
            <span className="truncate text-sm font-medium">{issue.title}</span>
          </div>
          {issue.description && (
            <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{issue.description}</div>
          )}
          <div className="mt-1 text-[10px] text-muted-foreground">
            {onOpenConversation && issue.guestName ? `${issue.guestName} · ` : ""}
            Opened by {authorLabel(issue.createdBy, issue.createdByRole)} · {fmtWhen(issue.createdAt)}
          </div>
          {onOpenConversation && (
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
              onClick={() => onOpenConversation(issue.conversationId)}
              data-testid={`button-guest-issue-open-conv-${issue.id}`}
            >
              <MessageSquare className="h-3 w-3" />
              {issue.guestName ? `Open ${issue.guestName}'s conversation` : "Open conversation"}
            </button>
          )}
        </div>
        {canDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600"
            title="Delete issue"
            aria-label="Delete issue"
            disabled={deleteIssue.isPending}
            onClick={() => {
              if (window.confirm("Permanently delete this issue and its comments? This cannot be undone.")) {
                deleteIssue.mutate();
              }
            }}
            data-testid={`button-guest-issue-delete-${issue.id}`}
          >
            {deleteIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        )}
      </div>

      {issue.comments.length > 0 && (
        <div className="mt-2 space-y-1.5 border-l-2 border-muted pl-2">
          {issue.comments.map((c) => (
            <div key={c.id} className="text-xs" data-testid={`guest-issue-comment-${c.id}`}>
              <div className="whitespace-pre-wrap">{c.body}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{authorLabel(c.authorName, c.authorRole)}</span>
                <span>· {fmtWhen(c.createdAt)}</span>
                {c.statusChange && (
                  <span className={`rounded px-1 py-0.5 font-semibold ${STATUS_TONE[c.statusChange] ?? ""}`}>
                    → {guestIssueStatusLabel(c.statusChange)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add an update for this issue…"
          aria-label="Add an update for this issue"
          className="min-h-[44px] text-xs"
          data-testid={`textarea-guest-issue-comment-${issue.id}`}
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={busy || comment.trim().length === 0}
            onClick={() => addComment.mutate(undefined)}
            data-testid={`button-guest-issue-comment-${issue.id}`}
          >
            <Send className="h-3.5 w-3.5" />
            <span className="ml-1">Comment</span>
          </Button>
          {issue.status !== "ongoing" && !isResolved && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs text-blue-700"
              disabled={busy}
              onClick={() => addComment.mutate("ongoing")}
              data-testid={`button-guest-issue-ongoing-${issue.id}`}
            >
              <Clock className="h-3.5 w-3.5" />
              <span className="ml-1">Mark ongoing</span>
            </Button>
          )}
          {!isResolved && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs text-green-700"
              disabled={busy}
              onClick={() => addComment.mutate("resolved")}
              data-testid={`button-guest-issue-resolve-${issue.id}`}
            >
              <CheckCircle className="h-3.5 w-3.5" />
              <span className="ml-1">Mark resolved</span>
            </Button>
          )}
          {isResolved && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs text-amber-700"
              disabled={busy}
              onClick={() => addComment.mutate("open")}
              data-testid={`button-guest-issue-reopen-${issue.id}`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="ml-1">Reopen</span>
            </Button>
          )}
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      </div>
    </div>
  );
}

const TAB_FILTERS: { key: string; label: string }[] = [
  { key: "unresolved", label: "Needs attention" },
  { key: "open", label: "Open" },
  { key: "ongoing", label: "Ongoing" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

// Cross-conversation issues inbox tab: every issue across all guests of ONE kind
// (property → "Guest Issues" tab, back_office → "Back-Office Issues" tab),
// filterable by status, with the same comment / status / delete actions as the
// per-conversation panel plus a jump-to-conversation link. Creation stays in the
// per-conversation panel (an issue must attach to a guest thread).
export function GuestIssuesTab({
  kind = "property",
  canDelete = false,
  onOpenConversation,
}: {
  kind?: "property" | "back_office";
  canDelete?: boolean;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState("unresolved");
  const backOffice = kind === "back_office";

  const { data, isLoading, isError } = useQuery<{ issues: GuestIssue[] }>({
    queryKey: [GUEST_ISSUES_KEY, "tab", kind, filter],
    queryFn: async () =>
      (await apiRequest("GET", `${GUEST_ISSUES_KEY}?status=${filter}&kind=${kind}&withComments=1&limit=200`)).json(),
    refetchInterval: 30_000,
  });

  const issues = data?.issues ?? [];
  const counts = summarizeGuestIssueStatuses(issues);
  const invalidate = () => qc.invalidateQueries({ queryKey: [GUEST_ISSUES_KEY] });

  // Operator-only manual sweep of the guest inbox for complaints. The scanner
  // also runs automatically every ~5 min; this is the on-demand trigger. Any
  // issues/notes it opens flow into the same queries, so the list refreshes.
  const scanInbox = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/inbox/complaint-scan/run", {})).json(),
    onSuccess: (r: any) => {
      invalidate();
      const opened = r?.created ?? 0;
      const appended = r?.appended ?? 0;
      toast({
        title: r?.backfillComplete === false ? "Scanning inbox…" : "Inbox scanned",
        description:
          r?.backfillComplete === false
            ? "First-time full scan is still working through the inbox — run again in a moment."
            : `${opened} new issue(s) opened, ${appended} note(s) added.`,
      });
    },
    onError: (e: any) =>
      toast({ title: "Scan failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4" data-testid={`panel-guest-issues-tab${backOffice ? "-back-office" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertCircle className={`h-5 w-5 ${backOffice ? "text-violet-600" : "text-rose-600"}`} />
          <h2 className="text-base font-semibold">{backOffice ? "Back-office issues" : "Guest issues"}</h2>
          {filter === "unresolved" && counts.total > 0 && (
            <Badge className="bg-rose-100 text-rose-800 hover:bg-rose-100">{counts.unresolved} open</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {/* One scan sweeps the whole inbox and fills BOTH tabs — show the button
              only on the property tab to avoid a redundant control. */}
          {canDelete && !backOffice && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={scanInbox.isPending}
              onClick={() => scanInbox.mutate()}
              title="Scan the whole guest inbox now and auto-log any complaints/requests as issues"
              data-testid="button-guest-issues-scan"
            >
              {scanInbox.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
              <span className="ml-1">Scan for complaints</span>
            </Button>
          )}
          {TAB_FILTERS.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={filter === f.key ? "default" : "outline"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setFilter(f.key)}
              data-testid={`button-guest-issues-filter-${f.key}`}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {backOffice
          ? "Refund requests, billing disputes, and cancellation requests across your guests — auto-detected from the inbox (marked “Auto-detected”) or logged manually. Comment and mark each one ongoing or resolved."
          : "Property-side issues (maintenance, cleanliness, noise, access, safety, amenities) across your guests. Comment and mark each one ongoing or resolved — the tab badge clears as issues are resolved. Logged from the per-conversation panel or opened automatically by the inbox scanner (marked “Auto-detected”)."}
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading issues…
        </div>
      ) : isError ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800"
          data-testid="panel-guest-issues-tab-error"
        >
          <AlertCircle className="mx-auto mb-1 h-5 w-5 text-red-500" />
          Couldn't load guest issues — this is an alert surface, so it won't show "all clear" on a failure. Retrying automatically…
        </div>
      ) : issues.length === 0 ? (
        <div
          className="rounded-lg border border-dashed bg-card p-6 text-center text-sm text-muted-foreground"
          data-testid="panel-guest-issues-tab-empty"
        >
          <AlertCircle className="mx-auto mb-1 h-5 w-5 text-muted-foreground/60" />
          {filter === "resolved"
            ? "No resolved issues yet."
            : filter === "all"
              ? backOffice ? "No back-office issues logged yet." : "No guest issues logged yet."
              : filter === "unresolved"
                ? backOffice ? "Nothing needs attention — no open refund/cancellation requests." : "Nothing needs attention — no open guest issues."
                : `No ${filter} issues.`}
        </div>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              canDelete={canDelete}
              onChanged={invalidate}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </div>
      )}
    </div>
  );
}
