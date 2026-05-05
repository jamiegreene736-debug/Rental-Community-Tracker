import { Link, useLocation } from "wouter";
import { CalendarSearch, Home, MessageSquare } from "lucide-react";

export default function AppHeader() {
  const [location] = useLocation();
  const isHome = location === "/";
  const isInbox = location.startsWith("/inbox");
  const isOperations = location.startsWith("/bookings");

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[hsl(var(--brand-blue)/0.12)] bg-[linear-gradient(180deg,hsl(var(--brand-teal)/0.06),hsl(var(--background)))] shadow-sm backdrop-blur">
      <div className="max-w-[1400px] mx-auto px-4 py-2">
        <div className="flex min-h-12 items-center justify-between gap-3">
          <Link
            href="/"
            className="group inline-flex min-w-0 items-center gap-3 rounded-lg border border-[hsl(var(--brand-teal)/0.18)] bg-background/92 px-3 py-2 shadow-sm transition-colors hover:border-[hsl(var(--brand-teal)/0.35)] hover:bg-background"
            data-testid="link-brand-home"
          >
            <span className="flex h-9 w-[180px] max-w-[52vw] items-center">
              <img
                src="/brand/vacation-rental-expertz-horizontal-transparent.png"
                alt="VacationRentalExpertz"
                className="h-8 w-auto max-w-full object-contain select-none"
                draggable={false}
              />
            </span>
          </Link>

          <nav className="flex shrink-0 items-center gap-2" aria-label="Primary navigation">
            <Link
              href="/"
              className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors
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
              className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors
                ${isInbox
                  ? "border-[hsl(var(--brand-teal)/0.30)] bg-[hsl(var(--brand-teal)/0.08)] text-foreground cursor-default pointer-events-none"
                  : "border-transparent text-muted-foreground hover:border-[hsl(var(--brand-teal)/0.22)] hover:bg-background"
                }`}
              data-testid="link-header-inbox"
            >
              <MessageSquare className="h-4 w-4 text-primary" />
              <span className="hidden md:inline">Inbox</span>
            </Link>
            <Link
              href="/bookings"
              className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors
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
