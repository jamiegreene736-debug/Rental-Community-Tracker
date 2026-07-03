// Guesty push confirmation for the dashboard bulk market-pricing queue.
//
// A queue item can finish "completed" without its rates ever reaching Guesty
// (push skipped: no mapped listing / no priced months), and a "failed" item
// definitely didn't push. The operator asked for an explicit, glanceable
// confirmation that EVERY property in a mass update actually landed on Guesty
// — so this module classifies each item's push outcome from the progress
// payload the queue already persists (`progress.guestyPush`, written by
// runBulkPricingItem after pushBulkGuestyPricingAfterRefresh). Pure and
// dependency-free so the server (terminal queue event) and the client
// (per-item chips + terminal banner) share one source of truth.

export type GuestyPushOutcome =
  | "pushed" // seasonal base rates + lead-time windows landed on Guesty
  | "skipped" // item completed but nothing was pushed (unmapped / no priced months)
  | "failed" // item failed — push not confirmed
  | "cancelled"
  | "pending" // still queued/running
  | "unknown"; // terminal but no push info recorded (e.g. dry-run)

export type GuestyPushProgress = {
  skipped?: boolean;
  reason?: string;
  listingId?: string;
  targetMargin?: number;
  seasonal?: {
    pushedDays?: number;
    pushedRanges?: number;
    totalRanges?: number;
    verifiedDays?: number;
  } | null;
  leadTime?: { pushed?: number; total?: number } | null;
} | null;

export type BulkPricingPushItemLike = {
  propertyId: number;
  label: string;
  status: string;
  progress?: { guestyPush?: GuestyPushProgress } | Record<string, unknown> | null;
  error?: string | null;
};

export type ItemPushStatus = {
  propertyId: number;
  label: string;
  outcome: GuestyPushOutcome;
  /** Human-readable one-liner: what pushed (and verified) or why it didn't. */
  detail: string;
};

export type BulkPricingPushSummary = {
  total: number;
  pushed: number;
  skipped: number;
  failed: number;
  cancelled: number;
  pending: number;
  unknown: number;
  /** True when every item in the queue confirmed a Guesty push. */
  allPushed: boolean;
  /** Terminal items whose rates did NOT confirm on Guesty (skipped/failed/unknown). */
  attention: ItemPushStatus[];
  items: ItemPushStatus[];
};

const asFiniteCount = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function guestyPushStatusForItem(item: BulkPricingPushItemLike): ItemPushStatus {
  const base = { propertyId: item.propertyId, label: item.label };
  const status = String(item.status ?? "");
  if (status === "queued" || status === "running") {
    return { ...base, outcome: "pending", detail: "Still refreshing — Guesty push not attempted yet" };
  }
  if (status === "cancelled") {
    return { ...base, outcome: "cancelled", detail: "Cancelled before the Guesty push completed" };
  }
  const guestyPush = (item.progress as { guestyPush?: GuestyPushProgress } | null | undefined)?.guestyPush ?? null;
  if (status === "failed") {
    return {
      ...base,
      outcome: "failed",
      detail: item.error ? `Failed: ${item.error}` : "Failed before the Guesty push was confirmed",
    };
  }
  if (!guestyPush) {
    return { ...base, outcome: "unknown", detail: "No Guesty push confirmation was recorded for this item" };
  }
  if (guestyPush.skipped) {
    return {
      ...base,
      outcome: "skipped",
      detail: `Rates saved but NOT pushed to Guesty: ${guestyPush.reason || "push skipped"}`,
    };
  }
  const pushedDays = asFiniteCount(guestyPush.seasonal?.pushedDays);
  const verifiedDays = asFiniteCount(guestyPush.seasonal?.verifiedDays);
  const leadPushed = asFiniteCount(guestyPush.leadTime?.pushed);
  const leadTotal = asFiniteCount(guestyPush.leadTime?.total);
  const parts: string[] = [];
  if (pushedDays != null) parts.push(`${pushedDays} day${pushedDays === 1 ? "" : "s"} pushed`);
  parts.push(
    verifiedDays != null
      ? `${verifiedDays} verified by Guesty read-back`
      : "read-back deferred (Guesty rate limit)",
  );
  if (leadTotal != null && leadTotal > 0) parts.push(`lead-time ${leadPushed ?? 0}/${leadTotal}`);
  return { ...base, outcome: "pushed", detail: `Pushed to Guesty: ${parts.join(" · ")}` };
}

export function summarizeBulkPricingGuestyPush(items: BulkPricingPushItemLike[]): BulkPricingPushSummary {
  const statuses = items.map(guestyPushStatusForItem);
  const count = (outcome: GuestyPushOutcome) => statuses.filter((s) => s.outcome === outcome).length;
  const pushed = count("pushed");
  const attention = statuses.filter((s) => s.outcome === "skipped" || s.outcome === "failed" || s.outcome === "unknown");
  return {
    total: statuses.length,
    pushed,
    skipped: count("skipped"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    pending: count("pending"),
    unknown: count("unknown"),
    allPushed: statuses.length > 0 && pushed === statuses.length,
    attention,
    items: statuses,
  };
}
