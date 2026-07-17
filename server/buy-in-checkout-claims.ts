import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { buyInCheckoutClaims, buyIns, type BuyIn, type BuyInCheckoutClaim } from "@shared/schema";
import { db } from "./db";

export const BUY_IN_CHECKOUT_CLAIM_TTL_MS = 2 * 60 * 60_000;
export const BUY_IN_CHECKOUT_CLAIM_REAP_INTERVAL_MS = 15 * 60_000;
export const ACTIVE_BUY_IN_CHECKOUT_STATUSES = ["queued", "in_progress", "awaiting_payment"];

let claimReaperStarted = false;

export class BuyInCheckoutClaimError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 = 409) {
    super(message);
    this.name = "BuyInCheckoutClaimError";
  }
}

type ClaimInput = {
  reservationId: string;
  buyInId: number;
  claimToken: string;
  owner: "cowork" | "sidecar";
};

function normalizedClaimInput(input: ClaimInput): ClaimInput {
  const reservationId = String(input.reservationId ?? "").trim().slice(0, 200);
  const buyInId = Number(input.buyInId);
  const claimToken = String(input.claimToken ?? "").trim();
  if (!reservationId || !Number.isInteger(buyInId) || buyInId <= 0) {
    throw new BuyInCheckoutClaimError("A valid reservationId and buyInId are required", 400);
  }
  if (!/^[A-Za-z0-9_-]{16,120}$/.test(claimToken)) {
    throw new BuyInCheckoutClaimError("A valid checkout claimToken is required", 400);
  }
  if (input.owner !== "cowork" && input.owner !== "sidecar") {
    throw new BuyInCheckoutClaimError("A valid checkout claim owner is required", 400);
  }
  return { reservationId, buyInId, claimToken, owner: input.owner };
}

