// VRBO sidecar worker — drives real Chrome via CDP.
//
// v3 (2026-04-29): generalized to dispatch on op type. Each request
// from the queue carries `opType` ∈ { airbnb_search, vrbo_search,
// vrbo_photo_scrape, booking_search, google_serp, pm_site_search,
// pm_url_check } plus a `params` blob; this worker
// dispatches to the right scrape function based on opType. Each
// processor reuses the same Chrome instance — same dedicated
// user-data-dir, same cookies, same accumulated trust.
//
// Architecture:
//   - Spawns the user's Google Chrome.app with
//     --remote-debugging-port=9222 + a dedicated user-data-dir.
//   - Connects via Playwright's chromium.connectOverCDP.
//   - Polls Railway every ~10s when idle; dispatches by opType; posts results.
//   - Heartbeats happen automatically — every /next call stamps the
//     server's lastWorkerPollAt for the UI's "Local sidecar online"
//     badge.

import { chromium } from "playwright";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { ChromeSidecarManager } from "./chrome-sidecar-manager.mjs";
import { resolveChromeProxyConfig } from "./proxy-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = path.join(__dirname, "cookies.json");
const CHROME_DATA_DIR = path.join(
  os.homedir(),
  "Library/Application Support/VrboSidecar-Chrome",
);
const CHROME_BINARY = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9222;
const VIEWPORT = { width: 1280, height: 820 };
const SIDE_CAR_CHROME_VISIBLE = process.env.SIDECAR_CHROME_VISIBLE === "1";
const SIDECAR_ALLOW_FOCUS = process.env.SIDECAR_ALLOW_FOCUS === "1";
const SIDECAR_CAPTCHA_SURFACE_WINDOW = process.env.SIDECAR_CAPTCHA_SURFACE_WINDOW !== "0";
const SIDECAR_CAPTCHA_ALLOW_FOCUS = process.env.SIDECAR_CAPTCHA_ALLOW_FOCUS !== "0";
const SIDECAR_MACOS_BACKGROUND_LAUNCH = process.env.SIDECAR_MACOS_BACKGROUND_LAUNCH !== "0";
const HIDDEN_WINDOW_POSITION = "-32000,-32000";
const VISIBLE_WINDOW_POSITION = process.env.SIDECAR_CHROME_VISIBLE_POSITION ?? "120,80";
const VISIBLE_WINDOW_SIZE = (() => {
  const [widthRaw, heightRaw] = String(process.env.SIDECAR_CHROME_VISIBLE_SIZE ?? "").split(",").map((part) => Number(part.trim()));
  return {
    width: Number.isFinite(widthRaw) && widthRaw > 0 ? Math.round(widthRaw) : VIEWPORT.width,
    height: Number.isFinite(heightRaw) && heightRaw > 0 ? Math.round(heightRaw) : VIEWPORT.height + 80,
  };
})();

const SERVER = process.env.SIDECAR_SERVER ?? "https://rental-community-tracker-production.up.railway.app";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const WORKER_SLOT = process.env.SIDECAR_WORKER_SLOT ?? "1";

const CHROME_PRIMARY = String(process.env.CHROME_PRIMARY ?? "local").toLowerCase();
const WORKER_ROLE = String(process.env.SIDECAR_WORKER_ROLE ?? (CHROME_PRIMARY === "server" ? "server" : "local")).toLowerCase();
const SIDECAR_BROWSER_MODE = String(
  process.env.SIDECAR_BROWSER_MODE ??
    process.env.SIDECAR_LOCAL_BROWSER_MODE ??
    "cdp",
).toLowerCase();
const USE_HEADLESS_LOCAL_BROWSER = /^(headless|local-headless|playwright-headless)$/.test(SIDECAR_BROWSER_MODE);
const USE_SERVER_BROWSER = /^(server|remote|novnc|server-cdp)$/.test(SIDECAR_BROWSER_MODE);
const HEADLESS_FALLBACK_ENABLED = process.env.SIDECAR_HEADLESS_FALLBACK_ENABLED !== "0";
const HEADLESS_BROWSER_CHANNEL = process.env.SIDECAR_HEADLESS_BROWSER_CHANNEL ?? "chrome";
const HEADLESS_CHROMIUM_EXECUTABLE_PATH =
  process.env.SIDECAR_HEADLESS_EXECUTABLE_PATH ||
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  "";
const HEADLESS_USER_DATA_ROOT = process.env.SIDECAR_HEADLESS_USER_DATA_DIR ??
  path.join(os.homedir(), "Library/Application Support/VrboSidecar-Headless");
const HEADLESS_PROXY_ENABLED = process.env.SIDECAR_HEADLESS_PROXY_ENABLED !== "0";
const HEADLESS_PROXY_DIRECT_FALLBACK = process.env.SIDECAR_HEADLESS_PROXY_DIRECT_FALLBACK !== "0";
const REQUIRED_PROXY_COUNTRY = "us";
const REQUIRE_SERVER_CHROME_PROVIDERS = new Set(
  String(process.env.SIDECAR_REQUIRE_SERVER_CHROME_PROVIDERS ?? "vrbo,booking")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean),
);
const POLL_IDLE_MS = Number(process.env.SIDECAR_POLL_IDLE_MS ?? 1_000);
const POLL_BUSY_MS = Number(process.env.SIDECAR_POLL_BUSY_MS ?? 2_000);
const SCREENSHOT_MIN_INTERVAL_MS = Math.max(
  500,
  Number(process.env.SIDECAR_SCREENSHOT_MIN_INTERVAL_MS ?? 1_500) || 1_500,
);
const SCREENSHOT_HEARTBEAT_MS = Math.max(
  1_000,
  Number(process.env.SIDECAR_SCREENSHOT_HEARTBEAT_MS ?? 2_500) || 2_500,
);
const SERVER_WORKER_CLAIM_DELAY_MS = Number(process.env.SIDECAR_SERVER_WORKER_CLAIM_DELAY_MS ?? 4_000);
const HEARTBEAT_BUSY_MS = Number(process.env.SIDECAR_HEARTBEAT_BUSY_MS ?? 30_000);
const PAGE_NAV_TIMEOUT_MS = 35_000;
const PAGE_SETTLE_MS = Number(process.env.SIDECAR_PAGE_SETTLE_MS ?? 3_000);
const PM_PARTIAL_DATE_RETRY_MS = Number(process.env.SIDECAR_PM_PARTIAL_DATE_RETRY_MS ?? 1_500);
const PM_POST_DATE_SETTLE_MS = Number(process.env.SIDECAR_PM_POST_DATE_SETTLE_MS ?? 2_500);
const PM_SITE_SEARCH_BUDGET_MS = Number(process.env.SIDECAR_PM_SITE_SEARCH_BUDGET_MS ?? 150_000);
const REQUEST_HARD_TIMEOUT_MS = Number(process.env.SIDECAR_REQUEST_HARD_TIMEOUT_MS ?? 10 * 60_000);
const REQUEST_MAX_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.SIDECAR_REQUEST_MAX_ATTEMPTS ?? 2) || 2));
const REQUEST_RETRY_BASE_MS = Math.max(250, Number(process.env.SIDECAR_REQUEST_RETRY_BASE_MS ?? 1_500) || 1_500);
const PM_SITE_SEARCH_TAB_CONCURRENCY = Math.max(1, Math.floor(Number(process.env.SIDECAR_PM_SITE_TAB_CONCURRENCY ?? 3) || 3));
const PM_URL_CHECK_BATCH_CONCURRENCY = Math.max(1, Math.floor(Number(process.env.SIDECAR_PM_URL_BATCH_CONCURRENCY ?? 8) || 8));
const BLOCKED_NAV_HOST_RE = /(^|\.)((facebook|instagram|threads|pinterest)\.com|facebook\.net|fbcdn\.net|x\.com|twitter\.com|t\.co)$/i;

let browser = null;
let context = null;
let page = null;
let contextGuardsInstalled = false;
let activeChromeAllocation = null;
let captchaWindowVisible = false;
let launchedPersistentContext = false;
let activeRuntimeRequest = null;
let activeHeadlessProxyBridge = null;
let activeBrowserFingerprint = null;

function usingHeadlessRuntime() {
  return USE_HEADLESS_LOCAL_BROWSER || activeChromeAllocation?.type === "headless";
}

function activeRequestIsVrbo() {
  return isVrboBrowserOp(activeRuntimeRequest?.opType ?? "");
}

function activeRequestShouldUseHeadlessProxy() {
  return Boolean(activeRuntimeRequest?.opType);
}

function providerKeyForOp(opType) {
  const op = String(opType || "").toLowerCase();
  if (op.startsWith("vrbo_")) return "vrbo";
  if (op.startsWith("booking_")) return "booking";
  if (op.startsWith("airbnb_")) return "airbnb";
  return op.replace(/_.*/, "");
}

function requiresServerChromeForOp(opType) {
  if (!USE_SERVER_BROWSER) return false;
  const op = String(opType || "").toLowerCase();
  const provider = providerKeyForOp(op);
  return REQUIRE_SERVER_CHROME_PROVIDERS.has(provider) || REQUIRE_SERVER_CHROME_PROVIDERS.has(op);
}

function needsFreshChromeForOp(opType) {
  return /^(airbnb|booking|vrbo)_/i.test(String(opType || ""));
}

function log(msg, ...rest) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [vrbo-sidecar:${WORKER_SLOT}]`, msg, ...rest);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function withSoftTimeout(promise, timeoutMs, fallback = undefined) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

function boolFromEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function nonEmptyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function sanitizeProxyOption(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 64);
}

function replaceOrAppendProxyOption(value, option, optionValue) {
  const safeOptionValue = sanitizeProxyOption(optionValue);
  if (!safeOptionValue) return value;
  const pattern = new RegExp(`(^|-)${option}-[a-z0-9_]+(?=-|$)`, "i");
  if (pattern.test(value)) return value.replace(pattern, `$1${option}-${safeOptionValue}`);
  return `${value}-${option}-${safeOptionValue}`;
}

function headlessProxySessionId() {
  const base = [
    activeRuntimeRequest?.id,
    activeRuntimeRequest?.opType,
    activeRuntimeRequest?.freshSessionReason,
    activeRuntimeRequest?.requestAttempt ? `attempt${activeRuntimeRequest.requestAttempt}` : "attempt0",
    activeRuntimeRequest?.vrboFreshAttempt ? `fresh${activeRuntimeRequest.vrboFreshAttempt}` : "initial",
    `slot${WORKER_SLOT}`,
    Date.now().toString(36),
  ]
    .filter(Boolean)
    .join("-");
  return base.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 48) || `sidecar${Date.now().toString(36)}`;
}

function appendBrightDataUsernameOptions(username) {
  let next = replaceOrAppendProxyOption(username, "country", REQUIRED_PROXY_COUNTRY);
  if (!/-session-[a-z0-9_]+(?:-|$)/i.test(next)) {
    next += `-session-${headlessProxySessionId()}`;
  }
  return next;
}

async function headlessProxyConfig() {
  if (!HEADLESS_PROXY_ENABLED) return null;
  if (!activeRequestShouldUseHeadlessProxy()) return null;

  return resolveChromeProxyConfig({
    enabled: boolFromEnv("CHROME_PROXY_ENABLED", false),
    sessionId: { instance: { name: `worker-${WORKER_SLOT}` }, request: activeRuntimeRequest },
    brightDataUsernameOptions: (username) => appendBrightDataUsernameOptions(username),
    incompleteConfigMessage:
      "SIDECAR_HEADLESS_PROXY_ENABLED=1 but proxy config is incomplete. Set CHROME_PROXY_HOST, CHROME_PROXY_PORT, CHROME_PROXY_USERNAME, and CHROME_PROXY_PASSWORD, or set CHROME_PROXY_PROVIDER=gonzoproxy with GONZOPROXY_API_KEY, or CHROME_PROXY_PROVIDER=decodo with DECODO_PROXY_USERNAME/PASSWORD.",
  });
}

function writeProxyError(socket, status = 502, message = "Bad Gateway") {
  if (!socket || socket.destroyed) return;
  try {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {}
}

function proxyHeaderEntries(headers, proxyAuthorization) {
  return Object.entries(headers || {})
    .filter(([name]) => !/^proxy-(authorization|connection)$/i.test(name))
    .flatMap(([name, value]) => {
      if (value == null) return [];
      if (Array.isArray(value)) return value.map((item) => `${name}: ${item}`);
      return [`${name}: ${value}`];
    })
    .concat(`Proxy-Authorization: ${proxyAuthorization}`, "Proxy-Connection: Keep-Alive");
}

async function probeHeadlessProxyAuth(proxyConfig, target = "lumtest.com:443") {
  const proxyAuthorization = `Basic ${Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString("base64")}`;
  return await new Promise((resolve) => {
    const socket = net.connect(proxyConfig.port, proxyConfig.host);
    socket.setTimeout(8_000);
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\n` +
        `Host: ${target}\r\n` +
        `Proxy-Authorization: ${proxyAuthorization}\r\n` +
        "Proxy-Connection: Keep-Alive\r\n\r\n",
      );
    });
    let headerBuffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const headerEnd = headerBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const rawHeader = headerBuffer.slice(0, headerEnd).toString("latin1");
      const statusLine = rawHeader.split("\r\n")[0] || "";
      const status = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? 0);
      socket.destroy();
      resolve({ ok: status >= 200 && status < 300, status, statusLine });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, status: 0, statusLine: "proxy auth probe timed out" });
    });
    socket.once("error", (e) => {
      resolve({ ok: false, status: 0, statusLine: e?.message ?? "proxy auth probe failed" });
    });
  });
}

async function startHeadlessProxyAuthBridge(proxyConfig) {
  const proxyAuthorization = `Basic ${Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString("base64")}`;
  const upstreamHost = proxyConfig.host;
  const upstreamPort = proxyConfig.port;

  const server = http.createServer((clientReq, clientRes) => {
    const upstream = net.connect(upstreamPort, upstreamHost);
    upstream.once("connect", () => {
      const headerLines = proxyHeaderEntries(clientReq.headers, proxyAuthorization).join("\r\n");
      upstream.write(`${clientReq.method} ${clientReq.url} HTTP/${clientReq.httpVersion}\r\n${headerLines}\r\n\r\n`);
      clientReq.pipe(upstream);
    });
    upstream.on("error", (e) => {
      log(`headless proxy bridge HTTP upstream failed: ${e?.message ?? e}`);
      if (!clientRes.headersSent) clientRes.writeHead(502, { Connection: "close" });
      clientRes.end();
    });
    upstream.pipe(clientRes);
  });

  server.on("connect", (req, clientSocket, head) => {
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      const headerLines = [
        `Host: ${req.url}`,
        `Proxy-Authorization: ${proxyAuthorization}`,
        "Proxy-Connection: Keep-Alive",
      ].join("\r\n");
      upstream.write(`CONNECT ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
      if (head?.length) upstream.write(head);
    });

    let headerBuffer = Buffer.alloc(0);
    const onData = (chunk) => {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const headerEnd = headerBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      upstream.off("data", onData);
      const rawHeader = headerBuffer.slice(0, headerEnd).toString("latin1");
      const rest = headerBuffer.slice(headerEnd + 4);
      const status = Number(rawHeader.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? 0);

      if (status >= 200 && status < 300) {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) clientSocket.write(rest);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        return;
      }

      const statusText = status === 407 ? "Proxy Authentication Required" : "Proxy upstream failure";
      log(`headless proxy bridge upstream CONNECT failed: HTTP ${status || "unknown"} for ${req.url}`);
      writeProxyError(clientSocket, status || 502, statusText);
      upstream.destroy();
    };

    upstream.on("data", onData);
    upstream.on("error", (e) => {
      log(`headless proxy bridge CONNECT upstream failed: ${e?.message ?? e}`);
      writeProxyError(clientSocket);
    });
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    serverUrl: `http://127.0.0.1:${port}`,
    proxyConfig,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function closeHeadlessProxyBridge(reason) {
  if (!activeHeadlessProxyBridge) return;
  const bridge = activeHeadlessProxyBridge;
  activeHeadlessProxyBridge = null;
  try {
    await bridge.close();
    log(`closed headless proxy auth bridge: ${reason}`);
  } catch (e) {
    log(`headless proxy auth bridge close failed: ${e?.message ?? e}`);
  }
}

async function boundedPageDelay(targetPage, timeoutMs) {
  await withSoftTimeout(
    targetPage?.waitForTimeout?.(timeoutMs),
    Math.max(1_000, timeoutMs + 1_000),
    null,
  );
}

class SidecarHardTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "SidecarHardTimeoutError";
  }
}

class VrboHardBlockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VrboHardBlockError";
    this.details = details;
  }
}

class ProviderBrowserUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProviderBrowserUnavailableError";
    this.details = details;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transientErrorMessage(message) {
  return /timeout|timed out|navigation|net::|socket|fetch failed|econnreset|econnrefused|etimedout|protocol error|target closed|browser has been closed|disconnected|context.*closed|page.*closed|execution context was destroyed|cdp/i.test(
    String(message ?? ""),
  );
}

function providerTunnelProxyErrorMessage(message) {
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_PROXY_AUTH_UNSUPPORTED|tunnel connection failed|proxy.*(?:407|429|500|502|503|504)|HTTP\s+(?:407|429|500|502|503|504).*(?:CONNECT|proxy)|upstream CONNECT failed/i.test(
    String(message ?? ""),
  );
}

function isProviderTunnelProxyError(error) {
  return providerTunnelProxyErrorMessage(error?.message ?? error);
}

function isTransientScrapeError(error) {
  if (
    error instanceof SidecarCancelledError ||
    error instanceof SidecarHardTimeoutError ||
    error instanceof VrboHardBlockError ||
    error instanceof ProviderBrowserUnavailableError
  ) return false;
  return transientErrorMessage(error?.message ?? error);
}

function hardTimeoutMsForOp(opType) {
  switch (opType) {
    case "pm_site_search":
      return Math.max(REQUEST_HARD_TIMEOUT_MS, PM_SITE_SEARCH_BUDGET_MS + 90_000);
    case "pm_url_check_batch":
      return Math.max(REQUEST_HARD_TIMEOUT_MS, 4 * 60_000);
    default:
      return REQUEST_HARD_TIMEOUT_MS;
  }
}

