import net from "net";

const DEFAULT_BRIGHTDATA_HOST = "brd.superproxy.io";
const DEFAULT_BRIGHTDATA_PORT = 33335;
const DEFAULT_GONZOPROXY_API_URL = "https://api.gonzoproxy.app/functions/v1/proxy-api/generate";
const REQUIRED_PROXY_COUNTRY = "us";

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
    const v = process.env[name];
    if (typeof v === "string" && v.trim()) return v.trim();
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

function proxySessionToken(sessionId) {
  const request = sessionId?.request ?? {};
  const instance = sessionId?.instance ?? {};
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

function parseProxyCredentialLine(value) {
  const line = String(value ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;

  const parts = line.split(":");
  if (parts.length < 4) return null;

  const [host, portRaw, username, ...passwordParts] = parts;
  const port = Number(portRaw);
  const password = passwordParts.join(":");
  if (!host || !Number.isFinite(port) || port <= 0 || !username || !password) return null;
  return { host, port, username, password };
}

function collectProxyCredentialCandidates(value, candidates = []) {
  if (typeof value === "string") {
    candidates.push(value);
    return candidates;
  }
  if (!value || typeof value !== "object") return candidates;
  if (Array.isArray(value)) {
    for (const item of value) collectProxyCredentialCandidates(item, candidates);
    return candidates;
  }

  for (const key of ["proxy", "credential", "credentials", "result", "data", "proxies"]) {
    if (key in value) collectProxyCredentialCandidates(value[key], candidates);
  }

  const host = value.host || value.proxyHost || value.proxy_address || value.proxyAddress;
  const port = value.port || value.proxyPort || value.proxy_port;
  const username = value.username || value.user || value.login || value.proxyLogin || value.proxy_login;
  const password = value.password || value.pass || value.proxyPassword || value.proxy_password;
  if (host && port && username && password) {
    candidates.push(`${host}:${port}:${username}:${password}`);
  }
  return candidates;
}

function parseGonzoProxyCredential(body) {
  const text = String(body ?? "").trim();
  const direct = parseProxyCredentialLine(text);
  if (direct) return direct;

  try {
    const parsed = JSON.parse(text);
    const candidates = collectProxyCredentialCandidates(parsed);
    for (const candidate of candidates) {
      const credential = parseProxyCredentialLine(candidate);
      if (credential) return credential;
    }
  } catch {
    // GonzoProxy can return plain text depending on format, so non-JSON is valid.
  }

  return null;
}

async function generateGonzoProxyCredential() {
  const apiKey = nonEmptyEnv("GONZOPROXY_API_KEY", "GONZO_PROXY_API_KEY");
  if (!apiKey) {
    throw new Error(
      "CHROME_PROXY_PROVIDER=gonzoproxy requires either CHROME_PROXY_HOST/PORT/USERNAME/PASSWORD or GONZOPROXY_API_KEY.",
    );
  }

  const body = {
    country: "US",
    count: numberFromEnv("GONZOPROXY_COUNT", 1),
    rotation: boolFromEnv("GONZOPROXY_ROTATION", false),
    ttl: numberFromEnv("GONZOPROXY_TTL", 12),
    ttl_unit: nonEmptyEnv("GONZOPROXY_TTL_UNIT") || "hours",
    format: nonEmptyEnv("GONZOPROXY_FORMAT") || "1",
  };

  const url = nonEmptyEnv("GONZOPROXY_API_URL") || DEFAULT_GONZOPROXY_API_URL;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(numberFromEnv("GONZOPROXY_API_TIMEOUT_MS", 20_000)),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`GonzoProxy credential generation failed (${resp.status}): ${text.slice(0, 200) || resp.statusText}`);
  }

  const credential = parseGonzoProxyCredential(text);
  if (!credential) {
    throw new Error(`GonzoProxy credential generation returned an unrecognized response: ${text.slice(0, 200)}`);
  }
  return credential;
}

