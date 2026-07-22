// Operator dismissals for the dashboard's refund-receipt attention rows
// (operator ask 2026-07-22: "dismiss these messages individually and they
// won't show up again in the future").
//
// Persisted SERVER-SIDE in app_settings (not localStorage) so a dismissal
// holds across the operator's Mac + phone. Keyed by the receipt's TOKEN — the
// stable per-receipt id — so dismissing one alert can never hide a FUTURE
// failed refund receipt (a new failure is a new ledger row with a new token).
//
// Pure helpers (no I/O) so tests need no DATABASE_URL.

export const RECEIPT_ATTENTION_DISMISSALS_KEY = "receipt_attention_dismissals.v1";
/** Newest dismissals kept — comfortably above the alert scan's 300-row read. */
export const RECEIPT_ATTENTION_DISMISSALS_CAP = 400;

export interface ReceiptAttentionDismissalStore {
  version: 1;
  dismissed: Array<{ token: string; dismissedAt: string }>;
}

export function parseReceiptAttentionDismissals(raw: string | null | undefined): ReceiptAttentionDismissalStore {
  if (!raw) return { version: 1, dismissed: [] };
  try {
    const parsed = JSON.parse(raw) as ReceiptAttentionDismissalStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.dismissed)) return { version: 1, dismissed: [] };
    return {
      version: 1,
      dismissed: parsed.dismissed.filter(
        (d) => d && typeof d.token === "string" && d.token && typeof d.dismissedAt === "string",
      ),
    };
  } catch {
    return { version: 1, dismissed: [] };
  }
}

export function serializeReceiptAttentionDismissals(store: ReceiptAttentionDismissalStore): string {
  return JSON.stringify({
    version: 1,
    dismissed: store.dismissed.slice(-RECEIPT_ATTENTION_DISMISSALS_CAP),
  });
}

/** Idempotent add — re-dismissing an already-dismissed token is a no-op. */
export function addReceiptAttentionDismissal(
  store: ReceiptAttentionDismissalStore,
  token: string,
  nowIso: string,
): ReceiptAttentionDismissalStore {
  const trimmed = String(token ?? "").trim();
  if (!trimmed || store.dismissed.some((d) => d.token === trimmed)) return store;
  return { version: 1, dismissed: [...store.dismissed, { token: trimmed, dismissedAt: nowIso }] };
}

export function dismissedReceiptTokenSet(store: ReceiptAttentionDismissalStore): Set<string> {
  return new Set(store.dismissed.map((d) => d.token));
}
