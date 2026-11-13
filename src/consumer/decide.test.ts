import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSameAsset,
  parseAssetId,
  parseDecimalAmount,
  parseProviderId,
  toUnits,
  type Price,
  type ProviderId,
} from "../domain.ts";
import type { Listing, Reputation } from "../market/index.ts";
import { decide, percentOf, settleCounter, type Plan, type SelfAssessment } from "./decide.ts";

type Shop = Pick<Listing, "id" | "price" | "reputation">;

const UNRATED: Reputation = { kind: "unrated", completedJobs: 0 };
const INSURANCE = shop("insurance", "0.02");
const DISCLOSURE = shop("disclosure", "0.02");
const LEGAL = shop("legal", "0.03");
const MARKET = [DISCLOSURE, LEGAL, INSURANCE];

test("the buyer buys, counters, answers, or declines by comparing each option's net with its own worth", () => {
  const cases: readonly {
    readonly name: string;
    readonly value: string;
    readonly confidence: number;
    readonly coverage: { readonly [id: string]: number };
    readonly shops?: readonly Shop[];
    readonly expect: string;
  }[] = [
    {
      name: "0.70 x 0.10 - 0.02 = 0.05 beats a local worth of 0.02",
      value: "0.10",
      confidence: 0.2,
      coverage: { insurance: 1 },
      expect: "buy insurance at 0.02 list-price",
    },
    {
      name: "a net equal to the local worth still buys, because the ask equals the reservation",
      value: "0.04",
      confidence: 0.2,
      coverage: { insurance: 1 },
      expect: "buy insurance at 0.02 list-price",
    },
    {
      name: "an ask of 0.02 above the reservation (0.70 - 0.20) x 0.03 draws a counter at 0.015",
      value: "0.03",
      confidence: 0.2,
      coverage: { insurance: 1 },
      expect: "counter insurance at 0.015",
    },
    {
      name: "a shop the buyer trusts less than itself is worth no price",
      value: "0.10",
      confidence: 1,
      coverage: { insurance: 1 },
      expect: "answer-locally no-price-worth-paying",
    },
    {
      name: "a confident buyer answers when no shop covers anything",
      value: "0.10",
      confidence: 0.99,
      coverage: {},
      expect: "answer-locally no-coverage",
    },
    {
      name: "an unsure buyer declines when no shop covers anything",
      value: "0.10",
      confidence: 0.3,
      coverage: { insurance: 0 },
      expect: "decline no-coverage",
    },
    {
      name: "a value below every ask buys nothing and an unsure buyer declines",
      value: "0.01",
      confidence: 0.3,
      coverage: { disclosure: 1 },
      expect: "decline nothing-affordable",
    },
    {
      name: "a value below every ask still lets a confident buyer answer",
      value: "0.01",
      confidence: 0.9,
      coverage: { disclosure: 1 },
      expect: "answer-locally nothing-affordable",
    },
    {
      name: "a shop that covers the question but sits above the budget is not an option",
      value: "0.02",
      confidence: 0.1,
      coverage: { legal: 1 },
      expect: "decline no-coverage",
    },
    {
      name: "confidence at exactly 0.50 is enough to answer locally",
      value: "0.10",
      confidence: 0.5,
      coverage: {},
      expect: "answer-locally no-coverage",
    },
    {
      name: "with no shops listed nothing is affordable",
      value: "0.10",
      confidence: 0.2,
      coverage: {},
      shops: [],
      expect: "decline nothing-affordable",
    },
  ];
  for (const item of cases) {
    const plan = decide({
      value: near(item.value),
      assessment: assessment(item.confidence, item.coverage),
      listings: item.shops ?? MARKET,
    });
    assert.equal(summary(plan), item.expect, item.name);
  }
});

test("the plan carries the arithmetic it decided on", () => {
  const plan = decide({ value: near("0.03"), assessment: assessment(0.2, { insurance: 1 }), listings: MARKET });
  assert.equal(plan.local.worth, units("0.006"));
  const [first, second, third] = plan.options;
  assert.ok(first?.kind === "priced" && second?.kind === "priced" && third?.kind === "priced");
  assert.deepEqual(
    [first.providerId, first.coverage, first.reputation, first.quality, first.net, first.reservation],
    ["insurance", 100, 70, 70, units("0.001"), units("0.015")],
  );
  assert.deepEqual([second.providerId, second.quality, second.net], ["disclosure", 0, -units("0.02")]);
  assert.deepEqual([third.providerId, third.quality, third.net], ["legal", 0, -units("0.03")]);
});

test("ratings move a shop's quality toward its stars, starting from a prior of two ratings at 0.70", () => {
  const cases: readonly (readonly [Reputation, number, string])[] = [
    [UNRATED, 70, "0.05"],
    [{ kind: "rated", completedJobs: 1, ratings: 1, average: 5 }, 80, "0.06"],
    [{ kind: "rated", completedJobs: 1, ratings: 1, average: 3 }, 63, "0.043"],
    [{ kind: "rated", completedJobs: 1, ratings: 1, average: 1 }, 47, "0.027"],
    [{ kind: "rated", completedJobs: 8, ratings: 8, average: 5 }, 94, "0.074"],
  ];
  for (const [reputation, quality, net] of cases) {
    const plan = decide({
      value: near("0.10"),
      assessment: assessment(0.2, { insurance: 1 }),
      listings: [{ ...INSURANCE, reputation }],
    });
    const option = plan.options[0];
    assert.ok(option?.kind === "priced");
    assert.equal(option.reputation, quality);
    assert.equal(option.net, units(net));
  }
});

