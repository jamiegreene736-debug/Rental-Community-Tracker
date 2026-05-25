import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { boolFromEnv, nonEmptyEnv, resolveChromeProxyConfig, sanitizeProxyOption } from "./proxy-config.mjs";

const DEFAULT_VIEWPORT = { width: 1280, height: 820 };
const DEFAULT_LOCAL_CDP_PORT = 9222;
const DEFAULT_MAX_LOCAL_INSTANCES = 8;
const HARD_MAX_LOCAL_INSTANCES = 12;
const DEFAULT_SERVER_CDP_BASE_PORT = 9223;
const DEFAULT_SERVER_WEBDRIVER_BASE_PORT = 4445;
const DEFAULT_SERVER_NOVNC_BASE_PORT = 7901;
const DEFAULT_MAX_SERVER_INSTANCES = 4;
const DEFAULT_LOCK_TTL_MS = 45 * 60_000;
const REQUIRED_PROXY_COUNTRY = "us";
const DEFAULT_CHROME_BINARY =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome";
const SERVER_PROXY_DIRECT_FALLBACK = process.env.SERVER_CHROME_PROXY_DIRECT_FALLBACK !== "0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/g, "");
}

function numberFromEnv(name, defaultValue) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : defaultValue;
}

function replaceOrAppendProxyOption(value, option, optionValue) {
  const safeOptionValue = sanitizeProxyOption(optionValue);
  if (!safeOptionValue) return value;
  const pattern = new RegExp(`(^|-)${option}-[a-z0-9_]+(?=-|$)`, "i");
  if (pattern.test(value)) return value.replace(pattern, `$1${option}-${safeOptionValue}`);
  return `${value}-${option}-${safeOptionValue}`;
}

function parsePosition(value, fallback = { left: 120, top: 80 }) {
  const [leftRaw, topRaw] = String(value ?? "").split(",").map((part) => Number(part.trim()));
  if (!fallback && (!Number.isFinite(leftRaw) || !Number.isFinite(topRaw))) return null;
  return {
    left: Number.isFinite(leftRaw) ? Math.round(leftRaw) : fallback.left,
    top: Number.isFinite(topRaw) ? Math.round(topRaw) : fallback.top,
  };
}

function parseSize(value, fallback = DEFAULT_VIEWPORT) {
  const [widthRaw, heightRaw] = String(value ?? "").split(",").map((part) => Number(part.trim()));
  return {
    width: Number.isFinite(widthRaw) && widthRaw > 0 ? Math.round(widthRaw) : fallback.width,
    height: Number.isFinite(heightRaw) && heightRaw > 0 ? Math.round(heightRaw) : fallback.height,
  };
}

function formatPosition(pos) {
  return `${Math.round(pos.left)},${Math.round(pos.top)}`;
}

async function sendBrowserCdpCommand(cdpUrl, method, params = {}, timeoutMs = 3_000) {
  const versionResp = await fetch(`${trimTrailingSlash(cdpUrl)}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!versionResp.ok) throw new Error(`CDP version failed (${versionResp.status})`);
  const version = await versionResp.json();
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("CDP websocket URL missing");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1_000_000);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (data.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (data.error) {
        reject(new Error(`${method} failed: ${data.error.message ?? JSON.stringify(data.error)}`));
      } else {
        resolve(data.result ?? {});
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${method} websocket failed`));
    });
  });
}

