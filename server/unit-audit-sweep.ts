// Unit Audit Sweep orchestrator — the dashboard "Audit" button.
//
// VERIFY-ONLY (PR 1): runs every check the operator does by hand across the
// builder tabs against ONE property and reports a per-stage verdict — it
// changes nothing. Auto-fix chaining (dedupe apply, description regenerate,
// photo re-scrape → find-new → replace-unit ladder, pricing refresh) lands in
// the follow-up PR; the stage vocabulary already reserves "fixed" for it.
//
// Every stage REUSES an existing engine rather than re-implementing it:
//   photo-dedupe     → server/photo-dedupe.ts scanForDuplicatePhotos
//   photo-community  → loopback POST /api/builder/photo-community-check
//                      { propertyId } (server-built groups; persists → Comm QA)
//   ota-scan         → loopback POST /api/photo-listing-check/run (deep scan)
//                      + photo_listing_checks rows
//   descriptions     → shared/description-copy.ts placeholder detector
//   amenities        → property_amenities + the Guesty listing's amenities
//   cover-collage    → cover_collages.v1 record + disk file
//   layout           → Guesty listing document vs the system unit config
//   pricing          → property_market_rates + scanner_schedule push stamps +
//                      shared/market-rate-match-confirmation.ts
//   channels         → loopback GET /api/dashboard/channel-status + the
//                      shared license placeholder detector
//
// Job records persist in app_settings (shared/unit-audit-sweep-logic.ts) and
// a boot/interval watchdog resumes orphaned sweeps after a Railway restart —
// stage results are appended on completion, so a resume re-runs only the
// stages that never finished. The final receipt persists per property in
// unit_audit_reports.v1 and drives the dashboard Audit column badge.
//
// HONESTY RULE (load-bearing): a check that could not run reports verdict
// "error", never "pass" and never a silent skip — absence of evidence must
// not green the audit (the false-Clear class the preflight audit fixed).

import fs from "fs";
import path from "path";
import {
  getUnitBuilderByPropertyId,
  LISTING_DISCLOSURE,
  REPRESENTATIVE_ACCOMMODATIONS_DISCLOSURE,
  SINGLE_LISTING_SAMPLE_DISCLOSURE,
} from "../client/src/data/unit-builder-data";
import { parseStreetCityState } from "@shared/address-listing-logic";
import { resolveDraftUnitBedrooms } from "@shared/draft-unit-bedrooms";
import { pushPublishedAddressForListing } from "./published-address";
import {
  findDescriptionPlaceholders,
  AREA_SECTION_HEADERS,
  DESCRIPTION_OVERRIDE_FIELDS,
  composeSummaryWithDisclosures,
  composeSpaceFromUnitDescriptions,
} from "@shared/description-copy";
import { isPlaceholderLicenseValue, usableLicenseValue } from "@shared/license-compliance";
import { COVER_COLLAGE_SETTING_KEY, COVER_COLLAGE_DISK_FOLDER } from "@shared/cover-collage-logic";
import { GUESTY_UNSUPPORTED_AMENITY_KEYS, amenityPresenceCandidates, getAmenityLabel, normalizeGuestyAmenityName } from "@shared/guesty-amenity-catalog";
import { computeMarketRateMatchConfirmation } from "@shared/market-rate-match-confirmation";
import { isCuratedBuyInMarket } from "@shared/buy-in-market";
import { sourcePageIsStrongContradiction } from "@shared/source-page-community-logic";
import { classifyStagedUnitCommunityAudit } from "@shared/unit-replacement-community-gate";
import {
  COMMUNITY_CONSENSUS_PASSES_DEFAULT,
  COMMUNITY_PHOTO_FIX_FLOOR,
  UNIT_AUDIT_STAGE_RETRY_PASSES_DEFAULT,
  classifyUnitAuditConfiguredPhotoCoverage,
  communityCheckUncertaintyOnly,
  communityPhotoFixSelections,
  confirmSameSceneGroups,
  dedupeAutoFixSelections,
  mergeCommunityConsensusPasses,
  MAX_FULL_AUTOMATION_COMMITTED_REPLACEMENTS,
  photoFixRungsForUnit,
  replaceRungOnCooldown,
  shouldRetryCommittedFullAutomationReplacement,
  unitAuditRetryStageIds,
  type PhotoFixRung,
  MAX_UNIT_AUDIT_RESUMES,
  UNIT_AUDIT_REPORTS_SETTING_KEY,
  UNIT_AUDIT_STAGE_IDS,
  UNIT_AUDIT_STAGE_LABELS,
  UNIT_AUDIT_STORE_SETTING_KEY,
  failStuckUnitAuditRecords,
  findActiveUnitAuditJob,
  isUnitAuditStatusActive,
  lookupUnitAuditRecord,
  nextUnitAuditStage,
  parseUnitAuditReports,
  parseUnitAuditStore,
  queueRecoverableUnitAuditMutation,
  rollUpUnitAuditVerdict,
  serializeUnitAuditReports,
  serializeUnitAuditStore,
  shouldResumeUnitAuditJob,
  summarizeUnitAuditQueue,
  unitAuditHeadline,
  unitAuditChildPollShouldCancel,
  unitAuditChildPollShouldProcessTerminalBeforeCancel,
  unitAuditChildPollShouldTimeout,
  unitAuditVerifyReadBackoffMs,
  unitAuditVerifyReadRetryable,
  upsertUnitAuditStageResult,
  type UnitAuditJobRecord,
  type UnitAuditReportRecord,
  type UnitAuditStageId,
  type UnitAuditStageResult,
  type CommunityConsensusCoverage,
  type UnitAuditStageVerdict,
} from "@shared/unit-audit-sweep-logic";
import {
  PHOTO_JUDGMENT_DUPE_HASH_MAX_DISTANCE,
  collectPhotoJudgmentCandidates,
  filterAdjudicatedCandidates,
  photoJudgmentActionPlan,
  verifiedDupeHideDistance,
  type PhotoJudgmentCandidate,
  type PhotoJudgmentDecision,
} from "@shared/photo-judgment-adjudication";
import {
  coveredJudgmentKeysForFolders,
  judgmentFingerprintsForFolders,
  loadPhotoJudgmentDecisions,
  photoJudgmentDoubleCheckEnabled,
  photoJudgmentEnabled,
  recordPhotoJudgmentDecisions,
  runPhotoJudgmentVision,
  runRemovalRefuteVision,
  verifyDupePairOnDisk,
} from "./photo-judgment";
import { photoListingScanWasInconclusive } from "@shared/photo-listing-decision";
import {
  buildPhotoCommunityCheckRequestForProperty,
  configuredPhotoFolderStatusesForProperty,
  listPublishedFilenames,
  readFolderSourceUrl,
  writeFolderSourceUrlIfMissing,
  type ConfiguredPhotoFolderStatus,
} from "./builder-photo-groups";
import { replacementPhotoFolderRef } from "@shared/photo-folder-utils";
import { scanForDuplicatePhotos, type DedupeScanGroupInput } from "./photo-dedupe";
import { applyBeddingPhotoScanForAudit, beddingPhotoCheckForAudit } from "./bedding-photo-scan";
import type { PhotoCommunityCheckResult } from "./photo-community-check";
import { getPreflightPhotoFetchJob, startPreflightPhotoFetchJob } from "./preflight-background-jobs";
import { getCommunityPhotoRepullJob, startCommunityPhotoRepullJob } from "./community-photo-repull";
import { listAutoReplaceJobs, startAutoReplaceJob } from "./auto-replace-jobs";
import { repushGuestyPhotosForProperty } from "./guesty-photo-repush";
import { autoReplaceGuestyPushSatisfied, isAutoReplacePhaseActive, draftUnitIdForSlot } from "@shared/auto-replace-job-logic";
import { latestUnitSwapsByUnit } from "@shared/unit-swap-photos";
import { loopbackRequestHeaders } from "./auth";
import { sendOperatorAlert } from "./operator-alerts";
import { storage } from "./storage";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

// Per-stage ceilings. The long legs: community check + OTA deep scan (Lens),
// and — with auto-fix on — the description regenerate (one Claude call), the
// amenity scan (vision + area research), the collage (vision + ESRGAN + ImgBB
// + Guesty), and the pricing refresh (SearchAPI months × unit sizes, the same
// work a bulk-queue item does). Verify-only paths return in seconds anyway.
const STAGE_TIMEOUT_MS: Record<UnitAuditStageId, number> = {
  resolve: 60_000,
  // Dedupe + community ceilings grew with the 2026-07-12 double/triple-check
  // rails. Strict dedupe now pair-covers >60-photo folders in bounded batches:
  // a 100-photo folder needs six calls per exhaustive scan, so two required
  // 120s-ceiling scans alone can take 24 minutes. Forty minutes covers that
  // required clean confirmation plus normal apply/re-scan overhead; harder
  // galleries fail explicitly at the stage ceiling instead of claiming clean.
  // Community may run up to 2 extra consensus checks (each an independent full
  // Lens+vision pass, bounded per-call below).
  "photo-dedupe": 40 * 60_000,
  "photo-community": 55 * 60_000,
  "ota-scan": 16 * 60_000,
  // The ladder's worst case is real work: a re-scrape (~minutes), a
  // find-new-source discovery job (~minutes), a full one-click unit
  // replacement (find → commit → verify, up to ~35 min), plus a Lens+vision
  // re-check after each photo change (and, since 2026-07-12, a bounded
  // consensus re-check before the post-fix row upserts). Bounded per-rung
  // below.
  "photo-fix": 120 * 60_000,
  // Descriptions: one 4-min Claude generate + a 60s Guesty push, PLUS (since
  // 2026-07-17) the separate-published-address ensure — worst case a Guesty
  // address GET/PUT/GET behind a 429 gate pause. Eight minutes covers both.
  descriptions: 8 * 60_000,
  // Amenities: the scan (vision + area research + push) keeps its ~7-min
  // budget; the extra headroom covers the verify read's bounded retries over
  // Guesty rate-limit pauses (see loopbackVerifyRead — the accounting is
  // explicit at the scan call).
  amenities: 13 * 60_000,
  "cover-collage": 8 * 60_000,
  // Layout: the Guesty-backed read (2 retry attempts over a rate-limit pause)
  // PLUS the bedding photo check — one batched vision call per unit (~2 min
  // worst case each for a 2-unit property) when no fingerprint-fresh stored
  // scan exists. Channels stays a single read.
  layout: 8 * 60_000,
  pricing: 20 * 60_000,
  channels: 3 * 60_000,
};

// Global auto-fix kill (the per-engine kill switches — COVER_COLLAGE_VISION_
// DISABLED, PHOTO_DEDUPE_VISION_DISABLED, etc. — still apply downstream).
const autoFixGloballyDisabled = () =>
  /^(1|true|yes|on)$/i.test(String(process.env.UNIT_AUDIT_AUTOFIX_DISABLED ?? "").trim());
const autoFixEnabled = (record: UnitAuditJobRecord) => record.autoFix && !autoFixGloballyDisabled();
const FULL_AUTOMATION_MUTATING_STAGES = new Set<UnitAuditStageId>([
  "photo-dedupe",
  "photo-fix",
  "descriptions",
  "amenities",
  "cover-collage",
  "layout",
  "pricing",
]);

// How fresh an existing photo_listing_checks row must be for the OTA stage to
// reuse it instead of kicking a new deep scan (each deep scan is real Lens +
// SERP spend). Manual sweeps demand a fresh look (24h); CRON sweeps reuse the
// weekly photo-cron's rows (8 days) — without the wider window every weekly
// auto-audit would double-spend the deep scan the photo cron just ran.
const otaFreshHoursFor = (record: UnitAuditJobRecord) =>
  record.source === "cron"
    ? Number(process.env.AUDIT_CRON_OTA_FRESH_HOURS ?? "192")
    : Number(process.env.AUDIT_OTA_FRESH_HOURS ?? "24");
const OTA_POLL_INTERVAL_MS = 10_000;
// Breather between unverified-stage retry passes (rail A) — long enough for a
// transient quota/timeout blip or an in-flight refresh to clear, short enough
// that the sweep still finishes in one sitting.
const RETRY_PASS_DELAY_MS = 20_000;
// Rates pushed longer ago than this read as stale (matches the dashboard
// "Last Price Scan" amber threshold — the weekly cron cadence + 1 day).
const PRICING_STALE_DAYS = 8;
const AMENITY_SCAN_RECEIPTS_SETTING_KEY = "amenity_scan_receipts.v1";
const PRICING_AUDIT_RECEIPTS_SETTING_KEY = "pricing_audit_receipts.v1";

const jobs = new Map<string, UnitAuditJobRecord>();
const activeJobIds = new Set<string>();
const cancelRequested = new Set<string>();

let storeTail: Promise<void> = Promise.resolve();
function enqueueStoreMutation(
  mutate: (store: Record<string, UnitAuditJobRecord>, nowMs: number) => void,
): Promise<void> {
  const queued = queueRecoverableUnitAuditMutation(storeTail, async () => {
    const now = Date.now();
    const raw = await storage.getSetting(UNIT_AUDIT_STORE_SETTING_KEY);
    const store = parseUnitAuditStore(raw ?? null);
    mutate(store, now);
    await storage.setSetting(UNIT_AUDIT_STORE_SETTING_KEY, serializeUnitAuditStore(store, now));
  });
  // Later queue entries must still run after one strict caller observes a
  // rejected operation. Keep the shared tail healed while returning the raw
  // operation to callers that require a real durability guarantee.
  storeTail = queued.tail;
  return queued.operation;
}

function mutateStore(mutate: (store: Record<string, UnitAuditJobRecord>, nowMs: number) => void): Promise<void> {
  // Historical status/heartbeat writes are best-effort.
  return enqueueStoreMutation(mutate).catch(() => undefined);
}

function mutateStoreStrict(mutate: (store: Record<string, UnitAuditJobRecord>, nowMs: number) => void): Promise<void> {
  return enqueueStoreMutation(mutate);
}

let reportsTail: Promise<void> = Promise.resolve();
function mutateReports(mutate: (reports: Record<string, UnitAuditReportRecord>) => void): Promise<void> {
  reportsTail = reportsTail.then(async () => {
    try {
      const raw = await storage.getSetting(UNIT_AUDIT_REPORTS_SETTING_KEY);
      const reports = parseUnitAuditReports(raw ?? null);
      mutate(reports);
      await storage.setSetting(UNIT_AUDIT_REPORTS_SETTING_KEY, serializeUnitAuditReports(reports));
    } catch {
      // Fail-soft.
    }
  });
  return reportsTail;
}

function touch(record: UnitAuditJobRecord, patch: Partial<UnitAuditJobRecord>): void {
  Object.assign(record, patch, { updatedAt: Date.now() });
  jobs.set(record.jobId, record);
  void mutateStore((store) => {
    store[record.jobId] = { ...record, stages: record.stages.map((s) => ({ ...s })) };
  });
}

async function touchDurably(record: UnitAuditJobRecord, patch: Partial<UnitAuditJobRecord>): Promise<void> {
  Object.assign(record, patch, { updatedAt: Date.now() });
  jobs.set(record.jobId, record);
  const snapshot = { ...record, stages: record.stages.map((stage) => ({ ...stage })) };
  await mutateStoreStrict((store) => {
    store[record.jobId] = snapshot;
  });
}

async function markGuestyGallerySyncPending(
  record: UnitAuditJobRecord,
  patch: Partial<Pick<
    UnitAuditJobRecord,
    "pendingDedupeHiddenCount" | "coverCollageNeedsRefresh" | "requiredCoverCollageUrl" | "finalGuestyGalleryVerified"
  >> = {},
): Promise<void> {
  // Mark memory first: even if the durable write fails, this process must run
  // the final exact sync from its failure path instead of forgetting a local
  // mutation that already landed.
  await touchDurably(record, {
    finalGuestyGalleryVerified: false,
    ...patch,
    pendingGuestyGallerySync: true,
  });
}

async function prearmStrictGuestyGallerySync(record: UnitAuditJobRecord): Promise<void> {
  if (record.fullAutomation) {
    // Re-persist even when memory is already armed. A previous strict write
    // may have failed after updating memory, and the mutation below must not
    // reopen that crash window by trusting the in-process flag alone.
    await markGuestyGallerySyncPending(record, {
      coverCollageNeedsRefresh: true,
      requiredCoverCollageUrl: null,
    });
  }
}

