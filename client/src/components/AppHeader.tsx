import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CalendarSearch, Home, ListTodo, LogIn, LogOut, MessageSquare, PhoneMissed, UserRound } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { usePortalSession } from "@/lib/auth";
import { useInboxUnreadCount } from "@/lib/inboxUnreadStore";
import HawaiiClock from "@/components/HawaiiClock";
import PhilippinesClock from "@/components/PhilippinesClock";
import {
  countUnreadConversations,
  extractConversationList,
  parseStoredInboxReadOverrides,
  INBOX_READ_OVERRIDE_STORAGE_KEY,
} from "@shared/inbox-unread-count";
import { AGENT_DISPLAY_NAME } from "@shared/agent-identity";

export default function AppHeader() {
  const [location] = useLocation();
  const { data: session } = usePortalSession();
  const isAgent = session?.role === "agent";
  // The agent login is operated by Christal — show her name, not "agent".
  const userDisplayName = isAgent ? AGENT_DISPLAY_NAME : session?.username;
  const isHome = location === "/";
  const isInbox = location.startsWith("/inbox");
  const isOperations = location.startsWith("/bookings");
  const isListingQueue = location.startsWith("/listing-queue");
  // The SAME Guesty conversations list the inbox page fetches — identical
  // queryKey so TanStack shares one cache entry between the two components,
  // and the identical load-bearing `&fields=` (without it Guesty strips
  // `state` down to {read,status} and every conversation looks read — see
  // the inbox query's NOTE FOR CODEX). This is what lets the header badge
  // show the REAL unread count even before the inbox page is first opened.
  const { data: convData } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/communication/conversations"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/guesty-proxy/communication/conversations?limit=100&sort=-lastMessageAt&fields=");
      if (!r.ok) throw new Error(`Guesty returned HTTP ${r.status}`);
      return r.json();
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
  // Unread guest conversations. Two sources, most-authoritative first:
  //   1. The count PUBLISHED by the inbox page (it additionally folds the
  //      session-only "reply just sent" suppression) — updates the instant the
  //      operator marks a row read/unread. `null` until the inbox has mounted.
  //   2. Our own derivation from the shared conversations query + the
  //      PERSISTED right-click read/unread overrides (localStorage) — the
  //      same rules the inbox uses, so the badge matches the actual unread
  //      messages even before the inbox page is first opened. (Previously
  //      this fell back to the pending-AI-draft count and also summed missed
  //      calls into the number, so the badge routinely disagreed with the
  //      inbox — missed calls now only drive the separate phone icon.)
  const publishedUnread = useInboxUnreadCount();
  const derivedUnread = useMemo(() => {
    const conversations = extractConversationList(convData);
    if (conversations.length === 0) return 0;
    let storedOverrides: string | null = null;
    try {
      storedOverrides = window.localStorage.getItem(INBOX_READ_OVERRIDE_STORAGE_KEY);
    } catch {
      // localStorage unavailable — count without manual overrides.
    }
    return countUnreadConversations(conversations, parseStoredInboxReadOverrides(storedOverrides));
  }, [convData]);
  const unreadMessageCount = publishedUnread ?? derivedUnread;
  const unreadBadgeLabel = unreadMessageCount > 99 ? "99+" : String(unreadMessageCount);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[hsl(var(--brand-blue)/0.12)] bg-[linear-gradient(180deg,hsl(var(--brand-teal)/0.06),hsl(var(--background)))] shadow-sm backdrop-blur">
      <div className="max-w-[1400px] mx-auto px-3 py-2 sm:px-4">
        <div className="flex min-h-12 items-center justify-between gap-2 sm:gap-3">
          <div className="flex min-w-0 shrink items-center gap-2 sm:gap-3">
            <Link
              href="/"
              className="group inline-flex min-w-0 shrink-0 items-center gap-3 rounded-lg border border-[hsl(var(--brand-teal)/0.18)] bg-background/92 px-2 py-2 shadow-sm transition-colors hover:border-[hsl(var(--brand-teal)/0.35)] hover:bg-background sm:px-3"
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
            {/* Hawaii (HST) + Philippines (PHT) clocks — pinned right of the
                logo so the operator always sees the guests' local time and the
                Philippines team's local time (>= sm; phones get the strips
                under the row instead). */}
            <HawaiiClock variant="pill" />
            <PhilippinesClock variant="pill" />
          </div>

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
            {!isAgent && (
              <Link
                href="/listing-queue"
                className={`inline-flex h-10 items-center gap-2 rounded-lg border px-2 text-sm font-medium transition-colors sm:px-3
                  ${isListingQueue
                    ? "border-[hsl(var(--brand-blue)/0.25)] bg-[hsl(var(--brand-blue)/0.07)] text-foreground cursor-default pointer-events-none"
                    : "border-transparent text-muted-foreground hover:border-[hsl(var(--brand-blue)/0.18)] hover:bg-background"
                  }`}
                data-testid="link-header-listing-queue"
              >
                <ListTodo className="h-4 w-4 text-[hsl(var(--brand-blue))]" />
                <span className="hidden lg:inline">Listing Queue</span>
              </Link>
            )}
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
                {unreadMessageCount > 0 && (
                  <span
                    className="absolute right-0 top-0 flex h-3 min-w-3 translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full border border-background bg-red-500 px-[2px] text-[8px] font-bold leading-none text-white shadow-sm"
                    aria-label={`${unreadMessageCount} unread message${unreadMessageCount === 1 ? "" : "s"}`}
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
            <span className="mx-0.5 hidden h-6 w-px bg-[hsl(var(--brand-blue)/0.14)] sm:block" aria-hidden="true" />
            {session?.authenticated ? (
              <div className="flex items-center gap-1">
                <span
                  className="hidden h-10 items-center gap-2 rounded-lg border border-[hsl(var(--brand-blue)/0.14)] bg-background/80 px-3 text-sm font-medium text-muted-foreground md:inline-flex"
                  title={`Signed in as ${userDisplayName}`}
                  data-testid="header-current-user"
                >
                  <UserRound className="h-4 w-4 text-[hsl(var(--brand-blue))]" />
                  <span className="max-w-24 truncate capitalize">{userDisplayName}</span>
                </span>
                <form method="POST" action="/logout">
                  <button
                    type="submit"
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-transparent px-2 text-sm font-medium text-muted-foreground transition-colors hover:border-[hsl(var(--brand-blue)/0.18)] hover:bg-background hover:text-foreground sm:px-3"
                    aria-label="Log out"
                    title="Log out"
                    data-testid="button-header-logout"
                  >
                    <LogOut className="h-4 w-4 text-[hsl(var(--brand-blue))]" />
                    <span className="hidden lg:inline">Log out</span>
                  </button>
                </form>
              </div>
            ) : (
              <a
                href={`/login?next=${encodeURIComponent(location || "/")}`}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-transparent px-2 text-sm font-medium text-muted-foreground transition-colors hover:border-[hsl(var(--brand-blue)/0.18)] hover:bg-background hover:text-foreground sm:px-3"
                data-testid="link-header-login"
              >
                <LogIn className="h-4 w-4 text-[hsl(var(--brand-blue))]" />
                <span className="hidden lg:inline">Log in</span>
              </a>
            )}
          </nav>
        </div>
        {/* Phone-width fallback for the Hawaii + Philippines clocks (the main
            row has no spare width below `sm`). */}
        <HawaiiClock variant="strip" />
        <PhilippinesClock variant="strip" />
      </div>
    </header>
  );
}