async function runWithHardTimeout(label, opType, fn) {
  const timeoutMs = hardTimeoutMsForOp(opType);
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new SidecarHardTimeoutError(`${label} exceeded hard timeout ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseWindowPosition(raw, fallback) {
  const [x, y] = String(raw ?? "").split(",").map((part) => Number(part.trim()));
  if (Number.isFinite(x) && Number.isFinite(y)) return { left: Math.round(x), top: Math.round(y) };
  return fallback;
}

function macAppPathFromChromeBinary(binary) {
  const marker = ".app/Contents/MacOS/";
  const idx = String(binary ?? "").indexOf(marker);
  return idx >= 0 ? String(binary).slice(0, idx + ".app".length) : "";
}

function hostFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function shouldBlockNavigation(rawUrl) {
  const host = hostFromUrl(rawUrl);
  return Boolean(host && BLOCKED_NAV_HOST_RE.test(host));
}

async function minimizeSidecarWindow(targetPage = page) {
  if (usingHeadlessRuntime()) return;
  if (SIDE_CAR_CHROME_VISIBLE || captchaWindowVisible) return;
  if (!context || !targetPage || targetPage.isClosed?.()) return;
  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (!session) return;
  try {
    const info = await withSoftTimeout(session.send("Browser.getWindowForTarget"), 1_500, null);
    const windowId = info?.windowId;
    if (typeof windowId !== "number") return;
    const hidden = parseWindowPosition(process.env.SIDECAR_CHROME_HIDDEN_POSITION ?? HIDDEN_WINDOW_POSITION, { left: -32000, top: -32000 });
    await withSoftTimeout(
      session.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: hidden.left,
          top: hidden.top,
          width: VIEWPORT.width,
          height: VIEWPORT.height + 80,
        },
      }),
      1_500,
    );
    await withSoftTimeout(
      session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      }),
      1_500,
    );
  } catch {
    // Best effort only: the offscreen position still applies if CDP
    // window management is unavailable for a particular Chrome build.
  } finally {
    await withSoftTimeout(session.detach(), 500);
  }
}

function scheduleSidecarMinimize(targetPage = page) {
  if (usingHeadlessRuntime()) return;
  if (SIDE_CAR_CHROME_VISIBLE || captchaWindowVisible) return;
  for (const delay of [0, 150, 500, 1500]) {
    const timer = setTimeout(() => {
      void minimizeSidecarWindow(targetPage);
    }, delay);
    timer.unref?.();
  }
}

async function setCaptchaWindowVisibility(targetPage = page, visible, label = "sidecar", id = "") {
  if (usingHeadlessRuntime()) {
    if (visible) {
      await postScreenSnapshot({ id, opType: label }, targetPage, "manual CAPTCHA needed in embedded screenshot", { captcha: true, force: true });
      log(`${label} ${id}: CAPTCHA detected in headless mode; no local Chrome window will be surfaced`);
    }
    return false;
  }
  if (SIDE_CAR_CHROME_VISIBLE) return true;
  if (!context || !targetPage || targetPage.isClosed?.()) return false;
  if (visible && !SIDECAR_CAPTCHA_SURFACE_WINDOW) {
    log(`${label} ${id}: CAPTCHA manual surfacing disabled by SIDECAR_CAPTCHA_SURFACE_WINDOW=0`);
    return false;
  }

  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (!session) return false;
  try {
    const info = await withSoftTimeout(session.send("Browser.getWindowForTarget"), 1_500, null);
    const windowId = info?.windowId;
    if (typeof windowId !== "number") return false;

    if (visible) {
      const pos = parseWindowPosition(VISIBLE_WINDOW_POSITION, { left: 120, top: 80 });
      captchaWindowVisible = true;
      await withSoftTimeout(session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }), 1_500);
      await withSoftTimeout(
        session.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            left: pos.left,
            top: pos.top,
            width: VIEWPORT.width,
            height: VIEWPORT.height + 80,
          },
        }),
        1_500,
      );
      if (SIDECAR_CAPTCHA_ALLOW_FOCUS || SIDECAR_ALLOW_FOCUS) {
        await targetPage.bringToFront().catch(() => {});
      }
      log(`${label} ${id}: surfaced only this Chrome window for manual CAPTCHA verification`);
      await postScreenSnapshot({ id, opType: label }, targetPage, "manual CAPTCHA verification", { captcha: true, force: true });
    } else {
      captchaWindowVisible = false;
      const hidden = parseWindowPosition(process.env.SIDECAR_CHROME_HIDDEN_POSITION ?? HIDDEN_WINDOW_POSITION, { left: -32000, top: -32000 });
      await withSoftTimeout(
        session.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            left: hidden.left,
            top: hidden.top,
            width: VIEWPORT.width,
            height: VIEWPORT.height + 80,
          },
        }),
        1_500,
      );
      await withSoftTimeout(session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } }), 1_500);
      log(`${label} ${id}: returned Chrome window to hidden/background mode`);
      await postScreenSnapshot({ id, opType: label }, targetPage, "CAPTCHA cleared/backgrounded", { force: true });
    }
    return true;
  } catch (e) {
    log(`${label} ${id}: CAPTCHA window visibility change failed: ${e?.message ?? e}`);
    return false;
  } finally {
    await withSoftTimeout(session.detach(), 500);
  }
}

async function installContextGuards() {
  if (!context || contextGuardsInstalled) return;
  contextGuardsInstalled = true;

  await context.route("**/*", async (route) => {
    const rawUrl = route.request().url();
    if (shouldBlockNavigation(rawUrl)) {
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  }).catch((e) => {
    log(`context route guard failed: ${e?.message ?? e}`);
  });

  context.on("page", (createdPage) => {
    scheduleSidecarMinimize(createdPage);
    void (async () => {
      await applyFingerprintToPage(createdPage).catch(() => {});
      await createdPage.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
      scheduleSidecarMinimize(createdPage);
      const rawUrl = createdPage.url?.() ?? "";
      if (shouldBlockNavigation(rawUrl)) {
        log(`closed blocked popup/tab: ${rawUrl.slice(0, 140)}`);
        await createdPage.close({ runBeforeUnload: false }).catch(() => {});
      }
    })();
  });
}

async function closeExtraTabs(reason, keepPage = page) {
  if (!context) return 0;
  const pages = context.pages().filter((p) => p && !p.isClosed?.());
  let closedCount = 0;
  for (const candidate of pages) {
    if (candidate === keepPage) continue;
    try {
      const closed = await withSoftTimeout(
        candidate.close({ runBeforeUnload: false }).then(() => true),
        1_500,
        false,
      );
      if (closed) closedCount++;
    } catch {
      // Racy by nature: Chrome may already have closed the tab.
    }
  }
  if (closedCount > 0) log(`${reason}: closed ${closedCount} extra tab(s)`);
  return closedCount;
}

async function dismissObstructions(targetPage = page, label = "page") {
  if (!targetPage || targetPage.isClosed?.()) return [];
  const actions = [];
  for (let pass = 0; pass < 4; pass++) {
    const action = await withSoftTimeout(
      targetPage.evaluate(() => {
        const CONTROL_SELECTOR = "button, a, [role='button'], input[type='button'], input[type='submit'], [aria-label], [title]";
        const ROOT_SELECTOR = [
          "[role='dialog']",
          "[aria-modal='true']",
          "[class*='modal' i]",
          "[id*='modal' i]",
          "[class*='popup' i]",
          "[id*='popup' i]",
          "[class*='overlay' i]",
          "[id*='overlay' i]",
          "[class*='newsletter' i]",
          "[id*='newsletter' i]",
          "[class*='cookie' i]",
          "[id*='cookie' i]",
          "[class*='consent' i]",
          "[id*='consent' i]",
          "#onetrust-banner-sdk",
          ".cc-window",
        ].join(",");
        const closeRe = /(?:^|\b)(?:close|dismiss|no thanks|not now|skip|maybe later|continue without|×|x)(?:\b|$)/i;
        const strictCloseRe = /^(?:×|x|close|dismiss)$/i;
        const cookieRe = /\b(?:accept all|accept cookies|allow all|i agree|agree|reject all|decline|got it|ok)\b/i;
        const globalCookieRe = /\b(?:accept all|accept cookies|allow all|i agree|reject all|decline)\b/i;
        const socialRe = /\b(?:twitter|x\.com|facebook|instagram|threads|pinterest|social|share)\b/i;
        const socialHrefRe = /(?:^|\/\/|\.)(?:x\.com|twitter\.com|facebook\.com|instagram\.com|threads\.net|pinterest\.com|t\.co)\b/i;

        function isVisible(el) {
          if (!el || !(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) return false;
          if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
        }

        function labelOf(el) {
          return [
            el.textContent,
            el.getAttribute?.("aria-label"),
            el.getAttribute?.("title"),
            el.getAttribute?.("value"),
          ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        }

        function isDisabled(el) {
          return Boolean(el.disabled) || el.getAttribute?.("aria-disabled") === "true";
        }

        function isSocialControl(el, label) {
          const compact = String(label || "").trim();
          const href = el.closest?.("a[href]")?.getAttribute("href") || el.getAttribute?.("href") || "";
          return socialRe.test(compact) || socialHrefRe.test(href);
        }

        function isDismissLabel(label) {
          const compact = String(label || "").trim();
          if (!compact) return false;
          // Accessibility skip links are often visible/focusable near the top
          // of PM pages. They are not overlays and clicking them can move the
          // page away from the booking widget during rate checks.
          if (/^skip\s+to\s+main\s+content$/i.test(compact)) return false;
          if (strictCloseRe.test(compact)) return true;
          return compact.length <= 90 && closeRe.test(compact);
        }

        function clickCandidate(el, kind) {
          const rect = el.getBoundingClientRect();
          const label = labelOf(el).slice(0, 80) || el.tagName.toLowerCase();
          el.scrollIntoView?.({ block: "center", inline: "center" });
          el.click();
          return {
            clicked: true,
            kind,
            label,
            tag: el.tagName.toLowerCase(),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
        }

        const roots = Array.from(document.querySelectorAll(ROOT_SELECTOR))
          .filter(isVisible)
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
          });

        for (const root of roots) {
          const rootText = [
            root.id,
            root.className,
            root.getAttribute?.("aria-label"),
            root.textContent,
          ].filter(Boolean).join(" ").slice(0, 2000);
          const looksCookie = /cookie|consent|privacy|gdpr|onetrust/i.test(rootText);
          const controls = Array.from(root.querySelectorAll(CONTROL_SELECTOR))
            .filter((el) => isVisible(el) && !isDisabled(el));
          const target = controls.find((el) => {
            const label = labelOf(el);
            if (!label) return false;
            if (isSocialControl(el, label)) return false;
            if (looksCookie && cookieRe.test(label)) return true;
            return isDismissLabel(label);
          });
          if (target) {
            const targetLabel = labelOf(target);
            const kind = looksCookie && cookieRe.test(targetLabel) ? "cookie-or-consent" : "modal-or-popup";
            return clickCandidate(target, kind);
          }
        }

        const controls = Array.from(document.querySelectorAll(CONTROL_SELECTOR))
          .filter((el) => isVisible(el) && !isDisabled(el));
        const cookieTarget = controls.find((el) => {
          const label = labelOf(el);
          return !isSocialControl(el, label) && globalCookieRe.test(label);
        });
        if (cookieTarget) return clickCandidate(cookieTarget, "cookie-or-consent");

        const closeTarget = controls.find((el) => {
          const label = labelOf(el);
          if (isSocialControl(el, label)) return false;
          if (!isDismissLabel(label)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width <= 96 && rect.height <= 96;
        });
        if (closeTarget) return clickCandidate(closeTarget, "global-close");

        return null;
      }),
      2_500,
      null,
    );
    if (!action?.clicked) break;
    actions.push(action);
    await targetPage.waitForTimeout(400).catch(() => {});
  }

  const stillBlocked = await withSoftTimeout(
    targetPage.evaluate(() => {
      const roots = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true'], [class*='modal' i], [class*='popup' i], [class*='overlay' i]"));
      return roots.some((el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      });
    }),
    1_000,
    false,
  );
  if (stillBlocked) {
    await targetPage.keyboard.press("Escape").catch(() => {});
    actions.push({ clicked: true, kind: "escape", label: "Escape" });
    await targetPage.waitForTimeout(400).catch(() => {});
  }

  if (actions.length > 0) {
    log(`${label}: dismissed obstruction(s): ${actions.map((a) => `${a.kind}:${a.label}`).join("; ")}`);
  }
  return actions;
}

function withPagePrepReason(result, dismissals, dateEntry) {
  if (!result) return result;
  const parts = [];
  if (Array.isArray(dismissals) && dismissals.length > 0) {
    const detail = dismissals
      .slice(0, 4)
      .map((a) => `${a.kind}:${a.label}`)
      .join(", ");
    parts.push(`dismissed obstruction(s): ${detail}`);
  }
  const filledCount = dateEntry?.filled?.length ?? 0;
  if (filledCount > 0 || dateEntry?.openedLabel || dateEntry?.submitLabel) {
    parts.push(
      `entered dates (${filledCount} field${filledCount === 1 ? "" : "s"}` +
      `${dateEntry?.openedLabel ? `, opened "${dateEntry.openedLabel}"` : ""}` +
      `${dateEntry?.submitLabel ? `, clicked "${dateEntry.submitLabel}"` : ""})`,
    );
  }
  if (parts.length === 0) return result;
  const base = result.reason || "Parsed page";
  return {
    ...result,
    reason: `${base}; ${parts.join("; ")}`.slice(0, 800),
  };
}

function pmDateEntryComplete(dateEntry) {
  return Boolean(
    dateEntry?.filled?.some((f) => f.role === "range") ||
    (dateEntry?.filled?.some((f) => f.role === "checkin") && dateEntry?.filled?.some((f) => f.role === "checkout")),
  );
}

function attachDetectedBedrooms(result, bedrooms) {
  if (!result) return result;
  if (typeof result.bedrooms === "number" && Number.isFinite(result.bedrooms)) return result;
  return {
    ...result,
    bedrooms: typeof bedrooms === "number" && Number.isFinite(bedrooms) ? bedrooms : null,
  };
}

async function detectPmPageBedrooms(targetPage) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  return withSoftTimeout(
    targetPage.evaluate(() => {
      function clean(raw) {
        return String(raw || "").replace(/\s+/g, " ").trim();
      }
      function extractBedroomCount(raw) {
        const text = clean(raw).toLowerCase();
        if (!text) return null;
        if (/\bstudio\b|\befficiency\b/.test(text)) return 0;
        const direct = text.match(/\b([1-9])\s*(?:br|bd|bdr|bedrooms?|bed\s*rooms?)\b/);
        if (direct) return parseInt(direct[1], 10);
        const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
        for (const [word, count] of Object.entries(words)) {
          if (new RegExp(`\\b${word}[\\s-]*(?:bedroom|bedrooms|bed\\s*rooms?)\\b`).test(text)) return count;
        }
        return null;
      }
      const selectorGroups = [
        "h1, [data-testid*='title' i], [class*='title' i]",
        "[data-testid*='bedroom' i], [class*='bedroom' i], [class*='property-info' i], [class*='property-details' i], [class*='unit-details' i], [class*='amenit' i]",
        "meta[name='description'], meta[property='og:description']",
      ];
      for (const selectors of selectorGroups) {
        const parts = Array.from(document.querySelectorAll(selectors))
          .slice(0, 12)
          .map((el) => el instanceof HTMLMetaElement ? el.content : el.textContent)
          .map(clean)
          .filter(Boolean);
        const found = extractBedroomCount(parts.join(" | "));
        if (found !== null) return found;
      }
      return extractBedroomCount(`${document.title || ""} ${(document.body?.innerText || "").slice(0, 3000)}`);
    }),
    2_000,
    null,
  ).catch(() => null);
}

function authHeaders() {
  return ADMIN_SECRET ? { "X-Admin-Secret": ADMIN_SECRET } : {};
}

function workerRuntimeMetadata() {
  return {
    slot: WORKER_SLOT,
    workerRole: WORKER_ROLE,
    browserMode: SIDECAR_BROWSER_MODE,
    chromePrimary: CHROME_PRIMARY,
  };
}

function normaliseCookieRecords(arr) {
  const sameSiteMap = { strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None" };
  return arr
    .filter((c) => c?.name && c?.value && c?.domain)
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
      sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax",
    }));
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_FILE)) {
    log(`cookies.json not found at ${COOKIES_FILE}; using Chrome profile/server-pushed cookies only`);
    return [];
  }
  const raw = fs.readFileSync(COOKIES_FILE, "utf8").trim();
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("cookies.json is empty or not a JSON array.");
  }
  return normaliseCookieRecords(arr);
}

async function addCookiesBestEffort(cookies, label) {
  if (!cookies?.length || !context) return false;
  try {
    await context.addCookies(cookies);
    return true;
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/Browser context management is not supported|Storage\.setCookies|Target page, context or browser has been closed/i.test(msg)) {
      log(`${label}: cookie injection unavailable over CDP; continuing with Chrome profile cookies`);
      return false;
    }
    throw e;
  }
}

async function isCdpReady() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureChromeRunning() {
  if (await isCdpReady()) return;
  if (!fs.existsSync(CHROME_BINARY)) {
    throw new Error(`Google Chrome not found at ${CHROME_BINARY}`);
  }
  fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    `--window-size=${SIDE_CAR_CHROME_VISIBLE ? VISIBLE_WINDOW_SIZE.width : VIEWPORT.width},${SIDE_CAR_CHROME_VISIBLE ? VISIBLE_WINDOW_SIZE.height : VIEWPORT.height + 80}`,
    `--window-position=${SIDE_CAR_CHROME_VISIBLE ? VISIBLE_WINDOW_POSITION : HIDDEN_WINDOW_POSITION}`,
    "--force-device-scale-factor=1",
    ...(SIDE_CAR_CHROME_VISIBLE ? [] : ["--start-minimized", "--no-startup-window"]),
    "--disable-notifications",
    "--disable-backgrounding-occluded-windows",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  const launchHiddenOnMac = process.platform === "darwin" && !SIDE_CAR_CHROME_VISIBLE;
  const macAppPath = launchHiddenOnMac && SIDECAR_MACOS_BACKGROUND_LAUNCH
    ? macAppPathFromChromeBinary(CHROME_BINARY)
    : "";
  const command = macAppPath ? "open" : CHROME_BINARY;
  const args = macAppPath ? ["-g", "-j", "-n", macAppPath, "--args", ...chromeArgs] : chromeArgs;
  log(
    `spawning Chrome ${
      launchHiddenOnMac ? (macAppPath ? "macOS background hidden/offscreen " : "direct hidden/offscreen ") : ""
    }(port ${CDP_PORT}, user-data-dir ${CHROME_DATA_DIR})…`,
  );
  const proc = spawn(
    command,
    args,
    { detached: true, stdio: "ignore" },
  );
  proc.unref();
  for (let i = 0; i < 40; i++) {
    if (await isCdpReady()) {
      log("Chrome CDP ready");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Chrome spawned but CDP did not become ready within 20s");
}

const chromeSidecarManager = new ChromeSidecarManager({ viewport: VIEWPORT, log });

async function acquireChromeForRequest(request = {}) {
  if (USE_HEADLESS_LOCAL_BROWSER) {
    if (requiresServerChromeForOp(request?.opType)) {
      throw new ProviderBrowserUnavailableError(
        `${providerKeyForOp(request?.opType).toUpperCase()} requires headed server Google Chrome/noVNC for this search. ` +
        `SIDECAR_BROWSER_MODE=${SIDECAR_BROWSER_MODE} would run it headless, so the provider search was refused instead of getting stuck behind CAPTCHA or bot checks.`,
        { opType: request?.opType, provider: providerKeyForOp(request?.opType) },
      );
    }
    return {
      type: "headless",
      label: WORKER_ROLE === "server" ? "Railway headless Chromium" : "local headless Chrome",
      cdpUrl: null,
      noVncUrl: null,
      ephemeral: false,
      release: async () => {},
    };
  }
  if (activeChromeAllocation && needsFreshChromeForOp(request?.opType)) {
    await teardownBrowser(`fresh browser required for ${request.opType}`);
  } else if (activeChromeAllocation) {
    return activeChromeAllocation;
  }
  try {
    activeChromeAllocation = await chromeSidecarManager.acquire(request);
  } catch (e) {
    if (USE_SERVER_BROWSER && HEADLESS_FALLBACK_ENABLED) {
      const label = WORKER_ROLE === "server"
        ? "Railway headless Chromium fallback"
        : "no-window local headless Chrome fallback";
      if (requiresServerChromeForOp(request?.opType)) {
        throw new ProviderBrowserUnavailableError(
          `${providerKeyForOp(request?.opType).toUpperCase()} requires headed server Google Chrome/noVNC for this search, ` +
          `but server Chrome was unavailable: ${e?.message ?? e}. ` +
          "Not falling back to headless Chromium because it gets stuck behind CAPTCHA or bot checks.",
          { opType: request?.opType, provider: providerKeyForOp(request?.opType) },
        );
      }
      log(`server Chrome/noVNC unavailable; falling back to ${label}: ${e?.message ?? e}`);
      activeChromeAllocation = {
        type: "headless",
        label,
        cdpUrl: null,
        noVncUrl: null,
        proxyConfig: null,
        ephemeral: false,
        release: async () => {},
      };
    } else {
      throw e;
    }
  }
  log(
    activeChromeAllocation.cdpUrl
      ? `using ${activeChromeAllocation.label} via CDP (${activeChromeAllocation.cdpUrl})` +
          (activeChromeAllocation.noVncUrl ? `; live view ${activeChromeAllocation.noVncUrl}` : "")
      : `using ${activeChromeAllocation.label} without desktop Chrome`,
  );
  if (activeChromeAllocation.noVncUrl && request.id) {
    await sendHeartbeat(`server Chrome live view ${activeChromeAllocation.noVncUrl}`, true, request.id).catch(() => {});
  }
  return activeChromeAllocation;
}

async function verifyActiveChromeHealth(label = "chrome health") {
  if (usingHeadlessRuntime()) return true;
  if (!activeChromeAllocation?.cdpUrl) return true;
  const ok = await withSoftTimeout(chromeSidecarManager.isCdpReady(activeChromeAllocation.cdpUrl), 2_500, false);
  if (!ok) {
    throw new Error(`${label}: CDP health check failed for ${activeChromeAllocation.label}`);
  }
  return true;
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOne(items, rand) {
  return items[Math.floor(rand() * items.length) % items.length];
}

function browserFingerprintForRequest(request = activeRuntimeRequest) {
  if (process.env.SIDECAR_BROWSER_FINGERPRINT_RANDOMIZATION === "0") return null;
  const seedText = [
    request?.id,
    request?.opType,
    request?.freshSessionReason,
    request?.requestAttempt ?? 0,
    request?.vrboFreshAttempt ?? 0,
    WORKER_SLOT,
    Date.now().toString(36),
  ].filter((part) => part != null && part !== "").join("|");
  const rand = seededRandom(hashString(seedText));
  const chromeMajor = pickOne([124, 125, 126, 127], rand);
  const chromePatch = 6000 + Math.floor(rand() * 2200);
  const personas = [
    {
      os: "windows",
      platform: "Win32",
      uaPlatform: "Windows",
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromePatch}.0 Safari/537.36`,
      viewport: pickOne([{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1536, height: 864 }, { width: 1600, height: 900 }, { width: 1920, height: 1080 }], rand),
      webglVendor: "Google Inc. (Intel)",
      webglRenderer: pickOne([
        "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
        "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      ], rand),
    },
    {
      os: "macos",
      platform: "MacIntel",
      uaPlatform: "macOS",
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromePatch}.0 Safari/537.36`,
      viewport: pickOne([{ width: 1440, height: 900 }, { width: 1512, height: 982 }, { width: 1680, height: 1050 }, { width: 1728, height: 1117 }], rand),
      webglVendor: "Google Inc. (Apple)",
      webglRenderer: pickOne([
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
        "ANGLE (Apple, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics, Unspecified Version)",
      ], rand),
    },
  ];
  const persona = pickOne(personas, rand);
  const timezone = pickOne(["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Pacific/Honolulu"], rand);
  const deviceScaleFactor = persona.os === "macos" ? pickOne([1, 2], rand) : pickOne([1, 1.25, 1.5], rand);
  const hardwareConcurrency = pickOne([4, 6, 8, 10, 12], rand);
  const deviceMemory = pickOne([4, 8, 16], rand);
  const id = hashString(`${seedText}|${persona.os}|${persona.viewport.width}x${persona.viewport.height}|${timezone}`).toString(16);
  return {
    id,
    ...persona,
    locale: "en-US",
    language: "en-US",
    languages: ["en-US", "en"],
    acceptLanguage: "en-US,en;q=0.9",
    timezone,
    deviceScaleFactor,
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints: 0,
    screen: {
      width: persona.viewport.width,
      height: persona.viewport.height,
      availWidth: persona.viewport.width,
      availHeight: Math.max(640, persona.viewport.height - 40),
      colorDepth: 24,
      pixelDepth: 24,
    },
  };
}

async function installFingerprintInitScript(targetContext, fingerprint) {
  if (!targetContext || !fingerprint) return;
  await withSoftTimeout(targetContext.setExtraHTTPHeaders?.({ "Accept-Language": fingerprint.acceptLanguage }), 1_500, null);
  await withSoftTimeout(targetContext.addInitScript((fp) => {
    const defineGetter = (target, prop, value) => {
      try {
        Object.defineProperty(target, prop, { get: () => value, configurable: true });
      } catch {}
    };
    defineGetter(Navigator.prototype, "webdriver", undefined);
    defineGetter(Navigator.prototype, "platform", fp.platform);
    defineGetter(Navigator.prototype, "hardwareConcurrency", fp.hardwareConcurrency);
    defineGetter(Navigator.prototype, "deviceMemory", fp.deviceMemory);
    defineGetter(Navigator.prototype, "language", fp.language);
    defineGetter(Navigator.prototype, "languages", fp.languages);
    defineGetter(Navigator.prototype, "maxTouchPoints", fp.maxTouchPoints);
    defineGetter(Screen.prototype, "width", fp.screen.width);
    defineGetter(Screen.prototype, "height", fp.screen.height);
    defineGetter(Screen.prototype, "availWidth", fp.screen.availWidth);
    defineGetter(Screen.prototype, "availHeight", fp.screen.availHeight);
    defineGetter(Screen.prototype, "colorDepth", fp.screen.colorDepth);
    defineGetter(Screen.prototype, "pixelDepth", fp.screen.pixelDepth);
    try {
      if (!window.chrome) {
        Object.defineProperty(window, "chrome", {
          value: { runtime: {} },
          configurable: true,
        });
      }
    } catch {}
    const patchWebGL = (Proto) => {
      if (!Proto?.prototype?.getParameter) return;
      const original = Proto.prototype.getParameter;
      Object.defineProperty(Proto.prototype, "getParameter", {
        value(parameter) {
          if (parameter === 37445) return fp.webglVendor;
          if (parameter === 37446) return fp.webglRenderer;
          return original.apply(this, arguments);
        },
        configurable: true,
      });
    };
    patchWebGL(window.WebGLRenderingContext);
    patchWebGL(window.WebGL2RenderingContext);
  }, fingerprint), 1_500, null);
}

async function applyFingerprintToPage(targetPage = page, fingerprint = activeBrowserFingerprint) {
  if (!targetPage || targetPage.isClosed?.() || !fingerprint) return;
  await withSoftTimeout(targetPage.addInitScript((fp) => {
    const defineGetter = (target, prop, value) => {
      try { Object.defineProperty(target, prop, { get: () => value, configurable: true }); } catch {}
    };
    defineGetter(Navigator.prototype, "webdriver", undefined);
    defineGetter(Navigator.prototype, "platform", fp.platform);
    defineGetter(Navigator.prototype, "hardwareConcurrency", fp.hardwareConcurrency);
    defineGetter(Navigator.prototype, "deviceMemory", fp.deviceMemory);
    defineGetter(Navigator.prototype, "language", fp.language);
    defineGetter(Navigator.prototype, "languages", fp.languages);
    defineGetter(Navigator.prototype, "maxTouchPoints", fp.maxTouchPoints);
  }, fingerprint), 1_500, null);
  await withSoftTimeout(targetPage.setViewportSize(fingerprint.viewport), 1_500, null);
  const session = await withSoftTimeout(context?.newCDPSession(targetPage), 1_500, null);
  if (!session) return;
  try {
    await withSoftTimeout(session.send("Network.setUserAgentOverride", {
      userAgent: fingerprint.userAgent,
      acceptLanguage: fingerprint.acceptLanguage,
      platform: fingerprint.uaPlatform,
    }), 1_500, null);
    await withSoftTimeout(session.send("Emulation.setTimezoneOverride", { timezoneId: fingerprint.timezone }), 1_500, null);
    await withSoftTimeout(session.send("Emulation.setLocaleOverride", { locale: fingerprint.locale }), 1_500, null);
    await withSoftTimeout(session.send("Emulation.setDeviceMetricsOverride", {
      width: fingerprint.viewport.width,
      height: fingerprint.viewport.height,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      mobile: false,
      screenWidth: fingerprint.screen.width,
      screenHeight: fingerprint.screen.height,
      positionX: 0,
      positionY: 0,
    }), 1_500, null);
  } finally {
    await withSoftTimeout(session.detach(), 500, null);
  }
}

async function releaseChromeForRequest() {
  if (usingHeadlessRuntime()) {
    activeChromeAllocation = null;
    return;
  }
  if (!activeChromeAllocation) return;
  const allocation = activeChromeAllocation;
  activeChromeAllocation = null;
  try {
    await allocation.release?.();
  } catch (e) {
    log(`release ${allocation.label} failed: ${e?.message ?? e}`);
  }
}

async function normalizePageDisplay(targetPage = page) {
  if (!targetPage || targetPage.isClosed?.()) return;
  const viewport = activeBrowserFingerprint?.viewport ?? VIEWPORT;
  await withSoftTimeout(targetPage.setViewportSize(viewport), 1_500);
  await applyFingerprintToPage(targetPage).catch(() => {});
  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (session) {
    await withSoftTimeout(session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 }), 1_500);
    await withSoftTimeout(session.detach(), 500);
  }
  // Chrome profile zoom can persist per-origin. Reset the visible tab
  // so the sidecar window doesn't stay accidentally zoomed out.
  await withSoftTimeout(targetPage.keyboard.press(process.platform === "darwin" ? "Meta+0" : "Control+0"), 1_000);
  scheduleSidecarMinimize(targetPage);
}

async function clearContextStorageForFreshRun(label = "fresh browser run") {
  if (!context) return;
  await withSoftTimeout(context.clearCookies?.(), 2_000, null);
  const pages = typeof context.pages === "function" ? context.pages() : [];
  const targetPage = pages.find((p) => p && !p.isClosed?.()) ?? page;
  if (!targetPage || targetPage.isClosed?.()) {
    log(`${label}: cleared cookies; no page available for CDP cache clear`);
    return;
  }
  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (!session) {
    log(`${label}: cleared cookies; CDP cache clear unavailable`);
    return;
  }
  try {
    await withSoftTimeout(session.send("Network.clearBrowserCookies"), 1_500, null);
    await withSoftTimeout(session.send("Network.clearBrowserCache"), 1_500, null);
    await withSoftTimeout(session.send("Storage.clearDataForOrigin", {
      origin: "https://www.vrbo.com",
      storageTypes: "all",
    }), 1_500, null);
    await withSoftTimeout(session.send("Storage.clearDataForOrigin", {
      origin: "https://www.booking.com",
      storageTypes: "all",
    }), 1_500, null);
    await withSoftTimeout(session.send("Storage.clearDataForOrigin", {
      origin: "https://www.airbnb.com",
      storageTypes: "all",
    }), 1_500, null);
    log(`${label}: cleared cookies, cache, and OTA origin storage`);
  } finally {
    await withSoftTimeout(session.detach(), 500, null);
  }
}

async function ensureBrowser() {
  const allocation = await acquireChromeForRequest();
  if (usingHeadlessRuntime()) return ensureHeadlessBrowser();
  if (browser && context && page && !page.isClosed()) return;
  log(`connecting to Chrome via CDP (${allocation.label})…`);
  await verifyActiveChromeHealth("before connect");
  browser = await chromium.connectOverCDP(allocation.cdpUrl);
  context = browser.contexts()[0] ?? (await browser.newContext());
  activeBrowserFingerprint = browserFingerprintForRequest(activeRuntimeRequest);
  await installFingerprintInitScript(context, activeBrowserFingerprint);
  if (activeBrowserFingerprint) {
    log(
      `browser fingerprint ${activeBrowserFingerprint.id}: ${activeBrowserFingerprint.os} ` +
      `${activeBrowserFingerprint.viewport.width}x${activeBrowserFingerprint.viewport.height} ` +
      `tz=${activeBrowserFingerprint.timezone} hc=${activeBrowserFingerprint.hardwareConcurrency} dm=${activeBrowserFingerprint.deviceMemory}`,
    );
  }
  await installContextGuards();
  await clearContextStorageForFreshRun("server Chrome startup");
  await syncRemoteCookies();
  const cookies = loadCookies();
  const seeded = cookies.length ? await addCookiesBestEffort(cookies, "startup cookie seed") : false;
  log(seeded ? `seeded ${cookies.length} cookies into Chrome context` : `using existing Chrome profile/server cookies (${cookies.length} cookies available on disk)`);

  // PR #302 (revised): always create a NEW page rather than reusing
  // pages[0]. The daemon's Chrome accumulates tabs from prior sessions
  // (cookie-extension setup, leftover scans, manual user navigation)
  // and `pages[0]` may not be a tab the daemon owns. Operator
  // screenshot 2026-04-29 showed the visible window stuck on
  // about:blank while the daemon was scraping a hidden tab.
  //
  // PR #307: create the daemon-owned tab FIRST, then close all
  // OTHER tabs in the context. The earlier "close everything then
  // newPage" attempt hung Chrome because closing the last tab quits
  // Chrome on macOS — but if we have ≥2 tabs (our new one + N stale
  // ones), closing the stale set leaves Chrome alive and the daemon
  // tab as the only one. Net result: each daemon start gives us a
  // single fresh tab, no clutter, no stale state, no risk of
  // accidentally scraping a leftover tab.
  page = await Promise.race([
    context.newPage(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("newPage timed out")), 8000)),
  ]);
  await normalizePageDisplay(page);
  const closedCount = await closeExtraTabs("startup tab cleanup", page);
  log(`opened fresh daemon-owned tab; closed ${closedCount} stale tab(s)`);
}

function headlessUserDataDirForWorker() {
  const safeSlot = String(WORKER_SLOT || "1").replace(/[^a-z0-9_-]/gi, "_");
  if (WORKER_ROLE === "server" || activeRequestIsVrbo()) {
    const safeRequestId = String(activeRuntimeRequest?.id || "vrbo")
      .replace(/[^a-z0-9_-]/gi, "_")
      .slice(0, 48);
    const freshAttempt = Math.max(0, Number(activeRuntimeRequest?.vrboFreshAttempt ?? 0));
    const requestAttempt = Math.max(0, Number(activeRuntimeRequest?.requestAttempt ?? 0));
    const safeOpType = String(activeRuntimeRequest?.opType || "request")
      .replace(/[^a-z0-9_-]/gi, "_")
      .slice(0, 32);
    return path.join(HEADLESS_USER_DATA_ROOT, `worker-${safeSlot}-${safeOpType}-${safeRequestId}-try${requestAttempt}-fresh${freshAttempt}`);
  }
  const freshAttempt = Number(activeRuntimeRequest?.vrboFreshAttempt ?? 0);
  if (freshAttempt > 0 && activeRuntimeRequest?.freshSessionReason === "vrbo_hard_block") {
    const safeRequestId = String(activeRuntimeRequest?.id || "vrbo")
      .replace(/[^a-z0-9_-]/gi, "_")
      .slice(0, 48);
    return path.join(HEADLESS_USER_DATA_ROOT, `worker-${safeSlot}-vrbo-fresh-${safeRequestId}-${freshAttempt}`);
  }
  return path.join(HEADLESS_USER_DATA_ROOT, `worker-${safeSlot}`);
}

async function ensureHeadlessBrowser() {
  if (context && page && !page.isClosed()) return;
  const userDataDir = headlessUserDataDirForWorker();
  if (WORKER_ROLE === "server" || activeRequestShouldUseHeadlessProxy() || activeRequestIsVrbo()) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  let proxyConfig = await headlessProxyConfig();
  if (proxyConfig) {
    const probe = await probeHeadlessProxyAuth(proxyConfig);
    if (!probe.ok) {
      const probeStatus = probe.statusLine || `HTTP ${probe.status || "unknown"}`;
      const message =
        `headless proxy auth probe failed (${probeStatus}); ` +
        (HEADLESS_PROXY_DIRECT_FALLBACK
          ? "launching VRBO headless fallback without proxy"
          : "direct fallback disabled");
      log(message);
      await sendHeartbeat(`VRBO proxy unavailable: ${probeStatus}`, true, activeRuntimeRequest?.id).catch(() => {});
      if (!HEADLESS_PROXY_DIRECT_FALLBACK) throw new Error(message);
      proxyConfig = null;
    }
  }
  if (proxyConfig) {
    await closeHeadlessProxyBridge("new headless launch");
    activeHeadlessProxyBridge = await startHeadlessProxyAuthBridge(proxyConfig);
  }
  log(
    `launching ${WORKER_ROLE === "server" ? "Railway" : "local"} headless Chromium ` +
      `(${HEADLESS_CHROMIUM_EXECUTABLE_PATH || HEADLESS_BROWSER_CHANNEL}) with profile ${userDataDir}` +
      (proxyConfig ? ` using ${proxyConfig.provider} proxy ${proxyConfig.host}:${proxyConfig.port} via local auth bridge` : ""),
  );
  const launchOptions = {
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: VIEWPORT,
    locale: process.env.SIDECAR_LOCALE ?? "en-US",
    timezoneId: process.env.SIDECAR_TIMEZONE ?? "America/New_York",
    deviceScaleFactor: 1,
    args: [
      "--disable-notifications",
      "--disable-blink-features=AutomationControlled",
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-dev-shm-usage",
    ],
  };
  activeBrowserFingerprint = browserFingerprintForRequest(activeRuntimeRequest);
  if (activeBrowserFingerprint) {
    launchOptions.viewport = activeBrowserFingerprint.viewport;
    launchOptions.locale = activeBrowserFingerprint.locale;
    launchOptions.timezoneId = activeBrowserFingerprint.timezone;
    launchOptions.deviceScaleFactor = activeBrowserFingerprint.deviceScaleFactor;
    launchOptions.userAgent = activeBrowserFingerprint.userAgent;
    launchOptions.args.push(`--lang=${activeBrowserFingerprint.language}`);
  }
  if (HEADLESS_CHROMIUM_EXECUTABLE_PATH) {
    launchOptions.executablePath = HEADLESS_CHROMIUM_EXECUTABLE_PATH;
  } else {
    launchOptions.channel = HEADLESS_BROWSER_CHANNEL;
  }
  if (proxyConfig) {
    launchOptions.proxy = {
      server: activeHeadlessProxyBridge.serverUrl,
    };
  }
  context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  launchedPersistentContext = true;
  browser = context.browser?.() ?? null;
  await installFingerprintInitScript(context, activeBrowserFingerprint);
  if (activeBrowserFingerprint) {
    log(
      `browser fingerprint ${activeBrowserFingerprint.id}: ${activeBrowserFingerprint.os} ` +
      `${activeBrowserFingerprint.viewport.width}x${activeBrowserFingerprint.viewport.height} ` +
      `tz=${activeBrowserFingerprint.timezone} hc=${activeBrowserFingerprint.hardwareConcurrency} dm=${activeBrowserFingerprint.deviceMemory}`,
    );
  }
  await installContextGuards();
  await clearContextStorageForFreshRun("headless startup");
  await syncRemoteCookies();
  const cookies = loadCookies();
  const shouldSeedCookies = !proxyConfig && !activeRequestIsVrbo();
  const seeded = shouldSeedCookies && cookies.length ? await addCookiesBestEffort(cookies, "headless startup cookie seed") : false;
  log(
    shouldSeedCookies
      ? seeded
        ? `seeded ${cookies.length} cookies into headless context`
        : `using existing headless profile cookies (${cookies.length} cookies available on disk)`
      : "skipped cookie seeding for isolated proxied headless session",
  );

  const existingPages = context.pages().filter((p) => p && !p.isClosed?.());
  page = existingPages[0] ?? await context.newPage();
  await normalizePageDisplay(page);
  const closedCount = await closeExtraTabs("headless startup tab cleanup", page);
  log(`opened local headless daemon tab; closed ${closedCount} stale tab(s)`);
}

// Reset the daemon-owned page to a clean about:blank state. Called
// between ops in the dispatcher so each scrape starts from a known
// blank slate — no leftover modal dialogs, scroll position, JS
// timers, intersection observers, or page-level event listeners
// from the previous op. Cookies persist (context-level), which is
// what we want for VRBO/Booking/Google session continuity.
//
// Cheap (~50ms) and idempotent. If `page` is closed for any reason,
// ensureBrowser() in the next op will recreate it.
async function resetPage() {
  if (!page || page.isClosed?.()) return;
  try {
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 });
    await normalizePageDisplay(page);
  } catch {
    // about:blank should never fail, but if it does the next
    // ensureBrowser/page.goto will recover.
  }
}

async function showCompletePage(opType) {
  if (!page || page.isClosed?.()) return;
  try {
    const now = new Date();
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => {});
    await page.evaluate(
      ({ html, title }) => {
        document.title = title;
        document.open();
        document.write(html);
        document.close();
      },
      {
        title: "Sidecar Search Complete",
        html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Sidecar Search Complete</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #0f172a; }
    main { width: min(520px, calc(100vw - 48px)); border: 1px solid #dbeafe; border-radius: 14px; background: #ffffff; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08); padding: 28px; }
    .mark { width: 38px; height: 38px; border-radius: 999px; display: grid; place-items: center; background: #dcfce7; color: #15803d; font-size: 24px; margin-bottom: 14px; }
    h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.2; }
    p { margin: 0; color: #475569; font-size: 14px; line-height: 1.6; }
    .meta { margin-top: 14px; padding-top: 14px; border-top: 1px solid #e2e8f0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <main>
    <div class="mark">✓</div>
    <h1>Sidecar search complete</h1>
    <p>The local Chrome sidecar finished the latest ${escapeHtml(opType ?? "search")} request. You can return to the Rental Community Tracker tab.</p>
    <div class="meta">${escapeHtml(now.toLocaleString())}</div>
  </main>
</body>
</html>`,
      },
    );
    await normalizePageDisplay(page);
  } catch (e) {
    log(`complete page failed: ${e?.message ?? e}`);
  }
}

