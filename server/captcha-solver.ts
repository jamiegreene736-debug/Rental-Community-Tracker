// 2captcha integration for Google's "Type the text you hear or see"
// challenge that fires on the Sign-in-with-Google flow when the
// request comes from a datacenter IP (i.e. always for Railway).
//
// Why 2captcha and not anti-captcha / capsolver / etc: identical API
// shape, $0.001/solve for image CAPTCHAs (Google's identifier-step
// challenge is a normal text CAPTCHA, not reCAPTCHA), and the
// transport is plain HTTPS POST/GET which means no SDK weight added
// to the bundle. If we ever want to swap providers, this module is
// the only thing that has to change — `solveImageCaptcha` is the
// single export.
//
// Cost ceiling at typical usage (assume ~10 publish clicks/day, with
// CAPTCHA firing on every 4-7 days because Google's device-trust
// cookie persists between runs): ~$0.005/month. Trivially cheap
// versus the operator-time cost of refreshing GUESTY_SESSION_COOKIES
// manually every couple of weeks.
//
// Env: TWOCAPTCHA_API_KEY — get one at 2captcha.com → API tab.
//
// Honest failure modes (none are bugs in this module):
// 1. Solution is wrong → Google rejects + reshows CAPTCHA. We retry
//    once, then bail with a diagnostic. Per-solve cost is sunk.
// 2. 2captcha workers are slow → polling exceeds 90s. Solve might
//    eventually arrive but we've given up. Fix: bump the ceiling if
//    this becomes common (it isn't in steady state).
// 3. 2captcha account out of balance → API returns ERROR_ZERO_BALANCE.
//    Top up at 2captcha.com.

export type CaptchaSolveResult =
  | { ok: true; solution: string; captchaId: string }
  | { ok: false; error: string };

type SubmitResponse = { status: number; request: string };
type PollResponse = { status: number; request: string };
export type CoordinatesCaptchaSolveResult =
  | { ok: true; coordinates: Array<{ x: number; y: number }>; captchaId: string; cost?: string }
  | { ok: false; error: string };
export type DataDomeCaptchaSolveResult =
  | { ok: true; cookie: string; captchaId: string; cost?: string; ip?: string }
  | { ok: false; error: string; retryableWithFreshProxy?: boolean };

const SUBMIT_URL = "https://2captcha.com/in.php";
const POLL_URL = "https://2captcha.com/res.php";
const API_V2_BASE_URL = "https://api.2captcha.com";

function dataDomeSolveShouldUseFreshProxy(error: string): boolean {
  return /ERR_PROXY_CONNECTION_FAILED|ERROR_CAPTCHA_UNSOLVABLE|ERROR_BAD_PROXY|ERROR_PROXY|ERROR_TASK_ABSENT|timeout|didn'?t return DataDome solution/i.test(
    String(error ?? ""),
  );
}

/**
 * Submit a base64-encoded image to 2captcha and poll until the
 * solution arrives or we hit the polling ceiling.
 *
 * `base64` MUST be the raw base64 (no `data:image/png;base64,` prefix
 * — strip that before passing in). 2captcha rejects the data-URL
 * prefix with `ERROR_WRONG_USER_KEY` (misleading error code, but
 * that's what they return).
 *
 * `pollSeconds` defaults to 90s — image CAPTCHAs typically solve in
 * 5-15s, but the worker queue spikes during peak hours. 90s is
 * generous enough to ride out a busy queue without blocking the
 * caller's HTTP request indefinitely.
 */