async function lockReservation(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], reservationId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${reservationId}))`);
}

async function expireClaim(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  claim: BuyInCheckoutClaim,
): Promise<void> {
  await tx
    .update(buyIns)
    .set({
      bookingStatus: "failed",
      bookingError: "Checkout preparation claim expired before the payment handoff",
    })
    .where(and(eq(buyIns.id, claim.buyInId), eq(buyIns.bookingStatus, "in_progress")));
  await tx
    .delete(buyInCheckoutClaims)
    .where(and(
      eq(buyInCheckoutClaims.reservationId, claim.reservationId),
      eq(buyInCheckoutClaims.claimToken, claim.claimToken),
    ));
}

export async function reapExpiredBuyInCheckoutClaims(now = new Date()): Promise<number> {
  let reaped = 0;

  // Bound each sweep so an unexpected backlog cannot monopolize the process.
  // The 15-minute scheduler will continue draining any remainder.
  for (let batch = 0; batch < 10; batch += 1) {
    const expired = await db
      .select({ reservationId: buyInCheckoutClaims.reservationId })
      .from(buyInCheckoutClaims)
      .where(lte(buyInCheckoutClaims.expiresAt, now))
      .limit(100);
    if (expired.length === 0) break;

    for (const candidate of expired) {
      const didReap = await db.transaction(async (tx) => {
        await lockReservation(tx, candidate.reservationId);
        const [claim] = await tx
          .select()
          .from(buyInCheckoutClaims)
          .where(and(
            eq(buyInCheckoutClaims.reservationId, candidate.reservationId),
            lte(buyInCheckoutClaims.expiresAt, now),
          ))
          .limit(1);
        if (!claim) return false;
        await expireClaim(tx, claim);
        return true;
      });
      if (didReap) reaped += 1;
    }

    if (expired.length < 100) break;
  }

  return reaped;
}

export function startBuyInCheckoutClaimReaper(): void {
  if (claimReaperStarted) return;
  claimReaperStarted = true;
  const sweep = () => {
    void reapExpiredBuyInCheckoutClaims().catch(() => {
      // Keep the server alive and retry on the next interval. Avoid logging
      // claim contents because they contain reservation identifiers.
      console.error("[buy-in-checkout-claims] Expired claim cleanup failed");
    });
  };
  sweep();
  setInterval(sweep, BUY_IN_CHECKOUT_CLAIM_REAP_INTERVAL_MS).unref?.();
}

async function mutateBuyInWithCheckoutGuard<T>(
  buyInId: number,
  action: "detach" | "delete",
  mutate: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    target: BuyIn,
  ) => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const [initial] = await tx
      .select()
      .from(buyIns)
      .where(eq(buyIns.id, buyInId))
      .limit(1);
    if (!initial) return undefined;

    let lockedReservationId = String(initial.guestyReservationId ?? "").trim();
    if (!lockedReservationId) {
      const [orphanClaim] = await tx
        .select({ reservationId: buyInCheckoutClaims.reservationId })
        .from(buyInCheckoutClaims)
        .where(eq(buyInCheckoutClaims.buyInId, buyInId))
        .limit(1);
      lockedReservationId = String(orphanClaim?.reservationId ?? "").trim();
    }
    if (lockedReservationId) await lockReservation(tx, lockedReservationId);

    // Re-read after acquiring the reservation lane. This closes the race with
    // a claim that began between the first read and the advisory lock.
    const [target] = await tx
      .select()
      .from(buyIns)
      .where(eq(buyIns.id, buyInId))
      .limit(1)
      .for("update");
    if (!target) return undefined;
    const reservationId = String(target.guestyReservationId ?? "").trim();
    if (reservationId !== lockedReservationId && (reservationId || lockedReservationId)) {
      throw new BuyInCheckoutClaimError(
        `Cannot ${action} this buy-in because its reservation attachment changed; retry after the current operation finishes`,
      );
    }

    const [activeSibling] = reservationId
      ? await tx
          .select({ id: buyIns.id, bookingStatus: buyIns.bookingStatus })
          .from(buyIns)
          .where(and(
            eq(buyIns.guestyReservationId, reservationId),
            inArray(buyIns.bookingStatus, ACTIVE_BUY_IN_CHECKOUT_STATUSES),
          ))
          .limit(1)
      : ACTIVE_BUY_IN_CHECKOUT_STATUSES.includes(target.bookingStatus)
        ? [{ id: target.id, bookingStatus: target.bookingStatus }]
        : [];
    const [claim] = reservationId
      ? await tx
          .select({ buyInId: buyInCheckoutClaims.buyInId })
          .from(buyInCheckoutClaims)
          .where(eq(buyInCheckoutClaims.reservationId, reservationId))
          .limit(1)
      : await tx
          .select({ buyInId: buyInCheckoutClaims.buyInId })
          .from(buyInCheckoutClaims)
          .where(eq(buyInCheckoutClaims.buyInId, buyInId))
          .limit(1);
    if (activeSibling || claim) {
      throw new BuyInCheckoutClaimError(
        `Cannot ${action} a buy-in while checkout preparation is queued, in progress, or awaiting payment`,
      );
    }

    return mutate(tx, target);
  });
}

export async function detachBuyInWithCheckoutGuard(buyInId: number): Promise<BuyIn | undefined> {
  return mutateBuyInWithCheckoutGuard(buyInId, "detach", async (tx) => {
    const [row] = await tx
      .update(buyIns)
      .set({ guestyReservationId: null, attachedAt: null })
      .where(eq(buyIns.id, buyInId))
      .returning();
    return row;
  });
}

export async function deleteBuyInWithCheckoutGuard(buyInId: number): Promise<boolean> {
  const deleted = await mutateBuyInWithCheckoutGuard(buyInId, "delete", async (tx) => {
    const rows = await tx.delete(buyIns).where(eq(buyIns.id, buyInId)).returning({ id: buyIns.id });
    return rows.length > 0;
  });
  return deleted ?? false;
}

export async function claimBuyInCheckout(input: ClaimInput): Promise<{
  buyInId: number;
  reservationId: string;
  bookingStatus: "in_progress";
  reused: boolean;
  expiresAt: Date;
}> {
  const normalized = normalizedClaimInput(input);
  while (true) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + BUY_IN_CHECKOUT_CLAIM_TTL_MS);
    const outcome = await db.transaction(async (tx) => {
      await lockReservation(tx, normalized.reservationId);

      const existingRows = await tx
        .select()
        .from(buyInCheckoutClaims)
        .where(eq(buyInCheckoutClaims.reservationId, normalized.reservationId))
        .limit(1);
      const existing: BuyInCheckoutClaim | undefined = existingRows[0];

      if (existing && existing.expiresAt.getTime() <= now.getTime()) {
        await expireClaim(tx, existing);
        // Return instead of throwing so the cleanup transaction commits. The
        // outer loop then reacquires the lock and attempts a fresh claim.
        return { kind: "expired" as const };
      }

      if (existing) {
        if (
          existing.buyInId === normalized.buyInId
          && existing.claimToken === normalized.claimToken
          && existing.owner === normalized.owner
        ) {
          return {
            kind: "claimed" as const,
            claim: {
              buyInId: normalized.buyInId,
              reservationId: normalized.reservationId,
              bookingStatus: "in_progress" as const,
              reused: true,
              expiresAt: existing.expiresAt,
            },
          };
        }
        throw new BuyInCheckoutClaimError(
          `Buy-in ${existing.buyInId} already owns this reservation's checkout-preparation lane`,
        );
      }

      const [target] = await tx
        .select({
          id: buyIns.id,
          reservationId: buyIns.guestyReservationId,
          status: buyIns.status,
          bookingStatus: buyIns.bookingStatus,
        })
        .from(buyIns)
        .where(eq(buyIns.id, normalized.buyInId))
        .limit(1);

      if (!target || target.status === "cancelled") {
        throw new BuyInCheckoutClaimError("Attached buy-in not found", 404);
      }
      if (String(target.reservationId ?? "") !== normalized.reservationId) {
        throw new BuyInCheckoutClaimError("Buy-in is not attached to this reservation");
      }
      if (["booked", "request_submitted"].includes(target.bookingStatus)) {
        throw new BuyInCheckoutClaimError(`Buy-in is already ${target.bookingStatus}`);
      }
      if (ACTIVE_BUY_IN_CHECKOUT_STATUSES.includes(target.bookingStatus)) {
        throw new BuyInCheckoutClaimError(`Buy-in already has checkout status ${target.bookingStatus}`);
      }

      const activeSiblings = await tx
        .select({ id: buyIns.id, bookingStatus: buyIns.bookingStatus })
        .from(buyIns)
        .where(and(
          eq(buyIns.guestyReservationId, normalized.reservationId),
          inArray(buyIns.bookingStatus, ACTIVE_BUY_IN_CHECKOUT_STATUSES),
        ));
      const conflicting = activeSiblings.find((row) => row.id !== normalized.buyInId);
      if (conflicting) {
        throw new BuyInCheckoutClaimError(
          `Buy-in ${conflicting.id} already has checkout status ${conflicting.bookingStatus}`,
        );
      }

      await tx.insert(buyInCheckoutClaims).values({
        reservationId: normalized.reservationId,
        buyInId: normalized.buyInId,
        claimToken: normalized.claimToken,
        owner: normalized.owner,
        expiresAt,
      });
      await tx
        .update(buyIns)
        .set({ bookingStatus: "in_progress", bookingError: null })
        .where(eq(buyIns.id, normalized.buyInId));

      return {
        kind: "claimed" as const,
        claim: {
          buyInId: normalized.buyInId,
          reservationId: normalized.reservationId,
          bookingStatus: "in_progress" as const,
          reused: false,
          expiresAt,
        },
      };
    });

    if (outcome.kind === "claimed") return outcome.claim;
    // The expired-row deletion is committed before this fresh attempt. A
    // concurrent caller may win the next lock, in which case the ordinary
    // conflict response safely stops this task.
  }
}

