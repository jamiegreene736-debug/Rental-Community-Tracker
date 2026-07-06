/** Step budgets aligned with server BULK_COMBO_LISTING_STEP_TIMEOUTS_MS in routes.ts */
export const BULK_COMBO_STEP_BUDGET_MS: Record<string, number> = {
  photos: 12 * 60_000,
  copy: 90_000,
  save: 60_000,
  persist: 90_000,
  // Typical durations for the two post-persist verification gates (server
  // timeouts are 6/10 min, but a normal run is far shorter).
  "photo-community": 3 * 60_000,
  "ota-scan": 5 * 60_000,
};

export const BULK_COMBO_TYPICAL_ITEM_MS = Object.values(BULK_COMBO_STEP_BUDGET_MS).reduce((sum, ms) => sum + ms, 0);

const PHASE_ORDER = ["photos", "copy", "save", "persist", "photo-community", "ota-scan", "done"] as const;

export type BulkComboProgressItem = {
  status: string;
  phase?: string | null;
  message?: string | null;
  startedAt?: string | null;
  unit1Photos?: Array<{ url?: string }>;
  unit2Photos?: Array<{ url?: string }>;
  progressPercent?: number;
};

function phaseFloorPercent(phase: string): number {
  switch (phase) {
    case "queued":
      return 2;
    case "retrying":
      return 8;
    case "photos":
      return 10;
    case "copy":
      return 58;
    case "save":
      return 72;
    case "persist":
      return 86;
    case "photo-community":
      return 90;
    case "ota-scan":
      return 94;
    case "done":
      return 98;
    case "failed":
    case "cancelled":
      return 0;
    default:
      return 5;
  }
}

function photosSubProgress(item: BulkComboProgressItem): number {
  const u2 = item.unit2Photos?.length ?? 0;
  const u1 = item.unit1Photos?.length ?? 0;
  const msg = String(item.message ?? "").toLowerCase();
  if (u2 > 0) return 52;
  if (/unit b/.test(msg)) return 38;
  if (u1 > 0) return 28;
  if (/unit a/.test(msg)) return 18;
  if (/ota preflight|listed on/.test(msg)) return 22;
  return 12;
}

export function bulkComboProgressPercent(item: BulkComboProgressItem): number {
  if (item.status === "completed") return 100;
  if (item.status === "failed" || item.status === "cancelled") {
    const floor = phaseFloorPercent(item.phase || "");
    return floor > 0 ? floor : 5;
  }
  if (item.status === "queued") return 2;

  const phase = String(item.phase || "photos");
  let percent = phaseFloorPercent(phase);
  if (phase === "photos") percent = Math.max(percent, photosSubProgress(item));
  return Math.min(99, Math.max(5, percent));
}

function remainingBudgetMsForPhase(phase: string): number {
  const idx = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number]);
  if (idx < 0) return BULK_COMBO_TYPICAL_ITEM_MS;
  return PHASE_ORDER.slice(idx).reduce((sum, key) => {
    if (key === "done") return sum;
    return sum + (BULK_COMBO_STEP_BUDGET_MS[key] ?? 0);
  }, 0);
}

export function bulkComboRemainingMs(
  item: BulkComboProgressItem,
  options?: { queueAhead?: number; now?: number },
): number | null {
  const now = options?.now ?? Date.now();
  const queueAhead = Math.max(0, options?.queueAhead ?? 0);

  if (item.status === "completed") return 0;
  if (item.status === "failed" || item.status === "cancelled") return null;

  if (item.status === "queued") {
    return queueAhead * BULK_COMBO_TYPICAL_ITEM_MS + BULK_COMBO_TYPICAL_ITEM_MS;
  }

  const phase = String(item.phase || "photos");
  let remaining = remainingBudgetMsForPhase(phase);
  if (phase === "photos") {
    const sub = photosSubProgress(item);
    const photosBudget = BULK_COMBO_STEP_BUDGET_MS.photos;
    remaining = Math.max(30_000, Math.round(photosBudget * (1 - (sub - 10) / 45)));
    remaining += BULK_COMBO_STEP_BUDGET_MS.copy + BULK_COMBO_STEP_BUDGET_MS.save + BULK_COMBO_STEP_BUDGET_MS.persist;
  }

  const startedMs = item.startedAt ? Date.parse(item.startedAt) : NaN;
  if (Number.isFinite(startedMs)) {
    const elapsed = Math.max(0, now - startedMs);
    const progress = bulkComboProgressPercent(item);
    if (progress >= 10) {
      const paceBased = Math.round((elapsed / progress) * (100 - progress));
      remaining = Math.min(remaining, Math.max(15_000, paceBased));
    }
  }

  return queueAhead * BULK_COMBO_TYPICAL_ITEM_MS + remaining;
}

export function formatBulkComboEta(remainingMs: number | null): string {
  if (remainingMs == null) return "";
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds <= 5) return "finishing…";
  if (seconds < 60) return `~${seconds}s left`;
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60);
    return `~${minutes} min left`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return minutes > 0 ? `~${hours}h ${minutes}m left` : `~${hours}h left`;
}
