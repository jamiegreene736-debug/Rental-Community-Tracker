// PM rate extraction agent — drives a Browserbase stealth-Chrome
// session via Claude `computer-use` to fill date pickers, click
// "Search Availability", dismiss newsletter popups, and surface rates
// on arbitrary PM sites without per-site code. After the agent
// terminates, a separate single-shot extractor parses the final
// screenshot for structured JSON.
//
// The agent loop is bounded by MAX_ITERATIONS (12) so a stuck site
// can't run up unbounded API spend. Browserbase session is released
// in the finally block whether the loop succeeds or not.
//
// Env required:
//   ANTHROPIC_API_KEY      — Claude vision + computer-use
//   BROWSERBASE_API_KEY    — stealth Chrome session host
//   BROWSERBASE_PROJECT_ID — project that the session lives under

import Browserbase from "@browserbasehq/sdk";
import { chromium, type Page } from "playwright";

export type AgentExtraction = {
  isUnitPage: boolean | null;
  available: boolean | null;
  totalPrice: number | null;
  nightlyPrice: number | null;
  dateMatch: boolean | null;
  reason: string;
};

export type AgentResult = {
  ok: boolean;
  reason?: string;
  extracted: AgentExtraction | null;
  finalUrl: string;
  title: string;
  screenshotBase64: string; // data: URL form, ready for client <img>
  iterations: number;
  agentError?: string; // surfaced when the agent loop fails (HTTP error etc.)
  agentTrace?: string[]; // stop messages from each iteration for debugging
};

// 1366×768 keeps screenshot tokens reasonable while leaving room for
// most PM booking widgets to fully render.
const VIEWPORT_W = 1366;
const VIEWPORT_H = 768;
// Bound: most PMs converge in 4-7 iterations. 12 leaves headroom for
// awkward date-pickers without unbounded spend on stuck sites.
const MAX_ITERATIONS = 12;
const MODEL = "claude-sonnet-4-6";

export async function verifyPmRate(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
  anthropicKey: string;
  bbApiKey: string;
  bbProjectId: string;
}): Promise<AgentResult> {
  const { url, checkIn, checkOut, anthropicKey, bbApiKey, bbProjectId } = opts;
  const nights = Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T12:00:00").getTime() -
        new Date(checkIn + "T12:00:00").getTime()) /
        86400000,
    ),
  );

  const bb = new Browserbase({ apiKey: bbApiKey });
  const session = await bb.sessions.create({ projectId: bbProjectId });

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.setViewportSize({ width: VIEWPORT_W, height: VIEWPORT_H });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(1500);

    const loop = await runAgentLoop(page, { checkIn, checkOut, nights, anthropicKey });
    const extracted = await extractFinal(page, { checkIn, checkOut, nights, anthropicKey });
    const finalShot = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });

    return {
      ok: true,
      extracted,
      finalUrl: page.url(),
      title: await page.title().catch(() => ""),
      screenshotBase64: `data:image/jpeg;base64,${finalShot.toString("base64")}`,
      iterations: loop.iterations,
      agentError: loop.error,
      agentTrace: loop.trace,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Sessions auto-release when the connection drops, but explicit
    // release returns the slot to the pool faster.
    await bb.sessions
      .update(session.id, { projectId: bbProjectId, status: "REQUEST_RELEASE" })
      .catch(() => {});
  }
}

async function runAgentLoop(
  page: Page,
  opts: { checkIn: string; checkOut: string; nights: number; anthropicKey: string },
): Promise<{ iterations: number; error?: string; trace: string[] }> {
  const trace: string[] = [];
  // Two-stage architecture: this loop ONLY drives the page (clicks,
  // typing, scrolling) until the rates for the requested dates are
  // visible. Parsing the price out of the final screenshot is a
  // separate extractFinal() call. Splitting jobs keeps each prompt
  // simple and the agent cheaper (it doesn't need to reason about
  // numbers, just about "is the rate visible yet").
  const systemPrompt = [
    `You are a browser automation agent on a vacation-rental booking page.`,
    `Goal: drive the page so that the TOTAL rental price for ${opts.checkIn} to ${opts.checkOut} (${opts.nights} nights) becomes visible on screen.`,
    ``,
    `Typical steps:`,
    `1. If a newsletter / "book direct" / cookie modal is blocking the page, dismiss it (click its X button or press Escape).`,
    `2. Open the date picker. Click ${opts.checkIn} as the check-in date. Click ${opts.checkOut} as the check-out date. You may need to navigate the calendar forward by clicking the next-month arrow.`,
    `3. Click the Search / Check Availability / View Rates / Book Now button.`,
    `4. Wait for the rate to render. Scroll if the price is below the fold.`,
    ``,
    `Stop conditions — emit a final text response (no more tool use):`,
    `- "DONE: rates visible" when the total price for these specific dates is on screen.`,
    `- "DONE: unavailable" when the unit is shown as not bookable for these dates.`,
    `- "DONE: blocked - <reason>" if you're stuck (CAPTCHA, anti-bot wall, page won't load, etc.).`,
    ``,
    `Do NOT try to read the price out of the screenshot — another tool will do that. Your job is to drive the page only.`,
  ].join("\n");

  const messages: any[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Page just loaded at ${page.url()}. Drive the page until rates for ${opts.checkIn} → ${opts.checkOut} are visible.`,
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: await screenshotPngBase64(page),
          },
        },
      ],
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "computer-use-2025-01-24",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: [
          {
            type: "computer_20250124",
            name: "computer",
            display_width_px: VIEWPORT_W,
            display_height_px: VIEWPORT_H,
          },
        ],
        messages,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`[pm-agent] iter ${i}: HTTP ${resp.status} ${body.slice(0, 500)}`);
      trace.push(`iter ${i}: HTTP ${resp.status} ${body.slice(0, 200)}`);
      return { iterations: i, error: `HTTP ${resp.status}: ${body.slice(0, 300)}`, trace };
    }
    const data = (await resp.json()) as any;
    messages.push({ role: "assistant", content: data.content });

    const textBlocks = (data.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ");
    if (textBlocks) trace.push(`iter ${i}: ${textBlocks.slice(0, 120)}`);

    if (data.stop_reason === "end_turn" || /\bDONE\b/i.test(textBlocks)) {
      console.log(`[pm-agent] terminated iter ${i + 1}: ${textBlocks.slice(0, 200)}`);
      return { iterations: i + 1, trace };
    }

    if (data.stop_reason === "tool_use") {
      const toolUses = (data.content ?? []).filter((c: any) => c.type === "tool_use");
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        try {
          const result = await executeAction(page, tu.input);
          const content: any[] = [];
          if (result.text) content.push({ type: "text", text: result.text });
          if (result.image)
            content.push({
              type: "image",
              source: { type: "base64", media_type: "image/png", data: result.image },
            });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: content.length ? content : "(no output)",
          });
        } catch (e: any) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `error: ${e?.message ?? e}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    } else {
      // Unknown stop reason — treat as terminated.
      console.warn(`[pm-agent] iter ${i}: unexpected stop_reason=${data.stop_reason}`);
      trace.push(`iter ${i}: unexpected stop_reason=${data.stop_reason}`);
      return { iterations: i + 1, trace };
    }
  }
  console.warn(`[pm-agent] hit MAX_ITERATIONS=${MAX_ITERATIONS} without terminating`);
  return { iterations: MAX_ITERATIONS, trace };
}

