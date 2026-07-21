import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes, startBulkPricingResumeWatchdog } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startWeeklyScheduler, cleanupStaleRuns } from "./availability-scanner";
import { startAutoApproveScheduler } from "./auto-approve";
import { startAutoReplyScheduler } from "./auto-reply";
import { startAvailabilityScheduler } from "./availability-scheduler";
import { startPhotoListingScheduler } from "./photo-listing-scanner";
import { startReplacementFindResumeWatchdog } from "./preflight-background-jobs";
import { startAutoReplaceResumeWatchdog } from "./auto-replace-jobs";
import { startClaudeFindRunWatchdog } from "./claude-find-runs";
import { startUnitAuditResumeWatchdog } from "./unit-audit-sweep";
import { startUnitAuditAutoScheduler } from "./unit-audit-scheduler";
import { startBookingConfirmationScheduler } from "./booking-confirmations";
import { startGuestReceiptScheduler } from "./guest-receipts";
import { startGuestComplaintScanner } from "./guest-complaint-scanner";
import { startPropertyRevenueScheduler } from "./property-revenue-scheduler";
import { startMarketRateScheduler } from "./market-rate-scheduler";
import { startGuestInboxSyncScheduler } from "./guest-inbox-sync";
import { startBuyInVendorEmailSyncScheduler } from "./buy-in-email-sync";
import { warmGuestyListingsCache } from "./guesty-listings-cache";
import { warmOperationsReservationsCache } from "./guesty-reservations-cache";
import { sanitizeForChatText, sanitizeForChatValue } from "@shared/safe-log";
import { ensureRuntimeSchema } from "./schema-maintenance";
import { ensureTopMarketScanCacheLogicVersion, refreshTopMarketScanCacheComboFlags } from "./top-market-scan-cache";
import { requireAuth, loginPageHandler, loginPostHandler, logoutHandler } from "./auth";
import { installSearchApiFetchFallback } from "./searchapi";

installSearchApiFetchFallback();

// 2026-07-11 security fix: fail CLOSED in production. server/auth.ts is a
// documented no-op when ADMIN_SECRET is unset — convenient for local dev, but
// in production that means the entire portal (Guesty token, guest PII, inbox
// send, bookings, pricing) is anonymously reachable as admin. Refuse to boot
// so a cleared/typo'd/missing env var can never silently open the gate.
if (process.env.NODE_ENV === "production" && !(process.env.ADMIN_SECRET ?? "").trim()) {
  console.error(
    "[fatal] ADMIN_SECRET is not set in production — refusing to start with the auth gate disabled. " +
      "Set ADMIN_SECRET in the environment (Railway variables) and redeploy.",
  );
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// 2026-07-11 security fix: baseline security response headers on every route.
// Deliberately a small hand-rolled middleware rather than `helmet` — helmet's
// default Content-Security-Policy would break the SPA (inline styles on the
// login page + the built bundle) and its COEP/CORP defaults would block the
// cross-origin CDN images the guest pages render, and pulling it in just to
// disable those is more risk than value. These four headers are the useful,
// non-breaking subset: block MIME sniffing, deny framing (clickjacking), trim
// the Referer, and pin HTTPS in production.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${sanitizeForChatText(message, { maxLength: 4_000 })}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(sanitizeForChatValue(capturedJsonResponse, { maxLength: 1_000, maxArrayLength: 5 }))}`;
      }

      log(logLine);
    }
  });

  next();
});

// Single-password gate. No-op when ADMIN_SECRET env var is unset, so
// cold deploys + local dev keep working. See server/auth.ts for the
// full whitelist (sidecar, loopback, /login, static assets) and the
// "FOUR EXCLUSIONS" inline comment for why each one is load-bearing.
//
// Login routes are registered BEFORE requireAuth even though the
// middleware whitelists them — Express short-circuits on the first
// matching route, which avoids touching the auth check for the most
// common public-path requests. NOTE FOR CODEX: this ordering is not
// strictly required (the whitelist would handle it either way), but
// it keeps the hot path one function call shorter and makes the auth
// flow easier to reason about.
app.get("/login", loginPageHandler);
app.post("/login", loginPostHandler);
app.post("/logout", logoutHandler);
// Railway deploy healthcheck (railway.json healthcheckPath). With a healthcheck
// configured, Railway keeps the OLD container serving until this returns 200 on
// the NEW one — which is what stops every deploy from blackholing the portal
// with "connection refused" 502s for the 1-3 min boot window (photos-volume
// seed + db:push + ensureRuntimeSchema all run before listen()). A 200 here
// genuinely means "ready": this route can only answer once httpServer.listen()
// has run, which is after schema sync and route registration. Deliberately NO
// DB probe — a transient Postgres blip must not make Railway fail a healthy
// deploy. Registered before requireAuth (and whitelisted in server/auth.ts)
// because Railway's prober carries no auth cookie/secret.
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.use(requireAuth);
app.get("/api/auth/session", (_req, res) => {
  const session = res.locals.portalSession ?? { role: "admin", username: "admin" };
  res.json({ authenticated: true, role: session.role, username: session.username });
});

