import assert from "node:assert/strict";
import test from "node:test";
import { decimalToAtomic, formatNear, nearOf } from "./units.ts";

test("0.02 NEAR is 2e22 yoctoNEAR", () => {
  assert.equal(decimalToAtomic("NEAR", "0.02"), "20000000000000000000000");
  assert.equal(decimalToAtomic("NEAR", "0.03"), "30000000000000000000000");
  assert.equal(decimalToAtomic("NEAR", "1"), "1000000000000000000000000");
  assert.equal(decimalToAtomic("NEAR", "0.000000000000000000000001"), "1");
});

test("an amount finer than one yoctoNEAR or in another token has no NEAR value", () => {
  assert.equal(decimalToAtomic("NEAR", "0.0200000000000000000000001"), null);
  assert.equal(decimalToAtomic("NEAR", "-1"), null);
  assert.equal(decimalToAtomic("NEAR", "1e3"), null);
  assert.equal(decimalToAtomic("USDC", "0.25"), null);
});

test("yoctoNEAR balances print in NEAR without rounding up", () => {
  assert.equal(formatNear(nearOf("6.1")), "6.1");
  assert.equal(formatNear(nearOf("0.6")), "0.6");
  assert.equal(formatNear(nearOf("0.59999")), "0.5999");
  assert.equal(formatNear(0n), "0");
  assert.equal(formatNear(nearOf("10")), "10");
});
