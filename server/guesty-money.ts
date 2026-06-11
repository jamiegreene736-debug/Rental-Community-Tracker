// Canonical extraction of payment / refund / revenue figures from a Guesty
// reservation's `money` object, for all NEW money-reading code (the
// guest-receipt scheduler in server/guest-receipts.ts and the receipts feed in
// the Operations summary).
//
// These functions are copied VERBATIM from the inline closures inside
// `dashboardRevenue30DayHandler` (server/routes.ts). That handler keeps its own
// in-place copies on purpose — it is a load-bearing, operator-verified money
// path and re-pointing its 100+ lines of helpers at this module risked a subtle
// lexical-scope regression (a same-named `paymentAmount` exists elsewhere in
// registerRoutes). So this is a deliberate MIRROR: if you change the math in one
// place, change it in the other. The receipt scheduler reuses these so a
// receipt's amount/date EQUALS the number the revenue tile shows.
//
// Guesty exposes payment data under several shapes depending on account /
// channel / integration version (`money.payments[]`, `money.transactions[]`,
// `money.invoiceItems[]` filtered by type, top-level `reservation.payments[]`),
// so we walk all of them. `reservationPaymentItems` deliberately EXCLUDES
// refunds so a gross-collected figure stays pure; refunds are a separate pass.

