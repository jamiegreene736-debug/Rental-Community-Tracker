// Global kill-switch for AUTOMATED (scheduler-driven) sidecar scans.
//
// Operator-initiated sidecar work (find-buy-in, city-vrbo, auto-fill, the bulk
// queue — all HTTP-triggered by a click) is NEVER affected. This pauses only the
// unattended schedulers that drive the local Chrome sidecar on a timer:
//   - the Sourceability Gate sweep (server/sourceability-gate.ts)
//   - the weekly Monday-3am availability OTA scan (server/availability-scanner.ts)
// Add the guard to any future automated sidecar driver too.
//
// Two ways to pause, checked in order:
//   1. env SIDECAR_AUTOMATION_PAUSED = 1/true (hard override; survives nothing
//      else can re-enable) or 0/false (hard force-on).
//   2. a persisted app_settings toggle the operator flips from the Operations
//      sidecar control (POST /api/admin/sidecar-automation/toggle).
// Default (neither set) = NOT paused, so intended automation keeps working.
//
// NOTE: this cannot stop the OFF-REPO inventory-feed sweep (it isn't in this
// codebase); that requires a clean redeploy from `main`. See AGENTS.md
// Decision Log 2026-06-15.

import { storage } from "./storage";

const SETTING_KEY = "sidecar.automation_paused.v1";

export async function isSidecarAutomationPaused(): Promise<boolean> {
  const env = (process.env.SIDECAR_AUTOMATION_PAUSED ?? "").trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes") return true;
  if (env === "0" || env === "false" || env === "no") return false;
  try {
    const v = await storage.getSetting(SETTING_KEY);
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

export async function setSidecarAutomationPaused(paused: boolean): Promise<void> {
  await storage.setSetting(SETTING_KEY, paused ? "true" : "false");
}

/** {paused, source} — source tells the UI whether an env override is forcing it. */
export async function getSidecarAutomationState(): Promise<{ paused: boolean; envOverride: boolean }> {
  const env = (process.env.SIDECAR_AUTOMATION_PAUSED ?? "").trim().toLowerCase();
  const envOverride = ["1", "true", "yes", "0", "false", "no"].includes(env);
  return { paused: await isSidecarAutomationPaused(), envOverride };
}
