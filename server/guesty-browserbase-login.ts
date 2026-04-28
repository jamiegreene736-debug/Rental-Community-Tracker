// Self-healing Guesty session refresh via Browserbase persistent context.
//
// Why this exists: the steady-state Guesty admin path uses vanilla
// rebrowser-playwright + the Dockerfile's Chromium, which is cheap (~$0
// per session) and works fine while session cookies are valid. The
// problem is the COOKIE EXPIRY path: when cookies lapse, the refresh
// requires Google SSO from Railway's datacenter IP, which Google's
// "verify it's you" challenges block. Per AGENTS.md #28, the
// previously-documented answer was "operator manually re-pastes cookies
// into Railway env vars" — ~5 min of toil per refresh, every 1-2 weeks.
//
// This module replaces the manual step with a Browserbase residential-IP
// session attached to a persistent context. The context is bootstrapped
// once (operator pastes their browser cookies + Okta token, the bootstrap
// endpoint creates a Browserbase context and seeds it). After that,
// every subsequent refresh:
//
//   1. Connects to the persistent context (cookies + Google device-trust
//      cookie travel along — Google sees the same "browser" that
//      successfully logged in before, so challenges don't fire)
//   2. Navigates to app.guesty.com
//   3. If still logged in (the common case after the cookies in the
//      context get rotated by Guesty automatically) → just extract +
//      return them
//   4. If bounced to /auth/login → drives the SSO or native login,
//      lets Guesty issue fresh cookies, then extracts
//   5. Writes the freshly-extracted cookies + Okta token back to the
//      session cache, where the steady-state Playwright path will pick
//      them up on the next request
//
// The persistent context's `persist: true` flag also means cookies
// rotated mid-session (e.g. Guesty's session refresh) get saved back to
// the context for next time.
//
// Cost: ~$0.20 per refresh × ~30-50 refreshes/year ≈ $6-10/year. Vs.
// however much operator time the manual refresh was costing.

import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";
import {
  resolveBrowserbaseContextId,
  setCachedSession,
  type RawCookieRecord,
} from "./guesty-session-cache";
import type { Trace } from "./guesty-playwright";

type RefreshOk = {
  ok: true;
  cookieCount: number;
  oktaTokenSet: boolean;
  finalUrl: string;
  contextId: string;
  durationMs: number;
};

type RefreshErr = {
  ok: false;
  error: string;
  finalUrl?: string;
  trace: Trace;
};

/**
 * One-time bootstrap: create a Browserbase persistent context, seed it
 * with the operator's browser cookies + Okta token, run a verification
 * navigation to confirm Guesty accepts the session, save the context ID
 * to the session cache.
 *
 * Idempotent in the sense that calling it again replaces the context ID
 * with a fresh one. The previous context's data isn't deleted from
 * Browserbase — the operator can clean those up via Browserbase's
 * dashboard if they care, but it's not load-bearing.
 *
 * Returns the new context ID on success so the caller can echo it back
 * to the operator (handy for debugging if they need to share the ID with
 * support).
 */
export async function bootstrapBrowserbaseContext(opts: {
  cookies: RawCookieRecord[];
  oktaTokenStorage: string;
}): Promise<RefreshOk | RefreshErr> {
  const trace: Trace = [];
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    return {
      ok: false,
      error:
        "BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set on Railway. Both are required for the persistent-context refresh path.",
      trace,
    };
  }
  if (!opts.cookies || opts.cookies.length === 0) {
    return {
      ok: false,
      error:
        "No cookies provided. Bootstrap needs at least your app.guesty.com session cookies (and ideally accounts.google.com cookies too, so Google's device-trust cookie persists in the context).",
      trace,
    };
  }
  if (!opts.oktaTokenStorage) {
    return {
      ok: false,
      error:
        "okta-token-storage value missing. Open DevTools on app.guesty.com → Application → Local Storage → copy the okta-token-storage value.",
      trace,
    };
  }

  const startedAt = Date.now();
  const bb = new Browserbase({ apiKey });

  // Create the new context. Browserbase returns an ID we treat as opaque.
  let contextId: string;
  try {
    const ctxResp = await bb.contexts.create({ projectId });
    contextId = ctxResp.id;
    trace.push({ step: "context-created", detail: contextId });
  } catch (err: any) {
    return {
      ok: false,
      error: `Browserbase contexts.create failed: ${err?.message ?? String(err)}`,
      trace,
    };
  }

  return runRefreshSession({
    apiKey,
    projectId,
    contextId,
    seedCookies: opts.cookies,
    seedOktaToken: opts.oktaTokenStorage,
    startedAt,
    trace,
    persistContextId: true,
  });
}