async function executeAction(
  page: Page,
  input: any,
): Promise<{ image?: string; text?: string }> {
  const action = input?.action;
  switch (action) {
    case "screenshot":
      return { image: await screenshotPngBase64(page) };
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click": {
      const [x, y] = input.coordinate;
      const button =
        action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      const clickCount = action === "double_click" ? 2 : 1;
      await page.mouse.click(x, y, { button, clickCount });
      await page.waitForTimeout(500);
      return { image: await screenshotPngBase64(page) };
    }
    case "left_click_drag": {
      const [sx, sy] = input.start_coordinate;
      const [ex, ey] = input.coordinate;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(ex, ey);
      await page.mouse.up();
      await page.waitForTimeout(500);
      return { image: await screenshotPngBase64(page) };
    }
    case "type":
      await page.keyboard.type(input.text);
      await page.waitForTimeout(400);
      return { image: await screenshotPngBase64(page) };
    case "key":
      await page.keyboard.press(input.text);
      await page.waitForTimeout(400);
      return { image: await screenshotPngBase64(page) };
    case "scroll": {
      const [x, y] = input.coordinate ?? [VIEWPORT_W / 2, VIEWPORT_H / 2];
      await page.mouse.move(x, y);
      const amount = (input.scroll_amount ?? 3) * 100;
      const dy =
        input.scroll_direction === "down"
          ? amount
          : input.scroll_direction === "up"
            ? -amount
            : 0;
      const dx =
        input.scroll_direction === "right"
          ? amount
          : input.scroll_direction === "left"
            ? -amount
            : 0;
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(400);
      return { image: await screenshotPngBase64(page) };
    }
    case "wait":
      await page.waitForTimeout((input.duration ?? 1) * 1000);
      return { image: await screenshotPngBase64(page) };
    case "mouse_move": {
      const [x, y] = input.coordinate;
      await page.mouse.move(x, y);
      return { text: `moved cursor to ${x},${y}` };
    }
    case "cursor_position":
      // Playwright doesn't expose cursor position directly; return no-op.
      return { text: "cursor position not tracked" };
    default:
      return { text: `unsupported action: ${action}` };
  }
}

async function screenshotPngBase64(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "png", fullPage: false });
  return buf.toString("base64");
}

async function extractFinal(
  page: Page,
  opts: { checkIn: string; checkOut: string; nights: number; anthropicKey: string },
): Promise<AgentExtraction | null> {
  const screenshot = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
  const screenshotB64 = screenshot.toString("base64");

  const prompt = [
    `You are looking at a vacation rental booking page after a search has been performed.`,
    `The user wants ${opts.checkIn} → ${opts.checkOut} (${opts.nights} nights).`,
    ``,
    `Examine the screenshot and answer:`,
    `1. Is this a SPECIFIC unit's booking page (vs a search results / category / index page)?`,
    `2. Is the unit shown as available for the requested dates ${opts.checkIn} → ${opts.checkOut}?`,
    `3. What is the TOTAL price for the entire ${opts.nights}-night stay shown on the page? (USD integer, no symbols, no commas)`,
    `4. What is the per-night price? (USD integer)`,
    `5. Are the prices shown tied to the requested dates ${opts.checkIn} → ${opts.checkOut}, or default rates?`,
    ``,
    `Use null when truly unknown. Respond with ONLY a single line of minified JSON:`,
    `{"isUnitPage":true|false,"available":true|false|null,"totalPrice":N|null,"nightlyPrice":N|null,"dateMatch":true|false|null,"reason":"<=140 chars"}`,
  ].join("\n");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 250,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: screenshotB64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    console.warn(`[pm-agent] extract HTTP ${resp.status}`);
    return null;
  }
  const data = (await resp.json()) as any;
  const text: string = data?.content?.[0]?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as AgentExtraction;
  } catch {
    return null;
  }
}
