import assert from "node:assert/strict";
import {
  formatRateValue,
  parseRateValue,
  rateChangeDirection,
  rateChangePercent,
} from "../client/src/components/RateChangeDisplay";

assert.equal(parseRateValue("450"), 450);
assert.equal(parseRateValue(null), null);
assert.equal(formatRateValue(450), "$450");

assert.equal(rateChangeDirection(400, 500), "up");
assert.equal(rateChangeDirection(500, 400), "down");
assert.equal(rateChangeDirection(400, 400), "flat");
assert.equal(rateChangeDirection(null, 400), "new");

assert.equal(rateChangePercent(400, 500), 0.25);
assert.equal(rateChangePercent(500, 400), -0.2);

console.log("rate-change-display suite passed");
