import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export type RateChange = {
  bedrooms?: number;
  oldRate: number | string | null;
  newRate: number | string | null;
};

export type RateChangeDirection = "up" | "down" | "flat" | "new" | "unknown";

export function parseRateValue(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatRateValue(value: number | null): string {
  return value != null ? `$${Math.round(value).toLocaleString()}` : "—";
}

export function rateChangeDirection(oldRate: number | string | null, newRate: number | string | null): RateChangeDirection {
  const oldN = parseRateValue(oldRate);
  const newN = parseRateValue(newRate);
  if (newN == null) return "unknown";
  if (oldN == null) return "new";
  if (newN > oldN) return "up";
  if (newN < oldN) return "down";
  return "flat";
}

export function rateChangePercent(oldRate: number | string | null, newRate: number | string | null): number | null {
  const oldN = parseRateValue(oldRate);
  const newN = parseRateValue(newRate);
  if (oldN == null || newN == null || oldN <= 0) return null;
  return (newN - oldN) / oldN;
}

type RateChangeDisplayProps = RateChange & {
  showPercent?: boolean;
  showBedrooms?: boolean;
  className?: string;
};

export function RateChangeDisplay({
  bedrooms,
  oldRate,
  newRate,
  showPercent = true,
  showBedrooms = true,
  className,
}: RateChangeDisplayProps) {
  const oldN = parseRateValue(oldRate);
  const newN = parseRateValue(newRate);
  const direction = rateChangeDirection(oldRate, newRate);
  const pct = rateChangePercent(oldRate, newRate);
  const changed = direction === "up" || direction === "down";

  const toneClass =
    direction === "up" ? "text-green-700"
    : direction === "down" ? "text-red-700"
    : "text-muted-foreground";

  return (
    <span
      className={cn("inline-flex items-center gap-1 tabular-nums", toneClass, className)}
      data-testid="rate-change-display"
      data-direction={direction}
    >
      {showBedrooms && bedrooms != null && (
        <span className="font-semibold text-foreground">{bedrooms}BR</span>
      )}
      {oldN != null && changed && (
        <span className="line-through text-muted-foreground">{formatRateValue(oldN)}</span>
      )}
      {direction === "up" && (
        <ArrowUp className="h-3.5 w-3.5 shrink-0 text-green-600" aria-hidden />
      )}
      {direction === "down" && (
        <ArrowDown className="h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden />
      )}
      {direction === "flat" && oldN != null && newN != null && (
        <Minus className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className={cn("font-semibold", changed && toneClass)}>
        {formatRateValue(newN)}
      </span>
      {showPercent && pct != null && Math.abs(pct) > 0.0001 && (
        <span className={cn("text-[10px] font-medium", toneClass)}>
          ({pct > 0 ? "+" : ""}{(pct * 100).toFixed(1)}%)
        </span>
      )}
      {direction === "new" && (
        <span className="text-[10px] font-medium text-muted-foreground">(new)</span>
      )}
    </span>
  );
}

export function RateChangesList({
  changes,
  showPercent = true,
  className,
  itemClassName,
}: {
  changes: RateChange[];
  showPercent?: boolean;
  className?: string;
  itemClassName?: string;
}) {
  if (changes.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-x-4 gap-y-1", className)} data-testid="rate-changes-list">
      {changes.map((change, index) => (
        <RateChangeDisplay
          key={`${change.bedrooms ?? "rate"}-${index}`}
          {...change}
          showPercent={showPercent}
          className={itemClassName}
        />
      ))}
    </div>
  );
}
