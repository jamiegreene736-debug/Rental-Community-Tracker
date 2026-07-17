// Locks the browser-safe normalization layer for the durable automatic-fix
// activity feed. Database writes and route wiring are source-guarded by
// auto-replace-job.test.ts; this file keeps untrusted persisted event rows
// bounded, allowlisted, deduplicated, and safe to render in the dashboard.
import assert from "node:assert";
import {
  AUTO_FIX_ACTIVITY_DEFAULT_LIMIT,
  AUTO_FIX_ACTIVITY_MAX_LIMIT,
  AUTO_FIX_ACTIVITY_MESSAGE_MAX_LENGTH,
  AUTO_FIX_ACTIVITY_STATUSES,
  AUTO_REPLACE_ORIGINS,
  autoFixActivityEventKey,
  normalizeAutoFixActivityLimit,
  parseAutoFixActivityRows,
  parseAutoReplaceOrigin,
  sanitizeAutoFixActivityText,
} from "../shared/auto-fix-activity";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
  }
}

console.log("auto-fix-activity: durable automatic-fix activity normalization");

check("limit: absent/non-finite values use the documented default",
  normalizeAutoFixActivityLimit(undefined) === AUTO_FIX_ACTIVITY_DEFAULT_LIMIT
  && normalizeAutoFixActivityLimit("not-a-number") === AUTO_FIX_ACTIVITY_DEFAULT_LIMIT
  && normalizeAutoFixActivityLimit(Infinity) === AUTO_FIX_ACTIVITY_DEFAULT_LIMIT);

check("limit: values are integer-clamped to 1..MAX",
  normalizeAutoFixActivityLimit(0) === 1
  && normalizeAutoFixActivityLimit(-50) === 1
  && normalizeAutoFixActivityLimit(7.9) === 7
  && normalizeAutoFixActivityLimit(AUTO_FIX_ACTIVITY_MAX_LIMIT + 500) === AUTO_FIX_ACTIVITY_MAX_LIMIT);

check("allowlists: origin and status vocabularies stay explicit and closed",
  AUTO_REPLACE_ORIGINS.join(",") === "operator,operator-audit,scheduled-audit,automatic-retry,legacy-recovery,unknown"
  && AUTO_FIX_ACTIVITY_STATUSES.join(",") === "started,retry-scheduled,retry-started,succeeded,failed,skipped"
  && parseAutoReplaceOrigin("operator-audit") === "operator-audit"
  && parseAutoReplaceOrigin("automatic-retry") === "automatic-retry"
  && parseAutoReplaceOrigin("admin") === "unknown"
  && parseAutoReplaceOrigin(null) === "unknown");

{
  const sanitized = sanitizeAutoFixActivityText(
    "  Failed\u0000 at\nhttps://example.test/unit/9?token=super-secret\t please retry.  ",
  );
  check("text: URLs, control characters, and repeated whitespace are redacted",
    sanitized === "Failed at [link omitted] please retry."
    && !sanitized.includes("super-secret")
    && !/[\u0000-\u001f\u007f]/.test(sanitized));
}

check("text: persisted/operator-facing strings are hard-capped",
  sanitizeAutoFixActivityText("x".repeat(AUTO_FIX_ACTIVITY_MESSAGE_MAX_LENGTH + 200)).length
    === AUTO_FIX_ACTIVITY_MESSAGE_MAX_LENGTH);

const row = (
  id: number,
  eventKey: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  jobId: "arj-test",
  phase: "retry-started",
  message: "Automatic retry started.",
  createdAt: new Date(`2026-07-17T12:0${9 - id}:00.000Z`),
  meta: {
    eventKey,
    propertyId: -25,
    propertyName: "Poipu Kapili",
    unitId: "draft25-unit-b",
    unitLabel: "Unit B",
    origin: "scheduled-audit",
    attemptNumber: 1,
    scheduledFor: "2026-07-17T13:00:00.000Z",
  },
  ...overrides,
});

{
  const parsed = parseAutoFixActivityRows([
    row(9, "same-event"),
    row(8, "same-event", { message: "older duplicate" }),
    row(7, "other-event", {
      phase: "succeeded",
      meta: {
        ...(row(7, "other-event").meta as Record<string, unknown>),
        scheduledFor: "not-a-date",
      },
    }),
  ]);
  check("rows: duplicate event keys keep the first (newest query-order) row",
    parsed.map((event) => event.id).join(",") === "9,7"
    && parsed[0]?.message === "Automatic retry started.");
  check("rows: valid input order is preserved and invalid scheduled dates become null",
    parsed[0]?.status === "retry-started"
    && parsed[1]?.status === "succeeded"
    && parsed[1]?.scheduledFor === null);
}

{
  const malformed = parseAutoFixActivityRows([
    row(0, "bad-id"),
    row(6, "bad-job", { jobId: "" }),
    row(5, "bad-status", { phase: "running" }),
    row(4, "bad-date", { createdAt: "not-a-date" }),
    row(3, "bad-property", {
      meta: { ...(row(3, "bad-property").meta as Record<string, unknown>), propertyId: "NaN" },
    }),
    row(2, "bad-attempt", {
      meta: { ...(row(2, "bad-attempt").meta as Record<string, unknown>), attemptNumber: -1 },
    }),
  ]);
  check("rows: malformed ids, jobs, statuses, dates, property ids, and attempts are dropped",
    malformed.length === 0);
}

{
  const parsed = parseAutoFixActivityRows([
    row(9, "one"),
    row(8, "two"),
    row(7, "three"),
  ], 2);
  check("rows: output obeys the normalized limit without reordering",
    parsed.map((event) => event.id).join(",") === "9,8");
}

check("event keys normalize attempt numbers for stable write deduplication",
  autoFixActivityEventKey("arj-test", "failed", -4) === "arj-test:0:failed"
  && autoFixActivityEventKey("arj-test", "failed", 2.9) === "arj-test:2:failed");

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