async function clearGuestyGallerySyncPending(
  record: UnitAuditJobRecord,
  patch: Partial<Pick<UnitAuditJobRecord, "requiredCoverCollageUrl" | "finalGuestyGalleryVerified">> = {},
): Promise<void> {
  // Clear storage first. If this write fails, keep the in-memory obligation so
  // the final/failure seam retries rather than falsely claiming synchronization.
  const updatedAt = Date.now();
  const snapshot: UnitAuditJobRecord = {
    ...record,
    pendingGuestyGallerySync: false,
    pendingDedupeHiddenCount: 0,
    ...patch,
    updatedAt,
    stages: record.stages.map((stage) => ({ ...stage })),
  };
  await mutateStoreStrict((store) => {
    store[record.jobId] = snapshot;
  });
  Object.assign(record, {
    pendingGuestyGallerySync: false,
    pendingDedupeHiddenCount: 0,
    ...patch,
    updatedAt,
  });
  jobs.set(record.jobId, record);
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 60_000)} min`)), ms);
        (timer as any).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loopbackJson(method: "GET" | "POST" | "PUT", pathName: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: any }> {
  const resp = await fetch(`${loopbackBaseUrl()}${pathName}`, {
    method,
    headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// Retrying wrapper for VERIFY-side Guesty reads (idempotent GETs only). Every
// Guesty call funnels through the global request gate in guesty-sync.ts —
// serialized with a 500ms min gap and PAUSED for up to 120s after any 429
// (Retry-After) — so a single short-timeout attempt can straddle a rate-limit
// pause and abort while the queue drains. That produced the live 2026-07-12
// Coconut Plantation receipt: amenities "could not be verified (The operation
// was aborted due to timeout)" while the layout stage's read of the SAME
// listing succeeded seconds later. Retry classification + backoff are pure
// (unitAuditVerifyReadRetryable / unitAuditVerifyReadBackoffMs); callers size
// attempts × timeout to fit their stage ceiling.
async function loopbackVerifyRead(
  pathName: string,
  opts: { attempts: number; timeoutMs: number; label: string },
): Promise<{ status: number; data: any; attemptsUsed: number }> {
  let last: { status: number; data: any } = { status: 599, data: { error: "not attempted" } };
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= Math.max(1, opts.attempts); attempt++) {
    if (attempt > 1) {
      const backoffMs = unitAuditVerifyReadBackoffMs(attempt - 1);
      console.log(`[unit-audit] ${opts.label}: read attempt ${attempt - 1} failed (${String((last.data as any)?.error ?? `HTTP ${last.status}`)}) — retrying in ${Math.round(backoffMs / 1000)}s (Guesty rate-limit pauses can stall reads)`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    attemptsUsed = attempt;
    last = await loopbackJson("GET", pathName, undefined, opts.timeoutMs)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (!unitAuditVerifyReadRetryable(last.status)) break; // success, or a 4xx that won't heal
  }
  return { ...last, attemptsUsed };
}

// Verify-read budgets. Amenities worst case per verify call:
// attempts × timeout + backoffs (10s + 20s) = 165s; verifyAmenities runs at
// most twice per stage (before + after the auto-fix scan), and the scan's own
// timeout below subtracts both so the stage ceiling always holds.
const AMENITY_VERIFY_READ_ATTEMPTS = 3;
const AMENITY_VERIFY_READ_TIMEOUT_MS = 45_000;
const AMENITY_VERIFY_WORST_MS =
  AMENITY_VERIFY_READ_ATTEMPTS * AMENITY_VERIFY_READ_TIMEOUT_MS +
  unitAuditVerifyReadBackoffMs(1) + unitAuditVerifyReadBackoffMs(2);

// ── Target resolution ────────────────────────────────────────────────────────

type AuditPhotoGroup = {
  role: "community" | "unit";
  label: string;
  folder: string;
  filenames: string[];
  captions: Record<string, string>;
  expectedBedrooms?: number;
};

type UnitAuditUnitRef = {
  /** Matches the photo-group label format exactly: `Unit A (3BR)`. */
  label: string;
  unitId: string;
  unitIndex: 0 | 1;
  bedrooms: number;
};

type UnitAuditTarget = {
  propertyId: number;
  isDraft: boolean;
  propertyName: string;
  communityName: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  guestyListingId: string | null;
  groups: AuditPhotoGroup[];
  /** Includes required folders that are missing/empty and thus absent from groups. */
  configuredPhotoFolders: ConfiguredPhotoFolderStatus[] | null;
  unitRefs: UnitAuditUnitRef[];
  expectedListingBedrooms: number | null;
  unitBedroomSizes: number[];
  bathroomsTotal: number | null;
  maxGuestsTotal: number | null;
  licenses: Record<string, string | undefined> | null;
  /**
   * Draft-only: the saved unit1/unit2 source URLs, indexed by unitIndex. Feeds
   * the _source.json provenance backfill for a draft unit folder whose scrape
   * predates the source stamp (core builder units rely on swap history).
   */
  unitSourceUrlHints?: Array<string | undefined>;
};

function parseBathrooms(value: unknown): number | null {
  const n = parseFloat(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolveUnitAuditTarget(propertyId: number): Promise<UnitAuditTarget | null> {
  const mapRow = (await storage.getGuestyPropertyMap().catch(() => []))
    .find((m) => m.propertyId === propertyId);
  const [built, configuredPhotoFolders] = await Promise.all([
    buildPhotoCommunityCheckRequestForProperty(propertyId).catch(() => null),
    configuredPhotoFolderStatusesForProperty(propertyId).catch(() => null),
  ]);
  const groups: AuditPhotoGroup[] = (built?.request.groups ?? []).map((g) => ({
    role: g.role,
    label: g.label,
    folder: g.folder,
    filenames: g.filenames ?? [],
    captions: g.captions ?? {},
    expectedBedrooms: g.expectedBedrooms,
  }));

  if (propertyId > 0) {
    const builder = getUnitBuilderByPropertyId(propertyId);
    // Retired entries are folder-context data only, not auditable portfolio
    // rows: startUnitAuditSweep 404s and a stale queued record fails its
    // resolve stage instead of running a full ghost sweep (2026-07-18 —
    // the first weekly cron tick audited six retired properties).
    if (!builder || builder.retired === true) return null;
    const parsed = parseStreetCityState(builder.address ?? "");
    const bathrooms = builder.units.map((u) => parseBathrooms(u.bathrooms)).filter((n): n is number => n != null);
    const guests = builder.units.map((u) => Number(u.maxGuests)).filter((n) => Number.isFinite(n) && n > 0);
    return {
      propertyId,
      isDraft: false,
      propertyName: builder.propertyName || builder.complexName,
      communityName: builder.complexName,
      streetAddress: parsed.street || undefined,
      city: parsed.city || undefined,
      state: parsed.state || undefined,
      guestyListingId: mapRow?.guestyListingId ?? null,
      groups,
      configuredPhotoFolders,
      unitRefs: builder.units.map((u, i) => ({
        label: `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR)`,
        unitId: u.id,
        unitIndex: (i === 1 ? 1 : 0) as 0 | 1,
        bedrooms: u.bedrooms,
      })),
      expectedListingBedrooms: built?.request.expectedListingBedrooms ?? (builder.units.reduce((s, u) => s + (u.bedrooms ?? 0), 0) || null),
      unitBedroomSizes: Array.from(new Set(builder.units.map((u) => u.bedrooms).filter((n) => n > 0))),
      bathroomsTotal: bathrooms.length === builder.units.length ? bathrooms.reduce((s, n) => s + n, 0) : null,
      maxGuestsTotal: guests.length === builder.units.length ? guests.reduce((s, n) => s + n, 0) : null,
      licenses: {
        "TAT license": builder.tatLicense,
        "GET license": builder.getLicense,
        "STR permit": builder.strPermit,
        "DBPR license": (builder as any).dbprLicense,
      },
    };
  }

  const draft = await storage.getCommunityDraft(-propertyId).catch(() => undefined);
  if (!draft) return null;
  const isSingle = (draft as any).singleListing === true;
  const u1 = resolveDraftUnitBedrooms(draft as any, "unit1");
  const u2 = isSingle ? 0 : resolveDraftUnitBedrooms(draft as any, "unit2");
  const bathroomsParts = [parseBathrooms((draft as any).unit1Bathrooms), isSingle ? null : parseBathrooms((draft as any).unit2Bathrooms)];
  const bathroomsKnown = isSingle ? bathroomsParts[0] != null : bathroomsParts.every((n) => n != null);
  const draftUnitRefs: UnitAuditUnitRef[] = [
    { label: `Unit A (${u1}BR)`, unitId: draftUnitIdForSlot(-propertyId, "a"), unitIndex: 0 as const, bedrooms: u1 },
    ...(isSingle ? [] : [{ label: `Unit B (${u2}BR)`, unitId: draftUnitIdForSlot(-propertyId, "b"), unitIndex: 1 as const, bedrooms: u2 }]),
  ].filter((r) => r.bedrooms > 0);
  return {
    propertyId,
    isDraft: true,
    propertyName: (draft as any).listingTitle || draft.name,
    communityName: draft.name,
    streetAddress: (draft as any).streetAddress || undefined,
    city: (draft as any).city || undefined,
    state: (draft as any).state || undefined,
    guestyListingId: mapRow?.guestyListingId ?? null,
    groups,
    configuredPhotoFolders,
    unitRefs: draftUnitRefs,
    expectedListingBedrooms: built?.request.expectedListingBedrooms ?? ((u1 + u2) || null),
    unitBedroomSizes: Array.from(new Set([u1, u2].filter((n) => n > 0))),
    bathroomsTotal: bathroomsKnown ? bathroomsParts.reduce((s: number, n) => s + (n ?? 0), 0) : null,
    maxGuestsTotal: null,
    // Draft license fields live in the builder Compliance flow, not on the
    // draft row — the channels stage reports that honestly instead of
    // pretending to have checked them.
    licenses: null,
    unitSourceUrlHints: [
      String((draft as any).unit1SourceUrl ?? "").trim() || undefined,
      String((draft as any).unit2SourceUrl ?? "").trim() || undefined,
    ],
  };
}

// In-memory only (rebuilt on resume): jobId → resolved target.
const targets = new Map<string, UnitAuditTarget>();

// ── Stage implementations (verify-only) ──────────────────────────────────────

type StageOutcome = { verdict: UnitAuditStageVerdict; detail: string; items?: string[] };

function unitGroups(target: UnitAuditTarget): AuditPhotoGroup[] {
  return target.groups.filter((g) => g.role === "unit");
}

function strictPhotoFolderGaps(target: UnitAuditTarget): {
  inventoryUnavailable: boolean;
  communityMissing: boolean;
  communityStatus: ConfiguredPhotoFolderStatus | null;
  units: ConfiguredPhotoFolderStatus[];
} {
  const coverage = classifyUnitAuditConfiguredPhotoCoverage({
    configured: target.configuredPhotoFolders,
    represented: target.groups
      .filter((group) => group.filenames.length > 0)
      .map((group) => ({ role: group.role, label: group.label, folder: group.folder })),
    requiredUnits: target.unitRefs.map((ref) => ({ label: ref.label, unitId: ref.unitId })),
  });
  return {
    inventoryUnavailable: coverage.inventoryUnavailable,
    communityMissing: coverage.communityMissing,
    communityStatus: coverage.communityStatus,
    units: coverage.missingUnits,
  };
}

// PROVENANCE BACKFILL (lever 2 of the "can't confirm photos" fix): a unit
// folder with photos but no _source.json url can't run the source-page
// community leg, so uncertain Lens/vision votes have nothing to upgrade them.
// Recover the URL from records we already trust — the COMMITTED unit-swap row
// for a replacement-* folder (its photos came from newSourceUrl by
// construction), or the draft's saved unit source URL for the draft's own unit
// folder. Never guesses, never clobbers (writeFolderSourceUrlIfMissing).
async function backfillUnitSourceProvenance(target: UnitAuditTarget): Promise<string[]> {
  const notes: string[] = [];
  const units = unitGroups(target);
  if (units.length === 0) return notes;
  let swapsByUnit: Map<string, { oldUnitId: string; newSourceUrl?: string | null }> | null = null;
  for (const g of units) {
    try {
      if (await readFolderSourceUrl(g.folder)) continue;
      let candidate: string | undefined;
      let from = "";
      const repRef = replacementPhotoFolderRef(g.folder);
      if (repRef) {
        if (!swapsByUnit) {
          swapsByUnit = latestUnitSwapsByUnit(await storage.getUnitSwaps(target.propertyId).catch(() => []));
        }
        const url = String(swapsByUnit.get(repRef.oldUnitId)?.newSourceUrl ?? "").trim();
        if (/^https?:\/\//i.test(url)) {
          candidate = url;
          from = "the committed unit-replacement record";
        }
      } else if (target.isDraft) {
        // Only the draft's OWN unit folder may take the draft hint — a swapped
        // folder's photos did not come from the original unit's source URL.
        const ref = target.unitRefs.find((r) => r.label === g.label);
        const hint = ref ? String(target.unitSourceUrlHints?.[ref.unitIndex] ?? "").trim() : "";
        if (/^https?:\/\//i.test(hint)) {
          candidate = hint;
          from = "the draft's saved unit source URL";
        }
      }
      if (!candidate) continue;
      if (await writeFolderSourceUrlIfMissing(g.folder, candidate)) {
        notes.push(`${g.label}: backfilled the photo-source URL from ${from} — the source-page community leg can now verify this unit.`);
      }
    } catch {
      // Fail-soft per folder — backfill is an upgrade, never a blocker.
    }
  }
  return notes;
}

async function stageResolve(record: UnitAuditJobRecord): Promise<StageOutcome> {
  const target = await resolveUnitAuditTarget(record.propertyId);
  if (!target) {
    throw new Error(`Property ${record.propertyId} could not be resolved (unknown builder property / draft).`);
  }
  if (record.fullAutomation && strictPhotoFolderGaps(target).inventoryUnavailable) {
    throw new Error(
      "Configured photo-folder inventory or hydrated scan groups could not be read consistently; strict audit stopped before duplicate cleanup or any other mutation.",
    );
  }
  targets.set(record.jobId, target);
  const items: string[] = [];
  items.push(target.guestyListingId
    ? `Guesty listing mapped (${target.guestyListingId})`
    : record.fullAutomation
      ? "No Guesty listing mapped — the full audit will persist descriptions, amenities, bedding evidence, pricing, and the collage locally; Guesty-only pushes/channels are not required"
      : "NOT connected to a Guesty listing — Guesty-side checks (collage, layout, amenity push, channels) will be skipped");
  const community = target.groups.find((g) => g.role === "community");
  items.push(community
    ? `Community folder ${community.folder} — ${community.filenames.length} photos`
    : "No community photo folder with published photos");
  for (const g of unitGroups(target)) {
    items.push(`${g.label} — folder ${g.folder}, ${g.filenames.length} photos`);
  }
  items.push(...(await backfillUnitSourceProvenance(target)));
  if (unitGroups(target).length === 0) {
    return { verdict: "attention", detail: "Resolved, but no unit photo folders have published photos — the photo stages cannot verify anything.", items };
  }
  return {
    verdict: target.guestyListingId || record.fullAutomation ? "pass" : "attention",
    detail: `${target.propertyName} · ${target.communityName}${target.expectedListingBedrooms ? ` · ${target.expectedListingBedrooms}BR listing` : ""} · ${target.groups.length} photo folder${target.groups.length === 1 ? "" : "s"} resolved`,
    items,
  };
}

async function stagePhotoDedupe(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  if (target.groups.length === 0) {
    return { verdict: "error", detail: "No published photos found — nothing to scan for duplicates." };
  }
  const groupsFor = (t: UnitAuditTarget): DedupeScanGroupInput[] => t.groups.map((g) => ({
    folder: g.folder,
    label: g.label,
    filenames: g.filenames,
    captions: g.captions,
  }));
  const summarize = (proposal: Awaited<ReturnType<typeof scanForDuplicatePhotos>>) => {
    const all = proposal.folders.flatMap((f) => f.groups.map((grp) => ({ ...grp, folderLabel: f.label || f.folder })));
    return {
      all,
      hash: all.filter((g) => g.kind === "exact" || g.kind === "near"),
      sameScene: all.filter((g) => g.kind === "same-scene"),
      lines: all.map((g) => {
        const files = g.members.map((m: any) => m.filename).slice(0, 6).join(", ");
        return `${g.folderLabel}: ${g.kind} group of ${g.members.length} (${files}${g.members.length > 6 ? ", …" : ""})`;
      }),
    };
  };

  const requireCompleteVision = (
    scan: Awaited<ReturnType<typeof scanForDuplicatePhotos>>,
    phase: string,
  ): void => {
    if (!record.fullAutomation) return;
    const incomplete = scan.folders.filter((folder) => folder.totalVisible >= 2 && !folder.visionComplete);
    if (incomplete.length === 0) return;
    throw new Error(
      `Claude alternate-angle duplicate scan was incomplete during ${phase}: ` +
      incomplete.map((folder) => `${folder.label || folder.folder} (` +
        `${folder.scannedForVision}/${folder.totalVisible} photos pair-covered across ${folder.visionBatchCount} batch${folder.visionBatchCount === 1 ? "" : "es"}` +
        `${folder.visionError ? `; ${folder.visionError}` : ""})`).join("; "),
    );
  };

  const runScan = (t: UnitAuditTarget) => scanForDuplicatePhotos(groupsFor(t), {
    // The manual/cron audit keeps the Photos-tab's one sampled call. Only the
    // explicit Dashboard bulk workflow pays for exhaustive pair coverage.
    requireCompleteVision: record.fullAutomation,
  });

  const includeSameScene = String(process.env.AUDIT_DEDUPE_SAME_SCENE ?? "").trim() !== "0";
  const doubleCheckEnabled = String(process.env.AUDIT_DEDUPE_DOUBLE_CHECK ?? "").trim() !== "0";
  if (record.fullAutomation && !includeSameScene) {
    throw new Error("Full dashboard automation requires alternate-angle duplicate removal, but AUDIT_DEDUPE_SAME_SCENE=0 disables it");
  }
  if (record.fullAutomation && !doubleCheckEnabled) {
    throw new Error("Full dashboard automation requires an independent duplicate stability scan, but AUDIT_DEDUPE_DOUBLE_CHECK=0 disables it");
  }

  let proposal = await runScan(target);
  requireCompleteVision(proposal, "the initial gallery scan");
  let s = summarize(proposal);
  const items: string[] = [...s.lines];
  if (proposal.note) items.push(proposal.note);
  if (s.all.length === 0) {
    if (!record.fullAutomation) {
      return {
        verdict: "pass",
        detail: `No duplicates found across ${target.groups.length} folder${target.groups.length === 1 ? "" : "s"}${proposal.visionUsed ? " (hash + AI same-scene scan)" : " (hash-only scan)"}.`,
        items: proposal.note ? [proposal.note] : undefined,
      };
    }
    touch(record, { message: "Confirming the clean gallery with a second exhaustive Claude scan…" });
    const confirmation = await runScan(targets.get(record.jobId) ?? target);
    requireCompleteVision(confirmation, "the initial clean-gallery confirmation");
    const confirmedSummary = summarize(confirmation);
    if (confirmedSummary.all.length === 0) {
      return {
        verdict: "pass",
        detail: `No duplicates found across ${target.groups.length} folder${target.groups.length === 1 ? "" : "s"}; two exhaustive Claude scans independently confirmed the gallery clean.`,
        items: ["Every visible photo was pair-covered by both strict Claude scans."],
      };
    }
    proposal = confirmation;
    s = confirmedSummary;
    items.push(...confirmedSummary.lines);
    items.push("The independent clean-gallery confirmation found candidates; continuing through the normal stability and removal rail.");
  }

  // AUTO-FIX: hide the removable extras via the existing apply route — same
  // keep-one-per-group + never-empty-folder validation as the Photos-tab
  // confirm, and the same photo_labels.hidden soft-delete, so ↺ Undo on the
  // Photos tab remains a true undo. Hash-proven (exact/near) groups always
  // apply; AI same-scene groups apply too per the operator's 2026-07-12
  // "automate fixing all of these" directive — AUDIT_DEDUPE_SAME_SCENE=0
  // restores review-only for them.
  //
  // STABILITY DOUBLE-CHECK (rail C, 2026-07-12): vision same-scene grouping is
  // non-deterministic — a re-scan of the SAME gallery proposes different pairs
  // each run (the live receipt's "3 groups still present" after an apply were
  // NEW pairings, not survivors, so single-scan logic could never converge).
  // An AI group therefore only acts (or flags review) when a second
  // independent scan reproduces it (shared confirmSameSceneGroups); a group
  // only one scan proposes is AI noise — left visible, never a review item.
  // Hash groups are deterministic and skip the double-check.
  // AUDIT_DEDUPE_DOUBLE_CHECK=0 restores single-scan behavior.
  // Stability-filter a scan's same-scene groups with one extra independent
  // scan. Falls back to trusting the single scan when the double-check can't
  // run vision (no key / disabled) — never treats "could not re-check" as
  // "disproven".
  const stabilityFilter = async (
    sameScene: ReturnType<typeof summarize>["sameScene"],
    phase: string,
  ): Promise<{ confirmed: ReturnType<typeof summarize>["sameScene"]; checked: boolean }> => {
    if (!doubleCheckEnabled || sameScene.length === 0) return { confirmed: sameScene, checked: false };
    touch(record, { message: `Double-checking ${sameScene.length} AI same-scene group${sameScene.length === 1 ? "" : "s"} with an independent re-scan (${phase})…` });
    const second = await runScan(targets.get(record.jobId) ?? target);
    requireCompleteVision(second, `the ${phase} double-check`);
    if (!second.visionUsed) {
      items.push(`Double-check scan ran hash-only (vision unavailable) — keeping the single-scan same-scene groups (${phase})`);
      return { confirmed: sameScene, checked: false };
    }
    const { confirmed, noise } = confirmSameSceneGroups(sameScene, summarize(second).sameScene);
    if (noise.length > 0) {
      items.push(`Double-check (${phase}): ${noise.length} same-scene candidate${noise.length === 1 ? "" : "s"} not reproduced by an independent scan — AI noise, left visible`);
    }
    if (confirmed.length > 0) {
      items.push(`Double-check (${phase}): ${confirmed.length} same-scene group${confirmed.length === 1 ? "" : "s"} reproduced by an independent scan`);
    }
    return { confirmed, checked: true };
  };

  const applyRemovals = async (
    scanId: string,
    remove: Array<{ folder: string; filename: string }>,
  ): Promise<boolean> => {
    touch(record, { message: `Hiding ${remove.length} duplicate photo${remove.length === 1 ? "" : "s"} (hash + same-scene extras; soft-delete, undoable)…` });
    await prearmStrictGuestyGallerySync(record);
    const apply = await loopbackJson("POST", "/api/builder/photo-dedupe-apply", { scanId, remove }, 60_000)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (apply.status >= 400) {
      items.push(`Auto-fix could not apply (${String((apply.data as any)?.error ?? `HTTP ${apply.status}`)}) — review on the Photos tab instead`);
      return false;
    }
    items.push(`Auto-fixed: ${remove.length} duplicate photo${remove.length === 1 ? "" : "s"} hidden (soft-delete — ↺ Undo on the Photos tab): ${remove.map((r) => r.filename).slice(0, 8).join(", ")}${remove.length > 8 ? ", …" : ""}`);
    // Feed the end-of-sweep Guesty gallery sync. Persist this handoff in the
    // job record: Railway can restart after the local hide but before the
    // pictures[] PUT, and an in-memory counter would silently lose the sync.
    await markGuestyGallerySyncPending(record, {
      pendingDedupeHiddenCount: record.pendingDedupeHiddenCount + remove.length,
    });
    // Re-resolve the target so re-scans AND every later stage (e.g. the
    // collage candidate list) see the surviving photo set.
    const refreshedTarget = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
    if (refreshedTarget) targets.set(record.jobId, refreshedTarget);
    return true;
  };

  let hiddenTotal = 0;
  let unstableNoise = 0;
  if (autoFixEnabled(record) && (s.hash.length > 0 || (includeSameScene && s.sameScene.length > 0))) {
    const stable = includeSameScene
      ? await stabilityFilter(s.sameScene, "before hiding")
      : { confirmed: [] as ReturnType<typeof summarize>["sameScene"], checked: false };
    unstableNoise += s.sameScene.length - (includeSameScene ? stable.confirmed.length : s.sameScene.length);
    const selection = dedupeAutoFixSelections(
      [...s.hash, ...stable.confirmed].map((g) => ({ kind: g.kind, folder: g.folder, members: g.members })),
      { includeSameScene },
    );
    if (selection.remove.length > 0) {
      if (!(await applyRemovals(proposal.scanId, selection.remove))) {
        return {
          verdict: "attention",
          detail: `${s.hash.length + stable.confirmed.length} duplicate group${s.hash.length + stable.confirmed.length === 1 ? "" : "s"} found but the auto-hide was refused — review with 🧹 Scan photos & remove duplicates.`,
          items,
        };
      }
      hiddenTotal += selection.remove.length;

      // RE-VERIFY with the same stability rule: a fresh scan over the
      // survivors proposes new vision pairings — only double-confirmed ones
      // get ONE more apply round; the rest are noise, not review items.
      proposal = await runScan(targets.get(record.jobId) ?? target);
      requireCompleteVision(proposal, "the post-hide re-scan");
      s = summarize(proposal);
      let residual = {
        confirmed: [] as ReturnType<typeof summarize>["sameScene"],
        checked: false,
      };
      if (includeSameScene && s.sameScene.length > 0) {
        residual = await stabilityFilter(s.sameScene, "re-verify");
        unstableNoise += s.sameScene.length - residual.confirmed.length;
      }
      // The second round consumes deterministic hash groups too. Previously a
      // hash group exposed only after round one was left outstanding even
      // though the apply budget had not been used for it.
      const secondRoundGroups = [...s.hash, ...residual.confirmed];
      if (secondRoundGroups.length > 0) {
        const sel2 = dedupeAutoFixSelections(
          secondRoundGroups.map((g) => ({ kind: g.kind, folder: g.folder, members: g.members })),
          { includeSameScene: true },
        );
        if (sel2.remove.length > 0) {
          if (!(await applyRemovals(proposal.scanId, sel2.remove))) {
            return {
              verdict: "attention",
              detail: `${secondRoundGroups.length} re-confirmed duplicate group${secondRoundGroups.length === 1 ? "" : "s"} remain but the auto-hide was refused — review with 🧹 Scan photos & remove duplicates.`,
              items,
            };
          }
          hiddenTotal += sel2.remove.length;
        }
        // Round cap: two apply rounds per sweep. Strict automation now runs
        // two fresh scans below and refuses to claim clean if a confirmed
        // group survives. Manual audits keep the historical next-audit cap.
        if (record.fullAutomation) {
          items.push("Two apply rounds completed — running the required fresh final scan and stability confirmation");
        } else {
          s = { ...s, hash: [], sameScene: [] };
          items.push("Two apply rounds completed — any further duplicate candidates get checked on the next audit");
        }
      } else if (residual.checked) {
        // Every residual candidate failed the double-check → noise.
        s = { ...s, sameScene: [] };
      }
    } else if (includeSameScene && stable.checked && s.hash.length === 0 && stable.confirmed.length === 0) {
      // Nothing survived the double-check: the whole proposal was AI noise.
      return {
        verdict: "pass",
        detail: `${s.sameScene.length} same-scene candidate${s.sameScene.length === 1 ? "" : "s"} proposed by one AI scan but not reproduced by an independent double-check — treated as vision noise; no real duplicates.`,
        items,
      };
    }
  }

  if (record.fullAutomation && hiddenTotal > 0) {
    touch(record, { message: "Running the final fresh exhaustive duplicate scan and independent stability confirmation…" });
    const currentTarget = targets.get(record.jobId) ?? target;
    const finalPrimary = await runScan(currentTarget);
    requireCompleteVision(finalPrimary, "the final post-removal scan");
    const finalPrimarySummary = summarize(finalPrimary);
    const finalConfirmation = await runScan(targets.get(record.jobId) ?? currentTarget);
    requireCompleteVision(finalConfirmation, "the final post-removal stability confirmation");
    const finalConfirmationSummary = summarize(finalConfirmation);
    const finalSameScene = confirmSameSceneGroups(
      finalPrimarySummary.sameScene,
      finalConfirmationSummary.sameScene,
    );
    const reverseFinalSameScene = confirmSameSceneGroups(
      finalConfirmationSummary.sameScene,
      finalPrimarySummary.sameScene,
    );
    unstableNoise += finalSameScene.noise.length + reverseFinalSameScene.noise.length;
    const finalSameSceneCount = Math.max(
      finalSameScene.confirmed.length,
      reverseFinalSameScene.confirmed.length,
    );
    const finalHash = finalPrimarySummary.hash.length > 0
      ? finalPrimarySummary.hash
      : finalConfirmationSummary.hash;
    items.push(
      `Final verification: ${finalPrimary.folders.reduce((sum, folder) => sum + folder.scannedForVision, 0)} visible photo pair-cover position${finalPrimary.folders.reduce((sum, folder) => sum + folder.scannedForVision, 0) === 1 ? "" : "s"} checked in each of two fresh Claude scans`,
    );
    if (finalHash.length > 0 || finalSameSceneCount > 0) {
      const remaining = [
        finalHash.length > 0 ? `${finalHash.length} hash duplicate group${finalHash.length === 1 ? "" : "s"}` : null,
        finalSameSceneCount > 0
          ? `${finalSameSceneCount} double-confirmed same-scene group${finalSameSceneCount === 1 ? "" : "s"}`
          : null,
      ].filter(Boolean).join(" + ");
      return {
        verdict: "error",
        detail: `${hiddenTotal} duplicate photo${hiddenTotal === 1 ? " was" : "s were"} hidden, but ${remaining} remain after the two-round cap; the strict audit will not claim the gallery is clean.`,
        items,
      };
    }
    s = { ...finalPrimarySummary, all: [], hash: [], sameScene: [], lines: [] };
  }

  const fixedNote = hiddenTotal > 0
    ? `${hiddenTotal} duplicate photo${hiddenTotal === 1 ? "" : "s"} hidden (soft-delete — ↺ Undo on the Photos tab)`
    : "";
  const outstanding = s.hash.length + (includeSameScene ? s.sameScene.length : 0);
  if (outstanding > 0 || (!includeSameScene && s.sameScene.length > 0)) {
    const parts = [
      s.hash.length > 0 ? `${s.hash.length} hash duplicate group${s.hash.length === 1 ? "" : "s"}` : null,
      s.sameScene.length > 0 ? `${s.sameScene.length} same-scene (AI) group${s.sameScene.length === 1 ? "" : "s"}${includeSameScene ? "" : " — needs your eyes (AUDIT_DEDUPE_SAME_SCENE=0)"}` : null,
    ].filter(Boolean).join(" + ");
    return {
      verdict: "attention",
      detail: `${fixedNote ? `${fixedNote}; ` : ""}${parts} — review with 🧹 Scan photos & remove duplicates on the Photos tab.`,
      items,
    };
  }
  const noiseNote = unstableNoise > 0
    ? ` ${unstableNoise} unreproducible same-scene candidate${unstableNoise === 1 ? "" : "s"} dismissed as AI noise.`
    : "";
  return {
    verdict: fixedNote ? "fixed" : "pass",
    detail: fixedNote
      ? `${fixedNote} — re-scan confirms no double-confirmed duplicates remain.${noiseNote}`
      : `No duplicates found across ${target.groups.length} folder${target.groups.length === 1 ? "" : "s"}.${noiseNote}`,
    items,
  };
}

// Structured stage data for the photo-fix ladder — in-memory only (a resume
// mid-ladder re-runs the community check to re-derive it, which is honest:
// the world may have changed).
const communityResults = new Map<string, PhotoCommunityCheckResult>();

// Per-CALL ceiling for one full community check (Lens + vision + source
// pages). Fixed instead of derived from the stage ceiling because the stage
// may now run several independent passes (consensus rail B).
const COMMUNITY_CHECK_CALL_TIMEOUT_MS = 17.5 * 60_000;

async function runCommunityCheck(target: UnitAuditTarget, record: UnitAuditJobRecord, message: string): Promise<
  { ok: true; result: PhotoCommunityCheckResult } | { ok: false; error: string }
> {
  touch(record, { message });
  const { status, data } = await loopbackJson(
    "POST",
    "/api/builder/photo-community-check",
    { propertyId: target.propertyId },
    COMMUNITY_CHECK_CALL_TIMEOUT_MS,
  );
  if (status >= 400 || data?.ok === false) {
    return { ok: false, error: String(data?.error ?? `HTTP ${status}`) };
  }
  const result = data as PhotoCommunityCheckResult;
  communityResults.set(record.jobId, result);
  return { ok: true, result };
}

// CONSENSUS RAIL B (2026-07-12, operator: "no human intervention … double or
// triple check system"): a warn-class community check whose ONLY problem is
// unconfirmed photos/units (pure communityCheckUncertaintyOnly — zero "no"
// votes, zero bedroom shorts, zero junk/dupes) re-runs up to
// AUDIT_COMMUNITY_CONSENSUS_PASSES (default 3) independent times. Lens/vision
// are non-deterministic, so confirmations UNION across passes; any pass that
// surfaces a positive contradiction wins immediately (the double-check may
// honestly DOWNGRADE — it never masks). Only all-passes-zero-contradiction
// may consensus-pass; a "no" vote is never upgraded (Load-Bearing #16).
// Checks that persist through the loopback keep the Comm QA column fed; the
// audit row may read stronger than a single check because it holds strictly
// more evidence (N independent runs).
const communityConsensusPasses = () => {
  const n = Number(process.env.AUDIT_COMMUNITY_CONSENSUS_PASSES ?? String(COMMUNITY_CONSENSUS_PASSES_DEFAULT));
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.floor(n))) : COMMUNITY_CONSENSUS_PASSES_DEFAULT;
};

async function communityOutcomeWithConsensus(
  target: UnitAuditTarget,
  record: UnitAuditJobRecord,
  first: PhotoCommunityCheckResult,
  prefix = "",
): Promise<StageOutcome> {
  const firstOutcome = summarizeCommunityResult(first, prefix);
  const total = communityConsensusPasses();
  // AI FINAL-SAY coverage (2026-07-12): junk flags / cross-dupe pairs Claude
  // already adjudicated KEEP (fingerprint-valid) stop blocking the consensus
  // gate — the independent re-checks below still own the final greening, and
  // a positive contradiction in any pass still wins. "no" votes / bedroom
  // shorts / source-page contradictions are never coverable.
  const coverage: CommunityConsensusCoverage | undefined =
    await coveredJudgmentKeysForFolders(target.groups.map((g) => g.folder)).catch(() => undefined);
  if (firstOutcome.verdict !== "attention" || total <= 1 || !communityCheckUncertaintyOnly(first, coverage)) {
    return firstOutcome;
  }
  const passes: PhotoCommunityCheckResult[] = [first];
  const items = [...(firstOutcome.items ?? [])];
  if (coverage && !communityCheckUncertaintyOnly(first)) {
    const covered = (coverage.coveredPhotoKeys?.size ?? 0) + (coverage.coveredDupeSides?.size ?? 0);
    items.push(`AI judgment: ${covered} previously adjudicated finding(s) treated as resolved (Claude's keep decisions, fingerprint-scoped)`);
  }
  for (let p = 2; p <= total; p++) {
    if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
    const rerun = await runCommunityCheck(
      target,
      record,
      `Unconfirmed photos only — running independent re-check ${p}/${total} (consensus double-check)…`,
    );
    if (!rerun.ok) {
      items.push(`Consensus re-check ${p}/${total} could not run (${rerun.error}) — keeping the first result`);
      return { ...firstOutcome, items };
    }
    passes.push(rerun.result);
    const merged = mergeCommunityConsensusPasses(passes, coverage);
    if (merged.contradiction) {
      const downgraded = summarizeCommunityResult(rerun.result, prefix);
      return {
        verdict: downgraded.verdict,
        detail: `${downgraded.detail} (an independent double-check surfaced this — consensus aborted, the finding stands)`,
        items: [
          ...(downgraded.items ?? []),
          `Double-check pass ${p}/${total} found a positive contradiction the first check missed — findings stand for the fix ladder`,
        ],
      };
    }
    const rerunOutcome = summarizeCommunityResult(rerun.result, prefix);
    if (rerunOutcome.verdict === "pass" || merged.allResolvedByUnion) {
      return {
        verdict: "pass",
        detail: `${prefix}Confirmed by consensus: ${p} independent Lens+vision checks agree — every photo/unit confirmed in at least one pass, zero contradictions.`,
        items: [...(rerunOutcome.items ?? []), `Consensus: confirmed on independent re-check ${p}/${total}`],
      };
    }
  }
  const merged = mergeCommunityConsensusPasses(passes, coverage);
  const residual = merged.residualUnconfirmed;
  return {
    verdict: "pass",
    detail: `${prefix}Verified by ${passes.length}-check consensus: zero contradictions across ${passes.length} independent Lens+vision checks; ${residual.length} photo${residual.length === 1 ? "" : "s"} could not be positively confirmed online (interior shots often can't be) — no evidence of a wrong community.`,
    items: [
      ...items,
      `Consensus: ${passes.length} independent checks, zero contradictions${residual.length > 0 ? `; still unconfirmed after all passes: ${residual.slice(0, 6).join(", ")}${residual.length > 6 ? ", …" : ""}` : ""}`,
    ],
  };
}