async function teardownBrowser(reason) {
  log(`${usingHeadlessRuntime() ? "closing headless browser" : "disconnecting CDP"}: ${reason}`);
  try {
    if (launchedPersistentContext && context) {
      await context.close().catch(() => {});
    } else if (browser) {
      await browser.close().catch(() => {});
    }
  } catch {}
  browser = null;
  context = null;
  page = null;
  contextGuardsInstalled = false;
  launchedPersistentContext = false;
  activeBrowserFingerprint = null;
  await closeHeadlessProxyBridge(reason);
  await releaseChromeForRequest();
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON response: ${text.slice(0, 200)}`); }
}

async function pollNext() {
  const url = new URL(`${SERVER}/api/admin/vrbo-sidecar/next`);
  const runtime = workerRuntimeMetadata();
  url.searchParams.set("slot", runtime.slot);
  url.searchParams.set("workerRole", runtime.workerRole);
  url.searchParams.set("browserMode", runtime.browserMode);
  url.searchParams.set("chromePrimary", runtime.chromePrimary);
  const data = await fetchJson(url.toString(), {
    headers: authHeaders(),
  });
  return data.request ?? null;
}

let lastHeartbeatSentAt = 0;

class SidecarCancelledError extends Error {
  constructor(id) {
    super(`server cancelled request ${id}`);
    this.name = "SidecarCancelledError";
    this.id = id;
  }
}

const cancelledRequestIds = new Set();

function noteRequestCancelled(id) {
  if (id) cancelledRequestIds.add(id);
}

function forgetRequestCancelled(id) {
  if (id) cancelledRequestIds.delete(id);
}

function throwIfRequestCancelled(id) {
  if (id && cancelledRequestIds.has(id)) throw new SidecarCancelledError(id);
}

async function sendHeartbeat(label = "heartbeat", force = false, id = null) {
  const now = Date.now();
  if (!force && now - lastHeartbeatSentAt < 15_000) return false;
  lastHeartbeatSentAt = now;
  try {
    const r = await fetch(`${SERVER}/api/admin/vrbo-sidecar/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        ...(id ? { id, stage: label } : {}),
        workerRuntime: workerRuntimeMetadata(),
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json().catch(() => ({}));
    if (id && data?.cancelled) {
      noteRequestCancelled(id);
      log(`${label}: server cancelled request ${id}; closing active Chrome task`);
      await teardownBrowser(`server cancelled ${id}`);
      throw new SidecarCancelledError(id);
    }
    return true;
  } catch (e) {
    if (e instanceof SidecarCancelledError) throw e;
    if (!/404|fetch failed|AbortError/i.test(e?.message ?? "")) {
      log(`${label} failed: ${e?.message ?? e}`);
    }
    return false;
  }
}

function startBusyHeartbeat(label, id = null) {
  void sendHeartbeat(`start ${label}`, true, id).catch((e) => {
    if (e instanceof SidecarCancelledError) noteRequestCancelled(id);
    else log(`start ${label} heartbeat failed: ${e?.message ?? e}`);
  });
  const interval = setInterval(() => {
    void sendHeartbeat(`busy ${label}`, true, id).catch((e) => {
      if (e instanceof SidecarCancelledError) noteRequestCancelled(id);
      else log(`busy ${label} heartbeat failed: ${e?.message ?? e}`);
    });
  }, Math.min(HEARTBEAT_BUSY_MS, 5_000));
  interval.unref?.();
  return () => clearInterval(interval);
}

// ── Auto-refresh cookies pushed by the Chrome extension ─────────────
// Fingerprint of the cookie set last applied to the Chrome context.
// On each tick, fetch /api/admin/vrbo-sidecar/cookies; if the
// server's fingerprint differs from ours, reseed the context. This is
// the Chrome-extension → daemon handoff for Option C cookie sync.
let lastAppliedCookieFingerprint = null;

async function syncRemoteCookies() {
  try {
    const r = await fetch(`${SERVER}/api/admin/vrbo-sidecar/cookies`, {
      headers: authHeaders(),
    });
    if (!r.ok) return false;
    const data = await r.json();
    const cookies = data?.cookies ?? [];
    const fp = data?.fingerprint ?? null;
    if (!cookies.length) return false;
    if (fp && fp === lastAppliedCookieFingerprint) return false;
    // Avoid claiming a local/server browser while idle just to sync
    // cookies. The next real request will acquire the sidecar and then
    // apply the latest server-pushed cookie set before navigation.
    if (!context) return false;
    const normalised = normaliseCookieRecords(cookies);
    const applied = await addCookiesBestEffort(normalised, "cookie sync");
    if (!applied) {
      if (fp) lastAppliedCookieFingerprint = fp;
      return false;
    }
    lastAppliedCookieFingerprint = fp;
    log(`cookie sync: applied ${normalised.length} cookies from extension (fp=${fp})`);
    return true;
  } catch (e) {
    // Cookie sync failure is non-fatal — the daemon keeps running with
    // whatever cookies it last had (file-seeded or previously
    // extension-pushed).
    if (!/AbortError|fetch failed/i.test(e?.message ?? "")) {
      log(`cookie sync error: ${e?.message ?? e}`);
    }
    return false;
  }
}

async function postResult(id, results, error) {
  const body = error ? { id, error } : { id, results };
  await fetchJson(`${SERVER}/api/admin/vrbo-sidecar/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
}

let lastScreenSnapshotSentAt = 0;

async function postScreenSnapshot(req, targetPage = page, phase = "working", extra = {}) {
  const now = Date.now();
  if (!extra.force && now - lastScreenSnapshotSentAt < SCREENSHOT_MIN_INTERVAL_MS) return false;
  lastScreenSnapshotSentAt = now;
  try {
    const snapshotPage = targetPage && !targetPage.isClosed?.() ? targetPage : page;
    let screenshotDataUrl;
    let url = "";
    let title = "";
    let width = VIEWPORT.width;
    let height = VIEWPORT.height;
    if (snapshotPage && !snapshotPage.isClosed?.()) {
      try { url = snapshotPage.url?.() ?? ""; } catch {}
      title = await snapshotPage.title?.().catch(() => "") ?? "";
      const viewport = snapshotPage.viewportSize?.() ?? null;
      width = viewport?.width ?? width;
      height = viewport?.height ?? height;
      const buffer = await withSoftTimeout(
        snapshotPage.screenshot({ type: "jpeg", quality: 30, fullPage: false, timeout: 2_500 }),
        3_000,
        null,
      );
      if (buffer) screenshotDataUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    }
    await fetch(`${SERVER}/api/admin/vrbo-sidecar/screen`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        slot: WORKER_SLOT,
        requestId: req?.id,
        opType: req?.opType ?? "vrbo_search",
        label: req?.opType ?? "sidecar",
        phase,
        url,
        title,
        liveViewUrl: activeChromeAllocation?.noVncUrl ?? undefined,
        width,
        height,
        screenshotDataUrl,
        captcha: extra.captcha === true,
        error: extra.error,
      }),
    }).catch(() => null);
    return true;
  } catch {
    return false;
  }
}

async function clearScreenSnapshot(req, phase = "Ready for next search") {
  try {
    await fetch(`${SERVER}/api/admin/vrbo-sidecar/screen`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        slot: WORKER_SLOT,
        requestId: req?.id,
        opType: req?.opType ?? "sidecar",
        label: req?.opType ?? "sidecar",
        phase,
        clear: true,
      }),
    }).catch(() => null);
    return true;
  } catch {
    return false;
  }
}

function startScreenHeartbeat(req) {
  void postScreenSnapshot(req, page, `start ${req?.opType ?? "request"}`, { force: true });
  const interval = setInterval(() => {
    void applyScreenControlCommands(req, page, req?.opType ?? "sidecar");
    void postScreenSnapshot(req, page, `working ${req?.opType ?? "request"}`);
  }, SCREENSHOT_HEARTBEAT_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

async function dumpPageState(label, requestForLog) {
  try {
    // Set a wider viewport before screenshot so we capture more of the
    // listing grid (Vrbo's narrow viewport falls back to mobile layout
    // which renders fewer cards). Resize idempotent — Playwright
    // tracks the current size.
    await normalizePageDisplay(page);
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyExcerpt: (document.body?.innerText ?? "").slice(0, 2000),
      bodyHtmlSnippet: (document.body?.innerHTML ?? "").slice(0, 4000),
    }));
    fs.writeFileSync(
      path.join(__dirname, `last-${label}-state.json`),
      JSON.stringify({ ...requestForLog, ...state }, null, 2),
    );
    // Viewport screenshot only. Playwright full-page screenshots scroll
    // the visible Chrome window; on Vrbo that trips the "Ask a question"
    // widget and makes the operator think the worker is clicking around.
    await page.screenshot({ path: path.join(__dirname, `last-${label}.jpg`), type: "jpeg", quality: 70, fullPage: false }).catch(() => {});
    log(`${label} state: url=${state.url.slice(0, 100)} title="${state.title.slice(0, 60)}"`);
    return state;
  } catch {
    return null;
  }
}

const VRBO_HUMAN_CHALLENGE_RE =
  /show us your human side|we can.?t tell if you.?re a human|press and hold|slide (?:the )?(?:lock|slider)|captcha|not a robot|bot or not|verify (?:that )?you(?:'re| are) human|human verification|unusual traffic/i;
const VRBO_HARD_BLOCK_RE =
  /you have been blocked|something about the behaviour of the browser|robot on the same network/i;
const BRIGHTDATA_KYC_BLOCK_RE =
  /residential failed.*bad_endpoint|not available for immediate residential|no kyc access mode|brightdata\.com\/cp\/kyc/i;

function stateLooksLikeBrightDataKycBlock(state) {
  if (!state) return false;
  return BRIGHTDATA_KYC_BLOCK_RE.test(
    `${state.title ?? ""}\n${state.bodyExcerpt ?? ""}\n${state.bodyHtmlSnippet ?? ""}\n${state.url ?? ""}`,
  );
}

function providerHostFromUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).hostname.replace(/^www\./, "") || "provider";
  } catch {
    return "provider";
  }
}

function throwIfBrightDataKycBlock(state, label, id) {
  if (!stateLooksLikeBrightDataKycBlock(state)) return;
  const host = providerHostFromUrl(state?.url);
  throw new ProviderBrowserUnavailableError(
    `Bright Data residential proxy blocked ${host}: KYC is required for this target site. ` +
      "Complete Bright Data KYC for the active residential zone or switch this worker to a proxy zone that is approved for the target.",
    {
      label,
      id,
      provider: host,
      url: state?.url,
      title: state?.title,
      excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    },
  );
}

function stateLooksLikeBlankSearchPage(state, providerHost) {
  if (!state) return false;
  const body = String(state.bodyExcerpt ?? "").replace(/\s+/g, " ").trim();
  const title = String(state.title ?? "").trim();
  const url = String(state.url ?? "");
  return url.includes(providerHost) && title.length === 0 && body.length < 40;
}

function throwIfBlankSearchPage(state, providerHost, label, id) {
  if (!stateLooksLikeBlankSearchPage(state, providerHost)) return;
  throw new ProviderBrowserUnavailableError(
    `${providerHost} returned a blank search page for the requested dates/bedrooms; treating this as a provider/browser failure instead of a valid zero-result search.`,
    {
      label,
      id,
      provider: providerHost,
      url: state?.url,
      title: state?.title,
      excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    },
  );
}

function stateLooksLikeVrboHumanChallenge(state) {
  if (!state) return false;
  return VRBO_HUMAN_CHALLENGE_RE.test(
    `${state.title ?? ""}\n${state.bodyExcerpt ?? ""}\n${state.bodyHtmlSnippet ?? ""}\n${state.url ?? ""}`,
  );
}

function stateLooksLikeVrboHardBlock(state) {
  if (!state) return false;
  return VRBO_HARD_BLOCK_RE.test(
    `${state.title ?? ""}\n${state.bodyExcerpt ?? ""}\n${state.bodyHtmlSnippet ?? ""}\n${state.url ?? ""}`,
  );
}

async function captureVrboChallengeState(targetPage = page) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  return targetPage
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyExcerpt: (document.body?.innerText ?? "").slice(0, 3000),
      bodyHtmlSnippet: (document.body?.innerHTML ?? "").slice(0, 5000),
    }))
    .catch(() => null);
}

function throwIfVrboHardBlock(state, label, id) {
  if (!stateLooksLikeVrboHardBlock(state)) return;
  throw new VrboHardBlockError(
    "VRBO hard-blocked this browser/IP session; provider run stopped and retry is rate-limited until later",
    {
      label,
      id,
      url: state?.url,
      title: state?.title,
      excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    },
  );
}

async function pageLooksLikeVrboHumanChallenge(targetPage = page) {
  if (!targetPage || targetPage.isClosed?.()) return false;
  const state = await captureVrboChallengeState(targetPage);
  return stateLooksLikeVrboHumanChallenge(state);
}

async function stopVrboProviderIfBlocked(targetPage, label, id, initialState = null) {
  const state = initialState ?? await captureVrboChallengeState(targetPage);
  throwIfVrboHardBlock(state, label, id);
  const hasChallenge = stateLooksLikeVrboHumanChallenge(state);
  if (!hasChallenge) return false;

  await normalizePageDisplay(targetPage).catch(() => {});
  const stopMessage =
    "VRBO CAPTCHA/human-verification page detected. The compliant provider runner stops this VRBO search cleanly, records provider cooldown/health, preserves the original source URL for manual verification, and lets other providers continue without attempting to bypass the challenge.";
  log(`${label} ${id}: ${stopMessage}`);
  await postScreenSnapshot(
    { id, opType: label },
    targetPage,
    "VRBO blocked - provider stopped",
    { captcha: true, error: stopMessage, force: true },
  );
  await setCaptchaWindowVisibility(targetPage, false, label, id).catch(() => {});
  throw new VrboHardBlockError(
    stopMessage,
    {
      label,
      id,
      url: state?.url,
      title: state?.title,
      excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      retryLater: true,
    },
  );
}

async function applyScreenControlCommands(req, targetPage = page, label = "sidecar") {
  if (!targetPage || targetPage.isClosed?.()) return 0;
  try {
    const url = new URL(`${SERVER}/api/admin/vrbo-sidecar/screen-control`);
    url.searchParams.set("slot", WORKER_SLOT);
    if (req?.id) url.searchParams.set("requestId", String(req.id));
    const r = await fetch(url, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(2_500),
    });
    if (!r.ok) return 0;
    const data = await r.json();
    const commands = Array.isArray(data?.commands) ? data.commands : [];
    for (const command of commands) {
      const x = Number(command?.x);
      const y = Number(command?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const action = String(command?.action ?? "");
      if (action === "move") {
        await targetPage.mouse.move(x, y).catch(() => {});
      } else if (action === "down") {
        await targetPage.mouse.move(x, y).catch(() => {});
        await targetPage.mouse.down().catch(() => {});
      } else if (action === "up") {
        await targetPage.mouse.move(x, y).catch(() => {});
        await targetPage.mouse.up().catch(() => {});
      } else if (action === "click") {
        await targetPage.mouse.click(x, y, { delay: 60 }).catch(() => {});
      } else if (action === "surface") {
        const surfaced = await setCaptchaWindowVisibility(targetPage, true, label, req?.id ?? "").catch(() => false);
        if (!surfaced) await targetPage.bringToFront().catch(() => {});
      }
    }
    if (commands.length) {
      log(`${label} ${req?.id ?? ""}: applied ${commands.length} dashboard pointer command(s)`);
      await postScreenSnapshot(req, targetPage, "manual CAPTCHA control", { captcha: true, force: true });
    }
    return commands.length;
  } catch (e) {
    if (!/AbortError|fetch failed/i.test(e?.message ?? "")) {
      log(`${label} ${req?.id ?? ""}: screen control poll failed: ${e?.message ?? e}`);
    }
    return 0;
  }
}

// ─────────────────────── Airbnb search ──────────────────────────────
async function primeOtaHomepageSearch(homeUrl, searchTerm, label, requestId = "homepage") {
  if (!searchTerm) return false;
  const isVrbo = /vrbo/i.test(label) || /vrbo\.com/i.test(homeUrl);
  const maybeClearVrboChallenge = async (stage) => {
    if (!isVrbo) return false;
    const state = await withSoftTimeout(captureVrboChallengeState(page), 2_000, null);
    throwIfBrightDataKycBlock(state, label, requestId);
    throwIfVrboHardBlock(state, label, requestId);
    if (stateLooksLikeVrboHumanChallenge(state) || (await pageLooksLikeVrboHumanChallenge(page))) {
      log(`${label} ${requestId}: VRBO challenge detected during homepage prime (${stage})`);
      return stopVrboProviderIfBlocked(page, label, requestId, state);
    }
    return false;
  };
  try {
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await boundedPageDelay(page, 1_200);
    await maybeClearVrboChallenge("after-homepage-load");
    await dismissObstructions(page, `${label}_home`);
    const filled = await fillVisibleSearchField(page, searchTerm, `${label}_home`).catch(() => null);
    if (filled) {
      await withSoftTimeout(clickVisibleSearchSubmit(page, `${label}_home`), PAGE_SETTLE_MS + 2_000, null);
      await boundedPageDelay(page, 1_200);
      await maybeClearVrboChallenge("after-homepage-submit");
      log(`${label}: primed public homepage search with "${searchTerm}"`);
      return true;
    }
  } catch (e) {
    if (e instanceof SidecarCancelledError || e instanceof VrboHardBlockError || e instanceof ProviderBrowserUnavailableError) throw e;
    log(`${label}: homepage search prime skipped: ${e?.message ?? e}`);
  }
  return false;
}

async function processAirbnbSearch(id, params) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(searchTerm || destination || "").trim();
  log(
    `airbnb_search ${id}: searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR`,
  );
  await ensureBrowser();
  await primeOtaHomepageSearch("https://www.airbnb.com/", effectiveSearchTerm, "airbnb_search");
  const url =
    `https://www.airbnb.com/s/${encodeURIComponent(effectiveSearchTerm)}/homes` +
    `?query=${encodeURIComponent(effectiveSearchTerm)}` +
    `&checkin=${checkIn}&checkout=${checkOut}` +
    `&adults=2&min_bedrooms=${encodeURIComponent(String(bedrooms))}` +
    `&room_types%5B%5D=Entire%20home%2Fapt&currency=USD&search_type=filter_change`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await dismissObstructions(page, "airbnb_search");
  await fillVisibleSearchField(page, effectiveSearchTerm, "airbnb_search").catch(() => null);
  await clickVisibleSearchSubmit(page, "airbnb_search").catch(() => null);
  const bedroomFiltered = await fillBedroomFilter(page, bedrooms, "airbnb_search").catch(() => null);
  if (!bedroomFiltered) {
    try {
      const current = new URL(page.url());
      current.searchParams.set("min_bedrooms", String(bedrooms));
      current.searchParams.set("room_types[]", "Entire home/apt");
      current.searchParams.set("search_type", "filter_change");
      await page.goto(current.toString(), { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
      await page.waitForTimeout(PAGE_SETTLE_MS);
      log(`airbnb_search: applied URL bedroom filter (min_bedrooms=${bedrooms})`);
    } catch (e) {
      log(`airbnb_search: URL bedroom fallback failed: ${e?.message ?? e}`);
    }
  }
  await page.waitForTimeout(PAGE_SETTLE_MS);
  const state = await dumpPageState("airbnb", { id, ...params });
  if (state && /captcha|access denied|not a robot|robot|unusual traffic/i.test(state.bodyExcerpt)) {
    throw new Error("Airbnb bot wall — refresh cookies.json (airbnb.com) and kickstart");
  }

  const expectedNights = nightsBetween(checkIn, checkOut);
  const cards = await page.evaluate(({ expectedNights, targetBedrooms, checkIn, checkOut }) => {
    function clean(raw) {
      return String(raw || "").replace(/\s+/g, " ").trim();
    }
    function extractBedrooms(raw) {
      const text = clean(raw).toLowerCase();
      const direct = text.match(/\b([1-9])\s*(?:br|bd|bdr|bedrooms?|bed\s*rooms?)\b/);
      if (direct) return parseInt(direct[1], 10);
      const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
      for (const [word, count] of Object.entries(words)) {
        if (new RegExp(`\\b${word}[\\s-]*(?:bedroom|bedrooms|bed\\s*rooms?)\\b`).test(text)) return count;
      }
      return null;
    }
    function parseAmount(raw) {
      const n = parseFloat(String(raw || "").replace(/,/g, "").replace(/[^\d.]/g, ""));
      return Number.isFinite(n) ? n : 0;
    }
    function parsePrice(fullText) {
      const text = clean(fullText);
      const lower = text.toLowerCase();
      const totalMatch =
        text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:total|for\s+\d+\s+nights?)/i) ||
        text.match(/total(?:\s+before\s+taxes)?\s*\$\s*([\d,]+(?:\.\d+)?)/i);
      if (totalMatch) {
        const total = parseAmount(totalMatch[1]);
        if (total > 0) {
          const includesTaxes = /\bincludes?\s+tax(?:es)?\b|\btaxes?\s*(?:and|&)\s*fees?\s*included\b/.test(lower);
          const beforeTaxes = /\bbefore\s+tax(?:es)?\b/.test(lower);
          return {
            totalPrice: Math.round(total),
            nightlyPrice: Math.round(total / expectedNights),
            priceIncludesTaxes: includesTaxes && !beforeTaxes,
            priceIncludesFees: true,
            priceBasis: includesTaxes && !beforeTaxes ? "all_in" : "pre_tax_total",
          };
        }
      }
      const nightlyMatch =
        text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:night|\/night|per night)/i) ||
        text.match(/(?:night|\/night|per night)\s*\$\s*([\d,]+(?:\.\d+)?)/i);
      if (nightlyMatch) {
        const nightly = parseAmount(nightlyMatch[1]);
        if (nightly > 0) {
          return {
            nightlyPrice: Math.round(nightly),
            totalPrice: Math.round(nightly * expectedNights),
            priceIncludesTaxes: false,
            priceIncludesFees: false,
            priceBasis: "nightly_base",
          };
        }
      }
      const amounts = Array.from(text.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g))
        .map((m) => parseAmount(m[1]))
        .filter((n) => n > 0);
      const plausibleTotal = amounts.filter((n) => n >= Math.max(250, expectedNights * 80)).sort((a, b) => a - b)[0];
      if (plausibleTotal) {
        return {
          totalPrice: Math.round(plausibleTotal),
          nightlyPrice: Math.round(plausibleTotal / expectedNights),
          priceIncludesTaxes: false,
          priceIncludesFees: true,
          priceBasis: "stay_total",
        };
      }
      const plausibleNightly = amounts.filter((n) => n >= 50 && n <= 5000).sort((a, b) => a - b)[0];
      if (plausibleNightly) {
        return {
          nightlyPrice: Math.round(plausibleNightly),
          totalPrice: Math.round(plausibleNightly * expectedNights),
          priceIncludesTaxes: false,
          priceIncludesFees: false,
          priceBasis: "nightly_base",
        };
      }
      return null;
    }
    function extractedStayNights(fullText) {
      const text = clean(fullText);
      return Array.from(text.matchAll(/\bfor\s+(\d+)\s+nights?/gi))
        .map((m) => parseInt(m[1], 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    function cardForAnchor(anchor) {
      let el = anchor;
      let best = anchor;
      for (let depth = 0; depth < 9 && el && el.parentElement; depth++) {
        el = el.parentElement;
        const txt = clean(el.textContent);
        if (txt.includes("$") && txt.length > 50 && txt.length < 5000) {
          best = el;
          if (el.querySelector("img")) break;
        }
      }
      return best;
    }
    function imageFrom(card) {
      const img = card.querySelector("img");
      return img?.currentSrc || img?.src || img?.getAttribute("data-src") || undefined;
    }
    const out = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href*="/rooms/"]'));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/\/rooms\/(?:plus\/)?(\d+)/);
      if (!match) continue;
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const card = cardForAnchor(a);
      const fullText = clean(card.textContent || a.textContent || "");
      const stayNights = extractedStayNights(fullText);
      if (stayNights.some((n) => n !== expectedNights)) continue;
      const price = parsePrice(fullText);
      if (!price) continue;
      const bedrooms = extractBedrooms(fullText);
      if (bedrooms !== null && bedrooms < targetBedrooms) continue;
      const title =
        clean(a.getAttribute("aria-label")) ||
        clean(card.querySelector("[data-testid*='listing-card-title' i], [id*='title' i], h3, h2")?.textContent) ||
        clean(a.textContent) ||
        `Airbnb room ${id}`;
      const url = new URL(`/rooms/${id}`, "https://www.airbnb.com");
      url.searchParams.set("check_in", checkIn);
      url.searchParams.set("check_out", checkOut);
      url.searchParams.set("adults", "2");
      out.push({
        url: url.toString(),
        title: title.slice(0, 100),
        totalPrice: price.totalPrice,
        nightlyPrice: price.nightlyPrice,
        priceIncludesTaxes: price.priceIncludesTaxes,
        priceIncludesFees: price.priceIncludesFees,
        priceBasis: price.priceBasis,
        bedrooms: bedrooms ?? targetBedrooms,
        image: imageFrom(card),
        snippet: fullText.slice(0, 220),
      });
    }
    return out;
  }, { expectedNights, targetBedrooms: Number.parseInt(String(bedrooms ?? ""), 10), checkIn, checkOut });

  log(`airbnb_search ${id}: ${cards.length} priced room cards`);
  await postResult(id, dedupeCandidatesByUrl(cards));
}

