// Reactions to NEW photo-listing detections from the WEEKLY scanner (2026-07-12).
//
// Before this module, detection and remediation ran on two independent weekly clocks: the photo
// cron flagged a folder "found on VRBO" (red dashboard badge + popup) and nothing acted until the
// weekly auto-audit cron happened to sweep that property — worst case ~a week of a known repost
// sitting live. The machinery to fix it already existed (the Unit Audit Sweep's photo-fix ladder:
// OTA-found → replace-only rung); this module just closes the latency gap by queuing that sweep the
// moment the scanner flips a folder to "found", plus texting the operator (operator-alerts.ts).
//
// SAFETY POSTURE (load-bearing):
//   - Fires ONLY on FLIPS (non-found → found, the same transitions that write photo_listing_alerts
//     rows) and ONLY from the weekly scheduler path — a folder that STAYS found does not re-queue a
//     sweep every week (the weekly auto-audit cron owns steady-state retries), and on-demand deep
//     checks / the audit sweep's own verify rescans never trigger reactions.
//   - The queued sweep runs with source:"cron", so ALL the unattended-replacement rails apply
//     unchanged: labels-proven shortfall, the 28-day anti-churn cooldown, and the SHARED weekly
//     replacement budget (UNIT_AUDIT_CRON_REPLACE_CAP — deliberately NOT reset here; reactive swaps
//     draw from the same weekly allowance, and a budget block reports attention, never a fail).
//     It also reuses the just-written fresh OTA row (AUDIT_CRON_OTA_FRESH_HOURS) instead of
//     re-spending the Lens budget the detection itself just spent.
//   - startUnitAuditSweep already returns the existing active job when one is queued/running for
//     the property, so multiple folders of one property flipping in a single tick collapse into one
//     sweep, and a flip discovered mid-sweep can't stack a duplicate.
//   - Address-on-OTA hits get a TEXT ONLY: the remedy is a takedown request on someone else's
//     listing — swapping our photos can't fix an address leak, so no sweep is queued for those.
//   - unit-audit-sweep is imported LAZILY (dynamic import) so this module adds no boot-time edge
//     into the sweep's dependency graph from the scanner.
//
// Kill switch: PHOTO_FOUND_AUTO_AUDIT_DISABLED=1 (alerts still send; only the sweep enqueue stops).

import { storage } from "./storage";
import { draftPhotoFolderRef, replacementPhotoFolderRef } from "@shared/photo-folder-utils";
import { unitBuilderData } from "../client/src/data/unit-builder-data";
import { sendOperatorAlert } from "./operator-alerts";

export type OtaPlatformKey = "airbnb" | "vrbo" | "booking";

export type PhotoListingDetection = {
  folder: string;
  // Platforms whose PHOTO verdict flipped non-found → found on this scan.
  photoFoundFlips: OtaPlatformKey[];
  // Platforms whose ADDRESS verdict flipped non-found → found on this scan.
  addressFoundFlips: OtaPlatformKey[];
  matchCount: number;
};

const PLATFORM_LABEL: Record<OtaPlatformKey, string> = {
  airbnb: "Airbnb",
  vrbo: "VRBO",
  booking: "Booking.com",
};

function platformNames(keys: OtaPlatformKey[]): string {
  return keys.map((k) => PLATFORM_LABEL[k] ?? k).join(" + ");
}

export function reactiveAuditDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.PHOTO_FOUND_AUTO_AUDIT_DISABLED ?? "").trim());
}

