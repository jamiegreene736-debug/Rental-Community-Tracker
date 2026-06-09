// ─────────────────────────────────────────────────────────────────────────────
// Server-side "Auto-fill cheapest" background job.
//
// WHY THIS EXISTS (see AGENTS.md Load-Bearing "Auto-fill cheapest is a
// server-side background job"): the bookings-page "Auto-fill cheapest" button
// used to run the ENTIRE escalation ladder + the buy-in attach client-side
// inside a React mutation (bookings.tsx autoFillMutation). The heavy search
// primitives (find-buy-in, city-vrbo-inventory, the nearby-city expansion job)
// were already server-side, but the LADDER and the ATTACH calls lived in the
// component. So leaving the bookings page (in-app navigation, tab close, mobile
// suspend) unmounted the component, abandoned the in-flight promise chain, and
// any stage that hadn't finished NEVER attached. The operator had to babysit
// the tab.
//
// This module moves the whole flow server-side as a fire-and-forget job
// (modeled on server/preflight-background-jobs.ts + server/city-vrbo-expansion.ts):
// once started, Railway orchestrates and the operator's LOCAL Chrome sidecar
// keeps processing the queue regardless of the browser tab. Each pick is
// attached to Postgres as it's found, so returning to the page shows filled
// slots even if the operator walked away the instant they clicked the button.
//
// The worker drives the SAME endpoints the client used, via in-process loopback
// self-calls (127.0.0.1 bypasses the ADMIN_SECRET gate — see server/auth.ts and
// the loopback precedent in preflight-background-jobs.ts), so it reuses 100% of
// the existing multi-channel search + diagnostics + attach-validation logic
// without extracting the 4,000-line find-buy-in handler.
// ─────────────────────────────────────────────────────────────────────────────

import { loopbackRequestHeaders } from "./auth";
import { storage } from "./storage";
import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import { evaluateComboProfit, profitToleranceUsd } from "@shared/buy-in-profit";
import type { CityVrboCoverage } from "@shared/city-vrbo-coverage";
import {
  getExpansionJob,
  serializeExpansionJob,
  startExpansionJob,
  CityExpansionValidationError,
  type CityExpansionJobStatus,
  type ExpansionCityResult,
} from "./city-vrbo-expansion";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

// find-buy-in enforces a ~270s route budget; allow a little headroom over
// loopback (no edge proxy in the path, so this is the only ceiling).
const FIND_BUY_IN_LOOPBACK_TIMEOUT_MS = 300_000;
const CITY_VRBO_LOOPBACK_TIMEOUT_MS = 300_000;
// A completed job is kept this long so a returning client can still poll the
// final result; running jobs are kept longer (worst case = a multi-tier
// expansion sweep). Jobs are in-memory and lost on redeploy — that's fine
// because every pick is persisted to Postgres the moment it attaches.
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const EXPANSION_POLL_INTERVAL_MS = 3_000;
const EXPANSION_POLL_CAP_MS = 40 * 60_000;
// Profit-gate tuning (env-overridable): accept a combo when
// profit >= -max(FLAT, PCT * revenue). HARD max-loss limit of $100 (operator,
// 2026-06-08): match a combo as long as it loses <= $100, reject beyond. Flat
// (pct 0) so the cap is uniform across stay sizes — see shared/buy-in-profit.ts.
const PROFIT_MIN_FLAT_USD = Number(process.env.AUTOFILL_PROFIT_MIN_FLAT ?? 100) || 0;
const PROFIT_MIN_PCT = Number(process.env.AUTOFILL_PROFIT_MIN_PCT ?? 0) || 0;

// ── types ────────────────────────────────────────────────────────────────────
type JobStatus = "queued" | "running" | "completed" | "failed";

export type AutoFillStageStatus = "idle" | "searching" | "found" | "no-pair" | "skipped";

export type AutoFillSlotInput = {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
  community?: string | null;
};

export type StartAutoFillInput = {
  reservationId: string;
  propertyId: number;
  listingId?: string | null;
  propertyName: string;
  community?: string | null;
  checkIn: string;
  checkOut: string;
  slots: AutoFillSlotInput[];
  // Bedrooms that require a ground-floor unit (the client derives this from the
  // Guesty conversation scan and passes it through so the server job stays a
  // dumb orchestrator).
  groundFloorBedrooms?: number[];
  // The booking's net revenue (client getNetRevenue: hostPayout -> netIncome ->
  // fareAccommodation -> totalPaid), so the profit gate matches the bookings-page
  // number. When <= 0 / omitted (manual reservations, inquiries) the profit gate
  // is DISABLED and attach behaves as before.
  expectedRevenue?: number;
  silent?: boolean;
  // Bulk-queue fresh re-run: supersede (cancel) any in-flight job for this
  // reservation and start a NEW one instead of reusing it. The bulk path detaches
  // the reservation's units before this POST, so a reused job would carry a stale
  // existingAttachedCost baseline AND its old (smaller) slot set — leaving a
  // detached slot unfilled. forceRestart guarantees the fresh job reads the
  // post-detach DB (baseline 0) and the full slot set. See AGENTS.md #8.
  forceRestart?: boolean;
  // Who started this job. Bulk-queue jobs set owner="bulk" so the row-level
  // /active rediscovery (getActiveAutoFillJobForReservation with excludeBulk)
  // does NOT re-attach a competing row poller — that would race the bulk
  // orchestrator's single-flight and could forceRestart it mid-search. See
  // AGENTS.md "Bulk buy-in queue is a SERVER-SIDE background job" (B1).
  owner?: "row" | "bulk";
};

// Per-city economics recorded by the profit gate (resort, home-city, and each
// nearby city), so the operator sees what each city offered even when nothing
// was profitable enough to attach.
export type CityEconomics = {
  source: AttachStage;
  label: string;
  comboCost: number;
  expectedProfit: number;
  accepted: boolean;
  reason?: string;
};

type AttachStage = "resort" | "home-city" | "nearby" | "single-unit-city";

export type AutoFillAttached = {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
  buyInId: number | null;
  title: string;
  sourceLabel: string;
  url: string;
  totalPrice: number;
  airbnbPick: boolean;
  stage: AttachStage;
};

export type AutoFillSkipped = { unitId: string; unitLabel: string; reason: string };

type AutoFillEscalation = {
  resort: AutoFillStageStatus;
  resortLabel?: string;
  homeCity: AutoFillStageStatus;
  homeCityTerm?: string;
  homeCityListings?: number;
  // Found-vs-usable-vs-VRBO-total breakdown for the home-city scan, so the
  // tracker shows the tool captured ~all inventory and the lower "usable" count
  // is the (correct) >=2BR filter — not missing listings.
  homeCityCoverage?: CityVrboCoverage;
  foundAt?: "resort" | "home-city" | "nearby" | null;
  nearbyStatus?: "searching" | "found" | "exhausted" | "worker_offline" | "error";
  tierResults?: ExpansionCityResult[];
};

type AutoFillSearchAudit = {
  bedrooms: number;
  generatedAt: string;
  counts: {
    bedrooms: number;
    scanned: number;
    priced: number;
    sourceCounts: { airbnb: number; vrbo: number; booking: number; pm: number };
    kept: number;
    targetFiltered: number;
    groundFloorOnly: boolean;
  };
  candidates: any[];
  diagnostics?: any;
};

type AutoFillJob = {
  id: string;
  status: JobStatus;
  phase: string;
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  reservationId: string;
  propertyId: number;
  listingId: string | null;
  propertyName: string;
  community: string | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  slots: AutoFillSlotInput[];
  groundFloorBedrooms: Set<number>;
  silent: boolean;
  // Profit gate (computed once at start).
  expectedRevenue: number;
  existingAttachedCost: number;
  revenueAvailable: number;
  minProfit: number;
  gateEnabled: boolean;
  escalation: AutoFillEscalation;
  attached: AutoFillAttached[];
  skipped: AutoFillSkipped[];
  searchAudits: AutoFillSearchAudit[];
  comboOptions: any[];
  cityEconomics: CityEconomics[];
  totalCost: number | null;
  error: string | null;
  canceled: boolean;
  // "bulk" when started by the server-side bulk queue, "row" (default) for a
  // direct "Auto-fill cheapest" click. Lets row-level rediscovery skip bulk jobs.
  owner: "row" | "bulk";
};

