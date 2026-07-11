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
import { getUnitBuilderByPropertyId } from "../client/src/data/unit-builder-data";
import { parseStreetCityState } from "@shared/address-listing-logic";
import { resolveDraftUnitBedrooms } from "@shared/draft-unit-bedrooms";
import { findDescriptionPlaceholders, AREA_SECTION_HEADERS, DESCRIPTION_OVERRIDE_FIELDS } from "@shared/description-copy";
import { isPlaceholderLicenseValue, usableLicenseValue } from "@shared/license-compliance";
import { COVER_COLLAGE_SETTING_KEY, COVER_COLLAGE_DISK_FOLDER } from "@shared/cover-collage-logic";
import { GUESTY_PUSH_NAME_ALIASES, GUESTY_UNSUPPORTED_AMENITY_KEYS, getAmenityLabel } from "@shared/guesty-amenity-catalog";
import { computeMarketRateMatchConfirmation } from "@shared/market-rate-match-confirmation";
import { isCuratedBuyInMarket } from "@shared/buy-in-market";
import {
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
import { buildPhotoCommunityCheckRequestForProperty } from "./builder-photo-groups";
import { scanForDuplicatePhotos, type DedupeScanGroupInput } from "./photo-dedupe";
import type { PhotoCommunityCheckResult } from "./photo-community-check";
import { loopbackRequestHeaders } from "./auth";
import { storage } from "./storage";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

// Per-stage ceilings. The two long legs (community check, OTA deep scan) are
// bounded generously; everything else is reads + one Guesty GET.
const STAGE_TIMEOUT_MS: Record<UnitAuditStageId, number> = {
  resolve: 60_000,
  "photo-dedupe": 6 * 60_000,
  "photo-community": 18 * 60_000,
  "ota-scan": 16 * 60_000,
  descriptions: 60_000,
  amenities: 90_000,
  "cover-collage": 30_000,
  layout: 90_000,
  pricing: 60_000,
  channels: 90_000,
};

// How fresh an existing photo_listing_checks row must be for the OTA stage to
// reuse it instead of kicking a new deep scan (each deep scan is real Lens +
// SERP spend; the weekly cron refreshes rows anyway).
const OTA_FRESH_HOURS = Number(process.env.AUDIT_OTA_FRESH_HOURS ?? "24");
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

async function loopbackJson(method: "GET" | "POST", pathName: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: any }> {
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

type UnitAuditTarget = {
  propertyId: number;
  isDraft: boolean;
  propertyName: string;
  communityName: string;
  city?: string;
  state?: string;
  guestyListingId: string | null;
  groups: AuditPhotoGroup[];
  expectedListingBedrooms: number | null;
  unitBedroomSizes: number[];
  bathroomsTotal: number | null;
  maxGuestsTotal: number | null;
  licenses: Record<string, string | undefined> | null;
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
      city: parsed.city || undefined,
      state: parsed.state || undefined,
      guestyListingId: mapRow?.guestyListingId ?? null,
      groups,
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
  return {
    propertyId,
    isDraft: true,
    propertyName: (draft as any).listingTitle || draft.name,
    communityName: draft.name,
    city: (draft as any).city || undefined,
    state: (draft as any).state || undefined,
    guestyListingId: mapRow?.guestyListingId ?? null,
    groups,
    expectedListingBedrooms: built?.request.expectedListingBedrooms ?? ((u1 + u2) || null),
    unitBedroomSizes: Array.from(new Set([u1, u2].filter((n) => n > 0))),
    bathroomsTotal: bathroomsKnown ? bathroomsParts.reduce((s: number, n) => s + (n ?? 0), 0) : null,
    maxGuestsTotal: null,
    // Draft license fields live in the builder Compliance flow, not on the
    // draft row — the channels stage reports that honestly instead of
    // pretending to have checked them.
    licenses: null,
  };
}

// In-memory only (rebuilt on resume): jobId → resolved target.
const targets = new Map<string, UnitAuditTarget>();

// ── Stage implementations (verify-only) ──────────────────────────────────────

type StageOutcome = { verdict: UnitAuditStageVerdict; detail: string; items?: string[] };

function unitGroups(target: UnitAuditTarget): AuditPhotoGroup[] {
  return target.groups.filter((g) => g.role === "unit");
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
  if (unitGroups(target).length === 0) {
    return { verdict: "attention", detail: "Resolved, but no unit photo folders have published photos — the photo stages cannot verify anything.", items };
  }
  return {
    verdict: target.guestyListingId ? "pass" : "attention",
    detail: `${target.propertyName} · ${target.communityName}${target.expectedListingBedrooms ? ` · ${target.expectedListingBedrooms}BR listing` : ""} · ${target.groups.length} photo folder${target.groups.length === 1 ? "" : "s"} resolved`,
    items,
  };
}

async function stagePhotoDedupe(target: UnitAuditTarget): Promise<StageOutcome> {
  if (target.groups.length === 0) {
    return { verdict: "error", detail: "No published photos found — nothing to scan for duplicates." };
  }
  const groups: DedupeScanGroupInput[] = target.groups.map((g) => ({
    folder: g.folder,
    label: g.label,
    filenames: g.filenames,
    captions: g.captions,
  }));
  const proposal = await scanForDuplicatePhotos(groups);
  const allGroups = proposal.folders.flatMap((f) => f.groups.map((grp) => ({ ...grp, folderLabel: f.label || f.folder })));
  const exact = allGroups.filter((g) => g.kind === "exact" || g.kind === "near");
  const sameScene = allGroups.filter((g) => g.kind === "same-scene");
  const items: string[] = [];
  for (const g of allGroups) {
    const files = g.members.map((m: any) => m.filename).slice(0, 6).join(", ");
    items.push(`${g.folderLabel}: ${g.kind} group of ${g.members.length} (${files}${g.members.length > 6 ? ", …" : ""})`);
  }
  if (proposal.note) items.push(proposal.note);
  if (allGroups.length === 0) {
    return {
      verdict: "pass",
      detail: `No duplicates found across ${target.groups.length} folder${target.groups.length === 1 ? "" : "s"}${proposal.visionUsed ? " (hash + AI same-scene scan)" : " (hash-only scan)"}.`,
      items: proposal.note ? [proposal.note] : undefined,
    };
  }
  return {
    verdict: "attention",
    detail: `${exact.length} exact/near duplicate group${exact.length === 1 ? "" : "s"} + ${sameScene.length} same-scene group${sameScene.length === 1 ? "" : "s"} (${proposal.removableCount} removable photo${proposal.removableCount === 1 ? "" : "s"}) — review with 🧹 Scan photos & remove duplicates on the Photos tab.`,
    items,
  };
}

async function stagePhotoCommunity(target: UnitAuditTarget, record: UnitAuditJobRecord): Promise<StageOutcome> {
  if (unitGroups(target).length === 0 && !target.groups.some((g) => g.role === "community")) {
    return { verdict: "error", detail: "No published photos — the community/bedroom check cannot run." };
  }
  touch(record, { message: "Running the full photo community check (Google Lens + Claude vision — this is the long stage)…" });
  const { status, data } = await loopbackJson(
    "POST",
    "/api/builder/photo-community-check",
    { propertyId: target.propertyId },
    STAGE_TIMEOUT_MS["photo-community"] - 30_000,
  );
  if (status >= 400 || data?.ok === false) {
    return { verdict: "error", detail: `Community check could not run: ${String(data?.error ?? `HTTP ${status}`)}` };
  }
  const result = data as PhotoCommunityCheckResult;
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
    detail: result.summary || `Community check verdict: ${result.verdict}`,
    items,
  };
}

function otaRowFresh(row: { checkedAt: Date | string | null } | undefined, nowMs: number): boolean {
  if (!row?.checkedAt) return false;
  const t = new Date(row.checkedAt as any).getTime();
  return Number.isFinite(t) && nowMs - t <= OTA_FRESH_HOURS * 3600_000;
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
  const stale = folders.filter((f) => !otaRowFresh(rows.get(f.folder), kickStart));
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

async function stageDescriptions(target: UnitAuditTarget): Promise<StageOutcome> {
  const overridesRow = await storage.getPropertyDescriptionOverrides(target.propertyId).catch(() => undefined);
  const overrides: Record<string, string> = {};
  for (const field of DESCRIPTION_OVERRIDE_FIELDS) {
    const v = String((overridesRow as any)?.[field] ?? "").trim();
    if (v) overrides[field] = v;
  }
  const fields: Record<string, string | null | undefined> = { ...overrides };
  let baseSummary = "";
  if (target.isDraft) {
    const draft = await storage.getCommunityDraft(-target.propertyId).catch(() => undefined);
    baseSummary = String((draft as any)?.description ?? "");
    fields["draft description"] = baseSummary;
    fields["Unit A description"] = String((draft as any)?.unit1Description ?? "");
    if ((draft as any)?.singleListing !== true) fields["Unit B description"] = String((draft as any)?.unit2Description ?? "");
    fields["listing title"] = String((draft as any)?.listingTitle ?? "");
  } else {
    const builder = getUnitBuilderByPropertyId(target.propertyId);
    baseSummary = String(builder?.combinedDescription ?? "");
    fields["combined description"] = baseSummary;
    builder?.units.forEach((u, i) => {
      fields[`Unit ${String.fromCharCode(65 + i)} description`] = [u.shortDescription, u.longDescription].filter(Boolean).join(" ");
    });
  }

  const items: string[] = [];
  const placeholderHits = findDescriptionPlaceholders(fields);
  for (const hit of placeholderHits) items.push(`${hit.field}: placeholder scaffolding ("${hit.phrase.slice(0, 60)}…")`);

  const effectiveSummary = overrides.summary || baseSummary;
  const embeddedHeaders = AREA_SECTION_HEADERS.filter((h) => effectiveSummary.toUpperCase().includes(h));
  if (embeddedHeaders.length > 0) {
    items.push(`Summary embeds ${embeddedHeaders.join(" + ")} section${embeddedHeaders.length === 1 ? "" : "s"} — these push as their own OTA fields and would duplicate; use ↻ Regenerate descriptions`);
  }
  if (!effectiveSummary.trim()) items.push("Summary/description is EMPTY");

  const overrideNote = Object.keys(overrides).length > 0
    ? `${Object.keys(overrides).length} operator-edited override${Object.keys(overrides).length === 1 ? "" : "s"} (✎) in effect`
    : "no manual overrides — generated copy in effect";

  if (placeholderHits.length > 0) {
    return {
      verdict: "failed",
      detail: `Placeholder scaffolding in ${new Set(placeholderHits.map((h) => h.field)).size} field(s) — the Guesty push guard would reject this; run ↻ Regenerate descriptions on the Descriptions tab.`,
      items,
    };
  }
  if (embeddedHeaders.length > 0 || !effectiveSummary.trim()) {
    return { verdict: "attention", detail: "Description copy needs cleanup — see the findings below.", items };
  }
  return {
    verdict: "pass",
    detail: `No placeholder copy · summary ${effectiveSummary.trim().length} chars · ${overrideNote}.`,
    items: items.length > 0 ? items : undefined,
  };
}

async function stageAmenities(target: UnitAuditTarget): Promise<StageOutcome> {
  const row = await storage.getPropertyAmenities(target.propertyId).catch(() => undefined);
  const keys: string[] = Array.isArray(row?.amenityKeys) ? (row!.amenityKeys as string[]) : [];
  if (!row || keys.length === 0) {
    return {
      verdict: "attention",
      detail: "No amenity set saved in-system — run 🔎 Scan photos for amenities on the Amenities tab (fills the Hawaii baseline + AI-detected extras).",
    };
  }
  const items: string[] = [];
  const scannedNote = row.scannedAt
    ? `last scanned ${new Date(row.scannedAt as any).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "saved manually (never AI-scanned)";
  items.push(`${keys.length} amenities saved in-system (source: ${row.source ?? "unknown"}, ${scannedNote})`);
  if (!row.scannedAt) items.push("Run the AI amenity scan to catch photo-visible + nearby-area amenities");

  if (!target.guestyListingId) {
    return {
      verdict: row.scannedAt ? "pass" : "attention",
      detail: `${keys.length} amenities saved in-system (${scannedNote}) — no Guesty listing yet, push happens automatically when one is connected.`,
      items,
    };
  }
  const { status, data } = await loopbackJson("GET", `/api/guesty-proxy/listings/${encodeURIComponent(target.guestyListingId)}?fields=${encodeURIComponent("amenities")}`, undefined, 30_000)
    .catch((e) => ({ status: 599, data: { error: String(e?.message ?? e) } }));
  if (status >= 400) {
    items.push(`Could not read the Guesty listing's amenities (HTTP ${status})`);
    return { verdict: "error", detail: "Amenities are saved in-system but the Guesty listing could not be read to confirm they were pushed.", items };
  }
  const guestyNames = new Set<string>((Array.isArray(data?.amenities) ? data.amenities : []).map((a: unknown) => String(a).trim().toLowerCase()));
  const missing = keys.filter((k) => {
    if (GUESTY_UNSUPPORTED_AMENITY_KEYS.has(k)) return false; // no truthful Guesty equivalent (delivered via Other)
    const pushName = (GUESTY_PUSH_NAME_ALIASES[k] ?? getAmenityLabel(k)).trim().toLowerCase();
    return !guestyNames.has(pushName);
  });
  if (missing.length > 0) {
    items.push(`Missing from the Guesty listing: ${missing.slice(0, 10).map((k) => getAmenityLabel(k)).join(", ")}${missing.length > 10 ? ` +${missing.length - 10} more` : ""}`);
    return {
      verdict: "attention",
      detail: `${missing.length} saved amenit${missing.length === 1 ? "y is" : "ies are"} not on the Guesty listing — push amenities from the Amenities tab (add-only).`,
      items,
    };
  }
  const unsupportedCount = keys.filter((k) => GUESTY_UNSUPPORTED_AMENITY_KEYS.has(k)).length;
  return {
    verdict: row.scannedAt ? "pass" : "attention",
    detail: `All ${keys.length - unsupportedCount} Guesty-supported amenities are on the listing (${guestyNames.size} total on Guesty)${unsupportedCount > 0 ? ` · ${unsupportedCount} with no Guesty equivalent (Other-bucket/description class)` : ""} · ${scannedNote}.`,
    items,
  };
}

async function stageCoverCollage(target: UnitAuditTarget): Promise<StageOutcome> {
  if (!target.guestyListingId) {
    return { verdict: "skipped", detail: "No Guesty listing mapped — the cover collage is generated + pinned when a listing exists." };
  }
  const raw = await storage.getSetting(COVER_COLLAGE_SETTING_KEY).catch(() => undefined);
  let recordRow: any = null;
  try { recordRow = raw ? (JSON.parse(raw) as Record<string, any>)[target.guestyListingId] ?? null : null; } catch { recordRow = null; }
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
    verdict: "pass",
    detail: `AI cover collage on file and pushed to Guesty (pinned first)${recordRow.method === "vision" ? "" : " — heuristic pick, consider re-running for a Claude-vision pick"}.`,
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
  if (mismatch) {
    return { verdict: "failed", detail: "Guesty bedroom count does not match the system unit config — guests are filtering on the wrong layout.", items };
  }
  if (soft) {
    return { verdict: "attention", detail: "Layout numbers partially disagree with Guesty — review the Bedding tab.", items };
  }
  return { verdict: "pass", detail: "Guesty layout matches the system config (bedrooms/bathrooms/sleeps).", items };
}

async function stagePricing(target: UnitAuditTarget): Promise<StageOutcome> {
  const schedule = await storage.getScannerSchedule(target.propertyId).catch(() => undefined);
  const rates = await storage.getPropertyMarketRates(target.propertyId).catch(() => []);
  const items: string[] = [];
  let verdict: UnitAuditStageVerdict = "pass";
  const bump = (v: UnitAuditStageVerdict) => {
    const rank: Record<string, number> = { pass: 0, fixed: 0, skipped: 0, attention: 1, error: 2, failed: 3 };
    if (rank[v] > rank[verdict]) verdict = v;
  };

  const sizes = target.unitBedroomSizes;
  const rateSizes = new Set(rates.map((r: any) => Number(r.bedrooms)));
  const missingSizes = sizes.filter((s) => !rateSizes.has(s));
  if (rates.length === 0) {
    bump("attention");
    items.push("No market-rate pricing table — run Update market pricing (dashboard queue or the Pricing tab)");
  } else if (missingSizes.length > 0) {
    bump("attention");
    items.push(`No market-rate row for ${missingSizes.map((s) => `${s}BR`).join(", ")} — the push would miss those units`);
  } else if (sizes.length > 0) {
    items.push(`Market-rate rows cover the listing's unit sizes (${sizes.map((s) => `${s}BR`).join(" + ")})`);
  }

  const pushedAt = schedule?.lastGuestyRatePushAt ? new Date(schedule.lastGuestyRatePushAt as any).getTime() : null;
  const pushStatus = (schedule as any)?.lastGuestyRatePushStatus ?? null;
  if (!pushedAt) {
    bump("attention");
    items.push("Rates have never been pushed to Guesty for this property");
  } else {
    const days = Math.floor((Date.now() - pushedAt) / 86_400_000);
    if (pushStatus === "error") {
      bump("failed");
      items.push(`Last Guesty rate push FAILED ${days}d ago: ${(schedule as any)?.lastGuestyRatePushSummary ?? "see the Last Price Scan column"}`);
    } else if (pushStatus === "seed") {
      bump("attention");
      items.push(`Only a seeded backfill stamp exists (${days}d ago) — no real push yet`);
    } else if (days > PRICING_STALE_DAYS) {
      bump("attention");
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
    else { bump("attention"); items.push(`Match confirmation RED: ${confirmation.headline || "research may not match this community/bedrooms"} — re-run the market-rate scan`); }
  } else if (rates.length > 0) {
    items.push("No research evidence stored on the pricing rows (older scan) — re-running Update market pricing stamps it");
  }

  const detail = verdict === "pass"
    ? `Pricing table fresh + pushed · ${items.find((i) => i.startsWith("Match confirmation")) ?? "rates verified"}`
    : items.find((i) => /FAILED|never been pushed|stale|No market-rate|RED|AMBER|seeded/.test(i)) ?? "Pricing needs review.";
  return { verdict, detail, items };
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
      : stageId === "photo-dedupe" ? stagePhotoDedupe(target!)
      : stageId === "photo-community" ? stagePhotoCommunity(target!, record)
      : stageId === "ota-scan" ? stageOtaScan(target!, record)
      : stageId === "descriptions" ? stageDescriptions(target!)
      : stageId === "amenities" ? stageAmenities(target!)
      : stageId === "cover-collage" ? stageCoverCollage(target!)
      : stageId === "layout" ? stageLayout(target!)
      : stageId === "pricing" ? stagePricing(target!)
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

async function runUnitAuditJob(record: UnitAuditJobRecord): Promise<void> {
  if (activeJobIds.has(record.jobId)) return;
  activeJobIds.add(record.jobId);
  try {
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
    activeJobIds.delete(record.jobId);
    cancelRequested.delete(record.jobId);
    targets.delete(record.jobId);
  }
}

// ── Public API (routes) ──────────────────────────────────────────────────────

export async function startUnitAuditSweep(input: { propertyId: number }): Promise<
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
  };
  jobs.set(record.jobId, record);
  await mutateStore((store) => { store[record.jobId] = { ...record }; });
  void runUnitAuditJob(record);
  return { ok: true, job: record };
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
