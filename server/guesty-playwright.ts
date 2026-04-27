// Shared building blocks for Playwright automation against
// app.guesty.com. The original endpoint
// `/api/admin/guesty/inspect-vrbo-compliance` (server/routes.ts) was the
// first user of these patterns; pulling them into one place so subsequent
// per-channel automations (publish-to-channel, distribution inspection,
// etc.) can reuse the cookie restoration, Okta storage injection, stealth
// init script, and the email/password + IMAP-MFA login flow without each
// endpoint re-implementing 500 lines of boilerplate.
//
// Inputs (env):
//   GUESTY_SESSION_COOKIES         — JSON array (Cookie-Editor export
//                                    format) for app.guesty.com cookies
//   GUESTY_OKTA_TOKEN_STORAGE      — raw value for `okta-token-storage`
//                                    localStorage key (optional)
//   GUESTY_LOCAL_STORAGE           — JSON object { key: value } merged
//                                    into localStorage (optional)
//   GUESTY_SESSION_STORAGE         — JSON object merged into
//                                    sessionStorage (optional)
//   GUESTY_EMAIL / GUESTY_PASSWORD — credentials used IF the cookies +
//                                    storage above don't keep the
//                                    session alive (Guesty's server-side
//                                    session check redirects ephemeral
//                                    Railway browsers to /auth/login)
//   GMAIL_USER / GMAIL_APP_PASSWORD — Gmail IMAP credentials so the MFA
//                                    code can be fetched automatically
//                                    when Guesty challenges from a new
//                                    device (i.e. always)
//
// Cost note: this stack uses vanilla rebrowser-playwright + the local
// /usr/bin/chromium baked into the Dockerfile (Load-Bearing #17 in
// AGENTS.md applies to photos, but the Playwright executable path is
// configured the same way). No Browserbase fees.

import path from "path";
import fs from "fs";
import type { BrowserContext, Page } from "playwright";
import { chromium as vanillaChromium } from "playwright";

export type Trace = Array<{ step: string; detail?: string }>;
export type SaveShot = (page: Page, tag: string) => Promise<string | null>;

type RawCookie = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expirationDate?: number;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

type PWCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

/**
 * Parse the GUESTY_SESSION_COOKIES env var into the shape Playwright's
 * BrowserContext.addCookies expects. Filters out malformed entries so a
 * single bad cookie doesn't blow up the whole session.
 *
 * Throws when the env var isn't set, so callers can short-circuit with a
 * clear error before bothering to launch a browser.
 */
export function parseGuestyCookies(): PWCookie[] {
  const cookieJson = process.env.GUESTY_SESSION_COOKIES;
  if (!cookieJson) {
    throw new Error("GUESTY_SESSION_COOKIES not set");
  }
  const raw = JSON.parse(cookieJson) as RawCookie[];
  const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = {
    strict: "Strict",
    lax: "Lax",
    no_restriction: "None",
    unspecified: "Lax",
    none: "None",
  };
  return raw
    .filter((c) => c.name && c.value && c.domain)
    .map<PWCookie>((c) => ({
      name: c.name!,
      value: c.value!,
      domain: c.domain!.startsWith(".") ? c.domain! : `.${c.domain!}`,
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
        sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ??
        ("Lax" as "Strict" | "Lax" | "None"),
    }));
}

/**
 * Launch a stealthed Chromium via rebrowser-playwright. rebrowser is a
 * drop-in replacement for `playwright` that patches the CDP
 * Runtime.Enable leak Okta's bot detection (and CreepJS / FingerprintJS)
 * watches for. The vanilla `playwright` package can't hide that leak no
 * matter what init script you inject — it has to be patched at the CDP
 * layer.
 *
 * Falls back to vanilla chromium if rebrowser fails to import (eg in
 * test environments that didn't install it).
 */
export async function launchGuestyBrowser(): Promise<
  Awaited<ReturnType<typeof vanillaChromium.launch>>
> {
  const launchOpts = {
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  };
  try {
    const { chromium: rbChromium } = await import("rebrowser-playwright");
    return (await rbChromium.launch(launchOpts)) as unknown as Awaited<
      ReturnType<typeof vanillaChromium.launch>
    >;
  } catch {
    return vanillaChromium.launch(launchOpts);
  }
}

/**
 * Apply the comprehensive stealth init script to a context. Covers the
 * vectors Okta JS is known to probe: webdriver flag, plugins array,
 * languages, permissions API oddities, WebGL renderer, Chrome runtime
 * shape, and webdriver property leaks left on `document` by some
 * Chromium builds.
 *
 * Call once per context, before navigating to anything authenticated.
 */
