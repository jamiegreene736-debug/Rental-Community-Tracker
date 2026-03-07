import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, numeric, timestamp, serial, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const buyIns = pgTable("buy_ins", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  unitId: text("unit_id").notNull(),
  propertyName: text("property_name").notNull(),
  unitLabel: text("unit_label").notNull(),
  checkIn: date("check_in").notNull(),
  checkOut: date("check_out").notNull(),
  costPaid: numeric("cost_paid", { precision: 10, scale: 2 }).notNull(),
  airbnbConfirmation: text("airbnb_confirmation"),
  airbnbListingUrl: text("airbnb_listing_url"),
  notes: text("notes"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBuyInSchema = createInsertSchema(buyIns).omit({
  id: true,
  createdAt: true,
});

export type InsertBuyIn = z.infer<typeof insertBuyInSchema>;
export type BuyIn = typeof buyIns.$inferSelect;

export const lodgifyBookings = pgTable("lodgify_bookings", {
  id: serial("id").primaryKey(),
  lodgifyBookingId: integer("lodgify_booking_id").notNull().unique(),
  propertyId: integer("property_id"),
  unitId: text("unit_id"),
  lodgifyPropertyId: integer("lodgify_property_id"),
  lodgifyPropertyName: text("lodgify_property_name"),
  guestName: text("guest_name"),
  guestEmail: text("guest_email"),
  checkIn: date("check_in").notNull(),
  checkOut: date("check_out").notNull(),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }),
  source: text("source"),
  status: text("status"),
  currency: text("currency").default("USD"),
  nights: integer("nights"),
  syncedAt: timestamp("synced_at").defaultNow().notNull(),
});

export const insertLodgifyBookingSchema = createInsertSchema(lodgifyBookings).omit({
  id: true,
  syncedAt: true,
});

export type InsertLodgifyBooking = z.infer<typeof insertLodgifyBookingSchema>;
export type LodgifyBooking = typeof lodgifyBookings.$inferSelect;

export const scannerRuns = pgTable("scanner_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  totalWeeksScanned: integer("total_weeks_scanned").default(0),
  totalBlocked: integer("total_blocked").default(0),
  totalAvailable: integer("total_available").default(0),
  totalErrors: integer("total_errors").default(0),
  status: text("status").notNull().default("running"),
});

export const insertScannerRunSchema = createInsertSchema(scannerRuns).omit({
  id: true,
  startedAt: true,
});

export type InsertScannerRun = z.infer<typeof insertScannerRunSchema>;
export type ScannerRun = typeof scannerRuns.$inferSelect;

export const availabilityScans = pgTable("availability_scans", {
  id: serial("id").primaryKey(),
  runId: integer("run_id"),
  community: text("community").notNull(),
  checkIn: date("check_in").notNull(),
  checkOut: date("check_out").notNull(),
  bedroomConfig: text("bedroom_config").notNull(),
  airbnbResults: integer("airbnb_results").default(0),
  vrboResults: integer("vrbo_results").default(0),
  totalResults: integer("total_results").default(0),
  blocked: text("blocked").notNull().default("false"),
  lodgifyBlockIds: text("lodgify_block_ids"),
  status: text("status").notNull().default("available"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAvailabilityScanSchema = createInsertSchema(availabilityScans).omit({
  id: true,
  createdAt: true,
});

export type InsertAvailabilityScan = z.infer<typeof insertAvailabilityScanSchema>;
export type AvailabilityScan = typeof availabilityScans.$inferSelect;
