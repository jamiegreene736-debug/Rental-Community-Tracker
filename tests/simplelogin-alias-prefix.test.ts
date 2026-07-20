import assert from "node:assert";
import {
  aliasPrefixForGuest,
  aliasPrefixCandidates,
  aliasUnitToken,
  isSimpleLoginAliasExistsError,
} from "../server/simplelogin";

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}

const RESERVATION = "6a3e88479cbfa900134c015c";

test("base prefix = guest first.last + reservation tail", () => {
  assert.strictEqual(aliasPrefixForGuest("Thien Tran", RESERVATION), "thien.tran.4c015c");
});

test("aliasUnitToken strips the word 'unit' and slugs the rest", () => {
  assert.strictEqual(aliasUnitToken("Unit B"), "b");
  assert.strictEqual(aliasUnitToken("Unit 812"), "812");
  assert.strictEqual(aliasUnitToken("unit"), "");
  assert.strictEqual(aliasUnitToken(null), "");
});

test("two units on one reservation get DISTINCT first-choice prefixes (the 2026-07-05 Unit B collision)", () => {
  const unitA = aliasPrefixCandidates({
    guestName: "Thien Tran",
    reservationId: RESERVATION,
    unitLabel: "Unit A",
    buyInId: 526,
  });
  const unitB = aliasPrefixCandidates({
    guestName: "Thien Tran",
    reservationId: RESERVATION,
    unitLabel: "Unit B",
    buyInId: 527,
  });
  // Unit aliases stay `first.last.<numbers>` (operator 2026-07-20, superseding
  // the same-day "unit.b." lead-in) with a per-unit 6-digit tail, so the two
  // units' trailing numbers are COMPLETELY different — never one character.
  assert.strictEqual(unitA[0], "thien.tran.261243");
  assert.strictEqual(unitB[0], "thien.tran.618938");
  assert.notStrictEqual(unitA[0], unitB[0]);
  assert.ok(/^thien\.tran\.\d{6}$/.test(unitA[0]) && /^thien\.tran\.\d{6}$/.test(unitB[0]));
});

test("candidates fall back to buyInId then entropy, all unique", () => {
  const candidates = aliasPrefixCandidates({
    guestName: "Thien Tran",
    reservationId: RESERVATION,
    unitLabel: "Unit B",
    buyInId: 527,
    entropy: "zz99xx",
  });
  assert.deepStrictEqual(candidates, [
    "thien.tran.618938",
    "thien.tran.618938.b527",
    "thien.tran.618938.zz99xx",
  ]);
  assert.strictEqual(new Set(candidates).size, candidates.length);
});

test("the same unit re-mints deterministically; different reservations differ", () => {
  const again = aliasPrefixCandidates({
    guestName: "Thien Tran",
    reservationId: RESERVATION,
    unitLabel: "Unit B",
    buyInId: 527,
  });
  assert.strictEqual(again[0], "thien.tran.618938");
  const otherReservation = aliasPrefixCandidates({
    guestName: "Thien Tran",
    reservationId: "6a357e7c60363d0014ae9958",
    unitLabel: "Unit B",
    buyInId: 999,
  });
  assert.strictEqual(otherReservation[0], "thien.tran.410862");
  assert.notStrictEqual(again[0], otherReservation[0]);
});

test("legacy reservation-level call (no unit) keeps the historical base prefix first", () => {
  const candidates = aliasPrefixCandidates({
    guestName: "Thien Tran",
    reservationId: RESERVATION,
    entropy: "abc123",
  });
  assert.strictEqual(candidates[0], "thien.tran.4c015c");
  assert.deepStrictEqual(candidates, ["thien.tran.4c015c", "thien.tran.4c015c.abc123"]);
});

test("unit label with no distinguishing token still yields a buyInId disambiguator", () => {
  const candidates = aliasPrefixCandidates({
    guestName: "Thien Tran",
    reservationId: RESERVATION,
    unitLabel: "Unit",
    buyInId: 42,
    entropy: "abc123",
  });
  assert.strictEqual(candidates[0], "thien.tran.4c015c");
  assert.ok(candidates.includes("thien.tran.4c015c.b42"));
});

test("isSimpleLoginAliasExistsError matches SimpleLogin duplicate messages only", () => {
  assert.ok(isSimpleLoginAliasExistsError(new Error("alias thien.tran.4c015c@emailprivaccy.com already exists")));
  assert.ok(isSimpleLoginAliasExistsError(new Error("This alias is already in use")));
  assert.ok(!isSimpleLoginAliasExistsError(new Error("SimpleLogin POST /api/v3/alias/custom/new failed (503)")));
  assert.ok(!isSimpleLoginAliasExistsError(new Error("SIMPLELOGIN_API_KEY is not configured")));
});

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("All simplelogin-alias-prefix tests passed");
