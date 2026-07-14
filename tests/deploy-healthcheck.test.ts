// Deploy healthcheck + transient-fetch retry — locks the 2026-07-14 fix for
// "Remove 6 selected photos → HTTP 502": a deploy swap left the app not
// listening while Railway already routed traffic to it (connection refused at
// the edge for EVERY endpoint). Two layers, both guarded here:
//   1. railway.json healthcheckPath /healthz — Railway keeps the OLD container
//      serving until the new one answers, so deploys stop blackholing the
//      portal. The endpoint must stay auth-exempt AND the sidecar supervisor
//      must answer it too (rct-sidecar-worker-lxkl builds from the same
//      railway.json).
//   2. shared/transient-fetch.ts — bounded client retry for the idempotent
//      dedupe apply/restore calls.
import { readFileSync } from "node:fs";
import {
  TRANSIENT_HTTP_STATUSES,
  fetchWithTransientRetry,
  isTransientHttpStatus,
  transientRetryDelayMs,
} from "../shared/transient-fetch";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const noSleep = async (_ms: number) => {};

async function run() {
  console.log("transient-fetch: status classification");

  check("502/503/504 are transient", isTransientHttpStatus(502) && isTransientHttpStatus(503) && isTransientHttpStatus(504));
  check("app-level statuses are NOT transient (200/400/410/422/500)",
    ![200, 400, 410, 422, 500].some((s) => isTransientHttpStatus(s)));
  check("500 stays out of the retry set — a handler failure must not be blindly repeated",
    !TRANSIENT_HTTP_STATUSES.has(500));

  console.log("transient-fetch: delay curve");

  check("delays back off 2s → 4s and cap at 8s",
    transientRetryDelayMs(0) === 2_000 && transientRetryDelayMs(1) === 4_000 &&
    transientRetryDelayMs(2) === 8_000 && transientRetryDelayMs(5) === 8_000);

  console.log("transient-fetch: retry behavior");

  {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return { status: 200 }; }, { sleep: noSleep });
    check("first success returns immediately with no retry", res.status === 200 && calls === 1);
  }

  {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      return { status: calls < 3 ? 502 : 200 };
    }, { sleep: noSleep });
    check("502,502,200 → retries through to the success", res.status === 200 && calls === 3);
  }

  {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return { status: 410 }; }, { sleep: noSleep });
    check("non-transient status (410 scan-expired) returns on the FIRST attempt — the caller owns its meaning",
      res.status === 410 && calls === 1);
  }

  {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return { status: 502 }; }, { sleep: noSleep });
    check("exhausted retries return the last transient response (default 3 attempts)",
      res.status === 502 && calls === 3);
  }

  {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      if (calls === 1) throw new TypeError("Load failed");
      return { status: 200 };
    }, { sleep: noSleep });
    check("a thrown network error retries too (Safari 'Load failed')", res.status === 200 && calls === 2);
  }

  {
    let calls = 0;
    let threw: unknown = null;
    try {
      await fetchWithTransientRetry(async () => { calls++; throw new Error("boom"); }, { sleep: noSleep, attempts: 2 });
    } catch (e) { threw = e; }
    check("all-throw exhaustion rethrows the last error with the attempts cap respected",
      calls === 2 && threw instanceof Error && (threw as Error).message === "boom");
  }

  {
    const delays: number[] = [];
    let calls = 0;
    await fetchWithTransientRetry(async () => { calls++; return { status: 503 }; }, {
      sleep: async (ms) => { delays.push(ms); },
    });
    check("sleeps between attempts follow the backoff curve", delays.join(",") === "2000,4000");
  }

  console.log("deploy-healthcheck: config + wiring source guards");

  const railwayJson = JSON.parse(readFileSync("railway.json", "utf8"));
  check("railway.json sets healthcheckPath /healthz",
    railwayJson?.deploy?.healthcheckPath === "/healthz");
  check("railway.json healthcheckTimeout covers the slow boot (photos seed + db:push + schema sync)",
    typeof railwayJson?.deploy?.healthcheckTimeout === "number" && railwayJson.deploy.healthcheckTimeout >= 300);

  const indexSrc = readFileSync("server/index.ts", "utf8");
  const healthzAt = indexSrc.indexOf(`app.get("/healthz"`);
  const authAt = indexSrc.indexOf("app.use(requireAuth)");
  check("server/index.ts registers GET /healthz", healthzAt >= 0);
  check("/healthz is registered BEFORE the auth gate (Railway's prober carries no credentials)",
    healthzAt >= 0 && authAt >= 0 && healthzAt < authAt);

  const authSrc = readFileSync("server/auth.ts", "utf8");
  check("server/auth.ts whitelists /healthz in PUBLIC_PATH_EXACT",
    /PUBLIC_PATH_EXACT[\s\S]*?"\/healthz"/.test(authSrc));

  const supervisorSrc = readFileSync("daemon/vrbo-sidecar/supervisor.mjs", "utf8");
  check("sidecar supervisor answers /healthz (rct-sidecar-worker-lxkl shares railway.json)",
    supervisorSrc.includes("/healthz") && supervisorSrc.includes("http.createServer"));
  check("supervisor health listener is gated to Railway — never binds a port on the operator's Mac",
    /RAILWAY_ENVIRONMENT|RAILWAY_PRIVATE_DOMAIN/.test(supervisorSrc) &&
    /if\s*\(onRailway\)/.test(supervisorSrc));

  const builderSrc = readFileSync("client/src/components/GuestyListingBuilder/index.tsx", "utf8");
  check("dedupe APPLY goes through fetchWithTransientRetry",
    /fetchWithTransientRetry\(\(\) =>\s*\n?\s*fetch\("\/api\/builder\/photo-dedupe-apply"/.test(builderSrc));
  check("dedupe RESTORE (undo) goes through fetchWithTransientRetry",
    /fetchWithTransientRetry\(\(\) =>\s*\n?\s*fetch\("\/api\/builder\/photo-dedupe-restore"/.test(builderSrc));
  check("apply error copy explains a transient 5xx honestly (nothing was removed; rescan)",
    builderSrc.includes("isTransientHttpStatus(resp.status)") && builderSrc.includes("Nothing was removed"));

  console.log(`\ndeploy-healthcheck: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