export async function applyStealthInitScript(
  ctx: BrowserContext,
): Promise<void> {
  await ctx.addInitScript(() => {
    // 1. webdriver flag
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // 2. Plugins — return a realistic non-empty array. Detection code
    //    checks navigator.plugins.length > 0 as a basic signal.
    const fakePlugins = [
      {
        name: "PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "Portable Document Format",
      },
      {
        name: "Chrome PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "",
      },
      {
        name: "Chromium PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "",
      },
      {
        name: "Microsoft Edge PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "",
      },
      {
        name: "WebKit built-in PDF",
        filename: "internal-pdf-viewer",
        description: "",
      },
    ];
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        const arr = fakePlugins.map((p) =>
          Object.assign(Object.create(Plugin.prototype), p),
        );
        Object.defineProperty(arr, "item", { value: (i: number) => arr[i] });
        Object.defineProperty(arr, "namedItem", {
          value: (n: string) =>
            arr.find((p: any) => p.name === n) || null,
        });
        Object.defineProperty(arr, "refresh", { value: () => {} });
        return arr;
      },
    });

    // 3. Languages — ensure array matches Accept-Language header shape.
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });

    // 4. Permissions query — headless Chromium returns "denied" for
    //    notifications; real Chrome returns "default" / "prompt".
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    (navigator.permissions as any).query = (params: { name: string }) =>
      params?.name === "notifications"
        ? Promise.resolve({ state: "prompt" } as unknown as PermissionStatus)
        : origQuery(params as PermissionDescriptor);

    // 5. WebGL renderer — headless Chrome reports "SwiftShader" or
    //    "ANGLE (llvmpipe)", both dead giveaways. Spoof to a common
    //    Intel integrated GPU string.
    const getParamProto = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      if (param === 37445) return "Intel Inc.";
      if (param === 37446) return "Intel Iris OpenGL Engine";
      return getParamProto.call(this, param);
    };

    // 6. window.chrome shape — real Chrome has a `chrome` object with
    //    runtime / loadTimes / csi properties.
    if (!(window as any).chrome) {
      (window as any).chrome = {};
    }
    if (!(window as any).chrome.runtime) {
      (window as any).chrome.runtime = {
        OnInstalledReason: {},
        OnRestartRequiredReason: {},
        PlatformArch: {},
        PlatformOs: {},
        RequestUpdateCheckStatus: {},
      };
    }

    // 7. Strip webdriver property leaks ($cdc_, $wdc_) seen in some
    //    Chromium builds.
    for (const key of Object.keys(document)) {
      if (/^\$[cC]dc_|^\$[wW]dc_/.test(key)) {
        delete (document as any)[key];
      }
    }
  });
}

/**
 * Build a Playwright context tuned for Guesty's admin SPA — mainland US
 * locale, Hawaii timezone (matches the operator's actual location and
 * keeps Guesty's session-fingerprint check happy), realistic Mac Chrome
 * user agent, and a 1440x900 viewport that mirrors the dimensions
 * Guesty's internal CSS is calibrated for.
 */
export async function newGuestyContext(
  browser: Awaited<ReturnType<typeof vanillaChromium.launch>>,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "Pacific/Honolulu",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  });
  await applyStealthInitScript(ctx);
  return ctx;
}

/**
 * Inject any Okta-related storage state before the SPA's route guard
 * runs. Returns the keys it injected so callers can record them in
 * trace output.
 *
 * Inputs come from env:
 *   GUESTY_OKTA_TOKEN_STORAGE → localStorage["okta-token-storage"]
 *   GUESTY_LOCAL_STORAGE      → JSON.parse merged into localStorage
 *   GUESTY_SESSION_STORAGE    → JSON.parse merged into sessionStorage
 *
 * Use addInitScript so storage is primed BEFORE the SPA's first auth
 * check runs — setting it after page.goto is too late.
 */
export async function restoreOktaStorage(
  ctx: BrowserContext,
  trace: Trace,
): Promise<{ localKeys: string[]; sessionKeys: string[] }> {
  const toInjectLocal: Record<string, string> = {};
  const lsObjRaw = process.env.GUESTY_LOCAL_STORAGE;
  if (lsObjRaw) {
    try {
      Object.assign(
        toInjectLocal,
        JSON.parse(lsObjRaw) as Record<string, string>,
      );
    } catch (e) {
      trace.push({
        step: "localstorage-json-parse-failed",
        detail: (e as Error).message,
      });
    }
  }
  const oktaRaw = process.env.GUESTY_OKTA_TOKEN_STORAGE;
  if (oktaRaw) toInjectLocal["okta-token-storage"] = oktaRaw;

  const toInjectSession: Record<string, string> = {};
  const ssObjRaw = process.env.GUESTY_SESSION_STORAGE;
  if (ssObjRaw) {
    try {
      Object.assign(
        toInjectSession,
        JSON.parse(ssObjRaw) as Record<string, string>,
      );
    } catch (e) {
      trace.push({
        step: "sessionstorage-json-parse-failed",
        detail: (e as Error).message,
      });
    }
  }

  const localKeys = Object.keys(toInjectLocal);
  const sessionKeys = Object.keys(toInjectSession);
  if (localKeys.length === 0 && sessionKeys.length === 0) {
    trace.push({
      step: "no-storage-env",
      detail:
        "set GUESTY_OKTA_TOKEN_STORAGE (raw) or GUESTY_LOCAL_STORAGE / GUESTY_SESSION_STORAGE (JSON objects)",
    });
    return { localKeys, sessionKeys };
  }

  trace.push({
    step: "priming-storage-via-init-script",
    detail: `localStorage=${localKeys.length} sessionStorage=${sessionKeys.length}`,
  });
  await ctx.addInitScript(
    (payload: {
      local: Array<[string, string]>;
      session: Array<[string, string]>;
    }) => {
      try {
        for (const [k, v] of payload.local)
          window.localStorage.setItem(k, v);
      } catch {
        /* storage blocked on this origin */
      }
      try {
        for (const [k, v] of payload.session)
          window.sessionStorage.setItem(k, v);
      } catch {
        /* storage blocked on this origin */
      }
    },
    {
      local: Object.entries(toInjectLocal),
      session: Object.entries(toInjectSession),
    },
  );
  return { localKeys, sessionKeys };
}

