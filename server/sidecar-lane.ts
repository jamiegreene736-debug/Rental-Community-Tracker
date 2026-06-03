import { and, eq, sql } from "drizzle-orm";
import { workResourceLocks, type WorkResourceLock } from "@shared/schema";
import { db } from "./db";

const SIDECAR_LANE_OWNER_TYPES = ["availability-scan", "bulk-combo-listing", "bulk-pricing", "pricing-refresh", "find-buy-in"] as const;
type SidecarLaneOwnerType = typeof SIDECAR_LANE_OWNER_TYPES[number];

type SidecarLaneOwner = {
  ownerType: SidecarLaneOwnerType;
  ownerId: string;
  label: string;
  acquiredAt: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
};

type AcquireSidecarLaneOptions = {
  ownerType: SidecarLaneOwnerType;
  ownerId: string;
  label: string;
  waitTimeoutMs?: number;
  pollMs?: number;
  onWait?: (owner: SidecarLaneOwner) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
};

type SidecarLaneWaiter = {
  ownerType: SidecarLaneOwnerType;
  ownerId: string;
  label: string;
  enqueuedAt: number;
};

const SIDECAR_LANE_LEASE_MS = 10 * 60 * 1000;
const SIDECAR_LANE_RESOURCE_KEY = "sidecar-browser";
const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;

let owner: SidecarLaneOwner | null = null;
let waiters: SidecarLaneWaiter[] = [];
const cancelledOwners = new Map<string, string>();

const nowMs = () => Date.now();

const cloneOwner = (value: SidecarLaneOwner | null) => value ? { ...value } : null;
const cloneWaiter = (value: SidecarLaneWaiter) => ({ ...value });

function dateMs(value: Date | string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function toOwnerType(value: string | null | undefined): SidecarLaneOwnerType | null {
  if (!value) return null;
  return (SIDECAR_LANE_OWNER_TYPES as readonly string[]).includes(value)
    ? value as SidecarLaneOwnerType
    : null;
}

function ownerFromLock(row: WorkResourceLock): SidecarLaneOwner | null {
  const ownerType = toOwnerType(row.ownerType);
  if (!ownerType) return null;
  const heartbeatAt = dateMs(row.heartbeatAt) || nowMs();
  return {
    ownerType,
    ownerId: row.ownerId,
    label: row.ownerLabel,
    acquiredAt: dateMs(row.acquiredAt) || heartbeatAt,
    heartbeatAt,
    leaseExpiresAt: dateMs(row.expiresAt) || heartbeatAt + SIDECAR_LANE_LEASE_MS,
  };
}

function logPersistentLockError(action: string, e: unknown): void {
  console.warn(`[sidecar-lane] ${action} failed:`, e instanceof Error ? e.message : e);
}

function isExpired(value: SidecarLaneOwner | null): boolean {
  return !!value && value.leaseExpiresAt < nowMs();
}

function sameOwner(value: Pick<SidecarLaneOwner, "ownerType" | "ownerId"> | null, ownerType: SidecarLaneOwnerType, ownerId: string): boolean {
  return !!value && value.ownerType === ownerType && value.ownerId === ownerId;
}

function ownerKey(ownerType: SidecarLaneOwnerType, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

function removeWaiter(ownerType: SidecarLaneOwnerType, ownerId: string): void {
  waiters = waiters.filter((waiter) => !sameOwner(waiter, ownerType, ownerId));
}

function firstWaiterIs(ownerType: SidecarLaneOwnerType, ownerId: string): boolean {
  const first = waiters[0];
  return !!first && first.ownerType === ownerType && first.ownerId === ownerId;
}

function hasWaiter(ownerType: SidecarLaneOwnerType, ownerId: string): boolean {
  return waiters.some((waiter) => sameOwner(waiter, ownerType, ownerId));
}

function clearExpiredOwner(): void {
  if (!isExpired(owner)) return;
  if (owner) cancelledOwners.delete(ownerKey(owner.ownerType, owner.ownerId));
  owner = null;
}

function setOwner(ownerType: SidecarLaneOwnerType, ownerId: string, label: string): SidecarLaneOwner {
  const now = nowMs();
  owner = {
    ownerType,
    ownerId,
    label,
    acquiredAt: sameOwner(owner, ownerType, ownerId) ? owner!.acquiredAt : now,
    heartbeatAt: now,
    leaseExpiresAt: now + SIDECAR_LANE_LEASE_MS,
  };
  return owner;
}

function setPersistentOwner(value: SidecarLaneOwner): SidecarLaneOwner {
  owner = { ...value };
  return owner;
}

async function markPersistentOwnerStatus(
  ownerType: SidecarLaneOwnerType,
  ownerId: string,
  status: "released" | "cancelled" | "expired",
): Promise<void> {
  const now = new Date();
  await db
    .update(workResourceLocks)
    .set({
      status,
      expiresAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(workResourceLocks.resourceKey, SIDECAR_LANE_RESOURCE_KEY),
      eq(workResourceLocks.ownerType, ownerType),
      eq(workResourceLocks.ownerId, ownerId),
    ));
}

async function markExpiredPersistentOwner(): Promise<void> {
  const now = new Date();
  await db
    .update(workResourceLocks)
    .set({
      status: "expired",
      expiresAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(workResourceLocks.resourceKey, SIDECAR_LANE_RESOURCE_KEY),
      eq(workResourceLocks.status, "active"),
      sql`${workResourceLocks.expiresAt} <= ${now}`,
    ));
}

async function loadPersistentOwner(): Promise<SidecarLaneOwner | null> {
  const [row] = await db
    .select()
    .from(workResourceLocks)
    .where(eq(workResourceLocks.resourceKey, SIDECAR_LANE_RESOURCE_KEY))
    .limit(1);
  if (!row) return null;
  const current = ownerFromLock(row);
  if (!current || row.status !== "active" || current.leaseExpiresAt <= nowMs()) {
    if (row.status === "active") {
      await markExpiredPersistentOwner();
    }
    return null;
  }
  return current;
}

async function syncOwnerFromPersistentLock(): Promise<void> {
  const persistentOwner = await loadPersistentOwner();
  owner = persistentOwner;
}

async function claimPersistentOwner(
  ownerType: SidecarLaneOwnerType,
  ownerId: string,
  label: string,
): Promise<SidecarLaneOwner | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SIDECAR_LANE_LEASE_MS);
  const [row] = await db
    .insert(workResourceLocks)
    .values({
      resourceKey: SIDECAR_LANE_RESOURCE_KEY,
      ownerType,
      ownerId,
      ownerLabel: label,
      status: "active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workResourceLocks.resourceKey,
      set: {
        ownerType,
        ownerId,
        ownerLabel: label,
        status: "active",
        acquiredAt: sql`case when ${workResourceLocks.ownerType} = ${ownerType} and ${workResourceLocks.ownerId} = ${ownerId} and ${workResourceLocks.status} = 'active' then ${workResourceLocks.acquiredAt} else ${now} end`,
        heartbeatAt: now,
        expiresAt,
        updatedAt: now,
      },
      where: sql`${workResourceLocks.status} <> 'active'
        or ${workResourceLocks.expiresAt} <= ${now}
        or (${workResourceLocks.ownerType} = ${ownerType} and ${workResourceLocks.ownerId} = ${ownerId})`,
    })
    .returning();
  const claimed = row ? ownerFromLock(row) : null;
  return sameOwner(claimed, ownerType, ownerId) ? claimed : null;
}