export function asNum(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function reservationRevenue(reservation: any): number {
  const money = reservation?.money ?? {};
  const grossFare =
    asNum(money.fareAccommodation) +
    asNum(money.fareCleaning) +
    asNum(money.guestServiceFee) +
    asNum(money.totalTaxes);
  const candidates = [
    money.totalPrice,
    money.fare?.guestPrice,
    grossFare,
    money.totalPaid,
    reservation?.totalPrice,
    reservation?.totalAmount,
  ];
  for (const candidate of candidates) {
    const n = asNum(candidate);
    if (n > 0) return n;
  }
  return 0;
}

export function paymentAmount(payment: any): number {
  return asNum(payment?.amount ?? payment?.paidAmount ?? payment?.collectedAmount ?? payment?.total ?? payment?.value);
}

export function paymentDate(payment: any): Date | null {
  const raw =
    payment?.paidAt ??
    payment?.collectedAt ??
    payment?.processedAt ??
    payment?.paymentDate ??
    payment?.date ??
    payment?.createdAt;
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function paymentDescription(payment: any): string {
  return String(payment?.description ?? payment?.note ?? payment?.label ?? payment?.type ?? payment?.kind ?? "");
}

export function paymentLooksCollected(payment: any): boolean {
  const status = String(payment?.status ?? payment?.paymentStatus ?? "").toLowerCase();
  const description = paymentDescription(payment).toLowerCase();
  if (/(refund|void|fail|declin|cancel|reversal|chargeback)/.test(status + " " + description)) return false;
  if (/(scheduled|pending|unpaid|due|future|authorized|authorization)/.test(status + " " + description)) return false;
  if (payment?.paidAt || payment?.collectedAt || payment?.processedAt) return true;
  return /(paid|captured|collected|succeeded|settled|processed|payment|charge)/.test(status + " " + description);
}

export function reservationPaymentItems(reservation: any): any[] {
  const money = reservation?.money ?? {};
  const items: any[] = [
    ...(Array.isArray(reservation?.payments) ? reservation.payments : []),
    ...(Array.isArray(money?.payments) ? money.payments : []),
    ...(Array.isArray(money?.paymentSchedule) ? money.paymentSchedule : []),
  ];
  if (Array.isArray(money?.transactions)) {
    for (const transaction of money.transactions) {
      const type = String(transaction?.type ?? transaction?.kind ?? "").toLowerCase();
      const status = String(transaction?.status ?? "").toLowerCase();
      if (/refund|void|fail|declin|auth|chargeback/.test(type) && !/captured/.test(type)) continue;
      if (/refund|fail|declin|void|chargeback/.test(status)) continue;
      if (/payment|charge|paid|capture|succeeded|collected/.test(type + " " + status)) items.push(transaction);
    }
  }
  if (Array.isArray(money?.invoiceItems)) {
    for (const item of money.invoiceItems) {
      const type = String(item?.type ?? item?.subType ?? "").toLowerCase();
      if (/payment|paid|charge|capture|collected/.test(type)) items.push(item);
    }
  }
  return items;
}

// Refund accounting. reservationPaymentItems() deliberately EXCLUDES refunds so
// the gross-collected figure stays pure, so this is a SEPARATE pass that pulls
// every refund-shaped row (negative amount, or a refund/reversal/chargeback
// type/status) from money.refunds, money.payments, money.transactions, and the
// top-level refunds array.
export function refundLooksReal(entry: any): boolean {
  const status = String(entry?.status ?? entry?.paymentStatus ?? "").toLowerCase();
  const type = String(entry?.type ?? entry?.kind ?? entry?.subType ?? "").toLowerCase();
  const description = paymentDescription(entry).toLowerCase();
  const blob = `${status} ${type} ${description}`;
  if (/(fail|declin|void|cancel|pending|scheduled|authorized|authorization)/.test(blob)) return false;
  if (/(refund|reversal|chargeback)/.test(blob)) return true;
  // A bare negative payment line is a refund even without a label.
  return paymentAmount(entry) < 0;
}

export function reservationRefundItems(reservation: any): any[] {
  const money = reservation?.money ?? {};
  const pools: any[] = [
    ...(Array.isArray(reservation?.refunds) ? reservation.refunds : []),
    ...(Array.isArray(money?.refunds) ? money.refunds : []),
    ...(Array.isArray(reservation?.payments) ? reservation.payments : []),
    ...(Array.isArray(money?.payments) ? money.payments : []),
    ...(Array.isArray(money?.transactions) ? money.transactions : []),
  ];
  return pools.filter(refundLooksReal);
}

export function refundAmount(entry: any): number {
  return Math.abs(paymentAmount(entry));
}

// ── Receipt-oriented normalizers ──────────────────────────────────────────
// Turn a reservation's raw money rows into deduped, dated, positive-amount
// transaction records the receipt scheduler can drive directly.

export interface ReceiptTransaction {
  amount: number; // always positive
  date: Date;
  dateIso: string; // full ISO timestamp
  description: string;
}

function dedupeTransactions(items: ReceiptTransaction[]): ReceiptTransaction[] {
  const seen = new Set<string>();
  const out: ReceiptTransaction[] = [];
  for (const t of items) {
    const key = `${t.dateIso.slice(0, 10)}|${t.amount.toFixed(2)}|${t.description.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// Real, collected payments (not scheduled/pending/authorized/refunds), each
// with a usable capture date and positive amount.
export function collectedPaymentsForReceipts(reservation: any): ReceiptTransaction[] {
  const out: ReceiptTransaction[] = [];
  for (const item of reservationPaymentItems(reservation)) {
    if (!paymentLooksCollected(item)) continue;
    const amount = paymentAmount(item);
    if (!(amount > 0)) continue;
    const date = paymentDate(item);
    if (!date) continue;
    out.push({ amount, date, dateIso: date.toISOString(), description: paymentDescription(item) });
  }
  return dedupeTransactions(out);
}

// Real refunds issued back to the guest, each with a usable date and positive
// (absolute) amount.
export function realRefundsForReceipts(reservation: any): ReceiptTransaction[] {
  const out: ReceiptTransaction[] = [];
  for (const item of reservationRefundItems(reservation)) {
    const amount = refundAmount(item);
    if (!(amount > 0)) continue;
    const date = paymentDate(item);
    if (!date) continue;
    out.push({ amount, date, dateIso: date.toISOString(), description: paymentDescription(item) });
  }
  return dedupeTransactions(out);
}

// All collected payments as { date(YYYY-MM-DD), amount } for the receipt's
// "payment history" block — sorted oldest-first.
export function paymentHistoryForReceipts(reservation: any): Array<{ date: string; amount: number }> {
  return collectedPaymentsForReceipts(reservation)
    .map((t) => ({ date: t.dateIso.slice(0, 10), amount: t.amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
