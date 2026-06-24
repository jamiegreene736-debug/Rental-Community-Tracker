// Pure helpers for reading a Guesty reservation's payment SCHEDULE — specifically
// "when is the guest's next payment due". Extracted from
// client/src/pages/bookings.tsx so the logic can be regression-tested against
// real Guesty payment shapes.
//
// THE LOAD-BEARING FACT (operator-caught on reservation BC-9jpBrRM5Y, where
// Guesty's UI said "Next payment $5,224 on Jul 24, 2026" but our column showed
// "May 6, 2026"):
//   • Guesty stamps a scheduled / auto-payment row's charge date on
//     `shouldBePaidAt`. That is the date Guesty's reservation Payments page
//     surfaces as "Next payment $X on <date>". It is NOT in
//     dueAt/dueDate/scheduledAt/chargeDate.
//   • A scheduled row's `createdAt` is when the schedule row was CREATED
//     (≈ booking time), NOT when the charge is due. Falling back to it made the
//     "Payment next due" column show the booking month instead of the real
//     future charge. So `createdAt` is DELIBERATELY ABSENT from the field list
//     below — a scheduled row with no real due-date field resolves to null
//     (shown as "—") rather than a misleading creation date.
//
// Verified shape of the PENDING (scheduled) payment row that exposed the bug:
//   { status: "PENDING", amount: 5224, shouldBePaidAt: "2026-07-25T01:00:00.000Z",
//     createdAt: "2026-05-07T03:06:10.396Z" }   // no dueAt / paidAt

export type GuestyPaymentRow = Record<string, unknown>;

// Ordered by Guesty authority. `shouldBePaidAt` FIRST; `createdAt` intentionally
// excluded (see the header note). Earlier fields win.
export const SCHEDULED_CHARGE_DATE_FIELDS = [
  "shouldBePaidAt",
  "dueAt",
  "dueDate",
  "scheduledAt",
  "scheduledFor",
  "chargeDate",
  "chargeAt",
  "paymentDate",
  "date",
] as const;

// The ISO date string a Guesty payment row is scheduled to be charged on, or
// null when none of the schedule fields are present.
export function scheduledChargeDateIso(payment: GuestyPaymentRow | null | undefined): string | null {
  if (!payment || typeof payment !== "object") return null;
  for (const field of SCHEDULED_CHARGE_DATE_FIELDS) {
    const raw = (payment as Record<string, unknown>)[field];
    if (typeof raw === "string" && raw.trim()) return raw;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString();
  }
  return null;
}

function paymentTextBlob(payment: GuestyPaymentRow): { status: string; description: string } {
  const status = String((payment as any)?.status ?? "").toLowerCase();
  const description = String(
    (payment as any)?.description ??
      (payment as any)?.note ??
      (payment as any)?.label ??
      (payment as any)?.type ??
      (payment as any)?.kind ??
      "",
  ).toLowerCase();
  return { status, description };
}

// Mirror of bookings.tsx `paymentLooksCollected` (kept byte-equivalent so the
// classification used here matches the Expected Deposits tab).
export function paymentRowLooksCollected(payment: GuestyPaymentRow): boolean {
  const { status, description } = paymentTextBlob(payment);
  if (/(refund|void|fail|declin|cancel)/.test(status) || /(refund|void|fail|declin|cancel)/.test(description)) return false;
  if (/(scheduled|pending|unpaid|due|future)/.test(status)) return false;
  if ((payment as any)?.paidAt || (payment as any)?.collectedAt || (payment as any)?.processedAt) return true;
  return /(paid|captured|collected|succeeded|settled|payment|charge)/.test(status + " " + description);
}

// Mirror of bookings.tsx `paymentLooksScheduled`.
export function paymentRowLooksScheduled(payment: GuestyPaymentRow): boolean {
  if (paymentRowLooksCollected(payment)) return false;
  const { status, description } = paymentTextBlob(payment);
  return /(scheduled|pending|unpaid|due|future|installment|payment)/.test(status + " " + description);
}

// The date of the guest's NEXT due payment per Guesty: the earliest scheduled
// (not-yet-collected) charge. Prefer the soonest still-upcoming date (tolerating
// "due today"); if every scheduled date is already past, fall back to the
// earliest outstanding one. Returns null when there is no scheduled charge.
export function nextScheduledChargeDate(
  payments: Array<GuestyPaymentRow | null | undefined>,
  nowMs: number,
): Date | null {
  const dates = (Array.isArray(payments) ? payments : [])
    .filter((p): p is GuestyPaymentRow => !!p && typeof p === "object")
    .filter(paymentRowLooksScheduled)
    .map(scheduledChargeDateIso)
    .filter((iso): iso is string => !!iso)
    .map((iso) => new Date(iso))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return null;
  const cutoff = nowMs - 24 * 60 * 60 * 1000; // still surface a "due today" date
  return dates.find((d) => d.getTime() >= cutoff) ?? dates[0];
}
