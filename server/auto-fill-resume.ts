// ── boot resume: searches survive deploys ────────────────────────────────────
// Railway deploys land every ~10 minutes from concurrent sessions, and each one
// SIGTERMs the old process — which used to kill every in-flight buy-in search
// (observed 2026-06-10: a live bulk queue at 16:13Z and Cecilio Marquez's
// nearby-town expansion at 02:21Z, both silently). The durable layer now
// persists everything needed to continue:
//   • auto_fill_loss_options: per-reservation row with status running/
//     interrupted + the FULL StartAutoFillInput (request) + jobId + owner.
//   • bulk_auto_fill_state: the whole bulk queue snapshot (items + _input).
// This module, called once from server/index.ts AFTER the HTTP server is
// listening (the ladder self-calls over loopback, so the port must be live),
// restarts what died:
//   1. The bulk queue first (same bulkJobId; terminal items keep results; the
//      mid-flight item re-queues). Its per-item auto-fill jobs are owner="bulk"
//      and are NOT resumed standalone — the queue re-runs them itself.
//   2. Standalone (owner="row") searches, re-registered under their original
//      jobId so an operator's still-open poller keeps working.
// Safety rails: resume window (default 3h — don't resurrect ancient rows after
// a long outage), attempt cap (default 2 — a search that keeps killing the
// server must not crash-loop it forever; capped rows are stamped interrupted
// with an explanatory error and left for manual re-run).

import { storage } from "./storage";
import { resumeBulkAutoFillJob } from "./bulk-auto-fill-job";
import { startAutoFillJob, type StartAutoFillInput } from "./auto-fill-job";

const RESUME_WINDOW_MS = Math.max(10 * 60_000, Number(process.env.AUTO_FILL_RESUME_WINDOW_MS ?? 3 * 60 * 60 * 1000));
const RESUME_MAX_ATTEMPTS = Math.max(1, Number(process.env.AUTO_FILL_RESUME_MAX_ATTEMPTS ?? 2));

export async function resumeInterruptedAutoFillWork(): Promise<void> {
  if ((process.env.AUTO_FILL_RESUME ?? "1") === "0") return;

  // ── 1. bulk queue ──
  const bulkOwnedReservations = new Set<string>();
  try {
    const row = await storage.getLatestBulkAutoFillState();
    const fresh = row?.updatedAt && Date.now() - new Date(row.updatedAt).getTime() < RESUME_WINDOW_MS;
    const attempts = row?.resumeAttempts ?? 0;
    if (row && (row.status === "running" || row.status === "interrupted") && fresh) {
      // Every reservation in the snapshot is queue-owned — standalone resume
      // must skip them even if the queue itself is too crash-looped to resume.
      for (const it of ((row.state as any)?.items ?? [])) {
        if (it?.reservationId) bulkOwnedReservations.add(String(it.reservationId));
      }
      if (attempts < RESUME_MAX_ATTEMPTS) {
        // Bump the attempt counter DURABLY BEFORE starting the resumed queue —
        // matching the standalone-row path below. If the resumed queue crash-loops
        // the server faster than runBulkJob's own snapshot can land, the increment
        // must already be written or the 2-attempt cap never engages and the queue
        // resurrects forever. (resumeBulkAutoFillJob only starts the in-memory loop;
        // the caller owns the durable counter.)
        await storage.upsertBulkAutoFillState({ id: row.id, status: "running", state: row.state, resumeAttempts: attempts + 1 });
        const resumed = resumeBulkAutoFillJob(row.state, attempts + 1);
        if (resumed) {
          console.log(`[auto-fill-resume] resumed bulk queue ${resumed.bulkJobId} (attempt ${attempts + 1}/${RESUME_MAX_ATTEMPTS})`);
        } else {
          // Unusable snapshot OR an operator already started a fresh queue on
          // this process (operator wins). Stamp the row terminal either way so
          // a corrupt/superseded snapshot can't retry on every boot.
          await storage.upsertBulkAutoFillState({ id: row.id, status: "completed", state: row.state, resumeAttempts: attempts + 1 });
          console.warn(`[auto-fill-resume] bulk queue ${row.id} not resumed (superseded or unusable snapshot) — stamped terminal`);
        }
      } else {
        await storage.upsertBulkAutoFillState({ id: row.id, status: "completed", state: row.state, resumeAttempts: attempts });
        console.warn(`[auto-fill-resume] bulk queue ${row.id} hit the ${RESUME_MAX_ATTEMPTS}-resume cap — not resurrecting (re-start it manually)`);
      }
    }
  } catch (e: any) {
    console.error("[auto-fill-resume] bulk resume failed:", e?.message ?? e);
  }

  // ── 2. standalone row searches ──
  try {
    const rows = await storage.getResumableAutoFillRows(new Date(Date.now() - RESUME_WINDOW_MS));
    for (const row of rows) {
      const attempts = row.resumeAttempts ?? 0;
      const request = row.request as StartAutoFillInput | null;
      if (row.owner === "bulk" || bulkOwnedReservations.has(row.reservationId)) continue; // queue re-runs these
      if (!request || typeof request !== "object" || !request.reservationId) {
        // Pre-feature row (no persisted request) — display-only; /auto-fill/last
        // shows it as interrupted, but there's nothing to restart from.
        console.log(`[auto-fill-resume] skipping ${row.reservationId} — no persisted request (pre-feature row)`);
        continue;
      }
      if (attempts >= RESUME_MAX_ATTEMPTS) {
        await storage.markAutoFillSearchInterrupted(
          row.reservationId,
          `Search was interrupted by server restarts ${attempts} time(s) and won't auto-resume again — re-run Auto-fill manually.`,
        );
        continue;
      }
      try {
        // Bump the attempt counter DURABLY before starting: if the resumed
        // search crash-loops the server faster than startAutoFillJob's own
        // fire-and-forget stamp can land, the counter must already be written
        // or the cap never engages.
        await storage.markAutoFillSearchStarted({
          reservationId: row.reservationId,
          propertyId: row.propertyId,
          slotsTotal: row.slotsTotal,
          request,
          jobId: row.jobId,
          owner: row.owner ?? "row",
          resumeAttempts: attempts + 1,
        });
        // NO forceRestart (review finding 2026-06-10): if the operator already
        // re-ran this reservation in the boot window, single-flight REUSES their
        // live job instead of superseding it — operator intent wins. A fresh
        // resume re-reads attached state from the DB regardless (refreshFilled),
        // so forceRestart adds nothing here.
        //
        // KNOWN EDGE (deliberate): if the dead run attached PART of a combo, the
        // resumed run sees it as a filled slot and tries to complete the combo —
        // usually the best outcome. If it can't fill the partner, the lone unit
        // stays attached (visible in the row; same as a pre-feature crash). We do
        // NOT auto-detach it: a unit attached mid-window is indistinguishable
        // from an operator's manual attach, and silently detaching those is the
        // worse failure.
        const { jobId } = startAutoFillJob({
          ...request,
          forceRestart: false,
          resumeJobId: row.jobId ?? undefined,
          resumeAttempt: attempts + 1,
        });
        console.log(`[auto-fill-resume] resumed search for reservation ${row.reservationId} as ${jobId} (attempt ${attempts + 1}/${RESUME_MAX_ATTEMPTS})`);
      } catch (e: any) {
        console.error(`[auto-fill-resume] could not resume ${row.reservationId}:`, e?.message ?? e);
      }
    }
  } catch (e: any) {
    console.error("[auto-fill-resume] row resume failed:", e?.message ?? e);
  }
}
