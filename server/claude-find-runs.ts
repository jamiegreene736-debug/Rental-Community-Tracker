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
  CLAUDE_FIND_RUN_STORE_KEY,
  activeClaudeFindRunForReservation,
  applyClaudeFindRunUpdate,
  claimNextClaudeFindRun,
  claudeFindRunWatchdogVerdict,
  clientClaudeFindRunView,
  latestClaudeFindRunForReservation,
  parseClaudeFindRunStore,
  scrubClaudeFindRunToken,
  serializeClaudeFindRunStore,
} from "@shared/claude-find-run";
import { buildCoworkBuyInPrompt, type CoworkBuyInPromptInput } from "@shared/cowork-buyin-prompt";

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
      const active = activeClaudeFindRunForReservation(store.runs, input.reservationId);
      if (active) return { conflict: clientClaudeFindRunView(active) };
      const id = randomUUID();
      const token = randomBytes(24).toString("hex");
      const prompt = buildCoworkBuyInPrompt(
        { ...input, baseUrl: apiRoot },
        { headlessRun: { runId: id, runToken: token } },
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
      return { run: clientClaudeFindRunView(run) };
    });
    if ("conflict" in result && result.conflict) {
      return res.status(409).json({ error: "A find-run is already active for this reservation", run: result.conflict });
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
    for (const reservationId of ids) {
      const latest = latestClaudeFindRunForReservation(store.runs, reservationId);
      if (latest) runs[reservationId] = clientClaudeFindRunView(latest);
    }
    return res.json({ runs, disabled: claudeFindRunsDisabled() });
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
    const forwarded = {
      propertyId: run.propertyId,
      propertyName: run.propertyName,
      unitId,
      unitLabel: typeof body.unitLabel === "string" ? body.unitLabel.slice(0, 200) : unitId,
      checkIn: run.checkIn,
      checkOut: run.checkOut,
      costPaid: typeof body.costPaid === "string" || typeof body.costPaid === "number" ? String(body.costPaid) : "0",
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
}

// ── watchdog (started from server/index.ts after listen) ────────────────────
let watchdogTimer: NodeJS.Timeout | null = null;

export function startClaudeFindRunWatchdog(): void {
  if (watchdogTimer || process.env.CLAUDE_FIND_RUN_WATCHDOG_DISABLED === "1") return;
  watchdogTimer = setInterval(() => {
    void mutateStore((store) => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      for (const run of store.runs) {
        const verdict = claudeFindRunWatchdogVerdict(run, nowMs);
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
