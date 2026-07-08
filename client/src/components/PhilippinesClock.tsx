import { useEffect, useState } from "react";
import { philippinesClockParts } from "@shared/philippines-time";

// Live Philippines (PHT) clock pinned in the app header next to the Hawaii
// clock so the operator always knows the local time for the Philippines team.
// Two render variants because the header row has no spare width on phones:
//   - "pill":  two-line card next to the Hawaii pill (>= sm screens)
//   - "strip": one-line ribbon under the header row (< sm screens)
// PHT is fixed UTC+8 (no DST), formatting lives in shared/philippines-time.ts.
export default function PhilippinesClock({ variant }: { variant: "pill" | "strip" }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // 1s tick keeps the minute flip prompt (incl. after a backgrounded tab
    // resumes); the component is a leaf so the re-render cost is negligible.
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const parts = philippinesClockParts(now);
  const tooltip = `Philippines local time — ${parts.fullDate} · ${parts.time} PHT (UTC+8)`;

  if (variant === "strip") {
    return (
      <div
        className="mt-1.5 flex items-center justify-center gap-1.5 rounded-md border border-[hsl(var(--brand-teal)/0.14)] bg-background/80 px-2 py-0.5 text-[11px] leading-tight text-muted-foreground sm:hidden"
        title={tooltip}
        aria-label={tooltip}
        data-testid="header-philippines-clock-mobile"
      >
        <span aria-hidden="true">🇵🇭</span>
        <span className="truncate">
          Philippines · {parts.weekdayShort}, {parts.date} ·{" "}
          <span className="font-semibold tabular-nums text-foreground">{parts.time}</span>{" "}
          <span className="font-semibold text-[hsl(var(--brand-teal))]">{parts.tzLabel}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className="hidden min-w-0 shrink items-center gap-2 rounded-lg border border-[hsl(var(--brand-teal)/0.18)] bg-background/92 px-2.5 py-1 shadow-sm sm:flex"
      title={tooltip}
      aria-label={tooltip}
      data-testid="header-philippines-clock"
    >
      <span className="text-base leading-none" aria-hidden="true">🇵🇭</span>
      <span className="flex min-w-0 flex-col">
        <span className="flex items-baseline gap-1 text-sm font-semibold leading-tight text-foreground">
          <span className="tabular-nums whitespace-nowrap">{parts.time}</span>
          <span className="text-[9px] font-bold uppercase tracking-wide text-[hsl(var(--brand-teal))]">
            {parts.tzLabel}
          </span>
        </span>
        <span className="truncate text-[10px] leading-tight text-muted-foreground">
          {parts.weekdayShort}, {parts.date} · Philippines
        </span>
      </span>
    </div>
  );
}
