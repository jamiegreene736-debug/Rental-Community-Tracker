import type { Express, Response } from "express";
import { and, eq, gt, lt } from "drizzle-orm";
import { coworkPromptRuns } from "@shared/schema";
import { db } from "./db";
import {
  BuyInCheckoutClaimError,
  claimBuyInCheckout,
  completeBuyInCheckoutClaim,
  failBuyInCheckoutClaim,
  resetBuyInCheckoutClaim,
  startBuyInCheckoutClaimReaper,
} from "./buy-in-checkout-claims";

export const COWORK_PROMPT_RUN_TTL_MS = 24 * 60 * 60 * 1_000;
// Eight combined reservation briefs are ~181k with ordinary names. Keep
// enough headroom for long property/unit labels while remaining far below the
// app's 10 MB JSON-body ceiling.
export const COWORK_PROMPT_RUN_MAX_CHARS = 500_000;

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_KINDS = new Set(["find-and-prepare", "prepare-checkout", "bulk-find-and-prepare"]);

type PortalSession = { role?: string } | undefined;

function requireOperator(res: Response): boolean {
  const session = res.locals.portalSession as PortalSession;
  if (session?.role === "admin") return true;
  res.status(403).json({ error: "Only the operator can use Cowork workflow routes" });
  return false;
}

function claimErrorResponse(res: Response, error: unknown): Response {
  if (error instanceof BuyInCheckoutClaimError) {
    return res.status(error.status).json({ error: error.message });
  }
  throw error;
}

/**
 * Authenticated, short-lived prompt relay for Cowork. This avoids putting a
 * large prompt in Claude Desktop's silently-truncated `claude://...?q=` value.
 * The endpoint is deliberately inside the normal portal auth gate and returns
 * plain text so Cowork can read the complete brief in the operator's real
 * Chrome session. It never stores or returns payment-card data.
 */
export function registerCoworkPromptRunRoutes(app: Express): void {
  startBuyInCheckoutClaimReaper();

  app.post("/api/cowork/checkout-claims", async (req, res) => {
    if (!requireOperator(res)) return;
    if (!req.is("application/json")) {
      return res.status(415).json({ error: "Content-Type must be application/json" });
    }

    try {
      const outcome = await claimBuyInCheckout({
        reservationId: req.body?.reservationId,
        buyInId: req.body?.buyInId,
        claimToken: req.body?.claimToken,
        owner: "cowork",
      });
      return res.status(200).json(outcome);
    } catch (error) {
      return claimErrorResponse(res, error);
    }
  });

  app.post("/api/cowork/checkout-claims/complete", async (req, res) => {
    if (!requireOperator(res)) return;
    try {
      await completeBuyInCheckoutClaim({
        reservationId: req.body?.reservationId,
        buyInId: req.body?.buyInId,
        claimToken: req.body?.claimToken,
        owner: "cowork",
      });
      return res.json({ ok: true, bookingStatus: "awaiting_payment" });
    } catch (error) {
      return claimErrorResponse(res, error);
    }
  });

  app.post("/api/cowork/checkout-claims/release", async (req, res) => {
    if (!requireOperator(res)) return;
    try {
      await failBuyInCheckoutClaim(
        {
          reservationId: req.body?.reservationId,
          buyInId: req.body?.buyInId,
          claimToken: req.body?.claimToken,
          owner: "cowork",
        },
        req.body?.reason,
      );
      return res.json({ ok: true, bookingStatus: "failed" });
    } catch (error) {
      return claimErrorResponse(res, error);
    }
  });

  app.post("/api/cowork/checkout-claims/reset", async (req, res) => {
    if (!requireOperator(res)) return;
    try {
      await resetBuyInCheckoutClaim(req.body?.reservationId, req.body?.buyInId);
      return res.json({ ok: true, bookingStatus: "failed" });
    } catch (error) {
      return claimErrorResponse(res, error);
    }
  });

  app.post("/api/cowork/prompt-runs", async (req, res) => {
    if (!requireOperator(res)) return;
    if (!req.is("application/json")) {
      return res.status(415).json({ error: "Content-Type must be application/json" });
    }

    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const kind = typeof req.body?.kind === "string" ? req.body.kind.trim() : "";
    const reservationId = typeof req.body?.reservationId === "string"
      ? req.body.reservationId.trim().slice(0, 200) || null
      : null;

    if (!prompt) return res.status(400).json({ error: "Prompt is required" });
    if (prompt.length > COWORK_PROMPT_RUN_MAX_CHARS) {
      return res.status(413).json({ error: `Prompt exceeds ${COWORK_PROMPT_RUN_MAX_CHARS} characters` });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return res.status(400).json({ error: "Unsupported Cowork prompt-run kind" });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + COWORK_PROMPT_RUN_TTL_MS);
    // Cleanup is opportunistic: an expired-row deletion failure must not turn a
    // valid operator launch into an outage. The expiry predicate still makes an
    // old row unreadable even if cleanup is temporarily unavailable.
    await db.delete(coworkPromptRuns).where(lt(coworkPromptRuns.expiresAt, now)).catch(() => undefined);

    const [run] = await db
      .insert(coworkPromptRuns)
      .values({ kind, reservationId, prompt, expiresAt })
      .returning({ id: coworkPromptRuns.id, expiresAt: coworkPromptRuns.expiresAt });

    if (!run) return res.status(500).json({ error: "Could not create Cowork prompt run" });
    return res.status(201).json({
      id: run.id,
      path: `/api/cowork/prompt-runs/${run.id}`,
      expiresAt: run.expiresAt.toISOString(),
    });
  });

  app.get("/api/cowork/prompt-runs/:id", async (req, res) => {
    if (!requireOperator(res)) return;
    const id = String(req.params.id ?? "").trim();
    if (!RUN_ID_RE.test(id)) return res.status(404).type("text/plain").send("Cowork prompt run not found.");

    const now = new Date();
    const [run] = await db
      .select({ prompt: coworkPromptRuns.prompt })
      .from(coworkPromptRuns)
      .where(and(eq(coworkPromptRuns.id, id), gt(coworkPromptRuns.expiresAt, now)))
      .limit(1);

    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (!run) return res.status(404).type("text/plain").send("Cowork prompt run not found or expired.");
    return res.status(200).type("text/plain; charset=utf-8").send(run.prompt);
  });
}
