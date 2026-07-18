// Retired unit-builder-data entries (2026-07-18 ghost-audit incident).
//
// Six legacy builder entries (7, 10, 14, 26, 28, 31) were never part of the
// live portfolio: they have no dashboard row in home.tsx's `properties`
// array, no guesty_property_map row, and no PROPERTY_UNIT_CONFIGS entry.
// The weekly unit-audit cron's FIRST tick (2026-07-18 01:46Z) swept
// getAllUnitBuilders() wholesale, audited all six ghosts, and the photo-fix
// ladder auto-committed a REAL unit swap for retired property 7
// ("Beautiful 8 brs for 22 near Poipu Beach Park!") — a listing the
// operator no longer runs. This suite locks the `retired` flag set, the
// active-portfolio ⇄ dashboard drift, and every enumeration gate.
import assert from "node:assert";
import fs from "node:fs";
import {
  getActiveUnitBuilders,
  getAllMultiUnitProperties,
  getAllUnitBuilders,
  getUnitBuilderByPropertyId,
  isRetiredUnitBuilderProperty,
  unitBuilderData,
} from "../client/src/data/unit-builder-data";

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

console.log("retired-properties: retired builder entries stay out of every automated pipeline");

// ── The retired set itself ───────────────────────────────────────────────────
const RETIRED_IDS = [7, 10, 14, 26, 28, 31];
const retired = unitBuilderData.filter((b) => b.retired === true).map((b) => b.propertyId).sort((a, b) => a - b);
check("exactly the six known ghost entries are flagged retired (deliberately un-retiring one means updating this lock in the same PR)",
  retired.join(",") === RETIRED_IDS.join(","));

check("isRetiredUnitBuilderProperty: true for every ghost, false for actives and unknown ids",
  RETIRED_IDS.every((id) => isRetiredUnitBuilderProperty(id))
  && !isRetiredUnitBuilderProperty(4)
  && !isRetiredUnitBuilderProperty(32)
  && !isRetiredUnitBuilderProperty(9999)
  && !isRetiredUnitBuilderProperty(-25));

check("getActiveUnitBuilders excludes every retired entry and keeps everything else",
  getActiveUnitBuilders().every((b) => b.retired !== true)
  && getActiveUnitBuilders().length === unitBuilderData.length - RETIRED_IDS.length);

check("getAllUnitBuilders still returns retired entries (folder/context lookups depend on them)",
  RETIRED_IDS.every((id) => getAllUnitBuilders().some((b) => b.propertyId === id))
  && RETIRED_IDS.every((id) => getUnitBuilderByPropertyId(id) !== undefined));

check("getAllMultiUnitProperties (property pickers) excludes retired entries",
  getAllMultiUnitProperties().every((p) => !RETIRED_IDS.includes(p.propertyId)));

// ── Drift-lock: active builder ids === the dashboard portfolio ───────────────
// home.tsx's static `properties` array IS the operator's core portfolio ("10
// core" on the dashboard). An entry in unit-builder-data that is neither on
// the dashboard nor flagged retired is exactly the bug class this suite
// exists for. Adding a new property → add the dashboard row and the builder
// entry in the same PR; removing one from the dashboard → flag the builder
// entry retired in the same PR.
{
  const homeSrc = read("client/src/pages/home.tsx");
  const start = homeSrc.indexOf("const properties: Property[] = [");
  const end = homeSrc.indexOf("\n];", start);
  check("drift-lock: home.tsx's static dashboard properties array is locatable", start >= 0 && end > start);
  const slice = homeSrc.slice(start, end);
  const dashboardIds = Array.from(slice.matchAll(/^    id: (\d+),$/gm), (m) => Number(m[1])).sort((a, b) => a - b);
  const activeIds = getActiveUnitBuilders().map((b) => b.propertyId).sort((a, b) => a - b);
  check("drift-lock: dashboard core rows were extracted (expected 10)", dashboardIds.length === 10);
  check("drift-lock: active (non-retired) builder ids === dashboard core property ids",
    dashboardIds.join(",") === activeIds.join(","));
}

// ── Enumeration gates (source guards) ────────────────────────────────────────
{
  const scheduler = read("server/unit-audit-scheduler.ts");
  check("gate: unit-audit cron targets enumerate getActiveUnitBuilders (not getAllUnitBuilders)",
    /const coreIds = getActiveUnitBuilders\(\)/.test(scheduler)
    && !/getAllUnitBuilders/.test(scheduler));
}

{
  const sweep = read("server/unit-audit-sweep.ts");
  check("gate: resolveUnitAuditTarget rejects retired builders (stale queued ghost sweeps fail their resolve stage)",
    /if \(!builder \|\| builder\.retired === true\) return null;/.test(sweep));
}

{
  const autoReplace = read("server/auto-replace-jobs.ts");
  check("gate: resolveAutoReplaceTarget rejects retired builders (blocks new ghost jobs AND cancels pending ghost retries)",
    /if \(!builder\?\.communityPhotoFolder \|\| builder\.retired === true\) return null;/.test(autoReplace));
}

{
  const reactions = read("server/photo-found-reactions.ts");
  check("gate: reactiveSweepEligible refuses retired positive ids",
    /if \(propertyId > 0\) return !isRetiredUnitBuilderProperty\(propertyId\);/.test(reactions));
  check("gate: photo-found reaction reports the retired case honestly (not the draft wording)",
    reactions.includes("retired from the portfolio"));
}

{
  const scanner = read("server/photo-listing-scanner.ts");
  check("gate: listScanableFolders excludes retired-owned folders at the single choke point",
    /const ownedByRetiredProperty = \(folder: string\): boolean =>/.test(scanner)
    && /if \(ownedByRetiredProperty\(folder\)\) continue;/.test(scanner)
    && /retiredIds\.has\(ref\.propertyId\)/.test(scanner));
}

// ── Ghost identity sanity (the entries this incident was about) ──────────────
check("ghost 7 is the 'Beautiful 8 brs' Regency entry from the incident",
  getUnitBuilderByPropertyId(7)?.propertyName === "Beautiful 8 brs for 22 near Poipu Beach Park!"
  && getUnitBuilderByPropertyId(7)?.retired === true);
check("ghost 10 is the 'Fabulous 5 br' Kekaha entry from the incident",
  getUnitBuilderByPropertyId(10)?.propertyName === "Fabulous 5 br for 15 private beachfront Estate!"
  && getUnitBuilderByPropertyId(10)?.retired === true);

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
