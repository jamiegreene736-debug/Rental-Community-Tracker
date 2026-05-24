const DEFAULT_BRIGHTDATA_HOST = "brd.superproxy.io";
const DEFAULT_BRIGHTDATA_PORT = 33335;
const DEFAULT_GONZOPROXY_API_URL = "https://api.gonzoproxy.app/functions/v1/proxy-api/generate";
const DEFAULT_DECODO_HOST = "gate.decodo.com";
const DEFAULT_DECODO_PORT = 7000;

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
    country: nonEmptyEnv("GONZOPROXY_COUNTRY", "CHROME_PROXY_COUNTRY", "PROXY_COUNTRY") || "US",
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

  if (provider === "decodo") {
    return {
      host: nonEmptyEnv("DECODO_PROXY_HOST", "CHROME_PROXY_HOST", "PROXY_HOST") || DEFAULT_DECODO_HOST,
      port: Number(nonEmptyEnv("DECODO_PROXY_PORT", "CHROME_PROXY_PORT", "PROXY_PORT") || DEFAULT_DECODO_PORT),
      username: nonEmptyEnv("DECODO_PROXY_USERNAME", "CHROME_PROXY_USERNAME", "PROXY_USERNAME"),
      password: nonEmptyEnv("DECODO_PROXY_PASSWORD", "CHROME_PROXY_PASSWORD", "PROXY_PASSWORD"),
    };
  }

  return {
    host: nonEmptyEnv("CHROME_PROXY_HOST", "PROXY_HOST"),
    port: Number(nonEmptyEnv("CHROME_PROXY_PORT", "PROXY_PORT")),
    username: nonEmptyEnv("CHROME_PROXY_USERNAME", "PROXY_USERNAME"),
    password: nonEmptyEnv("CHROME_PROXY_PASSWORD", "PROXY_PASSWORD"),
  };
}

function appendDecodoUsernameOptions(username, sessionId) {
  const parts = [String(username ?? "").trim()];
  const country = sanitizeProxyOption(nonEmptyEnv("DECODO_PROXY_COUNTRY", "CHROME_PROXY_COUNTRY", "PROXY_COUNTRY"));
  const state = sanitizeProxyOption(nonEmptyEnv("DECODO_PROXY_STATE", "CHROME_PROXY_STATE", "PROXY_STATE"));
  const city = sanitizeProxyOption(nonEmptyEnv("DECODO_PROXY_CITY", "CHROME_PROXY_CITY", "PROXY_CITY"));
  const zip = sanitizeProxyOption(nonEmptyEnv("DECODO_PROXY_ZIP", "CHROME_PROXY_ZIP", "PROXY_ZIP"));
  const sessionDuration = Math.max(1, Math.min(1440, Math.floor(numberFromEnv("DECODO_PROXY_SESSION_DURATION_MINUTES", 20))));
  const session = sanitizeProxyOption(nonEmptyEnv("DECODO_PROXY_SESSION")) || proxySessionToken(sessionId);

  if (country && !/-country-[a-z0-9_]+(?:-|$)/i.test(parts[0])) parts.push(`country-${country}`);
  if (state && !/-state-[a-z0-9_]+(?:-|$)/i.test(parts[0])) parts.push(`state-${state}`);
  if (city && !/-city-[a-z0-9_]+(?:-|$)/i.test(parts[0])) parts.push(`city-${city}`);
  if (zip && !/-zip-[a-z0-9_]+(?:-|$)/i.test(parts[0])) parts.push(`zip-${zip}`);
  if (!/-session-[a-z0-9_]+(?:-|$)/i.test(parts[0])) parts.push(`session-${session}`);
  if (!/-sessionduration-\d+(?:-|$)/i.test(parts[0])) parts.push(`sessionduration-${sessionDuration}`);

  const needsUserPrefix = boolFromEnv("DECODO_PROXY_USER_PREFIX", true) && !/^user-/i.test(parts[0]);
  if (needsUserPrefix) parts[0] = `user-${parts[0]}`;
  return parts.filter(Boolean).join("-");
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

  const provider = (nonEmptyEnv("CHROME_PROXY_PROVIDER", "PROXY_PROVIDER") || "brightdata").toLowerCase();
  const scheme = nonEmptyEnv("CHROME_PROXY_SCHEME", "PROXY_SCHEME") || "http";
  const isBrightData = provider === "brightdata";
  const isDecodo = provider === "decodo";
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
  if (isDecodo) {
    username = appendDecodoUsernameOptions(username, sessionId);
  }

  return { provider, scheme, host, port, username, password };
}

export { boolFromEnv, nonEmptyEnv, sanitizeProxyOption };
