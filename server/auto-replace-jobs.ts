// One-click "Auto replace unit photos" orchestrator (dashboard duplicate-photos
// warning). Chains the EXISTING machinery server-side so the operator's click
// is fire-and-forget:
//
//   1. finding    — start the replacement-find background job (same engine as
//                   the manual flow; restart-survivable per PR #899).
//   2. committing — auto-commit the first viable candidate via loopback
//                   POST /api/unit-swaps (the route owns every dedup guard +
//                   photo hydration). A 409 duplicate-source rejection burns
//                   that URL and falls through to the next option.
//   3. verifying  — kick the deep OTA rescan of the new replacement folder +
//                   the Claude-vision photo-community check (both existing
//                   endpoints), then complete. The dashboard's own polling
//                   refreshes the duplicate-photos indicators as those land.
//
// Records persist in app_settings (shared/auto-replace-job-logic.ts) and a
// boot/interval watchdog resumes orphaned jobs after a Railway restart —
// the phone can be in another app the whole time. Pure decisions are
// unit-tested in tests/auto-replace-job.test.ts.

import { getUnitBuilderByPropertyId } from "../client/src/data/unit-builder-data";
import { inferCommunityStreetAddress } from "@shared/community-addresses";
import { parseStreetCityState } from "@shared/address-listing-logic";
import { latestUnitSwapsByUnit, replacementPhotoFolderForUnit } from "@shared/unit-swap-photos";
import { resolveCanonicalCommunityPhotoFolder } from "@shared/community-photo-folders";
import { resolveDraftUnitBedrooms } from "@shared/draft-unit-bedrooms";
import {
  AUTO_REPLACE_STORE_SETTING_KEY,
  MAX_AUTO_REPLACE_FIND_RESTARTS,
  STUCK_AUTO_REPLACE_ERROR,
  clearableAutoReplaceJobIds,
  parseDraftUnitId,
  failStuckAutoReplaceRecords,
  findActiveAutoReplaceJob,
  isAutoReplacePhaseActive,
  nextStepFromFindJob,
  parseAutoReplaceStore,
  pickCommitCandidate,
  serializeAutoReplaceStore,
  shouldResumeAutoReplaceJob,
  summarizeAutoReplaceQueue,
  type AutoReplaceJobRecord,
  type AutoReplacePhase,
} from "@shared/auto-replace-job-logic";
import {
  getPersistedReplacementFindJob,
  getPreflightReplacementFindJob,
  startPreflightReplacementFindJob,
} from "./preflight-background-jobs";
import { repushGuestyPhotosForProperty } from "./guesty-photo-repush";
import { loopbackRequestHeaders } from "./auth";
import { storage } from "./storage";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

const FIND_POLL_INTERVAL_MS = 5_000;
// The exhaustive manual search can run long; the auto flow uses first-hit mode
// so ~45 min is a generous ceiling before declaring the find leg stuck.
const FIND_WAIT_CEILING_MS = 45 * 60 * 1000;
// Consecutive "restart" poll signals required before launching a fresh search
// (~15s at the poll interval) — a lone signal can be a store blip/write lag.
const RESTART_SIGNAL_CONFIRM_POLLS = 3;

const jobs = new Map<string, AutoReplaceJobRecord>();
const activeJobIds = new Set<string>();

let storeTail: Promise<void> = Promise.resolve();
function mutateStore(mutate: (store: Record<string, AutoReplaceJobRecord>, nowMs: number) => void): Promise<void> {
  storeTail = storeTail.then(async () => {
    try {
      const now = Date.now();
      const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY);
      const store = parseAutoReplaceStore(raw ?? null);
      mutate(store, now);
      await storage.setSetting(AUTO_REPLACE_STORE_SETTING_KEY, serializeAutoReplaceStore(store, now));
    } catch {
      // Fail-soft: persistence is an upgrade, never a blocker.
    }
  });
  return storeTail;
}

function touch(record: AutoReplaceJobRecord, patch: Partial<AutoReplaceJobRecord>): void {
  Object.assign(record, patch, { updatedAt: Date.now() });
  jobs.set(record.jobId, record);
  void mutateStore((store) => {
    store[record.jobId] = { ...record };
  });
}

