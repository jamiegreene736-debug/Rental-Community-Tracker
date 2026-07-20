/**
 * Find-new-source bedroom-identity guard (2026-07-18).
 *
 * Root cause (Cliffs at Princeville draft 20): the audit sweep's
 * find-new-source rung requested an exact-3BR discovery; fetch-unit-photos
 * found no exact match and returned its REPRESENTATIVE fallback — a 2BR
 * gallery from the same resort (proof status "review", representativeFallback
 * true). The job accepted anything not status="rejected", so the wrong-bedroom
 * gallery REPLACED the unit's real gallery and re-stamped its source URL,
 * silently turning a 3BR unit into a 2BR one with no unit_swaps record and no
 * operator flag — then every weekly audit re-flagged the bedroom shortfall and
 * churned the unit's identity again.
 *
 * The fix is two-layered (both locked here):
 *  1. fetch-unit-photos accepts `rejectRepresentativeFallback` and suppresses
 *     BOTH representative returns (best wrong-BR candidate + configured-source
 *     reuse) — the find-new caller fails honestly instead.
 *  2. the photo-fetch job re-checks every discovery result through the pure
 *     `findNewDiscoveryResultRejection` predicate before accepting.
 */
import { readFileSync } from "fs";
import { findNewDiscoveryResultRejection } from "../shared/preflight-photo-discovery";
import { replacementBedroomMismatch } from "../shared/auto-replace-job-logic";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
};

console.log("find-new-bedroom-guard: pure predicate");
{
  // The exact live failure shape: find-new mode, representative 2BR-for-3BR.
  check(
    "representative fallback is rejected in find-new mode",
    findNewDiscoveryResultRejection({
      findNewSource: true,
      representativeFallback: true,
      bedroomMatch: false,
    }) !== null,
  );
  check(
    "bedroom-contradicted result is rejected in find-new mode even without the representative flag",
    findNewDiscoveryResultRejection({
      findNewSource: true,
      representativeFallback: false,
      bedroomMatch: false,
    }) !== null,
  );
  check(
    "exact-bedroom result is accepted in find-new mode",
    findNewDiscoveryResultRejection({
      findNewSource: true,
      representativeFallback: false,
      bedroomMatch: true,
    }) === null,
  );
  // Unverifiable bedrooms (proof bedroomMatch null) stay acceptable — many
  // listing pages don't parse a bedroom count and blocking them would starve
  // legitimate finds; the observed failure class is the PARSED contradiction.
  check(
    "unknown-bedroom result is accepted in find-new mode",
    findNewDiscoveryResultRejection({
      findNewSource: true,
      representativeFallback: false,
      bedroomMatch: null,
    }) === null,
  );
  // Creation-time flows (empty-unit Find Photos, add-community wizard) keep
  // the representative fallback — photos beat an empty listing at creation.
  check(
    "representative fallback stays accepted outside find-new mode",
    findNewDiscoveryResultRejection({
      findNewSource: false,
      representativeFallback: true,
      bedroomMatch: false,
    }) === null,
  );
}

console.log("find-new-bedroom-guard: wiring source guards");
{
  const jobSrc = readFileSync("server/preflight-background-jobs.ts", "utf8");
  check(
    "photo-fetch job sends rejectRepresentativeFallback tied to findNewSource",
    /rejectRepresentativeFallback:\s*findNewSource/.test(jobSrc),
  );
  check(
    "photo-fetch job re-checks discovery results through findNewDiscoveryResultRejection",
    jobSrc.includes("findNewDiscoveryResultRejection({"),
  );
  check(
    "photo-fetch job checks the response's representativeFallback flag",
    /representativeFallback:\s*fetchData\?\.representativeFallback === true/.test(jobSrc),
  );

  const routesSrc = readFileSync("server/routes.ts", "utf8");
  check(
    "fetch-unit-photos parses the rejectRepresentativeFallback body flag",
    /rejectRepresentativeFallback\s*\}\s*=\s*req\.body/.test(routesSrc)
      || /suppressRepresentativeFallback\s*=\s*rejectRepresentativeFallback === true/.test(routesSrc),
  );
  check(
    "representative fallback return is gated off when suppressed",
    routesSrc.includes("if (representativeFallback && !suppressRepresentativeFallback) {"),
  );
  check(
    "configured-source representative reuse is gated off when suppressed",
    /requestedBedrooms >= 3 &&[\s\S]{0,300}?!suppressRepresentativeFallback\s*\n?\s*\)/.test(routesSrc),
  );
}

