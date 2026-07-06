// Booking-confirmation auto-send ("unit setup confirmation").
//
// Fires once per newly-booked Guesty reservation, posting a warm
// "here's how your stay is set up" message into the matching
// conversation so the guest 100% knows what's going on the day they
// book. The body (built by the pure `shared/booking-confirmation-
// message.ts`) includes:
//   - Region-aware tone: Hawaii stays open "Aloha" / close "Mahalo"
//     and say "'ohana"; mainland stays (Florida, etc.) use
//     "Hi" / "Thanks" / "family". Region is derived from the
//     property/draft address (`@shared/listing-geo` mentionsHawaii /
//     mentionsNonHawaiiState) — default Hawaii unless clearly a
//     non-Hawaii state. Signature stays John Carpenter /
//     VacationRentalExpertz.
//   - A clear explanation of the setup: how many separate units the
//     booking spans within the resort, the approximate walking
//     distance between them (`shared/walking-distance.ts`), combined
//     bedrooms, and the advertised "sleeps N" (occupancyForBedrooms).
//     Single-unit listings get a single-unit variant (no "separate
//     units" language).
//   - The 14-day arrival-info promise so guests know when to expect
//     check-in instructions, parking notes, etc.
//
// Coverage: fires for BOTH the hard-coded core properties
// (`unitBuilderData`) AND published community drafts (mapped in
// `guesty_property_map` with a NEGATIVE propertyId = -draft.id) — see
// `lookupStayForListing`. A booking on any listing not mapped to one
// of our managed properties/drafts is skipped without erroring.
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
import { findGuestyConversationForReservation, sendGuestyConversationMessage, deliveryOutcome } from "./guesty-ota-messaging";
import { storage } from "./storage";
import { unitBuilderData } from "../client/src/data/unit-builder-data";
import type { PropertyUnitBuilder } from "../client/src/data/unit-builder-data";
import { fallbackWalkForResort } from "@shared/walking-distance";
import { buildBookingConfirmationMessage } from "@shared/booking-confirmation-message";
import { guestPartyFromReservation } from "@shared/guest-party";
import { mentionsHawaii, mentionsNonHawaiiState } from "@shared/listing-geo";
import type { InsertBookingConfirmation, CommunityDraft } from "@shared/schema";

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

// Normalized stay context the message builder needs, resolved from EITHER a
// hard-coded core property OR a published community draft. `label` is for logs.
interface ConfirmationStayContext {
  propertyName: string;
  resortName: string;
  unitCount: number;
  totalBedrooms: number;
  walkMinutes: number;
  isHawaii: boolean;
  label: string;
}

// Default to the Hawaiian voice (the portfolio is HI-majority) unless the
// location CLEARLY names a non-Hawaii state — that's the only case we flip to
// the mainland voice, so an HI property whose address lacks a recognizable
// token never gets "Hi/Thanks" by accident.
function isHawaiiLocation(text: string | null | undefined): boolean {
  if (mentionsHawaii(text)) return true;
  return !mentionsNonHawaiiState(text);
}

function stayFromBuilder(property: PropertyUnitBuilder): ConfirmationStayContext {
  const totalBedrooms = property.units.reduce((sum, u) => sum + (Number(u.bedrooms) || 0), 0);
  return {
    propertyName: property.propertyName,
    resortName: property.complexName,
    unitCount: property.units.length,
    totalBedrooms,
    walkMinutes: fallbackWalkForResort(property.complexName).minutes,
    isHawaii: isHawaiiLocation(property.address),
    label: `property ${property.propertyId}`,
  };
}

function stayFromDraft(draft: CommunityDraft): ConfirmationStayContext {
  // A draft is a combo when its second unit is populated; otherwise it's a
  // single-unit listing.
  const hasUnit2 = !!(draft.unit2Url || (draft.unit2Bedrooms ?? 0) > 0 || draft.unit2Bedding);
  const unitCount = hasUnit2 ? 2 : 1;
  const totalBedrooms =
    (draft.combinedBedrooms ?? 0) > 0
      ? (draft.combinedBedrooms as number)
      : (draft.unit1Bedrooms ?? 0) + (hasUnit2 ? (draft.unit2Bedrooms ?? 0) : 0);
  const resortName = draft.name;
  const location = [draft.streetAddress, draft.city, draft.state, draft.name].filter(Boolean).join(", ");
  return {
    propertyName: draft.bookingTitle || draft.listingTitle || draft.name,
    resortName,
    unitCount,
    totalBedrooms,
    walkMinutes: fallbackWalkForResort(resortName).minutes,
    isHawaii: isHawaiiLocation(location),
    label: `draft ${draft.id}`,
  };
}