// ───────────────────────── VRBO search ──────────────────────────────
function bookingUrlMissingExpectedSearch(current, expected) {
  if (!expected) return false;
  const currentSearch = normalizeBookingSearchText(current.searchParams.get("ss") || current.searchParams.get("ssne") || "");
  const expectedSearch = normalizeBookingSearchText(expected.searchParams.get("ss") || expected.searchParams.get("ssne") || "");
  return Boolean(
    (expectedSearch && currentSearch !== expectedSearch) ||
      current.searchParams.get("checkin") !== expected.searchParams.get("checkin") ||
      current.searchParams.get("checkout") !== expected.searchParams.get("checkout"),
  );
}

async function applyBookingBedroomFilter(bedrooms, expectedUrl = null) {
  const targetBedrooms = Number.parseInt(String(bedrooms ?? ""), 10);
  if (!Number.isFinite(targetBedrooms) || targetBedrooms <= 0) return false;
  try {
    const expected = expectedUrl ? new URL(expectedUrl) : null;
    let current = new URL(page.url());
    if (bookingUrlMissingExpectedSearch(current, expected)) {
      current = expected;
      log(`booking_search: bedroom filter restored intended search URL before applying ${targetBedrooms}BR filter`);
    }
    const filters = current.searchParams
      .getAll("nflt")
      .join(";")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/^entire_place_bedroom_count=/i.test(part));
    filters.push(`entire_place_bedroom_count=${targetBedrooms}`);
    current.searchParams.delete("nflt");
    current.searchParams.set("nflt", filters.join(";"));
    await page.goto(current.toString(), { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await page.waitForTimeout(PAGE_SETTLE_MS);
    await dismissObstructions(page, "booking_search_after_bedroom_filter");
    log(`booking_search: applied bedroom filter (${targetBedrooms}BR) with intended dates/search preserved`);
    return true;
  } catch (e) {
    log(`booking bedroom filter failed: ${e.message ?? e}`);
    return false;
  }
}

async function clickVisibleSearchSubmit(targetPage = page, label = "search") {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const clicked = await withSoftTimeout(
    targetPage.evaluate(() => {
      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 &&
          rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05;
      }
      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }
      const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button']"))
        .filter((el) => isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
      const target = candidates.find((el) => {
        const label = textOf(el);
        return /^(search|find|submit)$/i.test(label) ||
          /\b(search|find stays|show stays|show properties)\b/i.test(label);
      });
      if (!target) return null;
      const clickedLabel = textOf(target).slice(0, 80) || target.tagName.toLowerCase();
      target.scrollIntoView?.({ block: "center", inline: "center" });
      target.click?.();
      return clickedLabel;
    }),
    2_000,
    null,
  );
  if (clicked) {
    log(`${label}: clicked visible search submit "${clicked}"`);
    await targetPage.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
  }
  return clicked;
}

function nightsBetween(checkIn, checkOut) {
  return Math.max(
    1,
    Math.round((Date.parse(`${checkOut}T12:00:00Z`) - Date.parse(`${checkIn}T12:00:00Z`)) / 86400000),
  );
}

function normalizeAbsoluteUrl(rawUrl, baseUrl) {
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return "";
  }
}