function explicitProxyConfig(provider) {
  if (provider === "brightdata" || !provider) {
    return {
      host: nonEmptyEnv("BRIGHTDATA_PROXY_HOST", "CHROME_PROXY_HOST", "PROXY_HOST") || DEFAULT_BRIGHTDATA_HOST,
      port: Number(nonEmptyEnv("BRIGHTDATA_PROXY_PORT", "CHROME_PROXY_PORT", "PROXY_PORT") || DEFAULT_BRIGHTDATA_PORT),
      username: nonEmptyEnv("BRIGHTDATA_PROXY_USERNAME", "CHROME_PROXY_USERNAME", "PROXY_USERNAME"),
      password: nonEmptyEnv("BRIGHTDATA_PROXY_PASSWORD", "CHROME_PROXY_PASSWORD", "PROXY_PASSWORD"),
    };
  }

  if (provider === "gonzoproxy") {
    return {
      host: nonEmptyEnv("GONZOPROXY_HOST", "CHROME_PROXY_HOST", "PROXY_HOST"),
      port: Number(nonEmptyEnv("GONZOPROXY_PORT", "CHROME_PROXY_PORT", "PROXY_PORT")),
      username: nonEmptyEnv("GONZOPROXY_USERNAME", "CHROME_PROXY_USERNAME", "PROXY_USERNAME"),
      password: nonEmptyEnv("GONZOPROXY_PASSWORD", "CHROME_PROXY_PASSWORD", "PROXY_PASSWORD"),
    };
  }

  return {
    host: nonEmptyEnv("CHROME_PROXY_HOST", "PROXY_HOST"),
    port: Number(nonEmptyEnv("CHROME_PROXY_PORT", "PROXY_PORT")),
    username: nonEmptyEnv("CHROME_PROXY_USERNAME", "PROXY_USERNAME"),
    password: nonEmptyEnv("CHROME_PROXY_PASSWORD", "PROXY_PASSWORD"),
  };
}

export async function resolveChromeProxyConfig({
  enabled,
  requireServer = false,
  isServer = false,
  sessionId,
  brightDataUsernameOptions,
  incompleteConfigMessage,
} = {}) {
  if (!enabled) return null;
  if (requireServer && !isServer) return null;

  const provider = (nonEmptyEnv("CHROME_PROXY_PROVIDER", "PROXY_PROVIDER") || "none").toLowerCase();
  if (provider === "decodo") {
    throw new Error("Decodo proxy provider is disabled for this project.");
  }
  const scheme = nonEmptyEnv("CHROME_PROXY_SCHEME", "PROXY_SCHEME") || "http";
  const isBrightData = provider === "brightdata";
  const explicit = explicitProxyConfig(provider);
  let { host, port, username, password } = explicit;

  if (provider === "gonzoproxy" && (!host || !Number.isFinite(port) || !username || !password)) {
    const credential = await generateGonzoProxyCredential();
    host = credential.host;
    port = credential.port;
    username = credential.username;
    password = credential.password;
  }

  if (!host || !Number.isFinite(port) || !username || !password) {
    throw new Error(
      incompleteConfigMessage ||
        "CHROME_PROXY_ENABLED=1 but proxy config is incomplete. Set CHROME_PROXY_HOST, CHROME_PROXY_PORT, CHROME_PROXY_USERNAME, and CHROME_PROXY_PASSWORD.",
    );
  }

  if (isBrightData && typeof brightDataUsernameOptions === "function") {
    username = brightDataUsernameOptions(username, sessionId);
  }

  return { provider, scheme, host, port, username, password };
}

function maskProxyUsername(username) {
  const s = String(username ?? "");
  if (!s) return "(empty)";
  if (s.length <= 28) return `${s.slice(0, 12)}…`;
  return `${s.slice(0, 22)}…${s.slice(-6)}`;
}

export async function probeProxyConnect(proxyConfig, targetHost = "lumtest.com", targetPort = 443, timeoutMs = 10_000) {
  const proxyAuthorization = `Basic ${Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString("base64")}`;
  const target = `${targetHost}:${targetPort}`;
  return await new Promise((resolve) => {
    const socket = net.connect(proxyConfig.port, proxyConfig.host);
    socket.setTimeout(timeoutMs);
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
      resolve({ ok: false, status: 0, statusLine: "proxy connect probe timed out" });
    });
    socket.once("error", (e) => {
      resolve({ ok: false, status: 0, statusLine: e?.message ?? "proxy connect probe failed" });
    });
  });
}