/**
 * Build a screenshot saver bound to a specific debug-tag namespace. The
 * returned function writes JPEGs into client/public/photos/debug/ and
 * returns the public URL path (or null on any failure — never throws).
 *
 * The /photos directory is on the Railway volume (Load-Bearing #17), so
 * shots survive container restarts and are reachable via the same static
 * route the rest of the app uses.
 */
export function makeShotSaver(prefix: string, listingId: string): SaveShot {
  return async (page, tag) => {
    const buf = await page
      .screenshot({ type: "jpeg", quality: 70, fullPage: true })
      .catch(() => null);
    if (!buf) return null;
    try {
      const debugDir = path.resolve(
        process.cwd(),
        "client/public/photos/debug",
      );
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      const fname = `${prefix}-${tag}-${listingId}-${Date.now()}.jpg`;
      fs.writeFileSync(path.join(debugDir, fname), buf);
      return `/photos/debug/${fname}`;
    } catch {
      return null;
    }
  };
}

/**
 * Detect whether the current page is Guesty's login screen. Checks both
 * the URL (Okta-hosted login lives under /auth/) and a content
 * fingerprint (input names + the hosted-form prompt text), so it works
 * for both the embedded widget and the redirected hosted login.
 */
export async function isOnGuestyLoginPage(page: Page): Promise<boolean> {
  const u = page.url();
  if (/\/auth\//i.test(u)) return true;
  const html = await page.content().catch(() => "");
  return /okta-signin-username|okta-signin-password|Please enter your details to sign in/i.test(
    html,
  );
}

/**
 * If the page has been redirected to Guesty's Okta login, run the full
 * email → password → MFA-via-Gmail flow to log back in. Returns
 * `{ ok: true }` if no login was needed OR if login succeeded;
 * returns `{ ok: false, error, beforeShotUrl, finalUrl }` if any step
 * failed so the caller can return that diagnostic to the client
 * verbatim.
 *
 * Pass the same `trace` and `saveShot` the caller is using so the
 * combined trace tells one story. The MFA path requires
 * `fetchGuestyMfaCodeFromGmail` to be passed in — it lives in
 * server/routes.ts today and we don't want a circular import; callers
 * pull the dependency in themselves.
 */
/**
 * Run Guesty's "Sign in with Google" path. Used when the operator's
 * Guesty account is provisioned via Google SSO (no native password
 * configured) — typical for Google Workspace tenants. Requires
 * GOOGLE_EMAIL (or GUESTY_EMAIL as fallback) + GOOGLE_PASSWORD env vars.
 *
 * Honest failure modes you should expect (none of these are bugs):
 * 1. **"Verify it's you"** — Google challenges first logins from new
 *    datacenter IPs. Headless Chrome from Railway is ALWAYS a new
 *    location to Google. Fix: log in once from a residential browser
 *    using the same Google account so the IP gets device-trusted, OR
 *    refresh `GUESTY_SESSION_COOKIES` instead.
 * 2. **2-Step Verification** — Workspace accounts almost always have
 *    2SV on. Google sends prompts to phone / authenticator app — no
 *    automatable second factor for service accounts (the Gmail IMAP
 *    code path doesn't work for Google's own 2SV). Caller will see a
 *    diagnostic + screenshot; the only fix is fresh cookies.
 * 3. **"This browser may not be secure"** — Google detects headless
 *    Chrome on cloud IPs. Stealth init script helps but isn't
 *    bulletproof against Google's signal collection.
 *
 * Returns the same shape as `loginToGuestyIfNeeded` so the dispatcher
 * can forward the result verbatim.
 */
export async function loginToGuestyViaGoogleSso(
  page: Page,
  trace: Trace,
  saveShot: SaveShot,
): Promise<
  | { ok: true; loggedIn: boolean }
  | {
      ok: false;
      error: string;
      finalUrl: string;
      beforeShotUrl: string | null;
    }
> {
  const googleEmail = process.env.GOOGLE_EMAIL || process.env.GUESTY_EMAIL;
  const googlePassword = process.env.GOOGLE_PASSWORD;
  if (!googleEmail || !googlePassword) {
    const shot = await saveShot(page, "google-no-creds");
    return {
      ok: false,
      error:
        "Google SSO path entered but GOOGLE_EMAIL/GUESTY_EMAIL or GOOGLE_PASSWORD not set.",
      finalUrl: page.url(),
      beforeShotUrl: shot,
    };
  }

  trace.push({ step: "google-sso-starting" });

  // STEP 0: Find and click the "Sign in with Google" button on Guesty's
  // login page. The Guesty button has Google's "G" logo + label text;
  // selector tries both the visible text and the typical SSO data
  // attributes.
  const googleBtn = await page
    .waitForSelector(
      'button:has-text("Sign in with Google"), button:has-text("Continue with Google"), button:has-text("Log in with Google"), [data-provider="google" i], button[aria-label*="Google" i]',
      { timeout: 10000 },
    )
    .catch(() => null);
  if (!googleBtn) {
    const shot = await saveShot(page, "google-button-missing");
    return {
      ok: false,
      error:
        "GOOGLE_PASSWORD is set but no 'Sign in with Google' button was found on Guesty's login page. The login form may have changed, or this account isn't actually SSO-configured.",
      finalUrl: page.url(),
      beforeShotUrl: shot,
    };
  }

  // OAuth typically opens a popup. Race the popup event against the
  // same-tab navigation in case Guesty configured it as a redirect.
  const ctx = page.context();
  const popupPromise = ctx
    .waitForEvent("page", { timeout: 8000 })
    .catch(() => null);
  await googleBtn.click().catch(() => {});
  trace.push({ step: "google-sso-button-clicked" });

  let workPage: Page = page;
  const popup = await popupPromise;
  if (popup) {
    workPage = popup;
    trace.push({ step: "google-sso-popup-opened" });
    // Wait for the popup to land on accounts.google.com. Some tenants
    // route through an Okta IdP first.
    await workPage
      .waitForURL((u) => /accounts\.google\.com/.test(u.toString()), {
        timeout: 20000,
      })
      .catch(() => {
        /* best-effort; we'll fall through and probe for the email field */
      });
  } else {
    // Same-window redirect — wait for the URL to leave guesty.
    await page
      .waitForURL((u) => /accounts\.google\.com/.test(u.toString()), {
        timeout: 15000,
      })
      .catch(() => {
        trace.push({ step: "google-sso-no-popup-no-redirect" });
      });
  }
  trace.push({
    step: "google-sso-on-google-page",
    detail: workPage.url(),
  });

  // STEP 1: Email. Google's login uses input[id="identifierId"] (most
  // stable) but some experiments use a different name; cover the
  // common variants.
  const emailField = await workPage
    .waitForSelector(
      'input[type="email"], input[name="identifier"], input#identifierId',
      { timeout: 15000 },
    )
    .catch(() => null);
  if (!emailField) {
    // Possible an account chooser is showing (the email is already
    // remembered from a prior session). Try clicking the matching tile.
    const tile = await workPage
      .$(
        `[data-email="${googleEmail}"], [data-identifier="${googleEmail}"], li:has-text("${googleEmail}")`,
      )
      .catch(() => null);
    if (tile) {
      await tile.click().catch(() => {});
      trace.push({ step: "google-sso-clicked-account-chooser-tile" });
    } else {
      const shot = await saveShot(workPage, "google-no-email-field");
      return {
        ok: false,
        error:
          "Google didn't show an email field or a recognizable account-chooser tile. May be a 'verify it's you' challenge or 'this browser may not be secure' page — check the screenshot.",
        finalUrl: workPage.url(),
        beforeShotUrl: shot,
      };
    }
  } else {
    await emailField.fill(googleEmail);
    trace.push({ step: "google-sso-email-filled" });
    await workPage
      .click('#identifierNext button, button:has-text("Next")', {
        timeout: 8000,
      })
      .catch(() => {});
    trace.push({ step: "google-sso-email-submitted" });
  }

  // CAPTCHA gate. Google's identifier step often serves a "Type the
  // text you hear or see" image CAPTCHA when the request comes from a
  // datacenter IP (which Railway always is). Detection: after email
  // submit we wait briefly, then check whether we're STILL on
  // /signin/identifier with a CAPTCHA image present. If both, send the
  // image to 2captcha, type the solution, click Next, retry. Up to 2
  // CAPTCHA solves per run — Google sometimes chains a second one
  // after the first solves correctly. Past that we bail with the
  // standard cookie-refresh recommendation; chained challenges are a
  // signal that this session is suspect and no amount of solving will
  // get us through.
  //
  // Cost: $0.001 per solve. Disabled cleanly when TWOCAPTCHA_API_KEY
  // is not set (we just fall through to the existing "no password
  // field" diagnostic, which still works).
  for (let captchaAttempt = 0; captchaAttempt < 2; captchaAttempt++) {
    await workPage.waitForTimeout(2000);
    const stillOnIdentifier = /\/signin\/identifier|\/v3\/signin\/identifier/i.test(
      workPage.url(),
    );
    if (!stillOnIdentifier) break; // advanced past identifier step

    // Look for the CAPTCHA image. Google renders it as an <img> with
    // either a data: URL or an https://www.google.com/... URL. The
    // image is inside the form, not in any Google chrome (logo, etc),
    // so scoping to form > img is reasonably tight.
    const captchaImg = await workPage
      .$(
        'form img[src*="captcha" i], form img[src^="data:image"], img[role="presentation"][src]:not([alt*="Google" i]):not([src*="logo" i])',
      )
      .catch(() => null);
    if (!captchaImg) break; // not a CAPTCHA — let the password-wait surface the real reason

    if (!process.env.TWOCAPTCHA_API_KEY) {
      const shot = await saveShot(workPage, "google-captcha-no-key");
      return {
        ok: false,
        error:
          "Google served a 'Type the text you hear or see' CAPTCHA but TWOCAPTCHA_API_KEY env var is not set. Either set it (cheap: ~$0.001/solve at 2captcha.com) or refresh GUESTY_SESSION_COOKIES + GUESTY_OKTA_TOKEN_STORAGE to skip Google's login entirely.",
        finalUrl: workPage.url(),
        beforeShotUrl: shot,
      };
    }

    trace.push({
      step: "google-captcha-detected",
      detail: `attempt ${captchaAttempt + 1}/2`,
    });

    // Get the image as base64. If it's a data: URL we already have
    // it; otherwise fetch it from inside the page so the request
    // inherits the page's auth cookies (Google's CAPTCHA endpoint
    // requires the session).
    const imgSrc = await captchaImg.getAttribute("src");
    if (!imgSrc) {
      const shot = await saveShot(workPage, "google-captcha-no-src");
      return {
        ok: false,
        error: "CAPTCHA image element had no src attribute.",
        finalUrl: workPage.url(),
        beforeShotUrl: shot,
      };
    }
    let imgBase64: string;
    if (imgSrc.startsWith("data:image")) {
      imgBase64 = imgSrc.split(",")[1] || "";
    } else {
      imgBase64 = await workPage
        .evaluate(async (url: string) => {
          const res = await fetch(url, { credentials: "include" });
          const blob = await res.blob();
          return await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () =>
              resolve(((reader.result as string) || "").split(",")[1] || "");
            reader.readAsDataURL(blob);
          });
        }, imgSrc)
        .catch(() => "");
    }
    if (!imgBase64) {
      const shot = await saveShot(workPage, "google-captcha-fetch-failed");
      return {
        ok: false,
        error: `Couldn't fetch CAPTCHA image from ${imgSrc.slice(0, 120)}.`,
        finalUrl: workPage.url(),
        beforeShotUrl: shot,
      };
    }
    trace.push({
      step: "google-captcha-image-fetched",
      detail: `${imgBase64.length} base64 chars`,
    });

    const { solveImageCaptcha, reportBadCaptcha } = await import(
      "./captcha-solver"
    );
    const solveResult = await solveImageCaptcha(
      imgBase64,
      process.env.TWOCAPTCHA_API_KEY,
    );
    if (!solveResult.ok) {
      const shot = await saveShot(workPage, "google-captcha-solver-failed");
      return {
        ok: false,
        error: `2captcha solver failed: ${solveResult.error}`,
        finalUrl: workPage.url(),
        beforeShotUrl: shot,
      };
    }
    trace.push({
      step: "google-captcha-solved",
      detail: `solution=${solveResult.solution.length} chars id=${solveResult.captchaId}`,
    });

    // Type the solution into the CAPTCHA input. The input typically
    // has aria-label "Type the text you hear or see" or name="ca";
    // cover both plus a positional fallback (the only text input
    // inside the form that isn't the email field).
    const captchaInput = await workPage
      .$(
        'input[aria-label*="text you hear" i], input[name="ca"], input[type="text"][autocomplete="off"]:not([type="email"])',
      )
      .catch(() => null);
    if (!captchaInput) {
      const shot = await saveShot(workPage, "google-captcha-no-input");
      // Refund the credit since we never used the solution.
      await reportBadCaptcha(
        process.env.TWOCAPTCHA_API_KEY,
        solveResult.captchaId,
      );
      return {
        ok: false,
        error: "Solved CAPTCHA but couldn't find the input field to type it into.",
        finalUrl: workPage.url(),
        beforeShotUrl: shot,
      };
    }
    await captchaInput.fill(solveResult.solution);
    trace.push({ step: "google-captcha-solution-filled" });

    await workPage
      .click('#identifierNext button, button:has-text("Next")', {
        timeout: 8000,
      })
      .catch(() => {});
    trace.push({ step: "google-captcha-next-clicked" });

    // Brief beat for Google to respond. If we're still on identifier
    // after this, the loop iterates and tries again (with a fresh
    // CAPTCHA, since Google rotates the image on rejection).
    await workPage.waitForTimeout(3000);
    if (
      !/\/signin\/identifier|\/v3\/signin\/identifier/i.test(workPage.url())
    ) {
      // Advanced — break out and let the password-wait take over.
      break;
    }
    // Solution was rejected. Report it bad to refund the credit, then
    // loop for one more attempt (or bail).
    await reportBadCaptcha(
      process.env.TWOCAPTCHA_API_KEY,
      solveResult.captchaId,
    );
    trace.push({
      step: "google-captcha-solution-rejected",
      detail: "still on identifier page — looping for retry",
    });
  }

  // STEP 2: Password. Google sometimes shows an interstitial ("Not your
  // device? Sign in with a private window") between email and password
  // — the password field still mounts after a beat, so we just wait
  // patiently here. Cap at 25s; longer than that is almost always a
  // hard-block challenge.
  await workPage.waitForTimeout(2000);
  const pwField = await workPage
    .waitForSelector(
      'input[type="password"], input[name="Passwd"], input#password',
      { timeout: 25000 },
    )
    .catch(() => null);
  if (!pwField) {
    // Common reasons: "verify it's you" prompt, 2SV-from-new-device
    // challenge, or Google's "this browser or app may not be secure"
    // wall. None of these have a clean automatable path — surface the
    // screenshot so the operator can see what challenge Google is
    // serving and decide whether to refresh cookies instead.
    const shot = await saveShot(workPage, "google-no-password-field");
    const url = workPage.url();
    return {
      ok: false,
      error:
        /signin\/v2\/challenge|signin\/identifier\?.*signinChooser|signin\/rejected|disabled_client/i.test(
          url,
        )
          ? `Google served a challenge page instead of password (URL hint: ${url}). Likely 'verify it's you' / 2SV / 'browser may not be secure'. The cleanest fix is to refresh GUESTY_SESSION_COOKIES + GUESTY_OKTA_TOKEN_STORAGE from a logged-in browser session, rather than fighting Google's bot detection. See the screenshot for the exact prompt.`
          : "Google didn't show a password field within 25s after email submit. Almost always a Google challenge — see the screenshot. Refresh cookies as the fallback path.",
      finalUrl: url,
      beforeShotUrl: shot,
    };
  }
  await pwField.fill(googlePassword);
  trace.push({ step: "google-sso-password-filled" });
  await workPage
    .click('#passwordNext button, button:has-text("Next")', { timeout: 8000 })
    .catch(() => {});
  trace.push({ step: "google-sso-password-submitted" });

  // STEP 3: Wait for Guesty to come back. Two cases:
  //   a) Popup flow — the popup posts auth back to the parent and
  //      closes; the parent's URL changes from /auth/login to a real
  //      Guesty page. We watch the ORIGINAL `page`, not workPage,
  //      because workPage closes.
  //   b) Same-window redirect — workPage IS page; URL changes to
  //      app.guesty.com.
  // Either way, we wait on `page` for the post-auth state.
  try {
    await page.waitForURL(
      (u) => {
        const s = u.toString();
        return /app\.guesty\.com/i.test(s) && !/\/auth\//i.test(s);
      },
      { timeout: 45000 },
    );
    trace.push({
      step: "google-sso-redirected-back-to-guesty",
      detail: page.url(),
    });
    return { ok: true, loggedIn: true };
  } catch {
    // If the popup is still alive, capture its state for diagnosis —
    // it's probably stuck on a 2SV / "verify it's you" prompt that
    // Google surfaces AFTER password submit.
    const stuckPage = popup && !popup.isClosed() ? popup : page;
    const shot = await saveShot(stuckPage, "google-stuck-after-password");
    return {
      ok: false,
      error:
        "Google accepted the password but didn't redirect back to Guesty within 45s. Almost always a post-password 2SV challenge (Google Prompt to phone, authenticator code, security key) — there's no automatable second factor for this. Refresh cookies as the fallback.",
      finalUrl: stuckPage.url(),
      beforeShotUrl: shot,
    };
  }
}