export async function solveImageCaptcha(
  base64: string,
  apiKey: string,
  opts: { pollSeconds?: number; pollIntervalMs?: number } = {},
): Promise<CaptchaSolveResult> {
  const pollSeconds = opts.pollSeconds ?? 90;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;

  // STEP 1: submit. POST as form-encoded body so we don't have to
  // worry about JSON encoding multi-megabyte base64 strings (some
  // proxies misbehave with large JSON bodies).
  const submitBody = new URLSearchParams({
    key: apiKey,
    method: "base64",
    body: base64,
    json: "1",
  });
  let submitData: SubmitResponse;
  try {
    const submitRes = await fetch(SUBMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: submitBody.toString(),
    });
    submitData = (await submitRes.json()) as SubmitResponse;
  } catch (e: any) {
    return {
      ok: false,
      error: `2captcha submit network error: ${e?.message ?? String(e)}`,
    };
  }
  if (submitData.status !== 1) {
    return {
      ok: false,
      error: `2captcha submit rejected: ${submitData.request} (common causes: ERROR_WRONG_USER_KEY = bad TWOCAPTCHA_API_KEY; ERROR_ZERO_BALANCE = top up at 2captcha.com)`,
    };
  }
  const captchaId = submitData.request;

  // STEP 2: poll. 2captcha returns "CAPCHA_NOT_READY" (their typo,
  // not ours) until the worker hands in a solution.
  const deadline = Date.now() + pollSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollUrl = `${POLL_URL}?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(captchaId)}&json=1`;
    let pollData: PollResponse;
    try {
      const pollRes = await fetch(pollUrl);
      pollData = (await pollRes.json()) as PollResponse;
    } catch (e: any) {
      // Transient network failures during polling shouldn't end the
      // run — the worker may still be processing. Just wait and retry.
      continue;
    }
    if (pollData.status === 1) {
      return { ok: true, solution: pollData.request, captchaId };
    }
    if (pollData.request !== "CAPCHA_NOT_READY") {
      return {
        ok: false,
        error: `2captcha poll returned error after id ${captchaId}: ${pollData.request}`,
      };
    }
  }
  return {
    ok: false,
    error: `2captcha didn't return a solution for id ${captchaId} within ${pollSeconds}s. Worker queue may be slow; if persistent, increase pollSeconds or check 2captcha.com status.`,
  };
}

/**
 * Optional: report a wrong solution back to 2captcha so they refund
 * the credit. Call this when we type the solution and Google still
 * rejects the CAPTCHA. Best-effort — never throws.
 *
 * Per their docs we have ~5 minutes after solving to report the
 * captcha as wrong. Past that window the report is ignored.
 */
export async function reportBadCaptcha(
  apiKey: string,
  captchaId: string,
): Promise<void> {
  try {
    const url = `${POLL_URL}?key=${encodeURIComponent(apiKey)}&action=reportbad&id=${encodeURIComponent(captchaId)}&json=1`;
    await fetch(url);
  } catch {
    /* best-effort */
  }
}

// ─────────────────────────────────────────────────────────────────
// reCAPTCHA v2 / v3 (PR #313)
//
// Used by Phase 2b sidecar handlers when Google SERP scraping or any
// other Google-hosted page throws reCAPTCHA. Operator's call: VRBO /
// Booking partner-portal walls aren't 2captcha-solvable (Cloudflare /
// Akamai fingerprint blocks, no challenge to solve), so this module
// is scoped to Google reCAPTCHA only.
//
// 2captcha's `userrecaptcha` method takes the page's site key and
// page URL, queues a worker to solve in a real browser, and returns
// the `g-recaptcha-response` token (a long opaque string). The
// caller injects that token into the page's hidden response field
// and submits the form — Google validates the token server-side
// against their record of who solved it.
//
// v2 = the visible "I'm not a robot" checkbox + image grid.
// v3 = invisible scoring; submit also needs the `action` string and
// optionally a `min_score` threshold (default 0.3, raise to 0.7+
// for strict pages that reject low-confidence solves).
//
// Polling deadline: reCAPTCHA solves take 30-60s typically, well
// past image CAPTCHA's 5-15s. Default 180s wallet rides out a busy
// queue without blocking the caller forever.
// ─────────────────────────────────────────────────────────────────

const RECAPTCHA_DEFAULT_POLL_SECONDS = 180;
const RECAPTCHA_DEFAULT_POLL_INTERVAL_MS = 5000;

