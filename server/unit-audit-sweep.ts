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
import {
  COMMUNITY_PHOTO_FIX_FLOOR,
  communityPhotoFixSelections,
  dedupeAutoFixSelections,
  photoFixRungsForUnit,
  replaceRungOnCooldown,
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
  rollUpUnitAuditVerdict,
  serializeUnitAuditReports,
  serializeUnitAuditStore,
  shouldResumeUnitAuditJob,
  summarizeUnitAuditQueue,
  unitAuditHeadline,
  upsertUnitAuditStageResult,
  type UnitAuditJobRecord,
  type UnitAuditReportRecord,
  type UnitAuditStageId,
  type UnitAuditStageResult,
  type UnitAuditStageVerdict,
} from "@shared/unit-audit-sweep-logic";
import { buildPhotoCommunityCheckRequestForProperty, listPublishedFilenames, readFolderSourceUrl, writeFolderSourceUrlIfMissing } from "./builder-photo-groups";
import { replacementPhotoFolderRef } from "@shared/photo-folder-utils";
import { scanForDuplicatePhotos, type DedupeScanGroupInput } from "./photo-dedupe";
import type { PhotoCommunityCheckResult } from "./photo-community-check";
import { getPreflightPhotoFetchJob, startPreflightPhotoFetchJob } from "./preflight-background-jobs";
import { getCommunityPhotoRepullJob, startCommunityPhotoRepullJob } from "./community-photo-repull";
import { listAutoReplaceJobs, startAutoReplaceJob } from "./auto-replace-jobs";
import { isAutoReplacePhaseActive, draftUnitIdForSlot } from "@shared/auto-replace-job-logic";
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
  "photo-dedupe": 12 * 60_000,
  "photo-community": 18 * 60_000,
  "ota-scan": 16 * 60_000,
  // The ladder's worst case is real work: a re-scrape (~minutes), a
  // find-new-source discovery job (~minutes), a full one-click unit
  // replacement (find → commit → verify, up to ~35 min), plus a Lens+vision
  // re-check after each photo change. Bounded per-rung below.
  "photo-fix": 90 * 60_000,
  descriptions: 6 * 60_000,
  amenities: 8 * 60_000,
  "cover-collage": 8 * 60_000,
  layout: 90_000,
  pricing: 20 * 60_000,
  channels: 90_000,
};

// Global auto-fix kill (the per-engine kill switches — COVER_COLLAGE_VISION_
// DISABLED, PHOTO_DEDUPE_VISION_DISABLED, etc. — still apply downstream).
const autoFixGloballyDisabled = () =>
  /^(1|true|yes|on)$/i.test(String(process.env.UNIT_AUDIT_AUTOFIX_DISABLED ?? "").trim());
const autoFixEnabled = (record: UnitAuditJobRecord) => record.autoFix && !autoFixGloballyDisabled();

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
// Rates pushed longer ago than this read as stale (matches the dashboard
// "Last Price Scan" amber threshold — the weekly cron cadence + 1 day).
const PRICING_STALE_DAYS = 8;

const jobs = new Map<string, UnitAuditJobRecord>();
const activeJobIds = new Set<string>();
const cancelRequested = new Set<string>();

let storeTail: Promise<void> = Promise.resolve();
function mutateStore(mutate: (store: Record<string, UnitAuditJobRecord>, nowMs: number) => void): Promise<void> {
  storeTail = storeTail.then(async () => {
    try {
      const now = Date.now();
      const raw = await storage.getSetting(UNIT_AUDIT_STORE_SETTING_KEY);
      const store = parseUnitAuditStore(raw ?? null);
      mutate(store, now);
      await storage.setSetting(UNIT_AUDIT_STORE_SETTING_KEY, serializeUnitAuditStore(store, now));
    } catch {
      // Fail-soft: persistence is an upgrade, never a blocker.
    }
  });
  return storeTail;
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
  const built = await buildPhotoCommunityCheckRequestForProperty(propertyId).catch(() => null);
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
    if (!builder) return null;
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
  targets.set(record.jobId, target);
  const items: string[] = [];
  items.push(target.guestyListingId
    ? `Guesty listing mapped (${target.guestyListingId})`
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
    verdict: target.guestyListingId ? "pass" : "attention",
    detail: `${target.propertyName} · ${target.communityName}${target.expectedListingBedrooms ? ` · ${target.expectedListingBedrooms}BR listing` : ""} · ${target.groups.length} photo folder${target.groups.length === 1 ? "" : "s"} resolved`,
    items,
  };
}

