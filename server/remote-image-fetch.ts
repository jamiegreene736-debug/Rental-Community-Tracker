import sharp from "sharp";
import dns from "node:dns/promises";
import http, {
  type IncomingHttpHeaders,
  type RequestOptions,
} from "node:http";
import https from "node:https";
import net from "node:net";

const BROWSER_IMAGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const MAX_IMAGE_PIXELS = 100_000_000;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_IMAGE_FORMATS = new Set(["jpeg", "png", "webp"]);

export type RemoteImage = {
  buffer: Buffer;
  contentType: string | null;
};

type ResolvedRemoteTarget = {
  address: string;
  family: 4 | 6;
};

type PinnedRemoteResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  buffer: Buffer | null;
};

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = octets;
  if (
    a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }
  return true;
}

function isPublicIpAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (
    normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("::ffff:")
    || normalized.startsWith("64:ff9b:")
    || normalized.startsWith("2001:db8:")
    || normalized.startsWith("2002:")
  ) {
    return false;
  }
  return true;
}

async function resolveRemoteTarget(
  url: URL,
  allowPrivateNetworkForTests: boolean,
  deadlineAt: number,
): Promise<ResolvedRemoteTarget | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    if (!allowPrivateNetworkForTests) return null;
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (!allowPrivateNetworkForTests && !isPublicIpAddress(hostname)) return null;
    return { address: hostname, family: literalFamily as 4 | 6 };
  }

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return null;
  let timeout: NodeJS.Timeout | null = null;
  try {
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("DNS lookup timed out")),
          Math.max(1, Math.min(3_000, remainingMs)),
        );
        timeout.unref?.();
      }),
    ]);
    if (
      addresses.length === 0
      || (!allowPrivateNetworkForTests
        && addresses.some((entry) => !isPublicIpAddress(entry.address)))
    ) {
      return null;
    }
    const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    return {
      address: selected.address,
      family: selected.family === 6 ? 6 : 4,
    };
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Request through the exact address already validated above. Supplying a
 * pinned lookup prevents a hostile hostname from returning a public address
 * to validation and a private address to the subsequent connection.
 */
function requestPinnedRemote(
  url: URL,
  target: ResolvedRemoteTarget,
  headers: Record<string, string> | undefined,
  deadlineAt: number,
  maxBytes: number,
): Promise<PinnedRemoteResponse | null> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let wallTimer: NodeJS.Timeout | null = null;
    const settle = (value: PinnedRemoteResponse | null) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      resolve(value);
    };
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: {
        ...(headers ?? {}),
        Host: url.host,
      },
      lookup: (_lookupHostname, _lookupOptions, callback) => {
        callback(null, target.address, target.family);
      },
      ...(url.protocol === "https:" && !net.isIP(hostname)
        ? { servername: hostname }
        : {}),
    };
    const makeRequest = url.protocol === "https:" ? https.request : http.request;
    const request = makeRequest(requestOptions, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (REDIRECT_STATUS_CODES.has(statusCode) || statusCode < 200 || statusCode >= 300) {
        settle({ statusCode, headers: response.headers, buffer: null });
        response.destroy();
        return;
      }

      const rawLength = Array.isArray(response.headers["content-length"])
        ? response.headers["content-length"][0]
        : response.headers["content-length"];
      const declaredBytes = Number(rawLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        settle({ statusCode, headers: response.headers, buffer: null });
        response.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | Uint8Array) => {
        if (settled) return;
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > maxBytes) {
          settle({ statusCode, headers: response.headers, buffer: null });
          response.destroy();
          return;
        }
        chunks.push(bytes);
      });
      response.once("end", () => {
        settle({
          statusCode,
          headers: response.headers,
          buffer: Buffer.concat(chunks, total),
        });
      });
      response.once("aborted", () => settle(null));
      response.once("error", () => settle(null));
    });
    wallTimer = setTimeout(() => {
      request.destroy(new Error("remote image request timed out"));
    }, Math.max(1, remainingMs));
    wallTimer.unref?.();
    request.setTimeout(Math.max(1, remainingMs), () => {
      request.destroy(new Error("remote image socket timed out"));
    });
    request.once("error", () => settle(null));
    request.end();
  });
}

async function fetchValidatedRemote(
  initialUrl: URL,
  headers: Record<string, string> | undefined,
  deadlineAt: number,
  maxBytes: number,
  allowPrivateNetworkForTests: boolean,
): Promise<PinnedRemoteResponse | null> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (Date.now() >= deadlineAt) return null;
    if (current.username || current.password) return null;
    const target = await resolveRemoteTarget(
      current,
      allowPrivateNetworkForTests,
      deadlineAt,
    );
    if (!target) return null;
    const response = await requestPinnedRemote(
      current,
      target,
      headers,
      deadlineAt,
      maxBytes,
    );
    if (!response) return null;
    if (!REDIRECT_STATUS_CODES.has(response.statusCode)) return response;
    const rawLocation = response.headers.location;
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
    if (!location) return null;
    try {
      current = new URL(location, current);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Download one remote raster image with a pinned public destination and bounded
 * response size. The neutral first request avoids crawler-name CDN blocks; a
 * browser-shaped retry handles CDNs that require a browser user agent.
 */
export async function fetchRemoteImage(
  rawUrl: string,
  opts: {
    timeoutMs?: number;
    minBytes?: number;
    maxBytes?: number;
    /** Test-only escape hatch for a loopback HTTP fixture. */
    allowPrivateNetworkForTests?: boolean;
  } = {},
): Promise<RemoteImage | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
  ) {
    return null;
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const minBytes = Math.max(0, opts.minBytes ?? 1);
  const maxBytes = Math.max(minBytes, opts.maxBytes ?? 20 * 1024 * 1024);
  const allowPrivateNetworkForTests = opts.allowPrivateNetworkForTests === true;
  const attempts: Array<Record<string, string> | undefined> = [
    undefined,
    {
      Accept: "image/jpeg,image/png,image/webp,*/*;q=0.1",
      "User-Agent": BROWSER_IMAGE_USER_AGENT,
    },
  ];
  const deadlineAt = Date.now() + Math.max(1, timeoutMs);

  for (const headers of attempts) {
    try {
      const response = await fetchValidatedRemote(
        url,
        headers,
        deadlineAt,
        maxBytes,
        allowPrivateNetworkForTests,
      );
      if (
        !response
        || response.statusCode < 200
        || response.statusCode >= 300
        || !response.buffer
      ) {
        continue;
      }
      const { buffer } = response;
      if (buffer.length < minBytes || buffer.length > maxBytes) continue;
      const metadata = await sharp(buffer, {
        failOn: "none",
        limitInputPixels: MAX_IMAGE_PIXELS,
      }).metadata().catch(() => null);
      if (
        !metadata?.format
        || !ALLOWED_IMAGE_FORMATS.has(metadata.format)
        || !metadata.width
        || !metadata.height
        || metadata.width * metadata.height * (metadata.pages ?? 1) > MAX_IMAGE_PIXELS
      ) {
        continue;
      }
      const rawContentType = response.headers["content-type"];
      return {
        buffer,
        contentType: Array.isArray(rawContentType)
          ? rawContentType[0] ?? null
          : rawContentType ?? null,
      };
    } catch {
      // Try the browser-shaped request, then fail closed.
    }
  }
  return null;
}
