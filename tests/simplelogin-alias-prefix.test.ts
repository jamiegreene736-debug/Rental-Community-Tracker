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
  assert.strictEqual(unitA[0], "thien.tran.4c015c.a");
  assert.strictEqual(unitB[0], "thien.tran.4c015c.b");
  assert.notStrictEqual(unitA[0], unitB[0]);
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
    "thien.tran.4c015c.b",
    "thien.tran.4c015c.b.b527",
    "thien.tran.4c015c.b.zz99xx",
  ]);
  assert.strictEqual(new Set(candidates).size, candidates.length);
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
