import { useEffect, useState } from "react";
import { hawaiiClockParts } from "@shared/hawaii-time";

// Live Hawaii (HST) clock pinned in the app header so the operator always
// knows the guests' local time. Two render variants because the header row
// has no spare width on phones:
//   - "pill":  two-line card next to the logo (>= sm screens)
//   - "strip": one-line ribbon under the header row (< sm screens)
// HST is fixed UTC-10 (no DST), formatting lives in shared/hawaii-time.ts.
export default function HawaiiClock({ variant }: { variant: "pill" | "strip" }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // 1s tick keeps the minute flip prompt (incl. after a backgrounded tab
    // resumes); the component is a leaf so the re-render cost is negligible.
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const parts = hawaiiClockParts(now);
  const tooltip = `Hawaii local time — ${parts.fullDate} · ${parts.time} HST (UTC-10)`;

  if (variant === "strip") {
    return (
      <div
        className="mt-1.5 flex items-center justify-center gap-1.5 rounded-md border border-[hsl(var(--brand-teal)/0.14)] bg-background/80 px-2 py-0.5 text-[11px] leading-tight text-muted-foreground sm:hidden"
        title={tooltip}
        aria-label={tooltip}
        data-testid="header-hawaii-clock-mobile"
      >
        <span aria-hidden="true">🌺</span>
        <span className="truncate">
          Hawaii · {parts.weekdayShort}, {parts.date} ·{" "}
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
      data-testid="header-hawaii-clock"
    >
      <span className="text-base leading-none" aria-hidden="true">🌺</span>
      <span className="flex min-w-0 flex-col">
        <span className="flex items-baseline gap-1 text-sm font-semibold leading-tight text-foreground">
          <span className="tabular-nums whitespace-nowrap">{parts.time}</span>
          <span className="text-[9px] font-bold uppercase tracking-wide text-[hsl(var(--brand-teal))]">
            {parts.tzLabel}
          </span>
        </span>
        <span className="truncate text-[10px] leading-tight text-muted-foreground">
          {parts.weekdayShort}, {parts.date} · Hawaii
        </span>
      </span>
    </div>
  );
}
