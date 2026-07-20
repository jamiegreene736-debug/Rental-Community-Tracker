// Headless Claude find-runs — server side (operator directive 2026-07-19).
//
// The portal's "Auto-run · find cheapest" button creates a RUN here; the Mac
// sidecar daemon's runner child claims it (X-Admin-Secret, same channel as
// every other daemon call), spawns `claude -p` with the run's brief, and
// relays progress/terminal state back. The headless agent authenticates its
// TWO portal writes (create buy-in, attach) with the run-scoped token minted
// below — it NEVER holds the admin secret, so a prompt-injected agent's blast
// radius is capped at "attach buy-ins to this one reservation until the run
// ends". The proxies forward to the REAL endpoints via 127.0.0.1 loopback
// (the auto-fill-job precedent) so buy-in creation/attach logic exists once.
//
// Store: app_settings `claude_find_runs.v1` via the promise-tail pattern
// (auto-replace-jobs precedent) — all mutations sequence through one tail so
// concurrent daemon flushes + operator cancels can't interleave writes.
import type { Express, Request, Response } from "express";
import { randomUUID, randomBytes, timingSafeEqual } from "crypto";
import { storage } from "./storage";
import { loopbackRequestHeaders } from "./auth";
import {
  ClaudeFindRunRecord,
  ClaudeFindRunStore,
  ClaudeFindRunUpdate,
  CLAUDE_FIND_RUN_BULK_MAX,
  CLAUDE_FIND_RUN_STORE_KEY,
  activeClaudeFindRunForReservation,
  applyClaudeFindRunUpdate,
  checkoutRunEligibility,
  claimNextClaudeFindRun,
  claudeFindRunnerActivity,
  claudeFindRunQueueAhead,
  claudeFindRunWatchdogVerdict,
  claudeFindRunHistoryForReservation,
  clientClaudeFindRunView,
  latestClaudeFindRunForReservation,
  parseClaudeFindRunStore,
  scrubClaudeFindRunToken,
  serializeClaudeFindRunStore,
} from "@shared/claude-find-run";
import {
  buildCoworkBuyInPrompt,
  buildCoworkCheckoutPrompt,
  type CoworkBuyInPromptInput,
} from "@shared/cowork-buyin-prompt";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

export const claudeFindRunsDisabled = () => process.env.CLAUDE_FIND_RUNS_DISABLED === "1";

// ── store I/O (promise-tail; fail-soft reads) ───────────────────────────────
let storeTail: Promise<unknown> = Promise.resolve();

async function readStore(): Promise<ClaudeFindRunStore> {
  try {
    const raw = await storage.getSetting(CLAUDE_FIND_RUN_STORE_KEY);
    return parseClaudeFindRunStore(raw ?? null);
  } catch (e) {
    console.warn("[claude-find-runs] store read failed:", (e as Error)?.message ?? e);
    return { version: 1, runs: [] };
  }
}

/** Sequence every mutation through one tail; mutator returns the response value. */
function mutateStore<T>(mutator: (store: ClaudeFindRunStore) => T | Promise<T>): Promise<T> {
  const next = storeTail.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await storage.setSetting(CLAUDE_FIND_RUN_STORE_KEY, serializeClaudeFindRunStore(store, Date.now()));
    return result;
  });
  // Failures must not wedge the tail (fail-soft precedent: auto-replace-jobs).
  storeTail = next.catch((e) => {
    console.warn("[claude-find-runs] store mutation failed:", (e as Error)?.message ?? e);
  });
  return next;
}

// ── auth helpers ────────────────────────────────────────────────────────────
type PortalSession = { role?: string } | undefined;

function requireOperator(res: Response): boolean {
  const session = res.locals.portalSession as PortalSession;
  if (session?.role === "admin") return true;
  res.status(403).json({ error: "Only the operator can use headless find-runs" });
  return false;
}

/**
 * Timing-safe run-token check for the auth-EXCLUDED /agent/ endpoints. The
 * token is the capability: it exists per run, dies with the run, and is only
 * ever known to the brief + the daemon. See server/auth.ts PUBLIC prefix note.
 */
function runTokenMatches(run: ClaudeFindRunRecord, presented: string | undefined): boolean {
  if (!presented || !run.token) return false;
  const a = Buffer.from(run.token);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function findRun(store: ClaudeFindRunStore, id: string): ClaudeFindRunRecord | null {
  return store.runs.find((r) => r.id === id) ?? null;
}

// ── request validation ──────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface CreateRunBody {
  reservationId?: unknown;
  guestName?: unknown;
  propertyId?: unknown;
  propertyName?: unknown;
  community?: unknown;
  checkIn?: unknown;
  checkOut?: unknown;
  units?: unknown;
  party?: unknown;
  netRevenue?: unknown;
}

