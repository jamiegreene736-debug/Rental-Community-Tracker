// Bulk Cowork DISPATCH MEMORY — pure, browser-safe.
//
// THE BUG THIS FIXES: the bulk Cowork buttons pick their reservations purely
// from live slot state. Cowork attaches OUT OF BAND and a batch of eight takes
// many minutes, so during that whole window the selection still looks
// unfilled — click the button again and the SAME reservations are dispatched
// to a second Cowork task racing the first for the same open slots.
//
// Why that is worse than a wasted run: `attachBuyIn` rejects a same-slot or
// same-listing collision server-side, so it will not double-book. But nothing
// server-side enforces the brief's PAIR RULE (a combo's units must share a
// complex, ideally the same building — prompt text only). Two tasks researching
// independently can each attach a unit from a DIFFERENT resort and pass every
// server guard, producing a guest split across two properties that one task
// would never have produced.
//
// DESIGN NOTE — the primary rule is the UNIT SET, not the clock. A dispatch
// covers exactly the slots that were open when it was built. If a slot opens
// that the dispatch never covered — the operator detaches a unit Cowork did not
// attach, or a new slot appears — that slot was never handed to Cowork and the
// reservation must be selectable again IMMEDIATELY. (Detaching a unit Cowork
// just attached is NOT that case: it re-opens a slot the dispatch did cover, so
// it stays suppressed until the window lapses or "Send anyway" is used.)
// Suppressing on a timer alone would hide a booking for the whole window — and a bulk queue that
// silently SKIPS a booking is worse than one that double-sends, because the
// end state is a guest with no unit. The TTL is only the outer bound for the
// case no client-side signal can ever resolve: a task the operator closed
// without sending.

export type CoworkDispatchKind = "bulk-find" | "bulk-prepare-checkout";

export interface CoworkDispatchRecord {
  reservationId: string;
  kind: CoworkDispatchKind;
  dispatchedAtMs: number;
  /** The unit slots this dispatch actually covers. Empty = cover everything. */
  unitIds: string[];
  /**
   * Suppression window for THIS record, stamped at dispatch from the
   * reservation's position in its batch. Stored per-record rather than
   * recomputed so a later change to the cap or the TTL constants cannot
   * retroactively lengthen or shorten a dispatch already in flight.
   */
  ttlMs?: number;
}

/** localStorage key. Matches the house `nexstay_*` convention. */
export const COWORK_DISPATCH_STORAGE_KEY = "nexstay_cowork_bulk_dispatches";

/** Hard cap on stored records, so the key cannot grow without bound. */
export const COWORK_DISPATCH_MAX_RECORDS = 60;

/**
 * TTL bounds, per kind, because the two runs have opposite dynamics.
 *
 * bulk-find is MACHINE-paced: Cowork works reservations serially and nobody is
 * waiting, so the bound scales with the reservation's POSITION in the batch —
 * reservation 1 finishes early, reservation 8 needs the whole window. A flat
 * per-batch number is wrong at both ends.
 *
 * bulk-prepare-checkout is HUMAN-paced by definition: every unit stops for the
 * operator's card, so a batch can legitimately span an afternoon. It gets a
 * much longer bound, and re-dispatching one of those mid-sitting is exactly how
 * a second unsubmitted payment tab appears.
 */
export const COWORK_DISPATCH_TTL = {
  "bulk-find": { baseMs: 15 * 60_000, perReservationMs: 10 * 60_000, maxMs: 120 * 60_000 },
  "bulk-prepare-checkout": { baseMs: 30 * 60_000, perReservationMs: 20 * 60_000, maxMs: 240 * 60_000 },
} as const;

/**
 * How long a dispatch suppresses, given WHERE in the batch the reservation sat.
 * `position` is 0-based; a later reservation is reached later, so it needs a
 * longer window than the first one.
 */
export function coworkDispatchTtlMs(kind: CoworkDispatchKind, position: number): number {
  const cfg = COWORK_DISPATCH_TTL[kind] ?? COWORK_DISPATCH_TTL["bulk-find"];
  const slot = Number.isFinite(position) && position > 0 ? Math.floor(position) : 0;
  return Math.min(cfg.baseMs + cfg.perReservationMs * (slot + 1), cfg.maxMs);
}

function normalizeRecord(raw: unknown): CoworkDispatchRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const reservationId = typeof r.reservationId === "string" ? r.reservationId.trim() : "";
  const kind = r.kind === "bulk-find" || r.kind === "bulk-prepare-checkout" ? r.kind : null;
  const dispatchedAtMs = Number(r.dispatchedAtMs);
  if (!reservationId || !kind || !Number.isFinite(dispatchedAtMs)) return null;
  const unitIds = Array.isArray(r.unitIds)
    ? r.unitIds.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];
  const ttlMs = Number(r.ttlMs);
  return {
    reservationId,
    kind,
    dispatchedAtMs,
    unitIds,
    ...(Number.isFinite(ttlMs) && ttlMs > 0 ? { ttlMs } : {}),
  };
}

export function parseCoworkDispatches(rawJson: string | null | undefined): CoworkDispatchRecord[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRecord).filter((r): r is CoworkDispatchRecord => r !== null);
  } catch {
    return []; // Corrupt/absent storage degrades to "no memory", never throws.
  }
}

export function serializeCoworkDispatches(records: CoworkDispatchRecord[]): string {
  return JSON.stringify(records);
}

function recordTtlMs(record: CoworkDispatchRecord): number {
  const explicit = record.ttlMs;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return explicit;
  return coworkDispatchTtlMs(record.kind, 0);
}

