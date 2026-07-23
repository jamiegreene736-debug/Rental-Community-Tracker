// Dashboard "Next 12 months" revenue-projection band — the forward-looking hero
// of the redesigned KPI area. Reads the cached snapshot from
// GET /api/dashboard/revenue-projection (computed daily by
// server/revenue-projection-aggregate.ts) and renders projected revenue,
// scheduled collections, and net profit for the next 12 months, plus a
// month-by-month bar chart with the on-the-books vs estimated split.
//
// Methodology (Phase 1): each future month is anchored on ON-THE-BOOKS revenue
// (already contracted) and, for months that aren't booked up yet, filled up to
// the trailing 90-day run rate — never summed, so a strong near month keeps its
// real figure. Net profit is on-the-books only (contracted stays), estimating a
// market-rate cost for any slot not yet bought in.

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TrendingUp,
  Wallet,
  PiggyBank,
  CalendarClock,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import type {
  RevenueProjectionResponse,
  RevenueProjectionMonth,
} from "@shared/revenue-projection-types";

const usd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Math.round(value || 0));

const pct = (fraction: number) => `${Math.round((fraction || 0) * 100)}%`;

function MomentumChip({ value, label }: { value: number | null; label: string }) {
  if (value == null || !Number.isFinite(value)) return null;
  const up = value >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const tone = up
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${tone}`} title={`${label}: last 30 days vs the prior 30 days`}>
      <Icon className="h-3 w-3" />
      {up ? "+" : ""}
      {Math.round(value * 100)}% <span className="font-normal text-muted-foreground">{label}</span>
    </span>
  );
}

// Compact, dependency-free stacked bar chart: full bar = projected revenue,
// solid segment = on-the-books, lighter segment on top = run-rate fill.
function MiniBars({ months, seasonal }: { months: RevenueProjectionMonth[]; seasonal: boolean }) {
  const max = Math.max(1, ...months.map((m) => m.projectedRevenue));
  return (
    <div className="mt-3">
      <div className="flex items-end gap-1" style={{ height: 96 }}>
        {months.map((m) => {
          const projH = (m.projectedRevenue / max) * 100;
          const onBooksH = m.projectedRevenue > 0 ? (m.onBooksRevenue / m.projectedRevenue) * projH : 0;
          const fillH = Math.max(0, projH - onBooksH);
          return (
            <div
              key={m.month}
              className="flex flex-1 flex-col justify-end"
              title={`${m.label}\nProjected: ${usd(m.projectedRevenue)}\nOn the books: ${usd(m.onBooksRevenue)} (${pct(m.onBooksPct)})\nCollections: ${usd(m.collections)}\nNet profit: ${usd(m.netProfit)}`}
            >
              <div className="flex w-full flex-col justify-end overflow-hidden rounded-t-sm" style={{ height: `${projH}%`, minHeight: m.projectedRevenue > 0 ? 2 : 0 }}>
                {fillH > 0 && (
                  <div className="w-full bg-sky-200/70 dark:bg-sky-900/50" style={{ height: `${(fillH / projH) * 100}%` }} />
                )}
                <div className="w-full bg-sky-500 dark:bg-sky-500" style={{ height: `${(onBooksH / Math.max(projH, 0.0001)) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1">
        {months.map((m) => (
          <div key={m.month} className="flex-1 text-center text-[9px] leading-tight text-muted-foreground">
            {m.label.slice(0, 3)}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-sky-500" /> On the books</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-sky-200/70 dark:bg-sky-900/50" /> {seasonal ? "Seasonal estimate" : "Run-rate estimate"}</span>
      </div>
    </div>
  );
}

export function RevenueProjectionBand({
  data,
  isLoading,
}: {
  data: RevenueProjectionResponse | undefined;
  isLoading: boolean;
}) {
  const ready = data?.ready === true ? data : null;

  const marginPct = useMemo(() => {
    if (!ready) return null;
    const rev = ready.totals.onBooksRevenue12mo;
    return rev > 0 ? ready.totals.projectedNetProfit12mo / rev : null;
  }, [ready]);

  if (!ready) {
    return (
      <Card className="mb-3 p-4">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Next 12 months — projection</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {isLoading
            ? "Loading your 12-month projection…"
            : "Building your 12-month projection from on-the-books reservations — this refreshes daily. Check back shortly."}
        </p>
      </Card>
    );
  }

  const t = ready.totals;
  const profitPositive = t.projectedNetProfit12mo >= 0;

  return (
    <Card className="mb-3 p-4" data-testid="card-revenue-projection">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Next 12 months — projection</span>
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-950/60 dark:text-sky-300" title="Share of projected revenue that is already contracted (booked). The rest is an estimate for unbooked nights.">
            {pct(t.onBooksPct12mo)} on the books
          </span>
          {ready.seasonality.applied && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-950/60 dark:text-violet-300" title={`Unbooked nights are estimated seasonally from your last ${ready.seasonality.monthsOfHistory} months of stay revenue, not a flat run rate.`}>
              seasonally adjusted
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {t.reservations} on-the-books reservation{t.reservations === 1 ? "" : "s"}
            {ready.computedAt ? ` · updated ${new Date(ready.computedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
          </span>
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="button-projection-detail"
              >
                Month-by-month
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-4xl overflow-hidden p-0">
              <div className="max-h-[85vh] overflow-y-auto p-6">
                <DialogHeader>
                  <DialogTitle>12-month revenue projection · by stay month</DialogTitle>
                </DialogHeader>
                <p className="mt-1 text-xs text-muted-foreground">
                  Revenue is anchored on already-booked stays and filled where a month isn't booked up yet
                  {ready.seasonality.applied
                    ? ` — using a seasonal estimate from your last ${ready.seasonality.monthsOfHistory} months of stay revenue`
                    : " — using your trailing 90-day run rate"}
                  . Net profit counts contracted stays only, estimating a market-rate cost for slots not yet bought in.
                </p>
                <div className="mt-3 max-w-full overflow-x-auto rounded-md border">
                  <Table className="min-w-[720px] table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[110px]">Month</TableHead>
                        <TableHead className="w-[120px] text-right">On the books</TableHead>
                        <TableHead className="w-[120px] text-right">Projected</TableHead>
                        <TableHead className="w-[120px] text-right">Collections</TableHead>
                        <TableHead className="w-[110px] text-right">Net profit</TableHead>
                        <TableHead className="w-[90px] text-right">Open slots</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ready.months.map((m) => (
                        <TableRow key={m.month} data-testid={`row-projection-${m.month}`}>
                          <TableCell className="align-top font-medium">{m.label}</TableCell>
                          <TableCell className="text-right align-top">
                            {usd(m.onBooksRevenue)}
                            <span className="block text-[11px] text-muted-foreground">{pct(m.onBooksPct)} booked</span>
                          </TableCell>
                          <TableCell className="text-right align-top font-medium">{usd(m.projectedRevenue)}</TableCell>
                          <TableCell className="text-right align-top">{usd(m.collections)}</TableCell>
                          <TableCell className={`text-right align-top font-medium ${m.netProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                            {usd(m.netProfit)}
                            {m.estimatedCost > 0 && (
                              <span className="block text-[11px] font-normal text-muted-foreground">incl. {usd(m.estimatedCost)} est. cost</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right align-top">
                            {m.openSlots || "—"}
                            {m.unpricedSlots > 0 && (
                              <span className="block text-[11px] text-amber-600 dark:text-amber-400" title="Open slots with no known community — cost not estimated">{m.unpricedSlots} unpriced</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {/* Projected revenue */}
        <div className="rounded-lg border bg-muted/20 p-3" data-testid="stat-projected-revenue">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" /> Projected revenue
          </div>
          <p className="mt-1 text-2xl font-bold">{usd(t.projectedRevenue12mo)}</p>
          <p className="text-[11px] text-muted-foreground">
            {usd(t.onBooksRevenue12mo)} contracted · {pct(t.onBooksPct12mo)} on the books
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="text-[11px] text-muted-foreground" title="Trailing 90-day booking run rate, annualized — your current pace for comparison.">
              90-day run rate: {usd(ready.trailing.revenueRunRateAnnual)}/yr
            </span>
            <MomentumChip value={ready.trailing.revenueMomentumPct} label="vs prior 30d" />
            <MomentumChip value={ready.trailing.revenueYoyPct} label="YoY" />
          </div>
        </div>

        {/* Projected collections */}
        <div className="rounded-lg border bg-muted/20 p-3" data-testid="stat-projected-collections">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Wallet className="h-3.5 w-3.5" /> Projected collections
          </div>
          <p className="mt-1 text-2xl font-bold">{usd(t.projectedCollections12mo)}</p>
          <p className="text-[11px] text-muted-foreground">scheduled guest payments (cash in)</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="text-[11px] text-muted-foreground" title="Trailing 90-day collected-cash run rate, annualized.">
              90-day run rate: {usd(ready.trailing.collectedRunRateAnnual)}/yr
            </span>
            <MomentumChip value={ready.trailing.collectedMomentumPct} label="vs prior 30d" />
          </div>
        </div>

        {/* Projected net profit */}
        <div className="rounded-lg border bg-muted/20 p-3" data-testid="stat-projected-profit">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <PiggyBank className="h-3.5 w-3.5" /> Projected net profit
          </div>
          <p className={`mt-1 text-2xl font-bold ${profitPositive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {usd(t.projectedNetProfit12mo)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {marginPct != null ? `${pct(marginPct)} margin · ` : ""}after buy-ins, on the books
          </p>
          <p className="mt-1.5 text-[11px] text-muted-foreground" title="Cost of slots not yet bought in, estimated from the market-rate table.">
            incl. {usd(t.estimatedCost12mo)} est. cost
            {t.openSlots > 0 ? ` · ${t.openSlots} open slot${t.openSlots === 1 ? "" : "s"}` : ""}
            {t.unpricedSlots > 0 ? ` · ${t.unpricedSlots} unpriced` : ""}
          </p>
        </div>
      </div>

      <MiniBars months={ready.months} seasonal={ready.seasonality.applied} />
    </Card>
  );
}

export default RevenueProjectionBand;