export async function loginToGuestyIfNeeded(
  page: Page,
  trace: Trace,
  saveShot: SaveShot,
  fetchMfaCode: (
    user: string,
    appPassword: string,
    afterTimestamp: number,
    trace: Trace,
  ) => Promise<string | null>,
): Promise<
  | { ok: true; loggedIn: boolean }
  | {
      ok: false;
      error: string;
      finalUrl: string;
      beforeShotUrl: string | null;
    }
> {
  if (!(await isOnGuestyLoginPage(page))) return { ok: true, loggedIn: false };

  // Branch: Google SSO. If GOOGLE_PASSWORD is set AND Guesty's login
  // page actually shows a "Sign in with Google" button, take the SSO
  // path instead of the native email/password flow. Google Workspace
  // tenants on Guesty are typically SSO-only — they have no native
  // password to fill — and detection by button presence avoids
  // misrouting on accounts where SSO isn't configured.
  if (process.env.GOOGLE_PASSWORD) {
    const hasGoogleBtn = await page
      .$(
        'button:has-text("Sign in with Google"), button:has-text("Continue with Google"), button:has-text("Log in with Google"), [data-provider="google" i], button[aria-label*="Google" i]',
      )
      .catch(() => null);
    if (hasGoogleBtn) {
      trace.push({
        step: "routing-to-google-sso",
        detail: "GOOGLE_PASSWORD set + Guesty showed 'Sign in with Google'",
      });
      return loginToGuestyViaGoogleSso(page, trace, saveShot);
    }
  }

  const guestyEmail = process.env.GUESTY_EMAIL;
  const guestyPassword = process.env.GUESTY_PASSWORD;
  if (!guestyEmail || !guestyPassword) {
    const beforeShot = await saveShot(page, "needs-login-no-creds");
    return {
      ok: false,
      error:
        "Guesty redirected to login and no usable credentials are set. For native login: GUESTY_EMAIL + GUESTY_PASSWORD. For Google SSO: GOOGLE_PASSWORD (and GOOGLE_EMAIL if different from GUESTY_EMAIL). Token/storage injection alone doesn't bypass Guesty's server-side session check.",
      finalUrl: page.url(),
      beforeShotUrl: beforeShot,
    };
  }

  trace.push({ step: "starting-login-flow" });

  // STEP 1: Email.
  const emailInput = await page
    .waitForSelector(
      'input[type="email"], input[name="username"], input[name="email"], input[id*="okta-signin-username"], input[placeholder*="@"]',
      { timeout: 10000 },
    )
    .catch(() => null);
  if (!emailInput) {
    const shot = await saveShot(page, "no-email-input");
    return {
      ok: false,
      error:
        "Login page loaded but no email input was found. Guesty may have changed their login form — check the screenshot.",
      finalUrl: page.url(),
      beforeShotUrl: shot,
    };
  }
  await emailInput.fill(guestyEmail);
  trace.push({ step: "filled-email" });

  // Keep "Remember me" checked so subsequent runs can reuse the
  // device-trust cookie and skip MFA.
  const rememberMe = await page
    .$(
      'input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i]',
    )
    .catch(() => null);
  if (rememberMe) {
    const checked = await rememberMe.isChecked().catch(() => false);
    if (!checked) await rememberMe.check({ force: true }).catch(() => {});
  }

  await page
    .click(
      'button[type="submit"], input[type="submit"], button:has-text("Continue"), button:has-text("Sign In"), button:has-text("Next"), button:has-text("Log In")',
      { timeout: 8000 },
    )
    .catch(() => {});
  trace.push({ step: "clicked-email-submit" });

  // STEP 2: Password.
  const passwordInput = await page
    .waitForSelector(
      'input[type="password"], input[name="password"], input[id*="okta-signin-password"]',
      { timeout: 20000 },
    )
    .catch(() => null);
  if (!passwordInput) {
    const shot = await saveShot(page, "no-password-input");
    return {
      ok: false,
      error:
        "Couldn't find password input after email submit. Guesty may be using Google SSO-only for this account, or the form changed.",
      finalUrl: page.url(),
      beforeShotUrl: shot,
    };
  }
  await passwordInput.fill(guestyPassword);
  trace.push({ step: "filled-password" });

  await page
    .click(
      'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Verify"), button:has-text("Submit")',
      { timeout: 8000 },
    )
    .catch(() => {});
  trace.push({ step: "clicked-password-submit" });

  // STEP 3: Wait for either auth completion OR an MFA email-code screen.
  // Guesty's flow sends a 6-digit code on every new device, which is us.
  const mfaInputSelector =
    'input[type="text"][inputmode="numeric"], input[maxlength="6"], input[placeholder*="000000"], input[id*="code" i][type="text"], input[name*="code" i]';
  try {
    await Promise.race([
      page.waitForURL(
        (u) => {
          const s = u.toString();
          return /app\.guesty\.com/i.test(s) && !/\/auth\//i.test(s);
        },
        { timeout: 30000 },
      ),
      page
        .waitForSelector(mfaInputSelector, { timeout: 30000 })
        .then(() => {
          throw new Error("MFA_PROMPT");
        }),
    ]);
    trace.push({ step: "login-redirected", detail: page.url() });
    return { ok: true, loggedIn: true };
  } catch (err: any) {
    if (err?.message !== "MFA_PROMPT") {
      const html = await page.content().catch(() => "");
      const badCreds =
        /invalid|incorrect|try again|doesn.?t match|not recognized/i.test(html);
      const shot = await saveShot(page, "login-stuck");
      return {
        ok: false,
        error: badCreds
          ? "Login failed — email or password rejected by Guesty. Verify GUESTY_EMAIL / GUESTY_PASSWORD values."
          : `Login didn't complete within 30s: ${err?.message ?? "unknown"}. Check the screenshot for what Guesty is showing.`,
        finalUrl: page.url(),
        beforeShotUrl: shot,
      };
    }

    // MFA path.
    trace.push({ step: "mfa-email-code-prompt" });
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    if (!gmailUser || !gmailPass) {
      const shot = await saveShot(page, "mfa-no-gmail");
      return {
        ok: false,
        error:
          "Guesty sent an email verification code but GMAIL_USER / GMAIL_APP_PASSWORD env vars aren't set. Add them so the server can fetch the code automatically.",
        finalUrl: page.url(),
        beforeShotUrl: shot,
      };
    }
    const mfaStartedAt = Date.now();
    let code: string | null = null;
    try {
      code = await fetchMfaCode(gmailUser, gmailPass, mfaStartedAt, trace);
    } catch (imapErr: any) {
      const shot = await saveShot(page, "mfa-imap-error");
      return {
        ok: false,
        error: `IMAP failed while fetching Guesty MFA code: ${imapErr?.message ?? String(imapErr)}.`,
        finalUrl: page.url(),
        beforeShotUrl: shot,
      };
    }
    if (!code) {
      const shot = await saveShot(page, "mfa-code-not-found");
      return {
        ok: false,
        error:
          "Couldn't find a Guesty verification code in the Gmail inbox within the IMAP polling window.",
        finalUrl: page.url(),
        beforeShotUrl: shot,
      };
    }
    trace.push({ step: "mfa-code-fetched", detail: `${code.length} digits` });

    const codeInput = await page.$(mfaInputSelector);
    if (!codeInput) {
      const shot = await saveShot(page, "mfa-no-input");
      return {
        ok: false,
        error: "MFA prompt detected earlier but code input isn't there now.",
        finalUrl: page.url(),
        beforeShotUrl: shot,
      };
    }
    await codeInput.fill(code);
    trace.push({ step: "mfa-code-filled" });

    await page
      .click(
        'button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")',
        { timeout: 8000 },
      )
      .catch(() => {});
    trace.push({ step: "mfa-code-submitted" });

    try {
      await page.waitForURL(
        (u) => {
          const s = u.toString();
          return /app\.guesty\.com/i.test(s) && !/\/auth\//i.test(s);
        },
        { timeout: 30000 },
      );
      trace.push({
        step: "mfa-verified-login-redirected",
        detail: page.url(),
      });
      return { ok: true, loggedIn: true };
    } catch {
      const shot = await saveShot(page, "mfa-verify-stuck");
      return {
        ok: false,
        error:
          "MFA code was filled + submitted but Guesty didn't redirect. The code may have been wrong/stale or Guesty added another verification step.",
        finalUrl: page.url(),
        beforeShotUrl: shot,
      };
    }
  }
}

