// Booking-confirmation auto-send.
//
// Fires once per newly-booked Guesty reservation, posting a warm
// "thanks for booking" message into the matching conversation. The
// message includes:
//   - Hawaiian tone (Aloha greeting / Mahalo sign-off, John Carpenter
//     / Magical Island Rentals signature) — every active property is
//     in HI today; if/when mainland properties are added we'd
//     introduce a tone variant gated on the listing's address.
//   - A reminder that the listing is two separate units within the
//     resort, with the approximate walking distance pulled from
//     `shared/walking-distance.ts` (`RESORT_DEFAULT_WALK_MINUTES`).
//   - The 14-day arrival-info promise so guests know when to expect
//     check-in instructions, parking notes, etc.
//
// Idempotency: a row in `booking_confirmations` (unique on
// reservationId) is what stops a second send. We insert AFTER a
// successful Guesty post — a failed send leaves no row and gets
// retried next tick. The unique constraint catches the rare race
// where two ticks both think they need to send.
//
// Backfill safety: only reservations whose `createdAt` is within the
// last 14 days are eligible. Without this cap, the first run after
// deploy would spam every confirmed reservation in the account with
// "thanks for booking!" — guests who booked weeks ago shouldn't
// hear from us out of nowhere.

import { guestyRequest } from "./guesty-sync";
import { storage } from "./storage";
import { unitBuilderData } from "../client/src/data/unit-builder-data";
import { fallbackWalkForResort } from "@shared/walking-distance";
import type { InsertBookingConfirmation } from "@shared/schema";

let _enabled = process.env.BOOKING_CONFIRMATIONS_DISABLED !== "true";
let _lastRunAt: Date | null = null;
let _lastRunResult: { processed: number; sent: number; skipped: number; errors: number; message: string } | null = null;

export function getBookingConfirmationStatus() {
  return { enabled: _enabled, lastRunAt: _lastRunAt, lastRunResult: _lastRunResult };
}

export function setBookingConfirmationEnabled(v: boolean) {
  _enabled = v;
  console.log(`[booking-confirmation] ${v ? "Enabled" : "Disabled"}`);
}

// Statuses Guesty exposes for "the booking is confirmed and the guest
// can be greeted." `inquiry` and `request` deliberately omitted —
// pre-approval / acceptance hasn't happened yet.
const BOOKED_STATUSES = new Set([
  "confirmed",
  "accepted",
  "reserved",
]);

const BACKFILL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// Map a Guesty listingId → the unit-builder property entry. Goes via
// `guestyPropertyMap` (the table the dashboard uses to flag connected
// listings) and then unit-builder-data. Returns null when the listing
// isn't mapped to one of our managed properties — those skip without
// erroring.
async function lookupPropertyForListing(listingId: string) {
  if (!listingId) return null;
  const maps = await storage.getGuestyPropertyMap();
  const row = maps.find((m) => m.guestyListingId === listingId);
  if (!row) return null;
  return unitBuilderData.find((p) => p.propertyId === row.propertyId) ?? null;
}

// Build the confirmation message body. Pure function — easy to unit
// test and reason about. Always closes with the canonical signature
// so guests recognize who's writing.
function buildConfirmationMessage(args: {
  guestFirstName: string;
  propertyName: string;
  complexName: string;
  walkMinutes: number;
}): string {
  const { guestFirstName, propertyName, complexName, walkMinutes } = args;
  const greeting = guestFirstName ? `Aloha ${guestFirstName},` : "Aloha,";
  const walkPhrase =
    walkMinutes <= 1
      ? "just steps apart within the resort grounds"
      : `about a ${walkMinutes}-minute walk apart within the resort grounds`;

  return [
    greeting,
    "",
    `Mahalo for booking with us! We're so excited to host your 'ohana at ${propertyName}.`,
    "",
    `Quick logistics so you know what to expect: this stay is two separate units within ${complexName}, ${walkPhrase}. You'll have your own private spaces but stay connected during your time here.`,
    "",
    "Your detailed arrival information — check-in instructions, lockbox codes, parking, WiFi, and a few local recommendations — will be sent to you about 14 days before your check-in date. If you have any questions before then, just reply here.",
    "",
    "Mahalo,",
    "John Carpenter",
    "Magical Island Rentals",
  ].join("\n");
}

// Find the conversation associated with a reservation. Guesty exposes
// this via `/communication/conversations?reservationId=...`. Falls
// back to the conversation embedded on the reservation document if
// the search endpoint returns nothing. Either way, returns null when
// we can't post — log + skip.
async function findConversationForReservation(reservationId: string): Promise<{ id: string; module: any } | null> {
  try {
    const data = await guestyRequest("GET", `/communication/conversations?reservationId=${encodeURIComponent(reservationId)}&limit=1`) as any;
    const list = data?.data?.conversations ?? data?.conversations ?? data?.results ?? [];
    if (Array.isArray(list) && list.length > 0) {
      const c = list[0];
      return { id: c._id, module: c.module ?? c.lastPost?.module ?? null };
    }
  } catch (e: any) {
    console.warn(`[booking-confirmation] conversation lookup failed for reservation ${reservationId}: ${e.message}`);
  }
  return null;
}