async function stagePhotoDedupe(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  if (target.groups.length === 0) {
    return { verdict: "error", detail: "No published photos found — nothing to scan for duplicates." };
  }
  const groups: DedupeScanGroupInput[] = target.groups.map((g) => ({
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

  let proposal = await scanForDuplicatePhotos(groups);
  let s = summarize(proposal);
  const items: string[] = [...s.lines];
  if (proposal.note) items.push(proposal.note);
  if (s.all.length === 0) {
    return {
      verdict: "pass",
      detail: `No duplicates found across ${target.groups.length} folder${target.groups.length === 1 ? "" : "s"}${proposal.visionUsed ? " (hash + AI same-scene scan)" : " (hash-only scan)"}.`,
      items: proposal.note ? [proposal.note] : undefined,
    };
  }

  // AUTO-FIX: hide the removable extras via the existing apply route — same
  // keep-one-per-group + never-empty-folder validation as the Photos-tab
  // confirm, and the same photo_labels.hidden soft-delete, so ↺ Undo on the
  // Photos tab remains a true undo. Hash-proven (exact/near) groups always
  // apply; AI same-scene groups apply too per the operator's 2026-07-12
  // "automate fixing all of these" directive — AUDIT_DEDUPE_SAME_SCENE=0
  // restores review-only for them.
  const includeSameScene = String(process.env.AUDIT_DEDUPE_SAME_SCENE ?? "").trim() !== "0";
  let fixedNote = "";
  if (autoFixEnabled(record) && (s.hash.length > 0 || (includeSameScene && s.sameScene.length > 0))) {
    const selection = dedupeAutoFixSelections(
      s.all.map((g) => ({ kind: g.kind, folder: g.folder, members: g.members })),
      { includeSameScene },
    );
    if (selection.remove.length > 0) {
      touch(record, { message: `Hiding ${selection.remove.length} duplicate photo${selection.remove.length === 1 ? "" : "s"} (hash + same-scene extras; soft-delete, undoable)…` });
      const apply = await loopbackJson("POST", "/api/builder/photo-dedupe-apply", { scanId: proposal.scanId, remove: selection.remove }, 60_000)
        .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
      if (apply.status >= 400) {
        items.push(`Auto-fix could not apply (${String(apply.data?.error ?? `HTTP ${apply.status}`)}) — review on the Photos tab instead`);
        return {
          verdict: "attention",
          detail: `${s.hash.length} hash duplicate group${s.hash.length === 1 ? "" : "s"} found but the auto-hide was refused — review with 🧹 Scan photos & remove duplicates.`,
          items,
        };
      }
      fixedNote = `${selection.remove.length} duplicate photo${selection.remove.length === 1 ? "" : "s"} hidden (soft-delete — ↺ Undo on the Photos tab)`;
      items.push(`Auto-fixed: ${fixedNote}: ${selection.remove.map((r) => r.filename).slice(0, 8).join(", ")}${selection.remove.length > 8 ? ", …" : ""}`);
      // Re-resolve the target so this re-verify AND every later stage (e.g.
      // the collage candidate list) see the surviving photo set, not the
      // just-hidden files.
      const refreshedTarget = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
      if (refreshedTarget) targets.set(record.jobId, refreshedTarget);
      const refreshedGroups: DedupeScanGroupInput[] = (refreshedTarget ?? target).groups.map((g) => ({
        folder: g.folder,
        label: g.label,
        filenames: g.filenames,
        captions: g.captions,
      }));
      if (refreshedGroups.length > 0) {
        proposal = await scanForDuplicatePhotos(refreshedGroups);
        s = summarize(proposal);
        if (s.hash.length > 0 || (includeSameScene && s.sameScene.length > 0)) {
          items.push(`Re-verify: ${s.hash.length + (includeSameScene ? s.sameScene.length : 0)} duplicate group(s) still present — review on the Photos tab`);
        }
      }
    }
  }

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
  return {
    verdict: fixedNote ? "fixed" : "pass",
    detail: fixedNote
      ? `${fixedNote} — re-scan confirms no duplicates remain.`
      : `No duplicates found across ${target.groups.length} folder${target.groups.length === 1 ? "" : "s"}.`,
    items,
  };
}

// Structured stage data for the photo-fix ladder — in-memory only (a resume
// mid-ladder re-runs the community check to re-derive it, which is honest:
// the world may have changed).
const communityResults = new Map<string, PhotoCommunityCheckResult>();

async function runCommunityCheck(target: UnitAuditTarget, record: UnitAuditJobRecord, message: string): Promise<
  { ok: true; result: PhotoCommunityCheckResult } | { ok: false; error: string }
> {
  touch(record, { message });
  const { status, data } = await loopbackJson(
    "POST",
    "/api/builder/photo-community-check",
    { propertyId: target.propertyId },
    STAGE_TIMEOUT_MS["photo-community"] - 30_000,
  );
  if (status >= 400 || data?.ok === false) {
    return { ok: false, error: String(data?.error ?? `HTTP ${status}`) };
  }
  const result = data as PhotoCommunityCheckResult;
  communityResults.set(record.jobId, result);
  return { ok: true, result };
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
  return out;
}

async function stagePhotoCommunity(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  if (unitGroups(target).length === 0 && !target.groups.some((g) => g.role === "community")) {
    return { verdict: "error", detail: "No published photos — the community/bedroom check cannot run." };
  }
  const run = await runCommunityCheck(target, record, "Running the full photo community check (Google Lens + Claude vision — this is the long stage)…");
  if (!run.ok) {
    return { verdict: "error", detail: `Community check could not run: ${run.error}` };
  }
  return summarizeCommunityResult(run.result);
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
  const stale = folders.filter((f) => !otaRowFresh(rows.get(f.folder), kickStart, otaFreshHoursFor(record)));
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

async function runPhotoFixRung(
  rung: PhotoFixRung,
  target: UnitAuditTarget,
  ref: UnitAuditUnitRef,
  folder: string,
  record: UnitAuditJobRecord,
): Promise<{ ok: boolean; note: string }> {
  if (rung === "rescrape") {
    touch(record, { message: `${ref.label}: re-scraping the current photo source…` });
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
      if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
      const j = getPreflightPhotoFetchJob(job.id);
      if (!j) return { ok: false, note: "find-new-source job vanished" };
      if (j.status === "completed") {
        return { ok: true, note: `found a new source${j.savedCount != null ? ` (${j.savedCount} photos saved)` : ""}${j.sourceUrl ? ` — ${j.sourceUrl}` : ""}` };
      }
      if (j.status === "failed" || j.status === "cancelled") {
        return { ok: false, note: `find-new-source ${j.status}: ${j.error ?? j.message ?? "no reason given"}` };
      }
      if (Date.now() > deadline) return { ok: false, note: "find-new-source did not finish in time" };
      touch(record, { message: `${ref.label}: ${j.message || "searching for a new photo source…"}` });
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // rung === "replace" — the one-click auto-replace orchestrator (find →
  // commit → verify + Guesty photo push). Its find phase only accepts
  // OTA-clean, community-matched candidates, which is what makes the result
  // trustworthy for the OTA-found case.
  touch(record, { message: `${ref.label}: replacing the unit (find → commit → verify — the long rung)…` });
  const started = await startAutoReplaceJob({ propertyId: target.propertyId, unitId: ref.unitId, unitLabel: ref.label });
  if (!started.ok) return { ok: false, note: `unit replacement did not start (${started.error})` };
  const replaceJobId = started.job.jobId;
  const deadline = Date.now() + PHOTO_FIX_REPLACE_CEILING_MS;
  for (;;) {
    if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
    const jobs2 = await listAutoReplaceJobs();
    const j = jobs2.jobs.find((x) => x.jobId === replaceJobId);
    if (!j) return { ok: false, note: "replacement job record vanished" };
    if (!isAutoReplacePhaseActive(j.phase)) {
      if (j.phase === "completed") {
        return { ok: true, note: `unit replaced — ${j.newUnitLabel ?? "new unit"}${j.newAddress ? ` (${j.newAddress})` : ""}` };
      }
      return { ok: false, note: `unit replacement failed: ${j.error ?? j.message ?? "no reason given"}` };
    }
    if (Date.now() > deadline) {
      return { ok: false, note: "unit replacement did not finish inside the audit window — it keeps running; check the dashboard replace queue" };
    }
    touch(record, { message: `${ref.label}: replacement ${j.phase} — ${j.message ?? "working…"}` });
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

async function stagePhotoFix(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  if (String(process.env.AUDIT_PHOTO_FIX ?? "").trim() === "0") {
    return { verdict: "skipped", detail: "Photo fix ladder disabled via AUDIT_PHOTO_FIX=0." };
  }
  if (!autoFixEnabled(record)) {
    return { verdict: "skipped", detail: "Verify-only run — the photo fix ladder (re-scrape → new source → replace unit) only runs with auto-fix on." };
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
      for (const h of selections.hide) {
        if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
        const put = await loopbackJson("PUT", `/api/photo-labels/${encodeURIComponent(h.folder)}/${encodeURIComponent(h.filename)}`, { hidden: true }, 30_000)
          .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
        if (put.status < 400) { hidden += 1; items.push(`Community folder: hid ${h.filename} — ${h.reason}`); }
        else items.push(`Community folder: could NOT hide ${h.filename} (${String((put.data as any)?.error ?? `HTTP ${put.status}`)})`);
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
      const repull = startCommunityPhotoRepullJob({
        communityName: target.communityName,
        communityFolder: communityGroupOf(target)?.folder ?? cg.folder,
        city: target.city,
        state: target.state,
      });
      const deadline = Date.now() + PHOTO_FIX_REPULL_CEILING_MS;
      for (;;) {
        if (cancelRequested.has(record.jobId)) throw new Error("cancelled");
        const j = getCommunityPhotoRepullJob(repull.id);
        if (!j) { items.push("Community repull job vanished"); break; }
        if (j.status === "completed") {
          items.push(`Community repull: ${j.savedCount ?? 0} photos saved, ${j.removedCount ?? 0} mismatches removed${j.verifiedCount != null ? `, ${j.verifiedCount} verified` : ""}`);
          anyFixed = true;
          const refreshed = await resolveUnitAuditTarget(target.propertyId).catch(() => null);
          if (refreshed) { targets.set(record.jobId, refreshed); target = refreshed; }
          const recheck = await runCommunityCheck(target, record, "Re-checking the community folder after the repull…");
          if (recheck.ok) communityResult = recheck.result;
          break;
        }
        if (j.status === "failed" || j.status === "cancelled") {
          items.push(`Community repull ${j.status}: ${j.message || "no reason given"}`);
          break;
        }
        if (Date.now() > deadline) { items.push("Community repull did not finish in time — it keeps running; re-run the audit later"); break; }
        touch(record, { message: `Community repull ${j.phase}: ${j.message || "working…"}` });
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    communityFolderStillBad = communityResult?.community?.matchesExpected === "no" ||
      (communityResult?.community?.photoVerdicts ?? []).some((v) => v.match === "no");
    if (communityFolderStillBad) {
      items.push("Community folder still not confirmed after the cleanup ladder — review the report (yellow/uncertain votes may just need your eyes)");
    }
  }

  const problems = communityResult ? communityProblemsByUnit(communityResult) : new Map<string, { bedroomShort: boolean; communityMismatch: boolean }>();

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

  const otaFoundByLabel = new Set<string>();
  for (const g of unitGroups(target)) {
    const row = await storage.getPhotoListingCheckByFolder(g.folder).catch(() => undefined);
    if (!row) continue;
    const found = [row.airbnbStatus, row.vrboStatus, row.bookingStatus,
      row.airbnbAddressStatus, row.vrboAddressStatus, row.bookingAddressStatus].some((s: any) => s === "found");
    if (found) otaFoundByLabel.add(g.label);
  }

  type UnitPlan = { ref: UnitAuditUnitRef; folder: string; rungs: PhotoFixRung[]; why: string[] };
  const plans: UnitPlan[] = [];
  for (const ref of target.unitRefs) {
    const group = unitGroups(target).find((g) => g.label === ref.label);
    if (!group) continue;
    const p = problems.get(ref.label) ?? { bedroomShort: false, communityMismatch: false };
    const otaFound = otaFoundByLabel.has(ref.label);
    const rungs = photoFixRungsForUnit({ bedroomShort: p.bedroomShort, communityMismatch: p.communityMismatch, otaFound });
    if (rungs.length === 0) continue;
    const why = [
      otaFound ? "photos/address found on another OTA listing" : null,
      p.communityMismatch ? "photos not confirmed in the community" : null,
      p.bedroomShort ? "not enough bedroom photos" : null,
    ].filter((s): s is string => !!s);
    plans.push({ ref, folder: group.folder, rungs, why });
  }
  if (plans.length === 0 && !anyFixed && !communityFolderStillBad) {
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
    for (const rung of plan.rungs) {
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
      const rungResult = await runPhotoFixRung(rung, target, plan.ref, plan.folder, record);
      items.push(`${plan.ref.label}: ${rung} — ${rungResult.ok ? rungResult.note : `✕ ${rungResult.note}`}`);
      if (!rungResult.ok) continue;
      // A committed swap means downstream stages must re-ground content in
      // the NEW unit (descriptions regenerate, collage re-composes).
      if (rung === "replace") replacedThisSweep.add(record.jobId);

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
      const recheck = await runCommunityCheck(target, record, `${plan.ref.label}: re-checking community + bedroom coverage after the ${rung}…`);
      if (!recheck.ok) {
        items.push(`${plan.ref.label}: re-check could not run (${recheck.error})`);
        continue;
      }
      communityResult = recheck.result;
      const after = communityProblemsByUnit(recheck.result).get(plan.ref.label);
      const stillOta = rung === "replace" ? false : otaFoundByLabel.has(plan.ref.label);
      if (!after?.bedroomShort && !after?.communityMismatch && !stillOta) {
        healed = true;
        anyFixed = true;
        if (rung === "replace") {
          // The flagged photos are gone with the old unit; the replace flow's
          // find phase only accepts OTA-clean candidates and it already
          // kicked a fresh deep rescan of the new folder.
          otaFoundByLabel.delete(plan.ref.label);
        }
        items.push(`${plan.ref.label}: ✓ re-verified clean after the ${rung}`);
        break;
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
  if (anyFixed && communityResult) {
    const fresh = summarizeCommunityResult(communityResult, "(after photo fixes) ");
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
  return {
    verdict: "fixed",
    detail: `Photo problems fixed and re-verified${plans.length > 0 ? ` for ${plans.length} unit${plans.length === 1 ? "" : "s"}` : " (community folder cleanup)"} — log below.`,
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
async function regenerateDescriptionsForTarget(target: UnitAuditTarget): Promise<{ ok: boolean; note: string; patch?: Record<string, string> }> {
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
  if (summary) patch.summary = summary;
  if (space) patch.space = space;
  const neighborhood = String((gen as any)?.neighborhood ?? "").trim();
  if (neighborhood) patch.neighborhood = neighborhood;
  const transit = String((gen as any)?.transit ?? "").trim();
  if (transit) patch.transit = transit;
  if (Object.keys(patch).length === 0) return { ok: false, note: "Generator produced no usable fields." };

  await storage.upsertPropertyDescriptionOverrides(target.propertyId, patch);
  let note = `Regenerated ${Object.keys(patch).join(", ")} from the real source listings and saved as overrides`;

  if (target.guestyListingId) {
    const push = await loopbackJson("POST", "/api/builder/push-descriptions", {
      listingId: target.guestyListingId,
      descriptions: patch,
    }, 60_000).catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    note += push.status < 400
      ? "; pushed to Guesty (placeholder guard re-passed)"
      : `; Guesty push failed (${String((push.data as any)?.error ?? `HTTP ${push.status}`)}) — push from the Descriptions tab`;
  } else {
    note += "; no Guesty listing yet — the copy pushes when one is connected";
  }
  return { ok: true, note, patch };
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
  const needsFix = problems.placeholderFields.length > 0 || problems.embeddedHeaders.length > 0 || problems.emptySummary || forcedBySwap;
  if (needsFix && autoFixEnabled(record)) {
    if (forcedBySwap) items.push("Regenerating because a unit was replaced earlier in this sweep — grounding the copy in the NEW unit's source listing");
    touch(record, { message: "Regenerating descriptions from the real source listings (Claude)…" });
    const fix = await regenerateDescriptionsForTarget(target);
    items.push(fix.ok ? `Auto-fixed: ${fix.note}` : `Auto-fix failed: ${fix.note}`);
    if (fix.ok) {
      fixedNote = fix.note;
      ({ overrides, fields } = await effectiveDescriptionFields(target));
      problems = describeDescriptionProblems(fields);
      if (problems.items.length > 0) items.push(...problems.items.map((l) => `Re-verify: ${l}`));
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
  // (the 2026-07-12 Coconut Plantation receipt).
  const { status, data } = await loopbackJson("GET", `/api/builder/guesty-amenities?listingId=${encodeURIComponent(target.guestyListingId)}`, undefined, 30_000)
    .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
  if (status >= 400) {
    return { row, keys, scannedNote, missing: null, guestyCount: null, guestyReadError: String((data as any)?.error ?? `HTTP ${status}`) };
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

async function stageAmenities(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  let v = await verifyAmenities(target);
  const items: string[] = [];

  // AUTO-FIX: the existing scan route does the whole remedy in one call —
  // Claude-vision + area-research scan, ADD-ONLY merge over the saved set,
  // persist, and (when mapped) the add-only union push to Guesty. Fire when
  // there's no AI-scanned set yet or saved amenities are missing from Guesty.
  let fixedNote = "";
  const needsFix = !v.row || !v.row.scannedAt || (v.missing != null && v.missing.length > 0);
  if (needsFix && autoFixEnabled(record)) {
    touch(record, { message: "Scanning photos + area for amenities (Claude vision + web research), saving, and pushing add-only…" });
    const scan = await loopbackJson("POST", "/api/builder/scan-amenities", { propertyId: target.propertyId }, STAGE_TIMEOUT_MS.amenities - 90_000)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (scan.status >= 400) {
      items.push(`Auto-fix failed: amenity scan did not run (${String((scan.data as any)?.error ?? `HTTP ${scan.status}`)})`);
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

async function readCoverCollageRecord(listingId: string): Promise<any> {
  const raw = await storage.getSetting(COVER_COLLAGE_SETTING_KEY).catch(() => undefined);
  try {
    const map = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    return Object.prototype.hasOwnProperty.call(map, listingId) ? map[listingId] : null;
  } catch {
    return null;
  }
}

async function stageCoverCollage(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  if (!target.guestyListingId) {
    return { verdict: "skipped", detail: "No Guesty listing mapped — the cover collage is generated + pinned when a listing exists." };
  }
  let recordRow: any = await readCoverCollageRecord(target.guestyListingId);
  let fixedNote = "";
  // A unit replaced earlier in THIS sweep may be featured on the existing
  // collage — re-compose from the surviving photo set (post-swap
  // follow-through, 2026-07-12).
  const collageStaleFromSwap = !!recordRow && replacedThisSweep.has(record.jobId);
  if ((!recordRow || collageStaleFromSwap) && autoFixEnabled(record)) {
    // AUTO-FIX: the one-click AI collage — same endpoint the Photos-tab
    // button drives, candidates built from the resolved PUBLISHED photos
    // (hidden files never reach the pick; community-group labels keep the
    // destination-left pairing heuristic honest). Vision fail-softs to the
    // caption heuristic inside the endpoint; ImgBB + Guesty push included.
    const candidates = target.groups.flatMap((g) =>
      g.filenames.map((filename) => ({
        url: `/photos/${g.folder}/${filename}`,
        caption: g.captions[filename] ?? filename,
        source: g.label,
      })),
    ).slice(0, 80); // endpoint caps vision at COVER_COLLAGE_VISION_CAP anyway
    if (candidates.length < 2) {
      return { verdict: "attention", detail: "No AI cover collage and fewer than 2 published photos to build one from." };
    }
    touch(record, { message: "Making the AI cover collage (Claude picks the pair, composes, pushes + pins on Guesty)…" });
    const make = await loopbackJson("POST", "/api/builder/auto-cover-collage", {
      listingId: target.guestyListingId,
      photos: candidates,
    }, STAGE_TIMEOUT_MS["cover-collage"] - 60_000).catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (make.status >= 400) {
      return {
        verdict: "attention",
        detail: `No AI cover collage, and the auto-make failed: ${String((make.data as any)?.error ?? `HTTP ${make.status}`)} — use 🖼 Make Cover Collage on the Photos tab.`,
      };
    }
    recordRow = await readCoverCollageRecord(target.guestyListingId);
    fixedNote = collageStaleFromSwap
      ? "AI cover collage re-composed after this sweep's unit replacement, pushed to Guesty (pinned first)"
      : "AI cover collage generated, pushed to Guesty (pinned first), and saved in-system";
  }
  if (!recordRow) {
    return {
      verdict: "attention",
      detail: "No AI cover collage on file for this listing — one-click 🖼 Make Cover Collage on the Photos tab (Claude picks the pair, composes, pushes + pins).",
    };
  }
  const items: string[] = [
    `Picked ${recordRow.method === "vision" ? "by Claude vision" : "by the caption heuristic (vision fallback)"} on ${String(recordRow.createdAt ?? "").slice(0, 10)}`,
  ];
  if (recordRow.left?.caption || recordRow.right?.caption) {
    items.push(`Pair: ${recordRow.left?.caption ?? "?"} + ${recordRow.right?.caption ?? "?"}`);
  }
  const file = path.join(process.cwd(), "client/public/photos", COVER_COLLAGE_DISK_FOLDER, `${String(target.guestyListingId).replace(/[^a-zA-Z0-9_-]+/g, "-")}.jpg`);
  const onDisk = await fs.promises.access(file).then(() => true).catch(() => false);
  if (!onDisk) items.push("Saved collage file is missing from the photos volume (record exists; Guesty copy unaffected)");
  return {
    verdict: fixedNote ? "fixed" : "pass",
    detail: fixedNote
      ? `${fixedNote} (${recordRow.method === "vision" ? "Claude-vision pick" : "heuristic pick"}).`
      : `AI cover collage on file and pushed to Guesty (pinned first)${recordRow.method === "vision" ? "" : " — heuristic pick, consider re-running for a Claude-vision pick"}.`,
    items,
  };
}

async function stageLayout(target: UnitAuditTarget): Promise<StageOutcome> {
  if (!target.guestyListingId) {
    return { verdict: "skipped", detail: "No Guesty listing mapped — nothing to compare the bedding/layout against." };
  }
  const fields = "bedrooms bathrooms accommodates beds title";
  const { status, data } = await loopbackJson("GET", `/api/guesty-proxy/listings/${encodeURIComponent(target.guestyListingId)}?fields=${encodeURIComponent(fields)}`, undefined, 30_000)
    .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
  if (status >= 400) {
    return { verdict: "error", detail: `Could not read the Guesty listing to verify the layout (HTTP ${status}).` };
  }
  const items: string[] = [];
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
  if (mismatch || soft) {
    // DELIBERATELY no auto-push here: the canonical bedding push reads the
    // operator's Bedding-tab configuration from browser localStorage
    // (loadBuilderBeddingConfig), which this server-side sweep cannot see —
    // pushing static defaults could clobber his curated bed arrangement.
    // The remedy is one click on the builder's push button.
    items.push("Fix: open the builder and push Bedding + sqft (the sweep never overwrites a layout — your Bedding-tab configuration lives in the browser)");
  }
  if (mismatch) {
    return { verdict: "failed", detail: "Guesty bedroom count does not match the system unit config — guests are filtering on the wrong layout.", items };
  }
  if (soft) {
    return { verdict: "attention", detail: "Layout numbers partially disagree with Guesty — review the Bedding tab.", items };
  }
  return { verdict: "pass", detail: "Guesty layout matches the system config (bedrooms/bathrooms/sleeps).", items };
}

type PricingVerify = {
  verdict: UnitAuditStageVerdict;
  items: string[];
  /** A market-rate refresh+push would remedy the finding. */
  needsRefresh: boolean;
};

async function verifyPricing(target: UnitAuditTarget): Promise<PricingVerify> {
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
  if (!pushedAt) {
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
  let v = await verifyPricing(target);
  const items = [...v.items];

  // AUTO-FIX: the SAME per-property refresh+push path the "Update market
  // pricing" queue and the weekly cron drive — SearchAPI Airbnb median scan
  // per unit size, marked-up push to Guesty with read-back verification, and
  // the Last Price Scan stamp. Fired only when the verify found a refreshable
  // problem (never/stale/failed/seed/missing-size/RED confirmation) so a
  // fresh table never burns SearchAPI budget. AUDIT_PRICING_REFRESH=0 kills.
  let fixedNote = "";
  if (v.needsRefresh && autoFixEnabled(record) && String(process.env.AUDIT_PRICING_REFRESH ?? "").trim() !== "0") {
    touch(record, { message: "Refreshing market rates (SearchAPI Airbnb median) and pushing marked-up rates to Guesty — the long pricing leg…" });
    const refreshPath = target.isDraft
      ? `/api/community/${-target.propertyId}/refresh-pricing`
      : `/api/property/${target.propertyId}/refresh-market-rates`;
    const refresh = await loopbackJson("POST", refreshPath, {}, STAGE_TIMEOUT_MS.pricing - 2 * 60_000)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (refresh.status >= 400) {
      items.push(`Auto-fix failed: market-rate refresh did not run (${String((refresh.data as any)?.error ?? `HTTP ${refresh.status}`)})`);
    } else if ((refresh.data as any)?.alreadyRunning) {
      items.push("A market-rate refresh for this property is already running — re-run the audit after it lands");
    } else if ((refresh.data as any)?.guestyPush?.skipped) {
      // HONESTY (2026-07-12 "Last Price Scan didn't update" incident): the
      // scan saved a fresh pricing table, but NOTHING reached Guesty — the
      // refresh routes soft-skip the push (no mapped listing, no priced
      // months, plan gaps), and markScannerGuestyRatePush only stamps real
      // pushes, so the Last Price Scan column will not move. Say exactly
      // that instead of claiming "refreshed + pushed".
      const reason = String((refresh.data as any).guestyPush.reason ?? "no mapped Guesty listing / no priced months");
      items.push(`Auto-fix PARTIAL: market rates rescanned + saved, but the Guesty push was SKIPPED — ${reason}`);
      const re = await verifyPricing(target);
      items.push(...re.items.map((l) => `Re-verify: ${l}`));
      return {
        verdict: re.verdict === "pass" ? "attention" : re.verdict,
        detail: `Rates rescanned, but the Guesty push was skipped: ${reason} — the Last Price Scan column stamps real pushes only.`,
        items,
      };
    } else {
      fixedNote = "Market rates refreshed + pushed to Guesty";
      items.push(`Auto-fixed: ${fixedNote}`);
      v = await verifyPricing(target);
      items.push(...v.items.map((l) => `Re-verify: ${l}`));
    }
  }

  if (v.verdict === "pass" && fixedNote) {
    return { verdict: "fixed", detail: `${fixedNote} — re-verify clean.`, items };
  }
  const detail = v.verdict === "pass"
    ? `Pricing table fresh + pushed · ${v.items.find((i) => i.startsWith("Match confirmation")) ?? "rates verified"}`
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
    const { status, data } = await loopbackJson("GET", "/api/dashboard/channel-status", undefined, 45_000)
      .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
    if (status >= 400) {
      bump("error");
      items.push(`Channel status could not be read (HTTP ${status})`);
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

async function runStageForRecord(record: UnitAuditJobRecord, stageId: UnitAuditStageId): Promise<void> {
  const startedAt = Date.now();
  touch(record, {
    currentStage: stageId,
    message: `Stage ${UNIT_AUDIT_STAGE_IDS.indexOf(stageId) + 1}/${UNIT_AUDIT_STAGE_IDS.length}: ${UNIT_AUDIT_STAGE_LABELS[stageId]}…`,
  });
  let outcome: StageOutcome;
  try {
    const target = stageId === "resolve" ? null : targets.get(record.jobId) ?? null;
    if (stageId !== "resolve" && !target) throw new Error("internal: target not resolved");
    const work: Promise<StageOutcome> = stageId === "resolve"
      ? stageResolve(record)
      : stageId === "photo-dedupe" ? stagePhotoDedupe(target!, record)
      : stageId === "photo-community" ? stagePhotoCommunity(target!, record)
      : stageId === "ota-scan" ? stageOtaScan(target!, record)
      : stageId === "photo-fix" ? stagePhotoFix(target!, record)
      : stageId === "descriptions" ? stageDescriptions(target!, record)
      : stageId === "amenities" ? stageAmenities(target!, record)
      : stageId === "cover-collage" ? stageCoverCollage(target!, record)
      : stageId === "layout" ? stageLayout(target!)
      : stageId === "pricing" ? stagePricing(target!, record)
      : stageChannels(target!);
    outcome = await withTimeout(work, STAGE_TIMEOUT_MS[stageId], UNIT_AUDIT_STAGE_LABELS[stageId]);
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
      touch(record, { status: "cancelled", currentStage: null, message: "Audit sweep cancelled.", error: null });
    } else {
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

export async function startUnitAuditSweep(input: { propertyId: number; autoFix?: boolean; allowReplace?: boolean; source?: "manual" | "cron" }): Promise<
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
      return { ok: true, job: existing };
    }
  }
  const raw = await storage.getSetting(UNIT_AUDIT_STORE_SETTING_KEY).catch(() => undefined);
  const persistedActive = findActiveUnitAuditJob(parseUnitAuditStore(raw ?? null), propertyId);
  if (persistedActive && !jobs.has(persistedActive.jobId)) {
    jobs.set(persistedActive.jobId, persistedActive);
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
  source?: "manual" | "cron";
}): Promise<{ started: UnitAuditJobRecord[]; skipped: Array<{ propertyId: number; error: string }> }> {
  const ids = Array.from(new Set((input.propertyIds ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n !== 0))).slice(0, 40);
  const started: UnitAuditJobRecord[] = [];
  const skipped: Array<{ propertyId: number; error: string }> = [];
  for (const propertyId of ids) {
    const result = await startUnitAuditSweep({ propertyId, autoFix: input.autoFix, allowReplace: input.allowReplace, source: input.source });
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
