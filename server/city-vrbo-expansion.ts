// ── Drive-time tiered city VRBO combo expansion ────────────────────────────
//
// When a >=2-unit ("combo") booking's resort search AND its home-city VRBO scan
// both fail to surface a same-community pair, this module widens the search by
// drive-time: it discovers the towns within a 20-minute drive of the booking's
// community, runs a full city-wide VRBO inventory scan for each (nearest first),
// and stops at the first town that yields a walkable same-resort pair. If none
// do, it widens to a 45-minute drive, EXCLUDING every town already scanned.
//
// This is the operator's explicit fallback ladder:
//   resort search -> home city -> [cities within 20 min] -> [cities within 45 min].
//
// It runs as a BACKGROUND JOB (in-memory, single-process Railway idiom) that the
// client starts and polls — each city scan drives the VRBO sidecar for ~1-3 min,
// so a synchronous request would blow Railway's edge timeout.
//
// VRBO sight+click policy (AGENTS.md, zero-tolerance): every scan goes through
// runCityVrboInventoryScanForCity -> the sidecar destination-dropdown path with a
// plain "City, State" string. Coordinates are used ONLY for Photon town discovery
// and drive-time math — NEVER passed to VRBO, never used to build a search URL.

import {
  BUY_IN_MARKET_LOCATIONS,
  cityWideSearchLocationForBuyInMarket,
  driveMinutesBetweenCoords,
  haversineMiles,
} from "@shared/buy-in-market";
import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import {
  runCityVrboInventoryScanForCity,
  type CityVrboScanResult,
} from "./city-vrbo-inventory";

// ── tunables (env-overridable, floored) ────────────────────────────────────
function envInt(name: string, fallback: number, floor: number): number {
  const raw = Number(process.env[name]);
  return Math.max(floor, Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback);
}

const TIER1_MAX_MIN = envInt("CITY_VRBO_EXPANSION_TIER1_MAX_MIN", 20, 5);
const TIER2_MAX_MIN = envInt("CITY_VRBO_EXPANSION_TIER2_MAX_MIN", 45, TIER1_MAX_MIN + 5);
const TIER1_RADIUS_KM = envInt("CITY_VRBO_EXPANSION_TIER1_RADIUS_KM", 35, 5);
const TIER2_RADIUS_KM = envInt("CITY_VRBO_EXPANSION_TIER2_RADIUS_KM", 70, TIER1_RADIUS_KM);
// City caps: how many towns each tier scans (nearest-first). These were 4/5,
// which on Kauai capped the walk at the ~9 NEAREST towns (all ≤21 min) and never
// reached the 21–45 min band (Wailua ~28, Kapaa ~35, Anahola ~45) — so the
// "within 45 min" tier wasn't actually reaching 45 min (operator, 2026-06-08).
// Raised so each tier covers its full drive-time radius: tier 1 sweeps all towns
// ≤20 min, tier 2 the rest ≤45 min. Kauai has ~12–14 towns within 45 min of a
// south-shore market, so the actual count self-caps below these. Trade-off: an
// UNFILLABLE booking now scans more cities (~2 min each) before giving up; a
// fillable one still stops at the first profitable pair. Env-tunable if a bulk
// queue gets too slow.
const TIER1_CITY_CAP = envInt("CITY_VRBO_EXPANSION_TIER1_CITY_CAP", 8, 1);
const TIER2_CITY_CAP = envInt("CITY_VRBO_EXPANSION_TIER2_CITY_CAP", 8, 1);
// 38 min (was 30): with the wider city caps a full Kauai sweep is ~12–14 cities
// at ~2 min each ≈ 26–28 min, and the 21–45 min towns are scanned LAST — so the
// budget needs headroom or the furthest (the ones we just widened to reach) get
// cut by "time budget exhausted". Stays under the auto-fill job's 40-min poll cap
// (EXPANSION_POLL_CAP_MS) so the parent is still polling when it finishes.
// NOTE: an UNFILLABLE booking now ties up the sidecar longer; in a big bulk queue
// dial CITY_VRBO_EXPANSION_TIER*_CITY_CAP / _BUDGET_MS down if it's too slow.
const EXPANSION_BUDGET_MS = envInt("CITY_VRBO_EXPANSION_BUDGET_MS", 38 * 60_000, 5 * 60_000);
const EXPANSION_JOB_TTL_MS = envInt("CITY_VRBO_EXPANSION_JOB_TTL_MS", 38 * 60_000, 5 * 60_000);
const HOME_RADIUS_KM = envInt("CITY_VRBO_EXPANSION_HOME_RADIUS_KM", 5, 1);