/**
 * Drop expired records, then trim to the cap.
 *
 * Order is load-bearing: expired first, THEN oldest-by-dispatch. A cap eviction
 * must never drop a LIVE record while an expired one survives — that would
 * re-admit a reservation whose task is still running.
 *
 * A future-dated record (clock change, DST, a synced device) is CLAMPED to now
 * rather than deleted. Deleting it would re-admit the reservation, and this
 * module's whole asymmetry is that a wrong re-admit costs more than a wrong
 * suppression.
 */
export function pruneCoworkDispatches(
  records: CoworkDispatchRecord[],
  nowMs: number,
): CoworkDispatchRecord[] {
  const clamped = records.map((r) => (
    r.dispatchedAtMs > nowMs ? { ...r, dispatchedAtMs: nowMs } : r
  ));
  const live = clamped.filter((r) => nowMs - r.dispatchedAtMs < recordTtlMs(r));
  if (live.length <= COWORK_DISPATCH_MAX_RECORDS) return live;
  return [...live]
    .sort((a, b) => b.dispatchedAtMs - a.dispatchedAtMs)
    .slice(0, COWORK_DISPATCH_MAX_RECORDS);
}

export function recordCoworkDispatches(
  existing: CoworkDispatchRecord[],
  dispatched: { reservationId: string; unitIds: string[] }[],
  kind: CoworkDispatchKind,
  nowMs: number,
  opts?: { ttlOverrideMs?: number },
): CoworkDispatchRecord[] {
  const ids = new Set(dispatched.map((d) => d.reservationId));
  // A fresh dispatch REPLACES any prior record for the same (reservation, kind):
  // the new one's unit set and clock are the current truth.
  const kept = existing.filter((r) => !(r.kind === kind && ids.has(r.reservationId)));
  const added = dispatched.map((d, index) => ({
    reservationId: d.reservationId,
    kind,
    dispatchedAtMs: nowMs,
    unitIds: [...d.unitIds],
    ttlMs: opts?.ttlOverrideMs ?? coworkDispatchTtlMs(kind, index),
  }));
  return pruneCoworkDispatches([...kept, ...added], nowMs);
}

export function clearCoworkDispatches(
  existing: CoworkDispatchRecord[],
  reservationIds: string[],
  kind: CoworkDispatchKind,
): CoworkDispatchRecord[] {
  const ids = new Set(reservationIds);
  return existing.filter((r) => !(r.kind === kind && ids.has(r.reservationId)));
}

export interface CoworkDispatchPartition<T> {
  /** Safe to dispatch now. */
  ready: T[];
  /** Held back because a live dispatch already covers these exact slots. */
  suppressed: { item: T; reservationId: string; dispatchedAtMs: number; clearsAtMs: number }[];
}

/**
 * Split candidates into what may be dispatched and what a live run already
 * covers.
 *
 * SUPPRESSION RULE (both must hold):
 *  1. a live record exists for this (reservation, kind), AND
 *  2. every slot we would dispatch NOW is one the record already covers.
 *
 * Rule 2 is what makes a detach — or any newly-opened slot — re-admit the
 * reservation immediately and correctly, with no clock involved. A record with
 * an empty unit set covers everything (checkout batches, where the unit set is
 * the whole reservation).
 */
export function partitionCoworkDispatchCandidates<T>(
  candidates: T[],
  kind: CoworkDispatchKind,
  records: CoworkDispatchRecord[],
  nowMs: number,
  describe: (item: T) => { reservationId: string; unitIds: string[] },
): CoworkDispatchPartition<T> {
  const live = pruneCoworkDispatches(records, nowMs);
  const byId = new Map<string, CoworkDispatchRecord>();
  for (const r of live) if (r.kind === kind) byId.set(r.reservationId, r);

  const ready: T[] = [];
  const suppressed: CoworkDispatchPartition<T>["suppressed"] = [];
  for (const item of candidates) {
    const { reservationId, unitIds } = describe(item);
    const record = byId.get(reservationId);
    if (!record) { ready.push(item); continue; }
    const covered = record.unitIds.length === 0
      || unitIds.every((u) => record.unitIds.includes(u));
    if (!covered) { ready.push(item); continue; }
    suppressed.push({
      item,
      reservationId,
      dispatchedAtMs: record.dispatchedAtMs,
      clearsAtMs: record.dispatchedAtMs + recordTtlMs(record),
    });
  }
  return { ready, suppressed };
}

/**
 * Honest one-line summary. Deliberately ELAPSED-time based: "3 just sent" is
 * true at minute 2 and a lie at minute 80, and the operator reads this line
 * long after dispatching.
 */
export function describeCoworkSuppression(
  count: number,
  oldestDispatchedAtMs: number,
  nowMs: number,
): string {
  if (count <= 0) return "";
  // FLOOR, not round: 90 minutes must read "1h ago", not "2h ago".
  const mins = Math.max(0, Math.floor((nowMs - oldestDispatchedAtMs) / 60_000));
  const when = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)}h ago`;
  const noun = count === 1 ? "booking" : "bookings";
  // HONESTY: say SENT, not "already with Cowork" / "running". All the app can
  // know is that it fired the deep link — firing it does NOT start the task,
  // and the operator still has to press send in Claude Desktop. If they walked
  // away without pressing send, nothing is running and this line would
  // otherwise be a flat lie, so it names that case and points at the override.
  return `${count} ${noun} sent to Cowork ${when} — held back so a second run can't race the same slots. Didn't press send in Claude Desktop? Use "Send anyway".`;
}
