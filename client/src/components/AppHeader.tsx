import { Link, useLocation } from "wouter";
import { Home } from "lucide-react";

export default function AppHeader() {
  const [location] = useLocation();
  const isHome = location === "/";

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-[1400px] mx-auto px-4 h-11 flex items-center gap-3">
        <Link
          href="/"
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors
            ${isHome
              ? "bg-muted text-foreground cursor-default pointer-events-none"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          data-testid="link-home"
        >
          <Home className="h-3.5 w-3.5" />
          Home
        </Link>
        <span className="text-muted-foreground/40 text-xs select-none">|</span>
        <span className="text-sm font-semibold tracking-tight text-foreground/80 select-none">NexStay</span>
      </div>
    </header>
  );
}
