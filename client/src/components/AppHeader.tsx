import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CalendarSearch, Home, MessageSquare, PhoneMissed } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { usePortalSession } from "@/lib/auth";

type AutoReplyLogSummary = {
  status?: string | null;
  replySent?: boolean | null;
};

function isPendingAutoReplyLog(log: AutoReplyLogSummary): boolean {
  return (
    !log.replySent &&
    log.status !== "dismissed" &&
    (log.status === "drafted" || log.status === "flagged" || log.status === "error")
  );
}

export default function AppHeader() {
  const [location] = useLocation();
  const { data: session } = usePortalSession();
  const isAgent = session?.role === "agent";
  const isHome = location === "/";
  const isInbox = location.startsWith("/inbox");
  const isOperations = location.startsWith("/bookings");
  const { data: pendingDraftCount = 0 } = useQuery<number>({
    queryKey: ["/api/inbox/auto-reply/logs", "pending-count"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/inbox/auto-reply/logs?limit=200");
      if (!response.ok) return 0;
      const logs = await response.json();
      return Array.isArray(logs) ? logs.filter(isPendingAutoReplyLog).length : 0;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const { data: missedCallCount = 0 } = useQuery<number>({
    queryKey: ["/api/inbox/calls/unacknowledged", "count"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/inbox/calls/unacknowledged?limit=100");
      if (!response.ok) return 0;
      const data = await response.json();
      return Number(data?.count ?? data?.calls?.length ?? 0) || 0;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const inboxAlertCount = pendingDraftCount + missedCallCount;
  const unreadBadgeLabel = inboxAlertCount > 99 ? "99+" : String(inboxAlertCount);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[hsl(var(--brand-blue)/0.12)] bg-[linear-gradient(180deg,hsl(var(--brand-teal)/0.06),hsl(var(--background)))] shadow-sm backdrop-blur">
      <div className="max-w-[1400px] mx-auto px-3 py-2 sm:px-4">
        <div className="flex min-h-12 items-center justify-between gap-2 sm:gap-3">
          <Link
            href="/"
            className="group inline-flex min-w-0 items-center gap-3 rounded-lg border border-[hsl(var(--brand-teal)/0.18)] bg-background/92 px-2 py-2 shadow-sm transition-colors hover:border-[hsl(var(--brand-teal)/0.35)] hover:bg-background sm:px-3"
            data-testid="link-brand-home"
          >
            <span className="flex h-9 w-[132px] max-w-[42vw] items-center sm:w-[180px] sm:max-w-[52vw]">
              <img
                src="/brand/vacation-rental-expertz-horizontal-transparent.png"
                alt="VacationRentalExpertz"
                className="h-8 w-auto max-w-full object-contain select-none"
                draggable={false}
              />
            </span>
          </Link>

          <nav className="flex shrink-0 items-center gap-1 sm:gap-2" aria-label="Primary navigation">
            <Link
              href="/"
              className={`inline-flex h-10 items-center gap-2 rounded-lg border px-2 text-sm font-medium transition-colors sm:px-3
                ${isHome
                  ? "border-[hsl(var(--brand-blue)/0.25)] bg-[hsl(var(--brand-blue)/0.07)] text-foreground cursor-default pointer-events-none"
                  : "border-transparent text-muted-foreground hover:border-[hsl(var(--brand-blue)/0.18)] hover:bg-background"
                }`}
              data-testid="link-home"
            >
              <Home className="h-4 w-4 text-[hsl(var(--brand-blue))]" />
              <span className="hidden sm:inline">Home</span>
            </Link>
            <Link
              href="/inbox"
              className={`inline-flex h-10 items-center gap-2 rounded-lg border px-2 text-sm font-medium transition-colors sm:px-3
                ${isInbox
                  ? "border-[hsl(var(--brand-teal)/0.30)] bg-[hsl(var(--brand-teal)/0.08)] text-foreground cursor-default pointer-events-none"
                  : "border-transparent text-muted-foreground hover:border-[hsl(var(--brand-teal)/0.22)] hover:bg-background"
                }`}
              data-testid="link-header-inbox"
            >
              <span className="relative inline-flex h-5 w-5 items-center justify-center">
                <MessageSquare className="h-4 w-4 text-primary" />
                {inboxAlertCount > 0 && (
                  <span
                    className="absolute right-0 top-0 flex h-3 min-w-3 translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full border border-background bg-red-500 px-[2px] text-[8px] font-bold leading-none text-white shadow-sm"
                    aria-label={`${inboxAlertCount} inbox alert${inboxAlertCount === 1 ? "" : "s"}`}
                    data-testid="badge-header-inbox-unread"
                  >
                    {unreadBadgeLabel}
                  </span>
                )}
              </span>
              <span className="hidden md:inline">Inbox</span>
              {missedCallCount > 0 && <PhoneMissed className="hidden h-3.5 w-3.5 text-red-600 sm:block" />}
            </Link>
            {!isAgent && (
              <Link
                href="/bookings"
                className={`inline-flex h-10 items-center gap-2 rounded-lg border px-2 text-sm font-medium transition-colors sm:px-3
                  ${isOperations
                    ? "border-[hsl(var(--brand-orange)/0.40)] bg-[hsl(var(--brand-orange)/0.10)] text-foreground cursor-default pointer-events-none"
                    : "border-transparent text-muted-foreground hover:border-[hsl(var(--brand-orange)/0.25)] hover:bg-background"
                  }`}
                data-testid="link-header-operations"
              >
                <CalendarSearch className="h-4 w-4 text-[hsl(var(--brand-orange))]" />
                <span className="hidden md:inline">Operations</span>
              </Link>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
}
