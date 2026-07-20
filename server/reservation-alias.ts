// Unit-scoped SimpleLogin alias engine — extracted VERBATIM from routes.ts
// (2026-07-19, unified-alias PR) so server/buy-in-checkout-job.ts can mint the
// SAME per-unit alias for the VRBO traveler email instead of its old per-guest
// `firstname.lastname@` scheme (which silently stored one shared address on two
// units when SimpleLogin said "already exists"). ONE alias per attached buy-in,
// keyed (reservation_id, buy_in_id), now serves BOTH the PM/arrival-details
// thread AND the VRBO booking/traveler email.
//
// NOTE FOR CODEX: do not re-inline these into routes.ts and do not add a second
// traveler-email minting scheme — tests/unified-buyin-alias.test.ts source-locks
// this seam.

import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { reservationAliases } from "@shared/schema";
import { storage } from "./storage";
import {
  aliasPrefixCandidates,
  createSimpleLoginAlias,
  extractSimpleLoginAliasEmail,
  extractSimpleLoginAliasId,
  isSimpleLoginAliasExistsError,
  SIMPLELOGIN_MAILBOX_EMAIL,
} from "./simplelogin";

export const ALIAS_EXPIRES_DAYS_AFTER_CHECKOUT = Math.max(
  1,
  Number(process.env.SIMPLELOGIN_ALIAS_EXPIRES_DAYS_AFTER_CHECKOUT || 30),
);
export const ALIAS_FALLBACK_ACTIVE_DAYS = Math.max(
  ALIAS_EXPIRES_DAYS_AFTER_CHECKOUT,
  Number(process.env.SIMPLELOGIN_ALIAS_FALLBACK_ACTIVE_DAYS || 180),
);

export function parseAliasExpiryDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  if (!raw) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00.000Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addAliasDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

export function computeReservationAliasExpiresAt(
  buyIns: Array<{ checkOut?: unknown }>,
  fallbackBase: Date = new Date(),
): Date {
  const latestCheckout = buyIns.reduce<Date | null>((latest, buyIn) => {
    const parsed = parseAliasExpiryDate(buyIn.checkOut);
    if (!parsed) return latest;
    return !latest || parsed.getTime() > latest.getTime() ? parsed : latest;
  }, null);
  if (latestCheckout) return addAliasDays(latestCheckout, ALIAS_EXPIRES_DAYS_AFTER_CHECKOUT);
  return addAliasDays(fallbackBase, ALIAS_FALLBACK_ACTIVE_DAYS);
}

export async function ensureReservationAliasExpiresAt<
  T extends { id: number; expiresAt?: Date | string | null; createdAt?: Date | string | null },
>(alias: T, buyIns: Array<{ checkOut?: unknown }>): Promise<T> {
  const fallbackBase = parseAliasExpiryDate(alias.createdAt) ?? new Date();
  const expiresAt = computeReservationAliasExpiresAt(buyIns, fallbackBase);
  const current = parseAliasExpiryDate(alias.expiresAt);
  if (current && current.getTime() >= expiresAt.getTime() - 60_000) return alias;
  const [updated] = await db
    .update(reservationAliases)
    .set({ expiresAt, updatedAt: new Date() })
    .where(eq(reservationAliases.id, alias.id))
    .returning();
  return (updated ?? alias) as T;
}

export function reservationAliasIsExpired(alias: { expiresAt?: Date | string | null }): boolean {
  const expiresAt = parseAliasExpiryDate(alias.expiresAt);
  return !!expiresAt && expiresAt.getTime() < Date.now();
}

