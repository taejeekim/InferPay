import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountId, parseAssetId, parseCorrelationId, parseDecimalAmount, parseIdempotencyKey, parseJobId, parseParentAccount, parseModelId, parseProviderId, type Price } from "../domain.ts";
import { decide, percentOf } from "../consumer/decide.ts";
import type { CallAttestation } from "../inference/attest.ts";
import { resolveRoster } from "../roster.ts";
import { attestLines, progressLine, railsLine, walletsTable } from "./render.ts";

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

const HASH = "CYvHqXWvDNtEaQnfuoNyMP7LBUkAZLxwbyunhT2Qs5Mp";

function pay(correlation: string | null) {
  return {
    step: "pay" as const,
    transfer: "called" as const,
    status: "settled" as const,
    amount: { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount("0.02")) },
    payer: must(parseAccountId("clerk.kyle.inferpay.testnet")),
    recipient: must(parseAccountId("insurance.ban.inferpay.testnet")),
    correlationId: correlation === null ? null : must(parseCorrelationId(correlation)),
    key: must(parseIdempotencyKey("nt_key")),
    jobId: must(parseJobId("job_01M7BGGX58BF3B8VB4ADYKXYZA")),
  };
}

test("a testnet payment names the rail and links the transaction", () => {
  assert.equal(railsLine({ payment: "near-testnet", inference: "stub" }), "rails: payment=near-testnet inference=stub");
  const block = progressLine(pay(HASH), "near-testnet");
  assert.match(block, /via +NEAR testnet transfer/);
  assert.match(block, new RegExp(`tx +https://testnet\\.nearblocks\\.io/txns/${HASH}`));
  assert.doesNotMatch(progressLine(pay("mock-ab12"), "mock"), /tx +http/);
});

test("on the testnet rail the wallets table shows each live balance", () => {
  const resolved = resolveRoster(must(parseParentAccount("inferpay.testnet")));
  assert.ok(resolved.ok);
  const clerk = must(parseAccountId("clerk.kyle.inferpay.testnet"));
  const text = walletsTable(resolved.roster, new Map([[clerk, 579_955_000_000_000_000_000_000n]]));
  assert.match(text, /clerk\.kyle\.inferpay\.testnet +payer +0\.5799 NEAR/);
  assert.match(text, /writer\.kyle\.inferpay\.testnet +payer +not created/);
  assert.match(text, /spend cap/);
  assert.doesNotMatch(walletsTable(resolved.roster, null), /BALANCE/);
});

const model = parseModelId("z-ai/glm-5.3-flash");
if (!model) throw new Error("model");
const signer = "0x3b753b4406613c5e70ae640508632b600424fa0c";

test("a fully verified role names its signer and what was not checked", () => {
  const calls: CallAttestation[] = [
    { verdict: "verified", model, completionId: "a", signer },
    { verdict: "verified", model, completionId: "b", signer },
  ];
  assert.deepEqual(attestLines("specialist", calls), [
    "attest    specialist 2/2 calls verified",
    `          signed by ${signer}, a key in NEAR AI's attestation report for z-ai/glm-5.3-flash`,
    "          request and response hashes match; report echoed our nonce; TDX and GPU quotes not re-verified locally",
  ]);
});

test("an unverified call prints its reason and claims no match", () => {
  const calls: CallAttestation[] = [
    { verdict: "unverified", model, completionId: "a", reason: "hash-mismatch", detail: "signed text differs from what we hashed: response hash" },
  ];
  assert.deepEqual(attestLines("buyer", calls), [
    "attest    buyer 0/1 calls verified",
    "          unverified hash-mismatch: signed text differs from what we hashed: response hash",
  ]);
});

test("a role with no live calls prints nothing", () => {
  assert.deepEqual(attestLines("buyer", []), []);
});

function near(amount: string): Price {
  return { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount(amount)) };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture failed its check");
  return value;
}