// ── public types ───────────────────────────────────────────────────────────
export type ExpansionJobStatus =
  | "pending"
  | "running"
  | "found"
  | "exhausted"
  | "worker_offline"
  | "error";

export type ExpansionTier = 1 | 2;

export type ExpansionCityStatus =
  | "pending"
  | "scanning"
  | "no-pair"
  | "pair"
  | "unprofitable" // a same-community pair was found but it loses money — skipped, searched on
  | "skipped"
  | "scan-error";

export type ExpansionCityResult = {
  citySearchTerm: string;
  placeName: string;
  driveMinutes: number;
  tier: ExpansionTier;
  status: ExpansionCityStatus;
  listingsExported?: number;
  suggestedPair: boolean;
  workerOnline?: boolean;
  reason?: string;
  durationMs?: number;
  // Economics recorded when a pair is found (accepted OR rejected for profit), so
  // the operator sees each city's combo cost + expected profit in the ladder.
  comboCost?: number;
  expectedProfit?: number;
  accepted?: boolean;
  // For UNPROFITABLE cities only: the cheapest walkable pair we rejected, kept so
  // the auto-fill job can surface it as an attachable "accept the loss" override
  // option after the search. Just the 2 picks + bedrooms — compact (~1-2KB), not
  // the full city inventory, so polling the job status stays cheap.
  lossPair?: NonNullable<CityVrboScanResult["suggestedPair"]>;
};

// The inventory payload shape the client consumes — identical to the
// GET /api/operations/city-vrbo-inventory response so the existing
// cityComboOptionFromInventory(payload) works unchanged.
export type CityVrboInventoryClientPayload = CityVrboScanResult & {
  propertyId: number;
  community: string;
  unitLabels: string[];
  bedroomPlan: number[];
};

type ExpansionJob = {
  id: string;
  status: ExpansionJobStatus;
  propertyId: number;
  community: string;
  unitLabels: string[];
  checkIn: string;
  checkOut: string;
  bedroomPlan: number[];
  nights: number;
  homeCitySearchTerm: string;
  // Profit gate (passed in pre-netted by the auto-fill job): a city's cheapest
  // combo is accepted only if (revenueAvailable - comboCost) >= minProfit. When
  // profitGateEnabled is false (revenue unknown), the first pair found wins (old
  // behavior). Unprofitable cities are recorded and the walk continues.
  revenueAvailable: number;
  minProfit: number;
  profitGateEnabled: boolean;
  phase: { tier: ExpansionTier | 0; label: string };
  progress: { citiesPlanned: number; citiesScanned: number; currentCity: string | null };
  citiesSearched: string[];
  cityResults: ExpansionCityResult[];
  result: {
    comboSourceCity: string;
    comboSourcePlaceName: string;
    comboSourceTier: ExpansionTier;
    driveMinutes: number;
    inventory: CityVrboInventoryClientPayload;
  } | null;
  workerOnline: boolean;
  error: string | null;
  canceled: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
};

// The serialized poll response the client consumes.
export type CityExpansionJobStatus = {
  jobId: string;
  status: ExpansionJobStatus;
  done: boolean;
  community: string;
  checkIn: string;
  checkOut: string;
  phase: { tier: ExpansionTier | 0; label: string };
  tier: number | null; // tier -> drive-minute ceiling, for the UI
  tier1Ceiling: number; // env-accurate tier-1 ceiling (default 20), always present
  tier2Ceiling: number; // env-accurate tier-2 ceiling (default 45), always present
  currentCity: string | null;
  citiesSearched: string[];
  scannedCount: number;
  totalCount: number;
  cityResults: ExpansionCityResult[];
  workerOnline: boolean;
  error: string | null;
  combo: CityVrboInventoryClientPayload | null;
  comboSourceCity: string | null;
  driveMinutes: number | null;
  timestamps: { createdAt: number; startedAt: number | null; finishedAt: number | null };
};

