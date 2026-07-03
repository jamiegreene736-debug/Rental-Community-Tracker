import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, numeric, timestamp, serial, date, boolean, doublePrecision, jsonb } from "drizzle-orm/pg-core";
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
  groundFloorStatus: text("ground_floor_status").notNull().default("unknown"),
  groundFloorEvidence: text("ground_floor_evidence"),
  notes: text("notes"),
  status: text("status").notNull().default("active"),
  guestyReservationId: text("guesty_reservation_id"),
  attachedAt: timestamp("attached_at"),
  unitTypeConfidence: integer("unit_type_confidence"), // 0-100 from computeUnitTypeConfidence at search time
  unitTypeConfidenceBreakdown: jsonb("unit_type_confidence_breakdown"), // optional array of {layer, points, reason}
  // --- VRBO buy-in checkout lifecycle (server/buy-in-checkout-job.ts) ---
  // Tracks the actual PURCHASE of this unit on vrbo.com (distinct from
  // `status` active/cancelled and from `attachedAt` = when we internally
  // picked it). Doubles as the idempotency guard: a row at "booked" is
  // never re-driven through checkout. See memory buy-in-checkout-automation-plan.
  bookingStatus: text("booking_status").notNull().default("not_started"),
  // not_started | queued | in_progress | awaiting_payment | booked | failed
  bookingConfirmation: text("booking_confirmation"), // VRBO itinerary/confirmation number, set on confirmed purchase
  bookedAt: timestamp("booked_at"), // when the purchase actually completed on vrbo.com
  travelerEmail: text("traveler_email"), // the unique per-unit alias used as the VRBO traveler email
  bookingError: text("booking_error"), // last checkout failure/skip reason for operator diagnostics
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBuyInSchema = createInsertSchema(buyIns).omit({
  id: true,
  createdAt: true,
});

export type InsertBuyIn = z.infer<typeof insertBuyInSchema>;
export type BuyIn = typeof buyIns.$inferSelect;

