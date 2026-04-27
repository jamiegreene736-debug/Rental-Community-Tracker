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

const SUBMIT_URL = "https://2captcha.com/in.php";
const POLL_URL = "https://2captcha.com/res.php";

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
