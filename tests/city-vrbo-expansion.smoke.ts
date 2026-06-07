// Local smoke for the nearby-city combo expansion server module.
// Network-free: with no sidecar heartbeat, getHeartbeat().isOnline === false, so
// the worker hits its pre-loop offline gate before any Photon/sidecar call.
// The worker dynamically imports vrbo-sidecar-queue, which transitively loads
// server/db.ts (throws if DATABASE_URL is unset; it connects lazily, and
// getHeartbeat never queries) — so seed a dummy URL for the offline-gate path.
process.env.DATABASE_URL ||= "postgres://smoke:smoke@127.0.0.1:5432/smoke";
import {
  startExpansionJob,
  getExpansionJob,
  cancelExpansionJob,
  serializeExpansionJob,
  CityExpansionValidationError,
} from "../server/city-vrbo-expansion";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, extra ?? ""); }
};

async function main() {
  // 1. Combo-only gate: single-unit property (2 = Keauhou, 1 unit) must throw.
  try {
    startExpansionJob({ propertyId: 2, checkIn: "2026-08-01", checkOut: "2026-08-08" });
    check("single-unit property rejected", false, "no throw");
  } catch (e) {
    check("single-unit property rejected", e instanceof CityExpansionValidationError, (e as Error)?.message);
  }

  // 2. Date validation.
  try {
    startExpansionJob({ propertyId: 4, checkIn: "bad", checkOut: "2026-08-08" });
    check("bad date rejected", false, "no throw");
  } catch (e) {
    check("bad date rejected", e instanceof CityExpansionValidationError);
  }

  // 3. Valid 2-unit combo (4 = Poipu Kai, 2x3BR) starts a job and, with the
  //    sidecar offline, resolves to worker_offline near-instantly (pre-loop gate).
  const started = startExpansionJob({ propertyId: 4, checkIn: "2026-08-01", checkOut: "2026-08-08" });
  check("combo property starts a job", !!started.jobId && started.community === "Poipu Kai", started);

  // 4. Single-flight: a second start for the same (property, dates) returns the same job.
  const again = startExpansionJob({ propertyId: 4, checkIn: "2026-08-01", checkOut: "2026-08-08" });
  check("single-flight returns same job", again.jobId === started.jobId, { started: started.jobId, again: again.jobId });

  await sleep(600);
  const job = getExpansionJob(started.jobId);
  const serialized = job ? serializeExpansionJob(job) : null;
  check("offline worker bails fast → worker_offline", serialized?.status === "worker_offline", serialized?.status);
  check("serialized poll shape has done=true + no combo", serialized?.done === true && serialized?.combo === null, {
    done: serialized?.done, combo: serialized?.combo,
  });
  check("no cities scanned when offline (pre-loop gate)", serialized?.scannedCount === 0, serialized?.scannedCount);

  // 5. cancel on a terminal job still returns true (job exists), null job → false.
  check("cancel unknown job → false", cancelExpansionJob("cve_does_not_exist") === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("harness error:", e); process.exit(1); });
