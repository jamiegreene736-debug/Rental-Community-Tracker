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
      ADD COLUMN IF NOT EXISTS arrival_notes text
  `);
  console.log("[schema] ensured buy_ins arrival detail columns");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reservation_aliases (
      id serial PRIMARY KEY,
      reservation_id text NOT NULL UNIQUE,
      guest_name text,
      alias_email text NOT NULL,
      simplelogin_alias_id integer,
      mailbox_email text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      raw_payload text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
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
      provider_message_id text,
      raw_payload text,
      parsed_arrival_details text,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now()
    )
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
    ALTER TABLE message_templates
      ADD COLUMN IF NOT EXISTS delivery_channel text NOT NULL DEFAULT 'guesty'
  `);
  console.log("[schema] ensured message_templates delivery channel column");

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
}
