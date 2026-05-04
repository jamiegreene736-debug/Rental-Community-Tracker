import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startWeeklyScheduler, cleanupStaleRuns } from "./availability-scanner";
import { startAutoApproveScheduler } from "./auto-approve";
import { startAutoReplyScheduler } from "./auto-reply";
import { startAvailabilityScheduler } from "./availability-scheduler";
import { startPhotoListingScheduler } from "./photo-listing-scanner";
import { startBookingConfirmationScheduler } from "./booking-confirmations";
import { sanitizeForChatText, sanitizeForChatValue } from "@shared/safe-log";
import { ensureRuntimeSchema } from "./schema-maintenance";
import { requireAuth, loginPageHandler, loginPostHandler, logoutHandler } from "./auth";

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
app.use(requireAuth);

(async () => {
  await ensureRuntimeSchema();
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
      await cleanupStaleRuns();
      startWeeklyScheduler();
      startAutoApproveScheduler();
      startAutoReplyScheduler();
      startAvailabilityScheduler();
      startPhotoListingScheduler();
      startBookingConfirmationScheduler();
    },
  );
})();