// Map a Guesty listingId → a normalized stay context. Goes via
// `guestyPropertyMap` (the table the dashboard uses to flag connected
// listings). Positive propertyIds resolve against the hard-coded
// `unitBuilderData`; NEGATIVE propertyIds are published community drafts
// (mapped as -draft.id) and resolve against the `community_drafts` table.
// Returns null when the listing isn't mapped to one of our managed
// properties/drafts — those skip without erroring.
async function lookupStayForListing(listingId: string): Promise<ConfirmationStayContext | null> {
  if (!listingId) return null;
  const maps = await storage.getGuestyPropertyMap();
  const row = maps.find((m) => m.guestyListingId === listingId);
  if (!row) return null;

  if (row.propertyId < 0) {
    const draft = await storage.getCommunityDraft(-row.propertyId);
    return draft ? stayFromDraft(draft) : null;
  }
  const property = unitBuilderData.find((p) => p.propertyId === row.propertyId);
  return property ? stayFromBuilder(property) : null;
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
        const stay = await lookupStayForListing(listingId);
        if (!stay) {
          console.log(`[booking-confirmation] reservation ${reservationId}: listingId ${listingId} not mapped to a managed property/draft — skipping`);
          skipped++;
          continue;
        }

        const guestFirstName: string =
          r.guest?.firstName ??
          (typeof r.guest?.fullName === "string" ? r.guest.fullName.split(" ")[0] : "") ??
          "";

        // Guest's booked party size, when the channel provided it — the message
        // only surfaces it when it comfortably fits the listing.
        const partyTotal = guestPartyFromReservation(r)?.total ?? null;
        const body = buildBookingConfirmationMessage({
          guestFirstName,
          propertyName: stay.propertyName,
          resortName: stay.resortName,
          unitCount: stay.unitCount,
          totalBedrooms: stay.totalBedrooms,
          walkMinutes: stay.walkMinutes,
          isHawaii: stay.isHawaii,
          partyTotal,
        });

        // Resolve the conversation + the proven-delivering OTA module via the
        // hardened resolver (reservation integration.platform + conversation
        // posts), the same one Message AD / the inbox compose box use.
        const channelHint = r.integration?.platform ?? r.source ?? null;
        const conv = await findGuestyConversationForReservation(reservationId, channelHint);
        if (!conv) {
          console.log(`[booking-confirmation] reservation ${reservationId}: no conversation found — skipping`);
          skipped++;
          continue;
        }

        // Send ONCE through the delivery-verified path, then write the dedup row
        // based on the verified outcome. A bare Guesty `pending` post is NOT
        // proof the guest received it (see AGENTS.md #51 /
        // guesty-bookingcom-delivery-externalid) — so we never record a
        // confirmation as "sent" on a misroute. The dedup row's mere EXISTENCE
        // stops the 5-minute scheduler from re-posting, so we still write a row
        // on a posted-but-unconfirmed / misrouted send (just not as "sent") to
        // avoid piling up duplicate copies on the thread.
        try {
          const delivery = await sendGuestyConversationMessage({
            conversationId: conv.id,
            body,
            module: conv.module,
            reservation: conv.reservation ?? r,
            channelHint,
            logPrefix: "booking-confirmation",
          });
          const channel = delivery.deliveryModuleType ?? (conv.module?.type as string | undefined) ?? r.integration?.platform ?? null;
          const outcome = deliveryOutcome(delivery);
          const baseInsert: InsertBookingConfirmation = {
            reservationId,
            conversationId: conv.id,
            guestName: r.guest?.fullName ?? null,
            listingId: listingId || null,
            listingNickname: r.listing?.nickname ?? r.listing?.title ?? null,
            channel,
            messageBody: body,
            status: outcome === "delivered" ? "sent" : outcome === "misroute" ? "misroute" : "pending",
            errorMessage: outcome === "delivered" ? null : (delivery.reason ?? null),
          };
          await storage.createBookingConfirmation(baseInsert);
          if (outcome === "misroute") {
            errors++;
            console.warn(`[booking-confirmation] MISROUTE for reservation ${reservationId} (${channel}): ${delivery.reason ?? ""} — recorded, not delivered to the guest channel`);
          } else if (outcome === "unconfirmed") {
            sent++;
            console.warn(`[booking-confirmation] POSTED to reservation ${reservationId} but ${channel} delivery unconfirmed — not resending: ${delivery.reason ?? ""}`);
          } else {
            sent++;
            console.log(`[booking-confirmation] sent to reservation ${reservationId} (${guestFirstName || "Guest"} @ ${stay.propertyName} [${stay.label}], via ${channel})`);
          }
        } catch (e: any) {
          // POST threw (Guesty rejected every module / network) — leave NO row so
          // it retries next tick.
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