/**
 * Run the refresh session against the bootstrapped context. Called by
 * the auto-refresh path inside openGuestyAdminPage (no operator
 * involvement). Errors out clearly if no context has been bootstrapped.
 */
export async function refreshGuestySessionViaBrowserbase(): Promise<RefreshOk | RefreshErr> {
  const trace: Trace = [];
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    return {
      ok: false,
      error:
        "BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set. Skipping Browserbase refresh; operator should fall back to manual cookie paste via /api/admin/guesty/save-session.",
      trace,
    };
  }
  const contextId = resolveBrowserbaseContextId();
  if (!contextId) {
    return {
      ok: false,
      error:
        "Browserbase persistent context not bootstrapped. POST /api/admin/guesty/bootstrap-browserbase-context with cookies + okta-token-storage to set it up (one-time).",
      trace,
    };
  }
  return runRefreshSession({
    apiKey,
    projectId,
    contextId,
    seedCookies: null,
    seedOktaToken: null,
    startedAt: Date.now(),
    trace,
    persistContextId: false,
  });
}

/**
 * Shared session driver. Bootstrap and steady-state refresh share
 * everything except whether they seed cookies/storage on entry and
 * whether they save the context ID at the end.
 */
async function runRefreshSession(opts: {
  apiKey: string;
  projectId: string;
  contextId: string;
  seedCookies: RawCookieRecord[] | null;
  seedOktaToken: string | null;
  startedAt: number;
  trace: Trace;
  persistContextId: boolean;
}): Promise<RefreshOk | RefreshErr> {
  const { apiKey, projectId, contextId, trace } = opts;
  const bb = new Browserbase({ apiKey });

  let session: Awaited<ReturnType<typeof bb.sessions.create>>;
  try {
    session = await bb.sessions.create({
      projectId,
      proxies: true,
      browserSettings: {
        context: { id: contextId, persist: true },
        viewport: { width: 1440, height: 900 },
        // Browserbase auto-solves common CAPTCHAs server-side. Cheap
        // insurance against Google's identifier-step CAPTCHA, which is
        // the failure mode the manual-refresh path was hitting.
        solveCaptchas: true,
      },
    });
    trace.push({ step: "browserbase-session-created", detail: session.id });
  } catch (err: any) {
    return {
      ok: false,
      error: `Browserbase sessions.create failed: ${err?.message ?? String(err)}`,
      trace,
    };
  }

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    // Browserbase preloads one context + one page per session. Reuse
    // them — creating a new context here would not inherit the
    // persistent context's cookies (Browserbase only attaches the
    // context to the FIRST context of the session).
    const ctx = browser.contexts()[0];
    if (!ctx) {
      throw new Error("Browserbase session opened but no contexts attached");
    }

    // Seed cookies / Okta token on bootstrap. Steady-state refresh
    // skips this — the persistent context already has the values.
    if (opts.seedCookies && opts.seedCookies.length > 0) {
      await ctx.addCookies(toPlaywrightCookies(opts.seedCookies));
      trace.push({
        step: "seeded-cookies",
        detail: `${opts.seedCookies.length} cookies`,
      });
    }

    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // Land on app.guesty.com first so the localStorage origin matches
    // before we inject the Okta token. localStorage is per-origin —
    // setting it before the page is on a guesty.com URL would write to
    // about:blank's storage and the SPA would never see it.
    trace.push({ step: "navigating-to-guesty" });
    await page.goto("https://app.guesty.com/", {
      waitUntil: "domcontentloaded",
      timeout: 35000,
    });
    await page.waitForTimeout(3000);

    if (opts.seedOktaToken) {
      await page.evaluate((tok) => {
        try {
          window.localStorage.setItem("okta-token-storage", tok);
        } catch {
          /* origin storage blocked; rare */
        }
      }, opts.seedOktaToken);
      // Reload so the SPA picks up the seeded token before its first
      // auth check runs.
      await page.goto("https://app.guesty.com/", {
        waitUntil: "domcontentloaded",
        timeout: 35000,
      });
      await page.waitForTimeout(5000);
      trace.push({ step: "seeded-okta-token-and-reloaded" });
    }

    // If we're on the dashboard (not /auth/login), the persistent
    // context already has a working session — just harvest cookies
    // and storage. If we're on /auth/login, drive the SSO flow.
    const url = page.url();
    if (/\/auth\/login/i.test(url)) {
      trace.push({
        step: "on-login-driving-sso",
        detail: "persistent context session expired or never had one",
      });
      const loginRes = await driveGuestyLogin(page, trace);
      if (!loginRes.ok) {
        return {
          ok: false,
          error: loginRes.error,
          finalUrl: page.url(),
          trace,
        };
      }
    } else {
      trace.push({
        step: "already-logged-in",
        detail: "persistent context skipped login entirely",
      });
    }

    // Harvest. ctx.cookies() returns ALL cookies across the context,
    // so we filter to the domains we care about.
    const allCookies = await ctx.cookies();
    const guestyCookies = allCookies.filter((c) =>
      /guesty\.com|okta(?:preview)?\.com|cloudflare/i.test(c.domain),
    );
    const oktaTokenStorage = await page
      .evaluate(() => {
        try {
          return window.localStorage.getItem("okta-token-storage");
        } catch {
          return null;
        }
      })
      .catch(() => null);

    const cookieRecords: RawCookieRecord[] = guestyCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expirationDate: typeof c.expires === "number" && c.expires > 0 ? c.expires : undefined,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));

    if (cookieRecords.length === 0) {
      return {
        ok: false,
        error:
          "Browserbase session reached app.guesty.com but no Guesty cookies were extracted. The session may have hit an unexpected wall — check the trace.",
        finalUrl: page.url(),
        trace,
      };
    }

    setCachedSession(
      {
        cookies: cookieRecords,
        oktaTokenStorage: oktaTokenStorage ?? null,
        ...(opts.persistContextId ? { browserbaseContextId: contextId } : {}),
      },
      opts.persistContextId ? "manual-paste" : "browserbase-refresh",
    );
    trace.push({
      step: "wrote-cache",
      detail: `cookies=${cookieRecords.length} okta=${!!oktaTokenStorage}`,
    });

    return {
      ok: true,
      cookieCount: cookieRecords.length,
      oktaTokenSet: !!oktaTokenStorage,
      finalUrl: page.url(),
      contextId,
      durationMs: Date.now() - opts.startedAt,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: `Browserbase refresh failed: ${err?.message ?? String(err)}`,
      trace,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await bb.sessions
      .update(session.id, { projectId, status: "REQUEST_RELEASE" })
      .catch(() => {});
  }
}

