import {
  type User, type InsertUser,
  type BuyIn, type InsertBuyIn,
  type LodgifyBooking, type InsertLodgifyBooking,
  type ScannerRun, type InsertScannerRun,
  type AvailabilityScan, type InsertAvailabilityScan,
  type CommunityDraft, type InsertCommunityDraft,
  type LodgifyPropertyMap,
  type UnitSwap, type InsertUnitSwap,
  type GuestyPropertyMap, type InsertGuestyPropertyMap,
  type MessageTemplate, type InsertMessageTemplate,
  type AutoReplyLog, type InsertAutoReplyLog,
  type BookingConfirmation, type InsertBookingConfirmation,
  type PhotoLabel, type InsertPhotoLabel,
  type PhotoListingCheck, type InsertPhotoListingCheck,
  type PhotoListingAlert, type InsertPhotoListingAlert,
  type PhotoSync, type InsertPhotoSync,
  type PhotoSyncAudit, type InsertPhotoSyncAudit,
  type ScannerBlock, type InsertScannerBlock,
  type ScannerOverride, type InsertScannerOverride,
  type ScannerSchedule, type InsertScannerSchedule,
  type ScannerRunHistory, type InsertScannerRunHistory,
  users, buyIns, lodgifyBookings, scannerRuns, availabilityScans, communityDrafts, lodgifyPropertyMap, unitSwaps, guestyPropertyMap, messageTemplates, autoReplyLog, bookingConfirmations, photoLabels, photoListingChecks, photoListingAlerts, photoSync, photoSyncAudit, scannerBlocks, scannerOverrides, scannerSchedule, scannerRunHistory, propertyMarketRates,
  type PropertyMarketRate, type InsertPropertyMarketRate,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, gte, lte, lt, or, sql } from "drizzle-orm";

function listingUrlKey(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [
      "checkin",
      "checkout",
      "check_in",
      "check_out",
      "arrival",
      "departure",
      "startDate",
      "endDate",
      "adults",
      "group_adults",
    ]) {
      u.searchParams.delete(key);
    }
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return String(url).split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function normalizedIdentityText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericRentalTitle(title: string): boolean {
  const t = normalizedIdentityText(title);
  if (!t) return true;
  if (/^(?:condo|apartment|townhouse|home|house|villa|rental unit|guest suite|loft|cottage|bungalow|place)\s+in\s+[a-z ]+$/.test(t)) return true;
  if (/^(?:beautiful|lovely|spacious|modern|luxury|elegant)?\s*(?:\d+\s*(?:br|bedroom)\s*)?(?:condo|apartment|townhouse|home|house|villa|rental)$/.test(t)) return true;
  return false;
}

function titleFromBuyInNotes(notes: string | null | undefined): string {
  const raw = String(notes ?? "");
  const firstClause = raw.split(" · ")[0] ?? raw;
  const dash = firstClause.indexOf(" — ");
  if (dash >= 0) return firstClause.slice(dash + 3).trim();
  const bought = firstClause.match(/^Bought via .+? — (.+)$/i);
  return bought?.[1]?.trim() ?? "";
}

function urlsFromText(text: string | null | undefined): string[] {
  const raw = String(text ?? "");
  return [...raw.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0]);
}

function buyInIdentityKeys(row: Pick<BuyIn, "airbnbListingUrl" | "notes">): Set<string> {
  const keys = new Set<string>();
  const primaryKey = listingUrlKey(row.airbnbListingUrl);
  if (primaryKey) keys.add(`url:${primaryKey}`);
  for (const url of urlsFromText(row.notes)) {
    const key = listingUrlKey(url);
    if (key) keys.add(`url:${key}`);
  }
  const titleKey = normalizedIdentityText(titleFromBuyInNotes(row.notes));
  if (titleKey.length >= 12 && !isGenericRentalTitle(titleKey)) {
    keys.add(`title:${titleKey}`);
  }
  return keys;
}

function identitySetsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) {
    if (b.has(key)) return true;
  }
  return false;
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  createBuyIn(buyIn: InsertBuyIn): Promise<BuyIn>;
  getBuyIns(): Promise<BuyIn[]>;
  getBuyIn(id: number): Promise<BuyIn | undefined>;
  updateBuyIn(id: number, data: Partial<InsertBuyIn>): Promise<BuyIn | undefined>;
  deleteBuyIn(id: number): Promise<boolean>;
  // Per-unit-slot buy-in matching. Multi-unit properties need one buy-in per unit
  // so a single reservation can have multiple attached buy-ins (one per unitId).
  getBuyInCandidates(params: { propertyId: number; unitId: string; checkIn: string; checkOut: string }): Promise<BuyIn[]>;
  getBuyInsByReservation(reservationId: string): Promise<BuyIn[]>;
  attachBuyIn(buyInId: number, reservationId: string): Promise<BuyIn | undefined>;
  detachBuyIn(buyInId: number): Promise<BuyIn | undefined>;

  upsertLodgifyBooking(booking: InsertLodgifyBooking): Promise<LodgifyBooking>;
  getLodgifyBookings(): Promise<LodgifyBooking[]>;
  getLodgifyBooking(id: number): Promise<LodgifyBooking | undefined>;

  getMonthlyReport(year: number, month: number): Promise<{
    buyIns: BuyIn[];
    bookings: LodgifyBooking[];
  }>;

  getBookedUnits(checkIn: string, checkOut: string): Promise<{ propertyId: number; unitId: string; source: string }[]>;

  createScannerRun(run: InsertScannerRun): Promise<ScannerRun>;
  updateScannerRun(id: number, data: Partial<InsertScannerRun>): Promise<ScannerRun | undefined>;
  getScannerRuns(limit?: number): Promise<ScannerRun[]>;
  getLatestScannerRun(): Promise<ScannerRun | undefined>;
  cleanupStaleRuns(): Promise<number>;

  createAvailabilityScan(scan: InsertAvailabilityScan): Promise<AvailabilityScan>;
  getAvailabilityScans(filters?: { runId?: number; community?: string; status?: string }): Promise<AvailabilityScan[]>;
  deleteAvailabilityScansForRun(runId: number): Promise<void>;

  createCommunityDraft(draft: InsertCommunityDraft): Promise<CommunityDraft>;
  getCommunityDrafts(): Promise<CommunityDraft[]>;
  getCommunityDraft(id: number): Promise<CommunityDraft | undefined>;
  updateCommunityDraft(id: number, data: Partial<InsertCommunityDraft>): Promise<CommunityDraft | undefined>;
  deleteCommunityDraft(id: number): Promise<boolean>;

  upsertPropertyMarketRate(input: InsertPropertyMarketRate): Promise<PropertyMarketRate>;
  deletePropertyMarketRate(propertyId: number, bedrooms: number): Promise<void>;
  getPropertyMarketRates(propertyId: number): Promise<PropertyMarketRate[]>;
  getAllPropertyMarketRates(): Promise<PropertyMarketRate[]>;

  getLodgifyPropertyMap(): Promise<LodgifyPropertyMap[]>;
  upsertLodgifyPropertyId(propertyId: number, lodgifyPropertyId: string): Promise<LodgifyPropertyMap>;
  deleteLodgifyPropertyId(propertyId: number): Promise<boolean>;

  createUnitSwap(swap: InsertUnitSwap): Promise<UnitSwap>;
  getUnitSwaps(propertyId: number): Promise<UnitSwap[]>;
  getLatestUnitSwap(propertyId: number, unitId: string): Promise<UnitSwap | undefined>;
  deleteUnitSwap(id: number): Promise<boolean>;
  commitUnitSwaps(propertyId: number): Promise<void>;

  upsertGuestyPropertyMap(propertyId: number, guestyListingId: string): Promise<GuestyPropertyMap>;
  getGuestyPropertyMap(): Promise<GuestyPropertyMap[]>;
  getGuestyListingId(propertyId: number): Promise<string | null>;
  updateGuestyLastSynced(propertyId: number): Promise<void>;

  getMessageTemplates(): Promise<MessageTemplate[]>;
  getMessageTemplate(id: number): Promise<MessageTemplate | undefined>;
  createMessageTemplate(t: InsertMessageTemplate): Promise<MessageTemplate>;
  updateMessageTemplate(id: number, data: Partial<InsertMessageTemplate>): Promise<MessageTemplate | undefined>;
  deleteMessageTemplate(id: number): Promise<boolean>;

  createAutoReplyLog(log: InsertAutoReplyLog): Promise<AutoReplyLog>;
  getAutoReplyLogs(limit?: number): Promise<AutoReplyLog[]>;
  getAutoReplyLog(id: number): Promise<AutoReplyLog | undefined>;
  updateAutoReplyLog(id: number, data: Partial<InsertAutoReplyLog>): Promise<AutoReplyLog | undefined>;
  getAutoReplyLogByTriggerPostId(postId: string): Promise<AutoReplyLog | undefined>;

  createBookingConfirmation(b: InsertBookingConfirmation): Promise<BookingConfirmation>;
  getBookingConfirmationByReservationId(reservationId: string): Promise<BookingConfirmation | undefined>;
  getRecentBookingConfirmations(limit?: number): Promise<BookingConfirmation[]>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async createBuyIn(buyIn: InsertBuyIn): Promise<BuyIn> {
    const [result] = await db.insert(buyIns).values(buyIn).returning();
    return result;
  }

  async getBuyIns(): Promise<BuyIn[]> {
    return db.select().from(buyIns).orderBy(desc(buyIns.createdAt));
  }

  async getBuyIn(id: number): Promise<BuyIn | undefined> {
    const [result] = await db.select().from(buyIns).where(eq(buyIns.id, id));
    return result;
  }

  async updateBuyIn(id: number, data: Partial<InsertBuyIn>): Promise<BuyIn | undefined> {
    const [result] = await db.update(buyIns).set(data).where(eq(buyIns.id, id)).returning();
    return result;
  }

  async deleteBuyIn(id: number): Promise<boolean> {
    const result = await db.delete(buyIns).where(eq(buyIns.id, id)).returning();
    return result.length > 0;
  }

  async getBuyInCandidates(params: { propertyId: number; unitId: string; checkIn: string; checkOut: string }): Promise<BuyIn[]> {
    // A candidate must:
    //   1. Be for the same property AND unit slot (multi-unit properties need a buy-in per slot)
    //   2. Fully cover the booking window: buyIn.checkIn <= booking.checkIn AND buyIn.checkOut >= booking.checkOut
    //   3. Be status=active
    //   4. Not already be attached to any reservation
    //   5. Have a non-zero costPaid. Auto-fill creates buy-in records
    //      with costPaid=0 when it falls back to the unpriced-PM
    //      fallback (no priced bookable inventory found). Detaching
    //      unlinks the reservation but doesn't delete the record, so
    //      these orphan $0 rows accumulate across auto-fill runs and
    //      flood the picker. Filter them out — a $0 buy-in isn't a
    //      useful candidate to attach (the operator still needs to
    //      negotiate a price with the PM). Buy-ins with a real price
    //      that happen to be 0 (comp stays etc.) can be entered via
    //      the manual create flow at any cost > 0.
    const rows = await db
      .select()
      .from(buyIns)
      .where(
        and(
          eq(buyIns.propertyId, params.propertyId),
          eq(buyIns.unitId, params.unitId),
          lte(buyIns.checkIn, params.checkIn),
          gte(buyIns.checkOut, params.checkOut),
          eq(buyIns.status, "active"),
          sql`${buyIns.guestyReservationId} IS NULL`,
          sql`${buyIns.costPaid} > 0`,
        ),
      );
    return rows;
  }

  async getBuyInsByReservation(reservationId: string): Promise<BuyIn[]> {
    return db.select().from(buyIns).where(eq(buyIns.guestyReservationId, reservationId));
  }

  async attachBuyIn(buyInId: number, reservationId: string): Promise<BuyIn | undefined> {
    const existing = await this.getBuyIn(buyInId);
    if (!existing) return undefined;

    // Refuse if this buy-in is already attached to a *different* reservation.
    if (existing.guestyReservationId && existing.guestyReservationId !== reservationId) {
      throw new Error(`Buy-in ${buyInId} is already attached to reservation ${existing.guestyReservationId}`);
    }

    // Refuse if this reservation already has a buy-in attached for THIS same unit slot.
    const currentAttachments = await this.getBuyInsByReservation(reservationId);
    const sameSlot = currentAttachments.find(
      (b) => b.id !== buyInId && b.propertyId === existing.propertyId && b.unitId === existing.unitId,
    );
    if (sameSlot) {
      throw new Error(
        `Reservation ${reservationId} already has buy-in ${sameSlot.id} attached for unit "${existing.unitId}" — detach it first`,
      );
    }

    // Refuse if another slot in the same reservation already points to
    // the same physical listing. Multi-unit reservations need distinct
    // units; the identity set covers normalized URL, URL(s) embedded in
    // auto-fill notes (photo-match anchors), and specific non-generic
    // listing titles.
    const existingIdentity = buyInIdentityKeys(existing);
    if (existingIdentity.size > 0) {
      const sameListing = currentAttachments.find(
        (b) => b.id !== buyInId && identitySetsOverlap(buyInIdentityKeys(b), existingIdentity),
      );
      if (sameListing) {
        throw new Error(
          `Reservation ${reservationId} already has buy-in ${sameListing.id} attached for the same physical listing on unit "${sameListing.unitId}" — choose a different unit`,
        );
      }
    }

    const [row] = await db
      .update(buyIns)
      .set({ guestyReservationId: reservationId, attachedAt: new Date() })
      .where(eq(buyIns.id, buyInId))
      .returning();
    return row;
  }

  async detachBuyIn(buyInId: number): Promise<BuyIn | undefined> {
    const [row] = await db
      .update(buyIns)
      .set({ guestyReservationId: null, attachedAt: null })
      .where(eq(buyIns.id, buyInId))
      .returning();
    return row;
  }

  async upsertLodgifyBooking(booking: InsertLodgifyBooking): Promise<LodgifyBooking> {
    const [result] = await db
      .insert(lodgifyBookings)
      .values(booking)
      .onConflictDoUpdate({
        target: lodgifyBookings.lodgifyBookingId,
        set: {
          guestName: booking.guestName,
          guestEmail: booking.guestEmail,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          totalAmount: booking.totalAmount,
          source: booking.source,
          status: booking.status,
          nights: booking.nights,
          syncedAt: new Date(),
        },
      })
      .returning();
    return result;
  }

  async getLodgifyBookings(): Promise<LodgifyBooking[]> {
    return db.select().from(lodgifyBookings).orderBy(desc(lodgifyBookings.checkIn));
  }

  async getLodgifyBooking(id: number): Promise<LodgifyBooking | undefined> {
    const [result] = await db.select().from(lodgifyBookings).where(eq(lodgifyBookings.id, id));
    return result;
  }

  async getMonthlyReport(year: number, month: number): Promise<{
    buyIns: BuyIn[];
    bookings: LodgifyBooking[];
  }> {
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const monthBuyIns = await db
      .select()
      .from(buyIns)
      .where(and(gte(buyIns.checkIn, startDate), lte(buyIns.checkIn, endDate)));

    const monthBookings = await db
      .select()
      .from(lodgifyBookings)
      .where(and(gte(lodgifyBookings.checkIn, startDate), lte(lodgifyBookings.checkIn, endDate)));

    return { buyIns: monthBuyIns, bookings: monthBookings };
  }
  async getBookedUnits(checkIn: string, checkOut: string): Promise<{ propertyId: number; unitId: string; source: string }[]> {
    const bookedFromBuyIns = await db
      .select({ propertyId: buyIns.propertyId, unitId: buyIns.unitId })
      .from(buyIns)
      .where(
        and(
          lt(buyIns.checkIn, checkOut),
          sql`${buyIns.checkOut} > ${checkIn}`
        )
      );

    const bookedFromLodgify = await db
      .select({ propertyId: lodgifyBookings.propertyId, unitId: lodgifyBookings.unitId })
      .from(lodgifyBookings)
      .where(
        and(
          lt(lodgifyBookings.checkIn, checkOut),
          sql`${lodgifyBookings.checkOut} > ${checkIn}`
        )
      );

    const results: { propertyId: number; unitId: string; source: string }[] = [];
    for (const b of bookedFromBuyIns) {
      results.push({ propertyId: b.propertyId, unitId: b.unitId, source: "buy-in" });
    }
    for (const b of bookedFromLodgify) {
      if (b.propertyId !== null && b.unitId !== null) {
        results.push({ propertyId: b.propertyId, unitId: b.unitId, source: "lodgify" });
      }
    }
    return results;
  }

  async createScannerRun(run: InsertScannerRun): Promise<ScannerRun> {
    const [result] = await db.insert(scannerRuns).values(run).returning();
    return result;
  }

  async updateScannerRun(id: number, data: Partial<InsertScannerRun>): Promise<ScannerRun | undefined> {
    const [result] = await db.update(scannerRuns).set(data).where(eq(scannerRuns.id, id)).returning();
    return result;
  }

  async getScannerRuns(limit = 20): Promise<ScannerRun[]> {
    return db.select().from(scannerRuns).orderBy(desc(scannerRuns.startedAt)).limit(limit);
  }

  async getLatestScannerRun(): Promise<ScannerRun | undefined> {
    const [result] = await db.select().from(scannerRuns).orderBy(desc(scannerRuns.startedAt)).limit(1);
    return result;
  }

  async cleanupStaleRuns(): Promise<number> {
    const staleRuns = await db.update(scannerRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(scannerRuns.status, "running"))
      .returning();
    return staleRuns.length;
  }

  async createAvailabilityScan(scan: InsertAvailabilityScan): Promise<AvailabilityScan> {
    const [result] = await db.insert(availabilityScans).values(scan).returning();
    return result;
  }

  async getAvailabilityScans(filters?: { runId?: number; community?: string; status?: string }): Promise<AvailabilityScan[]> {
    const conditions = [];
    if (filters?.runId) conditions.push(eq(availabilityScans.runId, filters.runId));
    if (filters?.community) conditions.push(eq(availabilityScans.community, filters.community));
    if (filters?.status) conditions.push(eq(availabilityScans.status, filters.status));

    if (conditions.length > 0) {
      return db.select().from(availabilityScans).where(and(...conditions)).orderBy(availabilityScans.checkIn);
    }
    return db.select().from(availabilityScans).orderBy(desc(availabilityScans.createdAt)).limit(500);
  }

  async deleteAvailabilityScansForRun(runId: number): Promise<void> {
    await db.delete(availabilityScans).where(eq(availabilityScans.runId, runId));
  }

  async createCommunityDraft(draft: InsertCommunityDraft): Promise<CommunityDraft> {
    const [result] = await db.insert(communityDrafts).values(draft).returning();
    return result;
  }

  async getCommunityDrafts(): Promise<CommunityDraft[]> {
    return db.select().from(communityDrafts).orderBy(desc(communityDrafts.createdAt));
  }

  async getCommunityDraft(id: number): Promise<CommunityDraft | undefined> {
    const [result] = await db.select().from(communityDrafts).where(eq(communityDrafts.id, id));
    return result;
  }

  async updateCommunityDraft(id: number, data: Partial<InsertCommunityDraft>): Promise<CommunityDraft | undefined> {
    const [result] = await db.update(communityDrafts).set(data).where(eq(communityDrafts.id, id)).returning();
    return result;
  }

  async deleteCommunityDraft(id: number): Promise<boolean> {
    const result = await db.delete(communityDrafts).where(eq(communityDrafts.id, id)).returning();
    return result.length > 0;
  }

  // Per-property live market rates. One row per (propertyId, bedrooms)
  // pair — `upsertPropertyMarketRate` deletes any existing row for that
  // pair and re-inserts so callers don't need to track previous IDs.
  // Read paths return `PropertyMarketRate[]` ordered by bedrooms ASC so
  // a property with mixed-BR units gets a stable iteration order.
  async upsertPropertyMarketRate(input: InsertPropertyMarketRate): Promise<PropertyMarketRate> {
    await db
      .delete(propertyMarketRates)
      .where(and(
        eq(propertyMarketRates.propertyId, input.propertyId),
        eq(propertyMarketRates.bedrooms, input.bedrooms),
      ));
    const [row] = await db.insert(propertyMarketRates).values(input).returning();
    return row;
  }

  // PR #291: clear out stale rows when a refresh scan returns no
  // usable basis. Without this, a previous scan's bad data (e.g. the
  // booking-regex bug surfaced 2026-04-29 that persisted $67 for
  // Kaha Lani 3BR) sticks around forever — the route's upsert is
  // skipped when basis is null/0, so the bad row never gets
  // overwritten. Deleting on empty-scan lets the Pricing tab fall
  // through to BUY_IN_RATES static which is at least sane.
  async deletePropertyMarketRate(propertyId: number, bedrooms: number): Promise<void> {
    await db
      .delete(propertyMarketRates)
      .where(and(
        eq(propertyMarketRates.propertyId, propertyId),
        eq(propertyMarketRates.bedrooms, bedrooms),
      ));
  }

  async getPropertyMarketRates(propertyId: number): Promise<PropertyMarketRate[]> {
    return db
      .select()
      .from(propertyMarketRates)
      .where(eq(propertyMarketRates.propertyId, propertyId))
      .orderBy(propertyMarketRates.bedrooms);
  }

  async getAllPropertyMarketRates(): Promise<PropertyMarketRate[]> {
    return db
      .select()
      .from(propertyMarketRates)
      .orderBy(propertyMarketRates.propertyId, propertyMarketRates.bedrooms);
  }

  async getLodgifyPropertyMap(): Promise<LodgifyPropertyMap[]> {
    return db.select().from(lodgifyPropertyMap).orderBy(lodgifyPropertyMap.propertyId);
  }

  async upsertLodgifyPropertyId(propertyId: number, lodgifyPropertyId: string): Promise<LodgifyPropertyMap> {
    const [result] = await db
      .insert(lodgifyPropertyMap)
      .values({ propertyId, lodgifyPropertyId })
      .onConflictDoUpdate({
        target: lodgifyPropertyMap.propertyId,
        set: { lodgifyPropertyId, updatedAt: new Date() },
      })
      .returning();
    return result;
  }

  async deleteLodgifyPropertyId(propertyId: number): Promise<boolean> {
    const result = await db.delete(lodgifyPropertyMap).where(eq(lodgifyPropertyMap.propertyId, propertyId)).returning();
    return result.length > 0;
  }

  async createUnitSwap(swap: InsertUnitSwap): Promise<UnitSwap> {
    const [result] = await db.insert(unitSwaps).values(swap).returning();
    return result;
  }

  async getUnitSwaps(propertyId: number): Promise<UnitSwap[]> {
    return db.select().from(unitSwaps).where(eq(unitSwaps.propertyId, propertyId)).orderBy(desc(unitSwaps.createdAt));
  }

  async getLatestUnitSwap(propertyId: number, unitId: string): Promise<UnitSwap | undefined> {
    const [result] = await db
      .select()
      .from(unitSwaps)
      .where(and(eq(unitSwaps.propertyId, propertyId), eq(unitSwaps.oldUnitId, unitId)))
      .orderBy(desc(unitSwaps.createdAt))
      .limit(1);
    return result;
  }

  async deleteUnitSwap(id: number): Promise<boolean> {
    const result = await db.delete(unitSwaps).where(eq(unitSwaps.id, id)).returning();
    return result.length > 0;
  }

  async commitUnitSwaps(propertyId: number): Promise<void> {
    await db.update(unitSwaps).set({ committed: true }).where(eq(unitSwaps.propertyId, propertyId));
  }

  async upsertGuestyPropertyMap(propertyId: number, guestyListingId: string): Promise<GuestyPropertyMap> {
    const [result] = await db
      .insert(guestyPropertyMap)
      .values({ propertyId, guestyListingId })
      .onConflictDoUpdate({ target: guestyPropertyMap.propertyId, set: { guestyListingId, updatedAt: new Date() } })
      .returning();
    return result;
  }

  async getGuestyPropertyMap(): Promise<GuestyPropertyMap[]> {
    return db.select().from(guestyPropertyMap);
  }

  async getGuestyListingId(propertyId: number): Promise<string | null> {
    const [row] = await db.select().from(guestyPropertyMap).where(eq(guestyPropertyMap.propertyId, propertyId));
    return row?.guestyListingId ?? null;
  }

  async updateGuestyLastSynced(propertyId: number): Promise<void> {
    await db.update(guestyPropertyMap).set({ lastSyncedAt: new Date() }).where(eq(guestyPropertyMap.propertyId, propertyId));
  }

  async getMessageTemplates(): Promise<MessageTemplate[]> {
    return db.select().from(messageTemplates).orderBy(messageTemplates.createdAt);
  }

  async getMessageTemplate(id: number): Promise<MessageTemplate | undefined> {
    const [row] = await db.select().from(messageTemplates).where(eq(messageTemplates.id, id));
    return row;
  }

  async createMessageTemplate(t: InsertMessageTemplate): Promise<MessageTemplate> {
    const [row] = await db.insert(messageTemplates).values(t).returning();
    return row;
  }

  async updateMessageTemplate(id: number, data: Partial<InsertMessageTemplate>): Promise<MessageTemplate | undefined> {
    const [row] = await db.update(messageTemplates).set(data).where(eq(messageTemplates.id, id)).returning();
    return row;
  }

  async deleteMessageTemplate(id: number): Promise<boolean> {
    const result = await db.delete(messageTemplates).where(eq(messageTemplates.id, id)).returning();
    return result.length > 0;
  }

  async createAutoReplyLog(log: InsertAutoReplyLog): Promise<AutoReplyLog> {
    const [row] = await db.insert(autoReplyLog).values(log).returning();
    return row;
  }

  async getAutoReplyLogs(limit = 100): Promise<AutoReplyLog[]> {
    return db.select().from(autoReplyLog).orderBy(desc(autoReplyLog.createdAt)).limit(limit);
  }

  async getAutoReplyLog(id: number): Promise<AutoReplyLog | undefined> {
    const [row] = await db.select().from(autoReplyLog).where(eq(autoReplyLog.id, id));
    return row;
  }

  async updateAutoReplyLog(id: number, data: Partial<InsertAutoReplyLog>): Promise<AutoReplyLog | undefined> {
    const [row] = await db.update(autoReplyLog).set(data).where(eq(autoReplyLog.id, id)).returning();
    return row;
  }

  async getAutoReplyLogByTriggerPostId(postId: string): Promise<AutoReplyLog | undefined> {
    const [row] = await db.select().from(autoReplyLog).where(eq(autoReplyLog.triggerPostId, postId)).limit(1);
    return row;
  }

  // ── Booking confirmations ──
  // Insert is performed AFTER a successful Guesty send, so a failed
  // send leaves no row and gets retried on the next scheduler tick.
  // The unique constraint on `reservationId` (in shared/schema.ts) is
  // the safety net against rare double-sends — concurrent ticks both
  // calling insert hit the constraint and one of them throws.
  async createBookingConfirmation(b: InsertBookingConfirmation): Promise<BookingConfirmation> {
    const [row] = await db.insert(bookingConfirmations).values(b).returning();
    return row;
  }

  async getBookingConfirmationByReservationId(reservationId: string): Promise<BookingConfirmation | undefined> {
    const [row] = await db.select().from(bookingConfirmations).where(eq(bookingConfirmations.reservationId, reservationId)).limit(1);
    return row;
  }

  async getRecentBookingConfirmations(limit = 100): Promise<BookingConfirmation[]> {
    return db.select().from(bookingConfirmations).orderBy(desc(bookingConfirmations.sentAt)).limit(limit);
  }

  // ── Photo labels ──
  async upsertPhotoLabel(data: InsertPhotoLabel): Promise<PhotoLabel> {
    const existing = await db.select().from(photoLabels)
      .where(and(eq(photoLabels.folder, data.folder), eq(photoLabels.filename, data.filename)))
      .limit(1);
    if (existing.length > 0) {
      // Update ONLY the labeler-generated fields (label, category, confidence,
      // model). Preserve any existing user overrides (userLabel, userCategory,
      // hidden) — they were set by a human and shouldn't be wiped by a
      // rescrape or relabel operation.
      const [row] = await db.update(photoLabels)
        .set({
          label: data.label,
          category: data.category ?? null,
          confidence: data.confidence ?? null,
          model: data.model ?? null,
          generatedAt: new Date(),
        })
        .where(eq(photoLabels.id, existing[0].id))
        .returning();
      return row;
    }
    const [row] = await db.insert(photoLabels).values(data).returning();
    return row;
  }

  // Write a human override onto a single photo. Fields left undefined are
  // preserved. Pass null explicitly to clear an override.
  async updatePhotoLabelOverrides(
    folder: string,
    filename: string,
    patch: { userLabel?: string | null; userCategory?: string | null; hidden?: boolean },
  ): Promise<PhotoLabel | null> {
    const set: Record<string, unknown> = {};
    if ("userLabel" in patch) set.userLabel = patch.userLabel;
    if ("userCategory" in patch) set.userCategory = patch.userCategory;
    if ("hidden" in patch) set.hidden = patch.hidden;
    if (Object.keys(set).length === 0) return null;
    const [row] = await db.update(photoLabels)
      .set(set)
      .where(and(eq(photoLabels.folder, folder), eq(photoLabels.filename, filename)))
      .returning();
    return row ?? null;
  }

  async getPhotoLabelsByFolder(folder: string): Promise<PhotoLabel[]> {
    return db.select().from(photoLabels).where(eq(photoLabels.folder, folder));
  }

  async getAllPhotoLabels(): Promise<PhotoLabel[]> {
    return db.select().from(photoLabels);
  }

  async deletePhotoLabelsByFolder(folder: string): Promise<number> {
    const result = await db.delete(photoLabels).where(eq(photoLabels.folder, folder)).returning();
    return result.length;
  }

  // ── Scanner blocks ──
  async getActiveScannerBlocks(propertyId: number): Promise<ScannerBlock[]> {
    return db.select().from(scannerBlocks)
      .where(and(eq(scannerBlocks.propertyId, propertyId), sql`${scannerBlocks.removedAt} IS NULL`))
      .orderBy(scannerBlocks.startDate);
  }

  async createScannerBlock(data: InsertScannerBlock): Promise<ScannerBlock> {
    const [row] = await db.insert(scannerBlocks).values(data).returning();
    return row;
  }

  async markScannerBlockRemoved(id: number): Promise<void> {
    await db.update(scannerBlocks)
      .set({ removedAt: new Date() })
      .where(eq(scannerBlocks.id, id));
  }

  // ── Scanner overrides ──
  async getScannerOverrides(propertyId: number): Promise<ScannerOverride[]> {
    return db.select().from(scannerOverrides)
      .where(eq(scannerOverrides.propertyId, propertyId))
      .orderBy(scannerOverrides.startDate);
  }

  async upsertScannerOverride(data: InsertScannerOverride): Promise<ScannerOverride> {
    // One override per (propertyId, startDate). Replace existing.
    const existing = await db.select().from(scannerOverrides)
      .where(and(eq(scannerOverrides.propertyId, data.propertyId), eq(scannerOverrides.startDate, data.startDate)))
      .limit(1);
    if (existing.length > 0) {
      const [row] = await db.update(scannerOverrides)
        .set({ mode: data.mode, note: data.note ?? null, endDate: data.endDate })
        .where(eq(scannerOverrides.id, existing[0].id))
        .returning();
      return row;
    }
    const [row] = await db.insert(scannerOverrides).values(data).returning();
    return row;
  }

  async deleteScannerOverride(propertyId: number, startDate: string): Promise<boolean> {
    const result = await db.delete(scannerOverrides)
      .where(and(eq(scannerOverrides.propertyId, propertyId), eq(scannerOverrides.startDate, startDate)))
      .returning();
    return result.length > 0;
  }

  // ── Scanner schedule (Phase 4) ──
  async getScannerSchedules(): Promise<ScannerSchedule[]> {
    return db.select().from(scannerSchedule).orderBy(scannerSchedule.propertyId);
  }

  async getScannerSchedule(propertyId: number): Promise<ScannerSchedule | undefined> {
    const [row] = await db.select().from(scannerSchedule)
      .where(eq(scannerSchedule.propertyId, propertyId))
      .limit(1);
    return row;
  }

  async upsertScannerSchedule(data: InsertScannerSchedule): Promise<ScannerSchedule> {
    const existing = await this.getScannerSchedule(data.propertyId);
    if (existing) {
      const [row] = await db.update(scannerSchedule)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(scannerSchedule.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(scannerSchedule).values(data).returning();
    return row;
  }

  async markScannerScheduleRan(
    propertyId: number,
    status: "ok" | "error" | "skipped",
    summary: string,
  ): Promise<void> {
    await db.update(scannerSchedule)
      .set({ lastRunAt: new Date(), lastRunStatus: status, lastRunSummary: summary, updatedAt: new Date() })
      .where(eq(scannerSchedule.propertyId, propertyId));
  }

  // Append one row per scanner run (scheduled tick or manual "Run now").
  // `scannerSchedule.lastRunSummary` holds only the latest; this table
  // keeps the trail the UI renders as "Last N runs".
  async recordScannerRun(data: InsertScannerRunHistory): Promise<void> {
    await db.insert(scannerRunHistory).values(data);
  }

  async getRecentScannerRuns(propertyId: number, limit: number): Promise<ScannerRunHistory[]> {
    return db.select().from(scannerRunHistory)
      .where(eq(scannerRunHistory.propertyId, propertyId))
      .orderBy(desc(scannerRunHistory.ranAt))
      .limit(limit);
  }

  // ── Photo listing (reverse-image) checks ──
  async upsertPhotoListingCheck(data: InsertPhotoListingCheck): Promise<PhotoListingCheck> {
    const [row] = await db
      .insert(photoListingChecks)
      .values(data)
      .onConflictDoUpdate({
        target: photoListingChecks.photoFolder,
        set: {
          airbnbStatus: data.airbnbStatus,
          vrboStatus: data.vrboStatus,
          bookingStatus: data.bookingStatus,
          airbnbMatches: data.airbnbMatches ?? null,
          vrboMatches: data.vrboMatches ?? null,
          bookingMatches: data.bookingMatches ?? null,
          photosChecked: data.photosChecked ?? 0,
          lensCalls: data.lensCalls ?? 0,
          errorMessage: data.errorMessage ?? null,
          checkedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async getAllPhotoListingChecks(): Promise<PhotoListingCheck[]> {
    return db.select().from(photoListingChecks);
  }

  async getPhotoListingCheckByFolder(folder: string): Promise<PhotoListingCheck | undefined> {
    const [row] = await db.select().from(photoListingChecks).where(eq(photoListingChecks.photoFolder, folder));
    return row;
  }

  async createPhotoListingAlert(data: InsertPhotoListingAlert): Promise<PhotoListingAlert> {
    const [row] = await db.insert(photoListingAlerts).values(data).returning();
    return row;
  }

  async getUnacknowledgedPhotoListingAlerts(): Promise<PhotoListingAlert[]> {
    return db.select().from(photoListingAlerts)
      .where(sql`${photoListingAlerts.acknowledgedAt} IS NULL`)
      .orderBy(desc(photoListingAlerts.detectedAt));
  }

  async getPhotoListingAlertById(id: number): Promise<PhotoListingAlert | undefined> {
    const [row] = await db.select().from(photoListingAlerts).where(eq(photoListingAlerts.id, id));
    return row;
  }

  // Sets photo_labels.perceptual_hash for an existing row. No-op if the
  // row doesn't exist (folder/filename pair not yet labeled — caller
  // will catch up on the next labeler pass).
  async updatePhotoLabelHash(folder: string, filename: string, perceptualHash: string): Promise<void> {
    await db.update(photoLabels)
      .set({ perceptualHash })
      .where(and(eq(photoLabels.folder, folder), eq(photoLabels.filename, filename)));
  }

  // Sets photo_labels.channel_usage (JSON-encoded) for one row. Used
  // by the channel-photo-independence flow to record that a specific
  // photo is currently live on a particular channel.
  async updatePhotoLabelChannelUsage(folder: string, filename: string, channelUsage: string): Promise<void> {
    await db.update(photoLabels)
      .set({ channelUsage })
      .where(and(eq(photoLabels.folder, folder), eq(photoLabels.filename, filename)));
  }

  // ── Channel-photo-independence: photo_sync ──
  // One row per (guestyListingId, channel). Caller upserts: get existing
  // by listing+channel and either insert a new row or update in place.
  async getPhotoSync(guestyListingId: string, channel: string): Promise<PhotoSync | undefined> {
    const [row] = await db.select().from(photoSync)
      .where(and(eq(photoSync.guestyListingId, guestyListingId), eq(photoSync.channel, channel)));
    return row;
  }

  async getPhotoSyncByListing(guestyListingId: string): Promise<PhotoSync[]> {
    return db.select().from(photoSync).where(eq(photoSync.guestyListingId, guestyListingId));
  }

  async upsertPhotoSync(data: InsertPhotoSync): Promise<PhotoSync> {
    const existing = await this.getPhotoSync(data.guestyListingId, data.channel);
    if (existing) {
      const [row] = await db.update(photoSync)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(photoSync.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(photoSync).values(data).returning();
    return row;
  }

  // ── Channel-photo-independence: photo_sync_audit ──
  // Append-only. Caller passes the action ("isolate" | "re-enable" |
  // "replace" | "scan") and any structured details as a JSON blob.
  async createPhotoSyncAudit(data: InsertPhotoSyncAudit): Promise<PhotoSyncAudit> {
    const [row] = await db.insert(photoSyncAudit).values(data).returning();
    return row;
  }

  async getRecentPhotoSyncAudit(guestyListingId: string, limit = 100): Promise<PhotoSyncAudit[]> {
    return db.select().from(photoSyncAudit)
      .where(eq(photoSyncAudit.guestyListingId, guestyListingId))
      .orderBy(desc(photoSyncAudit.performedAt))
      .limit(limit);
  }

  async getRecentPhotoListingAlerts(limit: number): Promise<PhotoListingAlert[]> {
    return db.select().from(photoListingAlerts)
      .orderBy(desc(photoListingAlerts.detectedAt))
      .limit(limit);
  }

  async acknowledgePhotoListingAlert(id: number): Promise<PhotoListingAlert | undefined> {
    const [row] = await db.update(photoListingAlerts)
      .set({ acknowledgedAt: new Date() })
      .where(eq(photoListingAlerts.id, id))
      .returning();
    return row;
  }

  async getStalePhotoListingFolders(olderThanMs: number, knownFolders: string[]): Promise<string[]> {
    // Returns a list of folders that EITHER have no row yet OR were
    // last checked more than `olderThanMs` ago. Caller supplies the
    // `knownFolders` list (derived from unit-builder) so the scheduler
    // doesn't scan folders that no longer belong to any property.
    if (knownFolders.length === 0) return [];
    const rows = await db.select().from(photoListingChecks);
    const cutoff = new Date(Date.now() - olderThanMs);
    const fresh = new Set(
      rows.filter((r) => r.checkedAt && r.checkedAt > cutoff).map((r) => r.photoFolder),
    );
    return knownFolders.filter((f) => !fresh.has(f));
  }
}

export const storage = new DatabaseStorage();