async function refreshPersistentOwner(
  ownerType: SidecarLaneOwnerType,
  ownerId: string,
  label: string,
): Promise<SidecarLaneOwner | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SIDECAR_LANE_LEASE_MS);
  const [row] = await db
    .update(workResourceLocks)
    .set({
      ownerLabel: label,
      heartbeatAt: now,
      expiresAt,
      updatedAt: now,
    })
    .where(and(
      eq(workResourceLocks.resourceKey, SIDECAR_LANE_RESOURCE_KEY),
      eq(workResourceLocks.ownerType, ownerType),
      eq(workResourceLocks.ownerId, ownerId),
      eq(workResourceLocks.status, "active"),
      sql`${workResourceLocks.expiresAt} > ${now}`,
    ))
    .returning();
  return row ? ownerFromLock(row) : null;
}

function createLaneHandle(
  current: SidecarLaneOwner,
  options: Pick<AcquireSidecarLaneOptions, "ownerType" | "ownerId" | "label">,
): {
  acquiredAt: number;
  heartbeat: () => void;
  release: () => void;
} {
  return {
    acquiredAt: current.acquiredAt,
    heartbeat: () => {
      if (!sameOwner(owner, options.ownerType, options.ownerId)) return;
      setOwner(options.ownerType, options.ownerId, options.label);
      void refreshPersistentOwner(options.ownerType, options.ownerId, options.label)
        .then((refreshed) => {
          if (refreshed && sameOwner(owner, options.ownerType, options.ownerId)) {
            setPersistentOwner(refreshed);
          }
        })
        .catch((e) => logPersistentLockError("heartbeat", e));
    },
    release: () => {
      cancelledOwners.delete(ownerKey(options.ownerType, options.ownerId));
      if (sameOwner(owner, options.ownerType, options.ownerId)) owner = null;
      void markPersistentOwnerStatus(options.ownerType, options.ownerId, "released")
        .catch((e) => logPersistentLockError("release", e));
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getSidecarLaneStatus() {
  clearExpiredOwner();
  return {
    resourceKey: SIDECAR_LANE_RESOURCE_KEY,
    leaseMs: SIDECAR_LANE_LEASE_MS,
    busy: !!owner,
    owner: cloneOwner(owner),
    waiting: waiters.map(cloneWaiter),
  };
}

export function isSidecarLaneOwner(ownerType: SidecarLaneOwnerType, ownerId: string): boolean {
  clearExpiredOwner();
  return sameOwner(owner, ownerType, ownerId);
}

export function isSidecarLaneCancellationRequested(ownerType: SidecarLaneOwnerType, ownerId: string): boolean {
  return cancelledOwners.has(ownerKey(ownerType, ownerId));
}

export function cancelActiveSidecarLane(reason = "sidecar lane cancelled by operator"): {
  cancelled: boolean;
  owner: SidecarLaneOwner | null;
} {
  clearExpiredOwner();
  if (!owner) return { cancelled: false, owner: null };
  // NOTE FOR CODEX: this only marks the top-level producer cancelled.
  // `/api/vrbo-sidecar/stop|clear` still cancels low-level Chrome queue
  // requests; lane cancellation stops the producer from enqueueing the
  // next Airbnb/VRBO/Booking job after the operator has cleared the queue.
  cancelledOwners.set(ownerKey(owner.ownerType, owner.ownerId), reason.slice(0, 200));
  return { cancelled: true, owner: cloneOwner(owner) };
}

export function clearActiveSidecarLane(reason = "sidecar lane cleared by operator"): {
  cancelled: boolean;
  owner: SidecarLaneOwner | null;
} {
  const result = cancelActiveSidecarLane(reason);
  if (result.owner) {
    void markPersistentOwnerStatus(result.owner.ownerType, result.owner.ownerId, "cancelled")
      .catch((e) => logPersistentLockError("cancel", e));
  }
  owner = null;
  waiters = [];
  return result;
}

export async function acquireSidecarLane(options: AcquireSidecarLaneOptions): Promise<{
  acquiredAt: number;
  heartbeat: () => void;
  release: () => void;
}> {
  const startedAt = nowMs();
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let lastWaitNoticeAt = 0;
  let enqueued = false;

  while (true) {
    clearExpiredOwner();
    await syncOwnerFromPersistentLock();
    if (await options.shouldCancel?.()) {
      removeWaiter(options.ownerType, options.ownerId);
      throw Object.assign(new Error("Cancelled while waiting for Chrome sidecar lane"), { cancelled: true });
    }
    if (isSidecarLaneCancellationRequested(options.ownerType, options.ownerId)) {
      removeWaiter(options.ownerType, options.ownerId);
      throw Object.assign(new Error("Chrome sidecar lane owner was cancelled"), { cancelled: true });
    }

    if (sameOwner(owner, options.ownerType, options.ownerId)) {
      const current = await claimPersistentOwner(options.ownerType, options.ownerId, options.label);
      if (current) {
        removeWaiter(options.ownerType, options.ownerId);
        return createLaneHandle(setPersistentOwner(current), options);
      }
      await syncOwnerFromPersistentLock();
    }

    if (!enqueued && !hasWaiter(options.ownerType, options.ownerId)) {
      waiters.push({
        ownerType: options.ownerType,
        ownerId: options.ownerId,
        label: options.label,
        enqueuedAt: startedAt,
      });
      enqueued = true;
    } else if (!enqueued) {
      enqueued = true;
    }

    if (!owner && firstWaiterIs(options.ownerType, options.ownerId)) {
      const current = await claimPersistentOwner(options.ownerType, options.ownerId, options.label);
      if (current) {
        removeWaiter(options.ownerType, options.ownerId);
        cancelledOwners.delete(ownerKey(options.ownerType, options.ownerId));
        return createLaneHandle(setPersistentOwner(current), options);
      }
      await syncOwnerFromPersistentLock();
    }

    if (nowMs() - startedAt > waitTimeoutMs) {
      removeWaiter(options.ownerType, options.ownerId);
      const blockingLabel = owner?.label ?? waiters[0]?.label ?? "another queued scan";
      throw new Error(`Timed out waiting for Chrome sidecar lane held by ${blockingLabel}`);
    }

    if (options.onWait && nowMs() - lastWaitNoticeAt > 30_000) {
      lastWaitNoticeAt = nowMs();
      await options.onWait(owner ? { ...owner } : {
        ownerType: waiters[0]?.ownerType ?? options.ownerType,
        ownerId: waiters[0]?.ownerId ?? options.ownerId,
        label: waiters[0]?.label ?? "another queued scan",
        acquiredAt: waiters[0]?.enqueuedAt ?? nowMs(),
        heartbeatAt: nowMs(),
        leaseExpiresAt: nowMs() + SIDECAR_LANE_LEASE_MS,
      });
    }
    await sleep(pollMs);
  }
}