export const sidecarSearchVariations = pgTable("sidecar_search_variations", {
  id: serial("id").primaryKey(),
  communityKey: text("community_key").notNull(),
  communityName: text("community_name").notNull(),
  city: text("city"),
  state: text("state"),
  channel: text("channel").notNull(),
  term: text("term").notNull(),
  source: text("source").notNull().default("operator"),
  preferred: boolean("preferred").notNull().default(false),
  timesTried: integer("times_tried").notNull().default(0),
  lastYieldCount: integer("last_yield_count").notNull().default(0),
  totalYieldCount: integer("total_yield_count").notNull().default(0),
  lastError: text("last_error"),
  lastSearchedAt: timestamp("last_searched_at"),
  lastSuccessAt: timestamp("last_success_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSidecarSearchVariationSchema = createInsertSchema(sidecarSearchVariations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSidecarSearchVariation = z.infer<typeof insertSidecarSearchVariationSchema>;
export type SidecarSearchVariation = typeof sidecarSearchVariations.$inferSelect;

export const workResourceLocks = pgTable("work_resource_locks", {
  resourceKey: text("resource_key").primaryKey(),
  ownerType: text("owner_type").notNull(),
  ownerId: text("owner_id").notNull(),
  ownerLabel: text("owner_label").notNull(),
  status: text("status").notNull().default("active"),
  acquiredAt: timestamp("acquired_at").defaultNow().notNull(),
  heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type WorkResourceLock = typeof workResourceLocks.$inferSelect;
export type InsertWorkResourceLock = typeof workResourceLocks.$inferInsert;

export const communityResearchSearches = pgTable("community_research_searches", {
  id: serial("id").primaryKey(),
  cityKey: text("city_key").notNull().unique(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  mode: text("mode").notNull().default("combo"),
  resultCount: integer("result_count").notNull().default(0),
  resultNames: jsonb("result_names").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  resultSummaries: jsonb("result_summaries").$type<Array<{
    name: string;
    confidenceScore: number | null;
    unitTypes: string | null;
    estimatedLowRate: number | null;
    estimatedHighRate: number | null;
  }>>().default(sql`'[]'::jsonb`).notNull(),
  error: text("error"),
  lastSearchedAt: timestamp("last_searched_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type CommunityResearchSearch = typeof communityResearchSearches.$inferSelect;
export type InsertCommunityResearchSearch = typeof communityResearchSearches.$inferInsert;

/** Cached top-market combo scan (6BR / 7–8BR potential per city seed). */
export const topMarketScanCache = pgTable("top_market_scan_cache", {
  marketKey: text("market_key").primaryKey(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  tag: text("tag"),
  fourBedroomPossible: boolean("four_bedroom_possible").notNull().default(false),
  fiveBedroomPossible: boolean("five_bedroom_possible").notNull().default(false),
  sixBedroomPossible: boolean("six_bedroom_possible").notNull().default(false),
  sevenEightBedroomPossible: boolean("seven_eight_bedroom_possible").notNull().default(false),
  qualifyingCount: integer("qualifying_count").notNull().default(0),
  communities: jsonb("communities").$type<unknown[]>().default(sql`'[]'::jsonb`).notNull(),
  error: text("error"),
  scannedAt: timestamp("scanned_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type TopMarketScanCache = typeof topMarketScanCache.$inferSelect;
export type InsertTopMarketScanCache = typeof topMarketScanCache.$inferInsert;

export const propertyBuyInMarkets = pgTable("property_buy_in_markets", {
  propertyId: integer("property_id").primaryKey(),
  baseCommunity: text("base_community").notNull(),
  recommendedMarkets: jsonb("recommended_markets").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  // Per-property unit-type confidence threshold for buy-in attach (default 85).
  // Used to enforce "correct unit" (bedroom + sub-community) before high-confidence attach.
  unitTypeConfidenceThreshold: integer("unit_type_confidence_threshold").default(85),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PropertyBuyInMarkets = typeof propertyBuyInMarkets.$inferSelect;
export type InsertPropertyBuyInMarkets = typeof propertyBuyInMarkets.$inferInsert;

export const reservationCancellationAudits = pgTable("reservation_cancellation_audits", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  guestyListingId: text("guesty_listing_id").notNull(),
  guestyReservationId: text("guesty_reservation_id").notNull(),
  guestName: text("guest_name"),
  status: text("status"),
  channel: text("channel"),
  confirmationCode: text("confirmation_code"),
  checkIn: date("check_in"),
  checkOut: date("check_out"),
  cancelledAt: timestamp("cancelled_at"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }),
  totalPaid: numeric("total_paid", { precision: 10, scale: 2 }),
  totalRefunded: numeric("total_refunded", { precision: 10, scale: 2 }),
  balanceDue: numeric("balance_due", { precision: 10, scale: 2 }),
  currency: text("currency").default("USD"),
  paymentsJson: text("payments_json"),
  refundsJson: text("refunds_json"),
  refundDecision: text("refund_decision").notNull().default("unknown"),
  operatorStatus: text("operator_status").notNull().default("needs_review"),
  operatorNotes: text("operator_notes"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReservationCancellationAuditSchema = createInsertSchema(reservationCancellationAudits).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReservationCancellationAudit = z.infer<typeof insertReservationCancellationAuditSchema>;
export type ReservationCancellationAudit = typeof reservationCancellationAudits.$inferSelect;

export const manualReservations = pgTable("manual_reservations", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  guestName: text("guest_name").notNull(),
  guestEmail: text("guest_email"),
  guestPhone: text("guest_phone"),
  checkIn: date("check_in").notNull(),
  checkOut: date("check_out").notNull(),
  totalRate: numeric("total_rate", { precision: 10, scale: 2 }).notNull(),
  notes: text("notes"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertManualReservationSchema = createInsertSchema(manualReservations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertManualReservation = z.infer<typeof insertManualReservationSchema>;
export type ManualReservation = typeof manualReservations.$inferSelect;

export const reservationAliases = pgTable("reservation_aliases", {
  id: serial("id").primaryKey(),
  reservationId: text("reservation_id").notNull(),
  // Per-unit: each attached buy-in (unit) gets its own alias. NULL = a legacy
  // reservation-level alias (pre per-unit). Uniqueness is (reservation_id, buy_in_id).
  buyInId: integer("buy_in_id"),
  guestName: text("guest_name"),
  aliasEmail: text("alias_email").notNull(),
  simpleloginAliasId: integer("simplelogin_alias_id"),
  mailboxEmail: text("mailbox_email").notNull(),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at"),
  rawPayload: text("raw_payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReservationAliasSchema = createInsertSchema(reservationAliases).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReservationAlias = z.infer<typeof insertReservationAliasSchema>;
export type ReservationAlias = typeof reservationAliases.$inferSelect;

export const buyInVendorContacts = pgTable("buy_in_vendor_contacts", {
  id: serial("id").primaryKey(),
  buyInId: integer("buy_in_id").notNull(),
  reservationId: text("reservation_id").notNull(),
  vendorName: text("vendor_name"),
  vendorEmail: text("vendor_email").notNull(),
  simpleloginContactId: integer("simplelogin_contact_id"),
  reverseAliasEmail: text("reverse_alias_email"),
  reverseAlias: text("reverse_alias"),
  status: text("status").notNull().default("active"),
  rawPayload: text("raw_payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertBuyInVendorContactSchema = createInsertSchema(buyInVendorContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBuyInVendorContact = z.infer<typeof insertBuyInVendorContactSchema>;
export type BuyInVendorContact = typeof buyInVendorContacts.$inferSelect;

export const buyInEmails = pgTable("buy_in_emails", {
  id: serial("id").primaryKey(),
  buyInId: integer("buy_in_id").notNull(),
  reservationId: text("reservation_id").notNull(),
  vendorContactId: integer("vendor_contact_id"),
  direction: text("direction").notNull(), // outbound | inbound
  fromEmail: text("from_email").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  attachmentsJson: text("attachments_json"),
  providerMessageId: text("provider_message_id"),
  rawPayload: text("raw_payload"),
  parsedArrivalDetails: text("parsed_arrival_details"),
  status: text("status").notNull().default("sent"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBuyInEmailSchema = createInsertSchema(buyInEmails).omit({
  id: true,
  createdAt: true,
});

export type InsertBuyInEmail = z.infer<typeof insertBuyInEmailSchema>;
export type BuyInEmail = typeof buyInEmails.$inferSelect;

// Per-guest booking inbox (operator, 2026-06-10): every message received at a
// guest's firstname.lastname@emailprivaccy.com booking address is stored here,
// keyed by aliasEmail, kept forever (independent of buy_in_emails, which is
// vendor/PM comms keyed by reservation). Populated by the inbound email webhook
// when a message is addressed to a guest booking alias.
export const guestInboxMessages = pgTable("guest_inbox_messages", {
  id: serial("id").primaryKey(),
  aliasEmail: text("alias_email").notNull(), // the guest address = the inbox key (lowercased)
  guestName: text("guest_name"),
  buyInId: integer("buy_in_id"), // best-effort attribution to the unit this address books
  reservationId: text("reservation_id"), // best-effort
  direction: text("direction").notNull().default("inbound"),
  fromEmail: text("from_email").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  attachmentsJson: text("attachments_json"),
  providerMessageId: text("provider_message_id"),
  rawPayload: text("raw_payload"),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGuestInboxMessageSchema = createInsertSchema(guestInboxMessages).omit({
  id: true,
  createdAt: true,
});

export type InsertGuestInboxMessage = z.infer<typeof insertGuestInboxMessageSchema>;
export type GuestInboxMessage = typeof guestInboxMessages.$inferSelect;

export const rentalAgreements = pgTable("rental_agreements", {
  id: serial("id").primaryKey(),
  token: text("token").notNull(),
  reservationId: text("reservation_id").notNull(),
  conversationId: text("conversation_id"),
  channel: text("channel").notNull(),
  guestName: text("guest_name").notNull(),
  guestEmail: text("guest_email"),
  guestPhone: text("guest_phone"),
  propertyName: text("property_name").notNull(),
  checkIn: date("check_in"),
  checkOut: date("check_out"),
  nights: integer("nights"),
  bookingTotal: numeric("booking_total", { precision: 10, scale: 2 }),
  confirmationCode: text("confirmation_code"),
  unitSummary: text("unit_summary"),
  cancellationPolicy: text("cancellation_policy"),
  agreementText: text("agreement_text").notNull(),
  status: text("status").notNull().default("pending"),
  signedName: text("signed_name"),
  signerEmail: text("signer_email"),
  signerPhone: text("signer_phone"),
  signerIp: text("signer_ip"),
  signerUserAgent: text("signer_user_agent"),
  signedAt: timestamp("signed_at"),
  rawPayload: text("raw_payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertRentalAgreementSchema = createInsertSchema(rentalAgreements).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRentalAgreement = z.infer<typeof insertRentalAgreementSchema>;
export type RentalAgreement = typeof rentalAgreements.$inferSelect;

export const lodgifyBookings = pgTable("lodgify_bookings", {
  id: serial("id").primaryKey(),
  lodgifyBookingId: integer("lodgify_booking_id").notNull(),
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
  // Geocoded coordinates for the complex/listing, populated lazily the first time
  // market-rate pricing runs for a NON-curated resort (AUTO-CURATION). Used to
  // build a center-radius Airbnb comp box so a resort with no hand-tuned
  // BUY_IN_MARKETS entry still gets a geo-scoped scan instead of a state-wide
  // raw-string search. Nullable — drafts saved before this column (or that fail
  // geocoding) keep working and fall back to the broad search. Stored as text to
  // match the numeric-as-text convention used elsewhere in this schema.
  latitude: text("latitude"),
  longitude: text("longitude"),
  estimatedLowRate: integer("estimated_low_rate"),
  estimatedHighRate: integer("estimated_high_rate"),
  estimatedTotalUnits: integer("estimated_total_units"),
  unitTypes: text("unit_types"),
  confidenceScore: integer("confidence_score"),
  researchSummary: text("research_summary"),
  sourceUrl: text("source_url"),
  // Community/resort-level minimum stay signal captured during
  // research. Null = unknown / not enough reliable evidence. 0 =
  // reliable source says there is no published community-wide
  // minimum. Positive integer = likely minimum nights imposed by
  // the resort/HOA/PM rule, not just one OTA listing's settings.
  minimumStayNights: integer("minimum_stay_nights"),
  minimumStayEvidence: text("minimum_stay_evidence"),
  minimumStaySourceUrl: text("minimum_stay_source_url"),
  status: text("status").notNull().default("researching"),
  unit1Url: text("unit1_url"),
  // Full per-unit address captured by the single-listing flow. This
  // intentionally keeps Unit/Apt/# suffixes that `streetAddress`
  // strips away for community grouping, because license lookups and
  // Airbnb/Guesty compliance checks need the exact unit address.
  unit1Address: text("unit1_address"),
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
  unit2Address: text("unit2_address"),
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
  // CODEX NOTE (2026-05-04, claude/single-listing): Single-listing flag.
  // When true, this draft is a STANDALONE condo/townhouse — only the
  // unit1_* fields are populated and unit2_* stay null. The dashboard
  // adapter (home.tsx → draftsAsProperties), the builder adapter
  // (client/src/data/adapt-draft.ts), and the listing-draft generator
  // all branch on this flag. Reusing community_drafts (rather than a
  // new table) keeps the builder, preflight, photo pipeline, and
  // Guesty publish path unchanged — they all already handle per-unit
  // data and just need to skip the missing unit2. Nullable so existing
  // drafts saved before this column existed keep working (treated as
  // false / combo listing).
  singleListing: boolean("single_listing"),
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
  taxMapKey: text("tax_map_key"),
  tatLicense: text("tat_license"),
  getLicense: text("get_license"),
  strPermit: text("str_permit"),
  dbprLicense: text("dbpr_license"),
  touristTaxAccount: text("tourist_tax_account"),
  // Server-owned queue idempotency. Bulk listing jobs send a stable key so a
  // retry can return the original dashboard draft instead of creating a
  // duplicate row after a timeout or deploy interruption.
  queueIdempotencyKey: text("queue_idempotency_key"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCommunityDraftSchema = createInsertSchema(communityDrafts).omit({
  id: true,
  createdAt: true,
});

export type InsertCommunityDraft = z.infer<typeof insertCommunityDraftSchema>;
export type CommunityDraft = typeof communityDrafts.$inferSelect;

export const comboPhotoFetchJobs = pgTable("combo_photo_fetch_jobs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("queued"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  currentIndex: integer("current_index").notNull().default(0),
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  cancelled: integer("cancelled").notNull().default(0),
  lockedBy: text("locked_by"),
  lockExpiresAt: timestamp("lock_expires_at"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const comboPhotoFetchJobItems = pgTable("combo_photo_fetch_job_items", {
  id: serial("id").primaryKey(),
  jobId: text("job_id").notNull(),
  itemKey: text("item_key").notNull(),
  label: text("label").notNull(),
  status: text("status").notNull().default("queued"),
  phase: text("phase").notNull().default("queued"),
  message: text("message").notNull().default("Queued"),
  payload: jsonb("payload"),
  unit1Photos: jsonb("unit1_photos"),
  unit2Photos: jsonb("unit2_photos"),
  unit1SourceUrl: text("unit1_source_url"),
  unit2SourceUrl: text("unit2_source_url"),
  error: text("error"),
  attemptCount: integer("attempt_count").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const bulkComboListingJobs = pgTable("bulk_combo_listing_jobs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("queued"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  currentIndex: integer("current_index").notNull().default(0),
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  cancelled: integer("cancelled").notNull().default(0),
  lockedBy: text("locked_by"),
  lockExpiresAt: timestamp("lock_expires_at"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const bulkComboListingJobItems = pgTable("bulk_combo_listing_job_items", {
  id: serial("id").primaryKey(),
  jobId: text("job_id").notNull(),
  itemKey: text("item_key").notNull(),
  label: text("label").notNull(),
  status: text("status").notNull().default("queued"),
  phase: text("phase").notNull().default("queued"),
  message: text("message").notNull().default("Queued"),
  payload: jsonb("payload"),
  draftId: integer("draft_id"),
  unit1Photos: jsonb("unit1_photos"),
  unit2Photos: jsonb("unit2_photos"),
  unit1SourceUrl: text("unit1_source_url"),
  unit2SourceUrl: text("unit2_source_url"),
  error: text("error"),
  attemptCount: integer("attempt_count").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at"),
  // Bedroom re-mix / photo-reuse tracking (sizes actually sourced + saved).
  effectiveUnit1Beds: integer("effective_unit1_beds"),
  effectiveUnit2Beds: integer("effective_unit2_beds"),
  remixApplied: boolean("remix_applied").notNull().default(false),
  unit2PhotosReused: boolean("unit2_photos_reused").notNull().default(false),
  // Count of worker restarts/interruptions that stopped this item mid-run (bounded
  // reprieve so a deploy mid-listing doesn't permanently drop a viable listing).
  interruptions: integer("interruptions").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type BulkComboListingJobRow = typeof bulkComboListingJobs.$inferSelect;
export type BulkComboListingJobItemRow = typeof bulkComboListingJobItems.$inferSelect;

export const communityPricingRefreshJobs = pgTable("community_pricing_refresh_jobs", {
  id: text("id").primaryKey(),
  draftId: integer("draft_id").notNull(),
  status: text("status").notNull().default("queued"),
  phase: text("phase").notNull().default("queued"),
  message: text("message").notNull().default("Queued market pricing refresh"),
  error: text("error"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lockedBy: text("locked_by"),
  lockExpiresAt: timestamp("lock_expires_at"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const queueJobEvents = pgTable("queue_job_events", {
  id: serial("id").primaryKey(),
  jobType: text("job_type").notNull(),
  jobId: text("job_id").notNull(),
  itemKey: text("item_key"),
  phase: text("phase").notNull(),
  level: text("level").notNull().default("info"),
  message: text("message").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const bulkPricingRefreshJobs = pgTable("bulk_pricing_refresh_jobs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("queued"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  currentIndex: integer("current_index").notNull().default(-1),
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  cancelled: integer("cancelled").notNull().default(0),
  dryRun: boolean("dry_run").notNull().default(false),
  lockedBy: text("locked_by"),
  lockExpiresAt: timestamp("lock_expires_at"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const bulkPricingRefreshJobItems = pgTable("bulk_pricing_refresh_job_items", {
  id: serial("id").primaryKey(),
  jobId: text("job_id").notNull(),
  itemKey: text("item_key").notNull(),
  propertyId: integer("property_id").notNull(),
  label: text("label").notNull(),
  status: text("status").notNull().default("queued"),
  progress: jsonb("progress"),
  error: text("error"),
  attemptCount: integer("attempt_count").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ComboPhotoFetchJobRow = typeof comboPhotoFetchJobs.$inferSelect;
export type ComboPhotoFetchJobItemRow = typeof comboPhotoFetchJobItems.$inferSelect;
export type CommunityPricingRefreshJobRow = typeof communityPricingRefreshJobs.$inferSelect;

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
// book a comparable unit on Airbnb/Vrbo/Booking.com?" number as the cost basis
// instead of the static `BUY_IN_RATES` table alone.
//
// `propertyId` covers BOTH the static 11 hardcoded properties (positive
// integers from `unit-builder-data.ts`) and promoted drafts (negative
// `-draftId` keys, the same convention `home.tsx` and the builder use
// for drafts on the dashboard). One table for both — the Pricing tab
// only needs the (id, bedrooms) → median lookup, and the source of the
// id doesn't matter at read time.
//
// `source` is free text because the pricing basis can be Airbnb-only
// or an OTA median across Airbnb, VRBO, and Booking.com sidecar samples.
export const propertyMarketRates = pgTable("property_market_rates", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  bedrooms: integer("bedrooms").notNull(),
  // Median amortized nightly across the engine sample (extracted_total_price
  // ÷ nights), per AGENTS.md Load-Bearing #31 — the priced monthly-row window
  // path. 10–15% accurate vs operator-validated buy-ins for Southern Dunes
  // today; direct/PM sites are intentionally excluded
  // from market pricing.
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
  monthlyRates: jsonb("monthly_rates").$type<Record<string, {
    medianNightly: number;
    season?: "LOW" | "HIGH" | "HOLIDAY";
    checkIn?: string;
    checkOut?: string;
    channelCount?: number;
    sampleCount?: number;
    demandClass?: "standard" | "high" | "peak" | "ultra";
    seasonTierId?: string;
    seasonTierLabel?: string;
    channels?: { airbnb?: number | null; vrbo?: number | null; booking?: number | null; pm?: number | null };
    hybrid?: {
      baseAirbnbMedian?: number;
      finalRate?: number;
      layers?: Array<Record<string, unknown>>;
      notes?: string[];
    };
    // Per-month research confidence + evidence written by the hybrid market-rate
    // scan (server/hybrid-pricing.ts recordPricedMonth). Structural subset of
    // MarketRateConfidence / MarketRateEvidence — the source-of-truth shapes live
    // in hybrid-pricing.ts; shared/ cannot import server types. Surfaced by the
    // research-confirmation UI (resort + geo radius + per-bedroom confidence).
    confidence?: {
      score?: number;
      level?: "green" | "yellow" | "red";
      sampleCount?: number;
      acceptedCandidates?: number;
      rejectedCandidates?: number;
      exactBedroomCandidates?: number;
      communityMatchedCandidates?: number;
      geoVerifiedCandidates?: number;
    };
    evidence?: {
      query?: string;
      geoConstraint?: {
        kind?: "curated-bounds" | "center-radius" | "none";
        description?: string;
        radiusMiles?: number | null;
        widened?: boolean;
      };
    };
  }>>().default(sql`'{}'::jsonb`).notNull(),
  lowNightly: numeric("low_nightly", { precision: 10, scale: 2 }),
  highNightly: numeric("high_nightly", { precision: 10, scale: 2 }),
  sampleCount: integer("sample_count").notNull().default(0),
  source: text("source").notNull().default("airbnb"),
  // Claude-generated STATIC seasonal rate plan (server/static-rate-engine.ts).
  // Present when `source = "claude-static"`: the 6 seasonal anchors per bedroom
  // (LOW/HIGH/HOLIDAY × year1/year2), operator lock flags, the static prior, and
  // Claude's reasoning/confidence/metrics. Nullable so legacy airbnb-scan rows
  // keep working. Structural mirror of StaticRatePlan in shared/static-rate-logic.ts
  // (shared/ can't import server types).
  staticPlan: jsonb("static_plan").$type<{
    generatedAt: string;
    model: string;
    source: "claude-static" | "static-fallback";
    summary: string;
    communityConfirmation?: {
      community: string;
      searchLabel: string;
      expectedCity?: string;
      expectedState?: string;
      nameMatch: boolean;
      cityMatch: boolean;
      stateMatch: boolean;
      locationMatch: boolean;
      curated: boolean;
      claudeConfirmed?: boolean;
      verifiedResort?: string;
      confirmed: boolean;
      detail: string;
    };
    bedrooms: Array<{
      bedrooms: number;
      anchors: { year1: { LOW: number; HIGH: number; HOLIDAY: number }; year2: { LOW: number; HIGH: number; HOLIDAY: number } };
      locks: { year1?: { LOW?: boolean; HIGH?: boolean; HOLIDAY?: boolean }; year2?: { LOW?: boolean; HIGH?: boolean; HOLIDAY?: boolean } };
      staticBasis: { LOW: number; HIGH: number; HOLIDAY: number };
      confidence: number;
      reasoning: string;
      metricsUsed: string[];
      // ── ALL-IN (taxes + fees) provenance — optional; absent on legacy rows.
      // Mirror of the optional fields on StaticRateBedroomPlan in
      // shared/static-rate-logic.ts (kept in sync by hand).
      allInBasis?: { LOW: number; HIGH: number; HOLIDAY: number };
      evidence?: Array<{
        season: "LOW" | "HIGH" | "HOLIDAY";
        year: 1 | 2;
        channel: "pm" | "resort" | "vrbo" | "booking" | "airbnb" | "other";
        sourceUrl?: string;
        stayNights: number;
        rentNightly: number;
        cleaningPerStay: number | null;
        serviceFeePct: number | null;
        feesObserved: boolean;
        allInNightly: number;
        feeBasis: "all-in-observed" | "grossed-up";
      }>;
      reconciliation?: Array<{
        season: "LOW" | "HIGH" | "HOLIDAY";
        year: 1 | 2;
        chosen: number;
        channel: "pm" | "resort" | "vrbo" | "booking" | "airbnb" | "other" | null;
        rule: string;
        spread: { min: number; median: number; max: number; n: number };
        dropped: string[];
      }>;
      clampedSeasons?: string[];
      cleaningPerNight?: number;
    }>;
  }>(),
  refreshedAt: timestamp("refreshed_at").defaultNow().notNull(),
});

export const insertPropertyMarketRateSchema = createInsertSchema(propertyMarketRates).omit({
  id: true,
  refreshedAt: true,
});

export type InsertPropertyMarketRate = z.infer<typeof insertPropertyMarketRateSchema>;
export type PropertyMarketRate = typeof propertyMarketRates.$inferSelect;

export const pricingUpdateLogs = pgTable("pricing_update_logs", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  propertyName: text("property_name").notNull(),
  bedrooms: integer("bedrooms").notNull(),
  triggerType: text("trigger_type").notNull(),
  oldRate: numeric("old_rate", { precision: 10, scale: 2 }),
  newRate: numeric("new_rate", { precision: 10, scale: 2 }),
  layersJson: jsonb("layers_json").$type<Array<Record<string, unknown>>>().default(sql`'[]'::jsonb`).notNull(),
  calendarJson: jsonb("calendar_json").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  status: text("status").notNull().default("ok"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPricingUpdateLogSchema = createInsertSchema(pricingUpdateLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertPricingUpdateLog = z.infer<typeof insertPricingUpdateLogSchema>;
export type PricingUpdateLog = typeof pricingUpdateLogs.$inferSelect;

export const lodgifyPropertyMap = pgTable("lodgify_property_map", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
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
  deliveryChannel: text("delivery_channel").notNull().default("guesty"),
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
  propertyId: integer("property_id").notNull(),
  guestyListingId: text("guesty_listing_id").notNull(),
  lastSyncedAt: timestamp("last_synced_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const builderBookingRules = pgTable("builder_booking_rules", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  guestyListingId: text("guesty_listing_id").notNull(),
  minNights: integer("min_nights").notNull().default(3),
  maxNights: integer("max_nights").notNull().default(365),
  advanceNotice: integer("advance_notice").notNull().default(7),
  preparationTime: integer("preparation_time").notNull().default(1),
  instantBooking: boolean("instant_booking").notNull().default(true),
  cancellationPolicies: jsonb("cancellation_policies").$type<{
    airbnb?: string;
    vrbo?: string;
    booking?: string;
  }>().default(sql`'{}'::jsonb`).notNull(),
  lastPushedAt: timestamp("last_pushed_at"),
  lastPushStatus: text("last_push_status"),
  lastPushSummary: text("last_push_summary"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type BuilderBookingRules = typeof builderBookingRules.$inferSelect;
export type InsertBuilderBookingRules = typeof builderBookingRules.$inferInsert;

/** Builder-pulled compliance values for hardcoded (positive) propertyIds. */
export const propertyComplianceOverrides = pgTable("property_compliance_overrides", {
  propertyId: integer("property_id").primaryKey(),
  taxMapKey: text("tax_map_key"),
  tatLicense: text("tat_license"),
  getLicense: text("get_license"),
  strPermit: text("str_permit"),
  dbprLicense: text("dbpr_license"),
  touristTaxAccount: text("tourist_tax_account"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertGuestyPropertyMapSchema = createInsertSchema(guestyPropertyMap).omit({
  id: true,
  updatedAt: true,
});

export type InsertGuestyPropertyMap = z.infer<typeof insertGuestyPropertyMapSchema>;
export type GuestyPropertyMap = typeof guestyPropertyMap.$inferSelect;

// Audit log of every auto-reply attempt. One row per guest post the agent evaluates.
// status: "sent" (sent to guest — human-clicked OR auto-sent, see autoSent),
//         "queued" (clean draft waiting out the auto-send review window),
//         "drafted" (draft saved, awaiting human review),
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
  status: text("status").notNull(),    // sent | queued | drafted | flagged | dismissed | error
  flagReason: text("flag_reason"),
  errorMessage: text("error_message"),
  toolsUsed: text("tools_used"),       // JSON-encoded list of { name, args } for audit
  // Auto-send (Part B). autoSent distinguishes a machine send from a human
  // "Send" click; sendAfter is the review-window deadline for a "queued" row —
  // the send pass only sends rows whose sendAfter <= now (and still uncontested).
  autoSent: boolean("auto_sent").notNull().default(false),
  sendAfter: timestamp("send_after"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const autoReplyStyleExamples = pgTable("auto_reply_style_examples", {
  id: serial("id").primaryKey(),
  autoReplyLogId: integer("auto_reply_log_id"),
  guestMessage: text("guest_message").notNull(),
  originalDraft: text("original_draft"),
  editedDraft: text("edited_draft").notNull(),
  analysis: text("analysis").notNull(),
  listingId: text("listing_id"),
  channel: text("channel"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAutoReplyLogSchema = createInsertSchema(autoReplyLog).omit({
  id: true,
  createdAt: true,
});

export const insertAutoReplyStyleExampleSchema = createInsertSchema(autoReplyStyleExamples).omit({
  id: true,
  createdAt: true,
});

export type InsertAutoReplyLog = z.infer<typeof insertAutoReplyLogSchema>;
export type AutoReplyLog = typeof autoReplyLog.$inferSelect;
export type InsertAutoReplyStyleExample = z.infer<typeof insertAutoReplyStyleExampleSchema>;
export type AutoReplyStyleExample = typeof autoReplyStyleExamples.$inferSelect;

// ── Platform AI assistant (dashboard chat agent) ──
// Conversational front-door to the whole platform. One row per chat thread in
// `assistant_sessions`; every turn (operator message, assistant reply, and the
// tool calls/results in between) is persisted in `assistant_messages` so the
// operator gets durable scrollback AND an audit trail of what the agent did.
// `content` is a JSON blob: { text?, toolCalls?: [{name,input}], toolResults?:
// [{name,output}] }. See server/assistant/* for the agent loop + tool registry.
export const assistantSessions = pgTable("assistant_sessions", {
  id: serial("id").primaryKey(),
  title: text("title").notNull().default("New chat"),
  createdBy: text("created_by").notNull().default("admin"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
});

export const assistantMessages = pgTable("assistant_messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  role: text("role").notNull(), // user | assistant | tool
  content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AssistantSession = typeof assistantSessions.$inferSelect;
export type AssistantMessage = typeof assistantMessages.$inferSelect;

// Tiny persisted key-value store for operator-controlled toggles that must
// survive restarts (the auto-send master toggle / review window). Value is a
// JSON-encoded string. Read via storage.getSetting / written via setSetting.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type AppSetting = typeof appSettings.$inferSelect;

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
  reservationId: text("reservation_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  guestName: text("guest_name"),
  listingId: text("listing_id"),
  listingNickname: text("listing_nickname"),
  channel: text("channel"),
  messageBody: text("message_body").notNull(),
  status: text("status").notNull(), // "sent" (delivery confirmed) | "pending" (posted, delivery not confirmed) | "misroute" (filed off the guest's OTA channel) | "error"
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});

export const insertBookingConfirmationSchema = createInsertSchema(bookingConfirmations).omit({
  id: true,
  sentAt: true,
});

export type InsertBookingConfirmation = z.infer<typeof insertBookingConfirmationSchema>;
export type BookingConfirmation = typeof bookingConfirmations.$inferSelect;

// ── Guest-facing "alternative stay" / relocation pages ──
// Durable store for the tokenized /alternatives/:token pages so the guest links
// survive deploys (the legacy tmp/booking-alternatives copy is ephemeral on
// Railway's filesystem) AND so we can track whether the guest opened the link.
// openCount/firstOpenedAt/lastOpenedAt are incremented only for unauthenticated
// (guest) GETs of the page — operator previews carry the admin session and are
// not counted (see GET /alternatives/:token).
export const bookingAlternativePages = pgTable("booking_alternative_pages", {
  token: varchar("token", { length: 64 }).primaryKey(),
  reservationId: text("reservation_id"),
  channel: text("channel"),                  // booking channel: airbnb | booking | vrbo | manual | other
  guestName: text("guest_name"),
  checkIn: text("check_in"),
  checkOut: text("check_out"),
  payload: jsonb("payload").notNull(),       // full render payload (same shape as the legacy tmp JSON)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  messageSentAt: timestamp("message_sent_at"),
  messageChannel: text("message_channel"),
  firstOpenedAt: timestamp("first_opened_at"),
  lastOpenedAt: timestamp("last_opened_at"),
  openCount: integer("open_count").default(0).notNull(),
});
export type BookingAlternativePage = typeof bookingAlternativePages.$inferSelect;

// ── Guest payment / refund receipts (auto-sent) ──
// One row per money transaction we sent the guest a receipt for. The row is
// BOTH the dedup ledger (`dedupKey` is UNIQUE, so a given charge/refund is
// messaged exactly once) AND the durable receipt-page store (the tokenized
// /receipt/:token page the message links to). Lifecycle:
//   status "pending"  -> row + token created, message not yet posted
//   status "sent"     -> Guesty message posted (messageSentAt stamped)
//   status "error"    -> post failed; retried on the next scheduler tick
// The auto-send scheduler is server/guest-receipts.ts. openCount /
// firstOpenedAt / lastOpenedAt are incremented only for UNAUTHENTICATED (guest)
// opens of the page — operator previews carry the admin session and are not
// counted (see GET /receipt/:token), mirroring booking_alternative_pages.
export const guestReceipts = pgTable("guest_receipts", {
  id: serial("id").primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),   // /receipt/:token durable page
  dedupKey: text("dedup_key").notNull().unique(),               // reservationId|kind|day|amount
  reservationId: text("reservation_id").notNull(),
  conversationId: text("conversation_id"),
  kind: text("kind").notNull(),                                 // "payment" | "refund"
  amount: numeric("amount", { precision: 10, scale: 2 }),       // positive USD (refunds stored as the absolute value)
  currency: text("currency"),
  transactionDate: text("transaction_date"),                    // ISO timestamp of the charge/refund
  guestName: text("guest_name"),
  listingId: text("listing_id"),
  listingNickname: text("listing_nickname"),
  channel: text("channel"),                                     // resolved send channel: bookingCom | airbnb2 | homeaway | email
  messageBody: text("message_body").notNull(),
  payload: jsonb("payload").notNull(),                          // render data for the /receipt page
  status: text("status").notNull().default("pending"),         // "pending" (not yet sent) | "sent" (delivery confirmed) | "unconfirmed" (posted, delivery not confirmed) | "misroute" (filed off the guest's OTA channel) | "error" (send threw)
  errorMessage: text("error_message"),
  // REFUND-only SMS leg (Quo/OpenPhone text to the guest's phone on file):
  // null (not attempted / n/a) | "sent" | "error" | "no-phone" | "not-configured"
  smsStatus: text("sms_status"),
  smsTo: text("sms_to"),
  smsError: text("sms_error"),
  smsSentAt: timestamp("sms_sent_at"),
  expiresAt: timestamp("expires_at"),
  messageSentAt: timestamp("message_sent_at"),
  firstOpenedAt: timestamp("first_opened_at"),
  lastOpenedAt: timestamp("last_opened_at"),
  openCount: integer("open_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertGuestReceiptSchema = createInsertSchema(guestReceipts).omit({
  id: true,
  createdAt: true,
});
export type InsertGuestReceipt = z.infer<typeof insertGuestReceiptSchema>;
export type GuestReceipt = typeof guestReceipts.$inferSelect;

// Per-property TRAILING-365-DAY revenue, refreshed once daily by the
// property-revenue scheduler (server/property-revenue-scheduler.ts) and read by
// the dashboard "Total Revenue" column (GET /api/dashboard/property-revenue).
// Keyed by the dashboard property id — i.e. the enriched reservation's
// `operationsPropertyId`: a POSITIVE core property id (PROPERTY_UNIT_CONFIGS),
// or a NEGATIVE -draftId for a published community draft mapped to a Guesty
// listing in guesty_property_map. Properties with no connected listing (or no
// stays whose check-in falls in the window) simply have NO row → the column
// renders "—". The scheduler WHOLESALE-REPLACES this table each run (delete-all
// + insert in one txn) so a property whose bookings have aged out drops to
// absent rather than keeping a stale figure.
export const propertyTrailingRevenue = pgTable("property_trailing_revenue", {
  propertyId: integer("property_id").primaryKey(),
  revenue: numeric("revenue", { precision: 12, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("USD"),
  bookings: integer("bookings").notNull().default(0),
  windowDays: integer("window_days").notNull().default(365),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
});
export type PropertyTrailingRevenue = typeof propertyTrailingRevenue.$inferSelect;
export type InsertPropertyTrailingRevenue = typeof propertyTrailingRevenue.$inferInsert;

// Durable per-reservation "over-budget combos" the auto-fill search found but did
// not attach (would have lost money). Persisted so the operator can review the
// options + one-click attach a loss combo even after the in-memory job expires
// (2h) or a redeploy wipes it. Upserted by reservationId on every auto-fill
// finalize — always the LATEST search. comboOptions holds the attachable loss
// combos (AutoFillComboOption[] with isLoss), cityEconomics the per-city ledger.
export const autoFillLossOptions = pgTable("auto_fill_loss_options", {
  reservationId: text("reservation_id").primaryKey(),
  propertyId: integer("property_id"),
  status: text("status"),
  slotsTotal: integer("slots_total"),
  slotsFilled: integer("slots_filled"),
  comboOptions: jsonb("combo_options"),
  cityEconomics: jsonb("city_economics"),
  finishedAt: timestamp("finished_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Durable terminal diagnostics (2026-06-10): the job's final message (the rich
  // "No profitable combination found … best option loses $X … coverage" line) and
  // error used to live ONLY in the in-memory job, so every redeploy erased the
  // WHY of a finished search — the operator saw bare loss cards with no
  // explanation. startedAt + status="running" written at job START make a scan
  // that a deploy/restart killed mid-run DETECTABLE: a "running" row with no
  // live in-memory job is surfaced as status "interrupted" by
  // /api/operations/auto-fill/last and rendered as an error in the scan panel.
  doneMessage: text("done_message"),
  error: text("error"),
  startedAt: timestamp("started_at"),
  // Deploy-survival (2026-06-10): the full StartAutoFillInput persisted at job
  // start so a search killed by a redeploy can be RESUMED on the next boot
  // (server/auto-fill-resume.ts) instead of dying silently. jobId is preserved
  // across the resume so an open client poller keeps working; owner
  // ("row"/"bulk") lets the boot resume skip bulk-owned rows (the bulk queue
  // resumes those itself); resumeAttempts caps restart loops (a job that keeps
  // killing the server must not resurrect forever).
  request: jsonb("request"),
  jobId: text("job_id"),
  owner: text("owner"),
  resumeAttempts: integer("resume_attempts").default(0),
});
export type AutoFillLossOptions = typeof autoFillLossOptions.$inferSelect;

// Durable snapshot of the (single) bulk buy-in queue so a Railway redeploy
// mid-queue RESUMES instead of dying silently (deploys land every ~10 min from
// concurrent sessions — observed killing a live queue 2026-06-10). The whole
// BulkJob (incl. each item's self-contained _input) serializes to jsonb; resume
// rebuilds it under the SAME id (open dialogs keep polling), re-queues the item
// that was mid-flight, and skips already-terminal items. One queue at a time —
// upsert prunes other rows.
export const bulkAutoFillState = pgTable("bulk_auto_fill_state", {
  id: text("id").primaryKey(),
  status: text("status"),
  state: jsonb("state"),
  resumeAttempts: integer("resume_attempts").default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type BulkAutoFillState = typeof bulkAutoFillState.$inferSelect;

// Internal "we told the guest we're cancelling" flag, keyed by reservation.
// Set when the operator clicks "Send cancellation notice" on the Operations
// tab — it sends a guest message through the booking channel and records that
// it went out. It deliberately does NOT cancel the Guesty reservation; it's a
// notification + an internal marker so the row shows a durable "sent" badge.
export const cancellationNotices = pgTable("cancellation_notices", {
  reservationId: text("reservation_id").primaryKey(),
  channel: text("channel"),
  message: text("message"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});
export type CancellationNotice = typeof cancellationNotices.$inferSelect;

// ── Quo / OpenPhone SMS messages mirrored into the Guesty inbox ──
// Guesty remains the reservation + conversation source of truth. These rows
// store SMS messages sent/received through the 808 Quo number and attach them
// to a Guesty conversation when we can match the guest phone number.
export const quoSmsMessages = pgTable("quo_sms_messages", {
  id: serial("id").primaryKey(),
  providerMessageId: text("provider_message_id").notNull(),
  conversationId: text("conversation_id"),
  reservationId: text("reservation_id"),
  guestName: text("guest_name"),
  guestPhone: text("guest_phone").notNull(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  direction: text("direction").notNull(), // inbound | outbound
  body: text("body").notNull(),
  status: text("status"),
  rawPayload: text("raw_payload"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertQuoSmsMessageSchema = createInsertSchema(quoSmsMessages).omit({
  id: true,
  createdAt: true,
});

export type InsertQuoSmsMessage = z.infer<typeof insertQuoSmsMessageSchema>;
export type QuoSmsMessage = typeof quoSmsMessages.$inferSelect;

export const quoCallEvents = pgTable("quo_call_events", {
  id: serial("id").primaryKey(),
  providerCallId: text("provider_call_id").notNull(),
  conversationId: text("conversation_id"),
  reservationId: text("reservation_id"),
  guestName: text("guest_name"),
  guestPhone: text("guest_phone").notNull(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  direction: text("direction").notNull(), // inbound | outbound
  status: text("status"),
  disposition: text("disposition").notNull().default("unknown"), // answered | missed | voicemail | unknown
  durationSeconds: integer("duration_seconds"),
  matchStrategy: text("match_strategy"),
  matchConfidence: text("match_confidence"),
  voicemailId: text("voicemail_id"),
  voicemailStatus: text("voicemail_status"),
  voicemailRecordingUrl: text("voicemail_recording_url"),
  voicemailTranscript: text("voicemail_transcript"),
  voicemailDurationSeconds: integer("voicemail_duration_seconds"),
  rawPayload: text("raw_payload"),
  callStartedAt: timestamp("call_started_at"),
  callCompletedAt: timestamp("call_completed_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertQuoCallEventSchema = createInsertSchema(quoCallEvents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertQuoCallEvent = z.infer<typeof insertQuoCallEventSchema>;
export type QuoCallEvent = typeof quoCallEvents.$inferSelect;

export const guestInboxInternalNotes = pgTable("guest_inbox_internal_notes", {
  id: serial("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  reservationId: text("reservation_id"),
  guestName: text("guest_name"),
  guestPhone: text("guest_phone"),
  note: text("note").notNull(),
  source: text("source").notNull().default("manual"),
  createdBy: text("created_by").notNull().default("agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGuestInboxInternalNoteSchema = createInsertSchema(guestInboxInternalNotes).omit({
  id: true,
  createdAt: true,
});

export type InsertGuestInboxInternalNote = z.infer<typeof insertGuestInboxInternalNoteSchema>;
export type GuestInboxInternalNote = typeof guestInboxInternalNotes.$inferSelect;

export const guestPhoneOverrides = pgTable("guest_phone_overrides", {
  id: serial("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  reservationId: text("reservation_id"),
  guestName: text("guest_name"),
  phone: text("phone").notNull(),
  sourcePhone: text("source_phone"),
  preArrivalFormUrl: text("pre_arrival_form_url"),
  paymentUrl: text("payment_url"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGuestPhoneOverrideSchema = createInsertSchema(guestPhoneOverrides).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertGuestPhoneOverride = z.infer<typeof insertGuestPhoneOverrideSchema>;
export type GuestPhoneOverride = typeof guestPhoneOverrides.$inferSelect;

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

// ── Legacy scanner-placed Guesty calendar blocks ──
// Records every block the inventory scanner pushed to Guesty so cleanup can
// REMOVE only the blocks WE placed, without touching blocks placed by humans
// or other tools.
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

// ── Sourceability gate per-window confirmation state ──
// The sourceability gate (server/sourceability-gate.ts) only blocks/unblocks a
// Guesty window after the SAME decision repeats across N CONSECUTIVE sweeps, so
// a single flaky/partial VRBO scrape can't false-block (or false-unblock) a
// window — we observed the same week read −$8,664 then +$5,045 minutes apart.
// This persists the consecutive-decision streaks per (property, window) so the
// confirmation survives redeploys (in-memory would reset every deploy).
export const sourceabilityObservations = pgTable("sourceability_observations", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  consecutiveBlocks: integer("consecutive_blocks").notNull().default(0),
  consecutiveOpens: integer("consecutive_opens").notNull().default(0),
  lastDecision: text("last_decision"),            // "block" | "open" | "skip"
  lastCheapestCost: numeric("last_cheapest_cost", { precision: 10, scale: 2 }),
  lastSellableRevenue: numeric("last_sellable_revenue", { precision: 10, scale: 2 }),
  lastReason: text("last_reason"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type SourceabilityObservation = typeof sourceabilityObservations.$inferSelect;
export type InsertSourceabilityObservation = typeof sourceabilityObservations.$inferInsert;

// ── Per-window manual overrides ──
// Users can force a window to be normal-priced or critical-priced regardless
// of the policy result. One row per (propertyId, startDate).
export const scannerOverrides = pgTable("scanner_overrides", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  // "force-open" → normal pricing; "force-block" → critical scarcity pricing.
  mode: text("mode").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type ScannerOverride = typeof scannerOverrides.$inferSelect;
export type InsertScannerOverride = typeof scannerOverrides.$inferInsert;

// ── Per-listing scheduler rows (Phase 4) ──
// One row per Guesty-mapped property that the availability pricing scheduler
// should keep refreshing on its own. The server-side tick reads this table
// every few minutes and runs due rows once per Eastern day after 1 AM.
export const scannerSchedule = pgTable("scanner_schedule", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  intervalHours: integer("interval_hours").notNull().default(12),
  // What the scheduled run should do. Flags so we can flip price-push
  // off while keeping inventory-check on (or vice versa).
  runInventory: boolean("run_inventory").notNull().default(true),
  runPricing: boolean("run_pricing").notNull().default(true),
  runSyncBlocks: boolean("run_sync_blocks").notNull().default(false),
  // User's target margin for the pricing push. Default 20% (MARKET_RATE_TARGET_MARGIN).
  // NOTE: the server market-rate pushes (bulk queue + weekly scan) apply the flat
  // MARKET_RATE_TARGET_MARGIN constant and no longer read this column, so a legacy
  // 0.2000 here no longer forces a 20% push. Kept for the builder UI / future use.
  targetMargin: numeric("target_margin", { precision: 5, scale: 4 }).notNull().default("0.1500"),
  // Minimum sets floor the run uses when deciding blocks.
  minSets: integer("min_sets").notNull().default(3),
  // Scarcity markups layered on policy windows instead of blacking them out.
  tightMarkup: numeric("tight_markup", { precision: 5, scale: 4 }).notNull().default("0.1200"),
  criticalMarkup: numeric("critical_markup", { precision: 5, scale: 4 }).notNull().default("0.4000"),
  // Per-property lead-time safety policy (pure calendar pricing, independent of inventory).
  // These drive the automatic "45/75/90/120 days out" critical price bands.
  standardLeadDays: integer("standard_lead_days").notNull().default(45),
  highSeasonLeadDays: integer("high_season_lead_days").notNull().default(75),
  majorHolidayLeadDays: integer("major_holiday_lead_days").notNull().default(90),
  ultraPeakLeadDays: integer("ultra_peak_lead_days").notNull().default(120),
  lastRunAt: timestamp("last_run_at"),
  lastRunStatus: text("last_run_status"),       // "ok" | "error" | null
  lastRunSummary: text("last_run_summary"),     // short message for the UI
  // Separate from scan completion: this records when the pricing plan was
  // actually written to Guesty's calendar, so a fresh market scan and a
  // fresh Guesty push can be audited independently.
  lastGuestyRatePushAt: timestamp("last_guesty_rate_push_at"),
  lastGuestyRatePushStatus: text("last_guesty_rate_push_status"),
  lastGuestyRatePushSummary: text("last_guesty_rate_push_summary"),
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
  // Operator-defined display/push order WITHIN a folder (a unit gallery or the
  // community gallery), set by the Photos-tab drag-to-reorder. Null = no manual
  // order → the tab falls back to the hero-first category default
  // (shared/photo-order.ts). When the operator drags photos around, every photo
  // in that folder gets an explicit index here and the manual order wins. The
  // across-gallery order (Unit A → Unit B → … → Community) is fixed by the
  // builder assembly, not by this column.
  sortOrder: integer("sort_order"),
  model: text("model"),                      // claude model used, for auditing
  // Perceptual hash (dHash, 64-bit → 16-char hex) computed by
  // server/photo-hashing.ts. Lets the photo-listing scanner detect
  // edited-photo theft (resized, recompressed, lightly cropped) and
  // lets the Replace & push orchestrator filter candidate photos that
  // are visually identical to the contaminated set. Nullable for
  // legacy rows; backfilled lazily on the first scanner tick that
  // touches the folder.
  perceptualHash: text("perceptual_hash"),
  /** Precomputed bedroom cluster within folder (e.g. room-1) — set at ingest. */
  bedroomClusterId: text("bedroom_cluster_id"),
  /** Detected bed type for bedroom cluster representative (King Bed, etc.). */
  bedroomBedType: text("bedroom_bed_type"),
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
  photoFolder: text("photo_folder").notNull(),
  airbnbStatus: text("airbnb_status").notNull().default("unknown"),
  vrboStatus: text("vrbo_status").notNull().default("unknown"),
  bookingStatus: text("booking_status").notNull().default("unknown"),
  airbnbMatches: text("airbnb_matches"),   // JSON-encoded array
  vrboMatches: text("vrbo_matches"),       // JSON-encoded array
  bookingMatches: text("booking_matches"), // JSON-encoded array
  // Address-on-OTA leg (complements the photo reverse-image leg above).
  // "clean" | "found" | "unknown" per platform — found means the unit's
  // street address surfaced on a real Airbnb/VRBO/Booking listing page
  // (unit-number gated, our own authorized URLs suppressed). addressMatches
  // is a JSON array of { platform, url, title, snippet }.
  airbnbAddressStatus: text("airbnb_address_status").notNull().default("unknown"),
  vrboAddressStatus: text("vrbo_address_status").notNull().default("unknown"),
  bookingAddressStatus: text("booking_address_status").notNull().default("unknown"),
  addressMatches: text("address_matches"), // JSON-encoded array
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