function summarizeCommunityResult(result: PhotoCommunityCheckResult, prefix = ""): StageOutcome {
  const items: string[] = [];
  if (result.community) {
    items.push(`Community folder: identified as "${result.community.identifiedCommunity || "unknown"}" — ${result.community.matchesExpected === "yes" ? "matches" : "does NOT match"} ${result.expectedCommunity}`);
  }
  for (const u of result.units ?? []) {
    items.push(`${u.label}: ${u.sameAsCommunity === "yes" ? "same community ✓" : `community NOT confirmed (${u.reason || "no reason given"})`}`);
  }
  for (const u of result.bedroomCoverage?.units ?? []) {
    items.push(`${u.label}: bedroom photos ${u.bedroomsFound}/${u.expectedBedrooms ?? "?"}${u.matchesListing === "no" ? " — SHORT" : ""}`);
  }
  if ((result.duplicates ?? []).length > 0) items.push(`${result.duplicates.length} cross-folder duplicate pair(s)`);
  if (result.warning) items.push(`⚠ ${result.warning}`);
  const verdict: UnitAuditStageVerdict =
    result.verdict === "pass" ? "pass" : result.verdict === "fail" ? "failed" : "attention";
  return {
    verdict,
    detail: `${prefix}${result.summary || `Community check verdict: ${result.verdict}`}`,
    items,
  };
}

// Per-unit problems the photo-fix ladder can act on.
function communityProblemsByUnit(result: PhotoCommunityCheckResult): Map<string, { bedroomShort: boolean; communityMismatch: boolean }> {
  const out = new Map<string, { bedroomShort: boolean; communityMismatch: boolean }>();
  const ensure = (label: string) => {
    if (!out.has(label)) out.set(label, { bedroomShort: false, communityMismatch: false });
    return out.get(label)!;
  };
  for (const u of result.bedroomCoverage?.units ?? []) {
    if (u.matchesListing === "no") ensure(u.label).bedroomShort = true;
  }
  for (const u of result.units ?? []) {
    if (u.sameAsCommunity === "no") ensure(u.label).communityMismatch = true;
  }
  // The full pre-flight engine treats a strongly contradictory source page
  // as a hard community failure even when generic interiors happen to look
  // plausible. Thread that unit-specific failure into the replacement ladder
  // so strict Audit selected finds another unit instead of stopping at a red
  // report with no automatic remedy.
  for (const source of result.sourcePages ?? []) {
    if (sourcePageIsStrongContradiction(source)) ensure(source.unitLabel).communityMismatch = true;
  }
  return out;
}

async function stagePhotoCommunity(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  const strictGaps = record.fullAutomation ? strictPhotoFolderGaps(target) : null;
  if (strictGaps?.inventoryUnavailable) {
    return {
      verdict: "error",
      detail: "The configured photo-folder inventory could not be read, so the full community audit stopped without treating folders as absent or replacing a unit.",
    };
  }
  if (strictGaps?.communityMissing) {
    const folder = strictGaps.communityStatus?.folder;
    return {
      verdict: "failed",
      detail: "The configured community photo folder is missing or empty, so the full community audit cannot be proven.",
      items: [folder ? `Community folder ${folder} has no published photos` : "No community photo folder is configured"],
    };
  }
  if (unitGroups(target).length === 0 && !target.groups.some((g) => g.role === "community")) {
    return { verdict: "error", detail: "No published photos — the community/bedroom check cannot run." };
  }
  const run = await runCommunityCheck(target, record, "Running the full photo community check (Google Lens + Claude vision — this is the long stage)…");
  if (!run.ok) {
    return { verdict: "error", detail: `Community check could not run: ${run.error}` };
  }
  const outcome = await communityOutcomeWithConsensus(target, record, run.result);
  if (strictGaps && strictGaps.units.length > 0) {
    return {
      verdict: "failed",
      detail: `${strictGaps.units.length} configured unit photo folder${strictGaps.units.length === 1 ? " is" : "s are"} missing or empty; omitted folders cannot count as a successful full audit.`,
      items: [
        ...(outcome.items ?? []),
        ...strictGaps.units.map((group) =>
          group.folder
            ? `${group.label}: configured folder ${group.folder} has no published photos`
            : `${group.label}: no photo folder configured`),
      ],
    };
  }
  return outcome;
}

function otaRowFresh(row: { checkedAt: Date | string | null } | undefined, nowMs: number, freshHours: number): boolean {
  if (!row?.checkedAt) return false;
  const t = new Date(row.checkedAt as any).getTime();
  return Number.isFinite(t) && nowMs - t <= freshHours * 3600_000;
}

async function stageOtaScan(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  const folders = unitGroups(target).map((g) => ({ label: g.label, folder: g.folder }));
  if (folders.length === 0) {
    return { verdict: "error", detail: "No unit photo folders — the OTA repost scan cannot run." };
  }
  const kickStart = Date.now();
  const rows = new Map<string, any>();
  for (const f of folders) {
    rows.set(f.folder, await storage.getPhotoListingCheckByFolder(f.folder).catch(() => undefined));
  }
  // Re-scan when the row is stale OR when it is fresh-but-INCONCLUSIVE
  // (all-unknown / Lens outage — the shared predicate the weekly photo cron
  // retries on). "Could not be verified" must mean we TRIED just now, not
  // that we trusted a row that never really ran (rail D, 2026-07-12).
  const stale = folders.filter((f) => {
    const row = rows.get(f.folder);
    if (!otaRowFresh(row, kickStart, otaFreshHoursFor(record))) return true;
    return !!row && photoListingScanWasInconclusive(row);
  });
  const scanDisabled = String(process.env.AUDIT_OTA_SCAN ?? "").trim() === "0";
  if (stale.length > 0 && !scanDisabled) {
    touch(record, { message: `Deep-scanning ${stale.length} unit folder${stale.length === 1 ? "" : "s"} against Airbnb/VRBO/Booking (reverse image + address)…` });
    const kick = await loopbackJson("POST", "/api/photo-listing-check/run", { folders: stale.map((f) => f.folder) }, 30_000)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (kick.status >= 400) {
      return { verdict: "error", detail: `OTA deep scan did not start: ${String(kick.data?.error ?? `HTTP ${kick.status}`)}` };
    }
    // The run endpoint is fire-and-forget — poll the rows until each stale
    // folder's checkedAt passes the kick time (the dashboard modal's pattern).
    const deadline = kickStart + STAGE_TIMEOUT_MS["ota-scan"] - 60_000;
    for (;;) {
      if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
      let pending = 0;
      for (const f of stale) {
        const row = await storage.getPhotoListingCheckByFolder(f.folder).catch(() => undefined);
        rows.set(f.folder, row);
        const t = row?.checkedAt ? new Date(row.checkedAt as any).getTime() : 0;
        if (!(t > kickStart - 1000)) pending += 1;
      }
      if (pending === 0) break;
      if (Date.now() > deadline) {
        return { verdict: "error", detail: `OTA deep scan did not finish in time (${pending} of ${stale.length} folders still scanning) — check the dashboard Photos column later.` };
      }
      await new Promise((r) => setTimeout(r, OTA_POLL_INTERVAL_MS));
    }
  }

  const items: string[] = [];
  let found = 0;
  let unverified = 0;
  for (const f of folders) {
    const row = rows.get(f.folder);
    if (!row) {
      unverified += 1;
      items.push(`${f.label}: no scan result${scanDisabled ? " (scan disabled via AUDIT_OTA_SCAN=0)" : ""}`);
      continue;
    }
    const photo: Array<[string, string]> = [["Airbnb", row.airbnbStatus], ["VRBO", row.vrboStatus], ["Booking.com", row.bookingStatus]];
    const addr: Array<[string, string]> = [["Airbnb", row.airbnbAddressStatus], ["VRBO", row.vrboAddressStatus], ["Booking.com", row.bookingAddressStatus]];
    const photoFound = photo.filter(([, s]) => s === "found").map(([p]) => p);
    const addrFound = addr.filter(([, s]) => s === "found").map(([p]) => p);
    const photoUnknown = photo.filter(([, s]) => s !== "found" && s !== "clean").map(([p]) => p);
    if (photoFound.length > 0) { found += 1; items.push(`${f.label}: photos FOUND on ${photoFound.join(", ")} — links in the dashboard duplicate-photos popup`); }
    if (addrFound.length > 0) { found += 1; items.push(`${f.label}: street address surfaced on ${addrFound.join(", ")}`); }
    if (photoFound.length === 0 && addrFound.length === 0) {
      const ageH = row.checkedAt ? Math.round((Date.now() - new Date(row.checkedAt as any).getTime()) / 3600_000) : null;
      const ageNote = ageH != null && ageH >= 1 ? ` (scanned ${ageH}h ago)` : "";
      if (photoUnknown.length > 0) { unverified += 1; items.push(`${f.label}: ${photoUnknown.join("/")} lookup inconclusive — not proven clean${ageNote}`); }
      else items.push(`${f.label}: clean on Airbnb, VRBO, and Booking.com (photos + address)${ageNote}`);
    }
  }
  if (found > 0) {
    return { verdict: "failed", detail: `Photos or address found on another OTA listing for ${found} unit${found === 1 ? "" : "s"} — replace the photos (dashboard popup has the links).`, items };
  }
  if (unverified > 0) {
    return { verdict: "error", detail: `${unverified} unit folder${unverified === 1 ? "" : "s"} could not be fully verified against the OTAs.`, items };
  }
  return { verdict: "pass", detail: `No photos found on Airbnb / VRBO / Booking.com · address clean (${folders.length} unit folder${folders.length === 1 ? "" : "s"}, deep scan).`, items };
}

// ── Stage: photo fixes — the bounded fix ladder (PR 3) ───────────────────────
// re-scrape source → find a new source listing → replace the unit, re-checking
// after each photo change. Max ONE unit replacement per unit per sweep; the
// replace rung requires record.allowReplace and AUDIT_REPLACE_DISABLED unset.
// AUDIT_PHOTO_FIX=0 skips the whole stage.

const PHOTO_FIX_RESCRAPE_TIMEOUT_MS = 6 * 60_000;
const PHOTO_FIX_FIND_NEW_CEILING_MS = 15 * 60_000;
const PHOTO_FIX_REPLACE_CEILING_MS = 40 * 60_000;
const PHOTO_FIX_REPULL_CEILING_MS = 20 * 60_000;
const PHOTO_FIX_LABEL_WAIT_MS = 240_000;

// Local twin of routes' waitForFolderPhotoLabels (not exported there): the
// bedroom engine selects candidates BY caption/category, so checking before
// the async auto-labeler finishes false-fails 0/N (the 2026-07-07 combo-gate
// root cause). Poll until every published file has a label row, bounded.
async function folderLabelsComplete(folder: string): Promise<boolean> {
  try {
    const files = await listPublishedFilenames(folder);
    if (files.length === 0) return true;
    const labeled = new Set((await storage.getPhotoLabelsByFolder(folder)).map((l) => l.filename));
    return files.every((f) => labeled.has(f));
  } catch {
    return false; // transient — treat as incomplete so callers wait/retry
  }
}