// Unified property/unit resolution — the one seam that makes the flow work for
// BOTH the 11 hardcoded builder properties (positive ids, unit-builder-data)
// and promoted community drafts (negative ids, community_drafts rows). Draft
// unit ids follow adapt-draft.ts's `draft<id>-unit-a/b`; the community folder
// mirrors its canonical-name resolution so the find job's community gates see
// the same folder the builder UI uses. 2026-07-05: draft rows in the
// duplicate-photos popup previously had NO replace path at all.
type AutoReplaceTarget = {
  isDraft: boolean;
  communityFolder: string;
  communityName: string;
  propertyName: string;
  address: string;
  street?: string;
  city?: string;
  state?: string;
  unit: { id: string; unitNumber: string; bedrooms: number };
  unitIndex: number;
};

async function resolveAutoReplaceTarget(propertyId: number, unitId: string): Promise<AutoReplaceTarget | null> {
  if (Number.isFinite(propertyId) && propertyId > 0) {
    const builder = getUnitBuilderByPropertyId(propertyId);
    if (!builder?.communityPhotoFolder) return null;
    const index = builder.units.findIndex((u) => u.id === unitId);
    if (index < 0) return null;
    const unit = builder.units[index];
    const parsed = parseStreetCityState(builder.address ?? "");
    return {
      isDraft: false,
      communityFolder: builder.communityPhotoFolder,
      communityName: builder.complexName,
      propertyName: builder.propertyName || builder.complexName,
      address: builder.address ?? "",
      street: parsed.street || undefined,
      city: parsed.city || undefined,
      state: parsed.state || undefined,
      unit: { id: unit.id, unitNumber: unit.unitNumber ?? "", bedrooms: unit.bedrooms },
      unitIndex: index,
    };
  }
  if (!Number.isFinite(propertyId) || propertyId >= 0) return null;
  const ref = parseDraftUnitId(unitId);
  if (!ref || ref.draftId !== -propertyId) return null;
  const draft = await storage.getCommunityDraft(ref.draftId).catch(() => undefined);
  if (!draft) return null;
  if (ref.slot === "b" && (draft as any).singleListing === true) return null;
  const bedrooms = resolveDraftUnitBedrooms(draft as any, ref.slot === "a" ? "unit1" : "unit2");
  if (!bedrooms) return null;
  const street = (draft as any).streetAddress ?? "";
  return {
    isDraft: true,
    communityFolder: resolveCanonicalCommunityPhotoFolder(draft.name) ?? `community-draft-${ref.draftId}`,
    communityName: draft.name,
    propertyName: draft.name,
    address: [street, draft.city, draft.state].filter(Boolean).join(", "),
    street: street || undefined,
    city: draft.city || undefined,
    state: draft.state || undefined,
    unit: { id: unitId, unitNumber: ref.slot.toUpperCase(), bedrooms },
    unitIndex: ref.slot === "a" ? 0 : 1,
  };
}

// The same find payload the manual dialog assembles (builder-preflight parity):
// parsed display address + inferred community street + existing swaps' source
// URLs as skipUrls. First-hit mode (no collectAllOptions) — the auto flow
// commits the first viable unit, so exhaustive pool-draining is wasted time.
async function assembleFindPayload(propertyId: number, unitId: string): Promise<Record<string, unknown> | null> {
  const target = await resolveAutoReplaceTarget(propertyId, unitId);
  if (!target) return null;
  const streetAddress = inferCommunityStreetAddress({
    communityName: target.communityName,
    city: target.city,
    state: target.state,
    addressHint: target.street || target.address,
  }) || target.street;
  const swaps = latestUnitSwapsByUnit(await storage.getUnitSwaps(propertyId).catch(() => []));
  const skipUrls = Array.from(new Set(
    Array.from(swaps.values()).map((s: any) => String(s?.newSourceUrl ?? "")).filter(Boolean),
  ));
  return {
    communityFolder: target.communityFolder,
    communityName: target.communityName,
    propertyAddress: target.address,
    streetAddress: streetAddress || undefined,
    city: target.city || undefined,
    state: target.state || undefined,
    propertyId,
    targetUnitId: target.unit.id,
    requiredBedrooms: target.unit.bedrooms,
    skipUrls,
  };
}