console.log("find-new-bedroom-guard: repoint reconciles combinedBedrooms");
{
  const routesSrc = readFileSync("server/routes.ts", "utf8");
  // The unit-swaps commit repoint must keep combinedBedrooms = sum of unit
  // bedrooms whenever a replacement changed a unit's count — otherwise the
  // audit's layout stage validates the Guesty listing against a stale total
  // (the 6-vs-7 Cliffs drift) and the contradiction stays invisible.
  check(
    "commit repoint recomputes combinedBedrooms when a unit's bedrooms change",
    /unit\[12\]Bedrooms.*\.test\(k\)/.test(routesSrc.replace(/\\/g, ""))
      || routesSrc.includes("update.combinedBedrooms = combined"),
  );
  check(
    "single-listing drafts sum only unit 1",
    /draft\.singleListing\s*\n?\s*\?\s*0/.test(routesSrc),
  );
}

// ── 2026-07-20 RECURRENCE: replacement finder bedroom gates were FLOORS ─────
// The 2026-07-19 weekly audit re-flipped the Cliffs 2BR Unit A to 3BR through
// a DIFFERENT hole in the same incident family: the auto-replace ladder's
// find-unit route gated every candidate with ">= requiredBedrooms" ("needs at
// least NBR"), so a 3BR unit (#5308) qualified for the 2BR requirement
// (replacement_find_jobs prfj_mrrhzffg_h9cq4x: payload requiredBedrooms 2,
// returned unit bedrooms 3), got committed as swap #74, and the commit
// repoint flipped the draft to 3BR/7-combined. Replacements stand in for the
// SAME sellable unit, so the match must be EXACT (operator spec since
// 2026-07-04: "same community + same bedroom count").
console.log("find-new-bedroom-guard: replacement finder EXACT bedroom rule");
{
  // Pure predicate: only a POSITIVE mismatch rejects.
  check("exact match passes", !replacementBedroomMismatch(2, 2));
  check("bigger candidate REJECTS (the 2026-07-19 Cliffs shape: 3BR for a 2BR unit)",
    replacementBedroomMismatch(2, 3));
  check("smaller candidate rejects", replacementBedroomMismatch(3, 2));
  check("unknown candidate passes (downstream scrape/vision own it)",
    !replacementBedroomMismatch(2, null) && !replacementBedroomMismatch(2, undefined));
  check("unknown requirement passes", !replacementBedroomMismatch(null, 3) && !replacementBedroomMismatch(undefined, 3));
  check("non-positive / non-finite counts never reject",
    !replacementBedroomMismatch(0, 3) && !replacementBedroomMismatch(2, 0) && !replacementBedroomMismatch(NaN, 3) && !replacementBedroomMismatch(2, NaN));
  check("rounding tolerated", !replacementBedroomMismatch(2, 2.0) && replacementBedroomMismatch(2, 3.0));
}
{
  const routesSrc = readFileSync("server/routes.ts", "utf8");
  // Source guards: every find-unit bedroom gate must run through the shared
  // exact predicate — re-widening any one of them back to a ">= required"
  // floor reintroduces the silent bedroom-count flip.
  const predicateUses = routesSrc.split("replacementBedroomMismatch(").length - 1;
  check("find-unit gates use replacementBedroomMismatch (discovery filter + hint qualifier + pre-scrape + post-scrape)",
    predicateUses >= 4, `uses=${predicateUses}`);
  check("floor wording is gone from the finder's skip reasons",
    !routesSrc.includes("needs at least ${requiredBedroomCount}BR"));
  check("skip reasons state the exact-match rule",
    routesSrc.includes("must match the unit's ${requiredBedroomCount}BR exactly"));
  check("candidate scoring prefers exact matches, not \">= required\"",
    routesSrc.includes("candidate.bedroomHint === requiredBedroomCount ? 0 : 2"));
}
{
  const jobsSrc = readFileSync("server/auto-replace-jobs.ts", "utf8");
  // Belt-and-braces: the orchestrator burns a positively-mismatched candidate
  // before POSTing the commit, and the burn feeds the bounded find-restart.
  check("orchestrator burns bedroom-mismatched candidates pre-commit",
    jobsSrc.includes("burnedBedrooms += 1")
      && jobsSrc.includes("replacementBedroomMismatch(")
      && jobsSrc.includes("unit.bedrooms,"));
  check("bedroom burns widen the pool via find restart",
    jobsSrc.includes("burnedCoverage > 0 || burnedCommunity > 0 || burnedBedrooms > 0"));
  check("all-burned failure message reports the bedroom-mismatch count",
    jobsSrc.includes("had a different bedroom count than this unit (replacements must match exactly)"));
}

console.log(`\nfind-new-bedroom-guard: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