async function httpGetViaProxy(proxyConfig, urlString, timeoutMs = 12_000) {
  const url = new URL(urlString);
  if (url.protocol !== "http:") {
    throw new Error(`httpGetViaProxy only supports http URLs (got ${url.protocol})`);
  }
  const proxyAuthorization = `Basic ${Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString("base64")}`;
  const targetPath = `${url.pathname}${url.search}`;

  return await new Promise((resolve, reject) => {
    const socket = net.connect(proxyConfig.port, proxyConfig.host);
    let raw = "";
    const finish = (err, value) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(
        `GET ${url.href} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `Proxy-Authorization: ${proxyAuthorization}\r\n` +
        "Connection: close\r\n" +
        "Accept: application/json\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
    });
    socket.once("timeout", () => finish(new Error("proxy HTTP GET timed out")));
    socket.once("error", (e) => finish(e));
    socket.once("close", () => {
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        finish(new Error("proxy HTTP GET returned no headers"));
        return;
      }
      const headerBlock = raw.slice(0, headerEnd);
      const status = Number(headerBlock.split("\r\n")[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? 0);
      const body = raw.slice(headerEnd + 4).trim();
      if (status < 200 || status >= 300) {
        finish(new Error(`proxy HTTP GET failed: HTTP ${status} ${body.slice(0, 180)}`));
        return;
      }
      finish(null, body);
    });
  });
}

async function fetchEgressViaProxy(proxyConfig) {
  const body = await httpGetViaProxy(
    proxyConfig,
    "http://ip-api.com/json/?fields=status,query,country,regionName,city,isp,proxy,hosting",
  );
  const data = JSON.parse(body);
  if (data?.status !== "success" || !data?.query) {
    throw new Error(`egress lookup failed: ${body.slice(0, 200)}`);
  }
  return {
    ip: data.query,
    country: data.country ?? null,
    region: data.regionName ?? null,
    city: data.city ?? null,
    isp: data.isp ?? null,
    proxy: Boolean(data.proxy),
    hosting: Boolean(data.hosting),
  };
}

/**
 * Startup check: resolve proxy config, verify CONNECT auth, log egress IP, optionally
 * verify that two Decodo/Bright Data session tokens yield different IPs.
 */
export async function runChromeProxyStartupPreflight({
  enabled = false,
  sessionId,
  brightDataUsernameOptions,
  verifySessionRotation = true,
} = {}) {
  if (!enabled) {
    return { ok: true, skipped: true, reason: "CHROME_PROXY_ENABLED=0" };
  }

  let config;
  try {
    config = await resolveChromeProxyConfig({
      enabled: true,
      sessionId,
      brightDataUsernameOptions,
    });
  } catch (e) {
    return { ok: false, phase: "config", error: e?.message ?? String(e) };
  }

  const probe = await probeProxyConnect(config);
  if (!probe.ok) {
    return {
      ok: false,
      phase: "connect",
      provider: config.provider,
      host: config.host,
      port: config.port,
      usernameHint: maskProxyUsername(config.username),
      status: probe.status,
      error: probe.statusLine,
    };
  }

  let egress;
  try {
    egress = await fetchEgressViaProxy(config);
  } catch (e) {
    return {
      ok: false,
      phase: "egress",
      provider: config.provider,
      host: config.host,
      port: config.port,
      usernameHint: maskProxyUsername(config.username),
      error: e?.message ?? String(e),
    };
  }

  const result = {
    ok: true,
    provider: config.provider,
    host: config.host,
    port: config.port,
    usernameHint: maskProxyUsername(config.username),
    ...egress,
  };

  if (!verifySessionRotation) return result;

  const sessionA = {
    instance: { name: "preflight-a" },
    request: { id: "preflight-a", opType: "vrbo_search", requestAttempt: 0 },
  };
  const sessionB = {
    instance: { name: "preflight-b" },
    request: { id: "preflight-b", opType: "vrbo_search", requestAttempt: 0 },
  };

  try {
    const [configA, configB] = await Promise.all([
      resolveChromeProxyConfig({ enabled: true, sessionId: sessionA, brightDataUsernameOptions }),
      resolveChromeProxyConfig({ enabled: true, sessionId: sessionB, brightDataUsernameOptions }),
    ]);
    const [egressA, egressB] = await Promise.all([
      fetchEgressViaProxy(configA),
      fetchEgressViaProxy(configB),
    ]);
    result.rotationCheck = {
      ipA: egressA.ip,
      ipB: egressB.ip,
      distinctIps: egressA.ip !== egressB.ip,
      usernameHintA: maskProxyUsername(configA.username),
      usernameHintB: maskProxyUsername(configB.username),
    };
  } catch (e) {
    result.rotationCheck = { error: e?.message ?? String(e) };
  }

  return result;
}

export { boolFromEnv, nonEmptyEnv, sanitizeProxyOption, proxySessionToken };