test("partial coverage scales quality: 0.80 x 0.70 = 0.56", () => {
  const plan = decide({ value: near("0.10"), assessment: assessment(0.15, { disclosure: 0.8 }), listings: MARKET });
  const option = plan.options[0];
  assert.ok(option?.kind === "priced");
  assert.equal(option.quality, 56);
  assert.equal(option.net, units("0.036"));
});

test("the better net wins, a tie goes to the lower ask, and an exact tie goes to listing order", () => {
  const proven: Shop = { ...shop("legal", "0.03"), reputation: { kind: "rated", completedJobs: 1, ratings: 1, average: 5 } };
  const both = assessment(0.2, { insurance: 1, legal: 1, disclosure: 1 });

  const dearButBetter = decide({ value: near("0.20"), assessment: both, listings: [INSURANCE, proven] });
  assert.equal(summary(dearButBetter), "buy legal at 0.03 list-price");

  for (const listings of [[INSURANCE, proven], [proven, INSURANCE]]) {
    const tied = decide({ value: near("0.10"), assessment: both, listings });
    assert.equal(summary(tied), "buy insurance at 0.02 list-price");
  }

  assert.equal(
    summary(decide({ value: near("0.10"), assessment: both, listings: [DISCLOSURE, INSURANCE] })),
    "buy disclosure at 0.02 list-price",
  );
  assert.equal(
    summary(decide({ value: near("0.10"), assessment: both, listings: [INSURANCE, DISCLOSURE] })),
    "buy insurance at 0.02 list-price",
  );
});

test("a shop priced in another asset is outside the budget", () => {
  const foreign: Shop = { ...INSURANCE, price: { ...INSURANCE.price, asset: must(parseAssetId("nep141:other.near")) } };
  const plan = decide({ value: near("0.10"), assessment: assessment(0.2, { insurance: 1 }), listings: [foreign] });
  assert.equal(summary(plan), "decline nothing-affordable");
  assert.equal(plan.options[0]?.kind, "unaffordable");
});

test("an accepted counter buys at the offer, and a refused one falls back on local confidence", () => {
  const unsure = decide({ value: near("0.03"), assessment: assessment(0.2, { insurance: 1 }), listings: MARKET });
  assert.equal(unsure.kind, "counter");
  if (unsure.kind !== "counter") return;
  assert.equal(summary(settleCounter(unsure, "accepted")), "buy insurance at 0.015 counter-accepted");
  assert.equal(summary(settleCounter(unsure, "refused")), "decline counter-refused");

  const fairlySure = decide({ value: near("0.10"), assessment: assessment(0.55, { disclosure: 1 }), listings: MARKET });
  assert.equal(summary(fairlySure), "counter disclosure at 0.015");
  if (fairlySure.kind !== "counter") return;
  const walked = settleCounter(fairlySure, "refused");
  assert.equal(summary(walked), "answer-locally counter-refused");
  assert.equal(walked.local.answer, "a local answer");
});

test("no plan pays above the budget, and a counter is always above zero and below the ask", () => {
  const shares = [0, 0.05, 0.2, 0.35, 0.5, 0.55, 0.7, 0.9, 1];
  const values = ["0.000000000000000001", "0.01", "0.02", "0.025", "0.03", "0.0333", "0.05", "0.1", "0.5", "40"];
  let buys = 0;
  let counters = 0;
  for (const amount of values) {
    for (const confidence of shares) {
      for (const coverage of shares) {
        const value = near(amount);
        const plan = decide({
          value,
          assessment: assessment(confidence, { insurance: coverage, legal: coverage }),
          listings: MARKET,
        });
        const label = `value ${amount} confidence ${confidence} coverage ${coverage}`;
        if (plan.kind === "buy") {
          buys += 1;
          assert.notEqual(compareSameAsset(plan.agreed, value), 1, label);
        }
        if (plan.kind === "counter") {
          counters += 1;
          assert.ok(toUnits(plan.offer.amount) > 0n, label);
          assert.equal(compareSameAsset(plan.offer, plan.option.ask), -1, label);
          assert.notEqual(compareSameAsset(plan.offer, value), 1, label);
        }
      }
    }
  }
  assert.ok(buys > 0 && counters > 0);
});

test("a share outside 0 to 1 is not a probability", () => {
  assert.equal(percentOf(0.2), 20);
  assert.equal(percentOf(0.125), 13);
  assert.equal(percentOf(1), 100);
  for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(percentOf(bad), null, String(bad));
  }
});

function summary(plan: Plan): string {
  switch (plan.kind) {
    case "buy":
      return `buy ${plan.option.providerId} at ${plan.agreed.amount} ${plan.negotiation}`;
    case "counter":
      return `counter ${plan.option.providerId} at ${plan.offer.amount}`;
    case "answer-locally":
    case "decline":
      return `${plan.kind} ${plan.because.kind}`;
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

function assessment(confidence: number, coverage: { readonly [id: string]: number }): SelfAssessment {
  return {
    answer: "a local answer",
    confidence: must(percentOf(confidence)),
    missing: ["a private fact"],
    coverage: new Map(Object.entries(coverage).map(([id, share]) => [providerId(id), must(percentOf(share))])),
  };
}

function shop(id: string, ask: string): Shop {
  return { id: providerId(id), price: near(ask), reputation: UNRATED };
}

function providerId(id: string): ProviderId {
  return must(parseProviderId(id));
}

function near(amount: string): Price {
  return { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount(amount)) };
}

function units(amount: string): bigint {
  return toUnits(must(parseDecimalAmount(amount)));
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
