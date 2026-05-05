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
      updated_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  console.log("[schema] ensured guest_phone_overrides table");
}