export type AutoFillJobStatus = {
  jobId: string;
  status: JobStatus;
  done: boolean;
  phase: string;
  message: string;
  progress: number;
  reservationId: string;
  escalation: AutoFillEscalation;
  attached: AutoFillAttached[];
  skipped: AutoFillSkipped[];
  searchAudits: AutoFillSearchAudit[];
  comboOptions: any[];
  cityEconomics: CityEconomics[];
  slotsTotal: number;
  slotsFilled: number;
  totalCost: number | null;
  expectedRevenue: number;
  expectedProfit: number | null;
  error: string | null;
  timestamps: { createdAt: number; startedAt: number | null; finishedAt: number | null };
};

export class AutoFillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoFillValidationError";
  }
}

// ── stores ─────────────────────────────────────────────────────────────────
const autoFillJobs = new Map<string, AutoFillJob>();
// reservationId -> live jobId (single-flight: one auto-fill job per reservation).
const activeJobByReservation = new Map<string, string>();
// reservationId -> MOST-RECENT jobId (kept after the job finalizes, unlike
// activeJobByReservation). Lets the bookings page re-show the last search's
// loss-combo economics after the operator closes the bulk-queue dialog. Bounded
// by JOB_TTL_MS via cleanupStaleJobs (the job itself is evicted at 2h).
const lastJobByReservation = new Map<string, string>();
const activeJobIds = new Set<string>();

const TERMINAL = new Set<JobStatus>(["completed", "failed"]);
const isTerminal = (s: JobStatus) => TERMINAL.has(s);

function cleanupStaleJobs(): void {
  const now = Date.now();
  for (const [id, job] of Array.from(autoFillJobs.entries())) {
    const ref = job.finishedAt ?? job.updatedAt;
    if (now - ref > JOB_TTL_MS) {
      autoFillJobs.delete(id);
      if (activeJobByReservation.get(job.reservationId) === id) {
        activeJobByReservation.delete(job.reservationId);
      }
    }
  }
}
setInterval(cleanupStaleJobs, 30 * 60_000).unref?.();

