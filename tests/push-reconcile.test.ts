// Network-free unit tests for shared/push-reconcile.ts — the client-side
// push-outcome reconcile against the durable Guesty push ledger (2026-07-14).
// THE INCIDENT: a Guesty 429 pause held the Descriptions push for 111s; the
// server completed + ledger-stamped SUCCESS, but the browser lost the
// long-lived response and the button sat on "Pushing…" forever. These tests
// lock the fresh-vs-baseline decision (server-time vs server-time, so client
// clock skew can never matter) plus source guards on the client wiring so the
// reconcile loop can't be silently unwired.
import { readFileSync } from "node:fs";
import {
  PUSH_RECONCILE_DEADLINE_MS,
  PUSH_RECONCILE_POLL_MS,
  freshPushOutcome,
  pushEntryTimeMs,
  pushReconcileTimeoutMessage,
} from "../shared/push-reconcile";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const T0 = "2026-07-14T22:00:00.000Z";
const T0_MS = new Date(T0).getTime();
const after = (ms: number) => new Date(T0_MS + ms).toISOString();

console.log("push-reconcile: pushEntryTimeMs");
check("parses a valid ISO entry", pushEntryTimeMs({ pushedAt: T0, status: "success", summary: "x" }) === T0_MS);
check("null entry → null", pushEntryTimeMs(null) === null);
check("undefined entry → null", pushEntryTimeMs(undefined) === null);
check("missing pushedAt → null", pushEntryTimeMs({ status: "success", summary: "x" }) === null);
check("junk pushedAt → null", pushEntryTimeMs({ pushedAt: "not-a-date", status: "success" }) === null);

console.log("push-reconcile: freshPushOutcome");
// The exact incident shape: baseline null (first descriptions push for this
// listing), server later stamps success → the poll must resolve it.
{
  const outcome = freshPushOutcome(null, { pushedAt: after(111_283), status: "success", summary: "7 description fields pushed" });
  check("no-baseline + fresh success resolves", outcome?.status === "success" && outcome.summary === "7 description fields pushed");
}
check(
  "entry newer than baseline resolves",
  freshPushOutcome(T0_MS, { pushedAt: after(60_000), status: "success", summary: "s" })?.status === "success",
);
check(
  "fresh error entry resolves as error",
  freshPushOutcome(T0_MS, { pushedAt: after(60_000), status: "error", summary: "Descriptions push failed: Guesty 500" })?.status === "error",
);
check(
  "entry EQUAL to baseline is stale (strictly newer required)",
  freshPushOutcome(T0_MS, { pushedAt: T0, status: "success", summary: "s" }) === null,
);
check(
  "entry older than baseline is stale",
  freshPushOutcome(T0_MS, { pushedAt: after(-5_000), status: "success", summary: "s" }) === null,
);
check("missing entry never resolves", freshPushOutcome(T0_MS, null) === null);
check(
  "unknown status never resolves",
  freshPushOutcome(null, { pushedAt: after(1_000), status: "pending" as never, summary: "s" }) === null,
);
check(
  "unparseable timestamp never resolves",
  freshPushOutcome(null, { pushedAt: "junk", status: "success", summary: "s" }) === null,
);
check(
  "missing summary degrades to empty string",
  freshPushOutcome(null, { pushedAt: after(1_000), status: "success" })?.summary === "",
);
check(
  "outcome normalizes pushedAt to ISO",
  freshPushOutcome(null, { pushedAt: after(1_000), status: "success", summary: "s" })?.pushedAt === after(1_000),
);

console.log("push-reconcile: constants + copy");
check("poll interval is slow (>= 3s) — the ledger GET must not be hammered", PUSH_RECONCILE_POLL_MS >= 3_000);
check(
  "deadline outlives the worst honest server case (two 120s gate pauses + queue)",
  PUSH_RECONCILE_DEADLINE_MS >= 5 * 60_000,
);
check(
  "timeout copy says the push may still complete (never implies failure)",
  pushReconcileTimeoutMessage("descriptions").includes("may still complete"),
);

// ── Source guards: the client wiring must stay reconciled ──────────────────
// The stuck-"Pushing…" class returns the moment someone "simplifies" the push
// back to a bare fetch+await, so lock the load-bearing pieces to the source.
console.log("push-reconcile: client wiring source guards");
const builderSrc = readFileSync("client/src/components/GuestyListingBuilder/index.tsx", "utf8");
check(
  "builder imports the reconcile module",
  builderSrc.includes(`from "@shared/push-reconcile"`),
);
check(
  "push captures a ledger baseline BEFORE the POST",
  /const baselineMs = pushEntryTimeMs\(await readDescriptionsLedgerEntry\(\)\)/.test(builderSrc),
);
check(
  "push resolves from the ledger via freshPushOutcome",
  /freshPushOutcome\(baselineMs, await readDescriptionsLedgerEntry\(\)\)/.test(builderSrc),
);
check(
  "ledger read hits the durable push-history endpoint",
  builderSrc.includes("/api/builder/guesty-push-history?") ,
);
check(
  "a settled fetch error keeps polling instead of failing immediately",
  builderSrc.includes("keep polling the ledger until the deadline"),
);
check(
  "a DEFINITIVE server JSON error still fails fast (422 placeholder guard UX)",
  builderSrc.includes("fetchErrorDefinitive) throw fetchError"),
);
check(
  "AbortSignal.timeout is feature-detected (older Safari)",
  builderSrc.includes(`typeof AbortSignal.timeout === "function"`),
);

console.log(`\npush-reconcile: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
