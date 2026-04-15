// Auto-Approve Airbnb Reservation Requests
// Polls Guesty every 15 minutes for pending inquiries on the Airbnb channel
// and automatically confirms them.

import { guestyRequest } from "./guesty-sync";

let _autoApproveEnabled = true;
let _lastRunAt: Date | null = null;
let _lastRunResult: { approved: number; errors: number; message: string } | null = null;

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

export async function runAutoApprove(): Promise<{ approved: number; errors: number; message: string }> {
  if (!_autoApproveEnabled) {
    return { approved: 0, errors: 0, message: "Auto-approve is disabled" };
  }

  console.log("[auto-approve] Checking for pending Airbnb reservation requests...");
  let approved = 0;
  let errors = 0;

  try {
    const data = await guestyRequest(
      "GET",
      "/reservations?status[]=inquiry&status[]=awaitingPayment&limit=50&fields=_id%20status%20integration%20source"
    ) as any;

    const reservations: any[] = data?.results ?? [];
    const airbnbPending = reservations.filter((r: any) => {
      const src = (r.integration?.platform ?? r.source ?? "").toLowerCase();
      return src.includes("airbnb");
    });

    console.log(`[auto-approve] Found ${airbnbPending.length} pending Airbnb request(s)`);

    for (const res of airbnbPending) {
      try {
        await guestyRequest("PUT", `/reservations/${res._id}/confirm`, {});
        console.log(`[auto-approve] Confirmed reservation ${res._id}`);
        approved++;
      } catch (err: any) {
        console.error(`[auto-approve] Failed to confirm ${res._id}:`, err?.message ?? err);
        errors++;
      }
    }
  } catch (err: any) {
    console.error("[auto-approve] Failed to fetch pending reservations:", err?.message ?? err);
    errors++;
  }

  _lastRunAt = new Date();
  _lastRunResult = {
    approved,
    errors,
    message: approved > 0
      ? `Auto-approved ${approved} Airbnb request${approved > 1 ? "s" : ""}`
      : errors > 0
      ? `Encountered ${errors} error(s) while checking`
      : "No pending Airbnb requests found",
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