type MatchingClaimOutcome =
  | { kind: "matched"; claim: BuyInCheckoutClaim }
  | { kind: "expired" };

async function matchingClaim(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: ClaimInput,
): Promise<MatchingClaimOutcome> {
  const [claim] = await tx
    .select()
    .from(buyInCheckoutClaims)
    .where(eq(buyInCheckoutClaims.reservationId, input.reservationId))
    .limit(1);
  if (claim && claim.expiresAt.getTime() <= Date.now()) {
    await expireClaim(tx, claim);
    // The caller must return this sentinel from its transaction and throw only
    // after commit; throwing here would roll the cleanup back.
    return { kind: "expired" };
  }
  if (
    !claim
    || claim.buyInId !== input.buyInId
    || claim.claimToken !== input.claimToken
    || claim.owner !== input.owner
  ) {
    throw new BuyInCheckoutClaimError("Checkout claim is missing or owned by another task");
  }
  return { kind: "matched", claim };
}

function throwExpiredClaimAfterCommit(): never {
  throw new BuyInCheckoutClaimError("Checkout claim expired before the payment handoff");
}

export async function completeBuyInCheckoutClaim(input: ClaimInput): Promise<void> {
  const normalized = normalizedClaimInput(input);
  const outcome = await db.transaction(async (tx) => {
    await lockReservation(tx, normalized.reservationId);
    const match = await matchingClaim(tx, normalized);
    if (match.kind === "expired") return "expired" as const;
    const [target] = await tx
      .select({
        reservationId: buyIns.guestyReservationId,
        notes: buyIns.notes,
        travelerEmail: buyIns.travelerEmail,
      })
      .from(buyIns)
      .where(eq(buyIns.id, normalized.buyInId))
      .limit(1);
    if (!target || String(target.reservationId ?? "") !== normalized.reservationId) {
      throw new BuyInCheckoutClaimError("Buy-in is not attached to this reservation");
    }
    const travelerEmail = String(target.travelerEmail ?? "").trim();
    if (!travelerEmail) throw new BuyInCheckoutClaimError("Traveler alias is missing");
    const sourceLabel = normalized.owner === "cowork" ? "Cowork" : "local sidecar";
    const suffix = `VRBO checkout prepared via ${sourceLabel} — awaiting operator card entry and final checkout, traveler ${travelerEmail}`;
    const notes = String(target.notes ?? "").includes(suffix)
      ? target.notes
      : [String(target.notes ?? "").trim(), suffix].filter(Boolean).join(" · ");
    await tx
      .update(buyIns)
      .set({ bookingStatus: "awaiting_payment", bookingError: null, notes })
      .where(eq(buyIns.id, normalized.buyInId));
    await tx
      .delete(buyInCheckoutClaims)
      .where(eq(buyInCheckoutClaims.reservationId, normalized.reservationId));
    return "completed" as const;
  });
  if (outcome === "expired") throwExpiredClaimAfterCommit();
}

