import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// Runtime-maintained virtual-staging tables. These definitions intentionally
// live outside shared/schema.ts: Railway runs drizzle-kit push before server
// startup, and drizzle-kit treats brand-new tables as an interactive
// create-vs-rename decision. ensureRuntimeSchema creates these additive tables
// non-interactively before routes are registered, while these objects retain
// fully typed Drizzle queries at runtime.
export const photoOriginalAssets = pgTable("photo_original_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: integer("property_id").notNull(),
  unitId: text("unit_id").notNull(),
  folder: text("folder").notNull(),
  filename: text("filename").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  storageRelativePath: text("storage_relative_path").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type PhotoOriginalAsset = typeof photoOriginalAssets.$inferSelect;
export type InsertPhotoOriginalAsset = typeof photoOriginalAssets.$inferInsert;

export const virtualStagingJobs = pgTable("virtual_staging_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: integer("property_id").notNull(),
  unitId: text("unit_id").notNull(),
  unitLabel: text("unit_label").notNull(),
  folder: text("folder").notNull(),
  status: text("status").notNull().default("queued"),
  total: integer("total").notNull().default(0),
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  model: text("model"),
  error: text("error"),
  requestedBy: text("requested_by"),
  approvedBy: text("approved_by"),
  selectedCandidateIds: jsonb("selected_candidate_ids").$type<string[]>(),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type VirtualStagingJob = typeof virtualStagingJobs.$inferSelect;
export type InsertVirtualStagingJob = typeof virtualStagingJobs.$inferInsert;

export const virtualStagingCandidates = pgTable("virtual_staging_candidates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull(),
  propertyId: integer("property_id").notNull(),
  unitId: text("unit_id").notNull(),
  folder: text("folder").notNull(),
  originalAssetId: varchar("original_asset_id").notNull(),
  originalFilename: text("original_filename").notNull(),
  activeFilenameAtRequest: text("active_filename_at_request").notNull(),
  candidateFilename: text("candidate_filename").notNull(),
  stagingRelativePath: text("staging_relative_path"),
  sourceSha256: text("source_sha256").notNull(),
  roomLabel: text("room_label").notNull(),
  metadataSnapshot: jsonb("metadata_snapshot").$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  attempt: integer("attempt").notNull().default(0),
  generationToken: text("generation_token"),
  generationLeaseExpiresAt: timestamp("generation_lease_expires_at"),
  model: text("model"),
  active: boolean("active").notNull().default(false),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type VirtualStagingCandidate = typeof virtualStagingCandidates.$inferSelect;
export type InsertVirtualStagingCandidate = typeof virtualStagingCandidates.$inferInsert;
