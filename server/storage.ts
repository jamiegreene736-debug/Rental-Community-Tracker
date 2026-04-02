import {
  type User, type InsertUser,
  type BuyIn, type InsertBuyIn,
  type LodgifyBooking, type InsertLodgifyBooking,
  type ScannerRun, type InsertScannerRun,
  type AvailabilityScan, type InsertAvailabilityScan,
  type CommunityDraft, type InsertCommunityDraft,
  type LodgifyPropertyMap,
  users, buyIns, lodgifyBookings, scannerRuns, availabilityScans, communityDrafts, lodgifyPropertyMap,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, gte, lte, lt, or, sql } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  createBuyIn(buyIn: InsertBuyIn): Promise<BuyIn>;
  getBuyIns(): Promise<BuyIn[]>;
  getBuyIn(id: number): Promise<BuyIn | undefined>;
  updateBuyIn(id: number, data: Partial<InsertBuyIn>): Promise<BuyIn | undefined>;
  deleteBuyIn(id: number): Promise<boolean>;

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

  getLodgifyPropertyMap(): Promise<LodgifyPropertyMap[]>;
  upsertLodgifyPropertyId(propertyId: number, lodgifyPropertyId: string): Promise<LodgifyPropertyMap>;
  deleteLodgifyPropertyId(propertyId: number): Promise<boolean>;
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
}

export const storage = new DatabaseStorage();
