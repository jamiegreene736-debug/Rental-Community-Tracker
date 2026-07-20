import { sql } from "drizzle-orm";
import { db } from "./db";

// Keep production usable when schema-only fields are added but `db:push`
// has not been run inside Railway yet. These are additive, nullable columns.
export async function ensureRuntimeSchema(): Promise<void> {
  // Cowork checkout preparation depends on both tables immediately after boot:
  // prompt runs bridge oversized Claude deep links, while reservation-scoped
  // claims prevent duplicate checkout sessions across workers. Keep these in
  // the authoritative additive schema path because the non-interactive
  // drizzle push can safely decline an ambiguous create-vs-rename prompt.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cowork_prompt_runs (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      reservation_id text,
      prompt text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      expires_at timestamp NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS buy_in_checkout_claims (
      reservation_id text PRIMARY KEY,
      buy_in_id integer NOT NULL,
      claim_token text NOT NULL,
      owner text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      expires_at timestamp NOT NULL,
      CONSTRAINT buy_in_checkout_claims_claim_token_unique UNIQUE (claim_token)
    )
  `);
  console.log("[schema] ensured Cowork prompt relay + buy-in checkout claim tables");

  await db.execute(sql`
    ALTER TABLE buy_ins
      ADD COLUMN IF NOT EXISTS unit_address text,
      ADD COLUMN IF NOT EXISTS access_code text,
      ADD COLUMN IF NOT EXISTS wifi_name text,
      ADD COLUMN IF NOT EXISTS wifi_password text,
      ADD COLUMN IF NOT EXISTS parking_info text,
      ADD COLUMN IF NOT EXISTS management_company text,
      ADD COLUMN IF NOT EXISTS management_contact text,
      ADD COLUMN IF NOT EXISTS arrival_notes text,
      ADD COLUMN IF NOT EXISTS ground_floor_status text NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS ground_floor_evidence text,
      ADD COLUMN IF NOT EXISTS community_verdict text,
      ADD COLUMN IF NOT EXISTS community_verdict_source text,
      ADD COLUMN IF NOT EXISTS community_verdict_at timestamp,
      ADD COLUMN IF NOT EXISTS guest_happy_verdict text,
      ADD COLUMN IF NOT EXISTS guest_happy_feedback text,
      ADD COLUMN IF NOT EXISTS guest_happy_source text,
      ADD COLUMN IF NOT EXISTS guest_happy_at timestamp,
      ADD COLUMN IF NOT EXISTS vrbo_lookup_status text,
      ADD COLUMN IF NOT EXISTS vrbo_lookup_note text,
      ADD COLUMN IF NOT EXISTS vrbo_lookup_at timestamp,
      ADD COLUMN IF NOT EXISTS arrival_extraction jsonb,
      ADD COLUMN IF NOT EXISTS paid_rate numeric(10,2),
      ADD COLUMN IF NOT EXISTS paid_rate_source jsonb,
      ADD COLUMN IF NOT EXISTS management_contact_source jsonb
  `);
  console.log("[schema] ensured buy_ins arrival detail + ground-floor + community-verdict + guest-happy columns");

  // Dashboard refund alert: when the guest originally BOOKED (Guesty
  // reservation createdAt). Additive nullable; legacy rows heal on the next
  // cancellation rescan (the dashboard GET fires one in the background).
  await db.execute(sql`
    ALTER TABLE reservation_cancellation_audits
      ADD COLUMN IF NOT EXISTS booked_at timestamp
  `);
  console.log("[schema] ensured reservation_cancellation_audits.booked_at column");

  // Claude static-rate engine: additive nullable JSONB for the persisted
  // seasonal anchor plan. The table itself is created by db:push; this keeps a
  // Railway deploy usable before db:push runs.
  await db.execute(sql`
    ALTER TABLE property_market_rates
      ADD COLUMN IF NOT EXISTS static_plan jsonb
  `);
  console.log("[schema] ensured property_market_rates.static_plan column");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reservation_aliases (
      id serial PRIMARY KEY,
      reservation_id text NOT NULL UNIQUE,
      guest_name text,
      alias_email text NOT NULL,
      simplelogin_alias_id integer,
      mailbox_email text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      expires_at timestamp,
      raw_payload text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE reservation_aliases
      ADD COLUMN IF NOT EXISTS expires_at timestamp
  `);
  // Per-unit buy-in aliases: each attached buy-in (unit) can have its own alias.
  // Add buy_in_id, backfill legacy reservation-level rows to the reservation's
  // earliest buy-in, then replace the UNIQUE(reservation_id) constraint with a
  // UNIQUE(reservation_id, buy_in_id) index so unit B can hold a 2nd alias.
  await db.execute(sql`
    ALTER TABLE reservation_aliases
      ADD COLUMN IF NOT EXISTS buy_in_id integer
  `);
  await db.execute(sql`
    UPDATE reservation_aliases ra
      SET buy_in_id = sub.bid
      FROM (
        SELECT guesty_reservation_id AS rid, MIN(id) AS bid
        FROM buy_ins
        WHERE guesty_reservation_id IS NOT NULL
        GROUP BY guesty_reservation_id
      ) sub
      WHERE ra.buy_in_id IS NULL AND ra.reservation_id = sub.rid
  `);
  await db.execute(sql`
    ALTER TABLE reservation_aliases
      DROP CONSTRAINT IF EXISTS reservation_aliases_reservation_id_key
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS reservation_aliases_resv_buyin_idx
      ON reservation_aliases (reservation_id, buy_in_id)
  `);
  console.log("[schema] ensured reservation_aliases per-buy-in alias support");
  // Agent-portal per-reservation shares (limited buy-in view, 2026-07-20):
  // a row = the operator clicked "Show in agent portal" for that reservation.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reservation_agent_shares (
      reservation_id text PRIMARY KEY,
      shared_by text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("[schema] ensured reservation_agent_shares table");
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS buy_in_vendor_contacts (
      id serial PRIMARY KEY,
      buy_in_id integer NOT NULL,
      reservation_id text NOT NULL,
      vendor_name text,
      vendor_email text NOT NULL,
      simplelogin_contact_id integer,
      reverse_alias_email text,
      reverse_alias text,
      status text NOT NULL DEFAULT 'active',
      raw_payload text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS buy_in_vendor_contacts_unique_idx
      ON buy_in_vendor_contacts (buy_in_id, lower(vendor_email))
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS buy_in_emails (
      id serial PRIMARY KEY,
      buy_in_id integer NOT NULL,
      reservation_id text NOT NULL,
      vendor_contact_id integer,
      direction text NOT NULL,
      from_email text NOT NULL,
      to_email text NOT NULL,
      subject text NOT NULL,
      body text NOT NULL,
      attachments_json text,
      provider_message_id text,
      raw_payload text,
      parsed_arrival_details text,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE buy_in_emails
      ADD COLUMN IF NOT EXISTS attachments_json text
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS buy_in_emails_reservation_idx
      ON buy_in_emails (reservation_id, sent_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS buy_in_emails_buy_in_idx
      ON buy_in_emails (buy_in_id, sent_at DESC)
  `);
  console.log("[schema] ensured SimpleLogin buy-in email tables");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS rental_agreements (
      id serial PRIMARY KEY,
      token text NOT NULL UNIQUE,
      reservation_id text NOT NULL,
      conversation_id text,
      channel text NOT NULL,
      guest_name text NOT NULL,
      guest_email text,
      guest_phone text,
      property_name text NOT NULL,
      check_in date,
      check_out date,
      nights integer,
      booking_total numeric(10,2),
      confirmation_code text,
      unit_summary text,
      cancellation_policy text,
      agreement_text text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      signed_name text,
      signer_email text,
      signer_phone text,
      signer_ip text,
      signer_user_agent text,
      signed_at timestamp,
      raw_payload text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE rental_agreements
      ADD COLUMN IF NOT EXISTS cancellation_policy text
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS rental_agreements_reservation_idx
      ON rental_agreements (reservation_id, created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS rental_agreements_status_idx
      ON rental_agreements (status)
  `);
  console.log("[schema] ensured rental_agreements table");

  await db.execute(sql`
    ALTER TABLE message_templates
      ADD COLUMN IF NOT EXISTS delivery_channel text NOT NULL DEFAULT 'guesty'
  `);
  console.log("[schema] ensured message_templates delivery channel column");

  await db.execute(sql`
    ALTER TABLE property_market_rates
      ADD COLUMN IF NOT EXISTS monthly_rates jsonb NOT NULL DEFAULT '{}'::jsonb
  `);
  console.log("[schema] ensured property_market_rates monthly_rates column");

  // Address-on-OTA detection REMOVED 2026-07-18 (the clubhouse published
  // address made the address-theft signal moot). Drop the leg's four columns
  // so the live DB matches shared/schema.ts again — without this, drizzle-kit
  // push sees a destructive diff on every boot and aborts (non-interactive),
  // leaving db:push permanently dirty. Idempotent; a fresh DB has no-op drops.
  await db.execute(sql`
    ALTER TABLE photo_listing_checks
      DROP COLUMN IF EXISTS airbnb_address_status,
      DROP COLUMN IF EXISTS vrbo_address_status,
      DROP COLUMN IF EXISTS booking_address_status,
      DROP COLUMN IF EXISTS address_matches
  `);
  console.log("[schema] dropped photo_listing_checks address-on-OTA columns (leg removed 2026-07-18)");

  await db.execute(sql`
    ALTER TABLE community_drafts
      ADD COLUMN IF NOT EXISTS street_address text,
      ADD COLUMN IF NOT EXISTS minimum_stay_nights integer,
      ADD COLUMN IF NOT EXISTS minimum_stay_evidence text,
      ADD COLUMN IF NOT EXISTS minimum_stay_source_url text,
      ADD COLUMN IF NOT EXISTS unit1_bathrooms text,
      ADD COLUMN IF NOT EXISTS unit1_sqft text,
      ADD COLUMN IF NOT EXISTS unit1_max_guests integer,
      ADD COLUMN IF NOT EXISTS unit1_bedding text,
      ADD COLUMN IF NOT EXISTS unit1_short_description text,
      ADD COLUMN IF NOT EXISTS unit1_long_description text,
      ADD COLUMN IF NOT EXISTS unit1_photo_folder text,
      ADD COLUMN IF NOT EXISTS unit2_bathrooms text,
      ADD COLUMN IF NOT EXISTS unit2_sqft text,
      ADD COLUMN IF NOT EXISTS unit2_max_guests integer,
      ADD COLUMN IF NOT EXISTS unit2_bedding text,
      ADD COLUMN IF NOT EXISTS unit2_short_description text,
      ADD COLUMN IF NOT EXISTS unit2_long_description text,
      ADD COLUMN IF NOT EXISTS unit2_photo_folder text,
      ADD COLUMN IF NOT EXISTS pricing_area text,
      ADD COLUMN IF NOT EXISTS single_listing boolean,
      ADD COLUMN IF NOT EXISTS booking_title text,
      ADD COLUMN IF NOT EXISTS property_type text,
      ADD COLUMN IF NOT EXISTS neighborhood text,
      ADD COLUMN IF NOT EXISTS transit text,
      ADD COLUMN IF NOT EXISTS str_permit text,
      ADD COLUMN IF NOT EXISTS latitude text,
      ADD COLUMN IF NOT EXISTS longitude text
  `);
  console.log("[schema] ensured community_drafts listing draft columns");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS manual_reservations (
      id serial PRIMARY KEY,
      property_id integer NOT NULL,
      guest_name text NOT NULL,
      guest_email text,
      guest_phone text,
      check_in date NOT NULL,
      check_out date NOT NULL,
      total_rate numeric(10,2) NOT NULL,
      notes text,
      status text NOT NULL DEFAULT 'active',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS manual_reservations_property_check_in_idx
      ON manual_reservations (property_id, check_in)
  `);
  console.log("[schema] ensured manual_reservations table");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS quo_sms_messages (
      id serial PRIMARY KEY,
      provider_message_id text NOT NULL UNIQUE,
      conversation_id text,
      reservation_id text,
      guest_name text,
      guest_phone text NOT NULL,
      from_number text NOT NULL,
      to_number text NOT NULL,
      direction text NOT NULL,
      body text NOT NULL,
      status text,
      media_urls text,
      raw_payload text,
      sent_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE quo_sms_messages ADD COLUMN IF NOT EXISTS media_urls text
  `);
  // Boot-time heal for the upsert target (mirrors quo_call_events below).
  // The Dockerfile CMD runs `db:push` before the server starts, and any
  // UNIQUE constraint shared/schema.ts doesn't declare gets DROPPED by
  // drizzle-kit — the inline UNIQUE in the CREATE TABLE above only applies
  // when the table is first created, so it can't restore it. Without this
  // index createQuoSmsMessage's onConflictDoUpdate fails on EVERY insert
  // ("no unique or exclusion constraint...") after the SMS already went out
  // (the 2026-07-06 "500: Failed to send SMS" incident). Guarded: a unique
  // index can't be created over pre-existing duplicate rows, and a schema
  // heal must never brick boot.
  await db
    .execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS quo_sms_messages_provider_message_id_idx
        ON quo_sms_messages (provider_message_id)
    `)
    .catch((err: any) =>
      console.error(`[schema] FAILED to ensure quo_sms_messages provider_message_id unique index (SMS mirror upserts will fail): ${err?.message ?? err}`),
    );
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS quo_sms_messages_conversation_sent_at_idx
      ON quo_sms_messages (conversation_id, sent_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS quo_sms_messages_guest_phone_idx
      ON quo_sms_messages (guest_phone)
  `);
  console.log("[schema] ensured quo_sms_messages table");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS quo_call_events (
      id serial PRIMARY KEY,
      provider_call_id text NOT NULL UNIQUE,
      conversation_id text,
      reservation_id text,
      guest_name text,
      guest_phone text NOT NULL,
      from_number text NOT NULL,
      to_number text NOT NULL,
      direction text NOT NULL,
      status text,
      disposition text NOT NULL DEFAULT 'unknown',
      duration_seconds integer,
      match_strategy text,
      match_confidence text,
      voicemail_id text,
      voicemail_status text,
      voicemail_recording_url text,
      voicemail_transcript text,
      voicemail_duration_seconds integer,
      raw_payload text,
      call_started_at timestamp,
      call_completed_at timestamp,
      acknowledged_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE quo_call_events
      ADD COLUMN IF NOT EXISTS match_strategy text,
      ADD COLUMN IF NOT EXISTS match_confidence text,
      ADD COLUMN IF NOT EXISTS voicemail_id text,
      ADD COLUMN IF NOT EXISTS voicemail_status text,
      ADD COLUMN IF NOT EXISTS voicemail_recording_url text,
      ADD COLUMN IF NOT EXISTS voicemail_transcript text,
      ADD COLUMN IF NOT EXISTS voicemail_duration_seconds integer,
      ADD COLUMN IF NOT EXISTS acknowledged_at timestamp
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS quo_call_events_provider_call_id_idx
      ON quo_call_events (provider_call_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS quo_call_events_conversation_created_idx
      ON quo_call_events (conversation_id, created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS quo_call_events_unacknowledged_idx
      ON quo_call_events (acknowledged_at, created_at DESC)
  `);
  console.log("[schema] ensured quo_call_events table");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS guest_inbox_internal_notes (
      id serial PRIMARY KEY,
      conversation_id text NOT NULL,
      reservation_id text,
      guest_name text,
      guest_phone text,
      note text NOT NULL,
      source text NOT NULL DEFAULT 'manual',
      created_by text NOT NULL DEFAULT 'agent',
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS guest_inbox_internal_notes_conversation_created_idx
      ON guest_inbox_internal_notes (conversation_id, created_at DESC)
  `);
  console.log("[schema] ensured guest_inbox_internal_notes table");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS guest_phone_overrides (
      id serial PRIMARY KEY,
      conversation_id text NOT NULL UNIQUE,
      reservation_id text,
      guest_name text,
      phone text NOT NULL,
      source_phone text,
      pre_arrival_form_url text,
      payment_url text,
      updated_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE guest_phone_overrides
      ADD COLUMN IF NOT EXISTS pre_arrival_form_url text,
      ADD COLUMN IF NOT EXISTS payment_url text
  `);
  // Same db:push constraint-drop heal as quo_sms_messages above —
  // upsertGuestPhoneOverride conflicts on conversation_id.
  await db
    .execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS guest_phone_overrides_conversation_id_idx
        ON guest_phone_overrides (conversation_id)
    `)
    .catch((err: any) =>
      console.error(`[schema] FAILED to ensure guest_phone_overrides conversation_id unique index (phone saves will fail): ${err?.message ?? err}`),
    );
  console.log("[schema] ensured guest_phone_overrides table");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS property_compliance_overrides (
      property_id integer PRIMARY KEY,
      tax_map_key text,
      tat_license text,
      get_license text,
      str_permit text,
      dbpr_license text,
      tourist_tax_account text,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("[schema] ensured property_compliance_overrides table");

  // Operator-edited Descriptions-tab overrides. property_id is a positive
  // core id OR a negative -draftId (see schema.ts).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS property_description_overrides (
      property_id integer PRIMARY KEY,
      title text,
      summary text,
      space text,
      neighborhood text,
      transit text,
      access text,
      house_rules text,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("[schema] ensured property_description_overrides table");

  // In-system amenity selection per property (photo-scan / combo / manual).
  // property_id is a positive core id OR a negative -draftId (see schema.ts).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS property_amenities (
      property_id integer PRIMARY KEY,
      amenity_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
      detected jsonb,
      source text,
      photos_scanned integer,
      scanned_at timestamp,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("[schema] ensured property_amenities table");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS top_market_scan_cache (
      market_key text PRIMARY KEY,
      city text NOT NULL,
      state text NOT NULL,
      tag text,
      four_bedroom_possible boolean NOT NULL DEFAULT false,
      five_bedroom_possible boolean NOT NULL DEFAULT false,
      six_bedroom_possible boolean NOT NULL DEFAULT false,
      seven_eight_bedroom_possible boolean NOT NULL DEFAULT false,
      qualifying_count integer NOT NULL DEFAULT 0,
      communities jsonb NOT NULL DEFAULT '[]'::jsonb,
      error text,
      scanned_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  // Existing deploys created the table before the 4BR/5BR combo flags existed —
  // CREATE TABLE IF NOT EXISTS won't add the new columns, so add them explicitly.
  await db.execute(sql`
    ALTER TABLE top_market_scan_cache
      ADD COLUMN IF NOT EXISTS four_bedroom_possible boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS five_bedroom_possible boolean NOT NULL DEFAULT false
  `);
  console.log("[schema] ensured top_market_scan_cache table");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS auto_fill_loss_options (
      reservation_id text PRIMARY KEY,
      property_id integer,
      status text,
      slots_total integer,
      slots_filled integer,
      combo_options jsonb NOT NULL DEFAULT '[]'::jsonb,
      city_economics jsonb NOT NULL DEFAULT '[]'::jsonb,
      finished_at timestamp,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("[schema] ensured auto_fill_loss_options table");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cancellation_notices (
      reservation_id text PRIMARY KEY,
      channel text,
      message text,
      sent_at timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("[schema] ensured cancellation_notices table");

  // Guest payment/refund receipts (auto-sent). Created here too so a fresh
  // Railway deploy works before `npm run db:push` runs. UNIQUE on token (the
  // /receipt/:token durable page) and dedup_key (one receipt per transaction).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS guest_receipts (
      id serial PRIMARY KEY,
      token varchar(64) NOT NULL UNIQUE,
      dedup_key text NOT NULL UNIQUE,
      reservation_id text NOT NULL,
      conversation_id text,
      kind text NOT NULL,
      amount numeric(10,2),
      currency text,
      transaction_date text,
      guest_name text,
      listing_id text,
      listing_nickname text,
      channel text,
      message_body text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending',
      error_message text,
      expires_at timestamp,
      message_sent_at timestamp,
      first_opened_at timestamp,
      last_opened_at timestamp,
      open_count integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS guest_receipts_reservation_idx
      ON guest_receipts (reservation_id, created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS guest_receipts_created_idx
      ON guest_receipts (created_at DESC)
  `);
  // Refund-only SMS leg (2026-07-03): the scheduler also TEXTS the guest's
  // phone on file for refunds and records the outcome here so the dashboard
  // can confirm the text actually sent.
  await db.execute(sql`
    ALTER TABLE guest_receipts
      ADD COLUMN IF NOT EXISTS sms_status text,
      ADD COLUMN IF NOT EXISTS sms_to text,
      ADD COLUMN IF NOT EXISTS sms_error text,
      ADD COLUMN IF NOT EXISTS sms_sent_at timestamp
  `);
  console.log("[schema] ensured guest_receipts table (+ refund SMS columns)");

  // Platform AI assistant (dashboard chat agent). Created here too so a fresh
  // Railway deploy works before `npm run db:push` runs. The list/history
  // endpoints fail-soft (return empty) until these exist.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS assistant_sessions (
      id serial PRIMARY KEY,
      title text NOT NULL DEFAULT 'New chat',
      created_by text NOT NULL DEFAULT 'admin',
      created_at timestamp NOT NULL DEFAULT now(),
      last_active_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id serial PRIMARY KEY,
      session_id integer NOT NULL,
      role text NOT NULL,
      content jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS assistant_messages_session_idx
      ON assistant_messages (session_id, created_at ASC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS assistant_sessions_active_idx
      ON assistant_sessions (last_active_at DESC)
  `);
  console.log("[schema] ensured assistant chat tables");

  // Bedroom re-mix / photo-reuse tracking + worker-interruption counter on bulk
  // combo listing queue items.
  await db.execute(sql`
    ALTER TABLE bulk_combo_listing_job_items
      ADD COLUMN IF NOT EXISTS effective_unit1_beds integer,
      ADD COLUMN IF NOT EXISTS effective_unit2_beds integer,
      ADD COLUMN IF NOT EXISTS remix_applied boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS unit2_photos_reused boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS interruptions integer NOT NULL DEFAULT 0
  `);
  console.log("[schema] ensured bulk_combo_listing_job_items re-mix + interruption columns");

  // Approval-based virtual staging. Generated assets live on the mounted photo
  // volume; these rows provide durable job progress, immutable-original
  // provenance, and the single active candidate for each logical gallery photo.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS photo_original_assets (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      property_id integer NOT NULL,
      unit_id text NOT NULL,
      folder text NOT NULL,
      filename text NOT NULL,
      source_sha256 text NOT NULL,
      storage_relative_path text NOT NULL,
      mime_type text NOT NULL,
      byte_size integer NOT NULL,
      width integer,
      height integer,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS photo_original_assets_source_idx
      ON photo_original_assets (property_id, unit_id, folder, filename, source_sha256)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS virtual_staging_jobs (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      property_id integer NOT NULL,
      unit_id text NOT NULL,
      unit_label text NOT NULL,
      folder text NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      total integer NOT NULL DEFAULT 0,
      completed integer NOT NULL DEFAULT 0,
      failed integer NOT NULL DEFAULT 0,
      model text,
      error text,
      requested_by text,
      approved_by text,
      selected_candidate_ids jsonb,
      confirmed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS virtual_staging_jobs_active_unit_idx
      ON virtual_staging_jobs (property_id, unit_id)
      WHERE status IN ('queued', 'running')
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS virtual_staging_jobs_unit_created_idx
      ON virtual_staging_jobs (property_id, unit_id, created_at DESC)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS virtual_staging_candidates (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id varchar NOT NULL,
      property_id integer NOT NULL,
      unit_id text NOT NULL,
      folder text NOT NULL,
      original_asset_id varchar NOT NULL,
      original_filename text NOT NULL,
      active_filename_at_request text NOT NULL,
      candidate_filename text NOT NULL,
      staging_relative_path text,
      source_sha256 text NOT NULL,
      room_label text NOT NULL,
      metadata_snapshot jsonb,
      status text NOT NULL DEFAULT 'pending',
      error text,
      attempt integer NOT NULL DEFAULT 0,
      generation_token text,
      generation_lease_expires_at timestamp,
      model text,
      active boolean NOT NULL DEFAULT false,
      approved_by text,
      approved_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE virtual_staging_candidates
      ADD COLUMN IF NOT EXISTS generation_token text,
      ADD COLUMN IF NOT EXISTS generation_lease_expires_at timestamp
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS virtual_staging_candidates_job_source_idx
      ON virtual_staging_candidates (job_id, original_filename)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS virtual_staging_candidates_filename_idx
      ON virtual_staging_candidates (candidate_filename)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS virtual_staging_candidates_active_source_idx
      ON virtual_staging_candidates (property_id, unit_id, folder, original_filename)
      WHERE active = true
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS virtual_staging_candidates_folder_active_idx
      ON virtual_staging_candidates (folder, active)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS virtual_staging_candidates_job_created_idx
      ON virtual_staging_candidates (job_id, created_at ASC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS virtual_staging_candidates_generation_lease_idx
      ON virtual_staging_candidates (generation_lease_expires_at)
      WHERE status = 'generating'
  `);
  // Candidate metadata is prepared as hidden before a file is copied into the
  // top-level gallery. This narrow uniqueness guard prevents two confirm
  // requests from creating duplicate label rows without changing legacy rows.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS photo_labels_virtual_staged_unique_idx
      ON photo_labels (folder, filename)
      WHERE filename LIKE 'virtual-staged-%'
  `);
  console.log("[schema] ensured approval-based virtual-staging tables and indexes");

  await db.execute(sql`
    ALTER TABLE photo_labels
      ADD COLUMN IF NOT EXISTS bedroom_cluster_id text,
      ADD COLUMN IF NOT EXISTS bedroom_bed_type text
  `);
  console.log("[schema] ensured photo_labels bedroom cluster precompute columns");

  // Operator-defined photo order within a gallery (Photos-tab drag-to-reorder).
  await db.execute(sql`
    ALTER TABLE photo_labels
      ADD COLUMN IF NOT EXISTS sort_order integer
  `);
  console.log("[schema] ensured photo_labels sort_order column");

  // Per-property trailing-365-day revenue cache for the dashboard "Total
  // Revenue" column, refreshed daily by the property-revenue scheduler.
  // Created here so a fresh Railway deploy works before `npm run db:push`
  // runs; GET /api/dashboard/property-revenue fails-soft (empty) until then.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS property_trailing_revenue (
      property_id integer PRIMARY KEY,
      revenue numeric(12,2) NOT NULL DEFAULT 0,
      currency text NOT NULL DEFAULT 'USD',
      bookings integer NOT NULL DEFAULT 0,
      window_days integer NOT NULL DEFAULT 365,
      computed_at timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("[schema] ensured property_trailing_revenue table");

  // Guest issues tracker + threaded comments for the guest inbox (operator +
  // remote "agent" portal role). Created here so a fresh Railway deploy works
  // before `npm run db:push` runs; the inbox endpoints fail-soft (empty) until
  // then. Indexes live only here (shared/schema.ts declares none).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS guest_issues (
      id serial PRIMARY KEY,
      conversation_id text NOT NULL,
      reservation_id text,
      guest_name text,
      listing_id text,
      title text NOT NULL,
      description text,
      severity text NOT NULL DEFAULT 'normal',
      status text NOT NULL DEFAULT 'open',
      created_by text NOT NULL DEFAULT 'agent',
      created_by_role text NOT NULL DEFAULT 'agent',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      last_comment_at timestamp,
      resolved_at timestamp
    )
  `);
  // kind added 2026-07-09 (Guest Issues vs Back-Office Issues tabs). The table
  // predates it, so ADD COLUMN IF NOT EXISTS on boot; new rows default to
  // 'property'. A one-time re-classification below routes existing auto-detected
  // billing/refund/cancellation issues to 'back_office' so the split applies
  // retroactively (idempotent — only property-kind system rows are touched).
  await db.execute(sql`ALTER TABLE guest_issues ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'property'`);
  await db.execute(sql`
    UPDATE guest_issues
       SET kind = 'back_office'
     WHERE kind = 'property'
       AND created_by_role = 'system'
       AND (
         lower(coalesce(title, '')) ~ '(refund|cancel|charge|billing|money back|overcharg|chargeback)'
         OR lower(coalesce(description, '')) ~ '(refund|cancel|overcharg|chargeback|money back|dispute the charge)'
       )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS guest_issues_conversation_created_idx
      ON guest_issues (conversation_id, created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS guest_issues_kind_status_updated_idx
      ON guest_issues (kind, status, updated_at DESC)
  `);
  console.log("[schema] ensured guest_issues table");

  // Guest-question tier columns (2026-07-10): auto_reply_log predates them
  // (table itself comes from db:push), so ADD COLUMN IF NOT EXISTS on boot.
  // tier 1 = super-basic property question the AI auto-answers; tier 2 =
  // held for the operator. Null = legacy rows written before tiering.
  await db.execute(sql`ALTER TABLE auto_reply_log ADD COLUMN IF NOT EXISTS tier integer`);
  await db.execute(sql`ALTER TABLE auto_reply_log ADD COLUMN IF NOT EXISTS tier_reason text`);
  console.log("[schema] ensured auto_reply_log tier columns");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS guest_issue_comments (
      id serial PRIMARY KEY,
      issue_id integer NOT NULL,
      conversation_id text NOT NULL,
      body text NOT NULL,
      status_change text,
      author_name text NOT NULL DEFAULT 'agent',
      author_role text NOT NULL DEFAULT 'agent',
      source text NOT NULL DEFAULT 'portal',
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS guest_issue_comments_issue_created_idx
      ON guest_issue_comments (issue_id, created_at ASC)
  `);
  console.log("[schema] ensured guest_issue_comments table");
}