// Shared poll loop. Submitter passes the URLSearchParams; we just
// dispatch + poll. Returns the solution token on success.
async function submitAndPoll(
  submitBody: URLSearchParams,
  apiKey: string,
  pollSeconds: number,
  pollIntervalMs: number,
): Promise<CaptchaSolveResult> {
  let submitData: SubmitResponse;
  try {
    const submitRes = await fetch(SUBMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: submitBody.toString(),
    });
    submitData = (await submitRes.json()) as SubmitResponse;
  } catch (e: any) {
    return { ok: false, error: `2captcha submit network error: ${e?.message ?? String(e)}` };
  }
  if (submitData.status !== 1) {
    return {
      ok: false,
      error: `2captcha submit rejected: ${submitData.request} (common causes: ERROR_WRONG_USER_KEY = bad TWOCAPTCHA_API_KEY; ERROR_ZERO_BALANCE = top up at 2captcha.com; ERROR_GOOGLEKEY = bad sitekey)`,
    };
  }
  const captchaId = submitData.request;
  const deadline = Date.now() + pollSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollUrl = `${POLL_URL}?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(captchaId)}&json=1`;
    let pollData: PollResponse;
    try {
      const pollRes = await fetch(pollUrl);
      pollData = (await pollRes.json()) as PollResponse;
    } catch {
      continue;
    }
    if (pollData.status === 1) {
      return { ok: true, solution: pollData.request, captchaId };
    }
    if (pollData.request !== "CAPCHA_NOT_READY") {
      return { ok: false, error: `2captcha poll returned error after id ${captchaId}: ${pollData.request}` };
    }
  }
  return {
    ok: false,
    error: `2captcha didn't return a solution for id ${captchaId} within ${pollSeconds}s. Worker queue may be slow; if persistent, increase pollSeconds or check 2captcha.com status.`,
  };
}

/**
 * Solve a Google reCAPTCHA v2 ("I'm not a robot" checkbox + image
 * grid). Caller passes the page's `data-sitekey` (visible in the
 * <div class="g-recaptcha"> element, or in the <iframe src> on
 * older pages) plus the page URL the CAPTCHA appears on. 2captcha's
 * worker solves in a real browser and hands back the
 * g-recaptcha-response token — inject it into the page's hidden
 * <textarea name="g-recaptcha-response"> and submit.
 *
 * `invisible: true` for invisible reCAPTCHA v2 (no checkbox; fires
 * on form submit). 2captcha needs the flag to spawn the right
 * worker pool.
 */
export async function solveRecaptchaV2(
  sitekey: string,
  pageurl: string,
  apiKey: string,
  opts: { pollSeconds?: number; pollIntervalMs?: number; invisible?: boolean } = {},
): Promise<CaptchaSolveResult> {
  const submitBody = new URLSearchParams({
    key: apiKey,
    method: "userrecaptcha",
    googlekey: sitekey,
    pageurl,
    json: "1",
  });
  if (opts.invisible) submitBody.set("invisible", "1");
  return submitAndPoll(
    submitBody,
    apiKey,
    opts.pollSeconds ?? RECAPTCHA_DEFAULT_POLL_SECONDS,
    opts.pollIntervalMs ?? RECAPTCHA_DEFAULT_POLL_INTERVAL_MS,
  );
}

/**
 * Solve a Google reCAPTCHA v3 (invisible, behavioral scoring).
 * Caller passes the sitekey, page URL, the `action` name registered
 * on the page (e.g. "submit", "login", "search"), and optionally a
 * `minScore` threshold (default 0.3 — raise toward 0.7+ for strict
 * pages that reject low-confidence solves).
 *
 * Solution is the same shape as v2: a token to POST as
 * `g-recaptcha-response` (or whatever field the page expects;
 * v3 page integrations vary).
 */
export async function solveRecaptchaV3(
  sitekey: string,
  pageurl: string,
  action: string,
  apiKey: string,
  opts: { pollSeconds?: number; pollIntervalMs?: number; minScore?: number } = {},
): Promise<CaptchaSolveResult> {
  const submitBody = new URLSearchParams({
    key: apiKey,
    method: "userrecaptcha",
    version: "v3",
    googlekey: sitekey,
    pageurl,
    action,
    min_score: String(opts.minScore ?? 0.3),
    json: "1",
  });
  return submitAndPoll(
    submitBody,
    apiKey,
    opts.pollSeconds ?? RECAPTCHA_DEFAULT_POLL_SECONDS,
    opts.pollIntervalMs ?? RECAPTCHA_DEFAULT_POLL_INTERVAL_MS,
  );
}