async function waitForFolderLabels(folder: string, timeoutMs = PHOTO_FIX_LABEL_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await folderLabelsComplete(folder)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// Unattended-replacement rails (2026-07-12, operator: a 3BR with one bedroom
// photo "100% needs to be automated"):
//  • cooldown — a unit whose photos already came from a swap inside the
//    window is never cron-swapped again (anti-churn in communities with no
//    better unit). Manual sweeps are exempt — an operator click is explicit.
//  • budget — each weekly cron run may commit at most N replacements (each
//    is a full SearchAPI find sweep); the scheduler resets it per run.
async function lastSwapAtForUnit(propertyId: number, unitId: string): Promise<number | null> {
  const swaps = await storage.getUnitSwaps(propertyId).catch(() => []);
  const latest = latestUnitSwapsByUnit(swaps as Array<{ oldUnitId: string }>);
  const s: any = latest.get(unitId);
  const t = s?.createdAt ? new Date(s.createdAt).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

const cronReplaceCap = () => Math.max(0, Number(process.env.UNIT_AUDIT_CRON_REPLACE_CAP ?? "3") || 3);
let cronReplaceBudgetRemaining = cronReplaceCap();
export function resetCronReplaceBudget(): number {
  cronReplaceBudgetRemaining = cronReplaceCap();
  return cronReplaceBudgetRemaining;
}
function consumeCronReplaceBudget(): boolean {
  if (cronReplaceBudgetRemaining <= 0) return false;
  cronReplaceBudgetRemaining -= 1;
  return true;
}

// Units replaced earlier in the CURRENT sweep — downstream stages regenerate
// copy/collage from the NEW unit's facts instead of trusting stale content.
// In-memory on purpose (a resume mid-sweep loses the hint; the next weekly
// run heals any staleness).
const replacedThisSweep = new Set<string>();

// Local gallery mutations are invisible to a mapped Guesty listing until its
// pictures[] is re-PUT. The durable pendingGuestyGallerySync fields on the job
// record carry that handoff across Railway restarts; one re-push runs only
// after every photo mutation has settled.

async function runPhotoFixRung(
  rung: PhotoFixRung,
  target: UnitAuditTarget,
  ref: UnitAuditUnitRef,
  folder: string,
  record: UnitAuditJobRecord,
  opts: { requireBedroomPhotoCoverage?: boolean } = {},
): Promise<{ ok: boolean; note: string; photoChanged?: boolean; cancelAfterTerminal?: boolean }> {
  if (rung === "rescrape") {
    touch(record, { message: `${ref.label}: re-scraping the current photo source…` });
    await prearmStrictGuestyGallerySync(record);
    const r = await loopbackJson("POST", "/api/builder/rescrape-unit-photos", { folder }, PHOTO_FIX_RESCRAPE_TIMEOUT_MS)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (r.status >= 400) {
      return { ok: false, note: `re-scrape ${(r.data as any)?.needsUrl ? "has no source URL on file" : `failed (${String((r.data as any)?.error ?? `HTTP ${r.status}`)})`}` };
    }
    return { ok: true, note: "re-scraped the current source" };
  }

  if (rung === "find-new") {
    // Exclude every unit folder's CURRENT source so discovery can't re-find
    // the same listing (or steal the sibling's).
    const skipUrls = (await Promise.all(unitGroups(target).map((g) => readFolderSourceUrl(g.folder))))
      .filter((u): u is string => !!u);
    touch(record, { message: `${ref.label}: searching for a new photo source listing…` });
    await prearmStrictGuestyGallerySync(record);
    const job = startPreflightPhotoFetchJob({
      draftId: target.isDraft ? -target.propertyId : 0,
      propertyId: target.propertyId,
      unitId: ref.unitId,
      unitIndex: ref.unitIndex,
      bedrooms: ref.bedrooms,
      communityName: target.communityName,
      streetAddress: target.streetAddress,
      city: target.city,
      state: target.state,
      skipUrls,
      replacingExistingPhotos: true,
      findNewSource: true,
      targetFolder: target.isDraft ? undefined : folder,
    });
    const deadline = Date.now() + PHOTO_FIX_FIND_NEW_CEILING_MS;
    for (;;) {
      const j = getPreflightPhotoFetchJob(job.id);
      if (!j) {
        if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
        return { ok: false, note: "find-new-source job vanished" };
      }
      const childActive = j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled";
      const cancellationPending = cancelRequested.has(record.jobId);
      const cancelAfterTerminal = unitAuditChildPollShouldProcessTerminalBeforeCancel(
        record.fullAutomation, cancellationPending, childActive,
      );
      if (unitAuditChildPollShouldCancel(record.fullAutomation, cancellationPending, childActive) && !cancelAfterTerminal) {
        throw new Error("cancelled");
      }
      if (j.status === "completed") {
        return {
          ok: true,
          note: `found a new source${j.savedCount != null ? ` (${j.savedCount} photos saved)` : ""}${j.sourceUrl ? ` — ${j.sourceUrl}` : ""}`,
          cancelAfterTerminal,
        };
      }
      if (j.status === "failed" || j.status === "cancelled") {
        return {
          ok: false,
          note: `find-new-source ${j.status}: ${j.error ?? j.message ?? "no reason given"}`,
          cancelAfterTerminal,
        };
      }
      if (unitAuditChildPollShouldTimeout(record.fullAutomation, Date.now(), deadline)) {
        return { ok: false, note: "find-new-source did not finish in time" };
      }
      touch(record, {
        message: cancellationPending
          ? `${ref.label}: Cancellation requested — waiting for find-new photo search to finish safely (${j.message || "working…"})`
          : `${ref.label}: ${j.message || "searching for a new photo source…"}`,
      });
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // rung === "replace" — the one-click auto-replace orchestrator (find →
  // commit → verify + Guesty photo push). Its find phase only accepts
  // OTA-clean, community-matched candidates, which is what makes the result
  // trustworthy for the OTA-found case.
  touch(record, { message: `${ref.label}: replacing the unit (find → commit → verify — the long rung)…` });
  await prearmStrictGuestyGallerySync(record);
  const started = await startAutoReplaceJob({
    propertyId: target.propertyId,
    unitId: ref.unitId,
    unitLabel: ref.label,
    origin: record.source === "cron" ? "scheduled-audit" : "operator-audit",
    requireBedroomPhotoCoverage: opts.requireBedroomPhotoCoverage === true,
    requireFullCommunityAudit: record.fullAutomation,
  });
  if (!started.ok) return { ok: false, note: `unit replacement did not start (${started.error})` };
  const replaceJobId = started.job.jobId;
  const deadline = Date.now() + PHOTO_FIX_REPLACE_CEILING_MS;
  for (;;) {
    const jobs2 = await listAutoReplaceJobs();
    const j = jobs2.jobs.find((x) => x.jobId === replaceJobId);
    if (!j) {
      if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
      return { ok: false, note: "replacement job record vanished" };
    }
    const childActive = isAutoReplacePhaseActive(j.phase);
    const cancellationPending = cancelRequested.has(record.jobId);
    const cancelAfterTerminal = unitAuditChildPollShouldProcessTerminalBeforeCancel(
      record.fullAutomation, cancellationPending, childActive,
    );
    if (unitAuditChildPollShouldCancel(record.fullAutomation, cancellationPending, childActive) && !cancelAfterTerminal) {
      throw new Error("cancelled");
    }
    if (!childActive) {
      if (j.phase === "completed") {
        if (record.fullAutomation && !autoReplaceGuestyPushSatisfied(j.guestyPhotoPush, !!target.guestyListingId)) {
          const outcome = j.guestyPhotoPush;
          const reason = outcome?.error ?? outcome?.skipped ?? (outcome ? outcome.status : "missing persisted push receipt");
          return {
            ok: false,
            // The swap itself is already committed. Continue through target
            // refresh, post-swap dedupe, and community verification so the
            // local gallery is fully tidied even though this strict stage must
            // ultimately remain failed for lack of Guesty synchronization.
            photoChanged: true,
            cancelAfterTerminal,
            note: `unit swap committed locally, but the required awaited Guesty gallery push did not sync (${reason}) — the strict audit cannot mark replacement complete`,
          };
        }
        return {
          ok: true,
          note: `unit replaced — ${j.newUnitLabel ?? "new unit"}${j.newAddress ? ` (${j.newAddress})` : ""}`,
          cancelAfterTerminal,
        };
      }
      return {
        ok: false,
        note: `unit replacement failed: ${j.error ?? j.message ?? "no reason given"}`,
        cancelAfterTerminal,
      };
    }
    if (unitAuditChildPollShouldTimeout(record.fullAutomation, Date.now(), deadline)) {
      return { ok: false, note: "unit replacement did not finish inside the audit window — it keeps running; check the dashboard replace queue" };
    }
    touch(record, {
      message: cancellationPending
        ? `${ref.label}: Cancellation requested — waiting for unit replacement to finish safely (${j.phase})`
        : `${ref.label}: replacement ${j.phase} — ${j.message ?? "working…"}`,
    });
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

// ── AI FINAL SAY (2026-07-12 operator directive: "I don't want to make
// judgment calls. I'll leave that to Claude AI to determine.") ───────────────
// The residual review-class findings — junk flags, unit↔unit duplicate
// ownership, still-unconfirmed photos — get ONE forced-choice Claude vision
// call (keep or remove; "uncertain" refused at parse). Removals are the same
// photo_labels.hidden soft-delete the report's Remove button performs
// (floor-guarded, ↺ undoable); every decision lands in the receipt; KEEPs
// persist fingerprint-scoped (photo_judgment_decisions.v1 — the operator-pin
// posture) so the next sweep doesn't re-ask and the consensus rail treats
// them as covered. Red "no" votes are NEVER adjudicated (Load-Bearing #16 —
// they belong to the fix ladder), and a failed/malformed vision answer keeps
// the pre-existing "needs your eyes" behavior (honesty rule #3).
type AiJudgmentSummary = { touched: boolean; failed: boolean; hidden: number; unresolved: number };

async function runAiFinalSayAdjudication(
  target: UnitAuditTarget,
  record: UnitAuditJobRecord,
  result: PhotoCommunityCheckResult,
  items: string[],
): Promise<AiJudgmentSummary> {
  const none: AiJudgmentSummary = { touched: false, failed: false, hidden: 0, unresolved: 0 };
  if (!photoJudgmentEnabled()) return none;
  const communityFolder = target.groups.find((g) => g.role === "community")?.folder;
  const currentFolders = new Set(target.groups.map((g) => g.folder));
  const candidates = collectPhotoJudgmentCandidates(result, { communityFolder })
    .filter((c) => currentFolders.has(c.folder) && (!c.pairFolder || currentFolders.has(c.pairFolder)));
  if (candidates.length === 0) return none;

  const folders = Array.from(new Set(candidates.flatMap((c) => [c.folder, ...(c.pairFolder ? [c.pairFolder] : [])])));
  const fingerprints = await judgmentFingerprintsForFolders(folders);
  const decisions = await loadPhotoJudgmentDecisions();
  const { pending, priorKeeps } = filterAdjudicatedCandidates(candidates, decisions, fingerprints);
  if (priorKeeps.length > 0) {
    items.push(`AI judgment: ${priorKeeps.length} finding(s) already adjudicated keep by Claude on a prior sweep (photo set unchanged) — not re-asked`);
  }
  if (pending.length === 0) return { touched: true, failed: false, hidden: 0, unresolved: 0 };

  touch(record, { message: `Claude is making the final call on ${pending.length} flagged photo${pending.length === 1 ? "" : "s"} (junk / duplicate ownership / unconfirmed)…` });
  const vision = await runPhotoJudgmentVision(target.communityName, pending);
  if (!vision.ok) {
    items.push(`AI judgment could not run (${vision.error}) — the flagged findings stay for review`);
    return { touched: true, failed: true, hidden: 0, unresolved: pending.length };
  }
  if (vision.judged.length < pending.length) {
    items.push(`AI judgment: ${pending.length - vision.judged.length} flagged photo(s) no longer on disk — stale findings skipped`);
  }
  if (vision.judged.length === 0) return { touched: true, failed: false, hidden: 0, unresolved: 0 };

  const visibleCounts: Record<string, number> = {};
  for (const g of target.groups) visibleCounts[g.folder] = g.filenames.length;
  const plan = photoJudgmentActionPlan(vision.judged, vision.verdicts, visibleCounts, { floor: COMMUNITY_PHOTO_FIX_FLOOR });

  // ── REMOVAL VERIFICATION (2026-07-12 operator follow-up: "make sure the
  // photos we're deleting are genuine like duplicates or similar content").
  // Nothing hides on a single opinion: cross-dupe hides need a fresh dHash
  // re-proof from the bytes ON DISK (the stored distance fabricated phantom
  // pairs in the Ilikai stale-hash incident); junk/uncertain hides need an
  // independent adversarial second review (default keep). Unprovable
  // removals are WITHHELD — kept visible, reported, retryable.
  const confirmedHides: typeof plan.hide = [];
  const extraKeeps: typeof plan.keep = [];
  let withheld = 0;

  const dupeSideIndex = new Map<string, PhotoJudgmentCandidate>();
  for (const c of vision.judged) {
    if (c.kind !== "cross-dupe" || !c.pairFolder || !c.pairFilename) continue;
    dupeSideIndex.set(`${c.folder}/${c.filename}`, c);
    dupeSideIndex.set(`${c.pairFolder}/${c.pairFilename}`, c);
  }
  const refuteQueue: typeof plan.hide = [];
  for (const h of plan.hide) {
    if (h.kind !== "cross-dupe") { refuteQueue.push(h); continue; }
    const cand = dupeSideIndex.get(`${h.folder}/${h.filename}`);
    const pair = cand
      ? (cand.folder === h.folder && cand.filename === h.filename
        ? { folder: cand.pairFolder!, filename: cand.pairFilename! }
        : { folder: cand.folder, filename: cand.filename })
      : null;
    const distance = pair ? await verifyDupePairOnDisk({ folder: h.folder, filename: h.filename }, pair) : null;
    if (verifiedDupeHideDistance(distance)) {
      confirmedHides.push({ ...h, reason: `hash-verified duplicate (fresh on-disk distance ${distance}) — ${h.reason}` });
    } else if (distance == null) {
      withheld += 1;
      items.push(`AI judgment: ${h.folder}/${h.filename} removal WITHHELD — could not re-verify the duplicate from the files on disk`);
    } else {
      extraKeeps.push({
        folder: h.folder, filename: h.filename, kind: h.kind, action: "keep",
        reason: `hash re-verification refuted the duplicate (fresh distance ${distance} > ${PHOTO_JUDGMENT_DUPE_HASH_MAX_DISTANCE}) — not the same content, both copies kept`,
      });
      items.push(`AI judgment: kept ${h.folder}/${h.filename} — fresh dHash refuted the duplicate finding (distance ${distance}); both copies stay`);
    }
  }

  if (refuteQueue.length > 0) {
    if (!photoJudgmentDoubleCheckEnabled()) {
      confirmedHides.push(...refuteQueue);
      items.push(`AI judgment: second removal review disabled (AUDIT_JUDGMENT_DOUBLE_CHECK=0) — ${refuteQueue.length} removal(s) acting on the first review only`);
    } else {
      touch(record, { message: `Independent second review of ${refuteQueue.length} removal decision${refuteQueue.length === 1 ? "" : "s"} (adversarial re-check before anything hides)…` });
      const refute = await runRemovalRefuteVision(
        target.communityName,
        refuteQueue.map((h) => ({ folder: h.folder, filename: h.filename, kind: h.kind, reason: h.reason })),
      );
      if (!refute.ok) {
        withheld += refuteQueue.length;
        items.push(`AI judgment could not run the second removal review (${refute.error}) — ${refuteQueue.length} removal(s) withheld this pass`);
      } else {
        refute.verdicts.forEach((v, i) => {
          const h = refuteQueue[i];
          if (v.verdict === "remove") {
            confirmedHides.push({ ...h, reason: `double-confirmed by an independent second review — ${h.reason}` });
          } else {
            extraKeeps.push({
              folder: h.folder, filename: h.filename, kind: h.kind, action: "keep",
              reason: `removal refuted by the independent second review (${v.reason}) — kept`,
            });
            items.push(`AI judgment: kept ${h.folder}/${h.filename} — the second review refuted the removal (${v.reason})`);
          }
        });
      }
    }
  }

  let hidden = 0;
  const hiddenActions: typeof plan.hide = [];
  let putFailed = 0;
  if (confirmedHides.length > 0) await prearmStrictGuestyGallerySync(record);
  for (const h of confirmedHides) {
    if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
    const put = await loopbackJson("PUT", `/api/photo-labels/${encodeURIComponent(h.folder)}/${encodeURIComponent(h.filename)}`, { hidden: true }, 30_000)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (put.status < 400) {
      hidden += 1;
      hiddenActions.push(h);
      items.push(`AI judgment: hid ${h.folder}/${h.filename} (soft-delete — ↺ Undo on the Photos tab) — ${h.reason}`);
      if (hidden === 1 && !record.pendingGuestyGallerySync) await markGuestyGallerySyncPending(record);
    } else {
      putFailed += 1;
      items.push(`AI judgment: could NOT hide ${h.folder}/${h.filename} (${String((put.data as any)?.error ?? `HTTP ${put.status}`)})`);
    }
  }
  const allKeeps = [...plan.keep, ...extraKeeps];
  for (const k of plan.keep) items.push(`AI judgment: kept ${k.folder}/${k.filename} — ${k.reason}`);
  for (const f of plan.floorBlocked) items.push(`AI judgment: ${f.folder}/${f.filename} ${f.reason}`);
  if (plan.lowConfidenceKept > 0) {
    items.push(`AI judgment: ${plan.lowConfidenceKept} low-confidence removal call(s) conservatively resolved as keep`);
  }

  // Persist definitive decisions fingerprint-scoped to the POST-hide photo
  // set (a keep stamped against the pre-hide set would lapse immediately).
  // floorBlocked and WITHHELD removals are deliberately NOT persisted —
  // those stay unresolved.
  const postFingerprints = hidden > 0 ? await judgmentFingerprintsForFolders(folders) : fingerprints;
  const nowIso = new Date().toISOString();
  const rows: PhotoJudgmentDecision[] = [];
  for (const a of allKeeps) {
    const fp = postFingerprints[a.folder];
    if (fp) rows.push({ folder: a.folder, filename: a.filename, kind: a.kind, decision: "keep", reason: a.reason, decidedAt: nowIso, fingerprint: fp });
  }
  for (const a of hiddenActions) {
    const fp = postFingerprints[a.folder];
    if (fp) rows.push({ folder: a.folder, filename: a.filename, kind: a.kind, decision: "remove", reason: a.reason, decidedAt: nowIso, fingerprint: fp });
  }
  if (rows.length > 0) await recordPhotoJudgmentDecisions(rows);

  return { touched: true, failed: false, hidden, unresolved: plan.floorBlocked.length + putFailed + withheld };
}

async function stagePhotoFix(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  if (String(process.env.AUDIT_PHOTO_FIX ?? "").trim() === "0") {
    return record.fullAutomation
      ? { verdict: "error", detail: "Full dashboard automation requires the photo repair/replacement ladder, but AUDIT_PHOTO_FIX=0 disables it." }
      : { verdict: "skipped", detail: "Photo fix ladder disabled via AUDIT_PHOTO_FIX=0." };
  }
  if (!autoFixEnabled(record)) {
    return { verdict: "skipped", detail: "Verify-only run — the photo fix ladder (re-scrape → new source → replace unit) only runs with auto-fix on." };
  }
  if (record.fullAutomation && strictPhotoFolderGaps(target).inventoryUnavailable) {
    return {
      verdict: "error",
      detail: "Configured photo-folder inventory or hydrated scan groups are unavailable — photo repair stopped before OTA planning, repull, or replacement.",
    };
  }

  // What needs fixing? Community/bedroom problems from the stage-3 result
  // (re-derived by a fresh check if this job resumed mid-ladder), OTA-found
  // photos from the persisted photo_listing_checks rows (cheap read).
  const communityRow = record.stages.find((s) => s.stage === "photo-community");
  let communityResult = communityResults.get(record.jobId) ?? null;
  if (!communityResult && (communityRow?.verdict === "failed" || communityRow?.verdict === "attention")) {
    const rerun = await runCommunityCheck(target, record, "Re-deriving the community/bedroom findings after a restart…");
    if (rerun.ok) communityResult = rerun.result;
  }

  const items: string[] = [];
  let anyFixed = false;
  let anyStillFailing = false;
  let anyNeedsReplacePermission = false;

  // ── Community-folder ladder (2026-07-12, from the live Coconut Plantation
  // receipt): hide positively-flagged community photos (RED votes, junk,
  // community-side cross-folder dupes — the flagged-photo Remove button's
  // soft-delete, floor-guarded) → re-check; if the folder STILL reads as the
  // wrong place, run the existing "Find new community photos" repull job
  // (research + re-scrape + vision/Lens verify with mismatch deletion) →
  // re-check again.
  let communityFolderStillBad = false;
  const communityGroupOf = (t: UnitAuditTarget) => t.groups.find((g) => g.role === "community");
  const initialStrictGaps = record.fullAutomation ? strictPhotoFolderGaps(target) : null;
  if (initialStrictGaps?.communityMissing) {
    const configuredFolder = initialStrictGaps.communityStatus?.folder;
    if (!configuredFolder) {
      anyStillFailing = true;
      communityFolderStillBad = true;
      items.push("Community folder: no folder is configured, so the automatic repull cannot run");
    } else {
      touch(record, { message: "Community folder is empty — running Find new community photos before any strict audit can pass…" });
      await prearmStrictGuestyGallerySync(record);
      const repull = startCommunityPhotoRepullJob({
        communityName: target.communityName,
        communityFolder: configuredFolder,
        city: target.city,
        state: target.state,
      });
      const deadline = Date.now() + PHOTO_FIX_REPULL_CEILING_MS;
      let repullCompleted = false;
      let repullVerified = false;
      for (;;) {
        const job = getCommunityPhotoRepullJob(repull.id);
        if (!job) {
          if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
          items.push("Empty community folder repull job vanished");
          break;
        }
        const childActive = job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled";
        const cancellationPending = cancelRequested.has(record.jobId);
        const cancelAfterTerminal = unitAuditChildPollShouldProcessTerminalBeforeCancel(
          record.fullAutomation, cancellationPending, childActive,
        );
        if (unitAuditChildPollShouldCancel(record.fullAutomation, cancellationPending, childActive) && !cancelAfterTerminal) {
          throw new Error("cancelled");
        }
        if (job.status === "completed") {
          repullCompleted = true;
          anyFixed = true;
          items.push(`Empty community folder repull: ${job.savedCount ?? 0} photos saved${job.verifiedCount != null ? `, ${job.verifiedCount} verified` : ""}`);
          await markGuestyGallerySyncPending(record);
          if (cancelAfterTerminal) throw new Error("cancelled");
          const refreshed = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
          if (refreshed) { targets.set(record.jobId, refreshed); target = refreshed; }
          const recheck = await runCommunityCheck(target, record, "Checking the newly populated community folder…");
          if (recheck.ok && recheck.result.community) {
            communityResult = recheck.result;
            repullVerified = true;
          } else {
            items.push(`Empty community folder repull could not be fully rechecked${recheck.ok ? " (community result missing)" : ` (${recheck.error})`}`);
          }
          break;
        }
        if (job.status === "failed" || job.status === "cancelled") {
          items.push(`Empty community folder repull ${job.status}: ${job.message || "no reason given"}`);
          if (cancelAfterTerminal) throw new Error("cancelled");
          break;
        }
        if (unitAuditChildPollShouldTimeout(record.fullAutomation, Date.now(), deadline)) {
          items.push("Empty community folder repull did not finish in time — it keeps running; re-run the audit later");
          break;
        }
        touch(record, {
          message: cancellationPending
            ? `Cancellation requested — waiting for empty-community repull to finish safely (${job.phase})`
            : `Empty community folder repull ${job.phase}: ${job.message || "working…"}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      if (!repullCompleted || !repullVerified || strictPhotoFolderGaps(target).communityMissing) {
        anyStillFailing = true;
        communityFolderStillBad = true;
      }
    }
  }
  if (communityResult?.community) {
    const cg = communityGroupOf(target);
    const c = communityResult.community;
    const selections = cg ? communityPhotoFixSelections({
      communityFolder: cg.folder,
      photoVerdicts: (c.photoVerdicts ?? []).map((v) => ({ id: v.id, folder: v.folder, filename: v.filename, match: v.match })),
      junk: (c.junk ?? []).map((j: any) => ({ id: j.id, reason: j.reason })),
      duplicates: (communityResult.duplicates ?? []),
      visibleCount: cg.filenames.length,
    }) : null;
    for (const line of selections?.reviewOnly ?? []) items.push(`Review: ${line}`);

    if (selections && selections.hide.length > 0) {
      touch(record, { message: `Hiding ${selections.hide.length} flagged community photo${selections.hide.length === 1 ? "" : "s"} (soft-delete, undoable)…` });
      let hidden = 0;
      await prearmStrictGuestyGallerySync(record);
      for (const h of selections.hide) {
        if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
        const put = await loopbackJson("PUT", `/api/photo-labels/${encodeURIComponent(h.folder)}/${encodeURIComponent(h.filename)}`, { hidden: true }, 30_000)
          .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
        if (put.status < 400) {
          hidden += 1;
          items.push(`Community folder: hid ${h.filename} — ${h.reason}`);
          if (hidden === 1 && !record.pendingGuestyGallerySync) await markGuestyGallerySyncPending(record);
        } else {
          items.push(`Community folder: could NOT hide ${h.filename} (${String((put.data as any)?.error ?? `HTTP ${put.status}`)})`);
        }
      }
      if (selections.skippedForFloor > 0) {
        items.push(`Community folder: ${selections.skippedForFloor} more flagged photo(s) left visible to keep at least ${COMMUNITY_PHOTO_FIX_FLOOR} photos — the repull below (or Find new community photos) replaces them`);
      }
      if (hidden > 0) {
        anyFixed = true;
        const refreshed = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
        if (refreshed) { targets.set(record.jobId, refreshed); target = refreshed; }
        const recheck = await runCommunityCheck(target, record, "Re-checking the community folder after hiding flagged photos…");
        if (recheck.ok) communityResult = recheck.result;
      }
    }

    // Identity still wrong (or the floor kept flagged photos visible) →
    // repull the whole community folder through the existing background job.
    const stillBad = communityResult?.community?.matchesExpected === "no" || (selections?.skippedForFloor ?? 0) > 0;
    if (stillBad && cg) {
      touch(record, { message: "Community folder still reads wrong — running Find new community photos (research + re-scrape + verify)…" });
      await prearmStrictGuestyGallerySync(record);
      const repull = startCommunityPhotoRepullJob({
        communityName: target.communityName,
        communityFolder: communityGroupOf(target)?.folder ?? cg.folder,
        city: target.city,
        state: target.state,
      });
      const deadline = Date.now() + PHOTO_FIX_REPULL_CEILING_MS;
      for (;;) {
        const j = getCommunityPhotoRepullJob(repull.id);
        if (!j) {
          if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
          items.push("Community repull job vanished");
          break;
        }
        const childActive = j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled";
        const cancellationPending = cancelRequested.has(record.jobId);
        const cancelAfterTerminal = unitAuditChildPollShouldProcessTerminalBeforeCancel(
          record.fullAutomation, cancellationPending, childActive,
        );
        if (unitAuditChildPollShouldCancel(record.fullAutomation, cancellationPending, childActive) && !cancelAfterTerminal) {
          throw new Error("cancelled");
        }
        if (j.status === "completed") {
          items.push(`Community repull: ${j.savedCount ?? 0} photos saved, ${j.removedCount ?? 0} mismatches removed${j.verifiedCount != null ? `, ${j.verifiedCount} verified` : ""}`);
          anyFixed = true;
          // Repull clears/rebuilds the local community folder. Even if the
          // final count happens to match, Guesty's prior byte set is stale.
          await markGuestyGallerySyncPending(record);
          if (cancelAfterTerminal) throw new Error("cancelled");
          const refreshed = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
          if (refreshed) { targets.set(record.jobId, refreshed); target = refreshed; }
          const recheck = await runCommunityCheck(target, record, "Re-checking the community folder after the repull…");
          if (recheck.ok) communityResult = recheck.result;
          break;
        }
        if (j.status === "failed" || j.status === "cancelled") {
          items.push(`Community repull ${j.status}: ${j.message || "no reason given"}`);
          if (cancelAfterTerminal) throw new Error("cancelled");
          break;
        }
        if (unitAuditChildPollShouldTimeout(record.fullAutomation, Date.now(), deadline)) {
          items.push("Community repull did not finish in time — it keeps running; re-run the audit later");
          break;
        }
        touch(record, {
          message: cancellationPending
            ? `Cancellation requested — waiting for community repull to finish safely (${j.phase})`
            : `Community repull ${j.phase}: ${j.message || "working…"}`,
        });
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    communityFolderStillBad = communityResult?.community?.matchesExpected === "no" ||
      (communityResult?.community?.photoVerdicts ?? []).some((v) => v.match === "no");
    if (communityFolderStillBad) {
      items.push("Community folder still not confirmed after the cleanup ladder — review the report (yellow/uncertain votes may just need your eyes)");
    }
  }

  // AI FINAL SAY: hand the residual judgment calls to Claude BEFORE the unit
  // ladder, so junk/dupe/uncertain cleanup lands in the same result the
  // ladder plans from (a hide that drops bedroom coverage gets fixed by the
  // ladder in this same sweep, not next week's).
  let judgment: AiJudgmentSummary = { touched: false, failed: false, hidden: 0, unresolved: 0 };
  if (communityResult && (communityRow?.verdict === "failed" || communityRow?.verdict === "attention")) {
    judgment = await runAiFinalSayAdjudication(target, record, communityResult, items);
    if (judgment.hidden > 0) {
      anyFixed = true;
      const refreshed = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
      if (refreshed) { targets.set(record.jobId, refreshed); target = refreshed; }
      const recheck = await runCommunityCheck(target, record, "Re-checking photos after Claude's final-say cleanup…");
      if (recheck.ok) communityResult = recheck.result;
    }
  }

  const problems = communityResult ? communityProblemsByUnit(communityResult) : new Map<string, { bedroomShort: boolean; communityMismatch: boolean }>();
  const strictFolderGaps = record.fullAutomation ? strictPhotoFolderGaps(target) : null;
  for (const missing of strictFolderGaps?.units ?? []) {
    // An omitted/empty unit folder is a real bedroom-photo failure, not a
    // smaller property. Feed it into the normal bounded repair ladder so a
    // source refresh can heal an empty folder and replacement remains the
    // terminal fallback.
    problems.set(missing.label, { bedroomShort: true, communityMismatch: false });
  }

  // PROVE a bedroom shortfall before the ladder may act on it (2026-07-12,
  // unattended-replacement rail #1): the bedroom engine reads photo LABELS,
  // written asynchronously after any photo change — a labeling race reading
  // "1/3 bedrooms" must never trigger a swap. If any short unit's folder has
  // unlabeled files, wait for the auto-labeler and re-verify; only a
  // labels-complete shortfall survives into the plans below.
  const shortLabels = Array.from(problems.entries()).filter(([, p]) => p.bedroomShort).map(([label]) => label);
  if (shortLabels.length > 0) {
    let raced = false;
    for (const label of shortLabels) {
      const folder = unitGroups(target).find((g) => g.label === label)?.folder;
      if (!folder) continue;
      if (!(await folderLabelsComplete(folder))) {
        raced = true;
        touch(record, { message: `${label}: photo labels still generating — waiting before trusting the bedroom count…` });
        await waitForFolderLabels(folder);
      }
    }
    if (raced) {
      const recheck = await runCommunityCheck(target, record, "Re-verifying bedroom coverage with labels complete (a labeling race must never trigger a swap)…");
      if (recheck.ok) {
        communityResult = recheck.result;
        problems.clear();
        for (const [k, v] of Array.from(communityProblemsByUnit(recheck.result).entries())) problems.set(k, v);
        items.push("Bedroom shortfall re-verified with photo labels complete before any fix ran");
      }
    }
  }
  for (const missing of strictFolderGaps?.units ?? []) {
    problems.set(missing.label, { bedroomShort: true, communityMismatch: false });
  }

  const otaFoundByLabel = new Set<string>();
  for (const g of unitGroups(target)) {
    const row = await storage.getPhotoListingCheckByFolder(g.folder).catch(() => undefined);
    if (!row) continue;
    const found = [row.airbnbStatus, row.vrboStatus, row.bookingStatus,
      row.airbnbAddressStatus, row.vrboAddressStatus, row.bookingAddressStatus].some((s: any) => s === "found");
    if (found) otaFoundByLabel.add(g.label);
  }

  type UnitPlan = { ref: UnitAuditUnitRef; folder: string; rungs: PhotoFixRung[]; why: string[]; bedroomShort: boolean };
  const plans: UnitPlan[] = [];
  for (const ref of target.unitRefs) {
    const group = unitGroups(target).find((g) => g.label === ref.label);
    const missingFolder = strictFolderGaps?.units.find((missing) =>
      missing.unitId === ref.unitId || missing.label === ref.label);
    if (!group && !missingFolder) continue;
    const p = problems.get(ref.label) ?? { bedroomShort: false, communityMismatch: false };
    const otaFound = otaFoundByLabel.has(ref.label);
    const rungs: PhotoFixRung[] = missingFolder
      ? (missingFolder.folder ? ["rescrape", "find-new", "replace"] : ["replace"])
      : photoFixRungsForUnit({ bedroomShort: p.bedroomShort, communityMismatch: p.communityMismatch, otaFound });
    if (rungs.length === 0) continue;
    const why = [
      missingFolder ? (missingFolder.folder ? "configured photo folder is empty" : "no photo folder is configured") : null,
      otaFound ? "photos/address found on another OTA listing" : null,
      p.communityMismatch ? "photos not confirmed in the community" : null,
      p.bedroomShort && !missingFolder ? "not enough bedroom photos" : null,
    ].filter((s): s is string => !!s);
    plans.push({ ref, folder: missingFolder?.folder ?? group?.folder ?? "", rungs, why, bedroomShort: p.bedroomShort });
  }
  if (plans.length === 0 && !anyFixed && !communityFolderStillBad) {
    // AI FINAL SAY settled every residual judgment call with keeps only
    // (hides would have set anyFixed): refresh the photo-community row
    // through the coverage-aware consensus rail so the receipt converges
    // without the operator — the rail may still honestly DOWNGRADE.
    if (judgment.touched && !judgment.failed && judgment.unresolved === 0 && communityResult) {
      const fresh = await communityOutcomeWithConsensus(target, record, communityResult, "(after AI judgment) ");
      touch(record, {
        stages: upsertUnitAuditStageResult(record.stages, {
          stage: "photo-community",
          verdict: fresh.verdict,
          detail: fresh.detail,
          items: fresh.items,
        }),
      });
      if (fresh.verdict === "pass") {
        return {
          verdict: "pass",
          detail: "No mechanical fixes needed — Claude adjudicated the residual judgment calls (decisions in the log below); nothing left for review.",
          items,
        };
      }
      return {
        verdict: "attention",
        detail: "Claude adjudicated the residual judgment calls, but the follow-up consensus re-check still isn't clean — see the refreshed photo rows above.",
        items,
      };
    }
    // HONESTY (2026-07-12): "nothing to fix" must not render under a failed
    // photo stage — when the earlier rows flagged problems this ladder has no
    // remedy for (yellow/uncertain votes, review-only groups), say that.
    const otaRowNow = record.stages.find((s) => s.stage === "ota-scan");
    const photoRowsBad = [communityRow, otaRowNow].some((r) => r && (r.verdict === "failed" || r.verdict === "attention" || r.verdict === "error"));
    if (photoRowsBad) {
      return {
        verdict: "attention",
        detail: "The earlier photo stages flagged findings this ladder has no automatic remedy for (unconfirmed/yellow votes or unverifiable checks need your eyes) — open the reports above.",
        items: items.length > 0 ? items : undefined,
      };
    }
    return { verdict: "skipped", detail: "Photos verified clean in the earlier stages — nothing to fix." };
  }

  const replaceAllowed = record.allowReplace && String(process.env.AUDIT_REPLACE_DISABLED ?? "").trim() !== "1";

  let anyOnCooldown = false;
  let anyBudgetSpent = false;
  for (const plan of plans) {
    items.push(`${plan.ref.label}: ${plan.why.join("; ")} → ladder: ${plan.rungs.join(" → ")}`);
    let healed = false;
    let blockedOnPermission = false;
    let blockedSoft = false;
    const rungQueue = [...plan.rungs];
    let committedReplacementAttempts = 0;
    for (let rungIndex = 0; rungIndex < rungQueue.length; rungIndex += 1) {
      const rung = rungQueue[rungIndex];
      if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
      if (rung === "replace" && !replaceAllowed) {
        blockedOnPermission = true;
        items.push(`${plan.ref.label}: replacement rung skipped (${record.allowReplace ? "AUDIT_REPLACE_DISABLED=1" : "unit replacement unchecked for this run"}) — use Replace photos on the dashboard popup`);
        break;
      }
      // Unattended (cron) replacements only: anti-churn cooldown + per-run
      // budget. Manual sweeps skip both — an operator click is explicit.
      if (rung === "replace" && record.source === "cron") {
        const cooldownDays = Math.max(0, Number(process.env.AUDIT_REPLACE_COOLDOWN_DAYS ?? "28") || 0);
        const lastSwapAt = await lastSwapAtForUnit(target.propertyId, plan.ref.unitId);
        if (replaceRungOnCooldown(lastSwapAt, Date.now(), cooldownDays)) {
          anyOnCooldown = true;
          blockedSoft = true;
          items.push(`${plan.ref.label}: replacement skipped — this unit was already swapped within the last ${cooldownDays} days and is still short (anti-churn cooldown); this community may have no better unit — run a manual sweep to force another swap`);
          // Cooldown/budget blocks are exactly the cases the automation deliberately leaves to a
          // human, and the cron runs unattended — text the operator (fail-soft, dedup keeps this
          // to one message per unit per weekly cycle).
          void sendOperatorAlert({
            dedupKey: `replace-blocked-cooldown:${target.propertyId}:${plan.ref.unitId}`,
            body: `Weekly audit: ${record.propertyName} — ${plan.ref.label} still needs a unit replacement but was swapped within the last ${cooldownDays} days (anti-churn cooldown). This community may have no better unit; run a manual audit sweep to force another swap.`,
          });
          break;
        }
        if (!consumeCronReplaceBudget()) {
          anyBudgetSpent = true;
          blockedSoft = true;
          items.push(`${plan.ref.label}: replacement skipped — this weekly run's replacement budget (UNIT_AUDIT_CRON_REPLACE_CAP) is spent; next week's run or a manual sweep picks it up`);
          void sendOperatorAlert({
            dedupKey: `replace-blocked-budget:${target.propertyId}:${plan.ref.unitId}`,
            body: `Weekly audit: ${record.propertyName} — ${plan.ref.label} needs a unit replacement but this week's replacement budget is spent. Next week's run picks it up, or run a manual audit sweep now.`,
          });
          break;
        }
      }
      const rungResult = await runPhotoFixRung(rung, target, plan.ref, plan.folder, record, {
        // A bedroom-shortfall replacement must not commit a gallery that is
        // itself short (Ilikai receipt: APT 510 photographed 1 of 2 bedrooms
        // and the ladder ended "still short") — the commit aborts at staging
        // and the orchestrator tries the next candidate instead.
        requireBedroomPhotoCoverage: plan.bedroomShort,
      });
      items.push(`${plan.ref.label}: ${rung} — ${rungResult.ok ? rungResult.note : `✕ ${rungResult.note}`}`);
      if (!rungResult.ok && !rungResult.photoChanged) {
        if (rungResult.cancelAfterTerminal) throw new Error("cancelled");
        continue;
      }
      const strictSyncFailed = !rungResult.ok && rungResult.photoChanged === true;
      if (rung === "replace") committedReplacementAttempts += 1;
      else {
        // Re-scrape/find-new replace the local folder without touching Guesty.
        // Carry a durable sync obligation to the sweep's final gallery seam.
        await markGuestyGallerySyncPending(record);
      }
      // A committed swap means downstream stages must re-ground content in
      // the NEW unit (descriptions regenerate, collage re-composes).
      if (rung === "replace") {
        replacedThisSweep.add(record.jobId);
        // The replacement orchestrator has just completed its awaited Guesty
        // gallery push. On a verified push, every prior local change rode
        // along and the durable obligation clears. If that awaited push failed,
        // retain the obligation so the end seam can make one final attempt.
        if (rungResult.ok) await clearGuestyGallerySyncPending(record);
        else await markGuestyGallerySyncPending(record);
      }
      if (rungResult.cancelAfterTerminal) throw new Error("cancelled");

      // Photos changed: re-resolve the target (active folders may have moved),
      // wait for the auto-labeler, then re-check. Later stages read the
      // refreshed target from the map.
      const refreshed = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
      if (refreshed) {
        targets.set(record.jobId, refreshed);
        target = refreshed;
      }
      const newFolder = unitGroups(target).find((g) => g.label === plan.ref.label)?.folder ?? plan.folder;
      plan.folder = newFolder;
      touch(record, { message: `${plan.ref.label}: waiting for the photo auto-labeler on ${newFolder}…` });
      const labelsReady = await waitForFolderLabels(newFolder);
      if (!labelsReady) items.push(`${plan.ref.label}: photo labels were still generating after 4 min — the re-check may under-count bedrooms; re-run the audit if it reads short`);

      // A re-scrape/find-new/replacement can introduce exact copies or several
      // angles of the same scene after the sweep's initial dedupe stage. In
      // full dashboard mode, run the same hash + Claude same-scene engine over
      // the new final gallery before community/bedroom verification. This is
      // deliberately before the check: bedroom coverage must reflect the
      // photos that will actually remain visible.
      if (record.fullAutomation) {
        touch(record, { message: `${plan.ref.label}: tidying the changed gallery (exact + alternate-angle duplicate removal)…` });
        const dedupe = await stagePhotoDedupe(target, record);
        items.push(`${plan.ref.label}: final dedupe — ${dedupe.detail}`);
        if (dedupe.items?.length) items.push(...dedupe.items.map((line) => `${plan.ref.label} dedupe: ${line}`));
        touch(record, {
          stages: upsertUnitAuditStageResult(record.stages, {
            stage: "photo-dedupe",
            verdict: dedupe.verdict,
            detail: `Final post-change gallery: ${dedupe.detail}`,
            items: dedupe.items,
          }),
        });
        if (dedupe.verdict !== "pass" && dedupe.verdict !== "fixed") {
          items.push(`${plan.ref.label}: changed gallery could not be proven duplicate-free — trying the next repair rung`);
          continue;
        }
        const afterDedupe = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
        if (afterDedupe) {
          targets.set(record.jobId, afterDedupe);
          target = afterDedupe;
          plan.folder = unitGroups(target).find((g) => g.label === plan.ref.label)?.folder ?? plan.folder;
        }
      }
      const recheck = await runCommunityCheck(target, record, `${plan.ref.label}: re-checking community + bedroom coverage after the ${rung}…`);
      if (!recheck.ok) {
        items.push(`${plan.ref.label}: re-check could not run (${recheck.error})`);
        continue;
      }
      communityResult = recheck.result;
      const after = communityProblemsByUnit(recheck.result).get(plan.ref.label);
      const stillOta = rung === "replace" ? false : otaFoundByLabel.has(plan.ref.label);
      const strictGate = record.fullAutomation
        ? classifyStagedUnitCommunityAudit(recheck.result, {
            targetFolder: plan.folder,
            bedroomCoverageReliable: labelsReady,
          })
        : null;
      if (strictGate?.decision === "inconclusive") {
        items.push(`${plan.ref.label}: final full preflight proof was inconclusive (${strictGate.reason}) — no candidate was burned and no additional destructive replacement was started`);
        continue;
      }
      const strictVerified = !record.fullAutomation || strictGate?.decision === "accept";
      if (strictVerified && !after?.bedroomShort && !after?.communityMismatch && !stillOta) {
        anyFixed = true;
        if (strictSyncFailed) {
          items.push(`${plan.ref.label}: local replacement gallery is clean, but Guesty synchronization is still unverified — this audit remains failed`);
          break;
        }
        healed = true;
        if (rung === "replace") {
          // The flagged photos are gone with the old unit; the replace flow's
          // find phase only accepts OTA-clean candidates and it already
          // kicked a fresh deep rescan of the new folder.
          otaFoundByLabel.delete(plan.ref.label);
        }
        items.push(`${plan.ref.label}: ✓ re-verified clean after the ${rung}`);
        break;
      }
      if (strictGate?.decision === "reject") {
        items.push(`${plan.ref.label}: final full preflight rejected this gallery (${strictGate.reason})`);
      }
      if (strictGate && shouldRetryCommittedFullAutomationReplacement({
        fullAutomation: record.fullAutomation,
        rung,
        gateDecision: strictGate.decision,
        reasonCode: strictGate.reasonCode,
        strictSyncFailed,
        committedAttempts: committedReplacementAttempts,
      })) {
        rungQueue.push("replace");
        items.push(`${plan.ref.label}: committed candidate ${committedReplacementAttempts}/${MAX_FULL_AUTOMATION_COMMITTED_REPLACEMENTS} failed a positive community/bedroom check — automatically finding another distinct unit`);
        continue;
      }
      items.push(`${plan.ref.label}: still ${[after?.bedroomShort ? "short on bedroom photos" : null, after?.communityMismatch ? "unconfirmed community" : null, stillOta ? "OTA-flagged" : null].filter(Boolean).join(" + ")} — trying the next rung`);
    }
    if (!healed) {
      if (blockedOnPermission) anyNeedsReplacePermission = true;
      else if (!blockedSoft) anyStillFailing = true;
    }
  }

  // Refresh the earlier photo rows so the roll-up reflects the POST-fix
  // state: the stage-3 row gets the freshest check result; the stage-4 row
  // flips to fixed only for units whose replacement removed the flagged
  // photos (the new gallery was OTA-clean-gated by the find phase).
  // The post-fix row goes through the SAME consensus rail as stage 3 — the
  // live receipt's residual "N could not be confirmed online" review chip
  // came from exactly this upsert, so uncertainty-only leftovers here also
  // get the independent double/triple re-check instead of a human.
  if (anyFixed && communityResult) {
    const fresh = await communityOutcomeWithConsensus(target, record, communityResult, "(after photo fixes) ");
    communityResult = communityResults.get(record.jobId) ?? communityResult;
    touch(record, {
      stages: upsertUnitAuditStageResult(record.stages, {
        stage: "photo-community",
        verdict: fresh.verdict,
        detail: fresh.detail,
        items: fresh.items,
      }),
    });
    const otaRow = record.stages.find((s) => s.stage === "ota-scan");
    if (otaRow && otaRow.verdict === "failed" && otaFoundByLabel.size === 0) {
      touch(record, {
        stages: upsertUnitAuditStageResult(record.stages, {
          stage: "ota-scan",
          verdict: "fixed",
          detail: "Flagged unit(s) replaced — the found photos are no longer used; the replace flow verified the new gallery OTA-clean and kicked a fresh deep rescan (dashboard Photos column).",
          items: otaRow.items,
        }),
      });
    }
  }

  const communityIdentityStillWrong = communityResult?.community?.matchesExpected === "no";
  if (anyStillFailing || communityIdentityStillWrong) {
    return {
      verdict: "failed",
      detail: communityIdentityStillWrong && !anyStillFailing
        ? "The community folder still reads as the wrong place after the cleanup + repull ladder — see the log below; Find new community photos (preflight) is the manual fallback."
        : "The fix ladder ran but at least one unit still fails — see the rung-by-rung log below; the dashboard Replace photos flow is the manual fallback.",
      items,
    };
  }
  if (anyNeedsReplacePermission) {
    return {
      verdict: "attention",
      detail: "Fixing these photos needs a unit replacement, which this run wasn't allowed to do — re-run with \"Allow unit replacement\" checked or use Replace photos on the dashboard popup.",
      items,
    };
  }
  if (anyOnCooldown || anyBudgetSpent) {
    return {
      verdict: "attention",
      detail: anyOnCooldown
        ? "A unit still needs replacing but was already swapped recently (anti-churn cooldown) — this community may have no better unit; a manual sweep forces another attempt."
        : "A unit still needs replacing but this weekly run's replacement budget is spent — next week's run (or a manual sweep) picks it up.",
      items,
    };
  }
  if (communityFolderStillBad) {
    return {
      verdict: "attention",
      detail: "Fixes applied, but some community photos still carry mismatch votes after the ladder — they may be shared-resort look-alikes; review the report.",
      items,
    };
  }
  if (judgment.unresolved > 0) {
    return {
      verdict: "attention",
      detail: `Claude's final say decided ${judgment.unresolved} photo(s) should be removed but they were kept visible (folder floor, a failed hide, or a removal the verification pass could not prove) — add replacement photos (Find new photos) or remove them on the Photos tab.`,
      items,
    };
  }
  return {
    verdict: "fixed",
    detail: `Photo problems fixed and re-verified${plans.length > 0 ? ` for ${plans.length} unit${plans.length === 1 ? "" : "s"}` : judgment.hidden > 0 ? " (AI judgment cleanup)" : " (community folder cleanup)"} — log below.`,
    items,
  };
}

// Effective description fields = what a push would actually send: an
// operator/regenerated OVERRIDE wins over the generated/static base per field
// (the Descriptions-tab contract) — so an override that fixed a placeholder
// must not keep flagging the stale base copy underneath it.
async function effectiveDescriptionFields(target: UnitAuditTarget): Promise<{
  overrides: Record<string, string>;
  fields: Record<string, string>;
}> {
  const overridesRow = await storage.getPropertyDescriptionOverrides(target.propertyId).catch(() => undefined);
  const overrides: Record<string, string> = {};
  for (const field of DESCRIPTION_OVERRIDE_FIELDS) {
    const v = String((overridesRow as any)?.[field] ?? "").trim();
    if (v) overrides[field] = v;
  }
  const fields: Record<string, string> = { ...overrides };
  if (target.isDraft) {
    const draft: any = await storage.getCommunityDraft(-target.propertyId).catch(() => undefined);
    if (!fields.summary) fields.summary = String(draft?.description ?? "").trim();
    if (!fields.space) {
      fields.space = [String(draft?.unit1Description ?? ""), draft?.singleListing === true ? "" : String(draft?.unit2Description ?? "")]
        .map((s) => s.trim()).filter(Boolean).join("\n\n");
    }
    if (!fields.title) fields.title = String(draft?.listingTitle ?? "").trim();
  } else {
    const builder = getUnitBuilderByPropertyId(target.propertyId);
    if (!fields.summary) fields.summary = String(builder?.combinedDescription ?? "").trim();
    if (!fields.space) {
      fields.space = (builder?.units ?? [])
        .map((u) => [u.shortDescription, u.longDescription].filter(Boolean).join(" ").trim())
        .filter(Boolean).join("\n\n");
    }
    if (!fields.neighborhood) fields.neighborhood = String(builder?.neighborhood ?? "").trim();
    if (!fields.transit) fields.transit = String(builder?.transit ?? "").trim();
  }
  return { overrides, fields };
}

function describeDescriptionProblems(fields: Record<string, string>): {
  placeholderFields: string[];
  embeddedHeaders: string[];
  emptySummary: boolean;
  items: string[];
} {
  const items: string[] = [];
  const hits = findDescriptionPlaceholders(fields);
  for (const hit of hits) items.push(`${hit.field}: placeholder scaffolding ("${hit.phrase.slice(0, 60)}…")`);
  const embeddedHeaders = AREA_SECTION_HEADERS.filter((h) => (fields.summary ?? "").toUpperCase().includes(h));
  if (embeddedHeaders.length > 0) {
    items.push(`Summary embeds ${embeddedHeaders.join(" + ")} section${embeddedHeaders.length === 1 ? "" : "s"} — these push as their own OTA fields and would duplicate`);
  }
  const emptySummary = !(fields.summary ?? "").trim();
  if (emptySummary) items.push("Summary/description is EMPTY");
  return {
    placeholderFields: Array.from(new Set(hits.map((h) => h.field))),
    embeddedHeaders,
    emptySummary,
    items,
  };
}

// AUTO-FIX: the server-side twin of the Descriptions tab's "↻ Regenerate
// descriptions" — same generator endpoint grounded in each unit's REAL
// source-listing URL (_source.json) + the property address, same disclosure
// composition, persisted as overrides, then the regenerated fields (ONLY)
// are pushed to Guesty. `notes` is never touched (compliance-owned) and a
// generator fallback (`warning` set) is REFUSED — never applied.
async function regenerateDescriptionsForTarget(target: UnitAuditTarget): Promise<{
  ok: boolean;
  note: string;
  patch?: Record<string, string>;
  guestyStatus?: "not-requested" | "pushed" | "failed";
}> {
  type GenUnit = { bedrooms: number; folder: string | null };
  let units: GenUnit[] = [];
  let address = "";
  if (target.isDraft) {
    const draft: any = await storage.getCommunityDraft(-target.propertyId).catch(() => undefined);
    if (!draft) return { ok: false, note: "Draft row not found for regenerate." };
    units = [{ bedrooms: resolveDraftUnitBedrooms(draft, "unit1"), folder: draft.unit1PhotoFolder ?? null }];
    if (draft.singleListing !== true) units.push({ bedrooms: resolveDraftUnitBedrooms(draft, "unit2"), folder: draft.unit2PhotoFolder ?? null });
    address = [draft.streetAddress, draft.city, draft.state].filter(Boolean).join(", ");
  } else {
    const builder = getUnitBuilderByPropertyId(target.propertyId);
    if (!builder) return { ok: false, note: "Builder property not found for regenerate." };
    units = builder.units.map((u) => ({ bedrooms: u.bedrooms, folder: u.photoFolder ?? null }));
    address = builder.address ?? "";
  }
  units = units.filter((u) => u.bedrooms > 0);
  if (units.length === 0) return { ok: false, note: "No units with a bedroom count — cannot regenerate." };
  const singleListing = units.length === 1;
  const sourceUrls = await Promise.all(units.map((u) => (u.folder ? readFolderSourceUrl(u.folder) : Promise.resolve(undefined))));

  const { status, data: gen } = await loopbackJson("POST", "/api/community/generate-listing", {
    communityName: target.communityName,
    city: target.city ?? "",
    state: target.state ?? "",
    singleListing,
    unit1: { bedrooms: units[0].bedrooms, url: sourceUrls[0] ?? "", address },
    ...(singleListing ? {} : { unit2: { bedrooms: units[1].bedrooms, url: sourceUrls[1] ?? "" } }),
    suggestedRate: 0,
  }, 4 * 60_000).catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
  if (status >= 400) return { ok: false, note: `Generator call failed: ${String((gen as any)?.error ?? `HTTP ${status}`)}` };
  if ((gen as any)?.warning) return { ok: false, note: `Generator returned fallback copy — refused (never applied): ${String((gen as any).warning)}` };
  if ((gen as any)?.generation?.method !== "claude") {
    return { ok: false, note: "Generator did not prove Claude provenance — refused (never applied)." };
  }

  const requiredClaudeFields = ["title", "summary", "space", "neighborhood", "transit", "access", "houseRules"];
  const missingClaudeFields = requiredClaudeFields.filter((field) => !String((gen as any)?.[field] ?? "").trim());
  if (missingClaudeFields.length > 0) {
    return { ok: false, note: `Claude omitted required description field(s): ${missingClaudeFields.join(", ")} — nothing was saved.` };
  }

  const summaryBody = [gen?.summary, gen?.space].map((s: unknown) => String(s ?? "").trim()).filter(Boolean).join("\n\n");
  if (!summaryBody) return { ok: false, note: "Generator returned no description copy." };
  // Same composition as the builder's regenerate button (index.tsx): the
  // combo top-disclosure is LISTING_DISCLOSURE without its trailing rule.
  const comboTopDisclosure = LISTING_DISCLOSURE.replace(/\s*---\s*$/i, "").trim();
  const summary = composeSummaryWithDisclosures(summaryBody, {
    top: singleListing ? "" : comboTopDisclosure,
    bottom: singleListing ? SINGLE_LISTING_SAMPLE_DISCLOSURE : REPRESENTATIVE_ACCOMMODATIONS_DISCLOSURE,
  });
  const space = composeSpaceFromUnitDescriptions(
    units.map((u, i) => ({
      label: `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR)`,
      text: String((i === 0 ? (gen as any)?.unitA?.longDescription : (gen as any)?.unitB?.longDescription) ?? "").trim(),
    })),
    !singleListing ? String((gen as any)?.walk?.description ?? "").trim() : "",
  );
  const patch: Record<string, string> = {};
  const title = String((gen as any)?.title ?? "").trim();
  if (title) patch.title = title;
  if (summary) patch.summary = summary;
  if (space) patch.space = space;
  const neighborhood = String((gen as any)?.neighborhood ?? "").trim();
  if (neighborhood) patch.neighborhood = neighborhood;
  const transit = String((gen as any)?.transit ?? "").trim();
  if (transit) patch.transit = transit;
  const access = String((gen as any)?.access ?? "").trim();
  if (access) patch.access = access;
  const houseRules = String((gen as any)?.houseRules ?? "").trim();
  if (houseRules) patch.houseRules = houseRules;
  const requiredGeneratedFields = ["title", "summary", "space", "neighborhood", "transit", "access", "houseRules"];
  const missingGeneratedFields = requiredGeneratedFields.filter((field) => !String(patch[field] ?? "").trim());
  if (missingGeneratedFields.length > 0) {
    return { ok: false, note: `Claude omitted required description field(s): ${missingGeneratedFields.join(", ")} — nothing was saved.` };
  }

  await storage.upsertPropertyDescriptionOverrides(target.propertyId, patch);
  let note = `Regenerated ${Object.keys(patch).join(", ")} with ${(gen as any).generation.model ?? "Claude"} from the real source listings and saved as overrides`;

  let guestyStatus: "not-requested" | "pushed" | "failed" = "not-requested";
  if (target.guestyListingId) {
    const push = await loopbackJson("POST", "/api/builder/push-descriptions", {
      listingId: target.guestyListingId,
      descriptions: patch,
      // The stage runs its OWN awaited published-address ensure right after —
      // suppress the route's fire-and-forget hook so a full-automation audit
      // doesn't double-push the address (2 concurrent GET/PUT/GET rounds).
      skipPublishedAddressEnsure: true,
    }, 60_000).catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (push.status < 400 && (push.data as any)?.success === true && (push.data as any)?.verified === true) {
      guestyStatus = "pushed";
      note += "; pushed to Guesty (placeholder guard re-passed)";
    } else {
      guestyStatus = "failed";
      note += `; Guesty push failed (${String((push.data as any)?.error ?? `HTTP ${push.status}`)}) — local overrides were saved`;
    }
  } else {
    note += "; no Guesty listing yet — the copy pushes when one is connected";
  }
  return { ok: true, note, patch, guestyStatus };
}

async function stageDescriptions(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  let { overrides, fields } = await effectiveDescriptionFields(target);
  let problems = describeDescriptionProblems(fields);
  const items: string[] = [...problems.items];

  let fixedNote = "";
  // A unit replaced earlier in THIS sweep means the copy describes the OLD
  // unit — regenerate from the NEW unit's source listing even if the old
  // copy was otherwise clean (post-swap follow-through, 2026-07-12).
  const forcedBySwap = replacedThisSweep.has(record.jobId);
  const needsFix = record.fullAutomation || problems.placeholderFields.length > 0 || problems.embeddedHeaders.length > 0 || problems.emptySummary || forcedBySwap;
  if (needsFix && autoFixEnabled(record)) {
    if (record.fullAutomation) items.push("Full dashboard audit: regenerating every marketing-description field with Claude, even when existing copy looks valid");
    if (forcedBySwap) items.push("Regenerating because a unit was replaced earlier in this sweep — grounding the copy in the NEW unit's source listing");
    touch(record, { message: "Regenerating descriptions from the real source listings (Claude)…" });
    const fix = await regenerateDescriptionsForTarget(target);
    items.push(fix.ok ? `Auto-fixed: ${fix.note}` : `Auto-fix failed: ${fix.note}`);
    if (!fix.ok && record.fullAutomation) {
      return {
        verdict: "error",
        detail: `Claude description generation did not complete, so existing copy was not accepted: ${fix.note}`,
        items,
      };
    }
    if (fix.ok && record.fullAutomation && target.guestyListingId && fix.guestyStatus !== "pushed") {
      return {
        verdict: "error",
        detail: "Claude descriptions were regenerated and saved locally, but the mapped Guesty listing did not accept the update.",
        items,
      };
    }
    if (fix.ok) {
      fixedNote = fix.note;
      ({ overrides, fields } = await effectiveDescriptionFields(target));
      problems = describeDescriptionProblems(fields);
      if (problems.items.length > 0) items.push(...problems.items.map((l) => `Re-verify: ${l}`));
    }
  }

  // Separate published address (2026-07-17): every audited listing must have
  // Guesty's published-address feature ON, pointed at the clubhouse (or the
  // generic main-building street). Idempotent — the engine skips the PUT when
  // Guesty already shows the target address, so weekly cron sweeps stay
  // cheap (two reads). A failure never blocks the descriptions verdict below
  // pass→attention: it's a listing-config gap, not broken copy. The
  // "Auto-fix failed:" prefix deliberately makes the row rail-A retryable
  // (transient Guesty 429/5xx heals on the automatic re-run).
  let publishedAddressIssue: string | null = null;
  if (target.guestyListingId && autoFixEnabled(record) && process.env.AUDIT_PUBLISHED_ADDRESS !== "0") {
    touch(record, { message: "Verifying the separate published address on Guesty…" });
    try {
      const pa = await pushPublishedAddressForListing({
        listingId: target.guestyListingId,
        propertyId: target.propertyId,
        reason: "unit-audit",
      });
      if (pa.ok && pa.alreadyOn) {
        items.push(`Published address: already enabled (${pa.address?.street ?? "?"} · ${pa.address?.source ?? "community"})`);
      } else if (pa.ok) {
        items.push(`Auto-fixed: separate published address enabled (${pa.address?.street ?? "?"} · ${pa.address?.source ?? "community"})`);
      } else {
        publishedAddressIssue = pa.error ?? "push failed";
        items.push(`Auto-fix failed: separate published address — ${publishedAddressIssue}`);
      }
    } catch (e: any) {
      publishedAddressIssue = String(e?.message ?? e);
      items.push(`Auto-fix failed: separate published address — ${publishedAddressIssue}`);
    }
  }

  const overrideNote = Object.keys(overrides).length > 0
    ? `${Object.keys(overrides).length} override${Object.keys(overrides).length === 1 ? "" : "s"} (✎/regenerated) in effect`
    : "no overrides — generated copy in effect";

  if (problems.placeholderFields.length > 0) {
    return {
      verdict: "failed",
      detail: `Placeholder scaffolding in ${problems.placeholderFields.length} field(s) — the Guesty push guard would reject this; run ↻ Regenerate descriptions on the Descriptions tab.`,
      items,
    };
  }
  if (problems.embeddedHeaders.length > 0 || problems.emptySummary) {
    return { verdict: "attention", detail: "Description copy needs cleanup — see the findings below.", items };
  }
  // A published-address failure caps an otherwise-clean stage at attention
  // (never a silent pass) — the copy is fine, the listing config isn't.
  if (publishedAddressIssue) {
    return {
      verdict: "attention",
      detail: `Copy is clean, but the separate published address could not be confirmed on Guesty — ${publishedAddressIssue}`,
      items,
    };
  }
  if (fixedNote) {
    return { verdict: "fixed", detail: `${fixedNote} — re-verify clean.`, items };
  }
  return {
    verdict: "pass",
    detail: `No placeholder copy · summary ${(fields.summary ?? "").trim().length} chars · ${overrideNote}.`,
    items: items.length > 0 ? items : undefined,
  };
}

type AmenityVerify = {
  row: Awaited<ReturnType<typeof storage.getPropertyAmenities>>;
  keys: string[];
  scannedNote: string;
  /** null = Guesty not readable / not mapped; else keys absent from the listing. */
  missing: string[] | null;
  guestyCount: number | null;
  guestyReadError: string | null;
};

async function verifyAmenities(target: UnitAuditTarget): Promise<AmenityVerify> {
  const row = await storage.getPropertyAmenities(target.propertyId).catch(() => undefined);
  const keys: string[] = Array.isArray(row?.amenityKeys) ? (row!.amenityKeys as string[]) : [];
  const scannedNote = row?.scannedAt
    ? `last scanned ${new Date(row.scannedAt as any).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : row ? "saved manually (never AI-scanned)" : "never scanned";
  if (!target.guestyListingId) {
    return { row, keys, scannedNote, missing: null, guestyCount: null, guestyReadError: null };
  }
  // SAME read-back the add-only push uses ({amenities, otherAmenities} via
  // /properties-api/amenities/:propertyId) and the SAME normalizer the push
  // route resolves names with — the push maps "BBQ / Grill" → canonical
  // "BBQ grill", "Ocean View" → "Sea view", etc., so a plain label comparison
  // against the stored names falsely read 27 pushed amenities as missing
  // (the 2026-07-12 Coconut Plantation receipt). Read with bounded retries:
  // the route makes TWO serialized Guesty calls behind the global rate-limit
  // gate, so a single short attempt falsely reported "could not be verified"
  // during a 429 pause (the same day's follow-up receipt).
  const { status, data, attemptsUsed } = await loopbackVerifyRead(
    `/api/builder/guesty-amenities?listingId=${encodeURIComponent(target.guestyListingId)}`,
    { attempts: AMENITY_VERIFY_READ_ATTEMPTS, timeoutMs: AMENITY_VERIFY_READ_TIMEOUT_MS, label: "amenities verify" },
  );
  if (status >= 400) {
    const reason = String((data as any)?.error ?? `HTTP ${status}`);
    return {
      row, keys, scannedNote, missing: null, guestyCount: null,
      guestyReadError: `${reason} — after ${attemptsUsed} read attempt${attemptsUsed === 1 ? "" : "s"}; Guesty rate limiting can stall reads, re-run the audit to verify`,
    };
  }
  const storedNames = [
    ...(Array.isArray((data as any)?.amenities) ? (data as any).amenities : []),
    ...(Array.isArray((data as any)?.otherAmenities) ? (data as any).otherAmenities : []),
  ].filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
  const present = new Set(storedNames.map((n) => normalizeGuestyAmenityName(n)));
  const missing = keys.filter((k) => {
    if (GUESTY_UNSUPPORTED_AMENITY_KEYS.has(k)) return false; // no truthful Guesty equivalent (Other-bucket/description class)
    return !amenityPresenceCandidates(k).some((candidate) => present.has(candidate));
  });
  return { row, keys, scannedNote, missing, guestyCount: storedNames.length, guestyReadError: null };
}

async function readAmenityScanReceipt(propertyId: number): Promise<any | null> {
  const raw = await storage.getSetting(AMENITY_SCAN_RECEIPTS_SETTING_KEY).catch(() => undefined);
  try {
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, String(propertyId))
      ? map[String(propertyId)]
      : null;
  } catch {
    return null;
  }
}

async function readPricingAuditReceipt(propertyId: number): Promise<any | null> {
  const raw = await storage.getSetting(PRICING_AUDIT_RECEIPTS_SETTING_KEY).catch(() => undefined);
  try {
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, String(propertyId))
      ? map[String(propertyId)]
      : null;
  } catch {
    return null;
  }
}

async function stageAmenities(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  let v = await verifyAmenities(target);
  const items: string[] = [];

  // AUTO-FIX: the existing scan route does the whole remedy in one call —
  // Claude-vision + area-research scan, ADD-ONLY merge over the saved set,
  // persist, and (when mapped) the add-only union push to Guesty. Fire when
  // there's no AI-scanned set yet or saved amenities are missing from Guesty.
  let fixedNote = "";
  const needsFix = record.fullAutomation || !v.row || !v.row.scannedAt || (v.missing != null && v.missing.length > 0);
  if (needsFix && autoFixEnabled(record)) {
    touch(record, { message: "Scanning photos + area for amenities (Claude vision + web research), saving, and pushing add-only…" });
    // Ceiling accounting: two verify calls (worst case each AMENITY_VERIFY_
    // WORST_MS) + this scan + a 30s cushion must fit STAGE_TIMEOUT_MS.amenities.
    const scanTimeoutMs = STAGE_TIMEOUT_MS.amenities - 2 * AMENITY_VERIFY_WORST_MS - 30_000;
    const scan = await loopbackJson("POST", "/api/builder/scan-amenities", {
      propertyId: target.propertyId,
      requireVision: record.fullAutomation,
    }, scanTimeoutMs)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (scan.status >= 400) {
      items.push(`Auto-fix failed: amenity scan did not run (${String((scan.data as any)?.error ?? `HTTP ${scan.status}`)})`);
      if (record.fullAutomation) {
        return {
          verdict: "error",
          detail: `The required complete Claude amenity scan failed: ${String((scan.data as any)?.error ?? `HTTP ${scan.status}`)}`,
          items,
        };
      }
    } else if (record.fullAutomation && ((scan.data as any)?.strictVisionComplete !== true || (scan.data as any)?.provenance?.method !== "claude-vision")) {
      return {
        verdict: "error",
        detail: "The amenity scan did not prove a complete Claude-vision pass, so its baseline/partial result was not accepted.",
        items,
      };
    } else if (record.fullAutomation && target.guestyListingId && (scan.data as any)?.guesty?.synced !== true) {
      return {
        verdict: "error",
        detail: `Claude detected and saved the amenities locally, but Guesty sync failed: ${String((scan.data as any)?.guesty?.error ?? "unknown Guesty error")}`,
        items,
      };
    } else {
      const synced = (scan.data as any)?.guesty?.synced === true;
      fixedNote = `AI amenity scan ran and saved${synced ? " + pushed add-only to Guesty" : target.guestyListingId ? " (Guesty push did not confirm — see Amenities tab)" : " (no Guesty listing yet — auto-push on connect)"}`;
      items.push(`Auto-fixed: ${fixedNote}`);
      v = await verifyAmenities(target);
    }
  }

  if (!v.row || v.keys.length === 0) {
    return {
      verdict: "attention",
      detail: "No amenity set saved in-system — run 🔎 Scan photos for amenities on the Amenities tab (fills the Hawaii baseline + AI-detected extras).",
      items: items.length > 0 ? items : undefined,
    };
  }
  items.unshift(`${v.keys.length} amenities saved in-system (source: ${v.row.source ?? "unknown"}, ${v.scannedNote})`);
  if (record.fullAutomation) {
    const receipt = await readAmenityScanReceipt(target.propertyId);
    if (!receipt || receipt.strictVisionComplete !== true || receipt.method !== "claude-vision" || !receipt.photoFingerprint) {
      return {
        verdict: "error",
        detail: "Amenities are saved, but the durable Claude photo-scan receipt is missing or incomplete.",
        items,
      };
    }
    items.push(`Claude vision receipt: ${receipt.model ?? "Claude"} · ${receipt.photosConsidered ?? 0} photos · ${String(receipt.photoFingerprint).slice(0, 18)}…`);
  }

  if (!target.guestyListingId) {
    return {
      verdict: fixedNote ? "fixed" : v.row.scannedAt ? "pass" : "attention",
      detail: `${v.keys.length} amenities saved in-system (${v.scannedNote}) — no Guesty listing yet, push happens automatically when one is connected.`,
      items,
    };
  }
  if (v.guestyReadError) {
    items.push(`Could not read the Guesty listing's amenities (${v.guestyReadError})`);
    return { verdict: "error", detail: "Amenities are saved in-system but the Guesty listing could not be read to confirm they were pushed.", items };
  }
  if (v.missing && v.missing.length > 0) {
    items.push(`Missing from the Guesty listing: ${v.missing.slice(0, 10).map((k) => getAmenityLabel(k)).join(", ")}${v.missing.length > 10 ? ` +${v.missing.length - 10} more` : ""}`);
    return {
      verdict: "attention",
      detail: `${v.missing.length} saved amenit${v.missing.length === 1 ? "y is" : "ies are"} not on the Guesty listing${fixedNote ? " even after the scan+push" : ""} — push amenities from the Amenities tab (add-only).`,
      items,
    };
  }
  const unsupportedCount = v.keys.filter((k) => GUESTY_UNSUPPORTED_AMENITY_KEYS.has(k)).length;
  const summary = `All ${v.keys.length - unsupportedCount} Guesty-supported amenities are on the listing (${v.guestyCount} total on Guesty)${unsupportedCount > 0 ? ` · ${unsupportedCount} with no Guesty equivalent (Other-bucket/description class)` : ""} · ${v.scannedNote}.`;
  if (fixedNote) {
    return { verdict: "fixed", detail: `${fixedNote} — re-verify: ${summary}`, items };
  }
  return {
    verdict: v.row.scannedAt ? "pass" : "attention",
    detail: summary,
    items,
  };
}

async function readCoverCollageRecord(target: UnitAuditTarget, allowPropertyOnly: boolean): Promise<any> {
  const raw = await storage.getSetting(COVER_COLLAGE_SETTING_KEY).catch(() => undefined);
  try {
    const map = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    const propertyKey = `property:${target.propertyId}`;
    if (target.guestyListingId && Object.prototype.hasOwnProperty.call(map, target.guestyListingId)) return map[target.guestyListingId];
    return allowPropertyOnly && Object.prototype.hasOwnProperty.call(map, propertyKey)
      ? map[propertyKey]
      : null;
  } catch {
    return null;
  }
}

async function stageCoverCollage(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  if (!target.guestyListingId && !record.fullAutomation) {
    return { verdict: "skipped", detail: "No Guesty listing mapped — the cover collage is generated + pinned when a listing exists." };
  }
  if (record.fullAutomation) {
    const strictGaps = strictPhotoFolderGaps(target);
    if (strictGaps.inventoryUnavailable) {
      return { verdict: "error", detail: "The configured photo-folder inventory could not be read, so the strict Claude collage was not generated or accepted." };
    }
    if (strictGaps.communityMissing) {
      return {
        verdict: "error",
        detail: "The strict Claude collage requires a non-empty published community-photo pool for its left panel; no existing receipt or unit-only pair was accepted.",
      };
    }
  }
  let recordRow: any = await readCoverCollageRecord(target, record.fullAutomation);
  let fixedNote = "";
  let generatedCollageUrl: string | null = null;
  // A unit replaced earlier in THIS sweep may be featured on the existing
  // collage — re-compose from the surviving photo set (post-swap
  // follow-through, 2026-07-12).
  const collageStaleFromSwap = !!recordRow && replacedThisSweep.has(record.jobId);
  if ((record.fullAutomation || !recordRow || collageStaleFromSwap) && autoFixEnabled(record)) {
    // AUTO-FIX: the one-click AI collage — same endpoint the Photos-tab
    // button drives, candidates built from the resolved PUBLISHED photos
    // (hidden files never reach the pick; community-group labels keep the
    // destination-left pairing heuristic honest). Vision fail-softs to the
    // caption heuristic inside the endpoint for manual audits. Full dashboard
    // automation requires a real Claude-vision pick and saves locally before
    // the optional ImgBB + Guesty push.
    const candidates = target.groups.flatMap((g) =>
      g.filenames.map((filename) => ({
        url: `/photos/${g.folder}/${filename}`,
        caption: g.captions[filename] ?? filename,
        source: g.label,
      })),
    ).slice(0, 80); // endpoint caps vision at COVER_COLLAGE_VISION_CAP anyway
    if (candidates.length < 2) {
      return { verdict: record.fullAutomation ? "error" : "attention", detail: "No AI cover collage and fewer than 2 published photos to build one from." };
    }
    touch(record, { message: target.guestyListingId
      ? "Making the AI cover collage (Claude picks the pair, saves locally, then pushes + pins on Guesty)…"
      : "Making the AI cover collage (Claude picks the pair and saves it locally for this listing)…" });
    if (record.fullAutomation && target.guestyListingId) {
      // Arm the final exact-sync obligation BEFORE the collage endpoint's
      // pictures[] PUT. A replacement may have cleared an earlier pending
      // flag, and a process death after this PUT must still resume into the
      // final verifier. Clear the previous identity because this call creates
      // a new collage URL.
      await markGuestyGallerySyncPending(record, {
        requiredCoverCollageUrl: null,
        finalGuestyGalleryVerified: false,
      });
    }
    const make = await loopbackJson("POST", "/api/builder/auto-cover-collage", {
      propertyId: target.propertyId,
      listingId: target.guestyListingId ?? null,
      photos: candidates,
      requireVision: record.fullAutomation,
    }, STAGE_TIMEOUT_MS["cover-collage"] - 60_000).catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (make.status >= 400) {
      return {
        verdict: record.fullAutomation ? "error" : "attention",
        detail: `No AI cover collage, and the auto-make failed: ${String((make.data as any)?.error ?? `HTTP ${make.status}`)} — use 🖼 Make Cover Collage on the Photos tab.`,
      };
    }
    if (record.fullAutomation && target.guestyListingId) {
      const rawGeneratedCollageUrl = typeof (make.data as any)?.collageUrl === "string"
        ? String((make.data as any).collageUrl).trim()
        : "";
      let validGeneratedCollageUrl = false;
      try {
        const parsed = new URL(rawGeneratedCollageUrl);
        validGeneratedCollageUrl = rawGeneratedCollageUrl.length <= 2_000
          && (parsed.protocol === "http:" || parsed.protocol === "https:")
          && !!parsed.hostname;
      } catch { /* invalid URL is rejected below */ }
      if (!validGeneratedCollageUrl) {
        return {
          verdict: "error",
          detail: "The collage endpoint changed Guesty but did not return a valid persisted URL identity for the required final exact-gallery verification.",
        };
      }
      generatedCollageUrl = rawGeneratedCollageUrl;
    }
    recordRow = await readCoverCollageRecord(target, record.fullAutomation);
    if (record.fullAutomation && (make.data as any)?.method !== "vision") {
      return { verdict: "error", detail: "The collage endpoint did not prove a Claude-vision pick, so the generated collage was not accepted." };
    }
    const guestySynced = (make.data as any)?.guesty?.synced === true;
    if (target.guestyListingId && !guestySynced) {
      return {
        verdict: "error",
        detail: `The Claude collage was generated and saved locally, but Guesty sync failed: ${String((make.data as any)?.guesty?.error ?? "unknown Guesty error")}`,
      };
    }
    fixedNote = collageStaleFromSwap
      ? `Claude cover collage re-composed after this sweep's unit replacement and saved${guestySynced ? "; pushed to Guesty (pinned first)" : " locally"}`
      : `Claude cover collage generated and saved${guestySynced ? "; pushed to Guesty (pinned first)" : " locally (no Guesty listing mapped)"}`;
  }
  if (!recordRow) {
    return {
      verdict: record.fullAutomation ? "error" : "attention",
      detail: "No AI cover collage on file for this listing — one-click 🖼 Make Cover Collage on the Photos tab (Claude picks the pair, composes, pushes + pins).",
    };
  }
  if (record.fullAutomation && recordRow.method !== "vision") {
    return { verdict: "error", detail: "The saved collage was not selected by Claude vision — the full audit will not accept a heuristic cover." };
  }
  const items: string[] = [
    `Picked ${recordRow.method === "vision" ? "by Claude vision" : "by the caption heuristic (vision fallback)"} on ${String(recordRow.createdAt ?? "").slice(0, 10)}`,
  ];
  if (recordRow.left?.caption || recordRow.right?.caption) {
    items.push(`Pair: ${recordRow.left?.caption ?? "?"} + ${recordRow.right?.caption ?? "?"}`);
  }
  const savedFile = path.basename(String(recordRow.localPath ?? ""));
  const fallbackFile = target.guestyListingId
    ? `${String(target.guestyListingId).replace(/[^a-zA-Z0-9_-]+/g, "-")}.jpg`
    : `property-${target.propertyId < 0 ? `neg-${Math.abs(target.propertyId)}` : target.propertyId}.jpg`;
  const file = path.join(process.cwd(), "client/public/photos", COVER_COLLAGE_DISK_FOLDER, savedFile || fallbackFile);
  const onDisk = await fs.promises.access(file).then(() => true).catch(() => false);
  if (!onDisk) items.push("Saved collage file is missing from the photos volume (record exists; Guesty copy unaffected)");
  if (!onDisk && record.fullAutomation) {
    return { verdict: "error", detail: "The Claude collage receipt exists, but its locally saved JPEG is missing from the photos volume.", items };
  }
  if (record.fullAutomation) {
    if (target.guestyListingId) {
      if (!generatedCollageUrl) {
        return { verdict: "error", detail: "The validated Claude collage is missing its current-audit Guesty URL identity.", items };
      }
      // Accept the new identity only after the response, durable vision
      // receipt, and local JPEG have all been validated. This atomically marks
      // the collage current for the final photo set and keeps exact sync armed.
      await markGuestyGallerySyncPending(record, {
        coverCollageNeedsRefresh: false,
        requiredCoverCollageUrl: generatedCollageUrl,
        finalGuestyGalleryVerified: false,
      });
    } else {
      await touchDurably(record, {
        coverCollageNeedsRefresh: false,
        requiredCoverCollageUrl: null,
        finalGuestyGalleryVerified: false,
      });
    }
  }
  return {
    verdict: fixedNote ? "fixed" : "pass",
    detail: fixedNote
      ? `${fixedNote} (${recordRow.method === "vision" ? "Claude-vision pick" : "heuristic pick"}).`
      : `AI cover collage on file${target.guestyListingId ? " and pushed to Guesty (pinned first)" : " and saved locally for this listing"}${recordRow.method === "vision" ? "" : " — heuristic pick, consider re-running for a Claude-vision pick"}.`,
    items,
  };
}

async function stageLayout(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  let strictApply: Awaited<ReturnType<typeof applyBeddingPhotoScanForAudit>> | null = null;
  if (record.fullAutomation) {
    touch(record, { message: "Scanning every unit's bedding + bathroom photos with Claude, saving >60% evidence, and safely syncing existing Guesty room slots…" });
    try {
      strictApply = await applyBeddingPhotoScanForAudit(target.propertyId, {
        guestyListingId: target.guestyListingId,
        forceFresh: true,
      });
    } catch (e: any) {
      return {
        verdict: "error",
        detail: `Claude bedding/bathroom scan could not complete, so no fallback evidence was accepted: ${String(e?.message ?? e)}`,
      };
    }
    if (strictApply.guestyStatus === "failed" || strictApply.guestyStatus === "blocked") {
      return {
        verdict: "error",
        detail: strictApply.guestyStatus === "failed"
          ? "Claude bedding/bathroom evidence was saved locally, but the Guesty bedding update failed."
          : "Claude found confident bedding, but it could not be mapped into the existing Guesty bedroom slots without changing the room structure.",
        items: strictApply.items,
      };
    }
    if (!target.guestyListingId) {
      return {
        verdict: "fixed",
        detail: "Claude bedding and bathroom scan completed; every >60% detection was saved locally for the listing (no Guesty listing mapped).",
        items: strictApply.items,
      };
    }
  }

  if (!target.guestyListingId) {
    return { verdict: "skipped", detail: "No Guesty listing mapped — nothing to compare the bedding/layout against." };
  }
  const fields = "bedrooms bathrooms accommodates beds title";
  const { status, data, attemptsUsed } = await loopbackVerifyRead(
    `/api/guesty-proxy/listings/${encodeURIComponent(target.guestyListingId)}?fields=${encodeURIComponent(fields)}`,
    { attempts: 2, timeoutMs: 45_000, label: "layout verify" },
  );
  if (status >= 400) {
    return { verdict: "error", detail: `Could not read the Guesty listing to verify the layout (${String((data as any)?.error ?? `HTTP ${status}`)} — after ${attemptsUsed} read attempt${attemptsUsed === 1 ? "" : "s"}).` };
  }
  const items: string[] = [...(strictApply?.items ?? [])];
  let mismatch = false;
  let soft = false;
  const gBedrooms = Number(data?.bedrooms);
  if (target.expectedListingBedrooms != null && Number.isFinite(gBedrooms)) {
    if (gBedrooms !== target.expectedListingBedrooms) {
      mismatch = true;
      items.push(`Bedrooms: Guesty shows ${gBedrooms}, system config says ${target.expectedListingBedrooms} — push Bedding + sqft (or fix the config) so the OTA layout is right`);
    } else {
      items.push(`Bedrooms: ${gBedrooms} ✓`);
    }
  } else {
    items.push("Bedrooms: could not compare (missing on one side)");
    soft = true;
  }
  const gBaths = Number(data?.bathrooms);
  if (target.bathroomsTotal != null && Number.isFinite(gBaths)) {
    if (Math.abs(gBaths - target.bathroomsTotal) > 0.01) {
      soft = true;
      items.push(`Bathrooms: Guesty shows ${gBaths}, system says ${target.bathroomsTotal}`);
    } else items.push(`Bathrooms: ${gBaths} ✓`);
  }
  const gSleeps = Number(data?.accommodates);
  if (target.maxGuestsTotal != null && Number.isFinite(gSleeps)) {
    if (gSleeps !== target.maxGuestsTotal) {
      soft = true;
      items.push(`Sleeps: Guesty shows ${gSleeps}, system max guests total is ${target.maxGuestsTotal}`);
    } else items.push(`Sleeps: ${gSleeps} ✓`);
  }

  // BEDDING PHOTO CHECK (2026-07-14 operator ask): compare what the unit's
  // photos actually show — bed types per distinct photographed bedroom — to
  // the bed layout pushed to Guesty. Runs through the SAME engine as the
  // Bedding tab's "Scan photos for bedding" button (a fingerprint-fresh
  // stored scan is reused, so a tab scan and an audit share one vision spend).
  // The Guesty rooms read lives in server/bedding-photo-scan.ts — this module
  // stays push-free per the layout stage's source lock. Standard audit
  // findings are flag-only; a Bedding-tab click auto-applies fresh vision
  // evidence strictly above 60%. Full dashboard automation has already called
  // the strict helper above: it updates only existing bedroom slots with
  // photographed >60% evidence, while unphotographed rooms/counts stay
  // untouched. Unphotographed bedrooms are reported as unverifiable, never
  // guessed.
  // Kill: AUDIT_BEDDING_PHOTO_CHECK=0.
  let beddingMismatch = false;
  let beddingClean = false;
  const beddingReadbackEnabled = String(process.env.AUDIT_BEDDING_PHOTO_CHECK ?? "").trim() !== "0";
  if (record.fullAutomation && !beddingReadbackEnabled) {
    return {
      verdict: "error",
      detail: "Full dashboard automation requires the post-apply Claude bedding read-back, but AUDIT_BEDDING_PHOTO_CHECK=0 disables it.",
      items,
    };
  }
  if (beddingReadbackEnabled) {
    try {
      const bedding = await beddingPhotoCheckForAudit(target.propertyId, target.guestyListingId);
      items.push(...bedding.items);
      if (bedding.mismatch) {
        beddingMismatch = true;
        soft = true;
      } else if (!bedding.unverified && bedding.method === "vision") {
        beddingClean = true;
      }
    } catch (e: any) {
      // Strict dashboard runs must prove the just-applied bedding survived a
      // fresh Guesty read. Manual sweeps retain the historical attention-only
      // posture because their source of truth may be browser-local curation.
      if (record.fullAutomation) {
        return {
          verdict: "error",
          detail: `Claude bedding evidence was saved/applied, but the Guesty read-back could not verify it: ${String(e?.message ?? e).slice(0, 180)}`,
          items,
        };
      }
      soft = true;
      items.push(`Bedding photo check could not run (${String(e?.message ?? e).slice(0, 160)}) — re-run the audit to retry`);
    }
  }

  if (mismatch || soft) {
    if (strictApply) {
      items.push("The Claude evidence was saved/applied, but structural counts or unphotographed room details still disagree; the audit never overwrites a layout count or guesses an unseen room");
    } else {
      // Manual audit behavior stays proposal-only because its canonical config
      // lives in the browser and may contain operator curation.
      items.push("Fix: open the builder and push Bedding + sqft (the sweep never overwrites a layout — your Bedding-tab configuration lives in the browser)");
    }
  }
  if (mismatch) {
    return { verdict: "failed", detail: "Guesty bedroom count does not match the system unit config — guests are filtering on the wrong layout.", items };
  }
  if (soft) {
    return {
      verdict: record.fullAutomation && beddingMismatch ? "error" : "attention",
      detail: beddingMismatch
        ? record.fullAutomation
          ? "The post-apply Guesty read-back still disagrees with Claude's confident photographed bedding; the strict audit did not accept the push."
          : "The unit photos disagree with the pushed Guesty bed layout — open the Bedding tab and click Scan photos for bedding to auto-apply and push."
        : "Layout numbers partially disagree with Guesty — review the Bedding tab.",
      items,
    };
  }
  return {
    verdict: strictApply ? "fixed" : "pass",
    detail: strictApply
      ? "Claude bedding/bathroom evidence was saved and safely applied to existing Guesty room slots; layout counts and photographed beds re-verify clean."
      : beddingClean
        ? "Guesty layout matches the system config (bedrooms/bathrooms/sleeps) and the photographed beds match the pushed bed layout."
        : "Guesty layout matches the system config (bedrooms/bathrooms/sleeps).",
    items,
  };
}

type PricingVerify = {
  verdict: UnitAuditStageVerdict;
  items: string[];
  /** A market-rate refresh+push would remedy the finding. */
  needsRefresh: boolean;
};

async function verifyPricing(target: UnitAuditTarget, opts: { localOnlyAccepted?: boolean } = {}): Promise<PricingVerify> {
  const schedule = await storage.getScannerSchedule(target.propertyId).catch(() => undefined);
  const rates = await storage.getPropertyMarketRates(target.propertyId).catch(() => []);
  const items: string[] = [];
  let verdict: UnitAuditStageVerdict = "pass";
  let needsRefresh = false;
  const bump = (v: UnitAuditStageVerdict) => {
    const rank: Record<string, number> = { pass: 0, fixed: 0, skipped: 0, attention: 1, error: 2, failed: 3 };
    if (rank[v] > rank[verdict]) verdict = v;
  };

  const sizes = target.unitBedroomSizes;
  const rateSizes = new Set(rates.map((r: any) => Number(r.bedrooms)));
  const missingSizes = sizes.filter((s) => !rateSizes.has(s));
  if (rates.length === 0) {
    bump("attention");
    needsRefresh = true;
    items.push("No market-rate pricing table — run Update market pricing (dashboard queue or the Pricing tab)");
  } else if (missingSizes.length > 0) {
    bump("attention");
    needsRefresh = true;
    items.push(`No market-rate row for ${missingSizes.map((s) => `${s}BR`).join(", ")} — the push would miss those units`);
  } else if (sizes.length > 0) {
    items.push(`Market-rate rows cover the listing's unit sizes (${sizes.map((s) => `${s}BR`).join(" + ")})`);
  }

  const pushedAt = schedule?.lastGuestyRatePushAt ? new Date(schedule.lastGuestyRatePushAt as any).getTime() : null;
  const pushStatus = (schedule as any)?.lastGuestyRatePushStatus ?? null;
  if (!target.guestyListingId && opts.localOnlyAccepted) {
    items.push("No Guesty listing mapped — the complete SearchAPI pricing table is saved locally and no Guesty push is required yet");
  } else if (!pushedAt) {
    bump("attention");
    needsRefresh = true;
    items.push("Rates have never been pushed to Guesty for this property");
  } else {
    const days = Math.floor((Date.now() - pushedAt) / 86_400_000);
    if (pushStatus === "error") {
      bump("failed");
      needsRefresh = true;
      items.push(`Last Guesty rate push FAILED ${days}d ago: ${(schedule as any)?.lastGuestyRatePushSummary ?? "see the Last Price Scan column"}`);
    } else if (pushStatus === "seed") {
      bump("attention");
      needsRefresh = true;
      items.push(`Only a seeded backfill stamp exists (${days}d ago) — no real push yet`);
    } else if (days > PRICING_STALE_DAYS) {
      bump("attention");
      needsRefresh = true;
      items.push(`Rates last pushed ${days} days ago — stale (weekly cadence); re-run Update market pricing`);
    } else {
      items.push(`Rates pushed to Guesty ${days === 0 ? "today" : `${days}d ago`} (status ${pushStatus ?? "ok"})`);
    }
  }

  // A confirmation compute hiccup must not erase the freshness findings above
  // — degrade to "no evidence" instead of failing the whole stage.
  let confirmation: ReturnType<typeof computeMarketRateMatchConfirmation> = null;
  try {
    confirmation = computeMarketRateMatchConfirmation({
      community: target.communityName,
      expectedCity: target.city ?? null,
      expectedState: target.state ?? null,
      curated: isCuratedBuyInMarket(target.communityName),
      expectedBedrooms: sizes.length > 0 ? sizes : null,
      rows: rates.map((r: any) => ({ bedrooms: r.bedrooms, monthlyRates: r.monthlyRates })),
    });
  } catch {
    confirmation = null;
  }
  if (confirmation) {
    if (confirmation.level === "green") items.push("Match confirmation GREEN — researched the right community + bedroom sizes (95%+ bar)");
    else if (confirmation.level === "yellow") { bump("attention"); items.push(`Match confirmation AMBER: ${confirmation.headline || "research evidence incomplete"}`); }
    else {
      bump("attention");
      // A RED confirmation means the stored research may not match this
      // community/bedrooms — a fresh scan re-researches and re-stamps.
      needsRefresh = true;
      items.push(`Match confirmation RED: ${confirmation.headline || "research may not match this community/bedrooms"} — re-run the market-rate scan`);
    }
  } else if (rates.length > 0) {
    items.push("No research evidence stored on the pricing rows (older scan) — re-running Update market pricing stamps it");
  }
  return { verdict, items, needsRefresh };
}

async function stagePricing(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  const localOnlyAccepted = record.fullAutomation && !target.guestyListingId;
  let v = await verifyPricing(target, { localOnlyAccepted });
  const items = [...v.items];
  if (record.fullAutomation && String(process.env.AUDIT_PRICING_REFRESH ?? "").trim() === "0") {
    return {
      verdict: "error",
      detail: "Full dashboard automation requires a fresh SearchAPI Airbnb pricing run, but AUDIT_PRICING_REFRESH=0 disables it.",
      items,
    };
  }

  // AUTO-FIX: the SAME per-property refresh+push path the "Update market
  // pricing" queue and the weekly cron drive — SearchAPI Airbnb median scan
  // per unit size, marked-up push to Guesty with read-back verification, and
  // the Last Price Scan stamp. Fired only when the verify found a refreshable
  // problem (never/stale/failed/seed/missing-size/RED confirmation) so a
  // fresh table never burns SearchAPI budget. AUDIT_PRICING_REFRESH=0 kills.
  let fixedNote = "";
  const shouldRefresh = record.fullAutomation || v.needsRefresh;
  if (record.fullAutomation) items.push("Full dashboard audit: forcing a fresh live SearchAPI Airbnb pricing research run and saving the complete monthly setup");
  if (shouldRefresh && autoFixEnabled(record) && String(process.env.AUDIT_PRICING_REFRESH ?? "").trim() !== "0") {
    touch(record, { message: "Refreshing market rates (SearchAPI Airbnb median) and pushing marked-up rates to Guesty — the long pricing leg…" });
    const refreshPath = target.isDraft
      ? `/api/community/${-target.propertyId}/refresh-pricing`
      : `/api/property/${target.propertyId}/refresh-market-rates`;
    const refresh = await loopbackJson("POST", refreshPath, { forceSearchApi: record.fullAutomation }, STAGE_TIMEOUT_MS.pricing - 2 * 60_000)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (refresh.status >= 400) {
      items.push(`Auto-fix failed: market-rate refresh did not run (${String((refresh.data as any)?.error ?? `HTTP ${refresh.status}`)})`);
      if (record.fullAutomation) {
        return {
          verdict: "error",
          detail: `The required SearchAPI Airbnb pricing refresh failed: ${String((refresh.data as any)?.error ?? `HTTP ${refresh.status}`)}`,
          items,
        };
      }
    } else if ((refresh.data as any)?.alreadyRunning) {
      items.push("A market-rate refresh for this property is already running — re-run the audit after it lands");
      if (record.fullAutomation) {
        return {
          verdict: "attention",
          detail: "A SearchAPI pricing refresh is already running; the audit will retry before writing its receipt.",
          items,
        };
      }
    } else if (record.fullAutomation) {
      const receipt = (refresh.data as any)?.auditReceipt;
      const durableReceipt = await readPricingAuditReceipt(target.propertyId);
      const expectedRows = target.unitBedroomSizes.length;
      const receiptValid = receipt?.engine === "searchapi-airbnb"
        && receipt?.propertyId === target.propertyId
        && typeof receipt?.runId === "string"
        && /^sha256:[0-9a-f]{64}$/.test(String(receipt?.rowFingerprint ?? ""))
        && Number(receipt?.bedroomRows) === expectedRows
        && Number(receipt?.monthsSaved) > 0
        && Number(receipt?.searchAttemptMonths) >= Math.max(1, expectedRows)
        && durableReceipt?.runId === receipt.runId
        && durableReceipt?.rowFingerprint === receipt.rowFingerprint;
      if (!receiptValid) {
        return {
          verdict: "error",
          detail: "The pricing endpoint returned without a matching durable receipt for this fresh SearchAPI Airbnb run.",
          items,
        };
      }
      items.push(
        `SearchAPI receipt ${receipt.runId}: ${receipt.searchAttemptMonths} searched month(s), ${receipt.liveCompMonths} with live comps, ` +
        `${receipt.extrapolatedMonths} extrapolated, ${receipt.staticFallbackMonths} thin-market fallback, ${receipt.monthsSaved} saved total · ${receipt.rowFingerprint.slice(0, 18)}…`,
      );
      if ((refresh.data as any)?.guestyPush?.skipped && !localOnlyAccepted) {
        const reason = String((refresh.data as any).guestyPush.reason ?? "no mapped Guesty listing / no priced months");
        items.push(`Auto-fix PARTIAL: market rates rescanned + saved, but the Guesty push was SKIPPED — ${reason}`);
        const re = await verifyPricing(target, { localOnlyAccepted });
        items.push(...re.items.map((line) => `Re-verify: ${line}`));
        return {
          verdict: re.verdict === "pass" ? "attention" : re.verdict,
          detail: `Rates rescanned, but the Guesty push was skipped: ${reason} — the Last Price Scan column stamps real pushes only.`,
          items,
        };
      }
      fixedNote = localOnlyAccepted
        ? "SearchAPI Airbnb market rates refreshed and the complete pricing setup saved locally"
        : "SearchAPI Airbnb market rates refreshed + pushed to Guesty";
      items.push(`Auto-fixed: ${fixedNote}`);
      v = await verifyPricing(target, { localOnlyAccepted });
      items.push(...v.items.map((line) => `Re-verify: ${line}`));
    } else if ((refresh.data as any)?.guestyPush?.skipped && !localOnlyAccepted) {
      // HONESTY (2026-07-12 "Last Price Scan didn't update" incident): the
      // scan saved a fresh pricing table, but NOTHING reached Guesty — the
      // refresh routes soft-skip the push (no mapped listing, no priced
      // months, plan gaps), and markScannerGuestyRatePush only stamps real
      // pushes, so the Last Price Scan column will not move. Say exactly
      // that instead of claiming "refreshed + pushed".
      const reason = String((refresh.data as any).guestyPush.reason ?? "no mapped Guesty listing / no priced months");
      items.push(`Auto-fix PARTIAL: market rates rescanned + saved, but the Guesty push was SKIPPED — ${reason}`);
      const re = await verifyPricing(target, { localOnlyAccepted });
      items.push(...re.items.map((l) => `Re-verify: ${l}`));
      return {
        verdict: re.verdict === "pass" ? "attention" : re.verdict,
        detail: `Rates rescanned, but the Guesty push was skipped: ${reason} — the Last Price Scan column stamps real pushes only.`,
        items,
      };
    } else {
      fixedNote = localOnlyAccepted
        ? "SearchAPI Airbnb market rates refreshed and the complete pricing setup saved locally"
        : "SearchAPI Airbnb market rates refreshed + pushed to Guesty";
      items.push(`Auto-fixed: ${fixedNote}`);
      v = await verifyPricing(target, { localOnlyAccepted });
      items.push(...v.items.map((l) => `Re-verify: ${l}`));
    }
  }

  if (v.verdict === "pass" && fixedNote) {
    return { verdict: "fixed", detail: `${fixedNote} — re-verify clean.`, items };
  }
  const detail = v.verdict === "pass"
    ? `Pricing table fresh${localOnlyAccepted ? " + saved locally" : " + pushed"} · ${v.items.find((i) => i.startsWith("Match confirmation")) ?? "rates verified"}`
    : v.items.find((i) => /FAILED|never been pushed|stale|No market-rate|RED|AMBER|seeded/.test(i)) ?? "Pricing needs review.";
  return { verdict: v.verdict, detail, items };
}

async function stageChannels(target: UnitAuditTarget): Promise<StageOutcome> {
  const items: string[] = [];
  let verdict: UnitAuditStageVerdict = "pass";
  const bump = (v: UnitAuditStageVerdict) => {
    const rank: Record<string, number> = { pass: 0, fixed: 0, skipped: 0, attention: 1, error: 2, failed: 3 };
    if (rank[v] > rank[verdict]) verdict = v;
  };

  if (!target.guestyListingId) {
    items.push("No Guesty listing mapped — channel status not applicable");
  } else {
    const { status, data, attemptsUsed } = await loopbackVerifyRead(
      "/api/dashboard/channel-status",
      { attempts: 2, timeoutMs: 45_000, label: "channels verify" },
    );
    if (status >= 400) {
      bump("error");
      items.push(`Channel status could not be read (${String((data as any)?.error ?? `HTTP ${status}`)} — after ${attemptsUsed} read attempt${attemptsUsed === 1 ? "" : "s"})`);
    } else {
      const ch = (data as any)?.[String(target.propertyId)] ?? (data as any)?.[target.propertyId];
      if (!ch) {
        bump("error");
        items.push("Channel status returned no row for this property");
      } else {
        for (const [key, label] of [["airbnb", "Airbnb"], ["vrbo", "VRBO"], ["bookingCom", "Booking.com"]] as const) {
          const c = ch[key];
          if (!c?.connected) { items.push(`${label}: not connected`); continue; }
          if (c.syncFailed) { bump("attention"); items.push(`${label}: connected but the last channel sync FAILED — may be serving stale data`); }
          else if (!c.live) { bump("attention"); items.push(`${label}: connected but NOT live/bookable`); }
          else items.push(`${label}: live ✓`);
        }
      }
    }
  }

  if (target.licenses) {
    let anyLicense = false;
    for (const [label, value] of Object.entries(target.licenses)) {
      const usable = usableLicenseValue(value);
      if (!usable) continue;
      anyLicense = true;
      if (isPlaceholderLicenseValue(usable)) {
        bump("attention");
        items.push(`${label} is a SAMPLE/placeholder value (${usable}) — replace with the real license before pushing compliance`);
      } else {
        items.push(`${label}: ${usable} (not a known sample pattern)`);
      }
    }
    if (!anyLicense) {
      bump("attention");
      items.push("No license values on file for this property");
    }
  } else {
    items.push("License check: draft licenses live in the builder Compliance flow — not checked here");
  }

  const bad = items.filter((i) => /FAILED|NOT live|SAMPLE|No license|could not be read|no row/.test(i));
  return {
    verdict,
    detail: verdict === "pass"
      ? "Channels live where connected · licenses look real."
      : bad[0] ?? "Channels/licenses need review.",
    items,
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

async function runStageForRecord(record: UnitAuditJobRecord, stageId: UnitAuditStageId, opts: { retryPass?: number } = {}): Promise<void> {
  const startedAt = Date.now();
  touch(record, {
    currentStage: stageId,
    message: `Stage ${UNIT_AUDIT_STAGE_IDS.indexOf(stageId) + 1}/${UNIT_AUDIT_STAGE_IDS.length}: ${UNIT_AUDIT_STAGE_LABELS[stageId]}${opts.retryPass ? ` (double-check pass ${opts.retryPass})` : ""}…`,
  });
  let outcome: StageOutcome;
  try {
    const target = stageId === "resolve" ? null : targets.get(record.jobId) ?? null;
    if (stageId !== "resolve" && !target) throw new Error("internal: target not resolved");
    if (record.fullAutomation && FULL_AUTOMATION_MUTATING_STAGES.has(stageId) && !autoFixEnabled(record)) {
      throw new Error("Full dashboard automation requires auto-fix, but it is disabled for this run or by UNIT_AUDIT_AUTOFIX_DISABLED");
    }
    const work: Promise<StageOutcome> = stageId === "resolve"
      ? stageResolve(record)
      : stageId === "photo-dedupe" ? stagePhotoDedupe(target!, record)
      : stageId === "photo-community" ? stagePhotoCommunity(target!, record)
      : stageId === "ota-scan" ? stageOtaScan(target!, record)
      : stageId === "photo-fix" ? stagePhotoFix(target!, record)
      : stageId === "descriptions" ? stageDescriptions(target!, record)
      : stageId === "amenities" ? stageAmenities(target!, record)
      : stageId === "cover-collage" ? stageCoverCollage(target!, record)
      : stageId === "layout" ? stageLayout(target!, record)
      : stageId === "pricing" ? stagePricing(target!, record)
      : stageChannels(target!);
    // Promise.race cannot cancel a mutating stage. In strict bulk mode, letting
    // the wrapper time out would start later stages while the original write
    // kept running in the background (photo replacement vs collage/push is the
    // dangerous case). Each strict mutating engine owns bounded network calls
    // and polling deadlines, so await it to its real terminal result.
    outcome = record.fullAutomation && FULL_AUTOMATION_MUTATING_STAGES.has(stageId)
      ? await work
      : await withTimeout(work, STAGE_TIMEOUT_MS[stageId], UNIT_AUDIT_STAGE_LABELS[stageId]);
  } catch (e: any) {
    if (String(e?.message) === "cancelled") throw e;
    // A resolve failure is fatal for the whole sweep — rethrow after recording.
    outcome = { verdict: "error", detail: `Check could not run: ${e?.message ?? e}` };
    if (stageId === "resolve") {
      touch(record, {
        stages: upsertUnitAuditStageResult(record.stages, { stage: stageId, verdict: "error", detail: outcome.detail, elapsedMs: Date.now() - startedAt }),
      });
      throw e;
    }
  }
  if (opts.retryPass) {
    outcome = {
      ...outcome,
      items: [
        ...(outcome.items ?? []),
        `Automatically re-checked (double-check pass ${opts.retryPass}) because the first attempt could not verify or fix this stage`,
      ],
    };
  }
  touch(record, {
    stages: upsertUnitAuditStageResult(record.stages, {
      stage: stageId,
      verdict: outcome.verdict,
      detail: outcome.detail,
      items: outcome.items,
      elapsedMs: Date.now() - startedAt,
    }),
  });
}

// Global concurrency gate (bulk "Audit selected", PR 3): each sweep is heavy
// on shared budgets (Lens, SearchAPI, vision), so queued sweeps run one at a
// time by default (UNIT_AUDIT_CONCURRENCY raises it). Waiting records stay
// status "queued" with a heartbeat touch so the resume window never lapses
// while they wait in line.
let runningSweeps = 0;
async function acquireSweepSlot(record: UnitAuditJobRecord): Promise<void> {
  const max = Math.max(1, Number(process.env.UNIT_AUDIT_CONCURRENCY ?? "1") || 1);
  let waitNoted = false;
  while (runningSweeps >= max) {
    if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
    if (!waitNoted || Date.now() - record.updatedAt > 60_000) {
      waitNoted = true;
      touch(record, { message: "Queued — waiting for the running audit sweep to finish…" });
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  runningSweeps += 1;
}

// END-OF-SWEEP Guesty sync for dedupe hides (2026-07-15, the sweep edition of
// PR #1042): if this sweep's dedupe stage hid ≥1 duplicate, fire ONE
// full-gallery re-push so the hides reach the live Guesty listing — AFTER
// every photo stage AND the retry rails, so a minutes-long push can never
// race the replace rung or the collage pin. Standard/manual sweeps keep the
// historical fire-and-forget behavior (the Photos tab ledger confirms it).
// Strict dashboard bulk audits await the push and turn a mapped push failure
// into an error receipt, so "Audit selected" cannot finish green while Guesty
// still serves a hidden duplicate. A completed replacement resets the hide counter immediately after
// its awaited gallery push: pre-swap hides already rode along, while any hides
// found by the mandatory post-swap dedupe are newer and therefore still reach
// this one end-of-sweep push. RATE-LIMIT POSTURE: a push fires only when a hide
// actually landed after the latest gallery push, so the weekly cron is
// self-quenching — once the dupes are hidden, later sweeps find nothing new
// and fire nothing; sweeps run one-at-a-time (UNIT_AUDIT_CONCURRENCY) so
// pushes space out, and every Guesty call serializes through guesty-sync's
// global gate. Kill switch: AUDIT_DEDUPE_GUESTY_PUSH=0.
// Returns the honest receipt line plus any strict failure (or null when there
// is nothing to say). At-most-once per job: the map entry is consumed.
async function runSweepDedupeGuestySync(record: UnitAuditJobRecord): Promise<{ note: string; strictFailure?: string } | null> {
  const target = targets.get(record.jobId);
  // Every mapped dashboard audit gets one final exact read-back after the
  // collage stage, even if a successful replacement already cleared an
  // earlier pending flag. The durable receipt makes a resumed job idempotent
  // only after that exact current-audit collage + ordered gallery was proven.
  const strictMappedFinalSync = record.fullAutomation
    && !!target?.guestyListingId
    && !record.finalGuestyGalleryVerified;
  if (!record.pendingGuestyGallerySync && !strictMappedFinalSync) return null;
  const hidden = record.pendingDedupeHiddenCount;
  const plural = hidden === 1 ? "" : "s";
  const localChange = hidden > 0
    ? `${hidden} hidden duplicate${plural}`
    : "the final locally changed gallery";
  if (!target?.guestyListingId) {
    try {
      await clearGuestyGallerySyncPending(record, {
        requiredCoverCollageUrl: null,
        finalGuestyGalleryVerified: false,
      });
      return { note: `${localChange} saved locally — property is not connected to Guesty, nothing external to sync` };
    } catch (e: any) {
      const note = `${localChange} was saved locally, but its durable no-Guesty sync receipt could not be recorded (${String(e?.message ?? e)})`;
      return record.fullAutomation ? { note, strictFailure: note } : { note };
    }
  }
  if (record.fullAutomation && !record.requiredCoverCollageUrl) {
    const note = "Guesty exact-gallery sync was not attempted because this audit did not persist the generated Cover Collage URL identity.";
    return { note, strictFailure: note };
  }
  if (String(process.env.AUDIT_DEDUPE_GUESTY_PUSH ?? "").trim() === "0") {
    const note = `${localChange} NOT synchronized to Guesty (AUDIT_DEDUPE_GUESTY_PUSH=0) — use "Push Photos to Guesty" on the Photos tab`;
    return record.fullAutomation ? { note, strictFailure: note } : { note };
  }
  const pushPromise = repushGuestyPhotosForProperty(record.propertyId, {
    reason: record.fullAutomation
      ? "unit-audit sweep — verify this audit's exact Cover Collage and final ordered gallery"
      : `unit-audit sweep — synchronize final local gallery${hidden > 0 ? ` after hiding ${hidden} duplicate${plural}` : " after photo replacement"}`,
    ...(record.fullAutomation ? { requiredCoverCollageUrl: record.requiredCoverCollageUrl! } : {}),
  });
  if (!record.fullAutomation) {
    touch(record, {
      pendingGuestyGallerySync: false,
      pendingDedupeHiddenCount: 0,
      requiredCoverCollageUrl: null,
    });
    void pushPromise.then((r) => {
      if (!r.ok) console.warn(`[unit-audit] ${record.propertyName}: dedupe Guesty re-push did not complete — ${r.error ?? r.skipped ?? "unknown"}`);
    }).catch((e: any) => {
      console.warn(`[unit-audit] ${record.propertyName}: dedupe Guesty re-push failed to start — ${e?.message ?? e}`);
    });
    return { note: `Guesty gallery re-push started in the background to synchronize ${localChange} — the Photos tab push ledger ("Pushed …") confirms completion` };
  }

  try {
    const result = await pushPromise;
    const exactGalleryVerified = result.collagePinned === true && result.strictGalleryVerified === true;
    if (result.ok && !result.skipped && exactGalleryVerified) {
      try {
        await clearGuestyGallerySyncPending(record, {
          requiredCoverCollageUrl: null,
          finalGuestyGalleryVerified: true,
        });
      } catch (e: any) {
        const note = `Guesty exact-gallery read-back succeeded, but its durable completion receipt could not be saved (${String(e?.message ?? e)}); the sync remains pending`;
        return { note, strictFailure: note };
      }
      return {
        note: `Guesty exact gallery verified: this audit's Cover Collage is first and all ${result.successCount ?? 0} photo${result.successCount === 1 ? "" : "s"} match the intended order`,
      };
    }
    const reason = result.error
      ?? result.skipped
      ?? (!exactGalleryVerified ? "the exact current-audit collage and ordered gallery were not proven" : "unknown Guesty push outcome");
    const note = `Guesty gallery re-push did not complete while synchronizing ${localChange} (${reason}) — the strict audit cannot verify the live gallery`;
    return { note, strictFailure: note };
  } catch (e: any) {
    const note = `Guesty gallery re-push failed while synchronizing ${localChange} (${String(e?.message ?? e)}) — the strict audit cannot verify the live gallery`;
    return { note, strictFailure: note };
  }
}

// Append the sync verdict to the photo-dedupe receipt row so the operator
// can see from the receipt alone whether Guesty was updated.
async function noteSweepDedupeGuestySync(record: UnitAuditJobRecord): Promise<void> {
  const sync = await runSweepDedupeGuestySync(record);
  if (!sync) return;
  const row = record.stages.find((s) => s.stage === "photo-dedupe");
  if (!row) return;
  touch(record, {
    stages: upsertUnitAuditStageResult(record.stages, {
      ...row,
      ...(sync.strictFailure
        ? { verdict: "error" as const, detail: `${row.detail} Guesty sync failed after the local cleanup.` }
        : {}),
      items: [...(row.items ?? []), sync.note],
    }),
  });
}

async function runUnitAuditJob(record: UnitAuditJobRecord): Promise<void> {
  if (activeJobIds.has(record.jobId)) return;
  activeJobIds.add(record.jobId);
  let holdsSlot = false;
  try {
    await acquireSweepSlot(record);
    holdsSlot = true;
    touch(record, { status: "running" });
    // Resume seam: `resolve` always re-runs (its target is in-memory only) but
    // overwrites its own stage row; every already-completed stage is skipped.
    if (!targets.has(record.jobId)) {
      await runStageForRecord(record, "resolve");
    }
    for (;;) {
      if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
      const next = nextUnitAuditStage(record);
      if (!next) break;
      await runStageForRecord(record, next);
    }

    // RETRY RAIL A (2026-07-12, operator: "no human intervention … double or
    // triple check system"): before the receipt is written, re-run every
    // stage that ended `error` (the "? unverified" badge class) plus
    // attention/failed rows carrying a TRANSIENT auto-fix failure signature —
    // a timeout, quota blip, or already-running refresh usually clears on a
    // second look minutes later. Pure unitAuditRetryStageIds picks the rows;
    // judgment-call attention rows (layout, licenses, cooldown/budget,
    // replace-permission) never re-run. If a photo verify changes verdict,
    // photo-fix re-runs too (its inputs changed). AUDIT_STAGE_RETRY_PASSES=0
    // disables; default 2 extra passes = triple-checked worst case.
    const retryPasses = (() => {
      const n = Number(process.env.AUDIT_STAGE_RETRY_PASSES ?? String(UNIT_AUDIT_STAGE_RETRY_PASSES_DEFAULT));
      return Number.isFinite(n) ? Math.max(0, Math.min(4, Math.floor(n))) : UNIT_AUDIT_STAGE_RETRY_PASSES_DEFAULT;
    })();
    for (let pass = 1; pass <= retryPasses; pass++) {
      if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
      const retryIds = unitAuditRetryStageIds(record.stages);
      if (retryIds.length === 0) break;
      touch(record, { message: `Double-checking ${retryIds.length} unresolved stage${retryIds.length === 1 ? "" : "s"} before the receipt (retry pass ${pass}/${retryPasses})…` });
      await new Promise((r) => setTimeout(r, RETRY_PASS_DELAY_MS));
      const before = new Map(record.stages.map((s) => [s.stage, s.verdict]));
      for (const stageId of retryIds) {
        if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
        await runStageForRecord(record, stageId, { retryPass: pass });
      }
      // Dependent refresh: photo-fix plans off the community + OTA rows, so a
      // verdict change there makes its row stale — re-run it (idempotent: it
      // re-reads current state and fixes only what is still broken).
      const photoInputChanged = (["photo-community", "ota-scan"] as UnitAuditStageId[]).some((id) => {
        const now = record.stages.find((s) => s.stage === id)?.verdict;
        return now !== undefined && before.get(id) !== undefined && before.get(id) !== now;
      });
      const photoFixRow = record.stages.find((s) => s.stage === "photo-fix");
      if (
        photoInputChanged &&
        photoFixRow &&
        !retryIds.includes("photo-fix") &&
        (photoFixRow.verdict === "attention" || photoFixRow.verdict === "failed" || photoFixRow.verdict === "error")
      ) {
        await runStageForRecord(record, "photo-fix", { retryPass: pass });
      }
    }

    // Retry rails run after the first collage stage and may still hide,
    // rescrape, repull, or replace photos. Every strict mutator pre-arms this
    // durable dirty bit and clears the older collage identity before changing
    // files. Re-compose once, after the LAST retry pass, so both local-only
    // listings and the mapped final exact sync use a collage from the actual
    // final gallery rather than one depicting a removed/hidden photo.
    if (record.fullAutomation && record.coverCollageNeedsRefresh) {
      if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
      await runStageForRecord(record, "cover-collage");
    }

    // Every photo stage + the retry rails are done — safe point for the ONE
    // Guesty gallery re-push that propagates this sweep's dedupe
    // hides to the live listing (no-op when nothing was hidden / a swap
    // already pushed). Must run BEFORE the receipt so the photo-dedupe row
    // carries the sync verdict. Strict dashboard runs await and verify it;
    // standard runs preserve the background behavior.
    await noteSweepDedupeGuestySync(record);

    const headline = unitAuditHeadline(record.stages);
    touch(record, { status: "completed", currentStage: null, message: headline, error: null });
    const report: UnitAuditReportRecord = {
      propertyId: record.propertyId,
      propertyName: record.propertyName,
      jobId: record.jobId,
      finishedAt: new Date().toISOString(),
      verdict: rollUpUnitAuditVerdict(record.stages),
      stages: record.stages.map((s) => ({ ...s })),
    };
    await mutateReports((reports) => { reports[String(record.propertyId)] = report; });
  } catch (e: any) {
    if (String(e?.message) === "cancelled") {
      // Operator cancel = stop doing things; already-applied hides stay
      // local-only (the next completed sweep or any photo push heals Guesty).
      touch(record, { status: "cancelled", currentStage: null, message: "Audit sweep cancelled.", error: null });
    } else {
      // The hides a FAILED sweep applied are just as durable as a completed
      // sweep's — still sync them so the live listing doesn't keep serving
      // duplicates because a LATER stage (descriptions/pricing/…) errored.
      await noteSweepDedupeGuestySync(record);
      touch(record, { status: "failed", currentStage: null, error: e?.message ?? "Audit sweep failed" });
    }
  } finally {
    if (holdsSlot) runningSweeps -= 1;
    activeJobIds.delete(record.jobId);
    cancelRequested.delete(record.jobId);
    targets.delete(record.jobId);
    communityResults.delete(record.jobId);
    replacedThisSweep.delete(record.jobId);
  }
}

// ── Public API (routes) ──────────────────────────────────────────────────────

export async function startUnitAuditSweep(input: { propertyId: number; autoFix?: boolean; allowReplace?: boolean; fullAutomation?: boolean; source?: "manual" | "cron" }): Promise<
  { ok: true; job: UnitAuditJobRecord } | { ok: false; status: number; error: string }
> {
  const propertyId = Number(input.propertyId);
  if (!Number.isFinite(propertyId) || propertyId === 0) {
    return { ok: false, status: 400, error: "propertyId required (positive core id or negative -draftId)" };
  }
  // Cheap existence check before creating a record.
  const target = await resolveUnitAuditTarget(propertyId);
  if (!target) return { ok: false, status: 404, error: "Unknown property/draft for audit sweep" };

  for (const existing of Array.from(jobs.values())) {
    if (existing.propertyId === propertyId && isUnitAuditStatusActive(existing.status)) {
      if (input.fullAutomation === true && !existing.fullAutomation) {
        // A queued job that has not acquired the worker can safely be upgraded
        // in place. Once any standard stage has started/completed, reusing it
        // would falsely tell Audit selected that the strict Claude/SearchAPI
        // contract ran, even though earlier artifacts were never regenerated.
        if (existing.status === "queued" && existing.currentStage == null && existing.stages.length === 0) {
          touch(existing, { fullAutomation: true, autoFix: true, allowReplace: true, source: "manual" });
          return { ok: true, job: existing };
        }
        return {
          ok: false,
          status: 409,
          error: "A standard audit is already running for this property. Let it finish, then click Audit selected again so every strict stage runs from the beginning.",
        };
      }
      return { ok: true, job: existing };
    }
  }
  const raw = await storage.getSetting(UNIT_AUDIT_STORE_SETTING_KEY).catch(() => undefined);
  const persistedActive = findActiveUnitAuditJob(parseUnitAuditStore(raw ?? null), propertyId);
  if (persistedActive && !jobs.has(persistedActive.jobId)) {
    if (input.fullAutomation === true && !persistedActive.fullAutomation) {
      if (persistedActive.status === "queued" && persistedActive.currentStage == null && persistedActive.stages.length === 0) {
        persistedActive.fullAutomation = true;
        persistedActive.autoFix = true;
        persistedActive.allowReplace = true;
        persistedActive.source = "manual";
      } else {
        return {
          ok: false,
          status: 409,
          error: "A standard audit is already running for this property. Let it finish, then click Audit selected again so every strict stage runs from the beginning.",
        };
      }
    }
    jobs.set(persistedActive.jobId, persistedActive);
    await mutateStore((store) => { store[persistedActive.jobId] = { ...persistedActive }; });
    void runUnitAuditJob(persistedActive);
    return { ok: true, job: persistedActive };
  }

  const record: UnitAuditJobRecord = {
    jobId: `uas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    propertyId,
    propertyName: target.propertyName,
    status: "queued",
    currentStage: null,
    stages: [],
    message: "Queued",
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resumeCount: 0,
    autoFix: input.autoFix !== false,
    allowReplace: input.allowReplace !== false,
    fullAutomation: input.fullAutomation === true,
    pendingGuestyGallerySync: false,
    pendingDedupeHiddenCount: 0,
    coverCollageNeedsRefresh: false,
    requiredCoverCollageUrl: null,
    finalGuestyGalleryVerified: false,
    source: input.source === "cron" ? "cron" : "manual",
  };
  jobs.set(record.jobId, record);
  await mutateStore((store) => { store[record.jobId] = { ...record }; });
  void runUnitAuditJob(record);
  return { ok: true, job: record };
}

// Bulk "Audit selected" (dashboard checkboxes): one sweep per property,
// deduped by the per-property active guard, funneled through the global
// concurrency slot so they run in sequence.
export async function startUnitAuditSweepBulk(input: {
  propertyIds: number[];
  autoFix?: boolean;
  allowReplace?: boolean;
  fullAutomation?: boolean;
  source?: "manual" | "cron";
}): Promise<{ started: UnitAuditJobRecord[]; skipped: Array<{ propertyId: number; error: string }> }> {
  const ids = Array.from(new Set((input.propertyIds ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n !== 0))).slice(0, 40);
  const started: UnitAuditJobRecord[] = [];
  const skipped: Array<{ propertyId: number; error: string }> = [];
  for (const propertyId of ids) {
    const result = await startUnitAuditSweep({
      propertyId,
      autoFix: input.autoFix,
      allowReplace: input.allowReplace,
      fullAutomation: input.fullAutomation,
      source: input.source,
    });
    if (result.ok) started.push(result.job);
    else skipped.push({ propertyId, error: result.error });
  }
  return { started, skipped };
}

export async function getUnitAuditJob(jobId: string): Promise<UnitAuditJobRecord | null> {
  const live = jobs.get(jobId);
  if (live) return live;
  const raw = await storage.getSetting(UNIT_AUDIT_STORE_SETTING_KEY).catch(() => undefined);
  // Own-property lookup — jobId comes from the request path, and a crafted
  // "__proto__" id against a plain object would hand back Object.prototype
  // for the cancel path to mutate (CodeQL, PR #1013).
  return lookupUnitAuditRecord(parseUnitAuditStore(raw ?? null), jobId);
}

export async function listUnitAuditJobs(): Promise<{ activeCount: number; jobs: UnitAuditJobRecord[] }> {
  const raw = await storage.getSetting(UNIT_AUDIT_STORE_SETTING_KEY).catch(() => undefined);
  const store = parseUnitAuditStore(raw ?? null);
  for (const record of Array.from(jobs.values())) store[record.jobId] = record;
  return summarizeUnitAuditQueue(store, Date.now());
}

export async function cancelUnitAuditSweep(jobId: string): Promise<UnitAuditJobRecord | null> {
  const record = await getUnitAuditJob(jobId);
  if (!record) return null;
  if (!isUnitAuditStatusActive(record.status)) return record;
  if (activeJobIds.has(jobId)) {
    // Live in this process — the run loop notices between stages / inside the
    // OTA poll loop and terminalizes with status "cancelled".
    cancelRequested.add(jobId);
    touch(record, { message: "Cancelling after the current step…" });
    return record;
  }
  // Orphaned record (not running here) — terminalize directly.
  record.status = "cancelled";
  record.currentStage = null;
  record.message = "Audit sweep cancelled.";
  record.updatedAt = Date.now();
  jobs.set(jobId, record);
  await mutateStore((store) => { store[jobId] = { ...record }; });
  return record;
}

// Dashboard column feed: last report + live job per property, one call.
export async function getUnitAuditDashboardStatus(): Promise<{
  reports: Record<string, { verdict: UnitAuditReportRecord["verdict"]; finishedAt: string; headline: string; stages: UnitAuditStageResult[]; jobId: string }>;
  active: Record<string, { jobId: string; status: UnitAuditJobRecord["status"]; currentStage: UnitAuditStageId | null }>;
}> {
  const rawReports = await storage.getSetting(UNIT_AUDIT_REPORTS_SETTING_KEY).catch(() => undefined);
  const reports = parseUnitAuditReports(rawReports ?? null);
  // Null-prototype like the parsers — keys originate from persisted JSON.
  const out: Record<string, { verdict: UnitAuditReportRecord["verdict"]; finishedAt: string; headline: string; stages: UnitAuditStageResult[]; jobId: string }> = Object.create(null);
  for (const [key, r] of Object.entries(reports)) {
    out[key] = { verdict: r.verdict, finishedAt: r.finishedAt, headline: unitAuditHeadline(r.stages), stages: r.stages, jobId: r.jobId };
  }
  const queue = await listUnitAuditJobs();
  const active: Record<string, { jobId: string; status: UnitAuditJobRecord["status"]; currentStage: UnitAuditStageId | null }> = {};
  for (const job of queue.jobs) {
    if (!isUnitAuditStatusActive(job.status)) continue;
    active[String(job.propertyId)] = { jobId: job.jobId, status: job.status, currentStage: job.currentStage };
  }
  return { reports: out, active };
}

// ── Boot/interval watchdog (same pattern as auto-replace) ────────────────────

let resumeSweepInFlight = false;
export async function resumeOrphanedUnitAuditJobs(): Promise<void> {
  if (resumeSweepInFlight) return;
  resumeSweepInFlight = true;
  try {
    const raw = await storage.getSetting(UNIT_AUDIT_STORE_SETTING_KEY);
    const store = parseUnitAuditStore(raw ?? null);
    for (const record of Object.values(store)) {
      if (!shouldResumeUnitAuditJob(record, Date.now())) continue;
      if (jobs.has(record.jobId) || activeJobIds.has(record.jobId)) continue;
      console.warn(`[unit-audit] boot-resume: re-attaching orphaned sweep ${record.jobId} (stage ${record.currentStage ?? "?"}, resume ${record.resumeCount + 1}/${MAX_UNIT_AUDIT_RESUMES})`);
      record.resumeCount += 1;
      jobs.set(record.jobId, record);
      void mutateStore((store2) => { store2[record.jobId] = { ...record }; });
      void runUnitAuditJob(record);
    }
    const liveIds = new Set([...Array.from(jobs.keys()), ...Array.from(activeJobIds)]);
    const stuckIds = Object.values(store).filter((r) =>
      isUnitAuditStatusActive(r.status) && !liveIds.has(r.jobId) && !shouldResumeUnitAuditJob(r, Date.now()),
    ).map((r) => r.jobId);
    if (stuckIds.length > 0) {
      console.warn(`[unit-audit] failing ${stuckIds.length} stuck unresumable sweep(s): ${stuckIds.join(", ")}`);
      await mutateStore((liveStore, now) => {
        failStuckUnitAuditRecords(liveStore, now, liveIds);
      });
    }
  } catch {
    // Fail-soft — next sweep retries.
  } finally {
    resumeSweepInFlight = false;
  }
}

export function startUnitAuditResumeWatchdog(): void {
  if (/^(1|true|yes|on)$/i.test(String(process.env.UNIT_AUDIT_RESUME_DISABLED ?? "").trim())) {
    console.log("[unit-audit] resume watchdog disabled via UNIT_AUDIT_RESUME_DISABLED");
    return;
  }
  // After the loopback server is listening (the sweep's stages self-call it).
  setTimeout(() => void resumeOrphanedUnitAuditJobs(), 30_000).unref?.();
  setInterval(() => void resumeOrphanedUnitAuditJobs(), 2 * 60_000).unref?.();
}