// ── identity dedup (ported VERBATIM from client/src/pages/bookings.tsx so the
// server's across-slot de-dup matches the client's exactly — see AGENTS.md
// adversarial review; the server's looser buyInIdentityKeys is only a backstop). ──
function listingUrlKey(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [
      "checkin", "checkout", "check_in", "check_out", "arrival", "departure",
      "startDate", "endDate", "adults", "group_adults",
    ]) {
      u.searchParams.delete(key);
    }
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return String(url).split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function normalizedIdentityText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function imageUrlKey(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return String(url).split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function isGenericRentalTitle(title: string): boolean {
  const t = normalizedIdentityText(title);
  if (!t) return true;
  if (/^(?:condo|apartment|townhouse|home|house|villa|rental unit|guest suite|loft|cottage|bungalow|place)\s+in\s+[a-z ]+$/.test(t)) return true;
  if (/^(?:beautiful|lovely|spacious|modern|luxury|elegant)?\s*(?:\d+\s*(?:br|bedroom)\s*)?(?:condo|apartment|townhouse|home|house|villa|rental)$/.test(t)) return true;
  return false;
}

type IdentityItem = {
  url?: string | null;
  sourceLabel?: string | null;
  title?: string | null;
  image?: string | null;
  airbnbAnchorUrl?: string | null;
  alternateUrls?: Array<string | null | undefined>;
  photoMatches?: Array<{ url?: string | null }>;
  identityKeys?: Array<string | null | undefined>;
};

function listingIdentityKeys(item: IdentityItem): string[] {
  const keys = new Set<string>();
  for (const identityKey of item.identityKeys ?? []) if (identityKey) keys.add(identityKey);
  const urlKey = listingUrlKey(item.url);
  if (urlKey) keys.add(`url:${urlKey}`);
  const anchorKey = listingUrlKey(item.airbnbAnchorUrl);
  if (anchorKey) keys.add(`url:${anchorKey}`);
  for (const alternateUrl of item.alternateUrls ?? []) {
    const alternateKey = listingUrlKey(alternateUrl);
    if (alternateKey) keys.add(`url:${alternateKey}`);
  }
  const imgKey = imageUrlKey(item.image);
  if (imgKey) keys.add(`image:${imgKey}`);
  const titleKey = normalizedIdentityText(item.title);
  if (titleKey.length >= 12 && !isGenericRentalTitle(titleKey)) keys.add(`title:${titleKey}`);
  const labelKey = normalizedIdentityText(item.sourceLabel);
  const labelLooksUnitSpecific = /\b(?:unit|apt|suite|condo|villa|regency|#)?\s*\d{2,4}\b/.test(labelKey);
  if (labelKey.length >= 12 && labelLooksUnitSpecific && !isGenericRentalTitle(labelKey)) keys.add(`label:${labelKey}`);
  for (const match of item.photoMatches ?? []) {
    const matchKey = listingUrlKey(match.url);
    if (matchKey) keys.add(`url:${matchKey}`);
  }
  return Array.from(keys);
}

function hasUsedListingIdentity(used: Set<string>, item: IdentityItem): boolean {
  return listingIdentityKeys(item).some((key) => used.has(key));
}

function addUsedListingIdentity(used: Set<string>, item: IdentityItem): void {
  for (const key of listingIdentityKeys(item)) used.add(key);
}

// Mirror of the client titleFromBuyInNotes — used to seed the used-identity set
// from sibling slots already attached when the job starts.
function titleFromBuyInNotes(notes: string | null | undefined): string {
  const raw = String(notes ?? "");
  const autoFilled = raw.match(/(?:Auto-filled from|Bought via)\s+[^—-]+[—-]\s*([^·]+)/i);
  if (autoFilled?.[1]) return autoFilled[1].trim();
  const firstClause = raw.split(" · ")[0] ?? raw;
  const dash = firstClause.indexOf(" — ");
  if (dash >= 0) return firstClause.slice(dash + 3).trim();
  return "";
}

const MANUAL_BUY_IN_PHOTO_MARKER = "Manual photo URLs:";
// Build the trailing "Manual photo URLs:" marker (AGENTS.md Load-Bearing #1: it
// MUST be last in the notes — manualBuyInPhotoUrlsFromNotes parses every URL
// after it). Only NEW attaches get the marker, matching the client.
function buyInPhotoNotesSuffix(photos: Array<string | null | undefined>): string {
  const urls = Array.from(new Set(
    photos.map((u) => String(u ?? "").trim()).filter((u) => /^https?:\/\/\S+$/i.test(u)),
  )).slice(0, 12);
  return urls.length ? ` · ${MANUAL_BUY_IN_PHOTO_MARKER} ${urls.join(" ")}` : "";
}

// ── helpers ──────────────────────────────────────────────────────────────────
function newJobId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(1, Math.round(
    (new Date(`${checkOut}T12:00:00`).getTime() - new Date(`${checkIn}T12:00:00`).getTime()) / 86_400_000,
  ));
}

function touch(job: AutoFillJob, patch: Partial<AutoFillJob> = {}): void {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

function setEscalation(job: AutoFillJob, patch: Partial<AutoFillEscalation>): void {
  job.escalation = { ...job.escalation, ...patch };
  touch(job);
}

function finalize(job: AutoFillJob): void {
  if (job.finishedAt == null) job.finishedAt = Date.now();
  if (activeJobByReservation.get(job.reservationId) === job.id) {
    activeJobByReservation.delete(job.reservationId);
  }
  touch(job);
}

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const resp = await fetch(url, {
    method: "GET",
    headers: loopbackRequestHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || data?.message || `HTTP ${resp.status}`);
  return data;
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; data: any }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: loopbackRequestHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

type LiveCandidate = {
  source: string;
  sourceLabel: string;
  title: string;
  url: string;
  nightlyPrice: number;
  totalPrice: number;
  bedrooms?: number | null;
  image?: string | null;
  images?: string[];
  lat?: number | null;
  lng?: number | null;
  alternateUrls?: string[];
  verified?: string;
  verifiedReason?: string;
  airbnbAnchorUrl?: string | null;
  airbnbAnchorPrice?: number | null;
  groundFloorStatus?: string | null;
  groundFloorEvidence?: string | null;
  unitTypeConfidence?: number;
  unitTypeConfidenceBreakdown?: any;
};

function bedroomFromCandidateText(c: { title?: string; snippet?: string; url?: string }): number | null {
  const text = `${c.title ?? ""} ${c.snippet ?? ""} ${c.url ?? ""}`.toLowerCase();
  const direct = text.match(/(?:^|[\W_])(\d+)\s*(?:br|bd|bdr|bedrooms?)(?=$|[\W_])/);
  if (direct) return parseInt(direct[1], 10);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  for (const [word, count] of Object.entries(words)) {
    if (new RegExp(`\\b${word}[\\s-]bedroom\\b`).test(text)) return count;
  }
  return null;
}

function candidateBedrooms(c: LiveCandidate, fallback: number): number {
  const explicit = bedroomFromCandidateText(c);
  if (explicit !== null) return explicit;
  return typeof c.bedrooms === "number" && Number.isFinite(c.bedrooms) ? c.bedrooms : fallback;
}

// Map a find-buy-in response's cheapestUnits clusters into ranked candidates —
// mirrors the client getCandidatePool: one cheapest verified (or Airbnb) listing
// per physical unit, cheapest-first.
function candidatesFromFindBuyIn(data: any): LiveCandidate[] {
  // unitTypeConfidence lives on the flat `cheapest` items; index by url so the
  // candidate carries it (the attach route's combo-confidence gate reads it).
  const confByUrl = new Map<string, number>();
  for (const c of data?.cheapest ?? []) {
    if (c?.url && typeof c.unitTypeConfidence === "number") confByUrl.set(listingUrlKey(c.url), c.unitTypeConfidence);
  }
  const out: LiveCandidate[] = [];
  for (const unit of data?.cheapestUnits ?? []) {
    const listing = [...(unit.listings ?? [])]
      .filter((l: any) => (l.totalPrice ?? 0) > 0)
      .filter((l: any) => l.channel === "airbnb" || l.verified === "yes")
      .sort((a: any, b: any) => {
        const aRank = a.verified === "yes" ? 0 : 1;
        const bRank = b.verified === "yes" ? 0 : 1;
        if (aRank !== bRank) return aRank - bRank;
        return (a.totalPrice || 999999) - (b.totalPrice || 999999);
      })[0];
    if (!listing) continue;
    const alternateUrls = (unit.listings ?? []).map((l: any) => l.url).filter(Boolean);
    out.push({
      source: listing.channel,
      sourceLabel: listing.channelLabel ?? listing.channel,
      title: unit.unitTitle,
      url: listing.url,
      nightlyPrice: listing.nightlyPrice ?? 0,
      totalPrice: listing.totalPrice ?? 0,
      bedrooms: listing.bedrooms ?? unit.bedrooms,
      image: unit.image,
      images: unit.image ? [unit.image] : undefined,
      lat: listing.lat ?? unit.lat,
      lng: listing.lng ?? unit.lng,
      alternateUrls,
      verified: listing.verified,
      verifiedReason: listing.verifiedReason,
      airbnbAnchorUrl: listing.airbnbAnchorUrl,
      airbnbAnchorPrice: listing.airbnbAnchorPrice,
      groundFloorStatus: listing.groundFloorStatus ?? unit.groundFloorStatus,
      groundFloorEvidence: listing.groundFloorEvidence ?? unit.groundFloorEvidence,
      unitTypeConfidence: confByUrl.get(listingUrlKey(listing.url)),
    });
  }
  out.sort((a, b) => (a.totalPrice || 999999) - (b.totalPrice || 999999));
  return out;
}

function liveCandidateFromCityRow(row: any, bedrooms: number, nights: number): LiveCandidate {
  const totalPrice = Number(row.totalPrice) || 0;
  const nightlyPrice = Number(row.nightlyPrice) || (totalPrice > 0 && nights > 0 ? totalPrice / nights : 0);
  const images = Array.isArray(row.images) && row.images.length ? row.images : (row.image ? [row.image] : undefined);
  return {
    source: "vrbo",
    sourceLabel: row.sourceLabel ?? "Vrbo",
    title: row.title,
    url: row.url,
    nightlyPrice,
    totalPrice,
    bedrooms: row.bedrooms ?? bedrooms,
    image: row.image ?? undefined,
    images,
    lat: row.lat,
    lng: row.lng,
    verified: "yes",
    verifiedReason: "City VRBO map inventory",
  };
}

function auditFromFindBuyIn(bedrooms: number, data: any, groundFloorOnly: boolean): AutoFillSearchAudit {
  const cheapest = (data?.cheapest ?? []) as any[];
  const candidates = cheapest.slice(0, 20).map((c) => ({
    source: c.source,
    sourceLabel: c.sourceLabel,
    title: c.title,
    url: c.url,
    totalPrice: c.totalPrice ?? 0,
    nightlyPrice: c.nightlyPrice ?? 0,
    bedrooms: c.bedrooms,
    verified: c.verified,
    verifiedReason: c.verifiedReason,
    image: c.image,
    groundFloorStatus: c.groundFloorStatus,
  }));
  const sourceCounts = {
    airbnb: data?.sources?.airbnb?.length ?? 0,
    vrbo: data?.sources?.vrboAll?.length ?? data?.sources?.vrbo?.length ?? 0,
    booking: 0,
    pm: data?.sources?.pm?.length ?? 0,
  };
  const scanned = sourceCounts.airbnb + sourceCounts.vrbo + sourceCounts.pm;
  return {
    bedrooms,
    generatedAt: data?.diagnostics?.generatedAt ?? new Date().toISOString(),
    counts: {
      bedrooms,
      scanned: Math.max(scanned, candidates.length),
      priced: typeof data?.totalPricedResults === "number" ? data.totalPricedResults : candidates.filter((c) => c.totalPrice > 0).length,
      sourceCounts,
      kept: candidates.length,
      targetFiltered: 0,
      groundFloorOnly,
    },
    candidates,
    diagnostics: data?.diagnostics,
  };
}

function auditFromCity(bedrooms: number, payload: any): AutoFillSearchAudit {
  const rows = (payload?.byBedroom?.[bedrooms] ?? []) as any[];
  return {
    bedrooms,
    generatedAt: new Date().toISOString(),
    counts: {
      bedrooms,
      scanned: payload?.listings?.length ?? 0,
      priced: rows.filter((r) => (Number(r.totalPrice) || 0) > 0).length,
      sourceCounts: { airbnb: 0, vrbo: payload?.listings?.length ?? 0, booking: 0, pm: 0 },
      kept: rows.length,
      targetFiltered: 0,
      groundFloorOnly: false,
    },
    candidates: rows.slice(0, 20).map((r) => ({
      source: "vrbo",
      sourceLabel: r.sourceLabel ?? "Vrbo",
      title: r.title,
      url: r.url,
      totalPrice: r.totalPrice ?? 0,
      nightlyPrice: r.nightlyPrice ?? 0,
      bedrooms: r.bedrooms ?? bedrooms,
      verified: "yes",
      image: r.image,
    })),
    diagnostics: {
      severity: "ok",
      title: "City-wide VRBO map inventory",
      summary: `${payload?.listings?.length ?? 0} exported · pair=${payload?.suggestedPair?.resortPhrase ?? "none"}`,
      generatedAt: new Date().toISOString(),
      request: { bedrooms, checkIn: payload?.checkIn, checkOut: payload?.checkOut },
      sources: [],
      issues: [],
      report: `City search: ${payload?.citySearchTerm ?? ""}`,
    },
  };
}

function setAudit(job: AutoFillJob, audit: AutoFillSearchAudit): void {
  const idx = job.searchAudits.findIndex((a) => a.bedrooms === audit.bedrooms);
  if (idx >= 0) job.searchAudits[idx] = audit;
  else job.searchAudits.push(audit);
  job.searchAudits.sort((a, b) => b.bedrooms - a.bedrooms);
  touch(job);
}

function recomputeTotals(job: AutoFillJob): void {
  const costs = job.attached.map((a) => a.totalPrice).filter((n) => Number.isFinite(n) && n > 0);
  job.totalCost = costs.length === job.attached.length && job.attached.length > 0
    ? costs.reduce((s, n) => s + n, 0)
    : (costs.length > 0 ? costs.reduce((s, n) => s + n, 0) : null);
}

// ALL-OR-NOTHING reconciliation for combo bookings (operator: 2026-06-08, combos
// must fill EVERY unit or none — a lone unit can't house the group and the attach
// proximity guard rejects a cross-community 2nd pick). PR #608's rollback only
// covered the single-unit FALLBACK stage, but a partial can also be left by the
// resort / home-city / nearby combo stages — e.g. the 1st unit attaches, then the
// 2nd is proximity-rejected (the guard only fires once >=2 are attached). This
// FINAL pass, run before EVERY finalize (normal AND error path), detaches every
// unit THIS job attached when a COMBO booking ends partially filled, leaving it
// empty for manual review. Safe because the client only ever passes the EMPTY
// slots to fill, so job.slots has no pre-attached siblings — rolling back
// job.attached can't strand a prior-run sibling. No-op for single-unit bookings,
// complete fills, empty results, or a canceled job (cancel reports partials
// honestly). See AGENTS.md #608 + the bulk-queue load-bearing note.
async function reconcileComboAllOrNothing(job: AutoFillJob): Promise<void> {
  if (job.canceled) return;
  const unitConfig = PROPERTY_UNIT_CONFIGS[job.propertyId];
  const isComboProperty = !!unitConfig && unitConfig.units.length >= 2;
  if (!isComboProperty) return;
  const filled = job.attached.length;
  if (filled === 0 || filled >= job.slots.length) return; // empty or complete → nothing to roll back
  const rolledBack = job.attached.splice(0);
  for (const a of rolledBack) {
    if (a.buyInId != null) { try { await storage.detachBuyIn(a.buyInId); } catch { /* best effort */ } }
  }
  recomputeTotals(job);
  for (const slot of job.slots) {
    if (!job.skipped.some((s) => s.unitId === slot.unitId)) {
      job.skipped.push({
        unitId: slot.unitId,
        unitLabel: slot.unitLabel,
        reason: `${slot.unitLabel}: partial combo rolled back — no complete walkable combo for all ${job.slots.length} units; detached ${rolledBack.length} lone unit${rolledBack.length === 1 ? "" : "s"} and left the booking empty for manual review`,
      });
    }
  }
  touch(job);
}

// ── attach (server analog of the client createAndAttachPick) ─────────────────
async function attachPick(args: {
  job: AutoFillJob;
  base: string;
  slot: AutoFillSlotInput;
  pick: LiveCandidate;
  searchedBedrooms: number;
  used: Set<string>;
  stage: AttachStage;
  comboLabel?: string;
}): Promise<boolean> {
  const { job, base, slot, pick, searchedBedrooms, used, stage, comboLabel } = args;
  const skip = (reason: string) => {
    job.skipped.push({ unitId: slot.unitId, unitLabel: slot.unitLabel, reason: `${slot.unitLabel}: ${reason}` });
    touch(job);
  };

  const finalCost = pick.totalPrice;
  if (!Number.isFinite(finalCost) || finalCost <= 0) { skip("skipped invalid price"); return false; }
  const actualBedrooms = candidateBedrooms(pick, searchedBedrooms);
  const airbnbPick = pick.source === "airbnb";
  if (actualBedrooms < searchedBedrooms) { skip(`skipped ${actualBedrooms}BR result for ${searchedBedrooms}BR search`); return false; }
  if (!airbnbPick && pick.verified !== "yes") { skip(`skipped unverified ${pick.sourceLabel} result`); return false; }
  if (hasUsedListingIdentity(used, pick)) { skip("skipped duplicate physical listing"); return false; }

  const ci = job.checkIn;
  const co = job.checkOut;
  const isCity = stage === "home-city" || stage === "nearby" || stage === "single-unit-city";
  const verifySuffix = pick.verified === "yes"
    ? (isCity
      ? ` · Matched from city-wide VRBO map for ${actualBedrooms}BR ${ci}→${co}`
      : ` · Verified by find-buy-in for ${actualBedrooms}BR ${ci}→${co}`)
    : "";
  const comboSuffix = comboLabel ? ` · ${comboLabel}; selected ${actualBedrooms}BR for this slot` : "";
  const tosSuffix = airbnbPick
    ? " · ⚠️ Airbnb pick — Airbnb TOS prohibits sublet. Operator should handle channel-specific compliance before booking."
    : "";
  const groundFloorSuffix = pick.groundFloorStatus === "confirmed"
    ? ` · Ground-floor: confirmed${pick.groundFloorEvidence ? ` (${pick.groundFloorEvidence})` : ""}`
    : pick.groundFloorStatus
      ? ` · Ground-floor: ${String(pick.groundFloorStatus).replace("_", " ")}${pick.groundFloorEvidence ? ` (${pick.groundFloorEvidence})` : ""}`
      : "";
  const sameUnitEvidenceUrls = Array.from(new Set([
    ...(pick.alternateUrls ?? []),
    pick.airbnbAnchorUrl,
  ].filter((u): u is string => !!u && listingUrlKey(u) !== listingUrlKey(pick.url)))).slice(0, 8);
  const identitySuffix = sameUnitEvidenceUrls.length > 0 ? ` · Same-unit evidence: ${sameUnitEvidenceUrls.join(" ")}` : "";
  // Manual photo URLs marker MUST stay last (AGENTS.md Load-Bearing #1).
  const photoSuffix = buyInPhotoNotesSuffix([pick.image, ...(pick.images ?? [])]);
  const notes = `Auto-filled from ${pick.sourceLabel} — ${pick.title}${verifySuffix}${comboSuffix}${tosSuffix}${groundFloorSuffix}${identitySuffix}${photoSuffix}`;

  try {
    const createResp = await postJson(`${base}/api/buy-ins`, {
      propertyId: job.propertyId,
      propertyName: job.propertyName,
      unitId: slot.unitId,
      unitLabel: slot.unitLabel,
      checkIn: ci,
      checkOut: co,
      costPaid: finalCost.toFixed(2),
      airbnbConfirmation: null,
      airbnbListingUrl: pick.url,
      groundFloorStatus: pick.groundFloorStatus ?? "unknown",
      groundFloorEvidence: pick.groundFloorEvidence ?? null,
      notes,
      status: "active",
      ...(typeof pick.unitTypeConfidence === "number"
        ? { unitTypeConfidence: Math.round(pick.unitTypeConfidence), unitTypeConfidenceBreakdown: pick.unitTypeConfidenceBreakdown ?? null }
        : {}),
    }, 30_000);
    if (!createResp.ok || !createResp.data?.id) {
      skip(`create failed (${createResp.data?.error || createResp.status})`);
      return false;
    }
    const buyInId = createResp.data.id as number;
    const attachResp = await postJson(`${base}/api/bookings/${encodeURIComponent(job.reservationId)}/attach-buy-in`, { buyInId }, 60_000);
    if (!attachResp.ok) {
      // 409 = proximity / combo-confidence reject (same outcome the client gets);
      // record a clear reason and move on. The orphaned buy-in record stays
      // unattached (status active, no reservation) — harmless, matches client.
      skip(`attach rejected (${attachResp.data?.error || attachResp.status})`);
      return false;
    }
    addUsedListingIdentity(used, pick);
    job.attached.push({
      unitId: slot.unitId,
      unitLabel: slot.unitLabel,
      bedrooms: actualBedrooms,
      buyInId,
      title: pick.title,
      sourceLabel: pick.sourceLabel,
      url: pick.url,
      totalPrice: finalCost,
      airbnbPick,
      stage,
    });
    recomputeTotals(job);
    touch(job);
    return true;
  } catch (e: any) {
    skip(`attach-error ${e?.message ?? ""}`.trim());
    return false;
  }
}

// ── worker ───────────────────────────────────────────────────────────────────
async function runAutoFillJob(job: AutoFillJob): Promise<void> {
  if (activeJobIds.has(job.id)) return;
  activeJobIds.add(job.id);
  const base = loopbackBaseUrl();
  try {
    touch(job, { status: "running", phase: "resort", message: "Searching the resort…", progress: 8, startedAt: job.startedAt ?? Date.now() });

    // Seed the used-identity set + filled-slot set from buy-ins ALREADY attached
    // to this reservation (sibling slots filled before / concurrently). This is
    // the no-double-attach guard: we never re-fill a slot that's already filled.
    const used = new Set<string>();
    // PRE-JOB baseline cost (cost already committed on sibling slots before this
    // job ran) — captured ONCE so re-reads after this job's own attaches don't
    // double-count (this job's attaches are tracked separately in job.attached).
    let baselineCostCaptured = false;
    const refreshFilled = async (): Promise<Set<string>> => {
      const existing = await storage.getBuyInsByReservation(job.reservationId).catch(() => []);
      const filled = new Set<string>();
      let existingCost = 0;
      for (const b of existing) {
        if (b.status === "cancelled") continue;
        if (b.unitId) filled.add(b.unitId);
        existingCost += Number(b.costPaid) || 0;
        addUsedListingIdentity(used, { url: b.airbnbListingUrl, title: titleFromBuyInNotes(b.notes) });
      }
      if (!baselineCostCaptured) {
        job.existingAttachedCost = existingCost;
        baselineCostCaptured = true;
      }
      job.revenueAvailable = job.expectedRevenue - committedCost();
      return filled;
    };
    // Total cost committed so far = pre-job baseline + everything THIS job attached.
    const committedCost = (): number =>
      job.existingAttachedCost + job.attached.reduce((s, a) => s + (Number(a.totalPrice) || 0), 0);
    let filledUnitIds = await refreshFilled();
    const remainingSlots = (): AutoFillSlotInput[] =>
      job.slots.filter((s) => !filledUnitIds.has(s.unitId) && !job.attached.some((a) => a.unitId === s.unitId));

    if (remainingSlots().length === 0) {
      touch(job, { status: "completed", phase: "done", message: "All slots were already filled.", progress: 100, finishedAt: Date.now() });
      finalize(job);
      return;
    }

    if (!job.gateEnabled) {
      job.message = "Profit gate disabled (booking revenue unknown) — attaching cheapest as before.";
      touch(job);
    }

    // Profit gate: a proposed combo (cost C) is OK to attach iff the booking stays
    // profitable/break-even. The cheapest combo per city IS the max-profit one
    // there, so an unprofitable cheapest => no acceptable combo in that city =>
    // record economics + move to the next city. Disabled when revenue is unknown.
    // Uses committedCost() so a second/partial pick is gated on the RUNNING total.
    const gate = (comboCost: number) =>
      evaluateComboProfit({
        expectedRevenue: job.expectedRevenue,
        existingCost: committedCost(),
        comboCost,
        flat: PROFIT_MIN_FLAT_USD,
        pct: PROFIT_MIN_PCT,
      });
    const recordEconomics = (source: AttachStage, label: string, comboCost: number, profit: number, accepted: boolean, reason?: string) => {
      job.cityEconomics.push({ source, label, comboCost: Math.round(comboCost), expectedProfit: Math.round(profit), accepted, reason });
      touch(job);
    };
    const recordLossComboOption = (label: string, pair: any, comboCost: number, profit: number) =>
      pushLossComboOption(job, label, pair, comboCost, profit);

    const unitConfig = PROPERTY_UNIT_CONFIGS[job.propertyId];
    const isComboProperty = !!unitConfig && unitConfig.units.length >= 2;

    // find-buy-in deduped per bedroom group. recover=1 is NOT used (it only
    // replays the recovery cache); a fresh call re-runs the scan. We retry once
    // when the scan came back EMPTY and incomplete (a transient sidecar blip).
    const fbiCache = new Map<string, Promise<any>>();
    const getFbi = (bedrooms: number): Promise<any> => {
      const requireGround = job.groundFloorBedrooms.has(bedrooms);
      const key = `${bedrooms}|${requireGround ? "ground" : "any"}`;
      const existing = fbiCache.get(key);
      if (existing) return existing;
      const run = (async () => {
        const params = new URLSearchParams({
          propertyId: String(job.propertyId),
          bedrooms: String(bedrooms),
          checkIn: job.checkIn,
          checkOut: job.checkOut,
        });
        if (job.listingId) params.set("listingId", job.listingId);
        if (job.community) params.set("community", job.community);
        if (requireGround) params.set("groundFloor", "required");
        const url = `${base}/api/operations/find-buy-in?${params.toString()}`;
        let data = await getJson(url, FIND_BUY_IN_LOOPBACK_TIMEOUT_MS);
        if (data?.scanComplete !== true && (data?.cheapest?.length ?? 0) === 0 && !job.canceled) {
          await new Promise((r) => setTimeout(r, 4_000));
          try { data = await getJson(url, FIND_BUY_IN_LOOPBACK_TIMEOUT_MS); } catch { /* keep first */ }
        }
        return data;
      })();
      fbiCache.set(key, run);
      return run;
    };

    // ── Stage 1: resort search (find-buy-in) ──
    setEscalation(job, { resort: "searching" });
    const bedroomsNeeded = Array.from(new Set(remainingSlots().map((s) => s.bedrooms)));
    const poolByBedroom = new Map<number, LiveCandidate[]>();
    for (const bedrooms of bedroomsNeeded) {
      if (job.canceled) break;
      const data = await getFbi(bedrooms).catch(() => null);
      if (data) {
        setAudit(job, auditFromFindBuyIn(bedrooms, data, job.groundFloorBedrooms.has(bedrooms)));
        poolByBedroom.set(bedrooms, candidatesFromFindBuyIn(data));
      } else {
        poolByBedroom.set(bedrooms, []);
      }
    }
    // PROPOSE the cheapest distinct unit per remaining slot (no attach yet), gate
    // the WHOLE proposed combo by profit, then attach all-or-nothing — so we never
    // commit a partial unprofitable resort set. If unprofitable, record the
    // economics and fall through to the city stages.
    {
      const proposeUsed = new Set(used);
      const proposal: Array<{ slot: AutoFillSlotInput; pick: LiveCandidate }> = [];
      for (const slot of remainingSlots()) {
        const pool = poolByBedroom.get(slot.bedrooms) ?? [];
        const pick = pool.find((c) => !hasUsedListingIdentity(proposeUsed, c));
        if (pick) { proposal.push({ slot, pick }); addUsedListingIdentity(proposeUsed, pick); }
      }
      if (proposal.length > 0) {
        const comboCost = proposal.reduce((s, p) => s + (Number(p.pick.totalPrice) || 0), 0);
        const v = gate(comboCost);
        if (v.acceptable) {
          for (const { slot, pick } of proposal) {
            if (job.canceled) break;
            await attachPick({ job, base, slot, pick, searchedBedrooms: slot.bedrooms, used, stage: "resort", comboLabel: isComboProperty ? `Resort search ${job.community ?? ""}`.trim() : undefined });
          }
        } else {
          recordEconomics("resort", `Resort ${job.community ?? ""}`.trim() || "Resort", comboCost, v.profit, false,
            `combo $${Math.round(comboCost).toLocaleString()} → est. profit $${Math.round(v.profit).toLocaleString()} (worse than the $${PROFIT_MIN_FLAT_USD.toLocaleString()} max-loss limit); searched on`);
          // The resort itself is the same-community walkable combo — a PRIME
          // override candidate. Capture it as an attachable loss option, but only
          // when the proposal covers EVERY slot (the client attach requires
          // picks.length === slots.length).
          if (proposal.length === job.slots.length) {
            recordLossComboOption(
              `Resort ${job.community ?? ""}`.trim() || "Resort",
              { bedrooms: proposal.map((p) => p.slot.bedrooms), picks: proposal.map((p) => p.pick) },
              comboCost,
              v.profit,
            );
          }
        }
      }
    }
    filledUnitIds = await refreshFilled();
    const afterResort = remainingSlots();
    setEscalation(job, {
      resort: afterResort.length === 0 ? "found" : (job.attached.length > 0 ? "found" : "no-pair"),
      resortLabel: job.community ?? undefined,
      ...(afterResort.length === 0 ? { foundAt: "resort" as const } : {}),
    });
    if (afterResort.length === 0) {
      touch(job, { status: "completed", phase: "done", message: doneMessage(job), progress: 100, finishedAt: Date.now() });
      finalize(job);
      return;
    }

    // City stages only run for configured static combo/single properties (the
    // city-vrbo endpoint requires a PROPERTY_UNIT_CONFIGS entry). Drafts and
    // Guesty-derived targets get Stage 1 only — exactly as the client gated it.
    const cityCapable = !!unitConfig;
    let cityPayload: any = null;
    const fetchCity = async (): Promise<any> => {
      if (cityPayload) return cityPayload;
      const params = new URLSearchParams({ propertyId: String(job.propertyId), checkIn: job.checkIn, checkOut: job.checkOut });
      cityPayload = await getJson(`${base}/api/operations/city-vrbo-inventory?${params.toString()}`, CITY_VRBO_LOOPBACK_TIMEOUT_MS);
      return cityPayload;
    };

    // ── Stage 2: home-city VRBO combo (combo properties only) ──
    if (cityCapable && isComboProperty && remainingSlots().length >= 2 && !job.canceled) {
      touch(job, { phase: "home-city", message: "Searching the home city on VRBO…", progress: 45 });
      setEscalation(job, { homeCity: "searching" });
      try {
        const payload = await fetchCity();
        setEscalation(job, {
          homeCityTerm: payload?.citySearchTerm,
          homeCityListings: payload?.listings?.length ?? 0,
          homeCityCoverage: payload?.coverage as CityVrboCoverage | undefined,
        });
        const pair = payload?.suggestedPair;
        const hasPair = !!pair && Array.isArray(pair.picks) && pair.picks.length >= 2;
        if (hasPair) {
          const comboCost = (pair.picks as any[]).reduce((s, pk) => s + (Number(pk?.totalPrice) || 0), 0);
          const v = gate(comboCost);
          for (const b of pair.bedrooms ?? []) setAudit(job, auditFromCity(b, payload));
          if (v.acceptable) {
            setEscalation(job, { homeCity: "found", foundAt: "home-city" });
            await attachCityCombo(job, base, payload, used);
          } else {
            // Found a pair, but it loses money — record economics + keep searching
            // nearby cities (the cheapest combo here is the max-profit one, so no
            // other home-city combo would be better).
            setEscalation(job, { homeCity: "no-pair" });
            recordEconomics("home-city", payload?.citySearchTerm ?? "home city", comboCost, v.profit, false,
              `combo $${Math.round(comboCost).toLocaleString()} → est. profit $${Math.round(v.profit).toLocaleString()} (worse than the $${PROFIT_MIN_FLAT_USD.toLocaleString()} max-loss limit); searching nearby cities`);
            recordLossComboOption(payload?.citySearchTerm ?? "home city", pair, comboCost, v.profit);
          }
        } else {
          setEscalation(job, { homeCity: "no-pair" });
        }
      } catch (e: any) {
        setEscalation(job, { homeCity: "skipped" });
      }
    }

    // ── Stage 3-4: nearby-city combo expansion (combo properties only) ──
    // Runs whenever >=2 slots are still empty — i.e. the home city had NO pair OR
    // an UNPROFITABLE one (an accepted home combo would have filled the slots, so
    // remainingSlots<2 and this is skipped). Keep searching cities for a
    // profitable/break-even combo; the expansion applies the SAME profit gate.
    const homeWorkerOnline = cityPayload?.sidecar?.workerOnline === true;
    if (cityCapable && isComboProperty && remainingSlots().length >= 2 && homeWorkerOnline && !job.canceled) {
      const g0 = gate(0); // gate(0).profit == revenueAvailable (revenue - committed)
      await runExpansion(job, base, used, {
        revenueAvailable: g0.profit,
        minProfit: g0.minProfit,
        profitGateEnabled: g0.gateEnabled,
      });
    }

    // ── Per-slot single-unit city fallback for anything still empty ──
    // ALL-OR-NOTHING for a COMBO booking (operator, 2026-06-08): a 6BR/2-unit
    // group needs ALL its units, and they must be WALKABLE to each other (the
    // attach endpoint's proximity guard enforces it — a cross-community pick is
    // rejected "units too far apart"). When there's no profitable WALKABLE pair
    // within the $100 limit, the cheap single units are scattered across
    // communities, so this fallback can only ever attach ONE — a lone unit that
    // can't house the group. So: if we can't fill EVERY remaining slot with a
    // valid (walkable + within-$100) unit, attach NONE and leave it for manual
    // review. Profit-gated on the RUNNING total (committedCost grows as units
    // attach). A SINGLE-unit booking (one slot) attaches normally — no combo.
    if (cityCapable && remainingSlots().length > 0 && !job.canceled) {
      touch(job, { phase: "single-unit-city", message: "City VRBO fallback for remaining units…", progress: 80 });
      const slotsToFill = remainingSlots();
      const allOrNothing = slotsToFill.length >= 2;
      const stageStartAttachCount = job.attached.length;
      let failed = false;
      let failReason = "";
      try {
        const payload = await fetchCity();
        for (const slot of slotsToFill) {
          if (job.canceled) { failed = true; failReason = "canceled"; break; }
          const rows = ((payload?.byBedroom?.[slot.bedrooms] ?? []) as any[])
            .filter((r) => (Number(r.totalPrice) || 0) > 0)
            .sort((a, b) => (Number(a.totalPrice) || Infinity) - (Number(b.totalPrice) || Infinity));
          setAudit(job, auditFromCity(slot.bedrooms, payload));
          const row = rows.find((r) => !hasUsedListingIdentity(used, { url: r.url, title: r.title, sourceLabel: r.sourceLabel }));
          if (!row) { failed = true; failReason = `${slot.unitLabel}: no distinct ${slot.bedrooms}BR unit available`; break; }
          const cost = Number(row.totalPrice) || 0;
          const v = gate(cost);
          if (!v.acceptable) {
            recordEconomics("single-unit-city", `${payload?.citySearchTerm ?? "city"} ${slot.unitLabel}`.trim(), cost, v.profit, false,
              `adding ${slot.unitLabel} ($${Math.round(cost).toLocaleString()}) → est. profit $${Math.round(v.profit).toLocaleString()} (worse than the $${PROFIT_MIN_FLAT_USD.toLocaleString()} max-loss limit); left empty`);
            failed = true;
            failReason = `${slot.unitLabel}: $${Math.round(cost).toLocaleString()} exceeds the $${PROFIT_MIN_FLAT_USD.toLocaleString()} loss limit`;
            break; // further units only deepen the loss
          }
          const ok = await attachPick({
            job, base, slot,
            pick: liveCandidateFromCityRow(row, slot.bedrooms, job.nights),
            searchedBedrooms: slot.bedrooms,
            used, stage: "single-unit-city",
            comboLabel: `City VRBO ${row.sourceLabel ?? "unit"}`,
          });
          if (!ok) {
            // attach rejected (proximity "too far apart" / unverified / dup) — for a
            // combo this means no walkable partner, so the whole fill can't complete.
            failed = true;
            failReason = `${slot.unitLabel}: attach rejected (no walkable partner / unavailable)`;
            break;
          }
        }
        // Roll back a PARTIAL combo fill: detach anything this stage attached so we
        // never leave a lone unit on a multi-unit booking.
        if (allOrNothing && failed && job.attached.length > stageStartAttachCount) {
          const rolledBack = job.attached.splice(stageStartAttachCount);
          for (const a of rolledBack) {
            if (a.buyInId != null) await storage.detachBuyIn(a.buyInId).catch(() => {});
          }
          recomputeTotals(job);
          recordEconomics(
            "single-unit-city",
            `${payload?.citySearchTerm ?? "city"} combo`,
            0, 0, false,
            `no profitable WALKABLE combo for all ${slotsToFill.length} units (${failReason}); detached ${rolledBack.length} lone unit(s) and left the booking empty for manual review`,
          );
          touch(job);
        }
      } catch { /* best effort */ }
    }

    // All-or-nothing: a combo left partially filled by ANY stage rolls back to
    // empty (the single-unit fallback above only guards its own stage). doneMessage
    // recomputes from job.attached, so a rollback correctly reports 0 filled.
    await reconcileComboAllOrNothing(job);
    touch(job, { status: "completed", phase: "done", message: doneMessage(job), progress: 100, finishedAt: Date.now() });
    finalize(job);
  } catch (e: any) {
    // A throw mid-combo (e.g. an attach failed after the 1st unit) can also leave a
    // lone unit — reconcile before finalizing so we never strand a partial combo.
    try { await reconcileComboAllOrNothing(job); } catch { /* best effort */ }
    touch(job, {
      status: "failed",
      phase: "failed",
      message: e?.message || "Auto-fill failed",
      progress: 100,
      finishedAt: Date.now(),
      error: e?.message || "Auto-fill failed",
    });
    finalize(job);
  } finally {
    activeJobIds.delete(job.id);
  }
}

function jobExpectedProfit(job: AutoFillJob): number | null {
  if (!job.gateEnabled) return null;
  const cost = job.existingAttachedCost + job.attached.reduce((s, a) => s + (Number(a.totalPrice) || 0), 0);
  return job.expectedRevenue - cost;
}

function doneMessage(job: AutoFillJob): string {
  const filled = job.attached.length;
  const total = job.slots.length;
  const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
  // Nothing attached: if the profit gate rejected combos, say so with the
  // best-found economics (the operator is intentionally NOT committed to a loss).
  if (filled === 0) {
    const rejected = job.cityEconomics.filter((c) => !c.accepted);
    // Count cities actually SCANNED (home city + every nearby tier city that ran),
    // not just the ones that produced a priced combo — otherwise the message
    // under-reports (e.g. "5" when 9 nearby + home were searched).
    const nearbyScanned = (job.escalation.tierResults ?? []).filter((c) => c.status && c.status !== "pending").length;
    const citiesSearched = nearbyScanned + 1; // + the home city
    if (job.gateEnabled && rejected.length > 0) {
      const best = rejected.reduce((a, b) => (b.expectedProfit > a.expectedProfit ? b : a));
      return `No profitable combination found (revenue ${usd(job.expectedRevenue)}). Best option: ${best.label} — combo ${usd(best.comboCost)}, est. profit ${usd(best.expectedProfit)}. Searched ${citiesSearched} ${citiesSearched === 1 ? "city" : "cities"} (home + nearby); left empty so you're not committed to a loss.`;
    }
    return "No verified priced candidate could be attached. Open Find buy-in to review.";
  }
  const cost = job.totalCost != null ? ` · Buy-in cost: ${usd(job.totalCost)}` : "";
  const profit = jobExpectedProfit(job);
  const profitStr = profit != null ? ` · Revenue ${usd(job.expectedRevenue)} · Est. profit ${usd(profit)}` : "";
  return `Attached ${filled}/${total} unit${total === 1 ? "" : "s"}${cost}${profitStr}`;
}

// Assign each combo pick to a DISTINCT slot, consuming each pick exactly once.
// Exported for testing. LARGEST-pick-to-LARGEST-slot bijection: this fills every
// slot when counts match AND supports alternative bedroom SPLITS — a 6BR booking
// configured [3,3] can be satisfied by a 4BR+2BR combo, where the 2BR must land
// in a "3BR" slot (per-slot >= matching would leave it unfilled). The combo was
// already chosen to satisfy the TOTAL, so any bijection is valid; biggest-to-
// biggest keeps over/under-fills sensible. For the configured split (picks
// multiset == slots multiset, e.g. [3,3] or [3,2]) this is identical to an
// exact-bedroom match. Also fixes the earlier "only attached the first unit" bug
// (a same-bedroom pair never collapses to one pick here).
export function assignComboPicksToSlots(
  pickBedrooms: number[],
  slots: Array<{ bedrooms: number }>,
): Array<{ slotIndex: number; pickIndex: number }> {
  const picksDesc = pickBedrooms
    .map((br, pickIndex) => ({ pickIndex, br: Number(br) || 0 }))
    .sort((a, b) => b.br - a.br);
  const slotsDesc = slots
    .map((slot, slotIndex) => ({ slotIndex, br: Number(slot.bedrooms) || 0 }))
    .sort((a, b) => b.br - a.br);
  const out: Array<{ slotIndex: number; pickIndex: number }> = [];
  const n = Math.min(picksDesc.length, slotsDesc.length);
  for (let i = 0; i < n; i += 1) {
    out.push({ slotIndex: slotsDesc[i].slotIndex, pickIndex: picksDesc[i].pickIndex });
  }
  return out;
}

// Capture a REJECTED (over-budget) walkable pair as an ATTACHABLE option so the
// operator can review it after the search and one-click "attach anyway" to
// override the loss limit. Shaped like the client's AutoFillComboOption +
// isLoss/lossProfit. Only same-community walkable pairs (resort / home-city /
// nearby-city) land here — their picks are in hand and the attach won't trip the
// proximity guard. `pair` is a suggestedPair-shaped object (CityVrboComboPair or
// its serialized twin): { picks: CityVrboListing[], bedrooms: number[] }.
// `profit` is negative for a loss; `comboCost` is the pair's total. Module-level
// so both runAutoFillJob (resort/home-city) and runExpansion (nearby) can call it.
function pushLossComboOption(
  job: AutoFillJob,
  label: string,
  pair: any,
  comboCost: number,
  profit: number,
): void {
  if (!pair || !Array.isArray(pair.picks) || pair.picks.length < 2) return;
  // Don't log the same walkable pair twice (resort + home-city can re-surface the
  // same cheapest pair across stages). Key on the sorted attach URLs.
  const urls = (pair.picks as any[]).map((p) => String(p?.url ?? "")).filter(Boolean).sort();
  const key = urls.join("|");
  if (key && job.comboOptions.some((o: any) => o.isLoss && o.__lossKey === key)) return;
  const picks = (pair.picks as any[]).map((p, i) => ({
    bedrooms: Number(pair.bedrooms?.[i] ?? p?.bedrooms ?? 0) || 0,
    source: "vrbo" as const,
    sourceLabel: String(p?.sourceLabel ?? "Vrbo"),
    title: String(p?.title ?? "Unit"),
    totalPrice: Number(p?.totalPrice) || 0,
    nightlyPrice: Number(p?.nightlyPrice) || undefined,
    url: String(p?.url ?? ""),
    image: p?.image,
    images: Array.isArray(p?.images) ? p.images.filter(Boolean).slice(0, 12) : undefined,
  }));
  job.comboOptions.push({
    label,
    bedrooms: Array.isArray(pair.bedrooms) ? pair.bedrooms : picks.map((x) => x.bedrooms),
    totalCost: Math.round(comboCost),
    selected: false,
    isLoss: true,
    lossProfit: Math.round(profit),
    note: `Walkable ${label} pair — would lose $${Math.round(-profit).toLocaleString()} (over the $${PROFIT_MIN_FLAT_USD.toLocaleString()} limit). Attach to override.`,
    picks,
    __lossKey: key,
  });
  touch(job);
}

// Attach a city suggestedPair's picks to the remaining slots, consuming each pick
// once (see assignComboPicksToSlots). Shared by the home-city and nearby-expansion
// combo paths — pass the right `stage` so the attached record is labeled correctly.
async function attachCityCombo(
  job: AutoFillJob,
  base: string,
  payload: any,
  used: Set<string>,
  stage: AttachStage = "home-city",
): Promise<void> {
  const pair = payload?.suggestedPair;
  if (!pair || !Array.isArray(pair.picks) || pair.picks.length === 0) return;
  const remainingSlots = job.slots.filter((s) => !job.attached.some((a) => a.unitId === s.unitId));
  const pickBedrooms: number[] = pair.picks.map((p: any, i: number) =>
    Number(pair.bedrooms?.[i] ?? p?.bedrooms ?? 0),
  );
  const assignments = assignComboPicksToSlots(pickBedrooms, remainingSlots);
  for (const { slotIndex, pickIndex } of assignments) {
    if (job.canceled) break;
    const slot = remainingSlots[slotIndex];
    await attachPick({
      job, base, slot,
      pick: liveCandidateFromCityRow(pair.picks[pickIndex], slot.bedrooms, job.nights),
      searchedBedrooms: slot.bedrooms,
      used, stage,
      comboLabel: `City VRBO ${pair.resortPhrase ?? "pair"}`,
    });
  }
}

// Drive the existing nearby-city expansion job IN-PROCESS (start + poll to
// terminal) and attach the found combo. No HTTP — the expansion module's
// functions are imported directly.
async function runExpansion(
  job: AutoFillJob,
  base: string,
  used: Set<string>,
  gateParams: { revenueAvailable: number; minProfit: number; profitGateEnabled: boolean },
): Promise<void> {
  touch(job, { phase: "nearby", message: "Widening to nearby cities (drive-time)…", progress: 60 });
  setEscalation(job, { nearbyStatus: "searching" });
  let started: { jobId: string } | null = null;
  try {
    started = startExpansionJob({
      propertyId: job.propertyId,
      checkIn: job.checkIn,
      checkOut: job.checkOut,
      // Profit gate threaded through so the expansion only STOPS on a profitable
      // city and records the economics of unprofitable ones (continuing the walk).
      revenueAvailable: gateParams.revenueAvailable,
      minProfit: gateParams.minProfit,
      profitGateEnabled: gateParams.profitGateEnabled,
    });
  } catch (e: any) {
    if (e instanceof CityExpansionValidationError) { setEscalation(job, { nearbyStatus: "exhausted" }); return; }
    setEscalation(job, { nearbyStatus: "error" }); return;
  }
  const expansionJobId = started.jobId;
  const startedAt = Date.now();
  let terminal: CityExpansionJobStatus | null = null;
  while (Date.now() - startedAt < EXPANSION_POLL_CAP_MS && !job.canceled) {
    const exp = getExpansionJob(expansionJobId);
    if (!exp) break; // lost (redeploy)
    const s = serializeExpansionJob(exp);
    setEscalation(job, {
      // Strip lossPair from the LIVE escalation copy — the client doesn't need the
      // picks here (they arrive as attachable comboOptions); keeps polling lean.
      // The terminal fold below reads s.cityResults directly, so it keeps lossPair.
      tierResults: s.cityResults.map(({ lossPair, ...rest }) => rest),
      nearbyStatus: s.status === "found" ? "found"
        : s.status === "worker_offline" ? "worker_offline"
        : s.status === "error" ? "error"
        : s.done ? "exhausted" : "searching",
    });
    if (s.done) { terminal = s; break; }
    await new Promise((r) => setTimeout(r, EXPANSION_POLL_INTERVAL_MS));
  }
  // Fold each nearby city's combo economics into the ladder (accepted OR skipped).
  for (const c of terminal?.cityResults ?? []) {
    if (typeof c.comboCost === "number") {
      job.cityEconomics.push({
        source: "nearby",
        label: c.placeName || c.citySearchTerm,
        comboCost: Math.round(c.comboCost),
        expectedProfit: Math.round(c.expectedProfit ?? 0),
        accepted: c.accepted === true,
        reason: c.reason,
      });
      // Surface each rejected nearby pair as an attachable "accept the loss"
      // override option (its picks rode along in c.lossPair).
      if (c.accepted !== true && c.lossPair) {
        pushLossComboOption(
          job,
          c.placeName || c.citySearchTerm,
          c.lossPair,
          c.comboCost,
          c.expectedProfit ?? 0,
        );
      }
    }
  }
  if (terminal?.status === "found" && terminal.combo) {
    setEscalation(job, { foundAt: "nearby" });
    await attachCityCombo(job, base, terminal.combo, used, "nearby");
    for (const b of terminal.combo.suggestedPair?.bedrooms ?? []) setAudit(job, auditFromCity(b, terminal.combo));
  }
}

// ── serialize ────────────────────────────────────────────────────────────────
export function serializeAutoFillJob(job: AutoFillJob): AutoFillJobStatus {
  return {
    jobId: job.id,
    status: job.status,
    done: isTerminal(job.status),
    phase: job.phase,
    message: job.message,
    progress: job.progress,
    reservationId: job.reservationId,
    escalation: job.escalation,
    attached: job.attached,
    skipped: job.skipped,
    searchAudits: job.searchAudits,
    comboOptions: job.comboOptions,
    cityEconomics: job.cityEconomics,
    slotsTotal: job.slots.length,
    slotsFilled: job.attached.length,
    totalCost: job.totalCost,
    expectedRevenue: job.expectedRevenue,
    expectedProfit: jobExpectedProfit(job),
    error: job.error,
    timestamps: { createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt },
  };
}

// ── public API ─────────────────────────────────────────────────────────────
export function startAutoFillJob(input: StartAutoFillInput): { jobId: string; status: JobStatus; reused: boolean } {
  cleanupStaleJobs();
  const reservationId = String(input.reservationId ?? "").trim();
  if (!reservationId) throw new AutoFillValidationError("reservationId required");
  if (!Number.isFinite(input.propertyId) || input.propertyId === 0) throw new AutoFillValidationError("propertyId required");
  if (!input.checkIn || !input.checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkOut)) {
    throw new AutoFillValidationError("checkIn and checkOut required (YYYY-MM-DD)");
  }
  const slots = Array.isArray(input.slots)
    ? input.slots
        .map((s) => ({ unitId: String(s.unitId ?? "").trim(), unitLabel: String(s.unitLabel ?? "").trim() || "Unit", bedrooms: Number(s.bedrooms) }))
        .filter((s) => s.unitId && Number.isFinite(s.bedrooms) && s.bedrooms > 0)
    : [];
  if (slots.length === 0) throw new AutoFillValidationError("at least one empty slot (unitId + bedrooms) required");

  // Single-flight: a live job for this reservation already exists → return it,
  // UNLESS forceRestart (bulk fresh re-run) — then supersede it so a stale job
  // (old slot set + pre-detach baseline) can't be reused. Cancel + finalize the
  // old job so its worker stops attaching, then fall through to a fresh job.
  const existingId = activeJobByReservation.get(reservationId);
  if (existingId) {
    const existing = autoFillJobs.get(existingId);
    if (existing && !isTerminal(existing.status)) {
      if (!input.forceRestart) {
        return { jobId: existing.id, status: existing.status, reused: true };
      }
      // Supersede: stop the old worker (canceled) + mark terminal so any poller
      // on the old jobId resolves. finalize() only clears the active mapping if it
      // still points at the old id, so the fresh job's mapping (set below) is safe
      // even if the old worker finalizes again later.
      existing.canceled = true;
      existing.status = "failed";
      existing.error = existing.error ?? "Superseded by a fresh re-run";
      finalize(existing);
    }
    activeJobByReservation.delete(reservationId);
  }

  const id = newJobId("afj");
  const now = Date.now();
  const expectedRevenue = Number(input.expectedRevenue) || 0;
  const gateEnabled = expectedRevenue > 0;
  const minProfit = -profitToleranceUsd(expectedRevenue, PROFIT_MIN_FLAT_USD, PROFIT_MIN_PCT);
  const job: AutoFillJob = {
    id,
    status: "queued",
    phase: "queued",
    message: "Queued",
    progress: 4,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    reservationId,
    propertyId: input.propertyId,
    listingId: input.listingId ?? null,
    propertyName: input.propertyName || `Property ${input.propertyId}`,
    community: input.community ?? null,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    nights: nightsBetween(input.checkIn, input.checkOut),
    slots,
    groundFloorBedrooms: new Set((input.groundFloorBedrooms ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)),
    silent: input.silent === true,
    expectedRevenue,
    existingAttachedCost: 0,
    revenueAvailable: expectedRevenue,
    minProfit,
    gateEnabled,
    escalation: { resort: "idle", homeCity: "idle", foundAt: null },
    attached: [],
    skipped: [],
    searchAudits: [],
    comboOptions: [],
    cityEconomics: [],
    totalCost: null,
    error: null,
    canceled: false,
    owner: input.owner === "bulk" ? "bulk" : "row",
  };
  autoFillJobs.set(id, job);
  activeJobByReservation.set(reservationId, id);
  lastJobByReservation.set(reservationId, id);
  void runAutoFillJob(job).catch((err) => {
    job.status = "failed";
    job.error = String(err?.message ?? err);
    finalize(job);
  });
  return { jobId: id, status: job.status, reused: false };
}

export function getAutoFillJob(jobId: string): AutoFillJob | null {
  cleanupStaleJobs();
  return autoFillJobs.get(jobId) ?? null;
}

// Rediscover the live job for a reservation (so a returning client can resume
// polling without remembering the jobId). Returns the live or most-recent job.
// excludeBulk (used by the row-level /active endpoint) skips jobs the bulk queue
// owns, so the row poller never competes with the bulk orchestrator's
// single-flight on the same reservation (would race a forceRestart). See B1.
export function getActiveAutoFillJobForReservation(
  reservationId: string,
  opts?: { excludeBulk?: boolean },
): AutoFillJob | null {
  cleanupStaleJobs();
  const id = activeJobByReservation.get(reservationId);
  if (id) {
    const job = autoFillJobs.get(id);
    if (job && !(opts?.excludeBulk && job.owner === "bulk")) return job;
  }
  return null;
}

// The MOST-RECENT job for a reservation, terminal or live (unlike the active
// accessor, which drops it on finalize). Powers the durable "last search" panel
// so the loss-combo economics survive closing the bulk-queue dialog.
export function getLastAutoFillJobForReservation(reservationId: string): AutoFillJob | null {
  cleanupStaleJobs();
  const id = lastJobByReservation.get(reservationId);
  return id ? autoFillJobs.get(id) ?? null : null;
}

export function cancelAutoFillJob(jobId: string): boolean {
  const job = autoFillJobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  touch(job);
  return true;
}