function validateCreateBody(body: CreateRunBody): { ok: true; input: CoworkBuyInPromptInput } | { ok: false; error: string } {
  const reservationId = typeof body.reservationId === "string" ? body.reservationId.trim() : "";
  if (!reservationId || reservationId.length > 200) return { ok: false, error: "reservationId required" };
  const propertyId = Number(body.propertyId);
  if (!Number.isFinite(propertyId)) return { ok: false, error: "propertyId (number) required" };
  const propertyName = typeof body.propertyName === "string" ? body.propertyName.trim() : "";
  if (!propertyName) return { ok: false, error: "propertyName required" };
  const community = typeof body.community === "string" ? body.community.trim() : "";
  const checkIn = typeof body.checkIn === "string" ? body.checkIn : "";
  const checkOut = typeof body.checkOut === "string" ? body.checkOut : "";
  if (!DATE_RE.test(checkIn) || !DATE_RE.test(checkOut)) return { ok: false, error: "checkIn/checkOut must be YYYY-MM-DD" };
  const rawUnits = Array.isArray(body.units) ? body.units : [];
  const units = rawUnits
    .map((u: any) => ({
      unitId: typeof u?.unitId === "string" ? u.unitId : "",
      unitLabel: typeof u?.unitLabel === "string" ? u.unitLabel : "",
      bedrooms: Number(u?.bedrooms),
    }))
    .filter((u) => u.unitId && u.unitLabel && Number.isFinite(u.bedrooms) && u.bedrooms > 0);
  if (!units.length || units.length > 6) return { ok: false, error: "units (1-6 empty slots) required" };
  const netRevenue = Number(body.netRevenue);
  return {
    ok: true,
    input: {
      reservationId,
      guestName: typeof body.guestName === "string" ? body.guestName : null,
      propertyId,
      propertyName,
      community,
      checkIn,
      checkOut,
      units,
      party: (body.party ?? null) as CoworkBuyInPromptInput["party"],
      netRevenue: Number.isFinite(netRevenue) ? netRevenue : null,
    },
  };
}

