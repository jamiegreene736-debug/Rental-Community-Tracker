// Server side of the per-tab "last pushed to Guesty" ledger (2026-07-12).
// Persists in app_settings under `guesty_push_history.v1` via the same
// serialized promise-tail pattern as auto-replace-jobs / unit-audit-sweep
// stores. Everything here is fail-soft: the ledger is display-only, so a
// storage hiccup must never break (or slow down the response of) a push —
// recordGuestyPush is fire-and-forget.
import { storage } from "./storage";
import {
  applyGuestyPushBackfill,
  applyGuestyPushRecord,
  parseGuestyPushHistoryStore,
  serializeGuestyPushHistoryStore,
  normalizeGuestyPushOperationId,
  type GuestyPushHistoryStore,
  type GuestyPushListingHistory,
  type GuestyPushStatus,
  type GuestyPushTab,
} from "@shared/guesty-push-history";

const GUESTY_PUSH_HISTORY_SETTING_KEY = "guesty_push_history.v1";

let storeTail: Promise<void> = Promise.resolve();
function mutateStore(mutate: (store: GuestyPushHistoryStore, nowIso: string) => void): Promise<void> {
  storeTail = storeTail.then(async () => {
    try {
      const nowIso = new Date().toISOString();
      const raw = await storage.getSetting(GUESTY_PUSH_HISTORY_SETTING_KEY);
      const store = parseGuestyPushHistoryStore(raw ?? null);
      mutate(store, nowIso);
      await storage.setSetting(GUESTY_PUSH_HISTORY_SETTING_KEY, serializeGuestyPushHistoryStore(store));
    } catch {
      // Fail-soft: the ledger is an upgrade, never a blocker.
    }
  });
  return storeTail;
}

// Fire-and-forget: called inline from push endpoints, must never throw or
// delay the push response.
export function recordGuestyPush(
  listingId: string,
  tab: GuestyPushTab,
  status: GuestyPushStatus,
  summary: string,
  operationId?: string,
): void {
  const id = String(listingId ?? "").trim();
  if (!id) return;
  const cleanOperationId = normalizeGuestyPushOperationId(operationId);
  void mutateStore((store, nowIso) => {
    applyGuestyPushRecord(store, id, tab, {
      pushedAt: nowIso,
      status,
      summary,
      ...(cleanOperationId ? { operationId: cleanOperationId } : {}),
    }, nowIso);
  });
}

export async function getGuestyPushHistory(listingId: string): Promise<GuestyPushListingHistory> {
  try {
    await storeTail; // let in-flight writes land so a just-finished push shows
    const raw = await storage.getSetting(GUESTY_PUSH_HISTORY_SETTING_KEY);
    const store = parseGuestyPushHistoryStore(raw ?? null);
    return store.listings[String(listingId ?? "").trim()]?.tabs ?? {};
  } catch {
    return {};
  }
}

export async function backfillGuestyPushHistory(
  listingId: string,
  entries: unknown,
): Promise<{ applied: number; rejected: number }> {
  const id = String(listingId ?? "").trim();
  if (!id) return { applied: 0, rejected: 0 };
  let result = { applied: 0, rejected: 0 };
  await mutateStore((store, nowIso) => {
    result = applyGuestyPushBackfill(store, id, entries, nowIso);
  });
  return result;
}
