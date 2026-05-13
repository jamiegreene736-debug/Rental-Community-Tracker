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
  log(`received ${signal}; stopping ${children.size} worker(s)`);
  for (const child of children.values()) child.kill(signal);
  setTimeout(() => process.exit(0), 5_000).unref?.();
}

process.on("SIGINT", () => void stopAll("SIGINT"));
process.on("SIGTERM", () => void stopAll("SIGTERM"));

log(`starting local worker pool max=${maxWorkers}`);
for (let slot = 1; slot <= maxWorkers; slot++) startWorker(slot);