// Resolve a scanned photo folder to the dashboard property that owns it (positive builder core id
// or negative -draftId) — the inverse of the property→folders aggregation home.tsx does. Mirrors
// the scanner's own resolution order: replacement/draft folder-name refs first (they encode the
// owner), then the static unit-builder map, then the community-draft rows' folder fields.
export async function propertyForScannedFolder(
  folder: string,
): Promise<{ propertyId: number; name: string } | null> {
  const ref = replacementPhotoFolderRef(folder) ?? draftPhotoFolderRef(folder);
  if (ref) {
    if (ref.propertyId > 0) {
      const builder = unitBuilderData.find((b) => b.propertyId === ref.propertyId);
      return { propertyId: ref.propertyId, name: builder?.propertyName ?? `Property ${ref.propertyId}` };
    }
    const draft = await storage.getCommunityDraft(-ref.propertyId).catch(() => null);
    return { propertyId: ref.propertyId, name: draft?.name ?? `Draft ${-ref.propertyId}` };
  }
  for (const builder of unitBuilderData) {
    if (builder.units.some((u) => u.photoFolder === folder)) {
      return { propertyId: builder.propertyId, name: builder.propertyName };
    }
  }
  const drafts = await storage.getCommunityDrafts().catch(() => []);
  for (const draft of drafts) {
    const d = draft as any;
    if (d?.unit1PhotoFolder === folder || d?.unit2PhotoFolder === folder) {
      return { propertyId: -draft.id, name: draft.name };
    }
  }
  return null;
}

// Only queue reactive sweeps for targets the weekly audit cron would sweep anyway: every builder
// core property, but drafts only once they're Guesty-MAPPED — burning a sweep (and possibly a
// SearchAPI replacement search) on a half-finished draft that isn't selling anywhere is waste.
async function reactiveSweepEligible(propertyId: number): Promise<boolean> {
  if (propertyId > 0) return true;
  const map = await storage.getGuestyPropertyMap().catch(() => []);
  return map.some((m) => m.propertyId === propertyId);
}

export async function reactToPhotoListingDetections(d: PhotoListingDetection): Promise<void> {
  try {
    const prop = await propertyForScannedFolder(d.folder);
    const label = prop ? `${prop.name} — ${d.folder}` : d.folder;

    if (d.photoFoundFlips.length > 0) {
      let sweepNote: string;
      if (reactiveAuditDisabled()) {
        sweepNote = "Auto-fix sweep NOT queued (PHOTO_FOUND_AUTO_AUDIT_DISABLED=1) — use the dashboard Replace photos popup";
      } else if (!prop) {
        sweepNote = "Auto-fix sweep NOT queued (folder is not tied to a dashboard property) — use the dashboard Replace photos popup";
      } else if (!(await reactiveSweepEligible(prop.propertyId))) {
        sweepNote = "Auto-fix sweep NOT queued (draft is not connected to Guesty yet)";
      } else {
        // Lazy import keeps the scanner→sweep edge out of the boot-time module graph.
        const { startUnitAuditSweep } = await import("./unit-audit-sweep");
        const res = await startUnitAuditSweep({
          propertyId: prop.propertyId,
          autoFix: true,
          // Same replacement posture as the weekly audit cron — the cron rails (proven shortfall,
          // cooldown, shared weekly budget) are what make unattended replacement safe here too.
          allowReplace: String(process.env.UNIT_AUDIT_CRON_REPLACE ?? "").trim() !== "0",
          source: "cron",
        });
        sweepNote = res.ok
          ? "Auto-fix audit sweep queued (dashboard Audit column tracks it)"
          : `Auto-fix sweep NOT queued (${res.error})`;
      }
      console.error(`[photo-found-reaction] ${d.folder}: photos found on ${platformNames(d.photoFoundFlips)} — ${sweepNote}`);
      await sendOperatorAlert({
        dedupKey: `photo-found:${d.folder}`,
        body:
          `Photo scan: ${label} photos were FOUND on ${platformNames(d.photoFoundFlips)}` +
          `${d.matchCount > 0 ? ` (${d.matchCount} matched listing${d.matchCount === 1 ? "" : "s"})` : ""}. ` +
          `${sweepNote}. The dashboard Photos popup has the offending links.`,
      });
    }

    if (d.addressFoundFlips.length > 0) {
      await sendOperatorAlert({
        dedupKey: `address-found:${d.folder}`,
        body:
          `Photo scan: ${label} street address surfaced on ${platformNames(d.addressFoundFlips)}. ` +
          `A photo swap cannot fix an address leak — request a takedown on the listing. ` +
          `The dashboard address popup has the links.`,
      });
    }
  } catch (e: any) {
    // Reactions are best-effort; the scan result is already persisted.
    console.error(`[photo-found-reaction] failed for ${d.folder}: ${e?.message ?? e}`);
  }
}