export async function failBuyInCheckoutClaim(input: ClaimInput, reason: string): Promise<void> {
  const normalized = normalizedClaimInput(input);
  const safeReason = String(reason ?? "Checkout preparation stopped before payment handoff")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "Checkout preparation stopped before payment handoff";
  const outcome = await db.transaction(async (tx) => {
    await lockReservation(tx, normalized.reservationId);
    const match = await matchingClaim(tx, normalized);
    if (match.kind === "expired") return "expired" as const;
    await tx
      .update(buyIns)
      .set({ bookingStatus: "failed", bookingError: safeReason })
      .where(and(
        eq(buyIns.id, normalized.buyInId),
        eq(buyIns.guestyReservationId, normalized.reservationId),
      ));
    await tx
      .delete(buyInCheckoutClaims)
      .where(eq(buyInCheckoutClaims.reservationId, normalized.reservationId));
    return "failed" as const;
  });
  if (outcome === "expired") throwExpiredClaimAfterCommit();
}

export async function clearBuyInCheckoutClaim(input: ClaimInput): Promise<void> {
  const normalized = normalizedClaimInput(input);
  const outcome = await db.transaction(async (tx) => {
    await lockReservation(tx, normalized.reservationId);
    const match = await matchingClaim(tx, normalized);
    if (match.kind === "expired") return "expired" as const;
    await tx
      .delete(buyInCheckoutClaims)
      .where(eq(buyInCheckoutClaims.reservationId, normalized.reservationId));
    return "cleared" as const;
  });
  if (outcome === "expired") throwExpiredClaimAfterCommit();
}

export async function resetBuyInCheckoutClaim(
  reservationIdInput: string,
  buyInIdInput: number,
): Promise<void> {
  const reservationId = String(reservationIdInput ?? "").trim().slice(0, 200);
  const buyInId = Number(buyInIdInput);
  if (!reservationId || !Number.isInteger(buyInId) || buyInId <= 0) {
    throw new BuyInCheckoutClaimError("A valid reservationId and buyInId are required", 400);
  }
  await db.transaction(async (tx) => {
    await lockReservation(tx, reservationId);
    const [target] = await tx
      .select({ reservationId: buyIns.guestyReservationId, bookingStatus: buyIns.bookingStatus })
      .from(buyIns)
      .where(eq(buyIns.id, buyInId))
      .limit(1);
    if (!target || String(target.reservationId ?? "") !== reservationId) {
      throw new BuyInCheckoutClaimError("Buy-in is not attached to this reservation", 404);
    }
    if (target.bookingStatus !== "queued" && target.bookingStatus !== "in_progress") {
      throw new BuyInCheckoutClaimError("Only a queued or in-progress checkout can be reset");
    }
    const [claim] = await tx
      .select({ buyInId: buyInCheckoutClaims.buyInId })
      .from(buyInCheckoutClaims)
      .where(eq(buyInCheckoutClaims.reservationId, reservationId))
      .limit(1);
    if (claim && claim.buyInId !== buyInId) {
      throw new BuyInCheckoutClaimError(
        `Buy-in ${claim.buyInId} owns this reservation's checkout-preparation lane`,
      );
    }
    if (claim) {
      await tx
        .delete(buyInCheckoutClaims)
        .where(and(
          eq(buyInCheckoutClaims.reservationId, reservationId),
          eq(buyInCheckoutClaims.buyInId, buyInId),
        ));
    }
    await tx
      .update(buyIns)
      .set({ bookingStatus: "failed", bookingError: "Checkout preparation reset by operator" })
      .where(eq(buyIns.id, buyInId));
  });
}