async function getChromeWindowId(cdpUrl) {
  const targetsResp = await fetch(`${trimTrailingSlash(cdpUrl)}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!targetsResp.ok) throw new Error(`CDP targets failed (${targetsResp.status})`);
  const targets = await targetsResp.json();
  const target = Array.isArray(targets)
    ? targets.find((t) => t.type === "page") ?? targets[0]
    : null;
  if (!target?.id) throw new Error("CDP page target missing");
  const windowInfo = await sendBrowserCdpCommand(cdpUrl, "Browser.getWindowForTarget", { targetId: target.id });
  if (typeof windowInfo.windowId !== "number") throw new Error("CDP window id missing");
  return windowInfo.windowId;
}

async function enforceChromeWindowBounds(cdpUrl, position, size) {
  const windowId = await getChromeWindowId(cdpUrl);
  await sendBrowserCdpCommand(cdpUrl, "Browser.setWindowBounds", {
    windowId,
    bounds: {
      left: Math.round(position.left),
      top: Math.round(position.top),
      width: Math.round(size.width),
      height: Math.round(size.height),
      windowState: "normal",
    },
  });
}

async function hideChromeWindow(cdpUrl, position, size) {
  const windowId = await getChromeWindowId(cdpUrl);
  await sendBrowserCdpCommand(cdpUrl, "Browser.setWindowBounds", {
    windowId,
    bounds: {
      left: Math.round(position.left),
      top: Math.round(position.top),
      width: Math.round(size.width),
      height: Math.round(size.height),
    },
  });
  await sendBrowserCdpCommand(cdpUrl, "Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "minimized" },
  });
}

function parsePositionList(value) {
  return String(value ?? "")
    .split(/[;|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parsePosition(part, null))
    .filter((pos) => pos && Number.isFinite(pos.left) && Number.isFinite(pos.top));
}

function macAppPathFromChromeBinary(binary) {
  const marker = ".app/Contents/MacOS/";
  const idx = String(binary ?? "").indexOf(marker);
  return idx >= 0 ? String(binary).slice(0, idx + ".app".length) : "";
}

function jsonRead(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

function lockIsActive(file, ttlMs) {
  const data = jsonRead(file);
  if (!data?.startedAt) return false;
  const age = Date.now() - Number(data.startedAt);
  if (age > ttlMs) {
    safeUnlink(file);
    return false;
  }
  return true;
}

function writeLock(file, details) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ ...details, pid: process.pid, startedAt: Date.now() }, null, 2),
  );
}

function tryWriteLock(file, details, ttlMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (lockIsActive(file, ttlMs)) return false;
  const payload = JSON.stringify({ ...details, pid: process.pid, startedAt: Date.now() }, null, 2);
  try {
    fs.writeFileSync(file, payload, { flag: "wx" });
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    throw e;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function zipFilesBase64(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.content, "utf8");
    const checksum = crc32(data);
    const localHeader = Buffer.concat([
      writeUInt32LE(0x04034b50),
      writeUInt16LE(20),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt32LE(checksum),
      writeUInt32LE(data.length),
      writeUInt32LE(data.length),
      writeUInt16LE(name.length),
      writeUInt16LE(0),
      name,
    ]);
    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      writeUInt32LE(0x02014b50),
      writeUInt16LE(20),
      writeUInt16LE(20),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt32LE(checksum),
      writeUInt32LE(data.length),
      writeUInt32LE(data.length),
      writeUInt16LE(name.length),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt32LE(0),
      writeUInt32LE(offset),
      name,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.concat([
    writeUInt32LE(0x06054b50),
    writeUInt16LE(0),
    writeUInt16LE(0),
    writeUInt16LE(files.length),
    writeUInt16LE(files.length),
    writeUInt32LE(centralSize),
    writeUInt32LE(offset),
    writeUInt16LE(0),
  ]);

  return Buffer.concat([...localParts, ...centralParts, end]).toString("base64");
}

function proxySessionId(instance, request) {
  const base = [
    request?.id,
    request?.opType,
    request?.freshSessionReason,
    request?.requestAttempt ? `attempt${request.requestAttempt}` : "attempt0",
    request?.vrboFreshAttempt ? `fresh${request.vrboFreshAttempt}` : "",
    instance?.name,
    Date.now().toString(36),
  ]
    .filter(Boolean)
    .join("-");
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 48) || `sidecar${Date.now().toString(36)}`;
}

function appendBrightDataUsernameOptions(username, instance, request) {
  return replaceOrAppendProxyOption(
    replaceOrAppendProxyOption(username, "country", REQUIRED_PROXY_COUNTRY),
    "session",
    proxySessionId(instance, request),
  );
}

async function chromeProxyConfig(instance, request, { requireServer = false } = {}) {
  return resolveChromeProxyConfig({
    enabled: boolFromEnv("CHROME_PROXY_ENABLED", false),
    requireServer,
    isServer: Boolean(instance?.server),
    sessionId: { instance, request },
    brightDataUsernameOptions: (username) => appendBrightDataUsernameOptions(username, instance, request),
    incompleteConfigMessage:
      "CHROME_PROXY_ENABLED=1 but proxy config is incomplete. Set CHROME_PROXY_HOST, CHROME_PROXY_PORT, CHROME_PROXY_USERNAME, and CHROME_PROXY_PASSWORD, or set CHROME_PROXY_PROVIDER=gonzoproxy with GONZOPROXY_API_KEY, or CHROME_PROXY_PROVIDER=decodo with DECODO_PROXY_USERNAME/PASSWORD.",
  });
}

async function serverChromeProxyConfig(instance, request) {
  return chromeProxyConfig(instance, request, { requireServer: true });
}

function proxyAuthExtensionBase64(proxyConfig) {
  const manifest = {
    manifest_version: 3,
    name: "Vrbo Sidecar Proxy Auth",
    version: "1.0.0",
    permissions: ["webRequest", "webRequestAuthProvider"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "background.js" },
  };
  const background = `
const credentials = ${JSON.stringify({
  username: proxyConfig.username,
  password: proxyConfig.password,
})};

chrome.webRequest.onAuthRequired.addListener(
  (_details, callback) => callback({ authCredentials: credentials }),
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
`;
  return zipFilesBase64([
    { name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    { name: "background.js", content: background },
  ]);
}

function proxyHeaderEntries(headers, proxyAuthorization) {
  return Object.entries(headers)
    .filter(([name]) => !/^proxy-(authorization|connection)$/i.test(name))
    .flatMap(([name, value]) => {
      if (value == null) return [];
      if (Array.isArray(value)) return value.map((item) => `${name}: ${item}`);
      return [`${name}: ${value}`];
    })
    .concat(`Proxy-Authorization: ${proxyAuthorization}`, "Proxy-Connection: Keep-Alive");
}

function writeProxyError(socket, status = 502, statusText = "Proxy upstream failure") {
  try {
    socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

async function startLocalProxyAuthBridge(proxyConfig, log) {
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
      log(`local Chrome proxy bridge HTTP upstream failed: ${e?.message ?? e}`);
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

      log(`local Chrome proxy bridge upstream CONNECT failed: HTTP ${status || "unknown"} for ${req.url}`);
      writeProxyError(clientSocket, status || 502, status === 407 ? "Proxy Authentication Required" : "Proxy upstream failure");
      upstream.destroy();
    };

    upstream.on("data", onData);
    upstream.on("error", (e) => {
      log(`local Chrome proxy bridge CONNECT upstream failed: ${e?.message ?? e}`);
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
    serverUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function probeServerChromeProxyAuth(proxyConfig, target = "lumtest.com:443") {
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

async function isHttpReady(url, timeoutMs = 2_000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

async function openExternalUrl(url, log) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["/c", "start", "", url]
      : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref?.();
    return true;
  } catch (e) {
    log?.(`could not open live sidecar view automatically: ${e?.message ?? e}`);
    return false;
  }
}

function serverModeRequested() {
  return /^(server|remote|novnc|server-cdp)$/i.test(String(process.env.SIDECAR_BROWSER_MODE ?? ""));
}

function parseServerEndpointList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      // Format:
      //   name=http://host:9223|http://host:4445|http://host:7901
      // or:
      //   http://host:9223|http://host:4445|http://host:7901
      const [maybeName, maybeRest] = part.includes("=")
        ? part.split(/=(.*)/s).filter(Boolean)
        : [`chrome-server-${index + 1}`, part];
      const [cdpUrl, webdriverUrl, noVncUrl] = String(maybeRest ?? "")
        .split("|")
        .map((value) => trimTrailingSlash(value.trim()));
      return {
        name: maybeName || `chrome-server-${index + 1}`,
        server: true,
        cdpUrl,
        webdriverUrl,
        noVncUrl,
      };
    })
    .filter((endpoint) => endpoint.cdpUrl && endpoint.noVncUrl);
}

function discoverServerInstances() {
  const explicit = parseServerEndpointList(process.env.SERVER_CHROME_ENDPOINTS);
  if (explicit.length > 0) return explicit;

  const host = process.env.SERVER_CHROME_HOST;
  if (!host) return [];
  const max = Math.max(0, Math.floor(numberFromEnv("MAX_SERVER_INSTANCES", DEFAULT_MAX_SERVER_INSTANCES)));
  const baseCdp = numberFromEnv("SERVER_CHROME_BASE_PORT", DEFAULT_SERVER_CDP_BASE_PORT);
  const baseWebDriver = numberFromEnv("SERVER_CHROME_BASE_WEBDRIVER_PORT", DEFAULT_SERVER_WEBDRIVER_BASE_PORT);
  const baseNoVnc = numberFromEnv("SERVER_CHROME_BASE_NOVNC_PORT", DEFAULT_SERVER_NOVNC_BASE_PORT);
  const scheme = process.env.SERVER_CHROME_SCHEME ?? "http";

  return Array.from({ length: max }, (_, i) => ({
    name: `chrome-server-${i + 1}`,
    server: true,
    cdpUrl: `${scheme}://${host}:${baseCdp + i}`,
    webdriverUrl: `${scheme}://${host}:${baseWebDriver + i}`,
    noVncUrl: `${scheme}://${host}:${baseNoVnc + i}`,
  }));
}