/**
 * Convenience that runs everything before the action click: launch
 * browser, build context, restore cookies + Okta storage, navigate to
 * `targetUrl`, and log in if Guesty bounced us to /auth/. On any
 * failure returns `{ ok: false, ... }` with the same shape the existing
 * inspect endpoints use, so route handlers can pass it straight to
 * `res.json`.
 *
 * Caller is responsible for closing `browser` in a finally block. The
 * `fetchMfaCode` callback is injected so this module doesn't have to
 * import from server/routes.ts (which would create a cycle).
 */
export async function openGuestyAdminPage(
  targetUrl: string,
  opts: {
    listingId: string;
    debugPrefix: string;
    fetchMfaCode: (
      user: string,
      appPassword: string,
      afterTimestamp: number,
      trace: Trace,
    ) => Promise<string | null>;
    /**
     * How long to wait after navigation for Guesty's SPA to hydrate.
     * Guesty's admin pages are heavy; the existing endpoint uses 5000ms
     * and that's been reliable.
     */
    hydrationMs?: number;
  },
): Promise<
  | {
      ok: true;
      browser: Awaited<ReturnType<typeof vanillaChromium.launch>>;
      ctx: BrowserContext;
      page: Page;
      trace: Trace;
      saveShot: SaveShot;
    }
  | {
      ok: false;
      error: string;
      trace: Trace;
      finalUrl?: string;
      beforeShotUrl?: string | null;
    }
