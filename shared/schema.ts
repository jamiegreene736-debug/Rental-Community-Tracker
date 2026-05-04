import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, numeric, timestamp, serial, date, boolean, doublePrecision } from "drizzle-orm/pg-core";
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
  unitAddress: text("unit_address"),
  accessCode: text("access_code"),
  wifiName: text("wifi_name"),
  wifiPassword: text("wifi_password"),
  parkingInfo: text("parking_info"),
  managementCompany: text("management_company"),
  managementContact: text("management_contact"),
  arrivalNotes: text("arrival_notes"),
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
  // Single complex-level street address. Most resort communities have
  // one canonical address shared across units; the preflight Platform
  // Check uses this (combined with the unit number) for text-search
  // matching. Nullable so existing drafts saved before this column
  // existed keep working — the adapter falls back to "city, state".
  streetAddress: text("street_address"),
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
  // Per-unit fields generated by Claude in Step 5 to mirror the
  // structure of unit-builder-data — bedding text ("King master,
  // Queen second, Twin third"), bathroom count, square footage,
  // and max guests. Stored as nullable text so the existing draft
  // shape (just title/description/strPermit) keeps working.
  unit1Bathrooms: text("unit1_bathrooms"),
  unit1Sqft: text("unit1_sqft"),
  unit1MaxGuests: integer("unit1_max_guests"),
  unit1Bedding: text("unit1_bedding"),
  unit1ShortDescription: text("unit1_short_description"),
  unit1LongDescription: text("unit1_long_description"),
  // Folder name under /app/client/public/photos/ holding the
  // downloaded photos for this unit. Persist-photos endpoint
  // creates these folders on save (draft-${id}-unit-a /
  // draft-${id}-unit-b) and writes the unit's selected photos
  // there. Builder-preflight reads these folders so promoted
  // drafts have photos in the builder UI just like the
  // hardcoded 11 properties do.
  unit1PhotoFolder: text("unit1_photo_folder"),
  unit2Url: text("unit2_url"),
  unit2Bedrooms: integer("unit2_bedrooms"),
  unit2Description: text("unit2_description"),
  unit2Bathrooms: text("unit2_bathrooms"),
  unit2Sqft: text("unit2_sqft"),
  unit2MaxGuests: integer("unit2_max_guests"),
  unit2Bedding: text("unit2_bedding"),
  unit2ShortDescription: text("unit2_short_description"),
  unit2LongDescription: text("unit2_long_description"),
  unit2PhotoFolder: text("unit2_photo_folder"),
  combinedBedrooms: integer("combined_bedrooms"),
  suggestedRate: integer("suggested_rate"),
  // Pricing area key (matches BUY_IN_RATES in shared/pricing-rates).
  // Set on Step 5 of the Add Community wizard (auto-suggested
  // from city/state, operator can override). Promoted drafts use
  // this for buy-in / quality calcs in the dashboard table; an
  // empty value falls through to the default per-bedroom rate
  // (270 × bedrooms) and the dashboard shows that approximation.
  pricingArea: text("pricing_area"),
  listingTitle: text("listing_title"),
  // Longer "OTA-channel" headline (e.g. for Booking.com which
  // tolerates 70-80 chars where Airbnb truncates at 50).
  bookingTitle: text("booking_title"),
  // Property type used by the Guesty / OTA listing builder
  // ("Condominium", "Townhouse", "House", "Villa", "Apartment",
  // "Estate", "Cottage", "Bungalow", "Loft").
  propertyType: text("property_type"),
  listingDescription: text("listing_description"),
  // Description tab fields that mirror the existing Listing Builder
  // (server/routes.ts → /api/builder/* descriptions push). Each is
  // a paragraph; the Listing Builder renders them as separate
  // sections ("The Neighborhood", "Getting Around").
  neighborhood: text("neighborhood"),
  transit: text("transit"),
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