export async function getOrCreateReservationAlias(input: {
  reservationId: string;
  guestName?: string | null;
  buyIns?: Array<{ checkOut?: unknown }>;
  // When provided, the alias is scoped to this specific buy-in (unit), so a
  // combo booking can have a distinct alias per unit. Omitted = legacy
  // reservation-level lookup (matches the earliest existing alias row).
  buyInId?: number | null;
  unitLabel?: string | null;
}) {
  const hasBuyInId = typeof input.buyInId === "number" && Number.isFinite(input.buyInId);
  const existing = await db
    .select()
    .from(reservationAliases)
    .where(
      hasBuyInId
        ? and(
            eq(reservationAliases.reservationId, input.reservationId),
            eq(reservationAliases.buyInId, input.buyInId as number),
          )
        : eq(reservationAliases.reservationId, input.reservationId),
    )
    .limit(1);
  if (existing[0]) {
    const alias = await ensureReservationAliasExpiresAt(existing[0], input.buyIns ?? []);
    if (hasBuyInId) await backfillBuyInTravelerEmail(input.buyInId as number, alias.aliasEmail);
    return { alias, created: false };
  }

  // Unit-scoped aliases append the unit token to the prefix — two units on
  // ONE reservation share the guest+reservation base and SimpleLogin rejects
  // the second create with "alias ... already exists" (the Unit B failure the
  // operator hit 2026-07-05). Walk the candidate list, only continuing past a
  // prefix when SimpleLogin says it's taken.
  const prefixCandidates = aliasPrefixCandidates({
    guestName: input.guestName,
    reservationId: input.reservationId,
    unitLabel: hasBuyInId ? input.unitLabel : null,
    buyInId: hasBuyInId ? (input.buyInId as number) : null,
  });
  let payload: any = null;
  let lastAliasError: unknown = null;
  for (const prefix of prefixCandidates) {
    try {
      payload = await createSimpleLoginAlias({
        prefix,
        guestName: input.guestName,
        note: `Buy-in communication alias for Guesty reservation ${input.reservationId}${input.unitLabel ? ` — ${input.unitLabel}` : ""}`,
      });
      break;
    } catch (err) {
      lastAliasError = err;
      if (!isSimpleLoginAliasExistsError(err)) throw err;
    }
  }
  if (!payload) throw lastAliasError ?? new Error("SimpleLogin alias creation failed");
  const aliasEmail = extractSimpleLoginAliasEmail(payload);
  const simpleloginAliasId = extractSimpleLoginAliasId(payload);
  if (!aliasEmail) throw new Error("SimpleLogin did not return an alias email");

  const [alias] = await db
    .insert(reservationAliases)
    .values({
      reservationId: input.reservationId,
      buyInId: hasBuyInId ? (input.buyInId as number) : null,
      guestName: input.guestName ?? null,
      aliasEmail,
      simpleloginAliasId,
      mailboxEmail: SIMPLELOGIN_MAILBOX_EMAIL,
      expiresAt: computeReservationAliasExpiresAt(input.buyIns ?? []),
      rawPayload: JSON.stringify(payload),
    })
    .returning();
  if (hasBuyInId) await backfillBuyInTravelerEmail(input.buyInId as number, alias.aliasEmail);
  return { alias, created: true };
}

// The unit alias doubles as the VRBO traveler/booking email (unified 2026-07-19).
// Whenever a unit-scoped alias is minted or looked up, stamp it onto the buy-in's
// travelerEmail so booking confirmations key to the SAME address — but NEVER
// clobber an existing travelerEmail (a live VRBO booking may already use it;
// the shared-duplicate heal for unbooked units lives in
// ensureTravelerEmailForBuyIn, not here). Fail-soft: an alias mint must never
// fail because the buy-in stamp did.
async function backfillBuyInTravelerEmail(buyInId: number, aliasEmail: string): Promise<void> {
  try {
    const email = String(aliasEmail ?? "").trim().toLowerCase();
    if (!email) return;
    const buyIn = await storage.getBuyIn(buyInId);
    if (!buyIn) return;
    if (String(buyIn.travelerEmail ?? "").trim()) return;
    await storage.updateBuyIn(buyInId, { travelerEmail: email });
  } catch (err: any) {
    console.warn(`[reservation-alias] travelerEmail backfill failed for buy-in ${buyInId}:`, err?.message ?? err);
  }
}