export class CityExpansionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CityExpansionValidationError";
  }
}

const TERMINAL: ReadonlySet<ExpansionJobStatus> = new Set<ExpansionJobStatus>([
  "found",
  "exhausted",
  "worker_offline",
  "error",
]);
const isTerminal = (status: ExpansionJobStatus) => TERMINAL.has(status);

// ── stores ─────────────────────────────────────────────────────────────────
const expansionJobs = new Map<string, ExpansionJob>();
// `${propertyId}|${checkIn}|${checkOut}` -> live jobId (single-flight)
const activeJobByKey = new Map<string, string>();

function jobKey(propertyId: number, checkIn: string, checkOut: string): string {
  return `${propertyId}|${checkIn}|${checkOut}`;
}

function sweepExpansionJobs(): void {
  const now = Date.now();
  for (const [id, job] of Array.from(expansionJobs.entries())) {
    const ref = job.finishedAt ?? job.updatedAt;
    const ttl = isTerminal(job.status) ? EXPANSION_JOB_TTL_MS : Math.max(EXPANSION_JOB_TTL_MS, EXPANSION_BUDGET_MS * 2);
    if (now - ref > ttl) {
      expansionJobs.delete(id);
      const key = jobKey(job.propertyId, job.checkIn, job.checkOut);
      if (activeJobByKey.get(key) === id) activeJobByKey.delete(key);
    }
  }
}
setInterval(sweepExpansionJobs, 5 * 60_000).unref();

// ── helpers ──────────────────────────────────────────────────────────────
function normTerm(value: string): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(
    1,
    Math.round(
      (new Date(`${checkOut}T12:00:00`).getTime() - new Date(`${checkIn}T12:00:00`).getTime()) / 86_400_000,
    ),
  );
}

function touch(job: ExpansionJob): void {
  job.updatedAt = Date.now();
}

function setCityResult(job: ExpansionJob, citySearchTerm: string, patch: Partial<ExpansionCityResult>): void {
  const row = job.cityResults.find((r) => r.citySearchTerm === citySearchTerm);
  if (row) Object.assign(row, patch);
  touch(job);
}

function markRemaining(job: ExpansionJob, status: ExpansionCityStatus, reason: string): void {
  for (const row of job.cityResults) {
    if (row.status === "pending" || row.status === "scanning") {
      row.status = status;
      row.reason = reason;
    }
  }
  touch(job);
}

function toClientInventoryPayload(scan: CityVrboScanResult, job: ExpansionJob): CityVrboInventoryClientPayload {
  return {
    ...scan,
    propertyId: job.propertyId,
    community: job.community,
    unitLabels: job.unitLabels,
    bedroomPlan: job.bedroomPlan,
  };
}

// ── nearby-town discovery (Photon reverse, anchored on community coords) ────
// Refactor of GET /api/community/nearby-cities, but anchored on coordinates we
// already have (BUY_IN_MARKET_LOCATIONS) so there's no initial geocode step.
type NearbyTown = { placeName: string; driveMinutes: number; lat: number; lng: number; state: string };

