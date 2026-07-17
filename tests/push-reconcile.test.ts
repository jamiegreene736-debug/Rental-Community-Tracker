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
  PHOTO_PUSH_RECONCILE_BASE_MS,
  PHOTO_PUSH_RECONCILE_MAX_MS,
  PHOTO_PUSH_RECONCILE_PER_PHOTO_MS,
  PUSH_RECONCILE_DEADLINE_MS,
  PUSH_RECONCILE_POLL_MS,
  freshPushOutcome,
  photoPushReconcileDeadlineMs,
  photoPushStreamLostMessage,
  pushEntryTimeMs,
  pushReconcileTimeoutMessage,
} from "../shared/push-reconcile";
import { parsePhotosPushSummary, summarizePhotosPush } from "../shared/guesty-push-history";

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

// ── Photos push: stream-loss reconcile (2026-07-14 second incident) ────────
// A 51-photo AI-upscale push ran ~16 min server-side; Railway's edge cut the
// NDJSON response at exactly 15:00, the UI reported failure, and the server
// then finished + verified 51/51 + ledger-stamped success. These lock the
// deadline math and the summary round-trip the client reconcile depends on.
console.log("push-reconcile: photoPushReconcileDeadlineMs");
check(
  "0 remaining photos → floor = the descriptions deadline (never LESS patient)",
  photoPushReconcileDeadlineMs(0) === PUSH_RECONCILE_DEADLINE_MS,
);
check(
  "6 remaining (the live incident's tail) → base + 6/photo = 8 min",
  photoPushReconcileDeadlineMs(6) === PHOTO_PUSH_RECONCILE_BASE_MS + 6 * PHOTO_PUSH_RECONCILE_PER_PHOTO_MS,
);
check(
  "100 remaining → capped so a wedged server can't pin the UI for hours",
  photoPushReconcileDeadlineMs(100) === PHOTO_PUSH_RECONCILE_MAX_MS,
);
check("negative input clamps to the floor", photoPushReconcileDeadlineMs(-5) === PUSH_RECONCILE_DEADLINE_MS);
check("NaN input clamps to the floor", photoPushReconcileDeadlineMs(Number.NaN) === PUSH_RECONCILE_DEADLINE_MS);
check(
  "cap covers a full 100-photo push at the worst honest per-photo cost is >= 30 min",
  PHOTO_PUSH_RECONCILE_MAX_MS >= 30 * 60_000,
);
check(
  "stream-lost copy says the SERVER is still pushing (never implies failure)",
  photoPushStreamLostMessage(45, 51).includes("still pushing") &&
    photoPushStreamLostMessage(45, 51).includes("45 of 51"),
);
check(
  "stream-lost copy omits progress when total is unknown",
  !photoPushStreamLostMessage(0, 0).includes(" of "),
);

console.log("push-reconcile: parsePhotosPushSummary round-trips summarizePhotosPush");
// The reconcile reads counts back out of the ledger summary — the parser must
// stay the exact inverse of the server's builder (same shared module).
check("all verified: '51 photos pushed'", (() => {
  const p = parsePhotosPushSummary(summarizePhotosPush(51, 51));
  return p?.pushed === 51 && p.verified === 51;
})());
check("singular: '1 photo pushed'", (() => {
  const p = parsePhotosPushSummary(summarizePhotosPush(1, 1));
  return p?.pushed === 1 && p.verified === 1;
})());
check("shortfall: '51 photos pushed (49 verified on Guesty)'", (() => {
  const p = parsePhotosPushSummary(summarizePhotosPush(51, 49));
  return p?.pushed === 51 && p.verified === 49;
})());
check("over-verified collapses to pushed (builder emits the bare form)", (() => {
  const p = parsePhotosPushSummary(summarizePhotosPush(10, 12));
  return p?.pushed === 10 && p.verified === 10;
})());
check("cover-collage summary is NOT a photos-push count", parsePhotosPushSummary("Cover collage pushed (12 photos on the listing)") === null);
check("error summary never parses", parsePhotosPushSummary("No photos pushed to Guesty") === null);
check("null/empty never parse", parsePhotosPushSummary(null) === null && parsePhotosPushSummary("") === null);

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

// ── Source guards: PHOTOS stream-loss reconcile wiring ─────────────────────
// The false-"✗ failed" class returns the moment someone treats the NDJSON
// stream as immortal again ("no timeout possible" — it isn't; the edge cuts
// at 15 min) or unwires the ledger fallback.
console.log("push-reconcile: photos client wiring source guards");
check(
  "photo push reads the ledger's PHOTOS tab entry",
  builderSrc.includes("tabs?: { photos?: PushLedgerEntryLike }"),
);
check(
  "photo push captures a ledger baseline BEFORE the POST",
  /const baselineMs = pushEntryTimeMs\(await readPhotosPushLedgerEntry\(selectedId\)\)/.test(builderSrc),
);
check(
  "a lost stream resolves from the ledger via freshPushOutcome",
  /freshPushOutcome\(baselineMs, await readPhotosPushLedgerEntry\(selectedId\)\)/.test(builderSrc),
);
check(
  "reconcile deadline scales with the photos the server still had in flight",
  /photoPushReconcileDeadlineMs\(Math\.max\(0, photos\.length - lastSeenIndex\)\)/.test(builderSrc),
);
check(
  "user cancel (AbortError) returns cancelled and never enters the reconcile",
  /AbortError[\s\S]{0,200}Photo push cancelled\./.test(builderSrc),
);
check(
  "the reconcile loop itself observes a mid-poll cancel",
  builderSrc.includes("if (controller.signal.aborted) {"),
);
check(
  "a definitive !resp.ok error still fails fast (no reconcile)",
  /if \(!resp\.ok\) \{[\s\S]{0,700}return \{ successCount: 0, total: photos\.length/.test(builderSrc),
);
check(
  "ledger counts come from the test-locked summary parser",
  builderSrc.includes("parsePhotosPushSummary(outcome.summary)"),
);
check(
  "reconcile note renders while the ledger poll runs",
  builderSrc.includes("photo-push-reconcile-note"),
);
check(
  "reconciled done state renders the ledger summary (per-photo tail is gone)",
  builderSrc.includes("photo-push-reconciled-done"),
);

// The server side of the contract: push-photos MUST ledger-stamp its outcome
// at the end (that stamp IS the reconcile signal) — success and failure both.
const routesSrc = readFileSync("server/routes.ts", "utf8");
check(
  "push-photos route stamps the photos ledger on completion",
  /recordGuestyPush\(\s*guestyListingId,\s*"photos",\s*successCount > 0 && !strictGalleryError \? "success" : "error"/.test(routesSrc),
);
check(
  "push-photos route stamps the photos ledger on a failed final PUT too",
  routesSrc.includes(`recordGuestyPush(guestyListingId, "photos", "error", \`Photo push failed: \${e.message}\`)`),
);

console.log(`\npush-reconcile: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