// Per-(property, bedrooms) live nightly market rate from the buy-in
// finder. One row per (propertyId, bedrooms) pair — upserted on every
// refresh — so the Pricing tab can use a fresh "what does it cost to
// book a comparable unit on Airbnb/Vrbo/PM?" number as the cost basis
// instead of the static `BUY_IN_RATES` table alone.
//
// `propertyId` covers BOTH the static 11 hardcoded properties (positive
// integers from `unit-builder-data.ts`) and promoted drafts (negative
// `-draftId` keys, the same convention `home.tsx` and the builder use
// for drafts on the dashboard). One table for both — the Pricing tab
// only needs the (id, bedrooms) → median lookup, and the source of the
// id doesn't matter at read time.
//
// `source` is "airbnb" today (we query the SearchAPI Airbnb engine via
// `fetchAmortizedNightlyByBR`). Vrbo / PM-direct will populate the same
// column when those source-tagged rate paths land. Treating the field
// as free-text rather than an enum lets the schema stay forward-
// compatible without a migration.
export const propertyMarketRates = pgTable("property_market_rates", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  bedrooms: integer("bedrooms").notNull(),
  // Median amortized nightly across the engine sample (extracted_total_price
  // ÷ nights), per AGENTS.md Load-Bearing #31 — the priced 7-night-window
  // path. 10–15% accurate vs operator-validated buy-ins for Caribe Cove
  // / Southern Dunes today; expected to tighten as PM-direct scrapers
  // start tagging samples by source.
  //
  // `medianNightly` is the LOW-season basis (the legacy single value
  // every existing caller reads). The two seasonal columns below were
  // added in PR #282 and are populated by the multi-channel scan when
  // it samples HIGH and HOLIDAY windows on top of LOW. Nullable so
  // existing rows + sidecar-offline runs keep working with just the
  // LOW value + SEASON_MULTIPLIERS as the fallback.
  medianNightly: numeric("median_nightly", { precision: 10, scale: 2 }).notNull(),
  medianNightlyHigh: numeric("median_nightly_high", { precision: 10, scale: 2 }),
  medianNightlyHoliday: numeric("median_nightly_holiday", { precision: 10, scale: 2 }),
  lowNightly: numeric("low_nightly", { precision: 10, scale: 2 }),
  highNightly: numeric("high_nightly", { precision: 10, scale: 2 }),
  sampleCount: integer("sample_count").notNull().default(0),
  source: text("source").notNull().default("airbnb"),
  refreshedAt: timestamp("refreshed_at").defaultNow().notNull(),
});

export const insertPropertyMarketRateSchema = createInsertSchema(propertyMarketRates).omit({
  id: true,
  refreshedAt: true,
});

export type InsertPropertyMarketRate = z.infer<typeof insertPropertyMarketRateSchema>;
export type PropertyMarketRate = typeof propertyMarketRates.$inferSelect;

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

// ── Booking-confirmation auto-send dedup ──
// One row per reservation we've sent the auto-confirmation message to.
// The unique constraint on `reservationId` is what prevents the
// scheduler from double-sending: every tick re-checks the table before
// posting. Insert happens AFTER a successful Guesty send, so a failed
// send stays uninserted and gets retried next tick. Status field is
// "sent" for the success path; "error" rows are written for visibility
// when something other than the send itself fails (e.g. property lookup
// returned no match) but we still want a record so we don't keep
// retrying forever.
export const bookingConfirmations = pgTable("booking_confirmations", {
  id: serial("id").primaryKey(),
  reservationId: text("reservation_id").notNull().unique(),
  conversationId: text("conversation_id").notNull(),
  guestName: text("guest_name"),
  listingId: text("listing_id"),
  listingNickname: text("listing_nickname"),
  channel: text("channel"),
  messageBody: text("message_body").notNull(),
  status: text("status").notNull(), // "sent" | "error"
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});

export const insertBookingConfirmationSchema = createInsertSchema(bookingConfirmations).omit({
  id: true,
  sentAt: true,
});

export type InsertBookingConfirmation = z.infer<typeof insertBookingConfirmationSchema>;
export type BookingConfirmation = typeof bookingConfirmations.$inferSelect;

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

// ── Scanner-placed Guesty calendar blocks ──
// Records every block the inventory scanner pushes to Guesty so a later
// scan can REMOVE only the blocks WE placed when inventory recovers,
// without touching blocks placed by humans / other tools. The scanner
// re-runs nightly and uses this table to diff desired vs. actual blocks.
export const scannerBlocks = pgTable("scanner_blocks", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  guestyListingId: text("guesty_listing_id").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  guestyBlockId: text("guesty_block_id"),     // Guesty's id for the block we created
  reason: text("reason").notNull(),           // e.g. "low-inventory: 0 sets / 3 needed"
  source: text("source").notNull().default("nexstay-scanner"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // When set, the block was removed from Guesty (inventory recovered or
  // manual override). Kept for audit history.
  removedAt: timestamp("removed_at"),
});
export type ScannerBlock = typeof scannerBlocks.$inferSelect;
export type InsertScannerBlock = typeof scannerBlocks.$inferInsert;

