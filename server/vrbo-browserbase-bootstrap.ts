// One-time Vrbo persistent-context bootstrap.
//
// Sister to server/guesty-browserbase-login.ts (PR #261). The shape is
// the same — accept the operator's freshly-exported browser cookies,
// create a Browserbase persistent context, seed the context by opening
// vrbo.com in a session attached to it, verify the session is alive
// (no bot-wall), and save the contextId to the local cache.
//
// Why a separate module from the Guesty one:
//   - Different cookie domains / verification probe URL.
//   - Different success criteria (Vrbo's bot wall is a specific
//     "Show us your human side..." spin page; Guesty's is /auth/login).
//   - Want them to evolve independently — Vrbo's anti-bot rev cycles
//     don't line up with Guesty's session-management changes.
//
// Once bootstrapped, server/stagehand-vrbo-search.ts attaches the
// context to its Browserbase session via
// `browserSettings.context: { id: contextId, persist: true }`. Vrbo's
// anti-bot recognizes the session as a returning real user and lets
// the search through.

import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";
import { setCachedSession, type RawCookieRecord } from "./vrbo-session-cache";

type Trace = Array<{ step: string; detail?: string }>;

type BootstrapOk = {
  ok: true;
  contextId: string;
  cookieCount: number;
  finalUrl: string;
  durationMs: number;
  trace: Trace;
};

type BootstrapErr = {
  ok: false;
  error: string;
  finalUrl?: string;
  trace: Trace;
};

export async function bootstrapVrboBrowserbaseContext(opts: {
  cookies: RawCookieRecord[];
}): Promise<BootstrapOk | BootstrapErr> {
  const trace: Trace = [];
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    return {
      ok: false,
      error:
        "BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set on Railway. Both are required for the persistent-context bootstrap.",
      trace,
    };
  }
  if (!opts.cookies || opts.cookies.length === 0) {
    return {
      ok: false,
      error:
        "No cookies provided. Bootstrap needs Vrbo session cookies (Cookie-Editor extension on vrbo.com → Export → JSON). Including accounts.expedia.com / vrbo.com cookies maximizes the chance that Vrbo's anti-bot recognizes the persistent context as a returning real user.",
      trace,
    };
  }

  const startedAt = Date.now();
  const bb = new Browserbase({ apiKey });

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

  let session: Awaited<ReturnType<typeof bb.sessions.create>>;
  try {
    session = await bb.sessions.create({
      projectId,
      proxies: true,
      browserSettings: {
        context: { id: contextId, persist: true },
        viewport: { width: 1280, height: 800 },
        // Browserbase auto-solves common CAPTCHAs server-side. Insurance
        // against Vrbo's slider escalation if the passive fingerprint
        // check fails.
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
    const ctx = browser.contexts()[0];
    if (!ctx) {
      throw new Error("Browserbase session opened but no contexts attached");
    }

    // Seed the persistent context with the operator's cookies BEFORE
    // navigation so Vrbo's first request carries them. addCookies
    // accepts the same Cookie-Editor JSON shape the operator exports
    // from their browser, with light normalization.
    await ctx.addCookies(toPlaywrightCookies(opts.cookies));
    trace.push({
      step: "seeded-cookies",
      detail: `${opts.cookies.length} cookies`,
    });

    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // Navigate to a benign Vrbo URL (homepage) — same as Stagehand's
    // search path entry point. If the persistent context is going to
    // work, it has to make it past the bot wall HERE.
    trace.push({ step: "navigating-to-vrbo" });
    await page.goto("https://www.vrbo.com/", {
      waitUntil: "domcontentloaded",
      timeout: 35000,
    });
    await page.waitForTimeout(5000);

    // Verify we're not stuck on the bot wall. The wall has very
    // specific copy ("Show us your human side..." / "We can't tell if
    // you're a human or a bot"). If we see those, the cookies didn't
    // work — possibly stale, possibly not enough cookies, possibly
    // wrong domain mix.
    const pageText = await page
      .evaluate(() => (document.body?.innerText ?? "").slice(0, 2000))
      .catch(() => "");
    const onBotWall = /show us your human side|we can.?t tell if you.?re a human|press and hold|prove you.?re not a robot/i.test(
      pageText,
    );

    if (onBotWall) {
      trace.push({ step: "bot-wall-still-up", detail: pageText.slice(0, 300) });
      return {
        ok: false,
        error:
          "Browserbase session with the seeded cookies is STILL hitting Vrbo's anti-bot wall. The cookies may be stale, or Vrbo may be tying its trust to additional signals (browser fingerprint, IP region) that the cookies alone can't carry. Try: (a) export cookies from the SAME Chrome window where you just successfully searched vrbo.com; (b) include cookies from accounts.expedia.com and vrbo.com in the same paste.",
        finalUrl: page.url(),
        trace,
      };
    }

    // Save the contextId + cookies to the cache. Cookies are kept
    // largely for diagnostic / re-bootstrap convenience — the
    // persistent context handles cookie reuse server-side from this
    // point on.
    setCachedSession(
      { cookies: opts.cookies, browserbaseContextId: contextId },
      "manual-paste",
    );

    trace.push({ step: "context-bootstrapped", detail: page.url() });

    return {
      ok: true,
      contextId,
      cookieCount: opts.cookies.length,
      finalUrl: page.url(),
      durationMs: Date.now() - startedAt,
      trace,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: `Vrbo bootstrap failed: ${err?.message ?? String(err)}`,
      trace,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await bb.sessions
      .update(session.id, { projectId, status: "REQUEST_RELEASE" })
      .catch(() => {});
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