function dedupeCandidatesByUrl(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = String(candidate?.url || "").replace(/[?#].*$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

async function fillVisibleSearchField(targetPage, searchTerm, label = "site_search") {
  if (!targetPage || targetPage.isClosed?.() || !searchTerm) return null;
  const filled = await withSoftTimeout(
    targetPage.evaluate(({ searchTerm }) => {
      const fieldRe = /\b(?:where|destination|location|search|keyword|property|resort|community|area|city)\b/i;
      const badRe = /\b(?:email|phone|password|promo|coupon|newsletter|first name|last name|name on card)\b/i;

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 6 && rect.height > 6 &&
          rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05;
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function setValue(el) {
        try { el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
        try { el.focus?.(); } catch {}
        const tag = el.tagName.toLowerCase();
        if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
          el.textContent = searchTerm;
        } else if (tag === "input" || tag === "textarea") {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
          if (setter) setter.call(el, searchTerm);
          else el.value = searchTerm;
        } else {
          return false;
        }
        for (const name of ["input", "change", "blur"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return true;
      }

      const controls = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, [contenteditable='true'], [role='textbox']"))
        .filter((el) => el instanceof HTMLElement && isVisible(el))
        .map((el) => {
          const ctx = contextOf(el);
          let score = 0;
          if (fieldRe.test(ctx)) score += 80;
          if (/search|where|destination|location/i.test(ctx)) score += 20;
          if (badRe.test(ctx)) score -= 100;
          const type = (el.getAttribute?.("type") || "").toLowerCase();
          if (["date", "number", "email", "tel", "password"].includes(type)) score -= 80;
          return { el, score, ctx };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      const target = controls[0]?.el ?? null;
      if (!target) return null;
      return setValue(target) ? contextOf(target).slice(0, 100) : null;
    }, { searchTerm }),
    3_000,
    null,
  );
  if (filled) {
    log(`${label}: entered search term in "${filled}"`);
    await chooseVisibleDestinationSuggestion(targetPage, searchTerm, label).catch(() => null);
  }
  return filled;
}

async function chooseVisibleDestinationSuggestion(targetPage, searchTerm, label = "site_search") {
  if (!targetPage || targetPage.isClosed?.() || !searchTerm) return null;
  await targetPage.waitForTimeout(900).catch(() => null);
  const clicked = await withSoftTimeout(
    targetPage.evaluate(({ searchTerm }) => {
      const clean = (raw) => String(raw || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const wanted = clean(searchTerm).split(" ").filter((token) => token.length >= 3);
      if (wanted.length === 0) return null;
      const searchNorm = clean(searchTerm);
      const requirePoipuKai = /\bpoipu\s+kai\b/.test(searchNorm);

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 &&
          rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05;
      }

      const candidates = Array.from(document.querySelectorAll([
        "[role='option']",
        "[role='listbox'] *",
        "[aria-selected]",
        "[data-testid*='option' i]",
        "[data-testid*='suggest' i]",
        "li",
        "button",
        "a",
      ].join(",")))
        .filter((el) => el instanceof HTMLElement && isVisible(el))
        .map((el) => {
          const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
          const norm = clean(text);
          if (!norm || text.length > 220) return null;
          const matched = wanted.filter((token) => norm.includes(token)).length;
          const hasPoipuKai = /\bpoipu\b/.test(norm) && /\bkai\b/.test(norm);
          if (requirePoipuKai && !hasPoipuKai) return null;
          if (!requirePoipuKai && matched === 0) return null;
          let score = matched * 20;
          if (hasPoipuKai) score += 80;
          if (norm.includes(searchNorm)) score += 40;
          if (/\b(resort|koloa|hi|hawaii|kauai)\b/.test(norm)) score += 10;
          return { el, text, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (!best || best.score < 40) return null;
      try { best.el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
      best.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      best.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      best.el.click();
      return best.text.slice(0, 120);
    }, { searchTerm }),
    3_000,
    null,
  );
  if (clicked) log(`${label}: selected destination suggestion "${clicked}"`);
  return clicked;
}

async function fillPmRentalLocationField(targetPage, searchTerm, label = "pm_rental_location") {
  if (!targetPage || targetPage.isClosed?.() || !searchTerm) return null;
  const filled = await withSoftTimeout(
    targetPage.evaluate(({ searchTerm }) => {
      const locationRe = /\b(?:where|destination|location|resort|community|area|city|neighbou?rhood|complex)\b/i;
      const rentalFormRe = /\b(?:arrival|departure|check[\s_-]*in|check[\s_-]*out|dates?|availability|booking|reservation|guest|bed(?:room)?s?|rentals?|properties|lodging|stays?)\b/i;
      const badRe = /\b(?:search_block_form|site\s*search|global\s*search|header\s*search|nav\s*search|wp-block-search|enter\s+the\s+terms|keyword|blog|article|faq|email|phone|password|promo|coupon|newsletter|first name|last name|name on card)\b/i;

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 6 && rect.height > 6 &&
          rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05;
      }

      function clean(raw) {
        return String(raw || "").replace(/\s+/g, " ").trim();
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
          el.getAttribute?.("class"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        const form = el.closest?.("form");
        if (form) {
          parts.push(form.getAttribute?.("id"));
          parts.push(form.getAttribute?.("class"));
          const formText = clean(form.textContent);
          if (formText.length <= 500) parts.push(formText);
        }
        let cur = el.parentElement;
        for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
          parts.push(cur.getAttribute?.("id"));
          parts.push(cur.getAttribute?.("class"));
          const txt = clean(cur.textContent);
          if (txt.length <= 260) parts.push(txt);
        }
        return clean(parts.filter(Boolean).join(" "));
      }

      function inBadChrome(el) {
        return Boolean(el.closest?.("header, nav, footer, [class*='header' i], [class*='nav' i], [class*='footer' i], [class*='menu' i], [class*='blog' i], [class*='newsletter' i]"));
      }

      function setValue(el) {
        try { el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
        try { el.focus?.(); } catch {}
        const tag = el.tagName.toLowerCase();
        if (tag === "select") {
          const wanted = clean(searchTerm).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
          const option = Array.from(el.options || []).find((o) => {
            const hay = clean(`${o.value} ${o.textContent}`).toLowerCase();
            return wanted.length > 0 && wanted.some((t) => hay.includes(t));
          });
          if (!option) return false;
          el.value = option.value;
        } else if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
          el.textContent = searchTerm;
        } else if (tag === "input" || tag === "textarea") {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
          if (setter) setter.call(el, searchTerm);
          else el.value = searchTerm;
        } else {
          return false;
        }
        for (const name of ["input", "change", "blur"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return true;
      }

      const controls = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, select, [contenteditable='true'], [role='textbox']"))
        .filter((el) => el instanceof HTMLElement && isVisible(el) && !inBadChrome(el))
        .map((el) => {
          const ctx = contextOf(el);
          let score = 0;
          const type = (el.getAttribute?.("type") || "").toLowerCase();
          const hasLocationSignal = locationRe.test(ctx);
          const hasRentalContext = rentalFormRe.test(ctx);
          if (hasLocationSignal) score += 90;
          if (hasRentalContext) score += 35;
          if (/\b(?:search|keyword|terms?)\b/i.test(ctx) && !hasLocationSignal) score -= 90;
          if (badRe.test(ctx)) score -= 140;
          if (["date", "number", "email", "tel", "password"].includes(type)) score -= 80;
          return { el, score, ctx, hasLocationSignal, hasRentalContext };
        })
        .filter((x) => x.score >= 90 && x.hasLocationSignal && x.hasRentalContext)
        .sort((a, b) => b.score - a.score);
      const target = controls[0]?.el ?? null;
      if (!target) return null;
      return setValue(target) ? contextOf(target).slice(0, 100) : null;
    }, { searchTerm }),
    3_000,
    null,
  );
  if (filled) log(`${label}: entered rental location in "${filled}"`);
  return filled;
}

async function clickPmRentalSearchSubmit(targetPage, label = "pm_rental_search") {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const clicked = await withSoftTimeout(
    targetPage.evaluate(() => {
      const goodLabelRe = /\b(?:search availability|check availability|check rates|view rates|show rates|find rentals?|search rentals?|view rentals?|show rentals?|find properties|show properties|update results|apply filters?|apply|book now|reserve)\b/i;
      const genericSearchRe = /^(?:search|find|submit)$/i;
      const rentalContextRe = /\b(?:arrival|departure|check[\s_-]*in|check[\s_-]*out|dates?|availability|booking|reservation|guest|bed(?:room)?s?|rentals?|properties|lodging|stays?|destination|location|resort|community|area)\b/i;
      const badRe = /\b(?:search_block_form|site\s*search|global\s*search|header\s*search|nav\s*search|wp-block-search|enter\s+the\s+terms|keyword|blog|article|faq|newsletter|subscribe|contact|request\s+info|ask\s+a\s+question|question|message|favorite|share|facebook|instagram|owner|management)\b/i;

      function clean(raw) {
        return String(raw || "").replace(/\s+/g, " ").trim();
      }

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 &&
          rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return clean([
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" "));
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("id"),
          el.getAttribute?.("class"),
          el.getAttribute?.("name"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
        ];
        const form = el.closest?.("form");
        if (form) {
          parts.push(form.getAttribute?.("id"));
          parts.push(form.getAttribute?.("class"));
          const formText = clean(form.textContent);
          if (formText.length <= 700) parts.push(formText);
        }
        let cur = el.parentElement;
        for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
          parts.push(cur.getAttribute?.("id"));
          parts.push(cur.getAttribute?.("class"));
          const txt = clean(cur.textContent);
          if (txt.length <= 300) parts.push(txt);
        }
        return clean(parts.filter(Boolean).join(" "));
      }

      function inBadChrome(el) {
        return Boolean(el.closest?.("header, nav, footer, [class*='header' i], [class*='nav' i], [class*='footer' i], [class*='menu' i], [class*='blog' i], [class*='newsletter' i], [class*='contact' i], [class*='social' i]"));
      }

      const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], a, [role='button']"))
        .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true" && !inBadChrome(el))
        .map((el) => {
          const label = textOf(el);
          const ctx = contextOf(el);
          if (badRe.test(label) || badRe.test(ctx)) return null;
          const specific = goodLabelRe.test(label);
          const generic = genericSearchRe.test(label);
          const contextual = rentalContextRe.test(ctx);
          if (!specific && !(generic && contextual)) return null;
          let score = 0;
          if (specific) score += 90;
          if (generic && contextual) score += 45;
          if (contextual) score += 35;
          if (/^(?:search availability|check availability|find rentals?|search rentals?|view rentals?)$/i.test(label)) score += 25;
          if (/^(?:search|find)$/i.test(label)) score -= 10;
          return { el, score, label };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      const target = candidates[0]?.el ?? null;
      if (!target) return null;
      const clickedLabel = candidates[0].label.slice(0, 80) || target.tagName.toLowerCase();
      target.scrollIntoView?.({ block: "center", inline: "center" });
      target.click?.();
      return clickedLabel;
    }),
    2_000,
    null,
  );
  if (clicked) {
    log(`${label}: clicked PM rental-search submit "${clicked}"`);
    await targetPage.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
  }
  return clicked;
}

async function fillBedroomFilter(targetPage, bedrooms, label = "bedroom_filter") {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const targetBedrooms = Number.parseInt(String(bedrooms ?? ""), 10);
  if (!Number.isFinite(targetBedrooms) || targetBedrooms <= 0) return null;
  const filled = await withSoftTimeout(
    targetPage.evaluate(({ targetBedrooms }) => {
      const bedroomRe = /\b(?:bedroom|bedrooms|beds|br|bd)\b/i;
      const badRe = /\b(?:bath|baths|bathrooms?|guest|guests|adult|adults|child|children|kids|pet|pets|price|email|phone|tel)\b/i;

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 &&
          rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        let cur = el.parentElement;
        for (let i = 0; cur && i < 3; i++, cur = cur.parentElement) {
          const txt = (cur.textContent || "").replace(/\s+/g, " ").trim();
          if (txt.length <= 180) parts.push(txt);
        }
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function setValue(el) {
        try { el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
        try { el.focus?.(); } catch {}
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
        if (setter) setter.call(el, String(targetBedrooms));
        else el.value = String(targetBedrooms);
        for (const name of ["input", "change", "blur"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return true;
      }

      const fields = Array.from(document.querySelectorAll("input:not([type='hidden']), select, [role='spinbutton']"))
        .filter((el) => el instanceof HTMLElement && isVisible(el))
        .map((el) => {
          const ctx = contextOf(el);
          let score = 0;
          if (bedroomRe.test(ctx)) score += 80;
          if (badRe.test(ctx)) score -= 120;
          return { el, score, ctx };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (fields[0]) {
        setValue(fields[0].el);
        return `field:${fields[0].ctx.slice(0, 80)}`;
      }

      const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"))
        .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
      const openFilter = buttons.find((el) => /\b(filter|rooms|beds?)\b/i.test(textOf(el)) && bedroomRe.test(contextOf(el)) && !badRe.test(`${textOf(el)} ${contextOf(el)}`))
        ?? buttons.find((el) => /\b(filter|rooms|guests)\b/i.test(textOf(el)));
      if (openFilter) openFilter.click();
      const plus = buttons.find((el) => {
        const hay = `${textOf(el)} ${contextOf(el)}`;
        return bedroomRe.test(hay) && !badRe.test(hay) && /\b(?:increase|add|plus|\+)\b/i.test(hay);
      });
      if (plus) {
        for (let i = 0; i < targetBedrooms; i++) plus.click();
        return `button:${textOf(plus).slice(0, 80)}`;
      }
      return null;
    }, { targetBedrooms }),
    4_000,
    null,
  );
  if (filled) {
    log(`${label}: applied ${targetBedrooms} bedroom filter via ${filled}`);
    await targetPage.waitForTimeout(800).catch(() => {});
  }
  return filled;
}

function normalizeBookingSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function restoreBookingSearchUrlIfRewritten(expectedUrl, expectedSearchTerm, expectedCheckIn = null, expectedCheckOut = null) {
  try {
    const current = new URL(page.url());
    const actualSearchTerm = current.searchParams.get("ss") || current.searchParams.get("ssne") || "";
    const expected = normalizeBookingSearchText(expectedSearchTerm);
    const actual = normalizeBookingSearchText(actualSearchTerm);
    const searchMismatch = expected && actual !== expected;
    const checkInMismatch = expectedCheckIn && current.searchParams.get("checkin") !== expectedCheckIn;
    const checkOutMismatch = expectedCheckOut && current.searchParams.get("checkout") !== expectedCheckOut;
    if (searchMismatch || checkInMismatch || checkOutMismatch) {
      const reasons = [
        searchMismatch ? `search="${actualSearchTerm.slice(0, 90) || "missing"}"` : "",
        checkInMismatch ? `checkin="${current.searchParams.get("checkin") || "missing"}"` : "",
        checkOutMismatch ? `checkout="${current.searchParams.get("checkout") || "missing"}"` : "",
      ].filter(Boolean).join(", ");
      log(`booking_search: restored intended URL after Booking rewrote ${reasons}`);
      await page.goto(expectedUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
      await page.waitForTimeout(PAGE_SETTLE_MS);
      await dismissObstructions(page, "booking_search_after_query_restore");
      return true;
    }
  } catch (e) {
    log(`booking search-term restore skipped: ${e?.message ?? e}`);
  }
  return false;
}

async function enforceBookingSearchUrl(expectedUrl, expectedSearchTerm, expectedCheckIn, expectedCheckOut, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const restored = await restoreBookingSearchUrlIfRewritten(expectedUrl, expectedSearchTerm, expectedCheckIn, expectedCheckOut);
    const current = new URL(page.url());
    const expected = new URL(expectedUrl);
    if (!bookingUrlMissingExpectedSearch(current, expected)) return true;
    log(
      `booking_search: ${label} still missing intended dates/search after ${restored ? "restore" : "check"} ` +
      `${attempt}/3 (url=${current.toString().slice(0, 180)})`,
    );
    await page.goto(expectedUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await page.waitForTimeout(PAGE_SETTLE_MS);
    await dismissObstructions(page, `booking_search_${label}_${attempt}`).catch(() => null);
  }
  const finalUrl = page.url();
  const finalState = await dumpPageState("booking-invalid-dates", {
    expectedUrl,
    expectedSearchTerm,
    expectedCheckIn,
    expectedCheckOut,
    finalUrl,
  }).catch(() => null);
  const excerpt = finalState?.bodyExcerpt ? ` Body starts: ${finalState.bodyExcerpt.slice(0, 180)}` : "";
  throw new Error(
    `Booking.com rewrote the search away from ${expectedCheckIn}→${expectedCheckOut}; refusing to use default-date results. ` +
    `Final URL: ${finalUrl.slice(0, 220)}.${excerpt}`,
  );
}

async function processVrboSearch(id, params) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(searchTerm || destination || "").trim();
  log(
    `vrbo_search ${id}: searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR`,
  );
  await ensureBrowser();
  await primeOtaHomepageSearch("https://www.vrbo.com/", effectiveSearchTerm, "vrbo_search", id);
  // PR #301: drop minBedrooms URL filter — Vrbo's server-side filter
  // is unreliable (returns 5 properties for a regionId+minBedrooms=3
  // search where only 0 are actually 3BR). Pull ALL listings for the
  // resort and let the helper filter by minimum bedroom downstream.
  // Same pattern lets one Vrbo fetch satisfy multiple BR scans —
  // server-side dedup in the queue avoids hitting Vrbo multiple times
  // per property/date window.
  // Force currency=USD so Canadian operators don't get CAD values
  // mistakenly persisted as USD.
  const url =
    `https://www.vrbo.com/search?destination=${encodeURIComponent(effectiveSearchTerm)}` +
    `&startDate=${checkIn}&endDate=${checkOut}` +
    `&adults=2&sort=PRICE_LOW_TO_HIGH&currency=USD`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await stopVrboProviderIfBlocked(page, "vrbo_search", id);
  await dismissObstructions(page, "vrbo_search");
  await clickVisibleSearchSubmit(page, "vrbo_search").catch(() => null);
  // Do not apply VRBO's browser-side bedroom filter here. The same
  // resort/date browser run is shared across all bedroom-combination
  // checks for a booking, and the API curation layer applies the
  // authoritative bedroom rules later. This reduces repeated VRBO
  // loads without hiding provider blocks or bypassing controls.
  let state = await dumpPageState("vrbo", { id, ...params });
  throwIfBrightDataKycBlock(state, "vrbo_search", id);
  throwIfVrboHardBlock(state, "vrbo_search", id);
  await stopVrboProviderIfBlocked(page, "vrbo_search", id, state);
  if (stateLooksLikeVrboHumanChallenge(state)) {
    throw new VrboHardBlockError("VRBO human-verification page remained visible; provider run stopped and retry is rate-limited until later", {
      label: "vrbo_search",
      id,
      url: state?.url,
      title: state?.title,
      excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      retryLater: true,
    });
  }
  // Extract all visible cards and bucket by BR client-side. The
  // downstream minimum-bedroom guard remains the authoritative
  // protection against mismatched 1BR/2BR rows.

  // Compute expected nights from the requested window — we always
  // ask for 7-night (multichannel scanner) but compute robustly so
  // future callers can ask for different windows.
  const expectedNights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / (24 * 60 * 60 * 1000)));

  const result = await page.evaluate((args) => {
    const { expectedNights } = args;

    // Card selector with fallback chain. Vrbo's data-stid attribute
    // has changed multiple times; relying on a single fixed selector
    // breaks every time they redesign. Strategy:
    //   1. Try the historical data-stid="lodging-card-responsive"
    //      (still works on some page variants)
    //   2. Fall back to anchors with Vrbo property URLs (/N pattern)
    //      and walk up to their card-like ancestor. Vrbo property
    //      listing URLs are consistently digit-based, much more
    //      stable than data-stid attributes.
    let cardEls = Array.from(document.querySelectorAll('[data-stid="lodging-card-responsive"]'));
    let selectorSource = "data-stid";
    if (cardEls.length === 0) {
      const propertyAnchors = Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => /^\/\d+/.test(a.getAttribute("href") || ""));
      const cardSet = new Set();
      for (const a of propertyAnchors) {
        // Walk up to a card-like container. The first ancestor with
        // an h3 inside is likely the card boundary.
        let el = a;
        for (let depth = 0; depth < 6 && el && el.parentElement; depth++) {
          el = el.parentElement;
          if (el.querySelector("h3")) {
            cardSet.add(el);
            break;
          }
        }
      }
      cardEls = Array.from(cardSet);
      selectorSource = "anchor-fallback";
    }
    const out = [];
    const drops = { noUrl: 0, noPrice: 0, noBedrooms: 0 };
    let firstCardSample = null;
    for (const card of cardEls) {
      const titleEl = card.querySelector("h3");
      const title = titleEl ? titleEl.textContent.trim().replace(/^Photo gallery for\s*/i, "") : "";
      const fullText = (card.textContent || "").replace(/\s+/g, " ");
      const bdMatch = fullText.match(/(\d+)\s*bedrooms?/i);
      const link = card.querySelector("a[href]");
      const propertyPath = ((link?.getAttribute("href") || "")).replace(/^https?:\/\/[^\/]+/, "").split("?")[0];
      const bedroomsExtracted = bdMatch ? parseInt(bdMatch[1], 10) : null;

      // Capture the first card's text + extracted values so the daemon
      // can log it when zero cards survived the filter — gives us
      // visibility into Vrbo UI changes without redeploying.
      if (firstCardSample === null) {
        firstCardSample = {
          title: title.slice(0, 80),
          textExcerpt: fullText.slice(0, 240),
          propertyPath: propertyPath.slice(0, 80),
          bedroomsExtracted,
        };
      }

      if (!/^\/\d+/.test(propertyPath)) { drops.noUrl++; continue; }

      // Vrbo card pricing has TWO common formats today (2026-04-29):
      //   New: "$820" big price + "$8,123 total includes taxes & fees"
      //   Old: "$X for Y nights" (single string)
      let totalPrice = 0;
      let totalNights = 0;
      let priceIncludesTaxes = false;
      let priceIncludesFees = true;
      let priceBasis = "pre_tax_total";

      const totalMatch = fullText.match(/\$\s*([\d,]+)\s*total\s*(?:includes\s*taxes)?/i);
      if (totalMatch) {
        totalPrice = parseInt(totalMatch[1].replace(/,/g, ""), 10);
        totalNights = expectedNights;
        priceIncludesTaxes = /total\s*includes\s*taxes/i.test(fullText);
        priceIncludesFees = true;
        priceBasis = priceIncludesTaxes ? "all_in" : "pre_tax_total";
      } else {
        const m = fullText.match(/\$\s*([\d,]+)\s*for\s*(\d+)\s*nights/i);
        if (m) {
          totalPrice = parseInt(m[1].replace(/,/g, ""), 10);
          totalNights = parseInt(m[2], 10);
          priceIncludesTaxes = false;
          priceIncludesFees = true;
          priceBasis = "pre_tax_total";
        }
      }
      if (!(totalPrice > 0) || !(totalNights > 0)) { drops.noPrice++; continue; }
      if (bedroomsExtracted === null) { drops.noBedrooms++; continue; }

      out.push({
        url: "https://www.vrbo.com" + propertyPath,
        title: title.slice(0, 80),
        totalPrice,
        nightlyPrice: Math.round(totalPrice / totalNights),
        bedrooms: bedroomsExtracted,
        priceIncludesTaxes,
        priceIncludesFees,
        priceBasis,
      });
    }
    return { out, drops, totalSeen: cardEls.length, selectorSource, firstCardSample };
  }, { expectedNights });

  const cards = result.out;
  const allInCount = cards.filter((c) => c.priceIncludesTaxes).length;
  // Bedroom distribution across the extracted cards — surfaces UI
  // changes where the regex matches the wrong number (e.g. matches
  // "Sleeps 4 · 1 bedroom" → 4 instead of 1).
  const brList = cards.map((c) => c.bedrooms ?? "?").join(",");
  log(
    `vrbo_search ${id}: ${cards.length} cards (${allInCount} all-in / ${cards.length - allInCount} pre-tax) ` +
    `[selector=${result.totalSeen}/${result.selectorSource}, drops=noUrl:${result.drops.noUrl}/noPrice:${result.drops.noPrice}/noBR:${result.drops.noBedrooms}, BRs=[${brList}]]`,
  );
  if (cards.length === 0 && result.firstCardSample) {
    log(`vrbo_search ${id}: empty-result diagnostic — first card title="${result.firstCardSample.title}" path="${result.firstCardSample.propertyPath}" br=${result.firstCardSample.bedroomsExtracted} text="${result.firstCardSample.textExcerpt}"`);
  }
  // Per-card detail. Log min/max nightly per BR bucket so we can spot
  // outliers without flooding logs with 19+ lines per scan.
  if (cards.length > 0) {
    const byBR = new Map();
    for (const c of cards) {
      const k = c.bedrooms ?? "?";
      const bucket = byBR.get(k) ?? [];
      bucket.push(c.nightlyPrice);
      byBR.set(k, bucket);
    }
    const summary = Array.from(byBR.entries())
      .sort((a, b) => (typeof a[0] === "number" ? a[0] : 99) - (typeof b[0] === "number" ? b[0] : 99))
      .map(([br, prices]) => {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        return `${br}BR n=${prices.length} $${min}-$${max}`;
      })
      .join(", ");
    log(`vrbo_search ${id}: by-BR: ${summary}`);
  }
  await postResult(id, cards);
}

// ─────────────────────── VRBO listing photo scrape ─────────────────
async function processVrboPhotoScrape(id, params) {
  const { url, maxPhotos = 50 } = params;
  log(`vrbo_photo_scrape ${id}: ${url}`);
  await ensureBrowser();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await stopVrboProviderIfBlocked(page, "vrbo_photo_scrape", id);
  await dismissObstructions(page, "vrbo_photo_scrape");
  let state = await dumpPageState("vrbo-photo", { id, ...params });
  throwIfVrboHardBlock(state, "vrbo_photo_scrape", id);
  await stopVrboProviderIfBlocked(page, "vrbo_photo_scrape", id, state);
  if (stateLooksLikeVrboHumanChallenge(state)) {
    throw new VrboHardBlockError("VRBO human-verification page remained visible; provider run stopped and retry is rate-limited until later", {
      label: "vrbo_photo_scrape",
      id,
      url: state?.url,
      title: state?.title,
      excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      retryLater: true,
    });
  }

  await page
    .click('button:has-text("View all photos"), button:has-text("Show all photos"), button:has-text("Photo gallery")', { timeout: 2500 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const photos = await page.evaluate(({ maxPhotos }) => {
    const out = [];
    const seen = new Set();

    function normalize(raw) {
      if (!raw) return "";
      let url = String(raw)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .trim();
      if (url.startsWith("//")) url = `https:${url}`;
      return url;
    }

    function push(raw) {
      const url = normalize(raw);
      if (!/^https?:\/\//i.test(url)) return;
      const lower = url.toLowerCase();
      const isVrboImageHost = /(?:images\.trvl-media\.com|mediaim\.expedia\.com|odis\.homeaway\.com|vrbo\.com|homeaway\.com)/i.test(lower);
      const hasImageExtension = /\.(?:jpe?g|webp|png)(?:[?#]|$)/i.test(lower);
      if (!isVrboImageHost && !hasImageExtension) return;
      if (/logo|icon|sprite|avatar|favicon|placeholder|transparent|map/.test(lower)) return;
      const key = lower.replace(/[?#].*$/, "");
      if (seen.has(key)) return;
      seen.add(key);
      out.push(url);
    }

    function pushSrcset(srcset) {
      String(srcset || "").split(",").forEach((part) => {
        const first = part.trim().split(/\s+/)[0];
        push(first);
      });
    }

    document.querySelectorAll("img").forEach((img) => {
      push(img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src"));
      pushSrcset(img.getAttribute("srcset"));
    });
    document.querySelectorAll("source[srcset]").forEach((source) => pushSrcset(source.getAttribute("srcset")));

    document.querySelectorAll("script").forEach((script) => {
      const text = normalize(script.textContent || "");
      const matches = text.match(/https?:\/\/[^"' <>()]+?(?:jpe?g|webp|png)(?:\?[^"' <>()]*)?/gi) || [];
      matches.forEach(push);
    });

    return out.slice(0, Math.max(1, Math.min(100, Number(maxPhotos) || 50)));
  }, { maxPhotos });

  log(`vrbo_photo_scrape ${id}: ${photos.length} photos`);
  await postResult(id, { photos });
}

// ─────────────────────── Booking.com search ─────────────────────────
async function processBookingSearch(id, params) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(searchTerm || destination || "").trim();
  log(
    `booking_search ${id}: searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR`,
  );
  await ensureBrowser();
  // Booking.com supports `nflt=entire_place_bedroom_count%3D${bedrooms}`
  // for the bedroom filter (URL-encoded "entire_place_bedroom_count=N"),
  // sorted by price: `&order=price`. Do not click the Booking homepage
  // form first: its visible calendar defaults to today/tomorrow and can
  // asynchronously rewrite this URL back to the wrong dates.
  const urlParams = new URLSearchParams({
    ss: effectiveSearchTerm,
    ssne: effectiveSearchTerm,
    ssne_untouched: effectiveSearchTerm,
    checkin: checkIn,
    checkout: checkOut,
    group_adults: "2",
    no_rooms: "1",
    group_children: "0",
    order: "price",
    selected_currency: "USD",
    nflt: `entire_place_bedroom_count=${bedrooms}`,
  });
  const url = `https://www.booking.com/searchresults.html?${urlParams.toString()}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await dismissObstructions(page, "booking_search");
  await enforceBookingSearchUrl(url, effectiveSearchTerm, checkIn, checkOut, "after_initial_goto");
  await applyBookingBedroomFilter(bedrooms, url).catch(() => false);
  await enforceBookingSearchUrl(url, effectiveSearchTerm, checkIn, checkOut, "after_bedroom_filter");
  const state = await dumpPageState("booking", { id, ...params });
  throwIfBrightDataKycBlock(state, "booking_search", id);
  throwIfBlankSearchPage(state, "booking.com", "booking_search", id);
  if (state && /access denied|are you a robot|please verify/i.test(state.bodyExcerpt)) {
    throw new Error("Booking.com bot wall — refresh cookies.json (booking.com)");
  }

  const expectedNights = nightsBetween(checkIn, checkOut);
  const cards = await page.evaluate(({ minBd, expectedNights }) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="property-card"]'));
    const out = [];
    function moneyAmounts(text) {
      return Array.from(String(text || "").matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g))
        .map((m) => Math.round(parseFloat(m[1].replace(/,/g, ""))))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    for (const card of cards) {
      const titleEl = card.querySelector('[data-testid="title"]') ?? card.querySelector("h3, h2");
      const title = titleEl ? titleEl.textContent.trim() : "";
      const link = card.querySelector('a[href*="/hotel/"]');
      const href = link ? link.getAttribute("href") || "" : "";
      const img = card.querySelector("img");
      const image = img?.currentSrc || img?.src || img?.getAttribute("data-src") || undefined;
      // Strip query string for the canonical URL but keep the .html path.
      const url = href.startsWith("http") ? href.split("?")[0] : href ? "https://www.booking.com" + href.split("?")[0] : "";
      // Booking renders price fragments in two different places. On some
      // cards [price-and-discounted-price] is only the nightly rate while
      // the full card text also contains the stay total (e.g.
      // "Per night $1,028 $7,196 Price"). Prefer the largest plausible
      // full-card amount for the requested stay; only fall back to the
      // price element when the full card has no total-like amount.
      const priceEl = card.querySelector('[data-testid="price-and-discounted-price"]');
      const priceText = priceEl ? priceEl.textContent.replace(/\s+/g, " ") : "";
      const fullText = (card.textContent || "").replace(/\s+/g, " ");
      const priceElAmounts = moneyAmounts(priceText);
      const fullAmounts = moneyAmounts(fullText);
      const minStayTotal = Math.max(250, expectedNights * 175);
      const fullStayTotals = fullAmounts.filter((n) => n >= minStayTotal);
      let totalPrice = fullStayTotals.length > 0
        ? Math.max(...fullStayTotals)
        : priceElAmounts.length > 0
        ? Math.max(...priceElAmounts)
        : 0;
      // If we only found an implausibly-low "total" on a 3BR card, it is
      // almost certainly a nightly/partial-price fragment, not the full
      // stay total. Drop it rather than ranking a bogus $89/night Hawaii
      // 3BR above real resort inventory.
      if (minBd >= 3 && totalPrice > 0 && totalPrice < minStayTotal) {
        totalPrice = 0;
      }
      const bdMatch = fullText.match(/(\d+)\s*bedroom/i);
      const bedrooms = bdMatch ? parseInt(bdMatch[1], 10) : 0;
      if (!url) continue;
      if (!(totalPrice > 0)) continue;
      if (bedrooms < minBd) continue;
      out.push({
        url,
        title: title.slice(0, 80),
        totalPrice,
        // Booking shows a "total" price including taxes/fees for the
        // requested window; nightlyPrice is the average across that window.
        // Caller knows the night count from its own context (find-buy-in),
        // so we just publish total + a best-effort per-night.
        nightlyPrice: 0, // filled in by caller using its known night count
        bedrooms: bedrooms || undefined,
        priceIncludesTaxes: true,
        priceIncludesFees: true,
        priceBasis: "all_in",
        image,
        snippet: fullText.slice(0, 220),
      });
    }
    return out;
  }, { minBd: bedrooms, expectedNights });
  log(`booking_search ${id}: ${cards.length} cards`);
  await postResult(id, cards);
}

// ─────────────────────── Google SERP scrape ─────────────────────────
async function processGoogleSerp(id, params) {
  const { query, maxResults } = params;
  log(`google_serp ${id}: "${query}" max=${maxResults}`);
  await ensureBrowser();
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults ?? 20}&hl=en&gl=us`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(2500);
  await dismissObstructions(page, "google_serp");
  await page.waitForTimeout(800);
  const state = await dumpPageState("google", { id, ...params });
  if (state && /unusual traffic|sorry, but your computer/i.test(state.bodyExcerpt)) {
    throw new Error("Google rate-limit page — wait or rotate IP");
  }

  const hits = await page.evaluate((max) => {
    const out = [];
    const seen = new Set();
    // Modern Google SERP: organic results are inside `div.g` or
    // `div[data-sokoban-container]`. The h3 is the title; the parent
    // anchor carries the destination URL.
    const candidates = Array.from(document.querySelectorAll("div.g, div[data-sokoban-container], div.MjjYud"));
    for (const node of candidates) {
      if (out.length >= max) break;
      const a = node.querySelector("a[href^=http]");
      if (!a) continue;
      const url = a.getAttribute("href") || "";
      if (!url || seen.has(url)) continue;
      // Skip ads and Google-internal links.
      if (/google\.com\/(?:aclk|search|sorry)/.test(url)) continue;
      const titleEl = node.querySelector("h3");
      const title = titleEl ? titleEl.textContent.trim() : "";
      if (!title) continue;
      const snippetEl = node.querySelector("div[data-sncf], div.VwiC3b, span.aCOpRe");
      const snippet = snippetEl ? snippetEl.textContent.trim().slice(0, 220) : "";
      seen.add(url);
      out.push({ url, title: title.slice(0, 120), snippet });
    }
    return out;
  }, maxResults ?? 20);
  log(`google_serp ${id}: ${hits.length} hits`);
  await postResult(id, hits);
}

// ─────────────────────── PM URL availability check ─────────────────
// URL canonicalisation: most PM widgets accept either checkin/checkout
// or check_in/check_out query keys; set both so we don't have to know
// which CMS each PM is running.
function withDateParams(url, checkIn, checkOut) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("checkin")) u.searchParams.set("checkin", checkIn);
    if (!u.searchParams.has("checkout")) u.searchParams.set("checkout", checkOut);
    if (!u.searchParams.has("check_in")) u.searchParams.set("check_in", checkIn);
    if (!u.searchParams.has("check_out")) u.searchParams.set("check_out", checkOut);
    return u.toString();
  } catch {
    return url;
  }
}

async function clickPmCalendarDates(targetPage, checkIn, checkOut) {
  if (!targetPage || targetPage.isClosed?.()) return null;

  const runCalendarAction = (action, iso = null) => withSoftTimeout(
    targetPage.evaluate(({ action, iso }) => {
      const dateContextRe = /\b(?:check[\s_-]*in|check[\s_-]*out|arrival|departure|arrive|depart|date|dates|stay|calendar|availability|rates|booking|reservation|book now|reserve|select dates)\b/i;
      const badActionRe = /\b(?:clear|reset|cancel|close|search results|view search results|skip to main content|overview|photos?|visit owner|owner'?s website|external website|facebook|instagram|social|share|contact|request\s+info|ask\s+a\s+question|question|inquir(?:y|e)|enquir(?:y|e)|message|newsletter|subscribe|save\s+to\s+my\s+rentals|my\s+rentals|favorites?|terms|privacy|cookies?|policy|map|directions)\b/i;
      const submitRe = /\b(?:search|check availability|check rates|view rates|show rates|update|apply|submit|book now|reserve|continue)\b/i;
      const nextRe = /^(?:next|next month|following month|›|»|>|→)$/i;

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
          el.getAttribute?.("class"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        let cur = el.parentElement;
        for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
          parts.push(cur.getAttribute?.("aria-label"));
          parts.push(cur.getAttribute?.("class"));
          const txt = (cur.textContent || "").replace(/\s+/g, " ").trim();
          if (txt.length <= 320) parts.push(txt);
        }
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function disabled(el) {
        return Boolean(el.disabled) ||
          el.getAttribute?.("aria-disabled") === "true" ||
          /\b(?:disabled|unavailable|blocked|booked|unselectable)\b/i.test(el.getAttribute?.("class") || "");
      }

      function activate(el) {
        const label = textOf(el).slice(0, 80) || el.tagName.toLowerCase();
        el.scrollIntoView?.({ block: "center", inline: "center" });
        const init = { bubbles: true, cancelable: true, view: window };
        try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("mousedown", init)); } catch {}
        try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("mouseup", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("click", init)); } catch { el.click?.(); }
        return label;
      }

      function isoParts(rawIso) {
        const [y, m, d] = String(rawIso || "").split("-").map((p) => parseInt(p, 10));
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
        const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        return {
          y,
          m,
          d,
          iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
          mdyyyy: `${m}/${d}/${y}`,
          padded: `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`,
          monthLong: date.toLocaleString("en-US", { timeZone: "UTC", month: "long" }),
          monthShort: date.toLocaleString("en-US", { timeZone: "UTC", month: "short" }),
        };
      }

      function scoreDateCell(el, rawIso) {
        const p = isoParts(rawIso);
        if (!p || !isVisible(el) || disabled(el)) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width > 180 || rect.height > 180) return 0;
        const attrs = [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
          el.getAttribute?.("data-date"),
          el.getAttribute?.("data-day"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
          el.getAttribute?.("datetime"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        const label = attrs.toLowerCase();
        const ancestor = contextOf(el).toLowerCase();
        const monthYear = new RegExp(`\\b(?:${p.monthLong}|${p.monthShort})\\b[\\s\\S]{0,80}\\b${p.y}\\b`, "i");
        if (label.includes(p.iso)) return 100;
        if (label.includes(p.padded.toLowerCase()) || label.includes(p.mdyyyy.toLowerCase())) return 96;
        if (label.includes(`${p.monthLong.toLowerCase()} ${p.d}, ${p.y}`) || label.includes(`${p.monthShort.toLowerCase()} ${p.d}, ${p.y}`)) return 94;
        if (label.includes(`${p.monthLong.toLowerCase()} ${p.d}`) || label.includes(`${p.monthShort.toLowerCase()} ${p.d}`)) return 86;
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text === String(p.d) && monthYear.test(ancestor)) return 78;
        if (new RegExp(`\\b${p.d}\\b`).test(text) && monthYear.test(ancestor)) return 66;
        return 0;
      }

      function findDateCell(rawIso) {
        const selector = [
          "button",
          "a",
          "[role='button']",
          "td",
          "div[aria-label]",
          "span[aria-label]",
          "[data-date]",
          "[data-day]",
          "[class*='day' i]",
          "time",
        ].join(",");
        return Array.from(document.querySelectorAll(selector))
          .map((el) => ({ el, score: scoreDateCell(el, rawIso) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)[0]?.el ?? null;
      }

      function openCalendar() {
        if (iso && findDateCell(iso)) return null;
        const controls = Array.from(document.querySelectorAll("input, textarea, [role='textbox'], button, a, [role='button']"))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !disabled(el))
          .map((el) => {
            const label = textOf(el);
            const ctx = contextOf(el);
            const hay = `${label} ${ctx}`;
            let score = 0;
            if (!label && /^(?:a|button)$/i.test(el.tagName)) score = -100;
            if (dateContextRe.test(hay)) score += 50;
            if (/check[\s_-]*in|arrival|check[\s_-]*out|departure|dates|calendar/i.test(hay)) score += 30;
            if (/book now|reserve|check availability|select dates|view rates|show rates/i.test(hay)) score += 10;
            if (/^(?:overview|rooms|amenities|availability|location|reviews|rentals|vacation rentals|find a property|show filters|clear search|remove from favorites)(?:\s+.*)?$/i.test(label.trim())) score = 0;
            if (badActionRe.test(label)) score = 0;
            return { el, score, label };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score);
        const target = controls[0]?.el ?? null;
        if (!target) return null;
        return { openedLabel: activate(target) };
      }

      function clickDate(rawIso) {
        const target = findDateCell(rawIso);
        if (!target) return null;
        return { clickedLabel: activate(target) };
      }

      function clickNextMonth() {
        const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], [class*='next' i], [class*='arrow' i], [class*='chevron' i]"))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !disabled(el))
          .map((el) => ({ el, label: textOf(el), ctx: contextOf(el) }))
          .filter(({ label, ctx }) => {
            if (badActionRe.test(label)) return false;
            return nextRe.test(label.trim()) || /\bnext\b/i.test(label) || /\bnext\b/i.test(ctx) || /chevron[-_\s]*right|arrow[-_\s]*right/i.test(ctx);
          });
        const target = candidates[0]?.el ?? null;
        if (!target) return null;
        return { openedLabel: activate(target) };
      }

      function submitDates() {
        const buttons = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']"))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !disabled(el));
        const target = buttons.find((el) => {
          const label = textOf(el);
          if (!submitRe.test(label)) return false;
          if (badActionRe.test(label)) return false;
          return true;
        });
        if (!target) return null;
        return { submitLabel: activate(target) };
      }

      if (action === "open") return openCalendar();
      if (action === "click-date") return iso ? clickDate(iso) : null;
      if (action === "next-month") return clickNextMonth();
      if (action === "submit") return submitDates();
      return null;
    }, { action, iso }),
    3_000,
    null,
  );

  const filled = [];
  let openedLabel = null;
  let submitLabel = null;
  const openResult = await runCalendarAction("open", checkIn);
  if (openResult?.openedLabel) {
    openedLabel = openResult.openedLabel;
    await targetPage.waitForTimeout(500).catch(() => {});
  }

  for (const [role, iso] of [["checkin", checkIn], ["checkout", checkOut]]) {
    let clicked = null;
    for (let i = 0; i < 8 && !clicked; i++) {
      clicked = await runCalendarAction("click-date", iso);
      if (clicked?.clickedLabel) break;
      const next = await runCalendarAction("next-month", iso);
      if (next?.openedLabel) {
        openedLabel = openedLabel ?? next.openedLabel;
        await targetPage.waitForTimeout(350).catch(() => {});
      } else if (i === 0) {
        const retryOpen = await runCalendarAction("open", iso);
        if (retryOpen?.openedLabel) {
          openedLabel = openedLabel ?? retryOpen.openedLabel;
          await targetPage.waitForTimeout(500).catch(() => {});
        } else {
          break;
        }
      } else {
        break;
      }
    }
    if (clicked?.clickedLabel) {
      filled.push({ role, label: `calendar ${clicked.clickedLabel}`.slice(0, 80), visible: true });
      await targetPage.waitForTimeout(600).catch(() => {});
    }
  }

  if (filled.length > 0) {
    const submit = await runCalendarAction("submit");
    if (submit?.submitLabel) {
      submitLabel = submit.submitLabel;
      await targetPage.waitForTimeout(600).catch(() => {});
    }
  }

  return { filled, submitLabel, openedLabel, controlCount: 0 };
}

async function fillKnownPmDatePairs(targetPage, checkIn, checkOut) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  return withSoftTimeout(
    targetPage.evaluate(({ checkIn, checkOut }) => {
      const [cinY, cinM, cinD] = String(checkIn).split("-").map((p) => parseInt(p, 10));
      const [coutY, coutM, coutD] = String(checkOut).split("-").map((p) => parseInt(p, 10));
      const checkInHuman = `${cinM}/${cinD}/${cinY}`;
      const checkOutHuman = `${coutM}/${coutD}/${coutY}`;
      const pairs = [
        ["#book_start_date, [name='book_start_date']", "#book_end_date, [name='book_end_date']"],
        ["#checkin, #check_in, [name='checkin'], [name='check_in']", "#checkout, #check_out, [name='checkout'], [name='check_out']"],
        ["[name*='arrival' i], [id*='arrival' i], [name*='start' i], [id*='start' i]", "[name*='departure' i], [id*='departure' i], [name*='end' i], [id*='end' i]"],
      ];
      const buttonSelector = "button, a, input[type='button'], input[type='submit'], [role='button']";
      const submitRe = /\b(?:search|check availability|check rates|view rates|show rates|update|apply|submit|book now|reserve|select dates|continue)\b/i;
      const badDateActionRe = /\b(?:clear|reset|cancel|close|search results|view search results|skip to main content|overview|photos?|visit owner|owner'?s website|external website|facebook|instagram|social|share|contact|call|phone|tel|request\s+info|ask\s+a\s+question|question|inquir(?:y|e)|enquir(?:y|e)|message|newsletter|subscribe|save\s+to\s+my\s+rentals|my\s+rentals|favorites?|terms|privacy|cookies?|policy|map|directions)\b|(?:\+?\d[\d().\-\s]{6,}\d)|(?:\b\d{3}[-.\s]?\d{3}[-.\s]?[a-z]{3,}\s*\(?\d{4}\)?)/i;

      function isRendered(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function dateValueNeedles(value, iso) {
        const needles = [value, iso].filter(Boolean).map(String);
        const [y, m, d] = String(iso || "").split("-").map((p) => parseInt(p, 10));
        if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
          needles.push(`${m}/${d}/${y}`);
          needles.push(`${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`);
          needles.push(`${m}-${d}-${y}`);
          needles.push(`${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}-${y}`);
        }
        return needles.map((s) => s.toLowerCase());
      }

      function valueWasApplied(el, value, iso) {
        const tag = el.tagName.toLowerCase();
        const current = String(el.isContentEditable || el.getAttribute?.("role") === "textbox"
          ? (el.textContent || "")
          : tag === "select"
          ? (el.value || el.selectedOptions?.[0]?.textContent || "")
          : (el.value || el.getAttribute?.("value") || "")).toLowerCase();
        if (!current.trim()) return false;
        return dateValueNeedles(value, iso).some((needle) => needle && current.includes(needle));
      }

      function hasJqueryDatepicker(el) {
        try {
          const jq = window.jQuery || window.$;
          return Boolean(jq?.fn?.datepicker && jq(el)?.hasClass?.("hasDatepicker"));
        } catch {
          return false;
        }
      }

      function setInputValue(el, value, iso) {
        if (!el) return false;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();
        if (tag === "input" && type !== "hidden" && el.readOnly && isRendered(el) && !hasJqueryDatepicker(el)) return false;
        const nextValue = tag === "input" && type === "date" ? iso : value;
        try { el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
        try { el.focus?.(); } catch {}
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, nextValue);
        else el.value = nextValue;
        try {
          const jq = window.jQuery || window.$;
          if (jq?.fn?.datepicker && jq(el)?.hasClass?.("hasDatepicker")) {
            jq(el).datepicker("setDate", value);
            jq(el).trigger("input").trigger("change").trigger("blur");
          }
        } catch {}
        for (const name of ["input", "change", "blur"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return valueWasApplied(el, nextValue, iso);
      }

      for (const [startSelector, endSelector] of pairs) {
        const start = Array.from(document.querySelectorAll(startSelector)).find(isRendered);
        const end = Array.from(document.querySelectorAll(endSelector)).find(isRendered);
        if (!start || !end || start === end) continue;
        const filled = [];
        if (setInputValue(start, checkInHuman, checkIn)) {
          filled.push({ role: "checkin", label: `${start.getAttribute("name") || start.id || "paired start"}`.slice(0, 80), visible: true });
        }
        if (setInputValue(end, checkOutHuman, checkOut)) {
          filled.push({ role: "checkout", label: `${end.getAttribute("name") || end.id || "paired end"}`.slice(0, 80), visible: true });
        }
        const submit = filled.some((f) => f.role === "checkin") && filled.some((f) => f.role === "checkout")
          ? Array.from(document.querySelectorAll(buttonSelector))
            .filter((el) => el instanceof HTMLElement && isRendered(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true")
            .find((el) => {
              const label = textOf(el);
              return submitRe.test(label) && !badDateActionRe.test(label);
            })
          : null;
        if (submit) {
          submit.scrollIntoView?.({ block: "center", inline: "center" });
          submit.click();
        }
        if (filled.length > 0) return {
          filled,
          submitLabel: submit ? textOf(submit).slice(0, 80) || submit.tagName.toLowerCase() : null,
          openedLabel: null,
          controlCount: 2,
        };
      }
      return null;
    }, { checkIn, checkOut }),
    5_000,
    null,
  );
}

async function askVisualDateControlModel(targetPage, checkIn, checkOut) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const candidates = await withSoftTimeout(
    targetPage.evaluate(() => {
      const selector = [
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[role='textbox']",
        "button",
        "a",
        "[role='button']",
        "label",
        "[aria-label]",
        "[title]",
      ].join(",");
      const usefulRe = /\b(?:arrival|departure|arrive|depart|check[\s_-]*in|check[\s_-]*out|date|dates|calendar|availability|search|book|reserve|guest|bedroom|filter)\b/i;
      const badContainerRe = /\b(?:footer|social|share|newsletter|cookie|privacy|terms)\b/i;

      function clean(raw) {
        return String(raw || "").replace(/\s+/g, " ").trim();
      }

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 6 && rect.height > 6 &&
          rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return clean([
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" "));
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
          el.getAttribute?.("class"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        let cur = el.parentElement;
        for (let i = 0; cur && i < 3; i++, cur = cur.parentElement) {
          parts.push(cur.getAttribute?.("aria-label"));
          parts.push(cur.getAttribute?.("class"));
          const txt = clean(cur.textContent);
          if (txt.length <= 260) parts.push(txt);
        }
        return clean(parts.filter(Boolean).join(" "));
      }

      const out = [];
      let seq = 0;
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        const ctx = contextOf(el);
        const label = textOf(el);
        const hay = `${label} ${ctx}`;
        if (!usefulRe.test(hay)) continue;
        if (badContainerRe.test(ctx) && !/\b(?:arrival|departure|check|date|search availability)\b/i.test(hay)) continue;
        const visualId = `v${seq++}`;
        el.setAttribute("data-sidecar-visual-id", visualId);
        out.push({
          id: visualId,
          tag: el.tagName.toLowerCase(),
          type: clean(el.getAttribute?.("type")).slice(0, 24),
          role: clean(el.getAttribute?.("role")).slice(0, 40),
          text: label.slice(0, 120),
          placeholder: clean(el.getAttribute?.("placeholder")).slice(0, 80),
          ariaLabel: clean(el.getAttribute?.("aria-label")).slice(0, 100),
          title: clean(el.getAttribute?.("title")).slice(0, 100),
          name: clean(el.getAttribute?.("name")).slice(0, 80),
          domId: clean(el.getAttribute?.("id")).slice(0, 80),
          context: ctx.slice(0, 260),
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
        });
        if (out.length >= 80) break;
      }
      return out;
    }),
    4_000,
    [],
  ).catch(() => []);
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const screenshot = await withSoftTimeout(
    targetPage.screenshot({ type: "jpeg", quality: 58, fullPage: false }),
    5_000,
    null,
  ).catch(() => null);
  if (!screenshot) return null;

  const response = await withSoftTimeout(
    fetch(`${SERVER}/api/admin/vrbo-sidecar/visual-date-controls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        url: targetPage.url(),
        title: await targetPage.title().catch(() => ""),
        checkIn,
        checkOut,
        screenshotBase64: screenshot.toString("base64"),
        candidates,
      }),
    }),
    15_000,
    null,
  ).catch(() => null);
  if (!response?.ok) {
    if (response) {
      const text = await response.text().catch(() => "");
      log(`pm_visual_date_fallback: model unavailable HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    return null;
  }
  const data = await response.json().catch(() => null);
  return data?.plan ?? null;
}

async function applyVisualPmDateFallback(targetPage, checkIn, checkOut) {
  const plan = await askVisualDateControlModel(targetPage, checkIn, checkOut);
  if (!plan || typeof plan !== "object") return null;
  const confidence = Number(plan.confidence ?? 0);
  if (Number.isFinite(confidence) && confidence < 0.35) return null;

  return withSoftTimeout(
    targetPage.evaluate(({ plan, checkIn, checkOut }) => {
      const [cinY, cinM, cinD] = String(checkIn).split("-").map((p) => parseInt(p, 10));
      const [coutY, coutM, coutD] = String(checkOut).split("-").map((p) => parseInt(p, 10));
      const checkInHuman = `${cinM}/${cinD}/${cinY}`;
      const checkOutHuman = `${coutM}/${coutD}/${coutY}`;
      const rangeHuman = `${checkInHuman} - ${checkOutHuman}`;

      function clean(raw) {
        return String(raw || "").replace(/\s+/g, " ").trim();
      }

      function find(id) {
        if (!id || typeof id !== "string") return null;
        return document.querySelector(`[data-sidecar-visual-id="${CSS.escape(id)}"]`);
      }

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("class"),
          clean(el.textContent).slice(0, 80),
        ];
        return clean(parts.filter(Boolean).join(" ")).slice(0, 80);
      }

      function valueNeedles(value, iso) {
        const needles = [value, iso].filter(Boolean).map(String);
        const [y, m, d] = String(iso || "").split("-").map((p) => parseInt(p, 10));
        if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
          needles.push(`${m}/${d}/${y}`);
          needles.push(`${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`);
        }
        return needles.map((s) => s.toLowerCase());
      }

      function valueWasApplied(el, value, iso) {
        const tag = el.tagName.toLowerCase();
        const current = String(el.isContentEditable || el.getAttribute?.("role") === "textbox"
          ? (el.textContent || "")
          : tag === "select"
          ? (el.value || el.selectedOptions?.[0]?.textContent || "")
          : (el.value || el.getAttribute?.("value") || "")).toLowerCase();
        if (!current.trim()) return false;
        return valueNeedles(value, iso).some((needle) => needle && current.includes(needle));
      }

      function setValue(el, value, iso) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();
        const nextValue = tag === "input" && type === "date" ? iso : value;
        try { el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
        try { el.focus?.(); } catch {}
        try {
          const jq = window.jQuery || window.$;
          if (jq?.fn?.datepicker && jq(el)?.hasClass?.("hasDatepicker")) {
            jq(el).datepicker("setDate", value);
            jq(el).trigger("input").trigger("change").trigger("blur");
          }
        } catch {}
        if (tag === "select") return valueWasApplied(el, nextValue, iso);
        if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
          el.textContent = nextValue;
        } else {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, nextValue);
          else el.value = nextValue;
          el.setAttribute?.("value", nextValue);
        }
        for (const name of ["input", "change", "blur"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return valueWasApplied(el, nextValue, iso);
      }

      function activate(el) {
        if (!el || !(el instanceof HTMLElement) || !isVisible(el)) return null;
        const label = clean([el.textContent, el.getAttribute?.("aria-label"), el.getAttribute?.("title"), el.getAttribute?.("value")].filter(Boolean).join(" ")).slice(0, 80) || el.tagName.toLowerCase();
        el.scrollIntoView?.({ block: "center", inline: "center" });
        const init = { bubbles: true, cancelable: true, view: window };
        try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("mousedown", init)); } catch {}
        try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("mouseup", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("click", init)); } catch { el.click?.(); }
        return label;
      }

      const filled = [];
      const addFill = (role, id, value, iso) => {
        const el = find(id);
        if (!el) return;
        if (setValue(el, value, iso)) {
          filled.push({ role, label: `visual ${contextOf(el)}`, visible: isVisible(el) });
        }
      };

      if (plan.rangeId) {
        addFill("range", plan.rangeId, rangeHuman, checkIn);
      } else {
        addFill("checkin", plan.checkInId, checkInHuman, checkIn);
        addFill("checkout", plan.checkOutId, checkOutHuman, checkOut);
      }

      const complete =
        filled.some((f) => f.role === "range") ||
        (filled.some((f) => f.role === "checkin") && filled.some((f) => f.role === "checkout"));
      const submitLabel = complete ? activate(find(plan.submitId)) : null;
      return {
        filled,
        submitLabel,
        openedLabel: null,
        controlCount: Number(plan.candidateCount || 0),
        visualReason: clean(plan.reason).slice(0, 160),
      };
    }, { plan, checkIn, checkOut }),
    7_000,
    null,
  ).catch(() => null);
}

async function applyPmDateInputs(targetPage, checkIn, checkOut) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const attempt = async (allowOpenOnly) => withSoftTimeout(
    targetPage.evaluate(({ checkIn, checkOut, allowOpenOnly }) => {
      const [cinY, cinM, cinD] = String(checkIn).split("-").map((p) => parseInt(p, 10));
      const [coutY, coutM, coutD] = String(checkOut).split("-").map((p) => parseInt(p, 10));
      const checkInHuman = `${cinM}/${cinD}/${cinY}`;
      const checkOutHuman = `${coutM}/${coutD}/${coutY}`;
      const rangeHuman = `${checkInHuman} - ${checkOutHuman}`;
      const controlSelector = [
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[role='textbox']",
      ].join(",");
      const buttonSelector = "button, a, input[type='button'], input[type='submit'], [role='button']";
      const inRe = /\b(?:check[\s_-]*in|arrival|arrive|start|from|begin|beginning)\b/i;
      const outRe = /\b(?:check[\s_-]*out|departure|depart|end|until|leave|leaving|to)\b/i;
      const dateRe = /\b(?:date|dates|stay|calendar|availability|booking|reservation|arrival|departure|check[\s_-]*in|check[\s_-]*out)\b/i;
      const dateValueRe = /(?:mm\/dd|dd\/mm|yyyy|arrival|departure|check|date)/i;
      const submitRe = /\b(?:search|check availability|check rates|view rates|show rates|update|apply|submit|book now|reserve|select dates|continue)\b/i;
      const openerRe = /\b(?:check availability|check rates|view rates|show rates|book now|reserve|select dates|availability|rates)\b/i;
      const badDateActionRe = /\b(?:clear|reset|cancel|close|search results|view search results|skip to main content|overview|photos?|visit owner|owner'?s website|external website|facebook|instagram|social|share|contact|call|phone|tel|request\s+info|ask\s+a\s+question|question|inquir(?:y|e)|enquir(?:y|e)|message|newsletter|subscribe|save\s+to\s+my\s+rentals|my\s+rentals|favorites?|terms|privacy|cookies?|policy|map|directions)\b|(?:\+?\d[\d().\-\s]{6,}\d)|(?:\b\d{3}[-.\s]?\d{3}[-.\s]?[a-z]{3,}\s*\(?\d{4}\)?)/i;

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function contextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
          el.getAttribute?.("class"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        let cur = el.parentElement;
        for (let i = 0; cur && i < 3; i++, cur = cur.parentElement) {
          parts.push(cur.getAttribute?.("aria-label"));
          parts.push(cur.getAttribute?.("class"));
          const txt = (cur.textContent || "").replace(/\s+/g, " ").trim();
          if (txt.length <= 240) parts.push(txt);
        }
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function fieldContextOf(el) {
        const parts = [
          el.getAttribute?.("name"),
          el.getAttribute?.("id"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
        ];
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        const nearestField = el.closest?.(".form-group, .date-group, [class*='field' i], [class*='date' i]");
        const fieldText = (nearestField?.textContent || "").replace(/\s+/g, " ").trim();
        if (fieldText.length <= 120) parts.push(fieldText);
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function isDateControl(el) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();
        if (tag === "input" && ["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(type)) return false;
        const ctx = contextOf(el);
        if (tag === "input" && type === "date") return true;
        if (!isVisible(el) && !(tag === "input" && type === "hidden" && /check|arrival|depart|date/i.test(ctx))) return false;
        if (dateRe.test(ctx) || dateValueRe.test(ctx)) return true;
        return false;
      }

      function dateValueNeedles(value, iso) {
        const needles = [value, iso].filter(Boolean).map(String);
        const [y, m, d] = String(iso || "").split("-").map((p) => parseInt(p, 10));
        if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
          needles.push(`${m}/${d}/${y}`);
          needles.push(`${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`);
          needles.push(`${m}-${d}-${y}`);
          needles.push(`${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}-${y}`);
        }
        return needles.map((s) => s.toLowerCase());
      }

      function valueWasApplied(el, value, iso) {
        const tag = el.tagName.toLowerCase();
        const current = String(el.isContentEditable || el.getAttribute?.("role") === "textbox"
          ? (el.textContent || "")
          : tag === "select"
          ? (el.value || el.selectedOptions?.[0]?.textContent || "")
          : (el.value || el.getAttribute?.("value") || "")).toLowerCase();
        if (!current.trim()) return false;
        return dateValueNeedles(value, iso).some((needle) => needle && current.includes(needle));
      }

      function hasJqueryDatepicker(el) {
        try {
          const jq = window.jQuery || window.$;
          return Boolean(jq?.fn?.datepicker && jq(el)?.hasClass?.("hasDatepicker"));
        } catch {
          return false;
        }
      }

      function setValue(el, value, iso) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();
        if (tag === "input" && type !== "hidden" && el.readOnly && isVisible(el) && !hasJqueryDatepicker(el)) return false;
        const nextValue = tag === "input" && type === "date" ? iso : value;
        try { el.focus?.(); } catch {}
        if (tag === "select") {
          const options = Array.from(el.options || []);
          const wanted = [nextValue, value, iso].map((s) => String(s).toLowerCase());
          const option = options.find((o) => wanted.some((w) => String(o.value || "").toLowerCase().includes(w) || String(o.textContent || "").toLowerCase().includes(w)));
          if (!option) return false;
          el.value = option.value;
        } else if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
          el.textContent = nextValue;
        } else {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, nextValue);
          else el.value = nextValue;
        }
        try {
          const jq = window.jQuery || window.$;
          if (jq?.fn?.datepicker && jq(el)?.hasClass?.("hasDatepicker")) {
            jq(el).datepicker("setDate", value);
            jq(el).trigger("input").trigger("change").trigger("blur");
          }
        } catch {}
        for (const name of ["input", "change", "blur"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return valueWasApplied(el, nextValue, iso);
      }

      function classify(el) {
        const fieldCtx = fieldContextOf(el);
        if (inRe.test(fieldCtx) && !outRe.test(fieldCtx)) return "checkin";
        if (outRe.test(fieldCtx) && !inRe.test(fieldCtx)) return "checkout";
        const ctx = contextOf(el);
        if (inRe.test(ctx) && !outRe.test(ctx)) return "checkin";
        if (outRe.test(ctx) && !inRe.test(ctx)) return "checkout";
        if (/\b(?:range|dates|stay)\b/i.test(ctx) && inRe.test(ctx) && outRe.test(ctx)) return "range";
        return "unknown";
      }

      function clickSubmit(nearEls) {
        const nearForms = new Set(nearEls.map((el) => el.closest?.("form")).filter(Boolean));
        const visibleNearRects = nearEls
          .filter(isVisible)
          .map((el) => el.getBoundingClientRect());
        const nearBounds = visibleNearRects.length > 0
          ? {
              top: Math.min(...visibleNearRects.map((r) => r.top)),
              bottom: Math.max(...visibleNearRects.map((r) => r.bottom)),
              left: Math.min(...visibleNearRects.map((r) => r.left)),
              right: Math.max(...visibleNearRects.map((r) => r.right)),
            }
          : null;
        function isBadSubmitContainer(el) {
          return Boolean(el.closest?.("footer, nav, header, [class*='footer' i], [class*='social' i], [class*='share' i], [class*='contact' i], [class*='chat' i], [class*='question' i], [class*='favorite' i]"));
        }
        const buttons = Array.from(document.querySelectorAll(buttonSelector))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
        const candidates = buttons.map((el) => {
          const label = textOf(el);
          if (!submitRe.test(label)) return null;
          if (badDateActionRe.test(label) || isBadSubmitContainer(el)) return null;
          const form = el.closest?.("form");
          const ctx = contextOf(el);
          const rect = el.getBoundingClientRect();
          const nearForm = nearForms.size > 0 && nearForms.has(form);
          const nearWidget =
            nearBounds &&
            rect.bottom >= nearBounds.top - 260 &&
            rect.top <= nearBounds.bottom + 700 &&
            rect.right >= nearBounds.left - 320 &&
            rect.left <= nearBounds.right + 420;
          const contextual = /availability|rates|book|reserve|search/i.test(ctx);
          if (nearForms.size > 0 && !nearForm && !nearWidget && !contextual) return null;
          if (nearForms.size === 0 && nearBounds && !nearWidget && !contextual) return null;
          let score = 0;
          if (nearForm) score += 80;
          if (nearWidget) score += 50;
          if (/^(?:search|check availability|check rates|view rates|show rates|update results|apply)$/i.test(label.trim())) score += 30;
          if (contextual) score += 15;
          if (nearBounds) score -= Math.min(30, Math.abs(rect.top - nearBounds.bottom) / 50);
          return { el, score };
        }).filter(Boolean).sort((a, b) => b.score - a.score);
        const target = candidates[0]?.el;
        if (!target) return null;
        target.scrollIntoView?.({ block: "center", inline: "center" });
        target.click();
        return textOf(target).slice(0, 80) || target.tagName.toLowerCase();
      }

      const controls = Array.from(document.querySelectorAll(controlSelector)).filter(isDateControl);
      const visibleControls = controls.filter(isVisible);
      const checkInEls = controls.filter((el) => classify(el) === "checkin");
      const checkOutEls = controls.filter((el) => classify(el) === "checkout");
      const rangeEls = controls.filter((el) => classify(el) === "range");
      const filled = [];
      const filledEls = [];

      const uniqueControls = (items) => Array.from(new Set(items.filter(Boolean)));
      const preferVisible = (items) => items.find(isVisible) ?? items[0] ?? null;
      const nextVisibleAfter = (el) => {
        if (!el) return null;
        const idx = visibleControls.indexOf(el);
        if (idx < 0) return null;
        return visibleControls.slice(idx + 1).find((candidate) => !filledEls.includes(candidate)) ?? null;
      };
      const previousVisibleBefore = (el) => {
        if (!el) return null;
        const idx = visibleControls.indexOf(el);
        if (idx < 0) return null;
        return [...visibleControls.slice(0, idx)].reverse().find((candidate) => !filledEls.includes(candidate)) ?? null;
      };
      const firstUnusedVisible = (...exclude) =>
        visibleControls.find((candidate) => !exclude.includes(candidate) && !filledEls.includes(candidate)) ?? null;

      const fillOne = (el, value, iso, role) => {
        if (!el || filledEls.includes(el)) return null;
        if (setValue(el, value, iso)) {
          filledEls.push(el);
          filled.push({ role, label: contextOf(el).slice(0, 80), visible: isVisible(el) });
          return el;
        }
        return null;
      };
      const fillFirst = (candidates, value, iso, role) => {
        for (const candidate of uniqueControls(candidates)) {
          const used = fillOne(candidate, value, iso, role);
          if (used) return used;
        }
        return null;
      };

      if (checkInEls.length > 0 || checkOutEls.length > 0) {
        const labeledCheckIn = preferVisible(checkInEls);
        const labeledCheckOut = preferVisible(checkOutEls);
        const usedCheckIn = fillFirst([
          labeledCheckIn,
          previousVisibleBefore(labeledCheckOut),
          firstUnusedVisible(labeledCheckOut),
        ], checkInHuman, checkIn, "checkin");
        fillFirst([
          labeledCheckOut,
          nextVisibleAfter(usedCheckIn ?? labeledCheckIn),
          firstUnusedVisible(usedCheckIn ?? labeledCheckIn),
        ], checkOutHuman, checkOut, "checkout");
      } else if (rangeEls.length > 0) {
        fillOne(rangeEls[0], rangeHuman, checkIn, "range");
      } else if (visibleControls.length >= 2) {
        fillOne(visibleControls[0], checkInHuman, checkIn, "checkin");
        fillOne(visibleControls[1], checkOutHuman, checkOut, "checkout");
      } else if (visibleControls.length === 1) {
        fillOne(visibleControls[0], rangeHuman, checkIn, "range");
      }

      const hasCompleteDateEntry =
        filled.some((f) => f.role === "range") ||
        (filled.some((f) => f.role === "checkin") && filled.some((f) => f.role === "checkout"));
      const submitLabel = hasCompleteDateEntry ? clickSubmit(filledEls) : null;
      if (filled.length === 0 && allowOpenOnly) {
        const openers = Array.from(document.querySelectorAll(buttonSelector))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true")
          .filter((el) => {
            const label = textOf(el);
            if (badDateActionRe.test(label)) return false;
            if (/^(?:overview|rooms|amenities|availability|location|reviews|rentals|vacation rentals|find a property|show filters|clear search|remove from favorites)(?:\s+.*)?$/i.test(label.trim())) return false;
            return openerRe.test(label) || openerRe.test(contextOf(el));
          });
        const opener = openers[0];
        if (opener) {
          opener.scrollIntoView?.({ block: "center", inline: "center" });
          opener.click();
          return { filled, submitLabel: null, openedLabel: textOf(opener).slice(0, 80) || opener.tagName.toLowerCase(), controlCount: controls.length };
        }
      }
      return { filled, submitLabel, openedLabel: null, controlCount: controls.length };
    }, { checkIn, checkOut, allowOpenOnly }),
    5_000,
    null,
  );

  const hasCompleteDateEntry = (entry) =>
    entry?.filled?.some((f) => f.role === "range" && f.visible) ||
    (entry?.filled?.some((f) => f.role === "checkin" && f.visible) && entry?.filled?.some((f) => f.role === "checkout" && f.visible));
  const mergeDateEntry = (prev, next) => {
    const filled = [];
    const seen = new Set();
    for (const item of [...(prev?.filled ?? []), ...(next?.filled ?? [])]) {
      const key = `${item.role}|${item.label}|${item.visible}`;
      if (seen.has(key)) continue;
      seen.add(key);
      filled.push(item);
    }
    return {
      controlCount: next?.controlCount ?? prev?.controlCount ?? 0,
      filled,
      submitLabel: next?.submitLabel ?? prev?.submitLabel ?? null,
      openedLabel: prev?.openedLabel ?? next?.openedLabel ?? null,
      visualReason: next?.visualReason ?? prev?.visualReason ?? null,
    };
  };
  const knownPair = await fillKnownPmDatePairs(targetPage, checkIn, checkOut);
  await targetPage.waitForTimeout(hasCompleteDateEntry(knownPair) ? 500 : 0).catch(() => {});
  const first = hasCompleteDateEntry(knownPair)
    ? knownPair
    : mergeDateEntry(knownPair, await attempt(true));
  let result = first;
  if (first?.openedLabel && (!first.filled || first.filled.length === 0)) {
    await targetPage.waitForTimeout(1_000).catch(() => {});
    await dismissObstructions(targetPage, "pm_date_entry_after_open");
    const second = await attempt(false);
    result = mergeDateEntry(first, second);
  }
  for (let i = 0; result?.filled?.length > 0 && !hasCompleteDateEntry(result) && i < 2; i++) {
    await targetPage.waitForTimeout(PM_PARTIAL_DATE_RETRY_MS).catch(() => {});
    await dismissObstructions(targetPage, "pm_date_entry_after_partial");
    const next = await attempt(false);
    result = mergeDateEntry(result, next);
    if (!next?.filled?.length && !next?.openedLabel && !next?.submitLabel) break;
  }
  if (!hasCompleteDateEntry(result)) {
    await targetPage.waitForTimeout(500).catch(() => {});
    const knownPairRetry = await fillKnownPmDatePairs(targetPage, checkIn, checkOut);
    result = mergeDateEntry(result, knownPairRetry);
  }
  if (!hasCompleteDateEntry(result)) {
    await dismissObstructions(targetPage, "pm_date_entry_visual_fallback");
    const visual = await applyVisualPmDateFallback(targetPage, checkIn, checkOut);
    result = mergeDateEntry(result, visual);
  }
  if (!hasCompleteDateEntry(result)) {
    await dismissObstructions(targetPage, "pm_date_entry_calendar_fallback");
    const calendar = await clickPmCalendarDates(targetPage, checkIn, checkOut);
    result = mergeDateEntry(result, calendar);
  }
  if (hasCompleteDateEntry(result) && !result?.submitLabel) {
    await targetPage.waitForTimeout(700).catch(() => {});
    const submitRetry = await attempt(false);
    if (submitRetry?.submitLabel) result = mergeDateEntry(result, submitRetry);
  }
  const filledCount = result?.filled?.length ?? 0;
  const entryComplete = hasCompleteDateEntry(result);
  if (filledCount > 0 || result?.openedLabel || result?.submitLabel) {
    log(
      `pm_url_check: date entry controls=${result?.controlCount ?? 0} filled=${filledCount}` +
      `${result?.filled?.length ? ` roles=${result.filled.map((f) => f.role).join("+")}` : ""}` +
      `${entryComplete ? " complete=true" : filledCount > 0 ? " complete=false" : ""}` +
      `${result?.openedLabel ? ` opened="${result.openedLabel}"` : ""}` +
      `${result?.submitLabel ? ` clicked="${result.submitLabel}"` : ""}` +
      `${result?.visualReason ? ` visual="${result.visualReason}"` : ""}`,
    );
    if (entryComplete || result?.submitLabel || result?.openedLabel) {
      if (result?.submitLabel || result?.openedLabel) {
        await withSoftTimeout(targetPage.waitForLoadState("networkidle", { timeout: 4_000 }), 4_500);
      }
      await targetPage.waitForTimeout(entryComplete ? PM_POST_DATE_SETTLE_MS : 1_000).catch(() => {});
      await dismissObstructions(targetPage, entryComplete ? "pm_url_check_after_date_entry" : "pm_url_check_after_date_submit");
    }
  }
  return result;
}

// Visit `url` on `targetPage`, scrape an availability + price signal.
// Returns { available, nightlyPrice, totalPrice, reason }. Pure
// function on a Playwright page — doesn't touch the shared `page`,
// so safe to call concurrently from N tabs.
async function scrapePmUrl(targetPage, url, checkIn, checkOut, bedrooms = null) {
  const finalUrl = withDateParams(url, checkIn, checkOut);
  const navResponse = await targetPage.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  const navStatus = navResponse?.status?.();
  if (navStatus === 404 || navStatus === 410) {
    return {
      available: "no",
      nightlyPrice: null,
      totalPrice: null,
      reason: `HTTP ${navStatus}: PM page is no longer published for this URL`,
    };
  }
  if (typeof navStatus === "number" && navStatus >= 400) {
    return {
      available: "unclear",
      nightlyPrice: null,
      totalPrice: null,
      reason: `HTTP ${navStatus}: PM page did not load cleanly`,
    };
  }
  await targetPage.waitForTimeout(PAGE_SETTLE_MS);
  const dismissals = await dismissObstructions(targetPage, "pm_url_check");
  await targetPage.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" })).catch(() => {});
  const dateEntry = await applyPmDateInputs(targetPage, checkIn, checkOut);
  await normalizePageDisplay(targetPage);
  const hostForBedroomDetect = (() => {
    try { return new URL(finalUrl).hostname.replace(/^www\./, ""); } catch { return ""; }
  })();
  const detectedBedrooms = /booking\.com$/i.test(hostForBedroomDetect)
    ? null
    : await detectPmPageBedrooms(targetPage);
  const platformResult = await targetPage.evaluate(async ({ checkIn, checkOut, bedrooms }) => {
    const nightsBetween = (a, b) => Math.max(
      1,
      Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000),
    );
    const nights = nightsBetween(checkIn, checkOut);
    const isoNights = [];
    for (
      let t = new Date(`${checkIn}T12:00:00Z`).getTime(), end = new Date(`${checkOut}T12:00:00Z`).getTime();
      t < end;
      t += 86400000
    ) {
      const d = new Date(t);
      isoNights.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
    const toMdY = (iso) => {
      const [y, m, d] = iso.split("-").map((p) => parseInt(p, 10));
      return `${m}-${d}-${y}`;
    };
    const toMdYY = (iso) => {
      const [y, m, d] = iso.split("-");
      return `${m}/${d}/${y}`;
    };
    const host = window.location.hostname.replace(/^www\./, "");

    function parseMoneyAmount(raw) {
      const n = parseFloat(String(raw || "").replace(/,/g, "").replace(/[^\d.]/g, ""));
      return Number.isFinite(n) ? n : 0;
    }

    function roundCents(n) {
      return Math.round(n * 100) / 100;
    }

    function displayDate(iso) {
      const d = new Date(`${iso}T12:00:00Z`);
      if (!Number.isFinite(d.getTime())) return iso;
      return d.toLocaleDateString("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }

    function bedroomPhraseRe(n) {
      if (!n || !Number.isFinite(Number(n))) return null;
      const words = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };
      const w = words[Number(n)];
      return new RegExp(`(?:${n}${w ? `|${w}` : ""})[\\s-]*(?:bedroom|bedrooms|bed|br|bd)`, "i");
    }

    async function callStreamline(methodName, params) {
      const sp = new URLSearchParams();
      sp.set("action", "streamlinecore-api-request");
      sp.set("params", JSON.stringify({ methodName, params }));
      const resp = await fetch(`/wp-admin/admin-ajax.php?${sp.toString()}`, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
      const raw = await resp.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { return { ok: false, reason: "non-JSON response" }; }
      if (json?.status?.code) {
        return { ok: false, reason: `${json.status.code}: ${json.status.description || ""}`.slice(0, 180) };
      }
      return { ok: true, data: json?.data };
    }

    function streamlineWindowAvailable(avail) {
      const begin = String(avail?.range?.beginDate || "").split("/").map((p) => parseInt(p, 10));
      const availability = String(avail?.availability || "");
      const minStay = String(avail?.minStay || "").split(",").map((p) => parseInt(p, 10)).filter(Number.isFinite);
      if (begin.length !== 3 || availability.length === 0) return null;
      const [bm, bd, by] = begin;
      const beginMs = Date.UTC(by, bm - 1, bd, 12, 0, 0);
      const startMs = new Date(`${checkIn}T12:00:00Z`).getTime();
      const endMs = new Date(`${checkOut}T12:00:00Z`).getTime();
      const startIdx = Math.round((startMs - beginMs) / 86400000);
      const endIdx = Math.round((endMs - beginMs) / 86400000);
      if (startIdx < 0 || endIdx > availability.length) return null;
      const window = availability.slice(startIdx, endIdx);
      if (/N/.test(window)) return { available: false, reason: `blocked nights ${window}` };
      const requiredMinStay = minStay[startIdx] || 1;
      if (nights < requiredMinStay) return { available: false, reason: `${requiredMinStay}-night minimum` };
      return { available: true, reason: `calendar open ${window}` };
    }

    async function tryStreamline() {
      if (!/(?:alekonakauai|princevillevacationrentals)\.com$/i.test(host)) return null;
      const html = document.documentElement?.innerHTML ?? "";
      const unitIdMatch =
        html.match(/propertyId\s*=\s*(\d+)/) ||
        html.match(/(?:unit_id|unitId|property_id|propertyId)["'\s:=]+(\d+)/i);
      const unitId = unitIdMatch ? parseInt(unitIdMatch[1], 10) : 0;
      if (!(unitId > 0)) return null;

      const availability = await callStreamline("GetPropertyAvailabilityRawData", {
        unit_id: unitId,
        use_room_type_logic: "no",
        standard_pricing: 1,
      });
      const availabilityState = availability.ok ? streamlineWindowAvailable(availability.data) : null;
      if (availabilityState?.available === false) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Streamline calendar: ${availabilityState.reason} for ${checkIn} → ${checkOut} (unitId=${unitId})`,
        };
      }

      const quote = await callStreamline("GetPreReservationPrice", {
        unit_id: unitId,
        startdate: checkIn,
        enddate: checkOut,
        adults: 2,
        children: 0,
      });
      const total = quote.ok ? parseMoneyAmount(quote.data?.total) : 0;
      if (availabilityState?.available === true && total > 0) {
        return {
          available: "yes",
          nightlyPrice: Math.round(total / nights),
          totalPrice: Math.round(total),
          reason: `Streamline API: $${Math.round(total).toLocaleString()} total for ${nights} nights; ${availabilityState.reason} (unitId=${unitId})`,
        };
      }
      if (total > 0) {
        return {
          available: "unclear",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Streamline API quoted $${Math.round(total).toLocaleString()} but calendar availability was inconclusive for ${checkIn} → ${checkOut} (unitId=${unitId})`,
        };
      }
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `Streamline API returned no usable quote for ${checkIn} → ${checkOut} (unitId=${unitId}${quote.ok ? "" : `; ${quote.reason}`})`,
      };
    }

    function tryBookingCom() {
      if (!/booking\.com$/i.test(host)) return null;
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
      if (/no availability|sold out|not available|unavailable for your dates|no properties found/i.test(text)) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Booking.com page says unavailable for ${checkIn} → ${checkOut}`,
        };
      }
      const reserveBtn = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'))
        .find((el) => {
          const label = [
            el.textContent,
            el.getAttribute?.("aria-label"),
            el.getAttribute?.("title"),
            el.getAttribute?.("value"),
          ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
          const disabled = el.disabled || el.getAttribute?.("aria-disabled") === "true";
          return !disabled && /\b(reserve|select|book now|see availability|choose room)\b/i.test(label);
        });
      const targetBedroomRe = bedroomPhraseRe(bedrooms);
      const rowTexts = Array.from(document.querySelectorAll("[data-block-id], tr, [class*=hprt], [class*=room]"))
        .map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
        .filter((row) => row.length > 20 && row.length < 5000 && /(?:US\$|\$)\s*[\d,]+/.test(row));
      const pricedRows = rowTexts.filter((row) => /\b(select|reserve|room|suite|apartment|villa|nights?|price)\b/i.test(row));
      const targetRows = targetBedroomRe ? pricedRows.filter((row) => targetBedroomRe.test(row)) : pricedRows;
      if (targetBedroomRe && pricedRows.length > 0 && targetRows.length === 0) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Booking.com did not show a priced ${bedrooms}-bedroom room type for ${checkIn} → ${checkOut}`,
        };
      }
      const priceText = (targetRows[0] || pricedRows[0] || text).replace(/\s+/g, " ");
      const perNightMatch =
        priceText.match(/(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)[^\n.]{0,40}(?:per night|nightly)/i) ||
        priceText.match(/(?:per night|nightly)[^\$]{0,40}(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)/i);
      const nightly = perNightMatch ? Math.round(parseMoneyAmount(perNightMatch[1])) : null;
      let total = 0;
      const amounts = Array.from(priceText.matchAll(/(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)/g))
        .map((m) => Math.round(parseMoneyAmount(m[1])))
        .filter((n) => n > 0);
      const minStayTotal = Math.max(250, (nightly && nightly > 0 ? nightly : 50) * nights * 0.6);
      const plausibleTotals = amounts.filter((n) => n >= minStayTotal && (!nightly || Math.abs(n - nightly) > 3));
      if (plausibleTotals.length > 0) total = Math.min(...plausibleTotals);
      if (!(total > 0) && nightly && reserveBtn) total = Math.round(nightly * nights);
      if (total > 0) {
        return {
          available: "yes",
          nightlyPrice: nightly && nightly > 0 ? nightly : Math.round(total / nights),
          totalPrice: Math.round(total),
          reason: `Booking.com detail page quoted $${Math.round(total).toLocaleString()} total for ${nights} nights`,
        };
      }
      if (reserveBtn) {
        return {
          available: "unclear",
          nightlyPrice: null,
          totalPrice: null,
          reason: "Booking.com showed a reserve/select flow but no parseable total price",
        };
      }
      return null;
    }

    async function trySuiteParadise() {
      if (!/suite-paradise\.com$/i.test(host)) return null;
      const html = document.documentElement?.innerHTML ?? "";
      const eidMatch = html.match(/"eid"\s*:\s*"(\d+)"/) || html.match(/(?:^|[^a-zA-Z0-9_])eid\s*:\s*"?(\d+)"?/);
      const eid = eidMatch ? eidMatch[1] : null;
      if (!eid) return null;
      const params = new URLSearchParams({
        "rcav[begin]": toMdYY(checkIn),
        "rcav[end]": toMdYY(checkOut),
        "rcav[adult]": "2",
        "rcav[child]": "0",
        "rcav[eid]": eid,
        "rcav[flex_type]": "d",
      });
      const resp = await fetch(`/rescms/ajax/item/pricing/simple?${params.toString()}`, {
        headers: {
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const raw = await resp.text();
      if (!resp.ok) return null;
      let json = {};
      try { json = JSON.parse(raw); } catch { return null; }
      const content = json?.content ?? "";
      if (/class=["'][^"']*\brc-na\b/i.test(content) || /not available/i.test(content)) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Suite Paradise rcapi: not available for ${checkIn} → ${checkOut} (eid=${eid})`,
        };
      }
      const exact = content.match(/(?:&quot;|")price(?:&quot;|")\s*:\s*([\d.]+)/);
      const rendered = content.match(/class=["'][^"']*\brc-price\b[^>]*>\s*\$\s*([\d,]+(?:\.\d+)?)/);
      const total = exact
        ? parseFloat(exact[1])
        : rendered
        ? parseFloat(rendered[1].replace(/,/g, ""))
        : 0;
      if (Number.isFinite(total) && total > 0) {
        return {
          available: "yes",
          nightlyPrice: Math.round(total / nights),
          totalPrice: Math.round(total),
          reason: `Suite Paradise rcapi: $${Math.round(total).toLocaleString()} total for ${nights} nights (eid=${eid})`,
        };
      }
      return null;
    }

    async function tryVrpMain() {
      const dataEl = document.querySelector("[data-unit-id][data-unit-slug]") || document.querySelector("#unit-data");
      const hiddenUnitEl = document.querySelector('input[name="obj[unit_id]"], input[name*="unit_id" i], input[name*="unitId" i]');
      const pathSlug = (() => {
        const m = window.location.pathname.match(/\/vrp\/unit\/([^/?#]+)/i);
        return m ? decodeURIComponent(m[1]) : null;
      })();
      const unitId =
        dataEl?.getAttribute("data-unit-id") ||
        dataEl?.dataset?.unitId ||
        hiddenUnitEl?.getAttribute("value") ||
        hiddenUnitEl?.value ||
        null;
      const slug =
        dataEl?.getAttribute("data-unit-slug") ||
        dataEl?.dataset?.unitSlug ||
        pathSlug ||
        null;
      if (!unitId || !slug) return null;
      const [ratesResp, bookedResp] = await Promise.all([
        fetch(`/?vrpjax=1&act=getUnitRates&unitId=${encodeURIComponent(unitId)}`, { headers: { Accept: "application/json, text/javascript, */*; q=0.01" } }),
        fetch(`/?vrpjax=1&act=getUnitBookedDates&par=${encodeURIComponent(slug)}`, { headers: { Accept: "application/json, text/javascript, */*; q=0.01" } }),
      ]);
      if (!bookedResp.ok) return null;
      let rates = null;
      let booked = {};
      if (ratesResp.ok) {
        try { rates = await ratesResp.json(); } catch { rates = null; }
      }
      try { booked = await bookedResp.json(); } catch { booked = {}; }

      const bookedSet = new Set(booked.bookedDates || []);
      for (const iso of isoNights) {
        if (bookedSet.has(toMdY(iso))) {
          return {
            available: "no",
            nightlyPrice: null,
            totalPrice: null,
            reason: `VRP calendar: booked night ${iso} for ${checkIn} → ${checkOut}`,
          };
        }
      }
      const checkInMd = toMdY(checkIn);
      if (new Set(booked.noCheckin || []).has(checkInMd)) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `VRP calendar: no check-in allowed on ${checkIn}`,
        };
      }
      let requiredMinLOS = Number(booked.minLOS || 1);
      if (Array.isArray(booked.minNights)) {
        for (const rule of booked.minNights) {
          if (rule?.start && rule?.end && checkIn >= rule.start && checkIn <= rule.end) {
            requiredMinLOS = Math.max(requiredMinLOS, Number(rule.minLOS || 1));
          }
        }
      }
      if (nights < requiredMinLOS) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `VRP calendar: ${requiredMinLOS}-night minimum for ${checkIn}`,
        };
      }
      const quoteParams = new URLSearchParams();
      quoteParams.set("check-availability-arrival-date", displayDate(checkIn));
      quoteParams.set("obj[Arrival]", checkIn);
      quoteParams.set("check-availability-departure-date", displayDate(checkOut));
      quoteParams.set("obj[Departure]", checkOut);
      quoteParams.set("obj[Adults]", "2");
      quoteParams.set("obj[Children]", "0");
      quoteParams.set("obj[Vendor]", "Track");
      quoteParams.set("obj[PropID]", unitId);
      quoteParams.set("obj[v2]", "1");
      const quoteResp = await fetch(`/?vrpjax=1&act=checkavailability&par=1&${quoteParams.toString()}`, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      }).catch(() => null);
      if (quoteResp?.ok) {
        const quoteRaw = await quoteResp.text();
        let quote = null;
        try { quote = JSON.parse(quoteRaw); } catch { quote = null; }
        const totalCost = parseMoneyAmount(quote?.TotalCost ?? quote?.TheTotalCost ?? quote?.TheCost);
        const quoteNights = Number(quote?.nights);
        if (!quote?.Error && totalCost > 0 && (!Number.isFinite(quoteNights) || Math.round(quoteNights) === nights)) {
          const dueToday = parseMoneyAmount(quote?.DueToday);
          return {
            available: "yes",
            nightlyPrice: roundCents(totalCost / nights),
            totalPrice: roundCents(totalCost),
            reason: `VRP checkavailability: $${roundCents(totalCost).toLocaleString()} all-in total for ${nights} nights${dueToday > 0 ? ` ($${roundCents(dueToday).toLocaleString()} due now)` : ""} (unitId=${unitId})`,
          };
        }
      }
      if (!rates || typeof rates !== "object") return null;
      let total = 0;
      let pricedNights = 0;
      for (const iso of isoNights) {
        const amount = parseFloat(String(rates?.[iso]?.amount ?? "0"));
        if (Number.isFinite(amount) && amount > 0) {
          total += amount;
          pricedNights++;
        }
      }
      if (pricedNights >= Math.ceil(nights * 0.8) && total > 0) {
        return {
          available: "unclear",
          nightlyPrice: null,
          totalPrice: null,
          reason: `VRP vrpjax returned base rent only ($${roundCents(total).toLocaleString()}); no all-in quote was available for ${checkIn} → ${checkOut} (unitId=${unitId})`,
        };
      }
      return null;
    }

    try {
      const streamline = await tryStreamline();
      if (streamline) return streamline;
    } catch (e) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `Streamline API parse error: ${String(e?.message || e).slice(0, 120)}`,
      };
    }
    try {
      const booking = tryBookingCom();
      if (booking) return booking;
    } catch (e) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `Booking.com detail parse error: ${String(e?.message || e).slice(0, 120)}`,
      };
    }
    try {
      const sp = await trySuiteParadise();
      if (sp) return sp;
    } catch (e) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `Suite Paradise rcapi error: ${String(e?.message || e).slice(0, 120)}`,
      };
    }
    try {
      const vrp = await tryVrpMain();
      if (vrp) return vrp;
    } catch (e) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: `VRP vrpjax error: ${String(e?.message || e).slice(0, 120)}`,
      };
    }
    return null;
  }, { checkIn, checkOut, bedrooms }).catch(() => null);
  if (platformResult) {
    return withPagePrepReason(attachDetectedBedrooms(platformResult, detectedBedrooms), dismissals, dateEntry);
  }
  const genericResult = await targetPage.evaluate(({ checkIn, checkOut, nights }) => {
    const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
    const parseMoney = (raw) => {
      const n = parseFloat(String(raw || "").replace(/,/g, "").replace(/[^\d.]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const roundCents = (n) => Math.round(n * 100) / 100;
    const NO_PATTERNS = [
      /not available for these dates/i,
      /no availability/i,
      /unavailable for the selected dates/i,
      /sold out/i,
      /these dates are not available/i,
    ];
    for (const re of NO_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        return {
          available: "no",
          nightlyPrice: null,
          totalPrice: null,
          reason: `Page says: "${text.slice(Math.max(0, m.index - 20), m.index + 120)}"`,
        };
      }
    }
    const nativeReserveSelector =
      'button[id*="book" i], button[name*="book" i], button[class*="book" i], a[href*="book" i], input[type="submit"], input[type="button"], [role="button"]';
    const textReserveRe = /\b(reserve|book now|book direct|book online|check availability|check rates|view rates|select dates)\b/i;
    const isDisabled = (el) =>
      el.disabled ||
      el.getAttribute("aria-disabled") === "true" ||
      /\bdisabled\b/i.test(el.getAttribute("class") || "");
    const reserveBtn = Array.from(document.querySelectorAll(nativeReserveSelector))
      .find((el) => {
        if (isDisabled(el)) return false;
        const label = [
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.getAttribute("value"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        return textReserveRe.test(label);
      });
    const perNight = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:\/|per|a\s+)?\s*(?:night|nightly)/i);
    const totalPrice =
      text.match(/total\s+cost\s*:?\s*\$\s*([\d,]+(?:\.\d+)?)/i) ||
      text.match(/total\s+cost[\s\S]{0,80}?\$\s*([\d,]+(?:\.\d+)?)/i) ||
      text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*total/i) ||
      text.match(/total\s*\$\s*([\d,]+(?:\.\d+)?)/i) ||
      text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:including|incl\.?)\s+(?:taxes?\s*(?:&|and)\s*)?fees?/i);
    const totalForStayRe = new RegExp(`\\$\\s*([\\d,]+(?:\\.\\d+)?)\\s*for\\s+${nights}\\s+nights?`, "ig");
    const totalForStayMatches = Array.from(text.matchAll(totalForStayRe));
    const availabilityIdx = text.search(/\byour dates are available\b/i);
    const currentPriceIdx = text.search(/\bcurrent price\b/i);
    const preferredTotalForStay =
      totalForStayMatches.find((m) => availabilityIdx >= 0 && m.index != null && m.index >= availabilityIdx && m.index - availabilityIdx < 700) ||
      totalForStayMatches.find((m) => currentPriceIdx >= 0 && m.index != null && m.index >= currentPriceIdx && m.index - currentPriceIdx < 700) ||
      totalForStayMatches[0] ||
      null;
    const nightlyN = perNight ? roundCents(parseMoney(perNight[1])) : null;
    const totalN = totalPrice
      ? roundCents(parseMoney(totalPrice[1]))
      : preferredTotalForStay
      ? roundCents(parseMoney(preferredTotalForStay[1]))
      : null;
    const nightlyForSelectedStay = preferredTotalForStay && totalN
      ? roundCents(totalN / nights)
      : nightlyN;
    const dateHintVariants = (iso) => {
      const hints = [iso];
      const d = new Date(`${iso}T12:00:00Z`);
      if (Number.isFinite(d.getTime())) {
        const monthShort = d.toLocaleString("en-US", { timeZone: "UTC", month: "short" });
        const monthLong = d.toLocaleString("en-US", { timeZone: "UTC", month: "long" });
        hints.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`);
        hints.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(-2)}`);
        hints.push(`${monthShort} ${d.getUTCDate()}`);
        hints.push(`${monthLong} ${d.getUTCDate()}`);
      }
      return hints;
    };
    const lowerText = text.toLowerCase();
    const hasCheckInSignal = dateHintVariants(checkIn).some((hint) => lowerText.includes(String(hint).toLowerCase()));
    const hasCheckOutSignal = dateHintVariants(checkOut).some((hint) => lowerText.includes(String(hint).toLowerCase()));
    const hasDateSignal = hasCheckInSignal && hasCheckOutSignal;
    const hasAvailableDatesSignal = /\byour dates are available\b/i.test(text);
    const hasDateSpecificPrice = hasDateSignal && (totalN || (reserveBtn && nightlyForSelectedStay) || (hasAvailableDatesSignal && totalN));
    const path = window.location.pathname;
    const pathSegments = path.split("/").filter(Boolean);
    const lastPathSegment = pathSegments[pathSegments.length - 1] || "";
    const collectionText = `${document.title || ""} ${text}`;
    const pathLooksCollection =
      /\/bedrooms?\//i.test(path) ||
      /^(?:search|search-results|properties|rentals?|vacation-rentals?|[a-z0-9-]+-rentals?|[a-z0-9-]+-vacation-rentals?)$/i.test(lastPathSegment);
    const isCollectionSearchPage =
      pathLooksCollection &&
      /\b(?:results?|properties|list view|map view|show filters|clear search|view all .{0,40} rentals)\b/i.test(collectionText);
    if (hasDateSpecificPrice && isCollectionSearchPage) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: "Search-results page showed a date-specific price, but it was not a detail page for the candidate listing",
      };
    }
    if (hasDateSpecificPrice) {
      return {
        available: "yes",
        nightlyPrice: nightlyForSelectedStay,
        totalPrice: totalN ?? (nightlyForSelectedStay ? roundCents(nightlyForSelectedStay * nights) : null),
        reason: reserveBtn
          ? `Reserve/Book button present${nightlyForSelectedStay ? ` ($${nightlyForSelectedStay}/night)` : ""}${totalN ? ` ($${totalN} total)` : ""}`
          : `Visible price${nightlyForSelectedStay ? ` $${nightlyForSelectedStay}/night` : ""}${totalN ? ` $${totalN} total` : ""}`,
      };
    }
    if (reserveBtn || nightlyN || totalN) {
      return {
        available: "unclear",
        nightlyPrice: null,
        totalPrice: null,
        reason: "Page showed a generic book/price signal but no date-specific total for the requested stay",
      };
    }
    return {
      available: "unclear",
      nightlyPrice: null,
      totalPrice: null,
      reason: "Page didn't show a clear availability/price signal — possibly login wall or non-standard PM layout",
    };
  }, { checkIn, checkOut, nights: Math.max(1, Math.round((new Date(`${checkOut}T12:00:00Z`).getTime() - new Date(`${checkIn}T12:00:00Z`).getTime()) / 86400000)) });
  const genericWithBedrooms = attachDetectedBedrooms(genericResult, detectedBedrooms);
  const preparedGeneric = withPagePrepReason(genericWithBedrooms, dismissals, dateEntry);
  const canTrustVrboAutoUpdatedQuote =
    /(?:^|\.)vrbo\.com$/i.test(hostForBedroomDetect)
    && pmDateEntryComplete(dateEntry)
    && Number(preparedGeneric?.totalPrice || 0) > 0
    && /(?:visible price|reserve\/book button present)/i.test(preparedGeneric?.reason || "");
  if (
    preparedGeneric?.available === "yes"
    && !canTrustVrboAutoUpdatedQuote
    && (!pmDateEntryComplete(dateEntry) || !dateEntry?.submitLabel)
  ) {
    return {
      ...preparedGeneric,
      available: "unclear",
      nightlyPrice: null,
      totalPrice: null,
      reason: `Date-specific search was not confirmed by a clicked availability/search submit; ${preparedGeneric.reason}`.slice(0, 800),
    };
  }
  return preparedGeneric;
}

async function ensurePmRentalSearchPage(targetPage, site, label = "pm_site_search") {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const found = await withSoftTimeout(
    targetPage.evaluate(({ baseUrl }) => {
      function clean(raw) {
        return String(raw || "").replace(/\s+/g, " ").trim();
      }
      function sameHost(raw) {
        try {
          const base = new URL(baseUrl);
          const u = new URL(raw, baseUrl);
          return u.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
        } catch {
          return false;
        }
      }
      function looksRentalSearchPage() {
        const href = String(location.href || "").toLowerCase();
        const title = clean(document.title).toLowerCase();
        const body = clean(document.body?.innerText || "").toLowerCase();
        const firstBody = body.slice(0, 22000);
        const siteSearchOnly =
          /\b(?:search results for|enter the terms you wish to search for|site search|search this site)\b/i.test(`${title} ${firstBody}`) &&
          !/\b(?:vacation rentals?|bedrooms?|sleeps?|check[\s_-]*in|arrival|departure|availability|book now|view rates)\b/i.test(firstBody);
        const rentalControls = /\b(?:arrival|departure|check[\s_-]*in|check[\s_-]*out|dates?|availability|bedrooms?|guests?|show filters|search availability|find a property)\b/i.test(firstBody);
        const rentalPath = /\b(?:vacation-rentals?|rentals?|properties|search-results|accommodations|lodging|vrp\/search)\b/i.test(href);
        const listingSignals =
          document.querySelectorAll("a[href*='/vrp/unit/'], a[href*='/vacation-rentals/'], a[href*='/rentals/'], a[href*='/properties/'], [class*='property' i], [class*='rental' i]").length > 2 ||
          /\$\s*[\d,]+|\b(?:bedroom|bedrooms|br|bd)\b/i.test(firstBody);
        const collectionSignal = /\b(?:results?|properties|list view|map view|show filters|clear search|view all .{0,40} rentals|browse all|sort by)\b/i.test(firstBody);
        const detailPath = /\/(?:vrp\/unit|unit|property|properties|vacation-rentals|rentals)\/[^/?#]*(?:\d|unit|condo|villa|home|suite)[^/?#]*$/i.test(href);
        if (detailPath && !collectionSignal) return false;
        return !siteSearchOnly && (rentalControls || (rentalPath && listingSignals && collectionSignal));
      }
      if (looksRentalSearchPage()) return { url: location.href, current: true, reason: "current page looks like rental search" };

      const badRe = /\b(?:property management|owner|owners?|management|about|who we are|blog|news|faq|contact|privacy|terms|login|sign in|favorite|share|deals?|experience|restaurants?|activities?|weddings?|real estate|sales?)\b/i;
      const goodRe = /\b(?:vacation rentals?|rentals?|browse rentals?|find a property|properties|search rentals?|availability|lodging|accommodations?|places to stay|all rentals?)\b/i;
      const pathGoodRe = /\/(?:vacation-rentals?|rentals?|properties|search-results|accommodations?|lodging|vrp\/search)(?:\/|$)/i;
      const candidates = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => {
          const href = a.getAttribute("href") || "";
          let url = "";
          try { url = new URL(href, baseUrl).toString(); } catch { return null; }
          if (!url || !sameHost(url)) return null;
          const text = clean([
            a.textContent,
            a.getAttribute?.("aria-label"),
            a.getAttribute?.("title"),
          ].filter(Boolean).join(" "));
          const path = new URL(url).pathname;
          const hay = `${text} ${path}`.toLowerCase();
          if (badRe.test(hay)) return null;
          let score = 0;
          if (goodRe.test(text)) score += 80;
          if (pathGoodRe.test(path)) score += 70;
          if (/\b(?:search|availability|all|browse|find)\b/i.test(hay)) score += 20;
          if (/\b(?:poipu|kauai|hawaii)\b/i.test(hay)) score += 10;
          if (score <= 0) return null;
          return { url, text: text.slice(0, 80), score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      return candidates[0] ? { ...candidates[0], current: false, reason: "best rental-search link" } : null;
    }, { baseUrl: site.baseUrl || site.searchUrl }),
    4_000,
    null,
  ).catch(() => null);

  if (found?.url && !found.current) {
    log(`${label}: opening rental search page "${found.text || found.url}" (${found.reason})`);
    await targetPage.goto(found.url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await targetPage.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
    await dismissObstructions(targetPage, `${label}_rental_search_page`).catch(() => {});
  }
  return found;
}

function buildPmSearchUrl(site, searchTerm, checkIn, checkOut, bedrooms) {
  const start = site.searchUrl || site.baseUrl;
  try {
    const u = new URL(start);
    for (const [key, value] of [
      ["checkin", checkIn],
      ["checkout", checkOut],
      ["check_in", checkIn],
      ["check_out", checkOut],
      ["arrival", checkIn],
      ["departure", checkOut],
      ["startdate", checkIn],
      ["enddate", checkOut],
      ["bedrooms", String(bedrooms)],
      ["beds", String(bedrooms)],
      ["sleeps", "2"],
    ]) {
      if (!u.searchParams.has(key)) u.searchParams.set(key, value);
    }
    return u.toString();
  } catch {
    return start;
  }
}

async function extractPmSearchSeeds(targetPage, site, searchTerm, bedrooms, limit, expectedNights, bedroomFilterApplied = false) {
  const baseUrl = site.baseUrl;
  return withSoftTimeout(
    targetPage.evaluate(({ baseUrl, searchTerm, bedrooms, limit, expectedNights, bedroomFilterApplied }) => {
      function clean(raw) {
        return String(raw || "").replace(/\s+/g, " ").trim();
      }
      function parseAmount(raw) {
        const n = parseFloat(String(raw || "").replace(/,/g, "").replace(/[^\d.]/g, ""));
        return Number.isFinite(n) ? n : 0;
      }
      function parsePrice(raw) {
        const text = clean(raw);
        const lower = text.toLowerCase();
        const totalMatch =
          text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:total|for\s+\d+\s+nights?)/i) ||
          text.match(/total(?:\s+before\s+taxes)?\s*\$\s*([\d,]+(?:\.\d+)?)/i);
        if (totalMatch) {
          const total = parseAmount(totalMatch[1]);
          if (total > 0) {
            const includesTaxes = /\bincludes?\s+tax(?:es)?\b|\btaxes?\s*(?:and|&)\s*fees?\s*included\b/.test(lower);
            const beforeTaxes = /\bbefore\s+tax(?:es)?\b/.test(lower);
            return {
              totalPrice: Math.round(total),
              nightlyPrice: Math.round(total / expectedNights),
              priceIncludesTaxes: includesTaxes && !beforeTaxes,
              priceIncludesFees: true,
              priceBasis: includesTaxes && !beforeTaxes ? "all_in" : "pre_tax_total",
            };
          }
        }
        // PM search-result grids often show generic "from $X/night" or
        // marketing prices that are not tied to the requested dates. Do not
        // fabricate a stay total from those snippets; detail-page/API
        // verification is the only path allowed to promote a PM row.
        return null;
      }
      function looksLikeRentalSearchPage() {
        const href = String(location.href || "").toLowerCase();
        const title = clean(document.title).toLowerCase();
        const body = clean(document.body?.innerText || "").toLowerCase();
        const firstBody = body.slice(0, 25000);
        const pathSignal = /\b(?:vacation-rentals?|rentals?|properties|search-results|accommodations|lodging|vrp\/search)\b/i.test(href);
        const rentalSignal =
          /\b(?:vacation rentals?|properties|lodging|stays?|availability|check[\s_-]*in|arrival|departure|bedrooms?|sleeps?|guests?|nightly|per night|book now|view rates|show rates)\b/i.test(firstBody);
        const listingSignal =
          document.querySelectorAll("a[href*='/vrp/unit/'], a[href*='/vacation-rentals/'], a[href*='/rentals/'], a[href*='/properties/']").length > 0 ||
          /\$\s*[\d,]+|\b(?:bedroom|bedrooms|br|bd)\b/i.test(firstBody);
        const siteSearchOnly =
          /\b(?:search results for|enter the terms you wish to search for|site search|search this site)\b/i.test(`${title} ${firstBody}`) &&
          !/\b(?:vacation rentals?|bedrooms?|sleeps?|check[\s_-]*in|arrival|departure|availability)\b/i.test(firstBody);
        return (pathSignal || rentalSignal) && listingSignal && !siteSearchOnly;
      }
      function extractBedrooms(raw) {
        const text = clean(raw).toLowerCase();
        const direct = text.match(/\b([1-9])\s*(?:br|bd|bdr|bedrooms?|bed\s*rooms?)\b/);
        if (direct) return parseInt(direct[1], 10);
        const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
        for (const [word, count] of Object.entries(words)) {
          if (new RegExp(`\\b${word}[\\s-]*(?:bedroom|bedrooms|bed\\s*rooms?)\\b`).test(text)) return count;
        }
        return null;
      }
      function sameHost(raw) {
        try {
          const b = new URL(baseUrl);
          const u = new URL(raw, baseUrl);
          return u.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
        } catch {
          return false;
        }
      }
      function looksDetail(raw, text) {
        let u;
        try { u = new URL(raw, baseUrl); } catch { return false; }
        const path = u.pathname.toLowerCase();
        const pathAndQuery = `${path}?${u.searchParams.toString()}`.toLowerCase();
        const segments = path.split("/").filter(Boolean);
        const last = segments[segments.length - 1] || "";
        const searchOrListPage =
          /\/site\/propertylist\b/i.test(path) ||
          /\bpropertylist\b/i.test(path) ||
          /(?:^|\/)(?:search|search-results|availability|property-list|browse-all)(?:\/|$)/i.test(path) ||
          // Real PM unit details often live below collection folders such as
          // /vacation-rentals/<unit-slug>. Treat only the bare collection URL
          // as a listing/search page.
          (segments.length <= 1 && /^(?:properties|rentals?|vacation-rentals?)$/.test(last)) ||
          /\b(?:propertylist|searchresults|search-results|availability|property-list)\b/i.test(pathAndQuery);
        if (searchOrListPage) return false;
        if (path === "/" || /\/(?:search|availability|rentals?|vacation-rentals?|properties|collections?|areas?|locations?)\/?$/.test(path)) return false;
        if (/\/vrp\/unit\//i.test(path)) return true;
        if (/\d/.test(path)) return true;
        if (/\b(unit|condo|villa|home|suite|cottage|bungalow|townhome|property)\b/i.test(path)) return true;
        return /\$\s*[\d,]+|\bbedroom|\bbr\b/i.test(text) && path.split("/").filter(Boolean).length >= 2;
      }
      function imageFrom(card) {
        const img = card.querySelector("img");
        return img?.currentSrc || img?.src || img?.getAttribute("data-src") || undefined;
      }
      const pageText = clean(document.body?.innerText || "");
      const pageTitle = clean(document.title);
      if (looksDetail(location.href, `${pageTitle} ${pageText}`)) {
        const detailBedrooms = extractBedrooms(`${pageTitle} ${pageText}`);
        if (detailBedrooms !== null && detailBedrooms < bedrooms) return [];
        const price = parsePrice(pageText);
        if (!price) return [];
        const canonical = document.querySelector("link[rel='canonical']")?.href || location.href;
        return [{
          url: canonical,
          title: pageTitle || clean(document.querySelector("h1, h2")?.textContent) || "Property manager listing",
          totalPrice: price.totalPrice,
          nightlyPrice: price.nightlyPrice,
          priceIncludesTaxes: price.priceIncludesTaxes,
          priceIncludesFees: price.priceIncludesFees,
          priceBasis: price.priceBasis,
          bedrooms: detailBedrooms ?? bedrooms,
          bedroomSource: detailBedrooms === null ? "search-filter" : "detail-page",
          image: imageFrom(document),
          snippet: pageText.slice(0, 220),
        }];
      }
      if (!looksLikeRentalSearchPage()) return [];
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const out = [];
      const seen = new Set();
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const url = (() => {
          try { return new URL(href, baseUrl).toString(); } catch { return ""; }
        })();
        if (!url || seen.has(url) || !sameHost(url)) continue;
        let card = a;
        for (let depth = 0; depth < 7 && card?.parentElement; depth++) {
          card = card.parentElement;
          const txt = clean(card.textContent);
          if (txt.length > 60 && txt.length < 6000 && (txt.includes("$") || /bedroom|br|bd/i.test(txt) || card.querySelector("img"))) break;
        }
        const fullText = clean(card?.textContent || a.textContent || "");
        if (!looksDetail(url, fullText)) continue;
        const cardBedrooms = extractBedrooms(fullText);
        if (cardBedrooms !== null && cardBedrooms < bedrooms) continue;
        // Do not promote cards solely because the search page appeared to
        // have a bedroom filter. Some PM widgets ignore query/filter state
        // and still show 1BR rows inside a 3BR search; the server auto-fill
        // path needs card-level bedroom proof.
        if (cardBedrooms === null) continue;
        const br = cardBedrooms ?? bedrooms;
        const price = parsePrice(fullText);
        if (!price) continue;
        const title =
          clean(card?.querySelector("h1, h2, h3, [class*='title' i], [data-testid*='title' i]")?.textContent) ||
          clean(a.textContent) ||
          new URL(url).pathname.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ") ||
          "Property manager listing";
        seen.add(url);
        out.push({
          url,
          title: title.slice(0, 100),
          totalPrice: price.totalPrice,
          nightlyPrice: price.nightlyPrice,
          priceIncludesTaxes: price.priceIncludesTaxes,
          priceIncludesFees: price.priceIncludesFees,
          priceBasis: price.priceBasis,
          bedrooms: br,
          bedroomSource: cardBedrooms === null ? "search-filter" : "search-card",
          image: imageFrom(card),
          snippet: fullText.slice(0, 220),
        });
        if (out.length >= limit) break;
      }
      return out;
    }, { baseUrl, searchTerm, bedrooms: Number.parseInt(String(bedrooms ?? ""), 10), limit, expectedNights, bedroomFilterApplied: Boolean(bedroomFilterApplied) }),
    5_000,
    [],
  );
}

async function processPmSiteSearch(id, params) {
  const { sites = [], searchTerm, checkIn, checkOut, bedrooms, perSiteLimit = 3 } = params;
  const maxSitesRaw = Number(params.maxSites ?? sites.length);
  const maxSites = Number.isFinite(maxSitesRaw) && maxSitesRaw > 0
    ? Math.min(sites.length, Math.max(1, Math.round(maxSitesRaw)))
    : sites.length;
  const budgetMs = Number(params.budgetMs ?? PM_SITE_SEARCH_BUDGET_MS);
  const deadline = Date.now() + Math.max(15_000, budgetMs);
  const hasBudget = (reserveMs = 0) => Date.now() + reserveMs < deadline;
  log(`pm_site_search ${id}: ${sites.length} sites (max ${maxSites}) searchTerm="${searchTerm}" ${checkIn}→${checkOut} ${bedrooms}BR budget=${budgetMs}ms`);
  await ensureBrowser();
  const out = [];
  const tabs = new Set();
  const selectedSites = sites.slice(0, maxSites);
  const concurrency = Math.min(PM_SITE_SEARCH_TAB_CONCURRENCY, selectedSites.length);
  log(`pm_site_search ${id}: running up to ${concurrency} PM site tab(s) in parallel`);
  await mapWithConcurrency(selectedSites, concurrency, async (site) => {
    if (!hasBudget(8_000)) {
      log(`pm_site_search ${id}: stopping before ${site.label}; budget nearly exhausted`);
      return;
    }
    let tab = null;
    try {
      if (!site.searchUrl) {
        log(`pm_site_search ${id}: ${site.label} skipped; no rental search URL configured`);
        return;
      }
      await sendHeartbeat(`PM websites: opening ${site.label}`, true, id);
      tab = await context.newPage();
      tabs.add(tab);
      await normalizePageDisplay(tab);
      const url = buildPmSearchUrl(site, searchTerm, checkIn, checkOut, bedrooms);
      await tab.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
      await tab.waitForTimeout(PAGE_SETTLE_MS);
      await dismissObstructions(tab, `pm_site_search_${site.label}`);
      await sendHeartbeat(`PM websites: finding rental search on ${site.label}`, true, id);
      await ensurePmRentalSearchPage(tab, site, `pm_site_search_${site.label}`);
      await sendHeartbeat(`PM websites: entering dates on ${site.label}`, true, id);
      await fillPmRentalLocationField(tab, searchTerm, `pm_site_search_${site.label}`).catch(() => null);
      const dateEntry = await applyPmDateInputs(tab, checkIn, checkOut).catch(() => null);
      const bedroomFilled = await fillBedroomFilter(tab, bedrooms, `pm_site_search_${site.label}`).catch(() => null);
      if (bedroomFilled || !dateEntry?.submitLabel) {
        await sendHeartbeat(`PM websites: submitting ${site.label}`, true, id);
        await clickPmRentalSearchSubmit(tab, `pm_site_search_${site.label}`).catch(() => null);
      }
      await withSoftTimeout(tab.waitForLoadState("networkidle", { timeout: 5_000 }), 5_500);
      await tab.waitForTimeout(PAGE_SETTLE_MS);
      await sendHeartbeat(`PM websites: reading results from ${site.label}`, true, id);
      const bedroomFilterApplied = Boolean(bedroomFilled) || /(?:bedrooms?|beds?)=\d/i.test(String(url));
      const cards = await extractPmSearchSeeds(tab, site, searchTerm, bedrooms, perSiteLimit, nightsBetween(checkIn, checkOut), bedroomFilterApplied);
      log(`pm_site_search ${id}: ${site.label} priced result cards=${cards.length}`);
      const siteOut = [];
      for (const card of cards) {
        const total = Number(card.totalPrice || 0);
        const nightly = Number(card.nightlyPrice || (total > 0 ? Math.round(total / nightsBetween(checkIn, checkOut)) : 0));
        if (!(total > 0) && !(nightly > 0)) continue;
        siteOut.push({
          url: card.url,
          title: card.title,
          sourceLabel: site.label,
          totalPrice: Math.round(total > 0 ? total : nightly * nightsBetween(checkIn, checkOut)),
          nightlyPrice: Math.round(nightly > 0 ? nightly : total / nightsBetween(checkIn, checkOut)),
          bedrooms: card.bedrooms,
          bedroomSource: card.bedroomSource,
          priceIncludesTaxes: card.priceIncludesTaxes,
          priceIncludesFees: card.priceIncludesFees,
          priceBasis: card.priceBasis,
          image: card.image,
          snippet: `${site.label} rental search result · ${card.snippet || ""}`.slice(0, 360),
        });
      }
      out.push(...siteOut);
    } catch (e) {
      log(`pm_site_search ${id}: ${site?.label ?? "site"} error: ${e?.message ?? e}`);
    } finally {
      if (tab && !tab.isClosed?.()) await tab.close().catch(() => {});
    }
  });
  await Promise.all(Array.from(tabs).map(async (tab) => {
    try { if (tab && !tab.isClosed?.()) await tab.close(); } catch {}
  }));
  log(`pm_site_search ${id}: ${out.length} priced website-search candidates`);
  await postResult(id, dedupeCandidatesByUrl(out));
}

async function processPmUrlCheck(id, params) {
  const { url, checkIn, checkOut, bedrooms } = params;
  log(`pm_url_check ${id}: ${url} ${checkIn}→${checkOut}`);
  await ensureBrowser();
  const result = await scrapePmUrl(page, url, checkIn, checkOut, bedrooms ?? null);
  await dumpPageState("pm", { id, ...params });
  log(`pm_url_check ${id}: available=${result.available} price=${result.nightlyPrice}/n`);
  await postResult(id, result);
}

// ─────────────────────── PM URL availability check (BATCH) ─────────
// Open one fresh tab per URL, scrape concurrently, close each. Total
// wall time ≈ slowest single check, not sum. Capped at 5 to keep
// Chrome happy and to bound the per-request budget.
async function processPmUrlCheckBatch(id, params) {
  const { urls, checkIn, checkOut, bedrooms } = params;
  log(`pm_url_check_batch ${id}: ${urls.length} urls ${checkIn}→${checkOut}`);
  await ensureBrowser();
  const cap = Math.min(urls.length, PM_URL_CHECK_BATCH_CONCURRENCY);
  const slice = urls.slice(0, cap);
  const tabs = new Set();
  const results = await mapWithConcurrency(
    slice,
    Math.min(PM_URL_CHECK_BATCH_CONCURRENCY, slice.length),
    async (url) => {
      let tab = null;
      try {
        tab = await context.newPage();
        tabs.add(tab);
        const r = await scrapePmUrl(tab, url, checkIn, checkOut, bedrooms ?? null);
        return { url, ...r };
      } catch (e) {
        return {
          url,
          available: "unclear",
          nightlyPrice: null,
          totalPrice: null,
          reason: `tab error: ${e?.message ?? String(e)}`.slice(0, 200),
        };
      }
    },
  );
  await Promise.all(Array.from(tabs).map(async (tab) => {
    try { if (tab && !tab.isClosed?.()) await tab.close(); } catch {}
  }));
  log(
    `pm_url_check_batch ${id}: yes=${results.filter((r) => r.available === "yes").length} no=${results.filter((r) => r.available === "no").length} unclear=${results.filter((r) => r.available === "unclear").length}`,
  );
  await postResult(id, results);
}

// ─────────────────────── Dispatcher ─────────────────────────────────
async function processRequest(req) {
  // Backward compat: if req.opType is missing (server hasn't deployed
  // yet OR a very old daemon talking to a new server somehow), the
  // request is the legacy vrbo-only shape.
  const opType = req.opType ?? "vrbo_search";
  const params = req.params ?? {
    destination: req.destination,
    checkIn: req.checkIn,
    checkOut: req.checkOut,
    bedrooms: req.bedrooms,
  };

  const runtimeRequest = {
    id: req.id,
    opType,
    requestAttempt: req.requestAttempt ?? 0,
    vrboFreshAttempt: req.vrboFreshAttempt ?? 0,
    freshSessionReason: req.freshSessionReason,
  };

  // Acquire the browser at the request boundary so the worker pool can
  // spread jobs across either configured CDP/noVNC sidecars or the
  // no-window local headless fallback.
  try {
    activeRuntimeRequest = runtimeRequest;
    if (!USE_HEADLESS_LOCAL_BROWSER) {
      await acquireChromeForRequest(runtimeRequest);
    }
    await ensureBrowser();
  } catch (e) {
    activeRuntimeRequest = null;
    throw e;
  }
  const stopScreenHeartbeat = startScreenHeartbeat({ ...req, opType });

  try {
    // PR #307: clear the daemon page between ops so each scrape starts
    // from a known blank state — no carryover from the previous scrape's
    // modals, observers, timers, or scroll position. The batch op
    // (pm_url_check_batch) opens its own per-URL tabs and closes them
    // in finally, so it's already isolated; skip the reset for it to
    // avoid an extra navigation on the daemon-owned page that the
    // batch isn't going to use.
    if (opType !== "pm_url_check_batch") {
      await resetPage();
    }
    await postScreenSnapshot({ ...req, opType }, page, `ready ${opType}`, { force: true });

    switch (opType) {
      case "airbnb_search": return await processAirbnbSearch(req.id, params);
      case "vrbo_search": return await processVrboSearch(req.id, params);
      case "vrbo_photo_scrape": return await processVrboPhotoScrape(req.id, params);
      case "booking_search": return await processBookingSearch(req.id, params);
      case "google_serp": return await processGoogleSerp(req.id, params);
      case "pm_site_search": return await processPmSiteSearch(req.id, params);
      case "pm_url_check": return await processPmUrlCheck(req.id, params);
      case "pm_url_check_batch": return await processPmUrlCheckBatch(req.id, params);
      default: throw new Error(`unknown opType: ${opType}`);
    }
  } finally {
    activeRuntimeRequest = null;
    stopScreenHeartbeat();
    await closeExtraTabs(`after ${opType}`, page).catch(() => {});
    await showCompletePage(opType);
    await clearScreenSnapshot({ ...req, opType }).catch(() => {});
    if (activeChromeAllocation?.ephemeral) {
      await teardownBrowser(`finished ${activeChromeAllocation.type}-side ${opType}`);
    } else if (usingHeadlessRuntime() && USE_SERVER_BROWSER) {
      // Server mode should retry the noVNC/residential-proxy pool on
      // the next request. If this op had to fall back to local
      // headless, close it after the op instead of pinning this worker
      // to fallback mode forever.
      await teardownBrowser(`finished local headless fallback for ${opType}`);
    } else if (usingHeadlessRuntime()) {
      // Keep the persistent headless profile open in this worker for
      // cookies/session continuity and fast follow-up queue items. It
      // has no desktop window, and screenshots continue to stream to
      // the dashboard from postScreenSnapshot().
    } else {
      // Keep a non-ephemeral local Chrome allocation pinned to this
      // worker process. Releasing the lock while keeping the CDP
      // connection open lets another worker claim the same Chrome, or
      // lets this worker claim a different Chrome while still reusing
      // the old browser object. That makes parallel scans serialize or
      // cross streams. The allocation heartbeat is cheap, and the
      // supervisor starts one worker per local Chrome slot.
      await verifyActiveChromeHealth(`finished ${opType}`).catch((e) => {
        log(`local Chrome health after ${opType} failed: ${e?.message ?? e}`);
        return teardownBrowser(`unhealthy after ${opType}`);
      });
    }
  }
}

// ─────────────────────── Tick / main loop ───────────────────────────
let consecutiveErrors = 0;

function isVrboBrowserOp(opType) {
  return opType === "vrbo_search" || opType === "vrbo_photo_scrape";
}

// Returns true if a request was processed (so the main loop knows to
// poll again immediately rather than sleeping POLL_IDLE_MS — that
// way back-to-back requests don't each pay the 60s polling interval
// as latency. Critical for find-buy-in's pre-verify pass which fires
// 3+ pm_url_check requests in quick succession; without busy-loop
// the operator's wallet budget expires before the daemon gets to
// the second URL.)
async function tick() {
  // Pull the latest cookies the extension pushed, before claiming
  // work. Fast no-op when nothing changed (server returns same
  // fingerprint, we skip reseed).
  await syncRemoteCookies();

  let req = null;
  try {
    // Server-backed workers are overflow consumers. Give the local
    // Mac worker first claim on fresh queue items; if it is busy or
    // offline, the request will still be pending after this short
    // delay and a server worker can take it.
    if (WORKER_ROLE === "server" && SERVER_WORKER_CLAIM_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, SERVER_WORKER_CLAIM_DELAY_MS));
    }
    req = await pollNext();
  } catch (e) {
    consecutiveErrors++;
    log(`poll error (${consecutiveErrors}): ${e.message}`);
    if (consecutiveErrors >= 3) await new Promise((r) => setTimeout(r, POLL_IDLE_MS * 2));
    return false;
  }
  if (!req) {
    consecutiveErrors = 0;
    return false;
  }
  const startedAt = Date.now();
  const stopBusyHeartbeat = startBusyHeartbeat(req.opType ?? "request", req.id);
  try {
    let lastError = null;
    const isVrboOp = isVrboBrowserOp(req.opType ?? "vrbo_search");
    const maxAttempts = Math.max(1, REQUEST_MAX_ATTEMPTS);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        throwIfRequestCancelled(req.id);
        if (attempt > 1) {
          const backoff = REQUEST_RETRY_BASE_MS * Math.pow(2, attempt - 2);
          log(`retrying ${req.id} (${req.opType}) attempt ${attempt}/${maxAttempts} after ${backoff}ms`);
          await sleep(backoff);
          throwIfRequestCancelled(req.id);
        }
        req.requestAttempt = attempt - 1;
        await runWithHardTimeout(`request ${req.id} ${req.opType ?? "request"}`, req.opType ?? "request", () => processRequest(req));
        throwIfRequestCancelled(req.id);
        lastError = null;
        break;
      } catch (e) {
        if (e instanceof SidecarCancelledError || cancelledRequestIds.has(req.id)) {
          lastError = e instanceof SidecarCancelledError ? e : new SidecarCancelledError(req.id);
          log(`attempt ${attempt}/${maxAttempts} stopped for ${req.id}: ${lastError.message}`);
          await teardownBrowser("request cancelled during retry").catch(() => {});
          break;
        }
        lastError = e;
        const providerTunnelProxyFailure =
          isVrboOp &&
          isProviderTunnelProxyError(e);
        if (providerTunnelProxyFailure) {
          lastError = new VrboHardBlockError("VRBO provider proxy tunnel failed; provider run stopped and retry is rate-limited until later", {
            url: req.url,
            title: "VRBO proxy tunnel failure",
            excerpt: String(e?.message ?? e).slice(0, 500),
            proxyTunnel: true,
            retryLater: true,
          });
        }
        const transientRetry = !providerTunnelProxyFailure && attempt < maxAttempts && isTransientScrapeError(e);
        const canRetry = transientRetry;
        if (e instanceof VrboHardBlockError && isVrboOp) {
          lastError = new VrboHardBlockError(
            "VRBO CAPTCHA/block page detected; provider run stopped cleanly and retry is rate-limited until later. Original VRBO URL remains available in the search diagnostics/manual verification links.",
            e.details ?? {},
          );
        }
        log(
          `attempt ${attempt}/${maxAttempts} failed for ${req.id}: ${lastError?.message ?? e?.message ?? e}` +
          (transientRetry ? " (transient; will retry)" : ""),
        );
        await teardownBrowser(
          canRetry
              ? "retry after transient failure"
              : "request failure cleanup",
        ).catch(() => {});
        if (!canRetry) break;
      }
    }
    if (lastError) throw lastError;
    consecutiveErrors = 0;
    log(`done ${req.id} in ${Date.now() - startedAt}ms`);
    return true;
  } catch (e) {
    if (e instanceof SidecarCancelledError) {
      log(`cancelled ${req.id} in ${Date.now() - startedAt}ms`);
    } else {
      log(`process error for ${req.id}: ${e.message}`);
    }
    if (e instanceof ProviderBrowserUnavailableError) {
      await postScreenSnapshot(
        { ...req, opType: req.opType ?? "request" },
        page,
        "provider proxy unavailable",
        { error: e.message, force: true },
      ).catch(() => {});
    }
    try { await postResult(req.id, undefined, e.message ?? String(e)); } catch {}
    if (e instanceof SidecarHardTimeoutError) {
      log(`hard timeout for ${req.id}; exiting worker so supervisor restarts a clean process`);
      setTimeout(() => process.exit(2), 250).unref?.();
    }
    if (/closed|disconnected|protocol|target/i.test(e.message ?? "")) {
      await teardownBrowser("error suggests CDP died");
    }
    return true; // we DID process (even if it errored) — keep busy-looping
  } finally {
    stopBusyHeartbeat();
    try {
      await sendHeartbeat(`finish ${req.opType ?? "request"}`, true, req.id);
    } catch (e) {
      if (!(e instanceof SidecarCancelledError)) throw e;
    }
    forgetRequestCancelled(req.id);
  }
}

async function main() {
  log(`starting (server=${SERVER}, admin-secret=${ADMIN_SECRET ? "set" : "none"})`);
  log(`worker slot: ${WORKER_SLOT}; Chrome primary: ${CHROME_PRIMARY}; worker role: ${WORKER_ROLE}; browser mode: ${SIDECAR_BROWSER_MODE}`);
  log(`Chrome binary: ${process.env.LOCAL_CHROME_BINARY ?? CHROME_BINARY}`);
  log(`Chrome user-data-dir: ${process.env.LOCAL_CHROME_USER_DATA_DIR ?? CHROME_DATA_DIR}`);
  if (USE_HEADLESS_LOCAL_BROWSER) {
    log("local macOS Chrome warmup skipped; using no-window local headless browser mode");
  } else if (USE_SERVER_BROWSER) {
    log("local macOS Chrome warmup skipped; preferring server Chrome/noVNC with residential proxy");
  } else if (WORKER_SLOT === "1") {
    try {
      if (process.env.SIDECAR_WARM_ALL_LOCAL_CHROME !== "0") {
        await chromeSidecarManager.warmAllLocal();
      } else {
        await chromeSidecarManager.warmPrimaryLocal();
      }
    } catch (e) {
      log(`local Chrome warmup skipped: ${e.message}`);
    }
  } else {
    log("local Chrome warmup skipped on non-primary worker slot");
  }
  process.on("SIGINT", async () => { await teardownBrowser("SIGINT"); process.exit(0); });
  process.on("SIGTERM", async () => { await teardownBrowser("SIGTERM"); process.exit(0); });
  while (true) {
    const wasBusy = await tick();
    // After a busy tick, only wait POLL_BUSY_MS (default 2s) before
    // polling again — find-buy-in often fires several requests in
    // close succession (e.g. pre-verifying 3-6 PM URLs) and the
    // operator's wallet budget can't absorb 60s × N idle waits.
    // After an idle tick (queue empty), wait the full POLL_IDLE_MS
    // (default 1s) so find-buy-in doesn't spend its server budget
    // waiting for the daemon to notice fresh work.
    await new Promise((r) => setTimeout(r, wasBusy ? POLL_BUSY_MS : POLL_IDLE_MS));
  }
}

main().catch((e) => {
  log(`fatal: ${e.message ?? String(e)}`);
  process.exit(1);
});
