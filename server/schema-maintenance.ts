import { sql } from "drizzle-orm";
import { db } from "./db";

// Keep production usable when schema-only fields are added but `db:push`
// has not been run inside Railway yet. These are additive, nullable columns.
export async function ensureRuntimeSchema(): Promise<void> {
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
      ADD COLUMN IF NOT EXISTS vrbo_lookup_at timestamp
  `);
  console.log("[schema] ensured buy_ins arrival detail + ground-floor + community-verdict + guest-happy columns");

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

  await db.execute(sql`
    ALTER TABLE photo_listing_checks
      ADD COLUMN IF NOT EXISTS airbnb_address_status text NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS vrbo_address_status text NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS booking_address_status text NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS address_matches text
  `);
  console.log("[schema] ensured photo_listing_checks address-on-OTA columns");

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
      raw_payload text,
      sent_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
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
}
