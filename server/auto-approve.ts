// Auto-Approve Airbnb Reservation Requests
// Polls Guesty every 15 minutes for pending Airbnb inquiries / requests and
// sends the Guesty-supported channel action. Guesty does not support the older
// /reservations/:id/confirm action for these Airbnb channel records.

import { guestyRequest } from "./guesty-sync";

let _autoApproveEnabled = true;
let _lastRunAt: Date | null = null;
let _lastRunResult: { approved: number; errors: number; skipped?: number; message: string } | null = null;

export function getAutoApproveStatus() {
  return {
    enabled: _autoApproveEnabled,
    lastRunAt: _lastRunAt,
    lastRunResult: _lastRunResult,
  };
}

export function setAutoApproveEnabled(enabled: boolean) {
  _autoApproveEnabled = enabled;
  console.log(`[auto-approve] ${enabled ? "Enabled" : "Disabled"}`);
}

function guestyErrorStatus(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const m = /Guesty\s+(\d{3})/.exec(message);
  return m ? parseInt(m[1], 10) : undefined;
}

function isAirbnbReservation(reservation: any): boolean {
  const src = String(
    reservation?.integration?.platform
      ?? reservation?.integration?.source
      ?? reservation?.source
      ?? reservation?.channel
      ?? "",
  ).toLowerCase();
  return src.includes("airbnb");
}

function isAlreadyPreApproved(reservation: any): boolean {
  return reservation?.preApproveState === true
    || reservation?.preApproved === true
    || String(reservation?.preApprovalStatus ?? "").toLowerCase() === "preapproved";
}

function pendingAirbnbStatus(reservation: any): boolean {
  const status = String(reservation?.status ?? "").toLowerCase();
  return status === "inquiry"
    || status === "reserved"
    || status === "awaitingpayment"
    || status === "pending";
}

async function preApproveAirbnbInquiry(reservationId: string): Promise<"preapproved" | "already"> {
  try {
    await guestyRequest("POST", `/reservations-v3/${reservationId}/pre-approve`, {});
    return "preapproved";
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const status = guestyErrorStatus(err);
    if (status === 400 && /duplicate|already/i.test(message)) {
      return "already";
    }
    throw err;
  }
}

async function approveAirbnbRequest(reservationId: string): Promise<"approved" | "already"> {
  try {
    await guestyRequest("POST", `/reservations-v3/${reservationId}/approve`, {});
    return "approved";
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const status = guestyErrorStatus(err);
    if (status === 400 && /duplicate|already|confirmed|approved/i.test(message)) {
      return "already";
    }
    throw err;
  }
}

export async function runAutoApprove(): Promise<{ approved: number; errors: number; skipped?: number; message: string }> {
  if (!_autoApproveEnabled) {
    return { approved: 0, errors: 0, message: "Auto-approve is disabled" };
  }

  console.log("[auto-approve] Checking for pending Airbnb inquiries/requests...");
  let approved = 0;
  let errors = 0;
  let skipped = 0;

  try {
    const data = await guestyRequest(
      "GET",
      "/reservations?status[]=inquiry&status[]=reserved&status[]=awaitingPayment&status[]=pending&limit=50&fields=_id%20status%20integration%20source%20channel%20preApproveState%20preApproved%20preApprovalStatus"
    ) as any;

    const reservations: any[] = data?.results ?? [];
    const airbnbRecords = reservations.filter(isAirbnbReservation);
    const airbnbPending = airbnbRecords.filter(pendingAirbnbStatus);

    console.log(`[auto-approve] Found ${airbnbPending.length} pending Airbnb record(s) (${airbnbRecords.length} Airbnb record(s) returned by Guesty)`);

    for (const res of airbnbPending) {
      const status = String(res?.status ?? "").toLowerCase();
      if (isAlreadyPreApproved(res)) {
        console.log(`[auto-approve] Skipped ${res._id}: already pre-approved`);
        skipped++;
        continue;
      }
      try {
        if (status === "inquiry") {
          const result = await preApproveAirbnbInquiry(res._id);
          console.log(`[auto-approve] ${result === "already" ? "Already pre-approved" : "Pre-approved"} Airbnb inquiry ${res._id}`);
        } else if (status === "reserved") {
          const result = await approveAirbnbRequest(res._id);
          console.log(`[auto-approve] ${result === "already" ? "Already approved" : "Approved"} Airbnb request ${res._id} (status=${res?.status ?? "unknown"})`);
        } else {
          console.log(`[auto-approve] Skipped ${res._id}: status=${res?.status ?? "unknown"} is not eligible for Guesty auto-approval`);
          skipped++;
          continue;
        }
        approved++;
      } catch (err: any) {
        console.error(`[auto-approve] Failed to approve/pre-approve ${res._id}:`, err?.message ?? err);
        errors++;
      }
    }
  } catch (err: any) {
    console.error("[auto-approve] Failed to fetch pending Airbnb inquiries/requests:", err?.message ?? err);
    errors++;
  }

  _lastRunAt = new Date();
  _lastRunResult = {
    approved,
    errors,
    skipped,
    message: approved > 0
      ? `Approved/pre-approved ${approved} Airbnb request${approved > 1 ? "s" : ""}${skipped > 0 ? `; skipped ${skipped}` : ""}`
      : errors > 0
      ? `Encountered ${errors} error(s) while checking`
      : skipped > 0
      ? `No new Airbnb inquiries needed pre-approval; skipped ${skipped}`
      : "No pending Airbnb inquiries/requests found",
  };

  return _lastRunResult;
}

export function startAutoApproveScheduler() {
  runAutoApprove().catch(() => {});

  const INTERVAL_MS = 15 * 60 * 1000;
  setInterval(() => {
    runAutoApprove().catch(() => {});
  }, INTERVAL_MS);

  console.log("[auto-approve] Scheduler started (every 15 minutes)");
}