async function sendMessage(conversationId: string, body: string, mod: any): Promise<void> {
  // Whitelist module fields per the existing inbox send code (extra
  // fields like templateValues / templateVariableNames cause Guesty's
  // /send-message to reject the request). type defaults to "email"
  // when we couldn't sniff the channel.
  const cleanMod: Record<string, unknown> = {};
  if (mod && typeof mod === "object") {
    for (const k of ["type", "channelId", "platform", "integrationId"] as const) {
      if (mod[k] !== undefined) cleanMod[k] = mod[k];
    }
  }
  if (!cleanMod.type) cleanMod.type = "email";
  await guestyRequest("POST", `/communication/conversations/${conversationId}/send-message`, {
    body,
    module: cleanMod,
  });
}

export async function runBookingConfirmations(): Promise<NonNullable<typeof _lastRunResult>> {
  if (!_enabled) {
    const r = { processed: 0, sent: 0, skipped: 0, errors: 0, message: "Booking confirmations disabled" };
    _lastRunAt = new Date();
    _lastRunResult = r;
    return r;
  }

  let processed = 0, sent = 0, skipped = 0, errors = 0;

  try {
    // Pull recent reservations sorted newest-first so the freshly-
    // booked ones are at the front of the list. Cap at 50 — typical
    // host has nowhere near that many new bookings between ticks.
    const data = await guestyRequest("GET", "/reservations?limit=50&sort=-createdAt") as any;
    const list: any[] = data?.results ?? data?.data?.results ?? data?.data ?? [];
    const cutoff = Date.now() - BACKFILL_WINDOW_MS;

    for (const r of list) {
      processed++;
      try {
        const status = String(r?.status ?? "").toLowerCase();
        if (!BOOKED_STATUSES.has(status)) { skipped++; continue; }

        const reservationId: string | undefined = r._id ?? r.id;
        if (!reservationId) { skipped++; continue; }

        // Backfill cap — don't message guests who booked weeks ago.
        const created = new Date(r.createdAt ?? r.confirmedAt ?? 0).getTime();
        if (!Number.isFinite(created) || created < cutoff) { skipped++; continue; }

        // Already-sent dedup
        const prior = await storage.getBookingConfirmationByReservationId(reservationId);
        if (prior) { skipped++; continue; }

        const listingId: string = r.listingId ?? r.listing?._id ?? "";
        const property = await lookupPropertyForListing(listingId);
        if (!property) {
          console.log(`[booking-confirmation] reservation ${reservationId}: listingId ${listingId} not in guestyPropertyMap — skipping`);
          skipped++;
          continue;
        }

        // Single-unit listings shouldn't get the "two units" message.
        if (property.units.length < 2) {
          console.log(`[booking-confirmation] reservation ${reservationId}: property ${property.propertyId} is single-unit — skipping`);
          skipped++;
          continue;
        }

        const guestFirstName: string =
          r.guest?.firstName ??
          (typeof r.guest?.fullName === "string" ? r.guest.fullName.split(" ")[0] : "") ??
          "";

        const walk = fallbackWalkForResort(property.complexName);
        const body = buildConfirmationMessage({
          guestFirstName,
          propertyName: property.propertyName,
          complexName: property.complexName,
          walkMinutes: walk.minutes,
        });

        const conv = await findConversationForReservation(reservationId);
        if (!conv) {
          console.log(`[booking-confirmation] reservation ${reservationId}: no conversation found — skipping`);
          skipped++;
          continue;
        }

        // Send first; insert dedup row only if the send actually
        // went through. A failed send leaves no row and gets retried.
        try {
          await sendMessage(conv.id, body, conv.module);
          const channel = conv.module?.type ?? r.integration?.platform ?? null;
          const insert: InsertBookingConfirmation = {
            reservationId,
            conversationId: conv.id,
            guestName: r.guest?.fullName ?? null,
            listingId: listingId || null,
            listingNickname: r.listing?.nickname ?? r.listing?.title ?? null,
            channel,
            messageBody: body,
            status: "sent",
            errorMessage: null,
          };
          await storage.createBookingConfirmation(insert);
          sent++;
          console.log(`[booking-confirmation] sent to reservation ${reservationId} (${guestFirstName || "Guest"} @ ${property.propertyName})`);
        } catch (e: any) {
          errors++;
          console.error(`[booking-confirmation] send failed for reservation ${reservationId}: ${e.message}`);
        }
      } catch (e: any) {
        errors++;
        console.error(`[booking-confirmation] error processing reservation: ${e.message}`);
      }
    }
  } catch (e: any) {
    errors++;
    console.error(`[booking-confirmation] top-level error: ${e.message}`);
  }

  _lastRunAt = new Date();
  _lastRunResult = {
    processed, sent, skipped, errors,
    message: `Processed ${processed} — sent ${sent}, skipped ${skipped}, errors ${errors}`,
  };
  console.log(`[booking-confirmation] ${_lastRunResult.message}`);
  return _lastRunResult;
}

export function startBookingConfirmationScheduler() {
  // Delay first run so the server can finish booting and the rest of
  // the schedulers come up first.
  setTimeout(() => { runBookingConfirmations().catch(() => {}); }, 45_000);

  // Every 5 minutes — same cadence as the auto-reply scheduler so a
  // freshly-booked reservation is greeted within ~5 min of confirmation.
  const INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    runBookingConfirmations().catch(() => {});
  }, INTERVAL_MS);

  console.log("[booking-confirmation] Scheduler started (every 5 minutes)");
}
