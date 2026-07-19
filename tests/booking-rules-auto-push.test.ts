// Booking-rules mapping-birth auto-push (2026-07-19 Royal Kahana incident).
//
// The 7-day advance-notice cutoff was pushed portfolio-wide exactly ONCE
// (2026-06-02, push-advance-notice-all). Every listing mapped after that date
// silently had NO cutoff in Guesty — the Pricing tab's Booking Rules card
// renders client-side defaults when no saved row exists, so the gap was
// invisible until VRBO sold a next-day arrival on Royal Kahana (booked
// 2026-07-19 20:03Z for a 2026-07-20 check-in, $6.7k fare, listing
// 6a3bdba43b75bc0023cd9230: calendarRules.advanceNotice had no
// defaultSettings.hours at all). This suite locks the three-part fix:
//  1. autoPushBookingRulesForMapping fires at EVERY mapping-birth seam
//     (parity with autoPushSavedAmenitiesForProperty), skips operator-owned
//     rows, floors min-nights at the standing policy, and forces the 7-day
//     advance notice.
//  2. push-advance-notice-all floors min-nights so re-running the sweep can
//     never push a stale minNights=3 row back over the min-4 policy.
//  3. The Booking Rules card warns when it is rendering never-pushed defaults.
import fs from "node:fs";

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

const read = (rel: string): string => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

console.log("booking-rules-auto-push: advance-notice cutoff reaches every newly mapped listing");

const routes = read("server/routes.ts");
const builder = read("client/src/components/GuestyListingBuilder/index.tsx");

// ── The hook itself ──────────────────────────────────────────────────────────
const hookStart = routes.indexOf("async function autoPushBookingRulesForMapping(");
check("routes.ts defines autoPushBookingRulesForMapping", hookStart >= 0);

const hookBody = hookStart >= 0
  ? routes.slice(hookStart, routes.indexOf("\n  }", hookStart) + 4)
  : "";

check("hook has the BOOKING_RULES_AUTO_PUSH_DISABLED kill switch",
  hookBody.includes('process.env.BOOKING_RULES_AUTO_PUSH_DISABLED === "1"'));

check("hook SKIPS when a saved builder_booking_rules row exists (operator-owned rules are never clobbered)",
  hookBody.includes("getBuilderBookingRules(propertyId, guestyListingId)")
  && /if \(existing\) return;/.test(hookBody));

check("hook merges the listing's LIVE Guesty terms before applying defaults (maxNights 45 must survive)",
  hookBody.includes("currentBuilderBookingRulesForListing(propertyId, guestyListingId)"));

check("hook forces the standing 7-day advance notice",
  hookBody.includes("advanceNotice: DEFAULT_ADVANCE_NOTICE_DAYS")
  && routes.includes("const DEFAULT_ADVANCE_NOTICE_DAYS = 7;"));

check("hook floors min-nights at the standing policy (Guesty newborn listings default to 1)",
  hookBody.includes("rules.minNights = Math.max(rules.minNights, DEFAULT_MIN_NIGHTS);"));

check("hook pushes through the canonical pushBuilderBookingRulesToGuesty seam (read-back verify + row upsert + availability ledger)",
  hookBody.includes("pushBuilderBookingRulesToGuesty(propertyId, guestyListingId, rules)"));

check("hook has a cooldown absorbing the create flow's double-fire",
  hookBody.includes("BOOKING_RULES_AUTO_PUSH_COOLDOWN_MS"));

// ── Mapping-birth seam parity with the amenities auto-push ───────────────────
// Every seam that auto-pushes amenities at mapping birth must also auto-push
// booking rules. If a new mapping-birth seam is added with the amenities hook
// but not this one, this lock trips.
const EXPECTED_SEAMS = [
  "guesty-property-map",
  "schedule-sync",
  "sync-now",
  "guesty-import",
  "guesty-import-create",
];
for (const seam of EXPECTED_SEAMS) {
  check(`mapping-birth seam "${seam}" fires the booking-rules auto-push`,
    routes.includes(`autoPushBookingRulesForMapping(propertyId, guestyListingId.trim(), "${seam}")`)
    || routes.includes(`autoPushBookingRulesForMapping(propertyId, guestyListingId, "${seam}")`)
    || routes.includes(`autoPushBookingRulesForMapping(requestedPropertyId, guestyListingId, "${seam}")`)
    || routes.includes(`autoPushBookingRulesForMapping(-draft.id, guestyListingId, "${seam}")`));
}

const amenitySeamCalls = (routes.match(/void autoPushSavedAmenitiesForProperty\(/g) ?? []).length;
const bookingRuleSeamCalls = (routes.match(/void autoPushBookingRulesForMapping\(/g) ?? []).length;
check(`booking-rules seam count matches the amenities seam count (${bookingRuleSeamCalls}/${amenitySeamCalls}) — a new mapping-birth seam must wire BOTH hooks`,
  amenitySeamCalls > 0 && bookingRuleSeamCalls === amenitySeamCalls);

// ── Bulk sweep min-nights floor ──────────────────────────────────────────────
const bulkStart = routes.indexOf('"/api/builder/booking-rules/push-advance-notice-all"');
const bulkEnd = routes.indexOf('app.get("/api/builder/booking-rules/:propertyId"', bulkStart);
const bulkBody = bulkStart >= 0 && bulkEnd > bulkStart ? routes.slice(bulkStart, bulkEnd) : "";
check("push-advance-notice-all FLOORS min-nights at DEFAULT_MIN_NIGHTS (a re-run must never push a stale saved minNights=3 back over the min-4 policy)",
  bulkBody.includes("rules.minNights = Math.max(rules.minNights, DEFAULT_MIN_NIGHTS);"));

// ── Pricing-tab honesty warning ──────────────────────────────────────────────
check("Booking Rules card warns when rendering never-pushed defaults",
  builder.includes("Never pushed to Guesty — showing defaults")
  && builder.includes("booking-rules-never-pushed-warning"));

check("warning keys off the server's confirmed rules:null (fetch OK), not a failed fetch",
  builder.includes("setBookingRulesNeverPushed(true)")
  && /catch\(\(\) => \{\s*\n\s*if \(!cancelled\) \{\s*\n\s*setBookingRulesPushInfo\(null\);\s*\n[^]{0,200}setBookingRulesNeverPushed\(false\)/.test(builder));

check("a successful manual push clears the warning",
  builder.split("setBookingRulesNeverPushed(false)").length >= 4);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
