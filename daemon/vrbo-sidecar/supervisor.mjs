import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, "worker.mjs");
const DEFAULT_MAX_WORKERS = 8;
const HARD_MAX_WORKERS = 12;
const requestedWorkers = Number(process.env.MAX_LOCAL_CHROME_INSTANCES ?? DEFAULT_MAX_WORKERS) || DEFAULT_MAX_WORKERS;
const maxWorkers = Math.min(HARD_MAX_WORKERS, Math.max(1, Math.floor(requestedWorkers)));
const children = new Map();
let shuttingDown = false;

function log(message) {
  console.log(`[${new Date().toISOString()}] [vrbo-sidecar-supervisor] ${message}`);
}

// ── Keep the Mac awake while the sidecar has work ────────────────────────────
// The buy-in BULK QUEUE (and any sidecar scan) stalls if the Mac idle-sleeps:
// macOS suspends this LaunchAgent on sleep, the workers stop polling the server,
// and the server marks the sidecar "offline" after ~90s — so an unattended queue
// dies mid-run even though the Mac is "online". While there is active OR pending
// sidecar work we hold a `caffeinate -i` power assertion (prevents IDLE system
// sleep so the workers keep polling; the DISPLAY may still sleep and the operator
// can still sleep manually / close the lid). It's released after a grace window
// with no work so the Mac sleeps normally when idle. macOS-only; opt out with
// SIDECAR_KEEP_MAC_AWAKE=0. We poll the server's queue status (auth-excluded
// /api/admin/vrbo-sidecar/* path) rather than guessing from worker CPU.
const KEEP_AWAKE_SERVER = String(process.env.SIDECAR_SERVER || "").replace(/\/+$/, "");
const KEEP_AWAKE_ENABLED =
  process.platform === "darwin" &&
  (process.env.SIDECAR_KEEP_MAC_AWAKE ?? "1") !== "0" &&
  !!KEEP_AWAKE_SERVER;
const KEEP_AWAKE_POLL_MS = 30_000;
const KEEP_AWAKE_GRACE_MS = Math.max(60_000, Number(process.env.SIDECAR_KEEP_MAC_AWAKE_GRACE_MS) || 5 * 60_000);
let caffeinateChild = null;
let lastBusyAt = 0;

function setCaffeinate(on) {
  if (on === !!caffeinateChild) return;
  if (on) {
    try {
      // -i: prevent idle SYSTEM sleep (keeps workers polling). -m: keep disk awake.
      caffeinateChild = spawn("caffeinate", ["-i", "-m"], { stdio: "ignore" });
      caffeinateChild.on("exit", () => { caffeinateChild = null; });
      log("caffeinate held — Mac will not idle-sleep while the sidecar has work");
    } catch (e) {
      caffeinateChild = null;
      log(`caffeinate spawn failed: ${e?.message ?? e}`);
    }
  } else {
    try { caffeinateChild.kill(); } catch {}
    caffeinateChild = null;
    log("caffeinate released — sidecar idle, Mac may sleep normally");
  }
}

async function pollKeepAwake() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`${KEEP_AWAKE_SERVER}/api/admin/vrbo-sidecar/status`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const s = await res.json();
      if ((Number(s?.pending) || 0) + (Number(s?.inProgress) || 0) > 0) lastBusyAt = Date.now();
    }
  } catch {
    // Transient blip (server unreachable): hold the current assertion until the
    // grace window lapses rather than dropping it on a single missed poll.
  }
  setCaffeinate(Date.now() - lastBusyAt < KEEP_AWAKE_GRACE_MS);
}

function startWorker(slot) {
  const child = spawn(process.execPath, [workerPath], {
    cwd: __dirname,
    stdio: "inherit",
    env: {
      ...process.env,
      SIDECAR_WORKER_SLOT: String(slot),
      MAX_LOCAL_CHROME_INSTANCES: String(maxWorkers),
      SERVER_CHROME_FALLBACK_ENABLED: process.env.SERVER_CHROME_FALLBACK_ENABLED ?? "0",
    },
  });
  children.set(slot, child);
  log(`started worker ${slot}/${maxWorkers} pid=${child.pid}`);
  child.on("exit", (code, signal) => {
    children.delete(slot);
    log(`worker ${slot} exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    if (!shuttingDown) {
      setTimeout(() => startWorker(slot), 5_000).unref?.();
    }
  });
}

async function stopAll(signal) {
  shuttingDown = true;
  try { caffeinateChild?.kill(); } catch { /* ignore */ }
  log(`received ${signal}; stopping ${children.size} worker(s)`);
  for (const child of children.values()) child.kill(signal);
  setTimeout(() => process.exit(0), 5_000).unref?.();
}

process.on("SIGINT", () => void stopAll("SIGINT"));
process.on("SIGTERM", () => void stopAll("SIGTERM"));

log(`starting local worker pool max=${maxWorkers}`);
for (let slot = 1; slot <= maxWorkers; slot++) startWorker(slot);

if (KEEP_AWAKE_ENABLED) {
  log(`keep-mac-awake ON (poll ${KEEP_AWAKE_POLL_MS}ms, grace ${Math.round(KEEP_AWAKE_GRACE_MS / 1000)}s)`);
  const ka = setInterval(() => void pollKeepAwake(), KEEP_AWAKE_POLL_MS);
  ka.unref?.();
  void pollKeepAwake();
} else if (process.platform === "darwin") {
  log("keep-mac-awake OFF (SIDECAR_KEEP_MAC_AWAKE=0 or no SIDECAR_SERVER)");
}
process.on("exit", () => { try { caffeinateChild?.kill(); } catch { /* ignore */ } });
