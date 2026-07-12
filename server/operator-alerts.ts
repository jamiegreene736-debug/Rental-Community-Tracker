// Operator SMS alerts — the proactive channel for UNATTENDED findings (2026-07-12).
//
// The dashboard already raises red popups for photo/address OTA hits and the audit column shows ⚠
// attention verdicts, but all of that only reaches the operator when he happens to open the
// dashboard. The weekly crons run at all hours; the cases wired through here are exactly the ones
// the automation deliberately will NOT fix on its own:
//   - a folder's photos flipped to FOUND on an OTA (the reactive sweep is queued, but he should
//     know it happened),
//   - a street address surfaced on an OTA listing page (remedy = takedown request, never automated),
//   - a cron replacement was blocked by the anti-churn cooldown or the per-run budget (a human
//     decision: force a manual sweep or let next week's run retry).
//
// Delivery reuses the EXISTING Quo/OpenPhone sender (sendQuoSms with conversationId:null — the same
// conversation-less posture the refund-receipt SMS leg uses), so there is no second SMS integration
// to maintain. Everything here is FAIL-SOFT: no configured phone, no QUO_API_KEY, or a provider
// error logs and returns false — an alert failure must never break a scan or a sweep.
//
// Activation: set OPERATOR_ALERT_PHONE (the operator's personal cell, E.164 or US 10-digit) in
// Railway. Unset = alerts are silently skipped (logged once per boot), so this ships dormant and
// costs nothing until the operator opts in.

import { storage } from "./storage";
import { sendQuoSms } from "./quo-sms";

const RECENT_ALERTS_SETTING_KEY = "operator_alerts.recent.v1";
// Default dedup window: 6 days — just under the weekly cadences, so a condition that persists
// week over week (e.g. a unit stuck on cooldown) re-alerts once per weekly run, never per tick.
const DEFAULT_DEDUP_HOURS = 24 * 6;
const MAX_RECENT_ENTRIES = 300;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function operatorAlertPhone(): string {
  return String(process.env.OPERATOR_ALERT_PHONE ?? "").trim();
}

let warnedUnconfigured = false;

function parseRecentMap(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function pruneRecentMap(map: Record<string, string>, now: number): Record<string, string> {
  const entries = Object.entries(map)
    .map(([key, iso]) => ({ key, iso, at: new Date(iso).getTime() }))
    .filter((e) => Number.isFinite(e.at) && now - e.at < PRUNE_AFTER_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_RECENT_ENTRIES);
  const out: Record<string, string> = {};
  for (const e of entries) out[e.key] = e.iso;
  return out;
}

// All alert sends are serialized through one promise tail so two concurrent callers (scanner tick +
// a running sweep) can't interleave read-modify-write on the dedup map (the app_settings promise-
// tail pattern used by the job stores).
let tail: Promise<unknown> = Promise.resolve();

export function sendOperatorAlert(input: {
  body: string;
  // Stable key for the underlying CONDITION (e.g. "photo-found:<folder>"), not the message text —
  // repeated detections of the same condition inside the dedup window send exactly one text.
  dedupKey: string;
  dedupHours?: number;
}): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    try {
      const phone = operatorAlertPhone();
      if (!phone) {
        if (!warnedUnconfigured) {
          warnedUnconfigured = true;
          console.log("[operator-alerts] OPERATOR_ALERT_PHONE is not set — operator SMS alerts are skipped (set it in Railway to activate)");
        }
        return false;
      }
      const body = String(input.body ?? "").trim().slice(0, 1500);
      const dedupKey = String(input.dedupKey ?? "").trim();
      if (!body || !dedupKey) return false;

      const now = Date.now();
      const dedupMs = Math.max(0, (input.dedupHours ?? DEFAULT_DEDUP_HOURS) * 60 * 60 * 1000);
      const raw = await storage.getSetting(RECENT_ALERTS_SETTING_KEY).catch(() => undefined);
      const recent = parseRecentMap(raw ?? null);
      const lastAt = recent[dedupKey] ? new Date(recent[dedupKey]).getTime() : NaN;
      if (dedupMs > 0 && Number.isFinite(lastAt) && now - lastAt < dedupMs) {
        console.log(`[operator-alerts] skipping duplicate alert (${dedupKey}) — last sent ${recent[dedupKey]}`);
        return false;
      }

      await sendQuoSms({ conversationId: null, to: phone, body });
      console.log(`[operator-alerts] sent (${dedupKey}): ${body.slice(0, 120)}`);

      recent[dedupKey] = new Date(now).toISOString();
      await storage
        .setSetting(RECENT_ALERTS_SETTING_KEY, JSON.stringify(pruneRecentMap(recent, now)))
        .catch((e: any) => console.error(`[operator-alerts] failed to persist dedup map: ${e?.message ?? e}`));
      return true;
    } catch (e: any) {
      // Fail-soft by contract: a missing QUO_API_KEY or a provider error must never break the
      // scanner tick or an audit sweep that fired the alert.
      console.error(`[operator-alerts] send failed (${input.dedupKey}): ${e?.message ?? e}`);
      return false;
    }
  };
  const next = tail.then(run, run);
  tail = next.catch(() => false);
  return next as Promise<boolean>;
}
