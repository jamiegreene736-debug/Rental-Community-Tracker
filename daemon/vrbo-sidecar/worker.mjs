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
import { spawn, execFile } from "child_process";
import { ChromeSidecarManager } from "./chrome-sidecar-manager.mjs";
import { resolveChromeProxyConfig, runChromeProxyStartupPreflight } from "./proxy-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = path.join(__dirname, "cookies.json");
// Env-gated diagnostics: when enabled, dump raw VRBO GraphQL request/response
// payloads so we can inspect the live schema (operation names, listing array
// keys, pagination cursor/offset fields) and repair parsing when VRBO changes.
const VRBO_GRAPHQL_DUMP_ENABLED = process.env.SIDECAR_VRBO_GRAPHQL_DUMP === "1";
const VRBO_GRAPHQL_DUMP_DIR = path.join(__dirname, "graphql-dumps");
let __vrboGraphqlDumpCount = 0;
function dumpVrboGraphqlArtifact(kind, id, data) {
  if (!VRBO_GRAPHQL_DUMP_ENABLED) return;
  try {
    if (__vrboGraphqlDumpCount === 0) fs.mkdirSync(VRBO_GRAPHQL_DUMP_DIR, { recursive: true });
    if (__vrboGraphqlDumpCount >= 120) return;
    __vrboGraphqlDumpCount += 1;
    const safeId = String(id || "unknown").replace(/[^a-z0-9]/gi, "").slice(0, 16);
    const file = path.join(
      VRBO_GRAPHQL_DUMP_DIR,
      `${Date.now()}-${safeId}-${kind}-${__vrboGraphqlDumpCount}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Diagnostics must never break a live scrape.
  }
}
const CHROME_DATA_DIR = path.join(
  os.homedir(),
  "Library/Application Support/VrboSidecar-Chrome",
);
const CHROME_BINARY = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9222;
const DEFAULT_VIEWPORT = { width: 1600, height: 1000 };
function parseViewportSize(value, fallback = DEFAULT_VIEWPORT) {
  const [widthRaw, heightRaw] = String(value ?? "").split(",").map((part) => Number(part.trim()));
  return {
    width: Number.isFinite(widthRaw) && widthRaw >= 1200 ? Math.round(widthRaw) : fallback.width,
    height: Number.isFinite(heightRaw) && heightRaw >= 800 ? Math.round(heightRaw) : fallback.height,
  };
}
const VIEWPORT = parseViewportSize(process.env.SIDECAR_VIEWPORT_SIZE ?? process.env.SIDECAR_PLAYWRIGHT_VIEWPORT);
const SIDE_CAR_CHROME_VISIBLE = process.env.SIDECAR_CHROME_VISIBLE === "1";
const SIDECAR_ALLOW_FOCUS = process.env.SIDECAR_ALLOW_FOCUS === "1";
const SIDECAR_IDLE_CHROME_RESET_ENABLED = process.env.SIDECAR_IDLE_CHROME_RESET_ENABLED === "1";
const SIDECAR_WARM_LOCAL_CHROME_ON_STARTUP = process.env.SIDECAR_WARM_LOCAL_CHROME_ON_STARTUP === "1" || process.env.SIDECAR_WARM_ALL_LOCAL_CHROME === "1";
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

// ── macOS focus guard ────────────────────────────────────────────────────
// In hidden/offscreen mode Chrome still momentarily ACTIVATES when macOS first
// creates its window (launch + first page), which knocks the operator's
// foreground app (Safari, Claude, …) out of focus — and macOS does NOT hand
// focus back, so they have to re-click the app in the Dock. We capture the
// operator's frontmost app right before we risk launching/activating Chrome,
// then re-activate it immediately afterward so they never lose their place.
// `lsappinfo` (read) + `open -b` (activate) need NO Accessibility/Automation
// (TCC) permission — essential for a launchd background daemon. No-op in visible
// mode (operator wants to see it) and off macOS. Gated by SIDECAR_RETURN_FOCUS
// (default on) so it can be disabled without a code change.
const SIDECAR_RETURN_FOCUS = process.env.SIDECAR_RETURN_FOCUS !== "0";
// Auto-minimize / push-offscreen the sidecar Chrome window after each CDP
// page-create. On some macOS setups the page-create (which activates Chrome)
// fighting with this minimize makes Chrome visibly flap open/closed in a loop.
// Set SIDECAR_AUTO_MINIMIZE=0 to turn it off entirely — Chrome then just takes
// focus once and stays put (operator clicks their app back). No-op in visible
// mode and off macOS regardless.
const SIDECAR_AUTO_MINIMIZE = process.env.SIDECAR_AUTO_MINIMIZE !== "0";
const FOCUS_GUARD_CHROME_BUNDLE_IDS = new Set([
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "com.google.Chrome.beta",
  "com.google.Chrome.dev",
  "org.chromium.Chromium",
]);
let lastUserAppBundleId = null;
function focusGuardActive() {
  return process.platform === "darwin" && SIDECAR_RETURN_FOCUS && !SIDE_CAR_CHROME_VISIBLE;
}
function execFileCapture(cmd, args, timeoutMs = 1200) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? "" : String(stdout ?? "")));
    } catch {
      resolve("");
    }
  });
}
async function captureFrontmostUserApp() {
  if (!focusGuardActive()) return;
  try {
    const asn = (await execFileCapture("lsappinfo", ["front"])).trim();
    if (!asn) return;
    const out = await execFileCapture("lsappinfo", ["info", "-only", "bundleid", asn]);
    const m = out.match(/"CFBundleIdentifier"\s*=\s*"([^"]+)"/) || out.match(/=\s*"([^"]+)"/);
    const bid = m ? m[1].trim() : "";
    // Keep the last NON-Chrome app even when Chrome is frontmost now, so a prior
    // sidecar job can't erase the operator's real app.
    if (bid && !FOCUS_GUARD_CHROME_BUNDLE_IDS.has(bid)) lastUserAppBundleId = bid;
  } catch {
    // best effort
  }
}
function returnFocusToUserApp() {
  if (!focusGuardActive()) return;
  const bid = lastUserAppBundleId;
  if (!bid || FOCUS_GUARD_CHROME_BUNDLE_IDS.has(bid)) return;
  try {
    const p = spawn("open", ["-b", bid], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref?.();
  } catch {
    // best effort
  }
}
function scheduleReturnFocus() {
  if (!focusGuardActive()) return;
  // Re-fire across a short window because the activation can land at slightly
  // different moments (launch vs. first CDP page create vs. window restore).
  for (const delay of [100, 350, 750, 1400]) {
    const t = setTimeout(returnFocusToUserApp, delay);
    t.unref?.();
  }
}

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
const OTA_SEARCH_HARD_TIMEOUT_MS = Number(process.env.SIDECAR_OTA_SEARCH_HARD_TIMEOUT_MS ?? 20 * 60_000);
const REQUEST_MAX_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.SIDECAR_REQUEST_MAX_ATTEMPTS ?? 2) || 2));
const REQUEST_RETRY_BASE_MS = Math.max(250, Number(process.env.SIDECAR_REQUEST_RETRY_BASE_MS ?? 1_500) || 1_500);
const VRBO_MANUAL_VERIFICATION_ENABLED = process.env.SIDECAR_VRBO_MANUAL_VERIFICATION !== "0";
const VRBO_MANUAL_VERIFICATION_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.SIDECAR_VRBO_MANUAL_VERIFICATION_TIMEOUT_MS ?? 8 * 60_000) || 8 * 60_000,
);
const VRBO_MANUAL_VERIFICATION_POLL_MS = Math.max(
  1_000,
  Number(process.env.SIDECAR_VRBO_MANUAL_VERIFICATION_POLL_MS ?? 2_000) || 2_000,
);
const VRBO_MANUAL_SESSION_TTL_MS = Math.max(
  5 * 60_000,
  Number(process.env.SIDECAR_VRBO_MANUAL_SESSION_TTL_MS ?? 48 * 60 * 60_000) || 48 * 60 * 60_000,
);
const VRBO_REUSE_MANUAL_SESSION = process.env.SIDECAR_VRBO_REUSE_MANUAL_SESSION !== "0";
const VRBO_MANUAL_SESSION_STATE_PATH = process.env.SIDECAR_VRBO_MANUAL_SESSION_STATE_PATH ||
  path.join(os.tmpdir(), `rct-vrbo-manual-session-${WORKER_SLOT}.json`);
const CLEAR_OTA_STORAGE_BETWEEN_RUNS = process.env.SIDECAR_CLEAR_OTA_STORAGE_BETWEEN_RUNS === "1";
const FORCE_FRESH_OTA_IDENTITY = process.env.SIDECAR_FORCE_FRESH_OTA_IDENTITY === "1";
const OTA_SUGGESTION_MAX = Math.max(1, Math.min(12, Math.floor(Number(process.env.SIDECAR_OTA_SUGGESTION_MAX ?? 8) || 8)));
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
let lastObservedQueueControlGeneration = null;
let pendingIdleChromeReset = false;
let lastObservedWindowState = null;
let lastViewportWarningAt = 0;
let lastVrboChallengeAlertAt = 0;

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

function needsFreshIdentityForOp(opType) {
  return FORCE_FRESH_OTA_IDENTITY && /^(airbnb|booking|vrbo)_/i.test(String(opType || ""));
}

function keepVisibleLocalChromeGrid() {
  return SIDE_CAR_CHROME_VISIBLE && !USE_HEADLESS_LOCAL_BROWSER && !USE_SERVER_BROWSER && CHROME_PRIMARY === "local";
}

async function surfaceVisibleOtaSearchWindow(targetPage = page, label = "sidecar", id = "") {
  if (!keepVisibleLocalChromeGrid()) return false;
  return snapSidecarWindowToGrid(targetPage, { focus: false, label, id }).catch(() => false);
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
  return replaceOrAppendProxyOption(
    replaceOrAppendProxyOption(username, "country", REQUIRED_PROXY_COUNTRY),
    "session",
    headlessProxySessionId(),
  );
}

async function headlessProxyConfig() {
  if (!HEADLESS_PROXY_ENABLED) return null;
  if (!activeRequestShouldUseHeadlessProxy()) return null;

  return resolveChromeProxyConfig({
    enabled: boolFromEnv("CHROME_PROXY_ENABLED", false),
    sessionId: { instance: { name: `worker-${WORKER_SLOT}` }, request: activeRuntimeRequest },
    brightDataUsernameOptions: (username) => appendBrightDataUsernameOptions(username),
    incompleteConfigMessage:
      "SIDECAR_HEADLESS_PROXY_ENABLED=1 but proxy config is incomplete. Set CHROME_PROXY_HOST, CHROME_PROXY_PORT, CHROME_PROXY_USERNAME, and CHROME_PROXY_PASSWORD, or set CHROME_PROXY_PROVIDER=gonzoproxy with GONZOPROXY_API_KEY.",
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
    case "airbnb_search":
    case "vrbo_search":
    case "booking_search":
      return Math.max(REQUEST_HARD_TIMEOUT_MS, OTA_SEARCH_HARD_TIMEOUT_MS);
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

function gridWindowPositionForWorker() {
  const slotIndex = Math.max(0, Math.floor(Number(WORKER_SLOT) || 1) - 1);
  const explicitPositions = String(process.env.SIDECAR_CHROME_VISIBLE_POSITIONS ?? "")
    .split(/[;|]/)
    .map((part) => parseWindowPosition(part, null))
    .filter(Boolean);
  if (explicitPositions[slotIndex]) return explicitPositions[slotIndex];
  const origin = parseWindowPosition(process.env.SIDECAR_CHROME_VISIBLE_GRID_ORIGIN ?? VISIBLE_WINDOW_POSITION, { left: 120, top: 80 });
  const columns = Math.max(1, Math.floor(Number(process.env.SIDECAR_CHROME_VISIBLE_GRID_COLUMNS ?? 4) || 4));
  const gapX = Math.max(0, Math.floor(Number(process.env.SIDECAR_CHROME_VISIBLE_GRID_GAP_X ?? 24) || 0));
  const gapY = Math.max(0, Math.floor(Number(process.env.SIDECAR_CHROME_VISIBLE_GRID_GAP_Y ?? 36) || 0));
  return {
    left: origin.left + (slotIndex % columns) * (VISIBLE_WINDOW_SIZE.width + gapX),
    top: origin.top + Math.floor(slotIndex / columns) * (VISIBLE_WINDOW_SIZE.height + gapY),
  };
}

async function nearFullscreenWindowBounds(targetPage = page) {
  const fallback = {
    left: 40,
    top: 40,
    width: Math.max(VIEWPORT.width, 1320),
    height: Math.max(VIEWPORT.height + 80, 880),
  };
  if (process.env.SIDECAR_CAPTCHA_WINDOW_BOUNDS) {
    const [leftRaw, topRaw, widthRaw, heightRaw] = String(process.env.SIDECAR_CAPTCHA_WINDOW_BOUNDS).split(",").map((part) => Number(part.trim()));
    if ([leftRaw, topRaw, widthRaw, heightRaw].every(Number.isFinite) && widthRaw > 0 && heightRaw > 0) {
      return {
        left: Math.round(leftRaw),
        top: Math.round(topRaw),
        width: Math.round(widthRaw),
        height: Math.round(heightRaw),
      };
    }
  }
  const screenBounds = await targetPage?.evaluate?.(() => ({
    left: Math.max(0, Math.round(window.screen?.availLeft ?? 0)),
    top: Math.max(0, Math.round(window.screen?.availTop ?? 0)),
    width: Math.round(window.screen?.availWidth ?? 0),
    height: Math.round(window.screen?.availHeight ?? 0),
  })).catch(() => null);
  if (screenBounds?.width > 600 && screenBounds?.height > 500) {
    const margin = Math.max(0, Math.floor(Number(process.env.SIDECAR_CAPTCHA_WINDOW_MARGIN ?? 36) || 36));
    return {
      left: screenBounds.left + margin,
      top: screenBounds.top + margin,
      width: Math.max(600, screenBounds.width - margin * 2),
      height: Math.max(500, screenBounds.height - margin * 2),
    };
  }
  return fallback;
}

function playVrboChallengeAlertSound(label = "vrbo", id = "") {
  if (process.env.SIDECAR_VRBO_ALERT_SOUND === "0") return;
  if (!/^vrbo/i.test(String(label || ""))) return;
  const now = Date.now();
  const minGapMs = Math.max(1_000, Number(process.env.SIDECAR_VRBO_ALERT_SOUND_MIN_GAP_MS ?? 10_000) || 10_000);
  if (now - lastVrboChallengeAlertAt < minGapMs) return;
  lastVrboChallengeAlertAt = now;

  try {
    const soundPath = process.env.SIDECAR_VRBO_ALERT_SOUND_PATH || "/System/Library/Sounds/Submarine.aiff";
    const child = fs.existsSync(soundPath)
      ? spawn("afplay", [soundPath], { detached: true, stdio: "ignore" })
      : spawn("osascript", ["-e", "beep 2"], { detached: true, stdio: "ignore" });
    child.unref?.();
    log(`${label} ${id}: played VRBO challenge alert sound`);
  } catch (e) {
    log(`${label} ${id}: VRBO challenge alert sound skipped: ${e?.message ?? e}`);
  }
}

async function setVrboChallengeHighlight(targetPage = page, enabled = true, label = "vrbo", id = "") {
  if (!targetPage || targetPage.isClosed?.()) return;
  await targetPage.evaluate(({ enabled }) => {
    const styleId = "rct-vrbo-challenge-alert-style";
    const bannerId = "rct-vrbo-challenge-alert-banner";
    const borderId = "rct-vrbo-challenge-alert-border";
    if (!enabled) {
      document.getElementById(borderId)?.remove();
      document.getElementById(bannerId)?.remove();
      document.getElementById(styleId)?.remove();
      return;
    }
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        #${bannerId} {
          position: fixed;
          z-index: 2147483647;
          top: 0;
          left: 0;
          right: 0;
          padding: 14px 18px;
          background: #fde047;
          color: #111827;
          border-bottom: 4px solid #f59e0b;
          font: 700 18px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
          text-align: center;
        }
        html { outline: 8px solid #facc15 !important; outline-offset: -8px !important; }
        body { padding-top: 58px !important; }
        #${borderId} {
          position: fixed;
          z-index: 2147483646;
          inset: 0;
          border: 12px solid #facc15;
          box-shadow: inset 0 0 0 4px #f59e0b;
          pointer-events: none;
        }
      `;
      document.documentElement.appendChild(style);
    }
    let banner = document.getElementById(bannerId);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = bannerId;
      banner.setAttribute("role", "alert");
      banner.textContent = "VRBO BOT / NOT verification needs manual clearing";
      document.documentElement.appendChild(banner);
    }
    if (!document.getElementById(borderId)) {
      const border = document.createElement("div");
      border.id = borderId;
      document.documentElement.appendChild(border);
    }
  }, { enabled }).catch((e) => {
    log(`${label} ${id}: VRBO challenge highlight ${enabled ? "apply" : "remove"} skipped: ${e?.message ?? e}`);
  });
}

async function surfaceVrboChallengeWindow(targetPage = page, label = "vrbo", id = "") {
  if (usingHeadlessRuntime()) return false;
  if (!context || !targetPage || targetPage.isClosed?.()) return false;
  if (!SIDECAR_CAPTCHA_SURFACE_WINDOW) {
    log(`${label} ${id}: CAPTCHA manual surfacing disabled by SIDECAR_CAPTCHA_SURFACE_WINDOW=0`);
    return false;
  }

  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (!session) return false;
  try {
    const info = await withSoftTimeout(session.send("Browser.getWindowForTarget"), 1_500, null);
    const windowId = info?.windowId;
    if (typeof windowId !== "number") return false;

    const bounds = await nearFullscreenWindowBounds(targetPage);
    captchaWindowVisible = true;
    lastObservedWindowState = "normal";
    playVrboChallengeAlertSound(label, id);
    await setVrboChallengeHighlight(targetPage, true, label, id).catch(() => {});
    await withSoftTimeout(session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }), 1_500);
    await withSoftTimeout(session.send("Browser.setWindowBounds", { windowId, bounds }), 1_500);
    if (SIDECAR_CAPTCHA_ALLOW_FOCUS || SIDECAR_ALLOW_FOCUS || SIDE_CAR_CHROME_VISIBLE) {
      await targetPage.bringToFront().catch(() => {});
    }
    log(`${label} ${id}: surfaced Chrome near fullscreen for manual VRBO BOT/NOT verification`);
    await postScreenSnapshot({ id, opType: label }, targetPage, "manual VRBO BOT/NOT verification", { captcha: true, force: true });
    return true;
  } catch (e) {
    log(`${label} ${id}: VRBO challenge window surfacing failed: ${e?.message ?? e}`);
    return false;
  } finally {
    await withSoftTimeout(session.detach(), 500, null);
  }
}

async function snapSidecarWindowToGrid(targetPage = page, { focus = false, label = "sidecar", id = "" } = {}) {
  if (usingHeadlessRuntime()) return false;
  if (!context || !targetPage || targetPage.isClosed?.()) return false;
  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (!session) return false;
  try {
    const info = await withSoftTimeout(session.send("Browser.getWindowForTarget"), 1_500, null);
    const windowId = info?.windowId;
    if (typeof windowId !== "number") return false;
    const pos = gridWindowPositionForWorker();
    await withSoftTimeout(session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }), 1_500, null);
    await withSoftTimeout(
      session.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: pos.left,
          top: pos.top,
          width: VISIBLE_WINDOW_SIZE.width,
          height: VISIBLE_WINDOW_SIZE.height,
        },
      }),
      1_500,
      null,
    );
    if (focus) await targetPage.bringToFront().catch(() => {});
    log(`${label} ${id}: snapped Chrome sidecar window to grid slot ${WORKER_SLOT}${focus ? " and focused it" : ""}`);
    return true;
  } catch (e) {
    log(`${label} ${id}: Chrome grid snap failed: ${e?.message ?? e}`);
    return false;
  } finally {
    await withSoftTimeout(session.detach(), 500, null);
  }
}

async function getSidecarWindowBounds(targetPage = page) {
  if (usingHeadlessRuntime()) return null;
  if (!context || !targetPage || targetPage.isClosed?.()) return null;
  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (!session) return null;
  try {
    const info = await withSoftTimeout(session.send("Browser.getWindowForTarget"), 1_500, null);
    const windowId = info?.windowId;
    if (typeof windowId !== "number") return null;
    const bounds = await withSoftTimeout(session.send("Browser.getWindowBounds", { windowId }), 1_500, null);
    return bounds ?? null;
  } catch {
    return null;
  } finally {
    await withSoftTimeout(session.detach(), 500, null);
  }
}

async function snapGridAfterNativeRestore(targetPage = page, label = "sidecar", id = "") {
  if (!SIDE_CAR_CHROME_VISIBLE || !captchaWindowVisible) return false;
  const bounds = await getSidecarWindowBounds(targetPage);
  const state = String(bounds?.windowState ?? "normal");
  const wasZoomed = lastObservedWindowState === "maximized" || lastObservedWindowState === "fullscreen";
  lastObservedWindowState = state;
  if (!wasZoomed || state !== "normal") return false;
  return snapSidecarWindowToGrid(targetPage, { focus: false, label: "green restore", id }).catch(() => false);
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
  if (!SIDECAR_AUTO_MINIMIZE) return;
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
  if (!SIDECAR_AUTO_MINIMIZE) return;
  if (usingHeadlessRuntime()) return;
  if (SIDE_CAR_CHROME_VISIBLE || captchaWindowVisible) return;
  // Hand focus back to the operator's app alongside the off-screen minimize —
  // the page-create that precedes this is one of the moments Chrome activates.
  scheduleReturnFocus();
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
  if (SIDE_CAR_CHROME_VISIBLE) {
    if (visible) {
      if (/^vrbo/i.test(String(label || ""))) {
        await surfaceVrboChallengeWindow(targetPage, label, id).catch(() => false);
      } else {
        lastObservedWindowState = "normal";
        await snapSidecarWindowToGrid(targetPage, { focus: false, label, id }).catch(() => false);
      }
    } else {
      lastObservedWindowState = null;
      if (/^vrbo/i.test(String(label || ""))) {
        await setVrboChallengeHighlight(targetPage, false, label, id).catch(() => {});
      }
    }
    captchaWindowVisible = visible;
    return true;
  }
  if (!context || !targetPage || targetPage.isClosed?.()) return false;
  if (visible && /^vrbo/i.test(String(label || ""))) {
    return surfaceVrboChallengeWindow(targetPage, label, id);
  }
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
      lastObservedWindowState = "normal";
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
      lastObservedWindowState = null;
      if (/^vrbo/i.test(String(label || ""))) {
        await setVrboChallengeHighlight(targetPage, false, label, id).catch(() => {});
      }
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

async function dismissObstructions(targetPage = page, label = "page", options = {}) {
  if (!targetPage || targetPage.isClosed?.()) return [];
  const allowEscape = options?.allowEscape !== false;
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
  if (stillBlocked && allowEscape) {
    await targetPage.keyboard.press("Escape").catch(() => {});
    actions.push({ clicked: true, kind: "escape", label: "Escape" });
    await targetPage.waitForTimeout(400).catch(() => {});
  }

  if (actions.length > 0) {
    log(`${label}: dismissed obstruction(s): ${actions.map((a) => `${a.kind}:${a.label}`).join("; ")}`);
  }
  return actions;
}

async function dismissBookingPopups(targetPage = page, label = "booking_search") {
  if (!targetPage || targetPage.isClosed?.()) return [];
  const actions = [...await dismissObstructions(targetPage, label)];
  for (let pass = 0; pass < 4; pass++) {
    const action = await withSoftTimeout(
      targetPage.evaluate(() => {
        const rootSelector = [
          "[role='dialog']",
          "[aria-modal='true']",
          "[class*='modal' i]",
          "[class*='overlay' i]",
          "[class*='popup' i]",
          "[data-testid*='modal' i]",
          "[data-testid*='overlay' i]",
          "[data-testid*='sign' i]",
        ].join(",");
        const controlSelector = [
          "button",
          "[role='button']",
          "a",
          "[aria-label]",
          "[title]",
          "[data-testid]",
        ].join(",");
        const closeRe = /\b(?:close|dismiss|not now|maybe later|no thanks|skip|continue without|sign in later)\b|^(?:×|x)$/i;
        const badRe = /\b(?:sign in|register|create account|search|reserve|book|select|favorite|share|facebook|google|apple|email)\b/i;

        function isVisible(el) {
          if (!el || !(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width >= 4 && rect.height >= 4 &&
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
            el.getAttribute?.("data-testid"),
            el.getAttribute?.("data-test"),
          ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        }

        function click(el, kind, label) {
          const rect = el.getBoundingClientRect();
          el.scrollIntoView?.({ block: "center", inline: "center" });
          el.click();
          return {
            clicked: true,
            kind,
            label: (label || textOf(el) || el.tagName.toLowerCase()).slice(0, 80),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          };
        }

        const roots = Array.from(document.querySelectorAll(rootSelector))
          .filter(isVisible)
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
          });

        for (const root of roots) {
          const rootRect = root.getBoundingClientRect();
          const rootText = textOf(root).slice(0, 1500);
          const looksBookingPopup = /sign in|genius|save|unlock|account|deal|app|booking/i.test(rootText) ||
            rootRect.width > window.innerWidth * 0.25 ||
            rootRect.height > window.innerHeight * 0.18;
          if (!looksBookingPopup) continue;

          const controls = Array.from(root.querySelectorAll(controlSelector))
            .filter((el) => isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
          const labeledClose = controls.find((el) => {
            const label = textOf(el);
            return closeRe.test(label) && !badRe.test(label.replace(closeRe, ""));
          });
          if (labeledClose) return click(labeledClose, "booking-popup-close", textOf(labeledClose));

          const iconClose = controls
            .map((el) => ({ el, rect: el.getBoundingClientRect(), label: textOf(el) }))
            .filter(({ rect, label }) => {
              const small = rect.width <= 72 && rect.height <= 72;
              const nearTopRight = rect.top <= rootRect.top + Math.max(120, rootRect.height * 0.25) &&
                rect.left >= rootRect.right - Math.max(180, rootRect.width * 0.35);
              const notPrimaryAction = !badRe.test(label);
              return small && nearTopRight && notPrimaryAction;
            })
            .sort((a, b) => {
              const ax = Math.abs(a.rect.top - rootRect.top) + Math.abs(a.rect.right - rootRect.right);
              const bx = Math.abs(b.rect.top - rootRect.top) + Math.abs(b.rect.right - rootRect.right);
              return ax - bx;
            })[0];
          if (iconClose) return click(iconClose.el, "booking-popup-icon-close", iconClose.label || "top-right close");
        }

        return null;
      }),
      2_500,
      null,
    );
    if (!action?.clicked) break;
    actions.push(action);
    await targetPage.waitForTimeout(500).catch(() => {});
  }
  if (actions.length > 0) {
    log(`${label}: dismissed Booking popup(s): ${actions.map((a) => `${a.kind}:${a.label}`).join("; ")}`);
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

function mergeDateEntries(prev, next) {
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

function vrboCookiesFromStorageState(state) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  return cookies.filter((cookie) => /(^|\.)vrbo\.com$/i.test(String(cookie?.domain ?? "").replace(/^\./, "")));
}

function readVrboManualSessionState() {
  if (!VRBO_REUSE_MANUAL_SESSION) return null;
  try {
    if (!fs.existsSync(VRBO_MANUAL_SESSION_STATE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(VRBO_MANUAL_SESSION_STATE_PATH, "utf8"));
    const savedAt = Number(parsed?.savedAt ?? 0);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > VRBO_MANUAL_SESSION_TTL_MS) {
      fs.rmSync(VRBO_MANUAL_SESSION_STATE_PATH, { force: true });
      return null;
    }
    const cookies = vrboCookiesFromStorageState(parsed?.state);
    if (!cookies.length) return null;
    return { savedAt, state: parsed.state, cookies };
  } catch (e) {
    log(`VRBO manual session cache read failed: ${e?.message ?? e}`);
    return null;
  }
}

async function restoreVrboManualSessionCookies(label = "VRBO manual session restore") {
  if (!VRBO_REUSE_MANUAL_SESSION) {
    log(`${label}: skipped; SIDECAR_VRBO_REUSE_MANUAL_SESSION is not enabled`);
    return false;
  }
  if (!context) return false;
  const snapshot = readVrboManualSessionState();
  if (!snapshot?.cookies?.length) return false;
  const restored = await addCookiesBestEffort(snapshot.cookies, label).catch((e) => {
    log(`${label}: failed to restore cached VRBO cookies: ${e?.message ?? e}`);
    return false;
  });
  if (restored) {
    const ageMinutes = Math.max(0, Math.round((Date.now() - snapshot.savedAt) / 60_000));
    log(`${label}: restored ${snapshot.cookies.length} VRBO cookie(s) from manual solve cache (${ageMinutes}m old)`);
  }
  return restored;
}

async function saveVrboManualSessionState(targetPage = page, label = "vrbo", id = "") {
  if (!VRBO_REUSE_MANUAL_SESSION) {
    log(`${label} ${id}: not caching VRBO manual solve cookies; every VRBO search uses a fresh identity`);
    return false;
  }
  if (!targetPage || targetPage.isClosed?.()) return false;
  try {
    const state = await targetPage.context().storageState();
    const cookies = vrboCookiesFromStorageState(state);
    if (!cookies.length) {
      log(`${label} ${id}: manual solve finished but no VRBO cookies were available to cache`);
      return false;
    }
    fs.mkdirSync(path.dirname(VRBO_MANUAL_SESSION_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      VRBO_MANUAL_SESSION_STATE_PATH,
      JSON.stringify({ savedAt: Date.now(), state }, null, 2),
      "utf8",
    );
    log(`${label} ${id}: cached ${cookies.length} VRBO cookie(s) from manual CAPTCHA solve`);
    return true;
  } catch (e) {
    log(`${label} ${id}: failed to cache VRBO manual solve state: ${e?.message ?? e}`);
    return false;
  }
}

function clearVrboManualSessionState(label = "VRBO fresh identity") {
  if (VRBO_REUSE_MANUAL_SESSION) return;
  try {
    if (fs.existsSync(VRBO_MANUAL_SESSION_STATE_PATH)) {
      fs.rmSync(VRBO_MANUAL_SESSION_STATE_PATH, { force: true });
      log(`${label}: removed cached VRBO manual session state`);
    }
  } catch (e) {
    log(`${label}: failed to remove cached VRBO manual session state: ${e?.message ?? e}`);
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
  if (activeChromeAllocation && needsFreshChromeForOp(request?.opType) && !keepVisibleLocalChromeGrid()) {
    await teardownBrowser(`fresh browser required for ${request.opType}`);
  } else if (activeChromeAllocation) {
    return activeChromeAllocation;
  }
  // Capture the operator's foreground app BEFORE the manager may launch/activate
  // Chrome, so we can hand focus back to them right after (see scheduleReturnFocus).
  await captureFrontmostUserApp();
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
  // A local Chrome instance was just acquired (possibly freshly launched) —
  // return focus to the operator's app in case Chrome stole it.
  if (activeChromeAllocation.cdpUrl) scheduleReturnFocus();
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

function preferredFingerprintOs() {
  const raw = nonEmptyEnv("SIDECAR_FINGERPRINT_OS", "SIDECAR_BROWSER_FINGERPRINT_OS") || "macos";
  const value = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (value === "random" || value === "any") return "random";
  if (value === "windows" || value === "win") return "windows";
  return "macos";
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
      viewport: pickOne([{ width: 1600, height: 1000 }, { width: 1680, height: 1050 }, { width: 1920, height: 1080 }], rand),
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
      viewport: pickOne([{ width: 1600, height: 1000 }, { width: 1680, height: 1050 }, { width: 1728, height: 1117 }, { width: 1920, height: 1080 }], rand),
      webglVendor: "Google Inc. (Apple)",
      webglRenderer: pickOne([
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
        "ANGLE (Apple, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics, Unspecified Version)",
      ], rand),
    },
  ];
  const osPreference = preferredFingerprintOs();
  const eligiblePersonas = osPreference === "random"
    ? personas
    : personas.filter((persona) => persona.os === osPreference);
  const persona = pickOne(eligiblePersonas.length ? eligiblePersonas : personas, rand);
  const configuredTimezone = nonEmptyEnv("SIDECAR_FINGERPRINT_TIMEZONE", "SIDECAR_TIMEZONE");
  const configuredLocale = nonEmptyEnv("SIDECAR_LOCALE") || "en-US";
  const configuredLanguage = nonEmptyEnv("SIDECAR_LANGUAGE") || configuredLocale;
  const configuredAcceptLanguage = nonEmptyEnv("SIDECAR_ACCEPT_LANGUAGE") || `${configuredLanguage},en;q=0.9`;
  const timezone = configuredTimezone || pickOne(["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Pacific/Honolulu"], rand);
  const deviceScaleFactor = persona.os === "macos" ? pickOne([1, 2], rand) : pickOne([1, 1.25, 1.5], rand);
  const hardwareConcurrency = pickOne([4, 6, 8, 10, 12], rand);
  const deviceMemory = pickOne([4, 8, 16], rand);
  const id = hashString(`${seedText}|${persona.os}|${persona.viewport.width}x${persona.viewport.height}|${timezone}`).toString(16);
  return {
    id,
    ...persona,
    locale: configuredLocale,
    language: configuredLanguage,
    languages: [configuredLanguage, "en"],
    acceptLanguage: configuredAcceptLanguage,
    userAgentMetadata: {
      brands: [
        { brand: "Google Chrome", version: String(chromeMajor) },
        { brand: "Chromium", version: String(chromeMajor) },
        { brand: "Not A(Brand", version: "99" },
      ],
      fullVersionList: [
        { brand: "Google Chrome", version: `${chromeMajor}.0.${chromePatch}.0` },
        { brand: "Chromium", version: `${chromeMajor}.0.${chromePatch}.0` },
        { brand: "Not A(Brand", version: "99.0.0.0" },
      ],
      platform: persona.uaPlatform,
      platformVersion: persona.os === "macos" ? "14.7.0" : "10.0.0",
      architecture: persona.os === "macos" ? "arm" : "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
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
    if ("userAgentData" in Navigator.prototype) {
      defineGetter(Navigator.prototype, "userAgentData", {
        brands: fp.userAgentMetadata.brands,
        mobile: false,
        platform: fp.userAgentMetadata.platform,
        getHighEntropyValues: async (hints = []) => {
          const values = {
            architecture: fp.userAgentMetadata.architecture,
            bitness: fp.userAgentMetadata.bitness,
            brands: fp.userAgentMetadata.brands,
            fullVersionList: fp.userAgentMetadata.fullVersionList,
            mobile: false,
            model: "",
            platform: fp.userAgentMetadata.platform,
            platformVersion: fp.userAgentMetadata.platformVersion,
            uaFullVersion: fp.userAgentMetadata.fullVersionList[0]?.version ?? "",
            wow64: false,
          };
          return Object.fromEntries(String(hints).split(",").filter(Boolean).map((hint) => [hint, values[hint]]).filter(([, value]) => value !== undefined));
        },
        toJSON: () => ({
          brands: fp.userAgentMetadata.brands,
          mobile: false,
          platform: fp.userAgentMetadata.platform,
        }),
      });
    }
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
    if ("userAgentData" in Navigator.prototype) {
      defineGetter(Navigator.prototype, "userAgentData", {
        brands: fp.userAgentMetadata.brands,
        mobile: false,
        platform: fp.userAgentMetadata.platform,
        getHighEntropyValues: async (hints = []) => {
          const values = {
            architecture: fp.userAgentMetadata.architecture,
            bitness: fp.userAgentMetadata.bitness,
            brands: fp.userAgentMetadata.brands,
            fullVersionList: fp.userAgentMetadata.fullVersionList,
            mobile: false,
            model: "",
            platform: fp.userAgentMetadata.platform,
            platformVersion: fp.userAgentMetadata.platformVersion,
            uaFullVersion: fp.userAgentMetadata.fullVersionList[0]?.version ?? "",
            wow64: false,
          };
          return Object.fromEntries(String(hints).split(",").filter(Boolean).map((hint) => [hint, values[hint]]).filter(([, value]) => value !== undefined));
        },
        toJSON: () => ({
          brands: fp.userAgentMetadata.brands,
          mobile: false,
          platform: fp.userAgentMetadata.platform,
        }),
      });
    }
  }, fingerprint), 1_500, null);
  await withSoftTimeout(targetPage.setViewportSize(fingerprint.viewport), 1_500, null);
  const session = await withSoftTimeout(context?.newCDPSession(targetPage), 1_500, null);
  if (!session) return;
  try {
    await withSoftTimeout(session.send("Network.setUserAgentOverride", {
      userAgent: fingerprint.userAgent,
      acceptLanguage: fingerprint.acceptLanguage,
      platform: fingerprint.uaPlatform,
      userAgentMetadata: fingerprint.userAgentMetadata,
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
  const metrics = await withSoftTimeout(targetPage.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    visualWidth: window.visualViewport?.width ?? window.innerWidth,
    visualHeight: window.visualViewport?.height ?? window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  })), 1_500, null);
  const minWidth = Math.min(1000, viewport.width - 80);
  const minHeight = Math.min(700, viewport.height - 80);
  const tooSmall = metrics && (metrics.innerWidth < minWidth || metrics.innerHeight < minHeight);
  if (tooSmall) {
    await withSoftTimeout(targetPage.setViewportSize(viewport), 1_500);
    await applyFingerprintToPage(targetPage).catch(() => {});
    const retry = await withSoftTimeout(targetPage.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      visualWidth: window.visualViewport?.width ?? window.innerWidth,
      visualHeight: window.visualViewport?.height ?? window.innerHeight,
    })), 1_500, null);
    const stillTooSmall = retry && (retry.innerWidth < minWidth || retry.innerHeight < minHeight);
    const now = Date.now();
    if (stillTooSmall && now - lastViewportWarningAt > 30_000) {
      lastViewportWarningAt = now;
      log(
        `warning: scrape viewport stayed small after normalization ` +
        `inner=${retry.innerWidth}x${retry.innerHeight} visual=${retry.visualWidth}x${retry.visualHeight} ` +
        `outer=${retry.outerWidth}x${retry.outerHeight}; expected ${viewport.width}x${viewport.height}`,
      );
    }
  }
  scheduleSidecarMinimize(targetPage);
}

async function clearContextStorageForFreshRun(label = "fresh browser run", options = {}) {
  if (!context) return;
  const force = options?.force === true;
  if (!force && !CLEAR_OTA_STORAGE_BETWEEN_RUNS) {
    log(`${label}: preserved cookies, cache, and OTA origin storage for 48h session reuse`);
    return;
  }
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

async function clearOtaClientSearchState(origin, label = "client search state reset") {
  if (!context || !origin) return false;
  const pages = typeof context.pages === "function" ? context.pages() : [];
  const targetPage = pages.find((p) => p && !p.isClosed?.()) ?? page;
  if (!targetPage || targetPage.isClosed?.()) return false;
  const session = await withSoftTimeout(context.newCDPSession(targetPage), 1_500, null);
  if (!session) return false;
  try {
    await withSoftTimeout(session.send("Storage.clearDataForOrigin", {
      origin,
      storageTypes: "appcache,file_systems,indexeddb,local_storage,shader_cache,websql,service_workers,cache_storage,storage_buckets",
    }), 1_500, null);
    log(`${label}: cleared ${origin} client search/cache state; preserved cookies`);
    return true;
  } catch (e) {
    log(`${label}: client search state reset failed for ${origin}: ${e?.message ?? e}`);
    return false;
  } finally {
    await withSoftTimeout(session.detach(), 500, null);
  }
}

function isCdpContextManagementError(error) {
  return /setDownloadBehavior|context management is not supported/i.test(error?.message ?? String(error));
}

async function switchToHeadlessFromCdpFailure(message) {
  if (!HEADLESS_FALLBACK_ENABLED) {
    throw new Error(message);
  }
  log(message);
  await teardownBrowser("CDP fallback to headless");
  browser = null;
  context = null;
  page = null;
  activeChromeAllocation = {
    type: "headless",
    label: WORKER_ROLE === "server" ? "Railway headless Chromium fallback" : "headless Chromium fallback",
    cdpUrl: null,
    noVncUrl: null,
    ephemeral: false,
    release: async () => {},
  };
  return ensureHeadlessBrowser();
}

async function ensureBrowser(cdpRecoverAttempt = 0) {
  const allocation = await acquireChromeForRequest();
  if (usingHeadlessRuntime()) return ensureHeadlessBrowser();
  if (browser && context && page && !page.isClosed()) {
    await normalizePageDisplay(page);
    return;
  }
  log(`connecting to Chrome via CDP (${allocation.label})…`);
  await verifyActiveChromeHealth("before connect");
  if (allocation.cdpUrl) {
    await chromeSidecarManager.recoverDeadLocalCdp(allocation.cdpUrl).catch(() => false);
  }
  try {
    browser = await chromium.connectOverCDP(allocation.cdpUrl);
    // Never call browser.newContext() over CDP: Playwright issues Browser.setDownloadBehavior,
    // which headed server Chrome rejects ("Browser context management is not supported").
    const existingContexts = browser.contexts();
    if (!existingContexts.length) {
      await browser.close().catch(() => {});
      browser = null;
      return switchToHeadlessFromCdpFailure("CDP Chrome has no browser contexts; falling back to headless Chromium");
    }
    context = existingContexts[0];
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
    await clearContextStorageForFreshRun("local Chrome startup");
    await syncRemoteCookies();
    const cookies = loadCookies();
    const shouldSeedCookies = !needsFreshIdentityForOp(activeRuntimeRequest?.opType);
    const seeded = shouldSeedCookies && cookies.length ? await addCookiesBestEffort(cookies, "startup cookie seed") : false;
    if (activeRequestIsVrbo()) {
      await restoreVrboManualSessionCookies("server Chrome VRBO manual session restore");
    }
    log(
      shouldSeedCookies
        ? seeded
          ? `seeded ${cookies.length} cookies into Chrome context`
          : `using existing Chrome profile/server cookies (${cookies.length} cookies available on disk)`
        : "skipped cookie seeding for isolated OTA identity",
    );

    // PR #302 (revised): always create a NEW page rather than reusing pages[0].
    page = await Promise.race([
      context.newPage(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("newPage timed out")), 8000)),
    ]);
    await normalizePageDisplay(page);
    const closedCount = await closeExtraTabs("startup tab cleanup", page);
    log(`opened fresh daemon-owned tab; closed ${closedCount} stale tab(s)`);
  } catch (e) {
    const errMsg = String(e?.message ?? e);
    // CDP WEDGE auto-heal: connectOverCDP hangs/times out even though Chrome's
    // HTTP endpoint is alive (so recoverDeadLocalCdp's HTTP checks won't relaunch
    // it). Hard-kill + relaunch the instance and retry, bounded. Without this the
    // worker just reconnects to the SAME wedged Chrome on every retry → every
    // scan exports 0 (the 2026-06-08 outage). connectOverCDP's default 30s
    // timeout is what surfaces the wedge.
    const isCdpConnectTimeout =
      /connectOverCDP/i.test(errMsg) && /Timeout\s+\d+\s*ms exceeded/i.test(errMsg);
    if (isCdpConnectTimeout && allocation.cdpUrl && cdpRecoverAttempt < 2) {
      log(`${allocation.label}: connectOverCDP timed out (Chrome CDP wedged); hard-relaunching + retrying (wedge attempt ${cdpRecoverAttempt + 1}/2)`);
      const relaunched = await chromeSidecarManager
        .forceRelaunchLocalCdp(allocation.cdpUrl, "connectOverCDP timeout")
        .catch(() => false);
      await teardownBrowser("CDP wedge relaunch");
      browser = null;
      context = null;
      page = null;
      if (relaunched) return ensureBrowser(cdpRecoverAttempt + 1);
      log(`${allocation.label}: wedge-relaunch did not restore CDP; surfacing error`);
    }
    if (isCdpContextManagementError(e) && allocation.cdpUrl && cdpRecoverAttempt < 1) {
      const recovered = await chromeSidecarManager.recoverDeadLocalCdp(allocation.cdpUrl).catch(() => false);
      if (recovered) {
        await teardownBrowser("CDP recover relaunch");
        browser = null;
        context = null;
        page = null;
        return ensureBrowser(cdpRecoverAttempt + 1);
      }
    }
    if (isCdpContextManagementError(e)) {
      return switchToHeadlessFromCdpFailure(`CDP browser setup failed (${e?.message ?? e})`);
    }
    throw e;
  }
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
      const directFallbackAllowed = HEADLESS_PROXY_DIRECT_FALLBACK && !needsFreshIdentityForOp(activeRuntimeRequest?.opType);
      const message =
        `headless proxy auth probe failed (${probeStatus}); ` +
        (directFallbackAllowed
          ? "launching headless fallback without proxy"
          : "direct fallback disabled");
      log(message);
      await sendHeartbeat(`VRBO proxy unavailable: ${probeStatus}`, true, activeRuntimeRequest?.id).catch(() => {});
      if (!directFallbackAllowed) throw new Error(message);
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
  const shouldSeedCookies = !proxyConfig && !needsFreshIdentityForOp(activeRuntimeRequest?.opType);
  const seeded = shouldSeedCookies && cookies.length ? await addCookiesBestEffort(cookies, "headless startup cookie seed") : false;
  if (activeRequestIsVrbo()) {
    await restoreVrboManualSessionCookies("headless VRBO manual session restore");
  }
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

async function resetVisibleChromeToIdle(reason = "idle reset") {
  if (!keepVisibleLocalChromeGrid()) return false;
  try {
    await acquireChromeForRequest({ id: `idle-${WORKER_SLOT}`, opType: "idle" });
    await ensureBrowser();
    if (!context) return false;
    if (!page || page.isClosed?.()) {
      page = context.pages().find((p) => p && !p.isClosed?.()) ?? await context.newPage();
      await normalizePageDisplay(page);
    }
    await clearContextStorageForFreshRun(`${reason}: clear idle browser state`);
    await closeExtraTabs(`${reason}: idle tab cleanup`, page);
    await resetPage();
    await snapSidecarWindowToGrid(page, { focus: false, label: "idle reset", id: String(reason).slice(0, 80) }).catch(() => false);
    log(`${reason}: reset visible Chrome slot to blank idle state`);
    return true;
  } catch (e) {
    log(`${reason}: idle Chrome reset failed: ${e?.message ?? e}`);
    return false;
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

async function markVisibleChromeIdleBeforeDisconnect(reason) {
  if (usingHeadlessRuntime() || !keepVisibleLocalChromeGrid()) return;
  if (!page || page.isClosed?.()) return;
  try {
    await closeExtraTabs(`${reason}: pre-disconnect idle tab cleanup`, page).catch(() => {});
    await showCompletePage(reason);
    await snapSidecarWindowToGrid(page, { focus: false, label: "pre-disconnect idle", id: String(reason).slice(0, 80) }).catch(() => false);
  } catch (e) {
    log(`${reason}: visible Chrome idle mark failed before disconnect: ${e?.message ?? e}`);
  }
}

async function teardownBrowser(reason) {
  await markVisibleChromeIdleBeforeDisconnect(reason);
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
  return data;
}

async function handleQueueControlState(control, hasRequest) {
  const generation = Number(control?.generation);
  if (!Number.isFinite(generation)) return;
  if (lastObservedQueueControlGeneration === null) {
    lastObservedQueueControlGeneration = generation;
    pendingIdleChromeReset = true;
  } else if (generation !== lastObservedQueueControlGeneration) {
    lastObservedQueueControlGeneration = generation;
    pendingIdleChromeReset = true;
  }
  if (!pendingIdleChromeReset || hasRequest || !keepVisibleLocalChromeGrid()) return;
  if (!SIDECAR_IDLE_CHROME_RESET_ENABLED) {
    pendingIdleChromeReset = false;
    return;
  }
  const reason = control?.paused
    ? "sidecar queue paused/cleared"
    : "sidecar idle startup";
  const reset = await resetVisibleChromeToIdle(reason);
  if (reset) pendingIdleChromeReset = false;
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
      await normalizePageDisplay(snapshotPage).catch(() => {});
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
const OTA_PRESS_AND_HOLD_CHALLENGE_RE =
  /press\s+and\s+hold|hold\s+(?:the\s+)?(?:button|slider)|show us your human side|we can.?t tell if you.?re a human|bot or not/i;
const OTA_SLIDER_CHALLENGE_RE =
  /slide\s+(?:the\s+)?(?:lock|slider)|drag\s+(?:the\s+)?(?:slider|piece|puzzle)|slider\s+(?:captcha|verification)|puzzle\s+(?:piece|captcha)|move\s+(?:the\s+)?(?:slider|piece)/i;
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

function normalizeDestinationGuardText(value) {
  let text = String(value || "");
  try {
    text = decodeURIComponent(text);
  } catch {}
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function vrboSearchDestinationFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (!/(^|\.)vrbo\.com$/i.test(url.hostname) || !/\/search/i.test(url.pathname)) return "";
    return normalizeDestinationGuardText(url.searchParams.get("destination") || "");
  } catch {
    return "";
  }
}

// Mainland-namesake guard. Every buy-in market is in Hawaii, so if VRBO's
// autocomplete resolved a search to a NON-Hawaii US state it landed on the wrong
// place — e.g. nearby Kauai town "Port Allen" → "Port Allen, LOUISIANA" (next to
// Baton Rouge / LSU), which harvested mainland listings that got attached to a
// Hawaii booking. (The Florida special-case below was the narrow precedent; this
// generalizes it to all 49 other states.) Inlined here because worker.mjs can't
// import the TS shared/listing-geo leaf.
const NON_HAWAII_US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "idaho", "illinois", "indiana", "iowa", "kansas",
  "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
  "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
];
const HAWAII_DESTINATION_RE = /\b(hawaii|kauai|maui|oahu|molokai|lanai|honolulu|lihue|kona|hilo)\b/;
// expectedState (full lowercase name, threaded from the server when known) makes
// this REGION-AWARE: a resolution to a non-Hawaii state is a "mismatch" to reject
// ONLY when it disagrees with the property's expected state. So a Florida property
// (expectedState="florida") resolving to Florida is FINE; a Hawaii property
// (expectedState "hawaii"/undefined) resolving to Louisiana is still rejected
// (the $2,604 Port-Allen-Louisiana guard). Default (no/"hawaii" expectedState) is
// byte-identical to before: reject every non-Hawaii resolution.
function vrboResolvedToNonHawaiiState(urlDestination, title, expectedState) {
  const text = `${urlDestination || ""} ${normalizeDestinationGuardText(title || "")}`.trim();
  if (!text) return false;
  if (HAWAII_DESTINATION_RE.test(text)) return false; // resolved to Hawaii → fine
  const resolvedState = NON_HAWAII_US_STATES.find((s) => new RegExp(`\\b${s}\\b`).test(text));
  if (!resolvedState) return false; // didn't resolve to any recognized US state
  const expected = String(expectedState || "").trim().toLowerCase();
  if (expected && expected !== "hawaii") {
    // The property is in a known non-Hawaii state → accept that state, reject others.
    return resolvedState !== expected;
  }
  return true; // Hawaii / unknown expectation → any mainland resolution is wrong.
}

function destinationGuardTokens(...values) {
  const stop = new Set([
    "resort",
    "vacation",
    "rental",
    "rentals",
    "places",
    "place",
    "stays",
    "stay",
    "homes",
    "home",
    "condo",
    "condos",
    "villa",
    "villas",
    "the",
    "and",
    "near",
    "area",
    "united",
    "states",
    "america",
  ]);
  return Array.from(new Set(
    values
      .flatMap((value) => normalizeDestinationGuardText(value).split(/\s+/))
      .filter((token) => token.length >= 3 && !stop.has(token)),
  ));
}

// Derive the property's EXPECTED state from the expected-destination values. The
// server appends a full lowercase state name ("florida"/"hawaii") to the guard's
// destination, so we match full names only (NO ambiguous 2-letter abbreviations
// like "in"/"or"/"me" that collide with common words). Hawaii wins first so an
// incidental mainland token in a Hawaii resort name can't relax the guard.
function extractExpectedStateFromDestination(...values) {
  const text = normalizeDestinationGuardText(values.filter(Boolean).join(" "));
  if (!text) return undefined;
  if (HAWAII_DESTINATION_RE.test(text)) return "hawaii";
  return NON_HAWAII_US_STATES.find((s) => new RegExp(`\\b${s}\\b`).test(text)) ?? undefined;
}

function stateMatchesExpectedDestination(state, ...expectedValues) {
  if (!state) return false;
  const expectedText = normalizeDestinationGuardText(expectedValues.filter(Boolean).join(" "));
  const haystack = normalizeDestinationGuardText(`${state.url ?? ""} ${state.title ?? ""} ${state.bodyExcerpt ?? ""}`);
  const urlDestination = vrboSearchDestinationFromUrl(state?.url ?? "");
  // Reject a mainland-namesake resolution (e.g. "Port Allen, Louisiana") before
  // any token matching — port+allen would otherwise match an expected
  // "Port Allen, Hawaii" because the state is treated as a generic token. The
  // expectedState (when the server threaded one) makes this region-aware so a
  // legitimately-Florida property is NOT rejected for resolving to Florida.
  const expectedState = extractExpectedStateFromDestination(...expectedValues);
  if (vrboResolvedToNonHawaiiState(urlDestination, state?.title, expectedState)) return false;
  const genericLocationTokens = new Set([
    "hawaii", "koloa", "kauai", "island", "states", "america", "united", "beach", "county",
  ]);
  const resortTokens = destinationGuardTokens(...expectedValues)
    .filter((token) => !genericLocationTokens.has(token));
  if (urlDestination) {
    if (resortTokens.length >= 2) {
      const hits = resortTokens.filter((token) => urlDestination.includes(token)).length;
      const required = Math.min(2, resortTokens.length);
      if (hits < required) return false;
    }
    if (/\bpoipu\b/.test(expectedText) && /\bkai\b/.test(expectedText) && /\bbrennecke\b/.test(urlDestination)) {
      return false;
    }
  }
  const tokens = destinationGuardTokens(...expectedValues);
  if (tokens.length === 0) return true;
  if (tokens.every((token) => haystack.includes(token))) return true;
  const prefixTokens = destinationGuardTokens(String(expectedValues.find(Boolean) ?? "").split(",")[0]);
  if (prefixTokens.length > 0 && prefixTokens.every((token) => haystack.includes(token))) {
    if (!/\b(kissimmee|orlando|florida)\b/.test(haystack) || /\bflorida\b/.test(expectedText)) {
      return true;
    }
  }
  // Only use the relaxed Poipu-Kai body heuristic when VRBO did not land on a
  // contradictory /search?destination= URL (e.g. Brennecke Beach in Koloa).
  if (!urlDestination && /\bpoipu\s+kai\b/.test(expectedText)) {
    return /\bpoipu\b/.test(haystack) &&
      /\b(kai|koloa|kauai)\b/.test(haystack) &&
      !/\b(kissimmee|orlando|florida|brennecke)\b/.test(haystack);
  }
  return false;
}

function vrboUrlHasExpectedDates(rawUrl, checkIn, checkOut) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (!/(\.|^)vrbo\.com$/i.test(url.hostname)) return false;
    const start = url.searchParams.get("d1") || url.searchParams.get("startDate") || "";
    const end = url.searchParams.get("d2") || url.searchParams.get("endDate") || "";
    return start === checkIn && end === checkOut;
  } catch {
    return false;
  }
}

function stateTextHasExpectedDates(state, checkIn, checkOut) {
  const haystack = normalizeDestinationGuardText(`${state?.url ?? ""} ${state?.title ?? ""} ${state?.bodyExcerpt ?? ""}`);
  const dateNeedles = (iso) => {
    const [year, month, day] = String(iso || "").split("-").map((part) => parseInt(part, 10));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return [];
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const shortMonth = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toLowerCase();
    const longMonth = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
    return [
      iso,
      `${shortMonth} ${day}`,
      `${longMonth} ${day}`,
      `${month} ${day} ${year}`,
      `${month}/${day}/${year}`,
    ].map(normalizeDestinationGuardText).filter(Boolean);
  };
  const inNeedles = dateNeedles(checkIn);
  const outNeedles = dateNeedles(checkOut);
  return inNeedles.some((needle) => haystack.includes(needle)) &&
    outNeedles.some((needle) => haystack.includes(needle));
}

function vrboStateHasExpectedDates(state, checkIn, checkOut) {
  return vrboUrlHasExpectedDates(state?.url, checkIn, checkOut) ||
    stateTextHasExpectedDates(state, checkIn, checkOut);
}

function vrboStateCorrectionReasons(state, checkIn, checkOut, ...expectedValues) {
  const reasons = [];
  if (!stateMatchesExpectedDestination(state, ...expectedValues)) reasons.push("destination");
  if (!vrboStateHasExpectedDates(state, checkIn, checkOut)) reasons.push("dates");
  return reasons;
}

function throwIfVrboDateMismatch(state, label, id, checkIn, checkOut) {
  if (vrboStateHasExpectedDates(state, checkIn, checkOut)) return;
  throw new ProviderBrowserUnavailableError(
    `${label} landed without the requested VRBO dates; refusing to return default-date provider results for ${checkIn}→${checkOut}.`,
    {
      label,
      id,
      expected: `${checkIn}→${checkOut}`,
      url: state?.url,
      title: state?.title,
      excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    },
  );
}

function throwIfDestinationMismatch(state, label, id, ...expectedValues) {
  if (stateMatchesExpectedDestination(state, ...expectedValues)) return;
  const expected = expectedValues.filter(Boolean).join(" / ");
  throw new ProviderBrowserUnavailableError(
    `${label} landed on a different destination than requested; refusing to return stale provider results for "${expected}".`,
    {
      label,
      id,
      expected,
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

function stateLooksLikePressAndHoldChallenge(state) {
  if (!state) return false;
  return OTA_PRESS_AND_HOLD_CHALLENGE_RE.test(
    `${state.title ?? ""}\n${state.bodyExcerpt ?? ""}\n${state.bodyHtmlSnippet ?? ""}\n${state.url ?? ""}`,
  );
}

function stateLooksLikeSliderChallenge(state) {
  if (!state) return false;
  return OTA_SLIDER_CHALLENGE_RE.test(
    `${state.title ?? ""}\n${state.bodyExcerpt ?? ""}\n${state.bodyHtmlSnippet ?? ""}\n${state.url ?? ""}`,
  );
}

function classifyOtaHumanChallenge(state) {
  if (!stateLooksLikeVrboHumanChallenge(state)) return "none";
  if (stateLooksLikePressAndHoldChallenge(state)) return "press_and_hold";
  if (stateLooksLikeSliderChallenge(state)) return "image_slider";
  return "unknown";
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

/**
 * Hard runtime guard: legacy VRBO destination-dropdown flows must not use
 * constructed search URLs. Map-bounds buy-in searches are the explicit
 * exception: the server supplies resort bounds and the worker immediately
 * switches to map/search-area behavior instead of trusting autocomplete.
 */
function assertSafeVrboNavigation(targetUrl, label = "vrbo", id = "", options = {}) {
  if (!targetUrl) return;
  const u = String(targetUrl);
  // Bare homepage or root is always allowed (the only permitted page.goto for VRBO form flows)
  const isBareHome = /^https?:\/\/(www\.)?vrbo\.com\/?(?:\?|$|#|$)/i.test(u);
  if (isBareHome) return;
  const allowMapBoundsSearch = options?.allowMapBoundsSearch === true &&
    /vrbo\.com\/search/i.test(u) &&
    /[?&](latLong|mapBounds)=/i.test(u);
  if (allowMapBoundsSearch) return;

  // Any other vrbo.com URL that looks like a pre-constructed search (with destination, dates, q, etc. in query)
  // or deep result path that was reached via automation goto rather than click is forbidden.
  const looksLikeSearchInjection =
    /vrbo\.com\/search/i.test(u) ||
    /[?&](destination|q|checkin|checkout|d1|d2|adults|minBedrooms)=/i.test(u);

  if (looksLikeSearchInjection) {
    const msg = `${label} ${id}: ABORT — direct navigation to VRBO search/injected URL "${u.slice(0, 200)}" is FORBIDDEN for dropdown flows. Use map-bounds mode or visible homepage form + typing + clicking.`;
    log(msg);
    throw new Error(msg);
  }
}

async function screenshotSliderImageCandidates(scope) {
  const candidates = [];
  const locators = scope.locator('img, canvas, svg, [style*="background-image"]');
  const count = await locators.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 16); i += 1) {
    const loc = locators.nth(i);
    const box = await loc.boundingBox().catch(() => null);
    if (!box || box.width < 15 || box.height < 15) continue;
    const image = await loc.screenshot({ type: "jpeg", quality: 85 }).catch(() => null);
    if (!image) continue;
    candidates.push({ image: image.toString("base64"), area: box.width * box.height, width: box.width, height: box.height });
  }
  return candidates;
}

async function extractSliderCaptchaImagePair(page) {
  const rootSelector = [
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="arkose" i]',
    '[class*="slider" i]',
    '[class*="puzzle" i]',
    '[class*="human" i]',
    '[class*="verify" i]',
    '[class*="challenge" i]',
  ].join(",");

  const scopes = [];
  const roots = page.locator(rootSelector);
  const rootCount = await roots.count().catch(() => 0);
  for (let i = 0; i < Math.min(rootCount, 8); i += 1) scopes.push(roots.nth(i));
  scopes.push(page.locator("body"));

  for (const scope of scopes) {
    const candidates = await screenshotSliderImageCandidates(scope).catch(() => []);
    if (candidates.length < 2) continue;
    candidates.sort((a, b) => b.area - a.area);
    const background = candidates[0];
    const piece = candidates
      .slice(1)
      .sort((a, b) => a.area - b.area)
      .find((candidate) => candidate.area < background.area * 0.8);
    if (piece?.image && background?.image) {
      return {
        image: piece.image,
        imageBackground: background.image,
        mode: "dual_element_screenshot",
        candidates: candidates.length,
        pieceSize: `${Math.round(piece.width)}x${Math.round(piece.height)}`,
        backgroundSize: `${Math.round(background.width)}x${Math.round(background.height)}`,
      };
    }
  }

  const firstRoot = roots.first();
  const box = await firstRoot.boundingBox().catch(() => null);
  if (box && box.width > 80 && box.height > 50) {
    const clip = {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: box.width,
      height: box.height,
    };
    const full = await page.screenshot({ clip, type: "jpeg", quality: 85 }).catch(() => null);
    if (full) {
      const b64 = full.toString("base64");
      return { image: b64, imageBackground: b64, mode: "container_clip_fallback" };
    }
  }

  return null;
}

async function callCapSolverVisionEngineSlider(apiKey, websiteURL, image, imageBackground, label, id) {
  const createResponse = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: "VisionEngine",
        module: "slider_1",
        websiteURL,
        image,
        imageBackground,
      },
    }),
  });

  if (!createResponse.ok) {
    log(`${label} ${id}: CapSolver HTTP ${createResponse.status}`);
    return null;
  }

  const createResult = await createResponse.json();
  if (createResult.errorId !== 0) {
    log(`${label} ${id}: CapSolver createTask error → ${createResult.errorDescription || createResult.errorCode}`);
    return null;
  }

  if (createResult.status === "ready" && createResult.solution) {
    return createResult.solution;
  }

  const taskId = createResult.taskId;
  if (!taskId) return null;

  for (let poll = 0; poll < 15; poll += 1) {
    await new Promise((r) => setTimeout(r, 1_500));
    const resultResponse = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const resultData = await resultResponse.json();
    if (resultData.errorId !== 0) {
      log(`${label} ${id}: CapSolver getTaskResult error → ${resultData.errorDescription || resultData.errorCode}`);
      return null;
    }
    if (resultData.status === "ready" && resultData.solution) {
      return resultData.solution;
    }
  }

  return null;
}

async function performHumanLikeSliderDrag(page, distancePx) {
  const distance = Math.max(0, Math.round(Number(distancePx) || 0));
  if (!page || distance <= 0) return false;

  const handleSelectors = [
    '[role="slider"]',
    '[class*="slider-handle" i]',
    '[class*="slider" i] [class*="handle" i]',
    '[class*="captcha" i] [class*="slider" i]',
    'button[aria-label*="slide" i]',
    '[class*="verify" i] [draggable="true"]',
    '[class*="puzzle" i] [class*="piece" i]',
    'div[style*="cursor: grab"]',
    'div[style*="cursor: grabbing"]',
  ];

  let handle = null;
  let box = null;

  for (const selector of handleSelectors) {
    try {
      const locator = page.locator(selector).first();
      const isVisible = await locator.isVisible().catch(() => false);
      if (!isVisible) continue;

      const candidateBox = await locator.boundingBox().catch(() => null);
      if (candidateBox && candidateBox.width > 10 && candidateBox.height > 10) {
        handle = locator;
        box = candidateBox;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!handle || !box) {
    log("performHumanLikeSliderDrag: Could not find a usable slider handle");
    return false;
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  const steps = Math.min(30, Math.max(12, Math.ceil(distance / 10)));
  const stepDx = distance / steps;

  try {
    await page.mouse
      .move(startX + (Math.random() - 0.5) * 3, startY + (Math.random() - 0.5) * 2)
      .catch(() => {});

    await page.mouse.down().catch(() => {});

    for (let i = 1; i <= steps; i += 1) {
      const progress = i / steps;
      const currentX = startX + stepDx * i;
      const jitterY = startY + (Math.random() - 0.5) * 4 * (1 - progress);

      await page.mouse.move(currentX, jitterY).catch(() => {});
      await boundedPageDelay(page, 20 + Math.floor(Math.random() * 25));
    }

    const overshoot = Math.random() * 8 + 4;
    await page.mouse.move(startX + distance + overshoot, startY + (Math.random() - 0.5) * 2).catch(() => {});
    await boundedPageDelay(page, 80 + Math.floor(Math.random() * 60));

    await page.mouse.move(startX + distance, startY + (Math.random() - 0.5) * 2).catch(() => {});
    await boundedPageDelay(page, 60 + Math.floor(Math.random() * 40));

    await page.mouse.up().catch(() => {});

    return true;
  } catch (err) {
    log(`performHumanLikeSliderDrag error: ${err?.message || err}`);
    await page.mouse.up().catch(() => {});
    return false;
  }
}

async function setCaptchaTextSelectionSuppressed(targetPage = page, enabled = true) {
  if (!targetPage || targetPage.isClosed?.()) return;
  const applyToScope = (scope) => scope.evaluate(({ enabled }) => {
    const styleId = "rct-captcha-no-text-selection";
    if (enabled) {
      let style = document.getElementById(styleId);
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        style.textContent = [
          "html, body, body * {",
          "  -webkit-user-select: none !important;",
          "  user-select: none !important;",
          "}",
        ].join("\n");
        document.documentElement.appendChild(style);
      }
    } else {
      document.getElementById(styleId)?.remove();
    }
    try { window.getSelection?.()?.removeAllRanges?.(); } catch {}
  }, { enabled });

  await applyToScope(targetPage).catch(() => {});
  for (const frame of targetPage.frames?.() ?? []) {
    if (frame === targetPage.mainFrame?.()) continue;
    await applyToScope(frame).catch(() => {});
  }
}

async function performHumanLikePressAndHold(page, label = "vrbo", id = "") {
  if (!page || page.isClosed?.()) return false;
  const selectors = [
    'button:has-text("Press and hold")',
    '[role="button"]:has-text("Press and hold")',
    'text=/press\\s+and\\s+hold/i',
    '[aria-label*="press" i]',
    '[aria-label*="hold" i]',
    '[title*="press" i]',
    '[title*="hold" i]',
    '[class*="captcha" i] button',
    '[class*="human" i] button',
    '[class*="verify" i] button',
    '[class*="challenge" i] button',
    '[class*="slider" i]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="human" i]',
    '[class*="verify" i]',
    '[class*="challenge" i]',
  ];
  const scopes = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];

  let target = null;
  let box = null;
  for (const scope of scopes) {
    for (const selector of selectors) {
      try {
        const locator = scope.locator(selector).first();
        if (!(await locator.isVisible().catch(() => false))) continue;
        const candidateBox = await locator.boundingBox().catch(() => null);
        if (!candidateBox || candidateBox.width < 20 || candidateBox.height < 15) continue;
        target = locator;
        box = candidateBox;
        break;
      } catch {
        continue;
      }
    }
    if (target && box) break;
  }

  if (!target || !box) {
    log(`${label} ${id}: press-and-hold challenge detected, but no hold target was visible`);
    return false;
  }

  await target.scrollIntoViewIfNeeded?.().catch(() => {});
  const refreshedBox = await target.boundingBox().catch(() => null);
  if (refreshedBox) box = refreshedBox;

  const startX = box.x + box.width * (0.45 + Math.random() * 0.1);
  const startY = box.y + box.height * (0.45 + Math.random() * 0.1);
  const holdMs = 7_000 + Math.floor(Math.random() * 3_000);
  const startedAt = Date.now();

  try {
    log(`${label} ${id}: attempting human-like press-and-hold (${Math.round(holdMs / 1000)}s)`);
    await setCaptchaTextSelectionSuppressed(page, true).catch(() => {});
    await page.mouse.move(startX + (Math.random() - 0.5) * 4, startY + (Math.random() - 0.5) * 3).catch(() => {});
    await boundedPageDelay(page, 180 + Math.floor(Math.random() * 220));
    await page.mouse.down().catch(() => {});

    while (Date.now() - startedAt < holdMs) {
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(1, elapsed / holdMs);
      const jitter = 1.6 * (1 - progress * 0.4);
      await page.mouse
        .move(
          startX + Math.sin(elapsed / 470) * jitter + (Math.random() - 0.5) * 0.8,
          startY + Math.cos(elapsed / 530) * jitter + (Math.random() - 0.5) * 0.8,
        )
        .catch(() => {});
      await boundedPageDelay(page, 220 + Math.floor(Math.random() * 180));
    }

    await page.mouse.up().catch(() => {});
    await setCaptchaTextSelectionSuppressed(page, false).catch(() => {});
    await boundedPageDelay(page, 2_000);
    const stillChallenged = stateLooksLikeVrboHumanChallenge(await captureVrboChallengeState(page));
    if (!stillChallenged) {
      log(`${label} ${id}: human-like press-and-hold cleared the challenge`);
      return true;
    }
    log(`${label} ${id}: press-and-hold completed, but challenge is still visible`);
    return false;
  } catch (err) {
    log(`${label} ${id}: press-and-hold failed — ${err?.message || err}`);
    await page.mouse.up().catch(() => {});
    await setCaptchaTextSelectionSuppressed(page, false).catch(() => {});
    return false;
  }
}

async function trySolveOtaSliderWithCapSolver(page, label = "vrbo", id = "") {
  const challengeState = await captureVrboChallengeState(page).catch(() => null);
  const challengeType = classifyOtaHumanChallenge(challengeState);
  if (/^vrbo/i.test(String(label)) && process.env.SIDECAR_VRBO_CAPTCHA_AUTOMATION !== "1") {
    return { solved: false, reason: "vrbo_manual_only", challengeType };
  }

  const solvingEnabled = process.env.CAPTCHA_SOLVING_ENABLED === "1";
  const apiKey = process.env.CAPSOLVER_API_KEY;

  if (!solvingEnabled || !apiKey) {
    return { solved: false, reason: "disabled_or_no_key", challengeType };
  }

  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      if (challengeType === "press_and_hold") {
        if (attempt === 1) {
          log(
            `${label} ${id}: detected press-and-hold challenge; CapSolver VisionEngine slider_1 is not applicable ` +
              "because VRBO did not expose separate puzzle + background images",
          );
        }
        const held = await performHumanLikePressAndHold(page, label, id);
        if (held) return { solved: true, method: "press_and_hold" };
        if (attempt === maxRetries) return { solved: false, reason: "press_hold_failed", challengeType };
        continue;
      }

      log(`${label} ${id}: CapSolver VisionEngine slider_1 (attempt ${attempt}/${maxRetries}, challenge=${challengeType})...`);
      const imagePair = await extractSliderCaptchaImagePair(page);
      if (!imagePair?.image || !imagePair?.imageBackground) {
        log(`${label} ${id}: Could not extract slider puzzle + background images for CapSolver`);
        if (attempt === maxRetries) return { solved: false, reason: "captcha_images_not_found", challengeType };
        continue;
      }

      if (imagePair.mode === "container_clip_fallback") {
        log(`${label} ${id}: only captured a single captcha container screenshot; VisionEngine slider_1 requires separate puzzle + background images`);
        if (attempt === maxRetries) return { solved: false, reason: "captcha_images_not_found", challengeType };
        continue;
      } else {
        log(
          `${label} ${id}: CapSolver image capture mode: ${imagePair.mode}` +
            (imagePair.candidates ? ` candidates=${imagePair.candidates} piece=${imagePair.pieceSize} background=${imagePair.backgroundSize}` : ""),
        );
      }

      let websiteURL = "";
      try {
        websiteURL = page.url();
      } catch {
        websiteURL = "";
      }
      const solution = await callCapSolverVisionEngineSlider(
        apiKey,
        websiteURL,
        imagePair.image,
        imagePair.imageBackground,
        label,
        id,
      );

      if (!solution) {
        if (attempt === maxRetries) return { solved: false, reason: "no_solution", challengeType };
        continue;
      }

      const distance = solution.distance ?? solution.x ?? solution.move ?? null;
      if (distance === null) {
        log(`${label} ${id}: CapSolver solution missing distance/x (${JSON.stringify(solution).slice(0, 200)})`);
        if (attempt === maxRetries) return { solved: false, reason: "unexpected_solution", challengeType };
        continue;
      }

      log(`${label} ${id}: CapSolver returned distance: ${distance}`);
      const dragged = await performHumanLikeSliderDrag(page, distance);
      if (!dragged) {
        log(`${label} ${id}: Could not perform slider drag`);
        if (attempt === maxRetries) return { solved: false, reason: "drag_failed", challengeType };
        continue;
      }

      await boundedPageDelay(page, 1_400);

      const stillChallenged = await stateLooksLikeVrboHumanChallenge(
        await captureVrboChallengeState(page),
      );
      if (!stillChallenged) {
        log(`${label} ${id}: CapSolver VisionEngine successfully solved the slider`);
        return { solved: true };
      }

      log(`${label} ${id}: Drag applied but challenge still present`);
      if (attempt === maxRetries) return { solved: false, reason: "verification_failed", challengeType };
    } catch (err) {
      log(`${label} ${id}: CapSolver attempt ${attempt} crashed — ${err?.message || err}`);
      if (attempt === maxRetries) return { solved: false, reason: "error" };
    }
  }

  return { solved: false, reason: "max_retries_exceeded" };
}

async function trySolveVrboSliderWithCapSolver(page, label = "vrbo", id = "") {
  return trySolveOtaSliderWithCapSolver(page, label, id);
}

async function stopVrboProviderIfBlocked(targetPage, label, id, initialState = null) {
  return stopOtaProviderIfBlocked(targetPage, label, id, initialState);
}

async function stopOtaProviderIfBlocked(targetPage, label, id, initialState = null) {
  let state = initialState ?? await captureVrboChallengeState(targetPage);

  throwIfVrboHardBlock(state, label, id);

  const hasChallenge = stateLooksLikeVrboHumanChallenge(state);
  if (!hasChallenge) return false;

  const solveResult = await trySolveOtaSliderWithCapSolver(targetPage, label, id).catch(() => ({ solved: false }));
  if (solveResult.solved) {
    log(`${label} ${id}: CapSolver successfully solved slider — auto-continuing`);
    return false;
  }
  const challengeType = solveResult.challengeType || classifyOtaHumanChallenge(state);
  const solverReason = solveResult.reason || "not_solved";
  if (solverReason === "vrbo_manual_only") {
    log(`${label} ${id}: VRBO CAPTCHA automation is disabled; waiting for manual solve in the real Chrome window (type=${challengeType})`);
  } else {
    log(`${label} ${id}: CAPTCHA automation did not clear challenge (type=${challengeType}, reason=${solverReason})`);
  }

  const manualVerificationEnabled = process.env.SIDECAR_VRBO_MANUAL_VERIFICATION !== "0";
  if (manualVerificationEnabled) {
    const timeoutMs = parseInt(process.env.SIDECAR_VRBO_MANUAL_VERIFICATION_TIMEOUT_MS, 10) || 8 * 60 * 60_000;
    const pollMs = parseInt(process.env.SIDECAR_VRBO_MANUAL_VERIFICATION_POLL_MS, 10) || 2_000;
    const timeoutAt = Date.now() + timeoutMs;
    const sourceUrl = state?.url;
    const instructions =
      "VRBO CAPTCHA/human-verification page detected. This provider run is paused for manual verification in the real Chrome window. No CapSolver, automated slider, or press-and-hold action will be attempted; solve it yourself in Chrome and the worker will continue once the challenge clears.";

    log(`${label} ${id}: waiting for manual Chrome verification; automated CAPTCHA solving is disabled`);
    await normalizePageDisplay(targetPage).catch(() => {});
    await setCaptchaWindowVisibility(targetPage, true, label, id).catch(() => {});
    await postScreenSnapshot(
      { id, opType: label },
      targetPage,
      "VRBO waiting for manual CAPTCHA solve",
      { captcha: true, force: true },
    );

    let lastSnapshotAt = 0;
    while (Date.now() < timeoutAt) {
      throwIfRequestCancelled(id);
      await sendHeartbeat("VRBO waiting for manual CAPTCHA solve", true, id).catch((e) => {
        if (e instanceof SidecarCancelledError) throw e;
      });
      await applyScreenControlCommands({ id, opType: label }, targetPage, label).catch(() => 0);
      await boundedPageDelay(targetPage, Math.min(pollMs, 1_000));
      state = await captureVrboChallengeState(targetPage);
      if (stateLooksLikeVrboHardBlock(state)) {
        await postScreenSnapshot(
          { id, opType: label },
          targetPage,
          "VRBO hard-blocked after manual CAPTCHA input",
          {
            captcha: true,
            force: true,
            error: "VRBO changed this session from CAPTCHA to a hard block. The worker will abandon this browser/IP and retry with a fresh identity if retries remain.",
          },
        );
        await setCaptchaWindowVisibility(targetPage, false, label, id).catch(() => {});
        throwIfVrboHardBlock(state, label, id);
      }
      if (state && !stateLooksLikeVrboHumanChallenge(state)) {
        throwIfVrboHardBlock(state, label, id);
        await boundedPageDelay(targetPage, 1_000);
        await saveVrboManualSessionState(targetPage, label, id);
        await postScreenSnapshot(
          { id, opType: label },
          targetPage,
          "VRBO manual CAPTCHA solved",
          { force: true },
        );
        await setCaptchaWindowVisibility(targetPage, false, label, id).catch(() => {});
        log(`${label} ${id}: manual VRBO verification cleared; continuing provider run`);
        return true;
      }
      const now = Date.now();
      if (now - lastSnapshotAt >= 1_000) {
        lastSnapshotAt = now;
        await postScreenSnapshot(
          { id, opType: label },
          targetPage,
          "VRBO waiting for manual CAPTCHA solve",
          { captcha: true, error: instructions },
        );
      }
    }

    await postScreenSnapshot(
      { id, opType: label },
      targetPage,
      "VRBO manual CAPTCHA timed out",
      { captcha: true, force: true },
    );
    await setCaptchaWindowVisibility(targetPage, false, label, id).catch(() => {});
    throw new VrboHardBlockError("VRBO manual verification timed out.", {
      label,
      id,
      url: state?.url || sourceUrl,
      title: state?.title,
      excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      challengeType,
      captchaSolverReason: solverReason,
      manualVerificationTimedOut: true,
      retryLater: true,
    });
  }

  log(`${label} ${id}: CAPTCHA detected and manual verification is disabled — rotating/failing provider (type=${challengeType}, reason=${solverReason})`);
  await normalizePageDisplay(targetPage).catch(() => {});
  await postScreenSnapshot(
    { id, opType: label },
    targetPage,
    "VRBO blocked - provider stopped",
    { captcha: true, force: true },
  );
  await setCaptchaWindowVisibility(targetPage, false, label, id).catch(() => {});

  throw new VrboHardBlockError(`VRBO CAPTCHA detected and automation did not solve it (${challengeType}: ${solverReason}).`, {
    label,
    id,
    url: state?.url,
    title: state?.title,
    excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    challengeType,
    captchaSolverReason: solverReason,
    retryLater: true,
  });
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
        await setCaptchaTextSelectionSuppressed(targetPage, true).catch(() => {});
        await targetPage.mouse.move(x, y).catch(() => {});
        await targetPage.mouse.down().catch(() => {});
      } else if (action === "up") {
        await targetPage.mouse.move(x, y).catch(() => {});
        await targetPage.mouse.up().catch(() => {});
        await setCaptchaTextSelectionSuppressed(targetPage, true).catch(() => {});
      } else if (action === "click") {
        await setCaptchaTextSelectionSuppressed(targetPage, true).catch(() => {});
        await targetPage.mouse.click(x, y, { delay: 60 }).catch(() => {});
      } else if (action === "hold") {
        const durationMs = Math.max(1_000, Math.min(15_000, Math.round(Number(command?.durationMs) || 8_000)));
        await setCaptchaTextSelectionSuppressed(targetPage, true).catch(() => {});
        await targetPage.mouse.move(x, y).catch(() => {});
        await targetPage.mouse.down().catch(() => {});
        await boundedPageDelay(targetPage, durationMs);
        await targetPage.mouse.up().catch(() => {});
      } else if (action === "surface") {
        const surfaced = /^vrbo/i.test(String(label || ""))
          ? await surfaceVrboChallengeWindow(targetPage, label, req?.id ?? "").catch(() => false)
          : SIDE_CAR_CHROME_VISIBLE
            ? await snapSidecarWindowToGrid(targetPage, { focus: true, label, id: req?.id ?? "" }).catch(() => false)
            : await setCaptchaWindowVisibility(targetPage, true, label, req?.id ?? "").catch(() => false);
        lastObservedWindowState = "normal";
        if (!surfaced) await targetPage.bringToFront().catch(() => {});
      } else if (action === "restore") {
        await snapSidecarWindowToGrid(targetPage, { focus: false, label: "dashboard restore", id: req?.id ?? "" }).catch(() => false);
        lastObservedWindowState = "normal";
      }
    }
    await snapGridAfterNativeRestore(targetPage, label, req?.id ?? "").catch(() => false);
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
// OTA destination policy: type the community name without "resort", then
// search every matching in-city dropdown suggestion instead of trusting a
// provider default/geolocated destination.
function normalizeOtaText(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const US_STATE_NAMES = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
  ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho",
  il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
  ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada",
  nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
  nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon",
  pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota",
  tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia",
  wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district columbia",
};

function otaBaseSearchQuery(searchTerm, destination) {
  const firstPart = String(searchTerm || destination || "").split(",")[0] || "";
  return firstPart
    .replace(/\b(?:resort|resorts)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || String(searchTerm || destination || "").replace(/\s+/g, " ").trim();
}

function otaExplicitSearchVariants(params, typedQuery, fallbackSearchTerm, label = "site_search") {
  const rawTerms = Array.isArray(params?.searchVariations) ? params.searchVariations : [];
  const mode = params?.variationMode && typeof params.variationMode === "object" ? params.variationMode : {};
  const filterTokens = Array.isArray(mode.filterTokens)
    ? mode.filterTokens.map((token) => String(token || "").toLowerCase().trim()).filter((token) => token.length >= 3)
    : otaQueryTokens(typedQuery || fallbackSearchTerm);
  const maxVariations = Math.max(1, Math.min(20, Number(mode.maxVariations) || OTA_SUGGESTION_MAX));
  const seen = new Set();
  const out = [];
  const add = (term, source = "server-policy") => {
    const cleanTerm = String(term || "").replace(/\s+/g, " ").trim();
    if (!cleanTerm) return;
    const haystack = cleanTerm.toLowerCase();
    if (filterTokens.length) {
      const hits = filterTokens.filter((token) => haystack.includes(token)).length;
      const requiredHits = filterTokens.length <= 2 ? filterTokens.length : 2;
      if (hits < requiredHits) return;
    }
    const key = haystack;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ typedQuery, searchTerm: cleanTerm, suggestionText: cleanTerm, source });
  };
  for (const term of rawTerms) add(term);
  add(fallbackSearchTerm || typedQuery, "fallback");
  const sliced = out.slice(0, maxVariations);
  if (sliced.length && rawTerms.length) {
    log(`${label}: server policy supplied ${sliced.length} destination variation(s): ${sliced.map((v) => `"${v.searchTerm}"`).join("; ")}`);
  }
  return sliced;
}

function otaVisionFallbackEnabled() {
  return process.env.USE_HIKU_VISION === "1" ||
    process.env.SIDECAR_USE_VISION_FALLBACK === "1" ||
    process.env.USE_OTA_VISION_FALLBACK === "1";
}

async function askOtaVisionAction(targetPage, label, prompt, options = {}) {
  if (!otaVisionFallbackEnabled()) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    log(`${label}: vision fallback skipped (ANTHROPIC_API_KEY missing)`);
    return null;
  }
  const req = options.request ?? activeRuntimeRequest ?? {
    id: options.requestId ?? `${label}-vision`,
    opType: options.opType ?? label,
  };
  try {
    await normalizePageDisplay(targetPage).catch(() => {});
    await postScreenSnapshot(req, targetPage, `${label} vision fallback`, { force: true }).catch(() => {});
    await applyScreenControlCommands(req, targetPage, label).catch(() => 0);
    await normalizePageDisplay(targetPage).catch(() => {});
    const viewport = targetPage.viewportSize?.() ?? { width: 1280, height: 900 };
    const screenshot = await targetPage.screenshot({ type: "jpeg", quality: 65, fullPage: false });
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.SIDECAR_VISION_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `${prompt}\n\nReturn ONLY compact JSON: {"action":"click"|"type"|"none","x":number,"y":number,"text":string,"reason":string}. Coordinates must be viewport CSS pixels within ${viewport.width}x${viewport.height}. Do not solve or bypass CAPTCHAs.`,
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: screenshot.toString("base64") },
            },
          ],
        }],
      }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      log(`${label}: vision fallback HTTP ${resp.status}: ${String(data?.error?.message ?? data?.error?.type ?? "").slice(0, 180)}`);
      return null;
    }
    const text = String(data?.content?.find?.((part) => part?.type === "text")?.text ?? data?.content?.[0]?.text ?? "").trim();
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
    const parsed = JSON.parse(jsonText);
    const action = String(parsed?.action || "none").toLowerCase();
    const x = Number(parsed?.x);
    const y = Number(parsed?.y);
    const value = String(parsed?.text || "").trim();
    const reason = String(parsed?.reason || "").replace(/\s+/g, " ").trim().slice(0, 180);
    if (action === "click" && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height) {
      log(`${label}: vision fallback clicking ${Math.round(x)},${Math.round(y)}${reason ? ` (${reason})` : ""}`);
      await targetPage.mouse.click(x, y);
      await postScreenSnapshot(req, targetPage, `${label} vision clicked`, { force: true }).catch(() => {});
      return { action, x, y, reason };
    }
    if (action === "type" && value) {
      log(`${label}: vision fallback typing suggested text "${value.slice(0, 80)}"${reason ? ` (${reason})` : ""}`);
      await targetPage.keyboard.type(value, { delay: 25 });
      await postScreenSnapshot(req, targetPage, `${label} vision typed`, { force: true }).catch(() => {});
      return { action, text: value, reason };
    }
    log(`${label}: vision fallback returned no action${reason ? ` (${reason})` : ""}`);
    return null;
  } catch (e) {
    log(`${label}: vision fallback failed: ${e?.message ?? e}`);
    return null;
  }
}

function otaLocationTokens(...values) {
  const tokens = [];
  for (const value of values) {
    const parts = String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
    for (const part of parts.slice(1)) {
      const norm = normalizeOtaText(part);
      if (!norm) continue;
      for (const token of norm.split(/\s+/)) {
        if (token.length >= 3) tokens.push(token);
        const stateName = US_STATE_NAMES[token];
        if (stateName) tokens.push(...stateName.split(/\s+/).filter((t) => t.length >= 3));
      }
    }
  }
  return Array.from(new Set(tokens));
}

function otaRequiredCityTokens(...values) {
  const tokens = [];
  for (const value of values) {
    const parts = String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
    const city = parts.length >= 3 ? parts[1] : "";
    const norm = normalizeOtaText(city);
    if (!norm) continue;
    for (const token of norm.split(/\s+/)) {
      if (token.length >= 3) tokens.push(token);
    }
  }
  return Array.from(new Set(tokens));
}

function otaQueryTokens(value) {
  return normalizeOtaText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(the|and|resort|resorts)$/.test(token));
}

function otaTextHasRequiredTokens(text, requiredTokens = []) {
  const tokens = new Set(normalizeOtaText(text).split(/\s+/).filter(Boolean));
  const required = Array.isArray(requiredTokens)
    ? requiredTokens.map((token) => String(token || "").toLowerCase().trim()).filter((token) => token.length >= 3)
    : [];
  return required.length === 0 || required.every((token) => tokens.has(token));
}

async function collectVisibleDestinationSuggestions(targetPage, typedQuery, destination, label = "site_search", options = {}) {
  if (!targetPage || targetPage.isClosed?.() || !typedQuery) return [];
  const queryTokens = otaQueryTokens(typedQuery);
  const requiredSearchTokens = Array.isArray(options.filterTokens)
    ? options.filterTokens.map((token) => String(token || "").toLowerCase().trim()).filter((token) => token.length >= 3)
    : queryTokens;
  const locationTokens = otaLocationTokens(destination);
  const requiredCityTokens = otaRequiredCityTokens(destination);
  const maxSuggestions = Math.max(1, Math.min(20, Math.floor(Number(options.maxSuggestions ?? OTA_SUGGESTION_MAX) || OTA_SUGGESTION_MAX)));
  await targetPage.waitForTimeout(2_400).catch(() => null);
  const suggestions = await withSoftTimeout(
    targetPage.evaluate(({ queryTokens, requiredSearchTokens, locationTokens, requiredCityTokens, maxSuggestions }) => {
      const clean = (raw) => String(raw || "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/(\d)([A-Za-z])/g, "$1 $2")
        .toLowerCase()
        .replace(/&amp;/g, "&")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

      function tokenSet(norm) {
        return new Set(String(norm || "").split(/\s+/).filter(Boolean));
      }

      function hasAllTokens(tokens, required) {
        return required.every((token) => tokens.has(token));
      }

      function hasAnyToken(tokens, required) {
        return required.some((token) => tokens.has(token));
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

      function displayText(el) {
        return String([
          el.innerText,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
      }

      function looksLikePageChrome(text, norm) {
        if (text.length > 150) return true;
        if (/(?:homes|experiences|services).{0,60}(?:where|when|add dates|add guests|search)/i.test(text)) return true;
        if (/\bwhere\b.*\bwhen\b.*\badd dates\b.*\badd guests\b/i.test(text)) return true;
        const queryHits = queryTokens.reduce((sum, token) => sum + (norm.match(new RegExp(`\\b${token}\\b`, "g"))?.length ?? 0), 0);
        return queryTokens.length > 0 && queryHits > queryTokens.length * 2;
      }

      function hasMatchingDescendant(row, rowNorm, rowText) {
        return Array.from(row.querySelectorAll("[role='option'], [role='menuitem'], li, button, a, [data-testid*='option' i], [data-testid*='suggest' i]"))
          .some((child) => {
            if (!(child instanceof HTMLElement) || child === row || !isVisible(child)) return false;
            const text = displayText(child);
            const norm = clean(text);
            if (!norm || norm === rowNorm || text.length >= rowText.length) return false;
            const tokens = tokenSet(norm);
            return (!requiredSearchTokens.length || hasAllTokens(tokens, requiredSearchTokens)) &&
              (!requiredCityTokens.length || hasAllTokens(tokens, requiredCityTokens)) &&
              (!locationTokens.length || hasAnyToken(tokens, locationTokens));
          });
      }

      const out = [];
      const seen = new Set();
      const nodes = Array.from(document.querySelectorAll([
        "[role='option']",
        "[role='menuitem']",
        "[data-testid*='autocomplete' i] [role='option']",
        "[data-testid*='autocomplete' i] li",
        "[data-testid*='autocomplete' i] button",
        "[aria-selected]",
        "[data-testid*='option' i]",
        "[data-testid*='suggest' i]",
        "[class*='autocomplete' i] [role='option']",
        "[class*='autocomplete' i] li",
        "[class*='autocomplete' i] button",
        "[class*='autosuggest' i] [role='option']",
        "[class*='autosuggest' i] li",
        "[class*='autosuggest' i] button",
        "[class*='suggest' i] [role='option']",
        "[class*='suggest' i] li",
        "[class*='suggest' i] button",
        "[class*='typeahead' i] [role='option']",
        "[class*='typeahead' i] li",
        "[class*='typeahead' i] button",
        "li",
        "button",
        "a",
      ].join(",")));
      for (const el of nodes) {
        if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
        const row = el.closest("[role='option'], [role='menuitem'], li, button, a, [data-testid*='option' i], [data-testid*='suggest' i]") || el;
        if (!(row instanceof HTMLElement) || !isVisible(row)) continue;
        const text = displayText(row);
        const norm = clean(text);
        if (!norm || looksLikePageChrome(text, norm)) continue;
        if (/^search for\b/i.test(text) || /\bsearch for\b/i.test(norm)) continue;
        if (hasMatchingDescendant(row, norm, text)) continue;
        const tokens = tokenSet(norm);
        if (requiredSearchTokens.length && !hasAllTokens(tokens, requiredSearchTokens)) continue;
        if (requiredCityTokens.length && !hasAllTokens(tokens, requiredCityTokens)) continue;
        if (locationTokens.length && !hasAnyToken(tokens, locationTokens)) continue;
        const key = norm;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text: text.slice(0, 160), norm });
      }
      return out.slice(0, maxSuggestions);
    }, { queryTokens, requiredSearchTokens, locationTokens, requiredCityTokens, maxSuggestions }),
    3_000,
    [],
  );
  if (suggestions.length) {
    log(
      `${label}: discovered ${suggestions.length} in-location destination suggestion(s)` +
      `${requiredSearchTokens.length ? ` requiring resort-prefix token(s) ${requiredSearchTokens.join("+")}` : ""}: ` +
      suggestions.map((s) => `"${s.text}"`).join("; "),
    );
  }
  return suggestions;
}

async function scrapeAndIterateOtaDropdown(targetPage, baseTerm, filterTokens = [], max = OTA_SUGGESTION_MAX, options = {}) {
  const typedQuery = otaBaseSearchQuery(baseTerm, options.destination || baseTerm);
  const label = options.label || "site_search";
  const destination = options.destination || baseTerm;
  const tokens = Array.isArray(filterTokens) && filterTokens.length
    ? filterTokens.map((token) => String(token || "").toLowerCase().trim()).filter((token) => token.length >= 3)
    : otaQueryTokens(typedQuery || baseTerm);
  const maxSuggestions = Math.max(1, Math.min(20, Math.floor(Number(max) || OTA_SUGGESTION_MAX)));
  if (!targetPage || targetPage.isClosed?.() || !typedQuery) {
    return { variants: [], variationsTried: [] };
  }

  await dismissObstructions(targetPage, `${label}_dropdown_helper`).catch(() => []);
  const filled = options.isVrbo
    ? await fillVrboDestinationField(targetPage, typedQuery, `${label}_dropdown_helper`, { chooseSuggestion: false, requestId: options.requestId }).catch(() => null)
    : await fillVisibleSearchField(targetPage, typedQuery, `${label}_dropdown_helper`, { chooseSuggestion: false, requestId: options.requestId }).catch(() => null);
  if (!filled) {
    const vision = await askOtaVisionAction(
      targetPage,
      `${label}_dropdown_focus`,
      `Focus the visible destination/location input for this OTA search. The intended search text is "${typedQuery}".`,
      { requestId: options.requestId, opType: label },
    );
    if (vision?.action === "click") {
      await targetPage.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await targetPage.keyboard.press("Backspace").catch(() => {});
      await targetPage.keyboard.type(typedQuery, { delay: 35 }).catch(() => {});
      await targetPage.waitForTimeout(1_000).catch(() => {});
    }
  }

  const suggestions = await collectVisibleDestinationSuggestions(
    targetPage,
    typedQuery,
    destination,
    `${label}_dropdown_helper`,
    { filterTokens: tokens, maxSuggestions },
  );
  const variants = suggestions.map((suggestion) => ({
    typedQuery,
    searchTerm: suggestion.text,
    suggestionText: suggestion.text,
    source: "suggestion",
  }));
  return {
    variants,
    variationsTried: variants.map((variant) => ({
      term: variant.searchTerm,
      typedQuery: variant.typedQuery,
      suggestionText: variant.suggestionText,
      source: variant.source,
      success: false,
      candidateCount: 0,
    })),
  };
}

async function selectVisibleDestinationSuggestion(targetPage, searchTerm, label = "site_search", targetSuggestion = null, options = {}) {
  if (!targetPage || targetPage.isClosed?.() || !searchTerm) return null;
  const requiredSearchTokens = otaQueryTokens(searchTerm);
  const targetTokens = otaQueryTokens(targetSuggestion || searchTerm);
  await targetPage.waitForTimeout(900).catch(() => null);
  const clicked = await withSoftTimeout(
    targetPage.evaluate(({ searchTerm, targetSuggestion, requiredSearchTokens, targetTokens }) => {
      const clean = (raw) => String(raw || "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/(\d)([A-Za-z])/g, "$1 $2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const searchNorm = clean(searchTerm);
      const targetNorm = clean(targetSuggestion || "");
      if (requiredSearchTokens.length === 0) return null;

      function tokenSet(norm) {
        return new Set(String(norm || "").split(/\s+/).filter(Boolean));
      }

      function hasAllTokens(tokens, required) {
        return required.every((token) => tokens.has(token));
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

      function displayText(el) {
        return String([
          el.innerText,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
        ].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
      }

      function looksLikePageChrome(text, norm) {
        if (text.length > 150) return true;
        if (/(?:homes|experiences|services).{0,60}(?:where|when|add dates|add guests|search)/i.test(text)) return true;
        if (/\bwhere\b.*\bwhen\b.*\badd dates\b.*\badd guests\b/i.test(text)) return true;
        const queryHits = requiredSearchTokens.reduce((sum, token) => sum + (norm.match(new RegExp(`\\b${token}\\b`, "g"))?.length ?? 0), 0);
        return requiredSearchTokens.length > 0 && queryHits > requiredSearchTokens.length * 2;
      }

      const candidates = Array.from(document.querySelectorAll([
        "[role='option']",
        "[role='menuitem']",
        "[aria-selected]",
        "[data-testid*='option' i]",
        "[data-testid*='suggest' i]",
        "li",
        "button",
        "a",
      ].join(",")))
        .filter((el) => el instanceof HTMLElement && isVisible(el))
        .map((el) => {
          const text = displayText(el);
          const norm = clean(text);
          if (!norm || looksLikePageChrome(text, norm)) return null;
          if (/^search for\b/i.test(text) || /\bsearch for\b/i.test(norm)) return null;
          const tokens = tokenSet(norm);
          if (!hasAllTokens(tokens, requiredSearchTokens)) return null;
          const matched = targetTokens.filter((token) => tokens.has(token)).length;
          let score = matched * 20;
          if (targetNorm && norm === targetNorm) score += 500;
          else if (targetNorm && norm.includes(targetNorm)) score += 300;
          else if (targetNorm && targetNorm.includes(norm)) score += 120;
          score += requiredSearchTokens.length * 80;
          if (norm.includes(searchNorm)) score += 40;
          if (/\b(resort|koloa|hi|hawaii|kauai)\b/.test(norm)) score += 10;
          return { el, text, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      let best = candidates[0] ?? null;
      if (targetNorm) {
        const anchored = candidates.filter(({ norm }) => {
          if (norm === targetNorm) return true;
          if (norm.includes(targetNorm) || targetNorm.includes(norm)) return true;
          const targetParts = targetNorm.split(/\s+/).filter(Boolean);
          const candTokens = tokenSet(norm);
          return targetParts.length >= 2 && targetParts.every((token) => candTokens.has(token));
        });
        if (anchored.length) best = anchored.sort((a, b) => b.score - a.score)[0];
      }
      if (!best || best.score < 40) return null;
      try { best.el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
      best.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      best.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      best.el.click();
      return best.text.slice(0, 120);
    }, { searchTerm, targetSuggestion, requiredSearchTokens, targetTokens }),
    3_000,
    null,
  );
  if (clicked) log(`${label}: selected destination suggestion "${clicked}"`);
  if (clicked) return clicked;
  const vision = await askOtaVisionAction(
    targetPage,
    `${label}_vision_dropdown`,
    `The location autocomplete dropdown should be visible. Click the best destination suggestion matching "${targetSuggestion || searchTerm}". It must include the resort-prefix token(s) ${requiredSearchTokens.join(", ")} and must not be a broad unrelated city-only option.`,
    { requestId: options.requestId, opType: label },
  );
  if (!vision) return null;
  await targetPage.waitForTimeout(900).catch(() => {});
  const afterText = await withSoftTimeout(
    targetPage.evaluate(() => {
      const active = document.activeElement;
      const inputText = (el) => {
        if (!(el instanceof HTMLElement)) return "";
        const isTextControl =
          el.matches?.("input, textarea, [role='textbox'], [contenteditable='true']") ||
          el.isContentEditable;
        if (!isTextControl) return "";
        return (el.value || el.textContent || "").replace(/\s+/g, " ").trim();
      };
      const sane = (text) => text && text.length <= 180 && !/\b(?:copyright|popular with travelers|browse by property type)\b/i.test(text);
      const candidates = Array.from(document.querySelectorAll("input, [role='textbox'], [contenteditable='true']"))
        .filter((el) => el instanceof HTMLElement)
        .map(inputText)
        .filter(sane);
      const activeText = inputText(active);
      return sane(activeText) ? activeText : candidates[0] || "";
    }),
    2_000,
    "",
  );
  const fallbackSuggestion = String(targetSuggestion || searchTerm || "").replace(/\s+/g, " ").trim();
  const validatedText = afterText || "";
  if (!validatedText || !otaTextHasRequiredTokens(validatedText, requiredSearchTokens)) {
    log(
      `${label}: vision fallback did not confirm a matching destination` +
      `${validatedText ? `; field now "${validatedText.slice(0, 120)}"` : ""}` +
      `${fallbackSuggestion ? `; expected "${fallbackSuggestion.slice(0, 120)}"` : ""}`,
    );
    return null;
  }
  log(`${label}: vision fallback selected destination; field now "${validatedText.slice(0, 120)}"`);
  return validatedText;
}

async function discoverOtaSearchVariants(homeUrl, searchTerm, destination, label, requestId = "homepage", params = {}) {
  const typedQuery = otaBaseSearchQuery(searchTerm, destination);
  const fallback = String(destination || searchTerm || typedQuery).trim();
  if (!typedQuery) return [{ typedQuery: fallback, searchTerm: fallback, suggestionText: fallback, source: "fallback" }];
  const explicitVariants = otaExplicitSearchVariants(params, typedQuery, fallback || typedQuery, label);
  const mode = params?.variationMode && typeof params.variationMode === "object" ? params.variationMode : {};
  if (mode.allowDiscovery === false && explicitVariants.length > 0) return explicitVariants;
  const isVrbo = /vrbo/i.test(label) || /vrbo\.com/i.test(homeUrl);
  try {
    if (isVrbo) {
      assertSafeVrboNavigation(homeUrl, label, requestId);
    }
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await boundedPageDelay(page, 1_200);
    if (isVrbo) {
      const state = await withSoftTimeout(captureVrboChallengeState(page), 2_000, null);
      throwIfBrightDataKycBlock(state, label, requestId);
      if (stateLooksLikeVrboHumanChallenge(state) || (await pageLooksLikeVrboHumanChallenge(page))) {
        log(`${label} ${requestId}: VRBO challenge detected during suggestion discovery`);
        await stopVrboProviderIfBlocked(page, label, requestId, state);
      }
      throwIfVrboHardBlock(state, label, requestId);
    }
    const scraped = await scrapeAndIterateOtaDropdown(
      page,
      typedQuery,
      Array.isArray(mode.filterTokens) ? mode.filterTokens : otaQueryTokens(typedQuery),
      Number(mode.maxVariations) || OTA_SUGGESTION_MAX,
      {
        destination: destination || searchTerm,
        label: `${label}_suggestions`,
        isVrbo,
        requestId,
      },
    );
    const variants = scraped.variants;
    if (variants.length > 0) {
      const seen = new Set();
      // The provider autocomplete is the source of truth. Operator policy is:
      // type the clean resort prefix, choose the first in-location dropdown
      // option, then walk the remaining visible dropdown options. Server
      // generated variations are only fallback coverage after that list.
      const ordered = [...variants, ...explicitVariants];
      log(`${label}: using ${variants.length} provider dropdown destination(s) before ${explicitVariants.length} generated fallback variation(s)`);
      return ordered.filter((variant) => {
        const key = String(variant.searchTerm || "").toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, Number(mode.maxVariations) || OTA_SUGGESTION_MAX);
    }
  } catch (e) {
    if (e instanceof SidecarCancelledError || e instanceof VrboHardBlockError || e instanceof ProviderBrowserUnavailableError) throw e;
    if (transientErrorMessage(e?.message ?? e)) throw e;
    log(`${label}: destination suggestion discovery skipped: ${e?.message ?? e}`);
  }
  const fallbackSearchTerm = fallback || typedQuery;
  return explicitVariants.length > 0
    ? explicitVariants
    : [{ typedQuery, searchTerm: fallbackSearchTerm, suggestionText: fallbackSearchTerm, source: "fallback" }];
}

function candidateResultSetSignature(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return "";
  const urls = cards
    .map((card) => String(card?.url || card?.href || card?.listingUrl || "").trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .slice(0, 24);
  if (urls.length) return `${cards.length}:${urls.join("|")}`;
  return `${cards.length}:${cards
    .map((card) => String(card?.title || card?.name || "").trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .slice(0, 24)
    .join("|")}`;
}

async function runOtaSearchVariants(id, label, variants, runVariant, options = {}) {
  const allCards = [];
  const failures = [];
  const variationsTried = [];
  let lastMapHarvest = null;
  let completedVariants = 0;
  const duplicateResultCounts = new Map();
  for (let i = 0; i < variants.length; i++) {
    throwIfRequestCancelled(id);
    const variant = variants[i];
    log(`${label} ${id}: running destination variant ${i + 1}/${variants.length}: "${variant.searchTerm}"`);
    try {
      const variantResult = await runVariant(variant);
      const cards = Array.isArray(variantResult) ? variantResult : (variantResult?.candidates ?? []);
      if (!Array.isArray(variantResult) && variantResult?.mapHarvest) lastMapHarvest = variantResult.mapHarvest;
      completedVariants += 1;
      variationsTried.push({
        term: variant.searchTerm,
        typedQuery: variant.typedQuery,
        suggestionText: variant.suggestionText,
        source: variant.source,
        success: true,
        candidateCount: Array.isArray(cards) ? cards.length : 0,
      });
      allCards.push(...cards);
      const signature = options.stopAfterDuplicateResults && Array.isArray(cards) && cards.length > 0
        ? candidateResultSetSignature(cards)
        : "";
      if (signature) {
        const count = (duplicateResultCounts.get(signature) || 0) + 1;
        duplicateResultCounts.set(signature, count);
        const maxDuplicateRuns = Math.max(2, Number(options.maxDuplicateResultRuns) || 2);
        if (count >= maxDuplicateRuns && i < variants.length - 1) {
          const skipped = variants.slice(i + 1);
          for (const skippedVariant of skipped) {
            variationsTried.push({
              term: skippedVariant.searchTerm,
              typedQuery: skippedVariant.typedQuery,
              suggestionText: skippedVariant.suggestionText,
              source: skippedVariant.source,
              success: false,
              candidateCount: 0,
              skipped: true,
              error: `skipped after ${count} destination variations returned the same provider result set`,
            });
          }
          log(
            `${label} ${id}: stopping remaining ${skipped.length} destination variant(s) after ` +
            `${count} successful runs returned the same provider result set`,
          );
          break;
        }
      }
    } catch (e) {
      if (e instanceof SidecarCancelledError || e instanceof SidecarHardTimeoutError || e instanceof VrboHardBlockError) throw e;
      failures.push(e);
      variationsTried.push({
        term: variant.searchTerm,
        typedQuery: variant.typedQuery,
        suggestionText: variant.suggestionText,
        source: variant.source,
        success: false,
        candidateCount: 0,
        error: String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 240),
      });
      log(`${label} ${id}: destination variant "${variant.searchTerm}" failed; continuing with remaining variants: ${e?.message ?? e}`);
    }
  }
  const deduped = dedupeCandidatesByUrl(allCards);
  log(
    `${label} ${id}: ${deduped.length} de-duped cards across ${variants.length} destination variant(s)` +
    `; ${completedVariants} completed${failures.length ? `; ${failures.length} variant failure(s)` : ""}`,
  );
  if (completedVariants === 0 && failures.length > 0) throw failures[0];
  return { candidates: deduped, variationsTried, mapHarvest: lastMapHarvest };
}

async function primeOtaHomepageSearch(homeUrl, searchTerm, label, requestId = "homepage", options = {}) {
  if (!searchTerm) return false;
  const inputTerm = String(options?.inputTerm || searchTerm || "").trim();
  const targetSuggestion = options?.targetSuggestion || null;
  const submitAfterSearch = options?.submitAfterSearch !== false;
  const isVrbo = /vrbo/i.test(label) || /vrbo\.com/i.test(homeUrl);
  const maybeClearVrboChallenge = async (stage) => {
    if (!isVrbo) return false;
    const state = await withSoftTimeout(captureVrboChallengeState(page), 2_000, null);
    throwIfBrightDataKycBlock(state, label, requestId);
    if (stateLooksLikeVrboHumanChallenge(state) || (await pageLooksLikeVrboHumanChallenge(page))) {
      log(`${label} ${requestId}: VRBO challenge detected during homepage prime (${stage})`);
      return stopVrboProviderIfBlocked(page, label, requestId, state);
    }
    throwIfVrboHardBlock(state, label, requestId);
    return false;
  };
  try {
    if (isVrbo) {
      assertSafeVrboNavigation(homeUrl, label, requestId);
    }
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await boundedPageDelay(page, 1_200);
    await maybeClearVrboChallenge("after-homepage-load");
    await dismissObstructions(page, `${label}_home`);
    const vrboFilled = isVrbo
      ? await fillVrboDestinationField(page, inputTerm, `${label}_home`, { targetSuggestion, requestId }).catch(() => null)
      : null;
    const genericFilled = isVrbo
      ? null
      : await fillVisibleSearchField(page, inputTerm, `${label}_home`, { targetSuggestion, requestId }).catch(() => null);
    const filled = vrboFilled?.filled ?? genericFilled?.filled ?? null;
    const suggestion = vrboFilled?.suggestion ?? genericFilled?.suggestion ?? null;
    if (filled && !suggestion && targetSuggestion) {
      const retrySuggestion = await chooseVisibleDestinationSuggestion(
        page,
        String(targetSuggestion),
        `${label}_home_retry`,
        targetSuggestion,
        { requestId },
      ).catch(() => null);
      if (retrySuggestion) {
        log(`${label}: confirmed destination suggestion on retry → "${retrySuggestion}"`);
        return true;
      }
    }
    if (filled && !suggestion && !targetSuggestion) {
      log(`${label}: destination suggestion was not confirmed for "${searchTerm}"; refusing to submit a provider default/geolocated search`);
      return false;
    }
    if (filled) {
      let resolvedSuggestion = String(suggestion || targetSuggestion || inputTerm || searchTerm || "").trim();
      if (
        targetSuggestion &&
        resolvedSuggestion &&
        !bookingSuggestionMatchesVariant(resolvedSuggestion, targetSuggestion)
      ) {
        const corrected = await chooseVisibleDestinationSuggestion(
          page,
          String(targetSuggestion),
          `${label}_home_correct`,
          targetSuggestion,
          { requestId },
        ).catch(() => null);
        if (corrected && bookingSuggestionMatchesVariant(corrected, targetSuggestion)) {
          resolvedSuggestion = corrected;
        } else {
          log(
            `${label}: autocomplete drifted to "${resolvedSuggestion}"; ` +
            `using intended destination "${targetSuggestion}" for the dated results URL`,
          );
          resolvedSuggestion = String(targetSuggestion).trim();
        }
      }
      if (submitAfterSearch) {
        await withSoftTimeout(clickVisibleSearchSubmit(page, `${label}_home`, { requestId }), PAGE_SETTLE_MS + 2_000, null);
        await boundedPageDelay(page, 1_200);
        await maybeClearVrboChallenge("after-homepage-submit");
        log(`${label}: primed public homepage search with "${inputTerm}" → "${resolvedSuggestion}"`);
      } else {
        log(`${label}: entered public homepage search term "${inputTerm}" → "${resolvedSuggestion}"`);
      }
      return { ok: true, suggestion: resolvedSuggestion };
    }
  } catch (e) {
    if (e instanceof SidecarCancelledError || e instanceof VrboHardBlockError || e instanceof ProviderBrowserUnavailableError) throw e;
    if (transientErrorMessage(e?.message ?? e)) throw e;
    log(`${label}: homepage search prime skipped: ${e?.message ?? e}`);
  }
  return false;
}

async function fillVrboDestinationField(targetPage, searchTerm, label = "vrbo_search", options = {}) {
  if (!targetPage || targetPage.isClosed?.() || !searchTerm) return null;
  const chooseSuggestion = options?.chooseSuggestion !== false;
  const targetSuggestion = options?.targetSuggestion || null;
  const suggestionNeedle = String(targetSuggestion || searchTerm || "").trim();
  const pickSuggestion = async () => {
    if (!chooseSuggestion) return null;
    await targetPage.waitForTimeout(2_400).catch(() => {});
    let suggestion = await chooseVisibleDestinationSuggestion(
      targetPage,
      searchTerm,
      label,
      targetSuggestion,
      { requestId: options.requestId },
    ).catch(() => null);
    if (!suggestion && suggestionNeedle && suggestionNeedle !== searchTerm) {
      suggestion = await chooseVisibleDestinationSuggestion(
        targetPage,
        suggestionNeedle,
        label,
        targetSuggestion,
        { requestId: options.requestId },
      ).catch(() => null);
    }
    return suggestion;
  };
  const selectors = [
    'input[name="destination"]',
    '#destination_form_field',
    'input[id*="destination" i]',
    'input[placeholder*="Where" i]',
    'input[aria-label*="Where" i]',
    '[role="textbox"][aria-label*="Where" i]',
  ];
  for (const selector of selectors) {
    const locator = targetPage.locator(selector).first();
    const visible = await locator.isVisible({ timeout: 800 }).catch(() => false);
    if (!visible) continue;
    try {
      await locator.click({ timeout: 1_500 });
      await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await locator.press("Backspace").catch(() => {});
      await locator.type(searchTerm, { delay: 35, timeout: 6_000 });
      let suggestion = await pickSuggestion();
      if (!suggestion && chooseSuggestion) {
        await locator.click({ timeout: 1_500 }).catch(() => {});
        await targetPage.waitForTimeout(600).catch(() => {});
        suggestion = await pickSuggestion();
      }
      log(`${label}: typed destination into VRBO field "${selector}"${suggestion ? ` and selected "${suggestion}"` : ""}`);
      return { filled: selector, suggestion };
    } catch (e) {
      log(`${label}: VRBO destination field "${selector}" failed: ${e?.message ?? e}`);
    }
  }
  const vision = await askOtaVisionAction(
    targetPage,
    `${label}_vision_fill`,
    `Find and focus the VRBO destination input. The intended destination text is "${searchTerm}".`,
    { requestId: options.requestId, opType: label },
  );
  if (vision?.action === "click") {
    await targetPage.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await targetPage.keyboard.press("Backspace").catch(() => {});
    await targetPage.keyboard.type(searchTerm, { delay: 35 }).catch(() => {});
    const suggestion = chooseSuggestion ? await pickSuggestion() : null;
    return { filled: "vision destination input", suggestion };
  }
  const genericFilled = await fillVisibleSearchField(targetPage, searchTerm, label, {
    targetSuggestion,
    requestId: options.requestId,
    chooseSuggestion,
  }).catch(() => null);
  if (genericFilled?.filled) {
    log(`${label}: filled VRBO destination via generic search-field helper "${genericFilled.filled}"${genericFilled.suggestion ? ` → "${genericFilled.suggestion}"` : ""}`);
    return genericFilled;
  }
  return null;
}

async function readVrboHomepageFormSnapshot(targetPage) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  return withSoftTimeout(
    targetPage.evaluate(() => {
      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 6 && rect.height > 6 &&
          style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05;
      }
      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("value"),
          el.getAttribute?.("placeholder"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }
      const isPlaceholderDestination = (text) => /^where\s*to\??$/i.test(String(text || "").trim());
      const destinationSelectors = [
        'input[name="destination"]',
        "#destination_form_field",
        'input[id*="destination" i]',
        'input[placeholder*="Where" i]',
        '[role="combobox"][aria-label*="Where" i]',
      ];
      let destination = "";
      for (const selector of destinationSelectors) {
        const el = document.querySelector(selector);
        if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
        const rawValue = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? String(el.value || "").replace(/\s+/g, " ").trim()
          : String(el.textContent || el.getAttribute?.("value") || "").replace(/\s+/g, " ").trim();
        if (rawValue.length >= 3 && rawValue.length <= 180 && !isPlaceholderDestination(rawValue)) {
          destination = rawValue;
          break;
        }
      }
      const controls = Array.from(document.querySelectorAll("input, button, [role='button'], [role='textbox'], [aria-label], [data-stid]"))
        .filter((el) => el instanceof HTMLElement && isVisible(el))
        .map((el) => ({ text: textOf(el), cls: String(el.className || "") }));
      if (!destination) {
        destination = controls
          .filter(({ text, cls }) => /destination|where to|where\?/i.test(`${text} ${cls}`) || /destination/i.test(cls))
          .map(({ text }) => text)
          .find((text) => text.length >= 3 && text.length <= 180 && !isPlaceholderDestination(text)) || "";
      }
      const dates = controls
        .filter(({ text }) => /\b(?:dates?|check[\s-]*in|check[\s-]*out|arrival|departure)\b/i.test(text))
        .map(({ text }) => text)
        .find((text) => text.length >= 3 && text.length <= 120) || "";
      return { destination, dates };
    }),
    2_000,
    null,
  );
}

function vrboHomepageFormMatchesRequest(snapshot, checkIn, checkOut, ...expectedValues) {
  if (!snapshot) return { destinationOk: false, datesOk: false };
  const pseudoState = {
    url: "",
    title: snapshot.destination,
    bodyExcerpt: `${snapshot.destination} ${snapshot.dates}`,
  };
  return {
    destinationOk: stateMatchesExpectedDestination(pseudoState, ...expectedValues),
    datesOk: stateTextHasExpectedDates(pseudoState, checkIn, checkOut),
    destinationText: snapshot.destination,
    datesText: snapshot.dates,
  };
}

async function processAirbnbSearch(id, params) {
  const { destination, searchTerm } = params;
  const effectiveSearchTerm = String(searchTerm || destination || "").trim();
  await ensureBrowser();
  const variants = await discoverOtaSearchVariants("https://www.airbnb.com/", effectiveSearchTerm, destination, "airbnb_search", id, params);
  const result = await runOtaSearchVariants(id, "airbnb_search", variants, (variant) =>
    runAirbnbSearchVariant(id, params, variant),
  );
  await postResult(id, result);
}

function buildAirbnbDatedSearchUrl(searchTerm, checkIn, checkOut, bedrooms) {
  const safeSearchTerm = String(searchTerm || "").trim();
  const url = new URL(`https://www.airbnb.com/s/${encodeURIComponent(safeSearchTerm)}/homes`);
  url.searchParams.set("query", safeSearchTerm);
  url.searchParams.set("checkin", checkIn);
  url.searchParams.set("checkout", checkOut);
  url.searchParams.set("adults", "2");
  url.searchParams.set("min_bedrooms", String(bedrooms));
  url.searchParams.set("room_types[]", "Entire home/apt");
  url.searchParams.set("currency", "USD");
  url.searchParams.set("search_type", "filter_change");
  return url.toString();
}

function airbnbStateHasRequestedDates(state, checkIn, checkOut) {
  try {
    const url = new URL(String(state?.url || ""));
    return url.searchParams.get("checkin") === checkIn && url.searchParams.get("checkout") === checkOut;
  } catch {
    return false;
  }
}

async function runAirbnbSearchVariant(id, params, variant = null) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(variant?.searchTerm || searchTerm || destination || "").trim();
  const typedQuery = String(variant?.typedQuery || otaBaseSearchQuery(searchTerm, destination) || effectiveSearchTerm).trim();
  log(
    `airbnb_search ${id}: searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR`,
  );
  await ensureBrowser();
  await surfaceVisibleOtaSearchWindow(page, "airbnb_search", id);
  const primedDestination = await primeOtaHomepageSearch("https://www.airbnb.com/", effectiveSearchTerm, "airbnb_search", id, {
    inputTerm: typedQuery,
    targetSuggestion: variant?.suggestionText || null,
    submitAfterSearch: false,
  });
  if (!primedDestination) {
    const state = await dumpPageState("airbnb-unprimed-destination", { id, ...params }).catch(() => null);
    throw new ProviderBrowserUnavailableError(
      `Airbnb homepage did not confirm destination "${effectiveSearchTerm}" from the visible dropdown; refusing to submit the provider's default/geolocated search.`,
      {
        label: "airbnb_search",
        id,
        provider: "airbnb",
        url: page.url(),
        title: await page.title().catch(() => state?.title ?? ""),
        excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      },
    );
  }
  // NOTE FOR CODEX: Airbnb's homepage calendar can spin through months in
  // visible Chrome. We still require a provider dropdown-confirmed
  // destination above, but dates are applied through Airbnb's stable results
  // URL params so the worker does not scroll the calendar for every variant.
  const datedSearchUrl = buildAirbnbDatedSearchUrl(effectiveSearchTerm, checkIn, checkOut, bedrooms);
  await page.goto(datedSearchUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await dismissObstructions(page, "airbnb_search_after_dated_url");
  const bedroomFiltered = await fillBedroomFilter(page, bedrooms, "airbnb_search").catch(() => null);
  if (!bedroomFiltered) {
    log(`airbnb_search ${id}: bedroom filter was not found in visible UI; continuing with visible results and card-level bedroom filtering only`);
  }
  await page.waitForTimeout(PAGE_SETTLE_MS);
  const state = await dumpPageState("airbnb", { id, ...params });
  if (!airbnbStateHasRequestedDates(state, checkIn, checkOut)) {
    throw new ProviderBrowserUnavailableError(
      `Airbnb results URL did not keep requested dates ${checkIn}→${checkOut}; refusing stale/default-date results.`,
      {
        label: "airbnb_search",
        id,
        provider: "airbnb",
        url: state?.url,
        title: state?.title,
      },
    );
  }
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
    function imagesFrom(card) {
      const out = [];
      const seen = new Set();
      for (const img of Array.from(card.querySelectorAll("img"))) {
        const url = img?.currentSrc || img?.src || img?.getAttribute("data-src") || "";
        if (!/^https?:\/\//i.test(url)) continue;
        const cleanUrl = url.replace(/&amp;/g, "&").trim();
        const key = cleanUrl.replace(/[?#].*$/, "");
        if (!key || seen.has(key)) continue;
        if (/logo|icon|sprite|avatar|profile|map|placeholder/i.test(cleanUrl)) continue;
        seen.add(key);
        out.push(cleanUrl);
        if (out.length >= 3) break;
      }
      return out;
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
      const url = href.startsWith("http") ? href : new URL(href, "https://www.airbnb.com").toString();
      const images = imagesFrom(card);
      out.push({
        url,
        title: title.slice(0, 100),
        totalPrice: price.totalPrice,
        nightlyPrice: price.nightlyPrice,
        priceIncludesTaxes: price.priceIncludesTaxes,
        priceIncludesFees: price.priceIncludesFees,
        priceBasis: price.priceBasis,
        bedrooms: bedrooms ?? targetBedrooms,
        image: images[0],
        images,
        snippet: fullText.slice(0, 220),
      });
    }
    return out;
  }, { expectedNights, targetBedrooms: Number.parseInt(String(bedrooms ?? ""), 10), checkIn, checkOut });

  log(`airbnb_search ${id}: ${cards.length} priced room cards for "${effectiveSearchTerm}"`);
  return dedupeCandidatesByUrl(cards).map((card) => ({ ...card, searchVariant: effectiveSearchTerm }));
}

// ───────────────────────── VRBO search ──────────────────────────────
async function clickVisibleSearchSubmit(targetPage = page, label = "search", options = {}) {
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
      const isSearchSubmit = (el) => {
        const label = textOf(el);
        return /^(search|find|submit)$/i.test(label) ||
          (/\b(search|find stays|show stays|show properties)\b/i.test(label) && !/^search\s+for\b/i.test(label));
      };
      const target = candidates.find((el) => /^(search|find|submit)$/i.test(textOf(el))) ||
        candidates.find(isSearchSubmit);
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
    return clicked;
  }
  const vision = await askOtaVisionAction(
    targetPage,
    `${label}_vision_submit`,
    "Click the primary visible Search button for this OTA search form. Do not click ads, sign-in, app install, or navigation buttons.",
    { requestId: options.requestId, opType: label },
  );
  if (vision?.action === "click") {
    await targetPage.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
    return "vision search submit";
  }
  return null;
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
    const rawId = String(candidate?.vrboId || candidate?.propertyId || "").trim();
    const urlKey = String(candidate?.url || "").replace(/[?#].*$/, "");
    const key = rawId ? `id:${rawId}` : urlKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function cleanText(raw) {
  if (raw == null) return "";
  if (typeof raw === "object") return "";
  return String(raw || "").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function parseVrboAmount(raw) {
  const n = Number.parseFloat(String(raw || "").replace(/,/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function findFirstStringDeep(root, predicates, maxDepth = 7) {
  const stack = [{ value: root, path: "", depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { value, path, depth } = stack.pop();
    if (value == null || depth > maxDepth) continue;
    if (typeof value === "string") {
      const text = cleanText(value);
      if (text && predicates.some((predicate) => predicate(text, path))) return text;
      continue;
    }
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = Math.min(value.length - 1, 40); i >= 0; i--) {
        stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
    } else {
      const entries = Object.entries(value);
      for (let i = Math.min(entries.length - 1, 80); i >= 0; i--) {
        const [key, child] = entries[i];
        stack.push({ value: child, path: path ? `${path}.${key}` : key, depth: depth + 1 });
      }
    }
  }
  return "";
}

function collectStringsDeep(root, predicate, limit = 20, maxDepth = 7) {
  const out = [];
  const stack = [{ value: root, path: "", depth: 0 }];
  const seen = new Set();
  while (stack.length && out.length < limit) {
    const { value, path, depth } = stack.pop();
    if (value == null || depth > maxDepth) continue;
    if (typeof value === "string") {
      const text = cleanText(value);
      if (text && predicate(text, path)) out.push(text);
      continue;
    }
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = Math.min(value.length - 1, 80); i >= 0; i--) {
        stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
    } else {
      const entries = Object.entries(value);
      for (let i = Math.min(entries.length - 1, 120); i >= 0; i--) {
        const [key, child] = entries[i];
        stack.push({ value: child, path: path ? `${path}.${key}` : key, depth: depth + 1 });
      }
    }
  }
  return out;
}

function firstNumberDeep(root, keyPattern, min = 0, max = Number.POSITIVE_INFINITY, maxDepth = 6) {
  const stack = [{ value: root, path: "", depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { value, path, depth } = stack.pop();
    if (value == null || depth > maxDepth) continue;
    if (typeof value === "number" || typeof value === "string") {
      if (keyPattern.test(path)) {
        const n = typeof value === "number" ? value : Number.parseFloat(value.replace(/[^\d.]/g, ""));
        if (Number.isFinite(n) && n >= min && n <= max) return n;
      }
      continue;
    }
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const entries = Array.isArray(value) ? value.map((child, i) => [String(i), child]) : Object.entries(value);
    for (let i = Math.min(entries.length - 1, 80); i >= 0; i--) {
      const [key, child] = entries[i];
      stack.push({ value: child, path: path ? `${path}.${key}` : key, depth: depth + 1 });
    }
  }
  return null;
}

function extractLatLngDeep(root, maxDepth = 7) {
  const stack = [{ value: root, depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object" || depth > maxDepth) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value)) {
      const lat = Number(value.lat ?? value.latitude ?? value.geo?.lat ?? value.geo?.latitude);
      const lng = Number(value.lng ?? value.lon ?? value.longitude ?? value.geo?.lng ?? value.geo?.lon ?? value.geo?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (let i = Math.min(children.length - 1, 120); i >= 0; i--) {
      stack.push({ value: children[i], depth: depth + 1 });
    }
  }
  return null;
}

function extractVrboBedroomsFromText(raw) {
  const text = cleanText(raw).toLowerCase();
  const direct = text.match(/\b([1-9])\s*(?:br|bd|bdr|bedrooms?|bed\s*rooms?)\b/);
  if (direct) return Number.parseInt(direct[1], 10);
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  for (const [word, count] of Object.entries(words)) {
    if (new RegExp(`\\b${word}[\\s-]*(?:bedroom|bedrooms|bed\\s*rooms?)\\b`).test(text)) return count;
  }
  return null;
}

function extractVrboBathroomsFromText(raw) {
  const text = cleanText(raw).toLowerCase();
  const direct = text.match(/\b(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathrooms?)\b/);
  return direct ? Number.parseFloat(direct[1]) : null;
}

function extractVrboSleepsFromText(raw) {
  const text = cleanText(raw).toLowerCase();
  const direct =
    text.match(/\bsleeps?\s*(\d{1,2})\b/) ||
    text.match(/\b(\d{1,2})\s*(?:guests?|sleeps?)\b/);
  return direct ? Number.parseInt(direct[1], 10) : null;
}

function extractVrboRatingFromText(raw) {
  const text = cleanText(raw);
  const direct =
    text.match(/\b(\d(?:\.\d)?)\s*(?:out of\s*)?5\b/i) ||
    text.match(/\b(\d(?:\.\d)?)\s*(?:stars?|rating)\b/i);
  const value = direct ? Number.parseFloat(direct[1]) : null;
  return value !== null && value >= 0 && value <= 5 ? value : null;
}

function extractVrboReviewCountFromText(raw) {
  const text = cleanText(raw);
  const direct = text.match(/\b(\d{1,5})\s*reviews?\b/i);
  return direct ? Number.parseInt(direct[1], 10) : null;
}

function collectVrboBasicDetails(row, textBlob) {
  const details = collectStringsDeep(
    row,
    (text, path) => (
      text.length <= 120 &&
      /(?:bed|bath|sleep|guest|studio|condo|villa|townhome|house|apartment|location|neighborhood|rating|review)/i.test(`${path} ${text}`) &&
      !/\$|http|vrbo\.com|photo gallery|sign in|reserve|book now/i.test(text)
    ),
    7,
    7,
  );
  const textDetails = cleanText(textBlob)
    .split(/(?<=\b(?:bedrooms?|bathrooms?|guests?|sleeps?|reviews?))\b/i)
    .map((part) => cleanText(part).slice(0, 120))
    .filter((part) => /\b(?:bed|bath|sleep|guest|review)\b/i.test(part));
  return Array.from(new Set([...details, ...textDetails])).slice(0, 10);
}

function parseVrboPriceText(raw, expectedNights) {
  const text = cleanText(raw);
  if (!text) return null;
  const lower = text.toLowerCase();
  const totalMatch =
    text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:total|for\s+\d+\s+nights?)/i) ||
    text.match(/total(?:\s+before\s+taxes)?\s*\$\s*([\d,]+(?:\.\d+)?)/i);
  if (totalMatch) {
    const totalPrice = parseVrboAmount(totalMatch[1]);
    if (totalPrice > 0) {
      const includesTaxes = /\bincludes?\s+tax(?:es)?\b|\btaxes?\s*(?:and|&)\s*fees?\s*included\b/.test(lower);
      const beforeTaxes = /\bbefore\s+tax(?:es)?\b/.test(lower);
      return {
        totalPrice: Math.round(totalPrice),
        nightlyPrice: Math.round(totalPrice / expectedNights),
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
    const nightlyPrice = parseVrboAmount(nightlyMatch[1]);
    if (nightlyPrice > 0) {
      return {
        nightlyPrice: Math.round(nightlyPrice),
        totalPrice: Math.round(nightlyPrice * expectedNights),
        priceIncludesTaxes: false,
        priceIncludesFees: false,
        priceBasis: "nightly_base",
      };
    }
  }
  return null;
}

function normalizeVrboListingUrl(rawUrl, id) {
  const raw = cleanText(rawUrl);
  if (/^https?:\/\//i.test(raw)) return normalizeAbsoluteUrl(raw, "https://www.vrbo.com");
  if (/^\/\d+/.test(raw)) return normalizeAbsoluteUrl(raw, "https://www.vrbo.com");
  if (/^\d{5,}$/.test(String(id || ""))) return `https://www.vrbo.com/${id}`;
  return "";
}

function normalizeVrboGraphqlListing(row, expectedNights, variantLabel) {
  if (!row || typeof row !== "object") return null;
  const id = firstNonEmpty(
    row.id,
    row.listingId,
    row.propertyId,
    row.propertyMetadata?.id,
    row.cardLink?.resource?.value?.match?.(/\/(\d{5,})/)?.[1],
    row.cardLink?.uri?.value?.match?.(/\/(\d{5,})/)?.[1],
  );
  const url = normalizeVrboListingUrl(
    firstNonEmpty(
      row.cardLink?.resource?.value,
      row.cardLink?.uri?.value,
      row.cardLink?.url,
      row.url,
      row.href,
      findFirstStringDeep(row, [
        (text, path) => /(?:cardLink|propertyUrl|detailsUrl|url|href|resource|uri)/i.test(path) && /(?:vrbo\.com|^\/\d+)/i.test(text),
      ], 5),
    ),
    id,
  );
  if (!url) return null;

  const title = firstNonEmpty(
    row.headingSection?.heading,
    row.headingSection?.title,
    row.detailSection?.title,
    row.name,
    row.title,
    findFirstStringDeep(row, [
      (_text, path) => /(?:heading|title|name)$/i.test(path) && !/(badge|label|button|accessibility|price)/i.test(path),
    ], 5),
    id ? `Vrbo property ${id}` : "Vrbo property",
  ).replace(/^Photo gallery for\s*/i, "").slice(0, 110);

  const images = collectStringsDeep(
    row,
    (text, path) => /(?:image|photo|media|gallery|url|uri)/i.test(path) && /^https?:\/\//i.test(text) && !/logo|icon|sprite|avatar|profile|map|placeholder/i.test(text),
    5,
    7,
  );
  const textBlob = collectStringsDeep(row, (text) => text.length <= 260, 40, 6).join(" ");
  const bedrooms =
    firstNumberDeep(row, /bedrooms?|bedroomCount|bedCount|rooms\.bed/i, 1, 30, 6) ??
    extractVrboBedroomsFromText(textBlob);
  const bathrooms =
    firstNumberDeep(row, /bathrooms?|bathroomCount|bathCount|rooms\.bath/i, 0.5, 30, 6) ??
    extractVrboBathroomsFromText(textBlob);
  const sleeps =
    firstNumberDeep(row, /sleeps?|sleepCount|occupancy|maxOccupancy|guestCount|guests?|personCapacity|accommodates/i, 1, 100, 6) ??
    extractVrboSleepsFromText(textBlob);
  const rating =
    firstNumberDeep(row, /(?:^|\.)(?:rating|averageRating|overallRating|starRating|reviewScore|score)$/i, 0, 10, 6) ??
    extractVrboRatingFromText(textBlob);
  const reviewCount =
    firstNumberDeep(row, /(?:reviews?|reviewCount|totalReviews|reviewsCount)$/i, 0, 100000, 6) ??
    extractVrboReviewCountFromText(textBlob);
  const locationText = firstNonEmpty(
    row.location?.text,
    row.location?.name,
    row.neighborhood?.name,
    row.address?.localizedAddress,
    row.address?.city,
    findFirstStringDeep(row, [
      (text, path) => /(?:location|neighborhood|address|distance|region|city|area)/i.test(path) && text.length <= 120 && !/\$|http|check[- ]?in|check[- ]?out/i.test(text),
    ], 6),
  );
  const basicDetails = collectVrboBasicDetails(row, textBlob);
  const priceText = firstNonEmpty(
    row.priceSection?.priceSummary,
    row.priceSection?.primary?.lineItems?.map?.((x) => x?.value || x?.text)?.join(" "),
    row.priceSection?.primary?.text,
    row.priceSection?.price?.text,
    row.priceSection?.displayPrice,
    findFirstStringDeep(row, [
      (text, path) => /\$/.test(text) && /(?:price|total|rate|amount|summary|lineItems?)/i.test(path),
      (text) => /\$\s*[\d,]+/.test(text) && /\b(?:total|night|nights?|tax|fee)\b/i.test(text),
    ], 7),
  );
  const price = parseVrboPriceText(priceText || textBlob, expectedNights);
  const snippet = cleanText([priceText, textBlob].filter(Boolean).join(" ")).slice(0, 260);
  const coords = extractLatLngDeep(row);
  return {
    url,
    title,
    totalPrice: price?.totalPrice ?? 0,
    nightlyPrice: price?.nightlyPrice ?? 0,
    bedrooms: Number.isFinite(bedrooms) ? Math.round(bedrooms) : undefined,
    bathrooms: Number.isFinite(bathrooms) ? Math.round(bathrooms * 2) / 2 : undefined,
    sleeps: Number.isFinite(sleeps) ? Math.round(sleeps) : undefined,
    rating: Number.isFinite(rating) ? Math.round(rating * 10) / 10 : undefined,
    reviewCount: Number.isFinite(reviewCount) ? Math.round(reviewCount) : undefined,
    bedroomSource: Number.isFinite(bedrooms) ? "search-card" : "unknown",
    image: images[0],
    images,
    lat: coords?.lat,
    lng: coords?.lng,
    locationText: locationText || undefined,
    snippet,
    basicDetails,
    priceIncludesTaxes: price?.priceIncludesTaxes ?? false,
    priceIncludesFees: price?.priceIncludesFees ?? false,
    priceBasis: price?.priceBasis ?? "unknown",
    availabilityOnly: !price,
    vrboId: id || undefined,
    captureSource: "vrbo_graphql_propertySearchListings",
    searchVariant: variantLabel,
  };
}

function parseVrboGraphqlPostBody(postData) {
  const raw = String(postData || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry) => entry && typeof entry === "object");
    }
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {
    return null;
  }
  return null;
}

function isVrboPropertySearchGraphqlOperation(operation) {
  if (!operation || typeof operation !== "object") return false;
  const blob = [
    operation.operationName,
    operation.query,
    JSON.stringify(operation.variables ?? {}),
  ].join(" ").toLowerCase();
  return /propertysearch|searchlistings|lodgingsearch|propertysearchlistings|searchproperties|listingsearch/i.test(blob);
}

function extractVrboGraphqlPaginationMeta(root) {
  const meta = {
    hasNextPage: null,
    endCursor: null,
    offset: null,
    limit: null,
    totalCount: null,
    pageNumber: null,
  };
  const stack = [{ value: root, path: "", depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { value, path, depth } = stack.pop();
    if (value == null || depth > 14) continue;
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = Math.min(value.length - 1, 120); i >= 0; i--) {
        stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const lk = key.toLowerCase();
      if (lk === "hasnextpage" && typeof child === "boolean") meta.hasNextPage = child;
      if (lk === "hasmore" && typeof child === "boolean" && meta.hasNextPage == null) meta.hasNextPage = child;
      if ((lk === "endcursor" || lk === "nextcursor") && typeof child === "string" && child) meta.endCursor = child;
      if (lk === "cursor" && typeof child === "string" && child && !/^\{/.test(child)) meta.endCursor = meta.endCursor || child;
      if (lk === "offset" && Number.isFinite(Number(child))) meta.offset = Number(child);
      if ((lk === "limit" || lk === "pagesize" || lk === "page_size" || lk === "size") && Number.isFinite(Number(child))) {
        meta.limit = meta.limit ?? Number(child);
      }
      if (/^total(count|results|listings|records)?$/i.test(key) && Number.isFinite(Number(child))) {
        meta.totalCount = meta.totalCount ?? Number(child);
      }
      if ((lk === "pagenumber" || lk === "page" || lk === "pageindex") && Number.isFinite(Number(child))) {
        meta.pageNumber = Number(child);
      }
      if (child && typeof child === "object") {
        stack.push({ value: child, path: childPath, depth: depth + 1 });
      }
    }
  }
  return meta;
}

function extractVrboGraphqlOffsetLimitFromVariables(variables) {
  const found = { offset: null, limit: null };
  const stack = [{ value: variables, depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      const lk = key.toLowerCase();
      if (lk === "offset" && Number.isFinite(Number(child))) found.offset = Number(child);
      if ((lk === "limit" || lk === "pagesize" || lk === "page_size" || lk === "size") && Number.isFinite(Number(child))) {
        found.limit = Number(child);
      }
      if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
    }
  }
  return found;
}

function patchVrboGraphqlVariablesForNextPage(variables, paginationMeta, pagingState) {
  const next = JSON.parse(JSON.stringify(variables ?? {}));
  let patched = false;
  const cursor = paginationMeta?.endCursor || pagingState?.lastCursor || null;
  const nextOffset = pagingState?.nextOffset;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 10) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    for (const key of Object.keys(node)) {
      const lk = key.toLowerCase();
      if (cursor && /^(after|endcursor|cursor|nextcursor|pagetoken|nextpagetoken|continuationtoken)$/i.test(key)) {
        node[key] = cursor;
        patched = true;
      } else if (nextOffset != null && /^offset$/i.test(key)) {
        node[key] = nextOffset;
        patched = true;
      } else if (nextOffset != null && pagingState?.pageSize && /^(page|pagenumber|pageindex)$/i.test(key)) {
        node[key] = Math.floor(nextOffset / pagingState.pageSize);
        patched = true;
      } else if (typeof node[key] === "object") {
        walk(node[key], depth + 1);
      }
    }
  };
  walk(next);
  return { variables: next, patched };
}

function ingestVrboGraphqlPayload(rows, payload, expectedNights, variantLabel, maxRows, ingestState) {
  const listings = collectVrboPropertySearchListings(payload);
  const pagination = extractVrboGraphqlPaginationMeta(payload);
  if (
    pagination.hasNextPage !== null
    || pagination.endCursor
    || pagination.totalCount != null
    || pagination.offset != null
  ) {
    ingestState.lastPagination = {
      ...pagination,
      listingsInPage: listings.length,
      at: Date.now(),
    };
    if (pagination.endCursor) ingestState.lastCursor = pagination.endCursor;
    if (pagination.offset != null && pagination.limit) {
      ingestState.nextOffset = pagination.offset + pagination.limit;
      ingestState.pageSize = pagination.limit;
    }
  }
  if (listings.length === 0) return 0;
  ingestState.matchedResponses += 1;
  let added = 0;
  for (const listing of listings) {
    const normalized = normalizeVrboGraphqlListing(listing, expectedNights, variantLabel);
    if (normalized) {
      rows.push(normalized);
      added += 1;
    }
    if (rows.length >= maxRows) break;
  }
  return added;
}

function collectVrboPropertySearchListings(root, out = [], maxDepth = 10) {
  const stack = [{ value: root, path: "", depth: 0 }];
  const seen = new Set();
  while (stack.length && out.length < 600) {
    const { value, path, depth } = stack.pop();
    if (value == null || depth > maxDepth) continue;
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      if (/propertySearchListings|propertySearchResults|searchListings|listingSearch|lodgingSearch|searchResults/i.test(path)) {
        for (const item of value) {
          if (item && typeof item === "object") out.push(item);
          if (out.length >= 600) break;
        }
      }
      for (let i = Math.min(value.length - 1, 120); i >= 0; i--) {
        stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
    } else {
      for (const [key, child] of Object.entries(value).reverse()) {
        const childPath = path ? `${path}.${key}` : key;
        if (
          /^(propertySearchListings|propertySearchResults|searchListings|listingSearchResults|lodgingSearchListings)$/i.test(key)
          && Array.isArray(child)
        ) {
          for (const item of child) {
            if (item && typeof item === "object") out.push(item);
            if (out.length >= 600) break;
          }
        }
        stack.push({ value: child, path: childPath, depth: depth + 1 });
      }
    }
  }
  return out;
}

function createVrboGraphqlCollector(targetPage, id, expectedNights, variantLabel, maxRows = 400) {
  const rows = [];
  let responsesSeen = 0;
  let inFlight = 0;
  let requestTemplate = null;
  const ingestState = {
    matchedResponses: 0,
    lastPagination: null,
    lastCursor: null,
    nextOffset: null,
    pageSize: null,
  };
  const captureRequestTemplate = (request) => {
    try {
      const method = String(request?.method?.() || "").toUpperCase();
      if (method !== "POST") return;
      const url = String(request?.url?.() || "");
      if (!/vrbo\.com|expediagroup|egds|graphql/i.test(url)) return;
      const postData = request?.postData?.() || "";
      const operations = parseVrboGraphqlPostBody(postData);
      if (!operations?.length) return;
      const operation = operations.find(isVrboPropertySearchGraphqlOperation);
      if (!operation) return;
      requestTemplate = {
        url,
        operation,
        operations: operations.length > 1 ? operations : null,
        capturedAt: Date.now(),
      };
      const { offset, limit } = extractVrboGraphqlOffsetLimitFromVariables(operation.variables);
      if (offset != null && limit) {
        ingestState.nextOffset = offset + limit;
        ingestState.pageSize = limit;
      } else if (limit) {
        ingestState.pageSize = limit;
      }
      log(
        `vrbo_search ${id}: captured GraphQL request template ` +
        `op=${String(operation.operationName || "unknown").slice(0, 80)} url=${url.slice(0, 100)}`,
      );
    } catch (e) {
      log(`vrbo_search ${id}: GraphQL request capture skipped: ${e?.message ?? e}`);
    }
  };
  const ingestResponse = async (response) => {
    try {
      const request = response.request?.();
      const url = response.url?.() || "";
      const contentType = String(response.headers?.()?.["content-type"] || "");
      const method = request?.method?.() || "";
      if (!/vrbo\.com|expediagroup|egds|graphql/i.test(url)) return;
      if (!/json|graphql/i.test(contentType) && !/graphql/i.test(url)) return;
      if (response.status?.() >= 400) return;
      responsesSeen++;
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") return;
      const payloads = Array.isArray(payload) ? payload : [payload];
      let addedTotal = 0;
      let listingsSeenTotal = 0;
      for (const item of payloads) {
        if (VRBO_GRAPHQL_DUMP_ENABLED) {
          listingsSeenTotal += collectVrboPropertySearchListings(item).length;
        }
        const added = ingestVrboGraphqlPayload(rows, item, expectedNights, variantLabel, maxRows, ingestState);
        addedTotal += added;
        if (rows.length >= maxRows) break;
      }
      if (VRBO_GRAPHQL_DUMP_ENABLED) {
        let requestBody = null;
        try { requestBody = request?.postData?.() || null; } catch { requestBody = null; }
        // Only dump GraphQL responses whose payload actually carries the SRP
        // property-search root (data.propertySearch / propertySearchListings),
        // so the dump budget targets the listings grid query rather than the
        // dozens of supporting homepage/SRP module queries.
        const payloadStr = (() => { try { return JSON.stringify(payload); } catch { return ""; } })();
        const looksLikeSearchResults =
          /\"propertySearch\"|propertySearchListings|\"summary\".*\"resultMessages\"|\"listings\"\s*:\s*\[/i.test(payloadStr)
          || /mojoSection/i.test(payloadStr);
        const isGraphql = /\/graphql/i.test(url);
        if (isGraphql && (looksLikeSearchResults || listingsSeenTotal > 0)) {
          dumpVrboGraphqlArtifact("response", id, {
            url,
            method,
            contentType,
            status: response.status?.() ?? null,
            extractedListings: listingsSeenTotal,
            addedToRows: addedTotal,
            requestBody: requestBody ? String(requestBody).slice(0, 40000) : null,
            payload,
          });
        }
      }
      if (addedTotal > 0) {
        log(
          `vrbo_search ${id}: captured ${addedTotal} listing rows from ${method} ${url.slice(0, 120)} ` +
          `(hasNextPage=${ingestState.lastPagination?.hasNextPage ?? "?"}, endCursor=${ingestState.lastPagination?.endCursor ? "yes" : "no"})`,
        );
      }
    } catch (e) {
      log(`vrbo_search ${id}: VRBO network capture skipped response: ${e?.message ?? e}`);
    }
  };
  const responseHandler = (response) => {
    inFlight += 1;
    ingestResponse(response)
      .finally(() => {
        inFlight = Math.max(0, inFlight - 1);
      });
  };
  const requestHandler = (request) => captureRequestTemplate(request);
  const disposers = [];
  if (targetPage?.on) {
    targetPage.on("response", responseHandler);
    targetPage.on("request", requestHandler);
    disposers.push(() => targetPage.off?.("response", responseHandler));
    disposers.push(() => targetPage.off?.("request", requestHandler));
  }
  const browserContext = targetPage?.context?.();
  if (browserContext?.on) {
    browserContext.on("response", responseHandler);
    browserContext.on("request", requestHandler);
    disposers.push(() => browserContext.off?.("response", responseHandler));
    disposers.push(() => browserContext.off?.("request", requestHandler));
  }
  return {
    candidates: () => dedupeCandidatesByUrl(rows),
    getRequestTemplate: () => requestTemplate,
    getLastPagination: () => ingestState.lastPagination,
    stats: () => ({
      responsesSeen,
      matchedResponses: ingestState.matchedResponses,
      normalized: dedupeCandidatesByUrl(rows).length,
      inFlight,
      hasRequestTemplate: Boolean(requestTemplate),
      lastPagination: ingestState.lastPagination,
    }),
    async settle(label, maxWaitMs = 10_000) {
      const start = Date.now();
      let lastCount = -1;
      let stablePasses = 0;
      while (Date.now() - start < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        while (inFlight > 0 && Date.now() - start < maxWaitMs) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        const count = dedupeCandidatesByUrl(rows).length;
        if (count === lastCount) stablePasses += 1;
        else {
          stablePasses = 0;
          lastCount = count;
        }
        if (stablePasses >= 3 && inFlight === 0) {
          log(
            `vrbo_search ${id}: ${label} graphql settled at ${count} rows ` +
            `(${ingestState.matchedResponses}/${responsesSeen} matched responses)`,
          );
          return count;
        }
      }
      const count = dedupeCandidatesByUrl(rows).length;
      log(
        `vrbo_search ${id}: ${label} graphql settle timeout at ${count} rows ` +
        `(inFlight=${inFlight}, matched=${ingestState.matchedResponses}/${responsesSeen})`,
      );
      return count;
    },
    async replayNextGraphqlPage() {
      const template = requestTemplate;
      if (!template?.operation) return { ok: false, reason: "no-template" };
      const pagination = ingestState.lastPagination || {};
      if (pagination.hasNextPage === false) return { ok: false, reason: "hasNextPage=false" };
      const pagingState = {
        lastCursor: ingestState.lastCursor,
        nextOffset: ingestState.nextOffset,
        pageSize: ingestState.pageSize,
      };
      const { variables, patched } = patchVrboGraphqlVariablesForNextPage(
        template.operation.variables,
        pagination,
        pagingState,
      );
      if (!patched) return { ok: false, reason: "no-patch" };
      const replayPayload = {
        url: template.url,
        operationName: template.operation.operationName || "",
        query: template.operation.query || "",
        variables,
        batchOperations: template.operations,
      };
      let payload = null;
      try {
        payload = await targetPage.evaluate(async (replay) => {
          const headers = { "content-type": "application/json", accept: "application/json" };
          let body = "";
          if (Array.isArray(replay.batchOperations) && replay.batchOperations.length > 1) {
            const ops = replay.batchOperations.map((op) => {
              const sameOp =
                String(op.operationName || "") === String(replay.operationName || "") ||
                String(op.query || "") === String(replay.query || "");
              return sameOp ? { ...op, variables: replay.variables } : op;
            });
            body = JSON.stringify(ops);
          } else {
            body = JSON.stringify({
              operationName: replay.operationName || undefined,
              query: replay.query || undefined,
              variables: replay.variables,
            });
          }
          const res = await fetch(replay.url, {
            method: "POST",
            headers,
            credentials: "include",
            body,
          });
          if (!res.ok) return { __replayError: res.status };
          return res.json();
        }, replayPayload);
      } catch (e) {
        return { ok: false, reason: `evaluate-failed:${e?.message ?? e}` };
      }
      if (!payload || payload.__replayError) {
        return { ok: false, reason: `http-${payload?.__replayError ?? "unknown"}` };
      }
      const payloads = Array.isArray(payload) ? payload : [payload];
      let added = 0;
      for (const item of payloads) {
        added += ingestVrboGraphqlPayload(rows, item, expectedNights, variantLabel, maxRows, ingestState);
        if (rows.length >= maxRows) break;
      }
      if (ingestState.lastPagination?.offset != null && ingestState.lastPagination?.limit) {
        ingestState.nextOffset = ingestState.lastPagination.offset + ingestState.lastPagination.limit;
        ingestState.pageSize = ingestState.lastPagination.limit;
      } else if (ingestState.pageSize && ingestState.nextOffset != null) {
        ingestState.nextOffset += ingestState.pageSize;
      }
      return {
        ok: true,
        added,
        pagination: ingestState.lastPagination,
        total: dedupeCandidatesByUrl(rows).length,
      };
    },
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

async function scrollVrboResultsPaginationIntoView(targetPage) {
  return targetPage.evaluate(() => {
    const nextBtn = document.querySelector('[data-stid="next-button"]');
    if (nextBtn instanceof HTMLElement) {
      nextBtn.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return "next-button";
    }
    const cards = document.querySelectorAll('[data-stid="lodging-card-responsive"]');
    const last = cards[cards.length - 1];
    if (last instanceof HTMLElement) {
      last.scrollIntoView({ block: "end", behavior: "instant" });
      return "last-card";
    }
    window.scrollTo(0, document.body.scrollHeight);
    return "document-bottom";
  }).catch(() => null);
}

async function readVrboResultsPageRangeHint(targetPage) {
  return targetPage.evaluate(() => {
    const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
    const rangeMatch = text.match(/\b(\d{1,4})\s*[-–]\s*(\d{1,4})\s+of\s+(\d{1,4})\b/i);
    if (rangeMatch) {
      return {
        start: Number(rangeMatch[1]),
        end: Number(rangeMatch[2]),
        total: Number(rangeMatch[3]),
        range: `${rangeMatch[1]}-${rangeMatch[2]} of ${rangeMatch[3]}`,
      };
    }
    return null;
  }).catch(() => null);
}

async function isVrboResultsNextPageAvailable(targetPage) {
  return targetPage.evaluate(() => {
    const btn = document.querySelector('[data-stid="next-button"]');
    if (!(btn instanceof HTMLButtonElement)) return false;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    const style = window.getComputedStyle(btn);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
  }).catch(() => false);
}

async function clickVrboResultsNextPage(targetPage, id) {
  if (!targetPage || targetPage.isClosed?.()) return false;
  await scrollVrboResultsPaginationIntoView(targetPage);
  await boundedPageDelay(targetPage, 500);
  const clicked = await targetPage.evaluate(() => {
    function normalizeText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
    function isClickable(el) {
      if (!(el instanceof HTMLElement)) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
    }
    function tryClick(el, via) {
      if (!isClickable(el)) return null;
      try {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        el.click();
        return via;
      } catch {
        return null;
      }
    }

    const explicit = document.querySelector('[data-stid="next-button"]');
    const explicitVia = tryClick(explicit, "data-stid=next-button");
    if (explicitVia) return { ok: true, via: explicitVia };

    const candidates = Array.from(document.querySelectorAll('button[aria-label*="Next" i], button, a, [role="button"]'))
      .filter(isClickable);
    const next = candidates.find((el) => {
      const text = normalizeText(el.textContent);
      const aria = normalizeText(el.getAttribute("aria-label"));
      const testId = normalizeText(el.getAttribute("data-stid"));
      const hay = `${text} ${aria} ${testId}`;
      if (/(?:show|load|see|view)\s+(?:\d+\s+)?more|more\s+results|more\s+properties/i.test(hay)) return false;
      if (/\b(?:prev|previous|back)\b/i.test(hay)) return false;
      return /^(?:next|next page|›|»|→)$/i.test(text) ||
        /\bnext\s+page\b/i.test(hay) ||
        /(?:^|-)next-button$/i.test(testId) ||
        /pagination.*next|next.*pagination/i.test(testId) ||
        (/\bnext\b/i.test(aria) && /\b(?:page|result|listing|property)\b/i.test(aria));
    });
    const fallbackVia = next ? tryClick(next, "aria/text") : null;
    if (fallbackVia) return { ok: true, via: fallbackVia };
    return { ok: false, via: null };
  }).catch(() => ({ ok: false, via: null }));
  if (clicked?.ok) {
    log(`vrbo_search ${id}: clicked UI results Next page button via ${clicked.via}`);
    return true;
  }
  return false;
}

// Poll the visible "N-M of T" range until the start index advances past the
// previous page. VRBO swaps the SRP list asynchronously after a Next click, so
// harvesting immediately scrapes a transitional/duplicate page and the
// next-button briefly disappears — that combination is what truncated the walk.
async function waitForVrboResultsPageAdvance(targetPage, prevStart, timeoutMs = 9_000) {
  const deadline = Date.now() + Math.max(2_000, timeoutMs);
  let lastHint = null;
  while (Date.now() < deadline) {
    const hint = await readVrboResultsPageRangeHint(targetPage);
    lastHint = hint;
    if (hint?.start != null && (prevStart == null || hint.start > prevStart)) return hint;
    await boundedPageDelay(targetPage, 500);
  }
  return lastHint;
}

async function walkVrboResultsUiPages(targetPage, id, options = {}) {
  const maxPages = Math.min(14, Math.max(1, Number(options.maxPages) || 8));
  const passesPerPage = Math.max(4, Math.min(16, Number(options.passesPerPage) || 8));
  const targetTotal = Number.isFinite(Number(options.targetTotal)) && Number(options.targetTotal) > 0
    ? Math.round(Number(options.targetTotal))
    : null;
  let pagesWalked = 0;
  let stopReason = "ui-next-unavailable";
  const pageRanges = [];
  let prevStart = null;
  let prevHarvestTotal = 0;
  let noGrowthStreak = 0;

  for (let pageIdx = 0; pageIdx < maxPages; pageIdx += 1) {
    // Scroll the pagination footer into view: this drags the full 50-card page
    // through the viewport so VRBO's virtualized list instantiates every card
    // before we harvest. (Resetting to the top instead leaves the lower cards
    // unrendered and the per-page harvest only captures ~20 of 50.)
    await scrollVrboResultsPaginationIntoView(targetPage);
    await boundedPageDelay(targetPage, 700);

    const rangeHint = await readVrboResultsPageRangeHint(targetPage);
    if (rangeHint?.range) pageRanges.push(rangeHint.range);
    if (rangeHint?.start != null) prevStart = rangeHint.start;

    await harvestVrboMapResultCards(targetPage, id, passesPerPage, { exhaustive: false });
    const harvestTotal = await targetPage.evaluate(
      () => (Array.isArray(window.__vrboHarvestCards) ? window.__vrboHarvestCards.length : 0),
    ).catch(() => 0);

    log(
      `vrbo_search ${id}: UI page walk page=${pageIdx + 1}` +
      `${rangeHint?.range ? ` range=${rangeHint.range}` : ""} harvestTotal=${harvestTotal}` +
      `${targetTotal ? ` target=${targetTotal}` : ""}`,
    );

    // Reached and harvested the final page (e.g. "201-210 of 210") — stop clean.
    // This is the AUTHORITATIVE end signal: it reads the visible "X-Y of T"
    // results range, not the (frequently under-counted) targetTotal hint.
    if (rangeHint?.total && rangeHint?.end && rangeHint.end >= rangeHint.total) {
      stopReason = "range-end-reached";
      break;
    }

    // Next-button availability flickers during the page swap; re-check once
    // after a short settle before concluding we've hit the end.
    let nextAvail = await isVrboResultsNextPageAvailable(targetPage);
    if (!nextAvail) {
      await boundedPageDelay(targetPage, 1_000);
      nextAvail = await isVrboResultsNextPageAvailable(targetPage);
    }

    // The targetTotal hint (from readVrboResultsTotalHint) is only honored as a
    // stop signal when the blue Next button is GENUINELY unavailable. VRBO often
    // hasn't rendered the "N-M of T" results-count text when the hint is first
    // read, so its fallback can grab a stray small number (e.g. "25") that, if
    // trusted, short-circuits the walk on page 1 — the "145 results but only 48
    // exported" bug. While Next is still clickable there ARE more pages,
    // regardless of the hint. See AGENTS.md "VRBO city inventory export".
    if (!nextAvail) {
      if (targetTotal && harvestTotal >= targetTotal - 2) stopReason = "target-reached";
      else stopReason = pageIdx === 0 ? "ui-next-unavailable" : "ui-next-end";
      break;
    }

    // Guard against a non-advancing SRP: when the range text is absent (so
    // range-end-reached can't fire) but two consecutive pages add no new cards,
    // stop instead of clicking Next up to maxPages. A real new page adds ~50;
    // a stuck/duplicate page adds ~0.
    if (harvestTotal <= prevHarvestTotal + 2) {
      noGrowthStreak += 1;
      if (noGrowthStreak >= 2) {
        stopReason = "harvest-plateau";
        break;
      }
    } else {
      noGrowthStreak = 0;
    }
    prevHarvestTotal = harvestTotal;

    const clicked = await clickVrboResultsNextPage(targetPage, id);
    if (!clicked) {
      stopReason = pageIdx === 0 ? "ui-next-unavailable" : "ui-next-end";
      break;
    }
    pagesWalked += 1;
    // Block until the SRP actually advances to the next page before the next
    // iteration harvests it.
    const advancedHint = await waitForVrboResultsPageAdvance(targetPage, prevStart, 9_000);
    if (advancedHint?.start != null) prevStart = advancedHint.start;
    await dismissObstructions(targetPage, `vrbo_search_ui_page_${pagesWalked}`).catch(() => []);
  }

  const finalHarvestTotal = await targetPage.evaluate(
    () => (Array.isArray(window.__vrboHarvestCards) ? window.__vrboHarvestCards.length : 0),
  ).catch(() => 0);

  log(
    `vrbo_search ${id}: UI page walk done pages=${pagesWalked} harvestTotal=${finalHarvestTotal} stop=${stopReason}` +
    `${pageRanges.length ? ` ranges=[${pageRanges.join(", ")}]` : ""}`,
  );
  return { pagesWalked, stopReason, finalHarvestTotal, pageRanges };
}

async function paginateVrboGraphqlInventory(targetPage, networkCapture, id, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || 40);
  const maxRows = Math.max(50, Number(options.maxRows) || 500);
  const plateauLimit = Math.max(1, Number(options.plateauLimit) || 2);
  // City-wide export drives a dedicated UI page walk (walkVrboResultsUiPages)
  // that harvests every SRP page's DOM cards as it clicks the blue Next button.
  // GraphQL replay doesn't work on VRBO's list view (it yields 0 rows), so if we
  // let this phase fall back to UI-Next clicks it silently advances the SRP past
  // pages it never harvests — the walk then starts mid-list (e.g. "151-200 of
  // 210") and only captures the tail. For city-wide, stay GraphQL-replay-only so
  // the SRP remains on page 1 and the walk can harvest 1→N from the start.
  const allowUiNext = options.allowUiNext !== false;
  let replayPages = 0;
  let uiPages = 0;
  let plateau = 0;
  let lastCount = networkCapture.candidates().length;
  let stopReason = "max-pages";
  for (let pageIdx = 0; pageIdx < maxPages; pageIdx += 1) {
    const pagination = networkCapture.getLastPagination?.() || {};
    if (pagination.hasNextPage === false) {
      stopReason = "hasNextPage=false";
      log(`vrbo_search ${id}: graphql pagination stop hasNextPage=false at ${lastCount} rows`);
      break;
    }
    if (lastCount >= maxRows) {
      stopReason = "max-rows";
      break;
    }
    const replay = await networkCapture.replayNextGraphqlPage();
    if (replay?.ok) {
      replayPages += 1;
      await networkCapture.settle(`graphql-pagination-replay-${replayPages}`, 8_000);
      const newCount = networkCapture.candidates().length;
      const meta = replay.pagination || networkCapture.getLastPagination?.() || {};
      log(
        `vrbo_search ${id}: graphql pagination replay page=${replayPages} added=${replay.added ?? 0} ` +
        `total=${newCount} hasNextPage=${meta.hasNextPage ?? "?"} endCursor=${meta.endCursor ? "yes" : "no"} ` +
        `offset=${meta.offset ?? "?"} totalCount=${meta.totalCount ?? "?"}`,
      );
      if (newCount <= lastCount) plateau += 1;
      else plateau = 0;
      lastCount = newCount;
      if (plateau >= plateauLimit) {
        stopReason = "plateau";
        log(`vrbo_search ${id}: graphql pagination plateau at ${newCount} rows after ${replayPages} replay pages`);
        break;
      }
      if (networkCapture.getLastPagination?.()?.hasNextPage === false) {
        stopReason = "hasNextPage=false";
        break;
      }
      continue;
    }
    if (!allowUiNext) {
      stopReason = replay?.reason ? `replay-${replay.reason}-no-ui` : "graphql-replay-exhausted";
      log(
        `vrbo_search ${id}: graphql pagination stop (ui-next disabled for city-wide) at ${lastCount} rows ` +
        `after ${replayPages} replay page(s); UI page walk will harvest from page 1`,
      );
      break;
    }
    const clicked = await clickVrboResultsNextPage(targetPage, id);
    if (!clicked) {
      stopReason = replay?.reason ? `replay-${replay.reason}` : "ui-next-unavailable";
      log(
        `vrbo_search ${id}: graphql pagination stop (${stopReason}, ui-next=false) at ${lastCount} rows ` +
        `(replayPages=${replayPages}, uiPages=${uiPages})`,
      );
      break;
    }
    uiPages += 1;
    await networkCapture.settle(`graphql-pagination-ui-next-${uiPages}`, 8_000);
    const newCount = networkCapture.candidates().length;
    log(
      `vrbo_search ${id}: graphql pagination UI next page=${uiPages} total=${newCount} ` +
      `hasNextPage=${networkCapture.getLastPagination?.()?.hasNextPage ?? "?"}`,
    );
    if (newCount <= lastCount) plateau += 1;
    else plateau = 0;
    lastCount = newCount;
    if (plateau >= plateauLimit) {
      stopReason = "plateau";
      log(`vrbo_search ${id}: graphql pagination plateau at ${newCount} rows after ${uiPages} UI next clicks`);
      break;
    }
    if (networkCapture.getLastPagination?.()?.hasNextPage === false) {
      stopReason = "hasNextPage=false";
      break;
    }
  }
  return {
    replayPages,
    uiPages,
    finalCount: lastCount,
    stopReason,
    lastPagination: networkCapture.getLastPagination?.() || null,
  };
}

async function fillVisibleSearchField(targetPage, searchTerm, label = "site_search", options = {}) {
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
          el.getAttribute?.("role"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("data-test"),
        ];
        for (const attr of ["aria-labelledby", "aria-describedby"]) {
          const ids = String(el.getAttribute?.(attr) || "").split(/\s+/).filter(Boolean);
          for (const refId of ids) {
            const ref = document.getElementById(refId);
            if (ref) parts.push(ref.textContent);
          }
        }
        const id = el.getAttribute?.("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push(label.textContent);
        }
        const wrappingLabel = el.closest?.("label");
        if (wrappingLabel) parts.push(wrappingLabel.textContent);
        const searchRegion = el.closest?.("form, [role='search'], [data-testid*='search' i], [class*='search' i], [aria-label*='search' i]");
        if (searchRegion) {
          const txt = (searchRegion.textContent || "").replace(/\s+/g, " ").trim();
          if (txt.length <= 220) parts.push(txt);
        }
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function setValue(el) {
        try { el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
        try { el.focus?.(); } catch {}
        const tag = el.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea") {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
          if (setter) setter.call(el, searchTerm);
          else el.value = searchTerm;
        } else if (el.isContentEditable || el.getAttribute?.("role") === "textbox" || el.getAttribute?.("role") === "combobox") {
          el.textContent = searchTerm;
        } else {
          return false;
        }
        for (const name of ["input", "change"]) {
          el.dispatchEvent(new Event(name, { bubbles: true }));
        }
        return true;
      }

      const controls = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, [contenteditable='true'], [role='textbox'], [role='combobox'], [aria-autocomplete], [aria-haspopup='listbox'], [aria-controls]"))
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
    if (options?.chooseSuggestion !== false) {
      const suggestion = await chooseVisibleDestinationSuggestion(targetPage, searchTerm, label, options?.targetSuggestion || null, { requestId: options.requestId }).catch(() => null);
      return { filled, suggestion };
    }
  }
  if (filled) return { filled, suggestion: null };
  const vision = await askOtaVisionAction(
    targetPage,
    `${label}_vision_fill`,
    `Find and focus the visible destination/location/search field. The intended search text is "${searchTerm}".`,
    { requestId: options.requestId, opType: label },
  );
  if (vision?.action === "click") {
    await targetPage.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await targetPage.keyboard.press("Backspace").catch(() => {});
    await targetPage.keyboard.type(searchTerm, { delay: 35 }).catch(() => {});
    await targetPage.waitForTimeout(1_000).catch(() => {});
    const suggestion = options?.chooseSuggestion !== false
      ? await chooseVisibleDestinationSuggestion(targetPage, searchTerm, label, options?.targetSuggestion || null, { requestId: options.requestId }).catch(() => null)
      : null;
    return { filled: "vision destination field", suggestion };
  }
  return null;
}

async function chooseVisibleDestinationSuggestion(targetPage, searchTerm, label = "site_search", targetSuggestion = null, options = {}) {
  return selectVisibleDestinationSuggestion(targetPage, searchTerm, label, targetSuggestion, options);
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

async function processVrboSearch(id, params) {
  const { destination, searchTerm } = params;
  const effectiveSearchTerm = String(searchTerm || destination || "").trim();
  await ensureBrowser();
  if (params?.searchMode === "map_bounds" || params?.mapSearch?.enabled) {
    const mapVariant = {
      typedQuery: effectiveSearchTerm,
      searchTerm: effectiveSearchTerm,
      suggestionText: params?.mapSearch?.targetName || effectiveSearchTerm,
      source: "map-bounds",
    };
    const mapResult = await runVrboMapBoundsSearchVariant(id, params, mapVariant);
    const rawCards = Array.isArray(mapResult) ? mapResult : (mapResult?.candidates ?? []);
    const uniqueCards = dedupeCandidatesByUrl(rawCards);
    await postResult(id, {
      candidates: uniqueCards,
      mapHarvest: Array.isArray(mapResult) ? null : (mapResult?.mapHarvest ?? null),
      variationsTried: [{
        term: effectiveSearchTerm,
        typedQuery: effectiveSearchTerm,
        suggestionText: mapVariant.suggestionText,
        source: "map-bounds",
        success: true,
        candidateCount: uniqueCards.length,
      }],
    });
    return;
  }
  const variants = await discoverOtaSearchVariants("https://www.vrbo.com/", effectiveSearchTerm, destination, "vrbo_search", id, params);
  const result = await runOtaSearchVariants(id, "vrbo_search", variants, (variant) =>
    runVrboSearchVariant(id, params, variant),
    { stopAfterDuplicateResults: true, maxDuplicateResultRuns: 2 },
  );
  await postResult(id, result);
}

function numericMapBounds(params) {
  const b = params?.mapSearch?.bounds;
  if (!b) return null;
  const bounds = {
    sw_lat: Number(b.sw_lat),
    sw_lng: Number(b.sw_lng),
    ne_lat: Number(b.ne_lat),
    ne_lng: Number(b.ne_lng),
  };
  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

function vrboMapCenter(params) {
  const c = params?.mapSearch?.center;
  const lat = Number(c?.lat);
  const lng = Number(c?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  const b = numericMapBounds(params);
  if (!b) return null;
  return {
    lat: (b.sw_lat + b.ne_lat) / 2,
    lng: (b.sw_lng + b.ne_lng) / 2,
  };
}

function formatMapBoundsForLog(bounds, precision = 5) {
  if (!bounds) return "none";
  return [
    bounds.sw_lat,
    bounds.sw_lng,
    bounds.ne_lat,
    bounds.ne_lng,
  ].map((n) => Number(n).toFixed(precision)).join(",");
}

function formatMapCenterForLog(center) {
  if (!center) return "none";
  return `${Number(center.lat).toFixed(6)},${Number(center.lng).toFixed(6)}`;
}

function logProviderMapSearchPlan(label, id, providerName, params, effectiveSearchTerm, url) {
  const bounds = numericMapBounds(params);
  const center = vrboMapCenter(params);
  const urlHasMapBounds = /[?&]mapBounds=/i.test(String(url || ""));
  const urlHasLatLong = /[?&]latLong=/i.test(String(url || ""));
  const urlHasMapMode = /[?&]map=1(?:&|$)/i.test(String(url || ""));
  log(
    `${label} ${id}: map-search-plan provider=${providerName} ` +
    `mode=${params?.searchMode || "default"} enabled=${Boolean(params?.mapSearch?.enabled)} ` +
    `term="${effectiveSearchTerm}" destination="${params?.destination || ""}" ` +
    `target="${params?.mapSearch?.targetName || ""}" ` +
    `center=${formatMapCenterForLog(center)} radiusKm=${Number.isFinite(Number(params?.mapSearch?.radiusKm)) ? Number(params.mapSearch.radiusKm).toFixed(2) : "none"} ` +
    `bounds=${formatMapBoundsForLog(bounds)} urlHasMapBounds=${urlHasMapBounds} urlHasLatLong=${urlHasLatLong} urlHasMapMode=${urlHasMapMode}`,
  );
}

function vrboMapMinBedrooms(bedrooms) {
  const n = Number.parseInt(String(bedrooms ?? ""), 10);
  // Buy-in map scans need at least 2BR in the VRBO filter so 1BR map pins
  // do not dominate Princeville/Kauai results while the server still applies
  // the per-slot bedroom floor afterward.
  return Math.max(2, Number.isFinite(n) && n > 0 ? n : 1);
}

function buildVrboMapSearchUrl(params, searchTerm) {
  const { checkIn, checkOut, bedrooms } = params;
  const url = new URL("https://www.vrbo.com/search");
  url.searchParams.set("destination", String(searchTerm || params.destination || ""));
  url.searchParams.set("startDate", checkIn);
  url.searchParams.set("endDate", checkOut);
  url.searchParams.set("adults", "2");
  url.searchParams.set("minBedrooms", String(vrboMapMinBedrooms(bedrooms)));
  url.searchParams.set("sort", "PRICE_RELEVANT");
  const center = vrboMapCenter(params);
  if (center) {
    // Vrbo's public URL schema is not formally documented, but current
    // map URLs commonly preserve a latLong hint. The visible map/search
    // area controls below remain authoritative if Vrbo ignores this hint.
    url.searchParams.set("latLong", `${center.lat.toFixed(6)},${center.lng.toFixed(6)}`);
  }
  const b = numericMapBounds(params);
  if (b) {
    url.searchParams.set("mapBounds", [b.sw_lat, b.sw_lng, b.ne_lat, b.ne_lng].map((n) => n.toFixed(6)).join(","));
  }
  return url.toString();
}

async function clickVrboListViewControl(targetPage, label, id) {
  const result = await targetPage.evaluate(() => {
    function visible(el) {
      if (!el || !(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
    }
    const controls = Array.from(document.querySelectorAll("button, a[role='button'], a[href]"))
      .filter(visible)
      .map((el) => ({
        el,
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        aria: el.getAttribute("aria-label") || "",
      }));
    const listButton = controls.find((c) => {
      const hay = `${c.text} ${c.aria}`;
      // Exclude VRBO's host CTAs ("List your property", "List your home") — the
      // old `\blist\b` test matched those and clicked them, opening a stray tab.
      if (/\blist\s+(?:your|a|my)\s+(?:property|home|place|space)\b|become\s+a\s+host/i.test(hay)) return false;
      // Only a genuine list/map VIEW toggle: an explicit "list view" phrase or a
      // control whose entire label is just "List".
      return /\b(?:view\s+as\s+list|list\s+view|show\s+(?:results\s+)?list|view\s+list)\b/i.test(hay)
        || /^\s*list\s*$/i.test(c.text)
        || /^\s*(?:show|view)\s+list\s*$/i.test(c.aria);
    });
    if (listButton) {
      listButton.el.scrollIntoView({ block: "center", inline: "center" });
      listButton.el.click();
      return { clicked: true, label: `${listButton.text} ${listButton.aria}`.trim().slice(0, 80) };
    }
    return { clicked: false };
  }).catch((e) => ({ clicked: false, error: e?.message ?? String(e) }));
  if (result.clicked) {
    log(`${label} ${id}: opened VRBO list view via "${result.label}"`);
    await boundedPageDelay(targetPage, 1_500);
    await dismissObstructions(targetPage, `${label}_list`).catch(() => []);
  }
  return result.clicked;
}

async function readVrboResultsTotalHint(targetPage) {
  return targetPage.evaluate(() => {
    const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
    // Hard floor: the hint must never report fewer than the property cards that
    // are actually rendered right now. This kills the "stray small number"
    // misparse (e.g. a nearby-area module's "25 rentals") that would otherwise
    // short-circuit the city-wide page walk below its own first page.
    const renderedCards = document.querySelectorAll('[data-stid="lodging-card-responsive"]').length;
    const rangeMatch = text.match(/\b(\d{1,4})\s*[-–]\s*(\d{1,4})\s+of\s+(\d{1,4})\b/i);
    if (rangeMatch) {
      return {
        visible: Number(rangeMatch[2]) - Number(rangeMatch[1]) + 1,
        total: Math.max(Number(rangeMatch[3]), renderedCards),
        range: `${rangeMatch[1]}-${rangeMatch[2]} of ${rangeMatch[3]}`,
      };
    }
    // Explicit "showing/viewing N of M" or "N of M stays/properties" carry a real
    // total (capture group 2) — trust those.
    const explicitOfTotal = [
      /\b(?:showing|viewing)\s+(\d{1,4})\s+of\s+(\d{1,4})\b/i,
      /\b(\d{1,4})\s+of\s+(\d{1,4})\s+(?:stays?|properties|results?|rentals?|homes?)\b/i,
    ];
    for (const re of explicitOfTotal) {
      const m = text.match(re);
      if (m && m[2]) return { visible: Number(m[1]), total: Math.max(Number(m[2]), renderedCards) };
    }
    // Bare "N properties/stays/results/rentals" — unreliable (it appears in
    // related-search and card-snippet text too), so floor it by the rendered
    // card count rather than trusting it outright.
    const bare = text.match(/\b(\d{1,4})\s+(?:stays?|properties|results?|rentals?|vacation\s+rentals?|homes?)\b/i);
    const bareTotal = bare ? Number(bare[1]) : 0;
    const total = Math.max(bareTotal, renderedCards);
    if (total > 0) return { visible: null, total };
    return null;
  }).catch(() => null);
}

async function clickVrboMapControl(targetPage, label, id) {
  const result = await targetPage.evaluate(() => {
    function visible(el) {
      if (!el || !(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
    }
    const controls = Array.from(document.querySelectorAll("button, a[role='button'], a[href]"))
      .filter(visible)
      .map((el) => ({
        el,
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        aria: el.getAttribute("aria-label") || "",
        href: el.getAttribute("href") || "",
      }));
    const mapButton = controls.find((c) => /\b(view\s+)?map(\s+view)?\b|show\s+map|view\s+in\s+map/i.test(`${c.text} ${c.aria}`));
    if (mapButton) {
      mapButton.el.scrollIntoView({ block: "center", inline: "center" });
      mapButton.el.click();
      return { clicked: true, label: `${mapButton.text} ${mapButton.aria}`.trim().slice(0, 80) };
    }
    return { clicked: false };
  }).catch((e) => ({ clicked: false, error: e?.message ?? String(e) }));
  if (result.clicked) {
    log(`${label} ${id}: opened VRBO map view via "${result.label}"`);
    await boundedPageDelay(targetPage, 1_500);
    await dismissObstructions(targetPage, `${label}_map`).catch(() => []);
  }
  return result.clicked;
}

async function clickVrboSearchThisArea(targetPage, label, id) {
  const result = await targetPage.evaluate(() => {
    function visible(el) {
      if (!el || !(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
    }
    const buttons = Array.from(document.querySelectorAll("button, a[role='button']"))
      .filter(visible)
      .map((el) => ({
        el,
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        aria: el.getAttribute("aria-label") || "",
      }));
    const searchArea = buttons.find((b) => /\bsearch\s+(this\s+)?area\b|redo\s+search\s+in\s+map|update\s+results/i.test(`${b.text} ${b.aria}`));
    if (searchArea) {
      searchArea.el.scrollIntoView({ block: "center", inline: "center" });
      searchArea.el.click();
      return { clicked: true, label: `${searchArea.text} ${searchArea.aria}`.trim().slice(0, 80) };
    }
    return { clicked: false };
  }).catch((e) => ({ clicked: false, error: e?.message ?? String(e) }));
  if (result.clicked) {
    log(`${label} ${id}: clicked VRBO map area search "${result.label}"`);
    await boundedPageDelay(targetPage, 2_000);
  }
  return result.clicked;
}

async function disableVrboSearchAsMapMoves(targetPage, label, id) {
  const result = await targetPage.evaluate(() => {
    function visible(el) {
      if (!el || !(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
    }
    function textOf(el) {
      return [
        el?.textContent || "",
        el?.getAttribute?.("aria-label") || "",
        el?.getAttribute?.("title") || "",
      ].join(" ").replace(/\s+/g, " ").trim();
    }
    function isMoveMapControlText(text) {
      return /\bsearch\s+(?:as|when|while)\s+i\s+move\s+(?:the\s+)?map\b|\bsearch\s+(?:this\s+)?area\s+when\s+(?:the\s+)?map\s+moves\b|\bupdate\s+results\s+when\s+map\s+moves\b/i.test(text);
    }
    const candidates = [];
    for (const labelEl of Array.from(document.querySelectorAll("label"))) {
      if (!visible(labelEl) || !isMoveMapControlText(textOf(labelEl))) continue;
      const forId = labelEl.getAttribute("for");
      const linked = forId ? document.getElementById(forId) : null;
      const nested = labelEl.querySelector("input[type='checkbox'], [role='switch'], [role='checkbox']");
      const control = linked || nested;
      if (control) candidates.push({ control, label: textOf(labelEl) });
    }
    for (const control of Array.from(document.querySelectorAll("input[type='checkbox'], [role='switch'], [role='checkbox'], button"))) {
      if (!visible(control)) continue;
      const wrapper = control.closest("label, [role='group'], div, section, aside") || control;
      const text = `${textOf(control)} ${textOf(wrapper)}`;
      if (isMoveMapControlText(text)) candidates.push({ control, label: text.slice(0, 100) });
    }
    const seen = new Set();
    for (const item of candidates) {
      const control = item.control;
      if (!control || seen.has(control)) continue;
      seen.add(control);
      const ariaChecked = control.getAttribute?.("aria-checked");
      const pressed = control.getAttribute?.("aria-pressed");
      const checked = control instanceof HTMLInputElement
        ? control.checked
        : ariaChecked === "true" || pressed === "true" || control.className?.toString?.().match?.(/\bchecked|selected|active\b/i);
      if (!checked) return { found: true, changed: false, label: item.label };
      control.scrollIntoView({ block: "center", inline: "center" });
      control.click();
      return { found: true, changed: true, label: item.label };
    }
    return { found: false, changed: false };
  }).catch((e) => ({ found: false, changed: false, error: e?.message ?? String(e) }));
  if (result.changed) {
    log(`${label} ${id}: turned off VRBO map auto-search "${result.label || "search as map moves"}"`);
    await boundedPageDelay(targetPage, 900);
  } else if (result.found) {
    log(`${label} ${id}: VRBO map auto-search already off "${result.label || "search as map moves"}"`);
  } else {
    log(`${label} ${id}: VRBO map auto-search toggle not found; continuing without viewport search`);
  }
  return Boolean(result.found);
}

async function extractVisibleVrboCards(id, params, expectedNights, variantLabel, options = {}) {
  const mapMinBedrooms = Number.isFinite(options.minBedrooms)
    ? Math.max(1, Math.floor(options.minBedrooms))
    : vrboMapMinBedrooms(params?.bedrooms);
  const result = await page.evaluate((args) => {
    const { expectedNights, mapMinBedrooms } = args;

    function cardImageUrl(card) {
      const imgs = card.querySelectorAll?.("img") || [];
      for (const img of imgs) {
        const src = img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
        if (/^https?:/i.test(src) && /(?:trvl-media|mediaim\.expedia|odis\.homeaway|vrbo\.com|homeaway\.com)/i.test(src)) {
          return src;
        }
      }
      return "";
    }
    function cardRowFromElement(card) {
      const titleEl = card.querySelector?.("h3");
      const link = card.querySelector?.("a[href]");
      return {
        title: titleEl ? titleEl.textContent.trim().replace(/^Photo gallery for\s*/i, "") : "",
        fullText: (card.textContent || "").replace(/\s+/g, " "),
        href: link?.getAttribute("href") || "",
        image: cardImageUrl(card),
      };
    }

    let cardEls = Array.from(document.querySelectorAll('[data-stid="lodging-card-responsive"]'));
    let selectorSource = "data-stid";
    if (cardEls.length === 0) {
      const propertyAnchors = Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => /^\/\d+/.test(a.getAttribute("href") || ""));
      const cardSet = new Set();
      for (const a of propertyAnchors) {
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
    const harvestedRows = Array.isArray(window.__vrboHarvestCards) ? window.__vrboHarvestCards : [];
    if (harvestedRows.length > 0) selectorSource = `${selectorSource}+harvest`;

    const out = [];
    const drops = { noUrl: 0, noPrice: 0, noBedrooms: 0, belowMinBedrooms: 0 };
    let firstCardSample = null;
    const seenRows = new Set();
    const rows = [
      ...cardEls.map(cardRowFromElement),
      ...harvestedRows.map((row) => ({
        title: String(row?.title || ""),
        fullText: String(row?.fullText || ""),
        href: String(row?.href || ""),
        image: String(row?.image || ""),
      })),
    ].filter((row) => {
      const key = `${row.href}|${row.title}|${row.fullText.slice(0, 160)}`;
      if (seenRows.has(key)) return false;
      seenRows.add(key);
      return true;
    });
    const seenOut = new Set();
    for (const row of rows) {
      const title = row.title;
      const fullText = row.fullText;
      const image = row.image && /^https?:/i.test(row.image) ? row.image : undefined;
      const bdMatch = fullText.match(/(\d+)\s*bedrooms?/i);
      const bathMatch = fullText.match(/\b(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathrooms?)\b/i);
      const sleepMatch = fullText.match(/\bsleeps?\s*(\d{1,2})\b/i) || fullText.match(/\b(\d{1,2})\s*guests?\b/i);
      const ratingMatch = fullText.match(/\b(\d(?:\.\d)?)\s*(?:out of\s*)?5\b/i) || fullText.match(/\b(\d(?:\.\d)?)\s*(?:stars?|rating)\b/i);
      const reviewMatch = fullText.match(/\b(\d{1,5})\s*reviews?\b/i);
      const propertyPath = row.href.replace(/^https?:\/\/[^\/]+/, "").split("?")[0];
      const bedroomsExtracted = bdMatch ? parseInt(bdMatch[1], 10) : null;
      const bathroomsExtracted = bathMatch ? Math.round(parseFloat(bathMatch[1]) * 2) / 2 : undefined;
      const sleepsExtracted = sleepMatch ? parseInt(sleepMatch[1], 10) : undefined;
      const ratingExtracted = ratingMatch ? Math.round(parseFloat(ratingMatch[1]) * 10) / 10 : undefined;
      const reviewCountExtracted = reviewMatch ? parseInt(reviewMatch[1], 10) : undefined;
      const basicDetails = Array.from(new Set(
        fullText
          .split(/(?:·|\||•|\n)/)
          .map((part) => part.replace(/\s+/g, " ").trim())
          .filter((part) => part.length > 0 && part.length <= 100 && /\b(?:bed|bath|sleep|guest|review|condo|villa|townhome|home|apartment)\b/i.test(part))
      )).slice(0, 8);
      const locationText = (fullText.match(/\b(?:in|near)\s+([A-Z][A-Za-z ,'-]{3,80})/)?.[1] || "").trim() || undefined;

      if (firstCardSample === null) {
        firstCardSample = {
          title: title.slice(0, 80),
          textExcerpt: fullText.slice(0, 240),
          propertyPath: propertyPath.slice(0, 80),
          bedroomsExtracted,
        };
      }

      if (!/^\/\d+/.test(propertyPath)) { drops.noUrl++; continue; }
      if (bedroomsExtracted === null) { drops.noBedrooms++; continue; }
      if (bedroomsExtracted < mapMinBedrooms) { drops.belowMinBedrooms++; continue; }

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
      if (!(totalPrice > 0) || !(totalNights > 0)) {
        drops.noPrice++;
        const candidate = {
          url: "https://www.vrbo.com" + propertyPath,
          title: title.slice(0, 80),
          image,
          images: image ? [image] : undefined,
	          totalPrice: 0,
	          nightlyPrice: 0,
	          bedrooms: bedroomsExtracted,
	          bathrooms: bathroomsExtracted,
	          sleeps: sleepsExtracted,
	          rating: ratingExtracted,
	          reviewCount: reviewCountExtracted,
	          locationText,
	          snippet: fullText.slice(0, 260),
	          basicDetails,
	          priceIncludesTaxes: false,
	          priceIncludesFees: false,
	          priceBasis: "unknown",
	          availabilityOnly: true,
	          captureSource: "vrbo_dom_search_card",
	        };
        const candidateKey = `${candidate.url}|${candidate.bedrooms}|${candidate.totalPrice}|${candidate.title}`;
        if (!seenOut.has(candidateKey)) {
          seenOut.add(candidateKey);
          out.push(candidate);
        }
        continue;
      }

      const candidate = {
        url: "https://www.vrbo.com" + propertyPath,
        title: title.slice(0, 80),
        image,
        images: image ? [image] : undefined,
	        totalPrice,
	        nightlyPrice: Math.round(totalPrice / totalNights),
	        bedrooms: bedroomsExtracted,
	        bathrooms: bathroomsExtracted,
	        sleeps: sleepsExtracted,
	        rating: ratingExtracted,
	        reviewCount: reviewCountExtracted,
	        locationText,
	        snippet: fullText.slice(0, 260),
	        basicDetails,
	        priceIncludesTaxes,
	        priceIncludesFees,
	        priceBasis,
	        captureSource: "vrbo_dom_search_card",
	      };
      const candidateKey = `${candidate.url}|${candidate.bedrooms}|${candidate.totalPrice}|${candidate.title}`;
      if (!seenOut.has(candidateKey)) {
        seenOut.add(candidateKey);
        out.push(candidate);
      }
    }
    return {
      out,
      drops,
      totalSeen: rows.length,
      domSeen: cardEls.length,
      harvestSeen: harvestedRows.length,
      selectorSource,
      firstCardSample,
    };
  }, { expectedNights, mapMinBedrooms });

  const cards = result.out;
  const allInCount = cards.filter((c) => c.priceIncludesTaxes).length;
  const brList = cards.map((c) => c.bedrooms ?? "?").join(",");
  log(
    `vrbo_search ${id}: ${cards.length} cards (${allInCount} all-in / ${cards.length - allInCount} pre-tax) ` +
    `[selector=${result.totalSeen}/${result.selectorSource}, dom=${result.domSeen ?? 0}, harvest=${result.harvestSeen ?? 0}, drops=noUrl:${result.drops.noUrl}/noPrice:${result.drops.noPrice}/noBR:${result.drops.noBedrooms}/belowMinBR:${result.drops.belowMinBedrooms ?? 0}, BRs=[${brList}]]`,
  );
  if (cards.length === 0 && result.firstCardSample) {
    log(`vrbo_search ${id}: empty-result diagnostic — first card title="${result.firstCardSample.title}" path="${result.firstCardSample.propertyPath}" br=${result.firstCardSample.bedroomsExtracted} text="${result.firstCardSample.textExcerpt}"`);
  }
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
  return {
    cards: cards.map((card) => ({ ...card, searchVariant: variantLabel })),
    domSeen: result.domSeen ?? 0,
    harvestSeen: result.harvestSeen ?? 0,
    totalSeen: result.totalSeen ?? cards.length,
    drops: result.drops ?? { noUrl: 0, noPrice: 0, noBedrooms: 0 },
  };
}

async function harvestVrboMapResultCards(targetPage, id, passes = 10, options = {}) {
  const exhaustive = options.exhaustive === true;
  // VRBO's search results page (SRP) server-renders the grid and lazy-loads more
  // as you approach the bottom of the WINDOW (the list is virtualized: DOM rows
  // recycle, so we must accumulate harvested cards across passes rather than rely
  // on the cards currently in the DOM). When a target total is known (read from
  // the "N properties" hint), we keep scrolling until we reach it; otherwise we
  // stop after sustained no-growth at the document bottom.
  const targetTotal = Number.isFinite(Number(options.targetTotal)) && Number(options.targetTotal) > 0
    ? Math.round(Number(options.targetTotal))
    : null;
  // When a target is known, give the loop enough runway to actually reach it
  // even if VRBO loads ~30-50 cards per "page". The caller's `passes` is treated
  // as a floor, not a hard ceiling, for exhaustive city exports with a target.
  const maxPasses = exhaustive && targetTotal
    ? Math.max(passes, Math.ceil(targetTotal / 12) + 20)
    : passes;
  let lastSnapshot = null;
  let lastHarvestTotal = 0;
  let plateauPasses = 0;
  let atBottomPasses = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    log(`vrbo_search ${id}: map harvest pass ${pass + 1}/${maxPasses} starting`);
    let snapshot = null;
    try {
      snapshot = await withSoftTimeout(
        targetPage.evaluate((passNumber) => {
          function normalizeText(value) {
            return String(value || "").replace(/\s+/g, " ").trim();
          }
          function firstCardImage(card) {
            const imgs = card.querySelectorAll?.("img") || [];
            for (const img of imgs) {
              const src = img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
              if (/^https?:/i.test(src) && /(?:trvl-media|mediaim\.expedia|odis\.homeaway|vrbo\.com|homeaway\.com)/i.test(src)) {
                return src;
              }
            }
            return "";
          }
          function harvestRowFromElement(card) {
            const titleEl = card.querySelector?.("h3");
            const link = card.querySelector?.("a[href]");
            const href = link?.getAttribute("href") || "";
            const title = titleEl ? normalizeText(titleEl.textContent).replace(/^Photo gallery for\s*/i, "") : "";
            const fullText = normalizeText(card.textContent);
            const propertyPath = href.replace(/^https?:\/\/[^\/]+/, "").split("?")[0];
            if (!/^\/\d+/.test(propertyPath)) return null;
            if (!fullText) return null;
            return { href, title, fullText, image: firstCardImage(card) };
          }
          const cards = Array.from(document.querySelectorAll('[data-stid="lodging-card-responsive"]'));
          const currentRows = cards.map(harvestRowFromElement).filter(Boolean);
          // Dedupe accumulation keyed primarily by property id (href path) so a
          // recycled DOM node with a slightly different price/badge string does
          // not create duplicate rows or block a genuinely new listing.
          window.__vrboHarvestCards = Array.isArray(window.__vrboHarvestCards) ? window.__vrboHarvestCards : [];
          if (!window.__vrboHarvestSeen) window.__vrboHarvestSeen = {};
          const seen = window.__vrboHarvestSeen;
          for (const row of currentRows) {
            const idKey = (row.href.replace(/^https?:\/\/[^\/]+/, "").split("?")[0].match(/\/(\d{5,})/) || [])[1]
              || `${row.href}|${row.title}`;
            const existing = seen[idKey];
            if (existing == null) {
              seen[idKey] = window.__vrboHarvestCards.length;
              window.__vrboHarvestCards.push(row);
            } else {
              const prev = window.__vrboHarvestCards[existing];
              if (row.fullText.length > (prev?.fullText?.length || 0)) {
                // Keep the richest snapshot of a card (priced text beats placeholder),
                // but don't lose a previously-captured image if this pass lacks one.
                if (!row.image && prev?.image) row.image = prev.image;
                window.__vrboHarvestCards[existing] = row;
              } else if (!prev?.image && row.image) {
                prev.image = row.image;
              }
            }
          }
          function looksLikeMapPane(rect) {
            if (!rect || rect.width < 1 || rect.height < 1) return false;
            const vw = window.innerWidth || 1;
            const vh = window.innerHeight || 1;
            const wide = rect.width >= vw * 0.42;
            const rightHeavy = rect.left >= vw * 0.28;
            const tall = rect.height >= vh * 0.45;
            return wide && rightHeavy && tall;
          }
          // Drive lazy-loading from BOTH the document/window and any inner
          // scrollable results container. Modern VRBO SRPs lazy-load on window
          // scroll; older/map layouts use an inner pane. Scrolling both is safe.
          const docEl = document.scrollingElement || document.documentElement;
          const winBefore = (docEl?.scrollTop ?? window.scrollY) || 0;
          const winMax = Math.max(0, (docEl?.scrollHeight || 0) - (window.innerHeight || 0));
          const winStep = Math.round((window.innerHeight || 720) * 0.9);
          try { window.scrollBy({ top: winStep, left: 0, behavior: "instant" }); } catch { window.scrollTo(0, winBefore + winStep); }
          const winAfter = (docEl?.scrollTop ?? window.scrollY) || 0;

          const scrollCandidates = [];
          const seed = cards[0] || document.querySelector('[data-stid="lodging-card-responsive"]');
          let el = seed;
          for (let depth = 0; el && depth < 18; depth += 1, el = el.parentElement) {
            if (!el || el.nodeType !== 1) continue;
            const overflow = (el.scrollHeight || 0) - (el.clientHeight || 0);
            if (overflow < 80) continue;
            const rect = el.getBoundingClientRect?.() ?? { width: 0, height: 0, left: 0 };
            if (looksLikeMapPane(rect)) continue;
            const cardCount = el.querySelectorAll?.('[data-stid="lodging-card-responsive"]')?.length ?? 0;
            if (cardCount < 1) continue;
            scrollCandidates.push({ el, overflow, cardCount, before: el.scrollTop || 0 });
          }
          scrollCandidates.sort((a, b) => (b.cardCount - a.cardCount) || (b.overflow - a.overflow));
          const innerTarget = scrollCandidates[0]?.el ?? null;
          let innerBefore = 0;
          let innerAfter = 0;
          let innerAtBottom = true;
          if (innerTarget) {
            innerBefore = innerTarget.scrollTop || 0;
            // Use the proven step size (~72% of the container height). Larger steps
            // overshoot VRBO's lazy-load trigger and the list stops growing.
            const step = Math.max(360, Math.round((innerTarget.clientHeight || 640) * 0.72));
            innerTarget.scrollTop = innerBefore + step;
            innerTarget.dispatchEvent?.(new Event("scroll", { bubbles: true }));
            innerAfter = innerTarget.scrollTop || 0;
            // The container grows as cards lazy-load; treat "at bottom" as being
            // within a card-height of the current bottom AND the height not having
            // grown this pass (checked across passes via plateau tracking).
            innerAtBottom = (innerTarget.scrollHeight - innerTarget.clientHeight - innerAfter) < 40;
          }

          const loadMore = Array.from(document.querySelectorAll("button, a, [role='button']"))
            .find((b) => b instanceof HTMLElement && /(?:show|see|view|load)\s+(?:\d+\s+)?more|more\s+results|more\s+properties/i.test((b.textContent || "").replace(/\s+/g, " ")));
          if (loadMore) { try { loadMore.click(); } catch {} }

          const winAtBottom = winMax < 40 ? true : (winMax - winAfter) < 60;
          // "At bottom" is governed by whichever element we are actually scrolling.
          // VRBO's SRP keeps the document static and scrolls an inner results
          // container, so when an inner target exists its bottom state wins. The
          // inner container's scrollHeight grows as more cards lazy-load, so being
          // momentarily at the bottom is normal until growth truly stops.
          const effectiveAtBottom = innerTarget ? innerAtBottom : winAtBottom;
          const effBefore = innerTarget ? innerBefore : winBefore;
          const effAfter = innerTarget ? innerAfter : winAfter;
          return {
            pass: passNumber,
            scrollTargets: scrollCandidates.length,
            scrolledResultsList: Boolean(innerTarget) || winAfter > winBefore,
            visibleCards: document.querySelectorAll('[data-stid="lodging-card-responsive"]').length,
            propertyLinks: Array.from(document.querySelectorAll('a[href]')).filter((a) => /^\/\d+/.test(a.getAttribute("href") || "")).length,
            harvestedCurrent: currentRows.length,
            harvestedTotal: window.__vrboHarvestCards.length,
            topTargetCards: scrollCandidates[0]?.cardCount ?? 0,
            topTargetOverflow: scrollCandidates[0]?.overflow ?? 0,
            innerScroll: Boolean(innerTarget),
            atBottom: effectiveAtBottom,
            before: effBefore,
            after: effAfter,
          };
        }, pass + 1),
        6_000,
        null,
      );
    } catch (e) {
      log(`vrbo_search ${id}: map harvest pass ${pass + 1}/${maxPasses} evaluate failed: ${e?.message || e}`);
    }
    if (snapshot) {
      lastSnapshot = snapshot;
      log(
        `vrbo_search ${id}: map harvest pass ${snapshot.pass}/${maxPasses} ` +
        `targets=${snapshot.scrollTargets} scrolledList=${snapshot.scrolledResultsList} visibleCards=${snapshot.visibleCards} propertyLinks=${snapshot.propertyLinks} ` +
        `harvest=${snapshot.harvestedCurrent}/${snapshot.harvestedTotal}` +
        `${targetTotal ? `/target=${targetTotal}` : ""} ` +
        `atBottom=${snapshot.atBottom} scroll=${snapshot.before}->${snapshot.after}`,
      );
    } else {
      log(`vrbo_search ${id}: map harvest pass ${pass + 1}/${maxPasses} did not return a DOM snapshot`);
    }
    const harvestedTotal = lastSnapshot?.harvestedTotal ?? 0;
    if (harvestedTotal <= lastHarvestTotal) plateauPasses += 1;
    else plateauPasses = 0;
    lastHarvestTotal = harvestedTotal;
    // Track how many consecutive passes we have been wedged at the bottom with
    // no new cards — that is the real "nothing left to load" signal.
    if (lastSnapshot?.atBottom && plateauPasses > 0) atBottomPasses += 1;
    else atBottomPasses = 0;

    // If we have a known target, keep going until we essentially reach it.
    const reachedTarget = targetTotal ? harvestedTotal >= targetTotal - 2 : false;
    if (reachedTarget) {
      log(`vrbo_search ${id}: harvest reached target ${harvestedTotal}/${targetTotal} cards after pass ${pass + 1}`);
      break;
    }

    if (!exhaustive && pass >= 6 && plateauPasses >= 3 && lastHarvestTotal >= 30) {
      log(`vrbo_search ${id}: map harvest plateau at ${harvestedTotal} cards; stopping early after pass ${pass + 1}/${maxPasses}`);
      break;
    }
    // Exhaustive: only give up once we are wedged at the document bottom with
    // no growth for several passes (so we do not quit while VRBO is still
    // lazy-loading). Allow more patience when a target is set and unmet.
    const bottomGiveUp = targetTotal ? 6 : 4;
    if (exhaustive && pass >= 12 && atBottomPasses >= bottomGiveUp) {
      log(
        `vrbo_search ${id}: exhaustive harvest exhausted at ${harvestedTotal}` +
        `${targetTotal ? `/${targetTotal}` : ""} cards (bottomPasses=${atBottomPasses}) after pass ${pass + 1}/${maxPasses}`,
      );
      break;
    }
    await boundedPageDelay(targetPage, pass < 2 ? 1_400 : 1_000);
  }
  return {
    passes: maxPasses,
    finalHarvestTotal: lastSnapshot?.harvestedTotal ?? 0,
    lastVisibleCards: lastSnapshot?.visibleCards ?? 0,
    lastPropertyLinks: lastSnapshot?.propertyLinks ?? 0,
    targetTotal,
  };
}

function vrboPropertyIdFromHref(href) {
  const path = String(href || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const m = path.match(/\/(\d{5,})/);
  return m ? m[1] : null;
}

function buildVrboSortVariantUrl(baseUrl, sort, extraParams) {
  try {
    const u = new URL(baseUrl, "https://www.vrbo.com");
    if (sort) u.searchParams.set("sort", sort);
    if (extraParams && typeof extraParams === "object") {
      for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, String(v));
    }
    return u.toString();
  } catch {
    return baseUrl;
  }
}

// VRBO's SRP paginates in ~50-result pages with a footer Next control
// (data-stid="next-button", aria-label="Next page"). walkVrboResultsUiPages is
// the primary city-export path. When that still falls short, re-run the SAME
// dated search under different sort orders (+ bedroom filters): each sort returns
// a different slice, so the union across variants approaches the reported total.
async function exhaustiveCityHarvestAllSorts(targetPage, id, baseSrpUrl, options = {}) {
  const targetTotal = Number.isFinite(Number(options.targetTotal)) && Number(options.targetTotal) > 0
    ? Math.round(Number(options.targetTotal))
    : null;
  const passesPerVariant = Math.max(20, Number(options.passesPerVariant) || 35);
  // Order matters: RECOMMENDED first (matches the page the user already landed
  // on), then the two price extremes (which the live probe showed contribute the
  // most net-new listings), then bedroom-filtered slices for extra coverage.
  const variants = [
    { label: "RECOMMENDED", sort: "RECOMMENDED" },
    { label: "PRICE_HIGH_TO_LOW", sort: "PRICE_HIGH_TO_LOW" },
    { label: "PRICE_LOW_TO_HIGH", sort: "PRICE_LOW_TO_HIGH" },
    { label: "RECOMMENDED+2BR", sort: "RECOMMENDED", extra: { bedroom_count_gt: 1 } },
    { label: "RECOMMENDED+3BR", sort: "RECOMMENDED", extra: { bedroom_count_gt: 2 } },
  ];

  const merged = new Map(); // propertyId -> { href, title, fullText }
  // Seed with whatever the initial harvest already collected on the current page.
  try {
    const seedRows = await targetPage.evaluate(
      () => (Array.isArray(window.__vrboHarvestCards) ? window.__vrboHarvestCards : []),
    );
    for (const row of seedRows || []) {
      const pid = vrboPropertyIdFromHref(row?.href) || `${row?.href}|${row?.title}`;
      if (!merged.has(pid)) merged.set(pid, row);
    }
  } catch { /* seeding is best-effort */ }
  log(`vrbo_search ${id}: exhaustive multi-sort harvest seeded with ${merged.size} cards from initial page`);

  const variantStats = [];
  for (const variant of variants) {
    if (targetTotal && merged.size >= targetTotal - 2) {
      log(`vrbo_search ${id}: multi-sort harvest reached target ${merged.size}/${targetTotal}; skipping remaining variants`);
      break;
    }
    const url = buildVrboSortVariantUrl(baseSrpUrl, variant.sort, variant.extra);
    const before = merged.size;
    try {
      await targetPage.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
      await boundedPageDelay(targetPage, 2_200);
      await dismissObstructions(targetPage, `vrbo_search_sort_${variant.label}`).catch(() => []);
      // Fresh per-variant accumulator in the page context.
      await targetPage.evaluate(() => { window.__vrboHarvestCards = []; window.__vrboHarvestSeen = {}; }).catch(() => {});
      const stats = await harvestVrboMapResultCards(targetPage, id, passesPerVariant, {
        exhaustive: true,
        targetTotal: null, // per-variant cap is VRBO's ~90; do not chase the city total within one sort
      });
      const rows = await targetPage.evaluate(
        () => (Array.isArray(window.__vrboHarvestCards) ? window.__vrboHarvestCards : []),
      );
      for (const row of rows || []) {
        const pid = vrboPropertyIdFromHref(row?.href) || `${row?.href}|${row?.title}`;
        if (!pid) continue;
        const existing = merged.get(pid);
        if (!existing || String(row?.fullText || "").length > String(existing?.fullText || "").length) {
          merged.set(pid, row);
        }
      }
      variantStats.push({ label: variant.label, harvested: rows?.length ?? 0, unionAfter: merged.size, gained: merged.size - before, passes: stats.passes });
      log(
        `vrbo_search ${id}: multi-sort variant ${variant.label} harvested=${rows?.length ?? 0} ` +
        `union=${merged.size} (+${merged.size - before} new)` +
        `${targetTotal ? ` target=${targetTotal}` : ""}`,
      );
    } catch (e) {
      log(`vrbo_search ${id}: multi-sort variant ${variant.label} failed: ${e?.message ?? e}`);
      variantStats.push({ label: variant.label, error: String(e?.message ?? e) });
    }
  }

  // Write the merged union back into the page so the unchanged extraction path
  // (extractVisibleVrboCards reads window.__vrboHarvestCards) sees everything.
  const unionRows = Array.from(merged.values());
  await targetPage.evaluate((rows) => {
    window.__vrboHarvestCards = rows;
    window.__vrboHarvestSeen = {};
  }, unionRows).catch(() => {});
  log(`vrbo_search ${id}: exhaustive multi-sort harvest union=${unionRows.length}${targetTotal ? `/${targetTotal}` : ""} across ${variantStats.length} variant(s)`);
  return { unionTotal: unionRows.length, targetTotal, variantStats };
}

async function runVrboMapBoundsSearchVariant(id, params, variant = null) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(variant?.searchTerm || searchTerm || destination || "").trim();
  const bounds = numericMapBounds(params);
  const center = vrboMapCenter(params);
  log(
    `vrbo_search ${id}: map-bounds searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR` +
    (center ? ` center=${center.lat.toFixed(6)},${center.lng.toFixed(6)}` : "") +
    (bounds ? ` bounds=${bounds.sw_lat.toFixed(5)},${bounds.sw_lng.toFixed(5)},${bounds.ne_lat.toFixed(5)},${bounds.ne_lng.toFixed(5)}` : ""),
  );
  await ensureBrowser();
  await surfaceVisibleOtaSearchWindow(page, "vrbo_search", id);
  await clearOtaClientSearchState("https://www.vrbo.com", `vrbo_search ${id} map-bounds preflight`);
  const expectedNights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / (24 * 60 * 60 * 1000)));
  const deepMapHarvest = params?.mapSearch?.deepHarvest === true;
  const maxGraphqlRows = deepMapHarvest ? 500 : 300;
  const networkCapture = createVrboGraphqlCollector(page, id, expectedNights, effectiveSearchTerm, maxGraphqlRows);
  const url = buildVrboMapSearchUrl(params, effectiveSearchTerm);
  logProviderMapSearchPlan("vrbo_search", id, "vrbo", params, effectiveSearchTerm, url);
  try {
    assertSafeVrboNavigation(url, "vrbo_search_map", id, { allowMapBoundsSearch: true });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await boundedPageDelay(page, PAGE_SETTLE_MS);
    await stopVrboProviderIfBlocked(page, "vrbo_search", id);
    await dismissObstructions(page, "vrbo_search_map");
    await clickVrboMapControl(page, "vrbo_search", id).catch(() => false);
    await disableVrboSearchAsMapMoves(page, "vrbo_search", id).catch(() => false);
    const mapMinBedrooms = vrboMapMinBedrooms(bedrooms);
    await fillBedroomFilter(page, mapMinBedrooms, `vrbo_search ${id} map-min-br`).catch(() => null);
    if (bounds) {
      log(`vrbo_search ${id}: provider bounds present; clicking search-this-area to apply viewport/bounds ${formatMapBoundsForLog(bounds)}`);
      await clickVrboSearchThisArea(page, "vrbo_search", id).catch(() => false);
    } else {
      log(`vrbo_search ${id}: city map search has no provider mapBounds; leaving city results unbound by map viewport`);
    }
    await boundedPageDelay(page, 2_500);
    let state = await dumpPageState("vrbo-map", { id, ...params });
    throwIfBrightDataKycBlock(state, "vrbo_search", id);
    if (await stopVrboProviderIfBlocked(page, "vrbo_search", id, state)) {
      state = await dumpPageState("vrbo-map-after-manual-solve", { id, ...params });
    }
    throwIfVrboHardBlock(state, "vrbo_search", id);
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
    await networkCapture.settle("post-map-load", 12_000);
    const paginationStats = await paginateVrboGraphqlInventory(page, networkCapture, id, {
      maxRows: maxGraphqlRows,
      maxPages: deepMapHarvest ? 50 : 30,
    });
    log(
      `vrbo_search ${id}: graphql pagination done replay=${paginationStats.replayPages} ui=${paginationStats.uiPages} ` +
      `total=${paginationStats.finalCount} stop=${paginationStats.stopReason} ` +
      `hasNextPage=${paginationStats.lastPagination?.hasNextPage ?? "?"}`,
    );
    const graphqlPrefillCount = networkCapture.candidates().length;
    const defaultMapHarvestPasses = deepMapHarvest ? 25 : (bounds ? 4 : 15);
    const harvestPasses = graphqlPrefillCount >= 100
      ? Math.min(deepMapHarvest ? 8 : 6, defaultMapHarvestPasses)
      : defaultMapHarvestPasses;
    log(
      `vrbo_search ${id}: starting map harvest passes (${deepMapHarvest ? "deep-city" : bounds ? "bounded" : "city-unbounded"}) ` +
      `count=${harvestPasses} graphqlPrefill=${graphqlPrefillCount} before card extraction`,
    );
    const harvestStats = await harvestVrboMapResultCards(page, id, harvestPasses);
    const domExtract = await extractVisibleVrboCards(id, params, expectedNights, effectiveSearchTerm);
    const domCards = domExtract.cards ?? [];
    const networkCards = networkCapture.candidates();
    const mergedCards = dedupeCandidatesByUrl([...networkCards, ...domCards]);
    const pricedNetworkCards = networkCards.filter((c) => !c.availabilityOnly && c.totalPrice > 0).length;
    const stats = networkCapture.stats();
    log(
      `vrbo_search ${id}: map inventory merged ${mergedCards.length} candidates ` +
      `(network=${networkCards.length}, networkPriced=${pricedNetworkCards}, dom=${domCards.length}, ` +
      `jsonResponses=${stats.matchedResponses}/${stats.responsesSeen})`,
    );
    return {
      candidates: mergedCards,
      mapHarvest: {
        harvestPasses: harvestStats.passes,
        finalHarvestTotal: harvestStats.finalHarvestTotal,
        lastVisibleCards: harvestStats.lastVisibleCards,
        lastPropertyLinks: harvestStats.lastPropertyLinks,
        domSeen: domExtract.domSeen ?? 0,
        harvestSeenInExtract: domExtract.harvestSeen ?? 0,
        extractTotalSeen: domExtract.totalSeen ?? 0,
        extractDrops: domExtract.drops ?? null,
        networkCount: networkCards.length,
        pricedNetworkCount: pricedNetworkCards,
        mergedCount: mergedCards.length,
        graphqlResponsesMatched: stats.matchedResponses ?? 0,
        graphqlResponsesSeen: stats.responsesSeen ?? 0,
	        graphqlReplayPages: paginationStats.replayPages ?? 0,
	        graphqlUiPages: paginationStats.uiPages ?? 0,
	        graphqlPaginationStop: paginationStats.stopReason ?? null,
	        graphqlTotalCount: paginationStats.lastPagination?.totalCount ?? undefined,
	      },
    };
  } finally {
    networkCapture.dispose();
  }
}

async function runVrboSearchVariant(id, params, variant = null, visibleAttempt = 0) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const exhaustiveCityExport = Boolean(params?.cityWideInventory);
  // Region-aware destination guard: append the property's expected state (full
  // lowercase name from the server, e.g. "florida") to the destination ONLY for
  // the post-submit mainland-namesake checks, so a Florida property resolving to
  // Florida is accepted. NOT used for the pre-submit homepage-form match (that
  // judges the typed field, where a state token would force needless re-fills).
  const expectedState = String(params?.expectedState || "").trim().toLowerCase();
  const guardDestination = expectedState ? `${destination}, ${expectedState}` : destination;
  const effectiveSearchTerm = String(variant?.searchTerm || searchTerm || destination || "").trim();
  const typedQuery = String(variant?.typedQuery || otaBaseSearchQuery(searchTerm, destination) || effectiveSearchTerm).trim();
  log(
    `vrbo_search ${id}: searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR` +
    `${exhaustiveCityExport ? " cityWide=exhaustive" : ""}` +
    `${visibleAttempt ? ` retry=${visibleAttempt}` : ""}`,
  );
  await ensureBrowser();
  const expectedNights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / (24 * 60 * 60 * 1000)));
  const maxGraphqlRows = Math.max(
    400,
    Math.min(
      600,
      Number.parseInt(String(process.env.SIDECAR_VRBO_LIST_GRAPHQL_MAX_ROWS ?? process.env.SIDECAR_VRBO_GRAPHQL_MAX_ROWS ?? "500"), 10) || 500,
    ),
  );
  const networkCapture = createVrboGraphqlCollector(page, id, expectedNights, effectiveSearchTerm, maxGraphqlRows);
  try {
  await surfaceVisibleOtaSearchWindow(page, "vrbo_search", id);
  await clearOtaClientSearchState(
    "https://www.vrbo.com",
    visibleAttempt > 0 ? `vrbo_search ${id} retry ${visibleAttempt}` : `vrbo_search ${id} preflight`,
  );
  if (visibleAttempt > 0) await resetPage();
  const primedDestination = await primeOtaHomepageSearch("https://www.vrbo.com/", effectiveSearchTerm, "vrbo_search", id, {
    inputTerm: typedQuery,
    targetSuggestion: variant?.suggestionText || null,
    submitAfterSearch: false,
  });
  if (!primedDestination) {
    const state = await dumpPageState("vrbo-unprimed-destination", { id, ...params }).catch(() => null);
    throw new ProviderBrowserUnavailableError(
      `VRBO homepage did not accept destination "${effectiveSearchTerm}"; refusing to submit the provider's default/geolocated search.`,
      {
        label: "vrbo_search",
        id,
        provider: "vrbo",
        url: page.url(),
        title: await page.title().catch(() => state?.title ?? ""),
        excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      },
    );
  }
  // Drive VRBO like a user from the public homepage. Do not jump to an
  // injected /search URL; those URLs appear to raise bot scrutiny and can
  // mask destination drift.
  await stopVrboProviderIfBlocked(page, "vrbo_search", id);
  let dateEntry = await applyOtaSearchDateInputs(page, checkIn, checkOut, "vrbo_search", "vrbo");
  if (!pmDateEntryComplete(dateEntry)) {
    throw new ProviderBrowserUnavailableError(
      `VRBO homepage UI date entry failed for ${checkIn}→${checkOut}; refusing to build an injected search URL.`,
      {
        label: "vrbo_search",
        id,
        provider: "vrbo",
        url: page.url(),
        title: await page.title().catch(() => ""),
        dateEntry,
      },
    );
  }
  log(`vrbo_search ${id}: entered dates via VRBO homepage controls (${checkIn}→${checkOut})`);
  const visibleSearchWasAuthoritative = Boolean(primedDestination && pmDateEntryComplete(dateEntry));
  await stopVrboProviderIfBlocked(page, "vrbo_search", id);
  // VRBO often resets the destination to a geolocated default (e.g. Brennecke
  // Beach) after the calendar closes. Re-assert the dropdown selection before Search.
  const postDateSnapshot = await readVrboHomepageFormSnapshot(page);
  const postDateCheck = vrboHomepageFormMatchesRequest(
    postDateSnapshot,
    checkIn,
    checkOut,
    destination,
    typedQuery,
  );
  if (!postDateCheck.destinationOk) {
    log(
      `vrbo_search ${id}: destination drifted after date entry` +
      `${postDateSnapshot?.destination ? ` (field="${String(postDateSnapshot.destination).slice(0, 80)}")` : ""}; re-selecting "${effectiveSearchTerm}"`,
    );
    await fillVrboDestinationField(page, typedQuery, "vrbo_search_post_dates", {
      targetSuggestion: variant?.suggestionText || effectiveSearchTerm,
      requestId: id,
    }).catch(() => null);
    await dismissObstructions(page, "vrbo_search_post_dates", { allowEscape: false }).catch(() => []);
  }
  let formSnapshot = await readVrboHomepageFormSnapshot(page);
  let formCheck = vrboHomepageFormMatchesRequest(formSnapshot, checkIn, checkOut, destination, typedQuery);
  if (!formCheck.destinationOk || !formCheck.datesOk) {
    log(
      `vrbo_search ${id}: homepage form drift before submit ` +
      `(destinationOk=${formCheck.destinationOk} datesOk=${formCheck.datesOk}; ` +
      `where="${String(formCheck.destinationText || "").slice(0, 80)}" dates="${String(formCheck.datesText || "").slice(0, 80)}")`,
    );
    if (!formCheck.destinationOk) {
      await fillVrboDestinationField(page, typedQuery, "vrbo_search_preflight", {
        targetSuggestion: variant?.suggestionText || null,
        requestId: id,
      }).catch(() => null);
    }
    if (!formCheck.datesOk) {
      dateEntry = mergeDateEntries(
        dateEntry,
        await applyOtaSearchDateInputs(page, checkIn, checkOut, "vrbo_search", "vrbo").catch(() => null),
      );
    }
    formSnapshot = await readVrboHomepageFormSnapshot(page);
    formCheck = vrboHomepageFormMatchesRequest(formSnapshot, checkIn, checkOut, destination, typedQuery);
    if (!formCheck.destinationOk || !formCheck.datesOk) {
      throw new ProviderBrowserUnavailableError(
        `VRBO homepage form did not keep destination/dates before search (${checkIn}→${checkOut}).`,
        {
          label: "vrbo_search",
          id,
          provider: "vrbo",
          url: page.url(),
          destinationText: formCheck.destinationText,
          datesText: formCheck.datesText,
          dateEntry,
        },
      );
    }
  }
  await clickVisibleSearchSubmit(page, "vrbo_search", { requestId: id }).catch(() => null);
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await stopVrboProviderIfBlocked(page, "vrbo_search", id);
  await dismissObstructions(page, "vrbo_search");
  const quickPostSubmitState = {
    url: page.url(),
    title: await page.title().catch(() => ""),
    bodyExcerpt: "",
  };
  let correctionReasons = vrboStateCorrectionReasons(quickPostSubmitState, checkIn, checkOut, effectiveSearchTerm, guardDestination);
  if (correctionReasons.length > 0) {
    log(`vrbo_search ${id}: post-submit state not settled yet (${correctionReasons.join("+")} mismatch); waiting for visible results before deciding`);
  }
  // Do not apply VRBO's browser-side bedroom filter here. The same
  // resort/date browser run is shared across all bedroom-combination
  // checks for a booking, and the API curation layer applies the
  // authoritative bedroom rules later. This reduces repeated VRBO
  // loads without hiding provider blocks or bypassing controls.
  let state = await dumpPageState("vrbo", { id, ...params });
  throwIfBrightDataKycBlock(state, "vrbo_search", id);
  if (await stopVrboProviderIfBlocked(page, "vrbo_search", id, state)) {
    state = await dumpPageState("vrbo-after-manual-solve", { id, ...params });
    // After manual slider solve, insert human-like "thinking + casual interaction" pause.
    // This reduces secondary bot signals that can keep the session flagged even after the challenge clears.
    log(`vrbo_search ${id}: post-manual-CAPTCHA human pause + jitter (5-12s)`);
    await page.waitForTimeout(2000 + Math.random() * 3000).catch(() => {});
    // Small human-like mouse jiggles and scroll to look alive
    try {
      const vp = page.viewportSize?.() ?? { width: 1200, height: 800 };
      await page.mouse.move(vp.width * 0.3 + Math.random() * 200, vp.height * 0.4 + Math.random() * 150, { steps: 12 }).catch(() => {});
      await page.waitForTimeout(800 + Math.random() * 1200).catch(() => {});
      await page.mouse.move(vp.width * 0.6 + Math.random() * 150, vp.height * 0.55 + Math.random() * 120, { steps: 8 }).catch(() => {});
      await page.evaluate(() => window.scrollBy(0, 80 + Math.random() * 120)).catch(() => {});
      await page.waitForTimeout(1500 + Math.random() * 2000).catch(() => {});
    } catch {}
  }
  throwIfVrboHardBlock(state, "vrbo_search", id);
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
  correctionReasons = vrboStateCorrectionReasons(state, checkIn, checkOut, effectiveSearchTerm, guardDestination);
  if (correctionReasons.length > 0) {
    const haystack = normalizeDestinationGuardText(`${state?.url ?? ""} ${state?.title ?? ""} ${state?.bodyExcerpt ?? ""}`);
    const expectedText = normalizeDestinationGuardText(`${effectiveSearchTerm} ${guardDestination}`);
    const clearlyWrongFloridaDefault =
      /\b(?:orlando|kissimmee|florida)\b/.test(haystack) && !/\bflorida\b/.test(expectedText);
    if (visibleSearchWasAuthoritative && !clearlyWrongFloridaDefault && !correctionReasons.includes("destination")) {
      log(
        `vrbo_search ${id}: accepting visible date entry despite ` +
        `post-submit URL/text not echoing ${checkIn}→${checkOut}`,
      );
      correctionReasons = correctionReasons.filter((reason) => reason !== "dates");
    }
  }
  if (correctionReasons.length > 0) {
    if (visibleAttempt < 1 && correctionReasons.includes("destination")) {
      log(
        `vrbo_search ${id}: visible submit drifted to the wrong destination; ` +
        `retrying once from a fresh visible VRBO form without URL injection`,
      );
      return runVrboSearchVariant(id, params, variant, visibleAttempt + 1);
    }
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
    throw new ProviderBrowserUnavailableError(
      `VRBO visible search state shows ${correctionReasons.join("+")} mismatch; refusing to correct with an injected search URL.`,
      {
        label: "vrbo_search",
        id,
        provider: "vrbo",
        url: state?.url,
        title: state?.title,
        reasons: correctionReasons,
        excerpt: String(state?.bodyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      },
    );
  }
  if (!visibleSearchWasAuthoritative) {
    throwIfDestinationMismatch(state, "vrbo_search", id, effectiveSearchTerm, guardDestination);
    throwIfVrboDateMismatch(state, "vrbo_search", id, checkIn, checkOut);
  }
  // Let the first propertySearchListings GraphQL batch land before pagination replay.
  await networkCapture.settle("post-submit", 12_000);
  let resultsTotalHint = await readVrboResultsTotalHint(page);
  if (resultsTotalHint?.total) {
    log(
      `vrbo_search ${id}: VRBO results page reports total=${resultsTotalHint.total}` +
      `${resultsTotalHint.visible != null ? ` visible=${resultsTotalHint.visible}` : ""}`,
    );
  }
  let openedMapView = false;
  if (exhaustiveCityExport) {
    // City-wide inventory must scroll the results list, not the map pane.
    await clickVrboListViewControl(page, "vrbo_search", id).catch(() => false);
    log(`vrbo_search ${id}: city-wide export staying on list view for scroll + GraphQL pagination`);
    // Re-read the total now that the list view + results-count header are
    // rendered. The pre-list-view reading above is unreliable: VRBO frequently
    // hasn't painted the "N-M of T" range yet, so the fallback under-counts and
    // an under-counted total would cap estimatedPages + trip the walk's
    // target-reached stop. Take the larger of the two readings.
    await scrollVrboResultsPaginationIntoView(page).catch(() => {});
    await boundedPageDelay(page, 700);
    const settledHint = await readVrboResultsTotalHint(page);
    if (settledHint?.total && (!resultsTotalHint?.total || settledHint.total > resultsTotalHint.total)) {
      resultsTotalHint = settledHint;
      log(
        `vrbo_search ${id}: refreshed city-wide total after list view total=${settledHint.total}` +
        `${settledHint.range ? ` range=${settledHint.range}` : ""}`,
      );
    }
    // Scroll back to the top so the page walk harvests page 1 from the start.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" })).catch(() => {});
  } else if (!networkCapture.getRequestTemplate()) {
    // Bootstrap GraphQL request capture via map view when the first page did not expose a replay template.
    openedMapView = await clickVrboMapControl(page, "vrbo_search", id).catch(() => false);
    if (openedMapView) {
      await disableVrboSearchAsMapMoves(page, "vrbo_search", id).catch(() => false);
      await clickVrboSearchThisArea(page, "vrbo_search", id).catch(() => false);
      await boundedPageDelay(page, 2_500);
      await networkCapture.settle("post-map-view", 14_000);
    }
  }
  const paginationStats = await paginateVrboGraphqlInventory(page, networkCapture, id, {
    maxRows: maxGraphqlRows,
    maxPages: exhaustiveCityExport ? 80 : 50,
    plateauLimit: exhaustiveCityExport ? 3 : 2,
    // Don't let GraphQL pagination advance the SRP via UI-Next for city-wide;
    // the dedicated walkVrboResultsUiPages below owns page navigation + harvest
    // so it must start on page 1. See note in paginateVrboGraphqlInventory.
    allowUiNext: !exhaustiveCityExport,
  });
  log(
    `vrbo_search ${id}: graphql pagination done replay=${paginationStats.replayPages} ui=${paginationStats.uiPages} ` +
    `total=${paginationStats.finalCount} stop=${paginationStats.stopReason} ` +
    `hasNextPage=${paginationStats.lastPagination?.hasNextPage ?? "?"}` +
    `${paginationStats.lastPagination?.totalCount != null ? ` totalCount=${paginationStats.lastPagination.totalCount}` : ""}`,
  );

  await page.evaluate(() => {
    window.__vrboHarvestCards = [];
  }).catch(() => {});
  const graphqlPrefillCount = networkCapture.candidates().length;
  let uiPageWalkStats = null;
  if (exhaustiveCityExport) {
    // Floor at 8 pages (≈400 listings): the total hint can read low when VRBO
    // hasn't painted its results-count text, and a low cap would starve the walk
    // before it reaches the real end. The walk stops early on its own authoritative
    // signals (range-end-reached / Next-unavailable / harvest-plateau), and is
    // hard-capped at 14 pages internally, so a generous floor is safe.
    const estimatedPages = Math.max(
      8,
      resultsTotalHint?.total ? Math.ceil(resultsTotalHint.total / 50) + 2 : 8,
    );
    uiPageWalkStats = await walkVrboResultsUiPages(page, id, {
      maxPages: estimatedPages,
      targetTotal: resultsTotalHint?.total,
      passesPerPage: 6,
    });
  }
  const defaultListHarvestPasses = Math.max(
    20,
    Math.min(
      40,
      Number.parseInt(String(process.env.SIDECAR_VRBO_LIST_HARVEST_PASSES ?? "30"), 10) || 30,
    ),
  );
  const uiWalkHarvestTotal = uiPageWalkStats?.finalHarvestTotal ?? 0;
  const uiWalkReachedTarget = Boolean(
    resultsTotalHint?.total && uiWalkHarvestTotal >= resultsTotalHint.total - 2,
  );
  const listHarvestPasses = exhaustiveCityExport
    ? (uiWalkReachedTarget ? 6 : Math.max(35, defaultListHarvestPasses))
    : (graphqlPrefillCount >= 80 ? Math.min(6, defaultListHarvestPasses) : defaultListHarvestPasses);
  log(
    `vrbo_search ${id}: starting dropdown list harvest (${listHarvestPasses} passes, graphqlPrefill=${graphqlPrefillCount}` +
    `${exhaustiveCityExport ? ", cityWide=exhaustive" : ""}` +
    `${uiPageWalkStats ? `, uiPages=${uiPageWalkStats.pagesWalked}` : ""}) before card extraction`,
  );
  const listHarvestStats = await harvestVrboMapResultCards(page, id, listHarvestPasses, {
    exhaustive: exhaustiveCityExport && !uiWalkReachedTarget,
    targetTotal: exhaustiveCityExport && !uiWalkReachedTarget ? resultsTotalHint?.total : undefined,
  });
  log(
    `vrbo_search ${id}: dropdown list harvest done passes=${listHarvestStats.passes} ` +
    `total=${listHarvestStats.finalHarvestTotal} visible=${listHarvestStats.lastVisibleCards}`,
  );
  // City-wide exports: if UI page-walk + scroll still fall short, re-run under
  // multiple sort orders and merge unique listings (e.g. ~218 for Princeville).
  let multiSortStats = null;
  const postHarvestTotal = await page.evaluate(
    () => (Array.isArray(window.__vrboHarvestCards) ? window.__vrboHarvestCards.length : 0),
  ).catch(() => listHarvestStats.finalHarvestTotal);
  const needsMultiSort = exhaustiveCityExport &&
    resultsTotalHint?.total &&
    postHarvestTotal < resultsTotalHint.total - 10;
  if (needsMultiSort) {
    const baseSrpUrl = page.url();
    if (/\/search\b/i.test(String(baseSrpUrl))) {
      multiSortStats = await exhaustiveCityHarvestAllSorts(page, id, baseSrpUrl, {
        targetTotal: resultsTotalHint?.total,
        passesPerVariant: Math.min(26, listHarvestPasses),
      });
      log(
        `vrbo_search ${id}: multi-sort exhaustive harvest union=${multiSortStats.unionTotal}` +
        `${multiSortStats.targetTotal ? `/${multiSortStats.targetTotal}` : ""}`,
      );
    } else {
      log(`vrbo_search ${id}: skipped multi-sort harvest; current URL is not a /search SRP (${String(baseSrpUrl).slice(0, 80)})`);
    }
  }
  await networkCapture.settle("post-harvest", 10_000);
  const domExtract = await extractVisibleVrboCards(id, params, expectedNights, effectiveSearchTerm, { minBedrooms: 1 });
	  const networkCards = networkCapture.candidates();
	  const domCards = domExtract.cards ?? [];
	  const mergedCards = dedupeCandidatesByUrl([...networkCards, ...domCards]);
	  const pricedNetworkCards = networkCards.filter((c) => !c.availabilityOnly && c.totalPrice > 0).length;
	  const graphqlStats = networkCapture.stats();
	  log(
    `vrbo_search ${id}: dropdown export merged ${mergedCards.length} candidates ` +
    `(network=${networkCards.length}, dom=${domCards.length}, harvestTotal=${listHarvestStats.finalHarvestTotal}, ` +
    `mapView=${openedMapView ? "yes" : "no"}, cityWide=${exhaustiveCityExport ? "yes" : "no"}, ` +
	    `graphqlReplay=${paginationStats.replayPages}, graphqlUi=${paginationStats.uiPages}, ` +
	    `graphqlResponses=${graphqlStats.matchedResponses}/${graphqlStats.responsesSeen})`,
	  );
	  return {
	    candidates: mergedCards.map((card) => ({ ...card, searchVariant: effectiveSearchTerm })),
	    mapHarvest: {
	      harvestPasses: listHarvestStats.passes,
	      finalHarvestTotal: listHarvestStats.finalHarvestTotal,
	      lastVisibleCards: listHarvestStats.lastVisibleCards,
	      lastPropertyLinks: listHarvestStats.lastPropertyLinks,
	      domSeen: domExtract.domSeen ?? 0,
	      harvestSeenInExtract: domExtract.harvestSeen ?? 0,
	      extractTotalSeen: domExtract.totalSeen ?? 0,
	      extractDrops: domExtract.drops ?? null,
	      networkCount: networkCards.length,
	      pricedNetworkCount: pricedNetworkCards,
	      mergedCount: mergedCards.length,
	      graphqlResponsesMatched: graphqlStats.matchedResponses ?? 0,
	      graphqlResponsesSeen: graphqlStats.responsesSeen ?? 0,
	      graphqlReplayPages: paginationStats.replayPages ?? 0,
	      graphqlUiPages: paginationStats.uiPages ?? 0,
	      graphqlPaginationStop: paginationStats.stopReason ?? null,
	      graphqlTotalCount: paginationStats.lastPagination?.totalCount ?? resultsTotalHint?.total ?? undefined,
	      reportedTotal: resultsTotalHint?.total ?? undefined,
	      uiPageWalkPages: uiPageWalkStats?.pagesWalked ?? undefined,
	      uiPageWalkStop: uiPageWalkStats?.stopReason ?? undefined,
	      uiPageWalkRanges: uiPageWalkStats?.pageRanges ?? undefined,
	      multiSortUnion: multiSortStats?.unionTotal ?? undefined,
	      multiSortVariants: multiSortStats?.variantStats ?? undefined,
	    },
	  };
	  } finally {
    networkCapture.dispose();
  }
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
  if (await stopVrboProviderIfBlocked(page, "vrbo_photo_scrape", id, state)) {
    state = await dumpPageState("vrbo-photo-after-manual-solve", { id, ...params });
  }
  throwIfVrboHardBlock(state, "vrbo_photo_scrape", id);
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

  // Try to expand a collapsed "Sleeping arrangements" / "Rooms & beds" section
  // so its bed text is present in innerText before we harvest it.
  await page
    .click('button:has-text("Show all rooms"), button:has-text("Sleeping arrangements"), [data-stid*="sleeping" i] button, button:has-text("Rooms & beds")', { timeout: 1500 })
    .catch(() => {});
  // Give a lazy/animated section time to render before we harvest its text.
  await page.waitForTimeout(900);

  // While we're on the listing page (real browser, no bot wall), harvest the
  // sleeping-arrangements / bed text so the guest alternative page can show
  // real bed types. The server parses distinct types + counts (King/Queen/
  // Twin/Sofa) out of this; we just return the short bed-mentioning segments.
  // We PREFER a dedicated "Sleeping arrangements / Rooms & beds" section
  // (highest signal, e.g. "Bedroom 1 · 1 King Bed") and fall back to the full
  // body so a missing section still degrades to whatever beds are mentioned.
  const bedText = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    // Keep a segment only if a size term sits with an explicit "bed" (so
    // "full kitchen" / "double vanity" are excluded), or it's a self-evident
    // bed term. This keeps the harvested text to real sleeping arrangements.
    const sizeRe = /\b(?:california\s+king|king|queen|twin|full|double|bunk|murphy|trundle)\b/i;
    const hasBed = /\bbeds?\b/i;
    const selfEvident = /\b(?:sleeper\s*sofa|sofa\s*bed|bunk\s*beds?|murphy\s*bed|pull[-\s]?out\s*(?:sofa|couch|bed)|day\s*bed)\b/i;
    const collect = (raw) => {
      const segs = clean(raw).split(/(?:[.!?]\s+)|·|•|\||\n|;|,/).map((s) => clean(s)).filter(Boolean);
      const out = [];
      const seen = new Set();
      for (const s of segs) {
        if (s.length < 3 || s.length > 120) continue;
        if (!((sizeRe.test(s) && hasBed.test(s)) || selfEvident.test(s))) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= 40) break;
      }
      return out;
    };
    // Locate a dedicated sleeping-arrangements section by its heading text.
    let sectionText = "";
    const heads = Array.from(document.querySelectorAll("h1,h2,h3,h4,[role='heading']"));
    for (const h of heads) {
      if (/\b(?:sleeping\s+arrangements|rooms?\s*(?:&|and)\s*beds|bedrooms?\s*(?:&|and)\s*beds)\b/i.test(clean(h.textContent))) {
        const container = h.closest("section,div") || h.parentElement;
        sectionText = clean(container ? container.innerText : h.textContent);
        break;
      }
    }
    const merged = [];
    const seen = new Set();
    for (const s of [...collect(sectionText), ...collect(document.body && document.body.innerText)]) {
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(s);
      if (merged.length >= 40) break;
    }
    return merged.join(" · ").slice(0, 2000);
  }).catch(() => "");

  // Guest capacity ("Sleeps N" / "N guests") — VRBO shows it in the property
  // summary near the top of the listing. This is reliable (always present),
  // unlike the rooms&beds section, so the guest page can show the combined
  // sleeps across the attached units.
  const sleeps = await page.evaluate(() => {
    const full = String((document.body && document.body.innerText) || "").replace(/\s+/g, " ");
    // "Sleeps N" is VRBO's specific capacity label — trust the FIRST occurrence
    // (the property summary sits above the reviews in the DOM, so the first match
    // is the real capacity, not a number mentioned in a review).
    let m = full.match(/\bsleeps?\s*(\d{1,2})\b/i);
    // Fallback "N guests" ONLY within the top summary region, so a guest count
    // quoted in review text further down the page can't be mistaken for capacity.
    if (!m) m = full.slice(0, 2500).match(/\b(\d{1,2})\s+guests?\b/i);
    return m ? Number.parseInt(m[1], 10) : null;
  }).catch(() => null);

  // Phase 4 (detail enrichment): the listing DETAIL page reliably carries
  // coordinates (unlike the SRP/map — see AGENTS.md city-inventory #8), so pull
  // lat/lng + a complex/street identifier here. Multi-source + best-effort:
  // JSON-LD geo/address → meta tags → __APOLLO_STATE__/embedded-JSON regex.
  const geo = await page.evaluate(() => {
    const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
    let lat = null, lng = null, complexName = null, streetAddress = null;
    // 1) JSON-LD structured data
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent || "{}");
        const arr = Array.isArray(data) ? data : [data];
        for (const obj of arr) {
          const nodes = [obj, ...(Array.isArray(obj && obj["@graph"]) ? obj["@graph"] : [])];
          for (const node of nodes) {
            if (!node || typeof node !== "object") continue;
            if (lat == null && node.geo) {
              const la = num(node.geo.latitude), ln = num(node.geo.longitude);
              if (la != null && ln != null) { lat = la; lng = ln; }
            }
            if (!streetAddress && node.address && typeof node.address === "object") {
              const a = node.address;
              streetAddress = [a.streetAddress, a.addressLocality].filter(Boolean).join(", ") || null;
            }
            if (!complexName && typeof node.name === "string" && node.name.trim()) complexName = node.name.trim().slice(0, 120);
          }
        }
      } catch {}
    }
    // 2) Meta tags (place:location:latitude / og:latitude / geo.position "lat;lng")
    if (lat == null) {
      const mLat = document.querySelector('meta[property="place:location:latitude"], meta[property="og:latitude"]');
      const mLng = document.querySelector('meta[property="place:location:longitude"], meta[property="og:longitude"]');
      if (mLat && mLng) { lat = num(mLat.getAttribute("content")); lng = num(mLng.getAttribute("content")); }
      if (lat == null) {
        const gp = document.querySelector('meta[name="geo.position"]')?.getAttribute("content") || "";
        const m = gp.match(/(-?\d+\.\d+)[;, ]\s*(-?\d+\.\d+)/);
        if (m) { lat = num(m[1]); lng = num(m[2]); }
      }
    }
    // 3) __APOLLO_STATE__ / embedded-JSON regex
    if (lat == null) {
      let txt = "";
      try { txt = JSON.stringify(window.__APOLLO_STATE__ || {}); } catch {}
      let m = txt.match(/"latitude"\s*:\s*"?(-?\d+\.\d+)"?\s*,\s*"longitude"\s*:\s*"?(-?\d+\.\d+)"?/);
      if (!m) m = document.documentElement.outerHTML.match(/"latitude"\s*:\s*"?(-?\d+\.\d+)"?\s*,\s*"longitude"\s*:\s*"?(-?\d+\.\d+)"?/);
      if (m) { lat = num(m[1]); lng = num(m[2]); }
    }
    // Sanity: reject obviously bogus coords (0,0 / out of range).
    if (lat != null && lng != null && (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01)) { lat = null; lng = null; }
    if (lat != null && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) { lat = null; lng = null; }
    return { lat, lng, complexName, streetAddress };
  }).catch(() => ({ lat: null, lng: null, complexName: null, streetAddress: null }));

  log(`vrbo_photo_scrape ${id}: ${photos.length} photos, bedText=${bedText ? bedText.length + "c" : "none"}, sleeps=${sleeps ?? "none"}, geo=${geo.lat != null ? `${geo.lat},${geo.lng}` : "none"}${geo.streetAddress ? ` addr="${geo.streetAddress.slice(0, 40)}"` : ""}`);
  await postResult(id, { photos, bedText, sleeps, lat: geo.lat, lng: geo.lng, complexName: geo.complexName, streetAddress: geo.streetAddress });
}

// ─────────────────────── Booking.com search ─────────────────────────
async function processBookingSearch(id, params) {
  const { destination, searchTerm } = params;
  const effectiveSearchTerm = String(searchTerm || destination || "").trim();
  await ensureBrowser();
  if (params?.searchMode === "map_bounds" || params?.mapSearch?.enabled) {
    const mapVariant = {
      searchTerm: effectiveSearchTerm,
      typedQuery: effectiveSearchTerm,
      suggestionText: params?.mapSearch?.targetName || effectiveSearchTerm,
      source: "map-bounds",
    };
    const cards = await runBookingMapBoundsSearchVariant(id, params, mapVariant);
    const uniqueCards = dedupeCandidatesByUrl(cards);
    await postResult(id, {
      candidates: uniqueCards,
      variationsTried: [{
        term: effectiveSearchTerm,
        typedQuery: effectiveSearchTerm,
        suggestionText: mapVariant.suggestionText,
        source: "map-bounds",
        success: true,
        candidateCount: uniqueCards.length,
      }],
    });
    return;
  }
  const variants = await discoverOtaSearchVariants("https://www.booking.com/", effectiveSearchTerm, destination, "booking_search", id, params);
  const result = await runOtaSearchVariants(id, "booking_search", variants, (variant) =>
    runBookingSearchVariant(id, params, variant),
  );
  await postResult(id, result);
}

async function waitForBookingResultsSurface(targetPage, id, effectiveSearchTerm) {
  if (!targetPage || targetPage.isClosed?.()) {
    return { propertyCards: 0, hotelLinks: 0, noResults: false, priceMentions: 0, excerpt: "" };
  }

  await targetPage.waitForFunction(() => {
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ");
    const hasResultCard = Boolean(
      document.querySelector('[data-testid="property-card"], [data-testid="property-card-container"], [data-testid*="property-card" i], a[href*="/hotel/"]'),
    );
    const hasTerminalEmptyState = /\b(?:no properties|no results|couldn'?t find|no availability|sold out|not available)\b/i.test(bodyText);
    return hasResultCard || hasTerminalEmptyState;
  }, null, { timeout: 10_000 }).catch(() => null);

  await targetPage.evaluate(async () => {
    window.scrollBy({ top: Math.round(window.innerHeight * 0.65), left: 0, behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 450));
    window.scrollBy({ top: Math.round(window.innerHeight * 0.65), left: 0, behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 450));
  }).catch(() => null);
  await targetPage.waitForTimeout(600).catch(() => {});

  const diagnostics = await targetPage.evaluate(() => {
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return {
      propertyCards: document.querySelectorAll('[data-testid="property-card"], [data-testid="property-card-container"], [data-testid*="property-card" i]').length,
      hotelLinks: document.querySelectorAll('a[href*="/hotel/"]').length,
      noResults: /\b(?:no properties|no results|couldn'?t find|no availability|sold out|not available)\b/i.test(bodyText),
      priceMentions: (bodyText.match(/(?:US\$|\$)\s*[\d,]+/g) || []).length,
      excerpt: bodyText.slice(0, 260),
    };
  }).catch(() => ({ propertyCards: 0, hotelLinks: 0, noResults: false, priceMentions: 0, excerpt: "" }));

  log(
    `booking_search ${id}: results surface for "${effectiveSearchTerm}" ` +
    `propertyCards=${diagnostics.propertyCards} hotelLinks=${diagnostics.hotelLinks} ` +
    `prices=${diagnostics.priceMentions} noResults=${diagnostics.noResults}`,
  );
  return diagnostics;
}

function bookingRequiredTargetTokens(params, effectiveSearchTerm, typedQuery, destination) {
  const mode = params?.variationMode && typeof params.variationMode === "object" ? params.variationMode : {};
  const modeTokens = Array.isArray(mode.filterTokens)
    ? mode.filterTokens.map((token) => String(token || "").toLowerCase().trim()).filter((token) => token.length >= 3)
    : [];
  const resortTokens = otaQueryTokens(
    otaBaseSearchQuery(effectiveSearchTerm, destination) || typedQuery || effectiveSearchTerm,
  );
  const cityTokens = otaRequiredCityTokens(destination);
  return Array.from(new Set([...modeTokens, ...resortTokens, ...cityTokens])).slice(0, 8);
}

const BOOKING_CARD_GENERIC_LOCATION_TOKENS = new Set([
  "hawaii", "koloa", "kauai", "island", "states", "america", "united", "county", "beach",
]);

function bookingCardTargetTokens(params, effectiveSearchTerm, typedQuery, destination) {
  const tokens = bookingRequiredTargetTokens(params, effectiveSearchTerm, typedQuery, destination)
    .filter((token) => !/^\d{1,4}$/.test(token));
  const resortSpecific = tokens.filter((token) => !BOOKING_CARD_GENERIC_LOCATION_TOKENS.has(token));
  return (resortSpecific.length > 0 ? resortSpecific : tokens).slice(0, 6);
}

function bookingCardMatchMinHits(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return 0;
  if (tokens.length === 1) return 1;
  return 2;
}

function bookingHaystackMatchesTargetTokens(haystack, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return true;
  const norm = String(haystack || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const hits = tokens.filter((token) => norm.includes(token)).length;
  return hits >= bookingCardMatchMinHits(tokens);
}

function bookingSuggestionMatchesVariant(selected, variantTerm) {
  const variantTokens = otaQueryTokens(variantTerm);
  if (!variantTokens.length) return true;
  return bookingHaystackMatchesTargetTokens(selected, variantTokens);
}

function bookingStateHasRequestedDates(state, checkIn, checkOut) {
  try {
    const url = new URL(String(state?.url || ""));
    const checkin = url.searchParams.get("checkin");
    const checkout = url.searchParams.get("checkout");
    if (checkin === checkIn && checkout === checkOut) return true;
    const inYear = url.searchParams.get("checkin_year");
    const inMonth = url.searchParams.get("checkin_month");
    const inDay = url.searchParams.get("checkin_monthday");
    const outYear = url.searchParams.get("checkout_year");
    const outMonth = url.searchParams.get("checkout_month");
    const outDay = url.searchParams.get("checkout_monthday");
    if (inYear && inMonth && inDay && outYear && outMonth && outDay) {
      const pad = (value) => String(value).padStart(2, "0");
      return `${inYear}-${pad(inMonth)}-${pad(inDay)}` === checkIn &&
        `${outYear}-${pad(outMonth)}-${pad(outDay)}` === checkOut;
    }
  } catch {}
  return false;
}

function bookingStateHasTargetSearchQuery(state, requiredTargetTokens = []) {
  if (!Array.isArray(requiredTargetTokens) || requiredTargetTokens.length === 0) return true;
  try {
    const url = new URL(String(state?.url || ""));
    if (!/\/searchresults/i.test(url.pathname)) return true;
    const searchText = [
      url.searchParams.get("ss"),
      url.searchParams.get("ssne"),
      url.searchParams.get("dest_id"),
      url.searchParams.get("dest_type"),
    ].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ");
    if (!searchText.trim()) return true;
    return bookingHaystackMatchesTargetTokens(searchText, requiredTargetTokens);
  } catch {}
  return true;
}

function buildBookingDatedSearchUrl(searchTerm, checkIn, checkOut, bedrooms) {
  const safeSearchTerm = String(searchTerm || "").replace(/\s+/g, " ").trim();
  const url = new URL("https://www.booking.com/searchresults.html");
  url.searchParams.set("ss", safeSearchTerm);
  url.searchParams.set("ssne", safeSearchTerm);
  url.searchParams.set("ssne_untouched", safeSearchTerm);
  url.searchParams.set("checkin", checkIn);
  url.searchParams.set("checkout", checkOut);
  url.searchParams.set("group_adults", "2");
  url.searchParams.set("group_children", "0");
  url.searchParams.set("no_rooms", "1");
  url.searchParams.set("selected_currency", "USD");
  url.searchParams.set("order", "price");
  if (bedrooms) url.searchParams.set("nflt", `entire_place_bedroom_count=${bedrooms}`);
  return url.toString();
}

function buildBookingMapSearchUrl(params, searchTerm) {
  const url = new URL(buildBookingDatedSearchUrl(searchTerm, params.checkIn, params.checkOut, params.bedrooms));
  url.searchParams.set("map", "1");
  const center = vrboMapCenter(params);
  if (center) {
    url.searchParams.set("latitude", center.lat.toFixed(6));
    url.searchParams.set("longitude", center.lng.toFixed(6));
  }
  return url.toString();
}

async function clickBookingMapControl(targetPage, label, id) {
  const result = await targetPage.evaluate(() => {
    function visible(el) {
      if (!el || !(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
    }
    const controls = Array.from(document.querySelectorAll("button, a[role='button'], a[href]"))
      .filter(visible)
      .map((el) => ({
        el,
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        aria: el.getAttribute("aria-label") || "",
        href: el.getAttribute("href") || "",
      }));
    const mapButton = controls.find((c) => /\b(view\s+)?map(\s+view)?\b|show\s+(?:on\s+)?map|open\s+map|view\s+on\s+map/i.test(`${c.text} ${c.aria}`));
    if (mapButton) {
      mapButton.el.scrollIntoView({ block: "center", inline: "center" });
      mapButton.el.click();
      return { clicked: true, label: `${mapButton.text} ${mapButton.aria}`.trim().slice(0, 80) };
    }
    return { clicked: false };
  }).catch((e) => ({ clicked: false, error: e?.message ?? String(e) }));
  if (result.clicked) {
    log(`${label} ${id}: opened Booking.com map view via "${result.label}"`);
    await boundedPageDelay(targetPage, 1_500);
    await dismissBookingPopups(targetPage, `${label}_map`).catch(() => []);
  }
  return result.clicked;
}

async function clickBookingSearchThisArea(targetPage, label, id) {
  const result = await targetPage.evaluate(() => {
    function visible(el) {
      if (!el || !(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
    }
    const buttons = Array.from(document.querySelectorAll("button, a[role='button']"))
      .filter(visible)
      .map((el) => ({
        el,
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        aria: el.getAttribute("aria-label") || "",
      }));
    const searchArea = buttons.find((b) => /\bsearch\s+(this\s+)?area\b|update\s+results|show\s+results|redo\s+search/i.test(`${b.text} ${b.aria}`));
    if (searchArea) {
      searchArea.el.scrollIntoView({ block: "center", inline: "center" });
      searchArea.el.click();
      return { clicked: true, label: `${searchArea.text} ${searchArea.aria}`.trim().slice(0, 80) };
    }
    return { clicked: false };
  }).catch((e) => ({ clicked: false, error: e?.message ?? String(e) }));
  if (result.clicked) {
    log(`${label} ${id}: clicked Booking.com map area search "${result.label}"`);
    await boundedPageDelay(targetPage, 2_000);
  }
  return result.clicked;
}

async function extractVisibleBookingCards(targetPage, id, params, expectedNights, requiredTargetTokens, requiredTargetMinHits, variantLabel) {
  const cards = await targetPage.evaluate(({ minBd, expectedNights, requiredTargetTokens, requiredTargetMinHits }) => {
    const cardSet = new Set();
    for (const selector of [
      '[data-testid="property-card"]',
      '[data-testid="property-card-container"]',
      '[data-testid*="property-card" i]',
      'article:has(a[href*="/hotel/"])',
      '[role="listitem"]:has(a[href*="/hotel/"])',
      '[class*="property-card" i]',
      '[class*="sr_property_block" i]',
    ]) {
      document.querySelectorAll(selector).forEach((el) => cardSet.add(el));
    }
    for (const link of document.querySelectorAll('a[href*="/hotel/"]')) {
      let el = link;
      let picked = null;
      for (let depth = 0; depth < 7 && el; depth++, el = el.parentElement) {
        if (!(el instanceof HTMLElement)) continue;
        const text = (el.textContent || "").replace(/\s+/g, " ");
        if (text.length >= 80 && (/(?:US\$|\$)\s*[\d,]+/.test(text) || /\bbed(?:room)?s?\b|\bbr\b/i.test(text))) picked = el;
      }
      if (picked) cardSet.add(picked);
    }
    const out = [];
    const drops = { noUrl: 0, noPrice: 0, noBedrooms: 0, wrongTarget: 0 };
    let firstCardSample = null;
    function moneyAmounts(text) {
      return Array.from(String(text || "").matchAll(/(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)/g))
        .map((m) => Math.round(parseFloat(m[1].replace(/,/g, ""))))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    function bedroomNumber(text) {
      const raw = String(text || "");
      const digitMatch = raw.match(/(\d+)\s*(?:bedrooms?|beds?|br|bd)\b/i);
      if (digitMatch) return parseInt(digitMatch[1], 10);
      const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
      const wordMatch = raw.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)[-\s]*(?:bedrooms?|beds?|br|bd)\b/i);
      return wordMatch ? words[wordMatch[1]] : 0;
    }
    function plausibleStayTotals(amounts, minStayTotal, maxStayTotal) {
      return amounts.filter((n) => n >= minStayTotal && n <= maxStayTotal);
    }
    function numAttr(el, names) {
      for (const name of names) {
        const value = Number(el.getAttribute?.(name) || el.dataset?.[name.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())]);
        if (Number.isFinite(value)) return value;
      }
      return null;
    }
    for (const card of Array.from(cardSet)) {
      const titleEl = card.querySelector([
        '[data-testid="title"]',
        '[data-testid*="title" i]',
        '[data-testid*="name" i]',
        '[itemprop="name"]',
        '[aria-label*="property" i]',
        '[class*="title" i]',
        '[class*="name" i]',
        "h3",
        "h2",
        'a[href*="/hotel/"]',
      ].join(", ")) ?? card.querySelector("h3, h2, a[href*='/hotel/']");
      const title = titleEl
        ? (titleEl.textContent || titleEl.getAttribute?.("aria-label") || titleEl.getAttribute?.("title") || "").trim()
        : "";
      const link = card.matches?.('a[href*="/hotel/"]') ? card : card.querySelector('a[href*="/hotel/"]');
      const href = link ? link.getAttribute("href") || "" : "";
      const imgEls = Array.from(card.querySelectorAll("img")).slice(0, 5);
      const images = imgEls
        .map((img) => img.currentSrc || img.src || img.getAttribute("data-src") || "")
        .filter((src) => /^https?:\/\//i.test(src));
      const url = href.startsWith("http") ? href.split("?")[0] : href ? "https://www.booking.com" + href.split("?")[0] : "";
      const fullText = [
        card.textContent || "",
        card.getAttribute?.("aria-label") || "",
        card.getAttribute?.("title") || "",
        Array.from(card.querySelectorAll("[aria-label], [title]")).slice(0, 20)
          .map((el) => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`)
          .join(" "),
      ].join(" ").replace(/\s+/g, " ");
      const targetHaystack = `${title} ${url} ${fullText}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const targetHits = Array.isArray(requiredTargetTokens)
        ? requiredTargetTokens.filter((token) => targetHaystack.includes(token)).length
        : 0;
      const hasRequiredTarget = !Array.isArray(requiredTargetTokens) ||
        requiredTargetTokens.length === 0 ||
        targetHits >= (requiredTargetMinHits || requiredTargetTokens.length);
      const priceEl = card.querySelector([
        '[data-testid="price-and-discounted-price"]',
        '[data-testid*="price" i]',
        '[aria-label*="$"]',
        '[class*="price" i]',
        '[class*="rate" i]',
      ].join(", "));
      const priceText = priceEl ? priceEl.textContent.replace(/\s+/g, " ") : "";
      const minStayTotal = Math.max(250, expectedNights * 175);
      const maxStayTotal = Math.max(30_000, expectedNights * Math.max(minBd, 1) * 2_500);
      const fullStayTotals = plausibleStayTotals(moneyAmounts(fullText), minStayTotal, maxStayTotal);
      const priceElStayTotals = plausibleStayTotals(moneyAmounts(priceText), 1, maxStayTotal);
      let totalPrice = fullStayTotals.length > 0
        ? Math.max(...fullStayTotals)
        : priceElStayTotals.length > 0
          ? Math.max(...priceElStayTotals)
          : 0;
      if (minBd >= 3 && totalPrice > 0 && totalPrice < minStayTotal) totalPrice = 0;
      const bedrooms = bedroomNumber(fullText);
      const lat = numAttr(card, ["data-lat", "data-latitude", "lat", "latitude"]);
      const lng = numAttr(card, ["data-lng", "data-lon", "data-longitude", "lng", "lon", "longitude"]);
      const hotelId = (url.match(/\/hotel\/[^/]+\/([^/.?#]+)/i)?.[1] || url.match(/hotel_id=(\d+)/i)?.[1] || "").slice(0, 80);
      if (firstCardSample === null) {
        firstCardSample = { title: title.slice(0, 80), url: url.slice(0, 120), bedrooms, price: totalPrice, textExcerpt: fullText.slice(0, 240) };
      }
      if (!url) { drops.noUrl++; continue; }
      if (!hasRequiredTarget) { drops.wrongTarget++; continue; }
      if (!(totalPrice > 0)) { drops.noPrice++; continue; }
      if (bedrooms < minBd) { drops.noBedrooms++; continue; }
      out.push({
        url,
        title: title.slice(0, 110),
        totalPrice,
        nightlyPrice: Math.round(totalPrice / expectedNights),
        bedrooms: bedrooms || undefined,
        bedroomSource: bedrooms ? "search-card" : "unknown",
        priceIncludesTaxes: true,
        priceIncludesFees: true,
        priceBasis: "all_in",
        image: images[0],
        images,
        lat,
        lng,
        bookingId: hotelId || undefined,
        captureSource: "booking_map_search_results",
        snippet: fullText.slice(0, 260),
      });
    }
    return { out, drops, totalSeen: cardSet.size, firstCardSample };
  }, { minBd: params.bedrooms, expectedNights, requiredTargetTokens, requiredTargetMinHits });

  const resultCards = cards.out || [];
  log(
    `booking_search ${id}: ${resultCards.length} map cards for "${variantLabel}" ` +
    `[seen=${cards.totalSeen ?? 0}, drops=noUrl:${cards.drops?.noUrl ?? 0}/wrongTarget:${cards.drops?.wrongTarget ?? 0}/noPrice:${cards.drops?.noPrice ?? 0}/noBR:${cards.drops?.noBedrooms ?? 0}]`,
  );
  if (resultCards.length === 0 && cards.firstCardSample) {
    log(
      `booking_search ${id}: empty map-result diagnostic — first card title="${cards.firstCardSample.title}" ` +
      `url="${cards.firstCardSample.url}" br=${cards.firstCardSample.bedrooms} price=${cards.firstCardSample.price} ` +
      `text="${cards.firstCardSample.textExcerpt}"`,
    );
  }
  return resultCards.map((card) => ({ ...card, searchVariant: variantLabel }));
}

async function runBookingMapBoundsSearchVariant(id, params, variant = null) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(variant?.searchTerm || searchTerm || destination || "").trim();
  const typedQuery = String(variant?.typedQuery || effectiveSearchTerm).trim();
  const bounds = numericMapBounds(params);
  const center = vrboMapCenter(params);
  log(
    `booking_search ${id}: map-bounds searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR` +
    (center ? ` center=${center.lat.toFixed(6)},${center.lng.toFixed(6)}` : "") +
    (bounds ? ` bounds=${bounds.sw_lat.toFixed(5)},${bounds.sw_lng.toFixed(5)},${bounds.ne_lat.toFixed(5)},${bounds.ne_lng.toFixed(5)}` : ""),
  );
  await ensureBrowser();
  throwIfRequestCancelled(id);
  if (!page || page.isClosed?.()) {
    throw new SidecarCancelledError(`booking_search ${id}: browser page unavailable`);
  }
  await surfaceVisibleOtaSearchWindow(page, "booking_search", id);
  await clearOtaClientSearchState("https://www.booking.com", `booking_search ${id} map-bounds preflight`);
  const url = buildBookingMapSearchUrl(params, effectiveSearchTerm);
  logProviderMapSearchPlan("booking_search", id, "booking", params, effectiveSearchTerm, url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await stopOtaProviderIfBlocked(page, "booking_search", id);
  await dismissBookingPopups(page, "booking_search_map_after_dated_url");
  await clickBookingMapControl(page, "booking_search", id).catch(() => false);
  await clickBookingSearchThisArea(page, "booking_search", id).catch(() => false);
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await dismissBookingPopups(page, "booking_search_map_before_scrape");
  const resultsSurface = await waitForBookingResultsSurface(page, id, effectiveSearchTerm);
  let state = await dumpPageState("booking-map", { id, ...params });
  throwIfBrightDataKycBlock(state, "booking_search", id);
  if (await stopOtaProviderIfBlocked(page, "booking_search", id, state)) {
    state = await dumpPageState("booking-map-after-captcha", { id, ...params });
  }
  const lateDismissals = await dismissBookingPopups(page, "booking_search_map_after_block_check");
  if (lateDismissals.length > 0) {
    await page.waitForTimeout(800).catch(() => {});
    state = await dumpPageState("booking-map-after-popup-dismiss", { id, ...params });
  }
  throwIfBlankSearchPage(state, "booking.com", "booking_search", id);
  if (state && stateLooksLikeVrboHumanChallenge(state)) {
    throw new VrboHardBlockError(
      "Booking.com human-verification page remained visible after CapSolver/manual handling",
      { label: "booking_search", id, url: state?.url, retryLater: true },
    );
  }
  if (state && /access denied|are you a robot|please verify/i.test(state.bodyExcerpt)) {
    throw new Error("Booking.com bot wall — refresh cookies or retry after proxy rotation");
  }
  const expectedNights = nightsBetween(checkIn, checkOut);
  const requiredTargetTokens = bookingCardTargetTokens(params, effectiveSearchTerm, typedQuery, destination);
  const requiredTargetMinHits = bookingCardMatchMinHits(requiredTargetTokens);
  if (!bookingStateHasTargetSearchQuery(state, requiredTargetTokens)) {
    throw new ProviderBrowserUnavailableError(
      `Booking.com map results URL no longer includes required target token(s) ${requiredTargetTokens.join("+")}; refusing broad results.`,
      {
        label: "booking_search",
        id,
        provider: "booking",
        url: state?.url,
        title: state?.title,
        requiredTargetTokens,
      },
    );
  }
  if (!bookingStateHasRequestedDates(state, checkIn, checkOut) && resultsSurface.propertyCards > 0 && resultsSurface.priceMentions === 0) {
    throw new ProviderBrowserUnavailableError(
      `Booking.com map search reached an unpriced results page without preserving ${checkIn}→${checkOut}; refusing to treat that as a completed dated search.`,
      {
        label: "booking_search",
        id,
        provider: "booking",
        url: state?.url,
        title: state?.title,
        resultsSurface,
      },
    );
  }
  return extractVisibleBookingCards(page, id, params, expectedNights, requiredTargetTokens, requiredTargetMinHits, effectiveSearchTerm);
}

async function applyOtaHomepageDateInputs(targetPage, checkIn, checkOut, label = "booking_search", provider = "booking") {
  if (!targetPage || targetPage.isClosed?.()) return null;

  const openLabel = await withSoftTimeout(
    targetPage.evaluate(({ provider }) => {
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
      function textOf(el) {
        return [
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-testid"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }
      function contextOf(el) {
        const parts = [textOf(el)];
        let cur = el.parentElement;
        for (let i = 0; cur && i < 2; i++, cur = cur.parentElement) {
          const txt = (cur.textContent || "").replace(/\s+/g, " ").trim();
          if (txt.length <= 220) parts.push(txt);
          parts.push(cur.getAttribute?.("aria-label"));
          parts.push(cur.getAttribute?.("data-testid"));
        }
        return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], div[tabindex], span[tabindex]"))
        .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true")
        .map((el) => {
          const label = textOf(el);
          const ctx = contextOf(el);
          const haystack = `${label} ${ctx}`;
          let score = 0;
          if (/check[\s-]*in|check[\s-]*out|arrival|departure/i.test(haystack)) score += 90;
          if (/\bdate|dates|calendar|when|add dates\b/i.test(haystack)) score += 70;
          if (provider === "airbnb" && /\bwhen\b|add dates|check[\s-]*in|check[\s-]*out/i.test(haystack)) score += 40;
          if (provider === "vrbo" && /\bdates?\b|check[\s-]*in|check[\s-]*out/i.test(haystack)) score += 40;
          if (/search|destination|where|guest|currency|account|sign in/i.test(label)) score -= 100;
          if (/destination|where to|where\?|guest|currency|account|sign in/i.test(ctx)) score -= 35;
          if (provider !== "booking" && /\bsearch\b/i.test(label)) score -= 80;
          return { el, label, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      const target = candidates[0]?.el ?? null;
      if (!target) return null;
      target.scrollIntoView?.({ block: "center", inline: "center" });
      target.click();
      return candidates[0].label.slice(0, 100);
    }, { provider }),
    3_000,
    null,
  );
  if (!openLabel) return null;

  await targetPage.waitForTimeout(700).catch(() => {});

  const clickDate = async (iso, role) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const clicked = await withSoftTimeout(
        targetPage.evaluate(({ iso }) => {
          const date = new Date(`${iso}T12:00:00Z`);
          const month = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
          const monthShort = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
          const weekday = date.toLocaleString("en-US", { weekday: "long", timeZone: "UTC" });
          const day = String(date.getUTCDate());
          const year = String(date.getUTCFullYear());
          const labels = [
            iso,
            `${weekday}, ${month} ${day}, ${year}`,
            `${month} ${day}, ${year}`,
            `${monthShort} ${day}, ${year}`,
          ].map((s) => s.toLowerCase());

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
          function textOf(el) {
            return [
              el.textContent,
              el.getAttribute?.("aria-label"),
              el.getAttribute?.("title"),
              el.getAttribute?.("data-date"),
              el.getAttribute?.("datetime"),
            ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
          }
          function clickable(el) {
            const button = el.closest?.("button, [role='button']");
            return button instanceof HTMLElement ? button : el;
          }

          const exact = Array.from(document.querySelectorAll(`[data-date="${CSS.escape(iso)}"], [datetime="${CSS.escape(iso)}"]`))
            .find((el) => isVisible(el) && !clickable(el).disabled && clickable(el).getAttribute?.("aria-disabled") !== "true");
          if (exact) {
            const target = clickable(exact);
            target.scrollIntoView?.({ block: "center", inline: "center" });
            target.click();
            return textOf(target).slice(0, 100) || iso;
          }

          const candidates = Array.from(document.querySelectorAll("button, [role='button'], td, span, div"))
            .filter((el) => el instanceof HTMLElement && isVisible(el))
            .map((el) => {
              const label = textOf(el);
              const lower = label.toLowerCase();
              const target = clickable(el);
              if (target.disabled || target.getAttribute?.("aria-disabled") === "true") return null;
              const matched = labels.some((needle) => needle && lower.includes(needle));
              if (!matched) return null;
              let score = 0;
              if (lower.includes(iso)) score += 100;
              if (lower.includes(month.toLowerCase()) && lower.includes(day) && lower.includes(year)) score += 80;
              if (el.tagName.toLowerCase() === "button" || el.getAttribute?.("role") === "button") score += 20;
              return { el: target, label, score };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);
          const target = candidates[0]?.el ?? null;
          if (!target) return null;
          target.scrollIntoView?.({ block: "center", inline: "center" });
          target.click();
          return candidates[0].label.slice(0, 100) || iso;
        }, { iso }),
        3_000,
        null,
      );
      if (clicked) return { role, label: clicked, visible: true };

      const advanced = await withSoftTimeout(
        targetPage.evaluate(() => {
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
          function textOf(el) {
            return [
              el.textContent,
              el.getAttribute?.("aria-label"),
              el.getAttribute?.("title"),
              el.getAttribute?.("data-testid"),
            ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
          }
          const navCandidates = Array.from(document.querySelectorAll("button, [role='button'], a, [class*='next' i], [class*='paging' i], [class*='chevron' i], [class*='arrow' i]"))
            .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true")
            .map((el) => ({
              el,
              label: textOf(el),
              cls: String(el.className || ""),
              tag: String(el.tagName || ""),
              rect: el.getBoundingClientRect(),
            }))
            .filter(({ label, cls, rect }) => {
              if (/^\d{1,2}$/.test(String(label || "").trim())) return false;
              if (rect.width > 150 || rect.height > 90) return false;
              return /\bnext\b|›|»|→/i.test(label) || /next|paging|chevron|arrow/i.test(cls);
            })
            .sort((a, b) => ((a.rect.left + a.rect.right) / 2) - ((b.rect.left + b.rect.right) / 2));
          const explicit = navCandidates
            .filter(({ label, cls }) => /\bnext\b|›|»|→|chevron.*right|arrow.*right/i.test(`${label} ${cls}`))
            .sort((a, b) => (
              (/button/i.test(b.tag) ? 4 : 0) + (/paging/i.test(b.cls) ? 3 : 0) + (b.rect.width <= 60 ? 1 : 0)
            ) - (
              (/button/i.test(a.tag) ? 4 : 0) + (/paging/i.test(a.cls) ? 3 : 0) + (a.rect.width <= 60 ? 1 : 0)
            ))[0];
          const next = explicit?.el || navCandidates[navCandidates.length - 1]?.el || null;
          if (!next) return null;
          next.click();
          return textOf(next).slice(0, 80) || "next";
        }),
        2_000,
        null,
      );
      if (!advanced) break;
      await targetPage.waitForTimeout(500).catch(() => {});
    }
    return null;
  };

  const checkin = await clickDate(checkIn, "checkin");
  await targetPage.waitForTimeout(500).catch(() => {});
  const checkout = await clickDate(checkOut, "checkout");
  await targetPage.waitForTimeout(500).catch(() => {});
  const doneLabel = await withSoftTimeout(
    targetPage.evaluate(() => {
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
      function textOf(el) {
        return [el.textContent, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
          .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }
      const done = Array.from(document.querySelectorAll("button, [role='button']"))
        .find((el) => el instanceof HTMLElement && isVisible(el) && /^(?:done|apply|ok)$/i.test(textOf(el)) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
      if (!done) return null;
      done.click();
      return textOf(done).slice(0, 80) || "Done";
    }),
    2_000,
    null,
  );

  const filled = [checkin, checkout].filter(Boolean);
  if (filled.length > 0 || doneLabel) {
    log(
      `${label}: ${provider} date picker opened="${openLabel}" filled=${filled.length}` +
      `${filled.length ? ` roles=${filled.map((f) => f.role).join("+")}` : ""}` +
      `${doneLabel ? ` clicked="${doneLabel}"` : ""}`,
    );
  }
  return { filled, openedLabel: openLabel, submitLabel: doneLabel, controlCount: 0 };
}

async function applyBookingDateInputs(targetPage, checkIn, checkOut, label = "booking_search") {
  return applyOtaHomepageDateInputs(targetPage, checkIn, checkOut, label, "booking");
}

async function applyVrboVisibleCalendarDates(targetPage, checkIn, checkOut, label = "vrbo_search") {
  if (!targetPage || targetPage.isClosed?.()) return null;

  const result = await withSoftTimeout(
    targetPage.evaluate(async ({ checkIn, checkOut }) => {
      const monthNames = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
      ];
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clean = (raw) => String(raw || "").replace(/\s+/g, " ").trim();
      const parseIso = (iso) => {
        const [year, month, day] = String(iso || "").split("-").map((part) => parseInt(part, 10));
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
        return { year, month, day };
      };
      const targetIn = parseIso(checkIn);
      const targetOut = parseIso(checkOut);
      if (!targetIn || !targetOut) return null;

      function isVisible(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
      }

      function textOf(el) {
        return [el.textContent, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
          .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      }

      function click(el) {
        if (!el) return false;
        el.scrollIntoView?.({ block: "center", inline: "center" });
        const init = { bubbles: true, cancelable: true, view: window };
        try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("mousedown", init)); } catch {}
        try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("mouseup", init)); } catch {}
        try { el.dispatchEvent(new MouseEvent("click", init)); } catch { el.click?.(); }
        return true;
      }

      function visibleMonths() {
        const body = clean(document.body?.innerText || "").toLowerCase();
        const current = body.match(/current months are\s+([a-z]+),\s*(\d{4})\s+and\s+([a-z]+),\s*(\d{4})/i);
        if (current) {
          return [
            { month: monthNames.indexOf(current[1].toLowerCase()) + 1, year: Number(current[2]) },
            { month: monthNames.indexOf(current[3].toLowerCase()) + 1, year: Number(current[4]) },
          ].filter((item) => item.month > 0 && Number.isFinite(item.year));
        }
        const found = [];
        for (const el of Array.from(document.querySelectorAll("*"))) {
          if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
          const text = clean(el.textContent);
          if (text.length > 40) continue;
          const match = text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i);
          if (!match) continue;
          const month = monthNames.indexOf(match[1].toLowerCase()) + 1;
          const year = Number(match[2]);
          if (month > 0 && Number.isFinite(year) && !found.some((item) => item.month === month && item.year === year)) {
            found.push({ month, year });
          }
        }
        return found.slice(0, 2);
      }

      function daysInMonth(year, month) {
        return new Date(Date.UTC(year, month, 0)).getUTCDate();
      }

      function dayButtons() {
        return Array.from(document.querySelectorAll(".uitk-day-button, [class*='day-button' i], [data-day], [role='button']"))
          .filter((el) => el instanceof HTMLElement && isVisible(el))
          .filter((el) => {
            const text = clean(el.textContent);
            const aria = clean(el.getAttribute?.("aria-label"));
            const dataDay = clean(el.getAttribute?.("data-day"));
            const dataDate = clean(el.getAttribute?.("data-date"));
            const datetime = clean(el.getAttribute?.("datetime"));
            return /^\d{1,2}$/.test(text) ||
              /^\d{1,2}$/.test(dataDay) ||
              /^\d{4}-\d{2}-\d{2}$/.test(dataDate) ||
              /^\d{4}-\d{2}-\d{2}$/.test(datetime) ||
              /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(aria);
          });
      }

      function compareMonth(a, b) {
        return (a.year * 12 + a.month) - (b.year * 12 + b.month);
      }

      function calendarNavButton(direction) {
        const wantsNext = direction === "next";
        const buttons = Array.from(document.querySelectorAll("button, [role='button'], a, [class*='next' i], [class*='paging' i]"))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true")
          .map((el) => ({ el, text: textOf(el), cls: String(el.className || ""), tag: String(el.tagName || ""), rect: el.getBoundingClientRect() }))
          .filter(({ text, cls, rect }) => {
            if (/^\d{1,2}$/.test(clean(text))) return false;
            if (rect.width > 140 || rect.height > 80) return false;
            return /\b(?:next|following|previous|prev|back)\b|[›»→‹«←]/i.test(text) ||
              /paging|next|prev|chevron|arrow/i.test(cls);
          });
        const explicit = buttons.filter(({ text, cls }) => {
          const hay = `${text} ${cls}`;
          return wantsNext
            ? /\b(?:next|following)\b|›|»|→|chevron.*right|arrow.*right/i.test(hay)
            : /\b(?:previous|prev|back)\b|‹|«|←|chevron.*left|arrow.*left/i.test(hay);
        }).sort((a, b) => (
          (/button/i.test(b.tag) ? 4 : 0) + (/paging/i.test(b.cls) ? 3 : 0) + (b.rect.width <= 60 ? 1 : 0)
        ) - (
          (/button/i.test(a.tag) ? 4 : 0) + (/paging/i.test(a.cls) ? 3 : 0) + (a.rect.width <= 60 ? 1 : 0)
        ))[0];
        if (explicit?.el) return explicit.el;
        const paging = buttons
          .filter(({ cls }) => /paging|chevron|arrow/i.test(cls))
          .sort((a, b) => ((a.rect.left + a.rect.right) / 2) - ((b.rect.left + b.rect.right) / 2));
        return wantsNext ? paging[paging.length - 1]?.el || null : paging[0]?.el || null;
      }

      function nextButton() {
        return calendarNavButton("next");
      }

      function prevButton() {
        return calendarNavButton("prev");
      }

      async function bringMonthIntoView(target) {
        for (let i = 0; i < 18; i++) {
          const months = visibleMonths();
          if (months.some((month) => month.month === target.month && month.year === target.year)) return months;
          if (!months.length) break;
          const last = months[months.length - 1];
          const first = months[0];
          const nav = compareMonth(target, last) > 0 ? nextButton() : compareMonth(target, first) < 0 ? prevButton() : null;
          if (!nav) break;
          click(nav);
          await sleep(350);
        }
        return visibleMonths();
      }

      function isEnabledDay(el) {
        return !(el.disabled || el.getAttribute?.("aria-disabled") === "true");
      }

      function dayButtonsWithin(root) {
        return Array.from(root.querySelectorAll(".uitk-day-button, [class*='day-button' i], [data-day], [role='button']"))
          .filter((el) => el instanceof HTMLElement && isVisible(el))
          .filter((el) => {
            const text = clean(el.textContent);
            const dataDay = clean(el.getAttribute?.("data-day"));
            const dataDate = clean(el.getAttribute?.("data-date"));
            const datetime = clean(el.getAttribute?.("datetime"));
            return /^\d{1,2}$/.test(text) || /^\d{1,2}$/.test(dataDay) ||
              /^\d{4}-\d{2}-\d{2}$/.test(dataDate) || /^\d{4}-\d{2}-\d{2}$/.test(datetime);
          });
      }

      function monthHeadingEls() {
        const out = [];
        for (const el of Array.from(document.querySelectorAll("*"))) {
          if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
          const text = clean(el.textContent);
          if (text.length > 40) continue;
          if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i.test(text)) {
            out.push(el);
          }
        }
        return out;
      }

      // VRBO/Expedia renders TWO months at once and the day cells are usually
      // bare numbers ("20" exists in both June and July). The previous scorer
      // gave a bare-number/role match enough points to "win", so it silently
      // clicked the FIRST "20" in the DOM — the current month — instead of the
      // requested month. That landed July 20→27 on June 20→27. Disambiguate by
      // real metadata first, then by month-grid container, then by column x.
      function findVisibleDay(target, months) {
        const buttons = dayButtons();
        const monthName = monthNames[target.month - 1];
        const monthShort = monthName.slice(0, 3);
        const yyyy = String(target.year);
        const mm = String(target.month).padStart(2, "0");
        const dd = String(target.day).padStart(2, "0");
        const iso = `${yyyy}-${mm}-${dd}`;
        const dayNeedle = new RegExp(`\\b${target.day}\\b`);

        // 1) STRICT metadata match. Only cells that actually encode the target
        //    month+year (or the full ISO date) may win here. A bare day number
        //    is intentionally NOT scored — it cannot tell June 20 from July 20.
        const strict = buttons
          .map((el) => {
            if (!isEnabledDay(el)) return null;
            const hay = [
              textOf(el),
              el.getAttribute?.("data-day"),
              el.getAttribute?.("data-date"),
              el.getAttribute?.("datetime"),
            ].filter(Boolean).join(" ").toLowerCase();
            let score = 0;
            if (hay.includes(iso)) score += 500;
            else if (hay.includes(monthName) && hay.includes(yyyy) && dayNeedle.test(hay)) score += 350;
            else if (hay.includes(monthShort) && hay.includes(yyyy) && dayNeedle.test(hay)) score += 260;
            return score > 0 ? { el, score } : null;
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)[0]?.el;
        if (strict) return strict;

        // 2) MONTH-CONTAINER match. Day cells are bare numbers: walk up from the
        //    target month's heading to the grid that holds its day buttons (and
        //    no OTHER month heading), then pick the day inside that grid. Robust
        //    to the current month hiding past days and to vertical layouts.
        const allHeadings = monthHeadingEls();
        const targetHeadingText = `${monthName} ${yyyy}`.toLowerCase();
        const heading = allHeadings.find((el) => clean(el.textContent).toLowerCase() === targetHeadingText);
        if (heading) {
          let node = heading;
          for (let i = 0; i < 6 && node; i++) {
            const parent = node.parentElement;
            if (!parent) break;
            const within = dayButtonsWithin(parent);
            const headingsInside = allHeadings.filter((h) => parent.contains(h));
            if (within.length >= 20 && headingsInside.length === 1) {
              const cell = within.find((el) => isEnabledDay(el) && clean(el.textContent) === String(target.day));
              if (cell) return cell;
              break;
            }
            node = parent;
          }
        }

        // 3) POSITIONAL column match. Months render left→right (earlier→later);
        //    pick the same-day cell whose column index matches the target
        //    month's index in the visible-month list.
        const idx = months.findIndex((m) => m.month === target.month && m.year === target.year);
        if (idx >= 0) {
          const sameDay = buttons
            .filter((el) => isEnabledDay(el) && clean(el.textContent) === String(target.day))
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return { el, x: rect.left + rect.width / 2 };
            })
            .sort((a, b) => a.x - b.x);
          if (sameDay.length === 1) return sameDay[0].el;
          if (sameDay.length > 1 && idx < sameDay.length) return sameDay[idx].el;
        }

        // 4) Last resort: original offset-by-daysInMonth slice.
        let offset = 0;
        for (const month of months) {
          const count = daysInMonth(month.year, month.month);
          const slice = buttons.slice(offset, offset + count);
          if (month.month === target.month && month.year === target.year) {
            return slice.find((el) => clean(el.textContent) === String(target.day)) || null;
          }
          offset += count;
        }
        return buttons.find((el) => {
          const hay = textOf(el).toLowerCase();
          return hay.includes(monthName) && hay.includes(String(target.year)) && new RegExp(`\\b${target.day}\\b`).test(hay);
        }) || null;
      }

      function calendarIsOpen() {
        return visibleMonths().length > 0 && dayButtons().length >= 20;
      }

      async function openDatePickerIfNeeded() {
        if (calendarIsOpen()) return true;
        const controls = Array.from(document.querySelectorAll("button, [role='button'], input, [aria-label], [title]"))
          .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true")
          .map((el) => ({ el, text: textOf(el), cls: String(el.className || "") }))
          .filter(({ text, cls }) => {
            const hay = `${text} ${cls}`;
            if (/\b(?:search|guest|currency|sign\s*in|trip boards|list your property|help)\b/i.test(text)) return false;
            return /\b(?:dates?|check[ -]?in|check[ -]?out|calendar)\b/i.test(hay) || /uitk-fake-input|date-selector/i.test(cls);
          });
        const opener = controls[0]?.el || null;
        if (!opener) return false;
        click(opener);
        await sleep(700);
        return calendarIsOpen();
      }

      if (!(await openDatePickerIfNeeded())) return { filled: [], failureReason: "VRBO visible calendar did not open", controlCount: 0 };
      const clear = Array.from(document.querySelectorAll("button, [role='button'], a"))
        .find((el) => el instanceof HTMLElement && isVisible(el) && /^clear$/i.test(textOf(el)));
      if (clear) {
        click(clear);
        await sleep(350);
      }

      const inMonths = await bringMonthIntoView(targetIn);
      const inDay = findVisibleDay(targetIn, inMonths);
      if (!inDay || !click(inDay)) {
        return { filled: [], failureReason: `VRBO visible calendar could not select check-in ${checkIn}`, openedLabel: "VRBO visible calendar", controlCount: 0 };
      }
      await sleep(550);
      const outMonths = await bringMonthIntoView(targetOut);
      const outDay = findVisibleDay(targetOut, outMonths);
      if (!outDay || !click(outDay)) {
        return {
          filled: [{ role: "checkin", label: `${checkIn}`, visible: true }],
          failureReason: `VRBO visible calendar could not select checkout ${checkOut}`,
          openedLabel: "VRBO calendar",
        };
      }
      await sleep(550);
      const done = Array.from(document.querySelectorAll("button, [role='button'], a"))
        .find((el) => el instanceof HTMLElement && isVisible(el) && /^(?:done|apply|ok)$/i.test(textOf(el)));
      if (done) click(done);
      await sleep(500);
      return {
        filled: [
          { role: "checkin", label: `${checkIn}`, visible: true },
          { role: "checkout", label: `${checkOut}`, visible: true },
        ],
        submitLabel: done ? textOf(done).slice(0, 80) || "Done" : null,
        openedLabel: "VRBO visible calendar",
        controlCount: 0,
      };
    }, { checkIn, checkOut }),
    14_000,
    null,
  );

  if (result?.filled?.length) {
    log(`${label}: VRBO visible calendar selected ${result.filled.map((item) => `${item.role}:${item.label}`).join(", ")}${result.submitLabel ? ` and clicked ${result.submitLabel}` : ""}`);
  } else if (result?.failureReason) {
    log(`${label}: ${result.failureReason}`);
  }
  return result;
}

async function applyOtaSearchDateInputs(targetPage, checkIn, checkOut, label, provider) {
  let dateEntry = null;
  if (provider === "vrbo") {
    dateEntry = await applyVrboVisibleCalendarDates(targetPage, checkIn, checkOut, label).catch((e) => {
      log(`${label}: VRBO visible calendar date entry failed: ${e?.message ?? e}`);
      return null;
    });
  }
  if (!pmDateEntryComplete(dateEntry)) {
    const homepageEntry = await applyOtaHomepageDateInputs(targetPage, checkIn, checkOut, label, provider).catch((e) => {
      log(`${label}: homepage deterministic date entry failed: ${e?.message ?? e}`);
      return null;
    });
    dateEntry = mergeDateEntries(dateEntry, homepageEntry);
  }
  if (!pmDateEntryComplete(dateEntry)) {
    const openedLabel = String(dateEntry?.openedLabel || "");
    if (/\b(?:earn\s+airbnb\s+credit|featured\s+hotels|sign[ -]?in|log[ -]?in|register|create\s+account)\b/i.test(openedLabel)) {
      await dismissObstructions(targetPage, `${label}_date_entry_obstruction`, { allowEscape: false }).catch(() => []);
      const retryEntry = await applyOtaHomepageDateInputs(targetPage, checkIn, checkOut, label, provider).catch((e) => {
        log(`${label}: homepage deterministic date retry failed: ${e?.message ?? e}`);
        return null;
      });
      dateEntry = mergeDateEntries(dateEntry, retryEntry);
    }
  }
  if (provider === "vrbo" && !pmDateEntryComplete(dateEntry)) {
    const vrboCalendarEntry = await applyVrboVisibleCalendarDates(targetPage, checkIn, checkOut, label).catch((e) => {
      log(`${label}: VRBO visible calendar date entry failed: ${e?.message ?? e}`);
      return null;
    });
    dateEntry = mergeDateEntries(dateEntry, vrboCalendarEntry);
  }
  if (!pmDateEntryComplete(dateEntry)) {
    await dismissObstructions(targetPage, `${label}_date_entry_visual_assist`, { allowEscape: false });
    const visualEntry = await applyVisualPmDateFallback(targetPage, checkIn, checkOut).catch((e) => {
      log(`${label}: visual date assist failed: ${e?.message ?? e}`);
      return null;
    });
    dateEntry = mergeDateEntries(dateEntry, visualEntry);
    if (visualEntry?.visualReason || visualEntry?.filled?.length) {
      log(
        `${label}: visual date assist ` +
        `${pmDateEntryComplete(dateEntry) ? "completed" : "did not complete"} date entry` +
        `${visualEntry?.visualReason ? ` (${visualEntry.visualReason})` : ""}`,
      );
    }
  }
  if (!pmDateEntryComplete(dateEntry) && dateEntry?.openedLabel) {
    const calendarEntry = await clickPmCalendarDates(targetPage, checkIn, checkOut).catch((e) => {
      log(`${label}: calendar date selection after visual open failed: ${e?.message ?? e}`);
      return null;
    });
    dateEntry = mergeDateEntries(dateEntry, calendarEntry);
  }
  if (!pmDateEntryComplete(dateEntry)) {
    const genericEntry = await applyPmDateInputs(targetPage, checkIn, checkOut, label, { skipVisualFallback: true }).catch((e) => {
      log(`${label}: homepage generic date entry failed: ${e?.message ?? e}`);
      return null;
    });
    dateEntry = mergeDateEntries(dateEntry, genericEntry);
  }
  return dateEntry;
}

async function runBookingSearchVariant(id, params, variant = null) {
  const { destination, searchTerm, checkIn, checkOut, bedrooms } = params;
  const effectiveSearchTerm = String(variant?.searchTerm || searchTerm || destination || "").trim();
  const typedQuery = String(variant?.typedQuery || otaBaseSearchQuery(searchTerm, destination) || effectiveSearchTerm).trim();
  const datedSearchTerm = String(variant?.suggestionText || variant?.searchTerm || effectiveSearchTerm).trim();
  log(
    `booking_search ${id}: searchTerm="${effectiveSearchTerm}" destination="${destination}" ` +
    `${checkIn}→${checkOut} ${bedrooms}BR`,
  );
  await ensureBrowser();
  throwIfRequestCancelled(id);
  if (!page || page.isClosed?.()) {
    throw new SidecarCancelledError(`booking_search ${id}: browser page unavailable`);
  }
  await surfaceVisibleOtaSearchWindow(page, "booking_search", id);
  // Per-variant dropdown click: type the resort prefix and select THIS
  // suggestion before loading the dated results URL (Booking rewrites
  // broad form submits to ss=Koloa, so the URL carries the exact variant).
  if (variant?.suggestionText) {
    await page.goto("https://www.booking.com/", { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    await boundedPageDelay(page, 1_000);
    await dismissObstructions(page, "booking_search_variant_home");
    const picked = await fillVisibleSearchField(page, typedQuery, "booking_search_variant", {
      targetSuggestion: variant.suggestionText,
      chooseSuggestion: true,
      requestId: id,
    }).catch(() => null);
    if (picked?.suggestion) {
      log(
        `booking_search ${id}: selected dropdown "${picked.suggestion}" ` +
        `before dated search for "${datedSearchTerm}"`,
      );
    } else {
      log(
        `booking_search ${id}: dropdown select skipped for "${datedSearchTerm}"; ` +
        "loading dated results URL directly",
      );
    }
  }
  const datedSearchUrl = buildBookingDatedSearchUrl(datedSearchTerm, checkIn, checkOut, bedrooms);
  await page.goto(datedSearchUrl, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await stopOtaProviderIfBlocked(page, "booking_search", id);
  await dismissBookingPopups(page, "booking_search_after_dated_url");
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await dismissBookingPopups(page, "booking_search_before_scrape");
  const resultsSurface = await waitForBookingResultsSurface(page, id, effectiveSearchTerm);
  let state = await dumpPageState("booking", { id, ...params });
  throwIfBrightDataKycBlock(state, "booking_search", id);
  if (await stopOtaProviderIfBlocked(page, "booking_search", id, state)) {
    state = await dumpPageState("booking-after-captcha", { id, ...params });
  }
  const lateDismissals = await dismissBookingPopups(page, "booking_search_after_block_check");
  if (lateDismissals.length > 0) {
    await page.waitForTimeout(800).catch(() => {});
    state = await dumpPageState("booking-after-popup-dismiss", { id, ...params });
  }
  throwIfBlankSearchPage(state, "booking.com", "booking_search", id);
  if (state && stateLooksLikeVrboHumanChallenge(state)) {
    throw new VrboHardBlockError(
      "Booking.com human-verification page remained visible after CapSolver/manual handling",
      { label: "booking_search", id, url: state?.url, retryLater: true },
    );
  }
  if (state && /access denied|are you a robot|please verify/i.test(state.bodyExcerpt)) {
    throw new Error("Booking.com bot wall — refresh cookies or retry after proxy rotation");
  }
  const expectedNights = nightsBetween(checkIn, checkOut);
  const requiredTargetTokens = bookingCardTargetTokens(params, datedSearchTerm, typedQuery, destination);
  const requiredTargetMinHits = bookingCardMatchMinHits(requiredTargetTokens);
  if (!bookingStateHasTargetSearchQuery(state, requiredTargetTokens)) {
    throw new ProviderBrowserUnavailableError(
      `Booking.com results URL no longer includes required resort-prefix token(s) ${requiredTargetTokens.join("+")}; refusing broad city-only results.`,
      {
        label: "booking_search",
        id,
        provider: "booking",
        url: state?.url,
        title: state?.title,
        requiredTargetTokens,
      },
    );
  }
  if (!bookingStateHasRequestedDates(state, checkIn, checkOut) && resultsSurface.propertyCards > 0 && resultsSurface.priceMentions === 0) {
    throw new ProviderBrowserUnavailableError(
      `Booking.com visible search reached an unpriced Koloa/property results page without preserving ${checkIn}→${checkOut}; refusing to treat that as a completed dated search.`,
      {
        label: "booking_search",
        id,
        provider: "booking",
        url: state?.url,
        title: state?.title,
        resultsSurface,
      },
    );
  }

  const cards = await page.evaluate(({ minBd, expectedNights, requiredTargetTokens, requiredTargetMinHits }) => {
    const cardSet = new Set();
    for (const selector of [
      '[data-testid="property-card"]',
      '[data-testid="property-card-container"]',
      '[data-testid*="property-card" i]',
      'article:has(a[href*="/hotel/"])',
      '[role="listitem"]:has(a[href*="/hotel/"])',
      '[aria-label*="property" i]:has(a[href*="/hotel/"])',
      '[class*="property-card" i]',
      '[class*="sr_property_block" i]',
    ]) {
      document.querySelectorAll(selector).forEach((el) => cardSet.add(el));
    }
    for (const link of document.querySelectorAll('a[href*="/hotel/"]')) {
      let el = link;
      let picked = null;
      for (let depth = 0; depth < 7 && el; depth++, el = el.parentElement) {
        if (!(el instanceof HTMLElement)) continue;
        const text = (el.textContent || "").replace(/\s+/g, " ");
        if (text.length >= 80 && (/(?:US\$|\$)\s*[\d,]+/.test(text) || /\bbed(?:room)?s?\b|\bbr\b/i.test(text))) {
          picked = el;
        }
      }
      if (picked) cardSet.add(picked);
    }
    const cards = Array.from(cardSet);
    const out = [];
    const drops = { noUrl: 0, noPrice: 0, noBedrooms: 0, wrongTarget: 0 };
    let firstCardSample = null;
    function moneyAmounts(text) {
      return Array.from(String(text || "").matchAll(/(?:US\$|\$)\s*([\d,]+(?:\.\d+)?)/g))
        .map((m) => Math.round(parseFloat(m[1].replace(/,/g, ""))))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    function plausibleBookingStayTotals(amounts, minStayTotal, maxStayTotal) {
      return amounts.filter((n) => n >= minStayTotal && n <= maxStayTotal);
    }
    function bedroomNumber(text) {
      const raw = String(text || "");
      const digitMatch = raw.match(/(\d+)\s*(?:bedrooms?|beds?|br|bd)\b/i);
      if (digitMatch) return parseInt(digitMatch[1], 10);
      const words = {
        one: 1,
        two: 2,
        three: 3,
        four: 4,
        five: 5,
        six: 6,
        seven: 7,
        eight: 8,
        nine: 9,
        ten: 10,
      };
      const wordMatch = raw.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)[-\s]*(?:bedrooms?|beds?|br|bd)\b/i);
      return wordMatch ? words[wordMatch[1]] : 0;
    }
    for (const card of cards) {
      const titleEl = card.querySelector([
        '[data-testid="title"]',
        '[data-testid*="title" i]',
        '[data-testid*="name" i]',
        '[itemprop="name"]',
        '[aria-label*="property" i]',
        '[class*="title" i]',
        '[class*="name" i]',
        "h3",
        "h2",
        'a[href*="/hotel/"]',
      ].join(", ")) ?? card.querySelector("h3, h2, a[href*='/hotel/']");
      const title = titleEl
        ? (titleEl.textContent || titleEl.getAttribute?.("aria-label") || titleEl.getAttribute?.("title") || "").trim()
        : "";
      const link = card.matches?.('a[href*="/hotel/"]') ? card : card.querySelector('a[href*="/hotel/"]');
      const href = link ? link.getAttribute("href") || "" : "";
      const img = card.querySelector("img");
      const image = img?.currentSrc || img?.src || img?.getAttribute("data-src") || undefined;
      // Strip query string for the canonical URL but keep the .html path.
      const url = href.startsWith("http") ? href.split("?")[0] : href ? "https://www.booking.com" + href.split("?")[0] : "";
      const fullText = [
        card.textContent || "",
        card.getAttribute?.("aria-label") || "",
        card.getAttribute?.("title") || "",
        Array.from(card.querySelectorAll("[aria-label], [title]")).slice(0, 20)
          .map((el) => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`)
          .join(" "),
      ].join(" ").replace(/\s+/g, " ");
      if (/^browse the results\b/i.test(title) || /\bbrowse the results for\b/i.test(fullText.slice(0, 180))) {
        drops.noPrice++;
        continue;
      }
      const targetHaystack = `${title} ${url} ${fullText}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const targetHits = Array.isArray(requiredTargetTokens)
        ? requiredTargetTokens.filter((token) => targetHaystack.includes(token)).length
        : 0;
      const hasRequiredTarget = !Array.isArray(requiredTargetTokens) ||
        requiredTargetTokens.length === 0 ||
        targetHits >= (requiredTargetMinHits || requiredTargetTokens.length);
      // Booking renders price fragments in two different places. On some
      // cards [price-and-discounted-price] is only the nightly rate while
      // the full card text also contains the stay total (e.g.
      // "Per night $1,028 $7,196 Price"). Prefer the largest plausible
      // full-card amount for the requested stay; only fall back to the
      // price element when the full card has no total-like amount.
      const priceEl = card.querySelector([
        '[data-testid="price-and-discounted-price"]',
        '[data-testid*="price" i]',
        '[aria-label*="$"]',
        '[class*="price" i]',
        '[class*="rate" i]',
      ].join(", "));
      const priceText = priceEl ? priceEl.textContent.replace(/\s+/g, " ") : "";
      const priceElAmounts = moneyAmounts(priceText);
      const fullAmounts = moneyAmounts(fullText);
      const minStayTotal = Math.max(250, expectedNights * 175);
      // NOTE FOR CODEX: Booking sometimes concatenates search/header numbers
      // into impossible card totals (for example "$241,891"). Cap parsed stay
      // totals so those artifacts cannot win auto-fill pricing.
      const maxStayTotal = Math.max(30_000, expectedNights * Math.max(minBd, 1) * 2_500);
      const fullStayTotals = plausibleBookingStayTotals(fullAmounts, minStayTotal, maxStayTotal);
      const priceElStayTotals = plausibleBookingStayTotals(priceElAmounts, 1, maxStayTotal);
      let totalPrice = fullStayTotals.length > 0
        ? Math.max(...fullStayTotals)
        : priceElStayTotals.length > 0
        ? Math.max(...priceElStayTotals)
        : 0;
      // If we only found an implausibly-low "total" on a 3BR card, it is
      // almost certainly a nightly/partial-price fragment, not the full
      // stay total. Drop it rather than ranking a bogus $89/night Hawaii
      // 3BR above real resort inventory.
      if (minBd >= 3 && totalPrice > 0 && totalPrice < minStayTotal) {
        totalPrice = 0;
      }
      const bedrooms = bedroomNumber(fullText);
      if (firstCardSample === null) {
        firstCardSample = {
          title: title.slice(0, 80),
          url: url.slice(0, 120),
          bedrooms,
          price: totalPrice,
          textExcerpt: fullText.slice(0, 240),
        };
      }
      if (!url) { drops.noUrl++; continue; }
      if (!hasRequiredTarget) { drops.wrongTarget++; continue; }
      if (!(totalPrice > 0)) { drops.noPrice++; continue; }
      if (bedrooms < minBd) { drops.noBedrooms++; continue; }
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
    return { out, drops, totalSeen: cards.length, firstCardSample };
  }, { minBd: bedrooms, expectedNights, requiredTargetTokens, requiredTargetMinHits });
  const resultCards = cards.out || [];
  log(
    `booking_search ${id}: ${resultCards.length} cards for "${effectiveSearchTerm}" ` +
    `[seen=${cards.totalSeen ?? 0}, surface=${resultsSurface.propertyCards}/${resultsSurface.hotelLinks}, ` +
    `drops=noUrl:${cards.drops?.noUrl ?? 0}/wrongTarget:${cards.drops?.wrongTarget ?? 0}/noPrice:${cards.drops?.noPrice ?? 0}/noBR:${cards.drops?.noBedrooms ?? 0}]`,
  );
  if (resultCards.length === 0 && cards.firstCardSample) {
    log(
      `booking_search ${id}: empty-result diagnostic — first card title="${cards.firstCardSample.title}" ` +
      `url="${cards.firstCardSample.url}" br=${cards.firstCardSample.bedrooms} ` +
      `price=${cards.firstCardSample.price} text="${cards.firstCardSample.textExcerpt}"`,
    );
  } else if (resultCards.length === 0 && resultsSurface.excerpt) {
    log(`booking_search ${id}: empty-result page excerpt="${resultsSurface.excerpt}"`);
  }
  return resultCards.map((card) => ({ ...card, searchVariant: effectiveSearchTerm }));
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
        if (label.includes(`${p.d} ${p.monthLong.toLowerCase()} ${p.y}`) || label.includes(`${p.d} ${p.monthShort.toLowerCase()} ${p.y}`)) return 94;
        if (label.includes(`${p.monthLong.toLowerCase()} ${p.d}`) || label.includes(`${p.monthShort.toLowerCase()} ${p.d}`)) return 86;
        if (label.includes(`${p.d} ${p.monthLong.toLowerCase()}`) || label.includes(`${p.d} ${p.monthShort.toLowerCase()}`)) return 84;
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
          .map((el) => ({ el, label: textOf(el), ctx: contextOf(el), cls: String(el.className || ""), tag: String(el.tagName || ""), rect: el.getBoundingClientRect() }))
          .filter(({ label, ctx, cls, rect }) => {
            if (badActionRe.test(label)) return false;
            if (/^\d{1,2}$/.test(label.trim())) return false;
            if (rect.width > 150 || rect.height > 90) return false;
            return nextRe.test(label.trim()) ||
              /\bnext\b|›|»|→/i.test(label) ||
              /\bnext\b/i.test(ctx) ||
              /paging|chevron|arrow|next/i.test(cls) ||
              /chevron[-_\s]*right|arrow[-_\s]*right/i.test(ctx);
          })
          .sort((a, b) => ((a.rect.left + a.rect.right) / 2) - ((b.rect.left + b.rect.right) / 2));
        const explicit = candidates.filter(({ label, ctx, cls }) =>
          nextRe.test(label.trim()) ||
          /\bnext\b|›|»|→|chevron.*right|arrow.*right/i.test(`${label} ${ctx} ${cls}`),
        ).sort((a, b) => (
          (/button/i.test(b.tag) ? 4 : 0) + (/paging/i.test(b.cls) ? 3 : 0) + (b.rect.width <= 60 ? 1 : 0)
        ) - (
          (/button/i.test(a.tag) ? 4 : 0) + (/paging/i.test(a.cls) ? 3 : 0) + (a.rect.width <= 60 ? 1 : 0)
        ))[0];
        const target = explicit?.el || candidates[candidates.length - 1]?.el || null;
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

  const complete =
    filled.some((f) => f.role === "range") ||
    (filled.some((f) => f.role === "checkin") && filled.some((f) => f.role === "checkout"));
  if (complete) {
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

      function isFillableDateControl(el) {
        if (!el || !(el instanceof HTMLElement)) return false;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();
        if (tag === "textarea" || tag === "select") return true;
        if (el.isContentEditable || el.getAttribute?.("role") === "textbox") return true;
        if (tag !== "input") return false;
        return !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(type);
      }

      function setValue(el, value, iso) {
        if (!el || !(el instanceof HTMLElement)) return false;
        if (!isFillableDateControl(el)) return false;
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
      let openedLabel = null;
      const addFill = (role, id, value, iso) => {
        const el = find(id);
        if (!el) return;
        if (setValue(el, value, iso)) {
          filled.push({ role, label: `visual ${contextOf(el)}`, visible: isVisible(el) });
        } else if (!isFillableDateControl(el)) {
          const label = activate(el);
          if (label) openedLabel = label;
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
        openedLabel,
        controlCount: Number(plan.candidateCount || 0),
        visualReason: clean(plan.reason).slice(0, 160),
      };
    }, { plan, checkIn, checkOut }),
    7_000,
    null,
  ).catch(() => null);
}

async function applyPmDateInputs(targetPage, checkIn, checkOut, label = "pm_url_check", options = {}) {
  if (!targetPage || targetPage.isClosed?.()) return null;
  const skipVisualFallback = options?.skipVisualFallback === true;
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
  const knownPair = await fillKnownPmDatePairs(targetPage, checkIn, checkOut);
  await targetPage.waitForTimeout(hasCompleteDateEntry(knownPair) ? 500 : 0).catch(() => {});
  const first = hasCompleteDateEntry(knownPair)
    ? knownPair
    : mergeDateEntries(knownPair, await attempt(true));
  let result = first;
  if (first?.openedLabel && (!first.filled || first.filled.length === 0)) {
    await targetPage.waitForTimeout(1_000).catch(() => {});
    await dismissObstructions(targetPage, `${label}_date_entry_after_open`);
    const second = await attempt(false);
    result = mergeDateEntries(first, second);
  }
  for (let i = 0; result?.filled?.length > 0 && !hasCompleteDateEntry(result) && i < 2; i++) {
    await targetPage.waitForTimeout(PM_PARTIAL_DATE_RETRY_MS).catch(() => {});
    await dismissObstructions(targetPage, `${label}_date_entry_after_partial`);
    const next = await attempt(false);
    result = mergeDateEntries(result, next);
    if (!next?.filled?.length && !next?.openedLabel && !next?.submitLabel) break;
  }
  if (!hasCompleteDateEntry(result)) {
    await targetPage.waitForTimeout(500).catch(() => {});
    const knownPairRetry = await fillKnownPmDatePairs(targetPage, checkIn, checkOut);
    result = mergeDateEntries(result, knownPairRetry);
  }
  if (!hasCompleteDateEntry(result)) {
    await dismissObstructions(targetPage, `${label}_date_entry_calendar_fallback`);
    const calendar = await clickPmCalendarDates(targetPage, checkIn, checkOut);
    result = mergeDateEntries(result, calendar);
  }
  if (!hasCompleteDateEntry(result) && !skipVisualFallback) {
    await dismissObstructions(targetPage, `${label}_date_entry_visual_fallback`);
    const visual = await applyVisualPmDateFallback(targetPage, checkIn, checkOut);
    result = mergeDateEntries(result, visual);
  }
  if (hasCompleteDateEntry(result) && !result?.submitLabel) {
    await targetPage.waitForTimeout(700).catch(() => {});
    const submitRetry = await attempt(false);
    if (submitRetry?.submitLabel) result = mergeDateEntries(result, submitRetry);
  }
  const filledCount = result?.filled?.length ?? 0;
  const entryComplete = hasCompleteDateEntry(result);
  if (filledCount > 0 || result?.openedLabel || result?.submitLabel) {
    log(
      `${label}: date entry controls=${result?.controlCount ?? 0} filled=${filledCount}` +
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
      await dismissObstructions(targetPage, entryComplete ? `${label}_after_date_entry` : `${label}_after_date_submit`);
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
    if (needsFreshIdentityForOp(opType)) {
      clearVrboManualSessionState(`${opType} ${req.id} fresh identity`);
      if (!keepVisibleLocalChromeGrid() && (browser || context || page || activeChromeAllocation || activeHeadlessProxyBridge)) {
        await teardownBrowser(`fresh identity required for ${opType} ${req.id}`);
      }
    }
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
      await clearContextStorageForFreshRun(`${opType} ${req.id} fresh cache`, {
        force: needsFreshIdentityForOp(opType),
      });
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
    if (needsFreshIdentityForOp(opType) && !keepVisibleLocalChromeGrid()) {
      await teardownBrowser(`finished fresh-identity ${opType}`);
    } else if (activeChromeAllocation?.ephemeral) {
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
    const poll = await pollNext();
    req = poll?.request ?? null;
    await handleQueueControlState(poll?.control, Boolean(req));
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
    const vrboFreshRetryLimit = isVrboOp
      ? Math.max(0, Math.floor(Number(process.env.SIDECAR_VRBO_HARD_BLOCK_FRESH_RETRIES ?? 2)))
      : 0;
    const maxAttempts = Math.max(1, REQUEST_MAX_ATTEMPTS, isVrboOp ? vrboFreshRetryLimit + 1 : REQUEST_MAX_ATTEMPTS);
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
        const currentVrboFreshAttempt = Math.max(0, Number(req.vrboFreshAttempt ?? 0));
        const vrboBlockFreshRetry =
          e instanceof VrboHardBlockError &&
          isVrboOp &&
          !providerTunnelProxyFailure &&
          attempt < maxAttempts &&
          currentVrboFreshAttempt < vrboFreshRetryLimit;
        const transientRetry = !providerTunnelProxyFailure && attempt < maxAttempts && isTransientScrapeError(e);
        const canRetry = transientRetry || vrboBlockFreshRetry;
        if (e instanceof VrboHardBlockError && isVrboOp) {
          lastError = new VrboHardBlockError(
            vrboBlockFreshRetry
              ? "VRBO CAPTCHA/block page detected; retrying with a fresh proxy session and browser fingerprint."
              : "VRBO CAPTCHA/block page detected; provider run stopped cleanly and retry is rate-limited until later. Original VRBO URL remains available in the search diagnostics/manual verification links.",
            {
              ...(e.details ?? {}),
              freshRetry: vrboBlockFreshRetry,
              vrboFreshAttempt: currentVrboFreshAttempt,
            },
          );
          if (vrboBlockFreshRetry) {
            req.vrboFreshAttempt = currentVrboFreshAttempt + 1;
            req.freshSessionReason = "vrbo_hard_block";
          }
        }
        log(
          `attempt ${attempt}/${maxAttempts} failed for ${req.id}: ${lastError?.message ?? e?.message ?? e}` +
          (vrboBlockFreshRetry ? " (fresh identity; will retry)" : transientRetry ? " (transient; will retry)" : ""),
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

function logSidecarStartupConfig() {
  if (WORKER_SLOT !== "1") return;
  const captchaOn =
    process.env.CAPTCHA_SOLVING_ENABLED === "1" && Boolean(String(process.env.CAPSOLVER_API_KEY ?? "").trim());
  const proxyOn = process.env.CHROME_PROXY_ENABLED !== "0";
  const proxyProvider = (process.env.CHROME_PROXY_PROVIDER ?? process.env.PROXY_PROVIDER ?? "none").toLowerCase();
  log(
    `config: server=${SERVER}; role=${WORKER_ROLE}; browserMode=${SIDECAR_BROWSER_MODE}; ` +
      `chromePrimary=${CHROME_PRIMARY}; slots=${process.env.MAX_LOCAL_CHROME_INSTANCES ?? "8"}; ` +
      `CapSolver=${captchaOn ? "on" : "off"}; proxy=${proxyOn ? `on (${proxyProvider})` : "off"}`,
  );
}

async function logProxyStartupPreflight() {
  if (WORKER_SLOT !== "1") return;
  const enabled = boolFromEnv("CHROME_PROXY_ENABLED", false);
  if (!enabled) {
    log("proxy preflight: skipped (CHROME_PROXY_ENABLED=0)");
    return;
  }

  const result = await runChromeProxyStartupPreflight({
    enabled: true,
    sessionId: {
      instance: { name: `worker-${WORKER_SLOT}` },
      request: { id: "startup-preflight", opType: "vrbo_search", requestAttempt: 0 },
    },
    brightDataUsernameOptions: (username) => appendBrightDataUsernameOptions(username),
    verifySessionRotation: true,
  });

  if (result.skipped) {
    log(`proxy preflight: ${result.reason}`);
    return;
  }
  if (!result.ok) {
    log(
      `proxy preflight FAILED [${result.phase}]: provider=${result.provider ?? "?"} ` +
        `${result.host ?? ""}:${result.port ?? ""} — ${result.error ?? result.statusLine ?? "unknown"}`,
    );
    return;
  }

  log(
    `proxy preflight OK: provider=${result.provider} ${result.host}:${result.port} ` +
      `egress=${result.ip} (${result.city ?? "?"}, ${result.region ?? "?"}, ${result.country ?? "?"}) ` +
      `isp=${result.isp ?? "?"} proxy_flag=${result.proxy} hosting=${result.hosting}`,
  );
  log(`proxy session username: ${result.usernameHint}`);

  const rotation = result.rotationCheck;
  if (rotation?.error) {
    log(`proxy rotation check skipped: ${rotation.error}`);
  } else if (rotation) {
    log(
      `proxy rotation check: session-a=${rotation.ipA} session-b=${rotation.ipB} ` +
        `distinct_ips=${rotation.distinctIps ? "yes" : "no (same IP; verify proxy sticky-session settings)"}`,
    );
  }
}

async function logServerChromePoolHealth() {
  if (!USE_SERVER_BROWSER || WORKER_SLOT !== "1") return;
  const host = process.env.SERVER_CHROME_HOST;
  if (!host) {
    log("warning: SERVER_CHROME_HOST is unset; server Chrome/noVNC pool cannot be used");
    return;
  }
  const scheme = process.env.SERVER_CHROME_SCHEME ?? "http";
  const port = Number(process.env.SERVER_CHROME_BASE_PORT ?? 9223);
  const cdpUrl = `${scheme}://${host}:${port}/json/version`;
  try {
    const r = await fetch(cdpUrl, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) {
      log(`warning: server Chrome CDP probe failed (${cdpUrl} → HTTP ${r.status})`);
    } else {
      log(`server Chrome pool reachable (${cdpUrl})`);
      return;
    }
  } catch (e) {
    log(`warning: server Chrome pool unreachable (${cdpUrl}): ${e?.message ?? e}`);
  }
  if (process.env.SIDECAR_DISABLE_LOCAL_CDP_FALLBACK !== "0") {
    log(
      "hint: reinstall sidecar with ./scripts/install-vrbo-sidecar-launchagent.sh (auto-enables local Chrome when server pool is down), " +
        "or start Docker server Chrome via ./scripts/start-server-sidecars.sh",
    );
  }
}

async function main() {
  log(`starting (server=${SERVER}, admin-secret=${ADMIN_SECRET ? "set" : "none"})`);
  log(`worker slot: ${WORKER_SLOT}; Chrome primary: ${CHROME_PRIMARY}; worker role: ${WORKER_ROLE}; browser mode: ${SIDECAR_BROWSER_MODE}`);
  logSidecarStartupConfig();
  await logProxyStartupPreflight();
  log(`Chrome binary: ${process.env.LOCAL_CHROME_BINARY ?? CHROME_BINARY}`);
  log(`Chrome user-data-dir: ${process.env.LOCAL_CHROME_USER_DATA_DIR ?? CHROME_DATA_DIR}`);
  if (USE_HEADLESS_LOCAL_BROWSER) {
    log("local macOS Chrome warmup skipped; using no-window local headless browser mode");
  } else if (USE_SERVER_BROWSER) {
    log("local macOS Chrome warmup skipped; preferring server Chrome/noVNC with residential proxy");
    await logServerChromePoolHealth();
  } else if (WORKER_SLOT === "1") {
    if (SIDECAR_WARM_LOCAL_CHROME_ON_STARTUP) {
      try {
        if (process.env.SIDECAR_WARM_ALL_LOCAL_CHROME === "1") {
          await chromeSidecarManager.warmAllLocal();
        } else {
          await chromeSidecarManager.warmPrimaryLocal();
        }
      } catch (e) {
        log(`local Chrome warmup skipped: ${e.message}`);
      }
    } else {
      log("local Chrome warmup skipped until a queued sidecar request is claimed");
    }
  } else {
    log("local Chrome warmup skipped on non-primary worker slot");
  }
  if (keepVisibleLocalChromeGrid() && SIDECAR_IDLE_CHROME_RESET_ENABLED) {
    await resetVisibleChromeToIdle("sidecar startup");
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
