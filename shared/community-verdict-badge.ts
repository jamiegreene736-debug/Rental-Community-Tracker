// Pure display logic for the PER-UNIT community-verdict badge (operator spec
// 2026-07-05, follow-up to the "Verify community" Cowork prompt): once a
// verdict is recorded via POST /api/bookings/:reservationId/community-verdict
// it is stamped on EVERY attached buy-in row (communityVerdict/Source/At), but
// until this change the only visible surface was the consensus badge on the
// walking-distance panel — which needs 2+ attached units to render at all.
// The operator asked for the UNITS THEMSELVES to be marked, so each attached
// unit slot card on the bookings page now derives its own badge from its own
// buy-in row via this helper. Kept pure/zero-dep so it is unit-testable.

export type CommunityVerdict = "same_building" | "same_community" | "different";

export interface UnitCommunityVerdictBadge {
  verdict: CommunityVerdict;
  /** Short badge text, e.g. "✓ Same building". */
  label: string;
  /** true → style the badge red (review this pairing); false → emerald. */
  different: boolean;
  /** Hover text: what the verdict means plus how/when it was recorded. */
  title: string;
}

/**
 * Derive the badge for one attached buy-in's own community verdict. Returns
 * null when no verdict has been recorded — or when the stored value is not
 * one of the three known verdicts (never render junk from a legacy row).
 */
export function unitCommunityVerdictBadge(
  buyIn:
    | {
        communityVerdict?: string | null;
        communityVerdictSource?: string | null;
        communityVerdictAt?: string | Date | null;
      }
    | null
    | undefined,
): UnitCommunityVerdictBadge | null {
  const raw = String(buyIn?.communityVerdict ?? "").trim().toLowerCase();
  if (raw !== "same_building" && raw !== "same_community" && raw !== "different") return null;
  const verdict = raw as CommunityVerdict;

  const label =
    verdict === "same_building"
      ? "✓ Same building"
      : verdict === "same_community"
        ? "✓ Same community"
        : "✕ Not the same community";

  const source = String(buyIn?.communityVerdictSource ?? "").trim();
  const atRaw = buyIn?.communityVerdictAt;
  const at = atRaw ? new Date(atRaw as string | Date) : null;
  // ISO day (not toLocaleDateString) so the string is locale-stable in tests.
  const day = at && !Number.isNaN(at.getTime()) ? at.toISOString().slice(0, 10) : null;

  const meaning =
    verdict === "same_building"
      ? "confirmed in the SAME BUILDING"
      : verdict === "same_community"
        ? "confirmed in the same complex/community"
        : "NOT in the same community — review this pairing";
  const title = `Community verified${source ? ` via ${source}` : ""}${day ? ` on ${day}` : ""} — ${meaning}`;

  return { verdict, label, different: verdict === "different", title };
}
