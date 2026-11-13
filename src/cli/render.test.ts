import assert from "node:assert/strict";
import test from "node:test";
import { parseAssetId, parseDecimalAmount, parseProviderId, type Price } from "../domain.ts";
import { decide, percentOf } from "../consumer/decide.ts";
import { progressLine } from "./render.ts";

test("when the shop is no better than the buyer, the decide block shows a reservation at or below zero", () => {
  const insurance = must(parseProviderId("insurance"));
  const plan = decide({
    value: near("0.10"),
    assessment: {
      answer: "Covered.",
      confidence: must(percentOf(0.9)),
      missing: ["the policy schedule", "the copay table"],
      coverage: new Map([[insurance, must(percentOf(1))]]),
    },
    listings: [{ id: insurance, price: near("0.02"), reputation: { kind: "unrated", completedJobs: 0 } }],
  });
  assert.ok(plan.kind !== "counter");
  assert.equal(
    progressLine({ step: "decide", decision: plan }, "mock"),
    [
      "decide    answer locally, pay nothing",
      "          value   0.10 NEAR, the budget: the most a right answer is worth",
      "          local   confidence 0.90 x value = worth 0.090 NEAR",
      "          missing the policy schedule; the copay table",
      "          option  insurance  ask 0.02  cover 1.00 x rep 0.70 = quality 0.70  net +0.050",
      "          rule    net = quality x value - ask; buy when net >= local worth: 0.050 < 0.090",
      "          rule    counter only when the reservation is above zero: (0.70 - 0.90) x 0.10 = -0.020 NEAR",
      "          rule    answer locally when confidence >= 0.50: 0.90 >= 0.50",
    ].join("\n"),
  );
});

test("an amount finer than a thousandth prints up to six decimals", () => {
  const insurance = must(parseProviderId("insurance"));
  const plan = decide({
    value: near("0.0433"),
    assessment: {
      answer: "Covered.",
      confidence: must(percentOf(0.2)),
      missing: [],
      coverage: new Map([[insurance, must(percentOf(1))]]),
    },
    listings: [{ id: insurance, price: near("0.02"), reputation: { kind: "unrated", completedJobs: 0 } }],
  });
  assert.ok(plan.kind !== "counter");
  const block = progressLine({ step: "decide", decision: plan }, "mock");
  assert.match(block, /^ {10}local {3}confidence 0\.20 x value = worth 0\.00866 NEAR$/m);
  assert.match(block, /^ {10}missing nothing$/m);
  assert.match(block, /net \+0\.01031$/m);
});

function near(amount: string): Price {
  return { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount(amount)) };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
