import {
  type User, type InsertUser,
  type BuyIn, type InsertBuyIn,
  type LodgifyBooking, type InsertLodgifyBooking,
  users, buyIns, lodgifyBookings,
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
}

export const storage = new DatabaseStorage();
