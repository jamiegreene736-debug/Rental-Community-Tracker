// Decision logic for the bulk combo queue's POST-SAVE OTA deep scan gate.
//
// The photo-sourcing stage already OTA-preflights each candidate (3-photo Lens +
// address SERP), but that is a cheap screen over a slice of the gallery. After
// the draft's photos are persisted, the queue runs the SAME deep scanner the
// dashboard Photos column / weekly cron use (`runPhotoListingCheckForFolders`,
// full deduped gallery + address leg) over `draft-<id>-unit-a/-unit-b` and feeds
// the per-platform verdicts through this pure gate.
//
// POSTURE (mirrors shared/combo-photo-community-gate.ts — an explicit operator
// decision, 2026-07-06): skip ONLY on a POSITIVE `found`; anything the scanner
// could not decide (`unknown`, missing folder result, scan crash) PUBLISHES, so
// a SearchAPI outage can never silently skip an entire batch. A skip means the
// unit's photos are provably live on Airbnb/VRBO/Booking — the one thing a combo
// listing must never be built from.

export type ComboOtaScanFolderResult = {
  folder: string;
  /** Operator-facing unit label, e.g. "Unit A". */
  label?: string;
  airbnbStatus?: string | null;
  vrboStatus?: string | null;
  bookingStatus?: string | null;
};

export type ComboOtaScanGateDecision = {
  decision: "skip" | "publish";
  /** True when nothing could be verified (no results at all) — publish, but flagged. */
  infra: boolean;
  reasons: string[];
};

const PLATFORM_LABELS: Array<{ key: "airbnbStatus" | "vrboStatus" | "bookingStatus"; label: string }> = [
  { key: "airbnbStatus", label: "Airbnb" },
  { key: "vrboStatus", label: "VRBO" },
  { key: "bookingStatus", label: "Booking.com" },
];

export function evaluateComboOtaScanGate(
  results: Array<ComboOtaScanFolderResult | null | undefined>,
  expectedFolders: string[],
): ComboOtaScanGateDecision {
  const rows = results.filter((r): r is ComboOtaScanFolderResult => !!r && typeof r.folder === "string");
  if (rows.length === 0) {
    return { decision: "publish", infra: true, reasons: ["OTA deep scan returned no results (infra) — published without the gate"] };
  }
  const reasons: string[] = [];
  for (const row of rows) {
    const foundOn = PLATFORM_LABELS
      .filter(({ key }) => String(row[key] ?? "").toLowerCase() === "found")
      .map(({ label }) => label);
    if (foundOn.length > 0) {
      reasons.push(`${row.label || row.folder} photos were found live on ${foundOn.join(" + ")}`);
    }
  }
  if (reasons.length > 0) return { decision: "skip", infra: false, reasons };
  const missing = expectedFolders.filter((f) => !rows.some((r) => r.folder === f));
  if (missing.length > 0) {
    // Partial coverage is still a publish (fail-open), but say so honestly.
    return {
      decision: "publish",
      infra: true,
      reasons: [`OTA deep scan could not verify ${missing.join(", ")} — published without full coverage`],
    };
  }
  return { decision: "publish", infra: false, reasons: [] };
}
