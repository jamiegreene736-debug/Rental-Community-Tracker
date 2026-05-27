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

const SIDECAR_LANE_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;

let owner: SidecarLaneOwner | null = null;
const cancelledOwners = new Map<string, string>();

const nowMs = () => Date.now();

const cloneOwner = (value: SidecarLaneOwner | null) => value ? { ...value } : null;

function isExpired(value: SidecarLaneOwner | null): boolean {
  return !!value && value.leaseExpiresAt < nowMs();
}

function sameOwner(value: SidecarLaneOwner | null, ownerType: SidecarLaneOwnerType, ownerId: string): boolean {
  return !!value && value.ownerType === ownerType && value.ownerId === ownerId;
}

function ownerKey(ownerType: SidecarLaneOwnerType, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
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

  while (true) {
    clearExpiredOwner();
    if (await options.shouldCancel?.()) {
      throw Object.assign(new Error("Cancelled while waiting for Chrome sidecar lane"), { cancelled: true });
    }
    if (isSidecarLaneCancellationRequested(options.ownerType, options.ownerId)) {
      throw Object.assign(new Error("Chrome sidecar lane owner was cancelled"), { cancelled: true });
    }

    if (!owner || isExpired(owner) || sameOwner(owner, options.ownerType, options.ownerId)) {
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
      throw new Error(`Timed out waiting for Chrome sidecar lane held by ${owner.label}`);
    }

    if (options.onWait && nowMs() - lastWaitNoticeAt > 30_000) {
      lastWaitNoticeAt = nowMs();
      await options.onWait({ ...owner });
    }
    await sleep(pollMs);
  }
}