async function postLoopback(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: any }> {
  const resp = await fetch(`${loopbackBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function patchLoopback(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: any }> {
  const resp = await fetch(`${loopbackBaseUrl()}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function runAutoReplaceJob(record: AutoReplaceJobRecord): Promise<void> {
  if (activeJobIds.has(record.jobId)) return;
  activeJobIds.add(record.jobId);
  try {
    // Resumed mid-"verifying": the swap is already COMMITTED (newUnitLabel /
    // replacementFolder were persisted in the same touch that flipped the
    // phase) — never re-commit; just re-kick the idempotent verification legs
    // + Guesty push and land. Without this, a job killed during the verify /
    // push leg re-attached into a phase no block handled and sat "verifying"
    // forever.
    if (record.phase === "verifying") {
      await runAutoReplaceVerifyPhase(record, {
        newUnitLabel: record.newUnitLabel ?? "",
        newAddress: record.newAddress ?? "",
        photoFolder: record.replacementFolder || replacementPhotoFolderForUnit(record.propertyId, record.unitId),
      });
      return;
    }

    // Phase 1 — finding. Restart-tolerant: a find job that vanished or died
    // unresumably (killed by a deploy burst — the 2026-07-05 Pili Mai
    // incident) gets a bounded number of FRESH searches instead of the old
    // misleading "no eligible unit found" failure.
    let findJob: any = null;
    if (record.phase === "queued" || record.phase === "finding" || !record.findJobId) {
      const waitStart = Date.now();
      // A single "restart" signal can be a store-write lag racing this poll —
      // require a few consecutive signals before burning a bounded fresh
      // search (each one is a full SearchAPI sweep).
      let restartSignals = 0;
      for (;;) {
        if (!record.findJobId) {
          const payload = await assembleFindPayload(record.propertyId, record.unitId);
          if (!payload) {
            touch(record, { phase: "failed", error: "Could not resolve this property/unit for a replacement search." });
            return;
          }
          const started = startPreflightReplacementFindJob(payload);
          touch(record, {
            phase: "finding",
            findJobId: started.id,
            message: `Searching ${String(payload.communityName ?? "the community")} for a clean ${String(payload.requiredBedrooms ?? "?")}BR unit…`,
          });
        } else if (record.phase === "queued") {
          touch(record, { phase: "finding" });
        }
        findJob = getPreflightReplacementFindJob(record.findJobId!) ?? await getPersistedReplacementFindJob(record.findJobId!);
        const step = nextStepFromFindJob(findJob);
        if (step !== "restart") restartSignals = 0;
        if (step === "commit") break;
        if (step === "restart" && ++restartSignals >= RESTART_SIGNAL_CONFIRM_POLLS) {
          restartSignals = 0;
          if (record.findRestarts >= MAX_AUTO_REPLACE_FIND_RESTARTS) {
            touch(record, { phase: "failed", error: STUCK_AUTO_REPLACE_ERROR });
            return;
          }
          console.warn(`[auto-replace] find job ${record.findJobId} died unresumably — starting a fresh search (restart ${record.findRestarts + 1}/${MAX_AUTO_REPLACE_FIND_RESTARTS})`);
          touch(record, {
            findJobId: null,
            findRestarts: record.findRestarts + 1,
            message: "The search was interrupted by a server restart — starting a fresh search…",
          });
          continue;
        }
        if (step === "fail") {
          touch(record, {
            phase: "failed",
            error: String(findJob?.error ?? findJob?.message ?? "Replacement search failed — no eligible unit found."),
          });
          return;
        }
        if (Date.now() - waitStart > FIND_WAIT_CEILING_MS) {
          touch(record, { phase: "failed", error: "Replacement search did not finish in time." });
          return;
        }
        touch(record, { message: String(findJob?.message ?? "Searching…") });
        await new Promise((r) => setTimeout(r, FIND_POLL_INTERVAL_MS));
      }
    } else {
      findJob = getPreflightReplacementFindJob(record.findJobId!) ?? await getPersistedReplacementFindJob(record.findJobId!);
    }

    // Phase 2 — committing (auto-pick, 409s fall through to the next option).
    if (record.phase === "finding" || record.phase === "queued" || record.phase === "committing") {
      const units: Array<Record<string, unknown>> = Array.isArray(findJob?.units)
        ? findJob.units
        : findJob?.unit ? [findJob.unit] : [];
      const target = await resolveAutoReplaceTarget(record.propertyId, record.unitId);
      if (!target) {
        touch(record, { phase: "failed", error: "Property/unit no longer resolvable for commit." });
        return;
      }
      const unit = target.unit;
      touch(record, { phase: "committing", message: "Recording the swap and pulling the new unit's photos…" });
      let committed: { newUnitLabel: string; newAddress: string; photoFolder: string } | null = null;
      // Per-reason burn counts so the all-burned failure message reports what
      // ACTUALLY happened — a photo-hydration burn used to read as "already
      // used by another listing" (Makahuena 2026-07-06: the single found
      // unit's gallery was gone, but the failure blamed a duplicate).
      let burnedInUse = 0;
      let burnedPhotos = 0;
      let burnedCoverage = 0;
      for (;;) {
        const candidate = pickCommitCandidate(units as Array<{ url?: unknown }>, record.attemptedUrls);
        if (!candidate) {
          const reasons = [
            burnedInUse > 0 ? `${burnedInUse} already used by another listing` : null,
            burnedPhotos > 0 ? `${burnedPhotos} had a gallery that could not be scraped (bot-walled or photos taken down)` : null,
            burnedCoverage > 0 ? `${burnedCoverage} photographed fewer bedrooms than the unit claims (the audit needs every bedroom in the gallery)` : null,
          ].filter(Boolean).join("; ");
          touch(record, {
            phase: "failed",
            error: units.length === 0
              // Resumed mid-commit but the find results are gone (store evicted
              // >24h later) — the search never said "no units", so don't claim it.
              ? "The search results were lost in a server restart — click Replace photos to run a fresh search."
              : `Every found option failed at commit${reasons ? ` (${reasons})` : ""}. Re-run the search.`,
          });
          return;
        }
        const c = candidate as Record<string, unknown>;
        const url = String(c.url ?? "");
        const { status, data } = await postLoopback("/api/unit-swaps", {
          // The route's fire-and-forget Guesty push is skipped here — this
          // orchestrator runs its OWN awaited push below so the dashboard
          // queue shows push progress and the completed message reports the
          // real outcome. Without the flag the same swap would push twice.
          skipGuestyPhotoPush: true,
          propertyId: record.propertyId,
          communityFolder: target.communityFolder,
          oldUnitId: unit.id,
          oldUnitNumber: unit.unitNumber ?? "",
          oldBedrooms: unit.bedrooms,
          newAddress: String(c.address ?? ""),
          newUnitLabel: String(c.unitLabel ?? c.address ?? "Replacement unit"),
          newBedrooms: typeof c.bedrooms === "number" ? c.bedrooms : unit.bedrooms,
          newSourceUrl: url,
          thumbnailUrl: Array.isArray(c.photos) ? String((c.photos[0] as any)?.url ?? "") || null : null,
          // The find phase's scraped gallery — hydration's fallback when the
          // commit-time re-scrape hits a bot-wall/quota outage (all scrape
          // tiers can degrade at once; the find already proved this gallery).
          photoUrls: Array.isArray(c.photos)
            ? (c.photos as Array<{ url?: unknown }>).map((p) => String(p?.url ?? "")).filter((u) => /^https?:\/\//i.test(u))
            : [],
          // Bedroom-shortfall replacements (audit ladder): the route aborts
          // the commit at staging when the new gallery photographs fewer
          // bedrooms than the unit claims — burned below as coverageShort.
          requireBedroomPhotoCoverage: record.requireBedroomPhotoCoverage === true,
        }, 300_000); // hydration may use the bounded 90s sidecar scrape tier
        if (status === 409) {
          burnedInUse += 1;
          touch(record, { attemptedUrls: [...record.attemptedUrls, url], message: "Candidate already in use — trying the next option…" });
          continue;
        }
        // 502 from this route = photo hydration failed for THIS candidate
        // (bot-walled gallery / photos taken down since the find phase / the
        // bedroom-coverage gate rejected the gallery) — a candidate-level
        // problem, not a job-level one. Burn the URL and try the next option
        // (the Pili Mai 9K case: option 1's Redfin gallery came back empty
        // while option 2 scraped fine).
        if (status === 502 && (data?.coverageShort === true || /photo/i.test(String(data?.error ?? "")))) {
          if (data?.coverageShort === true) burnedCoverage += 1;
          else burnedPhotos += 1;
          touch(record, {
            attemptedUrls: [...record.attemptedUrls, url],
            message: data?.coverageShort === true
              ? "Candidate's gallery photographs too few bedrooms — trying the next option…"
              : "Candidate's photos could not be scraped — trying the next option…",
          });
          continue;
        }
        if (status >= 400) {
          touch(record, { phase: "failed", error: String(data?.error ?? `Unit swap failed (HTTP ${status})`) });
          return;
        }
        committed = {
          newUnitLabel: String(data?.swap?.newUnitLabel ?? c.unitLabel ?? ""),
          newAddress: String(data?.swap?.newAddress ?? c.address ?? ""),
          photoFolder: String(data?.photoFolder ?? replacementPhotoFolderForUnit(record.propertyId, record.unitId)),
        };
        // Promoted drafts persist photos under unit{1,2}PhotoFolder — repoint
        // the draft at the replacement folder + the new unit's identity NOW
        // (one-click semantics; same PATCH as builder-preflight's "Commit
        // Replacements & Continue", but SCOPED to this unit so a sibling
        // unit's abandoned preflight pick is never silently committed).
        // Without it the dashboard, scanner, and Guesty push keep reading the
        // OLD folder/unit.
        if (target.isDraft) {
          const repoint = await patchLoopback(`/api/unit-swaps/commit/${record.propertyId}`, { oldUnitId: record.unitId }, 30_000)
            .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
          if (repoint.status >= 400) {
            touch(record, {
              phase: "failed",
              error: `The swap was recorded but the draft could not be repointed at the new unit (HTTP ${repoint.status}) — open builder pre-flight and use "Commit Replacements & Continue".`,
            });
            return;
          }
        }
        break;
      }

      // Phase 3 — verifying (shared with the resumed-mid-verifying path).
      await runAutoReplaceVerifyPhase(record, committed);
    }
  } catch (e: any) {
    touch(record, { phase: "failed", error: e?.message ?? "Auto replace failed" });
  } finally {
    activeJobIds.delete(record.jobId);
  }
}

// Phase 3 — verifying: kick both verification legs (best-effort) + the awaited
// Guesty photo push, then complete. Also the resume entry point for a job
// killed mid-verify: every leg is safe to re-run (rescan + community check are
// re-kicks; the Guesty push PUTs the full pictures[] array idempotently).
async function runAutoReplaceVerifyPhase(
  record: AutoReplaceJobRecord,
  committed: { newUnitLabel: string; newAddress: string; photoFolder: string },
): Promise<void> {
  touch(record, {
    phase: "verifying",
    newUnitLabel: committed.newUnitLabel || record.newUnitLabel,
    newAddress: committed.newAddress || record.newAddress,
    replacementFolder: committed.photoFolder,
    message: "Swap committed — verifying the new photos are clean and in-community…",
  });
  // Track the kick outcome — an HTTP failure here (e.g. the folder rejected
  // as unscannable) must surface in the completed message, not silently read
  // as "rescan is running".
  let rescanKickNote = "";
  await postLoopback("/api/photo-listing-check/run", { folders: [committed.photoFolder] }, 30_000)
    .then(({ status, data }) => {
      if (status >= 400) {
        rescanKickNote = ` ⚠ OTA rescan did not start (${String((data as any)?.error ?? `HTTP ${status}`)}) — use "Rescan again" on the row.`;
        console.warn(`[auto-replace] verify rescan kick rejected (${status}) for ${committed.photoFolder}`);
      }
    })
    .catch((e) => {
      rescanKickNote = " ⚠ OTA rescan did not start (request failed) — use \"Rescan again\" on the row.";
      console.warn(`[auto-replace] verify rescan kick failed: ${e?.message ?? e}`);
    });
  await postLoopback("/api/builder/bulk-photo-community-check", {
    propertyIds: [record.propertyId],
    labels: { [String(record.propertyId)]: record.propertyName },
  }, 30_000).catch((e) => console.warn(`[auto-replace] community check kick failed: ${e?.message ?? e}`));

  // Phase 3b — push the rebuilt gallery to Guesty (2026-07-05 operator
  // ask). The PUT replaces the listing's entire pictures[] array, so this
  // is what actually removes the OLD unit's duplicated photos from
  // Guesty (and, via its channel fan-out, from Airbnb/VRBO/Booking).
  // Awaited so the queue message reports the real outcome; a failure is
  // surfaced but does NOT fail the job — the swap itself is committed and
  // the builder's manual "Push Photos to Guesty" button remains the
  // fallback. The commit POST passed skipGuestyPhotoPush so the route's
  // own fire-and-forget hook doesn't double-push.
  touch(record, {
    message: "Swap committed — pushing the new photos to Guesty (replaces the old unit's photos on the listing)…",
  });
  let guestyPushNote = "";
  try {
    const push = await repushGuestyPhotosForProperty(record.propertyId, {
      reason: `auto-replace ${record.jobId} (${record.unitLabel})`,
      waitForLabelsFolder: committed.photoFolder,
    });
    if (push.ok && !push.skipped) {
      guestyPushNote = ` ${push.successCount ?? 0} photos re-pushed to Guesty (old photos replaced).`;
    } else if (push.skipped === "no-guesty-mapping") {
      guestyPushNote = " No Guesty listing is mapped to this property, so there were no old photos to replace on Guesty.";
    } else if (push.skipped) {
      guestyPushNote = ` ⚠ Guesty photo push skipped (${push.skipped}).`;
    } else {
      guestyPushNote = ` ⚠ Guesty photo push failed (${push.error ?? "unknown error"}) — open the builder's Photos tab and use "Push Photos to Guesty".`;
    }
  } catch (e: any) {
    guestyPushNote = ` ⚠ Guesty photo push failed (${e?.message ?? e}) — open the builder's Photos tab and use "Push Photos to Guesty".`;
  }

  touch(record, {
    phase: "completed",
    message: `${record.unitLabel} now uses ${committed.newUnitLabel || record.newUnitLabel || committed.newAddress || "the new unit"} — OTA rescan + Claude-vision community check are running.${rescanKickNote}${guestyPushNote}`,
    error: null,
  });
}

export async function startAutoReplaceJob(input: {
  propertyId: number;
  unitId: string;
  unitLabel?: string;
  // Audit-ladder bedroom-shortfall replacements: require the NEW gallery to
  // photograph every claimed bedroom (commit aborts at staging + burns the
  // candidate otherwise). See AutoReplaceJobRecord.requireBedroomPhotoCoverage.
  requireBedroomPhotoCoverage?: boolean;
}): Promise<{ ok: true; job: AutoReplaceJobRecord } | { ok: false; status: number; error: string }> {
  const propertyId = Number(input.propertyId);
  const unitId = String(input.unitId ?? "");
  // Resolves BOTH builder properties (positive ids) and promoted drafts
  // (negative ids, `draft<id>-unit-a/b`).
  const target = await resolveAutoReplaceTarget(propertyId, unitId);
  if (!target) return { ok: false, status: 400, error: "Unknown property/unit for auto replace" };

  // Double-tap guard — one active auto-replace per property+unit (memory + store).
  for (const existing of Array.from(jobs.values())) {
    if (existing.propertyId === propertyId && existing.unitId === unitId && isAutoReplacePhaseActive(existing.phase)) {
      return { ok: true, job: existing };
    }
  }
  const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY).catch(() => undefined);
  const persistedActive = findActiveAutoReplaceJob(parseAutoReplaceStore(raw ?? null), propertyId, unitId);
  if (persistedActive && !jobs.has(persistedActive.jobId)) {
    jobs.set(persistedActive.jobId, persistedActive);
    void runAutoReplaceJob(persistedActive);
    return { ok: true, job: persistedActive };
  }

  const letter = String.fromCharCode(65 + Math.max(0, target.unitIndex));
  const numberSuffix = target.unit.unitNumber && target.unit.unitNumber !== letter
    ? ` (${target.unit.unitNumber})`
    : "";
  const record: AutoReplaceJobRecord = {
    jobId: `arj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    phase: "queued",
    propertyId,
    unitId,
    unitLabel: input.unitLabel || `Unit ${letter}${numberSuffix}`,
    propertyName: target.propertyName,
    findJobId: null,
    attemptedUrls: [],
    newUnitLabel: null,
    newAddress: null,
    replacementFolder: null,
    message: "Queued",
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resumeCount: 0,
    findRestarts: 0,
    requireBedroomPhotoCoverage: input.requireBedroomPhotoCoverage === true,
  };
  jobs.set(record.jobId, record);
  await mutateStore((store) => { store[record.jobId] = { ...record }; });
  void runAutoReplaceJob(record);
  return { ok: true, job: record };
}

// Queue for the dashboard chip: in-memory records win (freshest), persisted
// records fill in after a restart.
export async function listAutoReplaceJobs(): Promise<{ activeCount: number; jobs: AutoReplaceJobRecord[] }> {
  const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY).catch(() => undefined);
  const store = parseAutoReplaceStore(raw ?? null);
  for (const record of Array.from(jobs.values())) store[record.jobId] = record;
  return summarizeAutoReplaceQueue(store, Date.now());
}

// Operator "Clear queue": drop finished (and unresumably-stuck) records from
// memory AND the persisted store so the dashboard banner disappears. Jobs this
// process is actively running keep their records (clearableAutoReplaceJobIds
// protects them via activeJobIds).
export async function clearAutoReplaceQueue(): Promise<{ removed: number; activeCount: number; jobs: AutoReplaceJobRecord[] }> {
  const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY).catch(() => undefined);
  const store = parseAutoReplaceStore(raw ?? null);
  for (const record of Array.from(jobs.values())) store[record.jobId] = record;
  const removable = clearableAutoReplaceJobIds(store, Date.now(), activeJobIds);
  for (const jobId of removable) jobs.delete(jobId);
  await mutateStore((persisted) => {
    for (const jobId of removable) delete persisted[jobId];
  });
  const summary = await listAutoReplaceJobs();
  return { removed: removable.length, ...summary };
}

// Boot/interval watchdog — resume orphaned active jobs after a restart.
// Gate: AUTO_REPLACE_RESUME_DISABLED=1.
let resumeSweepInFlight = false;
export async function resumeOrphanedAutoReplaceJobs(): Promise<void> {
  if (resumeSweepInFlight) return;
  resumeSweepInFlight = true;
  try {
    const raw = await storage.getSetting(AUTO_REPLACE_STORE_SETTING_KEY);
    const store = parseAutoReplaceStore(raw ?? null);
    for (const record of Object.values(store)) {
      if (!shouldResumeAutoReplaceJob(record, Date.now())) continue;
      if (jobs.has(record.jobId) || activeJobIds.has(record.jobId)) continue;
      console.warn(`[auto-replace] boot-resume: re-attaching orphaned job ${record.jobId} (phase ${record.phase}, resume ${record.resumeCount + 1})`);
      record.resumeCount += 1;
      jobs.set(record.jobId, record);
      void mutateStore((store2) => { store2[record.jobId] = { ...record }; });
      void runAutoReplaceJob(record);
    }
    // Active-phase records that can NEVER come back (resume cap exhausted /
    // outside the window) become an honest terminal failure instead of
    // pinning the queue banner "active" until the 24h eviction (2026-07-05
    // Pili Mai deploy-burst incident). In-process jobs are protected.
    const liveIds = new Set([...Array.from(jobs.keys()), ...Array.from(activeJobIds)]);
    const stuckIds = Object.values(store).filter((r) =>
      isAutoReplacePhaseActive(r.phase) && !liveIds.has(r.jobId) && !shouldResumeAutoReplaceJob(r, Date.now()),
    ).map((r) => r.jobId);
    if (stuckIds.length > 0) {
      console.warn(`[auto-replace] failing ${stuckIds.length} stuck unresumable job(s): ${stuckIds.join(", ")}`);
      await mutateStore((liveStore, now) => {
        failStuckAutoReplaceRecords(liveStore, now, liveIds);
      });
    }
  } catch {
    // Fail-soft — next sweep retries.
  } finally {
    resumeSweepInFlight = false;
  }
}

export function startAutoReplaceResumeWatchdog(): void {
  if (/^(1|true|yes|on)$/i.test(String(process.env.AUTO_REPLACE_RESUME_DISABLED ?? "").trim())) {
    console.log("[auto-replace] resume watchdog disabled via AUTO_REPLACE_RESUME_DISABLED");
    return;
  }
  // Slightly after the replacement-find watchdog (20s) so a resumed find job
  // is already back in memory when the orchestrator re-attaches.
  setTimeout(() => void resumeOrphanedAutoReplaceJobs(), 25_000).unref?.();
  setInterval(() => void resumeOrphanedAutoReplaceJobs(), 2 * 60_000).unref?.();
}