const PLACE_VALUES = new Set(["city", "town", "village", "municipality", "borough", "suburb", "locality"]);
const stripOkina = (s: string) => s.replace(/[ʻʼ'‘’]/g, "").normalize("NFD").replace(/[̀-ͯ]/g, "");

const nearbyTownsCache = new Map<string, { towns: NearbyTown[]; ts: number }>();
const NEARBY_TOWNS_TTL_MS = 10 * 60_000;

async function nearbyTownsForCoords(args: {
  lat: number;
  lng: number;
  state: string;
  radiusKm: number;
  maxDriveMinutes: number;
  limit: number;
}): Promise<NearbyTown[]> {
  const cacheKey = `${args.lat.toFixed(3)}|${args.lng.toFixed(3)}|${args.radiusKm}|${args.state.toLowerCase()}`;
  const cached = nearbyTownsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NEARBY_TOWNS_TTL_MS) {
    return cached.towns.filter((t) => t.driveMinutes <= args.maxDriveMinutes).slice(0, args.limit);
  }
  try {
    const url = new URL("https://photon.komoot.io/reverse");
    url.searchParams.set("lat", String(args.lat));
    url.searchParams.set("lon", String(args.lng));
    url.searchParams.set("radius", String(args.radiusKm));
    url.searchParams.set("limit", "40");
    url.searchParams.set("osm_tag", "place");
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "NexStay/1.0 (contact: jamie.greene736@gmail.com)" },
    });
    if (!resp.ok) {
      nearbyTownsCache.set(cacheKey, { towns: [], ts: Date.now() });
      return [];
    }
    const data = (await resp.json()) as any;
    const seen = new Set<string>();
    const towns: NearbyTown[] = [];
    for (const f of data.features ?? []) {
      const p = f.properties ?? {};
      if ((p.country ?? "") !== "United States") continue;
      if (args.state && (p.state ?? "").toLowerCase() !== args.state.toLowerCase()) continue;
      if (!PLACE_VALUES.has((p.osm_value ?? "").toLowerCase())) continue;
      const rawName = (p.name ?? "").trim();
      if (!rawName) continue;
      const placeName = stripOkina(rawName);
      const key = placeName.toLowerCase();
      if (seen.has(key)) continue;
      const [lon, lat] = f.geometry?.coordinates ?? [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const driveMinutes = driveMinutesBetweenCoords(args.lat, args.lng, lat, lon);
      if (driveMinutes == null) continue;
      seen.add(key);
      towns.push({ placeName, driveMinutes, lat, lng: lon, state: p.state ?? args.state });
    }
    towns.sort((a, b) => a.driveMinutes - b.driveMinutes || a.placeName.localeCompare(b.placeName));
    nearbyTownsCache.set(cacheKey, { towns, ts: Date.now() });
    return towns.filter((t) => t.driveMinutes <= args.maxDriveMinutes).slice(0, args.limit);
  } catch (e: any) {
    console.warn(`[city-vrbo-expansion] nearby-towns error: ${e?.message ?? e}`);
    nearbyTownsCache.set(cacheKey, { towns: [], ts: Date.now() });
    return [];
  }
}

