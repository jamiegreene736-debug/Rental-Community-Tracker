// Refund alert "booked <date> · cancelled <date>" — locks the 2026-07-20
// operator ask: the "Guest cancelled — payment on file" dashboard alert must
// show WHEN the guest booked in addition to when they cancelled.
//
// Wiring guarded here (all source guards — the pieces span schema, boot ALTER,
// the Guesty sync, and two render sites, and any one silently dropping loses
// the date without a type error at the seam):
//   1. shared/schema.ts — reservation_cancellation_audits.booked_at column.
//   2. server/schema-maintenance.ts — idempotent boot ALTER so a Railway
//      deploy is usable before db:push runs.
//   3. server/routes.ts buildCancellationAudit — bookedAt comes from the
//      reservation's createdAt ONLY (no updatedAt/cancelledAt fallback: a
//      wrong "booked" date is worse than none), and createdAt stays in the
//      Guesty fields= list so the sync actually receives it.
//   4. client/src/pages/home.tsx — both the refund alert row and the
//      cancellations dialog row render the booked date, conditionally (legacy
//      rows are null until the background rescan heals them — never "booked
//      N/A").
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const schema = readFileSync(new URL("../shared/schema.ts", import.meta.url), "utf8");
const maintenance = readFileSync(new URL("../server/schema-maintenance.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const home = readFileSync(new URL("../client/src/pages/home.tsx", import.meta.url), "utf8");

console.log("cancellation booked-date: schema");

const auditTable = schema.slice(
  schema.indexOf("reservationCancellationAudits = pgTable"),
  schema.indexOf("insertReservationCancellationAuditSchema"),
);
check("reservation_cancellation_audits declares bookedAt -> booked_at",
  /bookedAt:\s*timestamp\("booked_at"\)/.test(auditTable));

check("schema-maintenance boot-ALTERs booked_at onto reservation_cancellation_audits",
  /ALTER TABLE reservation_cancellation_audits\s+ADD COLUMN IF NOT EXISTS booked_at timestamp/.test(maintenance));

console.log("cancellation booked-date: Guesty sync");

const buildAudit = routes.slice(
  routes.indexOf("const buildCancellationAudit = "),
  routes.indexOf("const scanCancellationAuditsForProperty = "),
);
check("buildCancellationAudit derives bookedAt from reservation createdAt",
  /const bookedAt = timestampOrNull\(reservation\?\.createdAt\);/.test(buildAudit));
check("bookedAt has NO fallback to updatedAt/cancelledAt (a wrong booked date is worse than none)",
  !/const bookedAt = [^;]*(updatedAt|cancelledAt|canceledAt)/.test(buildAudit));
check("buildCancellationAudit persists bookedAt on the audit row",
  /\n\s+bookedAt,\n\s+cancelledAt,/.test(buildAudit));

const scanFn = routes.slice(
  routes.indexOf("const scanCancellationAuditsForProperty = "),
  routes.indexOf("const dashboardCancellationWindowDays"),
);
check("cancellation scan requests createdAt in the Guesty fields= list",
  /"createdAt",/.test(scanFn));

console.log("cancellation booked-date: dashboard rendering");

check("refund alert row renders the booked date next to cancelled",
  home.includes("` · booked ${formatShortDate(row.bookedAt)}`"));
check("cancellations dialog row renders the booked date",
  home.includes("`booked ${formatShortDate(row.bookedAt)} · `"));
check("booked date renders CONDITIONALLY (legacy null rows must not show 'booked N/A')",
  /row\.bookedAt \? ` · booked \$\{formatShortDate\(row\.bookedAt\)\}` : ""/.test(home) &&
  /row\.bookedAt \? `booked \$\{formatShortDate\(row\.bookedAt\)\} · ` : ""/.test(home));
check("alert row still shows the cancelled date",
  home.includes("cancelled {formatShortDate(row.cancelledAt)}") ||
  /cancelled \{formatShortDate\(row\.cancelledAt\)\}/.test(home));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
