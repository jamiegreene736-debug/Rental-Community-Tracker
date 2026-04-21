import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, numeric, timestamp, serial, date, boolean } from "drizzle-orm/pg-core";
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
  guestyReservationId: text("guesty_reservation_id"),
  attachedAt: timestamp("attached_at"),
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
  propertyId: integer("property_id"),
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

export const communityDrafts = pgTable("community_drafts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  estimatedLowRate: integer("estimated_low_rate"),
  estimatedHighRate: integer("estimated_high_rate"),
  unitTypes: text("unit_types"),
  confidenceScore: integer("confidence_score"),
  researchSummary: text("research_summary"),
  sourceUrl: text("source_url"),
  status: text("status").notNull().default("researching"),
  unit1Url: text("unit1_url"),
  unit1Bedrooms: integer("unit1_bedrooms"),
  unit1Description: text("unit1_description"),
  unit2Url: text("unit2_url"),
  unit2Bedrooms: integer("unit2_bedrooms"),
  unit2Description: text("unit2_description"),
  combinedBedrooms: integer("combined_bedrooms"),
  suggestedRate: integer("suggested_rate"),
  listingTitle: text("listing_title"),
  listingDescription: text("listing_description"),
  strPermit: text("str_permit"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCommunityDraftSchema = createInsertSchema(communityDrafts).omit({
  id: true,
  createdAt: true,
});

export type InsertCommunityDraft = z.infer<typeof insertCommunityDraftSchema>;
export type CommunityDraft = typeof communityDrafts.$inferSelect;

export const unitSwaps = pgTable("unit_swaps", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  communityFolder: text("community_folder").notNull(),
  oldUnitId: text("old_unit_id").notNull(),
  oldUnitNumber: text("old_unit_number").notNull(),
  oldBedrooms: integer("old_bedrooms"),
  newAddress: text("new_address").notNull(),
  newUnitLabel: text("new_unit_label").notNull(),
  newBedrooms: integer("new_bedrooms"),
  newSourceUrl: text("new_source_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  committed: boolean("committed").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUnitSwapSchema = createInsertSchema(unitSwaps).omit({
  id: true,
  createdAt: true,
});

export type InsertUnitSwap = z.infer<typeof insertUnitSwapSchema>;
export type UnitSwap = typeof unitSwaps.$inferSelect;

export const lodgifyPropertyMap = pgTable("lodgify_property_map", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().unique(),
  lodgifyPropertyId: text("lodgify_property_id").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLodgifyPropertyMapSchema = createInsertSchema(lodgifyPropertyMap).omit({
  id: true,
  updatedAt: true,
});

export type InsertLodgifyPropertyMap = z.infer<typeof insertLodgifyPropertyMapSchema>;
export type LodgifyPropertyMap = typeof lodgifyPropertyMap.$inferSelect;

export const messageTemplates = pgTable("message_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  daysOffset: integer("days_offset").notNull().default(0),
  body: text("body").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMessageTemplateSchema = createInsertSchema(messageTemplates).omit({
  id: true,
  createdAt: true,
});

export type InsertMessageTemplate = z.infer<typeof insertMessageTemplateSchema>;
export type MessageTemplate = typeof messageTemplates.$inferSelect;

export const guestyPropertyMap = pgTable("guesty_property_map", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().unique(),
  guestyListingId: text("guesty_listing_id").notNull(),
  lastSyncedAt: timestamp("last_synced_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertGuestyPropertyMapSchema = createInsertSchema(guestyPropertyMap).omit({
  id: true,
  updatedAt: true,
});

export type InsertGuestyPropertyMap = z.infer<typeof insertGuestyPropertyMapSchema>;
export type GuestyPropertyMap = typeof guestyPropertyMap.$inferSelect;

// Audit log of every auto-reply attempt. One row per guest post the agent evaluates.
// status: "sent" (auto-sent to guest), "drafted" (draft saved, awaiting human review),
//         "flagged" (risky content — human must handle), "dismissed", "error"
export const autoReplyLog = pgTable("auto_reply_log", {
  id: serial("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  triggerPostId: text("trigger_post_id").notNull(),
  guestName: text("guest_name"),
  listingId: text("listing_id"),
  listingNickname: text("listing_nickname"),
  reservationId: text("reservation_id"),
  channel: text("channel"),            // airbnb2 | booking | homeaway2 | email | direct
  guestMessage: text("guest_message").notNull(),
  replyDraft: text("reply_draft"),     // what Claude generated (null on error)
  replySent: boolean("reply_sent").notNull().default(false),
  status: text("status").notNull(),    // sent | drafted | flagged | dismissed | error
  flagReason: text("flag_reason"),
  errorMessage: text("error_message"),
  toolsUsed: text("tools_used"),       // JSON-encoded list of { name, args } for audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAutoReplyLogSchema = createInsertSchema(autoReplyLog).omit({
  id: true,
  createdAt: true,
});

export type InsertAutoReplyLog = z.infer<typeof insertAutoReplyLogSchema>;
export type AutoReplyLog = typeof autoReplyLog.$inferSelect;

// ── Guesty OAuth token cache ──
// Guesty's token endpoint is rate-limited to ~5 requests per 24h. Storing
// the token here (rather than on a Railway-ephemeral filesystem) means
// server restarts don't chew through the quota. Single-row table, upserted.
export const guestyTokenCache = pgTable("guesty_token_cache", {
  id: serial("id").primaryKey(),
  token: text("token").notNull(),
  expiry: timestamp("expiry").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type GuestyTokenCache = typeof guestyTokenCache.$inferSelect;