// ── worker ─────────────────────────────────────────────────────────────────
async function runExpansionWorker(job: ExpansionJob): Promise<void> {
  job.status = "running";
  job.startedAt = Date.now();
  touch(job);

  const loc = BUY_IN_MARKET_LOCATIONS[job.community];
  if (!loc) {
    job.status = "error";
    job.error = "Community has no map coordinates for nearby-city discovery";
    finalize(job);
    return;
  }

  const deadline = job.startedAt + EXPANSION_BUDGET_MS;
  const searched = new Set<string>();
  searched.add(normTerm(job.homeCitySearchTerm));
  searched.add(normTerm(`${loc.city}, ${loc.state}`));

  // getHeartbeat is the same online signal runCityVrboInventoryScan returns via
  // sidecar.workerOnline. Gate up-front: an offline worker leaves each scan
  // PENDING until the queue TTL (~5 min) — catastrophic across a tier.
  const { getHeartbeat } = await import("./vrbo-sidecar-queue");
  if (!getHeartbeat().isOnline) {
    job.status = "worker_offline";
    finalize(job);
    return;
  }

  try {
    for (const tier of [1, 2] as const) {
      if (Date.now() > deadline || job.canceled) break;
      const maxMin = tier === 1 ? TIER1_MAX_MIN : TIER2_MAX_MIN;
      const radiusKm = tier === 1 ? TIER1_RADIUS_KM : TIER2_RADIUS_KM;
      const cap = tier === 1 ? TIER1_CITY_CAP : TIER2_CITY_CAP;
      job.phase = { tier, label: `Within ${maxMin} min` };
      touch(job);

      const towns = await nearbyTownsForCoords({
        lat: loc.lat,
        lng: loc.lng,
        state: loc.state,
        radiusKm,
        maxDriveMinutes: maxMin,
        limit: cap * 3,
      });

      const plan: Array<{ term: string; placeName: string; driveMinutes: number }> = [];
      for (const t of towns) {
        // Coords-first home exclusion: the community KEY ("Kapaa Beachfront") is
        // not a town name, so name-only exclusion misses the home town. Drop any
        // town essentially at the community's location.
        if (haversineMiles(loc.lat, loc.lng, t.lat, t.lng) * 1.60934 <= HOME_RADIUS_KM) continue;
        const term = `${t.placeName}, ${t.state || loc.state}`;
        if (searched.has(normTerm(term))) continue; // home (tier 1) + all tier-1 towns (tier 2)
        plan.push({ term, placeName: t.placeName, driveMinutes: t.driveMinutes });
        if (plan.length >= cap) break;
      }

      for (const p of plan) {
        job.cityResults.push({
          citySearchTerm: p.term,
          placeName: p.placeName,
          driveMinutes: p.driveMinutes,
          tier,
          status: "pending",
          suggestedPair: false,
        });
      }
      job.progress.citiesPlanned += plan.length;
      touch(job);

      for (const p of plan) {
        if (Date.now() > deadline) {
          markRemaining(job, "skipped", "expansion time budget exhausted");
          job.status = "exhausted";
          finalize(job);
          return;
        }
        if (job.canceled) {
          markRemaining(job, "skipped", "canceled");
          job.status = "exhausted";
          finalize(job);
          return;
        }
        // Worker can drop mid-job; re-check before each scan so we never queue a
        // doomed PENDING scan against an offline worker.
        if (!getHeartbeat().isOnline) {
          setCityResult(job, p.term, { status: "skipped", reason: "sidecar went offline" });
          markRemaining(job, "skipped", "sidecar offline");
          job.status = "worker_offline";
          finalize(job);
          return;
        }

        searched.add(normTerm(p.term));
        job.citiesSearched.push(p.term);
        job.progress.currentCity = p.term;
        setCityResult(job, p.term, { status: "scanning" });

        let scan: CityVrboScanResult;
        try {
          scan = await runCityVrboInventoryScanForCity({
            citySearchTerm: p.term,
            checkIn: job.checkIn,
            checkOut: job.checkOut,
            bedroomPlan: job.bedroomPlan,
            // The nearby town has no community; pass the ORIGINATING property's
            // state so a Florida combo's expansion towns aren't filtered against
            // the "Hawaii" default (HI properties still pass "Hawaii").
            targetState: BUY_IN_MARKET_LOCATIONS[job.community]?.state,
          });
        } catch (err: any) {
          setCityResult(job, p.term, { status: "scan-error", reason: String(err?.message ?? err) });
          job.progress.citiesScanned += 1;
          touch(job);
          continue;
        }

        job.progress.citiesScanned += 1;
        job.workerOnline = scan.sidecar.workerOnline;

        // A scan can come back workerOnline=false for TWO reasons: the worker is
        // genuinely offline, OR a per-search wallet/queue budget expired while a
        // HEALTHY worker was mid-export (vrbo-sidecar-queue returns
        // workerOnline:false for that too). Only the genuinely-offline case
        // should abort the whole ladder — reconcile against the live heartbeat.
        if (!scan.sidecar.workerOnline) {
          if (!getHeartbeat().isOnline) {
            setCityResult(job, p.term, { status: "skipped", reason: scan.sidecar.reason });
            markRemaining(job, "skipped", "sidecar offline");
            job.status = "worker_offline";
            finalize(job);
            return;
          }
          // Healthy worker, this town's scan just timed out → transient; record
          // it and keep walking the ladder (the next town may have the pair).
          setCityResult(job, p.term, { status: "scan-error", reason: scan.sidecar.reason });
          touch(job);
          continue;
        }

        // VRBO provider cooldown (block/proxy failure) returns workerOnline=true
        // but 0 candidates instantly, and stays armed for ~15 min — so every
        // remaining town would return 0 and the operator would be told "no pair
        // nearby" when VRBO was actually blocking. Short-circuit with the
        // offline-style status so the toast tells them to retry, not "no pair".
        if (scan.listings.length === 0 && /cool(?:ing)?\s*down|provider is cooling|block|proxy/i.test(scan.sidecar.reason ?? "")) {
          setCityResult(job, p.term, { status: "skipped", reason: scan.sidecar.reason });
          markRemaining(job, "skipped", "VRBO provider cooling down (block/proxy)");
          job.error = scan.sidecar.reason;
          job.status = "worker_offline";
          finalize(job);
          return;
        }

        const exported = scan.listings.length;
        if (scan.suggestedPair) {
          // Profit gate: the cheapest same-community pair IS the max-profit one in
          // this city, so if it loses money no combo here is acceptable — record
          // the economics and CONTINUE to the next city instead of stopping.
          const comboCost = (scan.suggestedPair.picks ?? []).reduce(
            (sum, pk) => sum + (Number(pk?.totalPrice) || 0),
            0,
          );
          const profit = job.revenueAvailable - comboCost;
          const accepted = !job.profitGateEnabled || profit >= job.minProfit;
          if (accepted) {
            setCityResult(job, p.term, {
              status: "pair",
              suggestedPair: true,
              listingsExported: exported,
              durationMs: scan.sidecar.durationMs,
              comboCost,
              expectedProfit: job.profitGateEnabled ? profit : undefined,
              accepted: true,
            });
            job.result = {
              comboSourceCity: p.term,
              comboSourcePlaceName: p.placeName,
              comboSourceTier: tier,
              driveMinutes: p.driveMinutes,
              inventory: toClientInventoryPayload(scan, job),
            };
            job.status = "found";
            finalize(job);
            return;
          }
          // Found a pair, but unprofitable → record + keep searching. Keep the
          // rejected pair (compact) so the auto-fill job can offer it as an
          // "accept the loss" override after the ladder finishes.
          setCityResult(job, p.term, {
            status: "unprofitable",
            suggestedPair: true,
            listingsExported: exported,
            durationMs: scan.sidecar.durationMs,
            comboCost,
            expectedProfit: profit,
            accepted: false,
            lossPair: scan.suggestedPair,
            reason: `combo $${Math.round(comboCost).toLocaleString()} → est. profit $${Math.round(profit).toLocaleString()} (worse than the $${Math.abs(Math.round(job.minProfit)).toLocaleString()} max-loss limit); searched on`,
          });
          touch(job);
          continue;
        }

        setCityResult(job, p.term, {
          status: "no-pair",
          suggestedPair: false,
          listingsExported: exported,
          durationMs: scan.sidecar.durationMs,
        });
        touch(job);
      }
    }

    if (job.status === "running") job.status = "exhausted";
  } catch (err: any) {
    job.status = "error";
    job.error = String(err?.message ?? err);
  } finally {
    finalize(job);
  }
}