/**
 * Drive Guesty's login UI from a Browserbase page. Tries Google SSO
 * first when GOOGLE_PASSWORD is set and the SSO button is present, then
 * falls back to native email/password. Mirrors the dispatch order in
 * loginToGuestyIfNeeded but slimmed down — Browserbase's residential IP
 * + persistent context's device-trust cookie make the previously-failing
 * Google challenges rare, so the heroics that loginToGuestyViaGoogleSso
 * does (2captcha, MFA fetch, etc.) aren't strictly needed here.
 *
 * If we hit a challenge anyway, return a clear error and let the
 * operator re-bootstrap the context.
 */
async function driveGuestyLogin(
  page: import("playwright").Page,
  trace: Trace,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Check for Google SSO button first.
  const googlePassword = process.env.GOOGLE_PASSWORD;
  const googleEmail = process.env.GOOGLE_EMAIL || process.env.GUESTY_EMAIL;

  if (googlePassword && googleEmail) {
    const ssoBtn = await page
      .$(
        'button:has-text("Sign in with Google"), button:has-text("Continue with Google"), [data-provider="google" i]',
      )
      .catch(() => null);
    if (ssoBtn) {
      trace.push({ step: "clicking-sso-button" });
      const popupPromise = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
      await ssoBtn.click().catch(() => {});
      const popup = await popupPromise;
      const target = popup ?? page;
      await target.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await target.waitForTimeout(2000);

      const emailInput = await target
        .waitForSelector('input[type="email"], input[id="identifierId"]', {
          timeout: 15000,
        })
        .catch(() => null);
      if (emailInput) {
        await emailInput.fill(googleEmail);
        await target
          .click('#identifierNext, button:has-text("Next")', { timeout: 5000 })
          .catch(() => {});
        trace.push({ step: "google-email-submitted" });
      }

      const passwordInput = await target
        .waitForSelector('input[type="password"]', { timeout: 25000 })
        .catch(() => null);
      if (!passwordInput) {
        return {
          ok: false,
          error:
            "Google didn't show a password field within 25s after email submit. Likely a Google challenge (verify-it's-you / 2SV). Bootstrap a fresh context — open accounts.google.com in your browser, complete any challenges, export cookies, and POST /api/admin/guesty/bootstrap-browserbase-context again.",
        };
      }
      await passwordInput.fill(googlePassword);
      await target
        .click('#passwordNext, button:has-text("Next"), button:has-text("Sign in")', {
          timeout: 5000,
        })
        .catch(() => {});
      trace.push({ step: "google-password-submitted" });

      // Wait until we land back on app.guesty.com (popup closes or
      // top-level navigates).
      try {
        await page.waitForURL(
          (u) => /app\.guesty\.com/i.test(u.toString()) && !/\/auth\//i.test(u.toString()),
          { timeout: 60000 },
        );
        trace.push({ step: "google-sso-completed" });
        return { ok: true };
      } catch {
        return {
          ok: false,
          error:
            "Google login submitted but app.guesty.com didn't return to a logged-in state within 60s. Likely a post-password challenge — re-bootstrap.",
        };
      }
    }
    trace.push({ step: "no-sso-button-falling-through" });
  }

  // Native email/password fallback.
  const guestyEmail = process.env.GUESTY_EMAIL;
  const guestyPassword = process.env.GUESTY_PASSWORD;
  if (!guestyEmail || !guestyPassword) {
    return {
      ok: false,
      error:
        "On Guesty login page and no usable credentials. Set GOOGLE_PASSWORD (+ GOOGLE_EMAIL if different from GUESTY_EMAIL) for SSO, or GUESTY_EMAIL + GUESTY_PASSWORD for native login.",
    };
  }
  const emailInput = await page
    .waitForSelector(
      'input[type="email"], input[name="username"], input[name="email"]',
      { timeout: 10000 },
    )
    .catch(() => null);
  if (!emailInput) {
    return { ok: false, error: "Login page loaded but no email input was found." };
  }
  await emailInput.fill(guestyEmail);
  await page
    .click('button[type="submit"], button:has-text("Continue"), button:has-text("Sign In")', {
      timeout: 8000,
    })
    .catch(() => {});
  const passwordInput = await page
    .waitForSelector('input[type="password"]', { timeout: 20000 })
    .catch(() => null);
  if (!passwordInput) {
    return {
      ok: false,
      error:
        "Email submitted but no password input appeared. Account may be SSO-only — set GOOGLE_PASSWORD instead.",
    };
  }
  await passwordInput.fill(guestyPassword);
  await page
    .click('button[type="submit"], button:has-text("Sign In"), button:has-text("Verify")', {
      timeout: 8000,
    })
    .catch(() => {});
  try {
    await page.waitForURL(
      (u) => /app\.guesty\.com/i.test(u.toString()) && !/\/auth\//i.test(u.toString()),
      { timeout: 30000 },
    );
    trace.push({ step: "native-login-completed" });
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        "Native login submitted but Guesty didn't return to a logged-in state within 30s. May be an MFA challenge — fall back to the legacy loginToGuestyIfNeeded path.",
    };
  }
}

function toPlaywrightCookies(records: RawCookieRecord[]): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}> {
  const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = {
    strict: "Strict",
    lax: "Lax",
    no_restriction: "None",
    unspecified: "Lax",
    none: "None",
  };
  return records
    .filter((c) => c.name && c.value && c.domain)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
      path: c.path ?? "/",
      expires:
        typeof c.expirationDate === "number"
          ? Math.floor(c.expirationDate)
          : typeof c.expires === "number"
          ? Math.floor(c.expires)
          : -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite:
        sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? ("Lax" as const),
    }));
}
