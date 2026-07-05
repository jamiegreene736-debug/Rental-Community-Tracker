// Pure display logic for the PER-UNIT guest-happiness badge (operator spec
// 2026-07-05, follow-up to the "Will guest be happy?" Cowork prompt): once a
// verdict is recorded via POST /api/bookings/:reservationId/guest-happy it is
// stamped on EVERY attached buy-in row (guestHappyVerdict/Feedback/Source/At),
// but until this change the only visible surface was the panel on the
// walking-distance card — which needs 2+ attached units to render at all.
// The operator asked for the verdict to be put on the units in the portal
// ("yes, guest will be 100% happy" / "no — bedding is off"), so each attached
// unit slot card on the bookings page derives its own badge from its own
// buy-in row via this helper. Kept pure/zero-dep so it is unit-testable.
// Mirrors shared/community-verdict-badge.ts.

export type GuestHappyVerdict = "happy" | "concerns" | "unhappy";

export interface UnitGuestHappyBadge {
  verdict: GuestHappyVerdict;
  /** Short badge text, e.g. "★ Guest happy". */
  label: string;
  /** Styling tone: emerald = happy, amber = concerns, red = unhappy. */
  tone: "emerald" | "amber" | "red";
  /** Hover text: verdict meaning, recorded feedback, source, and ISO day. */
  title: string;
}

/**
 * Derive the badge for one attached buy-in's own guest-happiness verdict.
 * Returns null when no verdict has been recorded — or when the stored value
 * is not one of the three known verdicts (never render junk from a legacy
 * row).
 */
export function unitGuestHappyBadge(
  buyIn:
    | {
        guestHappyVerdict?: string | null;
        guestHappyFeedback?: string | null;
        guestHappySource?: string | null;
        guestHappyAt?: string | Date | null;
      }
    | null
    | undefined,
): UnitGuestHappyBadge | null {
  const raw = String(buyIn?.guestHappyVerdict ?? "").trim().toLowerCase();
  if (raw !== "happy" && raw !== "concerns" && raw !== "unhappy") return null;
  const verdict = raw as GuestHappyVerdict;

  const label =
    verdict === "happy" ? "★ Guest happy" : verdict === "concerns" ? "⚠ Guest concerns" : "✕ Guest NOT happy";
  const tone: UnitGuestHappyBadge["tone"] =
    verdict === "happy" ? "emerald" : verdict === "concerns" ? "amber" : "red";

  const source = String(buyIn?.guestHappySource ?? "").trim();
  const atRaw = buyIn?.guestHappyAt;
  const at = atRaw ? new Date(atRaw as string | Date) : null;
  // ISO day (not toLocaleDateString) so the string is locale-stable in tests.
  const day = at && !Number.isNaN(at.getTime()) ? at.toISOString().slice(0, 10) : null;

  const meaning =
    verdict === "happy"
      ? "guest will be happy with this unit vs what they booked"
      : verdict === "concerns"
        ? "mostly fine but a guest would notice something — read the feedback"
        : "guest will NOT be happy — review this unit";
  const feedback = String(buyIn?.guestHappyFeedback ?? "").trim();
  const title =
    `Guest-happiness check${source ? ` via ${source}` : ""}${day ? ` on ${day}` : ""} — ${meaning}` +
    (feedback ? `: ${feedback}` : "");

  return { verdict, label, tone, title };
}