function finalize(job: ExpansionJob): void {
  if (job.finishedAt == null) job.finishedAt = Date.now();
  job.progress.currentCity = null;
  touch(job);
  const key = jobKey(job.propertyId, job.checkIn, job.checkOut);
  if (activeJobByKey.get(key) === job.id) activeJobByKey.delete(key);
}

// ── public API ─────────────────────────────────────────────────────────────
export function startExpansionJob(args: {
  propertyId: number;
  checkIn: string;
  checkOut: string;
  // Profit gate (pre-netted by the auto-fill job). When profitGateEnabled is
  // omitted/false the expansion stops at the first pair (legacy behavior).
  revenueAvailable?: number;
  minProfit?: number;
  profitGateEnabled?: boolean;
}): { jobId: string; status: ExpansionJobStatus; community: string; citiesPlanned: number } {
  sweepExpansionJobs();
  const propertyId = Number(args.propertyId);
  if (!Number.isFinite(propertyId) || propertyId <= 0) {
    throw new CityExpansionValidationError("propertyId required");
  }
  if (
    !args.checkIn || !args.checkOut ||
    !/^\d{4}-\d{2}-\d{2}$/.test(args.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(args.checkOut)
  ) {
    throw new CityExpansionValidationError("checkIn and checkOut required (YYYY-MM-DD)");
  }
  const unitConfig = PROPERTY_UNIT_CONFIGS[propertyId];
  // Combo-only gate. NOTE: the GET /city-vrbo-inventory endpoint deliberately
  // allows >= 1 (single-unit fallback). The expansion is combo-only by design,
  // so it enforces a stricter gate here — the two are intentionally different.
  if (!unitConfig || unitConfig.units.length < 2) {
    throw new CityExpansionValidationError("Nearby-city expansion is combo-only (needs >= 2 unit slots)");
  }
  const community = unitConfig.community;
  if (!BUY_IN_MARKET_LOCATIONS[community]) {
    throw new CityExpansionValidationError("Community has no map coordinates for nearby-city discovery");
  }

  const key = jobKey(propertyId, args.checkIn, args.checkOut);
  const existingId = activeJobByKey.get(key);
  if (existingId) {
    const existing = expansionJobs.get(existingId);
    if (existing && !isTerminal(existing.status)) {
      // Single-flight: a live job for this (property, dates) already exists.
      return {
        jobId: existing.id,
        status: existing.status,
        community: existing.community,
        citiesPlanned: existing.progress.citiesPlanned,
      };
    }
    activeJobByKey.delete(key);
  }

  const id = `cve_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const job: ExpansionJob = {
    id,
    status: "pending",
    propertyId,
    community,
    unitLabels: unitConfig.units.map((u) => u.unitLabel),
    checkIn: args.checkIn,
    checkOut: args.checkOut,
    bedroomPlan: unitConfig.units.map((u) => u.bedrooms),
    nights: nightsBetween(args.checkIn, args.checkOut),
    homeCitySearchTerm: cityWideSearchLocationForBuyInMarket(community) ?? `${community}, Hawaii`,
    revenueAvailable: Number(args.revenueAvailable) || 0,
    minProfit: Number.isFinite(args.minProfit as number) ? (args.minProfit as number) : -Infinity,
    profitGateEnabled: args.profitGateEnabled === true,
    phase: { tier: 0, label: "Starting" },
    progress: { citiesPlanned: 0, citiesScanned: 0, currentCity: null },
    citiesSearched: [],
    cityResults: [],
    result: null,
    workerOnline: true,
    error: null,
    canceled: false,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
  expansionJobs.set(id, job);
  activeJobByKey.set(key, id);
  // Fire-and-forget; the worker owns its own lifecycle + finalize().
  void runExpansionWorker(job).catch((err) => {
    job.status = "error";
    job.error = String(err?.message ?? err);
    finalize(job);
  });
  return { jobId: id, status: job.status, community, citiesPlanned: 0 };
}

export function getExpansionJob(jobId: string): ExpansionJob | null {
  sweepExpansionJobs();
  return expansionJobs.get(jobId) ?? null;
}

export function cancelExpansionJob(jobId: string): boolean {
  const job = expansionJobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  touch(job);
  return true;
}

const tierMinutes = (tier: ExpansionTier | 0): number | null =>
  tier === 1 ? TIER1_MAX_MIN : tier === 2 ? TIER2_MAX_MIN : null;

// Public, env-accurate drive-time ceiling for a tier (the floored effective value
// of CITY_VRBO_EXPANSION_TIER{1,2}_MAX_MIN, defaults 20 / 45). The auto-fill job
// uses this to stamp each nearby loss combo with the "within ~N-min drive" ceiling
// so the UI chip/label never hardcodes 20/45 and can't drift from an env override.
// Delegates to tierMinutes (the tier 1|2 ? branch already lives there + at the
// worker's maxMin); the `?? TIER2_MAX_MIN` is an unreachable guard (tier is 1|2).
export function tierCeilingMinutes(tier: ExpansionTier): number {
  return tierMinutes(tier) ?? TIER2_MAX_MIN;
}

export function serializeExpansionJob(job: ExpansionJob): CityExpansionJobStatus {
  return {
    jobId: job.id,
    status: job.status,
    done: isTerminal(job.status),
    community: job.community,
    checkIn: job.checkIn,
    checkOut: job.checkOut,
    phase: job.phase,
    tier: tierMinutes(job.phase.tier),
    // Stable per-tier ceilings (vs `tier`, which is only the CURRENT phase's
    // ceiling) so the client can render BOTH the 20-min and 45-min stage titles
    // env-accurately at once and after the active phase advances.
    tier1Ceiling: tierCeilingMinutes(1),
    tier2Ceiling: tierCeilingMinutes(2),
    currentCity: job.progress.currentCity,
    citiesSearched: job.citiesSearched,
    scannedCount: job.progress.citiesScanned,
    totalCount: job.progress.citiesPlanned,
    cityResults: job.cityResults,
    workerOnline: job.workerOnline,
    error: job.error,
    combo: job.result?.inventory ?? null,
    comboSourceCity: job.result?.comboSourceCity ?? null,
    driveMinutes: job.result?.driveMinutes ?? null,
    timestamps: { createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt },
  };
}