/** Public origin for the brief's curl endpoints — derived from the request, never trusted from the body. */
function requestApiRoot(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/**
 * Enqueue one FIND run into the store. Shared by the single button and the
 * bulk batch so a bulk-queued run is byte-for-byte what the single button
 * would have created — same brief builder, same guest-expectation phase, same
 * run-scoped token. Returns the conflict view when a run is already live for
 * the reservation (which also de-dupes a reservation appearing twice in one
 * bulk body: the first item enqueues, the second sees it active).
 */
function enqueueFindRunInStore(
  store: ClaudeFindRunStore,
  input: CoworkBuyInPromptInput,
  apiRoot: string,
  nowIso: string,
): { run: ClaudeFindRunRecord } | { conflict: ClaudeFindRunRecord } {
  const active = activeClaudeFindRunForReservation(store.runs, input.reservationId);
  if (active) return { conflict: active };
  const id = randomUUID();
  const token = randomBytes(24).toString("hex");
  const prompt = buildCoworkBuyInPrompt(
    { ...input, baseUrl: apiRoot },
    // afterAttach "guest_expectation": the run continues past attach into a
    // READ-ONLY guest-experience check (2026-07-20) — it studies the
    // original listing vs the attached units and records a happy/concerns/
    // unhappy verdict; a concerns/unhappy verdict alerts the operator. Never
    // books, detaches, or re-finds.
    { headlessRun: { runId: id, runToken: token }, afterAttach: "guest_expectation" },
  );
  const run: ClaudeFindRunRecord = {
    id,
    reservationId: input.reservationId,
    propertyId: input.propertyId,
    propertyName: input.propertyName,
    guestName: input.guestName ?? null,
    status: "queued",
    createdAt: nowIso,
    claimedAt: null,
    heartbeatAt: null,
    endedAt: null,
    cancelRequested: false,
    attentionReason: null,
    report: null,
    error: null,
    events: [{ at: nowIso, kind: "status", text: "Run queued — waiting for the Mac runner to claim it." }],
    droppedEvents: 0,
    token,
    prompt,
    unitIds: input.units.map((u) => u.unitId),
    checkIn: input.checkIn,
    checkOut: input.checkOut,
  };
  store.runs.push(run);
  return { run };
}

/** Async-handler guard: a store/DB failure answers 500 instead of rejecting. */
function guarded(handler: (req: Request, res: Response) => Promise<unknown>): (req: Request, res: Response) => void {
  return (req, res) => {
    void handler(req, res).catch((e) => {
      console.warn("[claude-find-runs] handler failed:", (e as Error)?.message ?? e);
      if (!res.headersSent) res.status(500).json({ error: "Find-run store unavailable — try again" });
    });
  };
}

// ── routes ──────────────────────────────────────────────────────────────────
export function registerClaudeFindRunRoutes(app: Express): void {
  // Operator: start a run. Body = the same CoworkBuyInPromptInput shape the
  // Auto Cowork button builds (empty slots only, REMAINING net revenue).
  app.post("/api/claude-find-runs", guarded(async (req, res) => {
    if (!requireOperator(res)) return;
    if (claudeFindRunsDisabled()) {
      return res.status(503).json({ error: "Headless find-runs are disabled (CLAUDE_FIND_RUNS_DISABLED=1)" });
    }
    const validated = validateCreateBody((req.body ?? {}) as CreateRunBody);
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    const input = validated.input;
    const apiRoot = requestApiRoot(req);
    const nowIso = new Date().toISOString();

    const result = await mutateStore((store) => {
      const outcome = enqueueFindRunInStore(store, input, apiRoot, nowIso);
      return "conflict" in outcome
        ? { conflict: clientClaudeFindRunView(outcome.conflict) }
        : { run: clientClaudeFindRunView(outcome.run) };
    });
    if ("conflict" in result && result.conflict) {
      return res.status(409).json({ error: "A find-run is already active for this reservation", run: result.conflict });
    }
    return res.json(result);
  }));

  // Operator: start a BULK batch of find-runs (2026-07-20 — "extend the
  // headless runner to bulk"). One run per reservation, identical to what the
  // per-row button creates; the daemon runner is sequential by construction,
  // so enqueueing N runs IS the batch — they drain one at a time with per-row
  // live logs. Item semantics are bulk-shaped: an invalid or already-active
  // item is SKIPPED with its reason while the rest of the batch queues (an
  // all-or-nothing 409 would make one live run block seven fresh bookings).
  app.post("/api/claude-find-runs/bulk", guarded(async (req, res) => {
    if (!requireOperator(res)) return;
    if (claudeFindRunsDisabled()) {
      return res.status(503).json({ error: "Headless find-runs are disabled (CLAUDE_FIND_RUNS_DISABLED=1)" });
    }
    const rawItems = Array.isArray((req.body as Record<string, unknown> | undefined)?.items)
      ? ((req.body as Record<string, unknown>).items as unknown[])
      : [];
    if (rawItems.length === 0) return res.status(400).json({ error: "items (1+) required" });
    if (rawItems.length > CLAUDE_FIND_RUN_BULK_MAX) {
      return res.status(400).json({ error: `At most ${CLAUDE_FIND_RUN_BULK_MAX} runs per bulk batch — send the rest in a second batch` });
    }
    const apiRoot = requestApiRoot(req);
    const nowIso = new Date().toISOString();
    const result = await mutateStore((store) => {
      const created: ReturnType<typeof clientClaudeFindRunView>[] = [];
      const skipped: { reservationId: string; error: string }[] = [];
      for (const raw of rawItems) {
        const validated = validateCreateBody((raw ?? {}) as CreateRunBody);
        if (!validated.ok) {
          const rid = typeof (raw as CreateRunBody)?.reservationId === "string"
            ? String((raw as CreateRunBody).reservationId)
            : "(unknown)";
          skipped.push({ reservationId: rid, error: validated.error });
          continue;
        }
        const outcome = enqueueFindRunInStore(store, validated.input, apiRoot, nowIso);
        if ("conflict" in outcome) {
          skipped.push({
            reservationId: validated.input.reservationId,
            error: `A ${outcome.conflict.kind === "checkout" ? "checkout" : "find"}-run is already active for this reservation`,
          });
          continue;
        }
        created.push(clientClaudeFindRunView(outcome.run, {
          queueAhead: claudeFindRunQueueAhead(store.runs, outcome.run.id),
        }));
      }
      return { created, skipped };
    });
    return res.json(result);
  }));

  // Operator: start a HEADLESS CHECKOUT run for ONE attached buy-in
  // (2026-07-20 — the per-unit checkout buttons "execute cowork automatically"
  // like the find button). Every money-shaped value the brief embeds (cost,
  // listing URL, dates, unit label) is read from the AUTHORITATIVE buy_ins row
  // via loopback and validated by checkoutRunEligibility — the client body
  // contributes only identity/display data (guest name, property name, party).
  // This is what replaced the old client-side costPaid freshness pre-flight.
  app.post("/api/claude-find-runs/checkout", guarded(async (req, res) => {
    if (!requireOperator(res)) return;
    if (claudeFindRunsDisabled()) {
      return res.status(503).json({ error: "Headless runs are disabled (CLAUDE_FIND_RUNS_DISABLED=1)" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reservationId = typeof body.reservationId === "string" ? body.reservationId.trim() : "";
    if (!reservationId || reservationId.length > 200) return res.status(400).json({ error: "reservationId required" });
    const buyInId = Number(body.buyInId);
    if (!Number.isFinite(buyInId) || buyInId <= 0) return res.status(400).json({ error: "buyInId (number) required" });
    const propertyName = typeof body.propertyName === "string" && body.propertyName.trim()
      ? body.propertyName.trim().slice(0, 240)
      : "Vacation rental";
    const guestName = typeof body.guestName === "string" && body.guestName.trim() ? body.guestName.trim().slice(0, 160) : null;
    // The exact booking guest name is REQUIRED at VRBO checkout (every name
    // field including name-on-card) — refuse to queue a run that would only
    // stop at that wall ten minutes in.
    if (!guestName || !/\S\s+\S/.test(guestName)) {
      return res.status(422).json({ error: "The booking guest's full name is required — the checkout uses it for every name field" });
    }

    let row: Record<string, unknown> | null = null;
    try {
      const upstream = await fetch(`${loopbackBaseUrl()}/api/buy-ins/${buyInId}`, {
        headers: loopbackRequestHeaders(),
      });
      if (upstream.ok) row = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
    } catch {
      row = null;
    }
    const eligibility = checkoutRunEligibility(row, reservationId);
    if (!eligibility.ok) return res.status(422).json({ error: eligibility.error });
    const checkIn = typeof row?.checkIn === "string" ? row.checkIn.slice(0, 10) : "";
    const checkOut = typeof row?.checkOut === "string" ? row.checkOut.slice(0, 10) : "";
    if (!DATE_RE.test(checkIn) || !DATE_RE.test(checkOut)) {
      return res.status(422).json({ error: "The buy-in row has no usable stay dates" });
    }

    const apiRoot = requestApiRoot(req);
    const nowIso = new Date().toISOString();
    const result = await mutateStore((store) => {
      // ONE live run per reservation across BOTH kinds — a find run mutating
      // the slots underneath a checkout preparation (or two checkouts racing
      // one claim lane) is exactly the interleaving this guard exists for.
      const active = activeClaudeFindRunForReservation(store.runs, reservationId);
      if (active) return { conflict: clientClaudeFindRunView(active) };
      const id = randomUUID();
      const token = randomBytes(24).toString("hex");
      const prompt = buildCoworkCheckoutPrompt(
        {
          reservationId,
          guestName,
          propertyName,
          checkIn,
          checkOut,
          units: [eligibility.unit],
          party: (body.party ?? null) as CoworkBuyInPromptInput["party"],
          baseUrl: apiRoot,
        },
        { headlessRun: { runId: id, runToken: token } },
      );
      const run: ClaudeFindRunRecord = {
        id,
        reservationId,
        propertyId: Number(row?.propertyId) || 0,
        propertyName,
        guestName,
        kind: "checkout",
        buyInId,
        status: "queued",
        createdAt: nowIso,
        claimedAt: null,
        heartbeatAt: null,
        endedAt: null,
        cancelRequested: false,
        attentionReason: null,
        report: null,
        error: null,
        events: [{
          at: nowIso,
          kind: "status",
          text: `Checkout run queued for ${eligibility.unit.unitLabel} — waiting for the Mac runner to claim it.`,
        }],
        droppedEvents: 0,
        token,
        prompt,
        unitIds: [],
        checkIn,
        checkOut,
      };
      store.runs.push(run);
      return { run: clientClaudeFindRunView(run) };
    });
    if ("conflict" in result && result.conflict) {
      return res.status(409).json({ error: "A headless run is already active for this reservation", run: result.conflict });
    }
    return res.json(result);
  }));

  // Daemon: claim the oldest queued run. Reached with X-Admin-Secret (the
  // sidecar daemon's standing credential) — NOT on the public prefix.
  app.post("/api/claude-find-runs/claim", guarded(async (_req, res) => {
    if (claudeFindRunsDisabled()) return res.json({ run: null, disabled: true });
    const nowIso = new Date().toISOString();
    const claimed = await mutateStore((store) => claimNextClaudeFindRun(store.runs, nowIso));
    if (!claimed) return res.json({ run: null });
    return res.json({
      run: {
        id: claimed.id,
        token: claimed.token,
        prompt: claimed.prompt,
        reservationId: claimed.reservationId,
        propertyName: claimed.propertyName,
      },
    });
  }));

  // Operator: batch status for the bookings rows. Strips token + prompt.
  app.post("/api/claude-find-runs/status", guarded(async (req, res) => {
    if (!requireOperator(res)) return;
    const ids = Array.isArray(req.body?.reservationIds)
      ? (req.body.reservationIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 100)
      : [];
    const store = await readStore();
    const runs: Record<string, ReturnType<typeof clientClaudeFindRunView>> = {};
    const history: Record<string, ReturnType<typeof claudeFindRunHistoryForReservation>> = {};
    for (const reservationId of ids) {
      const latest = latestClaudeFindRunForReservation(store.runs, reservationId);
      // queueAhead tells a bulk-queued row "2 runs ahead in line" instead of a
      // generic "waiting for the Mac runner" that reads like an outage.
      if (latest) runs[reservationId] = clientClaudeFindRunView(latest, {
        queueAhead: claudeFindRunQueueAhead(store.runs, latest.id),
      });
      const prior = claudeFindRunHistoryForReservation(store.runs, reservationId);
      if (prior.length) history[reservationId] = prior;
    }
    return res.json({ runs, history, disabled: claudeFindRunsDisabled() });
  }));

  // Operator: cancel. Status flips immediately; the runner sees cancelled on
  // its next events flush and kills the CLI.
  app.post("/api/claude-find-runs/:id/cancel", guarded(async (req, res) => {
    if (!requireOperator(res)) return;
    const nowIso = new Date().toISOString();
    const view = await mutateStore((store) => {
      const run = findRun(store, String(req.params.id));
      if (!run) return null;
      run.cancelRequested = true;
      if (["queued", "claimed", "running", "attention"].includes(run.status)) {
        run.status = "cancelled";
        run.endedAt = nowIso;
        run.events.push({ at: nowIso, kind: "status", text: "Cancelled by the operator." });
      }
      return clientClaudeFindRunView(run);
    });
    if (!view) return res.status(404).json({ error: "Run not found" });
    return res.json({ run: view });
  }));

  // ── token-authed endpoints (auth-EXCLUDED prefix /api/claude-find-runs/agent/) ──

  // Runner wrapper: progress flush. Response carries {cancelled} so the
  // wrapper can kill the CLI promptly after an operator cancel.
  app.post("/api/claude-find-runs/agent/:id/events", guarded(async (req, res) => {
    const nowIso = new Date().toISOString();
    const body = (req.body ?? {}) as ClaudeFindRunUpdate & { events?: unknown };
    const result = await mutateStore((store) => {
      const run = findRun(store, String(req.params.id));
      if (!run) return { status: 404 as const };
      if (!runTokenMatches(run, req.header("x-run-token"))) return { status: 401 as const };
      const rawEvents = Array.isArray(body.events) ? body.events : [];
      const events = rawEvents
        .filter((e: any) => e && typeof e.text === "string" && typeof e.kind === "string")
        .slice(0, 40)
        .map((e: any) => ({
          at: typeof e.at === "string" ? e.at : nowIso,
          kind: (["status", "note", "action", "attention", "error"].includes(e.kind) ? e.kind : "note") as any,
          text: scrubClaudeFindRunToken(String(e.text).slice(0, 500), run.token),
        }));
      const update: ClaudeFindRunUpdate = {
        events,
        heartbeat: body.heartbeat === true,
        attention:
          typeof body.attention === "string"
            ? scrubClaudeFindRunToken(body.attention, run.token)
            : body.attention === null
            ? null
            : undefined,
        terminal:
          body.terminal && (body.terminal.status === "completed" || body.terminal.status === "failed")
            ? {
                status: body.terminal.status,
                report:
                  typeof body.terminal.report === "string"
                    ? scrubClaudeFindRunToken(body.terminal.report.slice(0, 20_000), run.token)
                    : null,
                error:
                  typeof body.terminal.error === "string"
                    ? scrubClaudeFindRunToken(body.terminal.error.slice(0, 2_000), run.token)
                    : null,
              }
            : undefined,
      };
      const alive = applyClaudeFindRunUpdate(run, update, nowIso);
      return { status: 200 as const, cancelled: !alive || run.cancelRequested };
    });
    if (result.status === 404) return res.status(404).json({ error: "Run not found" });
    if (result.status === 401) return res.status(401).json({ error: "Bad run token" });
    return res.json({ ok: true, cancelled: result.cancelled });
  }));

  // Agent: create a buy-in for one of the run's slots. propertyId/dates are
  // PINNED from the run record — the agent's body cannot retarget them.
  app.post("/api/claude-find-runs/agent/:id/buy-ins", guarded(async (req, res) => {
    const store = await readStore();
    const run = findRun(store, String(req.params.id));
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!runTokenMatches(run, req.header("x-run-token"))) return res.status(401).json({ error: "Bad run token" });
    if (!["claimed", "running", "attention"].includes(run.status)) {
      return res.status(409).json({ error: `Run is ${run.status} — attach calls are only valid while it is live` });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unitId = typeof body.unitId === "string" ? body.unitId : "";
    if (!run.unitIds.includes(unitId)) {
      return res.status(422).json({ error: `unitId must be one of this run's slots: ${run.unitIds.join(", ")}` });
    }
    const listingUrl = typeof body.airbnbListingUrl === "string" ? body.airbnbListingUrl.trim() : "";
    let host = "";
    try {
      host = new URL(listingUrl).hostname.toLowerCase();
    } catch {
      return res.status(422).json({ error: "airbnbListingUrl must be a valid listing URL" });
    }
    // CHANNEL rule 5, enforced server-side too: never attach an airbnb.com
    // link (any regional variant) — Airbnb is discovery-only in the brief.
    if (/(^|\.)airbnb\./.test(host)) {
      return res.status(422).json({ error: "Airbnb links can never be attached — find the unit's VRBO/Booking.com/direct page" });
    }
    // costPaid is REQUIRED, > 0 — this endpoint used to silently default a
    // missing price to "0". The agent hill-climbs against error messages
    // (proven in a real run: it iterated {} → {unitId} → {unitId,listingUrl} →
    // {unitId,airbnbListingUrl} until a 200), so a field the server accepts
    // when absent gets DROPPED. That produced $0 buy-ins even though the agent
    // had found real prices — and a $0 costPaid breaks the profit calc and the
    // checkout 15% guard, which anchor on it. Make it as hard a requirement as
    // unitId and the URL, so the agent's iteration lands on INCLUDING it.
    const rawCost = (body as Record<string, unknown>).costPaid;
    // Tolerate currency formatting ("$1,400.00", "1,400") — the agent's own
    // narration writes prices that way, and rejecting a REAL price it did send
    // is worse than accepting a formatted one. Strip $, commas, whitespace.
    const costPaid = typeof rawCost === "number"
      ? rawCost
      : typeof rawCost === "string"
        ? Number(rawCost.replace(/[$,\s]/g, ""))
        : NaN;
    if (!Number.isFinite(costPaid) || costPaid <= 0) {
      return res.status(422).json({
        error:
          "costPaid is required and must be the unit's total stay cost in dollars, greater than 0 "
          + "(e.g. 1400.00). It anchors the profit and 15% checkout guards — a buy-in with no price is invalid.",
      });
    }
    const forwarded = {
      propertyId: run.propertyId,
      propertyName: run.propertyName,
      unitId,
      unitLabel: typeof body.unitLabel === "string" ? body.unitLabel.slice(0, 200) : unitId,
      checkIn: run.checkIn,
      checkOut: run.checkOut,
      costPaid: costPaid.toFixed(2),
      airbnbListingUrl: listingUrl,
      unitAddress: typeof body.unitAddress === "string" ? body.unitAddress.slice(0, 400) : null,
      managementCompany: typeof body.managementCompany === "string" ? body.managementCompany.slice(0, 200) : null,
      groundFloorStatus: "unknown",
      status: "active",
      notes: typeof body.notes === "string" ? body.notes.slice(0, 2_000) : null,
    };
    try {
      const upstream = await fetch(`${loopbackBaseUrl()}/api/buy-ins`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
        body: JSON.stringify(forwarded),
      });
      const payload = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json(payload);
    } catch (e) {
      return res.status(502).json({ error: `Buy-in create failed: ${(e as Error)?.message ?? e}` });
    }
  }));

  // Agent: attach a created buy-in. The reservation is ALWAYS the run's own —
  // never read from the body.
  app.post("/api/claude-find-runs/agent/:id/attach", guarded(async (req, res) => {
    const store = await readStore();
    const run = findRun(store, String(req.params.id));
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!runTokenMatches(run, req.header("x-run-token"))) return res.status(401).json({ error: "Bad run token" });
    if (!["claimed", "running", "attention"].includes(run.status)) {
      return res.status(409).json({ error: `Run is ${run.status} — attach calls are only valid while it is live` });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const buyInId = Number(body.buyInId);
    if (!Number.isFinite(buyInId)) return res.status(422).json({ error: "buyInId (number) required" });
    const forwarded: Record<string, unknown> = { buyInId };
    if (body.force === true) forwarded.force = true;
    if (typeof body.overrideNote === "string") forwarded.overrideNote = body.overrideNote.slice(0, 500);
    try {
      const upstream = await fetch(
        `${loopbackBaseUrl()}/api/bookings/${encodeURIComponent(run.reservationId)}/attach-buy-in`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
          body: JSON.stringify(forwarded),
        },
      );
      const payload = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json(payload);
    } catch (e) {
      return res.status(502).json({ error: `Attach failed: ${(e as Error)?.message ?? e}` });
    }
  }));

  // Agent: record the guest-expectation verdict for the units it attached
  // (Phase 2 of the headless find-run, 2026-07-20). Run-scoped like the other
  // agent proxies — the agent never holds the admin secret. The reservation is
  // ALWAYS the run's own (pinned here, never read from the body), and source is
  // forced to "cowork". Read-only apart from stamping the verdict on the
  // reservation's attached buy-ins.
  app.post("/api/claude-find-runs/agent/:id/guest-happy", guarded(async (req, res) => {
    const store = await readStore();
    const run = findRun(store, String(req.params.id));
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!runTokenMatches(run, req.header("x-run-token"))) return res.status(401).json({ error: "Bad run token" });
    if (!["claimed", "running", "attention"].includes(run.status)) {
      return res.status(409).json({ error: `Run is ${run.status} — guest-happy calls are only valid while it is live` });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const verdict = String(body.verdict ?? "").trim().toLowerCase();
    if (!["happy", "concerns", "unhappy"].includes(verdict)) {
      return res.status(422).json({ error: "verdict must be one of: happy, concerns, unhappy" });
    }
    const feedback = typeof body.feedback === "string" ? body.feedback.slice(0, 2_000) : "";
    try {
      const upstream = await fetch(
        `${loopbackBaseUrl()}/api/bookings/${encodeURIComponent(run.reservationId)}/guest-happy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
          body: JSON.stringify({ verdict, feedback, source: "cowork" }),
        },
      );
      const payload = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json(payload);
    } catch (e) {
      return res.status(502).json({ error: `Guest-happy record failed: ${(e as Error)?.message ?? e}` });
    }
  }));

  // ── CHECKOUT-run agent proxies (2026-07-20) ───────────────────────────────
  // Same trust model as the find proxies, tightened one notch: every call is
  // pinned to the run's reservation AND its ONE buyInId — the agent's body
  // carries only the claimToken / guest-name fields / failure reason. A
  // prompt-injected checkout agent's blast radius is "prepare this one
  // already-approved unit's checkout lane until the run ends"; it can never
  // retarget another unit, another reservation, or write a booking result
  // (there is deliberately NO proxy for PATCHing bookingStatus — the operator
  // records the paid result themselves).

  /** Shared gate: live run, valid token, checkout kind with a pinned buy-in. */
  const checkoutRunFor = async (
    req: Request,
    res: Response,
  ): Promise<{ run: ClaudeFindRunRecord; buyInId: number } | null> => {
    const store = await readStore();
    const run = findRun(store, String(req.params.id));
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return null;
    }
    if (!runTokenMatches(run, req.header("x-run-token"))) {
      res.status(401).json({ error: "Bad run token" });
      return null;
    }
    if (!["claimed", "running", "attention"].includes(run.status)) {
      res.status(409).json({ error: `Run is ${run.status} — checkout calls are only valid while it is live` });
      return null;
    }
    const buyInId = Number(run.buyInId);
    if (run.kind !== "checkout" || !Number.isFinite(buyInId)) {
      res.status(403).json({ error: "This run is not a checkout run" });
      return null;
    }
    return { run, buyInId };
  };

  const forwardJson = async (res: Response, url: string, init: RequestInit, failLabel: string) => {
    try {
      const upstream = await fetch(url, init);
      const payload = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json(payload);
    } catch (e) {
      return res.status(502).json({ error: `${failLabel}: ${(e as Error)?.message ?? e}` });
    }
  };

  // Agent: read the run's ONE buy-in row (the brief's idempotency check).
  app.get("/api/claude-find-runs/agent/:id/buy-in", guarded(async (req, res) => {
    const gate = await checkoutRunFor(req, res);
    if (!gate) return;
    await forwardJson(
      res,
      `${loopbackBaseUrl()}/api/buy-ins/${gate.buyInId}`,
      { headers: loopbackRequestHeaders() },
      "Buy-in read failed",
    );
  }));

  // Agent: mint the buy-in's canonical traveler alias. Guest name fields come
  // from the body (they originate from the brief itself), everything else is
  // pinned.
  app.post("/api/claude-find-runs/agent/:id/traveler-email", guarded(async (req, res) => {
    const gate = await checkoutRunFor(req, res);
    if (!gate) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    await forwardJson(
      res,
      `${loopbackBaseUrl()}/api/buy-ins/${gate.buyInId}/traveler-email`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
        body: JSON.stringify({
          reservationId: gate.run.reservationId,
          guestFirstName: typeof body.guestFirstName === "string" ? body.guestFirstName.slice(0, 80) : "",
          guestLastName: typeof body.guestLastName === "string" ? body.guestLastName.slice(0, 120) : "",
        }),
      },
      "Traveler-email mint failed",
    );
  }));

  // Agent: claim / complete / release the reservation's one checkout lane.
  // The claimToken is the agent's own idempotency token (cowork_UUID per the
  // brief); the claim system's semantics are untouched — these only pin WHO
  // the claim is for.
  const claimProxy = (suffix: "" | "/complete" | "/release") =>
    guarded(async (req: Request, res: Response) => {
      const gate = await checkoutRunFor(req, res);
      if (!gate) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const claimToken = typeof body.claimToken === "string" ? body.claimToken.slice(0, 120) : "";
      if (!claimToken) return res.status(422).json({ error: "claimToken required" });
      const forwarded: Record<string, unknown> = {
        reservationId: gate.run.reservationId,
        buyInId: gate.buyInId,
        claimToken,
      };
      if (suffix === "/release") {
        forwarded.reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "released by the headless checkout run";
      }
      await forwardJson(
        res,
        `${loopbackBaseUrl()}/api/cowork/checkout-claims${suffix}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...loopbackRequestHeaders() },
          body: JSON.stringify(forwarded),
        },
        `Checkout claim${suffix || " create"} failed`,
      );
    });
  app.post("/api/claude-find-runs/agent/:id/checkout-claim", claimProxy(""));
  app.post("/api/claude-find-runs/agent/:id/checkout-claim/complete", claimProxy("/complete"));
  app.post("/api/claude-find-runs/agent/:id/checkout-claim/release", claimProxy("/release"));
}

// ── watchdog (started from server/index.ts after listen) ────────────────────
let watchdogTimer: NodeJS.Timeout | null = null;

export function startClaudeFindRunWatchdog(): void {
  if (watchdogTimer || process.env.CLAUDE_FIND_RUN_WATCHDOG_DISABLED === "1") return;
  watchdogTimer = setInterval(() => {
    void mutateStore((store) => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      // Runner-activity context (bulk, 2026-07-20): queued runs waiting behind
      // a live run must not be failed as "runner never picked this up".
      // Computed BEFORE any verdicts so one tick judges a consistent snapshot.
      const activity = claudeFindRunnerActivity(store.runs, nowMs);
      for (const run of store.runs) {
        const verdict = claudeFindRunWatchdogVerdict(run, nowMs, activity);
        if (verdict.action === "fail") {
          run.status = "failed";
          run.error = verdict.error ?? "Watchdog closed the run.";
          run.endedAt = nowIso;
          run.events.push({ at: nowIso, kind: "error", text: run.error });
          console.warn(`[claude-find-runs] watchdog failed run ${run.id}: ${run.error}`);
        }
      }
    });
  }, 60_000);
  watchdogTimer.unref?.();
}