> {
  const trace: Trace = [];
  const saveShot = makeShotSaver(opts.debugPrefix, opts.listingId);

  let cookies: PWCookie[];
  try {
    cookies = parseGuestyCookies();
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), trace };
  }

  let browser: Awaited<ReturnType<typeof vanillaChromium.launch>> | null = null;
  try {
    browser = await launchGuestyBrowser();
    const ctx = await newGuestyContext(browser);
    await ctx.addCookies(cookies);
    await restoreOktaStorage(ctx, trace);

    const page = await ctx.newPage();

    trace.push({ step: "navigating", detail: targetUrl });
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 35000,
    });
    await page.waitForTimeout(opts.hydrationMs ?? 5000);

    const loginResult = await loginToGuestyIfNeeded(
      page,
      trace,
      saveShot,
      opts.fetchMfaCode,
    );
    if (!loginResult.ok) {
      await browser.close().catch(() => {});
      return {
        ok: false,
        error: loginResult.error,
        trace,
        finalUrl: loginResult.finalUrl,
        beforeShotUrl: loginResult.beforeShotUrl,
      };
    }
    if (loginResult.loggedIn && !page.url().includes(targetUrl)) {
      // Post-login lands on dashboard — re-navigate to the target.
      trace.push({ step: "navigating-to-target-after-login", detail: targetUrl });
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 35000,
      });
      await page.waitForTimeout(opts.hydrationMs ?? 5000);
    }

    if (await isOnGuestyLoginPage(page)) {
      const beforeShot = await saveShot(page, "still-on-login");
      await browser.close().catch(() => {});
      return {
        ok: false,
        error:
          "Still on login page after Playwright login flow — something failed silently.",
        trace,
        finalUrl: page.url(),
        beforeShotUrl: beforeShot,
      };
    }

    return { ok: true, browser, ctx, page, trace, saveShot };
  } catch (e: any) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: e?.message ?? String(e), trace };
  }
}
