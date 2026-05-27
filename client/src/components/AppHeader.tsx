import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CalendarSearch, Home, MessageSquare } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

type GuestyConversationSummary = {
  unread?: boolean;
  unreadCount?: number;
  state?: unknown;
  lastPost?: unknown;
  lastMessage?: unknown;
  lastMessageFrom?: unknown;
  isLastPostFromGuest?: unknown;
  meta?: {
    unreadCount?: number;
    lastMessage?: unknown;
    lastPost?: unknown;
  };
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unwrapConversationList(raw: unknown): GuestyConversationSummary[] {
  const seen = new Set<unknown>();
  const hints = ["conversations", "results", "data"];

  const visit = (node: unknown, depth: number): GuestyConversationSummary[] | null => {
    if (Array.isArray(node)) return node as GuestyConversationSummary[];
    if (!node || typeof node !== "object" || depth > 3 || seen.has(node)) return null;
    seen.add(node);

    const obj = node as Record<string, unknown>;
    for (const hint of hints) {
      if (Array.isArray(obj[hint])) return obj[hint] as GuestyConversationSummary[];
    }
    for (const value of Object.values(obj)) {
      const found = visit(value, depth + 1);
      if (found) return found;
    }
    return null;
  };

  return visit(raw, 0) ?? [];
}

function latestMessageIsFromGuest(conversation: GuestyConversationSummary): boolean | null {
  const state = objectValue(conversation.state);
  const meta = objectValue(conversation.meta);
  const lastMessage = objectValue(
    conversation.lastMessage ??
    conversation.lastPost ??
    meta.lastMessage ??
    meta.lastPost ??
    state.lastMessage,
  );

  const explicit =
    conversation.isLastPostFromGuest ??
    state.isLastPostFromGuest ??
    state.lastMessageFromGuest;
  if (typeof explicit === "boolean") return explicit;

  const rawAuthor =
    conversation.lastMessageFrom ??
    lastMessage.authorType ??
    lastMessage.authorRole ??
    lastMessage.senderType ??
    lastMessage.from;
  if (typeof rawAuthor !== "string") return null;

  const author = rawAuthor.toLowerCase();
  if (/\b(guest|nonuser|non-user|traveler)\b/.test(author)) return true;
  if (/\b(host|owner|user|staff|admin)\b/.test(author)) return false;
  return null;
}

function isUnreadConversationThread(conversation: GuestyConversationSummary): boolean {
  const state = objectValue(conversation.state);
  const meta = objectValue(conversation.meta);
  const unreadSignal =
    (typeof conversation.unreadCount === "number" && conversation.unreadCount > 0) ||
    conversation.unread === true ||
    (typeof meta.unreadCount === "number" && meta.unreadCount > 0) ||
    state.read === false ||
    state.readByUser === false ||
    state.readByNonUser === false ||
    state.status === "UNREAD" ||
    state.status === "NEW" ||
    conversation.state === "UNREAD" ||
    conversation.state === "NEW" ||
    conversation.state === "UNANSWERED";

  if (!unreadSignal) return false;
  return latestMessageIsFromGuest(conversation) !== false;
}

function countUnreadConversationThreads(raw: unknown): number {
  return unwrapConversationList(raw).filter(isUnreadConversationThread).length;
}

export default function AppHeader() {
  const [location] = useLocation();
  const isHome = location === "/";
  const isInbox = location.startsWith("/inbox");
  const isOperations = location.startsWith("/bookings");
  const { data: unreadThreadCount = 0 } = useQuery<number>({
    queryKey: ["/api/guesty-proxy/communication/conversations", "unread-thread-count"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/guesty-proxy/communication/conversations?limit=100&fields=");
      if (!response.ok) return 0;
      return countUnreadConversationThreads(await response.json());
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const unreadBadgeLabel = unreadThreadCount > 99 ? "99+" : String(unreadThreadCount);

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
                {unreadThreadCount > 0 && (
                  <span
                    className="absolute right-0 top-0 flex h-3 min-w-3 translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full border border-background bg-red-500 px-[2px] text-[8px] font-bold leading-none text-white shadow-sm"
                    aria-label={`${unreadThreadCount} unread conversation thread${unreadThreadCount === 1 ? "" : "s"}`}
                    data-testid="badge-header-inbox-unread"
                  >
                    {unreadBadgeLabel}
                  </span>
                )}
              </span>
              <span className="hidden md:inline">Inbox</span>
            </Link>
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
          </nav>
        </div>
      </div>
    </header>
  );
}