(async () => {
  await ensureRuntimeSchema();
  await ensureTopMarketScanCacheLogicVersion();
  // Rewrite any cached market scans through filterTopScanComboCandidates so a
  // community now disqualified by the location guard (e.g. "Bay Watch" cached
  // under a Florida market) is physically removed from the stored JSON on
  // deploy — not just hidden at serve time. Idempotent; only changed rows write.
  await refreshTopMarketScanCacheComboFlags().catch((e: any) =>
    console.warn(`[top-market-scan-cache] boot location/combo scrub failed: ${e?.message ?? e}`),
  );
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = sanitizeForChatText(err.message || "Internal Server Error", { maxLength: 1_000 });

    console.error("Internal Server Error:", sanitizeForChatText(err, { maxLength: 4_000 }));

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    async () => {
      log(`serving on port ${port}`);
      // Resume buy-in searches a redeploy killed mid-run (auto-fill rows +
      // the bulk queue). Deferred a few seconds: the ladder self-calls over
      // loopback HTTP, so the server must be fully listening and warmed, and
      // boot-time schedulers below get first claim on the event loop. Gate:
      // AUTO_FILL_RESUME=0 disables. See server/auto-fill-resume.ts.
      setTimeout(() => {
        void import("./auto-fill-resume")
          .then((m) => m.resumeInterruptedAutoFillWork())
          .catch((err) => console.error("[auto-fill-resume] boot resume failed:", err?.message ?? err));
      }, 15_000);
      // Resume any dashboard bulk market-pricing queue a redeploy/restart
      // orphaned, and keep watching for orphans — the operator starts a mass
      // update from a phone and closes Safari, so no client poll can be relied
      // on to re-claim the job. Gate: BULK_PRICING_RESUME_DISABLED=1.
      startBulkPricingResumeWatchdog();
      // Same survivability for the find-a-replacement-unit search: the operator
      // taps Replace photos on a phone and hops to another app, so a
      // redeploy/restart mid-search must be re-launched server-side (same job
      // id) without waiting for a browser poll. Gate: REPLACEMENT_RESUME_DISABLED=1.
      startReplacementFindResumeWatchdog();
      // One-click auto-replace orchestrator (find → auto-commit → verify) —
      // resume orphaned jobs the same way. Gate: AUTO_REPLACE_RESUME_DISABLED=1.
      startAutoReplaceResumeWatchdog();
      // Headless Claude find-runs: close orphaned runs honestly (Mac runner
      // offline / went silent / 90-min ceiling) so a row never spins forever.
      // Gate: CLAUDE_FIND_RUN_WATCHDOG_DISABLED=1.
      startClaudeFindRunWatchdog();
      // Unit Audit Sweep (dashboard "Audit" column) — resume orphaned sweeps
      // after a restart. Gate: UNIT_AUDIT_RESUME_DISABLED=1.
      startUnitAuditResumeWatchdog();
      // Weekly auto-audit: every mapped property gets a full sweep with
      // auto-fix ON so the Audit/Comm QA columns keep themselves green.
      // Gate: UNIT_AUDIT_AUTO_DISABLED=1; replacement rung needs
      // UNIT_AUDIT_CRON_REPLACE=1.
      startUnitAuditAutoScheduler();
      await cleanupStaleRuns();
      startWeeklyScheduler();
      startAutoApproveScheduler();
      startAutoReplyScheduler();
      startAvailabilityScheduler();
      startPhotoListingScheduler();
      startBookingConfirmationScheduler();
      startGuestReceiptScheduler();
      startGuestComplaintScanner();
      startGuestInboxSyncScheduler();
      startBuyInVendorEmailSyncScheduler();
      startPropertyRevenueScheduler();
      startMarketRateScheduler();
      // Prime the Operations Property dropdown + global-summary listing set so
      // the operator's first page load reads from memory instead of paying for
      // two serialized Guesty paginations. Fire-and-forget; swallows its own
      // errors so a Guesty outage at boot can't crash startup.
      void warmGuestyListingsCache().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err ?? "");
        console.warn("[guesty-listings-cache] boot warm failed:", message);
      });
      // Same for the default Operations RESERVATION pull (the guesty-all main
      // pass) — the heaviest single interactive Guesty pagination.
      void warmOperationsReservationsCache().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err ?? "");
        console.warn("[guesty-reservations-cache] boot warm failed:", message);
      });
      const startTopMarketCacheRefresh = app.get("startTopMarketCacheRefresh") as
        | (() => Promise<unknown>)
        | undefined;
      if (startTopMarketCacheRefresh) {
        void startTopMarketCacheRefresh().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err ?? "");
          console.warn("[top-market-scan-cache] boot refresh failed:", message);
        });
      }
    },
  );
})();