// ── Per-window manual overrides ──
// Users can force a window to be open or blocked regardless of what the
// scanner found. One row per (propertyId, startDate); the scanner reads
// these before deciding to push/clear blocks.
export const scannerOverrides = pgTable("scanner_overrides", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  // "force-open" → never block this range; "force-block" → always block it
  mode: text("mode").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type ScannerOverride = typeof scannerOverrides.$inferSelect;
export type InsertScannerOverride = typeof scannerOverrides.$inferInsert;

// ── Per-listing scheduler rows (Phase 4) ──
// One row per Guesty-mapped property that the inventory scanner should
// keep refreshing on its own. The server-side tick reads this table
// every few minutes and kicks off jobs for whichever rows are past due.
export const scannerSchedule = pgTable("scanner_schedule", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  intervalHours: integer("interval_hours").notNull().default(12),
  // What the scheduled run should do. Flags so we can flip price-push
  // off while keeping inventory-check on (or vice versa).
  runInventory: boolean("run_inventory").notNull().default(true),
  runPricing: boolean("run_pricing").notNull().default(true),
  runSyncBlocks: boolean("run_sync_blocks").notNull().default(true),
  // User's target margin for the inventory-driven pricing push.
  targetMargin: numeric("target_margin", { precision: 5, scale: 4 }).notNull().default("0.2000"),
  // Minimum sets floor the run uses when deciding blocks.
  minSets: integer("min_sets").notNull().default(3),
  lastRunAt: timestamp("last_run_at"),
  lastRunStatus: text("last_run_status"),       // "ok" | "error" | null
  lastRunSummary: text("last_run_summary"),     // short message for the UI
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ScannerSchedule = typeof scannerSchedule.$inferSelect;
export type InsertScannerSchedule = typeof scannerSchedule.$inferInsert;

// ── Per-run history for the scheduler (Phase 4.1) ──
// One row per scanner run (scheduled tick OR manual "Run now"). The
// `scannerSchedule` row holds only the latest run; this table keeps the
// full trail so the UI can render "last N runs" without losing
// intermediate state every time the next run overwrites `lastRunAt`.
// Pruning is handled by `getRecentScannerRuns` (LIMIT N) — no TTL yet.
export const scannerRunHistory = pgTable("scanner_run_history", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  ranAt: timestamp("ran_at").defaultNow().notNull(),
  status: text("status").notNull(),          // "ok" | "error"
  summary: text("summary").notNull(),        // same format as scannerSchedule.lastRunSummary
  durationMs: integer("duration_ms"),        // optional — how long the run took
  trigger: text("trigger").notNull(),        // "scheduled" | "manual"
});
export type ScannerRunHistory = typeof scannerRunHistory.$inferSelect;
export type InsertScannerRunHistory = typeof scannerRunHistory.$inferInsert;

// ── Photo labels ──
// Claude-vision-generated captions for property photos. The static
// unit-builder-data.ts had hardcoded labels that drifted from reality
// (e.g. a photo labeled "Tennis Court" actually showed a rocky shoreline).
// This table replaces the hardcoded ones — the photo tab renders
// DB labels when present, falls back to the static label otherwise.
// Keyed by (folder, filename) — e.g. ("community-kaha-lani", "01-community.jpg").
export const photoLabels = pgTable("photo_labels", {
  id: serial("id").primaryKey(),
  folder: text("folder").notNull(),
  filename: text("filename").notNull(),
  label: text("label").notNull(),            // Claude's caption
  category: text("category"),                // Claude's category
  confidence: doublePrecision("confidence"), // 0.0-1.0 from labeler; null for legacy rows
  userLabel: text("user_label"),             // human override of caption — wins over `label`
  userCategory: text("user_category"),       // human override of category — wins over `category`
  hidden: boolean("hidden").default(false).notNull(), // user soft-delete — skipped on push-photos
  model: text("model"),                      // claude model used, for auditing
  // Perceptual hash (dHash, 64-bit → 16-char hex) computed by
  // server/photo-hashing.ts. Lets the photo-listing scanner detect
  // edited-photo theft (resized, recompressed, lightly cropped) and
  // lets the Replace & push orchestrator filter candidate photos that
  // are visually identical to the contaminated set. Nullable for
  // legacy rows; backfilled lazily on the first scanner tick that
  // touches the folder.
  perceptualHash: text("perceptual_hash"),
  // Per-channel usage state. JSON-encoded:
  //   { airbnb:  { active: bool, lastPushedAt: ISO },
  //     vrbo:    { active: bool, lastPushedAt: ISO },
  //     booking: { active: bool, lastPushedAt: ISO } }
  // `active=true` means this exact photo is currently in the channel's
  // live picture set. Used by the channel-photo-independence smart
  // selector to skip photos that already exist on the target channel.
  // Nullable; absent means "unknown / not tracked yet".
  channelUsage: text("channel_usage"),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
});
export type PhotoLabel = typeof photoLabels.$inferSelect;
export type InsertPhotoLabel = typeof photoLabels.$inferInsert;

// Reverse-image-search results per photo folder. One row per folder;
// upserted each time the scanner runs. The dashboard aggregates these
// rows by property (a single property may span multiple folders) when
// rendering the "Photo Match" column.
//
// status values: "clean" | "found" | "unknown" — same contract as the
// unit-replacement platform check.
//
// *_matches columns store an array of { photoUrl, listingUrl, title,
// source } objects — the photos of ours that matched, and the external
// listing URLs they were found on. Capped at 20 per platform to keep
// the column sane.
export const photoListingChecks = pgTable("photo_listing_checks", {
  id: serial("id").primaryKey(),
  photoFolder: text("photo_folder").notNull().unique(),
  airbnbStatus: text("airbnb_status").notNull().default("unknown"),
  vrboStatus: text("vrbo_status").notNull().default("unknown"),
  bookingStatus: text("booking_status").notNull().default("unknown"),
  airbnbMatches: text("airbnb_matches"),   // JSON-encoded array
  vrboMatches: text("vrbo_matches"),       // JSON-encoded array
  bookingMatches: text("booking_matches"), // JSON-encoded array
  photosChecked: integer("photos_checked").default(0).notNull(),
  lensCalls: integer("lens_calls").default(0).notNull(),
  errorMessage: text("error_message"),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});
export type PhotoListingCheck = typeof photoListingChecks.$inferSelect;
export type InsertPhotoListingCheck = typeof photoListingChecks.$inferInsert;

// State-change alerts derived from photo_listing_checks. One row per
// platform per transition (e.g. airbnb flipping from "clean" to
// "found"). Written by the scanner when it detects a status getting
// worse; dismissed by the operator via POST /api/photo-listing-alerts/
// :id/acknowledge.
//
// Rank of "worse": found > unknown > clean. Only transitions TO
// "found" are alert-worthy — `unknown` is routine (API hiccup) and
// `clean` is obviously fine. `found → clean` is silent (problem
// resolved) to avoid alert spam.
export const photoListingAlerts = pgTable("photo_listing_alerts", {
  id: serial("id").primaryKey(),
  photoFolder: text("photo_folder").notNull(),
  platform: text("platform").notNull(),            // "airbnb" | "vrbo" | "booking"
  priorStatus: text("prior_status").notNull(),     // "clean" | "unknown" | "found"
  newStatus: text("new_status").notNull(),         // always "found" today
  matchedUrls: text("matched_urls"),               // JSON-encoded array
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
  acknowledgedAt: timestamp("acknowledged_at"),
});
export type PhotoListingAlert = typeof photoListingAlerts.$inferSelect;
export type InsertPhotoListingAlert = typeof photoListingAlerts.$inferInsert;

// ── Channel Photo Independence ──
// Per-(listing, channel) sync state. When the operator isolates a
// channel for a listing, we flip status to "isolated" and capture
// the hashes of the photos that were live at isolation time
// ("previous_bad_hashes") so the daily scanner can detect re-theft
// (same hash reappearing) or cross-channel leak (same hash now
// active on a different channel). Re-enabling Master Sync sets
// status back to "synced" and clears previous_bad_hashes.
//
// One row per (guestyListingId, channel) — caller upserts.
export const photoSync = pgTable("photo_sync", {
  id: serial("id").primaryKey(),
  guestyListingId: text("guesty_listing_id").notNull(),
  channel: text("channel").notNull(),               // "airbnb" | "vrbo" | "booking"
  status: text("status").notNull().default("synced"), // "synced" | "isolated"
  isolatedAt: timestamp("isolated_at"),
  isolatedReason: text("isolated_reason"),
  previousBadHashes: text("previous_bad_hashes"),    // JSON array of dHash hex strings
  // Partner-portal listing reference — operator-supplied identifier the
  // sidecar uses to navigate to this property's edit page on the
  // channel's portal (VRBO partner-portal property id, Booking extranet
  // hotel id). Persisted so the operator only enters it once per
  // (listing, channel). Null until the first isolate-replace-disconnect
  // run records it.
  partnerListingRef: text("partner_listing_ref"),
  reEnabledAt: timestamp("re_enabled_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type PhotoSync = typeof photoSync.$inferSelect;
export type InsertPhotoSync = typeof photoSync.$inferInsert;

// Append-only audit of every photo-sync state change. Survives the
// status flip in photoSync — we want history even after re-enable.
//
// action values:
//   "isolate"   — channel flipped synced → isolated
//   "re-enable" — channel flipped isolated → synced
//   "replace"   — replacement photos pushed to an isolated channel
//   "scan"      — daily scanner ran and stored a hash snapshot
export const photoSyncAudit = pgTable("photo_sync_audit", {
  id: serial("id").primaryKey(),
  guestyListingId: text("guesty_listing_id").notNull(),
  channel: text("channel").notNull(),
  action: text("action").notNull(),
  reason: text("reason"),
  details: text("details"),                          // JSON; counts, hashes, etc.
  performedAt: timestamp("performed_at").defaultNow().notNull(),
});
export type PhotoSyncAudit = typeof photoSyncAudit.$inferSelect;
export type InsertPhotoSyncAudit = typeof photoSyncAudit.$inferInsert;