/**
 * Solve coordinate-based image challenges, used by the VRBO local
 * sidecar for slider CAPTCHA walls. 2Captcha's CoordinatesTask asks a
 * worker to click the target point in the screenshot; the sidecar then
 * converts that point into a mouse drag from the slider handle.
 *
 * We use 2Captcha API v2 here because CoordinatesTask returns
 * structured `{ x, y }` objects instead of the older text format.
 */
export async function solveCoordinatesCaptcha(
  imageBase64: string,
  apiKey: string,
  opts: {
    comment?: string;
    imgInstructionsBase64?: string;
    pollSeconds?: number;
    pollIntervalMs?: number;
    minClicks?: number;
    maxClicks?: number;
  } = {},
): Promise<CoordinatesCaptchaSolveResult> {
  const pollSeconds = opts.pollSeconds ?? 120;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const body = imageBase64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
  if (!body) return { ok: false, error: "imageBase64 is empty" };

  const task: Record<string, unknown> = {
    type: "CoordinatesTask",
    body,
    comment:
      opts.comment ??
      "Find the target gap/puzzle location for this slider CAPTCHA. Click the center of the target location.",
    minClicks: opts.minClicks ?? 1,
    maxClicks: opts.maxClicks ?? 1,
  };
  if (opts.imgInstructionsBase64) {
    task.imgInstructions = opts.imgInstructionsBase64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
  }

  let createData: any;
  try {
    const createRes = await fetch(`${API_V2_BASE_URL}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, task }),
    });
    createData = await createRes.json();
  } catch (e: any) {
    return { ok: false, error: `2captcha coordinate submit network error: ${e?.message ?? String(e)}` };
  }

  if (createData?.errorId !== 0 || !createData?.taskId) {
    return {
      ok: false,
      error: `2captcha coordinate submit rejected: ${createData?.errorCode ?? "UNKNOWN"} ${createData?.errorDescription ?? ""}`.trim(),
    };
  }

  const captchaId = String(createData.taskId);
  const deadline = Date.now() + pollSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    let pollData: any;
    try {
      const pollRes = await fetch(`${API_V2_BASE_URL}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId: createData.taskId }),
      });
      pollData = await pollRes.json();
    } catch {
      continue;
    }

    if (pollData?.errorId && pollData.errorId !== 0) {
      return {
        ok: false,
        error: `2captcha coordinate poll returned error after id ${captchaId}: ${pollData.errorCode ?? "UNKNOWN"} ${pollData.errorDescription ?? ""}`.trim(),
      };
    }
    if (pollData?.status === "ready") {
      const coordinates = Array.isArray(pollData?.solution?.coordinates)
        ? pollData.solution.coordinates
            .map((p: any) => ({ x: Number(p?.x), y: Number(p?.y) }))
            .filter((p: { x: number; y: number }) => Number.isFinite(p.x) && Number.isFinite(p.y))
        : [];
      if (coordinates.length === 0) {
        return { ok: false, error: `2captcha coordinate result ${captchaId} had no usable coordinates` };
      }
      return { ok: true, coordinates, captchaId, cost: pollData.cost };
    }
  }

  return {
    ok: false,
    error: `2captcha didn't return coordinate solution for id ${captchaId} within ${pollSeconds}s. Worker queue may be slow; if persistent, increase pollSeconds or check 2captcha.com status.`,
  };
}

/**
 * Solve DataDome slider challenges using 2Captcha's token/cookie
 * solver. DataDome binds the challenge to the browser fingerprint and
 * proxy quality, so callers must pass the active page URL, iframe URL,
 * browser User-Agent, and residential proxy details from the same run.
 */