function localChromeDataDirForIndex(baseDir, index) {
  if (index === 0) return baseDir;
  return `${baseDir}-${index + 1}`;
}

function localBusyLockForIndex(lockDir, explicitLock, index) {
  if (index === 0) return explicitLock ?? path.join(lockDir, "local-chrome.busy.json");
  return path.join(lockDir, `local-chrome-${index + 1}.busy.json`);
}

function shouldUseFreshProxiedLocalChrome(opType) {
  return /^(vrbo|booking|airbnb)_/i.test(String(opType || ""));
}

function freshLocalChromeDataDir(instance, request) {
  const safeId = proxySessionId(instance, request);
  return path.join(os.tmpdir(), `rct-sidecar-${instance.name}-${safeId}`);
}

export class ChromeSidecarManager {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.primary = String(process.env.CHROME_PRIMARY ?? "local").toLowerCase();
    this.serverFallbackEnabled = boolFromEnv("SERVER_CHROME_FALLBACK_ENABLED", false);
    this.serverFallbackForVrbo = boolFromEnv("SERVER_CHROME_FALLBACK_VRBO", false);
    this.localCdpFallbackEnabled = !(
      boolFromEnv("SIDECAR_DISABLE_LOCAL_CDP_FALLBACK", false) ||
      (serverModeRequested() && process.env.SIDECAR_DISABLE_LOCAL_CDP_FALLBACK !== "0")
    );
    this.maxLocalInstances = Math.min(
      HARD_MAX_LOCAL_INSTANCES,
      Math.max(1, Math.floor(numberFromEnv("MAX_LOCAL_CHROME_INSTANCES", DEFAULT_MAX_LOCAL_INSTANCES))),
    );
    this.localCdpPort = numberFromEnv("LOCAL_CHROME_PORT", DEFAULT_LOCAL_CDP_PORT);
    this.localCdpUrl = trimTrailingSlash(process.env.LOCAL_CHROME_CDP_URL ?? "");
    this.localWebDriverUrl = trimTrailingSlash(process.env.LOCAL_CHROME_WEBDRIVER_URL ?? "");
    this.localNoVncUrl = trimTrailingSlash(process.env.LOCAL_CHROME_NOVNC_URL ?? "");
    this.localChromeBinary = process.env.LOCAL_CHROME_BINARY ?? DEFAULT_CHROME_BINARY;
    this.localChromeDataDir =
      process.env.LOCAL_CHROME_USER_DATA_DIR ??
      path.join(os.homedir(), "Library/Application Support/VrboSidecar-Chrome");
    this.localVisible = boolFromEnv("SIDECAR_CHROME_VISIBLE", false);
    this.macosBackgroundLaunch = boolFromEnv("SIDECAR_MACOS_BACKGROUND_LAUNCH", true);
    this.hiddenWindowPosition = process.env.SIDECAR_CHROME_HIDDEN_POSITION ?? "-32000,-32000";
    this.visibleWindowPosition = process.env.SIDECAR_CHROME_VISIBLE_POSITION ?? "120,80";
    this.visibleWindowSize = parseSize(
      process.env.SIDECAR_CHROME_VISIBLE_SIZE,
      { width: this.viewport.width, height: this.viewport.height + 80 },
    );
    this.visibleWindowPositions = parsePositionList(process.env.SIDECAR_CHROME_VISIBLE_POSITIONS ?? "");
    this.visibleGridOrigin = parsePosition(
      process.env.SIDECAR_CHROME_VISIBLE_GRID_ORIGIN ?? this.visibleWindowPosition,
      { left: 120, top: 80 },
    );
    this.visibleGridColumns = Math.max(1, Math.floor(numberFromEnv("SIDECAR_CHROME_VISIBLE_GRID_COLUMNS", 2)));
    this.visibleGridGapX = Math.max(0, Math.floor(numberFromEnv("SIDECAR_CHROME_VISIBLE_GRID_GAP_X", 24)));
    this.visibleGridGapY = Math.max(0, Math.floor(numberFromEnv("SIDECAR_CHROME_VISIBLE_GRID_GAP_Y", 36)));
    this.lockDir =
      process.env.SIDECAR_LOCK_DIR ??
      path.join(os.homedir(), ".vrbo-sidecar", "locks");
    this.localBusyLock =
      process.env.SIDECAR_LOCAL_BUSY_LOCK ??
      path.join(this.lockDir, "local-chrome.busy.json");
    this.lockTtlMs = numberFromEnv("SIDECAR_LOCK_TTL_MS", DEFAULT_LOCK_TTL_MS);
    this.localInstances = Array.from({ length: this.maxLocalInstances }, (_, index) => {
      const port = this.localCdpPort + index;
      return {
        name: `local-chrome-${index + 1}`,
        label: `local Chrome sidecar #${index + 1}`,
        server: false,
        index,
        cdpPort: port,
        cdpUrl: index === 0 && this.localCdpUrl ? this.localCdpUrl : `http://127.0.0.1:${port}`,
        webdriverUrl: index === 0 ? this.localWebDriverUrl : "",
        noVncUrl: index === 0 ? this.localNoVncUrl : "",
        chromeDataDir: localChromeDataDirForIndex(this.localChromeDataDir, index),
        busyLock: localBusyLockForIndex(
          this.lockDir,
          process.env.SIDECAR_LOCAL_BUSY_LOCK ? this.localBusyLock : null,
          index,
        ),
      };
    });
  }

  async warmPrimaryLocal() {
    if (this.primary !== "local") return false;
    const first = this.localInstances[0];
    if (!first) return false;
    if (!(await this.isCdpReady(first.cdpUrl))) {
      await this.launchLocalChrome(first);
      const ready = await this.waitForCdp(first.cdpUrl, 20_000);
      if (!ready) return false;
    }
    await this.enforceLocalWindowMode(first);
    return true;
  }

  async warmAllLocal() {
    if (this.primary !== "local") return false;
    let readyCount = 0;
    for (const instance of this.localInstances) {
      if (!(await this.isCdpReady(instance.cdpUrl))) {
        await this.launchLocalChrome(instance);
        await this.waitForCdp(instance.cdpUrl, 20_000);
      }
      if (await this.isCdpReady(instance.cdpUrl)) {
        await this.enforceLocalWindowMode(instance);
        readyCount += 1;
      }
    }
    return readyCount === this.localInstances.length;
  }

  async acquire(request = {}) {
    if (this.primary === "local") {
      const local = await this.tryAcquireLocal(request);
      if (local) return local;
    }

    const opType = String(request?.opType ?? "");
    const vrboLocalOnly = /^vrbo_/i.test(opType) && !this.serverFallbackForVrbo;
    if (this.serverFallbackEnabled && !vrboLocalOnly) {
      const server = await this.tryAcquireServer(request);
      if (server) return server;
    } else if (this.serverFallbackEnabled && vrboLocalOnly) {
      this.log(`${opType || "vrbo"} kept local-only; SERVER_CHROME_FALLBACK_VRBO=1 required for server fallback`);
    }

    if (this.primary !== "local" && this.localCdpFallbackEnabled) {
      const local = await this.tryAcquireLocal(request);
      if (local) return local;
    } else if (this.primary !== "local") {
      this.log("local macOS Chrome fallback disabled; not launching desktop Chrome from server mode");
    }

    throw new Error(
      this.primary === "local"
        ? `All ${this.maxLocalInstances} local Chrome sidecars are busy. Wait for one to finish, or raise MAX_LOCAL_CHROME_INSTANCES up to ${HARD_MAX_LOCAL_INSTANCES}.`
        : "No server Chrome/noVNC sidecar is available, and local macOS Chrome fallback is disabled.",
    );
  }

  async tryAcquireLocal(request = {}) {
    for (const instance of this.localInstances) {
      const allocation = await this.tryAcquireLocalInstance(instance, request);
      if (allocation) return allocation;
    }
    this.log(`all ${this.localInstances.length} local Chrome sidecars are busy`);
    return null;
  }

  async tryAcquireLocalInstance(instance, request = {}) {
    const opType = String(request?.opType ?? "");
    const wantsFreshProxiedChrome = shouldUseFreshProxiedLocalChrome(opType);
    const chromeInstance = wantsFreshProxiedChrome
      ? { ...instance, chromeDataDir: freshLocalChromeDataDir(instance, request) }
      : instance;
    let proxyConfig = wantsFreshProxiedChrome ? await chromeProxyConfig(chromeInstance, request) : null;
    const locked = tryWriteLock(instance.busyLock, {
      type: "local",
      requestId: request.id ?? null,
      opType: request.opType ?? null,
      cdpUrl: instance.cdpUrl,
      instance: instance.name,
      proxy: proxyConfig
        ? { provider: proxyConfig.provider, host: proxyConfig.host, port: proxyConfig.port }
        : null,
    }, this.lockTtlMs);
    if (!locked) return null;

    let webdriverSessionId = null;
    let sessionBaseUrl = null;
    let localProxyBridge = null;

    if (proxyConfig) {
      const probe = await probeServerChromeProxyAuth(proxyConfig);
      if (!probe.ok) {
        const probeStatus = probe.statusLine || `HTTP ${probe.status || "unknown"}`;
        safeUnlink(instance.busyLock);
        this.log(`${instance.label} proxy auth probe failed (${probeStatus}); skipping local Chrome fallback for ${opType}`);
        return null;
      }

      if (await this.isCdpReady(instance.cdpUrl)) {
        this.log(`${instance.label} relaunching with ${proxyConfig.provider} proxy for ${opType}`);
        await sendBrowserCdpCommand(instance.cdpUrl, "Browser.close", {}, 2_000).catch(() => {});
        const closeStartedAt = Date.now();
        while (Date.now() - closeStartedAt < 5_000 && (await this.isCdpReady(instance.cdpUrl))) {
          await sleep(250);
        }
        if (await this.isCdpReady(instance.cdpUrl)) {
          safeUnlink(instance.busyLock);
          this.log(`${instance.label} could not relaunch with proxy because existing Chrome stayed open`);
          return null;
        }
      }

      try {
        localProxyBridge = await startLocalProxyAuthBridge(proxyConfig, this.log);
      } catch (e) {
        safeUnlink(instance.busyLock);
        this.log(`${instance.label} local proxy auth bridge failed: ${e?.message ?? e}`);
        return null;
      }
    }

    if (!(await this.isCdpReady(instance.cdpUrl)) && instance.webdriverUrl) {
      try {
        const session = await this.createSeleniumSession({
          name: instance.label,
          server: false,
          webdriverUrl: instance.webdriverUrl,
        });
        webdriverSessionId = session.sessionId;
        sessionBaseUrl = session.baseUrl;
        await this.waitForCdp(instance.cdpUrl, 15_000);
      } catch (e) {
        this.log(`${instance.label} Selenium session failed: ${e?.message ?? e}`);
      }
    }

    if (!(await this.isCdpReady(instance.cdpUrl))) {
      try {
        await this.launchLocalChrome(chromeInstance, proxyConfig, request, localProxyBridge);
      } catch (e) {
        await localProxyBridge?.close().catch(() => {});
        if (wantsFreshProxiedChrome) fs.rmSync(chromeInstance.chromeDataDir, { recursive: true, force: true });
        if (webdriverSessionId && sessionBaseUrl) {
          await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
        }
        safeUnlink(instance.busyLock);
        this.log(`${instance.label} launch failed: ${e?.message ?? e}`);
        return null;
      }
      const ready = await this.waitForCdp(instance.cdpUrl, 20_000);
      if (!ready) {
        await localProxyBridge?.close().catch(() => {});
        if (wantsFreshProxiedChrome) fs.rmSync(chromeInstance.chromeDataDir, { recursive: true, force: true });
        if (webdriverSessionId && sessionBaseUrl) {
          await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
        }
        safeUnlink(instance.busyLock);
        this.log(`${instance.label} CDP did not become ready`);
        return null;
      }
    }

    if (await this.isCdpReady(instance.cdpUrl)) {
      await this.enforceLocalWindowMode(instance);
    }

    const heartbeat = setInterval(() => {
      writeLock(instance.busyLock, {
        type: "local",
        requestId: request.id ?? null,
        opType: request.opType ?? null,
        cdpUrl: instance.cdpUrl,
        instance: instance.name,
        proxy: proxyConfig
          ? { provider: proxyConfig.provider, host: proxyConfig.host, port: proxyConfig.port }
          : null,
      });
    }, 15_000);
    heartbeat.unref?.();

    return {
      type: "local",
      label: instance.label,
      cdpUrl: instance.cdpUrl,
      noVncUrl: instance.noVncUrl || null,
      proxyConfig,
      ephemeral: Boolean(webdriverSessionId),
      release: async () => {
        clearInterval(heartbeat);
        safeUnlink(instance.busyLock);
        if (localProxyBridge) {
          await sendBrowserCdpCommand(instance.cdpUrl, "Browser.close", {}, 2_000).catch(() => {});
        }
        await localProxyBridge?.close().catch(() => {});
        if (wantsFreshProxiedChrome) fs.rmSync(chromeInstance.chromeDataDir, { recursive: true, force: true });
        if (webdriverSessionId && sessionBaseUrl) {
          await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
        }
      },
    };
  }

  async tryAcquireServer(request = {}) {
    const instances = discoverServerInstances();
    if (instances.length === 0) return null;

    console.log(
      this.primary === "server"
        ? "Using server Chrome/noVNC sidecar processing..."
        : "Local Chrome sidecar is currently in use, utilizing server processing...",
    );

    for (const instance of instances) {
      const allocation = await this.tryAcquireServerInstance(instance, request);
      if (!allocation) continue;

      console.log(`Opened live view for this job: ${allocation.noVncUrl}`);
      console.log("Watch the search happening in real time.");
      if (boolFromEnv("SIDECAR_OPEN_NOVNC_ON_ACQUIRE", false)) {
        await openExternalUrl(allocation.noVncUrl, this.log);
      }
      return allocation;
    }

    return null;
  }

  async tryAcquireServerInstance(instance, request = {}) {
    const lockFile = path.join(this.lockDir, `${instance.name}.busy.json`);
    if (lockIsActive(lockFile, this.lockTtlMs)) return null;
    const opType = String(request?.opType ?? "");

    let webdriverSessionId = null;
    let sessionBaseUrl = null;
    try {
      let proxyConfig = await serverChromeProxyConfig(instance, request);
      if (proxyConfig && !instance.webdriverUrl) {
        throw new Error(`${instance.name} has no WebDriver URL; cannot enforce server Chrome proxy`);
      }
      if (proxyConfig) {
        const probe = await probeServerChromeProxyAuth(proxyConfig);
        if (!probe.ok) {
          const probeStatus = probe.statusLine || `HTTP ${probe.status || "unknown"}`;
          const directFallbackAllowed = SERVER_PROXY_DIRECT_FALLBACK && !shouldUseFreshProxiedLocalChrome(opType);
          const message =
            `server Chrome proxy auth probe failed (${probeStatus}); ` +
            (directFallbackAllowed ? "launching without proxy" : "direct fallback disabled");
          this.log(message);
          if (!directFallbackAllowed) throw new Error(message);
          proxyConfig = null;
        }
      }

      let cdpReady = await this.isCdpReady(instance.cdpUrl);
      if (proxyConfig && instance.webdriverUrl) {
        await this.deleteSeleniumSessions(instance).catch((e) => {
          this.log(`could not clear existing ${instance.name} session before proxy launch: ${e?.message ?? e}`);
        });
        cdpReady = false;
      }

      if (!cdpReady && instance.webdriverUrl) {
        const session = await this.createSeleniumSession(instance, request, proxyConfig);
        webdriverSessionId = session.sessionId;
        sessionBaseUrl = session.baseUrl;
        const becameReady = await this.waitForCdp(instance.cdpUrl, 15_000);
        if (!becameReady) {
          this.log(`${instance.name} WebDriver session started, but CDP never became reachable at ${instance.cdpUrl}`);
        }
      }

      if (!(await this.isCdpReady(instance.cdpUrl))) {
        if (webdriverSessionId && sessionBaseUrl) {
          await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
        }
        return null;
      }

      writeLock(lockFile, {
        type: "server",
        requestId: request.id ?? null,
        opType: request.opType ?? null,
        cdpUrl: instance.cdpUrl,
        noVncUrl: instance.noVncUrl,
        proxy: proxyConfig
          ? { provider: proxyConfig.provider, host: proxyConfig.host, port: proxyConfig.port }
          : null,
      });
      const heartbeat = setInterval(() => {
        writeLock(lockFile, {
          type: "server",
          requestId: request.id ?? null,
          opType: request.opType ?? null,
          cdpUrl: instance.cdpUrl,
          noVncUrl: instance.noVncUrl,
          proxy: proxyConfig
            ? { provider: proxyConfig.provider, host: proxyConfig.host, port: proxyConfig.port }
            : null,
        });
      }, 15_000);
      heartbeat.unref?.();

      return {
        type: "server",
        label: instance.name,
        cdpUrl: instance.cdpUrl,
        noVncUrl: instance.noVncUrl,
        webdriverSessionId,
        proxyConfig,
        ephemeral: true,
        release: async () => {
          clearInterval(heartbeat);
          safeUnlink(lockFile);
          if (webdriverSessionId && sessionBaseUrl) {
            await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
          }
        },
      };
    } catch (e) {
      safeUnlink(lockFile);
      if (webdriverSessionId && sessionBaseUrl) {
        await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
      }
      this.log(`server Chrome instance ${instance.name} unavailable: ${e?.message ?? e}`);
      return null;
    }
  }

  async deleteSeleniumSessions(instance) {
    if (!instance.webdriverUrl) return;
    const baseUrl = trimTrailingSlash(instance.webdriverUrl);
    const r = await fetch(`${baseUrl}/sessions`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return;
    const data = await r.json();
    const sessions = Array.isArray(data.value) ? data.value : Array.isArray(data) ? data : [];
    await Promise.all(sessions.map((session) => {
      const id = session.id ?? session.sessionId;
      return id ? fetch(`${baseUrl}/session/${id}`, { method: "DELETE" }).catch(() => {}) : null;
    }));
  }

  async createSeleniumSession(instance, request = {}, proxyConfig = null) {
    const baseUrl = trimTrailingSlash(instance.webdriverUrl);
    const endpointCandidates = [
      `${baseUrl}/session`,
      ...(baseUrl.endsWith("/wd/hub") ? [] : [`${baseUrl}/wd/hub/session`]),
    ];
    const profileSessionId = proxySessionId(instance, request);
    const chromeArgs = [
      "--remote-debugging-address=0.0.0.0",
      "--remote-debugging-port=9222",
      ...(process.platform === "darwin" ? [] : ["--no-sandbox", "--disable-setuid-sandbox"]),
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--window-size=${this.viewport.width},${this.viewport.height + 80}`,
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-features=OptimizationHints,AutofillServerCommunication,MediaRouter,Translate,InterestFeedContentSuggestions",
      "--disable-blink-features=AutomationControlled",
      `--user-data-dir=/tmp/rct-sidecar-chrome-${profileSessionId}`,
      "--disk-cache-size=1",
      "--media-cache-size=1",
    ];
    const chromeOptions = { args: chromeArgs };

    if (proxyConfig) {
      chromeArgs.push(
        `--proxy-server=${proxyConfig.scheme}://${proxyConfig.host}:${proxyConfig.port}`,
        "--proxy-bypass-list=localhost;127.0.0.1;::1",
      );
      chromeOptions.extensions = [proxyAuthExtensionBase64(proxyConfig)];
      this.log(
        `launching ${instance.name} with ${proxyConfig.provider} proxy ${proxyConfig.host}:${proxyConfig.port}` +
          (request?.vrboFreshAttempt ? ` (fresh VRBO retry #${request.vrboFreshAttempt})` : ""),
      );
    }

    const body = {
      capabilities: {
        alwaysMatch: {
          browserName: "chrome",
          "goog:chromeOptions": chromeOptions,
        },
      },
    };
    let r = null;
    let text = "";
    let endpoint = endpointCandidates[0];
    for (const candidate of endpointCandidates) {
      endpoint = candidate;
      r = await fetch(candidate, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
      text = await r.text();
      if (r.ok) break;
      const looksLikeSelenium3HelpPage = r.status === 404 && /displayhelpservlet|selenium/i.test(text);
      if (!looksLikeSelenium3HelpPage) break;
    }
    if (!r?.ok) {
      throw new Error(`Selenium session failed at ${endpoint} (${r?.status ?? "unknown"}): ${text.slice(0, 240)}`);
    }
    const data = JSON.parse(text);
    const value = data.value ?? data;
    const sessionId = value.sessionId ?? data.sessionId;
    if (!sessionId) throw new Error("Selenium did not return a sessionId");
    return { sessionId, baseUrl };
  }

  async launchLocalChrome(instance = this.localInstances[0], proxyConfig = null, request = {}, localProxyBridge = null) {
    if (!fs.existsSync(this.localChromeBinary)) {
      throw new Error(`Google Chrome not found at ${this.localChromeBinary}`);
    }
    fs.mkdirSync(instance.chromeDataDir, { recursive: true });
    const visiblePosition = this.visiblePositionForInstance(instance);
    const windowSize = this.localVisible
      ? this.visibleWindowSize
      : { width: this.viewport.width, height: this.viewport.height + 80 };
    const chromeArgs = [
      `--remote-debugging-port=${instance.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${instance.chromeDataDir}`,
      `--window-size=${windowSize.width},${windowSize.height}`,
      `--window-position=${this.localVisible ? visiblePosition : this.hiddenWindowPosition}`,
      "--force-device-scale-factor=1",
      ...(this.localVisible ? [] : ["--start-minimized", "--no-startup-window"]),
      "--disable-notifications",
      "--disable-backgrounding-occluded-windows",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-features=OptimizationHints,AutofillServerCommunication,MediaRouter,Translate,InterestFeedContentSuggestions",
      "--disable-blink-features=AutomationControlled",
      ...(process.platform === "darwin" ? [] : ["--no-sandbox", "--disable-setuid-sandbox"]),
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "about:blank",
    ];
    if (proxyConfig) {
      chromeArgs.splice(
        chromeArgs.length - 1,
        0,
        `--proxy-server=${localProxyBridge?.serverUrl || `${proxyConfig.scheme}://${proxyConfig.host}:${proxyConfig.port}`}`,
        "--proxy-bypass-list=localhost;127.0.0.1;::1",
        "--ignore-certificate-errors",
      );
      this.log(
        `launching ${instance.label} with ${proxyConfig.provider} proxy ${proxyConfig.host}:${proxyConfig.port}` +
          (request?.vrboFreshAttempt ? ` (fresh VRBO retry #${request.vrboFreshAttempt})` : ""),
      );
    }
    const launchViaMacOpen = process.platform === "darwin" && this.macosBackgroundLaunch;
    const launchHiddenOnMac = launchViaMacOpen && !this.localVisible;
    const macAppPath = launchViaMacOpen
      ? macAppPathFromChromeBinary(this.localChromeBinary)
      : "";
    const command = macAppPath ? "open" : this.localChromeBinary;
    const args = macAppPath
      ? ["-g", ...(this.localVisible ? [] : ["-j"]), "-n", macAppPath, "--args", ...chromeArgs]
      : chromeArgs;
    this.log(
      `spawning ${instance.label} ${
        launchHiddenOnMac ? (macAppPath ? "macOS background hidden/offscreen " : "direct hidden/offscreen ") : ""
      }(port ${instance.cdpPort}, user-data-dir ${instance.chromeDataDir}, window ${visiblePosition} ${windowSize.width}x${windowSize.height})…`,
    );
    const proc = spawn(command, args, { detached: true, stdio: "ignore" });
    proc.unref?.();
  }

  async enforceVisibleBounds(instance) {
    if (!this.localVisible) return;
    const position = this.visiblePositionObjectForInstance(instance);
    await enforceChromeWindowBounds(instance.cdpUrl, position, this.visibleWindowSize)
      .then(() => this.log(`${instance.label} visible bounds enforced at ${formatPosition(position)} ${this.visibleWindowSize.width}x${this.visibleWindowSize.height}`))
      .catch((e) => this.log(`${instance.label} visible bounds enforcement skipped: ${e?.message ?? e}`));
  }

  async enforceHiddenBounds(instance) {
    const position = parsePosition(this.hiddenWindowPosition, { left: -32000, top: -32000 });
    const size = { width: this.viewport.width, height: this.viewport.height + 80 };
    await hideChromeWindow(instance.cdpUrl, position, size)
      .then(() => this.log(`${instance.label} hidden bounds enforced at ${formatPosition(position)} ${size.width}x${size.height}`))
      .catch((e) => this.log(`${instance.label} hidden bounds enforcement skipped: ${e?.message ?? e}`));
  }

  async enforceLocalWindowMode(instance) {
    if (this.localVisible) {
      await this.enforceVisibleBounds(instance);
      return;
    }
    await this.enforceHiddenBounds(instance);
  }

  visiblePositionForInstance(instance) {
    if (!this.localVisible) return this.hiddenWindowPosition;
    return formatPosition(this.visiblePositionObjectForInstance(instance));
  }

  visiblePositionObjectForInstance(instance) {
    if (!this.localVisible) return parsePosition(this.hiddenWindowPosition, { left: -32000, top: -32000 });
    const explicit = this.visibleWindowPositions[instance.index];
    if (explicit) return explicit;
    const col = instance.index % this.visibleGridColumns;
    const row = Math.floor(instance.index / this.visibleGridColumns);
    const left = this.visibleGridOrigin.left + col * (this.visibleWindowSize.width + this.visibleGridGapX);
    const top = this.visibleGridOrigin.top + row * (this.visibleWindowSize.height + this.visibleGridGapY);
    return { left, top };
  }

  async isCdpReady(cdpUrl) {
    return isHttpReady(`${trimTrailingSlash(cdpUrl)}/json/version`);
  }

  async waitForCdp(cdpUrl, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isCdpReady(cdpUrl)) return true;
      await sleep(500);
    }
    return false;
  }
}
