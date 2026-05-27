type SidecarLaneOwnerType = "availability-scan" | "bulk-combo-listing" | "bulk-pricing" | "pricing-refresh" | "find-buy-in";

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
const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;

let owner: SidecarLaneOwner | null = null;
let waiters: SidecarLaneWaiter[] = [];
const cancelledOwners = new Map<string, string>();

const nowMs = () => Date.now();

const cloneOwner = (value: SidecarLaneOwner | null) => value ? { ...value } : null;
const cloneWaiter = (value: SidecarLaneWaiter) => ({ ...value });

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getSidecarLaneStatus() {
  clearExpiredOwner();
  return {
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
    if (await options.shouldCancel?.()) {
      removeWaiter(options.ownerType, options.ownerId);
      throw Object.assign(new Error("Cancelled while waiting for Chrome sidecar lane"), { cancelled: true });
    }
    if (isSidecarLaneCancellationRequested(options.ownerType, options.ownerId)) {
      removeWaiter(options.ownerType, options.ownerId);
      throw Object.assign(new Error("Chrome sidecar lane owner was cancelled"), { cancelled: true });
    }

    if (sameOwner(owner, options.ownerType, options.ownerId)) {
      removeWaiter(options.ownerType, options.ownerId);
      const current = setOwner(options.ownerType, options.ownerId, options.label);
      return {
        acquiredAt: current.acquiredAt,
        heartbeat: () => {
          if (sameOwner(owner, options.ownerType, options.ownerId)) {
            setOwner(options.ownerType, options.ownerId, options.label);
          }
        },
        release: () => {
          cancelledOwners.delete(ownerKey(options.ownerType, options.ownerId));
          if (sameOwner(owner, options.ownerType, options.ownerId)) owner = null;
        },
      };
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
      removeWaiter(options.ownerType, options.ownerId);
      cancelledOwners.delete(ownerKey(options.ownerType, options.ownerId));
      const current = setOwner(options.ownerType, options.ownerId, options.label);
      return {
        acquiredAt: current.acquiredAt,
        heartbeat: () => {
          if (sameOwner(owner, options.ownerType, options.ownerId)) {
            setOwner(options.ownerType, options.ownerId, options.label);
          }
        },
        release: () => {
          cancelledOwners.delete(ownerKey(options.ownerType, options.ownerId));
          if (sameOwner(owner, options.ownerType, options.ownerId)) owner = null;
        },
      };
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