export async function solveDataDomeSliderCaptcha(
  input: {
    websiteURL: string;
    captchaUrl: string;
    userAgent: string;
    proxyType: "http" | "socks4" | "socks5";
    proxyAddress: string;
    proxyPort: number;
    proxyLogin?: string;
    proxyPassword?: string;
  },
  apiKey: string,
  opts: { pollSeconds?: number; pollIntervalMs?: number } = {},
): Promise<DataDomeCaptchaSolveResult> {
  const pollSeconds = opts.pollSeconds ?? 180;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const captchaUrl = input.captchaUrl.trim();
  if (!/^https?:\/\//i.test(input.websiteURL)) return { ok: false, error: "websiteURL must be an absolute URL" };
  if (!/^https?:\/\//i.test(captchaUrl)) return { ok: false, error: "captchaUrl must be an absolute URL" };
  const captcha = new URL(captchaUrl);
  const t = captcha.searchParams.get("t");
  if (t === "bv") {
    return {
      ok: false,
      retryableWithFreshProxy: true,
      error: "DataDome captchaUrl has t=bv, which means this proxy/IP is banned; rotate proxy before retrying",
    };
  }
  if (t !== "fe") {
    return {
      ok: false,
      error: `DataDome captchaUrl must contain t=fe before solving; got ${t ? `t=${t}` : "no t parameter"}`,
    };
  }
  const proxyPort = Number(input.proxyPort);
  if (!input.userAgent.trim()) return { ok: false, error: "userAgent is required for DataDome solve" };
  if (!input.proxyAddress.trim() || !Number.isFinite(proxyPort) || proxyPort <= 0) {
    return { ok: false, error: "valid proxyAddress and proxyPort are required for DataDome solve" };
  }

  const task: Record<string, unknown> = {
    type: "DataDomeSliderTask",
    websiteURL: input.websiteURL,
    captchaUrl,
    userAgent: input.userAgent,
    proxyType: input.proxyType,
    proxyAddress: input.proxyAddress,
    proxyPort,
  };
  if (input.proxyLogin) task.proxyLogin = input.proxyLogin;
  if (input.proxyPassword) task.proxyPassword = input.proxyPassword;

  let createData: any;
  try {
    const createRes = await fetch(`${API_V2_BASE_URL}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, task }),
    });
    createData = await createRes.json();
  } catch (e: any) {
    return { ok: false, error: `2captcha DataDome submit network error: ${e?.message ?? String(e)}` };
  }
  if (createData?.errorId !== 0 || !createData?.taskId) {
    const errorCode = String(createData?.errorCode ?? "UNKNOWN");
    const error = `2captcha DataDome submit rejected: ${errorCode} ${createData?.errorDescription ?? ""}`.trim();
    return {
      ok: false,
      retryableWithFreshProxy: dataDomeSolveShouldUseFreshProxy(error),
      error,
    };
  }

  const captchaId = String(createData.taskId);
  const deadline = Date.now() + pollSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    let pollData: any;
    try {
      const pollRes = await fetch(`${API_V2_BASE_URL}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId: createData.taskId }),
      });
      pollData = await pollRes.json();
    } catch {
      continue;
    }
    if (pollData?.errorId && pollData.errorId !== 0) {
      const errorCode = String(pollData.errorCode ?? "UNKNOWN");
      const error = `2captcha DataDome poll returned error after id ${captchaId}: ${errorCode} ${pollData.errorDescription ?? ""}`.trim();
      return {
        ok: false,
        retryableWithFreshProxy: dataDomeSolveShouldUseFreshProxy(error),
        error,
      };
    }
    if (pollData?.status === "ready") {
      const cookie = typeof pollData?.solution?.cookie === "string" ? pollData.solution.cookie.trim() : "";
      if (!/^datadome=/i.test(cookie)) {
        return { ok: false, error: `2captcha DataDome result ${captchaId} did not include a datadome cookie` };
      }
      return { ok: true, cookie, captchaId, cost: pollData.cost, ip: pollData.ip };
    }
  }

  const error = `2captcha didn't return DataDome solution for id ${captchaId} within ${pollSeconds}s. Worker queue may be slow; if persistent, increase pollSeconds or check 2captcha.com status.`;
  return { ok: false, retryableWithFreshProxy: true, error };
}
