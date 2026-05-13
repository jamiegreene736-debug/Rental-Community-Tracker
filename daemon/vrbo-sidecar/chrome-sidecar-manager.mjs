import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const DEFAULT_VIEWPORT = { width: 1280, height: 820 };
const DEFAULT_LOCAL_CDP_PORT = 9222;
const DEFAULT_MAX_LOCAL_INSTANCES = 8;
const HARD_MAX_LOCAL_INSTANCES = 12;
const DEFAULT_SERVER_CDP_BASE_PORT = 9223;
const DEFAULT_SERVER_WEBDRIVER_BASE_PORT = 4445;
const DEFAULT_SERVER_NOVNC_BASE_PORT = 7901;
const DEFAULT_MAX_SERVER_INSTANCES = 4;
const DEFAULT_LOCK_TTL_MS = 45 * 60_000;
const DEFAULT_BRIGHTDATA_HOST = "brd.superproxy.io";
const DEFAULT_BRIGHTDATA_PORT = 33335;
const DEFAULT_CHROME_BINARY =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/g, "");
}

function boolFromEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function numberFromEnv(name, defaultValue) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : defaultValue;
}

function nonEmptyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
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

function sanitizeProxyOption(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 64);
}

function proxySessionId(instance, request) {
  const base = [
    request?.id,
    request?.opType,
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
  let next = username;
  const country = sanitizeProxyOption(nonEmptyEnv("CHROME_PROXY_COUNTRY", "BRIGHTDATA_PROXY_COUNTRY"));
  if (country && !/-country-[a-z0-9_]+(?:-|$)/i.test(next)) {
    next += `-country-${country}`;
  }
  if (!/-session-[a-z0-9_]+(?:-|$)/i.test(next)) {
    next += `-session-${proxySessionId(instance, request)}`;
  }
  return next;
}

function serverChromeProxyConfig(instance, request) {
  if (!boolFromEnv("CHROME_PROXY_ENABLED", false)) return null;
  if (!instance?.server) return null;

  const provider = nonEmptyEnv("CHROME_PROXY_PROVIDER", "PROXY_PROVIDER").toLowerCase();
  const scheme = nonEmptyEnv("CHROME_PROXY_SCHEME", "PROXY_SCHEME") || "http";
  const isBrightData = !provider || provider === "brightdata";
  const host = nonEmptyEnv("BRIGHTDATA_PROXY_HOST", "CHROME_PROXY_HOST", "PROXY_HOST") ||
    (isBrightData ? DEFAULT_BRIGHTDATA_HOST : "");
  const port = Number(nonEmptyEnv("BRIGHTDATA_PROXY_PORT", "CHROME_PROXY_PORT", "PROXY_PORT") ||
    (isBrightData ? DEFAULT_BRIGHTDATA_PORT : ""));
  let username = nonEmptyEnv("BRIGHTDATA_PROXY_USERNAME", "CHROME_PROXY_USERNAME", "PROXY_USERNAME");
  const password = nonEmptyEnv("BRIGHTDATA_PROXY_PASSWORD", "CHROME_PROXY_PASSWORD", "PROXY_PASSWORD");

  if (!host || !Number.isFinite(port) || !username || !password) {
    throw new Error(
      "CHROME_PROXY_ENABLED=1 but Bright Data proxy config is incomplete. Set BRIGHTDATA_PROXY_HOST, BRIGHTDATA_PROXY_PORT, BRIGHTDATA_PROXY_USERNAME, and BRIGHTDATA_PROXY_PASSWORD.",
    );
  }

  if (isBrightData) username = appendBrightDataUsernameOptions(username, instance, request);
  return { provider: provider || "brightdata", scheme, host, port, username, password };
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

export class ChromeSidecarManager {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.primary = String(process.env.CHROME_PRIMARY ?? "local").toLowerCase();
    this.serverFallbackEnabled = boolFromEnv("SERVER_CHROME_FALLBACK_ENABLED", false);
    this.serverFallbackForVrbo = boolFromEnv("SERVER_CHROME_FALLBACK_VRBO", false);
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
    if (await this.isCdpReady(first.cdpUrl)) return true;
    await this.launchLocalChrome(first);
    return this.waitForCdp(first.cdpUrl, 20_000);
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

    if (this.primary !== "local") {
      const local = await this.tryAcquireLocal(request);
      if (local) return local;
    }

    throw new Error(
      `All ${this.maxLocalInstances} local Chrome sidecars are busy. Wait for one to finish, or raise MAX_LOCAL_CHROME_INSTANCES up to ${HARD_MAX_LOCAL_INSTANCES}.`,
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
    const locked = tryWriteLock(instance.busyLock, {
      type: "local",
      requestId: request.id ?? null,
      opType: request.opType ?? null,
      cdpUrl: instance.cdpUrl,
      instance: instance.name,
    }, this.lockTtlMs);
    if (!locked) return null;

    let webdriverSessionId = null;
    let sessionBaseUrl = null;

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
        await this.launchLocalChrome(instance);
      } catch (e) {
        if (webdriverSessionId && sessionBaseUrl) {
          await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
        }
        safeUnlink(instance.busyLock);
        this.log(`${instance.label} launch failed: ${e?.message ?? e}`);
        return null;
      }
      const ready = await this.waitForCdp(instance.cdpUrl, 20_000);
      if (!ready) {
        if (webdriverSessionId && sessionBaseUrl) {
          await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
        }
        safeUnlink(instance.busyLock);
        this.log(`${instance.label} CDP did not become ready`);
        return null;
      }
    }

    const heartbeat = setInterval(() => {
      writeLock(instance.busyLock, {
        type: "local",
        requestId: request.id ?? null,
        opType: request.opType ?? null,
        cdpUrl: instance.cdpUrl,
        instance: instance.name,
      });
    }, 15_000);
    heartbeat.unref?.();

    return {
      type: "local",
      label: instance.label,
      cdpUrl: instance.cdpUrl,
      noVncUrl: instance.noVncUrl || null,
      ephemeral: Boolean(webdriverSessionId),
      release: async () => {
        clearInterval(heartbeat);
        safeUnlink(instance.busyLock);
        if (webdriverSessionId && sessionBaseUrl) {
          await fetch(`${sessionBaseUrl}/session/${webdriverSessionId}`, { method: "DELETE" }).catch(() => {});
        }
      },
    };
  }

  async tryAcquireServer(request = {}) {
    const instances = discoverServerInstances();
    if (instances.length === 0) return null;

    // Required exact fallback message.
    console.log("Local Chrome sidecar is currently in use, utilizing server processing...");

    for (const instance of instances) {
      const allocation = await this.tryAcquireServerInstance(instance, request);
      if (!allocation) continue;

      console.log(`Opened live view for this job: ${allocation.noVncUrl}`);
      console.log("Watch the search happening in real time.");
      await openExternalUrl(allocation.noVncUrl, this.log);
      return allocation;
    }

    return null;
  }

  async tryAcquireServerInstance(instance, request = {}) {
    const lockFile = path.join(this.lockDir, `${instance.name}.busy.json`);
    if (lockIsActive(lockFile, this.lockTtlMs)) return null;

    let webdriverSessionId = null;
    let sessionBaseUrl = null;
    try {
      const proxyConfig = serverChromeProxyConfig(instance, request);
      if (proxyConfig && !instance.webdriverUrl) {
        throw new Error(`${instance.name} has no WebDriver URL; cannot enforce server Chrome proxy`);
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
        await this.waitForCdp(instance.cdpUrl, 15_000);
      }

      if (!(await this.isCdpReady(instance.cdpUrl))) return null;

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
    const endpoint = `${baseUrl}/session`;
    const chromeArgs = [
      "--remote-debugging-address=0.0.0.0",
      "--remote-debugging-port=9222",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--window-size=${this.viewport.width},${this.viewport.height + 80}`,
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    const chromeOptions = { args: chromeArgs };

    if (proxyConfig) {
      chromeArgs.push(
        `--proxy-server=${proxyConfig.scheme}://${proxyConfig.host}:${proxyConfig.port}`,
        "--proxy-bypass-list=localhost;127.0.0.1;::1",
      );
      chromeOptions.extensions = [proxyAuthExtensionBase64(proxyConfig)];
      this.log(
        `launching ${instance.name} with ${proxyConfig.provider} proxy ${proxyConfig.host}:${proxyConfig.port}`,
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
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`Selenium session failed (${r.status}): ${text.slice(0, 240)}`);
    }
    const data = JSON.parse(text);
    const value = data.value ?? data;
    const sessionId = value.sessionId ?? data.sessionId;
    if (!sessionId) throw new Error("Selenium did not return a sessionId");
    return { sessionId, baseUrl };
  }

  async launchLocalChrome(instance = this.localInstances[0]) {
    if (!fs.existsSync(this.localChromeBinary)) {
      throw new Error(`Google Chrome not found at ${this.localChromeBinary}`);
    }
    fs.mkdirSync(instance.chromeDataDir, { recursive: true });
    const chromeArgs = [
      `--remote-debugging-port=${instance.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${instance.chromeDataDir}`,
      `--window-size=${this.viewport.width},${this.viewport.height + 80}`,
      `--window-position=${this.localVisible ? "120,80" : this.hiddenWindowPosition}`,
      "--force-device-scale-factor=1",
      ...(this.localVisible ? [] : ["--start-minimized", "--no-startup-window"]),
      "--disable-notifications",
      "--disable-backgrounding-occluded-windows",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "about:blank",
    ];
    const launchHiddenOnMac = process.platform === "darwin" && !this.localVisible;
    const macAppPath = launchHiddenOnMac && this.macosBackgroundLaunch
      ? macAppPathFromChromeBinary(this.localChromeBinary)
      : "";
    const command = macAppPath ? "open" : this.localChromeBinary;
    const args = macAppPath
      ? ["-g", "-j", "-n", macAppPath, "--args", ...chromeArgs]
      : chromeArgs;
    this.log(
      `spawning ${instance.label} ${
        launchHiddenOnMac ? (macAppPath ? "macOS background hidden/offscreen " : "direct hidden/offscreen ") : ""
      }(port ${instance.cdpPort}, user-data-dir ${instance.chromeDataDir})…`,
    );
    const proc = spawn(command, args, { detached: true, stdio: "ignore" });
    proc.unref?.();
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
